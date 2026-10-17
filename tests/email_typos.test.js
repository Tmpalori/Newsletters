// @vitest-environment node
//
// Mistyped emails (server/emailTypos.js). Oct 2026: a Star 402 organizer
// typed "...@gmail.comm"; it passed the format check, every email to it
// bounced, and nobody knew. Pinned here: an impossible ending is refused on
// every form with the fix in the message, a likely slip gets a "Did you
// mean" note in the browser that never blocks twice, and a bounce on an
// event or order reaches the owner.

import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { JSDOM } from 'jsdom';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { suggestEmail, impossibleEmailError, EMAIL_CHECK_JS } from '../server/emailTypos.js';
import { validateSubmission } from '../server/validate.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const SECRET = 'whsec_' + Buffer.from('test-signing-key-0123456789').toString('base64');
const NOW = new Date('2026-10-17T17:00:00Z');
const nowS = Math.floor(NOW.getTime() / 1000);
let tmpDir, server, baseUrl, store, alerts;

async function startApp(extra = {}) {
  alerts = [];
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-typo-'));
  store = new FileStore(path.join(tmpDir, 's.json'));
  const eventsFile = path.join(tmpDir, 'events.json');
  await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
  const { app } = await createApp({
    storeBundle: { kind: 'file', store }, eventsFile, trustProxy: false, now: () => NOW,
    siteUrl: 'https://www.thevic361.com', turnstileSecret: null, resendWebhookSecret: SECRET,
    slack: { enabled: true, notify: async () => true, alert: async (key, title, detail) => { alerts.push({ key, title, detail }); return true; } },
    stripeSecretKey: 'sk_test', stripeWebhookSecret: 'whsec', resendApiKey: '',
    stripe: { createCheckoutSession: async () => ({ id: 'cs_1', url: 'https://checkout.stripe.com/x' }) },
    ...extra
  });
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

afterEach(async () => {
  if (server) await new Promise(r => server.close(r));
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  server = null; tmpDir = null;
});

const postJson = (p, body) => fetch(baseUrl + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const postForm = (p, fields) => fetch(baseUrl + p, { method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });

const EVENT = {
  name: 'Fall Fest', date: '2026-10-24', time: '7:00 PM', venue: 'Main Plaza', address: '101 Main St',
  description: 'Music and food.', icons: ['music'], free: true, submitter_kind: 'organizer',
  submitter_first_name: 'Pat', submitter_last_name: 'Doe', submitter_name: 'Pat Doe',
  submitter_email: 'pat@gmail.com', submitter_phone: '(402) 555-0100', elapsed_ms: 5000
};

describe('suggestEmail', () => {
  it('fixes endings no address can have, and says they are impossible', () => {
    expect(suggestEmail('pat@gmail.comm')).toEqual({ email: 'pat@gmail.com', impossible: true });
    expect(suggestEmail(' Pat@Gmail.COMM ')).toEqual({ email: 'pat@gmail.com', impossible: true });
    for (const end of ['con', 'cmo', 'ocm', 'vom', 'xom', 'cpm', 'coom']) {
      expect(suggestEmail(`a@shop.${end}`), end).toEqual({ email: 'a@shop.com', impossible: true });
    }
    expect(suggestEmail('a@isp.nett')).toEqual({ email: 'a@isp.net', impossible: true });
    expect(suggestEmail('a@club.ogr')).toEqual({ email: 'a@club.org', impossible: true });
    expect(suggestEmail('a@gmial.comm')).toEqual({ email: 'a@gmail.com', impossible: true });
  });

  it('only suggests for a misspelled provider (it could be a real domain)', () => {
    expect(suggestEmail('a@gmial.com')).toEqual({ email: 'a@gmail.com', impossible: false });
    expect(suggestEmail('a@yahoo.co')).toEqual({ email: 'a@yahoo.com', impossible: false });
    expect(suggestEmail('a@hotmial.com')).toEqual({ email: 'a@hotmail.com', impossible: false });
  });

  it('leaves real addresses alone, including short real endings', () => {
    for (const e of ['a@gmail.com', 'a@company.co', 'a@shop.cm', 'a@x.om', 'a@school.edu', 'a@town.gov', 'a@me.io', 'a@biz.net', 'bad', '', null]) {
      expect(suggestEmail(e), String(e)).toBeNull();
      expect(impossibleEmailError(e), String(e)).toBe('');
    }
  });
});

describe('every form refuses an impossible ending, with the fix', () => {
  it('free event form', async () => {
    await startApp();
    const r = await postJson('/api/submissions', { ...EVENT, submitter_email: 'pat@gmail.comm' });
    expect(r.status).toBe(400);
    expect((await r.json()).errors.submitter_email).toBe("That email can't receive mail. Did you mean pat@gmail.com?");
    expect((await postJson('/api/submissions', EVENT)).status).toBe(201);
  });

  it('an admin edit of an old row is not blocked by it', () => {
    const v = validateSubmission({ ...EVENT, submitter_email: 'pat@gmail.comm' }, { adminEdit: true });
    expect(v.errors && v.errors.submitter_email).toBeFalsy();
  });

  it('contact form', async () => {
    await startApp();
    const html = await (await postForm('/contact', { topic: 'other', name: 'Ann', email: 'ann@yahoo.con', message: 'Hello there' })).text();
    expect(html).toContain('Did you mean ann@yahoo.com?');
    expect(html).not.toContain('Message sent');
  });

  it('paid checkout', async () => {
    await startApp();
    const r = await postForm('/advertise/checkout', { package: 'weekly', week: '2026-10-19', business: 'Acme', text: 'x', url: 'acme.example', email: 'a@acme.comm', agree: '1' });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain('Did you mean a@acme.com?');
  });

  it('newsletter signup', async () => {
    await startApp();
    const r = await postJson('/api/subscribe', { email: 'fan@gmail.comm' });
    expect(r.status).toBe(400);
    expect((await r.json()).message).toBe("That email can't receive mail. Did you mean fan@gmail.com?");
    expect((await store.countSubscribers()).active || 0).toBe(0);
  });
});

describe('the "Did you mean" note in the browser', () => {
  it('is served from the same function the server uses', async () => {
    await startApp();
    const r = await fetch(baseUrl + '/emailcheck.js');
    expect(r.headers.get('content-type')).toMatch(/javascript/);
    expect(await r.text()).toBe(EMAIL_CHECK_JS);
    expect(EMAIL_CHECK_JS).toContain(suggestEmail.toString());
  });

  it('every page with an email field loads it', async () => {
    await startApp();
    for (const p of ['/contact', '/subscribe', '/advertise/checkout?package=weekly']) {
      expect(await (await fetch(baseUrl + p)).text(), p).toContain('<script src="/emailcheck.js" defer></script>');
    }
    const docs = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'docs');
    for (const f of ['index.html', 'submit.html']) {
      expect(await fs.readFile(path.join(docs, f), 'utf8'), f).toContain('<script src="/emailcheck.js" defer></script>');
    }
  });

  function page() {
    const dom = new JSDOM(`<form id="f"><input id="e" type="email" name="email"><button>Go</button></form>`, { runScripts: 'outside-only' });
    dom.window.eval(EMAIL_CHECK_JS);
    const { document } = dom.window;
    const input = document.getElementById('e');
    const form = document.getElementById('f');
    let submits = 0;
    form.addEventListener('submit', (e) => { e.preventDefault(); submits++; });
    const submit = () => form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    const leave = () => input.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true }));
    return { dom, document, input, submit, leave, submits: () => submits };
  }

  it('shows the fix when they leave the field, and one tap applies it', () => {
    const p = page();
    p.input.value = 'pat@gmail.comm';
    p.leave();
    const hint = p.document.querySelector('.email-hint');
    expect(hint.textContent).toBe('Did you mean pat@gmail.com?');
    hint.querySelector('button').click();
    expect(p.input.value).toBe('pat@gmail.com');
    expect(p.document.querySelector('.email-hint')).toBeNull();
  });

  it('the fix button survives the field losing focus again (the tap itself does that)', () => {
    const p = page();
    p.input.value = 'pat@gmail.comm';
    p.leave();
    const button = p.document.querySelector('.email-hint__fix');
    p.leave();
    expect(p.document.querySelector('.email-hint__fix')).toBe(button);
    button.click();
    expect(p.input.value).toBe('pat@gmail.com');
  });

  it('holds the first submit with a suggestion showing, never the second', () => {
    const p = page();
    p.input.value = 'pat@gmial.com';
    p.submit();
    expect(p.submits()).toBe(0);
    expect(p.document.querySelector('.email-hint')).not.toBeNull();
    p.submit();
    expect(p.submits()).toBe(1);
  });

  it('never gets in the way of a normal address', () => {
    const p = page();
    p.input.value = 'pat@gmail.com';
    p.leave();
    p.submit();
    expect(p.document.querySelector('.email-hint')).toBeNull();
    expect(p.submits()).toBe(1);
  });

  it('the note goes away once they fix it by hand', () => {
    const p = page();
    p.input.value = 'pat@gmail.comm';
    p.leave();
    p.input.value = 'pat@gmail.com';
    p.input.dispatchEvent(new p.dom.window.Event('input', { bubbles: true }));
    expect(p.document.querySelector('.email-hint')).toBeNull();
  });
});

describe('a bounced email to an organizer or buyer reaches the owner', () => {
  function webhook(event, id = 'msg_' + crypto.randomUUID()) {
    const body = JSON.stringify(event);
    const key = Buffer.from(SECRET.slice(6), 'base64');
    const sig = crypto.createHmac('sha256', key).update(`${id}.${nowS}.${body}`).digest('base64');
    return fetch(baseUrl + '/api/email/inbound', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'svix-id': id, 'svix-timestamp': String(nowS), 'svix-signature': `v1,${sig}` }, body
    });
  }
  // Inbound needs email set up (it answers 503 otherwise).
  const withEmail = () => startApp({ resendApiKey: 're_test', newsletterAddress: '1 Main St, Victoria, TX 77901',
    resend: { send: async () => ({ id: 'x' }), batch: async () => ({ data: [] }) } });
  const bounce = to => ({ type: 'email.bounced', created_at: NOW.toISOString(),
    data: { email_id: 'e1', from: 'The Vic 361 <news@thevic361.com>', to: [to], subject: 'We got your event', bounce: { type: 'Permanent' } } });

  it('names the event, the sender and the likely fix', async () => {
    await withEmail();
    // Saved before this check existed: the admin path skips it.
    await store.insert({ id: 's1', created_at: NOW.toISOString(), updated_at: NOW.toISOString(), status: 'approved', source: 'submission',
      submitter_name: 'Pat Doe', submitter_email: 'pat@gmail.comm', payload: { name: 'Fall Fest', date: '2026-10-24', venue: 'Main Plaza', submitter_phone: '(402) 555-0100' },
      admin_notes: '', review_history: [] });
    expect((await webhook(bounce('pat@gmail.comm'))).status).toBe(200);
    const a = alerts.find(x => x.key === 'bounce:pat@gmail.comm');
    expect(a.title).toBe('Email to pat@gmail.comm bounced');
    expect(a.detail).toContain('Event “Fall Fest” (2026-10-24, Main Plaza), sent by Pat Doe, phone (402) 555-0100');
    expect(a.detail).toContain('Probably a typo for pat@gmail.com.');
    expect(a.detail).toContain('They didn\'t get “We got your event”.');
  });

  it('stays quiet for a newsletter-only address', async () => {
    await withEmail();
    await store.importSubscribers(['gone@example.com'], 'import');
    await webhook(bounce('gone@example.com'));
    expect(alerts.filter(a => a.key.startsWith('bounce:'))).toEqual([]);
  });
});
