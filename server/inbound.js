/* server/inbound.js — Email replies land in Slack.
 *
 * thevic361.com's MX points at Resend (receiving), so a reply to
 * news@thevic361.com (the newsletter, the welcome email, sponsor and
 * submission emails) reaches Resend instead of bouncing. Resend POSTs an
 * `email.received` webhook here (metadata only); we verify its signature
 * (Svix: HMAC-SHA256 over "id.timestamp.body" with the whsec_ secret),
 * fetch the message from GET /emails/receiving/:id and post the sender,
 * subject and new text (quoted history cut off) to Slack. No inbox to
 * check: they go to the inbox channel (💰 marks ones about orders).
 * Resend keeps every message in its dashboard either way.
 *
 * The same webhook also takes `email.bounced` and `email.complained`
 * (subscribe it to both in Resend): a hard bounce marks the subscriber
 * bounced and a spam complaint unsubscribes them, so neither gets another
 * issue nor counts toward referral rewards or a sponsor's copies sent.
 * A soft bounce (a full mailbox) is only counted: a run of them over a
 * week or more marks the address bounced too (SOFT_BOUNCE in db.js). Also
 * subscribe it to `email.delivered`, which ends a run; without it a run
 * ends after 30 days with no soft bounce.
 *
 * Setup (Railway): RESEND_WEBHOOK_SECRET, the webhook's signing secret.
 * Unset, the endpoint answers 503 and the reply ask stays off (newsletter.js).
 */

import { burst } from './burst.js';
import { suggestEmail } from './emailTypos.js';
import { town, VICTORIA, otherTownDomains } from './town.js';
import crypto from 'node:crypto';
import express from 'express';
import { keyOk } from './hq.js';

const RESEND_API = 'https://api.resend.com';
const DELIVERY_EVENTS = new Set(['email.bounced', 'email.complained', 'email.delivered']);
const TOLERANCE_S = 5 * 60;      // Svix timestamps older/newer than this are refused
const MAX_TEXT = 1500;           // characters of the reply shown in Slack
const SEEN_MAX = 500;            // webhook ids remembered (Resend retries)

export function inboundConfig(env = process.env, overrides = {}) {
  const secret = overrides.resendWebhookSecret ?? env.RESEND_WEBHOOK_SECRET ?? '';
  return { secret, enabled: /^whsec_[A-Za-z0-9+/=]+$/.test(secret) };
}

// Svix signature check. `header` is "v1,<b64> v1,<b64>…".
export function verifySvix(raw, { id, timestamp, signature }, secret, nowS = Math.floor(Date.now() / 1000)) {
  if (!id || !timestamp || !signature || !/^whsec_/.test(secret || '')) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowS - ts) > TOLERANCE_S) return false;
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const expected = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${raw}`).digest();
  return String(signature).split(' ').some(part => {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) return false;
    const got = Buffer.from(sig, 'base64');
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  });
}

// The plain text of a received email: `text`, or the HTML (sometimes a
// data: URI) with tags stripped.
export function bodyText(email) {
  if (email && typeof email.text === 'string' && email.text.trim()) return email.text;
  let html = String((email && email.html) || '');
  const m = /^data:text\/html[^,]*?(;base64)?,(.*)$/s.exec(html);
  if (m) html = m[1] ? Buffer.from(m[2], 'base64').toString('utf8') : decodeURIComponent(m[2]);
  return html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&rsquo;/g, '\'').replace(/&quot;/g, '"');
}

// Just what they wrote: everything before the quoted original ("On … wrote:",
// "> " lines, Outlook's "From:" block, "-----Original Message-----").
export function newText(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    if (/^\s*>/.test(line) || /^On .+wrote:\s*$/.test(line.trim()) || /^-{2,}\s*Original Message/i.test(line.trim()) ||
        /^From:\s.+/.test(line.trim()) && out.some(l => l.trim())) break;
    out.push(line);
  }
  const s = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '…' : s;
}

// Out-of-office and bounces aren't worth a ping.
export function isAutomatic(email) {
  const h = Object.fromEntries(Object.entries((email && email.headers) || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const from = String((email && email.from) || '');
  const subject = String((email && email.subject) || '');
  return (h['auto-submitted'] && h['auto-submitted'] !== 'no') || /^(bulk|junk|auto_reply)$/i.test(h.precedence || '') ||
    'x-autoreply' in h || 'x-autorespond' in h || /mailer-daemon|postmaster@/i.test(from) ||
    /^(automatic reply|auto(matic)?[- ]?reply|out of (the )?office|undeliverable|delivery status notification)/i.test(subject);
}

// The Slack "Reply" link: the admin's compose box (docs/admin.js
// openReplyFromHash), which sends as news@ so their answer comes back here.
export function replyLink(siteUrl, { to, subject = '', ref = '' }) {
  const q = new URLSearchParams({ to, subject: /^re:/i.test(subject) ? subject : `Re: ${subject}` });
  if (ref) q.set('ref', ref);
  return `${siteUrl}/admin.html#reply?${q}`;
}

const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// A personal reply: plain text and a plain HTML twin (no newsletter
// design, so it reads like a person wrote it), signed with Tristen's first
// name only and the town: he approves every reply, from the admin reply box
// or through HQ.
export const REPLY_SIGNER = 'Tristen';

export function renderReply(text, siteUrl) {
  const body = String(text).replace(/\r\n/g, '\n').trim();
  const host = siteUrl.replace(/^https?:\/\//, '');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1F1A3D;">` +
    body.split(/\n{2,}/).map(par => `<p style="margin:0 0 12px;">${escHtml(par).replace(/\n/g, '<br>')}</p>`).join('') +
    `<p style="margin:16px 0 0;color:#5B5675;">${REPLY_SIGNER}<br>${escHtml(town.siteName)} · <a href="${escHtml(siteUrl)}" style="color:#4B3FD1;">${escHtml(host)}</a></p></div>`;
  return { html, text: `${body}\n\n${REPLY_SIGNER}\n${town.siteName} · ${host}` };
}

// Replies about money (Vic's Picks, sponsor weeks, refunds) get a 💰. The
// town's own pick name counts too ("Vic's Pick", with or without the
// apostrophe, in Victoria).
const SALES_RE = /vic[’']?s pick|sponsor|booked|receipt|refund|invoice|order|payment|report:/i;
const reEsc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function isSales(subject) {
  const pick = reEsc(town.pickNamePlain.toLowerCase()).replace(/'/g, "[’']?");
  return SALES_RE.test(subject) || new RegExp(pick, 'i').test(subject);
}

// Is a received email this town's? One Resend account can receive for
// several towns' domains, and each town's webhook sees all of them. Another
// town takes only mail to (or cc) its own domain or a subdomain. Victoria
// takes everything except mail addressed only to another town's domain, so
// a reply that reached it by Bcc or a forward is never lost.
export function isForTown(recipients, t = town, others = []) {
  const domains = (recipients || []).map(r => String(r).toLowerCase())
    .map(r => ((/<([^>]+)>/.exec(r) || [, r])[1].trim().split('@')[1] || '').replace(/\.$/, '')).filter(Boolean);
  const on = (d, dom) => d === dom || d.endsWith('.' + dom);
  if (domains.some(d => on(d, t.domain))) return true;
  if (t.id !== VICTORIA.id) return false;
  return !domains.length || !domains.every(d => others.some(o => on(d, o)));
}

// The bare, lowercased addresses of a webhook's `to` (a string or a list,
// with or without a display name), as subscribers are stored.
export function recipientAddresses(to) {
  return (Array.isArray(to) ? to : [to]).map(r => String(r || '').trim())
    .map(r => (/<([^>]+)>/.exec(r) || [, r])[1].trim().toLowerCase()).filter(r => /^[^\s@]+@[^\s@]+$/.test(r));
}

// A bounce Resend reports as temporary (a full mailbox, a greylist) isn't a
// dead address. Resend sends email.bounced for permanent bounces; when the
// payload names the kind, anything but Permanent is left alone.
export function isHardBounce(data) {
  const type = String((data && data.bounce && data.bounce.type) || '').trim().toLowerCase();
  return !type || type === 'permanent' || type === 'hard';
}

// onReply({ id, from, email, subject, text, at }): a reader's reply, for the
// sections' Thursday roundup (server/sections.js); not sales mail.
export function createInbound({ config, apiKey, slack, siteUrl = '', fetchImpl = globalThis.fetch, nowFn = () => Date.now(), otherDomains, store = null, onReply = null }) {
  const seen = new Set();
  const others = otherDomains || otherTownDomains();

  async function fetchEmail(id) {
    const r = await fetchImpl(`${RESEND_API}/emails/receiving/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000)
    });
    if (!r.ok) throw new Error(`resend ${r.status}`);
    return r.json();
  }

  // A hard bounce or a spam complaint about one of our emails. The `from`
  // is ours, so it says which town sent it (one Resend account can send for
  // several towns, and each town's webhook sees every event).
  // Many in a day means a bad list or a deliverability problem (Resend can
  // pause an account over it); a run of bad signatures, a wrong
  // RESEND_WEBHOOK_SECRET losing every reply, bounce and complaint.
  const bounces = burst(10, 24 * 3600 * 1000);
  const complaints = burst(3, 24 * 3600 * 1000);
  const badSignatures = burst(3, 3600 * 1000);

  // A bounced email to someone who sent us an event or bought a placement
  // (Oct 2026: a Star 402 organizer typed "...@gmail.comm" and never got
  // "we got it" or "you're live"). The owner hears whose it was, with what
  // they probably meant, to fix the address in the admin or reach them
  // another way. A newsletter-only address just leaves the list, as before.
  async function tellOwnerOfBounce(to, d) {
    if (!slack) return;
    try {
      const lc = new Set(to.map(x => x.toLowerCase()));
      const mine = e => lc.has(String(e || '').trim().toLowerCase());
      const subs = typeof store.list === 'function' ? (await store.list({})).filter(r => r && mine(r.submitter_email)) : [];
      const orders = typeof store.listSponsorOrders === 'function' ? (await store.listSponsorOrders()).filter(o => o && mine(o.email)) : [];
      if (!subs.length && !orders.length) return;
      const lines = [
        ...subs.slice(0, 3).map(r => {
          const p = r.payload || {};
          return `Event “${p.name || 'untitled'}” (${[p.date, p.venue].filter(Boolean).join(', ')}), sent by ${r.submitter_name || 'someone'}` +
            (p.submitter_phone ? `, phone ${p.submitter_phone}` : '');
        }),
        ...orders.slice(0, 3).map(o => `Paid order from ${o.business || 'a business'} (${o.kind || o.package || 'order'}, ${o.status || 'status unknown'})`)
      ];
      const guess = to.map(x => suggestEmail(x)).find(Boolean);
      slack.alert(`bounce:${to[0]}`, `Email to ${to.join(', ')} bounced`,
        `${lines.join('\n')}\n` +
        (guess ? `Probably a typo for ${guess.email}. ` : '') +
        `They didn't get “${String(d.subject || 'our email')}”. Fix the address in the admin, or reach them another way.`,
        siteUrl ? `${siteUrl}/admin.html` : null);
    } catch (err) {
      console.warn('[inbound] bounce lookup failed:', err.message);
    }
  }

  async function handleDeliveryEvent(event) {
    const d = event.data || {};
    if (!isForTown([d.from].filter(Boolean), town, others)) return 'other-town';
    const to = recipientAddresses(d.to);
    if (!to.length || !store) return 'ignored';
    if (event.type === 'email.delivered') {
      if (typeof store.clearSoftBounces === 'function') await store.clearSoftBounces(to);
      return 'delivered';
    }
    if (event.type === 'email.bounced') {
      if (!isHardBounce(d)) {
        if (typeof store.recordSoftBounce !== 'function') return 'soft-bounce';
        const gone = await store.recordSoftBounce(to, new Date(nowFn()));
        if (!gone.length) return 'soft-bounce';
        console.log(`[inbound] marked ${gone.length} subscriber(s) bounced (repeated soft bounces)`);
        return 'bounced';
      }
      await tellOwnerOfBounce(to, d);
      if (typeof store.markSubscribersBounced !== 'function') return 'ignored';
      const n = await store.markSubscribersBounced(to);
      if (n) console.log(`[inbound] marked ${n} subscriber(s) bounced (hard bounce)`);
      const many = bounces(nowFn());
      if (many && slack) slack.alert('email-bounces', `${many} emails hard-bounced in a day`,
        'Those addresses are off the list, but this many points at a bad import or a sending problem: check Resend → Emails for the bounce reasons.');
      return 'bounced';
    }
    if (typeof store.unsubscribeByEmail !== 'function') return 'ignored';
    const n = await store.unsubscribeByEmail(to);
    if (n && slack) {
      // Deliverability, so alerts; already handled, so ⚠️ (for today), not 🚨.
      slack.notify({ channel: 'alerts', title: '⚠️ Spam complaint: unsubscribed', text: 'They get no more issues.',
        more: `Email: ${to.join(', ')}\nSubject: ${String(d.subject || '')}\nThey marked one of our emails as spam.` });
      const many = complaints(nowFn());
      if (many) slack.alert('email-complaints', `${many} spam complaints in a day`,
        'Each one is unsubscribed. This many can get the Resend account paused: look at what went out and who it went to.');
    }
    return 'complained';
  }

  async function handle(event) {
    if (event && DELIVERY_EVENTS.has(event.type) && event.data) return handleDeliveryEvent(event);
    if (!event || event.type !== 'email.received' || !event.data || !event.data.email_id) return 'ignored';
    const id = event.data.email_id;
    if (!isForTown([...(event.data.to || []), ...(event.data.cc || [])], town, others)) return 'other-town';
    if (seen.has(id)) return 'duplicate';
    const email = await fetchEmail(id);
    seen.add(id);
    if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value);
    if (isAutomatic(email)) return 'automatic';
    const from = String(email.from || event.data.from || '');
    const addr = (/<([^>]+)>/.exec(from) || [, from])[1].trim();
    const subject = String(email.subject || event.data.subject || '(no subject)');
    const text = newText(bodyText(email)) || '(no text)';
    const files = (email.attachments || event.data.attachments || []).filter(a => a.content_disposition !== 'inline').map(a => a.filename).filter(Boolean);
    const sales = isSales(subject);
    if (slack) {
      await slack.notify({
        title: `${sales ? '💰' : '📬'} Email from ${addr || 'unknown sender'}`.slice(0, 150),
        fields: [['Subject', subject], ['To', (email.to || event.data.to || []).join(', ')], ...(files.length ? [['Attachments', files.join(', ')]] : [])],
        text,
        link: addr ? replyLink(siteUrl, { to: addr, subject, ref: email.message_id || '' }) : null, linkLabel: 'Reply as news@',
        footer: 'Full message in Resend → Emails → Receiving',
        channel: 'inbox'
      });
    }
    if (!sales && typeof onReply === 'function') {
      try {
        await onReply({ id: String(id), from, email: addr, subject, text, at: new Date(nowFn()).toISOString() });
      } catch (err) { console.warn('[inbound] reply not saved for the roundup:', err.message); }
    }
    return 'posted';
  }

  function register(app) {
    app.post('/api/email/inbound', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
      if (!config.enabled || !apiKey) return res.status(503).json({ ok: false, error: 'not-configured' });
      const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      const ok = verifySvix(raw, { id: req.get('svix-id'), timestamp: req.get('svix-timestamp'), signature: req.get('svix-signature') },
        config.secret, Math.floor(nowFn() / 1000));
      if (!ok) {
        const many = badSignatures(nowFn());
        if (many && slack) slack.alert('inbound-bad-signature', 'Resend webhooks are being refused (bad signature)',
          `${many} in the last hour. If RESEND_WEBHOOK_SECRET in Railway doesn't match the webhook's signing secret in Resend, every email reply, bounce and complaint is lost: copy it again from Resend → Webhooks. (If nothing changed, someone may just be poking at the URL.)`);
        return res.status(400).json({ ok: false, error: 'bad-signature' });
      }
      let event;
      try { event = JSON.parse(raw); } catch (_) { return res.status(400).json({ ok: false, error: 'bad-json' }); }
      try {
        res.json({ ok: true, result: await handle(event) });
      } catch (err) {
        // A 500 makes Resend retry; the email itself is kept in Resend (and
        // a bounce or complaint is tried again the same way).
        console.error('[inbound] handling a Resend webhook failed:', err.message);
        if (slack) slack.alert('inbound-email-failed', 'Email replies aren’t reaching Slack', err.message);
        res.status(500).json({ ok: false });
      }
    });
  }

  // POST /api/admin/email/reply {to, subject, text, ref}: send as news@
  // (Resend), threaded under their message when `ref` is its Message-ID.
  // Registered after the JSON parser; admin only.
  function registerReply(app, { requireAdmin, resend, from, normalizeEmail }) {
    app.post('/api/admin/email/reply', requireAdmin, async (req, res) => {
      const b = req.body || {};
      const to = normalizeEmail(String(b.to || ''));
      const subject = String(b.subject || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
      const text = String(b.text || '').slice(0, 10000);
      const ref = /^<[^<>\s]{3,300}>$/.test(String(b.ref || '')) ? b.ref : '';
      const errors = {};
      if (!to) errors.to = 'Add a valid email address.';
      if (!subject) errors.subject = 'Add a subject.';
      if (text.trim().length < 2) errors.text = 'Write a reply.';
      if (Object.keys(errors).length) return res.status(400).json({ ok: false, errors });
      if (!apiKey) return res.status(503).json({ ok: false, error: 'not-configured', message: 'Set RESEND_API_KEY in Railway first.' });
      const mail = renderReply(text, siteUrl);
      try {
        await resend.send({ from, to: [to], subject, html: mail.html, text: mail.text,
          ...(ref ? { headers: { 'In-Reply-To': ref, References: ref } } : {}) });
      } catch (err) {
        console.warn('[inbound] reply failed:', err.message);
        return res.status(502).json({ ok: false, error: 'send-failed', message: err.message });
      }
      if (slack) slack.notify({ title: `↩️ Replied to ${to}`, fields: [['Subject', subject]], text: text.slice(0, 600), channel: 'inbox' });
      res.json({ ok: true });
    });
  }

  // POST /api/hq/reply {event_id, draft, subject, text}: a reply the owner
  // approved through HQ (tmpalori/tristen-hq; his assistant asks him, HQ
  // records his OK), sent as news@ like the admin's reply box. Off (404)
  // without HQ_REPLY_KEY, its own key: the read-only HQ_API_KEY can't send.
  // HQ can't name a recipient: the town takes it from that message's own
  // "Reply as news@" link, so it only answers someone who wrote in, within
  // 60 days. At most `limit` a day, and each HQ draft once.
  function registerHqReply(app, { key = '', resend, from, limiter = null, clientKey = req => req.ip, limit = 30 }) {
    if (!key) return;
    const sentDrafts = new Set();
    let day = '', count = 0;
    app.post('/api/hq/reply', express.json({ limit: '32kb' }), async (req, res) => {
      if (limiter && !limiter.check(`hq-reply:${clientKey(req)}`).ok) return res.status(429).json({ ok: false, error: 'rate-limited' });
      if (!keyOk(req.get('authorization'), key)) return res.status(401).json({ ok: false, error: 'unauthorized' });
      res.set('Cache-Control', 'no-store');
      const b = req.body || {};
      const draft = /^\d{1,15}$/.test(String(b.draft || '')) ? String(b.draft) : '';
      const subject = String(b.subject || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
      const text = String(b.text || '').slice(0, 10000);
      if (!draft || !subject || text.trim().length < 2) return res.status(400).json({ ok: false, error: 'bad-request' });
      if (sentDrafts.has(draft)) return res.status(409).json({ ok: false, error: 'already-sent' });
      const event = /^\d{1,15}$/.test(String(b.event_id || '')) && store && typeof store.getInboxEvent === 'function'
        ? await store.getInboxEvent(Number(b.event_id)).catch(() => null) : null;
      const target = event && replyTarget(event, siteUrl, nowFn());
      if (!target) return res.status(422).json({ ok: false, error: 'not-replyable', message: 'Only a message someone sent in the last 60 days can be answered.' });
      if (!apiKey) return res.status(503).json({ ok: false, error: 'not-configured' });
      const today = new Date(nowFn()).toISOString().slice(0, 10);
      if (today !== day) { day = today; count = 0; }
      if (count >= limit) return res.status(429).json({ ok: false, error: 'daily-limit' });
      count++;
      sentDrafts.add(draft);
      const mail = renderReply(text, siteUrl);
      try {
        await resend.send({ from, to: [target.to], subject, html: mail.html, text: mail.text,
          ...(target.ref ? { headers: { 'In-Reply-To': target.ref, References: target.ref } } : {}) });
      } catch (err) {
        sentDrafts.delete(draft); count--;
        console.warn('[inbound] HQ reply failed:', err.message);
        return res.status(502).json({ ok: false, error: 'send-failed' });
      }
      if (slack) slack.notify({ title: `↩️ Replied to ${target.to}`, fields: [['Subject', subject], ['Approved', 'by Tristen, through HQ']], text: text.slice(0, 600), channel: 'inbox' });
      res.json({ ok: true, to: target.to });
    });
  }

  return { register, registerReply, registerHqReply, handle };
}

// Who a saved inbox event (server/inbox.js) can be answered at: the `to`
// and Message-ID of its own "Reply as news@" link, for a message from a
// person (an email to news@ or the contact form) at most 60 days old.
export function replyTarget(event, siteUrl, now = Date.now()) {
  const link = String((event && event.payload && event.payload.link) || '');
  const prefix = `${siteUrl}/admin.html#reply?`;
  if (!event || event.channel !== 'inbox' || !link.startsWith(prefix) || /^↩️/u.test(String(event.title || ''))) return null;
  if (!(now - Date.parse(event.created_at) <= 60 * 86400000)) return null;
  const q = new URLSearchParams(link.slice(prefix.length));
  const to = String(q.get('to') || '').trim().toLowerCase();
  if (!/^[^\s@<>,;]+@[^\s@<>,;]+\.[a-z]{2,}$/.test(to)) return null;
  const ref = String(q.get('ref') || '');
  return { to, ref: /^<[^<>\s]{3,300}>$/.test(ref) ? ref : '' };
}
