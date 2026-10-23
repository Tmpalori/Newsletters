// docs/app.js in another town (MULTI_CITY_PLAN.md 1.3c): it reads
// window.__TOWN__ (set by server/localize.js) for "today", the pick badge,
// the newsletter card and utm_source, and falls back to Victoria's values.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const APP_JS = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'app.js'), 'utf8');

function boot(town) {
  document.body.innerHTML = '<header id="site-header"></header><main>' +
    '<div id="events-container"></div><section id="sponsor-section"></section></main>';
  delete window.__vic361App;
  if (town) window.__TOWN__ = town; else delete window.__TOWN__;
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  window.fetch = () => new Promise(() => {});
  (0, eval)(APP_JS);
  return window.__vic361App;
}

afterEach(() => { vi.useRealTimers(); delete window.__TOWN__; });

const pick = { name: 'Gala', date: '2026-10-09', time: '7:00 PM', featured: true };
const sponsor = { name: 'Acme', url: 'https://acme.example/', text: 'Hi', cta: 'Go' };

describe('Victoria (no window.__TOWN__)', () => {
  it('keeps today’s behavior', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-10T04:30:00Z'));       // 11:30 PM Friday in Victoria
    const app = boot();
    expect(app.today()).toBe('2026-10-09');
    expect(app.renderEvent(pick)).toContain('<span class="badge badge--featured">Vic’s Pick</span>');
    expect(app.renderSponsor(sponsor)).toContain('utm_source=thevic361');
  });
});

describe('another town', () => {
  const BAY = { timezone: 'America/Los_Angeles', city: 'Bay City', pickName: 'Bay’s <Best>', utmSource: 'thebay979' };

  it('uses its own day, pick name and utm_source', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-10T06:30:00Z'));       // 1:30 AM Saturday in Central, 11:30 PM Friday in LA
    expect(boot().today()).toBe('2026-10-10');
    const app = boot(BAY);
    expect(app.today()).toBe('2026-10-09');
    const html = app.renderEvent(pick);
    expect(html).toContain('<span class="badge badge--featured">Bay’s &lt;Best&gt;</span>');
    expect(html).not.toContain('Vic’s Pick');
    expect(app.renderSponsor(sponsor)).toContain('utm_source=thebay979');
    expect(app.renderSponsor(sponsor)).not.toContain('thevic361');
  });
});
