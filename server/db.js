/* server/db.js — Submission storage with two backends.
 *
 * If DATABASE_URL is set we use Postgres (Railway-style). Otherwise we fall
 * back to a JSON file on disk so local dev and Railway preview deploys without
 * a DB attached still work. The fallback keeps the API surface identical so
 * route handlers don't branch.
 *
 * Submissions schema (logical):
 *   id              text    — uuid-like
 *   created_at      iso     — server clock
 *   updated_at      iso
 *   status          text    — pending | approved | rejected | duplicate
 *   source          text    — submission | local | scraper | candidate | etc.
 *   submitter_kind  text    — organizer | found_online | other
 *   submitter_name  text
 *   submitter_email text
 *   payload         json    — public event fields (name, date, time, venue, ...)
 *   admin_notes     text
 *   review_history  json[]  — [{ at, action, note }]
 *
 * The payload column owns the public-facing event shape and matches the keys
 * used in candidates.json / docs/events.json (date, name, time, venue,
 * address, url, description, icons, free) so the admin can promote a row to a
 * publishable event without remapping fields.
 *
 * Event edits overlay (PR #22): admins can correct mistakes the AI made on
 * candidate events (typos, wrong times, missing end_time, etc.) without
 * forcing a re-collect. Each overlay is keyed by the ORIGINAL event key
 * (date|name|venue) so we can find the candidate to replace even when the
 * edit changes one of those fields.
 *
 *   id             text    — same as original_key
 *   original_key   text    — date|name|venue at time of first edit
 *   payload        json    — full edited event (date, name, time, venue, ...)
 *   updated_at     iso
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_FILE = path.resolve(process.cwd(), 'data', 'submissions.json');

function newId() {
  // randomUUID exists in Node 18+ and is collision-safe enough for our scale.
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

// Soft bounces (server/inbound.js): a full mailbox or a greylist isn't a dead
// address, but one that soft-bounces issue after issue is, and mailing it
// forever wears down the sending domain's reputation with Gmail and Yahoo.
// `limit` soft bounces in a run, spread over at least `minSpanMs` (a mailbox
// full for a week, not one bad afternoon), and the address is marked bounced.
// Bounces within `sameSendMs` of the last one count once (Resend retrying one
// email, or two emails out the same day). The run starts over after a
// delivery (email.delivered) or, if those aren't sent, after `resetMs` with
// no soft bounce.
export const SOFT_BOUNCE = {
  limit: 4,
  minSpanMs: 7 * 24 * 3600 * 1000,
  sameSendMs: 12 * 3600 * 1000,
  resetMs: 30 * 24 * 3600 * 1000
};
const SOFT_BOUNCE_CLEAR = { soft_bounces: 0, soft_bounce_first_at: null, soft_bounce_last_at: null };

// Normalize a payload into the canonical event shape used by the rest of the
// site so admin promotion is a straight copy. Trims strings to sane lengths
// (defense-in-depth on top of route validation).
// The public copy of an approved submission: the submitter's name and
// phone stay in the review queue, never in the published list.
export function withoutSubmitter(ev) {
  const out = {};
  for (const [k, v] of Object.entries(ev || {})) if (!k.startsWith('submitter_')) out[k] = v;
  return out;
}

export function normalizePayload(input) {
  const s = (v, max = 500) => {
    if (v == null) return '';
    return String(v).trim().slice(0, max);
  };
  const icons = Array.isArray(input.icons)
    ? input.icons.map(c => s(c, 32)).filter(Boolean).slice(0, 8)
    : [];
  return {
    date: s(input.date, 10),
    name: s(input.name, 200),
    time: s(input.time, 60),
    end_time: s(input.end_time, 60),
    venue: s(input.venue, 200),
    address: s(input.address, 300),
    url: s(input.url, 500),
    description: s(input.description, 2000),
    icons,
    free: Boolean(input.free),
    submitter_first_name: s(input.submitter_first_name, 60),
    submitter_last_name: s(input.submitter_last_name, 60),
    submitter_phone: s(input.submitter_phone, 40)
  };
}

// Canonical "event identity" key used everywhere in the codebase to dedupe
// candidates and detect duplicate submissions. Keep in sync with the
// browser-side eventKey() in docs/admin.js.
export function eventKeyOf(ev) {
  if (!ev) return '||';
  return [ev.date || '', ev.name || '', ev.venue || ''].join('|');
}

// Split an eventKeyOf key back into its parts, or null when it isn't one.
// eventKeyOf doesn't escape '|', and real names carry it ("Foodies + New
// Friends: Victoria | Dinner Meetup"), so the date ends at the first '|'
// and the venue starts after the last; the name is everything between.
export function parseEventKey(key) {
  const s = String(key || '');
  const first = s.indexOf('|');
  const last = s.lastIndexOf('|');
  if (first === -1 || last === first) return null;
  const date = s.slice(0, first);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return { date, name: s.slice(first + 1, last), venue: s.slice(last + 1) };
}

// JSON for a JSONB column. Postgres refuses a \u0000 anywhere in jsonb, so
// one NUL in a scraped description would fail the whole publish; drop it.
// It refuses a lone UTF-16 surrogate too (JSON.stringify writes one as a
// "\ud83d" escape): a source that cut a description mid-emoji, or a
// .slice() that split a pair, would fail it the same way. toWellFormed
// turns those into U+FFFD and leaves real pairs alone.
export function toJsonb(value) {
  return JSON.stringify(value, (_k, v) => {
    if (typeof v !== 'string') return v;
    const clean = v.includes('\u0000') ? v.replace(/\u0000/g, '') : v;
    return clean.isWellFormed() ? clean : clean.toWellFormed();
  });
}

// Apply the admin event-edits overlay on top of a list of events. For each
// event matching an edit's original_key (or current key), replace it with the
// edited payload. New keys produced by an edit replace any existing event
// that would otherwise collide so the admin sees a single corrected row.
//
// Edits chain: before resolveEditKey, a second edit of an edited event was
// stored under the edited key (the only key the admin sees), so such a row
// is applied after the one that produced its key, up to EDIT_CHAIN_HOPS.
const EDIT_CHAIN_HOPS = 5;
export function applyEventEdits(events, edits) {
  if (!Array.isArray(events) || !edits || !edits.length) return events || [];
  const byOriginal = new Map();
  for (const e of edits) {
    if (e && e.original_key) byOriginal.set(e.original_key, e);
  }
  const seen = new Set();
  const out = [];
  for (const ev of events) {
    let merged = ev;
    const used = new Set();
    for (let hop = 0; hop < EDIT_CHAIN_HOPS; hop++) {
      const k = eventKeyOf(merged);
      const edit = byOriginal.get(k);
      if (!edit || used.has(k)) break; // a cycle (A→B, B→A) stops here
      used.add(k);
      merged = { ...merged, ...edit.payload };
    }
    const newKey = eventKeyOf(merged);
    if (seen.has(newKey)) continue;
    seen.add(newKey);
    out.push(merged);
  }
  return out;
}

// The key an edit should be stored under. The admin only sees events with
// the overlay applied, so a second edit of an edited event arrives with the
// edited key; stored under that, it never matched the original event and
// the correction silently didn't show. Follow edited keys back to the
// original one (a few hops for rows stored the old way), unless an edit
// row already exists under the key as given, or the published list stores
// an event under it (`storedKeys`): Save & Publish writes the edited shape,
// so after one the edited key *is* the stored identity, and an edit sent
// back to the original key would never match the live event.
export function resolveEditKey(edits, key, storedKeys = null) {
  const rows = Array.isArray(edits) ? edits : [];
  if (rows.some(e => e && e.original_key === key)) return key;
  if (storedKeys && storedKeys.has(key)) return key;
  let target = key;
  const seen = new Set([key]);
  for (let hop = 0; hop < EDIT_CHAIN_HOPS; hop++) {
    const from = rows.find(e => e && e.original_key && !seen.has(e.original_key) && eventKeyOf(e.payload) === target);
    if (!from) break;
    target = from.original_key;
    seen.add(target);
  }
  return target;
}

// One read-modify-write of the published payload at a time. Every writer
// (auto-publish in both modes, Save & Publish, unpublish/replace/forget,
// keep, hide/restore, the edit's kept-key move) reads the whole payload,
// changes its part and writes the whole thing back; two overlapping (a boot
// auto-publish and an AI-review approval seconds after a deploy) meant the
// last write silently undid the other. The site runs as one process, so an
// in-process queue per store is enough. `fn` must not call another writer
// (it would wait on itself).
const publishedLocks = new WeakMap();
export function withPublishedLock(store, fn) {
  const prev = publishedLocks.get(store) || Promise.resolve();
  const run = prev.then(() => fn());
  // The queue continues whether this writer succeeded or not.
  publishedLocks.set(store, run.then(() => {}, () => {}));
  return run;
}

// ─── JSON FILE BACKEND ───
const FILE_TRAFFIC_CAP = 50000;

function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

// Referral codes (thevic361.com/r/<code>): short enough to read out loud, no
// look-alike characters. Not a secret like the token: it only credits
// signups, it can't confirm or unsubscribe anyone.
const REF_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
// A referred subscriber counts once they've been on the list this long.
export const REF_HOLD_HOURS = 24;
export function newRefCode() {
  const bytes = crypto.randomBytes(7);
  let out = '';
  for (const b of bytes) out += REF_ALPHABET[b % REF_ALPHABET.length];
  return out;
}

// One inbox, one key: john+1@gmail.com, j.ohn@gmail.com and
// john@googlemail.com all land in the same Gmail inbox, so for counting
// referrals they're one person. Most providers ignore a +tag; only Gmail
// ignores dots.
export function emailKey(email) {
  const s = String(email || '').toLowerCase();
  const at = s.lastIndexOf('@');
  if (at < 1) return s;
  const domain = s.slice(at + 1) === 'googlemail.com' ? 'gmail.com' : s.slice(at + 1);
  let local = s.slice(0, at).split('+')[0];
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

// { code: { counted, all } } (Sets of emailKeys) from the active subscribers
// each code brought in (listReferredFriends rows, every code). A friend
// counts once they've been on the list REF_HOLD_HOURS; one inbox counts
// once across ALL codes (the earliest to sign it up gets it, so someone
// with several +tag addresses can't count the same friends under each);
// and the referrer's own inbox under another +tag never counts.
export function tallyReferrals(friends, now = Date.now()) {
  const cutoff = now - REF_HOLD_HOURS * 3600e3;
  const out = {};
  const claimed = new Set();
  const when = f => (f.confirmed_at ? new Date(f.confirmed_at).getTime() : Infinity);
  for (const f of [...friends].sort((a, b) => when(a) - when(b))) {
    const key = emailKey(f.email);
    if (f.referrer_email && emailKey(f.referrer_email) === key) continue;
    if (claimed.has(key)) continue;
    claimed.add(key);
    const t = out[f.referred_by] || (out[f.referred_by] = { counted: new Set(), all: new Set() });
    t.all.add(key);
    if (f.confirmed_at && new Date(f.confirmed_at).getTime() <= cutoff) t.counted.add(key);
  }
  return out;
}

function referralCounts(tally, counted) {
  const out = {};
  for (const [code, t] of Object.entries(tally)) {
    const n = (counted ? t.counted : t.all).size;
    if (n) out[code] = n;
  }
  return out;
}

// Admin view: counted referrals plus the ones still in the hold.
function referrerRows(tally, referrers, limit) {
  return referrers.filter(x => tally[x.ref_code] && tally[x.ref_code].all.size)
    .map(x => {
      const t = tally[x.ref_code];
      return { email: x.email, ref_code: x.ref_code, referrals: t.counted.size,
        pending: [...t.all].filter(k => !t.counted.has(k)).length, ref_tier: Number(x.ref_tier) || 0 };
    })
    .sort((a, b) => b.referrals - a.referrals || b.pending - a.pending || a.email.localeCompare(b.email)).slice(0, limit);
}
// Postgres keeps a bit over a year of traffic; older rows are pruned.
const TRAFFIC_RETENTION_DAYS = 400;
// Archived event pages are kept as long, then pruned: every public page
// reads the archive (guides, venues), so it can't grow forever.
export const ARCHIVE_RETENTION_DAYS = 400;

function archiveCutoff() {
  return new Date(Date.now() - ARCHIVE_RETENTION_DAYS * 86400000).toISOString().slice(0, 10);
}

// Why an admin import must leave an existing subscriber alone, or null. An
// import counts as an opt-in from elsewhere, which can't override an opt-out
// here (CAN-SPAM): unsubscribed (a spam complaint is an unsubscribe),
// bounced (a dead address), or a comeback still waiting to confirm
// (old_tokens: they unsubscribed or bounced before, and anyone can type an
// address into the form, which only sends that inbox a confirm email). The
// value names the import result's counter.
export function importSkip(sub) {
  if (!sub || sub.status === 'active') return null;
  if (sub.status === 'bounced') return 'skipped_bounced';
  if (sub.status === 'unsubscribed' || (sub.old_tokens || []).length) return 'skipped_unsubscribed';
  return null;
}

class FileStore {
  constructor(file) {
    this.file = file || DEFAULT_FILE;
    this._writeLock = Promise.resolve();
  }

  async _read() {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
        return { submissions: [], published: null, event_edits: [], event_archive: {}, traffic: [], subscribers: [], newsletter_sends: [], email_opens: [], referral_rewards: [], sponsor_orders: [], subscriber_counts: [] };
      }
      if (!Array.isArray(parsed.submissions)) parsed.submissions = [];
      if (!parsed.event_archive || typeof parsed.event_archive !== 'object') parsed.event_archive = {};
      if (!Array.isArray(parsed.traffic)) parsed.traffic = [];
      if (!Array.isArray(parsed.subscribers)) parsed.subscribers = [];
      if (!Array.isArray(parsed.newsletter_sends)) parsed.newsletter_sends = [];
      if (!Array.isArray(parsed.email_opens)) parsed.email_opens = [];
      if (!Array.isArray(parsed.referral_rewards)) parsed.referral_rewards = [];
      if (!Array.isArray(parsed.sponsor_orders)) parsed.sponsor_orders = [];
      if (!Array.isArray(parsed.event_edits)) parsed.event_edits = [];
      if (!Array.isArray(parsed.subscriber_counts)) parsed.subscriber_counts = [];
      return parsed;
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { submissions: [], published: null, event_edits: [], event_archive: {}, traffic: [], subscribers: [], newsletter_sends: [], email_opens: [], referral_rewards: [], sponsor_orders: [], subscriber_counts: [] };
      }
      throw err;
    }
  }

  async _write(data) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    await fs.rename(tmp, this.file);
  }

  // Serialize writes so concurrent submissions don't clobber each other.
  _withWrite(fn) {
    const next = this._writeLock.then(fn, fn);
    this._writeLock = next.catch(() => {});
    return next;
  }

  async ready() { return true; }

  // Which town this store belongs to (MULTI_CITY_PLAN.md 2.5): claimTown
  // writes `id` the first time, unless the store already holds people's
  // data (subscribers, orders, submissions) from before towns, which is
  // Victoria's. Returns { town, claimed, hasData }. Victoria never calls it.
  async claimTown(id) {
    return this._withWrite(async () => {
      const data = await this._read();
      if (data.town_meta && data.town_meta.town) return { town: data.town_meta.town, claimed: false, hasData: null };
      const hasData = data.subscribers.length + data.sponsor_orders.length + data.submissions.length > 0;
      if (hasData) return { town: null, claimed: false, hasData };
      data.town_meta = { town: id };
      await this._write(data);
      return { town: id, claimed: true, hasData };
    });
  }

  async insert(row) {
    return this._withWrite(async () => {
      const data = await this._read();
      data.submissions.push(row);
      await this._write(data);
      return row;
    });
  }

  // fromDate (YYYY-MM-DD): only events on or after it, uncapped. See PgStore.
  async list({ status, fromDate } = {}) {
    const data = await this._read();
    let rows = status
      ? data.submissions.filter(r => r.status === status)
      : data.submissions.slice();
    if (fromDate) rows = rows.filter(r => String((r.payload || {}).date || '') >= fromDate);
    rows.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    return rows;
  }

  async get(id) {
    const data = await this._read();
    return data.submissions.find(r => r.id === id) || null;
  }

  async update(id, patch) {
    return this._withWrite(async () => {
      const data = await this._read();
      const idx = data.submissions.findIndex(r => r.id === id);
      if (idx === -1) return null;
      const merged = { ...data.submissions[idx], ...patch, updated_at: nowIso() };
      data.submissions[idx] = merged;
      await this._write(data);
      return merged;
    });
  }

  // Last-published events.json payload, for the case where Railway is
  // operating without a GitHub token and we still want a durable copy.
  async getPublished() {
    const data = await this._read();
    return data.published || null;
  }

  async setPublished(payload) {
    return this._withWrite(async () => {
      const data = await this._read();
      data.published = payload;
      await this._write(data);
      return payload;
    });
  }

  // Every event ever published, keyed by its public page path
  // (/events/<date>-<slug>). Event pages stay up after their week rotates
  // out of the live payload, so links and search rankings don't 404.
  async archiveEvents(events) {
    return this._withWrite(async () => {
      const data = await this._read();
      for (const ev of events) {
        if (ev && ev.page) data.event_archive[ev.page] = ev;
      }
      const cutoff = archiveCutoff();
      for (const [page, ev] of Object.entries(data.event_archive)) {
        if (ev && /^\d{4}-\d{2}-\d{2}$/.test(ev.date || '') && ev.date < cutoff) delete data.event_archive[page];
      }
      await this._write(data);
    });
  }

  // Visitor stats (server/analytics.js). Capped so the JSON file stays
  // small; production uses Postgres.
  async recordTraffic(row) {
    return this._withWrite(async () => {
      const data = await this._read();
      data.traffic.push({ ...row, ts: nowIso() });
      if (data.traffic.length > FILE_TRAFFIC_CAP) data.traffic.splice(0, data.traffic.length - FILE_TRAFFIC_CAP);
      await this._write(data);
    });
  }

  async listTraffic(sinceDay) {
    const data = await this._read();
    return data.traffic.filter(r => r.day >= sinceDay);
  }

  // ─── Newsletter (server/newsletter.js) ───
  async addSubscriber({ email, source, referredBy = null }) {
    return this._withWrite(async () => {
      const data = await this._read();
      let sub = data.subscribers.find(x => x.email === email);
      const now = nowIso();
      if (sub && sub.status === 'active') return sub;
      let fresh = false;
      if (!sub) {
        // referred_by is only ever set here, on a first signup: a comeback
        // or a re-submit isn't a new reader anyone brought in.
        sub = { id: newId(), email, status: 'pending', token: newToken(), source, created_at: now, pending_since: now,
          ...(referredBy ? { referred_by: referredBy } : {}) };
        data.subscribers.push(sub);
        fresh = true;
      } else if (sub.status === 'unsubscribed' || sub.status === 'bounced') {
        // Coming back (or a bounced address signing up again, as in
        // PgStore): credit where they came back from. A new token, since
        // it also confirms and the old one sits in every issue they got
        // (forwarded ones too); but the old one is kept for unsubscribing,
        // so those issues' links still work (see PgStore.addSubscriber).
        // pending_since: when this signup asked, for the confirm reminder; a
        // comeback is a new ask and gets its own reminder.
        // weekend_optout: a fresh signup is promised both issues again.
        Object.assign(sub, { status: 'pending', token: newToken(), unsubscribed_at: null, bounced_at: null, unsub_reason: null, source,
          old_tokens: [...(sub.old_tokens || []), sub.token], pending_since: now, reminded_at: null, weekend_optout: false,
          ...SOFT_BOUNCE_CLEAR });
        fresh = true;
      }
      await this._write(data);
      // new_signup: a first signup or a comeback, not a re-submit. Only
      // these count as conversions (docs/track.js Lead).
      return { ...sub, new_signup: fresh };
    });
  }

  async confirmSubscriber(token) {
    if (!token) return null;
    return this._withWrite(async () => {
      const data = await this._read();
      const sub = data.subscribers.find(x => x.token === token && x.status !== 'unsubscribed');
      if (!sub) return null;
      const newly = sub.status !== 'active';
      if (newly) Object.assign(sub, { status: 'active', confirmed_at: nowIso() });
      await this._write(data);
      return { ...sub, newly_confirmed: newly };
    });
  }

  async unsubscribe(token) {
    if (!token) return false;
    return this._withWrite(async () => {
      const data = await this._read();
      const sub = data.subscribers.find(x => x.token === token || (x.old_tokens || []).includes(token));
      if (!sub) return false;
      Object.assign(sub, { status: 'unsubscribed', unsubscribed_at: nowIso(), unsub_reason: 'unsubscribe' });
      await this._write(data);
      return true;
    });
  }

  // Pending signups (asked between `from` and `to`, ISO times: pending_since,
  // or created_at for rows from before it was recorded) that haven't
  // had their one confirm reminder (newsletter.js sendConfirmReminders).
  async listConfirmReminders({ from, to, limit = 100 }) {
    const data = await this._read();
    return data.subscribers
      .filter(x => x.status === 'pending' && !x.reminded_at && (x.pending_since || x.created_at) >= from && (x.pending_since || x.created_at) <= to)
      .sort((a, b) => (a.pending_since || a.created_at).localeCompare(b.pending_since || b.created_at)).slice(0, limit)
      .map(x => ({ id: x.id, email: x.email, token: x.token }));
  }

  // Claims the reminder for one subscriber: true only for the first caller,
  // so two servers (old and new container in a deploy) can't both send it.
  // done=false gives the claim back (the send failed; try next hour).
  async markReminded(id, done = true) {
    return this._withWrite(async () => {
      const data = await this._read();
      const sub = data.subscribers.find(x => x.id === id);
      if (!sub) return false;
      if (!done) { delete sub.reminded_at; await this._write(data); return true; }
      if (sub.reminded_at) return false;
      sub.reminded_at = nowIso();
      await this._write(data);
      return true;
    });
  }

  // Addresses Resend refused outright (newsletter.js sendWeekly) or reported
  // as a hard bounce (inbound.js). Only active ones change: someone who
  // unsubscribed stays unsubscribed.
  async markSubscribersBounced(emails) {
    const set = new Set(emails || []);
    if (!set.size) return 0;
    return this._withWrite(async () => {
      const data = await this._read();
      let n = 0;
      for (const sub of data.subscribers) {
        if (set.has(sub.email) && sub.status === 'active') { Object.assign(sub, { status: 'bounced', bounced_at: nowIso() }); n++; }
      }
      await this._write(data);
      return n;
    });
  }

  // A stored address email can't go to, corrected in place (newsletter.js
  // repairSubscriberEmails): the same subscriber, token and status. False
  // when `from` isn't there or `to` already is.
  async replaceSubscriberEmail(from, to) {
    return this._withWrite(async () => {
      const data = await this._read();
      const sub = data.subscribers.find(x => x.email === from);
      if (!sub || data.subscribers.some(x => x.email === to)) return false;
      sub.email = to;
      await this._write(data);
      return true;
    });
  }

  // A soft bounce for these addresses (see SOFT_BOUNCE). Only active
  // subscribers count. Returns the addresses this marked bounced.
  async recordSoftBounce(emails, now = new Date()) {
    const set = new Set(emails || []);
    if (!set.size) return [];
    const t = now.getTime();
    return this._withWrite(async () => {
      const data = await this._read();
      const bounced = [];
      let changed = false;
      for (const sub of data.subscribers) {
        if (!set.has(sub.email) || sub.status !== 'active') continue;
        const last = sub.soft_bounce_last_at ? Date.parse(sub.soft_bounce_last_at) : null;
        if (last !== null && t - last < SOFT_BOUNCE.sameSendMs) continue;
        if (last === null || t - last >= SOFT_BOUNCE.resetMs) Object.assign(sub, { soft_bounces: 0, soft_bounce_first_at: now.toISOString() });
        sub.soft_bounces = (sub.soft_bounces || 0) + 1;
        sub.soft_bounce_last_at = now.toISOString();
        changed = true;
        if (sub.soft_bounces >= SOFT_BOUNCE.limit && t - Date.parse(sub.soft_bounce_first_at) >= SOFT_BOUNCE.minSpanMs) {
          Object.assign(sub, { status: 'bounced', bounced_at: now.toISOString() });
          bounced.push(sub.email);
        }
      }
      if (changed) await this._write(data);
      return bounced;
    });
  }

  // A delivery (email.delivered) ends a run of soft bounces.
  async clearSoftBounces(emails) {
    const set = new Set(emails || []);
    if (!set.size) return 0;
    return this._withWrite(async () => {
      const data = await this._read();
      let n = 0;
      for (const sub of data.subscribers) {
        if (set.has(sub.email) && sub.soft_bounces) { Object.assign(sub, SOFT_BOUNCE_CLEAR); n++; }
      }
      if (n) await this._write(data);
      return n;
    });
  }

  // A spam complaint (server/inbound.js): an unsubscribe by address, any
  // status, so a complainer waiting to confirm a comeback stays off too.
  // reason (unsub_reason): why, for the counts (complaint, bad_address,
  // typo_fixed); a link unsubscribe is 'unsubscribe'.
  async unsubscribeByEmail(emails, reason = null) {
    const set = new Set(emails || []);
    if (!set.size) return 0;
    return this._withWrite(async () => {
      const data = await this._read();
      let n = 0;
      for (const sub of data.subscribers) {
        if (set.has(sub.email) && sub.status !== 'unsubscribed') { Object.assign(sub, { status: 'unsubscribed', unsubscribed_at: nowIso(), unsub_reason: reason }); n++; }
      }
      await this._write(data);
      return n;
    });
  }

  async getSubscriberByToken(token) {
    if (!token) return null;
    const data = await this._read();
    const sub = data.subscribers.find(x => x.token === token || (x.old_tokens || []).includes(token));
    return sub ? { email: sub.email, status: sub.status, weekend_optout: Boolean(sub.weekend_optout) } : null;
  }

  // The Thursday weekend issue is on for everyone unless they turn it off
  // (the Monday issue keeps coming). Any of their tokens, like unsubscribe:
  // the link sits in every issue they got.
  async setWeekendOptout(token, optout) {
    if (!token) return null;
    return this._withWrite(async () => {
      const data = await this._read();
      const sub = data.subscribers.find(x => x.token === token || (x.old_tokens || []).includes(token));
      if (!sub) return null;
      sub.weekend_optout = Boolean(optout);
      await this._write(data);
      return { email: sub.email, status: sub.status, weekend_optout: sub.weekend_optout };
    });
  }

  async listSubscribers({ status } = {}) {
    const data = await this._read();
    return data.subscribers.filter(x => !status || x.status === status);
  }

  // Active subscribers who confirmed after `after` (an ISO time; null: none,
  // just the newest time), oldest first, at most `limit`, for HQ's
  // subscriber pings (server/hq.js). Imports don't count as new signups.
  // latest: the newest confirmed_at of any active signup, so HQ can start
  // from now instead of a town's whole history.
  async listConfirmedSince(after, limit = 500) {
    const data = await this._read();
    const t = x => new Date(x.confirmed_at).getTime();
    const live = data.subscribers.filter(x => x.status === 'active' && x.confirmed_at && x.source !== 'import' && Number.isFinite(t(x)))
      .sort((a, b) => t(a) - t(b));
    const latest = live.length ? new Date(t(live[live.length - 1])).toISOString() : null;
    if (!after) return { latest, subscribers: [] };
    const from = new Date(after).getTime();
    return { latest, subscribers: live.filter(x => t(x) > from).slice(0, limit)
      .map(x => ({ email: x.email, confirmed_at: new Date(t(x)).toISOString() })) };
  }

  // Active subscribers who skip the Thursday weekend issue.
  async countWeekendOptouts() {
    const data = await this._read();
    return data.subscribers.filter(x => x.status === 'active' && x.weekend_optout).length;
  }

  async countSubscribers() {
    const data = await this._read();
    const c = { active: 0, pending: 0, unsubscribed: 0 };
    for (const x of data.subscribers) c[x.status] = (c[x.status] || 0) + 1;
    return c;
  }

  // ─── Referrals (server/newsletter.js) ───
  // Give each listed subscriber a referral code if they don't have one yet;
  // returns { id: code } for all of them.
  async ensureRefCodes(ids) {
    const want = new Set(ids || []);
    if (!want.size) return {};
    return this._withWrite(async () => {
      const data = await this._read();
      const taken = new Set(data.subscribers.map(x => x.ref_code).filter(Boolean));
      const out = {};
      let changed = false;
      for (const sub of data.subscribers) {
        if (!want.has(sub.id)) continue;
        if (!sub.ref_code) {
          let c; do { c = newRefCode(); } while (taken.has(c));
          sub.ref_code = c; taken.add(c); changed = true;
        }
        out[sub.id] = sub.ref_code;
      }
      if (changed) await this._write(data);
      return out;
    });
  }

  // The active subscriber a code belongs to (a referral only counts for
  // someone still on the list).
  async getReferrer(code) {
    if (!code) return null;
    const data = await this._read();
    const sub = data.subscribers.find(x => x.ref_code === code && x.status === 'active');
    return sub ? { id: sub.id, email: sub.email, ref_code: sub.ref_code } : null;
  }

  // { code: n } of the subscribers each code brought in that count: still
  // active, and on the list for REF_HOLD_HOURS. Someone who unsubscribed or
  // bounced stops counting, and the hold means a burst of throwaway
  // addresses that unsubscribe right away never pays off.
  async countReferrals(codes, { counted = true } = {}) {
    // Every code's friends, so an inbox another code already counts isn't
    // counted again here (tallyReferrals); then just the codes asked for.
    const all = referralCounts(tallyReferrals(await this.listReferredFriends(null)), counted);
    if (!codes) return all;
    const want = new Set(codes);
    return Object.fromEntries(Object.entries(all).filter(([c]) => want.has(c)));
  }

  // The active subscribers each code brought in: { referred_by,
  // referrer_email, email, confirmed_at }. null codes means every code.
  async listReferredFriends(codes) {
    const want = codes ? new Set(codes) : null;
    const data = await this._read();
    const owner = new Map(data.subscribers.filter(x => x.ref_code).map(x => [x.ref_code, x]));
    return data.subscribers
      .filter(x => x.status === 'active' && x.referred_by && (!want || want.has(x.referred_by)))
      .map(x => {
        const o = owner.get(x.referred_by);
        return { referred_by: x.referred_by, referrer_email: o ? o.email : null, referrer_active: Boolean(o && o.status === 'active'),
          email: x.email, confirmed_at: x.confirmed_at || null };
      });
  }

  async topReferrers(limit = 10) {
    const tally = tallyReferrals(await this.listReferredFriends(null));
    const data = await this._read();
    return referrerRows(tally, data.subscribers.filter(x => x.ref_code), limit);
  }

  // The highest reward tier the owner was told about for this referrer, so
  // the Monday "rewards to send" note names each tier once.
  async listRefTiers(codes) {
    const want = new Set(codes || []);
    const data = await this._read();
    const out = {};
    for (const x of data.subscribers) if (x.ref_code && want.has(x.ref_code)) out[x.ref_code] = { email: x.email, ref_tier: x.ref_tier || 0 };
    return out;
  }

  async setRefTier(code, n) {
    return this._withWrite(async () => {
      const data = await this._read();
      const sub = data.subscribers.find(x => x.ref_code === code);
      if (!sub) return false;
      sub.ref_tier = Math.max(sub.ref_tier || 0, n);
      await this._write(data);
      return true;
    });
  }

  // Referral rewards (server/referralRewards.js): one row per reward, keyed
  // so a tier or a month's drawing is only ever created once. Returns the
  // new row, or null when that key already exists.
  async addReferralReward(row) {
    return this._withWrite(async () => {
      const data = await this._read();
      if (data.referral_rewards.some(x => x.key === row.key)) return null;
      const out = { id: newId(), order_id: null, reason: null, entries: null, total_entries: null, flags: null, ...row,
        created_at: nowIso(), updated_at: nowIso() };
      data.referral_rewards.push(out);
      await this._write(data);
      return { ...out };
    });
  }

  async updateReferralReward(id, patch) {
    return this._withWrite(async () => {
      const data = await this._read();
      const row = data.referral_rewards.find(x => x.id === id);
      if (!row) return null;
      for (const k of ['status', 'order_id', 'reason']) if (k in patch) row[k] = patch[k];
      row.updated_at = nowIso();
      await this._write(data);
      return { ...row };
    });
  }

  async getReferralReward(id) {
    const data = await this._read();
    const row = data.referral_rewards.find(x => x.id === id);
    return row ? { ...row } : null;
  }

  // Newest first; statuses limits it (e.g. ['pending', 'failed']).
  async listReferralRewards({ statuses = null, limit = 30 } = {}) {
    const data = await this._read();
    return data.referral_rewards.filter(x => !statuses || statuses.includes(x.status))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, limit).map(x => ({ ...x }));
  }

  // Imported addresses already opted in elsewhere (an old list), so they start
  // active. People who opted out here are never re-added (importSkip): only
  // their own inbox can put them back, through the confirm email.
  async importSubscribers(emails, source) {
    return this._withWrite(async () => {
      const data = await this._read();
      const out = { added: 0, already: 0, skipped_unsubscribed: 0, skipped_bounced: 0 };
      for (const email of emails) {
        const sub = data.subscribers.find(x => x.email === email);
        const skip = sub && importSkip(sub);
        if (!sub) {
          data.subscribers.push({ id: newId(), email, status: 'active', token: newToken(), source, created_at: nowIso(), confirmed_at: nowIso() });
          out.added++;
        } else if (skip) out[skip]++;
        else { if (sub.status !== 'active') Object.assign(sub, { status: 'active', confirmed_at: nowIso() }); out.already++; }
      }
      await this._write(data);
      return out;
    });
  }

  async recordNewsletterSend(rec) {
    return this._withWrite(async () => {
      const data = await this._read();
      const prev = data.newsletter_sends.find(x => x.week_key === rec.week_key);
      data.newsletter_sends = data.newsletter_sends.filter(x => x.week_key !== rec.week_key);
      // Like PgStore: a record without picks keeps the ones already noted.
      const picks = Array.isArray(rec.picks) ? rec.picks : prev && prev.picks;
      const events = Array.isArray(rec.events) ? rec.events : prev && prev.events;
      data.newsletter_sends.push({ ...rec, ...(picks ? { picks } : {}), ...(events ? { events } : {}), sent_at: nowIso() });
      await this._write(data);
    });
  }

  async getNewsletterSend(weekKey) {
    const data = await this._read();
    return data.newsletter_sends.find(x => x.week_key === weekKey) || null;
  }

  async listNewsletterSends(limit = 10) {
    const data = await this._read();
    return data.newsletter_sends.slice().sort((a, b) => (a.sent_at < b.sent_at ? 1 : -1)).slice(0, limit);
  }

  // Newsletter opens (the tracking image): one row per issue and
  // subscriber, so the count is unique opens. An id that isn't a
  // subscriber is ignored, so made-up image URLs can't pad the number.
  async recordEmailOpen({ week_key, subscriber_id }) {
    return this._withWrite(async () => {
      const data = await this._read();
      if (!data.subscribers.some(x => x.id === subscriber_id)) return false;
      const row = data.email_opens.find(x => x.week_key === week_key && x.subscriber_id === subscriber_id);
      if (row) Object.assign(row, { opens: (row.opens || 1) + 1, last_opened_at: nowIso() });
      else data.email_opens.push({ week_key, subscriber_id, opens: 1, first_opened_at: nowIso(), last_opened_at: nowIso() });
      await this._write(data);
      return true;
    });
  }

  // { week_key: unique opens } for the given issues.
  async countEmailOpens(weekKeys) {
    const data = await this._read();
    const want = new Set(weekKeys);
    const out = {};
    for (const r of data.email_opens) if (want.has(r.week_key)) out[r.week_key] = (out[r.week_key] || 0) + 1;
    return out;
  }

  // ─── Growth (server/growth.js) ───
  // Every subscriber's status, source and dates, without the address.
  async listSubscriberStats() {
    const data = await this._read();
    return data.subscribers.map(x => ({ id: x.id, status: x.status, source: x.source || null, referred_by: x.referred_by || null,
      created_at: x.created_at || null, confirmed_at: x.confirmed_at || null, unsubscribed_at: x.unsubscribed_at || null,
      bounced_at: x.bounced_at || null, unsub_reason: x.unsub_reason || null, pending_since: x.pending_since || null,
      weekend_optout: Boolean(x.weekend_optout) }));
  }

  // One row per town-local day of the list's own counts, written by the HQ
  // summary (server/hq.js): a record that isn't worked out again from
  // today's rows, so a restore or a wipe shows as a drop.
  async saveSubscriberCounts(day, counts) {
    return this._withWrite(async () => {
      const data = await this._read();
      const row = { day, active: counts.active || 0, pending: counts.pending || 0, bounced: counts.bounced || 0,
        unsubscribed: counts.unsubscribed || 0, recorded_at: nowIso() };
      const i = data.subscriber_counts.findIndex(x => x.day === day);
      if (i >= 0) data.subscriber_counts[i] = row; else data.subscriber_counts.push(row);
      data.subscriber_counts.sort((a, b) => (a.day < b.day ? -1 : 1));
      if (data.subscriber_counts.length > 400) data.subscriber_counts.splice(0, data.subscriber_counts.length - 400);
      await this._write(data);
    });
  }

  // The last `limit` days recorded, oldest first.
  async listSubscriberCounts(limit = 31) {
    const data = await this._read();
    return data.subscriber_counts.slice(-limit);
  }

  // Who opened the given issues: [{ week_key, subscriber_id }].
  async listEmailOpens(weekKeys) {
    const data = await this._read();
    const want = new Set(weekKeys);
    return data.email_opens.filter(r => want.has(r.week_key)).map(r => ({ week_key: r.week_key, subscriber_id: r.subscriber_id }));
  }

  // Meta's ad results per day (scripts/meta_ads.py posts them): a day's
  // row is replaced each time, since Meta revises the last few days.
  async saveAdSpend(rows) {
    return this._withWrite(async () => {
      const data = await this._read();
      const byDay = new Map((data.ad_spend || []).map(r => [r.day, r]));
      for (const r of rows) byDay.set(r.day, { ...r, updated_at: nowIso() });
      data.ad_spend = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
      await this._write(data);
      return rows.length;
    });
  }

  async listAdSpend(sinceDay) {
    const data = await this._read();
    return (data.ad_spend || []).filter(r => r.day >= sinceDay);
  }

  // ─── Sponsor orders (server/sponsors.js) ───
  async saveSponsorOrder(order) {
    return this._withWrite(async () => {
      const data = await this._read();
      data.sponsor_orders = data.sponsor_orders.filter(x => x.id !== order.id);
      data.sponsor_orders.push(order);
      await this._write(data);
    });
  }

  async listSponsorOrders() {
    const data = await this._read();
    return data.sponsor_orders.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }

  // Weekly sponsor logos, kept apart from orders (orders are read on every
  // page view; logos only when someone loads the image).
  async saveSponsorLogo(id, { contentType, data: bytes }) {
    return this._withWrite(async () => {
      const data = await this._read();
      data.sponsor_logos = data.sponsor_logos || {};
      data.sponsor_logos[id] = { contentType, data: Buffer.from(bytes).toString('base64') };
      await this._write(data);
    });
  }

  async getSponsorLogo(id) {
    const data = await this._read();
    const row = (data.sponsor_logos || {})[id];
    return row ? { contentType: row.contentType, data: Buffer.from(row.data, 'base64') } : null;
  }

  // Unpaid checkouts (expired, failed) and admin removals drop the image.
  async deleteSponsorLogo(id) {
    return this._withWrite(async () => {
      const data = await this._read();
      if (!data.sponsor_logos || !data.sponsor_logos[id]) return;
      delete data.sponsor_logos[id];
      await this._write(data);
    });
  }

  async getArchivedEvent(page) {
    const data = await this._read();
    return data.event_archive[page] || null;
  }

  async listArchivedEvents() {
    const data = await this._read();
    const cutoff = archiveCutoff();
    return Object.values(data.event_archive).filter(ev => !(ev && ev.date) || !(ev.date < cutoff));
  }

  // Lightweight duplicate detector: same date + normalized name + venue, status
  // not rejected.
  async findDuplicate({ date, name, venue }) {
    const data = await this._read();
    const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const dn = norm(name), dv = norm(venue);
    return data.submissions.find(r => {
      if (r.status === 'rejected') return false;
      const p = r.payload || {};
      return (p.date || '') === date &&
        norm(p.name) === dn &&
        norm(p.venue) === dv;
    }) || null;
  }

  // Admin event-edits overlay (PR #22). Stored as a flat list keyed by
  // original_key — the eventKey at the time of the first edit. Subsequent
  // edits to the same row update the same entry so we never accumulate
  // multiple stale overlays for one event.
  async listEventEdits() {
    const data = await this._read();
    return Array.isArray(data.event_edits) ? data.event_edits.slice() : [];
  }

  async upsertEventEdit({ original_key, payload }) {
    return this._withWrite(async () => {
      const data = await this._read();
      if (!Array.isArray(data.event_edits)) data.event_edits = [];
      const idx = data.event_edits.findIndex(e => e.original_key === original_key);
      const now = nowIso();
      const row = {
        id: original_key,
        original_key,
        payload,
        updated_at: now,
        created_at: idx === -1 ? now : (data.event_edits[idx].created_at || now)
      };
      if (idx === -1) data.event_edits.push(row);
      else data.event_edits[idx] = row;
      await this._write(data);
      return row;
    });
  }

  // ─── Scheduler runs (server/scheduler.js) ───
  async claimJobRun(job, slot, now = new Date()) {
    return this._withWrite(async () => {
      const data = await this._read();
      if (!Array.isArray(data.scheduler_runs)) data.scheduler_runs = [];
      const row = data.scheduler_runs.find(r => r.job === job && r.slot === slot);
      const at = now.toISOString();
      if (!row) {
        data.scheduler_runs.push({ job, slot, status: 'running', attempts: 1, started_at: at, retry_at: null });
      } else if (jobReclaimable(row, now)) {
        Object.assign(row, { status: 'running', attempts: (row.attempts || 0) + 1, started_at: at, retry_at: null });
      } else {
        return { claimed: false, attempts: row.attempts || 0 };
      }
      // A year of daily jobs is a few hundred rows; keep the file small.
      data.scheduler_runs = data.scheduler_runs.slice(-500);
      await this._write(data);
      return { claimed: true, attempts: row ? row.attempts : 1 };
    });
  }

  async finishJobRun(job, slot, { status, retry_at = null, detail = '' }) {
    return this._withWrite(async () => {
      const data = await this._read();
      const row = (data.scheduler_runs || []).find(r => r.job === job && r.slot === slot);
      if (!row) return;
      Object.assign(row, { status, retry_at, detail, finished_at: nowIso() });
      await this._write(data);
    });
  }

  async getJobRun(job, slot) {
    const data = await this._read();
    return (data.scheduler_runs || []).find(r => r.job === job && r.slot === slot) || null;
  }

  // ─── Jobs on Railway (server/jobs.js, JOBS_ON_RAILWAY.md) ───
  // The town's job queue (the scheduler and Pull Now add, the jobs worker
  // claims and finishes) and the files a job hands the site (candidates,
  // collection metadata, enrichment cache), which used to be commits.
  // unlessPending: not when a job of the same kind is already queued or
  // running (a worker that was down doesn't come back to a pile of them,
  // and a second Pull Now doesn't start a second collect).
  async enqueueJob(kind, slot, args = {}, now = new Date(), { unlessPending = false } = {}) {
    return this._withWrite(async () => {
      const data = await this._read();
      if (!Array.isArray(data.jobs)) data.jobs = [];
      const dup = data.jobs.find(j => j.kind === kind && j.slot === slot);
      if (dup) return { queued: false, id: dup.id };
      const pending = unlessPending && data.jobs.find(j => j.kind === kind && (j.status === 'queued' || j.status === 'running'));
      if (pending) return { queued: false, id: pending.id, pending: true };
      const id = (data.jobs.reduce((m, j) => Math.max(m, j.id), 0) || 0) + 1;
      data.jobs.push({ id, kind, slot, args, status: 'queued', queued_at: now.toISOString(), started_at: null, finished_at: null, result: null });
      data.jobs = data.jobs.slice(-500);
      await this._write(data);
      return { queued: true, id };
    });
  }

  async claimJob(now = new Date()) {
    return this._withWrite(async () => {
      const data = await this._read();
      const job = (data.jobs || []).find(j => j.status === 'queued');
      if (!job) return null;
      Object.assign(job, { status: 'running', started_at: now.toISOString() });
      await this._write(data);
      return { ...job };
    });
  }

  async finishJob(id, { status, result = null }, now = new Date()) {
    return this._withWrite(async () => {
      const data = await this._read();
      const job = (data.jobs || []).find(j => j.id === Number(id) && j.status === 'running');
      if (!job) return null;
      Object.assign(job, { status, result, finished_at: now.toISOString() });
      await this._write(data);
      return { ...job };
    });
  }

  // Running jobs past their time limit ({kind: ms}, default for the rest):
  // the worker died or was redeployed mid-run. Marked failed and returned.
  async expireJobs(now = new Date(), limits = {}, fallbackMs = 30 * 60 * 1000) {
    return this._withWrite(async () => {
      const data = await this._read();
      const out = [];
      for (const j of data.jobs || []) {
        if (j.status !== 'running') continue;
        if (Date.parse(j.started_at) + (limits[j.kind] || fallbackMs) > now.getTime()) continue;
        Object.assign(j, { status: 'failed', finished_at: now.toISOString(), result: { error: 'timed out: the jobs worker stopped answering' } });
        out.push({ ...j });
      }
      if (out.length) await this._write(data);
      return out;
    });
  }

  async listJobs(limit = 50) {
    const data = await this._read();
    return (data.jobs || []).slice(-limit).reverse().map(j => ({ ...j }));
  }

  // For HQ: each kind's last finished run however long ago, what's queued
  // and running, and the failures in the last day.
  async jobStats(now = new Date()) {
    const jobs = ((await this._read()).jobs || []).slice().reverse();
    const last = {};
    for (const j of jobs) if (!last[j.kind] && (j.status === 'done' || j.status === 'failed')) last[j.kind] = { ...j };
    const day = now.getTime() - 86400000;
    return {
      last,
      queued: jobs.filter(j => j.status === 'queued').length,
      running: jobs.filter(j => j.status === 'running').map(j => ({ kind: j.kind, started_at: j.started_at })),
      failed_24h: jobs.filter(j => j.status === 'failed' && Date.parse(j.finished_at) >= day).length
    };
  }

  async getTownFile(name) {
    const data = await this._read();
    const f = (data.town_files || {})[name];
    return f ? { data: f.data, updated_at: f.updated_at } : null;
  }

  async setTownFile(name, value, now = new Date()) {
    return this._withWrite(async () => {
      const data = await this._read();
      if (!data.town_files || typeof data.town_files !== 'object') data.town_files = {};
      data.town_files[name] = { data: value, updated_at: now.toISOString() };
      await this._write(data);
    });
  }

  // ─── A town's social kit (server/jobs.js, JOBS_ON_RAILWAY.md 2b) ───
  // The jobs worker uploads a kit's files under a build id, then publishes
  // the build: /social/latest/<name> serves the published one, and every
  // other build is deleted, so only the latest kit is kept. The pointer is
  // the town file "social_kit" ({ build, files, bytes, published_at }).
  async putSocialFile(build, name, type, body, now = new Date()) {
    return this._withWrite(async () => {
      const data = await this._read();
      const all = data.social_files && typeof data.social_files === 'object' ? data.social_files : {};
      const current = ((data.town_files || {}).social_kit || {}).data?.build;
      // One build in the making at a time: an upload abandoned by a crash
      // is dropped when the next one starts.
      for (const b of Object.keys(all)) if (b !== build && b !== current) delete all[b];
      all[build] = all[build] || {};
      all[build][name] = { type, b64: Buffer.from(body).toString('base64'), size: body.length, updated_at: now.toISOString() };
      data.social_files = all;
      await this._write(data);
    });
  }

  async socialBuildSize(build) {
    const files = ((await this._read()).social_files || {})[build] || {};
    return { files: Object.keys(files).length, bytes: Object.values(files).reduce((n, f) => n + (f.size || 0), 0), names: Object.keys(files) };
  }

  async getSocialBuildFile(build, name) {
    const f = (((await this._read()).social_files || {})[build] || {})[name];
    return f ? { type: f.type, body: Buffer.from(f.b64, 'base64'), updated_at: f.updated_at } : null;
  }

  async publishSocialKit(build, info, now = new Date()) {
    return this._withWrite(async () => {
      const data = await this._read();
      if (!data.town_files || typeof data.town_files !== 'object') data.town_files = {};
      data.town_files.social_kit = { data: { build, ...info, published_at: now.toISOString() }, updated_at: now.toISOString() };
      const all = data.social_files || {};
      for (const b of Object.keys(all)) if (b !== build) delete all[b];
      data.social_files = all;
      await this._write(data);
    });
  }

  // The published kit's file, or null (none published, or no such file).
  async getSocialFile(name) {
    const data = await this._read();
    const build = ((data.town_files || {}).social_kit || {}).data?.build;
    const f = build && ((data.social_files || {})[build] || {})[name];
    return f ? { type: f.type, body: Buffer.from(f.b64, 'base64'), updated_at: f.updated_at, build } : null;
  }

  // ─── Contact form messages (server/contact.js) ───
  async saveContactMessage(msg) {
    return this._withWrite(async () => {
      const data = await this._read();
      if (!Array.isArray(data.contact_messages)) data.contact_messages = [];
      data.contact_messages.push(msg);
      await this._write(data);
    });
  }

  async listContactMessages(limit = 100) {
    const data = await this._read();
    return (data.contact_messages || []).slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, limit);
  }

  // The admin dealt with it: off the Home list, kept until the retention purge.
  async dismissContactMessage(id, at = nowIso()) {
    return this._withWrite(async () => {
      const data = await this._read();
      const msg = (data.contact_messages || []).find(m => m.id === id);
      if (!msg) return false;
      msg.dismissed_at = at;
      await this._write(data);
      return true;
    });
  }

  // ─── Owner inbox (server/inbox.js) ───
  // Everything that pinged the owner, kept for HQ to read (GET /api/hq/inbox).
  async addInboxEvent(evt) {
    return this._withWrite(async () => {
      const data = await this._read();
      if (!Array.isArray(data.inbox_events)) data.inbox_events = [];
      const id = data.inbox_events.reduce((m, e) => Math.max(m, e.id), 0) + 1;
      const row = { id, created_at: evt.created_at || nowIso(), channel: evt.channel, severity: evt.severity, kind: evt.kind, title: evt.title, payload: evt.payload || {} };
      data.inbox_events.push(row);
      if (data.inbox_events.length > 2000) data.inbox_events = data.inbox_events.slice(-2000);
      await this._write(data);
      return row;
    });
  }

  async listInboxEvents(sinceId = 0, limit = 200) {
    const data = await this._read();
    return (data.inbox_events || []).filter(e => e.id > sinceId).sort((a, b) => a.id - b.id).slice(0, limit);
  }

  // Newest first, below `beforeId` (0: from the top), for the admin Inbox page.
  async listRecentInboxEvents(beforeId = 0, limit = 50) {
    const data = await this._read();
    return (data.inbox_events || []).filter(e => !beforeId || e.id < beforeId).sort((a, b) => b.id - a.id).slice(0, limit);
  }

  // The newest inbox event id (0 when empty): HQ compares it with its
  // cursor to notice a database that was reset.
  async latestInboxId() {
    const data = await this._read();
    return (data.inbox_events || []).reduce((m, e) => Math.max(m, e.id), 0);
  }

  async getInboxEvent(id) {
    const data = await this._read();
    return (data.inbox_events || []).find(e => e.id === Number(id)) || null;
  }

  // ─── Personal data (server/privacy.js) ───
  // Retention: submissions created before `submissionsBefore` lose the
  // submitter's IP address and user agent; contact messages created before
  // `contactBefore` are deleted. Both ISO timestamps.
  async purgePersonalData({ submissionsBefore, contactBefore }) {
    return this._withWrite(async () => {
      const data = await this._read();
      let submissions = 0;
      for (const r of data.submissions) {
        if (String(r.created_at || '') < submissionsBefore && (r.submitter_ip || r.user_agent)) {
          r.submitter_ip = null; r.user_agent = null; submissions++;
        }
      }
      const msgs = Array.isArray(data.contact_messages) ? data.contact_messages : [];
      const keep = msgs.filter(m => !(String(m.created_at || '') < contactBefore));
      const contact = msgs.length - keep.length;
      if (contact) data.contact_messages = keep;
      const inboxBefore = Array.isArray(data.inbox_events) ? data.inbox_events.length : 0;
      if (inboxBefore) data.inbox_events = data.inbox_events.filter(e => !(String(e.created_at || '') < contactBefore));
      if (submissions || contact || (inboxBefore && inboxBefore !== data.inbox_events.length)) await this._write(data);
      return { submissions, contact_messages: contact };
    });
  }

  // Everything stored about one address, on request: the subscriber (and
  // their opens), contact messages, the submitter fields of their
  // submissions (the event itself stays), and a failed-send entry. Sponsor
  // orders and referral rewards are money, kept for the books with the
  // address replaced by `masked`; a reward not sent yet is skipped.
  async forgetEmail(email, masked) {
    return this._withWrite(async () => {
      const data = await this._read();
      const same = v => String(v || '').toLowerCase() === email;
      const out = { subscribers: 0, email_opens: 0, submissions: 0, contact_messages: 0, sponsor_orders: 0, referral_rewards: 0, newsletter_sends: 0 };
      const gone = new Set(data.subscribers.filter(x => same(x.email)).map(x => x.id));
      out.subscribers = gone.size;
      data.subscribers = data.subscribers.filter(x => !gone.has(x.id));
      const opens = data.email_opens.length;
      data.email_opens = data.email_opens.filter(x => !gone.has(x.subscriber_id));
      out.email_opens = opens - data.email_opens.length;
      for (const r of data.submissions) {
        if (!same(r.submitter_email)) continue;
        Object.assign(r, { submitter_email: null, submitter_name: null, submitter_ip: null, user_agent: null,
          payload: { ...(r.payload || {}), ...BLANK_SUBMITTER }, updated_at: nowIso() });
        out.submissions++;
      }
      if (Array.isArray(data.contact_messages)) {
        const before = data.contact_messages.length;
        data.contact_messages = data.contact_messages.filter(m => !same(m.email));
        out.contact_messages = before - data.contact_messages.length;
      }
      if (Array.isArray(data.inbox_events)) {
        const before = data.inbox_events.length;
        data.inbox_events = data.inbox_events.filter(e => !JSON.stringify(e).toLowerCase().includes(email));
        if (before !== data.inbox_events.length) out.inbox_events = before - data.inbox_events.length;
      }
      for (const o of data.sponsor_orders) if (same(o.email)) { o.email = masked; out.sponsor_orders++; }
      for (const r of data.referral_rewards) {
        if (!same(r.email)) continue;
        r.email = masked;
        if (OPEN_REWARD.has(r.status)) Object.assign(r, { status: 'skipped', reason: FORGOTTEN });
        r.updated_at = nowIso();
        out.referral_rewards++;
      }
      for (const n of data.newsletter_sends) {
        if (!Array.isArray(n.failed_emails) || !n.failed_emails.some(same)) continue;
        n.failed_emails = n.failed_emails.filter(e => !same(e));
        n.failed = n.failed_emails.length;
        out.newsletter_sends++;
      }
      if (Object.values(out).some(Boolean)) await this._write(data);
      return out;
    });
  }

  // Every subscriber for the admin's CSV export (no tokens).
  async exportSubscribers() {
    const data = await this._read();
    return data.subscribers.slice().sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
      .map(x => ({ email: x.email, status: x.status, source: x.source || null, created_at: x.created_at || null,
        confirmed_at: x.confirmed_at || null, unsubscribed_at: x.unsubscribed_at || null }));
  }
}

// forgetEmail: what a forgotten submitter's payload fields become (the
// shape normalizePayload gives), and the rewards that hadn't gone out.
const BLANK_SUBMITTER = { submitter_first_name: '', submitter_last_name: '', submitter_phone: '' };
const OPEN_REWARD = new Set(['pending', 'held', 'failed', 'manual']);
const FORGOTTEN = 'Skipped: the person asked us to delete their data.';

// A job_queue row as the rest of the code sees it (ISO dates, numeric id).
function jobRow(r) {
  const iso = v => (v ? new Date(v).toISOString() : null);
  return { id: Number(r.id), kind: r.kind, slot: r.slot, args: r.args || {}, status: r.status,
    queued_at: iso(r.queued_at), started_at: iso(r.started_at), finished_at: iso(r.finished_at), result: r.result || null };
}

// A claimed slot can be taken again when its run asked for a retry and the
// time has come, or when it has said "running" for 30 minutes (the process
// died mid-run).
const STALE_RUN_MS = 30 * 60 * 1000;
function jobReclaimable(row, now) {
  if (row.status === 'retry') return !row.retry_at || Date.parse(row.retry_at) <= now.getTime();
  if (row.status === 'running') return Date.parse(row.started_at) < now.getTime() - STALE_RUN_MS;
  return false;
}

// ─── POSTGRES BACKEND ───
// Whether a pg error means the database itself is unreachable or stuck
// (trip the breaker) rather than a bad query or a constraint (don't). pg
// errors from the server carry a 5-character SQLSTATE: class 08 is a
// connection exception, 53 insufficient resources (too many connections),
// 57P01-57P05 a shutdown or a dropped session. A statement timeout (57014)
// or cancel (57000) is not: one slow query (a 90-day traffic report) used to
// open the breaker for 30 s and fail every unrelated query, while the
// server that answered with the timeout was plainly up. Anything without a
// code is a socket error or a client-side timeout ("Query read timeout",
// "timeout exceeded when trying to connect"), except that a checkout timeout
// with every client busy (`pool` full) is slow queries, not a dead database:
// if the database hung, those busy clients' own read timeouts trip it.
const POOL_TIMEOUT = /timeout exceeded when trying to connect/i;
export function isOutage(err, pool = null) {
  const code = err && typeof err.code === 'string' ? err.code : '';
  if (/^[0-9A-Z]{5}$/.test(code)) {
    return ['08', '53'].includes(code.slice(0, 2)) || code.startsWith('57P');
  }
  if (pool && POOL_TIMEOUT.test(String(err && err.message)) && Number.isFinite(pool.totalCount) &&
      pool.totalCount >= ((pool.options && pool.options.max) || 10) && pool.idleCount === 0) return false;
  return true;
}

// Circuit breaker around the pool. When Postgres hangs (accepts TCP, never
// answers), every query would wait out its own 5 s connect timeout and a
// page view chains several, so each request took 10-15 s instead of
// falling back to the last good copy. After an outage error, every query
// fails at once for `windowMs`; then one query is let through as a probe
// (the rest keep failing fast) and a success closes the breaker.
export function breakerPool(pool, { windowMs = 30000, now = () => Date.now() } = {}) {
  let openUntil = 0;
  let probing = false;
  const down = () => Object.assign(new Error('database unavailable (circuit open)'), { code: 'CIRCUIT_OPEN' });
  async function query(...args) {
    let probe = false;
    if (openUntil) {
      if (now() < openUntil || probing) throw down();
      probing = probe = true;
    }
    try {
      const r = await pool.query(...args);
      openUntil = 0;
      return r;
    } catch (err) {
      // A probe that times out keeps it open: the one query let through
      // to test a stuck database shouldn't close the breaker by timing out.
      if (isOutage(err, pool) || (probe && /^57/.test(String(err && err.code)))) openUntil = now() + windowMs;
      else if (probe) openUntil = 0; // it answered: the database is up
      throw err;
    } finally {
      if (probe) probing = false;
    }
  }
  return { query, get open() { return Boolean(openUntil); } };
}

// Tables holding data nothing else can rebuild; see ready().
// A referral_rewards row as the FileStore keeps it (ISO times, plain numbers).
function rewardRow(x) {
  return { ...x, amount: Number(x.amount), tier: x.tier == null ? null : Number(x.tier),
    entries: x.entries == null ? null : Number(x.entries), total_entries: x.total_entries == null ? null : Number(x.total_entries),
    created_at: x.created_at instanceof Date ? x.created_at.toISOString() : x.created_at,
    updated_at: x.updated_at instanceof Date ? x.updated_at.toISOString() : x.updated_at };
}

const FRESH_TABLES = ['subscribers', 'sponsor_orders'];

class PgStore {
  // opts.breaker: { windowMs, now } for the circuit breaker (tests).
  constructor(pool, opts = {}) {
    this.rawPool = pool;
    this.pool = breakerPool(pool, opts.breaker);
    this._readyPromise = null;
    // Called with the names of FRESH_TABLES that ready() had to create.
    this.onTablesCreated = opts.onTablesCreated || null;
  }

  async ready() {
    if (!this._readyPromise) {
      this._readyPromise = (async () => {
        // ALTER TABLE ... ADD COLUMN IF NOT EXISTS takes an ACCESS EXCLUSIVE
        // lock even when the column is there, so on every boot it queued
        // behind a long traffic report and every traffic read and write
        // queued behind it (and a timed-out ALTER failed ready()). Ask once
        // which of the added columns exist and only ALTER for missing ones.
        const added = [['event_submissions', 'ai_review'], ['traffic', 'ad'],
          ['newsletter_sends', 'failed_emails'], ['newsletter_sends', 'picks'], ['newsletter_sends', 'events'], ['newsletter_sends', 'chunks'], ['subscribers', 'old_tokens'],
          ['subscribers', 'ref_code'], ['subscribers', 'referred_by'], ['subscribers', 'ref_tier'],
          ['subscribers', 'reminded_at'], ['subscribers', 'pending_since'], ['subscribers', 'weekend_optout']];
        const cols = await this.pool.query(
          `SELECT table_name, column_name FROM information_schema.columns
            WHERE table_schema = current_schema() AND column_name = ANY($1::text[])`,
          [added.map(a => a[1])]);
        const have = new Set((cols.rows || []).map(r => `${r.table_name}.${r.column_name}`));
        // Subscribers and paid orders exist nowhere else. Finding their
        // tables missing means this is a new, empty database (a recreated
        // Postgres service or volume): everything else refills itself from
        // candidates.json, so without saying so the site looks fine while
        // the list and the orders are gone. The caller alerts.
        const existing = await this.pool.query(
          `SELECT table_name FROM information_schema.tables
            WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
          [FRESH_TABLES]);
        const present = new Set((existing.rows || []).map(r => r.table_name));
        const created = FRESH_TABLES.filter(t => !present.has(t));
        const addColumn = async (table, column, sql) => {
          if (!have.has(`${table}.${column}`)) await this.pool.query(sql);
        };
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS event_submissions (
            id TEXT PRIMARY KEY,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            status TEXT NOT NULL DEFAULT 'pending',
            source TEXT NOT NULL DEFAULT 'submission',
            submitter_kind TEXT,
            submitter_name TEXT,
            submitter_email TEXT,
            submitter_ip TEXT,
            user_agent TEXT,
            payload JSONB NOT NULL,
            admin_notes TEXT,
            review_history JSONB NOT NULL DEFAULT '[]'::jsonb
          );
        `);
        // The AI submission review's decision (server/submissionReview.js).
        await addColumn('event_submissions', 'ai_review', 'ALTER TABLE event_submissions ADD COLUMN IF NOT EXISTS ai_review JSONB');
        await this.pool.query(`
          CREATE INDEX IF NOT EXISTS event_submissions_status_idx
            ON event_submissions(status);
        `);
        await this.pool.query(`
          CREATE INDEX IF NOT EXISTS event_submissions_created_idx
            ON event_submissions(created_at DESC);
        `);
        // Single-row store for the most-recent published events.json payload.
        // Lets Railway operate independently of GitHub when GITHUB_TOKEN is
        // not configured or the GitHub API is unreachable.
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS published_events (
            id INT PRIMARY KEY,
            payload JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);
        // Admin event-edits overlay (PR #22). Keyed by the original event
        // identity (date|name|venue) so subsequent edits to the same row
        // upsert the same record instead of stacking.
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS event_edits (
            original_key TEXT PRIMARY KEY,
            payload JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);
        // Every event ever published, keyed by its public page path, so
        // /events/<slug> keeps working after the week rotates out.
        // Visitor stats (server/analytics.js): one row per page view, click,
        // or crawler hit. No IPs or cookies, only a daily visitor hash.
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS traffic (
            id BIGSERIAL PRIMARY KEY,
            day DATE NOT NULL,
            ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            kind TEXT NOT NULL,
            path TEXT,
            visitor TEXT,
            ref_source TEXT,
            ref_host TEXT,
            click_type TEXT,
            click_url TEXT,
            bot TEXT
          );
        `);
        await this.pool.query('CREATE INDEX IF NOT EXISTS traffic_day_idx ON traffic(day);');
        // The sponsor order an impression or click belongs to (data-ad), for
        // sponsor and Vic's Pick reports.
        await addColumn('traffic', 'ad', 'ALTER TABLE traffic ADD COLUMN IF NOT EXISTS ad TEXT;');
        // Newsletter subscribers (server/newsletter.js). token is the secret
        // in confirm/unsubscribe links.
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS subscribers (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL DEFAULT 'pending',
            token TEXT NOT NULL UNIQUE,
            source TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            confirmed_at TIMESTAMPTZ,
            unsubscribed_at TIMESTAMPTZ
          );
        `);
        // Tokens a returning subscriber had before (addSubscriber): they
        // still unsubscribe, so links in older issues keep working.
        await addColumn('subscribers', 'old_tokens', `ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS old_tokens TEXT[] NOT NULL DEFAULT '{}'`);
        // Referrals: each subscriber's own code, and the code of whoever
        // brought them in (see FileStore.ensureRefCodes). The column and its
        // unique constraint come in one statement, so neither can exist
        // without the other (and no index is built on every boot).
        await addColumn('subscribers', 'ref_code', 'ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS ref_code TEXT UNIQUE');
        await addColumn('subscribers', 'referred_by', 'ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS referred_by TEXT');
        await addColumn('subscribers', 'ref_tier', 'ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS ref_tier INT NOT NULL DEFAULT 0');
        // When a pending signup got its one "tap to confirm" reminder.
        await addColumn('subscribers', 'reminded_at', 'ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS reminded_at TIMESTAMPTZ');
        // When a pending signup asked (a first signup or a comeback), so the
        // reminder goes a day after the ask, not a day after the first signup.
        await addColumn('subscribers', 'pending_since', 'ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS pending_since TIMESTAMPTZ');
        // Turned off the Thursday weekend issue (still gets Monday's).
        await addColumn('subscribers', 'weekend_optout', 'ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS weekend_optout BOOLEAN NOT NULL DEFAULT FALSE');
        // A run of soft bounces (FileStore.recordSoftBounce, SOFT_BOUNCE).
        await addColumn('subscribers', 'soft_bounces', 'ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS soft_bounces INT NOT NULL DEFAULT 0');
        await addColumn('subscribers', 'soft_bounce_first_at', 'ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS soft_bounce_first_at TIMESTAMPTZ');
        await addColumn('subscribers', 'soft_bounce_last_at', 'ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS soft_bounce_last_at TIMESTAMPTZ');
        // When an address bounced, so the daily history counts it as leaving
        // (before October 2026 a bounce was only a status). Soft bounces
        // carry their last date; older hard bounces stay undated.
        await addColumn('subscribers', 'bounced_at', 'ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS bounced_at TIMESTAMPTZ');
        await this.pool.query(`UPDATE subscribers SET bounced_at = soft_bounce_last_at
          WHERE status = 'bounced' AND bounced_at IS NULL AND soft_bounce_last_at IS NOT NULL`);
        // Why someone left (FileStore.unsubscribeByEmail): unsubscribe,
        // complaint, bad_address, typo_fixed. NULL before October 2026.
        await addColumn('subscribers', 'unsub_reason', 'ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS unsub_reason TEXT');
        // FileStore.saveSubscriberCounts: the list's counts, once a day.
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS subscriber_counts (
            day DATE PRIMARY KEY,
            active INT NOT NULL,
            pending INT NOT NULL,
            bounced INT NOT NULL,
            unsubscribed INT NOT NULL,
            recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS newsletter_sends (
            week_key TEXT PRIMARY KEY,
            subject TEXT,
            recipients INT NOT NULL DEFAULT 0,
            failed INT NOT NULL DEFAULT 0,
            sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);
        // Who didn't get it, so a retry resends to them only.
        await addColumn('newsletter_sends', 'failed_emails', `ALTER TABLE newsletter_sends ADD COLUMN IF NOT EXISTS failed_emails JSONB NOT NULL DEFAULT '[]'::jsonb`);
        // Paid Vic's Pick order ids the issue starred, for their reports.
        await addColumn('newsletter_sends', 'picks', 'ALTER TABLE newsletter_sends ADD COLUMN IF NOT EXISTS picks JSONB');
        // Event pages the issue showed, for the event reports (server/eventReach.js).
        await addColumn('newsletter_sends', 'events', 'ALTER TABLE newsletter_sends ADD COLUMN IF NOT EXISTS events JSONB');
        // Each batch's idempotency key, members and outcome, saved when first
        // tried, so a retry resends a batch under its original key
        // (newsletter.js sendWeeklyNow).
        await addColumn('newsletter_sends', 'chunks', `ALTER TABLE newsletter_sends ADD COLUMN IF NOT EXISTS chunks JSONB NOT NULL DEFAULT '[]'::jsonb`);
        // Referral rewards (see FileStore.addReferralReward). key is unique:
        // a tier per referrer, or a month's drawing, is created once.
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS referral_rewards (
            id TEXT PRIMARY KEY,
            key TEXT NOT NULL UNIQUE,
            kind TEXT NOT NULL,
            ref_code TEXT,
            email TEXT NOT NULL,
            tier INT,
            month TEXT,
            amount INT NOT NULL,
            status TEXT NOT NULL,
            order_id TEXT,
            entries INT,
            total_entries INT,
            flags TEXT,
            reason TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);
        // Newsletter opens (see FileStore.recordEmailOpen): one row per
        // issue and subscriber.
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS email_opens (
            week_key TEXT NOT NULL,
            subscriber_id TEXT NOT NULL,
            opens INT NOT NULL DEFAULT 1,
            first_opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (week_key, subscriber_id)
          );
        `);
        // Sponsor orders (server/sponsors.js). Low volume, read whole; the
        // order itself lives in payload so new fields need no migration.
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS sponsor_orders (
            id TEXT PRIMARY KEY,
            payload JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);
        // Weekly sponsor logos (small images, read only when displayed).
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS sponsor_logos (
            id TEXT PRIMARY KEY,
            content_type TEXT NOT NULL,
            data BYTEA NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS event_archive (
            page TEXT PRIMARY KEY,
            event_date DATE,
            payload JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);
        // One row per scheduled job per slot (server/scheduler.js): the
        // primary key is what stops two containers firing the same job.
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS scheduler_runs (
            job TEXT NOT NULL,
            slot TEXT NOT NULL,
            status TEXT NOT NULL,
            attempts INT NOT NULL DEFAULT 1,
            started_at TIMESTAMPTZ NOT NULL,
            finished_at TIMESTAMPTZ,
            retry_at TIMESTAMPTZ,
            detail TEXT,
            PRIMARY KEY (job, slot)
          );
        `);
        // Contact form messages, so a lead survives a Slack outage and is
        // listed in admin.
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS contact_messages (
            id TEXT PRIMARY KEY,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            payload JSONB NOT NULL
          );
        `);
        // The owner inbox (server/inbox.js): every owner ping, for HQ.
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS inbox_events (
            id BIGSERIAL PRIMARY KEY,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            channel TEXT NOT NULL,
            severity TEXT NOT NULL,
            kind TEXT NOT NULL,
            title TEXT NOT NULL,
            payload JSONB NOT NULL
          );
        `);
        // Meta's ad results per day (FileStore.saveAdSpend), for the
        // admin's real cost per subscriber.
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS ad_spend (
            day DATE PRIMARY KEY,
            spend NUMERIC(12,2) NOT NULL DEFAULT 0,
            impressions INT NOT NULL DEFAULT 0,
            clicks INT NOT NULL DEFAULT 0,
            leads INT NOT NULL DEFAULT 0,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);
        if (created.length && typeof this.onTablesCreated === 'function') {
          try { this.onTablesCreated(created); } catch (err) { console.warn('[db] fresh-table hook failed:', err.message); }
        }
      })().catch(err => {
        this._readyPromise = null;
        throw err;
      });
    }
    return this._readyPromise;
  }

  _row(r) {
    if (!r) return null;
    return {
      id: r.id,
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
      updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
      status: r.status,
      source: r.source,
      submitter_kind: r.submitter_kind,
      submitter_name: r.submitter_name,
      submitter_email: r.submitter_email,
      submitter_ip: r.submitter_ip,
      user_agent: r.user_agent,
      payload: r.payload,
      admin_notes: r.admin_notes,
      review_history: r.review_history || [],
      ai_review: r.ai_review || null
    };
  }

  // See FileStore.claimTown. town_meta is created here, not in ready(), so
  // Victoria's database (which never claims) gets no new table.
  async claimTown(id) {
    await this.ready();
    await this.pool.query('CREATE TABLE IF NOT EXISTS town_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const owner = async () => ((await this.pool.query("SELECT value FROM town_meta WHERE key = 'town'")).rows[0] || {}).value || null;
    const town = await owner();
    if (town) return { town, claimed: false, hasData: null };
    const n = await this.pool.query(`SELECT (SELECT COUNT(*) FROM subscribers) + (SELECT COUNT(*) FROM sponsor_orders)
      + (SELECT COUNT(*) FROM event_submissions) AS n`);
    const hasData = Number(n.rows[0].n) > 0;
    if (hasData) return { town: null, claimed: false, hasData };
    await this.pool.query("INSERT INTO town_meta (key, value) VALUES ('town', $1) ON CONFLICT (key) DO NOTHING", [id]);
    const now = await owner();   // another instance may have claimed it first
    return { town: now, claimed: now === id, hasData };
  }

  async insert(row) {
    await this.ready();
    const q = `
      INSERT INTO event_submissions
        (id, created_at, updated_at, status, source, submitter_kind,
         submitter_name, submitter_email, submitter_ip, user_agent, payload,
         admin_notes, review_history)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *;
    `;
    const r = await this.pool.query(q, [
      row.id, row.created_at, row.updated_at, row.status, row.source,
      row.submitter_kind, row.submitter_name, row.submitter_email,
      row.submitter_ip, row.user_agent, toJsonb(row.payload), row.admin_notes,
      toJsonb(row.review_history || [])
    ]);
    return this._row(r.rows[0]);
  }

  // The admin's list is the newest 500. Readers that need every upcoming
  // approval (auto-publish, retryLive, paid pick reminders, the admin
  // picker) pass fromDate: the cap dropped an approval made long before its
  // date once 500 newer ones existed, and auto-publish then retired it as
  // missing. Upcoming rows are few, so that read has no cap.
  async list({ status, fromDate } = {}) {
    await this.ready();
    const args = [];
    const where = [];
    if (status) { args.push(status); where.push(`status = $${args.length}`); }
    if (fromDate) { args.push(fromDate); where.push(`payload->>'date' >= $${args.length}`); }
    let q = 'SELECT * FROM event_submissions';
    if (where.length) q += ' WHERE ' + where.join(' AND ');
    q += ' ORDER BY created_at DESC';
    if (!fromDate) q += ' LIMIT 500';
    const r = await this.pool.query(q, args);
    return r.rows.map(x => this._row(x));
  }

  async get(id) {
    await this.ready();
    const r = await this.pool.query('SELECT * FROM event_submissions WHERE id=$1', [id]);
    return this._row(r.rows[0] || null);
  }

  async update(id, patch) {
    await this.ready();
    const fields = ['status', 'source', 'submitter_kind', 'submitter_name',
      'submitter_email', 'admin_notes', 'payload', 'review_history', 'ai_review'];
    const sets = [];
    const args = [];
    for (const f of fields) {
      if (patch[f] !== undefined) {
        args.push(['review_history', 'payload', 'ai_review'].includes(f) ? toJsonb(patch[f]) : patch[f]);
        sets.push(`${f} = $${args.length}`);
      }
    }
    sets.push('updated_at = NOW()');
    args.push(id);
    const q = `UPDATE event_submissions SET ${sets.join(', ')} WHERE id = $${args.length} RETURNING *`;
    const r = await this.pool.query(q, args);
    return this._row(r.rows[0] || null);
  }

  async getPublished() {
    await this.ready();
    const r = await this.pool.query(
      'SELECT payload FROM published_events WHERE id = 1'
    );
    return r.rows[0] ? r.rows[0].payload : null;
  }

  async setPublished(payload) {
    await this.ready();
    await this.pool.query(`
      INSERT INTO published_events (id, payload, updated_at)
      VALUES (1, $1, NOW())
      ON CONFLICT (id) DO UPDATE
        SET payload = EXCLUDED.payload, updated_at = NOW();
    `, [toJsonb(payload)]);
    return payload;
  }

  async archiveEvents(events) {
    await this.ready();
    const rows = events.filter(ev => ev && ev.page);
    for (const ev of rows) {
      await this.pool.query(`
        INSERT INTO event_archive (page, event_date, payload, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (page) DO UPDATE
          SET event_date = EXCLUDED.event_date, payload = EXCLUDED.payload, updated_at = NOW();
      `, [ev.page, /^\d{4}-\d{2}-\d{2}$/.test(ev.date || '') ? ev.date : null, toJsonb(ev)]);
    }
    // Publishes are a few a week: a fine time to drop pages past retention.
    await this.pool.query('DELETE FROM event_archive WHERE event_date < CURRENT_DATE - $1::int', [ARCHIVE_RETENTION_DAYS]);
  }

  async recordTraffic(row) {
    await this.ready();
    await this.pool.query(`
      INSERT INTO traffic (day, kind, path, visitor, ref_source, ref_host, click_type, click_url, bot, ad)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);
    `, [row.day, row.kind, row.path || null, row.visitor || null, row.ref_source || null,
        row.ref_host || null, row.click_type || null, row.click_url || null, row.bot || null, row.ad || null]);
    // Prune now and then instead of on a schedule.
    if (Math.random() < 0.002) {
      await this.pool.query(`DELETE FROM traffic WHERE day < CURRENT_DATE - $1::int`, [TRAFFIC_RETENTION_DAYS]);
      // Newsletter opens are kept as long as traffic.
      await this.pool.query(`DELETE FROM email_opens WHERE first_opened_at < NOW() - make_interval(days => $1::int)`, [TRAFFIC_RETENTION_DAYS]);
    }
  }

  // Grouped in SQL: a year of raw rows is hundreds of thousands, and the
  // summary only needs counts. `n` is how many raw rows each one stands for
  // (summarize in analytics.js weighs by it); the visitor hash is daily, so
  // grouping by it keeps unique-visitor counts exact.
  async listTraffic(sinceDay) {
    await this.ready();
    const r = await this.pool.query(`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, kind, path, visitor, ref_source, ref_host,
             click_type, click_url, bot, ad, COUNT(*)::int AS n
      FROM traffic WHERE day >= $1::date
      GROUP BY day, kind, path, visitor, ref_source, ref_host, click_type, click_url, bot, ad
    `, [sinceDay]);
    return r.rows;
  }

  // ─── Newsletter ───
  async addSubscriber({ email, source, referredBy = null }) {
    await this.ready();
    const existing = (await this.pool.query('SELECT * FROM subscribers WHERE email = $1', [email])).rows[0];
    if (existing && existing.status === 'active') return existing;
    if (existing && existing.status === 'pending') return existing;
    if (existing) {
      // Coming back: credit where they came back from. The token also
      // confirms, and the old one is in every issue they got, forwarded
      // ones included, so whoever holds one could sign them back up without
      // their mailbox. So: a new token, with the old one kept only for
      // unsubscribing (Gmail's Unsubscribe on an older issue still works).
      const row = (await this.pool.query(
        `UPDATE subscribers SET status = 'pending', old_tokens = array_append(old_tokens, token), token = $2,
           unsubscribed_at = NULL, bounced_at = NULL, unsub_reason = NULL, source = $3, pending_since = NOW(), reminded_at = NULL, weekend_optout = FALSE,
           soft_bounces = 0, soft_bounce_first_at = NULL, soft_bounce_last_at = NULL WHERE email = $1 RETURNING *`,
        [email, newToken(), source])).rows[0];
      return { ...row, new_signup: true };
    }
    // xmax = 0 means this statement inserted the row (not the conflict path).
    const row = (await this.pool.query(
      `INSERT INTO subscribers (id, email, status, token, source, referred_by, pending_since) VALUES ($1, $2, 'pending', $3, $4, $5, NOW())
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING *, (xmax = 0) AS inserted`,
      [newId(), email, newToken(), source, referredBy])).rows[0];
    const { inserted, ...sub } = row;
    return { ...sub, new_signup: Boolean(inserted) };
  }

  async confirmSubscriber(token) {
    if (!token) return null;
    await this.ready();
    // newly_confirmed: was pending until this call (the welcome email goes out once).
    // confirmed_at is when they (re)joined, as in FileStore: a comeback starts
    // a new referral hold and counts in the month they came back.
    const r = await this.pool.query(
      `WITH prev AS (
         SELECT id, status FROM subscribers WHERE token = $1 AND status <> 'unsubscribed' FOR UPDATE
       )
       UPDATE subscribers s SET status = 'active',
         confirmed_at = CASE WHEN prev.status <> 'active' THEN NOW() ELSE s.confirmed_at END
       FROM prev WHERE s.id = prev.id
       RETURNING s.*, (prev.status <> 'active') AS newly_confirmed`, [token]);
    return r.rows[0] || null;
  }

  async unsubscribe(token) {
    if (!token) return false;
    await this.ready();
    const r = await this.pool.query(
      `UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = NOW(), unsub_reason = 'unsubscribe' WHERE token = $1 OR $1 = ANY(old_tokens)`, [token]);
    return r.rowCount > 0;
  }

  // See FileStore.listConfirmReminders.
  async listConfirmReminders({ from, to, limit = 100 }) {
    await this.ready();
    const r = await this.pool.query(
      `SELECT id, email, token FROM subscribers
        WHERE status = 'pending' AND reminded_at IS NULL
          AND COALESCE(pending_since, created_at) >= $1 AND COALESCE(pending_since, created_at) <= $2
        ORDER BY COALESCE(pending_since, created_at) LIMIT $3`, [from, to, limit]);
    return r.rows;
  }

  async markReminded(id, done = true) {
    await this.ready();
    const r = done
      ? await this.pool.query('UPDATE subscribers SET reminded_at = NOW() WHERE id = $1 AND reminded_at IS NULL', [id])
      : await this.pool.query('UPDATE subscribers SET reminded_at = NULL WHERE id = $1', [id]);
    return r.rowCount > 0;
  }

  // See FileStore.markSubscribersBounced.
  async markSubscribersBounced(emails) {
    if (!emails || !emails.length) return 0;
    await this.ready();
    const r = await this.pool.query(
      `UPDATE subscribers SET status = 'bounced', bounced_at = NOW() WHERE email = ANY($1::text[]) AND status = 'active'`, [emails]);
    return r.rowCount;
  }

  // See FileStore.replaceSubscriberEmail.
  async replaceSubscriberEmail(from, to) {
    await this.ready();
    const r = await this.pool.query(
      'UPDATE subscribers SET email = $2 WHERE email = $1 AND NOT EXISTS (SELECT 1 FROM subscribers WHERE email = $2)', [from, to]);
    return r.rowCount > 0;
  }

  // See FileStore.recordSoftBounce. Count first, then mark the ones whose
  // run is long enough; the second statement re-checks, so it's safe alone.
  async recordSoftBounce(emails, now = new Date()) {
    if (!emails || !emails.length) return [];
    await this.ready();
    const ms = v => `${v} milliseconds`;
    const counted = await this.pool.query(
      `UPDATE subscribers SET
         soft_bounces = CASE WHEN soft_bounce_last_at IS NULL OR soft_bounce_last_at <= $2::timestamptz - $4::interval THEN 1 ELSE soft_bounces + 1 END,
         soft_bounce_first_at = CASE WHEN soft_bounce_last_at IS NULL OR soft_bounce_last_at <= $2::timestamptz - $4::interval THEN $2::timestamptz ELSE soft_bounce_first_at END,
         soft_bounce_last_at = $2::timestamptz
       WHERE email = ANY($1::text[]) AND status = 'active'
         AND (soft_bounce_last_at IS NULL OR soft_bounce_last_at <= $2::timestamptz - $3::interval)`,
      [emails, now.toISOString(), ms(SOFT_BOUNCE.sameSendMs), ms(SOFT_BOUNCE.resetMs)]);
    if (!counted.rowCount) return [];
    const r = await this.pool.query(
      `UPDATE subscribers SET status = 'bounced', bounced_at = soft_bounce_last_at
       WHERE email = ANY($1::text[]) AND status = 'active' AND soft_bounces >= $2
         AND soft_bounce_last_at - soft_bounce_first_at >= $3::interval
       RETURNING email`,
      [emails, SOFT_BOUNCE.limit, ms(SOFT_BOUNCE.minSpanMs)]);
    return r.rows.map(row => row.email);
  }

  // See FileStore.clearSoftBounces.
  async clearSoftBounces(emails) {
    if (!emails || !emails.length) return 0;
    await this.ready();
    const r = await this.pool.query(
      `UPDATE subscribers SET soft_bounces = 0, soft_bounce_first_at = NULL, soft_bounce_last_at = NULL
       WHERE email = ANY($1::text[]) AND soft_bounces > 0`, [emails]);
    return r.rowCount;
  }

  // See FileStore.unsubscribeByEmail.
  async unsubscribeByEmail(emails, reason = null) {
    if (!emails || !emails.length) return 0;
    await this.ready();
    const r = await this.pool.query(
      `UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = NOW(), unsub_reason = $2 WHERE email = ANY($1::text[]) AND status <> 'unsubscribed'`, [emails, reason]);
    return r.rowCount;
  }

  async getSubscriberByToken(token) {
    if (!token) return null;
    await this.ready();
    const r = await this.pool.query('SELECT email, status, weekend_optout FROM subscribers WHERE token = $1 OR $1 = ANY(old_tokens)', [token]);
    return r.rows[0] || null;
  }

  async setWeekendOptout(token, optout) {
    if (!token) return null;
    await this.ready();
    const r = await this.pool.query(
      'UPDATE subscribers SET weekend_optout = $2 WHERE token = $1 OR $1 = ANY(old_tokens) RETURNING email, status, weekend_optout', [token, Boolean(optout)]);
    return r.rows[0] || null;
  }

  async listSubscribers({ status } = {}) {
    await this.ready();
    const r = status
      ? await this.pool.query('SELECT id, email, status, token, weekend_optout FROM subscribers WHERE status = $1 ORDER BY created_at', [status])
      : await this.pool.query('SELECT id, email, status, token, weekend_optout FROM subscribers ORDER BY created_at');
    return r.rows;
  }

  // See FileStore.listConfirmedSince. Compared at milliseconds, the precision
  // of the ISO cursor HQ hands back, so the last one isn't returned twice.
  async listConfirmedSince(after, limit = 500) {
    await this.ready();
    const live = "status = 'active' AND confirmed_at IS NOT NULL AND COALESCE(source, '') <> 'import'";
    const { rows: [top] } = await this.pool.query(`SELECT MAX(confirmed_at) AS latest FROM subscribers WHERE ${live}`);
    const latest = top && top.latest ? new Date(top.latest).toISOString() : null;
    if (!after) return { latest, subscribers: [] };
    const r = await this.pool.query(`SELECT email, confirmed_at FROM subscribers WHERE ${live} AND date_trunc('milliseconds', confirmed_at) > $1 ORDER BY confirmed_at LIMIT $2`,
      [new Date(after), limit]);
    return { latest, subscribers: r.rows.map(x => ({ email: x.email, confirmed_at: new Date(x.confirmed_at).toISOString() })) };
  }

  async countWeekendOptouts() {
    await this.ready();
    const r = await this.pool.query("SELECT COUNT(*)::int AS n FROM subscribers WHERE status = 'active' AND weekend_optout");
    return Number(r.rows[0].n) || 0;
  }

  async countSubscribers() {
    await this.ready();
    const r = await this.pool.query('SELECT status, COUNT(*)::int AS n FROM subscribers GROUP BY status');
    const c = { active: 0, pending: 0, unsubscribed: 0 };
    for (const row of r.rows) c[row.status] = row.n;
    return c;
  }

  // See FileStore.ensureRefCodes. A code that collides with another
  // subscriber's (unique index) is retried with a fresh one.
  async ensureRefCodes(ids) {
    if (!ids || !ids.length) return {};
    await this.ready();
    const r = await this.pool.query('SELECT id, ref_code FROM subscribers WHERE id = ANY($1::text[])', [ids]);
    const out = {};
    for (const row of r.rows) {
      if (row.ref_code) { out[row.id] = row.ref_code; continue; }
      for (let tries = 0; tries < 5 && !out[row.id]; tries++) {
        try {
          const u = await this.pool.query(
            `UPDATE subscribers SET ref_code = COALESCE(ref_code, $2) WHERE id = $1 RETURNING ref_code`, [row.id, newRefCode()]);
          if (u.rows[0]) out[row.id] = u.rows[0].ref_code;
        } catch (err) {
          if (err.code !== '23505') throw err; // unique_violation: try another code
        }
      }
    }
    return out;
  }

  async getReferrer(code) {
    if (!code) return null;
    await this.ready();
    const r = await this.pool.query(
      `SELECT id, email, ref_code FROM subscribers WHERE ref_code = $1 AND status = 'active'`, [code]);
    return r.rows[0] || null;
  }

  // See FileStore.countReferrals.
  // See FileStore.countReferrals. Counted in JS (tallyReferrals) so one
  // inbox under several addresses counts once.
  async countReferrals(codes, { counted = true } = {}) {
    // Every code's friends, so an inbox another code already counts isn't
    // counted again here (tallyReferrals); then just the codes asked for.
    const all = referralCounts(tallyReferrals(await this.listReferredFriends(null)), counted);
    if (!codes) return all;
    const want = new Set(codes);
    return Object.fromEntries(Object.entries(all).filter(([c]) => want.has(c)));
  }

  async listReferredFriends(codes) {
    await this.ready();
    const sql = `SELECT f.referred_by, s.email AS referrer_email, COALESCE(s.status = 'active', false) AS referrer_active, f.email, f.confirmed_at
                   FROM subscribers f LEFT JOIN subscribers s ON s.ref_code = f.referred_by
                  WHERE f.status = 'active' AND f.referred_by IS NOT NULL`;
    const r = codes
      ? await this.pool.query(`${sql} AND f.referred_by = ANY($1::text[])`, [codes])
      : await this.pool.query(sql);
    return r.rows;
  }

  async topReferrers(limit = 10) {
    const tally = tallyReferrals(await this.listReferredFriends(null));
    const codes = Object.keys(tally);
    if (!codes.length) return [];
    const r = await this.pool.query('SELECT email, ref_code, ref_tier FROM subscribers WHERE ref_code = ANY($1::text[])', [codes]);
    return referrerRows(tally, r.rows, limit);
  }

  async listRefTiers(codes) {
    if (!codes || !codes.length) return {};
    await this.ready();
    const r = await this.pool.query('SELECT email, ref_code, ref_tier FROM subscribers WHERE ref_code = ANY($1::text[])', [codes]);
    return Object.fromEntries(r.rows.map(x => [x.ref_code, { email: x.email, ref_tier: Number(x.ref_tier) || 0 }]));
  }

  async setRefTier(code, n) {
    await this.ready();
    const r = await this.pool.query('UPDATE subscribers SET ref_tier = GREATEST(ref_tier, $2) WHERE ref_code = $1', [code, n]);
    return r.rowCount > 0;
  }

  // See FileStore.importSubscribers.
  async importSubscribers(emails, source) {
    await this.ready();
    const out = { added: 0, already: 0, skipped_unsubscribed: 0, skipped_bounced: 0 };
    for (const email of emails) {
      const existing = (await this.pool.query('SELECT status, old_tokens FROM subscribers WHERE email = $1', [email])).rows[0];
      const skip = existing && importSkip(existing);
      if (!existing) {
        await this.pool.query(
          `INSERT INTO subscribers (id, email, status, token, source, confirmed_at) VALUES ($1, $2, 'active', $3, $4, NOW())
           ON CONFLICT (email) DO NOTHING`, [newId(), email, newToken(), source]);
        out.added++;
      } else if (skip) {
        out[skip]++;
      } else {
        await this.pool.query(
          `UPDATE subscribers SET status = 'active', confirmed_at = CASE WHEN status <> 'active' THEN NOW() ELSE confirmed_at END WHERE email = $1`, [email]);
        out.already++;
      }
    }
    return out;
  }

  async recordNewsletterSend(rec) {
    await this.ready();
    await this.pool.query(`
      INSERT INTO newsletter_sends (week_key, subject, recipients, failed, failed_emails, picks, chunks, events, sent_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, NOW())
      ON CONFLICT (week_key) DO UPDATE SET subject = EXCLUDED.subject, recipients = EXCLUDED.recipients,
        failed = EXCLUDED.failed, failed_emails = EXCLUDED.failed_emails,
        picks = COALESCE(EXCLUDED.picks, newsletter_sends.picks), chunks = EXCLUDED.chunks,
        events = COALESCE(EXCLUDED.events, newsletter_sends.events), sent_at = NOW()
    `, [rec.week_key, rec.subject, rec.recipients, rec.failed, toJsonb(rec.failed_emails || []),
        Array.isArray(rec.picks) ? toJsonb(rec.picks) : null, toJsonb(Array.isArray(rec.chunks) ? rec.chunks : []),
        Array.isArray(rec.events) ? toJsonb(rec.events) : null]);
  }

  async saveSponsorOrder(order) {
    await this.ready();
    await this.pool.query(`
      INSERT INTO sponsor_orders (id, payload, created_at, updated_at) VALUES ($1, $2::jsonb, COALESCE($3::timestamptz, NOW()), NOW())
      ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()
    `, [order.id, toJsonb(order), order.created_at || null]);
  }

  async saveSponsorLogo(id, { contentType, data }) {
    await this.ready();
    await this.pool.query(`
      INSERT INTO sponsor_logos (id, content_type, data) VALUES ($1, $2, $3)
      ON CONFLICT (id) DO UPDATE SET content_type = EXCLUDED.content_type, data = EXCLUDED.data
    `, [id, contentType, Buffer.from(data)]);
  }

  async getSponsorLogo(id) {
    await this.ready();
    const r = await this.pool.query('SELECT content_type, data FROM sponsor_logos WHERE id = $1', [id]);
    return r.rows[0] ? { contentType: r.rows[0].content_type, data: r.rows[0].data } : null;
  }

  async deleteSponsorLogo(id) {
    await this.ready();
    await this.pool.query('DELETE FROM sponsor_logos WHERE id = $1', [id]);
  }

  async listSponsorOrders() {
    await this.ready();
    // Abandoned checkouts pile up; keep every live or recent order and let
    // old expired/failed ones (and checkouts the buyer backed out of) fall
    // out instead of capping the whole list.
    const r = await this.pool.query(
      `SELECT payload FROM sponsor_orders
        WHERE (COALESCE(payload->>'status', '') NOT IN ('expired', 'failed')
               AND NOT (payload->>'status' = 'cancelled' AND payload->>'paid_at' IS NULL))
           OR created_at > now() - interval '30 days'
        ORDER BY created_at DESC`);
    return r.rows.map(row => row.payload);
  }

  async getNewsletterSend(weekKey) {
    await this.ready();
    const r = await this.pool.query('SELECT * FROM newsletter_sends WHERE week_key = $1', [weekKey]);
    return r.rows[0] || null;
  }

  async listNewsletterSends(limit = 10) {
    await this.ready();
    const r = await this.pool.query('SELECT * FROM newsletter_sends ORDER BY sent_at DESC LIMIT $1', [limit]);
    return r.rows;
  }

  // See FileStore.recordEmailOpen. The INSERT ... SELECT only inserts for
  // a real subscriber id.
  async recordEmailOpen({ week_key, subscriber_id }) {
    await this.ready();
    const r = await this.pool.query(
      `INSERT INTO email_opens (week_key, subscriber_id)
         SELECT $1::text, id FROM subscribers WHERE id = $2::text
       ON CONFLICT (week_key, subscriber_id) DO UPDATE
         SET opens = email_opens.opens + 1, last_opened_at = NOW()`,
      [week_key, subscriber_id]);
    return r.rowCount > 0;
  }

  async countEmailOpens(weekKeys) {
    await this.ready();
    const r = await this.pool.query(
      'SELECT week_key, COUNT(*)::int AS n FROM email_opens WHERE week_key = ANY($1::text[]) GROUP BY week_key', [weekKeys]);
    return Object.fromEntries(r.rows.map(x => [x.week_key, Number(x.n)]));
  }

  async listSubscriberStats() {
    await this.ready();
    const r = await this.pool.query(
      `SELECT id, status, source, referred_by, created_at, confirmed_at, unsubscribed_at, bounced_at, unsub_reason, pending_since,
              weekend_optout FROM subscribers ORDER BY created_at`);
    const iso = v => (v instanceof Date ? v.toISOString() : v || null);
    return r.rows.map(x => ({ id: x.id, status: x.status, source: x.source || null, referred_by: x.referred_by || null,
      created_at: iso(x.created_at), confirmed_at: iso(x.confirmed_at), unsubscribed_at: iso(x.unsubscribed_at),
      bounced_at: iso(x.bounced_at), unsub_reason: x.unsub_reason || null, pending_since: iso(x.pending_since),
      weekend_optout: Boolean(x.weekend_optout) }));
  }

  // See FileStore.saveSubscriberCounts.
  async saveSubscriberCounts(day, counts) {
    await this.ready();
    await this.pool.query(
      `INSERT INTO subscriber_counts (day, active, pending, bounced, unsubscribed, recorded_at) VALUES ($1::date, $2, $3, $4, $5, NOW())
       ON CONFLICT (day) DO UPDATE SET active = EXCLUDED.active, pending = EXCLUDED.pending, bounced = EXCLUDED.bounced,
         unsubscribed = EXCLUDED.unsubscribed, recorded_at = NOW()`,
      [day, counts.active || 0, counts.pending || 0, counts.bounced || 0, counts.unsubscribed || 0]);
  }

  // See FileStore.listSubscriberCounts.
  async listSubscriberCounts(limit = 31) {
    await this.ready();
    const r = await this.pool.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, active, pending, bounced, unsubscribed, recorded_at
         FROM subscriber_counts ORDER BY day DESC LIMIT $1`, [limit]);
    return r.rows.reverse().map(x => ({ day: x.day, active: x.active, pending: x.pending, bounced: x.bounced,
      unsubscribed: x.unsubscribed, recorded_at: x.recorded_at instanceof Date ? x.recorded_at.toISOString() : x.recorded_at }));
  }

  async listEmailOpens(weekKeys) {
    await this.ready();
    const r = await this.pool.query('SELECT week_key, subscriber_id FROM email_opens WHERE week_key = ANY($1::text[])', [weekKeys]);
    return r.rows.map(x => ({ week_key: x.week_key, subscriber_id: x.subscriber_id }));
  }

  async saveAdSpend(rows) {
    await this.ready();
    if (!rows.length) return 0;
    // One statement, so a bad row saves nothing rather than half the days.
    await this.pool.query(
      `INSERT INTO ad_spend (day, spend, impressions, clicks, leads, updated_at)
       SELECT x.day, x.spend, x.impressions, x.clicks, x.leads, NOW()
         FROM jsonb_to_recordset($1::jsonb) AS x(day date, spend numeric, impressions int, clicks int, leads int)
       ON CONFLICT (day) DO UPDATE SET spend = EXCLUDED.spend, impressions = EXCLUDED.impressions,
         clicks = EXCLUDED.clicks, leads = EXCLUDED.leads, updated_at = NOW()`,
      [JSON.stringify(rows)]);
    return rows.length;
  }

  async listAdSpend(sinceDay) {
    await this.ready();
    const r = await this.pool.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, spend::float AS spend, impressions, clicks, leads
         FROM ad_spend WHERE day >= $1::date ORDER BY day`, [sinceDay]);
    return r.rows.map(x => ({ day: x.day, spend: Number(x.spend), impressions: Number(x.impressions), clicks: Number(x.clicks), leads: Number(x.leads) }));
  }

  async addReferralReward(row) {
    await this.ready();
    const r = await this.pool.query(
      `INSERT INTO referral_rewards (id, key, kind, ref_code, email, tier, month, amount, status, entries, total_entries, flags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (key) DO NOTHING RETURNING *`,
      [newId(), row.key, row.kind, row.ref_code || null, row.email, row.tier ?? null, row.month || null, row.amount, row.status,
        row.entries ?? null, row.total_entries ?? null, row.flags || null]);
    return r.rows[0] ? rewardRow(r.rows[0]) : null;
  }

  async updateReferralReward(id, patch) {
    await this.ready();
    const sets = [], vals = [id];
    for (const k of ['status', 'order_id', 'reason']) if (k in patch) { vals.push(patch[k]); sets.push(`${k} = $${vals.length}`); }
    const r = await this.pool.query(
      `UPDATE referral_rewards SET ${[...sets, 'updated_at = NOW()'].join(', ')} WHERE id = $1 RETURNING *`, vals);
    return r.rows[0] ? rewardRow(r.rows[0]) : null;
  }

  async getReferralReward(id) {
    await this.ready();
    const r = await this.pool.query('SELECT * FROM referral_rewards WHERE id = $1', [id]);
    return r.rows[0] ? rewardRow(r.rows[0]) : null;
  }

  async listReferralRewards({ statuses = null, limit = 30 } = {}) {
    await this.ready();
    const r = statuses
      ? await this.pool.query('SELECT * FROM referral_rewards WHERE status = ANY($1::text[]) ORDER BY created_at DESC LIMIT $2', [statuses, limit])
      : await this.pool.query('SELECT * FROM referral_rewards ORDER BY created_at DESC LIMIT $1', [limit]);
    return r.rows.map(rewardRow);
  }

  async getArchivedEvent(page) {
    await this.ready();
    const r = await this.pool.query('SELECT payload FROM event_archive WHERE page = $1', [page]);
    return r.rows[0] ? r.rows[0].payload : null;
  }

  async listArchivedEvents() {
    await this.ready();
    // page (the key) breaks date ties, so same-day rows come back in the same
    // order every time; physical row order shifts when rows are rewritten,
    // which reordered same-time events on venue pages between deploys.
    const r = await this.pool.query(
      'SELECT payload FROM event_archive WHERE event_date IS NULL OR event_date >= CURRENT_DATE - $1::int ORDER BY event_date DESC NULLS LAST, page',
      [ARCHIVE_RETENTION_DAYS]
    );
    return r.rows.map(row => row.payload);
  }

  async findDuplicate({ date, name, venue }) {
    await this.ready();
    const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const q = `
      SELECT * FROM event_submissions
      WHERE status <> 'rejected'
        AND payload->>'date' = $1
        AND lower(regexp_replace(coalesce(payload->>'name',''),'\\s+',' ','g')) = $2
        AND lower(regexp_replace(coalesce(payload->>'venue',''),'\\s+',' ','g')) = $3
      LIMIT 1;
    `;
    const r = await this.pool.query(q, [date, norm(name), norm(venue)]);
    return this._row(r.rows[0] || null);
  }

  async listEventEdits() {
    await this.ready();
    const r = await this.pool.query(
      'SELECT original_key, payload, created_at, updated_at FROM event_edits ORDER BY updated_at DESC'
    );
    return r.rows.map(row => ({
      id: row.original_key,
      original_key: row.original_key,
      payload: row.payload,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
    }));
  }

  async upsertEventEdit({ original_key, payload }) {
    await this.ready();
    const r = await this.pool.query(`
      INSERT INTO event_edits (original_key, payload, created_at, updated_at)
      VALUES ($1, $2, NOW(), NOW())
      ON CONFLICT (original_key) DO UPDATE
        SET payload = EXCLUDED.payload,
            updated_at = NOW()
      RETURNING original_key, payload, created_at, updated_at;
    `, [original_key, toJsonb(payload)]);
    const row = r.rows[0];
    return {
      id: row.original_key,
      original_key: row.original_key,
      payload: row.payload,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
    };
  }

  // ─── Scheduler runs (server/scheduler.js) ───
  // One statement, so two containers can't both claim a slot: the insert
  // wins for the first, and the update only fires for a slot whose retry
  // is due or whose run died (still "running" after 30 minutes).
  async claimJobRun(job, slot, now = new Date()) {
    await this.ready();
    const r = await this.pool.query(`
      INSERT INTO scheduler_runs (job, slot, status, attempts, started_at) VALUES ($1, $2, 'running', 1, $3)
      ON CONFLICT (job, slot) DO UPDATE
        SET status = 'running', attempts = scheduler_runs.attempts + 1, started_at = EXCLUDED.started_at, retry_at = NULL
        WHERE (scheduler_runs.status = 'retry' AND (scheduler_runs.retry_at IS NULL OR scheduler_runs.retry_at <= EXCLUDED.started_at))
           OR (scheduler_runs.status = 'running' AND scheduler_runs.started_at < EXCLUDED.started_at - interval '30 minutes')
      RETURNING attempts
    `, [job, slot, now.toISOString()]);
    return r.rows[0] ? { claimed: true, attempts: r.rows[0].attempts } : { claimed: false, attempts: 0 };
  }

  async finishJobRun(job, slot, { status, retry_at = null, detail = '' }) {
    await this.ready();
    await this.pool.query(
      'UPDATE scheduler_runs SET status = $3, retry_at = $4, detail = $5, finished_at = NOW() WHERE job = $1 AND slot = $2',
      [job, slot, status, retry_at, detail]);
  }

  async getJobRun(job, slot) {
    await this.ready();
    const r = await this.pool.query('SELECT job, slot, status, attempts, started_at, finished_at, retry_at, detail FROM scheduler_runs WHERE job = $1 AND slot = $2', [job, slot]);
    return r.rows[0] || null;
  }

  // ─── Jobs on Railway: see FileStore. The tables are created on first
  // use, not in ready(), so a database whose town never runs jobs on
  // Railway (Victoria's, until she moves) gets no new table.
  async _jobTables() {
    await this.ready();
    if (!this._jobTablesPromise) {
      this._jobTablesPromise = this.pool.query(`
        CREATE TABLE IF NOT EXISTS job_queue (
          id BIGSERIAL PRIMARY KEY, kind TEXT NOT NULL, slot TEXT NOT NULL, args JSONB NOT NULL DEFAULT '{}'::jsonb,
          status TEXT NOT NULL, queued_at TIMESTAMPTZ NOT NULL, started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ,
          result JSONB, UNIQUE (kind, slot));
        CREATE TABLE IF NOT EXISTS town_files (name TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL);
      `).catch(err => { this._jobTablesPromise = null; throw err; });
    }
    await this._jobTablesPromise;
  }

  async enqueueJob(kind, slot, args = {}, now = new Date(), { unlessPending = false } = {}) {
    await this._jobTables();
    const r = await this.pool.query(`
      INSERT INTO job_queue (kind, slot, args, status, queued_at)
      SELECT $1, $2, $3::jsonb, 'queued', $4
       WHERE NOT $5::boolean OR NOT EXISTS (SELECT 1 FROM job_queue WHERE kind = $1 AND status IN ('queued', 'running'))
      ON CONFLICT (kind, slot) DO NOTHING RETURNING id`, [kind, slot, JSON.stringify(args || {}), now.toISOString(), Boolean(unlessPending)]);
    if (r.rows[0]) return { queued: true, id: Number(r.rows[0].id) };
    if (unlessPending) {
      const p = await this.pool.query("SELECT id FROM job_queue WHERE kind = $1 AND status IN ('queued', 'running') ORDER BY id LIMIT 1", [kind]);
      if (p.rows[0]) return { queued: false, id: Number(p.rows[0].id), pending: true };
    }
    const dup = await this.pool.query('SELECT id FROM job_queue WHERE kind = $1 AND slot = $2', [kind, slot]);
    return { queued: false, id: dup.rows[0] ? Number(dup.rows[0].id) : null };
  }

  async claimJob(now = new Date()) {
    await this._jobTables();
    const r = await this.pool.query(`
      UPDATE job_queue SET status = 'running', started_at = $1
       WHERE id = (SELECT id FROM job_queue WHERE status = 'queued' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING *`, [now.toISOString()]);
    return r.rows[0] ? jobRow(r.rows[0]) : null;
  }

  async finishJob(id, { status, result = null }, now = new Date()) {
    await this._jobTables();
    const r = await this.pool.query(`
      UPDATE job_queue SET status = $2, result = $3::jsonb, finished_at = $4
       WHERE id = $1 AND status = 'running' RETURNING *`, [Number(id), status, JSON.stringify(result), now.toISOString()]);
    return r.rows[0] ? jobRow(r.rows[0]) : null;
  }

  async expireJobs(now = new Date(), limits = {}, fallbackMs = 30 * 60 * 1000) {
    await this._jobTables();
    // A month of history is plenty (the review alone runs 96 times a day).
    await this.pool.query("DELETE FROM job_queue WHERE status IN ('done', 'failed') AND finished_at < $1::timestamptz - interval '30 days'", [now.toISOString()]);
    const running = await this.pool.query("SELECT id, kind, started_at FROM job_queue WHERE status = 'running'");
    const out = [];
    for (const j of running.rows) {
      if (new Date(j.started_at).getTime() + (limits[j.kind] || fallbackMs) > now.getTime()) continue;
      const r = await this.pool.query(`
        UPDATE job_queue SET status = 'failed', finished_at = $2, result = $3::jsonb
         WHERE id = $1 AND status = 'running' RETURNING *`,
      [j.id, now.toISOString(), JSON.stringify({ error: 'timed out: the jobs worker stopped answering' })]);
      if (r.rows[0]) out.push(jobRow(r.rows[0]));
    }
    return out;
  }

  async listJobs(limit = 50) {
    await this._jobTables();
    const r = await this.pool.query('SELECT * FROM job_queue ORDER BY id DESC LIMIT $1', [limit]);
    return r.rows.map(jobRow);
  }

  async jobStats(now = new Date()) {
    await this._jobTables();
    const last = await this.pool.query(`
      SELECT DISTINCT ON (kind) * FROM job_queue WHERE status IN ('done', 'failed') ORDER BY kind, id DESC`);
    const live = await this.pool.query("SELECT kind, status, started_at FROM job_queue WHERE status IN ('queued', 'running') ORDER BY id");
    const failed = await this.pool.query("SELECT COUNT(*)::int AS n FROM job_queue WHERE status = 'failed' AND finished_at >= $1::timestamptz - interval '1 day'", [now.toISOString()]);
    return {
      last: Object.fromEntries(last.rows.map(r => [r.kind, jobRow(r)])),
      queued: live.rows.filter(r => r.status === 'queued').length,
      running: live.rows.filter(r => r.status === 'running').map(r => ({ kind: r.kind, started_at: new Date(r.started_at).toISOString() })),
      failed_24h: failed.rows[0].n
    };
  }

  async getTownFile(name) {
    await this._jobTables();
    const r = await this.pool.query('SELECT data, updated_at FROM town_files WHERE name = $1', [name]);
    const row = r.rows[0];
    return row ? { data: row.data, updated_at: new Date(row.updated_at).toISOString() } : null;
  }

  async setTownFile(name, value, now = new Date()) {
    await this._jobTables();
    await this.pool.query(`
      INSERT INTO town_files (name, data, updated_at) VALUES ($1, $2::jsonb, $3)
      ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
    [name, JSON.stringify(value), now.toISOString()]);
  }

  // ─── A town's social kit: see FileStore. Its own table, made on first
  // use by these methods only, which a town calls only with jobs on Railway
  // (Victoria's too since JOBS_ON_RAILWAY.md phase 5; without jobs her kit
  // is git's, docs/social/latest, and her database gets no new table).
  async _socialTable() {
    await this._jobTables();
    if (!this._socialTablePromise) {
      this._socialTablePromise = this.pool.query(`
        CREATE TABLE IF NOT EXISTS social_files (
          build TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, body BYTEA NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (build, name))`)
        .catch(err => { this._socialTablePromise = null; throw err; });
    }
    await this._socialTablePromise;
  }

  async putSocialFile(build, name, type, body, now = new Date()) {
    await this._socialTable();
    await this.pool.query(`
      DELETE FROM social_files WHERE build <> $1
         AND build <> COALESCE((SELECT data->>'build' FROM town_files WHERE name = 'social_kit'), '')`, [build]);
    await this.pool.query(`
      INSERT INTO social_files (build, name, type, body, updated_at) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (build, name) DO UPDATE SET type = EXCLUDED.type, body = EXCLUDED.body, updated_at = EXCLUDED.updated_at`,
    [build, name, type, Buffer.from(body), now.toISOString()]);
  }

  async socialBuildSize(build) {
    await this._socialTable();
    const r = await this.pool.query('SELECT name, octet_length(body) AS n FROM social_files WHERE build = $1', [build]);
    return { files: r.rows.length, bytes: r.rows.reduce((n, row) => n + Number(row.n), 0), names: r.rows.map(row => row.name) };
  }

  async getSocialBuildFile(build, name) {
    await this._socialTable();
    const r = await this.pool.query('SELECT type, body, updated_at FROM social_files WHERE build = $1 AND name = $2', [build, name]);
    const row = r.rows[0];
    return row ? { type: row.type, body: row.body, updated_at: new Date(row.updated_at).toISOString() } : null;
  }

  async publishSocialKit(build, info, now = new Date()) {
    await this._socialTable();
    await this.setTownFile('social_kit', { build, ...info, published_at: now.toISOString() }, now);
    await this.pool.query('DELETE FROM social_files WHERE build <> $1', [build]);
  }

  async getSocialFile(name) {
    await this._socialTable();
    const r = await this.pool.query(`
      SELECT f.type, f.body, f.updated_at, f.build FROM social_files f
        JOIN town_files t ON t.name = 'social_kit' AND t.data->>'build' = f.build
       WHERE f.name = $1`, [name]);
    const row = r.rows[0];
    return row ? { type: row.type, body: row.body, updated_at: new Date(row.updated_at).toISOString(), build: row.build } : null;
  }

  // ─── Contact form messages (server/contact.js) ───
  async saveContactMessage(msg) {
    await this.ready();
    await this.pool.query('INSERT INTO contact_messages (id, created_at, payload) VALUES ($1, $2, $3::jsonb) ON CONFLICT (id) DO NOTHING',
      [msg.id, msg.created_at, JSON.stringify(msg)]);
  }

  async listContactMessages(limit = 100) {
    await this.ready();
    const r = await this.pool.query('SELECT payload FROM contact_messages ORDER BY created_at DESC LIMIT $1', [limit]);
    return r.rows.map(row => row.payload);
  }

  // See FileStore.dismissContactMessage.
  async dismissContactMessage(id, at = nowIso()) {
    await this.ready();
    const r = await this.pool.query(
      "UPDATE contact_messages SET payload = payload || jsonb_build_object('dismissed_at', $2::text) WHERE id = $1",
      [id, at]);
    return r.rowCount > 0;
  }

  // See FileStore.addInboxEvent.
  async addInboxEvent(evt) {
    await this.ready();
    const r = await this.pool.query(
      'INSERT INTO inbox_events (created_at, channel, severity, kind, title, payload) VALUES (COALESCE($1::timestamptz, NOW()), $2, $3, $4, $5, $6::jsonb) RETURNING *',
      [evt.created_at || null, evt.channel, evt.severity, evt.kind, evt.title, JSON.stringify(evt.payload || {})]);
    return r.rows[0];
  }

  async listInboxEvents(sinceId = 0, limit = 200) {
    await this.ready();
    const r = await this.pool.query('SELECT * FROM inbox_events WHERE id > $1 ORDER BY id LIMIT $2', [sinceId, limit]);
    return r.rows.map(row => ({ ...row, id: Number(row.id), created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at }));
  }

  // See FileStore.listRecentInboxEvents.
  async listRecentInboxEvents(beforeId = 0, limit = 50) {
    await this.ready();
    const r = beforeId
      ? await this.pool.query('SELECT * FROM inbox_events WHERE id < $1 ORDER BY id DESC LIMIT $2', [beforeId, limit])
      : await this.pool.query('SELECT * FROM inbox_events ORDER BY id DESC LIMIT $1', [limit]);
    return r.rows.map(row => ({ ...row, id: Number(row.id), created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at }));
  }

  // See FileStore.latestInboxId.
  async latestInboxId() {
    await this.ready();
    const r = await this.pool.query('SELECT COALESCE(MAX(id), 0) AS id FROM inbox_events');
    return Number(r.rows[0].id);
  }

  async getInboxEvent(id) {
    await this.ready();
    const r = await this.pool.query('SELECT * FROM inbox_events WHERE id = $1', [id]);
    const row = r.rows[0];
    return row ? { ...row, id: Number(row.id), created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at } : null;
  }

  // See FileStore.purgePersonalData.
  async purgePersonalData({ submissionsBefore, contactBefore }) {
    await this.ready();
    const subs = await this.pool.query(
      `UPDATE event_submissions SET submitter_ip = NULL, user_agent = NULL
       WHERE created_at < $1::timestamptz AND (submitter_ip IS NOT NULL OR user_agent IS NOT NULL)`, [submissionsBefore]);
    const msgs = await this.pool.query('DELETE FROM contact_messages WHERE created_at < $1::timestamptz', [contactBefore]);
    await this.pool.query('DELETE FROM inbox_events WHERE created_at < $1::timestamptz', [contactBefore]);
    return { submissions: subs.rowCount || 0, contact_messages: msgs.rowCount || 0 };
  }

  // See FileStore.forgetEmail. One transaction on a pool client (the
  // breaker wraps only pool.query), so a failure part way leaves nothing
  // half-forgotten; each statement is safe to repeat anyway.
  async forgetEmail(email, masked) {
    await this.ready();
    const client = this.rawPool && typeof this.rawPool.connect === 'function' ? await this.rawPool.connect() : null;
    const db = client || this.pool;
    const n = r => (r && r.rowCount) || 0;
    try {
      if (client) await db.query('BEGIN');
      const out = {};
      out.email_opens = n(await db.query(
        'DELETE FROM email_opens WHERE subscriber_id IN (SELECT id FROM subscribers WHERE lower(email) = $1)', [email]));
      out.subscribers = n(await db.query('DELETE FROM subscribers WHERE lower(email) = $1', [email]));
      out.submissions = n(await db.query(
        `UPDATE event_submissions SET submitter_email = NULL, submitter_name = NULL, submitter_ip = NULL, user_agent = NULL,
           payload = payload || $2::jsonb, updated_at = NOW() WHERE lower(submitter_email) = $1`, [email, toJsonb(BLANK_SUBMITTER)]));
      out.contact_messages = n(await db.query("DELETE FROM contact_messages WHERE lower(payload->>'email') = $1", [email]));
      const inboxGone = n(await db.query("DELETE FROM inbox_events WHERE strpos(lower(title || ' ' || payload::text), $1) > 0", [email]));
      if (inboxGone) out.inbox_events = inboxGone;
      out.sponsor_orders = n(await db.query(
        `UPDATE sponsor_orders SET payload = jsonb_set(payload, '{email}', to_jsonb($2::text)), updated_at = NOW()
         WHERE lower(payload->>'email') = $1`, [email, masked]));
      out.referral_rewards = n(await db.query(
        `UPDATE referral_rewards SET email = $2,
           status = CASE WHEN status = ANY($3::text[]) THEN 'skipped' ELSE status END,
           reason = CASE WHEN status = ANY($3::text[]) THEN $4 ELSE reason END, updated_at = NOW()
         WHERE lower(email) = $1`, [email, masked, [...OPEN_REWARD], FORGOTTEN]));
      out.newsletter_sends = n(await db.query(
        `UPDATE newsletter_sends SET failed_emails = failed_emails - $1, failed = jsonb_array_length(failed_emails - $1)
         WHERE failed_emails ? $1`, [email]));
      if (client) await db.query('COMMIT');
      return out;
    } catch (err) {
      if (client) await db.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      if (client) client.release();
    }
  }

  async exportSubscribers() {
    await this.ready();
    const r = await this.pool.query(
      'SELECT email, status, source, created_at, confirmed_at, unsubscribed_at FROM subscribers ORDER BY created_at');
    const iso = v => (v instanceof Date ? v.toISOString() : v || null);
    return r.rows.map(x => ({ email: x.email, status: x.status, source: x.source || null,
      created_at: iso(x.created_at), confirmed_at: iso(x.confirmed_at), unsubscribed_at: iso(x.unsubscribed_at) }));
  }
}

// An idle connection dropping (Postgres restart, maintenance) makes the
// pool emit 'error'; with no listener Node treats that as an uncaught
// exception and the whole site restarts. The pool replaces the client on
// the next query, so a log line is enough.
export function watchPool(pool) {
  pool.on('error', err => console.warn('[db] idle client error:', err && err.message));
  return pool;
}

// ─── FACTORY ───
export async function createStore(opts = {}) {
  const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL;
  if (databaseUrl) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      // Railway Postgres ships SSL by default; allow self-signed certs.
      ssl: databaseUrl.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
      // A hung database (not a refused one) must fail fast, so page views
      // fall back to the bundled docs/events.json instead of piling up.
      connectionTimeoutMillis: 5000,
      query_timeout: 15000,
      statement_timeout: 15000
    });
    watchPool(pool);
    const store = new PgStore(pool, { onTablesCreated: opts.onTablesCreated });
    // Boot doesn't need the database: pages fall back to the bundled
    // events file, and ready() retries on the next query.
    try {
      await store.ready();
    } catch (err) {
      console.error('[db] database unavailable at boot:', err.message);
      if (typeof opts.onUnavailable === 'function') opts.onUnavailable(err);
    }
    return { kind: 'postgres', store, pool };
  }
  const file = opts.file || DEFAULT_FILE;
  return { kind: 'file', store: new FileStore(file), file };
}

export { FileStore, PgStore, newId, nowIso };
