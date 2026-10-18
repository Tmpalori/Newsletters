/* server/dropNotices.js — Tell a submitter when their event didn't make its day's list.
 *
 * Busy days show their best few events (server/scoring.js capDays); the
 * rest keep their own page but leave the day lists. Tristen (Oct 2026): an
 * approved free submission that ends up there should hear so, politely,
 * with the paid pick on offer while the day still has one.
 *
 * Daily (scheduler 'drop-notices', 9:30 AM town time), for approved public
 * submissions whose event is one or two days out: the list has mostly
 * settled by then (collects are Sunday and Wednesday), and there's still
 * time to buy and be featured. Each is told at most once, recorded in its
 * review history ('drop-notice'); an event back on its list gets nothing.
 *
 * Only submissions sent after the /submit form said we'd email about this
 * (review_history[0].placement_emails, set at submit time): earlier
 * submitters were promised their address was used only to tell them it
 * was live.
 */

import { town } from './town.js';
import { localDateStr, addDays, formatDay } from './seo.js';
import { eventKeyOf } from './db.js';
import { dayMax } from './scoring.js';
import { pickAvailability } from './sponsors.js';
import { renderSubmissionDropped } from './notify.js';

const DAYS_AHEAD = 2;

const told = row => (Array.isArray(row.review_history) ? row.review_history : []).some(h => h && h.action === 'drop-notice');
const agreed = row => (Array.isArray(row.review_history) ? row.review_history : []).some(h => h && h.action === 'submitted' && h.placement_emails === true);

export function createDropNotices({ store, getPublicPayload, mailer, slack = null, siteUrl, address = '', orders = async () => [], checkoutEnabled = false, log = console }) {
  async function run(now) {
    const today = localDateStr(now);
    const last = addDays(today, DAYS_AHEAD);
    const rows = (await store.list({ status: 'approved', fromDate: addDays(today, 1) }))
      .filter(r => (r.source || 'submission') === 'submission' && r.submitter_email && agreed(r) && !told(r))
      .filter(r => { const d = String((r.payload || {}).date || ''); return d > today && d <= last; });
    if (!rows.length) return { ok: true, sent: 0 };

    const events = (await getPublicPayload()).events || [];
    const perDay = new Map();
    for (const e of events) perDay.set(e.date, (perDay.get(e.date) || 0) + 1);
    let allOrders = null;
    let sent = 0;
    for (const row of rows) {
      const live = events.find(e => eventKeyOf(e) === eventKeyOf(row.payload || {}));
      // Not on the site (unpublished since), or on its day's list: nothing to say.
      if (!live || !live.overflow) continue;
      let offer = null;
      if (checkoutEnabled && !town.dormant) {
        if (!allOrders) allOrders = await orders();
        const avail = pickAvailability(live.date, allOrders, now);
        if (avail.left > 0) offer = { price: avail.price, url: `${siteUrl}/advertise/checkout?package=featured&from=${encodeURIComponent(row.id)}` };
      }
      const mail = renderSubmissionDropped({ ...row.payload, name: live.name || (row.payload || {}).name }, {
        siteUrl, address, pageUrl: live.page ? `${siteUrl}${live.page}` : '',
        dayCount: perDay.get(live.date) || 0, dayMax: dayMax(live.date), offer, at: now
      });
      const result = await mailer.deliver(row.submitter_email, mail, `${town.keyPrefix}-submission-dropped-${row.id}`);
      // Email off: nothing went out, so nothing to record. A failure is
      // tried again tomorrow while the event is still ahead.
      if (result === 'off' || result === 'failed') continue;
      const history = [...(Array.isArray(row.review_history) ? row.review_history : []),
        { at: now.toISOString(), action: 'drop-notice', note: result === 'sent' ? `Told the submitter it didn't make its day's list${offer ? ', with the upgrade offer' : ' (no paid spot left that day)'}` : 'The address refused the email', offer: Boolean(offer) }];
      try {
        await store.update(row.id, { review_history: history });
      } catch (err) {
        log.warn('[drop-notices] not recorded:', err.message);
      }
      if (result !== 'sent') continue;
      sent++;
      if (slack) {
        const day = formatDay(live.date, { weekday: 'long', month: 'short', day: 'numeric' });
        slack.notify({ channel: 'activity', title: `📭 Told ${String(live.name || 'a submitter').slice(0, 80)}'s organizer it didn't make ${day}'s list`,
          text: offer ? `The email offered the ${town.pickNamePlain} upgrade (${offer.price}).` : `No ${town.pickNamePlain} spot was left that day, so no offer.`,
          link: `${siteUrl}/admin.html`, linkLabel: 'Admin' });
      }
    }
    return { ok: true, sent };
  }
  return { run };
}
