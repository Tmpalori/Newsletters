// @vitest-environment node
//
// Page copy follows the town (MULTI_CITY_PLAN.md 1.2d): the hub pages and
// seasonal guides name the site's own town, and a town gets only its own
// guides (Victoria's Bach Festival and Tejas Fest aren't another town's).
// Victoria's output is pinned by tests/golden/.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { town, townConfig, useTown, VICTORIA } from '../server/town.js';
import { HUB_PAGES, renderHubPage, withPages } from '../server/seo.js';
import { SEASONS, townSeasons, activeSeasons, renderSeasonPage } from '../server/guides.js';
import { createApp } from '../server/index.js';
import { eventCardSvg } from '../server/ogImage.js';
import { createInbound } from '../server/inbound.js';
import { FileStore } from '../server/db.js';
import { renderWeekly, renderWelcomeEmail, renderConfirmEmail, renderReferralRules } from '../server/newsletter.js';
import {
  renderSubmissionReceived, renderSubmissionLive, renderSponsorConfirmed, renderSponsorTooLate, renderSponsorReport, renderPickReport
} from '../server/notify.js';

const FIXTURE = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'golden', 'fixture.json'), 'utf8'));

// What another town's copy must never say. Case-insensitive: an uppercase
// "VIC’S PICK" pill or "SHARE THE VIC 361" heading is the same leak.
const LEAK = /.{0,50}(Victoria|Vic 361|Vic[’']s Pick|The Vic\b).{0,30}/gi;
// Uppercase strings still hard-coded in server/newsletter.js (the email
// "★ VIC’S PICK" badge and the plain-text "SHARE THE VIC 361" heading). A
// separate change fixes that file; until it lands they are known and
// tolerated here, and only these exact strings are. Delete this once
// newsletter.js uses the town's names.
const KNOWN_NEWSLETTER_LEAKS = /★ VIC’S PICK|SHARE THE VIC 361/;
const leaksIn = (text, { known = null } = {}) => {
  const found = (String(text).match(LEAK) || []).filter(m => !(known && known.test(m)));
  return found.length ? found : null;
};

const SITE = 'https://www.thebay979.com';
const NOW = new Date('2026-10-07T17:00:00Z');
const BAY = { id: 'bay', siteName: 'The Bay 979', siteNameHtml: 'The Bay <span>979</span>', pickName: 'Bay’s Best', domain: 'thebay979.com', city: 'Bay City', state: 'TX', stateName: 'Texas', timezone: 'America/Chicago' };
const events = withPages([
  { date: '2026-10-09', name: 'Tejas Fest Day 1', venue: 'Downtown', time: '6:00 PM' },
  { date: '2026-10-10', name: 'Fall Fest Hayride', venue: 'Farm', time: '7:00 PM', free: true },
  { date: '2026-10-24', name: 'Oktoberfest', venue: 'Hall', time: '5:00 PM' }
]);

afterAll(() => useTown(VICTORIA));

describe('Victoria', () => {
  it('keeps every guide, including its own festivals', () => {
    useTown(VICTORIA);
    expect(townSeasons()).toEqual(SEASONS);
    expect(townSeasons().map(s => s.path)).toEqual(expect.arrayContaining(['/bach-festival', '/tejas-fest']));
    expect(HUB_PAGES[0].title).toBe('Things To Do in Victoria, TX Today');
    expect(SEASONS.find(s => s.path === '/tejas-fest').title).toBe('Tejas Fest in Victoria, TX');
  });
});

describe('another town', () => {
  it('derives its short name and copy fields, and checks them', () => {
    expect(townConfig({}, { town: BAY })).toMatchObject({ shortName: 'Bay 979', areaCode: '', localSources: 'the city, the library, the chamber of commerce' });
    expect(townConfig({}, { town: { ...BAY, areaCode: '979' } }).areaCode).toBe('979');
    expect(() => townConfig({}, { town: { ...BAY, areaCode: '97' } })).toThrow(/areaCode/);
    expect(VICTORIA).toMatchObject({ shortName: 'Vic 361', areaCode: '361', pickName: 'Vic’s Pick', pickNamePlain: "Vic's Pick" });
    expect(townConfig({}, { town: BAY })).toMatchObject({ pickName: 'Bay’s Best', pickNamePlain: "Bay's Best" });
    expect(townConfig({}, { town: { ...BAY, pickName: undefined } })).toMatchObject({ pickName: 'Local Pick', pickNamePlain: 'Local Pick' });
    expect(() => townConfig({}, { town: { ...BAY, pickName: 'Bay <Pick>' } })).toThrow(/pickName/);
  });

  it('hub pages name it, in titles, headings, descriptions and leads', () => {
    useTown(townConfig({}, { town: BAY }));
    for (const page of HUB_PAGES) {
      expect(`${page.title} ${page.h1} ${page.description} ${page.lead(1, 'x')} ${page.lead(0, 'x')}`, page.path).not.toMatch(/Victoria/);
      expect(page.title, page.path).toMatch(/Bay City/);
      const html = renderHubPage(page, events, { siteUrl: SITE, now: NOW });
      expect(html.match(/[^.>]{0,40}Victoria[^.<]{0,40}/g), page.path).toBe(null);
    }
    expect(HUB_PAGES.find(p => p.path === '/this-weekend').description).toBe(
      'Events in Bay City, Texas this weekend: concerts, festivals, family events, markets, and free things to do Friday through Sunday.');
  });

  it('gets the shared guides, naming it, and not Victoria’s own festivals', () => {
    useTown(townConfig({}, { town: BAY }));
    const paths = townSeasons().map(s => s.path);
    expect(paths).not.toContain('/bach-festival');
    expect(paths).not.toContain('/tejas-fest');
    expect(paths).toContain('/halloween-events');
    expect(paths.length).toBe(SEASONS.length - 2);
    // A Tejas Fest listing elsewhere doesn't light up Victoria's guide.
    expect(activeSeasons(events, [], NOW).map(s => s.path)).toEqual(['/oktoberfest', '/halloween-events']);
    for (const season of townSeasons()) {
      expect(`${season.title} ${season.h1} ${season.description} ${season.intro}`, season.path).not.toMatch(/Victoria/);
      expect(renderSeasonPage(season, events, [], { siteUrl: SITE, now: NOW }), season.path).not.toMatch(/Victoria/);
    }
    expect(SEASONS.find(s => s.path === '/halloween-events').intro).toMatch(/around Bay City\.$/);
  });
});

describe('a whole second-town site', () => {
  let tmpDir, server, base;
  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-copy-'));
    const eventsFile = path.join(tmpDir, 'events.json');
    const venuesFile = path.join(tmpDir, 'venues.json');
    // Victoria's fixture, moved: no event, venue or sponsor names Victoria.
    const scrub = v => JSON.parse(JSON.stringify(v).replace(/Victoria/g, 'Bay City').replace(/77901/g, '77414'));
    await fs.writeFile(eventsFile, JSON.stringify(scrub({ events: FIXTURE.events, sponsor: FIXTURE.sponsor })));
    await fs.writeFile(venuesFile, JSON.stringify(scrub(FIXTURE.venues)));
    const { app } = await createApp({
      town: BAY, storeBundle: { kind: 'file', store: new FileStore(path.join(tmpDir, 's.json')) }, eventsFile, venuesFile,
      trustProxy: false, now: () => NOW, resendApiKey: '', stripeSecretKey: 'sk_test_copy', stripeWebhookSecret: 'whsec_copy',
      stripe: { createCheckoutSession: async () => { throw new Error('unused'); }, expireCheckoutSession: async () => ({}) },
      slack: { enabled: false, notify: async () => false, alert: async () => false }
    });
    server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    useTown(VICTORIA);
    if (server) await new Promise(r => server.close(r));
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  // The homepage and /submit are static HTML until plan step 1.3b.
  it('no server-rendered page says Victoria', async () => {
    const { events } = await (await fetch(base + '/events.json')).json();
    const pages = events.map(e => e.page).filter(Boolean).slice(0, 4);
    const venues = await (await fetch(base + '/venues')).text();
    const venue = venues.match(/href="(\/venues\/[a-z0-9-]+)"/)[1];
    const paths = ['/about', '/privacy', '/terms', '/advertising-terms', '/accessibility', '/advertise', '/advertise/checkout?package=weekly', '/advertise/checkout?package=featured', '/advertise/checkout?package=category', '/partners',
      '/subscribe', '/referral-rules', '/contact', '/venues', venue, '/no-such-page', '/llms.txt', '/sitemap.xml',
      ...pages, ...pages.map(p => p + '.ics'), ...HUB_PAGES.map(p => p.path), ...townSeasons().map(s => s.path)];
    for (const p of paths) {
      const text = await (await fetch(base + p)).text();
      // /advertise shows a sample newsletter pick, with newsletter.js's badge.
      expect(leaksIn(text, { known: KNOWN_NEWSLETTER_LEAKS }), p).toBe(null);
    }
    expect((await fetch(base + '/tejas-fest')).status).toBe(404);
    expect((await fetch(base + '/bach-festival')).status).toBe(404);
    const llms = await (await fetch(base + '/llms.txt')).text();
    expect(llms).toContain('things to do in Bay City, Texas. Concerts'); // no area code line for a town without one
  });

  it('no email says Victoria or Vic 361', () => {
    const evs = withPages(JSON.parse(JSON.stringify(FIXTURE.events).replace(/Victoria/g, 'Bay City')));
    const site = SITE;
    const order = { id: 'o1', kind: 'weekly', status: 'paid', amount: 30000, week_start: '2026-10-12', business: 'Acme', email: 'a@b.example',
      sponsor: { name: 'Acme', text: 'Hi.', cta: 'Go', url: 'https://acme.example' } };
    const pick = { id: 'o2', kind: 'featured', status: 'paid', amount: 4900, business: 'Main St', email: 'm@s.example',
      event: { name: 'Fall Fest', date: '2026-10-10', time: '10:00 AM', venue: 'Plaza' } };
    const mails = [
      renderWeekly(evs, { siteUrl: site, now: new Date('2026-10-05T12:43:00Z'), unsubscribeUrl: site + '/u', address: '', edition: 'weekly', referral: { code: 'abc', count: 1 }, replyAsk: true }),
      renderWeekly(evs, { siteUrl: site, now: new Date('2026-10-08T12:00:00Z'), unsubscribeUrl: site + '/u', address: '', edition: 'weekend' }),
      renderWelcomeEmail(evs, { siteUrl: site, now: NOW, unsubscribeUrl: site + '/u', address: '' }),
      renderWelcomeEmail([], { siteUrl: site, now: NOW, unsubscribeUrl: site + '/u', address: '' }),
      renderConfirmEmail({ siteUrl: site, confirmUrl: site + '/c', address: '' }),
      renderConfirmEmail({ siteUrl: site, confirmUrl: site + '/c', address: '', reminder: true }),
      renderSubmissionReceived(evs[0], { siteUrl: site, address: '', upgradeUrl: site + '/up' }),
      renderSubmissionLive(evs[0], { siteUrl: site, address: '', pageUrl: site + evs[0].page, upgradeUrl: '', pick: true }),
      renderSponsorConfirmed(order, { siteUrl: site, address: '' }),
      renderSponsorConfirmed(pick, { siteUrl: site, address: '' }),
      renderSponsorTooLate(pick, { siteUrl: site, address: '' }),
      renderSponsorReport({ ...order, week_start: '2026-09-28' }, { week_start: '2026-09-28', week_end: '2026-10-04', views: 5, site_visitors: 9 }, { siteUrl: site, address: '' }),
      renderPickReport(pick, { shown: 3, page_views: 2, clicks: 1 }, { siteUrl: site, address: '' })
    ];
    for (const m of mails) {
      const all = `${m.subject}\n${m.preheader || ''}\n${m.text}\n${m.html}`;
      expect(leaksIn(all, { known: KNOWN_NEWSLETTER_LEAKS }), m.subject).toBe(null);
    }
    expect(mails[4].subject).toBe('Confirm your Bay 979 subscription');
    // The header wordmark: the town's name and its badge.
    expect(mails[0].html).toContain('<div><span style="font-size:22px;font-weight:bold;">The Bay</span> <span ');
    expect(mails[0].html).toMatch(/padding:0 6px;[^>]*">979<\/span><\/div>/);
    // The pick's own name, in HTML and in plain text.
    expect(mails[9].html).toContain('Bay’s Best');
    expect(mails[9].text).toContain("Bay's Best");
    expect(renderReferralRules({ siteUrl: site })).not.toMatch(/Victoria/);
  });

  it('the case-insensitive check catches an uppercase leak', () => {
    expect(leaksIn('<text>VIC’S PICK</text>')).not.toBe(null);
    expect(leaksIn('SHARE THE VIC 361')).not.toBe(null);
    expect(leaksIn('SHARE THE VIC 361', { known: KNOWN_NEWSLETTER_LEAKS })).toBe(null);
    expect(leaksIn('BAY’S BEST')).toBe(null);
  });

  it("a featured event's share card shows the town's pick name", () => {
    useTown(townConfig({}, { town: BAY }));
    try {
      const svg = eventCardSvg({ date: '2026-10-09', name: 'Fall Fest', venue: 'Hall', time: '6:00 PM', featured: true });
      expect(svg).toContain('BAY’S BEST');
      expect(leaksIn(svg)).toBe(null);
    } finally {
      useTown(VICTORIA);
    }
    expect(eventCardSvg({ date: '2026-10-09', name: 'Fall Fest', venue: 'Hall', featured: true })).toContain('VIC’S PICK');
  });
});

describe('email replies about the town’s pick', () => {
  it('get the 💰, by the town’s own pick name', async () => {
    const pings = [];
    const slack = { notify: async m => { pings.push(m); return true; } };
    const mail = subject => ({ from: 'a@b.example', subject, text: 'hi', headers: {} });
    const run = async (subject, i) => {
      const inbound = createInbound({ config: { enabled: true }, apiKey: 'k', slack, siteUrl: SITE, fetchImpl: async () => ({ ok: true, json: async () => mail(subject) }) });
      await inbound.handle({ type: 'email.received', data: { email_id: 'e' + i, to: [`news@${town.domain}`] } });
      return pings.at(-1).title.startsWith('💰');
    };
    useTown(VICTORIA);
    expect(await run('Re: You’re a Vic’s Pick!', 1)).toBe(true);
    expect(await run('Re: hello', 2)).toBe(false);
    useTown(townConfig({}, { town: BAY }));
    expect(await run('Re: Your Bay’s Best is live', 3)).toBe(true);
    expect(await run("Re: bay's best", 4)).toBe(true);
    expect(await run('Re: hello', 5)).toBe(false);
    useTown(VICTORIA);
  });
});
