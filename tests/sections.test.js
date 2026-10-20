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
import { sectionsFor, questionFor, pollFor, firstName, sectionsConfig, mondayOf, sectionsHomeHtml } from '../server/sections.js';

// The first Monday of October: a poll week.
const NOW = new Date('2026-10-05T15:00:00Z');
const SECRET = 's'.repeat(40);
const LONG = { adminUsername: 'admin', adminPassword: 'a-long-enough-pass', adminSessionSecret: 'x'.repeat(32) };
const PHOTO = Buffer.from('ffd8ffe000104a46494600', 'hex').toString('base64');

const CFG = {
  enabled: true,
  questions: ['Best kolache in town?', 'Best sunset spot?'],
  polls: [{ id: 'went-to-event', question: 'Have you gone to something you found here?', choices: ['Yes', 'Not yet'] }]
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
    const id = sub.id || (await t.store.listSubscribers({})).find(x => x.email === 'reader@example.com').id;
    const ua = { 'User-Agent': 'Mozilla/5.0 (iPhone)' };
    const vote = (c, s = id, h = ua) => fetch(`${t.base}/p/2026-10-05/went-to-event/${c}?s=${s}`, { redirect: 'manual', headers: h });
    // A scanner: both choices within seconds → no vote.
    await vote(0);
    clock += 2000;
    await vote(1);
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

  it('hands the worker readers\' replies (words and a first name, never the address)', async () => {
    const t = await start();
    await t.store.saveReaderReply({ id: 'e1', created_at: '2026-10-05T16:00:00Z', name: 'Maria', email: 'm@x.com', subject: 'Re: This week', text: 'Sausage and cheese!' });
    await t.store.saveReaderReply({ id: 'e0', created_at: '2026-09-20T16:00:00Z', name: 'Old', email: 'o@x.com', subject: 'Re', text: 'Last month' });
    const r = await (await fetch(`${t.base}/api/jobs/replies?since=2026-10-05`, { headers: { Authorization: `Bearer ${SECRET}` } })).json();
    expect(r.replies).toEqual([{ at: '2026-10-05T16:00:00Z', name: 'Maria', subject: 'Re: This week', text: 'Sausage and cheese!' }]);
  });
});
