#!/usr/bin/env python3
"""Try candidate Apify actors against Victoria, TX and report what they return.

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

# Facebook groups probe: set to a town slug to run that town's group scraper
# (collect_events.fetch_apify_facebook_groups) instead of the actors above,
# logging every post the groups actor returns and the events extracted.
# About $0.007 a post (30 a group). Set back to "" when done.
GROUPS_TOWN = "victoria,lincoln,shoals,virginiabeach,medford"
# Raw-only runs (no OPENAI_API_KEY): posts per group and how many groups.
GROUPS_RAW_POSTS = 15
GROUPS_RAW_GROUPS = 1

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


def _gemini_chat(ce):
    """collect_events._openai_chat on Gemini's OpenAI-compatible endpoint, for
    a probe run where only GEMINI_API_KEY is set (GitHub's secrets)."""
    def chat(api_key, messages, max_tokens, timeout=60):
        resp = requests.post("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
                             headers={"Authorization": f"Bearer {api_key}"},
                             json={"model": ce._GEMINI_DEFAULT_MODEL, "messages": messages,
                                   "max_tokens": max_tokens, "reasoning_effort": "low"},
                             timeout=max(timeout, 120))
        resp.raise_for_status()
        return (resp.json()["choices"][0]["message"].get("content") or "").strip()
    return chat


def groups_probe(town):
    """Run the town's Facebook groups through the real collector code; log the
    raw posts (text, shared-post previews, images) and the events found.
    Several towns (comma-separated) run one process each: the collector reads
    TOWN when it's imported."""
    if "," in town:
        import subprocess
        for t in town.split(","):
            subprocess.run([sys.executable, os.path.abspath(__file__)], env={**os.environ, "PROBE_GROUPS_TOWN": t})
        return
    os.environ["TOWN"] = town
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    import collect_events as ce
    if not os.environ.get("OPENAI_API_KEY") and os.environ.get("GEMINI_API_KEY"):
        os.environ["OPENAI_API_KEY"] = os.environ["GEMINI_API_KEY"]
        ce._openai_chat = _gemini_chat(ce)
        print(f"Extraction on Gemini ({ce._GEMINI_DEFAULT_MODEL}) with the collector's prompt")

    raw = {}
    real_run = ce._apify_posts_run

    def recording_run(url, payload, token):
        resp = real_run(url, payload, token)
        try:
            raw[payload["startUrls"][0]["url"]] = resp.json()
        except Exception:
            raw[payload["startUrls"][0]["url"]] = {"status": resp.status_code, "body": resp.text[:500]}
        return resp

    ce._apify_posts_run = recording_run
    groups = ce._town_facebook_groups()
    if os.environ.get("OPENAI_API_KEY"):
        events = ce.fetch_apify_facebook_groups()
    else:
        print("No OPENAI_API_KEY: raw posts only, no event extraction")
        events = []
        since = (ce.datetime.now().date() - ce.timedelta(days=ce._GROUP_LOOKBACK_DAYS)).strftime("%Y-%m-%d")
        for g in groups[:GROUPS_RAW_GROUPS]:
            recording_run(ce._apify_run_url(ce.APIFY_FB_GROUPS_ACTOR),
                          {"startUrls": [{"url": g["url"]}], "resultsLimit": GROUPS_RAW_POSTS,
                           "viewOption": "CHRONOLOGICAL", "onlyPostsNewerThan": since}, TOKEN)
    print(f"\n══════ {town}: {len(groups)} groups")
    report = {"town": town, "groups": groups, "events": events, "posts": {}}
    for url, posts in raw.items():
        print(f"\n━━━ {url}")
        if not isinstance(posts, list):
            print("  ✗", json.dumps(posts)[:500])
            report["posts"][url] = posts
            continue
        keys = sorted({k for p in posts if isinstance(p, dict) for k in p})
        print(f"  {len(posts)} items; fields: {', '.join(keys)[:600]}")
        rows = []
        for p in posts:
            if not isinstance(p, dict):
                continue
            g = ce._group_post(p)
            row = {"url": p.get("url"), "time": p.get("time"), "error": p.get("error"),
                   "text": (g.get("text") or "")[:600], "images": ce._post_image_urls(g)[:3],
                   "raw_preview": {k: p.get(k) for k in ("title", "previewTitle", "previewDescription", "previewSource",
                                                         "link", "location", "isVideo") if p.get(k)}}
            if not p.get("text") or "isn't available" in row["text"]:
                # A share with no caption: what the actor gives for the shared post.
                row["raw"] = {k: v for k, v in p.items() if k not in ("topComments", "user", "collaborators")}
            rows.append(row)
            if not events:
                print("  •", json.dumps(row, ensure_ascii=False)[:3000])
        report["posts"][url] = rows
    print(f"\nEVENTS {town} ({len(events)})")
    for e in sorted(events, key=lambda e: e["date"]):
        print(f"  EV|{town}|{e['date']}|{e.get('time') or ''}|{e['name']}|{e.get('venue') or '-'}|{e.get('address') or ''}"
              f"|{'R' if e.get('recurring') else ''}|{e.get('url')}")
    with open(f"apify_probe_report_{town}.json", "w") as f:
        json.dump(report, f, indent=2, ensure_ascii=False, default=str)


def main():
    if not TOKEN:
        sys.exit("APIFY_TOKEN not set")
    if os.environ.get("PROBE_GROUPS_TOWN") or GROUPS_TOWN:
        return groups_probe(os.environ.get("PROBE_GROUPS_TOWN") or GROUPS_TOWN)
    only = [a.strip() for a in os.environ.get("PROBE_ACTORS", "").split(",") if a.strip()]
    report = {}
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
        print(f"  {a}: " + (r.get("error") or f"{r['items']} items, {r['victoria']} Victoria, ${r['usd']}"))


if __name__ == "__main__":
    main()
