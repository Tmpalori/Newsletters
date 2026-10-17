// @vitest-environment node
//
// Traffic features: search landing pages and list share images.

import { describe, it, expect, afterEach } from 'vitest';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const NOW = new Date('2026-10-09T15:00:00Z'); // Fri Oct 9, 10 AM CDT

const EVENTS = [
  { date: '2026-10-09', name: 'Friday Live Music', time: '8:00 PM', venue: 'Aero Crafters', icons: ['music', 'drinks'] },
  { date: '2026-10-09', name: 'Morning Story Time', time: '10:00 AM', venue: 'Victoria Public Library', icons: ['family'] },
  { date: '2026-10-10', name: 'Zoo Boo', time: '1:00 PM', venue: 'The Texas Zoo', icons: ['family', 'outdoors'] },
  { date: '2026-10-10', name: 'Art After Dark', time: '7:00 PM', venue: 'The Nave Museum', icons: ['arts'] },
  { date: '2026-10-12', name: 'Aero Open Mic', time: '7:00 PM', venue: 'Aero Crafters', icons: ['music'] },
  { date: '2026-10-10', name: 'Texas A&amp;M Night', time: '6:00 PM', venue: '1907 N Ben Jordan St, Victoria, TX', address: '1907 N Ben Jordan St, Victoria, TX', icons: ['family'] },
  { date: '2026-10-10', name: 'Josh Abbott Acoustic', time: '8:00 PM', venue: 'Aero Crafters', url: 'https://www.eventbrite.com/b/tx--victoria/music/', icons: ['music'] },
  { date: '2026-10-10', name: 'Story Strolls', time: '5:30 PM', venue: 'Riverside Park', url: 'https://www.victoriatx.gov/government/departments/parks-recreation', icons: ['outdoors'] },
  { date: '2026-10-10', name: 'Real Ticket Show', time: '9:00 PM', venue: 'Aero Crafters', url: 'https://www.eventbrite.com/e/real-ticket-show-tickets-123', icons: ['music'] }
];
const VENUES = [
  { name: 'Aero Crafters', category: 'Bar / Live Music' },
  { name: 'The Nave Museum', category: 'Museum' }
];

let tmpDir, server, baseUrl;

async function start() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-growth-'));
  const eventsFile = path.join(tmpDir, 'events.json');
  const venuesFile = path.join(tmpDir, 'venues.json');
  await fs.writeFile(eventsFile, JSON.stringify({ events: EVENTS }));
  await fs.writeFile(venuesFile, JSON.stringify(VENUES));
  const { app } = await createApp({
    storeBundle: { kind: 'file', store: new FileStore(path.join(tmpDir, 's.json')) },
    eventsFile, venuesFile, trustProxy: false, now: () => NOW, siteUrl: 'https://www.thevic361.com'
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

const get = async (p) => { const r = await fetch(baseUrl + p); return { r, html: await r.text() }; };

describe('search landing pages', () => {
  it('tonight, date night and weekend-with-kids filter correctly and stay out of the top nav', async () => {
    await start();
    const tonight = (await get('/tonight')).html;
    expect(tonight).toContain('Friday Live Music');
    expect(tonight).not.toContain('Morning Story Time');

    const date = (await get('/date-night')).html;
    expect(date).toContain('Art After Dark');
    expect(date).not.toContain('Zoo Boo');

    const kids = (await get('/this-weekend-with-kids')).html;
    expect(kids).toContain('Zoo Boo');
    expect(kids).not.toContain('Friday Live Music');

    const nav = (await get('/')).html.match(/<nav class="browse-nav"[\s\S]*?<\/nav>/)[0];
    expect(nav).not.toContain('/tonight');
    expect(tonight).toContain('href="/date-night"'); // footer
    expect((await get('/sitemap.xml')).html).toContain('/this-weekend-with-kids');
  });

  it('lists get a share button; link previews use the 1200x630 image, not the portrait slides', async () => {
    await start();
    const wk = (await get('/this-weekend')).html;
    expect(wk).toContain('data-share-url="https://www.thevic361.com/this-weekend"');
    // The social-kit slides are 1080x1350, sit under robots.txt's /social/
    // block and change weekly under one URL, so previews don't use them.
    expect(wk).toContain('<meta property="og:image" content="https://www.thevic361.com/og-image.png">');
    expect(wk).toContain('<meta property="og:image:width" content="1200">');
    expect(wk).not.toContain('/social/latest/');
    const home = (await get('/')).html;
    expect(home).toContain('property="og:image" content="https://www.thevic361.com/og-image.png"');
    expect(home).toContain('<meta property="og:image:height" content="630">');
    expect(home).not.toContain('/social/latest/');
  });
});

describe('event text', () => {
  it('decodes stored HTML entities and does not repeat the address', async () => {
    await start();
    const d = await (await fetch(baseUrl + '/events.json')).json();
    expect(d.events.find(e => e.date === '2026-10-10' && e.name.startsWith('Texas')).name).toBe('Texas A&M Night');
    const html = (await get('/')).html;
    expect(html).not.toContain('&amp;amp;');
    expect(html).toContain('Texas A&amp;M Night');
    const row = html.match(/<span class="event-venue">([^<]*)<\/span>/g).find(s => s.includes('Ben Jordan'));
    expect(row).toBe('<span class="event-venue">1907 N Ben Jordan St</span>');
  });
});

describe('event links', () => {
  it('drops search/category links but keeps real event links', async () => {
    await start();
    const d = await (await fetch(baseUrl + '/events.json')).json();
    expect(d.events.find(e => e.name === 'Josh Abbott Acoustic').url).toBe('');
    expect(d.events.find(e => e.name === 'Real Ticket Show').url).toContain('/e/real-ticket-show');
    expect((await get('/')).html).not.toContain('eventbrite.com/b/');
    expect(d.events.find(e => e.name === 'Story Strolls').url).toBe('https://www.victoriatx.gov/1330/Parks-Recreation');
  });
});

describe('link audit helpers', async () => {
  const { isMismatchedUrl, linkLabel } = await import('../server/seo.js');
  it('flags an event link whose slug names another event', () => {
    expect(isMismatchedUrl('https://www.facebook.com/events/306-w-commercial-st-victoria-tx/nave-volunteer-information-session/1065577712573226/', 'Live Band Karaoke')).toBe(true);
    expect(isMismatchedUrl('https://allevents.in/victoria/walk-to-end-alzheimers/200030364373618', "Walk to End Alzheimer's")).toBe(false);
    expect(isMismatchedUrl('https://www.facebook.com/victoriamainstreet/posts/-music-on-main-street/138', 'Thursday Karaoke')).toBe(false);
    expect(isMismatchedUrl('https://victoriapl.librarycalendar.com/event/adult-program-9240', 'Sourdough Baking')).toBe(false);
  });
  it('labels venue homepages and posts honestly', () => {
    expect(linkLabel('https://palacebingo.org')).toBe('Venue website');
    expect(linkLabel('https://www.weldercenter.org/events')).toBe('Venue website');
    expect(linkLabel('https://www.instagram.com/p/DdtoAzUCJ6L/')).toBe('See the post');
    expect(linkLabel('https://www.facebook.com/VictoriaFarmersMarket')).toBe('Venue page');
    expect(linkLabel('https://allevents.in/victoria/tejas-fest-2026/200030008232138')).toBe('Event details');
  });
});

describe('more landing pages', () => {
  it('free this weekend, nightlife, arts and outdoors filter and are in the sitemap', async () => {
    await start();
    const free = (await get('/free-this-weekend')).html;
    expect(free).toContain('Free things to do in Victoria, TX this weekend');
    const night = (await get('/nightlife')).html;
    expect(night).toContain('Friday Live Music');
    expect(night).not.toContain('Morning Story Time');
    expect((await get('/arts-and-culture')).html).toContain('Art After Dark');
    const out = (await get('/outdoor-events')).html;
    expect(out).toContain('Zoo Boo');
    expect(out).not.toContain('Art After Dark');
    const map = (await get('/sitemap.xml')).html;
    for (const p of ['/free-this-weekend', '/nightlife', '/arts-and-culture', '/outdoor-events']) expect(map).toContain(p);
  });
});

describe('homepage survives odd event names', () => {
  it("doesn't expand $' or $& from event text into the page", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-dollar-'));
    const eventsFile = path.join(tmpDir, 'events.json');
    await fs.writeFile(eventsFile, JSON.stringify({ events: [{ date: '2026-10-09', name: "Ladies$' Night $& more", time: '8:00 PM', venue: 'Bar' }] }));
    const { app } = await createApp({
      storeBundle: { kind: 'file', store: new FileStore(path.join(tmpDir, 's.json')) },
      eventsFile, trustProxy: false, now: () => NOW, siteUrl: 'https://www.thevic361.com'
    });
    server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    const html = (await get('/')).html;
    expect(html.match(/<body/g)).toHaveLength(1);
    expect(html).toContain('Ladies$&#39; Night $&amp; more');
  });
});

describe('spam check (Turnstile) on public forms', () => {
  // good-token passes, other-site was solved on someone else's site, the
  // rest fail.
  const siteverify = async (url, init) => ({
    json: async () => {
      const body = String(init.body);
      if (body.includes('response=other-site')) return { success: true, hostname: 'evil.example' };
      return { success: body.includes('response=good-token') };
    }
  });
  let alerts;
  let notes;
  async function boot() {
    alerts = [];
    notes = [];
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-ts-'));
    const eventsFile = path.join(tmpDir, 'events.json');
    await fs.writeFile(eventsFile, JSON.stringify({ events: EVENTS }));
    const store = new FileStore(path.join(tmpDir, 's.json'));
    const { app } = await createApp({
      storeBundle: { kind: 'file', store }, eventsFile, trustProxy: false, now: () => NOW,
      siteUrl: 'https://www.thevic361.com', turnstileSecret: 'ts-secret', turnstileSiteKey: 'ts-site',
      fetch: siteverify,
      slack: { enabled: true, notify: async (m) => { notes.push(m); return true; }, alert: async (key, title) => { alerts.push({ key, title }); return true; } },
      stripeSecretKey: 'sk_test', stripeWebhookSecret: 'whsec', resendApiKey: '',
      stripe: { createCheckoutSession: async () => ({ id: 'cs_1', url: 'https://checkout.stripe.com/x' }) }
    });
    server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    return store;
  }
  const postForm = (p, fields) => fetch(baseUrl + p, { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });

  // Oct 12: a visitor whose check didn't pass was turned away three times
  // and gave up. Now nobody is stuck on it, and the owner is told.
  it('contact, newsletter and checkout let a visitor through when the check fails, labeled and alerted', async () => {
    const store = await boot();
    const contact = { topic: 'other', name: 'Ann', email: 'ann@example.com', message: 'Hi there' };
    expect(await (await postForm('/contact', contact)).text()).toContain('Message sent');
    expect(notes.some(n => /Website message/.test(n.title) && /bot check didn’t pass/.test(n.title))).toBe(true);
    expect(alerts.some(a => a.key === 'form-bot:contact')).toBe(true);
    notes.length = 0;
    expect(await (await postForm('/contact', { ...contact, 'cf-turnstile-response': 'good-token' })).text()).toContain('Message sent');
    expect(notes.some(n => /Website message/.test(n.title) && !/bot check/.test(n.title))).toBe(true);

    // A token that fails gets the confirmation email instead of a refusal:
    // not on the list until they tap Confirm.
    const sub = (t, email) => fetch(baseUrl + '/api/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, turnstile_token: t }) });
    const bad = await sub('bad', 'c@example.com');
    expect(bad.status).toBe(200);
    expect((await store.countSubscribers()).active).toBe(0);
    expect((await sub('good-token', 'b@example.com')).status).toBe(200);
    expect((await store.countSubscribers()).active).toBe(1);

    const order = { package: 'weekly', week: '2026-10-19', business: 'Acme', text: 'x', url: 'acme.example', email: 'a@acme.example', agree: '1' };
    const paid = await postForm('/advertise/checkout', order);
    expect(paid.status).toBe(303);
    expect(paid.headers.get('location')).toBe('https://checkout.stripe.com/x');
    expect(alerts.some(a => a.key === 'form-bot:checkout')).toBe(true);
  });

  it('a token solved on another site is still refused, without an alert', async () => {
    await boot();
    const contact = { topic: 'other', name: 'Ann', email: 'ann@example.com', message: 'Hi there', 'cf-turnstile-response': 'other-site' };
    const r = await postForm('/contact', contact);
    expect(r.status).toBe(400);
    expect(await r.text()).toContain('reload the page');
    expect(alerts.some(a => a.key.startsWith('form-bot'))).toBe(false);
  });

  it('pages load the spam-check script and mark the forms', async () => {
    await boot();
    const html = (await get('/contact')).html;
    expect(html).toContain('<script src="/turnstile.js" defer></script>');
    expect(html).toContain('action="/contact" data-turnstile');
  });
});
