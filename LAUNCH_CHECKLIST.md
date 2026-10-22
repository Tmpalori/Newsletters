# New town launch checklist

The current way to launch a town, end to end. It replaces the GitHub parts
of MULTI_CITY_PLAN.md Phase 5: every town now runs its jobs on Railway
(JOBS_ON_RAILWAY.md), Victoria included, so it needs no GitHub
Environment, workflows, secrets or `GITHUB_TOKEN`: GitHub only holds the
code and runs the tests.
**Agent** steps an agent session does with the repo, the Railway connector
and the Cloudflare API; **Owner** steps need Tristen's accounts.

Order matters where noted. Copy this list into the town's launch PR or
issue and tick it off.

## 1. Pick the town (Owner)

- [ ] Fits GROWTH_STRATEGY.md (trade area 75k to 500k, its own identity,
      no established competitor).
- [ ] Town, state, newsletter name (house style: a local nickname plus the
      area code, e.g. The Crane 308) and domain, bought on the Cloudflare
      account. Sizing: judge the trade area (county or a 25 to 35 mile
      radius), not city limits.

## 2. The town's files (Agent, one PR)

- [ ] `python3 scripts/new_town.py ...`: `towns/<slug>/town.json`, empty
      collector files, `towns/index.json`. Keep `"workflows": false`.
- [ ] Feeds: the town's official calendars (city, county, library, chamber,
      CVB, university, venues) in `town.json` `feeds`; check they return
      events with `TOWN=<slug> python3 -c "import collect_events as c;
      print(len(c.fetch_town_feeds()))"` (it warns per feed that returns 0).
      `"sparse": true` on a real calendar that's often empty.
- [ ] Venues: `TOWN=<slug> python3 discover_venues.py --repo-root towns/<slug>`,
      then prune (bars, venues, breweries, parks, theaters with FB/IG).
- [ ] `local_events.yaml`: recurring weekly events (trivia, open mics,
      markets, live music nights) researched from venue sites.
- [ ] `schedule` in `town.json`: stagger the Monday and Thursday sends and
      sponsor reports 5 minutes after the last town in the same time zone
      (they share one Resend key). Medford-style towns in other zones need
      none.
- [ ] Brand kit in `towns/<slug>/public/` and `towns/<slug>/BRAND.md`:
      palette, logo (subject readable at 48 px, nothing clipped by the
      ring), favicon set, skyline day and night with **real landmarks**
      drawn from photos (courthouse, theater blade sign, signature hotel or
      sign), og-image, email skyline. Check the art at 2x for floating or
      off-center pieces, stray lines and overlaps.
- [ ] Tests green (`npx vitest run`, `pytest`), merge.

## 3. Railway, DNS, HQ (Agent; RAILWAY.md "New town, the simple way")

- [ ] `Postgres-<Town>`; Owner turns on its backups.
- [ ] Web service and `<web>-jobs` service with fresh secrets (never copied
      from another town), `JOBS_ON_RAILWAY=1`, `SLACK_TOWN_TAG`, watch paths.
- [ ] `www.<domain>` on Railway; Cloudflare `www` CNAME (DNS only) and the
      apex redirected to `www`.
- [ ] HQ: `HQ_TOWN_<SLUG>`, `HQ_SSO_<SLUG>`, `HQ_REPLY_<SLUG>` on the hq
      service.
- [ ] First collect only after the jobs service has its API keys
      (Apify, OpenAI, Gemini); otherwise run Pull Now again.

## 4. Email (Owner clicks, Agent does the rest)

- [ ] Owner: Resend → Domains → add `<domain>`, turn on **Enable
      Receiving**, then **Auto configure** (Cloudflare) adds DKIM, SPF and MX.
- [ ] Agent: add `_dmarc` TXT `v=DMARC1; p=none;`; confirm the records
      publicly.
- [ ] Owner: Resend → Webhooks → `https://www.<domain>/api/email/inbound`,
      events `email.received`, `email.bounced`, `email.complained`; send the
      signing secret. Agent sets `RESEND_WEBHOOK_SECRET`.
- [ ] Agent, once the domain shows **Verified**: `RESEND_API_KEY` =
      `${{TheVic361.RESEND_API_KEY}}` (the shared full-access key; it can
      read inbound mail) and `NEWSLETTER_ADDRESS` = the town's own mailing
      address (a mailbox in the town, from the owner; never Victoria's,
      which would show on its legal pages and in every email as an
      out-of-towner's). Set them after noon town time on
      a Monday or Thursday if the town already has subscribers, or a
      catch-up issue goes out.
- [ ] Agent: empty POST to `/api/email/inbound` answers 400 (not 503).
- [ ] Owner: Admin → Newsletter → test send to `delivered@resend.dev`; a
      reply to `news@<domain>` lands in Slack with the town's tag.

## 5. Legal and money (Owner)

- [ ] Texas assumed-name certificate (DBA) for the newsletter's name.
- [ ] `BUSINESS_LEGAL_NAME` and `BUSINESS_CONTACT_EMAIL` (Agent sets them;
      the same values for every town).
- [ ] Stripe: the one shared account (no new account per town; its public
      name and statement descriptor prefix stay neutral, see RAILWAY.md
      One-time setup step 5) and its one shared key: the town's
      `STRIPE_SECRET_KEY=${{shared.Stripe_secret_key}}` (no new key), and a
      webhook endpoint to
      `https://www.<domain>/api/stripe/webhook` with all 12 events in
      RAILWAY.md "New town on Railway" step 6, its secret as
      `STRIPE_WEBHOOK_SECRET`. The code tags the town's sessions
      (`metadata.town`) and puts the town on the card statement. A
      test-mode checkout shows the town's product name and suffix.
- [ ] Prices: the shared defaults (weekly sponsor $149, picks $29 Mon–Thu,
      $39 Fri–Sun) unless the town's `town.json` `business` sets its own.
- [ ] Category partners and venue outreach turned on for the town (see 8).

## 6. Meta and ads (Owner, with Agent assets)

- [ ] Agent: Facebook profile picture (logo-512) and cover (1640x624, name
      and tagline inside the center 640 px) from the brand kit.
- [ ] Owner: Facebook Page under the same Business account (category Media/News
      Company, bio "Everything to do in <City>, <ST>. Free in your inbox every
      Monday and Thursday.", website), Instagram if wanted. Send the Page and
      IG IDs; Agent pins them in `town.json` so posts can only go to the
      town's own Page.
- [ ] Daily posts (the town's jobs worker builds the social kit every day
      at 8:47 AM local, puts it on `https://www.<domain>/social/latest/` and
      posts it; JOBS_ON_RAILWAY.md 2b). Posting turns on with these
      variables on the town's **jobs service** (`<web>-jobs`), never shared
      with another town:
      - `META_TOWN=<slug>` (says these Meta settings are this town's)
      - `META_PAGE_ID=<the Page ID pinned in town.json "meta".page_id>`
      - `META_PAGE_TOKEN=<a Page token, or a system-user token with the Page
        assigned>` (pages_show_list, pages_read_engagement, pages_manage_posts;
        for Instagram also instagram_basic, instagram_content_publish)
      - `IG_USER_ID` only once Instagram is linked and its id is pinned in
        `town.json` as `"meta".ig_user_id` (an id it doesn't pin stops the
        post); without it the post is Facebook only
      - `SOCIAL_AUTOPOST=1` last. Without it the kit is still built and on
        the site every day, nothing is posted. `GRAPH_API_VERSION` optional
        (default `v23.0`).
      Check: the next morning's run in the jobs service log ("Facebook:
      posted ..."), or a "Social posts (Facebook/Instagram) failed" alert.
- [ ] Daily ads report (the jobs worker at 8:37 AM local: yesterday's and
      the week's results to Slack activity, the spend to Admin → Growth).
      It does nothing until the town's ad account is pinned in `town.json`
      as `"meta".ad_account_id` (a PR) and its jobs service has
      `META_AD_ACCOUNT_ID` (the same id) and `META_TOWN`; it uses
      `META_ADS_TOKEN` (a system-user token with ads_read and
      ads_management, the ad account assigned), else `META_PAGE_TOKEN`.
      Check: an "📈 Meta ads" post in Slack activity the morning after the
      first spend, or a "Meta ads report failed" alert.
- [ ] Owner: a pixel per domain in Events Manager; Agent sets
      `META_PIXEL_ID` and checks a signup is recorded.
- [ ] Ad video: Owner records a 12 to 15 s selfie (the town's name, three
      kinds of events, the newsletter's name, "free every week"). Agent edits
      it like `TheVic361_signup_B_4x5`: 4:5, HDR tone-mapped, captions in
      Fredoka, the badge ("N+ things to do", then "Subscribe free"), real
      event cards from the live list (each label true, at least 0.9 s on
      screen), the town's own email on a phone, a 2.8 s end card, loudness
      about -16 LUFS. Dated cards go stale: re-render when they pass.
- [ ] Owner: duplicate Victoria's ad set: the town's Page, video, a 25 to 35
      mile radius, link `<domain>/subscribe`, $15 to $20 a day.

## 7. Monitoring (Owner, once)

- [ ] `HQ_SLACK_WEBHOOK_URL` on HQ (its own channel).
- [ ] UptimeRobot (or similar) on `https://www.<domain>/api/health` and
      `https://hq.tristenpalori.com/health`, alerting Slack and a phone.
- [ ] Turnstile: add `www.<domain>` to the widget.
- [ ] Agent: the Sunday night digest email (the jobs worker at 9 PM
      local mails the owner what's collected) needs
      `RESEND_API_KEY=${{<web service>.RESEND_API_KEY}}` on the town's jobs
      service (or `SMTP_EMAIL` and `SMTP_PASSWORD`, a Gmail app password);
      without it the job does nothing. `DIGEST_TO` changes the recipient.

## 8. Launch checks (Agent)

- [ ] `python3 scripts/launch_check.py --town <slug>`: every automatic check
      passes. A "Victoria, TX" on /privacy means the town still has
      Victoria's mailing address: set its own `NEWSLETTER_ADDRESS`.
- [ ] All five reviews clean: no Victoria text on the town's pages or
      emails (render every email with `TOWN=<slug>`), no URL spelling
      reaching `docs/` raw files, health ok, the worker taking jobs.
- [ ] `python3 scripts/live_check.py`: Victoria unchanged.

## Revenue features every town gets (Victoria too)

Built once in the shared code, turned on per town:

- [ ] **Category partners**: a monthly sponsor per category (one
      restaurant, one realtor, one dentist...), exclusive, shown on the site
      and in every issue, billed monthly through the shared Stripe account.
- [ ] **Venue outreach**: each week, the venues with an upcoming listed
      event get an email offering a featured pick for that event, with
      checkout prefilled.

## Paused towns

A town can be paused at near-zero cost and resumed later: see
GROWTH_STRATEGY.md, Portfolio.
