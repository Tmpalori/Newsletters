// @vitest-environment node
//
// The in-process scheduler (server/scheduler.js): Central-time slots across
// DST, one run per slot even across restarts, retries, worker jobs queued
// for the town's jobs worker (never GitHub), and the "did it already run?"
// endpoint. The worker queue, Slack and email are fakes.

import { describe, it, expect, afterEach } from 'vitest';
import { createScheduler, dueSlot, lastSlot, localParts, JOBS, schedulerEnabled, slotStart, missedCollect } from '../server/scheduler.js';
import { nextWeeklyRunUtc } from '../server/sources.js';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { townConfig, useTown, VICTORIA } from '../server/town.js';

const job = name => JOBS.find(j => j.name === name);
let tmpDir;

async function freshStore() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-sched-'));
  return new FileStore(path.join(tmpDir, 's.json'));
}

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  tmpDir = null;
});

// The town's jobs worker queue (server/jobs.js enqueue), as index.js wires it.
function fakeWorker({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    opts: {
      canQueue: () => true,
      async queueJob(job, slot) {
        calls.push({ file: job.workflow, slot });
        if (fail) throw new Error('queue down');
        return { queued: true };
      }
    }
  };
}

function fakeSlack() {
  const alerts = [], notes = [];
  return { alerts, notes, enabled: true, alert: async (k, t, d) => { alerts.push({ k, t, d }); return true; }, notify: async m => { notes.push(m); return true; } };
}

const quiet = { warn() {}, log() {} };

describe('Central-time slots', () => {
  it('fires at 7:43 AM Central on Mondays in both CDT and CST', () => {
    // Oct 5 2026 is CDT (UTC-5), Nov 9 2026 is CST (UTC-6).
    expect(dueSlot(job('newsletter'), new Date('2026-10-05T12:42:00Z'))).toBeNull();
    expect(dueSlot(job('newsletter'), new Date('2026-10-05T12:43:00Z'))).toBe('2026-10-05');
    expect(dueSlot(job('newsletter'), new Date('2026-11-09T12:43:00Z'))).toBeNull(); // 6:43 CST
    expect(dueSlot(job('newsletter'), new Date('2026-11-09T13:43:00Z'))).toBe('2026-11-09');
    expect(dueSlot(job('newsletter'), new Date('2026-10-06T13:00:00Z'))).toBeNull(); // Tuesday
    // A late start the same morning still sends; one after noon (or the
    // next day) doesn't, so a deploy can't send an issue at night.
    expect(dueSlot(job('newsletter'), new Date('2026-10-05T16:30:00Z'))).toBe('2026-10-05'); // 11:30 CDT
    expect(dueSlot(job('newsletter'), new Date('2026-10-05T22:00:00Z'))).toBeNull(); // 5 PM CDT
    expect(dueSlot(job('newsletter-weekend'), new Date('2026-10-09T03:30:00Z'))).toBeNull(); // Thu 10:30 PM CDT
    expect(dueSlot(job('newsletter-weekend'), new Date('2026-10-08T16:59:00Z'))).toBe('2026-10-08'); // Thu 11:59 AM
    expect(localParts(new Date('2026-10-06T04:30:00Z'))).toMatchObject({ date: '2026-10-05', dow: 1 });
  });

  it('runs the event check before the newsletter and the social kit daily', () => {
    expect(dueSlot(job('event-check'), new Date('2026-10-05T11:43:00Z'))).toBe('2026-10-05');
    expect(dueSlot(job('social-kit'), new Date('2026-10-07T13:47:00Z'))).toBe('2026-10-07');
    expect(dueSlot(job('social-kit'), new Date('2026-10-07T13:46:00Z'))).toBeNull();
    expect(dueSlot(job('submission-review'), new Date('2026-10-07T13:52:00Z'))).toBe('2026-10-07T08:45');
  });

  it('knows the latest slot a job should have run in', () => {
    expect(lastSlot(job('social-kit'), new Date('2026-10-07T13:00:00Z'))).toBe('2026-10-06'); // before 8:47
    expect(lastSlot(job('social-kit'), new Date('2026-10-07T21:00:00Z'))).toBe('2026-10-07');
    expect(lastSlot(job('event-check'), new Date('2026-10-08T15:00:00Z'))).toBe('2026-10-05');
  });

  it('is on in production only, with an opt-out', () => {
    expect(schedulerEnabled({ RAILWAY_ENVIRONMENT_NAME: 'production' })).toBe(true);
    expect(schedulerEnabled({ RAILWAY_ENVIRONMENT_NAME: 'production', SCHEDULER: '0' })).toBe(false);
    expect(schedulerEnabled({ RAILWAY_ENVIRONMENT_NAME: 'staging' })).toBe(false);
  });
});

describe('createScheduler', () => {
  it('sends the newsletter once per Monday, even across a restart', async () => {
    const store = await freshStore();
    let sends = 0;
    const handlers = { newsletter: async () => { sends++; return { ok: true }; } };
    const make = () => createScheduler({ store, handlers, log: quiet });
    const mon = new Date('2026-10-05T12:44:00Z');
    await make().tick(mon);
    await make().tick(new Date(mon.getTime() + 60000)); // restarted container
    await make().tick(new Date(mon.getTime() + 3 * 3600000));
    expect(sends).toBe(1);
  });

  it('retries a failed send with backoff and alerts after the last try', async () => {
    const store = await freshStore();
    const slack = fakeSlack();
    let calls = 0;
    const s = createScheduler({ store, slack, log: quiet,
      handlers: { newsletter: async () => { calls++; return { ok: false, error: 'send-failed', message: 'Resend 500' }; } } });
    let t = new Date('2026-10-05T12:44:00Z').getTime();
    await s.tick(new Date(t));
    await s.tick(new Date(t + 60000)); // not yet: next try is 5 min later
    expect(calls).toBe(1);
    for (const mins of [5, 15, 30]) { t += mins * 60000; await s.tick(new Date(t)); }
    expect(calls).toBe(4);
    expect(slack.alerts.map(a => a.t)).toEqual(['Monday newsletter send failed after 4 tries']);
    t += 60 * 60000;
    await s.tick(new Date(t));
    expect(calls).toBe(4);
  });

  it('doesn\'t retry or alert twice when setup is missing (the handler said so)', async () => {
    const store = await freshStore();
    const slack = fakeSlack();
    let calls = 0;
    const s = createScheduler({ store, slack, log: quiet,
      handlers: { newsletter: async () => { calls++; return { ok: false, final: true, error: 'no-address' }; } } });
    await s.tick(new Date('2026-10-05T12:44:00Z'));
    await s.tick(new Date('2026-10-05T13:44:00Z'));
    expect(calls).toBe(1);
    expect(slack.alerts).toHaveLength(0);
  });

  it('queues the daily worker jobs on time, once', async () => {
    const store = await freshStore();
    const w = fakeWorker();
    const s = createScheduler({ store, log: quiet, ...w.opts });
    await s.tick(new Date('2026-10-07T13:40:00Z')); // 8:40 CDT: ads report only
    await s.tick(new Date('2026-10-07T13:48:00Z'));
    await s.tick(new Date('2026-10-07T13:49:00Z'));
    const daily = w.calls.filter(c => c.file !== 'submission-review.yml');
    expect(daily).toEqual([
      { file: 'meta-ads.yml', slot: '2026-10-07' },
      { file: 'social-kit.yml', slot: '2026-10-07' }
    ]);
    expect(w.calls.filter(c => c.file === 'submission-review.yml')).toHaveLength(2); // 8:30 and 8:45 slots
    expect((await s.ran('social-kit', new Date('2026-10-07T21:00:00Z'))).ran).toBe(true);
    expect((await s.ran('social-kit', new Date('2026-10-08T21:00:00Z'))).ran).toBe(false);
    expect(await s.ran('nope')).toBeNull();
  });

  it('queues the weekly digest Sunday at 9 PM town time', async () => {
    const w = fakeWorker();
    const s = createScheduler({ store: await freshStore(), log: quiet, ...w.opts });
    await s.tick(new Date('2026-10-12T01:59:00Z')); // Sun 8:59 PM CDT
    expect(w.calls.filter(c => c.file === 'weekly-digest.yml')).toEqual([]);
    await s.tick(new Date('2026-10-12T02:00:00Z'));
    await s.tick(new Date('2026-10-12T02:05:00Z'));
    expect(w.calls.filter(c => c.file === 'weekly-digest.yml')).toEqual([{ file: 'weekly-digest.yml', slot: '2026-10-11' }]);
  });

  it('a town that has never collected starts only its collect', async () => {
    const bay = townConfig({}, { town: { id: 'bay', siteName: 'The Bay 979', domain: 'thebay979.com', city: 'Bay City', state: 'TX', stateName: 'Texas', timezone: 'America/Chicago' } });
    useTown(bay);
    try {
      let collected = false;
      const w = fakeWorker();
      const s = createScheduler({ store: await freshStore(), log: quiet, ...w.opts, handlers: { collected: async () => collected } });
      await s.tick(new Date('2026-10-07T13:48:00Z'));        // ads, social kit, review due: none start
      expect(w.calls).toEqual([]);
      await s.tick(new Date('2026-10-07T20:30:00Z'));        // Wednesday's collect
      expect(w.calls.map(c => c.file)).toEqual(['weekly-collect.yml']);
      collected = true;
      await s.tick(new Date('2026-10-07T20:46:00Z'));
      expect(w.calls.map(c => c.file)).toContain('submission-review.yml');
    } finally {
      useTown(VICTORIA);
    }
  });

  it('without jobs on Railway the worker jobs don\'t run at all (nothing starts on GitHub)', async () => {
    const store = await freshStore();
    const s = createScheduler({ store, log: quiet, github: { isConfigured: () => true, dispatchWorkflow: () => { throw new Error('never'); } } });
    await s.tick(new Date('2026-10-07T13:48:00Z'));
    await s.tick(new Date('2026-10-11T20:30:00Z'));
    expect((await s.ran('social-kit', new Date('2026-10-07T21:00:00Z'))).ran).toBe(false);
    expect((await s.ran('weekly-collect', new Date('2026-10-11T22:00:00Z'))).ran).toBe(false);
  });

  it('retries a job it couldn\'t queue, then alerts once', async () => {
    const store = await freshStore();
    const slack = fakeSlack();
    const w = fakeWorker({ fail: true });
    const s = createScheduler({ store, slack, log: quiet, ...w.opts, jobs: [JOBS.find(j => j.name === 'social-kit')] });
    for (const t of ['13:48', '13:51', '13:57', '14:05']) await s.tick(new Date(`2026-10-07T${t}:00Z`));
    expect(w.calls).toHaveLength(3);
    expect(slack.alerts).toHaveLength(1);
    expect(slack.alerts[0].t).toContain("social-kit couldn't start");
  });

  it('calls the sponsor reports hook daily when it exists', async () => {
    const store = await freshStore();
    const seen = [];
    const s = createScheduler({ store, log: quiet,
      handlers: { sponsorReports: async now => { seen.push(now.toISOString()); } } });
    await s.tick(new Date('2026-10-07T14:01:00Z'));
    await s.tick(new Date('2026-10-07T15:01:00Z'));
    await s.tick(new Date('2026-10-08T14:01:00Z'));
    expect(seen).toHaveLength(2);
    // Without the hook the job is simply skipped.
    await createScheduler({ store, log: quiet }).tick(new Date('2026-10-09T14:01:00Z'));
  });
});

describe('weekly collect from the site', () => {
  // GitHub's cron skipped Sunday collects (Oct 4, Oct 11) and ran others
  // ~4 hours late, so the site starts them at 3:23 PM Central.
  it('queues the collect Sunday and Wednesday at 3:23 PM Central, once a slot', async () => {
    const store = await freshStore();
    const w = fakeWorker();
    const s = createScheduler({ store, log: quiet, ...w.opts });
    await s.tick(new Date('2026-10-11T20:22:00Z')); // Sun 3:22 PM CDT: not yet
    expect(w.calls.filter(c => c.file === 'weekly-collect.yml')).toEqual([]);
    await s.tick(new Date('2026-10-11T20:23:00Z'));
    await s.tick(new Date('2026-10-11T20:40:00Z'));
    await s.tick(new Date('2026-10-14T20:24:00Z')); // Wed
    await s.tick(new Date('2026-10-12T20:24:00Z')); // Mon: none
    // Winter: 3:23 PM CST is 21:23 UTC.
    await s.tick(new Date('2026-11-15T20:30:00Z'));
    await s.tick(new Date('2026-11-15T21:23:00Z'));
    const collects = w.calls.filter(c => c.file === 'weekly-collect.yml');
    expect(collects.map(c => c.slot)).toEqual(['2026-10-11', '2026-10-14', '2026-11-15']);
    expect(await s.ran('weekly-collect', new Date('2026-10-11T22:00:00Z'))).toMatchObject({ slot: '2026-10-11', ran: true });
    expect(await s.ran('weekly-collect-midweek', new Date('2026-10-14T22:00:00Z'))).toMatchObject({ slot: '2026-10-14', ran: true });
  });

  it('gives up for the day at 9 PM, leaving it to the fallback and the alert', () => {
    expect(dueSlot(job('weekly-collect'), new Date('2026-10-12T01:59:00Z'))).toBe('2026-10-11'); // 8:59 PM
    expect(dueSlot(job('weekly-collect'), new Date('2026-10-12T02:01:00Z'))).toBe(null);
  });

  it('slotStart is the slot time in Central across DST', () => {
    expect(slotStart(job('weekly-collect'), '2026-10-11').toISOString()).toBe('2026-10-11T20:23:00.000Z');
    expect(slotStart(job('weekly-collect'), '2026-11-15').toISOString()).toBe('2026-11-15T21:23:00.000Z');
    expect(slotStart(job('weekly-collect'), '2026-11-01').toISOString()).toBe('2026-11-01T21:23:00.000Z'); // DST ends that morning
    expect(slotStart(job('weekly-collect'), '2026-03-08').toISOString()).toBe('2026-03-08T20:23:00.000Z'); // and starts
  });

  it('missedCollect: a slot 3+ hours old with nothing collected since', () => {
    const wedCollect = '2026-10-08T00:50:13+00:00';
    // Oct 11 (Sunday's run never started): flagged from 6:23 PM.
    expect(missedCollect(wedCollect, new Date('2026-10-11T23:22:00Z'))).toBe(null);
    expect(missedCollect(wedCollect, new Date('2026-10-11T23:35:00Z'))).toMatchObject({ job: 'weekly-collect', slot: '2026-10-11' });
    // A collect that landed after the slot clears it, a late one too.
    expect(missedCollect('2026-10-11T20:58:00Z', new Date('2026-10-12T03:00:00Z'))).toBe(null);
    expect(missedCollect('2026-10-12T01:10:00Z', new Date('2026-10-12T03:00:00Z'))).toBe(null);
    // Sunday's arrived, Wednesday's didn't.
    expect(missedCollect('2026-10-11T20:58:00Z', new Date('2026-10-15T00:00:00Z'))).toMatchObject({ job: 'weekly-collect-midweek', slot: '2026-10-14' });
    // Nothing ever collected.
    expect(missedCollect(null, new Date('2026-10-11T23:35:00Z'))).toMatchObject({ job: 'weekly-collect' });
  });

  it("the admin's next collect follows the site's 3:23 PM, winter too", () => {
    expect(nextWeeklyRunUtc(new Date('2026-10-10T12:00:00Z')).toISOString()).toBe('2026-10-11T20:23:00.000Z');
    expect(nextWeeklyRunUtc(new Date('2026-11-12T12:00:00Z')).toISOString()).toBe('2026-11-15T21:23:00.000Z');
    expect(nextWeeklyRunUtc(new Date('2026-11-15T21:24:00Z')).toISOString()).toBe('2026-11-18T21:23:00.000Z');
  });
});

describe('scheduler in the app', () => {
  let server;
  afterEach(async () => { if (server) await new Promise(r => server.close(r)); server = null; });

  async function start(store, extra = {}) {
    const eventsFile = path.join(tmpDir, 'events.json');
    await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
    const slack = fakeSlack();
    const out = await createApp({
      storeBundle: { kind: 'file', store }, eventsFile, candidatesFile: path.join(tmpDir, 'none.json'), trustProxy: false,
      siteUrl: 'https://www.thevic361.com', slack, startScheduler: false, ...extra
    });
    server = http.createServer(out.app);
    await new Promise(r => server.listen(0, r));
    return { ...out, slack, base: `http://127.0.0.1:${server.address().port}` };
  }

  it('runs the hourly site check; the old fallback-cron endpoint is gone', async () => {
    const store = await freshStore();
    let now = new Date('2026-10-07T15:05:00Z');
    const { scheduler, slack, base } = await start(store, { now: () => now });
    expect((await fetch(base + '/api/scheduler/ran?job=social-kit')).status).toBe(404);

    // Nothing published: the hourly check says so once, not every hour.
    await scheduler.tick(now);
    now = new Date('2026-10-07T16:05:00Z');
    await scheduler.tick(now);
    expect(slack.alerts.filter(a => a.d.includes('upcoming events'))).toHaveLength(1);

    // Events back (collected yesterday): a recovery note.
    const events = Array.from({ length: 12 }, (_, i) => ({ date: '2026-10-09', name: `E${i}`, venue: 'V' }));
    await store.setPublished({ last_updated: now.toISOString(), events, auto_publish: { from: '2026-10-06T20:27:00-05:00' } });
    now = new Date('2026-10-07T17:05:00Z');
    await scheduler.tick(now);
    expect(slack.notes.some(n => n.title.includes('back to normal'))).toBe(true);

    // A collector stalled for 8+ days is flagged, even though a submission
    // just moved last_updated.
    await store.setPublished({ last_updated: now.toISOString(), events, auto_publish: { from: '2026-09-28T20:27:00-05:00' } });
    now = new Date('2026-10-07T18:05:00Z');
    await scheduler.tick(now);
    expect(slack.alerts.some(a => a.d.includes('No new events collected in 8 days'))).toBe(true);
  });

  it("alerts (Slack #alerts, so the owner inbox too) when a collect hasn't come in 3 hours after its slot", async () => {
    const store = await freshStore();
    const events = Array.from({ length: 12 }, (_, i) => ({ date: '2026-10-13', name: `E${i}`, venue: 'V' }));
    await store.setPublished({ last_updated: '2026-10-08T00:51:00Z', events, auto_publish: { from: '2026-10-08T00:50:13+00:00' } });
    let now = new Date('2026-10-11T22:05:00Z'); // Sun 5:05 PM: under 3 hours
    const { scheduler, slack } = await start(store, { now: () => now });
    await scheduler.tick(now);
    expect(slack.alerts.filter(a => a.d.includes('event collect'))).toEqual([]);
    now = new Date('2026-10-11T23:35:00Z');
    await scheduler.tick(now);
    const late = slack.alerts.filter(a => a.d.includes('event collect'));
    expect(late).toHaveLength(1);
    expect(late[0].d).toContain("Sunday's event collect (3:23 PM) hasn't come in after 3 hours");
    expect(late[0].d).toContain('Run workflow');
    // The collect lands: cleared.
    await store.setPublished({ last_updated: '2026-10-12T00:30:00Z', events, auto_publish: { from: '2026-10-12T00:20:00Z' } });
    now = new Date('2026-10-12T00:35:00Z');
    await scheduler.tick(now);
    expect(slack.notes.some(n => n.title.includes('back to normal') && n.text.includes('collect'))).toBe(true);
  });
});
