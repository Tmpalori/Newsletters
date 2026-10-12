/* server/submissionReview.js — The AI review of free event submissions.
 *
 * scripts/review_submissions.py (.github/workflows/submission-review.yml,
 * every 15 minutes) reads the pending public submissions here, runs the
 * collector's rules and one OpenAI pass over them, and posts back one
 * decision per submission:
 *
 *   approve    tidied up and published right away (auto-publish, approved
 *              submissions only), and once it's on the site the submitter
 *              gets a "you're live" email; past dates are flagged instead
 *   flag       left pending for the admin, with the AI's reason in the notes
 *   reject     spam or a church/worship event (the site doesn't list those)
 *   duplicate  the exact event is already live
 *
 * The AI may only rewrite the name, description and icons. Date, time,
 * venue, address, link and the submitter's details always stay as sent.
 * Each submission is reviewed once (`ai_review` on the row); an admin edit
 * or decision always wins. SUBMISSION_AUTOAPPROVE=0 turns approvals into
 * flags.
 *
 * Paid Vic's Picks go through the same review, so a clean one goes live
 * without waiting for the owner, but the buyer's words are kept (they saw
 * a preview before paying), and nothing paid for is turned away
 * automatically: a reject becomes a flag, and an exact copy of a live
 * event is approved (the pin finds the listed one). A paid pick still
 * unpublished close to its date, or to the Monday newsletter that promised
 * to star it, is called out in Slack (remindPaidPicks). A pick whose order
 * was refunded or disputed is treated as a free submission again.
 *
 * An approval whose publish failed (or whose live check threw) is marked
 * `ai_review.live_pending` and retried on later runs (retryLive), so the
 * event still goes live and its "you're live" email still goes out.
 *
 * Safety: the shared secret (like the event check), pending rows only, at
 * most MAX_PER_RUN decisions per call.
 */

import { town } from './town.js';
import crypto from 'node:crypto';
import { validateSubmission } from './validate.js';
import { normalizePayload, eventKeyOf } from './db.js';
import { localDateStr, currentWeek } from './seo.js';
import { newsletterCovers, weekendCovers } from './notify.js';

export const MAX_PER_RUN = 20;
const DECISIONS = new Set(['approve', 'flag', 'reject', 'duplicate']);
const STATUS = { approve: 'approved', reject: 'rejected', duplicate: 'duplicate' };
const LABEL = { approve: 'Approved', flag: 'Flagged', reject: 'Rejected', duplicate: 'Duplicate' };

function secretOk(given, want) {
  const g = Buffer.from(String(given || ''));
  const w = Buffer.from(String(want || ''));
  return w.length > 0 && g.length === w.length && crypto.timingSafeEqual(g, w);
}

const REVIEWED_SOURCES = new Set(['submission', 'paid-feature']);
// Order statuses that still carry a paid pick's privileges (sponsors.js LIVE).
const PAID_ORDER = new Set(['paid', 'active']);

// A paid Vic's Pick submission. With `orders` (the sponsor orders), only
// while its order is still paid: a refunded or disputed pick loses the
// softened review and the reminders. Without them (or with no order found
// for the row) the source alone decides, as before orders were checked.
export function isPaidPick(row, orders = null) {
  if (!row || row.source !== 'paid-feature') return false;
  if (!Array.isArray(orders)) return true;
  const order = orders.find(o => o && o.submission_id === row.id);
  return !order || PAID_ORDER.has(order.status);
}

// The sponsor orders, or null when they can't be read (then isPaidPick
// falls back to the source).
async function sponsorOrders(store) {
  if (typeof store.listSponsorOrders !== 'function') return null;
  try { return await store.listSponsorOrders(); } catch (err) {
    console.warn('[submission-review] sponsor orders unavailable:', err.message);
    return null;
  }
}

// Waiting for the AI: pending submissions (free or paid) it hasn't seen
// and the admin hasn't touched (anything beyond the "submitted" history
// entry and Slack reminders).
export function awaitingReview(row) {
  if (!row || row.status !== 'pending' || !REVIEWED_SOURCES.has(row.source || 'submission')) return false;
  if (row.ai_review) return false;
  const history = Array.isArray(row.review_history) ? row.review_history : [];
  return history.every(h => h && (h.action === 'submitted' || h.action === 'reminder'));
}

// Paid picks this close to their date (days) that still aren't live get a
// Slack reminder, at most every REMIND_EVERY_MS, once they've had
// REMIND_GRACE_MS for the review to publish them. So do picks promised a
// star in an issue (Monday's, newsletterCovers; Thursday's weekend one,
// weekendCovers) from REMIND_NEWSLETTER_DAYS before it: the issue goes out
// early that morning, before the 2-day window would open for a later pick.
const REMIND_DAYS = 2;
const REMIND_NEWSLETTER_DAYS = 1;
const REMIND_EVERY_MS = 6 * 3600 * 1000;
const REMIND_GRACE_MS = 30 * 60 * 1000;

function addDaysStr(dateStr, n) {
  return new Date(Date.parse(dateStr + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
}

// Not live yet: still pending, or approved but its publish hasn't
// succeeded (retryLive).
const notLive = r => r.status === 'pending' || (r.status === 'approved' && Boolean(r.ai_review && r.ai_review.live_pending));

// Called on every review run (the pending fetch). Returns the reminded rows.
// `rows` (pending and approved-but-not-live submissions) and `orders` can be
// passed in when the caller already read them.
export async function remindPaidPicks({ store, slack, nowFn, siteUrl = '', rows: given = null, orders }) {
  if (!slack) return [];
  const now = nowFn();
  const today = localDateStr(now);
  const until = addDaysStr(today, REMIND_DAYS);
  const paidOrders = orders === undefined ? await sponsorOrders(store) : orders;
  const soon = r => {
    const date = r.payload.date;
    if (date < today) return false;
    if (date <= until) return true;
    const week = currentWeek(date);
    const ahead = d => d >= today && d <= addDaysStr(today, REMIND_NEWSLETTER_DAYS);
    return (newsletterCovers(date, r.created_at) && ahead(week[0])) || (weekendCovers(date, r.created_at) && ahead(week[3]));
  };
  const candidates = given || [...await store.list({ status: 'pending' }), ...await store.list({ status: 'approved', fromDate: today })];
  const rows = candidates.filter(r => notLive(r) && isPaidPick(r, paidOrders) && r.payload && soon(r) &&
    now.getTime() - Date.parse(r.created_at || 0) >= REMIND_GRACE_MS);
  const due = rows.filter(r => {
    const last = (Array.isArray(r.review_history) ? r.review_history : []).filter(h => h && h.action === 'reminder').pop();
    return !last || now.getTime() - Date.parse(last.at) >= REMIND_EVERY_MS;
  });
  if (!due.length) return [];
  const at = now.toISOString();
  for (const r of due) {
    await store.update(r.id, { review_history: [...(Array.isArray(r.review_history) ? r.review_history : []),
      { at, action: 'reminder', note: `Reminded in Slack: paid ${town.pickName} not published yet` }] });
  }
  slack.notify({
    channel: 'sales',
    title: `⏰ ${due.length === 1 ? `A paid ${town.pickName} isn’t` : `${due.length} paid ${town.pickName}s aren’t`} on the site yet`,
    text: due.map(r => {
      const why = r.status === 'approved' ? ': approved, but publishing it failed (retrying)'
        : r.ai_review && r.ai_review.reason ? `: ${r.ai_review.reason}` : r.ai_review ? '' : ': not reviewed yet';
      return `• ${r.payload.name} · ${r.payload.date === today ? 'TODAY' : r.payload.date} (${r.submitter_name || r.submitter_email || 'buyer'})${why}`;
    }).join('\n'),
    link: `${siteUrl}/admin.html`, footer: 'Approve it in the Submissions tab, or refund it in Stripe'
  });
  return due;
}

// Approvals whose publish failed (or whose live check threw): publish
// again and, once the event is on the site, send its "you're live" email
// (onApproved). Upcoming dates only; one that published fine but still
// isn't listed stops retrying (the review's Slack note already said so).
// `deadline` (a Date.now() value) bounds a run: rows left when it passes
// keep live_pending for the next run, so a hanging Resend can't stack runs.
export async function retryLive({ store, publish, onApproved, nowFn, slack = null, siteUrl = '', rows: given = null, deadline = Infinity }) {
  const today = localDateStr(nowFn());
  const rows = (given || await store.list({ status: 'approved', fromDate: today })).filter(r => r.status === 'approved' &&
    r.ai_review && r.ai_review.live_pending && r.payload && String(r.payload.date || '') >= today);
  if (!rows.length) return [];
  let published;
  try { published = await publish(); } catch (err) {
    console.warn('[submission-review] publish retry failed:', err.message);
    return [];
  }
  if (!published || !published.ok) return [];
  const out = [];
  for (const r of rows) {
    if (Date.now() > deadline) break;
    let live;
    try { live = Boolean(await onApproved(r)); } catch (err) {
      console.warn('[submission-review] live check/email retry failed:', err.message);
      continue;
    }
    const at = nowFn().toISOString();
    await store.update(r.id, { ai_review: { ...r.ai_review, live_pending: null, live, live_at: live ? at : null } });
    out.push({ id: r.id, live });
    if (!live && slack) {
      slack.notify({ channel: 'activity', title: `⚠️ Approved but not on the site: ${r.payload.name}`,
        text: `${r.payload.name} · ${r.payload.date} published on retry but isn't listed (removed before, or matches an event already listed); check it.`,
        link: `${siteUrl}/admin.html` });
    }
  }
  return out;
}

// The stored payload with only the AI's allowed changes applied. Returns
// { payload, changes } or { error }.
export function applyCleanup(payload, cleaned) {
  const c = cleaned && typeof cleaned === 'object' ? cleaned : {};
  const next = { ...payload };
  const changes = [];
  if (typeof c.name === 'string' && c.name.trim() && c.name.trim() !== payload.name) {
    next.name = c.name.trim();
    changes.push('name');
  }
  if (typeof c.description === 'string' && c.description.trim() && c.description.trim() !== payload.description) {
    next.description = c.description.trim();
    changes.push('description');
  }
  if (Array.isArray(c.icons) && c.icons.length) {
    next.icons = c.icons;
    if (payload.free && !next.icons.includes('free')) next.icons = [...next.icons, 'free'];
  }
  // The same validation as an admin edit (icons filtered to the allowed set,
  // lengths capped); submitter fields pass through untouched.
  const v = validateSubmission(next, { adminEdit: true });
  if (!v.ok) return { error: Object.values(v.errors)[0] || 'invalid' };
  const out = normalizePayload(v.data.payload);
  if (JSON.stringify(out.icons) !== JSON.stringify(payload.icons || [])) changes.push('icons');
  return { payload: out, changes };
}

// The review script's research (scripts/review_submissions.py
// research_one): suggested address, end time and link for what the
// submitter left out, with https sources. Anything malformed is dropped;
// null when nothing is left.
const HTTPS = /^https:\/\/[^\s/]+\.[^\s]+$/;
export function cleanResearch(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const out = {};
  const addr = String(r.address || '').replace(/\s+/g, ' ').trim();
  if (addr.length >= 5 && addr.length <= 200) out.address = addr;
  const end = String(r.end_time || '').trim();
  if (/^(1[0-2]|0?[1-9]):[0-5]\d (AM|PM)$/.test(end)) out.end_time = end;
  const url = String(r.url || '').trim();
  if (HTTPS.test(url) && url.length <= 500) out.url = url;
  if (!Object.keys(out).length) return null;
  out.sources = (Array.isArray(r.sources) ? r.sources : []).map(u => String(u || '').trim())
    .filter(u => HTTPS.test(u) && u.length <= 500).slice(0, 5);
  const note = String(r.note || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (note) out.note = note;
  return out;
}
export function researchLine(r) {
  return [r.address && `address “${r.address}”`, r.end_time && `ends ${r.end_time}`, r.url && `link ${r.url}`]
    .filter(Boolean).join('; ') + (r.sources.length ? ` (sources: ${r.sources.join(', ')})` : '');
}

// onRun: called (not awaited) on each authenticated pending fetch; the
// server hangs the sponsor reports on it, since this is its 15-minute cron.
// Returns { idle } (the upkeep run in flight, for tests).
const UPKEEP_BUDGET_MS = 5 * 60 * 1000;
export function registerSubmissionReview(app, { store, secret, nowFn, autoApprove, publish, onApproved = () => {}, onRun = () => {}, slack = null, siteUrl = '', upkeepBudgetMs = UPKEEP_BUDGET_MS }) {
  // Each review run passes through the pending fetch, so it's also when
  // approvals whose publish failed are retried, and paid picks close to
  // their date (or their newsletter) and still not live are called out.
  // After the response, not before it: retryLive is a publish plus up to
  // 15 s of Resend per row, and during a Resend hang that ran the fetch past
  // review_submissions.py's 30 s timeout, which only logs a warning, so new
  // submissions went unreviewed. One run at a time, each within a budget.
  let upkeep = null;
  function startUpkeep(orders) {
    if (upkeep) return upkeep;
    upkeep = (async () => {
      let approved = [];
      try {
        approved = await store.list({ status: 'approved', fromDate: localDateStr(nowFn()) });
        const retried = await retryLive({ store, publish, onApproved, nowFn, slack, siteUrl, rows: approved,
          deadline: Date.now() + upkeepBudgetMs });
        if (retried.length) approved = await store.list({ status: 'approved', fromDate: localDateStr(nowFn()) });
      } catch (err) {
        console.warn('[submission-review] live retry failed:', err.message);
      }
      try {
        const pending = await store.list({ status: 'pending' });
        await remindPaidPicks({ store, slack, nowFn, siteUrl, rows: [...pending, ...approved], orders });
      } catch (err) {
        console.warn('[submission-review] paid pick reminder failed:', err.message);
      }
    })().finally(() => { upkeep = null; });
    return upkeep;
  }

  app.get('/api/submission-review/pending', async (req, res, next) => {
    if (!secretOk(req.get('x-cron-secret'), secret)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    try {
      try { Promise.resolve(onRun()).catch(err => console.warn('[submission-review] onRun failed:', err.message)); } catch (err) {
        console.warn('[submission-review] onRun failed:', err.message);
      }
      const orders = await sponsorOrders(store);
      const rows = (await store.list({ status: 'pending' })).filter(awaitingReview);
      // Only what the review needs: no emails, phone numbers or IPs.
      const submissions = rows.slice(0, MAX_PER_RUN).map(r => {
        const { submitter_first_name: _f, submitter_last_name: _l, submitter_phone: _p, ...event } = r.payload || {};
        return { id: r.id, created_at: r.created_at, submitter_kind: r.submitter_kind || 'other', paid: isPaidPick(r, orders), event };
      });
      res.json({ ok: true, auto_approve: autoApprove, submissions });
      startUpkeep(orders);
    } catch (err) { next(err); }
  });

  app.post('/api/submission-review', async (req, res, next) => {
    if (!secretOk(req.get('x-cron-secret'), secret)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const asks = Array.isArray(req.body && req.body.reviews) ? req.body.reviews : null;
    if (!asks) return res.status(400).json({ ok: false, error: 'bad-payload', message: 'reviews[] required' });
    if (asks.length > MAX_PER_RUN) {
      return res.status(400).json({ ok: false, error: 'too-many', message: `At most ${MAX_PER_RUN} reviews at once.` });
    }
    try {
      const done = [];
      const skipped = [];
      const orders = await sponsorOrders(store);
      for (const ask of asks) {
        const id = String(ask && ask.id || '');
        let decision = String(ask && ask.decision || '');
        const reason = String(ask && ask.reason || '').replace(/\s+/g, ' ').trim().slice(0, 300);
        const row = id ? await store.get(id) : null;
        if (!row || !awaitingReview(row)) { skipped.push({ id, why: 'not-awaiting-review' }); continue; }
        if (!DECISIONS.has(decision)) { skipped.push({ id, why: 'bad-decision' }); continue; }
        const paid = isPaidPick(row, orders);
        let reasonNote = reason;
        // Nothing paid for is turned away without the owner: a refund is
        // their call. An exact copy of a live event is fine for a paid
        // pick: the pin finds the listed one.
        if (paid && decision === 'reject') {
          decision = 'flag';
          reasonNote = `paid ${town.pickName} the review would have turned away${reason ? `: ${reason}` : ''}`;
        } else if (paid && decision === 'duplicate') {
          decision = 'approve';
        }
        if (decision === 'approve' && !autoApprove) decision = 'flag';
        // Auto-publish only lists upcoming events, so a past date can't go live.
        if (decision === 'approve' && String((row.payload || {}).date || '') < localDateStr(nowFn())) {
          decision = 'flag';
          reasonNote = `the date has already passed${reason ? `; ${reason}` : ''}`;
        }

        // Cleanup is applied only to what goes live; a flagged submission
        // keeps the submitter's words for the admin to judge, with the
        // suggestion in the notes.
        let payload = row.payload;
        let changes = [];
        let note = reasonNote;
        if (decision === 'approve' || decision === 'flag') {
          // A paid pick keeps the buyer's words (they saw a preview before
          // paying); the review only decides whether it can go live.
          const fixed = applyCleanup(row.payload, paid ? {} : ask.cleaned);
          if (fixed.error) {
            decision = 'flag';
            note = `${reasonNote ? reasonNote + ' ' : ''}(AI cleanup was invalid: ${fixed.error})`.trim();
          } else if (decision === 'approve') {
            payload = fixed.payload;
            changes = fixed.changes;
          } else if (fixed.changes.length) {
            const s = fixed.payload;
            note = `${reasonNote} Suggested: ${fixed.changes.includes('name') ? `name “${s.name}”; ` : ''}` +
              `${fixed.changes.includes('description') ? `description “${s.description}”` : ''}`.trim();
          }
        }
        const at = nowFn().toISOString();
        const history = [...(Array.isArray(row.review_history) ? row.review_history : []),
          { at, action: STATUS[decision] ? `status:${STATUS[decision]}` : 'ai-flag', note: `AI review: ${note || LABEL[decision]}`.slice(0, 500) }];
        // Web research's suggestions for missing details: kept for the
        // owner (and HQ), never applied here.
        const research = decision === 'reject' || decision === 'duplicate' ? null : cleanResearch(ask.research);
        const aiNote = `AI review (${LABEL[decision].toLowerCase()}): ${note || 'no notes'}` +
          (research ? `\nResearch suggests: ${researchLine(research)}` : '');
        const patch = {
          review_history: history,
          admin_notes: [row.admin_notes, aiNote].filter(Boolean).join('\n').slice(0, 2000),
          ai_review: { at, decision, reason: note, changes, original: changes.length ? row.payload : null,
            ...(research ? { research } : {}) }
        };
        if (STATUS[decision]) patch.status = STATUS[decision];
        if (decision === 'approve') patch.payload = payload;
        const updated = await store.update(id, patch);
        done.push({ id, decision, reason: note, changes, paid, row: updated || { ...row, ...patch }, live: null });
      }

      let published = null;
      if (done.some(d => d.decision === 'approve')) {
        try {
          published = await publish();
        } catch (err) {
          console.error('[submission-review] publish failed:', err.message);
          published = { ok: false, error: err.message };
        }
        // onApproved emails "you're live" only when the event is really on
        // the site, and says whether it is; Slack calls out the ones that
        // aren't (removed before, or matched an event already listed).
        for (const d of done) if (d.decision === 'approve') {
          try { d.live = published && published.ok ? Boolean(await onApproved(d.row)) : false; } catch (err) {
            console.warn('[submission-review] live check/email failed:', err.message);
          }
          // Publishing failed (or the check threw): the event isn't live and
          // nobody would send its email later, so retryLive picks it up on
          // the next run.
          if (!(published && published.ok) || d.live === null) {
            d.retrying = true;
            const aiReview = { ...(d.row.ai_review || {}), live_pending: nowFn().toISOString() };
            try {
              d.row = (await store.update(d.id, { ai_review: aiReview })) || { ...d.row, ai_review: aiReview };
            } catch (err) { console.warn('[submission-review] live retry mark failed:', err.message); }
          }
        }
      }
      if (slack && done.length) {
        const lines = done.map(d => {
          const ev = d.row.payload || {};
          const fixed = d.changes.length ? ` (tidied: ${d.changes.join(', ')})` : '';
          const notLive = d.retrying ? ': not live yet, publishing is retried on the next run'
            : d.decision === 'approve' && d.live === false
              ? ': ⚠️ approved but not on the site (removed before, or matches an event already listed); check it' : '';
          return `• *${LABEL[d.decision]}*${d.paid ? ` (💰 paid ${town.pickName})` : ''}: ${ev.name} · ${ev.date}${fixed}${notLive}${d.decision === 'approve' ? '' : `: ${d.reason}`}`;
        });
        const live = done.filter(d => d.decision === 'approve' && d.live !== false).length;
        const flagged = done.filter(d => d.decision === 'flag').length;
        const notOn = done.filter(d => d.decision === 'approve' && d.live === false).length;
        const turned = done.filter(d => d.decision === 'reject' || d.decision === 'duplicate').length;
        slack.notify({
          channel: 'activity',
          title: `🤖 Submission review: ${[live && `${live} live`, flagged && `${flagged} for you to look at`,
            notOn && `${notOn} approved but not live`,
            turned && `${turned} turned away`].filter(Boolean).join(', ')}`,
          text: lines.join('\n') + (published && !published.ok ? `\n⚠️ Publishing failed: ${published.error || published.message}` : ''),
          link: `${siteUrl}/admin.html`, footer: 'Reject one in the Submissions tab to take it off the site'
        });
      }
      res.json({
        ok: true,
        done: done.map(({ id, decision, reason, changes, row, live }) => ({ id, decision, reason, changes, live, key: eventKeyOf(row.payload || {}) })),
        skipped,
        published: published ? Boolean(published.ok) : null
      });
    } catch (err) { next(err); }
  });

  return { idle: () => upkeep || Promise.resolve() };
}
