// @vitest-environment node
//
// The newsletter's extra sections (server/sections.js, SECTIONS.md): the
// pet of the week, new in town, the question of the week and its readers'
// answers, good news from city hall and the monthly one-tap poll. Off for a
// town without sections.json (Victoria's goldens pin that); on, they show
// under the events in each issue and on the homepage.

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { renderWeekly, sectionsEmailHtml } from '../server/newsletter.js';
import { createSections, sectionPages, sectionsFor, questionFor, pollFor, firstName, sectionsConfig, mondayOf, sectionsHomeHtml, placeWhen, placeMapUrl } from '../server/sections.js';

// The first Monday of October: a poll week.
const NOW = new Date('2026-10-05T15:00:00Z');
const SECRET = 's'.repeat(40);
const LONG = { adminUsername: 'admin', adminPassword: 'a-long-enough-pass', adminSessionSecret: 'x'.repeat(32) };
const PHOTO = Buffer.from('ffd8ffe000104a46494600', 'hex').toString('base64');

const CFG = {
  enabled: true,
  questions: ['Best kolache in town?', 'Best sunset spot?'],
  polls: [{ id: 'went-to-event', question: 'Have you gone to something you found here?', choices: ['Yes', 'Not yet', 'Maybe'] }],
  // Sources for every section (the pages show only what a source can fill).
  pets: [{ name: 'County Shelter', source: 'petpoint' }], new_in_town: { source: 'growthzone_ribbons' }, good_news: { sources: [{ source: 'civicclerk' }] }
};
const FILE = {
  week: '2026-10-05', built_at: '2026-10-04T23:20:00Z',
  pet: { id: 'pp-57380521', name: 'Chloe', species: 'Dog', facts: 'Pit Bull mix · Female', blurb: 'Chloe loves a good walk.',
    shelter: 'Victoria County Animal Services', shelter_address: '513 Profit St', url: 'https://ws.petango.com/x', photo: PHOTO },
  new_in_town: [{ key: 'tx-1', name: 'Chai Filipino Food', line: 'Filipino food, now open on NE Zac Lentz Pkwy.', status: 'open' },
    { key: 'tx-2', name: 'Bao Bao Bakery', line: 'Buns and pastries, coming soon.', status: 'soon' }],
  good_news: { items: [{ title: 'MLK Jr. Park', line: 'Plans to improve the park are on the agenda.' }], url: 'https://example.gov/agenda' },
  roundup: { question: 'Best kolache in town?', answers: [{ quote: 'Sausage and cheese, still warm.', name: 'Maria' }, { quote: 'Fruit ones for the kids.', name: 'Dale' }] },
  review: [{ id: 'place:tx-3', verdict: 'drop', why: 'home business' }]
};

let servers = [], dirs = [];
afterEach(async () => {
  for (const s of servers) await new Promise(r => s.close(r));
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  servers = []; dirs = [];
});

function fakeSlack() {
  const s = { enabled: true, alerts: [], notes: [] };
  s.notify = async n => { s.notes.push(n); return true; };
  s.alert = async (key, title, text) => { s.alerts.push({ key, title, text }); return true; };
  return s;
}

async function start({ cfg = CFG, now = () => NOW } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-sections-'));
  dirs.push(dir);
  const eventsFile = path.join(dir, 'events.json');
  await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
  const store = new FileStore(path.join(dir, 's.json'));
  const slack = fakeSlack();
  const out = await createApp({
    storeBundle: { kind: 'file', store }, eventsFile, candidatesFile: path.join(dir, 'candidates.json'), collectionMetadataFile: path.join(dir, 'collection_metadata.json'),
    trustProxy: false, now, siteUrl: 'https://www.thevic361.com', resendApiKey: '', slack,
    autoPublish: false, startScheduler: false, jobsEnv: { JOBS_ON_RAILWAY: '1', JOBS_SECRET: SECRET }, sectionsConfig: cfg, ...LONG
  });
  const server = http.createServer(out.app);
  servers.push(server);
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async () => {
    const r = await (await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: LONG.adminUsername, password: LONG.adminPassword }) })).json();
    return { Authorization: `Bearer ${r.token}`, 'Content-Type': 'application/json' };
  };
  const putFile = (name, data) => fetch(`${base}/api/jobs/files/${name}`, { method: 'PUT',
    headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  return { ...out, base, store, slack, login, putFile };
}

describe('which section runs when', () => {
  it('rotates the question by week and asks a poll on the first Monday of the month only', () => {
    expect(mondayOf('2026-10-08')).toBe('2026-10-05');
    expect(questionFor(CFG, '2026-10-05')).not.toBe(questionFor(CFG, '2026-10-12'));
    expect(questionFor(CFG, '2026-10-05')).toBe(questionFor(CFG, '2026-10-19'));
    expect(pollFor(CFG, '2026-10-05').id).toBe('went-to-event');
    expect(pollFor(CFG, '2026-10-12')).toBeNull();
    expect(questionFor({}, '2026-10-05')).toBeNull();
  });

  it('puts the pet, new places, poll and question on Monday, the answers and good news on Thursday', () => {
    const mon = sectionsFor({ cfg: CFG, file: FILE, edition: 'weekly', now: NOW });
    expect(mon.pet.name).toBe('Chloe');
    expect(mon.places).toHaveLength(2);
    expect(mon.poll).toBeTruthy();
    expect(mon.question).toBeTruthy();
    expect(mon.roundup).toBeUndefined();
    const thu = sectionsFor({ cfg: CFG, file: FILE, edition: 'weekend', now: new Date('2026-10-08T12:00:00Z') });
    expect(thu.roundup.answers).toHaveLength(2);
    expect(thu.good.items).toHaveLength(1);
    expect(thu.pet).toBeUndefined();
  });

  it('leaves out what the owner took out, a stale file, and everything when off', () => {
    const s = sectionsFor({ cfg: CFG, file: FILE, hidden: ['pet', 'place:tx-1'], edition: 'weekly', now: NOW });
    expect(s.pet).toBeNull();
    expect(s.places.map(x => x.key)).toEqual(['tx-2']);
    const stale = sectionsFor({ cfg: CFG, file: FILE, edition: 'weekly', now: new Date('2026-10-26T12:00:00Z') });
    expect(stale.pet).toBeNull();
    expect(stale.places).toEqual([]);
    expect(stale.question).toBeTruthy();   // the town's own list, not the worker's
    expect(sectionsFor({ cfg: { ...CFG, enabled: false }, file: FILE, now: NOW })).toBeNull();
  });

  it('skips a roundup with only one answer', () => {
    const one = { ...FILE, roundup: { question: 'Q', answers: [{ quote: 'One', name: 'A' }] } };
    expect(sectionsFor({ cfg: CFG, file: one, edition: 'weekend', now: new Date('2026-10-08T12:00:00Z') }).roundup).toBeNull();
  });

  it('reads the town file, and SECTIONS=1/0 overrides it', () => {
    expect(sectionsConfig({ id: 'nowhere' }, { env: {} }).enabled).toBe(false);
    expect(sectionsConfig({ id: 'nowhere' }, { env: { SECTIONS: '1' } }).enabled).toBe(true);
    expect(sectionsConfig({ id: 'victoria' }, { env: { SECTIONS: '0' } }).enabled).toBe(false);
  });

  it('takes a first name from the From line, never the address', () => {
    expect(firstName('Maria Lopez <m@x.com>')).toBe('Maria');
    expect(firstName('"dale" <d@x.com>')).toBe('Dale');
    expect(firstName('m@x.com')).toBe('');
  });
});

describe('the issue', () => {
  const opts = { siteUrl: 'https://www.thevic361.com', now: NOW, unsubscribeUrl: 'https://www.thevic361.com/unsubscribe?token=t', replyAsk: true };

  it('is unchanged without sections', () => {
    expect(renderWeekly([], { ...opts, sections: null }).html).toBe(renderWeekly([], opts).html);
  });

  it('shows the Monday sections, each reader their own poll links, and the question in place of the reply line', () => {
    const sx = sectionsFor({ cfg: CFG, file: FILE, edition: 'weekly', now: NOW });
    const issue = renderWeekly([], { ...opts, sections: sx, subscriberId: 'sub-9' });
    expect(issue.html).toContain('Pet of the week');
    expect(issue.html).toContain('https://www.thevic361.com/sections/pet/pp-57380521.jpg');
    expect(issue.html).toContain('Chai Filipino Food');
    expect(issue.html).toContain('/p/2026-10-05/went-to-event/0?s=sub-9');
    expect(issue.html).toContain('Question of the week');
    expect(issue.html).not.toContain('What do you want more of?');
    expect(issue.text).toContain('PET OF THE WEEK: Chloe');
    expect(issue.text).toContain('QUESTION OF THE WEEK');
  });

  it('puts the poll right under the events, and the question has an answer button', () => {
    const sx = sectionsFor({ cfg: CFG, file: FILE, edition: 'weekly', now: NOW });
    const { html, text } = renderWeekly([], { ...opts, sections: sx, subscriberId: 'sub-9' });
    const at = s => html.indexOf(s);
    expect(at('Quick poll')).toBeGreaterThan(at('See the full list'));
    expect(at('Quick poll')).toBeLessThan(at('Pet of the week'));
    expect(at('Quick poll')).toBeLessThan(at('Question of the week'));
    expect(html).toContain('mailto:news@thevic361.com?subject=My%20answer%3A%20');
    expect(html).toContain('Send my answer');
    expect(text.indexOf('QUICK POLL')).toBeLessThan(text.indexOf('PET OF THE WEEK'));
  });

  it('never says where New in town came from', () => {
    const html = sectionsEmailHtml(sectionsFor({ cfg: CFG, file: FILE, edition: 'weekly', now: NOW }), { siteUrl: '' });
    expect(html).not.toMatch(/permit|licen[cs]e|record|comptroller|filing/i);
  });

  it('escapes what came from outside', () => {
    const bad = { ...FILE, new_in_town: [{ key: 'x', name: '<script>alert(1)</script>', line: 'a "quote" & more', status: 'open' }] };
    const html = sectionsEmailHtml(sectionsFor({ cfg: CFG, file: bad, edition: 'weekly', now: NOW }), { siteUrl: '' });
    expect(html).not.toContain('<script>');
    expect(sectionsHomeHtml(sectionsFor({ cfg: CFG, file: bad, edition: 'weekly', now: NOW }), { siteUrl: '' })).not.toContain('<script>');
  });
});

describe('on the site', () => {
  it('takes the worker file, pings Slack, and shows the sections on the homepage and the pet photo', async () => {
    const t = await start();
    expect((await t.putFile('sections', FILE)).status).toBe(200);
    expect(t.slack.notes.some(n => /sections ready/.test(n.title) && /Chloe/.test(n.text) && /left out 1 item/.test(n.text))).toBe(true);
    const home = await (await fetch(t.base + '/')).text();
    expect(home).toContain('id="new-in-town"');
    expect(home).toContain('Pet of the week');
    const img = await fetch(t.base + '/sections/pet/pp-57380521.jpg');
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/jpeg');
    expect((await fetch(t.base + '/sections/pet/someone-else.jpg')).status).toBe(404);
  });

  it('shows nothing when the town has sections off', async () => {
    const t = await start({ cfg: { ...CFG, enabled: false } });
    await t.putFile('sections', FILE);
    const home = await (await fetch(t.base + '/')).text();
    expect(home).not.toContain('id="sections"');
  });

  it('counts one vote per reader, throws out a mail scanner clicking every choice, and shows the results', async () => {
    let clock = NOW.getTime();
    const t = await start({ now: () => new Date(clock) });
    const sub = await t.store.addSubscriber({ email: 'reader@example.com', source: 'home' });
    const row = (await t.store.listSubscribers({})).find(x => x.email === 'reader@example.com');
    const id = sub.id || row.id;
    const ua = { 'User-Agent': 'Mozilla/5.0 (iPhone)' };
    const vote = (c, s = id, h = ua) => fetch(`${t.base}/p/2026-10-05/went-to-event/${c}?s=${s}`, { redirect: 'manual', headers: h });
    // Not confirmed yet: no vote.
    await vote(0);
    expect(await t.store.countPollVotes('2026-10-05', 'went-to-event')).toEqual({});
    await t.store.confirmSubscriber(row.token);
    // A scanner: every choice within seconds (three, so a vote can't come
    // back on the odd click), even all at once → no vote.
    clock += 60 * 60 * 1000;
    await vote(0);
    clock += 1000;
    await vote(1);
    clock += 1000;
    await vote(2);
    expect(await t.store.countPollVotes('2026-10-05', 'went-to-event')).toEqual({});
    clock += 60 * 60 * 1000;
    await Promise.all([vote(0), vote(1), vote(2)]);
    expect(await t.store.countPollVotes('2026-10-05', 'went-to-event')).toEqual({});
    // The reader, later.
    clock += 10 * 60 * 1000;
    const r = await vote(1);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/poll/2026-10-05/went-to-event?v=1');
    expect(await t.store.countPollVotes('2026-10-05', 'went-to-event')).toEqual({ 1: 1 });
    // A bot, a made-up subscriber, a week with no poll: nothing counted.
    await vote(0, id, { 'User-Agent': 'Barracuda Sentinel' });
    await vote(0, 'nobody');
    expect((await fetch(`${t.base}/p/2026-10-12/went-to-event/0?s=${id}`, { redirect: 'manual', headers: ua })).headers.get('location')).toBe('/');
    // A made-up week that isn't a Monday, or years away: nothing either.
    for (const w of ['2026-10-01', '2024-10-07']) {
      expect((await fetch(`${t.base}/p/${w}/went-to-event/0?s=${id}`, { redirect: 'manual', headers: ua })).headers.get('location')).toBe('/');
    }
    expect(await t.store.countPollVotes('2026-10-05', 'went-to-event')).toEqual({ 1: 1 });
    const page = await (await fetch(`${t.base}/poll/2026-10-05/went-to-event?v=1`)).text();
    expect(page).toContain('Thanks for voting');
    expect(page).toContain('100%');
  });

  it('lets the owner take an item out and put it back', async () => {
    const t = await start();
    await t.putFile('sections', FILE);
    const auth = await t.login();
    const list = await (await fetch(t.base + '/api/admin/sections', { headers: auth })).json();
    expect(list.pet.name).toBe('Chloe');
    expect(list.pet.photo).toBeUndefined();
    const hide = await fetch(t.base + '/api/admin/sections/hide', { method: 'POST', headers: auth, body: JSON.stringify({ id: 'place:tx-1' }) });
    expect((await hide.json()).hidden).toEqual(['place:tx-1']);
    const home = await (await fetch(t.base + '/')).text();
    expect(home).not.toContain('Chai Filipino Food');
    expect(home).toContain('Bao Bao Bakery');
    await fetch(t.base + '/api/admin/sections/hide', { method: 'POST', headers: auth, body: JSON.stringify({ id: 'place:tx-1', hidden: false }) });
    expect(await (await fetch(t.base + '/')).text()).toContain('Chai Filipino Food');
    expect((await fetch(t.base + '/api/admin/sections/hide', { method: 'POST', headers: auth, body: JSON.stringify({ id: 'drop table' }) })).status).toBe(400);
    expect((await fetch(t.base + '/api/admin/sections')).status).toBe(401);
  });

  it('uses the job’s question for the week, and lets the owner take a coming-up question out for good', async () => {
    const t = await start();
    await t.putFile('sections', { ...FILE, question: 'Best spot for a fall picnic?', question_bank: [{ id: 'abcdef0123', q: 'Best Halloween decorations in town?', added: '2026-10-05' }],
      questions_added: ['Best spot for a fall picnic?', 'Best Halloween decorations in town?'] });
    expect(t.slack.notes.some(n => /New questions for the weeks ahead/.test(n.text) && /fall picnic/.test(n.text))).toBe(true);
    expect(sectionsFor({ cfg: CFG, file: { ...FILE, question: 'Best spot for a fall picnic?' }, edition: 'weekly', now: NOW }).question).toBe('Best spot for a fall picnic?');
    const auth = await t.login();
    const list = await (await fetch(t.base + '/api/admin/sections', { headers: auth })).json();
    expect(list.question).toBe('Best spot for a fall picnic?');
    expect(list.upcoming_questions.map(q => q.q)).toEqual(['Best Halloween decorations in town?']);
    const r = await fetch(t.base + '/api/admin/sections/hide', { method: 'POST', headers: auth, body: JSON.stringify({ id: 'bank:abcdef0123' }) });
    expect(r.status).toBe(200);
    expect((await t.store.getTownFile('sections')).data.question_bank).toEqual([]);
  });

  it('shows Sunday evening’s build (already for Monday) on the homepage that night', () => {
    const sunday = new Date('2026-10-11T23:30:00Z');
    expect(sectionsFor({ cfg: CFG, file: { ...FILE, week: '2026-10-12' }, edition: 'weekly', now: sunday }).pet.name).toBe('Chloe');
  });

  it('hands the worker readers\' replies (words and a first name, never the address)', async () => {
    const t = await start();
    await t.store.saveReaderReply({ id: 'e1', created_at: '2026-10-05T16:00:00Z', name: 'Maria', email: 'm@x.com', subject: 'Re: This week', text: 'Sausage and cheese!' });
    await t.store.saveReaderReply({ id: 'e0', created_at: '2026-09-20T16:00:00Z', name: 'Old', email: 'o@x.com', subject: 'Re', text: 'Last month' });
    const r = await (await fetch(`${t.base}/api/jobs/replies?since=2026-10-05`, { headers: { Authorization: `Bearer ${SECRET}` } })).json();
    expect(r.replies).toEqual([{ at: '2026-10-05T16:00:00Z', name: 'Maria', subject: 'Re: This week', text: 'Sausage and cheese!' }]);
  });
});

describe('the sections’ own pages', () => {
  it('builds New in Town, Pets and City Hall from what the issues showed, in the menu and the sitemap', async () => {
    const t = await start();
    await t.putFile('sections', FILE);
    const nit = await (await fetch(t.base + '/new-in-town')).text();
    expect(nit).toContain('New in Victoria');
    expect(nit).toContain('Chai Filipino Food');
    expect(nit).toContain('October 2026');
    expect(nit).toContain('data-source="sections"');
    expect(nit).toContain('/sections/cards/new-in-town.png');
    expect(nit).toMatch(/<a href="\/this-weekend"[^>]*>This Weekend<\/a><a href="\/new-in-town" aria-current="page">New in Town<\/a><a href="\/pets">Pets<\/a><a href="\/city-hall">City Hall<\/a>/);
    const pets = await (await fetch(t.base + '/pets')).text();
    expect(pets).toContain('Meet Chloe, our pet of the week');
    expect(pets).toContain('/sections/pet/pp-57380521.jpg');
    const hall = await (await fetch(t.base + '/city-hall')).text();
    expect(hall).toContain('MLK Jr. Park');
    expect(hall).toContain('Week of Oct 5');
    const map = await (await fetch(t.base + '/sitemap.xml')).text();
    expect(map).toContain('/new-in-town</loc>');
    expect(map).toContain('/city-hall</loc>');
    const card = await fetch(t.base + '/sections/cards/new-in-town.png');
    expect(card.status).toBe(200);
    expect(card.headers.get('content-type')).toBe('image/png');
  });

  it('keeps past pets (and their photos) and every week’s places; taking one out takes it off the page', async () => {
    const t = await start();
    await t.putFile('sections', { ...FILE, week: '2026-09-28', pet: { ...FILE.pet, id: 'pp-1', name: 'Rex' }, new_in_town: [{ key: 'old', name: 'Old Spot', line: 'x', status: 'open' }] });
    await t.putFile('sections', FILE);
    const pets = await (await fetch(t.base + '/pets')).text();
    expect(pets).toContain('Recently featured');
    expect(pets).toContain('Rex');
    expect((await fetch(t.base + '/sections/pet/pp-1.jpg')).status).toBe(200);
    expect(await (await fetch(t.base + '/new-in-town')).text()).toContain('Old Spot');
    const auth = await t.login();
    await fetch(t.base + '/api/admin/sections/hide', { method: 'POST', headers: auth, body: JSON.stringify({ id: 'place:tx-1' }) });
    expect(await (await fetch(t.base + '/new-in-town')).text()).not.toContain('Chai Filipino Food');
  });

  it('has the question of the week on the homepage, with a button to the signup form', async () => {
    const t = await start();
    await t.putFile('sections', { ...FILE, question: 'Best spot for a fall picnic?' });
    const home = await (await fetch(t.base + '/')).text();
    expect(home).toContain('id="question-of-the-week"');
    expect(home).toContain('Best spot for a fall picnic?');
    expect(home).toContain('href="/subscribe">Count me in</a>');
  });

  it('none of it exists when the town has sections off', async () => {
    const t = await start({ cfg: { ...CFG, enabled: false } });
    await t.putFile('sections', FILE);
    expect((await fetch(t.base + '/new-in-town')).status).toBe(404);
    const home = await (await fetch(t.base + '/')).text();
    expect(home).not.toContain('href="/new-in-town"');
    expect(await (await fetch(t.base + '/sitemap.xml')).text()).not.toContain('/new-in-town');
  });
});

describe('clicks per section', () => {
  it('counts a reader’s click, not a bot’s, and only sends people to our pages or this week’s links', async () => {
    const t = await start();
    await t.putFile('sections', FILE);
    const ua = { 'User-Agent': 'Mozilla/5.0 (iPhone)' };
    const go = (section, to, h = ua) => fetch(`${t.base}/go/x/${section}?w=2026-10-05&to=${encodeURIComponent(to)}`, { redirect: 'manual', headers: h });
    expect((await go('pet', 'https://ws.petango.com/x')).headers.get('location')).toBe('https://ws.petango.com/x');
    expect((await go('places', '/new-in-town')).headers.get('location')).toBe('/new-in-town');
    expect((await go('hall', 'https://example.gov/agenda')).headers.get('location')).toBe('https://example.gov/agenda');
    await go('pet', 'https://ws.petango.com/x', { 'User-Agent': 'Mimecast scanner' });
    // Anywhere else: home, never the given address.
    expect((await go('pet', 'https://evil.example/phish')).headers.get('location')).toBe('/');
    expect((await go('pet', '//evil.example')).headers.get('location')).toBe('/');
    await new Promise(r => setTimeout(r, 50));
    const clicks = (await t.store.getTownFile('section_clicks')).data['2026-10-05'];
    expect(clicks).toEqual({ pet: 1, places: 1, hall: 1 });
    const auth = await t.login();
    const list = await (await fetch(t.base + '/api/admin/sections', { headers: auth })).json();
    expect(list.activity[0]).toMatchObject({ week: '2026-10-05', clicks: { pet: 1, places: 1, hall: 1 }, votes: 0 });
  });

  it('puts the counted links in the email', () => {
    const sx = sectionsFor({ cfg: CFG, file: FILE, edition: 'weekly', now: NOW });
    const html = renderWeekly([], { siteUrl: 'https://www.thevic361.com', now: NOW, unsubscribeUrl: 'u', sections: sx }).html;
    expect(html).toContain('/go/x/pet?w=2026-10-05&amp;to=https%3A%2F%2Fws.petango.com%2Fx');
    expect(html).toContain('/go/x/places?w=2026-10-05&amp;to=%2Fnew-in-town');
    expect(html).toContain('See every new place →');
  });
});

describe('the multi-agent review (Oct 2026)', () => {
  it('ignores made-up weeks on clicks, so real weeks are never pushed out', async () => {
    const t = await start();
    await t.putFile('sections', FILE);
    const ua = { 'User-Agent': 'Mozilla/5.0 (iPhone)' };
    for (let i = 1; i <= 13; i++) await fetch(`${t.base}/go/x/pet?w=9999-01-${String(i).padStart(2, '0')}&to=/`, { redirect: 'manual', headers: ua });
    await new Promise(r => setTimeout(r, 50));
    expect(Object.keys((await t.store.getTownFile('section_clicks')).data)).toEqual(['2026-10-05']);
  });

  it('with sections off, polls record nothing, and the worker is told they are off', async () => {
    const t = await start({ cfg: { ...CFG, enabled: false } });
    const sub = await t.store.addSubscriber({ email: 'r@example.com', source: 'home' });
    const row = (await t.store.listSubscribers({})).find(x => x.email === 'r@example.com');
    await t.store.confirmSubscriber(row.token);
    const r = await fetch(`${t.base}/p/2026-10-05/went-to-event/0?s=${sub.id || row.id}`, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0' } });
    expect(r.headers.get('location')).toBe('/');
    expect((await fetch(`${t.base}/poll/2026-10-05/went-to-event`)).status).toBe(404);
    const state = await (await fetch(`${t.base}/api/jobs/sections`, { headers: { Authorization: `Bearer ${SECRET}` } })).json();
    expect(state.sections).toEqual({ enabled: false });
  });

  it('gives the worker this week’s pet and places as readers see them', async () => {
    const t = await start();
    await t.putFile('sections', FILE);
    const auth = await t.login();
    await fetch(t.base + '/api/admin/sections/hide', { method: 'POST', headers: auth, body: JSON.stringify({ id: 'place:tx-1' }) });
    const got = (await (await fetch(`${t.base}/api/jobs/sections`, { headers: { Authorization: `Bearer ${SECRET}` } })).json()).sections;
    expect(got.enabled).toBe(true);
    expect(got.pet.name).toBe('Chloe');
    expect(got.new_in_town.map(x => x.name)).toEqual(['Bao Bao Bakery']);
  });

  it('never shows last week’s file, and skips malformed items instead of breaking the email', () => {
    const lastWeek = { ...FILE, week: '2026-09-28' };
    const s = sectionsFor({ cfg: CFG, file: lastWeek, edition: 'weekly', now: NOW });
    expect(s.pet).toBeNull();
    expect(s.places).toEqual([]);
    // Sunday evening's build is for tomorrow's issue: shown on Sunday.
    const sunday = sectionsFor({ cfg: CFG, file: { ...FILE, week: '2026-10-12' }, edition: 'weekly', now: new Date('2026-10-11T23:30:00Z') });
    expect(sunday.pet.name).toBe('Chloe');
    const bad = { ...FILE, new_in_town: [null, 5, { key: 'x', name: 'Ok', line: 'Fine.' }],
      roundup: { answers: [null, { quote: 'One.', name: 'A' }, { quote: 'Two.', name: 'B' }] }, good_news: { items: [null, { title: 'T', line: 'L' }] } };
    const weekly = sectionsFor({ cfg: CFG, file: bad, edition: 'weekly', now: NOW });
    expect(weekly.places.map(x => x.name)).toEqual(['Ok']);
    expect(() => sectionsEmailHtml(weekly, { siteUrl: 'https://x' })).not.toThrow();
    const weekend = sectionsFor({ cfg: CFG, file: bad, edition: 'weekend', now: new Date('2026-10-08T12:00:00Z') });
    expect(weekend.roundup.answers.length).toBe(2);
    expect(() => sectionsEmailHtml(weekend, { siteUrl: 'https://x' })).not.toThrow();
  });

  it('takes out a City Hall item or a quote by its key, so it stays out when items move', () => {
    const file = { ...FILE, good_news: { items: [{ key: 'aaaa1111', title: 'New', line: 'x' }, { key: 'bbbb2222', title: 'Park', line: 'y' }] } };
    const s = sectionsFor({ cfg: CFG, file, hidden: ['good:bbbb2222'], edition: 'weekend', now: new Date('2026-10-08T12:00:00Z') });
    expect(s.good.items.map(x => x.title)).toEqual(['New']);
  });

  it('alerts when the AI had trouble, once a week', async () => {
    const t = await start();
    await t.putFile('sections', { ...FILE, ai_problems: ['the AI call failed (HTTPError)'] });
    expect(t.slack.alerts.map(a => a.key)).toEqual(['sections-ai-2026-10-05']);
    expect(t.slack.alerts[0].text).toContain('the AI call failed');
  });

  it('tells Slack once a week, not on every run (builds and the before-send checks)', async () => {
    const t = await start();
    const file = { ...FILE, ai_problems: ['the AI call failed (HTTPError 429)'], source_problems: ["pets: County Shelter didn't answer (HTTPError 403)"] };
    for (let i = 0; i < 4; i++) await t.putFile('sections', file);
    expect(t.slack.alerts.map(a => a.key)).toEqual(['sections-ai-2026-10-05', 'sections-sources-2026-10-05']);
    expect(t.slack.alerts[1].text).toContain('County Shelter');
    expect(t.slack.notes.filter(n => /sections ready/.test(n.title)).length).toBe(1);
    // What readers will see changed (the pet was adopted): one more note.
    await t.putFile('sections', { ...file, pet: { ...FILE.pet, name: 'Biscuit' } });
    expect(t.slack.notes.filter(n => /sections ready/.test(n.title)).map(n => /Biscuit/.test(n.text))).toEqual([false, true]);
    // The next week alerts again.
    await t.putFile('sections', { ...file, week: '2026-10-12' });
    expect(t.slack.alerts.length).toBe(4);
  });
});

describe('new places: a map and when', () => {
  it('says when a place opened or opens, only as sure as its source', () => {
    expect(placeWhen({ grand_opening: '2026-10-28' }, '2026-10-21')).toBe('Grand opening Oct 28');
    expect(placeWhen({ opened: '2026-10-18' }, '2026-10-21')).toBe('Just opened');
    expect(placeWhen({ opened: '2026-10-02' }, '2026-10-21')).toBe('Opened early October');
    expect(placeWhen({ opened: '2026-09-15' }, '2026-10-21')).toBe('Opened mid September');
    expect(placeWhen({ opens: '2026-11-25' }, '2026-10-21')).toBe('Expected to open late November');
    expect(placeWhen({ opens: '2026-10-19' }, '2026-10-21')).toBe('Just opened');
    expect(placeWhen({ name: 'No date' }, '2026-10-21')).toBe('');
    expect(placeWhen({ opened: 'soon' }, '2026-10-21')).toBe('');
  });

  it('links each place to its map, in the email, on the site and through the click counter', async () => {
    const x = { name: 'Chai Filipino Food', street: 'NE Zac Lentz Pkwy' };
    expect(placeMapUrl(x)).toBe('https://www.google.com/maps/search/?api=1&query=Chai%20Filipino%20Food%2C%20NE%20Zac%20Lentz%20Pkwy%2C%20Victoria%2C%20TX');
    const file = { ...FILE, new_in_town: [{ ...FILE.new_in_town[0], street: 'NE Zac Lentz Pkwy', opened: '2026-09-15' }] };
    const s = sectionsFor({ cfg: CFG, file, edition: 'weekly', now: NOW });
    const html = sectionsEmailHtml(s, { siteUrl: 'https://www.thevic361.com' });
    expect(html).toContain(encodeURIComponent(placeMapUrl(file.new_in_town[0])));
    expect(html).toContain('Opened mid September');
    expect(html).toContain('id="new-in-town"');
    const t = await start();
    await t.putFile('sections', file);
    const to = placeMapUrl(file.new_in_town[0]);
    const r = await fetch(`${t.base}/go/x/places?w=2026-10-05&to=${encodeURIComponent(to)}`, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0' } });
    expect(r.headers.get('location')).toBe(to);
    const page = await (await fetch(`${t.base}/new-in-town`)).text();
    expect(page).toContain(`href="${placeMapUrl(file.new_in_town[0]).replace(/&/g, '&amp;')}"`);
    expect(page).toContain('Opened mid September');
  });
});

describe('readers’ replies and poll votes: privacy', () => {
  it('a “forget me” deletes them, and the purge keeps replies 30 days and votes a year', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sx-privacy-'));
    const store = new FileStore(path.join(dir, 's.json'));
    const now = Date.now();
    const iso = days => new Date(now - days * 86400000).toISOString();
    await store.saveReaderReply({ id: 'r1', created_at: iso(1), name: 'Pat', email: 'pat@example.com', subject: 'My answer: x', text: 'Tacos' });
    await store.saveReaderReply({ id: 'r2', created_at: iso(2), name: 'Lee', email: 'lee@example.com', subject: 'My answer: x', text: 'Pie' });
    const data = JSON.parse(await fs.readFile(store.file, 'utf8'));
    data.subscribers.push({ id: 'sub-pat', email: 'pat@example.com', status: 'active' });
    data.reader_replies.push({ id: 'old', created_at: iso(40), name: 'Old', email: 'old@example.com', subject: '', text: 'old' });
    data.poll_votes = [{ week: '2026-10-05', poll: 'p', subscriber_id: 'sub-pat', choice: 0, at: iso(1), first_at: iso(1) },
      { week: '2024-10-07', poll: 'p', subscriber_id: 'sub-x', choice: 1, at: iso(400), first_at: iso(400) },
      { week: '2026-10-05', poll: 'p', subscriber_id: 'sub-y', choice: 1, at: iso(1), first_at: iso(1) }];
    await fs.writeFile(store.file, JSON.stringify(data));
    await store.purgePersonalData({ submissionsBefore: iso(9999), contactBefore: iso(9999) });
    const out = await store.forgetEmail('pat@example.com', 'p•••@example.com');
    expect(out).toMatchObject({ reader_replies: 1, poll_votes: 1 });
    const after = JSON.parse(await fs.readFile(store.file, 'utf8'));
    expect(after.reader_replies.map(r => r.id)).toEqual(['r2']);
    expect(after.poll_votes.map(v => v.subscriber_id)).toEqual(['sub-y']);
  });
});

describe('readers’ replies: what is kept for the roundup', () => {
  it('keeps answers and replies to an issue, not a new email to news@', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sx-replies-'));
    const store = new FileStore(path.join(dir, 's.json'));
    const sx = createSections({ store, cfg: CFG, log: { warn() {} } });
    const at = new Date().toISOString();
    const save = (id, subject) => sx.saveReply({ id, from: 'Pat Doe <pat@example.com>', email: 'pat@example.com', subject, text: 'Tacos at Rosita', at });
    expect(await save('a', 'My answer: Best tacos?')).toBe(true);
    expect(await save('b', 'Re: This week in Victoria')).toBe(true);
    expect(await save('c', 'Question about your newsletter')).toBe(false);
    expect(await save('d', 'Re: Sponsor order')).toBe(false);
    expect((await sx.listReplies('2000-01-01')).map(r => r.subject)).toEqual(['My answer: Best tacos?', 'Re: This week in Victoria']);
  });
});

describe('which towns and pages show the sections', () => {
  it('a paused town shows none, and a page shows only when a source can fill it', () => {
    expect(sectionsConfig({ id: 'kearney', dormant: true }, { env: {} }).enabled).toBe(false);
    expect(sectionsConfig({ id: 'kearney', dormant: true }, { env: { SECTIONS: '1' } }).enabled).toBe(false);
    expect(sectionsConfig({ id: 'kearney' }, { env: {} }).enabled).toBe(true);
    expect(sectionPages(sectionsConfig({ id: 'medford' }, { env: {} })).map(p => p.path)).toEqual(['/new-in-town', '/pets']);
    expect(sectionPages(sectionsConfig({ id: 'victoria' }, { env: {} })).map(p => p.path)).toEqual(['/new-in-town', '/pets', '/city-hall']);
    expect(sectionPages({ enabled: false, pets: [{}] })).toEqual([]);
  });
});
