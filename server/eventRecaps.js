/* server/eventRecaps.js — A free submitter's "how your event did" email.
 *
 * Paid picks get a report the day after their event (sponsors.js
 * sendPickReports); Tristen (Oct 2026) wanted free submitters to hear how
 * theirs did too, with the same rules as the dropped-event notice
 * (server/dropNotices.js):
 *   - approved public submissions sent after the /submit form said we'd
 *     email about the event (review_history[0].placement_emails), with an
 *     email address;
 *   - once each (a 'recap' history entry), the morning after the event
 *     (scheduler 'event-recaps'), catching up for RECAP_CATCHUP_DAYS;
 *   - none when a paid pick was bought for the same event (its buyer gets
 *     the pick report), and none when its page had fewer than MIN_VIEWS
 *     views ("3 views" helps nobody) and it was seen in a list fewer than
 *     MIN_SHOWN times; that's recorded so it isn't checked again.
 * Numbers are the admin's Event stats (sponsors.js eventWeekStats): the
 * event's page from LEAD_IN_DAYS before its date through its date, and how
 * often it was seen in a list (data-seen, counted like a paid pick's
 * impressions: half of it on screen for a second). Tristen (Oct 2026): most
 * people see a free event in the list and never open it, so the page views
 * alone undersold it and kept most organizers from getting the email. On
 * top, everywhere it was put in front of people (server/eventReach.js): the
 * day lists it made (checked on its day, a 'listed' history entry; shown
 * only when it has no sightings, i.e. events from before they were
 * counted), the newsletter issues and social posts that showed it, and
 * visits from them; and, with the upgrade line, how paid picks did against
 * other events.
 */

import { town } from './town.js';
import { localDateStr, addDays } from './seo.js';
import { eventKeyOf } from './db.js';
import { currentWeek } from './seo.js';
import { eventWeekStats, sameEvent } from './sponsors.js';
import { listViews, newsletterReach, socialPosts, visitsFrom, pickLift, typicalPickShown, REACH_DAYS } from './eventReach.js';
import { renderSubmissionRecap } from './notify.js';

export const MIN_VIEWS = 5;
// Seen in lists this often is worth an email even with few page views. Above
// the 20 sightings a day one address can send (/api/track), so a single
// reader can't trip it alone.
export const MIN_SHOWN = 25;
const RECAP_CATCHUP_DAYS = 3;
// Paid picks against other events over the last month (the upgrade line).
const LIFT_DAYS = 30;
const PAID = new Set(['paid', 'active', 'processing']);

const history = row => (Array.isArray(row.review_history) ? row.review_history : []);
const recapped = row => history(row).some(h => h && h.action === 'recap');
const agreed = row => history(row).some(h => h && h.action === 'submitted' && h.placement_emails === true);
// Whether it made its day's list, as checked on its day (null: not checked).
const onList = row => { const h = history(row).find(x => x && x.action === 'listed'); return h ? h.on_list === true : null; };

export function createEventRecaps({ store, getEvents, mailer, slack = null, siteUrl, address = '', orders = async () => [], checkoutEnabled = false, log = console }) {
  // On its day: whether it's on the day's list (overflow), recorded once,
  // since the past events kept afterwards don't say.
  async function noteListed(rows, events, now) {
    for (const row of rows) {
      const ev = (events || []).find(e => e && e.page && eventKeyOf(e) === eventKeyOf(row.payload || {}));
      if (!ev) continue;
      try {
        await store.update(row.id, { review_history: [...history(row), { at: now.toISOString(), action: 'listed', on_list: !ev.overflow,
          note: ev.overflow ? "Not on its day's list" : "On its day's list" }] });
      } catch (err) { log.warn('[event-recaps] list check not recorded:', err.message); }
    }
  }

  async function reachOf(ev, row, traffic) {
    const week = currentWeek(ev.date);
    const [mon, thu, posted] = await Promise.all([
      store.getNewsletterSend ? store.getNewsletterSend(week[0]).catch(() => null) : null,
      store.getNewsletterSend ? store.getNewsletterSend(week[3]).catch(() => null) : null,
      store.getTownFile ? store.getTownFile('social_posted').catch(() => null) : null
    ]);
    const nl = newsletterReach([mon, thu], ev.page);
    const social = socialPosts(posted && posted.data, ev.page, ev.date);
    const from = visitsFrom(traffic, ev.page, ev.date);
    return {
      list_views: onList(row) ? listViews(traffic, ev.date) : 0,
      newsletter_issues: nl.issues.map(i => i.day), newsletter_recipients: nl.recipients,
      social_posts: social.posts, social_platforms: social.platforms,
      newsletter_visits: from.newsletter, social_visits: from.social
    };
  }

  async function run(now) {
    const today = localDateStr(now);
    const first = addDays(today, -RECAP_CATCHUP_DAYS);
    const mine = (await store.list({ status: 'approved', fromDate: first }))
      .filter(r => (r.source || 'submission') === 'submission' && r.submitter_email && agreed(r));
    const todays = mine.filter(r => (r.payload || {}).date === today && onList(r) === null);
    const rows = mine.filter(r => !recapped(r))
      .filter(r => { const d = String((r.payload || {}).date || ''); return d >= first && d < today; });
    if (todays.length) await noteListed(todays, await getEvents(), now);
    if (!rows.length || typeof store.listTraffic !== 'function') return { ok: true, sent: 0 };

    const upgrade = checkoutEnabled && !town.dormant;
    const earliest = rows.map(r => r.payload.date).sort()[0];
    const liftFrom = addDays(today, -LIFT_DAYS);
    const since = addDays(upgrade && liftFrom < earliest ? liftFrom : earliest, -REACH_DAYS);
    const [traffic, events, allOrders] = await Promise.all([store.listTraffic(since), getEvents(), orders()]);
    let lift;
    const liftNow = () => {
      if (lift !== undefined) return lift;
      const paid = (allOrders || []).filter(o => o && o.kind === 'featured' && PAID.has(o.status) && o.event);
      const past = (events || []).filter(e => e && e.page && e.date >= liftFrom && e.date < today);
      const pages = past.filter(e => paid.some(o => sameEvent(e, o.event))).map(e => e.page);
      lift = pickLift(traffic, past, pages, { from: liftFrom, to: addDays(today, -1) });
      return lift;
    };
    let pickShown;
    const pickShownNow = () => {
      if (pickShown === undefined) pickShown = typicalPickShown(traffic, allOrders, { from: liftFrom, to: addDays(today, -1) });
      return pickShown;
    };
    let sent = 0;
    for (const row of rows) {
      const record = async (entry) => {
        try {
          await store.update(row.id, { review_history: [...history(row), { at: now.toISOString(), action: 'recap', ...entry }] });
        } catch (err) { log.warn('[event-recaps] not recorded:', err.message); }
      };
      // A paid pick for the same event: its buyer gets the pick report.
      if ((allOrders || []).some(o => o && o.kind === 'featured' && PAID.has(o.status) && o.event && sameEvent(row.payload, o.event))) {
        await record({ note: 'No recap: a paid pick was bought for it', sent: false });
        continue;
      }
      const ev = (events || []).find(e => e && e.page && eventKeyOf(e) === eventKeyOf(row.payload || {}));
      // Not found (renamed or removed since): try again tomorrow while the
      // catch-up window lasts; nothing to report otherwise.
      if (!ev) continue;
      const [stats] = eventWeekStats(traffic, [ev], { start: ev.date, end: ev.date });
      const views = stats ? stats.page_views || 0 : 0, shown = stats ? stats.shown || 0 : 0;
      const counted = `${views} page views, seen ${shown} times in lists`;
      if (views < MIN_VIEWS && shown < MIN_SHOWN) {
        await record({ note: `No recap: ${counted}`, sent: false });
        continue;
      }
      const reach = await reachOf(ev, row, traffic);
      const mail = renderSubmissionRecap({ ...row.payload, name: ev.name || row.payload.name, url: ev.url || row.payload.url }, { ...stats, ...reach },
        { siteUrl, address, upgrade, pickLift: upgrade ? liftNow() : null, pickShown: upgrade ? pickShownNow() : null });
      const result = await mailer.deliver(row.submitter_email, mail, `${town.keyPrefix}-submission-recap-${row.id}`);
      if (result === 'off' || result === 'failed') continue;
      await record({ note: result === 'sent' ? `Recap sent: ${counted}` : 'The address refused the recap', sent: result === 'sent' });
      if (result !== 'sent') continue;
      sent++;
      if (slack) {
        slack.notify({ channel: 'activity', title: `📈 Sent ${String(ev.name || 'an organizer').slice(0, 80)}'s organizer their recap`,
          fields: [['Seen in lists', shown], ['Page views', stats.page_views], ['List views', reach.list_views], ['Newsletter copies', reach.newsletter_recipients],
            ['Social posts', reach.social_posts], ['Link clicks', stats.link_people], ['Calendar adds', stats.calendar_adds], ['Shares', stats.shares]] });
      }
    }
    return { ok: true, sent };
  }
  return { run };
}
