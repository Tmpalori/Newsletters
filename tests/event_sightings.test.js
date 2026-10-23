// @vitest-environment jsdom
//
// A free submitted event carries data-seen="<its page>" in every list
// (server/seo.js seenAttr, the same in docs/app.js), and docs/track.js
// reports one sighting per event per page load once half of it has been on
// screen for a second, like a paid pick's impressions. /api/track stores it
// (kind 'sighting', the event's page in click_url) for the submitter's
// recap (server/eventRecaps.js).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderEventItem, renderComingUp, seenAttr } from '../server/seo.js';
import { beaconRow } from '../server/analytics.js';

const DOCS = path.join(__dirname, '..', 'docs');
const TRACK = readFileSync(path.join(DOCS, 'track.js'), 'utf8');
const APP = readFileSync(path.join(DOCS, 'app.js'), 'utf8');
const AD = 'a1b2c3d4-0000-4000-8000-000000000001';
const PAGE = '/events/2026-10-10-fall-fest';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1';

const submitted = { date: '2026-10-10', name: 'Fall Fest', time: '10:00 AM', venue: 'De Leon Plaza', page: PAGE, submitted: true };

describe('data-seen markup: server and docs/app.js', () => {
  function app() {
    document.body.innerHTML = '<header id="site-header"></header><main><div id="events-container"></div><section id="sponsor-section"></section></main>';
    delete window.__vic361App;
    window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    window.fetch = () => new Promise(() => {});
    (0, eval)(APP);
    return window.__vic361App;
  }
  const openTag = html => html.slice(0, html.indexOf('>') + 1);

  it('tags free submitted events (editor’s picks too), the same way', () => {
    const a = app();
    for (const ev of [submitted, { ...submitted, featured: true, editor_pick: true }]) {
      expect(renderEventItem(ev)).toContain(`data-seen="${PAGE}"`);
      expect(openTag(a.renderEvent(ev))).toBe(openTag(renderEventItem(ev)));
    }
  });

  it('not paid picks (data-ad counts those), collected events, or a page that isn’t an event page', () => {
    const a = app();
    const paid = { ...submitted, featured: true, sponsor_order: AD };
    expect(renderEventItem(paid)).toContain(`data-ad="${AD}"`);
    for (const ev of [paid, { ...submitted, submitted: undefined }, { ...submitted, submitted: 'yes' },
      { ...submitted, page: '/events/"><script>' }, { ...submitted, page: 'https://evil.example/events/x' }, { ...submitted, page: undefined }]) {
      expect(renderEventItem(ev)).not.toContain('data-seen');
      expect(a.renderEvent(ev)).not.toContain('data-seen');
    }
  });

  it('tags it in "Coming up" too', () => {
    expect(seenAttr(submitted)).toBe(` data-seen="${PAGE}"`);
    // "Coming up" lists big events past this week.
    const html = renderComingUp([{ ...submitted, date: '2026-11-20', big: true }], '2026-10-23');
    expect(html).toContain(`<li class="coming-item" data-seen="${PAGE}">`);
  });
});

describe('sightings (docs/track.js)', () => {
  let sent, observers;
  class FakeIO {
    constructor(cb) { this.cb = cb; this.els = []; observers.push(this); }
    observe(el) { this.els.push(el); }
    unobserve(el) { this.els = this.els.filter(x => x !== el); }
    disconnect() { this.els = []; }
  }
  const show = (el, ratio) => {
    for (const io of observers) if (io.els.includes(el)) io.cb([{ target: el, isIntersecting: ratio > 0, intersectionRatio: ratio }], io);
  };
  const of = kind => sent.filter(b => b.kind === kind);

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    observers = [];
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    vi.stubGlobal('fetch', (url, opts) => { sent.push(JSON.parse(opts.body)); return Promise.resolve({}); });
    vi.stubGlobal('IntersectionObserver', FakeIO);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('fires once per event per page load, after half of it was on screen for a second', async () => {
    document.body.innerHTML = `<ul>${renderEventItem(submitted)}${renderEventItem({ ...submitted, name: 'Plain', page: '/events/2026-10-10-plain', submitted: false })}</ul>`;
    new Function(TRACK)();
    const el = document.querySelector('[data-seen]');
    show(el, 0.4);
    await vi.advanceTimersByTimeAsync(2000);
    expect(of('sighting')).toHaveLength(0);
    show(el, 0.6);
    await vi.advanceTimersByTimeAsync(900);
    expect(of('sighting')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(of('sighting')).toEqual([{ kind: 'sighting', page: PAGE, path: location.pathname }]);
    show(el, 0);
    show(el, 1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(of('sighting')).toHaveLength(1);
  });

  it('a paid pick still sends its impression, and only that', async () => {
    document.body.innerHTML = `<ul>${renderEventItem({ ...submitted, featured: true, sponsor_order: AD })}${renderEventItem(submitted)}</ul>`;
    new Function(TRACK)();
    for (const el of document.querySelectorAll('.event-entry')) show(el, 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(of('impression')).toEqual([{ kind: 'impression', ad: AD, path: location.pathname }]);
    expect(of('sighting')).toEqual([{ kind: 'sighting', page: PAGE, path: location.pathname }]);
  });

  it('picks up events a list re-render adds later', async () => {
    document.body.innerHTML = '<ul id="list"></ul>';
    new Function(TRACK)();
    document.getElementById('list').innerHTML = renderEventItem(submitted);
    await vi.advanceTimersByTimeAsync(0); // MutationObserver callbacks
    show(document.querySelector('[data-seen]'), 0.5);
    await vi.advanceTimersByTimeAsync(1000);
    expect(of('sighting')).toHaveLength(1);
  });
});

describe('sightings on /api/track', () => {
  const ctx = { ip: '1.2.3.4', ua: UA, secret: 's', siteHost: 'www.thevic361.com', now: new Date('2026-10-07T17:00:00Z') };

  it('keeps a real event page, drops anything else and bots', () => {
    expect(beaconRow({ kind: 'sighting', page: PAGE, path: '/today' }, ctx))
      .toEqual({ kind: 'sighting', click_url: PAGE, path: '/today', day: '2026-10-07', visitor: expect.any(String) });
    for (const page of ['', '/', '/today', '/events/', '/events/a/b', 'https://x.example/events/a', '/events/<script>', `/events/${'a'.repeat(121)}`, 42, null]) {
      expect(beaconRow({ kind: 'sighting', page, path: '/' }, ctx)).toBeNull();
    }
    expect(beaconRow({ kind: 'sighting', page: PAGE, path: '/' }, { ...ctx, ua: 'Mozilla/5.0 (compatible; Googlebot/2.1)' })).toBeNull();
  });
});
