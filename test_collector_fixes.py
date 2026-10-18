"""Regression tests for the Oct 2026 collector review:

  - a YAML syntax error in local_events.yaml fails the run before
    candidates.json is written; malformed-but-parseable entries are skipped
  - the real local_events.yaml parses and yields events
  - FB/IG post loops stop at the scrape time budget
  - Apify run-sync calls set the actor's own timeout
  - enrichment cache entries are per venue
  - AI review results are matched by id, not position
  - Google Sheet rows are curated like YAML entries
  - past (backfilled) events skip the AI review
  - warnings and per-source status reach collection_metadata.json and
    candidates.json (Slack summary, auto-publish retirement)
"""

import json
import os
import sys
from datetime import date, timedelta

import pytest
import yaml

sys.path.insert(0, os.path.dirname(__file__))
import collect_events as ce  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


@pytest.fixture(autouse=True)
def _window():
    today = date.today()
    ce._WINDOW_START = today
    ce._WINDOW_END = today + timedelta(days=14)
    ce._RUN_STARTED = None
    ce.reset_source_stats()
    yield
    ce._RUN_STARTED = None


def d(n):
    return (date.today() + timedelta(days=n)).isoformat()


_SCRAPERS = [
    "fetch_google_sheet_events", "fetch_city_calendar", "fetch_chamber_events",
    "fetch_library_events", "fetch_moonshine_events", "fetch_vtx_artwalk",
    "fetch_jwelch_events", "fetch_theatre_victoria_events",
    "fetch_generals_events", "fetch_allevents_events", "fetch_gemini_events",
    "fetch_apify_facebook_events", "fetch_apify_facebook_posts", "fetch_apify_eventbrite_events",
    "fetch_apify_instagram_posts", "fetch_gemini_notable",
]


def _run_main(tmp_path, monkeypatch, yaml_text, extra_args=(), scrapers=None):
    (tmp_path / "local_events.yaml").write_text(yaml_text)
    (tmp_path / "extras.yaml").write_text("new_and_notable: []\nsponsor: null\n")
    for fn in _SCRAPERS:
        monkeypatch.setattr(ce, fn, (scrapers or {}).get(fn, lambda *a, **k: []))
    monkeypatch.setattr(ce, "_load_venue_list", lambda: ([], None))
    monkeypatch.setattr(sys, "argv", [
        "collect_events.py", "--output", str(tmp_path / "events.json"),
        "--candidates", str(tmp_path / "candidates.json"), "--local-dir", str(tmp_path),
        "--days", "14", "--candidates-only", *extra_args,
    ])
    ce.main()


# ─── local_events.yaml ──────────────────────────────────────────────────────

def test_yaml_syntax_error_fails_the_run_before_writing_candidates(tmp_path, monkeypatch):
    (tmp_path / "candidates.json").write_text('{"last_updated": "old", "events": []}')
    bad = "events:\n  - date: '2026-10-10'\n    name: Fun Day\n    description: Games: fun for all\n"
    with pytest.raises(SystemExit) as exc:
        _run_main(tmp_path, monkeypatch, bad)
    assert exc.value.code not in (0, None)
    assert json.loads((tmp_path / "candidates.json").read_text())["last_updated"] == "old"


def test_yaml_root_not_a_mapping_fails_the_run(tmp_path, monkeypatch):
    (tmp_path / "candidates.json").write_text('{"last_updated": "old", "events": []}')
    with pytest.raises(SystemExit):
        _run_main(tmp_path, monkeypatch, "- a\n- b\n")
    assert json.loads((tmp_path / "candidates.json").read_text())["last_updated"] == "old"


def test_malformed_entries_are_skipped_not_fatal(tmp_path):
    yml = tmp_path / "e.yaml"
    yml.write_text(
        "recurring:\n"
        "  - name: Blank Day\n"
        "    day:\n"
        "  - name: Good Weekly\n"
        f"    day: {date.today().strftime('%A').lower()}\n"
        "events:\n"
        "  - just a string\n"
        f"  - date: '{d(1)}'\n"
        "    name: Good One\n"
    )
    names = {e["name"] for e in ce.load_local_events(str(yml))}
    assert names == {"Good Weekly", "Good One"}


def test_real_local_events_yaml_parses_and_yields_events():
    path = os.path.join(HERE, "local_events.yaml")
    with open(path) as f:
        assert isinstance(yaml.safe_load(f), dict)
    ce._WINDOW_START = date.today() - timedelta(days=7)
    assert len(ce.load_local_events(path)) > 0


# ─── FB / IG post loops: scrape time budget ─────────────────────────────────

def _post_env(monkeypatch):
    for k, v in {"FB_POSTS_ENABLED": "1", "IG_POSTS_ENABLED": "1", "APIFY_TOKEN": "t", "OPENAI_API_KEY": "k"}.items():
        monkeypatch.setenv(k, v)
    venues = [{"name": f"V{i}", "confidence": "high", "tier": "HIGH", "facebook_page": f"https://facebook.com/v{i}",
               "instagram": f"https://instagram.com/v{i}"} for i in range(3)]
    monkeypatch.setattr(ce, "_load_venue_list", lambda: (venues, "venues.json"))


@pytest.mark.parametrize("fn,name", [("fetch_apify_facebook_posts", "apify_facebook_posts"),
                                     ("fetch_apify_instagram_posts", "apify_instagram_posts")])
def test_post_loops_stop_at_the_scrape_budget(monkeypatch, fn, name):
    _post_env(monkeypatch)
    monkeypatch.setattr(ce, "_RUN_STARTED", __import__("time").time() - (ce.SCRAPE_BUDGET_MIN + 1) * 60)
    monkeypatch.setattr(ce.requests, "post", lambda *a, **k: pytest.fail("scraped past the budget"))
    assert getattr(ce, fn)() == []
    assert "time limit" in ce._SOURCE_NOTES.get(name, "")


# ─── Apify actor timeout ────────────────────────────────────────────────────

class _Resp:
    status_code = 200
    text = "[]"

    def json(self):
        return []


def test_apify_run_sync_urls_set_the_actor_timeout(monkeypatch):
    _post_env(monkeypatch)
    urls = []

    def post(url, **kw):
        urls.append(url)
        return _Resp()

    monkeypatch.setattr(ce.requests, "post", post)
    ce._run_apify_search("a~b", {}, "t")
    ce.fetch_apify_eventbrite_events()
    ce.fetch_apify_facebook_posts()
    ce.fetch_apify_instagram_posts()
    assert len(urls) >= 4
    for u in urls:
        assert f"timeout={ce.APIFY_ACTOR_TIMEOUT}" in u, u
    assert ce.APIFY_ACTOR_TIMEOUT < ce.APIFY_RUN_TIMEOUT


def test_discover_venues_sets_the_actor_timeout():
    import discover_venues as dv
    urls = []

    def post(url, **kw):
        urls.append(url)
        return _Resp()

    dv.run_apify_discovery("t", http_post=post, sleep=lambda s: None)
    assert urls and all(f"timeout={dv.APIFY_ACTOR_TIMEOUT}" in u for u in urls)
    assert dv.APIFY_ACTOR_TIMEOUT < dv.APIFY_PER_CALL_TIMEOUT


# ─── Enrichment cache is per venue ──────────────────────────────────────────

def test_enrichment_cache_does_not_cross_venues(monkeypatch, tmp_path):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    a = {"date": d(2), "name": "Trivia Night", "venue": "Bar A", "time": "", "address": "", "description": "", "url": ""}
    b = {**a, "venue": "Bar B"}
    cache = tmp_path / "c.json"
    cache.write_text(json.dumps({ce._enrich_key(a): {"checked": d(0), "found": {"address": "1 A St", "time": "7:00 PM"}}}))
    out = ce.enrich_thin_events([dict(a), dict(b)], cache_path=str(cache))
    assert out[0]["address"] == "1 A St"
    assert out[1]["address"] == "" and out[1]["time"] == ""


# ─── AI review matched by id ────────────────────────────────────────────────

def _review_events():
    return [{"date": d(1), "name": f"Event {i}", "time": "", "venue": f"V{i}", "description": "x", "icons": []}
            for i in range(3)]


def test_ai_review_sends_ids_and_matches_reordered_results(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "k")
    sent = {}

    def chat(api_key, messages, max_tokens, timeout=60):
        payload = json.loads(messages[1]["content"].split("\n\n", 1)[1])
        sent["ids"] = [p["id"] for p in payload]
        # Model returns them reversed, ids echoed.
        return json.dumps([{"id": p["id"], "description": f"About {p['name']}", "icons": ["music"],
                            "free": False, "appeal": 3, "keep": True} for p in reversed(payload)])

    monkeypatch.setattr(ce, "_openai_chat", chat)
    out = ce.ai_review(_review_events())
    assert sent["ids"] == [1, 2, 3]
    assert [e["description"] for e in out] == ["About Event 0", "About Event 1", "About Event 2"]


def test_ai_review_skips_missing_and_duplicate_ids(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "k")
    reply = [{"id": 1, "description": "One"}, {"id": 3, "description": "Three a"}, {"id": 3, "description": "Three b"}]
    monkeypatch.setattr(ce, "_openai_chat", lambda *a, **k: json.dumps(reply))
    out = ce.ai_review(_review_events())
    assert [e["description"] for e in out] == ["One", "x", "x"]


def test_ai_review_falls_back_to_position_without_ids(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "k")
    reply = [{"description": f"P{i}"} for i in range(3)]
    monkeypatch.setattr(ce, "_openai_chat", lambda *a, **k: json.dumps(reply))
    assert [e["description"] for e in ce.ai_review(_review_events())] == ["P0", "P1", "P2"]
    monkeypatch.setattr(ce, "_openai_chat", lambda *a, **k: json.dumps(reply[:2]))
    assert [e["description"] for e in ce.ai_review(_review_events())] == ["x", "x", "x"]


# ─── Google Sheet rows are curated ──────────────────────────────────────────

def test_google_sheet_rows_are_curated_and_pass_the_quality_gates(monkeypatch):
    csv_text = ("Date,Event Name,Venue,Address,Time,Notes,Status,Town\n"
                f"{d(3)},Cuero Turkeyfest,Downtown Cuero,\"100 Main St, Cuero, TX 77954\",10:00 AM,Parade and food,,Cuero\n")

    class R:
        text = csv_text

        def raise_for_status(self):
            pass

    monkeypatch.setattr(ce.requests, "get", lambda *a, **k: R())
    rows = ce.safe_fetch("google_sheet", ce.fetch_google_sheet_events, expect_events=False)
    assert rows[0]["curated"] is True and rows[0]["town"] == "Cuero"
    merged = ce.merge_events(rows, venues=[])
    assert [e["name"] for e in merged] == ["Cuero Turkeyfest"]
    assert merged[0]["curated"] is True and merged[0]["town"] == "Cuero"
    # A scraped copy of the same out-of-area row is still dropped.
    assert ce.merge_events([{**rows[0], "_source": "allevents", "curated": True}], venues=[]) == []


def test_google_sheet_link_column_is_the_events_link(monkeypatch):
    csv_text = ("Date,Event Name,Venue,Time,Link,URL\n"
                f"{d(2)},Pumpkin Fest,Church,5 PM,\"https://www.facebook.com/events/42),\",\n"
                f"{d(2)},No Link Fest,Hall,5 PM,,\n"
                f"{d(2)},Bad Link Fest,Hall,5 PM,see facebook,https://example.org/bad-link-fest\n"
                f"{d(2)},Listing Fest,Hall,5 PM,https://www.eventbrite.com/d/tx--victoria/events/,\n")

    class R:
        text = csv_text

        def raise_for_status(self):
            pass

    monkeypatch.setattr(ce.requests, "get", lambda *a, **k: R())
    rows = ce.fetch_google_sheet_events()
    # Trailing punctuation trimmed; a junk Link falls through to a good URL;
    # a listing page is never an event's link.
    assert [r["url"] for r in rows] == ["https://www.facebook.com/events/42", "", "https://example.org/bad-link-fest", ""]


# ─── main(): past events, warnings, per-source status ───────────────────────

def test_past_backfill_events_skip_the_ai_review(tmp_path, monkeypatch):
    today = date.today()
    monkeypatch.setattr(ce, "date_window", lambda **k: (today - timedelta(days=3), today + timedelta(days=14)))
    monkeypatch.setattr(ce, "now_central", lambda: __import__("datetime").datetime.combine(today, __import__("datetime").time(12)))
    reviewed = []
    monkeypatch.setattr(ce, "ai_review", lambda evs, **k: reviewed.extend(evs) or evs)
    yml = ("events:\n"
           f"  - date: '{d(-2)}'\n    name: Past Thing\n"
           f"  - date: '{d(1)}'\n    name: Next Thing\n")
    _run_main(tmp_path, monkeypatch, yml)
    assert [e["name"] for e in reviewed] == ["Next Thing"]
    names = [e["name"] for e in json.loads((tmp_path / "candidates.json").read_text())["events"]]
    assert names == ["Past Thing", "Next Thing"]


def test_warnings_and_source_status_are_written(tmp_path, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("token expired")

    _run_main(tmp_path, monkeypatch, f"events:\n  - date: '{d(1)}'\n    name: Hand\n", ("--skip-ai",),
              scrapers={"fetch_library_events": boom})
    meta = json.loads((tmp_path / "collection_metadata.json").read_text())
    assert meta["warnings"]["count"] >= 1
    assert any("library" in w for w in meta["warnings"]["first"])
    assert len(meta["warnings"]["first"]) <= 5
    cands = json.loads((tmp_path / "candidates.json").read_text())
    assert cands["sources"]["library"] == "error"
    assert cands["sources"]["local_events"] == "ok"


def test_warning_summary_line_is_short():
    ce.reset_source_stats()
    for i in range(12):
        ce._warn(f"thing {i} broke " + "x" * 300, scraper="s")
    line = ce.warning_summary()
    assert line.startswith("12 warnings")
    assert len(line) <= 400


@pytest.mark.parametrize("knob", ["FB_POSTS_MAX_VENUES", "EVENTBRITE_MAX"])
def test_empty_knob_means_default(monkeypatch, knob):
    monkeypatch.setenv(knob, "")
    assert ce._resolve_int_env(knob, 7) == 7
