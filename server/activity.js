/* server/activity.js — what people did on the site, for the owner's assistant.
 *
 * GET /api/admin/activity?days=1..90 (also /api/hq/admin/activity, so HQ's
 * assistant can read every town's): page views, visitors, every kind of
 * click (event links out and event pages opened from a list apart), shares
 * (and the visits shared links brought), calendar adds,
 * sponsor clicks and ad views, per day and per event page, plus the
 * newsletter issues sent in the range with their opens and clicks. Counts only: no
 * addresses, emails or visitor ids. Built from the same traffic rows as the
 * Traffic tab (server/analytics.js) and Event stats (server/sponsors.js),
 * so the numbers agree with the admin.
 */

import { CLICK_LABELS, SHARED_LINK, rowCount, visitorSources, isOutbound } from './analytics.js';
import { emailClickStats } from './growth.js';
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
    if (!out.has(page)) out.set(page, { page, ...(info.get(page) || { name: '', venue: '', date: '' }), views: [], link_clicks: [], list_opens: [], shares: [], share_visits: [], calendar_adds: [] });
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
    } else if (r.kind === 'click' && r.click_type === 'event_open') {
      const target = pathOf(r.click_url);
      if (isEventPage(target)) row(target).list_opens.push(r);
    }
  }
  return [...out.values()].map(e => ({
    page: e.page, name: e.name, venue: e.venue, date: e.date,
    views: rowCount(e.views), people: people(e.views), link_clicks: rowCount(e.link_clicks),
    link_clickers: people(e.link_clicks), list_opens: rowCount(e.list_opens),
    shares: rowCount(e.shares), share_visits: rowCount(e.share_visits), calendar_adds: rowCount(e.calendar_adds)
  })).sort((a, b) => (b.views + b.link_clicks + b.shares) - (a.views + a.link_clicks + a.shares) || a.page.localeCompare(b.page))
    .slice(0, limit);
}

// rows: traffic rows (store.listTraffic); events: live + archived events;
// sends: newsletter sends ({ week_key, subject, sent_at, recipients });
// opens: { week_key: unique opens }; emailClicks: store.listEmailClicks
// rows; siteHost: this site's host, to tell event links out from ours.
export function activitySummary(rows, { now, days = 7, events = [], sends = [], opens = {}, emailClicks = [], siteHost = '' }) {
  const to = localDateStr(now);
  const from = addDays(to, -(days - 1));
  // An event_click to one of our own pages is a tap from a list to the
  // event's page (event_open; before October 2026 the beacon sent both as
  // event_click).
  const inRange = (rows || []).filter(r => r.day >= from && r.day <= to)
    .map(r => (r.kind === 'click' && r.click_type === 'event_click' && !isOutbound(r.click_url, siteHost) ? { ...r, click_type: 'event_open' } : r));
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
    .map(s => {
      const mine = (emailClicks || []).filter(c => c.week_key === s.week_key);
      const tracked = Boolean(s.clicks_tracked) || mine.length > 0;
      const c = emailClickStats(mine);
      return { week_key: s.week_key, sent_on: dayOf(s.sent_at), subject: s.subject || '',
        recipients: Number(s.recipients) || 0, opens: Number(opens[s.week_key]) || 0,
        clickers: tracked ? c.clickers : null, clicks: tracked ? c.clicks : null };
    })
    .filter(s => s.sent_on && s.sent_on >= from && s.sent_on <= to)
    .sort((a, b) => b.sent_on.localeCompare(a.sent_on));

  const visitors = people(views);
  // Per 100 visitors, so towns of different sizes compare fairly.
  const per100 = n => (visitors ? Math.round(n / visitors * 1000) / 10 : null);
  const eventOut = type('event_click');
  const eventOpen = type('event_open');
  const subscribe = type('subscribe_click');
  return {
    ok: true,
    generated_at: now.toISOString(),
    days, from, to,
    totals: {
      views: rowCount(views), visitors,
      clicks: rowCount(clicks.filter(r => r.click_type !== 'filter')),
      // Taps out to an event's own link (its venue or organizer) and the
      // people who made them; event_opens are taps from a list to an
      // event's page here (navigation, not an outbound click).
      event_link_clicks: rowCount(eventOut), event_link_clickers: people(eventOut),
      event_link_clickers_per_100_visitors: per100(people(eventOut)),
      event_opens: rowCount(eventOpen), event_openers: people(eventOpen),
      event_openers_per_100_visitors: per100(people(eventOpen)),
      shares: rowCount(shares), share_visits: rowCount(views.filter(r => r.ref_source === SHARED_LINK)),
      calendar_adds: rowCount(type('add_to_calendar')),
      sponsor_clicks: rowCount(type('sponsor_click')),
      // Subscribe taps: links to the signup form (link_taps) and signups the
      // form accepted (form_ok; it may still wait on its Confirm tap).
      subscribe_clicks: rowCount(subscribe),
      subscribe_link_taps: rowCount(subscribe.filter(r => !['form', 'list-card'].includes(r.click_url))),
      subscribe_form_ok: rowCount(subscribe.filter(r => ['form', 'list-card'].includes(r.click_url))),
      subscribe_people: people(subscribe),
      ad_views: rowCount(inRange.filter(r => r.kind === 'impression')),
      newsletter_recipients: issues.reduce((n, s) => n + s.recipients, 0),
      newsletter_opens: issues.reduce((n, s) => n + s.opens, 0),
      newsletter_clickers: issues.some(s => s.clickers != null) ? issues.reduce((n, s) => n + (s.clickers || 0), 0) : null
    },
    clicks_by: countBy(clicks, r => r.click_type, 20).map(c => ({ ...c, label: CLICK_LABELS[c.key] || c.key })),
    shares_by: countBy(shares, r => r.click_type, 10).map(c => ({ ...c, label: CLICK_LABELS[c.key] || c.key })),
    // Visitors by the source that brought them (per visitor-day; moving
    // around the site doesn't count as Direct), and the page views each
    // source's visits added up to.
    sources: visitorSources(views, 10),
    source_views: countBy(views, r => r.ref_source || 'Direct', 10),
    top_pages: countBy(views, r => r.path, 10),
    events: byEvent(inRange, events, 25),
    newsletter: issues,
    daily
  };
}
