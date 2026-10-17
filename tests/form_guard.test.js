// @vitest-environment node
//
// No visitor stuck on a public form, and the owner hears when one is
// (server/formGuard.js). Oct 12: someone tried to submit a free event three
// times, was turned away each time, gave up and emailed instead; nothing
// told the owner. These pin both halves: the forms let people through, and
// every way of getting stuck reaches Slack.

import { describe, it, expect, afterEach } from 'vitest';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { browserLabel, createFormGuard, FORMS } from '../server/formGuard.js';
import { promises as fs, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = new Date('2026-10-17T17:00:00Z');
let tmpDir, server, baseUrl, alerts, notes;

async function startApp(extra = {}) {
  alerts = [];
  notes = [];
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-guard-'));
  const store = new FileStore(path.join(tmpDir, 's.json'));
  const eventsFile = path.join(tmpDir, 'events.json');
  await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
  const { app } = await createApp({
    storeBundle: { kind: 'file', store }, eventsFile, trustProxy: false, now: () => NOW,
    siteUrl: 'https://www.thevic361.com', turnstileSecret: 'ts-secret', turnstileSiteKey: 'ts-site',
    fetch: async (url, init) => ({ json: async () => ({ success: String(init.body).includes('response=good') }) }),
    slack: {
      enabled: true,
      notify: async (m) => { notes.push(m); return true; },
      alert: async (key, title, detail) => { alerts.push({ key, title, detail }); return true; }
    },
    stripeSecretKey: 'sk_test', stripeWebhookSecret: 'whsec', resendApiKey: '',
    stripe: { createCheckoutSession: async () => ({ id: 'cs_1', url: 'https://checkout.stripe.com/x' }) },
    ...extra
  });
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return store;
}

afterEach(async () => {
  if (server) await new Promise(r => server.close(r));
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  server = null; tmpDir = null;
});

const EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';
const postJson = (p, body, headers = {}) => fetch(baseUrl + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': EDGE, ...headers }, body: JSON.stringify(body)
});
const postForm = (p, fields) => fetch(baseUrl + p, {
  method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': EDGE },
  body: new URLSearchParams(fields).toString()
});

const EVENT = {
  name: 'Live Music at the Dive', date: '2026-10-24', time: '7:00 PM', end_time: '10:00 PM',
  venue: 'The Dive Bar', address: '123 Main St', url: 'https://example.com/event',
  description: 'A test event description.', icons: ['music'], free: true, submitter_kind: 'organizer',
  submitter_first_name: 'Jane', submitter_last_name: 'Tester', submitter_name: 'Jane Tester',
  submitter_email: 'jane@example.com', submitter_phone: '(361) 555-0123', elapsed_ms: 5000
};

describe('someone stuck on a form is alerted', () => {
  it('free event form: the third turn-away in a row alerts, with what the form said', async () => {
    await startApp();
    for (let i = 0; i < 2; i++) expect((await postJson('/api/submissions', { ...EVENT, url: 'not a link' })).status).toBe(400);
    expect(alerts.filter(a => a.key === 'form-stuck:submit')).toEqual([]);
    expect((await postJson('/api/submissions', { ...EVENT, url: 'not a link' })).status).toBe(400);
    const a = alerts.find(x => x.key === 'form-stuck:submit');
    expect(a.title).toBe('Someone is stuck on the free event form (/submit)');
    expect(a.detail).toContain('3 tries');
    expect(a.detail).toContain('Edge on Windows');
    expect(a.detail).toContain('Link must be a valid website');
  });

  it('getting through ends the streak', async () => {
    await startApp();
    await postJson('/api/submissions', { ...EVENT, url: 'not a link' });
    await postJson('/api/submissions', { ...EVENT, url: 'not a link' });
    expect((await postJson('/api/submissions', EVENT)).status).toBe(201);
    await postJson('/api/submissions', { ...EVENT, name: 'Other Event', url: 'not a link' });
    expect(alerts.some(a => a.key === 'form-stuck:submit')).toBe(false);
  });

  it('paid checkout: three turn-aways alert too', async () => {
    await startApp();
    const order = { package: 'weekly', week: '2026-10-19', business: 'Acme', text: 'x', url: 'acme.example', email: 'a@acme.example', 'cf-turnstile-response': 'good' };
    for (let i = 0; i < 3; i++) expect((await postForm('/advertise/checkout', order)).status).toBe(400); // terms not agreed
    expect(alerts.find(a => a.key === 'form-stuck:checkout').title).toBe('Someone is stuck on the paid checkout (/advertise/checkout)');
    // ...and with the box ticked it goes to Stripe, missing token and all.
    const ok = await postForm('/advertise/checkout', { ...order, 'cf-turnstile-response': '', agree: '1' });
    expect(ok.status).toBe(303);
  });

  it('contact form: three turn-aways alert', async () => {
    await startApp();
    for (let i = 0; i < 3; i++) await postForm('/contact', { topic: 'other', name: 'Ann', email: 'nope', message: 'Hi there' });
    expect(alerts.find(a => a.key === 'form-stuck:contact').detail).toContain('valid email');
  });

  it('a visitor whose tries are over 30 minutes apart is not "stuck"', () => {
    let t = 0;
    const slack = { alert: (key) => { alerts.push({ key }); } };
    alerts = [];
    const g = createFormGuard({ slack, verifyTurnstile: async () => ({ ok: true }), nowFn: () => t });
    const req = { ip: '1.2.3.4', get: () => EDGE };
    g.rejected('submit', req, ['x']); t += 31 * 60 * 1000;
    g.rejected('submit', req, ['x']); t += 31 * 60 * 1000;
    g.rejected('submit', req, ['x']);
    expect(alerts).toEqual([]);
  });
});

describe('the browser reports what the server cannot see', () => {
  it('POST /api/form-problem alerts with the browser and detail', async () => {
    await startApp();
    const r = await postJson('/api/form-problem', { form: 'submit', stage: 'network', detail: 'Failed to fetch' });
    expect(r.status).toBe(204);
    const a = alerts.find(x => x.key === 'form-client:submit:network');
    expect(a.title).toBe("A visitor's free event form (/submit) couldn't reach the server");
    expect(a.detail).toBe('Edge on Windows: Failed to fetch. The page offered them the contact form so they aren\'t stuck.');
  });

  it('refuses unknown forms or stages and is rate limited', async () => {
    await startApp();
    expect((await postJson('/api/form-problem', { form: 'admin', stage: 'network' })).status).toBe(400);
    expect((await postJson('/api/form-problem', { form: 'submit', stage: 'anything' })).status).toBe(400);
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await postJson('/api/form-problem', { form: 'contact', stage: 'server' })).status);
    expect(codes.slice(0, 10).every(c => c === 204)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
  });
});

describe('browser labels', () => {
  it('names the browser people actually use', () => {
    expect(browserLabel(EDGE)).toBe('Edge on Windows');
    expect(browserLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1')).toBe('Safari on iPhone/iPad');
    expect(browserLabel('Mozilla/5.0 (iPhone) [FBAN/FBIOS;FBAV/581.0]')).toBe('Facebook app');
    expect(browserLabel('Mozilla/5.0 (Linux; Android 14) Instagram 300.0')).toBe('Instagram app');
    expect(browserLabel('')).toBe('unknown browser');
  });
});

describe('no public form dead-ends on the bot check', () => {
  // The old message gave a person nothing to do but fail again. If it comes
  // back on any public form, this fails.
  it('the old "please try again" refusal is gone from every form handler', () => {
    const files = ['server/index.js', 'server/contact.js', 'server/sponsors.js', 'server/newsletter.js', 'docs/submit.js'];
    for (const f of files) {
      const src = readFileSync(path.join(ROOT, f), 'utf8');
      expect(src, f).not.toContain("We couldn't confirm you're not a bot. Please try again.");
      expect(src, f).not.toContain('Try the challenge again');
    }
  });

  it('every form the guard knows about is wired to it', () => {
    const src = ['server/index.js', 'server/contact.js', 'server/sponsors.js'].map(f => readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
    for (const form of ['submit', 'checkout', 'contact']) {
      expect(src, form).toContain(`formGuard.botCheck('${form}'`);
      expect(src, form).toContain(`formGuard.rejected('${form}'`);
      expect(src, form).toContain(`formGuard.ok('${form}'`);
    }
    expect(Object.keys(FORMS).sort()).toEqual(['checkout', 'contact', 'submit', 'subscribe']);
  });

  it('every public page form with the bot check is one the guard knows', () => {
    // A new form marked data-turnstile must be added to FORMS (and wired),
    // or it could refuse people with nobody told.
    const known = ['action="/contact"', 'action="/advertise/checkout"', 'action="/api/subscribe"', 'js-subscribe'];
    const sources = [...readdirSync(path.join(ROOT, 'server')).filter(f => f.endsWith('.js')).map(f => `server/${f}`),
      ...readdirSync(path.join(ROOT, 'docs')).filter(f => /\.(js|html)$/.test(f)).map(f => `docs/${f}`)];
    for (const f of sources) {
      const src = readFileSync(path.join(ROOT, f), 'utf8');
      for (const m of src.matchAll(/<form[^>]*data-turnstile[^>]*>/g)) {
        expect(known.some(k => m[0].includes(k)), `${f}: ${m[0]}`).toBe(true);
      }
    }
  });
});
