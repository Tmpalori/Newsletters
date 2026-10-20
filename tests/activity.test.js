// @vitest-environment node
//
// What people did on the site (server/activity.js), for the owner's
// assistant through HQ: views, clicks, shares, calendar adds, per event.

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { SHARED_LINK } from '../server/analytics.js';
import { activitySummary } from '../server/activity.js';

const NOW = new Date('2026-10-14T17:00:00Z'); // Wednesday, Central
const T = '/events/2026-10-16-trivia', M = '/events/2026-10-17-market';
const EVENTS = [
  { date: '2026-10-16', name: 'Trivia', venue: 'Pub', page: T, url: 'https://pub.example/trivia' },
  { date: '2026-10-17', name: 'Market', venue: 'Square', page: M, url: 'https://market.example' }
];
const view = (day, p, visitor, ref_source = 'Direct') => ({ day, kind: 'view', path: p, visitor, ref_source });
const click = (day, p, visitor, click_type, click_url = '') => ({ day, kind: 'click', path: p, visitor, click_type, click_url });

let tmpDir, server, baseUrl, store;
afterEach(async () => {
  if (server) await new Promise(r => server.close(r));
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  server = null; tmpDir = null;
});

describe('activitySummary', () => {
  const rows = [
    view('2026-10-01', T, 'old'),                                          // before the range: not counted
    view('2026-10-13', '/', 'a'), view('2026-10-13', T, 'a'), view('2026-10-14', T, 'b', SHARED_LINK),
    view('2026-10-14', M, 'c'),
    click('2026-10-13', '/', 'a', 'event_click', 'https://pub.example/trivia?utm_source=thevic361'),
    click('2026-10-13', T, 'a', 'share_native', `https://www.thevic361.com${T}`),
    click('2026-10-13', T, 'a', 'share_facebook', 'https://www.facebook.com/sharer/sharer.php?u=x'),
    click('2026-10-14', T, 'b', 'share_from_list', `https://www.thevic361.com${M}`), // Market's, from Trivia's "Also on"
    click('2026-10-14', T, 'b', 'add_to_calendar'),
    click('2026-10-14', '/', 'c', 'sponsor_click', 'https://sponsor.example'),
    click('2026-10-14', '/', 'c', 'filter'),
    click('2026-10-14', '/', 'c', 'event_open', T),                       // a list tap to Trivia's page
    click('2026-10-13', '/', 'a', 'event_click', M),                      // the same, sent before event_open existed
    { day: '2026-10-14', kind: 'impression', path: '/', visitor: 'c', ad: 'ord-12345678' },
    { day: '2026-10-14', kind: 'crawl', path: T, bot: 'GPTBot' }
  ];
  const sends = [
    { week_key: '2026-10-12', subject: 'This week', sent_at: '2026-10-12T12:43:00Z', recipients: 100 },
    { week_key: '2026-10-01', subject: 'This weekend', sent_at: '2026-10-01T12:00:00Z', recipients: 90 }   // before the range
  ];
  const s = activitySummary(rows, { now: NOW, days: 7, events: EVENTS, sends, opens: { '2026-10-12': 40, '2026-10-01': 30 } });

  it('totals views, visitors, clicks, shares and calendar adds in the range', () => {
    expect(s).toMatchObject({ ok: true, days: 7, from: '2026-10-08', to: '2026-10-14' });
    expect(s.totals).toEqual({
      views: 4, visitors: 3, clicks: 8, event_link_clicks: 1, event_link_clickers: 1, event_link_clickers_per_100_visitors: 33.3,
      event_opens: 2, event_openers: 2, event_openers_per_100_visitors: 66.7,
      shares: 3, share_visits: 1, calendar_adds: 1, sponsor_clicks: 1,
      subscribe_clicks: 0, subscribe_link_taps: 0, subscribe_form_ok: 0, subscribe_people: 0,
      ad_views: 1, newsletter_recipients: 100, newsletter_opens: 40, newsletter_clickers: null
    });
    expect(s.clicks_by.find(x => x.key === 'event_open')).toMatchObject({ count: 2, label: 'Event pages opened from a list' });
    expect(s.shares_by.map(x => x.key).sort()).toEqual(['share_facebook', 'share_from_list', 'share_native']);
    expect(s.clicks_by.find(x => x.key === 'add_to_calendar').label).toBe('Added to calendar');
  });

  it('credits each event with its own views, link clicks and shares', () => {
    const [trivia, market] = s.events;
    expect(trivia).toEqual({ page: T, name: 'Trivia', venue: 'Pub', date: '2026-10-16',
      views: 2, people: 2, link_clicks: 1, link_clickers: 1, list_opens: 1, shares: 2, share_visits: 1, calendar_adds: 1 });
    expect(market).toEqual({ page: M, name: 'Market', venue: 'Square', date: '2026-10-17',
      views: 1, people: 1, link_clicks: 0, link_clickers: 0, list_opens: 1, shares: 1, share_visits: 0, calendar_adds: 0 });
  });

  it('has every day, and only the issues sent in the range', () => {
    expect(s.daily).toHaveLength(7);
    expect(s.daily.at(-1)).toEqual({ day: '2026-10-14', views: 2, visitors: 2, clicks: 5, shares: 1 });
    // Sent before clicks were counted: no click numbers, not zeros.
    expect(s.newsletter).toEqual([{ week_key: '2026-10-12', subject: 'This week', sent_on: '2026-10-12', recipients: 100, opens: 40,
      clickers: null, clicks: null }]);
  });

  it("counts an issue's email clickers once its clicks are tracked", () => {
    const t = activitySummary(rows, { now: NOW, days: 7, events: EVENTS, opens: {},
      sends: [{ ...sends[0], clicks_tracked: true }],
      emailClicks: [
        { week_key: '2026-10-12', subscriber_id: 's1', url: T, clicks: 2, first_at: '2026-10-12T13:00:00Z' },
        { week_key: '2026-10-12', subscriber_id: 's2', url: M, clicks: 1, first_at: '2026-10-12T14:00:00Z' }
      ] });
    expect(t.newsletter[0]).toMatchObject({ clickers: 2, clicks: 3 });
    expect(t.totals.newsletter_clickers).toBe(2);
  });

  it('counts visitors by the outside source that brought them, not page views', () => {
    const t = activitySummary([
      view('2026-10-14', '/', 'f', 'Facebook'), view('2026-10-14', T, 'f'), view('2026-10-14', M, 'f'), view('2026-10-14', '/', 'g')
    ], { now: NOW, days: 1 });
    expect(t.sources).toEqual([{ key: 'Facebook', count: 1 }, { key: 'Direct', count: 1 }]);
    expect(t.source_views).toEqual([{ key: 'Direct', count: 3 }, { key: 'Facebook', count: 1 }]);
  });

  it('carries no visitor ids', () => {
    expect(JSON.stringify(s)).not.toMatch(/"visitor"/);
  });
});

describe('GET /api/admin/activity', () => {
  const HQK = 'hq-reply-key-0123456789-0123456789-abc';
  async function startApp() {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-activity-'));
    const eventsFile = path.join(tmpDir, 'events.json');
    await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
    store = new FileStore(path.join(tmpDir, 's.json'));
    const { app } = await createApp({
      storeBundle: { kind: 'file', store }, eventsFile, trustProxy: false, now: () => NOW,
      siteUrl: 'https://www.thevic361.com', analyticsSecret: 'test', hqReplyKey: HQK,
      adminUsername: 'tristen', adminPassword: 'pw', adminSessionSecret: 'secret'
    });
    server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  }
  const get = (p, key) => fetch(baseUrl + p, { headers: key ? { Authorization: `Bearer ${key}` } : {} });

  it('answers the reply key at /api/hq/ only, and caps the days', async () => {
    await startApp();
    await store.recordTraffic(view('2026-10-14', T, 'a'));
    await store.recordTraffic(click('2026-10-14', T, 'a', 'share_native', `https://www.thevic361.com${T}`));
    expect((await get('/api/hq/admin/activity')).status).toBe(401);
    expect((await get('/api/admin/activity', HQK)).status).toBe(401);
    const r = await get('/api/hq/admin/activity?days=500', HQK);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ ok: true, days: 90, totals: { views: 1, shares: 1 } });
    expect((await (await get('/api/hq/admin/activity', HQK)).json()).days).toBe(7);
  });
});
