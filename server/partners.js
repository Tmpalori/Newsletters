/* server/partners.js — category partners: one local business per category.
 *
 * A business claims a category (Food & drink, Dental…) for a town and pays
 * monthly (a Stripe subscription; server/sponsors.js kind 'category'). The
 * owner approves every new partner before it shows anywhere. While active,
 * a partner is shown:
 *   - in every newsletter issue ("Our local partners", server/newsletter.js)
 *   - on its category's pages (a partner box near the top; partnerBoxHtml)
 *   - on /partners (renderPartnersPage)
 *   - in a monthly Facebook thank-you (scripts/social_kit.py, from
 *     /events.json's `partners`)
 * Open categories show small invites instead. Prices never appear here:
 * only /advertise and its checkout name the money (the owner's rule).
 *
 * Order statuses (kind 'category'):
 *   pending           checkout open (held HOLD_MS, like a sponsor week)
 *   processing        a bank debit settling
 *   pending_approval  paid, subscription running, waiting for the owner's OK
 *   active            live on the site and in the newsletter
 *   past_due          Stripe can't charge them: hidden until it can
 *   hidden            hidden by the owner (Restore puts it back)
 *   rejected          the owner said no: subscription cancelled, refunded
 *   canceled          the subscription ended (they cancelled, or Stripe gave up)
 *   conflict          paid for a category someone else had meanwhile
 * Rejected and canceled are final: nothing brings them back on its own.
 *
 * Everything here is pure (orders in, HTML or data out); the Stripe and
 * webhook side lives in server/sponsors.js.
 */

import crypto from 'node:crypto';
import { town } from './town.js';
import { escHtml, HUB_PAGES, adAttr, isSponsorLogo, layout, breadcrumbLd } from './seo.js';

// The town's categories, each with only the pages this site has.
export function partnerCategories() {
  const paths = new Set(HUB_PAGES.map(p => p.path));
  return (town.business.partnerCategories || []).map(c => ({ ...c, pages: (c.pages || []).filter(p => paths.has(p)) }));
}
export const categoryOf = id => partnerCategories().find(c => c.id === id) || null;
export const categoriesForPage = path => partnerCategories().filter(c => c.pages.includes(path));

// Partners are a town's while it's running; a paused one (TOWN_DORMANT=1)
// shows none of this and sells nothing.
export const partnersOn = () => !town.dormant;

// Orders that keep a category taken: everything that hasn't ended. A
// checkout being paid holds it like a sponsor week (`held` tells, since
// the hold window lives in sponsors.js); `email`'s own hold doesn't count
// against them.
const TAKEN = new Set(['processing', 'pending_approval', 'active', 'past_due', 'hidden', 'disputed']);
export function takesCategory(o, held = () => false, email = '') {
  if (!o || o.kind !== 'category') return false;
  if (o.status === 'pending') return held(o) && !(email && o.email === email);
  return TAKEN.has(o.status);
}

export function openCategories(orders, held, email = '') {
  const taken = new Set((orders || []).filter(o => takesCategory(o, held, email)).map(o => o.category));
  return partnerCategories().filter(c => !taken.has(c.id)).map(c => c.id);
}

// What a page or email may show of a live partner: never the email,
// amount or Stripe ids, and never the raw link (clicks go through
// /go/p/<id>, which counts them for the partner's report).
export function publicPartner(o) {
  const c = categoryOf(o.category);
  const p = o.partner || {};
  return {
    id: o.id, category: o.category, label: c ? c.label : o.category, emoji: c ? c.emoji : '',
    name: p.name || o.business || '', line: p.line || '', cta: p.cta || 'Visit',
    ...(isSponsorLogo(p.logo) ? { logo: p.logo } : {})
  };
}

// { active: [...public partners, in category order], open: [category ids] },
// or null when nothing about partners has happened yet (no category order
// at all): readers then treat every category as open (partnerState), and
// /events.json stays as it was before partners.
export function partnersPayload(orders, held) {
  const mine = (orders || []).filter(o => o && o.kind === 'category');
  if (!mine.length || !partnersOn()) return null;
  const order = new Map(partnerCategories().map((c, i) => [c.id, i]));
  const active = mine.filter(o => o.status === 'active' && order.has(o.category))
    .sort((a, b) => order.get(a.category) - order.get(b.category) || String(a.approved_at || '').localeCompare(String(b.approved_at || '')));
  // One per category, even if a mistake let two through.
  const seen = new Set();
  const live = active.filter(o => !seen.has(o.category) && seen.add(o.category)).map(publicPartner);
  return { active: live, open: openCategories(orders, held) };
}

// The partners part of a public payload, or null for a paused town.
export function partnerState(payload) {
  if (!partnersOn()) return null;
  const p = payload && payload.partners;
  if (p && Array.isArray(p.active) && Array.isArray(p.open)) return p;
  return { active: [], open: partnerCategories().map(c => c.id) };
}

// The partner's own link through our counter: src says where it was tapped.
export const partnerHref = (siteUrl, id, src) => `${siteUrl}/go/p/${encodeURIComponent(id)}?src=${src}`;
export const PARTNER_SOURCES = ['newsletter', 'site', 'partners', 'social', 'email'];

// "What you get", as [bold, rest]. Every line must stay true: the
// newsletter section (newsletter.js partnersEmailHtml), the category boxes
// (partnerBoxHtml), /partners, the monthly Facebook thank-you
// (social_kit.py thanks_lines), the one-per-category check (takesCategory)
// and the monthly report (sponsors.js runPartnerReports). No Instagram
// until a town posts there.
export function partnerPoints(here = 'Our partners page') {
  return [
    ['Every issue', 'in Our local partners, Monday and Thursday'],
    ["Your category's pages", 'a partner box on matching event pages'],
    [here, "listed as the town's pick for your category"],
    ['A monthly Facebook thank-you', 'with your link'],
    ['No competitors', "your category is yours while you're a partner"],
    ['A monthly results report', 'views and clicks']
  ];
}

const checklist = points => `<div class="ad-checklist-wrap"><p class="ad-checklist-title">What you get</p><ul class="ad-checklist" role="list">${points.map(([b, rest]) =>
  `<li><span class="ad-check" aria-hidden="true">✓</span><span><strong>${escHtml(b)}</strong>${rest ? ` <span class="ad-check-rest">${escHtml(rest)}</span>` : ''}</span></li>`).join('')}</ul></div>`;

const catLabel = c => `${c.emoji ? `${escHtml(c.emoji)} ` : ''}${escHtml(c.label)}`;

// ─── Category pages ──────────────────────────────────────────────────────

// The box near the top of a category page: the live partner in the
// sponsor-box style (light blue), or, while the category is open, a small
// dashed invite. Nothing while it's taken but not live yet (waiting for
// approval, a payment issue): the spot isn't for sale then.
export function partnerBoxHtml(path, state, siteUrl = '') {
  if (!state) return '';
  return categoriesForPage(path).map(c => {
    const p = state.active.find(x => x.category === c.id);
    if (p) return partnerBlock(p, c, partnerHref(siteUrl, p.id, 'site'));
    if (!state.open.includes(c.id)) return '';
    return `<section class="partner-section"><a class="partner-invite" href="/advertise#partner">` +
      `<span><strong class="partner-invite__q">Own ${escHtml(c.owner)}?</strong><span class="partner-invite__a">Be our ${escHtml(c.label.toLowerCase())} partner. One spot, all yours.</span></span>` +
      '<span class="partner-invite__more">Learn more →</span></a></section>';
  }).join('');
}

// The partner box itself (also the checkout preview): sponsor-block markup,
// so the checkout's logo preview script finds it, tagged data-ad for its
// view count.
export function partnerBlock(p, c = categoryOf(p.category), href = '#') {
  const label = c ? `${c.emoji ? `${escHtml(c.emoji)} ` : ''}Our ${escHtml(c.label.toLowerCase())} partner` : 'Our local partner';
  const logo = isSponsorLogo(p.logo) ? `<img class="sponsor-logo" src="${escHtml(p.logo)}" alt="${escHtml(p.name)} logo" loading="lazy">` : '';
  return `<section class="partner-section"><div class="sponsor-block partner-box"${adAttr(p.id)}>` +
    `<div class="sponsor-label">${label}</div>${logo}` +
    `<div class="sponsor-name">${escHtml(p.name)}</div>` +
    (p.line ? `<div class="sponsor-text">${escHtml(p.line)}</div>` : '') +
    `<a href="${escHtml(href)}" class="btn btn--outline partner-cta" target="_blank" rel="sponsored noopener">${escHtml(p.cta || 'Visit')}</a>` +
    '</div></section>';
}

// ─── /partners ───────────────────────────────────────────────────────────

function slotsHtml(ids) {
  return `<div class="partner-slots">${ids.map(categoryOf).filter(Boolean).map(c =>
    `<div class="partner-slot"><span>${catLabel(c)}</span><span class="partner-open">Open</span></div>`).join('')}</div>`;
}

export function partnerCardHtml(p, siteUrl = '') {
  const c = categoryOf(p.category);
  const logo = isSponsorLogo(p.logo) ? `<img class="partner-card__logo" src="${escHtml(p.logo)}" alt="${escHtml(p.name)} logo" loading="lazy">` : '';
  return `<article class="partner-card"${adAttr(p.id)}>` +
    `<p class="partner-card__cat">${c ? catLabel(c) : escHtml(p.label || '')}</p>${logo}` +
    `<h2 class="partner-card__name">${escHtml(p.name)}</h2>` +
    (p.line ? `<p class="partner-card__line">${escHtml(p.line)}</p>` : '') +
    `<a class="partner-card__link" href="${escHtml(partnerHref(siteUrl, p.id, 'partners'))}" target="_blank" rel="sponsored noopener">Visit →</a></article>`;
}

export function renderPartnersPage({ siteUrl, state }) {
  const s = state || { active: [], open: [] };
  const cta = '<div class="ad-cta"><a class="btn ad-buy" href="/advertise#partner">See partner details →</a>' +
    '<span class="ad-cta-note">Pricing and sign-up are on our Advertise page</span></div>';
  const openLine = s.open.length === partnerCategories().length
    ? `All ${s.open.length} categories are open` : s.open.length ? 'Open categories' : '';
  const slots = s.open.length
    ? `<p class="ad-checklist-title partner-open-title">${escHtml(openLine)}</p>${slotsHtml(s.open)}`
    : '<p class="partner-open-title">Every category is taken right now. <a href="/contact?topic=advertising">Ask us</a> to hear when one opens.</p>';
  let body;
  if (!s.active.length) {
    body = `
    <h1 class="page-title">Our local partners</h1>
    <p class="page-lead">We're looking for our first local partners: one business per category that we'd happily send our readers to.</p>
    <section class="ad-package ad-package--row partner-join"><div class="ad-package__info">
      <div class="ad-package__head"><h2>Founding partner</h2><p class="ad-limit">One business per category. Cancel anytime.</p></div>
      ${checklist([['Every issue', 'Monday and Thursday'], ["Your category's pages", 'on the site'], ['No competitors', 'your category is yours'], ['A monthly results report', 'views and clicks']])}
      ${slots}
      ${cta}
    </div></section>`;
  } else {
    body = `
    <h1 class="page-title">Our local partners</h1>
    <p class="page-lead">The local businesses that keep ${escHtml(town.siteName)} free for everyone in ${escHtml(town.city)}. One partner per category, so when you need a roofer or a dentist, these are the folks we'd send you to.</p>
    <div class="partner-cards">${s.active.map(p => partnerCardHtml(p, siteUrl)).join('')}</div>
    <h2 class="section-heading">Become a partner</h2>
    <section class="ad-package ad-package--row partner-join"><div class="ad-package__info">
      <div class="ad-package__head"><h2>Category partner</h2><p class="ad-limit">One business per category. Cancel anytime.</p></div>
      ${checklist(partnerPoints('This page'))}
      ${slots}
      ${cta}
    </div></section>`;
  }
  return layout({
    siteUrl, path: '/partners',
    title: `Our local partners | ${town.siteName}`,
    description: `The local businesses that partner with ${town.siteName} in ${town.cityState}, one per category.`,
    body,
    ld: [breadcrumbLd(siteUrl, [{ name: town.siteName, path: '/' }, { name: 'Our local partners', path: '/partners' }])]
  });
}

// ─── HQ ──────────────────────────────────────────────────────────────────

// For the HQ summary (server/hq.js): live partners, those waiting for the
// owner's OK, the categories still open, and what the live ones bill a
// month. Test orders don't count.
export function partnerSummary(orders, held = () => false) {
  const mine = (orders || []).filter(o => o && o.kind === 'category' && !o.test);
  const active = mine.filter(o => o.status === 'active');
  return {
    active: active.length,
    pending: mine.filter(o => o.status === 'pending_approval').length,
    open_categories: openCategories(orders, held),
    monthly_cents: active.reduce((n, o) => n + (Number(o.amount) || 0), 0)
  };
}

// ─── The partner's manage link ───────────────────────────────────────────
// Every partner email carries /partners/manage?o=<order>&t=<token>, which
// opens their Stripe billing portal (update the card, cancel). The token is
// an HMAC of the town and order, so a link can't be made for someone else's
// order; it never expires (an old email still works).
export function manageToken(secret, orderId) {
  return crypto.createHmac('sha256', String(secret || '')).update(`partner-manage|${town.id}|${orderId}`).digest('base64url').slice(0, 32);
}
export function manageOk(secret, orderId, token) {
  if (!secret || !orderId || typeof token !== 'string') return false;
  const a = Buffer.from(manageToken(secret, orderId));
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export const manageUrl = (siteUrl, secret, orderId) => `${siteUrl}/partners/manage?o=${encodeURIComponent(orderId)}&t=${manageToken(secret, orderId)}`;
