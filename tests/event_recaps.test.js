// @vitest-environment node
//
// A free submitter hears how their event did, once, the morning after
// (server/eventRecaps.js; Tristen, Oct 2026), with the same rules as the
// dropped-event notice.

import { describe, it, expect, beforeEach } from 'vitest';
import { createEventRecaps } from '../server/eventRecaps.js';
import { renderSubmissionRecap } from '../server/notify.js';
import { useTown, townConfig, VICTORIA } from '../server/town.js';

// Sunday Oct 25, 2026, 9:35 AM Central; the event was Saturday Oct 24.
const NOW = new Date('2026-10-25T14:35:00Z');
const SAT = '2026-10-24';
const EVENT = { name: 'Fall Fest', date: SAT, time: '6:00 PM', venue: 'Main Plaza', address: '101 Main St', url: 'https://fallfest.example.com' };
const LIVE = { ...EVENT, page: '/e/fall-fest' };

const row = (extra = {}) => ({
  id: '11111111-2222-3333-4444-555555555555', status: 'approved', source: 'submission', created_at: '2026-10-20T15:00:00Z',
  submitter_email: 'pat@example.com', submitter_name: 'Pat Doe', payload: { ...EVENT },
  review_history: [{ at: '2026-10-20T15:00:00Z', action: 'submitted', placement_emails: true }], ...extra
});
const views = (n, day = '2026-10-22') => Array.from({ length: n }, (_, i) => ({ day, kind: 'view', path: '/e/fall-fest', visitor: `v${i}` }));
const TRAFFIC = [
  ...views(42),
  { day: '2026-10-23', kind: 'click', click_type: 'event_click', click_url: 'https://fallfest.example.com', path: '/e/fall-fest', visitor: 'v1' },
  { day: '2026-10-23', kind: 'click', click_type: 'add_to_calendar', path: '/e/fall-fest', visitor: 'v2' },
  { day: '2026-10-23', kind: 'click', click_type: 'share_copy', click_url: '/e/fall-fest', path: '/e/fall-fest', visitor: 'v3' }
];

function setup({ rows = [row()], events = [LIVE], traffic = TRAFFIC, orders = [], deliver = 'sent', checkout = true } = {}) {
  const sent = [], notes = [], updates = [];
  const store = {
    list: async ({ status }) => rows.filter(r => r.status === status),
    update: async (id, patch) => { updates.push({ id, patch }); const r = rows.find(x => x.id === id); Object.assign(r, patch); return r; },
    listTraffic: async () => traffic
  };
  const er = createEventRecaps({
    store, getEvents: async () => events, siteUrl: 'https://www.thevic361.com', address: '1 Main St, Victoria, TX',
    mailer: { deliver: async (to, mail, key) => { sent.push({ to, mail, key }); return deliver; } },
    slack: { notify: m => notes.push(m) }, orders: async () => orders, checkoutEnabled: checkout, log: { warn() {} }
  });
  return { er, sent, notes, updates, rows };
}

beforeEach(() => useTown(VICTORIA));

describe('free submitter recaps', () => {
  it('sends the morning after, with the numbers, a submit link and the upgrade', async () => {
    const t = setup();
    expect(await t.er.run(NOW)).toEqual({ ok: true, sent: 1 });
    const [{ to, mail, key }] = t.sent;
    expect(to).toBe('pat@example.com');
    expect(key).toBe('vic361-submission-recap-11111111-2222-3333-4444-555555555555');
    expect(mail.subject).toBe('How Fall Fest did on The Vic 361');
    expect(mail.text).toContain('- Views of its event page: 42');
    expect(mail.text).toContain('- Clicked through to your link: 1');
    expect(mail.text).toContain('- Added it to their calendar: 1');
    expect(mail.text).toContain('- Shared it: 1');
    expect(mail.text).toContain('https://www.thevic361.com/submit');
    expect(mail.text).toContain('the Vic’s Pick upgrade guarantees your event a spot');
    expect(t.rows[0].review_history.at(-1)).toMatchObject({ action: 'recap', sent: true });
    expect(t.notes[0].title).toBe("📈 Sent Fall Fest's organizer their recap");
  });

  it('only once', async () => {
    const t = setup();
    await t.er.run(NOW);
    await t.er.run(new Date(NOW.getTime() + 86400000));
    expect(t.sent).toHaveLength(1);
  });

  it('not before the event is over, and not after the catch-up window', async () => {
    expect((await setup().er.run(new Date('2026-10-24T14:35:00Z'))).sent).toBe(0);
    expect((await setup().er.run(new Date('2026-10-27T14:35:00Z'))).sent).toBe(1);
    expect((await setup().er.run(new Date('2026-10-28T14:35:00Z'))).sent).toBe(0);
  });

  it('none (recorded) under 5 page views, or when a paid pick was bought for it', async () => {
    const quiet = setup({ traffic: views(4) });
    expect((await quiet.er.run(NOW)).sent).toBe(0);
    expect(quiet.rows[0].review_history.at(-1)).toMatchObject({ action: 'recap', sent: false, note: 'No recap: 4 page views' });
    const paid = setup({ orders: [{ id: 'o1', kind: 'featured', status: 'paid', event: { ...EVENT } }] });
    expect((await paid.er.run(NOW)).sent).toBe(0);
    expect(paid.rows[0].review_history.at(-1)).toMatchObject({ action: 'recap', sent: false });
    expect(paid.sent).toEqual([]);
  });

  it('never for submissions sent before the form said so, admin-added ones, or no email', async () => {
    for (const r of [
      row({ review_history: [{ action: 'submitted' }] }),
      row({ source: 'admin' }),
      row({ submitter_email: '' }),
      row({ status: 'rejected' })
    ]) expect((await setup({ rows: [r] }).er.run(NOW)).sent).toBe(0);
  });

  it('tries again tomorrow when the email failed or the event is not found', async () => {
    for (const t of [setup({ deliver: 'failed' }), setup({ deliver: 'off' }), setup({ events: [] })]) {
      await t.er.run(NOW);
      expect(t.updates).toEqual([]);
      expect(t.notes).toEqual([]);
    }
  });

  it('no upgrade line when checkout is off or the town is paused', async () => {
    const t = setup({ checkout: false });
    await t.er.run(NOW);
    expect(t.sent[0].mail.text).not.toContain('upgrade');
    expect(t.sent[0].mail.text).not.toContain('/advertise');
  });

  it("uses each town's own name for its pick, and skips the link row without a link", () => {
    useTown(townConfig({ TOWN: 'shoals' }));
    const mail = renderSubmissionRecap({ ...EVENT, url: '' }, { page_views: 12 }, { siteUrl: 'https://www.shoalssetlist.com' });
    expect(mail.text).toContain('the Headliner upgrade guarantees your event a spot');
    expect(mail.text).not.toContain('Clicked through');
    expect(mail.subject).toBe('How Fall Fest did on Shoals Setlist');
  });
});
