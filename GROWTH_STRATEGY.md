# Growth strategy: local media, not just a newsletter

How the newsletters grow and earn, adopted October 2026. It draws on TJ
Larkin's approach (Local Newsletter Insider; runs the Leander, TX area
newsletters, Letterland LIVE, June 2025) and on Salina 311 (Salina, KS,
about $500k a year, mostly automated). Both are interviews or profiles with
self-reported numbers; treat them as direction, not proof.

## Picking a town

- **Size by trade area, not city limits.** Aim for 75,000 to 500,000
  people in the county or a 25 to 35 mile radius. Below about 75,000 a town
  only pays if it costs almost nothing to run or feeds another business.
- **A town people feel is theirs.** A suburb or standalone city with its
  own identity beats a big metro core ("Leander", not "Austin").
- **No established competitor.** No local newsletter or strong local
  Instagram brand already there.
- **Ad money.** Growing, decent incomes, lots of restaurants, venues,
  real estate and medical. A university helps.
- **Indirect value counts most.** The best operator also has a local
  business with a high value per customer (realtor, insurance, roofer). For
  Tristen that's commercial real estate: an Austin-area town feeds the CRE
  business directly, which is worth more than its ad revenue.

## Growth

- **Meta ads are the channel.** Early signups should cost 13 to 30 cents;
  over 50 cents means something is off (creative, audience, offer). Victoria
  runs about 80 cents, so test several videos and audiences before scaling.
- **Budget to about 10,000 subscribers** (about $5,000 at 50 cents), and
  expect the payoff to take about 12 months.
- **Instagram and short video.** A local Instagram is what makes ad sales
  easy. Simple talking-head "what's happening this week" videos work. The
  social kit already makes the posts; each town needs its own Page and
  account.
- **A local face per town** within about 3 months of launch (part-time:
  posts, events, ad sales).

## Content

- **Positive only:** no crime, no politics.
- **Events first:** the automated core. A featured event at the top gets
  the most clicks (our paid pick).
- **Evergreen sections** written whenever (not tied to a date):
  - **Adoptable pet of the week** from the local shelter. People love it,
    and pet businesses sponsor it.
  - **Business spotlights and "new in town"** openings.
  - **Community voices:** reader shout-outs and nominations.
- **City Hall in 2 minutes:** AI summaries of council and county meetings
  from their videos, approved before sending (Salina 311's strongest
  feature).

## Money

1. **Featured events** (built: $29 Mon–Thu, $39 Fri–Sun).
2. **Weekly sponsor** (built: $149).
3. **Category partners:** one per category a month, exclusive (to build;
   LAUNCH_CHECKLIST.md).
4. **Section sponsors:** the pet section, "new in town" and so on.
5. **Hosted events** with a bar or restaurant ($1,000 to $2,000 each;
   worked for one operator at 1,500 subscribers).
6. **Sales:** automated outreach to listed venues (to build), and a real
   salesperson once a town has the audience.
7. **Later:** paid print and legal notices (Salina 311), physical
   products.

## Portfolio (October 2026)

| Town | Status |
|---|---|
| Victoria, TX (The Vic 361) | Running, ads on |
| Medford, OR (The Rogue 541) | Running |
| The Shoals, AL (Shoals Setlist) | Running |
| Kearney, NE (The Crane 308) | Paused: under 75k, no collects, no ads |
| Tupelo, MS (Tupelo Current) | Paused: under 75k, no collects, no ads |

**Pausing a town** (cost near zero; the site stays up with its last events):
set the web service's `JOBS_ON_RAILWAY=0`, and give its jobs service the
start command `echo "Paused..."` with restart policy Never, then redeploy.
With jobs off and `"workflows": false`, nothing queues a collect, and the
"no new events", "missed collect" and "worker silent" alerts don't run.
**To resume:** `JOBS_ON_RAILWAY=1`, clear the jobs service's start command,
restart policy Always, redeploy, then Pull Now in the town's admin.
