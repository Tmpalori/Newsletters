// docs/app.js re-renders the homepage in the browser; these check it stays
// in step with server/seo.js (times, folded past days, sponsor link) and
// that filter messages fit the day they're on.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { formatTime as serverFormatTime, renderDays, withPages, parseTimes } from '../server/seo.js';

const APP_JS = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'app.js'), 'utf8');

function boot(containerHtml, fetchImpl = () => new Promise(() => {})) {
  document.body.innerHTML = '<header id="site-header"></header><main>' +
    `<div id="events-container">${containerHtml}</div><section id="sponsor-section"></section></main>`;
  delete window.__vic361App;
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  window.fetch = fetchImpl;
  (0, eval)(APP_JS);
  return window.__vic361App;
}

afterEach(() => { vi.useRealTimers(); });

describe('docs/app.js matches the server renderer', () => {
  it('formats times the same way', () => {
    const app = boot('');
    for (const t of ['04:00 PM', '5:30PM – 7:00PM', '4:00 PM - 6:00 PM', '10am - 3pm', '7:00 p.m.', '10:05 AM', 'All day']) {
      expect(app.formatTime(t), t).toBe(serverFormatTime(t));
    }
    expect(app.renderEvent({ name: 'X', date: '2026-10-07', time: '06:00PM' })).toContain('<span class="event-time">6:00 PM</span>');
  });

  it('shows a separate end time as a range, like withPages', () => {
    const app = boot('');
    const ev = { name: 'Gala', date: '2026-10-09', time: '7:00 PM', end_time: '11:30 PM' };
    expect(app.renderEvent(ev)).toContain(`<span class="event-time">${serverFormatTime(withPages([ev])[0].time)}</span>`);
    expect(app.renderEvent(ev)).toContain('7:00 PM – 11:30 PM');
    // Already a range (the server joined it): not joined twice.
    expect(app.renderEvent({ ...ev, time: '7:00 PM – 11:30 PM' })).toContain('<span class="event-time">7:00 PM – 11:30 PM</span>');
  });

  it('folds past days exactly like the server', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T17:00:00Z')); // Wednesday noon in Victoria
    const events = withPages([
      { date: '2026-10-05', name: 'Monday Market', time: '9 AM', icons: ['food'] },
      { date: '2026-10-07', name: 'Trivia', time: '7 PM', icons: ['drinks'] }
    ]).map(({ page, ...ev }) => ev); // the client render without event pages
    let done;
    const ready = new Promise(r => { done = r; });
    boot('', () => Promise.resolve({ ok: true, json: () => { setTimeout(done, 0); return Promise.resolve({ events }); } }));
    await ready;
    await new Promise(r => setTimeout(r, 0));
    const html = document.getElementById('events-container').innerHTML;
    const server = renderDays(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'],
      events, '2026-10-07');
    const pastIds = h => [...h.matchAll(/day-section--past day--d\d" id="(day-\d)"/g)].map(m => m[1]);
    expect(pastIds(html)).toEqual(['day-0', 'day-1']);
    expect(pastIds(server)).toEqual(['day-0', 'day-1']);
    const summary = h => h.match(/<summary class="day-header">[\s\S]*?<\/summary>/)[0];
    expect(summary(html)).toBe(summary(server));
    // Both fold Mon and Tue under the same "Earlier this week" bar.
    const group = h => h.match(/<details class="past-days">[\s\S]*?<\/summary>/)[0];
    expect(group(html)).toBe(group(server));
    expect(group(server)).toContain('<span class="past-days__meta">Mon–Tue · 1 event</span>');
  });

  it('folds every day but today, the same as the server, and opens days on demand', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T17:00:00Z')); // Wednesday noon in Victoria
    const events = withPages([
      { date: '2026-10-05', name: 'Monday Market', time: '9 AM', icons: ['food'] },
      { date: '2026-10-07', name: 'Trivia', time: '7 PM', icons: ['drinks'] },
      { date: '2026-10-10', name: 'Saturday Concert', time: '8 PM', icons: ['music'] }
    ]).map(({ page, ...ev }) => ev);
    let done;
    const ready = new Promise(r => { done = r; });
    const app = boot('', () => Promise.resolve({ ok: true, json: () => { setTimeout(done, 0); return Promise.resolve({ events }); } }));
    await ready;
    await new Promise(r => setTimeout(r, 0));
    const html = document.getElementById('events-container').innerHTML;
    const server = renderDays(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'],
      events, '2026-10-07');
    const shape = h => [...h.matchAll(/<section class="([^"]+)" id="(day-\d)"><details( open(?:="")?)?>[\s\S]*?<span class="day-count">([^<]+)</g)]
      .map(m => [m[2], m[1], Boolean(m[3]), m[4]]);
    expect(shape(html)).toEqual(shape(server));
    const open = () => [...document.querySelectorAll('.day-section details')].filter(d => d.open).map(d => d.closest('section').id);
    expect(open()).toEqual(['day-2']);
    expect(shape(html)[3]).toEqual(['day-3', 'day-section day-section--fold day--d3', false, 'No events']);
    // A category filter opens the days that have a match and folds the rest.
    app.applyFilter('music');
    expect(open()).toEqual(['day-5']);
    // A link to a day opens it.
    window.location.hash = '#day-0';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(open()).toEqual(['day-0', 'day-5']);
  });

  it('builds the week and Today in Victoria time, whatever zone the browser is in', async () => {
    // Sunday Oct 11, 9 PM in Victoria; a browser on UTC already says Monday.
    const tz = process.env.TZ;
    process.env.TZ = 'UTC';
    try {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-12T02:00:00Z'));
      const events = [{ date: '2026-10-11', name: 'Sunday Night Jazz', time: '8:00 PM' }];
      let done;
      const ready = new Promise(r => { done = r; });
      boot('', () => Promise.resolve({ ok: true, json: () => { setTimeout(done, 0); return Promise.resolve({ events }); } }));
      await ready;
      await new Promise(r => setTimeout(r, 0));
      const html = document.getElementById('events-container').innerHTML;
      expect(html).toContain('Sunday Night Jazz');
      expect(html).toContain('October 5');
      expect(html).not.toContain('October 12');
      const sections = [...html.matchAll(/class="day-section[^"]*" id="(day-\d)"/g)].map(m => m[0]);
      expect(sections.filter(s => s.includes('--past'))).toHaveLength(6);
      expect(html.match(/today-badge/g)).toHaveLength(1);
      expect(document.querySelector('#day-6').innerHTML).toContain('today-badge');
      // Mon–Sat fold together above Sunday.
      expect(document.querySelectorAll('.past-days .day-section')).toHaveLength(6);
      expect(document.querySelector('.past-days__meta').textContent).toBe('Mon–Sat · No events');
    } finally {
      if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
    }
  });

  it('sorts a range sharing one AM/PM by its start, like parseTimes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T17:00:00Z'));
    const events = [
      { date: '2026-10-07', name: 'Late Show', time: '8:00 PM' },
      { date: '2026-10-07', name: 'Early Set', time: '7:30 - 9:00 PM' }
    ];
    let done;
    const ready = new Promise(r => { done = r; });
    boot('', () => Promise.resolve({ ok: true, json: () => { setTimeout(done, 0); return Promise.resolve({ events }); } }));
    await ready;
    await new Promise(r => setTimeout(r, 0));
    const html = document.getElementById('events-container').innerHTML;
    expect(html.indexOf('Early Set')).toBeGreaterThan(-1);
    expect(html.indexOf('Early Set')).toBeLessThan(html.indexOf('Late Show'));
  });

  it('reads start times like parseTimes, minutes optional', () => {
    const app = boot('');
    const serverMins = t => {
      const s = parseTimes(t)[0];
      if (!s) return 9999;
      const [h, m] = s.split(':').map(Number);
      return h * 60 + m;
    };
    for (const t of ['7 PM', '7pm', '10am - 3pm', '12 p.m.', '12 AM', '7:00 PM', '7-9 PM', '11-1 PM', '7:30 – 9:30pm',
      'Doors 6 PM, show 7-9 PM', '13pm', '7:75 PM, 8 PM', '10:00AM – 11:00AM', 'All day', '', undefined]) {
      expect(app.timeMins(t), String(t)).toBe(serverMins(t));
    }
    expect(app.timeMins('7 PM')).toBe(19 * 60);
    expect(app.timeMins('10am - 3pm')).toBe(10 * 60);
  });

  it('sorts a time without minutes in its place, not at the end of the day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T17:00:00Z'));
    const events = [
      { date: '2026-10-07', name: 'Late Show', time: '9:00 PM' },
      { date: '2026-10-07', name: 'Typed By Hand', time: '7 PM' },
      { date: '2026-10-07', name: 'Market Day', time: '10am - 3pm' },
      { date: '2026-10-07', name: 'Dinner Set', time: '8:00 PM' }
    ];
    let done;
    const ready = new Promise(r => { done = r; });
    boot('', () => Promise.resolve({ ok: true, json: () => { setTimeout(done, 0); return Promise.resolve({ events }); } }));
    await ready;
    await new Promise(r => setTimeout(r, 0));
    const html = document.getElementById('events-container').innerHTML;
    const order = ['Market Day', 'Typed By Hand', 'Dinner Set', 'Late Show'].map(n => html.indexOf(n));
    expect(order.every(i => i > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('fills in the footer year', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-01-02T18:00:00Z'));
    document.body.innerHTML = '<footer><span data-year>2026</span></footer><div id="events-container"></div>';
    delete window.__vic361App;
    window.fetch = () => new Promise(() => {});
    (0, eval)(APP_JS);
    expect(document.querySelector('[data-year]').textContent).toBe('2027');
  });

  it('marks the sponsor link as paid and tags it for the sponsor', () => {
    const app = boot('');
    const html = app.renderSponsor({ name: 'Acme', text: 'Hi', cta: 'Visit', url: 'https://acme.example/' });
    expect(html).toContain('rel="sponsored noopener"');
    expect(html).toContain('utm_source=thevic361&amp;utm_medium=sponsor&amp;utm_campaign=weekly-sponsor');
    expect(app.sponsorLink('https://acme.example/?utm_source=x')).toBe('https://acme.example/?utm_source=x');
  });
});

describe('theme toggle (inline head script on every page)', () => {
  it('flips the theme from any page and labels the button', async () => {
    const { THEME_SCRIPT } = await import('../server/seo.js');
    document.documentElement.removeAttribute('data-theme');
    window.matchMedia = () => ({ matches: false });
    document.body.innerHTML = '<button type="button" data-theme-toggle><svg><path></path></svg></button>';
    (0, eval)(THEME_SCRIPT.replace(/^<script>|<\/script>$/g, ''));
    document.dispatchEvent(new Event('DOMContentLoaded'));
    const btn = document.querySelector('[data-theme-toggle]');
    expect(btn.getAttribute('aria-label')).toBe('Switch to dark mode');
    btn.querySelector('path').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(btn.getAttribute('aria-label')).toBe('Switch to light mode');
    document.documentElement.removeAttribute('data-theme');
  });
});

describe('filter messages', () => {
  it('say "today" only on today', () => {
    const sec = (i, today) => `<section class="day-section" id="day-${i}"><div class="day-header"><h2 class="day-name">D${today ? ' <span class="today-badge">Today</span>' : ''}</h2></div>` +
      '<ul class="event-list"><li class="event-entry" data-icons="food">Lunch</li></ul></section>';
    const app = boot(sec(0, false) + sec(1, true));
    app.applyFilter('music');
    const msgs = [...document.querySelectorAll('.filter-empty')].map(e => e.textContent);
    expect(msgs).toEqual(['Nothing in this category on this day.', 'Nothing in this category today.']);
  });
});

describe('docs/app.js day order', () => {
  it('keeps Vic’s Picks in time order (paid first at the same time), like sortEvents', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T17:00:00Z')); // Wednesday noon in Victoria
    const events = [
      { date: '2026-10-10', name: 'Plain', time: '9:00 AM', icons: [] },
      { date: '2026-10-10', name: 'Editor Pick', time: '1:00 PM', featured: true, editor_pick: true, icons: [] },
      { date: '2026-10-10', name: 'Paid Pick', time: '7:00 PM', featured: true, icons: [] },
      { date: '2026-10-10', name: 'Late Plain', time: '1:00 PM', icons: [] }
    ];
    let done;
    const ready = new Promise(r => { done = r; });
    boot('', () => Promise.resolve({ ok: true, json: () => { setTimeout(done, 0); return Promise.resolve({ events }); } }));
    await ready;
    await new Promise(r => setTimeout(r, 0));
    const html = document.getElementById('events-container').innerHTML;
    const order = ['>Plain<', 'Editor Pick', 'Late Plain', 'Paid Pick'].map(n => html.indexOf(n));
    expect(order.every(i => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});
