# Launching a new town: the owner's checklist

What only the owner can do (buy, sign up, prove identity), town by town.
Claude does the rest (Railway, settings, testing) once each step is done.
The full reference is RAILWAY.md "New town on Railway"; this is the short
version with each town's own values filled in.

| | Tupelo | Kearney | Medford | The Shoals |
|---|---|---|---|---|
| Slug (`TOWN`) | `tupelo` | `kearney` | `medford` | `shoals` |
| Brand | Tupelo Current | The Crane 308 | The Rogue 541 | Shoals Setlist |
| Domain | tupelocurrent.com | thecrane308.com | therogue541.com | shoalssetlist.com |
| Paid label | Spotlight | Featured | Spotlight | Headliner |
| Newsletter from | `Tupelo Current <news@tupelocurrent.com>` | `The Crane 308 <news@thecrane308.com>` | `The Rogue 541 <news@therogue541.com>` | `Shoals Setlist <news@shoalssetlist.com>` |
| Slack tag | Tupelo | Kearney | Medford | Shoals |

Do one town end to end first (Kearney has the best event feeds), then the
other three.

## 1. Domain (10 min a town)

1. Buy the domain (any registrar; Cloudflare or Porkbun are cheapest to keep).
2. Grab the same name on Instagram and Facebook while you're there.
3. Tell Claude. Claude adds it to Railway and sends you the exact DNS records
   (a `www` CNAME, plus the apex redirect) to paste in.

## 2. Resend: email (5 min a town)

1. resend.com → Domains → Add domain → the town's domain.
2. Paste the DNS records it shows (SPF, DKIM, and the MX record for replies).
3. No new API key: every town uses the one full-access key kept as the
   Newsletters shared variable `Resend_api_key` (to rotate it, create a new
   full-access key and paste it there).
4. Webhooks → Add endpoint: `https://www.<domain>/api/email/inbound`, events
   `email.received`, `email.bounced`, `email.complained`, `email.delivered`.
5. Send Claude the webhook's signing secret.

## 3. Stripe: payments (5 min a town)

Every town sells through the one Stripe account The Vic 361 uses, with
one shared key; no new account or key per town.

1. Once, for all towns: Settings → Business → Public details, a neutral
   business name and statement descriptor prefix (the LLC or a shared
   brand, 10 characters or fewer). The code adds the town to each card
   statement (e.g. `VIC 361`, `TUPELO`).
2. Once, for all towns: one restricted key (API keys → Create a secret
   key → Building your own integration → Custom permissions; write on
   Checkout Sessions, Products, Prices, Subscriptions, Charges and Refunds,
   and Customer Portal; read on Invoices). It lives in Railway as the
   Newsletters shared variable `Stripe_secret_key`; to rotate it, roll the
   key and paste the new one there.
3. Per town: nothing to create. Claude points the town's
   `STRIPE_SECRET_KEY` at the shared key and adds its webhook endpoint and
   `STRIPE_WEBHOOK_SECRET` (RAILWAY.md "New town on Railway" step 6).

## 4. Cloudflare Turnstile: spam protection on forms (2 minutes total)

dash.cloudflare.com → Turnstile → the widget → Hostname management. Every
town's `www.` host must be on the widget whose keys its service uses:

| Town | Host |
|---|---|
| Victoria | `www.thevic361.com` |
| Tupelo | `www.tupelocurrent.com` |
| Kearney | `www.thecrane308.com` |
| Medford | `www.therogue541.com` |
| Shoals | `www.shoalssetlist.com` |
| Lincoln | `www.thestar402.com` |
| Virginia Beach | `www.thetide757.com` |

A free widget holds at most **10 hostnames**: seven towns' `www.` hosts fit,
but adding apex or Railway domains (or an eighth town and beyond) needs a
second widget. A service's `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`
must come from the same widget. A missing hostname makes the widget fail
with error 110200 for every visitor; the form sends that code back
(`ts_err`), and after five failures and no pass in a day the town alerts
"The bot check fails for everyone" and its setup check reads failing
(`server/formGuard.js`). Messages still come through, labeled.

## 5. Facebook and Instagram (15 min a town)

1. Create a Facebook Page named after the brand (category: Media/News
   Company), and an Instagram professional account linked to it.
2. In Meta Business Suite, add both to your business. For ads, add an ad
   account for the town.
3. Tell Claude when they exist; Claude walks you through the page token.

## 6. Mailing address (once)

Every newsletter must show a postal address, and the legal pages print
it too. Get one in the town itself (a PO box or a registered mailbox
there) so the site doesn't read as run from somewhere else; never reuse
another town's. Send Claude the address.

Nothing on GitHub: every town, Victoria included, runs its jobs on its own
Railway jobs service, so there is no GitHub Environment to make.

## After that (Claude)

The town's Railway web and jobs services and database, every Railway
variable, domain, Stripe webhook, HQ entry, the first collect, the launch
check (`scripts/launch_check.py --town <slug>`), a test newsletter to the
test address, a test-mode checkout, and a check that Victoria is unchanged.
The steps are LAUNCH_CHECKLIST.md and RAILWAY.md "New town, the simple
way"; `town.json` keeps `"workflows": false`.
