"""Unit tests for the Facebook posts scraper integration.

Covers:
  - _apify_hard_limit_tripped detector
  - _venue_high_confidence filter
  - fetch_apify_facebook_posts feature-flag and tombstone gating
  - fetch_apify_facebook_events tombstone gating + maxEvents=25
  - main() resets the tombstone

Network is stubbed via monkey-patched requests.post.
"""
import json
import os
import sys
from datetime import date, timedelta
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.dirname(__file__))
import collect_events as ce


# ─── Fixtures ───────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def reset_state(monkeypatch, tmp_path):
    """Reset module state and provide a tmp facebook_venues.json."""
    ce._APIFY_LIMIT_TRIPPED = False
    ce._WINDOW_START = date.today()
    ce._WINDOW_END = date.today() + timedelta(days=14)

    # Clean env between tests
    for k in ("APIFY_TOKEN", "OPENAI_API_KEY", "FB_POSTS_ENABLED"):
        monkeypatch.delenv(k, raising=False)

    # Drop a venues file next to collect_events.py
    venues = [
        {
            "name": "Aero Crafters",
            "facebook_page": "https://www.facebook.com/aerocrafters",
            "confidence": "high",
        },
        {
            "name": "Moonshine Drinkery",
            "facebook_page": "https://www.facebook.com/moonshinedrinkery",
            "confidence": "high",
        },
        {
            "name": "Froggy's Grub & Pub",
            "facebook_page": "https://www.facebook.com/froggys",
            "confidence": "medium",
        },
        {"name": "No URL Venue", "confidence": "high"},  # missing facebook_page
    ]
    # The collector reads venues.json from --local-dir (ce._VENUE_DIR)
    # first, so the fixture goes in a temp dir and the repo's own
    # venues.json is never touched.
    monkeypatch.setattr(ce, "_VENUE_DIR", str(tmp_path))
    with open(tmp_path / "venues.json", "w") as f:
        json.dump(venues, f)


# ─── Tests ──────────────────────────────────────────────────────────────────


def test_hard_limit_detector_positive():
    body = '{"error":{"type":"usage-hard-limit","message":"Monthly usage hard limit exceeded."}}'
    assert ce._apify_hard_limit_tripped(body) is True


def test_hard_limit_detector_case_insensitive():
    assert ce._apify_hard_limit_tripped("MONTHLY USAGE HARD LIMIT") is True


def test_hard_limit_detector_negative_other_403():
    assert ce._apify_hard_limit_tripped('{"error":"forbidden"}') is False
    assert ce._apify_hard_limit_tripped("") is False
    assert ce._apify_hard_limit_tripped(None) is False


def test_venue_high_confidence_filter():
    venues = [
        {"name": "A", "confidence": "high"},
        {"name": "B", "confidence": "medium"},
        {"name": "C", "confidence": "HIGH"},  # case-insensitive
        {"name": "D"},  # missing
    ]
    out = ce._venue_high_confidence(venues)
    assert {v["name"] for v in out} == {"A", "C"}


def test_posts_scraper_disabled_by_default():
    out = ce.fetch_apify_facebook_posts(14)
    assert out == []


def test_posts_scraper_no_apify_token(monkeypatch):
    monkeypatch.setenv("FB_POSTS_ENABLED", "1")
    out = ce.fetch_apify_facebook_posts(14)
    assert out == []


def test_posts_scraper_no_openai_key(monkeypatch):
    monkeypatch.setenv("FB_POSTS_ENABLED", "1")
    monkeypatch.setenv("APIFY_TOKEN", "fake")
    out = ce.fetch_apify_facebook_posts(14)
    assert out == []


def test_posts_scraper_tombstone_short_circuits(monkeypatch):
    monkeypatch.setenv("FB_POSTS_ENABLED", "1")
    monkeypatch.setenv("APIFY_TOKEN", "fake")
    monkeypatch.setenv("OPENAI_API_KEY", "fake")
    ce._APIFY_LIMIT_TRIPPED = True

    with patch("collect_events.requests.post") as mock_post:
        out = ce.fetch_apify_facebook_posts(14)
    assert out == []
    mock_post.assert_not_called()


def test_posts_scraper_403_hard_limit_trips_tombstone(monkeypatch):
    monkeypatch.setenv("FB_POSTS_ENABLED", "1")
    monkeypatch.setenv("APIFY_TOKEN", "fake")
    monkeypatch.setenv("OPENAI_API_KEY", "fake")

    fake_resp = MagicMock()
    fake_resp.status_code = 403
    fake_resp.text = '{"error":"Monthly usage hard limit exceeded"}'

    with patch("collect_events.requests.post", return_value=fake_resp):
        out = ce.fetch_apify_facebook_posts(14)

    assert out == []
    assert ce._APIFY_LIMIT_TRIPPED is True


def test_posts_scraper_happy_path(monkeypatch):
    """Stub Apify + OpenAI — verify event normalization end-to-end."""
    monkeypatch.setenv("FB_POSTS_ENABLED", "1")
    monkeypatch.setenv("APIFY_TOKEN", "fake")
    monkeypatch.setenv("OPENAI_API_KEY", "fake")

    target_date = (date.today() + timedelta(days=3)).strftime("%Y-%m-%d")

    # Two responses needed per venue: posts response, then OpenAI response.
    # We only have 3 high-conf venues here (Aero, Moonshine, "No URL Venue").
    # No URL Venue is skipped before any HTTP call.
    posts_payload = [
        {"text": "Live music tonight 8pm with The Rangers", "url": "https://fb.com/post/1", "time": "2026-04-25T15:00:00"},
        {"text": "Photo dump from last weekend", "url": "https://fb.com/post/2", "time": "2026-04-24T15:00:00"},
    ]
    ai_payload = {
        "choices": [{
            "message": {
                "content": json.dumps([
                    {
                        "date": target_date,
                        "name": "Live Music with The Rangers",
                        "time": "8:00 PM",
                        "description": "Country band live on the patio.",
                        "free": False,
                        "source_post_index": 1,
                    }
                ])
            }
        }]
    }

    call_log = []

    def fake_post(url, **kwargs):
        call_log.append(url)
        resp = MagicMock()
        resp.status_code = 200
        resp.raise_for_status = MagicMock()
        if "facebook-posts-scraper" in url:
            resp.json.return_value = posts_payload
        elif "api.openai.com" in url:
            resp.json.return_value = ai_payload
        else:
            resp.status_code = 500
        return resp

    with patch("collect_events.requests.post", side_effect=fake_post):
        out = ce.fetch_apify_facebook_posts(14)

    # 2 high-confidence venues with URLs (Aero, Moonshine) → 2 Apify + 2 OpenAI = 4 calls
    assert len([u for u in call_log if "facebook-posts" in u]) == 2
    assert len([u for u in call_log if "api.openai.com" in u]) == 2

    # Each venue produced one event from the stub
    assert len(out) == 2
    ev = out[0]
    assert ev["date"] == target_date
    assert ev["name"] == "Live Music with The Rangers"
    assert ev["time"] == "8:00 PM"
    assert ev["venue"] in ("Aero Crafters", "Moonshine Drinkery")
    assert ev["url"] == "https://fb.com/post/1"  # via source_post_index
    assert "music" in ev["icons"]


def test_posts_scraper_filters_out_of_window_events(monkeypatch):
    """The model may return dates outside the collection window — drop them."""
    monkeypatch.setenv("FB_POSTS_ENABLED", "1")
    monkeypatch.setenv("APIFY_TOKEN", "fake")
    monkeypatch.setenv("OPENAI_API_KEY", "fake")

    far_future = (date.today() + timedelta(days=400)).strftime("%Y-%m-%d")
    ai_payload = {
        "choices": [{
            "message": {
                "content": json.dumps([
                    {"date": far_future, "name": "Way too far out", "free": False},
                    {"date": "not-a-date", "name": "Bad date", "free": False},
                    {"date": "", "name": "Missing date", "free": False},
                ])
            }
        }]
    }

    def fake_post(url, **kwargs):
        resp = MagicMock()
        resp.status_code = 200
        resp.raise_for_status = MagicMock()
        if "facebook-posts-scraper" in url:
            resp.json.return_value = [{"text": "post", "time": "2026-04-25T00:00:00"}]
        else:
            resp.json.return_value = ai_payload
        return resp

    with patch("collect_events.requests.post", side_effect=fake_post):
        out = ce.fetch_apify_facebook_posts(14)
    assert out == []


def test_posts_scraper_handles_actor_500(monkeypatch):
    monkeypatch.setenv("FB_POSTS_ENABLED", "1")
    monkeypatch.setenv("APIFY_TOKEN", "fake")
    monkeypatch.setenv("OPENAI_API_KEY", "fake")

    fake_resp = MagicMock()
    fake_resp.status_code = 500
    fake_resp.text = "internal server error"

    with patch("collect_events.requests.post", return_value=fake_resp):
        out = ce.fetch_apify_facebook_posts(14)
    assert out == []
    assert ce._APIFY_LIMIT_TRIPPED is False  # not a hard-limit


def test_fb_posts_env_cap_limits_venues(monkeypatch):
    """FB_POSTS_MAX_VENUES env var caps the FB scrape to its first N
    high-confidence venues (venues.json order)."""
    monkeypatch.setenv("FB_POSTS_ENABLED", "1")
    monkeypatch.setenv("APIFY_TOKEN", "fake")
    monkeypatch.setenv("OPENAI_API_KEY", "fake")
    monkeypatch.setenv("FB_POSTS_MAX_VENUES", "1")

    captured_urls = []

    def fake_post(url, **kwargs):
        resp = MagicMock()
        resp.status_code = 200
        resp.raise_for_status = MagicMock()
        if "facebook-posts-scraper" in url:
            captured_urls.append(kwargs.get("json", {}).get("startUrls", [{}])[0].get("url"))
            resp.json.return_value = []
        elif "api.openai.com" in url:
            resp.json.return_value = {"choices": [{"message": {"content": "[]"}}]}
        return resp

    with patch("collect_events.requests.post", side_effect=fake_post):
        ce.fetch_apify_facebook_posts(14)

    # Fixture has 2 high-confidence venues with URLs (Aero, Moonshine).
    # Cap of 1 → only the first is scraped.
    assert len(captured_urls) == 1
    assert captured_urls[0] == "https://www.facebook.com/aerocrafters"


def test_fb_posts_no_env_means_no_cap(monkeypatch):
    """Default _FB_POSTS_MAX_VENUES is None — no cap unless env is set,
    matching shipped behavior before the IG cost-cap addition."""
    monkeypatch.setenv("FB_POSTS_ENABLED", "1")
    monkeypatch.setenv("APIFY_TOKEN", "fake")
    monkeypatch.setenv("OPENAI_API_KEY", "fake")
    monkeypatch.delenv("FB_POSTS_MAX_VENUES", raising=False)

    assert ce._FB_POSTS_MAX_VENUES is None

    captured_urls = []

    def fake_post(url, **kwargs):
        resp = MagicMock()
        resp.status_code = 200
        resp.raise_for_status = MagicMock()
        if "facebook-posts-scraper" in url:
            captured_urls.append(kwargs.get("json", {}).get("startUrls", [{}])[0].get("url"))
            resp.json.return_value = []
        elif "api.openai.com" in url:
            resp.json.return_value = {"choices": [{"message": {"content": "[]"}}]}
        return resp

    with patch("collect_events.requests.post", side_effect=fake_post):
        ce.fetch_apify_facebook_posts(14)

    # Both Aero + Moonshine scraped (Froggy's = medium, "No URL Venue" = no URL).
    assert len(captured_urls) == 2


def test_fb_posts_invalid_env_disables_cap(monkeypatch):
    """Non-positive / unparseable FB_POSTS_MAX_VENUES values fall back to
    the default (None = no cap), so a misconfigured workflow var can't
    silently zero out the FB scrape."""
    monkeypatch.setenv("FB_POSTS_ENABLED", "1")
    monkeypatch.setenv("APIFY_TOKEN", "fake")
    monkeypatch.setenv("OPENAI_API_KEY", "fake")

    for bad in ("not-a-number", "", "0", "-2"):
        captured_urls = []
        monkeypatch.setenv("FB_POSTS_MAX_VENUES", bad)
        ce._QUIET_PAGES.clear()   # each pass is its own run; empty pages would turn quiet

        def fake_post(url, **kwargs):
            resp = MagicMock()
            resp.status_code = 200
            resp.raise_for_status = MagicMock()
            if "facebook-posts-scraper" in url:
                captured_urls.append(kwargs.get("json", {}).get("startUrls", [{}])[0].get("url"))
                resp.json.return_value = []
            elif "api.openai.com" in url:
                resp.json.return_value = {"choices": [{"message": {"content": "[]"}}]}
            return resp

        with patch("collect_events.requests.post", side_effect=fake_post):
            ce.fetch_apify_facebook_posts(14)
        assert len(captured_urls) == 2, f"bad={bad!r} got {captured_urls}"


def test_resolve_int_env_helper(monkeypatch):
    """Direct unit-test of the env-int resolver used by both caps."""
    monkeypatch.delenv("FOO_CAP", raising=False)
    assert ce._resolve_int_env("FOO_CAP", 10) == 10
    assert ce._resolve_int_env("FOO_CAP", None) is None

    for val, expected in [
        ("5", 5),
        ("  7  ", 7),
        ("0", 10),       # zero → default
        ("-3", 10),      # negative → default
        ("abc", 10),     # garbage → default
        ("", 10),        # empty → default
    ]:
        monkeypatch.setenv("FOO_CAP", val)
        assert ce._resolve_int_env("FOO_CAP", 10) == expected, f"{val!r}"


def test_events_scraper_max_events_default_and_override(monkeypatch):
    """maxEvents defaults to 50 (Oct 2026 probe: 39/40 results were Victoria
    events, 25 missed most of the window) and FB_EVENTS_MAX overrides it."""
    monkeypatch.setenv("APIFY_TOKEN", "fake")
    monkeypatch.delenv("FB_EVENTS_MAX", raising=False)

    captured = {}

    def fake_post(url, **kwargs):
        captured["json"] = kwargs.get("json")
        resp = MagicMock()
        resp.status_code = 200
        resp.json.return_value = []
        return resp

    with patch("collect_events.requests.post", side_effect=fake_post):
        ce.fetch_apify_facebook_events(14)

    assert captured["json"]["maxEvents"] == 50

    monkeypatch.setenv("FB_EVENTS_MAX", "30")
    with patch("collect_events.requests.post", side_effect=fake_post):
        ce.fetch_apify_facebook_events(14)
    assert captured["json"]["maxEvents"] == 30


def test_events_scraper_tombstone_short_circuits(monkeypatch):
    monkeypatch.setenv("APIFY_TOKEN", "fake")
    ce._APIFY_LIMIT_TRIPPED = True

    with patch("collect_events.requests.post") as mock_post:
        out = ce.fetch_apify_facebook_events(14)

    assert out == []
    mock_post.assert_not_called()


def test_events_scraper_403_hard_limit_trips_tombstone(monkeypatch):
    monkeypatch.setenv("APIFY_TOKEN", "fake")

    fake_resp = MagicMock()
    fake_resp.status_code = 403
    fake_resp.text = '{"error":"Monthly usage hard limit exceeded"}'

    with patch("collect_events.requests.post", return_value=fake_resp):
        ce.fetch_apify_facebook_events(14)

    assert ce._APIFY_LIMIT_TRIPPED is True
