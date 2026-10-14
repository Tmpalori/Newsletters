/* submit.js — Public event submission flow.
 *
 * Loads /api/config to discover whether Cloudflare Turnstile is required, and
 * if so injects the widget. Honeypot field + form-completion timer + a single
 * POST to /api/submissions handle the rest. The server is the source of truth
 * for validation, dedupe, rate limiting, and Turnstile verification — this
 * file is just a friendly UX layer.
 */
(function () {
  'use strict';

  const API_BASE = ''; // same-origin
  // Reset by "Submit another", so the next event's timer starts when its
  // blank form appears, not when the page first loaded.
  let formLoadTs = Date.now();
  let turnstileToken = null;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  // Errors used to be a small line of text under the field only; on a long
  // form the field was often off-screen, so "fix the highlighted fields"
  // pointed at nothing visible. Now the field is outlined, the message near
  // the button names the problems, and the page scrolls to the first one.
  // The message is tied to its field (aria-describedby) so a screen reader
  // reads the reason, not just "invalid".
  function showFieldError(name, msg) {
    const el = document.querySelector(`[data-error-for="${name}"]`);
    if (el) { el.textContent = msg || ''; el.id = 'err-' + name; }
    const input = document.querySelector(`#submit-form [name="${name}"]`);
    if (input) {
      input.setAttribute('aria-invalid', 'true');
      if (el) input.setAttribute('aria-describedby', el.id);
    }
  }
  function clearFieldError(name) {
    const el = document.querySelector(`[data-error-for="${name}"]`);
    if (el) el.textContent = '';
    const input = document.querySelector(`#submit-form [name="${name}"]`);
    if (input) { input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby'); }
  }
  function clearFieldErrors() {
    $$('.field-error').forEach(el => { el.textContent = ''; });
    $$('#submit-form [aria-invalid]').forEach(el => el.removeAttribute('aria-invalid'));
    $$('#submit-form [aria-describedby^="err-"]').forEach(el => el.removeAttribute('aria-describedby'));
    const fe = $('#form-error');
    if (fe) { fe.textContent = ''; fe.hidden = true; }
  }
  // Show every error, list them by the button, and bring the first into view.
  function showErrors(errors) {
    const names = Object.keys(errors);
    names.forEach(k => showFieldError(k, errors[k]));
    const msgs = names.map(k => errors[k]).filter(Boolean);
    showFormError(msgs.length ? 'Please fix: ' + msgs.join(' ') : 'Please fix the highlighted fields.');
    const first = names.map(k => document.querySelector(`#submit-form [name="${k}"]`)).find(Boolean);
    if (first) {
      if (first.scrollIntoView) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
      try { first.focus({ preventScroll: true }); } catch (e) { /* old browser */ }
    }
  }

  // The same required fields the server checks (server/validate.js), so
  // most mistakes are caught before anything is sent.
  const REQUIRED = [
    ['name', 'Event name is required.'], ['date', 'Date is required.'], ['time', 'Start time is required.'],
    ['venue', 'Venue is required.'], ['address', 'Address is required.'], ['description', 'Description is required.'],
    ['submitter_first_name', 'First name is required.'], ['submitter_last_name', 'Last name is required.'],
    ['submitter_email', 'Email is required.'], ['submitter_phone', 'Phone number is required.']
  ];
  function checkForm(body) {
    const errors = {};
    REQUIRED.forEach(([k, msg]) => { if (!String(body[k] || '').trim()) errors[k] = msg; });
    if (typeof body.free !== 'boolean') errors.free = 'Choose free or paid.';
    if (!errors.submitter_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.submitter_email.trim())) {
      errors.submitter_email = 'Email looks invalid.';
    }
    // 7+ digits, like the server: local and short international numbers are fine.
    if (!errors.submitter_phone && (body.submitter_phone.match(/\d/g) || []).length < 7) {
      errors.submitter_phone = 'Phone number looks invalid.';
    }
    return errors;
  }

  // A full US number becomes (361) 555-0123. Anything else (7-digit local,
  // international +44…, or an extension like "x12") is left as typed.
  function formatPhone(value) {
    if (/^\s*\+(?!1)/.test(value) || /[a-z#]/i.test(value)) return value;
    let d = value.replace(/\D/g, '');
    if (d.length === 11 && d[0] === '1') d = d.slice(1);
    if (d.length !== 10) return value;
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }
  function showFormError(msg) {
    const fe = $('#form-error');
    if (!fe) return;
    fe.textContent = msg;
    fe.hidden = false;
  }

  // Build the time options used by the start/end time selects. 30-minute
  // increments covering event hours (5:00 AM – 1:30 AM next day) keep the
  // list practical without forcing TBD on people who actually know. From
  // 5 AM, not 7: fun runs and sunrise services start at 6 or 6:30, and with
  // 7:00 AM the earliest choice they were published at the wrong time.
  function buildTimeOptions() {
    const out = [];
    // 5am through midnight, then 12:30am, 1:00am, 1:30am as late-night slots.
    const slots = [];
    for (let h = 5; h <= 23; h++) slots.push(h * 60, h * 60 + 30);
    slots.push(24 * 60, 24 * 60 + 30, 25 * 60, 25 * 60 + 30); // 12:00am, 12:30am, 1:00am, 1:30am
    for (const m of slots) {
      const hh = Math.floor(m / 60) % 24;
      const mm = m % 60;
      const ampm = hh < 12 ? 'AM' : 'PM';
      const h12 = ((hh + 11) % 12) + 1;
      const label = `${h12}:${String(mm).padStart(2, '0')} ${ampm}`;
      out.push(label);
    }
    return out;
  }

  function populateTimeSelects() {
    const opts = buildTimeOptions();
    const start = $('#f-time');
    const end = $('#f-end');
    if (start) {
      for (const t of opts) {
        const o = document.createElement('option');
        o.value = t; o.textContent = t;
        start.appendChild(o);
      }
    }
    if (end) {
      for (const t of opts) {
        const o = document.createElement('option');
        o.value = t; o.textContent = t;
        end.appendChild(o);
      }
    }
  }

  // Load Cloudflare Turnstile script and render the widget if a site key is
  // configured. Stores the resulting token via setTurnstileToken().
  function setTurnstileToken(t) { turnstileToken = t; }

  function injectTurnstile(siteKey) {
    if (!siteKey) return;
    if (window.turnstile && window.turnstile.render) {
      renderTurnstile(siteKey);
      return;
    }
    // Cloudflare exposes turnstile.render once the loader script is in.
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=__vic361TsReady';
    s.async = true; s.defer = true;
    window.__vic361TsReady = function () { renderTurnstile(siteKey); };
    document.head.appendChild(s);
  }

  function renderTurnstile(siteKey) {
    if (!window.turnstile || !window.turnstile.render) return;
    const mount = $('#f-turnstile');
    if (!mount) return;
    window.turnstile.render(mount, {
      sitekey: siteKey,
      callback: token => setTurnstileToken(token),
      'error-callback': () => setTurnstileToken(null),
      'expired-callback': () => setTurnstileToken(null)
    });
  }

  async function loadConfig() {
    try {
      const res = await fetch(API_BASE + '/api/config', { cache: 'no-store' });
      if (!res.ok) return null;
      return await res.json();
    } catch (_) { return null; }
  }

  function collectIcons() {
    return $$('input[name="icons"]:checked').map(el => el.value);
  }

  function collectForm() {
    // Scoped to the form: the page head has <meta name="description">, and an
    // unscoped [name="description"] lookup read that tag (no .value), so every
    // submission came back "Description is required."
    const get = name => {
      const el = document.querySelector(`#submit-form [name="${name}"]`);
      return el && el.value != null ? el.value : '';
    };
    // No default: a paid show sent with an untouched "Free" would be listed
    // as free (and marked free in Google's event data). null = not chosen.
    const cost = (document.querySelector('input[name="free"]:checked') || {}).value;
    const free = cost === 'true' ? true : cost === 'false' ? false : null;
    const submitter_kind = (document.querySelector('input[name="submitter_kind"]:checked') || {}).value || 'other';
    const first = get('submitter_first_name');
    const last = get('submitter_last_name');
    const combinedName = [first, last].map(s => (s || '').trim()).filter(Boolean).join(' ');
    return {
      name: get('name'),
      date: get('date'),
      time: get('time'),
      end_time: get('end_time'),
      venue: get('venue'),
      address: get('address'),
      url: get('url'),
      description: get('description'),
      icons: collectIcons(),
      free,
      submitter_kind,
      submitter_first_name: first,
      submitter_last_name: last,
      submitter_name: combinedName,
      submitter_email: get('submitter_email'),
      submitter_phone: get('submitter_phone'),
      hp_field: get('hp_field'),
      elapsed_ms: Date.now() - formLoadTs,
      turnstile_token: turnstileToken
    };
  }

  async function handleSubmit(e) {
    e.preventDefault();
    clearFieldErrors();
    const body = collectForm();
    const local = checkForm(body);
    if (Object.keys(local).length) { showErrors(local); return; }
    const btn = $('#submit-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }

    let res, json;
    try {
      res = await fetch(API_BASE + '/api/submissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      json = await res.json().catch(() => null);
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = 'Submit for review'; }
      showFormError('Could not reach the server. Try again in a moment.');
      return;
    }

    if (!res.ok || !json || json.ok === false) {
      if (btn) { btn.disabled = false; btn.textContent = 'Submit for review'; }
      if (json && json.errors) {
        showErrors(json.errors);
      } else if (json && json.error === 'turnstile-failed') {
        showFormError('We couldn\'t verify you aren\'t a bot. Try the challenge again.');
        if (window.turnstile && window.turnstile.reset) window.turnstile.reset();
      } else if (res.status === 429) {
        showFormError('Too many submissions from your network. Try again later.');
      } else {
        showFormError('Something went wrong. Please try again.');
      }
      return;
    }

    // Success branch. Offer the paid upgrade with this event prefilled:
    // the link names the new submission and server/sponsors.js fills in the
    // form, so no contact details end up in the URL. A duplicate has no id
    // of ours; prefill just the event.
    const promo = $('#thanks-promo-link');
    if (promo) {
      const q = new URLSearchParams({ package: 'featured' });
      if (json.id) q.set('from', json.id);
      else {
        const add = (k, v) => { if (v) q.set(k, String(v).slice(0, 2000)); };
        add('event_name', body.name); add('date', body.date); add('time', body.time);
        add('venue', body.venue); add('address', body.address); add('url', body.url);
      }
      promo.href = '/advertise/checkout?' + q.toString();
    }
    const emailNote = $('#thanks-email');
    if (emailNote) emailNote.hidden = !(body.submitter_email && !json.duplicate);
    const card = $('#form-card');
    const thanks = $('#thanks-card');
    if (card) card.hidden = true;
    if (thanks) {
      thanks.hidden = false;
      const msg = $('#thanks-message');
      showReach(json.duplicate);
      if (json.duplicate && msg) {
        msg.textContent = 'Looks like a matching submission was already in our queue. We\'ll review it soon.';
      } else if (json.queued === false && msg) {
        msg.textContent = 'Got it — we\'ll take a look.';
      }
    }
  }

  // How many people it goes in front of (GET /api/reach: rounded, null while
  // small). Not for a duplicate, and nothing if it can't be read.
  function showReach(duplicate) {
    const el = $('#thanks-reach');
    if (!el || duplicate) return;
    fetch('/api/reach').then(r => (r.ok ? r.json() : null)).then((j) => {
      if (!j || !j.readers) return;
      el.textContent = 'Once it\'s live, it\'s in front of the ' + j.readers.toLocaleString('en-US') + ' people who used the site this past week.';
      el.hidden = false;
    }).catch(() => null);   // the line is a bonus; the thank-you shows without it
  }

  function wireResetForAnother() {
    const btn = $('#submit-another');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const card = $('#form-card');
      const thanks = $('#thanks-card');
      const form = $('#submit-form');
      if (form) form.reset();
      formLoadTs = Date.now();
      // reset() fires no input events and empties the date, so put today
      // back and redraw the preview.
      setDefaultDate();
      updatePreview();
      clearFieldErrors();
      if (window.turnstile && window.turnstile.reset) window.turnstile.reset();
      setTurnstileToken(null);
      if (card) card.hidden = false;
      if (thanks) thanks.hidden = true;
      const subBtn = $('#submit-btn');
      if (subBtn) { subBtn.disabled = false; subBtn.textContent = 'Submit for review'; }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  // Live preview of the listing as they type: same pieces as the site's
  // event row (day card, time pill, icons, name, venue, free tag, blurb).
  const DAY_COLORS = ['#FF8A80', '#FFC93C', '#8FD3FF', '#FF8FC0', '#3DBE8B', '#FF7A3D', '#B9A6FF']; // Sun..Sat
  function updatePreview() {
    const get = n => { const el = document.querySelector(`#submit-form [name="${n}"]`); return el ? el.value.trim() : ''; };
    const text = (id, v, fallback) => { const el = document.getElementById(id); if (el) el.textContent = v || fallback; };
    const date = get('date');
    const day = $('#sp-day') && $('#sp-day').closest('.sp-day');
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const d = new Date(date + 'T12:00:00');
      text('sp-day', d.toLocaleDateString('en-US', { weekday: 'long' }));
      text('sp-date', d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' }));
      if (day) day.style.setProperty('--sp-color', DAY_COLORS[d.getDay()]);
    } else {
      text('sp-day', '', 'Your event’s day'); text('sp-date', '', '');
    }
    const t = get('time'); const end = get('end_time');
    const timeEl = $('#sp-time');
    if (timeEl) { timeEl.hidden = !t; timeEl.textContent = t ? (end ? `${t} – ${end}` : t) : ''; }
    text('sp-name', get('name'), 'Your event name');
    text('sp-venue', get('venue'), 'Venue');
    const desc = get('description');
    text('sp-desc', desc.length > 220 ? desc.slice(0, 217) + '…' : desc, 'Your description shows here.');
    const free = (document.querySelector('input[name="free"]:checked') || {}).value === 'true';
    const freeEl = $('#sp-free'); if (freeEl) freeEl.hidden = !free;
    const icons = $('#sp-icons');
    if (icons) {
      icons.textContent = '';
      collectIcons().concat(free ? ['free'] : []).slice(0, 3).forEach(k => {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'sp-ico'); svg.setAttribute('aria-hidden', 'true');
        const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        use.setAttribute('href', '/icons.svg#i-' + k);
        svg.appendChild(use); icons.appendChild(svg);
      });
    }
  }

  // A link from us (a reply to someone who emailed an event in) can carry
  // the details they already sent: /submit?name=…&date=…&venue=… . Event
  // fields only: their name and email never go in a link. Set as values
  // (never markup); the time selects take only one of their own options.
  const PREFILL = ['name', 'date', 'time', 'end_time', 'venue', 'address', 'url', 'description'];
  function prefillFromLink() {
    let q;
    try { q = new URLSearchParams(location.search); } catch (e) { return; }
    PREFILL.forEach(k => {
      const v = (q.get(k) || '').slice(0, k === 'description' ? 2000 : 300);
      const el = document.querySelector(`#submit-form [name="${k}"]`);
      if (!v || !el) return;
      if (k === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
      if (el.tagName === 'SELECT' && !Array.from(el.options).some(o => o.value === v)) return;
      el.value = v;
    });
  }

  // Pre-fill date with today (local) so users don't have to pick a year first.
  function setDefaultDate() {
    const dateEl = $('#f-date');
    if (dateEl && !dateEl.value) {
      const d = new Date();
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      dateEl.value = `${y}-${m}-${day}`;
    }
  }

  async function init() {
    populateTimeSelects();
    const form = $('#submit-form');
    if (form) {
      form.addEventListener('submit', handleSubmit);
      // Fixing a field clears its error right away.
      form.addEventListener('input', ev => { if (ev.target && ev.target.name) clearFieldError(ev.target.name); updatePreview(); });
      form.addEventListener('change', ev => { if (ev.target && ev.target.name) clearFieldError(ev.target.name); updatePreview(); });
    }
    // Fill the preview once the date default below is in.
    setTimeout(updatePreview, 0);
    const phone = $('#f-sub-phone');
    if (phone) {
      // Format while typing at the end (but not on a trailing space, so
      // " x12" can be typed); always tidy it when they leave.
      phone.addEventListener('input', () => {
        if (phone.selectionStart === phone.value.length && !/\s$/.test(phone.value)) phone.value = formatPhone(phone.value);
      });
      phone.addEventListener('blur', () => { phone.value = formatPhone(phone.value); });
    }
    wireResetForAnother();

    prefillFromLink();
    setDefaultDate();

    const cfg = await loadConfig();
    if (cfg && cfg.turnstile_site_key) {
      injectTurnstile(cfg.turnstile_site_key);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Test hook — exposes the form collector + token setter for jsdom tests.
  if (typeof window !== 'undefined') {
    window.__vic361Submit = {
      collectForm, setTurnstileToken, buildTimeOptions, populateTimeSelects,
      checkForm, showErrors, formatPhone, updatePreview
    };
  }
})();
