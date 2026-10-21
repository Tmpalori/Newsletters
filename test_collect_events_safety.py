"""Safety tests for collect_events.py:

  - load_local_events tolerates malformed YAML, missing files, and
    bad individual entries without crashing the run.
  - main() honors --candidates-only and never overwrites the curated
    fallback at docs/events.json.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import date, timedelta

import pytest

sys.path.insert(0, os.path.dirname(__file__))
import collect_events  # noqa: E402


# ─── load_local_events robustness ───────────────────────────────────────────


@pytest.fixture(autouse=True)
def _set_window():
    """All scrapers read these module globals; tests need them set."""
    today = date.today()
    collect_events._WINDOW_START = today
    collect_events._WINDOW_END = today + timedelta(days=14)
    yield


def test_load_local_events_returns_empty_for_missing_file(tmp_path):
    missing = tmp_path / "nope.yaml"
    out = collect_events.load_local_events(str(missing), days_ahead=14)
    assert out == []


def test_load_local_events_returns_empty_for_malformed_yaml(tmp_path):
    bad = tmp_path / "bad.yaml"
    # Tab-indented + unclosed brace = a YAML parser error.
    bad.write_text("recurring:\n\t- name: 'Bad'\n  day: 'monday'\n  {\n")
    out = collect_events.load_local_events(str(bad), days_ahead=14)
    assert out == []


def test_load_local_events_returns_empty_when_root_is_not_mapping(tmp_path):
    bad = tmp_path / "list_root.yaml"
    bad.write_text("- not\n- a\n- mapping\n")
    out = collect_events.load_local_events(str(bad), days_ahead=14)
    assert out == []


def test_load_local_events_skips_malformed_recurring_entry(tmp_path):
    """One bad entry must not poison the rest of the list."""
    yml = tmp_path / "events.yaml"
    yml.write_text(
        "recurring:\n"
        "  - name: 'Bad start_date'\n"
        "    day: 'monday'\n"
        "    start_date: 'not-a-date'\n"
        "  - name: 'Good Recurring'\n"
        "    day: 'monday'\n"
        "    venue: 'Vic Hall'\n"
    )
    out = collect_events.load_local_events(str(yml), days_ahead=14)
    names = [e["name"] for e in out]
    # Bad entry skipped, good one survived (may produce one or more dates
    # depending on what 'today' is — we only care that it's there).
    assert "Bad start_date" not in names
    assert any(n == "Good Recurring" for n in names)


def test_load_local_events_continues_on_one_time_event_error(tmp_path):
    yml = tmp_path / "events.yaml"
    today = collect_events._WINDOW_START
    yml.write_text(
        "events:\n"
        f"  - date: '{today.isoformat()}'\n"
        "    name: 'In Window'\n"
        "    venue: 'A'\n"
        "  - date: 'garbage-date'\n"
        "    name: 'Should Be Skipped'\n"
        "    venue: 'B'\n"
    )
    out = collect_events.load_local_events(str(yml), days_ahead=14)
    names = {e["name"] for e in out}
    assert "In Window" in names
    assert "Should Be Skipped" not in names


# ─── --candidates-only behavior ─────────────────────────────────────────────


def test_candidates_only_does_not_overwrite_events_json(tmp_path, monkeypatch):
    """The curated fallback at docs/events.json must survive a CI run."""
    # Pre-existing curated payload that the admin already published.
    events_path = tmp_path / "events.json"
    curated = {
        "last_updated": "2026-04-20T00:00:00-05:00",
        "events": [{"date": "2026-04-22", "name": "Curated Pick", "venue": "X"}],
        "new_and_notable": [{"name": "Newly Opened Cafe"}],
        "sponsor": {"name": "Sponsor Co"},
    }
    events_path.write_text(json.dumps(curated))

    candidates_path = tmp_path / "candidates.json"
    local_dir = tmp_path
    (local_dir / "local_events.yaml").write_text("recurring: []\nevents: []\n")
    (local_dir / "extras.yaml").write_text("new_and_notable: []\nsponsor: null\n")

    # Stub all the network-bound scrapers so the run is hermetic.
    for fn_name in [
        "fetch_google_sheet_events", "fetch_city_calendar", "fetch_chamber_events",
        "fetch_library_events", "fetch_moonshine_events", "fetch_vtx_artwalk",
        "fetch_jwelch_events", "fetch_theatre_victoria_events",
        "fetch_generals_events", "fetch_allevents_events",
        "fetch_apify_facebook_events", "fetch_apify_facebook_groups", "fetch_apify_facebook_posts", "fetch_apify_eventbrite_events",
        "fetch_apify_instagram_posts",
    ]:
        if hasattr(collect_events, fn_name):
            monkeypatch.setattr(collect_events, fn_name, lambda *a, **kw: [])

    # Build argv for --candidates-only mode.
    argv = [
        "collect_events.py",
        "--output", str(events_path),
        "--candidates", str(candidates_path),
        "--local-dir", str(local_dir),
        "--days", "14",
        "--skip-ai",
        "--candidates-only",
    ]
    monkeypatch.setattr(sys, "argv", argv)
    collect_events.main()

    # docs/events.json must be unchanged.
    after = json.loads(events_path.read_text())
    assert after == curated, (
        "--candidates-only must NOT overwrite the curated fallback events.json"
    )

    # candidates.json should have been written (possibly empty events).
    assert candidates_path.exists()
    cand = json.loads(candidates_path.read_text())
    assert "events" in cand


# The collect itself runs on each town's jobs worker (scripts/jobs_worker.py
# job_collect, which passes --candidates-only and uploads only candidates,
# metadata and the enrichment cache): test_jobs_worker.py pins that.


def test_safe_fetch_records_per_source_stats():
    """safe_fetch should append one entry per call to the per-run stats list,
    with the right status (ok/empty/error). The admin Sources tab consumes
    this via collection_metadata.json."""
    collect_events.reset_source_stats()

    def good():
        return [{"a": 1}, {"a": 2}, {"a": 3}]

    def empty():
        return []

    def boom():
        raise RuntimeError("kaboom")

    collect_events.safe_fetch("good_one", good)
    collect_events.safe_fetch("empty_one", empty, expect_events=False)
    collect_events.safe_fetch("crashy_one", boom)

    stats = collect_events.get_source_stats()
    by_name = {s["name"]: s for s in stats}
    assert by_name["good_one"]["count"] == 3
    assert by_name["good_one"]["status"] == "ok"
    assert by_name["empty_one"]["count"] == 0
    assert by_name["empty_one"]["status"] == "empty"
    assert by_name["crashy_one"]["count"] == 0
    assert by_name["crashy_one"]["status"] == "error"
    assert "kaboom" in by_name["crashy_one"]["message"]


def test_main_writes_collection_metadata_json(tmp_path, monkeypatch):
    """The new collection_metadata.json must be written next to candidates.json
    and must include per-source stats for the admin Sources tab."""
    events_path = tmp_path / "events.json"
    candidates_path = tmp_path / "candidates.json"
    local_dir = tmp_path
    (local_dir / "local_events.yaml").write_text("recurring: []\nevents: []\n")
    (local_dir / "extras.yaml").write_text("new_and_notable: []\nsponsor: null\n")

    for fn_name in [
        "fetch_google_sheet_events", "fetch_city_calendar", "fetch_chamber_events",
        "fetch_library_events", "fetch_moonshine_events", "fetch_vtx_artwalk",
        "fetch_jwelch_events", "fetch_theatre_victoria_events",
        "fetch_generals_events", "fetch_allevents_events",
        "fetch_apify_facebook_events", "fetch_apify_facebook_groups", "fetch_apify_facebook_posts", "fetch_apify_eventbrite_events",
        "fetch_apify_instagram_posts",
    ]:
        if hasattr(collect_events, fn_name):
            monkeypatch.setattr(collect_events, fn_name, lambda *a, **kw: [])

    argv = [
        "collect_events.py",
        "--output", str(events_path),
        "--candidates", str(candidates_path),
        "--local-dir", str(local_dir),
        "--days", "14",
        "--skip-ai",
        "--candidates-only",
    ]
    monkeypatch.setattr(sys, "argv", argv)
    collect_events.main()

    metadata_path = tmp_path / "collection_metadata.json"
    assert metadata_path.exists(), "collection_metadata.json should be written"
    meta = json.loads(metadata_path.read_text())
    assert "last_run_at" in meta
    assert "sources" in meta
    assert isinstance(meta["sources"], list)
    # Sanity: at least the local_events entry should be present.
    names = {s["name"] for s in meta["sources"]}
    assert "local_events" in names
    # raw_count is the sum of per-source counts; must be a non-negative int.
    assert isinstance(meta["raw_count"], int)
    assert meta["raw_count"] >= 0


def test_default_mode_still_writes_events_json(tmp_path, monkeypatch):
    """Backward-compat: a manual run without --candidates-only still updates
    docs/events.json (this is what local dev workflows depend on)."""
    events_path = tmp_path / "events.json"
    candidates_path = tmp_path / "candidates.json"
    local_dir = tmp_path
    (local_dir / "local_events.yaml").write_text("recurring: []\nevents: []\n")
    (local_dir / "extras.yaml").write_text("new_and_notable: []\nsponsor: null\n")

    for fn_name in [
        "fetch_google_sheet_events", "fetch_city_calendar", "fetch_chamber_events",
        "fetch_library_events", "fetch_moonshine_events", "fetch_vtx_artwalk",
        "fetch_jwelch_events", "fetch_theatre_victoria_events",
        "fetch_generals_events", "fetch_allevents_events",
        "fetch_apify_facebook_events", "fetch_apify_facebook_groups", "fetch_apify_facebook_posts", "fetch_apify_eventbrite_events",
        "fetch_apify_instagram_posts",
    ]:
        if hasattr(collect_events, fn_name):
            monkeypatch.setattr(collect_events, fn_name, lambda *a, **kw: [])

    argv = [
        "collect_events.py",
        "--output", str(events_path),
        "--candidates", str(candidates_path),
        "--local-dir", str(local_dir),
        "--days", "14",
        "--skip-ai",
    ]
    monkeypatch.setattr(sys, "argv", argv)
    collect_events.main()

    assert events_path.exists()
    out = json.loads(events_path.read_text())
    # Default mode must still build the standard payload shape.
    assert "events" in out
    assert "new_and_notable" in out
    assert "sponsor" in out
