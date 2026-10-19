# The Vic 361 — Setup Guide

Every town, Victoria included, runs on Railway: a web service (the Express
server and the site) with its own Postgres, and a jobs service that runs the
collector and the other jobs. GitHub only holds the code and runs the tests
(`tests.yml`). GitHub Pages and the old GitHub Actions jobs are retired.

Where the steps live:

- **RAILWAY.md**: standing up a service, every variable it needs, the jobs
  service, and the smoke test after a deploy.
- **LAUNCH_CHECKLIST.md**: a new town end to end (owner and agent steps).
- **AGENTS.md → Environment variables**: what every variable does.

---

## 1. Run it locally

```bash
npm ci
npm start                          # http://localhost:3000
pip install -r requirements.txt -r requirements-dev.txt
python collect_events.py --candidates-only --output ./docs/events.json --local-dir .
```

Without `DATABASE_URL` the server keeps its data in a JSON file under
`data/`, which is fine locally.

## 2. OpenAI, Apify and Gemini (the collector)

`OPENAI_API_KEY`, `APIFY_TOKEN` and `GEMINI_API_KEY` are project-shared
variables in the Newsletters Railway project; each town's jobs service
references them (RAILWAY.md "Jobs on Railway"). The collector still runs
without them, with fewer sources and no AI cleanup.

## 3. The Sunday digest email

The digest of what was collected goes out Sunday at 9 PM town time from the
town's jobs service. Give the jobs service the town's Resend key as a
reference, `RESEND_API_KEY=${{<web service>.RESEND_API_KEY}}`, and it sends
as news@ the town's domain. Gmail SMTP still works instead, with an
[App Password](https://myaccount.google.com/apppasswords): `SMTP_EMAIL` and
`SMTP_PASSWORD` (the 16-character App Password, no spaces); it wins when
both are set. Without either the digest is skipped.

## 4. Newsletter (Resend)

The newsletter runs on Resend (`server/newsletter.js`); Beehiiv is no longer used. Signups on the homepage are saved to the site's own list. To send:
1. Verify the town's domain in Resend and create an API key
2. In Railway set `RESEND_API_KEY` and `NEWSLETTER_ADDRESS` (mailing address shown in every email)
3. The site's scheduler sends Monday's and Thursday's issues on its own. `NEWSLETTER_CRON_SECRET` lets you start a send by hand (`POST /api/newsletter/cron`)

## 5. Legal pages

`/terms`, `/advertising-terms` (refunds at `/refunds`), `/privacy` and `/accessibility` name the business from Railway variables: `BUSINESS_LEGAL_NAME` (the LLC's legal name), `BUSINESS_CONTACT_EMAIL` (an inbox you read for refunds, privacy requests and free drawing entries) and `NEWSLETTER_ADDRESS`. They're plain-English drafts, not legal advice: have an attorney review them. See AGENTS.md "Legal pages".

---

## Architecture

```
Sunday and Wednesday, 3:23 PM town time:
┌──────────────────────┐
│  site scheduler      │──→ queues a collect (job_queue)
│  (web service)       │
└──────────────────────┘
         │
         ▼
┌──────────────────────┐
│  jobs service        │──→ collect_events.py --candidates-only:
│  (Railway)           │    town feeds, local_events.yaml, Facebook,
└──────────────────────┘    Instagram, Gemini; OpenAI cleanup
         │
         ▼
┌──────────────────────┐
│  web service +       │──→ candidates stored and auto-published;
│  Postgres            │    the site serves /events.json
└──────────────────────┘
```
