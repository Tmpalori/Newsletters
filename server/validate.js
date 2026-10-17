/* server/validate.js — Submission validation + light sanitization.
 *
 * Anything in here runs BEFORE we touch the DB and BEFORE Turnstile (cheap
 * rejects first). Sanitization strips control chars, caps lengths, and
 * normalizes booleans, but does NOT attempt to scrub HTML — payloads are only
 * rendered through escapeHtml() in the admin UI and as plain text in the
 * public site, never inserted as raw HTML.
 */

import { normalizeEmail } from './newsletter.js';
import { impossibleEmailError } from './emailTypos.js';
import { honeypotHit } from './honeypot.js';

const MAX_NAME = 200;
const MAX_VENUE = 200;
const MAX_ADDRESS = 300;
const MAX_DESC = 2000;
const MAX_URL = 500;
const MAX_TIME = 60;
const MAX_EMAIL = 254;
const MAX_SUBMITTER_NAME = 120;
const MAX_SUBMITTER_NAME_PART = 60;
const MAX_PHONE = 40;

const ALLOWED_ICONS = new Set([
  'food', 'music', 'family', 'drinks', 'arts',
  'shopping', 'outdoors', 'community', 'free'
]);

const ALLOWED_SUBMITTER_KIND = new Set(['organizer', 'found_online', 'other']);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// Accepts http(s)://host/... — used to validate the URL after scheme
// normalization (we add https:// when the user supplied a bare host like
// example.com, so the stored value is always a usable absolute URL).
// No quotes or angle brackets: the URL ends up inside an href attribute.
const URL_RE = /^https?:\/\/[^\s"'<>]+$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Phone: at least 7 digits when punctuation/spaces are stripped. Permissive on
// formatting (parentheses, dashes, dots, +, spaces) so users aren't forced into
// a specific style.
const PHONE_DIGIT_RE = /\d/g;

// Strip ASCII control chars (\x00-\x1F minus \t\n, plus DEL) before trim/cap.
const CONTROL_CHARS = new RegExp('[\\x00-\\x08\\x0B-\\x1F\\x7F]', 'g');

function clean(s, max) {
  if (s == null) return '';
  return String(s).replace(CONTROL_CHARS, '').trim().slice(0, max);
}

// Normalize a user-entered URL. If the user typed `example.com` or
// `www.example.com` we add `https://` so the stored value is a usable absolute
// URL. Existing http:// or https:// inputs are passed through unchanged.
// Returns '' for empty input.
export function normalizeUrl(raw) {
  const s = clean(raw, MAX_URL);
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  // Reject obvious non-http schemes (javascript:, data:, mailto:, etc.) — we
  // only auto-prepend https:// to inputs that look like a bare host/path.
  if (/^[a-z][a-z0-9+\-.]*:/i.test(s)) return s; // leave intact; URL_RE check below will reject
  return 'https://' + s;
}

export function validateSubmission(input, opts = {}) {
  // adminEdit: true relaxes the submitter contact requirements (first/last
  // name, email, phone). The public submit form still enforces them via the
  // default mode; the admin edit view shouldn't be blocked when a legacy row
  // (created before PR #32 made those fields required) lacks them, and an
  // admin editing event details shouldn't have to retype someone else's
  // contact info to save a typo fix on the venue. Format is still validated
  // when a value is provided.
  const adminEdit = Boolean(opts.adminEdit);
  const errors = {};
  if (!input || typeof input !== 'object') {
    return { ok: false, errors: { _form: 'Invalid request body.' } };
  }

  const name = clean(input.name, MAX_NAME);
  if (!name) errors.name = 'Event name is required.';
  else if (name.length < 3) errors.name = 'Event name is too short.';

  const date = clean(input.date, 10);
  if (!date) errors.date = 'Date is required.';
  else if (!ISO_DATE.test(date)) errors.date = 'Date must look like YYYY-MM-DD.';
  else {
    // Round-trip it: new Date rolls 2026-11-31 over to Dec 1 instead of
    // failing, and an event on a day that doesn't exist is on no day list.
    const d = new Date(date + 'T12:00:00Z');
    if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) errors.date = 'Date is invalid.';
  }

  const time = clean(input.time, MAX_TIME);
  if (!time) errors.time = 'Start time is required.';

  const end_time = clean(input.end_time, MAX_TIME);

  const venue = clean(input.venue, MAX_VENUE);
  if (!venue) errors.venue = 'Venue is required.';

  const address = clean(input.address, MAX_ADDRESS);
  if (!address) errors.address = 'Address is required.';

  const description = clean(input.description, MAX_DESC);
  if (!description) errors.description = 'Description is required.';

  // URL: optional. If supplied, accept bare hosts (example.com,
  // www.example.com) by prepending https:// before validating.
  const rawUrl = clean(input.url, MAX_URL);
  let url = '';
  if (rawUrl) {
    url = normalizeUrl(rawUrl);
    if (!URL_RE.test(url)) {
      errors.url = 'Link must be a valid website (e.g. example.com).';
    }
  }

  let icons = [];
  if (Array.isArray(input.icons)) {
    icons = input.icons
      .map(c => clean(c, 32).toLowerCase())
      .filter(c => ALLOWED_ICONS.has(c));
    icons = Array.from(new Set(icons)).slice(0, 8);
  }

  const free = Boolean(input.free);
  if (free && !icons.includes('free')) icons.push('free');

  // Submitter contact: first/last/email/phone are now all required. We keep
  // submitter_name (concatenated) populated for backward compatibility with
  // existing storage and admin code; the parts live on the payload so future
  // schema work can split them out without losing data.
  const submitter_first_name = clean(input.submitter_first_name, MAX_SUBMITTER_NAME_PART);
  const submitter_last_name = clean(input.submitter_last_name, MAX_SUBMITTER_NAME_PART);
  if (!adminEdit) {
    if (!submitter_first_name) errors.submitter_first_name = 'First name is required.';
    if (!submitter_last_name) errors.submitter_last_name = 'Last name is required.';
  }

  let submitter_name = clean(input.submitter_name, MAX_SUBMITTER_NAME);
  if (!submitter_name) {
    submitter_name = [submitter_first_name, submitter_last_name].filter(Boolean).join(' ').slice(0, MAX_SUBMITTER_NAME);
  }

  const submitter_email = clean(input.submitter_email, MAX_EMAIL);
  if (!submitter_email) {
    if (!adminEdit) errors.submitter_email = 'Email is required.';
  } else if (!EMAIL_RE.test(submitter_email) || (!adminEdit && !normalizeEmail(submitter_email))) {
    // The public form also gets the newsletter's stricter check:
    // "bob@gmail.com." or "bob@gmail..com" passed the loose regex, then
    // Resend refused every "you're live" email to it. Not on an admin edit,
    // so a row saved before this can still have its event details fixed.
    errors.submitter_email = 'Email looks invalid.';
  } else if (!adminEdit && impossibleEmailError(submitter_email)) {
    // "...@gmail.comm" passes both checks, then every email to it bounces
    // (server/emailTypos.js). Say what to fix.
    errors.submitter_email = impossibleEmailError(submitter_email);
  }

  const submitter_phone = clean(input.submitter_phone, MAX_PHONE);
  if (!submitter_phone) {
    if (!adminEdit) errors.submitter_phone = 'Phone number is required.';
  } else {
    const digits = (submitter_phone.match(PHONE_DIGIT_RE) || []).length;
    if (digits < 7) errors.submitter_phone = 'Phone number looks invalid.';
  }

  let submitter_kind = clean(input.submitter_kind, 32).toLowerCase();
  if (!submitter_kind) submitter_kind = 'other';
  if (!ALLOWED_SUBMITTER_KIND.has(submitter_kind)) {
    submitter_kind = 'other';
  }

  if (Object.keys(errors).length) return { ok: false, errors };

  return {
    ok: true,
    data: {
      payload: {
        name, date, time, end_time, venue, address, description, url,
        icons, free,
        submitter_first_name, submitter_last_name, submitter_phone
      },
      submitter_name,
      submitter_email,
      submitter_kind
    }
  };
}

// Validate an admin-applied event edit. The admin event editor (PR #22) lets
// an operator correct details on a candidate or already-picked event without
// pushing those edits through the public submission shape (no submitter
// contact info needed). Required: name, date, time, venue, description.
// Optional: end_time, address, url, icons[], free.
//
// timeOptional: the event being edited never had a start time (about a
// quarter of collected events don't). The renderers treat '' as unknown,
// and forcing one means inventing a time that then shows on the page, the
// .ics and the JSON-LD; the owner may only be fixing a date or a link.
//
// Returns { ok, data } on success or { ok: false, errors } with a per-field
// error map suitable for surfacing in the admin UI.
export function validateEventEdit(input, { timeOptional = false } = {}) {
  const errors = {};
  if (!input || typeof input !== 'object') {
    return { ok: false, errors: { _form: 'Invalid request body.' } };
  }

  const name = clean(input.name, MAX_NAME);
  if (!name) errors.name = 'Event name is required.';
  else if (name.length < 3) errors.name = 'Event name is too short.';

  const date = clean(input.date, 10);
  if (!date) errors.date = 'Date is required.';
  else if (!ISO_DATE.test(date)) errors.date = 'Date must look like YYYY-MM-DD.';
  else {
    // Round-trip it: new Date rolls 2026-11-31 over to Dec 1 instead of
    // failing, and an event on a day that doesn't exist is on no day list.
    const d = new Date(date + 'T12:00:00Z');
    if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) errors.date = 'Date is invalid.';
  }

  const time = clean(input.time, MAX_TIME);
  if (!time && !timeOptional) errors.time = 'Start time is required.';

  const end_time = clean(input.end_time, MAX_TIME);

  const venue = clean(input.venue, MAX_VENUE);
  if (!venue) errors.venue = 'Venue is required.';

  const address = clean(input.address, MAX_ADDRESS);

  const description = clean(input.description, MAX_DESC);
  if (!description) errors.description = 'Description is required.';

  const rawUrl = clean(input.url, MAX_URL);
  let url = '';
  if (rawUrl) {
    url = normalizeUrl(rawUrl);
    if (!URL_RE.test(url)) {
      errors.url = 'Link must be a valid website (e.g. example.com).';
    }
  }

  let icons = [];
  if (Array.isArray(input.icons)) {
    icons = input.icons
      .map(c => clean(c, 32).toLowerCase())
      .filter(c => ALLOWED_ICONS.has(c));
    icons = Array.from(new Set(icons)).slice(0, 8);
  }

  const free = Boolean(input.free);
  if (free && !icons.includes('free')) icons.push('free');

  // Paid featured listing: highlighted on its day on the public site.
  const featured = Boolean(input.featured);

  if (Object.keys(errors).length) return { ok: false, errors };

  return {
    ok: true,
    data: {
      name, date, time, end_time, venue, address, description, url,
      icons, free, featured
    }
  };
}

// Honeypot: a hidden field (server/honeypot.js; "company" before) no real
// user fills. Combined with
// elapsed_ms (time from form render to submit), we get a cheap bot filter.
// Only too-fast counts: there is no upper bound, because an organizer who
// leaves the tab open over lunch (or enters a series with "Submit another")
// is a person, and a dropped submission answers "Got it" and is lost without
// a trace. Turnstile and the rate limits already cover slow bots.
export function checkBotSignals(input, opts = {}) {
  const minMs = opts.minMs ?? 1500;
  const field = honeypotHit(input);
  if (field) return { ok: false, reason: 'honeypot', field };
  const elapsed = Number(input && input.elapsed_ms);
  if (Number.isFinite(elapsed)) {
    if (elapsed < minMs) return { ok: false, reason: 'too-fast' };
  }
  return { ok: true };
}

export const _internal = {
  ALLOWED_ICONS, ALLOWED_SUBMITTER_KIND, ISO_DATE, URL_RE, EMAIL_RE
};
