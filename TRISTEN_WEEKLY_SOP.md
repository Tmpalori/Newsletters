# The Vic 361 — Tristen's Weekly SOP

## What's Already Automated
The system handles ~70% of event collection automatically:
- **Recurring weekly events** (20+ events/week) — Froggy's specials, Farmers' Market, Aero Crafters live music, Library story times, Chess Club, Story Strolls, etc.
- **City of Victoria calendar** — scraped weekly (library programs, city events, meetings)
- **Chamber of Commerce events** — scraped weekly (business events, community gatherings)
- **Google Sheet submissions** — anything you add to the sheet gets pulled in automatically
- **Deduplication** — the system merges everything and removes duplicates

- **Publishing** — each collect goes live on its own (auto-publish); free submissions are AI-reviewed and the good ones publish themselves; the event check hides church events, non-events and exact duplicates

**Your job: Fill in what the bots can't find, and step in when Slack or the admin Home tab says something needs you.** That's mainly bar/restaurant live music, Facebook-only events, and one-time community stuff. There is no event picking to do. Takes ~15 minutes per week.

---

## Weekly Cadence

Times are Central daylight time. The site's own scheduler starts each job on time; Victoria's jobs run on her Railway jobs service.

| Time (Central) | What happens | Who does it |
|---|---|---|
| Sun + Wed 3:23 PM | The jobs service runs the event collector and hands the new candidates to the site, which **auto-publishes** them at once; Slack says "Collect done". | Automated |
| Right after each collect | The event check looks over the live list, hides sure-thing junk and posts to Slack what it hid and anything to look at | Automated |
| Every 15 min | AI review of free submissions: good ones go live (the submitter gets a "you're live" email), doubtful ones wait in the Submissions tab | Automated |
| Sun ~9 PM | The jobs service emails a summary of what was collected (for awareness; the events are already live) | Automated |
| Mon 7:43 AM | Newsletter (the week) sends automatically (or press Send in admin) | Automated |
| Thu 7:00 AM | Weekend newsletter (Friday–Sunday) sends automatically; readers can skip it and keep Mondays | Automated |
| When Slack asks | Open [www.thevic361.com/admin.html](https://www.thevic361.com/admin.html): Home tab for what needs you, Events tab to edit or remove an event, then **Save & Publish** | **You** |

Never edit `docs/events.json` by hand: it's only a fallback copy, and the live list is in the database.

---

## Weekly Checklist (Every Sunday — 15 min)

### Step 1: Quick Facebook Scan (5 min)
Open these two groups and scroll through this week's posts:

1. **[Victoria, Tx - Events and Nightlife](https://www.facebook.com/groups/victoriatxevents)** (~10K members)
2. **[Victoria Texas Community & Events](https://www.facebook.com/groups/victoriatxcommunity)** (~2.8K members)

**What to look for:**
- 🎵 Live music at bars (Moonshine, The Hideaway, Siesta, etc.)
- 🍔 Food truck rallies, pop-up restaurants
- 🎨 Art shows, gallery openings
- 🛍️ Pop-up markets, vendor fairs
- 👨‍👩‍👧‍👦 Fundraisers, benefits, community events
- 🆕 New restaurant openings / soft openings

### Step 2: Quick Venue Check (3 min)
Scan these pages for this week's lineup:

| Venue | Where to Check | What They Post |
|---|---|---|
| **Aero Crafters** | [Facebook](https://www.facebook.com/aerocrafters/) or [Eventbrite](https://www.eventbrite.com/o/aero-crafters-18361431565) | Specific artist names for Fri/Sat live music |
| **Moonshine Drinkery** | [Facebook](https://www.facebook.com/moonshinedrinkery/) | Live music, First Friday art shows |
| **The Hideaway** | Facebook | Weekend live music |
| **Froggy's Grub & Pub** | [Website Events](https://froggysgrub.com/froggys-events/) or [Facebook](https://www.facebook.com/froggysgrubandpub/) | Special events beyond daily specials |

**You're looking for:** The specific artist name playing this Friday/Saturday at Aero Crafters and Moonshine. The recurring "Live Music at Aero Crafters" is already in the system — you're just updating the artist name if you find it.

### Step 3: Add Events to Google Sheet (2 min)
**Sheet URL:** [The Vic 361 Events Sheet](https://docs.google.com/spreadsheets/d/1S42hYlrPM516LDTcy3W_8afCkCqc-ZrUfN2J-SmP23I/edit)

For each new event, add a row:

| Column | What to Enter | Example |
|---|---|---|
| **Date** | YYYY-MM-DD | 2026-03-22 |
| **Event Name** | Keep it short & clear | Jake Castillo LIVE |
| **Time** | Start – End | 7:00 PM – 10:00 PM |
| **Venue** | Venue name | Moonshine Drinkery |
| **Address** | Street address | 103 W. Santa Rosa St. |
| **Notes** | One-line description | Country acoustic set on the patio. |
| **Added By** | Your name | Tristen |
| **Status** | Leave blank or "new" | new |

That's it. The collector picks up new rows on its next run (Sunday and Wednesday, 3:23 PM Central). Add rows by 3 PM on Sunday or Wednesday so that run includes them.

---

## Monthly Tasks (First Monday of Each Month — 5 min)

### Update "New & Notable"
Edit the **extras.yaml** file directly in the repo. Swap in fresh items:
- New restaurant/bar openings
- Construction updates (what's coming)
- Closings or relocations

**Where to find this info:**
- Victoria Advocate headlines
- Fox Sports 1510 Victoria (tracks new businesses)
- Crossroads Today (KAVU TV)
- Facebook groups (people post about new spots)

### Schedule Monthly Library Events
Check [Victoria Public Library Calendar](https://victoriapl.librarycalendar.com/events/week) for:
- VPL Jams (monthly live music — usually a Friday)
- VPL Talks (monthly speaker series)
- VPL Rec Night (monthly game night — usually a Tuesday)
- True Crime Book Club (monthly)
- Tiny Hearts Club / Book'nic (monthly)

Add these to the Google Sheet as one-time events.

---

## Quick Reference

### Common Venues & Addresses

| Venue | Address |
|---|---|
| Aero Crafters | 309 E. Crestwood Dr. |
| Moonshine Drinkery | 103 W. Santa Rosa St. |
| The Hideaway | 1807 Stolz St. |
| Froggy's Grub & Pub | 5902 N. Navarro St. |
| Victoria Public Library | 302 N. Main St. |
| Victoria Farmers Market | 2805 N. Navarro St. |
| Riverside Park | 405 Memorial Drive |
| DeLeon Plaza | 101 N. Main St. |
| Leo J. Welder Center | 214 N. Main St. |
| Victoria Fine Arts Center | 1002 Sam Houston Dr. |
| Museum of the Coastal Bend | 2200 E. Red River St. |
| The Nave Museum | 306 W. Commercial St. |
| Victoria Community Center | 2905 E. North St. |
| DeLeon Civic Center | 203 N. Glass St. |

### Icon Tags (for reference)
🍔 food · 🎵 music · 👨‍👩‍👧‍👦 family · 🍺 drinks · 🎨 arts · 🛍️ shopping · 🏃 outdoors · 📅 community · 🆓 free

---

## Troubleshooting

**"The site doesn't show my event"**
→ Events are pulled from the Google Sheet during the Sunday and Wednesday 3:23 PM runs. If you add something after a run, it shows up after the next one, or right away if you add it in the admin Events tab, or press **Pull Now** in the admin's Sources tab to start a collect (watch it in the jobs service's Railway log).

**"There are duplicate events"**
→ The system deduplicates automatically. If you see a duplicate, it may have slightly different names from two sources. It'll usually resolve on the next run with AI cleanup.

**"Weekend events are thin"**
→ This is the main area where your weekly scan helps. Saturday & Sunday rely heavily on what you find on Facebook and venue pages.

---

## Venue Discovery (Manual)

Venue curation is now **manual**. Edit `venues.json` directly (HIGH-tier
list used by the venue-grounded scrapers and social post pipelines) and
`facebook_venues.json` for the legacy fallback. `rejected_venues.json`
blocks names you've explicitly decided against.

The Google Maps discovery step that used to run before the collector
(`discover_venues.py`, Apify `compass/google-maps-extractor`) was
**removed from the weekly cron in Apr 2026** because production runs
were spending ~4 minutes per pull, timing out partway through, skipping
most categories, and still landing 0 HIGH/0 MEDIUM venues. Not worth
the cost or schedule risk.

The script itself is still in the repo. If you ever want to take a one-
off look at what Google Maps would suggest, run it manually with an
Apify token:

```bash
APIFY_TOKEN=... python discover_venues.py
```

That writes/updates `venues.json` and `pending_venues.json` locally for
you to review and commit by hand. It does not run on any schedule.

---

## AI Steps (OpenAI)

OpenAI does two jobs on each collect (Sunday and Wednesday): it pulls dated
events out of FB/IG posts (below), and it rewrites each candidate's
description and icons before they publish. Both need the `OPENAI_API_KEY` repo secret.
Perplexity web search was removed in Oct 2026.

---

## Social Posts → Events (Opt-in)

Two optional pipelines pull recent posts from venue social pages and use
OpenAI to extract dated events from the post text. Both are
**off by default** and toggled by variables on the town's Railway jobs
service:

- `FB_POSTS_ENABLED=1` — Facebook posts (50 posts × HIGH-confidence venues,
  30-day lookback). Apify actor: `apify/facebook-posts-scraper`.
- `IG_POSTS_ENABLED=1` — Instagram posts (25 × HIGH, 15 × MEDIUM venues,
  14-day lookback). Apify actor: `apify/instagram-post-scraper`. Uses
  `instagrams[]` from `venues.json` (or legacy `instagram` field) and
  normalizes URLs/`@handles`/plain usernames before scraping.

Both share the same Apify monthly-cap tombstone — if one trips the hard
limit, the rest of that run skips remaining Apify calls. Costs: ≤ $0.50/run
(FB), ≤ $0.85/run (IG) at current tier sizes. The OpenAI extraction prompt
is shared between the two; IG captions and FB post text are similar enough
that one prompt covers both without redesign.
