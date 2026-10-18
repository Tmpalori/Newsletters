// @vitest-environment node
//
// An approved free submission that didn't make its day's list hears so,
// once, two days out, with the town's paid pick on offer while the day has
// one (server/dropNotices.js; Tristen, Oct 2026).

import { describe, it, expect, beforeEach } from 'vitest';
import { createDropNotices } from '../server/dropNotices.js';
import { renderSubmissionDropped } from '../server/notify.js';
import { useTown, townConfig, VICTORIA } from '../server/town.js';

// Thursday Oct 22, 2026, 9:30 AM Central; the event is Saturday Oct 24.
const NOW = new Date('2026-10-22T14:30:00Z');
const SAT = '2026-10-24';
const EVENT = { name: 'Fall Fest', date: SAT, time: '6:00 PM', venue: 'Main Plaza', address: '101 Main St', description: 'Music and food.' };

const row = (extra = {}) => ({
  id: '11111111-2222-3333-4444-555555555555', status: 'approved', source: 'submission', created_at: '2026-10-20T15:00:00Z',
  submitter_email: 'pat@example.com', submitter_name: 'Pat Doe', payload: { ...EVENT },
  review_history: [{ at: '2026-10-20T15:00:00Z', action: 'submitted', placement_emails: true }], ...extra
});
// A full Saturday: 27 events, Fall Fest past the cut.
const dayOf = (fallFest = { overflow: true }) => [
  { ...EVENT, page: '/e/fall-fest', ...fallFest },
  ...Array.from({ length: 26 }, (_, i) => ({ name: `Other ${i}`, date: SAT, venue: `V${i}`, ...(i >= 19 ? { overflow: true } : {}) }))
];

function setup({ rows = [row()], events = dayOf(), orders = [], deliver = 'sent', checkout = true } = {}) {
  const sent = [], notes = [], updates = [];
  const store = {
    list: async ({ status }) => rows.filter(r => r.status === status),
    update: async (id, patch) => { updates.push({ id, patch }); const r = rows.find(x => x.id === id); Object.assign(r, patch); return r; }
  };
  const dn = createDropNotices({
    store, getPublicPayload: async () => ({ events }), siteUrl: 'https://www.thevic361.com', address: '1 Main St, Victoria, TX',
    mailer: { deliver: async (to, mail, key) => { sent.push({ to, mail, key }); return deliver; } },
    slack: { notify: m => notes.push(m) }, orders: async () => orders, checkoutEnabled: checkout, log: { warn() {} }
  });
  return { dn, sent, notes, updates, rows };
}

beforeEach(() => useTown(VICTORIA));

describe('dropped-event notices', () => {
  it('tells the submitter two days out, with the upgrade and a prefilled checkout link', async () => {
    const t = setup();
    expect(await t.dn.run(NOW)).toEqual({ ok: true, sent: 1 });
    const [{ to, mail, key }] = t.sent;
    expect(to).toBe('pat@example.com');
    expect(key).toBe('vic361-submission-dropped-11111111-2222-3333-4444-555555555555');
    expect(mail.subject).toBe("Fall Fest didn't make Saturday's list on The Vic 361");
    expect(mail.text).toContain('Saturday, Oct 24 is a busy day in Victoria: 27 events are happening and our day list shows 20');
    expect(mail.text).toContain('See your event: https://www.thevic361.com/e/fall-fest');
    expect(mail.text).toContain('The Vic’s Pick upgrade ($39 for Fri–Sun) puts Fall Fest on Saturday’s list for sure');
    expect(mail.text).toContain("Upgrade to Vic's Pick: https://www.thevic361.com/advertise/checkout?package=featured&from=11111111-2222-3333-4444-555555555555");
    expect(t.rows[0].review_history.at(-1)).toMatchObject({ action: 'drop-notice', offer: true });
    expect(t.notes[0].title).toBe("📭 Told Fall Fest's organizer it didn't make Saturday, Oct 24's list");
  });

  it('promises only a newsletter that will still go out before the event', () => {
    const offer = { price: '$39', url: 'https://www.thevic361.com/advertise/checkout?package=featured&from=x' };
    // Thursday 9:30 AM for Saturday: Thursday's weekend issue already went out.
    const sat = renderSubmissionDropped(EVENT, { siteUrl: 'https://www.thevic361.com', dayCount: 27, dayMax: 20, offer, at: NOW });
    expect(sat.text).toContain('highlighted with the Vic’s Pick badge and featured first in our social posts.');
    expect(sat.text).not.toContain('newsletter');
    // Saturday for Monday: Monday's issue hasn't gone out yet.
    const mon = renderSubmissionDropped({ ...EVENT, date: '2026-10-26' }, { siteUrl: 'https://www.thevic361.com', dayCount: 18, dayMax: 15, offer,
      at: new Date('2026-10-24T14:30:00Z') });
    expect(mon.text).toContain('starred in the Monday newsletter for the week of October 26');
  });

  it('only once', async () => {
    const t = setup();
    await t.dn.run(NOW);
    await t.dn.run(new Date(NOW.getTime() + 86400000));
    expect(t.sent).toHaveLength(1);
  });

  it('no offer when the day’s paid spots are all taken', async () => {
    const full = Array.from({ length: 4 }, (_, i) => ({ id: `o${i}`, kind: 'featured', status: 'paid', event: { date: SAT } }));
    const t = setup({ orders: full });
    await t.dn.run(NOW);
    const { mail } = t.sent[0];
    expect(mail.text).not.toContain('Upgrade');
    expect(mail.text).not.toContain('/advertise/checkout');
    expect(t.rows[0].review_history.at(-1).offer).toBe(false);
    expect(t.notes[0].text).toBe("No Vic's Pick spot was left that day, so no offer.");
  });

  it('nothing when it made the list, is not live, or is more than two days out', async () => {
    expect((await setup({ events: dayOf({ overflow: false }) }).dn.run(NOW)).sent).toBe(0);
    expect((await setup({ events: dayOf().slice(1) }).dn.run(NOW)).sent).toBe(0);
    expect((await setup({ rows: [row({ payload: { ...EVENT, date: '2026-10-25' } })] }).dn.run(NOW)).sent).toBe(0);
  });

  it('never for submissions sent before the form said so, admin-added ones, or no email', async () => {
    for (const r of [
      row({ review_history: [{ action: 'submitted' }] }),
      row({ source: 'admin' }),
      row({ submitter_email: '' }),
      row({ status: 'pending' })
    ]) expect((await setup({ rows: [r] }).dn.run(NOW)).sent).toBe(0);
  });

  it('tries again tomorrow when the email failed; email off records nothing', async () => {
    const failed = setup({ deliver: 'failed' });
    await failed.dn.run(NOW);
    expect(failed.updates).toEqual([]);
    const off = setup({ deliver: 'off' });
    await off.dn.run(NOW);
    expect(off.updates).toEqual([]);
    expect(off.notes).toEqual([]);
  });

  it("uses each town's own name for its pick", () => {
    useTown(townConfig({ TOWN: 'shoals' }));
    const mail = renderSubmissionDropped(EVENT, { siteUrl: 'https://www.shoalssetlist.com', dayCount: 27, dayMax: 20,
      offer: { price: '$39', url: 'https://www.shoalssetlist.com/advertise/checkout?package=featured&from=x' } });
    expect(mail.text).toContain('The Headliner upgrade ($39 for Fri–Sun)');
    expect(mail.text).toContain('highlighted with the Headliner badge');
    expect(mail.text).toContain('Upgrade to Headliner: ');
    expect(mail.subject).toBe("Fall Fest didn't make Saturday's list on Shoals Setlist");
  });

  it('a new submission is marked as having seen the new form wording', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
    expect(src).toContain("action: 'submitted', note: 'Public submission', placement_emails: true");
    const form = readFileSync(new URL('../docs/submit.html', import.meta.url), 'utf8');
    expect(form).toContain("including if it doesn't\n          make its day's list and how to guarantee it a spot");
  });
});
