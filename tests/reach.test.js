// @vitest-environment node
//
// The newsletter's reach under every page's signup (server/seo.js
// reachHtml): subscribers and the past week's readers, each only once it's
// a crowd, rounded down; and the readers stat on /advertise.

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { reachHtml, reachNumbers, setReach } from '../server/seo.js';

const NOW = new Date('2026-10-14T17:00:00Z');
let tmpDir, server, baseUrl;
afterEach(async () => {
  setReach(null);
  if (server) await new Promise(r => server.close(r));
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  server = null; tmpDir = null;
});

describe('reachHtml', () => {
  it('shows each number only from its threshold, rounded down', () => {
    expect(reachNumbers({ subscribers: 99, readers: 499 })).toEqual({ subscribers: null, readers: null });
    expect(reachHtml({ subscribers: 99, readers: 499 })).toBe('');
    expect(reachNumbers({ subscribers: 847, readers: 3269 })).toEqual({ subscribers: 840, readers: 3200 });
    expect(reachHtml({ subscribers: 847, readers: 3269 })).toBe('<p class="site-reach">Join 840+ Victoria locals · 3,200 readers this week</p>');
    expect(reachHtml({ subscribers: 40, readers: 612 })).toBe('<p class="site-reach">610 readers this week</p>');
    expect(reachHtml({ subscribers: 1234, readers: 0 })).toBe('<p class="site-reach">Join 1,200+ Victoria locals</p>');
    expect(reachHtml(null)).toBe('');
  });
});

describe('on the site', () => {
  async function startApp({ active, visitors }) {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-reach-'));
    const eventsFile = path.join(tmpDir, 'events.json');
    await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
    const store = new FileStore(path.join(tmpDir, 's.json'));
    store.countSubscribers = async () => ({ active, pending: 0, unsubscribed: 0 });
    for (let i = 0; i < visitors; i++) {
      await store.recordTraffic({ day: '2026-10-13', kind: 'view', path: '/', visitor: `v${i}`, ref_source: 'Direct' });
    }
    const { app } = await createApp({
      storeBundle: { kind: 'file', store }, eventsFile, trustProxy: false, now: () => NOW,
      siteUrl: 'https://www.thevic361.com', analyticsSecret: 'test', stripeSecretKey: 'sk_test', stripeWebhookSecret: 'whsec_test',
      adminUsername: 'a', adminPassword: 'b', adminSessionSecret: 'c'
    });
    server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  }
  const page = async p => (await fetch(baseUrl + p, { headers: { Accept: 'text/html' } })).text();

  it('puts the line under the signup on the homepage and every other page, and the readers on /advertise', async () => {
    await startApp({ active: 847, visitors: 520 });
    const line = '<p class="site-reach">Join 840+ Victoria locals · 520 readers this week</p>';
    for (const p of ['/', '/about', '/this-weekend', '/referral-rules']) expect(await page(p), p).toContain(line);
    expect(await page('/')).not.toContain('<!--REACH-->');
    const ad = await page('/advertise');
    expect(ad).toContain('<strong>520</strong><span>readers on the site this past week</span>');
    expect(ad).toContain('<strong>840+</strong><span>local subscribers</span>');
  });

  it('the checkout pitch, /subscribe and the submit thank-you (GET /api/reach)', async () => {
    await startApp({ active: 847, visitors: 520 });
    for (const pkg of ['weekly', 'featured']) {
      expect(await page(`/advertise/checkout?package=${pkg}`), pkg)
        .toContain('<p class="co-reach">Your ad reaches 520 readers on the site this past week and 840+ newsletter subscribers.</p>');
    }
    expect(await page('/subscribe')).toContain('<p class="sub-crowd">Join 840+ Victoria locals who already get it. 520 people used The Vic 361 this past week.</p>');
    expect(await (await fetch(baseUrl + '/api/reach')).json()).toEqual({ ok: true, subscribers: 840, readers: 520 });
    expect(await page('/submit')).toContain('id="thanks-reach" hidden');
  });

  it('shows nothing while the numbers are small', async () => {
    await startApp({ active: 30, visitors: 12 });
    for (const p of ['/', '/about']) {
      const html = await page(p);
      expect(html, p).not.toContain('site-reach');
      expect(html, p).not.toContain('<!--REACH-->');
    }
    expect(await page('/advertise')).not.toContain('readers on the site');
    expect(await page('/advertise/checkout?package=weekly')).not.toContain('co-reach');
    expect(await page('/subscribe')).not.toContain('sub-crowd');
    expect(await (await fetch(baseUrl + '/api/reach')).json()).toEqual({ ok: true, subscribers: null, readers: null });
  });
});
