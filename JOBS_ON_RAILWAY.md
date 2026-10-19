# Jobs on Railway: one simple, identical setup for every town

Owner's goal (October 2026): as simple as possible, everything on Railway
rather than GitHub, the same for all five towns, and everything reported to
HQ so the owner's assistant can see what's going on.

## Where we were (before October 2026)

Each town was a Railway web service and its own Postgres, and the jobs
(collect, event check, submission review, social kit, ads report, uptime,
digest) ran as GitHub Actions. That cost, per town: a GitHub Environment,
the same cron secrets copied into Railway and GitHub by hand, a GitHub token
on Railway so the site could start its jobs, and a commit to `main` for
every collect (which redeployed every town). Missing Environment values
silently fell back to Victoria's repo-level secrets (Meta page, ad account,
ops inbox), which is how a new town could post to Victoria's Facebook page.

## Where we are (phase 5 done)

GitHub holds the code and runs the tests (`tests.yml`), plus three manual
tools (`apify-probe.yml`, `gemini-probe.yml`, `market-scan.yml`) that never
run on a schedule. Nothing else: every town, Victoria included, runs every
job on its own Railway jobs service, and no web service needs a
`GITHUB_TOKEN`.

Every town, Victoria included, is three Railway pieces in the
Newsletters project:

| Piece | Name | What it does |
|---|---|---|
| Web | `<domain>` (e.g. `thecrane308`) | The site, admin, API and scheduler (as today) |
| Database | `Postgres-<Town>` | Everything the town stores, now also its collected events and job history |
| Jobs | `<domain>-jobs` | A small always-on Python worker that runs the town's jobs when the web service queues them |

How a job runs:

1. The web service's scheduler (`server/scheduler.js`, already per town and
   in the town's timezone) decides a job is due and adds it to the town's
   job queue (a table in its own database) instead of starting a GitHub
   workflow. Pull Now in the admin does the same.
2. The jobs worker asks the web service for the next job over Railway's
   private network, runs the same Python script the workflow ran
   (`collect_events.py`, `scripts/sweep_events.py`, ...) and reports the
   result back: status, duration, counts, warnings and the end of its log.
3. A collect uploads its candidates, collection metadata and enrichment
   cache to the web service, which stores them in the database and
   auto-publishes at once. No commit, no redeploy.

Settings and secrets:

- A town's secrets live only on its own web service. The jobs service
  reads them through Railway references (`${{thecrane308.EVENT_CHECK_SECRET}}`),
  so nothing is ever copied and nothing is in GitHub.
- The worker reaches its web service at `http://${{<web>.RAILWAY_PRIVATE_DOMAIN}}:8080`
  with one `JOBS_SECRET` (also a reference). Requests from outside Railway
  can't reach the private address.
- Keys every town already shares (Apify, OpenAI, Gemini, the Slack
  webhooks) are set once as project-shared variables, referenced by each
  jobs service. Per-town keys (Meta page and Instagram tokens, ad account,
  Resend, Stripe) are never shared.
- A town can only ever see its own Meta credentials, so it can't post to
  another town's page.

HQ sees everything: each town's `/api/hq/summary` adds its job history (last
run of each job, status, counts per source, warnings, duration) and its
recent alerts. HQ also watches each town's health, replacing `uptime.yml`.
The owner's assistant reads it all through HQ.

The jobs and when the scheduler queues them (town time; `server/scheduler.js`):

| Job (`server/jobs.js` kind) | When | What |
|---|---|---|
| `collect` | Sun and Wed 3:23 PM | `collect_events.py --candidates-only`, then publish |
| `event-check` | after each collect, Mon 6:43 AM, Thu 6:00 AM | `scripts/sweep_events.py` |
| `submission-review` | every 15 minutes | `scripts/review_submissions.py` |
| `meta-ads` | daily 8:37 AM | `scripts/meta_ads.py report --scheduled`; the site posts the report to Slack activity; nothing without the town's ads settings |
| `social-kit` | daily 8:47 AM | `scripts/social_kit.py`, the kit into the town's database, `scripts/social_post.py` with `SOCIAL_AUTOPOST=1` |
| `digest` | Sun 9:00 PM | `send_digest.py` from the live list to the owner, through Resend (`RESEND_API_KEY=${{<web service>.RESEND_API_KEY}}`) or Gmail (`SMTP_EMAIL`/`SMTP_PASSWORD`); nothing without one of them |

The newsletter, sponsor reports, privacy purge and the hourly health check
run in the web service itself. A web service without jobs on Railway runs
none of the worker jobs (there's no GitHub fallback any more).

What the owner still does per town: buy the domain, the Stripe account
(identity check), the Facebook page and Instagram account, and merge one
PR. A Resend account key and the mailing address are given once.

## Phases

Each phase is its own PR with tests. Victoria's output must not change
(golden tests) until phase 5, whose whole purpose is moving her.

### Phase 1: safety and quiet (now)

- [x] **Meta guard.** The social kit post and the ads report act for a town
      only with credentials marked as that town's (`META_TOWN=<slug>` and the
      ids pinned in its `town.json` `"meta"`; in its
      settings); Victoria unchanged. Inherited repo-level Meta secrets can
      never post or read ads for another town.
- [x] **Quiet until the first collect.** A town that has never collected
      sends no auto-publish, "0 upcoming", stale or missed-collect alerts,
      and its scheduler starts only the collect. Decided by "has collected"
      (the published payload's `auto_publish.from`), not by `TOWN_WORKFLOWS`.
- [x] **One switch.** `townWorkflowsReady()` also honours `town.json`
      `"workflows": true`, so the scheduler, Pull Now and the GitHub cron
      agree; `TOWN_WORKFLOWS=0` stays an off switch.
- [x] **Fewer restarts.** A town's service doesn't redeploy for Victoria's
      `docs/social/**` and `docs/events.json` commits (watch paths).

### Phase 2: the jobs worker (Kearney first)

- [x] Database: `job_queue` (id, job, slot, status, queued/started/finished,
      result json) and `town_files` (name, json, updated) on both stores.
- [x] Web: `server/jobs.js` with internal routes, `JOBS_SECRET` only:
      `POST /api/jobs/claim`, `POST /api/jobs/:id/finish`,
      `GET|PUT /api/jobs/files/:name`. A finished collect auto-publishes.
- [x] Web: `autopublish` and the admin Sources tab read candidates and
      metadata from `town_files` first, the bundled file second (Victoria
      keeps her files until phase 5).
- [x] Web: the scheduler queues jobs instead of dispatching GitHub when
      `JOBS_ON_RAILWAY=1`; Pull Now likewise; a stuck job (worker gone) is
      released after its time limit and alerts once.
- [x] Worker: `scripts/jobs_worker.py` (poll, run, report, upload) and
      `Dockerfile.jobs` (Python, its requirements, ffmpeg later for reels).
- [x] Jobs: weekly collect, event check, submission review. Social kit and
      ads report come with a town's Meta accounts (phase 2b).
- [x] Railway: `thecrane308-jobs` service, its references, shared project
      variables for the shared keys; then `JOBS_ON_RAILWAY=1` on Kearney and
      `"workflows": false` in its `town.json` so GitHub stops collecting it.
      (The shared APIFY_TOKEN, OPENAI_API_KEY and GEMINI_API_KEY values are
      the owner's to paste in once.)
- [x] Docs: RAILWAY.md "New town" rewritten for this setup; LAUNCH.md's
      GitHub steps removed for new towns.

### Phase 2b: social kit and ads on the worker

- [x] Kit images and reels stored in the town's database (`social_files`,
      made on first use; only the latest kit is kept, 20 MB a file and 60 MB
      a kit at most) and served from `/social/latest/<name>` on the town's
      own site, which Instagram needs for image URLs. The worker uploads a
      kit under its build id and publishes it whole (`PUT
      /api/jobs/social/:build/:name`, `POST /api/jobs/social/:build/publish`);
      a town with no kit, and Victoria's `docs/social` files, stay 404s on
      every other domain.
- [x] `social_post.py` runs on the worker (job `social-kit`, queued daily at
      8:47 AM town time once the town has collected; Monday posts the week,
      Thursday the weekend and today with a paid pick, other days today)
      with the town's own Meta settings (`META_TOWN` and the page id pinned
      in `town.json`; Facebook only until an Instagram id is pinned) and
      only with `SOCIAL_AUTOPOST=1` on the jobs service. What went out is
      kept on the site (`social_posted`), saved before each publish call, so
      a retry or restart never posts twice; a failed post alerts like any
      failed job. Victoria's social kit stays on GitHub until phase 5.
      Pinned pages: Medford, Shoals, Lincoln, Virginia Beach. The jobs image
      now has Chromium (branded slides) and ffmpeg (the weekend Reel).
- [x] `meta_ads.py` (the daily ads report) on the worker (phase 5): job
      `meta-ads`, queued daily at 8:37 AM town time for every jobs town. The
      worker runs `meta_ads.py report --scheduled --result <file>` and hands
      the report to the site, which posts it to Slack activity (as
      meta-ads.yml did). A town acts only with its own ads settings
      (`META_TOWN` and the ad account its `town.json` pins as
      `"meta".ad_account_id`); a town with none pinned, or no token, does
      nothing (the job is done, "skipped"). Victoria's report uses the one
      ad account her token sees, as on GitHub.

### Phase 3: HQ sees everything

- [x] `/api/hq/summary` adds `jobs` (last run of each job and its result)
      and recent alerts; HQ shows them per town and to the assistant.
      (tristen-hq: a silent worker or a failed collect is a town problem,
      so it reaches the inbox; alerts already reach HQ's inbox.)
- [x] HQ checks each town's `/api/health` every few minutes and alerts once
      when a town is down or a job is overdue (replaces `uptime.yml`).
      (Already: tristen-hq src/watch.js turns a site that's down into an
      inbox item.)
- [x] The weekly digest (replaces `weekly-digest.yml`): kept in this repo
      rather than HQ, as the jobs worker's `digest` job (Sunday 9 PM town
      time, `send_digest.py` from the site's live list, the same email to
      the owner). It needs `RESEND_API_KEY` (a reference to the town's web
      service's key) or `SMTP_EMAIL` and `SMTP_PASSWORD` on the town's jobs
      service and does nothing without them. HQ still sees every run.

### Phase 4: new towns the new way

- [x] `scripts/bootstrap_town.py` / an agent runbook: Railway web, jobs and
      Postgres with backups, every variable (fresh secrets, never shown),
      domain, Cloudflare DNS and apex redirect, HQ registration. (RAILWAY.md
      "New town, the simple way".)
- [x] Source research per town (feeds, venues, recurring events), checked
      against Victoria's events per day. (Done October 2026, before FB/IG,
      events a day in a 17-day window: Medford 19, Shoals 9.4, Kearney 8,
      Tupelo 7; Kearney's first full run with FB/IG was 12 against
      Victoria's 15.)
- [x] Tupelo, Medford, The Shoals: web, jobs and Postgres services, domains
      and Cloudflare DNS (apex redirects to www), registered in HQ
      (`HQ_TOWN_<SLUG>`, `HQ_SSO_<SLUG>`, `HQ_REPLY_<SLUG>`), first collect
      run on the jobs worker (October 15, 2026). A town that boots after its
      Wednesday or Sunday collect window gets its first collect from Pull Now.

### Phase 5: Victoria moves (after the others run cleanly for 2+ weeks)

- [x] `thevic361-jobs`, `JOBS_ON_RAILWAY=1`, a live check before and after
      (moved early, October 15 2026, at the owner's request). Her collect,
      event check and submission review run on the worker with the same
      settings her GitHub collect used (Facebook and Instagram posts on,
      the rest at the code defaults). GitHub's fallback crons stand down
      for her: the collect and event check because the site ran the slot,
      the submission review because her /api/config says jobs_on_railway.
- [x] Her social kit on her worker like every town's: stored in her
      database and served at https://www.thevic361.com/social/latest/; until
      her worker publishes its first kit (or whenever her database can't
      answer) the git copy in `docs/social/latest/` is still served, so links
      already out keep working. Her page is pinned like another town's
      (`town.py` VICTORIA `"meta": {"page_id": "1388965530960534"}`; no
      Instagram id until one is linked), and her worker refuses another
      town's page or `META_TOWN`. What GitHub posted
      (`docs/social/latest/posted.json`) is merged under her site's
      `social_posted` file, so the switch day never posts a day and kind
      twice.
- [x] Her ads report and digest on her worker (2b, 3).
- [x] Her GitHub workflows retired: every workflow file deleted except
      `tests.yml` and the manual tools; the scheduler never starts a GitHub
      workflow (it queues for the worker or doesn't run the job), and a
      town with `JOBS_ON_RAILWAY=1` ignores `GITHUB_TOKEN` (no workflow
      dispatch, no candidates read from GitHub, no `docs/events.json`
      commit on Save & Publish: her published events live in her database
      like every town's, and `docs/events.json` stays in git only as the
      frozen fallback for an empty database).
- [ ] Owner, in Railway and GitHub: remove `GITHUB_TOKEN` from Victoria's
      web service, add her jobs service's social, ads and digest variables,
      delete the retired repo secrets and variables (RAILWAY.md "Victoria
      moved").
- [ ] Cleanups found in the October 2026 audit: Railway healthcheck path,
      the malformed `NODE_ENV` variable, separate event-check, review and
      ads secrets, the apex domain still on Squarespace, and the
      `readonly-stats-temp` service.

## Rules that don't change

- One database per town; a town never reads another town's data or secrets.
- Victoria's output doesn't change except where phase 5 moved it (her
  `/social/latest/` now from her database), checked by goldens and
  `scripts/live_check.py`.
- The `--candidates-only` invariant: the collector never writes
  `docs/events.json`.
