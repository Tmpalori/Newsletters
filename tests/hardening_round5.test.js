// @vitest-environment node
//
// Hardening round 5: auto-publish keeps an event the admin re-dated; the
// end time shows everywhere; a new empty production database and a wiped
// subscriber list alert; a checkout cancelled during the Stripe call isn't
// revived; an archived catalog price is looked up again; a failed archive
// read doesn't skip a pick report; a 409 idempotency conflict counts as
// sent; past event pages answer 503 during an outage; a midnight-crossing
// end on a DST night; published-payload writers don't undo each other.
// (Slow submissions: tests/submissions_api.test.js and submit_form.test.js.)

import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../server/index.js';
import { FileStore, PgStore, eventKeyOf } from '../server/db.js';
import { createAutoPublish, unpublishEvent } from '../server/autopublish.js';
import { withPages, eventJsonLd } from '../server/seo.js';
import { renderIcs, googleCalendarUrl } from '../server/guides.js';
import { createSponsors, createStripe } from '../server/sponsors.js';
import { createMailer } from '../server/notify.js';
import { createResend } from '../server/newsletter.js';
import { checkBotSignals } from '../server/validate.js';

const SITE = 'https://www.thevic361.com';
const NOW = new Date('2026-10-07T17:00:00Z');

let tmpDir = null;
let server = null;
async function tmp() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-r5-'));
  return tmpDir;
}
async function listen(app) {
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  return `http://127.0.0.1:${server.address().port}`;
}
afterEach(async () => {
  vi.restoreAllMocks();
  if (server) await new Promise(r => server.close(r));
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  server = null; tmpDir = null;
});
const recordingSlack = () => {
  const alerts = [];
  return { alerts, enabled: true, notify: async () => true, alert: async (key, title, text) => { alerts.push({ key, title, text }); } };
};
async function waitFor(fn, ms = 2000) {
  for (let t = 0; t < ms; t += 20) {
    const v = await fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, 20));
  }
  return fn();
}

describe('auto-publish and the edits overlay', () => {
  const FEST = { date: '2026-10-02', name: 'Riverside Fall Fest', venue: 'Riverside Park', time: '10:00 AM' };
  const OTHER = { date: '2026-10-20', name: 'Other', venue: 'Somewhere', time: '7:00 PM' };

  async function setup() {
    const dir = await tmp();
    const store = new FileStore(path.join(dir, 's.json'));
    await store.setPublished({ last_updated: 'x', events: [FEST, OTHER],
      auto_publish: { from: 'old', rules: 6, keys: [eventKeyOf(FEST), eventKeyOf(OTHER)] } });
    // Rained out: the admin moved it to Oct 20 in the edit modal and didn't Save & Publish.
    await store.upsertEventEdit({ original_key: eventKeyOf(FEST), payload: { ...FEST, date: '2026-10-20' } });
    const candidatesFile = path.join(dir, 'c.json');
    await fs.writeFile(candidatesFile, JSON.stringify({ last_updated: 'new', events: [OTHER] }));
    const ap = createAutoPublish({ store, candidatesFile, readJsonFile: async f => JSON.parse(await fs.readFile(f, 'utf8')),
      siteUrl: SITE, slack: null, archiveEvents: () => {}, nowFn: () => NOW });
    return { store, ap };
  }

  it('keeps a published event the admin re-dated to later, past its stored date', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { store, ap } = await setup();
    await ap.run();
    expect((await store.getPublished()).events.map(eventKeyOf)).toContain(eventKeyOf(FEST));
    await ap.run({ force: true, quiet: true, submissionsOnly: true });
    expect((await store.getPublished()).events.map(eventKeyOf)).toContain(eventKeyOf(FEST));
  });

  it('keeps it too when the edits can’t be read', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { store, ap } = await setup();
    store.listEventEdits = async () => { throw new Error('db down'); };
    await ap.run();
    expect((await store.getPublished()).events.map(eventKeyOf)).toContain(eventKeyOf(FEST));
  });

  it('still drops a past event nobody moved (from before this week)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { store, ap } = await setup();
    await store.deleteEventEdit?.(eventKeyOf(FEST));
    store.listEventEdits = async () => [];
    await ap.run();
    expect((await store.getPublished()).events.map(eventKeyOf)).not.toContain(eventKeyOf(FEST));
  });
});

describe('slow submissions', () => {
  it('only too-fast and the honeypot count as a bot, however long the form was open', () => {
    expect(checkBotSignals({ elapsed_ms: 3 * 24 * 3600 * 1000 })).toEqual({ ok: true });
    expect(checkBotSignals({ elapsed_ms: 200 }).reason).toBe('too-fast');
    expect(checkBotSignals({ company: 'x', elapsed_ms: 5000 }).reason).toBe('honeypot');
  });
});

describe('end_time is shown', () => {
  const ev = withPages([{ date: '2026-10-09', name: 'Gala', venue: 'Hall', time: '7:00 PM', end_time: '11:30 PM' }])[0];

  it('as a time range on pages and lists, keeping the page path', () => {
    expect(ev.time).toBe('7:00 PM – 11:30 PM');
    expect(ev.page).toBe(withPages([{ date: '2026-10-09', name: 'Gala', venue: 'Hall', time: '7:00 PM' }])[0].page);
    // A time that's already a range keeps its own end.
    expect(withPages([{ date: '2026-10-09', name: 'G', time: '7-9 PM', end_time: '11:30 PM' }])[0].time).toBe('7-9 PM');
    expect(withPages([{ date: '2026-10-09', name: 'G', time: '7:00 PM', end_time: '' }])[0].time).toBe('7:00 PM');
  });

  it('in JSON-LD endDate, .ics DTEND and Google Calendar', () => {
    expect(eventJsonLd(ev, SITE).endDate).toBe('2026-10-09T23:30:00-05:00');
    expect(renderIcs(ev, { siteUrl: SITE, now: NOW })).toContain('DTEND:20261010T043000Z');
    expect(new URL(googleCalendarUrl(ev, SITE)).searchParams.get('dates')).toBe('20261010T000000Z/20261010T043000Z');
  });
});

describe('a midnight-crossing end on a DST night', () => {
  it('uses the end day’s offset in .ics and Google Calendar, like JSON-LD', () => {
    const ev = withPages([{ date: '2026-10-31', name: 'Halloween Party', venue: 'Bar', time: '9:00 PM – 2:00 AM' }])[0];
    expect(eventJsonLd(ev, SITE).endDate).toBe('2026-11-01T02:00:00-06:00');
    expect(renderIcs(ev, { siteUrl: SITE, now: NOW })).toContain('DTEND:20261101T080000Z');
    expect(new URL(googleCalendarUrl(ev, SITE)).searchParams.get('dates')).toBe('20261101T020000Z/20261101T080000Z');
  });
});

describe('database backups: a new empty database and a wiped list alert', () => {
  function fakePool(tables) {
    return { query: async (text) => {
      if (/information_schema\.tables/.test(text)) return { rows: tables.map(table_name => ({ table_name })) };
      return { rows: [] };
    } };
  }

  it('ready() reports creating the subscribers and sponsor_orders tables, and only those', async () => {
    const created = [];
    await new PgStore(fakePool([]), { onTablesCreated: t => created.push(t) }).ready();
    expect(created).toEqual([['subscribers', 'sponsor_orders']]);
    const again = [];
    await new PgStore(fakePool(['subscribers', 'sponsor_orders']), { onTablesCreated: t => again.push(t) }).ready();
    expect(again).toEqual([]);
  });

  it('production alerts Slack (db-fresh); a PR environment does not', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const dir = await tmp();
    const eventsFile = path.join(dir, 'events.json');
    await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
    for (const [env, expected] of [['production', 1], ['pr-12', 0]]) {
      const slack = recordingSlack();
      const store = new PgStore(fakePool([]));
      await createApp({ storeBundle: { kind: 'postgres', store }, eventsFile, trustProxy: false, slack,
        railwayEnvironment: env, autoPublish: false, startScheduler: false });
      await store.ready();
      expect(slack.alerts.filter(a => a.key === 'db-fresh'), env).toHaveLength(expected);
    }
  });

  it('the hourly check alerts when active subscribers drop to 0 after an issue went out', async () => {
    const dir = await tmp();
    const eventsFile = path.join(dir, 'events.json');
    await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
    const store = new FileStore(path.join(dir, 's.json'));
    const slack = recordingSlack();
    const { healthCheck } = await createApp({ storeBundle: { kind: 'file', store }, eventsFile, trustProxy: false, slack,
      autoPublish: false, startScheduler: false, now: () => NOW });
    await store.recordNewsletterSend({ week_key: '2026-10-05', subject: 's', recipients: 250, failed: 0, failed_emails: [] });
    expect((await healthCheck(NOW)).problems).toContain('subscribers');
    expect(slack.alerts.some(a => /0 active subscribers/.test(a.text))).toBe(true);
    await store.importSubscribers(['a@example.com'], 'test');
    expect((await healthCheck(new Date(NOW.getTime() + 3600000))).problems).not.toContain('subscribers');
  });
});

describe('sponsor checkout', () => {
  const weekly = email => ({ package: 'weekly', week: '2026-10-19', business: 'W', text: 'x', url: 'w.example', email });

  async function start(stripe) {
    const dir = await tmp();
    const eventsFile = path.join(dir, 'events.json');
    await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
    const store = new FileStore(path.join(dir, 's.json'));
    const { app } = await createApp({
      storeBundle: { kind: 'file', store }, eventsFile, trustProxy: false, now: () => NOW, siteUrl: SITE,
      adminUsername: 'a', adminPassword: 'b', adminSessionSecret: 'c', autoPublish: false, startScheduler: false,
      stripeSecretKey: 'sk_test', stripeWebhookSecret: 'whsec', stripe, resendApiKey: '', slack: recordingSlack()
    });
    const base = await listen(app);
    const form = fields => fetch(base + '/advertise/checkout', {
      method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ agree: '1', ...fields }).toString()
    });
    return { store, form };
  }

  it('a hold cancelled by a second submit during the Stripe call stays cancelled; its session is expired', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let release;
    const gate = new Promise(r => { release = r; });
    const sessions = [];
    const expired = [];
    const { store, form } = await start({
      createCheckoutSession: async params => {
        const id = `cs_${sessions.length + 1}`;
        sessions.push({ id, params });
        if (id === 'cs_1') await gate;
        return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
      },
      expireCheckoutSession: async id => { expired.push(id); return { id }; }
    });
    const first = form(weekly('w@x.example'));
    await waitFor(() => sessions.length === 1);
    expect((await form(weekly('w@x.example'))).status).toBe(303); // the other tab
    release();
    expect((await first).status).toBe(409);
    const orders = await store.listSponsorOrders();
    const a = orders.find(o => o.id === sessions[0].params.client_reference_id);
    const b = orders.find(o => o.id === sessions[1].params.client_reference_id);
    expect(a.status).toBe('cancelled');
    expect(a.session_id).toBeUndefined();
    expect(b).toMatchObject({ status: 'pending', session_id: 'cs_2' });
    expect(expired).toContain('cs_1');
  });

  it('an archived catalog price is forgotten and looked up again once', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sessions = [];
    let current = 'price_old';
    const stripe = {
      ensurePrice: async () => current,
      forgetPrice: () => { current = 'price_new'; },
      createCheckoutSession: async (params, key) => {
        sessions.push({ params, key });
        if (params.line_items[0].price === 'price_old') {
          throw Object.assign(new Error('The price specified is inactive. This field only accepts prices that are active.'), { status: 400 });
        }
        return { id: `cs_${sessions.length}`, url: 'https://checkout.stripe.com/c/pay/x' };
      }
    };
    const { form } = await start(stripe);
    expect((await form(weekly('w@x.example'))).status).toBe(303);
    expect(sessions.map(s => s.params.line_items[0].price)).toEqual(['price_old', 'price_new']);
    expect(sessions[1].key).not.toBe(sessions[0].key);
  });

  it('falls back to inline pricing when the lookup gives the same dead price', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sessions = [];
    const { form } = await start({
      ensurePrice: async () => 'price_old',
      forgetPrice: () => {},
      createCheckoutSession: async params => {
        sessions.push(params);
        if (params.line_items[0].price) throw Object.assign(new Error('The price specified is inactive.'), { status: 400 });
        return { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/x' };
      }
    });
    expect((await form(weekly('w@x.example'))).status).toBe(303);
    expect(sessions[1].line_items[0].price_data.unit_amount).toBe(14900);
  });

  it('the Stripe client forgets a cached price on request', async () => {
    let gets = 0;
    const fetchImpl = async (url) => {
      if (url.includes('/prices?')) gets++;
      return { ok: true, status: 200, json: async () => (url.includes('/prices?') ? { data: [{ id: `price_${gets}` }] } : {}) };
    };
    const client = createStripe('rk_test_x', fetchImpl);
    const pkg = { key: 'weekly', name: 'Weekly sponsor', amount: 30000 };
    expect(await client.ensurePrice(pkg)).toBe('price_1');
    expect(await client.ensurePrice(pkg)).toBe('price_1');
    client.forgetPrice(pkg);
    expect(await client.ensurePrice(pkg)).toBe('price_2');
  });
});

describe('Vic’s Pick report when the archive read fails', () => {
  it('is retried next run instead of recorded as never live', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = await tmp();
    const store = new FileStore(path.join(dir, 's.json'));
    const order = { id: 'f1a2b3c4-0000-4000-8000-000000000001', kind: 'featured', status: 'paid', amount: 8900,
      created_at: '2026-10-01T15:00:00Z', paid_at: '2026-10-01T15:05:00Z', business: 'Fall Fest Co', email: 'fest@example.com',
      event: { date: '2026-10-10', name: 'Fall Festival', venue: 'De Leon Plaza', time: '10:00 AM' } };
    await store.saveSponsorOrder(order);
    const slack = recordingSlack();
    const real = store.listArchivedEvents.bind(store);
    store.listArchivedEvents = async () => { throw new Error('statement timeout'); };
    const sponsors = createSponsors({ store, siteUrl: SITE, nowFn: () => NOW, config: {}, stripe: {}, getVenues: () => [],
      slack, getPayload: async () => ({ events: [] }) });
    const now = new Date('2026-10-11T15:00:00Z');
    await sponsors.sendPickReports(now);
    let saved = (await store.listSponsorOrders())[0];
    expect(saved.report_skipped).toBeFalsy();
    expect(slack.alerts).toEqual([]);
    // Both reads work and it really isn't there: recorded once, as before.
    store.listArchivedEvents = real;
    await sponsors.sendPickReports(now);
    saved = (await store.listSponsorOrders())[0];
    expect(saved.report_skipped).toBeTruthy();
  });
});

describe('customer email idempotency conflict', () => {
  const mail = { subject: 'You’re live', html: '<p>x</p>', text: 'x' };
  const mailerThrowing = err => createMailer({ resend: { send: async () => { throw err; } }, config: { enabled: true, from: 'a@b.c' } });

  it('a 409 for a key Resend already used counts as sent; a concurrent request retries', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const used = Object.assign(new Error('Resend /emails HTTP 409'), { status: 409, code: 'invalid_idempotent_request' });
    expect(await mailerThrowing(used).deliver('x@example.com', mail, 'vic361-live-1')).toBe('sent');
    const busy = Object.assign(new Error('Resend /emails HTTP 409'), { status: 409, code: 'concurrent_idempotent_requests' });
    expect(await mailerThrowing(busy).deliver('x@example.com', mail, 'vic361-live-1')).toBe('failed');
  });

  it('the Resend client passes the error name on', async () => {
    const resend = createResend('re_x', async () => ({ ok: false, status: 409,
      json: async () => ({ name: 'invalid_idempotent_request', message: 'Same key, different body' }) }));
    await expect(resend.send({}, 'k')).rejects.toMatchObject({ status: 409, code: 'invalid_idempotent_request' });
  });
});

describe('past event pages during a database outage', () => {
  it('answer 503 with Retry-After (page, .ics, .png), not a bare 500', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const dir = await tmp();
    const eventsFile = path.join(dir, 'events.json');
    await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
    const store = new FileStore(path.join(dir, 's.json'));
    store.getArchivedEvent = async () => { throw Object.assign(new Error('database unavailable (circuit open)'), { code: 'CIRCUIT_OPEN' }); };
    const { app } = await createApp({ storeBundle: { kind: 'file', store }, eventsFile, trustProxy: false, now: () => NOW,
      autoPublish: false, startScheduler: false, slack: recordingSlack() });
    const base = await listen(app);
    for (const suffix of ['', '.ics', '.png']) {
      const r = await fetch(`${base}/events/2026-09-01-old-show${suffix}`);
      expect(r.status, suffix).toBe(503);
      expect(r.headers.get('retry-after'), suffix).toBeTruthy();
      expect(r.headers.get('cache-control'), suffix).toBe('no-store');
    }
  });
});

describe('published-payload writers are serialized', () => {
  it('an unpublish and a submissions-only publish at once both land', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = await tmp();
    const store = new FileStore(path.join(dir, 's.json'));
    const GONE = { date: '2026-10-12', name: 'Rejected Thing', venue: 'V' };
    const KEEP = { date: '2026-10-13', name: 'Kept Thing', venue: 'V' };
    await store.setPublished({ last_updated: 'x', events: [GONE, KEEP], auto_publish: { from: 'c', rules: 6, keys: [] } });
    await store.insert({ id: 'sub1', created_at: NOW.toISOString(), status: 'approved', source: 'submission',
      payload: { date: '2026-10-14', name: 'Approved Show', venue: 'Hall', time: '7:00 PM' }, review_history: [] });
    // A slow database: each read takes a moment, so unserialized writers
    // both read the old payload and the second write undoes the first.
    const read = store.getPublished.bind(store);
    store.getPublished = async () => { const p = await read(); await new Promise(r => setTimeout(r, 30)); return p; };
    const ap = createAutoPublish({ store, candidatesFile: path.join(dir, 'none.json'), readJsonFile: async () => ({}),
      siteUrl: SITE, slack: null, archiveEvents: () => {}, nowFn: () => NOW });
    await Promise.all([
      ap.run({ force: true, quiet: true, submissionsOnly: true }),
      unpublishEvent(store, eventKeyOf(GONE), NOW)
    ]);
    const names = (await read()).events.map(e => e.name);
    expect(names).toContain('Approved Show');
    expect(names).not.toContain('Rejected Thing');
    expect(names).toContain('Kept Thing');
  });
});
