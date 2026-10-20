// @vitest-environment node
//
// First-party visitor stats (server/analytics.js): beacon endpoint, crawler
// logging, and the admin Traffic summary.

import { describe, it, expect, afterEach } from 'vitest';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { botName, referrerSource, beaconRow, summarize } from '../server/analytics.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const NOW = new Date('2026-10-07T17:00:00Z');
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1';

let tmpDir, server, baseUrl, store;

async function startApp(now = NOW) {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-traffic-'));
  const eventsFile = path.join(tmpDir, 'events.json');
  await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
  store = new FileStore(path.join(tmpDir, 's.json'));
  const { app } = await createApp({
    storeBundle: { kind: 'file', store }, eventsFile, trustProxy: false, now: () => now,
    siteUrl: 'https://www.thevic361.com', analyticsSecret: 'test',
    adminUsername: 'tristen', adminPassword: 'pw', adminSessionSecret: 'secret'
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

const beacon = (body, ua = UA) => fetch(baseUrl + '/api/track', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': ua }, body: JSON.stringify(body)
});

async function token() {
  const r = await fetch(baseUrl + '/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'tristen', password: 'pw' })
  });
  return (await r.json()).token;
}

// Writes land after the 204, so wait for them.
const settle = () => new Promise(r => setTimeout(r, 50));
// Wait until n rows are stored (up to 2s): a fixed 50ms was too short on
// busy CI runners for crawler rows, written after the response finishes.
async function settleRows(n) {
  for (let i = 0; i < 40; i++) {
    if ((await store.listTraffic('2026-01-01')).length >= n) return;
    await new Promise(r => setTimeout(r, 50));
  }
}

describe('analytics helpers', () => {
  it('names crawlers and lets browsers through', () => {
    expect(botName('Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)')).toBe('GPTBot (AI training)');
    expect(botName('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0)')).toBe('ClaudeBot (AI training)');
    expect(botName('Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)')).toBe('ChatGPT (answering someone)');
    expect(botName('Mozilla/5.0 (compatible; OAI-SearchBot/1.0)')).toBe('ChatGPT search');
    expect(botName('Mozilla/5.0 (compatible; Perplexity-User/1.0)')).toBe('Perplexity (answering someone)');
    expect(botName('meta-externalagent/1.1')).toBe('Meta AI (AI training)');
    expect(botName('facebookexternalhit/1.1')).toBe('Facebook preview');
    expect(botName('Mozilla/5.0 (compatible; Googlebot/2.1)')).toBe('Googlebot');
    expect(botName('curl/8.6.0')).toBe('Other bot');
    expect(botName(UA)).toBeNull();
  });

  it('groups referrers', () => {
    expect(referrerSource('https://www.google.com/', 'www.thevic361.com').source).toBe('Google');
    expect(referrerSource('https://chatgpt.com/', 'www.thevic361.com').source).toBe('ChatGPT');
    expect(referrerSource('https://gemini.google.com/app', 'www.thevic361.com').source).toBe('Gemini');
    expect(referrerSource('https://www.meta.ai/', 'www.thevic361.com').source).toBe('Meta AI');
    expect(referrerSource('https://l.facebook.com/l.php?u=x', 'www.thevic361.com').source).toBe('Facebook');
    expect(referrerSource('https://www.thevic361.com/live-music', 'www.thevic361.com').source).toBe('Direct');
    expect(referrerSource('', 'www.thevic361.com').source).toBe('Direct');
    expect(referrerSource('https://victoriaadvocate.com/x', 'www.thevic361.com'))
      .toEqual({ source: 'Other sites', host: 'victoriaadvocate.com' });
  });

  it('credits AI apps that send no referrer but tag the link', () => {
    const ctx = { ip: '1.1.1.1', ua: UA, secret: 's', siteHost: 'www.thevic361.com', now: NOW };
    expect(beaconRow({ kind: 'view', ref: '', utm: 'chatgpt.com' }, ctx).ref_source).toBe('ChatGPT');
    expect(beaconRow({ kind: 'view', ref: '', utm: 'perplexity' }, ctx).ref_source).toBe('Perplexity');
    expect(beaconRow({ kind: 'view', ref: '', utm: 'spam<script>' }, ctx).ref_source).toBe('Direct');
    // A real referrer wins over the tag.
    expect(beaconRow({ kind: 'view', ref: 'https://www.google.com/', utm: 'chatgpt.com' }, ctx).ref_source).toBe('Google');
  });

  it('counts a tagged newsletter link as the newsletter whatever the email app sends, and notes which email', () => {
    const ctx = { ip: '1.1.1.1', ua: UA, secret: 's', siteHost: 'www.thevic361.com', now: NOW };
    const row = b => beaconRow({ kind: 'view', utm: 'newsletter', utm_campaign: 'weekly-2026-10-12', ...b }, ctx);
    for (const ref of ['https://mail.google.com/', 'https://www.google.com/', 'android-app://com.google.android.gm/',
      'https://outlook.office.com/mail/', 'https://outlook.live.com/', 'https://mail.yahoo.com/d/folders/1', '']) {
      expect(row({ ref })).toMatchObject({ ref_source: 'Newsletter', ref_host: 'weekly-2026-10-12' });
    }
    expect(row({ ref: '', utm_campaign: 'welcome' }).ref_host).toBe('welcome');
    // Anything else in utm_campaign isn't kept.
    expect(row({ ref: 'https://mail.google.com/', utm_campaign: '<b>x</b>' }).ref_host).toBe('mail.google.com');
    // Webmail without our tag is still email, not Google search.
    expect(referrerSource('https://mail.google.com/mail/u/0/', 'www.thevic361.com').source).toBe('Newsletter');
    expect(referrerSource('android-app://com.google.android.gm', 'www.thevic361.com').source).toBe('Newsletter');
    expect(referrerSource('https://www.google.com/', 'www.thevic361.com').source).toBe('Google');
  });

  it('splits Meta ad taps from free Facebook and Instagram visits', () => {
    const ctx = { ip: '1.1.1.1', ua: UA, secret: 's', siteHost: 'www.thevic361.com', now: NOW };
    const view = b => beaconRow({ kind: 'view', ...b }, ctx).ref_source;
    expect(view({ ref: 'https://l.facebook.com/l.php?u=x', utm: 'fb', utm_medium: 'paid' })).toBe('Meta ads');
    expect(view({ ref: 'https://l.instagram.com/', utm: 'ig', utm_medium: 'paid' })).toBe('Meta ads');
    // In-app browsers often drop the referrer; the tag still says Meta.
    expect(view({ ref: '', utm: 'facebook', utm_medium: 'PAID' })).toBe('Meta ads');
    expect(view({ ref: '', utm: 'google', utm_medium: 'cpc' })).toBe('Other ads');
    // No paid medium: a free post is still Facebook.
    expect(view({ ref: 'https://l.facebook.com/l.php?u=x', utm: 'fb' })).toBe('Facebook');
    expect(view({ ref: 'https://l.facebook.com/l.php?u=x', utm: 'fb', utm_medium: 'social' })).toBe('Facebook');
  });

  it('sums up how AI uses the site', () => {
    const ctx = { ip: '1.1.1.1', ua: UA, secret: 's', siteHost: 'www.thevic361.com', now: NOW };
    const day = beaconRow({ kind: 'view', path: '/' }, ctx).day;
    const rows = [
      beaconRow({ kind: 'view', path: '/', ref: 'https://chatgpt.com/' }, ctx),
      beaconRow({ kind: 'view', path: '/x', ref: 'https://chatgpt.com/' }, ctx),
      beaconRow({ kind: 'view', path: '/', ref: 'https://www.google.com/' }, ctx),
      { day, kind: 'crawl', path: '/this-weekend', bot: 'ChatGPT (answering someone)' },
      { day, kind: 'crawl', path: '/events.json', bot: 'Claude (answering someone)' },
      { day, kind: 'crawl', path: '/', bot: 'ChatGPT search' },
      { day, kind: 'crawl', path: '/', bot: 'GPTBot (AI training)' },
      { day, kind: 'crawl', path: '/', bot: 'Googlebot' }
    ];
    const { ai } = summarize(rows, { now: NOW, days: 7 });
    expect(ai).toMatchObject({ sent_visitors: 1, sent_views: 2, answer_reads: 2, search_crawls: 1, training_crawls: 1 });
    expect(ai.sent_by).toEqual([{ key: 'ChatGPT', count: 2 }]);
    expect(ai.answer_pages.map(p => p.key).sort()).toEqual(['/events.json', '/this-weekend']);
  });

  it('rejects unknown click types and bot beacons', () => {
    const ctx = { ip: '1.1.1.1', ua: UA, secret: 's', siteHost: 'www.thevic361.com', now: NOW };
    expect(beaconRow({ kind: 'click', type: 'drop_tables' }, ctx)).toBeNull();
    expect(beaconRow({ kind: 'view' }, { ...ctx, ua: 'HeadlessChrome' })).toBeNull();
    expect(beaconRow({ kind: 'view', path: '/x?secret=1' }, ctx).path).toBe('/x');
  });

  it('counts one visitor per person per day', () => {
    const ctx = { ip: '1.1.1.1', ua: UA, secret: 's', siteHost: 'www.thevic361.com', now: NOW };
    const a = beaconRow({ kind: 'view', path: '/' }, ctx);
    const b = beaconRow({ kind: 'view', path: '/live-music' }, ctx);
    const c = beaconRow({ kind: 'view', path: '/' }, { ...ctx, ip: '2.2.2.2' });
    expect(a.visitor).toBe(b.visitor);
    expect(a.visitor).not.toBe(c.visitor);
    const t = summarize([a, b, c], { now: NOW, days: 7 });
    expect(t.totals.today).toEqual({ visitors: 2, views: 3 });
    expect(t.top_pages[0]).toEqual({ key: '/', count: 2 });
    expect(t.daily).toHaveLength(7);
  });

  it('totals the whole period picked, not just 30 days', () => {
    const ctx = { ip: '1.1.1.1', ua: UA, secret: 's', siteHost: 'www.thevic361.com', now: NOW };
    const today = beaconRow({ kind: 'view', path: '/' }, ctx);
    const old = beaconRow({ kind: 'view', path: '/' }, { ...ctx, ip: '3.3.3.3', now: new Date(NOW.getTime() - 60 * 86400000) });
    const t = summarize([today, old], { now: NOW, days: 90 });
    expect(t.totals.range).toEqual({ visitors: 2, views: 2 });
    expect(t.totals.week).toEqual({ visitors: 1, views: 1 });
  });
});

describe('traffic endpoints', () => {
  it('records views, clicks and crawler hits, and summarizes them for the admin', async () => {
    await startApp();
    expect((await beacon({ kind: 'view', path: '/this-weekend', ref: 'https://www.google.com/' })).status).toBe(204);
    await beacon({ kind: 'view', path: '/', ref: '' });
    await beacon({ kind: 'click', type: 'sponsor_click', url: 'https://acme.example', path: '/' });
    await beacon({ kind: 'view', path: '/' }, 'curl/8.6.0'); // ignored
    await fetch(baseUrl + '/about', { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GPTBot/1.2)' } });
    await fetch(baseUrl + '/llms.txt', { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ChatGPT-User/1.0)' } });
    await fetch(baseUrl + '/robots.txt', { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ChatGPT-User/1.0)' } }); // not a read
    await fetch(baseUrl + '/about', { headers: { 'User-Agent': UA } }); // humans come via beacon only
    await settleRows(5);  // 2 views + 1 click + 2 crawls
    await settle();       // and nothing more

    const unauth = await fetch(baseUrl + '/api/admin/traffic');
    expect(unauth.status).toBe(401);

    const r = await fetch(baseUrl + '/api/admin/traffic?days=7', { headers: { Authorization: `Bearer ${await token()}` } });
    const t = await r.json();
    expect(t.ok).toBe(true);
    expect(t.totals.today).toEqual({ visitors: 1, views: 2 });
    // One person, who came from Google and then moved around the site:
    // one Google visitor; the page views keep both.
    expect(t.sources).toEqual([{ key: 'Google', count: 1 }]);
    expect(t.source_views.map(s => s.key).sort()).toEqual(['Direct', 'Google']);
    expect(t.clicks).toEqual([{ key: 'sponsor_click', count: 1, label: 'Sponsor clicks' }]);
    expect(t.crawlers.sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: 'ChatGPT (answering someone)', count: 1 }, { key: 'GPTBot (AI training)', count: 1 }]);
    expect(t.ai).toMatchObject({ answer_reads: 1, training_crawls: 1, answer_pages: [{ key: '/llms.txt', count: 1 }] });
  });

  // Crawler rows used the real clock while the summary used the injected
  // one, so this suite broke once the real date passed NOW.
  it('stamps crawler rows with the app clock', async () => {
    await startApp(new Date('2031-03-04T17:00:00Z'));
    await fetch(baseUrl + '/llms.txt', { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GPTBot/1.2)' } });
    await settleRows(1);
    const rows = await store.listTraffic('2000-01-01');
    expect(rows.map(r => [r.kind, r.day])).toEqual([['crawl', '2031-03-04']]);
  });

  it('ignores malformed beacons', async () => {
    await startApp();
    const r = await fetch(baseUrl + '/api/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
    expect(r.status).toBe(204);
    await beacon({ kind: 'nope' });
    await settle();
    expect(await store.listTraffic('2026-01-01')).toEqual([]);
  });
});

describe('Meta Pixel script', () => {
  async function pixelApp(metaPixelId) {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-pixel-'));
    const eventsFile = path.join(tmpDir, 'events.json');
    await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
    const { app } = await createApp({
      storeBundle: { kind: 'file', store: new FileStore(path.join(tmpDir, 's.json')) },
      eventsFile, trustProxy: false, now: () => NOW, metaPixelId
    });
    server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    return `http://127.0.0.1:${server.address().port}/pixel.js`;
  }

  it('is an empty script until META_PIXEL_ID is set', async () => {
    const r = await fetch(await pixelApp(''));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/javascript/);
    const js = await r.text();
    expect(js).not.toMatch(/fbq|facebook/);
  });

  it('loads the pixel with the configured ID and skips the admin', async () => {
    const js = await (await fetch(await pixelApp('123456789012345'))).text();
    expect(js).toContain("fbq('init', '123456789012345')");
    expect(js).toContain("fbq('track', 'PageView')");
    expect(js).toContain('vic361_admin_session');
  });

  it('never runs on token pages', async () => {
    const js = await (await fetch(await pixelApp('123456789012345'))).text();
    // ref: a referral code maps to a subscriber, so Meta doesn't get it either.
    expect(js).toContain("/[?&](token|from|cancelled|order|ref)=/.test(location.search)");
    expect(js).toContain("'/subscribe/confirm'");
    expect(js).toContain("'/unsubscribe'");
  });

  it('ignores an ID that is not a number', async () => {
    const js = await (await fetch(await pixelApp("123'); alert(1); ('"))).text();
    expect(js).not.toMatch(/fbq|alert/);
  });
});
