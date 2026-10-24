# Sponsor lead lists (marketing/leads)

Phase 1 of sponsor outreach: up to 300 local businesses per live town, each with an owner or decision-maker email where Openmart has one, for the cold email drips that sell featured events, the weekly sponsor and category partners. Like `marketing/video`, this folder is separate from the site. Nothing in `server/`, `scripts/` or the collector imports it. It needs only the Python standard library and the repo's `town.py`.

Data comes from [Openmart's API](https://app.openmart.com/api-docs), Tristen's own account. Don't use Apollo for this: that account belongs to Foresite.

## The key

Openmart reads the key from `Authorization: Bearer <key>` (or `X-API-Key: <key>`). Either of these works:

- **Network secret (how it's set up now):** in the cloud environment's settings, the secret for `api.openmart.ai` adds header **Name** `Authorization`, **Prefix** `Bearer`, **Value** the key. `leads.py` then sends no key of its own, and the proxy adds it.
- **Environment variable:** `OPENMART_API_KEY`. When it's set, `leads.py` sends it as the Bearer token.

Check it with `python3 marketing/leads/leads.py balance`. It's free and prints the credit balance. A 401 means the key or the header name is wrong.

## What it builds

Each town's own area: the ZIPs in `town.py` / `towns/<slug>/town.json` `areaZips`. The quotas add up to 300:

| Category | Pitch | Quota | Searches |
|---|---|---|---|
| Food & drink | Category partner | 50 | restaurant, bar, coffee shop, bakery, brewery, winery |
| Venues & fun | Featured events | 20 | event venue, live music venue, theater, bowling, escape room, golf |
| Home services | Category partner | 30 | HVAC, plumber, roofing, electrician, landscaping, pest control, pool, remodeling |
| Real estate | Category partner | 25 | agencies, home builders, mortgage, title, property management |
| Insurance & finance | Category partner | 25 | insurance agencies, advisors, credit unions, banks, accountants |
| Auto | Category partner | 20 | repair, dealers, tires, detailing, collision |
| Dental | Category partner | 20 | dentists, orthodontists, pediatric dentists |
| Pets | Category partner | 20 | vets, groomers, pet stores, boarding, trainers |
| Fitness | Category partner | 20 | gyms, yoga, pilates, CrossFit, martial arts |
| Family & kids | Category partner | 20 | dance, gymnastics, tutoring, kids' activities, trampoline parks, music lessons |
| Legal | Category partner | 15 | law firms, attorneys |
| Beauty & wellness | Weekly sponsor | 20 | salons, med spas, day spas, barbers, chiropractors |
| Local shops | Weekly sponsor | 15 | boutiques, gift shops, florists, furniture, jewelry |

The category partner ids match `server/town.js` `partnerCategories`, and a test checks that.

Picking rules:

- **Kept out:** businesses with no website of their own (`find_people` needs a domain), brands with more than 10 locations (their marketing is decided at head office), and any second business on the same domain. A practice's location subdomains (`florence.example.com`) count as one domain.
- **Local owners only:** the leads are businesses whose owner lives in the town. `not_local()` leaves out public bodies (government, libraries, schools and universities, parks, tourism boards, chambers, downtown associations, YMCAs, farmers markets), churches, chains (Openmart's `CHAIN` with 3 or more locations), and `.org` nonprofits. Two kinds of nonprofit stay: ticket-selling arts groups (theaters, symphonies, festivals, museums, zoos) and credit unions, because both sell to locals and pay for local promotion. `overrides.json` corrects the rules by domain: `drop` takes out national chains and out-of-town companies the rules can't see (Texas Roadhouse, a Houston dealer group, a national lender's loan officers), and `keep` saves real businesses on a `.org` site (a vet, a bar, a plumber). `pick` writes what it left out, with the reason, to `out/<town>/left_out.json`.
- **Ranking:** businesses with more Google reviews come first.
- **Already in the newsletter:** venues from the town's `venues.json` are always kept and marked `already_listed`. That includes ones the searches missed, when they have a website of their own. They're the warmest leads, because their events already run in the newsletter.
- **Short categories:** when a category comes up short, its slots go to the best of the rest.

## Stages

Every stage that spends credits is a **dry run unless `--go`**. With `--go` it prints the credit balance before and after. `--max-spend N` stops a stage once N credits are gone. Everything is cached under `out/<town>/`, so a re-run never pays twice for a search or a contact batch. `--refresh` forces new searches.

```bash
L="python3 marketing/leads/leads.py"
$L balance                                   # free: is the key working, how many credits
$L search --town victoria                    # dry run: the 66 queries it would send
$L search --town victoria --category dental --per-query 5 --go   # pilot: 15 records, see the cost
$L search --town victoria --go --max-spend 500
$L pick --town victoria                      # offline: picked.json, counts per category
$L contacts --town victoria --go             # find_people: 1 owner/decision maker per pick, email only
$L contacts --town victoria --limit 100 --go # only the 100 best picks not yet sent (spend in measured steps)
$L contacts --again --max-k 2 --go           # second round: a general or marketing manager where no one's email came back
$L named --go                                # lookup_people: emails for people we have a name for (staff on the
                                             # business's own site, or find_people results without an email)
$L emails --town victoria --go               # info@-type emails for picks with no verified person email
$L search --more --go                        # the next page of every search whose last page came back full
$L search --nearby --town victoria --go      # the town's NEARBY towns (Victoria: Cuero, Port Lavaca, Edna, Goliad, Yoakum)
$L pick --target 380                         # more than 300 per town; each category's quota scales with it
$L export                                    # offline: out/<town>/leads-<town>.csv + out/leads-all.csv
```

The options:

- **Towns:** with no `--town`, a stage runs every live town (victoria, medford, shoals, lincoln, virginiabeach).
- **`contacts`:** `--max-k 2` returns up to two people per business, and `--phone` adds phone numbers. Both cost more.
- **Waiting:** `contacts` and `emails` submit batches of 100 and wait up to 8 minutes for each. A batch that's still running is picked up on the next run. Batch ids are saved as soon as Openmart returns them, so nothing is sent twice.

Openmart doesn't publish a price per record. Run the pilot first and scale up from what it actually costs.

## The CSV

There's one row per business. The columns:

- **The business:** town, newsletter, category, pitch, business, website, domain, address, city, zip, business phone, business email, Google rating and review count, already_listed.
- **The best contact:** name, title, email, email_verified, phone, LinkedIn.
- **Everything else:** other_contacts, openmart_id, and empty `status` / `notes` columns for tracking outreach.

## Privacy

These are people's names and emails. `out/` is gitignored. The CSVs go to Tristen's Google Drive (one Sheet per town), never into the repo or a PR.

## Next (phase 2, not built here)

- **Sending:** cold email goes out from a separate domain with warmed-up inboxes. Never from news@ or the Resend account the newsletters use, so spam complaints can't hurt the newsletters.
- **CAN-SPAM:** a real From name, honest subject lines, the postal address, and a working unsubscribe that's honored.
- **Real numbers:** every audience number in an email or ad must be true. HQ has each town's subscriber count and open rate.
