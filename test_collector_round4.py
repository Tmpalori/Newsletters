"""Regression tests for the fourth collector review: Chamber dates from the
"Date and Time" block, the city calendar reading into next month, AI-named
festival copies merged, recurring local_events.yaml days in other spellings,
and venues.json winning over the legacy seed in discover_venues."""

import glob
import json
import os
import sys
from datetime import date, timedelta
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, os.path.dirname(__file__))
import collect_events as ce  # noqa: E402
import discover_venues as dv  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


@pytest.fixture(autouse=True)
def _state():
    saved = ce._WINDOW_START, ce._WINDOW_END
    today = date.today()
    ce._WINDOW_START = today
    ce._WINDOW_END = today + timedelta(days=14)
    ce.reset_source_stats()
    yield
    ce._WINDOW_START, ce._WINDOW_END = saved


def _page(status=200, text=""):
    r = MagicMock()
    r.status_code, r.text = status, text
    r.raise_for_status = lambda: None
    return r


# ─── Chamber: the "Date and Time" block ─────────────────────────────────────

def _chamber_detail(title, when, extra=""):
    # GrowthZone's markup, as on the live luncheon page (2026-10-06).
    return (f"<h1>{title}</h1><h5 class='gz-subtitle'>Date and Time</h5><p>"
            f"<span itemprop='startDate'>{when}</span><br>"
            f"<span class='gz-details-time'>11:15 AM - 1:00 PM CDT</span></p>"
            f"<div class='gz-details-description'><p>{extra}</p></div>")


def _run_chamber(monkeypatch, pages):
    listing = "".join(f'<a href="/events/details/{slug}">x</a>' for slug in pages)

    def get(url, **k):
        for slug, html in pages.items():
            if url.endswith(slug):
                return _page(text=html)
        return _page(text=listing)
    monkeypatch.setattr(ce.requests, "get", get)
    return ce.fetch_chamber_events()


def test_chamber_reads_short_month_names(monkeypatch):
    when = date.today() + timedelta(days=8)
    text = when.strftime("%A %b %d, %Y").replace(" 0", " ")  # "Wednesday Oct 14, 2026"
    [ev] = _run_chamber(monkeypatch, {
        "chamber-luncheon-michael-cloud-4547": _chamber_detail("Chamber Luncheon", text)})
    assert ev["date"] == when.isoformat()


def test_chamber_ignores_other_dates_in_the_description(monkeypatch):
    when = date.today() + timedelta(days=9)
    early = date.today() + timedelta(days=2)
    text = when.strftime("%A %b %d, %Y")
    blurb = f"Early-bird tickets end {early.strftime('%B %d, %Y')}."
    [ev] = _run_chamber(monkeypatch, {
        "annual-banquet-4513": _chamber_detail("Annual Banquet", text, blurb)})
    assert ev["date"] == when.isoformat()


def test_chamber_never_falls_back_to_a_date_anywhere_on_the_page(monkeypatch):
    # No "Date and Time" block and no date in the slug: not dated, even
    # though the description mentions one.
    soon = date.today() + timedelta(days=3)
    html = f"<h1>Mixer</h1><p>Sponsors must sign up by {soon.strftime('%B %d, %Y')}.</p>"
    assert _run_chamber(monkeypatch, {"mixer-4600": html}) == []


def test_chamber_link_cap_marks_partial(monkeypatch):
    pages = {f"ev-{i}": "<h1>x</h1>" for i in range(ce.CHAMBER_MAX_PAGES + 3)}
    _run_chamber(monkeypatch, pages)
    reasons = " ".join(ce._SOURCE_PARTIAL.get("chamber", []))
    assert "cap" in reasons and "3 skipped" in reasons


# ─── City calendar: a window that runs into next month ──────────────────────

def _city_detail(title, when):
    return f'<h2 id="x_eventTitle">{title}</h2><p>Date: {when:%B} {when.day}, {when:%Y}</p>'


def test_city_calendar_reads_next_months_events(monkeypatch):
    ce._WINDOW_START, ce._WINDOW_END = date(2026, 11, 29), date(2026, 12, 13)
    seen = []

    def get(url, **k):
        seen.append(url)
        if url.endswith("EID=1"):
            return _page(text=_city_detail("Turkey Trot Recovery Walk", date(2026, 11, 30)))
        if url.endswith("EID=2"):
            return _page(text=_city_detail("Christmas Tree Lighting", date(2026, 12, 5)))
        if "startDate=12/01/2026" in url:
            assert "enddate=12/13/2026" in url
            return _page(text='<a href="/Calendar.aspx?EID=2&month=12&year=2026&day=5&calType=0">b</a>')
        # The default view: today through the end of this month only.
        return _page(text='<a href="/Calendar.aspx?EID=1&month=11&year=2026&day=29&calType=0">a</a>')
    monkeypatch.setattr(ce.requests, "get", get)
    events = ce.fetch_city_calendar()
    assert {e["name"] for e in events} == {"Turkey Trot Recovery Walk", "Christmas Tree Lighting"}
    assert not ce._SOURCE_PARTIAL.get("city_calendar")


def test_city_calendar_next_month_failure_marks_partial(monkeypatch):
    ce._WINDOW_START, ce._WINDOW_END = date(2026, 11, 29), date(2026, 12, 13)

    def get(url, **k):
        if "startDate=" in url:
            raise ce.requests.ConnectionError("reset")
        if "EID=" in url:
            return _page(text=_city_detail("Turkey Trot Recovery Walk", date(2026, 11, 30)))
        return _page(text='<a href="/Calendar.aspx?EID=1">a</a>')
    monkeypatch.setattr(ce.requests, "get", get)
    events = ce.fetch_city_calendar()
    assert [e["name"] for e in events] == ["Turkey Trot Recovery Walk"]
    assert "Dec 2026" in " ".join(ce._SOURCE_PARTIAL.get("city_calendar", []))


def test_city_calendar_one_month_window_makes_one_listing_request(monkeypatch):
    ce._WINDOW_START, ce._WINDOW_END = date(2026, 10, 5), date(2026, 10, 19)
    seen = []

    def get(url, **k):
        seen.append(url)
        return _page(text="<html></html>")
    monkeypatch.setattr(ce.requests, "get", get)
    ce.fetch_city_calendar()
    assert seen == ["https://www.victoriatx.gov/Calendar.aspx"]


# ─── Festival copies with AI-written names ─────────────────────────────────

def _tejas(name, venue, source):
    return {"date": (date.today() + timedelta(days=4)).isoformat(), "name": name, "venue": venue,
            "_source": source}


def test_tejas_fest_copies_merge_into_one_listing():
    # The Oct 2 entries from the committed candidates.json (2026-10-04 run).
    evs = [
        _tejas("Tejas Fest (Moonshine VIP service)", "Tejas Fest (VIP)", "apify_facebook_posts"),
        _tejas("Tejas Fest 2026 (Day 1)", "Downtown Victoria", "apify_facebook_posts"),
        _tejas("Tejasfest (VIP shift)", "Tejasfest VIP (downtown)", "apify_instagram_posts"),
        _tejas("Tejas Fest (Night 1)", "Downtown Victoria", "apify_instagram_posts"),
        _tejas("Tejas Fest 2026 - Main Stage", "Main Stage", "apify_instagram_posts"),
    ]
    for order in (evs, evs[::-1]):
        [ev] = ce.merge_events([dict(e) for e in order], 14, venues=[])
        assert ev["name"] in ("Tejas Fest", "Tejas Fest 2026")
        assert ev["venue"] == "Downtown Victoria"
        assert ev["sources"] == 2


def test_festival_merge_needs_an_ai_named_side_and_a_distinctive_core():
    day = (date.today() + timedelta(days=4)).isoformat()
    # Two bars' "Live Music" the same night stay two events.
    a = {"date": day, "name": "Live Music (Night 1)", "venue": "Main Stage", "_source": "apify_instagram_posts"}
    b = {"date": day, "name": "Live Music", "venue": "Moonshine Drinkery", "_source": "allevents"}
    assert not ce.is_same_event(a, b)
    # A part of the festival is its own listing.
    c = {"date": day, "name": "Chihuahua Races at Tejas Fest", "venue": "Downtown Victoria",
         "_source": "apify_facebook_posts"}
    d = {"date": day, "name": "Tejas Fest 2026 (Day 1)", "venue": "Downtown Victoria",
         "_source": "apify_facebook_posts"}
    assert not ce.is_same_event(c, d)
    # Two specific venues that disagree stay apart.
    e = {"date": day, "name": "Oktoberfest (Day 1)", "venue": "Moonshine Drinkery", "_source": "apify_facebook_posts"}
    f = {"date": day, "name": "Oktoberfest", "venue": "Weber Brewing", "_source": "allevents"}
    assert not ce.is_same_event(e, f)


# ─── local_events.yaml recurring days ──────────────────────────────────────

@pytest.mark.parametrize("value,expected", [
    ("friday", {4}), ("Fridays", {4}), ("Fri.", {4}), ("thur", {3}), ("Thurs", {3}),
    ("tues", {1}), ("friday, saturday", {4, 5}), ("Fri & Sat", {4, 5}),
    (["friday", "saturday"], {4, 5}), ("sat and sun", {5, 6}),
    ("fryday", set()), ("weekends", set()), ("", set()), (None, set()),
])
def test_recurring_days_spellings(value, expected):
    assert ce.recurring_days(value) == expected


def test_recurring_entry_with_plural_day_is_loaded(tmp_path):
    p = tmp_path / "local.yaml"
    p.write_text("recurring:\n  - name: Fish Fry\n    day: Fridays\n")
    evs = ce.load_local_events(str(p))
    assert evs and all(date.fromisoformat(e["date"]).weekday() == 4 for e in evs)


def test_recurring_entry_with_a_day_list_is_loaded(tmp_path):
    p = tmp_path / "local.yaml"
    p.write_text("recurring:\n  - name: Haunted Trail\n    day: [friday, saturday]\n")
    evs = ce.load_local_events(str(p))
    assert evs and {date.fromisoformat(e["date"]).weekday() for e in evs} == {4, 5}


def test_recurring_entry_with_unknown_day_warns(tmp_path):
    p = tmp_path / "local.yaml"
    p.write_text("recurring:\n  - name: Fish Fry\n    day: fryday\n")
    assert ce.load_local_events(str(p)) == []
    assert any("unknown day" in w for w in ce._WARNINGS)


@pytest.mark.parametrize("path", ["local_events.yaml"] + sorted(
    os.path.relpath(p, HERE) for p in glob.glob(os.path.join(HERE, "towns", "*", "local_events.yaml"))))
def test_shipped_local_events_recurring_days_all_resolve(path):
    import yaml
    with open(os.path.join(HERE, path)) as f:
        data = ce._coerce_yaml_events(yaml.safe_load(f) or {})
    for ev in data.get("recurring") or []:
        assert ce.recurring_days(ev.get("day")), ev.get("name")


# ─── discover_venues: venues.json wins over the legacy seed ─────────────────

def test_merge_keeps_venues_json_over_the_seed():
    seed = [{"name": "Weber Brewing", "address": "1 Main St", "confidence": "medium",
             "facebook_page": "https://www.facebook.com/WeberBrewing", "source": "seed"}]
    existing = [{"name": "Weber Brewing", "address": "1 Main St", "tier": "HIGH", "confidence": "high",
                 "facebook_page": "https://www.facebook.com/p/Weber-Brewing-61555658972596/"}]
    [v] = dv.merge_venues(seed, [], existing)
    assert v["tier"] == "HIGH" and v["confidence"] == "high"
    assert v["facebook_page"].endswith("/p/Weber-Brewing-61555658972596/")


def test_discover_aborts_without_writing_when_venues_json_is_unreadable(monkeypatch, tmp_path):
    monkeypatch.delenv("APIFY_TOKEN", raising=False)
    (tmp_path / "facebook_venues.json").write_text(json.dumps([{"name": "Seed Bar", "address": "2 Main"}]))
    (tmp_path / "venues.json").write_text("[{not json")
    summary = dv.discover_and_update(repo_root=str(tmp_path))
    assert summary.get("aborted")
    assert (tmp_path / "venues.json").read_text() == "[{not json"
