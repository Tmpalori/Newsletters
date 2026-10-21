#!/usr/bin/env python3
"""Try candidate Apify actors against Victoria, TX and report what they return,
and check every town's Facebook groups (town.json "facebookGroups") with the
collector's groups scraper: public and readable, or a dead end (private,
login-walled, nothing readable). PROBE_ACTORS=groups runs only that check.

Manual-only (see .github/workflows/apify-probe.yml). Nothing is committed:
the report goes to the job log and a JSON artifact. Each actor runs with a
small item cap so a probe costs cents.

For each actor we fetch its input schema, start from the schema's prefill
values, then override the fields that look like a search query, location
or limit. The schema is printed too, so a bad guess is easy to fix.
"""
import json
import os
import re
import sys
import time

import requests

TOKEN = os.environ.get("APIFY_TOKEN", "").strip()
API = "https://api.apify.com/v2"
MAX_ITEMS = int(os.environ.get("PROBE_MAX_ITEMS") or "40")

QUERY = "events in Victoria, TX"
CITY = "Victoria, TX"

# actor id → extra input overrides (applied after the generic guesses)
# Round 1 (run 37127809936) measured, kept for reference:
#   apify/facebook-events-scraper   40 items, 39 Victoria, $0.39
#   khadinakbar/eventbrite-events-scraper  40 items, 26 Victoria, $0.20, rich fields
#   datapilot/eventbrite-events-scraper    20 items, 20 Victoria, $0.04, title/date/link only
#   bandsintown actors: artist-only, no city search. Dropped.
# actor id → extra input overrides (applied after the generic guesses)
ACTORS = {
    "muhammadafzal/google-events": {"searchQueries": ["events in Victoria TX", "things to do in Victoria Texas"],
                                    "location": "Victoria, Texas, United States", "dateFilter": "this_month"},
    "codingfrontend/google-events-scraper": {"maxRequestRetries": 3, "dateFilter": "this_month",
                                             "location": "Victoria, Texas, United States", "gl": "us", "hl": "en"},
    # Round 2: alfalfa/facebook-events-scraper 40 items, 31 Victoria, different set from apify's.
    # Round 3: codingfrontend/google-events-scraper 4 items; muhammadafzal/google-events 0. Not worth adding.
}

VICTORIA_RE = re.compile(r"victoria,?\s*(tx|texas)|\b7790[145]\b", re.I)


def guess_input(schema):
    props = (schema or {}).get("properties", {}) or {}
    inp = {}
    for name, spec in props.items():
        if "prefill" in spec:
            inp[name] = spec["prefill"]
        elif "default" in spec:
            inp[name] = spec["default"]
    for name, spec in props.items():
        n = name.lower()
        typ = spec.get("type")
        if re.search(r"items|events|results|limit", n) and typ == "integer" \
                and not re.search(r"retr|concurr|delay|timeout", n):
            inp[name] = min(MAX_ITEMS, spec.get("maximum", MAX_ITEMS))
        elif re.search(r"quer|search|keyword|term", n):
            inp[name] = [QUERY] if typ == "array" else QUERY
        elif re.search(r"city|location|place|near|where", n) and typ in ("string", None):
            inp[name] = CITY
        elif re.search(r"city|location", n) and typ == "array":
            inp[name] = [CITY]
        elif re.search(r"country", n) and typ == "string":
            inp[name] = spec.get("prefill") or "US"
        elif re.search(r"future|upcoming", n) and typ == "boolean":
            inp[name] = True
        elif re.search(r"proxy", n):
            inp.setdefault(name, {"useApifyProxy": True})
    return inp


def actor_schema(actor):
    aid = actor.replace("/", "~")
    r = requests.get(f"{API}/acts/{aid}", params={"token": TOKEN}, timeout=30)
    if r.status_code != 200:
        return None, f"actor lookup HTTP {r.status_code}"
    data = r.json().get("data", {})
    build_tag = (data.get("defaultRunOptions") or {}).get("build", "latest")
    build_id = (data.get("taggedBuilds") or {}).get(build_tag, {}).get("buildId")
    if not build_id:
        return {}, None
    b = requests.get(f"{API}/actor-builds/{build_id}", params={"token": TOKEN}, timeout=30)
    raw = (b.json().get("data") or {}).get("inputSchema") if b.status_code == 200 else None
    try:
        return (json.loads(raw) if isinstance(raw, str) else (raw or {})), None
    except ValueError:
        return {}, None


def run_actor(actor, inp):
    aid = actor.replace("/", "~")
    r = requests.post(f"{API}/acts/{aid}/runs", params={"token": TOKEN, "maxItems": MAX_ITEMS},
                      json=inp, timeout=60)
    if r.status_code not in (200, 201):
        return None, f"start HTTP {r.status_code}: {r.text[:300]}"
    run = r.json()["data"]
    deadline = time.time() + 300
    while run["status"] in ("READY", "RUNNING") and time.time() < deadline:
        time.sleep(10)
        run = requests.get(f"{API}/actor-runs/{run['id']}", params={"token": TOKEN}, timeout=30).json()["data"]
    if run["status"] in ("READY", "RUNNING"):
        requests.post(f"{API}/actor-runs/{run['id']}/abort", params={"token": TOKEN}, timeout=30)
        return {"status": "TIMEOUT", "items": [], "usd": None}, None
    items = requests.get(f"{API}/datasets/{run['defaultDatasetId']}/items",
                         params={"token": TOKEN, "clean": "true", "limit": MAX_ITEMS}, timeout=60).json()
    return {"status": run["status"], "items": items if isinstance(items, list) else [],
            "usd": run.get("usageTotalUsd")}, None


GROUPS_ACTOR = "apify/facebook-groups-scraper"
GROUP_POSTS = 5
DEAD_RE = re.compile(r"private|log ?in|sign ?in|join|members? only|not available|isn'?t available|"
                     r"no access|permission|restricted", re.I)


def town_groups():
    """[(town, group url)] for Victoria and every towns/*/town.json."""
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    sys.path.insert(0, root)
    from town import VICTORIA
    out = [("victoria", g["url"]) for g in VICTORIA.get("facebook_groups") or []]
    towns = os.path.join(root, "towns")
    for slug in sorted(os.listdir(towns)):
        try:
            with open(os.path.join(towns, slug, "town.json")) as f:
                out += [(slug, g["url"]) for g in json.load(f).get("facebookGroups") or []]
        except (OSError, ValueError, KeyError, TypeError):
            continue
    return out


def probe_groups():
    """Each town's groups: readable (posts come back) or a dead end."""
    print(f"\n━━━ {GROUPS_ACTOR} (every town's facebookGroups)")
    schema, err = actor_schema(GROUPS_ACTOR)
    if err:
        print(f"  ✗ {err}")
        return {"error": err}
    print("  input fields:", ", ".join(f"{k}:{v.get('type')}" for k, v in (schema or {}).get("properties", {}).items())[:600])
    rows = []
    for town, url in town_groups():
        inp = {"startUrls": [{"url": url}], "resultsLimit": GROUP_POSTS, "viewOption": "CHRONOLOGICAL"}
        res, err = run_actor(GROUPS_ACTOR, inp)
        if err:
            rows.append({"town": town, "url": url, "verdict": "error", "why": err})
            print(f"  {town:14} {url}  ERROR {err[:120]}")
            continue
        items = [i for i in res["items"] if isinstance(i, dict)]
        errors = [f"{i.get('error')} {i.get('errorDescription') or ''}".strip() for i in items if i.get("error")]
        posts = [i for i in items if not i.get("error") and (i.get("text") or i.get("attachments") or i.get("media"))]
        title = next((str(i.get("groupTitle") or "") for i in items if i.get("groupTitle")), "")
        if posts:
            verdict, why = "public", f"{len(posts)} posts read"
        elif errors and DEAD_RE.search(errors[0]):
            verdict, why = "private", errors[0][:200]
        else:
            verdict, why = "dead end", (errors[0][:200] if errors else f"no posts (run {res['status']})")
        rows.append({"town": town, "url": url, "title": title, "verdict": verdict, "why": why, "usd": res["usd"],
                     "fields": sorted({k for i in items for k in i})[:40]})
        print(f"  {town:14} {url}  {verdict.upper()}  {title[:50]!r}  {why[:100]}  ${res['usd']}")
        if posts:
            print("    sample:", json.dumps(posts[0], ensure_ascii=False)[:400])
    print("\nGROUPS: dead ends")
    for r in rows:
        if r["verdict"] != "public":
            print(f"  {r['town']}: {r['url']} ({r['verdict']}: {r['why'][:120]})")
    return {"groups": rows}


def main():
    if not TOKEN:
        sys.exit("APIFY_TOKEN not set")
    only = [a.strip() for a in os.environ.get("PROBE_ACTORS", "").split(",") if a.strip()]
    report = {}
    if not only or "groups" in only:
        report[GROUPS_ACTOR] = probe_groups()
    for actor, overrides in ACTORS.items():
        if only and actor not in only:
            continue
        print(f"\n━━━ {actor}")
        schema, err = actor_schema(actor)
        if err:
            print(f"  ✗ {err}")
            report[actor] = {"error": err}
            continue
        props = (schema or {}).get("properties", {})
        print("  input fields:", ", ".join(f"{k}:{v.get('type')}" for k, v in props.items())[:600])
        inp = guess_input(schema)
        inp.update(overrides)
        print("  input used:", json.dumps(inp)[:600])
        res, err = run_actor(actor, inp)
        if err:
            print(f"  ✗ {err}")
            report[actor] = {"error": err, "input": inp}
            continue
        items = res["items"]
        local = [i for i in items if VICTORIA_RE.search(json.dumps(i))]
        keys = sorted({k for i in items[:20] if isinstance(i, dict) for k in i})
        print(f"  status={res['status']} items={len(items)} victoria_mentions={len(local)} cost_usd={res['usd']}")
        print("  fields:", ", ".join(keys)[:500])
        for i in (local or items)[:4]:
            print("  sample:", json.dumps(i, ensure_ascii=False)[:500])
        report[actor] = {"status": res["status"], "items": len(items), "victoria": len(local),
                         "usd": res["usd"], "fields": keys, "input": inp, "samples": (local or items)[:10]}
    with open("apify_probe_report.json", "w") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    print("\nSUMMARY")
    for a, r in report.items():
        if "groups" in r:
            print(f"  {a}: " + ", ".join(f"{g['town']} {g['url'].rstrip('/').rsplit('/', 1)[-1]} {g['verdict']}" for g in r["groups"]))
            continue
        print(f"  {a}: " + (r.get("error") or f"{r['items']} items, {r['victoria']} Victoria, ${r['usd']}"))


if __name__ == "__main__":
    main()
