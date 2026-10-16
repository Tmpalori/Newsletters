// @vitest-environment node
//
// Each town's own colors (towns/<slug>/BRAND.md "Palette"): another town's
// /style.css and /submit.css are the shared files with its palette appended
// (server/palette.js), light and dark. Victoria's are served as they are.

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs, readFileSync, readdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { townConfig, useTown, VICTORIA, DOCS_DIR, brandPalette } from '../server/town.js';
import { townStyleCss, townSubmitCss, mix } from '../server/palette.js';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';

const TOWNS = path.join(DOCS_DIR, '..', 'towns');
const slugs = readdirSync(TOWNS).filter(id => existsSync(path.join(TOWNS, id, 'town.json')));
const STYLE = readFileSync(path.join(DOCS_DIR, 'style.css'), 'utf8');
const VIC_COLORS = ['#4B3FD1', '#FF7A3D', '#FFF4D6', '#1F1A3D', '#9D92FF', '#17142E', '#2B2370'];
// The value a variable ends up with: the last definition in a block for that selector.
const lastValue = (css, selector, name) => {
  const blocks = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m => m[1].trim() === selector);
  const vals = blocks.flatMap(m => [...m[2].matchAll(new RegExp(`${name}:\\s*([^;]+);`, 'g'))].map(v => v[1].trim()));
  return vals[vals.length - 1];
};

afterEach(() => useTown(VICTORIA));

describe('palette from BRAND.md', () => {
  it('every town has its own, none of them Victoria’s', () => {
    expect(slugs.length).toBeGreaterThan(0);
    for (const id of slugs) {
      const t = townConfig({ TOWN: id });
      const brand = readFileSync(path.join(TOWNS, id, 'BRAND.md'), 'utf8');
      expect(t.palette, id).toBeTruthy();
      expect(brand).toContain(`"primary": "${t.palette.light.primary}"`);
      expect(brand).toContain(`"primary": "${t.palette.dark.primary}"`);
      const css = townStyleCss(t);
      expect(lastValue(STYLE + css, ':root, [data-theme="light"]', '--color-primary'), id).toBe(t.palette.light.primary);
      expect(lastValue(STYLE + css, '[data-theme="dark"]', '--color-primary'), id).toBe(t.palette.dark.primary);
      expect(lastValue(STYLE + css, ':root, [data-theme="light"]', '--color-bg'), id).toBe(t.palette.light.paper);
      expect(lastValue(STYLE + css, '[data-theme="dark"]', '--color-text'), id).toBe(t.palette.dark.text);
      for (const c of VIC_COLORS) expect(css.toUpperCase(), `${id} ${c}`).not.toContain(c);
    }
  });

  it('Victoria has none, and gets no override', () => {
    expect(VICTORIA.palette).toBeNull();
    expect(townStyleCss(VICTORIA)).toBe('');
    expect(townSubmitCss(VICTORIA)).toBe('');
  });

  it('a town without BRAND.md keeps the stylesheet’s colors; a malformed palette stops the boot', async () => {
    expect(brandPalette(path.join(os.tmpdir(), 'no-such-town', 'BRAND.md'))).toBeNull();
    const base = { id: 'bay', siteName: 'The Bay 979', domain: 'thebay979.com', city: 'Bay City', state: 'TX', stateName: 'Texas', timezone: 'America/Chicago' };
    expect(townConfig({}, { town: base }).palette).toBeNull();
    expect(() => townConfig({}, { town: { ...base, palette: { light: { primary: 'red' }, dark: {} } } })).toThrow(/palette\.light\.primary/);
    // A stylesheet value can't break out of its declaration.
    const good = townConfig({ TOWN: 'lincoln' }).palette;
    expect(() => townConfig({}, { town: { ...base, palette: { ...good, dark: { ...good.dark, text: '#fff;}body{' } } } })).toThrow(/palette\.dark\.text/);
  });

  it('mixes shades', () => {
    expect(mix('#000000', '#FFFFFF', 0.5)).toBe('#808080');
    expect(mix('#2F3B73', '#2F3B73', 0.3)).toBe('#2F3B73');
  });
});

describe('a town’s site serves its colors', () => {
  async function serve(town) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-palette-'));
    const eventsFile = path.join(dir, 'events.json');
    await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
    const { app } = await createApp({ ...(town ? { town } : {}), storeBundle: { kind: 'file', store: new FileStore(path.join(dir, 's.json')) },
      eventsFile, trustProxy: false, startScheduler: false, slack: { enabled: false, notify: async () => false, alert: async () => false },
      siteUrl: town ? `https://www.${town.domain}` : 'https://www.thevic361.com' });
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    return { base, close: async () => { await new Promise(r => server.close(r)); await fs.rm(dir, { recursive: true, force: true }); } };
  }

  it('Lincoln: /style.css and /submit.css carry its palette after the shared rules', async () => {
    const raw = JSON.parse(readFileSync(path.join(TOWNS, 'lincoln', 'town.json'), 'utf8'));
    const s = await serve({ ...raw, id: 'lincoln', palette: brandPalette(path.join(TOWNS, 'lincoln', 'BRAND.md')) });
    try {
      const css = await fetch(s.base + '/style.css');
      expect(css.headers.get('content-type')).toMatch(/text\/css/);
      expect(css.headers.get('cache-control')).toBe('public, max-age=600');
      const text = await css.text();
      expect(text.startsWith(STYLE)).toBe(true);
      expect(lastValue(text, ':root, [data-theme="light"]', '--color-primary')).toBe('#2F3B73');
      expect(lastValue(text, ':root, [data-theme="light"]', '--color-accent')).toBe('#B04E32');
      expect(lastValue(text, '[data-theme="dark"]', '--color-primary')).toBe('#AEB8EE');
      expect(text).toMatch(/@media \(prefers-color-scheme: dark\) \{\s+:root:not\(\[data-theme\]\) \{[^}]*--color-primary: #AEB8EE;/);
      const submit = await (await fetch(s.base + '/submit.css')).text();
      expect(lastValue(submit, ':root', '--submit-primary')).toBe('#2F3B73');
      // Pages link the stylesheet with a hash that includes the palette.
      const home = await (await fetch(s.base + '/about')).text();
      expect(home).toMatch(/href="\/style\.css\?v=[0-9a-f]{10}"/);
    } finally { await s.close(); }
  });

  it('Victoria: the files as they are', async () => {
    const s = await serve(null);
    try {
      expect(await (await fetch(s.base + '/style.css')).text()).toBe(STYLE);
      expect(await (await fetch(s.base + '/submit.css')).text()).toBe(readFileSync(path.join(DOCS_DIR, 'submit.css'), 'utf8'));
    } finally { await s.close(); }
  });
});
