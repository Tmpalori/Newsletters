#!/usr/bin/env python3
"""One look over the published events, after they go live, for anything off.

Runs as the jobs worker's event-check job after each collect (once
auto-publish has updated the site) and on Monday morning before the
newsletter. Reads the live /events.json, so it checks what people actually
see, hand edits included, and posts one short Slack line to the activity
channel (how many of each kind to look at, or that everything looks fine);
the full list goes to the owner inbox (HQ) as an fyi item. What a rule is
sure about (church events, non-events, exact duplicates, a cut-off name with
the whole listing at the same place that day) it hides on its own through the site's
/api/event-check/hide (server/eventcheck.js; never deletes, restore on admin
Home); judgment calls are flagged. The run right before an issue
(--before-send) also hides what's still likely wrong in the coming week,
the AI's findings included (before_send_picks).

Two passes:
  - Rules (free): the collector's own duplicate, out-of-area and non-event
    checks run again over the published list (it can hold hand-added
    events, or ones published before a rule existed), plus a weekday in the
    name that doesn't match the date ("Monday Bingo" on a Tuesday) and
    start times in the middle of the night, or a night event in the morning.
  - AI (one call, a few cents): the whole list at once, so it can see what
    per-event checks can't, like the same event at two venues. Skipped
    without OPENAI_API_KEY; the rules still run.

    python3 scripts/sweep_events.py [--days 14] [--dry-run]
    python3 scripts/sweep_events.py --wait-for candidates.json   # after a collect
"""
import argparse
import json
import os
import re
import sys
import time
from collections import Counter
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
sys.path.insert(0, HERE)

import requests  # noqa: E402

import collect_events as ce  # noqa: E402
from town import TOWN, site_url  # noqa: E402
import slack_notify  # noqa: E402

SITE = site_url()
WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
AI_KINDS = {"duplicate", "wrong_date", "not_an_event", "out_of_area", "religious", "odd_time", "other"}
# The inbox keeps 4,000 characters of an item's text (server/inbox.js).
MAX_HQ_TEXT = 3800
RELIGIOUS_REASONS = {"religious event", "church event", "worship service"}  # collect_events.non_event_reason
# Rule findings certain enough to hide without asking, on any run. Wrong
# days and odd times stay flags until the before-send check (below).
AUTO_HIDE = {"religious", "not_an_event", "duplicate", "cut_off"}
MAX_PER_RUN = 25  # server/eventcheck.js refuses a larger batch
# The before-send check (the Monday and Thursday morning runs, an hour
# before the issue): nobody may have read the flags, so what is still
# likely wrong in the coming week comes down rather than go out to every
# subscriber. Hiding never deletes; Restore on the admin Home tab undoes it
# and a restored event is never hidden again. Paid picks and approved
# submissions are never touched. Odd times from the AI and "other" stay
# flags: the AI is too often wrong about those, and the fix is an edit.
BEFORE_SEND_DAYS = 7
BEFORE_SEND_RULE_KINDS = {"duplicate", "wrong_date", "not_an_event", "religious", "out_of_area", "odd_time"}
BEFORE_SEND_AI_KINDS = {"duplicate", "wrong_date", "not_an_event", "religious", "out_of_area"}
# A bar's standing "Live Music at Swampers" says nothing once the night's
# act is listed there too (Shoals, Oct 2026: a dozen of these a week).
_PLACEHOLDER_WORDS = {"live", "music", "band", "bands", "performance", "performances", "performer", "performers",
                      "local", "artist", "artists", "musician", "musicians", "night", "nightly", "tonight", "show",
                      "shows", "entertainment", "acoustic", "set", "sets", "by", "karaoke", "trivia", "bingo"}
_ACTIVITY_WORDS = {"karaoke", "trivia", "bingo"}
# Hand-written events (curated: true, from local_events.yaml) were checked
# by a person: church trunk-or-treats and nearby-town festivals are on the
# list on purpose, and a name like "Movie Night: Friday the 13th" on a
# Monday is right. Only duplicates and odd times are still worth a look.
CURATED_SKIP = {"religious", "not_an_event", "out_of_area", "wrong_date", "cut_off", "other"}
# Duplicates are only hidden when they're exact (same name, venue and start
# once normalized), or the library's copy of a program the city calendar
# lists at its real place, and neither copy is a paid/featured listing; the
# copy with less detail goes. Fuzzy matches are only reported. A cut-off
# name ("Scenic Root — Plant a") is hidden only when another listing is at
# the same place that day (the whole event, from another source); alone it
# is only reported, since hiding it could lose the event.


def upcoming(events, today, days):
    end = (today + timedelta(days=days - 1)).isoformat()
    out = [e for e in events if today.isoformat() <= str(e.get("date") or "") <= end]
    out.sort(key=lambda e: (e["date"], ce._start_minutes(e.get("time")) or 0, e.get("name") or ""))
    return out


def _weekday(d):
    return WEEKDAYS[date.fromisoformat(d).weekday()]


def rule_findings(events):
    """Cheap, certain checks. Returns [(index, kind, why)]."""
    found = []
    for i, e in enumerate(events):
        name = (e.get("name") or "").lower()
        # Exactly one weekday in the name, and it isn't the event's day.
        named = {d for d in WEEKDAYS if d in name}
        if len(named) == 1:
            want = named.pop()
            if want != _weekday(e["date"]):
                found.append((i, "wrong_date", f"name says {want.title()} but it's listed on a {_weekday(e['date']).title()}"))
        start = ce._start_minutes(e.get("time"))
        if start is not None and start < 6 * 60:
            found.append((i, "odd_time", f"starts at {e.get('time')}"))
        else:
            # "Comedy Night" at 10:00 AM: probably an AM/PM slip.
            reason = ce.morning_nightlife_reason(e) or ce.evening_venue_morning_reason(e)
            if reason:
                found.append((i, "odd_time", reason))
        reason = ce.cut_off_name_reason(e.get("name"))
        if reason:
            found.append((i, "cut_off", f"name looks cut off ({reason})"))
        reason = ce.out_of_area_reason(dict(e))
        if reason:
            found.append((i, "out_of_area", reason))
        reason = ce.non_event_reason(dict(e))
        if reason in RELIGIOUS_REASONS and ce.non_event_reason({**e, "description": ""}) not in RELIGIOUS_REASONS:
            # Only the description sounds religious: a person decides.
            found.append((i, "other", f"description sounds religious ({reason})"))
        elif reason:
            found.append((i, "religious" if reason in RELIGIOUS_REASONS else "not_an_event", reason))
        j = _dup_of(events, i)
        if j is not None:
            found.append((i, "duplicate", f"same as “{events[j]['name']}” at {events[j].get('venue') or 'no venue'}"))
        else:
            j = _placeholder_for(events, i)
            if j is not None:
                found.append((i, "duplicate", f"a general listing; “{events[j]['name']}” is listed there then"))
    return found


def _generic_name(e):
    """Only the venue and words like "Live Music" in the name."""
    words = ce._name_tokens(e.get("name"))
    drop = set(ce._name_tokens(e.get("venue"))) | ce._CITY_TOKENS | ce._WEEKDAY_TOKENS
    return bool(words) and all(w in _PLACEHOLDER_WORDS or w in drop for w in words)


def _overlap(a, b):
    """Times that overlap, or one isn't known. A set without an end runs two hours."""
    (sa, ea), (sb, eb) = ce._time_range(a.get("time")), ce._time_range(b.get("time"))
    if sa is None or sb is None:
        return True
    ea = ea if ea is not None and ea > sa else sa + 120
    eb = eb if eb is not None and eb > sb else sb + 120
    return sa < eb and sb < ea


def _placeholder_for(events, i):
    """The specific listing that makes events[i] a placeholder, or None:
    same day, same named place, overlapping times, the same kind of thing
    (karaoke for "Karaoke at ...", a music listing for "Live Music at ...")."""
    e = events[i]
    if not (e.get("venue") or "").strip() or not _generic_name(e):
        return None
    activity = _ACTIVITY_WORDS & set(ce._name_tokens(e.get("name")))
    for j, o in enumerate(events):
        if j == i or o.get("date") != e.get("date") or not (o.get("venue") or "").strip() or _generic_name(o):
            continue
        if not ce._same_place(e, o) or not _overlap(e, o):
            continue
        words = set(ce._name_tokens(o.get("name")))
        if activity & words if activity else ("music" in (o.get("icons") or []) and not _ACTIVITY_WORDS & words):
            return j
    return None


def _dup_of(events, i):
    return next((j for j in range(i) if ce.is_same_event(events[j], events[i])
                 or _library_twin(events[j], events[i])), None)


def _library_twin(a, b):
    """The library's copy of a program the city calendar lists at its real
    place (2026-10-06 "Bookish Society Book Club" at the library and at Vida
    Cafe, same hours). Published lists have lost the collector's "guessed
    venue" flag, so the links tell the copies apart."""
    lib, city = (a, b) if "librarycalendar.com" in (a.get("url") or "") else (b, a)
    if "librarycalendar.com" not in (lib.get("url") or "") \
            or "victoriatx.gov/calendar.aspx?eid=" not in (city.get("url") or "").lower():
        return False
    if (lib.get("venue") or "").strip().lower() != "victoria public library" or lib.get("date") != city.get("date"):
        return False
    ta, tb = ce._time_range(lib.get("time")), ce._time_range(city.get("time"))
    return _norm(lib.get("name")) == _norm(city.get("name")) and ta[0] is not None and ta == tb


def _line(i, e):
    desc = (e.get("description") or "").replace("\n", " ")[:140]
    return (f"{i} | {e['date']} ({_weekday(e['date'])[:3]}) | {e.get('time') or 'no time'} | "
            f"{e.get('name')} | {e.get('venue') or 'no venue'} | {desc}")


PROMPT = """You check the published event list for <<SITE>>, a community events site for <<PLACE>>.
Each line is: index | date (weekday) | time | name | venue | description.

Flag only clear problems a careful editor would fix before the list goes out:
- duplicate: the same real event listed more than once (same day, same event, even if the venue or wording differs). Set "dup_of" to the other index.
- wrong_date: the name or description says a different day or date than the one listed.
- not_an_event: not something the public can attend (job posts, ads, closures, sales, awareness days, private events).
- out_of_area: clearly not in or near <<CITY_LONG>>.
- religious: worship, church services or church-hosted events (the owner doesn't list these).
- odd_time: a time that can't be right for this kind of event.
- other: anything else clearly wrong (garbled name, wrong venue for the event, etc.).

Do not flag the same recurring event on different days (weekly karaoke, story time). Do not flag generic names at different venues ("Live Music" at two bars is two events). When unsure, leave it out.
Refer to other events by their name, never by their index number (the reader never sees the numbers).
Answer with only a JSON array, at most 20 items: [{"i": <index>, "kind": "<kind>", "why": "<under 15 words>", "dup_of": <index or null>}]. Answer [] if nothing is off."""
PROMPT = (PROMPT.replace("<<SITE>>", TOWN["site_name"])
          .replace("<<PLACE>>", f"{TOWN['city_state_long']} ({TOWN['county']})" if TOWN["county"] else TOWN["city_state_long"])
          .replace("<<CITY_LONG>>", TOWN["city_state_long"]))


def _named(why, events):
    """Swap "index 12" (the model's line numbers, meaningless in Slack) for
    the event's name; drop the reference if the number isn't valid."""
    def name(m):
        n = int(m.group(1) or m.group(2))
        return f"“{events[n]['name']}”" if 0 <= n < len(events) else "another listing"
    # "index 12" always means a line number. "#12", "event 12", "item 12" and
    # "line 12" usually do, but not when they start a quoted name ("Line 2
    # Dance Night", "#1 Fan Day"), so those skip a following capitalized word.
    # "line" only lowercase: a reason quoting a name keeps its capital.
    return re.sub(r"(?:\b(?i:index)\s*#?\s*(\d+)\b"
                  r"|(?:\b(?:[Ii]tem|[Ee]vent|line)\s*#?\s*|#\s*)(\d+)\b(?!\s+[A-Z]))",
                  name, why)


def ai_findings(events, api_key, dups=None):
    """[(index, kind, why)] from one model pass, or None if it failed.
    dups, when given, gets {index: the index it duplicates}."""
    lines = "\n".join(_line(i, e) for i, e in enumerate(events))
    try:
        content = ce._openai_chat(api_key, [
            {"role": "system", "content": PROMPT},
            {"role": "user", "content": lines},
        ], max_tokens=6000, timeout=120)
    except Exception as e:  # noqa: BLE001 - the rules still report
        print(f"AI check failed: {e}")
        return None
    parsed = ce._parse_ai_json_array(content)
    if parsed is None:
        print(f"AI check: unreadable answer: {content[:300]!r}")
        return None
    out = []
    for item in parsed:
        try:
            i = int(item.get("i"))
        except (TypeError, ValueError, AttributeError):
            continue
        kind = str(item.get("kind") or "other")
        if not 0 <= i < len(events) or kind not in AI_KINDS:
            continue
        why = _named(str(item.get("why") or "").strip()[:160], events)
        dup = item.get("dup_of")
        if kind == "duplicate" and isinstance(dup, int) and 0 <= dup < len(events) and dup != i:
            other = events[dup]
            why = f"same as “{other['name']}” at {other.get('venue') or 'no venue'}" + (f" ({why})" if why else "")
            if dups is not None:
                dups[i] = dup
        out.append((i, kind, why))
    return out


def cap_picks(events, picks):
    """At most MAX_PER_RUN: the hide endpoint refuses a bigger batch outright,
    which would hide nothing. Events on the day lists go first (stable order
    otherwise); the rest stay in the report and wait for the next run."""
    return sorted(picks, key=lambda p: bool(events[p[0]].get("overflow")))[:MAX_PER_RUN]


def trusted(events, findings):
    """Drop findings a person already settled (curated events, CURATED_SKIP)."""
    return [f for f in findings if not (events[f[0]].get("curated") is True and f[1] in CURATED_SKIP)]


def combine(rule, ai):
    """One entry per event; rules first (they're certain), AI adds the rest."""
    seen, out = set(), []
    for i, kind, why in rule + (ai or []):
        if (i, kind) in seen:
            continue
        seen.add((i, kind))
        out.append((i, kind, why))
    out.sort()
    return out


# The Slack summary's counts: (one, more than one).
COUNT_LABEL = {"duplicate": ("possible duplicate", "possible duplicates"), "wrong_date": ("wrong day?", "wrong days?"),
               "not_an_event": ("maybe not an event", "maybe not events"),
               "out_of_area": (f"outside {TOWN['city']}?", f"outside {TOWN['city']}?"),
               "religious": ("church event", "church events"), "odd_time": ("odd time", "odd times"),
               "cut_off": ("cut-off name", "cut-off names"), "other": ("other", "other")}
LABEL = {"duplicate": "possible duplicate", "wrong_date": "wrong day?", "not_an_event": "not an event?",
         "out_of_area": f"outside {TOWN['city']}?", "religious": "religious / church event", "odd_time": "odd time",
         "cut_off": "name cut off", "other": "check"}


esc = slack_notify.escape  # names, venues and AI text are outside input in Slack mrkdwn


def describe(e):
    when = datetime.strptime(e["date"], "%Y-%m-%d").strftime("%a %b %-d")
    where = f" ({esc(e['venue'])})" if e.get("venue") else ""
    link = f"{SITE}{e['page']}" if e.get("page") else ""
    # Inside <url|text> a "|" would split the link, so it's swapped for "¦".
    name = f"<{link}|{esc(e['name']).replace('|', '¦')}>" if link else esc(e["name"])
    return f"{when} · {name}{where}"


def _norm(text):
    return " ".join(ce._name_tokens(text or ""))


def _exact_twins(a, b):
    return (a.get("date") == b.get("date") and _norm(a.get("name")) == _norm(b.get("name"))
            and _norm(a.get("venue")) == _norm(b.get("venue"))
            and ce._start_minutes(a.get("time")) == ce._start_minutes(b.get("time")))


def _paid(e):
    """A paid/hand-featured listing. An editor's pick (server/scoring.js) is
    featured only because it scored well; it gets no protection here."""
    return bool(e.get("featured")) and not e.get("editor_pick")


def _detail(e):
    """How much a listing tells people; the richer duplicate is kept."""
    return (_paid(e), bool(e.get("url")), len(e.get("description") or ""), bool(e.get("time")))


def to_hide(events, rules):
    """The rule findings to hide: certain kinds only, one per event. For a
    duplicate, the copy with less detail, and only for exact, unfeatured
    twins. Returns (picks, resolved): resolved maps a duplicate finding's
    event to the copy picked for hiding, so the report shows the pair once."""
    out, seen, resolved = [], set(), {}
    for i, kind, why in rules:
        if kind not in AUTO_HIDE:
            continue
        # A paid Vic's Pick was approved by the owner and sold to someone who
        # was told it's live; a rule match ("Grand Opening Giveaway" reads
        # as not an event, "Gospel Brunch" as religious) is not reason enough
        # to pull it. It stays in the report and goes to sales instead.
        if _paid(events[i]):
            continue
        # An approved community submission (submitted: true) was let through
        # by the owner by hand, often over the very rule that flags it here
        # ("rules say: ..." in the review), and the submitter was told it's
        # live. Report it, never hide it, like a curated event. (A duplicate
        # is checked on the copy that would be hidden, below.)
        if kind != "duplicate" and events[i].get("submitted") is True:
            continue
        if kind == "cut_off":
            whole = _whole_listing(events, i)
            if whole is None:
                continue
            why = f"{why}; “{events[whole]['name']}” is listed there that day"
        if kind == "duplicate":
            j = _dup_of(events, i)
            if j is None or _paid(events[j]):
                continue
            if _library_twin(events[i], events[j]):
                # The city calendar's copy has the real meeting place.
                loser, keeper = (i, j) if "librarycalendar.com" in (events[i].get("url") or "") else (j, i)
                why = (f"the library's copy of “{events[keeper]['name']}”, which the city lists at "
                       f"{events[keeper].get('venue') or 'another place'}")
            elif _exact_twins(events[i], events[j]):
                loser, keeper = (i, j) if _detail(events[i]) <= _detail(events[j]) else (j, i)
                why = f"same as “{events[keeper]['name']}” at {events[keeper].get('venue') or 'no venue'}, which has more detail"
            else:
                continue
            if events[loser].get("submitted") is True:
                continue  # the copy to hide is an approved submission: report only
            resolved[i] = loser
            i = loser
        if i not in seen and events[i].get("page"):
            seen.add(i)
            out.append((i, kind, why))
    return out, resolved


def _protected(e):
    """Never hidden by the before-send check: sold, or let through by a person."""
    return _paid(e) or e.get("submitted") is True


def _shares_word(a, b):
    """The names share a distinctive word once the venues and town are out."""
    drop = set(ce._name_tokens(a.get("venue"))) | set(ce._name_tokens(b.get("venue"))) | ce._CITY_TOKENS
    wa = {w for w in ce._name_tokens(a.get("name")) if w not in drop and _distinctive(w)}
    return bool(wa & set(ce._name_tokens(b.get("name"))))


def _loser(events, i, j):
    """Which of a duplicate pair to hide: never a protected copy, then the
    placeholder, then not the owner's hand-entered copy, then the one fewer
    sources listed (the organizer's post names itself as the venue; the
    copies that agree name the arena), without a time, with the shorter name
    (the full lineup beats "ft. Lightwatch"), with less detail. None when
    both are protected."""
    a, b = events[i], events[j]
    if _protected(a) or _protected(b):
        return None if _protected(a) and _protected(b) else (j if _protected(a) else i)

    def rank(k):
        e = events[k]
        return (not _generic_name(e), e.get("curated") is True, int(e.get("sources") or 1),
                ce._start_minutes(e.get("time")) is not None, len(ce._name_tokens(e.get("name"))), _detail(e))
    return i if rank(i) <= rank(j) else j


def before_send_picks(events, rules, ai, ai_dups, today):
    """What the before-send check hides: (index, kind, why), at most one per
    event, coming week only. Duplicates need a partner the rules found, or
    the AI's on the same day at the same place or sharing a distinctive
    name word. Returns (picks, resolved) like to_hide."""
    end = (today + timedelta(days=BEFORE_SEND_DAYS - 1)).isoformat()
    ai = ai or []
    ai_set = {(i, k) for i, k, _ in ai}
    out, seen, resolved = [], set(), {}
    for i, kind, why in combine(rules, ai):
        from_ai = (i, kind) in ai_set and (i, kind) not in {(r[0], r[1]) for r in rules}
        if kind not in (BEFORE_SEND_AI_KINDS if from_ai else BEFORE_SEND_RULE_KINDS):
            continue
        # Only a start in the middle of the night is surely wrong; "early
        # for this kind of event" is a guess (a 10 AM dig, Oct 2026).
        start = ce._start_minutes(events[i].get("time"))
        if kind == "odd_time" and (start is None or start >= 6 * 60):
            continue
        if kind == "duplicate":
            if from_ai:
                j = ai_dups.get(i)
                if j is None or events[j].get("date") != events[i].get("date") \
                        or not (ce._same_place(events[i], events[j]) or _shares_word(events[i], events[j])
                                or _shares_word(events[j], events[i])):
                    continue
            else:
                j = _dup_of(events, i)
                j = _placeholder_for(events, i) if j is None else j
                if j is None:
                    continue
            loser = _loser(events, i, j)
            if loser is None:
                continue
            if loser != i:
                keeper = events[i]
                why = f"same as “{keeper['name']}” at {keeper.get('venue') or 'no venue'}"
            resolved[i] = loser
            i = loser
        e = events[i]
        if i in seen or not e.get("page") or str(e.get("date") or "") > end or _protected(e):
            continue
        seen.add(i)
        out.append((i, kind, why))
    return out, resolved


def _whole_listing(events, i):
    """The full listing of the cut-off event: same day, same named place,
    not itself cut off, and plainly the same event, or None. Sharing a
    venue isn't enough: a bar's "Trivia Night" is no proof that its "Live
    Music with Jake and the" is listed elsewhere, and hiding on that pulls
    the only copy. A vague venue ("Victoria", "Downtown") says no place."""
    e = events[i]
    if _vague_venue(e.get("venue")):
        return None
    for j, o in enumerate(events):
        if j != i and o.get("date") == e.get("date") and not _vague_venue(o.get("venue")) \
                and ce._same_place(e, o) and not ce.cut_off_name_reason(o.get("name")) \
                and _same_event(e, o):
            return j
    return None


def _vague_venue(venue):
    return not (venue or "").strip() or ce._generic_venue(venue, [])


def _distinctive(w):
    return len(w) >= 4 and w not in ce._GENERIC_CORE_TOKENS


def _cut_fragments(name):
    """Token lists the cut-off name may stand for: all of it, and the part
    after an "Organizer — " prefix (the AI writes "Scenic Root — Plant a"
    for Scenic Root's post about "Once Upon A Plant"). The ellipsis and
    the dangling connector are dropped first."""
    n = re.sub(r"(\.\.\.|…)\s*$", "", (name or "").strip())
    words = n.split()
    if len(words) >= 2 and words[-1].strip(".,;:!?\"'()") in ce._DANGLING_WORDS:
        n = " ".join(words[:-1])
    parts = [n] + [p for p in re.split(r"\s+[-\u2013\u2014|:]\s+|:\s+", n)[1:] if p.strip()]
    return [ce._name_tokens(p) for p in parts]


def _same_event(cut, whole):
    """True when the whole listing's name holds every word left in the
    cut-off name (the last may be cut mid-word after "..."), with at least
    one distinctive word among them; or both start at the same known time
    and share a distinctive word (the AI reworded the name)."""
    have = ce._name_tokens(whole.get("name"))
    for toks in _cut_fragments(cut.get("name")):
        if not toks or not any(_distinctive(w) for w in toks):
            continue
        *head, last = toks
        if all(w in have for w in head) and any(h.startswith(last) for h in have):
            return True
    sa, sb = ce._start_minutes(cut.get("time")), ce._start_minutes(whole.get("time"))
    if sa is not None and sa == sb:
        cut_words = {w for toks in _cut_fragments(cut.get("name")) for w in toks}
        return any(_distinctive(w) and w in have for w in cut_words)
    return False


def hide(events, picks, secret):
    """Ask the site to hide picks. Returns (hidden indexes, indexes the admin
    restored before, a problem note for Slack or None)."""
    if not picks or not secret:  # no secret: report-only, by design
        return set(), set(), None
    body = {"hide": [{"page": events[i]["page"], "reason": f"{LABEL.get(k, k)}: {why}"[:120]} for i, k, why in picks]}
    try:
        r = requests.post(f"{SITE}/api/event-check/hide", json=body, timeout=30,
                          headers={"X-Cron-Secret": secret, "User-Agent": "vic361-event-check"})
        out = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
        if r.status_code == 401:
            return set(), set(), ("auto-hide failed: the site rejected the secret (check EVENT_CHECK_SECRET "
                                 "matches on the town's web and jobs services in Railway)")
        if not r.ok:
            return set(), set(), f"auto-hide failed: {out.get('message') or out.get('error') or f'HTTP {r.status_code}'}"
    except Exception as e:  # noqa: BLE001 - still report everything
        return set(), set(), f"auto-hide failed: {e}"
    by_page = {events[i]["page"]: i for i, _, _ in picks}
    hidden = {by_page[h["page"]] for h in out.get("hidden") or [] if h.get("page") in by_page}
    restored = {by_page[x["page"]] for x in out.get("skipped") or []
                if x.get("why") == "restored-by-admin" and x.get("page") in by_page}
    return hidden, restored, None


def paid_findings(events, findings):
    """Findings about paid Vic's Picks that a rule would have hidden: the
    sales channel hears about these, since a refund or a word with the
    buyer is a sales call, not an edit."""
    return [f for f in findings if f[1] in AUTO_HIDE and _paid(events[f[0]])]


def notify_sales(events, flagged):
    """Post flagged paid picks to the sales channel (SLACK_SALES_WEBHOOK_URL),
    falling back to the alerts webhook so they're never only a line in
    the activity channel. No webhook set: nothing posted."""
    if not flagged:
        return
    url = (os.environ.get("SLACK_SALES_WEBHOOK_URL") or os.environ.get("SLACK_ALERTS_WEBHOOK_URL") or "").strip()
    if not url:
        return
    lines = [f"💳 Event check: {len({f[0] for f in flagged})} paid {TOWN['pick_name_plain']}(s) matched a hide rule. "
             "Not hidden; check with the buyer:"]
    lines += [f"• {describe(events[i])}: *{LABEL.get(kind, kind)}*, {esc(why)}" for i, kind, why in flagged]
    with _webhook(url):
        slack_notify.main(["\n".join(lines), "--link", f"{SITE}/admin.html"])


@contextmanager
def _webhook(url):
    """slack_notify posts to SLACK_WEBHOOK_URL; point it at url for one post."""
    old = os.environ.get("SLACK_WEBHOOK_URL")
    os.environ["SLACK_WEBHOOK_URL"] = url
    try:
        yield
    finally:
        if old is None:
            os.environ.pop("SLACK_WEBHOOK_URL", None)
        else:
            os.environ["SLACK_WEBHOOK_URL"] = old


def report(events, findings, ai_ran, days, hidden=(), problem=None):
    """Slack text: what was hidden, then what to look at."""
    scope = f"{len(events)} events in the next {days} days"
    gone = [f for f in findings if f[0] in hidden]
    look = [f for f in findings if f[0] not in hidden]
    note = ("" if ai_ran else " (Rules only; the AI check didn't run.)") + (f" ⚠️ {esc(problem)}." if problem else "")
    if not findings:
        return f"🔎 Event check: {scope}, nothing looks off.{note}", []
    nh, nl = len({f[0] for f in gone}), len({f[0] for f in look})
    parts = ([f"hid {nh}"] if nh else []) + ([f"{nl} to look at"] if nl else [])
    head = f"🔎 Event check: {', '.join(parts)} ({scope}){note}"
    lines = []
    if gone:
        lines.append("*Hidden automatically* (nothing deleted; Restore on the admin Home tab):")
        lines += [f"• {describe(events[i])}: *{LABEL.get(kind, kind)}*, {esc(why)}" for i, kind, why in gone]
    if look:
        lines.append("*To look at:*")
        lines += [f"• {describe(events[i])}: *{LABEL.get(kind, kind)}*, {esc(why)}" for i, kind, why in look]
    return head, lines


def _when(raw):
    """A last_updated as an aware datetime (naive reads as UTC), or None."""
    try:
        t = datetime.fromisoformat(str(raw or "").replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def _key(e):
    # server/db.js eventKeyOf
    return f"{e.get('date') or ''}|{e.get('name') or ''}|{e.get('venue') or ''}"


def fetch_live():
    resp = requests.get(f"{SITE}/events.json?all=1", timeout=30, headers={"User-Agent": "vic361-event-check"})
    resp.raise_for_status()
    return resp.json()


def wait_for_publish(candidates_path, fetch=fetch_live, sleep=time.sleep, tries=30, interval=30, today=None):
    """Wait until the live list holds these candidates (after a collect).

    The proof is the live collected_at (server/index.js): the last_updated
    of the candidates.json auto-publish last put live. Once it's at or after
    these candidates' last_updated, they're live, whatever the list holds:
    hidden, rejected or merged candidates never show up, so counting keys
    can wait out the full timeout on a list that went live before the first
    fetch and raise a false "didn't go live" alert.

    Fallback for a site that doesn't send collected_at: a newer live
    last_updated alone isn't proof (a submissions-only auto-publish or an
    admin publish bumps it too), so the first answer is the before picture,
    and the wait ends once the list is newer than the candidates and holds
    some of the upcoming candidates it didn't have then (half, at most 3).
    With nothing new, newer is enough.
    True when they're live; False (with a warning) after tries x interval.
    """
    with open(candidates_path) as f:
        cand = json.load(f)
    made = _when(cand.get("last_updated"))
    today = today or ce.now_central().date().isoformat()
    keys = {_key(e) for e in cand.get("events") or [] if e.get("name") and str(e.get("date") or "") >= today}
    new = need = None
    for i in range(tries):
        try:
            live = fetch()
            collected = _when(live.get("collected_at"))
            if made and collected:
                if collected >= made:
                    print(f"Live list is from the collect made {collected} (candidates made {made}).")
                    return True
                print(f"waiting: live list is from the collect made {collected}, candidates made {made}")
                if i < tries - 1:
                    sleep(interval)
                continue
            live_keys = {_key(e) for e in live.get("events") or []}
            if new is None:
                new = keys - live_keys
                need = min(3, (len(new) + 1) // 2)
            updated = _when(live.get("last_updated"))
            seen = len(new & live_keys)
            if made and updated and updated >= made and seen >= need:
                print(f"Live list updated at {updated} with {seen} of {len(new)} new candidates (made {made}).")
                return True
            print(f"waiting: live list from {updated}, {seen} of {len(new)} new candidates (need {need})")
        except (ValueError, OSError, requests.RequestException) as e:
            print(f"waiting: {e}")
        if i < tries - 1:
            sleep(interval)
    print(f"::warning::The new candidates didn't go live within {tries * interval // 60} minutes; "
          "checking what's there now.")
    return False


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=14)
    ap.add_argument("--dry-run", action="store_true", help="print instead of posting to Slack")
    ap.add_argument("--wait-for", metavar="CANDIDATES_JSON",
                    help="only wait (up to 15 min) for these candidates to go live, then exit")
    ap.add_argument("--before-send", action="store_true",
                    help="the run before an issue: also hide what's still likely wrong this coming week")
    args = ap.parse_args(argv)
    if args.wait_for:
        if not wait_for_publish(args.wait_for):
            # Usually Railway didn't deploy the collect commit (integration
            # off, or a failed build), so the site still shows the old list.
            # The check step still runs on what's there; this alert is what
            # gets someone to look before Monday's newsletter and posts use
            # the old list. The workflow points SLACK_WEBHOOK_URL at the
            # alerts channel for this step.
            run = os.environ.get("GITHUB_RUN_ID")
            link = (f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/"
                    f"{os.environ.get('GITHUB_REPOSITORY', '')}/actions/runs/{run}") if run else f"{SITE}/admin.html"
            slack_notify.main(["🚨 The new events didn't go live after the collect (no Railway deploy?); "
                               "the site still shows the old list", "--link", link, "--channel", "alerts"])
        return 0

    # ?all=1: every public event, including ones past their day's limit
    # (server/scoring.js), which still have pages and appear in the guides.
    events = upcoming(fetch_live().get("events") or [], ce.now_central().date(), args.days)

    rules = trusted(events, rule_findings(events))
    key = os.environ.get("OPENAI_API_KEY", "").strip()
    ai_dups = {}
    ai = ai_findings(events, key, ai_dups) if key and events else None
    ai = trusted(events, ai) if ai is not None else None
    secret = "" if args.dry_run else os.environ.get("EVENT_CHECK_SECRET", "").strip()
    picks, resolved = to_hide(events, rules)
    later, later_resolved = before_send_picks(events, rules, ai, ai_dups, ce.now_central().date())
    taken = {p[0] for p in picks}
    later = [p for p in later if p[0] not in taken and p[0] not in resolved.values()]
    if args.before_send:
        picks += later
        resolved = {**later_resolved, **resolved}
        later = []
    picks = cap_picks(events, picks)
    hidden, restored, problem = hide(events, picks, secret)
    findings = combine(rules, ai)
    # A duplicate pair shows once: as the copy that was hidden.
    done = {i for i, loser in resolved.items() if loser in hidden}
    findings = [f for f in findings if not (f[1] == "duplicate" and f[0] in done)]
    findings += [p for p in picks if p[0] in hidden and (p[0], p[1]) not in {(f[0], f[1]) for f in findings}]
    # What the admin restored isn't hidden or flagged again for the same
    # reason; anything else about it (wrong day, odd time, AI) still shows.
    findings = sorted(f for f in findings if not (f[0] in restored and f[1] in AUTO_HIDE))
    # Between issues, say what the before-send check will take down unless
    # someone fixes it first.
    due = {i for i, _, _ in later}
    findings = [(i, k, f"{why}; hidden before the next issue unless fixed" if i in due and k in BEFORE_SEND_RULE_KINDS
                 else why) for i, k, why in findings]
    findings += [p for p in later if p[0] not in {f[0] for f in findings}]
    head, lines = report(events, findings, ai is not None, args.days, hidden, problem)

    # Every finding in the log (the worker's Railway log keeps all of it).
    print("\n".join([head] + lines))
    if not args.dry_run:
        post_report(head, lines, findings, hidden)
        notify_sales(events, paid_findings(events, findings))
    return 0


def summary(head, findings, hidden=()):
    """The Slack line: the headline and how many of each kind to look at.
    Each finding one by one was a wall of text in Slack (Shoals: 3 messages
    for 30 findings, Oct 18 2026); the list itself goes to HQ."""
    look = Counter(kind for i, kind, _ in findings if i not in hidden)
    if not look:
        return head
    counts = [f"{n} {COUNT_LABEL.get(k, (k, k))[n != 1]}" for k, n in look.most_common()]
    return f"{head}\nTo look at: {', '.join(counts)}."


def hq_text(lines):
    """The full list for the owner inbox: Slack's <url|name> links as plain
    names, cut to what the inbox keeps (the rest stays in the Railway log)."""
    plain = [re.sub(r"<[^>|]*\|([^>]*)>", r"\1", line) for line in lines]
    out, size = [], 0
    for n, line in enumerate(plain):
        if size + len(line) + 1 > MAX_HQ_TEXT:
            out.append(f"…and {len(plain) - n} more lines in the event check's Railway log.")
            break
        out.append(line)
        size += len(line) + 1
    return "\n".join(out)


def post_report(head, lines, findings, hidden=()):
    """The full list to HQ as an fyi item, then one short line to Slack's
    activity channel. Not the default webhook: on the jobs services that
    one reaches the sales channel, and a report isn't a sale or an alert."""
    link = f"{SITE}/admin.html"
    in_hq = bool(lines) and slack_notify.report_to_site(f"{head}\n{hq_text(lines)}", link, True, fyi=True)
    text = summary(head, findings, hidden) + (" Full list in HQ." if in_hq else "")
    url = (os.environ.get("SLACK_ACTIVITY_WEBHOOK_URL") or os.environ.get("SLACK_WEBHOOK_URL") or "").strip()
    with _webhook(url):
        slack_notify.post_to_slack(text, link)


if __name__ == "__main__":
    sys.exit(main())
