// @vitest-environment node
//
// Everything that breaks reaches the owner: in Slack, and in the owner inbox
// that HQ and his assistant read. The GitHub workflows' alerts come in
// through POST /api/ops/report (server/opsReport.js); inbox saves that fail
// (no store yet, the database down) are kept and retried; alerts can't
// vanish when only some Slack channels are set up; and the hourly site
// check says when an issue never went out.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { classify, withInbox } from '../server/inbox.js';
import { slackConfig, createSlack } from '../server/slack.js';
import { burst } from '../server/burst.js';
import { cleanTitle, safeLink } from '../server/opsReport.js';
import { createScheduler } from '../server/scheduler.js';

const SECRET = 'ops-secret-0123456789abcdef';
const KEY = 'hq-test-key-0123456789';
let server, tmpDir, base, store, posts;

afterEach(async () => {
  vi.restoreAllMocks();
  if (server) await new Promise(r => server.close(r));
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  server = null; tmpDir = null;
});

const fakeSlack = () => {
  posts = [];
  return {
    enabled: true, refused: () => [],
    notify: async m => { posts.push({ kind: 'notify', ...m }); return true; },
    alert: async (key, title, text) => { posts.push({ kind: 'alert', key, title, text }); return true; }
  };
};

async function start(extra = {}) {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-alerting-'));
  const eventsFile = path.join(tmpDir, 'events.json');
  await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
  store = extra.store || new FileStore(path.join(tmpDir, 's.json'));
  const out = await createApp({ storeBundle: { kind: 'file', store }, eventsFile, candidatesFile: path.join(tmpDir, 'none.json'),
    trustProxy: false, siteUrl: 'https://www.thevic361.com', hqApiKey: KEY, opsReportSecret: SECRET,
    slack: fakeSlack(), startScheduler: false, ...extra });
  server = http.createServer(out.app);
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  return out;
}
const settle = () => new Promise(r => setTimeout(r, 50));
const report = (body, secret = SECRET) => fetch(base + '/api/ops/report', { method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Ops-Secret': secret } : {}) }, body: JSON.stringify(body) });

describe('POST /api/ops/report (GitHub workflow alerts into the inbox)', () => {
  it('needs the secret', async () => {
    await start();
    expect((await report({ title: '🚨 Weekly event collect failed' }, '')).status).toBe(401);
    expect((await report({ title: '🚨 Weekly event collect failed' }, 'wrong')).status).toBe(401);
    expect((await report({ title: '   ' })).status).toBe(400);
  });

  it('is off without a secret (none set, no fallback)', async () => {
    await start({ opsReportSecret: '' });
    expect((await report({ title: 'x' }, '')).status).toBe(401);
  });

  it('already in Slack: saved as urgent, not posted again', async () => {
    await start();
    const r = await report({ title: '🚨 Weekly event collect failed', link: 'https://github.com/Tmpalori/thevic361/actions/runs/1', slack_delivered: true });
    expect(r.status).toBe(200);
    await settle();
    const ev = await store.listInboxEvents(0);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ channel: 'alerts', severity: 'urgent', kind: 'alert', title: '🚨 Weekly event collect failed' });
    expect(ev[0].payload.link).toBe('https://github.com/Tmpalori/thevic361/actions/runs/1');
    expect(posts).toEqual([]);
  });

  it("not in Slack (no webhook, Slack refused): the site posts it, once", async () => {
    await start();
    await report({ title: '[Victoria] 🚨 Monday newsletter send failed', slack_delivered: false });
    await settle();
    expect(posts).toEqual([expect.objectContaining({ kind: 'alert', title: 'Monday newsletter send failed' })]);
    const ev = await store.listInboxEvents(0);
    expect(ev.map(e => [e.title, e.severity])).toEqual([['🚨 Monday newsletter send failed', 'urgent']]);
  });

  it('a recovery is fyi and a collector warning is for today', async () => {
    await start();
    await report({ title: '✅ The site is back up', slack_delivered: true });
    await report({ title: '⚠️ Weekly collect: 2 sources failed', slack_delivered: true });
    await settle();
    expect((await store.listInboxEvents(0)).map(e => [e.severity, e.kind])).toEqual([['fyi', 'recovered'], ['today', 'warning']]);
  });

  it("a report (the event check's list) is saved as fyi activity, never posted", async () => {
    await start();
    const text = '*To look at:*\n' + '• Sat Oct 24 · Live Music: possible duplicate\n'.repeat(60);
    await report({ title: '[Shoals] 🔎 Event check: 30 to look at (253 events in the next 14 days)', text, slack_delivered: true, fyi: true });
    await settle();
    const ev = await store.listInboxEvents(0);
    expect(ev.map(e => [e.channel, e.severity, e.title])).toEqual([['activity', 'fyi', '🔎 Event check: 30 to look at (253 events in the next 14 days)']]);
    expect(ev[0].payload.text.length).toBeGreaterThan(2000);
    expect(posts).toEqual([]);
  });

  it('keeps only links to GitHub or the site, and strips Slack markup', () => {
    expect(safeLink('https://github.com/x/y/actions/runs/1', 'https://www.thevic361.com')).toBe('https://github.com/x/y/actions/runs/1');
    expect(safeLink('https://www.thevic361.com/admin.html', 'https://www.thevic361.com')).toBe('https://www.thevic361.com/admin.html');
    expect(safeLink('https://evil.example/x', 'https://www.thevic361.com')).toBe(null);
    expect(safeLink('http://github.com/x', 'https://www.thevic361.com')).toBe(null);
    expect(safeLink('javascript:alert(1)', '')).toBe(null);
    expect(cleanTitle('[Bay City] 🚨 Collect failed <https://x|Open>')).toBe('🚨 Collect failed');
  });

  it('falls back to the submission review secret, like the workflows', async () => {
    await start({ opsReportSecret: undefined, submissionReviewSecret: 'sub-review-secret-0123456789' });
    expect((await report({ title: '🚨 x', slack_delivered: true }, 'sub-review-secret-0123456789')).status).toBe(200);
  });
});

describe('the inbox keeps pings it couldn\'t save', () => {
  it('saved once the store exists (an alert at boot, before the store)', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-alerting-'));
    const fileStore = new FileStore(path.join(tmpDir, 's.json'));
    let s = null;
    const slack = withInbox({ notify: async () => true, alert: async () => true }, () => s);
    await slack.alert('db-boot', 'Database unreachable at boot', 'ECONNREFUSED');
    expect(slack.pendingInbox()).toBe(1);
    s = fileStore;
    await slack.flushInbox();
    expect(slack.pendingInbox()).toBe(0);
    expect((await fileStore.listInboxEvents(0)).map(e => e.title)).toEqual(['🚨 Database unreachable at boot']);
  });

  it('a database outage holds them in order, and the next save after it sends them all', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const saved = [];
    let down = true;
    const fake = { addInboxEvent: async ev => { if (down) throw new Error('db down'); saved.push(ev.title); } };
    const slack = withInbox({ notify: async () => true, alert: async () => true }, fake);
    await slack.alert('a', 'Database unreachable');
    await slack.notify({ title: '📬 Email from pat@x.example', channel: 'inbox' });
    await settle();
    expect(slack.pendingInbox()).toBe(2);
    down = false;
    await slack.notify({ title: '✅ Site check: back to normal', channel: 'alerts' });
    await settle();
    expect(saved).toEqual(['🚨 Database unreachable', '📬 Email from pat@x.example', '✅ Site check: back to normal']);
    expect(slack.pendingInbox()).toBe(0);
  });

  it('an alert resolves after its save (a crashing process can wait for it)', async () => {
    let done = false;
    const slack = withInbox({ alert: async () => true }, { addInboxEvent: async () => { await new Promise(r => setTimeout(r, 20)); done = true; } });
    expect(await slack.alert('crash', 'Server crashed and is restarting')).toBe(true);
    expect(done).toBe(true);
  });
});

describe('Slack alerts never vanish', () => {
  const hook = n => `https://hooks.slack.com/services/T/B/${n}`;
  it('alerts: own webhook, else SLACK_WEBHOOK_URL, else activity', () => {
    expect(slackConfig({ SLACK_ALERTS_WEBHOOK_URL: hook(1), SLACK_ACTIVITY_WEBHOOK_URL: hook(2), SLACK_WEBHOOK_URL: hook(3) }).urls.alerts).toBe(hook(1));
    expect(slackConfig({ SLACK_ACTIVITY_WEBHOOK_URL: hook(2), SLACK_WEBHOOK_URL: hook(3) }).urls.alerts).toBe(hook(3));
    expect(slackConfig({ SLACK_ACTIVITY_WEBHOOK_URL: hook(2), SLACK_SALES_WEBHOOK_URL: hook(4) }).urls.alerts).toBe(hook(2));
  });
  it('the setup checklist knows when alerts have nowhere to go', () => {
    expect(createSlack(slackConfig({ SLACK_SALES_WEBHOOK_URL: hook(4) })).alertsRouted).toBe(false);
    expect(createSlack(slackConfig({ SLACK_ACTIVITY_WEBHOOK_URL: hook(2) })).alertsRouted).toBe(true);
  });
});

describe('severity of things that broke', () => {
  it.each([
    ['sales', '⏰ A paid Spotlight isn’t on the site yet', 'urgent', 'money'],
    ['activity', '✉️ “You’re live” email refused: Fall Fest', 'today', 'review'],
    ['alerts', '⚠️ Weekly collect: 2 sources failed', 'today', 'warning'],
    ['alerts', '🚨 Stripe webhooks are being refused (bad signature)', 'urgent', 'alert']
  ])('%s "%s" is %s', (channel, title, severity, kind) => {
    expect(classify({ channel, title })).toEqual({ severity, kind });
  });
});

describe('burst', () => {
  it('answers once per window when enough happen inside it', () => {
    const b = burst(3, 1000);
    expect([b(0), b(100), b(200), b(300), b(900)]).toEqual([0, 0, 3, 0, 0]);
    expect(b(1250)).toBe(3);             // 300, 900 and this, a window after the alert at 200
    expect(burst(3, 1000)(0)).toBe(0);
  });
});

describe('GET /api/hq/inbox: latest', () => {
  it('says the newest id, so HQ notices a database that was reset', async () => {
    await start();
    await report({ title: '🚨 a', slack_delivered: true });
    await report({ title: '🚨 b', slack_delivered: true });
    await settle();
    const body = await (await fetch(base + '/api/hq/inbox?since=1', { headers: { Authorization: `Bearer ${KEY}` } })).json();
    expect(body).toMatchObject({ ok: true, latest: 2 });
    expect(body.events.map(e => e.id)).toEqual([2]);
  });
});

describe('the hourly check: an issue that never went out', () => {
  const events = Array.from({ length: 12 }, (_, i) => ({ date: '2026-10-14', name: `E${i}`, venue: 'V' }));
  async function check(now, { sent = false, subscribers = 5, ...extra } = {}) {
    const out = await start({ now: () => now, resendApiKey: 're_test', newsletterAddress: '1 Main St', ...extra });
    await store.setPublished({ last_updated: now.toISOString(), events, auto_publish: { from: '2026-10-11T20:40:00Z' } });
    store.countSubscribers = async () => ({ active: subscribers });
    store.getNewsletterSend = async key => (sent && key === '2026-10-12' ? { week_key: key } : null);
    await out.healthCheck(now);
    return posts.filter(p => p.kind === 'alert' && /newsletter/.test(p.text || ''));
  }

  it("says so after Monday's noon cutoff", async () => {
    const late = await check(new Date('2026-10-12T17:30:00Z'));   // Mon 12:30 PM CDT
    expect(late).toHaveLength(1);
    expect(late[0].text).toContain("Monday's newsletter (2026-10-12) hasn't gone out");
  });

  it('not before the cutoff, not once sent, not without readers, not with autosend off', async () => {
    expect(await check(new Date('2026-10-12T16:30:00Z'))).toEqual([]);
    expect(await check(new Date('2026-10-12T17:30:00Z'), { sent: true })).toEqual([]);
    expect(await check(new Date('2026-10-12T17:30:00Z'), { subscribers: 0 })).toEqual([]);
    expect(await check(new Date('2026-10-12T17:30:00Z'), { newsletterAutosend: '0' })).toEqual([]);
  });

  it('names a missing Resend key', async () => {
    const late = await check(new Date('2026-10-12T17:30:00Z'), { resendApiKey: '' });
    expect(late[0].text).toContain('RESEND_API_KEY');
  });

  it('stops after three days', async () => {
    expect(await check(new Date('2026-10-15T18:00:00Z'), { newsletterWeekend: '0' })).toEqual([]);
  });
});

describe('a repeating job that keeps failing', () => {
  it('alerts after an hour of failures in a row, and says when it works again', async () => {
    const alerts = [], notes = [];
    const slack = { alert: (k, t) => { alerts.push(t); }, notify: m => { notes.push(m.title); } };
    let fail = true;
    const queueJob = async () => { if (fail) throw new Error('database down'); };
    const jobs = [{ name: 'submission-review', every: 15, kind: 'submission-review' }];
    const s = createScheduler({ store: {}, queueJob, canQueue: () => true, slack, jobs, log: { warn() {} } });
    for (const m of ['00', '15', '30']) await s.tick(new Date(`2026-10-12T15:${m}:00Z`));
    expect(alerts).toEqual([]);
    await s.tick(new Date('2026-10-12T15:45:00Z'));
    await s.tick(new Date('2026-10-12T16:00:00Z'));
    expect(alerts).toEqual(['Scheduled submission-review keeps failing']);
    fail = false;
    await s.tick(new Date('2026-10-12T16:15:00Z'));
    expect(notes).toEqual(['✅ Scheduled submission-review working again']);
  });
});
