#!/usr/bin/env python3
"""Each town's upcoming events, to write the next batch of video scripts from.

    python3 events.py                          # next week (Mon-Sun), every town
    python3 events.py --when weekend           # this coming weekend (Fri-Sun)
    python3 events.py --town lincoln --from 2026-11-06 --to 2026-11-08
    python3 events.py --all --json             # keep the weekly regulars, as JSON

The sites already publish these as pages with schema.org Event JSON-LD,
the data search engines read: /next-week (Monday to Sunday of the coming
week; on a Sunday, the week that starts tomorrow) and /this-weekend. So
this needs no admin key and shows exactly what readers see. It prints
markdown grouped by town and day: time, name, venue, FREE when the price
is 0, the start of the description, and the event's own page, which is
where every fact in a script gets checked before Tristen says it on camera.

Weekly regulars (bingo, story time, trivia, open mics...) are left out by
default: they're true every week, so they make weak hooks. --all keeps
them.
"""
import argparse
import datetime as dt
import html
import json
import re
import sys

import requests

import towns

PAGES = {"week": "/next-week", "weekend": "/this-weekend"}
TIMEOUT = 30
EVENT_TYPES = {"Event", "MusicEvent", "Festival", "SportsEvent", "TheaterEvent", "ChildrensEvent",
               "FoodEvent", "SocialEvent", "ExhibitionEvent", "ComedyEvent", "DanceEvent",
               "EducationEvent", "LiteraryEvent", "ScreeningEvent", "VisualArtsEvent"}
REGULAR = re.compile(
    r"\b(bingo|story ?time|storytime|pickleball|karaoke|trivia|open mic|toddler|bab(?:y|ies)|"
    r"rhyme time|playgroup|play group|open play|yoga|happy hour|gift shop|indoor playground|"
    r"crafternoons?|lap ?sit|preschool|book club|run club|walking group|winter hours|"
    r"early dine|half-priced?|wednesdays? special|kids eat)\b", re.I)
JSON_LD = re.compile(r'<script type="application/ld\+json">(.*?)</script>', re.S)


class EventsError(RuntimeError):
    pass


def _types(x):
    t = x.get("@type")
    return set(t) if isinstance(t, list) else {t}


def parse_events(page):
    """Every Event in the page's JSON-LD, however it's nested (ItemList,
    @graph...), as plain dicts, deduped by day and name, in start order."""
    found = []
    for m in JSON_LD.finditer(page):
        try:
            data = json.loads(m.group(1))
        except ValueError:
            continue
        stack = [data]
        while stack:
            x = stack.pop()
            if isinstance(x, list):
                stack.extend(x)
            elif isinstance(x, dict):
                if _types(x) & EVENT_TYPES and x.get("startDate") and x.get("name"):
                    found.append(_event(x))
                stack.extend(v for v in x.values() if isinstance(v, (dict, list)))
    seen, out = set(), []
    for e in sorted(found, key=lambda e: (e["start"], e["name"])):
        key = (e["start"][:10], e["name"].lower())
        if key not in seen:
            seen.add(key)
            out.append(e)
    return out


def _event(x):
    loc = x.get("location") or {}
    if isinstance(loc, list):
        loc = loc[0] if loc else {}
    offers = x.get("offers")
    if isinstance(offers, list):
        offers = offers[0] if offers else None
    price = offers.get("price") if isinstance(offers, dict) else None
    return {
        "start": str(x["startDate"]),
        "name": html.unescape(str(x["name"])).strip(),
        "venue": html.unescape(str(loc.get("name") or "")).strip() if isinstance(loc, dict) else "",
        "free": str(price).strip() in ("0", "0.0", "0.00"),
        "description": html.unescape(str(x.get("description") or "")).strip(),
        "url": str(x.get("url") or ""),
    }


def day_of(e):
    return dt.date.fromisoformat(e["start"][:10])


def time_of(e):
    """"7:30 PM", or "" for an all-day listing (a date with no time)."""
    if len(e["start"]) <= 10:
        return ""
    try:
        t = dt.datetime.fromisoformat(e["start"])
    except ValueError:
        return ""
    return t.strftime("%I:%M %p").lstrip("0")


def fetch(session, slug, when):
    t = towns.town(slug)
    url = t["site_url"] + PAGES[when]
    try:
        r = session.get(url, timeout=TIMEOUT, headers={"User-Agent": "town-videos events.py"})
    except requests.RequestException as e:
        raise EventsError(f"{t['name']}: couldn't reach {url} ({type(e).__name__})") from None
    if r.status_code != 200:
        raise EventsError(f"{t['name']}: {url} answered {r.status_code}")
    return url, parse_events(r.text)


def pick(events, keep_regulars=False, start=None, end=None):
    out = []
    for e in events:
        d = day_of(e)
        if (start and d < start) or (end and d > end):
            continue
        if not keep_regulars and REGULAR.search(e["name"]):
            continue
        out.append(e)
    return out


def markdown(slug, url, events, total):
    t = towns.town(slug)
    lines = [f"## {t['name']} ({t['city']}): {len(events)} events"
             + (f" ({total - len(events)} regulars or out-of-range left out)" if total > len(events) else ""),
             url, ""]
    day = None
    for e in events:
        d = day_of(e)
        if d != day:
            day = d
            lines += ["", f"### {d:%a %b} {d.day}"]
        desc = e["description"]
        desc = desc if len(desc) <= 140 else desc[:137].rstrip() + "..."
        bits = [b for b in (time_of(e), e["name"], e["venue"], "FREE" if e["free"] else "", desc) if b]
        lines.append("- " + " · ".join(bits) + (f" <{e['url']}>" if e["url"] else ""))
    return "\n".join(lines).strip() + "\n"


def main(argv=None, session=None):
    ap = argparse.ArgumentParser(description="Upcoming events per town, for writing video scripts.")
    ap.add_argument("--town", choices=sorted(towns.TOWNS), help="one town (default: all five)")
    ap.add_argument("--when", choices=sorted(PAGES), default="week",
                    help="week = the site's /next-week (default); weekend = /this-weekend")
    ap.add_argument("--from", dest="start", type=dt.date.fromisoformat, help="first day, YYYY-MM-DD")
    ap.add_argument("--to", dest="end", type=dt.date.fromisoformat, help="last day, YYYY-MM-DD")
    ap.add_argument("--all", action="store_true", help="keep the weekly regulars")
    ap.add_argument("--json", action="store_true", help="JSON instead of markdown")
    args = ap.parse_args(argv)

    session = session or requests.Session()
    result, failed = {}, 0
    for slug in [args.town] if args.town else list(towns.TOWNS):
        try:
            url, events = fetch(session, slug, args.when)
        except EventsError as e:
            print(f"events: {e}", file=sys.stderr)
            failed += 1
            continue
        kept = pick(events, args.all, args.start, args.end)
        result[slug] = {"url": url, "total": len(events), "events": kept}
        if not args.json:
            print(markdown(slug, url, kept, len(events)))
    if args.json:
        json.dump(result, sys.stdout, indent=2)
        print()
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
