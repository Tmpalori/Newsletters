/* server/jobs.js — the town's jobs on Railway (JOBS_ON_RAILWAY.md).
 *
 * With JOBS_ON_RAILWAY=1 the scheduler and Pull Now queue a job in the
 * town's own database instead of starting a GitHub workflow, and the town's
 * jobs worker (scripts/jobs_worker.py, its own Railway service) claims it,
 * runs the same script the workflow ran and reports back. A collect hands
 * its candidates, collection metadata and enrichment cache to the site
 * here instead of committing them, and the site publishes at once.
 *
 *   POST /api/jobs/claim              → { job } or 204 (nothing queued)
 *   POST /api/jobs/:id/finish         { status: 'done'|'failed', result }
 *   GET  /api/jobs/files/:name        → { data, updated_at } or 404
 *   PUT  /api/jobs/files/:name        the JSON body is the file
 *
 * Every route needs `Authorization: Bearer <JOBS_SECRET>` (32+ characters;
 * the jobs service reads it as a Railway reference to the web service's
 * variable, so it's never copied). Without JOBS_ON_RAILWAY=1 and the secret
 * the routes answer 404 and nothing here runs: Victoria is unchanged.
 */
import crypto from 'node:crypto';
import express from 'express';

// What the worker can run, the workflow it replaces, and how long a run may
// take before the site gives up on it (the worker died or was redeployed).
export const JOB_KINDS = {
  // The collector's own budget is 55 minutes, then its uploads (which wait
  // out a web redeploy): 75 minutes before the site gives up on it.
  collect: { workflow: 'weekly-collect.yml', label: 'Weekly event collect', limitMs: 75 * 60 * 1000 },
  'event-check': { workflow: 'event-check.yml', label: 'Event check', limitMs: 20 * 60 * 1000 },
  'submission-review': { workflow: 'submission-review.yml', label: 'Submission review', limitMs: 10 * 60 * 1000, alertAfter: 4 }
};

// Files a job may hand the site: the collect's outputs and the submission
// review's small state (when it last alerted, attempts per submission).
export const JOB_FILES = ['candidates', 'collection_metadata', 'enrichment_cache', 'review_ai_alert', 'review_attempts'];

export function kindForWorkflow(file) {
  return Object.keys(JOB_KINDS).find(k => JOB_KINDS[k].workflow === file) || null;
}

export function jobsConfig(env = process.env) {
  const secret = String(env.JOBS_SECRET || '').trim();
  return { enabled: String(env.JOBS_ON_RAILWAY || '').trim() === '1' && secret.length >= 32, secret };
}

function secretOk(given, secret) {
  if (!secret || typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

function bearer(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.get('Authorization') || '');
  return m ? m[1].trim() : null;
}

// Events in the next `days` days of a candidates file (the collect message).
export function upcomingCount(candidates, now, days = 14) {
  const events = Array.isArray(candidates && candidates.events) ? candidates.events : [];
  const end = new Date(now.getTime() + days * 86400000).toISOString().slice(0, 10);
  return events.filter(e => e && typeof e.date === 'string' && e.date <= end).length;
}

/**
 * store: { enqueueJob, claimJob, finishJob, expireJobs, listJobs, getTownFile, setTownFile }
 * publish(): runs auto-publish on the new candidates → its result
 * slack: { notify, alert } (the app's, so the owner inbox gets them too)
 */
export function createJobs({ store, slack = null, publish = async () => null, siteUrl = '', nowFn = () => new Date(), env = process.env, log = console }) {
  const cfg = jobsConfig(env);
  // lastPollAt: the worker's last ask for work. busyUntil: while it runs a
  // job (and doesn't ask), it's alive until that job's time limit.
  const state = { lastPollAt: null, busyUntil: null, since: nowFn().toISOString() };
  const failStreak = new Map();   // kind → failed runs in a row

  // Not while one of the same kind is already queued or running: a worker
  // that was down comes back to one review, not a day of them, and a second
  // Pull Now doesn't start a second collect.
  async function enqueue(kind, slot, args = {}) {
    if (!JOB_KINDS[kind]) throw new Error(`unknown job ${kind}`);
    return store.enqueueJob(kind, slot, args, nowFn(), { unlessPending: true });
  }

  // A failed collect or event check alerts every time (they run a few times
  // a week); the 15-minute review once its failures reach an hour, so a
  // short OpenAI blip isn't an alert. A second try that fails again always
  // alerts. And say when it's working again.
  function failed(job, text, title = `${JOB_KINDS[job.kind].label} failed`) {
    const n = (failStreak.get(job.kind) || 0) + 1;
    failStreak.set(job.kind, n);
    const after = JOB_KINDS[job.kind].alertAfter || 1;
    if (slack && (after === 1 || n === after || String(job.slot).endsWith('-retry'))) {
      slack.alert(`job-${job.kind}-failing`, title, text, `${siteUrl}/admin.html`);
    }
  }
  function worked(job) {
    const n = failStreak.get(job.kind) || 0;
    failStreak.set(job.kind, 0);
    if (slack && n >= (JOB_KINDS[job.kind].alertAfter || 1)) {
      slack.notify({ title: `✅ ${JOB_KINDS[job.kind].label} working again`, text: `After ${n} failed run${n === 1 ? '' : 's'}.`, channel: 'alerts' });
    }
  }

  // A run past its time limit: the worker stopped answering (a redeploy or
  // a crash mid-run). It's queued once more, and said once (the row is
  // failed, so it isn't found again).
  async function expire(now) {
    const limits = Object.fromEntries(Object.entries(JOB_KINDS).map(([k, v]) => [k, v.limitMs]));
    const stale = await store.expireJobs(now, limits);
    for (const job of stale) {
      const again = !String(job.slot).endsWith('-retry');
      if (again) await enqueue(job.kind, `${job.slot}-retry`, job.args || {});
      failed(job, "The jobs worker stopped answering in the middle of it (a redeploy or a crash). " +
        (again ? 'It has been started again.' : 'It already ran twice; it runs again at its next time. Check the jobs service in Railway.'),
      `${JOB_KINDS[job.kind].label} didn't finish`);
    }
    return stale;
  }

  async function finished(job, result) {
    const r = result || {};
    // Cut short by a redeploy of the jobs service: run it again, quietly.
    if (job.status === 'failed' && r.interrupted === true) {
      if (!String(job.slot).endsWith('-retry')) {
        await enqueue(job.kind, `${job.slot}-retry`, job.args || {});
        return;
      }
    }
    if (job.status === 'failed') {
      const tail = Array.isArray(r.log_tail) ? r.log_tail.slice(-8).map(l => String(l).slice(0, 300)).join('\n') : '';
      failed(job, `${r.error || 'The script exited with an error.'}${tail ? `\n${tail}` : ''}`);
      return;
    }
    worked(job);
    if (job.kind !== 'collect') return;
    // The upload was stored but its publish failed: the events aren't live.
    if (r.published && r.published.ok === false) {
      if (slack) slack.alert('job-collect-publish', 'Collect finished but its events didn\'t publish',
        `${String(r.published.message || r.published.error || 'The publish failed.').slice(0, 300)} The hourly check tries again; Save & Publish in admin publishes now.`, `${siteUrl}/admin.html`);
      await enqueue('event-check', `after-collect-${job.id}`);
      return;
    }
    // What the GitHub collect said in Slack, and the event check after it.
    if (slack) {
      const n = Number.isFinite(r.upcoming) ? r.upcoming : '?';
      const warnings = typeof r.warnings === 'string' ? r.warnings : '';
      slack.notify({ title: '🗓️ Collect done', text: `${n} events in the next two weeks are live; edit or remove any in admin.`, link: `${siteUrl}/admin.html`, channel: 'activity' });
      if (warnings) slack.notify({ title: `⚠️ Weekly collect: ${warnings}`, link: `${siteUrl}/admin.html`, channel: 'alerts' });
    }
    await enqueue('event-check', `after-collect-${job.id}`);
  }

  function register(app) {
    const guard = (req, res, next) => {
      if (!cfg.enabled) return res.status(404).json({ ok: false, error: 'not-found' });
      if (!secretOk(bearer(req), cfg.secret)) return res.status(401).json({ ok: false, error: 'unauthorized' });
      return next();
    };
    // The global JSON parser skips /api/jobs/ (index.js); each route parses
    // only once the secret checked out, with room for a collect's files.
    const finishJson = express.json({ limit: '1mb' });
    const fileJson = express.json({ limit: '16mb' });
    const wrap = fn => (req, res) => fn(req, res).catch(err => {
      log.error('[jobs]', req.method, req.path, err.message);
      res.status(500).json({ ok: false, error: 'jobs-failed', message: err.message });
    });

    app.post('/api/jobs/claim', guard, wrap(async (req, res) => {
      const now = nowFn();
      state.lastPollAt = now.toISOString();
      state.busyUntil = null;
      await expire(now);
      const job = await store.claimJob(now);
      if (!job) return res.status(204).end();
      state.busyUntil = new Date(now.getTime() + JOB_KINDS[job.kind].limitMs).toISOString();
      res.json({ ok: true, job: { id: job.id, kind: job.kind, slot: job.slot, args: job.args || {} } });
    }));

    app.post('/api/jobs/:id/finish', guard, finishJson, wrap(async (req, res) => {
      const status = req.body && req.body.status === 'done' ? 'done' : 'failed';
      const result = req.body && typeof req.body.result === 'object' && req.body.result ? req.body.result : null;
      const job = await store.finishJob(req.params.id, { status, result }, nowFn());
      state.lastPollAt = nowFn().toISOString();
      state.busyUntil = null;
      if (!job) return res.status(404).json({ ok: false, error: 'not-running' });
      try { await finished(job, result); } catch (err) { log.warn('[jobs] after finish:', err.message); }
      res.json({ ok: true });
    }));

    app.get('/api/jobs/files/:name', guard, wrap(async (req, res) => {
      if (!JOB_FILES.includes(req.params.name)) return res.status(404).json({ ok: false, error: 'unknown-file' });
      const f = await store.getTownFile(req.params.name);
      if (!f) return res.status(404).json({ ok: false, error: 'none-yet' });
      res.json({ ok: true, data: f.data, updated_at: f.updated_at });
    }));

    app.put('/api/jobs/files/:name', guard, fileJson, wrap(async (req, res) => {
      const name = req.params.name;
      if (!JOB_FILES.includes(name)) return res.status(404).json({ ok: false, error: 'unknown-file' });
      const body = req.body;
      if (!body || typeof body !== 'object') return res.status(400).json({ ok: false, error: 'json-object-required' });
      if (name === 'candidates' && (!Array.isArray(body.events) || !body.last_updated)) {
        return res.status(400).json({ ok: false, error: 'not-a-candidates-file' });
      }
      await store.setTownFile(name, body, nowFn());
      // New candidates publish now (no commit, no redeploy). The file is
      // stored either way: a failed publish is retried by the hourly check,
      // so it doesn't fail the upload (or the collect).
      let published = null;
      if (name === 'candidates') {
        try { published = await publish(); } catch (err) {
          log.warn('[jobs] publish after upload failed:', err.message);
          published = { ok: false, error: 'publish-failed', message: err.message };
        }
      }
      res.json({ ok: true, ...(published ? { published } : {}) });
    }));
  }

  // HQ's view (server/hq.js jobsSummary): each kind's last run however long
  // ago, and when the worker last asked for work since this process started.
  async function stats() {
    return { ...(await store.jobStats(nowFn())), worker_last_seen: state.lastPollAt, worker_since: state.since };
  }

  return { enabled: cfg.enabled, enqueue, expire, register, state, stats, listJobs: n => store.listJobs(n) };
}
