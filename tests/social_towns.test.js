// @vitest-environment node
//
// The social kit on a town's jobs worker (JOBS_ON_RAILWAY.md 2b): the
// worker uploads the kit to its own site, which keeps only the latest one
// in its database and serves it at /social/latest/<name> (Facebook and
// Instagram fetch the slides there). Victoria's too since she moved
// (JOBS_ON_RAILWAY.md phase 5): until her worker publishes its first kit
// (or without jobs on) her git copy in docs/social is served, and what
// GitHub posted (docs/social/latest/posted.json) seeds her worker's dedupe.
// Another town without a kit, and any path that isn't its own kit, is a 404.
//
// The Postgres half runs when TEST_DATABASE_URL points at a throwaway
// server (each run makes and drops its own database).

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { townConfig, useTown, VICTORIA, DOCS_DIR } from '../server/town.js';
import { createApp } from '../server/index.js';
import { FileStore, createStore } from '../server/db.js';
import { createScheduler } from '../server/scheduler.js';
import { canRunOnWorker, createJobs, SOCIAL_LIMITS } from '../server/jobs.js';

const NOW = new Date('2026-10-15T15:00:00Z');
const SECRET = 's'.repeat(40);
const ON = { JOBS_ON_RAILWAY: '1', JOBS_SECRET: SECRET };
const BAY = { siteName: 'The Bay 979', domain: 'thebay979.com', city: 'Bay City', state: 'TX', stateName: 'Texas', timezone: 'America/Chicago' };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const quiet = () => {
  const s = { enabled: true, alerts: [], notes: [] };
  s.notify = async n => { s.notes.push(n); return true; };
  s.alert = async (key, title, text) => { s.alerts.push({ key, title, text }); return true; };
  return s;
};

let towns, saved;
beforeAll(async () => {
  saved = process.env.TOWN;
  towns = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-social-towns-'));
  await fs.mkdir(path.join(towns, 'bay', 'public'), { recursive: true });
  await fs.writeFile(path.join(towns, 'bay', 'town.json'), JSON.stringify(BAY));
});
afterAll(async () => {
  if (saved === undefined) delete process.env.TOWN; else process.env.TOWN = saved;
  useTown(VICTORIA);
  await fs.rm(towns, { recursive: true, force: true });
});

let servers = [], dirs = [];
afterEach(async () => {
  for (const s of servers) await new Promise(r => s.close(r));
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  servers = []; dirs = [];
  if (saved === undefined) delete process.env.TOWN; else process.env.TOWN = saved;
  useTown(VICTORIA);
});

async function start({ town = 'bay', env = ON, store = null, extra = {} } = {}) {
  if (town) process.env.TOWN = town; else delete process.env.TOWN;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-social-'));
  dirs.push(dir);
  const eventsFile = path.join(dir, 'events.json');
  await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
  const slack = quiet();
  const out = await createApp({
    townsDir: towns, storeBundle: { kind: store ? 'postgres' : 'file', store: store || new FileStore(path.join(dir, 's.json')) },
    eventsFile, candidatesFile: path.join(dir, 'candidates.json'), trustProxy: false, now: () => NOW,
    ...(town ? {} : { siteUrl: 'https://www.thevic361.com' }), resendApiKey: '', slack, autoPublish: false, startScheduler: false,
    jobsEnv: env, adminUsername: 'admin', adminPassword: 'a-long-enough-pass', adminSessionSecret: 'x'.repeat(32), ...extra
  });
  const server = http.createServer(out.app);
  servers.push(server);
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const put = (build, name, body, secret = SECRET) => fetch(`${base}/api/jobs/social/${build}/${name}`, {
    method: 'PUT', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/octet-stream' }, body });
  const publish = build => fetch(`${base}/api/jobs/social/${build}/publish`, { method: 'POST', headers: { Authorization: `Bearer ${SECRET}` } });
  const call = (method, p, body) => fetch(base + p, { method, headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { ...out, base, put, publish, call, slack };
}

const kitJson = (build, extra = {}) => JSON.stringify({ generated_for: '2026-10-15', build,
  kits: { today: { slides: ['today-1.png'], slides_jpg: ['today-1.jpg'], events: 3, featured: 0, ...extra } } });

async function uploadKit(t, build, { png = PNG } = {}) {
  expect((await t.put(build, 'today-1.png', png)).status).toBe(200);
  expect((await t.put(build, 'today-1.jpg', Buffer.from('JPEG'))).status).toBe(200);
  expect((await t.put(build, 'index.html', Buffer.from('<h1>The Bay 979 kit</h1>'))).status).toBe(200);
  expect((await t.put(build, 'kit.json', Buffer.from(kitJson(build)))).status).toBe(200);
}

async function servingChecks(t) {
  // Nothing published yet: a 404, like a town that never had a kit.
  expect((await fetch(t.base + '/social/latest/kit.json')).status).toBe(404);
  await uploadKit(t, 'w1');
  expect((await fetch(t.base + '/social/latest/kit.json')).status).toBe(404);      // staged, not live
  expect((await t.publish('w1')).status).toBe(200);
  const png = await fetch(t.base + '/social/latest/today-1.png');
  expect(png.status).toBe(200);
  expect(png.headers.get('content-type')).toBe('image/png');
  expect(png.headers.get('x-robots-tag')).toBe('noindex');
  expect(Buffer.from(await png.arrayBuffer())).toEqual(PNG);
  expect((await fetch(t.base + '/social/latest/today-1.png', { method: 'HEAD' })).status).toBe(200);
  expect((await (await fetch(t.base + '/social/latest/kit.json')).json()).build).toBe('w1');
  const page = await fetch(t.base + '/social/', { redirect: 'follow' });
  expect([page.status, await page.text()]).toEqual([200, '<h1>The Bay 979 kit</h1>']);
  expect((await fetch(t.base + '/social/latest/week-1.png')).status).toBe(404);
  expect((await fetch(t.base + '/social/latest/captions.txt')).status).toBe(404);   // not in this kit
  // The next build replaces it whole: the old one's files are gone.
  const NEW = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9]);
  await uploadKit(t, 'w2', { png: NEW });
  expect(Buffer.from(await (await fetch(t.base + '/social/latest/today-1.png')).arrayBuffer())).toEqual(PNG);  // until published
  expect((await t.publish('w2')).status).toBe(200);
  expect(Buffer.from(await (await fetch(t.base + '/social/latest/today-1.png')).arrayBuffer())).toEqual(NEW);
  expect((await (await fetch(t.base + '/social/latest/kit.json')).json()).build).toBe('w2');
}

describe('a town’s social kit, stored and served from its own database', () => {
  it('uploads stay staged until published, then the latest kit is served and the previous one dropped', async () => {
    const t = await start();
    await servingChecks(t);
    expect(await t.store.socialBuildSize('w1')).toMatchObject({ files: 0 });
  });

  it('publishing checks the kit is whole and the names, builds and sizes are sane', async () => {
    const t = await start();
    expect((await t.put('w1', 'today-1.png', PNG, 'w'.repeat(40))).status).toBe(401);
    expect((await t.put('w1', '..%2Fx.png', PNG)).status).toBe(400);
    expect((await t.put('w1', 'today-1.exe', PNG)).status).toBe(400);
    expect((await t.put('bad_build!', 'today-1.png', PNG)).status).toBe(400);
    expect((await t.put('w1', 'today-1.png', Buffer.alloc(0))).status).toBe(400);
    expect((await t.publish('w1')).status).toBe(400);                               // no kit.json
    await t.put('w1', 'kit.json', Buffer.from(kitJson('w1')));
    const r = await t.publish('w1');
    expect([r.status, (await r.json()).error]).toEqual([400, 'missing-files']);   // its slides aren't there
    await t.put('w2', 'kit.json', Buffer.from(kitJson('other')));
    expect((await t.publish('w2')).status).toBe(400);                               // another run's manifest
    const big = Buffer.alloc(SOCIAL_LIMITS.fileBytes + 1);
    expect((await t.put('w1', 'weekend.mp4', big)).status).toBe(413);
  });

  it('without jobs on, nothing is accepted', async () => {
    const t = await start({ env: {} });
    expect((await t.put('w1', 'today-1.png', PNG)).status).toBe(404);
  });

  it('what was posted is a file the worker can keep on the site', async () => {
    const t = await start();
    expect((await t.call('PUT', '/api/jobs/files/social_posted', { '2026-10-15:today': { facebook: 'pending' } })).status).toBe(200);
    expect((await (await t.call('GET', '/api/jobs/files/social_posted')).json()).data).toEqual({ '2026-10-15:today': { facebook: 'pending' } });
  });
});

describe('Victoria’s kit moves to her database', () => {
  const gitKit = () => fs.readFile(path.join(DOCS_DIR, 'social', 'latest', 'kit.json'), 'utf8');

  it('git’s kit until her worker publishes one, then only the database’s', async () => {
    const t = await start({ town: null });
    let kit = await fetch(t.base + '/social/latest/kit.json');
    expect([kit.status, await kit.text()]).toEqual([200, await gitKit()]);
    expect((await fetch(t.base + '/social/latest/week-1.png')).status).toBe(200);      // git's
    await uploadKit(t, 'w1');
    expect(await (await fetch(t.base + '/social/latest/kit.json')).text()).toBe(await gitKit());   // staged only
    expect((await t.publish('w1')).status).toBe(200);
    kit = await fetch(t.base + '/social/latest/kit.json');
    expect((await kit.json()).build).toBe('w1');
    expect(Buffer.from(await (await fetch(t.base + '/social/latest/today-1.png')).arrayBuffer())).toEqual(PNG);
    expect((await fetch(t.base + '/social/latest/week-1.png')).status).toBe(404);      // not in her new kit
    expect((await fetch(t.base + '/social/latest/posted.json')).status).toBe(404);
  });

  it('without jobs on nothing is accepted and git’s kit is served, as before', async () => {
    const t = await start({ town: null, env: {} });
    expect((await t.put('w1', 'today-1.png', PNG)).status).toBe(404);
    expect(await (await fetch(t.base + '/social/latest/kit.json')).text()).toBe(await gitKit());
  });

  it('what GitHub posted seeds her worker’s dedupe, so switch day never posts twice', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-posted-'));
    dirs.push(dir);
    const file = path.join(dir, 'posted.json');
    await fs.writeFile(file, JSON.stringify({ '2026-10-15:weekend': { facebook: '1388965530960534_1' } }));
    const t = await start({ town: null, extra: { socialPostedFile: file } });
    const get = async () => (await (await t.call('GET', '/api/jobs/files/social_posted')).json()).data;
    expect(await get()).toEqual({ '2026-10-15:weekend': { facebook: '1388965530960534_1' } });
    // The worker saves its own (with the seed it was given, plus today's).
    await t.call('PUT', '/api/jobs/files/social_posted', { '2026-10-16:today': { facebook: 'pending' } });
    expect(await get()).toEqual({ '2026-10-15:weekend': { facebook: '1388965530960534_1' }, '2026-10-16:today': { facebook: 'pending' } });
    // The real docs/social/latest/posted.json is the default seed.
    const real = JSON.parse(await fs.readFile(path.join(DOCS_DIR, 'social', 'latest', 'posted.json'), 'utf8'));
    const v = await start({ town: null });
    expect((await (await v.call('GET', '/api/jobs/files/social_posted')).json()).data).toEqual(real);
    // Another town has no seed.
    expect((await (await start()).call('GET', '/api/jobs/files/social_posted')).status).toBe(404);
  });

  it('another town’s stored kit never brings Victoria’s files along', async () => {
    const t = await start();
    await uploadKit(t, 'w1');
    await t.publish('w1');
    for (const p of ['/social/latest/week-1.png', '/social/latest/weekend.mp4', '/social/latest/posted.json', '/social/latest/outreach.txt']) {
      expect((await fetch(t.base + p)).status).toBe(404);
    }
  });
});

describe('who runs the social kit', () => {
  const job = { name: 'social-kit', kind: 'social-kit' };
  it('the worker, for every town', () => {
    expect(canRunOnWorker(job)).toBe(true);
    expect(canRunOnWorker({ kind: 'meta-ads' })).toBe(true);
    expect(canRunOnWorker({ kind: 'collect' })).toBe(true);
  });

  async function day(townId, { jobsOn = true, collected = true } = {}) {
    if (townId) useTown(townConfig({ TOWN: townId })); else useTown(VICTORIA);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-sched-'));
    dirs.push(dir);
    const store = new FileStore(path.join(dir, 's.json'));
    const github = { calls: [], isConfigured: () => true, branch: 'main', dispatchWorkflow: async f => { github.calls.push(f); } };
    const queued = [];
    const s = createScheduler({ store, github, log: { warn() {} }, handlers: { collected: async () => collected },
      queueJob: jobsOn ? async (j, slot) => { queued.push([j.kind, slot]); } : null,
      canQueue: j => canRunOnWorker(j) });
    // 8:50 AM in each town (the social kit's 8:47 slot).
    const tzNow = { victoria: '2026-10-15T13:50:00Z', medford: '2026-10-15T15:50:00Z', kearney: '2026-10-15T13:50:00Z' }[townId || 'victoria'];
    await s.tick(new Date(tzNow));
    return { github: github.calls, queued: queued.map(q => q[0]) };
  }

  it('a jobs town queues it at 8:47 its own time, after its first collect', async () => {
    expect((await day('medford')).queued).toContain('social-kit');
    expect((await day('medford')).github).toEqual([]);
    expect((await day('medford', { collected: false })).queued).not.toContain('social-kit');
  });

  it('a paused town (JOBS_ON_RAILWAY=0, workflows off) never starts it', async () => {
    expect(await day('kearney', { jobsOn: false })).toEqual({ github: [], queued: [] });
  });

  it('Victoria with jobs on queues hers (and her ads report) for her worker; nothing on GitHub', async () => {
    const v = await day(null);
    expect(v.github).toEqual([]);
    expect(v.queued).toEqual(expect.arrayContaining(['social-kit', 'meta-ads']));
  });
});

describe('a social kit run reports like the other jobs', () => {
  it('a failed post alerts with the town; Monday’s venues to tag go to activity', async () => {
    const t = await start();
    const run = async (status, result) => {
      await t.store.enqueueJob('social-kit', `${status}-${Math.random()}`, {}, NOW);
      const { job } = await (await t.call('POST', '/api/jobs/claim')).json();
      expect(job.kind).toBe('social-kit');
      await t.call('POST', `/api/jobs/${job.id}/finish`, { status, result });
    };
    await run('failed', { error: 'Posting failed: Facebook: POST 1/feed failed: {"code":190}' });
    expect(t.slack.alerts).toEqual([expect.objectContaining({ title: 'Social posts (Facebook/Instagram) failed', text: expect.stringContaining('The Bay 979: Posting failed') })]);
    await run('done', { posted: 'week', outreach: '📣 *2 venues* …' });
    expect(t.slack.notes.map(n => n.title)).toEqual(expect.arrayContaining(['✅ Social posts (Facebook/Instagram) working again', '📣 Venues to tag this week']));
  });

  it('the worker counts as busy while it posts', async () => {
    const t = await start();
    await t.store.enqueueJob('social-kit', 'd', {}, NOW);
    await t.call('POST', '/api/jobs/claim');
    const fresh = createJobs({ store: t.store, env: ON, nowFn: () => NOW });
    expect(await fresh.busy(new Date(NOW.getTime() + 40 * 60 * 1000))).toBe(true);
  });
});

const PG = process.env.TEST_DATABASE_URL;
describe.skipIf(!PG)('on Postgres (TEST_DATABASE_URL)', () => {
  let admin, dbName, bundle;
  beforeAll(async () => {
    const { default: pg } = await import('pg');
    admin = new pg.Client({ connectionString: PG });
    await admin.connect();
    dbName = `social_test_${process.pid}_${Date.now()}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(PG);
    url.pathname = `/${dbName}`;
    url.searchParams.set('sslmode', 'disable');
    bundle = await createStore({ databaseUrl: url.toString() });
  });
  afterAll(async () => {
    if (bundle) await bundle.pool.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
      await admin.end();
    }
  });

  it('Victoria: git’s kit until her first kit is in her database, then the database’s', async () => {
    const t = await start({ town: null, store: bundle.store });
    expect(await (await fetch(t.base + '/social/latest/kit.json')).text())
      .toBe(await fs.readFile(path.join(DOCS_DIR, 'social', 'latest', 'kit.json'), 'utf8'));
    await uploadKit(t, 'v1');
    expect((await t.publish('v1')).status).toBe(200);
    expect((await (await fetch(t.base + '/social/latest/kit.json')).json()).build).toBe('v1');
    expect((await fetch(t.base + '/social/latest/week-1.png')).status).toBe(404);
    await bundle.pool.query("DELETE FROM social_files; DELETE FROM town_files WHERE name = 'social_kit'");
  });

  it('stores, serves and replaces a town’s kit the same way', async () => {
    const t = await start({ store: bundle.store });
    await servingChecks(t);
    const rows = await bundle.pool.query('SELECT DISTINCT build FROM social_files');
    expect(rows.rows.map(r => r.build)).toEqual(['w2']);
  });

  it('an abandoned upload is dropped when the next one starts', async () => {
    const s = bundle.store;
    await s.putSocialFile('dead', 'a.png', 'image/png', PNG);
    await s.putSocialFile('w3', 'a.png', 'image/png', PNG);
    expect((await s.socialBuildSize('dead')).files).toBe(0);
    expect((await s.socialBuildSize('w2')).files).toBeGreaterThan(0);   // the live kit stays
  });
});
