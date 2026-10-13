# The Vic 361 — Railway setup and smoke tests

The whole site runs on Railway: the Express server in `server/index.js`
serves the public pages, `/events.json`, the submit form, the admin and every
API from one service backed by Railway Postgres. `www.thevic361.com` is a
CNAME to the Railway service (see AGENTS.md "Production hosting").

The environment variable reference lives in **AGENTS.md → Environment
variables** (Railway variables, collector secrets, and GitHub Actions
secrets/variables). This file only covers standing up an environment and
checking it works.

How events go live (details in AGENTS.md): the collector runs Sunday and
Wednesday at 20:23 UTC with `--candidates-only` and commits `candidates.json`
(never `docs/events.json`); that commit redeploys the service, and on boot in
production `server/autopublish.js` publishes the upcoming candidates plus
approved submissions into the `published_events` row. Free public
submissions are reviewed by the AI review (`submission-review.yml`); the
good ones wait for the owner's OK unless `SUBMISSION_AUTOAPPROVE=1` (paid
picks publish on their own).

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
   GitHub token). PR and staging environments don't inherit `ADMIN_*`
   automatically; set them per environment or as shared variables.
4. **Cron secrets** (`NEWSLETTER_CRON_SECRET`, `EVENT_CHECK_SECRET`,
   `SUBMISSION_REVIEW_SECRET`) must match between Railway and the GitHub
   secrets of the same name. Give each its own value; see AGENTS.md
   "Security notes".
5. **Stripe** (sponsor checkout; each town has its own Stripe account and
   endpoint). Live restricted key (`rk_live_`) in production as
   `STRIPE_SECRET_KEY`; a test key there shows a Setup checklist warning,
   and with a live key a test-mode payment is never fulfilled. Webhook
   endpoint `<SITE_URL>/api/stripe/webhook` on API version
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
   marks the subscriber bounced) and **`email.complained`** (a spam
   complaint unsubscribes them). Put its signing secret in Railway as
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
#   → admin_login_enabled:true (github_publish_enabled:true only with GITHUB_TOKEN)
# 3. The published list is there
curl -s $SITE/events.json | jq '.events | length'
```

Use `www` (or the Railway domain), not the bare `thevic361.com`: the apex is
forwarded by Squarespace and its deep links 404.

Then sign in at `$SITE/admin.html`: the Home tab shows the setup checklist,
upcoming events and anything waiting for you.

## Save & Publish and `GITHUB_TOKEN`

`POST /api/admin/publish-events` always writes the `published_events` row,
which the site serves immediately. When `GITHUB_TOKEN` is set it also
commits `docs/events.json` (the bundled fallback) to `main`; a failure there
is reported as a warning and doesn't undo the save. Without the token the
admin still loads candidates from the bundled `candidates.json` plus
approved submissions.

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
4. **Cron secrets** (fresh, one each, the same value in the town's GitHub
   Environment): `NEWSLETTER_CRON_SECRET`, `EVENT_CHECK_SECRET`,
   `SUBMISSION_REVIEW_SECRET`, `ADS_SPEND_SECRET`.
5. **Email (Resend).** Verify the town's domain in Resend (SPF, DKIM, and MX
   for replies). `RESEND_API_KEY`; `NEWSLETTER_FROM="<Site name>
   <news@<domain>>"` (an address on the town's domain; Victoria's is
   refused); `NEWSLETTER_ADDRESS` (the mailing address the law requires in
   every email); `NEWSLETTER_REPLY_TO` (an inbox you read, or leave it out
   and use receiving instead); receiving: a webhook (event `email.received`)
   to `https://www.<domain>/api/email/inbound` with its secret as
   `RESEND_WEBHOOK_SECRET`.
6. **Stripe: the town's own account** (Stripe → account menu → New
   account; same LLC, EIN and payout bank), with its public business name,
   logo and statement descriptor, so checkout and card statements show the
   town, not The Vic 361. Its keys only: `STRIPE_SECRET_KEY` (a restricted
   key: Checkout Sessions, Products and Prices: write) and
   `STRIPE_WEBHOOK_SECRET` from a webhook endpoint at
   `https://www.<domain>/api/stripe/webhook` (API version as in the admin
   setup checklist) sending these events:
   `checkout.session.completed`, `checkout.session.expired`,
   `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `charge.refunded`,
   `charge.dispute.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.payment_failed`,
   `radar.early_fraud_warning.created`. Check it with a test-mode checkout.
7. **Referral gift cards (Tremendous).** The town's own campaign (its name
   and logo on the reward email): `TREMENDOUS_API_KEY`,
   `TREMENDOUS_CAMPAIGN_ID`, `TREMENDOUS_FUNDING_SOURCE`. Or leave them out
   and send cards by hand from the admin.
8. **Forms (Turnstile).** Add `www.<domain>` to a Turnstile widget (Managed
   mode); `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`. A site key without
   the town's hostname fails every form.
9. **GitHub.** `GITHUB_TOKEN`: a fine-grained token on this repo only, with
   Contents: write and Actions: write and nothing else (publishing the
   town's `events.json` and starting its workflows).
10. **Slack.** `SLACK_WEBHOOK_URL` (and the optional `SLACK_*_WEBHOOK_URL`
    channels, shared with Victoria is fine) and `SLACK_TOWN_TAG` (the city,
    e.g. `Bay City`), so the town's posts read `[Bay City] …`. Set
    `SLACK_TOWN_TAG` in the town's GitHub Environment too (step 12).
11. **HQ.** `HQ_API_KEY` and `HQ_SSO_SECRET` (both fresh, different per
    town and from each other). Then on the HQ service add
    `HQ_TOWN_<SLUG>` = `{"site_url":"https://www.<domain>","key":"<its HQ_API_KEY>"}`
    and `HQ_SSO_<SLUG>` = its `HQ_SSO_SECRET` (or add both to the town's
    entry in `HQ_TOWNS`), and check its row and its Admin → (it should
    open the admin signed in). HQ is its own repo and Railway project
    (`tmpalori/tristen-hq`, project Tristen HQ): it holds no town data and
    reads each town through its key.
12. **`TOWN_WORKFLOWS=1` only after** the town's GitHub Environment exists
    (MULTI_CITY_PLAN.md 3.3: its `SITE_URL`, Meta page and Instagram,
    `NTFY_TOPIC`, cron secrets, `SLACK_TOWN_TAG`). Before that the town
    starts no collect, social kit, submission review or event check, since
    they would run on Victoria's repo-level settings. At the same time, add
    `"workflows": true` to `towns/<slug>/town.json` (a PR): the scheduled
    Sunday and Wednesday collects then run the town beside Victoria, each
    in its own job, and Event Check follows each town whose collect
    succeeded. 3.5 must be done before launch too.
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
    `/server/**`, `/docs/**`, `/package.json`, `/package-lock.json`,
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
  with `{event, publish?}` adds a new event (published unless `publish` is
  false); one already in the queue or on the site answers 409.

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
  checks and `uptime.yml` can't see a dead process or a DNS/TLS break, and
  GitHub's cron runs hours late.
- **Two-factor sign-in** on every account that can change the site or take
  money: GitHub, Railway, Stripe, Resend, Cloudflare, Squarespace (DNS),
  Slack and Meta. Account takeover is the most likely way in.
- **`GITHUB_TOKEN` scope.** Use a fine-grained token on this repo only,
  with an expiry date and a calendar reminder to renew it. It needs
  Actions: write for the scheduler; Contents: write only lets Save &
  Publish commit `docs/events.json`, and also lets anyone holding the token
  push code to `main`, which deploys to production. Drop Contents: write if
  you can live without that commit. Add a ruleset on `main` (no
  force-push, no deletion) and keep PR environments from receiving
  production secrets.
- **Key rotation.** Keep a list of every secret, where it's set (Railway,
  GitHub) and when it was last changed: `GITHUB_TOKEN`, `STRIPE_SECRET_KEY`
  / `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY` / `RESEND_WEBHOOK_SECRET`,
  `TREMENDOUS_API_KEY`, `OPENAI_API_KEY` / `APIFY_TOKEN` / `GEMINI_API_KEY`,
  the `META_*` tokens, the SMTP app password, `PREVIEWS_DEPLOY_KEY`, the
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
