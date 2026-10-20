// @vitest-environment node
//
// GET /api/hq/summary (server/hq.js, MULTI_CITY_PLAN.md 4.1): a town's
// numbers for the HQ dashboard. Off without HQ_API_KEY; only that key gets
// in, it opens no admin route, and nothing personal leaves.

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { createRateLimiter } from '../server/rateLimit.js';
import { buildSummary, registerHq } from '../server/hq.js';
import { VICTORIA } from '../server/town.js';

const KEY = 'hq-test-key-0123456789';
const NOW = new Date('2026-10-09T18:00:00Z');
let server, tmpDir, base, store;

afterEach(async () => {
  if (server) await new Promise(r => server.close(r));
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  server = null; tmpDir = null;
});

async function start(extra = {}) {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-hq-'));
  const eventsFile = path.join(tmpDir, 'events.json');
  await fs.writeFile(eventsFile, JSON.stringify({ events: [{ date: '2026-10-10', name: 'Fair', venue: 'Hall' }] }));
  store = new FileStore(path.join(tmpDir, 's.json'));
  await store.addSubscriber({ email: 'reader@example.com', source: 'test' });
  await store.saveSponsorOrder({ id: 'o1', kind: 'weekly', status: 'paid', amount: 30000, paid_at: '2026-10-02T12:00:00Z',
    created_at: '2026-10-01T00:00:00Z', business: 'Acme Tacos', email: 'owner@acme.example', week_start: '2026-10-12' });
  const { app } = await createApp({ storeBundle: { kind: 'file', store }, eventsFile, trustProxy: false, now: () => NOW,
    siteUrl: 'https://www.thevic361.com', adminUsername: 'a', adminPassword: 'b', adminSessionSecret: 'c', ...extra });
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
}
const get = (p, auth) => fetch(base + p, { headers: auth ? { Authorization: auth } : {} });

describe('/api/hq/summary', () => {
  it("doesn't exist without HQ_API_KEY", async () => {
    await start({ hqApiKey: '' });
    const missing = await get('/api/hq/no-such-thing');
    const r = await get('/api/hq/summary', `Bearer ${KEY}`);
    expect(r.status).toBe(missing.status);
    expect(r.status).toBe(404);
  });

  it('answers only the key, with counts and nothing personal', async () => {
    await start({ hqApiKey: KEY });
    expect((await get('/api/hq/summary')).status).toBe(401);
    expect((await get('/api/hq/summary', 'Bearer wrong')).status).toBe(401);
    const login = await (await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'a', password: 'b' }) })).json();
    expect((await get('/api/hq/summary', `Bearer ${login.token}`)).status).toBe(401);   // an admin session isn't the key
    const r = await get('/api/hq/summary', `Bearer ${KEY}`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({
      ok: true,
      town: { id: 'victoria', name: 'The Vic 361', site_url: 'https://www.thevic361.com', admin_url: 'https://www.thevic361.com/admin.html' },
      subscribers: { active: 0, pending: 1 },
      revenue: { month_to_date: { month: '2026-10', cents: 30000, orders: 1 }, orders_by_status: { paid: 1 } },
      sponsors: { weeks_booked_next_4: 1, weeks_open_next_4: 3, picks_sold_this_month: 0 },
      submissions_waiting: 0,
      health: { database: false, scheduler_blocked: false, slack_refused: false }
    });
    expect(body.setup.required_missing).toContain('database');
    // The trends the HQ charts draw: 31 days of active counts ending today,
    // six months of revenue ending this month, the next four sponsor weeks.
    expect(body.subscribers.daily).toHaveLength(31);
    expect(body.subscribers.daily.at(-1)).toMatchObject({ day: '2026-10-09', active: 0 });
    expect(body.revenue.months.map(m => m.month)).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
    expect(body.revenue.months.at(-1).cents).toBe(30000);
    expect(body.sponsors.weeks).toEqual([
      { week_start: '2026-10-12', booked: true }, { week_start: '2026-10-19', booked: false },
      { week_start: '2026-10-26', booked: false }, { week_start: '2026-11-02', booked: false }]);
    expect(body.ads).toEqual({ spend_30_days: null, cost_per_sub_30_days: null, meta_7_days: null, meta_30_days: null,
      spend_30_days_window: { from: '2026-09-09', to: '2026-10-08' }, spend_month_to_date: 0, spend_last_month: 0,
      spend_all_time: 0, first_spend_day: null, daily: [], restated_30_days: [] });
    const text = JSON.stringify(body);
    for (const personal of ['@', 'reader', 'Acme', 'owner']) expect(text).not.toContain(personal);
  });

  it('opens no admin route', async () => {
    await start({ hqApiKey: KEY });
    expect((await get('/api/admin/setup', `Bearer ${KEY}`)).status).toBe(401);
    expect((await get('/api/admin/growth', `Bearer ${KEY}`)).status).toBe(401);
  });

  it('is cached for a minute and rate limited', async () => {
    await start({ hqApiKey: KEY, hqLimiter: createRateLimiter({ windowMs: 60000, max: 2 }) });
    const a = await (await get('/api/hq/summary', `Bearer ${KEY}`)).json();
    await store.addSubscriber({ email: 'second@example.com', source: 'test' });
    const b = await (await get('/api/hq/summary', `Bearer ${KEY}`)).json();
    expect(b).toEqual(a);   // the cached copy, not a second database read
    expect((await get('/api/hq/summary', `Bearer ${KEY}`)).status).toBe(429);
  });
});


describe('a town whose database is down', () => {
  const down = () => { throw Object.assign(new Error('database unavailable (circuit open)'), { code: 'CIRCUIT_OPEN' }); };
  const deadStore = {
    listSubscriberStats: down, listAdSpend: down, listNewsletterSends: down, countEmailOpens: down, listTraffic: down
  };
  const build = (store, health) => buildSummary({
    store, nowFn: () => NOW, town: VICTORIA, siteUrl: 'https://www.thevic361.com', commit: 'abc1234',
    getEvents: async () => [], getOrders: async () => down(), setup: async () => ({ checks: [], status: {} }), health
  });

  it('reports the failed parts as null and named, never as zeros', async () => {
    const body = await build(deadStore, async () => ({ database: false, database_configured: true, scheduler_blocked: false, slack_refused: false }));
    expect(body.ok).toBe(true);
    expect(body.failed).toEqual(['subscribers', 'revenue', 'ads', 'issues', 'database']);
    expect(body).toMatchObject({ subscribers: null, revenue: null, sponsors: null, issues: null, ads: null });
    expect(body.health).toEqual({ database: false, scheduler_blocked: false, slack_refused: false });   // no internal flag
  });

  it('a healthy summary carries no failed list (same shape as before)', async () => {
    const store = new FileStore(path.join(os.tmpdir(), `vic361-hq-${process.pid}-${Date.now()}.json`));
    const body = await buildSummary({ store, nowFn: () => NOW, town: VICTORIA, siteUrl: 'https://www.thevic361.com',
      getEvents: async () => [], getOrders: async () => [], setup: async () => ({ checks: [], status: {} }),
      health: async () => ({ database: true, database_configured: true, scheduler_blocked: false, slack_refused: false }) });
    expect(body).not.toHaveProperty('failed');
    expect(body.health).toEqual({ database: true, scheduler_blocked: false, slack_refused: false });
    expect(body.subscribers.active).toBe(0);
    expect(body).not.toHaveProperty('newsletter_runs');
  });

  it("carries each issue's latest slot: sent, or why not", async () => {
    const store = new FileStore(path.join(os.tmpdir(), `vic361-hq-${process.pid}-${Date.now()}-r.json`));
    const weekly = { job: 'newsletter', slot: '2026-10-05', ran: true, outcome: 'no-subscribers', detail: 'no-subscribers' };
    const body = await buildSummary({ store, nowFn: () => NOW, town: VICTORIA, siteUrl: 'https://www.thevic361.com',
      getEvents: async () => [], getOrders: async () => [], setup: async () => ({ checks: [], status: {} }), health: async () => null,
      getNewsletterRuns: async () => ({ weekly, weekend: null }) });
    expect(body.newsletter_runs).toEqual({ weekly, weekend: null });
  });

  it('reads issue dates the way Postgres returns them (Date objects)', async () => {
    const store = new FileStore(path.join(os.tmpdir(), `vic361-hq-${process.pid}-${Date.now()}-d.json`));
    let since = null;
    store.listNewsletterSends = async () => [{ week_key: '2026-10-08', edition: 'weekend', sent_at: new Date('2026-10-09T13:00:00Z'), recipients: 200, failed: 0 }];
    // Postgres rejects anything but a date here ("Fri Oct 09" was the bug).
    store.listTraffic = async (day) => { since = day; if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`invalid input syntax for type date: "${day}"`); return []; };
    const body = await buildSummary({ store, nowFn: () => NOW, town: VICTORIA, siteUrl: 'https://www.thevic361.com',
      getEvents: async () => [], getOrders: async () => [], setup: async () => ({ checks: [], status: {} }), health: async () => null });
    expect(body).not.toHaveProperty('failed');
    expect(since).toBe('2026-10-09');
    expect(body.issues).toHaveLength(1);
  });

  it("caches a failed summary for seconds, not a minute", async () => {
    let t = NOW.getTime(), calls = 0, fail = true;
    const routes = {};
    const app = { get: (p, fn) => { routes[p] = fn; } };
    registerHq(app, { key: KEY, limiter: createRateLimiter({ windowMs: 60000, max: 100 }), nowFn: () => new Date(t),
      build: async () => { calls++; return fail ? { ok: true, failed: ['subscribers'] } : { ok: true }; } });
    const call = () => new Promise(resolve => {
      const res = { set() { return res; }, status() { return res; }, json: b => resolve(b) };
      routes['/api/hq/summary']({ get: () => `Bearer ${KEY}`, ip: '1.2.3.4' }, res, () => resolve('next'));
    });
    await call(); await call();
    expect(calls).toBe(1);            // a burst of HQ loads still reads once
    t += 6000; fail = false;
    expect(await call()).toEqual({ ok: true });
    expect(calls).toBe(2);            // the town is back within seconds
    t += 30000;
    await call();
    expect(calls).toBe(2);            // a healthy summary keeps its minute
  });

  it('health.database is a live ping, not just "Postgres is configured"', async () => {
    let up = false;
    const pool = { query: async () => { if (!up) throw new Error('connect ECONNREFUSED'); return { rows: [] }; } };
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-hq-'));
    const eventsFile = path.join(tmpDir, 'events.json');
    await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
    store = new FileStore(path.join(tmpDir, 's.json'));
    const { app } = await createApp({ storeBundle: { kind: 'postgres', store, pool }, eventsFile, trustProxy: false, now: () => NOW,
      siteUrl: 'https://www.thevic361.com', adminUsername: 'a', adminPassword: 'b', adminSessionSecret: 'c', hqApiKey: KEY,
      hqLimiter: createRateLimiter({ windowMs: 60000, max: 100 }) });
    server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    base = `http://127.0.0.1:${server.address().port}`;
    const body = await (await get('/api/hq/summary', `Bearer ${KEY}`)).json();
    expect(body.health.database).toBe(false);
    expect(body.failed).toContain('database');
  });
});

describe('/api/hq/subscribers and /api/hq/hype (HQ\'s combined subscriber ping)', () => {
  const confirm = async (email, at) => {
    const sub = await store.addSubscriber({ email, source: 'web' });
    await store.confirmSubscriber(sub.token);
    if (at) {   // pin the time (FileStore keeps it in its JSON file)
      const data = await store._read();
      data.subscribers.find(x => x.email === email).confirmed_at = at;
      await store._write(data);
    }
  };

  it('starts from now: no after gives just the newest time; after gives the newer ones, oldest first', async () => {
    await start({ hqApiKey: KEY });
    expect((await get('/api/hq/subscribers')).status).toBe(401);
    await confirm('a@example.com', '2026-10-09T10:00:00.000Z');
    await confirm('b@example.com', '2026-10-09T11:00:00.000Z');
    await store.importSubscribers(['imported@example.com'], 'import');   // a list import isn't a signup
    const first = await (await get('/api/hq/subscribers', `Bearer ${KEY}`)).json();
    expect(first).toMatchObject({ ok: true, name: 'The Vic 361', latest: '2026-10-09T11:00:00.000Z', subscribers: [] });
    expect(first.total).toBe(3);   // every active subscriber, imports too
    await confirm('c@example.com', '2026-10-09T12:00:00.000Z');
    const next = await (await get(`/api/hq/subscribers?after=${first.latest}`, `Bearer ${KEY}`)).json();
    expect(next.subscribers).toEqual([{ email: 'c@example.com', confirmed_at: '2026-10-09T12:00:00.000Z' }]);
    expect(next.latest).toBe('2026-10-09T12:00:00.000Z');
    const older = await (await get('/api/hq/subscribers?after=2026-10-09T09:00:00.000Z', `Bearer ${KEY}`)).json();
    expect(older.subscribers.map(s => s.email)).toEqual(['a@example.com', 'b@example.com', 'c@example.com']);
    expect((await get('/api/hq/subscribers?after=yesterday', `Bearer ${KEY}`)).status).toBe(400);
  });

  it('posts HQ\'s batch to #hype, laid out and escaped by the town, with no town tag', async () => {
    const posts = [];
    await start({ hqApiKey: KEY, slack: { enabled: true, notify: async () => true, alert: async () => true,
      post: async (text, blocks, channel) => { posts.push({ text, blocks, channel }); return true; } } });
    const send = body => fetch(base + '/api/hq/hype', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await fetch(base + '/api/hq/hype', { method: 'POST' })).status).toBe(401);
    expect((await send({ count: 10, groups: [] })).status).toBe(400);
    const r = await send({ count: 10, all_total: 3148, groups: [
      { name: 'The Star 402', total: 412, emails: ['maria.k@gmail.com', 'jdoyle@yahoo.com'] },
      { name: 'The Vic 361', total: 1847, emails: ['<@channel>@x.example'] }] });
    expect(r.status).toBe(200);
    expect(posts).toHaveLength(1);
    const [{ text, blocks, channel }] = posts;
    expect(channel).toBe('hype');
    expect(text).toBe('📬 10 new subscribers');
    expect(blocks[0]).toEqual({ type: 'header', text: { type: 'plain_text', text: '📬 10 new subscribers' } });
    // One bullet per newsletter; the emails stay in HQ, not Slack.
    expect(blocks[1].text.text).toBe('• *The Star 402* +2 · 412 total\n• *The Vic 361* +1 · 1,847 total');
    expect(JSON.stringify(blocks)).not.toMatch(/maria|@channel/);
    expect(blocks[3].elements[0].text).toBe('All newsletters: 3,148 subscribers');
  });

  it("posts HQ's own alert to #alerts: one short line, escaped, no town tag; 502 when Slack doesn't take it", async () => {
    const posts = [];
    let up = true;
    await start({ hqApiKey: KEY, slack: { enabled: true, notify: async () => true, alert: async () => true,
      post: async (text, blocks, channel) => { posts.push({ text, blocks, channel }); return up; } } });
    const send = body => fetch(base + '/api/hq/alert', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await fetch(base + '/api/hq/alert', { method: 'POST' })).status).toBe(401);
    expect((await send({ text: 'x' })).status).toBe(400);
    const r = await send({ title: "Can't reach The Star 402: timed out", text: 'The site may be down <!channel>.\nCheck Railway.', link: 'https://hq.tristenpalori.com/' });
    expect(r.status).toBe(200);
    expect(posts).toEqual([{ channel: 'alerts', blocks: null,
      text: "*[HQ]* Can't reach The Star 402: timed out\nThe site may be down &lt;!channel&gt;. (more in HQ)\n<https://hq.tristenpalori.com/|Open HQ>" }]);
    up = false;
    expect((await send({ title: 'x', link: 'javascript:alert(1)' })).status).toBe(502);
    expect(posts[1].text).toBe('*[HQ]* x');
  });
});

const PG = process.env.TEST_DATABASE_URL;
describe.skipIf(!PG)('listConfirmedSince on Postgres (TEST_DATABASE_URL)', () => {
  it('same answers as the file store, and the last one at microseconds never comes back twice', async () => {
    const { default: pg } = await import('pg');
    const { createStore } = await import('../server/db.js');
    const admin = new pg.Client({ connectionString: PG });
    await admin.connect();
    const dbName = `hq_subs_${process.pid}_${Date.now()}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(PG);
    url.pathname = `/${dbName}`;
    url.searchParams.set('sslmode', 'disable');
    const bundle = await createStore({ databaseUrl: url.toString() });
    try {
      const s = bundle.store;
      expect(await s.listConfirmedSince(null)).toEqual({ latest: null, subscribers: [] });
      for (const e of ['a@example.com', 'b@example.com']) await s.confirmSubscriber((await s.addSubscriber({ email: e, source: 'web' })).token);
      await s.importSubscribers(['imported@example.com'], 'import');
      await bundle.pool.query("UPDATE subscribers SET confirmed_at = '2026-10-09T10:00:00.123456Z' WHERE email = 'a@example.com'");
      await bundle.pool.query("UPDATE subscribers SET confirmed_at = '2026-10-09T11:00:00.654321Z' WHERE email = 'b@example.com'");
      const first = await s.listConfirmedSince(null);
      expect(first).toEqual({ latest: '2026-10-09T11:00:00.654Z', subscribers: [] });
      expect(await s.listConfirmedSince(first.latest)).toEqual({ latest: first.latest, subscribers: [] });
      expect((await s.listConfirmedSince('2026-10-09T10:00:00.123Z')).subscribers)
        .toEqual([{ email: 'b@example.com', confirmed_at: '2026-10-09T11:00:00.654Z' }]);
      expect((await s.listConfirmedSince('2026-10-09T00:00:00.000Z', 1)).subscribers.map(x => x.email)).toEqual(['a@example.com']);
    } finally {
      await bundle.pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
      await admin.end();
    }
  });
});

describe.skipIf(!PG)('ad spend on Postgres (TEST_DATABASE_URL)', () => {
  it('keeps restatements and adds up every day, like the file store', async () => {
    const { default: pg } = await import('pg');
    const { createStore } = await import('../server/db.js');
    const admin = new pg.Client({ connectionString: PG });
    await admin.connect();
    const dbName = `hq_ads_${process.pid}_${Date.now()}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(PG);
    url.pathname = `/${dbName}`;
    url.searchParams.set('sslmode', 'disable');
    const bundle = await createStore({ databaseUrl: url.toString() });
    try {
      const s = bundle.store;
      const day = (d, spend) => ({ day: d, spend, impressions: 1, clicks: 2, leads: 3 });
      expect(await s.sumAdSpend()).toEqual({ spend: 0, days: 0, first_spend_day: null, last_spend_day: null });
      await s.saveAdSpend([day('2026-09-30', 0), day('2026-10-01', 40), day('2026-10-08', 50)], { today: '2026-10-09' });
      await s.saveAdSpend([day('2026-10-01', 46.5), day('2026-10-08', 60)], { today: '2026-10-09' });
      await s.saveAdSpend([day('2026-10-01', 46.6)], { today: '2026-10-09' });
      const rows = await s.listAdSpend('2026-09-01');
      expect(rows.map(r => [r.day, r.spend, r.restated_from])).toEqual([['2026-09-30', 0, null], ['2026-10-01', 46.6, 40], ['2026-10-08', 60, null]]);
      expect(rows[1].restated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(rows[2].restated_at).toBeNull();
      expect(await s.sumAdSpend()).toEqual({ spend: 106.6, days: 3, first_spend_day: '2026-10-01', last_spend_day: '2026-10-08' });
    } finally {
      await bundle.pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
      await admin.end();
    }
  });
});

describe('the summary for HQ: Meta detail, campaigns and dormant', () => {
  it('lists past days Meta restated, and the campaigns no town claims', async () => {
    await start({ hqApiKey: KEY });
    const day = (d, spend) => ({ day: d, spend, impressions: 0, clicks: 0, leads: 0 });
    await store.saveAdSpend([day('2026-10-01', 40), day('2026-10-08', 50)], { today: '2026-10-09' });
    // Recent days move freely (Meta settles them over ~3 days); an older one
    // moving more than $1 is a restatement, and a cent isn't.
    await store.saveAdSpend([day('2026-10-01', 46.5), day('2026-10-02', 0), day('2026-10-08', 60)], { today: '2026-10-09' });
    await store.saveAdSpend([day('2026-10-01', 46.6)], { today: '2026-10-09' });
    await store.setTownFile('ad_campaigns', { campaigns: [], unclaimed: [{ name: 'Rogue 541 Boost', daily_budget: 25 }], limit: 50 }, NOW);
    const s = await (await get('/api/hq/summary', `Bearer ${KEY}`)).json();
    expect(s.ads.restated_30_days).toEqual([{ day: '2026-10-01', from: 40, to: 46.6, at: expect.any(String) }]);
    expect(s.ads.unclaimed_campaigns).toEqual([{ name: 'Rogue 541 Boost', daily_budget: 25 }]);
    expect(s.ads.budget_command_limit).toBe(50);
  });

  it('adds up Meta\'s days, carries the campaigns, and says dormant only when it is', async () => {
    await start({ hqApiKey: KEY });
    await store.saveAdSpend([{ day: '2026-10-08', spend: 10, impressions: 1000, clicks: 50, leads: 20 },
      { day: '2026-10-05', spend: 5, impressions: 400, clicks: 10, leads: 5 }, { day: '2026-09-01', spend: 99, impressions: 1, clicks: 1, leads: 1 }]);
    await store.setTownFile('ad_campaigns', { campaigns: [{ name: 'Vic Newsletter Leads', status: 'ACTIVE', daily_budget: 68 }] }, new Date('2026-10-09T13:37:00Z'));
    const s = await (await get('/api/hq/summary', `Bearer ${KEY}`)).json();
    expect(s.ads.meta_7_days).toEqual({ spend: 15, impressions: 1400, clicks: 60, leads: 25, cost_per_lead: 0.6 });
    expect(s.ads.meta_30_days.spend).toBe(15);
    expect(s.ads.campaigns).toEqual([{ name: 'Vic Newsletter Leads', status: 'ACTIVE', daily_budget: 68 }]);
    expect(s.ads.campaigns_updated_at).toBe('2026-10-09T13:37:00.000Z');
    // A rolling window, named; the month's, last month's and all-time spend.
    expect(s.ads.spend_30_days_window).toEqual({ from: '2026-09-09', to: '2026-10-08' });
    expect(s.ads.spend_month_to_date).toBe(15);
    expect(s.ads.spend_last_month).toBe(99);
    expect(s.ads.spend_all_time).toBe(114);
    expect(s.ads.first_spend_day).toBe('2026-09-01');
    expect(s.ads.daily).toEqual([{ day: '2026-10-05', spend: 5, impressions: 400, clicks: 10, leads: 5 },
      { day: '2026-10-08', spend: 10, impressions: 1000, clicks: 50, leads: 20 }]);
    expect(s.ads.restated_30_days).toEqual([]);
    expect(s.ads.unclaimed_campaigns).toBeUndefined();
    expect(s.dormant).toBeUndefined();
  });
});

describe('the summary for HQ: what it needs to catch a lost or restored database', () => {
  it('the last issue\'s recipients next to active, how far back the database goes, and the bot check\'s day', async () => {
    await start({ hqApiKey: KEY });
    await store.recordNewsletterSend({ week_key: '2026-10-05', subject: 's', recipients: 250, failed: 0, failed_emails: [] });
    const body = await (await get('/api/hq/summary', `Bearer ${KEY}`)).json();
    expect(body.subscribers.last_send_recipients).toBe(250);
    expect(body.database).toMatchObject({ issues_sent: 1 });
    expect(body.database.first_subscriber_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(body.database.first_send_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(body.health.bot_check).toMatchObject({ forms: {} });
    expect(body.health).toHaveProperty('database_created');
  });
});

describe.skipIf(!PG)('databaseSpan on Postgres (TEST_DATABASE_URL)', () => {
  it('the oldest subscriber and issue, and how many issues', async () => {
    const { default: pg } = await import('pg');
    const { createStore } = await import('../server/db.js');
    const admin = new pg.Client({ connectionString: PG });
    await admin.connect();
    const dbName = `hq_span_${process.pid}_${Date.now()}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(PG);
    url.pathname = `/${dbName}`;
    url.searchParams.set('sslmode', 'disable');
    const bundle = await createStore({ databaseUrl: url.toString() });
    try {
      const s = bundle.store;
      expect(await s.databaseSpan()).toEqual({ first_subscriber_at: null, first_send_at: null, issues_sent: 0 });
      await s.addSubscriber({ email: 'a@example.com', source: 'web' });
      await s.recordNewsletterSend({ week_key: '2026-10-05', subject: 's', recipients: 1, failed: 0, failed_emails: [] });
      const span = await s.databaseSpan();
      expect(span.issues_sent).toBe(1);
      expect(span.first_subscriber_at).toMatch(/Z$/);
      expect(span.first_send_at).toMatch(/Z$/);
    } finally {
      await bundle.pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
      await admin.end();
    }
  });
});
