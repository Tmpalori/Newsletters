#!/usr/bin/env python3
"""Is a new town ready to launch? (MULTI_CITY_PLAN.md 5.3, the automatic part.)

    python3 scripts/launch_check.py --town bay [--site https://www.thebay979.com]
    HQ_API_KEY=… python3 scripts/launch_check.py --town bay      # also checks the HQ feed

Reads the town from towns/<slug>/town.json (TOWNS_DIR to override) and asks
its live site, GET only, nothing posted and no key needed (HQ's aside):

  - health: up, on its own Postgres (so the boot guards passed);
  - /api/config: it runs as this town and publishes to towns/<slug>/, and
    Turnstile is on (its public flags; the secret itself is never shown);
  - public pages: they answer, and none names Victoria's site, domain,
    Google tag or "Victoria, TX";
  - robots.txt and the sitemap point at the town's own host;
  - /events.json answers with at least 10 upcoming events (the hourly
    uptime check's own floor) and a collect in the last 8 days
    (`collected_at`, the candidates auto-publish last put live);
  - /api/config says the town's workflows are on (`town_workflows`:
    "workflows": true in its town.json, set once its GitHub Environment
    exists);
  - towns/<slug>/venues.json is seeded (the collector never borrows
    Victoria's);
  - HQ: /api/hq/summary answers with HQ_API_KEY as this town.

A town that answers but isn't actually collecting fails: an empty site
looks fine page by page.

Then it lists what only a person can check (a test newsletter to
delivered@resend.dev, a Stripe test-mode checkout, a reply landing in
#inbox with the town's tag, HQ showing the town, Victoria's live check).
Exits 1 when any automatic check fails. Victoria isn't a launch: use
scripts/live_check.py for it.
"""
import argparse
import datetime as dt
import json
import os
import sys
import urllib.parse

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
_saved_town = os.environ.pop("TOWN", None)   # the town comes from --town, not the env
import town as town_mod  # noqa: E402
if _saved_town is not None:
    os.environ["TOWN"] = _saved_town
from live_check import fetch  # noqa: E402

PAGES = ["/", "/about", "/privacy", "/advertise", "/subscribe", "/contact", "/submit", "/venues", "/llms.txt"]
# What a page copied from Victoria's would still say.
LEAKS = ["thevic361", "The Vic 361", "Vic 361", "G-52YHD3X3C2", "Victoria, TX", "Victoria, Texas"]

# A launched town needs at least this many events ahead (scripts/
# uptime_check.py alerts below the same number) and a collect this recent.
MIN_UPCOMING = 10
MAX_COLLECT_AGE_DAYS = 8

MANUAL = """
Must be done before launch (MULTI_CITY_PLAN.md; each one blocks a launch):
  [ ] 3.3 the town's GitHub Environment (SITE_URL, Meta, NTFY, cron secrets,
      SLACK_TOWN_TAG), then "workflows": true in its town.json (a PR)
  [ ] 3.4 its own scheduled collects (town matrix, staggered crons,
      fail-fast: false; Event Check gated on the town)
  [ ] 3.5 the workflows' gates call the town's own SITE_URL
  [ ] 3.7 test_workflows.py pins the town inputs (Victoria's crons unchanged)
  [ ] 2.6 Railway watch paths on every service, so one town's commits don't
      redeploy every town (by town #3 at the latest)
  [ ] RAILWAY.md "New town on Railway" followed end to end (fresh secrets)

Check by hand before launch:
  [ ] Admin → Home → Setup: every required item is green. The site doesn't publish
      whether these are set, so check them in Railway: RESEND_API_KEY,
      NEWSLETTER_ADDRESS (a street address or PO box with ZIP, not just the city),
      NEWSLETTER_REPLY_TO, NEWSLETTER_CRON_SECRET (also in the town's GitHub
      Environment) and TURNSTILE_SECRET_KEY
  [ ] The Resend webhook to /api/email/inbound sends email.received, email.bounced
      and email.complained
  [ ] Admin → Newsletter → send a test to delivered@resend.dev (never a real list)
  [ ] A Stripe test-mode checkout on /advertise completes and shows in Admin → Sponsors
  [ ] That checkout page and its receipt show the town's name and logo, not The Vic 361
      (the town has its own Stripe account)
  [ ] A reply to news@ lands in #inbox with the town's [tag]
  [ ] The HQ dashboard shows the town
  [ ] python3 scripts/live_check.py: Victoria unchanged
"""


def _when(raw):
    try:
        t = dt.datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=dt.timezone.utc)


def check(town, site, hq_key="", get=fetch, now=None, venues_path=None):
    """[(ok, what)] for each automatic check."""
    now = now or dt.datetime.now(dt.timezone.utc)
    results = []
    add = lambda ok, what: results.append((bool(ok), what))  # noqa: E731
    host = urllib.parse.urlparse(site).hostname or ""
    slug = town["id"]

    status, _, _, body = get(site + "/api/health?deep=1")
    try:
        health = json.loads(body)
    except ValueError:
        health = {}
    add(status == 200 and health.get("ok") is True, f"health answers ok (HTTP {status})")
    add(health.get("storage") == "postgres", f"runs on its own Postgres (storage: {health.get('storage')})")

    status, _, _, body = get(site + "/api/config")
    try:
        config = json.loads(body)
    except ValueError:
        config = {}
    t = config.get("town") or {}
    add(t.get("id") == slug, f"runs as TOWN={slug} (says {t.get('id')!r})")
    add(t.get("domain") == town["domain"], f"its domain is {town['domain']} (says {t.get('domain')!r})")
    add(config.get("github_events_path") == f"towns/{slug}/public/events.json",
        f"publishes to towns/{slug}/public/events.json (says {config.get('github_events_path')!r})")
    # Until "workflows": true the town starts no collect, social kit, review
    # or event check (server/town.js townWorkflowsReady).
    add(config.get("town_workflows") is True,
        "its workflows are on (\"workflows\": true in town.json, after its GitHub Environment)" +
        ("" if config.get("town_workflows") is True else f" (says {config.get('town_workflows')!r})"))

    if venues_path:
        try:
            with open(venues_path, encoding="utf-8") as f:
                venues = json.load(f)
        except (OSError, ValueError):
            venues = None
        n = len(venues) if isinstance(venues, list) else 0
        add(n > 0, f"towns/{slug}/venues.json is seeded ({n} venue{'s' if n != 1 else ''}"
            + ("" if venues is not None else ", missing or unreadable") + ")")

    # /api/config's public Turnstile flags (the site key is public; only
    # whether a secret is set is said). Without the secret every newsletter
    # signup has to confirm by email and the forms have no bot check.
    add(config.get("turnstile_required") is True and bool(config.get("turnstile_site_key")),
        "Turnstile is on (TURNSTILE_SECRET_KEY and TURNSTILE_SITE_KEY)")

    for path in PAGES:
        status, _, _, body = get(site + path)
        leaks = [w for w in LEAKS if w in body]
        add(status == 200 and not leaks, f"{path} answers without Victoria's name" +
            (f" (HTTP {status})" if status != 200 else "") + (f" (found {', '.join(leaks)})" if leaks else ""))

    status, _, _, body = get(site + "/robots.txt")
    add(status == 200 and f"Sitemap: https://{host}/sitemap.xml" in body and "thevic361" not in body,
        "robots.txt points at its own sitemap")
    status, _, _, body = get(site + "/sitemap.xml")
    add(status == 200 and f"https://{host}/" in body and "thevic361" not in body, "the sitemap lists its own pages")

    status, _, _, body = get(site + "/events.json")
    try:
        feed = json.loads(body)
        ok = status == 200 and isinstance(feed.get("events"), list)
    except (ValueError, AttributeError):
        feed, ok = {}, False
    add(ok, f"/events.json answers (HTTP {status})")
    events = feed.get("events") if ok else []
    today = now.astimezone(town_mod.tz(town)).date().isoformat()
    ahead = sum(1 for e in events if isinstance(e, dict) and str(e.get("date", "")) >= today)
    add(ahead >= MIN_UPCOMING, f"at least {MIN_UPCOMING} upcoming events ({ahead})")
    collected = _when(feed.get("collected_at")) if ok else None
    age = (now - collected).days if collected else None
    add(age is not None and age <= MAX_COLLECT_AGE_DAYS,
        f"a collect in the last {MAX_COLLECT_AGE_DAYS} days (" +
        (f"{age} day{'s' if age != 1 else ''} ago" if age is not None else "no collected_at") + ")")

    if hq_key:
        status, _, _, body = get(site + "/api/hq/summary", headers={"Authorization": f"Bearer {hq_key}"})
        try:
            hq_town = (json.loads(body).get("town") or {}).get("id")
        except (ValueError, AttributeError):
            hq_town = None
        add(status == 200 and hq_town == slug, f"HQ feed answers with HQ_API_KEY as {slug} (HTTP {status})")
    return results


def main(argv=None, get=fetch):
    ap = argparse.ArgumentParser(description="Is a new town ready to launch?")
    ap.add_argument("--town", required=True, help="slug in towns/<slug>/town.json")
    ap.add_argument("--site", help="the live site (default: the town's site_url)")
    ap.add_argument("--towns-dir", default=None)
    args = ap.parse_args(argv)
    args.town = args.town.strip().lower()
    if args.town == "victoria":
        print("Victoria isn't a launch: use scripts/live_check.py.", file=sys.stderr)
        return 2
    try:
        towns_dir = args.towns_dir or os.environ.get("TOWNS_DIR")
        town = town_mod.town_config({"TOWN": args.town, **({"TOWNS_DIR": towns_dir} if towns_dir else {})})
    except ValueError as e:
        print(f"Can't read the town: {e}", file=sys.stderr)
        return 2
    site = (args.site or town["site_url"]).rstrip("/")
    venues_path = os.path.join(towns_dir or os.path.join(ROOT, "towns"), args.town, "venues.json")
    results = check(town, site, os.environ.get("HQ_API_KEY", "").strip(), get=get, venues_path=venues_path)
    print(f"Launch check: {town['site_name']} at {site}")
    for ok, what in results:
        print(f"  {'✅' if ok else '❌'} {what}")
    if not os.environ.get("HQ_API_KEY"):
        print("  (HQ feed not checked: set HQ_API_KEY to the town's key)")
    print(MANUAL)
    failed = sum(1 for ok, _ in results if not ok)
    print(f"{failed} automatic check{'s' if failed != 1 else ''} failed." if failed else "All automatic checks passed.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
