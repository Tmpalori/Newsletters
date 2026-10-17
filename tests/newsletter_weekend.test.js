// The Thursday weekend issue (server/newsletter.js EDITIONS): Friday to
// Sunday, its own send and key, skippable from /email-prefs, scheduled
// Thursday 7:00 AM, and counted in pick and sponsor promises and reports.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { withPages } from '../server/seo.js';
import { renderWeekly, editionOf, EDITIONS, renderSubscribePage, upcomingIssueDay } from '../server/newsletter.js';
import { newsletterCovers, weekendCovers, pickWhere } from '../server/notify.js';
import { dueSlot, JOBS } from '../server/scheduler.js';

const THU = new Date('2026-10-08T12:30:00Z'); // Thursday Oct 8, 7:30 AM CDT
const EVENTS = [
  { date: '2026-10-07', name: 'Wednesday Trivia', time: '7 PM', venue: 'Pub' },
  { date: '2026-10-08', name: 'Thursday Bingo', time: '6 PM', venue: 'Hall' },
  { date: '2026-10-09', name: 'Friday Live Music', time: '8 PM', venue: 'Aero Crafters', icons: ['music'] },
  { date: '2026-10-10', name: 'Farmers Market', time: '8 AM', venue: 'Market Square', featured: true },
  { date: '2026-10-11', name: 'Sunday Brunch', time: '10 AM', venue: 'Cafe' },
  { date: '2026-10-12', name: 'Next Monday', time: '7 PM' }
];

let tmpDir, server, baseUrl, store, sent, nlApi;
afterEach(async () => {
  if (server) await new Promise(r => server.close(r));
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  server = null; tmpDir = null;
});

async function startApp(extra = {}) {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-wk-'));
  const eventsFile = path.join(tmpDir, 'events.json');
  await fs.writeFile(eventsFile, JSON.stringify({ events: EVENTS, sponsor: { name: 'Acme Tacos', text: 'Best tacos.', cta: 'Order', url: 'https://acme.example' } }));
  store = new FileStore(path.join(tmpDir, 's.json'));
  sent = { batches: [], single: [] };
  const resend = {
    send: async (msg) => { sent.single.push(msg); return { id: 'e1' }; },
    batch: async (msgs, key) => { sent.batches.push({ msgs, key }); return { data: msgs.map((_, i) => ({ id: `b${i}` })) }; }
  };
  const made = await createApp({
    storeBundle: { kind: 'file', store }, eventsFile, trustProxy: false, now: () => THU,
    siteUrl: 'https://www.thevic361.com', adminUsername: 'a', adminPassword: 'b', adminSessionSecret: 'c',
    resendApiKey: 're_test', newsletterAddress: '123 Main St, Victoria, TX 77901', newsletterCronSecret: 'cron-secret', resend, ...extra
  });
  nlApi = made.newsletter;
  server = http.createServer(made.app);
  await new Promise(r => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}
const post = (p, body, headers = {}) => fetch(baseUrl + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body || {}) });
async function auth() {
  const r = await post('/api/admin/login', { username: 'a', password: 'b' });
  return { Authorization: `Bearer ${(await r.json()).token}` };
}

describe('weekend issue content', () => {
  it('lists Friday to Sunday only, with its own title, campaign and a way to skip it', () => {
    const issue = renderWeekly(withPages(EVENTS), { siteUrl: 'https://www.thevic361.com', now: THU, sponsor: { name: 'Acme', text: 'Tacos', cta: 'Go', url: 'https://acme.example' },
      unsubscribeUrl: 'https://www.thevic361.com/unsubscribe?token=t', address: '1 Main', edition: 'weekend', prefsUrl: 'https://www.thevic361.com/email-prefs?token=t' });
    expect(issue.subject).toBe('This weekend in Victoria: 3 things to do (Oct 9–Oct 11)');
    expect(issue.total).toBe(3);
    for (const name of ['Friday Live Music', 'Farmers Market', 'Sunday Brunch']) expect(issue.html).toContain(name);
    for (const name of ['Wednesday Trivia', 'Thursday Bingo', 'Next Monday']) expect(issue.html).not.toContain(name);
    expect(issue.html).toContain('utm_campaign=weekend-2026-10-08');
    expect(issue.html).toContain('Just want Mondays? Skip the weekend email');
    // The settings link carries the private token: never UTM-tagged.
    expect(issue.html).toContain('href="https://www.thevic361.com/email-prefs?token=t"');
    expect(issue.html).toContain('THIS WEEK\'S SPONSOR');
    expect(issue.text).toContain('Just want Mondays? Skip the weekend email: https://www.thevic361.com/email-prefs?token=t');
    expect(issue.html).toContain('every Monday and Thursday');
  });

  it('tells the two issues apart by their key', () => {
    expect(EDITIONS.weekly.key('2026-10-08')).toBe('2026-10-05');
    expect(EDITIONS.weekend.key('2026-10-08')).toBe('2026-10-08');
    expect(editionOf('2026-10-08')).toBe('weekend');
    expect(editionOf('2026-10-05')).toBe('weekly');
    expect(editionOf('nope')).toBe('weekly');
  });

  it('the signup page promises both issues', () => {
    const html = renderSubscribePage([], { siteUrl: 'https://www.thevic361.com', now: THU });
    expect(html).toContain('every Monday and Thursday');
    expect(html).toContain('Thursday mornings:');
  });
});

describe('weekend issue sending', () => {
  async function subscribers() {
    await store.importSubscribers(['a@example.com', 'b@example.com', 'c@example.com'], 'import');
    const subs = await store.listSubscribers({ status: 'active' });
    const b = subs.find(s => s.email === 'b@example.com');
    await store.setWeekendOptout(b.token, true);
    return subs;
  }

  it('goes to everyone who didn\'t skip it, once, under Thursday\'s key; Monday\'s is separate', async () => {
    await startApp();
    await subscribers();
    const out = await nlApi.sendWeekly({ edition: 'weekend' });
    expect(out).toMatchObject({ ok: true, week_key: '2026-10-08', recipients: 2 });
    expect(sent.batches[0].msgs.map(m => m.to[0]).sort()).toEqual(['a@example.com', 'c@example.com']);
    expect(sent.batches[0].msgs[0].subject).toMatch(/^This weekend in Victoria/);
    expect(sent.batches[0].msgs[0].html).toContain('/email/o/2026-10-08/');
    expect(sent.batches[0].key).toMatch(/^vic361-2026-10-08-/);
    expect(await nlApi.sendWeekly({ edition: 'weekend' })).toMatchObject({ ok: false, error: 'already-sent' });
    // This week's Monday issue is its own send (to everyone).
    const mon = await nlApi.sendWeekly();
    expect(mon).toMatchObject({ ok: true, week_key: '2026-10-05', recipients: 3 });
  });

  it('NEWSLETTER_WEEKEND=0 stops it, and the scheduler doesn\'t retry that', async () => {
    await startApp({ newsletterWeekend: '0' });
    await subscribers();
    expect(await nlApi.sendWeekly({ edition: 'weekend' })).toMatchObject({ ok: false, error: 'weekend-off' });
    expect(await nlApi.scheduledSend('weekend')).toMatchObject({ ok: true, final: true, sent_ok: false });
    expect(sent.batches).toHaveLength(0);
  });

  it('the fallback cron sends the issue its header names', async () => {
    await startApp();
    await subscribers();
    const r = await post('/api/newsletter/cron', {}, { 'X-Cron-Secret': 'cron-secret', 'X-Newsletter-Edition': 'weekend' });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, week_key: '2026-10-08', edition: 'weekend' });
  });

  it('the admin sees both issues and can preview, test and send either', async () => {
    await startApp();
    await subscribers();
    const h = await auth();
    const d = await (await fetch(baseUrl + '/api/admin/newsletter', { headers: h })).json();
    expect(d.weekend).toMatchObject({ enabled: true, opted_out: 1, sent: false, next: { events: 3 } });
    const prevRes = await fetch(baseUrl + '/api/admin/newsletter/preview?edition=weekend', { headers: h });
    expect(prevRes.headers.get('x-issue-date')).toBe('2026-10-08');
    expect(await prevRes.text()).toContain('This weekend in Victoria');
    // On a Thursday the Monday preview is next Monday's issue, not this week's.
    const monRes = await fetch(baseUrl + '/api/admin/newsletter/preview?edition=weekly', { headers: h });
    expect(monRes.headers.get('x-issue-date')).toBe('2026-10-12');
    const mon = await monRes.text();
    expect(mon).toContain('Next Monday');
    expect(mon).not.toContain('Thursday Bingo');
    const t = await post('/api/admin/newsletter/test', { email: 'me@example.com', edition: 'weekend' }, h);
    expect(t.status).toBe(200);
    expect(sent.single[0].subject).toMatch(/^\[Test\] This weekend in Victoria/);
    const s = await post('/api/admin/newsletter/send', { edition: 'weekend' }, h);
    expect(await s.json()).toMatchObject({ ok: true, week_key: '2026-10-08', recipients: 2 });
    const after = await (await fetch(baseUrl + '/api/admin/newsletter', { headers: h })).json();
    expect(after.weekend.sent).toBe(true);
    expect(after.this_week_sent).toBe(false);
    expect(after.sends.map(x => x.edition)).toEqual(['weekend']);
    // Once today's issue is out, the preview moves on to next Thursday's.
    const next = await fetch(baseUrl + '/api/admin/newsletter/preview?edition=weekend', { headers: h });
    expect(next.headers.get('x-issue-date')).toBe('2026-10-15');
  });

  it('the preview is of the upcoming Monday and Thursday', () => {
    // Sunday Oct 11: tomorrow's Monday issue, and Thursday's after it.
    expect(upcomingIssueDay('weekly', '2026-10-11')).toBe('2026-10-12');
    expect(upcomingIssueDay('weekend', '2026-10-11')).toBe('2026-10-15');
    // On the day: that day's issue until it's sent, then next week's.
    expect(upcomingIssueDay('weekly', '2026-10-12')).toBe('2026-10-12');
    expect(upcomingIssueDay('weekly', '2026-10-12', true)).toBe('2026-10-19');
    expect(upcomingIssueDay('weekend', '2026-10-09')).toBe('2026-10-15');
  });
});

describe('email settings', () => {
  it('a reader can skip the weekend issue and turn it back on; GET changes nothing', async () => {
    await startApp();
    await store.importSubscribers(['a@example.com'], 'import');
    const [a] = await store.listSubscribers({ status: 'active' });
    const page = await (await fetch(`${baseUrl}/email-prefs?token=${a.token}`)).text();
    expect(page).toContain('Just Mondays, skip the weekend issue');
    expect((await store.listSubscribers({ status: 'active' }))[0].weekend_optout).toBeFalsy();
    const off = await fetch(`${baseUrl}/email-prefs?token=${a.token}&weekend=0`, { method: 'POST' });
    expect(await off.text()).toContain('Done: just Mondays from now on.');
    expect((await store.listSubscribers({ status: 'active' }))[0].weekend_optout).toBe(true);
    const on = await fetch(`${baseUrl}/email-prefs?token=${a.token}&weekend=1`, { method: 'POST' });
    expect(await on.text()).toContain('weekend issue on Thursdays too');
    expect((await store.listSubscribers({ status: 'active' }))[0].weekend_optout).toBe(false);
  });

  it('an unknown or unsubscribed token gets "Link expired"', async () => {
    await startApp();
    expect((await fetch(`${baseUrl}/email-prefs?token=nope`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/email-prefs?token=nope&weekend=0`, { method: 'POST' })).status).toBe(404);
    await store.importSubscribers(['a@example.com'], 'import');
    const [a] = await store.listSubscribers({ status: 'active' });
    await store.unsubscribe(a.token);
    expect((await fetch(`${baseUrl}/email-prefs?token=${a.token}`)).status).toBe(404);
  });
});

describe('promises and the schedule', () => {
  it('a Friday–Sunday Vic’s Pick booked by Tuesday is promised Thursday’s issue', () => {
    const tue = new Date('2026-10-06T15:00:00Z');
    expect(newsletterCovers('2026-10-10', tue)).toBe(false);
    expect(weekendCovers('2026-10-10', tue)).toBe(true);
    expect(weekendCovers('2026-10-08', tue)).toBe(false); // a Thursday event isn't in the weekend issue
    expect(weekendCovers('2026-10-10', new Date('2026-10-07T15:00:00Z'))).toBe(false); // Wednesday: no day to review
    expect(pickWhere('2026-10-10', tue)).toBe('starred in Thursday’s weekend newsletter (October 8) and featured first in our social posts');
    expect(pickWhere('2026-10-17', tue)).toBe('starred in the Monday newsletter for the week of October 12 and Thursday’s weekend newsletter (October 15) and featured first in our social posts');
  });

  it('the scheduler sends it Thursdays from 7:00 AM Central', () => {
    const job = JOBS.find(j => j.name === 'newsletter-weekend');
    expect(dueSlot(job, new Date('2026-10-08T11:59:00Z'))).toBeNull();
    expect(dueSlot(job, new Date('2026-10-08T12:00:00Z'))).toBe('2026-10-08');
    expect(dueSlot(job, new Date('2026-10-05T12:00:00Z'))).toBeNull();
  });
});

describe('review fixes', () => {
  it('a settings link from an older issue (old token) still works, and a comeback gets Thursdays again', async () => {
    await startApp();
    await store.importSubscribers(['a@example.com'], 'import');
    let [a] = await store.listSubscribers({ status: 'active' });
    const oldToken = a.token;
    await store.setWeekendOptout(oldToken, true);
    expect(await store.countWeekendOptouts()).toBe(1);
    await store.unsubscribe(oldToken);
    const back = await store.addSubscriber({ email: 'a@example.com', source: 'site' });
    await store.confirmSubscriber(back.token);
    [a] = await store.listSubscribers({ status: 'active' });
    expect(a.weekend_optout).toBe(false);
    // The old link from an earlier issue: same person, still works.
    const r = await fetch(`${baseUrl}/email-prefs?token=${oldToken}&weekend=0`, { method: 'POST' });
    expect(r.status).toBe(200);
    expect((await store.listSubscribers({ status: 'active' }))[0].weekend_optout).toBe(true);
  });

  it('the event check runs Thursday before the weekend issue', () => {
    const job = JOBS.find(j => j.name === 'event-check-weekend');
    expect(job).toMatchObject({ dow: 4, kind: 'event-check' });
    expect(dueSlot(job, new Date('2026-10-08T11:00:00Z'))).toBe('2026-10-08'); // 6:00 AM CDT
  });
});

describe('second review fixes', () => {
  it('Monday\'s send going out doesn\'t make Thursday\'s look done', async () => {
    // Monday's batch hangs until released; Thursday's goes out meanwhile.
    let release;
    const gate = new Promise(r => { release = r; });
    const batches = [];
    const resend = {
      send: async () => ({ id: 'e1' }),
      batch: async (msgs, key) => {
        batches.push(key);
        if (key.startsWith('vic361-2026-10-05-')) await gate;
        return { data: msgs.map((_, i) => ({ id: `b${i}` })) };
      }
    };
    await startApp({ resend });
    await store.importSubscribers(['a@example.com'], 'import');
    const monday = nlApi.sendWeekly({ edition: 'weekly' });
    await new Promise(r => setTimeout(r, 30));
    expect(await nlApi.sendWeekly({ edition: 'weekly' })).toMatchObject({ error: 'in-progress' });
    const thursday = await nlApi.sendWeekly({ edition: 'weekend' });
    expect(thursday).toMatchObject({ ok: true, week_key: '2026-10-08' });
    release();
    expect(await monday).toMatchObject({ ok: true, week_key: '2026-10-05' });
  });

  it('opens of a weekend issue sent early in the week still count', async () => {
    await startApp({ now: () => new Date('2026-10-06T15:00:00Z') }); // Tuesday
    await store.importSubscribers(['a@example.com'], 'import');
    const [a] = await store.listSubscribers({ status: 'active' });
    await fetch(`${baseUrl}/email/o/2026-10-08/${a.id}.gif`);
    // The open is recorded after the pixel is sent: wait for it.
    await vi.waitFor(async () => expect(await store.countEmailOpens(['2026-10-08'])).toEqual({ '2026-10-08': 1 }));
  });

  it('a pending subscriber\'s settings link changes nothing', async () => {
    await startApp();
    const p = await store.addSubscriber({ email: 'p@example.com', source: 'site' });
    const r = await fetch(`${baseUrl}/email-prefs?token=${p.token}&weekend=0`, { method: 'POST' });
    expect(r.status).toBe(404);
    expect((await store.listSubscribers({})).find(x => x.email === 'p@example.com').weekend_optout).toBeFalsy();
  });

  it('with NEWSLETTER_WEEKEND=0, Monday\'s issue has no weekend settings link', async () => {
    await startApp({ newsletterWeekend: '0' });
    await store.importSubscribers(['a@example.com'], 'import');
    await nlApi.sendWeekly();
    expect(sent.batches[0].msgs[0].html).not.toContain('/email-prefs');
  });
});

describe('multi-agent review fixes', () => {
  it('a weekly sponsor\'s report counts only the issues their block was in', async () => {
    const { sponsorStats } = await import('../server/sponsors.js');
    const { renderSponsorReport } = await import('../server/notify.js');
    const order = { id: 'w1', kind: 'weekly', business: 'Acme', week_start: '2026-10-05' };
    const one = sponsorStats(order, [], { recipients: 950, issues: 1 });
    expect(renderSponsorReport(order, one, { siteUrl: 'https://x' }).text).toContain('Newsletter copies with your block: 950');
    const two = sponsorStats(order, [], { recipients: 1950, issues: 2 });
    expect(renderSponsorReport(order, two, { siteUrl: 'https://x' }).text).toContain('Newsletter copies with your block (Monday and Thursday issues): 1950');
  });

  it('with NEWSLETTER_WEEKEND=0 nothing promises the Thursday issue', async () => {
    await startApp({ newsletterWeekend: '0' });
    const tue = new Date('2026-10-06T15:00:00Z');
    expect(weekendCovers('2026-10-10', tue)).toBe(false);
    expect(pickWhere('2026-10-10', tue)).not.toMatch(/Thursday/);
    const { renderSponsorConfirmed } = await import('../server/notify.js');
    const mail = renderSponsorConfirmed({ kind: 'weekly', business: 'Acme', week_start: '2026-10-12', sponsor: { name: 'Acme' } }, { siteUrl: 'https://x' });
    expect(mail.text).toContain('top of that Monday’s newsletter');
    expect(mail.text).not.toMatch(/Thursday/);
    // A fresh app with it on promises it again.
    await new Promise(r => server.close(r)); server = null;
    await fs.rm(tmpDir, { recursive: true, force: true }); tmpDir = null;
    await startApp();
    expect(weekendCovers('2026-10-10', tue)).toBe(true);
  });
});
