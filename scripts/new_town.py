#!/usr/bin/env python3
"""Start a new town (MULTI_CITY_PLAN.md 5.1).

    python3 scripts/new_town.py                      # asks for each setting
    python3 scripts/new_town.py --slug bay --name "The Bay 979" \\
        --domain thebay979.com --city "Bay City" --state TX --state-name Texas \\
        --timezone America/Chicago --county "Matagorda County" --area-code 979 \\
        --zips 77414,77404 --other-towns "wharton,palacios,el campo" --yes

Writes towns/<slug>/town.json (checked by town.py, the same checks the
server runs at boot), an empty local_events.yaml, extras.yaml and
venues.json for the collector (it never falls back to Victoria's root
files for another town), towns/<slug>/public/ for the town's own logo and images, and
adds the town to towns/index.json. It never touches Victoria's files and
refuses a slug that already exists. Then it prints what to run next and
the accounts the owner sets up.
"""
import argparse
import json
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, ROOT)
# town.py loads TOWN at import; the town being created can't be loaded yet.
_saved_town = os.environ.pop("TOWN", None)
import town as town_mod  # noqa: E402
if _saved_town is not None:
    os.environ["TOWN"] = _saved_town

FIELDS = [
    # (arg, town.json key, question, required)
    ("slug", None, "Short id (lowercase, e.g. bay)", True),
    ("name", "siteName", "Site name (e.g. The Bay 979)", True),
    ("domain", "domain", "Domain (e.g. thebay979.com)", True),
    ("city", "city", "City", True),
    ("state", "state", "State abbreviation (e.g. TX)", True),
    ("state_name", "stateName", "State name (e.g. Texas)", True),
    ("timezone", "timezone", "Time zone (e.g. America/Chicago)", True),
    ("county", "county", "County (e.g. Matagorda County; blank for none)", False),
    ("area_code", "areaCode", "Area code (3 digits; blank for none)", False),
    ("pick_name", "pickName", "Paid pick name (blank for Local Pick)", False),
    ("zips", "areaZips", "ZIP codes the area covers, comma-separated", False),
    ("other_towns", "otherTowns", "Nearby towns that aren't yours, comma-separated", False),
]
LISTS = {"zips", "other_towns"}


def build(values):
    """town.json from the answers; blank optional answers are left out."""
    out = {}
    for arg, key, _, _ in FIELDS:
        v = values.get(arg)
        if key is None or v in (None, ""):
            continue
        if arg in LISTS:
            v = [x.strip().lower() if arg == "other_towns" else x.strip() for x in str(v).split(",") if x.strip()]
            if not v:
                continue
        out[key] = v
    return out


def create(values, towns_dir):
    """Write the town's files; returns (slug, town settings, paths written)."""
    slug = str(values.get("slug") or "").strip().lower()
    if not re.match(r"^[a-z0-9-]+$", slug):
        raise ValueError("slug must be lowercase letters, digits or -")
    if slug == "victoria":
        raise ValueError("victoria is The Vic 361; pick another slug")
    raw = build(values)
    # The same checks the server and town.py run at boot.
    settings = town_mod.town_config(town={**raw, "id": slug})
    if settings["domain"] == town_mod.VICTORIA["domain"]:
        raise ValueError("that's Victoria's domain")
    folder = os.path.join(towns_dir, slug)
    if os.path.exists(os.path.join(folder, "town.json")):
        raise ValueError(f"{os.path.relpath(folder, ROOT)}/town.json already exists")
    # Read the index before writing anything, so a bad one stops the run
    # with nothing half-made.
    index_path = os.path.join(towns_dir, "index.json")
    try:
        with open(index_path, encoding="utf-8") as f:
            index = json.load(f)
    except FileNotFoundError:
        index = {"towns": ["victoria"]}
    except ValueError as e:
        raise ValueError(f"{index_path} isn't valid JSON ({e}); fix it first")
    if not isinstance(index, dict) or not isinstance(index.get("towns", []), list):
        raise ValueError(f'{index_path} must look like {{"towns": ["victoria", …]}}')
    os.makedirs(os.path.join(folder, "public"), exist_ok=True)
    written = []

    def write(name, text):
        path = os.path.join(folder, name)
        if not os.path.exists(path):
            with open(path, "w", encoding="utf-8") as f:
                f.write(text)
            written.append(path)

    write("town.json", json.dumps(raw, indent=2, ensure_ascii=False) + "\n")
    write("local_events.yaml", "# Hand-added events for this town (same format as Victoria's local_events.yaml).\nevents: []\n")
    write("extras.yaml", "new_and_notable: []\nsponsor: null\n")
    # No venues yet: the collector skips its venue-based scrapes (with a
    # warning) until discover_venues.py seeds this list.
    write("venues.json", "[]\n")
    write(os.path.join("public", ".gitkeep"), "")

    towns = [t for t in index.get("towns", []) if isinstance(t, str)]
    if slug not in towns:
        towns.append(slug)
    index["towns"] = ["victoria"] + sorted(t for t in set(towns) if t != "victoria")
    with open(index_path, "w", encoding="utf-8") as f:
        f.write(json.dumps(index, indent=2) + "\n")
    written.append(index_path)
    return slug, settings, written


def next_steps(slug, settings):
    site = settings["site_url"]
    return f"""
Next, in the repo:
  1. Seed venues (needs APIFY_TOKEN):
       TOWN={slug} python3 discover_venues.py --repo-root towns/{slug}
  2. Add the town's logo set to towns/{slug}/public/ (logo, favicons,
     apple-touch-icon, og-image, skyline day/night, email skyline).
  3. Add its own local calendars as collector sources (collect_events.py
     WEB_SOURCES) and list them in town.json "enabledSources".

Must be done before launch (MULTI_CITY_PLAN.md; each one blocks a launch,
and scripts/launch_check.py fails until the town is really collecting):
  - 3.3 the town's GitHub Environment "{slug}" (SITE_URL={site}, Meta,
    NTFY_TOPIC, cron secrets, SLACK_TOWN_TAG="{settings['city']}"), then
    "workflows": true in towns/{slug}/town.json (a PR), which turns on its
    site's scheduler and Pull Now and adds it to the scheduled Sunday and
    Wednesday collects. META_TOWN={slug} in the Environment only with the
    town's own Meta page, Instagram and ad account, whose ids also go in
    town.json "meta" (page_id, ig_user_id, ad_account_id, and campaign_prefix in the shared ad account). Until then it starts no collect, social kit,
    submission review or event check.
  - 3.5 the workflows' gates call the town's own SITE_URL.
  - 2.6 Railway watch paths on its service: /server/**, /docs/**,
    /package.json, /package-lock.json, /.nvmrc, /railpack.json,
    /town.py, /towns/{slug}/**, /towns/*/town.json (RAILWAY.md step 16).

Accounts and settings (owner; MULTI_CITY_PLAN.md 5.2). Follow
RAILWAY.md "New town on Railway" end to end: every variable, fresh secrets
per town (never copy Victoria's), Stripe webhook events, HQ_TOWNS, domain.
  - Domain {settings['domain']} and DNS.
  - A service and its own Postgres (backups on) in the Newsletters Railway
    project, production only. Variables: TOWN={slug},
    SITE_URL={site}, ADMIN_USERNAME, ADMIN_PASSWORD, ADMIN_SESSION_SECRET,
    the cron secrets, HQ_API_KEY, SLACK_TOWN_TAG="{settings['city']}".
  - Resend: verify {settings['domain']} (SPF, DKIM, MX for replies); RESEND_API_KEY;
    NEWSLETTER_FROM="{settings['site_name']} <news@{settings['domain']}>";
    NEWSLETTER_ADDRESS (a street address or PO box with ZIP: no issue goes out
    without it); NEWSLETTER_REPLY_TO; NEWSLETTER_CRON_SECRET (Railway and the
    town's GitHub Environment); a webhook to {site}/api/email/inbound with the
    events email.received, email.bounced and email.complained, and its
    RESEND_WEBHOOK_SECRET.
  - Legal pages (Railway): BUSINESS_LEGAL_NAME (the LLC's legal name),
    BUSINESS_CONTACT_EMAIL (an inbox you read: refunds, privacy requests,
    free drawing entries) and NEWSLETTER_ADDRESS (a PO box or registered
    mailbox; every email needs it too).
  - Stripe: the town's own Stripe account (Stripe → account menu → New
    account), on the same LLC, EIN and payout bank account as Victoria, so
    checkout, receipts and card statements show {settings['site_name']}, not
    The Vic 361. Set its public business name, logo and statement
    descriptor, then its STRIPE_SECRET_KEY, and a webhook endpoint at
    {site}/api/stripe/webhook with its STRIPE_WEBHOOK_SECRET, subscribed to
    the events in RAILWAY.md step 5 (including charge.dispute.closed and
    invoice.paid). Switch to the live key and live endpoint secret after the
    launch test checkout (a test key in production is a Setup warning).
    Products and prices are created on the first checkout.
  - Facebook page, Instagram, ad account (the town's GitHub Environment).
  - GA data stream (gaId in town.json), Tremendous campaign.
  - Turnstile: add {settings['domain']} to a widget; TURNSTILE_SITE_KEY and
    TURNSTILE_SECRET_KEY (required: without them every newsletter signup has
    to confirm by email).

Before launch (5.3): python3 scripts/launch_check.py --town {slug} passes
(10+ upcoming events, a collect in the last 8 days, workflows on, venues
seeded), the server starts (boot guards pass), a test newsletter to
delivered@resend.dev, a Stripe test-mode checkout, a reply lands in #inbox
tagged with the town, HQ shows it, and Victoria's live check is unchanged.
"""


def main(argv=None):
    ap = argparse.ArgumentParser(description="Start a new town (towns/<slug>/)")
    for arg, _, question, _ in FIELDS:
        ap.add_argument("--" + arg.replace("_", "-"), dest=arg, help=question)
    ap.add_argument("--towns-dir", default=os.path.join(ROOT, "towns"))
    ap.add_argument("--yes", action="store_true", help="don't ask; fail on a missing required setting")
    args = ap.parse_args(argv)
    values = vars(args)
    for arg, _, question, required in FIELDS:
        if values.get(arg) not in (None, ""):
            continue
        if args.yes or not sys.stdin.isatty():
            if required:
                ap.error(f"--{arg.replace('_', '-')} is required")
            continue
        values[arg] = input(f"{question}: ").strip()
    try:
        slug, settings, written = create(values, args.towns_dir)
    except ValueError as e:
        print(f"Not created: {e}", file=sys.stderr)
        return 1
    print(f"Created {settings['site_name']} ({slug}):")
    for p in written:
        print("  " + os.path.relpath(p, ROOT))
    print(next_steps(slug, settings))
    return 0


if __name__ == "__main__":
    sys.exit(main())
