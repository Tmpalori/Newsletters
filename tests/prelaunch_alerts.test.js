// @vitest-environment node
//
// A town that hasn't collected yet has no candidates.json and no events by
// design. Its auto-publish on boot and the hourly check's "only 0 upcoming"
// used to alert on every deploy of main (and did, on Kearney, the moment its
// workflows were turned on before its first collect); they stay quiet until
// the town has collected and its workflows are on. Victoria alerts as before.

import { describe, it, expect, afterEach } from 'vitest';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { town as current, useTown, VICTORIA } from '../server/town.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NOW = new Date('2026-10-07T17:00:00Z');
const BAY = { id: 'bay', siteName: 'The Bay 979', domain: 'thebay979.com', city: 'Bay City', state: 'TX', stateName: 'Texas', timezone: 'America/Chicago' };

function fakeSlack() {
  const alerts = [];
  return { alerts, enabled: true, notify: async () => true, alert: async (k, t, text) => { alerts.push({ k, t, text }); return true; } };
}

async function boot({ town = VICTORIA, workflows = false, collected = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-prelaunch-'));
  const store = new FileStore(path.join(dir, 's.json'));
  if (collected) await store.setPublished({ events: [], auto_publish: { from: '2026-10-04T20:30:00Z' } });
  const eventsFile = path.join(dir, 'events.json');
  await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
  if (workflows) process.env.TOWN_WORKFLOWS = '1';
  const slack = fakeSlack();
  const app = await createApp({
    storeBundle: { kind: 'file', store }, eventsFile,
    candidatesFile: path.join(dir, 'missing-candidates.json'),
    ...(town === VICTORIA ? {} : { town }),
    trustProxy: false, slack, now: () => NOW, startScheduler: false,
    siteUrl: town === VICTORIA ? 'https://www.thevic361.com' : `https://www.${town.domain}`,
    autoPublish: true, autoPublishDelayMs: 0
  });
  await new Promise(r => setTimeout(r, 50));
  expect(current.id).toBe(town === VICTORIA ? 'victoria' : town.id);
  return { slack, healthCheck: app.healthCheck };
}

afterEach(() => { delete process.env.TOWN_WORKFLOWS; useTown(VICTORIA); });

describe('alerts before a town can collect', () => {
  it('a town with workflows off: no auto-publish or empty-list alert', async () => {
    const { slack, healthCheck } = await boot({ town: BAY });
    expect(slack.alerts.filter(a => a.k === 'auto-publish')).toEqual([]);
    expect((await healthCheck(NOW)).problems).not.toContain('upcoming');
  });

  it('workflows on but no collect yet: still quiet', async () => {
    const { slack, healthCheck } = await boot({ town: BAY, workflows: true });
    expect(slack.alerts.filter(a => a.k === 'auto-publish')).toEqual([]);
    expect((await healthCheck(NOW)).problems).not.toContain('upcoming');
  });

  it('collected but workflows off: no "0 upcoming" (it can\'t collect again)', async () => {
    const { healthCheck } = await boot({ town: BAY, collected: true });
    expect((await healthCheck(NOW)).problems).not.toContain('upcoming');
  });

  it('the same town once it has collected and its workflows are on: alerts as usual', async () => {
    const { slack, healthCheck } = await boot({ town: BAY, workflows: true, collected: true });
    expect(slack.alerts.find(a => a.k === 'auto-publish').t).toBe('Auto-publish could not run');
    expect((await healthCheck(NOW)).problems).toContain('upcoming');
  });

  it('Victoria always alerts', async () => {
    const { slack, healthCheck } = await boot();
    expect(slack.alerts.find(a => a.k === 'auto-publish').t).toBe('Auto-publish could not run');
    expect((await healthCheck(NOW)).problems).toContain('upcoming');
  });
});
