# The Vic 361 — Railway setup and smoke tests

The whole site runs on Railway: the Express server in `server/index.js`
serves the public pages, `/events.json`, the submit form, the admin and every
API from one service backed by Railway Postgres. `www.thevic361.com` is a
CNAME to the Railway service (see AGENTS.md "Production hosting").

The environment variable reference lives in **AGENTS.md → Environment
variables**. This file only covers standing up an environment and checking
it works.

Every town, Victoria included, runs its jobs on its own Railway jobs
service (JOBS_ON_RAILWAY.md; "Jobs on Railway" below). GitHub only holds
the code and runs the tests: no workflow runs a town's jobs, and no service
needs a `GITHUB_TOKEN`.

How events go live (details in AGENTS.md): the site's scheduler queues a
collect Sunday and Wednesday at 3:23 PM town time; the town's jobs worker
runs the collector with `--candidates-only` (never `docs/events.json`) and
hands its candidates to the site, which stores them (`town_files`) and
`server/autopublish.js` publishes the upcoming candidates plus approved
submissions into the `published_events` row at once. Free public
submissions are reviewed by the AI review (the worker's
`submission-review` job, every 15 minutes); the good ones wait for the
owner's OK unless `SUBMISSION_AUTOAPPROVE=1` (paid picks publish on their
own).

## One-time setup

1. **Create a service** from this repo's `main` branch. Railpack
   (`railpack.json`) builds with Node 22 (`.nvmrc` / `engines`), installs
   from `package-lock.json` and runs `npm start`.
2. **Add Postgres.** Railway injects `DATABASE_URL`. The server creates its
   tables on first use; there is no migration step. Without `DATABASE_URL`
   it falls back to a JSON file under `data/`, which is fine locally but not
   durable on Railway.
3. **Set the variables.** At minimum `ADMIN_USERNAME`, `ADMIN_PASSWORD`
   (12+ characters) and `ADMIN_SESSION_SECRET` (32+, `openssl rand -hex 32`;
   the same for a legacy `ADMIN_TOKEN`). Shorter ones still work, but the
   checklist marks them required and production alerts Slack on every boot.
   Then work down the
   admin Home tab's setup checklist, which says what each missing variable
   turns on (Slack, Resend newsletter, Stripe, cron secrets, Turnstile,
   jobs on Railway). PR and staging environments don't inherit `ADMIN_*`
   automatically; set them per environment or as shared variables.
4. **Cron secrets** (`NEWSLETTER_CRON_SECRET`, `EVENT_CHECK_SECRET`,
   `SUBMISSION_REVIEW_SECRET`) live on the web service; the jobs service
   reads them as references (`${{<web>.<NAME>}}`), so nothing is copied.
   Give each its own value; see AGENTS.md "Security notes".
5. **Stripe** (sponsor checkout). Every town sells through **one shared
   Stripe account**; each town has its own key and its own webhook
   endpoint on it. Orders stay apart by `metadata.town` on each session,
   payment and subscription (Victoria's say `victoria`; older untagged
   ones are hers) and by matching only the town's own orders; each town's
   webhook skips the others' sessions and subscriptions. The card
   statement reads the account's prefix plus the town
   (`statement_descriptor_suffix`, e.g. "VIC 361"), so set the account's
   public name and statement descriptor prefix in the Dashboard to
   something neutral (the LLC or a shared brand, 10 characters or fewer).
   Live restricted key (`rk_live_`: Checkout Sessions, Products and
   Prices: write) in production as `STRIPE_SECRET_KEY`, one per town so
   one can be revoked alone; a test key there shows a Setup checklist
   warning, and with a live key a test-mode payment is never fulfilled.
   Webhook endpoint `<SITE_URL>/api/stripe/webhook` on API version
   `2026-09-30.endive`, its signing secret as `STRIPE_WEBHOOK_SECRET`,
   subscribed to: `checkout.session.completed`,
   `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `checkout.session.expired`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `invoice.payment_failed`, `invoice.paid`, `charge.refunded`,
   `charge.dispute.created`, `charge.dispute.closed`,
   `radar.early_fraud_warning.created`. An endpoint made before
   `charge.dispute.closed` and `invoice.paid` were added must add them, or
   a won dispute stays "Disputed" and partner renewals can't be matched.
6. **Resend webhook.** In Resend → Webhooks, add one endpoint at
   `$SITE/api/email/inbound` and subscribe it to **`email.received`**
   (replies to news@ post to Slack), **`email.bounced`** (a hard bounce
   marks the subscriber bounced; soft ones are counted, and a week-plus
   run of them does the same), **`email.complained`** (a spam complaint
   unsubscribes them) and **`email.delivered`** (a delivery ends a run of
   soft bounces; without it a run ends after 30 quiet days, so a mailbox
   that's only sometimes full can still be dropped). Put its signing secret in Railway as
   `RESEND_WEBHOOK_SECRET`. Without the last two events, a dead or
   complaining address stays active: it keeps getting issues and counts in
   referral rewards and sponsors' copies sent. Each town's endpoint acts
   only on events for mail its own domain sent (`isForTown`), so one
   Resend account can serve several towns.
7. **Turnstile** (`TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`) is required
   in production: without it every newsletter signup has to confirm by
   email (the signup can't be checked as a person), and the other forms
   rely on honeypot, timing and rate limits only.

## Smoke test after a deploy

```bash
SITE=https://www.thevic361.com   # or the environment's Railway domain
# 1. Server is up and on Postgres
curl -sf $SITE/api/health
#   → {"ok":true,"storage":"postgres"}
# 2. Config reports the right flags
curl -s $SITE/api/config
#   → admin_login_enabled:true, jobs_on_railway:true, sources_trigger_enabled:true
# 3. The published list is there
curl -s $SITE/events.json | jq '.events | length'
```

Use `www` (or the Railway domain), not the bare `thevic361.com`: the apex is
forwarded by Squarespace and its deep links 404.

Then sign in at `$SITE/admin.html`: the Home tab shows the setup checklist,
upcoming events and anything waiting for you.

## Save & Publish (no `GITHUB_TOKEN`)

`POST /api/admin/publish-events` writes the `published_events` row, which
the site serves immediately. A town with `JOBS_ON_RAILWAY=1` (every town,
Victoria included) never commits anything to GitHub, even with a leftover
`GITHUB_TOKEN`: the admin loads the last collect's candidates from the
database (`town_files`) plus approved submissions, and Pull Now queues a
collect for the jobs worker. `docs/events.json` stays in git only as
Victoria's frozen fallback, served when her database has nothing published
yet. (A service without jobs on Railway, such as a staging copy with a
`GITHUB_TOKEN`, still commits `docs/events.json` on publish as before.)

## New town on Railway

Every town lives in one Railway project, **Newsletters** (Victoria's, once
named TheVic361), as its own pair: one service from this repo, named after
the town's domain (`thecrane308`), and its own Postgres (`Postgres-<town>`).
A town never shares Victoria's database, secrets or accounts; the project is
only the folder they sit in. Two rules keep it that way:

- **No shared variables for secrets.** Railway's project-wide shared
  variables would hand one value to every town. Set every secret on the
  town's own service.
- **PR environments stay off** for the project: a PR would otherwise copy
  every town and its database. CI runs the tests.
`scripts/new_town.py` makes the town's files and prints the short version
of this list; this is the full one. Run `scripts/launch_check.py --town
<slug>` at the end: it fails until the town is really collecting.

**Every secret is fresh for the town** (`openssl rand -hex 32` each). Never
copy a value from Victoria's project, or from another town's: a copied
`ADMIN_SESSION_SECRET` or cron secret opens every town that shares it.

1. **Service and database, in the Newsletters project's `production`
   environment only** (not `staging`, which is Victoria's). Add a
   Postgres and turn on its backups; add an empty service named after the
   town, start command `node server/index.js`, healthcheck path
   `/api/health`, and set its `DATABASE_URL` to
   `${{<that Postgres>.DATABASE_URL}}`, never to Victoria's `Postgres`.
   Set every variable below **before** connecting the repo (`main`): a
   service that boots without `TOWN` runs as Victoria. On
   first boot the town claims the empty database (`town_meta`); a database
   that already holds another town's data, or Victoria's, stops the boot.
2. **Town identity.**
   - `TOWN=<slug>` (the folder in `towns/`). Forgetting it boots the service
     as Victoria; with any `SITE_URL` that isn't thevic361.com it refuses to
     start and says so.
   - `SITE_URL=https://www.<domain>` (the town's own; Victoria's is refused).
3. **Admin login.** `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`
   (fresh). Don't set `ADMIN_TOKEN` on a new town.
4. **Cron secrets** (fresh, one each; the jobs service references them):
   `NEWSLETTER_CRON_SECRET`, `EVENT_CHECK_SECRET`,
   `SUBMISSION_REVIEW_SECRET`, `ADS_SPEND_SECRET`.
5. **Email (Resend).** Verify the town's domain in Resend (SPF, DKIM, and MX
   for replies). `RESEND_API_KEY`; `NEWSLETTER_FROM="<Site name>
   <news@<domain>>"` (an address on the town's domain; Victoria's is
   refused); `NEWSLETTER_ADDRESS` (the mailing address the law requires in
   every email); `NEWSLETTER_REPLY_TO` (an inbox you read, or leave it out
   and use receiving instead); receiving: a webhook (event `email.received`)
   to `https://www.<domain>/api/email/inbound` with its secret as
   `RESEND_WEBHOOK_SECRET`.
6. **Stripe: the shared account** (One-time setup step 5). No new
   account: on the shared one, a new restricted key for the town
   (Checkout Sessions, Products and Prices: write) as `STRIPE_SECRET_KEY`,
   and `STRIPE_WEBHOOK_SECRET` from a new webhook endpoint at
   `https://www.<domain>/api/stripe/webhook` (API version
   `2026-09-30.endive`, as in the admin setup checklist) sending all 12
   events: `checkout.session.completed`,
   `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `checkout.session.expired`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `invoice.payment_failed`, `invoice.paid`, `charge.refunded`,
   `charge.dispute.created`, `charge.dispute.closed`,
   `radar.early_fraud_warning.created`. The code tags the town's sessions
   (`metadata.town=<slug>`), its catalog prices and keys (`town.keyPrefix`)
   and its card statement suffix, so nothing else is set per town. Check
   it with a test-mode checkout.
7. **Referral gift cards (Tremendous).** The town's own campaign (its name
   and logo on the reward email): `TREMENDOUS_API_KEY`,
   `TREMENDOUS_CAMPAIGN_ID`, `TREMENDOUS_FUNDING_SOURCE`. Or leave them out
   and send cards by hand from the admin.
8. **Forms (Turnstile).** Add `www.<domain>` to a Turnstile widget (Managed
   mode); `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`. A site key without
   the town's hostname fails every form.
9. **GitHub.** Nothing: no `GITHUB_TOKEN` (its jobs run on Railway).
10. **Slack.** `SLACK_WEBHOOK_URL` (and the optional `SLACK_*_WEBHOOK_URL`
    channels, shared with Victoria is fine) and `SLACK_TOWN_TAG` (the city,
    e.g. `Bay City`), so the town's posts read `[Bay City] …` (the jobs
    service references it).
11. **HQ.** `HQ_API_KEY` and `HQ_SSO_SECRET` (both fresh, different per
    town and from each other). Then on the HQ service add
    `HQ_TOWN_<SLUG>` = `{"site_url":"https://www.<domain>","key":"<its HQ_API_KEY>"}`
    and `HQ_SSO_<SLUG>` = its `HQ_SSO_SECRET` (or add both to the town's
    entry in `HQ_TOWNS`), and check its row and its Admin → (it should
    open the admin signed in). HQ is its own repo and Railway project
    (`tmpalori/tristen-hq`, project Tristen HQ): it holds no town data and
    reads each town through its key.
12. **Jobs.** `JOBS_ON_RAILWAY=1`, `JOBS_SECRET=${{SUBMISSION_REVIEW_SECRET}}`
    and the town's jobs service ("Jobs on Railway" below). `town.json`
    keeps `"workflows": false` (nothing runs on GitHub). Until the town's
    first collect lands, its scheduler queues only the collect and it sends
    no auto-publish, "0 upcoming" or missed-collect alerts. The social kit
    and the ads report use Meta settings only when the jobs service sets
    `META_TOWN=<slug>` and its page, Instagram and ad account ids match the
    ones `town.json` pins (`"meta": {"page_id", "ig_user_id",
    "ad_account_id"}`).
13. **Optional:** `META_PIXEL_ID` (the town's own pixel); the GA stream is
    `gaId` in `town.json` (a PR).
14. **Domain.** Add `www.<domain>` as a custom domain and CNAME it to the
    Railway target. Make the apex redirect to `www` with the path kept (a
    DNS host's 301 that keeps paths, or the apex on Railway too, where the
    server redirects it). Don't repeat Victoria's Squarespace forwarding,
    which breaks every deep link on the apex.
15. **PR environments** are off for the Newsletters project (see the top
    of this section); check they still are.
16. **Watch paths** (MULTI_CITY_PLAN.md 2.6): the service watches
    `/server/**`, `/docs/**` except Victoria's bot files
    (`!/docs/social/**`, `!/docs/events.json`), `/package.json`, `/package-lock.json`,
    `/.nvmrc`, `/railpack.json`, `/town.py`, `/towns/<slug>/**` and
    `/towns/*/town.json` (the inbound email filter reads every town's
    domain), so the bot commits of other towns (and Victoria's) don't
    redeploy it. Victoria's service watches `**` minus the files bots
    write for other towns: `!/towns/*/candidates.json`,
    `!/towns/*/collection_metadata.json`, `!/towns/*/enrichment_cache.json`
    and `!/towns/*/public/**` (its own data files are at the root). A commit that
    matches none of a service's paths shows as a skipped deployment.
    Change a service's watch paths when its code starts reading a new
    folder.

Then: `python3 scripts/launch_check.py --town <slug>` (every automatic
check passes, including 10+ upcoming events, a collect in the last 8 days
and workflows on), its manual list, and `python3 scripts/live_check.py`
for Victoria before and after.

## Jobs on Railway (a town's jobs service)

JOBS_ON_RAILWAY.md is the plan; this is the setup. A town on it runs its
collect, event check and submission review on its own **jobs service**
instead of GitHub Actions, so it needs no GitHub Environment, no
`GITHUB_TOKEN` and no copied cron secrets, and a collect publishes without
a commit or a redeploy.

1. **On the town's web service:** `JOBS_SECRET` = `${{SUBMISSION_REVIEW_SECRET}}`
   (a reference to the town's own fresh secret, so nothing is copied) and
   `JOBS_ON_RAILWAY=1`. Its scheduler and Pull Now then queue jobs in the
   town's database (`server/jobs.js`).
2. **Project-shared variables (once, for every town):** `APIFY_TOKEN`,
   `OPENAI_API_KEY`, `GEMINI_API_KEY`. These three are the only shared
   secrets: every town already uses the same accounts, capped per town by
   `limits` in its `town.json`. Never share a town's own secrets.
3. **The jobs service:** a new service named `<domain>-jobs` from this repo
   (`main`), in `production` only, built from `Dockerfile.jobs`, no domain,
   watch paths `/*.py`, `!/test_*.py`, `/scripts/**`, `/requirements.txt`,
   `/Dockerfile.jobs`, `/towns/<slug>/**`, `/towns/*/town.json` (the test
   files are left out: a redeploy stops a collect under way). Its
   variables, all references, so nothing is copied:
   - `TOWN=<slug>`, `SITE_URL=https://www.<domain>`
   - `JOBS_SECRET=${{<web>.JOBS_SECRET}}`
   - `EVENT_CHECK_SECRET`, `SUBMISSION_REVIEW_SECRET`,
     `NEWSLETTER_CRON_SECRET`, `SLACK_TOWN_TAG` and the `SLACK_*`
     webhooks: `${{<web>.<NAME>}}` each
   - `OPS_REPORT_URL=https://www.<domain>`,
     `OPS_REPORT_SECRET=${{<web>.SUBMISSION_REVIEW_SECRET}}`
   - `APIFY_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY`:
     `${{shared.<NAME>}}`
   - `FB_POSTS_ENABLED=1`, `IG_POSTS_ENABLED=1` (the collector's other
     sources are on by default)
   - The social kit (daily at 8:47 AM town time, every town's):
     `META_TOWN=<slug>`, `META_PAGE_ID` (the page id its `town.json` pins
     under `"meta"`; Victoria's is in `town.py` VICTORIA), `META_PAGE_TOKEN`, `IG_USER_ID` (only
     once pinned as `"meta".ig_user_id`; without it Facebook only),
     optional `GRAPH_API_VERSION`, and `SOCIAL_AUTOPOST=1` to post. These
     are the town's own (set here or as references to its web service's),
     never shared. Without `SOCIAL_AUTOPOST=1` the kit is still built and
     served at `https://www.<domain>/social/latest/`; with it but settings
     that aren't the town's own, the job fails and alerts and posts
     nothing. What was posted is the town file `social_posted` (per day and
     kind; `"pending"` means a publish call may have gone out: check the
     Page, then remove that entry, e.g. `UPDATE town_files SET data = data
     #- '{2026-10-15:today,facebook}' WHERE name = 'social_posted'`).
     Victoria's file starts from what GitHub posted
     (`docs/social/latest/posted.json`, merged under it on every read).
   - The ads report (daily at 8:37 AM town time): `META_ADS_TOKEN` (a
     system-user token with ads_read and ads_management; without it the
     report uses `META_PAGE_TOKEN`), `META_AD_ACCOUNT_ID` (the ad account
     `town.json` pins as `"meta".ad_account_id`; optional for Victoria,
     whose token sees one account), and `META_TOWN`. `ADS_SPEND_SECRET`
     is optional (else `SUBMISSION_REVIEW_SECRET`, as on the site): the
     daily spend goes to Admin → Growth. A town with no ad account pinned,
     or no token, does nothing. The report itself goes to Slack activity
     through the site; a dead token or lost access fails the job and alerts.
   - The digest (Sunday 9 PM town time, optional): `SMTP_EMAIL`,
     `SMTP_PASSWORD` (a Gmail app password), optional `DIGEST_TO` (default
     the owner's Gmail). Without them the job does nothing.
4. **Nothing on GitHub:** `"workflows": false` in `towns/<slug>/town.json`
   (the default). With `JOBS_ON_RAILWAY=1` the scheduler never starts a
   GitHub workflow and the site ignores `GITHUB_TOKEN`; remove it.
5. **Check:** Pull Now in the town's admin queues a collect; the jobs
   service's log shows it start, and the site says "Collect done" in Slack
   when the new events are live. The hourly site check alerts if the
   worker stops asking for work for 30 minutes, and a job that never
   finishes is started once more and alerted.

The jobs service runs every scheduled job a town has (collect, event
check, submission review, social kit, ads report, digest); the web service
runs the newsletter, sponsor reports, privacy purge and the hourly check.

## Victoria moved (JOBS_ON_RAILWAY.md phase 5)

Victoria runs exactly like the other towns. What changed in Railway and
GitHub when she moved (the code is merged first; the order below avoids a
double post or a missed run):

1. **`thevic361-jobs`** (her jobs service) adds: `META_TOWN=victoria`,
   `META_PAGE_ID=1388965530960534` (her pinned page), `META_PAGE_TOKEN`
   (her Page token, the GitHub secret of the same name), `SOCIAL_AUTOPOST=1`,
   optional `GRAPH_API_VERSION`; for the ads report `META_ADS_TOKEN` if
   she has a system-user token (GitHub used `META_PAGE_TOKEN`), no
   `META_AD_ACCOUNT_ID` (her token sees one account; set it only together
   with a pin), `ADS_SPEND_SECRET=${{thevic361.ADS_SPEND_SECRET}}` if her
   web service has one; for the digest `SMTP_EMAIL` and `SMTP_PASSWORD`.
   No `IG_USER_ID` until her Instagram id is pinned in `town.py`.
2. **Victoria's web service** removes `GITHUB_TOKEN` (and `GITHUB_PAT`,
   `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_BRANCH` if set). Keep
   `JOBS_ON_RAILWAY=1` and `JOBS_SECRET`.
3. **Other towns' jobs services** need nothing new: their ads report does
   nothing until an ad account is pinned and `META_AD_ACCOUNT_ID` set.
4. **GitHub:** delete the repo secrets only the retired workflows read
   (`META_PAGE_ID`, `META_PAGE_TOKEN`, `META_ADS_TOKEN`, `IG_USER_ID`,
   `ADS_SPEND_SECRET`, `SMTP_EMAIL`, `SMTP_PASSWORD`, `NTFY_TOPIC`,
   `OPENAI_API_KEY`, `PREVIEWS_DEPLOY_KEY`) and variables
   (`SOCIAL_AUTOPOST`, `META_AD_ACCOUNT_ID`, `META_TOWN`,
   `GRAPH_API_VERSION`, `SLACK_TOWN_TAG`, the collector knobs such as
   `FB_POSTS_MAX_VENUES`), and the towns' GitHub Environments. Keep what
   `tests.yml` and the manual tools read: `SLACK_WEBHOOK_URL`,
   `SLACK_ALERTS_WEBHOOK_URL`, `OPS_REPORT_SECRET` (or the cron secret it
   falls back to), `SITE_URL`, `APIFY_TOKEN`, `GEMINI_API_KEY`,
   `GEMINI_MODEL`.

## New town, the simple way (jobs on Railway)

The full owner-and-agent checklist (brand art, email, Stripe, Meta, ads,
monitoring) is [LAUNCH_CHECKLIST.md](./LAUNCH_CHECKLIST.md); this section is its Railway part.

What an agent does end to end with the Railway connector and the Cloudflare
API, once the town's files are in `towns/<slug>/` (feeds, venues, local
events) and merged:

1. **Postgres:** `Postgres-<Town>` in `production`, backups on (the owner
   turns backups on in Railway; the API can't).
2. **Web service** `<domain-without-tld>` from `main`, start `node
   server/index.js`, healthcheck `/api/health`, the watch paths of step 16
   above. Variables before the first deploy: `TOWN`, `SITE_URL`,
   `DATABASE_URL=${{Postgres-<Town>.DATABASE_URL}}`, `ADMIN_USERNAME`,
   `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`, `NEWSLETTER_CRON_SECRET`,
   `EVENT_CHECK_SECRET`, `SUBMISSION_REVIEW_SECRET`, `HQ_API_KEY`,
   `HQ_SSO_SECRET`, `HQ_REPLY_KEY` (each fresh, 32+ characters, never
   copied from another town), `SLACK_*` (shared channels are fine),
   `SLACK_TOWN_TAG`, `JOBS_SECRET=${{SUBMISSION_REVIEW_SECRET}}`,
   `JOBS_ON_RAILWAY=1`. The town's `town.json` keeps `"workflows": false`:
   it never runs on GitHub.
3. **Jobs service** `<web>-jobs`: "Jobs on Railway" above.
4. **Domain:** `www.<domain>` on the web service; in Cloudflare (DNS only,
   not proxied) the `www` CNAME to Railway's target and its verification
   TXT, and the apex redirected to `www` with the path kept (a Cloudflare
   redirect rule, or the apex on Railway too).
5. **HQ:** on the HQ service, `HQ_TOWN_<SLUG>` =
   `{"site_url":"https://www.<domain>","key":"<its HQ_API_KEY>"}` plus
   `HQ_SSO_<SLUG>` and `HQ_REPLY_<SLUG>` (references don't cross
   projects, so these are the only copies; the owner pastes them if the
   agent can't read secrets).
6. **First collect:** Pull Now in the town's admin (or wait for its first
   Sunday or Wednesday); HQ shows it under the town's jobs.
7. **Owner, when ready to sell and send:** Resend domain and key, the
   town's key and webhook on the shared Stripe account, the mailing
   address and business name, the
   Facebook page and Instagram (then `META_TOWN` and the social kit move,
   JOBS_ON_RAILWAY.md 2b). Turnstile: add `www.<domain>` to the widget.

Fresh secrets are generated (`openssl rand -hex 32`) and set straight on
the service. An agent session that isn't allowed to generate secrets asks
the owner to run that once per town, or to allow it.

## HQ dashboard (its own repo and project)

The dashboard that shows every town on one screen is `tmpalori/tristen-hq`,
deployed as the Tristen HQ project at https://hq.tristenpalori.com. Its
README covers its variables. What this repo's towns need:

- `HQ_API_KEY` on each town's service (a long random string, different per
  town). Until it's set, that town's `/api/hq/summary` is a 404. HQ holds
  the same value for the town (`HQ_TOWN_<SLUG>` or `HQ_TOWNS`).
- **One sign-in (optional, recommended).** A fresh `HQ_SSO_SECRET`
  (`openssl rand -hex 32`, different per town and from its `HQ_API_KEY`),
  with HQ holding the same value as `HQ_SSO_<SLUG>`. That town's **Admin →**
  on HQ then opens its admin already signed in: HQ posts a one-time pass
  (one town, 30 seconds, one use, never in a URL; `server/sso.js`) to the
  town's `POST /api/admin/sso`, which answers with an ordinary admin
  session. Without the pair the button is a plain link to the town's own
  login. Anyone who can sign in to HQ can open every town that has a
  secret, so HQ's password is the one that matters.
- **Replies as news@ from HQ (optional).** A fresh `HQ_REPLY_KEY`
  (`openssl rand -hex 32`, different from every other secret), with HQ
  holding the same value as `"reply"` in the town's `HQ_TOWN_<SLUG>` or
  `HQ_TOWNS` entry. HQ then sends replies Tristen approved (through his
  assistant) to `POST /api/hq/reply`, which sends them as news@. The town
  picks the recipient from the message's own reply link (someone who wrote
  in, within 60 days), 30 a day at most. Unset, the route is a 404.
  The same key lets HQ review submissions: `GET /api/hq/submissions`
  (pending, in full), and `POST /api/hq/submissions/:id` to edit
  (`payload`) or decide (`status`: approved, rejected, duplicate,
  pending), exactly like the admin Submissions tab. `POST /api/hq/submissions`
  with `{event, submitter?, publish?}` adds a new event (published unless
  `publish` is false); `submitter` (`{name, email}`) credits someone who
  sent it in another way, so approving it emails them that it's live. One
  already in the queue or on the site answers 409.
  The key also reads the admin's Needs attention, Newsletter, Sponsors and
  Analytics data at `/api/hq/admin/...` (the same handlers as
  `/api/admin/...`: `setup`, `sources`, `hidden`, `messages`, `newsletter`,
  `newsletter/preview`, `sponsors`, `sponsors/:id/report`, `growth`,
  `traffic`, `event-stats`), and takes a few of its actions for the owner:
  restore or dismiss a hidden event, dismiss a message, a sponsor's
  `hide` / `restore` / `mark-test` / `unmark-test`, a test issue (to the
  town's own test address only) and the issue itself
  (`server/hqAdmin.js`). It never opens `/api/admin/...`, and gift-card
  rewards, imports, data deletion and sponsor edits stay admin-only.
  `/submit?name=…&date=…&time=…&venue=…&address=…&url=…&description=…`
  prefills the form (event fields only), for replies pointing someone there.

`server/sso.js` here and `src/sso.js` in tristen-hq are the same file:
change both together. A change to the summary's shape (`server/hq.js`)
should be followed by refreshing tristen-hq's
`tests/fixtures/town-summary.json`.

## Backups and data exports

Railway's scheduled Postgres backups (AGENTS.md "Backups") live with the
Postgres service: deleting the service or project, or losing the Railway
account, takes them too. Keep a second copy somewhere else.

- **Subscriber list:** admin → Email tab → "Back up the list, or delete
  someone's data" → **Download subscribers (CSV)** (`GET
  /api/admin/subscribers.csv`: email, status, source and dates). Store the
  file somewhere private (not in this repo).
- **Whole database, encrypted:** from a machine with `pg_dump` and
  [`age`](https://github.com/FiloSottile/age), using the Postgres service's
  public URL (Railway → Postgres → Variables → `DATABASE_PUBLIC_URL`):

  ```bash
  age-keygen -o ~/vic361-backup.key        # once; keep the key OFF the machine that holds the dumps
  pg_dump --no-owner --format=custom "$DATABASE_PUBLIC_URL" \
    | age -r "$(age-keygen -y ~/vic361-backup.key)" > vic361-$(date +%F).dump.age
  # restore: age -d -i ~/vic361-backup.key vic361-YYYY-MM-DD.dump.age | pg_restore --no-owner -d "$TARGET_URL"
  ```

  Put the `.age` file in private storage you control (R2, B2, S3, a
  personal drive). Restore one into a scratch database now and then to know
  it works.
- **Never use GitHub Actions artifacts or the repo for backups.** This repo
  is public: anyone signed in to GitHub can download its workflow
  artifacts, and anything committed is public forever.

Personal data is kept only as long as the privacy page says: a daily job
(`privacy-purge`, `server/privacy.js`) clears the IP address and user agent
on submissions older than 12 months and deletes contact-form messages older
than 24 months. To delete everything about one person on request, use
**Delete their data** in the same admin section (`POST
/api/admin/privacy/forget`): it removes their subscription, contact
messages and the contact details on their submissions, and masks their
address on sponsor orders and gift-card rewards (kept for the books). The
action is logged and posted to Slack with the masked address.

## Operations checklist

Things the code can't do for you. Check them when setting up a town and
again every few months.

- **External uptime monitor.** Set one up (UptimeRobot, Better Stack or
  similar) on `https://www.thevic361.com/api/health?deep=1` every 1 to 5
  minutes, plus a keyword check that `/events.json` contains `"events"`.
  Send it to the Slack alerts webhook and a phone push. The in-process
  checks can't see a dead process or a DNS/TLS break (HQ's watch does,
  every few minutes).
- **Two-factor sign-in** on every account that can change the site or take
  money: GitHub, Railway, Stripe, Resend, Cloudflare, Squarespace (DNS),
  Slack and Meta. Account takeover is the most likely way in.
- **No `GITHUB_TOKEN` on any service.** Jobs run on Railway, so nothing
  on Railway needs to write to GitHub; a token there would only let anyone
  holding it push to `main`, which deploys to production. Add a ruleset on
  `main` (no force-push, no deletion) and keep PR environments from
  receiving production secrets.
- **Key rotation.** Keep a list of every secret, where it's set (Railway,
  GitHub) and when it was last changed: `STRIPE_SECRET_KEY`
  / `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY` / `RESEND_WEBHOOK_SECRET`,
  `TREMENDOUS_API_KEY`, `OPENAI_API_KEY` / `APIFY_TOKEN` / `GEMINI_API_KEY`,
  the `META_*` tokens, the SMTP app password, the
  three cron secrets, `HQ_API_KEY` and the `ADMIN_*` values. Rotate after
  anyone with access leaves or a secret may have leaked, and at least
  yearly. Changing `ADMIN_PASSWORD` or `ADMIN_SESSION_SECRET` signs every
  admin out (and the session secret also salts the day's visitor counts).
- **Backups.** Railway's daily backups on (7+ days kept), a test restore
  done once, and an encrypted copy off Railway (above).
- **`DATABASE_URL`** references Postgres's private URL
  (`*.railway.internal`), not the public proxy: the app doesn't verify the
  database's TLS certificate.

## Local development

```bash
npm ci
ADMIN_USERNAME=admin ADMIN_PASSWORD=<pick one> \
ADMIN_SESSION_SECRET=$(openssl rand -hex 32) npm start   # http://localhost:3000
```

Without `TURNSTILE_SECRET_KEY`, form verification is skipped (honeypot,
timing and rate limits still apply), and a newsletter signup gets the
confirmation email instead of going straight onto the list. Auto-publish doesn't run on boot
outside production; force a run with
`POST /api/admin/auto-publish`.
