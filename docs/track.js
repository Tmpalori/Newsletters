/* track.js — page view and click tracking, loaded on every public page.
 *
 * Each event goes two places: Google Analytics (when it loaded) and our own
 * /api/track beacon, which feeds the admin Traffic tab. Sponsors and venues
 * pay for clicks, so we record the ones they care about: event detail
 * clicks out, event pages opened from a list, sponsor clicks, subscribe clicks. One delegated listener covers
 * both the server-rendered pages and the homepage list app.js re-renders.
 * Paid placements ([data-ad]) also report when they're seen, for the
 * sponsor reports (server/sponsors.js), and so do free submitted events
 * ([data-seen]), for their submitter's recap (server/eventRecaps.js).
 */
(function () {
  'use strict';

  // Don't count the site owner: a browser signed into the admin, the admin
  // preview iframe, and the private social kit page.
  var skip = false;
  try { skip = !!localStorage.getItem('vic361_admin_session'); } catch (e) { /* storage blocked */ }
  if (/[?&]previewKey=/.test(location.search) || location.pathname.indexOf('/social/') === 0) skip = true;

  function beacon(data) {
    if (skip) return;
    data.path = location.pathname;
    var body = JSON.stringify(data);
    try {
      if (navigator.sendBeacon && navigator.sendBeacon('/api/track', new Blob([body], { type: 'application/json' }))) return;
    } catch (e) { /* fall through to fetch */ }
    try {
      fetch('/api/track', { method: 'POST', body: body, keepalive: true, headers: { 'Content-Type': 'application/json' } });
    } catch (e) { /* tracking must never break the page */ }
  }

  // Signup forms report subscribe_click with link_url 'form' or 'list-card'
  // once /api/subscribe accepts the email; plain Subscribe links don't.
  // That success is the Lead that Meta ads optimize for (server/metaPixel.js),
  // but only with lead: true, which the form passes on from the server's
  // answer: a signup still waiting on its Confirm tap (or a honeypot hit)
  // isn't a subscriber yet.
  var SIGNUP_DONE = { form: 1, 'list-card': 1 };

  // A link to our own /subscribe page (not /subscribe/confirm, not another site's /subscribe).
  function isOurSubscribeLink(a) {
    try {
      var u = new URL(a.href, location.href);
      return u.host === location.host && /^\/subscribe\/?$/.test(u.pathname);
    } catch (e) { return false; }
  }

  // `el`: what was tapped. A tap inside a paid placement ([data-ad]: the
  // sponsor block, a paid Vic's Pick) carries the ad's id, so the sponsor's
  // report can count it. Only our beacon gets it, not Google Analytics.
  function track(type, params, el) {
    var lead = !!(params && params.lead);
    if (params && 'lead' in params) {
      params = Object.assign({}, params);
      delete params.lead;  // ours, not a Google Analytics parameter
    }
    if (typeof window.gtag === 'function') window.gtag('event', type, params || {});
    if (type === 'subscribe_click' && lead && SIGNUP_DONE[params.link_url] && typeof window.fbq === 'function') {
      window.fbq('track', 'Lead');
    }
    sendView();  // a click is engagement; the view goes first
    var data = { kind: 'click', type: type, url: (params && params.link_url) || '' };
    var adEl = el && el.closest ? el.closest('[data-ad]') : null;
    if (adEl) data.ad = adEl.getAttribute('data-ad');
    beacon(data);
  }
  window.vic361Track = track;  // app.js filter chips report through this

  // utm_medium=paid marks a tap on an ad (server/analytics.js paidSource).
  // ?s=sh marks a link someone shared from the site (share buttons below):
  // the view counts as "Shared link", and the tag comes off the address
  // bar so a reload or a copied URL doesn't count again.
  // utm_campaign says which email a newsletter visit came from (weekly-…,
  // weekend-…, welcome), so the issue report credits the right issue.
  var utm = '', utmMedium = '', utmCampaign = '', viaShare = false;
  try {
    var q = new URLSearchParams(location.search);
    utm = q.get('utm_source') || '';
    utmMedium = q.get('utm_medium') || '';
    utmCampaign = q.get('utm_campaign') || '';
    if (q.get('s') === 'sh') {
      viaShare = true;
      q.delete('s');
      var rest = q.toString();
      if (window.history && history.replaceState) history.replaceState(history.state, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
    }
  } catch (e) { /* old browser */ }
  // A page view counts once someone engages: they scroll, tap, click or
  // type, or the page has been on screen for 5 seconds. Bots that run
  // JavaScript and visits that leave straight away never get there, so the
  // Traffic tab counts people who actually looked. Time in a background tab
  // doesn't count toward the 5 seconds.
  var ENGAGED_MS = 5000;
  var viewSent = false;
  var shownMs = 0, shownSince = null, timer = null;
  function sendView() {
    if (viewSent) return;
    viewSent = true;
    clearTimeout(timer);
    ENGAGE_EVENTS.forEach(function (t) { window.removeEventListener(t, sendView, true); });
    document.removeEventListener('visibilitychange', onVisibility);
    var view = { kind: 'view', ref: document.referrer || '', utm: utm, utm_medium: utmMedium, utm_campaign: utmCampaign };
    if (viaShare) view.via = 'share';
    beacon(view);
  }
  function onVisibility() {
    if (document.visibilityState === 'visible') {
      shownSince = Date.now();
      timer = setTimeout(sendView, Math.max(0, ENGAGED_MS - shownMs));
    } else if (shownSince !== null) {
      shownMs += Date.now() - shownSince;
      shownSince = null;
      clearTimeout(timer);
    }
  }
  var ENGAGE_EVENTS = ['scroll', 'pointerdown', 'keydown', 'touchstart'];
  ENGAGE_EVENTS.forEach(function (t) { window.addEventListener(t, sendView, { capture: true, passive: true }); });
  document.addEventListener('visibilitychange', onVisibility);
  onVisibility();

  // Remember for this visit that it started from an ad, so a signup a few
  // pages later still counts as one (server/newsletter.js signupSource).
  // Same paid mediums as server/analytics.js PAID_MEDIUMS.
  if (/^\s*(paid|paid_social|paidsocial|cpc|ppc|ads?)\s*$/i.test(utmMedium)) { try { sessionStorage.setItem('vic361-ad', '1'); } catch (e) { /* storage blocked */ } }
  // A referral link (/r/<code> → /subscribe?ref=<code>): keep the code for
  // this visit so a signup on any page credits the friend who shared it
  // (server/newsletter.js). Codes are 7 letters/digits; anything else is ignored.
  try {
    var refQ = (new URLSearchParams(location.search).get('ref') || '').toLowerCase();
    if (/^[a-z2-9]{7}$/.test(refQ)) sessionStorage.setItem('vic361-ref', refQ);
  } catch (e) { /* old browser or storage blocked */ }
  window.vic361Ref = function () {
    try { return sessionStorage.getItem('vic361-ref') || ''; } catch (e) { return ''; }
  };
  window.vic361Source = function (base) {
    var ad = false;
    try { ad = sessionStorage.getItem('vic361-ad') === '1'; } catch (e) { /* storage blocked */ }
    return ad ? base + ':ad' : base;
  };

  // Ad views. A paid placement ([data-ad]) counts as seen once at least
  // half of it has been on screen for a full second, with the tab in front:
  // one impression per ad per page load, however often it scrolls by. A
  // free submitted event ([data-seen], its page) counts the same way, as a
  // sighting for its submitter's recap. Lists re-render (app.js), so new
  // elements are picked up as they appear. Browsers without
  // IntersectionObserver just don't count views.
  var AD_MS = 1000;
  function watchAds() {
    if (skip || typeof window.IntersectionObserver !== 'function') return;
    var seen = {};      // 'ad:<id>' / 'seen:<page>' -> beacon sent
    var showing = [];   // elements at least half on screen right now
    var timers = new Map();  // element -> its one-second timer
    function arm(el) {
      clearTimeout(timers.get(el));
      timers.set(el, setTimeout(function () {
        var id = el.getAttribute('data-ad');
        var page = id ? '' : el.getAttribute('data-seen');
        var key = id ? 'ad:' + id : 'seen:' + page;
        if (document.visibilityState === 'hidden' || el.isConnected === false || !(id || page) || seen[key]) return;
        seen[key] = true;
        beacon(id ? { kind: 'impression', ad: id } : { kind: 'sighting', page: page });
      }, AD_MS));
    }
    function start(el) {
      if (showing.indexOf(el) !== -1) return;
      showing.push(el);
      arm(el);
    }
    function stop(el) {
      clearTimeout(timers.get(el));
      timers.delete(el);
      var i = showing.indexOf(el);
      if (i !== -1) showing.splice(i, 1);
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting && en.intersectionRatio >= 0.5) start(en.target);
        else stop(en.target);
      });
    }, { threshold: [0, 0.5] });
    var watched = new WeakSet();  // Map/WeakSet: every browser with IntersectionObserver has them
    function scan() {
      var els = document.querySelectorAll('[data-ad], [data-seen]');
      for (var i = 0; i < els.length; i++) {
        if (watched.has(els[i])) continue;
        watched.add(els[i]);
        io.observe(els[i]);
      }
    }
    // A background tab doesn't count: the second starts again when the
    // page is back in front.
    document.addEventListener('visibilitychange', function () {
      showing.forEach(function (el) {
        if (document.visibilityState === 'hidden') clearTimeout(timers.get(el));
        else arm(el);
      });
    });
    scan();
    if (typeof window.MutationObserver === 'function' && document.body) {
      new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchAds);
  else watchAds();

  // A link that leaves the site (an event's own page at its venue or
  // organizer), as opposed to one of our pages.
  function isOutbound(a) {
    return /^https?:$/.test(a.protocol || '') && !!a.host && a.host !== location.host;
  }

  // Event links: event_click is a tap out to the event's own link (the
  // "See event details" button, or a list item that links out);
  // event_open is a tap from a list to the event's page here. Other
  // buttons in .page-actions (the 404 page's) fall through to the checks
  // below.
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (a.classList.contains('sponsor-cta')) {
      track('sponsor_click', { link_url: href }, a);
    } else if (a.closest('.event-entry, .page-actions') && isOutbound(a)) {
      track('event_click', { link_url: href, link_text: a.textContent.trim().slice(0, 100) }, a);
    } else if (a.closest('.event-entry')) {
      track('event_open', { link_url: href }, a);
    } else if (href.indexOf('#subscribe') !== -1 || isOurSubscribeLink(a)) {
      track('subscribe_click');
    } else if (href.indexOf('/advertise') === 0) {
      track('advertise_click', { link_url: href });
    } else if (a.getAttribute('data-track')) {
      track(a.getAttribute('data-track'), { link_url: href }, a);
    }
  });

  // Share buttons (event pages, list headers, and the icon on each event in
  // a list): the phone's share sheet when there is one, otherwise copy the
  // link. List items carry a site-relative path; resolve it so the copied
  // link works anywhere. The shared link carries ?s=sh, so visits it brings
  // count as "Shared link" (see above). A share counts once it's sent or
  // copied, not when the sheet is opened and closed.
  function shareLink(raw) {
    try {
      var u = new URL(raw, location.href);
      u.searchParams.set('s', 'sh');
      return u.href;
    } catch (err) { return raw; }  // old browser: keep as is
  }
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-share-url]') : null;
    if (!btn) return;
    var page = btn.getAttribute('data-share-url');
    try { page = new URL(page, location.href).href; } catch (err) { /* old browser: keep as is */ }
    var url = shareLink(page);
    var text = btn.getAttribute('data-share-text') || '';
    var fromList = btn.classList.contains('event-share');
    function shared() { track(fromList ? 'share_from_list' : 'share_native', { link_url: page }, btn); }
    if (navigator.share) {
      navigator.share({ title: text, text: text, url: url }).then(shared, function () {});  // closed the sheet: not a share
      return;
    }
    function copied() {
      shared();
      if (!fromList) { btn.textContent = 'Link copied'; return; }
      // The list button is an icon; flag it instead of replacing the icon.
      btn.classList.add('is-copied');
      btn.setAttribute('aria-label', 'Link copied');
      setTimeout(function () { btn.classList.remove('is-copied'); btn.setAttribute('aria-label', 'Share ' + text); }, 2000);
    }
    function manual() { shared(); window.prompt('Copy this link:', url); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(copied, manual);
    } else {
      manual();
    }
  });
})();
