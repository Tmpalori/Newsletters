// @vitest-environment node
//
// A free submitter hears how their event did, once, the morning after
// (server/eventRecaps.js; Tristen, Oct 2026), with the same rules as the
// dropped-event notice.

import { describe, it, expect, beforeEach } from 'vitest';
import { createEventRecaps } from '../server/eventRecaps.js';
import { renderSubmissionRecap } from '../server/notify.js';
import { useTown, townConfig, VICTORIA } from '../server/town.js';
import { listViews, newsletterReach, socialPosts, visitsFrom, pickLift, liftOver } from '../server/eventReach.js';
import { renderPickReport } from '../server/notify.js';
import { renderWeekly } from '../server/newsletter.js';

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

function setup({ rows = [row()], events = [LIVE], traffic = TRAFFIC, orders = [], deliver = 'sent', checkout = true, sends = {}, posted = null } = {}) {
  const sent = [], notes = [], updates = [];
  const store = {
    list: async ({ status }) => rows.filter(r => r.status === status),
    update: async (id, patch) => { updates.push({ id, patch }); const r = rows.find(x => x.id === id); Object.assign(r, patch); return r; },
    listTraffic: async () => traffic,
    getNewsletterSend: async key => sends[key] || null,
    getTownFile: async name => (name === 'social_posted' && posted ? { data: posted } : null)
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

  it('shows where it went: its day list, the newsletter, social posts, with a total', async () => {
    const listed = row({ review_history: [...row().review_history, { action: 'listed', on_list: true }] });
    const t = setup({
      rows: [listed],
      traffic: [...TRAFFIC,
        ...Array.from({ length: 30 }, (_, i) => ({ day: '2026-10-21', kind: 'view', path: '/', visitor: `h${i}` })),
        ...Array.from({ length: 10 }, (_, i) => ({ day: '2026-10-23', kind: 'view', path: '/this-weekend', visitor: `w${i}` })),
        ...Array.from({ length: 6 }, (_, i) => ({ day: '2026-10-22', kind: 'view', path: '/e/fall-fest', visitor: `n${i}`, ref_source: 'Newsletter' })),
        ...Array.from({ length: 3 }, (_, i) => ({ day: '2026-10-23', kind: 'view', path: '/e/fall-fest', visitor: `f${i}`, ref_source: 'Facebook' }))],
      sends: { '2026-10-19': { recipients: 3100, events: ['/e/other'] }, '2026-10-22': { recipients: 3150, events: ['/e/fall-fest'] } },
      posted: { '2026-10-22:weekend': { facebook: 'p1', instagram: 'i1', pages: ['/e/fall-fest'] }, '2026-10-24:today': { facebook: 'pending', pages: ['/e/fall-fest'] } }
    });
    await t.er.run(NOW);
    const { text } = t.sent[0].mail;
    expect(text).toContain('3,190 chances to be seen across our site and newsletter');
    expect(text).toContain('- On Saturday’s list on thevic361.com, which was viewed: 40 times');
    expect(text).toContain('- In our Thursday weekend newsletter, copies sent: 3,150');
    expect(text).toContain('- In our Facebook and Instagram posts: 1 post');
    expect(text).toContain('- Views of its event page: 51');
    expect(text).toContain('- Visits from our newsletter: 6');
    expect(text).toContain('- Visits from our social posts: 3');
    expect(text).toContain('That total is list views on the site plus newsletter copies sent.');
    expect(t.notes[0].fields).toContainEqual(['Newsletter copies', 3150]);
  });

  it('leaves out the places it never appeared', async () => {
    const t = setup({ sends: { '2026-10-19': { recipients: 3100, events: [] } } });
    await t.er.run(NOW);
    const { text } = t.sent[0].mail;
    expect(text).not.toContain('chances to be seen');
    expect(text).not.toContain('newsletter, copies');
    expect(text).not.toContain('list on');
    expect(text).not.toContain('posts:');
  });

  it("checks on its day whether it made the list, once", async () => {
    const today = new Date('2026-10-24T14:35:00Z');
    const t = setup({ events: [{ ...LIVE, overflow: true }] });
    await t.er.run(today);
    await t.er.run(today);
    expect(t.rows[0].review_history.filter(h => h.action === 'listed')).toEqual([expect.objectContaining({ on_list: false, note: "Not on its day's list" })]);
    expect(t.sent).toEqual([]);
  });

  it('tells how paid picks did against other events, when it clearly helps', async () => {
    // Three picks with 40 views each, twelve other events with 10.
    const day = d => `2026-10-${String(d).padStart(2, '0')}`;
    const evs = [LIVE, ...Array.from({ length: 15 }, (_, i) => ({ name: `E${i}`, date: day(5 + i), venue: 'V', page: `/e/e${i}` }))];
    const traffic = [...TRAFFIC, ...evs.slice(1).flatMap((e, i) => Array.from({ length: i < 3 ? 40 : 10 }, (_, j) => ({ day: e.date, kind: 'view', path: e.page, visitor: `x${j}` })))];
    const orders = evs.slice(1, 4).map((e, i) => ({ id: `o${i}`, kind: 'featured', status: 'paid', event: { ...e } }));
    const t = setup({ events: evs, traffic, orders });
    await t.er.run(NOW);
    expect(t.sent[0].mail.text).toContain('This past month, Vic’s Picks got about 4× the page views of other events.');
    // Not enough picks to say: no claim.
    const few = setup({ events: evs, traffic, orders: orders.slice(0, 2) });
    await few.er.run(NOW);
    expect(few.sent[0].mail.text).not.toContain('This past month');
  });
});

describe('event reach numbers', () => {
  const v = (day, path, n, extra = {}) => Array.from({ length: n }, (_, i) => ({ day, kind: 'view', path, visitor: `${path}${i}`, ...extra }));

  it('counts the day lists that showed it, on the days they did', () => {
    const traffic = [...v('2026-10-19', '/', 5), ...v('2026-10-25', '/', 50), ...v('2026-10-17', '/', 50),
      ...v('2026-10-22', '/this-weekend', 4), ...v('2026-10-24', '/today', 3), ...v('2026-10-23', '/today', 50),
      ...v('2026-10-14', '/next-week', 2), ...v('2026-10-21', '/next-week', 50)];
    expect(listViews(traffic, '2026-10-24')).toBe(14);
    // A Wednesday event isn't on /this-weekend.
    expect(listViews([...v('2026-10-19', '/this-weekend', 9), ...v('2026-10-19', '/', 1)], '2026-10-21')).toBe(1);
  });

  it('newsletter issues, social posts and visits only where it was', () => {
    expect(newsletterReach([{ recipients: 10, events: ['/a'] }, { recipients: 20, events: ['/b'] }], '/a')).toEqual({ issues: [{ day: 'Monday', recipients: 10 }], recipients: 10 });
    expect(newsletterReach([null, { recipients: 0, events: ['/a'] }], '/a').recipients).toBe(0);
    const posted = { '2026-10-20:week': { facebook: 'p', pages: ['/a'] }, '2026-10-10:week': { facebook: 'old', pages: ['/a'] },
      '2026-10-23:today': { facebook: 'pending', pages: ['/a'] }, '2026-10-22:weekend': { instagram: 'i', pages: ['/b'] } };
    expect(socialPosts(posted, '/a', '2026-10-24')).toEqual({ posts: 1, platforms: ['facebook'] });
    expect(visitsFrom([...v('2026-10-22', '/a', 2, { ref_source: 'Newsletter' }), ...v('2026-10-22', '/a', 1, { ref_source: 'Meta ads' }),
      ...v('2026-10-22', '/a', 1, { ref_source: 'Instagram' })], '/a', '2026-10-24')).toEqual({ newsletter: 2, social: 1 });
  });

  it('claims a lift only with enough to compare and a clear gap', () => {
    expect(liftOver(30, [10, 10, 10, 10, 10])).toBe(3);
    expect(liftOver(12, [10, 10, 10, 10, 10])).toBeNull();
    expect(liftOver(30, [10, 10])).toBeNull();
    expect(liftOver(30, [0, 0, 0, 0, 0])).toBeNull();
    expect(pickLift([], [], [], { from: '2026-10-01', to: '2026-10-24' })).toBeNull();
  });

  it('the newsletter knows which event pages it showed', () => {
    const evs = [{ name: 'A', date: '2026-10-21', page: '/e/a' }, { name: 'B', date: '2026-10-22', page: '/e/b' }, { name: 'C', date: '2026-11-02', page: '/e/c' }];
    const issue = renderWeekly(evs, { siteUrl: 'https://www.thevic361.com', now: new Date('2026-10-19T13:00:00Z'), unsubscribeUrl: '#', address: 'x' });
    expect(issue.events.sort()).toEqual(['/e/a', '/e/b']);
  });

  it('the pick report adds social posts, a total and how it beat its day', () => {
    const mail = renderPickReport({ business: 'Biz', event: { name: 'Fall Fest' } },
      { shown: 640, page_views: 88, newsletter_starred: true, newsletter_issues: 1, newsletter_recipients: 3150,
        social_posts: 2, social_platforms: ['facebook'], social_visits: 4, day_lift: 3.7 }, { siteUrl: 'https://www.thevic361.com' });
    expect(mail.text).toContain('3,790 chances to be seen across our site and newsletter');
    expect(mail.text).toContain('That total is times shown on the site plus newsletter copies sent.');
    expect(mail.text).toContain('- In our Facebook posts: 2 posts');
    expect(mail.text).toContain('- Visits from our social posts: 4');
    expect(mail.text).toContain('That’s about 3.5× the page views of a typical event that day.');
  });
});

describe('big numbers', () => {
  it('get their commas', () => {
    const mail = renderSubmissionRecap({ name: 'X', date: '2026-10-24' }, { page_views: 1200, list_views: 1640, newsletter_issues: ['Monday'], newsletter_recipients: 3150 },
      { siteUrl: 'https://www.thevic361.com' });
    expect(mail.text).toContain('which was viewed: 1,640 times');
    expect(mail.text).toContain('- Views of its event page: 1,200');
  });
});
