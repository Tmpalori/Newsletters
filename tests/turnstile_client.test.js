// @vitest-environment jsdom
//
// docs/turnstile.js must never leave a signup form hanging: when
// Cloudflare's script can't load, vicTurnstile.token() answers '' and the
// server takes the confirm-by-email path (server/newsletter.js).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SRC = readFileSync(path.join(__dirname, '..', 'docs', 'turnstile.js'), 'utf8');

beforeEach(() => {
  vi.useFakeTimers();
  delete window.vicTurnstile; delete window.turnstile;
  vi.stubGlobal('fetch', () => Promise.resolve({ json: () => Promise.resolve({ turnstile_site_key: 'site-key' }) }));
  document.head.innerHTML = '';
  document.body.innerHTML = '<form data-turnstile="fetch"><input name="email"><button type="submit">Go</button></form>';
  // eslint-disable-next-line no-new-func
  new Function(SRC)();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('vicTurnstile.token', () => {
  it('answers right away with no token when the script fails to load', async () => {
    const p = window.vicTurnstile.token(document.querySelector('form'));
    await vi.advanceTimersByTimeAsync(0);
    const script = document.head.querySelector('script');
    expect(script.src).toContain('challenges.cloudflare.com/turnstile');
    script.onerror(new Event('error'));
    await vi.advanceTimersByTimeAsync(0);
    await expect(p).resolves.toBe('');
  });

  it('answers with no token when the script never arrives at all', async () => {
    let done = null;
    window.vicTurnstile.token(document.querySelector('form')).then(t => { done = t; });
    await vi.advanceTimersByTimeAsync(7000);
    expect(done).toBe(null);
    await vi.advanceTimersByTimeAsync(1500);
    expect(done).toBe('');
  });

  it('still waits for a real token when Cloudflare works', async () => {
    let cb;
    window.turnstile = { render: (box, opts) => { cb = opts.callback; return 'w1'; }, reset: () => {} };
    const p = window.vicTurnstile.token(document.querySelector('form'));
    await vi.advanceTimersByTimeAsync(0);
    cb('tok-123');
    await expect(p).resolves.toBe('tok-123');
  });

  it('a widget error answers at once and goes back with the form as ts_err', async () => {
    let onError;
    window.turnstile = { render: (box, opts) => { onError = opts['error-callback']; return 'w1'; }, reset: () => {} };
    const form = document.querySelector('form');
    let done = null;
    window.vicTurnstile.token(form).then(t => { done = t; });
    await vi.advanceTimersByTimeAsync(0);
    expect(onError(110200)).toBe(true);           // handled: Cloudflare doesn't throw it
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe('');                          // no 10-second wait
    expect(form.querySelector('input[name=ts_err]').value).toBe('110200');
    expect(window.vicTurnstile.error(form)).toBe('110200');
  });
});
