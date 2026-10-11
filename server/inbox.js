/* server/inbox.js — the owner inbox: every Slack ping, kept for HQ.
 *
 * withInbox(slack, store) wraps the Slack notifier so each notify() and
 * alert() is also saved (store.addInboxEvent) with a severity, whether or
 * not Slack is set up. HQ (tmpalori/tristen-hq) reads them through
 * GET /api/hq/inbox?since=<id> (server/hq.js) and tells the owner, through
 * his assistant, about anything that needs him:
 *   urgent  money trouble (payment failed, dispute, refund, fraud), the site
 *           broken, or someone asking about sponsoring or advertising
 *   today   people writing in, new sponsors, submissions waiting on him
 *   fyi     everything else (reports sent, our replies, subscriber counts)
 * Saving never blocks or breaks the ping: it's fire-and-forget.
 */

const ALERT_WINDOW_MS = 15 * 60 * 1000;
const SALESY = /💰|sponsor|advertis|partner/i;

export function classify({ channel = 'activity', title = '' }) {
  const t = String(title);
  if (channel === 'alerts') return t.startsWith('✅') ? { severity: 'fyi', kind: 'recovered' } : { severity: 'urgent', kind: 'alert' };
  if (channel === 'sales') {
    if (/^(📊|✅)/u.test(t)) return { severity: 'fyi', kind: 'sales' };
    if (/^👋/u.test(t)) return { severity: 'today', kind: 'sales' };
    if (/^(⚠️|↩️|🚨)/u.test(t) || /fraud|disput|refund|declined|didn.t go through/i.test(t)) return { severity: 'urgent', kind: 'money' };
    return { severity: 'today', kind: 'sales' };
  }
  if (channel === 'inbox') {
    if (/^↩️/u.test(t)) return { severity: 'fyi', kind: 'reply' };
    if (SALESY.test(t)) return { severity: 'urgent', kind: 'lead' };
    if (/^📬|^💰|email from/i.test(t)) return { severity: 'today', kind: 'email' };
    return { severity: 'today', kind: 'message' };
  }
  if (channel === 'hype') return /sponsor|pick/i.test(t) && !/subscriber/i.test(t) ? { severity: 'today', kind: 'sponsor' } : { severity: 'fyi', kind: 'growth' };
  // activity
  if (/for you to look at|^⚠️|^⏰/u.test(t)) return { severity: 'today', kind: 'review' };
  if (/submitted/i.test(t)) return { severity: 'fyi', kind: 'submission' };
  if (/^✉️ Website message/u.test(t)) return { severity: SALESY.test(t) ? 'urgent' : 'today', kind: SALESY.test(t) ? 'lead' : 'message' };
  return { severity: 'fyi', kind: 'activity' };
}

// `store`: the store, or a function returning it (the app creates its
// store after its Slack notifier).
export function withInbox(slack, store, { nowFn = () => Date.now() } = {}) {
  if (!slack || !store) return slack;
  const storeNow = () => (typeof store === 'function' ? store() : store);
  const lastAlert = new Map();
  const save = (channel, { title, fields = [], text = '', link = null }) => {
    const { severity, kind } = classify({ channel, title });
    const payload = {
      fields: (fields || []).filter(([, v]) => v != null && v !== '').slice(0, 12).map(([k, v]) => [String(k), String(v).slice(0, 1000)]),
      text: String(text || '').slice(0, 4000), link: link || null
    };
    const s = storeNow();
    if (!s || typeof s.addInboxEvent !== 'function') return;
    Promise.resolve().then(() => s.addInboxEvent({ channel, severity, kind, title: String(title).slice(0, 300), payload }))
      .catch(err => console.warn('[inbox] not saved:', err.message));
  };
  return {
    ...slack,
    notify(msg = {}) {
      save(msg.channel || 'activity', msg);
      return slack.notify(msg);
    },
    // Same window as Slack's own de-duplication, so a crash loop is one item.
    alert(key, title, detail = '', link = null) {
      const now = nowFn(), last = lastAlert.get(key);
      if (last === undefined || now - last >= ALERT_WINDOW_MS) {
        lastAlert.set(key, now);
        save('alerts', { title: `🚨 ${title}`, text: detail, link });
      }
      return slack.alert(key, title, detail, link);
    }
  };
}
