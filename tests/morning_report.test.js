// @vitest-environment node
//
// HQ's one morning ads message for every town (server/hq.js morningBlocks,
// POST /api/hq/morning), at Tristen's ask (Oct 2026): one Slack message,
// short bullets, instead of one dense message per town.

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { morningBlocks } from '../server/hq.js';
import { slackEscape } from '../server/slack.js';

const KEY = 'hq-test-key-0123456789';
const NOW = new Date('2026-10-18T14:00:00Z');
let server, tmpDir, base, store, posts;

afterEach(async () => {
  if (server) await new Promise(r => server.close(r));
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  server = null; tmpDir = null;
});

async function start() {
  posts = [];
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-morning-'));
  const eventsFile = path.join(tmpDir, 'events.json');
  await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
  store = new FileStore(path.join(tmpDir, 's.json'));
  const { app } = await createApp({ storeBundle: { kind: 'file', store }, eventsFile, trustProxy: false, now: () => NOW,
    siteUrl: 'https://www.thevic361.com', hqApiKey: KEY, startScheduler: false,
    slack: { enabled: true, notify: async () => true, alert: async () => true,
      post: async (text, blocks, channel) => { posts.push({ text, blocks, channel }); return true; } } });
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
}

const running = (name, y, w, sy, sw) => ({ name, status: 'running',
  yesterday: { spend: y, clicks: 10, leads: 3 }, last_7_days: { spend: w, clicks: 70, leads: 20 },
  ...(sy === undefined ? {} : { site: { yesterday: { joined: sy }, last_7_days: { joined: sw } } }), problems: [] });

const TOWNS = [
  running('The Vic 361', 12.34, 80.1, 8, 52),
  running('The Star 402', 10, 70, 5, 40),
  { name: 'The Rogue 541', status: 'stalled', problems: ['Meta ads: $0 spent in the last 7 days with 1 ad on', 'Ad Video is disapproved: check it in Ads Manager'] },
  { name: 'Shoals Setlist', status: 'started', today: { spend: 3.2 } },
  { name: 'Tupelo Current', status: 'off' },
  { name: 'The Crane 308', status: 'off' },
  { name: 'The Tide 757', status: 'missing' }
];

describe('the morning message', () => {
  it('is one message: totals, a short block per town with ads, one line for the rest', () => {
    const { title, blocks } = morningBlocks({ day: 'Sat, Oct 18', towns: TOWNS }, slackEscape);
    expect(title).toBe('📊 Ads this morning · Sat, Oct 18');
    const text = blocks.filter(b => b.type === 'section').map(b => b.text.text);
    expect(text).toEqual([
      '*All towns yesterday:* $22.34 · 13 new subscribers ($1.72 each)\n*Last 7 days:* $150.10 · 92 new subscribers ($1.63 each)',
      '*The Vic 361*\n• Yesterday: $12.34 · 8 new subscribers ($1.54 each)\n• Last 7 days: $80.10 · 52 new subscribers ($1.54 each)',
      '*The Star 402*\n• Yesterday: $10.00 · 5 new subscribers ($2.00 each)\n• Last 7 days: $70.00 · 40 new subscribers ($1.75 each)',
      '*The Rogue 541*\n• ⚠️ Meta ads: $0 spent in the last 7 days with 1 ad on\n• ⚠️ Ad Video is disapproved: check it in Ads Manager',
      '*Shoals Setlist*\n• Ads started today: $3.20 so far'
    ]);
    expect(blocks.at(-1)).toEqual({ type: 'context', elements: [{ type: 'mrkdwn',
      text: 'No ads running: Tupelo Current, The Crane 308 · No report today: The Tide 757' }] });
  });

  it("uses Meta's signups when the site didn't send its own count, and skips totals for one town", () => {
    const { blocks } = morningBlocks({ towns: [running('The Vic 361', 12, 60)] }, slackEscape);
    expect(blocks.map(b => b.type)).toEqual(['header', 'section']);
    expect(blocks[1].text.text).toBe('*The Vic 361*\n• Yesterday: $12.00 · 3 signups on Meta ($4.00 each)\n• Last 7 days: $60.00 · 20 signups on Meta ($3.00 each)');
  });

  it('escapes what it is sent', () => {
    const { blocks } = morningBlocks({ towns: [{ name: '<!channel>', status: 'stalled', problems: ['<@U1> *bold*'] }] }, slackEscape);
    expect(blocks[1].text.text).toBe('*&lt;!channel&gt;*\n• ⚠️ &lt;@U1&gt; *bold*');
  });
});

describe('POST /api/hq/morning and the summary', () => {
  it('posts to the activity channel with the HQ key only', async () => {
    await start();
    const send = body => fetch(base + '/api/hq/morning', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await fetch(base + '/api/hq/morning', { method: 'POST' })).status).toBe(401);
    expect((await send({ towns: [] })).status).toBe(400);
    expect((await send({ day: 'Sat, Oct 18', towns: TOWNS })).status).toBe(200);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ text: '📊 Ads this morning · Sat, Oct 18', channel: 'activity' });
  });

  it("the summary carries the town's last ads report for HQ", async () => {
    await start();
    await store.setTownFile('ads_report', { data: { status: 'running', yesterday: { spend: 5 } }, report: 'x', link: 'https://adsmanager.facebook.com/x' }, NOW);
    const s = await (await fetch(base + '/api/hq/summary', { headers: { Authorization: `Bearer ${KEY}` } })).json();
    expect(s.ads.report).toEqual({ status: 'running', yesterday: { spend: 5 }, link: 'https://adsmanager.facebook.com/x', updated_at: NOW.toISOString() });
  });
});
