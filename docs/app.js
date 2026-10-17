/* app.js — The Vic 361 */
// The town this page is for. Another town's server sets window.__TOWN__
// (server/localize.js); without it, Victoria.
var TOWN = Object.assign({ timezone: 'America/Chicago', city: 'Victoria', pickName: 'Vic’s Pick', utmSource: 'thevic361' },
  (typeof window !== 'undefined' && window.__TOWN__) || {});

(function () {
  'use strict';

  // ─── ICONS ───
  // Cartoon category icons live in icons.svg (one <symbol> per key).
  const ICON_KEYS = ['food', 'music', 'family', 'drinks', 'arts', 'shopping', 'outdoors', 'community', 'free'];
  // Read out for screen readers (ICON_LABELS in server/seo.js matches).
  const ICON_LABELS = {
    food: 'Food', music: 'Music', family: 'Kids & Family', drinks: 'Drinks', arts: 'Arts',
    shopping: 'Shopping', outdoors: 'Outdoors', community: 'Community', free: 'Free'
  };
  function iconSvg(key) {
    return '<svg class="ico" aria-hidden="true" focusable="false"><use href="icons.svg#i-' + key + '"></use></svg>';
  }

  // Dark mode: the toggle is handled by the inline THEME_SCRIPT in the page
  // head (server/seo.js), which saves the choice for every page.

  // ─── STICKY HEADER SHADOW ───
  const header = document.getElementById('site-header');
  // An open day's header bar sticks just under the site header
  // (style.css .day-section--fold), whose height changes with the width.
  function setHeaderHeight() {
    if (header) document.documentElement.style.setProperty('--header-height', header.offsetHeight + 'px');
  }
  setHeaderHeight();
  window.addEventListener('resize', setHeaderHeight, { passive: true });
  // Mark an open day's header bar while it's stuck, so it can look like
  // its own card (style.css .is-stuck).
  function markStuck() {
    var top = header ? header.offsetHeight : 0;
    document.querySelectorAll('.day-section--fold details[open] > summary').forEach(function (s) {
      var r = s.getBoundingClientRect();
      var sec = s.closest('.day-section').getBoundingClientRect();
      // Stuck once the card has moved up past the bar's resting place.
      s.classList.toggle('is-stuck', r.top <= top + 1 && sec.top < r.top + 6 && sec.bottom > r.bottom + 2);
    });
  }
  // Run right away (a handful of open days at most) so the bar never lags
  // a frame behind the scroll; also on resize and once the list renders.
  window.addEventListener('scroll', markStuck, { passive: true });
  window.addEventListener('resize', markStuck, { passive: true });
  window.addEventListener('scroll', function () {
    if (window.scrollY > 10) {
      header.classList.add('scrolled');
    } else {
      header.classList.remove('scrolled');
    }
  }, { passive: true });

  // ─── DATE HELPERS ───
  // Days are YYYY-MM-DD strings in the town's time (TOWN.timezone; Victoria:
  // America/Chicago), like currentWeek/addDays in server/seo.js. The
  // browser's own zone would
  // move "Today" and the week for a visitor whose clock says UTC (privacy
  // browsers, VMs) or who is traveling, and this render replaces the
  // server's correct grid.
  var TOWN_DAY = new Intl.DateTimeFormat('en-CA', {
    timeZone: TOWN.timezone, year: 'numeric', month: '2-digit', day: '2-digit'
  });

  function townToday() {
    return TOWN_DAY.format(new Date());
  }

  // Noon UTC on the day: formatting it in UTC can't slip to a neighbor day.
  function dayAt(dateStr) {
    return new Date(dateStr + 'T12:00:00Z');
  }

  function addDays(dateStr, n) {
    var d = dayAt(dateStr);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  function formatDayName(dateStr) {
    return dayAt(dateStr).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  }

  function formatMonthDay(dateStr) {
    return dayAt(dateStr).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
  }

  function isToday(dateStr) {
    return dateStr === townToday();
  }

  // ─── RENDER ICONS ───
  function renderIcons(icons) {
    if (!icons || !icons.length) return '';
    return icons
      .filter(function (key) { return ICON_KEYS.indexOf(key) !== -1; })
      .map(iconSvg)
      .join('');
  }

  // Event and sponsor URLs come from scrapers and public submissions. Only
  // http(s) is ever rendered, and the value is escaped so a quote in the
  // URL can't break out of the href attribute and inject markup.
  function safeHref(url) {
    if (typeof url !== 'string') return '';
    var u = url.trim();
    return /^https?:\/\/[^\s"'<>`]+$/i.test(u) ? escHtml(u) : '';
  }

  // Same as formatTime() in server/seo.js: "04:00PM-6PM" -> "4:00 PM – 6 PM".
  // Display only; ev.time itself is left alone.
  function formatTime(time) {
    if (typeof time !== 'string') return '';
    return time.trim()
      .replace(/(^|[^\d:])0(\d)(?=(?::\d{2})?\s*[ap]\.?\s*m\b)/gi, '$1$2')
      .replace(/(\d)\s*([ap])\.?\s*m\b\.?/gi, function (m, d, ap) { return d + ' ' + ap.toUpperCase() + 'M'; })
      .replace(/([\dM])\s*(?:[–—-]+|\bto\b)\s*(?=\d)/g, '$1 – ');
  }

  // The time shown for an event: with a separate end (end_time, from the
  // submit form or the admin edit modal) joined on when ev.time is a single
  // time, as withPages() in server/seo.js does for the server's lists.
  var TIME_RE = /(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b/gi;
  function timeText(ev) {
    var t = typeof ev.time === 'string' ? ev.time.trim() : '';
    var end = typeof ev.end_time === 'string' ? ev.end_time.trim() : '';
    if (t && end && (t.match(TIME_RE) || []).length === 1 && (end.match(TIME_RE) || []).length === 1) {
      t = t + ' – ' + end;
    }
    return t;
  }

  // Start of an event in minutes after midnight (9999 without a time, so
  // those sort last): the same reading as parseTimes in server/seo.js, so
  // the browser re-render keeps the server's order. Minutes are optional
  // ("7 PM", "10am - 3pm"; admin-typed times aren't normalized), and a
  // range sharing one am/pm ("7-9 PM") starts at its bare leading time,
  // flipped to the other half of the day when that would pass the end.
  var SHARED_RANGE = /(^|[^\d:])(\d{1,2})(?::(\d{2}))?\s*(?:-|–|—|to)\s*(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b/i;
  function timeMins(time) {
    var t = String(time || '');
    var re = /(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?/gi, m, end = -1;
    while ((m = re.exec(t))) {
      // "7:75 PM" or "13pm" isn't a time.
      if (parseInt(m[1], 10) > 12 || parseInt(m[2] || '0', 10) > 59) continue;
      end = (parseInt(m[1], 10) % 12 + (m[3].toLowerCase() === 'p' ? 12 : 0)) * 60 + parseInt(m[2] || '0', 10);
      break;
    }
    if (end < 0) return 9999;
    var r = SHARED_RANGE.exec(t);
    var first = /(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m/i.exec(t);
    if (r && first && first.index > r.index + r[1].length &&
        parseInt(r[2], 10) <= 12 && parseInt(r[3] || '0', 10) <= 59) {
      var h = parseInt(r[2], 10) % 12 + (end >= 720 ? 12 : 0);
      var mins = parseInt(r[3] || '0', 10);
      if (h * 60 + mins > end) h = (h + 12) % 24;
      return h * 60 + mins;
    }
    return end;
  }

  // Sponsor clicks carry utm_* tags for the sponsor's own analytics, like
  // sponsorLinkUrl() in server/seo.js. href is already safeHref()-checked.
  function sponsorLink(url) {
    var href = safeHref(url);
    if (!href || /[?&](amp;)?utm_/i.test(href)) return href;
    try {
      var u = new URL(url.trim());
      u.searchParams.set('utm_source', TOWN.utmSource);
      u.searchParams.set('utm_medium', 'sponsor');
      u.searchParams.set('utm_campaign', 'weekly-sponsor');
      return safeHref(u.toString()) || href;
    } catch (e) {
      return href;
    }
  }

  var SHARE_ICON = '<svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true" focusable="false"><path d="M17.5 4.5l10 8.6c.6.5.6 1.3 0 1.8l-10 8.6c-.7.6-1.7.1-1.7-.8v-4.4C10 18.4 6.6 21 4.3 26.2c-.3.7-1.3.5-1.3-.3C3.4 16.8 8.6 11 15.8 10.6V5.3c0-.9 1-1.4 1.7-.8z" fill="#FF8FC0" stroke="#1F1A3D" stroke-width="2.4" stroke-linejoin="round"/></svg>';

  // ─── RENDER SINGLE EVENT ───
  function renderEvent(ev) {
    // free: true shows the Free icon too (iconKeys in server/seo.js).
    var iconList = (ev.icons || []).concat(ev.free === true && (ev.icons || []).indexOf('free') === -1 ? ['free'] : []);
    var iconHtml = renderIcons(iconList);
    // The icons' meaning for screen readers, same as iconsHtml in
    // server/seo.js: one labelled image, or a hidden empty column.
    var iconLabel = iconList.filter(function (k) { return ICON_KEYS.indexOf(k) !== -1; })
      .map(function (k) { return ICON_LABELS[k]; }).join(', ');
    var iconAttrs = iconLabel ? ' role="img" aria-label="' + escHtml(iconLabel) + '"' : ' aria-hidden="true"';
    var href = safeHref(ev.url);
    // ev.page is the server-rendered event page (/events/<slug>), added by
    // /events.json. Admin preview data doesn't carry it, so fall back to the
    // external source link there.
    var nameHtml = ev.page
      ? '<a href="' + escHtml(ev.page) + '">' + escHtml(ev.name) + '</a>'
      : href
        ? '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + escHtml(ev.name) + '</a>'
        : escHtml(ev.name);

    // Venue line: "Venue · street address", without repeating the address
    // when the venue field already is one (mirrors placeText in seo.js).
    var venuePart = '';
    var venue = (ev.venue || '').trim();
    var addr = (ev.address || '').trim();
    if (/^\d/.test(venue)) venue = venue.split(',')[0].trim();
    if (!venue) venuePart = addr;
    else if (!addr || venue.toLowerCase().indexOf(addr.toLowerCase()) !== -1 ||
             addr.toLowerCase().indexOf(venue.toLowerCase()) !== -1) venuePart = venue;
    else venuePart = venue + ' · ' + addr;

    // A paid pick ends its description with a small "#ad" (adTag in
    // server/seo.js); editors' picks carry only the pick badge.
    var paid = ev.featured && !ev.editor_pick;
    var descHtml = ev.description || paid
      ? '<div class="event-desc">' + escHtml(ev.description || '') + (paid ? ' <span class="event-ad">#ad</span>' : '') + '</div>'
      : '';

    // Share button, same markup as shareButton in server/seo.js. Admin
    // preview data has no ev.page, so no button there.
    var shareHtml = ev.page
      ? '<button type="button" class="event-share" data-share-url="' + escHtml(ev.page) + '" data-share-text="' + escHtml(ev.name) +
        '" aria-label="Share ' + escHtml(ev.name) + '" title="Share">' + SHARE_ICON + '</button>'
      : '';

    var iconAttr = (ev.icons || []).join(' ') + (ev.free === true ? ' free' : '');
    var ad = ev.featured && !ev.editor_pick ? adAttr(ev.sponsor_order) : '';
    return '<li class="event-entry' + (ev.featured ? ' event-entry--featured' : '') + '"' + ad + ' data-icons="' + escHtml(iconAttr) + '">' +
      '<span class="event-icons"' + iconAttrs + '>' + iconHtml + '</span>' +
      '<div class="event-details">' +
        (ev.featured ? '<span class="badge badge--featured">' + escHtml(TOWN.pickName) + '</span> ' : '') +
        // Nearby-town events (ev.town), same as nearbyBadge in server/seo.js.
        (ev.town ? '<span class="badge badge--nearby">Nearby · ' + escHtml(ev.town) + '</span> ' : '') +
        (ev.time ? '<span class="event-time">' + escHtml(formatTime(timeText(ev))) + '</span> ' : '') +
        '<span class="event-name">' + nameHtml + '</span>' +
        (venuePart ? '<span class="event-venue">' + escHtml(venuePart) + '</span>' : '') +
        descHtml +
      '</div>' +
      shareHtml +
    '</li>';
  }

  // ─── RENDER DAY SECTION ───
  function renderDaySection(dateStr, events, idx, openDate, prompt) {
    var today = isToday(dateStr);
    var dayName = formatDayName(dateStr);
    var monthDay = formatMonthDay(dateStr);

    var todayBadgeHtml = today ? ' <span class="today-badge">Today</span>' : '';
    // Every day is folded to its header bar except openDate (today), so the
    // list opens on today and any day is one tap away (same markup as
    // renderDay in server/seo.js).
    var past = dateStr < townToday();

    var eventsForDay = events.filter(function (e) { return e.date === dateStr; });
    // Sort by time ascending (events without time go last); at the same
    // time, paid Vic's Picks then editor's picks (sortEvents in server/seo.js).
    eventsForDay.sort(function(a, b) {
      var ta = timeMins(a.time), tb = timeMins(b.time);
      if (ta !== tb) return ta - tb;
      var ra = a.featured ? (a.editor_pick ? 1 : 0) : 2, rb = b.featured ? (b.editor_pick ? 1 : 0) : 2;
      return ra - rb;
    });

    var bodyHtml;
    if (eventsForDay.length === 0) {
      bodyHtml = '<div class="empty-state">Nothing listed yet — know something happening? <a href="/submit">Submit an event.</a></div>';
    } else {
      bodyHtml = '<ul class="event-list" role="list">' +
        eventsForDay.map(renderEvent).join('') +
      '</ul>';
    }
    // The server's "Give it the Vic's Pick badge" line for this day, if it drew one.
    bodyHtml += prompt || '';

    // Phones show "Oct 7" so the day, date and count fit on one row.
    var shortDay = dayAt(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    var headHtml = '<h2 class="day-name">' + dayName + todayBadgeHtml + '</h2>' +
      '<span class="day-date"><span class="dd-long">' + monthDay + '</span>' +
      '<span class="dd-short" aria-hidden="true">' + shortDay + '</span></span>';
    var n = eventsForDay.length;
    // Color by weekday (dayClass in server/seo.js): day--d0 Monday … d6 Sunday.
    var dow = (dayAt(dateStr).getUTCDay() + 6) % 7;
    return '<section class="day-section day-section--fold' + (past ? ' day-section--past' : '') + ' day--d' + dow + '" id="day-' + idx + '">' +
      '<details' + (dateStr === openDate ? ' open' : '') + '>' +
      '<summary class="day-header">' + headHtml + '<span class="day-count">' +
        (n === 0 ? 'No events' : n === 1 ? '1 event' : n + ' events') + '</span></summary>' +
      bodyHtml + '</details></section>';
  }

  // ─── NEWSLETTER CARD ───
  // A "get this every Monday and Thursday" card two days into the list, where people
  // already finding the list useful are reading, instead of only in the
  // footer. Hidden after someone subscribes on this device.
  var SUB_KEY = 'vic361-subscribed';
  function alreadySubscribed() {
    try { return localStorage.getItem(SUB_KEY) === '1'; } catch (e) { return false; }
  }
  function insertNewsletterCard(container, fromIdx) {
    // A paused town (TOWN_DORMANT=1) takes no signups.
    if (TOWN.dormant || alreadySubscribed() || /[?&]preview/.test(location.search)) return;
    var sections = container.querySelectorAll('.day-section');
    var after = sections[Math.min(fromIdx + 1, sections.length - 1)];
    if (!after) return;
    var card = document.createElement('section');
    card.className = 'nl-card';
    card.innerHTML =
      '<div class="nl-card__title">Get this list every Monday and Thursday</div>' +
      '<p class="nl-card__text">The week\'s best events in ' + escHtml(TOWN.city) + ', in your inbox. Free, no spam.</p>' +
      '<form class="signup-form js-subscribe" novalidate data-turnstile="fetch">' +
        '<label class="visually-hidden" for="nl-card-email">Email address</label>' +
        '<input id="nl-card-email" name="email" type="email" required autocomplete="email" placeholder="you@example.com">' +
        '<input type="text" name="hp_field" tabindex="-1" autocomplete="off" class="hp-field" aria-hidden="true">' +
        '<button type="submit" class="btn btn--primary">Subscribe</button>' +
        '<p class="signup-msg" role="status" aria-live="polite"></p>' +
      '</form>';
    after.parentNode.insertBefore(card, after.nextSibling);
    var form = card.querySelector('form');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var msg = form.querySelector('.signup-msg');
      var btn = form.querySelector('button');
      btn.disabled = true;
      var tokenP = window.vicTurnstile ? window.vicTurnstile.token(form) : Promise.resolve('');
      tokenP.then(function (t) {
        return fetch('/api/subscribe', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: form.email.value, hp_field: form.hp_field.value, turnstile_token: t,
            source: window.vic361Source ? window.vic361Source('list-card') : 'list-card',
            ref: window.vic361Ref ? window.vic361Ref() : '' })
        });
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; });
      }).then(function (x) {
        // A refusal with no message of ours (a 5xx, a proxy page) is ours to fix.
        if (!x.ok && !x.j.message && window.vicTurnstile) window.vicTurnstile.report('subscribe', 'server', 'HTTP error on list card');
        msg.textContent = x.ok ? '✅ ' + (x.j.message || "You're on the list! Check your inbox.") : (x.j.message || 'Something went wrong. Try again.');
        if (x.ok) {
          form.email.value = '';
          // Done: the field and button go away (a second tap on an empty form
          // used to show "Enter a valid email address" right after success).
          form.classList.add('is-done');
          // Only a first signup from this browser counts as a Lead. The
          // server answers the same for new and existing addresses (so the
          // form can't reveal who's subscribed), so this device decides.
          var was = alreadySubscribed();
          try { localStorage.setItem(SUB_KEY, '1'); } catch (e2) { /* private mode */ }
          if (!was && window.vic361Track) window.vic361Track('subscribe_click', { link_url: 'list-card', lead: !!x.j.lead });
        }
      }).catch(function (err) {
        if (window.vicTurnstile) window.vicTurnstile.report('subscribe', 'network', (err && err.message) || 'list card');
        msg.textContent = 'Something went wrong. Try again.';
      }).then(function () {
        btn.disabled = false;
        if (window.vicTurnstile) window.vicTurnstile.reset(form);
      });
    });
  }

  // ─── RENDER NEW & NOTABLE ───
  function renderNotable(items) {
    if (!items || !items.length) return '';
    return items.map(function (item) {
      var icon = iconSvg(ICON_KEYS.indexOf(item.icon) !== -1 ? item.icon : 'pin');
      var tagClass = item.tag === 'new' ? 'badge--new' : 'badge--coming';
      var tagText = item.tag === 'new' ? 'NEW' : 'COMING';
      return '<li class="notable-entry">' +
        '<span class="notable-icon" aria-hidden="true">' + icon + '</span>' +
        '<div class="notable-details">' +
          '<span class="badge ' + tagClass + '">' + tagText + '</span> ' +
          (safeHref(item.url)
            ? '<a class="notable-name" href="' + safeHref(item.url) + '" target="_blank" rel="noopener noreferrer">' + escHtml(item.name) + '</a>'
            : '<span class="notable-name">' + escHtml(item.name) + '</span>') +
          '<div class="notable-desc">' + escHtml(item.description) + '</div>' +
        '</div>' +
      '</li>';
    }).join('');
  }

  // A paid placement's order id (the sponsor block, a paid Vic's Pick), for
  // docs/track.js to count views and clicks. Same as adAttr in server/seo.js.
  function adAttr(id) {
    return /^[A-Za-z0-9-]{8,64}$/.test(id || '') ? ' data-ad="' + escHtml(id) + '"' : '';
  }

  // ─── RENDER SPONSOR ───
  function renderSponsor(sponsor) {
    if (!sponsor) return '';
    var ctaHtml = '';
    if (sponsor.cta) {
      var sponsorHref = sponsorLink(sponsor.url);
      if (sponsorHref) {
        ctaHtml = '<a href="' + sponsorHref + '" class="btn btn--outline sponsor-cta" target="_blank" rel="sponsored noopener">' + escHtml(sponsor.cta) + '</a>';
      } else {
        ctaHtml = '<span class="btn btn--outline" style="cursor:default; opacity:0.6">' + escHtml(sponsor.cta) + '</span>';
      }
    }
    return '<div class="sponsor-block"' + adAttr(sponsor.order) + '>' +
      '<div class="sponsor-label">This week\'s sponsor</div>' +
      (/^\/sponsor-logo\/[A-Za-z0-9-]{8,64}$/.test(sponsor.logo || '')
        ? '<img class="sponsor-logo" src="' + escHtml(sponsor.logo) + '" alt="' + escHtml(sponsor.name) + ' logo" loading="lazy">' : '') +
      '<div class="sponsor-name">' + escHtml(sponsor.name) + '</div>' +
      '<div class="sponsor-text">' + escHtml(sponsor.text) + '</div>' +
      (sponsor.address ? '<div class="sponsor-address">📍 ' + escHtml(sponsor.address) + '</div>' : '') +
      ctaHtml +
    '</div>';
  }

  // ─── HTML ESCAPE ───
  // Escapes quotes too: the result goes into attributes (href, data-*), and
  // a text node's innerHTML leaves " and ' alone.
  function escHtml(str) {
    if (str === null || str === undefined || str === '') return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ─── PREVIEW MODE ───
  // Admin's Preview tab loads this page in an iframe with ?previewKey=<key>;
  // the events live in sessionStorage under 'vic361_preview_<key>'. The old
  // ?preview=<json> form was removed: it let anyone craft a link that put
  // arbitrary markup on thevic361.com, and admin stopped generating it.
  var PREVIEW_STORAGE_PREFIX = 'vic361_preview_';

  function readPreviewData() {
    try {
      var params = new URLSearchParams(window.location.search);
      var key = params.get('previewKey');
      if (key) {
        var storageKey = PREVIEW_STORAGE_PREFIX + key;
        var raw = null;
        try { raw = sessionStorage.getItem(storageKey); } catch (e) {}
        if (!raw) {
          try { raw = localStorage.getItem(storageKey); } catch (e) {}
        }
        if (raw) return JSON.parse(raw);
      }
    } catch (err) {
      console.error('Failed to read preview data:', err);
    }
    return null;
  }

  function showPreviewIndicator() {
    if (document.getElementById('vic361-preview-banner')) return;
    var banner = document.createElement('div');
    banner.id = 'vic361-preview-banner';
    banner.textContent = 'Preview mode — showing unpublished admin picks';
    banner.setAttribute('role', 'status');
    banner.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0',
      'background:#2d5b8a', 'color:#fff',
      'font:600 12px/1.4 system-ui, sans-serif',
      'text-align:center', 'padding:6px 12px',
      'z-index:9999', 'letter-spacing:0.02em',
      'box-shadow:0 1px 4px rgba(0,0,0,0.2)'
    ].join(';');
    document.body.appendChild(banner);
    document.body.style.paddingTop = (banner.offsetHeight || 28) + 'px';
  }

  // ─── MAIN LOAD ───
  function loadAndRender() {
    var previewData = readPreviewData();
    var dataPromise;
    if (previewData) {
      showPreviewIndicator();
      dataPromise = Promise.resolve(previewData);
    } else {
      dataPromise = fetch('./events.json').then(function (res) {
        if (!res.ok) throw new Error('events.json HTTP ' + res.status);
        return res.json();
      }).then(function (data) {
        if (!data || !Array.isArray(data.events)) throw new Error('events.json has no events list');
        return data;
      });
    }
    dataPromise
      .then(function (data) {
        var container = document.getElementById('events-container');
        var notableList = document.getElementById('notable-list');
        var sponsorSection = document.getElementById('sponsor-section');
        var lastUpdatedEl = document.getElementById('last-updated');

        // Last updated
        if (data.last_updated && lastUpdatedEl) {
          var d = new Date(data.last_updated);
          lastUpdatedEl.textContent = 'Last updated: ' + d.toLocaleDateString('en-US', {
            weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
          }) + ' at ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        }

        // Build Mon–Sun of the current week in Victoria
        var todayStr = townToday();
        var dayOfWeek = dayAt(todayStr).getUTCDay(); // 0=Sun, 1=Mon … 6=Sat
        var monday = addDays(todayStr, dayOfWeek === 0 ? -6 : 1 - dayOfWeek);

        var days = [];
        for (var i = 0; i < 7; i++) days.push(addDays(monday, i));

        // The open day: today, else the week's first day still ahead
        // (openDay in server/seo.js).
        var openDate = days.indexOf(todayStr) !== -1 ? todayStr
          : (days.filter(function (d) { return d >= todayStr; })[0] || null);
        // Keep the server's Pick lines (pickPromptHtml in server/seo.js):
        // it knows the town's caps and prices, this page doesn't.
        var prompts = {};
        if (container) {
          container.querySelectorAll('.pick-prompt[data-date]').forEach(function (el) {
            prompts[el.getAttribute('data-date')] = el.outerHTML;
          });
        }
        var html = days.map(function (date, idx) {
          return renderDaySection(date, data.events || [], idx, openDate, prompts[date]);
        }).join('');

        container.innerHTML = html;
        applyFilter(currentFilter);
        openHashDay();
        markStuck();

        // ─── SKIP TO TODAY BUTTON ───
        var todayIdx = days.indexOf(todayStr);
        insertNewsletterCard(container, Math.max(todayIdx, 0));
        // Show button whenever today isn't Monday (idx 0)
        if (todayIdx > 0) {
          var skipBar = document.getElementById('skip-today-bar');
          if (skipBar) {
            var btn = document.createElement('button');
            btn.className = 'btn btn--primary skip-today-btn';
            btn.textContent = '↓ Skip to Today';
            btn.addEventListener('click', function () {
              var sec = document.getElementById('day-' + todayIdx);
              if (sec) {
                var fold = sec.querySelector('details');
                if (fold) fold.open = true;
                var stickyHeader = document.getElementById('site-header');
                var stickyHeight = (stickyHeader ? stickyHeader.offsetHeight : 0) + 8;
                var offset = sec.getBoundingClientRect().top + window.pageYOffset - stickyHeight;
                window.scrollTo({ top: offset, behavior: 'smooth' });
              }
            });
            skipBar.appendChild(btn);
            skipBar.hidden = false;
          }
        }

        // New & Notable
        // The section (and its divider) only shows when there's something in it.
        if (notableList) {
          var notableHtml = renderNotable(data.new_and_notable);
          notableList.innerHTML = notableHtml;
          var notableSection = document.getElementById('new-notable');
          if (notableSection) notableSection.hidden = !notableHtml;
        }

        // Sponsor
        // Only a paid sponsor: with none, the server's house ad stays put.
        if (sponsorSection && data.sponsor && data.sponsor.name) {
          sponsorSection.innerHTML = renderSponsor(data.sponsor);
        }
      })
      .catch(function (err) {
        console.error('Failed to load events:', err);
        // The server already rendered this week's list into the page; keep
        // it. Only show an error when there's nothing there to keep.
        var container = document.getElementById('events-container');
        if (container && !container.querySelector('.event-entry, .day-section, .day-card')) {
          container.innerHTML = '<p class="empty-state">Could not load events. Please try again later.</p>';
        }
      });
  }

  // ─── FILTERS ───
  // Chips above the list hide events that don't match. Pure client-side:
  // the server-rendered markup carries data-icons on every event.
  var FILTERS = [
    { key: 'all', label: 'All' },
    { key: 'weekend', label: 'This weekend' },
    { key: 'free', label: 'Free' },
    { key: 'family', label: 'Kids & Family' },
    { key: 'music', label: 'Music' },
    { key: 'food drinks', label: 'Food & Drink' },
    { key: 'arts', label: 'Arts' },
    { key: 'outdoors', label: 'Outdoors' }
  ];
  var currentFilter = 'all';

  function renderFilterBar() {
    var container = document.getElementById('events-container');
    if (!container || document.getElementById('event-filters')) return;
    var bar = document.createElement('div');
    bar.id = 'event-filters';
    bar.className = 'event-filters';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Filter events');
    bar.innerHTML = FILTERS.map(function (f) {
      return '<button type="button" class="filter-chip" data-filter="' + f.key + '" aria-pressed="' +
        (f.key === currentFilter) + '">' + f.label + '</button>';
    }).join('');
    container.parentNode.insertBefore(bar, container);
    bar.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-filter]');
      if (!btn) return;
      applyFilter(btn.getAttribute('data-filter'));
      if (typeof window.vic361Track === 'function') window.vic361Track('filter', { link_url: currentFilter });
    });
  }

  function applyFilter(key) {
    currentFilter = key || 'all';
    document.querySelectorAll('#event-filters [data-filter]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-filter') === currentFilter));
    });
    var wanted = currentFilter === 'all' || currentFilter === 'weekend' ? null : currentFilter.split(' ');
    document.querySelectorAll('#events-container .day-section').forEach(function (sec, idx) {
      // Day sections are Mon (0) … Sun (6); the weekend is Fri–Sun.
      var dayHidden = currentFilter === 'weekend' && idx < 4;
      var shown = 0;
      sec.querySelectorAll('.event-entry').forEach(function (li) {
        var icons = (li.getAttribute('data-icons') || '').split(' ');
        var match = !wanted || wanted.some(function (w) { return icons.indexOf(w) !== -1; });
        li.hidden = dayHidden || !match;
        if (!li.hidden) shown++;
      });
      var empty = sec.querySelector('.filter-empty');
      sec.hidden = dayHidden;
      // A filter opens the folded days that have something to show and
      // folds the rest; "All" leaves the days as they are.
      var fold = sec.querySelector('details');
      if (fold && currentFilter !== 'all' && !dayHidden) fold.open = shown > 0;
      if (!dayHidden && wanted && shown === 0 && sec.querySelector('.event-entry')) {
        if (!empty) {
          empty = document.createElement('div');
          empty.className = 'empty-state filter-empty';
          empty.textContent = sec.querySelector('.today-badge')
            ? 'Nothing in this category today.' : 'Nothing in this category on this day.';
          (sec.querySelector('details') || sec).appendChild(empty);
        }
        empty.hidden = false;
      } else if (empty) {
        empty.hidden = true;
      }
    });
  }

  // A link to one day (#day-3) opens it.
  function openHashDay() {
    var m = /^#day-\d$/.test(location.hash) && document.querySelector(location.hash + ' details');
    if (m) m.open = true;
  }
  window.addEventListener('hashchange', openHashDay);

  // Folding a day from its stuck header bar, partway down the day, would
  // leave you somewhere further down the page: bring its bar back into view.
  document.addEventListener('toggle', function (e) {
    var d = e.target;
    if (d.open || !d.closest || !d.closest('.day-section--fold')) return;
    var sec = d.closest('.day-section');
    var top = sec.getBoundingClientRect().top;
    var h = header ? header.offsetHeight : 0;
    if (top < h) window.scrollTo({ top: top + window.pageYOffset - h - 8 });
  }, true);

  // Server-rendered events are on the page before app.js re-renders them,
  // so the chips work immediately.
  renderFilterBar();
  openHashDay();
  applyFilter(currentFilter);

  // Expose a small surface for tests.
  if (typeof window !== 'undefined') {
    window.__vic361App = {
      readPreviewData: readPreviewData,
      showPreviewIndicator: showPreviewIndicator,
      PREVIEW_STORAGE_PREFIX: PREVIEW_STORAGE_PREFIX,
      applyFilter: applyFilter,
      escHtml: escHtml,
      safeHref: safeHref,
      sponsorLink: sponsorLink,
      formatTime: formatTime,
      timeMins: timeMins,
      renderEvent: renderEvent,
      renderSponsor: renderSponsor,
      today: townToday
    };
  }

  // The Icons Guide opens as a panel over the list; close it on a tap
  // outside it or Esc, like any other popover, instead of only on its button.
  var iconGuide = document.querySelector('.icon-guide');
  if (iconGuide) {
    document.addEventListener('click', function (e) {
      if (iconGuide.open && !iconGuide.contains(e.target)) iconGuide.open = false;
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && iconGuide.open) {
        iconGuide.open = false;
        var summary = iconGuide.querySelector('summary');
        if (summary) summary.focus();
      }
    });
  }

  // The server fills the footer year in; this covers the raw page it falls
  // back to when rendering fails.
  var yearEl = document.querySelector('[data-year]');
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadAndRender);
  } else {
    loadAndRender();
  }

})();
