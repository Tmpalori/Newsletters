/* server/hq.js — one town's numbers for the HQ dashboard (MULTI_CITY_PLAN.md 4.1).
 *
 * GET /api/hq/summary, for a separate HQ service that shows every town on
 * one screen. Off unless HQ_API_KEY is set: until then the route doesn't
 * exist (the site's own 404). With it, only `Authorization: Bearer
 * <HQ_API_KEY>` gets in; an admin session never does, and the key opens no
 * admin route (requireAdmin doesn't know it). Read-only, counts and dates
 * only: no names, emails or addresses. GET /api/hq/inbox (same key) is the
 * exception: the owner's own messages, for HQ to pass on (server/inbox.js);
 * so is GET /api/hq/subscribers (new signups' emails), and POST /api/hq/hype
 * posts HQ's combined subscriber ping to #hype. Rate limited and cached 60 s, so a
 * busy HQ can't load the database.
 */

import crypto from 'node:crypto';
import { dailyGrowth, sumDays, issueReport, monthRevenue, goals } from './growth.js';
import { localDateStr, addDays, currentWeek } from './seo.js';

const CACHE_MS = 60 * 1000;
// A summary with failed parts (database down, say) is kept only briefly:
// HQ should see the town come back within seconds, not a minute of zeros.
const FAILED_CACHE_MS = 5 * 1000;
const KEPT = new Set(['paid', 'processing', 'active', 'hidden']);

// The next four sponsor weeks (from next Monday) booked or open, and picks
// paid this month. Test orders don't count.
export function sponsorCounts(orders, today) {
  const live = (orders || []).filter(o => o && !o.test && KEPT.has(o.status));
  const nextMonday = addDays(currentWeek(today)[0], 7);
  const weeks = [0, 1, 2, 3].map(i => addDays(nextMonday, i * 7));
  const booked = weeks.filter(w => live.some(o => o.kind === 'weekly' && o.week_start === w)).length;
  const month = today.slice(0, 7);
  return {
    weeks: weeks.map(w => ({ week_start: w, booked: live.some(o => o.kind === 'weekly' && o.week_start === w) })),
    weeks_booked_next_4: booked,
    weeks_open_next_4: weeks.length - booked,
    picks_sold_this_month: live.filter(o => o.kind === 'featured' && String(o.paid_at || '').slice(0, 7) === month).length
  };
}

export function keyOk(header, key) {
  const m = /^Bearer (.+)$/.exec(String(header || ''));
  if (!m || !key) return false;
  const a = crypto.createHash('sha256').update(m[1]).digest();
  const b = crypto.createHash('sha256').update(key).digest();
  return crypto.timingSafeEqual(a, b);
}

// The summary from what the town's store and server already know. Every
// part is best effort: a piece that fails reads null instead of failing all,
// and is named in `failed` (only present when something failed), so HQ
// shows "database down" rather than a green row of zeros (0 subscribers,
// $0) that would also drop the town out of the network totals.
export async function buildSummary({ store, nowFn, town, siteUrl, commit, getEvents, getOrders, setup, health, getJobs = null, getNewsletterRuns = null }) {
  const now = nowFn();
  const today = localDateStr(now);
  const failed = [];
  const safe = async (fn, dflt = null, part = null) => {
    try { return await fn(); } catch (err) {
      // HQ only shows "<part> unavailable"; the reason goes to the town's log.
      console.warn(`[hq] summary part ${part || 'extra'} failed:`, (err && err.message) || err);
      if (part && !failed.includes(part)) failed.push(part);
      return dflt;
    }
  };
  const subs = await safe(() => store.listSubscriberStats(), [], 'subscribers');
  const orders = await safe(getOrders, [], 'revenue');
  const spend = typeof store.listAdSpend === 'function' ? await safe(() => store.listAdSpend(addDays(today, -31)), [], 'ads') : [];
  const daily = dailyGrowth(subs, spend, { today, days: 31 });
  const done = daily.filter(d => d.day < today);
  const month30 = sumDays(done.slice(-30));
  const active = subs.filter(x => x.status === 'active').length;
  const sends = await safe(() => store.listNewsletterSends(4), [], 'issues');
  const weekKeys = sends.map(s => s.week_key);
  const opens = weekKeys.length ? await safe(() => store.countEmailOpens(weekKeys), {}, 'issues') : {};
  // Postgres returns sent_at as a Date (String() of one reads "Fri Oct 09
  // ..."), the file store as an ISO string: both to the town's YYYY-MM-DD.
  const dayOf = v => { const d = v ? new Date(v) : null; return d && !Number.isNaN(d.getTime()) ? localDateStr(d) : null; };
  const oldest = sends.map(s => dayOf(s.sent_at)).filter(Boolean).sort()[0] || today;
  const rows = await safe(() => store.listTraffic(oldest), [], 'issues');
  const events = await safe(getEvents, [], 'events');
  const lastMonthDay = addDays(today.slice(0, 7) + '-01', -1);
  const byStatus = {};
  for (const o of orders) if (o && !o.test) byStatus[o.status] = (byStatus[o.status] || 0) + 1;
  const s = await safe(setup, { checks: [], status: {} }, 'setup');
  const h = await safe(health, null, 'health');
  // Jobs on Railway only (server/jobs.js): each job's last run and the
  // worker's last check-in, so HQ and the owner's assistant see them.
  const jobsOut = getJobs ? await safe(getJobs, null, 'jobs') : null;
  // Each issue's latest scheduled slot: sent (and to how many) or why not,
  // since a slot that ran isn't always an issue that went out.
  const runsOut = getNewsletterRuns ? await safe(getNewsletterRuns, null, 'newsletter_runs') : null;
  // A configured database that doesn't answer its ping fails the store's
  // reads too (and setupReport swallows those): say so.
  if (h && h.database === false && h.database_configured && !failed.includes('database')) failed.push('database');
  const bad = part => failed.includes(part);
  const healthOut = h && typeof h === 'object' ? (({ database_configured: _c, ...rest }) => rest)(h) : h;
  const missing = level => s.checks.filter(c => c.level === level && c.ok === false).map(c => c.key);
  // Active subscribers at the end of each day, worked back from today's count.
  let after = 0;
  const history = [];
  for (let i = daily.length - 1; i >= 0; i--) {
    history.unshift({ day: daily[i].day, active: active - after, joined: daily[i].joined, left: daily[i].unsubscribed });
    after += daily[i].net;
  }
  // The last six months' revenue, oldest first (this month so far last).
  const months = [];
  for (let m = today.slice(0, 7) + '-01', i = 0; i < 6; i++, m = addDays(m, -1).slice(0, 7) + '-01') {
    const r = monthRevenue(orders, m);
    months.unshift({ month: r.month, cents: r.cents });
  }
  return {
    ok: true,
    generated_at: now.toISOString(),
    ...(failed.length ? { failed } : {}),
    town: { id: town.id, name: town.siteName, site_url: siteUrl, admin_url: `${siteUrl}/admin.html`, commit: commit || null },
    subscribers: bad('subscribers') ? null : {
      active,
      pending: subs.filter(x => x.status === 'pending').length,
      net_7_days: sumDays(done.slice(-7)).net,
      net_30_days: month30.net,
      joined_30_days: month30.joined,
      left_30_days: month30.unsubscribed,
      sources_30_days: month30.by_source,
      daily: history,
      goals: goals(subs, daily, monthRevenue(orders, today), today)
    },
    issues: bad('issues') ? null : issueReport(sends, opens, subs, rows, events).slice(0, 4)
      .map(i => ({ week: i.week, edition: i.edition, sent_at: i.sent_at, sent: i.sent, opens: i.opens, open_rate: i.open_rate,
        clickers: i.clickers, click_rate: i.click_rate })),
    revenue: bad('revenue') ? null : {
      month_to_date: monthRevenue(orders, today),
      last_month: monthRevenue(orders, lastMonthDay),
      orders_by_status: byStatus,
      live_orders: orders.filter(o => o && !o.test && KEPT.has(o.status)).length,
      months
    },
    ads: bad('ads') || bad('subscribers') ? null : { spend_30_days: month30.spend, cost_per_sub_30_days: month30.cost_per_sub },
    sponsors: bad('revenue') ? null : sponsorCounts(orders, today),
    submissions_waiting: s.status.pending_submissions ?? null,
    events: bad('setup') ? null : { upcoming: s.status.upcoming_events ?? null, last_collect: s.status.collected_at ?? null, published_at: s.status.published_at ?? null },
    health: healthOut,
    setup: bad('setup') ? null : { required_missing: missing('required'), recommended_missing: missing('recommended') },
    ...(getJobs ? { jobs: jobsOut } : {}),
    ...(getNewsletterRuns ? { newsletter_runs: runsOut } : {})
  };
}

// The jobs part of the summary (from jobs.stats()): per job, its last run
// (status, when, how long, and a collect's counts and warnings), what's
// queued and running, failures in the last day, and when the worker last
// asked for work (worker_since: this process's start, so HQ can tell a
// worker silent since a redeploy). No personal data: counts, source names
// and the collector's own warnings.
export function jobsSummary(st) {
  const last = {};
  for (const [kind, j] of Object.entries((st && st.last) || {})) {
    const r = j.result || {};
    last[kind] = {
      status: j.status, finished_at: j.finished_at, seconds: Number.isFinite(r.seconds) ? r.seconds : null,
      ...(kind === 'collect' ? { upcoming: r.upcoming ?? null, events: r.events ?? null, warnings: r.warnings || '', sources: r.sources || {} } : {}),
      ...(j.status === 'failed' ? { error: String(r.error || '').slice(0, 300) } : {})
    };
  }
  return {
    worker_last_seen: st.worker_last_seen || null,
    worker_since: st.worker_since || null,
    queued: st.queued || 0,
    running: st.running || [],
    failed_24h: st.failed_24h || 0,
    last
  };
}

// Slack blocks for HQ's combined subscriber ping (POST /api/hq/hype): a
// header, one section per newsletter (name, its total, the new emails), and
// the total across all of them. Everything from HQ is escaped.
export function hypeBlocks({ count, groups, allTotal = null }, escape) {
  const n = v => (Number.isFinite(Number(v)) ? Number(v).toLocaleString('en-US') : '—');
  const title = `📬 ${count} new subscriber${count === 1 ? '' : 's'}`;
  const blocks = [{ type: 'header', text: { type: 'plain_text', text: title } }];
  for (const g of groups) {
    const emails = g.emails.slice(0, 50).map(e => escape(String(e).slice(0, 254)));
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${escape(String(g.name).slice(0, 80))}* · ${n(g.total)} total\n${emails.join('\n')}`.slice(0, 2900) } });
  }
  if (allTotal != null) {
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `All newsletters: ${n(allTotal)} subscribers` }] });
  }
  return { title, blocks };
}

export function registerHq(app, { key = '', limiter, nowFn = () => new Date(), build, inbox = null, latestInbox = null, subscribers = null, hype = null, clientKey = req => req.ip }) {
  const allowed = (req, res) => {
    if (!limiter.check(`hq:${clientKey(req)}`).ok) { res.status(429).json({ ok: false, error: 'rate-limited' }); return false; }
    if (!keyOk(req.get('authorization'), key)) { res.status(401).json({ ok: false, error: 'unauthorized' }); return false; }
    res.set('Cache-Control', 'no-store');
    return true;
  };
  // New subscribers for HQ's combined Slack ping (tristen-hq src/subpings.js):
  // active signups confirmed after `after` (an ISO time), oldest first, with
  // the active total. Without `after`, none: just `latest`, the newest
  // confirmed time, so HQ starts from now. Emails, like the inbox.
  if (subscribers) app.get('/api/hq/subscribers', async (req, res, next) => {
    if (!key) return next();
    if (!allowed(req, res)) return;
    const raw = String(req.query.after || '');
    const after = raw && !Number.isNaN(Date.parse(raw)) && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(raw) ? raw : null;
    if (raw && !after) return res.status(400).json({ ok: false, error: 'bad-after' });
    try {
      res.json({ ok: true, ...(await subscribers(after)) });
    } catch (err) {
      console.error('[hq] subscribers failed:', err.message);
      res.status(500).json({ ok: false, error: 'subscribers-failed' });
    }
  });
  // HQ's combined subscriber ping, posted to this town's #hype webhook
  // (every town shares it; HQ has none of its own). HQ sends the data, the
  // town lays it out and escapes it: { count, groups: [{ name, total,
  // emails }], all_total }.
  if (hype) app.post('/api/hq/hype', async (req, res, next) => {
    if (!key) return next();
    if (!allowed(req, res)) return;
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const groups = Array.isArray(b.groups) ? b.groups.slice(0, 12).filter(g => g && typeof g.name === 'string' && Array.isArray(g.emails)) : [];
    const count = Number(b.count);
    if (!groups.length || !Number.isInteger(count) || count < 1) return res.status(400).json({ ok: false, error: 'bad-message' });
    try {
      const posted = await hype({ count, groups, allTotal: Number.isFinite(Number(b.all_total)) ? Number(b.all_total) : null });
      res.status(posted ? 200 : 502).json({ ok: Boolean(posted) });
    } catch (err) {
      console.error('[hq] hype failed:', err.message);
      res.status(500).json({ ok: false, error: 'hype-failed' });
    }
  });
  // The owner inbox (server/inbox.js): what pinged the owner since `since`
  // (an event id), oldest first, at most 200. Unlike the summary this has
  // people's names, emails and messages: it's for HQ to tell the owner.
  if (inbox) app.get('/api/hq/inbox', async (req, res, next) => {
    if (!key) return next();
    if (!allowed(req, res)) return;
    const since = /^\d{1,15}$/.test(String(req.query.since || '')) ? Number(req.query.since) : 0;
    try {
      const events = await inbox(since, 200);
      // latest: the newest id there is; below HQ's cursor means the
      // database was reset and HQ starts over.
      const latest = latestInbox ? await latestInbox() : null;
      res.json({ ok: true, since, next: events.length ? events[events.length - 1].id : since, more: events.length === 200,
        ...(latest == null ? {} : { latest }), events });
    } catch (err) {
      console.error('[hq] inbox failed:', err.message);
      res.status(500).json({ ok: false, error: 'inbox-failed' });
    }
  });
  let cache = null;
  app.get('/api/hq/summary', async (req, res, next) => {
    if (!key) return next();
    if (!allowed(req, res)) return;
    const t = nowFn().getTime();
    if (cache && t - cache.at < (cache.body.failed ? FAILED_CACHE_MS : CACHE_MS)) return res.json(cache.body);
    try {
      const body = await build();
      cache = { at: t, body };
      res.json(body);
    } catch (err) {
      console.error('[hq] summary failed:', err.message);
      res.status(500).json({ ok: false, error: 'summary-failed' });
    }
  });
}
