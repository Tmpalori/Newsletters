"""Regression tests for the Oct 2026 collector review: post dates in Central
time, New & Notable reaching candidates.json, partial runs, the library cap,
silent API failures, a dead OpenAI key, gap-filling trust, description
templates, the link check's time budget, metadata timestamps, and the
digest's HTML escaping."""

import json
import os
import sys
import time
from datetime import date, timedelta
from unittest.mock import MagicMock

import pytest
import requests

sys.path.insert(0, os.path.dirname(__file__))
import collect_events as ce  # noqa: E402
import send_digest as sd  # noqa: E402


@pytest.fixture(autouse=True)
def _state(monkeypatch):
    today = date.today()
    ce._WINDOW_START = today
    ce._WINDOW_END = today + timedelta(days=14)
    ce._RUN_STARTED = None
    ce._APIFY_LIMIT_TRIPPED = False
    ce._OPENAI_DEAD = False
    ce.reset_source_stats()
    for k in ("GEMINI_API_KEY", "APIFY_TOKEN", "OPENAI_API_KEY", "FB_POSTS_ENABLED", "IG_POSTS_ENABLED"):
        monkeypatch.delenv(k, raising=False)
    yield
    ce._RUN_STARTED = None
    ce._OPENAI_DEAD = False


def d(n):
    return (date.today() + timedelta(days=n)).isoformat()


def _resp(status=200, body=None, text=""):
    r = MagicMock()
    r.status_code = status
    r.json.return_value = body
    r.text = text or json.dumps(body)
    return r


# ─── FB/IG post dates are Central, not UTC ──────────────────────────────────

def _prompt_for(monkeypatch, posts):
    monkeypatch.setenv("OPENAI_API_KEY", "k")
    monkeypatch.setenv("FLYER_IMAGES", "0")
    sent = {}

    def chat(api_key, messages, max_tokens, timeout=60):
        sent["prompt"] = messages[0]["content"]
        return "[]"
    monkeypatch.setattr(ce, "_openai_chat", chat)
    ce._extract_events_from_posts_via_ai("Pour Haus", posts)
    return sent["prompt"]


def test_evening_post_is_dated_the_central_day_it_was_posted(monkeypatch):
    # Fri Oct 9 2026, 8:15 PM CDT. The prompt also names the window, so pin
    # it: on the real clock it starts on today's date, and from Oct 10 that
    # would put 2026-10-10 in the prompt for the wrong reason.
    from datetime import date
    monkeypatch.setattr(ce, "_WINDOW_START", date(2026, 10, 9))
    monkeypatch.setattr(ce, "_WINDOW_END", date(2026, 10, 23))
    prompt = _prompt_for(monkeypatch, [{"text": "Trivia TONIGHT at 8!", "time": "2026-10-10T01:15:00.000Z"}])
    assert "(posted Fri 2026-10-09 8:15 PM)" in prompt
    assert "2026-10-10" not in prompt


def test_post_dates_accept_epoch_seconds_and_plain_dates():
    assert ce._post_posted_on({"timestamp": 1791594900}) == "Fri 2026-10-09 8:15 PM"
    assert ce._post_posted_on({"time": 1791594900000}) == "Fri 2026-10-09 8:15 PM"
    assert ce._post_posted_on({"date": "2026-10-09"}) == "Fri 2026-10-09"
    assert ce._post_posted_on({"time": "last week"}) == "last week"
    assert ce._post_posted_on({}) == ""


# ─── New & Notable reaches candidates.json ──────────────────────────────────

_SCRAPERS = [
    "fetch_google_sheet_events", "fetch_city_calendar", "fetch_chamber_events",
    "fetch_library_events", "fetch_moonshine_events", "fetch_vtx_artwalk",
    "fetch_jwelch_events", "fetch_theatre_victoria_events",
    "fetch_generals_events", "fetch_allevents_events", "fetch_gemini_events",
    "fetch_apify_facebook_events", "fetch_apify_facebook_groups", "fetch_apify_facebook_posts", "fetch_apify_eventbrite_events",
    "fetch_apify_instagram_posts",
]


def _run_main(tmp_path, monkeypatch, notable=None, extras="new_and_notable: []\nsponsor: null\n", extra_args=()):
    (tmp_path / "local_events.yaml").write_text("recurring: []\nevents: []\n")
    (tmp_path / "extras.yaml").write_text(extras)
    for fn in _SCRAPERS:
        monkeypatch.setattr(ce, fn, lambda *a, **k: [])
    monkeypatch.setattr(ce, "drop_dead_links", lambda evs, **k: evs)
    if notable is not None:
        monkeypatch.setattr(ce, "fetch_gemini_notable", notable)
    monkeypatch.setattr(sys, "argv", [
        "collect_events.py", "--output", str(tmp_path / "events.json"),
        "--candidates", str(tmp_path / "candidates.json"), "--local-dir", str(tmp_path),
        "--days", "14", "--candidates-only", "--skip-ai", *extra_args,
    ])
    ce.main()
    return json.loads((tmp_path / "candidates.json").read_text())


ITEM = {"name": "Ellianos Coffee opens", "description": "On Airline Rd.", "tag": "new",
        "icon": "food", "url": "https://news.example/e", "added": "2026-10-04"}


def test_candidates_carry_new_and_notable_in_candidates_only_mode(tmp_path, monkeypatch):
    def notable():
        ce._NOTABLE_FETCHED = True
        return [dict(ITEM)]
    out = _run_main(tmp_path, monkeypatch, notable=notable,
                    extras="new_and_notable:\n  - name: Hand Pick\n    description: x\nsponsor: null\n")
    assert [n["name"] for n in out["new_and_notable"]] == ["Hand Pick", "Ellianos Coffee opens"]
    assert not (tmp_path / "events.json").exists()


def test_a_failed_notable_step_leaves_the_key_out(tmp_path, monkeypatch):
    # [] from a failed call would make auto-publish drop the live items.
    out = _run_main(tmp_path, monkeypatch, notable=lambda: [])
    assert "new_and_notable" not in out


def test_a_successful_empty_notable_step_writes_the_empty_list(tmp_path, monkeypatch):
    def notable():
        ce._NOTABLE_FETCHED = True
        return []
    out = _run_main(tmp_path, monkeypatch, notable=notable)
    assert out["new_and_notable"] == []


def test_skip_web_leaves_new_and_notable_out(tmp_path, monkeypatch):
    out = _run_main(tmp_path, monkeypatch, notable=lambda: pytest.fail("ran"), extra_args=("--skip-web",))
    assert "new_and_notable" not in out


# ─── Partial runs don't count as "ok" ───────────────────────────────────────

def test_a_partial_run_is_recorded_as_partial():
    def scraper():
        ce._mark_partial("allevents", "kids page failed")
        return [{"date": d(1), "name": "A"}]
    ce.safe_fetch("allevents", scraper)
    assert ce.source_status() == {"allevents": "partial"}
    assert "kids page failed" in ce.get_source_stats()[0]["message"]
    ce.safe_fetch("chamber", lambda: [{"date": d(1), "name": "B"}])
    assert ce.source_status()["chamber"] == "ok"


def test_allevents_page_error_marks_the_run_partial(monkeypatch):
    def get(url, **k):
        if url.endswith("/kids"):
            raise requests.ConnectionError("reset")
        return MagicMock(text="<html></html>", raise_for_status=lambda: None)

    def parse(html, events, seen):
        events.append({"date": d(1), "name": "X" + str(len(events))})
    monkeypatch.setattr(ce, "http_get", get)
    monkeypatch.setattr(ce, "_parse_allevents_page", parse)
    ce.safe_fetch("allevents", ce.fetch_allevents_events)
    assert ce.source_status()["allevents"] == "partial"


def _fb_item(n):
    return {"id": str(n), "name": f"Event {n}", "utcStartDate": f"{d(2)}T23:00:00Z",
            "location": {"name": "Hall", "city": "Victoria, TX"}}


def test_fb_events_partial_when_one_actor_fails_or_a_cap_is_hit(monkeypatch):
    monkeypatch.setenv("APIFY_TOKEN", "t")
    monkeypatch.setenv("FB_EVENTS_MAX", "3")
    monkeypatch.setattr(ce, "_load_venue_list", lambda: ([{"name": "x"}], "venues.json"))
    # One actor down, the other well under its cap.
    monkeypatch.setattr(ce, "_run_apify_search", lambda actor, payload, token:
                        None if actor == ce.APIFY_FB_ALT_ACTOR else [_fb_item(1)])
    ce.safe_fetch("apify_facebook", ce.fetch_apify_facebook_events, expect_events=False)
    assert ce.source_status()["apify_facebook"] == "partial"

    ce.reset_source_stats()
    monkeypatch.setattr(ce, "_run_apify_search", lambda actor, payload, token:
                        [_fb_item(n) for n in range(3)] if actor == ce.APIFY_FB_ACTOR else [])
    ce.safe_fetch("apify_facebook", ce.fetch_apify_facebook_events, expect_events=False)
    assert ce.source_status()["apify_facebook"] == "partial"

    ce.reset_source_stats()
    monkeypatch.setattr(ce, "_run_apify_search", lambda actor, payload, token: [_fb_item(1)])
    ce.safe_fetch("apify_facebook", ce.fetch_apify_facebook_events, expect_events=False)
    assert ce.source_status()["apify_facebook"] == "ok"


def test_eventbrite_partial_when_the_result_cap_is_hit(monkeypatch):
    monkeypatch.setenv("APIFY_TOKEN", "t")
    monkeypatch.setenv("EVENTBRITE_MAX", "2")
    items = [{"name": f"E{n}", "startDate": f"{d(2)}T19:00", "venueName": "Hall", "venueCity": "Victoria"}
             for n in range(2)]
    monkeypatch.setattr(ce.requests, "post", lambda *a, **k: _resp(200, items))
    ce.safe_fetch("apify_eventbrite", ce.fetch_apify_eventbrite_events, expect_events=False)
    assert ce.source_status()["apify_eventbrite"] == "partial"


# ─── Library cap spares hand-added events ───────────────────────────────────

def _lib(date_s, name, time_s="", **extra):
    return {"date": date_s, "name": name, "time": time_s, "venue": "Victoria Public Library",
            "url": "https://victoriapl.librarycalendar.com/event/x", "_source": "library", **extra}


def test_library_cap_keeps_hand_added_events_and_doesnt_count_them():
    day = d(3)
    rec = {"date": day, "name": "VPL Rec Night", "time": "6:00 PM", "venue": "Victoria Public Library",
           "url": "", "_source": "local_events", "curated": True, "big": True}
    out = ce.cap_library_events([_lib(day, "AgriLife Talk", "10:00 AM"), _lib(day, "Teen Anime Club", "4:00 PM"), rec])
    assert sorted(e["name"] for e in out) == ["AgriLife Talk", "Teen Anime Club", "VPL Rec Night"]


def test_library_cap_sorts_by_clock_time_not_text():
    day = d(3)
    out = ce.cap_library_events([_lib(day, "Late", "10:30 AM"), _lib(day, "Early", "9:30 AM"),
                                 _lib(day, "Afternoon", "2:00 PM")])
    assert sorted(e["name"] for e in out) == ["Early", "Late"]


# ─── Dead API keys and renamed actors warn ──────────────────────────────────

def test_gemini_events_warn_when_the_key_is_rejected(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    ce.fetch_gemini_events(post=lambda *a, **k: _resp(403, {}, "API key revoked"), workers=1)
    assert any("Gemini" in w for w in ce._WARNINGS)


def test_gemini_events_warn_when_every_call_fails(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    ce.fetch_gemini_events(post=lambda *a, **k: _resp(500, {}, "oops"), categories=["a", "b"], workers=1)
    assert any("Gemini" in w for w in ce._WARNINGS)


def test_gemini_notable_warns_on_http_error(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    assert ce.fetch_gemini_notable(post=lambda *a, **k: _resp(429, {}, "quota")) == []
    assert any("notable" in w.lower() for w in ce._WARNINGS)


def test_apify_search_and_eventbrite_warn_on_http_error(monkeypatch):
    monkeypatch.setattr(ce.requests, "post", lambda *a, **k: _resp(404, {}, "actor not found"))
    assert ce._run_apify_search(ce.APIFY_FB_ACTOR, {}, "t") is None
    assert any("404" in w for w in ce._WARNINGS)
    ce._WARNINGS.clear()
    monkeypatch.setenv("APIFY_TOKEN", "t")
    assert ce.fetch_apify_eventbrite_events() == []
    assert any("404" in w for w in ce._WARNINGS)


# ─── A dead OpenAI key stops the post scrapes ───────────────────────────────

def _http_error(status, body):
    resp = requests.Response()
    resp.status_code = status
    resp._content = body.encode()
    return requests.HTTPError(response=resp)


def test_openai_quota_stops_fb_posts_after_one_venue(monkeypatch):
    monkeypatch.setenv("FB_POSTS_ENABLED", "1")
    monkeypatch.setenv("APIFY_TOKEN", "t")
    monkeypatch.setenv("OPENAI_API_KEY", "k")
    monkeypatch.setenv("FLYER_IMAGES", "0")
    venues = [{"name": f"V{n}", "facebook_page": f"https://facebook.com/v{n}", "confidence": "high"}
              for n in range(4)]
    monkeypatch.setattr(ce, "_load_venue_list", lambda: (venues, "venues.json"))
    apify_calls = []

    def post(url, **k):
        apify_calls.append(url)
        return _resp(200, [{"text": "Live music Friday 8pm", "time": f"{d(0)}T12:00:00Z"}])
    monkeypatch.setattr(ce.requests, "post", post)

    def chat(*a, **k):
        raise _http_error(429, '{"error": {"code": "insufficient_quota"}}')
    monkeypatch.setattr(ce, "_openai_chat", chat)
    assert ce.fetch_apify_facebook_posts() == []
    assert len(apify_calls) == 1
    assert ce._OPENAI_DEAD


def test_openai_rate_limit_is_not_treated_as_dead(monkeypatch):
    def chat(*a, **k):
        raise _http_error(429, '{"error": {"code": "rate_limit_exceeded"}}')
    monkeypatch.setattr(ce, "_openai_chat", chat)
    assert ce._posts_ai_call("k", "V", {"role": "user", "content": "x"}, 5) is None
    assert not ce._OPENAI_DEAD


def test_post_extraction_warning_reports_the_real_status(monkeypatch):
    def chat(*a, **k):
        raise _http_error(401, '{"error": "invalid_api_key"}')
    monkeypatch.setattr(ce, "_openai_chat", chat)
    ce._posts_ai_call("k", "V", {"role": "user", "content": "x"}, 5)
    assert any("status=401" in w for w in ce._WARNINGS)
    assert not any("status=?" in w for w in ce._WARNINGS)


# ─── Gap filling: time/address need a page about this event ─────────────────

def _page(text, url):
    r = MagicMock()
    r.status_code, r.text, r.url = 200, text, url
    return r


def test_gap_fill_time_needs_its_source_to_name_the_event():
    item = {"_name": "Mercy House Trunk or Treat", "source": "https://facebook.com/somebody/posts/9",
            "time": "7:00 PM", "address": "4409 John Stockbauer Dr.",
            "description": "Costumes, candy and games for kids of all ages at the yearly event."}
    got = ce._verified_details(item, {"facebook.com"}, get=lambda u: _page("Log in to Facebook", u))
    assert "time" not in got and "address" not in got
    assert got["description"].startswith("Costumes")
    good = ce._verified_details(item, {"facebook.com"},
                                get=lambda u: _page("Mercy House Trunk or Treat, Friday 7 PM", u))
    assert good["time"] == "7:00 PM" and good["address"] == "4409 John Stockbauer Dr."


# ─── Description templates ──────────────────────────────────────────────────

def test_templates_make_no_claims_and_trivia_isnt_music():
    assert "music" not in ce.classify_icons("Trivia Night", "", "The Pub")
    out = ce.fill_gaps([{"date": d(1), "name": "Fall Fun", "venue": "Park", "icons": ["family"], "description": ""},
                        {"date": d(1), "name": "Show", "venue": "Hall", "icons": ["arts"], "description": ""}])
    text = " ".join(e["description"] for e in out).lower()
    for claim in ("free", "all ages", "open to the public", "live music", "bring the family"):
        assert claim not in text


def test_templates_fill_in_after_the_ai_review(tmp_path, monkeypatch):
    (tmp_path / "local_events.yaml").write_text(
        f"events:\n  - date: '{d(1)}'\n    name: Kids Craft Hour\n    venue: Hall\n")
    seen = {}

    def review(events, **k):
        seen["desc"] = [e.get("description") for e in events]
        return events
    monkeypatch.setattr(ce, "ai_review", review)
    (tmp_path / "extras.yaml").write_text("new_and_notable: []\nsponsor: null\n")
    for fn in _SCRAPERS:
        monkeypatch.setattr(ce, fn, lambda *a, **k: [])
    monkeypatch.setattr(sys, "argv", [
        "collect_events.py", "--output", str(tmp_path / "events.json"),
        "--candidates", str(tmp_path / "candidates.json"), "--local-dir", str(tmp_path),
        "--days", "14", "--candidates-only", "--skip-web",
    ])
    ce.main()
    assert seen["desc"] == [""]
    out = json.loads((tmp_path / "candidates.json").read_text())
    assert out["events"][0]["description"]


# ─── Link check has a time budget ───────────────────────────────────────────

def test_link_check_runs_in_parallel():
    def get(url):
        time.sleep(0.3)
        return MagicMock(status_code=404 if url.endswith("dead") else 200)
    evs = [{"url": f"https://h{n}.example/{'dead' if n == 0 else 'ok'}"} for n in range(8)]
    t0 = time.time()
    out = ce.drop_dead_links(evs, get=get)
    assert time.time() - t0 < 1.5
    assert out[0]["url"] == "" and all(e["url"] for e in out[1:])


def test_link_check_gives_up_on_a_hanging_host():
    calls = []

    def get(url):
        calls.append(url)
        raise requests.ReadTimeout("hang")
    evs = [{"url": f"https://slow.example/{n}"} for n in range(6)]
    ce.drop_dead_links(evs, get=get, workers=1)
    assert len(calls) == 2
    assert all(e["url"] for e in evs)


def test_link_check_stops_late_in_the_run(monkeypatch):
    monkeypatch.setattr(ce, "_minutes_in", lambda: ce.LINK_CHECK_STOP_MIN + 1)
    evs = [{"url": "https://a.example/dead"}]
    ce.drop_dead_links(evs, get=lambda u: pytest.fail("checked"))
    assert evs[0]["url"]


# ─── Metadata timestamps carry an offset ────────────────────────────────────

def test_metadata_timestamps_are_offset_aware(tmp_path, monkeypatch):
    _run_main(tmp_path, monkeypatch, notable=lambda: [])
    meta = json.loads((tmp_path / "collection_metadata.json").read_text())
    stamps = [meta["last_run_at"]] + [s["started_at"] for s in meta["sources"]] + [s["finished_at"] for s in meta["sources"]]
    for s in stamps:
        assert s[-6] in "+-" and s[-3] == ":", s


# ─── Digest escapes scraped text ────────────────────────────────────────────

def test_digest_escapes_scraped_html():
    ev = {"date": d(1), "name": '<a href="https://evil.example">Win</a>', "venue": "Bar & Grill",
          "time": "7 PM", "description": "<img src=x onerror=alert(1)>", "icons": []}
    _, _, html = sd.build_email_body([ev], {ev["date"]: [ev]})
    assert "<a href=\"https://evil.example\">" not in html
    assert "&lt;a href=" in html and "&lt;img" in html and "Bar &amp; Grill" in html
