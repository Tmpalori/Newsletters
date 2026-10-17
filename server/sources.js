/* server/sources.js — Per-source collection status for the admin "Sources" tab.
 *
 * Reads the local `collection_metadata.json` written by collect_events.py
 * (alongside candidates.json) and surfaces it to the admin UI:
 *
 *   - per-source row with name, count, status, last/started timestamps
 *   - last successful collection run timestamp (file mtime fallback)
 *   - next scheduled auto-pull time, computed from the Weekly Collect cron
 *
 * The site queues the collect for the town's jobs worker Sunday and
 * Wednesday at 3:23 PM town time (server/scheduler.js); `next_run_cron` is
 * that slot in UTC during CDT (`23 20 * * 0,3`).
 *
 * If `collection_metadata.json` is missing (e.g. the workflow hasn't run yet
 * after this code shipped), the response falls back to "unknown" but still
 * tells the UI when the next auto-pull will be and which sources we expect.
 */

import { promises as fsp } from 'node:fs';
import { JOBS, COLLECT_JOBS, localParts, slotStart } from './scheduler.js';

// Source list expected from collect_events.py. Used to render placeholder
// rows when collection_metadata.json doesn't yet exist (e.g. between the
// time this code ships and the next Sunday workflow run).
const KNOWN_SOURCES = [
  { name: 'local_events',          label: 'Local YAML',           category: 'local' },
  { name: 'google_sheet',          label: 'Google Sheet',         category: 'submission' },
  { name: 'city_calendar',         label: 'City of Victoria',     category: 'web' },
  { name: 'chamber',               label: 'Chamber of Commerce',  category: 'web' },
  { name: 'library',               label: 'Public Library',       category: 'web' },
  { name: 'moonshine',             label: 'Moonshine Drinkery',   category: 'web' },
  { name: 'vtx_artwalk',           label: 'VTX Art Walk',         category: 'web' },
  { name: 'jwelch',                label: 'J Welch Farms',        category: 'web' },
  { name: 'theatre_victoria',      label: 'Theatre Victoria',     category: 'web' },
  { name: 'generals',              label: 'Victoria Generals',    category: 'web' },
  { name: 'allevents',             label: 'AllEvents.in',         category: 'web' },
  { name: 'apify_facebook',        label: 'Apify · Facebook events', category: 'apify' },
  { name: 'apify_eventbrite',      label: 'Apify · Eventbrite',   category: 'apify' },
  { name: 'apify_facebook_posts',  label: 'Apify · Facebook posts → OpenAI', category: 'apify' },
  { name: 'apify_instagram_posts', label: 'Apify · Instagram posts → OpenAI', category: 'apify' },
  { name: 'gemini_search', label: 'Gemini · Google Search', category: 'ai' },
];

const KNOWN_BY_NAME = new Map(KNOWN_SOURCES.map(s => [s.name, s]));

// Next scheduled collect strictly AFTER `now`: the site starts it Sunday
// and Wednesday at 3:23 PM in the town's time (server/scheduler.js,
// weekly-collect and weekly-collect-midweek), which is 20:23 UTC in summer
// and 21:23 UTC in winter.
export function nextWeeklyRunUtc(now) {
  const ref = now ? new Date(now.getTime()) : new Date();
  const today = localParts(ref).date;
  const jobs = JOBS.filter(j => COLLECT_JOBS.includes(j.name));
  for (let add = 0; add <= 8; add++) {
    const d = new Date(today + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + add);
    const ymd = d.toISOString().slice(0, 10);
    for (const job of jobs.filter(j => j.dow === d.getUTCDay())) {
      const t = slotStart(job, ymd);
      if (t.getTime() > ref.getTime()) return t;
    }
  }
  return null;
}

// Reads `collection_metadata.json` from disk if present. Returns null on
// any read/parse failure — callers must degrade gracefully.
export async function readMetadataFile(metadataPath) {
  try {
    const stat = await fsp.stat(metadataPath);
    const raw = await fsp.readFile(metadataPath, 'utf8');
    const parsed = JSON.parse(raw);
    return { meta: parsed, mtime: stat.mtime.toISOString() };
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    return null;
  }
}

// Builds the response payload the /api/admin/sources route returns. Pure
// function over its inputs so it's easy to test.
// The collector's Apify spend (collect_events.py apify_spend): numbers only,
// so a malformed file can't put text in the admin.
function apifySpend(a) {
  if (!a || typeof a !== 'object') return null;
  const n = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const out = { month_usd: n(a.month_usd), limit_usd: n(a.limit_usd), run_usd: n(a.run_usd),
    cycle_end: typeof a.cycle_end === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a.cycle_end) ? a.cycle_end : null };
  return out.month_usd == null ? null : out;
}

// Facebook pages the collector skips for having no posts lately
// (collect_events.py quiet pages), for the owner to check their links.
function quietPages(q) {
  if (!q || typeof q !== 'object') return [];
  return Object.entries(q)
    .filter(([url, r]) => /^https:\/\/(www\.|m\.)?facebook\.com\//.test(url) && r && typeof r === 'object')
    .map(([url, r]) => ({ url, name: String(r.name || '').slice(0, 120), misses: Number(r.misses) || 0,
      since: /^\d{4}-\d{2}-\d{2}$/.test(String(r.since || '')) ? r.since : null }))
    .filter(r => r.misses >= 2)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// githubConfigured: whether Pull Now works (it queues a collect for the
// town's jobs worker; the name is from when it dispatched a GitHub workflow).
export function buildSourcesPayload({ metadata, mtime, now, githubConfigured, actionsUrl }) {
  const next = nextWeeklyRunUtc(now);
  const seenNames = new Set();
  const rows = [];

  // Map from collector stats. Falls back to {} when metadata is missing.
  const lastRunAt = (metadata && metadata.last_run_at) || mtime || null;
  const stats = Array.isArray(metadata && metadata.sources) ? metadata.sources : [];

  for (const s of stats) {
    const known = KNOWN_BY_NAME.get(s.name);
    rows.push({
      name: s.name,
      label: known ? known.label : s.name,
      category: known ? known.category : 'other',
      count: typeof s.count === 'number' ? s.count : 0,
      status: s.status || 'unknown',
      message: s.message || null,
      started_at: s.started_at || null,
      finished_at: s.finished_at || null,
      last_pulled_at: s.finished_at || lastRunAt,
    });
    seenNames.add(s.name);
  }

  // Fill in placeholder rows for any known source the metadata didn't cover.
  // Status "unknown" tells the UI to render a muted state — no count, no
  // last-pulled time. This keeps the tab useful before the first metadata
  // file is written.
  for (const k of KNOWN_SOURCES) {
    if (seenNames.has(k.name)) continue;
    rows.push({
      name: k.name,
      label: k.label,
      category: k.category,
      count: 0,
      status: 'unknown',
      message: metadata
        ? 'Source did not appear in latest collection metadata.'
        : 'No collection_metadata.json yet — waiting for the next pull.',
      started_at: null,
      finished_at: null,
      last_pulled_at: null,
    });
  }

  return {
    ok: true,
    last_run_at: lastRunAt,
    next_run_at: next.toISOString(),
    next_run_cron: '23 20 * * 0,3',
    next_run_note: 'Sundays and Wednesdays, mid-afternoon Central (about 3:30 PM)',
    metadata_present: Boolean(metadata),
    merged_count: metadata && typeof metadata.merged_count === 'number'
      ? metadata.merged_count : null,
    raw_count: metadata && typeof metadata.raw_count === 'number'
      ? metadata.raw_count : null,
    window_start: metadata && metadata.window_start ? metadata.window_start : null,
    window_end: metadata && metadata.window_end ? metadata.window_end : null,
    candidates_only: metadata && typeof metadata.candidates_only === 'boolean'
      ? metadata.candidates_only : null,
    trigger_enabled: Boolean(githubConfigured),
    trigger_workflow_file: 'weekly-collect.yml',
    // No GitHub fallback any more (jobs run on Railway); null.
    actions_url: actionsUrl || null,
    // Save & Publish doesn't depend on Pull Now. Surfaced so the UI can
    // reassure the user when Pull Now fails.
    save_publish_unaffected: true,
    apify: apifySpend(metadata && metadata.apify),
    quiet_pages: quietPages(metadata && metadata.quiet_pages),
    sources: rows,
  };
}

export const KNOWN_SOURCES_FOR_TESTS = KNOWN_SOURCES;
