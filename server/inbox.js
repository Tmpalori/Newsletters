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
  if (channel === 'alerts') {
    if (t.startsWith('✅')) return { severity: 'fyi', kind: 'recovered' };
    // A workflow's warning (a collector source failed, the run went on).
    if (/^⚠️/u.test(t)) return { severity: 'today', kind: 'warning' };
    return { severity: 'urgent', kind: 'alert' };
  }
  if (channel === 'sales') {
    if (/^(📊|✅)/u.test(t)) return { severity: 'fyi', kind: 'sales' };
    if (/^👋/u.test(t)) return { severity: 'today', kind: 'sales' };
    // ⏰: a paid Pick still not on the site (paid for, not delivered).
    if (/^(⚠️|↩️|🚨|⏰)/u.test(t) || /fraud|disput|refund|declined|didn.t go through/i.test(t)) return { severity: 'urgent', kind: 'money' };
    return { severity: 'today', kind: 'sales' };
  }
  if (channel === 'inbox') {
    if (/^↩️/u.test(t)) return { severity: 'fyi', kind: 'reply' };
    // A public event submission: the AI review handles it, so fyi.
    if (/^📝/u.test(t)) return { severity: 'fyi', kind: 'submission' };
    if (SALESY.test(t)) return { severity: 'urgent', kind: 'lead' };
    if (/^📬|^💰|email from/i.test(t)) return { severity: 'today', kind: 'email' };
    return { severity: 'today', kind: 'message' };
  }
  if (channel === 'hype') return /sponsor|pick/i.test(t) && !/subscriber/i.test(t) ? { severity: 'today', kind: 'sponsor' } : { severity: 'fyi', kind: 'growth' };
  // activity
  // A submitter who wasn't told their event is live needs reaching too.
  if (/for you to look at|^⚠️|^⏰|^✉️ “You’re live” email refused/u.test(t)) return { severity: 'today', kind: 'review' };
  if (/submitted/i.test(t)) return { severity: 'fyi', kind: 'submission' };
  if (/^✉️ Website message/u.test(t)) return { severity: SALESY.test(t) ? 'urgent' : 'today', kind: SALESY.test(t) ? 'lead' : 'message' };
  return { severity: 'fyi', kind: 'activity' };
}

// Pings that couldn't be saved yet (no store during boot, the database
// down) wait here, newest kept, and go in with the next save or flush().
const PENDING_MAX = 200;

// `store`: the store, or a function returning it (the app creates its
// store after its Slack notifier).
export function withInbox(slack, store, { nowFn = () => Date.now() } = {}) {
  if (!slack || !store) return slack;
  const storeNow = () => (typeof store === 'function' ? store() : store);
  const lastAlert = new Map();
  let pending = [];
  let flushing = null;
  const add = (s, ev) => Promise.resolve().then(() => s.addInboxEvent(ev));
  // Saves what's waiting, oldest first; stops at the first failure.
  function flush() {
    if (flushing) return flushing;
    const s = storeNow();
    if (!pending.length || !s || typeof s.addInboxEvent !== 'function') return Promise.resolve(false);
    flushing = (async () => {
      while (pending.length) {
        try { await add(s, pending[0]); } catch (err) { console.warn('[inbox] still not saved:', err.message); return false; }
        pending.shift();
      }
      return true;
    })().finally(() => { flushing = null; });
    return flushing;
  }
  // `more`: the long part (a full list, a log tail) kept for HQ only, so
  // Slack stays a few short lines (Tristen, Oct 2026: no word bombs; he
  // looks closer in HQ).
  const save = (channel, { title, fields = [], text = '', more = '', link = null }) => {
    const { severity, kind } = classify({ channel, title });
    const payload = {
      fields: (fields || []).filter(([, v]) => v != null && v !== '').slice(0, 12).map(([k, v]) => [String(k), String(v).slice(0, 1000)]),
      text: [text, more].filter(Boolean).join('\n\n').slice(0, 4000), link: link || null
    };
    const ev = { channel, severity, kind, title: String(title).slice(0, 300), payload };
    const s = storeNow();
    const keep = err => {
      if (err) console.warn('[inbox] not saved, will retry:', err.message);
      pending.push(ev);
      if (pending.length > PENDING_MAX) pending = pending.slice(-PENDING_MAX);
    };
    if (!s || typeof s.addInboxEvent !== 'function') { keep(); return Promise.resolve(false); }
    return flush().then(() => (pending.length ? keep() : add(s, ev).then(() => true, err => { keep(err); return false; })))
      .catch(err => { console.warn('[inbox] not saved:', err.message); return false; });
  };
  return {
    ...slack,
    notify(msg = {}) {
      save(msg.channel || 'activity', msg);
      return slack.notify(msg.more ? { ...msg, footer: [msg.footer, 'More in HQ'].filter(Boolean).join(' · ') } : msg);
    },
    // Same window as Slack's own de-duplication, so a crash loop is one item.
    // Resolves once both the save and the Slack post are done, so a caller
    // about to exit (a crash) can wait for it.
    alert(key, title, detail = '', link = null, more = '') {
      const now = nowFn(), last = lastAlert.get(key);
      let saved = Promise.resolve(false);
      if (last === undefined || now - last >= ALERT_WINDOW_MS) {
        lastAlert.set(key, now);
        saved = save('alerts', { title: `🚨 ${title}`, text: detail, more, link });
      }
      const posted = slack.alert(key, title, more ? [detail, 'More in HQ.'].filter(Boolean).join('\n') : detail, link);
      return Promise.all([saved, posted]).then(([, r]) => r);
    },
    // Into the inbox only (something already posted to Slack elsewhere,
    // e.g. a GitHub workflow's own alert).
    record(channel, msg) { return save(channel, msg); },
    flushInbox: flush,
    pendingInbox: () => pending.length
  };
}
