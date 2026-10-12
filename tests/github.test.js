// @vitest-environment node
//
// server/github.js: every GitHub API call has a deadline, so a GitHub that
// accepts the connection and hangs fails fast and the callers' local-file
// fallbacks run instead of the admin waiting minutes.

import { describe, it, expect } from 'vitest';
import { createGithub } from '../server/github.js';

// Hangs until its signal aborts, like a stalled HTTP response.
function hangingFetch(seen) {
  return (url, init = {}) => new Promise((_, reject) => {
    seen.push(init.signal);
    if (init.signal) init.signal.addEventListener('abort', () => reject(init.signal.reason));
  });
}

const settle = p => Promise.race([
  p.then(() => 'answered', err => err),
  new Promise(r => setTimeout(() => r('still hanging'), 1000))
]);

describe('GitHub API timeouts', () => {
  it('each call gives up and throws a timeout error instead of hanging', async () => {
    const seen = [];
    const gh = createGithub({ token: 't', owner: 'o', repo: 'r', branch: 'main', fetch: hangingFetch(seen), timeoutMs: 30 });
    const calls = [
      gh.getJsonFile('candidates.json'),
      gh.putJsonFile('docs/events.json', { events: [] }, 'msg', 'sha1'),
      gh.dispatchWorkflow('weekly-collect.yml'),
      gh.listWorkflowRuns('weekly-collect.yml', 1)
    ];
    for (const p of calls) {
      const out = await settle(p);
      expect(out).toBeInstanceOf(Error);
      expect(out.code).toBe('timeout');
      expect(out.status).toBeUndefined();
    }
    expect(seen).toHaveLength(4);
    expect(seen.every(s => s instanceof AbortSignal)).toBe(true);
  });

  it('the download_url read for a large file has a deadline too', async () => {
    const seen = [];
    const hang = hangingFetch(seen);
    const fetchImpl = (url, init) => (url.includes('/contents/')
      ? Promise.resolve({ ok: true, status: 200, json: async () => ({ sha: 's', download_url: 'https://raw.example/f.json' }) })
      : hang(url, init));
    const gh = createGithub({ token: 't', fetch: fetchImpl, timeoutMs: 30 });
    const out = await settle(gh.getJsonFile('big.json'));
    expect(out).toBeInstanceOf(Error);
    expect(out.code).toBe('timeout');
  });
});

describe('which repo', () => {
  const KEYS = ['GITHUB_OWNER', 'GITHUB_REPO', 'RAILWAY_GIT_REPO_OWNER', 'RAILWAY_GIT_REPO_NAME'];
  const withEnv = (env, fn) => {
    const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    Object.assign(process.env, env);
    try { return fn(); } finally { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
  };

  it('follows the repo Railway deployed from, so a rename needs no variable', () => {
    const gh = withEnv({ RAILWAY_GIT_REPO_OWNER: 'Tmpalori', RAILWAY_GIT_REPO_NAME: 'newsletters' }, () => createGithub({ token: 't' }));
    expect([gh.owner, gh.repo]).toEqual(['Tmpalori', 'newsletters']);
  });

  it('GITHUB_* still win, and without either it is Tmpalori/thevic361', () => {
    const set = withEnv({ GITHUB_REPO: 'other', RAILWAY_GIT_REPO_NAME: 'newsletters', RAILWAY_GIT_REPO_OWNER: '' }, () => createGithub({ token: 't' }));
    expect([set.owner, set.repo]).toEqual(['Tmpalori', 'other']);
    const none = withEnv({}, () => createGithub({ token: 't' }));
    expect([none.owner, none.repo]).toEqual(['Tmpalori', 'thevic361']);
  });
});
