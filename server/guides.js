/* server/guides.js — Venue pages, seasonal event guides, and calendar files.
 *
 * Everything here is generated from data that already exists, so it stays
 * current with no editing:
 *   - /venues and /venues/<slug>: one page per place in venues.json, with
 *     its upcoming events (live payload) and recent past ones (archive).
 *     People search venue names, and it's the page to show a venue when
 *     selling a partner plan.
 *   - Seasonal guides (/halloween-events, /christmas-events, ...): keyword
 *     matches over upcoming + archived events. They show in the nav only
 *     while in season and are noindexed when there's nothing to list.
 *   - /events/<slug>.ics: an add-to-calendar file for any event page.
 */

import { town } from './town.js';
import {
  escHtml, safeUrl, slugify, layout, renderEventItem, renderGrouped,
  eventJsonLd, breadcrumbLd, sponsorHtml, ctaHtml, localDateStr, formatDay,
  sortEvents, parseTimes, addDays, utcOffset, townOf, whereText
} from './seo.js';

// ─── Venues ──────────────────────────────────────────────────────────────

// Organizers rather than places (tourism accounts, promoters, festivals)
// don't get a venue page; their events show on the real venue's page.
// Exact organizer words only: "Public Library / Community Programs" is a place.
const NON_PLACE = /aggregator|promoter|\bfestival\b|\bmedia\b|events hub|online/i;

function normName(s) {
  return String(s || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(the|tx|texas|victoria)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildVenues(venueList) {
  const seen = new Set();
  const out = [];
  for (const v of Array.isArray(venueList) ? venueList : []) {
    if (!v || !v.name || NON_PLACE.test(v.category || '')) continue;
    const slug = slugify(v.name);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ ...v, slug, path: `/venues/${slug}`, key: normName(v.name) });
  }
  return out;
}

// True when an event's venue string could refer to this venue: an exact
// match on the normalized name, or one name containing the other as whole
// words when the shorter has 2+ words ("Leo J. Welder Center" inside "Leo J.
// Welder Center for the Performing Arts"). A single shared word isn't
// enough: "Theatre Victoria" and "Victoria Ballet Theatre" both normalize
// to names containing "theatre".
export function eventAtVenue(ev, venue) {
  const k = normName(ev.venue);
  if (!k || !venue.key) return false;
  if (k === venue.key) return true;
  const [a, b] = k.length < venue.key.length ? [k, venue.key] : [venue.key, k];
  return a.split(' ').length >= 2 && (` ${b} `).includes(` ${a} `);
}

// The single venue an event belongs to: an exact name match wins over a
// partial one, so each event lands on exactly one venue page.
//
// Answers are memoized per venues list (built once at boot) by the event's
// venue string. Venue pages and the sitemap ask for every archived event
// (thousands once the 400-day archive fills); normalizing and scanning
// ~80 venues each time took ~300 ms of blocking CPU per request. There are
// only a few hundred distinct venue strings.
const venueMemo = new WeakMap();
export function venueFor(ev, venues) {
  const raw = String((ev && ev.venue) || '');
  let memo = venueMemo.get(venues);
  // A list changed in place (tests build their own) starts over.
  if (!memo || memo.size !== venues.length) {
    memo = { size: venues.length, byVenue: new Map() };
    venueMemo.set(venues, memo);
  }
  if (memo.byVenue.has(raw)) return memo.byVenue.get(raw);
  const k = normName(raw);
  const found = !k ? null
    : venues.find(v => v.key === k) || venues.find(v => eventAtVenue({ venue: raw }, v)) || null;
  memo.byVenue.set(raw, found);
  return found;
}

function venueEvents(venue, live, archived, today, venues) {
  const candidates = venues || [venue];
  const byPage = new Map();
  for (const ev of [...archived, ...live]) {
    if (ev && ev.page && venueFor(ev, candidates) === venue) byPage.set(ev.page, ev);
  }
  const all = [...byPage.values()];
  // Upcoming from the live list only (as for seasons): the archive also
  // keeps the old page of an event that was renamed or taken down since.
  const livePages = new Set(live.map(e => e && e.page));
  return {
    upcoming: sortEvents(all.filter(e => e.date >= today && livePages.has(e.page))),
    past: sortEvents(all.filter(e => e.date < today)).reverse().slice(0, 10)
  };
}

// Street part only: some sources store "203 E. Constitution St, Victoria,
// TX" and the page adds ", Victoria, TX" (town.cityState) itself.
const reEsc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let cityTail = null;
function cityTailRe() {
  const key = `${town.city}|${town.state}|${town.stateName}`;
  if (!cityTail || cityTail.key !== key) {
    const c = reEsc(town.city), st = `(?:${reEsc(town.state)}|${reEsc(town.stateName)})`;
    // ", Victoria[, TX]" or " Victoria TX", so "123 N Victoria" (a street) stays.
    cityTail = { key, re: new RegExp(`(?:,\\s*${c}\\s*,?\\s*${st}?|\\s+${c}\\s*,?\\s*${st})\\.?\\s*(?:\\d{5}(?:-\\d{4})?)?\\s*$`, 'i') };
  }
  return cityTail.re;
}
export function streetAddress(addr) {
  return String(addr || '').trim()
    .replace(cityTailRe(), '')
    .replace(/,\s*$/, '').trim();
}

function venueAddress(events) {
  const withAddr = events.find(e => streetAddress(e.address));
  return withAddr ? streetAddress(withAddr.address) : '';
}

export function renderVenuePage(venue, live, archived, { siteUrl, now, sponsor, venues }) {
  const today = localDateStr(now);
  const { upcoming, past } = venueEvents(venue, live, archived, today, venues);
  const address = venueAddress([...upcoming, ...past]);
  const links = [
    ['Website', safeUrl(venue.website)],
    ['Facebook', safeUrl(venue.facebook_page)],
    ['Instagram', safeUrl(venue.instagram_url) || (venue.instagrams && venue.instagrams[0]
      ? `https://www.instagram.com/${encodeURIComponent(venue.instagrams[0])}/` : '')]
  ].filter(([, u]) => u);
  const lead = upcoming.length
    ? `${venue.name} has ${upcoming.length === 1 ? '1 upcoming event' : `${upcoming.length} upcoming events`} listed on ${town.siteName}, starting ${formatDay(upcoming[0].date, { weekday: 'long', month: 'long', day: 'numeric' })}.`
    : `No upcoming events are listed for ${venue.name} right now.`;
  const body = `
    <p class="breadcrumbs"><a href="/venues">Venues</a> › ${escHtml(venue.name)}</p>
    <h1 class="page-title">${escHtml(venue.name)}</h1>
    <p class="page-lead">${escHtml(lead)}</p>
    <dl class="event-facts">
      <dt>Type</dt><dd>${escHtml(venue.category)}</dd>
      ${address ? `<dt>Address</dt><dd>${escHtml(address)}, ${town.cityState}</dd>` : ''}
      ${venue.event_potential ? `<dt>Known for</dt><dd>${escHtml(venue.event_potential)}</dd>` : ''}
    </dl>
    ${links.length ? `<p class="venue-links">${links.map(([l, u]) =>
      `<a class="btn btn--outline" href="${escHtml(u)}" target="_blank" rel="noopener noreferrer">${l}</a>`).join(' ')}</p>` : ''}
    <h2 class="section-heading">Upcoming events</h2>
    ${upcoming.length ? renderGrouped(upcoming, today)
      : `<div class="empty-state">Check <a href="/">this week's full list</a> for everything happening in ${town.city}.</div>`}
    ${past.length ? `<h2 class="section-heading">Recent events</h2>
    <ul class="event-list" role="list">${past.map(renderEventItem).join('')}</ul>` : ''}
    ${sponsorHtml(sponsor)}
    <p class="page-cta">Own or manage ${escHtml(venue.name)}? <a href="/advertise">Feature your events every week</a>.</p>`;
  const place = {
    '@context': 'https://schema.org',
    '@type': 'Place',
    name: venue.name,
    url: siteUrl + venue.path,
    address: {
      '@type': 'PostalAddress',
      ...(address ? { streetAddress: address } : {}),
      addressLocality: town.city, addressRegion: town.state, addressCountry: 'US'
    },
    ...(links.length ? { sameAs: links.map(([, u]) => u) } : {})
  };
  return layout({
    siteUrl, path: venue.path, nav: null,
    // Thin pages (nothing listed, ever) stay out of the index.
    noindex: !upcoming.length && !past.length,
    title: `${venue.name} Events in ${town.cityState} | ${town.siteName}`,
    description: `Upcoming events at ${venue.name} in ${town.cityState}${venue.event_potential ? `: ${venue.event_potential}` : ''}.`.slice(0, 300),
    body,
    ld: [place, breadcrumbLd(siteUrl, [{ name: 'Venues', path: '/venues' }, { name: venue.name, path: venue.path }]),
      ...upcoming.slice(0, 20).map(ev => eventJsonLd(ev, siteUrl))]
  });
}

export function renderVenueIndex(venues, live, archived, { siteUrl, now }) {
  const today = localDateStr(now);
  const counts = upcomingCounts(venues, live, archived, today);
  const rows = venues.map(v => ({ v, n: counts.get(v) || 0 }))
    .sort((a, b) => b.n - a.n || a.v.name.localeCompare(b.v.name));
  const body = `
    <h1 class="page-title">Event venues in ${town.cityState}</h1>
    <p class="page-lead">Bars, music venues, theaters, museums, markets, and event spaces around ${town.city}, with what's coming up at each.</p>
    <ul class="venue-index" role="list">
      ${rows.map(({ v, n }) => `<li><a href="${v.path}">${escHtml(v.name)}</a>
        <span class="venue-meta">${escHtml(v.category)}${n ? ` · ${n} upcoming` : ''}</span></li>`).join('\n      ')}
    </ul>
    ${ctaHtml()}`;
  return layout({
    siteUrl, path: '/venues',
    title: `Event Venues in ${town.cityState} | ${town.siteName}`,
    description: `Bars, music venues, theaters, museums and event spaces in ${town.cityState}, with their upcoming events.`,
    body,
    ld: [breadcrumbLd(siteUrl, [{ name: town.siteName, path: '/' }, { name: 'Venues', path: '/venues' }])]
  });
}

// One pass over the events instead of one pass per venue.
function upcomingCounts(venues, live, archived, today) {
  const counts = new Map();
  const seen = new Set();
  for (const ev of live) {
    if (!ev || !ev.page || seen.has(ev.page) || ev.date < today) continue;
    seen.add(ev.page);
    const v = venueFor(ev, venues);
    if (v) counts.set(v, (counts.get(v) || 0) + 1);
  }
  return counts;
}

// Venues worth listing in the sitemap: the ones with something on them.
export function venuesWithEvents(venues, live, archived, now) {
  const withAny = new Set();
  for (const ev of [...live, ...archived]) {
    const v = ev && ev.page ? venueFor(ev, venues) : null;
    if (v) withAny.add(v);
  }
  return venues.filter(v => withAny.has(v));
}

// ─── Seasonal guides ─────────────────────────────────────────────────────

// A guide shows (nav, sitemap, llms.txt, indexed) only while the collector
// has an upcoming event that matches it, so an empty "Easter" tab never sits
// in the menu. months: 1-12 an event's date must fall in to count, which
// keeps a "Holiday BBQ" in September off the Christmas page. match: tested
// against name + description. Listed in calendar order (the nav order).
// Only things tied to a time of year belong here; year-round draws like
// car shows are categories, not seasons. Apostrophes in titles can be
// straight or curly, so match both.
export const SEASONS = [
  {
    path: '/crawfish', nav: 'Crawfish', months: [1, 2, 3, 4, 5, 6],
    get title() { return `Crawfish Boils in ${town.cityState}`; }, get h1() { return `Crawfish boils in ${town.cityState}`; },
    get description() { return `Crawfish boils, crawfish festivals, and all-you-can-eat crawfish nights in ${town.cityState}.`; },
    intro: 'Crawfish boils, festivals, and all-you-can-eat nights while the season lasts.',
    match: /crawfish|crawdad|mudbug/i
  },
  {
    path: '/valentines-day', nav: "Valentine's", months: [2],
    get title() { return `Valentine's Day Events in ${town.cityState}`; }, get h1() { return `Valentine's Day in ${town.cityState}`; },
    get description() { return `Valentine's Day events in ${town.cityState}: date nights, dinners, dances, and Galentine's parties.`; },
    get intro() { return `Date nights, special dinners, dances, and Galentine's parties around ${town.city}.`; },
    match: /valentine|galentine/i
  },
  {
    path: '/mardi-gras', nav: 'Mardi Gras', months: [2, 3],
    get title() { return `Mardi Gras Events in ${town.cityState}`; }, get h1() { return `Mardi Gras in ${town.cityState}`; },
    get description() { return `Mardi Gras events in ${town.cityState}: Fat Tuesday parties, crawfish, king cake, and parades.`; },
    get intro() { return `Fat Tuesday parties, crawfish boils, king cake, and parades around ${town.city}.`; },
    match: /mardi\s*gras|fat\s*tuesday/i
  },
  {
    path: '/st-patricks-day', nav: "St. Patrick's", months: [3],
    get title() { return `St. Patrick's Day Events in ${town.cityState}`; }, get h1() { return `St. Patrick's Day in ${town.cityState}`; },
    get description() { return `St. Patrick's Day events in ${town.cityState}: pub crawls, Irish music, green beer, and family fun.`; },
    get intro() { return `Pub crawls, Irish music, and wearing green around ${town.city}.`; },
    match: /\b(st\.?|saint)\s*(patrick['’]?s\s*day|patty['’]?s?\s*day|paddy['’]?s?\s*day|patrick['’]?s\s*(parade|pub|party|celebration|bash|fest))|\bst\.?\s*(patty|paddy)['’]?s?\b(?!\s*(church|parish|school|catholic))/i,
    exclude: /\b(church|parish|catholic|mass)\b/i
  },
  {
    path: '/spring-break', nav: 'Spring Break', months: [3],
    get title() { return `Spring Break in ${town.cityState}`; }, get h1() { return `Spring Break things to do in ${town.cityState}`; },
    get description() { return `Spring Break activities in ${town.cityState}: camps, kids programs, and family outings.`; },
    intro: 'Camps, kids programs, and family outings to fill the week off school.',
    match: /spring\s*break/i
  },
  {
    path: '/easter-events', nav: 'Easter', months: [3, 4],
    get title() { return `Easter Events in ${town.cityState}`; }, get h1() { return `Easter events in ${town.cityState}`; },
    get description() { return `Easter events in ${town.cityState}: egg hunts, Easter Bunny photos, and spring family events.`; },
    get intro() { return `Egg hunts, Easter Bunny photos, and spring family events around ${town.city}.`; },
    match: /\beaster\b|egg\s*hunt|eggstravaganza|egg[\s-]*stravaganza/i
  },
  {
    path: '/earth-day', nav: 'Earth Day', months: [4],
    get title() { return `Earth Day Events in ${town.cityState}`; }, get h1() { return `Earth Day in ${town.cityState}`; },
    get description() { return `Earth Day events in ${town.cityState}: cleanups, tree plantings, nature programs, and recycling drives.`; },
    get intro() { return `Cleanups, tree plantings, nature programs, and recycling drives around ${town.city}.`; },
    match: /earth\s*day|arbor\s*day/i
  },
  {
    path: '/cinco-de-mayo', nav: 'Cinco de Mayo', months: [5],
    get title() { return `Cinco de Mayo in ${town.cityState}`; }, get h1() { return `Cinco de Mayo in ${town.cityState}`; },
    get description() { return `Cinco de Mayo events in ${town.cityState}: festivals, live music, folklórico, and food.`; },
    get intro() { return `Festivals, live music, folklórico, and food specials around ${town.city}.`; },
    match: /cinco\s*de\s*mayo/i
  },
  {
    path: '/mothers-day', nav: "Mother's Day", months: [5],
    get title() { return `Mother's Day Events in ${town.cityState}`; }, get h1() { return `Mother's Day in ${town.cityState}`; },
    get description() { return `Mother's Day events in ${town.cityState}: brunches, markets, and things to do with Mom.`; },
    get intro() { return `Brunches, markets, and things to do with Mom around ${town.city}.`; },
    match: /mother['’]?s\s*day|mom['’]?s\s*day/i,
    exclude: /day\s*out\b/i  // "Mother's Day Out" is a preschool program
  },
  {
    only: 'victoria', path: '/bach-festival', nav: 'Bach Festival', months: [5, 6],
    title: 'Victoria Bach Festival', h1: 'Victoria Bach Festival events',
    description: 'Victoria Bach Festival concerts and events in Victoria, TX.',
    intro: 'Concerts and events from the Victoria Bach Festival, one of Texas\'s longest-running classical music festivals.',
    match: /bach\s*fest/i
  },
  {
    path: '/memorial-day', nav: 'Memorial Day', months: [5],
    get title() { return `Memorial Day Events in ${town.cityState}`; }, get h1() { return `Memorial Day in ${town.cityState}`; },
    get description() { return `Memorial Day events in ${town.cityState}: ceremonies, remembrances, and holiday weekend things to do.`; },
    intro: 'Ceremonies honoring the fallen, and things to do over the long weekend.',
    match: /memorial\s*day/i
  },
  {
    path: '/juneteenth', nav: 'Juneteenth', months: [6],
    get title() { return `Juneteenth in ${town.cityState}`; }, get h1() { return `Juneteenth in ${town.cityState}`; },
    get description() { return `Juneteenth celebrations in ${town.cityState}: festivals, parades, cookouts, and live music.`; },
    get intro() { return `Festivals, parades, cookouts, and live music celebrating Juneteenth in ${town.city}.`; },
    match: /juneteenth|emancipation\s*day/i
  },
  {
    path: '/fathers-day', nav: "Father's Day", months: [6],
    get title() { return `Father's Day Events in ${town.cityState}`; }, get h1() { return `Father's Day in ${town.cityState}`; },
    get description() { return `Father's Day events in ${town.cityState}: cookouts, car shows, fishing, and things to do with Dad.`; },
    get intro() { return `Cookouts, car shows, and things to do with Dad around ${town.city}.`; },
    match: /father['’]?s\s*day|dad['’]?s\s*day/i,
    exclude: /day\s*out\b/i
  },
  {
    path: '/fourth-of-july', nav: 'July 4th', months: [6, 7],
    get title() { return `Fourth of July in ${town.cityState}`; }, get h1() { return `Fourth of July events in ${town.cityState}`; },
    get description() { return `Fourth of July events in ${town.cityState}: fireworks, parades, and Independence Day celebrations.`; },
    get intro() { return `Fireworks, parades, and Independence Day celebrations around ${town.city}.`; },
    match: /fourth\s*of\s*july|july\s*4|4th\s*of\s*july|independence\s*day|firework/i
  },
  {
    path: '/back-to-school', nav: 'Back to School', months: [7, 8],
    get title() { return `Back to School Events in ${town.cityState}`; }, get h1() { return `Back to school in ${town.cityState}`; },
    get description() { return `Back-to-school events in ${town.cityState}: free school supply giveaways, backpack drives, and kids events.`; },
    intro: 'School supply giveaways, backpack drives, and kids events before the first day.',
    match: /back[\s-]*to[\s-]*school|school\s*suppl(y|ies)|backpack\s*(giveaway|drive|bash)/i
  },
  {
    path: '/labor-day', nav: 'Labor Day', months: [9],
    get title() { return `Labor Day Weekend in ${town.cityState}`; }, get h1() { return `Labor Day weekend in ${town.cityState}`; },
    get description() { return `Labor Day weekend events in ${town.cityState}: cookouts, live music, and things to do.`; },
    intro: 'Cookouts, live music, and things to do over the long weekend.',
    match: /labor\s*day/i
  },
  {
    path: '/oktoberfest', nav: 'Oktoberfest', months: [9, 10, 11],
    get title() { return `Oktoberfest in ${town.cityState}`; }, get h1() { return `Oktoberfest in ${town.cityState}`; },
    get description() { return `Oktoberfest celebrations in ${town.cityState}: German beer, brats, polka, and fall festivals.`; },
    get intro() { return `German beer, brats, polka, and stein-hoisting around ${town.city}.`; },
    match: /o[ck]tober\s*fest|wurst\s*fest|german\s*fest|polka\s*fest/i
  },
  {
    only: 'victoria', path: '/tejas-fest', nav: 'Tejas Fest', months: [9, 10],
    title: 'Tejas Fest in Victoria, TX', h1: 'Tejas Fest in Victoria, TX',
    description: 'Tejas Fest schedule and related events in downtown Victoria, TX: Tejano and Texas Country music, food, vendors, and family activities.',
    intro: "Tejas Fest is Victoria's free downtown festival of Tejano and Texas Country music, food, vendors, and family activities.",
    match: /tejas\s*fest/i
  },
  {
    path: '/halloween-events', nav: 'Halloween', months: [9, 10],  // haunted houses open in late September
    get title() { return `Halloween Events in ${town.cityState}`; }, get h1() { return `Halloween events in ${town.cityState}`; },
    get description() { return `Halloween events in ${town.cityState}: trunk or treats, haunted houses, costume parties, fall festivals, and pumpkin patches.`; },
    get intro() { return `Trunk or treats, haunted houses, costume parties, fall festivals, and pumpkin patches around ${town.city}.`; },
    match: /hallowe+n|trunk[\s-]*or[\s-]*treat|haunted|costume|spooky|pumpkin|fall\s*fest|d[ií]a\s*de\s*(los\s*)?muertos|cemetery\s*tour/i
  },
  {
    path: '/dia-de-los-muertos', nav: 'Día de los Muertos', months: [10, 11],
    get title() { return `Día de los Muertos in ${town.cityState}`; }, get h1() { return `Día de los Muertos in ${town.cityState}`; },
    get description() { return `Día de los Muertos events in ${town.cityState}: altars, festivals, calavera face painting, and Day of the Dead celebrations.`; },
    get intro() { return `Ofrendas, festivals, face painting, and Day of the Dead celebrations around ${town.city}.`; },
    match: /d[ií]a\s*de\s*(los\s*)?muertos|day\s*of\s*the\s*dead/i
  },
  {
    path: '/veterans-day', nav: 'Veterans Day', months: [11],
    get title() { return `Veterans Day Events in ${town.cityState}`; }, get h1() { return `Veterans Day in ${town.cityState}`; },
    get description() { return `Veterans Day events in ${town.cityState}: parades, ceremonies, and free meals and deals for veterans.`; },
    get intro() { return `Parades, ceremonies, and thank-yous for veterans around ${town.city}.`; },
    match: /veterans?['’]?\s*day/i
  },
  {
    path: '/thanksgiving-events', nav: 'Thanksgiving', months: [11],
    get title() { return `Thanksgiving Events in ${town.cityState}`; }, get h1() { return `Thanksgiving events in ${town.cityState}`; },
    get description() { return `Thanksgiving events in ${town.cityState}: turkey trots, community dinners, and holiday weekend things to do.`; },
    intro: 'Turkey trots, community dinners, and things to do over the holiday weekend.',
    match: /thanksgiving|turkey\s*trot|friendsgiving/i
  },
  {
    path: '/christmas-events', nav: 'Christmas', months: [11, 12],
    get title() { return `Christmas Events in ${town.cityState}`; }, get h1() { return `Christmas and holiday events in ${town.cityState}`; },
    get description() { return `Christmas events in ${town.cityState}: lighted parades, holiday markets, Santa visits, light displays, and holiday concerts.`; },
    get intro() { return `Lighted parades, holiday markets, Santa visits, light displays, and holiday concerts around ${town.city}.`; },
    match: /christmas|holiday\s*(market|parade|lights?|concert|bazaar|festival|party|show|open\s*house)|\bsanta\b(?!\s*(rosa|fe|clara|ana|cruz|maria|barbara|monica))|lighted\s*parade|light(s)?\s*(display|show|tour)|nutcracker|carol(s|ing)\b|winter\s*wonderland|jingle/i
  },
  {
    path: '/new-years-eve', nav: "New Year's Eve", months: [12, 1],
    get title() { return `New Year's Eve in ${town.cityState}`; }, get h1() { return `New Year's Eve in ${town.cityState}`; },
    get description() { return `New Year's Eve parties and events in ${town.cityState}.`; },
    get intro() { return `Parties, countdowns, and live music to ring in the new year in ${town.city}.`; },
    match: /new\s*year['’]?s?\s*(eve|party|bash|celebration|countdown|ball|gala|dance)|\bnye\s*(party|bash|celebration|countdown|gala|ball|dance)|countdown\s*to\s*20\d\d/i,
    exclude: /lunar|chinese|vietnamese|t[eế]t\b/i
  }
];

// Keyword match, limited to events dated in the season's months, so a
// "Holiday weekend BBQ" in September or New Year's fireworks don't land on
// the July 4th page.
export function seasonMatches(season, ev) {
  const text = `${ev.name || ''} ${ev.description || ''}`;
  if (!season.match.test(text) || (season.exclude && season.exclude.test(text))) return false;
  const month = Number(String(ev.date || '').slice(5, 7));
  return !month || season.months.includes(month);
}

// Upcoming comes from the live list only: the archive also holds events
// that were taken down or renamed since, and those mustn't keep a guide
// (and its nav tab) alive. The archive supplies past events.
function seasonEvents(season, live, archived, today) {
  const match = ev => ev && ev.page && seasonMatches(season, ev);
  const upcoming = sortEvents(live.filter(e => match(e) && e.date >= today));
  const byPage = new Map();
  for (const ev of [...archived, ...live]) {
    if (match(ev) && ev.date < today && ev.date >= addDays(today, -400)) byPage.set(ev.page, ev);
  }
  return {
    upcoming,
    past: sortEvents([...byPage.values()]).reverse().slice(0, 12)
  };
}

// The guides this town has: the shared ones plus its own (`only: <town id>`,
// like Victoria's Bach Festival and Tejas Fest). Another town's guides get no
// route, nav entry or sitemap line here.
export function townSeasons() {
  return SEASONS.filter(s => !s.only || s.only === town.id);
}

// Seasonal pages with at least one upcoming event. Being in season isn't
// enough: a guide with nothing on it stays out of the nav and sitemap.
// Upcoming events come from the live list only (see seasonEvents), so the
// archive isn't read: this runs on every public request, and walking the
// whole archive once per season cost real CPU as it grew.
export function activeSeasons(live, _archived, now) {
  const today = localDateStr(now);
  return townSeasons().filter(s => (live || []).some(ev => ev && ev.page && ev.date >= today && seasonMatches(s, ev)));
}

export function renderSeasonPage(season, live, archived, { siteUrl, now, sponsor }) {
  const today = localDateStr(now);
  const { upcoming, past } = seasonEvents(season, live, archived, today);
  const lead = upcoming.length
    ? `${season.intro} ${upcoming.length === 1 ? '1 event is' : `${upcoming.length} events are`} coming up, starting ${formatDay(upcoming[0].date, { weekday: 'long', month: 'long', day: 'numeric' })}.`
    : `${season.intro} Nothing is listed yet this year; check back as events are announced.`;
  const body = `
    <h1 class="page-title">${escHtml(season.h1)}</h1>
    <p class="page-lead">${escHtml(lead)}</p>
    ${upcoming.length ? renderGrouped(upcoming, today)
      : `<div class="empty-state">See <a href="/">this week's events</a>, or <a href="/submit">submit an event</a>.</div>`}
    ${past.length ? `<h2 class="section-heading">Past events</h2>
    <ul class="event-list" role="list">${past.map(renderEventItem).join('')}</ul>` : ''}
    ${sponsorHtml(sponsor)}
    ${ctaHtml()}`;
  return layout({
    siteUrl, path: season.path,
    // Old links keep working, but search engines only get the page while
    // it has something coming up.
    noindex: !upcoming.length,
    title: `${season.title} | ${town.siteName}`,
    description: season.description,
    body,
    ld: [breadcrumbLd(siteUrl, [{ name: town.siteName, path: '/' }, { name: season.nav, path: season.path }]),
      ...upcoming.slice(0, 30).map(ev => eventJsonLd(ev, siteUrl))]
  });
}

// ─── Calendar + sharing ──────────────────────────────────────────────────

function icsEscape(s) {
  // \r too: a bare CR is a line break to lenient calendar apps.
  return String(s || '').replace(/\\/g, '\\\\').replace(/\r\n?|\n/g, '\\n').replace(/([,;])/g, '\\$1');
}

// RFC 5545 lines must be ≤75 octets; continuation lines start with a space.
// Split on whole characters so an emoji is never cut in half.
function foldLine(line) {
  const out = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > 75) {
      out.push(cur);
      cur = ' ';
    }
    cur += ch;
  }
  out.push(cur);
  return out.join('\r\n');
}

function compactDate(dateStr) { return dateStr.replace(/-/g, ''); }

// Start/end as UTC instants. No end time → two hours; an end at or before
// the start ("10pm - 1am") runs past midnight.
function eventInstants(ev) {
  const times = parseTimes(ev.time);
  if (!times[0]) return null;
  const start = new Date(`${ev.date}T${times[0]}:00${utcOffset(ev.date)}`);
  // A malformed date would make toISOString throw on every view.
  if (Number.isNaN(start.getTime())) return null;
  if (!times[1]) return { start, end: new Date(start.getTime() + 2 * 3600 * 1000) };
  // An end at or before the start is on the next day, read with that day's
  // offset: start-day offset + 24 h was an hour off on a DST night (a
  // Halloween party to 2 AM on Nov 1). Same as eventJsonLd in seo.js.
  const endDay = times[1] <= times[0] ? addDays(ev.date, 1) : ev.date;
  const end = new Date(`${endDay}T${times[1]}:00${utcOffset(endDay)}`);
  return { start, end };
}

function utcStamp(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

export function renderIcs(ev, { siteUrl, now }) {
  const at = eventInstants(ev);
  const stamp = utcStamp(now);
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//${town.siteName}//Events//EN`, 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${compactDate(ev.date)}-${ev.page.split('/').pop()}@${town.icalDomain}`,
    `DTSTAMP:${stamp}`
  ];
  if (at) {
    // UTC instants need no VTIMEZONE block, which Outlook requires for TZID.
    lines.push(`DTSTART:${utcStamp(at.start)}`, `DTEND:${utcStamp(at.end)}`);
  } else {
    lines.push(`DTSTART;VALUE=DATE:${compactDate(ev.date)}`,
      `DTEND;VALUE=DATE:${compactDate(addDays(ev.date, 1))}`);
  }
  lines.push(
    `SUMMARY:${icsEscape(ev.name)}`,
    `LOCATION:${icsEscape(calendarLocation(ev))}`,
    `DESCRIPTION:${icsEscape([ev.details || ev.description, `${siteUrl}${ev.page}`].filter(Boolean).join('\n\n'))}`,
    `URL:${siteUrl}${ev.page}`,
    'END:VEVENT', 'END:VCALENDAR'
  );
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

// The place with its town and state, once: whereText already ends in
// "City, ST" when the event has a street address.
function calendarLocation(ev) {
  const where = whereText(ev);
  if (/, [A-Z]{2}$/.test(where)) return where;
  return [where, `${townOf(ev)}, ${town.state}`].filter(Boolean).join(', ');
}

export function googleCalendarUrl(ev, siteUrl) {
  const at = eventInstants(ev);
  let dates;
  if (at) {
    dates = `${utcStamp(at.start)}/${utcStamp(at.end)}`;
  } else {
    dates = `${compactDate(ev.date)}/${compactDate(addDays(ev.date, 1))}`;
  }
  const params = new URLSearchParams({
    action: 'TEMPLATE', text: ev.name, dates, ctz: town.timezone,
    location: calendarLocation(ev),
    details: `${ev.details || ev.description ? String(ev.details || ev.description).slice(0, 1500) + '\n\n' : ''}${siteUrl}${ev.page}`
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

export function eventActionsHtml(ev, siteUrl) {
  const url = `${siteUrl}${ev.page}`;
  const text = `${ev.name} · ${formatDay(ev.date, { weekday: 'short', month: 'short', day: 'numeric' })}`;
  const share = [
    // ?s=sh: visits from the shared link count as "Shared link" (docs/track.js).
    ['Facebook', `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(`${url}?s=sh`)}`],
    ['X', `https://twitter.com/intent/tweet?url=${encodeURIComponent(`${url}?s=sh`)}&text=${encodeURIComponent(text)}`],
    ['Text', `sms:?&body=${encodeURIComponent(`${text} ${url}?s=sh`)}`]
  ];
  return `<div class="event-actions">
      <a class="btn btn--outline" href="${escHtml(ev.page)}.ics" data-track="add_to_calendar">Add to calendar</a>
      <a class="btn btn--outline" href="${escHtml(googleCalendarUrl(ev, siteUrl))}" target="_blank" rel="noopener noreferrer" data-track="add_to_calendar">Google Calendar</a>
    </div>
    <div class="share-row" aria-label="Share this event">
      <span class="share-label">Share:</span>
      <button type="button" class="share-btn" data-share-url="${escHtml(url)}" data-share-text="${escHtml(text)}">Share or copy link</button>
      ${share.map(([l, u]) => `<a class="share-btn" href="${escHtml(u)}" target="_blank" rel="noopener noreferrer" data-track="share_${l.toLowerCase()}">${l}</a>`).join('\n      ')}
    </div>`;
}
