// @vitest-environment node
//
// What each newsletter signup came to (server/newsletter.js signupOutcome,
// counted in /api/admin/activity and the HQ summary), the address checks
// at the form (RFC atext before the @, at most 64 characters, a domain
// that takes mail: server/mailDomain.js), and the admin Import's checks.

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { normalizeEmail } from '../server/newsletter.js';
import { createMailDomainCheck } from '../server/mailDomain.js';

const NOW = new Date('2026-10-05T13:00:00Z');
const PASS = async () => ({ ok: true, json: async () => ({ success: true }) });
let tmpDir, server, base, store;

afterEach(async () => {
  if (server) await new Promise(r => server.close(r));
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  server = null; tmpDir = null;
});

async function start(extra = {}) {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-signups-'));
  const eventsFile = path.join(tmpDir, 'events.json');
  await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
  store = new FileStore(path.join(tmpDir, 's.json'));
  const { app } = await createApp({
    turnstileSecret: 'fake-secret', fetch: PASS, storeBundle: { kind: 'file', store }, eventsFile, trustProxy: false, now: () => NOW,
    siteUrl: 'https://www.thevic361.com', adminUsername: 'a', adminPassword: 'b', adminSessionSecret: 'c',
    resendApiKey: 're_test', newsletterAddress: '123 Main St, Victoria, TX 77901',
    resend: { send: async () => ({ id: 'e1' }), batch: async msgs => ({ data: msgs.map((_, i) => ({ id: `b${i}` })) }) }, ...extra
  });
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
}
const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const signup = (email, extra = {}) => post('/api/subscribe', { email, turnstile_token: 'ok', source: 'footer', ...extra });
const outcomes = async () => {
  // recordTraffic isn't awaited by the route: give it a moment.
  await new Promise(r => setTimeout(r, 50));
  return (await store.listTraffic('2026-01-01')).filter(r => r.kind === 'signup').map(r => r.click_type);
};
async function admin() {
  const r = await (await post('/api/admin/login', { username: 'a', password: 'b' })).json();
  return { Authorization: `Bearer ${r.token}`, Origin: base };
}

describe('the form address check', () => {
  it("takes an apostrophe, refuses what an address can't carry unquoted, and holds the name to 64", () => {
    expect(normalizeEmail("O'Brien@Example.com")).toBe("o'brien@example.com");
    for (const bad of ['a(b)@x.com', 'a[b]@x.com', 'a\\b@x.com', 'a:b@x.com', 'a"b@x.com', 'a,b@x.com', `${'x'.repeat(65)}@x.com`, 'josé@x.com', '.a@x.com', 'a..b@x.com']) {
      expect(normalizeEmail(bad)).toBeNull();
    }
    expect(normalizeEmail(`${'x'.repeat(64)}@x.com`)).toBe(`${'x'.repeat(64)}@x.com`);
  });
});

describe('createMailDomainCheck', () => {
  const err = code => Object.assign(new Error(code), { code });
  const resolver = (mx, a = err('ENODATA'), aaaa = err('ENODATA')) => ({
    resolveMx: async () => { if (mx instanceof Error) throw mx; return mx; },
    resolve4: async () => { if (a instanceof Error) throw a; return a; },
    resolve6: async () => { if (aaaa instanceof Error) throw aaaa; return aaaa; }
  });

  it('says yes for an MX, or an A record to fall back to', async () => {
    expect(await createMailDomainCheck({ resolver: resolver([{ exchange: 'mx.example.com', priority: 10 }]) })('example.com')).toBe(true);
    expect(await createMailDomainCheck({ resolver: resolver(err('ENODATA'), ['1.2.3.4']) })('example.com')).toBe(true);
  });

  it('says no only for no such domain, no records, or a null MX', async () => {
    expect(await createMailDomainCheck({ resolver: resolver(err('ENOTFOUND'), err('ENOTFOUND'), err('ENOTFOUND')) })('nope.example')).toBe(false);
    expect(await createMailDomainCheck({ resolver: resolver(err('ENODATA')) })('nope.example')).toBe(false);
    expect(await createMailDomainCheck({ resolver: resolver([{ exchange: '', priority: 0 }]) })('nomail.example')).toBe(false);
  });

  it("doesn't know on a server failure or a timeout, and doesn't keep that answer", async () => {
    expect(await createMailDomainCheck({ resolver: resolver(err('ESERVFAIL')) })('x.example')).toBeNull();
    let asked = 0;
    const slow = { resolveMx: () => { asked++; return new Promise(() => {}); }, resolve4: async () => [], resolve6: async () => [] };
    const check = createMailDomainCheck({ resolver: slow, timeoutMs: 20 });
    expect(await check('slow.example')).toBeNull();
    expect(await check('slow.example')).toBeNull();
    expect(asked).toBe(2);
  });
});

describe('/api/subscribe outcomes', () => {
  it('records what each signup came to, without the address', async () => {
    await start();
    expect((await signup('new@example.com')).status).toBe(200);
    expect((await signup('new@example.com')).status).toBe(200);
    expect((await signup('not an email')).status).toBe(400);
    expect((await signup('josé@example.com')).status).toBe(400);
    expect((await signup('typo@gmail.comm')).status).toBe(400);
    expect((await post('/api/subscribe', { email: 'bot@example.com', hp_field: 'http://spam.example', turnstile_token: 'ok' })).status).toBe(200);
    expect((await signup('nobot@example.com', { turnstile_token: '' })).status).toBe(200);
    expect(await outcomes()).toEqual(['joined', 'already_subscribed', 'invalid', 'invalid_non_ascii', 'typo', 'honeypot', 'pending_bot_check']);
    const rows = (await store.listTraffic('2026-01-01')).filter(r => r.kind === 'signup');
    expect(rows.every(r => r.path === 'footer' || r.path === 'site')).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/example\.com/);
  });

  it('counts a confirmation, and shows the outcomes in the activity report', async () => {
    await start();
    await signup('later@example.com', { turnstile_token: '' });
    const sub = (await store.listSubscribers()).find(x => x.email === 'later@example.com');
    expect((await fetch(`${base}/subscribe/confirm?token=${sub.token}`, { method: 'POST' })).status).toBe(200);
    expect(await outcomes()).toEqual(['pending_bot_check', 'confirmed']);
    const a = await (await fetch(`${base}/api/admin/activity?days=7`, { headers: await admin() })).json();
    expect(a.signups.outcomes).toEqual({ pending_bot_check: 1, confirmed: 1 });
    expect(a.totals).toMatchObject({ signup_attempts: 1, signups_confirmed: 1, views: 0 });
  });

  it('refuses a domain DNS says takes no mail, and lets one through it can\'t tell about', async () => {
    const answers = { 'gone.example': false, 'slow.example': null };
    await start({ mailDomainOk: async d => (d in answers ? answers[d] : true) });
    const r = await signup('a@gone.example');
    expect(r.status).toBe(400);
    expect((await r.json()).message).toMatch(/gone\.example can't receive email/);
    expect((await signup('b@slow.example')).status).toBe(200);
    expect(await outcomes()).toEqual(['no_mail_domain', 'joined']);
  });
});

describe('admin Import', () => {
  it('refuses an ending no mail can reach and counts the lines it left out', async () => {
    await start();
    const h = await admin();
    const bad = await (await post('/api/admin/newsletter/import', { emails: 'ok@example.com, x@gmail.comm' }, h)).json();
    expect(bad).toMatchObject({ ok: false, error: 'bad-email' });
    expect(bad.message).toMatch(/x@gmail\.comm/);
    const r = await (await post('/api/admin/newsletter/import', { emails: 'ok@example.com, not-an-address a(b)@example.com' }, h)).json();
    expect(r).toMatchObject({ ok: true, added: 1, invalid: 2, invalid_examples: ['not-an-address', 'a(b)@example.com'] });
  });
});
