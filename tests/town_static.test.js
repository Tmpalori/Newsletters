// @vitest-environment node
//
// docs/index.html (the homepage template) and docs/submit.html are
// Victoria's; another town gets them rewritten by server/localize.js
// (MULTI_CITY_PLAN.md 1.3b). Victoria's are pinned by tests/golden/.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { townConfig, useTown, VICTORIA } from '../server/town.js';
import { localizeHtml } from '../server/localize.js';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.join(HERE, '..', 'docs');
const FIXTURE = JSON.parse(readFileSync(path.join(HERE, 'golden', 'fixture.json'), 'utf8'));
const NOW = new Date('2026-10-07T17:00:00Z');
const BAY = { id: 'bay', siteName: 'The Bay 979', siteNameHtml: 'The Bay <span>979</span>', domain: 'thebay979.com', city: 'Bay City', state: 'TX',
  stateName: 'Texas', timezone: 'America/Chicago', pickName: 'Bay’s Best', areaCode: '979', gaId: 'G-TESTBAY979',
  business: { pickAmount: { weekday: 2950, weekend: 5900 } } };
// Victoria's identity in a static page (the vic361-theme storage key is
// per-browser state, not identity, and stays).
const LEAK = /.{0,40}(Victoria|Vic 361|The Vic\b|Vic(’|&rsquo;|')s Pick|thevic361\.com|G-52YHD3X3C2|\$49|\$89|\b361\b).{0,30}/g;

afterAll(() => useTown(VICTORIA));

describe('localizeHtml', () => {
  const index = readFileSync(path.join(DOCS, 'index.html'), 'utf8');
  const submit = readFileSync(path.join(DOCS, 'submit.html'), 'utf8');

  it('derives utm_source from the domain, and checks it', () => {
    expect(VICTORIA.utmSource).toBe('thevic361');
    expect(townConfig({}, { town: BAY }).utmSource).toBe('thebay979');
    expect(() => townConfig({}, { town: { ...BAY, utmSource: 'Bay City' } })).toThrow(/utmSource/);
  });

  it('leaves Victoria’s pages exactly as they are', () => {
    expect(localizeHtml(index, VICTORIA)).toBe(index);
    expect(localizeHtml(submit, VICTORIA)).toBe(submit);
  });

  it('rewrites them for another town, leaving none of Victoria behind', () => {
    const t = townConfig({}, { town: BAY });
    for (const [name, page] of [['index', index], ['submit', submit]]) {
      const out = localizeHtml(page, t);
      expect(out.match(LEAK), name).toBe(null);
    }
    expect(localizeHtml(index, t)).toContain("K='vic361-theme'");
    const home = localizeHtml(index, t);
    expect(home).toContain('<title>The Bay 979 — Events & Things To Do in Bay City, TX</title>');
    expect(home).toContain('<link rel="canonical" href="https://www.thebay979.com/">');
    expect(home).toContain('<div class="site-title">The Bay <span>979</span></div>');
    expect(home).toContain('gtag/js?id=G-TESTBAY979');
    expect(home).toContain('happening this week in the 979.');
    const form = localizeHtml(submit, t);
    expect(form).toContain('Make it a Bay&rsquo;s Best');
    expect(form).not.toMatch(/\$\d/); // prices stay on the sponsor pages
    expect(form).toContain('placeholder="(979) 555-0123"');
    expect(form).toContain('placeholder="123 Main St, Bay City, TX"');
  });

  it('drops the Google tag for a town without a GA ID, and the area code without one', () => {
    const t = townConfig({}, { town: { ...BAY, gaId: undefined, areaCode: undefined } });
    const home = localizeHtml(index, t);
    expect(home).not.toContain('googletagmanager');
    expect(home).not.toContain('gtag(');
    expect(home).toContain('happening this week in Bay City.');
    expect(localizeHtml(submit, t)).toContain('placeholder="(555) 555-0123"');
  });
});

describe('a second town’s homepage and submit form, served', () => {
  let tmpDir, server, base;
  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-static-'));
    const eventsFile = path.join(tmpDir, 'events.json');
    const scrub = v => JSON.parse(JSON.stringify(v).replace(/Victoria/g, 'Bay City'));
    await fs.writeFile(eventsFile, JSON.stringify(scrub({ events: FIXTURE.events, sponsor: FIXTURE.sponsor })));
    const { app } = await createApp({
      town: BAY, storeBundle: { kind: 'file', store: new FileStore(path.join(tmpDir, 's.json')) }, eventsFile,
      trustProxy: false, now: () => NOW, resendApiKey: '',
      slack: { enabled: false, notify: async () => false, alert: async () => false }
    });
    server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    useTown(VICTORIA);
    if (server) await new Promise(r => server.close(r));
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('tells docs/app.js which town it is', async () => {
    const home = await (await fetch(base + '/')).text();
    expect(home).toContain('<script>window.__TOWN__={"timezone":"America/Chicago","city":"Bay City","pickName":"Bay’s Best","utmSource":"thebay979"};</script>');
    expect(home.indexOf('window.__TOWN__')).toBeLessThan(home.search(/<script src="[^"]*app\.js/));
    expect(home.search(/<script src="[^"]*app\.js/)).toBeGreaterThan(0);
    expect(home).not.toContain('utm_source=thevic361');
  });

  it('says nothing of Victoria', async () => {
    for (const p of ['/', '/index.html', '/?preview=1', '/submit', '/submit.html']) {
      const r = await fetch(base + p);
      expect(r.status, p).toBe(200);
      expect((await r.text()).match(LEAK), p).toBe(null);
    }
  });
});
