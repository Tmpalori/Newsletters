"""Facebook groups → OpenAI (collect_events.fetch_apify_facebook_groups):
the town's group list, the gates, the groups actor's post shape, and that a
group's events take the venue the post names (a group is never a place).

Network and OpenAI are stubbed."""
import os
import sys
from datetime import date, timedelta
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, os.path.dirname(__file__))
import collect_events as ce
import town as town_mod

GROUP = {"name": "Victoria Texas Promote Your Event", "url": "https://www.facebook.com/groups/465382903645231/"}


@pytest.fixture(autouse=True)
def reset_state(monkeypatch):
    ce._APIFY_LIMIT_TRIPPED = False
    monkeypatch.setattr(ce, "_OPENAI_DEAD", False)
    ce._WINDOW_START = date.today()
    ce._WINDOW_END = date.today() + timedelta(days=14)
    ce._QUIET_PAGES.clear()
    for k in ("APIFY_TOKEN", "OPENAI_API_KEY", "FB_GROUPS_ENABLED", "FB_GROUPS_POSTS"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setitem(ce.TOWN, "facebook_groups", [GROUP])


def _keys(monkeypatch):
    monkeypatch.setenv("APIFY_TOKEN", "t")
    monkeypatch.setenv("OPENAI_API_KEY", "k")


def _resp(items, status=200):
    r = MagicMock(status_code=status, text="")
    r.json.return_value = items
    return r


def test_town_groups_keep_only_group_links():
    town = {"facebook_groups": [GROUP, "https://facebook.com/groups/123", {"name": "Page", "url": "https://www.facebook.com/somepage"}, 5]}
    out = ce._town_facebook_groups(town)
    assert [g["url"] for g in out] == [GROUP["url"], "https://facebook.com/groups/123"]
    assert out[1]["name"] == "https://facebook.com/groups/123"


def test_every_town_group_list_reads():
    for tid in ("lincoln", "shoals", "virginiabeach", "medford"):
        groups = ce._town_facebook_groups(town_mod.town_config(env={"TOWN": tid}))
        assert len(groups) == 2, tid
    assert len(ce._town_facebook_groups(town_mod.VICTORIA)) == 3


def test_victoria_runs_the_groups_source():
    assert "apify_facebook_groups" in [n for n, _, _ in ce.enabled_web_sources(town_mod.VICTORIA)]


@pytest.mark.parametrize("env,groups", [({}, [GROUP]), ({"APIFY_TOKEN": "t", "OPENAI_API_KEY": "k"}, []),
                                        ({"APIFY_TOKEN": "t", "OPENAI_API_KEY": "k", "FB_GROUPS_ENABLED": "0"}, [GROUP])])
def test_off_without_groups_keys_or_switch(monkeypatch, env, groups):
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setitem(ce.TOWN, "facebook_groups", groups)
    post = MagicMock()
    monkeypatch.setattr(ce.requests, "post", post)
    assert ce.fetch_apify_facebook_groups() == []
    post.assert_not_called()


def test_group_posts_become_events_at_the_named_venue(monkeypatch):
    _keys(monkeypatch)
    day = (date.today() + timedelta(days=3)).strftime("%Y-%m-%d")
    posts = [{"url": "https://www.facebook.com/groups/465382903645231/posts/1", "time": "2026-10-20T15:00:00Z",
              "text": "Fall market Saturday at the Community Center!",
              "attachments": [{"photo_image": {"uri": "https://x/flyer.jpg"}}]},
             {"error": "nothing here"}]
    calls = []
    monkeypatch.setattr(ce, "_apify_posts_run", lambda url, payload, token: calls.append((url, payload)) or _resp(posts))
    seen = {}

    def ai(name, got, group=False):
        seen.update(name=name, group=group, posts=got)
        return [{"name": "Fall Market", "date": day, "venue": "Community Center", "source_post_index": 1},
                {"name": "No Venue Night", "date": day, "venue": ""}]

    monkeypatch.setattr(ce, "_extract_events_from_posts_via_ai", ai)
    events = ce.fetch_apify_facebook_groups()

    assert "facebook-groups-scraper" in calls[0][0]
    assert calls[0][1]["startUrls"] == [{"url": GROUP["url"]}]
    assert seen["group"] is True and seen["name"] == GROUP["name"]
    assert len(seen["posts"]) == 1 and seen["posts"][0]["media"]   # attachments read as images
    by = {e["name"]: e for e in events}
    assert by["Fall Market"]["venue"] == "Community Center"
    assert by["Fall Market"]["url"].endswith("/posts/1")
    # A group isn't a place: no named venue means none, not the group's name.
    assert by["No Venue Night"]["venue"] == ""
    assert by["No Venue Night"]["url"] == GROUP["url"]


def test_shared_event_without_caption_reaches_the_model():
    p = ce._group_post({"text": "", "previewTitle": "Open Skate at the Belmont Community Center",
                        "previewDescription": "Sat, Nov 28 at 2 PM · Belmont Community Center",
                        "link": "https://www.facebook.com/events/123/"})
    assert p["text"] == ("Shared: Open Skate at the Belmont Community Center · Sat, Nov 28 at 2 PM · "
                         "Belmont Community Center · Link: https://www.facebook.com/events/123/")
    # A caption keeps its place; a preview it already quotes isn't repeated.
    q = ce._group_post({"text": "Come skate! Open Skate", "previewTitle": "Open Skate"})
    assert q["text"] == "Come skate! Open Skate"


def test_group_keeps_one_time_events_past_the_window(monkeypatch):
    _keys(monkeypatch)
    far = date.today() + timedelta(days=50)
    monkeypatch.setattr(ce, "_apify_posts_run", lambda *a: _resp([{"text": "Krampus Crawl Dec 19!"}]))
    monkeypatch.setattr(ce, "_extract_events_from_posts_via_ai", lambda *a, **k: [
        {"name": "Krampus Crawl", "date": far.strftime("%Y-%m-%d"), "venue": "Bierhaus"},
        {"name": "Too Far", "date": (date.today() + timedelta(days=200)).strftime("%Y-%m-%d")},
        {"name": "Trivia", "recurring": True, "weekday": "tuesday"}])
    events = ce.fetch_apify_facebook_groups()
    names = [e["name"] for e in events]
    assert "Krampus Crawl" in names and "Too Far" not in names
    # Weekly events stay inside the normal window.
    assert all(date.fromisoformat(e["date"]) <= ce._WINDOW_END for e in events if e["name"] == "Trivia")
    assert 1 <= names.count("Trivia") <= 3


def test_shared_post_text_and_images_reach_the_model():
    # The groups actor's shape for an admin's share of a page post (Oct 22 2026).
    p = ce._group_post({"text": "", "sharedPost": {
        "pageName": {"name": "Alchemy Lincoln"},
        "text": "Miky Semrad takes the stage at 6:30 tonight.",
        "media": [{"thumbnail": "https://x/thumb.jpg", "photo_image": {"uri": "https://x/flyer.jpg"}}]}})
    assert p["text"] == "Shared from Alchemy Lincoln: Miky Semrad takes the stage at 6:30 tonight."
    assert ce._post_image_urls(p) == ["https://x/flyer.jpg", "https://x/thumb.jpg"]


def test_unavailable_share_is_empty():
    p = ce._group_post({"text": "", "title": "This content isn't available right now", "attachments": [
        {"title_with_entities": {"text": "This content isn't available right now"},
         "description": {"text": "When this happens, it's usually because..."}}]})
    assert p["text"] == "" and p["media"] == []


def test_empty_group_goes_quiet(monkeypatch):
    _keys(monkeypatch)
    monkeypatch.setattr(ce, "_apify_posts_run", lambda *a: _resp([{"error": "private"}]))
    ai = MagicMock()
    monkeypatch.setattr(ce, "_extract_events_from_posts_via_ai", ai)
    assert ce.fetch_apify_facebook_groups() == []
    ce.fetch_apify_facebook_groups()
    ai.assert_not_called()
    assert ce._QUIET_PAGES[GROUP["url"]]["misses"] >= ce.QUIET_AFTER


def test_hard_limit_stops_the_rest(monkeypatch):
    _keys(monkeypatch)
    monkeypatch.setitem(ce.TOWN, "facebook_groups", [GROUP, {"name": "Two", "url": "https://www.facebook.com/groups/2/"}])
    r = _resp([], status=403)
    r.text = "Monthly usage hard limit exceeded"
    calls = []
    monkeypatch.setattr(ce, "_apify_posts_run", lambda *a: calls.append(a) or r)
    assert ce.fetch_apify_facebook_groups() == []
    assert len(calls) == 1 and ce._APIFY_LIMIT_TRIPPED


def test_group_prompt_names_the_group_and_asks_for_the_venue():
    p = ce._post_events_prompt("Lincoln NE Events", "[1] post", "2026-10-23", "2026-11-06", group=True)
    assert 'Facebook group "Lincoln NE Events"' in p
    assert "The venue's name as the post gives it" in p
    assert "NOT at Lincoln NE Events itself" not in p


def test_merge_keeps_far_group_events_but_not_other_scrapers():
    far = (date.today() + timedelta(days=50)).strftime("%Y-%m-%d")
    base = {"date": far, "time": "7:00 PM", "venue": "Bierhaus", "address": "151 N 8th St", "description": "x"}
    merged = ce.merge_events([{**base, "name": "Krampus Crawl", "_source": "apify_facebook_groups"},
                              {**base, "name": "Other Show", "_source": "apify_facebook_posts"}], venues=[])
    names = [e["name"] for e in merged]
    assert "Krampus Crawl" in names and "Other Show" not in names
