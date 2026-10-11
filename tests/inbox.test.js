// @vitest-environment node
//
// The owner inbox (server/inbox.js): every Slack ping is also saved with a
// severity, and HQ reads them at GET /api/hq/inbox with HQ_API_KEY only.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { classify, withInbox } from '../server/inbox.js';

const KEY = 'hq-test-key-0123456789';
const NOW = new Date('2026-10-11T18:00:00Z');
let server, tmpDir, base, store, notes;

afterEach(async () => {
  vi.restoreAllMocks();
  if (server) await new Promise(r => server.close(r));
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  server = null; tmpDir = null;
});

async function start(extra = {}) {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-inbox-'));
  const eventsFile = path.join(tmpDir, 'events.json');
  await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
  store = new FileStore(path.join(tmpDir, 's.json'));
  notes = [];
  const { app } = await createApp({ storeBundle: { kind: 'file', store }, eventsFile, trustProxy: false, now: () => NOW,
    siteUrl: 'https://www.thevic361.com', adminUsername: 'a', adminPassword: 'b', adminSessionSecret: 'c', hqApiKey: KEY,
    slack: { enabled: true, notify: async (m) => { notes.push(m); return true; }, alert: async () => true }, ...extra });
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
}
const get = (p, auth) => fetch(base + p, { headers: auth ? { Authorization: auth } : {} });
const settle = () => new Promise(r => setTimeout(r, 50));

describe('severity', () => {
  it.each([
    ['alerts', '🚨 Database down', 'urgent', 'alert'],
    ['alerts', '✅ Site check: back to normal', 'fyi', 'recovered'],
    ['sales', '⚠️ Sponsor disputed a charge: Acme', 'urgent', 'money'],
    ['sales', '↩️ Sponsor refunded: Acme', 'urgent', 'money'],
    ['sales', '📊 Click report sent: Acme', 'fyi', 'sales'],
    ['sales', '👋 Venue partner cancelled: Acme', 'today', 'sales'],
    ['inbox', '💰 Email from boss@acme.example', 'urgent', 'lead'],
    ['inbox', '📬 Email from reader@example.com', 'today', 'email'],
    ['inbox', '✉️ Website message: Advertising', 'urgent', 'lead'],
    ['inbox', '✉️ Website message: Event', 'today', 'message'],
    ['inbox', '↩️ Replied to reader@example.com', 'fyi', 'reply'],
    ['hype', '💰 New sponsor: Acme Tacos', 'today', 'sponsor'],
    ['hype', '📬 The Vic 361: 240 subscribers', 'fyi', 'growth'],
    ['activity', '🤖 Submission review: 2 live, 1 for you to look at', 'today', 'review'],
    ['activity', '📝 New event submitted', 'fyi', 'submission']
  ])('%s · %s → %s', (channel, title, severity, kind) => {
    expect(classify({ channel, title })).toEqual({ severity, kind });
  });
});

describe('withInbox', () => {
  it('saves every ping (even with Slack off) and one per alert window', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-inbox-'));
    store = new FileStore(path.join(tmpDir, 's.json'));
    let t = 0;
    const raw = { enabled: false, notify: async () => false, alert: async () => false, refused: () => [] };
    const slack = withInbox(raw, () => store, { nowFn: () => t });
    expect(typeof slack.refused).toBe('function');
    await slack.notify({ title: '✉️ Website message: Advertising', fields: [['Name', 'Pat'], ['Email', 'pat@acme.example'], ['Empty', '']], text: 'Rates?', channel: 'inbox' });
    await slack.alert('db', 'Database down', 'ECONNREFUSED');
    await slack.alert('db', 'Database down', 'again');                // same window: Slack dedupes, so do we
    t = 16 * 60 * 1000;
    await slack.alert('db', 'Database down', 'still');
    await settle();
    const ev = await store.listInboxEvents(0);
    expect(ev.map(e => [e.id, e.severity, e.kind])).toEqual([[1, 'urgent', 'lead'], [2, 'urgent', 'alert'], [3, 'urgent', 'alert']]);
    expect(ev[0].payload).toEqual({ fields: [['Name', 'Pat'], ['Email', 'pat@acme.example']], text: 'Rates?', link: null });
    expect((await store.listInboxEvents(2)).map(e => e.id)).toEqual([3]);
  });

  it('a store failure never breaks the ping', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = { notify: async () => true, alert: async () => true };
    const slack = withInbox(raw, { addInboxEvent: async () => { throw new Error('db down'); } });
    expect(await slack.notify({ title: 'x' })).toBe(true);
    await settle();
    expect(warn).toHaveBeenCalled();
  });
});

describe('GET /api/hq/inbox', () => {
  it('the contact form lands in the inbox; only the HQ key reads it', async () => {
    await start();
    const r = await fetch(base + '/contact', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ topic: 'advertising', name: 'Pat Lee', email: 'pat@acme.example', business: 'Acme', message: 'What are your sponsor rates?' }).toString() });
    expect(r.status).toBe(200);
    await settle();
    expect((await get('/api/hq/inbox')).status).toBe(401);
    expect((await get('/api/hq/inbox', 'Bearer wrong')).status).toBe(401);
    const login = await (await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'a', password: 'b' }) })).json();
    expect((await get('/api/hq/inbox', `Bearer ${login.token}`)).status).toBe(401);      // an admin session isn't the key
    const body = await (await get('/api/hq/inbox?since=0', `Bearer ${KEY}`)).json();
    expect(body).toMatchObject({ ok: true, since: 0, more: false });
    const msg = body.events.find(e => /Website message/.test(e.title));
    expect(msg).toMatchObject({ channel: 'inbox', severity: 'urgent', kind: 'lead' });
    expect(JSON.stringify(msg.payload)).toContain('pat@acme.example');
    expect(body.next).toBe(body.events[body.events.length - 1].id);
    const later = await (await get(`/api/hq/inbox?since=${body.next}`, `Bearer ${KEY}`)).json();
    expect(later.events).toEqual([]);
  });

  it("doesn't exist without HQ_API_KEY", async () => {
    await start({ hqApiKey: '' });
    expect((await get('/api/hq/inbox', `Bearer ${KEY}`)).status).toBe(404);
  });
});

describe('POST /api/hq/reply', () => {
  const REPLY = 'hq-reply-key-0123456789-0123456789-abc';
  let sends;
  const startReply = (extra = {}) => {
    sends = [];
    return start({ hqReplyKey: REPLY, resendApiKey: 're_test', newsletterAddress: '1 Main',
      resend: { send: async (m) => { sends.push(m); return { id: 'e1' }; }, batch: async () => ({ data: [] }) }, ...extra });
  };
  const post = (body, auth = `Bearer ${REPLY}`) => fetch(base + '/api/hq/reply', { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify(body) });
  const contact = async () => {
    await fetch(base + '/contact', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ topic: 'general', name: 'Pat Lee', email: 'pat@acme.example', business: 'Acme', message: 'Hi there' }).toString() });
    await settle();
    return (await store.listInboxEvents(0)).find(e => /Website message/.test(e.title));
  };

  it('sends an approved reply as news@ to whoever wrote in, once', async () => {
    await startReply();
    const evt = await contact();
    expect((await post({ event_id: evt.id, draft: 7, subject: 'Re: hi', text: 'Thanks!' }, null)).status).toBe(401);
    expect((await post({ event_id: evt.id, draft: 7, subject: 'Re: hi', text: 'Thanks!' }, `Bearer ${KEY}`)).status).toBe(401);   // the read-only key can't send
    const r = await post({ event_id: evt.id, draft: 7, subject: 'Re: hi', text: 'Thanks!', to: 'someone@else.example' });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, to: 'pat@acme.example' });
    expect(sends).toHaveLength(1);
    expect(sends[0].to).toEqual(['pat@acme.example']);          // never a recipient HQ names
    expect((await post({ event_id: evt.id, draft: 7, subject: 'Re: hi', text: 'Thanks!' })).status).toBe(409);
    expect(sends).toHaveLength(1);
    await settle();
    expect(notes.some(n => /↩️ Replied to pat@acme.example/.test(n.title))).toBe(true);
  });

  it('only answers messages from people, and only recent ones', async () => {
    await startReply();
    const alert = await store.addInboxEvent({ channel: 'alerts', severity: 'urgent', kind: 'alert', title: '🚨 x',
      payload: { link: 'https://www.thevic361.com/admin.html#reply?to=x%40y.example' } });
    expect((await post({ event_id: alert.id, draft: 1, subject: 's', text: 'hello' })).status).toBe(422);
    const old = await store.addInboxEvent({ channel: 'inbox', severity: 'today', kind: 'email', title: '📬 Email from x@y.example', created_at: '2026-07-01T00:00:00.000Z',
      payload: { link: 'https://www.thevic361.com/admin.html#reply?to=x%40y.example&subject=Re%3A+a' } });
    expect((await post({ event_id: old.id, draft: 2, subject: 's', text: 'hello' })).status).toBe(422);
    expect((await post({ event_id: 999, draft: 3, subject: 's', text: 'hello' })).status).toBe(422);
    expect(sends).toHaveLength(0);
  });

  it("doesn't exist without its own key", async () => {
    await startReply({ hqReplyKey: '' });
    expect((await post({ event_id: 1, draft: 1, subject: 's', text: 'hello' })).status).toBe(404);
    if (server) await new Promise(r => server.close(r));
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    server = null; tmpDir = null;
    await startReply({ hqReplyKey: KEY + 'x'.repeat(20), hqApiKey: KEY + 'x'.repeat(20) });     // same as the read-only key: off
    expect((await post({ event_id: 1, draft: 1, subject: 's', text: 'hello' }, `Bearer ${KEY + 'x'.repeat(20)}`)).status).toBe(404);
  });
});

describe('privacy', () => {
  it('forgetting an email removes its inbox items; the retention purge drops old ones', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-inbox-'));
    store = new FileStore(path.join(tmpDir, 's.json'));
    await store.addInboxEvent({ channel: 'inbox', severity: 'today', kind: 'email', title: '📬 Email from pat@acme.example', payload: {} });
    await store.addInboxEvent({ channel: 'alerts', severity: 'urgent', kind: 'alert', title: '🚨 x', payload: {}, created_at: '2020-01-01T00:00:00.000Z' });
    await store.addInboxEvent({ channel: 'hype', severity: 'fyi', kind: 'growth', title: 'y', payload: {} });
    const out = await store.forgetEmail('pat@acme.example', 'forgotten');
    expect(out.inbox_events).toBe(1);
    await store.purgePersonalData({ submissionsBefore: '2021-01-01T00:00:00.000Z', contactBefore: '2021-01-01T00:00:00.000Z' });
    expect((await store.listInboxEvents(0)).map(e => e.title)).toEqual(['y']);
  });
});
