"""The live scripts.json: whatever batch is in it must be filmable and postable.

The rest of the suite is pinned to a frozen batch (conftest.py). This file
reads the real scripts.json, so a new week's scripts are checked the moment
they're written: the shape the tools rely on, the words Tristen will say,
and that a clean read of each one plans into a single cut of 16 s or less
with every chip placed.
"""
import datetime as dt
import json
import os
import re
import sys

import pytest

VIDEO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, VIDEO)

import analyze  # noqa: E402
import towns  # noqa: E402

with open(os.path.join(VIDEO, "scripts.json"), encoding="utf-8") as _f:
    DATA = json.load(_f)
VIDEOS = DATA["videos"]
IDS = [v["id"] for v in VIDEOS]
# libass can't draw color emoji, so the hook and chips must not carry any.
EMOJI = re.compile("[\U0001F000-\U0001FAFF☀-➿️]")


def speak(text, t0=0.0):
    """Fake whisper words for a clean, upbeat read (~2.9 words/s); the same
    pace as test_analyze.speak."""
    out, t = [], t0
    for w in text.split():
        d = 0.12 + 0.035 * len(w)
        out.append({"text": w, "start": round(t, 3), "end": round(t + d, 3), "prob": 0.95})
        t += d + 0.03
    return out


def test_shared_fields():
    assert DATA["cta_cue"], "cta_cue says which word starts the sign-up line"
    assert "{domain}" in DATA["end_card"]["line2"]


def test_ids_are_unique_and_name_their_town():
    assert len(IDS) == len(set(IDS)), "a video id is used twice"
    for v in VIDEOS:
        assert re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)+", v["id"]), v["id"]
        assert v["id"].startswith(v["town"] + "-"), v["id"]


@pytest.mark.parametrize("v", VIDEOS, ids=IDS)
def test_the_script_is_postable(v):
    t = towns.town(v["town"])
    n = len(v["say"].split())
    assert 28 <= n <= 50, f"{n} spoken words; about 42-46 fills 16 s"
    assert t["domain"] in v["say"], "the script must end on the web address"
    assert t["subscribe_url"] in v["caption"], "the caption must link to the sign-up page"
    assert isinstance(v["draft"], bool)
    assert 1 <= len(v["chips"]) <= 4
    assert v["hook"] and len(v["hook"]) <= 40, "the hook is a sticker: 40 characters at most"
    for text in [v["hook"]] + [c["text"] for c in v["chips"]]:
        assert not EMOJI.search(text), f"emoji in on-screen text {text!r}"
    said = set(analyze.tokens(v["say"]))
    for c in v["chips"]:
        cues = {tok for cue in c["cue"] for tok in analyze.tokens(cue)}
        assert cues & said, f"chip {c['text']!r}: none of its cue words {c['cue']} is in the script"


@pytest.mark.parametrize("v", VIDEOS, ids=IDS)
def test_tomorrow_morning_is_true(v):
    # The issues go out Monday and Thursday mornings, so "in your inbox
    # tomorrow morning" only holds for a Sunday or Wednesday post.
    at = dt.datetime.strptime(v["post_at_local"], "%Y-%m-%dT%H:%M")
    if "tomorrow morning" in v["say"].lower():
        assert at.strftime("%A") in ("Sunday", "Wednesday"), \
            f"posts on a {at:%A}, but promises an issue tomorrow morning"


@pytest.mark.parametrize("v", VIDEOS, ids=IDS)
def test_a_clean_read_plans_cleanly(v):
    ps = analyze.plan("/tmp/raw.mov", transcript=speak(v["say"]), scripts=DATA)
    assert [p["video_id"] for p in ps] == [v["id"]], "a clean read must match this script and no other"
    p = ps[0]
    assert len(p["chips"]) == len(v["chips"]), p["warnings"]
    assert p["duration"] <= 16.5, f"{p['duration']:.1f} s: cut a few words"
    left = [w for w in p["warnings"] if "still a draft" not in w and not w.startswith("sped up")]
    assert not left, left
