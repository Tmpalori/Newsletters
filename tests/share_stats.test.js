// Share tracking on the server: visits from shared links (?s=sh, see
// docs/track.js) count as "Shared link", show in Vic's Pick reports, and
// every event's week is in the admin's Event stats.

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { beaconRow, SHARED_LINK } from '../server/analytics.js';
import { pickStats, eventWeekStats } from '../server/sponsors.js';
import { renderPickReport } from '../server/notify.js';

const NOW = new Date('2026-10-14T17:00:00Z'); // Wednesday; last week is Oct 5-11
let tmpDir, server, baseUrl, store;
afterEach(async () => {
  if (server) await new Promise(r => server.close(r));
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  server = null; tmpDir = null;
});

const view = (day, p, visitor, ref_source = 'Direct') => ({ day, kind: 'view', path: p, visitor, ref_source });
const click = (day, p, visitor, click_type, click_url = '') => ({ day, kind: 'click', path: p, visitor, click_type, click_url });

describe('shared links', () => {
  it('a beacon from a shared link is a "Shared link" visit, whatever app opened it', () => {
    const opts = { ip: '1.2.3.4', ua: 'Mozilla/5.0 (iPhone)', secret: 's', siteHost: 'www.thevic361.com', now: NOW };
    expect(beaconRow({ kind: 'view', path: '/events/x', ref: 'https://m.facebook.com/', via: 'share' }, opts).ref_source).toBe(SHARED_LINK);
    expect(beaconRow({ kind: 'view', path: '/events/x', ref: 'https://m.facebook.com/' }, opts).ref_source).toBe('Facebook');
  });

  it('a Vic\'s Pick report counts the visits its shares brought', () => {
    const page = '/events/2026-10-10-farmers-market';
    const rows = [
      view('2026-10-09', page, 'a'), view('2026-10-09', page, 'b', SHARED_LINK), view('2026-10-10', page, 'c', SHARED_LINK),
      click('2026-10-09', page, 'a', 'share_native', `https://www.thevic361.com${page}`)
    ];
    const stats = pickStats({ id: 'ord-12345678' }, rows, { start: '2026-10-08', end: '2026-10-10', pages: [page] });
    expect(stats).toMatchObject({ page_views: 3, shares: 1, share_visits: 2, share_people: 2 });
    const mail = renderPickReport({ business: 'Market', event: { name: 'Farmers Market' } }, stats, { siteUrl: 'https://www.thevic361.com', address: 'a' });
    expect(mail.text).toContain('Opened it from a shared link');
  });
});

describe('event stats', () => {
  it('every event that week, from a week before its date, with only its own taps and shares', () => {
    const T = '/events/2026-10-09-trivia', M = '/events/2026-10-10-market';
    const events = [
      { date: '2026-10-09', name: 'Trivia', venue: 'Pub', page: T, url: 'https://pub.example/trivia' },
      { date: '2026-10-10', name: 'Market', venue: 'Square', page: M, url: 'https://market.example' },
      { date: '2026-10-20', name: 'Later', page: '/events/2026-10-20-later' }
    ];
    const rows = [
      view('2026-10-03', T, 'early'),                                       // the week before: counts (lead-in)
      view('2026-10-01', T, 'z'),                                           // more than 7 days before: doesn't
      view('2026-10-08', T, 'a'), view('2026-10-09', T, 'b', SHARED_LINK),
      view('2026-10-10', T, 'late'),                                        // after its date: doesn't
      click('2026-10-08', '/this-weekend', 'a', 'event_click', 'https://pub.example/trivia'), // from a list: counts
      click('2026-10-08', T, 'a', 'share_native', `https://www.thevic361.com${T}`),
      click('2026-10-08', T, 'a', 'share_facebook', 'https://www.facebook.com/sharer/sharer.php?u=x'),
      // On Trivia's page, its "Also on" list: Market's link and share icon belong to Market.
      click('2026-10-08', T, 'a', 'event_click', 'https://market.example'),
      click('2026-10-08', T, 'a', 'share_from_list', `https://www.thevic361.com${M}`),
      view('2026-10-10', M, 'c'),
      // Seen in a list (data-seen): on the homepage counts, on its own page
      // doesn't; Market seen in Trivia's "Also on" list is Market's.
      { day: '2026-10-08', kind: 'sighting', path: '/', click_url: T, visitor: 'a' },
      { day: '2026-10-08', kind: 'sighting', path: T, click_url: T, visitor: 'a' },
      { day: '2026-10-09', kind: 'sighting', path: T, click_url: M, visitor: 'b', n: 2 }
    ];
    const [trivia, market] = eventWeekStats(rows, events, { start: '2026-10-05', end: '2026-10-11' });
    expect(trivia).toEqual({ page: T, name: 'Trivia', venue: 'Pub', date: '2026-10-09', counted_from: '2026-10-02', shown: 1, shown_people: 1,
      page_views: 3, page_people: 3, link_clicks: 1, link_people: 1, calendar_adds: 0, shares: 2, share_visits: 1 });
    expect(market).toEqual({ page: M, name: 'Market', venue: 'Square', date: '2026-10-10', counted_from: '2026-10-03', shown: 2, shown_people: 1,
      page_views: 1, page_people: 1, link_clicks: 0, link_people: 0, calendar_adds: 0, shares: 1, share_visits: 0 });
  });

  it('the admin endpoint defaults to last week and needs a login', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-ev-'));
    const eventsFile = path.join(tmpDir, 'events.json');
    await fs.writeFile(eventsFile, JSON.stringify({ events: [{ date: '2026-10-09', name: 'Trivia Night', venue: 'Pub', time: '7 PM' }] }));
    store = new FileStore(path.join(tmpDir, 's.json'));
    const { app } = await createApp({
      storeBundle: { kind: 'file', store }, eventsFile, trustProxy: false, now: () => NOW,
      siteUrl: 'https://www.thevic361.com', adminUsername: 'a', adminPassword: 'b', adminSessionSecret: 'c'
    });
    server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    const page = (await (await fetch(baseUrl + '/events.json')).json()).events[0].page;
    await store.recordTraffic(view('2026-10-09', page, 'a', SHARED_LINK));
    expect((await fetch(baseUrl + '/api/admin/event-stats')).status).toBe(401);
    const login = await fetch(baseUrl + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'a', password: 'b' }) });
    const h = { Authorization: `Bearer ${(await login.json()).token}` };
    const d = await (await fetch(baseUrl + '/api/admin/event-stats', { headers: h })).json();
    expect(d).toMatchObject({ ok: true, week_start: '2026-10-05', week_end: '2026-10-11', this_week: false });
    expect(d.events).toMatchObject([{ name: 'Trivia Night', page, page_views: 1, share_visits: 1 }]);
    const cur = await (await fetch(baseUrl + '/api/admin/event-stats?week=2026-10-14', { headers: h })).json();
    expect(cur).toMatchObject({ week_start: '2026-10-12', this_week: true, events: [] });
  });
});
