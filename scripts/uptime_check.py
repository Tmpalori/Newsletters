#!/usr/bin/env python3
"""Is a town's site up? A manual check now: uptime.yml is retired, and HQ
and each site's hourly check watch health on their own.

Down means any of: the homepage, /api/health?deep=1 (the server and its
database) or /events.json doesn't answer 200 within TIMEOUT seconds, answers
slower than SLOW seconds, or the feed has no events. One retry RETRY_WAIT
seconds later, so a deploy restart isn't an alert.

Alerts go to Slack (SLACK_WEBHOOK_URL) and, when NTFY_TOPIC is set, as a
high-priority push to the ntfy phone app. The first failure alerts at once,
then a reminder every REMIND_MIN while it stays down, then one "back up"
message. STATE_FILE carries that between runs.
Exits 1 while down, so the run is red too.

    python3 scripts/uptime_check.py https://www.thevic361.com [state.json]
"""
import datetime as dt
import json
import os
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import slack_notify  # noqa: E402
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from town import TOWN, site_url  # noqa: E402

TIMEOUT = 20
SLOW = 10
RETRY_WAIT = 30
REMIND_MIN = 60
UA = "thevic361-uptime/1.0 (+https://github.com/Tmpalori/thevic361)"


def fetch(url, timeout=TIMEOUT):
    """(status, body bytes, seconds). Status 0 when there's no answer."""
    t0 = time.monotonic()
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Cache-Control": "no-cache"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read()
            return r.status, body, time.monotonic() - t0
    except urllib.error.HTTPError as e:
        return e.code, b"", time.monotonic() - t0
    except Exception:
        return 0, b"", time.monotonic() - t0


def problems(site, fetch=fetch):
    """What's wrong right now (empty when all is well), plus the events body."""
    out, events_body = [], b""
    for path in ("/", "/api/health?deep=1", "/events.json"):
        status, body, secs = fetch(site.rstrip("/") + path)
        if status != 200:
            out.append(f"{path} {'did not answer' if status == 0 else f'returned HTTP {status}'}")
        elif secs > SLOW:
            out.append(f"{path} took {secs:.0f}s")
        elif path == "/events.json":
            events_body = body
            try:
                if not json.loads(body).get("events"):
                    out.append("events feed is empty")
            except Exception:
                out.append("events feed is unreadable")
    return out, events_body


def decide(state, found, now):
    """(message or None, new state). `now` is a UTC datetime."""
    stamp = now.isoformat()
    if found:
        what = "; ".join(found)
        if not state.get("down_since"):
            return f"🚨 {TOWN['domain']} is DOWN: {what}", {"down_since": stamp, "last_alert": stamp}
        since = dt.datetime.fromisoformat(state["down_since"])
        last = dt.datetime.fromisoformat(state.get("last_alert") or state["down_since"])
        if now - last >= dt.timedelta(minutes=REMIND_MIN):
            mins = int((now - since).total_seconds() // 60)
            return f"🚨 {TOWN['domain']} still DOWN ({mins} min): {what}", {**state, "last_alert": stamp}
        return None, state
    if state.get("down_since"):
        mins = int((now - dt.datetime.fromisoformat(state["down_since"])).total_seconds() // 60)
        return f"✅ {TOWN['domain']} is back up (down about {mins} min)", {}
    return None, {}


def push(message, site):
    """High-priority ntfy push, if NTFY_TOPIC is set. Never raises."""
    topic = os.environ.get("NTFY_TOPIC", "").strip()
    if not topic:
        return
    down = message.startswith("🚨")
    # Same [Town] tag as the Slack post, so a push says which town is down.
    tag = slack_notify.town_tag()
    body = f"[{tag}] {message}" if tag else message
    req = urllib.request.Request(
        f"https://ntfy.sh/{topic}", data=body.encode(),
        headers={"Title": TOWN["domain"], "Priority": "urgent" if down else "default",
                 "Click": site, "Tags": "rotating_light" if down else "white_check_mark"})
    try:
        urllib.request.urlopen(req, timeout=15).read()
    except Exception as e:  # noqa: BLE001 - best effort by design
        print(f"ntfy push failed: {e}")


def load(path):
    try:
        with open(path) as f:
            s = json.load(f)
        return s if isinstance(s, dict) else {}
    except Exception:
        return {}


def main(argv, fetch=fetch, sleep=time.sleep, now=None):
    site = argv[0] if argv else site_url()
    state_file = argv[1] if len(argv) > 1 else "uptime-state.json"
    found, body = problems(site, fetch)
    if found:
        sleep(RETRY_WAIT)
        found, body = problems(site, fetch)
    if body:
        # Next to the state file: the last feed served, kept in the cached
        # state for a look after an alert. (The daily stale-feed check in
        # uptime.yml fetches its own copy; it runs as a separate job.)
        with open(os.path.join(os.path.dirname(state_file) or ".", "events.json"), "wb") as f:
            f.write(body)
    message, state = decide(load(state_file), found, now or dt.datetime.now(dt.timezone.utc))
    with open(state_file, "w") as f:
        json.dump(state, f)
    if message:
        print(message)
        slack_notify.main([message, "--link", site])
        push(message, site)
    for p in found:
        print(f"::error::{p}")
    print("OK" if not found else "DOWN")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
