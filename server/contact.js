/* server/contact.js — Contact form that delivers to the owner's Slack.
 *
 * Replaces the public email address: /contact posts here, and each message
 * arrives in Slack (server/slack.js) with the sender's email so the owner
 * can reply (the inbox channel, with a "Reply as news@" link). Nothing
 * personal is published.
 *
 * Every message is also saved in the database and listed on admin Home, so
 * a Slack outage doesn't lose it; if both fail it goes to the server log.
 */

import { town } from './town.js';
import { hqPaths } from './hqAdmin.js';
import { escHtml, layout } from './seo.js';
import { replyLink } from './inbound.js';
import { normalizeEmail } from './newsletter.js';
import { honeypotTripped } from './honeypot.js';
import { newId, nowIso } from './db.js';
import { passiveGuard } from './formGuard.js';
import { impossibleEmailError } from './emailTypos.js';

export const CONTACT_TOPICS = [
  ['advertising', 'Advertising or sponsorship'],
  ['event', 'A question about an event'],
  ['fix', 'Fix or remove a listing'],
  ['other', 'Something else']
];

const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

export function renderContactPage({ siteUrl, values = {}, errors = {}, sent = false }) {
  const v = values;
  const e = errors;
  const field = (name, label, input, err) => `<div class="co-field"><label for="c-${name}">${label}</label>${input}${err ? `<small class="co-error">${escHtml(err)}</small>` : ''}</div>`;
  const body = sent
    ? `<h1 class="page-title">Message sent</h1>
       <p class="page-lead">Thanks! We read every message and usually reply within a day.</p>
       <p><a class="btn btn--primary" href="/">See this week's events</a></p>`
    : `<h1 class="page-title">Contact us</h1>
    <p class="page-lead">Questions about advertising, an event, or a listing? Send us a note and we'll get back to you, usually within a day.</p>
    ${e._form ? `<p class="co-error co-error--form">${escHtml(e._form)}</p>` : ''}
    <form class="co-form" method="post" action="/contact" data-turnstile>
      <div class="hp-field" aria-hidden="true"><label>Leave this empty <input name="hp_field" tabindex="-1" autocomplete="off"></label></div>
      ${field('topic', 'What is this about?', `<select id="c-topic" name="topic">${CONTACT_TOPICS.map(([k, l]) => `<option value="${k}"${v.topic === k ? ' selected' : ''}>${escHtml(l)}</option>`).join('')}</select>`)}
      ${field('name', 'Your name', `<input id="c-name" name="name" required maxlength="80" value="${escHtml(v.name || '')}"${e.name ? ' aria-invalid="true"' : ''}>`, e.name)}
      ${field('email', 'Your email', `<input id="c-email" name="email" type="email" required maxlength="254" value="${escHtml(v.email || '')}"${e.email ? ' aria-invalid="true"' : ''}>`, e.email)}
      ${field('business', 'Business (optional)', `<input id="c-business" name="business" maxlength="80" value="${escHtml(v.business || '')}">`)}
      ${field('message', 'Message', `<textarea id="c-message" name="message" required maxlength="3000" rows="6"${e.message ? ' aria-invalid="true"' : ''}>${escHtml(v.message || '')}</textarea>`, e.message)}
      <button class="btn btn--primary" type="submit">Send message</button>
      <p class="co-hint">Listing an event? <a href="/submit">Submit it here</a>; it's free.</p>
    </form>`;
  return layout({
    siteUrl, path: '/contact', noindex: sent,
    title: `Contact | ${town.siteName}`,
    description: `Contact ${town.siteName} about advertising, an event, or a listing in ${town.cityState}.`,
    body
  });
}

export function registerContact(app, { siteUrl, slack, store = null, requireAdmin = null, adminOrHq = null, createRateLimiter, sendHtml, verifyHuman = async () => true, formGuard = passiveGuard(verifyHuman) }) {
  // Admin Home lists recent messages, so a lead never lives only in Slack.
  if (requireAdmin) {
    const gate = adminOrHq || requireAdmin;
    const paths = p => (adminOrHq ? hqPaths(p) : p);
    app.get(paths('/api/admin/messages'), gate, async (req, res, next) => {
      try {
        // Dismissed ones are dealt with: read past them so they don't
        // crowd newer ones out of the 50.
        const all = store && typeof store.listContactMessages === 'function' ? await store.listContactMessages(500) : [];
        const messages = all.filter(m => m && !m.dismissed_at).slice(0, 50);
        res.set('Cache-Control', 'no-store').json({ ok: true, messages });
      } catch (err) { next(err); }
    });
    app.post(paths('/api/admin/messages/:id/dismiss'), gate, async (req, res, next) => {
      try {
        if (!store || typeof store.dismissContactMessage !== 'function') return res.status(501).json({ ok: false, error: 'unsupported' });
        const ok = await store.dismissContactMessage(String(req.params.id || '').slice(0, 64));
        if (!ok) return res.status(404).json({ ok: false, error: 'not-found' });
        res.json({ ok: true });
      } catch (err) { next(err); }
    });
  }

  const limiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 5 });

  app.get('/contact', (req, res) => {
    const topic = CONTACT_TOPICS.some(([k]) => k === req.query.topic) ? req.query.topic : 'advertising';
    sendHtml(res, renderContactPage({ siteUrl, values: { topic } }));
  });

  app.post('/contact', async (req, res, next) => {
    try {
      const b = req.body || {};
      const values = {
        topic: CONTACT_TOPICS.some(([k]) => k === b.topic) ? b.topic : 'other',
        name: clean(b.name, 80), email: clean(b.email, 254), business: clean(b.business, 80), message: clean(b.message, 3000)
      };
      // Honeypot: pretend it worked so bots move on.
      if (honeypotTripped(b, 'contact', { slack })) return sendHtml(res, renderContactPage({ siteUrl, sent: true }), 200, 'no-store');
      // Every turn-away counts toward "someone is stuck" (server/formGuard.js).
      const fail = (errors, status = 400) => {
        formGuard.rejected('contact', req, Object.values(errors));
        return sendHtml(res, renderContactPage({ siteUrl, values, errors }), status, 'no-store');
      };
      if (!limiter.check(req.ip || req.socket.remoteAddress).ok) return fail({ _form: 'Too many messages from here. Try again in an hour.' }, 429);
      // This is the fallback the other forms point to, so a bot check that
      // didn't pass never stops it: the message goes through, labeled.
      const human = await formGuard.botCheck('contact', req, b['cf-turnstile-response'] || b.turnstile_token);
      if (!human.ok && human.error === 'hostname-mismatch') return fail({ _form: "We couldn't confirm you're not a bot. Please reload the page and try again." });
      const unverified = !human.ok;
      const errors = {};
      if (!values.name) errors.name = 'Please add your name.';
      const email = normalizeEmail(values.email);
      if (!email) errors.email = 'Please add a valid email so we can reply.';
      else if (impossibleEmailError(email)) errors.email = impossibleEmailError(email);
      if (values.message.length < 5) errors.message = 'Please add a short message.';
      if (Object.keys(errors).length) return fail(errors);

      const topic = CONTACT_TOPICS.find(([k]) => k === values.topic)[1];
      // Every message goes to the inbox channel, where replies to our
      // emails land too, so all conversations are in one place.
      const delivered = await slack.notify({
        title: `✉️ Website message: ${topic}${unverified ? ' (bot check didn’t pass)' : ''}`,
        fields: [['From', values.name], ['Email', email], ['Business', values.business]],
        text: values.message,
        link: replyLink(siteUrl, { to: email, subject: `Your message to ${town.siteName}` }), linkLabel: 'Reply as news@',
        footer: 'Their answer comes back here',
        channel: 'inbox'
      });
      // Every message is kept in the database too (listed on admin Home),
      // so a Slack outage or rotated webhook can't lose a lead.
      let saved = false;
      if (store && typeof store.saveContactMessage === 'function') {
        try {
          await store.saveContactMessage({ id: newId(), created_at: nowIso(), ...values, email, delivered: Boolean(delivered) });
          saved = true;
        } catch (err) {
          console.warn('[contact] save failed:', err.message);
        }
      }
      if (!delivered && !saved) {
        // Railway keeps logs; better there than lost.
        console.log('[contact] message (Slack and database unavailable):', JSON.stringify({ ...values, email }));
      }
      formGuard.ok('contact', req);
      sendHtml(res, renderContactPage({ siteUrl, sent: true }), 200, 'no-store');
    } catch (err) { next(err); }
  });
}
