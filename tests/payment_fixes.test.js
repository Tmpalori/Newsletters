// @vitest-environment node
//
// Payment fixes in server/sponsors.js (the business-readiness review of
// payments): a paid session with no order alerts the owner, payment time is
// Stripe's event time (a late webhook doesn't make an on-time payment late
// or double-booked), test-mode payments aren't fulfilled on the live site,
// partial refunds and disputes are recorded as such, buyers hear about a
// failed bank debit or a double booking, and Stripe calls time out.
// Webhook events are fed to processEvent against a file store; nothing is
// charged or sent.

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { createSponsors, createStripe, stripeConfig } from '../server/sponsors.js';
import { monthRevenue } from '../server/growth.js';

const NOW = new Date('2026-10-07T15:00:00Z'); // Wed Oct 7
const sec = d => Math.floor(new Date(d).getTime() / 1000);
let tmpDir, server;

afterEach(async () => {
  if (server) await new Promise(r => server.close(r));
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  server = null; tmpDir = null;
});

async function newStore() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-payfix-'));
  return new FileStore(path.join(tmpDir, 's.json'));
}

const recorder = () => {
  const alerts = [], notes = [], sent = [];
  return {
    alerts, notes, sent,
    slack: { notify: n => notes.push(n), alert: (key, title, text) => alerts.push({ key, title, text }) },
    mailer: { enabled: true, send: async (to, mail, key) => { sent.push({ to, key, subject: mail.subject, text: mail.text }); return true; } }
  };
};

function setup(store, { now = () => NOW, rec = recorder(), config = {} } = {}) {
  const sp = createSponsors({
    store, siteUrl: 'https://www.thevic361.com', nowFn: now, getVenues: () => [],
    config: { enabled: true, webhookSecret: 'whsec', ...config }, stripe: {}, slack: rec.slack, mailer: rec.mailer, mailAddress: '1 Main St'
  });
  return { sp, ...rec };
}

const order = (extra = {}) => ({
  id: 'o1', kind: 'weekly', status: 'pending', email: 'a@acme.example', business: 'Acme', amount: 30000,
  created_at: NOW.toISOString(), session_id: 'cs_1', week_start: '2026-10-19',
  sponsor: { name: 'Acme', text: 'Tacos.', url: 'https://acme.example', cta: 'Order' }, ...extra
});
const pick = (extra = {}) => order({
  kind: 'featured', week_start: undefined, sponsor: undefined, amount: 8900,
  event: { date: '2026-10-10', name: 'Fall Fair', time: '9 AM', venue: 'Plaza', address: 'X', description: 'Fun.' }, ...extra
});
const ev = (type, o, extra = {}, top = {}) => ({ type, ...top, data: { object: { id: o.session_id, client_reference_id: o.id, ...extra } } });
const paidEvent = (o, top = {}, type = 'checkout.session.completed') =>
  ev(type, o, { payment_status: 'paid', amount_total: o.amount, payment_intent: `pi_${o.id}` }, top);
const byId = async (store, id) => (await store.listSponsorOrders()).find(o => o.id === id);

describe('M1: a paid session with no order alerts the owner', () => {
  const orphan = (metadata, extra = {}) => ({ type: 'checkout.session.completed', data: { object: {
    id: 'cs_gone', client_reference_id: 'gone', payment_status: 'paid', amount_total: 30000, payment_intent: 'pi_gone',
    customer_details: { email: 'lost@example.com' }, metadata, ...extra } } });

  it('our own paid session (order_id metadata) whose order is missing: a Slack alert, still handled', async () => {
    const store = await newStore();
    const { sp, alerts } = setup(store);
    await sp.processEvent(orphan({ order_id: 'gone', package: 'weekly' }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0].key).toBe('stripe-orphan:cs_gone');
    expect(alerts[0].text).toMatch(/lost@example\.com/);
    expect(alerts[0].text).toMatch(/\$300/);
    expect(alerts[0].text).toMatch(/pi_gone/);
    expect(await store.listSponsorOrders()).toEqual([]);
  });

  it('another town\'s tagged session, an unpaid one, or one without our metadata: silent', async () => {
    const store = await newStore();
    const { sp, alerts } = setup(store);
    await sp.processEvent(orphan({ order_id: 'gone', town: 'goliad' }));
    await sp.processEvent(orphan({ order_id: 'gone' }, { payment_status: 'unpaid' }));
    await sp.processEvent(orphan({}));
    await sp.processEvent(orphan(undefined));
    expect(alerts).toEqual([]);
  });
});

describe('M2: payment time is Stripe\'s, not when the webhook arrives', () => {
  it('a Vic\'s Pick paid at 11:58 PM on its day whose webhook lands after midnight is booked, not late', async () => {
    const store = await newStore();
    // Sat Oct 10, 11:50 PM Central; the webhook is handled at 12:05 AM.
    const created = '2026-10-11T04:50:00Z';
    const { sp, sent, alerts } = setup(store, { now: () => new Date('2026-10-11T05:05:00Z') });
    await store.saveSponsorOrder(pick({ created_at: created }));
    await sp.processEvent(paidEvent(pick(), { created: sec('2026-10-11T04:58:00Z') }));
    const o = await byId(store, 'o1');
    expect(o.status).toBe('paid');
    expect(o.paid_at).toBe('2026-10-11T04:58:00.000Z');
    expect(alerts.some(a => /late/.test(a.key))).toBe(false);
    expect(sent.some(m => /too late/.test(m.subject))).toBe(false);
  });

  it('without an event time (or one in the future) it falls back to now: a payment after the date is still late', async () => {
    const store = await newStore();
    const { sp } = setup(store, { now: () => new Date('2026-10-13T15:00:00Z') });
    await store.saveSponsorOrder(pick({ status: 'processing' }));
    await sp.processEvent(paidEvent(pick(), { created: sec('2026-10-20T00:00:00Z') }, 'checkout.session.async_payment_succeeded'));
    expect((await byId(store, 'o1')).status).toBe('late');
  });

  it('paid_at follows the event time, so revenue lands in the month it was paid', async () => {
    const store = await newStore();
    const { sp } = setup(store);
    await store.saveSponsorOrder(order({ created_at: '2026-10-01T04:50:00Z' }));
    // Sep 30, 11:55 PM Central.
    await sp.processEvent(paidEvent(order(), { created: sec('2026-10-01T04:55:00Z') }));
    const list = await store.listSponsorOrders();
    expect(monthRevenue(list, '2026-09-30').cents).toBe(30000);
    expect(monthRevenue(list, '2026-10-07').cents).toBe(0);
  });

  it('a week paid inside its hold keeps the slot when its webhook arrives after a later buyer\'s', async () => {
    const store = await newStore();
    const { sp, notes, sent } = setup(store, { now: () => new Date('2026-10-07T16:00:00Z') });
    // A: checkout at 15:00, paid 15:05; the database was down, so the event lands at 16:00.
    // B: booked at 15:40 (A's hold had lapsed in the database), paid and live.
    await store.saveSponsorOrder(order({ id: 'a', session_id: 'cs_a' }));
    await store.saveSponsorOrder(order({ id: 'b', session_id: 'cs_b', email: 'b@b.example', business: 'Bravo',
      status: 'paid', created_at: '2026-10-07T15:40:00Z', paid_at: '2026-10-07T15:41:00Z', confirmation_sent: '2026-10-07T15:41:00Z' }));
    await sp.processEvent(paidEvent(order({ id: 'a', session_id: 'cs_a' }), { created: sec('2026-10-07T15:05:00Z') }));
    expect((await byId(store, 'a')).status).toBe('paid');
    expect((await byId(store, 'b')).status).toBe('conflict');
    // Sales (move or refund), short; the orders are for HQ.
    const alert = notes.find(x => x.channel === 'sales' && /^⚠️/u.test(x.title));
    expect(alert.more).toContain('order a');
    expect(alert.more).toContain('order b');
    expect(sent.map(m => [m.to, m.key])).toContainEqual(['b@b.example', 'vic361-sponsor-conflict-b']);
    expect(sent.map(m => m.key)).toContain('vic361-sponsor-a');
  });

  it('a payment made after its hold lapsed is the double booking, as before', async () => {
    const store = await newStore();
    const { sp } = setup(store, { now: () => new Date('2026-10-07T16:00:00Z') });
    await store.saveSponsorOrder(order({ id: 'a', session_id: 'cs_a' }));
    await store.saveSponsorOrder(order({ id: 'b', session_id: 'cs_b', email: 'b@b.example', status: 'paid',
      created_at: '2026-10-07T15:40:00Z', paid_at: '2026-10-07T15:41:00Z' }));
    // 15:36: the 35-minute hold had run out.
    await sp.processEvent(paidEvent(order({ id: 'a', session_id: 'cs_a' }), { created: sec('2026-10-07T15:36:00Z') }));
    expect((await byId(store, 'a')).status).toBe('conflict');
    expect((await byId(store, 'b')).status).toBe('paid');
  });

  it('a week that has already started isn\'t taken from the sponsor running it', async () => {
    const store = await newStore();
    const { sp } = setup(store, { now: () => new Date('2026-10-20T16:00:00Z') });
    await store.saveSponsorOrder(order({ id: 'a', session_id: 'cs_a', created_at: '2026-10-07T15:00:00Z' }));
    await store.saveSponsorOrder(order({ id: 'b', session_id: 'cs_b', email: 'b@b.example', status: 'paid',
      created_at: '2026-10-07T15:40:00Z', paid_at: '2026-10-07T15:41:00Z' }));
    await sp.processEvent(paidEvent(order({ id: 'a', session_id: 'cs_a' }), { created: sec('2026-10-07T15:05:00Z') }));
    expect((await byId(store, 'a')).status).toBe('conflict');
    expect((await byId(store, 'b')).status).toBe('paid');
  });

  it('a bank debit finished inside its hold owns its week when it settles, even after a later buyer\'s', async () => {
    const store = await newStore();
    const { sp } = setup(store, { now: () => new Date('2026-10-12T16:00:00Z') });
    const a = order({ id: 'a', session_id: 'cs_a', week_start: '2026-10-26' });
    await store.saveSponsorOrder(a);
    // Its "completed" (unpaid) event is late too, but happened at 15:10.
    await sp.processEvent(ev('checkout.session.completed', a, { payment_status: 'unpaid' }, { created: sec('2026-10-07T15:10:00Z') }));
    expect((await byId(store, 'a')).processing_at).toBe('2026-10-07T15:10:00.000Z');
    await store.saveSponsorOrder(order({ id: 'b', session_id: 'cs_b', email: 'b@b.example', status: 'paid', week_start: '2026-10-26',
      created_at: '2026-10-07T15:50:00Z', paid_at: '2026-10-07T15:51:00Z' }));
    await sp.processEvent(paidEvent(a, { created: sec('2026-10-12T15:00:00Z') }, 'checkout.session.async_payment_succeeded'));
    expect((await byId(store, 'a')).status).toBe('paid');
    expect((await byId(store, 'b')).status).toBe('conflict');
  });

  it('a Vic\'s Pick paid inside its hold bumps the latest buyer off a day that filled while its webhook was late', async () => {
    const store = await newStore();
    const { sp } = setup(store, { now: () => new Date('2026-10-07T16:00:00Z') });
    await store.saveSponsorOrder(pick({ id: 'a', session_id: 'cs_a' }));
    // Saturday's 4 spots went to others after A's hold lapsed.
    for (let i = 1; i <= 4; i++) {
      await store.saveSponsorOrder(pick({ id: `p${i}`, session_id: `cs_p${i}`, email: `p${i}@x.example`, status: 'paid', submission_id: `s${i}`,
        created_at: `2026-10-07T15:4${i}:00Z`, paid_at: `2026-10-07T15:4${i}:30Z` }));
    }
    await sp.processEvent(paidEvent(pick({ id: 'a', session_id: 'cs_a' }), { created: sec('2026-10-07T15:05:00Z') }));
    expect((await byId(store, 'a')).status).toBe('paid');
    const statuses = Object.fromEntries((await store.listSponsorOrders()).map(o => [o.id, o.status]));
    expect(statuses).toMatchObject({ p1: 'paid', p2: 'paid', p3: 'paid', p4: 'conflict' });
  });
});

describe('M3: Stripe test mode on the live site', () => {
  it('in production with a live key, a test-mode payment isn\'t fulfilled: no submission, no email, an alert', async () => {
    const store = await newStore();
    const { sp, alerts, sent } = setup(store, { config: { production: true, liveKey: true } });
    await store.saveSponsorOrder(pick());
    await sp.processEvent({ ...paidEvent(pick()), livemode: false });
    const o = await byId(store, 'o1');
    expect(o).toMatchObject({ status: 'failed', test: true });
    expect(o.test_mode_refused).toBeTruthy();
    expect((await store.list({})).filter(r => r.source === 'paid-feature')).toHaveLength(0);
    expect(sent).toEqual([]);
    expect(alerts.map(a => a.key)).toEqual(['stripe-test-mode:o1']);
    // An unpaid (bank) test-mode completion doesn't hold the slot either.
    await store.saveSponsorOrder(order({ id: 'o2', session_id: 'cs_2' }));
    await sp.processEvent({ ...ev('checkout.session.completed', order({ id: 'o2', session_id: 'cs_2' }), { payment_status: 'unpaid' }), livemode: false });
    expect((await byId(store, 'o2')).status).toBe('failed');
  });

  it('a live-mode payment in production, and test mode anywhere else (or a launch test on a test key), still work', async () => {
    const store = await newStore();
    const live = setup(store, { config: { production: true, liveKey: true } });
    await store.saveSponsorOrder(order());
    await live.sp.processEvent({ ...paidEvent(order()), livemode: true });
    expect((await byId(store, 'o1')).status).toBe('paid');

    const testKey = setup(store, { config: { production: true, testKey: true } });
    await store.saveSponsorOrder(order({ id: 'o2', session_id: 'cs_2', week_start: '2026-10-26' }));
    await testKey.sp.processEvent({ ...paidEvent(order({ id: 'o2', session_id: 'cs_2', week_start: '2026-10-26' })), livemode: false });
    expect(await byId(store, 'o2')).toMatchObject({ status: 'paid', test: true });

    const dev = setup(store);
    await store.saveSponsorOrder(order({ id: 'o3', session_id: 'cs_3', week_start: '2026-11-02' }));
    await dev.sp.processEvent({ ...paidEvent(order({ id: 'o3', session_id: 'cs_3', week_start: '2026-11-02' })), livemode: false });
    expect(await byId(store, 'o3')).toMatchObject({ status: 'paid', test: true });
  });

  it('stripeConfig knows the key\'s mode and whether this is production', () => {
    expect(stripeConfig({ STRIPE_SECRET_KEY: 'rk_live_x', RAILWAY_ENVIRONMENT_NAME: 'production' })).toMatchObject({ liveKey: true, testKey: false, production: true });
    expect(stripeConfig({ STRIPE_SECRET_KEY: 'sk_test_x' }, { railwayEnvironment: 'staging' })).toMatchObject({ liveKey: false, testKey: true, production: false });
  });

  it('the Setup checklist warns about a test key only in production', async () => {
    const checks = async (extra) => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-payfix-'));
      const eventsFile = path.join(tmpDir, 'events.json');
      await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
      const { app } = await createApp({
        storeBundle: { kind: 'file', store: new FileStore(path.join(tmpDir, 's.json')) }, eventsFile, trustProxy: false, now: () => NOW,
        siteUrl: 'https://www.thevic361.com', adminUsername: 'a', adminPassword: 'b', adminSessionSecret: 'c',
        stripeWebhookSecret: 'whsec_x', stripe: {}, resendApiKey: '', ...extra
      });
      server = http.createServer(app);
      await new Promise(r => server.listen(0, r));
      const base = `http://127.0.0.1:${server.address().port}`;
      const login = await (await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'a', password: 'b' }) })).json();
      const r = await (await fetch(base + '/api/admin/setup', { headers: { Authorization: `Bearer ${login.token}` } })).json();
      await new Promise(res => server.close(res));
      server = null;
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      tmpDir = null;
      return Object.fromEntries(r.checks.map(c => [c.key, c]));
    };
    const prodTest = await checks({ stripeSecretKey: 'sk_test_abc', railwayEnvironment: 'production' });
    expect(prodTest.stripe_test_key.ok).toBe(false);
    expect(prodTest.stripe_test_key.fix).toMatch(/test key/);
    expect((await checks({ stripeSecretKey: 'rk_live_abc', railwayEnvironment: 'production' })).stripe_test_key).toBeUndefined();
    expect((await checks({ stripeSecretKey: 'sk_test_abc' })).stripe_test_key).toBeUndefined();
  });
});

describe('M4: partial refunds, disputes and partner charges', () => {
  const paid = (extra = {}) => order({ status: 'paid', paid_at: '2026-10-02T15:00:00Z', payment_intent: 'pi_1', ...extra });

  it('a partial refund keeps the placement and counts only what was kept; a full one takes it down', async () => {
    const store = await newStore();
    const { sp, notes } = setup(store);
    await store.saveSponsorOrder(paid());
    await sp.processEvent({ type: 'charge.refunded', data: { object: { payment_intent: 'pi_1', refunded: false, amount_refunded: 20000 } } });
    let o = await byId(store, 'o1');
    expect(o).toMatchObject({ status: 'paid', refunded_cents: 20000 });
    expect(monthRevenue([o], '2026-10-07').cents).toBe(10000);
    expect(notes.at(-1).title).toMatch(/partly refunded/);
    await sp.processEvent({ type: 'charge.refunded', data: { object: { payment_intent: 'pi_1', refunded: true, amount_refunded: 30000 } } });
    o = await byId(store, 'o1');
    expect(o.status).toBe('refunded');
    expect(monthRevenue([o], '2026-10-07').cents).toBe(0);
  });

  it('a dispute shows as disputed (off the site, out of revenue) and a won one is restored', async () => {
    const store = await newStore();
    const { sp, notes } = setup(store);
    await store.saveSponsorOrder(paid());
    await sp.processEvent({ type: 'charge.dispute.created', data: { object: { id: 'dp_1', payment_intent: 'pi_1', status: 'needs_response' } } });
    let o = await byId(store, 'o1');
    expect(o.status).toBe('disputed');
    expect(o.dispute).toMatchObject({ id: 'dp_1', status: 'open', prev_status: 'paid' });
    expect(monthRevenue([o], '2026-10-07').cents).toBe(0);
    await sp.processEvent({ type: 'charge.dispute.closed', data: { object: { id: 'dp_1', payment_intent: 'pi_1', status: 'won' } } });
    o = await byId(store, 'o1');
    expect(o.status).toBe('paid');
    expect(o.dispute.status).toBe('won');
    expect(monthRevenue([o], '2026-10-07').cents).toBe(30000);
    expect(notes.at(-1).title).toMatch(/dispute won/);
  });

  it('a lost dispute stays off the site; a won one whose week was resold meanwhile comes back hidden', async () => {
    const store = await newStore();
    const { sp } = setup(store);
    await store.saveSponsorOrder(paid());
    await sp.processEvent({ type: 'charge.dispute.created', data: { object: { id: 'dp_1', payment_intent: 'pi_1' } } });
    await sp.processEvent({ type: 'charge.dispute.closed', data: { object: { id: 'dp_1', payment_intent: 'pi_1', status: 'lost' } } });
    expect(await byId(store, 'o1')).toMatchObject({ status: 'disputed', dispute: { status: 'lost' } });

    await store.saveSponsorOrder(paid({ id: 'o2', payment_intent: 'pi_2', week_start: '2026-10-26' }));
    await sp.processEvent({ type: 'charge.dispute.created', data: { object: { id: 'dp_2', payment_intent: 'pi_2' } } });
    await store.saveSponsorOrder(paid({ id: 'o3', payment_intent: 'pi_3', week_start: '2026-10-26', email: 'c@c.example' }));
    await sp.processEvent({ type: 'charge.dispute.closed', data: { object: { id: 'dp_2', payment_intent: 'pi_2', status: 'won' } } });
    const o2 = await byId(store, 'o2');
    expect(o2).toMatchObject({ status: 'hidden', hidden_from: 'paid' });
    expect(monthRevenue([o2], '2026-10-07').cents).toBe(30000);
  });

  it('a venue partner\'s renewal is matched by its stored payment or its customer', async () => {
    const store = await newStore();
    const { sp } = setup(store);
    const partner = { id: 'vp', kind: 'partner', status: 'active', business: 'Aero', email: 'aero@example.com', amount: 15000,
      subscription_id: 'sub_1', customer_id: 'cus_1', payment_intent: null, venue_name: 'Aero', created_at: '2026-08-01T00:00:00Z', paid_at: '2026-08-01T00:00:00Z' };
    await store.saveSponsorOrder(partner);
    await sp.processEvent({ type: 'invoice.paid', data: { object: { id: 'in_2', parent: { subscription_details: { subscription: 'sub_1' } },
      payments: { data: [{ payment: { type: 'payment_intent', payment_intent: 'pi_renew' } }] } } } });
    expect(await byId(store, 'vp')).toMatchObject({ latest_invoice: 'in_2', payment_intent: 'pi_renew' });
    await sp.processEvent({ type: 'charge.dispute.created', data: { object: { id: 'dp_9', payment_intent: 'pi_renew' } } });
    expect((await byId(store, 'vp')).status).toBe('disputed');

    await store.saveSponsorOrder({ ...partner, id: 'vp2', subscription_id: 'sub_2', customer_id: 'cus_2' });
    await sp.processEvent({ type: 'charge.refunded', data: { object: { payment_intent: 'pi_older', customer: 'cus_2', refunded: true, amount_refunded: 15000 } } });
    expect((await byId(store, 'vp2')).status).toBe('refunded');
  });
});

describe('M5: a failed bank payment tells the buyer', () => {
  it('emails that it didn\'t go through, the slot is open again, with a link to book again', async () => {
    const store = await newStore();
    const { sp, sent } = setup(store);
    await store.saveSponsorOrder(order({ status: 'processing' }));
    await sp.processEvent(ev('checkout.session.async_payment_failed', order()));
    expect((await byId(store, 'o1')).status).toBe('failed');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'a@acme.example', key: 'vic361-sponsor-failed-o1' });
    expect(sent[0].subject).toMatch(/didn’t go through/);
    expect(sent[0].text).toContain('https://www.thevic361.com/advertise/checkout?package=weekly');
    // A replay sends nothing more.
    await sp.processEvent(ev('checkout.session.async_payment_failed', order()));
    expect(sent).toHaveLength(1);
  });

  it('never for a test-mode payment on the production site', async () => {
    const store = await newStore();
    const { sp, sent } = setup(store, { config: { production: true, testKey: true } });
    await store.saveSponsorOrder(pick({ status: 'processing' }));
    await sp.processEvent({ ...ev('checkout.session.async_payment_failed', pick()), livemode: false });
    expect((await byId(store, 'o1')).status).toBe('failed');
    expect(sent).toEqual([]);
  });
});

describe('L4: a double-booked buyer is emailed', () => {
  it('a second payment for a sold week gets the "we’ll refund or move you" email, no "you’re booked"', async () => {
    const store = await newStore();
    const { sp, sent } = setup(store);
    await store.saveSponsorOrder(order({ id: 'first', session_id: 'cs_f', status: 'paid', paid_at: '2026-10-06T00:00:00Z', confirmation_sent: 'x' }));
    await store.saveSponsorOrder(order({ status: 'cancelled', email: 'late@x.example' }));
    await sp.processEvent(paidEvent(order()));
    expect((await byId(store, 'o1')).status).toBe('conflict');
    expect(sent.map(m => m.key)).toEqual(['vic361-sponsor-conflict-o1']);
    expect(sent[0].to).toBe('late@x.example');
    expect(sent[0].text).toMatch(/refunded in full/);
  });
});

describe('L2: Stripe calls have a deadline', () => {
  it('passes a timeout signal and reports a timeout as such', async () => {
    let init;
    const stripe = createStripe('sk_test_x', async (url, i) => {
      init = i;
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    const err = await stripe.createCheckoutSession({ mode: 'payment' }, 'key').catch(e => e);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(err.code).toBe('timeout');
    expect(err.status).toBeUndefined();
  });
});
