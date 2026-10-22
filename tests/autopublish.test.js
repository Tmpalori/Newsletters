// @vitest-environment node
//
// Auto-publish (server/autopublish.js): collector candidates go live without
// the admin, but the admin's removals stick.

import { AUTO_PUBLISH_RULES } from '../server/autopublish.js';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const NOW = new Date('2026-10-05T15:00:00Z'); // Mon Oct 5

let tmpDir, server, baseUrl, store, sent;

async function start({ candidates, published = null, extra = {}, storeKind = 'file' } = {}) {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-auto-'));
  const candidatesFile = path.join(tmpDir, 'candidates.json');
  const eventsFile = path.join(tmpDir, 'events.json');
  await fs.writeFile(candidatesFile, JSON.stringify(candidates));
  await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
  store = new FileStore(path.join(tmpDir, 's.json'));
  if (published) await store.setPublished(published);
  sent = [];
  const { app } = await createApp({
    storeBundle: { kind: storeKind, store }, eventsFile, candidatesFile, trustProxy: false, now: () => NOW,
    siteUrl: 'https://www.thevic361.com', adminUsername: 'a', adminPassword: 'b', adminSessionSecret: 'c',
    slack: { enabled: true, notify: async (m) => { sent.push(m); return true; }, alert: async () => {} },
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

async function auth() {
  const r = await fetch(baseUrl + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'a', password: 'b' }) });
  return { Authorization: `Bearer ${(await r.json()).token}`, 'Content-Type': 'application/json' };
}
const runNow = async () => (await fetch(baseUrl + '/api/admin/auto-publish', { method: 'POST', headers: await auth() })).json();
const live = async () => (await fetch(baseUrl + '/events.json')).json();

const CANDIDATES = {
  last_updated: '2026-10-04T23:40:00-05:00',
  events: [
    { date: '2026-10-01', name: 'Already Happened', time: '7:00 PM', venue: 'X' },
    { date: '2026-10-09', name: 'Friday Live Music', time: '8:00 PM', venue: 'Aero Crafters', _source: 'apify_facebook' },
    { date: '2026-10-10', name: 'Farmers Market', time: '8:00 AM', venue: 'Market Square' },
    { date: '2026-10-10', name: 'Fall Festival 2026', time: '11:00 AM', venue: 'De Leon Plaza' }
  ]
};

describe('auto-publish', () => {
  it('publishes upcoming candidates, keeps prior events and extras, hides bookkeeping', async () => {
    await start({
      candidates: CANDIDATES,
      published: {
        last_updated: '2026-09-28T00:00:00Z',
        sponsor: { name: 'Acme' },
        events: [
          { date: '2026-10-10', name: 'Fall Festival', time: '11:00 AM', venue: 'De Leon Plaza' }, // hand-picked, same event
          { date: '2026-09-20', name: 'Old Event', time: '1 PM', venue: 'Y' }
        ]
      }
    });
    const r = await runNow();
    expect(r).toMatchObject({ ok: true, published: 3, added: 2, kept: 1 });

    const d = await live();
    expect(d.events.map(e => e.name)).toEqual(['Friday Live Music', 'Farmers Market', 'Fall Festival']);
    expect(d.sponsor.name).toBe('Acme');
    expect(d.auto_publish).toBeUndefined();
    expect(JSON.stringify(d)).not.toContain('_source');
    expect(sent[0].title).toBe('🗓️ Published 3 events automatically');
  });

  it("doesn't re-add an event the admin removed", async () => {
    await start({ candidates: CANDIDATES });
    await runNow();
    const h = await auth();
    // Admin takes Farmers Market down with Save & Publish.
    const keep = (await live()).events.filter(e => e.name !== 'Farmers Market');
    await fetch(baseUrl + '/api/admin/publish-events', { method: 'POST', headers: h, body: JSON.stringify({ events: keep }) });

    const r = await runNow();
    expect(r.skipped_removed).toBe(1);
    expect((await live()).events.map(e => e.name)).not.toContain('Farmers Market');
  });

  it("doesn't re-add a removed event under a reworded AI name", async () => {
    const bash = { date: '2026-10-10', name: 'Halloween Bash', time: '9:00 PM', venue: 'Moonshine Drinkery', _source: 'apify_facebook_posts' };
    await start({ candidates: { last_updated: 'r1', events: [bash] } });
    await runNow();
    const h = await auth();
    await fetch(baseUrl + '/api/admin/publish-events', { method: 'POST', headers: h, body: JSON.stringify({ events: [] }) });
    // Next run the model words the same post differently.
    await fs.writeFile(path.join(tmpDir, 'candidates.json'), JSON.stringify({
      last_updated: 'r2', events: [{ ...bash, name: 'Halloween Bash at Moonshine' }]
    }));
    const r = await runNow();
    expect(r).toMatchObject({ added: 0, skipped_removed: 1 });
    expect((await live()).events).toEqual([]);
  });

  it("doesn't re-add a hidden event under a reworded name once it's gone from the list", async () => {
    const key = '2026-10-10|Halloween Bash|Moonshine Drinkery';
    await start({
      candidates: { last_updated: 'r2', events: [{ date: '2026-10-10', name: 'Halloween Bash Party', time: '9:00 PM', venue: 'Moonshine Drinkery', _source: 'apify_instagram_posts' }] },
      published: { last_updated: 'x', events: [], hidden: [{ key, why: 'non-event' }], auto_publish: { from: 'r1', keys: [], rejected: [] } }
    });
    const r = await runNow();
    expect(r).toMatchObject({ added: 0, skipped_removed: 1 });
  });

  it('a removed event never blocks an approved submission with a similar name', async () => {
    await start({
      candidates: { last_updated: 'r2', events: [] },
      published: { last_updated: 'x', events: [], auto_publish: { from: 'r1', keys: [], rejected: ['2026-10-10|Fall Fest|Riverside Park'] } }
    });
    await store.insert({ id: 's1', status: 'approved', source: 'submission', created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
      payload: { date: '2026-10-10', name: 'Fall Fest Riverside', time: '5:00 PM', venue: 'Riverside Park', description: 'Fun.', icons: [] } });
    await runNow();
    expect((await live()).events.map(e => e.name)).toEqual(['Fall Fest Riverside']);
  });

  it('folds reworded copies of one listing already live (same venue, date and start)', async () => {
    // Real copies from candidates.json (2026-10-07 and 10-19): the farmers
    // market's posts and the YAML, and the film society's Monday screening.
    const yaml = { date: '2026-10-07', name: "Victoria Farmers' Market", time: '9:00 AM – 1:00 PM', venue: 'Victoria Farmers Market',
      address: '2805 N. Navarro St.', description: 'Hand-written.', _source: 'local_events', curated: true };
    const wed = { date: '2026-10-07', name: 'Wednesday Market', time: '9 AM–1 PM', venue: 'Victoria Farmers Market', description: 'Post copy.', _source: 'apify_facebook_posts' };
    const mid = { ...wed, name: 'Midweek Market' };
    const film = { date: '2026-10-19', name: 'Victoria Film Society presents “Friday the 13th” (1980)', time: '07:00 PM', venue: 'Moonshine Drinkery', _source: 'allevents' };
    const movie = { date: '2026-10-19', name: 'Movie Night: Friday the 13th', time: '7:00 PM', venue: 'Moonshine Drinkery', _source: 'local_events', curated: true };
    const ig = { date: '2026-10-19', name: 'Monday Movie Nights with Victoria Film Society', time: '7:00 PM', venue: 'Moonshine Drinkery', _source: 'apify_instagram_posts' };
    // A different show at the same venue and minute stays.
    const other = { date: '2026-10-19', name: 'Bourbon Society Mixer', time: '7:00 PM', venue: 'Moonshine Drinkery', _source: 'allevents' };
    await start({ candidates: { last_updated: 'r1', events: [yaml, film] } });
    await runNow();
    await fs.writeFile(path.join(tmpDir, 'candidates.json'), JSON.stringify({ last_updated: 'r2', events: [wed, yaml, mid, ig, movie, film, other] }));
    const r = await runNow();
    const names = (await live()).events.map(e => e.name);
    expect(names).toEqual(["Victoria Farmers' Market", 'Victoria Film Society presents “Friday the 13th” (1980)', 'Bourbon Society Mixer']);
    expect(r.added).toBe(1);
    // The post copy never overwrote the owner's listing.
    const market = (await live()).events.find(e => e.name === "Victoria Farmers' Market");
    expect(market).toMatchObject({ description: 'Hand-written.', curated: true });
  });

  it('includes approved submissions', async () => {
    await start({ candidates: { last_updated: 'x', events: [] } });
    await store.insert({
      id: 's1', status: 'approved', source: 'submission', created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
      payload: { date: '2026-10-08', name: 'Church Fish Fry', time: '5:00 PM', venue: 'St. Mary', description: 'Fish.', icons: ['food'] }
    });
    await runNow();
    expect((await live()).events.map(e => e.name)).toEqual(['Church Fish Fry']);
  });

  it('runs on boot once per candidates file', async () => {
    await start({ candidates: CANDIDATES, extra: { autoPublish: true, autoPublishDelayMs: 0 } });
    await vi.waitFor(async () => expect((await live()).events).toHaveLength(3), { timeout: 2000 });
    const at = (await store.getPublished()).auto_publish.at;

    // Same candidates on the next boot: nothing changes.
    await new Promise(r => server.close(r));
    const { app } = await createApp({
      storeBundle: { kind: 'file', store }, eventsFile: path.join(tmpDir, 'events.json'),
      candidatesFile: path.join(tmpDir, 'candidates.json'), trustProxy: false, now: () => NOW,
      siteUrl: 'https://www.thevic361.com', autoPublish: true, autoPublishDelayMs: 0,
      slack: { enabled: false, notify: async () => false, alert: async () => false }
    });
    server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    await new Promise(r => setTimeout(r, 100)); // checks nothing changes, so a fixed wait
    expect((await store.getPublished()).auto_publish.at).toBe(at);
  });

  it('takes down auto-added events two runs no longer find, but never hand-added or edited ones', async () => {
    const key = ev => [ev.date, ev.name, ev.venue].join('|');
    const wrongBingo = { date: '2026-10-05', name: 'Bingo Night', time: '7:00 PM', venue: 'J Welch Farms' };
    const wrongMusic = { date: '2026-10-11', name: 'Live Music', time: '7:00 PM', venue: 'J Welch Farms' };
    const editedAuto = { date: '2026-10-07', name: 'Trivia', time: '7:00 PM', venue: 'Shooters' };
    const stillFound = { date: '2026-10-09', name: 'Friday Live Music', time: '8:00 PM', venue: 'Aero Crafters' };
    const handAdded = { date: '2026-10-12', name: 'Hand Pick', time: '6:00 PM', venue: 'Somewhere' };
    await start({
      candidates: CANDIDATES,
      published: {
        last_updated: '2026-10-03T00:00:00Z',
        events: [wrongBingo, wrongMusic, editedAuto, stillFound, handAdded],
        auto_publish: { from: 'older', keys: [wrongBingo, wrongMusic, editedAuto, stillFound].map(key), rejected: [] }
      }
    });
    await store.upsertEventEdit({ original_key: key(editedAuto), payload: { ...editedAuto, time: '8:00 PM' } });

    // Keys from before sources were recorded: one miss isn't enough.
    expect((await runNow()).retired).toBe(0);
    expect((await store.getPublished()).auto_publish.missing).toEqual({ [key(wrongBingo)]: 1, [key(wrongMusic)]: 1 });
    // (One more find keeps the run looking healthy now that run 1 added two.)
    await fs.writeFile(path.join(tmpDir, 'candidates.json'), JSON.stringify({
      ...CANDIDATES, last_updated: 'second run', events: [...CANDIDATES.events, { date: '2026-10-13', name: 'Extra Show', time: '7:00 PM', venue: 'Elsewhere' }]
    }));
    sent.length = 0;
    const r = await runNow();
    expect(r.retired).toBe(2);
    const names = (await live()).events.map(e => `${e.date} ${e.name}`);
    expect(names).not.toContain('2026-10-05 Bingo Night');
    expect(names).not.toContain('2026-10-11 Live Music');
    expect(names).toEqual(expect.arrayContaining(['2026-10-07 Trivia', '2026-10-09 Friday Live Music', '2026-10-12 Hand Pick']));
    expect(sent[0].fields).toContainEqual(['Taken down (no longer found)', 2]);

    // Retired isn't "removed by the admin": a later run that finds it again brings it back.
    const state = (await store.getPublished()).auto_publish;
    expect(state.rejected).not.toContain(key(wrongBingo));
    await fs.writeFile(path.join(tmpDir, 'candidates.json'), JSON.stringify({
      last_updated: 'next', events: [...CANDIDATES.events, wrongBingo]
    }));
    await runNow();
    expect((await live()).events.map(e => `${e.date} ${e.name}`)).toContain('2026-10-05 Bingo Night');
  });

  it('takes nothing down when the new run looks broken', async () => {
    const ours = Array.from({ length: 10 }, (_, i) => ({ date: '2026-10-08', name: `Event ${i}`, time: '7:00 PM', venue: `V${i}` }));
    await start({
      candidates: { last_updated: 'broken', events: [{ date: '2026-10-09', name: 'Lonely', venue: 'X' }] },
      published: { events: ours, auto_publish: { from: 'older', keys: ours.map(e => [e.date, e.name, e.venue].join('|')) } }
    });
    const r = await runNow();
    expect(r.retired).toBe(0);
    expect((await live()).events).toHaveLength(11);
  });

  it('re-applies new publish rules on boot even when candidates are unchanged', async () => {
    const wrong = { date: '2026-10-05', name: 'Bingo Night', time: '7:00 PM', venue: 'J Welch Farms' };
    await start({
      candidates: CANDIDATES,
      // Published by the old rules from these same candidates (no "rules" marker).
      published: {
        events: [wrong, ...CANDIDATES.events.slice(1).map(({ _source, ...e }) => e)],
        auto_publish: { from: CANDIDATES.last_updated, keys: [[wrong.date, wrong.name, wrong.venue].join('|')] }
      },
      extra: { autoPublish: true, autoPublishDelayMs: 0 }
    });
    await vi.waitFor(async () => expect((await store.getPublished()).auto_publish.rules).toBe(AUTO_PUBLISH_RULES), { timeout: 2000 });
    // The re-run counts the first miss (one isn't enough to take it down).
    expect((await store.getPublished()).auto_publish.missing).toEqual({ [[wrong.date, wrong.name, wrong.venue].join('|')]: 1 });
    expect((await live()).events.map(e => e.name)).toContain('Bingo Night');
  });

  it("updates events it published with the collector's newer copy, never hand-made, edited, hidden or submitted ones", async () => {
    const key = ev => [ev.date, ev.name, ev.venue].join('|');
    // As live on 2026-10-05, published from the 2026-09-28 candidates.
    const party = { date: '2026-10-06', name: 'Community Connection Party', time: '04:00 PM',
      venue: '3102 Miori Ln., Victoria, TX, United States, Texas 77901', address: '3102 Miori Ln',
      url: 'https://allevents.in/victoria/community-connection-party/200030386823634', description: 'Party.' };
    const comedy = { date: '2026-10-09', name: 'Next Stop Comedy at LA CANTINA!', time: '9:00 PM',
      venue: 'La Cantina Tacos & Tequila', address: '', url: '', description: 'Stand-up.' };
    const quilt = { date: '2026-10-15', name: 'Sugar Skull Embroidery with Quilt Guild of Greate', time: '5:30PM – 6:30PM',
      venue: 'Victoria Public Library', address: '302 N. Main St.', url: 'https://victoriapl.librarycalendar.com/event/copy-adult-program-9348' };
    const edited = { date: '2026-10-07', name: 'Trivia', time: '7:00 PM', venue: 'Shooters', url: '' };
    const hiddenOne = { date: '2026-10-08', name: 'Karaoke', time: '9:00 PM', venue: '402 E North St', url: '' };
    const handAdded = { date: '2026-10-10', name: 'Hand Pick', time: '6:00 PM', venue: 'Somewhere', url: '' };
    const submitted = { date: '2026-10-11', name: 'Fall Craft Fair', time: '9:00 AM', venue: 'Community Center', description: 'Their words.' };
    const fresh = {
      last_updated: '2026-10-07T20:30:00-05:00',
      events: [
        { ...party, venue: '3102 Miori Ln.', address: '3102 Miori Ln.', _source: 'allevents' },
        { ...comedy, address: '212 S. Main St.', url: 'https://www.eventbrite.com/e/next-stop-comedy-123', _source: 'apify_eventbrite' },
        { ...quilt, name: 'Sugar Skull Embroidery with Quilt Guild of Greater Victoria', _source: 'library' },
        { ...edited, url: 'https://x.example/trivia' },
        { ...hiddenOne, venue: '', address: '402 E North St', url: 'https://x.example/karaoke' },
        { ...handAdded, url: 'https://x.example/hand' },
        { ...submitted, description: 'Collector words.', url: 'https://x.example/fair' }
      ]
    };
    await start({
      candidates: fresh,
      published: {
        last_updated: '2026-10-05T00:00:00Z',
        events: [party, comedy, quilt, edited, hiddenOne, handAdded, submitted],
        hidden: [{ key: key(hiddenOne), page: '/events/2026-10-08-karaoke', date: hiddenOne.date, reason: 'test' }],
        auto_publish: { from: 'older', rules: 2, keys: [party, comedy, quilt, edited, hiddenOne, submitted].map(key) }
      }
    });
    await store.upsertEventEdit({ original_key: key(edited), payload: { ...edited, time: '8:00 PM' } });
    await store.insert({ id: 's1', status: 'approved', source: 'submission', created_at: NOW.toISOString(), updated_at: NOW.toISOString(), payload: submitted });

    const r = await runNow();
    expect(r).toMatchObject({ updated: 4, added: 0, retired: 0 });
    const pub = await store.getPublished();
    const byDate = Object.fromEntries(pub.events.map(e => [e.date, e]));
    expect(byDate['2026-10-06']).toMatchObject({ name: 'Community Connection Party', venue: '3102 Miori Ln.', address: '3102 Miori Ln.' });
    expect(byDate['2026-10-09']).toMatchObject({ address: '212 S. Main St.', url: 'https://www.eventbrite.com/e/next-stop-comedy-123' });
    expect(byDate['2026-10-15'].name).toBe('Sugar Skull Embroidery with Quilt Guild of Greater Victoria');
    // Admin-edited, hand-added and submitted events are untouched.
    expect(byDate['2026-10-07']).toEqual(edited);
    expect(byDate['2026-10-10']).toEqual(handAdded);
    expect(byDate['2026-10-11']).toEqual({ ...submitted, submitted: true }); // the flag the score's bonus reads
    // The hidden one gets the link but keeps its key, so it stays hidden.
    expect(byDate['2026-10-08']).toMatchObject({ venue: '402 E North St', url: 'https://x.example/karaoke' });
    expect((await live()).events.map(e => e.name)).not.toContain('Karaoke');
    // Bookkeeping follows the new keys: nothing reads as "removed by the admin".
    expect(pub.auto_publish.keys).toEqual(expect.arrayContaining(pub.events.filter(e => e !== byDate['2026-10-07'] && e !== byDate['2026-10-10'] && e !== byDate['2026-10-11']).map(key)));
    expect(pub.auto_publish.rejected).toEqual([]);
    expect(pub.auto_publish.keys).not.toContain(key(party));

    // The next run with the same events changes nothing and re-adds nothing.
    await fs.writeFile(path.join(tmpDir, 'candidates.json'), JSON.stringify({ ...fresh, last_updated: 'next' }));
    const again = await runNow();
    expect(again).toMatchObject({ updated: 0, added: 0, retired: 0, skipped_removed: 0 });
    expect((await store.getPublished()).events).toHaveLength(7);
    await new Promise(r => setTimeout(r, 50)); // let the archive write finish before cleanup
  });

  it('only takes a new name when the published one was cut off', async () => {
    const { cutOff } = await import('../server/autopublish.js');
    expect(cutOff('Healthy South Texas Cooking Well Exploring Cultur', 'Healthy South Texas Cooking Well Exploring Cultures')).toBe(true);
    expect(cutOff('Healthy South Texas - Cooking Well Exploring Cult', 'Healthy South Texas Cooking Well Exploring Cultures')).toBe(true);
    expect(cutOff('Scenic Root — Once Upon...', 'Scenic Root — Once Upon A Plant')).toBe(true);
    expect(cutOff('Tejas Fest', 'Tejas Fest 2026')).toBe(false);
    expect(cutOff('Fall Festival', 'Victoria Fall Festival')).toBe(false);
    expect(cutOff('Long Name Here', 'Long Name')).toBe(false);
  });

  it('publishes New & Notable from the collector and keeps recent checked earlier finds for three weeks', async () => {
    const recent = { name: 'Arcade opens on Navarro', description: 'x', tag: 'new', icon: 'music', url: 'https://a.example', added: '2026-09-25', checked: true };
    const stale = { name: 'Old opening', description: 'x', tag: 'new', icon: 'food', url: 'https://b.example', added: '2026-09-01', checked: true };
    // Found before the collector checked links (Virginia Beach, Oct 2026: a
    // 404 and a made-up Instagram post): recent, but it leaves the box.
    const unchecked = { name: 'Front Porch Cafe', description: 'x', tag: 'coming', icon: 'food', url: 'https://d.example/404', added: '2026-09-28' };
    const legacy = { name: 'Hand item from before', description: 'x', tag: 'coming', icon: 'food' }; // no date
    const fresh = { name: 'Ellianos Coffee opens', description: 'y', tag: 'new', icon: 'food', url: 'https://c.example', added: '2026-10-05' };
    await start({
      candidates: { ...CANDIDATES, new_and_notable: [fresh, { ...recent, description: 'dupe by name' }] },
      published: { events: [], new_and_notable: [recent, stale, legacy, unchecked] }
    });
    await runNow();
    const d = await live();
    expect(d.new_and_notable.map(n => n.name)).toEqual(['Ellianos Coffee opens', 'Arcade opens on Navarro']);
  });

  it('leaves New & Notable alone when the candidates predate it', async () => {
    const item = { name: 'Kept as is', description: 'x', tag: 'new', icon: 'food' };
    await start({ candidates: CANDIDATES, published: { events: [], new_and_notable: [item] } });
    await runNow();
    expect((await live()).new_and_notable).toEqual([item]);
  });

  it('takes down unchecked finds even when the candidates have no New & Notable list', async () => {
    const hand = { name: 'Hand item', description: 'x', tag: 'new', icon: 'food' };
    const checked = { name: 'Checked find', description: 'x', tag: 'new', icon: 'food', url: 'https://a.example', added: '2026-10-05', checked: true };
    const unchecked = { name: 'Front Porch Cafe', description: 'x', tag: 'coming', icon: 'food', url: 'https://d.example/404', added: '2026-10-05' };
    await start({ candidates: CANDIDATES, published: { events: [], new_and_notable: [hand, checked, unchecked] } });
    await runNow();
    expect((await live()).new_and_notable.map(n => n.name)).toEqual(['Hand item', 'Checked find']);
  });

  it('is off by default outside production', async () => {
    await start({ candidates: CANDIDATES });
    await new Promise(r => setTimeout(r, 50)); // checks nothing runs, so a fixed wait
    expect(await store.getPublished()).toBeNull();
  });
});

describe('admin setup checklist', () => {
  it('needs a login and reports presence only', async () => {
    await start({ candidates: CANDIDATES });
    expect((await fetch(baseUrl + '/api/admin/setup')).status).toBe(401);
    await runNow();
    const r = await (await fetch(baseUrl + '/api/admin/setup', { headers: await auth() })).json();
    expect(r.ok).toBe(true);
    const byKey = Object.fromEntries(r.checks.map(c => [c.key, c]));
    expect(byKey.login.ok).toBe(true);
    expect(byKey.slack.ok).toBe(true);
    expect(byKey.database.ok).toBe(false);
    expect(byKey.social.ok).toBeNull();
    expect(r.status.upcoming_events).toBe(3);
    expect(r.status.collected_at).toBe(CANDIDATES.last_updated);
    expect(JSON.stringify(r)).not.toMatch(/"b"|"c"/); // no password/secret values
  });

  it('flags cron secrets that share one value', async () => {
    const checks = async () => Object.fromEntries((await (await fetch(baseUrl + '/api/admin/setup', { headers: await auth() })).json())
      .checks.map(c => [c.key, c.ok]));

    // Only the newsletter secret set: the other two still work through the
    // fallback, but all three share it.
    const saved = process.env.NEWSLETTER_CRON_SECRET;
    process.env.NEWSLETTER_CRON_SECRET = 'only-one-secret';
    try {
      await start({ candidates: CANDIDATES });
      const c = await checks();
      expect([c.event_check, c.submission_review, c.separate_secrets]).toEqual([true, true, false]);
    } finally {
      if (saved === undefined) delete process.env.NEWSLETTER_CRON_SECRET; else process.env.NEWSLETTER_CRON_SECRET = saved;
    }
    await new Promise(r => server.close(r));
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

    await start({ candidates: CANDIDATES, extra: { newsletterCronSecret: 'n', eventCheckSecret: 'e', submissionReviewSecret: 's' } });
    expect((await checks()).separate_secrets).toBe(true);
  });

  it('counts the Postgres store as set up', async () => {
    // server/db.js names it 'postgres'; the check once looked for 'pg' and always warned.
    await start({ candidates: CANDIDATES, storeKind: 'postgres' });
    const r = await (await fetch(baseUrl + '/api/admin/setup', { headers: await auth() })).json();
    expect(r.checks.find(c => c.key === 'database').ok).toBe(true);
  });
});

describe('client IP behind Railway', () => {
  it('ignores a forged X-Forwarded-For and uses the edge X-Real-IP', async () => {
    const { createApp: make } = await import('../server/index.js');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-ip-'));
    const { app } = await make({ storeBundle: { kind: 'file', store: new FileStore(path.join(dir, 's.json')) },
      trustProxy: 1, railway: true, adminUsername: 'a', adminPassword: 'b', adminSessionSecret: 'c' });
    const srv = http.createServer(app);
    await new Promise(r => srv.listen(0, r));
    const url = `http://127.0.0.1:${srv.address().port}/api/admin/login`;
    const tryLogin = (xff) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': xff, 'X-Real-IP': '203.0.113.9' },
      body: JSON.stringify({ username: 'a', password: 'wrong' }) });
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await tryLogin(`10.0.0.${i}`)).status);
    expect(codes).toContain(429);
    await new Promise(r => srv.close(r));
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
});

describe('auto-publish with far-ahead hand-added events', () => {
  const scraped = n => Array.from({ length: n }, (_, i) => ({
    date: `2026-10-${String(6 + (i % 10)).padStart(2, '0')}`, name: `Scraped ${i}`, time: '7:00 PM', venue: `Venue ${i}`, _source: 'allevents'
  }));
  const local = n => Array.from({ length: n }, (_, i) => ({
    date: `2026-11-${String(1 + (i % 28)).padStart(2, '0')}`, name: `Hand ${i}`, time: '6:00 PM', venue: `Place ${i}`,
    _source: 'local_events', curated: true
  }));

  it('a run where every scraper failed takes nothing down, however many hand-added events it has', async () => {
    await start({ candidates: { last_updated: '2026-10-04T23:00:00-05:00', events: [...scraped(20), ...local(40)] } });
    expect((await runNow()).ok).toBe(true);
    const before = (await live()).events.map(e => e.name).sort();
    expect(before.filter(n => n.startsWith('Scraped')).length).toBeGreaterThan(10);
    // Next run: scrapers all failed, only the 40 hand-added events came back
    // (40 is more than 0.6 × everything live).
    await fs.writeFile(path.join(tmpDir, 'candidates.json'), JSON.stringify({ last_updated: '2026-10-05T23:00:00-05:00', events: local(40) }));
    expect((await runNow()).ok).toBe(true);
    expect((await live()).events.map(e => e.name).sort()).toEqual(before);
  });

  it('a tag taken off in the YAML comes off the live event; appeal and sources stay', async () => {
    const ev = { date: '2026-10-15', name: 'Cuero Turkeyfest', time: '10:00 AM', venue: 'Downtown Cuero', _source: 'local_events' };
    await start({ candidates: { last_updated: '2026-10-04T23:00:00-05:00', events: [{ ...ev, big: true, town: 'Cuero', curated: true, appeal: 5, sources: 2 }] } });
    await runNow();
    await fs.writeFile(path.join(tmpDir, 'candidates.json'), JSON.stringify({
      last_updated: '2026-10-05T23:00:00-05:00', events: [{ ...ev, curated: true }]
    }));
    await runNow();
    const [now] = (await live()).events;
    // recurring is sticky: a weekly staple shouldn't flicker between runs.
    expect(now.big).toBeUndefined();
    expect(now.town).toBeUndefined();
    expect(now).toMatchObject({ curated: true, appeal: 5, sources: 2 });
  });

  it('tags added to the YAML later reach the live event', async () => {
    const ev = { date: '2026-10-15', name: 'Symphonic Spooktacular', time: '5:30 PM', venue: 'Victoria Fine Arts Center', _source: 'local_events' };
    await start({ candidates: { last_updated: '2026-10-04T23:00:00-05:00', events: [ev] } });
    await runNow();
    await fs.writeFile(path.join(tmpDir, 'candidates.json'), JSON.stringify({
      last_updated: '2026-10-05T23:00:00-05:00', events: [{ ...ev, big: true, curated: true, town: 'Victoria' }]
    }));
    await runNow();
    const [live1] = (await live()).events;
    expect(live1).toMatchObject({ big: true, curated: true, town: 'Victoria' });
  });
});

describe('auto-publish retires only reliable misses', () => {
  const filler = Array.from({ length: 5 }, (_, i) => ({
    date: '2026-10-08', name: `Library Program ${i}`, time: '10:00 AM', venue: `Room ${i}`, _source: 'library'
  }));
  const ok = { library: 'ok', allevents: 'ok', apify_instagram_posts: 'ok', gemini_search: 'ok' };
  const write = (from, events, sources = ok) =>
    fs.writeFile(path.join(tmpDir, 'candidates.json'), JSON.stringify({ last_updated: from, events: [...filler, ...events], sources }));
  const names = async () => (await live()).events.map(e => e.name);
  const comedy = { date: '2026-10-12', name: 'Comedy Night', time: '8:00 PM', venue: 'The Club', _source: 'allevents' };

  it('never takes down an event found in posts', async () => {
    const post = { date: '2026-10-10', name: 'Oktoberfest Party', time: '6:00 PM', venue: 'Some Bar', _source: 'apify_instagram_posts' };
    const both = { date: '2026-10-11', name: 'Harvest Fair', time: '9:00 AM', venue: 'Fairgrounds', _source: 'gemini_search', _also_from: ['apify_facebook_posts'] };
    await start({ candidates: { last_updated: 'r1', events: [...filler, post, both], sources: { ...ok, apify_facebook_posts: 'ok' } } });
    await runNow();
    expect((await store.getPublished()).auto_publish.sources).toMatchObject({
      '2026-10-10|Oktoberfest Party|Some Bar': ['apify_instagram_posts'],
      '2026-10-11|Harvest Fair|Fairgrounds': ['gemini_search', 'apify_facebook_posts']
    });
    for (const from of ['r2', 'r3', 'r4']) {
      await write(from, [], { ...ok, apify_facebook_posts: 'ok' });
      expect((await runNow()).retired).toBe(0);
    }
    expect(await names()).toEqual(expect.arrayContaining(['Oktoberfest Party', 'Harvest Fair']));
  });

  it("takes down a post's copy once the collector lists the event once, under the same long name", async () => {
    // Oct 2026, Shoals: the golf tournament went live twice (the course, and
    // the athletics page that posted it); the collector now merges them.
    const course = { date: '2026-10-10', name: 'Jack Karnes Memorial Golf Tournament', time: '9:00 AM', venue: 'Cypress Lakes', _source: 'allevents' };
    const post = { ...course, time: '', venue: 'North Alabama Athletics', _source: 'apify_facebook_posts' };
    await start({ candidates: { last_updated: 'r1', events: [...filler, course, post], sources: { ...ok, apify_facebook_posts: 'ok' } } });
    await runNow();
    expect((await names()).filter(n => n === course.name)).toHaveLength(2);
    await write('r2', [course], { ...ok, apify_facebook_posts: 'ok' });
    expect((await runNow()).retired).toBe(1);
    const evs = (await live()).events;
    expect(evs.filter(e => e.name === course.name).map(e => e.venue)).toEqual(['Cypress Lakes']);
  });

  it('takes down a Gemini-only event after two misses, like other sources', async () => {
    // Gemini's answer was its only evidence; once it stops finding it, it goes.
    const gem = { date: '2026-10-12', name: 'Weekly Karaoke', time: '8:00 PM', venue: 'Casa Jalisco', _source: 'gemini_search' };
    await start({ candidates: { last_updated: 'r1', events: [...filler, gem], sources: ok } });
    await runNow();
    // Gemini didn't run ok: no miss counts.
    await write('r2', [], { ...ok, gemini_search: 'error' });
    expect((await runNow()).retired).toBe(0);
    await write('r3', []);
    expect((await runNow()).retired).toBe(0);
    expect(await names()).toContain('Weekly Karaoke');
    await write('r4', []);
    expect((await runNow()).retired).toBe(1);
    expect(await names()).not.toContain('Weekly Karaoke');
  });

  it('needs two runs in a row, each with its source ok', async () => {
    await start({ candidates: { last_updated: 'r1', events: [...filler, comedy], sources: ok } });
    await runNow();
    // allevents broke for two runs: nothing counts.
    await write('r2', [], { ...ok, allevents: 'error' });
    expect((await runNow()).retired).toBe(0);
    await write('r3', [], { ...ok, allevents: 'empty' });
    expect((await runNow()).retired).toBe(0);
    // First real miss; a forced re-run of the same candidates isn't a second.
    await write('r4', []);
    expect((await runNow()).retired).toBe(0);
    expect((await runNow()).retired).toBe(0);
    expect(await names()).toContain('Comedy Night');
    // Second real miss.
    await write('r5', []);
    expect((await runNow()).retired).toBe(1);
    expect(await names()).not.toContain('Comedy Night');
  });

  it('never retires an approved submission the collector does not list, and retires nothing when submissions are unreadable', async () => {
    const sub = { date: '2026-10-09', name: 'Church Fish Fry', time: '5:00 PM', venue: 'St. Mary', description: 'Fish.', icons: ['food'] };
    await start({ candidates: { last_updated: 'r1', events: [...filler, comedy], sources: ok } });
    await store.insert({ id: 's1', status: 'approved', source: 'submission', created_at: NOW.toISOString(), updated_at: NOW.toISOString(), payload: sub });
    await runNow();
    expect((await store.getPublished()).auto_publish.keys).toContain('2026-10-09|Church Fish Fry|St. Mary');
    for (const from of ['r2', 'r3', 'r4']) {
      await write(from, [comedy]);
      const r = await runNow();
      expect(r).toMatchObject({ retired: 0, added: 0 });
    }
    expect(await names()).toContain('Church Fish Fry');
    expect((await store.getPublished()).auto_publish.missing).toEqual({});

    // Comedy Night misses one run; on the second the submissions read fails:
    // nothing comes down, the submission included.
    await write('r5', []);
    await runNow();
    vi.spyOn(store, 'list').mockRejectedValue(new Error('db down'));
    await write('r6', []);
    expect((await runNow()).retired).toBe(0);
    expect(await names()).toEqual(expect.arrayContaining(['Church Fish Fry', 'Comedy Night']));
    vi.restoreAllMocks();
  });

  it('a find in between starts the count over', async () => {
    await start({ candidates: { last_updated: 'r1', events: [...filler, comedy], sources: ok } });
    await runNow();
    await write('r2', []);
    await runNow();
    await write('r3', [comedy]);
    await runNow();
    await write('r4', []);
    expect((await runNow()).retired).toBe(0);
    expect(await names()).toContain('Comedy Night');
  });
});

describe('auto-publish keeps the week so far', () => {
  it('keeps events from earlier this week, never ones from before Monday, and never takes a past one down', async () => {
    const now = new Date('2026-10-10T15:00:00Z'); // Sat Oct 10
    const published = {
      last_updated: '2026-10-08T00:00:00Z',
      events: [
        { date: '2026-10-04', name: 'Last Sunday', time: '1 PM', venue: 'A' },
        { date: '2026-10-05', name: 'Monday Trivia', time: '7 PM', venue: 'B' },
        { date: '2026-10-08', name: 'Thursday Show', time: '8 PM', venue: 'C' },
        { date: '2026-10-11', name: 'Sunday Brunch', time: '11 AM', venue: 'D' }
      ],
      auto_publish: { from: 'old', rules: AUTO_PUBLISH_RULES, keys: [], missing: { '2026-10-08|thursday show|c': 1 }, sources: { '2026-10-08|thursday show|c': ['apify_facebook'] } }
    };
    published.auto_publish.keys = published.events.map(e => `${e.date}|${e.name.toLowerCase()}|${e.venue.toLowerCase()}`);
    // The collector no longer lists any of them; Sunday Brunch is upcoming.
    // The admin took a Tuesday event down earlier in the week.
    published.auto_publish.rejected = ['2026-10-06|removed tuesday|f'];
    // The collector lists the week from Monday: a Tuesday event the site
    // dropped before fills back in; the removed one stays out. It no
    // longer lists the published ones; Sunday Brunch is upcoming.
    await start({ candidates: { last_updated: '2026-10-10T05:00:00Z', events: [
      { date: '2026-10-03', name: 'Before Monday', time: '1 PM', venue: 'G' },
      { date: '2026-10-06', name: 'Tuesday Talk', time: '6 PM', venue: 'H' },
      { date: '2026-10-06', name: 'Removed Tuesday', time: '6 PM', venue: 'F' },
      { date: '2026-10-12', name: 'Next Week', time: '6 PM', venue: 'E' }
    ] }, published, extra: { now: () => now } });
    const r = await runNow();
    expect(r.ok).toBe(true);
    const names = (await live()).events.map(e => e.name);
    expect(names).toContain('Monday Trivia');
    expect(names).toContain('Thursday Show');   // past: not retired even after a second miss
    expect(names).toContain('Tuesday Talk');    // earlier this week, from the collector
    expect(names).not.toContain('Removed Tuesday');
    expect(names).not.toContain('Last Sunday');  // before this Monday: dropped as before
    expect(names).not.toContain('Before Monday');
    expect(names).toContain('Next Week');
    expect(names).toContain('Sunday Brunch');
  });
});
