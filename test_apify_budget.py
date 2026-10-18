"""Apify time and money: Instagram's own slice of the scrape budget, quiet
Facebook pages skipped between retries, and the month's Apify spend in
collection_metadata.json with a warning at 80% of the limit."""
import json
import time
from unittest.mock import MagicMock, patch

import pytest

import collect_events as ce


def _env(monkeypatch, ig=True):
    for k, v in {"FB_POSTS_ENABLED": "1", "APIFY_TOKEN": "t", "OPENAI_API_KEY": "k"}.items():
        monkeypatch.setenv(k, v)
    if ig:
        monkeypatch.setenv("IG_POSTS_ENABLED", "1")
    else:
        monkeypatch.delenv("IG_POSTS_ENABLED", raising=False)


def _venues(monkeypatch, n=3):
    venues = [{"name": f"V{i}", "confidence": "high", "tier": "HIGH", "facebook_page": f"https://facebook.com/v{i}"}
              for i in range(n)]
    monkeypatch.setattr(ce, "_load_venue_list", lambda: (venues, "venues.json"))


# ─── Instagram's slice ──────────────────────────────────────────────────────

def test_fb_posts_leave_instagram_its_minutes(monkeypatch):
    _env(monkeypatch, ig=True)
    assert ce.fb_posts_budget_min() == ce.SCRAPE_BUDGET_MIN - ce.IG_RESERVE_MIN
    _env(monkeypatch, ig=False)
    assert ce.fb_posts_budget_min() == ce.SCRAPE_BUDGET_MIN


def test_fb_posts_stop_at_their_slice_when_instagram_is_next(monkeypatch):
    _env(monkeypatch, ig=True)
    _venues(monkeypatch)
    ce._SOURCE_NOTES.clear()
    # Past FB's slice, inside the whole budget: FB stops, Instagram would still run.
    monkeypatch.setattr(ce, "_RUN_STARTED", time.time() - (ce.fb_posts_budget_min() + 1) * 60)
    monkeypatch.setattr(ce.requests, "post", lambda *a, **k: pytest.fail("scraped past FB's slice"))
    assert ce.fetch_apify_facebook_posts() == []
    assert "leaving Instagram its 10" in ce._SOURCE_NOTES["apify_facebook_posts"]
    assert ce._minutes_in() < ce.SCRAPE_BUDGET_MIN


# ─── Quiet pages ────────────────────────────────────────────────────────────

def test_a_page_quiet_twice_is_skipped_then_retried_every_fourth_run():
    ce._QUIET_PAGES.clear()
    url = "https://facebook.com/quiet"
    for _ in range(ce.QUIET_AFTER):
        assert not ce.quiet_page_skip(url)
        ce.quiet_page_result(url, "Quiet Bar", [])
    runs = [ce.quiet_page_skip(url) for _ in range(ce.QUIET_RETRY_EVERY)]
    assert runs == [True, True, True, False]          # three skipped, the fourth tries
    ce.quiet_page_result(url, "Quiet Bar", [{"text": "Live music Friday"}])
    assert url not in ce._QUIET_PAGES and not ce.quiet_page_skip(url)


def test_quiet_pages_round_trip_through_the_metadata(tmp_path):
    path = tmp_path / "collection_metadata.json"
    path.write_text(json.dumps({"quiet_pages": {"https://facebook.com/a": {"name": "A", "misses": 3, "skips": 1, "since": "2026-10-11"},
                                                "bad": "not a row"}}))
    ce.load_quiet_pages(str(path))
    assert ce._QUIET_PAGES == {"https://facebook.com/a": {"name": "A", "misses": 3, "skips": 1, "since": "2026-10-11"}}
    ce.load_quiet_pages(str(tmp_path / "missing.json"))
    assert ce._QUIET_PAGES == {}


def test_the_fb_loop_skips_quiet_pages_and_lists_them(monkeypatch):
    _env(monkeypatch, ig=False)
    _venues(monkeypatch, n=2)
    ce._SOURCE_NOTES.clear()
    ce._QUIET_PAGES.clear()
    ce._QUIET_PAGES["https://facebook.com/v0"] = {"name": "V0", "misses": 2, "skips": 0, "since": "2026-10-04"}
    asked = []

    def fake_post(url, **kw):
        resp = MagicMock(status_code=200)
        if "facebook-posts-scraper" in url:
            asked.append(kw["json"]["startUrls"][0]["url"])
            resp.json.return_value = []
        else:
            resp.json.return_value = {"choices": [{"message": {"content": "[]"}}]}
        return resp

    with patch("collect_events.requests.post", side_effect=fake_post):
        ce.fetch_apify_facebook_posts(14)
    assert asked == ["https://facebook.com/v1"]
    assert "skipped 1 pages with no posts lately" in ce._SOURCE_NOTES["apify_facebook_posts"]
    assert "V0" in ce._SOURCE_NOTES["apify_facebook_posts"]
    assert ce._QUIET_PAGES["https://facebook.com/v1"]["misses"] == 1   # empty this run: one miss


# ─── Apify spend ────────────────────────────────────────────────────────────

def _get(limits, runs, status=200):
    def get(url, **kw):
        r = MagicMock(status_code=status)
        r.json.return_value = {"data": limits} if "limits" in url else {"data": {"items": runs}}
        return r
    return get


LIMITS = {"current": {"monthlyUsageUsd": 41.237}, "limits": {"maxMonthlyUsageUsd": 50},
          "monthlyUsageCycle": {"startAt": "2026-10-01T00:00:00.000Z", "endAt": "2026-10-31T23:59:59.999Z"}}


def test_apify_spend_reads_the_month_and_this_collects_runs():
    runs = [{"startedAt": "2026-10-14T20:30:00.000Z", "usageTotalUsd": 0.61},
            {"startedAt": "2026-10-14T20:45:00.000Z", "usageTotalUsd": 1.2},
            {"startedAt": "2026-10-11T20:30:00.000Z", "usageTotalUsd": 9.9}]   # an earlier collect
    assert ce.apify_spend("t", "2026-10-14T20:23:00Z", get=_get(LIMITS, runs)) == {
        "month_usd": 41.24, "limit_usd": 50.0, "cycle_end": "2026-10-31", "run_usd": 1.81}


def test_apify_spend_is_left_out_when_apify_doesnt_answer():
    assert ce.apify_spend("t", "x", get=_get(None, [], status=401)) is None

    def boom(*a, **k):
        raise ConnectionError("down")
    assert ce.apify_spend("t", "x", get=boom) is None


def test_eighty_percent_of_the_limit_is_a_warning():
    ce.reset_source_stats()
    ce.note_apify_spend({"month_usd": 39.0, "limit_usd": 50.0, "cycle_end": "2026-10-31", "run_usd": 1.0})
    assert ce._WARNINGS == []
    ce.note_apify_spend({"month_usd": 41.24, "limit_usd": 50.0, "cycle_end": "2026-10-31", "run_usd": 1.0})
    assert ce._WARNINGS and "Apify spend at 82% of the monthly limit" in ce._WARNINGS[0]
    ce.reset_source_stats()
    ce.note_apify_spend({"month_usd": 400.0, "limit_usd": None, "cycle_end": None, "run_usd": None})   # no limit set
    assert ce._WARNINGS == []


# ─── No silent gaps ─────────────────────────────────────────────────────────

def test_a_watched_source_that_comes_back_empty_is_a_warning():
    ce.reset_source_stats()
    assert ce.safe_fetch("apify_instagram_posts", lambda: [], expect_events=True) == []
    assert any("apify_instagram_posts returned 0 events" in w for w in ce._WARNINGS)
    assert ce.get_source_stats()[-1]["status"] == "empty"


def test_a_source_switched_off_on_purpose_is_skipped_quietly(monkeypatch):
    ce.reset_source_stats()
    monkeypatch.delenv("IG_POSTS_ENABLED", raising=False)
    assert ce.safe_fetch("apify_instagram_posts", ce.fetch_apify_instagram_posts, expect_events=True) == []
    assert ce._WARNINGS == []
    assert ce.get_source_stats()[-1]["status"] == "skipped"


def test_every_paid_or_ai_source_is_watched():
    watched = {n for n, _, expect in ce.WEB_SOURCES if expect}
    assert {"gemini_search", "apify_facebook", "apify_eventbrite", "apify_facebook_posts", "apify_instagram_posts"} <= watched


def test_a_page_turning_quiet_warns_once():
    ce.reset_source_stats()
    ce._QUIET_PAGES.clear()
    url = "https://facebook.com/quiet"
    for _ in range(ce.QUIET_AFTER + 2):
        ce.quiet_page_result(url, "Quiet Bar", [])
    assert [w for w in ce._WARNINGS if "Quiet Bar" in w] == [
        f"Facebook page Quiet Bar had no posts {ce.QUIET_AFTER} collects in a row; skipped from now on, "
        f"check its link in venues.json (page={url})"]


def test_the_time_limits_stay_in_order_inside_the_workers_55_minutes():
    import importlib.util, pathlib
    spec = importlib.util.spec_from_file_location("jobs_worker", pathlib.Path(__file__).parent / "scripts" / "jobs_worker.py")
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    stop = worker.TIMEOUTS["collect"] / 60
    # Scraping, then the link check, then the optional steps, with time left
    # to write and upload the outputs before the worker stops the collect.
    assert ce.SCRAPE_BUDGET_MIN - ce.IG_RESERVE_MIN > 0
    assert ce.SCRAPE_BUDGET_MIN < ce.LINK_CHECK_STOP_MIN < ce.COLLECT_DEADLINE_MIN
    assert stop - ce.COLLECT_DEADLINE_MIN >= 8
