# Newsletter sections

The extra sections under the events, in both issues and on the homepage
(October 2026). They're there so readers have something they can't get
from any events list, and look forward to opening the email.

| Issue | Section | Where it comes from |
|---|---|---|
| Monday | Pet of the week | The town's shelter listing: the pet who has waited longest, has a real photo and wasn't featured in the last 8 weeks. The photo is copied and resized onto our site (`/sections/pet/<id>.jpg`), credited to the shelter. |
| Monday | New in town | Public business data (below). Readers see "NEW" or "SOON" and a one-line note, never where we found it. |
| Monday | Question of the week | The town's list in `sections.json`, one a week in order. Replaces the "Just hit reply" line. |
| First Monday of the month | One-tap poll | The town's list in `sections.json`. Each choice is a link (`/p/<week>/<poll>/<choice>?s=<subscriber id>`) that records the vote and opens the results (`/poll/<week>/<poll>`). One vote per reader; a mail scanner that clicks every choice within 30 seconds is thrown out, and so are bots. |
| Thursday | "<City> says" | The best 2 to 4 answers to Monday's question, from readers' replies (first names only). Skipped with fewer than 2. |
| Thursday | Good news from City Hall | Feel-good items from the city or county agenda: parks, the library, festivals, proclamations. Never taxes, police, elections, zoning, lawsuits, alcohol licenses or anything that could start an argument. |

## How it runs

1. **Sunday and Wednesday 6:13 PM** (after the collect), the jobs worker
   runs `scripts/sections.py` (job `sections`): it reads the sources, and
   one AI call drafts the pet's blurb, the new places' lines, the good news
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
   new blurb), and writes the issue's **opening paragraph** from what the
   issue will show (`GET /api/jobs/issue`): two or three of its best events
   by name and one or two sections further down, read by the editor and the
   rules like everything else. The site uses it only when every event it
   names is in the issue; otherwise, or without the AI, it writes a plain
   one from the same facts (`introText` in `server/newsletter.js`).

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

| Town | Pets | New in town | Good news |
|---|---|---|---|
| Victoria | Victoria County Animal Services (PetPoint) | Texas Comptroller sales-tax outlets, open in the last 60 days, storefront NAICS codes only | Victoria County Commissioners Court (CivicClerk API) |
| Medford | Southern Oregon Humane Society (Shelterluv) and Jackson County Animal Services (24PetConnect), rotating | Oregon Secretary of State new registrations (the city's own list is behind a bot wall) | Not yet: the city site blocks us; Jackson County's agenda PDFs are the next step |
| The Shoals | Florence-Lauderdale Animal Services (24PetConnect) | Shoals Chamber ribbon cuttings (GrowthZone) | Florence City Council (Granicus RSS + agenda PDF) |
| Lincoln | Capital Humane Society (its own site, with bios) | Journal Star food and business headlines about openings | LNKTV's caption text of the last council meeting |
| Virginia Beach | Virginia Beach Animal Care & Adoption Center (Adopets) | Commercial tenant build-out permits that name the business | The council's brief agenda PDF |

Each source fails on its own: a shelter site that's down means no pet that
week, and the rest still runs. Undocumented feeds (Adopets, PetPoint's
embed key) can change without notice; the job's log says which one failed.
