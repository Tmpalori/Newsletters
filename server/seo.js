import { town, dollars } from './town.js';
/* server/seo.js — Server-rendered pages for search engines and AI crawlers.
 *
 * Why this exists: the public site renders events in the browser from
 * /events.json. Google renders JS late and unreliably, and AI crawlers
 * (GPTBot, ClaudeBot, PerplexityBot) don't run JS at all, so they saw a
 * page that said "Loading events..." and nothing else. Everything here
 * turns the same published payload into plain HTML that any crawler can
 * read without executing a script:
 *
 *   - the homepage with this week's events baked into the markup
 *   - intent pages that match how people search ("this weekend",
 *     "free things to do", "live music") with an answer-first intro
 *   - one page per event, with schema.org Event JSON-LD so the event is
 *     eligible for Google's event results
 *   - /about, /sitemap.xml and /llms.txt built from the same data
 *
 * All functions are pure over (payload, now) so tests can pin dates.
 * Dates are computed in the town's timezone (town.timezone; Victoria's is
 * America/Chicago);
 * the server itself runs in UTC on Railway.
 */

const UPCOMING_DAYS = 60;
// Link-preview image: 1200x630 (the shape Facebook, X and iMessage use for
// large cards), outside robots.txt's /social/ block, and fixed content so a
// cached preview never shows an old week. The social-kit slides are
// 1080x1350 portraits that change weekly under one URL, so they don't fit.
const OG_IMAGE = '/og-image.png';

// Google tag. By default gtag sends the full URL (query string included) as
// page_location, and some links carry secrets (a subscriber's token on
// /subscribe/confirm and /unsubscribe). Send only origin + path, plus the
// campaign tags GA needs to attribute ads. docs/index.html and
// docs/submit.html carry this same snippet (tests/seo.test.js checks it).
export function gaSnippet(id = town.gaId) {
  if (!id) return '';
  return `<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());(function(){var k=new URLSearchParams();new URLSearchParams(location.search).forEach(function(v,n){if(/^(utm_[a-z]+|gclid)$/.test(n))k.append(n,v);});var q=k.toString();gtag('config','${id}',{page_location:location.origin+location.pathname+(q?'?'+q:'')});})();</script>`;
}

// Light/dark choice, saved per device and applied before first paint so
// every page (not just the homepage) keeps it. With nothing saved there's
// no data-theme and the CSS follows the system setting. Any
// [data-theme-toggle] button flips it. Also inlined in docs/index.html.
export const THEME_SCRIPT = `<script>(function(){var d=document.documentElement,K='vic361-theme';try{var t=localStorage.getItem(K);if(t==='dark'||t==='light')d.setAttribute('data-theme',t);}catch(e){}function cur(){return d.getAttribute('data-theme')||(window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');}function label(){var l='Switch to '+(cur()==='dark'?'light':'dark')+' mode';document.querySelectorAll('[data-theme-toggle]').forEach(function(b){b.setAttribute('aria-label',l);});}document.addEventListener('click',function(e){var b=e.target&&e.target.closest&&e.target.closest('[data-theme-toggle]');if(!b)return;var n=cur()==='dark'?'light':'dark';d.setAttribute('data-theme',n);try{localStorage.setItem(K,n);}catch(e2){}label();});document.addEventListener('DOMContentLoaded',label);})();</script>`;

// In the header (hidden on phones, where it doesn't fit beside Submit and
// Subscribe) and the footer.
const THEME_TOGGLE = `<button type="button" class="theme-toggle" data-theme-toggle aria-label="Switch color theme" title="Toggle dark mode">
          <svg class="theme-icon theme-icon--moon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
          <svg class="theme-icon theme-icon--sun" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
        </button>`;

// Times arrive the way each source wrote them ("04:00 PM", "5:30PM-7PM",
// "10am - 3pm"). Display them one way: no leading zero, a space before an
// upper-case AM/PM, and " – " between start and end. Display only: the
// stored ev.time feeds slugs and dedupe keys, so it never changes.
// docs/app.js has the same function.
export function formatTime(time) {
  if (typeof time !== 'string') return '';
  return time.trim()
    .replace(/(^|[^\d:])0(\d)(?=(?::\d{2})?\s*[ap]\.?\s*m\b)/gi, '$1$2')
    .replace(/(\d)\s*([ap])\.?\s*m\b\.?/gi, (m, d, ap) => `${d} ${ap.toUpperCase()}M`)
    .replace(/([\dM])\s*(?:[–—-]+|\bto\b)\s*(?=\d)/g, '$1 – ');
}

// Cartoon category icons: one <symbol> per key in docs/icons.svg.
const ICON_KEYS = new Set(['food', 'music', 'family', 'drinks', 'arts', 'shopping', 'outdoors', 'community', 'free']);
const iconSvg = k => `<svg class="ico" aria-hidden="true" focusable="false"><use href="/icons.svg#i-${k}"></use></svg>`;

// Start hour (0-23) of an event, or null when it has no clock time.
// parseTimes, not the first am/pm match: "1-4 PM" starts at 1 PM, and the
// first match ("4 PM") put an afternoon event on /tonight and /nightlife.
function startHour(ev) {
  const t = parseTimes(ev.time)[0];
  return t ? Number(t.slice(0, 2)) : null;
}
const isEvening = ev => { const h = startHour(ev); return h !== null && h >= 16; };

// Intent pages. `filter` picks events from the upcoming window; `range`
// picks the date window. Order here is the nav order. `hidden` pages answer
// specific searches ("things to do tonight", "date night") and stay out of
// the top nav to keep it short; they're still in the footer and sitemap.
export const HUB_PAGES = [
  {
    path: '/today',
    nav: 'Today',
    get title() { return `Things To Do in ${town.cityState} Today`; },
    get h1() { return `Things to do in ${town.cityState} today`; },
    get description() { return `Events happening today in ${town.cityStateLong}: live music, family activities, markets, and more.`; },
    range: 'today',
    lead: (n, label) => n
      ? `There ${n === 1 ? 'is 1 event' : `are ${n} events`} in ${town.cityState} today (${label})`
      : `Nothing is listed in ${town.cityState} for today (${label}) yet`
  },
  {
    path: '/this-weekend',
    nav: 'This Weekend',
    get title() { return `Things To Do in ${town.cityState} This Weekend`; },
    get h1() { return `Things to do in ${town.cityState} this weekend`; },
    get description() { return `Events in ${town.cityStateLong} this weekend: concerts, festivals, family events, markets, and free things to do Friday through Sunday.`; },
    range: 'weekend',
    lead: (n, label) => n
      ? `There ${n === 1 ? 'is 1 event' : `are ${n} events`} in ${town.cityState} this weekend (${label})`
      : `Nothing is listed in ${town.cityState} for this weekend (${label}) yet`
  },
  {
    path: '/free-things-to-do',
    nav: 'Free',
    get title() { return `Free Things To Do in ${town.cityState}`; },
    get h1() { return `Free things to do in ${town.cityState}`; },
    get description() { return `Upcoming free events in ${town.cityStateLong}: library programs, community events, outdoor activities, and more.`; },
    range: 'upcoming',
    filter: ev => ev.free === true || (ev.icons || []).includes('free'),
    lead: (n) => n
      ? `There ${n === 1 ? 'is 1 free event' : `are ${n} free events`} coming up in ${town.cityState}`
      : `No free events are listed in ${town.cityState} right now`
  },
  {
    path: '/kids-and-family',
    nav: 'Kids & Family',
    get title() { return `Kids & Family Events in ${town.cityState}`; },
    get h1() { return `Kids and family events in ${town.cityState}`; },
    get description() { return `Family-friendly things to do in ${town.cityStateLong}: story times, kids activities, all-ages shows, and outdoor fun.`; },
    range: 'upcoming',
    filter: ev => (ev.icons || []).includes('family'),
    lead: (n) => n
      ? `There ${n === 1 ? 'is 1 family-friendly event' : `are ${n} family-friendly events`} coming up in ${town.cityState}`
      : `No family events are listed in ${town.cityState} right now`
  },
  {
    path: '/live-music',
    nav: 'Live Music',
    get title() { return `Live Music in ${town.cityState} This Week`; },
    get h1() { return `Live music in ${town.cityState}`; },
    get description() { return `Live music in ${town.cityStateLong}: concerts, bands, open mics, and karaoke at local bars and venues.`; },
    range: 'upcoming',
    filter: ev => (ev.icons || []).includes('music'),
    lead: (n) => n
      ? `There ${n === 1 ? 'is 1 live music event' : `are ${n} live music events`} coming up in ${town.cityState}`
      : `No live music is listed in ${town.cityState} right now`
  },
  {
    path: '/food-and-drink',
    nav: 'Food & Drink',
    get title() { return `Food & Drink Events in ${town.cityState}`; },
    get h1() { return `Food and drink events in ${town.cityState}`; },
    get description() { return `Food and drink events in ${town.cityStateLong}: farmers markets, food trucks, tastings, brunches, and happy hours.`; },
    range: 'upcoming',
    filter: ev => (ev.icons || []).some(i => i === 'food' || i === 'drinks'),
    lead: (n) => n
      ? `There ${n === 1 ? 'is 1 food and drink event' : `are ${n} food and drink events`} coming up in ${town.cityState}`
      : `No food and drink events are listed in ${town.cityState} right now`
  },
  {
    path: '/tonight',
    nav: 'Tonight',
    hidden: true,
    get title() { return `Things To Do in ${town.cityState} Tonight`; },
    get h1() { return `Things to do in ${town.cityState} tonight`; },
    get description() { return `What's happening tonight in ${town.cityStateLong}: live music, trivia, karaoke, shows, and late events starting this evening.`; },
    range: 'today',
    filter: isEvening,
    lead: (n, label) => n
      ? `There ${n === 1 ? 'is 1 event' : `are ${n} events`} tonight in ${town.cityState} (${label})`
      : `Nothing is listed for tonight in ${town.cityState} (${label}) yet`
  },
  {
    path: '/date-night',
    nav: 'Date Night',
    hidden: true,
    get title() { return `Date Night Ideas in ${town.cityState}`; },
    get h1() { return `Date night ideas in ${town.cityState}`; },
    get description() { return `Date night in ${town.cityStateLong}: live music, theatre, art nights, wine and beer, and dinner events this week.`; },
    range: 'upcoming',
    filter: ev => isEvening(ev) && (ev.icons || []).some(i => ['music', 'arts', 'drinks', 'food'].includes(i)) &&
      !(ev.icons || []).includes('family'),
    lead: (n) => n
      ? `There ${n === 1 ? 'is 1 date-night pick' : `are ${n} date-night picks`} coming up in ${town.cityState}`
      : `No date-night events are listed in ${town.cityState} right now`
  },
  {
    path: '/next-week',
    nav: 'Next Week',
    hidden: true,
    get title() { return `Things To Do in ${town.cityState} Next Week`; },
    get h1() { return `Things to do in ${town.cityState} next week`; },
    get description() { return `Events in ${town.cityStateLong} next week, Monday through Sunday: live music, festivals, family events, markets, and more.`; },
    range: 'next-week',
    weekLink: { href: '/', label: '← This week' },
    lead: (n, label) => n
      ? `There ${n === 1 ? 'is 1 event' : `are ${n} events`} in ${town.cityState} next week (${label})`
      : `Nothing is listed in ${town.cityState} for next week (${label}) yet. New events are added every Sunday and Wednesday`
  },
  {
    path: '/this-weekend-with-kids',
    nav: 'Weekend with Kids',
    hidden: true,
    get title() { return `Things To Do With Kids in ${town.cityState} This Weekend`; },
    get h1() { return `Things to do with kids in ${town.cityState} this weekend`; },
    get description() { return `Kid-friendly events in ${town.cityStateLong} this weekend: story times, festivals, the zoo, crafts, and family fun.`; },
    range: 'weekend',
    filter: ev => (ev.icons || []).includes('family'),
    lead: (n, label) => n
      ? `There ${n === 1 ? 'is 1 kid-friendly event' : `are ${n} kid-friendly events`} in ${town.cityState} this weekend (${label})`
      : `No kid-friendly events are listed for this weekend (${label}) yet`
  },
  {
    path: '/free-this-weekend',
    nav: 'Free This Weekend',
    hidden: true,
    get title() { return `Free Things To Do in ${town.cityState} This Weekend`; },
    get h1() { return `Free things to do in ${town.cityState} this weekend`; },
    get description() { return `Free events in ${town.cityStateLong} this weekend: markets, library programs, festivals, outdoor fun, and community events.`; },
    range: 'weekend',
    filter: ev => ev.free === true || (ev.icons || []).includes('free'),
    lead: (n, label) => n
      ? `There ${n === 1 ? 'is 1 free event' : `are ${n} free events`} in ${town.cityState} this weekend (${label})`
      : `No free events are listed for this weekend (${label}) yet`
  },
  {
    path: '/nightlife',
    nav: 'Nightlife',
    hidden: true,
    get title() { return `Nightlife in ${town.cityState}: Bars, Live Music & Karaoke`; },
    get h1() { return `Nightlife in ${town.cityState}`; },
    get description() { return `Nightlife in ${town.cityStateLong} this week: bar shows, live bands, karaoke, trivia, and late events.`; },
    range: 'upcoming',
    filter: ev => isEvening(ev) && (ev.icons || []).some(i => ['music', 'drinks'].includes(i)) &&
      !(ev.icons || []).includes('family'),
    lead: (n) => n
      ? `There ${n === 1 ? 'is 1 nightlife event' : `are ${n} nightlife events`} coming up in ${town.cityState}`
      : `No nightlife events are listed in ${town.cityState} right now`
  },
  {
    path: '/arts-and-culture',
    nav: 'Arts & Culture',
    hidden: true,
    get title() { return `Arts & Culture Events in ${town.cityState}`; },
    get h1() { return `Arts and culture events in ${town.cityState}`; },
    get description() { return `Art, theatre, museums, and culture in ${town.cityStateLong}: gallery nights, plays, concerts, and exhibits coming up.`; },
    range: 'upcoming',
    filter: ev => (ev.icons || []).includes('arts'),
    lead: (n) => n
      ? `There ${n === 1 ? 'is 1 arts event' : `are ${n} arts and culture events`} coming up in ${town.cityState}`
      : `No arts events are listed in ${town.cityState} right now`
  },
  {
    path: '/outdoor-events',
    nav: 'Outdoors',
    hidden: true,
    get title() { return `Outdoor Events in ${town.cityState}`; },
    get h1() { return `Outdoor events in ${town.cityState}`; },
    get description() { return `Outdoor things to do in ${town.cityStateLong}: parks, runs, markets, festivals, and events at Riverside Park and around town.`; },
    range: 'upcoming',
    filter: ev => (ev.icons || []).includes('outdoors'),
    lead: (n) => n
      ? `There ${n === 1 ? 'is 1 outdoor event' : `are ${n} outdoor events`} coming up in ${town.cityState}`
      : `No outdoor events are listed in ${town.cityState} right now`
  }
];

// ─── Escaping ────────────────────────────────────────────────────────────

export function escHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Event URLs come from scrapers and public submissions; only http(s) is
// ever rendered as a link so a `javascript:` URL can't ride along.
export function safeUrl(url) {
  if (typeof url !== 'string') return '';
  const u = url.trim();
  // No whitespace, quotes or angle brackets: a URL that needs them is
  // either broken or trying to break out of an attribute.
  return /^https?:\/\/[^\s"'<>`]+$/i.test(u) ? u : '';
}

// JSON-LD lives inside a <script> tag, so "</script>" in an event name
// would end it early. Escaping "<" keeps the JSON valid and inert.
function jsonLd(obj) {
  return '<script type="application/ld+json">' +
    JSON.stringify(obj).replace(/</g, '\\u003c') +
    '</script>';
}

// ─── Dates (the town's timezone) ─────────────────────────────────────────────

// YYYY-MM-DD for `now` as seen in the town.
export function localDateStr(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: town.timezone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
  return parts; // en-CA formats as YYYY-MM-DD
}

function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)); // noon UTC dodges DST edges
}

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

export function addDays(s, n) {
  const d = parseYmd(s);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}

function weekday(s) {
  return parseYmd(s).getUTCDay(); // 0 = Sunday
}

export function formatDay(s, opts) {
  return parseYmd(s).toLocaleDateString('en-US', Object.assign({ timeZone: 'UTC' }, opts));
}

function formatRange(start, end) {
  const a = formatDay(start, { month: 'short', day: 'numeric' });
  if (start === end) return formatDay(start, { weekday: 'long', month: 'long', day: 'numeric' });
  const b = formatDay(end, { month: 'short', day: 'numeric' });
  return `${a} to ${b}`;
}

// Monday–Sunday of the current week, matching what docs/app.js renders.
// PR previews: the bundled sample list is months old, so a preview's
// homepage showed "No events" every day. This moves the whole list by
// whole weeks so its first week is this week (weekdays and times kept).
export function shiftToWeek(events, today) {
  const list = Array.isArray(events) ? events : [];
  const dates = list.map(ev => ev && ev.date).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d || '')).sort();
  if (!dates.length) return list;
  const days = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5);
  const shift = days(currentWeek(dates[0])[0], currentWeek(today)[0]);
  if (!shift) return list;
  return list.map(ev => ev && ev.date ? { ...ev, date: addDays(ev.date, shift) } : ev);
}

export function currentWeek(today) {
  const dow = weekday(today);
  const monday = addDays(today, dow === 0 ? -6 : 1 - dow);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

export function dateRange(kind, today) {
  if (kind === 'today') return [today, today];
  if (kind === 'next-week') {
    const monday = addDays(currentWeek(today)[0], 7);
    return [monday, addDays(monday, 6)];
  }
  if (kind === 'weekend') {
    // Mon–Thu: the coming Fri–Sun. Fri–Sun: from today through Sunday.
    const dow = weekday(today);
    if (dow === 0) return [today, today];
    if (dow >= 5) return [today, addDays(today, 7 - dow)];
    return [addDays(today, 5 - dow), addDays(today, 7 - dow)];
  }
  // Everything published from today on. The payload is curated and
  // usually covers ~2 weeks, but a festival added early should still show.
  return [today, addDays(today, UPCOMING_DAYS)];
}

// The town's UTC offset for a given date ("-05:00" / "-06:00" in Victoria),
// so JSON-LD startDate carries an explicit offset as Google recommends.
// shortOffset reads "GMT-5", "GMT+5:30", or plain "GMT" for UTC itself.
export function utcOffset(dateStr) {
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: town.timezone, timeZoneName: 'shortOffset'
  }).formatToParts(parseYmd(dateStr)).find(p => p.type === 'timeZoneName');
  const m = name && name.value.match(/GMT([+-])(\d+)(?::(\d+))?/);
  if (!m) return '+00:00';
  return m[1] + m[2].padStart(2, '0') + ':' + (m[3] || '00').padStart(2, '0');
}

// Pull "7:00 PM" / "10am" style times out of free-form strings like
// "10:00AM – 11:00AM" or "10am - 3pm". Returns ["HH:MM", ...] (24h).
// A range that shares one am/pm ("7-9 PM", "7:30 – 9:30pm") starts with a
// bare time; it takes the end's meridiem ("11-1 PM" flips to 11 AM, since a
// start can't be after its end). Without this the end time was read as the
// start (JSON-LD startDate, .ics, sorting, /tonight). docs/app.js sorts
// the homepage the same way (toMins).
const SHARED_RANGE = /(^|[^\d:])(\d{1,2})(?::(\d{2}))?\s*(?:-|–|—|to)\s*(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b/i;

export function parseTimes(time) {
  if (!time) return [];
  const out = [];
  const re = /(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?/gi;
  let m;
  while ((m = re.exec(time)) && out.length < 2) {
    // "7:75 PM" or "13pm" isn't a time; building a Date from it throws.
    if (Number(m[1]) > 12 || Number(m[2] || 0) > 59) continue;
    let h = Number(m[1]) % 12;
    if (m[3].toLowerCase() === 'p') h += 12;
    out.push(String(h).padStart(2, '0') + ':' + (m[2] || '00'));
  }
  const r = SHARED_RANGE.exec(String(time));
  // Only when the range is the first time in the string ("Doors 6 PM, show
  // 7-9 PM" starts at 6) and its end is the first time parsed above.
  const first = /(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m/i.exec(String(time));
  if (r && out.length && first && first.index > r.index + r[1].length &&
      Number(r[2]) <= 12 && Number(r[3] || 0) <= 59) {
    const [eh, em] = out[0].split(':').map(Number);
    let h = (Number(r[2]) % 12) + (eh >= 12 ? 12 : 0);
    const mins = r[3] || '00';
    if (h * 60 + Number(mins) > eh * 60 + em) h = (h + 12) % 24;
    return [String(h).padStart(2, '0') + ':' + mins, out[0]];
  }
  return out;
}

// Sort key in minutes; untimed events sort last, like the client.
function timeKey(ev) {
  const t = parseTimes(ev.time)[0];
  if (!t) return 9999;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

// ─── Events ──────────────────────────────────────────────────────────────

export function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

// Attach a stable `page` path to each event: /events/<date>-<name-slug>.
// Same date + name twice gets -2, -3 so links stay unique, numbered by
// start time, then venue, then name (not payload order: Save & Publish and
// auto-publish order ties differently, which swapped the pair's URLs).
// Some sources hand us text that's already HTML-encoded ("Texas A&amp;M");
// decode it once so escaping on render doesn't show "&amp;" on the page.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(str) {
  if (typeof str !== 'string' || !str.includes('&')) return str;
  return str.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

// Where an event is. Most are in the site's town (town.city: Victoria); a
// few big nearby-town events (Cuero Turkeyfest, Port Lavaca's Boo-Fest)
// carry `town` from local_events.yaml so pages, calendar files and schema
// say the right town.
export function townOf(ev) {
  return String((ev && ev.town) || '').trim() || town.city;
}

// "Nearby · Cuero" tag on list items for events outside Victoria. docs/app.js
// renders the same.
function nearbyBadge(ev) {
  return ev.town ? `<span class="badge badge--nearby">Nearby · ${escHtml(townOf(ev))}</span> ` : '';
}

// Venue line under an event name: "Venue · street address", without
// repeating the address when the venue field already is one.
export function placeText(ev, sep = ' · ') {
  let venue = (ev.venue || '').trim();
  const addr = (ev.address || '').trim();
  if (/^\d/.test(venue)) venue = venue.split(',')[0].trim();
  if (!venue) return addr;
  const v = venue.toLowerCase(), a = addr.toLowerCase();
  if (!addr || v.includes(a) || a.includes(v)) return venue;
  return `${venue}${sep}${addr}`;
}

// The same place as prose ("Venue, 1 Main St"): the event page, its .ics
// LOCATION and the Google Calendar link. A plain venue+address join read
// "at Victoria, Victoria" or "3102 Miori Ln., 3102 Miori Ln" when the
// collector put the same place in both fields.
export const whereText = ev => placeText(ev, ', ');

// Search and category pages ("music in Victoria") aren't a link to the event.
const LISTING_URL = [
  /eventbrite\.[a-z.]+\/(b|d)\//i,
  /allevents\.in\/[^/]+\/?(all|this-weekend|today|tomorrow|[a-z-]+-events)?\/?(\?|#|$)/i,
  /facebook\.com\/events\/?(explore|search|discover)?\/?(\?|#|$)/i,
  // The city calendar's home or a made-up "detail" view (one event is
  // Calendar.aspx?EID=<n>); a Perfect Game search. Same as collect_events.py.
  /victoriatx\.gov\/calendar(\.aspx)?\/?(?![^#]*\bEID=\d)(\?|#|$)/i,
  /perfectgame\.org\/events\/default\.aspx/i
];
export function isListingUrl(url) {
  return typeof url === 'string' && LISTING_URL.some(re => re.test(url.trim()));
}

// Event-specific URLs carry the event's name in a slug
// (facebook.com/events/<slug>/<id>, allevents.in/<city>/<slug>/<id>,
// eventbrite.com/e/<slug>-tickets-<id>). If that slug shares no word with the
// event's name, the link belongs to some other event.
const SLUG_HOSTS = /(^|\.)(facebook\.com|allevents\.in|eventbrite\.[a-z.]+|victoriachamber\.org)$/i;
const STOP = new Set('the and at in of for with on to tx victoria texas united states event events tickets night live free'.split(' '));
function words(text) {
  return new Set(String(text || '').toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // "Música" -> "musica", like the slug
    .replace(/['’.]/g, '').split(/[^a-z0-9]+/)
    .filter(w => w.length >= 3 && !/^\d+$/.test(w) && !STOP.has(w))
    .map(w => w.slice(0, 5)));
}
export function isMismatchedUrl(url, name) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (!SLUG_HOSTS.test(u.hostname)) return false;
  // A Facebook post can be a roundup of several events; only event links count.
  if (/facebook\.com$/i.test(u.hostname) && !u.pathname.startsWith('/events/')) return false;
  const slug = u.pathname.split('/').filter(seg => /[a-z]/i.test(seg) && seg.includes('-')).pop();
  if (!slug) return false;
  const a = words(slug), b = words(name);
  if (!a.size || !b.size) return false;
  for (const w of a) if (b.has(w)) return false;
  return true;
}

// What the event page's button should say for a link.
export function linkLabel(url) {
  let u;
  try { u = new URL(url); } catch { return 'Event details'; }
  const host = u.hostname.replace(/^www\./, '');
  const segs = u.pathname.split('/').filter(Boolean);
  if (/instagram\.com$/.test(host)) return segs[0] === 'p' || segs[0] === 'reel' ? 'See the post' : 'Venue page';
  if (/facebook\.com$/.test(host)) {
    if (segs[0] === 'events' && segs.length > 1) return 'Event details';
    return segs.includes('posts') ? 'See the post' : 'Venue page';
  }
  const last = (segs[segs.length - 1] || '').toLowerCase();
  if (!segs.length || (segs.length === 1 && /^(events?|calendar|index\.php)$/.test(last)) || /search/.test(u.search)) return 'Venue website';
  return 'Event details';
}

// Links found dead or wrong in the Oct 2026 audit, fixed on events that are
// already published. The collector's venue table carries the same fixes.
const FIXED_URLS = {
  'https://www.victoriatx.gov/government/departments/parks-recreation': 'https://www.victoriatx.gov/1330/Parks-Recreation',
  'https://www.navemuseum.com': 'https://navemuseum.org',
  'https://www.victoriafineartscentre.org': 'https://victoriafinearts.org',
  'https://www.weaverhouseconcerts.com': ''
};

const tieKey = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// The suffix an event's earlier page used (`_page`, from the archive: see
// reservePages in server/index.js), when it still fits its base: 1 for the
// base page, N for `-N`. A rename or a new date changes the base, so the
// old page doesn't fit and settleArchive 301s it instead.
function reservedNumber(page, base) {
  if (typeof page !== 'string' || !page.startsWith(`/events/${base}`)) return 0;
  const rest = page.slice(`/events/${base}`.length);
  if (!rest) return 1;
  const m = /^-(\d+)$/.exec(rest);
  return m && Number(m[1]) >= 2 ? Number(m[1]) : 0;
}

function pageNumbers(list) {
  const bases = list.map(ev => `${ev.date}-${slugify(ev.name) || 'event'}`);
  const groups = new Map();
  bases.forEach((b, i) => groups.set(b, [...(groups.get(b) || []), i]));
  const n = new Array(list.length).fill(0);
  for (const idx of groups.values()) {
    if (idx.length < 2) { n[idx[0]] = 1; continue; }
    const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    idx.sort((i, j) => (timeKey(list[i]) - timeKey(list[j])) ||
      cmp(tieKey(list[i].venue), tieKey(list[j].venue)) ||
      cmp(tieKey(list[i].name), tieKey(list[j].name)) ||
      cmp(String(list[i].time || ''), String(list[j].time || '')) || (i - j));
    // A page already handed out stays with its event: links in the
    // newsletter and on social media point there. Without this a later
    // same-name event that sorts first took the base URL and the first
    // event moved to -2 with nothing pointing the old link at it. The
    // rest get the first free number, in rank order.
    const taken = new Set();
    for (const i of idx) {
      const r = reservedNumber(list[i]._page, bases[i]);
      if (r && !taken.has(r)) { n[i] = r; taken.add(r); }
    }
    let next = 1;
    for (const i of idx) {
      if (n[i]) continue;
      while (taken.has(next)) next++;
      n[i] = next;
      taken.add(next);
    }
  }
  return { bases, n };
}

export function withPages(events) {
  const list = (Array.isArray(events) ? events : []).filter(ev => ev && ev.date && ev.name);
  const { bases, n: nums } = pageNumbers(list);
  return list
    .map((ev, i) => {
      // Slug from the stored name so existing event URLs don't move.
      const base = bases[i];
      const n = nums[i];
      const clean = {};
      for (const k of ['name', 'venue', 'address', 'description', 'time']) {
        if (typeof ev[k] === 'string') clean[k] = decodeEntities(ev[k]);
      }
      // The submit form and the admin edit modal store the end separately
      // (end_time); shown nowhere, the page said "7 PM" and Add to calendar
      // invented a 9 PM end. Joined into the displayed time it reaches the
      // page, lists, JSON-LD endDate and .ics/Google Calendar alike. Display
      // only: slugs and keys don't use the time, and sorting reads the start.
      // A time that already is a range keeps its own end. docs/app.js
      // timeText() does the same for the bundled list.
      const end = typeof ev.end_time === 'string' ? decodeEntities(ev.end_time).trim() : '';
      if (end && clean.time && parseTimes(clean.time).length === 1 && parseTimes(end).length === 1) {
        clean.time = `${clean.time.trim()} – ${end}`;
      }
      const fixed = typeof ev.url === 'string' ? FIXED_URLS[ev.url.trim().replace(/\/$/, '')] : undefined;
      if (fixed !== undefined) clean.url = fixed;
      if (isListingUrl(ev.url) || isMismatchedUrl(ev.url, ev.name)) clean.url = '';
      const { _page: _reserved, ...rest } = ev;
      return Object.assign(rest, clean, { page: `/events/${n === 1 ? base : `${base}-${n}`}` });
    });
}

// Paid Vic's Picks rank before editor's picks (server/scoring.js pickDays),
// then everything else: used where picks are chosen or break a tie.
export function pickRank(ev) {
  return ev && ev.featured ? (ev.editor_pick ? 1 : 0) : 2;
}

// By date, then by time, like the newsletter: a Vic's Pick stands out by
// its badge and card, not by jumping the day's order. Same time: picks first.
export function sortEvents(list) {
  return list.slice().sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (timeKey(a) !== timeKey(b)) return timeKey(a) - timeKey(b);
    return pickRank(a) - pickRank(b);
  });
}

export function eventsBetween(events, start, end, filter) {
  return sortEvents(events.filter(ev =>
    ev.date >= start && ev.date <= end && (!filter || filter(ev))));
}

export function eventJsonLd(ev, siteUrl) {
  const times = parseTimes(ev.time);
  const offset = utcOffset(ev.date);
  const startDate = times[0] ? `${ev.date}T${times[0]}:00${offset}` : ev.date;
  // "9:30 PM – 2:00 AM" ends the next day; same-day would put endDate
  // before startDate, which Google rejects (guides.js eventInstants agrees).
  const endDay = times[1] && times[1] <= times[0] ? addDays(ev.date, 1) : ev.date;
  const obj = {
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: ev.name,
    startDate,
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    location: {
      '@type': 'Place',
      name: ev.venue || `${townOf(ev)}, ${town.state}`,
      address: {
        '@type': 'PostalAddress',
        ...(ev.address ? { streetAddress: ev.address } : {}),
        addressLocality: townOf(ev),
        addressRegion: town.state,
        addressCountry: 'US'
      }
    },
    image: [`${siteUrl}/og-image.png`],
    url: `${siteUrl}${ev.page}`
  };
  // Google flags a missing endDate. With no end time listed, the event ends
  // when it starts rather than at a made-up hour.
  obj.endDate = times[1] ? `${endDay}T${times[1]}:00${utcOffset(endDay)}` : startDate;
  if (ev.description) obj.description = ev.description;
  // We don't track organizers or performers; the venue is who hosts it.
  // Without a venue there's nothing honest to name, so it stays off. No
  // performer: the venue isn't the band playing there, and we don't know
  // who is.
  if (ev.venue) {
    const host = { '@type': 'Organization', name: ev.venue };
    if (safeUrl(ev.url)) host.url = safeUrl(ev.url);
    obj.organizer = host;
  }
  // Every event gets an offer pointing at its details link. Price only when
  // we know it (free); validFrom is the listing date, never after the event,
  // so Google doesn't read it as tickets not yet on sale. No availability:
  // we can't know whether a show is sold out, so "InStock" was a claim
  // the data couldn't back.
  const today = localDateStr(new Date());
  const validDay = today < ev.date ? today : ev.date;
  obj.offers = {
    '@type': 'Offer',
    ...(ev.free === true ? { price: 0 } : {}),
    priceCurrency: 'USD',
    validFrom: `${validDay}T00:00:00${utcOffset(validDay)}`,
    url: safeUrl(ev.url) || `${siteUrl}${ev.page}`
  };
  if (ev.free === true) obj.isAccessibleForFree = true;
  return obj;
}

// ─── HTML pieces ─────────────────────────────────────────────────────────

// The icon keys an event shows: `free: true` shows the Free icon even when
// the collector didn't tag it, the same as the filter (data-icons) and the
// newsletter. docs/app.js iconKeys matches.
export function iconKeys(ev) {
  const keys = (ev.icons || []).filter(k => ICON_KEYS.has(k));
  return ev.free === true && !keys.includes('free') ? [...keys, 'free'] : keys;
}

// What the icons mean, in words, for screen readers (the filter chips'
// names: docs/app.js FILTERS). docs/app.js iconLabel matches.
export const ICON_LABELS = {
  food: 'Food', music: 'Music', family: 'Kids & Family', drinks: 'Drinks', arts: 'Arts',
  shopping: 'Shopping', outdoors: 'Outdoors', community: 'Community', free: 'Free'
};

// The icon column: the same pictures as before, now read out as one image
// ("Music, Free") instead of being hidden; an event with no icons keeps an
// empty, hidden column.
export function iconsHtml(ev) {
  const keys = iconKeys(ev);
  if (!keys.length) return '<span class="event-icons" aria-hidden="true"></span>';
  const label = keys.map(k => ICON_LABELS[k]).join(', ');
  return `<span class="event-icons" role="img" aria-label="${escHtml(label)}">${keys.map(iconSvg).join('')}</span>`;
}

// Mirrors renderEvent() in docs/app.js so the server markup and the
// client re-render look identical. The name links to our event page (the
// crawlable, internal link); the venue keeps the external source link.
// Share button on each list item (a pink curvy forward arrow, sticker style
// like docs/icons.svg), so an event can go out from the list
// without opening its page first. docs/track.js handles the tap (share
// sheet, or copy the link); docs/app.js renders the same button.
const SHARE_ICON = '<svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true" focusable="false"><path d="M17.5 4.5l10 8.6c.6.5.6 1.3 0 1.8l-10 8.6c-.7.6-1.7.1-1.7-.8v-4.4C10 18.4 6.6 21 4.3 26.2c-.3.7-1.3.5-1.3-.3C3.4 16.8 8.6 11 15.8 10.6V5.3c0-.9 1-1.4 1.7-.8z" fill="#FF8FC0" stroke="#1F1A3D" stroke-width="2.4" stroke-linejoin="round"/></svg>';
function shareButton(ev) {
  if (!ev.page) return '';
  return `<button type="button" class="event-share" data-share-url="${escHtml(ev.page)}" data-share-text="${escHtml(ev.name)}" aria-label="Share ${escHtml(ev.name)}" title="Share">${SHARE_ICON}</button>`;
}

// data-ad marks a paid placement (the weekly sponsor block, a paid Vic's
// Pick) with its order id: docs/track.js counts it as seen and tags clicks
// in it, for the sponsor's report. Editor's picks are unpaid, so untagged.
// docs/app.js adAttr renders the same.
const AD_ID = /^[A-Za-z0-9-]{8,64}$/;
export function adAttr(id) {
  return AD_ID.test(id || '') ? ` data-ad="${escHtml(id)}"` : '';
}

// A paid pick (featured, not an editor's pick: a Vic's Pick order, a venue
// partner's event, or one the admin marked paid) ends its description with
// a small "#ad" (the owner's choice of label; the legal pages say the same).
// docs/app.js renderEvent and the newsletter's eventRow render the same.
export const isPaidPick = ev => Boolean(ev && ev.featured && !ev.editor_pick);
export const AD_LABEL = '#ad';
export const adTag = ev => (isPaidPick(ev) ? ` <span class="event-ad">${AD_LABEL}</span>` : '');
export function pickBadges(ev) {
  if (!ev.featured) return '';
  return `<span class="badge badge--featured">${town.pickName}</span> `;
}

export function renderEventItem(ev) {
  const place = placeText(ev);
  const ad = ev.featured && !ev.editor_pick ? adAttr(ev.sponsor_order) : '';
  return `<li class="event-entry${ev.featured ? ' event-entry--featured' : ''}"${ad} data-icons="${escHtml((ev.icons || []).join(' ') + (ev.free === true ? ' free' : ''))}">` +
    iconsHtml(ev) +
    '<div class="event-details">' +
      pickBadges(ev) +
      nearbyBadge(ev) +
      (ev.time ? `<span class="event-time">${escHtml(formatTime(ev.time))}</span> ` : '') +
      `<span class="event-name"><a href="${escHtml(ev.page)}">${escHtml(ev.name)}</a></span>` +
      (place ? `<span class="event-venue">${escHtml(place)}</span>` : '') +
      (ev.description || isPaidPick(ev) ? `<div class="event-desc">${escHtml(ev.description || '')}${adTag(ev)}</div>` : '') +
    '</div>' +
    shareButton(ev) +
  '</li>';
}

// fold: the homepage's days are each a <details> folded to their header
// bar, with only today open (fold === 'open'), so the page opens on today
// and any day is one tap away; today folds up too. Past days keep the
// --past look. Still in the markup for crawlers, and still one
// .day-section per day so the weekend filter's Mon=0…Sun=6 indexing and
// the day colors hold. docs/app.js renders the same.
function dayCount(n) {
  return n === 0 ? 'No events' : n === 1 ? '1 event' : `${n} events`;
}

// "day--d0" (Monday) … "day--d6" (Sunday): a day's color follows its
// weekday, like the newsletter's DAY_COLORS, whatever else sits in the list
// (the newsletter card, hub pages that skip empty days). docs/app.js same.
export function dayClass(dateStr) {
  const dow = new Date(dateStr + 'T12:00:00Z').getUTCDay();
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr || '') && !isNaN(dow) ? ` day--d${(dow + 6) % 7}` : '';
}

// A line under each day still ahead that has paid Pick spots left, so a
// venue reading its own day sees it can stand out there. Counts the paid
// picks already live; checkout still checks the real cap (holds included),
// so a day that just sold out can't be oversold from here. Not today: a
// pick bought the same evening buys almost nothing. "Give it the <name>
// badge" reads right for every town's pick name ("Featured" too). docs/app.js keeps the
// server's line when it redraws the week.
export function pickPromptHtml(dateStr, list, today) {
  if (!(dateStr > today)) return '';
  const dow = new Date(dateStr + 'T12:00:00Z').getUTCDay();
  const kind = dow === 5 || dow === 6 || dow === 0 ? 'weekend' : 'weekday';
  if (list.filter(isPaidPick).length >= town.business.pickCap[kind]) return '';
  return `<p class="pick-prompt" data-date="${dateStr}">Have an event ${formatDay(dateStr, { weekday: 'long' })}? ` +
    `<a href="/advertise/checkout?package=featured&amp;date=${dateStr}">Give it the ${town.pickName} badge</a>.</p>`;
}

function renderDay(dateStr, list, idx, today, fold = null, prompt = '') {
  const badge = dateStr === today ? ' <span class="today-badge">Today</span>' : '';
  const body = (list.length
    ? `<ul class="event-list" role="list">${list.map(renderEventItem).join('')}</ul>`
    : '<div class="empty-state">Nothing listed yet — know something happening? <a href="/submit">Submit an event.</a></div>') + prompt;
  const head = `<h2 class="day-name">${formatDay(dateStr, { weekday: 'long' })}${badge}</h2>` +
    `<span class="day-date">${formatDay(dateStr, { month: 'long', day: 'numeric' })}</span>`;
  if (fold) {
    const past = dateStr < today ? ' day-section--past' : '';
    // Phones show "Oct 7" so the day, date and count fit on one row.
    const foldHead = `<h2 class="day-name">${formatDay(dateStr, { weekday: 'long' })}${badge}</h2>` +
      `<span class="day-date"><span class="dd-long">${formatDay(dateStr, { month: 'long', day: 'numeric' })}</span>` +
      `<span class="dd-short" aria-hidden="true">${formatDay(dateStr, { month: 'short', day: 'numeric' })}</span></span>`;
    return `<section class="day-section day-section--fold${past}${dayClass(dateStr)}" id="day-${idx}"><details${fold === 'open' ? ' open' : ''}>` +
      `<summary class="day-header">${foldHead}<span class="day-count">${dayCount(list.length)}</span></summary>` +
      body + '</details></section>';
  }
  return `<section class="day-section${dayClass(dateStr)}" id="day-${idx}">` +
    '<div class="day-header">' + head + '</div>' + body +
  '</section>';
}

// The day a folded week opens on: today, or (a week that doesn't hold
// today) its first day still ahead.
export function openDay(dates, today) {
  return dates.includes(today) ? today : dates.find(d => d >= today) || null;
}

// Day sections for an arbitrary list of dates (homepage = Mon–Sun), every
// day folded but the one openDay picks (see renderDay).
export function renderDays(dates, events, today) {
  const open = openDay(dates, today);
  return dates.map((d, i) => {
    const list = sortEvents(events.filter(ev => ev.date === d));
    return renderDay(d, list, i, today, d === open ? 'open' : 'closed', pickPromptHtml(d, list, today));
  }).join('');
}

// Day sections only for dates that have events (intent pages).
export function renderGrouped(list, today) {
  const dates = [...new Set(list.map(ev => ev.date))];
  return dates.map((d, i) => renderDay(d, list.filter(ev => ev.date === d), i, today)).join('');
}

// In-season guides are request-specific, so pages carry a placeholder the
// server fills per response (fillSeasonalNav) instead of sharing state
// between concurrent requests.
export const SEASONAL_NAV_SLOT = '<!--SEASONAL_NAV-->';

// The newsletter's reach under every page's signup: subscribers and the
// past week's readers, each only once it's a crowd (a small number reads as
// empty) and rounded down, so it never claims more than is true. The site
// keeps the latest count here (server/index.js setReach, refreshed every
// 10 minutes); every page's footer reads it, and the homepage template's
// slot is filled by fillReach. No count, no line.
export const REACH_SLOT = '<!--REACH-->';
let reachCounts = null;
export function setReach(counts) { reachCounts = counts || null; }
export function getReach() { return reachCounts; }

// Above the checkout's pay button: who the ad reaches. Only the numbers
// past their thresholds; none, no line.
export function reachPitchHtml(counts = reachCounts) {
  const { subscribers, readers } = reachNumbers(counts || {});
  const parts = [
    readers ? `${readers.toLocaleString('en-US')} readers on the site this past week` : null,
    subscribers ? `${subscribers.toLocaleString('en-US')}+ newsletter subscribers` : null
  ].filter(Boolean);
  return parts.length ? `<p class="co-reach">Your ad reaches ${parts.join(' and ')}.</p>` : '';
}
const roundDown = n => (n >= 1000 ? Math.floor(n / 100) * 100 : Math.floor(n / 10) * 10);
export function reachNumbers({ subscribers = 0, readers = 0 } = {}) {
  return {
    subscribers: subscribers >= town.business.showSubscribersFrom ? roundDown(subscribers) : null,
    readers: readers >= town.business.showReadersFrom ? roundDown(readers) : null
  };
}
export function reachHtml(counts) {
  const { subscribers, readers } = reachNumbers(counts || {});
  const parts = [
    subscribers ? `Join ${subscribers.toLocaleString('en-US')}+ ${escHtml(town.city)} locals` : null,
    readers ? `${readers.toLocaleString('en-US')} readers this week` : null
  ].filter(Boolean);
  return parts.length ? `<p class="site-reach">${parts.join(' · ')}</p>` : '';
}
export function fillReach(html, counts = reachCounts) {
  const line = reachHtml(counts);
  // No line: the slot goes with its indent, leaving the page as it was.
  return line ? html.split(REACH_SLOT).join(line) : html.replace(/\n[ \t]*<!--REACH-->/g, '').split(REACH_SLOT).join('');
}

export function seasonalNavLinks(seasons, current) {
  return (seasons || []).map(p =>
    `<a href="${p.path}"${p.path === current ? ' aria-current="page"' : ''}>${escHtml(p.nav)}</a>`).join('');
}

export function fillSeasonalNav(html, seasons, current) {
  return html.split(SEASONAL_NAV_SLOT).join(seasonalNavLinks(seasons, current));
}

export function navHtml(current) {
  const links = HUB_PAGES.filter(p => !p.hidden).map(p =>
    `<a href="${p.path}"${p.path === current ? ' aria-current="page"' : ''}>${escHtml(p.nav)}</a>`);
  // Last, after the reader's links: where a business finds the sponsor and
  // Pick offers without hunting through the footer.
  const biz = `<a class="browse-biz" href="/advertise"${current === '/advertise' ? ' aria-current="page"' : ''}>Feature your business</a>`;
  return `<nav class="browse-nav" aria-label="Browse events"><div class="container browse-inner">${SEASONAL_NAV_SLOT}${links.join('')}${biz}</div></nav>`;
}

function headerHtml() {
  return `<header class="site-header" id="site-header">
    <div class="container header-inner">
      <a class="logo-group" href="/">
        <img src="/logo.png" width="48" height="48" alt="${town.siteName} logo" class="site-logo site-logo--light" />
        <img src="/logo-dark.png" width="48" height="48" alt="" aria-hidden="true" class="site-logo site-logo--dark" />
        <div>
          <div class="site-title">${town.siteNameHtml}</div>
          <div class="tagline">Events &amp; Things To Do in <span class="tagline-accent">${town.cityState}</span></div>
        </div>
      </a>
      <div class="header-actions">
        <a href="/submit" class="btn btn--outline desktop-submit">Submit an Event</a>
        <a href="/submit" class="btn btn--outline mobile-submit" aria-label="Submit an event">+ Event</a>
        ${THEME_TOGGLE}
        <a href="/subscribe" class="btn btn--primary">Subscribe</a>
      </div>
    </div>
  </header>`;
}

function footerHtml() {
  // Victoria's year: the UTC year turned over at 6 PM on Dec 31.
  const year = localDateStr(new Date()).slice(0, 4);
  return `<footer class="site-footer">
    <div class="container">
      <div class="footer-grid footer-grid--4">
        <div class="footer-section">
          <h2>Stay in the loop</h2>
          <p>Get ${town.city}'s best events in your inbox every Monday and Thursday.</p>${reachHtml(reachCounts) && `\n          ${reachHtml(reachCounts)}`}
          <a href="/subscribe" class="btn btn--primary">Subscribe free</a>
        </div>
        <div class="footer-section">
          <h2>Browse</h2>
          <ul class="footer-links" role="list">
            <li><a href="/">This week</a></li>
            ${HUB_PAGES.map(p => `<li><a href="${p.path}">${escHtml(p.nav)}</a></li>`).join('\n            ')}
          </ul>
        </div>
        <div class="footer-section">
          <h2>About</h2>
          <ul class="footer-links" role="list">
            <li><a href="/about">About ${town.siteName}</a></li>
            <li><a href="/submit">Submit an event</a></li>
            <li><a href="/venues">Venues</a></li>
            <li><a href="/advertise">Advertise</a></li>
            <li><a href="/contact">Contact</a></li>
          </ul>
        </div>
        <div class="footer-section">
          <h2>Policies</h2>
          <ul class="footer-links" role="list">
            <li><a href="/terms">Terms</a></li>
            <li><a href="/advertising-terms">Advertising terms</a></li>
            <li><a href="/privacy">Privacy</a></li>
            <li><a href="/accessibility">Accessibility</a></li>
            <li><a href="/referral-rules">Referral rules</a></li>
          </ul>
        </div>
      </div>
      <div class="footer-bottom"><span>&copy; ${year} ${town.siteName} · ${town.cityState}</span>${THEME_TOGGLE}</div>
    </div>
  </footer>`;
}

export function breadcrumbLd(siteUrl, trail) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((t, i) => ({
      '@type': 'ListItem', position: i + 1, name: t.name, item: siteUrl + t.path
    }))
  };
}

// pixel: false leaves the Meta Pixel off a page, and analytics (which
// follows it) leaves Google Analytics off too. Pages reached from links
// carrying a subscriber's token (confirm, unsubscribe) use it: both tools
// report the page URL to a third party, and no third party should see the
// token. gaSnippet() strips query strings anyway; this is belt and braces.
export function layout({ siteUrl, path, title, description, body, ld = [], noindex = false, nav = path, image = OG_IMAGE, imageSize = image === OG_IMAGE ? [1200, 630] : null, pixel = true, analytics = pixel, wide = false }) {
  const url = siteUrl + path;
  return `<!DOCTYPE html>
<html lang="en">
<head>
${analytics && town.gaId ? `<!-- Google tag (gtag.js); same property as docs/index.html -->\n${gaSnippet()}\n` : ''}<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(title)}</title>
<meta name="description" content="${escHtml(description)}">
${noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${escHtml(url)}">`}
<meta property="og:type" content="website">
<meta property="og:title" content="${escHtml(title)}">
<meta property="og:description" content="${escHtml(description)}">
<meta property="og:url" content="${escHtml(url)}">
<meta property="og:site_name" content="${town.siteName}">
<meta property="og:image" content="${siteUrl}${image}">
${imageSize ? `<meta property="og:image:width" content="${imageSize[0]}">\n<meta property="og:image:height" content="${imageSize[1]}">\n` : ''}<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${siteUrl}${image}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<!-- Fonts load without blocking first paint; text shows in the fallback face until they arrive. -->
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fredoka:wght@400..700&family=Nunito:ital,wght@0,400..900;1,400..900&display=swap" media="print" onload="this.media='all'">
<noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fredoka:wght@400..700&family=Nunito:ital,wght@0,400..900;1,400..900&display=swap"></noscript>
<link rel="stylesheet" href="/base.css">
<link rel="stylesheet" href="/style.css">
${THEME_SCRIPT}
${ld.map(jsonLd).join('\n')}
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
${headerHtml()}
${navHtml(nav)}
<main class="main-content" id="main">
  <div class="container${wide ? '' : ' container--narrow'}">
${body}
  </div>
</main>
${footerHtml()}
${pixel ? '<script src="/pixel.js" defer></script>\n' : ''}<script src="/track.js" defer></script>
<script src="/turnstile.js" defer></script>
<script src="/scrollfade.js" defer></script>
</body>
</html>`;
}

// The sponsor paid for these clicks, so tag them (utm_*) for their own
// analytics, unless their URL already carries campaign tags. Paired with
// rel="sponsored" (Google's marker for paid links) and no "noreferrer",
// so the visit isn't counted as Direct. docs/app.js does the same.
export function sponsorLinkUrl(url, medium = 'sponsor') {
  const href = safeUrl(url);
  if (!href || /[?&]utm_/i.test(href)) return href;
  try {
    const u = new URL(href);
    u.searchParams.set('utm_source', town.utmSource);
    u.searchParams.set('utm_medium', medium);
    u.searchParams.set('utm_campaign', 'weekly-sponsor');
    return safeUrl(u.toString()) || href;
  } catch {
    return href;
  }
}

// Mirrors renderSponsor() in docs/app.js so the paid sponsor slot shows on
// every page, not just the homepage.
// The placeholder logo in /advertise and checkout examples (docs/sample-logo.svg).
export const SAMPLE_LOGO = '/sample-logo.svg';
export const isSponsorLogo = l => /^\/sponsor-logo\/[A-Za-z0-9-]{8,64}$/.test(l || '') || l === SAMPLE_LOGO;

// Prices stay on the sponsor pages (/advertise and checkout), never in
// these prompts: the owner's call.
// A week nobody has booked shows this in the sponsor slot instead of
// leaving it out, so the businesses reading the site see the spot is for
// sale. Booking the week replaces it. Not .sponsor-cta: track.js counts its
// /advertise link as an advertise click, not a sponsor click.
export function houseAdHtml() {
  return '<section class="sponsor-section"><div class="sponsor-block sponsor-block--house">' +
    '<div class="sponsor-label">Your business here</div>' +
    `<div class="sponsor-name">Feature your business on ${town.siteName}</div>` +
    '<div class="sponsor-text">One business a week gets this spot on every page and in the newsletter. ' +
    `Have an event coming up? Give it the ${town.pickName} badge.</div>` +
    '<a href="/advertise" class="btn btn--primary house-cta">See how it works</a></div></section>';
}

export function sponsorHtml(sponsor) {
  if (!sponsor || !sponsor.name) return houseAdHtml();
  const href = sponsorLinkUrl(sponsor.url);
  const cta = sponsor.cta
    ? (href
      ? `<a href="${escHtml(href)}" class="btn btn--outline sponsor-cta" target="_blank" rel="sponsored noopener">${escHtml(sponsor.cta)}</a>`
      : `<span class="btn btn--outline" style="cursor:default; opacity:0.6">${escHtml(sponsor.cta)}</span>`)
    : '';
  const logo = isSponsorLogo(sponsor.logo) ? sponsor.logo : '';
  return `<section class="sponsor-section"><div class="sponsor-block"${adAttr(sponsor.order)}>` +
    '<div class="sponsor-label">This week\'s sponsor</div>' +
    (logo ? `<img class="sponsor-logo" src="${escHtml(logo)}" alt="${escHtml(sponsor.name)} logo" loading="lazy">` : '') +
    `<div class="sponsor-name">${escHtml(sponsor.name)}</div>` +
    (sponsor.text ? `<div class="sponsor-text">${escHtml(sponsor.text)}</div>` : '') +
    (sponsor.address ? `<div class="sponsor-address">📍 ${escHtml(sponsor.address)}</div>` : '') +
    cta + '</div></section>';
}

export function ctaHtml() {
  return `<p class="page-cta">Get the full list every Monday and Thursday: <a href="/subscribe">subscribe to ${town.siteName} newsletter</a>. Know something we missed? <a href="/submit">Submit an event</a>.</p>`;
}

// Short "including A, B, and C" clause from the first few names, Vic's
// Picks first (the list itself is in time order; sort is stable).
function including(list) {
  const names = [...new Set(list.slice().sort((a, b) => pickRank(a) - pickRank(b)).map(ev => ev.name))].slice(0, 3);
  if (!names.length) return '';
  if (names.length === 1) return `, including ${names[0]}`;
  return `, including ${names.slice(0, -1).join(', ')}${names.length > 2 ? ',' : ''} and ${names[names.length - 1]}`;
}

export function renderHubPage(page, events, { siteUrl, now, sponsor }) {
  const today = localDateStr(now);
  const [start, end] = dateRange(page.range, today);
  const list = eventsBetween(events, start, end, page.filter);
  const label = formatRange(start, end);
  const lead = page.lead(list.length, label) + (list.length ? including(list) : '') + '.';
  const body = `
    <h1 class="page-title">${escHtml(page.h1)}</h1>
    <p class="page-lead">${escHtml(lead)}</p>
    ${page.weekLink ? `<p class="week-nav"><a href="${escHtml(page.weekLink.href)}">${escHtml(page.weekLink.label)}</a></p>` : ''}
    ${list.length ? `<p class="share-row"><button type="button" class="share-btn share-btn--list" data-share-url="${escHtml(siteUrl + page.path)}" data-share-text="${escHtml(page.h1)}" data-track="share_list">Share this list</button></p>` : ''}
    ${list.length
      ? renderGrouped(list, today)
      : `<div class="empty-state">Check <a href="/">this week's full list</a>, or <a href="/submit">submit an event</a>.</div>`}
    ${sponsorHtml(sponsor)}
    ${ctaHtml()}`;
  const ld = [
    breadcrumbLd(siteUrl, [{ name: town.siteName, path: '/' }, { name: page.nav, path: page.path }]),
    ...list.map(ev => eventJsonLd(ev, siteUrl))
  ];
  return layout({ siteUrl, path: page.path, title: `${page.title} | ${town.siteName}`, description: page.description, body, ld });
}

// image: the event's own link-preview card (server/ogImage.js), passed in
// by the route; falls back to the site-wide image.
export function renderEventPage(ev, events, { siteUrl, now, sponsor, extras = '', venuePath = null, image = null }) {
  const today = localDateStr(now);
  const src = safeUrl(ev.url);
  const when = formatDay(ev.date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const where = whereText(ev);
  const time = formatTime(ev.time);
  // "from 10:00 AM to 3:00 PM at The PumpHouse", not "at 10:00 AM – 3:00 PM at …".
  const timePart = !time ? '' : / – /.test(time) ? ` from ${time.replace(' – ', ' to ')}` : `, ${time},`;
  const lead = `${ev.name} ${ev.date < today ? 'was' : 'is'} on ${when}${timePart}` +
    `${where ? ` at ${where}` : ''} in ${townOf(ev)}, ${town.state}.` + (ev.free === true ? ' Free to attend.' : '');
  // With no source link there are no "event details" to point at.
  const cost = ev.free === true ? 'Free'
    : src ? 'See event details'
    : venuePath ? `<a href="${escHtml(venuePath)}">Check with the venue</a>` : 'Check with the venue';
  // Recurring names ("Live Music", "Brunch") are only told apart in search
  // results by where they are; fall back to the bare name if that runs long.
  const shortDate = formatDay(ev.date, { month: 'short', day: 'numeric' });
  const venue = (ev.venue || '').trim();
  const withVenue = venue && !/^\d/.test(venue) && !ev.name.toLowerCase().includes(venue.toLowerCase())
    ? `${ev.name} at ${venue} · ${shortDate}` : '';
  const heading = withVenue && withVenue.length <= 60 ? withVenue : `${ev.name} · ${shortDate}`;
  // "Also that day": picks are always among the six, then shown in time order.
  const sameDay = sortEvents(sortEvents(events.filter(o => o.date === ev.date && o.page !== ev.page))
    .sort((a, b) => pickRank(a) - pickRank(b)).slice(0, 6));
  const description = (ev.description ? ev.description + ' ' : '') +
    `${when}${where ? ` at ${where}` : ''}, ${townOf(ev)}, ${town.state}.`;
  const body = `
    <p class="breadcrumbs"><a href="/">This week</a> › ${escHtml(ev.name)}</p>
    <h1 class="page-title">${escHtml(ev.name)}</h1>
    ${ev.featured ? `<p class="event-pick">${pickBadges(ev)}Featured on ${town.siteName}</p>` : ''}
    <p class="page-lead">${escHtml(lead)}</p>
    ${ev.date < today ? `<p class="past-notice">This event has passed. <a href="/">See what's happening this week</a>.</p>` : ''}
    <dl class="event-facts">
      <dt>When</dt><dd>${escHtml(when)}${time ? `, ${escHtml(time)}` : ''}</dd>
      ${where ? `<dt>Where</dt><dd>${escHtml(where)}</dd>` : ''}
      <dt>Cost</dt><dd>${cost}</dd>
    </dl>
    ${ev.description || isPaidPick(ev) ? `<p class="event-about">${escHtml(ev.description || '')}${adTag(ev)}</p>` : ''}
    ${src ? `<p class="page-actions"><a class="btn btn--primary" href="${escHtml(src)}" target="_blank" rel="noopener noreferrer">${linkLabel(src)}</a></p>` : ''}
    ${extras}
    ${venuePath ? `<p class="venue-more"><a href="${escHtml(venuePath)}">More events at ${escHtml(ev.venue)} →</a></p>` : ''}
    ${sameDay.length ? `<h2 class="section-heading">Also on ${escHtml(formatDay(ev.date, { weekday: 'long' }))}</h2>
    <ul class="event-list" role="list">${sameDay.map(renderEventItem).join('')}</ul>` : ''}
    ${sponsorHtml(sponsor)}
    ${ctaHtml()}`;
  const ld = [
    eventJsonLd(ev, siteUrl),
    breadcrumbLd(siteUrl, [{ name: town.siteName, path: '/' }, { name: ev.name, path: ev.page }])
  ];
  return layout({
    siteUrl, path: ev.page, nav: null,
    title: `${heading} | ${town.siteName}`,
    description: description.slice(0, 300), body, ld,
    ...(image ? { image, imageSize: [1200, 630] } : {})
  });
}

export function renderAboutPage({ siteUrl }) {
  const body = `
    <h1 class="page-title">About ${town.siteName}</h1>
    <p class="page-lead">${town.siteName} is a free weekly guide to events and things to do in ${town.cityStateLong}. Every week we collect concerts, festivals, family activities, markets, and community events from across ${town.city} and publish them in one list, on this site and in our email newsletter.</p>
    <h2 class="section-heading">How we build the list</h2>
    <p>${town.siteName} is put together right here in ${town.city}. We round up what's happening from ${town.localSources}, local venues and small businesses, and neighbors who send in their own events, and a local editor keeps an eye on the list so it stays accurate and worth your time. We especially love giving a spotlight to the small businesses and community groups that make ${town.city} feel like home. Spot a mistake? <a href="/contact">Let us know</a> and we'll fix it.</p>
    <h2 class="section-heading">Get it in your inbox</h2>
    <p><a href="/subscribe">Subscribe to the newsletter</a> for the week's best events every Monday, and the weekend's every Thursday.</p>
    <h2 class="section-heading">List your event or business</h2>
    <p>Anyone can <a href="/submit">submit an event</a> for free. Venues and businesses can <a href="/advertise">sponsor the newsletter or feature an event</a>.</p>`;
  const ld = [{
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: town.siteName,
    url: siteUrl + '/',
    logo: siteUrl + '/logo-512.png',
    description: `Weekly guide to events and things to do in ${town.cityStateLong}.`,
    areaServed: { '@type': 'City', name: `${town.cityStateLong}` }
  }];
  return layout({
    siteUrl, path: '/about',
    title: `About | ${town.siteName}`,
    description: `${town.siteName} is a free weekly guide to events and things to do in ${town.cityStateLong}.`,
    body, ld
  });
}

// Packages and prices here are the starting offer; change them in one place.
// amount is in cents and is what Stripe charges (server/sponsors.js).
export const AD_PACKAGES = [
  {
    key: 'weekly',
    name: 'Weekly sponsor',
    cta: 'Book your sponsor week',
    get price() { return `${dollars(this.amount)} / week`; },
    get amount() { return town.business.weeklyAmount; },
    blurb: 'Pick a week and write your message; it goes live on its own that Monday.',
    limit: 'One sponsor a week, so you’re the only one.',
    // The "what you get" checklist: [bold, rest]. Every line must be true
    // (newsletter.js sponsorHtml, seo.js sponsorHtml, social_kit.py
    // sponsor_lines, sponsors.js sponsorStats). A getter, so it names the
    // town in use (server/town.js), not the one at load. Instagram only for
    // a town that posts there (town.instagram): no town does yet, and a
    // line we can't deliver would be owed back under the make-good terms.
    get points() {
      return [
        ['Top of the newsletter', 'in both issues that week, Monday and Thursday'],
        [`Every page of ${town.domain}`, 'all week long'],
        ['Shout-out on Facebook', 'in our posts that week, with your link'],
        ...(town.instagram ? [['Shout-out on Instagram', 'in our posts that week']] : []),
        ['Your logo, message and button', 'written by you'],
        ['No competitors', 'one sponsor a week, so it’s all yours'],
        ['Your results report', 'views, clicks and where you were seen, the Monday after']
      ];
    }
  },
  {
    key: 'featured',
    get name() { return town.pickName; },
    get cta() { return `Give my event the ${town.pickName} badge`; },
    get price() { const a = town.business.pickAmount; return `${dollars(a.weekday)} Mon–Thu · ${dollars(a.weekend)} Fri–Sun`; },
    get amount() { return town.business.pickAmount.weekday; },
    get blurb() { return `Tell us about your event. Once it's listed, it's highlighted on its day with the ${town.pickName} badge.`; },
    get limit() { const c = town.business.pickCap; return `Only ${c.weekday} a day Mon–Thu and ${c.weekend} a day Fri–Sun, so book early.`; },
    get points() {
      return [
        [`${town.pickName} badge`, 'your event stands out on its day'],
        ['Guaranteed listing', 'free listings aren’t'],
        ['Starred in the newsletter', 'when you book before the issue goes out'],
        ['Featured first on Facebook', 'in our posts for your day'],
        ...(town.instagram ? [['Featured first on Instagram', 'in our posts for your day']] : []),
        ['Highlighted on its event page', `tagged Featured on ${town.siteName}`],
        ['Your results report', 'views, clicks, calendar adds and shares, the day after']
      ];
    }
  }
];

// Live, true-today numbers for /advertise: this week's listed events, the
// venues and nearby towns they cover, and subscribers once there's a real
// crowd (the same 100 the subscribe page waits for).
export function advertiseStats(events, now, subscriberCount = 0, readers = 0) {
  const week = currentWeek(localDateStr(now));
  const list = (events || []).filter(ev => ev.date >= week[0] && ev.date <= week[6]);
  const venues = new Set(list.map(ev => String(ev.venue || '').trim().toLowerCase()).filter(Boolean));
  const towns = new Set(list.map(ev => String(ev.town || '').trim()).filter(Boolean));
  return {
    events: list.length, venues: venues.size, towns: towns.size,
    subscribers: subscriberCount >= town.business.showSubscribersFrom ? Math.floor(subscriberCount / 10) * 10 : null,
    readers: reachNumbers({ readers }).readers
  };
}

// "Where your ad goes": your ad, with cartoon arrows fanning out to the
// places it shows (both packages show in all of them: the site, the
// newsletter, the Facebook posts and, for a town that posts there, the
// Instagram ones; see AD_PACKAGES points). Arrows fan out beside the tiles
// on desktop and point down at a 2-column grid on phones.
const FLOW_ICONS = {
  web: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="4" width="19" height="16" rx="3" fill="#8FD3FF" stroke="#1F1A3D" stroke-width="2"/><path d="M2.5 8.5h19" stroke="#1F1A3D" stroke-width="2"/><circle cx="5.5" cy="6.3" r=".9" fill="#1F1A3D"/><circle cx="8.2" cy="6.3" r=".9" fill="#1F1A3D"/><rect x="5.5" y="11" width="13" height="2.2" rx="1.1" fill="#fff"/><rect x="5.5" y="15" width="8" height="2.2" rx="1.1" fill="#fff"/></svg>',
  email: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="5" width="19" height="14" rx="3" fill="#FFC93C" stroke="#1F1A3D" stroke-width="2"/><path d="M3.5 7l8.5 6.5L20.5 7" fill="none" stroke="#1F1A3D" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  facebook: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#1877F2" stroke="#1F1A3D" stroke-width="2"/><path d="M13.3 21v-6.6h2.2l.35-2.6H13.3v-1.7c0-.75.21-1.27 1.3-1.27h1.38V6.5a18 18 0 0 0-2-.1c-2 0-3.35 1.2-3.35 3.43v1.97H8.4v2.6h2.23V21" fill="#fff"/></svg>',
  instagram: '<svg viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="ig-g" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#FEDA75"/><stop offset=".35" stop-color="#FA7E1E"/><stop offset=".65" stop-color="#D62976"/><stop offset="1" stop-color="#4F5BD5"/></linearGradient></defs><rect x="2.5" y="2.5" width="19" height="19" rx="5.5" fill="url(#ig-g)" stroke="#1F1A3D" stroke-width="2"/><rect x="6.5" y="6.5" width="11" height="11" rx="3.5" fill="none" stroke="#fff" stroke-width="1.8"/><circle cx="12" cy="12" r="2.6" fill="none" stroke="#fff" stroke-width="1.8"/><circle cx="16.4" cy="7.6" r="1" fill="#fff"/></svg>'
};
const flowChannels = () => [
  ['web', town.domain, 'on the site, all week'],
  ['email', 'The newsletter', 'Monday and Thursday issues'],
  ['facebook', 'Facebook', 'in our posts'],
  ...(town.instagram ? [['instagram', 'Instagram', 'in our posts']] : [])
];
// One arrow from the ad card's edge to the middle of each tile (68px tiles,
// 16px apart: centers at 34, 118, 202, 286 in a 320px-tall column of four).
const flowFan = n => {
  const h = n * 84 - 16;
  return `<svg class="ad-flow__fan" viewBox="0 0 140 ${h}" width="140" height="${h}" aria-hidden="true">` +
    Array.from({ length: n }, (_, i) => 34 + i * 84).map((y, i) => `<path d="M6 ${h / 2} C 70 ${h / 2}, 58 ${y}, 120 ${y}" fill="none" stroke="#1F1A3D" stroke-width="4" stroke-linecap="round" stroke-dasharray="${i % 2 ? '0' : '1 9'}"/>` +
      `<path d="M112 ${y - 8} L 128 ${y} L 112 ${y + 8}" fill="none" stroke="#1F1A3D" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`).join('') +
    '</svg>';
};
const FLOW_DOWN = '<svg class="ad-flow__down" viewBox="0 0 40 56" width="40" height="56" aria-hidden="true"><path d="M20 4 C 30 18, 10 32, 20 46" fill="none" stroke="#1F1A3D" stroke-width="4" stroke-linecap="round"/><path d="M11 39 L 20 50 L 29 39" fill="none" stroke="#1F1A3D" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
export function adFlowHtml() {
  const channels = flowChannels();
  return `<section class="ad-flow" aria-label="Where your ad goes">
      <h2 class="section-heading">Where your ad goes</h2>
      <div class="ad-flow__grid">
        <div class="ad-flow__ad"><span class="ad-flow__tag">Your ad</span><img src="${SAMPLE_LOGO}" alt="" width="176" height="51"><strong>Your Business</strong><span>Your message and button</span></div>
        ${flowFan(channels.length)}${FLOW_DOWN}
        <ul class="ad-flow__channels" role="list">${channels.map(([k, name, sub]) =>
          `<li class="ad-flow__ch ad-flow__ch--${k}"><span class="ad-flow__icon">${FLOW_ICONS[k]}</span><span><strong>${escHtml(name)}</strong><small>${escHtml(sub)}</small></span></li>`).join('')}</ul>
      </div>
    </section>`;
}

// How close to a booked week or event a buyer can still cancel for a full
// refund (the advertise FAQ and the advertising terms, server/legal.js).
// The same 7 days as LEAD_IN_DAYS in server/sponsors.js (a pick's report
// counts its traffic from then; tests/legal_pages.test.js checks they
// match): from that point the placement is being promoted.
export const CANCEL_NOTICE_DAYS = 7;

// Questions a business asks before buying. Keep every answer true to what
// the site does (server/sponsors.js, server/newsletter.js).
const adFaq = () => [
  [`Who reads ${town.siteName}?`, `People in ${town.city} and the towns around it who are planning what to do: families looking for weekend plans, couples planning a night out, newcomers finding their way around. They come to the site and open the newsletter to decide where to go.`],
  ['How fast does it go live?', `A weekly sponsorship goes live on its own the Monday of the week you book. A ${town.pickName} is checked by our editors and highlighted as soon as your event is listed, usually the same day.`],
  ['When does it make the newsletter?', `Monday’s issue covers the whole week and Thursday’s covers the weekend. Book a ${town.pickName} before the issue goes out and it’s starred in it; a weekly sponsor is at the top of both issues of its week.`],
  ['Can I change something after I pay?', 'Yes. Reply to your confirmation email with the change and we’ll update it.'],
  ['What’s in the report?', `Weekly sponsors get one the Monday after: how often your block was seen, where, and how many people clicked. A ${town.pickName} gets one the day after your event: times seen, page views, clicks, calendar adds and shares.`],
  ['Can I cancel?', `Yes. Email us at least ${CANCEL_NOTICE_DAYS} days before your sponsor week starts or your event's date for a full refund. Our advertising terms (linked below) have the details, including what happens if something goes wrong on our side.`],
  ['What if my day is sold out?', `${town.pickName}s are limited each day so they stand out. Pick another day, or book a weekly sponsorship to be on every page all week.`]
];

// previews: { [package key]: html } sample placements from
// server/sponsors.js samplePreviews(), the same renderer the checkout uses;
// emailPreviews the same packages inside the newsletter
// (server/newsletter.js sampleEmailPreviews). stats from advertiseStats.
export function renderAdvertisePage({ siteUrl, checkout = false, previews = {}, emailPreviews = {}, stats = null }) {
  // A paused town (TOWN_DORMANT=1) sells nothing: no packages or prices,
  // and kept out of search until it's back.
  if (town.dormant) {
    return layout({
      siteUrl, path: '/advertise', noindex: true,
      title: `Advertise | ${town.siteName}`,
      description: `${town.siteName} is taking a break and isn't selling ads right now.`,
      body: `
    <h1 class="page-title">Advertising is on a break</h1>
    <p class="page-lead">${town.siteName} is taking a break, so we aren’t selling sponsorships or ${town.pickName}s right now.</p>
    <p>Questions? <a href="/contact?topic=advertising">Send us a message</a>.</p>`
    });
  }
  const statItems = stats ? [
    stats.events ? [stats.events, 'events listed this week'] : null,
    stats.venues ? [stats.venues, 'venues this week'] : null,
    // The town plus at least two nearby towns, or it undersells.
    stats.towns >= 2 ? [stats.towns + 1, `towns: ${town.city} and nearby`] : null,
    stats.subscribers ? [`${stats.subscribers}+`, 'local subscribers'] : null,
    stats.readers ? [stats.readers.toLocaleString('en-US'), 'readers on the site this past week'] : null
  ].filter(Boolean) : [];
  const body = `
    <h1 class="page-title">Advertise on ${town.siteName}</h1>
    <p class="page-lead">Reach people in ${town.cityState} who are actively looking for something to do this week. Here’s exactly what each option gets you and where it shows.</p>
    ${statItems.length ? `<ul class="ad-stats" role="list">${statItems.map(([n, l]) => `<li><strong>${escHtml(String(n))}</strong><span>${escHtml(l)}</span></li>`).join('')}</ul>` : ''}
    ${adFlowHtml()}
    <div class="ad-packages ad-packages--rows">
      ${AD_PACKAGES.map(p => `
      <section class="ad-package ad-package--row" id="${escHtml(p.key)}">
        <div class="ad-package__info">
          <div class="ad-package__head">
            <h2>${escHtml(p.name)}</h2>
            <p class="ad-price">${escHtml(p.price)}</p>
            <p class="ad-limit">${escHtml(p.limit)}</p>
          </div>
          <div class="ad-checklist-wrap">
            <p class="ad-checklist-title">What you get</p>
            <ul class="ad-checklist" role="list">${p.points.map(([b, rest]) => `<li><span class="ad-check" aria-hidden="true">✓</span><span><strong>${escHtml(b)}</strong>${rest ? ` <span class="ad-check-rest">${escHtml(rest)}</span>` : ''}</span></li>`).join('')}</ul>
          </div>
          ${checkout ? `<div class="ad-cta"><a class="btn ad-buy" href="/advertise/checkout?package=${escHtml(p.key)}">${escHtml(p.cta)} →</a><span class="ad-cta-note">See a live preview before you pay · takes 2 minutes</span></div>` : ''}
        </div>
        ${previews[p.key] || emailPreviews[p.key] ? `<div class="ad-package__preview" aria-label="Example of a ${escHtml(p.name)}">` +
          (previews[p.key] ? `<div class="ad-preview"><p class="ad-preview-label">On the site</p>${previews[p.key]}</div>` : '') +
          (emailPreviews[p.key] ? `<div class="ad-preview"><p class="ad-preview-label">In the newsletter</p><div class="ad-email-sample">${emailPreviews[p.key]}</div></div>` : '') +
          '</div>' : ''}
      </section>`).join('')}
    </div>
    <h2 class="section-heading">Common questions</h2>
    <div class="ad-faq">${adFaq().map(([q, a]) => `<details><summary>${escHtml(q)}</summary><p>${escHtml(a)}</p></details>`).join('')}</div>
    <h2 class="section-heading">${checkout ? 'Something else?' : 'Get started'}</h2>
    <p>${checkout ? 'Pick a package above to book and pay online in a couple of minutes. Questions or a custom package?' : 'Tell us your business name and what you\'d like to promote, and we\'ll reply with open dates and our latest audience numbers.'} <a href="/contact?topic=advertising">Send us a message</a>.</p>
    <p>Listing a community event is always free: <a href="/submit">submit it here</a>.</p>
    <p class="ad-terms-note">Buying a placement means agreeing to our <a href="/advertising-terms">advertising terms</a>, including <a href="/advertising-terms#refunds">cancellations and refunds</a>.</p>`;
  return layout({
    siteUrl, path: '/advertise', wide: true,
    title: `Advertise | ${town.siteName}`,
    description: `Sponsor ${town.siteName} for a week or give your event the ${town.pickName} badge to reach people looking for things to do in ${town.cityState}.`,
    body
  });
}

// kind: 'event' (an /events/ link), 'venue' (a /venues/ link) or 'page'
// (any other unknown URL), so the wording fits what the visitor followed.
const NOT_FOUND = {
  event: {
    h1: "That event isn't listed anymore",
    lead: "It may have already happened. Here's what's on now:",
    links: [['/', "See this week's events"], ['/this-weekend', 'This weekend']]
  },
  venue: {
    h1: "We don't have a page for that venue",
    lead: 'The link may be out of date. Browse every venue, or see what’s on this week:',
    links: [['/venues', 'All venues'], ['/', "This week's events"]]
  },
  // The event archive couldn't be read (database outage): a 503, not a
  // "gone", so crawlers and readers come back.
  unavailable: {
    h1: "We can't load that event right now",
    lead: 'Please try again in a minute. Meanwhile, here’s what’s on now:',
    links: [['/', "See this week's events"], ['/this-weekend', 'This weekend']]
  },
  page: {
    h1: "We couldn't find that page",
    lead: 'The link may be mistyped or out of date. Try one of these:',
    links: [['/', "This week's events"], ['/this-weekend', 'This weekend'], ['/submit', 'Submit an event']]
  }
};

export function renderNotFoundPage({ siteUrl, kind = 'page' }) {
  const copy = NOT_FOUND[kind] || NOT_FOUND.page;
  const body = `
    <h1 class="page-title">${escHtml(copy.h1)}</h1>
    <p class="page-lead">${escHtml(copy.lead)}</p>
    <p class="page-actions">${copy.links.map(([href, label], i) =>
      `<a class="btn ${i ? 'btn--outline' : 'btn--primary'}" href="${href}">${escHtml(label)}</a>`).join(' ')}</p>`;
  const title = kind === 'unavailable' ? 'Try again shortly' : 'Not found';
  return layout({ siteUrl, path: '/404', nav: null, noindex: true, title: `${title} | ${town.siteName}`, description: kind === 'unavailable' ? 'Temporarily unavailable.' : 'Page not found.', body });
}

// Homepage: inject this week's events + JSON-LD into docs/index.html so
// the first byte already has the content. docs/app.js re-renders the same
// list on load (and still powers the admin preview), so nothing changes
// for visitors with JS.
// "Coming up": big events after this week, so people can plan (and
// subscribe) weeks ahead. An event counts when local_events.yaml marks it
// `big` or it's a Vic's Pick. Server-rendered only; app.js re-renders the
// week grid, not this.
const COMING_UP_DAYS = 90;
const COMING_UP_MAX = 20;
// The rest fold behind "Show more" so a busy season doesn't bury the page.
const COMING_UP_SHOWN = 4;

export function comingUpEvents(events, today) {
  const week = currentWeek(today);
  const last = addDays(today, COMING_UP_DAYS);
  // A festival already running this week (Fri–Sun into next week) is in the
  // week's list; don't announce its later days as "coming up".
  const thisWeek = new Set((events || []).filter(ev => ev.date >= week[0] && ev.date <= week[6])
    .map(ev => `${ev.name}|${ev.town || ''}`));
  return sortEvents((events || []).filter(ev => ev.date > week[6] && ev.date <= last && (ev.big === true || (ev.featured && !ev.editor_pick)) &&
    !thisWeek.has(`${ev.name}|${ev.town || ''}`)))
    .sort((a, b) => a.date.localeCompare(b.date))
    // One line per event: a multi-day festival shows its first day.
    .filter((ev, i, arr) => arr.findIndex(o => o.name === ev.name && (o.town || '') === (ev.town || '')) === i)
    .slice(0, COMING_UP_MAX);
}

export function renderComingUp(events, today) {
  const list = comingUpEvents(events, today);
  if (!list.length) return '';
  const card = ev => {
    const venue = placeText(ev).split(' · ')[0];
    // "Downtown Cuero · Nearby", not "Downtown Cuero · Nearby · Cuero".
    const nearby = !ev.town ? '' : venue.toLowerCase().includes(townOf(ev).toLowerCase()) ? 'Nearby' : `Nearby · ${townOf(ev)}`;
    const where = [venue, nearby].filter(Boolean).join(' · ');
    // A paid pick weeks out shows only here until its week starts; tag it
    // so its views count toward the buyer's "Shown in lists" figure.
    const ad = ev.featured && !ev.editor_pick ? adAttr(ev.sponsor_order) : '';
    return `<li class="coming-item"${ad}><a href="${escHtml(ev.page)}">` +
      `<span class="coming-date">${escHtml(formatDay(ev.date, { weekday: 'short', month: 'short', day: 'numeric' }))}</span>` +
      `<span class="coming-name">${escHtml(ev.name)}</span>` +
      (where || isPaidPick(ev) ? `<span class="coming-where">${escHtml(where)}${adTag(ev)}</span>` : '') +
      '</a></li>';
  };
  const first = list.slice(0, COMING_UP_SHOWN), rest = list.slice(COMING_UP_SHOWN);
  const more = rest.length ? `
        <details class="coming-more">
          <summary class="btn btn--outline"><span class="when-closed">Show ${rest.length} more</span><span class="when-open">Show less</span></summary>
          <ul class="coming-list" role="list">${rest.map(card).join('')}</ul>
        </details>` : '';
  return `<section class="coming-up" id="coming-up" aria-labelledby="coming-up-heading">
        <h2 class="section-heading" id="coming-up-heading">Coming up</h2>
        <p class="coming-sub">Big events worth planning for.</p>
        <ul class="coming-list" role="list">${first.map(card).join('')}</ul>${more}
      </section>`;
}

export function renderHome(template, events, { siteUrl, now, sponsor = null, signupHtml = null }) {
  const today = localDateStr(now);
  const week = currentWeek(today);
  const weekEvents = events.filter(ev => ev.date >= week[0] && ev.date <= week[6]);
  const ld = [
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: town.siteName,
      url: siteUrl + '/',
      description: `Events and things to do in ${town.cityState}, updated every week.`
    },
    ...sortEvents(weekEvents).map(ev => eventJsonLd(ev, siteUrl))
  ];
  let page = template;
  // The newsletter signup form (server/newsletter.js) fills the footer slot.
  if (signupHtml) page = page.replace(/<!--SIGNUP_START-->[\s\S]*?<!--SIGNUP_END-->/, () => signupHtml);
  return page
    // Function replacements: event text can contain "$'" or "$&", which a
    // string replacement would expand into chunks of the page.
    .replace('<p class="loading-message">Loading events...</p>', () => renderDays(week, events, today))
    .replace('<!--COMING_UP-->', () => renderComingUp(events, today))
    // The week's sponsor, or the house ad when the week is unsold (docs/app.js
    // only redraws it for a paid sponsor).
    .replace(/(<section id="sponsor-section">)\s*<!-- rendered by JS -->/, (m, open) => open + sponsorHtml(sponsor))
    // A long week pushes "Coming up" far down; this jumps there.
    .replace('<!--COMING_UP_LINK-->', () => comingUpEvents(events, today).length
      ? '<a class="btn btn--outline" href="#coming-up">Coming up ↓</a>' : '')
    .replace('<!--NAV-->', () => navHtml('/'))
    // The template's footer year is only a fallback; every other page's
    // footer computes its year (footerHtml), so the homepage must too.
    .replace(/<span data-year>\d{4}<\/span>/, () => `<span data-year>${today.slice(0, 4)}</span>`)
    .replace('</head>', () => ld.map(jsonLd).join('\n') + '\n</head>');
}

export function renderSitemap(events, { siteUrl, now, lastmod, extraPaths = [] }) {
  const today = localDateStr(now);
  const mod = (lastmod || '').slice(0, 10) || today;
  const urls = [
    { loc: '/', freq: 'daily', pri: '1.0', mod },
    ...HUB_PAGES.map(p => ({ loc: p.path, freq: 'daily', pri: '0.8', mod })),
    { loc: '/about', freq: 'monthly', pri: '0.4' },
    { loc: '/advertise', freq: 'monthly', pri: '0.3' },
    { loc: '/contact', freq: 'yearly', pri: '0.2' },
    { loc: '/submit', freq: 'monthly', pri: '0.4' },
    ...extraPaths.map(loc => ({ loc, freq: 'weekly', pri: '0.5', mod })),
    ...events.filter(ev => ev.date >= today).map(ev => ({ loc: ev.page, freq: 'weekly', pri: '0.6', mod }))
  ];
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map(u => `  <url><loc>${escHtml(siteUrl + u.loc)}</loc>` +
      (u.mod ? `<lastmod>${u.mod}</lastmod>` : '') +
      `<changefreq>${u.freq}</changefreq><priority>${u.pri}</priority></url>`).join('\n') +
    '\n</urlset>\n';
}

// llms.txt (llmstxt.org): a plain-text map of the site for AI assistants,
// plus this week's events inline so an answer engine can cite them
// without crawling every page.
// Sponsors and Vic's Picks are spelled out (and labeled as paid) so an
// assistant that answers from this file passes them along too.
export function renderLlmsTxt(events, { siteUrl, now, extraLinks = [], sponsor = null }) {
  const today = localDateStr(now);
  const upcoming = eventsBetween(events, today, addDays(today, UPCOMING_DAYS));
  const picks = upcoming.filter(ev => ev.featured);
  const lines = [
    `# ${town.siteName}`,
    '',
    `> Free weekly guide to events and things to do in ${town.cityStateLong}${town.areaCode ? ` (the ${town.areaCode} area code)` : ''}. Concerts, festivals, family activities, farmers markets, art shows, and community events. Put together locally in ${town.city}, with a local editor keeping the list accurate and a spotlight on small businesses and community groups; updated twice a week.`,
    '',
    '## Pages',
    '',
    `- [This week in ${town.cityState}](${siteUrl}/): every event Monday through Sunday`,
    ...HUB_PAGES.map(p => `- [${p.title}](${siteUrl}${p.path}): ${p.description}`),
    ...extraLinks.map(([title, path, desc]) => `- [${title}](${siteUrl}${path})${desc ? `: ${desc}` : ''}`),
    `- [About](${siteUrl}/about): who runs ${town.siteName} and how events are chosen`,
    `- [Submit an event](${siteUrl}/submit)`,
    `- [Advertise](${siteUrl}/advertise): sponsorships and featured listings for local businesses`,
    '',
    ''
  ];
  const line = (ev) => {
    const when = formatDay(ev.date, { weekday: 'short', month: 'short', day: 'numeric' }) + (ev.time ? `, ${formatTime(ev.time)}` : '');
    const where = ev.venue ? ` at ${ev.venue}` : '';
    const free = ev.free === true ? ' (free)' : '';
    return `- ${when}: [${ev.name}](${siteUrl}${ev.page})${where}${free}`;
  };
  const sponsorUrl = sponsor && sponsor.name ? safeUrl(sponsor.url) : null;
  if (sponsor && sponsor.name) {
    lines.push("## This week's sponsor", '',
      `- ${sponsorUrl ? `[${sponsor.name}](${sponsorUrl})` : sponsor.name}${sponsor.text ? `: ${sponsor.text}` : ''}` +
        `${sponsor.address ? ` (${sponsor.address})` : ''}`,
      '', `${sponsor.name} is this week's paid sponsor of ${town.siteName}.`, '');
  }
  if (picks.length) {
    lines.push(`## ${town.pickNamePlain}s`, '',
      `Featured events, highlighted on their day on ${town.siteName}. Some are our editors' can't-miss picks; some are paid placements by the venue or organizer.`, '',
      ...picks.map(ev => line(ev) + (isPaidPick(ev) ? ` ${AD_LABEL}` : " (editors' pick)")), '');
  }
  lines.push(`## Upcoming events (as of ${formatDay(today, { month: 'long', day: 'numeric', year: 'numeric' })})`, '');
  if (!upcoming.length) lines.push('- No events listed yet this week.');
  for (const ev of upcoming) {
    lines.push(line(ev) + (ev.featured ? ` (${town.pickNamePlain})` : '') + (ev.description ? ` - ${ev.description}` : '') + (isPaidPick(ev) ? ` ${AD_LABEL}` : ''));
  }
  return lines.join('\n') + '\n';
}
