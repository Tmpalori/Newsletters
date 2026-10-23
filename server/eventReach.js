/* server/eventReach.js — Where an event was put in front of people, for its
 * reports: the free submitter's recap (server/eventRecaps.js) and the paid
 * pick report (server/sponsors.js).
 *
 * Tristen (Oct 2026): show everywhere the event went, so the numbers sell
 * the upgrade; each one is real and says what it counts:
 *   - list views: views of the day lists it was on (homepage for its week,
 *     /this-weekend for a Fri–Sun event, /today on the day, /next-week the
 *     week before), only when it made its day's list;
 *   - newsletter: the issues that listed it (newsletter_sends.events, the
 *     event pages each issue showed) and the copies sent; "sent to", never
 *     "seen by";
 *   - social: the Facebook/Instagram posts that showed it (the social kit's
 *     `pages`, kept per post in social_posted by scripts/social_post.py);
 *   - visits to its page from the newsletter and from Facebook/Instagram
 *     (traffic ref_source; our own paid ads are 'Meta ads' and not counted);
 *   - how a paid pick compares with other events (median page views).
 * Issues and posts are recorded from Oct 18 2026; earlier events just don't
 * get those lines.
 */

import { addDays, currentWeek, localDateStr } from './seo.js';
import { pathOf, eventWeekStats, LEAD_IN_DAYS } from './sponsors.js';
import { rowCount } from './analytics.js';

const SOCIAL_SOURCES = new Set(['Facebook', 'Instagram']);
// How far back the list views reach: /next-week shows it the week before.
export const REACH_DAYS = 14;

const isWeekend = date => [0, 5, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());
const views = (traffic, path, from, to) => (traffic || []).filter(r => r.kind === 'view' && r.day >= from && r.day <= to && pathOf(r.path) === path).length;

// Views of the day lists that showed an event on `date` (it made the list).
export function listViews(traffic, date) {
  const week = currentWeek(date);
  return views(traffic, '', week[0], date) +
    (isWeekend(date) ? views(traffic, '/this-weekend', week[0], date) : 0) +
    views(traffic, '/today', date, date) +
    views(traffic, '/next-week', addDays(week[0], -7), addDays(week[0], -1));
}

// The week's Monday issue and Thursday weekend issue that listed `page`.
// `sends`: [monday, thursday] newsletter_sends records (or null).
export function newsletterReach(sends, page) {
  const issues = [];
  ['Monday', 'Thursday'].forEach((day, i) => {
    const s = (sends || [])[i];
    if (s && Number(s.recipients) > 0 && Array.isArray(s.events) && s.events.includes(page)) issues.push({ day, recipients: Number(s.recipients) });
  });
  return { issues, recipients: issues.reduce((n, x) => n + x.recipients, 0) };
}

// Social posts (social_posted: { "<date>:<kind>": { facebook, instagram,
// pages } }) from the week before through `date` that showed `page`.
export function socialPosts(posted, page, date) {
  const from = addDays(date, -LEAD_IN_DAYS);
  const real = id => typeof id === 'string' && id && id !== 'pending';
  let posts = 0;
  const platforms = new Set();
  for (const [key, slot] of Object.entries(posted && typeof posted === 'object' ? posted : {})) {
    const day = key.slice(0, 10);
    if (day < from || day > date || !slot || !Array.isArray(slot.pages) || !slot.pages.includes(page)) continue;
    const on = ['facebook', 'instagram'].filter(p => real(slot[p]));
    if (!on.length) continue;
    posts++;
    on.forEach(p => platforms.add(p));
  }
  return { posts, platforms: [...platforms] };
}

// Visits to its page from the newsletter and from Facebook/Instagram, over
// its lead-in week.
export function visitsFrom(traffic, page, date) {
  const from = addDays(date, -LEAD_IN_DAYS);
  const mine = (traffic || []).filter(r => r.kind === 'view' && r.day >= from && r.day <= date && pathOf(r.path) === page);
  return { newsletter: mine.filter(r => r.ref_source === 'Newsletter').length, social: mine.filter(r => SOCIAL_SOURCES.has(r.ref_source)).length };
}

const median = xs => {
  const s = xs.slice().sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};
// How many times the page views of a typical other event `mine` got, or
// null when there's too little to compare or it isn't clearly more.
export function liftOver(mine, others, { minOthers = 5, minLift = 1.5 } = {}) {
  if (others.length < minOthers) return null;
  const typical = median(others);
  if (!(typical > 0)) return null;
  const r = mine / typical;
  return r >= minLift ? r : null;
}

// Paid picks against every other event over a window: median page views
// (each over its own lead-in week). `pickPages`: the paid picks' pages.
export function pickLift(traffic, events, pickPages, { from, to }) {
  const stats = eventWeekStats(traffic, events, { start: from, end: to });
  const picks = new Set(pickPages);
  const paid = stats.filter(s => picks.has(s.page)).map(s => s.page_views);
  if (paid.length < 3) return null;
  return liftOver(median(paid), stats.filter(s => !picks.has(s.page)).map(s => s.page_views), { minOthers: 10 });
}

// Times a typical paid pick was on screen, for the recap's upgrade line
// next to the event's own count (Tristen, Oct 2026: show free submitters
// what a pick adds, in numbers). The median over the picks dated `from` to
// `to`, each counted as its own report counts it: impressions from the day
// it was bought through its date. Rounded down to two significant figures
// so it never overstates; null under 3 picks, or with none seen. `traffic`
// starting after a pick was bought only undercounts it.
const PAID_PICK = new Set(['paid', 'active', 'processing']);
function roundDown(n) {
  if (n < 100) return n;
  const step = 10 ** (Math.floor(Math.log10(n)) - 1);  // 640 -> 10, 1,234 -> 100
  return Math.floor(n / step) * step;
}
export function typicalPickShown(traffic, orders, { from, to }) {
  const picks = (orders || []).filter(o => o && o.kind === 'featured' && PAID_PICK.has(o.status) && o.event &&
    o.event.date >= from && o.event.date <= to);
  if (picks.length < 3) return null;
  const counts = picks.map(o => {
    const bought = localDateStr(new Date(o.paid_at || o.created_at || `${o.event.date}T12:00:00Z`));
    return rowCount((traffic || []).filter(r => r.kind === 'impression' && r.ad === o.id && r.day >= bought && r.day <= o.event.date));
  });
  const typical = Math.floor(median(counts));
  return typical > 0 ? roundDown(typical) : null;
}

// The headline total: list views plus newsletter copies, only from the
// places it actually appeared.
export function reachTotal(r) {
  return (r.list_views || 0) + (r.newsletter_recipients || 0);
}
