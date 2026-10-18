// @vitest-environment node
//
// Category partners (server/partners.js, sponsors.js kind 'category'): one
// local business per category per town, monthly, approved by the owner
// before it shows anywhere. Stripe is a recording fake and webhooks are
// signed locally; nothing is charged.

import { describe, it, expect, afterEach, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { townConfig, useTown, VICTORIA } from '../server/town.js';
import {
  partnerCategories, categoriesForPage, partnersPayload, partnerState, partnerBoxHtml, renderPartnersPage, partnerSummary,
  manageToken, manageOk, takesCategory, openCategories
} from '../server/partners.js';
import { partnerStats } from '../server/sponsors.js';
import { renderWeekly } from '../server/newsletter.js';
import { monthRevenue } from '../server/growth.js';
import {
  renderPartnerReceived, renderPartnerLive, renderPartnerRejected, renderPartnerCanceled, renderPartnerReport
} from '../server/notify.js';

const NOW = new Date('2026-10-07T15:00:00Z'); // Wed Oct 7
const WHSEC = 'whsec_test';
const SITE = 'https://www.thevic361.com';
const HQK = 'hq-reply-key-0123456789-0123456789-abc';
const EVENTS = [
  { date: '2026-10-09', name: 'Friday Live Music', time: '8:00 PM', venue: 'Aero Crafters', icons: ['music', 'drinks'] },
  { date: '2026-10-10', name: 'Taco Fest', time: '11:00 AM', venue: 'De Leon Plaza', icons: ['food'] },
  { date: '2026-10-11', name: 'Kids Craft Hour', time: '10:00 AM', venue: 'Library', icons: ['family'] }
];

afterAll(() => useTown(VICTORIA));

// A price anywhere it must not be: "$99", "99/mo", "per month".
const PRICE = /\$\s?\d|\/\s?mo\b|per month/i;

// ─── Pure helpers ────────────────────────────────────────────────────────

describe('categories and state', () => {
  it('has the ten default categories, with pages only where the site has them', () => {
    useTown(VICTORIA);
    const cats = partnerCategories();
    expect(cats.map(c => c.id)).toEqual(['food', 'realestate', 'dental', 'home', 'pets', 'auto', 'fitness', 'family', 'insurance', 'legal']);
    expect(cats.find(c => c.id === 'food').pages).toEqual(['/food-and-drink', '/date-night']);
    expect(cats.find(c => c.id === 'family').pages).toEqual(['/kids-and-family', '/this-weekend-with-kids']);
    expect(cats.find(c => c.id === 'dental').pages).toEqual([]);
    expect(categoriesForPage('/outdoor-events').map(c => c.id)).toEqual(['fitness']);
    expect(VICTORIA.business.partnerAmount).toBe(9900);
  });

  it('a town can set its own price and categories, and bad ones stop the boot', () => {
    const t = townConfig({}, { town: { id: 'bay', siteName: 'The Bay 979', domain: 'thebay979.com', city: 'Bay City', state: 'TX', stateName: 'Texas', timezone: 'America/Chicago',
      business: { partnerAmount: 7900, partnerCategories: [{ id: 'food', label: 'Food & drink', emoji: '🍽️', owner: 'a restaurant', pages: ['/food-and-drink', '/no-such-page'] }] } } });
    useTown(t);
    try {
      expect(t.business.partnerAmount).toBe(7900);
      expect(partnerCategories()).toEqual([{ id: 'food', label: 'Food & drink', emoji: '🍽️', owner: 'a restaurant', pages: ['/food-and-drink'] }]);
    } finally { useTown(VICTORIA); }
    const bad = cats => () => townConfig({}, { town: { id: 'bay', siteName: 'B', domain: 'b.com', city: 'B', state: 'TX', stateName: 'Texas', timezone: 'America/Chicago', business: { partnerCategories: cats } } });
    expect(bad([])).toThrow(/partnerCategories/);
    expect(bad([{ id: 'a', label: 'x', emoji: '', owner: 'y', pages: [] }])).toThrow(/partnerCategories/);   // id too short
    expect(bad([{ id: 'food', label: '<b>', emoji: '', owner: 'y', pages: [] }])).toThrow(/partnerCategories/);
  });

  it('a category is taken by every order that hasn’t ended, and a checkout only while held', () => {
    useTown(VICTORIA);
    const o = (status, extra = {}) => ({ id: status, kind: 'category', category: 'food', status, email: 'a@x.com', ...extra });
    for (const s of ['pending_approval', 'active', 'past_due', 'hidden', 'processing', 'disputed']) expect(takesCategory(o(s))).toBe(true);
    for (const s of ['rejected', 'canceled', 'expired', 'failed', 'cancelled', 'refunded', 'conflict']) expect(takesCategory(o(s))).toBe(false);
    expect(takesCategory(o('pending'), () => true)).toBe(true);
    expect(takesCategory(o('pending'), () => false)).toBe(false);
    expect(takesCategory(o('pending'), () => true, 'a@x.com')).toBe(false);   // their own hold
    expect(openCategories([o('active'), o('rejected', { category: 'dental' })])).not.toContain('food');
    expect(openCategories([o('active'), o('rejected', { category: 'dental' })])).toContain('dental');
  });

  it('payload: nothing until a category order exists; live partners only, public fields only', () => {
    useTown(VICTORIA);
    expect(partnersPayload([{ kind: 'weekly', status: 'paid' }])).toBeNull();
    const p = partnersPayload([
      { id: 'o-dental-000001', kind: 'category', category: 'dental', status: 'active', email: 'd@x.com', amount: 9900, partner: { name: 'Smile', line: 'Hi', cta: 'Book', url: 'https://smile.example', logo: '/sponsor-logo/o-dental-000001' } },
      { id: 'o-food-0000001', kind: 'category', category: 'food', status: 'pending_approval', email: 'f@x.com', partner: { name: 'Tacos', line: 'Yum', url: 'https://t.example' } }
    ]);
    expect(p.active).toEqual([{ id: 'o-dental-000001', category: 'dental', label: 'Dental', emoji: '🦷', name: 'Smile', line: 'Hi', cta: 'Book', logo: '/sponsor-logo/o-dental-000001' }]);
    expect(p.open).not.toContain('food');
    expect(p.open).not.toContain('dental');
    expect(p.open).toHaveLength(8);
    expect(JSON.stringify(p)).not.toMatch(/x\.com|9900|smile\.example/);
    expect(partnerState({})).toEqual({ active: [], open: partnerCategories().map(c => c.id) });
  });

  it('a paused town shows none of it', () => {
    useTown(townConfig({ TOWN_DORMANT: '1' }));
    try {
      expect(partnerState({})).toBeNull();
      expect(partnersPayload([{ id: 'x', kind: 'category', category: 'food', status: 'active' }])).toBeNull();
      expect(partnerBoxHtml('/food-and-drink', partnerState({}))).toBe('');
    } finally { useTown(VICTORIA); }
  });

  it('category box: the live partner, an invite while open, nothing while it waits; never a price', () => {
    useTown(VICTORIA);
    const live = { active: [{ id: 'o-food-0000001', category: 'food', label: 'Food & drink', emoji: '🍽️', name: 'Mesquite Smokehouse', line: 'Brisket Fridays.', cta: 'See the menu' }], open: [] };
    const box = partnerBoxHtml('/food-and-drink', live, SITE);
    expect(box).toContain('Our food &amp; drink partner');
    expect(box).toContain('data-ad="o-food-0000001"');
    expect(box).toContain(`href="${SITE}/go/p/o-food-0000001?src=site"`);
    expect(box).toContain('rel="sponsored noopener"');
    const invite = partnerBoxHtml('/food-and-drink', { active: [], open: ['food'] }, SITE);
    expect(invite).toContain('Own a restaurant or bar?');
    expect(invite).toContain('Be our food &amp; drink partner.');
    expect(invite).toContain('href="/advertise#partner"');
    expect(partnerBoxHtml('/food-and-drink', { active: [], open: [] }, SITE)).toBe('');
    expect(partnerBoxHtml('/live-music', { active: [], open: ['food'] }, SITE)).toBe('');
    for (const html of [box, invite]) expect(html).not.toMatch(PRICE);
  });

  it('/partners: cards and open categories, or the founding invite; never a price', () => {
    useTown(VICTORIA);
    const empty = renderPartnersPage({ siteUrl: SITE, state: partnerState({}) });
    expect(empty).toContain('Founding partner');
    expect(empty).toContain('All 10 categories are open');
    expect(empty).toContain('href="/advertise#partner"');
    expect(empty).toContain('Pricing and sign-up are on our Advertise page');
    const full = renderPartnersPage({ siteUrl: SITE, state: { active: [{ id: 'o-food-0000001', category: 'food', label: 'Food & drink', emoji: '🍽️', name: 'Mesquite', line: 'Brisket.', cta: 'Menu' }], open: ['legal'] } });
    expect(full).toContain('<h2 class="partner-card__name">Mesquite</h2>');
    expect(full).toContain(`${SITE}/go/p/o-food-0000001?src=partners`);
    expect(full).toContain('Become a partner');
    expect(full).toContain('Open categories');
    expect(full).toContain('⚖️ Legal');
    for (const html of [empty, full]) expect(html.replace(/<script[\s\S]*?<\/script>/g, '')).not.toMatch(PRICE);
  });

  it('newsletter: partner cards with a tracked link and an open-categories line, or the founding invite', () => {
    useTown(VICTORIA);
    const now = new Date('2026-10-05T12:43:00Z');
    const state = { active: [
      { id: 'o-food-0000001', category: 'food', label: 'Food & drink', emoji: '🍽️', name: 'Mesquite', line: 'Brisket.', cta: 'See the menu' },
      { id: 'o-dent-0000001', category: 'dental', label: 'Dental', emoji: '🦷', name: 'Smile', line: 'New patients.', cta: 'Book' },
      { id: 'o-auto-0000001', category: 'auto', label: 'Auto', emoji: '🚗', name: 'Navarro Auto', line: 'Oil change.', cta: 'Specials' }], open: ['legal', 'pets'] };
    for (const edition of ['weekly', 'weekend']) {
      const issue = renderWeekly(EVENTS, { siteUrl: SITE, now, partners: state, unsubscribeUrl: '#', edition });
      expect(issue.html).toContain('OUR LOCAL PARTNERS');
      expect(issue.html).toContain(`${SITE}/go/p/o-food-0000001?src=newsletter`);
      expect(issue.html).toContain('2 categories open');
      expect(issue.html).toContain('Become a partner');
      expect(issue.html.indexOf('OUR LOCAL PARTNERS')).toBeGreaterThan(issue.html.indexOf(edition === 'weekly' ? 'See the full list' : 'See the whole weekend'));
      expect(issue.text).toContain(`- Food & drink: Mesquite. Brisket. ${SITE}/go/p/o-food-0000001?src=newsletter`);
      expect(issue.text).toContain('Become a partner (2 categories open)');
      expect(issue.html).not.toMatch(/\$\d/);
      expect(issue.text).not.toMatch(/\$\d/);
    }
    const none = renderWeekly(EVENTS, { siteUrl: SITE, now, unsubscribeUrl: '#' });
    expect(none.html).toContain('FOUNDING PARTNERS WANTED');
    expect(none.html).toContain('Claim your category →');
    expect(none.html).toContain('⚖️ Legal');
    expect(none.text).toContain('FOUNDING PARTNERS WANTED');
    const full = renderWeekly(EVENTS, { siteUrl: SITE, now, partners: { active: state.active, open: [] }, unsubscribeUrl: '#' });
    expect(full.html).not.toContain('Become a partner');
  });

  it('partner emails name the category, carry the manage link while there’s one, and never a price', () => {
    useTown(VICTORIA);
    const order = { id: 'o-1', kind: 'category', category: 'food', business: 'Mesquite', email: 'm@x.com', amount: 9900,
      partner: { name: 'Mesquite', line: 'Brisket.', cta: 'Menu', url: 'https://m.example' } };
    const manage = `${SITE}/partners/manage?o=o-1&t=abc`;
    const mails = [
      renderPartnerReceived(order, { siteUrl: SITE, manageUrl: manage }),
      renderPartnerLive(order, { siteUrl: SITE, manageUrl: manage }),
      renderPartnerRejected(order, { siteUrl: SITE, manageUrl: manage, reason: 'We already list a similar business.' }),
      renderPartnerCanceled(order, { siteUrl: SITE, manageUrl: manage }),
      renderPartnerReport(order, { start: '2026-09-07', end: '2026-10-06', views: 120, click_people: 9, newsletter_people: 5, site_people: 4, social_people: 1, newsletter_recipients: 900, newsletter_issues: 8, where: [] }, { siteUrl: SITE, manageUrl: manage })
    ];
    expect(mails[0].subject).toBe('You’re in: we’ll review your listing shortly');
    expect(mails[1].subject).toBe('You’re live on The Vic 361');
    expect(mails[1].text).toContain(`${SITE}/food-and-drink`);
    expect(mails[1].text).toContain(`${SITE}/partners`);
    expect(mails[2].text).toContain('We already list a similar business.');
    expect(mails[2].text).toContain('refunded your payment in full');
    expect(mails[4].text).toContain('9 people clicked through');
    // A rejected or ended partnership has nothing left to manage.
    for (const [i, m] of mails.entries()) {
      expect(m.text.includes(manage)).toBe(i !== 2 && i !== 3);
      expect(m.html.includes(manage.replace(/&/g, '&amp;'))).toBe(i !== 2 && i !== 3);
      expect(m.subject + m.text + m.html).not.toMatch(/\$\d/);
      expect(m.subject + m.text).not.toMatch(/—/);
    }
  });

  it('report stats: views from impressions, clicks by where they were tapped', () => {
    const order = { id: 'o-food-0000001' };
    const rows = [
      { day: '2026-10-01', kind: 'impression', ad: 'o-food-0000001', path: '/food-and-drink', visitor: 'a' },
      { day: '2026-10-01', kind: 'impression', ad: 'o-food-0000001', path: '/partners', visitor: 'b' },
      { day: '2026-10-02', kind: 'click', click_type: 'partner_click', path: '/go/p/o-food-0000001/newsletter', visitor: 'a' },
      { day: '2026-10-02', kind: 'click', click_type: 'partner_click', path: '/go/p/o-food-0000001/site', visitor: 'c' },
      { day: '2026-10-03', kind: 'click', click_type: 'partner_click', path: '/go/p/o-food-0000001/social', visitor: 'd' },
      { day: '2026-10-03', kind: 'click', click_type: 'partner_click', path: '/go/p/other-order-1/site', visitor: 'e' },
      { day: '2026-09-01', kind: 'impression', ad: 'o-food-0000001', path: '/', visitor: 'z' }
    ];
    const s = partnerStats(order, rows, { start: '2026-09-07', end: '2026-10-06', recipients: 300, issues: 2 });
    expect(s).toMatchObject({ views: 2, clicks: 3, click_people: 3, newsletter_people: 1, site_people: 1, social_people: 1, newsletter_recipients: 300, newsletter_issues: 2 });
  });

  it('HQ summary and revenue count live partners', () => {
    const orders = [
      { kind: 'category', status: 'active', category: 'food', amount: 9900, paid_at: '2026-08-02T12:00:00Z' },
      { kind: 'category', status: 'active', category: 'auto', amount: 9900, paid_at: '2026-08-02T12:00:00Z', test: true },
      { kind: 'category', status: 'pending_approval', category: 'dental', amount: 9900, paid_at: '2026-10-02T12:00:00Z' },
      { kind: 'category', status: 'rejected', category: 'legal', amount: 9900, paid_at: '2026-10-02T12:00:00Z' }
    ];
    const s = partnerSummary(orders);
    expect(s).toMatchObject({ active: 1, pending: 1, monthly_cents: 9900 });
    expect(s.open_categories).not.toContain('food');
    expect(s.open_categories).not.toContain('dental');
    expect(s.open_categories).toContain('legal');
    const r = monthRevenue(orders, '2026-10-07');
    expect(r).toMatchObject({ recurring_cents: 9900, cents: 19800 });   // food renews; dental paid this month
  });

  it('manage tokens are per town and order', () => {
    useTown(VICTORIA);
    const t = manageToken('s3cret', 'o-1');
    expect(manageOk('s3cret', 'o-1', t)).toBe(true);
    expect(manageOk('s3cret', 'o-2', t)).toBe(false);
    expect(manageOk('other', 'o-1', t)).toBe(false);
    expect(manageOk('', 'o-1', t)).toBe(false);
  });
});

// ─── The whole flow through the app ──────────────────────────────────────

let tmpDir, server, baseUrl, store, sessions, stripeCalls, slackPings, sent, app;

function fakeStripe({ portalFails = false, refundFails = false } = {}) {
  sessions = [];
  stripeCalls = [];
  return {
    createCheckoutSession: async (params, key) => {
      const id = `cs_test_${sessions.length + 1}`;
      sessions.push({ params, key, id });
      return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
    },
    expireCheckoutSession: async (id) => ({ id }),
    cancelSubscription: async (id) => { stripeCalls.push(['cancel', id]); return { id, status: 'canceled' }; },
    invoicePayment: async (inv) => { stripeCalls.push(['invoice', inv]); return { payment_intent: `pi_for_${inv}` }; },
    refund: async (target, key) => {
      stripeCalls.push(['refund', target, key]);
      if (refundFails) throw Object.assign(new Error('This key lacks Refunds write'), { status: 403 });
      return { id: 're_1' };
    },
    createPortalSession: async (customer, ret) => {
      stripeCalls.push(['portal', customer, ret]);
      if (portalFails) throw Object.assign(new Error('No configuration provided and your default configuration has not been created.'), { status: 400 });
      return { url: 'https://billing.stripe.com/p/session/test_1' };
    }
  };
}

async function startApp({ stripe = {}, ...extra } = {}) {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-partners-'));
  const eventsFile = path.join(tmpDir, 'events.json');
  await fs.writeFile(eventsFile, JSON.stringify({ events: EVENTS }));
  store = new FileStore(path.join(tmpDir, 's.json'));
  slackPings = [];
  sent = [];
  const out = await createApp({
    storeBundle: { kind: 'file', store }, eventsFile, trustProxy: 1, now: () => NOW,
    siteUrl: SITE, adminUsername: 'a', adminPassword: 'b', adminSessionSecret: 'c', hqReplyKey: HQK, hqApiKey: 'hq-api-key-0123456789-0123456789-zz',
    stripeSecretKey: 'sk_test', stripeWebhookSecret: WHSEC, stripe: fakeStripe(stripe), partnerManageSecret: 'manage-secret',
    resendApiKey: 're_test', newsletterAddress: '1 Main St',
    resend: { send: async (m) => { sent.push(m); return { id: 'e1' }; }, batch: async msgs => ({ data: msgs.map(() => ({ id: 'x' })) }) },
    slack: { enabled: true, notify: async (m) => { slackPings.push({ type: 'notify', ...m }); return true; }, alert: async (key, title, text) => { slackPings.push({ type: 'alert', key, title, text }); return true; } },
    ...extra
  });
  app = out;
  server = http.createServer(out.app);
  await new Promise(r => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

afterEach(async () => {
  useTown(VICTORIA);
  if (server) await new Promise(r => server.close(r));
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  server = null; tmpDir = null;
});

const ipOf = email => { const h = crypto.createHash('sha256').update(String(email)).digest(); return `10.1.${h[0]}.${h[1]}`; };
const claim = (fields) => fetch(baseUrl + '/advertise/checkout', {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': ipOf(fields.email) },
  body: new URLSearchParams({ package: 'category', agree: '1', ...fields }).toString()
});
const FOOD = { category: 'food', business: 'Mesquite Smokehouse', line: 'Brisket Fridays. Kids eat free on Tuesdays.', url: 'mesquite.example', cta: 'See the menu', email: 'owner@mesquite.example' };

function webhook(event) {
  const raw = JSON.stringify({ created: Math.floor(NOW.getTime() / 1000), livemode: true, ...event });
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', WHSEC).update(`${t}.${raw}`).digest('hex');
  return fetch(baseUrl + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${sig}` }, body: raw });
}
const paid = (s, extra = {}) => webhook({ type: 'checkout.session.completed', data: { object: {
  id: s.id, client_reference_id: s.params.client_reference_id, payment_status: 'paid', amount_total: 9900, subscription: `sub_${s.id}`, customer: `cus_${s.id}`,
  invoice: `in_${s.id}`, metadata: s.params.metadata, ...extra } } });

async function auth() {
  const r = await fetch(baseUrl + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'a', password: 'b' }) });
  return { Authorization: `Bearer ${(await r.json()).token}`, 'Content-Type': 'application/json' };
}
const act = async (id, body, headers) => fetch(`${baseUrl}/api/admin/sponsors/${id}`, { method: 'POST', headers: headers || await auth(), body: JSON.stringify(body) });
const page = async p => (await fetch(baseUrl + p)).text();
const orderOf = async id => (await store.listSponsorOrders()).find(o => o.id === id);
const visible = html => html.replace(/<script[\s\S]*?<\/script>/g, '');

async function buyFood() {
  const r = await claim(FOOD);
  expect(r.status).toBe(303);
  const s = sessions[sessions.length - 1];
  expect((await paid(s)).status).toBe(200);
  return { s, id: s.params.client_reference_id };
}

describe('selling it', () => {
  it('/advertise sells it at #partner with its price, checklist and open categories', async () => {
    await startApp();
    const html = await page('/advertise');
    const sec = html.slice(html.indexOf('id="partner"'));
    expect(html).toContain('<section class="ad-package ad-package--row" id="partner">');
    expect(sec).toContain('<h2>Category partner</h2>');
    expect(sec).toContain('$99 / month');
    expect(sec).toContain('One business per category. Cancel anytime.');
    for (const b of ['Every issue', 'Your category&#39;s pages', 'Our partners page', 'A monthly Facebook thank-you', 'No competitors', 'A monthly results report']) {
      expect(sec).toContain(b);
    }
    expect(sec).toContain('Open now: Food &amp; drink · Real estate');
    expect(sec).toContain('href="/advertise/checkout?package=category">Claim a category →');
    expect(sec).not.toMatch(/instagram/i);
  });

  it('checkout: an open category, the card and box preview, a monthly subscription with the town’s tags', async () => {
    await startApp();
    const form = await page('/advertise/checkout?package=category&category=dental');
    expect(form).toContain('<option value="dental" selected>🦷 Dental</option>');
    expect(form).toContain('Your line');
    expect(form).toContain('class="sponsor-block partner-box"');
    expect(form).toContain('Advertising Terms');
    const preview = await (await fetch(baseUrl + '/advertise/preview', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ package: 'category', category: 'pets', business: 'Bayou Paws', line: 'Grooming.' }).toString() })).text();
    expect(preview).toContain('Our pets partner');
    expect(preview).toContain('Bayou Paws');

    const bad = await claim({ ...FOOD, line: '' });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('Add one short line');

    const r = await claim(FOOD);
    expect(r.status).toBe(303);
    const s = sessions[0];
    expect(s.params.mode).toBe('subscription');
    expect(s.params.line_items[0].price_data).toMatchObject({ unit_amount: 9900, recurring: { interval: 'month' } });
    expect(s.params.metadata).toMatchObject({ package: 'category', category: 'food', town: 'victoria', order_id: s.params.client_reference_id });
    expect(s.params.subscription_data.metadata).toMatchObject({ category: 'food', town: 'victoria', order_id: s.params.client_reference_id });
    expect(s.params.payment_intent_data).toBeUndefined();
    const o = await orderOf(s.params.client_reference_id);
    expect(o).toMatchObject({ kind: 'category', category: 'food', status: 'pending', amount: 9900,
      partner: { name: 'Mesquite Smokehouse', line: FOOD.line, cta: 'See the menu', url: 'https://mesquite.example' } });

    // Held while they pay: someone else can't claim it, the form shows it taken.
    const other = await claim({ ...FOOD, business: 'Other BBQ', email: 'other@bbq.example' });
    expect(other.status).toBe(400);
    expect(await other.text()).toContain('Food &amp; drink was just taken');
    expect(await page('/advertise/checkout?package=category')).toContain('<option value="food" disabled>🍽️ Food &amp; drink (taken)</option>');
  });
});

describe('after payment: waiting for the owner', () => {
  it('is pending approval, shows nowhere, pings sales and the owner inbox, and emails the buyer', async () => {
    await startApp();
    const { id } = await buyFood();
    const o = await orderOf(id);
    expect(o).toMatchObject({ status: 'pending_approval', subscription_id: 'sub_cs_test_1', customer_id: 'cus_cs_test_1', first_invoice: 'in_cs_test_1' });
    const ping = slackPings.find(p => /New partner waiting for your OK/.test(p.title || ''));
    expect(ping).toMatchObject({ channel: 'sales', title: '🤝 New partner waiting for your OK: Mesquite Smokehouse, Food & drink', link: `${SITE}/admin.html` });
    const inbox = await store.listInboxEvents(0, 50);
    expect(inbox.find(e => /New partner waiting/.test(e.title))).toMatchObject({ severity: 'today' });
    // Not live: no box, no invite either (it's taken), not on /partners.
    const food = await page('/food-and-drink');
    expect(food).not.toContain('Mesquite');
    expect(food).not.toContain('partner-invite');
    expect(await page('/partners')).not.toContain('Mesquite');
    const feed = await (await fetch(baseUrl + '/events.json')).json();
    expect(feed.partners.active).toEqual([]);
    expect(feed.partners.open).not.toContain('food');
    // The "you're in" email (sent after the webhook).
    for (let i = 0; i < 50 && !sent.some(m => /You’re in/.test(m.subject)); i++) await new Promise(r => setTimeout(r, 10));
    const mail = sent.find(m => /You’re in/.test(m.subject));
    expect(mail.to).toEqual(['owner@mesquite.example']);
    expect(mail.text).toContain(`${SITE}/partners/manage?o=${id}&t=`);
    expect(mail.text + mail.html).not.toMatch(/\$\d/);
    expect(visible(await page(`/advertise/thanks?order=${id}`))).toContain('while we review your listing');
  });

  it('a second buyer whose payment lands on a category already taken is double-booked, not live', async () => {
    await startApp();
    await claim(FOOD);
    await claim({ ...FOOD, email: 'late@bbq.example', business: 'Late BBQ', category: 'dental' });
    const [first, second] = sessions;
    await paid(first);
    // Pretend the second checkout was for food too (its hold lapsed).
    const o2 = await orderOf(second.params.client_reference_id);
    await store.saveSponsorOrder({ ...o2, category: 'food' });
    await paid(second);
    expect((await orderOf(second.params.client_reference_id)).status).toBe('conflict');
    expect(slackPings.some(p => p.type === 'notify' && p.channel === 'sales' && /paid for twice/.test(p.title))).toBe(true);
  });
});

describe('approval', () => {
  it('approve puts it live everywhere with tracked links, and emails "you’re live"', async () => {
    await startApp();
    const { id } = await buyFood();
    const r = await act(id, { action: 'approve' });
    expect(r.status).toBe(200);
    expect(await orderOf(id)).toMatchObject({ status: 'active', approved_via: 'admin' });
    const food = await page('/food-and-drink');
    expect(food).toContain('Our food &amp; drink partner');
    expect(food).toContain(`data-ad="${id}"`);
    expect(food.lastIndexOf('day-section')).toBeLessThan(food.indexOf('partner-box'));   // at the bottom: the week's sponsor keeps the top
    expect(await page('/date-night')).toContain('Mesquite Smokehouse');
    expect(await page('/kids-and-family')).toContain('Own a business for families?');
    expect(await page('/live-music')).not.toContain('partner-');
    const partners = await page('/partners');
    expect(partners).toContain('Mesquite Smokehouse');
    expect(partners).toContain(`/go/p/${id}?src=partners`);
    for (const p of ['/partners', '/food-and-drink', '/kids-and-family']) expect(visible(await page(p))).not.toMatch(/\$\s?\d/);
    // Newsletter preview: the partner card, tracked.
    const issue = await (await fetch(baseUrl + '/api/admin/newsletter/preview', { headers: await auth() })).text();
    expect(issue).toContain('OUR LOCAL PARTNERS');
    expect(issue).toContain(`/go/p/${id}?src=newsletter`);
    expect(issue).toContain('9 categories open');
    expect(sent.find(m => /You’re live/.test(m.subject)).text).toContain(`${SITE}/food-and-drink`);
    // Approving twice is fine; approving a rejected one isn't.
    expect((await act(id, { action: 'approve' })).status).toBe(200);
    // Sitemap and footer have the page.
    expect(await page('/sitemap.xml')).toContain(`${SITE}/partners`);
    expect(await page('/about')).toContain('<a href="/partners">Our partners</a>');
  });

  it('HQ can approve and reject with the reply key, but nothing else new', async () => {
    await startApp();
    const { id } = await buyFood();
    const hq = { Authorization: `Bearer ${HQK}`, 'Content-Type': 'application/json' };
    expect((await fetch(`${baseUrl}/api/admin/sponsors/${id}`, { method: 'POST', headers: hq, body: JSON.stringify({ action: 'approve' }) })).status).toBe(401);
    const list = await (await fetch(`${baseUrl}/api/hq/admin/partners`, { headers: hq })).json();
    expect(list.waiting.map(w => w.id)).toEqual([id]);
    expect(list.categories.find(c => c.id === 'food')).toMatchObject({ open: false, holder: { id, status: 'pending_approval' } });
    expect((await fetch(`${baseUrl}/api/hq/admin/sponsors/${id}`, { method: 'POST', headers: hq, body: JSON.stringify({ action: 'edit', line: 'x' }) })).status).toBe(403);
    const r = await fetch(`${baseUrl}/api/hq/admin/sponsors/${id}`, { method: 'POST', headers: hq, body: JSON.stringify({ action: 'approve' }) });
    expect(await r.json()).toMatchObject({ ok: true, status: 'active' });
    expect((await orderOf(id)).approved_via).toBe('hq');
  });

  it('reject cancels the subscription, refunds its payment, emails a polite no and reopens the category', async () => {
    await startApp();
    const { id } = await buyFood();
    const r = await act(id, { action: 'reject', reason: 'We already list a similar business.' });
    expect(await r.json()).toMatchObject({ ok: true, status: 'rejected', refunded: true });
    expect(stripeCalls).toEqual([['cancel', 'sub_cs_test_1'], ['invoice', 'in_cs_test_1'], ['refund', { payment_intent: 'pi_for_in_cs_test_1' }, `vic361-partner-refund-${id}`]]);
    expect(await orderOf(id)).toMatchObject({ status: 'rejected', reject_reason: 'We already list a similar business.', refund: { ok: true } });
    const mail = sent.find(m => /^About your Vic 361 partner listing$/.test(m.subject));
    expect(mail.text).toContain('We already list a similar business.');
    // Stripe then says the subscription ended: it stays rejected, no "ended" email.
    await webhook({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_cs_test_1', status: 'canceled', metadata: { town: 'victoria' } } } });
    await webhook({ type: 'charge.refunded', data: { object: { id: 'ch_1', payment_intent: 'pi_for_in_cs_test_1', amount_refunded: 9900, refunded: true, customer: 'cus_cs_test_1' } } });
    expect((await orderOf(id)).status).toBe('rejected');
    expect(sent.some(m => /has ended/.test(m.subject))).toBe(false);
    expect((await (await fetch(baseUrl + '/events.json')).json()).partners.open).toContain('food');
    expect(await page('/food-and-drink')).toContain('Own a restaurant or bar?');
    // Final: approving it now is refused.
    expect((await act(id, { action: 'approve' })).status).toBe(409);
  });

  it('a refund Stripe refuses still rejects, and the owner is told to refund by hand', async () => {
    await startApp({ stripe: { refundFails: true } });
    const { id } = await buyFood();
    expect(await (await act(id, { action: 'reject' })).json()).toMatchObject({ ok: true, refunded: false });
    expect((await orderOf(id)).refund).toMatchObject({ ok: false });
    expect(slackPings.find(p => p.type === 'notify' && p.channel === 'sales' && /Refund Mesquite Smokehouse by hand/.test(p.title))).toBeTruthy();
    expect(sent.find(m => /partner listing/.test(m.subject)).text).toContain('are refunding your payment');
  });

  it('the admin can edit the card, and hide or restore a live partner', async () => {
    await startApp();
    const { id } = await buyFood();
    expect((await act(id, { action: 'edit', line: '' })).status).toBe(400);
    expect((await act(id, { action: 'edit', line: 'Now with ribs.', cta: 'Order' })).status).toBe(200);
    expect((await orderOf(id)).partner).toMatchObject({ line: 'Now with ribs.', cta: 'Order' });
    await act(id, { action: 'approve' });
    expect((await act(id, { action: 'hide' })).status).toBe(200);
    expect(await page('/partners')).not.toContain('Now with ribs.');
    expect((await act(id, { action: 'restore' })).status).toBe(200);
    expect(await page('/partners')).toContain('Now with ribs.');
  });
});

describe('billing lifecycle', () => {
  it('past due hides it, paid brings it back, renewals report monthly, and the end is final', async () => {
    await startApp();
    const { id } = await buyFood();
    await act(id, { action: 'approve' });
    const sub = (status, extra = {}) => webhook({ type: 'customer.subscription.updated', data: { object: { id: 'sub_cs_test_1', status, metadata: { town: 'victoria' }, ...extra } } });
    // A declined renewal: alert, still up until Stripe says past due.
    await webhook({ type: 'invoice.payment_failed', data: { object: { id: 'in_2', subscription: 'sub_cs_test_1' } } });
    expect(slackPings.find(p => /Partner card declined/.test(p.title || ''))).toMatchObject({ channel: 'sales' });
    await sub('past_due');
    expect((await orderOf(id)).status).toBe('past_due');
    expect(await page('/partners')).not.toContain('Mesquite');
    expect(await page('/food-and-drink')).not.toContain('partner-');   // taken, not open
    // The renewal goes through.
    await webhook({ type: 'invoice.paid', data: { object: { id: 'in_2', subscription: 'sub_cs_test_1', billing_reason: 'subscription_cycle', payment_intent: 'pi_2' } } });
    expect(await orderOf(id)).toMatchObject({ status: 'active', payment_intent: 'pi_2' });
    expect((await orderOf(id)).last_renewal_at).toBeTruthy();
    // Clicks through the counter, then the monthly report.
    const go = await fetch(`${baseUrl}/go/p/${id}?src=newsletter`, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0' } });
    expect(go.status).toBe(302);
    expect(go.headers.get('location')).toBe('https://mesquite.example/?utm_source=thevic361&utm_medium=email&utm_campaign=partner');
    for (let i = 0; i < 50 && !(await store.listTraffic('2026-10-01')).length; i++) await new Promise(r => setTimeout(r, 10));
    expect((await store.listTraffic('2026-10-01'))[0]).toMatchObject({ kind: 'click', click_type: 'partner_click', path: `/go/p/${id}/newsletter`, ad: id });
    await app.sponsors.sendSponsorReports(NOW);
    const report = sent.find(m => /partner month/.test(m.subject));
    expect(report).toBeTruthy();
    expect(report.text).toContain('Clicked your button in our newsletter: 1 person');
    expect(report.text).not.toMatch(/\$\d/);
    expect((await orderOf(id)).report_through).toBe('2026-10-07');
    sent.length = 0;
    await app.sponsors.sendSponsorReports(NOW);   // once a month
    expect(sent.some(m => /partner month/.test(m.subject))).toBe(false);
    // They cancel: off the site, category open, a confirmation; never back.
    await webhook({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_cs_test_1', status: 'canceled', metadata: { town: 'victoria' } } } });
    expect((await orderOf(id)).status).toBe('canceled');
    for (let i = 0; i < 50 && !sent.some(m => /has ended/.test(m.subject)); i++) await new Promise(r => setTimeout(r, 10));
    expect(sent.find(m => /has ended/.test(m.subject))).toBeTruthy();
    expect(await page('/food-and-drink')).toContain('Own a restaurant or bar?');
    await sub('active');
    await webhook({ type: 'invoice.paid', data: { object: { id: 'in_3', subscription: 'sub_cs_test_1', billing_reason: 'subscription_cycle' } } });
    expect((await orderOf(id)).status).toBe('canceled');
    // A dead link goes to /partners.
    expect((await fetch(`${baseUrl}/go/p/${id}`, { redirect: 'manual' })).headers.get('location')).toBe(`${SITE}/partners`);
  });

  it('ignores another town’s subscription events', async () => {
    await startApp();
    const { id } = await buyFood();
    await act(id, { action: 'approve' });
    await webhook({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_cs_test_1', status: 'canceled', metadata: { town: 'shoals' } } } });
    expect((await orderOf(id)).status).toBe('active');
  });
});

describe('self-service', () => {
  it('the signed manage link opens the Stripe billing portal', async () => {
    await startApp();
    const { id } = await buyFood();
    const t = (await page(`/advertise/thanks?order=${id}`)) && sent.find(m => /You’re in/.test(m.subject)).text.match(/t=([A-Za-z0-9_-]+)/)[1];
    const get = await fetch(`${baseUrl}/partners/manage?o=${id}&t=${t}`);
    expect(get.status).toBe(200);
    expect(await get.text()).toContain('Open my billing page');
    expect((await fetch(`${baseUrl}/partners/manage?o=${id}&t=wrong`)).status).toBe(404);
    const post = await fetch(`${baseUrl}/partners/manage`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ o: id, t }).toString() });
    expect(post.status).toBe(303);
    expect(post.headers.get('location')).toBe('https://billing.stripe.com/p/session/test_1');
    expect(stripeCalls).toContainEqual(['portal', 'cus_cs_test_1', `${SITE}/partners`]);
  });

  it('without the portal set up in Stripe it says to contact us and tells the owner', async () => {
    await startApp({ stripe: { portalFails: true } });
    const { id } = await buyFood();
    const t = sent.find(m => /You’re in/.test(m.subject)).text.match(/t=([A-Za-z0-9_-]+)/)[1];
    const post = await fetch(`${baseUrl}/partners/manage`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ o: id, t }).toString() });
    expect(post.status).toBe(503);
    expect(await post.text()).toContain('contact us');
    expect(slackPings.find(p => p.key === 'stripe-portal').text).toContain('Customer portal');
  });
});

describe('HQ summary', () => {
  it('reports live, waiting, open categories and monthly cents', async () => {
    await startApp();
    const { id } = await buyFood();
    let s = await (await fetch(baseUrl + '/api/hq/summary', { headers: { Authorization: 'Bearer hq-api-key-0123456789-0123456789-zz' } })).json();
    expect(s.partners).toMatchObject({ active: 0, pending: 1, monthly_cents: 0 });
    expect(s.partners.open_categories).not.toContain('food');
    await act(id, { action: 'approve' });
    await new Promise(r => setTimeout(r, 1100));
    s = await (await fetch(baseUrl + '/api/hq/summary?fresh=1', { headers: { Authorization: 'Bearer hq-api-key-0123456789-0123456789-zz' } })).json();
    expect(typeof s.partners.active).toBe('number');
  });
});

describe('a paused town', () => {
  it('shows none of it and sells nothing', async () => {
    await startApp({ siteUrl: 'https://www.thebay979.com',
      town: { id: 'bay', siteName: 'The Bay 979', domain: 'thebay979.com', city: 'Bay City', state: 'TX', stateName: 'Texas', timezone: 'America/Chicago', dormant: true } });
    expect((await fetch(baseUrl + '/partners')).status).toBe(404);
    expect(await page('/food-and-drink')).not.toContain('partner-');
    expect(await page('/about')).not.toContain('/partners');
    expect(await page('/advertise')).not.toContain('Category partner');
    expect((await fetch(baseUrl + '/advertise/checkout?package=category', { redirect: 'manual' })).status).toBe(302);
    expect(await page('/sitemap.xml')).not.toContain('/partners');
  });
});

// ─── Postgres ────────────────────────────────────────────────────────────

const PG = process.env.TEST_DATABASE_URL;
describe.skipIf(!PG)('category orders on Postgres (TEST_DATABASE_URL)', () => {
  it('keep their partner fields through status changes', async () => {
    const { default: pg } = await import('pg');
    const { createStore } = await import('../server/db.js');
    const admin = new pg.Client({ connectionString: PG });
    await admin.connect();
    const dbName = `partners_${process.pid}_${Date.now()}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(PG);
    url.pathname = `/${dbName}`;
    url.searchParams.set('sslmode', 'disable');
    const bundle = await createStore({ databaseUrl: url.toString() });
    try {
      const s = bundle.store;
      const o = { id: 'o-pg-00000001', kind: 'category', category: 'food', status: 'pending_approval', amount: 9900, email: 'a@x.com', business: 'A',
        created_at: NOW.toISOString(), partner: { name: 'A', line: 'L', cta: 'Visit', url: 'https://a.example' }, subscription_id: 'sub_1' };
      await s.saveSponsorOrder(o);
      await s.saveSponsorOrder({ ...o, status: 'active', approved_at: NOW.toISOString() });
      const back = (await s.listSponsorOrders()).find(x => x.id === o.id);
      expect(back).toMatchObject({ kind: 'category', category: 'food', status: 'active', partner: o.partner, subscription_id: 'sub_1' });
      expect(partnersPayload(await s.listSponsorOrders()).active.map(p => p.name)).toEqual(['A']);
    } finally {
      await bundle.pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
      await admin.end();
    }
  });
});
