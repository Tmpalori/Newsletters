// Admin → Growth (server/growth.js): subscribers per day with the real cost
// per subscriber, each Monday issue, signup weeks, categories and the two
// goals; Meta's daily spend comes in from scripts/meta_ads.py.

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { JSDOM } from 'jsdom';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { dailyGrowth, sumDays, issueReport, signupWeeks, categoryStats, monthRevenue, goals, sourceOf } from '../server/growth.js';

const NOW = new Date('2026-10-14T17:00:00Z'); // Wed Oct 14, Central
const TODAY = '2026-10-14';
// Noon Central on a day, as an ISO time.
const at = day => `${day}T17:00:00.000Z`;

const sub = (id, day, extra = {}) => ({ id, email: `${id}@example.com`, token: `t-${id}`, status: 'active', source: 'subscribe-page',
  created_at: at(day), confirmed_at: at(day), unsubscribed_at: null, ...extra });

let tmpDir, server, baseUrl;
afterEach(async () => {
  if (server) await new Promise(r => server.close(r));
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  server = null; tmpDir = null;
});

describe('growth numbers', () => {
  it('counts each day’s new subscribers by source, who left, and what each cost', () => {
    const subs = [
      sub('a', '2026-10-13', { source: 'subscribe-page:ad' }), sub('b', '2026-10-13', { source: 'footer:ad' }),
      sub('c', '2026-10-13', { referred_by: 'abc1234' }), sub('d', '2026-10-13'),
      sub('e', '2026-10-13', { source: 'import' }),
      sub('f', '2026-10-12', { status: 'unsubscribed', unsubscribed_at: at('2026-10-13') }),
      sub('p', '2026-10-13', { status: 'pending', confirmed_at: null })
    ];
    expect(sourceOf(subs[0])).toBe('Facebook ads');
    expect(sourceOf(subs[2])).toBe('Referral');
    const daily = dailyGrowth(subs, [{ day: '2026-10-13', spend: 10 }], { today: TODAY, days: 3 });
    expect(daily.map(d => d.day)).toEqual(['2026-10-12', '2026-10-13', '2026-10-14']);
    const oct13 = daily[1];
    expect(oct13).toMatchObject({ joined: 5, unsubscribed: 1, net: 4, spend: 10,
      by_source: { 'Facebook ads': 2, Referral: 1, Site: 1, Imported: 1 } });
    // $10 over the 4 who weren't imported.
    expect(oct13.cost_per_sub).toBe(2.5);
    expect(daily[0]).toMatchObject({ joined: 1, spend: null, cost_per_sub: null });
    expect(sumDays(daily)).toMatchObject({ joined: 6, unsubscribed: 1, net: 5, spend: 10, cost_per_sub: 2.5 });
  });

  it('reports each issue: opens, readers who clicked through that week, top events, unsubscribes', () => {
    const page = '/events/2026-10-08-trivia';
    const sends = [
      { week_key: '2026-10-05', subject: 'This week', recipients: 40, sent_at: at('2026-10-05') },
      { week_key: '2026-10-12', subject: 'Next', recipients: 50, sent_at: at('2026-10-12') }
    ];
    const rows = [
      { day: '2026-10-05', kind: 'view', path: page, visitor: 'a', ref_source: 'Newsletter' },
      { day: '2026-10-06', kind: 'view', path: page, visitor: 'b', ref_source: 'Newsletter', n: 2 },
      { day: '2026-10-06', kind: 'view', path: '/', visitor: 'c', ref_source: 'Newsletter' },
      { day: '2026-10-06', kind: 'view', path: page, visitor: 'x', ref_source: 'Facebook' },
      { day: '2026-10-12', kind: 'view', path: '/', visitor: 'd', ref_source: 'Newsletter' }
    ];
    const subs = [sub('u', '2026-09-01', { status: 'unsubscribed', unsubscribed_at: at('2026-10-06') })];
    const out = issueReport(sends, { '2026-10-05': 20 }, subs, rows, [{ name: 'Trivia', page }]);
    expect(out.map(x => x.week)).toEqual(['2026-10-12', '2026-10-05']);
    // Clicked that day: only the send day's readers (visitor ids are per day).
    expect(out[1]).toMatchObject({ sent: 40, opens: 20, open_rate: 50, clickers: 1, click_rate: 2.5, reader_days: 3, visits: 4,
      top_events: [{ name: 'Trivia', views: 3 }], unsubscribed: 1 });
    // The second issue's week starts the day it went out.
    expect(out[0]).toMatchObject({ clickers: 1, opens: 0, unsubscribed: 0 });
  });

  it('follows each signup week: still subscribed, opened lately', () => {
    const subs = [sub('a', '2026-10-06'), sub('b', '2026-10-07', { status: 'unsubscribed' }), sub('c', '2026-10-13'),
      sub('i', '2026-10-13', { source: 'import' })];
    const weeks = signupWeeks(subs, [{ week_key: '2026-10-12', subscriber_id: 'a' }, { week_key: '2026-09-28', subscriber_id: 'c' }],
      ['2026-10-12', '2026-10-05'], { today: TODAY, lastSentAt: '2026-10-12T12:43:00.000Z' });
    expect(weeks).toEqual([
      // Joined after the latest issue went out: nothing to open yet.
      { week: '2026-10-12', joined: 1, active: 1, sent: 0, opened: null },
      { week: '2026-10-05', joined: 2, active: 1, sent: 2, opened: 1 }
    ]);
  });

  it('adds up event views and taps by category', () => {
    const events = [{ page: '/events/a', icons: ['music', 'drinks', 'free'] }, { page: '/events/b', icons: ['family'] }];
    const rows = [
      { day: '2026-10-10', kind: 'view', path: '/events/a', n: 3 }, { day: '2026-10-10', kind: 'click', path: '/events/a', click_type: 'event_click' },
      { day: '2026-10-10', kind: 'view', path: '/events/b' }, { day: '2026-09-01', kind: 'view', path: '/events/b' }
    ];
    expect(categoryStats(rows, events, { start: '2026-10-01' })).toEqual([
      { category: 'music', views: 3, taps: 1 }, { category: 'drinks', views: 3, taps: 1 }, { category: 'family', views: 1, taps: 0 }
    ]);
  });

  it('this month’s revenue counts paid orders and active monthly partners, not refunds', () => {
    const orders = [
      { kind: 'featured', status: 'paid', amount: 1500, paid_at: at('2026-10-02') },
      { kind: 'weekly', status: 'refunded', amount: 5000, paid_at: at('2026-10-03') },
      { kind: 'featured', status: 'pending', amount: 1500 },
      { kind: 'featured', status: 'paid', amount: 1500, paid_at: at('2026-09-20') },
      { kind: 'partner', status: 'active', amount: 4900, paid_at: at('2026-09-10') }
    ];
    expect(monthRevenue(orders, TODAY)).toEqual({ month: '2026-10', cents: 6400, orders: 2, recurring_cents: 4900 });
  });

  it('projects when the list reaches 10,000 at the last two weeks’ pace', () => {
    const subs = Array.from({ length: 70 }, (_, i) => sub('s' + i, '2026-10-01'));
    // 14 whole days of +10, plus today (still going) and an import day that don't count.
    const day = n => new Date(Date.UTC(2026, 8, 30 + n)).toISOString().slice(0, 10); // Sep 30 + n
    const daily = [
      { net: 500, day: day(-1), by_source: { Imported: 500 } },
      ...Array.from({ length: 14 }, (_, i) => ({ net: 10, day: day(i) })), // Sep 30 – Oct 13
      { net: 0, day: TODAY }
    ];
    const g = goals(subs, daily, { cents: 0 }, TODAY);
    expect(g.subscribers).toMatchObject({ active: 70, goal: 10000, per_week: 70 });
    // 9,930 to go at 10 a day.
    expect(g.subscribers.eta).toBe('2029-07-03');
    expect(goals(subs, [{ net: 0, day: '2026-10-13' }], { cents: 0 }, TODAY).subscribers.eta).toBeNull();
  });

  it('a bad timestamp is skipped, not a broken report', () => {
    const subs = [sub('a', '2026-10-13'), sub('b', '2026-10-13', { confirmed_at: 'garbage', unsubscribed_at: 'nope' })];
    expect(dailyGrowth(subs, [], { today: TODAY, days: 2 })[0]).toMatchObject({ day: '2026-10-13', joined: 1 });
    expect(monthRevenue([{ status: 'paid', amount: 100, paid_at: 'bad' }], TODAY)).toMatchObject({ cents: 0 });
  });
});

describe('growth endpoints', () => {
  async function start() {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-growth-'));
    const eventsFile = path.join(tmpDir, 'events.json');
    await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
    const file = path.join(tmpDir, 's.json');
    await fs.writeFile(file, JSON.stringify({ subscribers: [
      sub('a', '2026-10-13', { source: 'subscribe-page:ad' }), sub('b', '2026-10-13'), sub('c', '2026-10-12', { source: 'subscribe-page:ad' })
    ] }));
    const store = new FileStore(file);
    const { app } = await createApp({
      storeBundle: { kind: 'file', store }, eventsFile, trustProxy: false, now: () => NOW, adsSpendSecret: 'spend-secret',
      siteUrl: 'https://www.thevic361.com', adminUsername: 'a', adminPassword: 'b', adminSessionSecret: 'c'
    });
    server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    return store;
  }
  const postSpend = (body, secret = 'spend-secret') => fetch(baseUrl + '/api/ads/spend', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cron-Secret': secret }, body: JSON.stringify(body) });

  it('takes Meta’s daily spend with the secret only, and answers with the site’s own count', async () => {
    const store = await start();
    expect((await postSpend({ days: [{ day: '2026-10-13', spend: 9 }] }, 'wrong')).status).toBe(401);
    // Not a real date: dropped, not a failed save.
    expect(await (await postSpend({ days: [{ day: '2026-02-30', spend: 1 }] })).json()).toMatchObject({ ok: true, saved: 0 });
    const r = await postSpend({ days: [{ day: '2026-10-13', spend: '9.00', impressions: 900, clicks: 30, leads: 1 },
      { day: '2026-10-12', spend: 4 }, { day: 'nope', spend: 1 }, { day: '2026-10-11', spend: -5 }] });
    const j = await r.json();
    expect(j).toMatchObject({ ok: true, saved: 3, yesterday: { day: '2026-10-13', joined: 2, spend: 9, cost_per_sub: 4.5 },
      last_7_days: { joined: 3, spend: 13 } });
    // Meta revises recent days: a later post replaces the day.
    await postSpend({ days: [{ day: '2026-10-13', spend: 10 }] });
    expect(await store.listAdSpend('2026-10-01')).toMatchObject([
      { day: '2026-10-11', spend: 0 }, { day: '2026-10-12', spend: 4 }, { day: '2026-10-13', spend: 10, impressions: 0 }]);
  });

  it('keeps the campaigns the ads report saw, for HQ', async () => {
    const store = await start();
    await postSpend({ days: [], campaigns: [{ name: 'Vic Newsletter Leads - Copy', status: 'ACTIVE', daily_budget: 40, spend_7_days: '26.14', leads_7_days: 15, clicks_7_days: 91 },
      { nope: true }] });
    const f = await store.getTownFile('ad_campaigns');
    expect(f.data.campaigns).toEqual([{ name: 'Vic Newsletter Leads - Copy', status: 'ACTIVE', daily_budget: 40, spend_7_days: 26.14, leads_7_days: 15, clicks_7_days: 91 }]);
    // A post without campaigns leaves the last ones.
    await postSpend({ days: [{ day: '2026-10-13', spend: 1 }] });
    expect((await store.getTownFile('ad_campaigns')).data.campaigns).toHaveLength(1);
  });

  it('the admin report needs a login and has the goals, days, issues and weeks', async () => {
    await start();
    await postSpend({ days: [{ day: '2026-10-13', spend: 8 }] });
    expect((await fetch(baseUrl + '/api/admin/growth')).status).toBe(401);
    const login = await fetch(baseUrl + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'a', password: 'b' }) });
    const h = { Authorization: `Bearer ${(await login.json()).token}` };
    const g = await (await fetch(baseUrl + '/api/admin/growth?days=7', { headers: h })).json();
    expect(g).toMatchObject({ ok: true, days: 7, today: TODAY, spend_reported: true, pending: 0,
      goals: { subscribers: { active: 3, goal: 10000 }, revenue: { cents: 0, goal_cents: 1000000 } },
      totals: { joined: 3, spend: 8, cost_per_sub: 4 }, yesterday: { day: '2026-10-13', joined: 2, cost_per_sub: 4 } });
    expect(g.daily).toHaveLength(7);
    expect(g.signup_weeks).toEqual([{ week: '2026-10-12', joined: 3, active: 3, sent: 0, opened: null }]);
    // Home asks for the goals only.
    const home = await (await fetch(baseUrl + '/api/admin/growth?goals=1', { headers: h })).json();
    expect(home).toEqual({ ok: true, today: TODAY, goals: g.goals });

    // And the admin page draws it.
    const html = await fs.readFile(path.join(process.cwd(), 'docs/admin.html'), 'utf8');
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://www.thevic361.com/admin.html' });
    dom.window.eval(await fs.readFile(path.join(process.cwd(), 'docs/admin.js'), 'utf8'));
    dom.window.__vic361Admin.renderGrowth(g);
    const doc = dom.window.document;
    // The goals are on Overview, not repeated here.
    expect(doc.getElementById('growth-goals')).toBeNull();
    expect(doc.getElementById('growth-totals').textContent).toContain('Real cost per subscriber$4.00');
    expect(doc.querySelectorAll('#growth-chart .chart-bar')).toHaveLength(7);
    expect(doc.getElementById('growth-sources').textContent).toContain('Facebook ads');
    expect(doc.getElementById('growth-issues-chart').textContent).toContain('No issues sent yet.');
    expect(doc.getElementById('growth-daily').textContent).toContain('Facebook ads 1, Site 1');
    expect(doc.getElementById('growth-issues').textContent).toContain('No issues sent yet.');
  });
});
