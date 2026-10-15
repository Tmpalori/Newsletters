// @vitest-environment node
//
// MULTI_CITY_PLAN.md 2.5: another town won't start on settings or a
// database copied from Victoria's. Victoria skips every check, so its boot
// can't change.

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { townConfig, townBootProblems, useTown, VICTORIA, victoriaBootProblem } from '../server/town.js';
import { createApp } from '../server/index.js';
import { FileStore, PgStore } from '../server/db.js';

const BAY = { id: 'bay', siteName: 'The Bay 979', domain: 'thebay979.com', city: 'Bay City', state: 'TX', stateName: 'Texas', timezone: 'America/Chicago' };
const bay = townConfig({}, { town: BAY });
const OK = { siteUrl: 'https://www.thebay979.com', emailFrom: 'The Bay 979 <news@thebay979.com>' };

let tmpDir;
afterEach(async () => {
  useTown(VICTORIA);
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

describe('townBootProblems', () => {
  it('passes Victoria and a town on its own settings', () => {
    expect(townBootProblems(VICTORIA, { siteUrl: 'https://www.thevic361.com', emailFrom: VICTORIA.emailFrom })).toEqual([]);
    expect(townBootProblems(bay, OK)).toEqual([]);
  });

  it("stops another town on Victoria's URL, sender or Google tag", () => {
    expect(townBootProblems(bay, { ...OK, siteUrl: 'https://www.thevic361.com' })).toEqual([expect.stringMatching(/^SITE_URL is Victoria's/)]);
    expect(townBootProblems(bay, { ...OK, siteUrl: 'https://thevic361.com' })).toHaveLength(1);
    expect(townBootProblems(bay, { ...OK, emailFrom: 'The Vic 361 <news@thevic361.com>' })).toEqual([expect.stringMatching(/^NEWSLETTER_FROM/)]);
    expect(townBootProblems(townConfig({}, { town: { ...BAY, gaId: VICTORIA.gaId } }), OK)).toEqual([expect.stringMatching(/^gaId is Victoria's/)]);
    expect(townBootProblems(bay, { ...OK, siteUrl: 'https://www.notthevic361.com' })).toEqual([]);
  });
});

async function boot(extra) {
  tmpDir = tmpDir || await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-guards-'));
  const eventsFile = path.join(tmpDir, 'events.json');
  await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
  const store = extra.store || new FileStore(path.join(tmpDir, 's.json'));
  const { store: _, ...rest } = extra;
  return createApp({ storeBundle: { kind: 'file', store }, eventsFile, trustProxy: false,
    adminUsername: 'a', adminPassword: 'b', adminSessionSecret: 'c', ...rest });
}

describe('createApp', () => {
  it("won't start another town on Victoria's settings", async () => {
    await expect(boot({ town: BAY, siteUrl: 'https://www.thevic361.com' })).rejects.toThrow(/TOWN=bay won't start: SITE_URL is Victoria's/);
    await expect(boot({ town: BAY, siteUrl: OK.siteUrl, newsletterFrom: VICTORIA.emailFrom })).rejects.toThrow(/NEWSLETTER_FROM/);
  });

  it('claims a new database, then only starts the town that owns it', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-guards-'));
    const file = path.join(tmpDir, 's.json');
    await boot({ town: BAY, siteUrl: OK.siteUrl, store: new FileStore(file) });
    expect(JSON.parse(await fs.readFile(file, 'utf8')).town_meta).toEqual({ town: 'bay' });
    await boot({ town: BAY, siteUrl: OK.siteUrl, store: new FileStore(file) });   // its own again: fine
    const tulsa = { ...BAY, id: 'tulsa', domain: 'tulsatoday.com', city: 'Tulsa', state: 'OK', stateName: 'Oklahoma' };
    await expect(boot({ town: tulsa, siteUrl: 'https://www.tulsatoday.com', store: new FileStore(file) }))
      .rejects.toThrow(/TOWN=tulsa won't start: its database belongs to TOWN=bay/);
  });

  it("won't take over a database with people in it from before towns", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-guards-'));
    const store = new FileStore(path.join(tmpDir, 's.json'));
    await store.addSubscriber({ email: 'reader@example.com', source: 'test' });
    await expect(boot({ town: BAY, siteUrl: OK.siteUrl, store })).rejects.toThrow(/from before towns \(Victoria's\)/);
    expect((await store._read()).town_meta).toBeUndefined();
  });

  it('Victoria starts without claiming anything', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-guards-'));
    const store = new FileStore(path.join(tmpDir, 's.json'));
    await store.addSubscriber({ email: 'reader@example.com', source: 'test' });
    await boot({ store, siteUrl: 'https://www.thevic361.com' });
    expect((await store._read()).town_meta).toBeUndefined();
  });
});

describe('PgStore.claimTown', () => {
  const pool = ({ owner = null, people = 0 } = {}) => {
    const seen = [];
    let town = owner;
    return { seen, query: async (text, params) => {
      seen.push(text);
      if (/information_schema\.tables/.test(text)) return { rows: [{ table_name: 'subscribers' }, { table_name: 'sponsor_orders' }] };
      if (/SELECT value FROM town_meta/.test(text)) return { rows: town ? [{ value: town }] : [] };
      if (/AS n$/.test(text.trim())) return { rows: [{ n: String(people) }] };
      if (/INSERT INTO town_meta/.test(text)) { town = town || params[0]; return { rows: [] }; }
      return { rows: [] };
    } };
  };

  it('claims an empty database once', async () => {
    const p = pool();
    expect(await new PgStore(p).claimTown('bay')).toEqual({ town: 'bay', claimed: true, hasData: false });
    expect(p.seen.some(t => /CREATE TABLE IF NOT EXISTS town_meta/.test(t))).toBe(true);
  });

  it('reports the owner, or the people already in it', async () => {
    expect(await new PgStore(pool({ owner: 'tulsa' })).claimTown('bay')).toEqual({ town: 'tulsa', claimed: false, hasData: null });
    const full = pool({ people: 3 });
    expect(await new PgStore(full).claimTown('bay')).toEqual({ town: null, claimed: false, hasData: true });
    expect(full.seen.some(t => /INSERT INTO town_meta/.test(t))).toBe(false);
  });

  it("isn't part of ready(), so Victoria's database gets no new table", async () => {
    const p = pool();
    await new PgStore(p).ready();
    expect(p.seen.some(t => /town_meta/.test(t))).toBe(false);
  });
});

describe('claiming the database through an outage', () => {
  const outage = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

  it('retries a database that is down at boot, then claims it', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-guards-'));
    const store = new FileStore(path.join(tmpDir, 's.json'));
    const real = store.claimTown.bind(store);
    let tries = 0;
    store.claimTown = async id => { if (++tries < 3) throw outage(); return real(id); };
    await boot({ town: BAY, siteUrl: OK.siteUrl, store, claimRetryMs: [1, 1, 1] });
    expect(tries).toBe(3);
    expect((await store._read()).town_meta).toEqual({ town: 'bay' });
  });

  it('gives up after the retries, and never retries a real error', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-guards-'));
    const down = new FileStore(path.join(tmpDir, 'a.json'));
    down.claimTown = async () => { throw outage(); };
    await expect(boot({ town: BAY, siteUrl: OK.siteUrl, store: down, claimRetryMs: [1, 1] })).rejects.toThrow(/ECONNREFUSED/);
    const broken = new FileStore(path.join(tmpDir, 'b.json'));
    let tries = 0;
    broken.claimTown = async () => { tries++; throw Object.assign(new Error('syntax error'), { code: '42601' }); };
    await expect(boot({ town: BAY, siteUrl: OK.siteUrl, store: broken, claimRetryMs: [1, 1] })).rejects.toThrow(/syntax error/);
    expect(tries).toBe(1);
  });
});

describe('workflows for another town (until its GitHub Environment exists)', () => {
  it('Victoria may always start them; another town only with TOWN_WORKFLOWS=1', async () => {
    const { townWorkflowsReady } = await import('../server/town.js');
    expect(townWorkflowsReady(VICTORIA, {})).toBe(true);
    expect(townWorkflowsReady(bay, {})).toBe(false);
    expect(townWorkflowsReady(bay, { TOWN_WORKFLOWS: '1' })).toBe(true);
  });

  it('town.json "workflows": true turns them on too (one switch with GitHub\'s collect); TOWN_WORKFLOWS=0 turns them off', async () => {
    const { townWorkflowsReady } = await import('../server/town.js');
    const ready = { ...bay, workflows: true };
    expect(townWorkflowsReady(ready, {})).toBe(true);
    expect(townWorkflowsReady(ready, { TOWN_WORKFLOWS: '0' })).toBe(false);
    expect(townWorkflowsReady(VICTORIA, { TOWN_WORKFLOWS: '0' })).toBe(true);
  });

  it("another town's Pull Now answers 409 instead of dispatching", async () => {
    const http = (await import('node:http')).default;
    const calls = [];
    const { app } = await boot({ town: BAY, siteUrl: OK.siteUrl, githubToken: 'gh', githubOwner: 'o', githubRepo: 'r',
      fetch: async (url, init) => { calls.push(url); return { ok: true, status: 204, json: async () => ({}) }; } });
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const login = await (await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'a', password: 'b' }) })).json();
      const r = await fetch(base + '/api/admin/trigger-collect', { method: 'POST', headers: { Authorization: `Bearer ${login.token}` } });
      expect(r.status).toBe(409);
      expect((await r.json()).error).toBe('town-workflows-not-ready');
      expect(calls.filter(u => /dispatches/.test(u))).toEqual([]);
    } finally {
      await new Promise(r => server.close(r));
    }
  });
});


describe('a service with TOWN forgotten', () => {
  it("passes Victoria on its own URL, none, or Railway's and local hosts", () => {
    for (const url of ['', 'https://www.thevic361.com', 'https://thevic361.com/', 'https://staging.thevic361.com',
      'https://thevic361-staging.up.railway.app', 'http://localhost:3000', 'http://127.0.0.1:3000', 'not a url']) {
      expect(victoriaBootProblem(VICTORIA, url), url).toBe('');
    }
    expect(victoriaBootProblem(bay, 'https://www.thebay979.com')).toBe('');   // another town: townBootProblems' job
  });

  it("stops Victoria on another town's SITE_URL, with what to set", async () => {
    const why = victoriaBootProblem(VICTORIA, 'https://www.thebay979.com');
    expect(why).toMatch(/TOWN is unset \(Victoria\) but SITE_URL is https:\/\/www\.thebay979\.com/);
    expect(why).toMatch(/Set TOWN to the town's slug/);
    expect(victoriaBootProblem(VICTORIA, 'https://www.notthevic361.com')).not.toBe('');
    await expect(boot({ envSiteUrl: 'https://www.thebay979.com' })).rejects.toThrow(/TOWN is unset \(Victoria\)/);
    await boot({ envSiteUrl: 'https://www.thevic361.com' });
    await boot({ envSiteUrl: '' });
  });
});

describe('/api/config town_workflows (scripts/launch_check.py)', () => {
  const config = async extra => {
    const { app } = await boot(extra);
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    try {
      return await (await fetch(`http://127.0.0.1:${server.address().port}/api/config`)).json();
    } finally {
      await new Promise(r => server.close(r));
    }
  };
  const saved = process.env.TOWN_WORKFLOWS;
  afterEach(() => { if (saved === undefined) delete process.env.TOWN_WORKFLOWS; else process.env.TOWN_WORKFLOWS = saved; });

  it("is another town's flag only; Victoria's config is unchanged", async () => {
    delete process.env.TOWN_WORKFLOWS;
    expect(await config({ siteUrl: 'https://www.thevic361.com' })).not.toHaveProperty('town_workflows');
    expect((await config({ town: BAY, siteUrl: OK.siteUrl })).town_workflows).toBe(false);
    process.env.TOWN_WORKFLOWS = '1';
    expect((await config({ town: BAY, siteUrl: OK.siteUrl })).town_workflows).toBe(true);
  });

  it('Victoria on Railway jobs says so (for the submission review cron), and nothing else changes', async () => {
    const off = await config({ siteUrl: 'https://www.thevic361.com' });
    expect(off).not.toHaveProperty('jobs_on_railway');
    const on = await config({ siteUrl: 'https://www.thevic361.com', jobs: { enabled: true, register() {} } });
    expect(on.jobs_on_railway).toBe(true);
    expect(on).not.toHaveProperty('town_workflows');
    // Pull Now works with jobs on (it queues the collect); the rest is the same.
    expect(on.sources_trigger_enabled).toBe(true);
    const { jobs_on_railway: _a, sources_trigger_enabled: _b, ...rest } = on;
    const { sources_trigger_enabled: _c, ...restOff } = off;
    expect(rest).toEqual(restOff);
  });
});
