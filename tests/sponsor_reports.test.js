// @vitest-environment node
//
// Sponsor performance reports: ad impressions on /api/track, data-ad on the
// server-rendered placements, the weekly sponsor report's views and "where
// it ran", the Vic's Pick report (sent the day after its event, once), and
// the admin Report route.

import { describe, it, expect, afterEach } from 'vitest';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { beaconRow, pageType } from '../server/analytics.js';
import { sponsorStats, pickStats } from '../server/sponsors.js';
import { renderPickReport, renderSponsorReport } from '../server/notify.js';
import { withPages } from '../server/seo.js';
import { renderWeekly } from '../server/newsletter.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1';
const AD = 'f1a2b3c4-0000-4000-8000-000000000001';
const WK = 'w1a2b3c4-0000-4000-8000-000000000002';
const EVENTS = [
  { date: '2026-10-09', name: 'Friday Live Music', time: '8:00 PM', venue: 'Aero Crafters' },
  { date: '2026-10-10', name: 'Fall Festival at De Leon Plaza', time: '10:00 AM', venue: 'De Leon Plaza', url: 'https://fallfest.example/tickets' }
];
const PAGE = withPages(EVENTS)[1].page;

const pickOrder = (extra = {}) => ({
  id: AD, kind: 'featured', status: 'paid', amount: 8900, created_at: '2026-10-01T15:00:00Z', paid_at: '2026-10-01T15:05:00Z',
  business: 'Fall Fest Co', email: 'fest@example.com', event: { ...EVENTS[1] }, ...extra
});
const weeklyOrder = (extra = {}) => ({
  id: WK, kind: 'weekly', status: 'paid', amount: 30000, week_start: '2026-10-05', created_at: '2026-09-20T00:00:00Z',
  business: 'Acme Tacos', email: 'acme@example.com',
  sponsor: { name: 'Acme Tacos', text: 'Best tacos.', cta: 'Order', url: 'https://acme.example' }, ...extra
});

let tmpDir, server, baseUrl, store, clock;

async function startApp({ events = EVENTS, ...extra } = {}) {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-reports-'));
  const eventsFile = path.join(tmpDir, 'events.json');
  await fs.writeFile(eventsFile, JSON.stringify({ events }));
  store = new FileStore(path.join(tmpDir, 's.json'));
  clock = { now: new Date('2026-10-07T17:00:00Z') };
  const { app } = await createApp({
    storeBundle: { kind: 'file', store }, eventsFile, trustProxy: false, now: () => clock.now,
    siteUrl: 'https://www.thevic361.com', analyticsSecret: 'test',
    adminUsername: 'a', adminPassword: 'b', adminSessionSecret: 'c', submissionReviewSecret: 'rs',
    stripeSecretKey: 'sk_test', stripeWebhookSecret: 'whsec', stripe: {}, resendApiKey: '', ...extra
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

const beacon = (body, ua = UA) => fetch(baseUrl + '/api/track', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': ua }, body: JSON.stringify(body)
});
async function waitFor(fn, ms = 2000) {
  for (let t = 0; t < ms; t += 20) {
    const v = await fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, 20));
  }
  return fn();
}
async function auth() {
  const r = await fetch(baseUrl + '/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'a', password: 'b' })
  });
  return { Authorization: `Bearer ${(await r.json()).token}` };
}
const mailer = () => {
  const sent = [];
  return { sent, resend: { send: async (msg, key) => { sent.push({ ...msg, key }); return { id: 'e' + sent.length }; }, batch: async (msgs) => ({ data: msgs.map(() => ({})) }) } };
};

describe('impressions on /api/track', () => {
  const ctx = { ip: '1.2.3.4', ua: UA, secret: 's', siteHost: 'www.thevic361.com', now: new Date('2026-10-07T17:00:00Z') };

  it('accepts an impression with a valid ad id and rejects bad ids and bots', () => {
    expect(beaconRow({ kind: 'impression', ad: AD, path: '/today' }, ctx)).toMatchObject({ kind: 'impression', ad: AD, path: '/today', day: '2026-10-07' });
    for (const ad of ['', 'short', 'has space here', '<script>alert(1)</script>', 'x'.repeat(65), 42, null]) {
      expect(beaconRow({ kind: 'impression', ad, path: '/' }, ctx)).toBeNull();
    }
    expect(beaconRow({ kind: 'impression', ad: AD, path: '/' }, { ...ctx, ua: 'Mozilla/5.0 (compatible; Googlebot/2.1)' })).toBeNull();
    // Clicks keep a valid ad id and drop a bad one.
    expect(beaconRow({ kind: 'click', type: 'event_click', url: '/events/x', ad: AD }, ctx)).toMatchObject({ ad: AD });
    expect(beaconRow({ kind: 'click', type: 'event_click', url: '/events/x', ad: 'bad id!' }, ctx)).not.toHaveProperty('ad');
  });

  it('stores impression rows (kind, path, visitor, ad) and skips bots', async () => {
    await startApp();
    await beacon({ kind: 'impression', ad: AD, path: '/this-weekend' });
    await beacon({ kind: 'impression', ad: 'nope', path: '/' });
    await beacon({ kind: 'impression', ad: AD, path: '/' }, 'HeadlessChrome/120');
    await beacon({ kind: 'click', type: 'sponsor_click', url: 'https://acme.example', ad: WK, path: '/' });
    const rows = await waitFor(async () => {
      const r = await store.listTraffic('2026-01-01');
      return r.length >= 2 ? r : null;
    });
    await new Promise(r => setTimeout(r, 50)); // room for a wrongly stored row
    const all = await store.listTraffic('2026-01-01');
    expect(all).toHaveLength(2);
    expect(rows.find(r => r.kind === 'impression')).toMatchObject({ kind: 'impression', path: '/this-weekend', ad: AD, visitor: expect.any(String) });
    expect(rows.find(r => r.kind === 'click')).toMatchObject({ click_type: 'sponsor_click', ad: WK });
    // The admin Traffic tab ignores impressions.
    const h = await auth();
    const t = await (await fetch(baseUrl + '/api/admin/traffic', { headers: h })).json();
    expect(t.totals.today.views).toBe(0);
  });
});

describe('data-ad on server-rendered placements', () => {
  it('tags the paid pick and the weekly sponsor block, not other events, and keeps it out of Save & Publish', async () => {
    await startApp();
    await store.saveSponsorOrder(pickOrder());
    await store.saveSponsorOrder(weeklyOrder());
    // The homepage's sponsor block is drawn by docs/app.js (from
    // /events.json, below); its list is server-rendered.
    const home = await (await fetch(baseUrl + '/')).text();
    const tagged = [...home.matchAll(/<li class="event-entry[^"]*" data-ad="([^"]+)"/g)].map(m => m[1]);
    expect(tagged).toEqual([AD]);
    const today = await (await fetch(baseUrl + '/this-weekend')).text();
    expect(today).toContain(`data-ad="${AD}"`);
    expect(today).toContain(`<div class="sponsor-block" data-ad="${WK}">`);
    const evPage = await (await fetch(baseUrl + withPages(EVENTS)[0].page)).text();
    expect(evPage).toContain(`data-ad="${WK}"`);  // sponsor block on event pages too
    // /events.json carries the ids app.js needs, and nothing about the buyer.
    const json = await (await fetch(baseUrl + '/events.json')).json();
    expect(json.sponsor.order).toBe(WK);
    const ev = json.events.find(e => e.name.startsWith('Fall'));
    expect(ev.sponsor_order).toBe(AD);
    expect(JSON.stringify(json)).not.toContain('fest@example.com');
    // Save & Publish doesn't store it.
    const h = { ...(await auth()), 'Content-Type': 'application/json' };
    const r = await fetch(baseUrl + '/api/admin/publish-events', { method: 'POST', headers: h, body: JSON.stringify({ events: json.events }) });
    expect(r.status).toBe(200);
    const published = await store.getPublished();
    expect(JSON.stringify(published.events)).not.toContain('sponsor_order');
  });
});

describe('weekly sponsor report', () => {
  it('counts views, people and where it ran', () => {
    const order = weeklyOrder();
    const rows = [
      { day: '2026-10-05', kind: 'impression', ad: WK, path: '/', visitor: 'v1' },
      { day: '2026-10-05', kind: 'impression', ad: WK, path: '/', visitor: 'v1' },
      { day: '2026-10-06', kind: 'impression', ad: WK, path: '/today', visitor: 'v2', n: 3 },   // grouped rows (PgStore)
      { day: '2026-10-06', kind: 'impression', ad: WK, path: '/events/2026-10-09-x', visitor: 'v3' },
      { day: '2026-10-06', kind: 'impression', ad: WK, path: '/venues/aero-crafters', visitor: 'v3' },
      { day: '2026-10-06', kind: 'impression', ad: WK, path: '/advertise', visitor: 'v3' },
      { day: '2026-10-06', kind: 'impression', ad: 'someone-else-1', path: '/', visitor: 'v4' },
      { day: '2026-10-12', kind: 'impression', ad: WK, path: '/', visitor: 'v5' },               // after the week
      { day: '2026-10-07', kind: 'click', click_type: 'sponsor_click', click_url: 'https://elsewhere.example', ad: WK, path: '/', visitor: 'v6' }
    ];
    const s = sponsorStats(order, rows, { recipients: 120 });
    expect(s).toMatchObject({ views: 8, view_people: 3, site_clicks: 1, site_people: 1, newsletter_recipients: 120 });
    expect(s.where).toEqual([
      { type: 'Day lists', views: 3 }, { type: 'Homepage', views: 2 },
      { type: 'Event pages', views: 1 }, { type: 'Guides & venues', views: 1 }, { type: 'Other', views: 1 }
    ]);
    const mail = renderSponsorReport(order, s, { siteUrl: 'https://www.thevic361.com', address: '1 Main St' });
    expect(mail.text).toContain('Your block was seen on thevic361.com: 8 times');
    expect(mail.text).toContain('- Day lists: 3 views');
    expect(mail.text).toContain('some browsers block');
    expect(mail.html).toContain('Where people saw it');
    expect(mail.text + mail.html).not.toMatch(/—|opened|opens/);
  });

  it('groups page paths the way sponsors think of them', () => {
    expect(pageType('/')).toBe('Homepage');
    expect(pageType('/this-weekend')).toBe('Day lists');
    expect(pageType('/next-week/')).toBe('Day lists');
    expect(pageType('/events/2026-10-10-x')).toBe('Event pages');
    expect(pageType('/live-music')).toBe('Guides & venues');
    expect(pageType('/oktoberfest')).toBe('Guides & venues');
    expect(pageType('/venues')).toBe('Guides & venues');
    expect(pageType('/subscribe')).toBe('Other');
  });
});

describe('Vic’s Pick report', () => {
  const opts = { start: '2026-10-01', end: '2026-10-10', pages: [PAGE], urls: ['https://fallfest.example/tickets'], recipients: 300, starred: true };

  it('counts list views, page views, link clicks, calendar adds and shares', () => {
    const rows = [
      { day: '2026-10-08', kind: 'impression', ad: AD, path: '/', visitor: 'v1' },
      { day: '2026-10-09', kind: 'impression', ad: AD, path: '/this-weekend', visitor: 'v2', n: 4 },
      { day: '2026-10-09', kind: 'view', path: PAGE, visitor: 'v1' },
      { day: '2026-10-09', kind: 'view', path: PAGE, visitor: 'v2' },
      { day: '2026-10-09', kind: 'view', path: '/today', visitor: 'v2' },
      { day: '2026-10-09', kind: 'click', click_type: 'event_click', click_url: 'https://fallfest.example/tickets?utm_x=1', path: PAGE, visitor: 'v1' },
      { day: '2026-10-09', kind: 'click', click_type: 'event_click', click_url: 'https://fallfest.example/tickets', ad: AD, path: '/', visitor: 'v3' },
      { day: '2026-10-09', kind: 'click', click_type: 'event_click', click_url: PAGE, ad: AD, path: '/', visitor: 'v4' },          // opened its page
      { day: '2026-10-09', kind: 'click', click_type: 'event_click', click_url: 'https://fallfest.example/tickets', path: '/today', visitor: 'v5' }, // not its ad
      { day: '2026-10-09', kind: 'click', click_type: 'add_to_calendar', click_url: `${PAGE}.ics`, path: PAGE, visitor: 'v1' },
      { day: '2026-10-09', kind: 'click', click_type: 'add_to_calendar', click_url: 'x.ics', path: '/events/other', visitor: 'v1' },
      { day: '2026-10-09', kind: 'click', click_type: 'share_facebook', click_url: 'https://www.facebook.com/sharer/sharer.php?u=x', path: PAGE, visitor: 'v1' },
      { day: '2026-10-09', kind: 'click', click_type: 'share_from_list', click_url: `https://www.thevic361.com${PAGE}`, path: '/', ad: AD, visitor: 'v6' },
      { day: '2026-10-11', kind: 'impression', ad: AD, path: '/', visitor: 'v9' }                                                    // after its day
    ];
    expect(pickStats(pickOrder(), rows, opts)).toMatchObject({
      shown: 5, shown_people: 2, page_views: 2, page_people: 2, link_clicks: 2, link_people: 2,
      calendar_adds: 1, shares: 2, newsletter_starred: true, newsletter_recipients: 300,
      where: [{ type: 'Day lists', views: 4 }, { type: 'Homepage', views: 1 }]
    });
    expect(pickStats(pickOrder(), [], { ...opts, starred: false })).toMatchObject({ shown: 0, newsletter_starred: false, newsletter_recipients: 0 });
  });

  it('the newsletter notes which paid picks it starred', () => {
    const events = withPages(EVENTS).map((ev, i) => (i === 1 ? { ...ev, featured: true, sponsor_order: AD } : { ...ev, featured: true, editor_pick: true }));
    const issue = renderWeekly(events, { siteUrl: 'https://x', now: new Date('2026-10-05T13:00:00Z'), sponsor: null, unsubscribeUrl: 'u', address: 'a' });
    expect(issue.picks).toEqual([AD]);
  });

  it('the email is plain, honest and never claims opens', () => {
    const stats = pickStats(pickOrder(), [], opts);
    const mail = renderPickReport(pickOrder(), stats, { siteUrl: 'https://www.thevic361.com', address: '1 Main St' });
    expect(mail.subject).toBe('Your Vic\'s Pick report: Fall Festival at De Leon Plaza');
    expect(mail.text).toContain('Starred in the newsletter, sent to: 300 subscribers');
    const both = renderPickReport(pickOrder(), { ...stats, newsletter_issues: 2, newsletter_recipients: 590 }, { siteUrl: 'https://x' });
    expect(both.text).toContain('Starred in both newsletters (Monday and Thursday), copies sent: 590');
    expect(mail.text).toContain('some browsers block');
    expect(mail.text + mail.html).not.toMatch(/—|opened|opens/);
    const unstarred = renderPickReport(pickOrder(), { ...stats, newsletter_starred: false }, { siteUrl: 'https://x' });
    expect(unstarred.text).not.toContain('newsletter');
  });

  it('is emailed the day after the event, not before, once, and never for refunded orders', async () => {
    const mail = mailer();
    await startApp({ resendApiKey: 're_test', resend: mail.resend, newsletterAddress: '1 Main St' });
    await store.saveSponsorOrder(pickOrder());
    await store.saveSponsorOrder(pickOrder({ id: 'refunded-0001', status: 'refunded', email: 'r@example.com' }));
    await store.saveSponsorOrder(pickOrder({ id: 'hidden-00001', status: 'hidden', email: 'h@example.com' }));
    await store.recordNewsletterSend({ week_key: '2026-10-05', subject: 's', recipients: 250, failed: 0, failed_emails: [], picks: [AD] });
    await store.recordTraffic({ day: '2026-10-08', kind: 'impression', ad: AD, path: '/', visitor: 'v1' });
    await store.recordTraffic({ day: '2026-10-09', kind: 'view', path: PAGE, visitor: 'v1' });
    const run = () => fetch(baseUrl + '/api/submission-review/pending', { headers: { 'X-Cron-Secret': 'rs' } });
    const reports = () => mail.sent.filter(m => m.key && m.key.startsWith('vic361-pick-report-'));

    clock.now = new Date('2026-10-10T22:00:00Z'); // its day: too early
    expect((await run()).status).toBe(200);
    await new Promise(r => setTimeout(r, 100));
    expect(reports()).toHaveLength(0);

    clock.now = new Date('2026-10-11T06:00:00Z'); // 1 AM the day after: wait for the morning
    await run();
    await new Promise(r => setTimeout(r, 100));
    expect(reports()).toHaveLength(0);

    clock.now = new Date('2026-10-11T15:00:00Z'); // the morning after
    await run();
    await waitFor(() => reports().length > 0);
    expect(reports()).toHaveLength(1);
    expect(reports()[0]).toMatchObject({ to: ['fest@example.com'], key: `vic361-pick-report-${AD}` });
    expect(reports()[0].text).toContain('Shown in our event lists as a Vic’s Pick: 1 time');
    expect(reports()[0].text).toContain('Views of its event page: 1');
    expect(reports()[0].text).toContain('sent to: 250 subscribers');
    // The order is saved just after the email goes out: wait for it.
    const savedOrder = async () => (await store.listSponsorOrders()).find(o => o.id === AD);
    await waitFor(async () => Boolean((await savedOrder())?.report_sent));
    const saved = await savedOrder();
    expect(saved.report_sent).toBeTruthy();
    expect(saved.report).toMatchObject({ shown: 1, page_views: 1 });

    await run();
    await new Promise(r => setTimeout(r, 100));
    expect(reports()).toHaveLength(1); // not twice
    expect(mail.sent.some(m => (m.to || []).includes('r@example.com') || (m.to || []).includes('h@example.com'))).toBe(false);
  });

  it('adds the social posts it was in and how it beat the other events that day', async () => {
    const mail = mailer();
    // Six other events that Saturday, two views each; the pick's page gets eight.
    const others = Array.from({ length: 6 }, (_, i) => ({ date: '2026-10-10', name: `Other ${i}`, time: '1:00 PM', venue: `V${i}` }));
    await startApp({ resendApiKey: 're_test', resend: mail.resend, newsletterAddress: '1 Main St', events: [...EVENTS, ...others] });
    await store.saveSponsorOrder(pickOrder());
    await store.setTownFile('social_posted', { '2026-10-09:weekend': { facebook: 'p1', pages: [PAGE] } });
    for (let i = 0; i < 8; i++) await store.recordTraffic({ day: '2026-10-09', kind: 'view', path: PAGE, visitor: `p${i}`, ref_source: i < 3 ? 'Facebook' : null });
    for (const page of withPages([...EVENTS, ...others]).slice(2).map(e => e.page)) {
      for (let i = 0; i < 2; i++) await store.recordTraffic({ day: '2026-10-09', kind: 'view', path: page, visitor: `o${i}` });
    }
    clock.now = new Date('2026-10-11T15:00:00Z');
    await fetch(baseUrl + '/api/submission-review/pending', { headers: { 'X-Cron-Secret': 'rs' } });
    const report = () => mail.sent.find(m => m.key && m.key.startsWith('vic361-pick-report-'));
    await waitFor(() => Boolean(report()));
    expect(report().text).toContain('- In our Facebook posts: 1 post');
    expect(report().text).toContain('- Visits from our social posts: 3');
    expect(report().text).toContain('That’s about 4× the page views of a typical event that day.');
  });

  it('stops catching up after 14 days, and without email tells Slack once', async () => {
    const alerts = [];
    // The to-do goes to sales (a notify), keyed here by its title.
    await startApp({ slack: { enabled: true, notify: async m => { if (m.channel === 'sales' && /report/.test(m.title)) alerts.push({ key: /Send .* their/.test(m.title) ? `pick-report:${AD}` : `pick-report-other:${m.title}`, text: m.text, more: m.more }); return true; }, alert: async (key, title, text) => { alerts.push({ key, title, text }); } } });
    await store.saveSponsorOrder(pickOrder());
    await store.saveSponsorOrder(pickOrder({ id: 'old-pick-0001', event: { ...EVENTS[1], date: '2026-09-01' }, created_at: '2026-08-20T00:00:00Z', paid_at: null }));
    const run = () => fetch(baseUrl + '/api/submission-review/pending', { headers: { 'X-Cron-Secret': 'rs' } });
    clock.now = new Date('2026-10-11T15:00:00Z');
    await run();
    await waitFor(() => alerts.some(a => a.key === `pick-report:${AD}`));
    await run();
    await new Promise(r => setTimeout(r, 100));
    expect(alerts.filter(a => a.key.startsWith('pick-report')).map(a => a.key)).toEqual([`pick-report:${AD}`]);
    expect(alerts[0].more).toContain('Event page views: 0');
    expect(alerts[0].text).toContain('fest@example.com');
  });
});

describe('admin Report button', () => {
  it('GET /api/admin/sponsors/:id/report needs the admin and returns live stats', async () => {
    await startApp();
    await store.saveSponsorOrder(pickOrder());
    await store.saveSponsorOrder(weeklyOrder());
    await store.recordTraffic({ day: '2026-10-06', kind: 'impression', ad: WK, path: '/today', visitor: 'v1' });
    await store.recordTraffic({ day: '2026-10-07', kind: 'impression', ad: AD, path: '/', visitor: 'v1' });
    expect((await fetch(`${baseUrl}/api/admin/sponsors/${AD}/report`)).status).toBe(401);
    const h = await auth();
    const pick = await (await fetch(`${baseUrl}/api/admin/sponsors/${AD}/report`, { headers: h })).json();
    expect(pick).toMatchObject({ ok: true, kind: 'featured', on_site: true, stats: { shown: 1, pages: [PAGE] } });
    const week = await (await fetch(`${baseUrl}/api/admin/sponsors/${WK}/report`, { headers: h })).json();
    expect(week).toMatchObject({ ok: true, kind: 'weekly', stats: { views: 1, where: [{ type: 'Day lists', views: 1 }] } });
    expect((await fetch(`${baseUrl}/api/admin/sponsors/nope/report`, { headers: h })).status).toBe(404);
  });
});
