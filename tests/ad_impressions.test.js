// @vitest-environment jsdom
//
// Paid placements carry data-ad="<order id>" (server/seo.js adAttr, the same
// in docs/app.js), and docs/track.js reports one impression per ad per page
// load once half of it has been on screen for a second.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderEventItem, sponsorHtml } from '../server/seo.js';

const DOCS = path.join(__dirname, '..', 'docs');
const TRACK = readFileSync(path.join(DOCS, 'track.js'), 'utf8');
const APP = readFileSync(path.join(DOCS, 'app.js'), 'utf8');
const AD = 'a1b2c3d4-0000-4000-8000-000000000001';

let sent, observers, visibility;

// A controllable IntersectionObserver: tests say how much of an element shows.
class FakeIO {
  constructor(cb, opts) { this.cb = cb; this.opts = opts; this.els = []; observers.push(this); }
  observe(el) { this.els.push(el); }
  unobserve(el) { this.els = this.els.filter(x => x !== el); }
  disconnect() { this.els = []; }
}
function show(el, ratio) {
  for (const io of observers) {
    if (io.els.includes(el)) io.cb([{ target: el, isIntersecting: ratio > 0, intersectionRatio: ratio }], io);
  }
}
const impressions = () => sent.filter(b => b.kind === 'impression');

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  observers = [];
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  vi.stubGlobal('fetch', (url, opts) => { sent.push(JSON.parse(opts.body)); return Promise.resolve({}); });
  vi.stubGlobal('IntersectionObserver', FakeIO);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const pick = { date: '2026-10-10', name: 'Fall Fest', time: '10:00 AM', venue: 'De Leon Plaza', page: '/events/2026-10-10-fall-fest', featured: true, sponsor_order: AD };

describe('ad impressions (docs/track.js)', () => {
  it('fires once when at least half the ad is on screen for a second', async () => {
    document.body.innerHTML = `<ul>${renderEventItem(pick)}</ul>`;
    new Function(TRACK)();
    const el = document.querySelector('[data-ad]');
    show(el, 0.3);
    await vi.advanceTimersByTimeAsync(2000);
    expect(impressions()).toHaveLength(0);       // under half: not seen
    show(el, 0.6);
    await vi.advanceTimersByTimeAsync(900);
    expect(impressions()).toHaveLength(0);       // not a full second yet
    show(el, 0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(impressions()).toHaveLength(0);       // scrolled away first
    show(el, 0.6);
    await vi.advanceTimersByTimeAsync(1000);
    expect(impressions()).toEqual([{ kind: 'impression', ad: AD, path: location.pathname }]);
    show(el, 0);
    show(el, 1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(impressions()).toHaveLength(1);       // once per ad per page load
  });

  it('a second in a background tab does not count', async () => {
    document.body.innerHTML = `<ul>${renderEventItem(pick)}</ul>`;
    new Function(TRACK)();
    show(document.querySelector('[data-ad]'), 0.8);
    await vi.advanceTimersByTimeAsync(500);
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(impressions()).toHaveLength(0);
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(impressions()).toHaveLength(1);
  });

  it('picks up ads a list re-render adds later', async () => {
    document.body.innerHTML = '<div id="list"></div>';
    new Function(TRACK)();
    document.getElementById('list').innerHTML = sponsorHtml({ name: 'Acme', cta: 'Go', url: 'https://acme.example', order: AD });
    await vi.advanceTimersByTimeAsync(0); // MutationObserver callbacks
    show(document.querySelector('.sponsor-block'), 0.5);
    await vi.advanceTimersByTimeAsync(1000);
    expect(impressions()).toHaveLength(1);
  });

  it('skips the admin and pages without IntersectionObserver, without breaking clicks', async () => {
    document.body.innerHTML = `<ul>${renderEventItem(pick)}</ul>`;
    vi.stubGlobal('IntersectionObserver', undefined);
    expect(() => new Function(TRACK)()).not.toThrow();
    document.querySelector('.event-name a').click();
    expect(sent.some(b => b.kind === 'click')).toBe(true);
    expect(observers).toHaveLength(0);

    vi.stubGlobal('IntersectionObserver', FakeIO);
    localStorage.setItem('vic361_admin_session', 'x');
    try {
      sent = [];
      new Function(TRACK)();
      expect(observers).toHaveLength(0);
    } finally {
      localStorage.removeItem('vic361_admin_session');
    }
  });

  it('tags clicks inside an ad with its id, and only those', async () => {
    document.body.innerHTML = `<ul>${renderEventItem(pick)}${renderEventItem({ ...pick, name: 'Other', page: '/events/x', featured: false, sponsor_order: undefined })}</ul>` +
      sponsorHtml({ name: 'Acme', cta: 'Go', url: 'https://acme.example', order: AD });
    new Function(TRACK)();
    for (const a of document.querySelectorAll('.event-name a, .sponsor-cta')) {
      a.addEventListener('click', e => e.preventDefault());
      a.click();
    }
    // Earlier tests' copies of track.js are still listening, hence the Set.
    const clicks = [...new Set(sent.filter(b => b.kind === 'click').map(c => `${c.type}|${c.ad || ''}`))];
    // A list tap to the event's page here is event_open (still the ad's).
    expect(clicks).toEqual([`event_open|${AD}`, 'event_open|', `sponsor_click|${AD}`]);
  });
});

describe('data-ad markup: server and docs/app.js', () => {
  function app() {
    document.body.innerHTML = '<header id="site-header"></header><main><div id="events-container"></div><section id="sponsor-section"></section></main>';
    delete window.__vic361App;
    window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    window.fetch = () => new Promise(() => {});
    (0, eval)(APP);
    return window.__vic361App;
  }
  const openTag = html => html.slice(0, html.indexOf('>') + 1);

  it('tags paid Vic’s Picks, not editor’s picks or plain events, the same way', () => {
    const a = app();
    const editor = { ...pick, editor_pick: true };
    const plain = { ...pick, featured: false };
    expect(renderEventItem(pick)).toContain(`data-ad="${AD}"`);
    expect(openTag(a.renderEvent(pick))).toBe(openTag(renderEventItem(pick)));
    for (const ev of [editor, plain, { ...pick, sponsor_order: undefined }, { ...pick, sponsor_order: '"><script>' }]) {
      expect(renderEventItem(ev)).not.toContain('data-ad');
      expect(a.renderEvent(ev)).not.toContain('data-ad');
    }
  });

  it('tags the weekly sponsor block, the same way', () => {
    const a = app();
    const sponsor = { name: 'Acme', text: 'Hi', cta: 'Go', url: 'https://acme.example', order: AD };
    const blockTag = html => html.match(/<div class="sponsor-block"[^>]*>/)[0];
    expect(blockTag(sponsorHtml(sponsor))).toBe(`<div class="sponsor-block" data-ad="${AD}">`);
    expect(blockTag(a.renderSponsor(sponsor))).toBe(blockTag(sponsorHtml(sponsor)));
    // A sponsor set by hand (no order) isn't a sold placement.
    expect(sponsorHtml({ ...sponsor, order: undefined })).not.toContain('data-ad');
    expect(a.renderSponsor({ ...sponsor, order: undefined })).not.toContain('data-ad');
  });
});
