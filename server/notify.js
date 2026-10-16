/* server/notify.js — "We got it" emails for people who submit an event or
 * buy a sponsorship, sent through Resend like the newsletter and in the same
 * design (server/newsletter.js emailShell, dark-mode safe).
 *
 * Each email says it worked, what happens next, and how to reach us
 * (reply, or /contact, which goes to Slack). Sending never blocks or fails
 * the request it follows: a mail problem is logged and the person still
 * sees the on-page confirmation. Off until RESEND_API_KEY is set.
 */

import { town } from './town.js';
import { escHtml, formatDay, safeUrl, currentWeek, addDays, localDateStr, formatTime, placeText } from './seo.js';
import { C, btn, emailShell, eventRow } from './newsletter.js';

// "Saturday, October 10, 7 PM · Venue · address" for the plain-text emails,
// formatted like the HTML row and the site (not the stored date and time).
function eventLine(ev) {
  const when = [ev.date ? formatDay(ev.date, { weekday: 'long', month: 'long', day: 'numeric' }) : '', formatTime(ev.time)].filter(Boolean).join(', ');
  return [when, placeText(ev)].filter(Boolean).join(' · ');
}

// ─── Vic’s Pick and the newsletter ──────────────────────────────────────
// The newsletter goes out twice a week: Monday morning with the whole week,
// Thursday morning with Friday to Sunday. A pick is only promised a star in
// an issue that is still ahead with a day to spare for the review (we
// approve paid picks "usually within a day"): bought on Tuesday for
// Saturday, Monday's issue has gone out but Thursday's hasn't.
// Whether Thursday's weekend issue goes out (NEWSLETTER_WEEKEND, set by
// createApp): with it off, nothing promises it.
let weekendIssue = true;
export function setWeekendIssue(on) { weekendIssue = Boolean(on); }
export function weekendIssueOn() { return weekendIssue; }

const boughtOn = at => {
  if (!at) return null;
  const when = at instanceof Date ? at : new Date(at);
  return Number.isNaN(when.getTime()) ? null : localDateStr(when);
};
export function newsletterCovers(dateStr, at) {
  const day = boughtOn(at);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '') || !day) return false;
  return currentWeek(dateStr)[0] > addDays(day, 1);
}
// Thursday's weekend issue: Friday to Sunday events, booked by Tuesday.
export function weekendCovers(dateStr, at) {
  if (!weekendIssue) return false;
  const day = boughtOn(at);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '') || !day) return false;
  const week = currentWeek(dateStr);
  return week.indexOf(dateStr) >= 4 && week[3] > addDays(day, 1);
}

// Where else a Vic’s Pick shows, worded for what's actually still possible
// (the checkout preview, the thank-you page and the confirmation email).
export function pickWhere(dateStr, at) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')) {
    return weekendIssue
      ? 'starred in the newsletter when it’s booked before the issue goes out (Monday’s covers the week, Thursday’s the weekend), and featured first in our social posts'
      : 'starred in the Monday newsletter when it’s booked before its week’s issue, and featured first in our social posts';
  }
  const long = d => formatDay(d, { month: 'long', day: 'numeric' });
  const week = currentWeek(dateStr);
  const issues = [
    newsletterCovers(dateStr, at) && `the Monday newsletter for the week of ${long(week[0])}`,
    weekendCovers(dateStr, at) && `Thursday’s weekend newsletter (${long(week[3])})`
  ].filter(Boolean);
  return issues.length
    ? `starred in ${issues.join(' and ')} and featured first in our social posts`
    : 'featured first in our social posts (its newsletter goes out before we could add it)';
}

// Resend's answer for a request it will never accept, whatever we retry:
// 400 and 422 are a malformed or refused message ("bob@gmail.com." as the
// recipient). Auth (401/403), rate (429) and server errors can clear up,
// so they stay retryable; deliver() counts an idempotency 409 as sent.
export const isPermanentSendError = err => Boolean(err) && (err.status === 400 || err.status === 422);

export function createMailer({ resend, config }) {
  const enabled = Boolean(config && config.enabled);
  // 'sent', 'failed' (worth retrying), 'refused' (never will be) or 'off'
  // (email not set up, or no address). Never throws.
  async function deliver(to, mail, idempotencyKey) {
    if (!enabled || !to) return 'off';
    // A masked address (j•••@gmail.com) is what an order keeps after its
    // buyer asked us to delete their data (server/privacy.js): no mail.
    if (String(to).includes('•')) return 'refused';
    try {
      await resend.send({
        from: config.from, to: [to], subject: mail.subject, html: mail.html, text: mail.text,
        ...(config.replyTo ? { reply_to: config.replyTo } : {})
      }, idempotencyKey);
      return 'sent';
    } catch (err) {
      // 409 on an idempotency key: Resend already accepted a message under
      // it (a send that timed out here but went out), now with different
      // content (the event was renamed meanwhile). Counting that as failed
      // retried it every 15 minutes for a day and then sent it twice. Same
      // as the newsletter. A request still in flight under the key
      // (concurrent_idempotent_requests) may yet fail, so that one retries.
      if (err && err.status === 409 && idempotencyKey &&
          err.code !== 'concurrent_idempotent_requests' && !/concurrent_idempotent_requests/.test(String(err.message))) {
        console.warn(`[notify] "${mail.subject}" already sent under its idempotency key; counting it as sent`);
        return 'sent';
      }
      console.warn(`[notify] "${mail.subject}" to a customer failed:`, err.message);
      return isPermanentSendError(err) ? 'refused' : 'failed';
    }
  }
  return {
    enabled,
    deliver,
    // Resolves to true when sent. Never throws.
    async send(to, mail, idempotencyKey) {
      return (await deliver(to, mail, idempotencyKey)) === 'sent';
    }
  };
}

const p = (html, style = '') => `<p style="margin:14px 0;font-size:15px;line-height:1.5;${style}">${html}</p>`;
const steps = items => `<ol style="margin:8px 0 14px;padding-left:22px;font-size:15px;line-height:1.55;">${items.map(i => `<li style="margin:4px 0;">${i}</li>`).join('')}</ol>`;
const box = html => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0;background:${C.sunLight};border:3px dashed ${C.ink};border-radius:16px;"><tr><td style="padding:14px 16px;font-size:15px;line-height:1.5;">${html}</td></tr></table>`;

function contactFooter(siteUrl, address) {
  const a = 'color:#FFC93C;';
  return `Questions or something not right? Just reply to this email, or reach us at <a href="${siteUrl}/contact" style="${a}">${town.domain}/contact</a>.<br>` +
    `${escHtml(town.siteName)} · ${escHtml(address || town.cityState)}`;
}
const contactText = siteUrl => `Questions or something not right? Reply to this email or reach us at ${siteUrl}/contact`;

function eventTable(ev, siteUrl) {
  const day = ev.date ? formatDay(ev.date, { weekday: 'long', month: 'long', day: 'numeric' }) : '';
  const row = eventRow({ ...ev, page: null, url: '', time: [day, ev.time].filter(Boolean).join(', ') }, siteUrl);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 4px;">${row}</table>`;
}

// ─── Free submission received ────────────────────────────────────────────

// Anyone can type any address into the public form, so this email carries
// none of the submitter's free text beyond a shortened event name (escaped):
// a fixed subject and no description, so it can't be used to mail strangers
// a message of the sender's choosing. Index.js also caps it per address.
// No paid upgrade offer: /submit promises the address isn't used for
// marketing (the form itself still mentions the paid option).
export function renderSubmissionReceived(ev, { siteUrl, address }) {
  const short = String(ev.name || '').slice(0, 80);
  const name = short ? (short.length < String(ev.name).length ? `${short}…` : short) : 'your event';
  ev = { ...ev, name, description: '', url: '' };
  const bodyHtml =
    p(`Thanks for sending in <strong>${escHtml(name)}</strong>. It's in our review queue. Here's what you sent:`) +
    eventTable(ev, siteUrl) +
    `<h2 style="font-size:18px;margin:20px 0 4px;">What happens next</h2>` +
    steps([
      'We review every submission, usually within the hour, and we’ll email you when it’s live; some need a closer look and take a day or two.',
      `If it's a fit, it goes on <a href="${siteUrl}" style="color:${C.accent};">${town.domain}</a> and can show up in our Monday and Thursday newsletters and our social posts.`,
      'Free listings aren’t guaranteed a spot, and we may tidy up the wording.'
    ]) +
    p('Need to change a detail? Reply to this email with the fix.', `color:${C.muted};font-size:14px;`);
  return {
    subject: 'We got your event submission',
    html: emailShell({ title: 'Thanks, we got it!', preheader: `${name} is in our review queue. Here's what happens next.`, bodyHtml, siteUrl,
      footerHtml: contactFooter(siteUrl, address) }),
    text: [
      `Thanks for sending in "${name}". It's in our review queue.`, '',
      eventLine(ev), '',
      'What happens next:',
      '1. We review every submission, usually within the hour, and we’ll email you when it’s live; some need a closer look and take a day or two.',
      `2. If it's a fit, it goes on ${siteUrl} and can show up in our Monday and Thursday newsletters and our social posts.`,
      '3. Free listings aren’t guaranteed a spot, and we may tidy up the wording.', '',
      'Need to change a detail? Reply to this email with the fix.',
      contactText(siteUrl)
    ].join('\n')
  };
}

// ─── Free submission approved and live ───────────────────────────────────

// `pick`: a paid Vic's Pick going live (and still pinned). No upgrade
// offer (they bought it) and no "we tidied the wording" (the buyer's words
// are kept). The newsletter line is worded from `at`, when they bought it,
// like the confirmation: a pick bought after its week's issue went out
// isn't promised the star. A free submission gets no upgrade offer (the
// submit form promises its address isn't used for marketing), and a paid
// pick that was refunded or hidden gets the same plain "you're live".
export function renderSubmissionLive(ev, { siteUrl, address, pageUrl, pick = false, at = null }) {
  const name = ev.name || 'your event';
  const link = pageUrl || siteUrl;
  const pickShare = `Share that link anywhere you promote the event. It’s ${pickWhere(ev.date, at)}.`;
  const lead = pick
    ? `Good news: <strong>${escHtml(name)}</strong> is live on ${town.siteName} as a ${town.pickName}, highlighted on its day.`
    : `Good news: <strong>${escHtml(name)}</strong> is now on ${town.siteName}.`;
  const bodyHtml =
    p(lead) +
    eventTable(ev, siteUrl) +
    `<div style="margin:16px 0;">${btn(link, 'See it on the site')}</div>` +
    p(pick ? escHtml(pickShare)
      : 'Share that link anywhere you promote the event. It can also show up in our Monday and Thursday newsletters and our social posts.') +
    p(pick ? 'Something wrong? Reply to this email with the fix.'
      : 'We may have tidied the wording a little. Something wrong? Reply to this email with the fix.', `color:${C.muted};font-size:14px;`);
  return {
    subject: pick ? `Your ${town.pickNamePlain} is live: ${name}` : `You're live: ${name}`,
    html: emailShell({ title: pick ? `Your ${town.pickName} is live!` : 'Your event is live!', preheader: `${name} is now on ${town.domain}.`, bodyHtml, siteUrl,
      footerHtml: contactFooter(siteUrl, address) }),
    text: [
      pick ? `Good news: "${name}" is live on ${town.siteName} as a ${town.pickNamePlain}, highlighted on its day.` : `Good news: "${name}" is now on ${town.siteName}.`, '',
      eventLine(ev), '',
      `See it: ${link}`,
      pick ? pickShare
        : 'Share that link anywhere you promote the event. It can also show up in our Monday and Thursday newsletters and our social posts.', '',
      pick ? 'Something wrong? Reply to this email with the fix.' : 'We may have tidied the wording a little. Something wrong? Reply to this email with the fix.',
      contactText(siteUrl)
    ].join('\n')
  };
}

// ─── Sponsorship paid ────────────────────────────────────────────────────

export function renderSponsorConfirmed(order, { siteUrl, address }) {
  const business = order.business || 'there';
  const receipt = 'Stripe emails your payment receipt separately.';
  if (order.kind === 'weekly') {
    const start = order.week_start;
    const week = start ? formatDay(start, { weekday: 'long', month: 'long', day: 'numeric' }) : 'your week';
    const s = order.sponsor || {};
    const href = safeUrl(s.url);
    const logo = /^\/sponsor-logo\/[A-Za-z0-9-]{8,64}$/.test(s.logo || '') ? `${siteUrl}${s.logo}` : '';
    const block = box(`<div style="font-size:11px;font-weight:bold;letter-spacing:.5px;">THIS WEEK'S SPONSOR</div>` +
      (logo ? `<div style="margin:8px 0 2px;"><img src="${escHtml(logo)}" alt="" style="display:block;max-height:60px;max-width:200px;height:auto;border:0;"></div>` : '') +
      `<div style="font-size:20px;font-weight:bold;margin:4px 0;">${escHtml(s.name || business)}</div>` +
      (s.text ? `<div>${escHtml(s.text)}</div>` : '') +
      (href ? `<div style="margin-top:8px;"><a href="${escHtml(href)}" style="color:${C.accent};font-weight:bold;">${escHtml(s.cta || 'Learn more')} →</a></div>` : ''));
    // A bank payment that cleared after that Monday's issue went out
    // (sponsors.js sets newsletter_missed) can't be promised the issue.
    const newsletterLine = order.newsletter_missed
      ? (order.newsletter_missed_both
        ? 'Your payment cleared after that week’s newsletters went out, so your block wasn’t in them. We’ll be in touch to make that up to you.'
        : 'Your payment cleared after that Monday’s newsletter went out, so your block wasn’t in it; it will be at the top of Thursday’s weekend issue. We’ll be in touch to make up for Monday’s.')
      : weekendIssue ? 'It’s also the sponsor spot at the top of that week’s newsletters: Monday’s, and Thursday’s weekend issue.'
        : 'It’s also the sponsor spot at the top of that Monday’s newsletter.';
    const bodyHtml =
      p(`Thanks, ${escHtml(business)}! Your payment went through and <strong>the week of ${escHtml(week)}</strong> is yours.`) +
      `<h2 style="font-size:18px;margin:20px 0 4px;">What happens next</h2>` +
      steps([
        `Your sponsor block goes live on its own on <strong>${escHtml(week)}</strong>, on every page of ${town.domain} for the whole week.`,
        escHtml(newsletterLine),
        'The Monday after your week, we’ll email you how it did: how many times people saw your block, where, and how many clicked through.'
      ]) +
      p('Here’s your block as it will run:') + block +
      p(`Want to change the wording or link before it goes live? Reply to this email. ${receipt}`, `color:${C.muted};font-size:14px;`);
    return {
      subject: `You're booked: ${town.siteName} sponsor, week of ${formatDay(start, { month: 'short', day: 'numeric' })}`,
      html: emailShell({ title: 'You’re booked!', preheader: `Your sponsor block goes live ${week}.`, bodyHtml, siteUrl,
        footerHtml: contactFooter(siteUrl, address) }),
      text: [
        `Thanks, ${business}! Your payment went through and the week of ${week} is yours.`, '',
        'What happens next:',
        `1. Your sponsor block goes live on its own on ${week}, on every page of ${town.domain} for the whole week.`,
        `2. ${newsletterLine}`,
        '3. The Monday after your week, we’ll email you how it did: how many times people saw your block, where, and how many clicked through.', '',
        `Your block: ${s.name || business}: ${s.text || ''} ${href ? `(${s.cta || 'Learn more'}: ${href})` : ''}`.trim(), '',
        `Want to change the wording or link before it goes live? Reply to this email. ${receipt}`,
        contactText(siteUrl)
      ].join('\n')
    };
  }
  // Vic’s Pick
  const ev = order.event || {};
  const day = ev.date ? formatDay(ev.date, { weekday: 'long', month: 'long', day: 'numeric' }) : 'its day';
  // Worded from when they bought it: a pick bought after its week's
  // newsletter went out isn't promised one.
  const where = pickWhere(ev.date, order.paid_at || order.created_at);
  const bodyHtml =
    p(`Thanks, ${escHtml(business)}! Your payment went through and <strong>${escHtml(ev.name || 'your event')}</strong> is a ${town.pickName}.`) +
    eventTable({ ...ev, featured: true }, siteUrl) +
    `<h2 style="font-size:18px;margin:20px 0 4px;">What happens next</h2>` +
    steps([
      'We check the details and publish it, usually within the hour, and email you when it’s live. If anything needs fixing, we’ll email you.',
      `Then it’s <strong>highlighted on ${escHtml(day)}</strong> on ${town.domain} and its event page, with the ${town.pickName} badge.`,
      `It’s ${escHtml(where)}.`,
      'The day after your event, we’ll email you how it did: how many times it was seen, page views, clicks to your link, calendar adds and shares.'
    ]) +
    p(`Need to change a detail? Reply to this email. ${receipt}`, `color:${C.muted};font-size:14px;`);
  return {
    subject: `Your ${town.pickNamePlain} is confirmed: ${ev.name || 'your event'}`,
    html: emailShell({ title: `You’re a ${town.pickName}!`, preheader: `${ev.name || 'Your event'} will be highlighted on ${day}.`, bodyHtml, siteUrl,
      footerHtml: contactFooter(siteUrl, address) }),
    text: [
      `Thanks, ${business}! Your payment went through and "${ev.name || 'your event'}" is a ${town.pickNamePlain}.`, '',
      eventLine(ev), '',
      'What happens next:',
      '1. We check the details and publish it, usually within the hour, and email you when it’s live. If anything needs fixing, we’ll email you.',
      `2. Then it's highlighted on ${day} on ${town.domain} and its event page, with the ${town.pickNamePlain} badge.`,
      `3. It's ${where}.`,
      '4. The day after your event, we’ll email you how it did: how many times it was seen, page views, clicks to your link, calendar adds and shares.', '',
      `Need to change a detail? Reply to this email. ${receipt}`,
      contactText(siteUrl)
    ].join('\n')
  };
}

// ─── Paid too late ───────────────────────────────────────────────────────
// A bank payment settled only after the pick's date (or the sponsor week)
// had passed, so there's nothing left to book. The owner gets a Slack alert
// to refund it in Stripe (our restricted key can't); this tells the buyer.

export function renderSponsorTooLate(order, { siteUrl, address }) {
  const business = order.business || 'there';
  const what = order.kind === 'weekly'
    ? `the sponsor week of ${formatDay(order.week_start, { month: 'long', day: 'numeric' })}`
    : `${(order.event && order.event.name) || 'your event'} as a ${town.pickName} on ${order.event && order.event.date ? formatDay(order.event.date, { weekday: 'long', month: 'long', day: 'numeric' }) : 'its day'}`;
  const lines = [
    `Thanks, ${business}. Your bank payment for ${what} only cleared after that date had passed, so we couldn't run it.`,
    'We’re refunding you in full. You’ll see it from Stripe within a few business days; nothing else is needed from you.',
    'Want to book another date instead? Reply to this email and we’ll set it up.'
  ];
  return {
    subject: `Your ${town.shortName} payment cleared too late: we’re refunding you`,
    html: emailShell({ title: 'Sorry, that date has passed', preheader: 'We’re refunding your payment in full.', siteUrl,
      bodyHtml: lines.map(l => p(escHtml(l))).join(''), footerHtml: contactFooter(siteUrl, address) }),
    text: [...lines, contactText(siteUrl)].join('\n\n')
  };
}

// What the order paid for, for the failed and double-booked emails.
function orderWhat(order) {
  return order.kind === 'weekly'
    ? `the sponsor week of ${formatDay(order.week_start, { month: 'long', day: 'numeric' })}`
    : `${(order.event && order.event.name) || 'your event'} as a ${town.pickName} on ${order.event && order.event.date ? formatDay(order.event.date, { weekday: 'long', month: 'long', day: 'numeric' }) : 'its day'}`;
}

// ─── Bank payment failed ─────────────────────────────────────────────────
// A bank debit (ACH) that bounced (checkout.session.async_payment_failed).
// The thank-you page told them their spot was held until it cleared, and
// Stripe doesn't email Checkout customers about a failed one-time debit, so
// without this they'd think they're booked while the slot is resold.

export function renderSponsorPaymentFailed(order, { siteUrl, address }) {
  const business = order.business || 'there';
  const unit = order.kind === 'weekly' ? 'week' : 'day';
  const again = `${siteUrl}/advertise/checkout?package=${order.kind === 'weekly' ? 'weekly' : 'featured'}`;
  const lines = [
    `Hi ${business}. Your bank payment for ${orderWhat(order)} didn’t go through, so nothing was charged and you’re not booked.`,
    `We’ve released the ${unit} we were holding for you, so someone else can book it now. If you still want it, book again (a card settles at once).`
  ];
  return {
    subject: `Your ${town.shortName} payment didn’t go through`,
    html: emailShell({ title: 'Your payment didn’t go through', preheader: `Nothing was charged; the ${unit} is open again.`, siteUrl,
      bodyHtml: lines.map(l => p(escHtml(l))).join('') + `<div style="margin:16px 0;">${btn(again, 'Book again')}</div>`,
      footerHtml: contactFooter(siteUrl, address) }),
    text: [...lines, `Book again: ${again}`, contactText(siteUrl)].join('\n\n')
  };
}

// ─── Double-booked ───────────────────────────────────────────────────────
// Two buyers paid for one week (or a full Vic's Pick day): the second isn't
// put live (status 'conflict'). The thank-you page explains it, but a buyer
// who closed the tab would only have Stripe's receipt. The owner refunds
// in Stripe (our restricted key can't) or moves them to an open slot.

export function renderSponsorConflict(order, { siteUrl, address }) {
  const business = order.business || 'there';
  const unit = order.kind === 'weekly' ? 'week' : 'day';
  const lines = [
    `Thanks, ${business}. Your payment for ${orderWhat(order)} went through, but that ${unit} was booked by someone else moments before you, so it isn’t running. Sorry about that.`,
    `Your payment will be refunded in full (Stripe shows it within a few business days), unless you’d rather move to another open ${unit}: just reply to this email and we’ll set it up.`,
    'We’ll be in touch within 1 business day either way.'
  ];
  return {
    subject: `Your ${town.shortName} ${unit} was double-booked: we’ll refund or move you`,
    html: emailShell({ title: `That ${unit} was just booked`, preheader: `Your payment will be refunded, or moved to another ${unit} if you prefer.`, siteUrl,
      bodyHtml: lines.map(l => p(escHtml(l))).join(''), footerHtml: contactFooter(siteUrl, address) }),
    text: [...lines, contactText(siteUrl)].join('\n\n')
  };
}

// ─── Sponsor reports ─────────────────────────────────────────────────────
// Weekly sponsors get theirs the Monday after their week, Vic's Picks the
// day after their event (server/sponsors.js sendSponsorReports /
// sendPickReports). People are counted once a day each, so a double tap or
// a mail scanner doesn't pad the number. Newsletter opens are tracked
// (email_opens) but left out here: Apple Mail's image preloading inflates
// them, so a sponsor's newsletter line only says how many it was sent to.

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const people = n => plural(n, 'person', 'people');

// A two-column table that stays readable on a phone (label left, number right).
function statsTable(rows) {
  const line = i => (i ? `border-top:2px dashed ${C.line};` : '');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0;border:3px solid ${C.ink};border-radius:14px;border-collapse:separate;">` +
    rows.map(([k, v], i) => `<tr><td style="padding:10px 14px;font-size:15px;${line(i)}">${escHtml(k)}</td>` +
      `<td align="right" style="padding:10px 14px;font-size:17px;font-weight:bold;white-space:nowrap;${line(i)}">${escHtml(v)}</td></tr>`).join('') +
    '</table>';
}

// "Where it ran": views by page type, as a small list under the table.
function whereHtml(where) {
  if (!where || !where.length) return '';
  return `<h2 style="font-size:17px;margin:20px 0 4px;">Where people saw it</h2>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 10px;font-size:15px;">` +
    where.map(w => `<tr><td style="padding:3px 0;">${escHtml(w.type)}</td><td align="right" style="padding:3px 0;font-weight:bold;">${escHtml(plural(w.views, 'view', 'views'))}</td></tr>`).join('') +
    '</table>';
}
const whereText = where => (where && where.length ? ['Where people saw it:', ...where.map(w => `- ${w.type}: ${plural(w.views, 'view', 'views')}`), ''] : []);

const COUNTER_NOTE = 'These numbers come from our privacy-friendly counter, which some browsers block, so the real numbers can be a bit higher. A view means at least half of it was on someone’s screen for a second.';

export function renderSponsorReport(order, stats, { siteUrl, address }) {
  const business = order.business || 'there';
  const short = { month: 'short', day: 'numeric' };
  const range = `${formatDay(stats.week_start, short)} – ${formatDay(stats.week_end, short)}`;
  const total = stats.site_people + stats.email_people + (Number(stats.social_people) || 0);
  const views = Number(stats.views) || 0;
  const rows = [
    ...(views ? [[`Your block was seen on ${town.domain}`, plural(views, 'time', 'times')]] : []),
    [`Clicked your button on ${town.domain}`, people(stats.site_people)],
    ['Clicked your button in our emails', people(stats.email_people)],
    ...(stats.social_people ? [[`Clicked your link in our ${town.instagram ? 'Facebook and Instagram' : 'Facebook'} posts`, people(stats.social_people)]] : []),
    ...(stats.newsletter_recipients ? [[stats.newsletter_issues > 1 ? 'Newsletter copies with your block (Monday and Thursday issues)' : 'Newsletter copies with your block',
      String(stats.newsletter_recipients)]] : []),
    ...(stats.site_visitors ? [[`Visits to ${town.domain} that week`, String(stats.site_visitors)]] : [])
  ];
  const bodyHtml =
    p(`Thanks for sponsoring ${town.siteName}, ${escHtml(business)}! Here’s how your week (${escHtml(range)}) went.`) +
    p(`<strong>${escHtml(people(total))}</strong> clicked through to you in total.`, 'font-size:17px;') +
    statsTable(rows) +
    whereHtml(stats.where) +
    p(`${escHtml(COUNTER_NOTE)} In your own analytics our visits are tagged utm_source=${town.utmSource}.`, `color:${C.muted};font-size:13px;`) +
    box(`<strong>Want another week?</strong> One sponsor a week, so book early.<br><br>${btn(`${siteUrl}/advertise/checkout?package=weekly`, 'Book another week')}`);
  return {
    subject: `Your ${town.shortName} sponsor week: ${people(total)} clicked`,
    html: emailShell({ title: 'Your sponsor report', preheader: `${people(total)} clicked through to ${business} during ${range}.`, bodyHtml, siteUrl,
      footerHtml: contactFooter(siteUrl, address) }),
    text: [
      `Thanks for sponsoring ${town.siteName}, ${business}! Here's how your week (${range}) went.`, '',
      `${people(total)} clicked through to you in total.`,
      ...rows.map(([k, v]) => `- ${k}: ${v}`), '',
      ...whereText(stats.where),
      COUNTER_NOTE, '',
      `Want another week? ${siteUrl}/advertise/checkout?package=weekly`,
      contactText(siteUrl)
    ].join('\n')
  };
}

export function renderPickReport(order, stats, { siteUrl, address }) {
  const business = order.business || 'there';
  const name = (order.event && order.event.name) || 'your event';
  const shown = Number(stats.shown) || 0;
  const rows = [
    [`Shown in our event lists as a ${town.pickName}`, plural(shown, 'time', 'times')],
    ['Views of its event page', String(stats.page_views || 0)],
    ['Clicked through to your link', people(stats.link_people || 0)],
    ['Added it to their calendar', String(stats.calendar_adds || 0)],
    ['Shared it', String(stats.shares || 0)],
    ['Opened it from a shared link', people(stats.share_people || 0)],
    ...(stats.newsletter_starred ? [[stats.newsletter_issues > 1 ? 'Starred in both newsletters (Monday and Thursday), copies sent' : 'Starred in the newsletter, sent to',
      stats.newsletter_issues > 1 ? String(stats.newsletter_recipients) : `${stats.newsletter_recipients} subscribers`]] : [])
  ];
  const headline = `${name} was seen ${plural(shown, 'time', 'times')} as a ${town.pickName}.`;
  const bodyHtml =
    p(`Thanks for making <strong>${escHtml(name)}</strong> a ${town.pickName}, ${escHtml(business)}! Here’s how it did on ${town.siteName}.`) +
    statsTable(rows) +
    whereHtml(stats.where) +
    p(escHtml(COUNTER_NOTE), `color:${C.muted};font-size:13px;`) +
    box(`<strong>Got another event coming up?</strong> Make it stand out on its day too.<br><br>${btn(`${siteUrl}/advertise/checkout?package=featured`, `Give it the ${town.pickName} badge`)}`);
  return {
    subject: `Your ${town.pickNamePlain} report: ${name}`,
    html: emailShell({ title: `Your ${town.pickName} report`, preheader: headline, bodyHtml, siteUrl,
      footerHtml: contactFooter(siteUrl, address) }),
    text: [
      `Thanks for making "${name}" a ${town.pickNamePlain}, ${business}! Here's how it did on ${town.siteName}.`, '',
      ...rows.map(([k, v]) => `- ${k}: ${v}`), '',
      ...whereText(stats.where),
      COUNTER_NOTE, '',
      `Got another event coming up? Give it the ${town.pickNamePlain} badge: ${siteUrl}/advertise/checkout?package=featured`,
      contactText(siteUrl)
    ].join('\n')
  };
}
