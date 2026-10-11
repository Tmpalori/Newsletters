/* server/newsletter.js — Own email newsletter, sent through Resend.
 *
 * The homepage signup form always shows. Signups are single opt-in: a new
 * address goes straight on the list and, once RESEND_API_KEY is set, gets
 * the welcome email right away.
 *
 *   - Signup: POST /api/subscribe → active subscriber + welcome email. Only
 *     a comeback (someone who unsubscribed) gets a confirmation email
 *     instead, so nobody else can sign them back up. Forms say where
 *     they are (`source`); docs/track.js adds ":ad" for visitors who
 *     arrived from a paid ad, so the Slack ping shows what's working.
 *   - GET /subscribe is the signup page every Subscribe button points at
 *     (and where ads should land): the pitch, the form, and a taste of
 *     this week's events.
 *     The answer is the same whether the address is new, waiting or already
 *     subscribed, and confirmation emails are capped per address.
 *   - GET /subscribe/confirm?token=… and /unsubscribe?token=… only show a
 *     one-button page (mail link scanners open every link); the POST
 *     confirms or removes. POST /unsubscribe is also the RFC 8058 one-click
 *     target mail clients use.
 *   - Two issues a week, built from the published events (sponsor block
 *     first, featured first; links back to the site carry
 *     utm_source=newsletter) and sent with Resend's batch API, each copy
 *     with its own unsubscribe link:
 *       weekly   Monday 7:43 AM Central: the rest of the week. Keyed by the
 *                week's Monday (newsletter_sends.week_key).
 *       weekend  Thursday 7:00 AM: Friday through Sunday. Keyed by the
 *                week's Thursday, so it's its own send, open count and row
 *                in the admin. Readers can turn it off and keep Monday's
 *                (/email-prefs, `weekend_optout`); NEWSLETTER_WEEKEND=0 in
 *                Railway stops it for everyone.
 *     One send per issue: a second attempt is refused unless forced.
 *   - Referrals: every subscriber gets a link, /r/<code> (→ /subscribe?ref=,
 *     kept for the visit by docs/track.js and sent with the form). A new
 *     signup through it records referred_by and must be confirmed by email; it
 *     counts for the sharer once the friend has been on the list a day and
 *     while they stay subscribed, one per inbox (see emailKey in db.js).
 *     The welcome email and each Monday copy show the reader's link and
 *     progress (REFERRAL_TIERS); Monday's send Slacks the owner who just
 *     earned a reward, once per tier (rewards go out by hand).
 *   - Open tracking: each weekly copy has a 1x1 image,
 *     /email/o/<week>/<subscriber id>.gif, counted once per subscriber per
 *     issue (email_opens) and shown as opens and open rate per send in the
 *     admin. Welcome, confirmation and test emails have none.
 *   - Admin: counts, preview, test send, send now, CSV/paste import.
 *   - Automation: the site's scheduler (server/scheduler.js) sends both
 *     issues. POST /api/newsletter/cron with X-Cron-Secret is the Monday
 *     fallback, called by .github/workflows/newsletter.yml. Monday's run
 *     also sends last week's sponsor reports and any Vic's Pick reports due
 *     (onCron, server/sponsors.js).
 */

import { town } from './town.js';
import crypto from 'node:crypto';
import { emailKey } from './db.js';
import { honeypotTripped } from './honeypot.js';
import { referralTiers, referralFlags, createReferralRewards } from './referralRewards.js';

export { referralTiers, referralFlags };
import { inboundConfig } from './inbound.js';
import {
  escHtml, safeUrl, localDateStr, currentWeek, formatDay, sortEvents, layout, addDays, renderEventItem, pickRank, parseTimes,
  sponsorLinkUrl, formatTime, placeText, iconKeys, isSponsorLogo, SAMPLE_LOGO, isPaidPick, AD_LABEL
} from './seo.js';
import { operatorHtml, operatorName, mailingAddress, emailLink, versionDate, REFERRAL_RULES_VERSION } from './legal.js';

const RESEND_API = 'https://api.resend.com';
// Strict enough that Resend accepts every address we keep: no empty dot
// segments ("bob@gmail..com", ".bob@"), domain labels of letters, digits
// and inner hyphens, and a real TLD. Matched after lowercasing.
const EMAIL_RE = /^[^\s@<>"',;.]+(?:\.[^\s@<>"',;.]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const BATCH_SIZE = 100;          // Resend batch limit
const PER_DAY = 6;               // events per day in the email

export function newsletterConfig(env = process.env, overrides = {}) {
  const c = {
    apiKey: overrides.resendApiKey ?? env.RESEND_API_KEY ?? '',
    from: overrides.newsletterFrom ?? env.NEWSLETTER_FROM ?? town.emailFrom,
    replyTo: overrides.newsletterReplyTo ?? env.NEWSLETTER_REPLY_TO ?? '',
    address: overrides.newsletterAddress ?? env.NEWSLETTER_ADDRESS ?? '',
    cronSecret: overrides.newsletterCronSecret ?? env.NEWSLETTER_CRON_SECRET ?? '',
    testTo: overrides.newsletterTestTo ?? env.NEWSLETTER_TEST_TO ?? '',
    // Replies to news@ reach Slack (server/inbound.js) once receiving is set up.
    inbound: inboundConfig(env, overrides).enabled
  };
  c.enabled = Boolean(c.apiKey);
  // The one switch for the automatic Monday send (Railway variable): on
  // unless NEWSLETTER_AUTOSEND=0. The site's scheduler (server/scheduler.js)
  // sends at 7:43 AM Central; newsletter.yml's late GitHub cron is only a
  // fallback and is told no when this is off.
  c.autosend = String(overrides.newsletterAutosend ?? env.NEWSLETTER_AUTOSEND ?? '1') !== '0';
  // The Thursday weekend issue: on unless NEWSLETTER_WEEKEND=0.
  c.weekend = String(overrides.newsletterWeekend ?? env.NEWSLETTER_WEEKEND ?? '1') !== '0';
  return c;
}

// The two issues. key: the send's id (newsletter_sends.week_key), the
// week's Monday or Thursday; days: the dates the issue lists.
export const EDITIONS = {
  weekly: { key: today => currentWeek(today)[0], days: today => currentWeek(today).filter(d => d >= today) },
  weekend: { key: today => currentWeek(today)[3], days: today => currentWeek(today).slice(4).filter(d => d >= today) }
};
// Which issue a send was, from its key's weekday (Thursday is the weekend one).
export function editionOf(weekKey) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(weekKey || '')) && new Date(`${weekKey}T12:00:00Z`).getUTCDay() === 4 ? 'weekend' : 'weekly';
}
// How the newsletter is described in its pages and emails. Copy elsewhere
// (seo.js pages, docs/app.js, social captions, sponsor promises) says the
// same in its own words. NEWSLETTER_WEEKEND=0 is a stopgap switch: it
// stops the Thursday send and its settings link, not this wording.
export const SCHEDULE = 'every Monday and Thursday';

export function normalizeEmail(raw) {
  const e = String(raw || '').trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

// "j•••@gmail.com": enough for someone to recognize their own address.
export function maskEmail(email) {
  const [user, domain] = String(email || '').split('@');
  if (!user || !domain) return '';
  return `${user[0]}•••@${domain}`;
}

// Resend keeps an idempotency key for 24 hours. A batch that may have gone
// out (asked, no definite answer) is only sent again under its key inside
// this window, with an hour's margin for clock skew and a slow request.
export const KEY_WINDOW_MS = 23 * 3600e3;

// What a failed weekly batch means, from Resend's error:
//   'sent'    the key was already used within its 24 hours: an earlier try
//             went out. Resend answers 409 invalid_idempotent_request when
//             the payload differs (someone left the chunk, or the issue was
//             re-rendered on a later day), so that counts as delivered;
//             never a new key, which would mail the chunk twice.
//   'unknown' still in flight under the key (409
//             concurrent_idempotent_requests: another container is sending
//             it, and that request may yet fail), a timeout or a network
//             error: possibly sent, so it's retried later under the same key
//             (like notify.js deliver).
//   'failed'  any other HTTP error: Resend didn't send it.
export function batchErrorOutcome(err) {
  const code = String((err && err.code) || '');
  const msg = String((err && err.message) || '');
  if (code === 'concurrent_idempotent_requests' || /concurrent_idempotent_requests/.test(msg)) return 'unknown';
  if ((err && err.status === 409) || code === 'invalid_idempotent_request') return 'sent';
  return err && err.status ? 'failed' : 'unknown';
}

export function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

// ─── Resend client ───────────────────────────────────────────────────────

// Resend calls give up after RESEND_TIMEOUT_MS. Without it a Resend that
// accepts the connection and never answers holds the caller for undici's
// 5-minute default: the sponsor confirmation, the reports and the weekly
// batch all wait on it, and so would anything queued behind them.
export const RESEND_TIMEOUT_MS = 15000;

export function createResend(apiKey, fetchImpl = globalThis.fetch, { timeoutMs = RESEND_TIMEOUT_MS } = {}) {
  async function call(path, body, idempotencyKey, extraHeaders = {}) {
    // One signal for the request and the body read below.
    const res = await fetchImpl(`${RESEND_API}${path}`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        ...extraHeaders
      },
      body: JSON.stringify(body)
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      const err = new Error(`Resend ${path} HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
      err.status = res.status;
      // Resend's error name ("invalid_idempotent_request"...), for callers
      // that branch on more than the status.
      if (json && typeof json.name === 'string') err.code = json.name;
      throw err;
    }
    return json;
  }
  return {
    send: (msg, key) => call('/emails', msg, key),
    // Batch validation is strict by default: one address Resend refuses
    // fails all 100 messages. Permissive sends the rest and lists the
    // refused ones in `errors` ({ index, message }).
    batch: (msgs, key) => call('/emails/batch', msgs, key, { 'x-batch-validation': 'permissive' })
  };
}

// ─── Email content ───────────────────────────────────────────────────────

// Same cartoon identity as the site (docs/style.css): ink outlines, sticker
// colors, rounded type. Email clients can't load icons.svg or web fonts
// reliably, so icons and the skyline are PNGs in docs/email/ and the font
// stack falls back to rounded system faces.
export const C = {
  bg: '#FFF4D6', card: '#FFFFFF', ink: '#1F1A3D', muted: '#554E7A', accent: '#4B3FD1',
  line: '#E8D9AE', sun: '#FFC93C', sunLight: '#FFF0BF', sunset: '#FF7A3D', navy: '#2B2370', sky: '#DDF2FF'
};
const DAY_COLORS = ['#FFC93C', '#8FD3FF', '#FF8FC0', '#3DBE8B', '#FF7A3D', '#B9A6FF', '#FF8A80'];
const ICON_KEYS = new Set(['food', 'music', 'family', 'drinks', 'arts', 'shopping', 'outdoors', 'community', 'free']);
const DISPLAY = "'Fredoka','Baloo 2','Trebuchet MS',Arial,sans-serif";
const BODY = "'Nunito','Helvetica Neue',Arial,sans-serif";
// "+N more" links: a small ink-outlined pill, like the site's chips.
const MORE_PILL = `display:inline-block;font-family:${DISPLAY};font-weight:bold;font-size:14px;color:${C.ink};border:2px solid ${C.ink};border-radius:999px;box-shadow:2px 2px 0 ${C.ink};padding:5px 14px;text-decoration:none;`;
export const btn = (href, label) => `<a href="${escHtml(href)}" style="display:inline-block;background:${C.accent};color:#fff;font-family:${DISPLAY};font-weight:bold;font-size:16px;padding:11px 22px;border:3px solid ${C.ink};border-radius:999px;box-shadow:3px 3px 0 ${C.ink};text-decoration:none;">${escHtml(label)}</a>`;

// ─── Dark mode ───────────────────────────────────────────────────────────
// Email apps decide how a message looks in dark mode, and they disagree:
//   - Apple Mail honors color-scheme "light only" and leaves it alone.
//   - Outlook (web, new Mac/Windows, phone) recolors anyway, but it never
//     recolors background *images*, and it marks what it recolored with
//     data-ogsc (text) / data-ogsb (background), which a <style> can target.
//   - Classic Outlook for Windows inverts everything; Gmail's apps recolor
//     too. Nothing reliable stops them, so the design has to read well
//     inverted (solid backgrounds, dark outlines, no mid-tone text).
// darkSafe() runs over the finished HTML: every inline background color is
// also painted as a one-color gradient (an image to Outlook), and every
// colored element gets a class the Outlook rules use to put its colors back.
const colorKey = c => c.slice(1).toLowerCase();

export function darkSafe(html) {
  const bgs = new Set(), texts = new Set();
  const body = html.replace(/<(table|td|div|span|a|p|body)\b([^>]*?)\sstyle="([^"]*)"([^>]*)>/gi, (tag, name, before, style, after) => {
    const classes = [];
    let bgHex = null;
    style = style.replace(/(^|;)\s*background(?:-color)?\s*:\s*(#[0-9a-f]{3,6})\s*(?=;|$)/i, (m, sep, hex) => {
      bgHex = hex;
      bgs.add(colorKey(hex));
      classes.push(`b-${colorKey(hex)}`);
      return `${sep}background-color:${hex};background-image:linear-gradient(${hex},${hex})`;
    });
    const fg = /(^|;)\s*color\s*:\s*(#[0-9a-f]{3,6})/i.exec(style);
    if (fg) { texts.add(colorKey(fg[2])); classes.push(`t-${colorKey(fg[2])}`); }
    if (!classes.length) return tag;
    let attrs = `${before}${after}`;
    // Classic Outlook for Windows reads the old bgcolor attribute.
    const bgcolor = bgHex && /^(table|td|body)$/i.test(name) && !/\bbgcolor=/i.test(attrs) ? ` bgcolor="${bgHex}"` : '';
    if (/\bclass="/i.test(attrs)) attrs = attrs.replace(/\bclass="([^"]*)"/i, (m, c) => `class="${c} ${classes.join(' ')}"`);
    else attrs += ` class="${classes.join(' ')}"`;
    return `<${name}${attrs}${bgcolor} style="${style}">`;
  });
  const rules = [
    // Outlook marks the recolored element itself or a wrapper; cover both.
    ...[...bgs].map(k => `[data-ogsb].b-${k},[data-ogsb] .b-${k}{background-color:#${k} !important;background-image:linear-gradient(#${k},#${k}) !important}`),
    ...[...texts].map(k => `[data-ogsc].t-${k},[data-ogsc] .t-${k}{color:#${k} !important}`)
  ];
  // Two blocks: Gmail drops a whole <style> it doesn't understand, and the
  // Outlook attribute selectors are the part it might not.
  const head = `<style>:root{color-scheme:light only;supported-color-schemes:light only}</style>\n<style>${rules.join('\n')}</style>`;
  return body.replace('</head>', () => `${head}</head>`);
}

// Invisible spacers after the preheader, so inbox previews (Gmail, iOS)
// stop at the preheader instead of running on into the header text.
const PREHEADER_FILLER = '&#847;&zwnj;&nbsp;'.repeat(80);

// The header wordmark: the town's two-tone title (town.siteNameHtml, "The Vic
// <span>361</span>") as bold text plus a yellow badge for the <span> part.
function emailWordmark() {
  const m = /^(.*?)\s*<span>(.*)<\/span>\s*$/.exec(town.siteNameHtml);
  const text = `<span style="font-size:22px;font-weight:bold;">${m ? m[1] : town.siteNameHtml}</span>`;
  return m ? `${text} <span style="display:inline-block;font-size:18px;font-weight:bold;background:${C.sun};border:3px solid ${C.ink};border-radius:8px;padding:0 6px;">${m[2]}</span>` : text;
}

export function emailShell({ title, preheader, bodyHtml, footerHtml, siteUrl, pixelUrl = '' }) {
  return darkSafe(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only"><title>${escHtml(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@600;700&family=Nunito:wght@400;700;800&display=swap" rel="stylesheet"></head>
<body style="margin:0;padding:0;background:${C.bg};">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;">${escHtml(preheader || '')}${PREHEADER_FILLER}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${C.card};border:3px solid ${C.ink};border-radius:20px;box-shadow:6px 6px 0 ${C.ink};overflow:hidden;">
<tr><td align="center" style="background:${C.sky};padding:22px 24px 0;font-family:${DISPLAY};color:${C.ink};">
<div>${emailWordmark()}</div>
<div style="font-size:30px;font-weight:bold;line-height:1.15;margin:10px 0 12px;">${escHtml(title)}</div></td></tr>
<tr><td style="background:${C.sky};padding:0;line-height:0;border-bottom:3px solid ${C.ink};"><img src="${siteUrl}/email/skyline.png" width="600" alt="" style="display:block;width:100%;max-width:600px;height:auto;border:0;"></td></tr>
<tr><td style="padding:8px 22px 26px;font-family:${BODY};color:${C.ink};font-size:15px;line-height:1.5;">${bodyHtml}</td></tr>
<tr><td style="background:${C.navy};padding:18px 24px;border-top:3px solid ${C.ink};font-family:${BODY};color:#D6CFFF;font-size:12px;line-height:1.6;font-weight:bold;">${footerHtml}</td></tr>
</table></td></tr></table>${pixelUrl ? `<img src="${escHtml(pixelUrl)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;">` : ''}</body></html>`);
}

function footer({ siteUrl, unsubscribeUrl, address, prefsUrl = '', edition = 'weekly' }) {
  const a = 'color:#FFC93C;';
  const prefs = prefsUrl
    ? `<br><a href="${escHtml(prefsUrl)}" style="${a}">${edition === 'weekend' ? 'Just want Mondays? Skip the weekend email' : 'Email settings'}</a>` : '';
  return `Forwarded this? <a href="${siteUrl}/subscribe" style="${a}">Get it free ${SCHEDULE}</a>.<br>
You're getting this because you subscribed at <a href="${siteUrl}" style="${a}">${town.domain}</a>.<br>
<a href="${escHtml(unsubscribeUrl)}" style="${a}">Unsubscribe</a> · <a href="${siteUrl}/advertise" style="${a}">Advertise</a> · <a href="${siteUrl}/submit" style="${a}">Submit an event</a>${prefs}<br>
${escHtml(town.siteName)}${address ? ` · ${escHtml(address)}` : ` · ${town.cityState}`}`;
}

// Up to three icons, the site's set (iconKeys: `free: true` is the Free
// icon). Free always makes the cut: it's the one readers scan for.
function iconImgs(ev, siteUrl) {
  const keys = iconKeys(ev).filter(k => ICON_KEYS.has(k));
  const shown = keys.slice(0, 3);
  if (keys.includes('free') && !shown.includes('free')) shown[2] = 'free';
  return shown
    .map(k => `<img src="${siteUrl}/email/${k}.png" width="22" height="22" alt="" style="vertical-align:middle;border:0;margin-right:2px;">`).join('');
}

// "7 PM" / "7:30 AM": the start of an event's time, with AM/PM even when
// the stored range shares one ("4-10 p.m." starts at 4 PM), or ''.
function clockOf(time) {
  const t = parseTimes(time)[0];
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}`;
}

// A Vic's Pick is its own yellow card with space around it, so the dashed
// divider is left off the row just above one (`next` is the row after).
export function eventRow(ev, siteUrl, next) {
  const link = ev.page ? `${siteUrl}${ev.page}` : (safeUrl(ev.url) || siteUrl);
  // Same place line and "Nearby · Cuero" tag as the site's list items.
  const where = placeText(ev);
  const rowStyle = ev.featured
    ? `padding:10px 12px;background:${C.sunLight};border:2px solid ${C.ink};border-radius:12px;`
    : `padding:10px 4px;${next?.featured ? '' : `border-bottom:2px dashed ${C.line};`}`;
  const open = ev.featured
    ? `<tr><td style="padding:6px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;"><tr><td style="${rowStyle}">`
    : `<tr><td style="${rowStyle}">`;
  const close = ev.featured ? '</td></tr></table></td></tr>' : '</td></tr>';
  return `${open}
${ev.featured ? `<span style="display:inline-block;background:${C.sunset};color:${C.ink};font-family:${DISPLAY};font-size:11px;font-weight:bold;padding:1px 8px;border:2px solid ${C.ink};border-radius:999px;margin-right:4px;">★ ${escHtml(town.pickName.toUpperCase())}</span>` : ''}
${ev.town ? `<span style="display:inline-block;background:${C.sky};color:${C.ink};font-family:${DISPLAY};font-size:11px;font-weight:bold;padding:1px 8px;border:2px solid ${C.ink};border-radius:999px;margin-right:4px;">Nearby · ${escHtml(ev.town)}</span>` : ''}
${iconImgs(ev, siteUrl)}
${ev.time ? `<span style="display:inline-block;font-family:${DISPLAY};font-weight:bold;font-size:12px;padding:0 8px;border:2px solid ${C.ink};border-radius:999px;margin-right:4px;">${escHtml(formatTime(ev.time))}</span>` : ''}
<a href="${escHtml(link)}" style="color:${C.ink};font-weight:800;text-decoration:none;">${escHtml(ev.name)}</a>${where ? ` <span style="color:${C.muted};">· ${escHtml(where)}</span>` : ''}${ev.also ? ` <span style="color:${C.muted};font-size:13px;font-weight:bold;">· also ${escHtml(ev.also)}</span>` : ''}
${ev.description || paidPick(ev) ? `<div style="color:${C.muted};font-size:13px;margin-top:2px;">${escHtml(ev.description || '')}${paidPick(ev) ? ` <span style="font-size:11px;">${AD_LABEL}</span>` : ''}</div>` : ''}
${close}`;
}

// Email apps send no referrer, so links back to the site carry UTM tags
// (server/analytics.js maps utm_source=newsletter to "Newsletter" in the
// Traffic tab). Only our own pages: not unsubscribe or confirm links
// (private tokens), images, or the /go/ sponsor redirect (it tags the
// sponsor's link itself). `amp` is '&amp;' in HTML and '&' in plain text.
export function utmTag(content, siteUrl, campaign, amp = '&amp;') {
  if (!siteUrl) return content;
  const base = siteUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${base}(/[^\\s"'<>]*)?`, 'g');
  const tags = `utm_source=newsletter${amp}utm_medium=email${amp}utm_campaign=${encodeURIComponent(campaign)}`;
  return content.replace(re, (url, rest = '') => {
    if (/^\/(unsubscribe|subscribe\/confirm|email-prefs|go\/|email\/|sponsor-logo\/|r\/)/.test(rest)) return url;
    const hash = url.indexOf('#');
    const [head, frag] = hash === -1 ? [url, ''] : [url.slice(0, hash), url.slice(hash)];
    return `${head}${head.includes('?') ? amp : '?'}${tags}${frag}`;
  });
}

// A paid weekly sponsor's button goes through /go/s/<week> (server/
// sponsors.js), which counts the click for the sponsor's end-of-week report
// and then sends the reader on with UTM tags. A hand-set sponsor (no order)
// links straight to its site.
export function sponsorHref(sponsor, siteUrl, src = 'newsletter') {
  if (siteUrl && /^\d{4}-\d{2}-\d{2}$/.test(sponsor.week || '')) return `${siteUrl}/go/s/${sponsor.week}?src=${src}`;
  return safeUrl(sponsor.url);
}

function sponsorHtml(sponsor, siteUrl = '', src = 'newsletter') {
  // Logo: absolute URL (email clients can't resolve a path), only our own.
  const logo = sponsor && isSponsorLogo(sponsor.logo) ? `${siteUrl}${sponsor.logo}` : '';
  return sponsor && sponsor.name ? `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;background:${C.sunLight};border:3px dashed ${C.ink};border-radius:16px;"><tr><td style="padding:14px 16px;">
<span style="display:inline-block;font-family:${DISPLAY};font-size:11px;font-weight:bold;letter-spacing:.5px;background:${C.sunset};color:${C.ink};border:2px solid ${C.ink};border-radius:999px;padding:1px 10px;">THIS WEEK'S SPONSOR</span>
${logo ? `<div style="margin:8px 0 2px;"><img src="${escHtml(logo)}" alt="${escHtml(sponsor.name)}" style="display:block;max-height:60px;max-width:200px;height:auto;border:0;"></div>` : ''}
<div style="font-family:${DISPLAY};font-size:20px;font-weight:bold;margin:6px 0 2px;">${escHtml(sponsor.name)}</div>
${sponsor.text ? `<div style="font-size:14px;">${escHtml(sponsor.text)}</div>` : ''}
${safeUrl(sponsor.url) && sponsor.cta ? `<a href="${escHtml(sponsorHref(sponsor, siteUrl, src))}" style="display:inline-block;margin-top:10px;background:#fff;color:${C.ink};font-family:${DISPLAY};font-weight:bold;padding:6px 14px;border:2px solid ${C.ink};border-radius:999px;text-decoration:none;">${escHtml(sponsor.cta)} →</a>` : ''}
</td></tr></table>` : '';
}

// No prices here (they stay on /advertise and checkout).
// An issue with no sponsor that week says the spot is open, under the list
// rather than in the sponsor's place at the top: readers get the events
// first, and the businesses among them see where to go. Booking the week
// puts the paid block back at the top and this goes away.
function houseAdHtml(siteUrl) {
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;background:#fff;border:3px dashed ${C.ink};border-radius:16px;"><tr><td style="padding:14px 16px;">
<span style="display:inline-block;font-family:${DISPLAY};font-size:11px;font-weight:bold;letter-spacing:.5px;background:${C.sunLight};color:${C.ink};border:2px solid ${C.ink};border-radius:999px;padding:1px 10px;">YOUR BUSINESS HERE</span>
<div style="font-family:${DISPLAY};font-size:18px;font-weight:bold;margin:6px 0 2px;">Feature your business in ${escHtml(town.siteName)}</div>
<div style="font-size:14px;">One business a week gets the top of this newsletter and every page of ${escHtml(town.domain)}. Have an event coming up? Give it the ${town.pickName} badge.</div>
<a href="${siteUrl}/advertise" style="display:inline-block;margin-top:10px;background:#fff;color:${C.ink};font-family:${DISPLAY};font-weight:bold;padding:6px 14px;border:2px solid ${C.ink};border-radius:999px;text-decoration:none;">See how it works →</a>
</td></tr></table>`;
}

function houseAdText(siteUrl) {
  return `FEATURE YOUR BUSINESS: one business a week gets the top of this newsletter, or give your event the ${town.pickNamePlain} badge. ${siteUrl}/advertise`;
}

// What each package looks like inside the newsletter, for /advertise: the
// real sponsor block, and a Saturday with a starred Vic's Pick among its
// neighbors (same renderers as the issue).
export function sampleEmailPreviews(siteUrl = '') {
  const day = (rows) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;border:3px solid ${C.ink};border-radius:16px;overflow:hidden;border-collapse:separate;background:#fff;">
<tr><td style="background:${DAY_COLORS[5]};padding:10px 14px;border-bottom:3px solid ${C.ink};font-family:${DISPLAY};color:${C.ink};"><span style="font-size:20px;font-weight:bold;">Saturday</span></td></tr>
<tr><td style="padding:6px 12px 10px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;">${rows}</table></td></tr></table>`;
  const evs = [
    { name: 'Farmers Market', time: '8:00 AM', venue: 'Market Square' },
    { name: 'Your Event Name', time: '7:00 PM', venue: 'Your Venue', description: 'A line or two about your event.', featured: true },
    { name: 'Live Music', time: '9:00 PM', venue: 'Downtown' }
  ];
  return {
    weekly: `<div style="font-family:Arial,Helvetica,sans-serif;color:${C.ink};">${sponsorHtml({ name: 'Your Business', text: 'One or two sentences about what you offer.', cta: 'Learn more', url: siteUrl || town.siteUrl, logo: SAMPLE_LOGO }, siteUrl)}</div>`,
    featured: `<div style="font-family:Arial,Helvetica,sans-serif;color:${C.ink};font-size:15px;">${day(evs.map((e, i) => eventRow({ ...e, page: null, url: '' }, siteUrl, evs[i + 1])).join(''))}</div>`
  };
}

// ─── Choosing what an issue shows ─────────────────────────────────────
// Each day shows PER_DAY events: paid Vic's Picks always, then editor's
// picks, then the best-rated (`appeal`, 1–5, from the collector), then
// earlier ones. Shown in time order (picks keep their badge), so a day
// reads morning to night. The weekend issue leaves out what nobody plans a
// weekend around (FILLER), never a paid pick.
const FILLER = /\b(training|course|certification|seminar|webinar|orientation|meeting|support group|info(?:rmation)? session|hiring event|job fair|career fair|tutoring|open house|chair yoga)\b/i;
const paidPick = isPaidPick;
// The plain-text part labels a paid pick too: "#ad" at the end of its line.
const paidTag = e => (paidPick(e) ? ` ${AD_LABEL}` : '');
export function isFiller(ev) {
  if (paidPick(ev)) return false;
  return FILLER.test(String(ev.name || '')) || (ev.appeal != null && Number(ev.appeal) <= 2);
}
const startMin = e => { const t = parseTimes(e.time)[0]; return t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) : 9999; };
const appealOf = e => (Number.isFinite(Number(e.appeal)) && e.appeal != null ? Number(e.appeal) : 3);
const byBest = (a, b) => pickRank(a) - pickRank(b) || appealOf(b) - appealOf(a) || startMin(a) - startMin(b);
const normName = v => String(v || '').toLowerCase().replace(/&/g, ' and ').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ')
  .replace(/\b(the|disneys)\b/g, ' ').replace(/\s+/g, ' ').trim();
// The same event listed twice (two sources): one name inside the other.
const sameEvent = (a, b) => {
  const x = normName(a.name), y = normName(b.name);
  return x.length >= 8 && y.length >= 8 && (x === y || x.includes(y) || y.includes(x));
};
const dayShort = d => formatDay(d, { weekday: 'short' });

// [{ d, list }] for the issue's days: filler out (weekend), same-day
// duplicates merged, an event on several days shown on its first with
// "also Sat & Sun" (a paid pick keeps its own day), best first.
export function issueDays(events, days, { weekend = false } = {}) {
  const out = days.map(d => {
    const list = [];
    for (const e of sortEvents(events.filter(x => x.date === d)).sort(byBest)) {
      if (weekend && isFiller(e)) continue;
      const twin = list.find(x => sameEvent(x, e) && (!x.venue || !e.venue || normName(x.venue) === normName(e.venue)));
      if (twin && !paidPick(e)) continue;
      list.push({ ...e });
    }
    return { d, list };
  });
  const seen = new Map();
  for (const day of out) {
    day.list = day.list.filter(e => {
      const key = normName(e.name) + '|' + normName(e.venue);
      const first = seen.get(key);
      if (!first) { seen.set(key, e); return true; }
      if (paidPick(e)) return true;
      first._also = [...(first._also || []), day.d];
      return false;
    });
  }
  for (const day of out) for (const e of day.list) {
    if (e._also) { e.also = e._also.map(dayShort).join(' & '); delete e._also; }
  }
  return out.filter(x => x.list.length);
}

// The day's events to show: the best PER_DAY, in time order.
function shownOf(list) {
  return list.slice(0, PER_DAY).sort((a, b) => startMin(a) - startMin(b) || pickRank(a) - pickRank(b));
}

// The issue's top three: best-rated across all its days.
export function dontMiss(byDay, n = 3) {
  return byDay.flatMap(x => x.list).slice().sort((a, b) => appealOf(b) - appealOf(a) || pickRank(a) - pickRank(b) ||
    (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || startMin(a) - startMin(b)).slice(0, n);
}

// An issue: the rest of this week (weekly, Monday) or Friday through
// Sunday (weekend, Thursday). See EDITIONS.
export function renderWeekly(events, { siteUrl, now, sponsor, unsubscribeUrl, address, openPixelUrl = '', referral = null, edition = 'weekly', prefsUrl = '', replyAsk = false }) {
  const today = localDateStr(now);
  const weekend = edition === 'weekend';
  const week = (EDITIONS[edition] || EDITIONS.weekly).days(today);
  const byDay = issueDays(events, week, { weekend });
  const total = byDay.reduce((n, x) => n + x.list.length, 0);
  const top = dontMiss(byDay);
  // The "Don't miss" box only when there's a lot to choose from.
  const topShown = total >= 6 ? top : [];
  const short = d => formatDay(d, { month: 'short', day: 'numeric' });
  const range = week.length ? (week.length === 1 ? short(week[0]) : `${short(week[0])}–${short(week[week.length - 1])}`) : '';
  const title = weekend ? `This weekend in ${town.city}` : `This week in ${town.city}`;
  const listPath = weekend ? '/this-weekend' : '/';
  const subject = `${title}: ${total} ${total === 1 ? 'thing' : 'things'} to do (${range})`;
  const preheader = top.map(e => e.name).join(' · ');
  const when = e => [dayShort(e.date), clockOf(e.time)].filter(Boolean).join(' ');
  const topHtml = topShown.length ? `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;background:#fff;border:3px solid ${C.ink};border-radius:16px;"><tr><td style="padding:12px 16px;">
<div style="font-family:${DISPLAY};font-size:19px;font-weight:bold;margin-bottom:4px;">Don’t miss ${weekend ? 'this weekend' : 'this week'}</div>
${topShown.map((e, i) => `<div style="margin-top:6px;font-size:15px;"><strong>${i + 1}.</strong> <a href="${escHtml(e.page ? siteUrl + e.page : (safeUrl(e.url) || siteUrl))}" style="color:${C.ink};font-weight:800;">${escHtml(e.name)}</a> <span style="color:${C.muted};">· ${escHtml([when(e), e.venue || placeText(e)].filter(Boolean).join(' · '))}${paidPick(e) ? ` · ${AD_LABEL}` : ''}</span></div>`).join('')}
</td></tr></table>` : '';

  // Day colors follow the weekday (Monday yellow ... Sunday coral), like the site.
  const days = byDay.map(({ d, list }) => { const dayColor = DAY_COLORS[(currentWeek(d).indexOf(d) + 7) % 7]; return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:22px;border:3px solid ${C.ink};border-radius:16px;overflow:hidden;border-collapse:separate;">
<tr><td style="background:${dayColor};padding:10px 14px;border-bottom:3px solid ${C.ink};font-family:${DISPLAY};color:${C.ink};">
<span style="font-size:21px;font-weight:bold;">${escHtml(formatDay(d, { weekday: 'long' }))}</span>
<span style="display:inline-block;margin-left:6px;font-size:13px;font-weight:bold;background:#fff;border:2px solid ${C.ink};border-radius:999px;padding:0 9px;">${escHtml(formatDay(d, { month: 'long', day: 'numeric' }))}</span></td></tr>
<tr><td style="padding:6px 12px 10px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;">${shownOf(list).map((e, i, arr) => eventRow(e, siteUrl, arr[i + 1])).join('')}</table>
${list.length > PER_DAY ? `<p style="margin:12px 0 4px;text-align:center;"><a href="${siteUrl}${weekend ? listPath : `/#day-${currentWeek(d).indexOf(d)}`}" style="${MORE_PILL}background:${dayColor};">+${list.length - PER_DAY} more on ${escHtml(formatDay(d, { weekday: 'long' }))} →</a></p>` : ''}
</td></tr></table>`; }).join('');

  const sponsorBlock = sponsorHtml(sponsor, siteUrl);

  const pill = (href, label) => `<a href="${siteUrl}${href}" style="display:inline-block;margin:6px 4px 0 0;font-family:${DISPLAY};font-weight:bold;font-size:13px;color:${C.ink};background:#fff;border:2px solid ${C.ink};border-radius:999px;padding:2px 10px;text-decoration:none;">${label}</a>`;
  const bodyHtml = `
<p style="margin:16px 0 4px;font-size:16px;">${total ? `Here's what's happening in ${town.cityState} ${weekend ? 'this weekend' : 'this week'}: <strong>${total} ${total === 1 ? 'event' : 'events'}</strong>.` : `Nothing is listed yet for ${weekend ? 'this weekend' : 'the rest of this week'}.`}</p>
<div>${weekend ? pill('/', 'All week') : pill('/this-weekend', 'This weekend')}${pill('/free-things-to-do', 'Free')}${pill('/kids-and-family', 'Kids')}${pill('/live-music', 'Live music')}</div>
${sponsorBlock}${topHtml}${days}
<p style="margin:28px 0 0;text-align:center;">${btn(`${siteUrl}${listPath}`, weekend ? 'See the whole weekend' : 'See the full list')}</p>${sponsorBlock ? '' : houseAdHtml(siteUrl)}
${replyAsk ? replyAskHtml(false) : ''}
${referral ? referralHtml({ siteUrl, ...referral }) : ''}`;

  // Sponsors are sold "the top of the newsletter": first in both parts (and
  // the week's sponsor is in Thursday's issue too).
  const sponsorLine = sponsor && sponsor.name
    ? [`THIS WEEK'S SPONSOR: ${[sponsor.name, sponsor.text, safeUrl(sponsor.url) ? sponsorHref(sponsor, siteUrl) : ''].filter(Boolean).join(' - ')}`, '']
    : [];
  const campaign = `${weekend ? 'weekend' : 'weekly'}-${(EDITIONS[edition] || EDITIONS.weekly).key(today)}`;
  const text = [
    `${subject}`, '', ...sponsorLine,
    ...(topShown.length ? [`DON'T MISS ${weekend ? 'THIS WEEKEND' : 'THIS WEEK'}`, ...topShown.map((e, i) => `${i + 1}. ${e.name} (${[when(e), e.venue || placeText(e)].filter(Boolean).join(', ')})${paidTag(e)}${e.page ? ' ' + siteUrl + e.page : ''}`), ''] : []),
    ...byDay.flatMap(({ d, list }) => [formatDay(d, { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase(),
      ...shownOf(list).map(e => `- ${e.time ? formatTime(e.time) + ' ' : ''}${e.name}${placeText(e) ? ' @ ' + placeText(e) : ''}${e.town ? ' (' + e.town + ')' : ''}${e.also ? ' (also ' + e.also + ')' : ''}${paidTag(e)}${e.page ? ' ' + siteUrl + e.page : ''}`), '']),
    `Full list: ${siteUrl}${listPath}`, '', ...(sponsorLine.length ? [] : [houseAdText(siteUrl), '']), ...(replyAsk ? [replyAskText(false), ''] : []), ...(referral ? referralText({ siteUrl, ...referral }) : []),
    ...(prefsUrl ? [`${weekend ? 'Just want Mondays? Skip the weekend email' : 'Email settings'}: ${prefsUrl}`] : []),
    `Unsubscribe: ${unsubscribeUrl}`, `${town.siteName} · ${address || town.cityState}`
  ].join('\n');

  // The paid Vic's Picks this issue actually stars (shown, not cut by
  // PER_DAY), recorded with the send for their reports.
  const picks = [...new Set(byDay.flatMap(({ list }) => shownOf(list))
    .filter(e => e.featured && !e.editor_pick && e.sponsor_order).map(e => e.sponsor_order))];
  return {
    subject, total, picks,
    html: utmTag(emailShell({ title, preheader, bodyHtml, siteUrl, pixelUrl: openPixelUrl, footerHtml: footer({ siteUrl, unsubscribeUrl, address, prefsUrl, edition }) }), siteUrl, campaign),
    text: utmTag(text, siteUrl, campaign, '&')
  };
}

// reminder: the one follow-up a day later to someone who hasn't tapped it
// (sendConfirmReminders), with a subject that says what it's for.
// One inbox, one key for rate limits (same as emailKey in db.js).
export const inboxKey = emailKey;

export function renderConfirmEmail({ siteUrl, confirmUrl, address, reminder = false }) {
  const lead = reminder
    ? `You asked for ${town.siteName} yesterday but haven't confirmed yet. One tap and ${town.city}'s best events land in your inbox ${SCHEDULE}.`
    : `Tap the button to confirm and start getting ${town.city}'s events ${SCHEDULE}.`;
  const bodyHtml = `<p style="margin:18px 0;font-size:16px;">${escHtml(lead)}</p>
<p style="text-align:center;">${btn(confirmUrl, 'Confirm my subscription')}</p>
<p style="color:${C.muted};font-size:13px;">Didn't sign up? Ignore this email and you won't hear from us${reminder ? ' again' : ''}.</p>`;
  return {
    subject: reminder ? `Still want ${town.city}'s events? Tap to confirm` : `Confirm your ${town.shortName} subscription`,
    html: emailShell({ title: reminder ? 'Just one tap left' : 'One tap to confirm',
      preheader: reminder ? `Your ${town.shortName} signup is waiting on one tap` : `Confirm to get ${town.city} events ${SCHEDULE}`, bodyHtml, siteUrl,
      footerHtml: `${escHtml(town.siteName)} · ${escHtml(address || town.cityState)}` }),
    text: reminder
      ? `${lead}\n\nConfirm: ${confirmUrl}\n\nDidn't sign up? Ignore this email and you won't hear from us again.`
      : `Confirm your subscription to ${town.siteName}: ${confirmUrl}\n\nDidn't sign up? Ignore this email.`
  };
}

// ─── Referral program ───
// Every subscriber has a link, thevic361.com/r/<code>. A friend who signs up
// through it counts for them while that friend stays subscribed. The tiers
// and the gift cards are in server/referralRewards.js (REFERRAL_TIERS);
// emails, Slack and the rules page read them. The first tier is at 1 on
// purpose: each tier up, about a tenth as many readers get there (Morning
// Brew's ladder), so the cheap early rewards do most of the work.
const REF_CODE_RE = /^[a-z2-9]{7}$/;
export function normalizeRefCode(raw) {
  const c = String(raw || '').trim().toLowerCase();
  return REF_CODE_RE.test(c) ? c : null;
}
export function refLink(siteUrl, code) { return `${siteUrl}/r/${code}`; }
function nextTier(count) { return referralTiers().find(t => t.n > count) || null; }
export function referralProgress(count) {
  const next = nextTier(count);
  const done = count === 1 ? "You've brought in 1 friend so far." : count ? `You've brought in ${count} friends so far.` : '';
  const todo = next ? `${next.n - count} more and you get ${next.reward}.` : "You've unlocked every reward. Thank you!";
  return [done, todo].filter(Boolean).join(' ');
}

// The "share" box in the weekly issue and the welcome email: this reader's
// own link and how close they are to the next reward.
function referralHtml({ siteUrl, code, count = 0 }) {
  if (!code) return '';
  const url = refLink(siteUrl, code);
  const tiers = referralTiers().map(t => `${t.n} ${t.n === 1 ? 'friend' : 'friends'}: ${escHtml(t.reward)}`).join('<br>');
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:28px 0 0;border-collapse:separate;"><tr><td style="background:${C.sunLight};border:2px solid ${C.ink};border-radius:14px;padding:16px 18px;">
<p style="margin:0 0 6px;font-family:${DISPLAY};font-size:19px;font-weight:bold;">Share ${town.siteName}, get local perks</p>
<p style="margin:0 0 10px;font-size:14px;">Know someone who's always asking what there is to do in ${town.city}? Send them your link:</p>
<p style="margin:0 0 10px;text-align:center;"><a href="${url}" style="display:inline-block;font-family:${DISPLAY};font-weight:bold;font-size:17px;color:${C.ink};background:#fff;border:2px solid ${C.ink};border-radius:999px;padding:6px 16px;text-decoration:none;">${escHtml(url.replace(/^https?:\/\/(www\.)?/, ''))}</a></p>
<p style="margin:0 0 8px;font-size:14px;font-weight:bold;">${escHtml(referralProgress(count))}</p>
<p style="margin:0;font-size:12px;color:${C.muted};">${tiers}<br>Every friend who joins in a month is another entry in that month's drawing. A friend counts a day after they sign up with your link and confirm their email, for as long as they stay subscribed. Gift cards arrive by email. <a href="${siteUrl}/referral-rules" style="color:${C.muted};">Rules</a></p>
</td></tr></table>`;
}
// The official rules. Every line describes what server/referralRewards.js
// and server/db.js actually do: a friend counts once confirmed for
// REF_HOLD_HOURS and while both of you stay subscribed (tallyReferrals,
// drawingEntries); gift card tiers are checked after each Monday issue
// (rewards.run); the drawing for a month runs with the first Monday issue
// on or after the 2nd of the next month (drawingMonth), picking one entry
// with crypto.randomInt. The free entry by email is handled by the owner
// by hand (AGENTS.md "Referral rewards": nothing automatic reads it).
export function renderReferralRules({ siteUrl }) {
  const cards = referralTiers().filter(t => t.amount);
  const amount = town.business.drawingAmount;
  const li = (title, text) => `<li><strong>${title}</strong> ${text}</li>`;
  return layout({
    siteUrl, path: '/referral-rules', nav: null, pixel: false, title: `Referral rewards: official rules | ${town.siteName}`,
    description: `How ${town.siteName} newsletter referral rewards and monthly gift card drawing work.`,
    body: `<h1 class="page-title">Referral rewards: official rules</h1>
<p class="page-lead">Share ${town.siteName} with friends and earn gift cards. No purchase is necessary: subscribing and sharing are free.</p>
<p class="legal-version">Last updated ${versionDate(REFERRAL_RULES_VERSION)} · Version ${REFERRAL_RULES_VERSION}</p>
<p class="legal-loud"><strong>NO PURCHASE OR PAYMENT OF ANY KIND IS NECESSARY TO TAKE PART OR WIN. A PURCHASE WILL NOT IMPROVE YOUR CHANCES. VOID WHERE PROHIBITED.</strong></p>
<ul>
${li('Sponsor.', `The program is run by ${operatorHtml()}${mailingAddress() ? `, ${escHtml(mailingAddress())}` : ''} (email ${emailLink('Referral rewards')}). "We" and "us" below mean the sponsor.`)}
${li('When it runs.', `These rules apply from ${versionDate(REFERRAL_RULES_VERSION)} until we end the program. Each drawing covers one calendar month, from 12:00 a.m. on the 1st to 11:59 p.m. on its last day, ${escHtml(town.city)} local time.`)}
${li('Who can take part.', `Anyone subscribed to ${town.siteName} newsletter who lives in the United States and is 18 or older, or the age of majority in their state if that's higher. ${escHtml(operatorName())}'s owners, employees and contractors, and the people in their households, can't win. Void where prohibited.`)}
${li('Your link.', 'Every subscriber gets a personal share link in each newsletter. A friend counts for you once they have signed up through your link, confirmed their email address, and been subscribed for 24 hours, and only while both of you are still subscribed when we count. Each email inbox counts once (for whoever referred it first), and your own addresses don\'t count.')}
${cards.map(t => li(`${t.n} friends.`, `A $${t.amount} digital gift card, once per subscriber.`)).join('\n')}
${li('Gift card timing.', 'We count friends every Monday after the newsletter goes out, and send any gift card you\'ve reached then. A reward that needs a closer look (see Fair play) is sent once we\'ve checked it.')}
${li('Monthly drawing: how to enter.', `Each friend who confirms through your link during a calendar month is one entry in that month's drawing. <strong>Free way to enter without referring anyone:</strong> email ${emailLink('Drawing entry')} with the subject "Drawing entry", your name and the email address you're subscribed with, for one entry in that month's drawing. One free entry per person per month; it must arrive by the last day of the month. Free entries have the same chance of winning as referral entries. Entries don't carry over to the next month.`)}
${li('Monthly drawing: picking the winner.', `On the first Monday on or after the 2nd of the next month (so between the 2nd and the 8th), one entry is picked at random from all eligible entries for that month, and its owner gets a $${amount} digital gift card. Your odds depend on how many eligible entries there are that month.`)}
${li('Prize.', `One $${amount} digital gift card each month (approximate retail value $${amount}). No cash or substitute, except that we may substitute a prize of equal or greater value. The gift card issuer's terms apply.`)}
${li('How rewards arrive.', 'Gift cards are sent by email from our rewards partner, Tremendous, to the address you\'re subscribed with. You choose the store from their list. Tremendous gets your email address to send it. The drawing winner\'s gift card email says they won; it is usually sent the day of the drawing.')}
${li('Claiming a prize.', 'Redeem a gift card from its email; if you can\'t find it, contact us within 30 days of the drawing. A prize that can\'t be delivered, isn\'t claimed within 30 days, or goes to someone who turns out not to be eligible is forfeited, and we may draw another entry from that month.')}
${li('Winners list.', `To ask who won a month's drawing, email ${emailLink('Winners list')} within 60 days after that month's drawing.`)}
${li('Taxes.', 'Winners are responsible for any taxes on their prize. We\'ll send any tax form the law requires.')}
${li('Fair play.', 'Referrals have to be real people who want the newsletter. We can hold back or cancel rewards for sign-ups that look made up (fake, throwaway or duplicate addresses), disqualify anyone who tampers with the program, and our decisions about who counts are final.')}
${li('Sharing your link.', 'Share it with people you know or on your own pages, and don\'t spam. If you post your link publicly, say that you get rewards if people sign up (for example, "I get a gift card if you join"). We never send invitations for you.')}
${li('Liability.', 'By taking part you release us from claims about the program and its prizes, except where the law doesn\'t allow it.')}
${li('Privacy.', 'Our <a href="/privacy">privacy policy</a> covers the information we use to run the program.')}
${li('Changes.', 'We may change or end the program at any time, for example because of fraud or technical problems. Rewards you have already earned will still be sent, and a month already under way is drawn from the eligible entries received up to the end.')}
${li('Governing law.', 'These rules are governed by the laws of the State of Texas.')}
</ul>
<p>Questions? Email ${emailLink('Referral rewards')} or <a href="/contact">get in touch</a>.</p>`
  });
}

function referralText({ siteUrl, code, count = 0 }) {
  if (!code) return [];
  return [`SHARE ${town.siteName.toUpperCase()}`, `Send friends your link: ${refLink(siteUrl, code)}`, referralProgress(count),
    `Rules: ${siteUrl}/referral-rules`, ''];
}

// Sent once, right after someone signs up (or a comeback confirms): what
// to expect, a few events they can use now (no waiting for the next issue), the
// sponsor, and a nudge to share.
const WELCOME_PICKS = 5;

// "Hit reply" asks (only when NEWSLETTER_REPLY_TO is set, so a reply never
// bounces). Readers tell us what they want more of, and a reply teaches
// Gmail and friends the issue is wanted mail, which keeps it out of spam
// and Promotions.
const REPLY_TOPICS = 'live music, family stuff, food & drink, markets, nightlife, arts';
function replyAskHtml(welcome) {
  return welcome
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;background:${C.sky};border:2px solid ${C.ink};border-radius:14px;border-collapse:separate;"><tr><td style="padding:12px 16px;font-size:15px;">
<strong style="font-family:${DISPLAY};font-size:17px;">One quick favor: hit reply 👋</strong><br>
Tell us what you're most into (${REPLY_TOPICS}...). We read every reply and use it to pick what goes in, and a reply helps make sure we keep landing in your inbox.</td></tr></table>`
    : `<p style="margin:22px 0 0;font-size:14px;text-align:center;color:${C.muted};">What do you want more of? <strong style="color:${C.ink};">Just hit reply</strong> and tell us. We read every one.</p>`;
}
const replyAskText = welcome => welcome
  ? `ONE QUICK FAVOR: hit reply and tell us what you're most into (${REPLY_TOPICS}...). We read every reply, and a reply helps make sure we keep landing in your inbox.`
  : 'What do you want more of? Just hit reply and tell us. We read every one.';

// A transparent 1x1 GIF, the newsletter's open-tracking image.
const PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
export function renderWelcomeEmail(events, { siteUrl, now, sponsor, unsubscribeUrl, address, referral = null, replyAsk = false }) {
  const today = localDateStr(now);
  const soon = sortEvents((events || []).filter(e => e.date >= today && e.date <= addDays(today, 6)));
  // Picks always make the five, then they're shown in time order like the
  // site; days past this Sunday carry their date (they aren't on the
  // homepage's week yet).
  const picks = sortEvents([...soon.filter(e => e.featured).sort((a, b) => pickRank(a) - pickRank(b)), ...soon.filter(e => !e.featured)].slice(0, WELCOME_PICKS));
  const weekEnd = currentWeek(today)[6];
  const dayLabel = (d) => d === today ? 'Today' : d > weekEnd ? formatDay(d, { weekday: 'short', month: 'short', day: 'numeric' }) : formatDay(d, { weekday: 'long' });
  const coming = picks.length ? `
<p style="margin:22px 0 6px;font-family:${DISPLAY};font-size:19px;font-weight:bold;">Coming up this week</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;">${picks.map((e, i) =>
    eventRow({ ...e, time: [dayLabel(e.date), e.time].filter(Boolean).join(', ') }, siteUrl, picks[i + 1])).join('')}</table>
${soon.length > picks.length ? `<p style="margin:12px 0 4px;text-align:center;"><a href="${siteUrl}/" style="${MORE_PILL}background:${C.sun};">+${soon.length - picks.length} more this week →</a></p>` : ''}` : '';
  const bodyHtml = `
<p style="margin:18px 0 4px;font-size:16px;"><strong>You're in!</strong> Every Monday morning you'll get the week's events in ${town.cityState} (concerts, markets, festivals, family stuff and more), and every Thursday morning the weekend's best.</p>
${replyAsk ? replyAskHtml(true) : ''}
${coming}${sponsorHtml(sponsor, siteUrl, 'welcome')}
<p style="margin:26px 0 0;text-align:center;">${btn(`${siteUrl}/`, "See this week's events")}</p>
${referral ? referralHtml({ siteUrl, ...referral }) : `<p style="margin:22px 0 0;font-size:14px;color:${C.muted};">Know someone who's always asking what there is to do in ${town.city}? Forward them this email or send them to <a href="${siteUrl}/" style="color:${C.accent};font-weight:bold;">${town.domain}</a>.</p>`}`;
  const text = [
    `You're in! Every Monday morning you'll get the week's events in ${town.cityState}, and every Thursday the weekend's best.`, '',
    ...(replyAsk ? [replyAskText(true), ''] : []),
    ...(picks.length ? ['COMING UP THIS WEEK', ...picks.map(e =>
      `- ${dayLabel(e.date)}${e.time ? ' ' + formatTime(e.time) : ''}: ${e.name}${placeText(e) ? ' @ ' + placeText(e) : ''}${paidTag(e)}${e.page ? ' ' + siteUrl + e.page : ''}`), ''] : []),
    `This week's events: ${siteUrl}/`, '', ...(referral ? referralText({ siteUrl, ...referral }) : []),
    `Unsubscribe: ${unsubscribeUrl}`, `${town.siteName} · ${address || town.cityState}`
  ].join('\n');
  return {
    subject: `Welcome to ${town.siteName}`,
    html: utmTag(emailShell({ title: `Welcome to ${town.siteName}`, preheader: picks.length ? `Coming up: ${picks.slice(0, 3).map(e => e.name).join(' · ')}` : `${town.city}'s events, ${SCHEDULE}`,
      bodyHtml, siteUrl, footerHtml: footer({ siteUrl, unsubscribeUrl, address }) }), siteUrl, 'welcome'),
    text: utmTag(text, siteUrl, 'welcome', '&')
  };
}

// Where a signup came from. Forms send one of these; ":ad" means the visitor
// first landed from a paid ad (docs/track.js). Anything else is "site".
const SIGNUP_SOURCES = new Set(['footer', 'list-card', 'subscribe-page']);
export function signupSource(raw) {
  const [base, tag] = String(raw || '').split(':');
  if (!SIGNUP_SOURCES.has(base)) return 'site';
  return tag === 'ad' ? `${base}:ad` : base;
}

// Newsletter signup form: the homepage footer and the /subscribe page.
export function signupFormHtml({ source = 'footer', button = 'Subscribe' } = {}) {
  return `<form class="signup-form" id="signup-form" action="/api/subscribe" method="post" novalidate data-turnstile="fetch" data-source="${escHtml(source)}">
  <label for="signup-email" class="visually-hidden">Email address</label>
  <input id="signup-email" name="email" type="email" required autocomplete="email" placeholder="you@example.com">
  <input type="text" name="hp_field" tabindex="-1" autocomplete="off" class="hp-field" aria-hidden="true">
  <button type="submit" class="btn btn--primary">${escHtml(button)}</button>
  <p class="signup-msg" id="signup-msg" role="status" aria-live="polite"></p>
</form>
<script>
(function(){var f=document.getElementById('signup-form');if(!f)return;var m=document.getElementById('signup-msg');
f.addEventListener('submit',function(e){e.preventDefault();var b=f.querySelector('button');b.disabled=true;m.textContent='';
(window.vicTurnstile?window.vicTurnstile.token(f):Promise.resolve('')).then(function(t){return fetch('/api/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:f.email.value,hp_field:f.hp_field.value,turnstile_token:t,source:window.vic361Source?window.vic361Source(f.getAttribute('data-source')):f.getAttribute('data-source'),ref:window.vic361Ref?window.vic361Ref():''})});})
.then(function(r){return r.json().catch(function(){return{};}).then(function(j){return{ok:r.ok,j:j};});})
.then(function(x){m.textContent=x.ok?'✅ '+(x.j.message||"You're on the list! Check your inbox."):(x.j.message||'Something went wrong. Try again.');if(x.ok){f.email.value='';f.classList.add('is-done');var was=false;try{was=localStorage.getItem('vic361-subscribed')==='1';localStorage.setItem('vic361-subscribed','1')}catch(e){}if(!was&&window.vic361Track)window.vic361Track('subscribe_click',{link_url:'form'});}})
.catch(function(){m.textContent='Something went wrong. Try again.';}).then(function(){b.disabled=false;if(window.vicTurnstile)window.vicTurnstile.reset(f);});});})();
</script>`;
}

// ─── Signup page ─────────────────────────────────────────────────────────


// The signup page: what you get, the form, then proof (real events from
// the next seven days) for people who scroll before deciding.
export function renderSubscribePage(events, { siteUrl, now, subscriberCount = 0, invited = false }) {
  const today = localDateStr(now);
  const end = addDays(today, 6);
  const next7 = sortEvents(events.filter(e => e.date >= today && e.date <= end));
  const seen = new Set();
  // Vic's Picks get a spot first, then the list reads in date order with
  // the day on each line (renderEventItem alone shows only the time).
  const dayOf = d => d === today ? 'Today' : formatDay(d, { weekday: 'short' });
  const picks = sortEvents(next7.filter(e => e.featured).sort((a, b) => pickRank(a) - pickRank(b)).concat(next7)
    .filter(e => e.page && !seen.has(e.name) && seen.add(e.name)).slice(0, 5))
    .map(e => ({ ...e, time: [dayOf(e.date), e.time].filter(Boolean).join(' · ') }));
  const crowd = subscriberCount >= town.business.showSubscribersFrom // "Join 40 locals" undersells
    ? `<p class="sub-crowd">Join ${Math.floor(subscriberCount / 10) * 10}+ ${town.city} locals who already get it.</p>` : '';
  const proof = picks.length ? `
    <h2 class="section-heading">Coming up in the next week</h2>
    <p class="sub-proof-lead">${next7.length} things to do in ${town.city} in the next seven days, including:</p>
    <ul class="event-list sub-picks" role="list">${picks.map(renderEventItem).join('')}</ul>
    <p class="sub-again"><a class="btn btn--primary" href="#signup-email">Get the full list ${SCHEDULE}</a> <a class="btn btn--outline" href="/">See this week's events</a></p>` : '';
  const body = `
    <section class="sub-hero">
      ${invited ? `<p class="sub-invited">🎁 A friend invited you to ${town.siteName}</p>` : ''}
      <p class="sub-kicker">Free · Mondays and Thursdays · ${town.cityState}</p>
      <h1 class="page-title">${town.city}'s best events, in your inbox ${SCHEDULE}.</h1>
      ${signupFormHtml({ source: 'subscribe-page', button: 'Subscribe free' })}
      <p class="sub-fine">No spam, ever. Unsubscribe with one click.</p>
      <p class="page-lead">The whole week on Monday, the weekend on Thursday: live music, festivals, markets, family days, and new spots opening.</p>
      ${crowd}
    </section>
    <ul class="sub-perks" role="list">
      <li><strong>Monday mornings:</strong> the whole week, day by day, before you make plans.</li>
      <li><strong>Thursday mornings:</strong> the weekend, Friday to Sunday, in time to plan it (skip it anytime and keep Mondays).</li>
      <li><strong>Free things to do</strong> marked, so you can find them fast.</li>
      <li><strong>New &amp; notable:</strong> places that just opened and things you haven't heard about yet.</li>
    </ul>
    ${proof}
    <script>
    // Already on the signup page: the header's Subscribe button (and "Get
    // the full list") take you to the email box instead of reloading the
    // page, which looked like the button didn't work.
    document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[href="/subscribe"],a[href="#signup-email"]');var i=document.getElementById('signup-email');
    if(!a||!i)return;e.preventDefault();i.scrollIntoView({behavior:'smooth',block:'center'});i.focus({preventScroll:true});});
    </script>`;
  return layout({
    siteUrl, path: '/subscribe', nav: null,
    title: `Free Events Newsletter for ${town.cityState} | ${town.siteName}`,
    description: `Get ${town.cityState}'s best events in your inbox ${SCHEDULE}: live music, festivals, markets, family events, and new spots. Free, no spam.`,
    body
  });
}

// ─── Routes ──────────────────────────────────────────────────────────────

export function registerNewsletter(app, { store, requireAdmin, siteUrl, nowFn, getPublicPayload, getSendPayload = getPublicPayload, createRateLimiter, config, resend, slack = null, verifyHuman = async () => true, turnstileConfigured = true, withNav = async html => html, onCron = null, tremendous = null }) {
  const rewards = createReferralRewards({ store, slack, tremendous, nowFn, localDate: localDateStr });
  const subscribeLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 10 });
  const confirmLimiter = createRateLimiter({ windowMs: 24 * 60 * 60 * 1000, max: 3 });
  // Signups without a bot-check token can ask for a confirmation email
  // without passing the check, so they share one hourly budget: a script
  // can't use the form to mail strangers at scale (and hurt the domain).
  const unverifiedLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 30 });
  // The open pixel writes on every hit, so a per-IP cap keeps a loop from
  // hammering the table. It's high: Gmail's image proxy and Apple Mail
  // Privacy Protection fetch for many readers from shared IPs right after a
  // send, and a low cap (it was 120) dropped real opens. Made-up URLs can't
  // pad the count anyway (recordEmailOpen ignores non-subscriber ids and
  // counts each subscriber once per issue).
  const pixelLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 5000 });
  const supported = typeof store.addSubscriber === 'function';

  const openPixel = (week, id) => `${siteUrl}/email/o/${week}/${encodeURIComponent(id)}.gif`;

  // One subscriber's referral link and count, for the welcome email. A
  // store without referrals (or a failed read) just leaves the box out.
  async function referralFor(sub) {
    if (!sub || !sub.id || typeof store.ensureRefCodes !== 'function') return null;
    try {
      const code = (await store.ensureRefCodes([sub.id]))[sub.id];
      if (!code) return null;
      const count = (await store.countReferrals([code]))[code] || 0;
      return { code, count };
    } catch (err) {
      console.warn('[newsletter] referral link failed:', err.message);
      return null;
    }
  }

  // Monday's send: each recipient's code and count. The rewards that came
  // due go out after the newsletter (rewards.run below), so a slow gift
  // card service can't hold up the issue.
  async function referralsForSend(subs) {
    if (typeof store.ensureRefCodes !== 'function') return { codes: {}, counts: {} };
    try {
      const codes = await store.ensureRefCodes(subs.map(s => s.id).filter(Boolean));
      const counts = await store.countReferrals(Object.values(codes));
      return { codes, counts };
    } catch (err) {
      console.warn('[newsletter] referral links failed:', err.message);
      return { codes: {}, counts: {} };
    }
  }

  const page = (title, message) => layout({
    siteUrl, path: '/subscribe', nav: null, noindex: true, pixel: false, title: `${title} | ${town.siteName}`, description: title,
    body: `<h1 class="page-title">${escHtml(title)}</h1><p class="page-lead">${message}</p><p><a class="btn btn--primary" href="/">See this week's events</a></p>`
  });

  // A send record's people still owed the issue (a partly failed send).
  const failedCount = r => (r ? (Array.isArray(r.failed_emails) ? r.failed_emails.length : Number(r.failed) || 0) : 0);

  // One send at a time in this process: the Monday cron and an admin
  // Send/Retry can overlap, and both would read "not sent yet" and mail
  // everyone. The second gets 'in-progress' instead.
  // Per issue: Monday's retry and Thursday's send are different people and
  // keys, so one mustn't make the other look done ("in-progress" counts as
  // done for the scheduler, since that same issue is going out).
  const sending = new Set();
  async function sendWeekly(opts = {}) {
    const edition = opts.edition || 'weekly';
    if (sending.has(edition)) return { ok: false, error: 'in-progress', message: 'The newsletter is going out right now. Check back in a minute.' };
    sending.add(edition);
    try {
      return await sendWeeklyNow(opts);
    } finally {
      sending.delete(edition);
    }
  }

  const prefsLink = s => `${siteUrl}/email-prefs?token=${encodeURIComponent(s.token)}`;

  async function sendWeeklyNow({ force = false, edition = 'weekly', resendUnknown = false } = {}) {
    if (!EDITIONS[edition]) return { ok: false, error: 'unknown-edition' };
    if (!config.enabled) return { ok: false, error: 'not-configured' };
    // CAN-SPAM: every marketing email needs a physical postal address.
    if (!config.address) return { ok: false, error: 'no-address', message: 'Set NEWSLETTER_ADDRESS (a mailing address) before sending.' };
    if (edition === 'weekend' && !config.weekend) return { ok: false, error: 'weekend-off', message: 'NEWSLETTER_WEEKEND=0 is set in Railway.' };
    const weekend = edition === 'weekend';
    const now = nowFn();
    const key = EDITIONS[edition].key(localDateStr(now));
    const prior = await store.getNewsletterSend(key);
    const priorFailed = prior && Array.isArray(prior.failed_emails) ? prior.failed_emails : [];
    const priorChunks = prior && Array.isArray(prior.chunks) ? prior.chunks : [];
    // Chunks recorded as possibly sent (asked, no definite answer) whose key
    // has expired: only the admin's explicit "resend unconfirmed" mails them.
    const unknownChunks = priorChunks.filter(c => c && c.state === 'sent-unknown');
    // Fully sent: done. Partly sent: a retry (cron or admin) only goes to
    // the people who didn't get it. Force resends to everyone.
    if (prior && !force && !priorFailed.length && !(resendUnknown && unknownChunks.length)) return { ok: false, error: 'already-sent', sent: prior };
    const resume = Boolean(prior && !force);
    const payload = await getSendPayload();
    let subs = await store.listSubscribers({ status: 'active' });
    if (weekend) subs = subs.filter(s => !s.weekend_optout);
    // Only people still on the list (and still taking this issue): someone
    // who unsubscribed, bounced or complained since the first try drops out
    // of their chunk's message list.
    const active = new Map(subs.map(s => [s.email, s]));
    // Only a forced resend (to everyone, on purpose) gets a fresh key. A
    // resume reuses the first try's key, so a chunk Resend queued but
    // answered after our 15 s timeout gets a 409 (counted as sent) instead
    // of going to those people twice.
    const attempt = force ? `-f${Date.now()}` : '';
    // The send's plan: each chunk's idempotency key and members, saved
    // before it is first sent. A resume sends a chunk again under its
    // ORIGINAL key with its original members (less anyone who left), so a
    // chunk Resend took but answered after our timeout gets the same key and
    // Resend's 409 (counted as sent), whoever unsubscribed meanwhile. Keys
    // built from the current members (as before) changed when anyone left,
    // and the whole chunk, and every later one, went out twice.
    // state: queued (not tried), pending (asked, no answer yet: the process
    // died mid-request), unknown (timed out, or still in flight at Resend:
    // possibly sent), failed (a definite error: not sent), sent,
    // sent-unknown (possibly sent and past Resend's key window).
    // The key is the week plus a hash of the chunk's addresses, as before,
    // so a first send's keys are unchanged.
    const chunkKey = emails => {
      const who = crypto.createHash('sha256').update(emails.join(',')).digest('hex').slice(0, 16);
      return `${town.keyPrefix}-${key}-${who}${attempt}`;
    };
    const planOf = list => {
      const out = [];
      for (let i = 0; i < list.length; i += BATCH_SIZE) {
        const emails = list.slice(i, i + BATCH_SIZE);
        out.push({ key: chunkKey(emails), emails, state: 'queued', first_at: null });
      }
      return out;
    };
    let plan;
    if (resume) {
      plan = priorChunks.map(c => ({ ...c, emails: [...(c.emails || [])] }));
      if (resendUnknown) {
        // The admin asked, after a warning: these may already have it, and
        // Resend no longer remembers the key, so a new key it is.
        const stamp = Date.now();
        for (const c of plan) if (c.state === 'sent-unknown') Object.assign(c, { state: 'queued', first_at: null, key: `${c.key}-u${stamp}` });
      }
      // People owed the issue whom no saved chunk covers: a record from
      // before chunks were saved. Their keys hash the current chunk, as then.
      const planned = new Set(plan.flatMap(c => c.emails));
      const owedBefore = new Set(priorFailed);
      const loose = subs.map(s => s.email).filter(e => !planned.has(e) && owedBefore.has(e));
      plan.push(...planOf(loose));
    } else {
      plan = planOf(subs.map(s => s.email));
    }
    const DONE = new Set(['sent', 'sent-unknown']);
    const todo = plan.filter(c => !DONE.has(c.state));
    subs = [...new Set(todo.flatMap(c => c.emails))].map(e => active.get(e)).filter(Boolean);
    if (!subs.length) {
      if (resume) {
        for (const c of todo) c.state = 'sent';
        await store.recordNewsletterSend({ ...prior, failed: 0, failed_emails: [], chunks: plan });
        return { ok: false, error: 'already-sent', sent: prior };
      }
      return { ok: false, error: 'no-subscribers' };
    }
    const probe = renderWeekly(payload.events, { siteUrl, now, sponsor: payload.sponsor, unsubscribeUrl: '', address: config.address, edition });
    if (!probe.total) return { ok: false, error: 'no-events' };

    let sent = 0;
    const failures = [];
    // Addresses Resend's permissive validation refused. Retrying them can't
    // help (same address, same answer), so they don't count as failed:
    // otherwise the week never reads "sent" and every Monday retries and
    // alerts again. They're marked bounced (no future sends) and listed in
    // one Slack note.
    const refusedEmails = [];
    // Chunks this run found possibly sent and past the key window.
    const expiredUnknown = [];
    const base = resume ? (Number(prior.recipients) || 0) : 0;
    // A resumed send renders from the resume day onward, so a pick starred
    // in Monday's issue may be missing from probe.picks by Tuesday. The
    // record keeps every pick any part of the week's send starred (the
    // Vic's Pick report reads it).
    const picks = resume && Array.isArray(prior.picks) ? [...new Set([...prior.picks, ...probe.picks])] : probe.picks;
    // Everyone in a chunk that isn't done is owed the issue (failed_emails,
    // which the admin and the scheduler read as "partly sent").
    const owed = () => [...new Set(plan.filter(c => !DONE.has(c.state)).flatMap(c => c.emails))];
    // Written before each chunk, with that chunk marked pending (asked,
    // answer not yet in): if the process dies mid-send, the week reads
    // "partly sent" and Retry (or the next cron) goes only to the people
    // still waiting, each under the key their chunk was first sent with.
    const progress = () => {
      const failedEmails = owed();
      return store.recordNewsletterSend({
        week_key: key, subject: probe.subject, recipients: base + sent, picks,
        failed: failedEmails.length, failed_emails: failedEmails, chunks: plan
      });
    };
    const refs = await referralsForSend(subs);
    const nowMs = now.getTime();
    for (const chunk of todo) {
      // Possibly sent already (no definite answer) and too old for Resend to
      // still hold its key: sending it again could mail every one of them
      // twice, so the cron never does. It's recorded as sent-unknown, which
      // the admin can resend on purpose after a warning.
      const possiblySent = chunk.state === 'pending' || chunk.state === 'unknown';
      if (possiblySent && chunk.first_at && nowMs - Date.parse(chunk.first_at) > KEY_WINDOW_MS) {
        chunk.state = 'sent-unknown';
        expiredUnknown.push(chunk);
        continue;
      }
      const members = chunk.emails.map(e => active.get(e)).filter(Boolean);
      if (!members.length) { chunk.state = 'sent'; continue; }
      if (!chunk.first_at) chunk.first_at = now.toISOString();
      chunk.state = 'pending';
      await progress();
      const msgs = members.map(s => {
        const unsubscribeUrl = `${siteUrl}/unsubscribe?token=${encodeURIComponent(s.token)}`;
        // Open tracking: a 1x1 image per copy, keyed by week and subscriber
        // id (not the token, which unsubscribes). See /email/o below.
        const openPixelUrl = s.id ? openPixel(key, s.id) : '';
        const code = s.id && refs.codes[s.id];
        const referral = code ? { code, count: refs.counts[code] || 0 } : null;
        const issue = renderWeekly(payload.events, { siteUrl, now, sponsor: payload.sponsor, unsubscribeUrl, address: config.address, openPixelUrl, referral, replyAsk: Boolean(config.replyTo || config.inbound),
          edition, prefsUrl: s.token && config.weekend ? prefsLink(s) : '' });
        return {
          from: config.from, to: [s.email], subject: issue.subject, html: issue.html, text: issue.text,
          ...(config.replyTo ? { reply_to: config.replyTo } : {}),
          headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
        };
      });
      try {
        const out = await resend.batch(msgs, chunk.key);
        // Permissive validation: refused addresses come back by index; the
        // rest of the chunk went out.
        const refused = new Map((out && Array.isArray(out.errors) ? out.errors : []).map(e => [Number(e.index), e.message]));
        members.forEach((s, j) => {
          if (refused.has(j)) refusedEmails.push({ email: s.email, reason: String(refused.get(j) || '').slice(0, 200) });
          else sent++;
        });
        chunk.state = 'sent';
      } catch (err) {
        const outcome = batchErrorOutcome(err);
        if (outcome === 'sent') {
          // The key was already used within Resend's 24 hours: the first
          // try went out (the payload differs now that someone left, or the
          // issue was re-rendered on a later day). They got it.
          sent += members.length;
          chunk.state = 'sent';
        } else {
          failures.push(err.message);
          chunk.state = outcome;
        }
      }
    }
    const failedEmails = owed();
    const record = {
      week_key: key, subject: probe.subject, picks,
      recipients: base + sent,
      failed: failedEmails.length, failed_emails: failedEmails, chunks: plan
    };
    await store.recordNewsletterSend(record);
    const unknownCount = plan.filter(c => c.state === 'sent-unknown').reduce((n, c) => n + c.emails.filter(e => active.has(e)).length, 0);
    if (slack && expiredUnknown.length) {
      const n = expiredUnknown.reduce((m, c) => m + c.emails.length, 0);
      slack.alert(`newsletter-unknown-${key}`, `Newsletter: ${n} may or may not have gotten it`,
        `Resend never answered for ${n} subscriber(s), and it's been over a day, so the retry key has expired. They weren't sent it again, ` +
        'since that could mail them twice. To send it anyway, use "Resend unconfirmed" in the Newsletter tab.', `${siteUrl}/admin.html`);
    }
    if (refusedEmails.length) {
      const emails = refusedEmails.map(r => r.email);
      let marked = false;
      try {
        if (typeof store.markSubscribersBounced === 'function') { await store.markSubscribersBounced(emails); marked = true; }
      } catch (err) { console.warn('[newsletter] marking refused addresses bounced failed:', err.message); }
      if (slack) {
        slack.alert(`newsletter-refused-${key}`, `Newsletter: Resend refused ${emails.length} address(es)`,
          `${refusedEmails.slice(0, 20).map(r => `${r.email}: ${r.reason}`).join('\n')}${emails.length > 20 ? `\n…and ${emails.length - 20} more` : ''}\n` +
          (marked ? 'They are marked bounced and get no more issues; one who signs up again on the site gets a confirmation email first.' : 'They could not be marked bounced, so the next send will try them again.'),
          `${siteUrl}/admin.html`);
      }
    }
    if (slack) {
      const name = weekend ? 'Weekend newsletter' : 'Newsletter';
      if (failures.length) slack.alert(`newsletter-failed-${key}`, `${name} send partly failed`, `${sent} sent, ${record.failed} failed.\n${failures[0]}`, `${siteUrl}/admin.html`);
      else slack.notify({ title: `📧 ${name} sent`, fields: [['Recipients', sent], ['Subject', probe.subject], ['Events', probe.total]] });
    }
    // Referral rewards, once Monday's issue is out (never throws).
    if (!weekend) await rewards.run(refs.counts);
    const { chunks: _chunks, ...summary } = record;
    return { ok: failures.length === 0, ...summary, unknown: unknownCount, refused: refusedEmails.map(r => r.email), errors: failures.slice(0, 3) };
  }

  app.post('/api/subscribe', async (req, res) => {
    if (!supported) return res.status(503).json({ ok: false, message: 'Signups are paused. Try again soon.' });
    const ip = req.ip || req.socket.remoteAddress || '';
    if (!subscribeLimiter.check(ip).ok) return res.status(429).json({ ok: false, message: 'Too many tries. Try again later.' });
    const body = req.body || {};
    // Honeypot: a hidden field people never fill. Pretend it worked.
    if (honeypotTripped(body, 'newsletter signup', { slack })) return res.json({ ok: true });
    const email = normalizeEmail(body.email);
    // Logged without the address: enough to tell a typo from a bot-check
    // failure ([turnstile] rejected) when a signup is turned away.
    if (!email) {
      console.warn('[newsletter] signup rejected: invalid email');
      return res.status(400).json({ ok: false, message: 'Enter a valid email address.' });
    }
    // The bot check. A token that fails is a 400. No token at all usually
    // means the check never loaded (the Facebook/Instagram in-app browser,
    // where ad taps land, lost about 1 in 9 signups this way on Oct 7), so
    // that signup isn't refused: it gets a confirmation email instead, the
    // same as a comeback. A real reader taps it; an address a bot typed in
    // never gets on the list.
    // Without TURNSTILE_SECRET_KEY nothing is checked (verifyTurnstile
    // answers ok), so that signup isn't a verified person either: it gets the
    // confirmation email too, or anyone could put strangers' addresses on
    // the list.
    const human = turnstileConfigured && await verifyHuman(req);
    const hasToken = Boolean(body['cf-turnstile-response'] || body.turnstile_token);
    if (!human && hasToken && turnstileConfigured) return res.status(400).json({ ok: false, error: 'turnstile-failed', message: "We couldn't confirm you're not a bot. Please try again." });
    const unverified = !human;
    if (unverified) console.warn(turnstileConfigured ? '[newsletter] signup without a bot-check token: sending a confirmation email instead'
      : '[newsletter] Turnstile is not configured: sending a confirmation email instead');
    // Every outcome (new, waiting to confirm, already subscribed) gets the
    // same answer, so the form can't be used to find out who's on the list.
    // Whether it was a first signup is the browser's to know (docs/track.js
    // Lead), not the server's to say.
    // A referral link (/r/<code>) the browser carried to this form. It only
    // credits an active subscriber, and never the referrer's own inbox (a
    // +tag or Gmail dots make another address for it).
    let referredBy = null;
    const ref = normalizeRefCode(body.ref);
    if (ref && typeof store.getReferrer === 'function') {
      try {
        const referrer = await store.getReferrer(ref);
        if (referrer && emailKey(referrer.email) !== emailKey(email)) referredBy = referrer.ref_code;
      } catch (err) {
        console.warn('[newsletter] referral lookup failed:', err.message);
      }
    }
    // Unverified signups and any signup carrying a referral code all get the
    // confirm message, whatever the address's state or whose code it is, so
    // the form can't tell anyone who's subscribed or who owns a code.
    const almost = { ok: true, message: 'Almost there! Check your inbox and tap Confirm to start getting it.' };
    const confirmFirst = unverified || Boolean(ref);
    const done = confirmFirst && config.enabled
      ? almost
      : { ok: true, message: config.enabled ? "You're on the list! Check your inbox." : "You're on the list! Look for us Monday and Thursday mornings." };
    try {
      const source = signupSource(body.source);
      const sub = await store.addSubscriber({ email, source, referredBy });
      if (sub.status === 'active') return res.json(done);
      // A referred address still waiting to confirm stays that way when it's
      // sent again without the code: only its inbox can put it on the list.
      // The answer doesn't change (that would tell anyone it's waiting).
      const needsConfirm = confirmFirst || Boolean(sub.referred_by);
      // Single opt-in: a new address is on the list right away and gets the
      // welcome email (with its unsubscribe link) now. One of the first two
      // ad-driven signups never finished the confirmation step, and the Turnstile
      // check, honeypot and rate limit already keep out junk. The exception
      // is a comeback (old_tokens): someone who unsubscribed must confirm
      // from their own inbox, so nobody else can sign them back up. So does a
      // friend from a referral link: a made-up address can't tap Confirm, so
      // it never counts toward a reward.
      const comeback = (sub.old_tokens || []).length > 0;
      if (!comeback && !needsConfirm) {
        const confirmed = await store.confirmSubscriber(sub.token);
        // Not awaited: the welcome email shouldn't hold up the form.
        if (confirmed && confirmed.newly_confirmed) welcome(confirmed);
        return res.json(done);
      }
      // Email is off (no RESEND_API_KEY yet, or mid key rotation), so no
      // confirmation email can go out. The signup stays pending rather than
      // being confirmed for them: a comeback, a referred friend or an
      // unchecked signup only joins by tapping Confirm in their own inbox
      // (the reminder job asks them once email is on).
      if (!config.enabled) return res.json(done);
      // A few confirmation emails per inbox a day, whoever asks (a +tag or
      // Gmail dots don't make a new inbox), so the form can't be used to
      // flood someone's inbox.
      if (!confirmLimiter.check(inboxKey(email)).ok) return res.json(done);
      if (unverified && !unverifiedLimiter.check('all').ok) {
        console.warn('[newsletter] hourly cap on confirmation emails for signups without a bot check reached');
        return res.json(done);
      }
      const confirmUrl = `${siteUrl}/subscribe/confirm?token=${encodeURIComponent(sub.token)}`;
      const mail = renderConfirmEmail({ siteUrl, confirmUrl, address: config.address });
      // Same answer whether or not the email went: a failure here must not
      // tell anyone this address needed confirming (an unsubscribed or
      // waiting address) when a new one gets "You're on the list".
      try {
        await resend.send({ from: config.from, to: [email], subject: mail.subject, html: mail.html, text: mail.text });
      } catch (err) {
        console.error('[newsletter] confirmation email failed:', err.message);
        if (slack) slack.alert('newsletter-subscribe-failed', 'Newsletter confirmation emails are failing', err.message, `${siteUrl}/admin.html`);
      }
      res.json(done);
    } catch (err) {
      console.error('[newsletter] subscribe failed:', err.message);
      // Usually Resend (key rotated, domain unverified, outage): every signup
      // fails until someone looks, so tell the owner (de-duplicated by key).
      if (slack) slack.alert('newsletter-subscribe-failed', 'Newsletter signups are failing', err.message, `${siteUrl}/admin.html`);
      res.status(500).json({ ok: false, message: 'Something went wrong. Try again.' });
    }
  });

  // Slack hears about subscribers in batches: one ping each time the active
  // count lands on a multiple of SUBSCRIBER_PING_EVERY, with the total. A
  // dip and climb back (25 → 24 → 25) doesn't ping the same total twice
  // while this process runs.
  const SUBSCRIBER_PING_EVERY = 5;
  let lastSubscriberPing = 0;
  async function subscriberPing(sub) {
    if (!slack) return;
    try {
      const total = (await store.countSubscribers()).active;
      if (!total || total % SUBSCRIBER_PING_EVERY !== 0 || total <= lastSubscriberPing) return;
      lastSubscriberPing = total;
      slack.notify({ channel: 'hype', title: `📬 ${total} newsletter subscribers`, fields: [['Total subscribers', total],
        ['Newest', sub.email], ...(sub.source ? [['From', sub.source]] : []),
        ...(sub.referred_by ? [['Referred by', sub.referred_by]] : [])] });
    } catch (err) {
      console.warn('[newsletter] subscriber count for Slack failed:', err.message);
    }
  }

  async function welcome(sub) {
    subscriberPing(sub);
    if (!config.enabled || !config.address) return; // never send without the required mailing address
    try {
      const payload = await getPublicPayload();
      const unsubscribeUrl = `${siteUrl}/unsubscribe?token=${encodeURIComponent(sub.token)}`;
      const referral = await referralFor(sub);
      const mail = renderWelcomeEmail(payload.events, { siteUrl, now: nowFn(), sponsor: payload.sponsor, unsubscribeUrl, address: config.address, referral, replyAsk: Boolean(config.replyTo || config.inbound) });
      await resend.send({
        from: config.from, to: [sub.email], subject: mail.subject, html: mail.html, text: mail.text,
        ...(config.replyTo ? { reply_to: config.replyTo } : {}),
        headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
      // One key per confirmation: a comeback's welcome (new token, new
      // unsubscribe link) isn't a repeat of the first one, and reusing the
      // key would make Resend refuse it.
      }, `${town.keyPrefix}-welcome-${sub.id || sub.token}-${new Date(sub.confirmed_at || 0).getTime() || 0}`);
    } catch (err) {
      console.warn('[newsletter] welcome email failed:', err.message);
      // The signup is saved either way, but with single opt-in this is the
      // only email a new subscriber gets before Monday: a broken Resend key
      // or domain should reach the owner (de-duplicated by key).
      if (slack) slack.alert('newsletter-welcome-failed', 'Newsletter welcome emails are failing', err.message, `${siteUrl}/admin.html`);
    }
  }

  // Open tracking pixel. Always answers the image (an email client showing
  // a broken image would look bad), never cached, so each open asks again.
  // Opens are counted once per subscriber per issue (store.recordEmailOpen
  // ignores ids that aren't subscribers). Apple Mail loads images for its
  // users in the background and some work mail scanners do too, so the
  // rate reads higher than real opens; the admin tab says so.
  // Only issues from the last six months count, and each IP has an hourly
  // cap, so made-up URLs can't pad the table.
  app.get('/email/o/:week/:file', (req, res) => {
    const m = /^([A-Za-z0-9-]{8,64})\.gif$/.exec(req.params.file);
    const week = req.params.week;
    const today = localDateStr(nowFn());
    // A weekend issue is keyed by its Thursday, so one sent early in the
    // week has a key up to 3 days ahead.
    const recent = /^\d{4}-\d{2}-\d{2}$/.test(week) && week <= addDays(today, 3) && week >= addDays(today, -183);
    if (m && recent && pixelLimiter.check(req.ip || '').ok && supported && typeof store.recordEmailOpen === 'function') {
      store.recordEmailOpen({ week_key: req.params.week, subscriber_id: m[1] })
        .catch(err => console.warn('[newsletter] recording an open failed:', err.message));
    }
    res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, private', 'Content-Length': String(PIXEL_GIF.length) });
    res.end(PIXEL_GIF);
  });

  // Referral links. The code rides along to the signup form in the URL
  // (docs/track.js keeps it for the visit); nothing is looked up here, so
  // the link can't be used to check whose code is whose.
  app.get('/r/:code', (req, res) => {
    const code = normalizeRefCode(req.params.code);
    res.set('Cache-Control', 'no-store');
    res.redirect(302, code ? `/subscribe?ref=${code}` : '/subscribe');
  });

  // The referral program's official rules (the monthly drawing needs them).
  app.get('/referral-rules', (req, res) => {
    res.type('html').send(renderReferralRules({ siteUrl }));
  });

  app.get('/subscribe', async (req, res, next) => {
    try {
      const payload = await getPublicPayload();
      let count = 0;
      if (supported) { try { count = (await store.countSubscribers()).active || 0; } catch { /* page still works */ } }
      res.set('Cache-Control', 'public, max-age=300');
      // withNav (server/index.js) adds the seasonal tabs other pages get.
      const invited = Boolean(normalizeRefCode(req.query.ref));
      res.type('html').send(await withNav(renderSubscribePage(payload.events, { siteUrl, now: nowFn(), subscriberCount: count, invited }), '/subscribe'));
    } catch (err) {
      next(err);
    }
  });

  const findByToken = async (token) => {
    if (!supported || !token || typeof store.getSubscriberByToken !== 'function') return null;
    try { return await store.getSubscriberByToken(token); } catch { return null; }
  };
  const buttonPage = (path, title, lead, token, label) => layout({
    siteUrl, path, nav: null, noindex: true, pixel: false, title: `${title} | ${town.siteName}`, description: title,
    body: `<h1 class="page-title">${escHtml(title)}</h1><p class="page-lead">${lead}</p>
<form method="post" action="${path}?token=${encodeURIComponent(token)}"><button class="btn btn--primary" type="submit">${escHtml(label)}</button></form>`
  });

  // GET only shows a button: mail link scanners (Safe Links, Mimecast) open
  // every link, and a GET that confirmed would sign up people who never
  // clicked. The person's tap on the button is the opt-in.
  app.get('/subscribe/confirm', async (req, res) => {
    const token = String(req.query.token || '');
    const sub = await findByToken(token);
    if (supported && typeof store.getSubscriberByToken === 'function' && (!sub || sub.status === 'unsubscribed')) {
      return res.status(404).type('html').send(page('Link expired', 'That confirmation link isn\'t valid anymore. <a href="/subscribe">Sign up again</a>.'));
    }
    if (sub && sub.status === 'active') {
      return res.type('html').send(page("You're subscribed", 'The week\'s events will land in your inbox every Monday morning, and the weekend\'s every Thursday.'));
    }
    res.type('html').send(buttonPage('/subscribe/confirm', 'Confirm your subscription',
      'One tap and the week\'s events land in your inbox every Monday morning, and the weekend\'s every Thursday.', token, 'Confirm my subscription'));
  });

  app.post('/subscribe/confirm', async (req, res) => {
    const sub = supported ? await store.confirmSubscriber(String(req.query.token || '')) : null;
    // Only the first confirm: a second click on the same link sends nothing.
    if (sub && sub.newly_confirmed) welcome(sub);
    res.status(sub ? 200 : 404).type('html').send(sub
      ? page("You're subscribed", 'The week\'s events will land in your inbox every Monday morning, and the weekend\'s every Thursday.')
      : page('Link expired', 'That confirmation link isn\'t valid anymore. <a href="/subscribe">Sign up again</a>.'));
  });

  app.get('/unsubscribe', async (req, res) => {
    const token = String(req.query.token || '');
    // GET only shows a button: link scanners in mail systems follow GETs.
    // It names the (masked) address, so someone reading a forwarded copy can
    // see the link belongs to whoever forwarded it.
    const sub = await findByToken(token);
    const who = sub && sub.email ? ` for <strong>${escHtml(maskEmail(sub.email))}</strong>` : '';
    const forwarded = sub && sub.email ? ' <small>Not your address? This email was forwarded to you; <a href="/subscribe">sign up for your own</a> instead.</small>' : '';
    res.type('html').send(buttonPage('/unsubscribe', 'Unsubscribe', `Stop ${town.siteName} newsletter${who}?${forwarded}`, token, 'Unsubscribe'));
  });

  // Also the RFC 8058 one-click endpoint mail clients POST to.
  app.post('/unsubscribe', async (req, res) => {
    const ok = supported ? await store.unsubscribe(String(req.query.token || '')) : false;
    res.status(ok ? 200 : 404).type('html').send(ok
      ? page("You're unsubscribed", 'You won\'t get any more newsletters. You can <a href="/subscribe">sign up again</a> anytime.')
      : page('Link expired', 'That unsubscribe link isn\'t valid.'));
  });

  // Email settings: keep or skip the Thursday weekend issue. GET shows the
  // choice (link scanners follow GETs), POST makes it.
  const prefsPage = (sub, token, note = '') => {
    const off = Boolean(sub.weekend_optout);
    const action = `/email-prefs?token=${encodeURIComponent(token)}&weekend=${off ? '1' : '0'}`;
    return layout({
      siteUrl, path: '/email-prefs', nav: null, noindex: true, pixel: false, title: `Email settings | ${town.siteName}`, description: 'Email settings',
      body: `<h1 class="page-title">Email settings</h1>${note ? `<p class="page-lead"><strong>${escHtml(note)}</strong></p>` : ''}
<p class="page-lead">For <strong>${escHtml(maskEmail(sub.email))}</strong>: the Monday issue (the whole week) ${off ? 'only' : 'and the Thursday weekend issue (Friday to Sunday)'}.</p>
<form method="post" action="${action}"><button class="btn btn--primary" type="submit">${off ? 'Get the weekend issue too' : 'Just Mondays, skip the weekend issue'}</button></form>
<p><small>Want nothing at all? <a href="/unsubscribe?token=${encodeURIComponent(token)}">Unsubscribe</a>.</small></p>`
    });
  };
  app.get('/email-prefs', async (req, res) => {
    const token = String(req.query.token || '');
    const sub = supported && typeof store.setWeekendOptout === 'function' ? await findByToken(token) : null;
    res.set('Cache-Control', 'no-store');
    if (!sub || sub.status !== 'active') return res.status(404).type('html').send(page('Link expired', 'That link isn\'t valid anymore. <a href="/subscribe">Sign up again</a>.'));
    res.type('html').send(prefsPage(sub, token));
  });
  app.post('/email-prefs', async (req, res) => {
    const token = String(req.query.token || '');
    let sub = null;
    // Only an active subscriber's setting changes (a pending comeback's
    // link waits until they've confirmed).
    const current = supported && typeof store.setWeekendOptout === 'function' ? await findByToken(token) : null;
    if (current && current.status === 'active') {
      try { sub = await store.setWeekendOptout(token, String(req.query.weekend) === '0'); } catch (err) { console.warn('[newsletter] email settings failed:', err.message); }
    }
    res.set('Cache-Control', 'no-store');
    if (!sub || sub.status !== 'active') return res.status(404).type('html').send(page('Link expired', 'That link isn\'t valid anymore. <a href="/subscribe">Sign up again</a>.'));
    res.type('html').send(prefsPage(sub, token, sub.weekend_optout ? 'Done: just Mondays from now on.' : 'Done: you\'ll get the weekend issue on Thursdays too.'));
  });

  app.get('/api/admin/newsletter', requireAdmin, async (req, res) => {
    if (!supported) return res.json({ ok: false, error: 'not-supported' });
    const counts = await store.countSubscribers();
    // Two issues a week: 16 is the last eight weeks.
    let sends = await store.listNewsletterSends(16);
    // Unique opens per issue. A failed read leaves them off, not the tab.
    if (typeof store.countEmailOpens === 'function' && sends.length) {
      try {
        const opens = await store.countEmailOpens(sends.map(x => x.week_key));
        sends = sends.map(x => ({ ...x, opens: opens[x.week_key] || 0 }));
      } catch (err) {
        console.warn('[newsletter] reading opens failed:', err.message);
      }
    }
    const payload = await getPublicPayload();
    const now = nowFn();
    const issue = renderWeekly(payload.events, { siteUrl, now, sponsor: payload.sponsor, unsubscribeUrl: '#', address: config.address });
    // A week whose send partly failed isn't "sent": the button stays on to
    // retry just the people who missed it (sendWeekly resumes).
    // Top referrers and their rewards (emails shown in full: this is the
    // owner's admin, and a held reward needs a person to look at it).
    let referrers = [], referralRewards = [];
    if (typeof store.topReferrers === 'function') {
      try { referrers = await store.topReferrers(10); } catch (err) { console.warn('[newsletter] reading referrers failed:', err.message); }
    }
    try {
      referralRewards = (await rewards.list(20)).map(r => ({ id: r.id, email: r.email, what: rewards.describe(r), status: r.status,
        flags: r.flags, reason: r.reason, created_at: r.created_at }));
    } catch (err) { console.warn('[newsletter] reading referral rewards failed:', err.message); }
    // This week's two issues, and how many skip Thursday's.
    const today = localDateStr(now);
    const [record, wkRecord, optedOut] = await Promise.all([
      store.getNewsletterSend(EDITIONS.weekly.key(today)),
      store.getNewsletterSend(EDITIONS.weekend.key(today)),
      typeof store.countWeekendOptouts === 'function' ? store.countWeekendOptouts().catch(() => 0) : 0
    ]);
    const failed = failedCount(record);
    const wkFailed = failedCount(wkRecord);
    // Possibly sent, past Resend's key window: only resent on purpose.
    const unknownCount = r => (r && Array.isArray(r.chunks) ? r.chunks.filter(c => c && c.state === 'sent-unknown').reduce((n, c) => n + (c.emails || []).length, 0) : 0);
    const wkIssue = renderWeekly(payload.events, { siteUrl, now, sponsor: payload.sponsor, unsubscribeUrl: '#', address: config.address, edition: 'weekend' });
    res.json({
      ok: true, configured: config.enabled, from: config.from, address_set: Boolean(config.address),
      autosend: config.enabled && config.autosend, counts, next: { subject: issue.subject, events: issue.total },
      referrers, referral_tiers: referralTiers(), referral_rewards: referralRewards,
      gift_cards: tremendous && tremendous.enabled ? 'tremendous' : 'manual',
      this_week_sent: Boolean(record) && !failed,
      this_week_failed: failed,
      this_week_recipients: record ? Number(record.recipients) || 0 : 0,
      this_week_unknown: unknownCount(record),
      weekend: {
        enabled: config.weekend, opted_out: optedOut, next: { subject: wkIssue.subject, events: wkIssue.total },
        sent: Boolean(wkRecord) && !wkFailed, failed: wkFailed, recipients: wkRecord ? Number(wkRecord.recipients) || 0 : 0,
        unknown: unknownCount(wkRecord)
      },
      // The chunk plan (every address) stays on the server.
      sends: sends.map(({ chunks: _c, ...x }) => ({ ...x, edition: editionOf(x.week_key) }))
    });
  });

  const editionParam = v => (v === 'weekend' ? 'weekend' : 'weekly');
  app.get('/api/admin/newsletter/preview', requireAdmin, async (req, res) => {
    const payload = await getPublicPayload();
    const issue = renderWeekly(payload.events, { siteUrl, now: nowFn(), sponsor: payload.sponsor, unsubscribeUrl: '#', address: config.address, replyAsk: Boolean(config.replyTo || config.inbound),
      edition: editionParam(req.query.edition), prefsUrl: config.weekend ? '#' : '' });
    res.type('html').send(issue.html);
  });

  app.post('/api/admin/newsletter/test', requireAdmin, async (req, res) => {
    if (!config.enabled) return res.status(503).json({ ok: false, error: 'not-configured' });
    const to = normalizeEmail((req.body || {}).email) || normalizeEmail(config.testTo);
    if (!to) return res.status(400).json({ ok: false, error: 'no-test-address', message: 'Enter an address to send the test to.' });
    try {
      const payload = await getPublicPayload();
      const issue = renderWeekly(payload.events, { siteUrl, now: nowFn(), sponsor: payload.sponsor, unsubscribeUrl: `${siteUrl}/unsubscribe`, address: config.address, replyAsk: Boolean(config.replyTo || config.inbound),
        edition: editionParam((req.body || {}).edition), prefsUrl: config.weekend ? `${siteUrl}/email-prefs` : '' });
      await resend.send({ from: config.from, to: [to], subject: `[Test] ${issue.subject}`, html: issue.html, text: issue.text, ...(config.replyTo ? { reply_to: config.replyTo } : {}) });
      res.json({ ok: true, to });
    } catch (err) {
      res.status(502).json({ ok: false, error: 'send-failed', message: err.message });
    }
  });

  // A held, failed or by-hand referral reward: send it now, or skip it.
  app.post('/api/admin/newsletter/rewards/:id/:action', requireAdmin, async (req, res) => {
    const { id, action } = req.params;
    if (!['approve', 'skip'].includes(action)) return res.status(404).json({ ok: false, message: 'Unknown action.' });
    try {
      const out = action === 'approve' ? await rewards.approve(id) : await rewards.skip(id);
      res.status(out.status).json({ ok: out.ok, message: out.message, reward: out.reward });
    } catch (err) {
      console.error('[referrals] admin reward action failed:', err.message);
      res.status(503).json({ ok: false, message: `Couldn't update the reward: ${err.message}` });
    }
  });

  app.post('/api/admin/newsletter/send', requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      // resend_unknown: the admin's explicit "Resend unconfirmed", after the
      // warning that some of them may get it twice (see sendWeeklyNow).
      const out = await sendWeekly({ force: Boolean(b.force), resendUnknown: b.resend_unknown === true, edition: editionParam(b.edition) });
      if (!out.ok && out.failed) out.message = `Sent to ${out.recipients}, but ${out.failed} failed (${(out.errors || [])[0] || 'email service error'}). Press Retry to send to the rest.`;
      else if (out.unknown) out.message = `Sent to ${out.recipients}. ${out.unknown} may or may not have gotten it (Resend never answered, over a day ago); they weren't sent it again.`;
      res.status(out.ok ? 200 : (out.error === 'not-configured' ? 503 : 409)).json(out);
    } catch (err) {
      res.status(500).json({ ok: false, error: 'send-failed', message: err.message });
    }
  });

  app.post('/api/admin/newsletter/import', requireAdmin, async (req, res) => {
    const raw = String((req.body || {}).emails || '');
    const emails = [...new Set(raw.split(/[\s,;]+/).map(normalizeEmail).filter(Boolean))];
    if (!emails.length) return res.status(400).json({ ok: false, message: 'No valid email addresses found.' });
    // Anyone who unsubscribed, complained or bounced here is skipped and
    // counted (skipped_unsubscribed, skipped_bounced), never made active.
    const result = await store.importSubscribers(emails, 'import');
    res.json({ ok: true, ...result });
  });

  // The automatic Monday send, from the site scheduler or the cron
  // endpoint. `ok` means done for this week (sent, already sent, nothing to
  // send); `final` means retrying won't help (setup missing).
  async function scheduledSend(edition = 'weekly') {
    const weekend = edition === 'weekend';
    const out = await sendWeekly({ edition });
    // Same Monday run: last week's sponsors get their click reports
    // (server/sponsors.js sendSponsorReports; safe to call more than once).
    if (onCron && !weekend) {
      try { out.sponsor_reports = await onCron(nowFn()); } catch (err) {
        console.error('[newsletter] sponsor reports failed:', err.message);
        if (slack) slack.alert('sponsor-reports', 'Sponsor click reports failed', err.message, `${siteUrl}/admin.html`);
      }
    }
    // The automatic send found nothing published for the days it covers.
    if (slack && out.error === 'no-events') {
      slack.alert(`newsletter-no-events${weekend ? '-weekend' : ''}`,
        weekend ? 'Weekend newsletter skipped: nothing published for Friday to Sunday' : 'Newsletter skipped: nothing published for this week',
        'Publish the events in admin, then send it from the Newsletter tab.', `${siteUrl}/admin.html`);
    }
    if (slack && out.error === 'no-address') {
      slack.alert('newsletter-no-address', 'Newsletter not sent: no mailing address', out.message, `${siteUrl}/admin.html`);
    }
    const done = out.ok || ['already-sent', 'no-events', 'no-subscribers', 'in-progress', 'weekend-off'].includes(out.error);
    return { ...out, edition, ok: done, sent_ok: out.ok, final: ['not-configured', 'no-address', 'weekend-off'].includes(out.error) };
  }

  // Scheduled send (GitHub Actions fallback, newsletter.yml). Needs the
  // shared secret; refuses when no secret is configured so the endpoint
  // can't be triggered by anyone. A run marked X-Cron-Scheduled honors
  // NEWSLETTER_AUTOSEND=0; a hand-started run sends regardless.
  app.post('/api/newsletter/cron', async (req, res) => {
    const given = Buffer.from(String(req.get('x-cron-secret') || ''));
    const want = Buffer.from(config.cronSecret || '');
    // Compare byte lengths: timingSafeEqual throws on a length mismatch,
    // and a non-ASCII header has more bytes than characters.
    const ok = want.length > 0 && given.length === want.length && crypto.timingSafeEqual(given, want);
    if (!ok) return res.status(401).json({ ok: false, error: 'unauthorized' });
    if (req.get('x-cron-scheduled') === '1' && !config.autosend) {
      return res.json({ ok: false, error: 'autosend-off', message: 'NEWSLETTER_AUTOSEND=0 in Railway; not sending automatically.' });
    }
    try {
      // newsletter.yml sends X-Newsletter-Edition: weekend on Thursdays.
      const { ok: done, sent_ok: sentOk, final: _f, ...out } = await scheduledSend(req.get('x-newsletter-edition') === 'weekend' ? 'weekend' : 'weekly');
      // already-sent / no-events are normal outcomes for a cron, not failures.
      res.status(done ? 200 : 500).json({ ...out, ok: sentOk });
    } catch (err) {
      if (slack) slack.alert('newsletter-cron', 'Newsletter send crashed', err.message);
      res.status(500).json({ ok: false, error: 'send-failed', message: err.message });
    }
  });

  // One reminder, a day after signing up, to anyone who got the "tap to
  // confirm" email and hasn't (the Facebook in-app browser sometimes skips
  // the bot check, and those signups have to confirm). Only signups from
  // the last week, so old pending rows aren't dug up. Hourly, from the
  // scheduler's health job; claims each row first so it's sent once.
  async function sendConfirmReminders(now = nowFn()) {
    if (!supported || !config.enabled || !config.address || typeof store.listConfirmReminders !== 'function') return { sent: 0 };
    const t = now.getTime();
    const due = await store.listConfirmReminders({
      from: new Date(t - 7 * 24 * 3600e3).toISOString(), to: new Date(t - 24 * 3600e3).toISOString(), limit: 50
    });
    let sent = 0;
    for (const sub of due) {
      if (!(await store.markReminded(sub.id))) continue;
      try {
        const confirmUrl = `${siteUrl}/subscribe/confirm?token=${encodeURIComponent(sub.token)}`;
        const mail = renderConfirmEmail({ siteUrl, confirmUrl, address: config.address, reminder: true });
        await resend.send({ from: config.from, to: [sub.email], subject: mail.subject, html: mail.html, text: mail.text }, `${town.keyPrefix}-remind-${sub.id}`);
        sent++;
      } catch (err) {
        console.warn('[newsletter] confirm reminder failed:', err.message);
        try { await store.markReminded(sub.id, false); } catch { /* tried again next hour or never */ }
      }
    }
    if (sent) console.log(`[newsletter] sent ${sent} confirm reminder(s)`);
    return { sent };
  }

  return { sendWeekly, scheduledSend, sendConfirmReminders };
}
