# Newsletter sections

The extra sections under the events, in both issues and on the homepage
(October 2026). They're there so readers have something they can't get
from any events list, and look forward to opening the email.

| Issue | Section | Where it comes from |
|---|---|---|
| Monday | Pet of the week | The town's shelter listing: the pet who has waited longest, has a real photo and wasn't featured in the last 8 weeks. The photo is copied and resized onto our site (`/sections/pet/<id>.jpg`), credited to the shelter. |
| Monday | New in town | Public business data (below). Readers see "NEW" or "SOON" and a one-line note, never where we found it. |
| Monday | Question of the week | New questions the AI writes for the town once a month (or when fewer than 4 are left): about half fit the season, none political, none repeated within 26 weeks, each read by the editor and the rules. The next one runs each Monday; the town's own list in `sections.json` is the fallback (and the AI's style guide). Replaces the "Just hit reply" line. Slack says when new ones are added; admin → Newsletter shows the ones coming up, each with Take out. |
| First Monday of the month | One-tap poll | The town's list in `sections.json`. Each choice is a link (`/p/<week>/<poll>/<choice>?s=<subscriber id>`) that records the vote and opens the results (`/poll/<week>/<poll>`). One vote per reader; a mail scanner that clicks every choice within 30 seconds is thrown out, and so are bots. |
| Thursday | "<City> says" | The best 2 to 4 answers to Monday's question, from readers' replies (first names only). Skipped with fewer than 2. |
| Thursday | From City Hall | Updates from the city or county agenda, good news only and nothing political: parks, the library, festivals, proclamations. Never taxes, police, elections, zoning, lawsuits, alcohol licenses or anything that could start an argument. |

## How it runs

1. **Sunday and Wednesday 6:13 PM** (after the collect), the jobs worker
   runs `scripts/sections.py` (job `sections`): it reads the sources, and
   one AI call drafts the pet's blurb, the new places' lines, the City Hall updates
   and the roundup in the house voice.
2. **The editor pass.** A second AI call reads every item the way a human
   editor would (positive, no politics or bad news, accurate to the source,
   no hint of permits or records, doesn't sound like AI, names written
   properly) and keeps, fixes or drops each one. Then fixed rules check its
   work: words that give away the source, AI tells ("nestled", "hidden
   gem"...), anything that isn't good news, dashes, extra exclamation
   points. Something the editor doesn't answer for is dropped. Without
   `OPENAI_API_KEY` only the pet runs, with a plain line.
3. The file goes to the site (`town_files.sections`) and Slack's activity
   channel gets one note: what's in it and how many items the editor left
   out, with a link to admin → Newsletter.
4. **Admin → Newsletter → This week's sections**: Take out (or Put back)
   any item. It's gone from the next issue and the homepage.
5. **Monday 7:08 AM and Thursday 6:23 AM**, right before each issue and
   after the event check, the job runs again: it checks the pet is still
   listed (if it was adopted, it picks another, and the editor reads the
   new blurb), and writes the issue's **one-line greeting** from what the issue
   will show (`GET /api/jobs/issue`), read by the editor and the rules like
   everything else. It sits above the "In this issue" list (the big three
   events, the count, the sections), which the site builds from the issue
   itself (`introText` in `server/newsletter.js`). The greeting is used only
   when any event it names is in the issue; otherwise a plain one.

## Turning it on for a town

`sections.json` (Victoria's at the repo root, another town's in
`towns/<slug>/`) holds the town's sources, questions and polls, with
`"enabled": false` until the owner OKs it. Set it to `true` (or set
`SECTIONS=1` on the town's web service to try it without a commit;
`SECTIONS=0` turns it off). Without it, every page and email is exactly
what it was (the Victoria goldens pin that).

The worker needs `poppler-utils` (`pdftotext`, in `Dockerfile.jobs`) for
the agenda PDFs.

## Sources by town (checked October 2026)

| Town | Pets | New in town | From City Hall |
|---|---|---|---|
| Victoria | Victoria County Animal Services (PetPoint) | Texas Comptroller sales-tax outlets, open in the last 60 days, storefront NAICS codes only | Victoria County Commissioners Court (CivicClerk API) |
| Medford | Southern Oregon Humane Society (Shelterluv) and Jackson County Animal Services (24PetConnect), rotating | Oregon Secretary of State new registrations (the city's own list is behind a bot wall) | Not yet: the city site blocks us; Jackson County's agenda PDFs are the next step |
| The Shoals | Florence-Lauderdale Animal Services (24PetConnect) | Shoals Chamber ribbon cuttings (GrowthZone) | Florence City Council (Granicus RSS + agenda PDF) |
| Lincoln | Capital Humane Society (its own site, with bios) | Journal Star food and business headlines about openings | LNKTV's caption text of the last council meeting |
| Virginia Beach | Virginia Beach Animal Care & Adoption Center (Adopets) | Commercial tenant build-out permits that name the business | The council's brief agenda PDF |

Each source fails on its own: a shelter site that's down means no pet that
week, and the rest still runs. Undocumented feeds (Adopets, PetPoint's
embed key) can change without notice; the job's log says which one failed.

## On the website

With a town's sections on:

- **Homepage**, under the events: New in town, the pet, the readers' answers,
  the question of the week (with a "Count me in" button to the footer's
  signup form) and From City Hall.
- **Pages** `/new-in-town` (by month), `/pets` (this week's and the 12
  before, photos kept) and `/city-hall` (by week), from `sections_archive`,
  a town file the site adds to whenever the worker hands in a sections file;
  what the owner takes out comes off them too. Each ends with a signup form
  (source `sections`) and is in the sitemap.
- **Menu**: New in Town, Pets and City Hall right after This Weekend
  (`setSectionNav` in `server/seo.js`; nothing for a town without them).
- **Share cards** (1200x630, same look as the event cards): the pet's photo
  and "Meet <name>" (`/sections/cards/pet-<id>.png`, the Pets page's
  og:image) and the newest three places (`/sections/cards/new-in-town.png`).

## On social

The daily social kit (`scripts/social_kit.py`) adds two posts for a town
with its sections on: **Tuesday** the pet of the week (its photo, "Meet
<name>", the shelter; caption links to `/pets`) and **Wednesday** New in
Town (up to four places on the slide, six in the caption; links to
`/new-in-town`). Each is the feature slide plus the subscribe slide. With no
pet or no new places that week, or sections off, the day posts its usual
"Today in" instead (`job_social_kit`). The sections job itself does nothing
for a town with sections off (no AI calls), unless `SECTIONS=1`.

## What readers do with them

The email's section links go through `/go/x/<pet|places|hall>` (counted,
then on to our own page or a link that week's sections carry; anything else
goes home, and a bot's or mail scanner's click isn't counted), kept per week
in the `section_clicks` town file. Admin → Newsletter → This week's sections
shows this week and last: clicks per section, poll votes and replies to the
question.

## When something goes wrong

| What fails | What readers get |
|---|---|
| A shelter's site is down or has no pet with a real photo | The next shelter on the town's list; with none, no pet that week (the email and the "In this issue" list just leave it out) |
| The pet is adopted before the issue | The morning recheck picks another; if that check can't reach the shelter, the pet stays |
| The AI is down or the editor doesn't answer | The pet runs with a plain line; New in Town, City Hall and the roundup skip that week; the greeting is a plain one |
| No new questions from the AI | The town's own list in `sections.json` (it never runs out) |
| The sections job fails | Slack alerts on the first failure; a file older than 9 days is ignored, so the email goes out with the events, the question and the poll (both from `sections.json`) |
| Fewer than 2 good answers | No roundup that Thursday |

## Readers' answers

Every reply to an issue (not sponsor, pick or order mail) is saved in
`reader_replies`, kept 30 days: the email id, time, first name, address and
subject, and the text without the quoted issue. It still goes to Slack's
inbox as before. The question's "Send my answer" button opens an email to
news@ with the subject "My answer: <question>"; the job marks those, and
its AI uses only replies that actually answer the question (an event tip or
a correction never ends up in the roundup). The worker sees words and first
names, never addresses.
