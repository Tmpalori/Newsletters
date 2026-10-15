/* server/town.js — Which town this site is (MULTI_CITY_PLAN.md, Phase 1).
 *
 * Each town runs as its own Railway service with its own database, so the
 * town is chosen once per process: TOWN (Railway variable) names it, and
 * unset or "victoria" is The Vic 361 with exactly today's values. Any other
 * town reads towns/<slug>/town.json; a missing file or field stops the boot
 * rather than quietly showing Victoria's name on another town's site.
 *
 * Renderers read `town` at call time (town.siteName, town.domain, …), so
 * createApp({ town }) or useTown() switches every page and email at once.
 * Fields arrive with the step that moves their literals (plan 1.2a–g).
 *
 * Names and domains go into pages and attributes as they are, so they're
 * checked here: no <, >, & or ", and the GA ID is G-XXXX or empty.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const VICTORIA = Object.freeze({
  id: 'victoria',
  // Identity
  siteName: 'The Vic 361',
  siteNameHtml: 'The Vic <span>361</span>',   // the header's two-tone title
  shortName: 'Vic 361',                        // "Confirm your Vic 361 subscription"
  pickName: 'Vic’s Pick',                      // the paid pick; pickNamePlain is the plain-text twin
  pickNamePlain: "Vic's Pick",
  domain: 'thevic361.com',
  siteUrl: 'https://www.thevic361.com',
  emailFrom: 'The Vic 361 <news@thevic361.com>',
  gaId: 'G-52YHD3X3C2',
  icalDomain: 'thevic361.com',
  utmSource: 'thevic361',                       // utm_source on links we send people out through
  // Starts every key we hand Stripe (lookup keys, idempotency keys, product
  // metadata), Resend (idempotency keys) and Tremendous (external_id), so
  // two towns on one account never collide. Another town's is its slug.
  keyPrefix: 'vic361',
  // Geography
  city: 'Victoria',
  state: 'TX',
  stateName: 'Texas',
  cityState: 'Victoria, TX',          // place labels, footers, page text
  cityStateLong: 'Victoria, Texas',   // schema.org areaServed, about text
  // Copy only a local would write: who we gather from (about page) and the
  // area code people know the region by (llms.txt).
  localSources: 'the City of Victoria, the Victoria Public Library, the Chamber of Commerce',
  areaCode: '361',
  timezone: 'America/Chicago',
  // Money and limits. Amounts are in cents (what Stripe charges); the
  // price text on pages and emails is generated from them (dollars()).
  business: Object.freeze({
    weeklyAmount: 14900,                        // weekly sponsor
    pickAmount: { weekday: 2900, weekend: 3900 },   // a pick, Mon–Thu / Fri–Sun
    pickCap: { weekday: 3, weekend: 4 },        // picks sold per day
    dayMax: { weekday: 15, weekend: 20 },       // events the curator lists per day
    picks: { weekday: 2, weekend: 3 },          // editor's picks per day
    picksMin: { weekday: 1, weekend: 2 },
    drawingAmount: 25,                          // monthly referral drawing, dollars
    rewardCards: [{ n: 5, amount: 10 }, { n: 10, amount: 25 }],   // referral gift cards, dollars
    showSubscribersFrom: 100,                   // say "N+ subscribers" only from here
    showReadersFrom: 500                        // say "N readers this week" only from here
  }),
  // Job start times that differ from server/scheduler.js JOBS (Central-style
  // "HH:MM" in the town's timezone). Victoria runs the defaults.
  schedule: Object.freeze({})
});

// What another town starts from when its town.json leaves a number out.
const SHARED_BUSINESS = VICTORIA.business;

const REQUIRED = ['siteName', 'domain', 'city', 'state', 'stateName', 'timezone'];
const SAFE_TEXT = /^[^<>&"]+$/;

// A town from its own settings plus what follows from them (never from
// Victoria's: a forgotten field must not show Victoria's domain or GA ID).
function complete(id, raw) {
  raw = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
  const missing = REQUIRED.filter(k => !raw[k]);
  if (missing.length) throw new Error(`TOWN=${id}: town.json is missing ${missing.join(', ')}`);
  const domain = String(raw.domain);
  return {
    siteNameHtml: raw.siteName,
    shortName: String(raw.siteName).replace(/^the\s+/i, ''),
    pickName: 'Local Pick',
    pickNamePlain: String(raw.pickName || 'Local Pick').replace(/[’‘]/g, "'"),
    localSources: 'the city, the library, the chamber of commerce',
    areaCode: '',
    siteUrl: `https://www.${domain}`,
    emailFrom: `${raw.siteName} <news@${domain}>`,
    gaId: '',
    icalDomain: domain,
    utmSource: domain.replace(/\.[a-z]+$/, '').replace(/[^a-z0-9]/g, ''),
    keyPrefix: id,
    cityState: `${raw.city}, ${raw.state}`,
    cityStateLong: `${raw.city}, ${raw.stateName}`,
    ...raw,
    business: { ...SHARED_BUSINESS, ...(raw.business || {}) },
    schedule: { ...(raw.schedule || {}) },
    id
  };
}

function fromFile(id, dir) {
  const file = path.join(dir, id, 'town.json');
  const publicDir = path.join(dir, id, 'public');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
    throw new Error(`TOWN=${id}: can't read ${path.relative(ROOT, file) || file} (${err.code || err.message})`);
  }
  return complete(id, { publicDir, ...raw });
}

function check(t) {
  for (const k of ['siteName', 'shortName', 'pickName', 'pickNamePlain', 'city', 'state', 'stateName', 'cityState', 'cityStateLong', 'localSources']) {
    if (!SAFE_TEXT.test(String(t[k] || ''))) throw new Error(`TOWN=${t.id}: ${k} can't be empty or contain < > & "`);
  }
  for (const k of ['domain', 'icalDomain']) {
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(String(t[k]))) throw new Error(`TOWN=${t.id}: ${k} "${t[k]}" doesn't look like a domain`);
  }
  if (!/^[^<>&"]+ <[^<>&"\s@]+@[a-z0-9.-]+>$/.test(String(t.emailFrom))) throw new Error(`TOWN=${t.id}: emailFrom must look like Name <news@domain>`);
  if (!/^https:\/\/[a-z0-9.-]+$/.test(t.siteUrl)) throw new Error(`TOWN=${t.id}: siteUrl must be https://host with no path`);
  if (!/^[a-z0-9_-]+$/.test(String(t.utmSource))) throw new Error(`TOWN=${t.id}: utmSource must be lowercase letters, digits, - or _`);
  if (!/^[a-z0-9-]+$/.test(String(t.keyPrefix)) || (t.id !== VICTORIA.id && t.keyPrefix === VICTORIA.keyPrefix)) {
    throw new Error(`TOWN=${t.id}: keyPrefix must be lowercase letters, digits or -, and not Victoria's`);
  }
  if (t.areaCode && !/^\d{3}$/.test(t.areaCode)) throw new Error(`TOWN=${t.id}: areaCode must be 3 digits or empty`);
  if (t.gaId && !/^G-[A-Z0-9]+$/.test(t.gaId)) throw new Error(`TOWN=${t.id}: gaId must look like G-XXXXXXX`);
  const b = t.business || {};
  const cents = v => Number.isInteger(v) && v >= 100;
  const pair = (v, ok) => v && ok(v.weekday) && ok(v.weekend);
  const count = v => Number.isInteger(v) && v >= 0 && v <= 100;
  if (!cents(b.weeklyAmount) || !pair(b.pickAmount, cents)) throw new Error(`TOWN=${t.id}: business amounts must be whole cents, at least 100`);
  if (![b.pickCap, b.dayMax, b.picks, b.picksMin].every(v => pair(v, count))) throw new Error(`TOWN=${t.id}: business caps need weekday and weekend counts`);
  if (!Number.isInteger(b.drawingAmount) || !Array.isArray(b.rewardCards) || !Number.isInteger(b.showSubscribersFrom) || !Number.isInteger(b.showReadersFrom)) {
    throw new Error(`TOWN=${t.id}: business needs drawingAmount, rewardCards, showSubscribersFrom and showReadersFrom`);
  }
  for (const [job, at] of Object.entries(t.schedule || {})) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(at))) throw new Error(`TOWN=${t.id}: schedule.${job} must be "HH:MM"`);
  }
  try { new Intl.DateTimeFormat('en-US', { timeZone: t.timezone }); } catch (_) {
    throw new Error(`TOWN=${t.id}: unknown timezone "${t.timezone}"`);
  }
  return Object.freeze(t);
}

// The town for these settings. overrides.town (a town.json-shaped object)
// wins, for tests.
export function townConfig(env = process.env, overrides = {}) {
  if (overrides.town) return check(complete(overrides.town.id || 'test', overrides.town));
  const id = String(env.TOWN || 'victoria').trim().toLowerCase();
  if (id === 'victoria') return VICTORIA;
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`TOWN="${env.TOWN}" isn't a town slug (lowercase letters, digits, dashes)`);
  return check(fromFile(id, overrides.townsDir || path.join(ROOT, 'towns')));
}

// Every other town's domain, from towns/*/town.json (unreadable or
// domain-less files are skipped): what Victoria's inbound email filter
// leaves to them.
export function otherTownDomains(t = town, townsDir = path.join(ROOT, 'towns')) {
  let ids = [];
  try { ids = fs.readdirSync(townsDir); } catch (_) { return []; }
  return ids.filter(id => id !== t.id).flatMap(id => {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(townsDir, id, 'town.json'), 'utf8')).domain;
      return typeof d === 'string' && d && d !== t.domain ? [d.toLowerCase()] : [];
    } catch (_) { return []; }
  });
}

// Where a town's data lives, relative to the repo root: Victoria's at the
// root and in docs/ (where it always was), another town's under
// towns/<slug>/ (its public files in towns/<slug>/public/, served before
// docs/). The collector, the social kit, the admin's GitHub reads and writes
// and the server all use these (town.py town_paths() is the Python twin).
export function townPaths(t = town) {
  const own = t.id === VICTORIA.id ? '' : `towns/${t.id}/`;
  const pub = t.id === VICTORIA.id ? 'docs/' : `towns/${t.id}/public/`;
  return {
    candidates: `${own}candidates.json`,
    collectionMetadata: `${own}collection_metadata.json`,
    enrichmentCache: `${own}enrichment_cache.json`,
    venues: `${own}venues.json`,
    localEvents: `${own}local_events.yaml`,
    extras: `${own}extras.yaml`,
    events: `${pub}events.json`,
    social: `${pub}social/latest/`
  };
}

// Settings a service copied from Victoria's would keep: another town
// refuses to start on Victoria's site URL, sender address or Google tag
// (it would link, mail and count as The Vic 361). Victoria passes.
export function townBootProblems(t, { siteUrl = '', emailFrom = '' } = {}) {
  if (t.id === VICTORIA.id) return [];
  const host = u => { try { return new URL(u).hostname.toLowerCase(); } catch (_) { return ''; } };
  const onVictoria = h => h === VICTORIA.domain || h.endsWith('.' + VICTORIA.domain);
  const problems = [];
  if (onVictoria(host(siteUrl))) problems.push(`SITE_URL is Victoria's (${siteUrl}); set it to ${t.siteUrl}`);
  const sender = (/@([^>\s]+)/.exec(String(emailFrom)) || [])[1] || '';
  if (onVictoria(sender.toLowerCase())) problems.push(`NEWSLETTER_FROM sends as Victoria (${emailFrom}); use an address on ${t.domain}`);
  if (t.gaId && t.gaId === VICTORIA.gaId) problems.push(`gaId is Victoria's Google tag (${t.gaId}); leave it out or use the town's own`);
  return problems;
}

// TOWN forgotten on a new town's service: unset means Victoria, so it would
// boot as a full clone of The Vic 361 on the new domain (Victoria's name,
// canonicals and Google tag; with a GITHUB_TOKEN, a second dispatch of
// Victoria's workflows). A service running as Victoria must therefore be on
// Victoria's SITE_URL (www.thevic361.com, or any thevic361.com host) or have
// none. Railway's own hosts (staging and PR copies) and local ones pass too.
// Returns the reason it won't start, or ''.
export function victoriaBootProblem(t, envSiteUrl = '') {
  if (t.id !== VICTORIA.id) return '';
  const raw = String(envSiteUrl || '').trim();
  if (!raw) return '';
  let h;
  try { h = new URL(raw).hostname.toLowerCase(); } catch (_) { return ''; }
  const ok = [VICTORIA.domain, 'railway.app', 'localhost'].some(d => h === d || h.endsWith('.' + d)) ||
    h === '127.0.0.1' || h === '[::1]';
  return ok ? '' : `TOWN is unset (Victoria) but SITE_URL is ${raw}: this service would run as The Vic 361 on another ` +
    `domain. Set TOWN to the town's slug (towns/<slug>/town.json), or SITE_URL to ${VICTORIA.siteUrl} for Victoria.`;
}

// Inputs for a workflow the server dispatches (MULTI_CITY_PLAN.md 3.5):
// another town names itself in the workflows' `town` input; Victoria's
// dispatches stay as they were (no input means victoria).
export function townInputs(inputs, t = town) {
  return t.id === VICTORIA.id ? inputs : { ...(inputs || {}), town: t.id };
}

// Whether this town may start GitHub workflows. Until its own GitHub
// Environment exists (MULTI_CITY_PLAN.md 3.3) a workflow run as another
// town would still use the repo-level settings, which are Victoria's
// (SITE_URL, secrets, Facebook page). Victoria always may; another town once
// its town.json says "workflows": true (the same switch GitHub's scheduled
// collect reads, set when its Environment exists) or TOWN_WORKFLOWS=1.
// TOWN_WORKFLOWS=0 turns a town's off whatever town.json says.
export function townWorkflowsReady(t = town, env = process.env) {
  if (t.id === VICTORIA.id) return true;
  const flag = String(env.TOWN_WORKFLOWS || '').trim();
  return flag === '1' || (t.workflows === true && flag !== '0');
}

// The process's town. A live binding: modules that import it see useTown's
// change, so read its fields when rendering, never copy them at load.
export let town = townConfig();

// A static file for the town: its own copy in towns/<slug>/public/ (the
// overlay) when there is one, else Victoria's in docs/. Victoria has no
// overlay, so its files never move.
export const DOCS_DIR = path.join(ROOT, 'docs');
export function townAssetPath(file, t = town) {
  if (t.publicDir) {
    const own = path.join(t.publicDir, file);
    if (own.startsWith(t.publicDir + path.sep) && fs.existsSync(own)) return own;
  }
  return path.join(DOCS_DIR, file);
}

// "$49", or "$49.50" when there are cents.
export function dollars(cents) {
  return '$' + (cents % 100 ? (cents / 100).toFixed(2) : String(cents / 100));
}

export function useTown(t) {
  town = t || VICTORIA;
  return town;
}
