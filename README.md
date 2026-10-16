# The Vic 361 🏙️

**Your Daily Guide to Victoria, TX**

A community events board that automatically collects and displays things to do in Victoria, Texas. The same code runs every town's site (`towns/`); each runs on Railway with its own jobs service, and GitHub only holds the code and runs the tests.

## How It Works

1. **`collect_events.py`** gathers events from public Victoria calendars + your curated YAML file into `candidates.json`
2. The site's scheduler queues a collect Sunday and Wednesday afternoons, and the town's **Railway jobs service** runs the collector in **candidates-only** mode: it hands its candidates to the site and never overwrites the curated fallback at `docs/events.json`
3. At 9 PM Sunday, an informational digest email summarizes what was collected (when the jobs service has SMTP settings)
4. Candidates publish automatically after each run (`server/autopublish.js`). Tristen can edit or remove events at `/admin.html`, and the Resend newsletter goes out Monday morning (the week) and Thursday morning (the weekend). **Save & Publish** writes the curated payload to Railway Postgres (the live source of truth); nothing is committed to GitHub.
5. **Railway** serves the live site; `events.json` is read from Postgres first, falling back to the bundled `docs/events.json` snapshot
6. The website reads `events.json` and auto-displays the next 7 days

### Source of truth (`events.json`)

- **Live, curated source:** Railway Postgres `published_events` row (`store.getPublished()`), written by the admin Save & Publish flow.
- **Fallback snapshot:** `docs/events.json` in this repo, Victoria's frozen copy, served only when her database has nothing published. The collector runs with `--candidates-only` so it never overwrites this file with un-screened scraper output.
- **Candidates:** the full raw collector output for the admin to screen, handed by the jobs service to the site and kept in Postgres (`town_files`). The `candidates.json` in git is Victoria's last committed collect.

## Quick Start

```bash
# Install dependencies
pip install -r requirements.txt

# Run the collector (outputs to docs/events.json)
python collect_events.py --output ./docs/events.json --local-dir .

# Run with AI cleanup (needs OpenAI API key)
export OPENAI_API_KEY=sk-...
python collect_events.py --output ./docs/events.json --local-dir .

# Run with only local YAML (no web scraping)
python collect_events.py --output ./docs/events.json --local-dir . --skip-web
```

## Files

| File | Purpose |
|---|---|
| `collect_events.py` | Event collector script |
| `discover_venues.py` | Optional/manual Google Maps venue discovery utility (Apify `compass/google-maps-extractor`). No longer part of the weekly cron — see "Venue Discovery" below. |
| `venues.json` | Primary venue list — manually curated (seed venues + any venues you choose to add) |
| `pending_venues.json` | Holding file for venues awaiting admin review (no longer auto-populated) |
| `rejected_venues.json` | Venues we've explicitly rejected (never re-suggested) |
| `facebook_venues.json` | Legacy venue list (kept as a one-cycle fallback) |
| `facebook_venues.backup.json` | Snapshot of the legacy list, refreshed each run |
| `local_events.yaml` | Recurring + manually curated events |
| `extras.yaml` | "New & Notable" section + sponsor |
| `docs/` | Website files (served by the Express server on Railway) |
| `docs/events.json` | Curated fallback snapshot. Live data is served from Railway Postgres; this file is only used when Postgres has nothing or the site is served without the Express layer. Only the admin Save & Publish flow writes this file — the weekly collector skips it via `--candidates-only`. |
| `candidates.json` | Full raw collector output (every event found this week), for admin screening. |
| `.github/workflows/` | `tests.yml` (both test suites on every PR) and the manual probes; no town's jobs run here |

## Venue Discovery

Venue curation is **manual**. `venues.json` is edited by hand (or via the
admin tooling) and is the primary source for the venue-grounded
scrapers and social post pipelines. `facebook_venues.json` is kept as a one-cycle legacy
fallback. `rejected_venues.json` blocks names we've explicitly decided
against.

Google Maps discovery is **no longer run on the weekly cron**. The
`discover_venues.py` script (Apify `compass/google-maps-extractor` across
8 category searches scoped to `Victoria, TX`) was removed from
`weekly-collect.yml` in Apr 2026 after production runs showed it
consuming ~4 minutes, hitting per-category Apify timeouts, skipping 5/8
categories, and still producing HIGH=0/MEDIUM=0 from 60 raw items. The
script and its tests are kept in-tree as an opt-in utility — run it
locally with `APIFY_TOKEN=… python discover_venues.py` if you want to
seed `pending_venues.json` for manual review — but it does not run
automatically anywhere.

## AI (OpenAI)

The collector makes two kinds of OpenAI calls through one helper
(`_openai_chat` in `collect_events.py`), both keyed off `OPENAI_API_KEY`:

- **Social post extraction:** reads FB/IG posts (see below) and pulls out dated events.
- **AI review:** rewrites each candidate's description, picks icons, and sets the `free` flag.

The default model is `gpt-5-mini`. Set the `OPENAI_MODEL` repo variable to
try another one without a code change. Without a key, both steps skip and
the collector still runs.

Perplexity Sonar web-search discovery was removed in Oct 2026.

## Social Posts → Events (Optional)

Two opt-in pipelines pull recent social posts and ask OpenAI to
extract any specific-dated events from them. They catch events announced
as posts ("live music tonight 8pm") that never become formal Event pages.

| Flag | Source | Tier limits | Lookback |
|---|---|---|---|
| `FB_POSTS_ENABLED=1` | Apify `apify/facebook-posts-scraper` | 50 posts × HIGH-confidence venues | 30 days |
| `IG_POSTS_ENABLED=1` | Apify `apify/instagram-post-scraper` | 25 posts × HIGH, 15 × MEDIUM | 14 days |

Both are **off by default** until cost/quality is production-validated.
They share the `_APIFY_LIMIT_TRIPPED` tombstone, so once Apify's monthly
hard limit trips on any actor, the rest of the run skips its remaining
Apify calls. Toggle each independently with `FB_POSTS_ENABLED` /
`IG_POSTS_ENABLED` on the town's Railway jobs service; no code change
required.

Cost shape: ≤ $0.50/run for FB-posts, ≤ $0.85/run for IG-posts when both
are enabled.

## Adding Events

Edit `local_events.yaml` and add under `events:`:

```yaml
events:
  - date: "2026-03-22"
    name: "Spring Block Party"
    time: "5:00 PM – 10:00 PM"
    venue: "Downtown Victoria"
    address: "Main Street"
    description: "Live music, food trucks, and fun."
    icons: [music, food, family]
    free: true
    url: ""
```

## Public Event Submissions (v1)

A bot-resistant **Submit an Event** flow lives at `/submit.html`, served
by a small Express backend in `server/`. Submissions land in a Postgres
table (or a JSON file fallback), where the admin can approve, reject,
mark duplicate, or edit them before pulling them into the existing
weekly publish flow.

- Public form: `docs/submit.html` (mobile-first, honeypot + timing +
  Cloudflare Turnstile, server-side rate limited and dedupe-checked).
- Backend: `server/index.js` (Express). Run `npm start` locally.
- Admin login: `docs/admin.html` now signs in with username + password
  against the server (`ADMIN_USERNAME` / `ADMIN_PASSWORD` /
  `ADMIN_SESSION_SECRET`).
- Admin Submissions tab: shares the same login session — no separate
  token needed.
- No `GITHUB_TOKEN`: the admin loads the last collect's candidates from
  the database plus the approved-submissions queue, and **Save & Publish**
  stores the published payload in Railway Postgres, which the site serves
  from `/events.json`. Nothing is committed to GitHub.
- Public-facing `events.json` strips submitter PII and admin-only
  metadata before publish.

See `RAILWAY.md` for Railway setup and smoke tests, and AGENTS.md for every
environment variable.

## Setup

See `SETUP_GUIDE.md` for full setup instructions.
