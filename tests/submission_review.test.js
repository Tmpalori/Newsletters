// @vitest-environment node
//
// AI review of free submissions (server/submissionReview.js): the secret
// endpoints, what the AI may change, publishing approved ones without the
// submitter's contact details, and leaving admin-touched rows alone.

import { describe, it, expect, afterEach } from 'vitest';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { applyCleanup, awaitingReview } from '../server/submissionReview.js';
import { applyPlacements } from '../server/sponsors.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const NOW = new Date('2026-10-05T17:00:00Z');
let tmpDir, server, baseUrl, store, sent, bundle;

const PAYLOAD = {
  name: 'FALL CRAFT FAIR!!!', date: '2026-10-10', time: '9:00 AM', end_time: '', venue: 'Community Center',
  address: '2905 E North St, Victoria, TX', url: '', description: 'COME OUT!!! crafts vendors food 🎉🎉',
  icons: ['shopping'], free: false,
  submitter_first_name: 'Pat', submitter_last_name: 'Doe', submitter_phone: '(361) 555-1234'
};

function row(id, extra = {}) {
  return {
    id, created_at: NOW.toISOString(), updated_at: NOW.toISOString(), status: 'pending', source: 'submission',
    submitter_kind: 'organizer', submitter_name: 'Pat Doe', submitter_email: 'pat@example.com', submitter_ip: '1.2.3.4',
    user_agent: 'x', payload: { ...PAYLOAD }, admin_notes: '',
    review_history: [{ at: NOW.toISOString(), action: 'submitted', note: 'Public submission' }], ...extra
  };
}

async function startApp(extra = {}) {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-review-'));
  store = new FileStore(path.join(tmpDir, 's.json'));
  await store.setPublished({ last_updated: 'x', events: [] });
  const candidatesFile = path.join(tmpDir, 'candidates.json');
  await fs.writeFile(candidatesFile, JSON.stringify({ last_updated: 'c1', events: [
    { date: '2026-10-12', name: 'Collector Candidate', time: '7:00 PM', venue: 'Somewhere' }] }));
  const eventsFile = path.join(tmpDir, 'events.json');
  await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
  sent = [];
  const resend = { send: async (msg, key) => { sent.push({ ...msg, key }); return { id: 'e' }; }, batch: async () => ({ data: [] }) };
  bundle = await createApp({
    storeBundle: { kind: 'file', store }, eventsFile, candidatesFile, trustProxy: false, now: () => NOW,
    siteUrl: 'https://www.thevic361.com', submissionReviewSecret: 'review-secret', autoPublish: false,
    resendApiKey: 're_test', resend, adminUsername: 'a', adminPassword: 'b', adminSessionSecret: 'c',
    // Most tests here exercise auto-approval; the default (off) has its own test.
    submissionAutoApprove: true, ...extra
  });
  server = http.createServer(bundle.app);
  await new Promise(r => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

afterEach(async () => {
  if (server) await new Promise(r => server.close(r));
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  server = null; tmpDir = null;
});

const H = (secret = 'review-secret') => ({ 'Content-Type': 'application/json', 'X-Cron-Secret': secret });
// The live retries and paid-pick reminders run after the response; wait
// for them so a test sees what the run did.
const pending = async (secret) => {
  const r = await fetch(baseUrl + '/api/submission-review/pending', { headers: H(secret) });
  await bundle.submissionReview.idle();
  return r;
};
const review = (reviews, secret) => fetch(baseUrl + '/api/submission-review', { method: 'POST', headers: H(secret), body: JSON.stringify({ reviews }) });
const CLEAN = { name: 'Fall Craft Fair', description: 'Local crafters and food vendors.', icons: ['shopping', 'food'] };

describe('submission review: what the AI may change', () => {
  it('applies only name, description and icons, validated like an admin edit', () => {
    const out = applyCleanup(PAYLOAD, { ...CLEAN, date: '2030-01-01', venue: 'Elsewhere', icons: ['food', 'bogus'], submitter_phone: 'x' });
    expect(out.payload).toMatchObject({ name: 'Fall Craft Fair', description: 'Local crafters and food vendors.', icons: ['food'],
      date: '2026-10-10', venue: 'Community Center', submitter_phone: '(361) 555-1234' });
    expect(out.changes).toEqual(['name', 'description', 'icons']);
    expect(applyCleanup(PAYLOAD, {}).changes).toEqual([]);
    expect(applyCleanup(PAYLOAD, { name: 'x' }).error).toMatch(/too short/);
  });

  it('only rows nobody has touched are waiting', () => {
    expect(awaitingReview(row('a'))).toBe(true);
    expect(awaitingReview(row('a', { ai_review: { decision: 'flag' } }))).toBe(false);
    expect(awaitingReview(row('a', { source: 'paid-feature' }))).toBe(true);
    expect(awaitingReview(row('a', { source: 'admin' }))).toBe(false);
    expect(awaitingReview(row('a', { review_history: [{ action: 'submitted' }, { action: 'reminder' }] }))).toBe(true);
    expect(awaitingReview(row('a', { review_history: [{ action: 'submitted' }, { action: 'edit' }] }))).toBe(false);
    expect(awaitingReview(row('a', { status: 'approved' }))).toBe(false);
  });
});

describe('submission review: endpoints', () => {
  it('need the secret, and list waiting submissions without contact details', async () => {
    await startApp();
    await store.insert(row('s1'));
    await store.insert(row('s2', { source: 'paid-feature' }));
    await store.insert(row('s3', { source: 'admin' }));
    expect((await pending('nope')).status).toBe(401);
    expect((await review([], '')).status).toBe(401);
    const body = await (await pending()).json();
    expect(body.submissions.map(s => [s.id, s.paid]).sort()).toEqual([['s1', false], ['s2', true]]);
    const text = JSON.stringify(body);
    for (const secret of ['pat@example.com', '555-1234', 'Doe', '1.2.3.4']) expect(text).not.toContain(secret);
  });

  it('is closed when no secret is configured', async () => {
    await startApp({ submissionReviewSecret: '' });
    expect((await pending('')).status).toBe(401);
  });

  it('approve: tidies, publishes without the submitter, emails "you\'re live", and only once', async () => {
    await startApp();
    await store.insert(row('s1'));
    const r = await review([{ id: 's1', decision: 'approve', reason: '', cleaned: CLEAN }]);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ done: [{ id: 's1', decision: 'approve', changes: ['name', 'description', 'icons'] }], published: true });

    const saved = await store.get('s1');
    expect(saved.status).toBe('approved');
    expect(saved.payload.name).toBe('Fall Craft Fair');
    expect(saved.ai_review.original.name).toBe('FALL CRAFT FAIR!!!');
    expect(saved.admin_notes).toMatch(/AI review \(approved\)/);

    const feed = await (await fetch(baseUrl + '/events.json')).json();
    const ev = feed.events.find(e => e.name === 'Fall Craft Fair');
    expect(ev).toBeTruthy();
    expect(JSON.stringify(feed)).not.toMatch(/submitter_|555-1234|Pat/);
    expect((await store.getPublished()).events[0]).not.toHaveProperty('submitter_phone');

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: ['pat@example.com'], subject: "You're live: Fall Craft Fair", key: 'vic361-submission-live-s1' });
    expect(sent[0].html).toContain(`https://www.thevic361.com${ev.page}`);

    const again = await (await review([{ id: 's1', decision: 'approve', cleaned: CLEAN }])).json();
    expect(again.skipped).toEqual([{ id: 's1', why: 'not-awaiting-review' }]);
    expect(sent).toHaveLength(1);
  });

  it('flag: stays pending with the reason and the suggestion; the submitter\'s words are kept', async () => {
    await startApp();
    await store.insert(row('s1'));
    await review([{ id: 's1', decision: 'flag', reason: 'looks like a private party', cleaned: CLEAN }]);
    const saved = await store.get('s1');
    expect(saved.status).toBe('pending');
    expect(saved.payload.name).toBe('FALL CRAFT FAIR!!!');
    expect(saved.admin_notes).toMatch(/looks like a private party.*Suggested: name “Fall Craft Fair”/);
    expect((await pending()).ok && (await (await pending()).json()).submissions).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it('reject and duplicate set the status; nothing is published or emailed', async () => {
    await startApp();
    await store.insert(row('s1'));
    await store.insert(row('s2', { payload: { ...PAYLOAD, name: 'Something Else' } }));
    await review([{ id: 's1', decision: 'reject', reason: 'spam' }, { id: 's2', decision: 'duplicate', reason: 'already live' }]);
    expect((await store.get('s1')).status).toBe('rejected');
    expect((await store.get('s2')).status).toBe('duplicate');
    expect((await store.getPublished()).events).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it('without auto-approval a free approval waits for the owner; a paid pick still goes live', async () => {
    await startApp({ submissionAutoApprove: false });
    await store.insert(row('s1'));
    await store.insert(row('s2', { source: 'paid-feature', payload: { ...PAYLOAD, name: 'Paid Pick Night' } }));
    const body = await (await review([{ id: 's1', decision: 'approve', cleaned: CLEAN },
      { id: 's2', decision: 'approve', cleaned: {} }])).json();
    expect(body.done.map(d => [d.id, d.decision])).toEqual([['s1', 'flag'], ['s2', 'approve']]);
    const s1 = await store.get('s1');
    expect(s1.status).toBe('pending');
    expect(s1.admin_notes).toMatch(/ready for your OK/);
    expect(s1.payload.name).toBe('FALL CRAFT FAIR!!!');            // the tidy-up is a suggestion until he approves
    expect(s1.admin_notes).toMatch(/Suggested: name “Fall Craft Fair”/);
    expect((await store.get('s2')).status).toBe('approved');
  });

  it('auto-approval is off unless SUBMISSION_AUTOAPPROVE=1', async () => {
    const saved = process.env.SUBMISSION_AUTOAPPROVE;
    try {
      for (const [val, want] of [[undefined, false], ['0', false], ['1', true]]) {
        if (val === undefined) delete process.env.SUBMISSION_AUTOAPPROVE; else process.env.SUBMISSION_AUTOAPPROVE = val;
        await startApp({ submissionAutoApprove: undefined });
        const r = await fetch(baseUrl + '/api/submission-review/pending', { headers: H() });
        expect((await r.json()).auto_approve).toBe(want);
        await bundle.submissionReview.idle();
        await new Promise(res => server.close(res));
        await fs.rm(tmpDir, { recursive: true, force: true });
        server = null; tmpDir = null;
      }
    } finally {
      if (saved === undefined) delete process.env.SUBMISSION_AUTOAPPROVE; else process.env.SUBMISSION_AUTOAPPROVE = saved;
    }
  });

  it('an invalid cleanup is flagged instead of approved', async () => {
    await startApp();
    await store.insert(row('s1'));
    const body = await (await review([{ id: 's1', decision: 'approve', cleaned: { name: 'x' } }])).json();
    expect(body.done[0].decision).toBe('flag');
    expect((await store.get('s1')).status).toBe('pending');
  });

  it('refuses too many at once', async () => {
    await startApp();
    const many = Array.from({ length: 21 }, (_, i) => ({ id: `x${i}`, decision: 'flag' }));
    expect((await review(many)).status).toBe(400);
  });
});

describe('submission review: publishing safely', () => {
  async function auth() {
    const r = await fetch(baseUrl + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'a', password: 'b' }) });
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${(await r.json()).token}` };
  }

  it('an approval publishes only the submission, never the collector candidates', async () => {
    await startApp();
    await store.insert(row('s1'));
    await review([{ id: 's1', decision: 'approve', cleaned: CLEAN }]);
    expect((await store.getPublished()).events.map(e => e.name)).toEqual(['Fall Craft Fair']);
  });

  it('a past date is flagged, not approved', async () => {
    await startApp();
    await store.insert(row('s1', { payload: { ...PAYLOAD, date: '2026-10-01' } }));
    const body = await (await review([{ id: 's1', decision: 'approve', cleaned: CLEAN }])).json();
    expect(body.done[0]).toMatchObject({ decision: 'flag' });
    expect(body.done[0].reason).toMatch(/already passed/);
  });

  it('no "you\'re live" email when it didn\'t go live (the admin removed it before)', async () => {
    await startApp();
    await store.setPublished({ last_updated: 'x', events: [], auto_publish: { rejected: ['2026-10-10|Fall Craft Fair|Community Center'] } });
    await store.insert(row('s1'));
    const body = await (await review([{ id: 's1', decision: 'approve', cleaned: CLEAN }])).json();
    expect(body.done[0]).toMatchObject({ decision: 'approve', live: false });
    expect(sent).toHaveLength(0);
  });

  it('rejecting an approved submission in admin takes it off the site, for good', async () => {
    await startApp();
    await store.insert(row('s1'));
    await review([{ id: 's1', decision: 'approve', cleaned: CLEAN }]);
    const r = await fetch(baseUrl + '/api/admin/submissions/s1', { method: 'POST', headers: await auth(), body: JSON.stringify({ status: 'rejected' }) });
    expect((await r.json()).unpublished).toBe(true);
    const pub = await store.getPublished();
    expect(pub.events).toEqual([]);
    expect(pub.auto_publish.rejected).toContain('2026-10-10|Fall Craft Fair|Community Center');
  });

  it('Save & Publish from a stale page is refused instead of dropping what went live meanwhile', async () => {
    await startApp();
    const h = await auth();
    const before = await (await fetch(baseUrl + '/api/admin/published-events', { headers: h })).json();
    await store.insert(row('s1'));
    await review([{ id: 's1', decision: 'approve', cleaned: CLEAN }]);
    const stale = await fetch(baseUrl + '/api/admin/publish-events', { method: 'POST', headers: h,
      body: JSON.stringify({ events: [], based_on: before.last_updated }) });
    expect(stale.status).toBe(409);
    expect((await store.getPublished()).events.map(e => e.name)).toEqual(['Fall Craft Fair']);
    const now = await (await fetch(baseUrl + '/api/admin/published-events', { headers: h })).json();
    const ok = await fetch(baseUrl + '/api/admin/publish-events', { method: 'POST', headers: h,
      body: JSON.stringify({ events: now.events, based_on: now.last_updated }) });
    expect(ok.status).toBe(200);
  });
});

async function adminAuth() {
  const r = await fetch(baseUrl + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'a', password: 'b' }) });
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${(await r.json()).token}` };
}
const admin = async (id, body) => (await fetch(baseUrl + `/api/admin/submissions/${id}`, {
  method: 'POST', headers: await adminAuth(), body: JSON.stringify(body) })).json();

describe('admin approve and edit keep the site in step', () => {
  const edit = (p) => ({ ...p, submitter_email: 'pat@example.com' });

  it('approving a flagged submission by hand publishes it now and emails "you\'re live"', async () => {
    await startApp();
    await store.insert(row('s1'));
    await review([{ id: 's1', decision: 'flag', reason: 'check it' }]);
    const body = await admin('s1', { status: 'approved' });
    expect(body).toMatchObject({ ok: true, published: true, live: true });
    expect((await store.getPublished()).events.map(e => e.name)).toEqual(['FALL CRAFT FAIR!!!']);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: ['pat@example.com'], subject: "You're live: FALL CRAFT FAIR!!!" });
  });

  it('re-approving one rejected by mistake puts it back on the site', async () => {
    await startApp();
    await store.insert(row('s1'));
    await review([{ id: 's1', decision: 'approve', cleaned: CLEAN }]);
    expect((await admin('s1', { status: 'rejected' })).unpublished).toBe(true);
    const back = await admin('s1', { status: 'approved' });
    expect(back).toMatchObject({ published: true, live: true });
    expect((await store.getPublished()).events.map(e => e.name)).toEqual(['Fall Craft Fair']);
  });

  it('a hand approval of a past event says it isn\'t live and sends nothing', async () => {
    await startApp();
    await store.insert(row('s1', { payload: { ...PAYLOAD, date: '2026-10-01' } }));
    const body = await admin('s1', { status: 'approved' });
    expect(body).toMatchObject({ published: true, live: false });
    expect(sent).toHaveLength(0);
  });

  it('editing an approved submission updates the live event, and a reject afterwards still takes it down', async () => {
    await startApp();
    await store.insert(row('s1'));
    await review([{ id: 's1', decision: 'approve', cleaned: CLEAN }]);
    const saved = await store.get('s1');
    const body = await admin('s1', { payload: edit({ ...saved.payload, name: 'Victoria Fall Craft Fair', date: '2026-10-11' }) });
    expect(body.updated_live).toBe(true);
    const pub = await store.getPublished();
    expect(pub.events.map(e => [e.name, e.date])).toEqual([['Victoria Fall Craft Fair', '2026-10-11']]);
    expect(pub.auto_publish.keys).toEqual(['2026-10-11|Victoria Fall Craft Fair|Community Center']);
    expect(pub.events[0]).not.toHaveProperty('submitter_phone');

    const off = await admin('s1', { status: 'rejected' });
    expect(off.unpublished).toBe(true);
    expect((await store.getPublished()).events).toEqual([]);
  });

  it('a reject still finds the live event under a key it had before an edit', async () => {
    await startApp();
    await store.insert(row('s1'));
    await review([{ id: 's1', decision: 'approve', cleaned: CLEAN }]);
    // The live list kept the old version (e.g. the in-place update failed).
    const before = await store.getPublished();
    const saved = await store.get('s1');
    await admin('s1', { payload: edit({ ...saved.payload, name: 'Renamed Craft Fair' }) });
    await store.setPublished(before);
    const off = await admin('s1', { status: 'rejected' });
    expect(off.unpublished).toBe(true);
    expect((await store.getPublished()).events).toEqual([]);
  });
});

describe('paid Vic\'s Picks in the review', () => {
  const ORDER = (extra = {}) => ({
    id: 'ord1', kind: 'featured', status: 'paid', email: 'pat@example.com', business: 'Pat Co', amount: 4900,
    created_at: NOW.toISOString(), paid_at: NOW.toISOString(), submission_id: 'p1',
    event: { date: '2026-10-10', name: 'FALL CRAFT FAIR!!!', time: '9:00 AM', venue: 'Community Center' }, ...extra
  });
  let notes;
  const paidRow = (extra = {}) => row('p1', { source: 'paid-feature', submitter_name: 'Pat Co', ...extra });
  async function startPaid(extra = {}) {
    notes = [];
    await startApp({
      slack: { notify: m => notes.push(m), alert: () => {} },
      stripeSecretKey: 'sk_test', stripeWebhookSecret: 'whsec_test',
      stripe: { createCheckoutSession: async () => ({}), expireCheckoutSession: async () => ({}) }, ...extra
    });
  }

  it('a clean paid pick goes live with the buyer\'s own words, pinned, and a Vic\'s Pick email', async () => {
    await startPaid();
    await store.saveSponsorOrder(ORDER());
    await store.insert(paidRow());
    const body = await (await review([{ id: 'p1', decision: 'approve', cleaned: CLEAN }])).json();
    expect(body.done[0]).toMatchObject({ decision: 'approve', changes: [], live: true });
    const feed = await (await fetch(baseUrl + '/events.json')).json();
    expect(feed.events).toEqual([expect.objectContaining({ name: 'FALL CRAFT FAIR!!!', featured: true })]);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("Your Vic's Pick is live: FALL CRAFT FAIR!!!");
    expect(sent[0].html).not.toContain('Give it the Vic’s Pick badge');
    expect(notes.at(-1).text).toMatch(/paid Vic’s Pick/);
  });

  it('nothing paid for is turned away automatically; an exact copy of a live event is approved', async () => {
    await startPaid();
    await store.insert(paidRow());
    await store.insert(row('p2', { source: 'paid-feature', payload: { ...PAYLOAD, name: 'Other Fair' } }));
    const body = await (await review([{ id: 'p1', decision: 'reject', reason: 'spam: looks like an ad' },
      { id: 'p2', decision: 'duplicate', reason: 'already live' }])).json();
    expect(body.done.map(d => d.decision)).toEqual(['flag', 'approve']);
    expect((await store.get('p1')).status).toBe('pending');
    expect((await store.get('p1')).ai_review.reason).toMatch(/paid Vic’s Pick.*looks like an ad/);
  });

  it('the live email only promises the newsletter star when that week\'s issue was still ahead at purchase', async () => {
    // Bought Monday Oct 5 for Saturday Oct 10: Monday's issue already went
    // out, but Thursday's weekend issue (Oct 8) is still ahead.
    await startPaid();
    await store.saveSponsorOrder(ORDER());
    await store.insert(paidRow());
    await review([{ id: 'p1', decision: 'approve', cleaned: CLEAN }]);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/starred in Thursday’s weekend newsletter \(October 8\)/);
    expect(sent[0].text).not.toMatch(/Monday newsletter/);
  });

  it('a pick bought too late for both issues isn\'t promised the newsletter', async () => {
    // Bought Wednesday Oct 7 for Saturday: no day left to review before Thursday's issue.
    await startPaid();
    const late = '2026-10-07T15:00:00Z';
    await store.saveSponsorOrder(ORDER({ created_at: late, paid_at: late }));
    await store.insert(paidRow({ created_at: late }));
    await review([{ id: 'p1', decision: 'approve', cleaned: CLEAN }]);
    expect(sent[0].text).not.toMatch(/starred in/i);
    expect(sent[0].html).not.toMatch(/starred in/i);
    expect(sent[0].text).toMatch(/newsletter goes out before we could add it/);
  });

  it('the live email promises the star for a pick bought before its week\'s issue', async () => {
    await startPaid();
    const early = '2026-09-28T15:00:00Z';
    await store.saveSponsorOrder(ORDER({ created_at: early, paid_at: early }));
    await store.insert(paidRow({ created_at: early }));
    await review([{ id: 'p1', decision: 'approve', cleaned: CLEAN }]);
    expect(sent[0].text).toMatch(/starred in the Monday newsletter for the week of October 5/);
  });

  it('a refunded pick that goes live as a plain listing isn\'t told it\'s pinned', async () => {
    await startPaid();
    await store.saveSponsorOrder(ORDER({ status: 'refunded' }));
    await store.insert(paidRow());
    await review([{ id: 'p1', decision: 'approve', cleaned: CLEAN }]);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).not.toMatch(/Vic's Pick/);
    expect(sent[0].text).not.toMatch(/pinned|starred/i);
    expect(sent[0].html).not.toContain('Give it the Vic’s Pick badge');
  });

  it('reminds the owner in Slack when a paid pick close to its date is still unpublished, at most every few hours', async () => {
    await startPaid();
    const earlier = new Date(NOW.getTime() - 3600 * 1000).toISOString();
    await store.insert(paidRow({ created_at: earlier, payload: { ...PAYLOAD, date: '2026-10-06' } }));
    await store.insert(row('p2', { source: 'paid-feature', created_at: earlier, payload: { ...PAYLOAD, date: '2026-10-20' } }));
    await store.insert(row('f1', { created_at: earlier, payload: { ...PAYLOAD, date: '2026-10-06' } }));
    const first = await (await pending()).json();
    const reminders = () => notes.filter(n => /Vic’s Pick isn’t on the site/.test(n.title));
    expect(reminders()).toHaveLength(1);
    expect(reminders()[0]).toMatchObject({ channel: 'sales' });
    expect(reminders()[0].text).toMatch(/FALL CRAFT FAIR!!! · 2026-10-06/);
    // Still waiting for the AI: the reminder doesn't count as the admin touching it.
    expect(first.submissions.map(s => s.id)).toContain('p1');
    await pending();
    expect(reminders()).toHaveLength(1);
  });

  it('rejecting a paid pick in admin pings sales to refund it', async () => {
    await startPaid();
    await store.insert(paidRow());
    await admin('p1', { status: 'rejected' });
    expect(notes.at(-1)).toMatchObject({ channel: 'sales' });
    expect(notes.at(-1).title).toMatch(/Paid Vic’s Pick marked rejected/);
  });

  it('the pin follows the submission when its date is fixed, and the Sponsors tab shows picks not on the site', async () => {
    await startPaid();
    await store.saveSponsorOrder(ORDER());
    await store.insert(paidRow());
    const h = await adminAuth();
    let d = await (await fetch(baseUrl + '/api/admin/sponsors', { headers: h })).json();
    expect(d.orders.find(o => o.id === 'ord1').on_site).toBe(false);

    // Approved with the date fixed: the bought event can't match any more,
    // but the pin follows the submission.
    await admin('p1', { status: 'approved', payload: { ...PAYLOAD, date: '2026-10-11', submitter_email: 'pat@example.com' } });
    d = await (await fetch(baseUrl + '/api/admin/sponsors', { headers: h })).json();
    expect(d.orders.find(o => o.id === 'ord1').on_site).toBe(true);
    const feed = await (await fetch(baseUrl + '/events.json')).json();
    expect(feed.events).toEqual([expect.objectContaining({ date: '2026-10-11', featured: true })]);
  });

  it('applyPlacements pins by the submission shapes when the bought event no longer matches', () => {
    const order = ORDER();
    const ev = { date: '2026-10-11', name: 'Totally New Name', venue: 'Elsewhere' };
    const payload = { events: [ev] };
    expect(applyPlacements(payload, [order], { now: NOW }).events[0].featured).toBeUndefined();
    const pins = new Map([['ord1', [ev]]]);
    expect(applyPlacements(payload, [order], { now: NOW, pins }).events[0].featured).toBe(true);
  });
});

describe('paid picks and approvals that aren\'t live yet', () => {
  const ORDER = (extra = {}) => ({
    id: 'ord1', kind: 'featured', status: 'paid', email: 'pat@example.com', business: 'Pat Co', amount: 4900,
    created_at: NOW.toISOString(), paid_at: NOW.toISOString(), submission_id: 'p1',
    event: { date: '2026-10-10', name: 'FALL CRAFT FAIR!!!', time: '9:00 AM', venue: 'Community Center' }, ...extra
  });
  let notes;
  const paidRow = (extra = {}) => row('p1', { source: 'paid-feature', submitter_name: 'Pat Co', ...extra });
  const reminders = () => notes.filter(n => /Vic’s Picks? (isn|aren)’t on the site/.test(n.title));
  async function startPaid(extra = {}) {
    notes = [];
    await startApp({
      slack: { notify: m => notes.push(m), alert: () => {} },
      stripeSecretKey: 'sk_test', stripeWebhookSecret: 'whsec_test',
      stripe: { createCheckoutSession: async () => ({}), expireCheckoutSession: async () => ({}) }, ...extra
    });
  }
  // Publishing fails (the database write times out) until the returned
  // function is called.
  function breakPublishing() {
    const real = store.setPublished.bind(store);
    store.setPublished = async () => { throw new Error('statement timeout'); };
    return () => { store.setPublished = real; };
  }

  it('reminds before the Monday newsletter that promised a star, not only 2 days before the pick', async () => {
    // Bought Thursday Oct 8 for Saturday Oct 17: promised a star in Monday Oct 12's issue.
    const clock = new Date('2026-10-11T15:00:00Z'); // Sunday
    await startPaid({ now: () => clock });
    const bought = '2026-10-08T15:00:00Z';
    await store.saveSponsorOrder(ORDER({ created_at: bought, paid_at: bought, event: { ...ORDER().event, date: '2026-10-17' } }));
    await store.insert(paidRow({ created_at: bought, payload: { ...PAYLOAD, date: '2026-10-17' } }));
    await pending();
    expect(reminders()).toHaveLength(1);
    expect(reminders()[0].text).toMatch(/2026-10-17/);
  });

  it('a refunded pick loses the paid privileges: no softened review, no reminders', async () => {
    await startPaid();
    const earlier = new Date(NOW.getTime() - 3600 * 1000).toISOString();
    await store.saveSponsorOrder(ORDER({ status: 'refunded' }));
    await store.insert(paidRow({ created_at: earlier, payload: { ...PAYLOAD, date: '2026-10-06' } }));
    const body = await (await pending()).json();
    expect(body.submissions.find(s => s.id === 'p1').paid).toBe(false);
    expect(reminders()).toHaveLength(0);
    const r = await (await review([{ id: 'p1', decision: 'reject', reason: 'spam' }])).json();
    expect(r.done[0].decision).toBe('reject');
  });

  it('an approval whose publish failed is published and emailed on a later run', async () => {
    await startApp();
    await store.insert(row('s1'));
    const up = breakPublishing();
    const body = await (await review([{ id: 's1', decision: 'approve', cleaned: CLEAN }])).json();
    expect(body.published).toBe(false);
    expect(sent).toHaveLength(0);
    expect((await store.get('s1')).ai_review.live_pending).toBeTruthy();
    up();
    await pending();
    expect((await store.getPublished()).events.map(e => e.name)).toEqual(['Fall Craft Fair']);
    expect(sent.map(m => m.key)).toEqual(['vic361-submission-live-s1']);
    expect((await store.get('s1')).ai_review).toMatchObject({ live_pending: null, live: true });
    await pending();
    expect(sent).toHaveLength(1);
  });

  it('a "you\'re live" email that failed to send is retried on a later run (AI review and by hand)', async () => {
    let down = true;
    const resend = { send: async (msg, key) => { if (down) throw new Error('resend 503'); sent.push({ ...msg, key }); return { id: 'e' }; },
      batch: async () => ({ data: [] }) };
    await startApp({ resend });
    await store.insert(row('s1'));
    await store.insert(row('s2', { payload: { ...PAYLOAD, name: 'Pumpkin Patch', date: '2026-10-11' } }));
    await review([{ id: 's1', decision: 'approve', cleaned: CLEAN }]);
    await admin('s2', { status: 'approved' });
    expect(sent).toHaveLength(0);
    expect((await store.get('s1')).ai_review.live_pending).toBeTruthy();
    expect((await store.get('s2')).ai_review.live_pending).toBeTruthy();
    // Still down on the next run: it keeps waiting.
    await pending();
    expect((await store.get('s1')).ai_review.live_pending).toBeTruthy();
    down = false;
    await pending();
    expect(sent.map(m => m.key).sort()).toEqual(['vic361-submission-live-s1', 'vic361-submission-live-s2']);
    expect((await store.get('s1')).ai_review).toMatchObject({ live_pending: null, live: true });
    expect((await store.get('s2')).ai_review).toMatchObject({ live_pending: null, live: true });
  });

  it('a paid pick approved but not published yet is still reminded about near its date', async () => {
    await startPaid();
    const earlier = new Date(NOW.getTime() - 3600 * 1000).toISOString();
    await store.saveSponsorOrder(ORDER());
    await store.insert(paidRow({ created_at: earlier, payload: { ...PAYLOAD, date: '2026-10-06' } }));
    breakPublishing();
    await review([{ id: 'p1', decision: 'approve', cleaned: CLEAN }]);
    expect((await store.get('p1')).status).toBe('approved');
    await pending();
    expect(reminders()).toHaveLength(1);
    expect(reminders()[0].more).toMatch(/publishing it failed/);  // the why is for HQ
  });
});


describe('live retries: refused addresses and Resend hangs', () => {
  it('an address Resend refuses for good is noted once and not retried every run', async () => {
    const notes = [];
    let calls = 0;
    const resend = { send: async () => { calls++; const e = new Error('Resend /emails HTTP 422: invalid `to`'); e.status = 422; throw e; },
      batch: async () => ({ data: [] }) };
    await startApp({ resend, slack: { notify: m => notes.push(m), alert: () => {} } });
    await store.insert(row('s1', { submitter_email: 'pat@example.com.' }));
    const body = await (await review([{ id: 's1', decision: 'approve', cleaned: CLEAN }])).json();
    expect(body.done[0].live).toBe(true);
    const saved = await store.get('s1');
    expect(saved.ai_review.live_pending).toBeFalsy();
    expect(saved.review_history.filter(h => h.action === 'live-email-refused')).toHaveLength(1);
    expect(notes.filter(n => /email refused/.test(n.title))).toHaveLength(1);
    await pending();
    await pending();
    expect(calls).toBe(1);
  });

  it('the pending list answers while a live retry hangs on Resend, and the retry still finishes', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const resend = { send: async (msg, key) => { await gate; sent.push({ ...msg, key }); return { id: 'e' }; },
      batch: async () => ({ data: [] }) };
    await startApp({ resend });
    await store.insert(row('s1', { status: 'approved', ai_review: { decision: 'approve', live_pending: NOW.toISOString() } }));
    await store.insert(row('s2'));
    const r = await fetch(baseUrl + '/api/submission-review/pending', { headers: H(), signal: AbortSignal.timeout(1500) });
    expect(r.status).toBe(200);
    expect((await r.json()).submissions.map(s => s.id)).toEqual(['s2']);
    release();
    await bundle.submissionReview.idle();
    expect(sent.map(m => m.key)).toEqual(['vic361-submission-live-s1']);
    expect((await store.get('s1')).ai_review).toMatchObject({ live_pending: null, live: true });
  });
});

describe('submissions through HQ (HQ_REPLY_KEY)', () => {
  const HQK = 'hq-reply-key-0123456789-0123456789-abc';
  const hq = (method, p, body, key = HQK) => fetch(baseUrl + p, { method,
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });

  it('lists pending submissions in full, without IP or browser', async () => {
    await startApp({ hqReplyKey: HQK, hqApiKey: 'hq-read-only-key-0123456789' });
    await store.insert(row('s1'));
    await store.insert(row('s2', { status: 'rejected' }));
    expect((await hq('GET', '/api/hq/submissions', null, '')).status).toBe(401);
    expect((await hq('GET', '/api/hq/submissions', null, 'hq-read-only-key-0123456789')).status).toBe(401);   // the read-only key can't
    const body = await (await hq('GET', '/api/hq/submissions')).json();
    expect(body.submissions.map(s => s.id)).toEqual(['s1']);
    expect(body.submissions[0]).toMatchObject({ submitter_email: 'pat@example.com', payload: { name: 'FALL CRAFT FAIR!!!', venue: 'Community Center' } });
    expect(JSON.stringify(body)).not.toContain('1.2.3.4');
    expect((await (await hq('GET', '/api/hq/submissions/s1')).json()).submission.id).toBe('s1');
    expect((await hq('GET', '/api/hq/submissions/nope')).status).toBe(404);
  });

  it('edits, then approves: published and the submitter emailed', async () => {
    await startApp({ hqReplyKey: HQK });
    await store.insert(row('s1'));
    const bad = await hq('POST', '/api/hq/submissions/s1', { payload: { ...PAYLOAD, date: 'soon' } });
    expect(bad.status).toBe(400);
    const edit = await hq('POST', '/api/hq/submissions/s1', { payload: { ...PAYLOAD, name: 'Fall Craft Fair' } });
    expect(edit.status).toBe(200);
    expect((await store.get('s1')).status).toBe('pending');
    const r = await hq('POST', '/api/hq/submissions/s1', { status: 'approved', note: 'looks good' });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, live: true, submission: { status: 'approved' } });
    const saved = await store.get('s1');
    expect(saved.review_history.slice(-1)[0]).toMatchObject({ action: 'status:approved', via: 'hq', note: 'looks good' });
    const feed = await (await fetch(baseUrl + '/events.json')).json();
    expect(feed.events.some(e => e.name === 'Fall Craft Fair')).toBe(true);
    expect(sent.some(m => (m.to || []).includes('pat@example.com'))).toBe(true);
  });

  it('adds an event the owner found: published, no submitter email, and duplicates refused', async () => {
    await startApp({ hqReplyKey: HQK, hqApiKey: 'hq-read-only-key-0123456789' });
    const EV = { name: 'Harvest Moon Fest', date: '2099-10-25', time: '6:00 PM', venue: 'De Leon Plaza', address: '101 N Main St, Victoria, TX', description: 'Live music and food trucks.', url: 'example.com/moon' };
    expect((await hq('POST', '/api/hq/submissions', { event: EV }, 'hq-read-only-key-0123456789')).status).toBe(401);
    expect((await hq('POST', '/api/hq/submissions', { event: { ...EV, venue: '' } })).status).toBe(400);
    expect((await hq('POST', '/api/hq/submissions', { event: { ...EV, date: '2000-01-01' } })).status).toBe(400);
    const r = await hq('POST', '/api/hq/submissions', { event: EV, note: 'found on Facebook' });
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body).toMatchObject({ ok: true, live: true, submission: { status: 'approved', source: 'hq', payload: { url: 'https://example.com/moon' } } });
    const saved = await store.get(body.submission.id);
    expect(saved.review_history[0]).toMatchObject({ action: 'submitted', via: 'hq', note: 'found on Facebook' });
    const feed = await (await fetch(baseUrl + '/events.json')).json();
    expect(feed.events.some(e => e.name === 'Harvest Moon Fest')).toBe(true);
    expect(sent).toHaveLength(0);                                       // nobody to email
    // The same event again, worded differently: refused, with what matched.
    const again = await hq('POST', '/api/hq/submissions', { event: { ...EV, name: 'Harvest Moon Fest at De Leon Plaza' } });
    expect(again.status).toBe(409);
    expect((await again.json()).error).toMatch(/duplicate|already-listed/);
  });

  it('adds without publishing when asked, and refuses one already in the queue', async () => {
    await startApp({ hqReplyKey: HQK });
    await store.insert(row('s1'));
    const q = await hq('POST', '/api/hq/submissions', { event: { ...PAYLOAD, name: 'Fall Craft Fair' } });
    expect(q.status).toBe(409);
    expect(await q.json()).toMatchObject({ error: 'duplicate', submission: { id: 's1' } });
    const r = await hq('POST', '/api/hq/submissions', { event: { ...PAYLOAD, name: 'Pumpkin Patch Opening', venue: 'Riverside Park' }, publish: false });
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body).toMatchObject({ live: false, submission: { status: 'pending' } });
  });

  it('credits the person who sent it in; approving emails them that it is live', async () => {
    await startApp({ hqReplyKey: HQK });
    const EV = { name: 'Church Fall Festival', date: '2099-10-26', time: '10:00 AM', venue: 'St. Mary Hall', address: '101 Main St, Victoria, TX', description: 'Games and food.' };
    expect((await hq('POST', '/api/hq/submissions', { event: EV, submitter: { email: 'not-an-email' } })).status).toBe(400);
    const r = await hq('POST', '/api/hq/submissions', { event: EV, submitter: { name: 'Roberto\nOlvera', email: 'Robert@Example.com' }, note: 'emailed news@' });
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body.submission).toMatchObject({ submitter_name: 'Roberto Olvera', submitter_email: 'robert@example.com', status: 'approved' });
    expect(sent.some(m => (m.to || []).includes('robert@example.com'))).toBe(true);
  });

  it("doesn't exist without HQ_REPLY_KEY", async () => {
    await startApp({ hqReplyKey: '' });
    expect((await hq('GET', '/api/hq/submissions')).status).toBe(404);
    expect((await hq('GET', '/api/hq/admin/newsletter')).status).toBe(404);
  });

  it("opens the admin's attention, newsletter, sponsor and analytics data to the reply key only", async () => {
    await startApp({ hqReplyKey: HQK, hqApiKey: 'hq-read-only-key-0123456789' });
    for (const p of ['setup', 'sources', 'hidden', 'messages', 'newsletter', 'sponsors', 'growth?days=7', 'traffic?days=7', 'event-stats', 'activity?days=7']) {
      expect((await hq('GET', `/api/hq/admin/${p}`)).status, p).toBe(200);
      expect((await hq('GET', `/api/hq/admin/${p}`, null, 'hq-read-only-key-0123456789')).status, p).toBe(401);
      expect((await hq('GET', `/api/hq/admin/${p}`, null, '')).status, p).toBe(401);
      expect((await hq('GET', `/api/admin/${p}`)).status, p).toBe(401);           // the key never opens the admin's own paths
    }
    expect((await hq('GET', '/api/hq/admin/subscribers.csv')).status).toBe(404);   // not every admin route
    // Import is open to it (Tristen's OK, Oct 2026), but not to the read-only key.
    expect((await hq('POST', '/api/hq/admin/newsletter/import', { emails: 'a@b.co' }, 'hq-read-only-key-0123456789')).status).toBe(401);
    expect((await hq('POST', '/api/hq/admin/newsletter/rewards/r1/approve', {})).status).toBe(404);
  });

  it('through HQ: only some sponsor actions, and a test issue only to the town\'s own address', async () => {
    await startApp({ hqReplyKey: HQK });
    for (const action of ['edit', 'remove-logo']) {
      expect((await hq('POST', '/api/hq/admin/sponsors/x1', { action })).status).toBe(403);
    }
    expect((await hq('POST', '/api/hq/admin/sponsors/x1', { action: 'hide' })).status).toBe(404);   // allowed; no such order
    const t = await hq('POST', '/api/hq/admin/newsletter/test', { email: 'stranger@example.com' });
    expect(sent.some(m => (m.to || []).includes('stranger@example.com'))).toBe(false);
    expect([400, 503]).toContain(t.status);                                     // no test address set here
    expect((await hq('POST', '/api/hq/admin/hidden/restore', { key: 'nope' })).status).toBe(404);
    expect((await hq('POST', '/api/hq/admin/messages/nope/dismiss', {})).status).toBe(404);
  });
});

describe('research suggestions', () => {
  it('are kept on the row and in the notes, never applied; junk is dropped', async () => {
    await startApp();
    await store.insert(row('s1', { payload: { ...PAYLOAD, address: '' } }));
    await store.insert(row('s2'));
    const r = await review([
      { id: 's1', decision: 'flag', reason: 'research found address', cleaned: CLEAN,
        research: { address: '501 E Larkspur St, Victoria, TX', end_time: '6:30 PM', url: 'javascript:alert(1)',
          sources: ['https://moradaseniorliving.com/east', 'http://plain.example'], note: 'From the venue page.' } },
      { id: 's2', decision: 'flag', reason: 'x', cleaned: CLEAN, research: { address: '', url: 'nope' } }
    ]);
    expect(r.status).toBe(200);
    const s1 = await store.get('s1');
    expect(s1.payload.address).toBe('');                          // a suggestion, not an edit
    expect(s1.ai_review.research).toEqual({ address: '501 E Larkspur St, Victoria, TX', end_time: '6:30 PM',
      sources: ['https://moradaseniorliving.com/east'], note: 'From the venue page.' });
    expect(s1.admin_notes).toMatch(/Research suggests: address “501 E Larkspur St, Victoria, TX”; ends 6:30 PM/);
    expect((await store.get('s2')).ai_review.research).toBeUndefined();
  });
});

describe('submission review: a bot check that did not pass', () => {
  // POST /api/submissions takes these now (server/formGuard.js) instead of
  // turning a real person away; the review may not publish one on its own.
  it('is flagged for the owner even with auto-approval on', async () => {
    await startApp();
    await store.insert(row('s1', { review_history: [{ at: NOW.toISOString(), action: 'submitted', note: 'Public submission', bot_check: 'failed' }] }));
    expect(awaitingReview(await store.get('s1'))).toBe(true);
    const r = await review([{ id: 's1', decision: 'approve', reason: 'looks fine', cleaned: CLEAN }]);
    expect(r.status).toBe(200);
    const s1 = await store.get('s1');
    expect(s1.status).toBe('pending');
    expect(s1.ai_review.decision).toBe('flag');
    expect(s1.admin_notes).toMatch(/bot check didn't pass/);
  });

  it('can still be turned away by the review', async () => {
    await startApp();
    await store.insert(row('s1', { review_history: [{ at: NOW.toISOString(), action: 'submitted', bot_check: 'failed' }] }));
    await review([{ id: 's1', decision: 'reject', reason: 'gibberish' }]);
    expect((await store.get('s1')).status).not.toBe('pending');
  });
});
