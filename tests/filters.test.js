// Homepage filter chips (docs/app.js). They filter the events already in
// the page, which the server renders with data-icons on every entry.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_JS = readFileSync(resolve(ROOT, 'docs', 'app.js'), 'utf8');

function day(idx, entries) {
  return `<section class="day-section" id="day-${idx}"><ul class="event-list">` +
    entries.map(([name, icons]) => `<li class="event-entry" data-icons="${icons}">${name}</li>`).join('') +
    '</ul></section>';
}

function boot() {
  document.body.innerHTML = '<main><div id="events-container">' +
    day(0, [['Mon Trivia', 'drinks community'], ['Story Time', 'family free']]) +
    day(1, []) + day(2, []) + day(3, []) +
    day(4, [['Fri Concert', 'music']]) + day(5, [['Sat Market', 'food shopping free']]) + day(6, []) +
    '</div></main>';
  delete window.__vic361App;
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  // Never resolves, so loadAndRender doesn't replace our fixture DOM.
  window.fetch = () => new Promise(() => {});
  (0, eval)(APP_JS);
  return window.__vic361App;
}

const visible = () => [...document.querySelectorAll('.event-entry')].filter(li => !li.hidden && !li.closest('.day-section').hidden).map(li => li.textContent);

// jsdom doesn't lay pages out, so the tests above only see li.hidden. The
// browser shows a hidden element anyway when a display rule beats the
// attribute (.event-entry is display:flex): base.css must force it.
describe('hidden events really disappear', () => {
  it('base.css makes [hidden] display:none !important, and every public page loads it', () => {
    const css = readFileSync(resolve(ROOT, 'docs', 'base.css'), 'utf8');
    expect(css).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
    const seo = readFileSync(resolve(ROOT, 'server', 'seo.js'), 'utf8');
    expect(seo).toContain('<link rel="stylesheet" href="/base.css">');
    const index = readFileSync(resolve(ROOT, 'docs', 'index.html'), 'utf8');
    expect(index).toContain('href="./base.css"');
  });
});

describe('homepage filters', () => {
  it('renders the chip bar above the list', () => {
    boot();
    const chips = [...document.querySelectorAll('#event-filters .filter-chip')].map(b => b.textContent);
    expect(chips).toEqual(['All', 'Today', 'This weekend', 'Free', 'Kids & Family', 'Music', 'Food & Drink', 'Arts',
      'Outdoors', 'Community', 'Shopping', 'Next week →']);
    // The category chips carry their icons (the row is the icon key).
    const icons = b => [...b.querySelectorAll('use')].map(u => u.getAttribute('href'));
    expect(icons(document.querySelector('[data-filter="music"]'))).toEqual(['icons.svg#i-music']);
    expect(icons(document.querySelector('[data-filter="food drinks"]'))).toEqual(['icons.svg#i-food', 'icons.svg#i-drinks']);
    expect(icons(document.querySelector('[data-filter="all"]'))).toEqual([]);
    expect(document.querySelector('#event-filters a.filter-chip').getAttribute('href')).toBe('/next-week');
  });

  it('Today shows only today, and the past group goes when it has nothing showing', () => {
    document.body.innerHTML = '<main><div id="events-container"><details class="past-days">' +
      day(0, [['Mon Trivia', 'drinks']]) + day(1, [['Tue Tacos', 'food']]) + '</details>' +
      '<section class="day-section" id="day-2"><h2 class="day-name">Wednesday <span class="today-badge">Today</span></h2>' +
      '<ul class="event-list"><li class="event-entry" data-icons="music">Wed Jazz</li></ul></section>' +
      day(3, [['Thu Market', 'food']]) + day(4, []) + day(5, []) + day(6, []) + '</div></main>';
    delete window.__vic361App;
    window.fetch = () => new Promise(() => {});
    (0, eval)(APP_JS);
    const app = window.__vic361App;
    const group = document.querySelector('.past-days');
    app.applyFilter('today');
    expect(visible()).toEqual(['Wed Jazz']);
    expect(group.hidden).toBe(true);
    app.applyFilter('food drinks');
    expect(group.hidden).toBe(false);
    app.applyFilter('weekend');
    expect(group.hidden).toBe(true);
    app.applyFilter('all');
    expect(group.hidden).toBe(false);
    expect(visible().length).toBe(4);
  });

  it('filters by category, free, and weekend', () => {
    const app = boot();
    app.applyFilter('free');
    expect(visible()).toEqual(['Story Time', 'Sat Market']);
    app.applyFilter('food drinks');
    expect(visible()).toEqual(['Mon Trivia', 'Sat Market']);
    app.applyFilter('weekend');
    expect(visible()).toEqual(['Fri Concert', 'Sat Market']);
    app.applyFilter('all');
    expect(visible().length).toBe(4);
  });

  it('chip clicks update aria-pressed', () => {
    boot();
    document.querySelector('[data-filter="music"]').click();
    expect(document.querySelector('[data-filter="music"]').getAttribute('aria-pressed')).toBe('true');
    expect(visible()).toEqual(['Fri Concert']);
  });
});
