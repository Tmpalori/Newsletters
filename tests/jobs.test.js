// @vitest-environment node
//
// Jobs on Railway (server/jobs.js, JOBS_ON_RAILWAY.md): the scheduler and
// Pull Now queue jobs in the town's database, the town's jobs worker claims
// and finishes them, and a collect hands its candidates to the site, which
// publishes at once. Off (404) without JOBS_ON_RAILWAY=1 and JOBS_SECRET.

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { createScheduler } from '../server/scheduler.js';
import { createJobs, kindForWorkflow, upcomingCount } from '../server/jobs.js';

const NOW = new Date('2026-10-07T15:00:00Z');
const SECRET = 's'.repeat(40);
const ON = { JOBS_ON_RAILWAY: '1', JOBS_SECRET: SECRET };
const LONG = { adminUsername: 'admin', adminPassword: 'a-long-enough-pass', adminSessionSecret: 'x'.repeat(32) };

let servers = [], dirs = [];
afterEach(async () => {
  for (const s of servers) await new Promise(r => s.close(r));
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  servers = []; dirs = [];
});

function fakeSlack() {
  const s = { enabled: true, alerts: [], notes: [] };
  s.notify = async n => { s.notes.push(n); return true; };
  s.alert = async (key, title, text) => { s.alerts.push({ key, title, text }); return true; };
  return s;
}

async function start({ env = ON, now = () => NOW } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-jobs-'));
  dirs.push(dir);
  const eventsFile = path.join(dir, 'events.json');
  await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
  const store = new FileStore(path.join(dir, 's.json'));
  const slack = fakeSlack();
  const out = await createApp({
    storeBundle: { kind: 'file', store }, eventsFile, candidatesFile: path.join(dir, 'candidates.json'), collectionMetadataFile: path.join(dir, 'collection_metadata.json'),
    trustProxy: false, now, siteUrl: 'https://www.thevic361.com', resendApiKey: '', slack,
    autoPublish: false, startScheduler: false, jobsEnv: env, ...LONG
  });
  const server = http.createServer(out.app);
  servers.push(server);
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, body, secret = SECRET) => fetch(base + p, {
    method, headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { ...out, base, store, slack, call, dir };
}

const CANDIDATES = {
  last_updated: '2026-10-07T14:30:00-05:00',
  events: [
    { date: '2026-10-09', name: 'Trivia Night', venue: 'The Upper Room', time: '7:00 PM', icons: [], free: true },
    { date: '2026-10-10', name: 'Farmers Market', venue: 'Hilltop Mall', time: '8:00 AM', icons: [], free: true },
    { date: '2026-12-31', name: 'New Year Gala', venue: 'Merryman', time: '8:00 PM', icons: [], free: false }
  ]
};

describe('jobs API', () => {
  it('is off (404) without JOBS_ON_RAILWAY and its secret, and refuses a wrong secret', async () => {
    const off = await start({ env: {} });
    expect((await off.call('POST', '/api/jobs/claim')).status).toBe(404);
    const short = await start({ env: { JOBS_ON_RAILWAY: '1', JOBS_SECRET: 'short' } });
    expect((await short.call('POST', '/api/jobs/claim')).status).toBe(404);
    const on = await start();
    expect((await on.call('POST', '/api/jobs/claim', undefined, 'w'.repeat(40))).status).toBe(401);
    expect((await on.call('POST', '/api/jobs/claim')).status).toBe(204);
  });

  it('a collect: claimed once, its files handed over, published, "collect done", then an event check', async () => {
    const t = await start();
    await t.store.enqueueJob('collect', '2026-10-07', {}, NOW);
    const claim = await (await t.call('POST', '/api/jobs/claim')).json();
    expect(claim.job).toMatchObject({ kind: 'collect', slot: '2026-10-07' });
    expect((await t.call('POST', '/api/jobs/claim')).status).toBe(204);       // not twice

    expect((await t.call('PUT', '/api/jobs/files/enrichment_cache', { a: 1 })).status).toBe(200);
    expect((await t.call('PUT', '/api/jobs/files/candidates', { events: 'no' })).status).toBe(400);
    expect((await t.call('PUT', '/api/jobs/files/nope', {})).status).toBe(404);
    const put = await (await t.call('PUT', '/api/jobs/files/candidates', CANDIDATES)).json();
    expect(put.published.ok).toBe(true);
    const live = await (await fetch(t.base + '/events.json')).json();
    expect(live.events.map(e => e.name)).toContain('Trivia Night');
    expect(live.collected_at).toBe(CANDIDATES.last_updated);
    expect((await (await t.call('GET', '/api/jobs/files/enrichment_cache')).json()).data).toEqual({ a: 1 });

    const fin = await t.call('POST', `/api/jobs/${claim.job.id}/finish`, { status: 'done', result: { upcoming: 2, warnings: 'mona returned 0 events' } });
    expect(fin.status).toBe(200);
    expect(t.slack.notes.find(n => n.title === '🗓️ Collect done').text).toMatch(/^2 events/);
    expect(t.slack.notes.find(n => n.title.startsWith('⚠️ Weekly collect:')).channel).toBe('alerts');
    const next = await (await t.call('POST', '/api/jobs/claim')).json();
    expect(next.job).toMatchObject({ kind: 'event-check', slot: `after-collect-${claim.job.id}` });
    expect((await t.call('POST', `/api/jobs/${claim.job.id}/finish`, { status: 'done' })).status).toBe(404);  // once
  });

  it('a failed job alerts with the end of its log', async () => {
    const t = await start();
    await t.store.enqueueJob('submission-review', 's1', {}, NOW);
    const { job } = await (await t.call('POST', '/api/jobs/claim')).json();
    await t.call('POST', `/api/jobs/${job.id}/finish`, { status: 'failed', result: { error: 'exited 1', log_tail: ['OpenAI 401'] } });
    expect(t.slack.alerts).toEqual([expect.objectContaining({ title: 'Submission review failed', text: expect.stringContaining('OpenAI 401') })]);
  });

  it('a run the worker never finished is failed, started once more and said once', async () => {
    let now = NOW;
    const t = await start({ now: () => now });
    await t.store.enqueueJob('collect', 'sun', {}, NOW);
    await t.call('POST', '/api/jobs/claim');
    now = new Date(NOW.getTime() + 61 * 60 * 1000);
    const again = await (await t.call('POST', '/api/jobs/claim')).json();
    expect(again.job).toMatchObject({ kind: 'collect', slot: 'sun-retry' });
    expect(t.slack.alerts.map(a => a.title)).toEqual(["Weekly event collect didn't finish"]);
    expect(t.slack.alerts[0].text).toContain('started again');
    now = new Date(now.getTime() + 61 * 60 * 1000);
    expect((await t.call('POST', '/api/jobs/claim')).status).toBe(204);      // a retry isn't retried
    expect(t.slack.alerts).toHaveLength(2);
  });

  it('the hourly check alerts when the worker stops asking for work', async () => {
    let now = NOW;
    const t = await start({ now: () => now });
    now = new Date(NOW.getTime() + 31 * 60 * 1000);
    expect((await t.healthCheck(now)).problems).toContain('jobs_worker');
    await t.call('POST', '/api/jobs/claim');
    expect((await t.healthCheck(now)).problems).not.toContain('jobs_worker');
  });

  it('Pull Now queues a collect; /api/admin/sources reads the metadata the collect handed over', async () => {
    const t = await start();
    const login = await (await fetch(t.base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: LONG.adminUsername, password: LONG.adminPassword }) })).json();
    const auth = { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' };
    const r = await (await fetch(t.base + '/api/admin/trigger-collect', { method: 'POST', headers: auth })).json();
    expect(r).toMatchObject({ ok: true, queued: true });
    expect((await t.store.listJobs())[0]).toMatchObject({ kind: 'collect', status: 'queued' });
    await t.call('PUT', '/api/jobs/files/collection_metadata', { last_run_at: '2026-10-07T14:30:00-05:00', sources: [{ name: 'town_feeds', count: 120, status: 'ok' }] });
    const src = await (await fetch(t.base + '/api/admin/sources', { headers: auth })).json();
    expect(JSON.stringify(src)).toContain('town_feeds');
  });

  it('the database copy of the candidates wins only when it is newer than the bundled file', async () => {
    const t = await start();
    await fs.writeFile(path.join(t.dir, 'candidates.json'), JSON.stringify({ last_updated: '2026-10-08T00:00:00Z', events: [{ date: '2026-10-09', name: 'From The File', venue: 'X', icons: [] }] }));
    await t.store.setTownFile('candidates', CANDIDATES, NOW);
    await t.call('PUT', '/api/jobs/files/candidates', CANDIDATES);
    const live = await (await fetch(t.base + '/events.json')).json();
    expect(live.events.map(e => e.name)).toContain('From The File');
  });
});

describe('the scheduler with jobs on Railway', () => {
  it('queues the jobs the worker runs instead of starting GitHub workflows, and leaves the rest', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-jobs-'));
    dirs.push(dir);
    const store = new FileStore(path.join(dir, 's.json'));
    const github = { calls: [], isConfigured: () => true, branch: 'main', dispatchWorkflow: async (f) => { github.calls.push(f); } };
    const queued = [];
    const s = createScheduler({ store, github, log: { warn() {} },
      queueJob: async (job, slot) => { queued.push([kindForWorkflow(job.workflow), slot]); },
      canQueue: job => Boolean(kindForWorkflow(job.workflow)) });
    await s.tick(new Date('2026-10-07T13:48:00Z'));     // ads, social kit and the review are due
    await s.tick(new Date('2026-10-07T20:30:00Z'));     // Wednesday's collect
    expect(github.calls).toEqual([]);
    expect(queued.map(q => q[0])).toEqual(['submission-review', 'collect', 'submission-review']);
    expect(new Set(queued.map(q => q[1])).size).toBe(3);
  });
});

describe('helpers', () => {
  it('counts the next two weeks', () => {
    expect(upcomingCount(CANDIDATES, NOW)).toBe(2);
  });

  it('createJobs is off without the secret', () => {
    expect(createJobs({ store: {}, env: { JOBS_ON_RAILWAY: '1' } }).enabled).toBe(false);
  });
});
