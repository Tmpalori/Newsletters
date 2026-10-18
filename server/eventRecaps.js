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
 *     views ("3 views" helps nobody); that's recorded so it isn't
 *     checked again.
 * Numbers are the admin's Event stats (sponsors.js eventWeekStats): the
 * event's page from LEAD_IN_DAYS before its date through its date.
 */

import { town } from './town.js';
import { localDateStr, addDays } from './seo.js';
import { eventKeyOf } from './db.js';
import { eventWeekStats, sameEvent, LEAD_IN_DAYS } from './sponsors.js';
import { renderSubmissionRecap } from './notify.js';

export const MIN_VIEWS = 5;
const RECAP_CATCHUP_DAYS = 3;
const PAID = new Set(['paid', 'active', 'processing']);

const history = row => (Array.isArray(row.review_history) ? row.review_history : []);
const recapped = row => history(row).some(h => h && h.action === 'recap');
const agreed = row => history(row).some(h => h && h.action === 'submitted' && h.placement_emails === true);

export function createEventRecaps({ store, getEvents, mailer, slack = null, siteUrl, address = '', orders = async () => [], checkoutEnabled = false, log = console }) {
  async function run(now) {
    const today = localDateStr(now);
    const first = addDays(today, -RECAP_CATCHUP_DAYS);
    const rows = (await store.list({ status: 'approved', fromDate: first }))
      .filter(r => (r.source || 'submission') === 'submission' && r.submitter_email && agreed(r) && !recapped(r))
      .filter(r => { const d = String((r.payload || {}).date || ''); return d >= first && d < today; });
    if (!rows.length || typeof store.listTraffic !== 'function') return { ok: true, sent: 0 };

    const since = addDays(rows.map(r => r.payload.date).sort()[0], -LEAD_IN_DAYS);
    const [traffic, events, allOrders] = await Promise.all([store.listTraffic(since), getEvents(), orders()]);
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
      if (!stats || (stats.page_views || 0) < MIN_VIEWS) {
        await record({ note: `No recap: ${stats ? stats.page_views : 0} page views`, sent: false });
        continue;
      }
      const mail = renderSubmissionRecap({ ...row.payload, name: ev.name || row.payload.name, url: ev.url || row.payload.url }, stats,
        { siteUrl, address, upgrade: checkoutEnabled && !town.dormant });
      const result = await mailer.deliver(row.submitter_email, mail, `${town.keyPrefix}-submission-recap-${row.id}`);
      if (result === 'off' || result === 'failed') continue;
      await record({ note: result === 'sent' ? `Recap sent: ${stats.page_views} page views` : 'The address refused the recap', sent: result === 'sent' });
      if (result !== 'sent') continue;
      sent++;
      if (slack) {
        slack.notify({ channel: 'activity', title: `📈 Sent ${String(ev.name || 'an organizer').slice(0, 80)}'s organizer their recap`,
          fields: [['Page views', stats.page_views], ['Link clicks', stats.link_people], ['Calendar adds', stats.calendar_adds], ['Shares', stats.shares]] });
      }
    }
    return { ok: true, sent };
  }
  return { run };
}
