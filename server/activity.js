/* server/activity.js — what people did on the site, for the owner's assistant.
 *
 * GET /api/admin/activity?days=1..90 (also /api/hq/admin/activity, so HQ's
 * assistant can read every town's): page views, visitors, every kind of
 * click, shares (and the visits shared links brought), calendar adds,
 * sponsor clicks and ad views, per day and per event page, plus the
 * newsletter issues sent in the range with their opens. Counts only: no
 * addresses, emails or visitor ids. Built from the same traffic rows as the
 * Traffic tab (server/analytics.js) and Event stats (server/sponsors.js),
 * so the numbers agree with the admin.
 */

import { CLICK_LABELS, SHARED_LINK, rowCount } from './analytics.js';
import { sameLink, pathOf, PAGE_SHARE_BUTTONS } from './sponsors.js';
import { localDateStr, addDays } from './seo.js';

export const ACTIVITY_MAX_DAYS = 90;
const isShare = t => /^share_/.test(t || '');
const people = rows => new Set(rows.map(r => `${r.day}|${r.visitor || Math.random()}`)).size;

function countBy(rows, keyFn, limit) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k) m.set(k, (m.get(k) || 0) + (Number(r.n) > 0 ? Number(r.n) : 1));
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([key, count]) => ({ key, count }));
}

// Each event page's views, link clicks, shares and calendar adds in the
// range. A share counts for the page it shared (the beacon's click_url), or
// for the page it was tapped on when the button doesn't carry the page
// (Facebook, X, text); a link click counts for the event whose link it is.
function byEvent(rows, events, limit) {
  const info = new Map();
  const byUrl = [];
  for (const ev of events || []) {
    if (!ev || !ev.page) continue;
    const page = pathOf(ev.page);
    if (!info.has(page)) info.set(page, { name: ev.name || '', venue: ev.venue || '', date: ev.date || '' });
    if (ev.url) byUrl.push([ev.url, page]);
  }
  const out = new Map();
  const row = page => {
    if (!out.has(page)) out.set(page, { page, ...(info.get(page) || { name: '', venue: '', date: '' }), views: [], link_clicks: [], shares: [], share_visits: [], calendar_adds: [] });
    return out.get(page);
  };
  const isEventPage = p => /^\/events\/[^/]+$/.test(p) && !p.endsWith('.png');
  for (const r of rows) {
    const here = pathOf(r.path);
    if (r.kind === 'view' && isEventPage(here)) {
      row(here).views.push(r);
      if (r.ref_source === SHARED_LINK) row(here).share_visits.push(r);
    } else if (r.kind === 'click' && isShare(r.click_type)) {
      const target = pathOf(r.click_url);
      if (isEventPage(target)) row(target).shares.push(r);
      else if (isEventPage(here) && PAGE_SHARE_BUTTONS.has(r.click_type)) row(here).shares.push(r);
    } else if (r.kind === 'click' && r.click_type === 'add_to_calendar' && isEventPage(here)) {
      row(here).calendar_adds.push(r);
    } else if (r.kind === 'click' && r.click_type === 'event_click') {
      const hit = byUrl.find(([u]) => sameLink(r.click_url, u));
      if (hit) row(hit[1]).link_clicks.push(r);
    }
  }
  return [...out.values()].map(e => ({
    page: e.page, name: e.name, venue: e.venue, date: e.date,
    views: rowCount(e.views), people: people(e.views), link_clicks: rowCount(e.link_clicks),
    shares: rowCount(e.shares), share_visits: rowCount(e.share_visits), calendar_adds: rowCount(e.calendar_adds)
  })).sort((a, b) => (b.views + b.link_clicks + b.shares) - (a.views + a.link_clicks + a.shares) || a.page.localeCompare(b.page))
    .slice(0, limit);
}

// rows: traffic rows (store.listTraffic); events: live + archived events;
// sends: newsletter sends ({ week_key, subject, sent_at, recipients });
// opens: { week_key: unique opens }.
export function activitySummary(rows, { now, days = 7, events = [], sends = [], opens = {} }) {
  const to = localDateStr(now);
  const from = addDays(to, -(days - 1));
  const inRange = (rows || []).filter(r => r.day >= from && r.day <= to);
  const views = inRange.filter(r => r.kind === 'view');
  const clicks = inRange.filter(r => r.kind === 'click');
  const shares = clicks.filter(r => isShare(r.click_type));
  const type = t => clicks.filter(r => r.click_type === t);

  const byDay = new Map();
  for (const r of inRange) {
    if (!byDay.has(r.day)) byDay.set(r.day, []);
    byDay.get(r.day).push(r);
  }
  const daily = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const day = byDay.get(d) || [];
    const v = day.filter(r => r.kind === 'view');
    const c = day.filter(r => r.kind === 'click');
    daily.push({ day: d, views: rowCount(v), visitors: people(v), clicks: rowCount(c), shares: rowCount(c.filter(r => isShare(r.click_type))) });
  }

  const dayOf = v => { const d = v ? new Date(v) : null; return d && !Number.isNaN(d.getTime()) ? localDateStr(d) : null; };
  const issues = (sends || [])
    .map(s => ({ week_key: s.week_key, sent_on: dayOf(s.sent_at), subject: s.subject || '',
      recipients: Number(s.recipients) || 0, opens: Number(opens[s.week_key]) || 0 }))
    .filter(s => s.sent_on && s.sent_on >= from && s.sent_on <= to)
    .sort((a, b) => b.sent_on.localeCompare(a.sent_on));

  return {
    ok: true,
    generated_at: now.toISOString(),
    days, from, to,
    totals: {
      views: rowCount(views), visitors: people(views),
      clicks: rowCount(clicks.filter(r => r.click_type !== 'filter')),
      event_link_clicks: rowCount(type('event_click')),
      shares: rowCount(shares), share_visits: rowCount(views.filter(r => r.ref_source === SHARED_LINK)),
      calendar_adds: rowCount(type('add_to_calendar')),
      sponsor_clicks: rowCount(type('sponsor_click')),
      subscribe_clicks: rowCount(type('subscribe_click')),
      ad_views: rowCount(inRange.filter(r => r.kind === 'impression')),
      newsletter_recipients: issues.reduce((n, s) => n + s.recipients, 0),
      newsletter_opens: issues.reduce((n, s) => n + s.opens, 0)
    },
    clicks_by: countBy(clicks, r => r.click_type, 20).map(c => ({ ...c, label: CLICK_LABELS[c.key] || c.key })),
    shares_by: countBy(shares, r => r.click_type, 10).map(c => ({ ...c, label: CLICK_LABELS[c.key] || c.key })),
    sources: countBy(views, r => r.ref_source || 'Direct', 10),
    top_pages: countBy(views, r => r.path, 10),
    events: byEvent(inRange, events, 25),
    newsletter: issues,
    daily
  };
}
