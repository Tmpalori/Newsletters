// @vitest-environment node
//
// Newsletter delivery safety (server/newsletter.js, server/inbound.js,
// server/db.js): no double sends on a retry, imports that can't revive an
// opt-out, bounces and spam complaints, the concurrent-request 409, signups
// while email or Turnstile is off. Resend is a fake that keeps idempotency
// keys the way Resend does; nothing is emailed.

import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { createApp } from '../server/index.js';
import { FileStore, importSkip, SOFT_BOUNCE } from '../server/db.js';
import { batchErrorOutcome, KEY_WINDOW_MS } from '../server/newsletter.js';
import { isHardBounce, recipientAddresses } from '../server/inbound.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const MON = new Date('2026-10-05T13:00:00Z'); // Monday Oct 5, 8 AM CDT
const WEEK = '2026-10-05';
const EVENTS = [
  { date: '2026-10-09', name: 'Friday Live Music', time: '8:00 PM', venue: 'Aero Crafters', icons: ['music'] },
  { date: '2026-10-10', name: 'Farmers Market', time: '8:00 AM', venue: 'Market Square', free: true }
];
const SECRET = 'whsec_' + Buffer.from('delivery-test-signing-key').toString('base64');
const PASS = async () => ({ ok: true, json: async () => ({ success: true }) });

function resendError(status, name) {
  const err = new Error(`Resend /emails/batch HTTP ${status}: ${JSON.stringify({ name })}`);
  err.status = status;
  err.code = name;
  return err;
}

// Resend's idempotency, as documented: a key it has seen within 24 hours
// with the same payload answers the first response again; with a different
// payload, 409 invalid_idempotent_request. `next` scripts the next calls:
// 'ok', 'late' (Resend sends it but our request times out), 'concurrent'
// (409 concurrent_idempotent_requests, nothing sent) or 500.
function idempotentResend() {
  const keys = new Map();
  const r = {
    calls: [], delivered: [], single: [], next: [],
    forget() { keys.clear(); }, // Resend's 24 hours are up
    send: async (msg) => { r.single.push(msg); return { id: 's1' }; },
    batch: async (msgs, key) => {
      const to = msgs.map(m => m.to[0]);
      r.calls.push({ key, to });
      const mode = r.next.shift() || 'ok';
      if (mode === 'concurrent') throw resendError(409, 'concurrent_idempotent_requests');
      if (mode === 500) throw resendError(500, 'internal_server_error');
      const body = JSON.stringify(to);
      if (keys.has(key)) {
        if (keys.get(key) === body) return { data: to.map((_, i) => ({ id: `b${i}` })) };
        throw resendError(409, 'invalid_idempotent_request');
      }
      keys.set(key, body);
      r.delivered.push(...to);
      if (mode === 'late') { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; }
      return { data: to.map((_, i) => ({ id: `b${i}` })) };
    }
  };
  return r;
}

let tmpDir, server, baseUrl, store, resend, nl, clock, alerts, pings;

async function startApp(extra = {}) {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-delivery-'));
  const eventsFile = path.join(tmpDir, 'events.json');
  await fs.writeFile(eventsFile, JSON.stringify({ events: EVENTS }));
  store = new FileStore(path.join(tmpDir, 's.json'));
  resend = idempotentResend();
  clock = MON;
  alerts = []; pings = [];
  const made = await createApp({
    storeBundle: { kind: 'file', store }, eventsFile, trustProxy: false, now: () => clock,
    siteUrl: 'https://www.thevic361.com', adminUsername: 'a', adminPassword: 'b', adminSessionSecret: 'c',
    resendApiKey: 're_test', newsletterAddress: '123 Main St, Victoria, TX 77901', resend,
    turnstileSecret: 'ts', fetch: PASS, resendWebhookSecret: SECRET,
    slack: { enabled: true, notify: async (m) => { pings.push(m); return true; }, alert: async (key, title) => { alerts.push({ key, title }); } },
    ...extra
  });
  nl = made.newsletter;
  server = http.createServer(made.app);
  await new Promise(r => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

afterEach(async () => {
  if (server) await new Promise(r => server.close(r));
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  server = null; tmpDir = null;
});

const post = (p, body, headers = {}) => fetch(baseUrl + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body || {})
});
async function auth() {
  const r = await post('/api/admin/login', { username: 'a', password: 'b' });
  return { Authorization: `Bearer ${(await r.json()).token}` };
}
const emails = n => Array.from({ length: n }, (_, i) => `reader${String(i).padStart(3, '0')}@example.com`);
async function tokenOf(email) {
  return (await store.listSubscribers()).find(s => s.email === email).token;
}
const statusOf = async email => ((await store.listSubscribers()).find(s => s.email === email) || {}).status;
const counts = list => list.reduce((m, e) => ({ ...m, [e]: (m[e] || 0) + 1 }), {});

describe('a retried send never mails a chunk twice', () => {
  it('first send: one key per chunk of 100, the same format as before, and the plan is saved', async () => {
    await startApp();
    await store.importSubscribers(emails(150), 'import');
    const out = await nl.sendWeekly();
    expect(out).toMatchObject({ ok: true, recipients: 150, failed: 0, unknown: 0 });
    expect(out.chunks).toBeUndefined(); // the plan (every address) stays in the store
    expect(resend.calls.map(c => c.to.length)).toEqual([100, 50]);
    for (const c of resend.calls) expect(c.key).toMatch(/^vic361-2026-10-05-[a-f0-9]{16}$/);
    const hash = crypto.createHash('sha256').update(emails(150).slice(0, 100).join(',')).digest('hex').slice(0, 16);
    expect(resend.calls[0].key).toBe(`vic361-2026-10-05-${hash}`);
    const rec = await store.getNewsletterSend(WEEK);
    expect(rec.chunks.map(c => [c.key, c.state, c.emails.length])).toEqual(resend.calls.map(c => [c.key, 'sent', c.to.length]));
    expect((await nl.sendWeekly()).error).toBe('already-sent');
  });

  it('Resend took the batch but answered late, then someone unsubscribed: the retry reuses the key and nobody gets two', async () => {
    await startApp();
    const list = emails(5);
    await store.importSubscribers(list, 'import');
    resend.next.push('late');
    const first = await nl.sendWeekly();
    expect(first).toMatchObject({ ok: false, recipients: 0, failed: 5 });
    expect((await store.getNewsletterSend(WEEK)).chunks[0]).toMatchObject({ state: 'unknown', emails: list, first_at: MON.toISOString() });
    // One of them reads it and unsubscribes before the 5-minute retry.
    expect(await store.unsubscribe(await tokenOf(list[2]))).toBe(true);
    clock = new Date(MON.getTime() + 5 * 60e3);
    const retry = await nl.sendWeekly();
    expect(retry).toMatchObject({ ok: true, failed: 0, recipients: 4 });
    // Same key as the first try, without the one who left: Resend says the
    // key was used with another payload (409), which counts as sent.
    expect(resend.calls).toHaveLength(2);
    expect(resend.calls[1].key).toBe(resend.calls[0].key);
    expect(resend.calls[1].to).toEqual(list.filter(e => e !== list[2]));
    expect(Object.values(counts(resend.delivered)).every(n => n === 1)).toBe(true);
    expect(resend.delivered).toHaveLength(5);
  });

  it('a chunk that may have gone out more than a day ago is not resent automatically, only on the admin\'s say-so', async () => {
    await startApp();
    const list = emails(4);
    await store.importSubscribers(list, 'import');
    resend.next.push('late');
    await nl.sendWeekly();
    // Tuesday afternoon: Resend has forgotten the key.
    clock = new Date(MON.getTime() + KEY_WINDOW_MS + 3600e3);
    resend.forget();
    const out = await nl.sendWeekly();
    expect(out).toMatchObject({ ok: true, failed: 0, unknown: 4 });
    expect(resend.calls).toHaveLength(1); // not sent again
    expect(alerts.map(a => a.key)).toContain('newsletter-unknown-2026-10-05');
    expect((await store.getNewsletterSend(WEEK)).chunks[0].state).toBe('sent-unknown');
    // The cron and a plain Send/Retry leave it alone.
    expect((await nl.sendWeekly()).error).toBe('already-sent');
    const h = await auth();
    const status = await (await fetch(baseUrl + '/api/admin/newsletter', { headers: h })).json();
    expect(status).toMatchObject({ this_week_sent: true, this_week_failed: 0, this_week_unknown: 4 });
    expect(status.sends[0].chunks).toBeUndefined();
    expect((await (await post('/api/admin/newsletter/send', {}, h)).json()).error).toBe('already-sent');
    // The admin's explicit resend (after the warning) goes out, on a new key.
    const forced = await (await post('/api/admin/newsletter/send', { resend_unknown: true }, h)).json();
    expect(forced).toMatchObject({ ok: true, unknown: 0, failed: 0 });
    expect(resend.calls).toHaveLength(2);
    expect(resend.calls[1].key).toMatch(new RegExp(`^${resend.calls[0].key}-u\\d+$`));
    expect(resend.calls[1].to).toEqual(list);
  });

  it('a definite error (HTTP 500) is still retried after a day, under the same key', async () => {
    await startApp();
    const list = emails(3);
    await store.importSubscribers(list, 'import');
    resend.next.push(500);
    expect(await nl.sendWeekly()).toMatchObject({ ok: false, failed: 3 });
    expect((await store.getNewsletterSend(WEEK)).chunks[0].state).toBe('failed');
    clock = new Date(MON.getTime() + 26 * 3600e3);
    resend.forget();
    expect(await nl.sendWeekly()).toMatchObject({ ok: true, failed: 0, recipients: 3, unknown: 0 });
    expect(resend.calls[1].key).toBe(resend.calls[0].key);
    expect(resend.delivered).toEqual(list);
  });

  it('a crash after a chunk was asked for leaves it pending, and the resume sends it under its first key', async () => {
    await startApp();
    const list = emails(120);
    await store.importSubscribers(list, 'import');
    const realBatch = resend.batch;
    // The process "dies" during the second chunk: the call never answers.
    let n = 0;
    resend.batch = async (msgs, key) => { if (++n === 2) { await realBatch(msgs, key); throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); } return realBatch(msgs, key); };
    await nl.sendWeekly();
    resend.batch = realBatch;
    const rec = await store.getNewsletterSend(WEEK);
    expect(rec.chunks.map(c => c.state)).toEqual(['sent', 'unknown']);
    expect(rec.failed_emails).toEqual(list.slice(100));
    expect((await nl.sendWeekly())).toMatchObject({ ok: true, recipients: 120, failed: 0 });
    expect(resend.calls[2].key).toBe(resend.calls[1].key);
    expect(resend.delivered).toHaveLength(120);
  });

  it('a record from before chunks were saved still resumes with just the people who missed it', async () => {
    await startApp();
    const list = emails(5);
    await store.importSubscribers(list, 'import');
    await store.recordNewsletterSend({ week_key: WEEK, subject: 'x', recipients: 3, failed: 2, failed_emails: [list[1], list[3]] });
    expect(await nl.sendWeekly()).toMatchObject({ ok: true, recipients: 5, failed: 0 });
    expect(resend.calls.map(c => c.to)).toEqual([[list[1], list[3]]]);
  });
});

describe('Resend 409 concurrent_idempotent_requests', () => {
  it('is "in progress, retry later", not delivered', async () => {
    await startApp();
    const list = emails(3);
    await store.importSubscribers(list, 'import');
    resend.next.push('concurrent');
    const out = await nl.sendWeekly();
    expect(out).toMatchObject({ ok: false, recipients: 0, failed: 3 });
    expect((await store.getNewsletterSend(WEEK)).chunks[0].state).toBe('unknown');
    const retry = await nl.sendWeekly();
    expect(retry).toMatchObject({ ok: true, recipients: 3, failed: 0 });
    expect(resend.calls[1].key).toBe(resend.calls[0].key);
    expect(resend.delivered).toEqual(list);
  });

  it('batchErrorOutcome sorts Resend errors', () => {
    expect(batchErrorOutcome(resendError(409, 'concurrent_idempotent_requests'))).toBe('unknown');
    expect(batchErrorOutcome({ status: 409, message: 'Resend HTTP 409: {"name":"concurrent_idempotent_requests"}' })).toBe('unknown');
    expect(batchErrorOutcome(resendError(409, 'invalid_idempotent_request'))).toBe('sent');
    expect(batchErrorOutcome(resendError(422, 'invalid_idempotent_request'))).toBe('sent');
    expect(batchErrorOutcome(resendError(500, 'internal_server_error'))).toBe('failed');
    expect(batchErrorOutcome(resendError(429, 'rate_limit_exceeded'))).toBe('failed');
    expect(batchErrorOutcome(new Error('The operation was aborted due to timeout'))).toBe('unknown');
  });
});

describe('import never revives an opt-out', () => {
  it('skips unsubscribed, complained, bounced and waiting comebacks, and says so', async () => {
    await startApp();
    await store.importSubscribers(['active@example.com', 'gone@example.com', 'back@example.com', 'dead@example.com', 'spam@example.com'], 'import');
    await store.unsubscribe(await tokenOf('gone@example.com'));
    await store.unsubscribe(await tokenOf('back@example.com'));
    await store.addSubscriber({ email: 'back@example.com', source: 'form' }); // someone typed it into the form
    await store.markSubscribersBounced(['dead@example.com']);
    await store.unsubscribeByEmail(['spam@example.com']);
    await store.addSubscriber({ email: 'waiting@example.com', source: 'form' }); // never confirmed, never left
    expect(await statusOf('back@example.com')).toBe('pending');
    const h = await auth();
    const r = await (await post('/api/admin/newsletter/import', {
      emails: 'active@example.com, gone@example.com back@example.com;dead@example.com spam@example.com waiting@example.com new@example.com'
    }, h)).json();
    expect(r).toEqual({ ok: true, added: 1, already: 2, skipped_unsubscribed: 3, skipped_bounced: 1 });
    expect(await statusOf('gone@example.com')).toBe('unsubscribed');
    expect(await statusOf('back@example.com')).toBe('pending');
    expect(await statusOf('dead@example.com')).toBe('bounced');
    expect(await statusOf('spam@example.com')).toBe('unsubscribed');
    expect(await statusOf('waiting@example.com')).toBe('active');
    expect(await statusOf('new@example.com')).toBe('active');
  });

  it('the form puts an unsubscribed address back only through its own confirm email', async () => {
    await startApp();
    await store.importSubscribers(['fan@example.com'], 'import');
    await store.unsubscribe(await tokenOf('fan@example.com'));
    const r = await (await post('/api/subscribe', { email: 'fan@example.com', turnstile_token: 'ok' })).json();
    expect(r.ok).toBe(true);
    expect(await statusOf('fan@example.com')).toBe('pending');
    expect(resend.single.map(m => m.to[0])).toEqual(['fan@example.com']);
    expect(resend.single[0].subject).toMatch(/confirm/i);
    // An import afterwards can't skip that step.
    await store.importSubscribers(['fan@example.com'], 'import');
    expect(await statusOf('fan@example.com')).toBe('pending');
  });

  it('importSkip', () => {
    expect(importSkip({ status: 'active', old_tokens: ['x'] })).toBe(null);
    expect(importSkip({ status: 'pending' })).toBe(null);
    expect(importSkip({ status: 'pending', old_tokens: ['x'] })).toBe('skipped_unsubscribed');
    expect(importSkip({ status: 'unsubscribed' })).toBe('skipped_unsubscribed');
    expect(importSkip({ status: 'bounced' })).toBe('skipped_bounced');
  });
});

describe('Resend bounce and complaint webhooks', () => {
  const nowS = Math.floor(MON.getTime() / 1000);
  function webhook(event, id = 'msg_' + crypto.randomUUID()) {
    const body = JSON.stringify(event);
    const key = Buffer.from(SECRET.slice(6), 'base64');
    const sig = crypto.createHmac('sha256', key).update(`${id}.${nowS}.${body}`).digest('base64');
    return fetch(baseUrl + '/api/email/inbound', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'svix-id': id, 'svix-timestamp': String(nowS), 'svix-signature': `v1,${sig}` }, body
    });
  }
  const event = (type, to, extra = {}) => ({ type, created_at: MON.toISOString(),
    data: { email_id: 'e1', from: 'The Vic 361 <news@thevic361.com>', to: [to], subject: 'This week in Victoria', ...extra } });

  it('a hard bounce marks the subscriber bounced; a soft one is left alone', async () => {
    await startApp();
    await store.importSubscribers(['dead@example.com', 'full@example.com'], 'import');
    expect(await (await webhook(event('email.bounced', 'Dead <Dead@Example.com>', { bounce: { type: 'Permanent', subType: 'General' } }))).json())
      .toEqual({ ok: true, result: 'bounced' });
    expect(await statusOf('dead@example.com')).toBe('bounced');
    expect(await (await webhook(event('email.bounced', 'full@example.com', { bounce: { type: 'Transient', subType: 'MailboxFull' } }))).json())
      .toEqual({ ok: true, result: 'soft-bounce' });
    expect(await statusOf('full@example.com')).toBe('active');
    // The next issue skips the dead address.
    await nl.sendWeekly();
    expect(resend.calls[0].to).toEqual(['full@example.com']);
  });

  it('a run of soft bounces over a week marks the address bounced; a delivery ends the run', async () => {
    await startApp();
    await store.importSubscribers(['full@example.com', 'busy@example.com'], 'import');
    const DAY = 24 * 3600 * 1000;
    // Signed at the app's clock, which moves between issues here.
    const at = (ms, ev) => {
      clock = new Date(MON.getTime() + ms);
      const body = JSON.stringify(ev), id = 'msg_' + crypto.randomUUID(), ts = Math.floor(clock.getTime() / 1000);
      const sig = crypto.createHmac('sha256', Buffer.from(SECRET.slice(6), 'base64')).update(`${id}.${ts}.${body}`).digest('base64');
      return fetch(baseUrl + '/api/email/inbound', { method: 'POST', body,
        headers: { 'Content-Type': 'application/json', 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}` } })
        .then(r => r.json()).then(j => j.result);
    };
    const soft = to => event('email.bounced', to, { bounce: { type: 'Transient', subType: 'MailboxFull' } });
    // Mon, Thu, Mon, Thu: the fourth is ten days after the first.
    const issues = [0, 3, 7, 10].map(d => d * DAY);
    for (const t of issues.slice(0, 3)) expect(await at(t, soft('full@example.com'))).toBe('soft-bounce');
    // Resend retrying the same email hours later counts once.
    expect(await at(7 * DAY + 3600 * 1000, soft('full@example.com'))).toBe('soft-bounce');
    expect(await statusOf('full@example.com')).toBe('active');
    expect(await at(issues[3], soft('full@example.com'))).toBe('bounced');
    expect(await statusOf('full@example.com')).toBe('bounced');

    // Same pattern, but Thursday's issue got through in between.
    for (const t of issues.slice(0, 2)) await at(t, soft('busy@example.com'));
    expect(await at(5 * DAY, event('email.delivered', 'busy@example.com'))).toBe('delivered');
    for (const t of issues.slice(2)) expect(await at(t, soft('busy@example.com'))).toBe('soft-bounce');
    expect(await statusOf('busy@example.com')).toBe('active');
  });

  it('recordSoftBounce: the run needs its span, and starts over after a quiet month', async () => {
    await startApp();
    await store.importSubscribers(['a@example.com', 'b@example.com', 'gone@example.com'], 'import');
    await store.unsubscribe(await tokenOf('gone@example.com'));
    const DAY = 24 * 3600 * 1000;
    const at = d => new Date(MON.getTime() + d * DAY);
    // Four soft bounces on four days in a row: too short a run to drop them.
    for (let d = 0; d < SOFT_BOUNCE.limit; d++) expect(await store.recordSoftBounce(['a@example.com'], at(d))).toEqual([]);
    expect(await statusOf('a@example.com')).toBe('active');
    // A week on from the first, the next one does.
    expect(await store.recordSoftBounce(['a@example.com'], at(7))).toEqual(['a@example.com']);
    // Three, then a month with none: the count starts again from one.
    for (const d of [0, 3, 7]) await store.recordSoftBounce(['b@example.com'], at(d));
    for (const d of [40, 43, 47]) expect(await store.recordSoftBounce(['b@example.com'], at(d))).toEqual([]);
    expect(await statusOf('b@example.com')).toBe('active');
    expect(await store.recordSoftBounce(['b@example.com'], at(50))).toEqual(['b@example.com']);
    // Only active subscribers count.
    for (const d of [0, 3, 7, 10]) expect(await store.recordSoftBounce(['gone@example.com'], at(d))).toEqual([]);
    expect(await statusOf('gone@example.com')).toBe('unsubscribed');
  });

  it('a spam complaint unsubscribes them, and they stop counting for their referrer', async () => {
    await startApp();
    await store.importSubscribers(['ref@example.com'], 'import');
    const referrer = (await store.listSubscribers()).find(s => s.email === 'ref@example.com');
    const code = (await store.ensureRefCodes([referrer.id]))[referrer.id];
    const friend = await store.addSubscriber({ email: 'friend@example.com', source: 'form', referredBy: code });
    await store.confirmSubscriber(friend.token);
    expect((await store.countReferrals([code], { counted: false }))[code]).toBe(1);
    expect(await (await webhook(event('email.complained', 'friend@example.com'))).json()).toEqual({ ok: true, result: 'complained' });
    expect(await statusOf('friend@example.com')).toBe('unsubscribed');
    expect((await store.countReferrals([code], { counted: false }))[code] || 0).toBe(0);
    expect(pings.some(p => /Spam complaint/.test(p.title))).toBe(true);
    // A sponsor's "copies sent" is the issue's recipients: they aren't in it.
    const out = await nl.sendWeekly();
    expect(out.recipients).toBe(1);
  });

  it('ignores another town\'s mail and refuses an unsigned event', async () => {
    await startApp({ inboundOtherDomains: ['thebay979.com'] });
    await store.importSubscribers(['x@example.com'], 'import');
    const bay = event('email.complained', 'x@example.com', { from: 'The Bay 979 <news@thebay979.com>' });
    expect(await (await webhook(bay)).json()).toEqual({ ok: true, result: 'other-town' });
    expect(await statusOf('x@example.com')).toBe('active');
    const r = await fetch(baseUrl + '/api/email/inbound', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event('email.complained', 'x@example.com')) });
    expect(r.status).toBe(400);
    expect(await statusOf('x@example.com')).toBe('active');
  });

  it('helpers', () => {
    expect(recipientAddresses(['A <A@B.com>', 'c@d.com', 'junk'])).toEqual(['a@b.com', 'c@d.com']);
    expect(recipientAddresses('e@f.com')).toEqual(['e@f.com']);
    expect(isHardBounce({})).toBe(true);
    expect(isHardBounce({ bounce: { type: 'Permanent' } })).toBe(true);
    expect(isHardBounce({ bounce: { type: 'Transient' } })).toBe(false);
    expect(isHardBounce({ bounce: { type: 'Undetermined' } })).toBe(false);
  });
});

describe('signups while email is off', () => {
  it('a comeback, a referred friend and an unchecked signup stay pending; a checked new one joins', async () => {
    await startApp({ resendApiKey: '' });
    await store.importSubscribers(['gone@example.com', 'ref@example.com'], 'import');
    await store.unsubscribe(await tokenOf('gone@example.com'));
    const referrer = (await store.listSubscribers()).find(s => s.email === 'ref@example.com');
    const code = (await store.ensureRefCodes([referrer.id]))[referrer.id];
    for (const body of [{ email: 'gone@example.com', turnstile_token: 'ok' }, { email: 'friend@example.com', ref: code, turnstile_token: 'ok' },
      { email: 'nocheck@example.com' }, { email: 'new@example.com', turnstile_token: 'ok' }]) {
      expect((await post('/api/subscribe', body)).status).toBe(200);
    }
    expect(await statusOf('gone@example.com')).toBe('pending');
    expect(await statusOf('friend@example.com')).toBe('pending');
    expect(await statusOf('nocheck@example.com')).toBe('pending');
    expect(await statusOf('new@example.com')).toBe('active');
    expect((await store.countReferrals([code], { counted: false }))[code] || 0).toBe(0);
    expect(resend.single).toEqual([]);
  });
});

describe('Turnstile not configured', () => {
  it('a signup is unverified: confirmation email, not straight onto the list', async () => {
    await startApp({ turnstileSecret: '' });
    const r = await (await post('/api/subscribe', { email: 'someone@example.com' })).json();
    expect(r.message).toMatch(/Almost there/);
    expect(await statusOf('someone@example.com')).toBe('pending');
    expect(resend.single.map(m => m.to[0])).toEqual(['someone@example.com']);
    // A form that sent a token anyway isn't refused (there's nothing to check it with).
    const t = await post('/api/subscribe', { email: 'other@example.com', turnstile_token: 'abc' });
    expect(t.status).toBe(200);
    expect(await statusOf('other@example.com')).toBe('pending');
  });

  it('Turnstile is a required setup item', async () => {
    await startApp({ turnstileSecret: '' });
    const setup = await (await fetch(baseUrl + '/api/admin/setup', { headers: await auth() })).json();
    expect(setup.checks.find(c => c.key === 'spam')).toMatchObject({ level: 'required', ok: false });
  });

  it('configured: a checked signup still joins at once with a welcome email', async () => {
    await startApp();
    const r = await (await post('/api/subscribe', { email: 'real@example.com', turnstile_token: 'ok' })).json();
    expect(r.message).toMatch(/on the list/);
    expect(await statusOf('real@example.com')).toBe('active');
  });
});
