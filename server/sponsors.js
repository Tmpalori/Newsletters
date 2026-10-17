/* server/sponsors.js — Self-serve sponsor checkout through Stripe.
 *
 * A business picks a package on /advertise, fills one short form, pays on
 * Stripe Checkout, and the placement goes live on its own:
 *
 *   - Weekly sponsor ($149, one-time): books one Monday–Sunday week. Their
 *     block replaces the sponsor slot on every page, in /events.json, and in
 *     that week's newsletters (Monday's and Thursday's). One sponsor per week; a week someone is
 *     paying for right now is held for the life of the Checkout session.
 *   - Venue partner (retired Oct 2026, no longer sold): a $150/month Stripe
 *     subscription that made every event at the venue a Vic’s Pick. It
 *     flooded busy days past the Vic’s Pick limits and undercut the per-event
 *     price, so it's off /advertise and checkout. Subscriptions bought before
 *     then are still honored (applyPlacements) until they're cancelled in
 *     Stripe (customer.subscription.* webhooks).
 *   - Vic’s Pick event (one-time; $29 Mon–Thu, $39 Fri–Sun): the event lands
 *     in the submissions queue (so a person still checks it before it's
 *     listed) and is pinned as Featured as soon as it, or a matching
 *     collector event, is live. Limited per day (VICS_PICK caps) so the top
 *     of a day stays special; a day that's full can't be bought.
 *
 * Every checkout form shows a live preview of the placement (the same
 * markup the site uses) before anyone is sent to pay.
 *
 * Weekly sponsors get a report the Monday after their week
 * (sendSponsorReports): how often their block was seen (data-ad
 * impressions from docs/track.js) and where, site clicks from the track
 * beacon, email clicks from the /go/s/<week> redirect the newsletter's
 * sponsor button uses. Vic's Picks get one the morning after their event
 * (sendPickReports). Both run from the Monday newsletter cron and the
 * 15-minute submission review cron (they're idempotent); the Sponsors
 * tab's Report button shows the same numbers live. The admin can edit a
 * weekly order's wording, link, logo and week (Sponsors tab).
 *
 * Placements are applied when the public payload is read (see
 * applyPlacements), never written into the published events, so Save &
 * Publish can't wipe them and a hidden or cancelled order disappears on
 * the next request.
 *
 * Stripe is called with fetch (no SDK; AGENTS.md: no new dependencies).
 * The webhook verifies Stripe's HMAC signature over the raw body, so it is
 * registered before express.json (see registerStripeWebhook).
 *
 * Off until STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are both set; until
 * then /advertise keeps the email-us flow.
 */

import { town, dollars, VICTORIA } from './town.js';
import { hqPaths, viaHq } from './hqAdmin.js';
import crypto from 'node:crypto';
import { ipKey } from './rateLimit.js';
import { burst } from './burst.js';
import express from 'express';
import { passiveGuard } from './formGuard.js';
import { impossibleEmailError } from './emailTypos.js';
import {
  AD_PACKAGES, escHtml, safeUrl, localDateStr, currentWeek, addDays, formatDay, layout,
  renderEventItem, sponsorHtml, dayClass, sortEvents, SAMPLE_LOGO, reachPitchHtml
} from './seo.js';
import { normalizeUrl, validateSubmission } from './validate.js';
import { normalizePayload, newId, nowIso, eventKeyOf } from './db.js';
import { normalizeEmail } from './newsletter.js';
import { honeypotTripped } from './honeypot.js';
import { venueFor } from './guides.js';
import { renderSponsorConfirmed, renderSponsorReport, renderPickReport, renderSponsorTooLate, renderSponsorPaymentFailed, renderSponsorConflict, newsletterCovers, weekendCovers, weekendIssueOn, pickWhere,
  renderPartnerReceived, renderPartnerLive, renderPartnerRejected, renderPartnerCanceled, renderPartnerReport } from './notify.js';
import { partnerCardEmail } from './newsletter.js';
import {
  partnerCategories, categoryOf, takesCategory, openCategories, partnersPayload, partnerBlock, publicPartner,
  manageOk, manageUrl, PARTNER_SOURCES, partnersOn
} from './partners.js';
import { botName, visitorHash, pageType, PAGE_TYPES, rowCount, SHARED_LINK } from './analytics.js';
import { ADVERTISING_TERMS_VERSION } from './legal.js';

export { newsletterCovers, pickWhere };

const STRIPE_API = 'https://api.stripe.com/v1';
// A hung Stripe call would hold the buyer's hold (and the request) for
// undici's ~300 s default; the callers' catch releases it and says "try again".
const STRIPE_TIMEOUT_MS = 20 * 1000;
// Stripe's shortest Checkout expiry is 30 minutes; hold a week a little
// longer so it can't be resold while the first buyer is still paying.
const CHECKOUT_TTL_S = 31 * 60;
export const HOLD_MS = 35 * 60 * 1000;
// The advertising terms (server/legal.js BOOKING) state these; keep them in
// step (tests/legal_pages.test.js).
export const WEEKS_AHEAD = 8;
export const FEATURE_DAYS_AHEAD = 120;
const SIG_TOLERANCE_S = 300;
// Orders are read on every page view; a minute of staleness is fine and
// every write below clears it anyway.
const CACHE_MS = 60 * 1000;
const LIVE = new Set(['paid', 'active']);
// Weekly orders the admin can edit (wording, link, logo, week).
const EDITABLE = new Set(['paid', 'hidden', 'processing', 'conflict']);
// /advertise/checkout?from=<submission> fills in the submitter's contact
// details only this long after they submitted (and only while it's pending).
const PREFILL_CONTACT_MS = 7 * 24 * 3600 * 1000;
// Weekly sponsor click reports go out from the Monday after the week, and
// a run that was missed catches up for this long.
const REPORT_CATCHUP_DAYS = 14;
// Vic's Pick reports go out from 9 AM (Victoria time) the day after the event.
const PICK_REPORT_HOUR = 9;
// A "you're booked" email that didn't send (Resend down) is retried by the
// periodic report run for this long after payment; the owner hears once it
// has failed this many times.
const CONFIRM_RETRY_DAYS = 7;
const CONFIRM_ALERT_AFTER = 3;

export function stripeConfig(env = process.env, overrides = {}) {
  const c = {
    secretKey: overrides.stripeSecretKey ?? env.STRIPE_SECRET_KEY ?? '',
    webhookSecret: overrides.stripeWebhookSecret ?? env.STRIPE_WEBHOOK_SECRET ?? ''
  };
  // Taking money without the webhook would mean nothing gets fulfilled.
  c.enabled = Boolean(c.secretKey && c.webhookSecret);
  // Which Stripe mode the key is in (secret sk_ or restricted rk_), and
  // whether this is the production service: a test-mode payment there is
  // never fulfilled while the key is live (the webhook), and a test key
  // there is flagged in the Setup checklist.
  c.liveKey = /^(sk|rk)_live_/.test(c.secretKey);
  c.testKey = /^(sk|rk)_test_/.test(c.secretKey);
  c.production = (overrides.railwayEnvironment ?? env.RAILWAY_ENVIRONMENT_NAME) === 'production';
  return c;
}

export function packageFor(key) {
  return AD_PACKAGES.find(p => p.key === key) || null;
}

// ─── Vic’s Pick pricing and capacity ─────────────────────────────────────
// "Weekend" is Fri–Sun, the site's own "This weekend". Caps are per day.
// The town's numbers (town.business), read when used.
export const VICS_PICK = {
  get weekdayAmount() { return town.business.pickAmount.weekday; },
  get weekendAmount() { return town.business.pickAmount.weekend; },
  get weekdayCap() { return town.business.pickCap.weekday; },
  get weekendCap() { return town.business.pickCap.weekend; }
};

export function isWeekendDate(dateStr) {
  const dow = new Date(`${dateStr}T12:00:00Z`).getUTCDay(); // 0 Sun … 6 Sat
  return dow === 5 || dow === 6 || dow === 0;
}

// The Stripe product/price for a Vic’s Pick on that date (weekend picks are
// their own catalog price, so receipts and reports tell them apart).
export function pickPackage(dateStr) {
  const base = packageFor('featured');
  if (!isWeekendDate(dateStr)) return { ...base, amount: VICS_PICK.weekdayAmount };
  return { ...base, key: 'featured_weekend', name: `${base.name} (Fri–Sun)`, amount: VICS_PICK.weekendAmount };
}

// A checkout someone is paying for right now. `email` is the buyer asking:
// their own earlier hold (they backed out of Stripe and came back) doesn't
// count against them.
function isHold(o, nowMs, email = '') {
  return o.status === 'pending' && nowMs - Date.parse(o.created_at) < HOLD_MS && !(email && o.email === email);
}

// Who started a checkout, for "one open hold per client": the client's
// address (ipKey, IPv6 on its /64), hashed with a server secret so no IP is
// stored on the order.
// Open (unpaid) checkouts one network address may hold at once.
export const MAX_HOLDS_PER_CLIENT = 3;

export function holdClient(ip, secret = '') {
  return crypto.createHash('sha256').update(`hold|${secret}|${ipKey(ip)}`).digest('hex').slice(0, 16);
}

// Spots used on a date: paid or settling orders, plus checkouts still being
// paid (held like weekly sponsor weeks, so a day can't be oversold).
export function picksTaken(dateStr, orders, nowMs, email = '') {
  return (orders || []).filter(o => o.kind === 'featured' && o.event && o.event.date === dateStr &&
    (LIVE.has(o.status) || o.status === 'processing' || isHold(o, nowMs, email))).length;
}

// Admin calendar: every sponsorship slot for `weeks` weeks from this
// Monday. Each week has the weekly-sponsor slot; each day its Vic’s Pick
// spots with who holds them. state: 'booked' (paid / live), 'processing'
// (slow payment settling), 'held' (checkout open right now), 'open'.
function slotState(o, nowMs) {
  if (LIVE.has(o.status)) return 'booked';
  if (o.status === 'processing') return 'processing';
  if (o.status === 'pending' && nowMs - Date.parse(o.created_at) < HOLD_MS) return 'held';
  return null;
}

export function sponsorCalendar(now, orders, weeks = 8) {
  const nowMs = now.getTime();
  const today = localDateStr(now);
  const monday = currentWeek(today)[0];
  const short = { month: 'short', day: 'numeric' };
  const active = (orders || []).map(o => ({ o, state: slotState(o, nowMs) })).filter(x => x.state);
  return Array.from({ length: weeks }, (_, w) => {
    const start = addDays(monday, 7 * w);
    const weekly = active.find(x => x.o.kind === 'weekly' && x.o.week_start === start);
    const days = Array.from({ length: 7 }, (_, d) => {
      const date = addDays(start, d);
      const a = pickAvailability(date, orders, now);
      const picks = active.filter(x => x.o.kind === 'featured' && x.o.event && x.o.event.date === date)
        .map(x => ({ id: x.o.id, business: x.o.business || '', event: x.o.event.name || '', state: x.state }));
      return { date, past: date < today, weekend: a.weekend, cap: a.cap, taken: a.taken, left: a.left, price: a.price, picks };
    });
    return {
      start, label: `${formatDay(start, short)} – ${formatDay(addDays(start, 6), short)}`,
      weekly: weekly ? { id: weekly.o.id, business: weekly.o.business || '', state: weekly.state } : null,
      days
    };
  });
}

export function pickAvailability(dateStr, orders, now, email = '') {
  const weekend = isWeekendDate(dateStr);
  const cap = weekend ? VICS_PICK.weekendCap : VICS_PICK.weekdayCap;
  const taken = picksTaken(dateStr, orders, now.getTime(), email);
  const amount = weekend ? VICS_PICK.weekendAmount : VICS_PICK.weekdayAmount;
  return { date: dateStr, weekend, cap, taken, left: Math.max(0, cap - taken), amount, price: `$${amount / 100}` };
}

// ─── Stripe client ───────────────────────────────────────────────────────

// Stripe takes form encoding with bracketed keys: line_items[0][quantity]=1.
export function formEncode(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') formEncode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

// Pinned so request and response shapes don't change under us when Stripe
// ships a new version. Set the webhook endpoint to the same version in the
// Dashboard so events match.
export const STRIPE_API_VERSION = '2026-09-30.endive';
// Tags our Checkout Sessions in the Dashboard (Stripe asks for an 8-letter suffix).
export const INTEGRATION_ID = 'vic361_sponsor_checkout_qvbkmxtr';

// Events whose object carries our metadata.town (sessions and
// subscriptions). Untagged ones are Victoria's: they predate towns.
// Invoices, charges and fraud warnings carry none; they only ever match
// this town's own orders.
const TOWN_TAGGED = /^(checkout\.session|customer\.subscription)\./;
const eventTown = obj => (obj && obj.metadata && obj.metadata.town) || VICTORIA.id;
// Every town's sessions are tagged, Victoria's too since Oct 2026 (her
// older sessions and subscriptions are untagged, which still means hers).
const townTag = () => ({ town: town.id });

// The card-statement suffix that tells a buyer which town they paid, since
// all towns share one Stripe account: the site name without a leading
// "The", upper case, Stripe's allowed characters only ("VIC 361",
// "SHOALS"). At most 10 characters, cut at a word, so the account's prefix
// (up to 10) plus "* " and this stays inside Stripe's 22.
export function statementSuffix(siteName) {
  const words = String(siteName || '').replace(/^the\s+/i, '').toUpperCase()
    .replace(/[^A-Z0-9 .-]/g, '').split(/\s+/).filter(Boolean);
  let out = '';
  for (const w of words) {
    const next = out ? `${out} ${w}` : w;
    if (next.length > 10) break;
    out = next;
  }
  if (!out && words[0]) out = words[0].slice(0, 10);
  return /[A-Z]/.test(out) ? out : undefined;
}

// Stripe's refusal of a catalog price that was archived ("The price
// specified is inactive"), or whose product was ("... is not active"), or
// that's gone.
const INACTIVE_PRICE = /inactive|not active|archived|no such price/i;

export function createStripe(secretKey, fetchImpl = globalThis.fetch) {
  async function call(method, path, params, idempotencyKey) {
    const qs = method === 'GET' && params ? `?${formEncode(params)}` : '';
    const res = await fetchImpl(`${STRIPE_API}${path}${qs}`, {
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Stripe-Version': STRIPE_API_VERSION,
        ...(method === 'GET' ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {})
      },
      body: method === 'GET' ? undefined : formEncode(params || {}).toString(),
      signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS)
    }).catch(err => {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw Object.assign(new Error(`Stripe didn't answer within ${STRIPE_TIMEOUT_MS / 1000} s`), { code: 'timeout' });
      }
      throw err;
    });
    let body = null;
    try { body = await res.json(); } catch (_) { body = null; }
    if (!res.ok || !body) {
      const err = new Error((body && body.error && body.error.message) || `Stripe HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  // One Product + Price per package, found by lookup_key and created the
  // first time it's needed, so the Dashboard catalog and reports show
  // "Weekly sponsor" etc. instead of a throwaway product per checkout.
  const priceCache = new Map();
  const lookupKeyOf = pkg => `${town.keyPrefix}_${pkg.key}_${pkg.amount}${pkg.interval ? `_${pkg.interval}` : ''}`;
  async function ensurePrice(pkg) {
    const lookupKey = lookupKeyOf(pkg);
    if (priceCache.has(lookupKey)) return priceCache.get(lookupKey);
    const found = await call('GET', '/prices', { 'lookup_keys[]': lookupKey, active: 'true', limit: 1 });
    let id = found && Array.isArray(found.data) && found.data[0] && found.data[0].id;
    if (!id) {
      const product = await call('POST', '/products', {
        name: `${town.siteName}: ${pkg.name}`, metadata: { [`${town.keyPrefix}_package`]: pkg.key }
      }, `${town.keyPrefix}-product-${pkg.key}`);
      const price = await call('POST', '/prices', {
        product: product.id, currency: 'usd', unit_amount: pkg.amount, lookup_key: lookupKey,
        recurring: pkg.interval ? { interval: pkg.interval } : undefined
      }, `${town.keyPrefix}-price-${lookupKey}`);
      id = price.id;
    }
    priceCache.set(lookupKey, id);
    return id;
  }

  return {
    ensurePrice,
    // The cached id stopped working (the price or its product was archived
    // in the Dashboard): the next ensurePrice looks it up again.
    forgetPrice(pkg) { priceCache.delete(lookupKeyOf(pkg)); },
    async createCheckoutSession(params, idempotencyKey) {
      const body = await call('POST', '/checkout/sessions', params, idempotencyKey);
      if (typeof body.url !== 'string' || typeof body.id !== 'string') throw new Error('Stripe returned no checkout URL');
      return { id: body.id, url: body.url };
    },
    // The buyer came back from Stripe without paying: close the session so
    // it can't be paid later for a spot we've released.
    async expireCheckoutSession(id) {
      return call('POST', `/checkout/sessions/${encodeURIComponent(id)}/expire`, {});
    },
    // Category partners (server/partners.js). The restricted key needs
    // Subscriptions, Refunds and Billing portal write and Invoices read
    // for these (AGENTS.md owner setup).
    // Rejected by the owner: end the subscription now (no proration, no
    // final invoice), then refund what it charged.
    async cancelSubscription(id) {
      return call('DELETE', `/subscriptions/${encodeURIComponent(id)}`, {});
    },
    // The payment an invoice was paid with: older API versions put it on
    // the invoice (payment_intent or charge), newer ones in its payments.
    async invoicePayment(invoiceId) {
      const inv = await call('GET', `/invoices/${encodeURIComponent(invoiceId)}`, null);
      if (inv && typeof inv.payment_intent === 'string') return { payment_intent: inv.payment_intent };
      if (inv && typeof inv.charge === 'string') return { charge: inv.charge };
      const pays = await call('GET', '/invoice_payments', { invoice: invoiceId, limit: 3 });
      const hit = ((pays && pays.data) || []).map(x => x && x.payment).find(x => x && (typeof x.payment_intent === 'string' || typeof x.charge === 'string'));
      return hit ? (typeof hit.payment_intent === 'string' ? { payment_intent: hit.payment_intent } : { charge: hit.charge }) : null;
    },
    async refund(target, idempotencyKey) {
      return call('POST', '/refunds', { ...target, reason: 'requested_by_customer' }, idempotencyKey);
    },
    // The partner's own billing page (update the card, cancel). Stripe
    // refuses until the Customer portal is saved once in the Dashboard.
    async createPortalSession(customer, returnUrl) {
      const body = await call('POST', '/billing_portal/sessions', { customer, return_url: returnUrl });
      if (typeof body.url !== 'string') throw new Error('Stripe returned no portal URL');
      return { url: body.url };
    }
  };
}

// Stripe-Signature: t=<unix>,v1=<hex hmac of "t.rawBody">[,v1=...]
export function verifyStripeSignature(rawBody, header, secret, nowSec = Math.floor(Date.now() / 1000)) {
  if (!rawBody || !header || !secret) return false;
  let t = null;
  const sigs = [];
  for (const part of String(header).split(',')) {
    const [k, v] = part.split('=');
    if (k === 't') t = Number(v);
    else if (k === 'v1' && v) sigs.push(v);
  }
  if (!Number.isFinite(t) || !sigs.length || Math.abs(nowSec - t) > SIG_TOLERANCE_S) return false;
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex'));
  return sigs.some(s => {
    const got = Buffer.from(s);
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  });
}

// ─── Placements ──────────────────────────────────────────────────────────

function nameKey(s) {
  return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

const VENUE_STOP = new Set(['the', 'and', 'victoria', 'texas', 'bar', 'grill', 'pub', 'cafe', 'park',
  'center', 'centre', 'church', 'hall', 'club', 'house', 'street']);
function venueWords(v) {
  return new Set(nameKey(v).split(' ').filter(w => w.length >= 4 && !VENUE_STOP.has(w)));
}
// Two named venues that share no distinctive word are different places.
function differentPlaces(a, b) {
  const va = nameKey(a.venue), vb = nameKey(b.venue);
  if (!va || !vb || va.includes(vb) || vb.includes(va)) return false;
  const wb = venueWords(b.venue);
  return ![...venueWords(a.venue)].some(w => wb.has(w));
}

// Same day, same place (when both name one) and a clearly matching name:
// exact, one containing the other, or most words shared ("Fall Festival" vs
// "Fall Festival at De Leon Plaza"). "Live Music" at two bars is two events.
export function sameEvent(a, b) {
  if (!a || !b || a.date !== b.date) return false;
  if (differentPlaces(a, b)) return false;
  const ka = nameKey(a.name);
  const kb = nameKey(b.name);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  if ((ka.length >= 6 && kb.includes(ka)) || (kb.length >= 6 && ka.includes(kb))) return true;
  const ta = new Set(ka.split(' '));
  const tb = new Set(kb.split(' '));
  const shared = [...ta].filter(x => tb.has(x)).length;
  return shared / new Set([...ta, ...tb]).size >= 0.6;
}

// Whether a Vic's Pick order is this event. `pins` maps order id to the
// other shapes the event may be live as: its submission as it is now (the
// admin may have fixed the date, venue or name when approving) and any
// Events-tab edit of that, so an edit doesn't silently drop the pin.
export function pickMatches(order, ev, pins = new Map()) {
  if (sameEvent(order.event, ev)) return true;
  const key = eventKeyOf(ev);
  return (pins.get(order.id) || []).some(s => eventKeyOf(s) === key || sameEvent(s, ev));
}

export function applyPlacements(payload, orders, { now, venues = [], pins = new Map() }) {
  if (!payload) return payload;
  // Category partners (server/partners.js): the live ones and the open
  // categories, as `partners`; left off entirely until a town has had a
  // category order, so its payload is as it was before partners.
  const categoryPartners = partnersPayload(orders, o => isHold(o, now.getTime()));
  if (categoryPartners) payload = { ...payload, partners: categoryPartners };
  const live = (orders || []).filter(o => LIVE.has(o.status) && o.kind !== 'category');
  if (!live.length) return payload;
  const week = currentWeek(localDateStr(now))[0];
  const weekly = live.find(o => o.kind === 'weekly' && o.week_start === week);
  const featured = live.filter(o => o.kind === 'featured' && o.event);
  const partners = new Set(live.filter(o => o.kind === 'partner').map(o => o.venue_slug));
  const events = (payload.events || []).map(ev => {
    // `sponsor_order` tags a paid pick with its order (data-ad in the
    // markup), so its views and clicks land in the buyer's report. Checked
    // before `featured`: an event the admin already starred is still theirs.
    const order = featured.find(o => pickMatches(o, ev, pins));
    if (order) return { ...ev, featured: true, sponsor_order: order.id };
    if (ev.featured) return ev;
    if (partners.size) {
      const v = venueFor(ev, venues);
      if (v && partners.has(v.slug)) return { ...ev, featured: true };
    }
    return ev;
  });
  // `week` lets the newsletter route the sponsor's button through
  // /go/s/<week>, which counts email clicks for the sponsor's report;
  // `order` tags the block (data-ad) for its view count.
  return { ...payload, events, sponsor: weekly ? { ...weekly.sponsor, week: weekly.week_start, order: weekly.id } : (payload.sponsor || null) };
}

// ─── Slow payments ───────────────────────────────────────────────────────
// Bank debits can take days to settle. Close to the date, checkout offers
// only cards (wallets included), which settle at once; a slow payment that
// still clears after the pick's day or the sponsor week is over is marked
// 'late' (never fulfilled) for the owner to refund.
// ACH takes up to 4 business days, which a weekend and a bank holiday
// stretch to 7 calendar days; 10 leaves room for the weekly sponsor's
// Monday newsletter (7:43 AM, before that day's settlements) too. A debit
// that still clears after its week's issue went out gets a make-good alert
// (processEvent) instead of the standard newsletter promise.
export const INSTANT_ONLY_DAYS = 10;

function orderDates(order) {
  if (order.kind === 'weekly' && order.week_start) return [order.week_start, addDays(order.week_start, 6)];
  if (order.kind === 'featured' && order.event && order.event.date) return [order.event.date, order.event.date];
  return null;
}

export function instantOnly(order, now) {
  const d = orderDates(order);
  return Boolean(d) && d[0] <= addDays(localDateStr(now), INSTANT_ONLY_DAYS);
}

export function paidTooLate(order, now) {
  const d = orderDates(order);
  return Boolean(d) && d[1] < localDateStr(now);
}

// ─── Sponsor click report ────────────────────────────────────────────────
// Weekly sponsors are promised how many people clicked. Site clicks come
// from the track beacon (docs/track.js sponsor_click with the button's
// link); email clicks from the /go/s/<week> redirect. People are counted
// once per day (the same visitor hash the Traffic tab uses), so a mail
// scanner or a double tap doesn't inflate the number.
// Compared by host (without www) and path only: the button's href is
// sponsorLinkUrl(url), so the beacon's click_url carries utm_* tags (and the
// browser may add a #hash) that the stored sponsor URL doesn't.
export function sameLink(a, b) {
  const norm = u => {
    const raw = String(u || '').trim();
    try {
      const x = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
      return `${x.hostname.toLowerCase().replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '')}`;
    } catch {
      return raw.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
    }
  };
  return Boolean(a) && Boolean(b) && norm(a) === norm(b);
}

// People: one per visitor per day (rows without a hash count apart).
function peopleIn(list) {
  return new Set(list.map(r => `${r.day}|${r.visitor || Math.random()}`)).size;
}

// Ad views by page type (server/analytics.js pageType), biggest first,
// leaving out types it never ran on.
function whereItRan(impressions) {
  return PAGE_TYPES.map(type => ({ type, views: rowCount(impressions.filter(r => pageType(r.path) === type)) }))
    .filter(x => x.views > 0).sort((a, b) => b.views - a.views);
}

// Counts are weighted by `n` (PgStore.listTraffic groups rows; rowCount).
export function sponsorStats(order, rows, { recipients = 0, issues = recipients ? 1 : 0 } = {}) {
  const start = order.week_start;
  const end = addDays(start, 6);
  const inWeek = (rows || []).filter(r => r.day >= start && r.day <= end);
  const clicks = inWeek.filter(r => r.kind === 'click' && r.click_type === 'sponsor_click');
  const email = clicks.filter(r => r.path === `/go/s/${start}`);
  const social = clicks.filter(r => r.path === `/go/s/${start}/social`);
  const site = clicks.filter(r => !String(r.path || '').startsWith('/go/') &&
    (r.ad === order.id || sameLink(r.click_url, order.sponsor && order.sponsor.url)));
  // Seen: the block was at least half on screen for a second (docs/track.js).
  const seen = inWeek.filter(r => r.kind === 'impression' && r.ad === order.id);
  return {
    week_start: start, week_end: end,
    views: rowCount(seen), view_people: peopleIn(seen), where: whereItRan(seen),
    site_clicks: rowCount(site), site_people: peopleIn(site),
    email_clicks: rowCount(email), email_people: peopleIn(email),
    social_clicks: rowCount(social), social_people: peopleIn(social),
    site_visitors: peopleIn(inWeek.filter(r => r.kind === 'view')),
    newsletter_recipients: Number(recipients) || 0,
    newsletter_issues: Number(recipients) ? Number(issues) || 1 : 0
  };
}

// ─── Category partner report ─────────────────────────────────────────────
// A partner's month: views of its card or box (data-ad impressions on the
// site), and clicks through its /go/p/<id>/<src> redirect, by where they
// were tapped (newsletter; site = its category box or /partners; social =
// the Facebook thank-you). People are counted once a day, like sponsors.
export function partnerStats(order, rows, { start, end, recipients = 0, issues = 0 } = {}) {
  const inRange = (rows || []).filter(r => r.day >= start && r.day <= end);
  const base = `/go/p/${order.id}`;
  const seen = inRange.filter(r => r.kind === 'impression' && r.ad === order.id);
  const clicks = inRange.filter(r => r.kind === 'click' && r.click_type === 'partner_click' && (r.path === base || String(r.path || '').startsWith(`${base}/`)));
  const from = (...srcs) => clicks.filter(r => srcs.some(x => r.path === `${base}/${x}`));
  return {
    start, end,
    views: rowCount(seen), view_people: peopleIn(seen), where: whereItRan(seen),
    clicks: rowCount(clicks), click_people: peopleIn(clicks),
    newsletter_people: peopleIn(from('newsletter', 'email')),
    site_people: peopleIn(from('site', 'partners')),
    social_people: peopleIn(from('social')),
    newsletter_recipients: Number(recipients) || 0,
    newsletter_issues: Number(recipients) ? Number(issues) || 1 : 0
  };
}

// ─── Vic's Pick report ───────────────────────────────────────────────────
// What a paid pick got, from the day it was bought through its (last) day:
//   shown      times it was seen in an event list as a Vic's Pick (its
//              data-ad impressions; the event's own page doesn't count)
//   page views views of its event page(s)
//   link       taps on the buyer's own link, from a list (data-ad) or its
//              page (the "event details" button); compared like sameLink
//   calendar   "Add to calendar" / Google Calendar taps on its page
//   shares     shares sent from its page, or anywhere for its page's link
//   from shares views of its page from a link someone shared (?s=sh)
// `pages`: its event page paths (one per day it's listed); `urls`: the
// link(s) it carries; `starred`: whether the Monday issue starred it.
export function pathOf(u) {
  try { return new URL(String(u || ''), 'https://x.invalid').pathname.replace(/\/+$/, ''); } catch { return ''; }
}

export function pickStats(order, rows, { start, end, pages = [], urls = [], recipients = 0, starred = false, issues = 1 } = {}) {
  const inRange = (rows || []).filter(r => r.day >= start && r.day <= end);
  const onPage = r => pages.includes(r.path);
  const clicks = type => inRange.filter(r => r.kind === 'click' && (typeof type === 'function' ? type(r.click_type) : r.click_type === type));
  const seen = inRange.filter(r => r.kind === 'impression' && r.ad === order.id);
  const views = inRange.filter(r => r.kind === 'view' && onPage(r));
  const link = clicks('event_click').filter(r => (r.ad === order.id || onPage(r)) && urls.some(u => sameLink(r.click_url, u)));
  const calendar = clicks('add_to_calendar').filter(onPage);
  const shares = clicks(t => /^share_/.test(t || '')).filter(r => onPage(r) || pages.includes(pathOf(r.click_url)));
  const fromShares = views.filter(r => r.ref_source === SHARED_LINK);
  return {
    start, end, pages,
    shown: rowCount(seen), shown_people: peopleIn(seen), where: whereItRan(seen),
    page_views: rowCount(views), page_people: peopleIn(views),
    link_clicks: rowCount(link), link_people: peopleIn(link),
    calendar_adds: rowCount(calendar), shares: rowCount(shares),
    share_visits: rowCount(fromShares), share_people: peopleIn(fromShares),
    newsletter_starred: Boolean(starred), newsletter_recipients: starred ? Number(recipients) || 0 : 0,
    newsletter_issues: starred ? Math.max(1, Number(issues) || 1) : 0
  };
}

// ─── Every event's week (admin "Event stats") ───────────────────────────
// How each event dated between `start` and `end` did, for pitching its
// venue a Vic's Pick ("your event got 120 views and 9 shares last week").
// Each event counts its traffic from LEAD_IN_DAYS before its date through
// its date (people look things up ahead of time; a Monday event's views
// are mostly the week before). Like pickStats: a link tap is one on its own
// page for its link, or one anywhere else whose link is its link; a share
// is one of its page's link (a share button on it, or the "Also on"
// list's icon elsewhere), or a Facebook/X/Text button on its page.
// `rows` must reach back LEAD_IN_DAYS before `start`. `events`: live and
// archived events (each with page, name, venue, date, url).
export const LEAD_IN_DAYS = 7;
export const PAGE_SHARE_BUTTONS = new Set(['share_facebook', 'share_x', 'share_text']);
export function eventWeekStats(rows, events, { start, end }) {
  const byPage = new Map();
  for (const ev of events || []) {
    if (!ev || !ev.page || !ev.date || ev.date < start || ev.date > end) continue;
    const page = pathOf(ev.page);
    if (!byPage.has(page)) byPage.set(page, { page, name: ev.name || '', venue: ev.venue || '', date: ev.date, urls: new Set() });
    if (ev.url) byPage.get(page).urls.add(ev.url);
  }
  const out = [];
  for (const e of byPage.values()) {
    const from = addDays(e.date, -LEAD_IN_DAYS);
    const inRange = (rows || []).filter(r => r.day >= from && r.day <= e.date);
    const onPage = r => pathOf(r.path) === e.page;
    const ours = u => [...e.urls].some(x => sameLink(u, x));
    const views = inRange.filter(r => r.kind === 'view' && onPage(r));
    const clicks = type => inRange.filter(r => r.kind === 'click' && (typeof type === 'function' ? type(r.click_type) : r.click_type === type));
    const link = clicks('event_click').filter(r => ours(r.click_url) && (onPage(r) || !/^\/events\//.test(pathOf(r.path))));
    const shares = clicks(t => /^share_/.test(t || ''))
      .filter(r => pathOf(r.click_url) === e.page || (onPage(r) && PAGE_SHARE_BUTTONS.has(r.click_type)));
    const fromShares = views.filter(r => r.ref_source === SHARED_LINK);
    out.push({
      page: e.page, name: e.name, venue: e.venue, date: e.date, counted_from: from,
      page_views: rowCount(views), page_people: peopleIn(views),
      link_clicks: rowCount(link), link_people: peopleIn(link),
      calendar_adds: rowCount(clicks('add_to_calendar').filter(onPage)),
      shares: rowCount(shares), share_visits: rowCount(fromShares)
    });
  }
  return out.sort((a, b) => (b.page_views + b.link_clicks + b.shares) - (a.page_views + a.link_clicks + a.shares) || a.date.localeCompare(b.date));
}

// The sponsor's link with our UTM tags (unless it already has its own), so
// the visit shows up as from The Vic 361 in the sponsor's own analytics.
export function sponsorLandingUrl(url, { medium = 'email', campaign = 'newsletter' } = {}) {
  const safe = safeUrl(url);
  if (!safe) return '';
  try {
    const u = new URL(safe);
    if (!u.searchParams.has('utm_source')) {
      u.searchParams.set('utm_source', town.utmSource);
      u.searchParams.set('utm_medium', medium);
      u.searchParams.set('utm_campaign', campaign);
    }
    return u.href;
  } catch {
    return safe;
  }
}

export function bookableWeeks(now, orders, email = '') {
  const monday = currentWeek(localDateStr(now))[0];
  const nowMs = now.getTime();
  const taken = new Set((orders || [])
    .filter(o => o.kind === 'weekly' && (o.status === 'paid' || o.status === 'processing' || isHold(o, nowMs, email)))
    .map(o => o.week_start));
  const short = { month: 'short', day: 'numeric' };
  return Array.from({ length: WEEKS_AHEAD }, (_, i) => {
    const start = addDays(monday, 7 * (i + 1));
    return { start, label: `${formatDay(start, short)} to ${formatDay(addDays(start, 6), short)}`, available: !taken.has(start) };
  });
}

// ─── Sponsor logo ────────────────────────────────────────────────────────
// The checkout page shrinks the logo in the browser (canvas) and sends it as
// a data URL in a hidden field, so the server needs no upload library. Only
// PNG, JPEG and WebP (checked by their first bytes, not the label): SVG can
// carry script, so it's not accepted.
const LOGO_MAX_BYTES = 300 * 1024;
// The same limit as base64 (4 chars per 3 bytes) plus the data: prefix; the
// checkout page refuses anything longer before it's sent.
const LOGO_MAX_CHARS = Math.ceil(LOGO_MAX_BYTES / 3) * 4 + 32;
export const LOGO_PATH = /^\/sponsor-logo\/[A-Za-z0-9-]{8,64}$/;

export function parseLogo(dataUrl) {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || '').trim());
  if (!m) return { error: 'Logo must be a PNG, JPG or WebP image.' };
  const data = Buffer.from(m[2], 'base64');
  if (!data.length) return { error: 'That logo file looks empty.' };
  if (data.length > LOGO_MAX_BYTES) return { error: 'Logo is too large. Try a smaller image (under 300 KB).' };
  const sig = {
    png: data[0] === 0x89 && data.slice(1, 4).toString() === 'PNG',
    jpeg: data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff,
    webp: data.slice(0, 4).toString() === 'RIFF' && data.slice(8, 12).toString() === 'WEBP'
  };
  if (!sig[m[1]]) return { error: 'That file isn’t a valid image.' };
  return { contentType: `image/${m[1]}`, data };
}

// ─── Form validation ─────────────────────────────────────────────────────

// A category partner's line: one short sentence (the newsletter card is
// half the email's width).
export const PARTNER_LINE_MAX = 80;

function clean(v, max) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
}

export function validateOrder(kind, input, { now, orders, venues }) {
  const errors = {};
  const email = normalizeEmail(input.email);
  if (!email) errors.email = 'Enter a valid email for your receipt.';
  else if (impossibleEmailError(email)) errors.email = impossibleEmailError(email);
  const business = clean(input.business, 80);
  if (!business) errors.business = 'Business name is required.';
  const order = { kind, email, business };

  if (kind === 'weekly') {
    const text = clean(input.text, 160);
    if (!text) errors.text = 'Add one or two sentences about your business.';
    const cta = clean(input.cta, 24) || 'Learn more';
    const url = safeUrl(normalizeUrl(clean(input.url, 300)));
    if (!url) errors.url = 'Enter your website or page (e.g. example.com).';
    const address = clean(input.address, 120);
    const week = bookableWeeks(now, orders, email).find(w => w.start === input.week);
    if (!week) errors.week = 'Pick a week.';
    else if (!week.available) errors.week = 'That week was just booked. Pick another.';
    order.week_start = week ? week.start : '';
    order.sponsor = { name: business, text, cta, url, address };
    if (input.logo_data) {
      const logo = parseLogo(input.logo_data);
      if (logo.error) errors.logo = logo.error;
      else order.logo = logo;   // saved separately; never stored on the order
    }
  } else if (kind === 'featured') {
    const v = validateSubmission({
      name: input.event_name, date: input.date, time: input.time, end_time: input.end_time, venue: input.venue,
      address: input.address, description: input.description, url: input.url
    }, { adminEdit: true });
    if (!v.ok) Object.assign(errors, v.errors);
    const ev = v.ok ? v.data.payload : null;
    if (ev) {
      const today = localDateStr(now);
      if (ev.date < today) errors.date = 'That date has passed.';
      else if (ev.date > addDays(today, FEATURE_DAYS_AHEAD)) errors.date = `Pick a date in the next ${FEATURE_DAYS_AHEAD} days.`;
      else if (!pickAvailability(ev.date, orders, now, email).left) {
        const a = pickAvailability(ev.date, orders, now, email);
        errors.date = `${town.pickName}s for ${formatDay(ev.date, { weekday: 'long', month: 'short', day: 'numeric' })} are sold out (${a.cap} a day). Pick another day, or submit the event free.`;
      }
    }
    order.event = ev;
  } else if (kind === 'category') {
    // One business per category: a category that's live, waiting for the
    // owner's OK or being paid for right now can't be bought (the buyer's
    // own open checkout doesn't count against them).
    const open = openCategories(orders, o => isHold(o, now.getTime()), email);
    const cat = categoryOf(clean(input.category, 20));
    if (!cat) errors.category = 'Pick a category.';
    else if (!open.includes(cat.id)) errors.category = `${cat.label} was just taken. Pick another category.`;
    const line = clean(input.line, PARTNER_LINE_MAX);
    if (!line) errors.line = 'Add one short line about your business.';
    const cta = clean(input.cta, 24) || 'Visit';
    const url = safeUrl(normalizeUrl(clean(input.url, 300)));
    if (!url) errors.url = 'Enter your website or page (e.g. example.com).';
    order.category = cat ? cat.id : '';
    order.partner = { name: business, line, cta, url };
    if (input.logo_data) {
      const logo = parseLogo(input.logo_data);
      if (logo.error) errors.logo = logo.error;
      else order.logo = logo;   // saved separately; never stored on the order
    }
  } else {
    errors._form = 'Unknown package.';
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, order };
}

// ─── Pages ───────────────────────────────────────────────────────────────

function field({ name, label, value = '', error, type = 'text', hint = '', required = true, max, rows }) {
  const id = `f-${name}`;
  const attrs = `id="${id}" name="${name}"${required ? ' required' : ''}${max ? ` maxlength="${max}"` : ''}${error ? ' aria-invalid="true"' : ''}`;
  const input = rows
    ? `<textarea ${attrs} rows="${rows}">${escHtml(value)}</textarea>`
    : `<input type="${type}" ${attrs} value="${escHtml(value)}">`;
  return `<div class="co-field"><label for="${id}">${escHtml(label)}</label>${input}` +
    (hint ? `<small class="co-hint">${escHtml(hint)}</small>` : '') +
    (error ? `<small class="co-error">${escHtml(error)}</small>` : '') + '</div>';
}

// Start and end time choices, as on the submit form (docs/submit.js
// buildTimeOptions): every half hour from 5:00 AM to 1:30 AM.
export const TIME_CHOICES = (() => {
  const out = [];
  for (let m = 5 * 60; m <= 25 * 60 + 30; m += 30) {
    const hh = Math.floor(m / 60) % 24;
    out.push(`${((hh + 11) % 12) + 1}:${String(m % 60).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`);
  }
  return out;
})();

// A prefilled time ("06:30 PM", "7pm") as the matching choice, so the
// select shows it; anything else as given.
export function timeChoice(value) {
  const s = clean(value, 60);
  const m = s.match(/^0?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$/i);
  return m ? `${Number(m[1])}:${m[2] || '00'} ${m[3].toUpperCase()}M` : s;
}

function timeField({ name, label, value, error, required = true, hint = '' }) {
  const v = timeChoice(value);
  // A time that isn't on the half hour (6:45 PM) stays selectable.
  const opts = v && !TIME_CHOICES.includes(v) ? [v, ...TIME_CHOICES] : TIME_CHOICES;
  return `<div class="co-field"><label for="f-${name}">${escHtml(label)}</label>` +
    `<select id="f-${name}" name="${name}"${required ? ' required' : ''}${error ? ' aria-invalid="true"' : ''}>` +
    `<option value="">${required ? 'Choose…' : 'None'}</option>` +
    opts.map(t => `<option value="${escHtml(t)}"${t === v ? ' selected' : ''}>${escHtml(t)}</option>`).join('') +
    '</select>' + (hint ? `<small class="co-hint">${escHtml(hint)}</small>` : '') +
    (error ? `<small class="co-error">${escHtml(error)}</small>` : '') + '</div>';
}

function selectField({ name, label, options, value, error }) {
  return `<div class="co-field"><label for="f-${name}">${escHtml(label)}</label>` +
    `<select id="f-${name}" name="${name}" required${error ? ' aria-invalid="true"' : ''}>` +
    '<option value="">Choose…</option>' +
    options.map(o => `<option value="${escHtml(o.value)}"${o.value === value ? ' selected' : ''}${o.disabled ? ' disabled' : ''}>${escHtml(o.label)}</option>`).join('') +
    `</select>${error ? `<small class="co-error">${escHtml(error)}</small>` : ''}</div>`;
}

// ─── Live preview ────────────────────────────────────────────────────────
// What the buyer gets, drawn with the site's own markup (renderEventItem,
// sponsorHtml) from what they've typed so far. Rendered into the checkout
// page and refreshed from POST /advertise/preview as they type, so there's
// one renderer and the preview can't drift from the real thing.

// The rest of the day around a pick in the preview: picks sit in time order
// with everything else (sortEvents), so the sample does too.
const SAMPLE_OTHERS = [
  { name: 'Other events that day', time: '6:00 PM', venue: 'In time order, around yours' },
  { name: '…and the rest of the day’s list', time: '8:00 PM', venue: '' }
];

function dayCard(dateStr, items) {
  const head = dateStr
    ? `<h2 class="day-name">${escHtml(formatDay(dateStr, { weekday: 'long' }))}</h2><span class="day-date">${escHtml(formatDay(dateStr, { month: 'long', day: 'numeric' }))}</span>`
    : '<h2 class="day-name">Your event’s day</h2>';
  return `<section class="day-section co-preview-day${dateStr ? dayClass(dateStr) : ''}"><div class="day-header">${head}</div>` +
    `<ul class="event-list" role="list">${items.join('')}</ul></section>`;
}

function previewItem(ev) {
  return renderEventItem({ ...ev, page: '#preview' }).replace(/<a href="#preview">/g, '<a href="#preview" tabindex="-1" onclick="return false">');
}

// The category partner's box as the buyer has typed it so far.
function samplePartner(v = {}) {
  const cat = categoryOf(clean(v.category, 20)) || categoryOf('food') || partnerCategories()[0];
  return {
    cat,
    p: { id: '', category: cat.id, label: cat.label, emoji: cat.emoji, name: clean(v.business, 80) || 'Your business',
      line: clean(v.line, PARTNER_LINE_MAX) || 'One short line about what you offer.', cta: clean(v.cta, 24) || 'Visit',
      logo: v.sampleLogo ? SAMPLE_LOGO : '' }
  };
}

export function renderPreview(pkgKey, v = {}, { now, orders = [], venues = [] } = {}) {
  const val = k => clean(v[k], 2000);
  if (pkgKey === 'category') {
    const { cat, p } = samplePartner(v);
    return `<p class="co-preview-where">Once we’ve approved you: on ${cat.pages.length ? `our ${escHtml(cat.label.toLowerCase())} pages and ` : ''}our partners page,</p>` +
      partnerBlock(p, cat, '#') +
      '<p class="co-preview-where">and in every newsletter issue, Monday and Thursday:</p>' +
      `<div class="ad-email-sample co-preview-email">${partnerCardEmail(p, '#')}</div>`;
  }
  if (pkgKey === 'weekly') {
    const block = sponsorHtml({
      name: clean(v.business, 80) || 'Your business',
      text: clean(v.text, 160) || 'Your one or two sentences about your business go here.',
      cta: clean(v.cta, 24) || 'Learn more',
      url: safeUrl(normalizeUrl(clean(v.url, 300))) || '#',
      address: clean(v.address, 120),
      logo: v.sampleLogo ? SAMPLE_LOGO : ''
    });
    return `<p class="co-preview-where">Shown on every page of ${town.domain} for your week, and at the top of that week’s ${weekendIssueOn() ? 'newsletters (Monday’s and Thursday’s)' : 'Monday newsletter'}.</p>${block}`;
  }
  // Vic’s Pick: the event as it will look, highlighted on its day.
  const date = /^\d{4}-\d{2}-\d{2}$/.test(val('date')) ? val('date') : '';
  const start = clean(v.time, 60) || '7:00 PM';
  const end = clean(v.end_time, 60);
  const ev = {
    name: clean(v.event_name, 200) || 'Your event name',
    time: end ? `${start} – ${end}` : start,
    venue: clean(v.venue, 200) || 'Your venue',
    description: clean(v.description, 300) || 'Your description shows here.',
    featured: true
  };
  const items = sortEvents([ev, ...SAMPLE_OTHERS].map(x => ({ ...x, date: date || '2000-01-01' })))
    .map(x => x.featured ? previewItem(x) : previewItem(x).replace('class="event-entry"', 'class="event-entry co-preview-dim"'));
  let price = `<strong>${dollars(VICS_PICK.weekdayAmount)}</strong> Mon–Thu · <strong>${dollars(VICS_PICK.weekendAmount)}</strong> Fri–Sun. Pick a date to see open spots.`;
  if (date && now) {
    const a = pickAvailability(date, orders, now);
    const day = formatDay(date, { weekday: 'long', month: 'short', day: 'numeric' });
    price = a.left
      ? `<strong>${escHtml(day)}: ${a.price}</strong> · ${a.left} of ${a.cap} ${town.pickName} spots left`
      : `<strong class="co-error">${escHtml(day)} is sold out</strong> (${a.cap} ${town.pickName}s a day). Pick another day.`;
  }
  return `<p class="co-preview-price">${price}</p>` +
    `<p class="co-preview-where">Highlighted on its day on the site and its event page, ${escHtml(pickWhere(date, now))}:</p>` +
    dayCard(date, items);
}

// Example placements for the /advertise page.
export function samplePreviews() {
  return {
    weekly: renderPreview('weekly', { business: 'Your Business', text: 'One or two sentences about what you offer, shown all week.', cta: 'Learn more', sampleLogo: true }),
    featured: renderPreview('featured', { event_name: 'Your Event Name', time: '7:00 PM', venue: 'Your Venue', description: 'A line or two about your event.' }),
    // The site box only: /advertise shows the newsletter card beside it.
    category: (({ cat, p }) => partnerBlock(p, cat, '#'))(samplePartner({ business: 'Your Business', line: 'One short line about what you offer.', cta: 'Visit' }))
  };
}

// The clickwrap: an unchecked box the buyer must tick, next to the pay
// button, with the terms one click away (new tab, so the form isn't lost).
// Enforced on the server (POST /advertise/checkout), which records the
// version agreed to on the order. Kept ticked only when the buyer ticked it
// and the form came back with another error.
export const AGREE_ERROR = 'Please tick the box to agree to the advertising terms.';
export function agreed(value) {
  return value === '1' || value === 'on' || value === true || value === 'true';
}
function agreeField(value, error) {
  return `<div class="co-field"><label class="co-check" for="f-agree">` +
    `<input type="checkbox" id="f-agree" name="agree" value="1" required${agreed(value) ? ' checked' : ''}${error ? ' aria-invalid="true"' : ''}>` +
    `<span>I agree to the <a href="/advertising-terms" target="_blank" rel="noopener">Advertising Terms</a>, including the <a href="/advertising-terms#refunds" target="_blank" rel="noopener">cancellation and refund policy</a>.</span></label>` +
    (error ? `<small class="co-error">${escHtml(error)}</small>` : '') + '</div>';
}

// The logo picker (weekly sponsor and category partner): the browser
// shrinks the file and sends it as a data URL (see the page script).
function logoField(v, e, where) {
  return `<div class="co-field"><label for="f-logo">Logo</label><input type="file" id="f-logo" accept="image/png,image/jpeg,image/webp">` +
    // A rejected logo isn't sent back, so resubmitting doesn't fail again.
    `<input type="hidden" name="logo_data" id="f-logo-data" value="${e.logo ? '' : escHtml(v.logo_data || '')}">` +
    `<button type="button" class="btn btn--ghost" id="f-logo-remove"${!e.logo && v.logo_data ? '' : ' hidden'}>Remove logo</button>` +
    `<small class="co-hint">Optional. PNG, JPG or WebP; a wide logo on a plain background looks best. ${where}</small>` +
    (e.logo ? `<small class="co-error">${escHtml(e.logo)}</small>` : '') + '</div>';
}

export function renderCheckoutPage(pkg, { siteUrl, now, orders, venues, values = {}, errors = {} }) {
  const e = errors;
  const v = values;
  let fields = '';
  if (pkg.key === 'weekly') {
    const weeks = bookableWeeks(now, orders).map(w => ({ value: w.start, label: w.available ? w.label : `${w.label} (booked)`, disabled: !w.available }));
    fields = selectField({ name: 'week', label: 'Week', options: weeks, value: v.week, error: e.week }) +
      field({ name: 'business', label: 'Business name', value: v.business, error: e.business, max: 80 }) +
      field({ name: 'text', label: 'Sponsor message', value: v.text, error: e.text, max: 160, rows: 3, hint: 'Up to 160 characters. Shown under your name.' }) +
      field({ name: 'url', label: 'Website or page', value: v.url, error: e.url, max: 300 }) +
      field({ name: 'cta', label: 'Button text', value: v.cta, error: e.cta, max: 24, required: false, hint: 'Optional, e.g. "Order now". Default: Learn more.' }) +
      logoField(v, e, 'Shown on your sponsor block.') +
      field({ name: 'address', label: 'Address', value: v.address, error: e.address, max: 120, required: false, hint: 'Optional.' });
  } else if (pkg.key === 'category') {
    const open = new Set(openCategories(orders, o => isHold(o, now.getTime())));
    const cats = partnerCategories().map(c => ({ value: c.id, label: `${c.emoji} ${c.label}${open.has(c.id) ? '' : ' (taken)'}`, disabled: !open.has(c.id) }));
    fields = (open.size ? '' : '<p class="co-error co-error--form">Every category is taken right now. <a href="/contact?topic=advertising">Ask us</a> to hear when one opens.</p>') +
      selectField({ name: 'category', label: 'Category', options: cats, value: v.category, error: e.category }) +
      field({ name: 'business', label: 'Business name', value: v.business, error: e.business, max: 80 }) +
      field({ name: 'line', label: 'Your line', value: v.line, error: e.line, max: PARTNER_LINE_MAX, hint: `One short line, up to ${PARTNER_LINE_MAX} characters. Shown under your name.` }) +
      field({ name: 'url', label: 'Website or page', value: v.url, error: e.url, max: 300 }) +
      field({ name: 'cta', label: 'Button text', value: v.cta, error: e.cta, max: 24, required: false, hint: 'Optional, e.g. "See the menu". Default: Visit.' }) +
      logoField(v, e, 'Shown on your partner box.');
  } else {
    fields = field({ name: 'event_name', label: 'Event name', value: v.event_name, error: e.name, max: 200 }) +
      field({ name: 'date', label: 'Date', type: 'date', value: v.date, error: e.date }) +
      timeField({ name: 'time', label: 'Start time', value: v.time, error: e.time }) +
      timeField({ name: 'end_time', label: 'End time', value: v.end_time, error: e.end_time, required: false, hint: 'Optional.' }) +
      field({ name: 'venue', label: 'Venue', value: v.venue, error: e.venue, max: 200 }) +
      field({ name: 'address', label: 'Address', value: v.address, error: e.address, max: 300 }) +
      field({ name: 'description', label: 'Description', value: v.description, error: e.description, max: 2000, rows: 4 }) +
      field({ name: 'url', label: 'Event link', value: v.url, error: e.url, max: 500, required: false, hint: 'Optional: tickets or Facebook event.' }) +
      field({ name: 'business', label: 'Your name or organization', value: v.business, error: e.business, max: 80 });
  }
  const body = `
    <p><a href="/advertise">← All packages</a></p>
    <h1 class="page-title">${escHtml(pkg.name)}</h1>
    <p class="page-lead">${escHtml(pkg.price)}. ${escHtml(pkg.blurb)}</p>
    ${e._form ? `<p class="co-error co-error--form">${escHtml(e._form)}</p>` : ''}
    <form class="co-form" method="post" action="/advertise/checkout" data-turnstile>
      <input type="hidden" name="package" value="${escHtml(pkg.key)}">
      <div class="hp-field" aria-hidden="true"><label>Leave this empty <input name="hp_field" tabindex="-1" autocomplete="off"></label></div>
      ${fields}
      <section class="co-preview" aria-labelledby="co-preview-h">
        <h2 id="co-preview-h" class="co-preview-h">Preview: exactly how it’ll look</h2>
        <div id="co-preview" aria-live="polite">${renderPreview(pkg.key, v, { now, orders, venues })}</div>
      </section>
      ${field({ name: 'email', label: 'Email for your receipt', type: 'email', value: v.email, error: e.email, max: 254 })}
      ${agreeField(v.agree, e.agree)}${reachPitchHtml() && `\n      ${reachPitchHtml()}`}
      <button class="btn btn--primary" type="submit">Continue to payment</button>
      <p class="co-hint">Secure payment by Stripe. ${pkg.key === 'category' ? 'Billed monthly. We review every new partner before it goes live and refund you in full if we can’t take it. Cancel anytime from the link in our emails.' : pkg.interval ? 'Cancel any time from your receipt email.' : ''}</p>
    </form>
    <script>
    (function () {
      // The submission or order id that filled the form isn't left in the
      // address bar (where it'd be bookmarked, shared or copied).
      try {
        if (/[?&](from|cancelled)=/.test(location.search) && history.replaceState) {
          history.replaceState(null, '', location.pathname + '?package=' + encodeURIComponent(${JSON.stringify(pkg.key)}));
        }
      } catch (e) { /* old browser: the URL just stays */ }
    })();
    (function () {
      var f = document.querySelector('.co-form'), box = document.getElementById('co-preview'), t;
      if (!f || !box || !window.fetch) return;
      var logoData = document.getElementById('f-logo-data'), logoRemove = document.getElementById('f-logo-remove');
      // The logo is shown in the preview from the browser's copy; it isn't
      // sent with every preview request.
      function showLogo() {
        if (logoRemove) logoRemove.hidden = !(logoData && logoData.value);
        var block = box.querySelector('.sponsor-block');
        if (!block) return;
        var img = block.querySelector('.sponsor-logo');
        if (!logoData || !logoData.value) { if (img) img.remove(); return; }
        if (!img) {
          img = document.createElement('img');
          img.className = 'sponsor-logo'; img.alt = 'Your logo';
          block.insertBefore(img, block.querySelector('.sponsor-name') || block.firstChild);
        }
        img.src = logoData.value;
      }
      function refresh() {
        var data = new URLSearchParams(new FormData(f));
        data.delete('logo_data');
        fetch('/advertise/preview', { method: 'POST', body: data })
          .then(function (r) { return r.ok ? r.text() : null; })
          .then(function (html) { if (html !== null) { box.innerHTML = html; showLogo(); } })
          .catch(function () { /* the server-rendered preview stays */ });
      }
      // Shrink the logo in the browser (max 480x240) so it's small to send.
      var logoInput = document.getElementById('f-logo');
      if (logoInput && logoData) {
        logoInput.addEventListener('change', function () {
          var file = logoInput.files && logoInput.files[0];
          if (!file) { logoData.value = ''; showLogo(); return; }
          var reader = new FileReader();
          reader.onload = function () {
            var im = new Image();
            im.onload = function () {
              var s = Math.min(1, 480 / im.width, 240 / im.height);
              var c = document.createElement('canvas');
              c.width = Math.max(1, Math.round(im.width * s)); c.height = Math.max(1, Math.round(im.height * s));
              c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
              logoData.value = c.toDataURL('image/png');
              showLogo();
            };
            im.onerror = function () { logoData.value = ''; alert('That file isn’t an image we can use. Try a PNG or JPG.'); };
            im.src = reader.result;
          };
          reader.readAsDataURL(file);
        });
        if (logoRemove) logoRemove.addEventListener('click', function () {
          logoData.value = ''; logoInput.value = ''; showLogo();
        });
        // Over the server's limit once encoded: drop it rather than lose the
        // whole form to a "too large" error.
        f.addEventListener('submit', function (ev) {
          if (logoData.value.length > ${LOGO_MAX_CHARS}) {
            ev.preventDefault();
            logoData.value = ''; logoInput.value = ''; showLogo();
            alert('That logo is too large. Try a smaller image, or continue without one.');
          }
        });
        showLogo();
      }
      f.addEventListener('input', function () { clearTimeout(t); t = setTimeout(refresh, 350); });
      f.addEventListener('change', refresh);
    })();
    </script>`;
  return layout({
    siteUrl, path: '/advertise/checkout', nav: '/advertise', noindex: true,
    title: `${pkg.name} | ${town.siteName}`, description: `Buy ${pkg.name} on ${town.siteName}.`, body
  });
}

// Only claims the confirmation email went out once it has (Resend can be
// down or not set up); otherwise it's on its way.
// Stripe usually sends the buyer back before its webhook arrives, so a
// pending order reloads itself for a couple of minutes until it's confirmed.
const THANKS_REFRESH_MS = 2 * 60 * 1000;

export function renderThanksPage(order, { siteUrl, now = new Date() }) {
  const emailed = Boolean(order && order.confirmation_sent);
  let msg = 'We\'re confirming your payment. Stripe will email your receipt in a minute or two.';
  let next = [];
  let refresh = false;
  if (order && order.status === 'pending') {
    const age = now.getTime() - Date.parse(order.created_at);
    if (age < THANKS_REFRESH_MS) {
      refresh = true;
      msg = 'We\'re confirming your payment with Stripe. This page updates on its own in a few seconds.';
    } else {
      msg = 'We haven\'t heard back from Stripe yet. If your payment went through, you\'ll get a confirmation email from us shortly (Stripe sends the receipt). If you didn\'t finish paying, nothing was charged.';
    }
  }
  if (order && order.kind === 'category' && ['pending_approval', 'active'].includes(order.status)) {
    const cat = categoryOf(order.category);
    const label = cat ? cat.label : 'your category';
    msg = order.status === 'active'
      ? `You're live: you're our ${escHtml(label.toLowerCase())} partner.`
      : `You're in! ${escHtml(label)} is yours while we review your listing.`;
    if (order.status === 'pending_approval') {
      next = ['We review every new partner, usually within 1 business day.',
        `Once you're approved, your card goes live in every newsletter issue, on our partners page${cat && cat.pages.length ? ` and our ${escHtml(label.toLowerCase())} pages` : ''}, and we email you.`,
        `${emailed ? 'We’ve emailed you' : 'We’ll email you'} a confirmation with a link to manage your partnership. Stripe sends your receipt separately.`];
    }
  } else if (order && order.kind === 'category' && order.status === 'conflict') {
    msg = 'Your payment went through, but someone else claimed that category moments before you. Sorry about that.';
    next = ['We’ll cancel your subscription and refund you in full within 1 business day.', 'Want a different category instead? Contact us below.'];
  } else if (order && LIVE.has(order.status)) {
    if (order.kind === 'weekly') {
      const week = formatDay(order.week_start, { weekday: 'long', month: 'long', day: 'numeric' });
      msg = `You're booked for the week of ${escHtml(week)}.`;
      next = [`Your sponsor block goes live on its own on ${escHtml(week)}, on every page of the site and at the top of that week’s ${weekendIssueOn() ? 'Monday and Thursday newsletters' : 'Monday newsletter'}.`,
        `${emailed ? 'We’ve emailed you' : 'We’ll email you'} a confirmation with a copy of your block. Stripe sends your receipt separately.`,
        'Want to change the wording or link before it goes live? Reply to that email.'];
    } else if (order.kind === 'partner') {
      msg = `You're a venue partner. Every event at ${escHtml(order.venue_name)} is now a ${town.pickName}.`;
    } else {
      const day = order.event ? formatDay(order.event.date, { weekday: 'long', month: 'long', day: 'numeric' }) : 'its day';
      msg = `Thanks! ${escHtml(order.event ? order.event.name : 'Your event')} is a ${town.pickName}.`;
      next = ['We check the details and publish it, usually within the hour, and email you when it’s live. If anything needs fixing, we’ll email you.',
        `Then it’s highlighted on ${escHtml(day)} with the ${town.pickName} badge, and ${escHtml(pickWhere(order.event && order.event.date, order.paid_at || order.created_at))}.`,
        `${emailed ? 'We’ve emailed you' : 'We’ll email you'} a confirmation. Stripe sends your receipt separately.`];
    }
  } else if (order && order.status === 'processing') {
    msg = 'Your payment is processing (bank payments can take a few days). Your spot is held, and we’ll email you as soon as it clears.';
  } else if (order && order.status === 'conflict') {
    // Two buyers paid for the same week (the first hold lapsed while the
    // other paid). The owner gets a Slack alert to refund or move them.
    // A Vic's Pick day can end up the same way (webhook day-cap check).
    const unit = order.kind === 'featured' ? 'day' : 'week';
    msg = order.kind === 'featured'
      ? `Your payment went through, but that day’s ${town.pickName} spots filled up moments before you. Sorry about that.`
      : 'Your payment went through, but someone else booked that week moments before you. Sorry about that.';
    next = [`We’ll get in touch within 1 business day to move you to another open ${unit} or refund you in full, whichever you prefer.`,
      'Nothing else is needed from you. If you already know which you’d like, contact us below.'];
  } else if (order && order.status === 'failed') {
    // A bank debit that bounced (we email them too), or a refused test payment.
    msg = 'Your payment didn’t go through, so nothing was charged and you’re not booked.';
    next = [`If you still want it, <a href="/advertise/checkout?package=${order.kind === 'weekly' || order.kind === 'category' ? order.kind : 'featured'}">book again</a> (a card settles at once).`];
  } else if (order && order.status === 'late') {
    // A bank payment that cleared after the date it paid for (webhook).
    msg = 'Your bank payment cleared only after that date had passed, so we couldn’t run it. Sorry about that.';
    next = ['We’re refunding you in full; Stripe shows it within a few business days.',
      'Want another date instead? Contact us below and we’ll set it up.'];
  }
  const steps = next.length ? `<h2 class="section-heading">What happens next</h2><ol class="thanks-steps">${next.map(x => `<li>${x}</li>`).join('')}</ol>` : '';
  const body = `<h1 class="page-title">Thank you</h1><p class="page-lead">${msg}</p>${steps}
    <p>Questions or something not right? <a href="/contact?topic=advertising">Contact us</a> and we’ll sort it out.</p>
    <p><a class="btn btn--primary" href="/">See this week's events</a></p>` +
    (refresh ? `<script>setTimeout(function () { location.reload(); }, 5000);</script>` : '');
  return layout({ siteUrl, path: '/advertise/thanks', nav: '/advertise', noindex: true, title: `Thank you | ${town.siteName}`, description: 'Thank you.', body });
}

// The checkout body went over its size limit (server/index.js error
// handler); in practice a logo too big to send.
export function renderLogoTooLargePage({ siteUrl }) {
  const body = `<h1 class="page-title">That logo is too large</h1>
    <p class="page-lead">Your form didn’t go through because the logo file was too big to send. Nothing was charged.</p>
    <p>Go back and pick a smaller image (under 300 KB), or continue without a logo.</p>
    <p><a class="btn btn--primary" href="/advertise/checkout?package=weekly" onclick="if (history.length > 1) { history.back(); return false; }">Back to the form</a></p>`;
  return layout({ siteUrl, path: '/advertise/checkout', nav: '/advertise', noindex: true, title: `Logo too large | ${town.siteName}`, description: 'Logo too large.', body });
}

// ─── Wiring ──────────────────────────────────────────────────────────────

// Pause before a strict (newsletter) order read's second try.
const STRICT_RETRY_MS = 2000;

// manageSecret: signs the category partners' manage links (server/
// partners.js manageToken); without one no link is put in their emails.
export function createSponsors({ store, siteUrl, nowFn, config, stripe, getVenues, slack = null, mailer = null, mailAddress = '', getPayload = null, manageSecret = '' }) {
  const supported = typeof store.listSponsorOrders === 'function';
  const manageLink = order => (manageSecret && order && order.id ? manageUrl(siteUrl, manageSecret, order.id) : '');
  let cache = null;
  // Bumped by every save. A read that started before a save neither fills
  // the cache nor is shared with readers after it.
  let gen = 0;
  let ordersRun = null;

  // Fails open (stale or empty list) because it feeds page views; anything
  // that books a slot uses freshOrders instead. When the cache has run out,
  // a burst of page views shares one read (and so one pins() lookup).
  async function orders() {
    if (!supported) return [];
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.list;
    if (!ordersRun || ordersRun.gen !== gen) {
      const started = gen;
      const run = { gen: started, promise: null };
      run.promise = store.listSponsorOrders().then(list => {
        if (gen === started) cache = { at: Date.now(), list };
        return list;
      }).finally(() => { if (ordersRun === run) ordersRun = null; });
      ordersRun = run;
    }
    try {
      return await ordersRun.promise;
    } catch (err) {
      console.warn('[sponsors] order list failed:', err.message);
      return cache ? cache.list : [];
    }
  }

  // The list straight from the store, throwing on a database error: a
  // booking that read an empty list would sell a week or day already sold.
  async function freshOrders() {
    cache = null;
    if (!supported) return [];
    const list = await store.listSponsorOrders();
    cache = { at: Date.now(), list };
    return list;
  }

  async function save(order) {
    await store.saveSponsorOrder({ ...order, updated_at: nowIso() });
    gen++;
    cache = null;
  }

  // One booking at a time (single Railway instance), so two buyers can't
  // both pass the "is this week free?" check before either hold is saved.
  let bookingChain = Promise.resolve();
  function withBookingLock(fn) {
    const run = bookingChain.then(fn, fn);
    bookingChain = run.catch(() => {});
    return run;
  }

  // Order id -> the shapes its event may be live as (see pickMatches), for
  // live Vic's Picks that came with a submission. Cached with the orders.
  // This runs on the page-view path, so only picks that can still be shown
  // or reported on are looked up (bought for a date no older than the
  // report catch-up window), and concurrent requests share one lookup.
  function pins(list) {
    if (cache && cache.list === list && cache.pins) return cache.pins;
    const run = buildPins(list);
    if (cache && cache.list === list) cache.pins = run;
    return run;
  }

  async function buildPins(list) {
    const out = new Map();
    const oldest = addDays(localDateStr(nowFn()), -(REPORT_CATCHUP_DAYS + 2));
    const picks = list.filter(o => o.kind === 'featured' && o.event && o.submission_id && LIVE.has(o.status) &&
      String(o.event.date || '') >= oldest);
    if (picks.length) {
      let edits = [];
      try { edits = typeof store.listEventEdits === 'function' ? await store.listEventEdits() : []; } catch { /* none */ }
      const byKey = new Map(edits.map(e => [e.original_key, e.payload]));
      await Promise.all(picks.map(async o => {
        try {
          const row = await store.get(o.submission_id);
          if (!row || !row.payload) return;
          const shapes = [row.payload];
          const edit = byKey.get(eventKeyOf(row.payload));
          if (edit) shapes.push({ ...row.payload, ...edit });
          out.set(o.id, shapes);
        } catch (err) { console.warn('[sponsors] pick submission lookup failed:', err.message); }
      }));
    }
    return out;
  }

  // strict: the newsletter send. Page views fail open (an empty list for
  // a moment is better than an error page), but a Monday issue built that
  // way went out without the paid weekly sponsor and starred picks and was
  // recorded as sent. Strict reads the orders fresh, tries once more after
  // a short pause, then throws, so the send fails and the scheduler retries
  // it (5, 15, 30 minutes, then an alert).
  async function apply(payload, { strict = false, now } = {}) {
    const at = now || nowFn();
    if (strict) {
      let list;
      try { list = await freshOrders(); } catch (err) {
        console.warn('[sponsors] order list failed, retrying once:', err.message);
        await new Promise(r => setTimeout(r, STRICT_RETRY_MS));
        list = await freshOrders();
      }
      return applyPlacements(payload, list, { now: at, venues: getVenues(), pins: await pins(list) });
    }
    try {
      const list = await orders();
      return applyPlacements(payload, list, { now: at, venues: getVenues(), pins: await pins(list) });
    } catch (err) {
      console.warn('[sponsors] placements skipped:', err.message);
      return payload;
    }
  }

  async function fulfil(order) {
    if (order.kind === 'featured' && order.event && !order.submission_id) {
      const now = nowIso();
      const row = {
        id: newId(), created_at: now, updated_at: now, status: 'pending', source: 'paid-feature',
        submitter_kind: 'organizer', submitter_name: order.business, submitter_email: order.email,
        submitter_ip: null, user_agent: '', payload: normalizePayload(order.event),
        admin_notes: `Paid featured listing (order ${order.id}). The AI review publishes it when it's clean and flags it here otherwise; it's pinned as a ${town.pickName} automatically.`,
        review_history: [{ at: now, action: 'submitted', note: 'Paid featured listing' }]
      };
      await store.insert(row);
      order.submission_id = row.id;
      await save(order);
    }
    // A new category partner shows nowhere until the owner approves it:
    // Slack sales and the owner inbox (a `today` item HQ's assistant reads).
    if (order.kind === 'category') {
      if (slack) {
        const cat = categoryOf(order.category);
        const pp = order.partner || {};
        slack.notify({ channel: 'sales',
          title: `🤝 New partner waiting for your OK: ${order.business}, ${cat ? cat.label : order.category}`,
          fields: [['Category', cat ? cat.label : order.category], ['Name', pp.name || order.business], ['Line', pp.line || ''],
            ['Button', `${pp.cta || 'Visit'} → ${pp.url || ''}`], ['Logo', pp.logo ? 'Yes' : 'None'], ['Contact', order.email],
            ['Paid', `$${Math.round((order.amount || 0) / 100)}/mo`], ['Order', order.id]],
          text: 'Paid and subscribed; nothing shows until you approve it. Approve or reject it in Admin → Sponsors (Reject cancels the subscription and refunds them), or tell HQ.',
          link: `${siteUrl}/admin.html`
        });
      }
      return;
    }
    // The "you're booked" email goes out after the lock (processEvent).
    if (slack) {
      const pkg = packageFor(order.kind);
      slack.notify({ channel: 'hype',
        title: `💰 New sponsor: ${order.business}`,
        fields: [['Package', pkg ? pkg.name : order.kind], ['Paid', `$${Math.round((order.amount || 0) / 100)}${order.kind === 'partner' ? '/mo' : ''}`],
          ['Contact', order.email],
          ['Details', order.kind === 'weekly' ? `Week of ${order.week_start}` : order.kind === 'partner' ? order.venue_name : `${order.event.name} (${order.event.date})`]],
        text: order.kind === 'featured'
          ? 'The AI review puts it live when it checks out (usually within the hour); if it flags it, approve it in the Submissions tab. You’ll get a reminder if it’s still not live close to its date.'
          : 'Live automatically.',
        link: `${siteUrl}/admin.html`
      });
    }
  }

  // "You're booked" email: what happens next and how to reach us. Once
  // per order. A card checkout gets exactly one completed webhook, so a send
  // that failed (Resend down) is retried by retryConfirmations, and the
  // owner is alerted once it keeps failing. True when it was sent.
  // Callers must NOT hold the booking lock: the send can take up to
  // Resend's 15-second timeout, and checkout, webhooks and admin edits all
  // queue behind that one lock. So the send happens outside it, and the
  // result is recorded under it on a fresh read of the order, merging only
  // the confirmation fields (a refund or edit that landed meanwhile stays).
  const confirming = new Set();
  const owesConfirmation = order => Boolean(mailer && mailer.enabled && (order.kind === 'weekly' || order.kind === 'featured' || order.kind === 'category') &&
    !order.confirmation_sent);
  // A category partner's first email is "you're in, we'll review it".
  const confirmationOf = order => (order.kind === 'category'
    ? renderPartnerReceived(order, { siteUrl, address: mailAddress, manageUrl: manageLink(order) })
    : renderSponsorConfirmed(order, { siteUrl, address: mailAddress }));
  async function sendConfirmation(order) {
    // Already in flight (a webhook and the retry run at once): one send.
    if (!owesConfirmation(order) || confirming.has(order.id)) return false;
    confirming.add(order.id);
    try {
      const sent = await mailer.send(order.email, confirmationOf(order), `${town.keyPrefix}-sponsor-${order.id}`);
      const failures = await withBookingLock(async () => {
        const cur = (await freshOrders()).find(o => o.id === order.id);
        if (!cur || cur.confirmation_sent) return 0;
        if (sent) {
          await save({ ...cur, confirmation_sent: nowIso() });
          return 0;
        }
        const n = (Number(cur.confirmation_failures) || 0) + 1;
        await save({ ...cur, confirmation_failures: n });
        return n;
      });
      if (!sent && slack && failures === CONFIRM_ALERT_AFTER) {
        slack.alert(`sponsor-confirmation-failed:${order.id}`, `"You're booked" email to ${order.business} isn't sending`,
          `${order.email} paid but hasn't had their confirmation after ${CONFIRM_ALERT_AFTER} tries. It keeps retrying for ${CONFIRM_RETRY_DAYS} days; check Resend, or email them yourself.`,
          `${siteUrl}/admin.html`);
      }
      return sent;
    } finally {
      confirming.delete(order.id);
    }
  }

  // Paid weekly sponsors and Vic's Picks still owed their confirmation
  // (from the last CONFIRM_RETRY_DAYS, while the placement hasn't ended).
  // Picked from a fresh read under the booking lock; each email then goes
  // out after the lock is released (see sendConfirmation).
  async function retryConfirmations(now) {
    if (!supported || !mailer || !mailer.enabled) return 0;
    const since = now.getTime() - CONFIRM_RETRY_DAYS * 864e5;
    const due = await withBookingLock(async () => (await freshOrders()).filter(o => !o.confirmation_sent && o.paid_at && Date.parse(o.paid_at) >= since &&
      (((o.kind === 'weekly' || o.kind === 'featured') && o.status === 'paid' && !paidTooLate(o, now)) ||
        (o.kind === 'category' && (o.status === 'pending_approval' || o.status === 'active')))));
    let sent = 0;
    for (const o of due) if (await sendConfirmation(o)) sent++;
    return sent;
  }

  // A report outcome, merged into the order as it is now: the run read it
  // before its traffic queries and email, and a refund, dispute or hide
  // saved meanwhile must not be overwritten with that older copy.
  function recordReport(order, fields) {
    return withBookingLock(async () => {
      const cur = (await freshOrders()).find(o => o.id === order.id) || order;
      await save({ ...cur, ...fields });
    });
  }

  // The end-of-week click report every weekly sponsor is promised. Goes to
  // each paid weekly order whose week ended (from the Monday after), once:
  // the order records report_sent, and Resend's idempotency key covers a
  // retried request. Runs from the Monday newsletter cron (server/index.js
  // onCron) and is safe to call from any daily scheduler too: overlapping
  // or repeated calls send nothing twice. A run that's missed catches up
  // for REPORT_CATCHUP_DAYS.
  // Also the retry path for unsent confirmations: this runs every 15
  // minutes (the review cron's onRun) and from the daily and Monday crons.
  let reportRun = null;
  function sendSponsorReports(now = nowFn()) {
    if (!reportRun) {
      reportRun = retryConfirmations(now)
        .catch(err => console.warn('[sponsors] confirmation retry failed:', err.message))
        .then(() => runSponsorReports(now))
        // Category partners' monthly reports ride the same hooks (the daily
        // scheduler, the 15-minute review cron, the Monday cron).
        .then(async out => {
          try { await runPartnerReports(now); } catch (err) { console.warn('[sponsors] partner reports failed:', err.message); }
          return out;
        })
        .finally(() => { reportRun = null; });
    }
    return reportRun;
  }

  async function runSponsorReports(now) {
    const out = { sent: 0, skipped: 0, failed: 0 };
    if (!supported) return out;
    const today = localDateStr(now);
    cache = null;
    const due = (await orders()).filter(o => o.kind === 'weekly' && LIVE.has(o.status) && o.week_start && !o.report_sent &&
      addDays(o.week_start, 7) <= today && addDays(o.week_start, 7 + REPORT_CATCHUP_DAYS) >= today);
    if (!due.length) return out;
    const since = due.map(o => o.week_start).sort()[0];
    const rows = typeof store.listTraffic === 'function' ? await store.listTraffic(since) : [];
    for (const order of due) {
      const stats = sponsorStats(order, rows, await recipientsFor(order));
      const summary = [['Sponsor', order.business], ['Week', order.week_start], ['Views on the site', stats.views],
        ['Clicked on the site', stats.site_people], ['Clicked in emails', stats.email_people]];
      if (!mailer || !mailer.enabled) {
        // No email service: hand the numbers to the owner once instead.
        if (!order.report_slack_sent && slack) {
          slack.alert(`sponsor-report:${order.id}`, `Send ${order.business} their click report (email is off)`,
            `${summary.map(([k, v]) => `${k}: ${v}`).join('\n')}\nEmail it to ${order.email}. Set RESEND_API_KEY so these go out on their own.`,
            `${siteUrl}/admin.html`);
          await recordReport(order, { report: stats, report_slack_sent: nowIso() });
        }
        out.skipped++;
        continue;
      }
      const sent = await mailer.send(order.email, renderSponsorReport(order, stats, { siteUrl, address: mailAddress }), `${town.keyPrefix}-sponsor-report-${order.id}`);
      if (!sent) {
        // Tried again on the next run; the owner hears once per order
        // (the 15-minute cron would repeat Slack's 15-minute dedupe).
        out.failed++;
        if (slack && !order.report_failed) {
          slack.alert(`sponsor-report-failed:${order.id}`, `Click report to ${order.business} didn't send`, 'It will be retried on the next run.', `${siteUrl}/admin.html`);
          await recordReport(order, { report_failed: nowIso() });
        }
        continue;
      }
      await recordReport(order, { report: stats, report_sent: nowIso() });
      out.sent++;
      if (slack) {
        slack.notify({ channel: 'sales', title: `📊 Click report sent: ${order.business}`, fields: [...summary, ['To', order.email]] });
      }
    }
    return out;
  }

  // ─── Category partner reports ────────────────────────────────────────
  // After each renewal (invoice.paid for a subscription_cycle invoice sets
  // last_renewal_at), the month that just ended: from the last report (or
  // approval) to the day before the renewal. Once per month (report_through
  // and a Resend key with the renewal's date); no price in it.
  const dayOf = iso => (iso ? localDateStr(new Date(iso)) : '');

  // Newsletter copies sent between start and end (Monday's and Thursday's
  // issues), for the "copies with your card" line.
  async function issuesBetween(start, end) {
    let recipients = 0, issues = 0;
    for (let d = start; d <= end; d = addDays(d, 1)) {
      const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
      if (dow !== 1 && dow !== 4) continue;
      const nl = await newsletterSend(d);
      if (nl && Number(nl.recipients) > 0) { recipients += Number(nl.recipients); issues++; }
    }
    return { recipients, issues };
  }

  async function partnerStatsFor(order, start, end, rows = null) {
    if (!rows) rows = typeof store.listTraffic === 'function' ? await store.listTraffic(start) : [];
    return partnerStats(order, rows, { start, end, ...(await issuesBetween(start, end)) });
  }

  async function runPartnerReports(now) {
    const out = { sent: 0, skipped: 0, failed: 0 };
    if (!supported) return out;
    cache = null;
    const due = (await orders()).filter(o => o.kind === 'category' && o.status === 'active' && o.last_renewal_at &&
      (!o.report_through || o.report_through < dayOf(o.last_renewal_at)));
    for (const order of due) {
      const renewal = dayOf(order.last_renewal_at);
      const start = order.report_through || dayOf(order.approved_at || order.paid_at) || renewal;
      const end = addDays(renewal, -1) < start ? start : addDays(renewal, -1);
      const stats = await partnerStatsFor(order, start, end);
      const cat = categoryOf(order.category);
      const summary = [['Partner', order.business], ['Category', cat ? cat.label : order.category], ['Month', `${start} to ${end}`],
        ['Views on the site', stats.views], ['Clicked', stats.click_people]];
      if (!mailer || !mailer.enabled) {
        if (slack) {
          slack.alert(`partner-report:${order.id}:${renewal}`, `Send ${order.business} their partner report (email is off)`,
            `${summary.map(([k, v]) => `${k}: ${v}`).join('\n')}\nEmail it to ${order.email}. Set RESEND_API_KEY so these go out on their own.`, `${siteUrl}/admin.html`);
        }
        await recordReport(order, { report: stats, report_through: renewal, report_slack_sent: nowIso() });
        out.skipped++;
        continue;
      }
      const sent = await mailer.send(order.email, renderPartnerReport(order, stats, { siteUrl, address: mailAddress, manageUrl: manageLink(order) }),
        `${town.keyPrefix}-partner-report-${order.id}-${renewal}`);
      if (!sent) {
        out.failed++;
        if (slack && order.report_failed !== renewal) {
          slack.alert(`partner-report-failed:${order.id}`, `Partner report to ${order.business} didn't send`, 'It will be retried on the next run.', `${siteUrl}/admin.html`);
          await recordReport(order, { report_failed: renewal });
        }
        continue;
      }
      await recordReport(order, { report: stats, report_through: renewal, report_sent: nowIso() });
      out.sent++;
      if (slack) slack.notify({ channel: 'sales', title: `📊 Partner report sent: ${order.business}`, fields: [...summary, ['To', order.email]] });
    }
    return out;
  }

  async function newsletterSend(week) {
    try {
      return typeof store.getNewsletterSend === 'function' ? await store.getNewsletterSend(week) : null;
    } catch { return null; } // the report still goes, without the newsletter line
  }

  // Newsletter copies a weekly sponsor's block went out in: Monday's issue
  // and Thursday's weekend issue both carry the week's sponsor, unless the
  // payment cleared after one went out (newsletter_missed: Monday's;
  // newsletter_missed_both: Thursday's too). → { recipients, issues }
  async function recipientsFor(order) {
    const week = order.week_start;
    const [mon, thu] = await Promise.all([newsletterSend(week), newsletterSend(addDays(week, 3))]);
    const sent = [!order.newsletter_missed && mon, !order.newsletter_missed_both && thu]
      .filter(nl => nl && Number(nl.recipients) > 0);
    return { recipients: sent.reduce((n, nl) => n + Number(nl.recipients), 0), issues: sent.length };
  }

  // Where a paid pick ran: the live and archived events it matches (by the
  // same rule that pins it, pickMatches), for their page paths, links and
  // last date. The admin may have fixed the date when approving, so the
  // live copy's date wins over the one bought.
  async function pickPlacement(order, list) {
    const p = await pins(list);
    // `complete` is false when either read failed: "not found" then means
    // "couldn't look", and the report run must try again rather than record
    // the pick as never having gone live (a one-off and a refund alert).
    let complete = true;
    let events = [];
    try { events = ((getPayload && (await getPayload())) || {}).events || []; } catch { complete = false; }
    let archived = [];
    try { archived = typeof store.listArchivedEvents === 'function' ? await store.listArchivedEvents() : []; } catch { complete = false; }
    const hits = [...events, ...archived].filter(ev => ev && ev.page && pickMatches(order, ev, p));
    const dates = [order.event.date, ...hits.map(ev => ev.date)].filter(Boolean).sort();
    return {
      found: hits.length > 0,
      complete,
      pages: [...new Set(hits.map(ev => ev.page))],
      urls: [...new Set([order.event.url, ...hits.map(ev => ev.url)].filter(Boolean))],
      lastDate: dates[dates.length - 1]
    };
  }

  // The newsletter record notes which paid picks it starred (`picks`);
  // a send from before that was recorded falls back to the promise made
  // at purchase (newsletterCovers).
  async function pickStatsFor(order, list, rows = null) {
    const place = await pickPlacement(order, list);
    const week = currentWeek(place.lastDate);
    // Monday's issue and Thursday's weekend issue: the copies of each that
    // starred it.
    const [mon, thu] = await Promise.all([newsletterSend(week[0]), newsletterSend(week[3])]);
    const bought = order.paid_at || order.created_at;
    const starredIn = (nl, covers) => Boolean(nl && Number(nl.recipients)) &&
      (Array.isArray(nl.picks) ? nl.picks.includes(order.id) : covers(order.event.date, bought));
    const inMon = starredIn(mon, newsletterCovers);
    const inThu = starredIn(thu, weekendCovers);
    const starred = inMon || inThu;
    const recipients = (inMon ? Number(mon.recipients) : 0) + (inThu ? Number(thu.recipients) : 0);
    const start = localDateStr(new Date(order.paid_at || order.created_at || Date.now()));
    if (!rows) rows = typeof store.listTraffic === 'function' ? await store.listTraffic(start) : [];
    return { place, stats: pickStats(order, rows, { start, end: place.lastDate, pages: place.pages, urls: place.urls, recipients, starred, issues: (inMon ? 1 : 0) + (inThu ? 1 : 0) }) };
  }

  // Live stats for the admin Sponsors tab's Report button: the same numbers
  // the emails send, so far.
  async function orderReport(order, list) {
    if (order.kind === 'weekly' && order.week_start) {
      const rows = typeof store.listTraffic === 'function' ? await store.listTraffic(order.week_start) : [];
      return { kind: 'weekly', stats: sponsorStats(order, rows, await recipientsFor(order)) };
    }
    if (order.kind === 'featured' && order.event && order.event.date) {
      const { place, stats } = await pickStatsFor(order, list);
      return { kind: 'featured', on_site: place.found, stats };
    }
    if (order.kind === 'category' && (order.approved_at || order.paid_at)) {
      const start = order.report_through || dayOf(order.approved_at || order.paid_at);
      const end = localDateStr(nowFn());
      return { kind: 'category', stats: await partnerStatsFor(order, start, end < start ? start : end) };
    }
    return null;
  }

  // The Vic's Pick report: emailed to each paid pick's buyer the day after
  // its (last) day, once, like sendSponsorReports (report_sent on the
  // order, Resend key vic361-pick-report-<id>, catches up for
  // REPORT_CATCHUP_DAYS). Refunded, hidden and late orders aren't LIVE, so
  // they get none. A pick that never made it onto the site gets no email;
  // the owner hears once (report_skipped). Runs from the submission review
  // cron (every 15 minutes) and the Monday newsletter cron.
  let pickRun = null;
  function sendPickReports(now = nowFn()) {
    if (!pickRun) pickRun = runPickReports(now).finally(() => { pickRun = null; });
    return pickRun;
  }

  async function runPickReports(now) {
    const out = { sent: 0, skipped: 0, failed: 0 };
    if (!supported) return out;
    // The 15-minute cron would otherwise send it just after midnight;
    // counting the day from PICK_REPORT_HOUR sends it in the morning.
    const today = localDateStr(new Date(now.getTime() - PICK_REPORT_HOUR * 3600 * 1000));
    cache = null;
    const list = await orders();
    // Cheap first cut on the date bought; the live date is checked below.
    const due = list.filter(o => o.kind === 'featured' && LIVE.has(o.status) && o.event && o.event.date &&
      !o.report_sent && !o.report_skipped && addDays(o.event.date, 1) <= today &&
      addDays(o.event.date, 1 + REPORT_CATCHUP_DAYS) >= today);
    if (!due.length) return out;
    const since = due.map(o => localDateStr(new Date(o.paid_at || o.created_at || now))).sort()[0];
    const rows = typeof store.listTraffic === 'function' ? await store.listTraffic(since) : [];
    for (const order of due) {
      const { place, stats } = await pickStatsFor(order, list, rows);
      if (addDays(place.lastDate, 1) > today) continue; // re-dated later: not over yet
      if (addDays(place.lastDate, 1 + REPORT_CATCHUP_DAYS) < today) continue;
      const name = order.event.name || 'their event';
      if (!place.found && !place.complete) {
        // A database blip at this run, not proof it never ran: the next
        // run (15 minutes) looks again.
        console.warn(`[sponsors] pick report ${order.id}: event lookup failed, retrying next run`);
        out.failed++;
        continue;
      }
      if (!place.found) {
        await recordReport(order, { report_skipped: nowIso() });
        out.skipped++;
        if (slack) {
          slack.alert(`pick-report-skipped:${order.id}`, `No ${town.pickNamePlain} report for ${order.business}: it never went live`,
            `${name} (${order.event.date}) was paid for but never matched a listed event, so there are no numbers to send. Check whether they need a refund.`,
            `${siteUrl}/admin.html`);
        }
        continue;
      }
      const summary = [['Buyer', order.business], ['Event', `${name} (${place.lastDate})`],
        ['Shown in lists', stats.shown], ['Event page views', stats.page_views], ['Clicked their link', stats.link_people],
        ['Added to calendar', stats.calendar_adds], ['Shares', stats.shares], ['Visits from shares', stats.share_visits],
        ['Newsletter', stats.newsletter_starred ? `Starred, ${stats.newsletter_recipients} copies${stats.newsletter_issues > 1 ? ' (Mon + Thu)' : ''}` : 'Not in it']];
      if (!mailer || !mailer.enabled) {
        if (!order.report_slack_sent && slack) {
          slack.alert(`pick-report:${order.id}`, `Send ${order.business} their ${town.pickNamePlain} report (email is off)`,
            `${summary.map(([k, v]) => `${k}: ${v}`).join('\n')}\nEmail it to ${order.email}. Set RESEND_API_KEY so these go out on their own.`,
            `${siteUrl}/admin.html`);
          await recordReport(order, { report: stats, report_slack_sent: nowIso() });
        }
        out.skipped++;
        continue;
      }
      const sent = await mailer.send(order.email, renderPickReport(order, stats, { siteUrl, address: mailAddress }), `${town.keyPrefix}-pick-report-${order.id}`);
      if (!sent) {
        out.failed++;
        if (slack && !order.report_failed) {
          slack.alert(`pick-report-failed:${order.id}`, `${town.pickNamePlain} report to ${order.business} didn't send`, 'It will be retried on the next run.', `${siteUrl}/admin.html`);
          await recordReport(order, { report_failed: nowIso() });
        }
        continue;
      }
      await recordReport(order, { report: stats, report_sent: nowIso() });
      out.sent++;
      if (slack) slack.notify({ channel: 'sales', title: `📊 ${town.pickNamePlain} report sent: ${order.business}`, fields: [...summary, ['To', order.email]] });
    }
    return out;
  }

  // A checkout that never got paid doesn't keep its uploaded logo.
  async function dropLogo(order) {
    const has = order && ((order.sponsor && order.sponsor.logo) || (order.partner && order.partner.logo));
    if (!has || typeof store.deleteSponsorLogo !== 'function') return;
    try { await store.deleteSponsorLogo(order.id); } catch (err) { console.warn('[sponsors] logo delete failed:', err.message); }
  }

  // Served only while the order is live, settling or being paid for right
  // now (the confirmation email and the hold's own preview), never once
  // it's hidden, refunded, expired or abandoned.
  function logoServed(o, nowMs) {
    return Boolean(o) && (LIVE.has(o.status) || o.status === 'processing' || isHold(o, nowMs));
  }

  // Why a hidden order can't be put back: its day or week was sold while it
  // was hidden. Empty when it fits.
  function restoreConflict(order, list, now) {
    const others = list.filter(o => o.id !== order.id);
    if (order.kind === 'featured' && order.event) {
      const a = pickAvailability(order.event.date, others, now);
      if (!a.left) return `${formatDay(order.event.date, { weekday: 'long', month: 'short', day: 'numeric' })} already has its ${a.cap} ${town.pickName}s (one was sold while this was hidden). Refund this one in Stripe, or hide another first.`;
    }
    if (order.kind === 'weekly') {
      const nowMs = now.getTime();
      const taken = others.some(o => o.kind === 'weekly' && o.week_start === order.week_start &&
        (o.status === 'paid' || o.status === 'processing' || isHold(o, nowMs)));
      if (taken) return `The week of ${order.week_start} was sold to someone else while this was hidden. Refund this one in Stripe, or move it to another week (Edit).`;
    }
    return '';
  }

  // Admin edit of a weekly sponsor: the same checks as the checkout form
  // (validateOrder), for the fields sent. Moving to another week must land
  // on an open one; a double-booked ('conflict') order moved to an open
  // week goes live like any paid order. Run under the booking lock.
  async function editWeekly(order, input) {
    cache = null;
    const list = await store.listSponsorOrders();
    const current = list.find(o => o.id === order.id) || order;
    const s = current.sponsor || {};
    const has = k => typeof input[k] === 'string';
    const errors = {};
    const business = has('business') ? clean(input.business, 80) : current.business;
    if (!business) errors.business = 'Business name is required.';
    const text = has('text') ? clean(input.text, 160) : s.text;
    if (!text) errors.text = 'Add one or two sentences about the business.';
    const cta = has('cta') ? (clean(input.cta, 24) || 'Learn more') : (s.cta || 'Learn more');
    const url = has('url') ? safeUrl(normalizeUrl(clean(input.url, 300))) : s.url;
    if (!url) errors.url = 'Enter a website or page (e.g. example.com).';
    const address = has('address') ? clean(input.address, 120) : (s.address || '');
    let week = current.week_start;
    if (has('week') && input.week && input.week !== current.week_start) {
      const w = bookableWeeks(nowFn(), list.filter(o => o.id !== current.id)).find(x => x.start === input.week);
      if (!w) errors.week = 'Pick one of the next 8 weeks.';
      else if (!w.available) errors.week = `The week of ${w.label} is already booked.`;
      else week = w.start;
    }
    let logo = null;
    if (has('logo_data') && input.logo_data) {
      logo = parseLogo(input.logo_data);
      if (logo.error) errors.logo = logo.error;
    }
    if (Object.keys(errors).length) return { errors };
    const sponsor = { ...s, name: business, text, cta, url, address };
    if (logo && typeof store.saveSponsorLogo === 'function') {
      await store.saveSponsorLogo(current.id, logo);
      sponsor.logo = `/sponsor-logo/${current.id}`;
    }
    const moved = current.status === 'conflict' && week !== current.week_start;
    const next = { ...current, business, sponsor, week_start: week, ...(moved ? { status: 'paid' } : {}) };
    await save(next);
    return { order: next, moved };
  }

  // Best effort: close a released hold's Stripe session so it can't be paid
  // later. If this fails it expires on its own in 30 minutes, and a late
  // payment is still honored (see the webhook).
  async function expireSession(o) {
    if (!o.session_id || typeof stripe.expireCheckoutSession !== 'function') return;
    try { await stripe.expireCheckoutSession(o.session_id); } catch (err) { console.warn('[sponsors] session expire failed:', err.message); }
  }

  // The form fields of an order, to refill the form when the buyer backs
  // out of Stripe (cancel_url).
  function orderValues(o) {
    const s = o.sponsor || {};
    const ev = o.event || {};
    if (o.kind === 'category') {
      const pp = o.partner || {};
      return { category: o.category, business: o.business, line: pp.line, url: pp.url, cta: pp.cta, email: o.email };
    }
    return o.kind === 'weekly'
      ? { week: o.week_start, business: o.business, text: s.text, url: s.url, cta: s.cta, address: s.address, email: o.email }
      : { event_name: ev.name, date: ev.date, time: ev.time, end_time: ev.end_time, venue: ev.venue, address: ev.address, description: ev.description,
        url: ev.url, business: o.business, email: o.email };
  }

  const findBy = (list, key, val) => (val ? list.find(o => o[key] === val) : null);

  // When Stripe says the event happened (event.created), never later than
  // now (a clock ahead of ours), or now when it has no time.
  function eventTime(event) {
    const now = nowFn();
    const t = Number(event && event.created) * 1000;
    return Number.isFinite(t) && t > 0 && t < now.getTime() ? new Date(t) : now;
  }

  // A Stripe test-mode payment on the production site while its key is
  // live: never fulfilled (anyone could book with Stripe's public test card).
  // A test key in production is the Setup checklist's warning instead, so a
  // new town's launch test-mode checkout still works.
  const testModeRefused = event => Boolean(config.production && config.liveKey && event && event.livemode === false);

  // Buyer emails a webhook sends (late, failed, double-booked); never for
  // a test-mode payment on the production site.
  const mayEmail = event => Boolean(mailer && mailer.enabled) && !(config.production && event && event.livemode === false);

  // The live orders in a slot paid for after `order`'s buyer finished
  // checkout (`finishedAt`), latest first, when there are `need` of them
  // and the slot hasn't started yet (a running week or day stays with
  // whoever is running it); null otherwise (then `order` is the one
  // double-booked).
  function paidAfter(order, rivals, finishedAt, need) {
    const d = orderDates(order);
    if (!d || d[0] <= localDateStr(nowFn())) return null;
    const later = rivals.filter(r => Date.parse(r.paid_at) > finishedAt.getTime())
      .sort((a, b) => Date.parse(b.paid_at) - Date.parse(a.paid_at));
    return later.length >= need ? later.slice(0, need) : null;
  }

  // The order a charge, refund or dispute is for: by its payment intent,
  // or for a venue partner's renewal by its invoice (older API versions)
  // or, from a charge, its Stripe customer.
  function chargeOrder(list, obj, isCharge) {
    const pi = typeof obj.payment_intent === 'string' ? obj.payment_intent : null;
    const byPi = findBy(list, 'payment_intent', pi);
    if (byPi) return byPi;
    const inv = typeof obj.invoice === 'string' ? obj.invoice : null;
    const byInvoice = findBy(list, 'latest_invoice', inv);
    if (byInvoice) return byInvoice;
    const customer = isCharge && typeof obj.customer === 'string' ? obj.customer : null;
    if (!customer) return null;
    // A category partner may have an ended order and a newer one: the
    // running one first.
    const subs = list.filter(o => (o.kind === 'partner' || o.kind === 'category') && o.customer_id === customer);
    return subs.find(o => !['rejected', 'canceled', 'cancelled', 'refunded'].includes(o.status)) || subs[0] || null;
  }

  // A paid order that can't run because its slot is taken ('conflict'):
  // the owner moves or refunds it, and the buyer is told (they may have
  // closed the thank-you page that explains it).
  async function doubleBooked(order, event, title, text, mail) {
    order.status = 'conflict';
    await save(order);
    if (slack) slack.alert(`sponsor-conflict:${order.id}`, title, text, `${siteUrl}/admin.html`);
    if (mayEmail(event)) {
      mail.push(() => mailer.send(order.email, renderSponsorConflict(order, { siteUrl, address: mailAddress }), `${town.keyPrefix}-sponsor-conflict-${order.id}`));
    }
  }

  // `rival` went live in a slot that `winner` had already paid for inside
  // its checkout hold (winner's webhook only arrived after the hold had
  // lapsed): the slot goes back to the buyer who paid first.
  async function bumpedBy(rival, winner, finishedAt, event, mail) {
    const what = winner.kind === 'weekly' ? `the week of ${winner.week_start}` : `a ${town.pickName} on ${winner.event.date}`;
    await doubleBooked({ ...rival }, event, `${winner.business} paid first for ${what}`,
      `${winner.business} (${winner.email}, order ${winner.id}) paid for ${what} at ${finishedAt.toISOString()}, inside their checkout hold, but Stripe's webhook only reached us later. ` +
      `Meanwhile ${rival.business} (${rival.email}, order ${rival.id}) bought it at ${rival.paid_at}. ${winner.business} keeps it; ${rival.business} is off the site and has been told you'll be in touch within 1 business day: move them to an open ${winner.kind === 'weekly' ? 'week (Sponsors tab, Edit)' : 'day'} or refund them in Stripe.`, mail);
  }

  // ─── Category partner subscriptions ──────────────────────────────────
  // Stripe's word on a partner's subscription (customer.subscription.*).
  // Past due or unpaid hides a live partner until it's paid; the
  // subscription ending is final ('canceled', the category opens again).
  // A rejected (or being-rejected) order stays rejected: nothing Stripe
  // says brings a rejected or canceled partner back.
  const BAD_SUB = new Set(['past_due', 'unpaid', 'incomplete_expired', 'paused']);
  const ENDED = new Set(['rejected', 'canceled', 'refunded']);
  async function partnerSubscription(order, event, obj, mail) {
    const cat = categoryOf(order.category);
    const label = cat ? cat.label : order.category;
    const deleted = event.type === 'customer.subscription.deleted' || obj.status === 'canceled';
    if (ENDED.has(order.status) || order.rejecting) {
      if (deleted && !order.subscription_ended) await save({ ...order, subscription_ended: nowIso() });
      return;
    }
    if (deleted) {
      const was = order.status;
      await save({ ...order, status: 'canceled', canceled_at: nowIso(), subscription_ended: nowIso(), hidden_from: null });
      if (slack) {
        slack.notify({ channel: 'sales',
          title: `👋 Partner cancelled: ${order.business}`,
          fields: [['Category', label], ['Contact', order.email], ['Was', was]],
          text: `Their subscription ended, so they're off the site and out of the newsletter. ${label} is open again.`
        });
      }
      // Not for a double-booked one: they were told they'd be refunded.
      if (was !== 'conflict' && mayEmail(event)) {
        mail.push(() => mailer.send(order.email, renderPartnerCanceled(order, { siteUrl, address: mailAddress, manageUrl: manageLink(order) }),
          `${town.keyPrefix}-partner-canceled-${order.id}`));
      }
      return;
    }
    const bad = BAD_SUB.has(obj.status);
    const good = obj.status === 'active' || obj.status === 'trialing';
    // Cancelling in the billing portal usually ends the subscription at the
    // end of the paid month: remember when, for the admin.
    const cancelAt = obj.cancel_at_period_end && Number(obj.cancel_at || obj.current_period_end)
      ? new Date(Number(obj.cancel_at || obj.current_period_end) * 1000).toISOString() : null;
    const next = { ...order, cancel_at: cancelAt, stripe_status: obj.status || order.stripe_status || null };
    if (order.status === 'hidden') {
      // Hidden by the owner: Restore puts back what Stripe says now.
      if (bad) next.hidden_from = 'past_due';
      else if (good && order.hidden_from === 'past_due') next.hidden_from = 'active';
    } else if (order.status === 'active' && bad) {
      next.status = 'past_due';
      next.past_due_at = nowIso();
      if (slack) {
        slack.notify({ channel: 'sales',
          title: `⚠️ Partner payment failing: ${order.business} is hidden`,
          fields: [['Category', label], ['Stripe says', obj.status], ['Contact', order.email]],
          text: 'Stripe couldn\'t charge them, so their card is off the site and out of the newsletter until it\'s paid. Stripe keeps retrying; if it gives up, the subscription ends and the category opens.'
        });
      }
    } else if (order.status === 'past_due' && good) {
      next.status = 'active';
      if (slack) slack.notify({ channel: 'sales', title: `✅ Partner payment back on track: ${order.business}`, fields: [['Category', label]], text: 'They\'re back on the site and in the newsletter.' });
    }
    if (next.status !== order.status || next.cancel_at !== (order.cancel_at || null) || next.hidden_from !== order.hidden_from || next.stripe_status !== order.stripe_status) {
      await save(next);
    }
  }

  // A partner's invoice paid: the first month or a renewal. A renewal sets
  // last_renewal_at, which is when the monthly report goes out
  // (runPartnerReports); a past-due partner is back.
  async function partnerInvoicePaid(order, event, obj) {
    if (ENDED.has(order.status) || order.rejecting) return;
    const paid = obj.payments && Array.isArray(obj.payments.data) &&
      obj.payments.data.map(x => x && x.payment).find(x => x && typeof x.payment_intent === 'string');
    const pi = (typeof obj.payment_intent === 'string' && obj.payment_intent) || (paid && paid.payment_intent) || null;
    const invoices = Array.isArray(order.paid_invoices) ? order.paid_invoices : [];
    if (obj.id && invoices.includes(obj.id)) return;   // a repeat delivery
    const at = eventTime(event).toISOString();
    const renewal = obj.billing_reason ? obj.billing_reason === 'subscription_cycle'
      : Boolean(order.first_invoice && obj.id && obj.id !== order.first_invoice);
    const next = {
      ...order, latest_invoice: obj.id || order.latest_invoice || null, payment_intent: pi || order.payment_intent || null,
      last_paid_at: at, paid_invoices: [...invoices, ...(obj.id ? [obj.id] : [])].slice(-24),
      ...(renewal ? { last_renewal_at: at } : {}),
      ...(order.status === 'past_due' ? { status: 'active' } : {})
    };
    await save(next);
  }

  // One webhook at a time, under the same lock as checkout bookings: Stripe
  // can deliver an event twice at once (both would fulfil a pending order),
  // and two weekly orders settling together must not both pass the
  // "is this week already live?" check below.
  // Emails the event calls for are queued in `mail` and sent after the lock
  // is released: a slow Resend must not hold up checkouts and other
  // webhooks. They never throw (createMailer), and a confirmation that
  // didn't send is retried by retryConfirmations, so the webhook's answer
  // doesn't depend on them.
  async function processEvent(event) {
    const mail = [];
    await withBookingLock(() => handleEvent(event, mail));
    for (const job of mail) {
      try { await job(); } catch (err) { console.warn('[sponsors] post-webhook email failed:', err.message); }
    }
  }

  async function handleEvent(event, mail = []) {
    const obj = (event && event.data && event.data.object) || {};
    if (!supported) return;
    if (TOWN_TAGGED.test(String(event && event.type)) && eventTown(obj) !== town.id) return;
    const list = await freshOrders();
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const order = findBy(list, 'id', obj.client_reference_id) || findBy(list, 'session_id', obj.id);
        if (!order) {
          // Our own session (it carries our order_id, and the town filter
          // above passed), paid, with no order here: Stripe has the money
          // and nothing will run. Typically a restored or recreated
          // database, or DATABASE_URL pointing at another one. Still a 200:
          // a retry can't find it either.
          if (obj.payment_status === 'paid' && obj.metadata && obj.metadata.order_id) {
            const email = (obj.customer_details && obj.customer_details.email) || obj.customer_email || 'unknown email';
            const pi = typeof obj.payment_intent === 'string' ? obj.payment_intent : '';
            console.error('[sponsors] paid checkout with no order:', obj.id, obj.metadata.order_id);
            if (slack) {
              slack.alert(`stripe-orphan:${obj.id}`, 'Paid Stripe checkout with no order',
                `${email} paid $${Math.round((Number(obj.amount_total) || 0) / 100)} (order ${obj.metadata.order_id}, ${obj.metadata.package || 'unknown package'}; session ${obj.id}${pi ? `, payment ${pi}` : ''}${event.livemode === false ? ', test mode' : ''}), but this site has no such order, so nothing was booked. ` +
                'Check that DATABASE_URL is this town\'s database (or restore the latest backup), then book them by hand or refund them in Stripe.',
                'https://dashboard.stripe.com/payments');
            }
          }
          return;
        }
        // Stripe's test card on the live site: a test-mode event can only
        // reach production with a live key through a test endpoint's secret.
        // Nothing is fulfilled or held; the owner hears about it.
        if (testModeRefused(event)) {
          if (!LIVE.has(order.status) && order.status !== 'failed') {
            await save({ ...order, status: 'failed', test: true, test_mode_refused: nowIso() });
            await dropLogo(order);
          }
          if (slack) {
            slack.alert(`stripe-test-mode:${order.id}`, 'Test-mode Stripe payment refused in production',
              `A Stripe test-mode payment for ${order.business} (${order.email}, order ${order.id}) reached the live site, which uses a live key, so nothing was booked. ` +
              'STRIPE_WEBHOOK_SECRET may be the test endpoint\'s: use the live endpoint\'s signing secret.',
              'https://dashboard.stripe.com/webhooks');
          }
          return;
        }
        // A retry after a failed fulfil (e.g. the submission insert threw):
        // the order is already paid, so finish the job instead of stopping.
        if (LIVE.has(order.status)) {
          if (order.kind === 'featured' && order.event && !order.submission_id) await fulfil(order);
          mail.push(() => sendConfirmation(order));
          return;
        }
        // 'cancelled': the buyer came back via cancel_url but paid anyway
        // (another tab) before the session could be expired.
        if (!['pending', 'expired', 'failed', 'processing', 'cancelled'].includes(order.status) ||
            (order.status === 'cancelled' && order.paid_at)) return;
        // When it happened at Stripe, not when the event got here: Stripe
        // retries for days after a 500 (database down, a deploy), and an
        // on-time payment mustn't turn "late" or lose its slot meanwhile.
        const paidAt = eventTime(event);
        // Delayed payment methods complete the session before the money
        // arrives; async_payment_succeeded (or _failed) follows. Hold the
        // week meanwhile so nobody else can buy it. Only an open checkout
        // moves to 'processing': a retried or replayed completed event
        // arriving after async_payment_failed (or expiry) would otherwise
        // hold the slot forever, with no further event to release it.
        if (obj.payment_status !== 'paid' && obj.payment_status !== 'no_payment_required') {
          if (event.type === 'checkout.session.completed' && (order.status === 'pending' || order.status === 'cancelled')) {
            await save({ ...order, status: 'processing', session_id: order.session_id || obj.id, processing_at: paidAt.toISOString() });
          }
          return;
        }
        // Whether the buyer finished checkout while their hold still kept
        // the slot for them (a bank debit finished at processing_at). Then
        // the slot is theirs even if their webhook arrived after the hold
        // lapsed and someone else bought it meanwhile.
        const finishedAt = new Date(Date.parse(order.processing_at) || paidAt.getTime());
        const held = (order.status === 'pending' || order.status === 'processing') &&
          finishedAt.getTime() - Date.parse(order.created_at) < HOLD_MS;
        Object.assign(order, {
          // A category partner waits for the owner's OK (approve/reject).
          status: order.kind === 'partner' ? 'active' : order.kind === 'category' ? 'pending_approval' : 'paid',
          // Its first invoice (subscription mode): what a rejection refunds.
          ...(typeof obj.invoice === 'string' ? { first_invoice: order.first_invoice || obj.invoice, latest_invoice: obj.invoice } : {}),
          paid_at: paidAt.toISOString(),
          amount: Number.isFinite(obj.amount_total) ? obj.amount_total : order.amount,
          subscription_id: typeof obj.subscription === 'string' ? obj.subscription : null,
          customer_id: typeof obj.customer === 'string' ? obj.customer : null,
          payment_intent: typeof obj.payment_intent === 'string' ? obj.payment_intent : null,
          // Paid with Stripe's test keys: not real money (revenue leaves it out).
          ...(event.livemode === false ? { test: true } : {})
        });
        // Settled after the date it paid for: nothing left to run, so no
        // submission and no "you're booked". The owner refunds in Stripe
        // (the restricted key can't); the buyer is told so.
        if (paidTooLate(order, paidAt)) {
          order.status = 'late';
          await save(order);
          await dropLogo(order);
          if (slack) {
            slack.alert(`sponsor-late:${order.id}`, `Refund ${order.business}: payment cleared after its date`,
              `${order.business} (${order.email}) paid $${Math.round((order.amount || 0) / 100)} by bank for ${order.kind === 'weekly' ? `the week of ${order.week_start}` : `${order.event.name} (${order.event.date})`}, but it only cleared now. Nothing went live; they've been told they'll be refunded in full. Refund it in Stripe${order.payment_intent ? ` (${order.payment_intent})` : ''}.`,
              'https://dashboard.stripe.com/payments');
          }
          if (mayEmail(event)) {
            mail.push(() => mailer.send(order.email, renderSponsorTooLate(order, { siteUrl, address: mailAddress }), `${town.keyPrefix}-sponsor-late-${order.id}`));
          }
          return;
        }
        // Someone else already paid for this week (e.g. this hold lapsed
        // first). Keep the money traceable and ask for a refund, but don't
        // put two sponsors in one slot. If this buyer paid first, inside
        // their hold, and only the webhook was late, the later buyer gives
        // the week back instead (while it hasn't started).
        if (order.kind === 'weekly') {
          const rivals = list.filter(o => o.id !== order.id && o.kind === 'weekly' && o.week_start === order.week_start && LIVE.has(o.status));
          if (rivals.length) {
            const bump = held ? paidAfter(order, rivals, finishedAt, rivals.length) : null;
            if (!bump) {
              await doubleBooked(order, event, `Week of ${order.week_start} was paid for twice`,
                `${order.business} (${order.email}) paid for a week that's already sold. They've been told you'll be in touch within 1 business day: move them to an open week (Sponsors tab, Edit) or refund them in Stripe.`, mail);
              return;
            }
            for (const r of bump) await bumpedBy(r, order, finishedAt, event, mail);
          }
        }
        // A category someone else claimed meanwhile (this buyer's hold had
        // lapsed): one business per category, so this one doesn't run. The
        // owner rejects it (cancel + refund) from the alert.
        if (order.kind === 'category') {
          const rival = list.find(o => o.id !== order.id && o.category === order.category && takesCategory(o));
          if (rival) {
            const cat = categoryOf(order.category);
            await doubleBooked(order, event, `${cat ? cat.label : order.category} partner was paid for twice`,
              `${order.business} (${order.email}, order ${order.id}) paid for ${cat ? cat.label : order.category}, but ${rival.business} (order ${rival.id}) already has it. Nothing shows for them; they've been told you'll be in touch within 1 business day. Reject it in Admin → Sponsors to cancel their subscription and refund them.`, mail);
            return;
          }
        }
        // The same for a Vic's Pick day: a hold the buyer backed out of
        // (cancelled, or expired) stopped counting, so others may have filled
        // the day before this payment arrived from a still-open tab. Count
        // the day without this order; at the cap, it's a conflict too
        // (unless this one paid first inside its hold: see above).
        if (order.kind === 'featured' && order.event && order.event.date) {
          const others = list.filter(o => o.id !== order.id);
          const a = pickAvailability(order.event.date, others, nowFn());
          if (a.taken >= a.cap) {
            let bump = null;
            if (held) {
              // Holds open right now are left alone: they turn into
              // conflicts themselves if they pay into a full day.
              const settled = others.filter(o => o.kind === 'featured' && o.event && o.event.date === order.event.date &&
                (LIVE.has(o.status) || o.status === 'processing'));
              const need = settled.length - a.cap + 1;
              bump = need <= 0 ? [] : paidAfter(order, settled.filter(o => LIVE.has(o.status)), finishedAt, need);
            }
            if (!bump) {
              await doubleBooked(order, event, `${town.pickName} day ${order.event.date} is over its cap`,
                `${order.business} (${order.email}) paid for a ${town.pickName} on ${order.event.date} (${order.event.name}), but its ${a.cap} spots were already taken. Nothing went live: move them to an open day or refund them in Stripe.`, mail);
              return;
            }
            for (const r of bump) await bumpedBy(r, order, finishedAt, event, mail);
          }
        }
        // A bank debit that cleared after its week's Monday issue went out:
        // the sponsor spot in that newsletter is gone, so the owner owes a
        // make-good and the confirmation doesn't promise it. Thursday's
        // weekend issue still carries it unless that has gone out too.
        if (order.kind === 'weekly' && await newsletterSend(order.week_start)) {
          order.newsletter_missed = nowIso();
          // With the weekend issue off, Thursday's never carries it either.
          const both = !weekendIssueOn() || Boolean(await newsletterSend(addDays(order.week_start, 3)));
          order.newsletter_missed_both = both;
          if (slack) {
            slack.alert(`sponsor-newsletter-missed:${order.id}`, `${order.business} paid after their week's newsletter went out`,
              `${order.business} (${order.email}) paid by bank for the week of ${order.week_start}; it cleared after that Monday's newsletter${both ? ' and Thursday\'s weekend issue were' : ' was'} sent, so their block wasn't in ${both ? 'either' : 'it'}${both ? '' : ' (it will be in Thursday\'s weekend issue)'}. It's live on the site now; offer them a make-good (e.g. a later issue) or a partial refund.`,
              `${siteUrl}/admin.html`);
          }
        }
        await save(order);
        await fulfil(order);
        mail.push(() => sendConfirmation(order));
        return;
      }
      case 'checkout.session.async_payment_failed': {
        const order = findBy(list, 'id', obj.client_reference_id) || findBy(list, 'session_id', obj.id);
        if (!order || !['processing', 'pending'].includes(order.status)) return;
        await save({ ...order, status: 'failed' });
        await dropLogo(order);
        if (slack) {
          slack.notify({ channel: 'sales',
            title: `⚠️ Sponsor payment didn't go through: ${order.business}`,
            fields: [['Package', order.kind], ['Contact', order.email]],
            text: order.kind === 'weekly' ? `Week of ${order.week_start} is open again.` : 'Nothing went live.'
          });
        }
        // The thank-you page said the spot was held until the debit cleared,
        // and Stripe doesn't email about a failed one-time debit.
        if (mayEmail(event)) {
          mail.push(() => mailer.send(order.email, renderSponsorPaymentFailed(order, { siteUrl, address: mailAddress }), `${town.keyPrefix}-sponsor-failed-${order.id}`));
        }
        return;
      }
      case 'invoice.payment_failed': {
        // Older API versions put the subscription on the invoice; newer ones
        // under parent.subscription_details.
        const subId = (typeof obj.subscription === 'string' && obj.subscription) ||
          (obj.parent && obj.parent.subscription_details && obj.parent.subscription_details.subscription) || null;
        const order = findBy(list, 'subscription_id', subId);
        if (order && order.kind === 'category') {
          if (slack && ['active', 'pending_approval', 'past_due', 'hidden'].includes(order.status)) {
            const cat = categoryOf(order.category);
            slack.notify({ channel: 'sales',
              title: `⚠️ Partner card declined: ${order.business}`,
              fields: [['Category', cat ? cat.label : order.category], ['Contact', order.email], ['Order', order.id]],
              text: 'Stripe retries on its own (and emails them, with Failed payment emails on). They stay up until the subscription goes past due; then they\'re hidden until it\'s paid.',
              link: `${siteUrl}/admin.html`
            });
          }
          return;
        }
        if (order && slack) {
          slack.notify({ channel: 'sales',
            title: `⚠️ Venue partner card declined: ${order.business}`,
            fields: [['Venue', order.venue_name], ['Contact', order.email]],
            text: 'Stripe will retry automatically. Their badges pause if the subscription goes past due.'
          });
        }
        return;
      }
      case 'radar.early_fraud_warning.created': {
        const pi = typeof obj.payment_intent === 'string' ? obj.payment_intent : null;
        const order = findBy(list, 'payment_intent', pi);
        // A warning names only a payment: another town alerts on its own
        // orders; Victoria, the account's first town, on the rest too.
        if (slack && (order || town.id === VICTORIA.id)) {
          slack.alert(`fraud-warning:${obj.id || pi}`, 'Stripe early fraud warning on a sponsor payment',
            `${order ? `${order.business} (${order.email}), ${order.kind}` : `Payment ${pi || 'unknown'}`}. Review it in Stripe and refund if it looks fraudulent.`,
            'https://dashboard.stripe.com/radar/early-fraud-warnings');
        }
        return;
      }
      case 'checkout.session.expired': {
        const order = findBy(list, 'id', obj.client_reference_id) || findBy(list, 'session_id', obj.id);
        if (!order || !(order.status === 'pending' || (order.status === 'cancelled' && !order.paid_at))) return;
        if (order.status === 'pending') await save({ ...order, status: 'expired' });
        await dropLogo(order);
        return;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const order = findBy(list, 'subscription_id', obj.id);
        if (!order) return;
        if (order.kind === 'category') { await partnerSubscription(order, event, obj, mail); return; }
        const s = event.type === 'customer.subscription.deleted' ? 'canceled' : obj.status;
        const status = (s === 'active' || s === 'trialing') ? 'active' : s === 'canceled' ? 'cancelled' : 'paused';
        // Hidden by the admin: remember what Stripe says so Restore can't
        // bring back a partner that cancelled in the meantime.
        if (order.status === 'hidden') {
          if (order.hidden_from !== status) await save({ ...order, hidden_from: status });
          return;
        }
        if (status !== order.status) {
          await save({ ...order, status });
          if (slack && status !== 'active') {
            slack.notify({ channel: 'sales',
              title: status === 'cancelled' ? `👋 Venue partner cancelled: ${order.business}` : `⚠️ Venue partner payment issue: ${order.business}`,
              fields: [['Venue', order.venue_name], ['Contact', order.email]],
              text: status === 'cancelled' ? `Their events are no longer marked ${town.pickName}.` : `Stripe couldn’t charge them, so their ${town.pickName} badges are paused until it does.`
            });
          }
        }
        return;
      }
      case 'invoice.paid': {
        // A venue partner's renewal: remember its payment (and invoice), so
        // a refund or dispute on a later month matches the order too. Older
        // API versions put the payment intent on the invoice; newer ones
        // under payments.
        const subId = (typeof obj.subscription === 'string' && obj.subscription) ||
          (obj.parent && obj.parent.subscription_details && obj.parent.subscription_details.subscription) || null;
        const order = findBy(list, 'subscription_id', subId);
        if (!order) return;
        if (order.kind === 'category') { await partnerInvoicePaid(order, event, obj); return; }
        const paid = obj.payments && Array.isArray(obj.payments.data) &&
          obj.payments.data.map(x => x && x.payment).find(x => x && typeof x.payment_intent === 'string');
        const pi = (typeof obj.payment_intent === 'string' && obj.payment_intent) || (paid && paid.payment_intent) || null;
        const next = { ...order, latest_invoice: obj.id || order.latest_invoice || null, payment_intent: pi || order.payment_intent };
        if (next.latest_invoice !== order.latest_invoice || next.payment_intent !== order.payment_intent) await save(next);
        return;
      }
      case 'charge.refunded':
      case 'charge.dispute.created':
      case 'charge.dispute.closed': {
        const order = chargeOrder(list, obj, event.type === 'charge.refunded');
        if (!order) return;
        if (event.type === 'charge.dispute.closed') {
          // Won (or an inquiry closed without a chargeback): the money is
          // back, so the order is again what it was before the dispute. Its
          // slot may have been sold meanwhile: then it stays off the site
          // (hidden; the money still counts) for the owner to sort out.
          if (order.status !== 'disputed') return;
          const d = order.dispute || {};
          if (obj.status === 'won' || obj.status === 'warning_closed') {
            const prev = d.prev_status || (order.kind === 'partner' ? 'active' : 'paid');
            const clash = LIVE.has(prev) ? restoreConflict(order, list, nowFn()) : '';
            const d1 = orderDates(order);
            const over = Boolean(d1) && d1[1] < localDateStr(nowFn());
            const status = clash && !over ? 'hidden' : prev;
            // A hidden order goes back to hidden, remembering what it was.
            const hiddenFrom = prev === 'hidden' ? (d.prev_hidden_from || null) : status === 'hidden' ? prev : null;
            await save({ ...order, status, hidden_from: hiddenFrom,
              dispute: { ...d, status: obj.status, closed_at: nowIso() } });
            if (slack) {
              slack.notify({ channel: 'sales',
                title: `✅ Sponsor dispute won: ${order.business}`,
                fields: [['Contact', order.email], ['Order', order.id]],
                text: status === 'hidden' ? `The money is back, but ${clash} It's hidden until you restore it.` : 'The money is back and the order is restored.'
              });
            }
          } else {
            await save({ ...order, dispute: { ...d, status: obj.status || 'lost', closed_at: nowIso() } });
            if (slack) {
              slack.notify({ channel: 'sales',
                title: `⚠️ Sponsor dispute lost: ${order.business}`,
                fields: [['Contact', order.email], ['Order', order.id]],
                text: 'Stripe kept the money for the cardholder. The placement stays off the site.'
              });
            }
          }
          return;
        }
        if (order.status === 'refunded') return;
        // A category partner's refund is one month's charge, not the end of
        // the subscription: it stays as it is (a rejection already refunded
        // and cancelled it; Stripe ending the subscription says the rest).
        if (order.kind === 'category' && event.type === 'charge.refunded') {
          const refunded = Number(obj.amount_refunded);
          const lr = order.last_refund || {};
          if (!Number.isFinite(refunded) || refunded <= 0 || (obj.id === lr.charge && refunded === lr.cents)) return;
          await save({ ...order, last_refund: { charge: obj.id || null, cents: refunded, at: nowIso() } });
          if (slack && order.status !== 'rejected' && !order.rejecting) {
            slack.notify({ channel: 'sales',
              title: `↩️ Partner refunded: ${order.business}`,
              fields: [['Refunded', `$${(refunded / 100).toFixed(2)}`], ['Contact', order.email], ['Order', order.id]],
              text: 'Their subscription is still running. If they\'re leaving, cancel it in Stripe (they disappear when it ends).'
            });
          }
          return;
        }
        if (event.type === 'charge.refunded') {
          const refunded = Number(obj.amount_refunded);
          // Partial refund: the placement stays live, and revenue counts
          // only what was kept (monthRevenue subtracts refunded_cents).
          if (obj.refunded === false) {
            if (!Number.isFinite(refunded) || refunded <= 0 || refunded === order.refunded_cents) return;
            await save({ ...order, refunded_cents: refunded });
            if (slack) {
              slack.notify({ channel: 'sales',
                title: `↩️ Sponsor partly refunded: ${order.business}`,
                fields: [['Refunded', `$${(refunded / 100).toFixed(2)} of $${((order.amount || 0) / 100).toFixed(2)}`], ['Contact', order.email], ['Order', order.id]],
                text: 'Their placement stays on the site.'
              });
            }
            return;
          }
          await save({ ...order, status: 'refunded', hidden_from: null, ...(Number.isFinite(refunded) && refunded > 0 ? { refunded_cents: refunded } : {}) });
        } else {
          // An open dispute isn't a refund: the money is held until Stripe
          // decides (charge.dispute.closed). Off the site and out of revenue
          // meanwhile.
          if (order.status === 'disputed') return;
          await save({ ...order, status: 'disputed', hidden_from: null,
            dispute: { id: obj.id || null, status: 'open', prev_status: order.status, prev_hidden_from: order.hidden_from || null, opened_at: nowIso() } });
        }
        if (slack) {
          slack.notify({ channel: 'sales',
            title: event.type === 'charge.refunded' ? `↩️ Sponsor refunded: ${order.business}` : `⚠️ Sponsor disputed a charge: ${order.business}`,
            fields: [['Contact', order.email], ['Order', order.id]],
            text: 'Their placement is off the site.'
          });
        }
        return;
      }
      default:
    }
  }

  // Must be registered before express.json: the signature covers raw bytes.
  // A run of refused webhooks: a wrong STRIPE_WEBHOOK_SECRET loses every
  // payment event (Stripe retries for days, then gives up).
  const refusedHooks = burst(3, 3600 * 1000);
  function hookRefused(why) {
    const many = refusedHooks(+nowFn());
    if (many && slack) slack.alert('stripe-webhook-refused', `Stripe webhooks are being refused (${why})`,
      `${many} in the last hour. Payments still go through, but the site doesn't hear about them (no confirmation, no Pick on the site). ` +
      'Check STRIPE_WEBHOOK_SECRET in Railway against the webhook\'s signing secret in Stripe → Developers → Webhooks. (If nothing changed, someone may just be poking at the URL.)', `${siteUrl}/admin.html`);
  }
  function registerWebhook(app) {
    app.post('/api/stripe/webhook', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
      if (!config.webhookSecret) {
        hookRefused('STRIPE_WEBHOOK_SECRET not set');
        return res.status(503).json({ ok: false, error: 'not-configured' });
      }
      const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      if (!verifyStripeSignature(raw, req.get('stripe-signature'), config.webhookSecret)) {
        hookRefused('bad signature');
        return res.status(400).json({ ok: false, error: 'bad-signature' });
      }
      let event;
      try { event = JSON.parse(raw); } catch (_) { return res.status(400).json({ ok: false, error: 'bad-json' }); }
      try {
        await processEvent(event);
      } catch (err) {
        // A 500 makes Stripe retry with backoff, which is what we want.
        console.error('[sponsors] webhook failed:', event.type, err.message);
        if (slack) slack.alert(`stripe-webhook:${event.type}`, 'Stripe webhook failed (Stripe will retry)', `${event.type}: ${err.message}`);
        return res.status(500).json({ ok: false, error: 'webhook-failed' });
      }
      res.json({ received: true });
    });
  }

  // ─── Approving a category partner ────────────────────────────────────
  // Every new partner waits for the owner (Admin → Sponsors, or HQ's
  // assistant with his words through /api/hq/admin/sponsors/:id). Approve
  // puts it live on the next request and emails "you're live". Reject
  // cancels the subscription now and refunds its payment (Stripe through
  // fetch), and emails a polite no; the category opens again.
  // → { status, body } for the route.
  async function approvePartner(id, via = 'admin') {
    const out = await withBookingLock(async () => {
      const fresh = await freshOrders();
      const cur = fresh.find(o => o.id === id);
      if (!cur || cur.kind !== 'category') return { status: 404, body: { ok: false, error: 'not-found' } };
      if (cur.status === 'active') return { status: 200, body: { ok: true, status: 'active', already: true } };
      if (cur.status !== 'pending_approval') {
        return { status: 409, body: { ok: false, error: 'not-waiting', message: `Only a partner waiting for approval can be approved (this one is ${cur.status}).` } };
      }
      const clash = fresh.find(o => o.id !== cur.id && o.kind === 'category' && o.category === cur.category && ['active', 'past_due', 'hidden'].includes(o.status));
      if (clash) {
        return { status: 409, body: { ok: false, error: 'category-taken', message: `${clash.business} already holds this category. Reject this one, or end theirs first.` } };
      }
      // The app's clock (reports count from this day), like paid_at.
      const next = { ...cur, status: 'active', approved_at: nowFn().toISOString(), approved_via: via };
      await save(next);
      return { status: 200, body: { ok: true, status: 'active' }, order: next };
    });
    if (out.order) {
      const o = out.order;
      const cat = categoryOf(o.category);
      if (slack) slack.notify({ channel: 'hype', title: `💰 New partner live: ${o.business}`, fields: [['Category', cat ? cat.label : o.category]], text: 'Approved: on the site and in the next issue.' });
      if (mailer && mailer.enabled) {
        const sent = await mailer.send(o.email, renderPartnerLive(o, { siteUrl, address: mailAddress, manageUrl: manageLink(o) }), `${town.keyPrefix}-partner-live-${o.id}`);
        if (sent) await recordReport(o, { live_email_sent: nowIso() });
      }
    }
    return out;
  }

  async function rejectPartner(id, { reason = '', via = 'admin' } = {}) {
    const claim = await withBookingLock(async () => {
      const cur = (await freshOrders()).find(o => o.id === id);
      if (!cur || cur.kind !== 'category') return { status: 404, body: { ok: false, error: 'not-found' } };
      if (cur.status === 'rejected') return { status: 200, body: { ok: true, status: 'rejected', already: true } };
      if (!['pending_approval', 'conflict'].includes(cur.status)) {
        return { status: 409, body: { ok: false, error: 'not-waiting', message: `Only a partner waiting for approval (or double-booked) can be rejected (this one is ${cur.status}). Hide it instead, or cancel it in Stripe.` } };
      }
      if (cur.rejecting && nowFn().getTime() - Date.parse(cur.rejecting) < 5 * 60 * 1000) {
        return { status: 409, body: { ok: false, error: 'in-progress', message: 'Already being rejected.' } };
      }
      // Marked first: the subscription.deleted webhook our cancel causes
      // must not treat it as the partner leaving (no "has ended" email).
      const marked = { ...cur, rejecting: nowIso() };
      await save(marked);
      return { order: marked };
    });
    if (!claim.order) return claim;
    const order = claim.order;
    const unmark = () => withBookingLock(async () => {
      const cur = (await freshOrders()).find(o => o.id === id);
      if (cur) await save({ ...cur, rejecting: null });
    });
    // 1. End the subscription now, so they're never charged again.
    if (order.subscription_id && typeof stripe.cancelSubscription === 'function') {
      try {
        await stripe.cancelSubscription(order.subscription_id);
      } catch (err) {
        // Already gone (they cancelled meanwhile) is fine; anything else
        // leaves it as it was, for the owner to retry or do in Stripe.
        if (!(err && err.status === 404) && !/canceled|no such subscription/i.test(String(err && err.message))) {
          await unmark();
          return { status: 502, body: { ok: false, error: 'stripe-cancel-failed', message: `Stripe didn't cancel the subscription (${err.message}). Nothing changed; try again, or cancel it in Stripe and then reject here.` } };
        }
      }
    }
    // 2. Refund what it charged: the first invoice's payment.
    let refund = { ok: false, error: '' };
    try {
      let target = order.payment_intent ? { payment_intent: order.payment_intent } : null;
      const inv = order.first_invoice || order.latest_invoice;
      if (!target && inv && typeof stripe.invoicePayment === 'function') target = await stripe.invoicePayment(inv);
      if (!target) throw new Error('no payment found for its invoice');
      if (typeof stripe.refund !== 'function') throw new Error('refunds unavailable');
      const r = await stripe.refund(target, `${town.keyPrefix}-partner-refund-${order.id}`);
      refund = { ok: true, id: (r && r.id) || null, ...target };
    } catch (err) {
      refund = { ok: false, error: String((err && err.message) || err).slice(0, 300) };
    }
    const why = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const done = await withBookingLock(async () => {
      const cur = (await freshOrders()).find(o => o.id === id) || order;
      const next = { ...cur, status: 'rejected', rejected_at: nowIso(), rejected_via: via, rejecting: null, hidden_from: null,
        refund: { ...refund, at: nowIso() }, ...(why ? { reject_reason: why } : {}) };
      await save(next);
      return next;
    });
    const cat = categoryOf(done.category);
    if (slack) {
      if (refund.ok) {
        slack.notify({ channel: 'sales', title: `✅ Partner rejected and refunded: ${done.business}`, fields: [['Category', cat ? cat.label : done.category], ['Contact', done.email]],
          text: 'Subscription cancelled and the payment refunded. The category is open again.' });
      } else {
        slack.alert(`partner-refund:${done.id}`, `Refund ${done.business} by hand: the partner refund didn't go through`,
          `Their subscription is cancelled, but Stripe refused the refund (${refund.error}). Refund their payment in Stripe. (The key needs Refunds and Invoices access for this to work on its own.)`,
          'https://dashboard.stripe.com/payments');
      }
    }
    if (mailer && mailer.enabled) {
      await mailer.send(done.email, renderPartnerRejected(done, { siteUrl, address: mailAddress, manageUrl: manageLink(done), reason: why, refunded: refund.ok }),
        `${town.keyPrefix}-partner-rejected-${done.id}`);
    }
    return { status: 200, body: { ok: true, status: 'rejected', refunded: refund.ok, ...(refund.ok ? {} : { refund_error: refund.error }) } };
  }

  // Admin edit of a category partner's card (they reply with changes):
  // the same checks as checkout. Under the booking lock.
  async function editPartner(id, input) {
    const cur = (await freshOrders()).find(o => o.id === id);
    if (!cur || cur.kind !== 'category') return { status: 404, body: { ok: false, error: 'not-found' } };
    const pp = cur.partner || {};
    const has = k => typeof input[k] === 'string';
    const errors = {};
    const business = has('business') ? clean(input.business, 80) : cur.business;
    if (!business) errors.business = 'Business name is required.';
    const line = has('line') ? clean(input.line, PARTNER_LINE_MAX) : pp.line;
    if (!line) errors.line = 'Add one short line about the business.';
    const cta = has('cta') ? (clean(input.cta, 24) || 'Visit') : (pp.cta || 'Visit');
    const url = has('url') ? safeUrl(normalizeUrl(clean(input.url, 300))) : pp.url;
    if (!url) errors.url = 'Enter a website or page (e.g. example.com).';
    let logo = null;
    if (has('logo_data') && input.logo_data) {
      logo = parseLogo(input.logo_data);
      if (logo.error) errors.logo = logo.error;
    }
    if (Object.keys(errors).length) return { status: 400, body: { ok: false, error: 'invalid', errors, message: Object.values(errors).join(' ') } };
    const partner = { ...pp, name: business, line, cta, url };
    if (logo && typeof store.saveSponsorLogo === 'function') {
      await store.saveSponsorLogo(cur.id, logo);
      partner.logo = `/sponsor-logo/${cur.id}`;
    }
    await save({ ...cur, business, partner });
    return null;
  }

  // The partners at a glance, for the admin and HQ: each category with who
  // holds it (or open), and the ones waiting for approval.
  async function partnerOverview() {
    const list = supported ? await freshOrders() : [];
    const nowMs = nowFn().getTime();
    const open = new Set(openCategories(list, o => isHold(o, nowMs)));
    const mine = list.filter(o => o.kind === 'category');
    const brief = o => ({ id: o.id, status: o.status, business: o.business, email: o.email, partner: o.partner || {}, amount: o.amount,
      paid_at: o.paid_at || null, approved_at: o.approved_at || null, cancel_at: o.cancel_at || null, test: Boolean(o.test) });
    return {
      categories: partnerCategories().map(c => {
        const holder = mine.find(o => o.category === c.id && takesCategory(o, x => isHold(x, nowMs)));
        return { id: c.id, label: c.label, emoji: c.emoji, pages: c.pages, open: open.has(c.id), holder: holder ? brief(holder) : null };
      }),
      waiting: mine.filter(o => o.status === 'pending_approval').map(o => ({ ...brief(o), category: o.category }))
    };
  }

  function registerRoutes(app, { requireAdmin, adminOrHq = null, createRateLimiter, sendHtml, verifyHuman = async () => true, formGuard = passiveGuard(verifyHuman), analyticsSecret = '' }) {
    const limiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 20 });

    // The weekly sponsor's button in our emails (server/newsletter.js
    // sponsorHref): count the click for the sponsor's report, then send the
    // reader to the sponsor with UTM tags. Recorded as a Traffic sponsor_click
    // (path /go/s/<week>) with the same daily visitor hash as the beacon.
    // Known bots and HEAD requests (link checkers) aren't counted.
    const goLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 30 });
    app.get('/go/s/:week', async (req, res, next) => {
      try {
        const week = /^\d{4}-\d{2}-\d{2}$/.test(req.params.week) ? req.params.week : '';
        const order = week ? (await orders()).find(o => o.kind === 'weekly' && o.week_start === week && LIVE.has(o.status)) : null;
        // src=social: the Facebook/Instagram captions (scripts/social_kit.py);
        // counted apart from email clicks (path /go/s/<week>/social).
        const src = ['welcome', 'social'].includes(req.query.src) ? req.query.src : 'newsletter';
        const target = order ? sponsorLandingUrl(order.sponsor && order.sponsor.url, { medium: src === 'social' ? 'social' : 'email', campaign: src }) : '';
        res.set('Cache-Control', 'no-store');
        if (!target) return res.redirect(302, siteUrl);
        const ip = req.ip || req.socket.remoteAddress || '';
        const ua = req.get('user-agent') || '';
        if (req.method === 'GET' && !botName(ua) && typeof store.recordTraffic === 'function' && goLimiter.check(ip).ok) {
          const day = localDateStr(nowFn());
          store.recordTraffic({
            day, kind: 'click', path: `/go/s/${week}${src === 'social' ? '/social' : ''}`, visitor: visitorHash(ip, ua, day, analyticsSecret),
            click_type: 'sponsor_click', click_url: String(order.sponsor.url || '').slice(0, 300)
          }).catch(err => console.warn('[sponsors] click record failed:', err.message));
        }
        res.redirect(302, target);
      } catch (err) { next(err); }
    });

    // A category partner's button, wherever it's shown (src: newsletter,
    // site = its category box, partners = /partners, social = the Facebook
    // thank-you, email): counted for its monthly report as a partner_click
    // at /go/p/<id>/<src>, then on to the partner with UTM tags. Only a live
    // partner redirects; anything else goes to /partners.
    app.get('/go/p/:id', async (req, res, next) => {
      try {
        const id = /^[A-Za-z0-9-]{8,64}$/.test(req.params.id) ? req.params.id : '';
        const order = id && partnersOn() ? (await orders()).find(o => o.id === id && o.kind === 'category' && o.status === 'active') : null;
        const src = PARTNER_SOURCES.includes(req.query.src) ? req.query.src : 'newsletter';
        const medium = src === 'social' ? 'social' : (src === 'newsletter' || src === 'email') ? 'email' : 'referral';
        const target = order ? sponsorLandingUrl(order.partner && order.partner.url, { medium, campaign: 'partner' }) : '';
        res.set('Cache-Control', 'no-store');
        if (!target) return res.redirect(302, `${siteUrl}/partners`);
        const ip = req.ip || req.socket.remoteAddress || '';
        const ua = req.get('user-agent') || '';
        if (req.method === 'GET' && !botName(ua) && typeof store.recordTraffic === 'function' && goLimiter.check(ip).ok) {
          const day = localDateStr(nowFn());
          store.recordTraffic({
            day, kind: 'click', path: `/go/p/${id}/${src}`, visitor: visitorHash(ip, ua, day, analyticsSecret),
            click_type: 'partner_click', click_url: String(order.partner.url || '').slice(0, 300), ad: id
          }).catch(err => console.warn('[sponsors] partner click record failed:', err.message));
        }
        res.redirect(302, target);
      } catch (err) { next(err); }
    });

    // The manage link in every partner email: a page with one button (a
    // POST, so mail scanners opening the link do nothing) that opens their
    // Stripe billing portal (update the card, see invoices, cancel). If the
    // portal isn't set up in Stripe yet, they're told to contact us and the
    // owner hears once.
    const manageLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 30 });
    const managePage = (title, lead, extra = '') => layout({ siteUrl, path: '/partners/manage', nav: '/partners', noindex: true, pixel: false,
      title: `${title} | ${town.siteName}`, description: title,
      body: `<h1 class="page-title">${escHtml(title)}</h1><p class="page-lead">${lead}</p>${extra}` });
    const manageOrder = async (o, t) => {
      if (!manageOk(manageSecret, String(o || ''), String(t || ''))) return null;
      return (await orders()).find(x => x.id === o && x.kind === 'category') || null;
    };
    app.get('/partners/manage', async (req, res, next) => {
      try {
        const order = await manageOrder(req.query.o, req.query.t);
        res.set('Referrer-Policy', 'no-referrer');
        if (!order) return sendHtml(res, managePage('Link not recognized', 'This manage link doesn’t look right. Use the link in your latest email from us, or <a href="/contact?topic=advertising">contact us</a>.'), 404, 'no-store');
        const cat = categoryOf(order.category);
        sendHtml(res, managePage('Manage your partnership',
          `${escHtml(order.business || 'Your business')}, our ${escHtml(cat ? cat.label.toLowerCase() : 'local')} partner. Update your card, see your invoices or cancel on Stripe’s secure billing page.`,
          `<form method="post" action="/partners/manage"><input type="hidden" name="o" value="${escHtml(order.id)}"><input type="hidden" name="t" value="${escHtml(String(req.query.t))}">` +
          '<button class="btn btn--primary" type="submit">Open my billing page</button></form>' +
          '<p>Want to change your line or link? <a href="/contact?topic=advertising">Send us a message</a> or reply to any of our emails.</p>'), 200, 'no-store');
      } catch (err) { next(err); }
    });
    app.post('/partners/manage', async (req, res, next) => {
      try {
        const body = req.body || {};
        if (!manageLimiter.check(req.ip || req.socket.remoteAddress).ok) return sendHtml(res, managePage('Slow down', 'Too many tries. Please wait a bit and try again.'), 429, 'no-store');
        const order = await manageOrder(body.o, body.t);
        if (!order) return sendHtml(res, managePage('Link not recognized', 'This manage link doesn’t look right. Use the link in your latest email from us, or <a href="/contact?topic=advertising">contact us</a>.'), 404, 'no-store');
        const sorry = managePage('Billing page unavailable', 'We couldn’t open your billing page just now. Nothing has changed with your partnership. Please <a href="/contact?topic=advertising">contact us</a> (or reply to any of our emails) and we’ll update your card or cancel for you.');
        if (!order.customer_id || typeof stripe.createPortalSession !== 'function') return sendHtml(res, sorry, 503, 'no-store');
        try {
          const portal = await stripe.createPortalSession(order.customer_id, `${siteUrl}/partners`);
          res.redirect(303, portal.url);
        } catch (err) {
          console.warn('[sponsors] billing portal failed:', err.message);
          if (slack) {
            slack.alert('stripe-portal', 'A partner couldn\'t open their billing page',
              `${order.business} (${order.email}) tried to manage their partnership. Stripe said: ${err.message}. Save the Customer portal settings once in Stripe (Settings → Billing → Customer portal), and give the Stripe key Billing portal write access. Meanwhile help them by hand.`,
              'https://dashboard.stripe.com/settings/billing/portal');
          }
          sendHtml(res, sorry, 503, 'no-store');
        }
      } catch (err) { next(err); }
    });

    app.get('/advertise/checkout', async (req, res, next) => {
      try {
        const pkg = packageFor(req.query.package);
        // A paused town (TOWN_DORMANT=1) sells nothing (seo.js renderAdvertisePage).
        if (!config.enabled || !pkg || town.dormant) return res.redirect(302, '/advertise');
        // Prefill from the query; only the form's own event fields are taken.
        // Contact details never ride in the URL (analytics and the Pixel see
        // page URLs): the submit form and its emails link with `from=<the
        // submission's id>` (a random UUID) and the server fills them in.
        // That id lives in forwardable emails, so the submitter's name and
        // email are only filled in while the submission is still waiting
        // for review and under a week old; the event fields (already public
        // once it's listed) always are. The page then drops the id from the
        // address bar (history.replaceState in renderCheckoutPage), and the
        // Pixel and Google tag leave it out of the URLs they report.
        // `category`: a partner invite's "claim this one" link.
        const PREFILL = ['event_name', 'date', 'time', 'end_time', 'venue', 'address', 'description', 'url', 'category'];
        let values = Object.fromEntries(PREFILL.filter(k => typeof req.query[k] === 'string').map(k => [k, req.query[k].slice(0, 2000)]));
        const from = typeof req.query.from === 'string' && /^[0-9a-f-]{36}$/i.test(req.query.from) ? req.query.from : '';
        const sub = from && typeof store.get === 'function' ? await store.get(from).catch(() => null) : null;
        if (sub && (sub.source || 'submission') === 'submission') {
          const p = sub.payload || {};
          const fresh = sub.status === 'pending' && nowFn().getTime() - Date.parse(sub.created_at) < PREFILL_CONTACT_MS;
          for (const [k, v] of [['event_name', p.name], ['date', p.date], ['time', p.time], ['end_time', p.end_time], ['venue', p.venue], ['address', p.address],
            ['description', p.description], ['url', p.url], ...(fresh ? [['business', sub.submitter_name], ['email', sub.submitter_email]] : [])]) {
            if (v) values[k] = String(v).slice(0, 2000);
          }
        }
        // Back from Stripe without paying (cancel_url): release their hold
        // so trying again isn't blocked by it, and refill the form.
        if (typeof req.query.cancelled === 'string' && req.query.cancelled) {
          const left = await withBookingLock(async () => {
            cache = null;
            const o = (await orders()).find(x => x.id === req.query.cancelled && x.status === 'pending');
            if (o) await save({ ...o, status: 'cancelled' });
            return o || null;
          });
          if (left) {
            await expireSession(left);
            values = { ...orderValues(left), ...values };
          }
        }
        sendHtml(res, renderCheckoutPage(pkg, { siteUrl, now: nowFn(), orders: await orders(), venues: getVenues(), values }), 200, 'no-store');
      } catch (err) { next(err); }
    });

    const previewLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 600 });
    app.post('/advertise/preview', async (req, res, next) => {
      try {
        const body = req.body || {};
        const pkg = packageFor(body.package);
        if (!pkg) return res.status(400).type('text/plain').send('Unknown package');
        if (!previewLimiter.check(req.ip || req.socket.remoteAddress).ok) return res.status(429).type('text/plain').send('Slow down');
        res.set('Cache-Control', 'no-store').type('html')
          .send(renderPreview(pkg.key, body, { now: nowFn(), orders: await orders(), venues: getVenues() }));
      } catch (err) { next(err); }
    });

    // Short cache, so a logo the admin removes (or a hidden or refunded
    // order's) stops showing within the hour.
    app.get('/sponsor-logo/:id', async (req, res, next) => {
      try {
        const path = `/sponsor-logo/${req.params.id}`;
        if (!LOGO_PATH.test(path) || typeof store.getSponsorLogo !== 'function') return res.status(404).end();
        const order = (await orders()).find(o => o.id === req.params.id);
        if (!logoServed(order, nowFn().getTime())) return res.status(404).end();
        const logo = await store.getSponsorLogo(req.params.id);
        if (!logo) return res.status(404).end();
        res.set({ 'Content-Type': logo.contentType, 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' })
          .send(Buffer.from(logo.data));
      } catch (err) { next(err); }
    });

    // Open Vic’s Pick spots and the price for a date (the checkout preview
    // and anyone wiring a calendar can use it).
    app.get('/api/vics-pick/availability', async (req, res, next) => {
      try {
        const date = String(req.query.date || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ ok: false, error: 'date=YYYY-MM-DD required' });
        res.set('Cache-Control', 'no-store').json({ ok: true, ...pickAvailability(date, await orders(), nowFn()) });
      } catch (err) { next(err); }
    });

    app.post('/advertise/checkout', async (req, res, next) => {
      try {
        const body = req.body || {};
        const pkg = packageFor(body.package);
        if (!config.enabled || !pkg || town.dormant) return res.redirect(303, '/advertise');
        const ctx = { siteUrl, now: nowFn(), orders: await orders(), venues: getVenues(), values: body };
        // Every turn-away counts toward "someone is stuck" (server/formGuard.js).
        const fail = (errors, status = 400) => {
          formGuard.rejected('checkout', req, Object.values(errors || {}));
          return sendHtml(res, renderCheckoutPage(pkg, { ...ctx, errors }), status, 'no-store');
        };
        if (honeypotTripped(body, 'sponsor checkout', { slack })) return res.redirect(303, '/advertise');
        const ip = req.ip || req.socket.remoteAddress;
        if (!limiter.check(ip).ok) return fail({ _form: 'Too many attempts. Try again in an hour.' }, 429);
        // A bot check that didn't pass doesn't stop a buyer: Stripe still
        // has to take their money, and the owner is alerted. Only a token
        // solved on another site (never one of our visitors) is refused.
        const human = await formGuard.botCheck('checkout', req, body['cf-turnstile-response'] || body.turnstile_token);
        if (!human.ok && human.error === 'hostname-mismatch') return fail({ _form: "We couldn't confirm you're not a bot. Please reload the page and try again." });
        const client = holdClient(ip, analyticsSecret);

        // Re-read and save the hold under one lock, so a week booked seconds
        // ago (or right now, by someone else) is caught.
        const booked = await withBookingLock(async () => {
          try {
            ctx.orders = await freshOrders();
          } catch (err) {
            console.warn('[sponsors] order list failed while booking:', err.message);
            return { errors: { _form: 'We couldn’t check what’s still available just now. Please try again in a minute.' }, status: 503 };
          }
          // A network address is shared by everyone behind it (a mobile
          // carrier, an office), so it may hold a few checkouts at once; past
          // that its oldest are released. An email holds one.
          const nowMs = nowFn().getTime();
          const clientHolds = ctx.orders.filter(x => x.client === client && isHold(x, nowMs))
            .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
          const dropping = new Set(clientHolds.slice(0, Math.max(0, clientHolds.length - (MAX_HOLDS_PER_CLIENT - 1))).map(x => x.id));
          const mine = x => dropping.has(x.id);
          const v = validateOrder(pkg.key, body, { ...ctx, orders: ctx.orders.filter(x => !mine(x)) });
          // The terms box is checked here, beside the fields, so one round
          // trip shows every problem. Not in validateOrder: admin edits use it.
          const accepted = agreed(body.agree);
          if (!v.ok || !accepted) return { errors: { ...(v.ok ? {} : v.errors), ...(accepted ? {} : { agree: AGREE_ERROR }) } };
          // Same clock as bookableWeeks, so the hold window lines up.
          const priced = pkg.key === 'featured' ? pickPackage(v.order.event.date) : pkg;
          const { logo, ...fields } = v.order;
          // terms_version / terms_accepted_at: the Advertising Terms the
          // buyer ticked the box for, and when (with `email`, the record of
          // who agreed). Kept in the order's payload (sponsor_orders is
          // JSONB in Postgres, the order object in the FileStore), so it
          // survives every later status change, which spreads the order.
          const at = nowFn().toISOString();
          const o = { ...fields, id: newId(), status: 'pending', amount: priced.amount, created_at: at, client,
            terms_version: ADVERTISING_TERMS_VERSION, terms_accepted_at: at };
          if (logo && typeof store.saveSponsorLogo === 'function') {
            await store.saveSponsorLogo(o.id, logo);
            if (o.kind === 'category') o.partner = { ...o.partner, logo: `/sponsor-logo/${o.id}` };
            else o.sponsor = { ...o.sponsor, logo: `/sponsor-logo/${o.id}` };
          }
          // The buyer's own earlier hold on this slot didn't count against
          // them (validateOrder); it's replaced, so one buyer can't hold two.
          // Any other open hold from this client or email goes too.
          const replaced = ctx.orders.filter(x => x.status === 'pending' && (
            (x.email === o.email && x.kind === o.kind &&
              (o.kind === 'weekly' ? x.week_start === o.week_start
                : o.kind === 'category' ? x.category === o.category
                  : x.event && o.event && x.event.date === o.event.date)) ||
            ((mine(x) || x.email === o.email) && isHold(x, nowMs))));
          for (const x of replaced) await save({ ...x, status: 'cancelled' });
          await save(o);
          return { order: o, replaced };
        });
        if (booked.errors) return fail(booked.errors, booked.status);
        for (const x of booked.replaced) await expireSession(x);
        const order = booked.order;
        // A Vic’s Pick's price depends on its day (weekday vs Fri–Sun).
        const priced = pkg.key === 'featured' ? pickPackage(order.event.date) : pkg;
        const inlineItem = {
          quantity: 1,
          price_data: {
            currency: 'usd', unit_amount: priced.amount,
            product_data: { name: `${town.siteName}: ${priced.name}` },
            recurring: pkg.interval ? { interval: pkg.interval } : undefined
          }
        };
        let lineItem = inlineItem;
        // Catalog price when we can get one; inline price_data otherwise, so
        // a catalog hiccup never blocks a sale.
        if (typeof stripe.ensurePrice === 'function') {
          try {
            lineItem = { quantity: 1, price: await stripe.ensurePrice(priced) };
          } catch (err) {
            console.warn('[sponsors] catalog price unavailable, using inline price:', err.message);
          }
        }
        const sessionParams = item => ({
          mode: pkg.interval ? 'subscription' : 'payment',
          // No payment_method_types: Stripe shows the methods enabled in
          // the Dashboard. Slower methods (bank debits) keep the week held
          // as "processing" until they settle; see the webhook. Within a
          // few days of the date, cards only (`instantOnly`): a bank debit
          // could settle after it.
          ...(!pkg.interval && instantOnly(order, nowFn()) ? { payment_method_types: ['card'] } : {}),
          integration_identifier: INTEGRATION_ID,
          customer_email: order.email,
          client_reference_id: order.id,
          line_items: [item],
          // metadata.town: one Stripe account serves every town, and each
          // town's webhook skips the others' sessions and subscriptions.
          metadata: { order_id: order.id, package: pkg.key, ...(order.category ? { category: order.category } : {}), terms_version: order.terms_version, terms_accepted_at: order.terms_accepted_at, ...townTag() },
          // A line by the pay button pointing back to the terms the buyer
          // just agreed to on our form. Only `submit`: Stripe's own terms
          // checkbox (consent_collection.terms_of_service, and with it
          // custom_text.terms_of_service_acceptance) refuses to create a
          // session unless a Terms of Service URL is set in each Stripe
          // account's Dashboard, which would break checkout for any town
          // that hasn't. custom_text.submit needs no Dashboard setting.
          custom_text: { submit: { message: `By paying you confirm the order and our [Advertising Terms](${siteUrl}/advertising-terms) (version ${order.terms_version}), including cancellations and refunds.` } },
          subscription_data: pkg.interval ? { metadata: { order_id: order.id, ...(order.category ? { category: order.category } : {}), ...townTag() } } : undefined,
          // One-time payments carry the town on the card statement too
          // (Checkout takes no descriptor for subscriptions; their invoices
          // show the account's own).
          payment_intent_data: pkg.interval ? undefined : {
            metadata: { order_id: order.id, ...townTag() },
            statement_descriptor_suffix: statementSuffix(town.siteName)
          },
          expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_TTL_S,
          success_url: `${siteUrl}/advertise/thanks?order=${order.id}`,
          cancel_url: `${siteUrl}/advertise/checkout?package=${pkg.key}&cancelled=${order.id}`
        });
        let session;
        try {
          try {
            session = await stripe.createCheckoutSession(sessionParams(lineItem), `${town.keyPrefix}-order-${order.id}`);
          } catch (err) {
            // The cached catalog price was archived (or its product) in the
            // Dashboard: every checkout failed until a restart. Forget it,
            // look it up again once, and use inline pricing if that gives
            // the same dead id. A new idempotency key, since the params
            // differ from the refused request's.
            if (!lineItem.price || !INACTIVE_PRICE.test(String(err && err.message))) throw err;
            console.warn('[sponsors] catalog price refused, looking it up again:', err.message);
            if (typeof stripe.forgetPrice === 'function') stripe.forgetPrice(priced);
            let retry = { quantity: 1, price_data: inlineItem.price_data };
            try {
              const again = await stripe.ensurePrice(priced);
              if (again && again !== lineItem.price) retry = { quantity: 1, price: again };
            } catch (e) { console.warn('[sponsors] catalog price lookup failed, using inline price:', e.message); }
            session = await stripe.createCheckoutSession(sessionParams(retry), `${town.keyPrefix}-order-${order.id}-retry`);
          }
        } catch (err) {
          console.error('[sponsors] checkout session failed:', err.message);
          if (slack) slack.alert('stripe-checkout', 'Sponsor checkout is failing', `Stripe: ${err.message}`);
          // Release the hold, from a fresh read under the booking lock: a
          // second submit may have cancelled it meanwhile.
          await withBookingLock(async () => {
            let cur = order;
            try { cur = (await freshOrders()).find(o => o.id === order.id) || order; } catch (_) { /* save what we have */ }
            if (cur.status === 'pending') await save({ ...cur, status: 'failed' });
          });
          await dropLogo(order);
          return fail({ _form: 'The payment page is unavailable right now. Please try again in a few minutes.' }, 502);
        }
        // Saved from a fresh read under the booking lock: a second submit
        // from another tab during the Stripe call may have cancelled this
        // hold (it had no session yet to expire). Spreading the copy read
        // before the call put it back to pending with an open session, so
        // both holds could be paid. Then this session is expired instead.
        const attached = await withBookingLock(async () => {
          let cur;
          try { cur = (await freshOrders()).find(o => o.id === order.id); } catch (err) {
            console.warn('[sponsors] order re-read failed after checkout:', err.message);
            return 'unread';
          }
          if (!cur || cur.status !== 'pending') return 'replaced';
          await save({ ...cur, session_id: session.id });
          return 'ok';
        });
        if (attached !== 'ok') {
          // The hold without a session lapses like any unpaid one.
          await expireSession({ session_id: session.id });
          return attached === 'unread'
            ? fail({ _form: 'We couldn’t check what’s still available just now. Please try again in a minute.' }, 503)
            : fail({ _form: 'This checkout was replaced by a newer one (another tab?). Please check your details and try again.' }, 409);
        }
        formGuard.ok('checkout', req);
        res.redirect(303, session.url);
      } catch (err) { next(err); }
    });

    app.get('/advertise/thanks', async (req, res, next) => {
      try {
        cache = null;
        const order = (await orders()).find(o => o.id === req.query.order) || null;
        sendHtml(res, renderThanksPage(order, { siteUrl, now: nowFn() }), 200, 'no-store');
      } catch (err) { next(err); }
    });

    // Through HQ too (the owner's assistant): the list, a report, and only
    // hide, restore and test marks; no edits, no logo removal.
    const gate = adminOrHq || requireAdmin;
    const paths = p => (adminOrHq ? hqPaths(p) : p);
    app.get(paths('/api/admin/sponsors'), gate, async (req, res, next) => {
      try {
        cache = null;
        // Read the store directly: orders() falls back to an empty list on a
        // database error, which would look like "no orders".
        const list = supported ? await store.listSponsorOrders() : [];
        cache = { at: Date.now(), list };
        // Live Vic's Picks for today or later: is the pin finding its event?
        // (on_site false: not approved yet, rejected, or edited past matching.)
        let onSite = () => undefined;
        if (getPayload) {
          try {
            const events = ((await getPayload()) || {}).events || [];
            const p = await pins(list);
            const today = localDateStr(nowFn());
            onSite = o => (o.kind === 'featured' && o.event && LIVE.has(o.status) && o.event.date >= today
              ? events.some(ev => pickMatches(o, ev, p)) : undefined);
          } catch (err) { console.warn('[sponsors] on-site check failed:', err.message); }
        }
        res.json({
          ok: true,
          configured: config.enabled,
          supported,
          orders: list.filter(o => o.status !== 'expired' && o.status !== 'failed' && !(o.status === 'cancelled' && !o.paid_at) &&
            !(o.status === 'pending' && nowFn().getTime() - Date.parse(o.created_at) > 24 * 3600 * 1000))
            .map(o => { const s = onSite(o); return s === undefined ? o : { ...o, on_site: s }; }),
          weeks: bookableWeeks(nowFn(), list),
          calendar: sponsorCalendar(nowFn(), list),
          // Category partners' categories, for their labels in the table.
          categories: partnerCategories().map(({ id, label, emoji }) => ({ id, label, emoji }))
        });
      } catch (err) { next(err); }
    });

    // The partners at a glance (each category: open, or who holds it; and
    // who's waiting for approval). HQ reads it too.
    app.get(paths('/api/admin/partners'), gate, async (req, res, next) => {
      try {
        res.json({ ok: true, ...(await partnerOverview()) });
      } catch (err) { next(err); }
    });

    // Live report numbers for a paid weekly or Vic's Pick order (the
    // Sponsors tab's Report button): what its email says, so far.
    app.get(paths('/api/admin/sponsors/:id/report'), gate, async (req, res, next) => {
      try {
        cache = null;
        const list = supported ? await store.listSponsorOrders() : [];
        const order = list.find(o => o.id === req.params.id);
        if (!order) return res.status(404).json({ ok: false, error: 'not-found' });
        const report = await orderReport(order, list);
        if (!report) return res.status(400).json({ ok: false, error: 'no-report', message: `Reports are for weekly sponsors and ${town.pickName}s.` });
        res.json({ ok: true, ...report, report_sent: order.report_sent || null });
      } catch (err) { next(err); }
    });

    // The uploaded logo, whatever the order's status, for the Sponsors tab.
    app.get('/api/admin/sponsors/:id/logo', requireAdmin, async (req, res, next) => {
      try {
        const logo = typeof store.getSponsorLogo === 'function' ? await store.getSponsorLogo(req.params.id) : null;
        if (!logo) return res.status(404).json({ ok: false, error: 'not-found' });
        res.set({ 'Content-Type': logo.contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
          .send(Buffer.from(logo.data));
      } catch (err) { next(err); }
    });

    // Mark test / not test: an order that wasn't real money (the owner's own
    // try-out), left out of the revenue goal; the placement itself is
    // untouched (Hide takes it off the site).
    // Hide pulls a placement (refund, bad copy); restore puts it back, unless
    // its day or week was sold meanwhile. Remove-logo deletes the uploaded
    // logo and keeps the rest of the placement. Edit changes a weekly
    // sponsor's wording, link, logo or week (sponsors are told to reply
    // with changes; a double-booked one can be moved to an open week).
    app.post(paths('/api/admin/sponsors/:id'), gate, async (req, res, next) => {
      try {
        const action = req.body && req.body.action;
        // approve/reject: a new category partner, which the owner decides on
        // (HQ asks him first, like every action it takes).
        if (viaHq(req) && !['hide', 'restore', 'mark-test', 'unmark-test', 'approve', 'reject'].includes(action)) return res.status(403).json({ ok: false, error: 'not-through-hq' });
        if (action === 'approve' || action === 'reject') {
          const via = viaHq(req) ? 'hq' : 'admin';
          const out = action === 'approve'
            ? await approvePartner(req.params.id, via)
            : await rejectPartner(req.params.id, { reason: (req.body && typeof req.body.reason === 'string') ? req.body.reason : '', via });
          return res.status(out.status).json(out.body);
        }
        cache = null;
        const list = supported ? await store.listSponsorOrders() : [];
        const order = list.find(o => o.id === req.params.id);
        if (!order) return res.status(404).json({ ok: false, error: 'not-found' });
        if (action === 'mark-test' || action === 'unmark-test') {
          const out = await withBookingLock(async () => {
            const cur = (await freshOrders()).find(o => o.id === order.id);
            if (!cur) return { status: 404, body: { ok: false, error: 'not-found' } };
            await save({ ...cur, test: action === 'mark-test' });
            return null;
          });
          if (out) return res.status(out.status).json(out.body);
        } else if (action === 'hide' || action === 'restore' || action === 'remove-logo') {
          // Under the booking lock and on a fresh read, like webhooks: a
          // refund or confirmation saved between the read above and this
          // save would otherwise be overwritten with the older copy.
          const out = await withBookingLock(async () => {
            const fresh = await freshOrders();
            const cur = fresh.find(o => o.id === order.id);
            if (!cur) return { status: 404, body: { ok: false, error: 'not-found' } };
            if (action === 'hide' && LIVE.has(cur.status)) {
              await save({ ...cur, status: 'hidden', hidden_from: cur.status });
            } else if (action === 'restore' && cur.status === 'hidden') {
              const status = cur.hidden_from || 'paid';
              const conflict = LIVE.has(status) ? restoreConflict(cur, fresh, nowFn()) : '';
              if (conflict) return { status: 409, body: { ok: false, error: 'slot-taken', message: conflict } };
              await save({ ...cur, status, hidden_from: null });
            } else if (action === 'remove-logo' && cur.sponsor && cur.sponsor.logo) {
              if (typeof store.deleteSponsorLogo === 'function') await store.deleteSponsorLogo(cur.id);
              const { logo: _gone, ...sponsor } = cur.sponsor;
              await save({ ...cur, sponsor });
            } else if (action === 'remove-logo' && cur.partner && cur.partner.logo) {
              if (typeof store.deleteSponsorLogo === 'function') await store.deleteSponsorLogo(cur.id);
              const { logo: _gone, ...partner } = cur.partner;
              await save({ ...cur, partner });
            } else {
              return { status: 400, body: { ok: false, error: 'bad-action' } };
            }
            return null;
          });
          if (out) return res.status(out.status).json(out.body);
        } else if (action === 'edit' && order.kind === 'category' && ['pending_approval', 'active', 'hidden', 'past_due'].includes(order.status)) {
          const out = await withBookingLock(() => editPartner(order.id, req.body || {}));
          if (out) return res.status(out.status).json(out.body);
        } else if (action === 'edit' && order.kind === 'weekly' && EDITABLE.has(order.status)) {
          const out = await withBookingLock(() => editWeekly(order, req.body || {}));
          if (out.errors) return res.status(400).json({ ok: false, error: 'invalid', errors: out.errors, message: Object.values(out.errors).join(' ') });
          // A double-booked sponsor's first confirmation, sent after the
          // edit's lock is released (sendConfirmation records it under one).
          if (out.moved) await sendConfirmation(out.order);
        } else {
          return res.status(400).json({ ok: false, error: 'bad-action' });
        }
        res.json({ ok: true });
      } catch (err) { next(err); }
    });
  }

  return { apply, orders, registerWebhook, registerRoutes, processEvent, sendSponsorReports, sendPickReports, approvePartner, rejectPartner, partnerOverview };
}
