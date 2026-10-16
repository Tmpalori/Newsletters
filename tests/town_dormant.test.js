// @vitest-environment node
//
// A paused town (TOWN_DORMANT=1, server/town.js; Kearney and Tupelo): its
// site stays up with everything it has, but takes no signups, sells nothing
// on /advertise, sends nothing on a schedule and raises no alerts about
// collects it isn't running. Off, the same town works as before.

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { townConfig, townDormant, useTown, VICTORIA } from '../server/town.js';
import { createScheduler, DORMANT_JOBS } from '../server/scheduler.js';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';

const NOW = new Date('2026-10-07T17:00:00Z');
const BAY = { id: 'bay', siteName: 'The Bay 979', domain: 'thebay979.com', city: 'Bay City', state: 'TX', stateName: 'Texas', timezone: 'America/Chicago' };
const quiet = { warn() {}, log() {} };
const dirs = [];

function fakeSlack() {
  const alerts = [];
  return { alerts, enabled: true, notify: async () => true, alert: async (k, t, text) => { alerts.push({ k, t, text }); return true; } };
}

async function boot({ dormant }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-dormant-'));
  dirs.push(dir);
  const store = new FileStore(path.join(dir, 's.json'));
  // Collected before the pause, then nothing: what Kearney and Tupelo look like.
  await store.setPublished({ events: [], auto_publish: { from: '2026-09-27T20:30:00Z' } });
  const eventsFile = path.join(dir, 'events.json');
  await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
  process.env.TOWN_WORKFLOWS = '1';
  const slack = fakeSlack();
  const out = await createApp({
    storeBundle: { kind: 'file', store }, eventsFile, candidatesFile: path.join(dir, 'missing-candidates.json'),
    town: { ...BAY, dormant }, trustProxy: false, slack, now: () => NOW, startScheduler: false,
    siteUrl: 'https://www.thebay979.com', autoPublish: true, autoPublishDelayMs: 0,
    stripeSecretKey: 'sk_test_x', stripeWebhookSecret: 'whsec_x'
  });
  await new Promise(r => setTimeout(r, 50));
  await out.store.addSubscriber({ email: 'already@example.com', source: 'footer' });
  const server = http.createServer(out.app);
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { ...out, slack, base, close: () => new Promise(r => server.close(r)) };
}

afterEach(async () => {
  delete process.env.TOWN_WORKFLOWS;
  useTown(VICTORIA);
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('the switch', () => {
  it('TOWN_DORMANT=1 pauses a town (Victoria too); unset or 0 does not', () => {
    expect(townDormant({})).toBe(false);
    expect(townDormant({ TOWN_DORMANT: '0' })).toBe(false);
    expect(townDormant({ TOWN_DORMANT: '1' })).toBe(true);
    expect(townConfig({ TOWN: 'kearney', TOWN_DORMANT: '1' }).dormant).toBe(true);
    expect(townConfig({ TOWN: 'kearney' }).dormant).toBe(false);
    expect(townConfig({ TOWN_DORMANT: '1' }).dormant).toBe(true);
    // Unset, Victoria is exactly her frozen settings.
    expect(townConfig({})).toBe(VICTORIA);
  });
});

describe('the scheduler of a paused town', () => {
  async function run(dormant) {
    useTown(townConfig({}, { town: { ...BAY, dormant } }));
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-dormant-sched-'));
    dirs.push(dir);
    const ran = [];
    const handler = name => async () => { ran.push(name); return { ok: true }; };
    const s = createScheduler({
      store: new FileStore(path.join(dir, 's.json')), log: quiet,
      canQueue: () => true, queueJob: async job => { ran.push(job.name); },
      handlers: { newsletter: handler('newsletter'), newsletterWeekend: handler('newsletter-weekend'), sponsorReports: handler('sponsor-reports'),
        privacyPurge: handler('privacy-purge'), health: handler('health'), collected: async () => true }
    });
    // Monday, every minute from 3 AM to 10 PM Central: every daily and Monday job's slot.
    for (let t = Date.parse('2026-10-05T08:00:00Z'); t <= Date.parse('2026-10-06T03:00:00Z'); t += 60000) await s.tick(new Date(t));
    return new Set(ran);
  }

  it('runs only the privacy purge and the hourly check', async () => {
    expect([...(await run(true))].sort()).toEqual([...DORMANT_JOBS].sort());
  });

  it('runs everything again once the switch is off', async () => {
    const ran = await run(false);
    for (const name of ['newsletter', 'sponsor-reports', 'social-kit', 'event-check', 'submission-review', 'privacy-purge', 'health']) {
      expect(ran.has(name), name).toBe(true);
    }
  });
});

describe('a paused town’s site', () => {
  it('takes no signups, sells nothing, and stays quiet about collects', async () => {
    const t = await boot({ dormant: true });
    try {
      const sub = await fetch(t.base + '/api/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'new@example.com' }) });
      expect(sub.status).toBe(503);
      expect(await sub.json()).toMatchObject({ ok: false, error: 'dormant', message: expect.stringMatching(/taking a break/) });
      const c = await t.store.countSubscribers();
      expect(c.active + c.pending).toBe(1);   // the one already there stays, nobody new

      const page = await (await fetch(t.base + '/subscribe')).text();
      expect(page).toContain('newsletter is taking a break');
      expect(page).toContain('<meta name="robots" content="noindex">');
      expect(page).not.toContain('id="signup-form"');
      const home = await (await fetch(t.base + '/')).text();
      expect(home).not.toContain('id="signup-form"');
      expect(home).toContain('signup-paused');

      const ad = await (await fetch(t.base + '/advertise')).text();
      expect(ad).toContain('Advertising is on a break');
      expect(ad).toContain('<meta name="robots" content="noindex">');
      expect(ad).not.toMatch(/\$\d|ad-package|\/advertise\/checkout/);
      const co = await fetch(t.base + '/advertise/checkout?package=weekly', { redirect: 'manual' });
      expect(co.status).toBe(302);
      expect(co.headers.get('location')).toBe('/advertise');

      expect(await (await fetch(t.base + '/api/config')).json()).toMatchObject({ dormant: true });
      // Collected before the pause, workflows on: a running town would say "0
      // upcoming", "stale" and "missed collect", and alert on the missing candidates.
      const problems = (await t.healthCheck(NOW)).problems;
      for (const p of ['upcoming', 'stale', 'collect', 'jobs_worker']) expect(problems).not.toContain(p);
      expect(t.slack.alerts).toEqual([]);
    } finally { await t.close(); }
  });

  it('the same town with the switch off works as before', async () => {
    const t = await boot({ dormant: false });
    try {
      const sub = await fetch(t.base + '/api/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'new@example.com' }) });
      expect(sub.status).toBe(200);
      expect(await (await fetch(t.base + '/subscribe')).text()).toContain('id="signup-form"');
      const ad = await (await fetch(t.base + '/advertise')).text();
      expect(ad).toContain('/advertise/checkout?package=weekly');
      expect((await (await fetch(t.base + '/api/config')).json()).dormant).toBeUndefined();
      expect((await t.healthCheck(NOW)).problems).toEqual(expect.arrayContaining(['upcoming', 'stale']));
      expect(t.slack.alerts.map(a => a.k)).toContain('auto-publish');
    } finally { await t.close(); }
  });
});
