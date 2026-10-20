// @vitest-environment node
//
// The HQ summary's subscriber history (server/hq.js, growth.js
// activeByDay): each day's active count from the rows themselves, never
// below zero; bounces and spam complaints counted as leaving; and the
// list's own counts recorded once a day, with a drop flagged. Both stores.

import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { FileStore } from '../server/db.js';
import { buildSummary } from '../server/hq.js';
import { dailyGrowth, activeByDay } from '../server/growth.js';
import { VICTORIA } from '../server/town.js';

const NOW = new Date('2026-10-09T18:00:00Z');   // Friday, Central
const at = day => `${day}T15:00:00.000Z`;
const summary = store => buildSummary({ store, nowFn: () => NOW, town: VICTORIA, siteUrl: 'https://www.thevic361.com',
  getEvents: async () => [], getOrders: async () => [], setup: async () => ({ checks: [], status: {} }), health: async () => null });

// 3 still active; 4 joined in the window and bounced Oct 5 (a wave like the
// Resend failure); 2 bounced before bounced_at was kept; 1 complained;
// 1 never confirmed and was taken off; 1 waiting.
const ROWS = [
  ...[1, 2, 3].map(i => ({ id: `a${i}`, status: 'active', confirmed_at: at('2026-09-15') })),
  ...[1, 2, 3, 4].map(i => ({ id: `b${i}`, status: 'bounced', confirmed_at: at('2026-09-20'), bounced_at: at('2026-10-05') })),
  ...[1, 2].map(i => ({ id: `o${i}`, status: 'bounced', confirmed_at: at('2026-09-01'), bounced_at: null })),
  { id: 'c1', status: 'unsubscribed', confirmed_at: at('2026-09-25'), unsubscribed_at: at('2026-10-01'), unsub_reason: 'complaint' },
  { id: 'p1', status: 'unsubscribed', confirmed_at: null, unsubscribed_at: at('2026-10-02'), unsub_reason: 'bad_address' },
  { id: 'w1', status: 'pending', created_at: at('2026-09-20'), pending_since: at('2026-09-20') }
];

function stub(extra = {}) {
  return { listSubscriberStats: async () => ROWS, listNewsletterSends: async () => [], listTraffic: async () => [], ...extra };
}

describe('the subscriber history', () => {
  it('counts each day from the rows, so a wave of bounces never pushes early days below zero', async () => {
    const s = (await summary(stub())).subscribers;
    expect(s.active).toBe(3);
    expect(s.daily.every(d => d.active >= 0)).toBe(true);
    const day = d => s.daily.find(x => x.day === d);
    expect(day('2026-09-15').active).toBe(3);
    expect(day('2026-09-25').active).toBe(3 + 4 + 1);
    expect(day('2026-10-01')).toMatchObject({ active: 7, left: 1, unsubscribed: 1, complaints: 1, bounced: 0 });
    expect(day('2026-10-05')).toMatchObject({ active: 3, left: 4, bounced: 4 });
    expect(s.daily.at(-1)).toMatchObject({ day: '2026-10-09', active: 3 });
  });

  it('counts bounces and complaints as leaving, and never-confirmed removals as nothing', async () => {
    const s = (await summary(stub())).subscribers;
    expect(s).toMatchObject({ joined_30_days: 8, left_30_days: 5, unsubscribed_30_days: 1, bounced_30_days: 4, complaints_30_days: 1,
      net_30_days: 3, pending_older_than_7_days: 1 });
    const g = dailyGrowth(ROWS, [], { today: '2026-10-09', days: 31 });
    expect(g.find(d => d.day === '2026-10-02').unsubscribed).toBe(0);
  });

  it('is what the old count worked back from today would have been, minus the bug', () => {
    // activeByDay on its own: undated leavers count as gone on every day.
    expect(activeByDay(ROWS, ['2026-09-10', '2026-10-09'])).toEqual([0, 3]);
  });

  it('flags a drop of a fifth or more against the last recorded day, and records today', async () => {
    const saved = [];
    const s = (await summary(stub({
      saveSubscriberCounts: async (day, c) => { saved.push([day, c]); },
      listSubscriberCounts: async () => [{ day: '2026-10-08', active: 50, pending: 1, bounced: 2, unsubscribed: 1 }, { day: '2026-10-09', active: 3, pending: 1, bounced: 6, unsubscribed: 2 }]
    }))).subscribers;
    expect(saved).toEqual([['2026-10-09', { active: 3, pending: 1, bounced: 6, unsubscribed: 2 }]]);
    expect(s.recorded_daily).toHaveLength(2);
    expect(s.drop_since_last_snapshot).toEqual({ from_day: '2026-10-08', from: 50, to: 3 });
    const small = (await summary(stub({ saveSubscriberCounts: async () => {}, listSubscriberCounts: async () => [{ day: '2026-10-08', active: 10 }] }))).subscribers;
    expect(small.drop_since_last_snapshot).toBeNull();
  });
});

// The store half: bounced_at, unsub_reason and the daily counts.
async function storeChecks(s) {
  const add = async (email) => (await s.confirmSubscriber((await s.addSubscriber({ email, source: 'web' })).token));
  const a = await add('bounce@example.com');
  await add('complain@example.com');
  const c = await add('leave@example.com');
  const soft = await add('soft@example.com');
  expect(a).toBeTruthy();
  await s.markSubscribersBounced(['bounce@example.com']);
  await s.unsubscribeByEmail(['complain@example.com'], 'complaint');
  expect(await s.unsubscribe(c.token)).toBe(true);
  for (const t of ['2026-10-01T00:00:00Z', '2026-10-03T00:00:00Z', '2026-10-06T00:00:00Z', '2026-10-09T00:00:00Z']) {
    await s.recordSoftBounce(['soft@example.com'], new Date(t));
  }
  expect(soft).toBeTruthy();
  const stats = Object.fromEntries((await s.listSubscriberStats()).map(x => [x.status + ':' + (x.unsub_reason || ''), x]));
  const all = await s.listSubscriberStats();
  const bounced = all.filter(x => x.status === 'bounced');
  expect(bounced).toHaveLength(2);
  expect(bounced.every(x => /^\d{4}-/.test(x.bounced_at))).toBe(true);
  expect(bounced.map(x => x.bounced_at).sort()[0]).toBe('2026-10-09T00:00:00.000Z');   // the soft one: its last bounce
  expect(stats['unsubscribed:complaint']).toBeTruthy();
  expect(stats['unsubscribed:unsubscribe']).toBeTruthy();
  // A comeback starts clean.
  await s.addSubscriber({ email: 'bounce@example.com', source: 'web' });
  const back = (await s.listSubscriberStats()).filter(x => x.status === 'pending');
  expect(back).toHaveLength(1);
  expect(back[0]).toMatchObject({ bounced_at: null, unsub_reason: null });
  expect(back[0].pending_since).toMatch(/^\d{4}-/);

  await s.saveSubscriberCounts('2026-10-08', { active: 10, pending: 1, bounced: 0, unsubscribed: 0 });
  await s.saveSubscriberCounts('2026-10-09', { active: 7, pending: 1, bounced: 1, unsubscribed: 0 });
  await s.saveSubscriberCounts('2026-10-09', { active: 8, pending: 2, bounced: 1, unsubscribed: 1 });
  const rows = await s.listSubscriberCounts(31);
  expect(rows.map(({ recorded_at: _r, ...x }) => x)).toEqual([
    { day: '2026-10-08', active: 10, pending: 1, bounced: 0, unsubscribed: 0 },
    { day: '2026-10-09', active: 8, pending: 2, bounced: 1, unsubscribed: 1 }]);
  expect(rows[1].recorded_at).toMatch(/^\d{4}-/);
  expect((await s.listSubscriberCounts(1)).map(x => x.day)).toEqual(['2026-10-09']);
}

describe('FileStore: bounce dates, reasons and daily counts', () => {
  it('keeps them', async () => {
    await storeChecks(new FileStore(path.join(os.tmpdir(), `vic361-subhist-${process.pid}-${Date.now()}.json`)));
  });
});

const PG = process.env.TEST_DATABASE_URL;
describe.skipIf(!PG)('PgStore: bounce dates, reasons and daily counts (TEST_DATABASE_URL)', () => {
  it('keeps them, and backfills a soft bounce\'s date on boot', async () => {
    const { default: pg } = await import('pg');
    const { createStore } = await import('../server/db.js');
    const admin = new pg.Client({ connectionString: PG });
    await admin.connect();
    const dbName = `subhist_${process.pid}_${Date.now()}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(PG);
    url.pathname = `/${dbName}`;
    url.searchParams.set('sslmode', 'disable');
    let bundle = await createStore({ databaseUrl: url.toString() });
    try {
      await storeChecks(bundle.store);
      // A bounce from before bounced_at: the next boot dates it from its last soft bounce.
      await bundle.pool.query(`INSERT INTO subscribers (id, email, status, token, confirmed_at, soft_bounce_last_at)
        VALUES ('old', 'old@example.com', 'bounced', 'tok-old', '2026-09-01', '2026-10-02T12:00:00Z')`);
      await bundle.pool.end();
      bundle = await createStore({ databaseUrl: url.toString() });
      const old = (await bundle.store.listSubscriberStats()).find(x => x.id === 'old');
      expect(old.bounced_at).toBe('2026-10-02T12:00:00.000Z');
    } finally {
      await bundle.pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
      await admin.end();
    }
  });
});
