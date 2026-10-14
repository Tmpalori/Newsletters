# Multi-city platform plan

Goal: run The Vic 361's code for many towns, each its own site and database,
with one HQ dashboard and one Slack workspace that funnel everything to the
owner. **Victoria must not change or break at any step.**

This plan comes from a four-part read-only audit of the repo (server, docs/
and admin, collector and workflows, integrations and ops), October 2026.
Tests on `main` at the time: vitest 860, pytest 564, all passing.

## Ground rules (apply to every PR below)

1. **Victoria is the default.** Every new setting reads `TOWN` (unset =
   Victoria) and defaults to today's literal value. Add new names; never
   rename an existing env var, storage key, route or prefix.
2. **Golden tests gate everything.** No PR in this plan merges if Victoria's
   golden snapshots change, unless that PR's whole purpose is a reviewed,
   owner-approved change to Victoria's output.
3. **One town per host, one database per town.** No path-based towns
   (`/cuero/...`): browser storage, cookies and canonicals assume one site
   per origin.
4. **Keep Victoria's files where they are** until the very last, optional
   step. New towns get `towns/<slug>/...`.
5. **Small PRs.** Each item below is one PR (or a few), with tests, a
   preview check, and the live before/after check after deploy.
6. **Don't touch** (from AGENTS.md and this audit): scheduler slot claims,
   Victoria's cron times, the `--candidates-only` invariant, `SITE_URL` /
   apex DNS, the `vic361-admin-session` salt, `vic361_*` / `vic361-*`
   browser keys, `utm_source=thevic361`, `/api/vics-pick/*`, Stripe lookup
   keys `vic361_*`, idempotency prefixes `vic361-*`.

## Phase 0: safety net (before any refactor)

- [x] **0.1 Backups.** Confirm Railway scheduled Postgres backups are on and
      listed; take a manual backup. (Owner, in Railway.)
- [x] **0.2 Golden snapshots, server** (`tests/golden/`). `createApp` with a
      fixed clock, a frozen fixture payload, Victoria defaults, and fake
      `fetch`. Snapshot byte-for-byte:
  - Pages: `/`, every hub and intent page, 3 event pages plus `.ics`/`.png`,
    `/venues` and one venue, one seasonal guide, `/about`, `/privacy`,
    `/advertise`, the checkout form, `/subscribe`, `/referral-rules`,
    `/contact`, the 404, `/events.json` (plain and `?all=1`), `/sitemap.xml`,
    `/llms.txt`, `/robots.txt`, `/pixel.js`.
  - Emails (HTML and text): weekly and weekend issues, welcome, confirm,
    reminder, submission received and live, Vic's Pick and sponsor
    confirmations, sponsor and pick reports, referral emails, a reply.
  - Outbound request bodies: Slack (`notify` and `alert` on each channel),
    Stripe product, price and session bodies plus idempotency keys and
    metadata, Resend batch body and key, Tremendous body and `external_id`,
    GitHub dispatch body.
- [x] **0.3 Golden snapshots, Python.** Social-kit captions and `kit.json`,
      `slack_notify.py` payloads, sweep report text, AI prompt strings, and
      the collector's area filter results on a fixture.
- [x] **0.4 Live check script** (`scripts/live_check.py`): fetch ~40
      production URLs and `/api/config` + `/api/health?deep=1`, normalize
      date-driven parts, and diff against the last run. Run before and after
      each deploy in this plan.
- [x] **0.5 Doc fix.** AGENTS.md says `GITHUB_TOKEN` is unset on
      production; `/api/config` shows GitHub publishing is on. Correct it.

## Phase 1: town settings with Victoria as the default (no visible change)

- [x] **1.1 `server/town.js`**: `townConfig(env, overrides)` in the same
      shape as `newsletterConfig` / `slackConfig`. `TOWN` unset or
      `victoria` returns a `VICTORIA` object holding today's literals.
      Other towns load `towns/<slug>/town.json` over shared defaults.
      Passed through `createApp(opts.town)`.
      (Done: the identity fields 1.2a uses, plus `city`, `state`,
      `stateName` and `timezone`, required now so a town.json is complete
      from the start and read from 1.2b/c. Each later 1.2 step adds the
      fields for the literals it moves.)
  Fields:
  - Identity: `id`, `siteName`, `siteNameHtml`, `pickName` (and the
    straight-quote variant where used), `domain`, `siteUrl`, `emailFrom`,
    `mailingAddressFallback`, `gaId`, `keyPrefix` (`vic361`), `utmSource`
    (`thevic361`), `icalDomain`, `stripeIntegrationId`, `palette`.
  - Geography: `city`, `state`, `stateName`, `cityState`, `timezone`,
    `defaultUtcOffset`, `areaCodeBlurb`, `localWords`, link heuristics
    (`listingUrlPatterns`, `fixedUrls`), `venueAddressSuffixRe`.
  - Copy: hub page text, seasonal guides (shared base plus per-town extras
    such as Bach Festival and Tejas Fest), about, privacy lead, advertise
    copy, llms text, tagline, footer, newsletter subjects and schedule
    phrase.
  - Business: prices and pick caps (the display strings generated from the
    numbers, so `$49/$89` text and `VICS_PICK` can't drift), `dayMax`,
    picks, `perDay`, thresholds, referral tiers and drawing amount.
  - Schedule: newsletter days and times, scheduler jobs, collect schedule.
  - Integrations: GitHub owner, repo, branch and data dir; `slackTag`
    (empty for Victoria until Phase 4).
  - Data paths: candidates, metadata, events bundle, venues, asset overlay.
- [x] **1.2 Move server literals to `town`**, one area per PR, goldens
      unchanged each time:
  - [x] a. Brand and identity (`SITE_NAME`, header markup, from-address,
        GA snippet; keep the GA test in sync).
  - [x] b. Time zone (`seo.js` `TZ`, `chicagoOffset`, `scheduler.js`,
        `guides.js` `ctz`).
  - [x] c. Geography in JSON-LD and venues (`townOf`, `addressRegion`,
        `addressLocality`, `guides.js` venue cleanup).
  - [x] d. Page copy (15 hub pages, about, privacy, advertise, llms, 24
        guides). (Victoria-only guides carry `only: 'victoria'`.)
  - [x] d2. Pick name: "Vic's Pick" in badges, copy and emails from a
        `pickName` field. Keep `/api/vics-pick/*`, `vic361_*` keys and
        Stripe lookup keys as they are.
  - [x] e. Email copy (newsletter, notify, referral, inbound signature).
        (Covered by 1.2a–d2; `tests/town_copy.test.js` sweeps 13 emails.)
  - [x] f. Business constants (prices, caps, thresholds), with the price
        strings generated.
  - [x] g. Scheduler job times and the duplicated schedule copy.
        (Decision: issue days stay Monday and Thursday for every town, so
        the "every Monday and Thursday" copy stays shared; a town moves
        job start times with `town.schedule` to stagger sends and collects.)
- [x] **1.3 `docs/` and admin**:
  - [x] a. Static assets: an overlay lookup (`towns/<slug>/public/` checked
        before `docs/` only for non-Victoria towns), used by
        `express.static`, `ogImage.js` and the email header. Victoria has
        no overlay, so its bytes and URLs don't change.
  - [x] b. `docs/index.html` and `docs/submit.html`: town text through the
        existing server template (`/submit` gets a route); canonicals,
        `og:url`, GA ID and prices from `town`. For Victoria the output must
        be byte-identical.
  - [x] c. `docs/app.js`: timezone, pick label and `utm_source` from an
        injected `window.__TOWN__`, defaulting to today's values.
  - [x] d. Admin: repo owner/name and events path from `/api/config` (it
        already returns them); week math in the town's timezone; sponsor
        pitch copy from `town`. Keep every `vic361_*` key.
  - [x] e. `robots.txt` from a route using `siteUrl`.
- [x] **1.4 Python `town.py`** (twin of `server/town.js`, same
      `towns/<slug>/town.json`): timezone, `SITE_URL`, brand strings,
      hashtags, area ZIPs and other-towns list, AllEvents slug, Facebook and
      Eventbrite queries, Gemini categories, Google Sheet ID, enabled
      sources, AI prompt place names, social slide text. `TOWN` unset =
      today's literals; Python goldens unchanged.
  - [x] a. Turn the 11 Victoria-only scrapers into a registry selected by
        `enabled_sources` (Victoria enables all of them). `WEB_SOURCES` in
        `collect_events.py`; a town without the list gets every source but
        the 8 local scrapers.
  - [x] b. Make `_load_venue_list` honor `--local-dir`.
  - [x] c. Stop `test_fb_posts.py` / `test_ig_posts.py` from overwriting the
        real root `venues.json`.

## Phase 2: isolation, so towns can't touch each other

These matter the moment a second town exists. All keep Victoria's values.

- [x] **2.1 Key prefixes.** New towns use `<slug>` where Victoria uses
      `vic361`: Stripe lookup keys, product metadata and idempotency keys,
      Resend idempotency keys (the weekly batch key would otherwise collide
      across towns and silently drop the second town's issue), Tremendous
      `external_id` (the monthly drawing would collide). Done as
      `town.keyPrefix`.
- [x] **2.2 Stripe town filter.** Add `metadata.town` to checkout sessions,
      payment intents and subscriptions. Each town's webhook ignores events
      for another town (missing metadata = Victoria). Only alert on a fraud
      warning when an order matches. (Done; Victoria's requests stay
      untagged, since untagged means Victoria, and it still alerts on
      unmatched warnings.)
- [x] **2.3 Inbound email filter.** Ignore `email.received` unless a `to`
      address is on the town's own domain (Victoria keeps `thevic361.com`).
      (Done; Victoria skips only mail addressed solely to another town's
      domain, so a Bcc or forward is never lost.)
- [x] **2.4 Per-town data paths.** New towns read and write
      `towns/<slug>/candidates.json`, `collection_metadata.json`,
      `enrichment_cache.json`, `venues.json`, `local_events.yaml`,
      `extras.yaml`, the events bundle and `social/latest/`. Victoria keeps
      the root paths. The server, the GitHub API reads and writes, the
      collect and social-kit commit steps, and sweep `--wait-for` all take
      the town's paths. (Done: `townPaths()` / `town_paths()`, and a
      `Town paths` step in each workflow that touches these files.)
- [x] **2.5 Boot guards** for non-Victoria towns: refuse to start if
      `SITE_URL` is unset or points at thevic361.com, if `NEWSLETTER_FROM`
      or GA ID is Victoria's, or if the database's stored `meta.town`
      doesn't match `TOWN` (written on first boot; catches a service wired
      to Victoria's database). (Done. An unset `SITE_URL` is allowed:
      it falls back to the town's own URL, never Victoria's. An unclaimed
      database that already has subscribers, orders or submissions is
      treated as Victoria's and refused too.)
- [x] **2.6 Railway watch paths** per service (shared code plus the town's
      own `towns/<slug>/**`; Victoria also watches its root data files), so
      one town's collect or social commit doesn't redeploy every town.
      Verify both directions on a test service.
      (Done: Victoria watches everything but other towns' bot-written
      files, HQ only what it runs; the patterns for a new town's service
      are RAILWAY.md step 16.)

## Phase 3: workflows per town

- [x] **3.1 `town` input** on every workflow, defaulting to `victoria`.
      Victoria's crons and repo-level secrets stay exactly as they are.
- [x] **3.2 Per-town concurrency groups and cache keys**: suffix with the
      town (`weekly-collect`, `meta-ads`, `submission-review`, `uptime`,
      `social-kit-*`; `review-state-`, `uptime-state-`). (Done: a `-<slug>`
      suffix on groups and a `<slug>-` prefix on cache keys, both empty for
      Victoria.)
- [ ] **3.3 GitHub Environments for new towns only.** Each holds that
      town's `SITE_URL`, Meta page and IG tokens and ids, ad account, cron
      secrets, `NTFY_TOPIC`, `SOCIAL_AUTOPOST`, source toggles and digest
      recipient. Victoria's jobs keep reading repo-level secrets (an
      Environment's secrets override repo secrets of the same name).
      Then set `TOWN_WORKFLOWS=1` on the town's Railway service: until then
      its scheduler and Pull Now start no workflows (they'd run on
      Victoria's repo-level `SITE_URL` and secrets), and `town.py`
      `site_url()` stops any script run as another town on Victoria's URL.
- [x] **3.4 Town matrix** from `towns/index.json` with `fail-fast: false`,
      so one town failing can't cancel Victoria's run. The DST gate reads
      the town's timezone. Stagger cron minutes per town.
      Event Check's `workflow_run` trigger has no inputs, so every town's
      collect currently starts Victoria's check: gate it on the triggering
      run's town here.
      (Done: Weekly Collect's scheduled runs collect Victoria plus each
      town in `towns/index.json` whose `town.json` has `"workflows": true`
      (`town.py scheduled`; set with 3.3), one `collect <town>` job each,
      `fail-fast: false`, per-town concurrency. A broken town file is
      skipped, never Victoria's run. Event Check lists the collect run's
      jobs and checks each town whose own job succeeded. The towns share
      one cron and run side by side, so there's nothing to stagger (3.6
      caps their Apify use). The other scheduled workflows' GitHub crons
      stay Victoria's late fallbacks: every town's own site dispatches its
      jobs on time in its own timezone (`server/scheduler.js`), so their
      DST gates keep Central.)
- [ ] **3.5 Scheduler dispatch** passes `town` and the `ran` gate calls the
      town's own `SITE_URL`. (Dispatch done: `townInputs()`; the gates'
      `SITE_URL` comes with the town's Environment in 3.3.)
- [x] **3.6 Shared budget limits.** Per-town caps for Apify and OpenAI
      (`*_MAX_VENUES` etc.) or separate tokens, so a new town can't trip the
      Apify hard limit and take down Victoria's Facebook and Eventbrite
      sources for the month. (Done: town.json `limits` caps the Apify
      knobs below the shared repo variables; defaults for a new town, none
      for Victoria. Separate tokens can come with 3.3's Environments.)
- [x] **3.7 Update `test_workflows.py`** pins for the new inputs while
      still pinning Victoria's crons, steps and `--candidates-only`.
      (Done with 3.4: the matrix jobs, the scheduled town list and Event
      Check's gate are tested by running their steps.)

## Phase 4: HQ dashboard and shared Slack

- [x] **4.1 `GET /api/hq/summary`** on each town. Auth: `Bearer
      <HQ_API_KEY>` (new per-town secret; route answers 404 when unset;
      never accepts an admin session and the key never works on admin
      routes). Read-only, no personal data, rate limited, cached 60 s:
      town, site URL, commit; subscribers (active, pending, 7/30-day net,
      goals); last 4 issues (recipients, opens, clicks); revenue (month to
      date, last month, orders by status); submissions waiting; upcoming
      event count and last collect; health (database, scheduler, Slack
      refusals); setup checklist status; admin URL.
- [x] **4.2 HQ service** (now its own repo, `tmpalori/tristen-hq`, and
      Railway project, at hq.tristenpalori.com): separate Railway service with its own login. Its
      town list (`slug`, `site_url`, key) in its own env. One screen:
      totals across towns, a row per town (subscribers, open rate, revenue
      this month, open sponsor weeks, picks sold, waiting submissions,
      health), each linking into that town's admin (which still asks for
      its own login).
- [x] **4.3 Slack `[Town]` tag**: `SLACK_TOWN_TAG` prefixes every title in
      `server/slack.js` `notify` and `scripts/slack_notify.py`. Unset = no
      change. Turn it on for new towns first; turn it on for Victoria last,
      as an owner-approved change to message wording. All towns post to the
      same channels: #hype-train, #inbox, #sales, #alerts (activity can map
      to #inbox or its own channel). (Done: Victoria is tagged too, by
      its Railway SLACK_TOWN_TAG and, in the workflows, its city.)

## Phase 5: launching a town

- [x] **5.1 New-town kit**: a script that creates `towns/<slug>/town.json`
      from prompts, seeds venues with `discover_venues.py`, adds the town to
      `towns/index.json`, and prints the account checklist below.
      (Done: `scripts/new_town.py`; venues seed with
      `TOWN=<slug> python3 discover_venues.py --repo-root towns/<slug>`.)
- [ ] **5.2 Per-town accounts and settings** (owner):
  - Domain and DNS; brand name, logo set (logo, favicon set, apple-touch,
    og-image, skyline day and night, email skyline).
  - A service and its own Postgres (backups on) in the Newsletters
    Railway project (RAILWAY.md, New town on Railway); `TOWN`,
    `SITE_URL`, admin login and session secret, cron secrets,
    `HQ_API_KEY`.
  - Resend domain (SPF, DKIM, MX for replies), `RESEND_API_KEY`,
    `NEWSLETTER_FROM`, `NEWSLETTER_ADDRESS` (a street address or PO box
    with ZIP; no issue goes out without it), `NEWSLETTER_REPLY_TO`,
    `NEWSLETTER_CRON_SECRET` (Railway and the town's GitHub Environment),
    the webhook to `/api/email/inbound` (events `email.received`,
    `email.bounced`, `email.complained`, `email.delivered`) and `RESEND_WEBHOOK_SECRET`.
  - Business identity for the legal pages (`server/legal.js`):
    `BUSINESS_LEGAL_NAME` (the LLC's legal name), `BUSINESS_CONTACT_EMAIL`
    (an inbox someone reads: refunds, privacy and deletion requests, free
    drawing entries) and `NEWSLETTER_ADDRESS` (a PO box or registered
    mailbox; also required in every email). Until they're set the terms
    name the site itself and fall back to the reply-to or news@ address.
    File a Texas assumed-name certificate for the town's brand name.
  - Stripe: the town's own Stripe account (same login, LLC, EIN and payout
    bank account as Victoria), so checkout, receipts and card statements
    carry the town's name and logo; its business name, logo and statement
    descriptor, `STRIPE_SECRET_KEY`, webhook endpoint and
    `STRIPE_WEBHOOK_SECRET`. Products and prices are created on the first
    checkout. (Checkout branding is per Stripe account, so a shared account
    would show The Vic 361 to another town's sponsors.) `metadata.town`
    stays as a second guard.
  - Slack: same webhooks, `SLACK_TOWN_TAG`.
  - Facebook page, Instagram, ad account (GitHub Environment).
  - GA data stream; Turnstile hostname (or its own widget) with
    `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` (required: without
    them every newsletter signup has to confirm by email).
  - Tremendous campaign and sender name.
- [ ] **5.3 Launch checks**: boot guards pass, the town's goldens (its own
      fixture) pass, a test newsletter to `delivered@resend.dev`, a Stripe
      test-mode checkout that shows the town's name and logo, a reply lands in #inbox tagged with the town, HQ
      shows the town, and Victoria's live check is unchanged.
      (Automatic part: `scripts/launch_check.py --town <slug>`.)

## Phase 6 (optional, last): move Victoria's files

- [ ] Move Victoria's root data files into `towns/victoria/` in one cutover
      PR, with the old paths kept as fallbacks for one release. Only after
      everything above has been stable for a few weeks.

## Things that differ per town by design

- **Event sources.** 5 of the collector's 16 sources take a city setting
  (Google Sheet, AllEvents, Eventbrite, Facebook events, Gemini search); the
  Facebook and Instagram post scrapers run off each town's venue list. 11
  scrapers only exist for Victoria (city calendar, chamber, library, art
  walk, Theatre Victoria, Victoria Generals and others). Each new town needs
  its own local calendars researched and added.
- **Seasonal guides.** Shared ones (Halloween, Christmas...) plus each
  town's own festivals.
- **Branding.** Each town needs its own logo and skyline art; the colors,
  fonts, icons and layout are shared.
