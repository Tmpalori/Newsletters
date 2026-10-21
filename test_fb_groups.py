"""Facebook groups → OpenAI (collect_events.fetch_apify_facebook_groups).

Covers the town.json wiring, the on/off gates, extraction through the same
date check and dedupe as page posts, and the dead-end flags for private or
empty groups. Network is stubbed.
"""
import json
import os
import sys
from datetime import date, timedelta
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.dirname(__file__))
import collect_events as ce
import town as town_mod

G1 = "https://www.facebook.com/groups/111/"
G2 = "https://www.facebook.com/groups/222/"
MON = date(2026, 10, 19)


@pytest.fixture(autouse=True)
def setup(monkeypatch):
    ce._APIFY_LIMIT_TRIPPED = False
    ce._OPENAI_DEAD = False
    ce._RUN_STARTED = None
    ce._WINDOW_START, ce._WINDOW_END = MON, MON + timedelta(days=13)
    ce._GROUP_STATUS.clear()
    ce._POST_ROTATION.clear()
    ce._SCRAPE_STOPS.clear()
    ce._SOURCE_NOTES.clear()
    ce._WARNINGS.clear()
    monkeypatch.setitem(ce.TOWN, "facebook_groups", [{"url": G1}, {"url": G2}])
    monkeypatch.setenv("APIFY_TOKEN", "t")
    monkeypatch.setenv("OPENAI_API_KEY", "k")
    monkeypatch.delenv("FB_GROUPS_ENABLED", raising=False)
    monkeypatch.setenv("FLYER_IMAGES", "0")
    monkeypatch.setattr(ce.time, "sleep", lambda s: None)


def _resp(items, status=200):
    r = MagicMock()
    r.status_code = status
    r.json.return_value = items
    r.text = json.dumps(items)
    return r


def _run(by_group, ai=None):
    """Run the fetcher with each group URL answering by_group[url]."""
    def post(url, json=None, **kw):
        return by_group[json["startUrls"][0]["url"]]
    with patch.object(ce.requests, "post", side_effect=post) as p, \
            patch.object(ce, "_extract_events_from_posts_via_ai", side_effect=ai or (lambda *a, **k: [])) as x:
        out = ce.fetch_apify_facebook_groups(14)
    return out, p, x


def test_every_town_json_group_is_valid_and_loaded():
    for slug in ("tupelo", "lincoln", "shoals", "virginiabeach", "medford"):
        t = town_mod.town_config(env={"TOWN": slug})
        assert len(t["facebook_groups"]) == 2
        assert all(town_mod.FACEBOOK_GROUP_URL.match(g["url"]) for g in t["facebook_groups"])
    assert len(town_mod.VICTORIA["facebook_groups"]) == 3
    assert "apify_facebook_groups" in town_mod.VICTORIA["enabled_sources"]
    assert town_mod.town_config(env={"TOWN": "kearney"})["facebook_groups"] == []


def test_a_bad_group_url_stops_the_town():
    with pytest.raises(ValueError, match="facebook_groups"):
        town_mod.town_config(town={"siteName": "Bay", "domain": "bay.com", "city": "Bay City", "state": "TX",
                                   "stateName": "Texas", "timezone": "America/Chicago",
                                   "facebookGroups": [{"url": "https://www.facebook.com/somepage"}]})


@pytest.mark.parametrize("env,groups", [({"FB_GROUPS_ENABLED": "0"}, None), ({"APIFY_TOKEN": ""}, None), ({}, [])])
def test_off_without_groups_token_or_switch(monkeypatch, env, groups):
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    if groups is not None:
        monkeypatch.setitem(ce.TOWN, "facebook_groups", groups)
    ce._SOURCE_OFF.clear()
    with patch.object(ce.requests, "post") as p:
        assert ce.fetch_apify_facebook_groups(14) == []
    p.assert_not_called()
    assert "apify_facebook_groups" in ce._SOURCE_OFF


def test_events_use_the_group_prompt_post_url_and_weekday_check():
    posts = [{"text": "Fall fest Saturday!", "url": "https://www.facebook.com/groups/111/posts/9", "groupTitle": "Tupelo Events",
              "time": "2026-10-20T15:00:00.000Z"}]
    ai = lambda name, p, prompt_fn=None: [
        {"date": "2026-10-24", "weekday": "Saturday", "name": "Fall Fest", "venue": "Fairpark", "time": "10 AM", "source_post_index": 1},
        {"date": "2026-10-24", "weekday": "Friday", "name": "Wrong Day", "source_post_index": 1},      # weekday mismatch
        {"date": "2027-01-01", "weekday": "Friday", "name": "Out Of Window"},
        {"weekday": "Tuesday", "recurring": True, "name": "Trivia Tuesday", "venue": "Tupelo Events"},  # the group isn't a place
    ]
    out, p, x = _run({G1: _resp(posts), G2: _resp([])}, ai)
    assert x.call_args.kwargs["prompt_fn"] is ce._group_events_prompt
    assert x.call_args.args[0] == "Tupelo Events"
    fest = [e for e in out if e["name"] == "Fall Fest"]
    assert fest == [{**fest[0], "date": "2026-10-24", "venue": "Fairpark", "address": "",
                     "url": "https://www.facebook.com/groups/111/posts/9"}]
    trivia = [e for e in out if e["name"] == "Trivia Tuesday"]
    assert [e["date"] for e in trivia] == ["2026-10-20", "2026-10-27"] and all(e["venue"] == "" and e["recurring"] for e in trivia)
    assert not [e for e in out if e["name"] in ("Wrong Day", "Out Of Window")]
    assert p.call_args_list[0].kwargs["json"]["viewOption"] == "CHRONOLOGICAL"
    assert ce._GROUP_STATUS[G1]["status"] == "ok" and ce._GROUP_STATUS[G1]["name"] == "Tupelo Events"


def test_one_event_cross_posted_in_two_groups_is_kept_once():
    posts = [{"text": "Market Saturday", "url": "u"}]
    ai = lambda *a, **k: [{"date": "2026-10-24", "weekday": "Saturday", "name": "Fall  Market"}]
    out, _, _ = _run({G1: _resp(posts), G2: _resp(posts)}, ai)
    assert [e["name"] for e in out] == ["Fall Market"]
    assert ce._GROUP_STATUS[G2]["status"] == "ok"


def test_a_private_group_is_flagged_a_dead_end_at_once_and_skipped_after():
    out, _, x = _run({G1: _resp([{"error": "This group is private. Join the group to see posts."}]), G2: _resp([])})
    assert out == [] and not x.called
    row = ce._GROUP_STATUS[G1]
    assert row["status"] == "private" and ce.group_dead(row)
    assert any("is private or needs a login" in w for w in ce._WARNINGS)
    assert "dead ends" in ce._SOURCE_NOTES["apify_facebook_groups"]
    # G2 had nothing: one miss, not yet a dead end.
    assert ce._GROUP_STATUS[G2]["status"] == "empty" and not ce.group_dead(ce._GROUP_STATUS[G2])
    # Next runs skip the private group, and try it again every QUIET_RETRY_EVERY-th run.
    tried = []
    for _ in range(ce.QUIET_RETRY_EVERY):
        _, p, _ = _run({G1: _resp([{"error": "private"}]), G2: _resp([{"text": "hi"}])})
        tried.append(any(c.kwargs["json"]["startUrls"][0]["url"] == G1 for c in p.call_args_list))
    assert tried == [False] * (ce.QUIET_RETRY_EVERY - 1) + [True]
    assert sum("is private" in w for w in ce._WARNINGS) == 1   # warned once


def test_an_empty_group_turns_dead_after_quiet_after_runs_and_recovers():
    for _ in range(ce.QUIET_AFTER):
        _run({G1: _resp([]), G2: _resp([])})
    assert ce.group_dead(ce._GROUP_STATUS[G1]) and ce._GROUP_STATUS[G1]["dead_since"]
    assert any("had no readable posts" in w for w in ce._WARNINGS)
    ce._GROUP_STATUS[G1]["skips"] = ce.QUIET_RETRY_EVERY - 1    # its retry turn
    _run({G1: _resp([{"text": "Show Friday"}]), G2: _resp([])})
    assert ce._GROUP_STATUS[G1]["status"] == "ok" and not ce.group_dead(ce._GROUP_STATUS[G1])


def test_http_errors_are_not_dead_ends_and_the_hard_limit_stops():
    _run({G1: _resp({"error": "boom"}, 500), G2: _resp([])})
    assert ce._GROUP_STATUS[G1]["status"] == "error" and not ce.group_dead(ce._GROUP_STATUS[G1])
    ce._GROUP_STATUS.clear()
    limit = _resp({"error": {"type": "usage-hard-limit", "message": "Monthly usage hard limit exceeded"}}, 403)
    _, p, _ = _run({G1: limit, G2: _resp([])})
    assert ce._APIFY_LIMIT_TRIPPED and p.call_count == 1
    assert ce._SCRAPE_STOPS[-1]["source"] == "apify_facebook_groups" and ce._SCRAPE_STOPS[-1]["reason"] == "apify-limit"


def test_group_status_round_trips_through_the_metadata(tmp_path):
    ce._group_result(G1, "Tupelo Events", "private", "This group is private")
    path = tmp_path / "collection_metadata.json"
    path.write_text(json.dumps({"facebook_groups": {u: {**r, "dead": ce.group_dead(r)} for u, r in ce._GROUP_STATUS.items()}}))
    ce._GROUP_STATUS.clear()
    ce.load_group_status(str(path))
    assert ce._GROUP_STATUS[G1]["status"] == "private" and ce.group_dead(ce._GROUP_STATUS[G1])
    ce.load_group_status(str(tmp_path / "missing.json"))
    assert ce._GROUP_STATUS == {}


def test_group_prompt_names_the_group_and_skips_non_events():
    p = ce._group_events_prompt("Tupelo Events", "[1] hi", "2026-10-19", "2026-11-01")
    assert '"Tupelo Events"' in p and "yard and garage sales" in p and "Never the person who posted" in p
    assert "between 2026-10-19 and 2026-11-01" in p


def test_group_post_images_come_from_attachments():
    p = {"attachments": [{"photo_image": {"uri": "https://cdn/x.jpg"}, "thumbnail": "https://cdn/t.jpg"}]}
    assert ce._post_image_urls(p) == ["https://cdn/x.jpg", "https://cdn/t.jpg"]


def test_group_events_merge_with_page_copies():
    page = {"date": "2026-10-24", "name": "Fall Market", "venue": "Fairpark", "time": "9:00 AM", "_source": "apify_facebook_posts"}
    group = {"date": "2026-10-24", "name": "Fall Market at Fairpark", "venue": "Fairpark", "time": "9 AM", "_source": "apify_facebook_groups"}
    assert ce.is_same_event(page, group)
