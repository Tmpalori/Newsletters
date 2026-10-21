#!/usr/bin/env python3
"""Set up a town's newsletter sections (SECTIONS.md "Turning it on for a town").

    python3 scripts/sections_setup.py detect <url> [<url> ...]
    TOWN=<slug> python3 scripts/sections_setup.py check

detect: opens each page (the shelter's adoptable-pets page, the chamber's
site, the city's agendas page) and says which system it runs on that
scripts/sections.py can read, with the sections.json lines to paste.

check: reads every source in the town's sections.json live, the way the
weekly job does but with no AI and nothing written: how many pets (with a
real photo), new places and agenda items each source gives, and whether
the questions and polls are enough. Exit 1 when something's missing.
"""
import argparse
import json
import os
import re
import sys
from datetime import date

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import sections as s  # noqa: E402

# What a page shows when it runs on a system we can read, and the
# sections.json lines for it.
SIGNS = [
    ("petpoint", r"petango\.com[^\"'<>]*?authkey=([a-z0-9]{20,})", lambda m: {"pets": [{"source": "petpoint", "authkey": m.group(1)}]}),
    ("shelterluv", r"shelterluv\.com/(?:embed|available_pets)/(\d+)", lambda m: {"pets": [{"source": "shelterluv", "gid": m.group(1)}]}),
    ("shelterluv", r"\bGID\s*[:=]\s*[\"']?(\d+)", lambda m: {"pets": [{"source": "shelterluv", "gid": m.group(1)}]}),
    ("24petconnect", r"24petconnect\.com/([A-Za-z0-9]+)", lambda m: {"pets": [{"source": "24petconnect", "code": m.group(1)}]}),
    ("adopets", r"adopets\.(?:com|app)", lambda m: {"pets": [{"source": "adopets", "api_key": "<from the iframe's requests>", "shelter_uuid": "<same>"}]}),
    ("growthzone", r"(https?://[a-z0-9.-]+)/(?:events/calendar|events/details/|members/)", lambda m: {"new_in_town": {"source": "growthzone_ribbons", "base": m.group(1)}}),
    ("civicclerk", r"([a-z0-9]+)\.portal\.civicclerk\.com", lambda m: {"good_news": {"sources": [{"source": "civicclerk", "client": m.group(1), "body": "<the body, e.g. City Council>"}]}}),
    ("granicus", r"([a-z0-9]+)\.granicus\.com", lambda m: {"good_news": {"sources": [{"source": "granicus", "client": m.group(1), "view_id": 1, "match": "Council", "body": "City Council"}]}}),
    ("cablecast", r"(https?://[a-z0-9.-]+)/CablecastAPI", lambda m: {"good_news": {"sources": [{"source": "cablecast", "api": m.group(1) + "/CablecastAPI/v1"}]}}),
]


def detect(urls, get=None):
    """[(url, system, sections.json lines)] for each sign found on each page."""
    get = get or s.get
    found = []
    for url in urls:
        try:
            page = get(url).text
        except Exception as e:  # noqa: BLE001 - say which page failed, go on
            found.append((url, f"couldn't open it ({type(e).__name__})", None))
            continue
        seen = set()
        for name, pattern, lines in SIGNS:
            m = re.search(pattern, page, re.I)
            if m and name not in seen:
                seen.add(name)
                found.append((url, name, lines(m)))
        if not seen:
            found.append((url, "nothing we read yet", None))
    return found


def check(config, today=None):
    """(ok, report lines): every source read live, no AI."""
    today = today or date.today()
    lines, ok = [], True
    for src in config.get("pets") or []:
        reader = s.PET_READERS.get(src.get("source"))
        if not reader:
            lines.append(f"✗ pets: {src.get('name') or '?'}: no reader for source {src.get('source')!r}")
            ok = False
            continue
        try:
            pets = [p for p in reader(src) if p.get("photo_url") and not s.PLACEHOLDER_PHOTO.search(p.get("photo_url", ""))]
            lines.append(f"{'✓' if pets else '✗'} pets: {src.get('name') or src['source']}: {len(pets)} with a real photo"
                         + (f" (e.g. {', '.join(p['name'] for p in pets[:3])})" if pets else ""))
            ok = ok and bool(pets)
        except Exception as e:  # noqa: BLE001
            lines.append(f"✗ pets: {src.get('name') or src['source']}: failed ({type(e).__name__}: {e})")
            ok = False
    if not config.get("pets"):
        lines.append("✗ pets: no shelter in sections.json")
        ok = False
    src = config.get("new_in_town") or {}
    reader = s.NEW_READERS.get(src.get("source"))
    if not reader:
        lines.append("– new in town: no source (the section stays empty)")
    else:
        try:
            places = reader(src, today)
            lines.append(f"✓ new in town: {len(places)} candidates (the AI editor keeps the real new spots)"
                         + (f" (e.g. {', '.join(x['name'] or x['raw'][:40] for x in places[:3])})" if places else ""))
        except Exception as e:  # noqa: BLE001
            lines.append(f"✗ new in town: failed ({type(e).__name__}: {e})")
            ok = False
    for src in (config.get("good_news") or {}).get("sources") or []:
        reader = s.AGENDA_READERS.get(src.get("source"))
        if not reader:
            lines.append(f"✗ city hall: no reader for source {src.get('source')!r}")
            ok = False
            continue
        try:
            agendas = reader(src, today)
            size = sum(len(a.get("items") or []) + (1 if a.get("text") else 0) for a in agendas)
            lines.append(f"✓ city hall: {src.get('body', src['source'])}: {len(agendas)} agenda(s), {size} parts to read")
        except Exception as e:  # noqa: BLE001
            lines.append(f"✗ city hall: {src.get('body', src['source'])}: failed ({type(e).__name__}: {e})")
            ok = False
    if not (config.get("good_news") or {}).get("sources"):
        lines.append("– city hall: no source (the section stays empty)")
    qs = [q for q in config.get("questions") or [] if isinstance(q, str) and q.strip()]
    polls = [p for p in config.get("polls") or [] if isinstance(p, dict) and p.get("id") and p.get("question") and len(p.get("choices") or []) >= 2]
    lines.append(f"{'✓' if len(qs) >= 8 else '✗'} questions: {len(qs)} (8 or more; the AI writes new ones monthly)")
    lines.append(f"{'✓' if len(polls) >= 3 else '✗'} polls: {len(polls)} (3 or more)")
    ok = ok and len(qs) >= 8 and len(polls) >= 3
    lines.append(f"enabled: {config.get('enabled') is True} (true only after the owner's OK)")
    return ok, lines


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("detect", help="which system each page runs on")
    d.add_argument("urls", nargs="+")
    sub.add_parser("check", help="read every source in the town's sections.json live")
    args = ap.parse_args(argv)
    if args.cmd == "detect":
        for url, name, lines in detect(args.urls):
            print(f"{url}\n  {name}" + (f"\n  {json.dumps(lines)}" if lines else ""))
        return 0
    config = s.load_config()
    if not config:
        print(f"{s.TOWN['id']}: no sections.json (scripts/new_town.py writes one)")
        return 1
    ok, lines = check(config)
    print(f"{s.TOWN['site_name']} ({s.TOWN['id']})")
    print("\n".join(lines))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
