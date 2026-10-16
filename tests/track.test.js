// @vitest-environment jsdom
//
// docs/track.js counts a page view only once the visitor engages (scroll,
// tap, click, key) or the page has been visible for 5 seconds.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SRC = readFileSync(path.join(__dirname, '..', 'docs', 'track.js'), 'utf8');
let sent, visibility;

function views() { return sent.filter(b => b.kind === 'view'); }

function load() {
  // eslint-disable-next-line no-new-func
  new Function(SRC)();
}

function setVisible(v) {
  visibility = v ? 'visible' : 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  // No sendBeacon in jsdom: track.js falls back to fetch, which we record.
  vi.stubGlobal('fetch', (url, opts) => { sent.push(JSON.parse(opts.body)); return Promise.resolve({}); });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('engaged page views', () => {
  it('sends nothing on load, then one view after 5 seconds on screen', async () => {
    load();
    await vi.advanceTimersByTimeAsync(4900);
    expect(views()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(views()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20000);
    window.dispatchEvent(new Event('scroll'));
    await flush();
    expect(views()).toHaveLength(1);
  });

  it('counts right away when the visitor scrolls or taps', async () => {
    load();
    window.dispatchEvent(new Event('scroll'));
    await flush();
    expect(views()).toHaveLength(1);
  });

  it('time in a background tab does not count', async () => {
    load();
    await vi.advanceTimersByTimeAsync(3000);
    setVisible(false);
    await vi.advanceTimersByTimeAsync(60000);
    expect(views()).toHaveLength(0);
    setVisible(true);
    await vi.advanceTimersByTimeAsync(1900);
    expect(views()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(views()).toHaveLength(1);
  });

  it('a page opened in the background waits until it is shown', async () => {
    visibility = 'hidden';
    load();
    await vi.advanceTimersByTimeAsync(30000);
    expect(views()).toHaveLength(0);
    setVisible(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(views()).toHaveLength(1);
  });

  it('a signup is a Meta Lead only when the server said lead, and GA never sees the flag', async () => {
    const fbq = vi.fn(), gtag = vi.fn();
    vi.stubGlobal('fbq', fbq);
    vi.stubGlobal('gtag', gtag);
    load();
    window.vic361Track('subscribe_click', { link_url: 'form', lead: false });
    window.vic361Track('subscribe_click', { link_url: 'list-card' });
    expect(fbq).not.toHaveBeenCalled();
    window.vic361Track('subscribe_click', { link_url: 'form', lead: true });
    expect(fbq).toHaveBeenCalledWith('track', 'Lead');
    expect(gtag.mock.calls.map(c => c[2])).toEqual([{ link_url: 'form' }, { link_url: 'list-card' }, { link_url: 'form' }]);
  });

  it('a tracked click sends the view first, then the click', async () => {
    load();
    window.vic361Track('subscribe_click', { link_url: 'form' });
    await flush();
    expect(sent.map(b => b.kind)).toEqual(['view', 'click']);
  });
});
