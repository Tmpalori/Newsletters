/* server/scheduler.js — The always-on Railway server is the clock.
 *
 * Every town's jobs run on Railway (JOBS_ON_RAILWAY.md): the scheduler
 * decides a job is due, in the town's timezone (Intl does the DST switch),
 * and either runs it in-process or queues it for the town's jobs worker
 * (server/jobs.js, scripts/jobs_worker.py). Nothing is started on GitHub.
 * Times are Victoria's; a town may move them (town.json "schedule"):
 *
 *   weekly-collect     Sun 3:23 PM   queue a collect (the week's events)
 *   weekly-collect-midweek Wed 3:23 PM the same, midweek
 *   event-check        Mon 6:43 AM   queue the event check (before the send)
 *   event-check-weekend Thu 6:00 AM  the same, before the weekend issue
 *   newsletter         Mon 7:43 AM   sendWeekly() in-process; retried on failure
 *   newsletter-weekend Thu 7:00 AM   the weekend issue (Friday–Sunday), same way
 *   meta-ads           daily 8:37 AM queue the ads report
 *   social-kit         daily 8:47 AM queue the social kit (build and post)
 *   weekly-digest      Sun 9:00 PM   queue the digest email of what's collected
 *   privacy-purge      daily 3:17 AM drop old submitter IPs and contact messages (server/privacy.js)
 *   sponsor-reports    daily 9:00 AM sponsors.sendSponsorReports(now), if it exists
 *   drop-notices       daily 9:30 AM tell submitters whose event didn't make its day's list
 *   event-recaps       daily 9:35 AM free submitters' "how your event did" (the day after)
 *   submission-review  every 15 min  queue the AI submission review
 *   health             hourly        retry a missed boot auto-publish, then check the
 *                                    database, upcoming events, collector freshness
 *
 * Each daily/weekly job runs once per slot (its local date). The claim is
 * a row in the store (scheduler_runs), taken atomically, so a restart or the
 * old and new containers overlapping during a deploy can't fire it twice.
 * A job missed while the server was down still runs later the same day
 * (until `until`). The 15-minute and hourly jobs are harmless to repeat and
 * only tracked in memory. A worker job (`kind`, one of server/jobs.js
 * JOB_KINDS) runs only where jobs are on (JOBS_ON_RAILWAY=1); elsewhere it
 * doesn't run at all.
 *
 * Production only (RAILWAY_ENVIRONMENT_NAME=production); SCHEDULER=0 turns it
 * off. `ran(name)` says whether a job's latest slot was claimed and done.
 * A paused town (TOWN_DORMANT=1, server/town.js) runs only DORMANT_JOBS:
 * nothing is sent, posted or collected, but old personal data is still
 * purged on time and the hourly check still watches the database.
 */

import { town } from './town.js';

const MIN = 60 * 1000;

// Wall-clock parts of an instant in the town's timezone (Central for
// Victoria; the job times below are in it).
export function localParts(now) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: town.timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short'
  }).formatToParts(now)) parts[p.type] = p.value;
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    dow,
    minutes: Number(parts.hour) * 60 + Number(parts.minute)
  };
}

const hm = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const pad = n => String(n).padStart(2, '0');
function prevDate(ymd, days) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
const dowOf = ymd => new Date(ymd + 'T12:00:00Z').getUTCDay();

export const JOBS = [
  // Until 9 PM: a collect started later still lands the same evening.
  { name: 'weekly-collect', dow: 0, at: '15:23', until: '21:00', kind: 'collect' },
  { name: 'weekly-collect-midweek', dow: 3, at: '15:23', until: '21:00', kind: 'collect' },
  { name: 'event-check', dow: 1, at: '06:43', until: '12:00', kind: 'event-check' },
  // And before Thursday's weekend issue.
  { name: 'event-check-weekend', dow: 4, at: '06:00', until: '12:00', kind: 'event-check' },
  // Until noon: a deploy or restart later in the day mustn't send an issue
  // at night.
  { name: 'newsletter', dow: 1, at: '07:43', until: '12:00', retryMins: [5, 15, 30] },
  // The weekend issue (Friday–Sunday), Thursday mornings.
  { name: 'newsletter-weekend', dow: 4, at: '07:00', until: '12:00', retryMins: [5, 15, 30] },
  { name: 'meta-ads', at: '08:37', until: '18:00', kind: 'meta-ads' },
  // Until noon: a "Today in..." post caught up after a missed slot (a
  // failed deploy) is still useful in the morning, not at 5 PM.
  { name: 'social-kit', at: '08:47', until: '12:00', kind: 'social-kit' },
  // Sunday night, after the afternoon's collect.
  { name: 'weekly-digest', dow: 0, at: '21:00', until: '23:59', kind: 'digest' },
  { name: 'sponsor-reports', at: '09:00', until: '23:59' },
  // Approved submissions that didn't make their day's list (server/dropNotices.js).
  { name: 'drop-notices', at: '09:30', until: '18:00' },
  // Free submitters' "how your event did", the morning after (server/eventRecaps.js).
  { name: 'event-recaps', at: '09:35', until: '18:00' },
  // Personal-data retention (server/privacy.js): old submitter IPs and
  // contact messages. Early morning, out of everyone's way.
  { name: 'privacy-purge', at: '03:17', until: '23:59' },
  { name: 'submission-review', every: 15, kind: 'submission-review' },
  { name: 'health', every: 60 }
];

export const DORMANT_JOBS = new Set(['privacy-purge', 'health']);

// A job's start time in the town: JOBS' time unless the town moves it
// (town.schedule, { "newsletter": "07:13" }), so several towns' sends and
// collects can be staggered. Days stay the same everywhere: the issues are
// Monday's and Thursday's for every town.
export function startOf(job) {
  return (town.schedule && town.schedule[job.name]) || job.at;
}

// "7:43 AM" for a job, for labels (the admin setup checklist).
export function startLabel(name, jobs = JOBS) {
  const job = jobs.find(j => j.name === name);
  const [h, m] = startOf(job).split(':').map(Number);
  return `${(h + 11) % 12 + 1}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
}

// A town's schedule must name real jobs and start them before their
// cutoff (a newsletter moved past noon would never send). Checked at boot.
export function checkTownSchedule(jobs = JOBS) {
  for (const [name, at] of Object.entries(town.schedule || {})) {
    const job = jobs.find(j => j.name === name);
    if (!job || job.every) throw new Error(`TOWN=${town.id}: schedule.${name} isn't a daily or weekly job in server/scheduler.js`);
    if (hm(at) > hm(job.until)) throw new Error(`TOWN=${town.id}: schedule.${name} (${at}) is after its cutoff (${job.until})`);
  }
}

// The slot a job is due in right now, or null when it isn't due.
export function dueSlot(job, now) {
  const c = localParts(now);
  if (job.every) {
    const n = Math.floor(c.minutes / job.every) * job.every;
    return `${c.date}T${pad(Math.floor(n / 60))}:${pad(n % 60)}`;
  }
  if (job.dow != null && c.dow !== job.dow) return null;
  if (c.minutes < hm(startOf(job)) || c.minutes > hm(job.until)) return null;
  return c.date;
}

// The most recent slot a daily/weekly job should have run in (today once
// its time has passed, else the previous matching day): what ran() and
// the missed-collect check look at.
export function lastSlot(job, now) {
  const c = localParts(now);
  for (let i = 0; i <= 7; i++) {
    const d = prevDate(c.date, i);
    if (job.dow != null && dowOf(d) !== job.dow) continue;
    if (i === 0 && c.minutes < hm(startOf(job))) continue;
    return d;
  }
  return null;
}

// The instant a daily/weekly job's slot starts: its time on `ymd` in the
// town's timezone.
export function slotStart(job, ymd) {
  const target = Date.parse(`${ymd}T00:00:00Z`) / MIN + hm(startOf(job));
  let t = target * MIN;
  for (let i = 0; i < 3; i++) {
    const p = localParts(new Date(t));
    const diff = Date.parse(`${p.date}T00:00:00Z`) / MIN + p.minutes - target;
    if (!diff) break;
    t -= diff * MIN;
  }
  return new Date(t);
}

export const COLLECT_JOBS = ['weekly-collect', 'weekly-collect-midweek'];

// The latest collect slot that started `hours` ago or more with nothing
// collected since (`collectedAt`: when the published candidates were
// collected), or null. For the hourly health check.
export function missedCollect(collectedAt, now, { hours = 3, jobs = JOBS } = {}) {
  const got = Date.parse(collectedAt || '');
  let worst = null;
  for (const job of jobs.filter(j => COLLECT_JOBS.includes(j.name))) {
    const slot = lastSlot(job, now);
    if (!slot) continue;
    const start = slotStart(job, slot);
    if (now.getTime() - start.getTime() < hours * 60 * MIN) continue;
    if (Number.isFinite(got) && got >= start.getTime()) continue;
    if (!worst || start > worst.start) worst = { job: job.name, slot, start };
  }
  return worst;
}

export function schedulerEnabled(env = process.env) {
  return env.RAILWAY_ENVIRONMENT_NAME === 'production' && env.SCHEDULER !== '0';
}

/**
 * queueJob(job, slot): hands a worker job to the town's jobs worker (null: jobs are off).
 * canQueue(job): whether the worker runs it.
 * handlers: { newsletter(), sponsorReports(now), privacyPurge(now), health(now), collected() }, each async.
 *   collected() → whether the town has ever collected (only the collect starts until it has)
 *   newsletter() → { ok, error?, retry?, message? } (see index.js)
 *   sponsorReports / health may be missing: the job is then skipped.
 */
export function createScheduler({ store, slack = null, nowFn = () => new Date(), handlers = {}, siteUrl = '', jobs = JOBS, log = console, queueJob = null, canQueue = () => false }) {
  checkTownSchedule(jobs);
  const memory = new Map(); // job → last in-memory slot
  const busy = new Set();
  const failStreak = new Map(); // repeating job → failed runs in a row
  const state = { lastTick: null };
  let timer = null;

  const persisted = job => !job.every;

  // Jobs on Railway (server/jobs.js): the town's jobs worker runs it.
  async function queue(job, slot) {
    try {
      await queueJob(job, slot);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  // Run one job's body. → { ok, final?, message? }
  async function runJob(job, now, slot) {
    if (job.kind) return queue(job, slot);
    const fn = { newsletter: handlers.newsletter, 'newsletter-weekend': handlers.newsletterWeekend, 'sponsor-reports': handlers.sponsorReports,
      'privacy-purge': handlers.privacyPurge, 'drop-notices': handlers.dropNotices, 'event-recaps': handlers.eventRecaps, health: handlers.health }[job.name];
    try {
      const out = await fn(now);
      return out && typeof out === 'object' && 'ok' in out ? out : { ok: true };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  // Whether a job can run at all here; otherwise it isn't claimed.
  function available(job) {
    if (town.dormant && !DORMANT_JOBS.has(job.name)) return false;
    // A worker job runs only where jobs are on, by the town's jobs worker.
    if (job.kind) return Boolean(queueJob) && canQueue(job);
    if (job.name === 'newsletter') return typeof handlers.newsletter === 'function' && (!handlers.newsletterReady || handlers.newsletterReady());
    if (job.name === 'newsletter-weekend') return typeof handlers.newsletterWeekend === 'function' && (!handlers.newsletterWeekendReady || handlers.newsletterWeekendReady());
    if (job.name === 'sponsor-reports') return typeof handlers.sponsorReports === 'function';
    if (job.name === 'privacy-purge') return typeof handlers.privacyPurge === 'function';
    if (job.name === 'drop-notices') return typeof handlers.dropNotices === 'function';
    if (job.name === 'event-recaps') return typeof handlers.eventRecaps === 'function';
    if (job.name === 'health') return typeof handlers.health === 'function';
    return false;
  }

  async function runPersisted(job, slot, now) {
    const claim = await store.claimJobRun(job.name, slot, now);
    if (!claim.claimed) return null;
    const out = await runJob(job, now, slot);
    const attempts = claim.attempts || 1;
    const retries = job.retryMins || (job.kind ? [2, 5] : []);
    let status = out.ok ? 'done' : 'failed';
    let retryAt = null;
    if (!out.ok && !out.final && attempts <= retries.length) {
      status = 'retry';
      retryAt = new Date(now.getTime() + retries[attempts - 1] * MIN).toISOString();
    }
    // detail: what a done slot did ("sent: 52 recipients", "no-subscribers"),
    // else why it failed.
    await store.finishJobRun(job.name, slot, { status, retry_at: retryAt, detail: String(out.detail || out.message || out.error || '').slice(0, 500) });
    if (status === 'failed' && !out.final && slack) {
      slack.alert(`scheduler-${job.name}-${slot}`, job.name === 'newsletter' ? `Monday newsletter send failed after ${attempts} tries`
        : job.name === 'newsletter-weekend' ? `Thursday weekend newsletter send failed after ${attempts} tries` : `Scheduled ${job.name} couldn't start`,
      String(out.message || out.error || 'unknown error'), `${siteUrl}/admin.html`);
    }
    if (status !== 'done') log.warn(`[scheduler] ${job.name} ${slot}: ${status}`, out.message || out.error || '');
    return status;
  }

  // A town that has never collected has nothing for the event check, the
  // social kit, the ads report or the submission review to work on, and
  // they'd only fail and alert: until its first collect lands, only the
  // collect starts. (handlers.collected: Victoria's is always true.)
  async function waitsForFirstCollect(job, known) {
    if (!job.kind || job.name.startsWith('weekly-collect') || typeof handlers.collected !== 'function') return false;
    if (known.collected === undefined) {
      try { known.collected = Boolean(await handlers.collected()); } catch { known.collected = true; }
    }
    return !known.collected;
  }

  async function tick(now = nowFn()) {
    state.lastTick = now.toISOString();
    const known = {};
    for (const job of jobs) {
      const slot = dueSlot(job, now);
      if (!slot || busy.has(job.name) || !available(job)) continue;
      if (await waitsForFirstCollect(job, known)) continue;
      if (!persisted(job) && memory.get(job.name) === slot) continue;
      busy.add(job.name);
      try {
        if (persisted(job)) {
          await runPersisted(job, slot, now);
        } else {
          memory.set(job.name, slot);
          const out = await runJob(job, now, slot);
          if (!out.ok) log.warn(`[scheduler] ${job.name} ${slot}:`, out.message || out.error || '');
          // Failing an hour straight (4 runs of a 15-minute job) is broken,
          // not a blip: once, and a note when it works again.
          const n = out.ok ? 0 : (failStreak.get(job.name) || 0) + 1;
          const was = failStreak.get(job.name) || 0;
          failStreak.set(job.name, n);
          if (slack && !out.final && n === Math.max(2, Math.ceil(60 / job.every))) {
            slack.alert(`scheduler-${job.name}-streak`, `Scheduled ${job.name} keeps failing`,
              `${n} runs in a row: ${String(out.message || out.error || 'unknown error')}`, `${siteUrl}/admin.html`);
          } else if (slack && out.ok && was >= Math.max(2, Math.ceil(60 / job.every))) {
            slack.notify({ title: `✅ Scheduled ${job.name} working again`, text: `After ${was} failed runs.`, channel: 'alerts' });
          }
        }
      } catch (err) {
        log.warn(`[scheduler] ${job.name} failed:`, err.message);
      } finally {
        busy.delete(job.name);
      }
    }
  }

  // Did the scheduler already run this job's most recent slot? Ran isn't
  // sent: a newsletter slot with nobody to send to is done too, so outcome
  // says which ("sent", "no-subscribers", "already-sent"...) and detail the
  // rest (counts; HQ only, not the public route).
  async function ran(name, now = nowFn()) {
    const job = jobs.find(j => j.name === name && persisted(j));
    if (!job) return null;
    const slot = lastSlot(job, now);
    const row = slot ? await store.getJobRun(job.name, slot) : null;
    const detail = row && row.detail ? String(row.detail) : null;
    const outcome = detail && row.status === 'done' ? (/^([a-z][a-z-]*)(?::|$)/.exec(detail) || [])[1] || null : null;
    return { job: name, slot, ran: Boolean(row && row.status === 'done'), outcome, detail };
  }

  function start(intervalMs = MIN) {
    if (timer) return;
    // Every minute, aligned loosely; the first tick waits for boot to settle.
    const first = setTimeout(() => { tick().catch(() => {}); }, 15 * 1000);
    timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
    if (first.unref) first.unref();
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { tick, ran, start, stop, state };
}
