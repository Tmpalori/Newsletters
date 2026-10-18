"""Facebook events keep their end time ("3 PM – 5 PM" was showing as
"3:00 PM"), sources keep their full text for the event page's `details`,
and the AI review writes those details without touching hand-entered
events."""

import json
import os
import sys
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

sys.path.insert(0, os.path.dirname(__file__))
import collect_events as ce  # noqa: E402


@pytest.fixture(autouse=True)
def _state():
    saved = ce._WINDOW_START, ce._WINDOW_END
    today = date.today()
    ce._WINDOW_START = today
    ce._WINDOW_END = today + timedelta(days=14)
    ce.reset_source_stats()
    yield
    ce._WINDOW_START, ce._WINDOW_END = saved


START = datetime(2026, 10, 18, 15, 0, tzinfo=ZoneInfo("America/Chicago"))


@pytest.mark.parametrize("item, end", [
    ({"dateTimeSentence": "Sunday, October 18, 2026 at 3 PM – 5 PM CDT"}, "5:00 PM"),
    ({"dateTimeSentence": "Sunday, October 18, 2026 at 3:00 PM – 5:30 PM CDT"}, "5:30 PM"),
    ({"duration": "2 hr"}, "5:00 PM"),
    ({"duration": "1 hr 30 min"}, "4:30 PM"),
    ({"utcEndDate": "2026-10-18T22:00:00Z"}, "5:00 PM"),
    # A run over several days has no same-day end; a bare time would mislead.
    ({"dateTimeSentence": "Oct 18 at 3 PM – Oct 19 at 11:59 PM CDT", "duration": "2 days"}, ""),
    ({"duration": "12 hr"}, ""),
    ({"dateTimeSentence": "Sunday, October 18, 2026 at 3 PM CDT"}, ""),
    ({}, ""),
])
def test_fb_end_time(item, end):
    assert ce._fb_end_time(item, START) == end


def test_fb_event_gets_its_range_city_and_full_text(monkeypatch):
    monkeypatch.setenv("APIFY_TOKEN", "t")
    monkeypatch.setattr(ce, "_load_venue_list", lambda: ([{"name": "x"}], "venues.json"))
    day = date.today() + timedelta(days=3)
    # 3 PM Central, whatever the offset that day.
    start = ce._to_central(datetime(day.year, day.month, day.day, 20, 0, tzinfo=timezone.utc))
    full = "Pumpkin painting, games and activities. " * 12
    items = [{"id": "1", "name": "Fall Festival", "utcStartDate": start.astimezone(timezone.utc).isoformat(),
              "duration": "2 hr", "description": full,
              "location": {"name": "Hall", "streetAddress": "224 E Mobile St", "city": "Victoria, TX"}}]
    monkeypatch.setattr(ce, "_run_apify_search", lambda actor, payload, token:
                        items if actor == ce.APIFY_FB_ACTOR else [])
    ev, = ce.fetch_apify_facebook_events(14)
    end = (start + timedelta(hours=2)).strftime("%-I:%M %p")
    assert ev["time"] == f"{start.strftime('%-I:%M %p')} – {end}"
    assert ev["address"] == "224 E Mobile St, Victoria, TX"
    assert len(ev["description"]) == 280
    assert ev["_details_src"] == full.strip()


def test_details_src_only_when_it_says_more():
    assert ce._details_src("Short.", "Short.") == {}
    assert ce._details_src("<p>Line one</p><p>Line two &amp; more, a good deal more text here</p>", "Line one") == {
        "_details_src": "Line one\nLine two & more, a good deal more text here"}


def test_merge_keeps_the_fullest_text():
    short = {"date": "2026-10-18", "name": "Fall Festival", "description": "Games.", "_source": "city_calendar"}
    long = {"date": "2026-10-18", "name": "Fall Festival", "description": "Games.",
            "_details_src": "Games, pumpkin painting, a costume contest at 4 PM and $5 armbands.", "_source": "apify_facebook"}
    merged = ce._merge_pair(short, long)
    assert merged["_details_src"].startswith("Games, pumpkin painting")


def _events():
    return [
        {"date": "2026-10-18", "name": "Fall Festival", "description": "Games.",
         "_details_src": "Games 🎃🎃, pumpkin painting, a costume contest at 4 PM and $5 armbands!!", "icons": []},
        {"date": "2026-10-18", "name": "Turkeyfest", "description": "Details on the Turkeyfest page.",
         "curated": True, "icons": []},
    ]


def test_ai_review_writes_details_from_the_full_text(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "k")
    sent = {}

    def chat(api_key, messages, max_tokens, timeout=60):
        payload = json.loads(messages[1]["content"].split("\n\n", 1)[1])
        sent["raw"] = [p["raw_description"] for p in payload]
        sent["prompt"] = messages[0]["content"]
        return json.dumps([{"id": p["id"], "description": "Fall games for families.",
                            "details": "Games and pumpkin painting 🎃.\\nCostume contest: 4 PM\\nArmbands: $5",
                            "icons": ["family"], "free": False, "appeal": 3, "keep": True} for p in payload])

    monkeypatch.setattr(ce, "_openai_chat", chat)
    out = ce.ai_review(_events())
    assert sent["raw"][0].startswith("Games 🎃🎃, pumpkin painting")
    assert "details:" in sent["prompt"]
    assert out[0]["description"] == "Fall games for families."
    assert out[0]["details"] == "Games and pumpkin painting.\nCostume contest: 4 PM\nArmbands: $5"
    # A hand-entered event keeps its own words: no AI details.
    assert "details" not in out[1]


def test_ai_review_skips_details_that_add_nothing(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "k")
    monkeypatch.setattr(ce, "_openai_chat", lambda *a, **k: json.dumps(
        [{"id": 1, "description": "Fall games for families.", "details": "Fall games for families.",
          "icons": ["family"], "free": False, "appeal": 3, "keep": True}]))
    out = ce.ai_review(_events()[:1])
    assert "details" not in out[0]


def test_post_prompt_asks_for_details():
    prompt = ce._post_events_prompt("Hall", "[1] post", "2026-10-18", "2026-11-01")
    assert '"details":' in prompt and "about THIS event" in prompt


# ─── A hand-entered festival keeps its place ────────────────────────────────

WALKER = {"date": "2026-10-24", "name": "Walker Ranch Fall Festival", "time": "Fri 3–7 PM, Sat 12–7 PM, Sun 2–7 PM",
          "venue": "Walker Ranch", "address": "16402 County Road 2, Florence", "description": "Corn maze.",
          "icons": ["family", "outdoors"], "curated": True, "_source": "local_events"}


@pytest.mark.parametrize("source", ["apify_facebook_posts", "apify_instagram_posts", "gemini_search"])
@pytest.mark.parametrize("order", [0, 1])
def test_curated_festival_keeps_its_venue(source, order):
    # A beauty studio's post about the festival: the model left the venue
    # blank, so the post took the account's own place.
    post = {"date": "2026-10-24", "name": "Walker Ranch Fall Festival", "time": "", "venue": "L&C Beauty Studio",
            "address": "207 Seville Street Ste C", "description": "Fall fun.", "icons": ["shopping"], "_source": source}
    a, b = (dict(WALKER), post) if order == 0 else (post, dict(WALKER))
    assert ce.is_same_event(a, b)
    merged = ce._merge_pair(a, b)
    assert (merged["venue"], merged["address"]) == ("Walker Ranch", "16402 County Road 2, Florence")


def test_place_in_a_festival_name_beats_a_posting_account():
    # Neither copy hand-entered: the listing at the ranch beats a post
    # filed under another business.
    feed = dict(WALKER, _source="town_feeds", curated=False)
    feed.pop("curated")
    post = {"date": "2026-10-24", "name": "Walker Ranch Fall Festival", "time": "", "venue": "L&C Beauty Studio",
            "address": "207 Seville Street Ste C", "_source": "apify_facebook_posts"}
    assert ce._merge_pair(feed, post)["venue"] == "Walker Ranch"


def test_festival_named_venue_still_gives_way():
    # "Tejas Fest (VIP)" as a venue is the event, not a place.
    a = {"date": "2026-10-24", "name": "Tejas Fest (VIP)", "time": "", "venue": "Tejas Fest VIP", "_source": "apify_facebook_posts"}
    b = {"date": "2026-10-24", "name": "Tejas Fest", "time": "", "venue": "Riverside Park", "address": "1 Park Rd",
         "_source": "apify_instagram_posts"}
    assert ce._merge_pair(a, b)["venue"] == "Riverside Park"


def test_hand_entered_without_address_takes_a_same_place_address():
    hand = dict(WALKER, address="")
    other = {"date": "2026-10-24", "name": "Walker Ranch Fall Festival", "time": "", "venue": "Walker Ranch",
             "address": "16402 County Road 2", "_source": "allevents"}
    assert ce._merge_pair(hand, other)["address"] == "16402 County Road 2"
