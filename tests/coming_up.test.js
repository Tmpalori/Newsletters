// @vitest-environment jsdom
//
// "Coming up" on the homepage (big events after this week) and nearby-town
// events (ev.town): the badge, the page's lead, schema and calendar links.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  comingUpEvents, renderComingUp, renderHome, renderEventItem, renderEventPage, eventJsonLd, withPages, townOf
} from '../server/seo.js';
import { renderIcs, googleCalendarUrl } from '../server/guides.js';

const SITE = 'https://www.thevic361.com';
const NOW = new Date('2026-10-07T17:00:00Z'); // Wednesday Oct 7; week is Oct 5–11
const TODAY = '2026-10-07';

const EVENTS = withPages([
  { date: '2026-10-09', name: 'This Week Big Thing', venue: 'DeLeon Plaza', big: true },
  { date: '2026-10-17', name: 'Uniting Hearts Music Festival', venue: 'DeLeon Plaza', address: '101 N. Main St.', big: true },
  { date: '2026-10-17', name: 'Plain Trunk or Treat', venue: 'Somewhere' },
  { date: '2026-10-24', name: 'Paid Pick', venue: 'Moonshine Drinkery', featured: true },
  { date: '2026-10-09', name: 'Cuero Turkeyfest', venue: 'Downtown Cuero', town: 'Cuero', big: true },
  { date: '2026-10-16', name: 'Yorktown Western Days', venue: 'Downtown Yorktown', town: 'Yorktown', big: true },
  { date: '2026-10-17', name: 'Yorktown Western Days', venue: 'Downtown Yorktown', town: 'Yorktown', big: true },
  { date: '2026-12-05', name: 'Crossroads Pickle Festival', venue: 'Gary Moses Victoria Community Center', big: true },
  { date: '2027-03-20', name: 'Too Far Out', venue: 'DeLeon Plaza', big: true }
]);

describe('coming up', () => {
  it('lists big events and Vic’s Picks after this week, one line per event, within 90 days', () => {
    const names = comingUpEvents(EVENTS, TODAY).map(e => `${e.date} ${e.name}`);
    expect(names).toEqual([
      '2026-10-16 Yorktown Western Days',
      '2026-10-17 Uniting Hearts Music Festival',
      '2026-10-24 Paid Pick',
      '2026-12-05 Crossroads Pickle Festival'
    ]);
  });

  it('leaves out a festival already running this week', () => {
    const evs = withPages([
      { date: '2026-10-11', name: 'Harvest Days', venue: 'X', big: true },
      { date: '2026-10-12', name: 'Harvest Days', venue: 'X', big: true },
      { date: '2026-10-20', name: 'Other Fest', venue: 'Y', big: true }
    ]);
    expect(comingUpEvents(evs, TODAY).map(e => e.name)).toEqual(['Other Fest']);
  });

  it('shows 4, folds the rest behind Show more, and caps at 20', () => {
    const many = withPages(Array.from({ length: 25 }, (_, i) => ({
      date: `2026-11-${String(i + 1).padStart(2, '0')}`, name: `Fest ${i}`, venue: 'X', big: true
    })));
    expect(comingUpEvents(many, TODAY)).toHaveLength(20);
    const html = renderComingUp(many, TODAY);
    const [shown, folded] = html.split('<details class="coming-more">');
    expect((shown.match(/class="coming-item"/g) || []).length).toBe(4);
    expect((folded.match(/class="coming-item"/g) || []).length).toBe(16);
    expect(folded).toContain('<span class="when-closed">Show 16 more</span>');
    const few = renderComingUp(many.slice(0, 3), TODAY);
    expect(few).not.toContain('coming-more');
  });

  it('renders cards with date, name and a nearby label, escaped', () => {
    const html = renderComingUp(withPages([
      { date: '2026-10-31', name: 'Boo-Fest <b>', venue: 'Downtown Port Lavaca', town: 'Port Lavaca', big: true },
      { date: '2026-11-01', name: 'Turkeyfest', venue: 'City Park', town: 'Cuero', big: true }
    ]), TODAY);
    expect(html).toContain('<span class="coming-where">City Park · Nearby · Cuero</span>');
    expect(html).toContain('<h2 class="section-heading" id="coming-up-heading">Coming up</h2>');
    expect(html).toContain('<span class="coming-date">Sat, Oct 31</span>');
    expect(html).toContain('Boo-Fest &lt;b&gt;');
    expect(html).toContain('<span class="coming-where">Downtown Port Lavaca · Nearby</span>');
    expect(html).toMatch(/href="\/events\/2026-10-31-boo-fest/);
    expect(renderComingUp([], TODAY)).toBe('');
  });

  it('tags paid picks for impression counting, never editor’s picks or big events', () => {
    const html = renderComingUp(withPages([
      { date: '2026-10-24', name: 'Paid Pick', venue: 'Moonshine', featured: true, sponsor_order: 'ord-12345678' },
      { date: '2026-10-25', name: 'Editor Pick', venue: 'X', featured: true, editor_pick: true, big: true, sponsor_order: 'ord-87654321' },
      { date: '2026-10-26', name: 'Big Fest', venue: 'Y', big: true }
    ]), TODAY);
    expect(html).toContain('<li class="coming-item" data-ad="ord-12345678"><a href="/events/2026-10-24-paid-pick">');
    expect(html).not.toContain('ord-87654321');
    expect(html.match(/data-ad=/g)).toHaveLength(1);
  });

  it('computes the homepage footer year', () => {
    const template = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'index.html'), 'utf8');
    const page = renderHome(template, [], { siteUrl: SITE, now: new Date('2027-01-01T18:00:00Z') });
    expect(page).toContain('&copy; <span data-year>2027</span> The Vic 361');
  });

  it('fills the homepage slot, and the real template has the slot', () => {
    const tpl = '<head></head><!--NAV--><p class="loading-message">Loading events...</p><!--COMING_UP-->';
    const page = renderHome(tpl, EVENTS, { siteUrl: SITE, now: NOW });
    expect(page).toContain('<section class="coming-up" id="coming-up"');
    expect(page).not.toContain('<!--COMING_UP');
    const empty = renderHome(tpl, [], { siteUrl: SITE, now: NOW });
    expect(empty).not.toContain('coming-up');
    const template = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'index.html'), 'utf8');
    expect(template).toContain('<!--COMING_UP-->');
    // The jump link above the list is gone (the button row was cleaned up).
    expect(template).not.toContain('<!--COMING_UP_LINK-->');
  });
});

describe('nearby-town events', () => {
  const [ev] = withPages([{ date: '2026-10-09', name: 'Cuero Turkeyfest', time: '10:00 AM', venue: 'Downtown Cuero', town: 'Cuero' }]);

  it('says the right town on the page, in schema and in calendar links', () => {
    expect(townOf(ev)).toBe('Cuero');
    expect(townOf({})).toBe('Victoria');
    const page = renderEventPage(ev, [ev], { siteUrl: SITE, now: NOW, image: null });
    expect(page).toContain('at Downtown Cuero in Cuero, TX.');
    expect(eventJsonLd(ev, SITE).location.address.addressLocality).toBe('Cuero');
    expect(renderIcs(ev, { siteUrl: SITE, now: NOW })).toContain('LOCATION:Downtown Cuero\\, Cuero\\, TX');
    expect(decodeURIComponent(googleCalendarUrl(ev, SITE)).replace(/\+/g, ' ')).toContain('location=Downtown Cuero, Cuero, TX');
  });

  it('Victoria events are unchanged', () => {
    const [vic] = withPages([{ date: '2026-10-09', name: 'Trivia', venue: 'Aero Crafters' }]);
    expect(eventJsonLd(vic, SITE).location.address.addressLocality).toBe('Victoria');
    expect(renderEventItem(vic)).not.toContain('badge--nearby');
  });

  it('list items get a Nearby badge, the same from server and docs/app.js', () => {
    const server = renderEventItem(ev);
    expect(server).toContain('<span class="badge badge--nearby">Nearby · Cuero</span>');
    document.body.innerHTML = '<header id="site-header"></header><main><div id="events-container"></div><section id="sponsor-section"></section></main>';
    delete window.__vic361App;
    window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    window.fetch = () => new Promise(() => {});
    (0, eval)(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'app.js'), 'utf8'));
    expect(window.__vic361App.renderEvent(ev)).toContain('<span class="badge badge--nearby">Nearby · Cuero</span>');
  });
});
