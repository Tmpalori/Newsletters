// @vitest-environment node
//
// Sign-in from HQ (server/sso.js): HQ (tmpalori/tristen-hq) mints a one-time
// pass for one town and posts it from the browser; the town's POST
// /api/admin/sso checks it and hands back an ordinary admin session. A
// pass is for one town, lives a minute and works once; anything else is
// refused, and the feature is off unless both sides hold the secret.

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mintPass, verifyPass, TTL_S, SKEW_S } from '../server/sso.js';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';

const SECRET = 'sso-'.repeat(12);
const VIC = { slug: 'victoria', siteUrl: 'https://www.thevic361.com' };
const NOW = Date.UTC(2026, 9, 10, 18, 0, 0);

describe('passes', () => {
  const pass = (o = {}) => mintPass(SECRET, { ...VIC, sub: 'tristen', now: NOW, ...o });

  it('a fresh pass for this town checks out', () => {
    const v = verifyPass(SECRET, pass(), { ...VIC, now: NOW + 5000 });
    expect(v.ok).toBe(true);
    expect(v.payload).toMatchObject({ v: 1, aud: 'victoria@www.thevic361.com', sub: 'tristen' });
    expect(v.payload.exp - v.payload.iat).toBe(TTL_S);
  });

  it('every pass carries its own nonce', () => {
    const n = new Set(Array.from({ length: 20 }, () => verifyPass(SECRET, pass(), { ...VIC, now: NOW }).payload.n));
    expect(n.size).toBe(20);
  });

  it('refuses another town, another host, another secret, or a changed byte', () => {
    expect(verifyPass(SECRET, pass(), { slug: 'bay', siteUrl: VIC.siteUrl, now: NOW }).reason).toBe('wrong-town');
    expect(verifyPass(SECRET, pass(), { slug: 'victoria', siteUrl: 'https://evil.example', now: NOW }).reason).toBe('wrong-town');
    expect(verifyPass('x'.repeat(48), pass(), { ...VIC, now: NOW }).reason).toBe('bad-signature');
    const p = pass();
    const flipped = (p[3] === 'A' ? 'B' : 'A');
    expect(verifyPass(SECRET, p.slice(0, 3) + flipped + p.slice(4), { ...VIC, now: NOW }).ok).toBe(false);
    expect(verifyPass(SECRET, p + 'x', { ...VIC, now: NOW }).reason).toBe('bad-signature');
  });

  it('refuses a pass from another town relabelled for this one', () => {
    const bay = mintPass(SECRET, { slug: 'bay', siteUrl: 'https://www.thebay979.com', sub: 'tristen', now: NOW });
    const [body, mac] = bay.split('.');
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    const relabelled = Buffer.from(JSON.stringify({ ...p, aud: 'victoria@www.thevic361.com' })).toString('base64url');
    expect(verifyPass(SECRET, `${relabelled}.${mac}`, { ...VIC, now: NOW }).reason).toBe('bad-signature');
  });

  it('expires after its minute (plus a little clock difference), and never starts in the future', () => {
    expect(verifyPass(SECRET, pass(), { ...VIC, now: NOW + (TTL_S + SKEW_S) * 1000 }).ok).toBe(true);
    expect(verifyPass(SECRET, pass(), { ...VIC, now: NOW + (TTL_S + SKEW_S + 2) * 1000 }).reason).toBe('expired');
    expect(verifyPass(SECRET, pass({ now: NOW + (SKEW_S + 5) * 1000 }), { ...VIC, now: NOW }).reason).toBe('not-yet-valid');
  });

  it('holds the exact clock edges', () => {
    expect(verifyPass(SECRET, pass({ now: NOW + SKEW_S * 1000 }), { ...VIC, now: NOW }).ok).toBe(true);
    expect(verifyPass(SECRET, pass({ now: NOW + (SKEW_S + 1) * 1000 }), { ...VIC, now: NOW }).reason).toBe('not-yet-valid');
  });

  it('refuses a pass that claims a long life, even one signed with the right secret', () => {
    const key = crypto.createHmac('sha256', SECRET).update('hq-sso-v1\0key').digest();
    const body = Buffer.from(JSON.stringify({ v: 1, aud: 'victoria@www.thevic361.com', sub: 'x', iat: NOW / 1000, exp: NOW / 1000 + 86400,
      n: 'n'.repeat(24) })).toString('base64url');
    const mac = crypto.createHmac('sha256', key).update(`hq-sso-v1\0${body}`).digest('base64url');
    expect(verifyPass(SECRET, `${body}.${mac}`, { ...VIC, now: NOW }).reason).toBe('malformed');
  });

  it('is off without a long enough secret, and refuses junk', () => {
    expect(() => mintPass('short', { ...VIC, sub: 'x' })).toThrow();
    expect(verifyPass('short', pass(), { ...VIC, now: NOW }).reason).toBe('off');
    for (const junk of [undefined, '', 'a', 'a.b.c', 'x'.repeat(5000), '.abc']) {
      expect(verifyPass(SECRET, junk, { ...VIC, now: NOW }).ok).toBe(false);
    }
  });
});

describe('the town signs in with a pass', () => {
  let tmpDir, server, base;
  afterEach(async () => {
    if (server) await new Promise(r => server.close(r));
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    server = null; tmpDir = null;
  });
  async function start(opts = {}) {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-sso-'));
    const file = path.join(tmpDir, 's.json');
    const { app } = await createApp({ storeBundle: { kind: 'file', store: new FileStore(file), file }, trustProxy: false,
      adminUsername: 'tristen', adminPassword: 'correct horse battery staple', adminSessionSecret: 'a'.repeat(40),
      ssoSecret: SECRET, siteUrl: VIC.siteUrl, slack: { enabled: false, notify: async () => false, alert: async () => false }, ...opts });
    server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  const post = pass => fetch(base + '/api/admin/sso', { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(pass === undefined ? {} : { pass }).toString() });
  const fresh = () => mintPass(SECRET, { ...VIC, sub: 'tristen' });

  it('a good pass gives a working admin session, once', async () => {
    await start();
    const pass = fresh();
    const r = await post(pass);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toMatch(/no-store/);
    expect(r.headers.get('content-security-policy')).toMatch(/script-src 'nonce-[^']+'/);
    expect(r.headers.get('content-security-policy')).not.toMatch(/unsafe-inline/);
    const html = await r.text();
    const token = /setItem\('vic361_admin_session',"([^"]+)"\)/.exec(html)[1];
    expect(html).toContain("location.replace('/admin.html')");
    const me = await fetch(base + '/api/admin/me', { headers: { Authorization: `Bearer ${token}` } });
    expect(me.status).toBe(200);
    // The same pass again (copied, or replayed): refused.
    expect((await post(pass)).status).toBe(401);
  });

  it('lands on the admin page HQ asked for, and only on one of the admin\'s own', async () => {
    await start();
    const go = async tab => (await (await fetch(base + '/api/admin/sso', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ pass: fresh(), ...(tab === undefined ? {} : { tab }) }).toString() })).text());
    expect(await go('sponsors')).toContain("location.replace('/admin.html#tab=sponsors')");
    expect(await go('submissions')).toContain("location.replace('/admin.html#tab=submissions')");
    for (const bad of ['', 'nope', "home');alert(1)//", 'SPONSORS', '../x']) {
      expect(await go(bad), bad).toContain("location.replace('/admin.html')");
    }
  });

  it('refuses a missing, wrong-town or forged pass', async () => {
    await start();
    expect((await post(undefined)).status).toBe(401);
    expect((await post(mintPass(SECRET, { slug: 'bay', siteUrl: 'https://www.thebay979.com', sub: 'x' }))).status).toBe(401);
    expect((await post(mintPass('z'.repeat(48), { ...VIC, sub: 'x' }))).status).toBe(401);
  });

  it('one pass, many tabs at once: exactly one session', async () => {
    await start();
    const pass = fresh();
    const codes = await Promise.all(Array.from({ length: 12 }, () => post(pass).then(r => r.status)));
    expect(codes.filter(c => c === 200)).toHaveLength(1);
    expect(codes.filter(c => c === 401)).toHaveLength(11);
  });

  it('fails closed when the nonce can\'t be recorded', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-sso-'));
    const store = new FileStore(path.join(tmpDir, 's.json'));
    for (const broken of [async () => { throw new Error('db down'); }, async () => undefined]) {
      store.claimJobRun = broken;
      const { app } = await createApp({ storeBundle: { kind: 'file', store, file: path.join(tmpDir, 's.json') }, trustProxy: false,
        adminUsername: 'tristen', adminPassword: 'correct horse battery staple', adminSessionSecret: 'a'.repeat(40),
        ssoSecret: SECRET, siteUrl: VIC.siteUrl, slack: { enabled: false, notify: async () => false, alert: async () => false } });
      server = http.createServer(app);
      await new Promise(r => server.listen(0, r));
      base = `http://127.0.0.1:${server.address().port}`;
      const r = await post(fresh());
      expect(r.status).toBe(401);
      expect(await r.text()).not.toContain('vic361_admin_session');
      await new Promise(r2 => server.close(r2)); server = null;
    }
  });

  it('opening the admin many times never locks the owner out; ten bad passes do', async () => {
    await start();
    for (let i = 0; i < 12; i++) expect((await post(fresh())).status).toBe(200);
    for (let i = 0; i < 10; i++) expect((await post('junk.pass')).status).toBe(401);
    expect((await post(fresh())).status).toBe(429);
  });

  it('the page that stores the session is locked down', async () => {
    await start();
    const r = await post(fresh());
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.headers.get('content-security-policy')).toContain("form-action 'none'");
  });

  it('a secret with stray whitespace still works; one shared with another secret turns it off', async () => {
    await start({ ssoSecret: `  ${SECRET}\n` });
    expect((await post(fresh())).status).toBe(200);
    for (const clash of [{ hqApiKey: SECRET }, { adminSessionSecret: SECRET }]) {
      await new Promise(r => server.close(r)); server = null;
      await fs.rm(tmpDir, { recursive: true, force: true }); tmpDir = null;
      await start(clash);
      expect((await post(fresh())).status).toBe(404);
    }
  });

  it('is off (404) without HQ_SSO_SECRET, and needs the admin login set up', async () => {
    await start({ ssoSecret: '' });
    expect((await post(fresh())).status).toBe(404);
    await new Promise(r => server.close(r)); server = null;
    await fs.rm(tmpDir, { recursive: true, force: true }); tmpDir = null;
    await start({ adminPassword: '', adminUsername: '' });
    expect((await post(fresh())).status).toBe(503);
  });
});
