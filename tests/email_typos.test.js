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

async function startApp({ before, ...extra } = {}) {
  alerts = [];
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-typo-'));
  store = new FileStore(path.join(tmpDir, 's.json'));
  if (before) await before(store);
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

describe('the owner can fix a submitter\'s email in the admin', () => {
  // Before this, the row-level address (where every email to them goes)
  // couldn't be changed at all, so a "...@gmail.comm" stayed broken.
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer admin-token-0123456789abcdef0123456789' };
  const save = (id, payload) => fetch(baseUrl + '/api/admin/submissions/' + id, { method: 'POST', headers: H, body: JSON.stringify({ payload }) });
  async function seed() {
    await startApp({ adminToken: 'admin-token-0123456789abcdef0123456789' });
    await store.insert({ id: 's1', created_at: NOW.toISOString(), updated_at: NOW.toISOString(), status: 'approved', source: 'submission',
      submitter_name: 'Pat Doe', submitter_email: 'pat@gmail.comm', payload: { ...EVENT }, admin_notes: '', review_history: [] });
  }
  const { submitter_email: _e, submitter_name: _n, ...PAYLOAD } = EVENT;

  it('a corrected address replaces the bad one, and the history says so', async () => {
    await seed();
    const r = await save('s1', { ...PAYLOAD, submitter_email: 'Pat@Gmail.com' });
    expect(r.status).toBe(200);
    const row = await store.get('s1');
    expect(row.submitter_email).toBe('pat@gmail.com');
    expect(row.review_history.at(-1)).toMatchObject({ action: 'edit', email_changed: true });
  });

  it('refuses another impossible ending, with the fix', async () => {
    await seed();
    const r = await save('s1', { ...PAYLOAD, submitter_email: 'pat@gmail.con' });
    expect(r.status).toBe(400);
    expect((await r.json()).errors.submitter_email).toBe("That email can't receive mail. Did you mean pat@gmail.com?");
    expect((await store.get('s1')).submitter_email).toBe('pat@gmail.comm');
  });

  it('an edit that leaves the address alone (or blank) keeps it, even an old bad one', async () => {
    await seed();
    expect((await save('s1', { ...PAYLOAD, name: 'Fall Fest 2026', submitter_email: 'pat@gmail.comm' })).status).toBe(200);
    expect((await save('s1', { ...PAYLOAD, name: 'Fall Fest 2026' })).status).toBe(200);
    const row = await store.get('s1');
    expect(row.submitter_email).toBe('pat@gmail.comm');
    expect(row.payload.name).toBe('Fall Fest 2026');
  });
});

describe('a subscriber typo can be fixed, by the owner or HQ (with his OK)', () => {
  // Oct 2026: "melaniereeves60@gmail.comm" signed up on The Star 402 and
  // every email to it bounced. Held to a typo so HQ's assistant can't use
  // it to add strangers to the list.
  const HQK = 'hq-reply-key-0123456789-0123456789-abc';
  const ADMIN = 'admin-token-0123456789abcdef0123456789';
  const fix = (body, { hq = true } = {}) => fetch(baseUrl + (hq ? '/api/hq/admin/newsletter/fix-subscriber' : '/api/admin/newsletter/fix-subscriber'), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hq ? HQK : ADMIN}` }, body: JSON.stringify(body) });
  const statusOf = async (email) => ((await store.listSubscribers()).find(s => s.email === email) || {}).status;
  async function seed() {
    await startApp({ hqReplyKey: HQK, adminToken: ADMIN });
    await store.importSubscribers(['melaniereeves60@gmail.comm'], 'import');
    await store.markSubscribersBounced(['melaniereeves60@gmail.comm']);
    await store.addSubscriber({ email: 'waiting@yahoo.con', source: 'footer' });   // never confirmed
    await store.importSubscribers(['happy@gmail.com'], 'import');
  }

  it('adds the corrected address as active, through HQ', async () => {
    await seed();
    const r = await fix({ from: 'melaniereeves60@gmail.comm', to: 'MelanieReeves60@Gmail.com' });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, from: 'melaniereeves60@gmail.comm', to: 'melaniereeves60@gmail.com', added: true });
    expect(await statusOf('melaniereeves60@gmail.com')).toBe('active');
    expect(await statusOf('melaniereeves60@gmail.comm')).toBe('bounced');
  });

  it('fixes an impossible address that still reads active (no bounce ever came back)', async () => {
    await seed();
    await store.importSubscribers(['melanie@gmail.comm'], 'import');
    expect(await statusOf('melanie@gmail.comm')).toBe('active');
    expect((await fix({ from: 'melanie@gmail.comm', to: 'melanie@gmail.com' })).status).toBe(200);
    expect(await statusOf('melanie@gmail.com')).toBe('active');
    expect(await statusOf('melanie@gmail.comm')).toBe('bounced');
  });

  it('takes an unconfirmed typo off the list so it is never mailed again', async () => {
    await seed();
    expect((await fix({ from: 'waiting@yahoo.con', to: 'waiting@yahoo.com' }, { hq: false })).status).toBe(200);
    expect(await statusOf('waiting@yahoo.com')).toBe('active');
    expect(await statusOf('waiting@yahoo.con')).toBe('unsubscribed');
  });

  it('refuses anything that is not a typo after the @', async () => {
    await seed();
    // A different person.
    expect((await (await fix({ from: 'melaniereeves60@gmail.comm', to: 'someone.else@gmail.com' })).json()).error).toBe('not-a-typo');
    // An address that is fine and active.
    expect((await fix({ from: 'happy@gmail.com', to: 'happy@yahoo.com' })).status).toBe(404);
    // Not on the list at all.
    expect((await fix({ from: 'nobody@gmail.comm', to: 'nobody@gmail.com' })).status).toBe(404);
    // A "fix" to another impossible ending.
    expect((await (await fix({ from: 'melaniereeves60@gmail.comm', to: 'melaniereeves60@gmail.con' })).json()).error).toBe('bad-to');
    expect(await statusOf('someone.else@gmail.com')).toBeUndefined();
    expect(await statusOf('happy@yahoo.com')).toBeUndefined();
  });

  it('fixes a stray character before the @ (a fancy dash Resend refuses), active or not', async () => {
    // Oct 2026: "alma\u2011mctygue@hotmail.com" (a non-breaking hyphen) got on
    // The Star 402's list and its welcome email failed with a 422.
    await seed();
    await store.importSubscribers(['alma\u2011mctygue@hotmail.com'], 'import');
    // from as HQ would likely type it, with a plain hyphen.
    const r = await fix({ from: 'alma-mctygue@hotmail.com', to: 'alma-mctygue@hotmail.com' });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, from: 'alma\u2011mctygue@hotmail.com', to: 'alma-mctygue@hotmail.com', added: true });
    expect(await statusOf('alma-mctygue@hotmail.com')).toBe('active');
    expect(await statusOf('alma\u2011mctygue@hotmail.com')).toBe('bounced');
  });

  it('takes the accents off one the site stopped mailing, with someone\'s OK', async () => {
    // Oct 2026: "m\u01f0\u00ecskra11@gmail.com" on The Star 402.
    await seed();
    await store.importSubscribers(['m\u01f0\u00ecskra11@gmail.com'], 'import');
    await store.markSubscribersBounced(['m\u01f0\u00ecskra11@gmail.com']);
    const r = await fix({ from: 'mjiskra11@gmail.com', to: 'mjiskra11@gmail.com' });
    expect(r.status).toBe(200);
    expect(await statusOf('mjiskra11@gmail.com')).toBe('active');
    expect(await statusOf('m\u01f0\u00ecskra11@gmail.com')).toBe('bounced');
    // Never to another name.
    expect((await (await fix({ from: 'm\u01f0\u00ecskra11@gmail.com', to: 'miskra11@gmail.com' })).json()).error).toBe('not-a-typo');
  });

  it('a stray-character fix is only ever to what the form makes of the address', async () => {
    await seed();
    await store.importSubscribers(['alma\u2011mctygue@hotmail.com'], 'import');
    // Another name before the @ isn't the same person.
    expect((await (await fix({ from: 'alma\u2011mctygue@hotmail.com', to: 'alma.mctygue@hotmail.com' })).json()).error).toBe('not-a-typo');
    // A plain-ASCII address that's fine has nothing to fix.
    expect((await fix({ from: 'happy@gmail.com', to: 'happy@gmail.com' })).status).toBe(404);
    expect(await statusOf('alma.mctygue@hotmail.com')).toBeUndefined();
    expect(await statusOf('alma\u2011mctygue@hotmail.com')).toBe('active');
  });

  it('HQ can add subscribers, a few at a time, never an impossible ending', async () => {
    await seed();
    const imp = body => fetch(baseUrl + '/api/hq/admin/newsletter/import', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${HQK}` }, body: JSON.stringify(body) });
    const r = await imp({ emails: 'mjiskra11@gmail.com, happy@gmail.com' });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, added: 1, already: 1 });
    expect(await statusOf('mjiskra11@gmail.com')).toBe('active');
    expect((await (await imp({ emails: 'pat@gmail.comm' })).json()).error).toBe('bad-email');
    expect((await (await imp({ emails: Array.from({ length: 26 }, (_, i) => `p${i}@gmail.com`).join(' ') })).json()).error).toBe('too-many');
    expect((await fetch(baseUrl + '/api/hq/admin/newsletter/import', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' }, body: '{"emails":"x@gmail.com"}' })).status).toBe(401);
    expect(await statusOf('x@gmail.com')).toBeUndefined();
  });

  it('needs the HQ key or an admin login', async () => {
    await seed();
    const r = await fetch(baseUrl + '/api/hq/admin/newsletter/fix-subscriber', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' },
      body: JSON.stringify({ from: 'melaniereeves60@gmail.comm', to: 'melaniereeves60@gmail.com' }) });
    expect(r.status).toBe(401);
    expect(await statusOf('melaniereeves60@gmail.com')).toBeUndefined();
  });
});

describe('an address email can\'t go to is fixed by the site itself', () => {
  // Oct 2026: alma-mctygue@hotmail.com on The Star 402 had a character
  // Resend refuses, and nobody could see which one.
  const statusOf = async (email) => ((await store.listSubscribers()).find(s => s.email === email) || {}).status;
  const settle = async (check) => { for (let i = 0; i < 50 && !(await check()); i++) await new Promise(r => setTimeout(r, 10)); };

  it('corrects one it can clean up in place, keeping the subscriber', async () => {
    await startApp({ before: async s => {
      await s.importSubscribers(['alma\u2011mctygue@hotmail.com', 'b\uff4fb@gmail.com', 'happy@gmail.com'], 'import');
    } });
    const token = (await store.listSubscribers()).find(s => s.email.startsWith('alma')).token;
    await settle(async () => await statusOf('alma-mctygue@hotmail.com') === 'active' && await statusOf('bob@gmail.com') === 'active');
    expect(await statusOf('alma-mctygue@hotmail.com')).toBe('active');
    expect(await statusOf('bob@gmail.com')).toBe('active');
    expect(await statusOf('happy@gmail.com')).toBe('active');
    expect((await store.listSubscribers()).find(s => s.email === 'alma-mctygue@hotmail.com').token).toBe(token);
    expect((await store.listSubscribers()).some(s => /[^\x01-\x7f]/.test(s.email))).toBe(false);
    expect(alerts).toEqual([]);
  });

  it('stops mailing one it can\'t, and the alert spells out the character', async () => {
    // A Cyrillic "а" looks like the Latin one.
    await startApp({ before: async s => { await s.importSubscribers(['\u0430lma@hotmail.com'], 'import'); } });
    await settle(async () => await statusOf('\u0430lma@hotmail.com') === 'bounced');
    expect(await statusOf('\u0430lma@hotmail.com')).toBe('bounced');
    expect(alerts.find(a => /can't go to/.test(a.title)).detail).toContain('[U+0430]lma@hotmail.com');
  });
});
