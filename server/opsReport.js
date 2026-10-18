/* server/opsReport.js — GitHub workflows' alerts into the owner inbox.
 *
 * The workflows post their failures straight to Slack (scripts/slack_notify.py),
 * which the owner inbox (server/inbox.js), and so HQ and the owner's
 * assistant, never saw. slack_notify.py now also sends each alert here:
 *
 *   POST /api/ops/report   X-Ops-Secret   { title, text?, link?, slack_delivered?, fyi? }
 *
 * fyi: a report, not an alert (the event check's full list; its short line
 * already went to Slack): saved as an fyi activity item, never posted.
 *
 * The alert is saved to the inbox as an alerts-channel item (urgent; a ✅
 * recovery is fyi). When the workflow couldn't post it to Slack itself
 * (no webhook, Slack refused), the site posts it, so it still reaches Slack.
 * The secret is OPS_REPORT_SECRET, else the submission review secret (the
 * workflows send the same fallback); it can only add an alert.
 */

import crypto from 'node:crypto';

const MAX_TITLE = 200;
const MAX_TEXT = 2000;
const MAX_FYI_TEXT = 4000; // the inbox keeps 4,000 (server/inbox.js)

function secretOk(given, want) {
  const g = Buffer.from(String(given || ''));
  const w = Buffer.from(String(want || ''));
  return w.length > 0 && g.length === w.length && crypto.timingSafeEqual(g, w);
}

// Only links to GitHub or this site: an alert is shown to the owner and his
// assistant, so it mustn't carry a link anywhere else.
export function safeLink(link, siteUrl) {
  try {
    const u = new URL(String(link || ''));
    if (u.protocol !== 'https:') return null;
    const site = siteUrl ? new URL(siteUrl).host : '';
    return u.host === 'github.com' || (site && u.host === site) ? u.toString() : null;
  } catch {
    return null;
  }
}

// Slack's "<url|Open>" link markup and the "[Town] " tag come off: the
// inbox keeps the link separately, and the town is this site.
export function cleanTitle(title) {
  return String(title || '').replace(/<[^>|]*\|[^>]*>/g, '').replace(/^\[[^\]]{1,40}\]\s*/, '')
    .replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
}

export function registerOpsReport(app, { secret, slack, json, limiter = null, siteUrl = '', clientKey = req => req.ip }) {
  app.post('/api/ops/report', json, async (req, res) => {
    if (limiter && !limiter.check(`ops:${clientKey(req)}`).ok) return res.status(429).json({ ok: false, error: 'rate-limited' });
    if (!secretOk(req.get('X-Ops-Secret'), secret)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const body = req.body || {};
    const title = cleanTitle(body.title);
    if (!title) return res.status(400).json({ ok: false, error: 'title-required' });
    const fyi = body.fyi === true;
    const text = String(body.text || '').slice(0, fyi ? MAX_FYI_TEXT : MAX_TEXT);
    const link = safeLink(body.link, siteUrl);
    // The workflow already prefixed its emoji (🚨, ⚠️, ⏰, ✅).
    const bare = title.replace(/^🚨\s*/u, '');
    try {
      if (fyi) {
        // classify() reads an activity title like "🔎 Event check: ..." as fyi.
        await slack.record('activity', { title, text, link });
      } else if (body.slack_delivered === true) {
        await slack.record('alerts', { title: /^\p{Extended_Pictographic}/u.test(title) ? title : `🚨 ${title}`, text, link });
      } else if (title.startsWith('✅') || title.startsWith('⚠️')) {
        // A recovery or a warning: posted and saved as it is.
        await slack.notify({ title, text, link, channel: 'alerts' });
      } else {
        // Not in Slack yet: alert() posts it and saves it.
        await slack.alert(`ops:${bare.slice(0, 80)}`, bare, text, link);
      }
      res.json({ ok: true });
    } catch (err) {
      console.warn('[ops] report failed:', err.message);
      res.status(500).json({ ok: false, error: 'report-failed' });
    }
  });
}
