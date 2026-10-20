// @vitest-environment node
//
// Resend newsletter (server/newsletter.js). Resend is replaced with a
// recording fake; nothing is emailed.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createApp } from '../server/index.js';
import { FileStore, } from '../server/db.js';
import { withPages } from '../server/seo.js';
import { renderWeekly, renderWelcomeEmail, normalizeEmail, signupSource, renderSubscribePage, darkSafe, createResend, referralFlags, renderConfirmEmail, inboxKey } from '../server/newsletter.js';
import { createReferralRewards, createTremendous, tremendousConfig, drawingMonth } from '../server/referralRewards.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const NOW = new Date('2026-10-05T13:00:00Z'); // Monday Oct 5, 8 AM CDT

const EVENTS = [
  { date: '2026-10-09', name: 'Friday <Live> Music', time: '8:00 PM', venue: 'Aero Crafters', icons: ['music'] },
  { date: '2026-10-10', name: 'Farmers Market', time: '8:00 AM', venue: 'Market Square', free: true, featured: true },
  { date: '2026-10-03', name: 'Last Week', time: '7 PM' }
];

let tmpDir, server, baseUrl, store, sent, nlApi;
// Production has Turnstile on, so by default these tests do too, with a
// Cloudflare that passes every token and a token on every signup. Without
// it every signup would confirm by email. A test that sets its own
// turnstileSecret posts exactly what it says.
const TURNSTILE_PASS = async () => ({ ok: true, json: async () => ({ success: true }) });
let autoToken = false;

// Each app gets its own outbox: a welcome email the previous test's app sends
// late (after its response) must not land in the next test's `sent`.
function fakeResend() {
  const box = { single: [], batches: [] };
  sent = box;
  return {
    send: async (msg) => { box.single.push(msg); return { id: 'e1' }; },
    batch: async (msgs, key) => { box.batches.push({ msgs, key }); return { data: msgs.map((_, i) => ({ id: `b${i}` })) }; }
  };
}

async function startApp(extra = {}) {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-nl-'));
  const eventsFile = path.join(tmpDir, 'events.json');
  await fs.writeFile(eventsFile, JSON.stringify({ events: EVENTS, sponsor: { name: 'Acme Tacos', text: 'Best tacos.', cta: 'Order', url: 'https://acme.example' } }));
  store = new FileStore(path.join(tmpDir, 's.json'));
  autoToken = !('turnstileSecret' in extra);
  const made = await createApp({
    ...(autoToken ? { turnstileSecret: 'fake-secret', fetch: TURNSTILE_PASS } : {}),
    storeBundle: { kind: 'file', store }, eventsFile, trustProxy: false, now: () => NOW,
    siteUrl: 'https://www.thevic361.com', adminUsername: 'a', adminPassword: 'b', adminSessionSecret: 'c',
    resendApiKey: 're_test', newsletterAddress: '123 Main St, Victoria, TX 77901',
    newsletterCronSecret: 'cron-secret', ...(extra.resend ? {} : { resend: fakeResend() }), ...extra
  });
  const { app } = made;
  nlApi = made.newsletter;
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

afterEach(async () => {
  if (server) await new Promise(r => server.close(r));
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  server = null; tmpDir = null;
});

const post = (p, body, headers = {}) => fetch(baseUrl + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(autoToken && p === '/api/subscribe' && body && !('turnstile_token' in body) ? { ...body, turnstile_token: 'ok' } : (body || {}))
});
async function auth() {
  const r = await post('/api/admin/login', { username: 'a', password: 'b' });
  return { Authorization: `Bearer ${(await r.json()).token}` };
}

describe('newsletter content', () => {
  it('renders the rest of the week, featured first, escaped, with unsubscribe and address', () => {
    const issue = renderWeekly(withPages(EVENTS), {
      siteUrl: 'https://www.thevic361.com', now: NOW, sponsor: null,
      unsubscribeUrl: 'https://www.thevic361.com/unsubscribe?token=t', address: '123 Main St'
    });
    expect(issue.total).toBe(2);
    expect(issue.subject).toBe('This week in Victoria: 2 things to do (Oct 5–Oct 11)');
    expect(issue.html).toContain('Friday &lt;Live&gt; Music');
    expect(issue.html).not.toContain('Last Week');
    expect(issue.html).toContain('https://www.thevic361.com/events/2026-10-09-friday-live-music');
    expect(issue.html).toContain('unsubscribe?token=t');
    expect(issue.html).toContain('123 Main St');
    expect(issue.text).toContain('Unsubscribe: https://www.thevic361.com/unsubscribe?token=t');
  });

  it('puts the weekly sponsor at the top, in both the HTML and the text part', () => {
    const sponsor = { name: 'Acme Tacos', text: 'Best tacos.', cta: 'Order', url: 'https://acme.example', week: '2026-10-05' };
    const issue = renderWeekly(withPages(EVENTS), {
      siteUrl: 'https://www.thevic361.com', now: NOW, sponsor, unsubscribeUrl: 'https://www.thevic361.com/unsubscribe?token=t', address: 'a'
    });
    const sponsorAt = issue.html.indexOf("THIS WEEK'S SPONSOR");
    const firstDay = issue.html.indexOf('font-size:21px'); // the first day's heading
    expect(sponsorAt).toBeGreaterThan(-1);
    expect(sponsorAt).toBeLessThan(firstDay);
    // A paid order's button is counted through /go/s/<week>, then sent on.
    expect(issue.html).toContain('href="https://www.thevic361.com/go/s/2026-10-05?src=newsletter"');
    expect(issue.html).not.toContain('href="https://acme.example"');
    const lines = issue.text.split('\n');
    expect(lines[2]).toBe("THIS WEEK'S SPONSOR: Acme Tacos - Best tacos. - https://www.thevic361.com/go/s/2026-10-05?src=newsletter");
    // A hand-set sponsor (no order) links straight to its site.
    const manual = renderWeekly(withPages(EVENTS), { siteUrl: 'https://www.thevic361.com', now: NOW, sponsor: { ...sponsor, week: undefined }, unsubscribeUrl: 'u', address: 'a' });
    expect(manual.html).toContain('href="https://acme.example"');
  });

  it('tags links back to the site for the Traffic tab, but not unsubscribe or images', () => {
    const issue = renderWeekly(withPages(EVENTS), {
      siteUrl: 'https://www.thevic361.com', now: NOW, sponsor: null,
      unsubscribeUrl: 'https://www.thevic361.com/unsubscribe?token=t', address: 'a'
    });
    const tag = 'utm_source=newsletter&amp;utm_medium=email&amp;utm_campaign=weekly-2026-10-05';
    expect(issue.html).toContain(`https://www.thevic361.com/events/2026-10-09-friday-live-music?${tag}`);
    expect(issue.html).toContain(`https://www.thevic361.com/this-weekend?${tag}`);
    expect(issue.html).toContain('href="https://www.thevic361.com/unsubscribe?token=t"');
    expect(issue.html).toContain('src="https://www.thevic361.com/email/skyline.png"');
    expect(issue.text).toContain('https://www.thevic361.com/events/2026-10-09-friday-live-music?utm_source=newsletter&utm_medium=email&utm_campaign=weekly-2026-10-05');
    expect(issue.text).toContain('Unsubscribe: https://www.thevic361.com/unsubscribe?token=t\n');
    const welcome = renderWelcomeEmail(withPages(EVENTS), { siteUrl: 'https://www.thevic361.com', now: NOW, sponsor: null, unsubscribeUrl: 'https://www.thevic361.com/unsubscribe?token=t', address: 'a' });
    expect(welcome.html).toContain('utm_campaign=welcome');
    expect(welcome.html).toContain('href="https://www.thevic361.com/unsubscribe?token=t"');
  });

  it('says "1 thing" and a single date for a one-day, one-event week, and pads the preheader', () => {
    const sunday = new Date('2026-10-11T15:00:00Z');
    const issue = renderWeekly(withPages([{ date: '2026-10-11', name: 'Sunday Brunch', time: '11 AM' }]), {
      siteUrl: 'https://www.thevic361.com', now: sunday, sponsor: null, unsubscribeUrl: 'u', address: 'a'
    });
    expect(issue.subject).toBe('This week in Victoria: 1 thing to do (Oct 11)');
    expect(issue.html).toContain('<strong>1 event</strong>');
    expect(issue.html).toMatch(/Sunday Brunch(&#847;&zwnj;&nbsp;){80}<\/span>/);
  });

  it('normalizes emails', () => {
    expect(normalizeEmail('  Me@Example.COM ')).toBe('me@example.com');
    expect(normalizeEmail('nope')).toBeNull();
    expect(normalizeEmail('a@b.co"><script>')).toBeNull();
  });

  it('rejects addresses Resend would refuse (dots in the wrong place, bad domain labels)', () => {
    for (const bad of ['bob@gmail..com', '.bob@gmail.com', 'bob.@gmail.com', 'a..b@gmail.com', 'bob@.gmail.com',
      'bob@gmail.com.', 'bob@-gmail.com', 'bob@gmail-.com', 'bob@gmail.c', 'bob@gm_ail.com', 'bob@gmail.123',
      'josé@gmail.com', 'bob\u00a0smith@gmail.com', 'bob\u2019s@gmail.com']) {
      expect(normalizeEmail(bad), bad).toBeNull();
    }
    for (const good of ['first.last+tag@sub.example.co.uk', 'a_b-c@my-site.example', 'x@xn--bcher-kva.example']) {
      expect(normalizeEmail(good), good).toBe(good);
    }
    // A zero-width space or BOM pasted in with the address is dropped, not refused.
    expect(normalizeEmail('\ufeffbob\u200b@gmail.com')).toBe('bob@gmail.com');
    // So is a dash autocorrect put in place of a hyphen.
    expect(normalizeEmail('alma\u2011mc@hotmail.com')).toBe('alma-mc@hotmail.com');
    expect(normalizeEmail('alma\u2013mc@hotmail.com')).toBe('alma-mc@hotmail.com');
  });
});

describe('review fixes: signups and privacy', () => {
  it('answers the same for new, pending and already-subscribed addresses', async () => {
    await startApp({ resendApiKey: '' });
    const first = await (await post('/api/subscribe', { email: 'a@example.com', source: 'footer' })).json();
    const again = await (await post('/api/subscribe', { email: 'a@example.com' })).json();
    expect(again).toEqual(first);
    expect(JSON.stringify(again)).not.toMatch(/already/i);
    const bot = await (await post('/api/subscribe', { email: 'b@example.com', company: 'spam' })).json();
    expect(bot).toEqual({ ok: true });
  });

  it('with Resend on, too: new, pending and active get one answer', async () => {
    await startApp();
    const fresh = await (await post('/api/subscribe', { email: 'n@example.com' })).json();
    const pending = await (await post('/api/subscribe', { email: 'n@example.com' })).json();
    await store.importSubscribers(['on@example.com'], 'import');
    const active = await (await post('/api/subscribe', { email: 'on@example.com' })).json();
    expect(pending).toEqual(fresh);
    expect(active).toEqual(fresh);
  });

  it('the forms count a Lead once per browser, not from the server\'s answer', async () => {
    await startApp();
    const html = await (await fetch(baseUrl + '/subscribe')).text();
    expect(html).toContain("was=localStorage.getItem('vic361-subscribed')==='1'");
    expect(html).not.toContain('x.j.new');
    const app = await fs.readFile(path.join(process.cwd(), 'docs/app.js'), 'utf8');
    expect(app).not.toContain('x.j.new');
  });

  it('a comeback keeps its new source', async () => {
    await startApp();
    await post('/api/subscribe', { email: 'p@example.com', source: 'footer' });
    const sub = (await store.listSubscribers({ status: 'active' }))[0];
    await store.unsubscribe(sub.token);
    await post('/api/subscribe', { email: 'p@example.com', source: 'subscribe-page:ad' });
    expect((await store.listSubscribers({ status: 'pending' }))[0].source).toBe('subscribe-page:ad');
  });

  it('sends a comeback at most 3 confirmation emails a day', async () => {
    await startApp();
    await store.importSubscribers(['flood@example.com'], 'import');
    await store.unsubscribe((await store.listSubscribers({ status: 'active' }))[0].token);
    for (let i = 0; i < 5; i++) expect((await post('/api/subscribe', { email: 'flood@example.com' })).status).toBe(200);
    expect(sent.single.filter(m => m.to[0] === 'flood@example.com')).toHaveLength(3);
  });

  it('a confirmation email that fails alerts the owner in Slack', async () => {
    const alerts = [];
    const resend = { send: async () => { throw new Error('Resend HTTP 401: bad key'); }, batch: async () => ({}) };
    await startApp({ resend, slack: { enabled: true, notify: async () => true, alert: async (key, title) => { alerts.push({ key, title }); } } });
    await store.importSubscribers(['x@example.com'], 'import');
    await store.unsubscribe((await store.listSubscribers({ status: 'active' }))[0].token);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Same answer as any other signup (a 500 here would tell anyone the
      // address had unsubscribed); the owner hears about it instead.
      const r = await post('/api/subscribe', { email: 'x@example.com' });
      expect(r.status).toBe(200);
      expect((await r.json()).message).toBe("You're on the list! Check your inbox.");
      expect(alerts).toEqual([{ key: 'newsletter-confirm-failed', title: 'Newsletter confirmation emails are failing' }]);
    } finally { err.mockRestore(); }
  });

  it('a welcome email that fails keeps the signup and alerts the owner in Slack', async () => {
    const alerts = [];
    const resend = { send: async () => { throw new Error('Resend HTTP 401: bad key'); }, batch: async () => ({}) };
    await startApp({ resend, slack: { enabled: true, notify: async () => true, alert: async (key, title) => { alerts.push({ key, title }); } } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await post('/api/subscribe', { email: 'x@example.com' })).status).toBe(200);
      expect((await store.countSubscribers()).active).toBe(1);
      await vi.waitFor(() => expect(alerts).toEqual([{ key: 'newsletter-welcome-failed', title: 'Newsletter welcome emails are failing' }]), { timeout: 2000 });
    } finally {
      warn.mockRestore();
    }
  });

  it('pages reached by token links never load the Meta Pixel', async () => {
    await startApp();
    await post('/api/subscribe', { email: 't@example.com' });
    const sub = (await store.listSubscribers({ status: 'active' }))[0];
    const confirm = await (await fetch(`${baseUrl}/subscribe/confirm?token=${sub.token}`)).text();
    const unsub = await (await fetch(`${baseUrl}/unsubscribe?token=${sub.token}`)).text();
    expect(confirm).not.toContain('/pixel.js');
    expect(unsub).not.toContain('/pixel.js');
    expect(await (await fetch(baseUrl + '/subscribe')).text()).toContain('/pixel.js');
  });

  it('/subscribe gets the seasonal tabs and shows the day on each pick', async () => {
    await startApp();
    const html = await (await fetch(baseUrl + '/subscribe')).text();
    expect(html).not.toContain('SEASONAL_NAV');
    expect(html).toMatch(/event-time">Fri · 8:00 PM</);
    expect(html).toMatch(/event-time">Sat · 8:00 AM</);
  });

  it('has a privacy page linked from every footer', async () => {
    await startApp();
    const r = await fetch(baseUrl + '/privacy');
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('Meta Pixel');
    expect(html).toContain('Google Analytics');
    for (const p of ['/', '/about']) expect(await (await fetch(baseUrl + p)).text()).toContain('href="/privacy"');
  });
});

describe('dark mode', () => {
  it('paints backgrounds as images and tags colors so Outlook can be put back', () => {
    const out = darkSafe('<html><head></head><body style="margin:0;background:#FFF4D6;">' +
      '<td class="x" style="background:#3DBE8B;padding:4px;color:#1F1A3D;">a</td>' +
      '<a href="#" style="color:#4B3FD1;">b</a><span style="font-weight:bold">c</span></body></html>');
    expect(out).toContain('<body class="b-fff4d6" bgcolor="#FFF4D6" style="margin:0;background-color:#FFF4D6;background-image:linear-gradient(#FFF4D6,#FFF4D6);">');
    expect(out).toContain('<td class="x b-3dbe8b t-1f1a3d" bgcolor="#3DBE8B" style="background-color:#3DBE8B;background-image:linear-gradient(#3DBE8B,#3DBE8B);padding:4px;color:#1F1A3D;">');
    expect(out).toContain('<a href="#" class="t-4b3fd1" style="color:#4B3FD1;">');
    expect(out).toContain('<span style="font-weight:bold">c</span>');
    expect(out).toContain('[data-ogsb].b-3dbe8b,[data-ogsb] .b-3dbe8b{background-color:#3dbe8b !important');
    expect(out).toContain('[data-ogsc].t-4b3fd1,[data-ogsc] .t-4b3fd1{color:#4b3fd1 !important}');
    expect(out).toContain(':root{color-scheme:light only;supported-color-schemes:light only}');
  });

  it('every email ships the light-only signals and no bare background colors', () => {
    const issue = renderWeekly(withPages(EVENTS), {
      siteUrl: 'https://www.thevic361.com', now: NOW, sponsor: { name: 'Acme', text: 'x', cta: 'Go', url: 'https://a.example' },
      unsubscribeUrl: 'u', address: 'a'
    });
    expect(issue.html).toContain('<meta name="supported-color-schemes" content="light only">');
    expect(issue.html).toContain('[data-ogsb]');
    expect(issue.html).not.toMatch(/style="[^"]*(^|;)background:#/i);
    const welcome = renderWelcomeEmail(withPages(EVENTS), { siteUrl: 'https://www.thevic361.com', now: NOW, sponsor: null, unsubscribeUrl: 'u', address: 'a' });
    expect(welcome.html).toContain('linear-gradient(#FFF4D6,#FFF4D6)');
  });
});

describe('welcome email', () => {
  it('lists the coming week in time order (picks always in) and escapes event names', () => {
    const mail = renderWelcomeEmail(withPages(EVENTS), { siteUrl: 'https://www.thevic361.com', now: NOW, sponsor: null,
      unsubscribeUrl: 'https://www.thevic361.com/unsubscribe?token=t', address: 'PO Box 1, Victoria, TX' });
    expect(mail.subject).toBe('Welcome to The Vic 361');
    expect(mail.html.indexOf('Friday &lt;Live&gt; Music')).toBeLessThan(mail.html.indexOf('Farmers Market'));
    expect(mail.html).not.toContain('<Live>');
    expect(mail.html).not.toContain('Last Week'); // already past
    expect(mail.text).toContain('Saturday 8:00 AM: Farmers Market');
    expect(mail.text).toContain('Unsubscribe: https://www.thevic361.com/unsubscribe?token=t');
  });
});

describe('signup flow', () => {
  it('single opt-in: a new address is active at once and gets one welcome email', async () => {
    const pings = [];
    await startApp({ slack: { enabled: true, notify: async (m) => { pings.push(m); return true; }, alert: async () => {} } });
    expect((await post('/api/subscribe', { email: 'bad' })).status).toBe(400);
    const r = await post('/api/subscribe', { email: 'New@Example.com' });
    expect(r.status).toBe(200);
    expect((await r.json()).message).toBe("You're on the list! Check your inbox.");
    expect((await store.countSubscribers()).active).toBe(1);
    await vi.waitFor(() => {
      expect(sent.single.some(m => m.subject === 'Welcome to The Vic 361')).toBe(true);
    }, { timeout: 2000 });
    // Signing up again while active sends nothing more.
    await post('/api/subscribe', { email: 'new@example.com' });
    await new Promise(r => setTimeout(r, 50)); // room for a wrong second one
    expect(sent.single).toHaveLength(1);
    const [welcome] = sent.single;
    expect(welcome.subject).toBe('Welcome to The Vic 361');
    expect(welcome.to).toEqual(['new@example.com']);
    expect(welcome.headers['List-Unsubscribe']).toContain('/unsubscribe?token=');
    expect(welcome.html).toContain('Farmers Market');
    expect(welcome.html).toContain('Acme Tacos');
    expect(welcome.html).toContain('123 Main St, Victoria, TX 77901');
    expect(pings.filter(p => p.channel === 'hype')).toHaveLength(0);
  });

  it('a signup alone never pings Slack: HQ posts every 10 across all newsletters', async () => {
    const pings = [];
    await startApp({ slack: { enabled: true, notify: async (m) => { pings.push(m); return true; }, alert: async () => {} } });
    for (let i = 1; i <= 10; i++) await post('/api/subscribe', { email: `fan${i}@example.com` });
    await new Promise(r => setTimeout(r, 50));
    expect(pings.filter(p => p.channel === 'hype')).toHaveLength(0);
  });

  it('a comeback must confirm from its own inbox: confirmation email, GET shows a button, POST activates', async () => {
    await startApp();
    await store.importSubscribers(['fan@example.com'], 'import');
    await store.unsubscribe((await store.listSubscribers({ status: 'active' }))[0].token);
    const r = await post('/api/subscribe', { email: 'Fan@Example.com' });
    expect(r.status).toBe(200);
    expect(sent.single).toHaveLength(1);
    expect(sent.single[0].to).toEqual(['fan@example.com']);
    expect(sent.single[0].subject).toBe('Confirm your Vic 361 subscription');
    const link = sent.single[0].html.match(/https:\/\/www\.thevic361\.com\/subscribe\/confirm\?token=([^"&]+)/);
    expect(link).toBeTruthy();
    expect((await store.countSubscribers()).pending).toBe(1);

    // Opening the link (or a mail scanner opening it) only shows a button.
    const g = await fetch(`${baseUrl}/subscribe/confirm?token=${link[1]}`);
    expect(g.status).toBe(200);
    const page = await g.text();
    expect(page).toContain(`<form method="post" action="/subscribe/confirm?token=${link[1]}">`);
    expect(page).toContain('Confirm my subscription');
    expect((await store.countSubscribers()).active).toBe(0);
    expect(sent.single).toHaveLength(1);

    const c = await fetch(`${baseUrl}/subscribe/confirm?token=${link[1]}`, { method: 'POST' });
    expect(c.status).toBe(200);
    expect(await c.text()).toContain('You&#39;re subscribed');
    expect((await store.countSubscribers()).active).toBe(1);
    await fetch(`${baseUrl}/subscribe/confirm?token=${link[1]}`, { method: 'POST' }); // second click
    // Opening the link again after confirming just says so.
    expect(await (await fetch(`${baseUrl}/subscribe/confirm?token=${link[1]}`)).text()).toContain('You&#39;re subscribed');
    expect((await fetch(`${baseUrl}/subscribe/confirm?token=nope`)).status).toBe(404);
    // The welcome email goes out after the page, once.
    await vi.waitFor(() => expect(sent.single).toHaveLength(2), { timeout: 2000 });
    await new Promise(r => setTimeout(r, 50));
    expect(sent.single.filter(m => m.subject === 'Welcome to The Vic 361')).toHaveLength(1);
  });

  it('a signup left pending under the old double opt-in is activated when they sign up again', async () => {
    await startApp();
    await store.addSubscriber({ email: 'old@example.com', source: 'footer' }); // pending, as before this change
    expect((await post('/api/subscribe', { email: 'old@example.com' })).status).toBe(200);
    expect((await store.countSubscribers()).active).toBe(1);
    await vi.waitFor(() => expect(sent.single.map(m => m.subject)).toEqual(['Welcome to The Vic 361']), { timeout: 2000 });
  });

  it('holds the welcome email when no mailing address is set', async () => {
    await startApp({ newsletterAddress: '' });
    await post('/api/subscribe', { email: 'new@example.com' });
    await new Promise(r => setTimeout(r, 50)); // checks an email is NOT sent, so a fixed wait
    expect((await store.countSubscribers()).active).toBe(1);
    expect(sent.single).toHaveLength(0);
  });

  it('honeypot submissions are dropped silently', async () => {
    await startApp();
    expect((await post('/api/subscribe', { email: 'bot@example.com', company: 'x' })).status).toBe(200);
    expect(sent.single).toHaveLength(0);
    expect((await store.countSubscribers()).pending).toBe(0);
  });

  it('unsubscribe: GET shows a button, POST removes', async () => {
    await startApp();
    await store.importSubscribers(['fan@example.com'], 'import');
    const [sub] = await store.listSubscribers({ status: 'active' });
    const g = await fetch(`${baseUrl}/unsubscribe?token=${sub.token}`);
    const html = await g.text();
    expect(html).toContain('<form method="post"');
    // Names whose subscription it is (masked), for readers of a forwarded copy.
    expect(html).toContain('f•••@example.com');
    expect(html).not.toContain('fan@example.com');
    expect(html).toContain('This email was forwarded to you');
    expect((await store.countSubscribers()).active).toBe(1);
    const p = await fetch(`${baseUrl}/unsubscribe?token=${sub.token}`, { method: 'POST' });
    expect(p.status).toBe(200);
    expect((await store.countSubscribers()).unsubscribed).toBe(1);
    // An unsubscribed address isn't re-added by an import.
    const res = await store.importSubscribers(['fan@example.com'], 'import');
    expect(res.skipped_unsubscribed).toBe(1);
  });

  it('homepage always shows our form; without Resend, signups are saved directly', async () => {
    await startApp({ resendApiKey: '' });
    const html = await (await fetch(baseUrl + '/')).text();
    expect(html).toContain('id="signup-form"');
    expect(html).not.toContain('beehiiv');
    const r = await post('/api/subscribe', { email: 'x@example.com' });
    expect(r.status).toBe(200);
    expect((await r.json()).message).toContain('on the list');
    expect(sent.single).toHaveLength(0);
    expect((await store.countSubscribers()).active).toBe(1);
  });
});

describe('rejected signups are logged with their reason', () => {
  it('a bad email and a failed bot check each log why, never the address', async () => {
    const fakeFetch = async () => ({ ok: true, json: async () => ({ success: false, 'error-codes': ['timeout-or-duplicate'] }) });
    await startApp({ turnstileSecret: 'fake-secret', fetch: fakeFetch });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await post('/api/subscribe', { email: 'bad' })).status).toBe(400);
      // Not refused (a token can expire while they type): it gets the
      // confirmation email instead, and the reason is still logged.
      expect((await post('/api/subscribe', { email: 'fan@example.com', turnstile_token: 't' },
        { 'User-Agent': 'Mozilla/5.0 (iPhone) [FBAN/FBIOS;FBAV/581.0]' })).status).toBe(200);
      const lines = warn.mock.calls.map(c => c.join(' '));
      expect(lines).toContain('[newsletter] signup rejected: invalid email');
      expect(lines).toContain('[turnstile] rejected: /api/subscribe verification-failed timeout-or-duplicate in-app: facebook');
      expect(lines.join('\n')).not.toContain('fan@example.com');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('signup page', () => {
  it('/subscribe has the pitch, a form tagged subscribe-page, and the next week of events', async () => {
    await startApp();
    const r = await fetch(baseUrl + '/subscribe');
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('in your inbox every Monday');
    expect(html).toContain('id="signup-form"');
    expect(html).toContain('data-source="subscribe-page"');
    expect(html).toContain('Subscribe free');
    // Proof: upcoming events in date order with their day, last week's left out.
    expect(html).toContain('2 things to do in Victoria in the next seven days');
    expect(html.indexOf('Friday &lt;Live&gt; Music')).toBeLessThan(html.indexOf('Farmers Market'));
    expect(html).not.toContain('Last Week');
    expect(html).toContain('<link rel="canonical" href="https://www.thevic361.com/subscribe">');
    expect(html).not.toContain('noindex');
    expect(html).not.toContain('Victoria locals who already get it'); // no count until there's a crowd
  });

  it('shows the subscriber count only once it is a real crowd', () => {
    const page = n => renderSubscribePage([], { siteUrl: 'https://x', now: NOW, subscriberCount: n });
    expect(page(99)).not.toContain('locals who already get it');
    expect(page(137)).toContain('Join 130+ Victoria locals');
  });

  it('on the signup page the form is up top and Subscribe jumps to it instead of reloading', async () => {
    const html = renderSubscribePage([], { siteUrl: 'https://x', now: NOW });
    // Above the fold on a phone: right under the headline.
    expect(html.indexOf('id="signup-email"')).toBeLessThan(html.indexOf('class="page-lead"'));
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM(`<header><a href="/subscribe">Subscribe</a></header>${html}`, { runScripts: 'dangerously' });
    const { document } = dom.window;
    const input = document.getElementById('signup-email');
    input.scrollIntoView = () => {};
    const link = document.querySelector('header a[href="/subscribe"]');
    const click = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  it('every Subscribe button on the site points at /subscribe', async () => {
    await startApp();
    for (const p of ['/', '/this-weekend', '/about']) {
      const html = await (await fetch(baseUrl + p)).text();
      expect(html).toContain('href="/subscribe"');
      expect(html).not.toContain('href="/#subscribe"');
      expect(html).not.toContain('href="#subscribe"');
    }
    expect(await (await fetch(baseUrl + '/sitemap.xml')).text()).toContain('<loc>https://www.thevic361.com/subscribe</loc>');
  });

  it('records where a signup came from, ad visits included', async () => {
    expect(signupSource('subscribe-page')).toBe('subscribe-page');
    expect(signupSource('list-card:ad')).toBe('list-card:ad');
    expect(signupSource('footer:bogus')).toBe('footer');
    expect(signupSource('<script>')).toBe('site');
    expect(signupSource(undefined)).toBe('site');
    await startApp({ resendApiKey: '' });
    await post('/api/subscribe', { email: 'ad@example.com', source: 'subscribe-page:ad' });
    await post('/api/subscribe', { email: 'old@example.com' });
    const subs = await store.listSubscribers({ status: 'active' });
    expect(Object.fromEntries(subs.map(x => [x.email, x.source]))).toEqual({
      'ad@example.com': 'subscribe-page:ad', 'old@example.com': 'site'
    });
  });

  it('newsletter footer invites forwarded readers to subscribe', () => {
    const issue = renderWeekly(withPages(EVENTS), {
      siteUrl: 'https://www.thevic361.com', now: NOW, sponsor: null, unsubscribeUrl: 'u', address: 'a'
    });
    expect(issue.html).toContain('Forwarded this? <a href="https://www.thevic361.com/subscribe?utm_source=newsletter');
  });
});

describe('signups where the bot check never loaded', () => {
  const pass = async () => ({ ok: true, json: async () => ({ success: true }) });
  const fail = async () => ({ ok: true, json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }) });

  it('no token: not refused, but confirmed by email before they are on the list', async () => {
    await startApp({ turnstileSecret: 'fake-secret', fetch: pass });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await post('/api/subscribe', { email: 'iab@example.com' });
      expect(r.status).toBe(200);
      expect((await r.json()).message).toBe('Almost there! Check your inbox and tap Confirm to start getting it.');
      expect((await store.countSubscribers()).pending).toBe(1);
      expect(sent.single.map(m => m.subject)).toEqual(['Confirm your Vic 361 subscription']);
      // Same answer for an address already on the list (no way to probe who's subscribed).
      await store.importSubscribers(['on@example.com'], 'import');
      expect((await (await post('/api/subscribe', { email: 'on@example.com' })).json()).message)
        .toBe('Almost there! Check your inbox and tap Confirm to start getting it.');
    } finally { warn.mockRestore(); }
  });

  it('a token that fails gets the confirmation email, not a dead end; a good one signs up straight away', async () => {
    await startApp({ turnstileSecret: 'fake-secret', fetch: fail });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await post('/api/subscribe', { email: 'expired@example.com', turnstile_token: 'x' });
      expect(r.status).toBe(200);
      expect((await r.json()).message).toBe('Almost there! Check your inbox and tap Confirm to start getting it.');
      // Not on the list until they tap Confirm, so a bot gains nothing.
      expect((await store.countSubscribers()).active || 0).toBe(0);
    } finally { warn.mockRestore(); }
    if (server) await new Promise(r => server.close(r));
    await startApp({ turnstileSecret: 'fake-secret', fetch: pass });
    const r = await post('/api/subscribe', { email: 'real@example.com', turnstile_token: 'ok' });
    expect((await r.json()).message).toBe("You're on the list! Check your inbox.");
    expect((await store.countSubscribers()).active).toBe(1);
  });

  it('only a signup that joins right away may count as a Meta Lead', async () => {
    await startApp({ turnstileSecret: 'fake-secret', fetch: pass });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const lead = async (body) => (await (await post('/api/subscribe', body)).json()).lead;
      expect(await lead({ email: 'real@example.com', turnstile_token: 'ok' })).toBe(true);
      // The same for an address already on the list: it says nothing of who's subscribed.
      expect(await lead({ email: 'real@example.com', turnstile_token: 'ok' })).toBe(true);
      // Waiting on a Confirm tap (no bot check, or a referral code) or a honeypot hit: no Lead.
      expect(await lead({ email: 'iab@example.com' })).toBeUndefined();
      expect(await lead({ email: 'friend@example.com', turnstile_token: 'ok', ref: 'abcdefg' })).toBeUndefined();
      expect(await lead({ email: 'bot@example.com', turnstile_token: 'ok', hp_field: 'spam' })).toBeUndefined();
    } finally { warn.mockRestore(); }
  });

  it('after a signup the form shows only the confirmation (no empty-form second tap)', async () => {
    await startApp();
    const html = await (await fetch(baseUrl + '/subscribe')).text();
    expect(html).toContain("f.classList.add('is-done')");
    const app = await fs.readFile(path.join(process.cwd(), 'docs/app.js'), 'utf8');
    expect(app).toContain("form.classList.add('is-done')");
    const css = await fs.readFile(path.join(process.cwd(), 'docs/style.css'), 'utf8');
    expect(css).toContain('.signup-form.is-done input, .signup-form.is-done button { display: none; }');
  });
});

describe('referral program', () => {
  // Backdate a subscriber's signup, past the 24-hour hold.
  async function age(email, hours = 25) {
    await store._withWrite(async () => {
      const data = await store._read();
      const sub = data.subscribers.find(x => x.email === email);
      sub.confirmed_at = new Date(Date.now() - hours * 3600e3).toISOString();
      await store._write(data);
    });
  }
  const codeOf = async (email) => (await store._read()).subscribers.find(x => x.email === email).ref_code;
  const subOf = async (email) => (await store._read()).subscribers.find(x => x.email === email);
  // A referred friend taps Confirm in their email before they're on the list.
  const confirmFriend = async (email) => {
    const r = await fetch(`${baseUrl}/subscribe/confirm?token=${(await subOf(email)).token}`, { method: 'POST' });
    expect(r.status).toBe(200);
  };

  it('/r/<code> sends people to the signup page with the code; a bad code just goes to signup', async () => {
    await startApp();
    const r = await fetch(`${baseUrl}/r/abc2345`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/subscribe?ref=abc2345');
    const bad = await fetch(`${baseUrl}/r/<script>`, { redirect: 'manual' });
    expect(bad.headers.get('location')).toBe('/subscribe');
    expect(await (await fetch(`${baseUrl}/subscribe?ref=abc2345`)).text()).toContain('A friend invited you');
    expect(await (await fetch(`${baseUrl}/subscribe`)).text()).not.toContain('A friend invited you');
  });

  it('the welcome email carries the new subscriber\'s own share link and the reward tiers', async () => {
    await startApp();
    await post('/api/subscribe', { email: 'fan@example.com' });
    await vi.waitFor(() => expect(sent.single).toHaveLength(1), { timeout: 2000 });
    const code = await codeOf('fan@example.com');
    expect(code).toMatch(/^[a-z2-9]{7}$/);
    const [w] = sent.single;
    expect(w.html).toContain(`https://www.thevic361.com/r/${code}`);
    expect(w.html).not.toContain(`/r/${code}?utm_`);
    expect(w.html).toContain('Share The Vic 361');
    expect(w.html).toContain('1 more and you get an entry in our monthly $25 gift card drawing.');
    expect(w.html).toContain('1 friend: an entry');
    expect(w.html).toContain('5 friends: a $10 gift card');
    expect(w.html).toContain('10 friends: a $25 gift card');
    expect(w.html).toContain('https://www.thevic361.com/referral-rules');
    expect(w.html).not.toMatch(/sticker/i);
    expect(w.text).toContain(`Send friends your link: https://www.thevic361.com/r/${code}`);
  });

  it('a signup through a link credits the friend; not yourself, not an inactive code, not a returning reader', async () => {
    await startApp();
    await store.importSubscribers(['sharer@example.com', 'gone@example.com', 'old@example.com'], 'import');
    const subs = await store.listSubscribers({ status: 'active' });
    const codes = await store.ensureRefCodes(subs.map(x => x.id));
    const code = codes[subs.find(x => x.email === 'sharer@example.com').id];
    const goneCode = codes[subs.find(x => x.email === 'gone@example.com').id];
    await store.unsubscribe(subs.find(x => x.email === 'gone@example.com').token);
    await store.unsubscribe(subs.find(x => x.email === 'old@example.com').token);

    const r = await post('/api/subscribe', { email: 'friend@example.com', ref: code.toUpperCase() });
    expect((await r.json()).message).toBe('Almost there! Check your inbox and tap Confirm to start getting it.');
    expect((await subOf('friend@example.com')).referred_by).toBe(code);
    // Not on the list (so not counted) until they confirm: a made-up address never can.
    expect((await subOf('friend@example.com')).status).toBe('pending');
    expect(sent.single.at(-1).subject).toBe('Confirm your Vic 361 subscription');
    expect(await store.countReferrals([code], { counted: false })).toEqual({});
    await confirmFriend('friend@example.com');
    expect(await store.countReferrals([code], { counted: false })).toEqual({ [code]: 1 });
    await post('/api/subscribe', { email: 'other@example.com', ref: goneCode });
    expect((await subOf('other@example.com')).referred_by).toBeUndefined();
    await post('/api/subscribe', { email: 'sharer@example.com', ref: code });
    expect((await subOf('sharer@example.com')).referred_by).toBeUndefined();
    await post('/api/subscribe', { email: 'old@example.com', ref: code }); // a comeback confirms by email
    expect((await subOf('old@example.com')).referred_by).toBeUndefined();
    await post('/api/subscribe', { email: 'junk@example.com', ref: 'nope' });
    expect((await subOf('junk@example.com')).referred_by).toBeUndefined();

    // Counted only after the 24-hour hold, and only while still subscribed.
    expect(await store.countReferrals([code])).toEqual({});
    await age('friend@example.com');
    expect(await store.countReferrals([code])).toEqual({ [code]: 1 });
    await store.unsubscribe((await subOf('friend@example.com')).token);
    expect(await store.countReferrals([code])).toEqual({});
  });

  it('every Monday copy has its reader\'s link and count; a reward that comes due is sent as a gift card, once', async () => {
    const pings = [], orders = [];
    const tremendous = { enabled: true, sendReward: async (o) => { orders.push(o); return { orderId: 'ORD' + orders.length, status: 'EXECUTED' }; } };
    await startApp({ tremendous, slack: { enabled: true, notify: async (m) => { pings.push(m); return true; }, alert: async () => {} } });
    await store.importSubscribers(['sharer@example.com', 'plain@example.com'], 'import');
    const [sharer] = (await store.listSubscribers({ status: 'active' })).filter(x => x.email === 'sharer@example.com');
    const code = (await store.ensureRefCodes([sharer.id]))[sharer.id];
    const friends = [['maria.g@gmail.com', 30], ['tomr@yahoo.com', 40], ['jess.k@outlook.com', 50], ['li.wei@icloud.com', 60], ['bob@aol.com', 70]];
    for (const [e, hours] of friends) {
      await post('/api/subscribe', { email: e, ref: code });
      await confirmFriend(e);
      await age(e, hours);
    }
    await post('/api/subscribe', { email: 'dee@icloud.com', ref: code }); // still in the hold
    await confirmFriend('dee@icloud.com');
    await post('/api/subscribe', { email: 'made.up@gmail.com', ref: code }); // never confirmed: not counted at all
    // A confirmation and a welcome for each confirmed friend, one confirmation for the last.
    await vi.waitFor(() => expect(sent.single).toHaveLength(13), { timeout: 2000 });
    pings.length = 0;

    const h = await auth();
    expect((await post('/api/admin/newsletter/send', {}, h)).status).toBe(200);
    const msgs = sent.batches.flatMap(b => b.msgs);
    const mine = msgs.find(m => m.to[0] === 'sharer@example.com');
    expect(mine.html).toContain(`/r/${code}`);
    expect(mine.text).toContain("You've brought in 5 friends so far. 5 more and you get a $25 gift card.");
    expect(mine.html).toContain('You&#39;ve brought in 5 friends so far.');
    const other = msgs.find(m => m.to[0] === 'plain@example.com');
    expect(other.html).toMatch(/\/r\/[a-z2-9]{7}/);
    expect(other.html).not.toContain(`/r/${code}`);

    // The $10 card went out by itself; the drawing entry is no gift card.
    expect(orders).toEqual([{ externalId: `vic361-tier-${code}-5`, amount: 10, email: 'sharer@example.com', name: 'sharer',
      message: "Thanks for sharing The Vic 361! You've brought in 5 friends, so here's a $10 gift card on us." }]);
    const notes = pings.filter(p => p.title === '🎁 Referral rewards');
    expect(notes).toHaveLength(1);
    expect(notes[0].fields).toEqual([['sharer@example.com', '$10 gift card for reaching 5 friends. Sent ✅']]);
    expect((await subOf('sharer@example.com')).ref_tier).toBe(5);

    // The admin shows counted and pending referrals, and the reward.
    const st = await (await fetch(baseUrl + '/api/admin/newsletter', { headers: h })).json();
    expect(st.referrers[0]).toMatchObject({ email: 'sharer@example.com', referrals: 5, pending: 1 });
    expect(st.referral_tiers.map(t => t.n)).toEqual([1, 5, 10]);
    expect(st.gift_cards).toBe('tremendous');
    expect(st.referral_rewards).toMatchObject([{ email: 'sharer@example.com', what: '$10 gift card for reaching 5 friends', status: 'sent' }]);

    // A retry of the week (or next Monday) doesn't send it again.
    pings.length = 0;
    expect((await post('/api/admin/newsletter/send', { force: true }, h)).status).toBe(200);
    expect(orders).toHaveLength(1);
    expect(pings.filter(p => p.title === '🎁 Referral rewards')).toHaveLength(0);
  });

  it('one inbox counts once: +tags and Gmail dots are the same friend, and never the referrer', async () => {
    await startApp();
    await store.importSubscribers(['sam@gmail.com'], 'import');
    const [sam] = await store.listSubscribers({ status: 'active' });
    const code = (await store.ensureRefCodes([sam.id]))[sam.id];
    // The referrer's own inbox under another address isn't credited at all.
    await post('/api/subscribe', { email: 's.a.m+vic@gmail.com', ref: code });
    expect((await subOf('s.a.m+vic@gmail.com')).referred_by).toBeUndefined();
    for (const e of ['pat@yahoo.com', 'pat+2@yahoo.com', 'jo.ann@gmail.com', 'joann@googlemail.com']) {
      await post('/api/subscribe', { email: e, ref: code });
      await confirmFriend(e);
      await age(e);
    }
    expect(await store.countReferrals([code])).toEqual({ [code]: 2 });
    expect((await store.topReferrers())[0]).toMatchObject({ email: 'sam@gmail.com', referrals: 2, pending: 0 });
    // Pat leaves: pat+2 is the same inbox, so it still counts once.
    await store.unsubscribe((await subOf('pat@yahoo.com')).token);
    expect(await store.countReferrals([code])).toEqual({ [code]: 2 });
  });

  it('holds a reward whose friends look made up until the owner approves it', async () => {
    const at = (min) => new Date(Date.UTC(2026, 9, 1, 12, min)).toISOString();
    expect(referralFlags([
      { email: 'maria.g@gmail.com', confirmed_at: at(0) },
      { email: 'tomr@yahoo.com', confirmed_at: at(45) },
      { email: 'jess.k@outlook.com', confirmed_at: at(120) }
    ])).toEqual([]);
    expect(referralFlags([
      { email: 'sam1@gmail.com', confirmed_at: at(0) },
      { email: 'sam.2@yahoo.com', confirmed_at: at(3) },
      { email: 'sam3@mailinator.com', confirmed_at: at(8) }
    ])).toEqual(['1 at a throwaway-inbox site', '3 joined within 10 minutes', '3 addresses like "sam"']);
    expect(referralFlags([
      { email: 'a@burner.biz', confirmed_at: at(0) },
      { email: 'b@burner.biz', confirmed_at: at(30) },
      { email: 'c@burner.biz', confirmed_at: at(90) }
    ])).toEqual(['3 at burner.biz']);

    const pings = [], orders = [];
    const tremendous = { enabled: true, sendReward: async (o) => { orders.push(o); return { orderId: 'ORD1', status: 'EXECUTED' }; } };
    await startApp({ tremendous, slack: { enabled: true, notify: async (m) => { pings.push(m); return true; }, alert: async () => {} } });
    await store.importSubscribers(['sharer@example.com'], 'import');
    const [sharer] = await store.listSubscribers({ status: 'active' });
    const code = (await store.ensureRefCodes([sharer.id]))[sharer.id];
    for (const e of ['sam1@gmail.com', 'sam2@gmail.com', 'sam3@gmail.com', 'sam4@gmail.com', 'sam5@gmail.com']) {
      await post('/api/subscribe', { email: e, ref: code });
      await confirmFriend(e);
      await age(e);
    }
    pings.length = 0;
    const h = await auth();
    expect((await post('/api/admin/newsletter/send', {}, h)).status).toBe(200);
    // Held: nothing sent until the owner says so.
    expect(orders).toHaveLength(0);
    const [note] = pings.filter(p => p.title === '🎁 Referral rewards');
    expect(note.fields).toEqual([['sharer@example.com', '$10 gift card for reaching 5 friends.\n' +
      '👀 Held for your OK (Admin → Newsletter → Referral rewards): 5 joined within 10 minutes; 5 addresses like "sam".\n' +
      'Friends: sam1@gmail.com, sam2@gmail.com, sam3@gmail.com, sam4@gmail.com, sam5@gmail.com']]);
    const st = await (await fetch(baseUrl + '/api/admin/newsletter', { headers: h })).json();
    const [held] = st.referral_rewards;
    expect(held).toMatchObject({ status: 'held', flags: '5 joined within 10 minutes; 5 addresses like "sam"' });

    // Approve sends it; a second approve can't send it twice.
    const ok = await post(`/api/admin/newsletter/rewards/${held.id}/approve`, {}, h);
    expect(await ok.json()).toMatchObject({ ok: true, message: 'Sent.', reward: { status: 'sent', order_id: 'ORD1' } });
    expect(orders).toHaveLength(1);
    expect((await post(`/api/admin/newsletter/rewards/${held.id}/approve`, {}, h)).status).toBe(409);
    expect((await post(`/api/admin/newsletter/rewards/${held.id}/skip`, {}, h)).status).toBe(409);
    expect((await post(`/api/admin/newsletter/rewards/${held.id}/approve`, {})).status).toBe(401);
  });

  it('a gift card that fails is retried every Monday; without Tremendous it\'s listed to send by hand', async () => {
    const pings = [], alerts = [];
    let fail = true;
    const tremendous = { enabled: true, sendReward: async () => {
      if (fail) { const e = new Error('Not enough money in the Tremendous balance. Add funds, then approve it again or wait for Monday.'); e.status = 402; throw e; }
      return { orderId: 'ORD9', status: 'EXECUTED' };
    } };
    await startApp({ tremendous, slack: { enabled: true, notify: async (m) => { pings.push(m); return true; }, alert: async (...a) => { alerts.push(a); } } });
    await store.importSubscribers(['sharer@example.com'], 'import');
    const [sharer] = await store.listSubscribers({ status: 'active' });
    const code = (await store.ensureRefCodes([sharer.id]))[sharer.id];
    for (const [e, hours] of [['maria.g@gmail.com', 30], ['tomr@yahoo.com', 40], ['jess.k@outlook.com', 50], ['li.wei@icloud.com', 60], ['bob@aol.com', 70]]) {
      await post('/api/subscribe', { email: e, ref: code });
      await confirmFriend(e);
      await age(e, hours);
    }
    const h = await auth();
    pings.length = 0;
    await post('/api/admin/newsletter/send', {}, h);
    expect(pings.find(p => p.title === '🎁 Referral rewards').fields[0][1])
      .toBe('$10 gift card for reaching 5 friends. Failed: Not enough money in the Tremendous balance. Add funds, then approve it again or wait for Monday. It\'s retried every Monday.');
    expect(alerts.map(a => a[0])).toContain('referral-reward-failed');
    fail = false;
    pings.length = 0;
    await post('/api/admin/newsletter/send', { force: true }, h);
    expect(pings.find(p => p.title === '🎁 Referral rewards').fields).toEqual([['sharer@example.com', '$10 gift card for reaching 5 friends. Sent ✅']]);

    // No Tremendous: the reward is still recorded, for the owner to send.
    if (server) await new Promise(r => server.close(r));
    const keep = store;
    await startApp({ slack: { enabled: true, notify: async (m) => { pings.push(m); return true; }, alert: async () => {} } });
    expect(keep).not.toBe(store);
    await store.importSubscribers(['sharer@example.com'], 'import');
    const [s2] = await store.listSubscribers({ status: 'active' });
    const c2 = (await store.ensureRefCodes([s2.id]))[s2.id];
    for (const [e, hours] of [['maria.g@gmail.com', 30], ['tomr@yahoo.com', 40], ['jess.k@outlook.com', 50], ['li.wei@icloud.com', 60], ['bob@aol.com', 70]]) {
      await post('/api/subscribe', { email: e, ref: c2 });
      await confirmFriend(e);
      await age(e, hours);
    }
    pings.length = 0;
    await post('/api/admin/newsletter/send', {}, await auth());
    expect(pings.find(p => p.title === '🎁 Referral rewards').fields[0][1])
      .toBe("$10 gift card for reaching 5 friends. Send it by hand (Tremendous isn't set up).");
    const st = await (await fetch(baseUrl + '/api/admin/newsletter', { headers: await auth() })).json();
    expect(st.gift_cards).toBe('manual');
    const marked = await post(`/api/admin/newsletter/rewards/${st.referral_rewards[0].id}/approve`, {}, await auth());
    expect(await marked.json()).toMatchObject({ ok: true, reward: { status: 'sent', reason: 'Sent by hand' } });
  });

  it('the rules page explains the drawing and the gift cards', async () => {
    await startApp();
    const html = await (await fetch(baseUrl + '/referral-rules')).text();
    expect(html).toContain('Referral rewards: official rules');
    expect(html).toContain('No purchase is necessary');
    expect(html).toContain('$25 digital gift card');
    expect(html).toContain('<strong>5 friends.</strong> A $10 digital gift card');
    expect(html).toContain('Tremendous');
    expect(await (await fetch(baseUrl + '/privacy')).text()).toContain('href="/referral-rules"');
  });

  it('the forms send the code the browser kept, and the pixel skips referral URLs', async () => {
    await startApp();
    const html = await (await fetch(baseUrl + '/subscribe')).text();
    expect(html).toContain("ref:window.vic361Ref?window.vic361Ref():''");
    const app = await fs.readFile(path.join(process.cwd(), 'docs/app.js'), 'utf8');
    expect(app).toContain("ref: window.vic361Ref ? window.vic361Ref() : ''");
    const track = await fs.readFile(path.join(process.cwd(), 'docs/track.js'), 'utf8');
    expect(track).toContain("sessionStorage.setItem('vic361-ref', refQ)");
  });
});

describe('open tracking', () => {
  it('each copy carries its own tracking image; opens count once per subscriber and show in admin', async () => {
    await startApp();
    const h = await auth();
    await post('/api/admin/newsletter/import', { emails: 'a@example.com, b@example.com' }, h);
    expect((await post('/api/admin/newsletter/send', {}, h)).status).toBe(200);
    const subs = await store.listSubscribers({ status: 'active' });
    const pixels = sent.batches[0].msgs.map(m => m.html.match(/<img src="(https:\/\/www\.thevic361\.com\/email\/o\/[^"]+)"/)[1]);
    expect(pixels.sort()).toEqual(subs.map(x => `https://www.thevic361.com/email/o/2026-10-05/${x.id}.gif`).sort());
    // Not utm-tagged, and the token (which unsubscribes) isn't in it.
    for (const p of pixels) expect(p).not.toMatch(/utm_|token/);
    expect(sent.batches[0].msgs[0].text).not.toContain('/email/o/');

    const open = (url) => fetch(url.replace('https://www.thevic361.com', baseUrl));
    const r = await open(pixels[0]);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/gif');
    expect(r.headers.get('cache-control')).toBe('no-store, private');
    expect((await r.arrayBuffer()).byteLength).toBe(42);
    await open(pixels[0]); // the same person again
    // A made-up id and a bad week answer the image but count nothing.
    expect((await fetch(`${baseUrl}/email/o/2026-10-05/00000000-0000-0000-0000-000000000000.gif`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/email/o/nope/${subs[0].id}.gif`)).status).toBe(200);

    await vi.waitFor(async () => {
      const st = await (await fetch(baseUrl + '/api/admin/newsletter', { headers: h })).json();
      expect(st.sends[0]).toMatchObject({ week_key: '2026-10-05', recipients: 2, opens: 1 });
    }, { timeout: 2000 });
    expect(await store.countEmailOpens(['2026-10-05', '2026-09-28'])).toEqual({ '2026-10-05': 1 });
  });

  it('the welcome, confirmation and test emails have no tracking image', async () => {
    await startApp();
    const h = await auth();
    await post('/api/subscribe', { email: 'new@example.com' });
    await post('/api/admin/newsletter/test', { email: 'me@example.com' }, h);
    await vi.waitFor(() => expect(sent.single).toHaveLength(2), { timeout: 2000 });
    for (const m of sent.single) expect(m.html).not.toContain('/email/o/');
  });

  it('the privacy page discloses it', async () => {
    await startApp();
    expect(await (await fetch(baseUrl + '/privacy')).text()).toContain('Newsletter opens:');
  });
});

describe('sending', () => {
  it('admin import, status, test and send; one send per week', async () => {
    await startApp();
    const h = await auth();
    const imp = await (await post('/api/admin/newsletter/import', { emails: 'a@example.com, b@example.com\nnot-an-email' }, h)).json();
    expect(imp).toMatchObject({ ok: true, added: 2 });

    const st = await (await fetch(baseUrl + '/api/admin/newsletter', { headers: h })).json();
    expect(st).toMatchObject({ configured: true, address_set: true, counts: { active: 2 } });
    expect(st.next.events).toBe(2);

    const t = await (await post('/api/admin/newsletter/test', { email: 'me@example.com' }, h)).json();
    expect(t).toMatchObject({ ok: true, to: 'me@example.com' });
    expect(sent.single.at(-1).subject.startsWith('[Test] ')).toBe(true);

    const s = await post('/api/admin/newsletter/send', {}, h);
    expect(s.status).toBe(200);
    expect(sent.batches).toHaveLength(1);
    const msgs = sent.batches[0].msgs;
    expect(msgs.map(m => m.to[0]).sort()).toEqual(['a@example.com', 'b@example.com']);
    expect(msgs[0].headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(msgs[0].headers['List-Unsubscribe']).not.toBe(msgs[1].headers['List-Unsubscribe']);
    expect(msgs[0].html).toContain('Acme Tacos');
    expect(sent.batches[0].key).toMatch(/^vic361-2026-10-05-[0-9a-f]{16}$/);

    const again = await post('/api/admin/newsletter/send', {}, h);
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe('already-sent');
    expect(sent.batches).toHaveLength(1);
  });

  it('cron endpoint needs the secret and skips a week already sent', async () => {
    await startApp();
    await store.importSubscribers(['a@example.com'], 'import');
    expect((await post('/api/newsletter/cron', {})).status).toBe(401);
    expect((await post('/api/newsletter/cron', {}, { 'X-Cron-Secret': 'wrong-secret' })).status).toBe(401);
    const ok = await post('/api/newsletter/cron', {}, { 'X-Cron-Secret': 'cron-secret' });
    expect(ok.status).toBe(200);
    expect(sent.batches).toHaveLength(1);
    const dup = await (await post('/api/newsletter/cron', {}, { 'X-Cron-Secret': 'cron-secret' })).json();
    expect(dup.error).toBe('already-sent');
    expect(sent.batches).toHaveLength(1);
  });

  it('a scheduled send says what it did, and nobody to send to is an alert, not a quiet "ran"', async () => {
    const alerts = [];
    await startApp({ slack: { enabled: true, notify: async () => true, alert: async (k, t) => { alerts.push({ k, t }); return true; } } });
    const empty = await nlApi.scheduledSend();
    expect(empty).toMatchObject({ ok: true, sent_ok: false, detail: 'no-subscribers' });
    expect(alerts.map(a => a.k)).toContain('newsletter-no-subscribers');
    await store.importSubscribers(['a@example.com'], 'import');
    expect(await nlApi.scheduledSend()).toMatchObject({ ok: true, sent_ok: true, detail: 'sent: 1 recipients' });
  });

  it('cron is closed when no secret is configured', async () => {
    await startApp({ newsletterCronSecret: '' });
    expect((await post('/api/newsletter/cron', {}, { 'X-Cron-Secret': '' })).status).toBe(401);
  });
});

describe('send failures', () => {
  it('a failed batch is retried by the next cron, only for the people who missed it', async () => {
    let fail = true;
    const calls = [];
    const resend = {
      send: async () => ({ id: 'x' }),
      batch: async (msgs, key) => {
        calls.push({ to: msgs.map(m => m.to[0]), key });
        if (fail && msgs.some(m => m.to[0] === 'b@example.com')) throw new Error('Resend down');
        return { data: msgs.map((_, i) => ({ id: `b${i}` })) };
      }
    };
    await startApp({ resend });
    await store.importSubscribers(['a@example.com', 'b@example.com'], 'import');
    const first = await (await post('/api/newsletter/cron', {}, { 'X-Cron-Secret': 'cron-secret' })).json();
    expect(first.ok).toBe(false);
    expect(first.failed).toBe(2); // one batch holds both

    fail = false;
    const retry = await (await post('/api/newsletter/cron', {}, { 'X-Cron-Secret': 'cron-secret' })).json();
    expect(retry.ok).toBe(true);
    expect(calls[calls.length - 1].to.sort()).toEqual(['a@example.com', 'b@example.com']);
    // The same key as the first try: had Resend queued that chunk and only
    // answered late, this retry gets a 409 instead of sending it twice.
    expect(calls[calls.length - 1].key).toBe(calls[0].key);

    const again = await (await post('/api/newsletter/cron', {}, { 'X-Cron-Secret': 'cron-secret' })).json();
    expect(again.error).toBe('already-sent');
  });

  it('the admin shows a partly failed week honestly and can retry it', async () => {
    let fail = true;
    const resend = {
      send: async () => ({ id: 'x' }),
      batch: async (msgs) => { if (fail) throw new Error('Resend down'); return { data: msgs.map((_, i) => ({ id: `b${i}` })) }; }
    };
    await startApp({ resend });
    const h = await auth();
    await store.importSubscribers(['a@example.com', 'b@example.com'], 'import');
    const first = await post('/api/admin/newsletter/send', {}, h);
    expect(first.status).toBe(409);
    expect((await first.json()).message).toMatch(/2 failed.*Retry/);
    const st = await (await fetch(baseUrl + '/api/admin/newsletter', { headers: h })).json();
    expect(st).toMatchObject({ this_week_sent: false, this_week_failed: 2 });

    fail = false;
    const retry = await post('/api/admin/newsletter/send', {}, h);
    expect(retry.status).toBe(200);
    const after = await (await fetch(baseUrl + '/api/admin/newsletter', { headers: h })).json();
    expect(after).toMatchObject({ this_week_sent: true, this_week_failed: 0, this_week_recipients: 2 });
  });

  it('asks Resend for permissive batch validation, and reads per-message errors', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, headers: init.headers });
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'e0' }], errors: [{ index: 1, message: 'Invalid `to` field' }] }) };
    };
    const r = createResend('re_x', fetchImpl);
    const out = await r.batch([{ to: ['a@example.com'] }, { to: ['b@example.com'] }], 'k1');
    expect(calls[0].headers['x-batch-validation']).toBe('permissive');
    expect(calls[0].headers['Idempotency-Key']).toBe('k1');
    expect(out.errors).toEqual([{ index: 1, message: 'Invalid `to` field' }]);
    await r.send({ to: ['a@example.com'] });
    expect(calls[1].headers['x-batch-validation']).toBeUndefined();
  });

  it('an address Resend refuses fails only itself, is marked bounced, and the week reads sent', async () => {
    const calls = [];
    const alerts = [];
    const resend = {
      send: async () => ({ id: 'x' }),
      batch: async (msgs) => {
        calls.push(msgs.map(m => m.to[0]));
        const bad = msgs.findIndex(m => m.to[0] === 'b@example.com');
        return { data: msgs.filter((_, i) => i !== bad).map((_, i) => ({ id: `b${i}` })), errors: bad >= 0 ? [{ index: bad, message: 'Invalid `to` field' }] : [] };
      }
    };
    await startApp({ resend, slack: { enabled: true, notify: async () => true, alert: async (key, title, text, link, more) => { alerts.push({ key, title, text, more }); } } });
    const h = await auth();
    await store.importSubscribers(['a@example.com', 'b@example.com', 'c@example.com'], 'import');
    const first = await (await post('/api/newsletter/cron', {}, { 'X-Cron-Secret': 'cron-secret' })).json();
    expect(first).toMatchObject({ ok: true, recipients: 2, failed: 0, failed_emails: [], refused: ['b@example.com'] });
    // Kept on record: the subscriber row says bounced, and the owner is told who.
    expect((await store.listSubscribers({})).find(s => s.email === 'b@example.com').status).toBe('bounced');
    expect(alerts.filter(a => a.key === 'newsletter-refused-2026-10-05')).toHaveLength(1);
    // Slack gets what happens to them; the addresses are for HQ (the inbox).
    const refused = alerts.find(a => a.key === 'newsletter-refused-2026-10-05');
    expect(refused.text).not.toContain('b@example.com');
    expect(refused.text).toContain('More in HQ');
    await new Promise(r => setTimeout(r, 50));
    expect((await store.listInboxEvents(0)).find(e => /refused/.test(e.title)).payload.text).toContain('b@example.com');
    expect(alerts.some(a => a.key.startsWith('newsletter-failed'))).toBe(false);
    const st = await (await fetch(baseUrl + '/api/admin/newsletter', { headers: h })).json();
    expect(st).toMatchObject({ this_week_sent: true, this_week_failed: 0 });
    // No retry of the refused address, this week or next.
    const again = await (await post('/api/newsletter/cron', {}, { 'X-Cron-Secret': 'cron-secret' })).json();
    expect(again.error).toBe('already-sent');
    expect(calls).toHaveLength(1);
    expect((await store.listSubscribers({ status: 'active' })).map(s => s.email).sort()).toEqual(['a@example.com', 'c@example.com']);
  });

  it('a resumed send keeps the picks the first part of the week starred', async () => {
    await startApp();
    await store.importSubscribers(['a@example.com', 'b@example.com'], 'import');
    // Monday's send starred a paid pick and missed b; by the retry that
    // pick's day may be gone from the issue, so the resend's own picks lack it.
    await store.recordNewsletterSend({ week_key: '2026-10-05', subject: 'x', recipients: 1, picks: ['order-monday'],
      failed: 1, failed_emails: ['b@example.com'] });
    const r = await (await post('/api/newsletter/cron', {}, { 'X-Cron-Secret': 'cron-secret' })).json();
    expect(r).toMatchObject({ ok: true, recipients: 2, failed: 0 });
    expect(sent.batches.at(-1).msgs.map(m => m.to[0])).toEqual(['b@example.com']);
    expect((await store.getNewsletterSend('2026-10-05')).picks).toContain('order-monday');
  });

  it('a 409 idempotency answer means that chunk already went out', async () => {
    const resend = {
      send: async () => ({ id: 'x' }),
      batch: async () => { const e = new Error('Resend /emails/batch HTTP 409: invalid_idempotent_request'); e.status = 409; throw e; }
    };
    await startApp({ resend });
    await store.importSubscribers(['a@example.com', 'b@example.com'], 'import');
    const first = await (await post('/api/newsletter/cron', {}, { 'X-Cron-Secret': 'cron-secret' })).json();
    expect(first).toMatchObject({ ok: true, recipients: 2, failed: 0 });
  });

  it('overlapping sends go out once', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const calls = [];
    const resend = {
      send: async () => ({ id: 'x' }),
      batch: async (msgs) => { calls.push(msgs.length); await gate; return { data: msgs.map((_, i) => ({ id: `b${i}` })) }; }
    };
    await startApp({ resend });
    const h = await auth();
    await store.importSubscribers(['a@example.com', 'b@example.com'], 'import');
    const one = post('/api/newsletter/cron', {}, { 'X-Cron-Secret': 'cron-secret' });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const two = await post('/api/admin/newsletter/send', {}, h);
    expect(two.status).toBe(409);
    expect((await two.json()).error).toBe('in-progress');
    release();
    expect((await (await one).json()).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('records who is still waiting before each chunk, so a crash mid-send resumes with only them', async () => {
    const emails = Array.from({ length: 150 }, (_, i) => `p${String(i).padStart(3, '0')}@example.com`);
    const seen = [];
    const resend = {
      send: async () => ({ id: 'x' }),
      batch: async (msgs) => {
        const rec = await store.getNewsletterSend('2026-10-05');
        seen.push(rec ? rec.failed_emails.length : null);
        if (seen.length === 2) throw Object.assign(new Error('process killed'), { crash: true });
        return { data: msgs.map((_, i) => ({ id: `b${i}` })) };
      }
    };
    await startApp({ resend });
    await store.importSubscribers(emails, 'import');
    await post('/api/newsletter/cron', {}, { 'X-Cron-Secret': 'cron-secret' });
    // Before chunk 1 everyone is waiting; before chunk 2 only its 50 are.
    expect(seen).toEqual([150, 50]);
  });

  it('refuses to send without a mailing address', async () => {
    await startApp({ newsletterAddress: '' });
    await store.importSubscribers(['a@example.com'], 'import');
    const r = await (await post('/api/newsletter/cron', {}, { 'X-Cron-Secret': 'cron-secret' })).json();
    expect(r.error).toBe('no-address');
    expect(sent.batches).toHaveLength(0);
  });

  it('a non-ASCII cron header is rejected, not a crash', async () => {
    await startApp();
    const r = await fetch(baseUrl + '/api/newsletter/cron', { method: 'POST', headers: { 'X-Cron-Secret': Buffer.from('crön-secret1', 'latin1').toString('latin1') } });
    expect(r.status).toBe(401);
  });
});

describe('Resend timeout', () => {
  it('a Resend that accepts the connection and never answers is given up on', async () => {
    const seen = [];
    // Hangs until its signal aborts, like a stalled HTTP response.
    const fetchImpl = (url, init) => new Promise((_, reject) => {
      seen.push(init.signal);
      if (!init.signal) return;
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    });
    const r = createResend('re_x', fetchImpl, { timeoutMs: 30 });
    const outcome = await Promise.race([
      r.send({ to: ['a@example.com'] }).then(() => 'answered', err => `failed: ${err.name}`),
      new Promise(res => setTimeout(() => res('still hanging'), 1000))
    ]);
    expect(outcome).toBe('failed: TimeoutError');
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });
});

describe('resumed chunks keep their idempotency key', () => {
  it('a chunk Resend accepted but answered too late is not sent twice on the retry', async () => {
    const accepted = new Map(); // key -> recipients Resend queued
    const delivered = [];
    let slow = true;
    const resend = {
      send: async () => ({ id: 'x' }),
      batch: async (msgs, key) => {
        if (accepted.has(key)) { const e = new Error('Resend 409 idempotent'); e.status = 409; throw e; }
        accepted.set(key, true);
        delivered.push(...msgs.map(m => m.to[0]));
        if (slow) throw new Error('The operation was aborted due to timeout');
        return { data: msgs.map((_, i) => ({ id: `b${i}` })) };
      }
    };
    await startApp({ resend });
    await store.importSubscribers(['a@example.com', 'b@example.com'], 'import');
    const first = await (await post('/api/newsletter/cron', {}, { 'X-Cron-Secret': 'cron-secret' })).json();
    expect(first.failed).toBe(2);
    slow = false;
    const retry = await (await post('/api/newsletter/cron', {}, { 'X-Cron-Secret': 'cron-secret' })).json();
    expect(retry).toMatchObject({ ok: true, failed: 0, recipients: 2 });
    expect(delivered.sort()).toEqual(['a@example.com', 'b@example.com']);
  });
});

describe('paid placements in the issue', () => {
  const PAID = { id: 'wk-paid-0001', kind: 'weekly', status: 'paid', amount: 30000, week_start: '2026-10-05',
    created_at: '2026-09-20T00:00:00Z', business: 'Paid Bakery', email: 'bake@example.com',
    sponsor: { name: 'Paid Bakery', text: 'Fresh bread.', cta: 'Visit', url: 'https://bakery.example' } };

  it('a failed order read is retried, and an issue is never sent without the paid sponsor', async () => {
    await startApp();
    await store.importSubscribers(['a@example.com'], 'import');
    await store.saveSponsorOrder(PAID);
    const real = store.listSponsorOrders.bind(store);
    let fails = 1;
    store.listSponsorOrders = async () => { if (fails-- > 0) throw new Error('statement timeout'); return real(); };
    const r = await (await post('/api/newsletter/cron', {}, { 'X-Cron-Secret': 'cron-secret' })).json();
    expect(r.ok).toBe(true);
    expect(sent.batches[0].msgs[0].html).toContain('Paid Bakery');
  });

  it('when the orders stay unreadable the send fails (and is retried later) instead of going out without them', async () => {
    await startApp();
    await store.importSubscribers(['a@example.com'], 'import');
    await store.saveSponsorOrder(PAID);
    store.listSponsorOrders = async () => { throw new Error('statement timeout'); };
    const r = await post('/api/newsletter/cron', {}, { 'X-Cron-Secret': 'cron-secret' });
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(sent.batches).toHaveLength(0);
    expect(await store.getNewsletterSend('2026-10-05')).toBeFalsy();
  });
});

describe('a returning subscriber', () => {
  it('old issues\' unsubscribe links still work, but the old token can\'t confirm the comeback', async () => {
    await startApp();
    const email = 'back@example.com';
    const first = await store.addSubscriber({ email, source: 'home' });
    await store.confirmSubscriber(first.token);
    const oldToken = first.token;
    expect((await post(`/unsubscribe?token=${oldToken}`)).status).toBe(200);
    const again = await store.addSubscriber({ email, source: 'footer' });
    expect(again.new_signup).toBe(true);
    // A new token confirms: the old one is in every issue they got,
    // forwarded copies included.
    expect(again.token).not.toBe(oldToken);
    expect(await store.confirmSubscriber(oldToken)).toBeNull();
    await store.confirmSubscriber(again.token);
    expect((await store.listSubscribers({ status: 'active' })).map(s => s.email)).toEqual([email]);
    // Gmail's Unsubscribe on an issue from before the first unsubscribe.
    expect(await (await fetch(`${baseUrl}/unsubscribe?token=${oldToken}`)).text()).toContain('example.com');
    expect((await post(`/unsubscribe?token=${oldToken}`)).status).toBe(200);
    expect(await store.listSubscribers({ status: 'active' })).toEqual([]);
  });

  it('Postgres keeps the old token for unsubscribing only', async () => {
    const { PgStore } = await import('../server/db.js');
    const calls = [];
    const pool = { query: async (text, params) => {
      calls.push({ text: String(text), params: params || [] });
      if (/SELECT \* FROM subscribers WHERE email/.test(text)) return { rows: [{ email: 'a@x.com', status: 'unsubscribed', token: 'old' }] };
      if (/^\s*UPDATE subscribers SET status = 'pending'/.test(text)) return { rows: [{ email: 'a@x.com', status: 'pending', token: params[1] }] };
      return { rows: [], rowCount: 1 };
    } };
    const st = new PgStore(pool);
    await st.addSubscriber({ email: 'a@x.com', source: 'home' });
    const up = calls.find(c => /UPDATE subscribers SET status = 'pending'/.test(c.text));
    expect(up.text).toMatch(/old_tokens = array_append\(old_tokens, token\)/);
    await st.unsubscribe('old');
    expect(calls.at(-1).text).toMatch(/\$1 = ANY\(old_tokens\)/);
    await st.confirmSubscriber('old');
    expect(calls.at(-1).text).not.toMatch(/old_tokens/);
  });
});

describe('referral rewards engine', () => {
  const localDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

  it('draws last month\'s winner once, from the 2nd, one entry per friend who joined that month', async () => {
    expect(drawingMonth('2026-10-01')).toBe(null);
    expect(drawingMonth('2026-10-02')).toBe('2026-09');
    expect(drawingMonth('2027-01-05')).toBe('2026-12');

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-draw-'));
    const st = new FileStore(path.join(tmpDir, 's.json'));
    await st.importSubscribers(['ann@example.com', 'ben@example.com', 'gone@example.com'], 'import');
    const subs = await st.listSubscribers({ status: 'active' });
    const codes = await st.ensureRefCodes(subs.map(x => x.id));
    const code = (e) => codes[subs.find(x => x.email === e).id];
    const join = async (email, ref, at) => {
      const s = await st.addSubscriber({ email, source: 'site', referredBy: ref });
      await st.confirmSubscriber(s.token);
      await st._withWrite(async () => {
        const data = await st._read();
        data.subscribers.find(x => x.email === email).confirmed_at = at;
        await st._write(data);
      });
    };
    await join('a1@gmail.com', code('ann@example.com'), '2026-09-03T15:00:00Z');
    await join('a.1+x@gmail.com', code('ann@example.com'), '2026-09-04T15:00:00Z'); // same inbox: one entry
    await join('a2@yahoo.com', code('ann@example.com'), '2026-09-20T15:00:00Z');
    await join('b1@outlook.com', code('ben@example.com'), '2026-10-01T04:30:00Z'); // Sept 30 in Victoria
    await join('b2@outlook.com', code('ben@example.com'), '2026-08-30T15:00:00Z'); // August: not this drawing
    await join('g1@aol.com', code('gone@example.com'), '2026-09-10T15:00:00Z');
    await st.unsubscribe(subs.find(x => x.email === 'gone@example.com').token); // a referrer who left can't win

    const orders = [], pings = [];
    const tremendous = { enabled: true, sendReward: async (o) => { orders.push(o); return { orderId: 'D1', status: 'EXECUTED' }; } };
    const slack = { notify: async (m) => { pings.push(m); }, alert: async () => {} };
    const picks = [];
    const rewards = createReferralRewards({ store: st, slack, tremendous, localDate, nowFn: () => new Date('2026-10-05T13:00:00Z'),
      // Entries run in code order: ann's 2 and ben's 1. Pick ben's.
      randomInt: (n) => { picks.push(n); return code('ben@example.com') < code('ann@example.com') ? 0 : 2; } });
    const done = await rewards.run({});
    expect(picks).toEqual([3]);
    expect(done).toMatchObject([{ kind: 'drawing', month: '2026-09', email: 'ben@example.com', entries: 1, total_entries: 3, amount: 25, status: 'sent' }]);
    expect(orders).toEqual([{ externalId: 'vic361-draw-2026-09', amount: 25, email: 'ben@example.com', name: 'ben',
      message: "You won The Vic 361's September 2026 referral drawing! Thanks for sharing the newsletter with your friends." }]);
    expect(pings[0].fields).toEqual([['ben@example.com', '$25 gift card: won the September 2026 drawing (1 of 3 entries). Sent ✅']]);
    // Once a month, however many Mondays.
    expect(await rewards.run({})).toEqual([]);
    expect(orders).toHaveLength(1);
  });

  it('sends one order to Tremendous: campaign, amount, email, and the key that stops a double payment', async () => {
    const calls = [];
    const ok = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ order: { id: 'O1', status: 'EXECUTED' } }) }; };
    const live = createTremendous(tremendousConfig({ TREMENDOUS_API_KEY: 'PROD_abc', TREMENDOUS_CAMPAIGN_ID: 'CAMP1' }), ok);
    expect(live.enabled).toBe(true);
    expect(await live.sendReward({ externalId: 'vic361-tier-abc2345-5', amount: 10, email: 'r@example.com', name: 'r', message: 'Thanks!' }))
      .toEqual({ orderId: 'O1', status: 'EXECUTED' });
    expect(calls[0].url).toBe('https://api.tremendous.com/api/v2/orders');
    expect(calls[0].init.headers.Authorization).toBe('Bearer PROD_abc');
    expect(JSON.parse(calls[0].init.body)).toEqual({
      external_id: 'vic361-tier-abc2345-5', payment: { funding_source_id: 'BALANCE' },
      reward: { campaign_id: 'CAMP1', value: { denomination: 10, currency_code: 'USD' }, recipient: { name: 'r', email: 'r@example.com' },
        delivery: { method: 'EMAIL', meta: { sender_name: 'The Vic 361', message: 'Thanks!' } } }
    });
    const test = createTremendous(tremendousConfig({ TREMENDOUS_API_KEY: 'TEST_abc', TREMENDOUS_CAMPAIGN_ID: 'C' }), ok);
    await test.sendReward({ externalId: 'x', amount: 1, email: 'r@example.com', name: 'r', message: 'm' });
    expect(calls[1].url).toBe('https://testflight.tremendous.com/api/v2/orders');
    expect(tremendousConfig({ TREMENDOUS_API_KEY: 'k' }).enabled).toBe(false); // needs the campaign too

    const broke = createTremendous(tremendousConfig({ TREMENDOUS_API_KEY: 'k', TREMENDOUS_CAMPAIGN_ID: 'C' }),
      async () => ({ ok: false, status: 402, json: async () => ({ errors: { message: 'Insufficient funds' } }) }));
    await expect(broke.sendReward({ externalId: 'x', amount: 1, email: 'r@example.com', name: 'r', message: 'm' }))
      .rejects.toThrow('Not enough money in the Tremendous balance');
  });
});

describe('referral rewards: failures from the code review', () => {
  const localDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const NOW_R = new Date('2026-10-20T13:00:00Z'); // nothing in last month's drawing
  // A store with one referrer who has 5 counted friends.
  async function fiveFriends() {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-rr-'));
    const st = new FileStore(path.join(tmpDir, 's.json'));
    await st.importSubscribers(['sharer@example.com'], 'import');
    const [s] = await st.listSubscribers({ status: 'active' });
    const code = (await st.ensureRefCodes([s.id]))[s.id];
    const friends = ['maria.g@gmail.com', 'tomr@yahoo.com', 'jess.k@outlook.com', 'li.wei@icloud.com', 'bob@aol.com'];
    for (const [i, email] of friends.entries()) {
      const f = await st.addSubscriber({ email, source: 'site', referredBy: code });
      await st.confirmSubscriber(f.token);
      await st._withWrite(async () => {
        const data = await st._read();
        data.subscribers.find(x => x.email === email).confirmed_at = new Date(Date.UTC(2026, 9, 10 + i, 15)).toISOString();
        await st._write(data);
      });
    }
    return { st, code };
  }
  const paying = () => {
    const orders = [];
    return { orders, tremendous: { enabled: true, sendReward: async (o) => { orders.push(o); return { orderId: 'O' + orders.length, status: 'EXECUTED' }; } } };
  };
  const quiet = { notify: async () => {}, alert: async () => {} };

  it('a failed insert leaves the tier due, so next Monday still creates and pays it', async () => {
    const { st, code } = await fiveFriends();
    const { orders, tremendous } = paying();
    let boom = true;
    const flaky = Object.create(st);
    flaky.addReferralReward = async (row) => { if (boom) { boom = false; throw new Error('db blip'); } return st.addReferralReward(row); };
    const rewards = createReferralRewards({ store: flaky, slack: quiet, tremendous, localDate, nowFn: () => NOW_R });
    expect(await rewards.run({ [code]: 5 })).toEqual([]);
    expect((await st.listRefTiers([code]))[code].ref_tier).toBe(0); // not marked reached
    const done = await rewards.run({ [code]: 5 });
    expect(done).toMatchObject([{ key: `tier:${code}:5`, status: 'sent' }]);
    expect(orders).toHaveLength(1);
    expect((await st.listRefTiers([code]))[code].ref_tier).toBe(5);
  });

  it('a reward left half-sent is retried later; one bad record doesn\'t stop the others', async () => {
    const { st, code } = await fiveFriends();
    const { orders, tremendous } = paying();
    let failUpdate = true;
    const flaky = Object.create(st);
    flaky.updateReferralReward = async (id, patch) => {
      if (failUpdate && patch.status === 'sent') { failUpdate = false; throw new Error('db blip'); }
      return st.updateReferralReward(id, patch);
    };
    // Real time here: the store stamps updated_at with the real clock.
    const rewards = createReferralRewards({ store: flaky, slack: quiet, tremendous, localDate, nowFn: () => new Date() });
    const first = await rewards.run({ [code]: 5 });
    expect(first).toMatchObject([{ status: 'failed' }]);
    expect(orders).toHaveLength(1); // Tremendous took it, the record didn't save
    const [row] = await st.listReferralRewards();
    expect(row.status).toBe('pending');
    // Too fresh to retry (it may still be sending)...
    expect(await rewards.approve(row.id)).toMatchObject({ ok: false, status: 409 });
    // ...but once it's stale, the admin can send it and Monday retries it,
    // with the same external_id (Tremendous answers with the same order).
    await st._withWrite(async () => {
      const data = await st._read();
      data.referral_rewards[0].updated_at = new Date(Date.now() - 11 * 60e3).toISOString();
      await st._write(data);
    });
    const again = await rewards.run({ [code]: 5 });
    expect(again).toMatchObject([{ status: 'sent' }]);
    expect(orders.map(o => o.externalId)).toEqual([`vic361-tier-${code}-5`, `vic361-tier-${code}-5`]);
  });

  it('when the friends can\'t be read, the reward is held, not paid', async () => {
    const { st, code } = await fiveFriends();
    const { orders, tremendous } = paying();
    const flaky = Object.create(st);
    flaky.listReferredFriends = async () => { throw new Error('db blip'); };
    const rewards = createReferralRewards({ store: flaky, slack: quiet, tremendous, localDate, nowFn: () => NOW_R });
    expect(await rewards.run({ [code]: 5 })).toMatchObject([{ status: 'held', flags: 'couldn\'t check this reader\'s friends' }]);
    expect(orders).toHaveLength(0);
  });

  it('a Tremendous order that comes back FAILED or CANCELED isn\'t marked sent', async () => {
    const { st, code } = await fiveFriends();
    const tremendous = { enabled: true, sendReward: async () => ({ orderId: 'OX', status: 'CANCELED' }) };
    const rewards = createReferralRewards({ store: st, slack: quiet, tremendous, localDate, nowFn: () => NOW_R });
    const [row] = await rewards.run({ [code]: 5 });
    expect(row).toMatchObject({ status: 'failed', order_id: 'OX' });
    expect(row.reason).toMatch(/^Tremendous order CANCELED/);
  });

  it('the newsletter goes out before any gift card is ordered', async () => {
    const order = [];
    const tremendous = { enabled: true, sendReward: async () => { order.push('gift card'); return { orderId: 'O', status: 'EXECUTED' }; } };
    const resend = fakeResend();
    const batch = resend.batch;
    resend.batch = async (...a) => { order.push('newsletter'); return batch(...a); };
    await startApp({ tremendous, resend });
    await store.importSubscribers(['sharer@example.com'], 'import');
    const [s] = await store.listSubscribers({ status: 'active' });
    const code = (await store.ensureRefCodes([s.id]))[s.id];
    for (const [i, e] of ['maria.g@gmail.com', 'tomr@yahoo.com', 'jess.k@outlook.com', 'li.wei@icloud.com', 'bob@aol.com'].entries()) {
      const f = await store.addSubscriber({ email: e, source: 'site', referredBy: code });
      await store.confirmSubscriber(f.token);
      await store._withWrite(async () => {
        const data = await store._read();
        data.subscribers.find(x => x.email === e).confirmed_at = new Date(NOW.getTime() - (30 + i * 10) * 3600e3).toISOString();
        await store._write(data);
      });
    }
    expect((await post('/api/admin/newsletter/send', {}, await auth())).status).toBe(200);
    expect(order).toEqual(['newsletter', 'gift card']);
  });

  it('the admin reward buttons answer with an error when the store is down', async () => {
    await startApp();
    const h = await auth();
    store.getReferralReward = async () => { throw new Error('db down'); };
    const r = await post('/api/admin/newsletter/rewards/abc/approve', {}, h);
    expect(r.status).toBe(503);
    expect((await r.json()).message).toMatch(/db down/);
  });
});

describe('referral signups: holes from the code review', () => {
  const ALMOST = 'Almost there! Check your inbox and tap Confirm to start getting it.';

  it('sending a referred address again without the code doesn\'t skip the confirmation', async () => {
    await startApp();
    await store.importSubscribers(['sharer@example.com'], 'import');
    const [s] = await store.listSubscribers({ status: 'active' });
    const code = (await store.ensureRefCodes([s.id]))[s.id];
    expect((await (await post('/api/subscribe', { email: 'fake1@nowhere.test', ref: code })).json()).message).toBe(ALMOST);
    // Same answer as any signup (not "Almost there", which would tell anyone
    // it's a referred address waiting to confirm); still only its inbox can
    // put it on the list.
    expect((await (await post('/api/subscribe', { email: 'fake1@nowhere.test' })).json()).message).toBe("You're on the list! Check your inbox.");
    expect(sent.single.filter(m => m.to[0] === 'fake1@nowhere.test').map(m => m.subject)).toEqual(['Confirm your Vic 361 subscription', 'Confirm your Vic 361 subscription']);
    const sub = (await store._read()).subscribers.find(x => x.email === 'fake1@nowhere.test');
    expect(sub).toMatchObject({ status: 'pending', referred_by: code });
    expect(await store.countReferrals([code], { counted: false })).toEqual({});
  });

  it('the reply doesn\'t reveal which address owns a share code', async () => {
    await startApp();
    await store.importSubscribers(['owner@gmail.com'], 'import');
    const [s] = await store.listSubscribers({ status: 'active' });
    const code = (await store.ensureRefCodes([s.id]))[s.id];
    for (const guess of ['owner@gmail.com', 'o.w.n.e.r+x@gmail.com', 'someone.else@gmail.com', 'nobody@example.com']) {
      expect((await (await post('/api/subscribe', { email: guess, ref: code })).json()).message).toBe(ALMOST);
    }
    // A made-up code gets the same answer too.
    expect((await (await post('/api/subscribe', { email: 'x@example.com', ref: 'zzzzzzz' })).json()).message).toBe(ALMOST);
  });
});

describe('confirm reminders', () => {
  // A pending signup made `hours` ago.
  async function pendingFor(email, hours, now = NOW) {
    const sub = await store.addSubscriber({ email, source: 'site' });
    await store._withWrite(async () => {
      const data = await store._read();
      const row = data.subscribers.find(x => x.email === email);
      row.created_at = row.pending_since = new Date(now.getTime() - hours * 3600e3).toISOString();
      await store._write(data);
    });
    return sub;
  }

  it('one reminder a day after signing up, only to recent pending signups', async () => {
    await startApp();
    const due = await pendingFor('forgot@example.com', 26);
    await pendingFor('just-now@example.com', 3);       // not a day yet
    await pendingFor('long-ago@example.com', 24 * 9);   // older than a week: left alone
    await store.importSubscribers(['on@example.com'], 'import'); // already on the list
    expect(await nlApi.sendConfirmReminders(NOW)).toEqual({ sent: 1 });
    expect(sent.single).toHaveLength(1);
    const [m] = sent.single;
    expect(m.to).toEqual(['forgot@example.com']);
    expect(m.subject).toBe("Still want Victoria's events? Tap to confirm");
    expect(m.html).toContain(`/subscribe/confirm?token=${due.token}`);
    expect(m.text).toContain("You asked for The Vic 361 yesterday but haven't confirmed yet.");
    // Once only.
    expect(await nlApi.sendConfirmReminders(new Date(NOW.getTime() + 3600e3))).toEqual({ sent: 0 });
    // The confirm link still works and puts them on the list.
    expect((await fetch(`${baseUrl}/subscribe/confirm?token=${due.token}`, { method: 'POST' })).status).toBe(200);
    expect((await store._read()).subscribers.find(x => x.email === 'forgot@example.com').status).toBe('active');
    // Confirming sends the welcome email in the background: wait for it, or
    // it lands in the next test's outbox.
    await vi.waitFor(() => expect(sent.single.map(m => m.subject)).toHaveLength(2), { timeout: 2000 });
  });

  it('a comeback is reminded a day after coming back, not right away', async () => {
    await startApp();
    await store.importSubscribers(['back@example.com'], 'import');
    const [s] = await store.listSubscribers({ status: 'active' });
    await store._withWrite(async () => {
      const data = await store._read();
      data.subscribers.find(x => x.email === 'back@example.com').created_at = new Date(NOW.getTime() - 3 * 864e5).toISOString();
      await store._write(data);
    });
    await store.unsubscribe(s.token);
    await store.addSubscriber({ email: 'back@example.com', source: 'site' }); // comes back now (the store's real clock)
    expect(await nlApi.sendConfirmReminders(new Date())).toEqual({ sent: 0 });
    expect(await nlApi.sendConfirmReminders(new Date(Date.now() + 25 * 3600e3))).toEqual({ sent: 1 });
  });

  it('a reminder that fails to send is tried again next hour', async () => {
    const resend = fakeResend();
    let fail = true;
    const send = resend.send;
    resend.send = async (...a) => { if (fail) { fail = false; throw new Error('resend down'); } return send(...a); };
    await startApp({ resend });
    await pendingFor('forgot@example.com', 30);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await nlApi.sendConfirmReminders(NOW)).toEqual({ sent: 0 });
    } finally { warn.mockRestore(); }
    expect(await nlApi.sendConfirmReminders(NOW)).toEqual({ sent: 1 });
    expect(sent.single.filter(m => /Tap to confirm/.test(m.subject)).map(m => m.to[0])).toEqual(['forgot@example.com']);
  });

  it('the first-time confirm email is unchanged', () => {
    const m = renderConfirmEmail({ siteUrl: 'https://www.thevic361.com', confirmUrl: 'https://x/c', address: 'a' });
    expect(m.subject).toBe('Confirm your Vic 361 subscription');
  });
});

describe('referral rewards: second review', () => {
  const localDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const NOW_R = new Date('2026-10-20T13:00:00Z');

  async function storeWith() {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-rr2-'));
    return new FileStore(path.join(tmpDir, 's.json'));
  }
  async function join(st, email, ref, at) {
    const f = await st.addSubscriber({ email, source: 'site', referredBy: ref });
    await st.confirmSubscriber(f.token);
    await st._withWrite(async () => {
      const data = await st._read();
      data.subscribers.find(x => x.email === email).confirmed_at = at;
      await st._write(data);
    });
  }

  it('one inbox counts for one referrer only, and a second address of a rewarded inbox is held', async () => {
    const st = await storeWith();
    await st.importSubscribers(['owner+r1@gmail.com', 'owner+r2@gmail.com'], 'import');
    const subs = await st.listSubscribers({ status: 'active' });
    const codes = await st.ensureRefCodes(subs.map(x => x.id));
    const c1 = codes[subs.find(x => x.email === 'owner+r1@gmail.com').id];
    const c2 = codes[subs.find(x => x.email === 'owner+r2@gmail.com').id];
    const friends = ['ann', 'bob', 'cat', 'dee', 'eve'];
    for (const [i, f] of friends.entries()) await join(st, `${f}+r1@gmail.com`, c1, new Date(Date.UTC(2026, 9, 2, 12 + i)).toISOString());
    for (const [i, f] of friends.entries()) await join(st, `${f}+r2@gmail.com`, c2, new Date(Date.UTC(2026, 9, 5, i)).toISOString());
    // The same five inboxes again under the second alias: they count only for the first.
    expect(await st.countReferrals([c1, c2])).toEqual({ [c1]: 5 });

    // Five different friends under the second alias: counted, but the reward is held for a look.
    for (const [i, f] of ['fay', 'gus', 'hal', 'ivy', 'jon'].entries()) await join(st, `${f}@yahoo.com`, c2, new Date(Date.UTC(2026, 9, 6, i * 3)).toISOString());
    const orders = [];
    const tremendous = { enabled: true, sendReward: async (o) => { orders.push(o); return { orderId: 'O' + orders.length, status: 'EXECUTED' }; } };
    const rewards = createReferralRewards({ store: st, slack: { notify: async () => {}, alert: async () => {} }, tremendous, localDate, nowFn: () => NOW_R });
    const first = await rewards.run(await st.countReferrals([c1]));
    expect(first).toMatchObject([{ ref_code: c1, status: 'sent' }]);
    const second = await rewards.run(await st.countReferrals([c2]));
    expect(second).toMatchObject([{ ref_code: c2, status: 'held', flags: 'another address of this inbox already earned referral rewards' }]);
    expect(orders).toHaveLength(1);
  });

  it('held rewards stay on the admin list however many newer ones there are; Slack puts them first', async () => {
    const st = await storeWith();
    const held = await st.addReferralReward({ key: 'tier:old:5', kind: 'tier', ref_code: 'old', email: 'h@example.com', tier: 5, amount: 10, status: 'held', flags: 'x' });
    for (let i = 0; i < 25; i++) {
      await st.addReferralReward({ key: `tier:c${i}:5`, kind: 'tier', ref_code: `c${i}`, email: `s${i}@example.com`, tier: 5, amount: 10, status: 'sent' });
    }
    const rewards = createReferralRewards({ store: st, slack: null, tremendous: null, localDate, nowFn: () => NOW_R });
    const list = await rewards.list(20);
    expect(list.some(r => r.id === held.id)).toBe(true);
    expect(list).toHaveLength(21);
  });
});

describe('review fixes: email limits', () => {
  it('one inbox is one key for the per-inbox confirmation cap (+tags and Gmail dots)', () => {
    expect(inboxKey('V.I.C.T.I.M+x@GoogleMail.com')).toBe('victim@gmail.com');
    expect(inboxKey('pat+news@yahoo.com')).toBe('pat@yahoo.com');
    expect(inboxKey('pat.smith@yahoo.com')).toBe('pat.smith@yahoo.com');
  });

  it('signups without a bot check share an hourly budget of confirmation emails', async () => {
    const pass = async () => ({ ok: true, json: async () => ({ success: true }) });
    await startApp({ turnstileSecret: 'fake-secret', fetch: pass, trustProxy: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (let i = 0; i < 35; i++) {
        const r = await fetch(baseUrl + '/api/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.0.0.${i}` },
          body: JSON.stringify({ email: `person${i}@example.com` }) });
        expect((await r.json()).message).toBe('Almost there! Check your inbox and tap Confirm to start getting it.');
      }
    } finally { warn.mockRestore(); }
    expect(sent.single).toHaveLength(30);
  });

  it('a comeback\'s welcome email gets its own idempotency key', async () => {
    const keys = [];
    const resend = fakeResend();
    const send = resend.send;
    resend.send = async (msg, key) => { keys.push(key); return send(msg, key); };
    await startApp({ resend });
    await post('/api/subscribe', { email: 'back@example.com' });
    await vi.waitFor(() => expect(keys).toHaveLength(1), { timeout: 2000 });
    const sub = (await store._read()).subscribers.find(x => x.email === 'back@example.com');
    await store.unsubscribe(sub.token);
    const again = await store.addSubscriber({ email: 'back@example.com', source: 'site' });
    await new Promise(r => setTimeout(r, 5));
    expect((await fetch(`${baseUrl}/subscribe/confirm?token=${again.token}`, { method: 'POST' })).status).toBe(200);
    await vi.waitFor(() => expect(keys.filter(k => /^vic361-welcome-/.test(k))).toHaveLength(2), { timeout: 2000 });
    const [a, b] = keys.filter(k => /^vic361-welcome-/.test(k));
    expect(a).not.toBe(b);
  });

  it('the open pixel ignores issues more than six months old or in the future', async () => {
    await startApp();
    await store.importSubscribers(['a@example.com'], 'import');
    const [s] = await store.listSubscribers({ status: 'active' });
    for (const week of ['2025-01-06', '2027-01-04', '2026-10-05']) {
      expect((await fetch(`${baseUrl}/email/o/${week}/${s.id}.gif`)).headers.get('content-type')).toBe('image/gif');
    }
    await vi.waitFor(async () => expect(await store.countEmailOpens(['2025-01-06', '2027-01-04', '2026-10-05'])).toEqual({ '2026-10-05': 1 }), { timeout: 2000 });
  });
});

describe('reply ask and open counting', () => {
  it('asks readers to reply (welcome and issues) only when replies reach an inbox', async () => {
    await startApp({ newsletterReplyTo: 'hello@thevic361.com' });
    const h = await auth();
    await post('/api/subscribe', { email: 'reader@example.com' });
    await vi.waitFor(() => expect(sent.single.some(m => m.subject === 'Welcome to The Vic 361')).toBe(true), { timeout: 2000 });
    const w = sent.single.find(m => m.subject === 'Welcome to The Vic 361');
    expect(w.reply_to).toBe('hello@thevic361.com');
    expect(w.html).toContain('One quick favor: hit reply');
    expect(w.text).toContain('ONE QUICK FAVOR: hit reply and tell us what you');
    expect((await post('/api/admin/newsletter/send', {}, h)).status).toBe(200);
    const issue = sent.batches[0].msgs[0];
    expect(issue.reply_to).toBe('hello@thevic361.com');
    expect(issue.html).toContain('Just hit reply');
    expect(issue.text).toContain('What do you want more of? Just hit reply');
  });

  it('no reply-to set: no ask, so nobody replies into a bounce', async () => {
    await startApp();
    await post('/api/subscribe', { email: 'reader@example.com' });
    await vi.waitFor(() => expect(sent.single.some(m => m.subject === 'Welcome to The Vic 361')).toBe(true), { timeout: 2000 });
    const w = sent.single.find(m => m.subject === 'Welcome to The Vic 361');
    expect(w.reply_to).toBeUndefined();
    expect(w.html).not.toContain('hit reply');
  });

  it('counts every reader’s open even when they all come through one image proxy', async () => {
    await startApp();
    const h = await auth();
    const emails = Array.from({ length: 150 }, (_, i) => `r${i}@example.com`).join(', ');
    await post('/api/admin/newsletter/import', { emails }, h);
    expect((await post('/api/admin/newsletter/send', {}, h)).status).toBe(200);
    const pixels = sent.batches.flatMap(b => b.msgs).map(m => m.html.match(/<img src="https:\/\/www\.thevic361\.com(\/email\/o\/[^"]+)"/)[1]);
    expect(pixels).toHaveLength(150);
    for (const p of pixels) await fetch(baseUrl + p); // all from 127.0.0.1, like Gmail's proxy
    // Each open is saved after its response, one rewrite of the file store at
    // a time; 150 of them took over 3 s on a CI runner.
    await vi.waitFor(async () => {
      expect(await store.countEmailOpens(['2026-10-05'])).toEqual({ '2026-10-05': 150 });
    }, { timeout: 20000, interval: 200 });
  }, 30000);
});
