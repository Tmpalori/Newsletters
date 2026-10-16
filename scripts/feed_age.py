#!/usr/bin/env python3
"""Freshness of the live events feed (a manual check; uptime.yml is retired).

    python3 scripts/feed_age.py events.json             days since the last collect (99 when unreadable)
    python3 scripts/feed_age.py --upcoming events.json  events dated today or later in the town (0 when unreadable)

The age uses `collected_at` (the candidates.json auto-publish last put live)
when the feed has it: `last_updated` also moves on every AI-approved
submission or admin edit, which would hide a stalled collector. Older feeds
without it fall back to `last_updated`.
"""
import datetime as dt
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from town import TOWN  # noqa: E402

try:
    from zoneinfo import ZoneInfo
    CENTRAL = ZoneInfo(TOWN["timezone"])  # the town's zone (Central for Victoria)
except Exception:  # noqa: BLE001 - no tz database: close enough
    CENTRAL = dt.timezone(dt.timedelta(hours=-6))


def age_days(path, now=None):
    try:
        with open(path) as f:
            d = json.load(f)
        raw = d.get("collected_at") or d.get("last_updated", "")
        t = dt.datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        if t.tzinfo is None:
            t = t.replace(tzinfo=dt.timezone.utc)
        return ((now or dt.datetime.now(dt.timezone.utc)) - t).days
    except Exception:
        return 99


def upcoming(path, now=None):
    try:
        with open(path) as f:
            events = json.load(f).get("events") or []
        today = (now or dt.datetime.now(dt.timezone.utc)).astimezone(CENTRAL).date().isoformat()
        return sum(1 for e in events if isinstance(e, dict) and str(e.get("date", "")) >= today)
    except Exception:
        return 0


if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "--upcoming":
        print(upcoming(args[1] if len(args) > 1 else "events.json"))
    else:
        print(age_days(args[0] if args else "events.json"))
