#!/usr/bin/env python3
"""Is a town's Facebook groups list worth its Apify time? A dry run.

Manual-only (the Apify Probe workflow runs it for every town after the
probe). For each public group in the town's town.json "facebookGroups" it
scrapes posts exactly as the collector does (fetch_apify_facebook_groups:
same actor, input and post filter), builds the collector's own extraction
request (_posts_prompt with _group_events_prompt), and asks it twice: the
post text alone, and the text with the flyer pictures. The events get the
collector's date check (_post_event_dates) and are matched against the
town's live /events.json with the collector's is_same_event, so "new" means
the site doesn't list it yet.

The extraction here runs on Gemini (the GitHub secret; the collector's
OpenAI key lives on Railway only), so counts are a close stand-in, not the
collector's exact output. Nothing is written to any site: the report goes
to the log and groups_trial_<town>.json.

    TOWN=tupelo APIFY_TOKEN=… GEMINI_API_KEY=… python scripts/groups_trial.py
"""
import base64
import json
import os
import re
import sys
import time

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import collect_events as ce  # noqa: E402
from town import TOWN, site_url  # noqa: E402

APIFY = os.environ.get("APIFY_TOKEN", "").strip()
GEMINI = os.environ.get("GEMINI_API_KEY", "").strip()
MODEL = os.environ.get("GEMINI_MODEL", "").strip() or ce._GEMINI_DEFAULT_MODEL


def gemini(parts):
    """One Gemini call on the collector's request; the parsed array or None."""
    body = {"contents": [{"role": "user", "parts": parts}],
            "generationConfig": {"temperature": 0, "maxOutputTokens": 16000}}
    for attempt in range(2):
        try:
            r = requests.post(ce.GEMINI_URL.format(model=MODEL), json=body, timeout=180,
                              headers={"x-goog-api-key": GEMINI, "Content-Type": "application/json"})
        except requests.RequestException as e:
            print(f"    gemini error {type(e).__name__}")
            continue
        if r.status_code in (429, 500, 503) and attempt == 0:
            time.sleep(20)
            continue
        if r.status_code != 200:
            print(f"    gemini HTTP {r.status_code}: {r.text[:200]}")
            return None
        cand = (r.json().get("candidates") or [{}])[0]
        text = "".join(p.get("text", "") for p in (cand.get("content") or {}).get("parts") or [])
        text = re.sub(r"^```\w*\s*|\s*```\s*$", "", text.strip())
        return ce._parse_ai_json_array(text)
    return None


def to_gemini(content_parts):
    """OpenAI-style content parts (text, image_url data URLs) → Gemini parts."""
    out = []
    for p in content_parts:
        if p["type"] == "text":
            out.append({"text": p["text"]})
        else:
            head, data = p["image_url"]["url"].split(",", 1)
            out.append({"inline_data": {"mime_type": head[5:].split(";")[0], "data": data}})
    return out


def dated(raw, group_url, posts):
    """The collector's handling of the model's answer: date check, one per (date, name)."""
    out, seen = [], set()
    for r in raw or []:
        if not isinstance(r, dict):
            continue
        name = re.sub(r"\s+", " ", str(r.get("name") or "")).strip()
        for d in (ce._post_event_dates(r, ce._WINDOW_START, ce._WINDOW_END) if name else []):
            if (d, name.lower()) in seen:
                continue
            seen.add((d, name.lower()))
            idx = r.get("source_post_index")
            url = ce._group_post_url(posts[idx - 1], group_url) if isinstance(idx, int) and 1 <= idx <= len(posts) else group_url
            out.append({"date": d.isoformat(), "name": name, "time": str(r.get("time") or "").strip(),
                        "venue": str(r.get("venue") or "").strip(), "url": url,
                        "recurring": r.get("recurring") is True, "_source": "apify_facebook_groups"})
    return out


def main():
    if not APIFY or not GEMINI:
        sys.exit("APIFY_TOKEN and GEMINI_API_KEY are both needed")
    os.environ["FLYER_IMAGES"] = "1"
    ce._WINDOW_START, ce._WINDOW_END = ce.date_window(days_ahead=14, backfill_to_monday=False)
    try:
        live = requests.get(site_url() + "/events.json", timeout=30).json().get("events") or []
    except Exception as e:
        sys.exit(f"can't read the live events.json: {e}")
    live = [e for e in live if ce._WINDOW_START.isoformat() <= str(e.get("date")) <= ce._WINDOW_END.isoformat()]
    print(f"\n═══ {TOWN['site_name']} ({TOWN['id']}): window {ce._WINDOW_START} → {ce._WINDOW_END}, "
          f"{len(live)} live events in it")

    newer_than = (ce.datetime.now().date() - ce.timedelta(days=ce._GROUP_POSTS_LOOKBACK_DAYS)).strftime("%Y-%m-%d")
    run_url = ce._apify_run_url(ce.APIFY_FB_GROUPS_ACTOR)
    report, town_found = {"town": TOWN["id"], "live_in_window": len(live), "groups": []}, []
    for g in TOWN.get("facebook_groups") or []:
        url = g["url"]
        payload = {"startUrls": [{"url": url}], "resultsLimit": ce._GROUP_POSTS_PER_GROUP,
                   "viewOption": "CHRONOLOGICAL", "onlyPostsNewerThan": newer_than}
        try:
            resp = ce._apify_posts_run(run_url, payload, APIFY)
            items = resp.json() if resp.status_code < 400 else []
        except Exception as e:
            print(f"\n── {url}: scrape failed ({type(e).__name__})")
            report["groups"].append({"url": url, "error": type(e).__name__})
            continue
        items = items if isinstance(items, list) else []
        posts = [p for p in items if isinstance(p, dict) and not p.get("error") and (p.get("text") or ce._post_image_urls(p))]
        title = next((str(p.get("groupTitle")) for p in items if isinstance(p, dict) and p.get("groupTitle")), url)
        with_img = [p for p in posts if ce._post_image_urls(p)]
        img_only = [p for p in with_img if not str(p.get("text") or "").strip()]
        print(f"\n── {title}  {url}")
        print(f"   {len(posts)} posts in {ce._GROUP_POSTS_LOOKBACK_DAYS} days; {len(with_img)} with pictures, "
              f"{len(img_only)} pictures with no text")
        if not posts:
            errs = [str(p.get("errorDescription") or p.get("error")) for p in items if isinstance(p, dict) and p.get("error")]
            print(f"   nothing readable: {errs[:1] or 'no posts'}")
            report["groups"].append({"url": url, "title": title, "posts": 0, "why": errs[:1]})
            continue
        if with_img:   # how the scraper gives pictures, to check _post_image_urls reads them
            shape = {k: (sorted(v[0].keys()) if isinstance(v, list) and v and isinstance(v[0], dict) else type(v).__name__)
                     for k, v in with_img[0].items() if k in ("attachments", "media", "images")}
            print(f"   picture fields: {json.dumps(shape)[:300]}")

        text_prompt, parts = ce._posts_prompt(title, posts, ce._group_events_prompt, ce.FLYER_IMAGES_PER_GROUP)
        text_only = dated(gemini([{"text": text_prompt}]), url, posts) if text_prompt else []
        with_pics = dated(gemini(to_gemini(parts)), url, posts) if parts else text_only
        flyers = sum(1 for p in (parts or []) if p["type"] == "image_url")
        new = [e for e in with_pics if not any(ce.is_same_event(e, {**l, "_source": l.get("_source") or "live"}) for l in live)]
        print(f"   events: {len(text_only)} from text alone, {len(with_pics)} with {flyers} pictures read; "
              f"{len(new)} not on the site yet")
        for e in new[:12]:
            print(f"     + {e['date']} {e['time'] or '(no time)':10} {e['name'][:60]}" + (f" @ {e['venue'][:40]}" if e["venue"] else ""))
        town_found += [{**e, "group": title} for e in new]
        report["groups"].append({"url": url, "title": title, "posts": len(posts), "with_pictures": len(with_img),
                                 "pictures_only": len(img_only), "flyers_read": flyers, "events_text_only": len(text_only),
                                 "events_with_pictures": len(with_pics), "new": len(new), "new_events": new})

    # One event in two groups counts once (the collector keeps one).
    distinct = []
    for e in town_found:
        if not any(ce.is_same_event(e, d) for d in distinct):
            distinct.append(e)
    report["new_distinct"] = len(distinct)
    print(f"\n   TOWN TOTAL: {len(distinct)} new events across its groups (after cross-group dedupe), "
          f"vs {len(live)} live in the window")
    with open(f"groups_trial_{TOWN['id']}.json", "w") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)


if __name__ == "__main__":
    main()
