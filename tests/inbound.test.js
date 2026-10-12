// @vitest-environment node
//
// Email replies to news@ land in Slack (server/inbound.js), and the admin
// answers as news@. Resend and Slack are recording fakes; nothing is sent.

import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { verifySvix, newText, bodyText, isAutomatic, replyLink, renderReply, isForTown } from '../server/inbound.js';
import { townConfig, VICTORIA, otherTownDomains } from '../server/town.js';
import { newsletterConfig } from '../server/newsletter.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const SECRET = 'whsec_' + Buffer.from('test-signing-key-0123456789').toString('base64');
const NOW = new Date('2026-10-09T18:00:00Z');
const nowS = Math.floor(NOW.getTime() / 1000);

function sign(body, { id = 'msg_1', ts = nowS, secret = SECRET } = {}) {
  const key = Buffer.from(secret.slice(6), 'base64');
  const sig = crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}` };
}

describe('pieces', () => {
  it('verifies Svix signatures, and refuses forged, stale or unsigned ones', () => {
    const body = '{"type":"email.received"}';
    const h = sign(body);
    const hdr = { id: h['svix-id'], timestamp: h['svix-timestamp'], signature: h['svix-signature'] };
    expect(verifySvix(body, hdr, SECRET, nowS)).toBe(true);
    expect(verifySvix(body, { ...hdr, signature: 'v1,bm9wZQ== ' + hdr.signature }, SECRET, nowS)).toBe(true); // one of several
    expect(verifySvix(body + ' ', hdr, SECRET, nowS)).toBe(false);
    expect(verifySvix(body, hdr, 'whsec_' + Buffer.from('other').toString('base64'), nowS)).toBe(false);
    expect(verifySvix(body, hdr, SECRET, nowS + 600)).toBe(false);
    expect(verifySvix(body, { ...hdr, signature: '' }, SECRET, nowS)).toBe(false);
  });

  it('keeps just what they wrote, from text or (data: URI) HTML', () => {
    expect(newText('Love live music!\n\nOn Mon, Oct 5, 2026 at 7:43 AM The Vic 361 <news@thevic361.com> wrote:\n> This week…')).toBe('Love live music!');
    expect(newText('Kids stuff please\r\n> quoted')).toBe('Kids stuff please');
    expect(newText('Hi\n\nFrom: The Vic 361\nSent: Monday')).toBe('Hi');
    const html = '<div>More <b>food</b> trucks&nbsp;please</div><style>p{}</style>';
    expect(bodyText({ text: null, html: 'data:text/html;base64,' + Buffer.from(html).toString('base64') }).trim()).toBe('More food trucks please');
    expect(bodyText({ text: 'plain', html: '<p>x</p>' })).toBe('plain');
  });

  it('spots out-of-office and bounces', () => {
    expect(isAutomatic({ subject: 'Automatic reply: This week in Victoria', from: 'a@b.com' })).toBe(true);
    expect(isAutomatic({ subject: 'Re: hi', from: 'a@b.com', headers: { 'Auto-Submitted': 'auto-replied' } })).toBe(true);
    expect(isAutomatic({ subject: 'Undeliverable: x', from: 'MAILER-DAEMON@x.com' })).toBe(true);
    expect(isAutomatic({ subject: 'Re: This week in Victoria', from: 'Mary <mary@gmail.com>', headers: { 'auto-submitted': 'no' } })).toBe(false);
  });

  it('builds the admin reply link and a plain signed reply', () => {
    expect(replyLink('https://www.thevic361.com', { to: 'a@b.com', subject: 'Hello', ref: '<x@y>' }))
      .toBe('https://www.thevic361.com/admin.html#reply?to=a%40b.com&subject=Re%3A+Hello&ref=%3Cx%40y%3E');
    const r = renderReply('Thanks!\n\nSee you there <3', 'https://www.thevic361.com');
    expect(r.text).toBe('Thanks!\n\nSee you there <3\n\nTristen\nThe Vic 361 · www.thevic361.com');
    expect(r.html).toContain('See you there &lt;3');
  });

  it('the reply ask turns on once receiving is set up', () => {
    expect(newsletterConfig({}).inbound).toBe(false);
    expect(newsletterConfig({ RESEND_WEBHOOK_SECRET: SECRET }).inbound).toBe(true);
  });
});

describe('which town a received email is for (MULTI_CITY_PLAN.md 2.3)', () => {
  const BAY = townConfig({}, { town: { id: 'bay', siteName: 'The Bay 979', domain: 'thebay979.com', city: 'Bay City', state: 'TX', stateName: 'Texas', timezone: 'America/Chicago' } });
  const others = ['thebay979.com'];

  it('another town takes only mail to its own domain', () => {
    expect(isForTown(['news@thebay979.com'], BAY, ['thevic361.com'])).toBe(true);
    expect(isForTown(['The Bay <News@TheBay979.com>'], BAY, [])).toBe(true);
    expect(isForTown(['news@reply.thebay979.com'], BAY, [])).toBe(true);
    expect(isForTown(['news@thevic361.com'], BAY, [])).toBe(false);
    expect(isForTown(['me@gmail.com'], BAY, [])).toBe(false); // a Bcc: Victoria's Slack gets it
    expect(isForTown([], BAY, [])).toBe(false);
    expect(isForTown(['news@notthebay979.com'], BAY, [])).toBe(false);
  });

  it('Victoria takes everything but mail only to another town', () => {
    expect(isForTown(['news@thevic361.com'], VICTORIA, others)).toBe(true);
    expect(isForTown(['me@gmail.com'], VICTORIA, others)).toBe(true);
    expect(isForTown([], VICTORIA, others)).toBe(true);
    expect(isForTown(['news@thebay979.com', 'news@thevic361.com'], VICTORIA, others)).toBe(true);
    expect(isForTown(['news@thebay979.com'], VICTORIA, others)).toBe(false);
    expect(isForTown(['news@thebay979.com'], VICTORIA, [])).toBe(true); // no such town here
  });

  it("reads other towns' domains from towns/*/town.json", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-towns-'));
    try {
      for (const [id, body] of [['bay', '{"domain":"thebay979.com"}'], ['broken', '{'], ['nodomain', '{}']]) {
        await fs.mkdir(path.join(dir, id));
        await fs.writeFile(path.join(dir, id, 'town.json'), body);
      }
      expect(otherTownDomains(VICTORIA, dir)).toEqual(['thebay979.com']);
      expect(otherTownDomains(VICTORIA, path.join(dir, 'missing'))).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the endpoints', () => {
  let tmpDir, server, baseUrl, pings, alerts, sends, emails;

  async function startApp(extra = {}) {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-inbound-'));
    const eventsFile = path.join(tmpDir, 'events.json');
    await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
    pings = []; alerts = []; sends = []; emails = {};
    const inboundFetch = async (url, init) => {
      const id = decodeURIComponent(url.split('/').pop());
      expect(init.headers.Authorization).toBe('Bearer re_test');
      if (!emails[id]) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => emails[id] };
    };
    const { app } = await createApp({
      storeBundle: { kind: 'file', store: new FileStore(path.join(tmpDir, 's.json')) }, eventsFile, trustProxy: false, now: () => NOW,
      siteUrl: 'https://www.thevic361.com', adminUsername: 'a', adminPassword: 'b', adminSessionSecret: 'c',
      resendApiKey: 're_test', newsletterAddress: '1 Main', resendWebhookSecret: SECRET, inboundFetch,
      resend: { send: async (m) => { sends.push(m); return { id: 'e1' }; }, batch: async () => ({ data: [] }) },
      slack: { enabled: true, notify: async (m) => { pings.push(m); return true; }, alert: async (...a) => { alerts.push(a); } },
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

  const webhook = (event, opts) => {
    const body = JSON.stringify(event);
    return fetch(baseUrl + '/api/email/inbound', { method: 'POST', headers: { 'Content-Type': 'application/json', ...sign(body, opts) }, body });
  };
  const received = (email_id, subject = 'Re: This week in Victoria') => ({ type: 'email.received', created_at: NOW.toISOString(),
    data: { email_id, from: 'mary@gmail.com', to: ['news@thevic361.com'], subject, attachments: [] } });

  it('posts a reply to the inbox channel once, with a "Reply as news@" link; money questions get a 💰', async () => {
    await startApp();
    emails.e1 = { id: 'e1', from: 'Mary D <mary@gmail.com>', to: ['news@thevic361.com'], subject: 'Re: This week in Victoria',
      text: 'More live music and kid stuff!\n\nOn Mon, Oct 5 The Vic 361 wrote:\n> This week…', html: null, headers: {}, message_id: '<abc@mail.gmail.com>', attachments: [] };
    const r = await webhook(received('e1'), { id: 'msg_1' });
    expect(await r.json()).toEqual({ ok: true, result: 'posted' });
    expect(pings).toHaveLength(1);
    expect(pings[0]).toMatchObject({ title: '📬 Email from mary@gmail.com', text: 'More live music and kid stuff!', channel: 'inbox', linkLabel: 'Reply as news@' });
    expect(pings[0].link).toBe(replyLink('https://www.thevic361.com', { to: 'mary@gmail.com', subject: 'Re: This week in Victoria', ref: '<abc@mail.gmail.com>' }));
    // Resend retries the same email: posted once.
    expect(await (await webhook(received('e1'), { id: 'msg_2' })).json()).toEqual({ ok: true, result: 'duplicate' });
    expect(pings).toHaveLength(1);

    emails.e2 = { id: 'e2', from: 'shop@biz.com', to: ['news@thevic361.com'], subject: 'Re: You’re a Vic’s Pick!', text: 'Can I change the time?', headers: {}, attachments: [] };
    await webhook(received('e2', 'Re: You’re a Vic’s Pick!'));
    expect(pings[1]).toMatchObject({ title: '💰 Email from shop@biz.com', channel: 'inbox' });

    emails.e3 = { id: 'e3', from: 'x@y.com', subject: 'Automatic reply: This week in Victoria', text: 'I am out', headers: {} };
    expect(await (await webhook(received('e3'))).json()).toEqual({ ok: true, result: 'automatic' });
    expect(pings).toHaveLength(2);
  });

  it("leaves another town's mail to it", async () => {
    await startApp({ inboundOtherDomains: ['thebay979.com'] });
    emails.b1 = { id: 'b1', from: 'sam@gmail.com', to: ['news@thebay979.com'], subject: 'Hi', text: 'Hello Bay', headers: {}, attachments: [] };
    const bay = { ...received('b1'), data: { ...received('b1').data, to: ['news@thebay979.com'] } };
    expect(await (await webhook(bay)).json()).toEqual({ ok: true, result: 'other-town' });
    expect(pings).toHaveLength(0);
    emails.e1 = { id: 'e1', from: 'mary@gmail.com', to: ['news@thevic361.com'], subject: 'Hi', text: 'Hello Vic', headers: {}, attachments: [] };
    expect(await (await webhook(received('e1'))).json()).toEqual({ ok: true, result: 'posted' });
    expect(pings).toHaveLength(1);
  });

  it('refuses unsigned or forged webhooks, and asks Resend to retry when it can’t fetch the email', async () => {
    await startApp();
    const body = JSON.stringify(received('e9'));
    expect((await fetch(baseUrl + '/api/email/inbound', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status).toBe(400);
    expect((await webhook(received('e9'), { secret: 'whsec_' + Buffer.from('wrong').toString('base64') })).status).toBe(400);
    const r = await webhook(received('missing'));
    expect(r.status).toBe(500);
    expect(alerts[0][0]).toBe('inbound-email-failed');
    expect(pings).toHaveLength(0);
  });

  it('is off (503) until the signing secret is set', async () => {
    await startApp({ resendWebhookSecret: '' });
    expect((await webhook(received('e1'))).status).toBe(503);
  });

  it('the admin replies as news@, threaded under their email; sign-in required', async () => {
    await startApp();
    const post = (body, headers = {}) => fetch(baseUrl + '/api/admin/email/reply', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    expect((await post({ to: 'mary@gmail.com', subject: 'Re: hi', text: 'Thanks!' })).status).toBe(401);
    const login = await (await fetch(baseUrl + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'a', password: 'b' }) })).json();
    const h = { Authorization: `Bearer ${login.token}` };
    const bad = await post({ to: 'nope', subject: '', text: '' }, h);
    expect(bad.status).toBe(400);
    expect(Object.keys((await bad.json()).errors).sort()).toEqual(['subject', 'text', 'to']);
    const ok = await post({ to: 'Mary@Gmail.com', subject: 'Re: This week\nBcc: x', text: 'We’ll add more music!', ref: '<abc@mail.gmail.com>' }, h);
    expect(await ok.json()).toEqual({ ok: true });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ from: 'The Vic 361 <news@thevic361.com>', to: ['mary@gmail.com'], subject: 'Re: This week Bcc: x',
      headers: { 'In-Reply-To': '<abc@mail.gmail.com>', References: '<abc@mail.gmail.com>' } });
    expect(sends[0].text).toContain('We’ll add more music!\n\nTristen\nThe Vic 361');
    expect(pings.at(-1).title).toBe('↩️ Replied to mary@gmail.com');
  });

  it('a contact-form message in Slack carries the same reply link', async () => {
    await startApp();
    const r = await fetch(baseUrl + '/contact', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ topic: 'advertising', name: 'Ann', email: 'Ann@Shop.example', message: 'How much is a sponsor week?' }).toString() });
    expect(r.status).toBe(200);
    expect(pings[0]).toMatchObject({ linkLabel: 'Reply as news@',
      link: replyLink('https://www.thevic361.com', { to: 'ann@shop.example', subject: 'Your message to The Vic 361' }) });
  });
});
