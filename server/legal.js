/* server/legal.js — Who runs the site, and the pages that say so.
 *
 *   - The business identity the legal pages print: the operator's legal
 *     name (BUSINESS_LEGAL_NAME), a contact email for legal and privacy
 *     requests (BUSINESS_CONTACT_EMAIL, else NEWSLETTER_REPLY_TO, else the
 *     town's own news@ address) and the mailing address the newsletter
 *     already requires (NEWSLETTER_ADDRESS). They're Railway variables, per
 *     town service, read once by createApp (useBusiness). Until the legal
 *     name is set the pages name the site itself ("The Vic 361") as the
 *     operator, never an empty or placeholder string; a missing address is
 *     left out.
 *   - The version of each page (a date string), exported from here so
 *     checkout records which Advertising Terms the buyer agreed to
 *     (server/sponsors.js) and the pages print the same "Last updated".
 *     Change a page's wording that changes what someone agrees to: bump its
 *     version.
 *   - The pages: /privacy, /terms, /advertising-terms (with the refund and
 *     cancellation policy at #refunds; /refunds redirects there) and
 *     /accessibility, in the site's layout and localized through `town`
 *     like every other page (no literal place or site names here).
 *
 * Every promise on these pages must match what the code does. When the
 * booking, refund, review or retention behavior changes, change the page
 * (and its version) in the same PR.
 */
import { town } from './town.js';
import { layout, escHtml, AD_PACKAGES, CANCEL_NOTICE_DAYS } from './seo.js';

// ─── Versions ────────────────────────────────────────────────────────────
// YYYY-MM-DD of the wording in force. ADVERTISING_TERMS_VERSION is stored on
// every sponsor order (terms_version) and sent to Stripe as metadata.
export const ADVERTISING_TERMS_VERSION = '2026-10-17';
export const TERMS_VERSION = '2026-10-10';
export const PRIVACY_VERSION = '2026-10-18';
export const ACCESSIBILITY_VERSION = '2026-10-10';
export const REFERRAL_RULES_VERSION = '2026-10-10';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// "2026-10-10" → "October 10, 2026".
export function versionDate(v) {
  const [y, m, d] = String(v).split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

// The cancellation window (CANCEL_NOTICE_DAYS) lives in seo.js beside the
// advertise FAQ that states it too.
export { CANCEL_NOTICE_DAYS };
// The booking rules the page states, as server/sponsors.js enforces them
// (WEEKS_AHEAD, FEATURE_DAYS_AHEAD, HOLD_MS, INSTANT_ONLY_DAYS; the test
// checks they match). Copied, not imported: sponsors.js imports this file.
export const BOOKING = { weeksAhead: 8, pickDaysAhead: 120, holdMinutes: 35, cardsOnlyDays: 10 };

// ─── Business identity ───────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@<>"',;]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
// "Name <a@b.com>" or "a@b.com" → "a@b.com", or '' when it isn't one.
function bareEmail(raw) {
  const s = String(raw || '').trim();
  const m = /<([^<>]+)>\s*$/.exec(s);
  const e = (m ? m[1] : s).trim();
  return EMAIL_RE.test(e) && e.length <= 254 ? e : '';
}
// A printable one-line value: no control characters, no runs of spaces.
const oneLine = (v, max) => String(v || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export function businessConfig(env = process.env, overrides = {}) {
  return {
    legalName: oneLine(overrides.businessLegalName ?? env.BUSINESS_LEGAL_NAME, 120),
    contactEmail: bareEmail(overrides.businessContactEmail ?? env.BUSINESS_CONTACT_EMAIL),
    replyTo: bareEmail(overrides.newsletterReplyTo ?? env.NEWSLETTER_REPLY_TO),
    address: oneLine(overrides.newsletterAddress ?? env.NEWSLETTER_ADDRESS, 200)
  };
}

let business = businessConfig({});
export function useBusiness(cfg) { business = { ...businessConfig({}), ...(cfg || {}) }; }

// Who runs the site: the legal name once it's set, else the site's name.
export function operatorName() { return business.legalName || town.siteName; }
export function hasLegalName() { return Boolean(business.legalName); }
// Where legal, privacy, refund and accessibility requests go.
export function contactEmail() {
  return business.contactEmail || business.replyTo || bareEmail(town.emailFrom) || `news@${town.domain}`;
}
export function hasContactEmail() { return Boolean(business.contactEmail); }
export function mailingAddress() { return business.address; }

// The operator's name, escaped (a legal name may hold "&").
export function operatorHtml() { return escHtml(operatorName()); }
// The opening sentence of each page: "The Vic 361 is run by Acme Media
// LLC." once the legal name is set; until then the site is named as the
// one running it, never a blank.
export function operatorSentence() {
  return business.legalName && business.legalName !== town.siteName
    ? `${town.siteName} is run by ${operatorHtml()}.`
    : `${town.siteName} runs ${town.domain} and its newsletter.`;
}
export function emailLink(subject = '') {
  const e = contactEmail();
  return `<a href="mailto:${escHtml(e)}${subject ? `?subject=${encodeURIComponent(subject)}` : ''}">${escHtml(e)}</a>`;
}
// The block at the end of each page: name, address (when set), email.
export function contactBlockHtml() {
  const addr = mailingAddress();
  return `<p class="legal-contact"><strong>${escHtml(operatorName())}</strong>${business.legalName && business.legalName !== town.siteName ? ` (${town.siteName})` : ''}<br>` +
    (addr ? `${escHtml(addr)}<br>` : '') +
    `Email: ${emailLink()}<br>Or use our <a href="/contact">contact form</a>.</p>`;
}

function updatedLine(version) {
  return `<p class="legal-version">Last updated ${versionDate(version)} · Version ${version}</p>`;
}

const section = (id, title, html) => `<h2 class="section-heading"${id ? ` id="${id}"` : ''}>${title}</h2>\n${html}`;
const ul = items => `<ul>\n${items.filter(Boolean).map(i => `      <li>${i}</li>`).join('\n')}\n    </ul>`;
// Clauses Texas law wants conspicuous (indemnity, limits of liability).
const loud = html => `<p class="legal-loud"><strong>${html}</strong></p>`;

// ─── /privacy ────────────────────────────────────────────────────────────
// Plain-language privacy notice. Meta's Business Tools terms require one
// once the Pixel runs; Google's, Stripe's and the app stores' too. Google
// Analytics is described only for a town that has a GA ID (town.gaId):
// another town's pages carry no Google tag until it gets one.
export function renderPrivacyPage({ siteUrl }) {
  const ga = Boolean(town.gaId);
  const body = `
    <h1 class="page-title">Privacy</h1>
    <p class="page-lead">${town.siteName} is a free events guide for ${town.cityStateLong}. This page explains what we collect, why, how long we keep it, and the choices you have.</p>
    ${updatedLine(PRIVACY_VERSION)}
    ${section('who', 'Who we are', `<p>${operatorSentence()} In this policy "we" and "us" mean ${escHtml(operatorName())}. Questions or requests about your information: email ${emailLink('Privacy request')}.</p>`)}
    ${section('collect', 'What you give us', ul([
      '<strong>Newsletter:</strong> your email address, so we can send the newsletter (Mondays and Thursdays), and, if you joined through a friend\'s share link, which link it was. Every email has a one-click unsubscribe link. We don\'t sell or rent your address, and sponsors never get it.',
      '<strong>Event submissions:</strong> the event details plus your name, email address and phone number, used to review the event, ask you about it if a detail needs checking, email you when it\'s live, and tell you if it doesn\'t make its day\'s list on a busy day (with how to guarantee it a spot). We also store the IP address and browser details (user agent) the submission came from, to stop spam and abuse of the form.',
      '<strong>Contact messages:</strong> your name, email address and message, used to answer you.',
      '<strong>Sponsor purchases:</strong> payments are handled by Stripe; we never see your card number. We keep your name or business, email, the ad or event details and logo you send, the order, and which version of our <a href="/advertising-terms">advertising terms</a> you agreed to and when.'
    ]))}
    ${section('public', 'Public event information', `<p>Most listings come from public sources: venue and organizer websites, public calendars, and public Facebook and Instagram pages of venues and organizations. We gather them with automated tools (including Apify for public social media pages, and OpenAI and Google Gemini to read event details and write short summaries). We collect event details (what, when, where, price), not information about individual people. If you organize an event and want a listing changed or removed, email ${emailLink('Event listing')}.</p>`)}
    ${section('measure', 'What we measure', ul([
      '<strong>Our own visit counts:</strong> which pages are viewed and which links are clicked, so we know what\'s useful and can report to sponsors how often their placement was seen. We don\'t use cookies for this, and this counter doesn\'t keep your IP address; a visitor is a one-way code that changes every day.',
      '<strong>Referrals:</strong> every subscriber gets a share link. When someone signs up through it, we note who shared it so we can count referrals and send rewards; we don\'t tell the person who shared it who signed up. Gift card rewards are sent by our rewards partner, <a href="https://www.tremendous.com/privacy" rel="noopener">Tremendous</a>, which gets the winner\'s email address to deliver them (see the <a href="/referral-rules">rules</a>).',
      '<strong>Newsletter opens:</strong> each newsletter has a tiny invisible image, so we can tell whether you opened that issue (we count each person once per issue), and links back to the site are tagged with the issue they came from. Turning off images in your email app stops the open count.',
      ga ? '<strong>Google Analytics</strong> measures visits to the site and uses cookies. See <a href="https://policies.google.com/technologies/partner-sites" rel="noopener">how Google uses this data</a>, or use Google\'s <a href="https://tools.google.com/dlpage/gaoptout" rel="noopener">opt-out add-on</a>.' : '',
      '<strong>Meta Pixel:</strong> when we advertise on Facebook and Instagram, the Meta Pixel tells Meta that someone visited from an ad or signed up for the newsletter, so we can see whether our ads work and show them to people likely to be interested. Meta may combine this with what it knows about your Meta account. It\'s never loaded on the newsletter confirm or unsubscribe pages. You can control this in your <a href="https://www.facebook.com/adpreferences/ad_settings" rel="noopener">Meta ad settings</a>, or through the <a href="https://optout.aboutads.info/" rel="noopener">DAA</a> and <a href="https://optout.networkadvertising.org/" rel="noopener">NAI</a> opt-out pages.',
      '<strong>Global Privacy Control:</strong> if your browser sends a Global Privacy Control signal, we treat it as a request to opt out of targeted advertising and don\'t load the Meta Pixel.'
    ]))}
    ${section('services', 'Services we use', `<p>Each of these only gets what it needs to do its job:</p>
    ${ul([
      'Railway hosts the site and its database.',
      'Resend delivers our emails.',
      'Stripe takes sponsor payments.',
      'Cloudflare Turnstile checks that forms are sent by people, not bots; it looks at your browser and device to do that.',
      'Google Fonts serves the site\'s and the emails\' fonts, so Google sees your IP address when they load.',
      'OpenAI reviews submitted events (the event details, not your contact details) before they\'re published.',
      'Slack: contact messages (with the sender\'s email), new submissions and sponsor orders (with the business name and email) are relayed to our staff\'s Slack so we can respond quickly.',
      'Tremendous delivers referral gift cards.',
      ga ? 'Google Analytics and the Meta Pixel, as described above.' : 'The Meta Pixel, as described above.'
    ])}
    <p>We may also share information if the law requires it, or with a buyer if the business is ever sold. We don't sell your personal information.</p>`)}
    ${section('retention', 'How long we keep it', ul([
      'Subscribers: while you\'re subscribed. After you unsubscribe we keep your address only so we never email you again.',
      'Event submissions: the IP address and browser details stored with a submission are deleted after 12 months. The event itself stays on the site while it\'s listed and in our archive after that.',
      'Contact messages: deleted after 24 months.',
      'Our own visit counts and newsletter open records: about 13 months.',
      'Sponsor orders: kept as business and tax records (up to 7 years).'
    ]))}
    ${section('choices', 'Your choices', ul([
      'Unsubscribe from any newsletter with the link at the bottom, any time.',
      'Block or delete cookies in your browser settings; the site works without them.',
      `Ask us what we have about you, or ask us to correct or delete it, by emailing ${emailLink('Privacy request')}. We'll remove what you ask us to delete within 30 days (except what we must keep by law, such as payment records), and we'll tell you when it's done. We honor these requests wherever you live, and won't treat you differently for making one.`
    ]))}
    ${section('children', 'Children', `<p>${town.siteName} is a general events guide and isn't directed to children under 13. We don't knowingly collect information from children under 13; if you think a child has sent us information, email ${emailLink('Privacy request')} and we'll delete it. Event submissions and referral rewards are for adults (18 or older).</p>`)}
    ${section('security', 'Security', '<p>The site uses encrypted connections (HTTPS), only our staff can reach the admin, and we never see or store card numbers. No system is perfect; if a breach affects your information we\'ll tell you as the law requires.</p>')}
    ${section('changes', 'Changes and contact', `<p>When this policy changes we update the date at the top, and we tell subscribers about important changes in the newsletter.</p>
    ${contactBlockHtml()}`)}`;
  return layout({
    siteUrl, path: '/privacy',
    title: `Privacy | ${town.siteName}`,
    description: `What ${town.siteName} collects, why, how long we keep it, and the choices you have.`,
    body
  });
}

// ─── /terms ──────────────────────────────────────────────────────────────

export function renderTermsPage({ siteUrl }) {
  const op = escHtml(operatorName());
  const body = `
    <h1 class="page-title">Terms of use</h1>
    <p class="page-lead">The rules for using ${town.siteName}, its newsletter and its forms, in plain English.</p>
    ${updatedLine(TERMS_VERSION)}
    ${section('intro', 'Who we are', `<p>${operatorSentence()} "We" and "us" mean ${op}. By using the site or subscribing, you agree to these terms and to our <a href="/privacy">privacy policy</a>. Buying an ad or a ${town.pickName} is covered by our separate <a href="/advertising-terms">advertising terms</a>.</p>`)}
    ${section('who-can', 'Who can use it', `<p>The site is for a general audience. You need to be at least 13 to subscribe to the newsletter. Event submissions and referral rewards are for adults: 18 or older, or the age of majority in your state if that's higher.</p>`)}
    ${section('accuracy', 'Event information can be wrong', `<p>Listings come from public sources (venue and organizer pages, public social media pages, public calendars and web searches) and from people who submit them, and we gather and summarize many of them with automated tools, including AI. <strong>Details change and can be wrong, so always check with the organizer before you go.</strong> We don't organize, run or endorse the events we list, and we aren't responsible for events, venues, tickets or other websites we link to.</p>`)}
    ${section('paid', 'Paid placements', `<p>Some content is paid for. The weekly sponsor is labeled "This week's sponsor", and a paid ${town.pickName} is marked "#ad" at the end of its description (in the newsletter and on social media too). ${town.pickName}s without that mark are our editors' picks, which nobody pays for.</p>`)}
    ${section('submissions', 'What you submit', ul([
      'When you submit an event (text, flyers, images), you give us a non-exclusive, worldwide, royalty-free license to host, copy, edit for format and length, display and share it on our site, in our newsletters and on our social media accounts to promote the event, and to keep it in our archive. Our service providers can use it only to help us do that.',
      'You promise you\'re allowed to submit it, that it\'s accurate, that you own or have permission to use any image, and that it isn\'t unlawful.',
      'We review every submission and may edit, decline or remove any of it. Free listings aren\'t guaranteed a spot.',
      'Please don\'t send anything confidential.'
    ]))}
    ${section('use', 'Using the site fairly', ul([
      'No scraping or bulk copying beyond normal search engine indexing, and no bots on our forms.',
      'Don\'t interfere with the site, its security or its spam checks.',
      'No false or misleading submissions, spam, harassment, impersonation or illegal content.'
    ]))}
    ${section('newsletter', 'The newsletter', `<p>The newsletter is free and goes out every Monday and Thursday. You can unsubscribe any time with the link in every email. We may change how often it comes, what's in it, or stop it.</p>`)}
    ${section('referrals', 'Referral rewards', '<p>Referral rewards and the monthly drawing are governed by their <a href="/referral-rules">official rules</a>.</p>')}
    ${section('ip', 'Our content', `<p>The site's design, logo, text and the way we put the listings together belong to us. Event names, logos and trademarks belong to their owners. You're welcome to use the site and share links to it for personal, non-commercial purposes.</p>`)}
    ${section('copyright', 'Copyright complaints', `<p>If you think something on the site infringes your copyright (a flyer or photo, for example), email ${emailLink('Copyright complaint')} with: the work you own, where it appears on our site (the link), your contact details, a statement that you believe in good faith the use isn't authorized, a statement that your notice is accurate and that you're the owner or authorized to act for them, and your signature (typing your full name is fine). We remove infringing material promptly, and we remove the content of anyone who repeatedly infringes. If your content was removed and you think that was a mistake, email us and tell us why.</p>`)}
    ${section('links', 'Other websites', '<p>We link to other websites (organizers, venues, ticket sellers, sponsors). They have their own terms and privacy policies, and we\'re not responsible for them.</p>')}
    ${section('disclaimer', 'No warranties', loud('THE SITE, THE NEWSLETTER AND ALL LISTINGS ARE PROVIDED "AS IS" AND "AS AVAILABLE", WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING ANY WARRANTY OF ACCURACY, FITNESS FOR A PARTICULAR PURPOSE OR NON-INFRINGEMENT, TO THE FULLEST EXTENT THE LAW ALLOWS.'))}
    ${section('liability', 'Limit of liability', loud(`TO THE FULLEST EXTENT THE LAW ALLOWS, ${op.toUpperCase()} IS NOT LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL OR PUNITIVE DAMAGES, OR LOST PROFITS, ARISING FROM YOUR USE OF THE SITE OR THE NEWSLETTER, AND OUR TOTAL LIABILITY FOR ANY CLAIM ABOUT THEM IS LIMITED TO $100 OR THE AMOUNT YOU PAID US IN THE 12 MONTHS BEFORE THE CLAIM, WHICHEVER IS MORE.`))}
    ${section('indemnity', 'Your responsibility', loud(`YOU AGREE TO DEFEND AND COMPENSATE ${op.toUpperCase()} FOR ANY THIRD-PARTY CLAIM, LOSS OR EXPENSE (INCLUDING REASONABLE ATTORNEYS' FEES) ARISING FROM WHAT YOU SUBMIT OR FROM YOUR MISUSE OF THE SITE.`))}
    ${section('law', 'Governing law', '<p>These terms are governed by the laws of the State of Texas, without regard to its conflict-of-law rules. Before going to court, email us and give us 30 days to try to sort it out. After that, disputes go to the state or federal courts in Texas, and either of us may use small claims court.</p>')}
    ${section('changes', 'Changes', '<p>We may update these terms. We\'ll change the date at the top, and tell subscribers about important changes in the newsletter. If you keep using the site after a change, the new terms apply.</p>')}
    ${section('contact', 'Contact', contactBlockHtml())}`;
  return layout({
    siteUrl, path: '/terms',
    title: `Terms of use | ${town.siteName}`,
    description: `The terms for using ${town.siteName}, its newsletter and its forms.`,
    body
  });
}

// ─── /advertising-terms ──────────────────────────────────────────────────
// What a sponsor or a paid pick buyer agrees to with the checkbox at
// checkout (server/sponsors.js records ADVERTISING_TERMS_VERSION). Every
// line here is tied to the code:
//   - booking: bookableWeeks (next week to WEEKS_AHEAD out, 35-minute hold),
//     validateOrder (picks up to FEATURE_DAYS_AHEAD days), instantOnly
//   - the newsletter star: newsletterCovers / weekendCovers (server/notify.js)
//   - refunds: 'conflict' (double-booked) and 'late' (payment settled after
//     the date) orders are refunded or moved by the owner (Slack alert)
//   - cancellations: by email to contactEmail(), CANCEL_NOTICE_DAYS ahead
export function renderAdvertisingTermsPage({ siteUrl }) {
  const op = escHtml(operatorName());
  const [weekly, pick, partner] = AD_PACKAGES;
  const points = p => `<ul>${p.points.map(([b, rest]) => `<li><strong>${escHtml(b)}</strong>${rest ? ` (${escHtml(rest)})` : ''}</li>`).join('')}</ul>`;
  const d = CANCEL_NOTICE_DAYS;
  const body = `
    <h1 class="page-title">Advertising terms</h1>
    <p class="page-lead">What you get when you sponsor ${town.siteName} or give your event the ${town.pickName} badge, what we expect from you, and how cancellations and refunds work.</p>
    ${updatedLine(ADVERTISING_TERMS_VERSION)}
    ${section('who', '1. Who we are', `<p>${operatorSentence()} "We" and "us" mean ${op}; "you" means the person or business buying a placement. These terms, together with your order (the package, dates and price shown at checkout and in your confirmation email), are our agreement. You accept them by ticking the box at checkout. If you buy for a business, you confirm you're allowed to accept them for it.</p>`)}
    ${section('what', '2. What you\'re buying', `<p><strong>${escHtml(weekly.name)}</strong> (${escHtml(weekly.price)}): one Monday-to-Sunday week. It includes:</p>${points(weekly)}
    <p><strong>${escHtml(pick.name)}</strong> (${escHtml(pick.price)}): one event on one day. It includes:</p>${points(pick)}
    <p><strong>${escHtml(partner.name)}</strong> (billed monthly at the price shown at checkout): one business per category for as long as you stay subscribed. It includes:</p>${points(partner)}
    <p>Paid placements are labeled as advertising: the weekly sponsor as "This week's sponsor", a category partner as "Our local partners" or "Our [category] partner", and a paid ${town.pickName} with "#ad" at the end of its description (and at the start of a social media caption that includes it). Where a placement sits within a page, an email or a post, and when posts go out, is up to us. Venue partner subscriptions are no longer sold; ones bought earlier keep running under these terms until cancelled.</p>`)}
    ${section('booking', '3. Booking and scheduling', ul([
      `You can book a sponsor week from next week up to ${BOOKING.weeksAhead} weeks ahead, and a ${town.pickName} for a date up to ${BOOKING.pickDaysAhead} days ahead. Each week has one sponsor, and each day has a limited number of ${town.pickName}s.`,
      `Your spot is held for about ${BOOKING.holdMinutes} minutes while you pay, and is booked once your payment goes through. A bank payment that is still processing keeps the spot held until it clears. Close to the date (within ${BOOKING.cardsOnlyDays} days), checkout takes only cards, which clear at once.`,
      'A sponsor week goes live on its own on its Monday. A ' + town.pickName + ' is checked by our editors before it\'s listed (usually the same day) and is highlighted on its day once it is.',
      town.pickName + 's are starred in the newsletter only when bought before the issue that covers their day goes out (we say in your confirmation which issues it will be in).',
      'You write your own message, link and button (and add a logo, for a sponsor week) at checkout, and see a preview before you pay. To change something before it runs, reply to your confirmation email.',
      'A category partner is checked by us before it goes live: we review every new partner, usually within 1 business day. Only one business holds a category at a time; a category someone is paying for or waiting on our review for can\'t be bought.'
    ]))}
    ${section('content', '4. Your content and our right to refuse it', `<p>We may edit your copy for length, clarity, style and accuracy, and resize or crop your logo. <strong>We may refuse, pause or remove any ad or ${town.pickName} at any time, for any reason, in our sole discretion.</strong> If we do that for a reason other than your breach of these terms, we refund the part that hasn't run (see section 11).</p>`)}
    ${section('prohibited', '5. What we don\'t accept', ul([
      'anything illegal, or that promotes illegal activity;',
      'adult or sexual content;',
      'weapons, ammunition or explosives for sale;',
      'tobacco, vaping, THC, CBD or drug products;',
      'gambling, sweepstakes or raffles, unless lawful and approved by us in advance;',
      'alcohol, except from licensed businesses and aimed at adults 21 and older;',
      'political candidates, parties or issue campaigns;',
      'multi-level marketing or get-rich-quick schemes;',
      'misleading health, financial or "guaranteed results" claims;',
      'hate, harassment or discrimination;',
      'anything that infringes someone else\'s copyright, trademark or privacy;',
      'links to malware, or misleading or broken pages.'
    ]))}
    ${section('promises', '6. Your promises', '<p>You promise that you own or have permission to use everything you give us (text, logo, images, links); that your claims are true and you can back them up; that you hold any license your business needs; that your offer follows the law; and that your link goes to a safe, working page.</p>')}
    ${section('license', '7. Permission to show your ad', `<p>You give us a non-exclusive, royalty-free license to copy, resize, display and share your name, logo and ad content in the placement you bought, in archived and web copies of our newsletters and pages, and in our social media posts for it. You can ask us to leave you out of any mention of our past sponsors by emailing us. We keep all rights in our own sites, newsletters and materials.</p>`)}
    ${section('makegoods', '8. If something goes wrong on our side', `<p>In normal conditions we run what you booked on schedule. <strong>If a newsletter issue you booked doesn't go out, or your placement is left out of it or off the site because of us, we give you an equivalent placement in the next open slot or, at our option, refund the affected part.</strong> Small variations (send time, position, formatting, or an email provider delaying delivery) don't count as failures.</p>`)}
    ${section('results', '9. No guaranteed results', `<p><strong>We don't guarantee any number of subscribers, views, opens, clicks, visits, leads or sales.</strong> The numbers in your results report are our own counts and estimates; some readers block our counter, so real numbers can be a little higher.</p>`)}
    ${section('payment', '10. Payment', '<p>You pay in US dollars through Stripe, at the price shown at checkout. Stripe emails your receipt. We never see your card number. A category partner subscription renews monthly until you cancel it, from the link in any of our partner emails (it opens Stripe\'s billing page) or by emailing us; you stay listed through the month you\'ve paid for and aren\'t charged again. A venue partner subscription bought earlier renews monthly until cancelled; email us to cancel it and it stops at the end of the month you\'ve paid for.</p>')}
    ${section('refunds', '11. Cancellations and refunds', `<p>We want every placement to work for you. If something goes wrong on our side, we make it right.</p>
    ${ul([
      `<strong>${escHtml(weekly.name)}:</strong> cancel at least ${d} days before the Monday your week starts for a full refund. After that, there's no refund, but if you ask before your week starts we'll try to move you to another open week once.`,
      `<strong>${town.pickName}:</strong> cancel at least ${d} days before your event's date for a full refund. After that, there's no refund. If the organizer cancels or moves the event before its date, tell us and we'll refund you or move the ${town.pickName} to the new date, whichever you prefer.`,
      `<strong>${escHtml(partner.name)}:</strong> if we don't approve your listing, we cancel the subscription and refund your first payment in full. After you're live you can cancel anytime; you stay listed through the month you've paid for, which isn't refunded, and nothing more is charged.`,
      '<strong>Double-booked:</strong> if someone else paid for the same week, or your day\'s spots filled up moments before your payment, we contact you within 1 business day to move you to another open week or day or refund you in full, whichever you prefer.',
      '<strong>Payment arrived too late:</strong> if a bank payment clears only after your date has passed, we refund you in full (or set up another date, if you\'d like).',
      `<strong>We decline or remove your placement:</strong> if we refuse or take down your ad or ${town.pickName} for a reason other than your breach of these terms, we refund the part that hasn't run. If it breaks these terms, there's no refund.`,
      '<strong>A placement we missed:</strong> see section 8.',
      `<strong>How to ask:</strong> email ${emailLink('Cancellation or refund')} with your business name and the email you paid with. We answer within 1 business day.`,
      '<strong>How refunds arrive:</strong> refunds go back to the card or account you paid with, through Stripe, and usually show up within 5 to 10 business days. We refund the full amount; we don\'t keep a fee.'
    ])}`)}
    ${section('disputes', '12. Before you dispute a charge', '<p>Please contact us first; we can usually fix things within a business day. If you dispute a charge for a placement we delivered, we may give Stripe proof that it ran and pause your future placements, and if the dispute is decided in our favor you agree to pay back the disputed amount and any dispute fee.</p>')}
    ${section('sender', '13. The newsletter is ours', '<p>We are the sender of our newsletters under the CAN-SPAM Act: we handle unsubscribes and the mailing address in every email. You don\'t get subscribers\' email addresses.</p>')}
    ${section('independence', '14. Independence', `<p>Running your ad doesn't mean we endorse you, and our editors' picks and coverage aren't for sale. A ${town.pickName} our editors choose carries no "#ad" mark; a paid one always does.</p>`)}
    ${section('indemnity', '15. Indemnity', loud(`YOU WILL DEFEND, INDEMNIFY AND HOLD HARMLESS ${op.toUpperCase()} AND ITS OWNERS AND CONTRACTORS FROM ANY THIRD-PARTY CLAIM, LOSS OR EXPENSE (INCLUDING REASONABLE ATTORNEYS' FEES) ARISING FROM YOUR AD CONTENT, YOUR LOGO, YOUR PRODUCTS, SERVICES, OFFERS OR CLAIMS, OR YOUR BREACH OF THESE TERMS, INCLUDING CLAIMS ALLEGING OUR OWN NEGLIGENCE IN PUBLISHING CONTENT YOU PROVIDED.`))}
    ${section('liability', '16. Limit of liability', loud(`TO THE FULLEST EXTENT THE LAW ALLOWS, OUR TOTAL LIABILITY FOR ANY CLAIM ABOUT AN ORDER IS LIMITED TO THE AMOUNT YOU PAID FOR THAT ORDER, AND WE ARE NOT LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL OR PUNITIVE DAMAGES, OR LOST PROFITS.`))}
    ${section('force', '17. Things outside our control', '<p>We aren\'t responsible for delays or failures caused by things beyond our reasonable control, such as outages of email, hosting, payment or social media services, severe weather or government action. If one affects your placement, you get a makeup placement or a refund of the affected part.</p>')}
    ${section('law', '18. Governing law and disputes', '<p>These terms are governed by the laws of the State of Texas, without regard to its conflict-of-law rules. If we disagree, email us first and give us 30 days to sort it out informally. After that, disputes go only to the state or federal courts in Texas, and either of us may use small claims court.</p>')}
    ${section('changes', '19. Changes', '<p>We may update these terms. The version you accepted at checkout (its date is shown at the top of this page) applies to that order; new versions apply only to later orders.</p>')}
    ${section('misc', '20. The rest', '<p>These terms and your order are the whole agreement between us about your placement. If a part of them can\'t be enforced, the rest still applies. You can\'t transfer your order to someone else without our OK. We send notices by email to the address you paid with. Sections 7, 12, 15, 16 and 18 continue after your placement ends.</p>')}
    ${section('contact', '21. Contact', contactBlockHtml())}`;
  return layout({
    siteUrl, path: '/advertising-terms', nav: '/advertise',
    title: `Advertising terms | ${town.siteName}`,
    description: `The terms for sponsoring ${town.siteName} or buying a ${town.pickName}, including cancellations and refunds.`,
    body
  });
}

// ─── /accessibility ──────────────────────────────────────────────────────

export function renderAccessibilityPage({ siteUrl }) {
  const body = `
    <h1 class="page-title">Accessibility</h1>
    <p class="page-lead">We want everyone in ${town.city} to be able to find out what's happening, whatever device or assistive technology they use.</p>
    ${updatedLine(ACCESSIBILITY_VERSION)}
    ${section('goal', 'What we aim for', `<p>We aim to meet the Web Content Accessibility Guidelines (WCAG) 2.1 at level AA on ${town.domain} and in our newsletter. That means:</p>
    ${ul([
      'event names, dates, times, places and prices are always text, never only inside an image;',
      'pages work with a keyboard and a screen reader, with headings, labels and a "skip to content" link;',
      'text has enough contrast in both light and dark mode, and pages work when zoomed or on a small screen;',
      'every newsletter has a plain-text version.'
    ])}`)}
    ${section('limits', 'Known limits', ul([
      'Some flyers and logos come from organizers and sponsors, and the text inside those images may not be fully described; the event details are always in the text next to them.',
      'Payment happens on Stripe\'s checkout page, and our spam check on forms is Cloudflare Turnstile. Both are run by those companies.',
      'Pages we link to (organizers, venues, ticket sellers) are outside our control.'
    ]))}
    ${section('contact', 'Tell us about a problem', `<p>If something on the site or in the newsletter is hard to use, or you need information in another format, email ${emailLink('Accessibility')} or use our <a href="/contact">contact form</a>. Tell us the page and what went wrong. We aim to reply within 5 business days and to fix what we can.</p>`)}`;
  return layout({
    siteUrl, path: '/accessibility',
    title: `Accessibility | ${town.siteName}`,
    description: `${town.siteName}'s accessibility statement, and how to tell us about a problem.`,
    body
  });
}
