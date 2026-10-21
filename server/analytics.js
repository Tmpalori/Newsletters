/* server/analytics.js — First-party visitor stats for the admin Traffic tab.
 *
 * No cookies and no third-party service. Two inputs:
 *   - People: docs/track.js sends a beacon to POST /api/track on each page
 *     view and on the clicks sponsors care about. A view is sent only once
 *     the visitor engages (scroll, tap, click, key) or the page has been on
 *     screen for 5 seconds, which leaves out JS-running bots and instant
 *     bounces; the beacon also skips browsers signed into the admin.
 *   - Crawlers: a middleware notes HTML page hits from known search and AI
 *     bots (Googlebot, GPTBot, ClaudeBot, ...), so you can see whether the
 *     SEO work is being picked up.
 *
 * Visitors are counted with a hash of IP + user agent + day + a server
 * secret, so the same person is one visitor per day and nothing that
 * identifies them is stored. Multi-day totals sum daily visitors.
 */

import crypto from 'node:crypto';
import { localDateStr, addDays, HUB_PAGES } from './seo.js';
import { SEASONS } from './guides.js';
import { createRateLimiter, ipKey } from './rateLimit.js';

// Known crawlers, checked in order. Anything else bot-like is "Other bot".
// The third field sorts AI bots by what the visit means:
//   ask       an assistant fetched the page to answer someone's question
//             right now (they read us through the AI instead of visiting)
//   search    an AI search engine indexing pages it can cite and link to
//   training  copying pages to train a model; sends nothing back
const BOTS = [
  ['Googlebot', /googlebot|google-inspectiontool|storebot-google/i],
  ['Bingbot', /bingbot|bingpreview/i],
  ['ChatGPT (answering someone)', /chatgpt-user/i, 'ask'],
  ['ChatGPT search', /oai-searchbot/i, 'search'],
  ['GPTBot (AI training)', /gptbot/i, 'training'],
  ['Claude (answering someone)', /claude-user/i, 'ask'],
  ['Claude search', /claude-searchbot/i, 'search'],
  ['ClaudeBot (AI training)', /claudebot|anthropic-ai/i, 'training'],
  ['Perplexity (answering someone)', /perplexity-user/i, 'ask'],
  ['Perplexity search', /perplexitybot/i, 'search'],
  ['Meta AI (answering someone)', /meta-externalfetcher/i, 'ask'],
  ['Meta AI (AI training)', /meta-externalagent/i, 'training'],
  ['Common Crawl (AI training)', /ccbot/i, 'training'],
  ['Bytespider (AI training)', /bytespider/i, 'training'],
  ['Applebot', /applebot/i],
  ['DuckDuckBot', /duckduckbot/i],
  ['Facebook preview', /facebookexternalhit|facebot/i],
  ['Other bot', /bot\b|bot\/|crawl|spider|slurp|preview|headless|lighthouse|python-requests|curl\/|wget|scrapy|httpclient|go-http/i]
];
const AI_BOT_KIND = new Map(BOTS.filter(b => b[2]).map(([name, , kind]) => [name, kind]));
// Rows recorded before the AI bots were split up.
AI_BOT_KIND.set('GPTBot (ChatGPT)', 'search').set('ClaudeBot', 'search').set('PerplexityBot', 'search');

export function botName(ua) {
  const s = String(ua || '');
  if (!s) return 'Other bot';
  for (const [name, re] of BOTS) if (re.test(s)) return name;
  return null;
}

// Group referrers into sources people recognize. Webmail comes first: Gmail
// on the web is mail.google.com and its app com.google.android.gm, which
// the Google rule would otherwise take for search.
const SOURCES = [
  ['Newsletter', /(^|\.)(beehiiv\.com|mail\.google\.com|com\.google\.android\.gm|outlook\.live\.com|outlook\.office(365)?\.com|mail\.yahoo\.com)$/],
  ['Gemini', /^(gemini|bard)\.google\.com$/],
  ['Google', /(^|\.)google\./],
  ['Bing', /(^|\.)bing\.com$/],
  ['ChatGPT', /(^|\.)(chatgpt\.com|openai\.com)$/],
  ['Perplexity', /(^|\.)perplexity\.ai$/],
  ['Claude', /(^|\.)claude\.ai$/],
  ['Copilot', /(^|\.)(copilot\.microsoft\.com|copilot\.com)$/],
  ['Meta AI', /(^|\.)meta\.ai$/],
  ['DuckDuckGo', /(^|\.)duckduckgo\.com$/],
  ['Facebook', /(^|\.)(facebook\.com|fb\.com|fb\.me|messenger\.com)$/],
  ['Instagram', /(^|\.)instagram\.com$/],
  ['X / Twitter', /(^|\.)(t\.co|twitter\.com|x\.com)$/],
  ['Reddit', /(^|\.)reddit\.com$/],
  ['Nextdoor', /(^|\.)nextdoor\.com$/]
];

export const AI_SOURCES = new Set(['ChatGPT', 'Perplexity', 'Claude', 'Copilot', 'Gemini', 'Meta AI']);

// AI apps often send no referrer but tag links instead (ChatGPT adds
// ?utm_source=chatgpt.com). Only known sources count; anything else is noise.
const UTM_NAMES = { chatgpt: 'ChatGPT', openai: 'ChatGPT', perplexity: 'Perplexity', claude: 'Claude',
  copilot: 'Copilot', gemini: 'Gemini', newsletter: 'Newsletter' };
export function utmSource(utm) {
  const v = String(utm || '').toLowerCase().trim().slice(0, 100);
  if (!v) return null;
  const bare = v.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  for (const [name, re] of SOURCES) if (re.test(bare)) return name;
  return UTM_NAMES[bare.split('.')[0]] || null;
}

// A tap on a Meta ad arrives with the same facebook.com / instagram.com
// referrer as a tap on a free post, so the referrer can't tell them apart.
// The ad's link carries utm_medium=paid instead, and that tag wins. Meta's
// {{site_source_name}} URL parameter fills utm_source with fb, ig, an or msg.
const PAID_MEDIUMS = new Set(['paid', 'paid_social', 'paidsocial', 'cpc', 'ppc', 'ad', 'ads']);
const META_UTM = /^(fb|ig|an|msg|facebook|instagram|meta|messenger|audience_network)$/;
export function paidSource(utm, medium, refSource) {
  if (!PAID_MEDIUMS.has(String(medium || '').toLowerCase().trim())) return null;
  const src = String(utm || '').toLowerCase().trim();
  if (META_UTM.test(src) || refSource === 'Facebook' || refSource === 'Instagram') return 'Meta ads';
  return 'Other ads';
}

export function referrerSource(ref, siteHost) {
  let host = '';
  try { host = new URL(ref).hostname.toLowerCase(); } catch { return { source: 'Direct', host: '' }; }
  const bare = host.replace(/^www\./, '');
  if (!host || (siteHost && bare === String(siteHost).replace(/^www\./, ''))) return { source: 'Direct', host: '' };
  for (const [name, re] of SOURCES) if (re.test(bare)) return { source: name, host: bare };
  return { source: 'Other sites', host: bare };
}

export const SHARED_LINK = 'Shared link';

export function visitorHash(ip, ua, day, secret) {
  return crypto.createHash('sha256').update(`${secret}|${day}|${ip}|${ua}`).digest('hex').slice(0, 16);
}

// Which email a newsletter visit came from: the link's utm_campaign
// (server/newsletter.js utmTag: weekly-<Monday>, weekend-<Thursday>,
// welcome). Kept in the view's ref_host, so the issue report can credit
// the right issue; anything else isn't kept.
export const EMAIL_CAMPAIGN = /^(?:(?:weekly|weekend)-\d{4}-\d{2}-\d{2}|welcome)$/;

// event_click is a tap out to an event's own link (its venue's or
// organizer's page); event_open is a tap from a list to the event's page
// on this site (docs/track.js). Before October 2026 both were event_click;
// isOutbound tells the old rows apart.
export const CLICK_TYPES = new Set([
  'event_click', 'event_open', 'sponsor_click', 'subscribe_click', 'advertise_click',
  'add_to_calendar', 'share_native', 'share_from_list', 'share_facebook', 'share_x', 'share_text', 'filter'
]);

export const CLICK_LABELS = {
  event_click: 'Event links (out to the event)', event_open: 'Event pages opened from a list', sponsor_click: 'Sponsor clicks', subscribe_click: 'Subscribe clicks',
  advertise_click: 'Advertise page clicks', add_to_calendar: 'Added to calendar',
  share_native: 'Shares (sent or copied)', share_from_list: 'Shares from the event list', share_facebook: 'Shares to Facebook',
  share_x: 'Shares to X', share_text: 'Shares by text', filter: 'Filter taps'
};

// A clicked link that leaves the site: an absolute URL to another host.
// Paths ("/events/x") and links to this site are not outbound.
export function isOutbound(url, siteHost = '') {
  const s = String(url || '');
  if (!s || s.startsWith('/') || s.startsWith('#') || s.startsWith('?')) return false;
  let host = '';
  try { host = new URL(s).hostname.toLowerCase(); } catch { return false; }
  const bare = h => String(h || '').toLowerCase().replace(/^www\./, '');
  return Boolean(host) && (!siteHost || bare(host) !== bare(siteHost));
}

function cleanPath(p) {
  const s = String(p || '/').split('?')[0].split('#')[0].slice(0, 200);
  return s.startsWith('/') ? s : '/';
}

// Middleware: record page hits from known crawlers (humans come in through
// the beacon): HTML pages plus the machine-readable feeds AI assistants
// read (/events.json, /llms.txt). Runs after the response is sent; failures
// are logged and never affect the request. `now` is the app's clock, so a
// crawl lands on the same day the summary is anchored on.
//
// The user agent is whatever the client says, so anyone can claim to be
// Googlebot: without a cap, a loop of `curl -A Googlebot` wrote one row per
// request and could fill the database. Each client address (IPv6 on its
// /64) records at most CRAWL_PER_IP_MIN crawls a minute and everyone
// together CRAWL_ALL_MIN; past that the page is still served, just not
// counted. Real crawlers on a site this size stay far below both.
export const CRAWL_PER_IP_MIN = 30;
export const CRAWL_ALL_MIN = 300;
export function crawlerMiddleware(store, now = () => new Date(), {
  perIp = createRateLimiter({ windowMs: 60 * 1000, max: CRAWL_PER_IP_MIN }),
  overall = createRateLimiter({ windowMs: 60 * 1000, max: CRAWL_ALL_MIN })
} = {}) {
  return (req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path.startsWith('/admin') ||
      req.path === '/robots.txt') return next();
    const bot = botName(req.get('user-agent'));
    if (!bot || bot === 'Other bot') return next();
    const ip = ipKey(req.ip || (req.socket && req.socket.remoteAddress) || '');
    // The overall budget is only spent by requests the per-client cap let
    // through, so one flooding address can't use it up for everyone.
    if (!perIp.check(ip).ok || !overall.check('all').ok) return next();
    res.on('finish', () => {
      const type = String(res.get('content-type') || '');
      if (res.statusCode !== 200 || !/text\/html|application\/json|text\/plain/.test(type)) return;
      store.recordTraffic({
        day: localDateStr(now()), kind: 'crawl', path: cleanPath(req.path), bot
      }).catch(err => console.warn('[traffic] crawl record failed:', err.message));
    });
    next();
  };
}

// An ad's id is the sponsor order id (data-ad on the sponsor block and on
// paid Vic's Picks), the same charset LOGO_PATH in server/sponsors.js
// allows. Anything else is dropped, so a forged beacon can't stuff junk
// into a sponsor's report.
export const AD_ID = /^[A-Za-z0-9-]{8,64}$/;
const adId = v => (typeof v === 'string' && AD_ID.test(v) ? v : null);

// Parse and validate a beacon body into a traffic row, or null to ignore.
export function beaconRow(body, { ip, ua, secret, siteHost, now }) {
  if (!body || typeof body !== 'object') return null;
  if (botName(ua)) return null; // headless browsers and scripts that run JS
  const day = localDateStr(now);
  const base = { day, path: cleanPath(body.path), visitor: visitorHash(ip, ua, day, secret) };
  if (body.kind === 'view') {
    let { source, host } = referrerSource(String(body.ref || '').slice(0, 500), siteHost);
    // Our own email links are tagged utm_source=newsletter, and that tag
    // wins over the referrer: Gmail's link redirect sends google.com,
    // webmail sends its own host, and both read as the newsletter.
    const fromEmail = utmSource(body.utm) === 'Newsletter';
    const tagged = paidSource(body.utm, body.utm_medium, source) || (source === 'Direct' || fromEmail ? utmSource(body.utm) : null);
    if (tagged) source = tagged;
    if (source === 'Newsletter') {
      const campaign = String(body.utm_campaign || '').toLowerCase().trim();
      if (EMAIL_CAMPAIGN.test(campaign)) host = campaign;
    }
    // A link someone shared with a share button (?s=sh, docs/track.js),
    // whatever app it was opened from.
    if (body.via === 'share') source = SHARED_LINK;
    return { ...base, kind: 'view', ref_source: source, ref_host: host };
  }
  if (body.kind === 'click' && CLICK_TYPES.has(body.type)) {
    // A click inside an ad (a Vic's Pick in a list, the sponsor block)
    // carries its id, so the sponsor's report can count it.
    const ad = adId(body.ad);
    return { ...base, kind: 'click', click_type: body.type, click_url: String(body.url || '').slice(0, 300), ...(ad ? { ad } : {}) };
  }
  // An ad seen: at least half of it on screen for a second (docs/track.js),
  // once per ad per page load.
  if (body.kind === 'impression') {
    const ad = adId(body.ad);
    return ad ? { ...base, kind: 'impression', ad } : null;
  }
  return null;
}

// Where an ad was seen, in groups a sponsor recognizes. Day lists are the
// date-bound hub pages (/today, /this-weekend, /next-week...); the
// "upcoming" hub pages are topic guides, grouped with venue and seasonal
// guides.
const DAY_LISTS = new Set(HUB_PAGES.filter(p => p.range !== 'upcoming').map(p => p.path));
const GUIDES = new Set([...HUB_PAGES.filter(p => p.range === 'upcoming').map(p => p.path), ...SEASONS.map(s => s.path), '/venues']);
export const PAGE_TYPES = ['Homepage', 'Day lists', 'Event pages', 'Guides & venues', 'Other'];
export function pageType(path) {
  const p = cleanPath(path).replace(/\/+$/, '') || '/';
  if (p === '/' || p === '/index.html') return 'Homepage';
  if (DAY_LISTS.has(p)) return 'Day lists';
  if (p.startsWith('/events/')) return 'Event pages';
  if (GUIDES.has(p) || p.startsWith('/venues/')) return 'Guides & venues';
  return 'Other';
}

// Rows may come pre-grouped (see `weight` below); exported for the sponsor
// reports, which count the same way.
export function rowCount(rows) {
  return total(rows);
}

// Rows may come pre-grouped from the store (PgStore.listTraffic), with `n`
// raw rows each; raw rows count once.
const weight = r => (Number(r.n) > 0 ? Number(r.n) : 1);
const total = rows => rows.reduce((sum, r) => sum + weight(r), 0);

function countBy(rows, keyFn, limit) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k) m.set(k, (m.get(k) || 0) + weight(r));
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([key, count]) => ({ key, count }));
}

// Where visitors came from, one source per visitor per day: the outside
// source that brought them (a page reached by moving around the site reads
// "Direct" and never beats one), else Direct. With two outside sources in
// a day, the first counts (rows carry first_at from the store; without it,
// the order the rows came in).
export function visitorSources(views, limit) {
  const first = new Map();
  for (const r of views) {
    const k = `${r.day}|${r.visitor}`;
    const src = r.ref_source || 'Direct';
    const at = r.first_at || r.ts;
    const t = at instanceof Date ? at.toISOString() : String(at || '');
    const cur = first.get(k);
    if (!cur || (cur.src === 'Direct' && src !== 'Direct') ||
      (src !== 'Direct' && cur.src !== 'Direct' && t && cur.t && t < cur.t)) first.set(k, { src, t });
  }
  const m = new Map();
  for (const { src } of first.values()) m.set(src, (m.get(src) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([key, count]) => ({ key, count }));
}

function uniqueVisitors(rows) {
  // One visitor per (day, visitor hash); multi-day ranges sum daily uniques.
  return new Set(rows.map(r => `${r.day}|${r.visitor}`)).size;
}

// How AI shows up: people it sent here, and bots reading on its behalf.
function aiSummary(views, crawls) {
  const sent = views.filter(r => AI_SOURCES.has(r.ref_source));
  const kind = (k) => crawls.filter(r => AI_BOT_KIND.get(r.bot) === k);
  const asks = kind('ask');
  return {
    sent_visitors: uniqueVisitors(sent),
    sent_views: total(sent),
    sent_by: countBy(sent, r => r.ref_source, 10),
    answer_reads: total(asks),
    answer_reads_by: countBy(asks, r => r.bot, 10),
    answer_pages: countBy(asks, r => r.path, 10),
    search_crawls: total(kind('search')),
    training_crawls: total(kind('training'))
  };
}

// Build the admin Traffic payload from raw rows.
export function summarize(rows, { now, days = 30, siteHost = '' }) {
  const today = localDateStr(now);
  const start = addDays(today, -(days - 1));
  const inRange = rows.filter(r => r.day >= start && r.day <= today);
  const views = inRange.filter(r => r.kind === 'view');
  // An old event_click to one of our own pages was a list tap: it counts
  // as event_open, like the beacon sends now.
  const clicks = inRange.filter(r => r.kind === 'click')
    .map(r => (r.click_type === 'event_click' && !isOutbound(r.click_url, siteHost) ? { ...r, click_type: 'event_open' } : r));
  const crawls = inRange.filter(r => r.kind === 'crawl');

  const window = (n) => {
    const from = addDays(today, -(n - 1));
    const v = views.filter(r => r.day >= from);
    return { visitors: uniqueVisitors(v), views: total(v) };
  };

  // One pass by day: filtering every row once per day was days x rows.
  const byDay = new Map();
  for (const r of views) {
    if (!byDay.has(r.day)) byDay.set(r.day, []);
    byDay.get(r.day).push(r);
  }
  const daily = [];
  for (let d = start; d <= today; d = addDays(d, 1)) {
    const v = byDay.get(d) || [];
    daily.push({ day: d, visitors: uniqueVisitors(v), views: total(v) });
  }

  return {
    ok: true,
    generated_at: now.toISOString(),
    days,
    // range covers the whole period picked (7, 30 or 90 days), matching the
    // chart and tables below it.
    totals: { today: window(1), week: window(7), range: window(days) },
    daily,
    top_pages: countBy(views, r => r.path, 15),
    // Visitors by the source that brought them (per visitor-day), and the
    // page views each source's visits added up to.
    sources: visitorSources(views, 12),
    source_views: countBy(views, r => r.ref_source || 'Direct', 12),
    referrer_sites: countBy(views.filter(r => r.ref_source === 'Other sites'), r => r.ref_host, 10),
    clicks: countBy(clicks, r => r.click_type, 20).map(c => ({ ...c, label: CLICK_LABELS[c.key] || c.key })),
    top_clicked: countBy(clicks.filter(r => (r.click_type === 'event_click' && isOutbound(r.click_url, siteHost)) || r.click_type === 'sponsor_click'),
      r => r.click_url, 10),
    ai: aiSummary(views, crawls),
    crawlers: countBy(crawls, r => r.bot, 12),
    crawler_pages: countBy(crawls, r => r.path, 10)
  };
}
