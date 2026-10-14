// Smoke test for the static admin panel (docs/admin.html + admin.js).
//
// Loads the static HTML into jsdom and evaluates admin.js so we can verify:
//   - The auth gate is shown when no PAT is in localStorage
//   - The app shell unhides when a PAT is present
//   - Pure helpers (filtering, grouping, weekend detection, newsletter HTML)
//     behave correctly on representative candidate data
//
// No real GitHub PAT or network call is required.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS = resolve(__dirname, '..', 'docs');

const HTML = readFileSync(resolve(DOCS, 'admin.html'), 'utf8');
const JS = readFileSync(resolve(DOCS, 'admin.js'), 'utf8');

function bootDom({ pat = null, session = null } = {}) {
  // Reset jsdom DOM and globals between tests.
  const bodyMatch = HTML.match(/<body>([\s\S]*?)<\/body>/);
  document.body.innerHTML = bodyMatch ? bodyMatch[1] : '';
  // Strip the trailing <script src="./admin.js"> — we'll evaluate JS directly.
  document.querySelectorAll('script[src*="admin.js"]').forEach(s => s.remove());

  delete window.__vic361Admin;
  window.localStorage.clear();
  if (pat) window.localStorage.setItem('vic361_admin_pat', pat);
  if (session) window.localStorage.setItem('vic361_admin_session', session);

  // admin.js calls fetch('/api/config') and (when a session is set)
  // fetch('/api/admin/me'). In jsdom there is no network, so stub fetch with
  // a default that says "no server config, no valid session" — tests that
  // need richer behavior can override before booting.
  if (!window.__originalFetch) window.__originalFetch = window.fetch;
  window.fetch = vi.fn(async (url) => {
    const u = String(url);
    if (u.includes('/api/admin/me')) {
      return { ok: false, status: 401, json: async () => ({ ok: false }) };
    }
    if (u.includes('/api/config')) {
      return { ok: true, status: 200, json: async () => ({
        admin_login_enabled: false,
        admin_legacy_token_enabled: false,
        github_publish_enabled: false
      }) };
    }
    // PAT-mode fallback: admin.js calls api.github.com directly. Return an
    // empty events file so loadCandidates doesn't blow up the test logs.
    if (u.includes('api.github.com')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          sha: 'fake', encoding: 'base64',
          content: Buffer.from('{"events":[]}', 'utf8').toString('base64')
        })
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });

  // eslint-disable-next-line no-eval
  (0, eval)(JS);
  return window.__vic361Admin;
}

describe('admin.html static structure', () => {
  it('exposes the expected core element ids', () => {
    bootDom();
    const ids = [
      'auth-gate', 'auth-form',
      'auth-username', 'auth-password',
      'auth-pat', 'auth-pat-form',
      'auth-error',
      'app', 'signout-btn',
      'tab-picker', 'tab-preview', 'tab-newsletter',
      'filter-search', 'filter-category', 'filter-venue',
      'reload-btn', 'publish-btn',
      'preview-frame', 'preview-refresh',
      'newsletter-html', 'newsletter-copy', 'newsletter-refresh',
      'count-summary', 'status-message',
      'picker-list', 'picker-loading', 'picker-empty', 'picker-error'
    ];
    for (const id of ids) {
      expect(document.getElementById(id), `missing #${id}`).not.toBeNull();
    }
  });

  it('has seven sidebar pages (Overview first) and sub-pages for Events and Analytics', () => {
    bootDom();
    const tabs = Array.from(document.querySelectorAll('.tab-btn'));
    expect(tabs.map(t => t.dataset.tab)).toEqual(['home', 'attention', 'inbox', 'picker', 'newsletter', 'sponsors', 'growth', 'settings']);
    const subs = Array.from(document.querySelectorAll('.subtab-btn')).map(b => b.dataset.in + ':' + b.dataset.goto);
    expect(subs).toEqual(['picker:picker', 'picker:submissions', 'picker:sources', 'picker:preview', 'growth:growth', 'growth:traffic']);
    // Every page and sub-page has its panel.
    for (const name of ['home', 'attention', 'picker', 'submissions', 'sources', 'preview', 'newsletter', 'sponsors', 'growth', 'traffic', 'settings']) {
      expect(document.getElementById('tab-' + name), name).not.toBeNull();
    }
  });

  it('a sub-page keeps its sidebar page lit and shows only its own sub-tabs', () => {
    const api = bootDom();
    window.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
    api.activateTab('submissions');
    expect(document.querySelector('.tab-btn.is-active').dataset.tab).toBe('picker');
    expect(document.getElementById('tab-submissions').hidden).toBe(false);
    expect(document.getElementById('subtabs').hidden).toBe(false);
    const visible = Array.from(document.querySelectorAll('.subtab-btn')).filter(b => !b.hidden).map(b => b.dataset.goto);
    expect(visible).toEqual(['picker', 'submissions', 'sources', 'preview']);
    expect(document.querySelector('.subtab-btn.is-active').dataset.goto).toBe('submissions');
    api.activateTab('settings');
    expect(document.getElementById('subtabs').hidden).toBe(true);
  });

  it('exposes the Sources tab structure', () => {
    bootDom();
    const ids = [
      'tab-sources',
      'sources-summary', 'sources-last-run', 'sources-next-run',
      'sources-merged-count',
      'sources-actions', // wrapper class, not an id — keep as a sanity miss
      'sources-refresh', 'sources-trigger', 'sources-trigger-help',
      'sources-loading', 'sources-empty', 'sources-error',
      'sources-message', 'sources-list'
    ];
    // 'sources-actions' is a class, not an id — drop it from the strict check.
    for (const id of ids.filter(i => i !== 'sources-actions')) {
      expect(document.getElementById(id), `missing #${id}`).not.toBeNull();
    }
  });
});

describe('admin Sources tab rendering', () => {
  let api;
  beforeEach(() => { api = bootDom(); });
  afterEach(() => { delete window.__vic361Admin; });

  it('renderSources fills summary fields and emits one card per source', () => {
    api.renderSources({
      ok: true,
      last_run_at: '2026-04-26T18:30:00',
      next_run_at: '2026-05-03T23:00:00.000Z',
      next_run_note: 'Sundays 23:00 UTC',
      merged_count: 80,
      raw_count: 120,
      trigger_enabled: true,
      sources: [
        { name: 'library', label: 'Public Library', category: 'web',
          count: 12, status: 'ok',
          started_at: '2026-04-26T18:25:00', finished_at: '2026-04-26T18:25:30',
          last_pulled_at: '2026-04-26T18:25:30' },
        { name: 'apify_facebook', label: 'Apify · Facebook', category: 'apify',
          count: 0, status: 'error', message: 'APIFY_TOKEN missing',
          last_pulled_at: '2026-04-26T18:27:00' }
      ]
    });
    const cards = document.querySelectorAll('.source-card');
    expect(cards.length).toBe(2);
    expect(document.getElementById('sources-merged-count').textContent)
      .toMatch(/80.*120 raw/);
    // Library card carries the count.
    const libCard = document.querySelector('[data-source="library"]');
    expect(libCard.textContent).toContain('Public Library');
    expect(libCard.textContent).toContain('12');
    // Apify card surfaces the message.
    const fbCard = document.querySelector('[data-source="apify_facebook"]');
    expect(fbCard.textContent).toContain('APIFY_TOKEN missing');
  });

  it('renderSources shows the Apify month and the quiet Facebook pages, escaped', () => {
    api.renderSources({
      ok: true, sources: [],
      apify: { month_usd: 41.24, limit_usd: 50, cycle_end: '2026-10-31', run_usd: 1.81 },
      quiet_pages: [{ url: 'https://www.facebook.com/aerocrafters', name: 'Aero <b>Crafters</b>', misses: 2, since: '2026-10-11' }]
    });
    const item = document.getElementById('sources-apify-item');
    expect(item.hidden).toBe(false);
    expect(document.getElementById('sources-apify').textContent).toBe('$41.24 of $50.00 (82%), resets 2026-10-31 · last collect $1.81');
    expect(item.classList.contains('is-warn')).toBe(true);
    const quiet = document.getElementById('sources-quiet');
    expect(quiet.hidden).toBe(false);
    expect(quiet.querySelector('a').getAttribute('href')).toBe('https://www.facebook.com/aerocrafters');
    expect(quiet.querySelector('b')).toBeNull();
    api.renderSources({ ok: true, sources: [] });
    expect(item.hidden).toBe(true);
    expect(quiet.hidden).toBe(true);
  });

  it('renderSources disables the trigger button and shows help when not enabled', () => {
    api.renderSources({
      ok: true,
      last_run_at: null,
      next_run_at: '2026-05-03T23:00:00.000Z',
      trigger_enabled: false,
      sources: []
    });
    const btn = document.getElementById('sources-trigger');
    expect(btn.disabled).toBe(true);
    // Help copy reassures the user that Save & Publish is unaffected and
    // points them at the GitHub Actions manual fallback.
    const help = document.getElementById('sources-trigger-help').textContent;
    expect(help).toMatch(/Save & Publish/);
    expect(help).toMatch(/manually|GitHub/i);
  });

  it('renderSources reveals the GitHub Actions fallback link when actions_url is set', () => {
    api.renderSources({
      ok: true,
      last_run_at: null,
      next_run_at: '2026-05-03T23:00:00.000Z',
      trigger_enabled: false,
      actions_url: 'https://github.com/Tmpalori/thevic361/actions/workflows/weekly-collect.yml',
      sources: []
    });
    const link = document.getElementById('sources-actions-link');
    expect(link).not.toBeNull();
    expect(link.hidden).toBe(false);
    expect(link.getAttribute('href'))
      .toBe('https://github.com/Tmpalori/thevic361/actions/workflows/weekly-collect.yml');
  });
});

describe('admin Sources tab error messaging', () => {
  let api;
  beforeEach(() => { api = bootDom(); });
  afterEach(() => { delete window.__vic361Admin; });

  it('describeTriggerError returns a friendly message and actions_url for github-token-invalid', () => {
    const desc = api.describeTriggerError({
      ok: false,
      error: 'github-token-invalid',
      github_status: 401,
      message: 'The server\'s GITHUB_TOKEN is invalid or expired',
      actions_url: 'https://github.com/Tmpalori/thevic361/actions/workflows/weekly-collect.yml',
      save_publish_unaffected: true
    }, 401);
    expect(desc.kind).toBe('error');
    // Message must explicitly tell the user that Save & Publish is OK and that
    // they can run the workflow manually.
    expect(desc.text).toMatch(/Save & Publish/);
    expect(desc.text).toMatch(/manual|manually/i);
    // Must NOT show the raw "Bad credentials" error string.
    expect(desc.text).not.toMatch(/Bad credentials/);
    expect(desc.actionsUrl).toBe('https://github.com/Tmpalori/thevic361/actions/workflows/weekly-collect.yml');
  });

  it('describeTriggerError handles a bare 401 (no error code) as token-invalid', () => {
    const desc = api.describeTriggerError({ message: 'Bad credentials' }, 401);
    expect(desc.kind).toBe('error');
    expect(desc.text).toMatch(/invalid or expired/i);
    expect(desc.text).not.toMatch(/Bad credentials/);
  });

  it('describeTriggerError surfaces github-not-configured with Save & Publish reassurance', () => {
    const desc = api.describeTriggerError({
      ok: false,
      error: 'github-not-configured',
      actions_url: 'https://github.com/Tmpalori/thevic361/actions/workflows/weekly-collect.yml'
    }, 503);
    expect(desc.text).toMatch(/Save & Publish/);
    expect(desc.actionsUrl).toMatch(/weekly-collect\.yml$/);
  });

  it('setSourcesMessage renders a fallback link when actions_url is provided', () => {
    api.setSourcesMessage('Pull now failed.', 'error', {
      actionsUrl: 'https://github.com/Tmpalori/thevic361/actions/workflows/weekly-collect.yml'
    });
    const el = document.getElementById('sources-message');
    expect(el.classList.contains('is-error')).toBe(true);
    const a = el.querySelector('a');
    expect(a).not.toBeNull();
    expect(a.getAttribute('href'))
      .toBe('https://github.com/Tmpalori/thevic361/actions/workflows/weekly-collect.yml');
    expect(a.getAttribute('target')).toBe('_blank');
    // Body still carries the descriptive text alongside the link.
    expect(el.textContent).toContain('Pull now failed.');
  });
});

describe('admin auth gate behavior', () => {
  // init() is async (it probes /api/config and /api/admin/me). Yield to the
  // microtask queue + a tick so the promise chain settles before asserting.
  async function waitForInit() {
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
  }

  it('shows the auth gate when no credentials are stored', async () => {
    bootDom();
    await waitForInit();
    const gate = document.getElementById('auth-gate');
    const app = document.getElementById('app');
    expect(gate.hidden).toBe(false);
    expect(app.hidden).toBe(true);
  });

  it('shows the app shell when a PAT is already in localStorage', async () => {
    bootDom({ pat: 'ghp_fake_for_test' });
    await waitForInit();
    const gate = document.getElementById('auth-gate');
    const app = document.getElementById('app');
    expect(gate.hidden).toBe(true);
    expect(app.hidden).toBe(false);
  });

  it('Sign out clears the PAT and re-shows the auth gate', async () => {
    bootDom({ pat: 'ghp_fake_for_test' });
    await waitForInit();
    document.getElementById('signout-btn').click();
    expect(window.localStorage.getItem('vic361_admin_pat')).toBeNull();
    expect(window.localStorage.getItem('vic361_admin_session')).toBeNull();
    expect(document.getElementById('auth-gate').hidden).toBe(false);
    expect(document.getElementById('app').hidden).toBe(true);
  });
});

describe('admin pure helpers', () => {
  let api;
  beforeEach(() => { api = bootDom(); });
  afterEach(() => { delete window.__vic361Admin; });

  const sampleEvents = [
    {
      date: '2026-04-20', name: 'Monday Bingo', time: '6 PM',
      venue: 'Palace Bingo', icons: ['community'], description: 'Cards at the door'
    },
    {
      date: '2026-04-25', name: 'Saturday Market', time: '9 AM',
      venue: 'Town Square', icons: ['shopping', 'free'], free: true,
      description: 'Local vendors and food'
    },
    {
      date: '2026-04-26', name: 'Sunday Concert', time: '7 PM',
      venue: 'Riverside Park', icons: ['music'], description: 'Free outdoor concert'
    }
  ];

  it('isWeekend identifies Fri/Sat/Sun', () => {
    expect(api.isWeekend('2026-04-20')).toBe(false); // Monday
    expect(api.isWeekend('2026-04-24')).toBe(true);  // Friday
    expect(api.isWeekend('2026-04-25')).toBe(true);  // Saturday
    expect(api.isWeekend('2026-04-26')).toBe(true);  // Sunday
    expect(api.isWeekend('')).toBe(false);
  });

  it('eventKey is stable and unique across events', () => {
    const keys = sampleEvents.map(api.eventKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[0]).toContain('Monday Bingo');
  });

  it('applyFilters filters by category, venue, and search', () => {
    api._state.candidates = sampleEvents;
    // Use the 'all' escape hatch so this test stays decoupled from wall-clock
    // time — the week filter is exercised separately below.
    api._state.filters = { search: '', category: 'music', venue: '', week: 'all' };
    expect(api.applyFilters(sampleEvents).map(e => e.name)).toEqual(['Sunday Concert']);

    api._state.filters = { search: 'market', category: '', venue: '', week: 'all' };
    expect(api.applyFilters(sampleEvents).map(e => e.name)).toEqual(['Saturday Market']);

    api._state.filters = { search: '', category: '', venue: 'Palace Bingo', week: 'all' };
    expect(api.applyFilters(sampleEvents).map(e => e.name)).toEqual(['Monday Bingo']);
  });

  it('groupByDate buckets events by date in chronological order', () => {
    const groups = api.groupByDate(sampleEvents);
    expect(groups.map(([d]) => d)).toEqual(['2026-04-20', '2026-04-25', '2026-04-26']);
    expect(groups[0][1][0].name).toBe('Monday Bingo');
  });

  it('buildNewsletterHtml renders selected events into HTML', () => {
    api._state.candidates = sampleEvents;
    api._state.selected = new Set(sampleEvents.map(api.eventKey));
    const html = api.buildNewsletterHtml();
    expect(html).toContain('Saturday Market');
    expect(html).toContain('Sunday Concert');
    expect(html).toContain('This Week in The Vic 361');
  });

  it('buildNewsletterHtml returns an empty-state message when nothing selected', () => {
    api._state.candidates = sampleEvents;
    api._state.selected = new Set();
    expect(api.buildNewsletterHtml()).toContain('No events selected');
  });

  it('utf8ToBase64 round-trips UTF-8 text', () => {
    const s = 'Vic 361 — café & música';
    const b64 = api.utf8ToBase64(s);
    // Decode through Buffer to confirm fidelity.
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    expect(decoded).toBe(s);
  });

  it('exposes the documented constants', () => {
    expect(api._constants.PAT_KEY).toBe('vic361_admin_pat');
    expect(api._constants.REPO_OWNER).toBe('Tmpalori');
    expect(api._constants.REPO_NAME).toBe('thevic361');
    expect(api._constants.BRANCH).toBe('main');
    expect(api._constants.WEEKDAY_TARGET_MIN).toBe(4);
    expect(api._constants.WEEKDAY_TARGET_MAX).toBe(8);
    expect(api._constants.WEEKEND_TARGET_MIN).toBe(8);
    expect(api._constants.WEEKEND_TARGET_MAX).toBe(12);
    expect(api._constants.PREVIEW_STORAGE_PREFIX).toBe('vic361_preview_');
  });
});

describe('admin active-week filter', () => {
  let api;
  // Pin the clock to Monday 2026-04-27 18:37 America/Chicago. The system clock
  // in this test runner is UTC, so we use a UTC instant whose local-time
  // projection in Chicago (UTC-5 during DST) lands on that Monday evening.
  // Using local-time Date constructors below keeps assertions independent of
  // the runner's TZ — they always use the runner's local interpretation.
  beforeEach(() => {
    vi.useFakeTimers();
    // Pick a wall-clock instant in the runner's local time so getDay() returns
    // Monday regardless of TZ. 2026-04-27T12:00:00 local is unambiguously Mon.
    vi.setSystemTime(new Date(2026, 3, 27, 12, 0, 0)); // month is 0-indexed
    api = bootDom();
  });
  afterEach(() => {
    vi.useRealTimers();
    delete window.__vic361Admin;
  });

  it('getMondayOfWeek returns this Monday for a Monday', () => {
    const m = api.getMondayOfWeek();
    expect(api.toLocalDateStr(m)).toBe('2026-04-27');
  });

  it('getMondayOfWeek returns this Monday for a Sunday (end of same week)', () => {
    vi.setSystemTime(new Date(2026, 4, 3, 22, 0, 0)); // Sun 2026-05-03 evening
    const m = api.getMondayOfWeek();
    expect(api.toLocalDateStr(m)).toBe('2026-04-27');
  });

  it('getWeekRange returns Mon–Sun for offset 0 and 1', () => {
    expect(api.getWeekRange(0)).toEqual({
      mondayStr: '2026-04-27', sundayStr: '2026-05-03'
    });
    expect(api.getWeekRange(1)).toEqual({
      mondayStr: '2026-05-04', sundayStr: '2026-05-10'
    });
  });

  it('inWeekBucket "this" excludes prior-week dates and includes Mon–Sun', () => {
    // Last week — must be excluded from every bucket.
    expect(api.inWeekBucket('2026-04-20', 'this')).toBe(false);
    expect(api.inWeekBucket('2026-04-26', 'this')).toBe(false);
    expect(api.inWeekBucket('2026-04-20', 'next')).toBe(false);
    expect(api.inWeekBucket('2026-04-20', 'upcoming')).toBe(false);
    // This week (Mon–Sun).
    expect(api.inWeekBucket('2026-04-27', 'this')).toBe(true);
    expect(api.inWeekBucket('2026-05-03', 'this')).toBe(true);
    // Next week not in "this".
    expect(api.inWeekBucket('2026-05-04', 'this')).toBe(false);
    expect(api.inWeekBucket('2026-05-04', 'next')).toBe(true);
    expect(api.inWeekBucket('2026-05-10', 'next')).toBe(true);
    expect(api.inWeekBucket('2026-05-11', 'next')).toBe(false);
    // Upcoming includes both.
    expect(api.inWeekBucket('2026-04-27', 'upcoming')).toBe(true);
    expect(api.inWeekBucket('2026-05-11', 'upcoming')).toBe(true);
  });

  it('applyFilters defaults to "this" week, hiding stale prior-week events', () => {
    const events = [
      { date: '2026-04-20', name: 'Last Mon Bingo', venue: 'Palace', icons: [] },
      { date: '2026-04-26', name: 'Last Sun Concert', venue: 'Park', icons: [] },
      { date: '2026-04-27', name: 'This Mon Run', venue: 'Stadium', icons: [] },
      { date: '2026-05-03', name: 'This Sun Market', venue: 'Square', icons: [] },
      { date: '2026-05-04', name: 'Next Mon Show', venue: 'Hall', icons: [] }
    ];
    api._state.candidates = events;
    // Default week filter is 'this'.
    expect(api._state.filters.week).toBe('this');
    const out = api.applyFilters(events).map(e => e.name);
    expect(out).toEqual(['This Mon Run', 'This Sun Market']);
  });

  it('applyFilters with week="next" returns next Mon–Sun only', () => {
    const events = [
      { date: '2026-04-27', name: 'This Mon', venue: 'A', icons: [] },
      { date: '2026-05-04', name: 'Next Mon', venue: 'B', icons: [] },
      { date: '2026-05-10', name: 'Next Sun', venue: 'C', icons: [] },
      { date: '2026-05-11', name: 'Week After', venue: 'D', icons: [] }
    ];
    api._state.candidates = events;
    api._state.filters = { search: '', category: '', venue: '', week: 'next' };
    expect(api.applyFilters(events).map(e => e.name)).toEqual(['Next Mon', 'Next Sun']);
  });

  it('applyFilters with week="upcoming" includes this week + lookahead, but not past', () => {
    const events = [
      { date: '2026-04-20', name: 'Past', venue: 'A', icons: [] },
      { date: '2026-04-27', name: 'This Mon', venue: 'B', icons: [] },
      { date: '2026-05-15', name: 'Two Weeks Out', venue: 'C', icons: [] }
    ];
    api._state.candidates = events;
    api._state.filters = { search: '', category: '', venue: '', week: 'upcoming' };
    expect(api.applyFilters(events).map(e => e.name))
      .toEqual(['This Mon', 'Two Weeks Out']);
  });

  it('pruneStalePastSelections drops picks for dates before this Monday', () => {
    const events = [
      { date: '2026-04-20', name: 'Stale', venue: 'A', icons: [] },
      { date: '2026-04-27', name: 'Fresh', venue: 'B', icons: [] }
    ];
    api._state.candidates = events;
    api._state.selected = new Set(events.map(api.eventKey));
    api.pruneStalePastSelections();
    const kept = Array.from(api._state.selected);
    expect(kept.length).toBe(1);
    expect(kept[0]).toContain('Fresh');
  });

  it('renders a Week filter control in the picker', () => {
    const sel = document.getElementById('filter-week');
    expect(sel).not.toBeNull();
    const opts = Array.from(sel.options).map(o => o.value).sort();
    expect(opts).toEqual(['next', 'this', 'upcoming']);
    expect(sel.value).toBe('this');
  });
});

describe('admin dark mode toggle', () => {
  // jsdom does not implement matchMedia by default. Provide a stub that we
  // can flip per-test to simulate the user's OS-level color scheme.
  let osPrefersDark = false;
  beforeEach(() => {
    osPrefersDark = false;
    window.matchMedia = (q) => ({
      matches: q.includes('dark') ? osPrefersDark : !osPrefersDark,
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {}
    });
  });
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
    delete window.__vic361Admin;
  });

  it('renders a theme toggle in the auth gate AND the admin header', () => {
    bootDom();
    expect(document.getElementById('theme-toggle-auth')).not.toBeNull();
    expect(document.getElementById('theme-toggle')).not.toBeNull();
  });

  it('exposes the theme storage key constant', () => {
    const api = bootDom();
    expect(api._constants.THEME_KEY).toBe('vic361_admin_theme');
  });

  it('defaults to system preference when no choice is stored', () => {
    osPrefersDark = true;
    const api = bootDom();
    expect(api.getStoredTheme()).toBeNull();
    expect(api.effectiveTheme()).toBe('dark');

    osPrefersDark = false;
    document.documentElement.removeAttribute('data-theme');
    const api2 = bootDom();
    expect(api2.effectiveTheme()).toBe('light');
  });

  it('toggleTheme flips and persists the preference to localStorage', () => {
    const api = bootDom();
    expect(window.localStorage.getItem('vic361_admin_theme')).toBeNull();

    api.toggleTheme();
    expect(window.localStorage.getItem('vic361_admin_theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(api.effectiveTheme()).toBe('dark');

    api.toggleTheme();
    expect(window.localStorage.getItem('vic361_admin_theme')).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(api.effectiveTheme()).toBe('light');
  });

  it('clicking the header toggle switches theme and updates aria-pressed', async () => {
    const api = bootDom();
    // Wait for init() so wireEvents has attached the click listener.
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    const btn = document.getElementById('theme-toggle');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    btn.click();
    expect(api.effectiveTheme()).toBe('dark');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.querySelector('.theme-toggle__label').textContent).toBe('Light mode');
    btn.click();
    expect(api.effectiveTheme()).toBe('light');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.querySelector('.theme-toggle__label').textContent).toBe('Dark mode');
  });

  it('a stored "dark" preference is applied (initTheme sets data-theme)', () => {
    const api = bootDom();
    // Simulate the user having previously chosen dark, then re-init.
    window.localStorage.setItem('vic361_admin_theme', 'dark');
    api.initTheme();
    expect(api.getStoredTheme()).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('signout does NOT clear the theme preference', async () => {
    bootDom({ pat: 'ghp_fake_for_test' });
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    window.localStorage.setItem('vic361_admin_theme', 'dark');
    document.getElementById('signout-btn').click();
    expect(window.localStorage.getItem('vic361_admin_theme')).toBe('dark');
  });
});

describe('admin preview mode (PR #20)', () => {
  let api;
  beforeEach(() => {
    api = bootDom();
    window.sessionStorage.clear();
  });
  afterEach(() => {
    window.sessionStorage.clear();
    delete window.__vic361Admin;
  });

  // Generate a large picks list — the kind that broke ?preview=<json> URLs.
  function manyEvents(n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push({
        date: '2026-04-' + String(20 + (i % 7)).padStart(2, '0'),
        name: 'Event number ' + i + ' with a moderately long name',
        time: '7 PM',
        venue: 'Venue ' + (i % 10) + ' with descriptive label',
        icons: ['music', 'food'],
        description: 'Lorem ipsum dolor sit amet, '.repeat(8) + ' #' + i
      });
    }
    return out;
  }

  it('writePreviewToStorage stores the payload under the short key prefix', () => {
    const payload = { last_updated: '2026-04-26T00:00:00Z', events: manyEvents(3) };
    const key = api.writePreviewToStorage(payload);
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThan(0);
    const stored = window.sessionStorage.getItem('vic361_preview_' + key);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored).events.length).toBe(3);
  });

  it('buildPreviewSrc returns a SHORT URL even with 100+ events', () => {
    const payload = { last_updated: '2026-04-26T00:00:00Z', events: manyEvents(150) };
    const src = api.buildPreviewSrc(payload);
    // Old ?preview=<json-blob> approach produced URLs in the tens-of-thousands
    // of chars range. The new ?previewKey=<key> form must stay tiny.
    expect(src.startsWith('index.html?previewKey=')).toBe(true);
    expect(src.length).toBeLessThan(200);
  });

  it('buildPreviewSrc with empty picks is also short', () => {
    const src = api.buildPreviewSrc({ last_updated: 'x', events: [] });
    expect(src.startsWith('index.html?previewKey=')).toBe(true);
    expect(src.length).toBeLessThan(200);
  });
});

describe('Events tab starts from the live site', () => {
  afterEach(() => { delete window.__vic361Admin; });

  it('lists live events missing from candidates and checks exactly what is live', async () => {
    const api = bootDom();
    const live = [
      { date: '2099-01-02', name: 'Kept From Last Week', time: '7 PM', venue: 'A' },
      { date: '2099-01-03', name: 'In Both', time: '8 PM', venue: 'B' }
    ];
    const cands = [
      { date: '2099-01-03', name: 'In Both', time: '8 PM', venue: 'B' },
      { date: '2099-01-04', name: 'New This Week', time: '9 PM', venue: 'C' }
    ];
    window.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/api/admin/candidates')) return { ok: true, status: 200, json: async () => ({ ok: true, data: { events: cands } }) };
      if (u.includes('/api/admin/published-events')) return { ok: true, status: 200, json: async () => ({ ok: true, events: live }) };
      return { ok: false, status: 404, json: async () => ({}) };
    });
    window.localStorage.setItem('vic361_admin_picks', JSON.stringify(['2099-01-04|New This Week|C']));
    api._state.session = 'tok';
    await api.loadCandidates();
    const names = api._state.candidates.map(e => e.name);
    expect(names).toEqual(['Kept From Last Week', 'In Both', 'New This Week']);
    const picked = api.buildEventsPayload().events.map(e => e.name);
    expect(picked).toEqual(['Kept From Last Week', 'In Both']);
    expect(document.getElementById('count-summary').textContent).toContain('matches the live site');
  });
});

describe('Settings, Overview and Needs attention', () => {
  afterEach(() => { delete window.__vic361Admin; });
  const json = body => ({ ok: true, status: 200, json: async () => body });

  it('Settings lists unfinished setup items first and folds the finished ones', async () => {
    const api = bootDom();
    window.fetch = vi.fn(async () => json({
      ok: true,
      status: { upcoming_events: 42, pending_submissions: 3, subscribers: 10, collected_at: null },
      checks: [
        { key: 'database', label: 'Database', ok: true, level: 'required', fix: '' },
        { key: 'slack', label: 'Slack alerts', ok: false, level: 'recommended', fix: 'Set SLACK_WEBHOOK_URL' },
        { key: 'social', label: 'Auto-post', ok: null, level: 'recommended', fix: 'In GitHub', link: 'https://github.com/x' }
      ]
    }));
    api._state.session = 'tok';
    await api.loadSettings();
    expect(document.getElementById('home-setup-count').textContent).toBe('1 of 3 set up');
    const todo = Array.from(document.querySelectorAll('#home-checks .home-check strong')).map(n => n.textContent);
    expect(todo).toEqual(['Slack alerts', 'Auto-post']);
    expect(document.getElementById('home-checks').textContent).toContain('Set SLACK_WEBHOOK_URL');
    expect(document.getElementById('home-checks-done').textContent).toContain('Database');
    expect(document.getElementById('settings-done').hidden).toBe(false);
  });

  it('Needs attention gathers submissions, messages, a stale collect and setup gaps, escaped, with a count', async () => {
    const api = bootDom();
    const old = new Date(Date.now() - 6 * 86400000).toISOString();
    window.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/api/admin/messages')) return json({ ok: true, messages: [{ id: 'm1', created_at: new Date().toISOString(), name: 'Ann <b>', email: 'ann@shop.example', message: 'Sponsor week?' }] });
      if (u.includes('/api/admin/submissions')) return json({ ok: true, submissions: [{ id: 's1', submitter_kind: 'organizer', payload: { name: 'Chili Cookoff', date: '2099-10-17' }, ai_review: { decision: 'flag', reason: 'venue unclear' } }] });
      if (u.includes('/api/admin/hidden')) return json({ ok: true, hidden: [] });
      if (u.includes('/api/admin/setup')) return json({ ok: true, status: { collected_at: old }, checks: [
        { key: 'slack', label: 'Slack alerts', ok: false, level: 'recommended', fix: 'Set SLACK_WEBHOOK_URL' },
        { key: 'extra', label: 'Optional thing', ok: false, level: 'optional', fix: 'x' },
        { key: 'db', label: 'Database', ok: true, level: 'required', fix: '' }] });
      return json({ ok: true });
    });
    api._state.session = 'tok';
    await api.loadAttention();
    const list = document.getElementById('attention-list');
    expect(list.textContent).toContain('Chili Cookoff');
    expect(list.textContent).toContain('needs your look (venue unclear)');
    expect(list.textContent).toContain('Sponsor week?');
    expect(list.innerHTML).not.toContain('<b>');
    expect(list.textContent).toContain('haven’t been collected');
    expect(list.textContent).toContain('Slack alerts');
    expect(list.textContent).not.toContain('Optional thing');   // optional items stay in Settings
    expect(list.textContent).not.toContain('Database');         // done
    expect(document.getElementById('attention-badge').textContent).toBe('4');
    // The filter chips narrow it to one group.
    document.querySelector('#attention-filters [data-filter="Messages"]').click();
    expect(list.textContent).toContain('Sponsor week?');
    expect(list.textContent).not.toContain('Chili Cookoff');
  });

  it('Inbox shows each item with its full text, a reply button for people who wrote in, and marks the answered ones', async () => {
    const api = bootDom();
    const now = new Date().toISOString();
    const link = 'https://www.thevic361.com/admin.html#reply?to=rob%40example.com&subject=Re%3A+Welcome&ref=%3Cm1%40x%3E';
    const events = [
      { id: 4, created_at: now, channel: 'alerts', severity: 'urgent', kind: 'alert', title: '🚨 Database down', payload: { fields: [], text: 'ECONNREFUSED', link: null } },
      { id: 3, created_at: now, channel: 'inbox', severity: 'fyi', kind: 'reply', title: '↩️ Replied to ann@example.com', payload: { fields: [['Subject', 'Re: Hi']], text: 'Thanks!', link: null } },
      { id: 2, created_at: now, channel: 'inbox', severity: 'today', kind: 'email', title: '📬 Email from rob@example.com', payload: { fields: [['Subject', 'Re: Welcome']], text: 'Love it <b>', link } },
      { id: 1, created_at: now, channel: 'inbox', severity: 'today', kind: 'email', title: '📬 Email from ann@example.com', payload: { fields: [], text: 'Hi', link: link.replace('rob%40', 'ann%40') } }
    ];
    window.fetch = vi.fn(async (url) => (String(url).includes('/api/admin/inbox') ? json({ ok: true, events, more: true }) : json({ ok: true })));
    api._state.session = 'tok';
    await api.loadInbox();
    const list = document.getElementById('inbox-list');
    const items = [...list.querySelectorAll('.att-item')];
    expect(items).toHaveLength(4);
    expect(items[2].textContent).toContain('Love it <b>');                   // escaped, shown as text
    expect(list.innerHTML).not.toContain('<b>');
    expect(items[2].querySelector('a.btn').getAttribute('href')).toBe('#reply?to=rob%40example.com&subject=Re%3A+Welcome&ref=%3Cm1%40x%3E');
    expect(items[2].textContent).not.toContain('Replied');
    expect(items[3].textContent).toContain('Replied');                       // answered by the later ↩️ item
    expect(items[1].querySelector('a.btn')).toBeNull();                      // our own reply has nothing to answer
    expect(document.getElementById('inbox-more').hidden).toBe(false);
    document.querySelector('#inbox-filters [data-filter="People"]').click();
    expect(list.querySelectorAll('.att-item')).toHaveLength(2);
    expect(list.textContent).not.toContain('Database down');
  });

  it('Overview shows the headline numbers, both charts and the attention banner', async () => {
    const api = bootDom();
    const days = n => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2099, 0, i + 1)).toISOString().slice(0, 10));
    window.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/api/admin/setup')) return json({ ok: true, checks: [], status: { upcoming_events: 42, subscribers: 30, collected_at: new Date().toISOString(), published_at: new Date().toISOString() } });
      if (u.includes('/api/admin/growth')) return json({ ok: true, goals: { subscribers: { active: 30, goal: 10000 }, revenue: { cents: 30000, goal_cents: 1000000, month: '2099-01', orders: 1 } },
        totals: { net: 20 }, daily: days(30).map(d => ({ day: d, net: 1 })), issues: [{ sent: 25, open_rate: 48, edition: 'weekend' }] });
      if (u.includes('/api/admin/traffic')) return json({ ok: true, daily: days(14).map((d, i) => ({ day: d, visitors: 10 + i })), sources: [{ key: 'facebook', count: 9 }], top_pages: [{ key: '/', count: 50 }] });
      if (u.includes('/api/admin/messages')) return json({ ok: true, messages: [{ id: 'm1', created_at: new Date().toISOString(), name: 'Ann', message: 'Hi' }] });
      return json({ ok: true });
    });
    api._state.session = 'tok';
    await api.loadHome();
    await new Promise(r => setTimeout(r, 0));
    const kpis = document.getElementById('home-kpis').textContent;
    expect(kpis).toContain('30');
    expect(kpis).toContain('$300');
    expect(kpis).toContain('48%');
    expect(document.querySelectorAll('#home-subs-chart .chart-line').length).toBe(1);
    expect(document.querySelectorAll('#home-visits-chart .chart-bar').length).toBe(14);
    expect(document.getElementById('home-visits-meta').textContent).toContain('facebook');
    expect(document.getElementById('home-site').textContent).toContain('Home 50');
    const banner = document.getElementById('home-attention');
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain('1 thing needs you: 1 message');
  });
});

describe('Traffic totals', () => {
  afterEach(() => { delete window.__vic361Admin; });
  const v = n => ({ visitors: n, views: n });
  const base = { daily: [], top_pages: [], sources: [], referrer_sites: [], clicks: [], top_clicked: [], crawlers: [], crawler_pages: [] };

  it('labels the box with the period picked and doesn\'t repeat 7 days', () => {
    const api = bootDom();
    api.renderTraffic({ ...base, days: 7, totals: { today: v(1), week: v(7), range: v(7) } });
    let text = document.getElementById('traffic-totals').textContent;
    expect(text.match(/Last 7 days/g)).toHaveLength(1);
    api.renderTraffic({ ...base, days: 90, totals: { today: v(1), week: v(7), range: v(90) } });
    text = document.getElementById('traffic-totals').textContent;
    expect(text).toContain('Last 90 days90 visitors');
    expect(text).toContain('Last 7 days');
  });

  it('totals shares sent and the views shared links brought', () => {
    const api = bootDom();
    api.renderTraffic({ ...base, days: 30, totals: { today: v(1), week: v(7), range: v(30) },
      clicks: [{ key: 'event_click', count: 9 }, { key: 'share_native', count: 3 }, { key: 'share_facebook', count: 2 }],
      sources: [{ key: 'Direct', count: 40 }, { key: 'Shared link', count: 6 }] });
    expect(document.getElementById('traffic-totals').textContent).toContain('Shares, last 30 days5 sent · 6 views from shared links');
  });
});

describe('Events tab safety', () => {
  afterEach(() => { delete window.__vic361Admin; });
  const live = [{ date: '2099-01-03', name: 'In Both', time: '8 PM', venue: 'B' }];
  const cands = [
    { date: '2099-01-03', name: 'In Both', time: '8 PM', venue: 'B' },
    { date: '2099-01-04', name: 'New This Week', time: '9 PM', venue: 'C' }
  ];
  function stub(publishedOk = true) {
    window.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/api/admin/candidates')) return { ok: true, status: 200, json: async () => ({ ok: true, data: { events: cands } }) };
      if (u.includes('/api/admin/published-events')) {
        return publishedOk
          ? { ok: true, status: 200, json: async () => ({ ok: true, events: live }) }
          : { ok: false, status: 500, json: async () => ({ ok: false }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
  }

  it('Reload keeps unsaved checkmarks', async () => {
    const api = bootDom();
    stub();
    api._state.session = 'tok';
    await api.loadCandidates();
    api._state.selected.add('2099-01-04|New This Week|C');
    api._state.selected.delete('2099-01-03|In Both|B');
    window.localStorage.setItem('vic361_admin_pending', JSON.stringify({ add: ['2099-01-04|New This Week|C'], remove: ['2099-01-03|In Both|B'] }));
    await api.loadCandidates();
    expect(api.buildEventsPayload().events.map(e => e.name)).toEqual(['New This Week']);
  });

  it('turns Save & Publish off when the live list fails to load', async () => {
    const api = bootDom();
    stub(false);
    api._state.session = 'tok';
    await api.loadCandidates();
    expect(document.getElementById('publish-btn').disabled).toBe(true);
    window.confirm = vi.fn(() => true);
    api._state.session = 'tok'; // boot's async sign-in check clears it in jsdom
    await api.publish();
    expect(window.confirm).not.toHaveBeenCalled();
    expect(document.getElementById('status-message').textContent).toMatch(/Reload/);
  });
});
