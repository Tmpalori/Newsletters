// @vitest-environment node
//
// Sponsor checkout (server/sponsors.js). Stripe is a recording fake and
// webhooks are signed locally with the test secret; nothing is charged.

import { describe, it, expect, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { sameEvent, verifyStripeSignature, formEncode, bookableWeeks, pickAvailability, isWeekendDate, renderPreview, sponsorCalendar, parseLogo,
  newsletterCovers, sponsorStats, sponsorLandingUrl, renderThanksPage, statementSuffix } from '../server/sponsors.js';
import { promises as fs } from 'node:fs';
import { renderSubmissionReceived, renderSponsorConfirmed } from '../server/notify.js';
import { sponsorLinkUrl } from '../server/seo.js';
import { ADVERTISING_TERMS_VERSION } from '../server/legal.js';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { townConfig, useTown, VICTORIA } from '../server/town.js';

const NOW = new Date('2026-10-07T15:00:00Z'); // Wed Oct 7; this week starts Mon Oct 5
const WHSEC = 'whsec_test';

const EVENTS = [
  { date: '2026-10-09', name: 'Friday Live Music', time: '8:00 PM', venue: 'Aero Crafters' },
  { date: '2026-10-10', name: 'Fall Festival at De Leon Plaza', time: '10:00 AM', venue: 'De Leon Plaza' },
  { date: '2026-10-10', name: 'Trivia Night', time: '7:00 PM', venue: 'Somewhere Else' }
];
const VENUES = [
  { name: 'Aero Crafters', category: 'Bar / Live Music' },
  { name: 'De Leon Plaza', category: 'Park' }
];

let tmpDir, server, baseUrl, store, sessions, expiredSessions;

function fakeStripe() {
  sessions = [];
  expiredSessions = [];
  return {
    createCheckoutSession: async (params, key) => {
      const id = `cs_test_${sessions.length + 1}`;
      sessions.push({ params, key, id });
      return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
    },
    expireCheckoutSession: async (id) => { expiredSessions.push(id); return { id, status: 'expired' }; }
  };
}

async function startApp(extra = {}) {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-sp-'));
  const eventsFile = path.join(tmpDir, 'events.json');
  const venuesFile = path.join(tmpDir, 'venues.json');
  await fs.writeFile(eventsFile, JSON.stringify({ events: EVENTS, sponsor: { name: 'Manual Sponsor', text: 'Set by hand.' } }));
  await fs.writeFile(venuesFile, JSON.stringify(VENUES));
  store = new FileStore(path.join(tmpDir, 's.json'));
  const { app } = await createApp({
    // Trust the loopback "proxy", so each buyer below can come from its own
    // address (X-Forwarded-For in form()): one client gets one open hold.
    storeBundle: { kind: 'file', store }, eventsFile, venuesFile, trustProxy: 1, now: () => NOW,
    siteUrl: 'https://www.thevic361.com', adminUsername: 'a', adminPassword: 'b', adminSessionSecret: 'c',
    stripeSecretKey: 'sk_test', stripeWebhookSecret: WHSEC, stripe: fakeStripe(), resendApiKey: '', ...extra
  });
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

afterEach(async () => {
  if (server) await new Promise(r => server.close(r));
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  server = null; tmpDir = null;
});

// Ticks the advertising terms box like a buyer does (agree: '' leaves it off).
// Different buyers come from different addresses: each email gets its own
// (stable) client IP, unless the test names one.
const buyerIp = (email) => {
  const h = crypto.createHash('sha256').update(String(email || '')).digest();
  return `10.0.${h[0]}.${h[1]}`;
};
const form = (fields, ip = buyerIp(fields.email)) => fetch(baseUrl + '/advertise/checkout', {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': ip },
  body: new URLSearchParams({ agree: '1', ...fields }).toString()
});

function webhook(event, secret = WHSEC) {
  const raw = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return fetch(baseUrl + '/api/stripe/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${sig}` }, body: raw
  });
}

const completed = (s, extra = {}) => webhook({
  type: 'checkout.session.completed',
  data: { object: { id: s.id, client_reference_id: s.params.client_reference_id, payment_status: 'paid', amount_total: s.params.line_items[0].price_data.unit_amount, ...extra } }
});

async function auth() {
  const r = await fetch(baseUrl + '/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'a', password: 'b' })
  });
  return { Authorization: `Bearer ${(await r.json()).token}`, 'Content-Type': 'application/json' };
}

const publicEvents = async () => (await fetch(baseUrl + '/events.json')).json();

describe('helpers', () => {
  it('matches the same event by date and name', () => {
    expect(sameEvent({ date: '2026-10-10', name: 'Fall Festival' }, { date: '2026-10-10', name: 'Fall Festival at De Leon Plaza' })).toBe(true);
    expect(sameEvent({ date: '2026-10-10', name: 'Fall Festival' }, { date: '2026-10-11', name: 'Fall Festival' })).toBe(false);
    expect(sameEvent({ date: '2026-10-10', name: 'Fall Festival' }, { date: '2026-10-10', name: 'Trivia Night' })).toBe(false);
  });

  it('verifies Stripe signatures and rejects stale or forged ones', () => {
    const raw = '{"a":1}';
    const t = 1000;
    const sig = crypto.createHmac('sha256', WHSEC).update(`${t}.${raw}`).digest('hex');
    expect(verifyStripeSignature(raw, `t=${t},v1=${sig}`, WHSEC, t + 10)).toBe(true);
    expect(verifyStripeSignature(raw, `t=${t},v1=${sig}`, WHSEC, t + 1000)).toBe(false);
    expect(verifyStripeSignature(raw, `t=${t},v1=${sig}`, 'other', t)).toBe(false);
    expect(verifyStripeSignature('{"a":2}', `t=${t},v1=${sig}`, WHSEC, t)).toBe(false);
  });

  it('form-encodes nested params the way Stripe expects', () => {
    const s = formEncode({ line_items: [{ quantity: 1, price_data: { unit_amount: 4900 } }], skip: undefined }).toString();
    expect(decodeURIComponent(s)).toBe('line_items[0][quantity]=1&line_items[0][price_data][unit_amount]=4900');
  });

  it('offers the next 8 weeks, starting next Monday', () => {
    const w = bookableWeeks(NOW, []);
    expect(w).toHaveLength(8);
    expect(w[0].start).toBe('2026-10-12');
  });
});

describe('advertise page', () => {
  it('shows Buy now only when Stripe is configured', async () => {
    await startApp();
    expect(await (await fetch(baseUrl + '/advertise')).text()).toContain('/advertise/checkout?package=weekly');
    await new Promise(r => server.close(r)); server = null;
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await startApp({ stripeWebhookSecret: '' });
    expect(await (await fetch(baseUrl + '/advertise')).text()).not.toContain('Buy now');
    const r = await fetch(baseUrl + '/advertise/checkout?package=weekly', { redirect: 'manual' });
    expect(r.status).toBe(302);
  });
});

describe('weekly sponsor', () => {
  it('checkout → Stripe → webhook puts the block live for that week, and holds the week', async () => {
    await startApp();
    const page = await (await fetch(baseUrl + '/advertise/checkout?package=weekly')).text();
    expect(page).toContain('value="2026-10-12"');

    const bad = await form({ package: 'weekly', email: 'x', week: '2026-10-12' });
    expect(bad.status).toBe(400);
    expect(sessions).toHaveLength(0);

    const r = await form({
      package: 'weekly', week: '2026-10-12', business: 'Acme Tacos', text: 'Best tacos in town.',
      url: 'acme.example', cta: 'Order', email: 'Owner@Acme.example'
    });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('https://checkout.stripe.com/c/pay/cs_test_1');
    const s = sessions[0];
    expect(s.params).toMatchObject({ mode: 'payment', customer_email: 'owner@acme.example' });
    expect(s.params.line_items[0].price_data.unit_amount).toBe(14900);
    expect(s.key).toBe(`vic361-order-${s.params.client_reference_id}`);

    // While that buyer is paying, the week can't be sold again.
    const dup = await form({ package: 'weekly', week: '2026-10-12', business: 'B', text: 'x', url: 'b.example', email: 'b@b.example' });
    expect(dup.status).toBe(400);
    expect(await dup.text()).toContain('just booked');

    expect((await webhook({ type: 'checkout.session.completed', data: { object: {} } }, 'wrong')).status).toBe(400);
    expect((await completed(s)).status).toBe(200);
    const [order] = await store.listSponsorOrders();
    expect(order.status).toBe('paid');

    // Not this week (it's booked for next week), so the manual sponsor stays.
    expect((await publicEvents()).sponsor.name).toBe('Manual Sponsor');
    const thanks = await (await fetch(`${baseUrl}/advertise/thanks?order=${order.id}`)).text();
    expect(thanks).toContain('October 12');
  });

  it('a paid sponsor for the current week replaces the sponsor everywhere', async () => {
    await startApp();
    await store.saveSponsorOrder({
      id: 'o1', kind: 'weekly', status: 'paid', week_start: '2026-10-05', created_at: '2026-10-01T00:00:00Z',
      sponsor: { name: 'Acme Tacos', text: 'Best tacos.', cta: 'Order', url: 'https://acme.example' }
    });
    expect((await publicEvents()).sponsor.name).toBe('Acme Tacos');
    expect(await (await fetch(baseUrl + '/this-weekend')).text()).toContain('Acme Tacos');

    const h = await auth();
    const hide = await fetch(baseUrl + '/api/admin/sponsors/o1', { method: 'POST', headers: h, body: JSON.stringify({ action: 'hide' }) });
    expect(hide.status).toBe(200);
    expect((await publicEvents()).sponsor.name).toBe('Manual Sponsor');
    await fetch(baseUrl + '/api/admin/sponsors/o1', { method: 'POST', headers: h, body: JSON.stringify({ action: 'restore' }) });
    expect((await publicEvents()).sponsor.name).toBe('Acme Tacos');
  });
});

describe('featured event', () => {
  it('paid order lands in the review queue and features the matching live event', async () => {
    await startApp();
    const r = await form({
      package: 'featured', event_name: 'Fall Festival', date: '2026-10-10', time: '10 AM', venue: 'De Leon Plaza',
      address: '101 N Main St', description: 'Food, music, rides.', business: 'Main Street', email: 'ms@example.com'
    });
    expect(r.status).toBe(303);
    // Saturday: weekend Vic’s Pick price.
    expect(sessions[0].params.line_items[0].price_data.unit_amount).toBe(3900);
    await completed(sessions[0]);

    const subs = await store.list({});
    const sub = subs.find(x => x.source === 'paid-feature');
    expect(sub).toBeTruthy();
    expect(sub.payload.name).toBe('Fall Festival');

    const ev = (await publicEvents()).events.find(e => e.name.startsWith('Fall Festival'));
    expect(ev.featured).toBe(true);
    expect((await publicEvents()).events.find(e => e.name === 'Trivia Night').featured).toBeFalsy();

    // Replayed webhook doesn't create a second submission.
    await completed(sessions[0]);
    expect((await store.list({})).filter(x => x.source === 'paid-feature')).toHaveLength(1);
  });

  it('rejects past dates', async () => {
    await startApp();
    const r = await form({
      package: 'featured', event_name: 'Old Show', date: '2026-10-01', time: '7 PM', venue: 'X',
      address: 'Y', description: 'Z', business: 'B', email: 'b@example.com'
    });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain('That date has passed');
  });
});

describe('venue partner (retired)', () => {
  it('is no longer for sale, but an existing subscription keeps working until it is cancelled', async () => {
    await startApp();
    // A subscription bought before the package was retired (saved before any
    // request, since orders are cached for a minute).
    await store.saveSponsorOrder({ id: 'old-partner', kind: 'partner', status: 'active', venue_slug: 'aero-crafters',
      venue_name: 'Aero Crafters', business: 'Aero Crafters', email: 'aero@example.com', amount: 15000,
      subscription_id: 'sub_123', created_at: '2026-09-01T00:00:00Z' });
    // Can't buy a new one: checkout sends them back to /advertise.
    const r = await form({ package: 'partner', venue: 'aero-crafters', business: 'Aero Crafters', email: 'aero@example.com' });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/advertise');
    expect(sessions).toHaveLength(0);
    expect((await fetch(baseUrl + '/advertise/checkout?package=partner', { redirect: 'manual' })).headers.get('location')).toBe('/advertise');
    expect(await (await fetch(baseUrl + '/advertise')).text()).not.toContain('Venue partner');

    // One bought before it was retired is still honored.
    const featuredNames = async () => (await publicEvents()).events.filter(e => e.featured && !e.editor_pick).map(e => e.name);
    expect(await featuredNames()).toEqual(['Friday Live Music']);
    await webhook({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_123', status: 'canceled' } } });
    expect(await featuredNames()).toEqual([]);
  });
});

describe('admin', () => {
  it('lists orders and the week calendar', async () => {
    await startApp();
    await form({ package: 'weekly', week: '2026-10-19', business: 'Acme', text: 'Hi.', url: 'acme.example', email: 'a@acme.example' });
    await completed(sessions[0]);
    const d = await (await fetch(baseUrl + '/api/admin/sponsors', { headers: await auth() })).json();
    expect(d).toMatchObject({ ok: true, configured: true });
    expect(d.orders).toHaveLength(1);
    expect(d.weeks.find(w => w.start === '2026-10-19').available).toBe(false);
    expect((await fetch(baseUrl + '/api/admin/sponsors')).status).toBe(401);
  });
});

describe('booking safety', () => {
  const weekly = (who) => ({ package: 'weekly', week: '2026-10-19', business: who, text: 'x', url: `${who}.example`, email: `${who}@x.example` });

  it('two buyers hitting the same week at once: only one gets a checkout', async () => {
    await startApp();
    const [a, b] = await Promise.all([form(weekly('alpha')), form(weekly('beta'))]);
    expect([a.status, b.status].sort()).toEqual([303, 400]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].params.payment_method_types).toBeUndefined();
    expect(sessions[0].params.integration_identifier).toMatch(/^vic361_sponsor_checkout_[a-z]{8}$/);
  });

  it('a second payment for a sold week is flagged for refund, not put live', async () => {
    await startApp();
    await form(weekly('alpha'));
    const first = sessions[0];
    await completed(first);
    // Second buyer's order sneaks in (e.g. an old hold) and pays too.
    const id = 'late-order';
    await store.saveSponsorOrder({ id, kind: 'weekly', week_start: '2026-10-19', business: 'Late', email: 'l@x.example', status: 'pending', created_at: NOW.toISOString(), amount: 30000 });
    expect((await completed({ id: 'cs_late', params: { client_reference_id: id, line_items: [{ price_data: { unit_amount: 30000 } }] } })).status).toBe(200);
    const late = (await store.listSponsorOrders()).find(o => o.id === id);
    expect(late.status).toBe('conflict');
  });

  it('a refund takes the placement down', async () => {
    await startApp();
    await form(weekly('alpha'));
    await completed(sessions[0], { payment_intent: 'pi_123' });
    await webhook({ type: 'charge.refunded', data: { object: { payment_intent: 'pi_123', refunded: true } } });
    const [order] = await store.listSponsorOrders();
    expect(order.status).toBe('refunded');
  });

  it('a Stripe failure releases the hold', async () => {
    await startApp({ stripe: { createCheckoutSession: async () => { throw new Error('down'); } } });
    expect((await form(weekly('alpha'))).status).toBe(502);
    const [order] = await store.listSponsorOrders();
    expect(order.status).toBe('failed');
    const page = await (await fetch(baseUrl + '/advertise/checkout?package=weekly')).text();
    expect(page).toContain('value="2026-10-19"');
    expect(page).not.toMatch(/value="2026-10-19"[^>]*disabled/);
  });
});

describe('same event matching', () => {
  it('same name at two different venues is two events', () => {
    expect(sameEvent({ date: '2026-10-10', name: 'Live Music', venue: 'Moonshine Drinkery' },
      { date: '2026-10-10', name: 'Live Music', venue: 'Aero Crafters' })).toBe(false);
    expect(sameEvent({ date: '2026-10-10', name: 'Live Music', venue: 'Moonshine Drinkery' },
      { date: '2026-10-10', name: 'Live Music', venue: 'Moonshine Drinkery Victoria' })).toBe(true);
    expect(sameEvent({ date: '2026-10-10', name: 'Live Music', venue: '' },
      { date: '2026-10-10', name: 'Live Music', venue: 'Aero Crafters' })).toBe(true);
  });
});

describe('Stripe best practices', () => {
  const weekly = (who) => ({ package: 'weekly', week: '2026-10-26', business: who, text: 'x', url: `${who}.example`, email: `${who}@x.example` });

  it('a slow (bank) payment holds the week as processing, then goes live or frees the week', async () => {
    await startApp();
    await form(weekly('alpha'));
    const s = sessions[0];
    await completed(s, { payment_status: 'unpaid' });
    let [order] = await store.listSponsorOrders();
    expect(order.status).toBe('processing');
    // Week stays taken while the money is in flight, even after the 35-min hold.
    const page = await (await fetch(baseUrl + '/advertise/checkout?package=weekly')).text();
    expect(page).toMatch(/value="2026-10-26"[^>]*disabled/);

    await webhook({ type: 'checkout.session.async_payment_failed', data: { object: { id: s.id, client_reference_id: s.params.client_reference_id } } });
    [order] = await store.listSponsorOrders();
    expect(order.status).toBe('failed');

    // A later success (e.g. a retried payment) still goes live.
    await webhook({ type: 'checkout.session.async_payment_succeeded', data: { object: { id: s.id, client_reference_id: s.params.client_reference_id, payment_status: 'paid', amount_total: 30000 } } });
    [order] = await store.listSponsorOrders();
    expect(order.status).toBe('paid');
  });

  it('a bank payment that settles after the pick\'s date isn\'t booked: no submission, no "you\'re booked", a refund alert and an apology', async () => {
    let clock = NOW;
    const sent = [];
    const alerts = [];
    await startApp({ now: () => clock, resendApiKey: 're_test', newsletterAddress: '1 Main St',
      resend: { send: async (msg, key) => { sent.push({ ...msg, key }); return { id: 'e' }; }, batch: async () => ({ data: [] }) },
      slack: { enabled: true, notify: async () => true, alert: async (key, title, text) => { alerts.push({ key, title, text }); } } });
    await form({ package: 'featured', event_name: 'Fall Festival', date: '2026-10-10', time: '10 AM', venue: 'De Leon Plaza',
      address: '101 N Main St', description: 'Food, music, rides.', business: 'Main Street', email: 'ms@example.com' });
    const s = sessions[0];
    await completed(s, { payment_status: 'unpaid' });
    clock = new Date('2026-10-13T15:00:00Z'); // the next Tuesday
    await webhook({ type: 'checkout.session.async_payment_succeeded', data: { object: { id: s.id, client_reference_id: s.params.client_reference_id, payment_status: 'paid', amount_total: 8900, payment_intent: 'pi_1' } } });
    const [order] = await store.listSponsorOrders();
    expect(order.status).toBe('late');
    expect(order.submission_id).toBeFalsy();
    expect((await store.list({})).filter(x => x.source === 'paid-feature')).toHaveLength(0);
    expect(sent.some(m => /booked/i.test(m.subject))).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/refund/i);
    expect(alerts.some(a => /refund/i.test(`${a.title} ${a.text}`))).toBe(true);
    const thanks = await (await fetch(`${baseUrl}/advertise/thanks?order=${order.id}`)).text();
    expect(thanks).toMatch(/refund/i);
    // A repeat of the webhook changes nothing.
    await webhook({ type: 'checkout.session.async_payment_succeeded', data: { object: { id: s.id, client_reference_id: s.params.client_reference_id, payment_status: 'paid', amount_total: 8900 } } });
    expect((await store.listSponsorOrders())[0].status).toBe('late');
    expect(sent).toHaveLength(1);
  });

  it('a weekly payment that settles after its week ended is not booked either', async () => {
    let clock = NOW;
    await startApp({ now: () => clock });
    await form(weekly('alpha')); // week of Oct 26
    const s = sessions[0];
    await completed(s, { payment_status: 'unpaid' });
    clock = new Date('2026-11-02T15:00:00Z'); // the Monday after that week
    await webhook({ type: 'checkout.session.async_payment_succeeded', data: { object: { id: s.id, client_reference_id: s.params.client_reference_id, payment_status: 'paid', amount_total: 30000 } } });
    expect((await store.listSponsorOrders())[0].status).toBe('late');
  });

  it('only instant payment methods are offered when the date is days away', async () => {
    await startApp();
    await form({ package: 'featured', event_name: 'Fall Festival', date: '2026-10-10', time: '10 AM', venue: 'De Leon Plaza',
      address: '101 N Main St', description: 'Food, music, rides.', business: 'Main Street', email: 'ms@example.com' });
    expect(sessions[0].params.payment_method_types).toEqual(['card']);
    await form(weekly('alpha')); // week of Oct 26: weeks away, so the Dashboard's methods
    expect(sessions[1].params.payment_method_types).toBeUndefined();
  });

  it('uses a catalog price when the client can make one, and falls back to inline pricing', async () => {
    const stripe = {
      ensurePrice: async (pkg) => `price_${pkg.key}`,
      createCheckoutSession: async (params, key) => { sessions.push({ params, key, id: 'cs_1' }); return { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' }; }
    };
    sessions = [];
    await startApp({ stripe });
    sessions = [];
    await form(weekly('alpha'));
    expect(sessions[0].params.line_items[0]).toEqual({ quantity: 1, price: 'price_weekly' });

    stripe.ensurePrice = async () => { throw new Error('catalog down'); };
    await form({ ...weekly('beta'), week: '2026-11-02' });
    expect(sessions[1].params.line_items[0].price_data.unit_amount).toBe(14900);
  });
});

describe('Stripe client', () => {
  it('pins the API version and creates a lookup-key price once', async () => {
    const { createStripe, STRIPE_API_VERSION } = await import('../server/sponsors.js');
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      const ok = (b) => ({ ok: true, status: 200, json: async () => b });
      if (url.includes('/prices?')) return ok({ data: [] });
      if (url.endsWith('/products')) return ok({ id: 'prod_1' });
      if (url.endsWith('/prices')) return ok({ id: 'price_1' });
      return ok({});
    };
    const client = createStripe('rk_test_x', fetchImpl);
    const pkg = { key: 'partner', name: 'Venue partner', amount: 15000, interval: 'month' };
    expect(await client.ensurePrice(pkg)).toBe('price_1');
    expect(await client.ensurePrice(pkg)).toBe('price_1'); // cached
    expect(calls).toHaveLength(3);
    expect(calls.every(c => c.init.headers['Stripe-Version'] === STRIPE_API_VERSION)).toBe(true);
    expect(calls[0].url).toContain('lookup_keys%5B%5D=vic361_partner_15000_month');
    expect(calls[2].init.body).toContain('recurring%5Binterval%5D=month');
    expect(calls[2].init.body).toContain('lookup_key=vic361_partner_15000_month');
  });
});

describe('Vic’s Pick: price by day, daily limits, preview', () => {
  const pick = (date, extra = {}) => form({
    package: 'featured', event_name: `Show on ${date}`, date, time: '7 PM', venue: 'Aero Crafters',
    address: '309 E Crestwood Dr', description: 'Live music.', business: 'Aero', email: 'a@example.com', ...extra
  });
  const order = (date, status, minutesAgo = 0) => store.saveSponsorOrder({
    id: `o-${date}-${Math.random()}`, kind: 'featured', status, amount: 4900,
    created_at: new Date(NOW.getTime() - minutesAgo * 60000).toISOString(),
    event: { date, name: 'Taken', time: '7 PM', venue: 'X' }
  });

  it('weekdays are $29, Fri–Sun $39, with its own Stripe product name', async () => {
    expect([isWeekendDate('2026-10-08'), isWeekendDate('2026-10-09'), isWeekendDate('2026-10-11'), isWeekendDate('2026-10-12')])
      .toEqual([false, true, true, false]);
    await startApp();
    expect((await pick('2026-10-08')).status).toBe(303);   // Thursday
    expect((await pick('2026-10-09')).status).toBe(303);   // Friday
    expect(sessions.map(x => x.params.line_items[0].price_data.unit_amount)).toEqual([2900, 3900]);
    expect(sessions[1].params.line_items[0].price_data.product_data.name).toContain('Fri–Sun');
    const amounts = (await store.listSponsorOrders()).map(o => o.amount).sort();
    expect(amounts).toEqual([2900, 3900]);
  });

  it('a weekday holds 3 picks and a weekend day 4; live checkouts count, expired ones don’t', async () => {
    await startApp();
    await order('2026-10-08', 'paid'); await order('2026-10-08', 'paid');
    await order('2026-10-08', 'pending', 5);        // someone paying right now
    await order('2026-10-08', 'pending', 120);      // abandoned long ago
    await order('2026-10-08', 'refunded');
    const full = await pick('2026-10-08');
    expect(full.status).toBe(400);
    expect(await full.text()).toContain('sold out (3 a day)');

    for (let i = 0; i < 3; i++) await order('2026-10-10', 'paid');
    expect((await pick('2026-10-10')).status).toBe(303);            // 4th Saturday spot
    const sat = await (await fetch(baseUrl + '/api/vics-pick/availability?date=2026-10-10')).json();
    expect(sat).toMatchObject({ ok: true, weekend: true, cap: 4, taken: 4, left: 0, price: '$39' });
    expect((await pick('2026-10-10', { email: 'someone@else.example' })).status).toBe(400);
    const thu = await (await fetch(baseUrl + '/api/vics-pick/availability?date=2026-10-08')).json();
    expect(thu).toMatchObject({ weekend: false, cap: 3, left: 0, price: '$29' });
    expect((await fetch(baseUrl + '/api/vics-pick/availability?date=soon')).status).toBe(400);
  });

  it('shows a live preview with the site’s own markup before payment', async () => {
    await startApp();
    const page = await (await fetch(baseUrl + '/advertise/checkout?package=featured&event_name=Pumpkin%20%3CPatch%3E&date=2026-10-10&venue=Titan')).text();
    expect(page).toContain('Preview: exactly how it’ll look');
    expect(page).toContain('event-entry event-entry--featured');            // same markup as the site
    expect(page).toContain('Pumpkin &lt;Patch&gt;');                        // prefilled and escaped
    expect(page).toContain('Saturday, Oct 10: $39');
    expect(page).toContain('4 of 4 Vic’s Pick spots left');
    expect(page.indexOf('co-preview')).toBeLessThan(page.indexOf('Continue to payment'));

    const r = await fetch(baseUrl + '/advertise/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ package: 'weekly', business: 'Acme Tacos', text: 'Best tacos <b>ever</b>', cta: 'Order' }).toString()
    });
    const html = await r.text();
    expect(html).toContain('sponsor-block');
    expect(html).toContain('Acme Tacos');
    expect(html).toContain('Best tacos &lt;b&gt;ever&lt;/b&gt;');
  });

  it('the advertise page says where each option shows, its limits, and shows examples', async () => {
    await startApp();
    const html = await (await fetch(baseUrl + '/advertise')).text();
    expect(html).toContain('$29 Mon–Thu · $39 Fri–Sun');
    expect(html).toContain('Only 3 a day Mon–Thu and 4 a day Fri–Sun');
    expect(html).not.toContain('Where it shows:'); // the checklist and the "Where your ad goes" diagram say it
    expect((html.match(/ad-package__preview/g) || []).length).toBe(3);
    expect(html).toContain('Book your sponsor week →');
    expect(html).toContain('Give my event the Vic’s Pick badge →');
    expect(html).toContain('See a live preview before you pay');
  });
});

describe('free submissions point to the paid upgrade', () => {
  it('the submit page says free isn’t guaranteed and links to a Vic’s Pick', async () => {
    const html = await fs.readFile(path.join(process.cwd(), 'docs', 'submit.html'), 'utf8');
    expect(html).toContain("aren't guaranteed a spot");
    expect(html).toContain('href="/advertise/checkout?package=featured"');
    expect(html).toContain('id="thanks-promo-link"');
  });
});

describe('admin sponsorship calendar', () => {
  it('shows every slot for 8 weeks: the weekly sponsor and each day’s Vic’s Picks with who holds them', () => {
    const o = (extra) => ({ id: Math.random().toString(36), created_at: NOW.toISOString(), ...extra });
    const orders = [
      o({ kind: 'weekly', status: 'paid', week_start: '2026-10-12', business: 'Acme Tacos' }),
      o({ kind: 'featured', status: 'paid', business: 'Titan', event: { date: '2026-10-10', name: 'Pumpkin Patch' } }),
      o({ kind: 'featured', status: 'pending', business: 'Weber', event: { date: '2026-10-10', name: 'Oktoberfest' } }),
      o({ kind: 'featured', status: 'pending', business: 'Stale', event: { date: '2026-10-10', name: 'Old' },
          created_at: new Date(NOW.getTime() - 3 * 3600e3).toISOString() }),
      o({ kind: 'featured', status: 'refunded', business: 'Gone', event: { date: '2026-10-10', name: 'X' } })
    ];
    const cal = sponsorCalendar(NOW, orders);
    expect(cal).toHaveLength(8);
    expect(cal[0].start).toBe('2026-10-05');                 // starts this week
    expect(cal[0].weekly).toBeNull();
    expect(cal[1].weekly).toMatchObject({ business: 'Acme Tacos', state: 'booked' });
    const sat = cal[0].days.find(d => d.date === '2026-10-10');
    expect(sat).toMatchObject({ weekend: true, cap: 4, taken: 2, left: 2, price: '$39', past: false });
    expect(sat.picks.map(p => [p.business, p.state])).toEqual([['Titan', 'booked'], ['Weber', 'held']]);
    expect(cal[0].days.find(d => d.date === '2026-10-06')).toMatchObject({ past: true, cap: 3, price: '$29' });
  });

  it('comes back from the admin API', async () => {
    await startApp();
    const login = await fetch(baseUrl + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'a', password: 'b' }) });
    const token = (await login.json()).token;
    const d = await (await fetch(baseUrl + '/api/admin/sponsors', { headers: { Authorization: `Bearer ${token}` } })).json();
    expect(d.calendar).toHaveLength(8);
    expect(d.calendar[0].days).toHaveLength(7);
  });
});

describe('confirmation emails', () => {
  const fakeMail = () => {
    const sent = [];
    return { sent, resend: { send: async (msg, key) => { sent.push({ ...msg, key }); return { id: 'e' + sent.length }; }, batch: async () => ({ data: [] }) } };
  };

  it('a Vic’s Pick purchase emails what happens next, once', async () => {
    const mail = fakeMail();
    await startApp({ resendApiKey: 're_test', resend: mail.resend, newsletterAddress: '123 Main St', newsletterReplyTo: 'hello@thevic361.com' });
    await form({
      package: 'featured', event_name: 'Pumpkin Patch', date: '2026-10-10', time: '10 AM', venue: 'Titan',
      address: 'X', description: 'Pumpkins.', business: 'Titan', email: 'titan@example.com'
    });
    await completed(sessions[0]);
    await completed(sessions[0]);                       // Stripe retries the webhook
    const mine = mail.sent.filter(m => m.to[0] === 'titan@example.com');
    expect(mine).toHaveLength(1);
    expect(mine[0].subject).toBe("Your Vic's Pick is confirmed: Pumpkin Patch");
    expect(mine[0].reply_to).toBe('hello@thevic361.com');
    expect(mine[0].key).toMatch(/^vic361-sponsor-/);
    expect(mine[0].text).toContain('highlighted on Saturday, October 10');
    expect(mine[0].html).toContain('thevic361.com/contact');
    expect((await store.listSponsorOrders())[0].confirmation_sent).toBeTruthy();
  });

  it('a weekly sponsor gets a "you’re booked" email; no Resend means no email and no error', async () => {
    const mail = fakeMail();
    await startApp({ resendApiKey: 're_test', resend: mail.resend });
    const week = bookableWeeks(NOW, []).find(w => w.available).start;
    await form({ package: 'weekly', week, business: 'Acme Tacos', text: 'Best tacos.', url: 'acme.example', email: 'acme@example.com' });
    await completed(sessions[0]);
    expect(mail.sent.map(m => m.subject)).toEqual([expect.stringMatching(/^You're booked: The Vic 361 sponsor, week of /)]);
    expect(mail.sent[0].text).toContain('Best tacos.');
  });

  it('a free submission with an email gets "we got it", what to expect and how to reach us, with no paid upsell', async () => {
    const mail = fakeMail();
    await startApp({ resendApiKey: 're_test', resend: mail.resend });
    const body = { name: 'Fall Fest', date: '2026-10-17', time: '10:00 AM', venue: 'De Leon Plaza', address: '101 N Main St',
      description: 'Music and food all day.', submitter_kind: 'organizer', submitter_email: 'org@example.com',
      submitter_first_name: 'Pat', submitter_last_name: 'Lee', submitter_phone: '361-555-0100', icons: ['music'], free: true };
    const r = await fetch(baseUrl + '/api/submissions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect(r.status).toBe(201);
    await vi.waitFor(() => expect(mail.sent).toHaveLength(1), { timeout: 2000 });
    const m = mail.sent[0];
    expect(m.to).toEqual(['org@example.com']);
    expect(m.subject).toBe('We got your event submission');                // fixed: no sender-chosen text
    expect(m.text).toContain('Free listings aren’t guaranteed a spot');
    expect(m.html).not.toContain('Music and food all day.');
    const { id } = await r.json();
    // /submit promises the address isn't used for marketing: no upgrade offer.
    expect(m.text).not.toContain('/advertise/checkout');
    expect(m.html).not.toContain('/advertise/checkout');
    expect(m.text).not.toContain('org%40example.com');
    expect(m.text).toContain('/contact');

    // The upgrade link fills in the event and contact on the server.
    const page = await (await fetch(`${baseUrl}/advertise/checkout?package=featured&from=${id}`)).text();
    expect(page).toContain('value="Fall Fest"');
    expect(page).toContain('value="org@example.com"');
    expect(page).toContain('value="Pat Lee"');
    // Contact fields in the query are ignored.
    expect(await (await fetch(`${baseUrl}/advertise/checkout?package=featured&email=x%40y.com&business=Me`)).text()).not.toContain('value="Me"');

    // At most 3 receipts a day to one address.
    for (let i = 0; i < 4; i++) {
      await fetch(baseUrl + '/api/submissions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, name: `Fall Fest ${i + 2}` }) });
    }
    await vi.waitFor(() => expect(mail.sent).toHaveLength(3), { timeout: 2000 });
    await new Promise(res => setTimeout(res, 50)); // room for a wrong fourth one
    expect(mail.sent).toHaveLength(3);
  });

  it('renders safely', () => {
    const sub = renderSubmissionReceived({ name: '<b>Show</b>', date: '2026-10-17', venue: 'Hall' }, { siteUrl: 'https://x', upgradeUrl: 'https://x/u' });
    expect(sub.html).toContain('&lt;b&gt;Show&lt;/b&gt;');
    expect(sub.html).not.toContain('<b>Show</b>');
    const w = renderSponsorConfirmed({ kind: 'weekly', business: 'A', week_start: '2026-10-12', sponsor: { name: 'A', text: 'Hi', url: 'javascript:alert(1)' } }, { siteUrl: 'https://x' });
    expect(w.html).not.toContain('javascript:');
  });
});

describe('weekly sponsor logo', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  it('accepts real PNG/JPEG/WebP only, and not too big', () => {
    expect(parseLogo(PNG)).toMatchObject({ contentType: 'image/png' });
    expect(parseLogo('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=').error).toMatch(/PNG, JPG or WebP/);
    expect(parseLogo('data:image/png;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64')).error).toMatch(/valid image/);
    const big = Buffer.alloc(301 * 1024); big[0] = 0x89; big.write('PNG', 1);
    expect(parseLogo('data:image/png;base64,' + big.toString('base64')).error).toMatch(/too large/);
  });

  it('is saved apart from the order, served as an image, and shown on the live sponsor block', async () => {
    await startApp();
    const week = bookableWeeks(NOW, []).find(w => w.available).start;
    const r = await form({ package: 'weekly', week, business: 'Acme Tacos', text: 'Best tacos.', url: 'acme.example',
      email: 'acme@example.com', logo_data: PNG });
    expect(r.status).toBe(303);
    const order = (await store.listSponsorOrders())[0];
    expect(order.sponsor.logo).toBe(`/sponsor-logo/${order.id}`);
    expect(JSON.stringify(order)).not.toContain('iVBOR');                 // bytes aren't on the order
    const img = await fetch(baseUrl + order.sponsor.logo);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(img.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await img.arrayBuffer()).slice(1, 4).toString()).toBe('PNG');
    expect((await fetch(baseUrl + '/sponsor-logo/nope')).status).toBe(404);
    expect((await fetch(baseUrl + '/sponsor-logo/..%2Fsecret')).status).toBe(404);
  });

  it('a bad logo is reported on the form, not charged', async () => {
    await startApp();
    const week = bookableWeeks(NOW, []).find(w => w.available).start;
    const r = await form({ package: 'weekly', week, business: 'Acme', text: 'Hi.', url: 'acme.example',
      email: 'a@example.com', logo_data: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain('Logo must be a PNG, JPG or WebP image.');
    expect(sessions).toHaveLength(0);
  });

  it('the checkout form offers a logo upload for weekly sponsors only', async () => {
    await startApp();
    expect(await (await fetch(baseUrl + '/advertise/checkout?package=weekly')).text()).toContain('id="f-logo"');
    expect(await (await fetch(baseUrl + '/advertise/checkout?package=featured')).text()).not.toContain('id="f-logo"');
  });
});


describe('logo review fixes', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const weeklyForm = (extra = {}) => ({ package: 'weekly', week: '2026-10-19', business: 'Acme Tacos', text: 'Best tacos.',
    url: 'acme.example', email: 'acme@example.com', logo_data: PNG, ...extra });
  const quietSlack = () => {
    const alerts = [];
    return { alerts, slack: { enabled: true, notify: async () => true, alert: async (...a) => { alerts.push(a); } } };
  };

  it('an oversized checkout body is a friendly 413, not a 500 or a Slack alert', async () => {
    const s = quietSlack();
    await startApp({ slack: s.slack });
    const r = await form(weeklyForm({ logo_data: 'data:image/png;base64,' + 'A'.repeat(700 * 1024) }));
    expect(r.status).toBe(413);
    const html = await r.text();
    expect(html).toContain('That logo is too large');
    expect(html).toContain('href="/advertise/checkout?package=weekly"');
    const api = await fetch(baseUrl + '/api/submissions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x: 'y'.repeat(70 * 1024) }) });
    expect(api.status).toBe(413);
    expect(s.alerts).toHaveLength(0);
    expect(sessions).toHaveLength(0);
    // The page refuses an oversized logo before sending it.
    expect(await (await fetch(baseUrl + '/advertise/checkout?package=weekly')).text()).toMatch(/logoData\.value\.length > \d{6}/);
  });

  it('a rejected logo isn’t sent back into the form, and a chosen one can be removed', async () => {
    await startApp();
    const bad = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=';
    const html = await (await form(weeklyForm({ logo_data: bad }))).text();
    expect(html).toContain('Logo must be a PNG');
    expect(html).toContain('id="f-logo-data" value=""');
    expect(html).not.toContain('PHN2Zz48L3N2Zz4=');
    expect(html).toMatch(/id="f-logo-remove" hidden>Remove logo/);
    // A good logo kept across another field's error shows the remove button.
    const kept = await (await form(weeklyForm({ email: 'nope' }))).text();
    expect(kept).toContain(`value="${PNG}"`);
    expect(kept).toMatch(/id="f-logo-remove">Remove logo/);
  });

  it('logos are served only while the order is live or being paid for, and unpaid ones are deleted', async () => {
    await startApp();
    await form(weeklyForm());
    let [order] = await store.listSponsorOrders();
    const logoUrl = baseUrl + order.sponsor.logo;
    const held = await fetch(logoUrl);
    expect(held.status).toBe(200);                             // checkout open right now
    expect(held.headers.get('cache-control')).toBe('public, max-age=3600');
    await webhook({ type: 'checkout.session.expired', data: { object: { id: sessions[0].id, client_reference_id: order.id } } });
    [order] = await store.listSponsorOrders();
    expect(order.status).toBe('expired');
    expect(await store.getSponsorLogo(order.id)).toBeNull();
    expect((await fetch(logoUrl)).status).toBe(404);
  });

  it('a logo whose checkout couldn’t start is deleted; a hidden order’s logo isn’t served', async () => {
    await startApp({ stripe: { createCheckoutSession: async () => { throw new Error('down'); } } });
    expect((await form(weeklyForm())).status).toBe(502);
    const [failed] = await store.listSponsorOrders();
    expect(await store.getSponsorLogo(failed.id)).toBeNull();

    // A paid order stored by hand, then hidden: its logo stops resolving.
    await store.saveSponsorLogo('paid-order-1', { contentType: 'image/png', data: Buffer.from(PNG.split(',')[1], 'base64') });
    await store.saveSponsorOrder({ id: 'paid-order-1', kind: 'weekly', status: 'paid', week_start: '2026-10-26', business: 'B', email: 'b@x.example',
      created_at: NOW.toISOString(), sponsor: { name: 'B', text: 'Hi', url: 'https://b.example', logo: '/sponsor-logo/paid-order-1' } });
    expect((await fetch(baseUrl + '/sponsor-logo/paid-order-1')).status).toBe(200);
    const h = await auth();
    await fetch(baseUrl + '/api/admin/sponsors/paid-order-1', { method: 'POST', headers: h, body: JSON.stringify({ action: 'hide' }) });
    expect((await fetch(baseUrl + '/sponsor-logo/paid-order-1')).status).toBe(404);
    // The admin still sees it.
    const adminImg = await fetch(baseUrl + '/api/admin/sponsors/paid-order-1/logo', { headers: h });
    expect(adminImg.status).toBe(200);
    expect(adminImg.headers.get('content-type')).toBe('image/png');
    expect((await fetch(baseUrl + '/api/admin/sponsors/paid-order-1/logo')).status).toBe(401);
  });

  it('the admin can remove a logo and the block stays up without it', async () => {
    await startApp();
    await form(weeklyForm());
    await completed(sessions[0]);
    let [order] = await store.listSponsorOrders();
    expect((await fetch(baseUrl + order.sponsor.logo)).status).toBe(200);
    const h = await auth();
    const r = await fetch(`${baseUrl}/api/admin/sponsors/${order.id}`, { method: 'POST', headers: h, body: JSON.stringify({ action: 'remove-logo' }) });
    expect((await r.json()).ok).toBe(true);
    [order] = await store.listSponsorOrders();
    expect(order.status).toBe('paid');
    expect(order.sponsor.logo).toBeUndefined();
    expect(order.sponsor.name).toBe('Acme Tacos');
    expect(await store.getSponsorLogo(order.id)).toBeNull();
    expect((await fetch(`${baseUrl}/sponsor-logo/${order.id}`)).status).toBe(404);
    // Nothing left to remove.
    expect((await fetch(`${baseUrl}/api/admin/sponsors/${order.id}`, { method: 'POST', headers: h, body: JSON.stringify({ action: 'remove-logo' }) })).status).toBe(400);
  });
});

describe('backing out of Stripe', () => {
  const pick = (extra = {}) => form({
    package: 'featured', event_name: 'Last Spot Show', date: '2026-10-08', time: '7 PM', venue: 'Aero Crafters',
    address: '309 E Crestwood Dr', description: 'Live music.', business: 'Aero', email: 'aero@example.com', ...extra
  });
  const paidPick = (id) => store.saveSponsorOrder({ id, kind: 'featured', status: 'paid', amount: 4900, created_at: NOW.toISOString(),
    event: { date: '2026-10-08', name: 'Taken', time: '7 PM', venue: 'X' } });

  it('cancel_url releases the hold, expires the session and refills the form', async () => {
    await startApp();
    await paidPick('p1'); await paidPick('p2');               // 1 of 3 Thursday spots left
    expect((await pick()).status).toBe(303);
    const s = sessions[0];
    expect(s.params.cancel_url).toBe(`https://www.thevic361.com/advertise/checkout?package=featured&cancelled=${s.params.client_reference_id}`);
    // Someone else can't have the held spot.
    expect((await pick({ email: 'other@example.com' })).status).toBe(400);

    const back = await (await fetch(s.params.cancel_url.replace('https://www.thevic361.com', baseUrl))).text();
    expect(back).toContain('value="Last Spot Show"');
    expect(back).toContain('value="aero@example.com"');
    const order = (await store.listSponsorOrders()).find(o => o.id === s.params.client_reference_id);
    expect(order.status).toBe('cancelled');
    expect(expiredSessions).toEqual([s.id]);
    expect((await pick()).status).toBe(303);                  // their retry gets the spot

    // Admin doesn't list abandoned checkouts the buyer backed out of.
    const d = await (await fetch(baseUrl + '/api/admin/sponsors', { headers: await auth() })).json();
    expect(d.orders.map(o => o.status)).not.toContain('cancelled');
  });

  it('the same buyer resubmitting isn’t blocked by their own hold; a different buyer is', async () => {
    await startApp();
    await paidPick('p1'); await paidPick('p2');
    expect((await pick()).status).toBe(303);
    expect((await pick()).status).toBe(303);                  // fixed a typo and tried again
    expect((await pick({ email: 'someone@else.example' })).status).toBe(400);
    // The retry replaced their first hold, so they don't hold two spots.
    const mine = (await store.listSponsorOrders()).filter(o => o.email === 'aero@example.com');
    expect(mine.map(o => o.status).sort()).toEqual(['cancelled', 'pending']);
    expect(expiredSessions).toEqual([sessions[0].id]);

    const weekly = (email) => form({ package: 'weekly', week: '2026-10-19', business: 'W', text: 'x', url: 'w.example', email });
    expect((await weekly('w@x.example')).status).toBe(303);
    expect((await weekly('w@x.example')).status).toBe(303);
    expect((await weekly('z@x.example')).status).toBe(400);
  });

  it('a payment that lands after cancelling is still honored', async () => {
    await startApp();
    await pick();
    const s = sessions[0];
    await fetch(s.params.cancel_url.replace('https://www.thevic361.com', baseUrl));
    await completed(s);
    const order = (await store.listSponsorOrders()).find(o => o.id === s.params.client_reference_id);
    expect(order.status).toBe('paid');
    expect(order.submission_id).toBeTruthy();
  });

  it('a payment after cancelling, once others filled the day, is a conflict, not a fourth pick', async () => {
    const alerts = [];
    await startApp({ slack: { enabled: true, notify: async () => true, alert: async (key, title, text) => { alerts.push({ key, title, text }); } } });
    await paidPick('p1'); await paidPick('p2');
    await pick();
    const s = sessions[0];
    await fetch(s.params.cancel_url.replace('https://www.thevic361.com', baseUrl));
    expect((await pick({ email: 'other@example.com' })).status).toBe(303); // the released spot sells
    await completed(sessions[1]);
    await completed(s);                                     // the first buyer pays in a still-open tab
    const order = (await store.listSponsorOrders()).find(o => o.id === s.params.client_reference_id);
    expect(order.status).toBe('conflict');
    expect(order.submission_id).toBeFalsy();
    expect(alerts.filter(a => a.key === `sponsor-conflict:${order.id}`)).toHaveLength(1);
    const thanks = await (await fetch(`${baseUrl}/advertise/thanks?order=${order.id}`)).text();
    expect(thanks).toContain('Vic’s Pick spots filled up');
  });
});

describe('confirmation email retries', () => {
  it('a confirmation that failed to send is retried on the next webhook; the thank-you page doesn’t claim it was sent', async () => {
    let fail = true;
    const sent = [];
    const resend = { send: async (msg) => { if (fail) throw new Error('resend down'); sent.push(msg); return { id: 'e1' }; }, batch: async () => ({ data: [] }) };
    await startApp({ resendApiKey: 're_test', resend });
    await form({ package: 'weekly', week: '2026-10-19', business: 'Acme', text: 'Hi.', url: 'acme.example', email: 'a@acme.example' });
    await completed(sessions[0]);
    let [order] = await store.listSponsorOrders();
    expect(order.status).toBe('paid');
    expect(order.confirmation_sent).toBeFalsy();
    let thanks = await (await fetch(`${baseUrl}/advertise/thanks?order=${order.id}`)).text();
    expect(thanks).toContain('We’ll email you a confirmation');
    expect(thanks).not.toContain('We’ve emailed you');

    fail = false;
    await completed(sessions[0]);                              // Stripe resends / another event for the order
    [order] = await store.listSponsorOrders();
    expect(order.confirmation_sent).toBeTruthy();
    expect(sent).toHaveLength(1);
    thanks = await (await fetch(`${baseUrl}/advertise/thanks?order=${order.id}`)).text();
    expect(thanks).toContain('We’ve emailed you a confirmation');
    await completed(sessions[0]);
    expect(sent).toHaveLength(1);                              // still only once
  });
});

describe('restoring a hidden sponsorship', () => {
  const pickOrder = (id, status, extra = {}) => store.saveSponsorOrder({ id, kind: 'featured', status, amount: 4900, created_at: NOW.toISOString(),
    event: { date: '2026-10-08', name: `Show ${id}`, time: '7 PM', venue: 'X' }, ...extra });
  const act = async (id, action) => fetch(`${baseUrl}/api/admin/sponsors/${id}`, { method: 'POST', headers: await auth(), body: JSON.stringify({ action }) });

  it('refuses when the day filled up while the pick was hidden', async () => {
    await startApp();
    await pickOrder('a', 'paid'); await pickOrder('b', 'paid'); await pickOrder('c', 'paid');
    expect((await act('a', 'hide')).status).toBe(200);
    await pickOrder('d', 'paid');                               // the freed spot was sold
    const r = await act('a', 'restore');
    expect(r.status).toBe(409);
    expect((await r.json()).message).toContain('already has its 3 Vic’s Picks');
    expect((await store.listSponsorOrders()).find(o => o.id === 'a').status).toBe('hidden');
    await act('d', 'hide');
    expect((await act('a', 'restore')).status).toBe(200);       // room again
  });

  it('refuses when the week was sold while the weekly sponsor was hidden', async () => {
    await startApp();
    const weekly = (id) => store.saveSponsorOrder({ id, kind: 'weekly', status: 'paid', amount: 30000, week_start: '2026-10-19',
      created_at: NOW.toISOString(), business: id, sponsor: { name: id, text: 'x', url: 'https://x.example' } });
    await weekly('w1');
    await act('w1', 'hide');
    await weekly('w2');
    const r = await act('w1', 'restore');
    expect(r.status).toBe(409);
    expect((await r.json()).message).toContain('week of 2026-10-19');
  });
});

describe('sponsor promises (review fixes)', () => {
  const PNG = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]).toString('base64');
  const mailer = () => {
    const sent = [];
    return { sent, resend: { send: async (msg, key) => { sent.push({ ...msg, key }); return { id: 'e' + sent.length }; }, batch: async (msgs) => ({ data: msgs.map(() => ({})) }) } };
  };
  const weeklyOrder = (extra = {}) => ({
    id: 'wk1', kind: 'weekly', status: 'paid', amount: 30000, week_start: '2026-09-28', created_at: '2026-09-20T00:00:00Z',
    business: 'Acme Tacos', email: 'acme@example.com',
    sponsor: { name: 'Acme Tacos', text: 'Best tacos.', cta: 'Order', url: 'https://acme.example', address: '' }, ...extra
  });
  const post = (p, body, headers) => fetch(baseUrl + p, { method: 'POST', headers, body: JSON.stringify(body) });

  it('a Vic’s Pick is promised the newsletter only when its week’s issue is still ahead', () => {
    expect(newsletterCovers('2026-10-10', NOW)).toBe(false);          // this week's issue went out Monday
    expect(newsletterCovers('2026-10-14', NOW)).toBe(true);           // next Monday's issue
    expect(newsletterCovers('2026-10-14', new Date('2026-10-11T18:00:00Z'))).toBe(false); // Sunday: no time to review
    expect(renderPreview('featured', { date: '2026-10-10' }, { now: NOW })).toContain('its newsletter goes out before we could add it');
    expect(renderPreview('featured', { date: '2026-10-14' }, { now: NOW })).toContain('starred in the Monday newsletter for the week of October 12');
    const late = renderSponsorConfirmed({ kind: 'featured', business: 'T', created_at: NOW.toISOString(), event: { name: 'Show', date: '2026-10-10' } }, { siteUrl: 'https://x' });
    expect(late.text).not.toContain('starred in');
    const early = renderSponsorConfirmed({ kind: 'featured', business: 'T', created_at: NOW.toISOString(), event: { name: 'Show', date: '2026-10-14' } }, { siteUrl: 'https://x' });
    expect(early.text).toContain('starred in the Monday newsletter for the week of October 12');
  });

  it('the thank-you page reloads while the webhook is late and explains a double booking', () => {
    const page = (o) => renderThanksPage(o, { siteUrl: 'https://x', now: NOW });
    const fresh = page({ id: 'a', kind: 'weekly', status: 'pending', created_at: new Date(NOW.getTime() - 10000).toISOString() });
    expect(fresh).toContain('location.reload()');
    const stale = page({ id: 'a', kind: 'weekly', status: 'pending', created_at: new Date(NOW.getTime() - 10 * 60000).toISOString() });
    expect(stale).not.toContain('location.reload()');
    expect(stale).toContain('heard back from Stripe');
    const conflict = page({ id: 'a', kind: 'weekly', status: 'conflict', week_start: '2026-10-12', created_at: NOW.toISOString() });
    expect(conflict).toContain('someone else booked that week');
    expect(conflict).toContain('within 1 business day');
  });

  it('?from= fills in contact details only for a pending submission under a week old, and drops the id from the URL', async () => {
    await startApp();
    const row = (id, status, created_at) => store.insert({ id, status, created_at, updated_at: created_at, source: 'submission',
      submitter_name: 'Pat Lee', submitter_email: 'pat@example.com', payload: { name: 'Fall Fest', date: '2026-10-17' } });
    const fresh = '11111111-1111-4111-8111-111111111111';
    const old = '22222222-2222-4222-8222-222222222222';
    const approved = '33333333-3333-4333-8333-333333333333';
    await row(fresh, 'pending', '2026-10-06T00:00:00Z');
    await row(old, 'pending', '2026-09-20T00:00:00Z');
    await row(approved, 'approved', '2026-10-06T00:00:00Z');
    const get = async id => (await fetch(`${baseUrl}/advertise/checkout?package=featured&from=${id}`)).text();
    const f = await get(fresh);
    expect(f).toContain('value="pat@example.com"');
    expect(f).toContain('history.replaceState');
    for (const id of [old, approved]) {
      const p = await get(id);
      expect(p).toContain('value="Fall Fest"');
      expect(p).not.toContain('pat@example.com');
      expect(p).not.toContain('Pat Lee');
    }
  });

  it('the newsletter button counts the click and sends the reader on with UTM tags', async () => {
    await startApp();
    await store.saveSponsorOrder(weeklyOrder({ week_start: '2026-10-05' }));
    const go = (q = '', headers = {}) => fetch(`${baseUrl}/go/s/2026-10-05${q}`, { redirect: 'manual', headers });
    const r = await go('?src=newsletter', { 'User-Agent': 'Mozilla/5.0 (iPhone)' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('https://acme.example/?utm_source=thevic361&utm_medium=email&utm_campaign=newsletter');
    await go('?src=newsletter', { 'User-Agent': 'Googlebot/2.1' });                 // bots aren't counted
    await fetch(`${baseUrl}/go/s/2026-10-05`, { method: 'HEAD', redirect: 'manual' }); // link checkers aren't either
    // The click is recorded without holding up the redirect, so wait for it
    // (a fixed short sleep was flaky on a busy machine).
    const clicks = async () => (await store.listTraffic('2026-01-01')).filter(x => x.path === '/go/s/2026-10-05');
    for (let i = 0; i < 100 && !(await clicks()).length; i++) await new Promise(res => setTimeout(res, 20));
    await new Promise(res => setTimeout(res, 50)); // room for a wrongly counted bot/HEAD row to land
    const rows = await clicks();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'click', click_type: 'sponsor_click', click_url: 'https://acme.example' });
    // No live sponsor that week: home, nothing counted.
    const none = await fetch(`${baseUrl}/go/s/2026-11-30`, { redirect: 'manual' });
    expect(none.headers.get('location')).toBe('https://www.thevic361.com');
    expect(sponsorLandingUrl('https://a.example/?utm_source=own', {})).toBe('https://a.example/?utm_source=own');
  });

  it('counts each person once a day, site and email apart', () => {
    const order = weeklyOrder();
    const rows = [
      { day: '2026-09-29', kind: 'click', click_type: 'sponsor_click', click_url: 'https://acme.example/', path: '/', visitor: 'v1' },
      { day: '2026-09-29', kind: 'click', click_type: 'sponsor_click', click_url: 'https://acme.example', path: '/events/x', visitor: 'v1' },
      { day: '2026-09-30', kind: 'click', click_type: 'sponsor_click', click_url: 'https://acme.example', path: '/', visitor: 'v1' },
      { day: '2026-09-29', kind: 'click', click_type: 'sponsor_click', click_url: 'https://acme.example', path: '/go/s/2026-09-28', visitor: 'v2' },
      { day: '2026-09-29', kind: 'click', click_type: 'sponsor_click', click_url: 'https://other.example', path: '/', visitor: 'v3' },
      { day: '2026-10-05', kind: 'click', click_type: 'sponsor_click', click_url: 'https://acme.example', path: '/', visitor: 'v4' },
      { day: '2026-09-29', kind: 'view', path: '/', visitor: 'v5' }
    ];
    expect(sponsorStats(order, rows, { recipients: 40 })).toMatchObject({
      site_clicks: 3, site_people: 2, email_clicks: 1, email_people: 1, site_visitors: 1, newsletter_recipients: 40
    });
  });

  it('counts site clicks on the utm-tagged button link the site really renders', () => {
    // The button's href is sponsorLinkUrl(url), so the beacon's click_url
    // carries utm_* tags (and maybe a www or trailing slash) the stored URL lacks.
    const order = weeklyOrder();
    const tagged = sponsorLinkUrl(order.sponsor.url);
    expect(tagged).toContain('utm_source=');
    const rows = [
      { day: '2026-09-29', kind: 'click', click_type: 'sponsor_click', click_url: tagged, path: '/', visitor: 'v1' },
      { day: '2026-09-30', kind: 'click', click_type: 'sponsor_click', click_url: 'https://www.acme.example/#top', path: '/', visitor: 'v2' },
      { day: '2026-09-30', kind: 'click', click_type: 'sponsor_click', click_url: 'https://acme.example.evil.test/?utm_source=thevic361', path: '/', visitor: 'v3' },
      { day: '2026-09-30', kind: 'click', click_type: 'sponsor_click', click_url: 'https://acme.example/other-page', path: '/', visitor: 'v4' }
    ];
    expect(sponsorStats(order, rows)).toMatchObject({ site_clicks: 2, site_people: 2 });
  });

  it('the Monday cron emails last week’s sponsor their click report, once', async () => {
    const mail = mailer();
    const pings = [];
    await startApp({ resendApiKey: 're_test', resend: mail.resend, newsletterCronSecret: 'cs', newsletterAddress: '1 Main St',
      slack: { enabled: true, notify: async (m) => { pings.push(m); return true; }, alert: async () => {} } });
    await store.saveSponsorOrder(weeklyOrder());
    await store.saveSponsorOrder(weeklyOrder({ id: 'wk2', week_start: '2026-10-05', business: 'Not Yet', email: 'later@example.com' }));
    await store.recordTraffic({ day: '2026-09-30', kind: 'click', click_type: 'sponsor_click', click_url: 'https://acme.example', path: '/', visitor: 'v1' });
    await store.recordTraffic({ day: '2026-09-28', kind: 'click', click_type: 'sponsor_click', click_url: 'https://acme.example', path: '/go/s/2026-09-28', visitor: 'v2' });
    const cron = async () => (await post('/api/newsletter/cron', {}, { 'Content-Type': 'application/json', 'X-Cron-Secret': 'cs' })).json();
    const first = await cron();
    expect(first.sponsor_reports).toMatchObject({ sent: 1, skipped: 0, failed: 0 });
    const reports = mail.sent.filter(m => m.key && m.key.startsWith('vic361-sponsor-report-'));
    expect(reports).toHaveLength(1);
    expect(reports[0].to).toEqual(['acme@example.com']);
    expect(reports[0].key).toBe('vic361-sponsor-report-wk1');
    expect(reports[0].subject).toBe('Your Vic 361 sponsor week: 2 people clicked');
    expect(reports[0].text).toContain('Clicked your button on thevic361.com: 1 person');
    expect(reports[0].text).toContain('Clicked your button in our emails: 1 person');
    const saved = (await store.listSponsorOrders()).find(o => o.id === 'wk1');
    expect(saved.report_sent).toBeTruthy();
    expect(saved.report).toMatchObject({ site_people: 1, email_people: 1 });
    expect(pings.some(p => p.title.includes('Click report sent'))).toBe(true);
    // A second run (or a daily scheduler) sends nothing more.
    expect((await cron()).sponsor_reports).toMatchObject({ sent: 0, skipped: 0, failed: 0 });
    expect(mail.sent.filter(m => m.key && m.key.startsWith('vic361-sponsor-report-'))).toHaveLength(1);
  });

  it('the admin can edit a weekly sponsor’s wording, link, logo and week, with checkout’s checks', async () => {
    await startApp();
    const h = await auth();
    await store.saveSponsorOrder(weeklyOrder({ id: 'e1', week_start: '2026-10-19' }));
    await store.saveSponsorOrder(weeklyOrder({ id: 'e2', week_start: '2026-10-26', business: 'Other' }));
    const edit = (id, body) => post(`/api/admin/sponsors/${id}`, { action: 'edit', ...body }, h);
    expect((await edit('e1', { url: 'not a url at all' })).status).toBe(400);
    const taken = await edit('e1', { week: '2026-10-26' });
    expect(taken.status).toBe(400);
    expect((await taken.json()).message).toContain('already booked');
    const ok = await edit('e1', { text: '  Now with   queso. ', url: 'acme.example/menu', cta: 'See menu', week: '2026-11-02', logo_data: PNG });
    expect(ok.status).toBe(200);
    const o = (await store.listSponsorOrders()).find(x => x.id === 'e1');
    expect(o.sponsor).toMatchObject({ text: 'Now with queso.', url: 'https://acme.example/menu', cta: 'See menu', logo: '/sponsor-logo/e1' });
    expect(o.week_start).toBe('2026-11-02');
    expect(await store.getSponsorLogo('e1')).toBeTruthy();
    // Vic's Picks are edited in Submissions, not here.
    await store.saveSponsorOrder({ id: 'f1', kind: 'featured', status: 'paid', created_at: NOW.toISOString(), event: { name: 'x', date: '2026-10-10' } });
    expect((await edit('f1', { text: 'x' })).status).toBe(400);
  });

  it('a double-booked sponsor moved to an open week goes live and gets its confirmation', async () => {
    const mail = mailer();
    await startApp({ resendApiKey: 're_test', resend: mail.resend });
    const h = await auth();
    await store.saveSponsorOrder(weeklyOrder({ id: 'c1', status: 'conflict', week_start: '2026-10-19' }));
    const r = await post('/api/admin/sponsors/c1', { action: 'edit', week: '2026-11-09' }, h);
    expect(r.status).toBe(200);
    const o = (await store.listSponsorOrders()).find(x => x.id === 'c1');
    expect(o).toMatchObject({ status: 'paid', week_start: '2026-11-09' });
    expect(o.confirmation_sent).toBeTruthy();
    expect(mail.sent.map(m => m.subject)).toEqual([expect.stringMatching(/week of Nov 9/)]);
  });

  it('admin sponsor routes answer with an error when the database fails, instead of hanging', async () => {
    await startApp();
    const h = await auth();
    store.listSponsorOrders = async () => { throw new Error('db down'); };
    expect((await fetch(baseUrl + '/api/admin/sponsors', { headers: h })).status).toBe(500);
    expect((await post('/api/admin/sponsors/x', { action: 'hide' }, h)).status).toBe(500);
  });
});

describe('selling it on /advertise', () => {
  it('live numbers, both previews per package (site and newsletter), and the FAQ', async () => {
    await startApp();
    const html = await (await fetch(baseUrl + '/advertise')).text();
    expect(html).toContain('class="ad-stats"');
    expect(html).not.toContain('newsletters a week');   // a small number on a sales page undersells
    expect(html.match(/<p class="ad-preview-label">On the site<\/p>/g)).toHaveLength(3);
    expect(html.match(/<p class="ad-preview-label">In the newsletter<\/p>/g)).toHaveLength(3);
    expect(html).toContain('THIS WEEK\'S SPONSOR');
    expect(html.match(/src="\/sample-logo.svg"/g)).toHaveLength(3); // the example logo: the diagram, the site and the email
    expect(html).toContain('★ VIC’S PICK');
    expect(html).toContain('<summary>How fast does it go live?</summary>');
    expect(html).not.toMatch(/\bAI\b|automat/i);
  });

  it('the Vic’s Pick example sits in time order, not on top', async () => {
    const { samplePreviews } = await import('../server/sponsors.js');
    const times = samplePreviews().featured.match(/event-time">[^<]+/g).map(t => t.split('>')[1]);
    expect(times).toEqual(['6:00 PM', '7:00 PM', '8:00 PM']);
    expect(samplePreviews().featured).not.toContain('below yours');
  });

  it('counts this week’s events, venues and nearby towns; subscribers only from 100', async () => {
    const { advertiseStats } = await import('../server/seo.js');
    const now = new Date('2026-10-09T17:00:00Z');
    const evs = [
      { date: '2026-10-09', venue: 'Club' }, { date: '2026-10-10', venue: 'club ' }, { date: '2026-10-11', venue: 'Park', town: 'Cuero' },
      { date: '2026-10-12', venue: 'Next Week' }, { date: '2026-10-04', venue: 'Last Week' }
    ];
    expect(advertiseStats(evs, now, 99)).toEqual({ events: 3, venues: 2, towns: 1, subscribers: null, readers: null });
    expect(advertiseStats(evs, now, 0, 499).readers).toBeNull();
    expect(advertiseStats(evs, now, 0, 3260).readers).toBe(3200);
    expect(advertiseStats(evs, now, 247).subscribers).toBe(240);
  });
});

describe('weekly sponsor on Facebook (and Instagram once a town posts there)', () => {
  afterEach(() => useTown(VICTORIA));
  const weeklyOrder = (extra = {}) => ({
    id: 'wk1', kind: 'weekly', status: 'paid', amount: 30000, week_start: '2026-09-28', created_at: '2026-09-20T00:00:00Z',
    business: 'Acme Tacos', email: 'acme@example.com',
    sponsor: { name: 'Acme Tacos', text: 'Best tacos.', cta: 'Order', url: 'https://acme.example', address: '' }, ...extra
  });
  it('the social link counts apart from email clicks, tagged utm_medium=social, and shows in the report', async () => {
    await startApp();
    await store.saveSponsorOrder(weeklyOrder({ week_start: '2026-10-05' }));
    const r = await fetch(`${baseUrl}/go/s/2026-10-05?src=social`, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 (iPhone)' } });
    expect(r.headers.get('location')).toBe('https://acme.example/?utm_source=thevic361&utm_medium=social&utm_campaign=social');
    const rows = async () => (await store.listTraffic('2026-01-01')).filter(x => String(x.path).startsWith('/go/s/2026-10-05'));
    for (let i = 0; i < 100 && !(await rows()).length; i++) await new Promise(res => setTimeout(res, 20));
    expect((await rows()).map(x => x.path)).toEqual(['/go/s/2026-10-05/social']);
    const stats = sponsorStats(weeklyOrder({ week_start: '2026-10-05' }), await rows());
    expect(stats).toMatchObject({ social_clicks: 1, social_people: 1, email_clicks: 0 });
    const { renderSponsorReport } = await import('../server/notify.js');
    const report = renderSponsorReport(weeklyOrder({ week_start: '2026-10-05' }), { ...stats, site_people: 0, email_people: 0 }, { siteUrl: 'https://www.thevic361.com', address: '1 Main' });
    // No town posts to Instagram yet (town.instagram), so the report doesn't say it.
    expect(report.text).toContain('- Clicked your link in our Facebook posts: 1 person');
    expect(report.text).not.toMatch(/instagram/i);
    expect(report.subject).toBe('Your Vic 361 sponsor week: 1 person clicked');
    useTown({ ...VICTORIA, instagram: 'thevic361' });
    expect(renderSponsorReport(weeklyOrder({ week_start: '2026-10-05' }), { ...stats, site_people: 0, email_people: 0 }, { siteUrl: 'https://www.thevic361.com', address: '1 Main' }).text)
      .toContain('- Clicked your link in our Facebook and Instagram posts: 1 person');
  });

  it('/advertise sells it as a checklist of perks', async () => {
    await startApp();
    const html = await (await fetch(baseUrl + '/advertise')).text();
    expect(html.match(/<p class="ad-checklist-title">What you get<\/p>/g)).toHaveLength(3);
    for (const perk of ['Top of the newsletter', 'Every page of thevic361.com', 'Shout-out on Facebook',
      'Your results report', 'Featured first on Facebook', 'Starred in the newsletter']) {
      expect(html).toContain(`<strong>${perk}</strong>`);
    }
    // Nothing posts to Instagram, so nothing is sold there (the make-good
    // terms would owe it back), on the page or in the advertising terms.
    expect(html).not.toMatch(/instagram/i);
    expect(await (await fetch(baseUrl + '/advertising-terms')).text()).not.toMatch(/on Instagram/);
  });

  it('a town with an Instagram handle sells the Instagram lines', async () => {
    const { AD_PACKAGES } = await import('../server/seo.js');
    useTown({ ...VICTORIA, instagram: 'thevic361' });
    const perks = AD_PACKAGES.flatMap(p => p.points.map(([b]) => b));
    expect(perks).toContain('Shout-out on Instagram');
    expect(perks).toContain('Featured first on Instagram');
  });
});

describe('where your ad goes', () => {
  afterEach(() => useTown(VICTORIA));
  it('shows the ad with arrows to the site, newsletter and Facebook', async () => {
    const { adFlowHtml } = await import('../server/seo.js');
    const html = adFlowHtml();
    for (const name of ['thevic361.com', 'The newsletter', 'Facebook']) expect(html).toContain(`<strong>${name}</strong>`);
    expect(html).not.toContain('Instagram');
    expect(html.match(/<path d="M6 118 C/g)).toHaveLength(3); // one arrow per channel, from the middle of 236px
    expect(html).toContain('viewBox="0 0 140 236"');
    expect(html).toContain('class="ad-flow__down"');            // phones: one arrow down
  });
  it('adds Instagram for a town that posts there', async () => {
    const { adFlowHtml } = await import('../server/seo.js');
    useTown({ ...VICTORIA, instagram: 'thevic361' });
    const html = adFlowHtml();
    expect(html).toContain('<strong>Instagram</strong>');
    expect(html.match(/<path d="M6 160 C/g)).toHaveLength(4);
    expect(html).toContain('viewBox="0 0 140 320"');
  });
});

describe('towns sharing one Stripe account (MULTI_CITY_PLAN.md 2.2)', () => {
  const BAY = { id: 'bay', siteName: 'The Bay 979', domain: 'thebay979.com', city: 'Bay City', state: 'TX', stateName: 'Texas', timezone: 'America/Chicago' };
  const weekly = () => form({ package: 'weekly', week: '2026-10-12', business: 'Acme', text: 'Hi.', url: 'acme.example', email: 'a@acme.example' });
  const status = async () => (await store.listSponsorOrders())[0].status;
  const fraud = () => webhook({ type: 'radar.early_fraud_warning.created', data: { object: { id: 'issfr_1', payment_intent: 'pi_elsewhere' } } });
  const slackFake = alerts => ({ enabled: true, notify: async () => true, alert: async (...a) => { alerts.push(a); } });
  afterEach(() => useTown(VICTORIA));

  it("Victoria's sessions are tagged victoria; it skips events tagged for another town", async () => {
    const alerts = [];
    await startApp({ slack: slackFake(alerts) });
    await weekly();
    const s = sessions[0];
    const id = s.params.client_reference_id;
    expect(s.params.metadata).toEqual({ order_id: id, package: 'weekly', terms_version: ADVERTISING_TERMS_VERSION, terms_accepted_at: expect.any(String), town: 'victoria' });
    expect(s.params.payment_intent_data).toEqual({ metadata: { order_id: id, town: 'victoria' }, statement_descriptor_suffix: 'VIC 361' });
    await completed(s, { metadata: { town: 'bay' } });
    expect(await status()).toBe('pending');
    await completed(s); // untagged: from before towns, so Victoria's
    expect(await status()).toBe('paid');
    await fraud(); // no order matches: Victoria still hears about it
    expect(alerts).toHaveLength(1);
  });

  it("another town handles only its own tagged events and its own orders' warnings", async () => {
    const alerts = [];
    await startApp({ town: BAY, siteUrl: 'https://www.thebay979.com', slack: slackFake(alerts) });
    await weekly();
    const s = sessions[0];
    const id = s.params.client_reference_id;
    expect(s.params.metadata).toEqual({ order_id: id, package: 'weekly', terms_version: ADVERTISING_TERMS_VERSION, terms_accepted_at: expect.any(String), town: 'bay' });
    expect(s.params.payment_intent_data).toEqual({ metadata: { order_id: id, town: 'bay' }, statement_descriptor_suffix: 'BAY 979' });
    expect(s.key).toBe(`bay-order-${id}`);
    await completed(s); // untagged = Victoria's
    await completed(s, { metadata: { town: 'victoria' } });
    expect(await status()).toBe('pending');
    await completed(s, { metadata: { town: 'bay' } });
    expect(await status()).toBe('paid');
    await fraud();
    expect(alerts).toEqual([]);
  });

  it("statementSuffix keeps each town inside Stripe's descriptor limits", () => {
    expect(statementSuffix('The Vic 361')).toBe('VIC 361');
    expect(statementSuffix('Shoals Setlist')).toBe('SHOALS');     // cut at a word
    expect(statementSuffix('Tupelo Current')).toBe('TUPELO');
    expect(statementSuffix('Abcdefghijklmn')).toBe('ABCDEFGHIJ'); // one long word: cut
    expect(statementSuffix('The "Bay" <979>*')).toBe('BAY 979');  // characters Stripe refuses dropped
    expect(statementSuffix('The 361')).toBeUndefined();           // Stripe needs a letter
    for (const name of ['The Crane 308', 'The Star 402', 'The Rogue 541', 'The Tide 757']) {
      expect(statementSuffix(name).length).toBeLessThanOrEqual(10);
    }
  });

  it("skips another town's subscription events", async () => {
    await startApp();
    await store.saveSponsorOrder({ id: 'old-partner', kind: 'partner', status: 'active', venue_slug: 'aero-crafters',
      venue_name: 'Aero Crafters', business: 'Aero Crafters', email: 'aero@example.com', amount: 15000,
      subscription_id: 'sub_123', created_at: '2026-09-01T00:00:00Z' });
    const cancel = metadata => webhook({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_123', status: 'canceled', metadata } } });
    await cancel({ town: 'bay' });
    expect(await status()).toBe('active');
    await cancel({});
    expect(await status()).toBe('cancelled');
  });
});
