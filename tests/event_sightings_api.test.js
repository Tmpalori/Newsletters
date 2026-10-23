// @vitest-environment node
//
// Sightings through the real app: the homepage tags a submitted event with
// data-seen, and /api/track stores its sightings (kind 'sighting', the
// event's page in click_url), at most 20 per address per event per day so
// nobody can pad a recap (server/index.js adBeaconAllowed).

import { describe, it, expect, afterEach } from 'vitest';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { withPages } from '../server/seo.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1';
const EVENTS = withPages([
  { date: '2026-10-09', name: 'Friday Live Music', time: '8:00 PM', venue: 'Aero Crafters' },
  { date: '2026-10-10', name: 'Fall Fest', time: '10:00 AM', venue: 'De Leon Plaza', submitted: true }
]);
const PAGE = EVENTS[1].page;

let tmpDir, server, baseUrl, store;

async function startApp() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-sightings-'));
  const eventsFile = path.join(tmpDir, 'events.json');
  await fs.writeFile(eventsFile, JSON.stringify({ events: EVENTS }));
  store = new FileStore(path.join(tmpDir, 's.json'));
  const { app } = await createApp({
    storeBundle: { kind: 'file', store }, eventsFile, trustProxy: false, now: () => new Date('2026-10-07T17:00:00Z'),
    siteUrl: 'https://www.thevic361.com', analyticsSecret: 'test',
    adminUsername: 'a', adminPassword: 'b', adminSessionSecret: 'c', resendApiKey: '',
    trackLimiter: { check: () => ({ ok: true }) }
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

const beacon = body => fetch(baseUrl + '/api/track', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify(body)
});

describe('sightings through the app', () => {
  it('the homepage tags the submitted event, not the collected one', async () => {
    await startApp();
    const home = await (await fetch(baseUrl + '/')).text();
    const tagged = [...home.matchAll(/<li class="event-entry[^"]*" data-seen="([^"]+)"/g)].map(m => m[1]);
    expect(tagged).toEqual([PAGE]);
  });

  it('stores them, 20 a day per address per event', async () => {
    await startApp();
    for (let i = 0; i < 25; i++) await beacon({ kind: 'sighting', page: PAGE, path: '/' });
    await beacon({ kind: 'sighting', page: '/events/2026-10-09-friday-live-music', path: '/today' });
    await beacon({ kind: 'sighting', page: '/not-an-event', path: '/' });
    let rows = [];
    for (let t = 0; t < 2000 && rows.length < 21; t += 20) {
      rows = await store.listTraffic('2026-01-01');
      await new Promise(r => setTimeout(r, 20));
    }
    await new Promise(r => setTimeout(r, 50)); // room for a wrongly stored row
    rows = await store.listTraffic('2026-01-01');
    expect(rows.filter(r => r.click_url === PAGE)).toHaveLength(20);
    expect(rows.find(r => r.click_url === PAGE)).toMatchObject({ kind: 'sighting', path: '/', visitor: expect.any(String) });
    expect(rows.filter(r => r.click_url !== PAGE)).toEqual([expect.objectContaining({ kind: 'sighting', path: '/today' })]);
  });
});
