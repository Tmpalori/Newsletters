// @vitest-environment node
//
// End-to-end tests for the submission API: validation, bot signals, dedupe,
// turnstile gating, admin auth, and admin status transitions.
//
// Each test creates a fresh app with an in-memory FileStore (tmpdir) so they
// don't share state.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

let tmpDir;
let appBundle;
let server;
let baseUrl;

async function startApp(opts = {}) {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-test-'));
  const file = path.join(tmpDir, 'submissions.json');
  const storeBundle = { kind: 'file', store: new FileStore(file), file };
  appBundle = await createApp(Object.assign({
    storeBundle,
    adminToken: 'test-admin-token',
    trustProxy: false
  }, opts));
  server = http.createServer(appBundle.app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
  return appBundle;
}

async function stopApp() {
  if (server) await new Promise(r => server.close(r));
  if (tmpDir) {
    try { await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch (_) {}
  }
  server = null; tmpDir = null; appBundle = null; baseUrl = null;
}

function fetchJson(method, path, body, headers) {
  const url = baseUrl + path;
  const init = { method, headers: Object.assign({}, headers || {}) };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  return fetch(url, init).then(async r => {
    let json = null;
    try { json = await r.json(); } catch (_) {}
    return { status: r.status, json, headers: r.headers };
  });
}

const validBody = (overrides = {}) => Object.assign({
  name: 'Live Music at the Dive',
  date: '2026-05-12',
  time: '7:00 PM',
  end_time: '10:00 PM',
  venue: 'The Dive Bar',
  address: '123 Main St',
  url: 'https://example.com/event',
  description: 'A test event description.',
  icons: ['music', 'drinks'],
  free: false,
  submitter_kind: 'organizer',
  submitter_first_name: 'Jane',
  submitter_last_name: 'Tester',
  submitter_name: 'Jane Tester',
  submitter_email: 'jane@example.com',
  submitter_phone: '(361) 555-0123',
  elapsed_ms: 5000
}, overrides);

describe('POST /api/submissions — validation', () => {
  beforeEach(async () => { await startApp(); });
  afterEach(async () => { await stopApp(); });

  it('accepts a fully valid submission', async () => {
    const r = await fetchJson('POST', '/api/submissions', validBody());
    expect(r.status).toBe(201);
    expect(r.json.ok).toBe(true);
    expect(r.json.queued).toBe(true);
    expect(typeof r.json.id).toBe('string');
  });

  it('rejects missing required fields with field-level errors', async () => {
    const r = await fetchJson('POST', '/api/submissions', validBody({
      name: '', date: '', time: '', venue: ''
    }));
    expect(r.status).toBe(400);
    expect(r.json.ok).toBe(false);
    expect(r.json.errors).toMatchObject({
      name: expect.any(String),
      date: expect.any(String),
      time: expect.any(String),
      venue: expect.any(String)
    });
  });

  it('rejects non-ISO dates', async () => {
    const r = await fetchJson('POST', '/api/submissions', validBody({ date: 'next Friday' }));
    expect(r.status).toBe(400);
    expect(r.json.errors.date).toBeDefined();
  });

  it('rejects non-http URLs', async () => {
    const r = await fetchJson('POST', '/api/submissions', validBody({ url: 'javascript:alert(1)' }));
    expect(r.status).toBe(400);
    expect(r.json.errors.url).toBeDefined();
  });

  it('accepts and normalizes a bare-host URL by adding https://', async () => {
    const r = await fetchJson('POST', '/api/submissions', validBody({ url: 'example.com/event' }));
    expect(r.status).toBe(201);
    const list = await fetchJson('GET', '/api/admin/submissions', undefined, {
      Authorization: 'Bearer test-admin-token'
    });
    expect(list.json.submissions[0].payload.url).toBe('https://example.com/event');
  });

  it('accepts a www-prefixed URL without scheme', async () => {
    const r = await fetchJson('POST', '/api/submissions', validBody({
      url: 'www.example.com', name: 'Other Show', date: '2026-06-01'
    }));
    expect(r.status).toBe(201);
    const list = await fetchJson('GET', '/api/admin/submissions', undefined, {
      Authorization: 'Bearer test-admin-token'
    });
    const stored = list.json.submissions.find(s => s.payload.name === 'Other Show');
    expect(stored.payload.url).toBe('https://www.example.com');
  });

  it('rejects malformed emails', async () => {
    const r = await fetchJson('POST', '/api/submissions', validBody({ submitter_email: 'not-an-email' }));
    expect(r.status).toBe(400);
    expect(r.json.errors.submitter_email).toBeDefined();
  });

  it('rejects when address is missing', async () => {
    const r = await fetchJson('POST', '/api/submissions', validBody({ address: '' }));
    expect(r.status).toBe(400);
    expect(r.json.errors.address).toBeDefined();
  });

  it('rejects when description is missing or blank', async () => {
    const r1 = await fetchJson('POST', '/api/submissions', validBody({ description: '' }));
    expect(r1.status).toBe(400);
    expect(r1.json.errors.description).toBeDefined();

    const r2 = await fetchJson('POST', '/api/submissions', validBody({ description: '   ' }));
    expect(r2.status).toBe(400);
    expect(r2.json.errors.description).toBeDefined();
  });

  it('rejects when first name, last name, email, or phone is missing', async () => {
    const r = await fetchJson('POST', '/api/submissions', validBody({
      submitter_first_name: '',
      submitter_last_name: '',
      submitter_email: '',
      submitter_phone: ''
    }));
    expect(r.status).toBe(400);
    expect(r.json.errors).toMatchObject({
      submitter_first_name: expect.any(String),
      submitter_last_name: expect.any(String),
      submitter_email: expect.any(String),
      submitter_phone: expect.any(String)
    });
  });

  it('rejects an obviously-wrong phone number', async () => {
    const r = await fetchJson('POST', '/api/submissions', validBody({ submitter_phone: 'abc' }));
    expect(r.status).toBe(400);
    expect(r.json.errors.submitter_phone).toBeDefined();
  });

  it('drops icons that are not in the allow-list', async () => {
    const r = await fetchJson('POST', '/api/submissions', validBody({ icons: ['music', 'evilcat'] }));
    expect(r.status).toBe(201);
    const list = await fetchJson('GET', '/api/admin/submissions', undefined, {
      Authorization: 'Bearer test-admin-token'
    });
    const stored = list.json.submissions[0];
    expect(stored.payload.icons).toContain('music');
    expect(stored.payload.icons).not.toContain('evilcat');
  });
});

describe('POST /api/submissions — bot signals', () => {
  beforeEach(async () => { await startApp(); });
  afterEach(async () => { await stopApp(); });

  it('honeypot field is silently dropped (returns ok but not queued)', async () => {
    const r = await fetchJson('POST', '/api/submissions', validBody({ company: 'AcmeBots Inc' }));
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.queued).toBe(false);
    // Confirm nothing was actually written.
    const list = await fetchJson('GET', '/api/admin/submissions', undefined, {
      Authorization: 'Bearer test-admin-token'
    });
    expect(list.json.submissions.length).toBe(0);
  });

  it('too-fast submissions are silently dropped', async () => {
    const r = await fetchJson('POST', '/api/submissions', validBody({ elapsed_ms: 200 }));
    expect(r.status).toBe(200);
    expect(r.json.queued).toBe(false);
  });

  it('a slow submission (tab left open for hours) is queued, not dropped', async () => {
    const r = await fetchJson('POST', '/api/submissions', validBody({ elapsed_ms: 3 * 60 * 60 * 1000 }));
    expect(r.status).toBe(201);
    expect(r.json.queued).toBe(true);
  });
});

describe('POST /api/submissions — turnstile gating', () => {
  // Oct 12: a visitor on a VPN got "couldn't verify you aren't a bot" three
  // times and gave up. A check that doesn't pass no longer turns the event
  // away: it's queued, labeled for the owner, and Slack hears about it.
  function recorder() {
    const alerts = [];
    const notes = [];
    return { alerts, notes, slack: { enabled: true, notify: async (m) => { notes.push(m); return true; }, alert: async (key, title, detail) => { alerts.push({ key, title, detail }); return true; } } };
  }

  it('takes a submission with no token, labeled, and alerts the owner', async () => {
    const rec = recorder();
    await startApp({ turnstileSecret: 'fake-secret', slack: rec.slack });
    const r = await fetchJson('POST', '/api/submissions', validBody(), {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0'
    });
    expect(r.status).toBe(201);
    expect(r.json.queued).toBe(true);
    const row = await appBundle.store.get(r.json.id);
    expect(row.status).toBe('pending');
    expect(row.review_history[0]).toMatchObject({ action: 'submitted', bot_check: 'failed' });
    expect(row.admin_notes).toMatch(/Bot check didn't pass \(missing-token\)/);
    expect(rec.notes.some(n => /bot check didn’t pass/.test(n.title))).toBe(true);
    const a = rec.alerts.find(x => x.key === 'form-bot:submit');
    expect(a.detail).toContain('Edge on Windows');
    await stopApp();
  });

  it('accepts when secret is configured and Cloudflare returns success, with no label or alert', async () => {
    const rec = recorder();
    const fakeFetch = async (url) => ({
      ok: true, json: async () => ({ success: true })
    });
    await startApp({ turnstileSecret: 'fake-secret', fetch: fakeFetch, slack: rec.slack });
    const r = await fetchJson('POST', '/api/submissions',
      validBody({ turnstile_token: 'cf-test-token' }));
    expect(r.status).toBe(201);
    expect(r.json.ok).toBe(true);
    const row = await appBundle.store.get(r.json.id);
    expect(row.review_history[0].bot_check).toBeUndefined();
    expect(rec.alerts).toEqual([]);
    await stopApp();
  });

  it('takes it when Cloudflare says the token failed (expired while typing) or is unreachable', async () => {
    const failing = async () => ({ ok: true, json: async () => ({ success: false, 'error-codes': ['timeout-or-duplicate'] }) });
    await startApp({ turnstileSecret: 'fake-secret', fetch: failing, slack: recorder().slack });
    let r = await fetchJson('POST', '/api/submissions', validBody({ turnstile_token: 'old' }));
    expect(r.status).toBe(201);
    await stopApp();
    const down = async () => { throw new Error('ETIMEDOUT'); };
    await startApp({ turnstileSecret: 'fake-secret', fetch: down, slack: recorder().slack });
    r = await fetchJson('POST', '/api/submissions', validBody({ turnstile_token: 'any', name: 'Another Event' }));
    expect(r.status).toBe(201);
    await stopApp();
  });

  it('refuses a token solved on another site (never one of our visitors)', async () => {
    const otherSite = async () => ({ ok: true, json: async () => ({ success: true, hostname: 'evil.example' }) });
    const rec = recorder();
    await startApp({ turnstileSecret: 'fake-secret', fetch: otherSite, slack: rec.slack });
    const r = await fetchJson('POST', '/api/submissions', validBody({ turnstile_token: 'replayed' }));
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('turnstile-failed');
    expect(rec.alerts.some(a => a.key === 'form-bot:submit')).toBe(false);
    await stopApp();
  });

  it('passes through when no secret configured (disabled)', async () => {
    await startApp({ turnstileSecret: null });
    const r = await fetchJson('POST', '/api/submissions', validBody());
    expect(r.status).toBe(201);
    const row = await appBundle.store.get(r.json.id);
    expect(row.review_history[0].bot_check).toBeUndefined();
    await stopApp();
  });
});

describe('POST /api/submissions — duplicate detection', () => {
  beforeEach(async () => { await startApp(); });
  afterEach(async () => { await stopApp(); });

  it('flags exact duplicates and does not queue a second copy', async () => {
    const r1 = await fetchJson('POST', '/api/submissions', validBody());
    expect(r1.status).toBe(201);

    const r2 = await fetchJson('POST', '/api/submissions', validBody());
    expect(r2.status).toBe(200);
    expect(r2.json.duplicate).toBe(true);
    expect(r2.json.queued).toBe(false);

    const list = await fetchJson('GET', '/api/admin/submissions', undefined, {
      Authorization: 'Bearer test-admin-token'
    });
    expect(list.json.submissions.length).toBe(1);
  });

  it('treats whitespace/case differences as duplicates', async () => {
    await fetchJson('POST', '/api/submissions', validBody());
    const r = await fetchJson('POST', '/api/submissions', validBody({
      name: '  LIVE music   AT the Dive  ',
      venue: 'the dive bar'
    }));
    expect(r.json.duplicate).toBe(true);
  });

  it('different dates are NOT duplicates', async () => {
    await fetchJson('POST', '/api/submissions', validBody());
    const r = await fetchJson('POST', '/api/submissions', validBody({ date: '2026-05-13' }));
    expect(r.status).toBe(201);
    expect(r.json.queued).toBe(true);
  });
});

describe('Admin API auth + transitions', () => {
  beforeEach(async () => { await startApp(); });
  afterEach(async () => { await stopApp(); });

  it('admin endpoints require Bearer token', async () => {
    const r = await fetchJson('GET', '/api/admin/submissions');
    expect(r.status).toBe(401);
  });

  it('rejects bad tokens', async () => {
    const r = await fetchJson('GET', '/api/admin/submissions', undefined, {
      Authorization: 'Bearer wrong'
    });
    expect(r.status).toBe(401);
  });

  it('lists submissions filtered by status', async () => {
    await fetchJson('POST', '/api/submissions', validBody());
    await fetchJson('POST', '/api/submissions', validBody({
      name: 'Another show', date: '2026-05-13'
    }));
    const r = await fetchJson('GET', '/api/admin/submissions?status=pending', undefined, {
      Authorization: 'Bearer test-admin-token'
    });
    expect(r.status).toBe(200);
    expect(r.json.submissions.length).toBe(2);
    expect(r.json.submissions.every(s => s.status === 'pending')).toBe(true);
  });

  it('approve transitions move a submission to approved status', async () => {
    const created = await fetchJson('POST', '/api/submissions', validBody());
    const id = created.json.id;
    const r = await fetchJson('POST', '/api/admin/submissions/' + id,
      { status: 'approved' },
      { Authorization: 'Bearer test-admin-token' });
    expect(r.status).toBe(200);
    expect(r.json.submission.status).toBe('approved');
    expect(r.json.submission.review_history.length).toBeGreaterThanOrEqual(2);
  });

  it('reject + duplicate transitions are accepted', async () => {
    const c1 = await fetchJson('POST', '/api/submissions', validBody());
    const c2 = await fetchJson('POST', '/api/submissions',
      validBody({ name: 'Other thing', date: '2026-05-14' }));
    const r1 = await fetchJson('POST', '/api/admin/submissions/' + c1.json.id,
      { status: 'rejected' }, { Authorization: 'Bearer test-admin-token' });
    const r2 = await fetchJson('POST', '/api/admin/submissions/' + c2.json.id,
      { status: 'duplicate' }, { Authorization: 'Bearer test-admin-token' });
    expect(r1.json.submission.status).toBe('rejected');
    expect(r2.json.submission.status).toBe('duplicate');
  });

  it('rejects invalid status values', async () => {
    const c = await fetchJson('POST', '/api/submissions', validBody());
    const r = await fetchJson('POST', '/api/admin/submissions/' + c.json.id,
      { status: 'magical' },
      { Authorization: 'Bearer test-admin-token' });
    expect(r.status).toBe(400);
  });

  it('payload edits go through validateSubmission', async () => {
    const c = await fetchJson('POST', '/api/submissions', validBody());
    const r = await fetchJson('POST', '/api/admin/submissions/' + c.json.id,
      { payload: { name: 'X', date: '2026-05-12', time: '7:00 PM', venue: 'The Dive Bar' } },
      { Authorization: 'Bearer test-admin-token' });
    expect(r.status).toBe(400);
    expect(r.json.errors.name).toBeDefined();
  });

  it('admin payload edit preserves all submitted fields end-to-end', async () => {
    // Mirrors the full round-trip an admin makes from the edit view: the
    // public submission lands, the admin tweaks the event details, and the
    // resulting row keeps every payload field (including end_time, address
    // and contact info) so the approved-events promotion has them.
    const c = await fetchJson('POST', '/api/submissions', validBody());
    const id = c.json.id;
    const editedPayload = {
      name: 'Live Music — edited',
      date: '2026-05-12',
      time: '8:00 PM',
      end_time: '11:00 PM',
      venue: 'The Dive Bar',
      address: '456 Other St',
      url: 'example.com/edited',
      description: 'Updated by admin.',
      icons: ['music'],
      free: true,
      submitter_kind: 'organizer',
      submitter_first_name: 'Jane',
      submitter_last_name: 'Tester',
      submitter_email: 'jane@example.com',
      submitter_phone: '(361) 555-0123'
    };
    const r = await fetchJson('POST', '/api/admin/submissions/' + id,
      { payload: editedPayload },
      { Authorization: 'Bearer test-admin-token' });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    const p = r.json.submission.payload;
    expect(p.name).toBe('Live Music — edited');
    expect(p.time).toBe('8:00 PM');
    expect(p.end_time).toBe('11:00 PM');
    expect(p.address).toBe('456 Other St');
    // URL should be normalized server-side (bare host gets https://).
    expect(p.url).toBe('https://example.com/edited');
    expect(p.submitter_first_name).toBe('Jane');
    expect(p.submitter_last_name).toBe('Tester');
    expect(p.submitter_phone).toBe('(361) 555-0123');
    // free: true means the icons should be augmented with 'free'.
    expect(p.icons).toContain('free');
  });

  it('admin Save Edits succeeds on a LEGACY row missing submitter contact fields', async () => {
    // Regression for the post-PR#32/#34 Save Edits 400. Rows created before
    // first/last/phone became required don't carry those keys on the payload;
    // when the admin opens the edit view, the contact inputs are blank, and
    // saving used to fail validation. The admin endpoint now runs in lenient
    // mode so legacy data can still be edited without retyping someone else's
    // contact info.
    const c = await fetchJson('POST', '/api/submissions', validBody());
    const id = c.json.id;
    // Strip the contact fields from the payload to simulate a legacy row,
    // then drive the same merge the admin frontend does on Save Edits.
    const list = await fetchJson('GET', '/api/admin/submissions', undefined,
      { Authorization: 'Bearer test-admin-token' });
    const orig = list.json.submissions.find(s => s.id === id);
    const legacyPayload = { ...orig.payload };
    delete legacyPayload.submitter_first_name;
    delete legacyPayload.submitter_last_name;
    delete legacyPayload.submitter_phone;
    // Admin tweaks the venue name only; contact fields stay blank because the
    // legacy row never had them.
    const merged = {
      ...legacyPayload,
      submitter_email: orig.submitter_email || '',
      submitter_name: orig.submitter_name || '',
      venue: 'Renamed Venue',
      submitter_first_name: '',
      submitter_last_name: '',
      submitter_phone: ''
    };
    const r = await fetchJson('POST', '/api/admin/submissions/' + id,
      { payload: merged }, { Authorization: 'Bearer test-admin-token' });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.submission.payload.venue).toBe('Renamed Venue');
    // Row-level submitter info is preserved (not wiped by the edit).
    expect(r.json.submission.submitter_email).toBe('jane@example.com');
    expect(r.json.submission.submitter_name).toBe('Jane Tester');
  });

  it('admin Save Edits still validates core event fields (name length etc.)', async () => {
    // The lenient mode only relaxes submitter contact requirements. Core
    // event-level validation must still fire so a save can't bypass name/date/
    // venue/address checks.
    const c = await fetchJson('POST', '/api/submissions', validBody());
    const r = await fetchJson('POST', '/api/admin/submissions/' + c.json.id,
      { payload: { name: 'X', date: '2026-05-12', time: '7:00 PM',
        venue: 'V', address: '123 Main' } },
      { Authorization: 'Bearer test-admin-token' });
    expect(r.status).toBe(400);
    expect(r.json.errors.name).toBeDefined();
  });

  it('admin Save Edits still rejects a malformed email when one is provided', async () => {
    // Lenient = optional, not unchecked. If the admin types an obviously bad
    // email, the format rule still fires.
    const c = await fetchJson('POST', '/api/submissions', validBody());
    const r = await fetchJson('POST', '/api/admin/submissions/' + c.json.id,
      { payload: { ...validBody(), submitter_email: 'not-an-email' } },
      { Authorization: 'Bearer test-admin-token' });
    expect(r.status).toBe(400);
    expect(r.json.errors.submitter_email).toBeDefined();
  });

  it('approved-events surfaces all event fields (incl. end_time + address) for the picker', async () => {
    // The picker lists upcoming approvals only (an uncapped read).
    const c = await fetchJson('POST', '/api/submissions', validBody({ date: '2099-05-12' }));
    await fetchJson('POST', '/api/admin/submissions/' + c.json.id,
      { status: 'approved' },
      { Authorization: 'Bearer test-admin-token' });
    const r = await fetchJson('GET', '/api/admin/approved-events', undefined,
      { Authorization: 'Bearer test-admin-token' });
    expect(r.status).toBe(200);
    const ev = r.json.events[0];
    expect(ev.end_time).toBe('10:00 PM');
    expect(ev.address).toBe('123 Main St');
    expect(ev.url).toBe('https://example.com/event');
    // Submitter contact rides on the approved candidate so the admin can
    // still see it during picker review; admin.js stripPrivateFields keeps
    // it out of the published events.json.
    // The submitter's contact stays in the review queue: these events get
    // published, so their name and phone must never ride along.
    expect(ev).not.toHaveProperty('submitter_first_name');
    expect(ev).not.toHaveProperty('submitter_phone');
  });

  it('approved-events endpoint returns candidate-shaped events with source metadata', async () => {
    // The picker lists upcoming approvals only (an uncapped read).
    const c = await fetchJson('POST', '/api/submissions', validBody({ date: '2099-05-12' }));
    await fetchJson('POST', '/api/admin/submissions/' + c.json.id,
      { status: 'approved' },
      { Authorization: 'Bearer test-admin-token' });
    const r = await fetchJson('GET', '/api/admin/approved-events', undefined,
      { Authorization: 'Bearer test-admin-token' });
    expect(r.status).toBe(200);
    expect(r.json.events.length).toBe(1);
    const ev = r.json.events[0];
    expect(ev.name).toBe('Live Music at the Dive');
    expect(ev._source).toBe('submission');
    expect(ev._source_id).toBe(c.json.id);
    expect(ev._submitter_kind).toBe('organizer');
  });

  it('approved-events leaves out approvals whose date has passed', async () => {
    const c = await fetchJson('POST', '/api/submissions', validBody({ date: '2020-05-12' }));
    await fetchJson('POST', '/api/admin/submissions/' + c.json.id, { status: 'approved' },
      { Authorization: 'Bearer test-admin-token' });
    const r = await fetchJson('GET', '/api/admin/approved-events', undefined, { Authorization: 'Bearer test-admin-token' });
    expect(r.json.events).toEqual([]);
  });
});

describe('GET /api/config', () => {
  beforeEach(async () => { await startApp({ turnstileSiteKey: 'test-site-key' }); });
  afterEach(async () => { await stopApp(); });

  it('exposes the site key but never the secret', async () => {
    const r = await fetchJson('GET', '/api/config');
    expect(r.status).toBe(200);
    expect(r.json.turnstile_site_key).toBe('test-site-key');
    expect(r.json.turnstile_required).toBe(false);
    expect(JSON.stringify(r.json)).not.toContain('secret');
  });
});
