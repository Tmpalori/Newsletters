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
import { createJobs, upcomingCount, canRunOnWorker } from '../server/jobs.js';
import { townConfig, useTown, VICTORIA } from '../server/town.js';

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

async function start({ env = ON, now = () => NOW, extra = {} } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-jobs-'));
  dirs.push(dir);
  const eventsFile = path.join(dir, 'events.json');
  await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
  const store = new FileStore(path.join(dir, 's.json'));
  const slack = fakeSlack();
  const out = await createApp({
    storeBundle: { kind: 'file', store }, eventsFile, candidatesFile: path.join(dir, 'candidates.json'), collectionMetadataFile: path.join(dir, 'collection_metadata.json'),
    trustProxy: false, now, siteUrl: 'https://www.thevic361.com', resendApiKey: '', slack,
    autoPublish: false, startScheduler: false, jobsEnv: env, ...LONG, ...extra
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

  it('a failed collect or check alerts every time; the 15-minute review once its failures reach an hour; then says it works again', async () => {
    const t = await start();
    const run = async (kind, slot, status, result) => {
      await t.store.enqueueJob(kind, slot, {}, NOW);
      const { job } = await (await t.call('POST', '/api/jobs/claim')).json();
      await t.call('POST', `/api/jobs/${job.id}/finish`, { status, result });
    };
    await run('event-check', 'e1', 'failed', { error: 'exited 1', log_tail: ['x'.repeat(5000), 'Site 500'] });
    expect(t.slack.alerts).toEqual([expect.objectContaining({ title: 'Event check failed', text: expect.stringContaining('Site 500') })]);
    expect(t.slack.alerts[0].text.length).toBeLessThan(1000);
    await run('event-check', 'e2', 'failed', { error: 'exited 1' });            // Thursday's fails too: said again
    expect(t.slack.alerts).toHaveLength(2);
    for (let i = 1; i <= 5; i++) await run('submission-review', `s${i}`, 'failed', { error: 'OpenAI 401' });
    expect(t.slack.alerts.map(a => a.title)).toEqual(['Event check failed', 'Event check failed', 'Submission review failed']);
    await run('submission-review', 's6', 'done', {});
    expect(t.slack.notes.map(n => n.title)).toContain('✅ Submission review working again');
  });

  it('a review whose AI is down alerts on that one failed run (the passes between never build a streak)', async () => {
    const t = await start();
    const run = async (slot, status, result) => {
      await t.store.enqueueJob('submission-review', slot, {}, NOW);
      const { job } = await (await t.call('POST', '/api/jobs/claim')).json();
      await t.call('POST', `/api/jobs/${job.id}/finish`, { status, result });
    };
    await run('a1', 'failed', { error: 'exited 1', log_tail: ["::error::The AI review can't run: OpenAI 429 insufficient_quota. Submissions are waiting; fix the key or credit."] });
    expect(t.slack.alerts.map(a => a.title)).toEqual(['Submission review: the AI can’t run (key or credit); submissions are waiting']);
    await run('a2', 'done', {});                 // the next runs pass (already alerted)
    await run('a3', 'failed', { error: 'exited 1', log_tail: ['Site 500'] });   // an ordinary failure still waits for 4
    expect(t.slack.alerts).toHaveLength(1);
  });

  it('one of a kind at a time: Pull Now twice queues one collect; a worker back after a day finds one review', async () => {
    const t = await start();
    const login = await (await fetch(t.base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: LONG.adminUsername, password: LONG.adminPassword }) })).json();
    const auth = { Authorization: `Bearer ${login.token}` };
    expect((await (await fetch(t.base + '/api/admin/trigger-collect', { method: 'POST', headers: auth })).json()).queued).toBe(true);
    expect((await (await fetch(t.base + '/api/admin/trigger-collect', { method: 'POST', headers: auth })).json()).already).toBe(true);
    const jobs = createJobs({ store: t.store, env: ON, nowFn: () => NOW });
    for (let i = 0; i < 5; i++) await jobs.enqueue('submission-review', `r${i}`);
    expect((await t.store.listJobs()).map(j => j.kind).sort()).toEqual(['collect', 'submission-review']);
  });

  it('a body is only read once the secret checks out', async () => {
    const t = await start();
    const big = JSON.stringify({ events: [], last_updated: 'x', pad: 'x'.repeat(2 * 1024 * 1024) });
    const r = await fetch(t.base + '/api/jobs/files/candidates', { method: 'PUT', headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' }, body: big });
    expect(r.status).toBe(401);
    const off = await start({ env: {} });
    expect((await fetch(off.base + '/api/jobs/files/candidates', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: big })).status).toBe(404);
  });

  it('a run the worker never finished is failed and started once more; the second try failing is said too', async () => {
    let now = NOW;
    const t = await start({ now: () => now });
    await t.store.enqueueJob('collect', 'sun', {}, NOW);
    await t.call('POST', '/api/jobs/claim');
    now = new Date(NOW.getTime() + 61 * 60 * 1000);
    expect((await t.call('POST', '/api/jobs/claim')).status).toBe(204);      // a collect has 75 minutes
    now = new Date(NOW.getTime() + 76 * 60 * 1000);
    const again = await (await t.call('POST', '/api/jobs/claim')).json();
    expect(again.job).toMatchObject({ kind: 'collect', slot: 'sun-retry' });
    expect(t.slack.alerts.map(a => a.title)).toEqual(["Weekly event collect didn't finish"]);
    expect(t.slack.alerts[0].text).toContain('started again');
    now = new Date(now.getTime() + 76 * 60 * 1000);
    expect((await t.call('POST', '/api/jobs/claim')).status).toBe(204);      // a retry isn't retried
    expect(t.slack.alerts).toHaveLength(2);
    expect(t.slack.alerts[1].text).toContain('already ran twice');
  });

  it('a second try failing minutes after "started again" is its own alert (not deduped away)', async () => {
    let now = NOW;
    const t = await start({ now: () => now });
    await t.store.enqueueJob('event-check', 'mon', {}, NOW);
    await t.call('POST', '/api/jobs/claim');
    now = new Date(NOW.getTime() + 21 * 60 * 1000);
    const { job } = await (await t.call('POST', '/api/jobs/claim')).json();    // the retry
    now = new Date(now.getTime() + 2 * 60 * 1000);
    await t.call('POST', `/api/jobs/${job.id}/finish`, { status: 'failed', result: { error: 'exited 1' } });
    expect(t.slack.alerts.map(a => a.title)).toEqual(["Event check didn't finish", 'Event check failed']);
    expect(new Set(t.slack.alerts.map(a => a.key)).size).toBe(2);
  });

  it('after a web redeploy mid-collect the worker is still busy, not silent (from the database)', async () => {
    const t = await start();
    await t.store.enqueueJob('collect', 'sun', {}, NOW);
    await t.call('POST', '/api/jobs/claim');
    const fresh = createJobs({ store: t.store, env: ON, nowFn: () => NOW });    // a new process: nothing in memory
    expect(await fresh.busy(new Date(NOW.getTime() + 45 * 60 * 1000))).toBe(true);
    expect(await fresh.busy(new Date(NOW.getTime() + 80 * 60 * 1000))).toBe(false);
  });

  it("a collect whose events didn't publish says so, not 'live'", async () => {
    const t = await start();
    await t.store.enqueueJob('collect', 'sun', {}, NOW);
    const { job } = await (await t.call('POST', '/api/jobs/claim')).json();
    await t.call('POST', `/api/jobs/${job.id}/finish`, { status: 'done', result: { upcoming: 120, published: { ok: false, error: 'publish-failed', message: 'db write failed' } } });
    expect(t.slack.alerts.map(a => a.title)).toEqual(["Collect finished but its events didn't publish"]);
    expect(t.slack.alerts[0].text).toContain('db write failed');
    expect(t.slack.notes.map(n => n.title)).not.toContain('🗓️ Collect done');
  });

  it('a worker busy with a long collect is not silent; past the job\'s limit it is', async () => {
    let now = NOW;
    const t = await start({ now: () => now });
    await t.store.enqueueJob('collect', 'sun', {}, NOW);
    await t.call('POST', '/api/jobs/claim');
    now = new Date(NOW.getTime() + 45 * 60 * 1000);                           // still collecting
    expect((await t.healthCheck(now)).problems).not.toContain('jobs_worker');
    now = new Date(NOW.getTime() + 80 * 60 * 1000);
    expect((await t.healthCheck(now)).problems).toContain('jobs_worker');
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
  afterEach(() => useTown(VICTORIA));

  async function run() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-jobs-'));
    dirs.push(dir);
    const store = new FileStore(path.join(dir, 's.json'));
    const github = { calls: [], isConfigured: () => true, branch: 'main', dispatchWorkflow: async (f) => { github.calls.push(f); } };
    const queued = [];
    const s = createScheduler({ store, github, log: { warn() {} },
      queueJob: async (job, slot) => { queued.push([job.kind, slot]); },
      canQueue: job => canRunOnWorker(job) });
    await s.tick(new Date('2026-10-07T13:48:00Z'));     // ads, social kit and the review are due
    await s.tick(new Date('2026-10-07T20:30:00Z'));     // Wednesday's collect
    return { github, queued };
  }

  it('queues every worker job for Victoria too (social kit and ads report included); nothing on GitHub', async () => {
    const { github, queued } = await run();
    expect(github.calls).toEqual([]);
    expect(queued.map(q => q[0])).toEqual(['meta-ads', 'social-kit', 'submission-review', 'collect', 'submission-review']);
  });

  it('another town the same way', async () => {
    useTown(townConfig({ TOWN: 'kearney' }));       // "workflows": false
    const { github, queued } = await run();
    expect(github.calls).toEqual([]);
    expect(queued.map(q => q[0])).toEqual(['meta-ads', 'social-kit', 'submission-review', 'collect', 'submission-review']);
  });

  it('every kind runs on the worker for every town', () => {
    for (const t of [VICTORIA, townConfig({ TOWN: 'medford' })]) {
      useTown(t);
      for (const kind of ['social-kit', 'meta-ads', 'digest', 'collect', 'event-check', 'submission-review']) {
        expect(canRunOnWorker({ kind })).toBe(true);
      }
      expect(canRunOnWorker({ kind: 'newsletter' })).toBe(false);
      expect(canRunOnWorker({ kind: 'toString' })).toBe(false);
      expect(canRunOnWorker({ name: 'newsletter' })).toBe(false);
    }
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

describe('HQ sees the jobs', () => {
  it('jobsSummary: each kind\'s last run however long ago, the worker\'s check-in and the day\'s failures', async () => {
    const { jobsSummary } = await import('../server/hq.js');
    const t = await start();
    const now = new Date('2026-10-08T12:00:00Z');
    const old = new Date('2026-10-04T20:00:00Z');
    await t.store.enqueueJob('collect', 'sun', {}, old);
    const c = await t.store.claimJob(old);
    await t.store.finishJob(c.id, { status: 'done', result: { upcoming: 206, events: 250, warnings: '1 warning', sources: { town_feeds: 120 }, seconds: 1800 } }, old);
    for (let i = 0; i < 300; i++) {          // a busy week of reviews doesn't push the collect out
      await t.store.enqueueJob('submission-review', `s${i}`, {}, now);
      const j = await t.store.claimJob(now);
      await t.store.finishJob(j.id, { status: 'done', result: { seconds: 2 } }, now);
    }
    await t.store.enqueueJob('event-check', 'e', {}, now);
    const e = await t.store.claimJob(now);
    await t.store.finishJob(e.id, { status: 'failed', result: { error: 'exited 1', seconds: 4 } }, now);
    const out = jobsSummary({ ...(await t.store.jobStats(now)), worker_last_seen: '2026-10-08T11:59:30Z', worker_since: '2026-10-08T09:00:00Z' });
    expect(out).toMatchObject({
      worker_last_seen: '2026-10-08T11:59:30Z', worker_since: '2026-10-08T09:00:00Z', queued: 0, failed_24h: 1, running: [],
      last: {
        'event-check': { status: 'failed', seconds: 4, error: 'exited 1' },
        collect: { status: 'done', seconds: 1800, upcoming: 206, events: 250, warnings: '1 warning', sources: { town_feeds: 120 } },
        'submission-review': { status: 'done', seconds: 2 }
      }
    });
  });

  it('a town on jobs reports them in /api/hq/summary; one without has no jobs key', async () => {
    const key = 'h'.repeat(40);
    const summary = async env => {
      const t = await start({ env });
      return { t, body: await (await fetch(t.base + '/api/hq/summary', { headers: { Authorization: `Bearer ${key}` } })).json() };
    };
    process.env.HQ_API_KEY = key;
    try {
      const { body: off } = await summary({});
      expect(off).not.toHaveProperty('jobs');
      const on = await summary(ON);
      expect(on.body.jobs).toMatchObject({ worker_last_seen: null, queued: 0, last: {} });
      expect(on.body.jobs.worker_since).toBeTruthy();
    } finally {
      delete process.env.HQ_API_KEY;
    }
  });
});

describe('review fixes', () => {
  it('a health problem that clears and comes back the same day is said again (Victoria too)', async () => {
    const t = await start({ env: {} });
    const at = h => new Date(NOW.getTime() + h * 3600000);
    const many = Array.from({ length: 40 }, (_, i) => ({ date: '2026-10-09', name: `E${i}`, venue: 'V', icons: [] }));
    await t.healthCheck(at(0));
    const said = () => t.slack.alerts.filter(a => a.text && /upcoming events/.test(a.text)).length;
    expect(said()).toBe(1);
    await t.store.setPublished({ events: many, auto_publish: { from: '2026-10-07T00:00:00Z' } });
    expect((await t.healthCheck(at(1))).problems).not.toContain('upcoming');
    await t.store.setPublished({ events: [], auto_publish: { from: '2026-10-07T00:00:00Z' } });
    await t.healthCheck(at(2));
    expect(said()).toBe(2);
  });

  it("a failed read of the collect's copy never falls back to an older bundled file", async () => {
    const t = await start();
    await fs.writeFile(path.join(t.dir, 'candidates.json'), JSON.stringify({ last_updated: '2026-09-01T00:00:00Z', events: [{ date: '2026-10-09', name: 'Old', venue: 'X', icons: [] }] }));
    await t.store.setTownFile('candidates', CANDIDATES, NOW);
    t.store.getTownFile = async () => { throw new Error('pool timeout'); };
    const login = await (await fetch(t.base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: LONG.adminUsername, password: LONG.adminPassword }) })).json();
    const r = await (await fetch(t.base + '/api/admin/auto-publish', { method: 'POST', headers: { Authorization: `Bearer ${login.token}` } })).json();
    expect(r.ok).toBe(false);
    const live = await (await fetch(t.base + '/events.json')).json();
    expect(live.events.map(e => e.name)).not.toContain('Old');
  });
});

describe('worker hiccups', () => {
  it('a run cut short by a redeploy is queued again quietly, once', async () => {
    const t = await start();
    await t.store.enqueueJob('collect', 'sun', {}, NOW);
    const { job } = await (await t.call('POST', '/api/jobs/claim')).json();
    await t.call('POST', `/api/jobs/${job.id}/finish`, { status: 'failed', result: { error: 'exited -15', interrupted: true } });
    expect(t.slack.alerts).toEqual([]);
    const again = (await (await t.call('POST', '/api/jobs/claim')).json()).job;
    expect(again).toMatchObject({ kind: 'collect', slot: 'sun-retry' });
    await t.call('POST', `/api/jobs/${again.id}/finish`, { status: 'failed', result: { error: 'exited -15', interrupted: true } });
    expect(t.slack.alerts).toHaveLength(1);                 // the retry cut short too: said
  });
});

describe('Victoria on jobs needs no GitHub (JOBS_ON_RAILWAY.md phase 5)', () => {
  async function admin(t) {
    const r = await fetch(t.base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: LONG.adminUsername, password: LONG.adminPassword }) });
    const token = (await r.json()).token;
    return (method, p, body) => fetch(t.base + p, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }

  for (const [label, extra] of [['GITHUB_TOKEN unset', {}], ['a leftover GITHUB_TOKEN', { githubToken: 'gh-left-over' }]]) {
    it(`admin, Pull Now and Save & Publish work from the database with ${label}`, async () => {
      const gh = [];
      const t = await start({ extra: { ...extra, fetch: async url => { gh.push(String(url)); return { ok: false, status: 500, json: async () => ({}) }; } } });
      const a = await admin(t);
      const cfg = await (await fetch(t.base + '/api/config')).json();
      expect(cfg).toMatchObject({ github_publish_enabled: false, sources_trigger_enabled: true, sources_actions_url: null, jobs_on_railway: true });
      // The collect's candidates (handed over by the worker) are what the editor sees.
      expect((await t.call('PUT', '/api/jobs/files/candidates', CANDIDATES)).status).toBe(200);
      const cands = await (await a('GET', '/api/admin/candidates')).json();
      expect(cands.source).toBe('jobs');
      // Save & Publish: the database only, no commit to docs/events.json.
      const pub = await (await a('POST', '/api/admin/publish-events', { events: CANDIDATES.events.slice(0, 1) })).json();
      expect(pub.ok).toBe(true);
      expect(pub.destinations.github).toMatchObject({ ok: false, error: 'github-not-configured' });
      expect((await (await fetch(t.base + '/events.json')).json()).events.map(e => e.name)).toEqual(['Trivia Night']);
      // Pull Now queues a collect; the Sources tab offers it.
      expect((await (await a('POST', '/api/admin/trigger-collect')).json()).queued).toBe(true);
      expect((await (await a('GET', '/api/admin/sources')).json())).toMatchObject({ trigger_enabled: true, actions_url: null });
      // The setup checklist: the scheduled jobs are fine without GitHub.
      const setup = await (await a('GET', '/api/admin/setup')).json();
      expect(setup.checks.find(c => c.key === 'scheduler').ok).toBe(true);
      expect(JSON.stringify(setup.checks)).not.toMatch(/GitHub secret|In GitHub/);
      expect(gh).toEqual([]);
    });
  }
});

describe('the ads report and the digest on the worker', () => {
  it('a finished ads report goes to Slack activity; a town without ads settings says nothing', async () => {
    const t = await start();
    const run = async result => {
      await t.store.enqueueJob('meta-ads', `s${Math.random()}`, {}, NOW);
      const job = (await (await t.call('POST', '/api/jobs/claim')).json()).job;
      expect(job.kind).toBe('meta-ads');
      return t.call('POST', `/api/jobs/${job.id}/finish`, { status: 'done', result });
    };
    await run({ skipped: 'no ads settings' });
    expect(t.slack.notes).toEqual([]);
    await run({ report: '📈 Meta ads: yesterday $5.00 spent\nLast 7 days: $30.00 spent', link: 'https://adsmanager.facebook.com/x' });
    expect(t.slack.notes).toEqual([expect.objectContaining({ title: '📈 Meta ads: yesterday $5.00 spent', text: 'Last 7 days: $30.00 spent',
      link: 'https://adsmanager.facebook.com/x', channel: 'activity' })]);
  });

  it('a failed ads report or digest alerts like any failed job', async () => {
    const t = await start();
    for (const kind of ['meta-ads', 'digest']) {
      await t.store.enqueueJob(kind, 'x', {}, NOW);
      const job = (await (await t.call('POST', '/api/jobs/claim')).json()).job;
      await t.call('POST', `/api/jobs/${job.id}/finish`, { status: 'failed', result: { error: 'Meta ads daily check failed: token' } });
    }
    expect(t.slack.alerts.map(a => a.title)).toEqual(['Meta ads report failed', 'Weekly digest email failed']);
  });
});
