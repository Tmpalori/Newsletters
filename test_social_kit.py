"""Social kit captions and event selection (scripts/social_kit.py).

Rendering needs Pillow and runs in the workflow; these tests cover the pure
helpers that decide what gets posted.
"""
import os
import sys
import urllib.error
from datetime import date
from unittest.mock import patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "scripts"))
import social_kit as sk

EVENTS = [
    {"date": "2026-10-09", "name": "Early Show", "time": "6:00 PM", "venue": "A"},
    {"date": "2026-10-09", "name": "Paid Show", "time": "9:00 PM", "venue": "B", "featured": True},
    {"date": "2026-10-10", "name": "Market", "time": "8am - 1pm", "venue": "Square", "free": True},
    {"date": "2026-10-05", "name": "Monday Trivia", "time": "7 PM", "venue": "Bar"},
    {"date": "2026-10-20", "name": "Next Week", "time": "7 PM"},
]


def test_bounds():
    assert sk.week_bounds(date(2026, 10, 5)) == (date(2026, 10, 5), date(2026, 10, 11))  # Monday run
    assert sk.week_bounds(date(2026, 10, 8)) == (date(2026, 10, 8), date(2026, 10, 11))  # Thursday run
    assert sk.weekend_bounds(date(2026, 10, 7)) == (date(2026, 10, 9), date(2026, 10, 11))
    assert sk.weekend_bounds(date(2026, 10, 10)) == (date(2026, 10, 10), date(2026, 10, 11))


def test_select_groups_by_day_featured_first():
    g = sk.select_events(EVENTS, date(2026, 10, 9), date(2026, 10, 11))
    assert list(g) == [date(2026, 10, 9), date(2026, 10, 10)]
    assert [e["name"] for e in g[date(2026, 10, 9)]] == ["Paid Show", "Early Show"]


def test_captions():
    start, end = date(2026, 10, 9), date(2026, 10, 11)
    caps = sk.captions(sk.select_events(EVENTS, start, end), start, end, "weekend")
    fb = caps["facebook"]
    assert fb.startswith("#ad This weekend in Victoria, TX (Oct 9–11): 3 events")
    assert "⭐ 9 PM Paid Show @ B #ad" in fb   # paid picks are starred and marked #ad
    assert "• 8 AM Market @ Square (free)" in fb
    assert "https://www.thevic361.com/this-weekend" in fb
    assert "link in bio" in caps["instagram"]


def test_empty_week_caption():
    start, end = date(2026, 12, 1), date(2026, 12, 7)
    caps = sk.captions({}, start, end, "week")
    assert "Nothing listed yet" in caps["facebook"]


def test_short_time():
    assert sk._short_time("7:00 PM – 10:00 PM") == "7 PM"
    assert sk._short_time("10:30am") == "10:30 AM"
    assert sk._short_time("") == ""


def test_today_caption_and_venue_tags():
    d = date(2026, 10, 9)
    handles = {"aero crafters": "aerocrafters", "the nave museum": "navemuseum"}
    groups = sk.select_events([
        {"date": "2026-10-09", "name": "Open Mic", "time": "7 PM", "venue": "Aero Crafters"},
        {"date": "2026-10-09", "name": "Art Night", "time": "6 PM", "venue": "Nave Museum"},
        {"date": "2026-10-09", "name": "Fish Fry", "time": "5 PM", "venue": "St. Mary"},
    ], d, d)
    caps = sk.captions(groups, d, d, "today", handles)
    assert caps["facebook"].startswith("Today in Victoria, TX (Oct 9): 3 events")
    assert "FRIDAY" not in caps["facebook"]
    assert "https://www.thevic361.com/today" in caps["facebook"]
    assert "@navemuseum @aerocrafters" in caps["instagram"]
    assert "@" not in caps["facebook"].split("See all")[1]


def test_outreach_lists_each_venue_once(tmp_path):
    import json as _json
    vf = tmp_path / "venues.json"
    vf.write_text(_json.dumps([{"name": "Aero Crafters", "instagram_url": "https://www.instagram.com/aerocrafters/"}]))
    groups = {date(2026, 10, 9): [
        {"name": "Open Mic", "venue": "Aero Crafters", "page": "/events/2026-10-09-open-mic"},
        {"name": "Late Show", "venue": "Aero Crafters", "page": "/events/2026-10-09-late-show"},
        {"name": "Fish Fry", "venue": "St. Mary"}]}
    lines = sk.outreach(groups, venues_path=str(vf))
    assert lines == [
        "• Aero Crafters: Open Mic https://www.thevic361.com/events/2026-10-09-open-mic (https://www.instagram.com/aerocrafters/)",
        "• St. Mary: Fish Fry https://www.thevic361.com/",
    ]


def test_no_reel_is_built_for_a_town_without_instagram(tmp_path, monkeypatch):
    # The Reel only goes to Instagram; Facebook gets the photos.
    import json as _json
    import pytest
    pytest.importorskip("PIL")
    monkeypatch.delenv("IG_USER_ID", raising=False)
    monkeypatch.setattr(sk, "make_reel", lambda *a, **k: pytest.fail("no Reel without Instagram"))
    ev = tmp_path / "events.json"
    ev.write_text(_json.dumps({"events": [
        {"date": "2026-10-09", "name": "Show", "time": "8 PM", "venue": "Aero Crafters"}]}))
    out = tmp_path / "out"
    sk.main(["--events-file", str(ev), "--today", "2026-10-08", "--out", str(out), "--kinds", "weekend"])
    assert "reel" not in _json.loads((out / "kit.json").read_text())["kits"]["weekend"]


def test_kinds_rebuild_keeps_other_kits(tmp_path, monkeypatch):
    monkeypatch.setenv("IG_USER_ID", "ig7")       # the Reel is Instagram's
    import json as _json
    import shutil as _shutil
    import pytest
    pytest.importorskip("PIL")
    ev = tmp_path / "events.json"
    ev.write_text(_json.dumps({"events": [
        {"date": "2026-10-09", "name": "Show", "time": "8 PM", "venue": "Aero Crafters"}]}))
    out = tmp_path / "out"
    sk.main(["--events-file", str(ev), "--today", "2026-10-08", "--out", str(out)])
    m = _json.loads((out / "kit.json").read_text())
    assert set(m["kits"]) == {"week", "weekend", "today"}
    assert (out / "outreach.txt").read_text().startswith("• Aero Crafters: Show")
    if _shutil.which("ffmpeg"):
        assert m["kits"]["weekend"]["reel"] == "weekend.mp4" and (out / "weekend.mp4").exists()
    sk.main(["--events-file", str(ev), "--today", "2026-10-09", "--out", str(out), "--kinds", "today"])
    m2 = _json.loads((out / "kit.json").read_text())
    assert m2["generated_for"] == "2026-10-09"
    assert m2["kits"]["week"] == m["kits"]["week"] and (out / "week-1.png").exists()
    assert m2["kits"]["today"]["events"] == 1


def test_branded_slides_markup():
    import social_slides as ss
    from datetime import date as _d
    ev = lambda name, day, **kw: {"name": name, "date": day, "time": "7:00 PM", "venue": "Weber <Brewing>", "icons": ["music", "nope"], **kw}
    groups = {_d(2026, 10, 9): [ev(f"Show <{i}>", "2026-10-09") for i in range(12)],
              _d(2026, 10, 10): [ev("Pumpkin Patch", "2026-10-10", featured=True, free=True)]}
    names, doc = ss.slides_html(groups, _d(2026, 10, 9), _d(2026, 10, 11), "weekend")
    assert names == ["weekend-1.png", "weekend-2.png", "weekend-3.png"]
    assert "Show &lt;0&gt;" in doc and "<0>" not in doc               # escaped
    assert '#i-music' in doc and '#i-nope' not in doc                  # only known icons
    assert "#FF7A3D" in doc and "#B9A6FF" in doc                       # Friday sunset, Saturday lilac (site colors)
    assert "+ 10 more" in doc                                          # 12 Friday events: 2 shown
    assert "thevic361.com/subscribe" in doc and "13 things to do" in doc


def test_branded_render_falls_back_without_chrome(tmp_path, monkeypatch):
    import social_slides as ss
    from datetime import date as _d
    monkeypatch.setattr(ss, "find_chrome", lambda: None)
    assert ss.render({}, _d(2026, 10, 9), _d(2026, 10, 9), "today", str(tmp_path)) is None


def test_caption_points_to_the_signup_page():
    from datetime import date as _d
    caps = sk.captions({_d(2026, 10, 9): [{"name": "Live Music", "date": "2026-10-09", "time": "7 PM"}]},
                       _d(2026, 10, 9), _d(2026, 10, 9), "today")
    assert "Don't miss a thing: get every event free in your inbox every Monday and Thursday 👉 https://www.thevic361.com/subscribe" in caps["facebook"]
    assert "subscribe at the link in bio" in caps["instagram"]


def test_outreach_slack_is_short_and_actionable(tmp_path):
    import json as _json
    vf = tmp_path / "venues.json"
    vf.write_text(_json.dumps([{"name": f"Bar {i}", "instagram_url": f"https://www.instagram.com/bar{i}/"} for i in range(12)]))
    groups = {date(2026, 10, 9): [{"name": f"Show | {i}", "venue": f"Bar {i}", "page": f"/events/2026-10-09-show-{i}"}
                                  for i in range(12)] + [{"name": "Fish Fry", "venue": "No Socials Hall"}]}
    msg = sk.outreach_slack(groups, venues_path=str(vf))
    lines = msg.splitlines()
    assert lines[0].startswith("📣 *12 venues on this week's list you can tag.*")
    assert len(lines) == 1 + 8 + 1                       # headline, 8 venues, "and 4 more"
    assert lines[1] == "• <https://www.instagram.com/bar0/|Bar 0> → <https://www.thevic361.com/events/2026-10-09-show-0|Show / 0>"
    assert "No Socials Hall" not in msg                  # nothing to tag, so not listed
    assert lines[-1] == "…and 4 more: <https://www.thevic361.com/social/latest/outreach.txt|full list>"
    assert sk.outreach_slack({date(2026, 10, 9): [{"name": "x", "venue": "No Socials Hall"}]}, venues_path=str(vf)) == ""


def test_captions_tease_two_per_day_sponsored_first():
    d = date(2026, 10, 9)
    evs = [{"date": "2026-10-09", "name": f"Show {i}", "time": f"{i + 1} PM", "venue": "Bar"} for i in range(6)]
    evs.append({"date": "2026-10-09", "name": "Sponsored Gala", "time": "9 PM", "venue": "Hall", "featured": True})
    caps = sk.captions(sk.select_events(evs, d, d), d, d, "today")
    fb = caps["facebook"]
    assert "⭐ 9 PM Sponsored Gala @ Hall" in fb          # sponsored first, marked
    assert "• 1 PM Show 0 @ Bar" in fb and "Show 1" not in fb
    assert "+ 5 more" in fb
    assert "👉 See all 7: https://www.thevic361.com/today" in fb
    assert "👉 See all 7: link in bio" in caps["instagram"]


def test_posts_have_at_most_three_slides():
    import social_slides as ss
    groups = {date(2026, 10, d): [{"name": f"E{d}{i}", "date": f"2026-10-{d:02d}", "time": "7 PM"} for i in range(9)]
              for d in range(5, 12)}
    names, doc = ss.slides_html(groups, date(2026, 10, 5), date(2026, 10, 11), "week")
    assert names == ["week-1.png", "week-2.png", "week-3.png"]
    assert doc.count("+ 7 more") == 7                      # every day: 2 shown, the rest teased
    assert "See all 63 events" in doc and "Subscribe free →" in doc and "thevic361.com/subscribe" in doc



def test_captions_with_one_event_use_the_singular():
    d = date(2026, 10, 9)
    caps = sk.captions({d: [{"name": "Live Music", "date": "2026-10-09", "time": "7 PM", "venue": "Bar"}]}, d, d, "today")
    assert caps["facebook"].startswith("Today in Victoria, TX (Oct 9): 1 event\n")
    assert "👉 Details: https://www.thevic361.com/today" in caps["facebook"]
    assert "👉 Details: link in bio" in caps["instagram"]
    assert "1 events" not in caps["facebook"] + caps["instagram"] and "See all 1" not in caps["facebook"]


def test_generic_venue_never_tags_a_named_venue():
    # Live data: an event "@ Victoria" must not tag @theatrevictoria.
    handles = {"theatre victoria": "theatrevictoria", "the nave museum": "navemuseum", "aero crafters": "aerocrafters"}
    d = date(2026, 10, 15)
    groups = sk.select_events([
        {"date": "2026-10-15", "name": "Parent Seminar", "venue": "Victoria"},
        {"date": "2026-10-15", "name": "Downtown Walk", "venue": "Downtown"},
        {"date": "2026-10-15", "name": "Art Night", "venue": "Nave Museum"},          # whole words, specific
        {"date": "2026-10-15", "name": "Gala", "venue": "Theatre Victoria, Victoria, TX"},
        {"date": "2026-10-15", "name": "Crafts", "venue": "Aero"},                     # one word: no fuzzy match
    ], d, d)
    assert sk.venue_tags(groups, handles) == ["@navemuseum", "@theatrevictoria"]
    assert sk.match_venue("victoria", handles) is None
    assert sk.match_venue("nave", {"the nave museum": "x"}) is None
    assert sk.match_venue("museum of the coastal bend", {"the coastal bend": "x"}) == "x"
    assert sk.match_venue("aero crafters", handles) == "aerocrafters"


def test_outreach_ignores_generic_venue(tmp_path):
    import json as _json
    venues = tmp_path / "venues.json"
    venues.write_text(_json.dumps([{"name": "Theatre Victoria", "instagram_url": "https://www.instagram.com/theatrevictoria/"}]))
    d = date(2026, 10, 15)
    groups = {d: [{"date": "2026-10-15", "name": "Parent Seminar", "venue": "Victoria"}]}
    assert sk.outreach(groups, str(venues)) == ["• Victoria: Parent Seminar https://www.thevic361.com/"]
    assert sk.outreach_slack(groups, str(venues)) == ""


def test_clean_venue_drops_geocoder_noise():
    assert sk.clean_venue("3102 Miori Ln., Victoria, TX, United States, Texas 77901") == "3102 Miori Ln."
    assert sk.clean_venue("Theatre Victoria, Victoria, TX 77901") == "Theatre Victoria"
    assert sk.clean_venue("402 E North St, TX 77901") == "402 E North St"
    assert sk.clean_venue("Downtown Victoria / Riverside Park / DeLeon Plaza") == "Downtown Victoria / Riverside Park / DeLeon Plaza"
    assert sk.clean_venue("Victoria") == "Victoria"
    assert sk.clean_venue(None) == ""
    d = date(2026, 10, 9)
    caps = sk.captions({d: [{"date": "2026-10-09", "name": "Community Connection Party", "time": "4 PM", "free": True,
                             "venue": "3102 Miori Ln., Victoria, TX, United States, Texas 77901"}]}, d, d, "today")
    assert "• 4 PM Community Connection Party @ 3102 Miori Ln. (free)" in caps["instagram"]
    assert "United States" not in caps["facebook"] and "77901" not in caps["facebook"]


def test_branded_cover_shows_clean_venue():
    import social_slides as ss
    d = date(2026, 10, 9)
    groups = {d: [{"date": "2026-10-09", "name": "Party", "venue": "3102 Miori Ln., Victoria, TX, United States, Texas 77901"}]}
    html_ = ss.cover_html(groups, d, d, "today")
    assert "3102 Miori Ln." in html_ and "United States" not in html_


def _busy_week(picks=()):
    evs = []
    for day in range(5, 12):
        for i in range(4):
            evs.append({"date": f"2026-10-{day:02d}", "time": "7:30 PM",
                        "name": f"Day {day} event {i} " + "with a really long descriptive name " * 2,
                        "venue": f"Venue {day}-{i} " + "Downtown Riverside Park DeLeon Plaza Pavilion " * 2,
                        "featured": (day, i) in picks})
    return evs


def test_instagram_caption_fits_2200_and_keeps_picks():
    handles = {sk._norm(f"Venue {d}-{i} " + "Downtown Riverside Park DeLeon Plaza Pavilion " * 2): f"venue{d}{i}"
               for d in range(5, 12) for i in range(4)}
    start, end = date(2026, 10, 5), date(2026, 10, 11)
    groups = sk.select_events(_busy_week(picks={(11, 3), (8, 2)}), start, end)
    caps = sk.captions(groups, start, end, "week", handles)
    ig = caps["instagram"]
    assert len(caps["facebook"]) > 2200                        # Facebook keeps the full text
    assert len(ig) <= sk.IG_MAX_CAPTION
    assert "…" in ig                                           # long names and venues shortened
    assert "Day 11 event 3" in ig and "Day 8 event 2" in ig   # Vic's Picks are in it
    assert "#TheVic361" in ig and "link in bio" in ig


def test_instagram_caption_folds_events_but_never_picks(monkeypatch):
    monkeypatch.setattr(sk, "IG_MAX_CAPTION", 1000)
    start, end = date(2026, 10, 5), date(2026, 10, 11)
    groups = sk.select_events(_busy_week(picks={(11, 3), (8, 2)}), start, end)
    ig = sk.captions(groups, start, end, "week")["instagram"]
    assert len(ig) <= 1000
    assert "+ more at thevic361.com" in ig
    assert "Day 11 event 3" in ig and "Day 8 event 2" in ig
    assert "Day 10 event 1" not in ig                          # later plain events fold first
    assert "#TheVic361" in ig


def test_short_caption_is_untouched():
    start, end = date(2026, 10, 9), date(2026, 10, 11)
    caps = sk.captions(sk.select_events(EVENTS, start, end), start, end, "weekend")
    assert "+ more at thevic361.com" not in caps["instagram"]


def test_every_vics_pick_is_in_the_caption_and_leads_today():
    d = date(2026, 10, 8)  # a Thursday
    evs = [{"date": "2026-10-08", "name": f"Free thing {i}", "time": f"{i + 1} PM"} for i in range(4)]
    evs += [{"date": "2026-10-08", "name": f"Pick {i}", "time": "9 PM", "featured": True} for i in range(3)]
    caps = sk.captions(sk.select_events(evs, d, d), d, d, "today")
    lines = caps["facebook"].splitlines()
    assert lines[2:5] == [f"⭐ 9 PM Pick {i} #ad" for i in range(3)]  # all three, first
    assert "+ 4 more" in caps["facebook"]


def test_manifest_has_jpeg_twins_and_featured_count(tmp_path):
    import json as _json
    import pytest
    pytest.importorskip("PIL")
    from PIL import Image
    ev = tmp_path / "events.json"
    ev.write_text(_json.dumps({"events": [
        {"date": "2026-10-08", "name": "Thursday Pick", "time": "8 PM", "venue": "Aero Crafters", "featured": True},
        {"date": "2026-10-09", "name": "Show", "time": "8 PM", "venue": "Aero Crafters"}]}))
    out = tmp_path / "out"
    sk.main(["--events-file", str(ev), "--today", "2026-10-08", "--out", str(out)])
    m = _json.loads((out / "kit.json").read_text())
    today = m["kits"]["today"]
    assert today["featured"] == 1 and m["kits"]["weekend"]["featured"] == 0
    assert today["slides_jpg"] == [n[:-4] + ".jpg" for n in today["slides"]]
    for png, jpg in zip(today["slides"], today["slides_jpg"]):
        with Image.open(out / jpg) as j, Image.open(out / png) as p:
            assert j.format == "JPEG" and j.size == p.size
    # A rebuild clears the old twins with the old PNGs.
    (out / "today-9.jpg").write_bytes(b"x")
    sk.main(["--events-file", str(ev), "--today", "2026-10-08", "--out", str(out), "--kinds", "today"])
    assert not (out / "today-9.jpg").exists()


def test_paid_picks_lead_editors_picks_and_only_paid_ones_count_for_thursday():
    d = "2026-10-10"
    events = [
        {"date": d, "name": "Editor Pick", "time": "1:00 PM", "featured": True, "editor_pick": True},
        {"date": d, "name": "Paid Pick", "time": "7:00 PM", "featured": True},
        {"date": d, "name": "Plain", "time": "9:00 AM"},
    ]
    g = sk.select_events(events, date(2026, 10, 10), date(2026, 10, 10))
    assert [e["name"] for e in g[date(2026, 10, 10)]] == ["Paid Pick", "Editor Pick", "Plain"]
    assert sk.is_paid_pick(events[1]) and not sk.is_paid_pick(events[0])
    assert sorted(events, key=sk.pick_rank)[0]["name"] == "Paid Pick"


class _Resp:
    def __init__(self, body):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return self.body


def test_fetch_events_retries_a_blip_with_backoff():
    # One failed fetch used to fail the day's build, and the scheduler had
    # already marked the run done, so the fallback cron skipped it.
    answers = [urllib.error.URLError("connection refused"),
               urllib.error.HTTPError("u", 502, "Bad Gateway", {}, None),
               _Resp(b'{"events": [{"name": "A &amp; B"}]}')]

    def fake(req, timeout):
        a = answers.pop(0)
        if isinstance(a, Exception):
            raise a
        return a
    sleeps = []
    with patch.object(sk.urllib.request, "urlopen", side_effect=fake):
        events = sk.fetch_events("https://example.test/events.json", sleep=sleeps.append)
    assert events == [{"name": "A & B"}] and sleeps == [30, 60]


def test_fetch_events_gives_up_on_a_4xx_and_after_its_tries():
    sleeps = []
    with patch.object(sk.urllib.request, "urlopen",
                      side_effect=urllib.error.HTTPError("u", 404, "Not Found", {}, None)):
        with pytest.raises(urllib.error.HTTPError):
            sk.fetch_events("https://example.test/x", sleep=sleeps.append)
    assert sleeps == []
    with patch.object(sk.urllib.request, "urlopen", side_effect=urllib.error.URLError("down")):
        with pytest.raises(urllib.error.URLError):
            sk.fetch_events("https://example.test/x", sleep=sleeps.append)
    assert sleeps == list(sk.FETCH_BACKOFF)


def test_weekly_sponsor_gets_a_shout_out_in_its_own_week_only():
    from datetime import date
    sponsor = {"name": "Acme Tacos", "text": "Best tacos in town.", "url": "https://acme.example", "week": "2026-10-05"}
    mon, sat_next = date(2026, 10, 5), date(2026, 10, 17)
    fb = sk.sponsor_lines(sponsor, mon, "facebook")
    assert fb[0] == "🙌 This week is brought to you by Acme Tacos: Best tacos in town."
    assert fb[1] == "👉 https://www.thevic361.com/go/s/2026-10-05?src=social"
    assert sk.sponsor_lines(sponsor, date(2026, 10, 9), "instagram") == [fb[0], ""]  # weekend kit, same week
    assert sk.sponsor_lines(sponsor, sat_next, "facebook") == []  # another week's kit
    assert sk.sponsor_lines(None, mon, "facebook") == []
    caps = sk.captions({}, mon, date(2026, 10, 11), "week", {}, sponsor)
    assert "brought to you by Acme Tacos" in caps["facebook"] and "brought to you by Acme Tacos" in caps["instagram"]
    assert "/go/s/" not in caps["instagram"]  # Instagram captions can't link


def test_paid_content_opens_with_ad_and_paid_picks_say_sponsored():
    d = date(2026, 10, 10)
    paid = {"date": "2026-10-10", "name": "Paid Pick", "time": "7 PM", "venue": "Hall", "featured": True}
    editor = {"date": "2026-10-10", "name": "Editor Pick", "time": "1 PM", "featured": True, "editor_pick": True}
    plain = {"date": "2026-10-10", "name": "Plain", "time": "9 AM"}
    caps = sk.captions(sk.select_events([paid, editor, plain], d, d), d, d, "today")
    for c in caps.values():
        assert c.startswith("#ad ")                          # first thing seen, before "more"
        assert "⭐ 7 PM Paid Pick @ Hall #ad" in c
        assert "Editor Pick #ad" not in c and "ponsored" not in c
    # No paid content: no #ad, no label.
    caps = sk.captions(sk.select_events([editor, plain], d, d), d, d, "today")
    assert not any("#ad" in c or "(sponsored)" in c for c in caps.values())
    # The weekly sponsor's shout-out in its own week is paid content too.
    sponsor = {"name": "Acme", "week": "2026-10-05"}
    caps = sk.captions(sk.select_events([plain], d, d), d, d, "today", sponsor=sponsor)
    assert caps["facebook"].startswith("#ad ") and caps["instagram"].startswith("#ad ")


def test_slides_tag_paid_picks_sponsored():
    import social_slides as ss
    d = date(2026, 10, 10)
    g = sk.select_events([{"date": "2026-10-10", "name": "Paid Pick", "time": "7 PM", "featured": True},
                          {"date": "2026-10-10", "name": "Editor Pick", "time": "1 PM", "featured": True, "editor_pick": True}], d, d)
    for page in (ss.cover_html(g, d, d, "today"), ss.digest_html(g, d, d, "today")):
        assert page.count(">#ad</span>") == 1 and "Sponsored" not in page


def test_free_paid_pick_line_ends_with_ad():
    ev = {"name": "Wags", "time": "4 PM", "venue": "Park", "free": True, "featured": True}
    assert sk._line(ev) == "⭐ 4 PM Wags @ Park (free) #ad"


def test_partners_get_a_facebook_thank_you_on_the_first_of_the_month():
    partners = [{"id": "ord-3", "name": "Mesquite Smokehouse", "label": "Food & drink", "line": "Brisket."},
                {"id": "ord-4", "name": "Smile Dental", "label": "Dental"}]
    first, second = date(2026, 11, 1), date(2026, 11, 2)
    lines = sk.thanks_lines(partners, first)
    assert lines[0] == "🙏 Thank you to our local partners for keeping The Vic 361 free:"
    assert lines[1] == "• Mesquite Smokehouse (Food & drink): https://www.thevic361.com/go/p/ord-3?src=social"
    assert sk.thanks_lines(partners, second) == []
    assert sk.thanks_lines([], first) == []
    plain = {"date": "2026-11-01", "name": "Plain", "time": "9 AM"}
    caps = sk.captions(sk.select_events([plain], first, first), first, first, "today", partners=partners, today=first)
    assert caps["facebook"].startswith("#ad ")                   # a paid thank-you
    assert "Mesquite Smokehouse (Food & drink)" in caps["facebook"]
    assert "Mesquite" not in caps["instagram"] and not caps["instagram"].startswith("#ad ")
    assert "$" not in caps["facebook"]
    caps = sk.captions(sk.select_events([plain], second, second), second, second, "today", partners=partners, today=second)
    assert "Mesquite" not in caps["facebook"] and not caps["facebook"].startswith("#ad ")


def test_live_partners_read_from_events_json():
    assert sk.live_partners({"partners": {"active": [{"id": "a", "name": "A"}], "open": ["food"]}}) == [{"id": "a", "name": "A"}]
    assert sk.live_partners({"events": []}) == []
    assert sk.live_partners({"partners": "nope"}) == []
