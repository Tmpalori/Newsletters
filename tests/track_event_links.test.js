// @vitest-environment jsdom
//
// docs/track.js: event links out (event_click) vs event pages opened from
// a list (event_open), and the email campaign on a newsletter visit. Its
// own file so the page loads track.js once.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SRC = readFileSync(path.join(__dirname, '..', 'docs', 'track.js'), 'utf8');
let sent;

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  vi.stubGlobal('fetch', (url, opts) => { sent.push(JSON.parse(opts.body)); return Promise.resolve({}); });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('event links and newsletter visits', () => {
  it('sends the email campaign with the view, and tells event links out from event pages', async () => {
    window.history.replaceState(null, '', '/?utm_source=newsletter&utm_medium=email&utm_campaign=weekly-2026-10-12');
    new Function(SRC)();  // eslint-disable-line no-new-func
    window.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.find(b => b.kind === 'view')).toMatchObject({ utm: 'newsletter', utm_campaign: 'weekly-2026-10-12' });

    document.body.innerHTML = '<li class="event-entry"><a id="open" href="/events/2026-10-16-trivia">Trivia</a></li>' +
      '<p class="page-actions"><a id="out" href="https://pub.example/trivia">See event details</a></p>' +
      '<p class="page-actions"><a id="home" href="/this-week">This week\'s events</a></p>';
    for (const id of ['open', 'out', 'home']) {
      const a = document.getElementById(id);
      a.addEventListener('click', e => e.preventDefault());
      a.click();
    }
    await vi.advanceTimersByTimeAsync(0);
    const clicks = sent.filter(b => b.kind === 'click').map(b => [b.type, b.url]);
    expect(clicks).toEqual([['event_open', '/events/2026-10-16-trivia'], ['event_click', 'https://pub.example/trivia']]);
    window.history.replaceState(null, '', '/');
  });
});
