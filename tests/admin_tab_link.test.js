// The admin opens on the page a link names (docs/admin.js openTabFromHash):
// admin.html#tab=sponsors, which HQ's buttons and its sign-in use.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const DOCS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const HTML = readFileSync(resolve(DOCS, 'admin.html'), 'utf8');
const JS = readFileSync(resolve(DOCS, 'admin.js'), 'utf8');

function boot({ session = 'test-session' } = {}) {
  document.body.innerHTML = HTML.match(/<body>([\s\S]*?)<\/body>/)[1];
  document.querySelectorAll('script[src]').forEach(s => s.remove());
  delete window.__vic361Admin;
  window.localStorage.clear();
  if (session) window.localStorage.setItem('vic361_admin_session', session);
  window.fetch = vi.fn(async url => {
    const u = String(url);
    if (u.includes('/api/admin/me')) return { ok: true, status: 200, json: async () => ({ ok: true, kind: 'session' }) };
    if (u.includes('/api/config')) return { ok: true, status: 200, json: async () => ({ admin_login_enabled: true }) };
    return { ok: false, status: 404, json: async () => ({}) };
  });
  // eslint-disable-next-line no-eval
  (0, eval)(JS);
}
const shown = id => !document.getElementById(`tab-${id}`).hidden;

afterEach(() => { delete window.__vic361Admin; history.replaceState(null, '', '/'); });

describe('admin.html#tab=…', () => {
  it('opens that page once signed in, then forgets the hash', async () => {
    history.replaceState(null, '', '/admin.html#tab=sponsors');
    boot();
    await vi.waitFor(() => expect(shown('sponsors')).toBe(true));
    expect(shown('home')).toBe(false);
    expect(document.querySelector('.tab-btn[data-tab="sponsors"]').classList.contains('is-active')).toBe(true);
    expect(window.location.hash).toBe('');
  });

  it('opens a sub-page under its sidebar button', async () => {
    history.replaceState(null, '', '/admin.html#tab=submissions');
    boot();
    await vi.waitFor(() => expect(shown('submissions')).toBe(true));
    expect(document.querySelector('.tab-btn[data-tab="picker"]').classList.contains('is-active')).toBe(true);
  });

  it('ignores a name that is not an admin page', async () => {
    history.replaceState(null, '', '/admin.html#tab=nope');
    boot();
    await vi.waitFor(() => expect(document.getElementById('app').hidden).toBe(false));
    expect(shown('home')).toBe(true);
  });

  it('waits for sign-in: no session keeps the hash for after it', async () => {
    history.replaceState(null, '', '/admin.html#tab=newsletter');
    boot({ session: null });
    await vi.waitFor(() => expect(document.getElementById('auth-gate').hidden).toBe(false));
    expect(window.location.hash).toBe('#tab=newsletter');
  });
});
