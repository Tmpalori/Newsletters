// @vitest-environment node
//
// A town's own static files (MULTI_CITY_PLAN.md 1.3a, 1.3e): towns/<slug>/
// public/ is served ahead of docs/, the share-card logo comes from it, and
// robots.txt names the town's sitemap. Victoria has no overlay.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { townConfig, useTown, VICTORIA, townAssetPath, DOCS_DIR } from '../server/town.js';
import { eventCardSvg } from '../server/ogImage.js';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';

const BAY = { siteName: 'The Bay 979', domain: 'thebay979.com', city: 'Bay City', state: 'TX', stateName: 'Texas', timezone: 'America/Chicago' };
const LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>bay-logo</title></svg>';
let towns;

beforeAll(async () => {
  towns = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-towns-'));
  await fs.mkdir(path.join(towns, 'bay', 'public'), { recursive: true });
  await fs.writeFile(path.join(towns, 'bay', 'town.json'), JSON.stringify(BAY));
  await fs.writeFile(path.join(towns, 'bay', 'public', 'logo.png'), 'BAY-LOGO-PNG');
  await fs.writeFile(path.join(towns, 'bay', 'public', 'logo.svg'), LOGO_SVG);
});
afterAll(async () => {
  useTown(VICTORIA);
  await fs.rm(towns, { recursive: true, force: true });
});

describe('townAssetPath', () => {
  it('is docs/ for Victoria', () => {
    expect(VICTORIA.publicDir).toBeUndefined();
    expect(townAssetPath('logo.png', VICTORIA)).toBe(path.join(DOCS_DIR, 'logo.png'));
  });

  it('prefers the town’s own copy, falls back to docs/, and never leaves its folder', () => {
    const t = townConfig({ TOWN: 'bay' }, { townsDir: towns });
    expect(t.publicDir).toBe(path.join(towns, 'bay', 'public'));
    expect(townAssetPath('logo.png', t)).toBe(path.join(towns, 'bay', 'public', 'logo.png'));
    expect(townAssetPath('style.css', t)).toBe(path.join(DOCS_DIR, 'style.css'));
    expect(townAssetPath('../town.json', t)).toBe(path.join(DOCS_DIR, '../town.json'));
  });

  it('draws the town’s logo on share cards', () => {
    const ev = { name: 'Fish Fry', date: '2026-10-09', time: '6:00 PM', venue: 'Hall', page: '/events/2026-10-09-fish-fry' };
    useTown(VICTORIA);
    const vic = eventCardSvg(ev);
    useTown(townConfig({ TOWN: 'bay' }, { townsDir: towns }));
    const bay = eventCardSvg(ev);
    expect(bay).toContain(Buffer.from(LOGO_SVG).toString('base64'));
    expect(vic).not.toContain(Buffer.from(LOGO_SVG).toString('base64'));
    useTown(VICTORIA);
  });
});

describe('a town’s site serves its own files', () => {
  let tmpDir, server, base, saved;
  beforeAll(async () => {
    saved = process.env.TOWN;
    process.env.TOWN = 'bay';
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-assets-'));
    const eventsFile = path.join(tmpDir, 'events.json');
    await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
    const { app } = await createApp({ townsDir: towns, storeBundle: { kind: 'file', store: new FileStore(path.join(tmpDir, 's.json')) },
      eventsFile, trustProxy: false, slack: { enabled: false, notify: async () => false, alert: async () => false } });
    server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    if (saved === undefined) delete process.env.TOWN; else process.env.TOWN = saved;
    useTown(VICTORIA);
    if (server) await new Promise(r => server.close(r));
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('its logo from its folder, the rest from docs/', async () => {
    const logo = await fetch(base + '/logo.png');
    expect(logo.status).toBe(200);
    expect(await logo.text()).toBe('BAY-LOGO-PNG');
    expect(logo.headers.get('cache-control')).toBe('public, max-age=86400');
    const css = await fetch(base + '/style.css');
    expect(css.status).toBe(200);
    expect(await css.text()).toBe(await fs.readFile(path.join(DOCS_DIR, 'style.css'), 'utf8'));
  });

  it('robots.txt names its sitemap, or is its own copy', async () => {
    const robots = await (await fetch(base + '/robots.txt')).text();
    expect(robots).toContain('Sitemap: https://www.thebay979.com/sitemap.xml');
    expect(robots).not.toContain('thevic361');
    await fs.writeFile(path.join(towns, 'bay', 'public', 'robots.txt'), 'User-agent: *\nDisallow: /\n');
    expect(await (await fetch(base + '/robots.txt')).text()).toBe('User-agent: *\nDisallow: /\n');
    await fs.rm(path.join(towns, 'bay', 'public', 'robots.txt'));
  });
});


describe('a new town never serves Victoria’s data from docs/', () => {
  let tmpDir, server, base, saved;
  beforeAll(async () => {
    saved = process.env.TOWN;
    process.env.TOWN = 'bay';
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-isolation-'));
    // No eventsFile and nothing published: the town has no list of its own yet.
    const { app } = await createApp({ townsDir: towns, storeBundle: { kind: 'file', store: new FileStore(path.join(tmpDir, 's.json')) },
      trustProxy: false, slack: { enabled: false, notify: async () => false, alert: async () => false } });
    server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    if (saved === undefined) delete process.env.TOWN; else process.env.TOWN = saved;
    useTown(VICTORIA);
    if (server) await new Promise(r => server.close(r));
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('events.json is empty, not Victoria’s bundled list', async () => {
    const res = await fetch(base + '/events.json');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ last_updated: null, events: [] });
  });

  it('Victoria’s social kit is not served', async () => {
    const res = await fetch(base + '/social/latest/kit.json');
    expect(res.status).toBe(404);
  });

  // express.static decodes %-escapes, so other spellings must be caught too.
  it('no URL spelling reaches Victoria’s raw events, social kit, homepage or submit form', async () => {
    for (const p of ['/%65vents.json', '/EVENTS.JSON']) {
      const res = await fetch(base + p);
      expect(await res.json()).toEqual({ last_updated: null, events: [] });
    }
    for (const p of ['/%73ocial/latest/index.html', '/Social/latest/kit.json']) {
      expect((await fetch(base + p, { redirect: 'manual' })).status).toBe(404);
    }
    for (const [p, to] of [['/index', '/'], ['/%69ndex.html', '/'], ['/%73ubmit', '/submit'], ['/%73ubmit.html', '/submit']]) {
      const res = await fetch(base + p, { redirect: 'manual' });
      expect([res.status, res.headers.get('location')]).toEqual([301, to]);
    }
  });
});

describe('a town with its own social kit (stored by its jobs worker) still never serves Victoria’s', () => {
  let tmpDir, server, base, saved, store;
  beforeAll(async () => {
    saved = process.env.TOWN;
    process.env.TOWN = 'bay';
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-social-own-'));
    store = new FileStore(path.join(tmpDir, 's.json'));
    await store.putSocialFile('b1', 'today-1.png', 'image/png', Buffer.from('BAY-SLIDE'));
    await store.putSocialFile('b1', 'kit.json', 'application/json', Buffer.from('{"build":"b1"}'));
    await store.publishSocialKit('b1', { files: 2 });
    const { app } = await createApp({ townsDir: towns, storeBundle: { kind: 'file', store },
      trustProxy: false, slack: { enabled: false, notify: async () => false, alert: async () => false } });
    server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    if (saved === undefined) delete process.env.TOWN; else process.env.TOWN = saved;
    useTown(VICTORIA);
    if (server) await new Promise(r => server.close(r));
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('serves its own slide and manifest, under any spelling that means them', async () => {
    for (const p of ['/social/latest/today-1.png', '/%73ocial/latest/today-1.png']) {
      const res = await fetch(base + p);
      expect([res.status, await res.text()]).toEqual([200, 'BAY-SLIDE']);
    }
    expect(await (await fetch(base + '/social/latest/kit.json')).json()).toEqual({ build: 'b1' });
  });

  it('Victoria’s files in docs/social are 404s however they are asked for', async () => {
    for (const p of ['/social/latest/week-1.png', '/social/latest/weekend.mp4', '/social/latest/captions.txt', '/social/latest/index.html',
      '/social/latest/posted.json', '/%73ocial/latest/week-1.png', '/Social/latest/today-1.png', '/social/latest/../latest/week-1.png', '/social/x.png']) {
      expect((await fetch(base + p, { redirect: 'manual' })).status, p).toBe(404);
    }
  });
});
