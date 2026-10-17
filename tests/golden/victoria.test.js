// @vitest-environment node
//
// Golden snapshots of Victoria: the safety net for the multi-city work
// (MULTI_CITY_PLAN.md, Phase 0). Every public page, feed, email and the
// requests we send to Slack, Stripe and Resend are rendered from a frozen
// fixture at a fixed clock and compared byte for byte with the files in
// tests/golden/__golden__/victoria/.
//
// A diff here means Victoria's output changed. If that's intended (a real
// copy or design change), update the snapshots on purpose and say so in
// the PR:  npx vitest run tests/golden -u
// A multi-city refactor must never need that.
//
// Normalized before comparing, because they change for reasons that aren't
// Victoria's output: the ?v=<hash> on CSS/JS links (it follows the CSS and
// JS files themselves), random ids (UUIDs, tokens), and Stripe's
// checkout expiry, which follows the real clock.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createApp } from '../../server/index.js';
import { FileStore } from '../../server/db.js';
import { HUB_PAGES } from '../../server/seo.js';
import { SEASONS } from '../../server/guides.js';
import { withPages } from '../../server/seo.js';
import { renderWeekly, renderWelcomeEmail, renderConfirmEmail, renderReferralRules, createResend } from '../../server/newsletter.js';
import {
  renderSubmissionReceived, renderSubmissionLive, renderSponsorConfirmed, renderSponsorTooLate,
  renderSponsorReport, renderPickReport, renderPartnerReceived, renderPartnerLive, renderPartnerRejected, renderPartnerCanceled, renderPartnerReport
} from '../../server/notify.js';
import { renderReply } from '../../server/inbound.js';
import { createSlack, slackConfig } from '../../server/slack.js';
import { createStripe } from '../../server/sponsors.js';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(path.join(HERE, 'fixture.json'), 'utf8'));
const NOW = new Date('2026-10-07T17:00:00Z'); // Wednesday Oct 7, noon in Victoria
const SITE = 'https://www.thevic361.com';
const ADDRESS = 'PO Box 1, Victoria, TX 77901';
const golden = name => path.join(HERE, '__golden__', 'victoria', name);

// Settings a developer's shell or a CI runner might export that would change
// the output; the snapshots are of Victoria with nothing extra set.
const ENV_KEYS = ['SITE_URL', 'NEWSLETTER_FROM', 'NEWSLETTER_REPLY_TO', 'NEWSLETTER_ADDRESS', 'META_PIXEL_ID',
  'TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY', 'RESEND_API_KEY', 'RESEND_WEBHOOK_SECRET', 'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET', 'SLACK_WEBHOOK_URL', 'SLACK_SALES_WEBHOOK_URL', 'SLACK_ACTIVITY_WEBHOOK_URL',
  'SLACK_ALERTS_WEBHOOK_URL', 'SLACK_HYPE_WEBHOOK_URL', 'SLACK_INBOX_WEBHOOK_URL', 'TOWN', 'SLACK_TOWN_TAG',
  'NEWSLETTER_WEEKEND', 'NEWSLETTER_AUTOSEND', 'AUTO_PUBLISH', 'SCHEDULER', 'DATABASE_URL', 'RAILWAY_ENVIRONMENT_NAME',
  'BUSINESS_LEGAL_NAME', 'BUSINESS_CONTACT_EMAIL'];
const saved = {};
for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
afterAll(() => { for (const k of ENV_KEYS) if (saved[k] !== undefined) process.env[k] = saved[k]; });
// The real clock leaks into a few places the app's now() doesn't reach
// (JSON-LD offers.validFrom, the footer year): freeze Date at NOW so the
// snapshots can't drift with the calendar (they used to fail every midnight
// Central and would again every New Year). Timers stay real.
vi.useFakeTimers({ toFake: ['Date'] });
vi.setSystemTime(NOW);
afterAll(() => vi.useRealTimers());

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
function norm(text) {
  return String(text)
    .replace(/\?v=[0-9a-f]{6,}/g, '?v=HASH')
    .replace(UUID, 'UUID')
    .replace(/(token=)[A-Za-z0-9_-]{16,}/g, '$1TOKEN')
    .replace(/cs_test_[A-Za-z0-9]+/g, 'cs_test_ID')
    .replace(/expires_at=\d+/g, 'expires_at=TIMESTAMP'); // Stripe's expiry follows the real clock
}
const json = v => JSON.stringify(v, null, 2) + '\n';

// ─── Pages and feeds ──────────────────────────────────────────────────────

describe('Victoria pages and feeds', () => {
  let tmpDir, server, base;
  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-golden-'));
    const eventsFile = path.join(tmpDir, 'events.json');
    const venuesFile = path.join(tmpDir, 'venues.json');
    await fs.writeFile(eventsFile, JSON.stringify({ events: FIXTURE.events, sponsor: FIXTURE.sponsor }));
    await fs.writeFile(venuesFile, JSON.stringify(FIXTURE.venues));
    const { app } = await createApp({
      storeBundle: { kind: 'file', store: new FileStore(path.join(tmpDir, 's.json')) }, eventsFile, venuesFile,
      // Checkout on, like production (the Buy buttons and checkout forms
      // show); a stand-in Stripe that page views never call.
      trustProxy: false, now: () => NOW, siteUrl: SITE, resendApiKey: '', stripeSecretKey: 'sk_test_golden', stripeWebhookSecret: 'whsec_golden',
      stripe: { createCheckoutSession: async () => { throw new Error('not in page snapshots'); }, expireCheckoutSession: async () => ({}) },
      slack: { enabled: false, notify: async () => false, alert: async () => false }
    });
    server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    if (server) await new Promise(r => server.close(r));
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const get = async p => {
    const r = await fetch(base + p, { redirect: 'manual' });
    return `${r.status} ${r.headers.get('content-type') || ''}${r.headers.get('location') ? ` -> ${r.headers.get('location')}` : ''}\n\n${norm(await r.text())}`;
  };
  const file = p => (p === '/' ? 'home' : p.slice(1).replace(/[/?=&.]+/g, '_')) + '.txt';

  const PAGES = ['/', '/about', '/privacy', '/advertise', '/advertise/checkout?package=weekly', '/advertise/checkout?package=featured',
    '/advertise/checkout?package=category', '/partners',
    '/subscribe', '/referral-rules', '/contact', '/submit', '/venues', '/no-such-page', '/events.json', '/events.json?all=1',
    '/terms', '/advertising-terms', '/refunds', '/accessibility',
    '/sitemap.xml', '/llms.txt', '/robots.txt', '/pixel.js',
    ...HUB_PAGES.map(p => p.path), ...SEASONS.map(s => s.path)];

  for (const p of PAGES) {
    it(p, async () => { await expect(await get(p)).toMatchFileSnapshot(golden('pages/' + file(p))); });
  }

  it('event pages, their calendar files, and a venue page', async () => {
    const { events } = await (await fetch(base + '/events.json')).json();
    const pages = events.map(e => e.page).filter(Boolean).slice(0, 4);
    expect(pages.length).toBe(4);
    for (const p of pages) {
      await expect(await get(p)).toMatchFileSnapshot(golden('pages/' + file(p)));
      await expect(await get(p + '.ics')).toMatchFileSnapshot(golden('pages/' + file(p + '.ics')));
    }
    const venues = await (await fetch(base + '/venues')).text();
    const venue = (venues.match(/href="(\/venues\/[a-z0-9-]+)"/) || [])[1];
    expect(venue).toBeTruthy();
    await expect(await get(venue)).toMatchFileSnapshot(golden('pages/' + file(venue)));
  });
});

// ─── Emails ──────────────────────────────────────────────────────────────

describe('Victoria emails', () => {
  const evs = withPages(FIXTURE.events);
  const sponsor = { ...FIXTURE.sponsor, week: '2026-10-05', order: 'ord-weekly-1' };
  const referral = { code: 'abc123', count: 1 };
  const mail = m => `Subject: ${m.subject || ''}\n\n${norm(m.text || '')}\n\n----- HTML -----\n${norm(m.html || '')}\n`;
  const order = {
    id: 'ord-1', kind: 'weekly', status: 'paid', amount: 30000, week_start: '2026-10-12', created_at: '2026-10-07T15:00:00Z',
    business: 'Acme Tacos', email: 'owner@acme.example',
    sponsor: { name: 'Acme Tacos', text: 'Best tacos in town.', cta: 'Order now', url: 'https://acme.example', address: '' }
  };
  const pick = {
    id: 'ord-2', kind: 'featured', status: 'paid', amount: 8900, created_at: '2026-10-07T15:00:00Z', business: 'Main Street',
    email: 'ms@example.com', event: { name: 'Fall Festival at De Leon Plaza', date: '2026-10-10', time: '10:00 AM', venue: 'De Leon Plaza' }
  };

  // A category partner (server/partners.js) and the issue it shows in.
  const partner = {
    id: 'ord-3', kind: 'category', category: 'food', status: 'active', amount: 9900, created_at: '2026-09-07T15:00:00Z', paid_at: '2026-09-07T15:05:00Z',
    business: 'Mesquite Smokehouse', email: 'owner@mesquite.example',
    partner: { name: 'Mesquite Smokehouse', line: 'Brisket Fridays. Kids eat free on Tuesdays.', cta: 'See the menu', url: 'https://mesquite.example' }
  };
  const manageUrl = `${SITE}/partners/manage?o=ord-3&t=TOKEN`;
  const partners = { active: [
    { id: 'ord-3', category: 'food', label: 'Food & drink', emoji: '🍽️', name: 'Mesquite Smokehouse', line: 'Brisket Fridays. Kids eat free on Tuesdays.', cta: 'See the menu' },
    { id: 'ord-4', category: 'dental', label: 'Dental', emoji: '🦷', name: 'Riverside Family Dental', line: 'New patients welcome. Saturday hours.', cta: 'Book a visit' },
    { id: 'ord-5', category: 'auto', label: 'Auto', emoji: '🚗', name: 'Navarro Street Auto', line: 'Oil change and tire rotation in 45 minutes.', cta: 'See specials' }
  ], open: ['realestate', 'home', 'pets', 'fitness', 'family', 'insurance', 'legal'] };

  const CASES = {
    'weekly-issue': () => renderWeekly(evs, { siteUrl: SITE, now: new Date('2026-10-05T12:43:00Z'), sponsor, unsubscribeUrl: `${SITE}/unsubscribe?token=t0k3nt0k3nt0k3nt0k3n`,
      address: ADDRESS, openPixelUrl: `${SITE}/email/o/2026-10-05/sub-1.gif`, referral, edition: 'weekly', prefsUrl: `${SITE}/email-prefs?token=t0k3nt0k3nt0k3nt0k3n`, replyAsk: true }),
    'weekend-issue': () => renderWeekly(evs, { siteUrl: SITE, now: new Date('2026-10-08T12:00:00Z'), sponsor, unsubscribeUrl: `${SITE}/unsubscribe?token=t0k3nt0k3nt0k3nt0k3n`,
      address: ADDRESS, referral, edition: 'weekend', prefsUrl: `${SITE}/email-prefs?token=t0k3nt0k3nt0k3nt0k3n`, replyAsk: true }),
    'welcome': () => renderWelcomeEmail(evs, { siteUrl: SITE, now: NOW, sponsor, unsubscribeUrl: `${SITE}/unsubscribe?token=t0k3nt0k3nt0k3nt0k3n`, address: ADDRESS, referral, replyAsk: true }),
    'confirm': () => renderConfirmEmail({ siteUrl: SITE, confirmUrl: `${SITE}/subscribe/confirm?token=t0k3nt0k3nt0k3nt0k3n`, address: ADDRESS }),
    'confirm-reminder': () => renderConfirmEmail({ siteUrl: SITE, confirmUrl: `${SITE}/subscribe/confirm?token=t0k3nt0k3nt0k3nt0k3n`, address: ADDRESS, reminder: true }),
    'submission-received': () => renderSubmissionReceived(evs[7], { siteUrl: SITE, address: ADDRESS, upgradeUrl: `${SITE}/advertise/checkout?package=featured&from=sub-1` }),
    'submission-live': () => renderSubmissionLive(evs[7], { siteUrl: SITE, address: ADDRESS, pageUrl: SITE + evs[7].page, upgradeUrl: `${SITE}/advertise/checkout?package=featured&from=sub-1`, at: '2026-10-06T15:00:00Z' }),
    'submission-live-pick': () => renderSubmissionLive(evs[7], { siteUrl: SITE, address: ADDRESS, pageUrl: SITE + evs[7].page, upgradeUrl: '', pick: true, at: '2026-10-06T15:00:00Z' }),
    'sponsor-confirmed-weekly': () => renderSponsorConfirmed(order, { siteUrl: SITE, address: ADDRESS }),
    'sponsor-confirmed-pick': () => renderSponsorConfirmed(pick, { siteUrl: SITE, address: ADDRESS }),
    'sponsor-too-late': () => renderSponsorTooLate(pick, { siteUrl: SITE, address: ADDRESS }),
    'sponsor-report': () => renderSponsorReport({ ...order, week_start: '2026-09-28' }, {
      week_start: '2026-09-28', week_end: '2026-10-04', views: 812, view_people: 401, where: [{ type: 'Homepage', views: 500 }, { type: 'Event pages', views: 312 }],
      site_clicks: 14, site_people: 12, email_clicks: 9, email_people: 8, social_clicks: 3, social_people: 3, site_visitors: 1530, newsletter_recipients: 152, newsletter_issues: 2
    }, { siteUrl: SITE, address: ADDRESS }),
    'weekly-issue-partners': () => renderWeekly(evs, { siteUrl: SITE, now: new Date('2026-10-05T12:43:00Z'), sponsor, partners, unsubscribeUrl: `${SITE}/unsubscribe?token=t0k3nt0k3nt0k3nt0k3n`,
      address: ADDRESS, edition: 'weekly' }),
    'partner-received': () => renderPartnerReceived({ ...partner, status: 'pending_approval' }, { siteUrl: SITE, address: ADDRESS, manageUrl }),
    'partner-live': () => renderPartnerLive(partner, { siteUrl: SITE, address: ADDRESS, manageUrl }),
    'partner-rejected': () => renderPartnerRejected(partner, { siteUrl: SITE, address: ADDRESS, manageUrl, reason: 'We already list a similar business.' }),
    'partner-canceled': () => renderPartnerCanceled(partner, { siteUrl: SITE, address: ADDRESS, manageUrl }),
    'partner-report': () => renderPartnerReport(partner, { start: '2026-09-07', end: '2026-10-06', views: 1240, click_people: 31, newsletter_people: 18, site_people: 11, social_people: 2,
      newsletter_recipients: 1520, newsletter_issues: 8, where: [{ type: 'Guides & venues', views: 700 }, { type: 'Other', views: 540 }] }, { siteUrl: SITE, address: ADDRESS, manageUrl }),
    'pick-report': () => renderPickReport(pick, { shown: 640, page_views: 88, clicks: 21, calendar: 7, shares: 4, where: [{ type: 'Homepage', views: 400 }] }, { siteUrl: SITE, address: ADDRESS })
  };
  for (const [name, fn] of Object.entries(CASES)) {
    it(name, async () => { await expect(mail(fn())).toMatchFileSnapshot(golden(`emails/${name}.txt`)); });
  }
  it('referral rules page and a reply', async () => {
    await expect(norm(renderReferralRules({ siteUrl: SITE }))).toMatchFileSnapshot(golden('emails/referral-rules.html'));
    await expect(json(renderReply('Thanks for writing!\n\nSee you Saturday.', SITE))).toMatchFileSnapshot(golden('emails/reply.json'));
  });
});

// ─── What we send to other services ──────────────────────────────────────

function recorder() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body });
    if (String(url).includes('api.stripe.com')) {
      if ((init.method || 'GET') === 'GET') return { ok: true, status: 200, json: async () => ({ data: [] }) };
      if (String(url).endsWith('/products')) return { ok: true, status: 200, json: async () => ({ id: 'prod_1' }) };
      if (String(url).endsWith('/prices')) return { ok: true, status: 200, json: async () => ({ id: 'price_1' }) };
      return { ok: true, status: 200, json: async () => ({ id: 'cs_test_abc', url: 'https://checkout.stripe.com/c/pay/cs_test_abc' }) };
    }
    if (String(url).includes('api.resend.com')) return { ok: true, status: 200, json: async () => ({ id: 'em_1', data: [{ id: 'em_1' }] }) };
    return { ok: true, status: 200, text: async () => 'ok', json: async () => ({ ok: true }) };
  };
  const shown = () => calls.map(c => ({
    method: c.method, url: norm(c.url),
    headers: Object.fromEntries(Object.entries(c.headers).filter(([k]) => /idempotency|stripe-version|content-type/i.test(k)).map(([k, v]) => [k, norm(v)])),
    body: c.body == null ? null : (() => { try { return JSON.parse(norm(c.body)); } catch (_) { return norm(decodeURIComponent(String(c.body)).split('&').sort().join('\n')); } })()
  }));
  return { calls, fetchImpl, shown };
}

describe('Victoria outbound requests', () => {
  it('Slack: a notify on every channel and an alert', async () => {
    const rec = recorder();
    const hooks = Object.fromEntries(['sales', 'activity', 'alerts', 'hype', 'inbox'].map(ch => [ch, `https://hooks.slack.com/services/T/${ch}/x`]));
    const slack = createSlack(slackConfig({ RAILWAY_ENVIRONMENT_NAME: 'production' }, { slackUrls: hooks }), { fetchImpl: rec.fetchImpl, nowFn: () => NOW.getTime() });
    for (const ch of Object.keys(hooks)) {
      await slack.notify({ title: `Title for ${ch}`, fields: [['Email', 'a@b.example'], ['Paid', '$300']], text: 'Body <with> & marks', link: `${SITE}/admin.html`, footer: 'footer', channel: ch });
    }
    await slack.alert('golden-key', 'Something broke', 'details here', `${SITE}/admin.html`);
    await expect(json(rec.shown())).toMatchFileSnapshot(golden('outbound/slack.json'));
  });

  it('Stripe: catalog and checkout for a weekly sponsor and a Vic’s Pick', async () => {
    const rec = recorder();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-golden-st-'));
    const eventsFile = path.join(tmpDir, 'events.json');
    await fs.writeFile(eventsFile, JSON.stringify({ events: FIXTURE.events }));
    const { app } = await createApp({
      // Two buyers, two addresses (X-Forwarded-For below): one client gets
      // one open checkout, so a second from the same address replaces it.
      storeBundle: { kind: 'file', store: new FileStore(path.join(tmpDir, 's.json')) }, eventsFile, trustProxy: 1, now: () => NOW,
      siteUrl: SITE, stripeSecretKey: 'sk_test_golden', stripeWebhookSecret: 'whsec_golden', stripe: createStripe('sk_test_golden', rec.fetchImpl),
      resendApiKey: '', slack: { enabled: false, notify: async () => false, alert: async () => false }
    });
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (fields, ip) => fetch(base + '/advertise/checkout', { method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': ip }, body: new URLSearchParams(fields).toString() });
    try {
      const w = await post({ package: 'weekly', week: '2026-10-12', business: 'Acme Tacos', text: 'Best tacos in town.', url: 'acme.example', cta: 'Order', email: 'owner@acme.example', agree: '1' }, '10.0.0.1');
      const f = await post({ package: 'featured', event_name: 'Fall Festival', date: '2026-10-10', time: '10 AM', venue: 'De Leon Plaza',
        address: '101 N Main St', description: 'Food, music, rides.', business: 'Main Street', email: 'ms@example.com', agree: '1' }, '10.0.0.2');
      const c = await post({ package: 'category', category: 'food', business: 'Mesquite Smokehouse', line: 'Brisket Fridays.', url: 'mesquite.example',
        cta: 'See the menu', email: 'owner@mesquite.example', agree: '1' }, '10.0.0.3');
      expect([w.status, f.status, c.status]).toEqual([303, 303, 303]);
      await expect(json(rec.shown())).toMatchFileSnapshot(golden('outbound/stripe.json'));
    } finally {
      await new Promise(r => server.close(r));
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('Resend: a welcome email and the weekly issue batch', async () => {
    const rec = recorder();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-golden-rs-'));
    const eventsFile = path.join(tmpDir, 'events.json');
    await fs.writeFile(eventsFile, JSON.stringify({ events: FIXTURE.events, sponsor: FIXTURE.sponsor }));
    const MON = new Date('2026-10-05T12:43:00Z');
    const { app } = await createApp({
      storeBundle: { kind: 'file', store: new FileStore(path.join(tmpDir, 's.json')) }, eventsFile, trustProxy: false, now: () => MON,
      siteUrl: SITE, adminUsername: 'a', adminPassword: 'b', adminSessionSecret: 'c',
      resendApiKey: 're_golden', newsletterAddress: ADDRESS, resend: createResend('re_golden', rec.fetchImpl),
      // Turnstile on, as in production (a stand-in Cloudflare that passes
      // the token): without it the signup gets a confirmation email instead.
      turnstileSecret: 'ts_golden', fetch: async () => ({ ok: true, json: async () => ({ success: true }) }),
      slack: { enabled: false, notify: async () => false, alert: async () => false }
    });
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    try {
      await post('/api/subscribe', { email: 'reader@example.com', turnstile_token: 'golden' });
      for (let i = 0; i < 100 && !rec.calls.length; i++) await new Promise(r => setTimeout(r, 10));
      const login = await (await post('/api/admin/login', { username: 'a', password: 'b' })).json();
      const sent = await post('/api/admin/newsletter/send', {}, { Authorization: `Bearer ${login.token}` });
      expect(sent.status).toBe(200);
      // Subscriber ids and tokens are random: normalized to UUID / TOKEN.
      const shown = rec.shown().map(c => ({ ...c, body: c.body && typeof c.body === 'object' ? JSON.parse(JSON.stringify(c.body)
        .replace(/\/email\/o\/([0-9-]+)\/[A-Za-z0-9-]+\.gif/g, '/email/o/$1/SUB.gif').replace(/\/r\/[A-Za-z0-9]+/g, '/r/CODE')
        .replace(/vic361-[0-9-]+-[a-f0-9]{8,}/g, m => m.replace(/-[a-f0-9]{8,}$/, '-HASH'))) : c.body,
        headers: Object.fromEntries(Object.entries(c.headers).map(([k, v]) => [k, String(v).replace(/-[a-f0-9]{8,}$/, '-HASH')])) }));
      await expect(json(shown)).toMatchFileSnapshot(golden('outbound/resend.json'));
    } finally {
      await new Promise(r => server.close(r));
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
