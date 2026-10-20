/**
 * Growth: the numbers behind the two goals (10,000 subscribers, $10,000 a
 * month), for Admin → Growth and the goal strip on Home.
 *
 *   GET  /api/admin/growth?days=30   admin
 *   GET  /api/admin/growth/cleanup   admin; who a never-opens rule would
 *                                    catch (a dry run, counts only)
 *   POST /api/ads/spend              X-Cron-Secret; scripts/meta_ads.py posts
 *                                    Meta's daily results with its daily report
 *
 * - Subscribers per day (by Central date confirmed), where they came from
 *   (Facebook ads, referral, site, imported), unsubscribes, and the real
 *   cost per subscriber: Meta's spend that day over the subscribers who
 *   actually joined, not Meta's own "signups" (its pixel misses iPhones,
 *   in-app browsers and blockers).
 * - Each issue (Monday's week, Thursday's weekend): sent, unique opens, readers who came to the site
 *   from it (links carry utm_source=newsletter; a visit is credited to the
 *   issue sent before it): on the day it went out (the click rate; the
 *   visitor id changes daily, so later days can't be told apart from new
 *   readers) and reader-days over its week, top events those visits opened,
 *   and unsubscribes that week.
 * - Signup weeks: of each week's new subscribers, how many are still
 *   subscribed and how many opened one of the last two issues.
 * - Event categories: event page views and link taps by icon.
 * - Goals: active subscribers against 10,000 with the pace of the last two
 *   weeks, and this month's sponsor revenue against $10,000.
 */
import crypto from 'node:crypto';
import { hqPaths } from './hqAdmin.js';
import { localDateStr, addDays, currentWeek } from './seo.js';
import { editionOf } from './newsletter.js';

export const SUBSCRIBER_GOAL = 10000;
export const REVENUE_GOAL_CENTS = 1000000;
const ISSUE_WINDOW_DAYS = 7;
// Orders whose money stays with us (sponsors.js statuses). Not 'disputed':
// Stripe holds that money until the dispute closes (won restores the order).
// pending_approval, past_due and canceled: a category partner's paid months
// (a rejected one is refunded, so it isn't here).
const KEPT = new Set(['paid', 'active', 'hidden', 'cancelled', 'pending_approval', 'past_due', 'canceled']);

const weight = r => (Number(r.n) > 0 ? Number(r.n) : 1);
// A bad timestamp counts as no date rather than breaking the report.
const dayOf = iso => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? localDateStr(d) : null;
};
const pathOf = p => String(p || '').split(/[?#]/)[0].replace(/\/$/, '') || '/';

function secretOk(given, want) {
  const g = Buffer.from(String(given || ''));
  const w = Buffer.from(String(want || ''));
  return w.length > 0 && g.length === w.length && crypto.timingSafeEqual(g, w);
}

// Where a subscriber came from, in the owner's words.
export function sourceOf(sub) {
  if (sub.referred_by) return 'Referral';
  const s = String(sub.source || '');
  if (s === 'import') return 'Imported';
  if (s.endsWith(':ad')) return 'Facebook ads';
  return 'Site';
}

const round2 = n => Math.round(n * 100) / 100;

// Subscribers and spend per day over the window, oldest first.
export function dailyGrowth(subs, spend, { today, days }) {
  const start = addDays(today, -(days - 1));
  const rows = new Map();
  for (let d = start; d <= today; d = addDays(d, 1)) rows.set(d, { day: d, joined: 0, by_source: {}, unsubscribed: 0, spend: null });
  for (const s of subs) {
    const j = s.status !== 'pending' && dayOf(s.confirmed_at);
    if (j && rows.has(j)) {
      const r = rows.get(j);
      r.joined++;
      const src = sourceOf(s);
      r.by_source[src] = (r.by_source[src] || 0) + 1;
    }
    const u = dayOf(s.unsubscribed_at);
    if (u && rows.has(u)) rows.get(u).unsubscribed++;
  }
  for (const x of spend || []) if (rows.has(x.day)) rows.get(x.day).spend = round2(Number(x.spend) || 0);
  return [...rows.values()].map(r => ({
    ...r,
    net: r.joined - r.unsubscribed,
    // Imported addresses didn't cost anything.
    cost_per_sub: r.spend != null && r.joined - (r.by_source.Imported || 0) > 0
      ? round2(r.spend / (r.joined - (r.by_source.Imported || 0))) : null
  }));
}

// Totals for a run of daily rows.
export function sumDays(daily) {
  const t = { joined: 0, unsubscribed: 0, net: 0, spend: 0, paid_joined: 0, by_source: {} };
  let spendDays = false;
  for (const d of daily) {
    t.joined += d.joined; t.unsubscribed += d.unsubscribed; t.net += d.net;
    for (const [k, v] of Object.entries(d.by_source)) t.by_source[k] = (t.by_source[k] || 0) + v;
    if (d.spend != null) { spendDays = true; t.spend += d.spend; t.paid_joined += d.joined - (d.by_source.Imported || 0); }
  }
  t.spend = spendDays ? round2(t.spend) : null;
  t.cost_per_sub = spendDays && t.paid_joined ? round2(t.spend / t.paid_joined) : null;
  return t;
}

// One row per issue (Monday's and Thursday's), newest first. A visit is
// credited to the latest issue before it, so the two split the week.
export function issueReport(sends, opens, subs, rows, events) {
  const sorted = (sends || []).filter(x => x && x.sent_at).slice().sort((a, b) => (a.sent_at < b.sent_at ? -1 : 1));
  const pageEvent = new Map();
  for (const ev of events || []) if (ev && ev.page) pageEvent.set(pathOf(ev.page), ev.name || ev.page);
  const fromEmail = (rows || []).filter(r => r.kind === 'view' && r.ref_source === 'Newsletter');
  const out = sorted.map((s, i) => {
    const from = dayOf(s.sent_at);
    const next = sorted[i + 1] ? dayOf(sorted[i + 1].sent_at) : null;
    const until = addDays(from, ISSUE_WINDOW_DAYS - 1);
    const end = next && addDays(next, -1) < until ? addDays(next, -1) : until;
    const visits = fromEmail.filter(r => r.day >= from && r.day <= end);
    // Visitor ids are per day (analytics.js), so only the send day's
    // readers are unique; the week's figure is reader-days.
    const readerDays = new Set(visits.map(r => `${r.day}|${r.visitor}`)).size;
    const firstDay = new Set(visits.filter(r => r.day === from).map(r => r.visitor)).size;
    const top = new Map();
    for (const r of visits) {
      const name = pageEvent.get(pathOf(r.path));
      if (name) top.set(name, (top.get(name) || 0) + weight(r));
    }
    const sent = Number(s.recipients) || 0;
    const opened = opens[s.week_key] || 0;
    const unsubscribed = (subs || []).filter(x => { const u = dayOf(x.unsubscribed_at); return u && u >= from && u <= end; }).length;
    return {
      week: s.week_key, edition: editionOf(s.week_key), subject: s.subject || '', sent_at: s.sent_at, sent, opens: opened,
      open_rate: sent ? Math.round(opened / sent * 1000) / 10 : null,
      clickers: firstDay, click_rate: sent ? Math.round(firstDay / sent * 1000) / 10 : null, reader_days: readerDays,
      visits: visits.reduce((a, r) => a + weight(r), 0),
      top_events: [...top.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, views]) => ({ name, views })),
      unsubscribed
    };
  });
  return out.reverse();
}

// Of each signup week's subscribers: still subscribed, and opened one of
// the last two issues, out of those who had been sent one (joined before
// the latest went out; null when none had). Newest week first.
export function signupWeeks(subs, openRows, lastTwo, { today, weeks = 8, lastSentAt = null }) {
  const opened = new Set((openRows || []).filter(r => lastTwo.includes(r.week_key)).map(r => r.subscriber_id));
  const first = addDays(currentWeek(today)[0], -7 * (weeks - 1));
  const by = new Map();
  for (const s of subs) {
    if (s.status === 'pending' || sourceOf(s) === 'Imported') continue;
    const d = dayOf(s.confirmed_at);
    if (!d) continue;
    const wk = currentWeek(d)[0];
    if (wk < first) continue;
    if (!by.has(wk)) by.set(wk, { week: wk, joined: 0, active: 0, sent: 0, opened: 0 });
    const r = by.get(wk);
    r.joined++;
    if (s.status === 'active') r.active++;
    if (lastSentAt && s.confirmed_at < lastSentAt) r.sent++;
    if (opened.has(s.id)) r.opened++;
  }
  return [...by.values()].map(r => (r.sent ? r : { ...r, opened: null }))
    .sort((a, b) => (a.week < b.week ? 1 : -1));
}

// Event page views and link taps by category (an event counts for each icon).
export function categoryStats(rows, events, { start }) {
  const iconsOf = new Map();
  for (const ev of events || []) if (ev && ev.page) iconsOf.set(pathOf(ev.page), (ev.icons || []).filter(i => i !== 'free'));
  const out = new Map();
  for (const r of rows || []) {
    if (r.day < start) continue;
    const icons = iconsOf.get(pathOf(r.path));
    if (!icons) continue;
    const isView = r.kind === 'view';
    const isTap = r.kind === 'click' && r.click_type === 'event_click';
    if (!isView && !isTap) continue;
    for (const ic of icons) {
      const c = out.get(ic) || { category: ic, views: 0, taps: 0 };
      if (isView) c.views += weight(r); else c.taps += weight(r);
      out.set(ic, c);
    }
  }
  return [...out.values()].sort((a, b) => b.views - a.views);
}

// This month's sponsor money (Central month): orders paid this month, plus
// monthly partners (venue and category) still active from an earlier month
// (they renew).
export function monthRevenue(orders, today) {
  const month = today.slice(0, 7);
  let cents = 0, count = 0, recurring = 0;
  for (const o of orders || []) {
    // A test order (marked in Admin → Sponsors, or paid in Stripe test mode) isn't revenue.
    if (!o || o.test || !KEPT.has(o.status) || !o.paid_at) continue;
    const paid = dayOf(o.paid_at);
    // A partial refund (charge.refunded with some money kept) counts only
    // what was kept. A partner's later months count the plan price.
    if (paid && paid.slice(0, 7) === month) { cents += Math.max(0, (Number(o.amount) || 0) - (Number(o.refunded_cents) || 0)); count++; }
    // Category partners (server/partners.js) renew like the old venue partners.
    else if ((o.kind === 'partner' || o.kind === 'category') && o.status === 'active' && paid < month) { recurring += Number(o.amount) || 0; count++; }
  }
  return { month, cents: cents + recurring, orders: count, recurring_cents: recurring };
}

// List cleanup, dry run only: who a "stop mailing readers who never open"
// rule would catch, counted and never acted on, so the owner can pick the
// cutoffs from real numbers before anything is removed.
//   - new: joined inside the window, sent at least `firstIssues` issues
//     (3 weeks at two a week) and opened none. `strictFirstIssues` (2 weeks)
//     is the tighter version for heavy ad spend, counted alongside.
//   - quiet: joined before the window, sent at least `quietMinIssues` of the
//     window's issues and opened none of them.
// Opens are all we have per reader: site visits from the email carry no
// subscriber id, so a reader whose mail app blocks images looks quiet.
// Apple Mail's automatic opens push the other way, so the counts lean low.
export const CLEANUP_RULES = Object.freeze({ firstIssues: 6, strictFirstIssues: 4, quietDays: 90, quietMinIssues: 6 });
const CLEANUP_SENDS = 60; // about 30 weeks at two a week, more than the window

export function cleanupDryRun(subs, sends, openRows, { now, rules = CLEANUP_RULES }) {
  const from = new Date(now.getTime() - rules.quietDays * 86400000).toISOString();
  const opened = new Set((openRows || []).map(r => `${r.week_key}|${r.subscriber_id}`));
  const tracked = new Set((openRows || []).map(r => r.week_key));
  // An issue nobody opened was sent before open counting worked (or the
  // pixel broke): counting it would make everyone look quiet.
  const issues = (sends || [])
    .filter(s => s && s.sent_at && tracked.has(s.week_key))
    .map(s => ({ key: s.week_key, at: new Date(s.sent_at).toISOString(), weekend: editionOf(s.week_key) === 'weekend' }))
    .filter(s => s.at >= from)
    .sort((a, b) => (a.at < b.at ? -1 : 1));
  // The window starts at the oldest issue we can read, which is later than
  // quietDays ago while open counting is newer than that.
  const start = issues.length ? issues[0].at : null;
  const days = start ? Math.max(1, Math.round((now.getTime() - new Date(start).getTime()) / 86400000)) : 0;
  const blank = () => ({ active: 0, too_new: 0, new_never_opened: 0, new_never_opened_strict: 0, quiet: 0 });
  const total = blank();
  const bySource = new Map();
  for (const s of subs || []) {
    const joinedAt = s.confirmed_at ? new Date(s.confirmed_at) : null;
    // A bad timestamp leaves the reader out rather than breaking the report.
    if (s.status !== 'active' || !joinedAt || Number.isNaN(joinedAt.getTime())) continue;
    const joined = joinedAt.toISOString();
    const src = sourceOf(s);
    if (!bySource.has(src)) bySource.set(src, blank());
    const rows = [total, bySource.get(src)];
    const add = k => rows.forEach(r => r[k]++);
    add('active');
    const got = issues.filter(i => i.at > joined && !(i.weekend && s.weekend_optout));
    const none = !got.some(i => opened.has(`${i.key}|${s.id}`));
    if (start && joined >= start) {
      if (got.length < rules.strictFirstIssues) { add('too_new'); continue; }
      if (none) add('new_never_opened_strict');
      if (got.length < rules.firstIssues) { add('too_new'); continue; }
      if (none) add('new_never_opened');
    } else if (got.length >= rules.quietMinIssues && none) add('quiet');
  }
  const pct = (n, of) => (of ? Math.round(n / of * 1000) / 10 : null);
  const finish = r => ({ ...r, flagged: r.new_never_opened + r.quiet, flagged_pct: pct(r.new_never_opened + r.quiet, r.active),
    flagged_strict: r.new_never_opened_strict + r.quiet, flagged_strict_pct: pct(r.new_never_opened_strict + r.quiet, r.active) });
  return {
    rules: { ...rules },
    window: { from: start, days, issues: issues.length, full: days >= rules.quietDays - 7 },
    totals: finish(total),
    by_source: [...bySource.entries()].map(([source, r]) => ({ source, ...finish(r) })).sort((a, b) => b.active - a.active)
  };
}

export function goals(subs, daily, revenue, today) {
  const active = subs.filter(s => s.status === 'active').length;
  // The last 14 whole days (today is still going), imports left out.
  const last14 = daily.filter(d => d.day < today).slice(-14);
  const perDay = last14.length ? last14.reduce((a, d) => a + d.net - ((d.by_source && d.by_source.Imported) || 0), 0) / last14.length : 0;
  const left = Math.max(0, SUBSCRIBER_GOAL - active);
  const days = perDay > 0 ? Math.ceil(left / perDay) : null;
  return {
    subscribers: { active, goal: SUBSCRIBER_GOAL, per_week: Math.round(perDay * 7 * 10) / 10,
      eta: left === 0 ? today : days != null && days < 365 * 20 ? addDays(today, days) : null },
    revenue: { ...revenue, goal_cents: REVENUE_GOAL_CENTS }
  };
}

export function registerGrowth(app, { store, requireAdmin, adminOrHq = null, nowFn = () => new Date(), secret = '', getEvents = async () => [], getOrders = async () => [] }) {
  // Meta's daily results: [{ day, spend, impressions, clicks, leads }].
  // Answers with the site's own count for yesterday, so the Slack report
  // can say what a subscriber really cost.
  app.post('/api/ads/spend', async (req, res) => {
    if (!secretOk(req.get('X-Cron-Secret'), secret)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    if (typeof store.saveAdSpend !== 'function') return res.status(501).json({ ok: false, error: 'not-supported' });
    const rows = Array.isArray((req.body || {}).days) ? req.body.days : [];
    const num = v => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
    const realDay = d => /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(`${d}T12:00:00Z`).toISOString().slice(0, 10) === d;
    const clean = rows.filter(r => r && realDay(String(r.day))).slice(0, 120)
      .map(r => ({ day: String(r.day), spend: round2(num(r.spend)), impressions: Math.round(num(r.impressions)),
        clicks: Math.round(num(r.clicks)), leads: Math.round(num(r.leads)) }));
    // The town's campaigns as the ads report saw them (scripts/meta_ads.py
    // campaign_snapshot), for HQ: name, status, daily budget (the campaign's
    // or its ad sets' added up) and where it's set, lifetime budget,
    // yesterday's spend, whether either is over the budget command's limit,
    // and the last 7 days. Victoria's report also sends the shared account's
    // live campaigns no town's prefix claims (unclaimed).
    const money = v => (v == null || v === '' ? null : round2(num(v)));
    const cams = Array.isArray((req.body || {}).campaigns) ? req.body.campaigns.slice(0, 30)
      .filter(c => c && typeof c.name === 'string')
      .map(c => ({ name: c.name.slice(0, 120), status: String(c.status || '').slice(0, 30),
        daily_budget: money(c.daily_budget),
        ...(c.budget_level === 'campaign' || c.budget_level === 'ad_sets' ? { budget_level: c.budget_level } : {}),
        ...('lifetime_budget' in c ? { lifetime_budget: money(c.lifetime_budget) } : {}),
        ...('spend_yesterday' in c ? { spend_yesterday: money(c.spend_yesterday) } : {}),
        ...('over_limit' in c ? { over_limit: c.over_limit === true } : {}),
        spend_7_days: round2(num(c.spend_7_days)), leads_7_days: Math.round(num(c.leads_7_days)), clicks_7_days: Math.round(num(c.clicks_7_days)) })) : null;
    const stray = Array.isArray((req.body || {}).unclaimed) ? req.body.unclaimed.slice(0, 30)
      .filter(c => c && typeof c.name === 'string')
      .map(c => ({ name: c.name.slice(0, 120), daily_budget: money(c.daily_budget) })) : null;
    const limit = Number.isFinite(Number((req.body || {}).limit)) && Number(req.body.limit) > 0 ? Number(req.body.limit) : null;
    try {
      await store.saveAdSpend(clean, { today: localDateStr(nowFn()) });
      if (cams && typeof store.setTownFile === 'function') {
        await store.setTownFile('ad_campaigns', { campaigns: cams, ...(stray ? { unclaimed: stray } : {}), ...(limit ? { limit } : {}) }, nowFn());
      }
      const today = localDateStr(nowFn());
      const yday = addDays(today, -1);
      const daily = dailyGrowth(await store.listSubscriberStats(), clean, { today, days: 8 });
      const y = daily.find(d => d.day === yday) || null;
      const week = sumDays(daily.filter(d => d.day < today));
      res.json({ ok: true, saved: clean.length, yesterday: y, last_7_days: week });
    } catch (err) {
      console.error('[growth] saving ad spend failed:', err.message);
      res.status(503).json({ ok: false, error: 'store-failed', message: err.message });
    }
  });

  // The list cleanup dry run (cleanupDryRun): counts only, no addresses, and
  // nothing is changed. Also under /api/hq/admin/ so HQ can compare towns.
  app.get(adminOrHq ? hqPaths('/api/admin/growth/cleanup') : '/api/admin/growth/cleanup', adminOrHq || requireAdmin, async (req, res) => {
    if (typeof store.listSubscriberStats !== 'function' || typeof store.listEmailOpens !== 'function') return res.json({ ok: false, error: 'not-supported' });
    try {
      const sends = typeof store.listNewsletterSends === 'function' ? await store.listNewsletterSends(CLEANUP_SENDS) : [];
      const keys = sends.map(s => s.week_key);
      const [subs, openRows] = await Promise.all([store.listSubscriberStats(), keys.length ? store.listEmailOpens(keys) : []]);
      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, dry_run: true, ...cleanupDryRun(subs, sends, openRows, { now: nowFn() }) });
    } catch (err) {
      console.error('[growth] cleanup dry run failed:', err.message);
      res.status(500).json({ ok: false, error: 'cleanup-failed', message: err.message });
    }
  });

  app.get(adminOrHq ? hqPaths('/api/admin/growth') : '/api/admin/growth', adminOrHq || requireAdmin, async (req, res) => {
    if (typeof store.listSubscriberStats !== 'function') return res.json({ ok: false, error: 'not-supported' });
    const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    try {
      const now = nowFn();
      const today = localDateStr(now);
      // ?goals=1 (Home's goal bars): just subscribers and orders.
      if (req.query.goals === '1') {
        const [subs, orders] = await Promise.all([store.listSubscriberStats(), getOrders().catch(() => [])]);
        res.set('Cache-Control', 'no-store');
        return res.json({ ok: true, today, goals: goals(subs, dailyGrowth(subs, [], { today, days: 15 }), monthRevenue(orders, today), today) });
      }
      const sends = typeof store.listNewsletterSends === 'function' ? await store.listNewsletterSends(16).catch(() => []) : [];
      // Enough history for the 14-day pace and every listed issue's week.
      const oldestSend = sends.map(s => dayOf(s.sent_at)).filter(Boolean).sort()[0];
      const since = [addDays(today, -(Math.max(days, 15) - 1)), oldestSend].filter(Boolean).sort()[0];
      const [subs, spend, rows, events, orders] = await Promise.all([
        store.listSubscriberStats(),
        typeof store.listAdSpend === 'function' ? store.listAdSpend(since).catch(() => []) : [],
        typeof store.listTraffic === 'function' ? store.listTraffic(since).catch(() => []) : [],
        getEvents().catch(() => []),
        getOrders().catch(() => [])
      ]);
      const span = Math.max(days, 15);
      const weekKeys = sends.map(s => s.week_key);
      const [opens, openRows] = weekKeys.length && typeof store.listEmailOpens === 'function'
        ? await Promise.all([store.countEmailOpens(weekKeys).catch(() => ({})), store.listEmailOpens(weekKeys).catch(() => [])])
        : [{}, []];
      const all = dailyGrowth(subs, spend, { today, days: span });
      const daily = all.slice(-days);
      const newest = sends.slice().sort((a, b) => (a.sent_at < b.sent_at ? 1 : -1));
      const lastTwo = newest.slice(0, 2).map(s => s.week_key);
      res.set('Cache-Control', 'no-store');
      res.json({
        ok: true, days, today,
        goals: goals(subs, all, monthRevenue(orders, today), today),
        totals: sumDays(daily),
        yesterday: all.find(d => d.day === addDays(today, -1)) || null,
        daily,
        pending: subs.filter(s => s.status === 'pending').length,
        spend_reported: spend.length > 0,
        issues: issueReport(sends, opens, subs, rows, events),
        signup_weeks: signupWeeks(subs, openRows, lastTwo, { today, lastSentAt: newest[0] ? new Date(newest[0].sent_at).toISOString() : null }),
        categories: categoryStats(rows, events, { start: addDays(today, -(days - 1)) })
      });
    } catch (err) {
      console.error('[growth] report failed:', err.message);
      res.status(500).json({ ok: false, error: 'growth-failed', message: err.message });
    }
  });
}
