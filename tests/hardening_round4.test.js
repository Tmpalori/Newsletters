// @vitest-environment node
//
// Hardening round 4: the event page and calendar links don't repeat a
// place; shared-meridiem ranges start when they say; the footer year is
// Victoria's; the approved list auto-publish reads isn't capped; impossible
// dates are rejected; admin sessions end when the password changes; a
// permanently refused "you're live" email stops retrying; resumed newsletter
// chunks keep their idempotency key; a paid placement read failure doesn't
// send an issue without it; a paid cancelled pick re-checks the day cap;
// retryLive is off the request path; a statement timeout isn't an outage;
// boot migrations don't take a table lock when nothing changes.

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as seo from '../server/seo.js';
import * as guides from '../server/guides.js';

const SITE = 'https://www.thevic361.com';
const NOW = new Date('2026-10-07T17:00:00Z');

afterEach(() => { vi.useRealTimers(); });

describe('event page and calendar links name the place once', () => {
  const ev = seo.withPages([{ date: '2026-10-09', name: 'Garage Sale', time: '8:00 AM', venue: '3102 Miori Ln.', address: '3102 Miori Ln' }])[0];
  const same = seo.withPages([{ date: '2026-10-09', name: 'Market Day', venue: 'Riverside Park', address: 'Riverside Park' }])[0];

  it('event page lead and description', () => {
    const page = seo.renderEventPage(same, [same], { siteUrl: SITE, now: NOW });
    expect(page).not.toContain('Riverside Park, Riverside Park');
    expect(page).toContain('at Riverside Park in Victoria, TX.');
    const page2 = seo.renderEventPage(ev, [ev], { siteUrl: SITE, now: NOW });
    expect(page2).not.toMatch(/3102 Miori Ln\.?, 3102 Miori Ln/);
  });

  it('.ics LOCATION and the Google Calendar location', () => {
    expect(guides.renderIcs(ev, { siteUrl: SITE, now: NOW })).toContain('LOCATION:3102 Miori Ln.\\, Victoria\\, TX');
    const url = new URL(guides.googleCalendarUrl(same, SITE));
    expect(url.searchParams.get('location')).toBe('Riverside Park, Victoria, TX');
    const both = seo.withPages([{ date: '2026-10-09', name: 'X', venue: 'The PumpHouse', address: '128 W Constitution St' }])[0];
    expect(new URL(guides.googleCalendarUrl(both, SITE)).searchParams.get('location'))
      .toBe('The PumpHouse, 128 W Constitution St, Victoria, TX');
  });
});

describe('startHour reads a shared-meridiem range from its start', () => {
  const tonight = seo.HUB_PAGES.find(p => p.path === '/tonight');
  it('"1-4 PM" is an afternoon event, not tonight', () => {
    expect(tonight.filter({ time: '1-4 PM' })).toBe(false);
    expect(tonight.filter({ time: '7-10 PM' })).toBe(true);
    expect(tonight.filter({ time: '6:00 PM' })).toBe(true);
    expect(tonight.filter({ time: '10:00 AM' })).toBe(false);
  });
});

describe('footer year', () => {
  it('is the year in Victoria, not UTC, on the evening of Dec 31', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-01-01T01:30:00Z')); // Dec 31, 7:30 PM Central
    const html = seo.renderAboutPage({ siteUrl: SITE });
    expect(html).toContain('&copy; 2026 The Vic 361');
    expect(html).not.toContain('&copy; 2027');
  });
});

describe('validation', () => {
  const base = {
    name: 'Fall Fair', date: '2026-11-14', time: '9:00 AM', venue: 'Community Center', address: '2905 E North St',
    description: 'Crafts.', submitter_first_name: 'Pat', submitter_last_name: 'Doe',
    submitter_email: 'pat@example.com', submitter_phone: '361-555-1234', submitter_kind: 'organizer'
  };
  it('rejects dates that do not exist instead of rolling them over', async () => {
    const { validateSubmission, validateEventEdit } = await import('../server/validate.js');
    expect(validateSubmission(base).ok).toBe(true);
    expect(validateEventEdit(base).ok).toBe(true);
    for (const date of ['2026-11-31', '2026-02-30', '2026-13-01', '2026-00-10']) {
      expect(validateSubmission({ ...base, date }).errors.date, date).toBe('Date is invalid.');
      expect(validateEventEdit({ ...base, date }).ok, date).toBe(false);
    }
    expect(validateSubmission({ ...base, date: '2028-02-29' }).ok).toBe(true);
  });
  it('rejects submitter emails Resend refuses', async () => {
    const { validateSubmission } = await import('../server/validate.js');
    for (const e of ['bob@gmail.com.', 'bob@gmail..com']) {
      expect(validateSubmission({ ...base, submitter_email: e }).errors.submitter_email, e).toBeTruthy();
    }
  });
});

describe('retryLive is bounded', () => {
  it('leaves rows for the next run once its deadline passes', async () => {
    const { retryLive } = await import('../server/submissionReview.js');
    const rows = [1, 2].map(i => ({ id: `s${i}`, status: 'approved', payload: { date: '2026-10-10', name: `E${i}` },
      ai_review: { live_pending: 'x' } }));
    const onApproved = vi.fn(async () => true);
    const store = { update: vi.fn(async () => null) };
    const out = await retryLive({ store, publish: async () => ({ ok: true }), onApproved, nowFn: () => NOW, rows, deadline: Date.now() - 1 });
    expect(out).toEqual([]);
    expect(onApproved).not.toHaveBeenCalled();
    expect(store.update).not.toHaveBeenCalled();
  });
});

describe('database', () => {
  // Records every query; answers information_schema with `columns`.
  function fakePool(columns = []) {
    const calls = [];
    return { calls, query: async (text, params) => {
      calls.push({ text: String(text), params: params || [] });
      if (/information_schema\.columns/.test(text)) return { rows: columns };
      return { rows: [] };
    } };
  }

  it('the approved list for upcoming dates has no 500-row cap; the admin list keeps it', async () => {
    const { PgStore } = await import('../server/db.js');
    const pool = fakePool();
    const store = new PgStore(pool);
    await store.list({ status: 'approved', fromDate: '2026-10-07' });
    const q = pool.calls.at(-1);
    expect(q.text).not.toMatch(/LIMIT/);
    expect(q.text).toMatch(/payload->>'date' >= \$2/);
    expect(q.params).toEqual(['approved', '2026-10-07']);
    await store.list({});
    expect(pool.calls.at(-1).text).toMatch(/LIMIT 500/);
  });

  it('auto-publish reads every upcoming approval, not the newest 500', async () => {
    const { FileStore } = await import('../server/db.js');
    const { createAutoPublish } = await import('../server/autopublish.js');
    const { promises: fs } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-r4-'));
    try {
      const store = new FileStore(path.join(dir, 's.json'));
      const old = { id: 'old', created_at: '2025-01-01T00:00:00Z', status: 'approved', source: 'submission',
        payload: { date: '2026-12-20', name: 'Christmas Parade', venue: 'Downtown', time: '6:00 PM' }, review_history: [] };
      await store.insert(old);
      await store.setPublished({ last_updated: 'x', events: [] });
      // What Postgres did with 500 newer approvals: the old one fell off.
      const real = store.list.bind(store);
      store.list = async (o = {}) => (o.fromDate ? real(o) : (await real(o)).filter(r => r.id !== 'old'));
      const candidatesFile = path.join(dir, 'c.json');
      await fs.writeFile(candidatesFile, JSON.stringify({ last_updated: 'c', events: [] }));
      const ap = createAutoPublish({ store, candidatesFile, readJsonFile: async f => JSON.parse(await fs.readFile(f, 'utf8')),
        siteUrl: SITE, slack: null, archiveEvents: async () => {}, nowFn: () => NOW });
      await ap.run({ force: true, quiet: true, submissionsOnly: true });
      expect(((await store.getPublished()) || { events: [] }).events.map(e => e.name)).toContain('Christmas Parade');
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it('a statement timeout does not open the breaker; a dropped connection still does', async () => {
    const { isOutage, breakerPool } = await import('../server/db.js');
    expect(isOutage(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }))).toBe(false);
    expect(isOutage(Object.assign(new Error('terminating connection'), { code: '57P01' }))).toBe(true);
    expect(isOutage(Object.assign(new Error('x'), { code: '08006' }))).toBe(true);
    expect(isOutage(new Error('Connection terminated unexpectedly'))).toBe(true);
    // Checkout timeout with every client busy: slow queries, not an outage.
    const busy = { totalCount: 10, idleCount: 0, options: { max: 10 } };
    expect(isOutage(new Error('timeout exceeded when trying to connect'), busy)).toBe(false);
    expect(isOutage(new Error('timeout exceeded when trying to connect'), { totalCount: 0, idleCount: 0, options: { max: 10 } })).toBe(true);

    let n = 0;
    const pool = { query: async (t) => { n++; if (t === 'slow') throw Object.assign(new Error('statement timeout'), { code: '57014' }); return { rows: [] }; } };
    const b = breakerPool(pool);
    await expect(b.query('slow')).rejects.toThrow(/statement timeout/);
    expect(b.open).toBe(false);
    await expect(b.query('fast')).resolves.toEqual({ rows: [] });
    expect(n).toBe(2);
  });

  it('boot skips ALTER TABLE for columns that already exist', async () => {
    const { PgStore } = await import('../server/db.js');
    const all = [['event_submissions', 'ai_review'], ['traffic', 'ad'], ['newsletter_sends', 'failed_emails'], ['newsletter_sends', 'picks'], ['newsletter_sends', 'events'], ['newsletter_sends', 'chunks'],
      ['subscribers', 'old_tokens'], ['subscribers', 'ref_code'], ['subscribers', 'referred_by'], ['subscribers', 'ref_tier'], ['subscribers', 'reminded_at'], ['subscribers', 'pending_since'], ['subscribers', 'weekend_optout'],
      ['subscribers', 'soft_bounces'], ['subscribers', 'soft_bounce_first_at'], ['subscribers', 'soft_bounce_last_at'],
      ['ad_spend', 'restated_from'], ['ad_spend', 'restated_at'],
      ['subscribers', 'bounced_at'], ['subscribers', 'unsub_reason']]
      .map(([table_name, column_name]) => ({ table_name, column_name }));
    const pool = fakePool(all);
    await new PgStore(pool).ready();
    expect(pool.calls.filter(c => /ALTER TABLE/.test(c.text))).toEqual([]);
    const fresh = fakePool([{ table_name: 'traffic', column_name: 'ad' }]);
    await new PgStore(fresh).ready();
    const alters = fresh.calls.filter(c => /ALTER TABLE/.test(c.text)).map(c => c.text);
    expect(alters).toHaveLength(19);
    // The referral code's unique constraint comes with its column (one
    // statement), never as a separate index build on boot.
    expect(pool.calls.some(c => /CREATE UNIQUE INDEX/.test(c.text))).toBe(false);
    expect(fresh.calls.some(c => /CREATE UNIQUE INDEX/.test(c.text))).toBe(false);
    expect(alters).toContain('ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS ref_code TEXT UNIQUE');
    expect(alters.some(t => /traffic/.test(t))).toBe(false);
  });
});

describe('admin sessions', () => {
  it('a token stops working once ADMIN_PASSWORD changes; the format is unchanged', async () => {
    const { createAuth } = await import('../server/auth.js');
    const before = createAuth({ username: 'owner', password: 'old-pass', secret: 's'.repeat(32) });
    const token = before.signToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(before.verifyToken(token).ok).toBe(true);
    const after = createAuth({ username: 'owner', password: 'new-pass', secret: 's'.repeat(32) });
    expect(after.verifyToken(token)).toEqual({ ok: false, reason: 'bad-signature' });
    expect(after.verifyToken(after.signToken()).ok).toBe(true);
  });
});
