// The admin for another town (MULTI_CITY_PLAN.md 1.3d): it takes the town
// and its GitHub settings from /api/config, so its week, publish target and
// labels follow the town; without them it is Victoria's, as before.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const DOCS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const HTML = readFileSync(resolve(DOCS, 'admin.html'), 'utf8');
const JS = readFileSync(resolve(DOCS, 'admin.js'), 'utf8');

async function boot(config) {
  document.body.innerHTML = HTML.match(/<body>([\s\S]*?)<\/body>/)[1];
  document.querySelectorAll('script[src*="admin.js"]').forEach(s => s.remove());
  document.title = 'Admin — The Vic 361';
  delete window.__vic361Admin;
  window.localStorage.clear();
  window.fetch = vi.fn(async url => String(url).includes('/api/config')
    ? { ok: true, status: 200, json: async () => ({ admin_login_enabled: true, ...config }) }
    : { ok: false, status: 401, json: async () => ({ ok: false }) });
  (0, eval)(JS);
  for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0));
  return window.__vic361Admin;
}

afterEach(() => { vi.useRealTimers(); delete window.__vic361Admin; });

describe('Victoria (config without a town)', () => {
  it('keeps its labels, repo and Central week', async () => {
    const api = await boot({});
    expect(api.town()).toMatchObject({ siteName: 'The Vic 361', domain: 'thevic361.com', timezone: 'America/Chicago' });
    expect(api.repo()).toEqual({ owner: 'Tmpalori', name: 'thevic361', branch: 'main', eventsPath: 'docs/events.json', candidatesPath: 'candidates.json' });
    expect(document.title).toBe('Admin — The Vic 361');
    expect(document.getElementById('reply-title').textContent).toBe('Reply as news@thevic361.com');
    expect(document.querySelector('#reply-modal .event-edit-form__hint').textContent).toBe('Signed “Tristen, The Vic 361”. Their answer comes back to Slack.');
  });
});

describe('another town', () => {
  const config = {
    github_owner: 'Tmpalori', github_repo: 'thebay979', github_branch: 'live', github_events_path: 'towns/bay/public/events.json', github_candidates_path: 'towns/bay/candidates.json',
    town: { id: 'bay', siteName: 'The Bay 979', domain: 'thebay979.com', city: 'Bay City', pickName: 'Bay’s Best', timezone: 'America/Los_Angeles' }
  };

  it('publishes to its own repo and labels the admin with its name', async () => {
    const api = await boot(config);
    expect(api.repo()).toEqual({ owner: 'Tmpalori', name: 'thebay979', branch: 'live', eventsPath: 'towns/bay/public/events.json', candidatesPath: 'towns/bay/candidates.json' });
    expect(document.title).toBe('Admin — The Bay 979');
    expect(document.getElementById('reply-title').textContent).toBe('Reply as news@thebay979.com');
    expect(document.querySelector('#reply-modal .event-edit-form__hint').textContent).toContain('Tristen, The Bay 979');
    const ev = { name: 'Fish Fry', date: '2026-05-08', time: '6:00 PM', venue: 'Hall' };
    api._state.candidates = [ev];
    api._state.selected = new Set([api.eventKey(ev)]);
    expect(api.buildNewsletterHtml()).toContain('This Week in The Bay 979');
  });

  it('counts weeks in its own timezone, whatever the browser’s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 1 AM Monday May 4 in Central, still 11 PM Sunday May 3 on the West Coast.
    vi.setSystemTime(new Date('2026-05-04T06:00:00Z'));
    const vic = await boot({});
    expect(vic.getWeekRange(0)).toEqual({ mondayStr: '2026-05-04', sundayStr: '2026-05-10' });
    const bay = await boot(config);
    expect(bay.getWeekRange(0)).toEqual({ mondayStr: '2026-04-27', sundayStr: '2026-05-03' });
    expect(bay.inWeekBucket('2026-05-03', 'this')).toBe(true);
  });
});
