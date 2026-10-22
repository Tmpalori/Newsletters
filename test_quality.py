"""Tests for collector quality: Victoria-only filter, venue cleanup, fuzzy
dedupe, source preference, and the scraper fixes that feed them.

Cases come from the 2026-09-28 run, where duplicates like "Tejas Fest" /
"Tejas Fest 2026" and "Disney Pixar's Finding Nemo JR." / "Disney's Finding
Nemo JR" reached the admin as separate candidates.
"""
import datetime
import json
import os
import sys
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(__file__))
import collect_events as ce


_SAVED_WINDOW = None


def setup_module(_):
    global _SAVED_WINDOW
    _SAVED_WINDOW = (ce._WINDOW_START, ce._WINDOW_END)
    ce._WINDOW_START = datetime.date(2026, 9, 28)
    ce._WINDOW_END = datetime.date(2026, 10, 12)


def teardown_module(_):
    ce._WINDOW_START, ce._WINDOW_END = _SAVED_WINDOW


def _window_around_today(monkeypatch):
    """The few tests that use the real date need a window around it, not the
    fixed one above (or they'd start failing once the calendar passes it)."""
    today = ce.now_central().date()
    monkeypatch.setattr(ce, "_WINDOW_START", today)
    monkeypatch.setattr(ce, "_WINDOW_END", today + datetime.timedelta(days=14))


def ev(name, date="2026-10-02", venue="", address="", source=None, **kw):
    e = {"date": date, "name": name, "venue": venue, "address": address,
         "time": kw.pop("time", ""), "description": kw.pop("description", ""),
         "url": kw.pop("url", ""), "icons": kw.pop("icons", []), "free": kw.pop("free", False)}
    if source:
        e["_source"] = source
    e.update(kw)
    return e


# ─── Location ─────────────────────────────────────────────────────────────

def test_victoria_addresses_pass():
    assert ce.out_of_area_reason(ev("Bingo", venue="Palace Bingo", address="5306 Houston Hwy")) is None
    assert ce.out_of_area_reason(ev("Fest", venue="Inez Community Center", address="2511 Garcitas Creek Rd, Inez, TX 77968")) is None
    assert ce.out_of_area_reason(ev("Show", venue="Welder Center", address="214 N Main St, Victoria, TX 77901")) is None


def test_other_towns_are_dropped():
    assert ce.out_of_area_reason(ev("Turkeyfest", venue="Cuero Municipal Park", address="")) == "town cuero"
    assert ce.out_of_area_reason(ev("Market", venue="Downtown", address="100 Main St, 77954")) == "zip 77954"
    assert ce.out_of_area_reason(ev("Gala", description="Join us at the pavilion, Port Lavaca, TX")) == "town port lavaca"


def test_merge_drops_out_of_area_but_trusts_local_yaml():
    out = ce.merge_events([
        ev("Turkeyfest", venue="Cuero Municipal Park", source="allevents"),
        ev("Shiner Music Fest", venue="Shiner", source="local_events"),
    ], venues=[])
    assert [e["name"] for e in out] == ["Shiner Music Fest"]


# ─── Venue cleanup ────────────────────────────────────────────────────────

def test_address_in_venue_field_moves_to_address_and_matches_venue_list():
    e = ev("Tejas Fest 2026", venue="101 N. Main St, Victoria, TX, United States, Texas 77901")
    ce.clean_venue(e, [{"name": "De Leon Plaza", "address": "101 North Main Street"}])
    assert e["venue"] == "De Leon Plaza"
    assert e["address"] == "101 N. Main St"


def test_address_venue_without_match_shows_the_address_only():
    # The event page read "at 78 Tate Rd."; now the street is the address
    # and the venue is blank (the site then shows the address alone).
    e = ev("Seminar", venue="2002 E Mockingbird Ln, Victoria, TX, United States, Texas 77904")
    ce.clean_venue(e, [])
    assert e["venue"] == "" and e["address"] == "2002 E Mockingbird Ln"
    e = ev("Haunted Attraction", venue="78 Tate Rd.", address="78 Tate Rd")
    ce.clean_venue(e, [])
    assert e["venue"] == "" and e["address"] == "78 Tate Rd"
    # A name before the city is still the venue.
    e = ev("Live Music", venue="Moonshine Drinkery, Victoria, TX")
    ce.clean_venue(e, [])
    assert e["venue"] == "Moonshine Drinkery"


def test_placeholder_venues_are_blanked():
    # Live 2026-10: "The ABC's of Behavior" at venue "Victoria", address
    # "Victoria"; Eventbrite dinners at "Restaurant of the Week".
    e = ev("The ABC’s of Behavior: A Parent Seminar", venue="Victoria", address="Victoria")
    ce.clean_venue(e, [])
    assert e["venue"] == "" and e["address"] == ""
    e = ev("Dinner with Entrepreneurs", venue="Restaurant of the Week", address="South Main Street")
    ce.clean_venue(e, [])
    assert e["venue"] == "" and e["address"] == "South Main Street"
    for v in ["Victoria, TX", "Victoria Texas", "TBA", "Various locations"]:
        e = ev("X", venue=v)
        ce.clean_venue(e, [])
        assert e["venue"] == "", v
    for v in ["Victoria Public Library", "Victoria College", "Downtown Victoria"]:
        e = ev("X", venue=v)
        ce.clean_venue(e, [])
        assert e["venue"] == v


def test_real_venue_names_untouched():
    e = ev("Show", venue="Aero Crafters", address="309 E Crestwood Dr")
    ce.clean_venue(e, [])
    assert e["venue"] == "Aero Crafters"


# ─── Dedupe ───────────────────────────────────────────────────────────────

def test_same_event_variants_match():
    assert ce.is_same_event(ev("Tejas Fest"), ev("Tejas Fest 2026"))
    assert ce.is_same_event(ev("Disney Pixar’s Finding Nemo JR."), ev("Disney's Finding Nemo JR"))
    assert ce.is_same_event(ev("The Life of the Party: Film Screening and Discussion", venue="Welder Center"),
                            ev("The Life of the Party", venue="Welder Center"))
    assert ce.is_same_event(
        ev("6th Realm Night Market October 10th- Street spots $45", venue="502 E Juan Linn St"),
        ev("6th Realm Night Market", venue="Around the Haus, 502 E Juan Linn St"))


def test_different_events_do_not_match():
    assert not ce.is_same_event(ev("Wednesday Night Karaoke", venue="Shooters Bar"),
                                ev("VARRA Wednesday Night Run", venue="Riverside Stadium"))
    # Contained name at a different place is a different event.
    assert not ce.is_same_event(ev("Tejas Fest", venue="Victoria Main Street Program"),
                                ev("Chihuahua Races at Tejas Fest", venue="DeLeon City Plaza"))
    assert not ce.is_same_event(ev("Tejas Fest", date="2026-10-02"), ev("Tejas Fest", date="2026-10-03"))


def test_same_event_ignores_venue_and_weekday_words():
    # A social post's "Brunch" and the curated "Sunday Brunch at J Welch Farms".
    assert ce.is_same_event(ev("Brunch", venue="J Welch Farms"), ev("Sunday Brunch at J Welch Farms", venue="J Welch Farms"))
    assert ce.is_same_event(ev("Live Music", venue="J Welch Farms"), ev("Live Music at J Welch Farms", venue="J Welch Farms"))
    assert not ce.is_same_event(ev("Bingo Night", venue="J Welch Farms"), ev("Sunday Brunch at J Welch Farms", venue="J Welch Farms"))
    # Needs both venues: a blank venue isn't enough to merge on one word.
    assert not ce.is_same_event(ev("Brunch", venue=""), ev("Sunday Brunch at J Welch Farms", venue="J Welch Farms"))


def _slot(name, source, date="2026-10-07", venue="Victoria Farmers Market", time="9 AM–1 PM", **kw):
    return ev(name, date=date, venue=venue, source=source, time=time, **kw)


def test_reworded_copies_at_one_venue_and_minute_match():
    # Real copies from candidates.json (Oct 2026), each pair once missed.
    wed = _slot("Wednesday Market", "apify_facebook_posts")
    mid = _slot("Midweek Market", "apify_facebook_posts")
    yaml = _slot("Victoria Farmers' Market", "local_events", time="9:00 AM – 1:00 PM", curated=True)
    for a, b in [(wed, mid), (wed, yaml), (mid, yaml)]:
        assert ce.is_same_event(a, b) and ce.is_same_event(b, a), (a["name"], b["name"])

    film = dict(date="2026-10-19", venue="Moonshine Drinkery")
    vfs = _slot("Victoria Film Society presents “Friday the 13th” (1980)", "allevents", time="07:00 PM", **film)
    movie = _slot("Movie Night: Friday the 13th", "local_events", time="7:00 PM", curated=True, **film)
    ig = _slot("Monday Movie Nights with Victoria Film Society", "apify_instagram_posts", time="7:00 PM", **film)
    for a, b in [(vfs, movie), (vfs, ig), (movie, ig)]:
        assert ce.is_same_event(a, b), (a["name"], b["name"])

    oct5 = dict(date="2026-10-05", venue="Moonshine Drinkery", time="7:00 PM")
    psycho = _slot("Psycho | October Horror Film Series", "apify_facebook_posts", **oct5)
    monday = _slot("Monday Movie Night", "apify_facebook_posts", **oct5)
    nights = _slot("Monday Movie Nights with Victoria Film Society", "apify_instagram_posts", **oct5)
    for a, b in [(psycho, monday), (psycho, nights), (monday, nights)]:
        assert ce.is_same_event(a, b), (a["name"], b["name"])
    # A generic name stands in for the night's act.
    assert ce.is_same_event(_slot("Live Music", "apify_facebook_posts", venue="Aero Crafters", time="8:00 PM"),
                            _slot("Jake Smith Band", "allevents", venue="Aero Crafters", time="8 PM"))


def test_reworded_copies_merge_into_one_listing():
    out = ce.merge_events([
        _slot("Wednesday Market", "apify_facebook_posts"),
        _slot("Midweek Market", "apify_facebook_posts"),
        _slot("Victoria Farmers' Market", "local_events", time="9:00 AM – 1:00 PM", address="2805 N. Navarro St."),
    ], venues=[])
    assert [e["name"] for e in out] == ["Victoria Farmers' Market"]


def test_different_events_at_one_venue_and_minute_stay_apart():
    moon = dict(date="2026-10-19", venue="Moonshine Drinkery", time="7:00 PM")
    # Two specific names sharing nothing but a weak word.
    assert not ce.is_same_event(_slot("Victoria Film Society presents “Friday the 13th”", "allevents", **moon),
                                _slot("Bourbon Society Mixer", "apify_facebook_posts", **moon))
    # A multi-stage venue's two shows, both official listings.
    welder = dict(date="2026-10-17", venue="Leo J. Welder Center", time="7:00 PM")
    assert not ce.is_same_event(_slot("Halloween Pops Concert", "theatre_victoria", **welder),
                                _slot("Kids Costume Craft", "apify_facebook_posts", **welder))
    # Generic names of different kinds: karaoke isn't trivia.
    bar = dict(venue="Shooters Bar", time="9:00 PM")
    assert not ce.is_same_event(_slot("Karaoke", "apify_facebook_posts", **bar), _slot("Trivia Night", "allevents", **bar))
    # A generic offering isn't any specific listing ("Brunch" vs "Corn Maze").
    farm = dict(date="2026-10-11", venue="J Welch Farms", time="10:00 AM – 3:00 PM")
    assert not ce.is_same_event(_slot("Sunday Brunch", "apify_facebook_posts", **farm), _slot("Corn Maze", "jwelch", **farm))
    # Two hand-entered listings were kept apart on purpose.
    assert not ce.is_same_event(_slot("Sunday Brunch at J Welch Farms", "local_events", curated=True, **farm),
                                _slot("J Welch Farms Corn Maze", "local_events", curated=True, **farm))
    # Start times must be known and equal.
    assert not ce.is_same_event(_slot("Wednesday Market", "apify_facebook_posts", time=""),
                                _slot("Midweek Market", "apify_facebook_posts", time=""))
    assert not ce.is_same_event(_slot("Wednesday Market", "apify_facebook_posts", time="9 AM"),
                                _slot("Midweek Market", "apify_facebook_posts", time="3 PM"))
    # Venues must agree by name; a shared strip-center address isn't enough.
    assert not ce.is_same_event(_slot("Live Music", "apify_facebook_posts", venue="Bar One", address="100 Main St", time="8 PM"),
                                _slot("Jake Smith Band", "allevents", venue="Bar Two", address="100 Main St", time="8 PM"))


def test_merge_keeps_hand_entered_price():
    out = ce.merge_events([
        ev("Pumpkin Fest", date="2026-10-09", venue="DeLeon Plaza", source="local_events", free=False, icons=["family"]),
        ev("Pumpkin Fest", date="2026-10-09", venue="DeLeon Plaza", source="allevents", free=True, icons=["free", "food"]),
    ], venues=[])
    assert len(out) == 1
    assert out[0]["free"] is False and "free" not in out[0]["icons"]


def test_merge_prefers_official_source_and_fills_gaps():
    out = ce.merge_events([
        ev("Tejas Fest 2026", time="05:30 PM", address="101 N Main St", source="allevents",
           url="https://allevents.in/x"),
        ev("Tejas Fest", venue="Victoria Public Library", description="Free downtown festival.",
           source="library", url="https://victoriapl.librarycalendar.com/x"),
    ], venues=[])
    assert len(out) == 1
    m = out[0]
    assert m["name"] == "Tejas Fest"
    assert m["url"].startswith("https://victoriapl")      # library outranks allevents
    assert m["time"] == "05:30 PM"                         # filled from the other record
    assert m["_source"] == "library"
    assert m["_also_from"] == ["allevents"]


def test_merge_replaces_organizer_account_with_real_venue():
    venues = [{"name": "Discover Victoria Texas", "category": "Tourism / Events Aggregator"}]
    out = ce.merge_events([
        ev("Disney Pixar’s Finding Nemo JR.", venue="Discover Victoria Texas",
           description="Musical.", url="https://instagram.com/p/1", source="apify_instagram_posts"),
        ev("Disney's Finding Nemo JR", venue="Leo J. Welder Center for the Performing Arts",
           url="https://allevents.in/y", source="apify_instagram_posts"),
    ], venues=venues)
    assert len(out) == 1
    assert out[0]["venue"] == "Leo J. Welder Center for the Performing Arts"


def test_safe_fetch_tags_source():
    out = ce.safe_fetch("library", lambda: [ev("Story Time")], expect_events=False)
    assert out[0]["_source"] == "library"


# ─── Post extraction venue ────────────────────────────────────────────────

def test_post_event_venue_uses_named_venue_when_elsewhere():
    assert ce._post_event_venue({"venue": "DeLeon Plaza"}, "Discover Victoria Texas", "") == ("DeLeon Plaza", "")
    assert ce._post_event_venue({"venue": ""}, "Aero Crafters", "309 E Crestwood") == ("Aero Crafters", "309 E Crestwood")
    assert ce._post_event_venue({"venue": "Aero Crafters patio"}, "Aero Crafters", "309 E Crestwood") == ("Aero Crafters", "309 E Crestwood")


def test_extraction_prompt_asks_for_venue_and_victoria_only():
    captured = {}

    def fake_chat(api_key, messages, max_tokens, timeout=60):
        captured["prompt"] = messages[0]["content"]
        return "[]"

    with patch.dict(os.environ, {"OPENAI_API_KEY": "x"}), patch.object(ce, "_openai_chat", side_effect=fake_chat):
        ce._extract_events_from_posts_via_ai("Discover Victoria Texas", [{"text": "Big show Friday", "time": "2026-10-01"}])
    assert '"venue"' in captured["prompt"]
    assert "Victoria County" in captured["prompt"]


# ─── AllEvents multi-page ─────────────────────────────────────────────────

def _allevents_html(events):
    blocks = "".join(
        '<script type="application/ld+json">' + json.dumps({
            "@type": "Event", "name": n, "startDate": d, "url": u,
            "location": {"name": "Venue", "address": {"addressLocality": "Victoria", "streetAddress": "1 Main St"}},
        }) + "</script>"
        for n, d, u in events
    )
    return "<html><body>" + blocks + "</body></html>"


def test_allevents_reads_several_pages_and_dedupes_by_url():
    pages = {
        "all": _allevents_html([("A", "2026-10-01", "https://allevents.in/victoria/a/1000000001")]),
        "music": _allevents_html([("A", "2026-10-01", "https://allevents.in/victoria/a/1000000001"),
                                  ("B", "2026-10-02", "https://allevents.in/victoria/b/1000000002")]),
    }

    def fake_get(url, **kw):
        key = url.rsplit("/", 1)[-1]
        if key not in pages:
            raise RuntimeError("404")
        r = MagicMock()
        r.text = pages[key]
        r.raise_for_status = lambda: None
        return r

    with patch.object(ce, "http_get", side_effect=fake_get):
        out = ce.fetch_allevents_events()
    assert sorted(e["name"] for e in out) == ["A", "B"]


def test_allevents_keeps_the_listing_text_for_icons(monkeypatch):
    # "Spooky Starry Night" is a painting class. Without its text the icons
    # and the AI review guessed from the name alone and tagged it music.
    monkeypatch.setattr(ce, "in_window", lambda d: True)
    html_text = "<html><body><script type=\"application/ld+json\">" + json.dumps({
        "@type": "Event", "name": "Spooky Starry Night", "startDate": "2026-10-10T18:30:00-05:00",
        "url": "https://allevents.in/victoria/spooky-starry-night/200030777754000",
        "description": "Give a classic starry-night painting a spooky seasonal twist!\n\nSpend the evening creating your own canvas. &amp; more",
        "location": {"name": "2914 N Laurent St.", "address": {"addressLocality": "Victoria", "streetAddress": "2914 N Laurent St"}},
    }) + "</script></body></html>"
    events = []
    ce._parse_allevents_page(html_text, events, set())
    [ev] = events
    assert ev["description"] == ("Give a classic starry-night painting a spooky seasonal twist! "
                                 "Spend the evening creating your own canvas. & more")
    assert "arts" in ev["icons"] and "music" not in ev["icons"]


# ─── FB posts placeholder items ───────────────────────────────────────────

def test_fb_posts_ignores_apify_error_placeholders(monkeypatch):
    monkeypatch.setenv("FB_POSTS_ENABLED", "1")
    monkeypatch.setenv("APIFY_TOKEN", "t")
    monkeypatch.setenv("OPENAI_API_KEY", "k")
    monkeypatch.setattr(ce, "_APIFY_LIMIT_TRIPPED", False)
    venues = [{"name": "Dead Page Bar", "confidence": "high",
               "facebook_page": "https://facebook.com/deadpage"}]
    monkeypatch.setattr(ce, "_load_venue_list", lambda: (venues, "venues.json"))
    resp = MagicMock(status_code=200, text="[]")
    resp.json.return_value = [{"url": "https://facebook.com/deadpage", "error": "no_items"}]
    resp.raise_for_status = lambda: None
    called = []
    monkeypatch.setattr(ce, "_extract_events_from_posts_via_ai", lambda *a: called.append(a) or [])
    with patch.object(ce.requests, "post", return_value=resp):
        out = ce.fetch_apify_facebook_posts()
    assert out == []
    assert called == []  # no OpenAI call for a page with zero real posts


# ─── Eventbrite + Facebook events ─────────────────────────────────────────

def _apify_resp(items):
    r = MagicMock(status_code=200)
    r.json.return_value = items
    return r


def test_eventbrite_maps_fields_and_filters(monkeypatch):
    monkeypatch.setenv("APIFY_TOKEN", "t")
    monkeypatch.delenv("EVENTBRITE_ENABLED", raising=False)
    monkeypatch.setattr(ce, "_APIFY_LIMIT_TRIPPED", False)
    items = [
        {"name": "Next Stop Comedy", "startDate": "2026-10-09T21:00", "venueName": "La Cantina",
         "venueAddressLine1": "123 Main St", "venueCity": "Victoria", "isFree": False,
         "summary": "Stand-up night.", "url": "https://www.eventbrite.com/e/123?aff=x"},
        {"name": "Online Webinar", "startDate": "2026-10-09T12:00", "isOnline": True},
        {"name": "Corpus Show", "startDate": "2026-10-09T19:00", "venueName": "Hall", "venueCity": "Corpus Christi"},
        {"name": "Far Future", "startDate": "2027-01-01T19:00", "venueCity": "Victoria"},
    ]
    with patch.object(ce.requests, "post", return_value=_apify_resp(items)):
        out = ce.fetch_apify_eventbrite_events()
    assert len(out) == 1
    e = out[0]
    assert (e["date"], e["time"], e["venue"], e["address"]) == ("2026-10-09", "9:00 PM", "La Cantina", "123 Main St")
    assert e["url"] == "https://www.eventbrite.com/e/123"
    assert e["free"] is False


def test_eventbrite_can_be_disabled(monkeypatch):
    monkeypatch.setenv("APIFY_TOKEN", "t")
    monkeypatch.setenv("EVENTBRITE_ENABLED", "0")
    with patch.object(ce.requests, "post") as post:
        assert ce.fetch_apify_eventbrite_events() == []
    post.assert_not_called()


def test_facebook_events_use_victoria_time_not_utc(monkeypatch):
    monkeypatch.setenv("APIFY_TOKEN", "t")
    monkeypatch.setattr(ce, "_APIFY_LIMIT_TRIPPED", False)
    monkeypatch.setattr(ce, "_load_venue_list", lambda: ([{"name": "x"}], "venues.json"))
    # 7 PM CDT on Oct 9 is 00:00Z on Oct 10.
    items = [{"name": "Late Show", "utcStartDate": "2026-10-10T00:00:00.000Z",
              "location": {"name": "Aero Crafters", "city": "Victoria, TX"}}]
    with patch.object(ce.requests, "post", return_value=_apify_resp(items)):
        out = ce.fetch_apify_facebook_events()
    assert out[0]["date"] == "2026-10-09"
    assert out[0]["time"] == "7:00 PM"


def test_facebook_events_runs_both_searches_and_dedupes(monkeypatch):
    monkeypatch.setenv("APIFY_TOKEN", "t")
    monkeypatch.delenv("FB_EVENTS_ALT_ENABLED", raising=False)
    monkeypatch.setattr(ce, "_APIFY_LIMIT_TRIPPED", False)
    monkeypatch.setattr(ce, "_load_venue_list", lambda: ([{"name": "x"}], "venues.json"))
    loc = {"name": "Hall", "city": "Victoria, TX"}
    by_actor = {
        ce.APIFY_FB_ACTOR: [{"id": "1", "name": "Shared", "utcStartDate": "2026-10-09T23:00:00Z", "location": loc}],
        ce.APIFY_FB_ALT_ACTOR: [{"id": "1", "name": "Shared", "utcStartDate": "2026-10-09T23:00:00Z", "location": loc},
                                {"id": "2", "name": "Only Alt", "utcStartDate": "2026-10-10T23:00:00Z", "location": loc}],
    }
    calls = []

    def fake_post(url, **kw):
        actor = url.split("/acts/")[1].split("/")[0]
        calls.append(actor)
        return _apify_resp(by_actor[actor])

    with patch.object(ce.requests, "post", side_effect=fake_post):
        out = ce.fetch_apify_facebook_events()
    assert calls == [ce.APIFY_FB_ACTOR, ce.APIFY_FB_ALT_ACTOR]
    assert sorted(e["name"] for e in out) == ["Only Alt", "Shared"]

    monkeypatch.setenv("FB_EVENTS_ALT_ENABLED", "0")
    calls.clear()
    with patch.object(ce.requests, "post", side_effect=fake_post):
        ce.fetch_apify_facebook_events()
    assert calls == [ce.APIFY_FB_ACTOR]


# ─── Non-event filter (2026-10 auto-publish) ────────────────────────────────

def test_religious_and_church_hosted_events_are_dropped():
    for name, desc in [
        ("A Service of Seeking the Lord in Repentance", "Public worship service focused on repentance."),
        ("Uniting Hearts Music Festival", "An interfaith day of music, worship, and fellowship."),
        ("Wednesday Night Bible Study", ""),
        ("Gospel Brunch", "Gospel singers and brunch."),
        ("Fall Revival", ""),
    ]:
        assert ce.non_event_reason(ev(name, description=desc)) in ("religious event", "worship service"), name
    # Church-hosted community events are left off too (owner's call, Oct 2026).
    assert ce.non_event_reason(ev("Emmanuel Lutheran Church Fall Fun Fest", description="Fall fun.")) == "church event"
    assert ce.non_event_reason(ev("Luther Fest", venue="Trinity Lutheran Church")) == "church event"
    assert ce.non_event_reason(ev("2026 Our Lady of Victory Parish Fall Festival")) == "church event"
    assert ce.non_event_reason(ev("Fish Fry", description="St. Mary church fish fry fundraiser.")) == "church event"
    for name, desc, venue, address in [
        ("Christkindl Market", "Holiday market with Christ Kindl vendors.", "", ""),
        ("Massage Workshop", "", "", ""),
        ("Corpus Christi Day Trip", "", "", ""),
        ("Live Music", "", "Church Street Tavern", ""),
        ("Trivia Night", "", "The Pub", "101 N Church St"),
    ]:
        assert ce.non_event_reason(ev(name, description=desc, venue=venue, address=address)) is None, name


def test_non_event_reason_catches_listings_not_events():
    assert ce.non_event_reason(ev("Internship Program", venue="The Texas Zoo"))
    assert ce.non_event_reason(ev("Field Trip Booking", venue="J Welch Farms"))
    assert ce.non_event_reason(ev("National Drink Beer Day", venue="La Cantina"))
    assert ce.non_event_reason(ev("Now Hiring Bartenders"))
    # A real event on an awareness day, with a time, stays.
    assert ce.non_event_reason(ev("National Taco Day Party", time="6:00 PM")) is None
    assert ce.non_event_reason(ev("Job Fair", time="10:00 AM")) is None
    assert ce.non_event_reason(ev("Tejas Fest 2026")) is None


def test_merge_drops_non_events_and_decodes_entities():
    out = ce.merge_events([
        ev("Field Trip Booking", venue="J Welch Farms", source="apify_instagram_posts"),
        ev("Walk to End Alzheimer&#39;s", venue="Texas A&amp;M University-Victoria", source="allevents", time="9:00 AM"),
        ev("Field Trip Booking", venue="Somewhere", source="local_events"),  # curated YAML is trusted
    ], venues=[])
    names = [e["name"] for e in out]
    assert "Walk to End Alzheimer's" in names
    assert any(e["venue"] == "Texas A&M University-Victoria" for e in out)
    assert names.count("Field Trip Booking") == 1


def test_listing_urls_are_not_event_links():
    from collect_events import is_listing_url
    for u in ("https://www.eventbrite.com/b/tx--victoria/music/",
              "https://www.eventbrite.com/d/tx--victoria/events/",
              "https://allevents.in/victoria", "https://allevents.in/victoria/all",
              "https://www.facebook.com/events/"):
        assert is_listing_url(u), u
    for u in ("https://www.eventbrite.com/e/josh-abbott-acoustic-tickets-123456",
              "https://allevents.in/victoria/tejas-fest-2026/200030008232138",
              "https://www.facebook.com/events/1234567890/", ""):
        assert not is_listing_url(u), u


def test_drop_dead_links_only_removes_not_found():
    from collect_events import drop_dead_links

    class R:
        def __init__(self, c): self.status_code = c

    codes = {"https://a.com/gone": 404, "https://b.com/ok": 200, "https://c.com/bot": 403}
    calls = []

    def get(u):
        calls.append(u)
        if u == "https://d.com/down":
            raise ConnectionError("down")
        return R(codes[u])

    evs = [{"url": u} for u in ["https://a.com/gone", "https://a.com/gone", "https://b.com/ok",
                                "https://c.com/bot", "https://d.com/down", "https://www.facebook.com/x", ""]]
    out = drop_dead_links(evs, get=get)
    assert [e["url"] for e in out] == ["", "", "https://b.com/ok", "https://c.com/bot",
                                       "https://d.com/down", "https://www.facebook.com/x", ""]
    assert calls.count("https://a.com/gone") == 1 and "https://www.facebook.com/x" not in calls


def test_same_name_different_venues_stay_separate():
    from collect_events import is_same_event
    a = {"date": "2026-10-10", "name": "Live Music", "venue": "Moonshine Drinkery"}
    b = {"date": "2026-10-10", "name": "Live Music", "venue": "Aero Crafters"}
    c = {"date": "2026-10-10", "name": "Live Music!", "venue": "Moonshine Drinkery Victoria"}
    d = {"date": "2026-10-10", "name": "Live Music", "venue": ""}
    assert not is_same_event(a, b)
    assert is_same_event(a, c)
    assert is_same_event(a, d)


def test_unquoted_yaml_values_dont_abort(tmp_path, monkeypatch):
    from datetime import date, timedelta
    import collect_events as ce
    _window_around_today(monkeypatch)
    d = (ce.now_central().date() + timedelta(days=1)).isoformat()
    p = tmp_path / "local.yaml"
    p.write_text(f"events:\n  - date: {d}\n    name: 1776\n    time: 19:00\n  - date: not-a-date\n    name: Broken\n")
    out = ce.load_local_events(str(p), days_ahead=7)
    assert [e["name"] for e in out] == ["1776"]
    assert out[0]["time"] == "7:00 PM" and out[0]["date"] == d
    merged = ce.merge_events(out, venues=[])
    assert merged and merged[0]["name"] == "1776"


# ─── Gemini + Google Search ───────────────────────────────────────────────

def _gemini_reply(items, hosts=("facebook.com", "victoriatx.gov")):
    import json as _json

    class R:
        status_code = 200
        text = ""

        def json(self):
            return {"candidates": [{
                "content": {"parts": [{"text": "```json\n" + _json.dumps(items) + "\n```"}]},
                "groundingMetadata": {"groundingChunks": [
                    {"web": {"uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc", "title": h}} for h in hosts]},
            }]}
    return R()


def test_gemini_keeps_only_grounded_in_window_events(monkeypatch):
    from datetime import timedelta
    import collect_events as ce
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    today = ce.now_central().date()
    monkeypatch.setattr(ce, "_WINDOW_START", today)
    monkeypatch.setattr(ce, "_WINDOW_END", today + timedelta(days=14))
    d = (today + timedelta(days=2)).isoformat()
    items = [
        {"name": "Fall Fest", "date": d, "time": "6:00 PM", "venue": "DeLeon Plaza",
         "url": "https://www.victoriatx.gov/Calendar.aspx?EID=1", "free": True},
        {"name": "Band Night", "date": d, "venue": "Bar", "url": "https://www.facebook.com/events/123/"},
        {"name": "Made Up Gala", "date": d, "venue": "X", "url": "https://totally-invented.example/gala"},
        {"name": "Old Thing", "date": "2020-01-01", "venue": "X", "url": "https://www.facebook.com/events/9/"},
        {"name": "No Link", "date": d, "venue": "X", "url": ""},
        {"name": "Search Page", "date": d, "venue": "X", "url": "https://www.eventbrite.com/d/tx--victoria/events/"},
    ]
    calls = []

    def post(url, json=None, timeout=None, headers=None):
        calls.append((url, json, headers))
        return _gemini_reply(items, hosts=("facebook.com", "victoriatx.gov", "eventbrite.com"))

    class Page:
        def __init__(self, code, text=""):
            self.status_code, self.text = code, text

    def get(url):
        if "invented" in url:
            return Page(404)
        if "victoriatx" in url:
            return Page(200, "<h1>Fall Fest</h1> at DeLeon Plaza")
        return Page(200, "<h1>Pumpkin Patch Party</h1> Oct at the farm")

    items.append({"name": "Pumpkin Patch Party", "date": d, "venue": "Farm", "url": "https://somefarm.example/events/pumpkin"})
    out = ce.fetch_gemini_events(14, post=post, categories=["music"], get=get)
    assert [e["name"] for e in out] == ["Fall Fest", "Band Night", "Pumpkin Patch Party"]
    assert out[0]["free"] is True and out[0]["time"] == "6:00 PM"
    assert calls[0][1]["tools"] == [{"google_search": {}}]
    assert calls[0][2]["x-goog-api-key"] == "k"
    assert "gemini-2.5-flash" in calls[0][0]


def test_gemini_skips_without_key_and_stops_on_bad_key(monkeypatch):
    import collect_events as ce
    _window_around_today(monkeypatch)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    assert ce.fetch_gemini_events(14, post=lambda *a, **k: 1 / 0) == []

    monkeypatch.setenv("GEMINI_API_KEY", "bad")
    n = []

    class R:
        status_code = 403
        text = "denied"

    def post(*a, **k):
        n.append(1)
        return R()
    assert ce.fetch_gemini_events(14, post=post, workers=1) == []
    assert len(n) == 1


def test_worship_and_members_only_are_filtered_but_church_festivals_stay():
    import collect_events as ce
    drop = ["Confessions", "Mass in English at Our Lady of Sorrows", "Santa Misa en Espanol", "Baptism Class",
            "Communion Service", "Cathedral Charities Collection", "Rosary Congress",
            "Catholic Daughters of the Americas Meeting", "Victoria Rotary Club Board Meeting",
            "Way Truth Life (WTL) Meet & Sweets",
            "Victoria College Physical Therapist Assistant Program Color Ceremony",
            # Religious music counts as a religious event (owner's call, Oct 2026).
            "Christmas Mass Choir Concert",
            # Church-hosted events are left off too (owner's call, Oct 2026).
            "Our Lady of Victory's 2026 Fall Festival", "Church Fish Fry"]
    keep = [
            "Massive Garage Sale", "Meet and Greet with Santa", "Bingo Night", "Symphonic Spooktacular"]
    assert all(ce.non_event_reason({"name": n}) for n in drop), [n for n in drop if not ce.non_event_reason({"name": n})]
    assert not any(ce.non_event_reason({"name": n}) for n in keep), [n for n in keep if ce.non_event_reason({"name": n})]


def test_gemini_notable_keeps_linked_grounded_items(monkeypatch):
    import collect_events as ce
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    items = [
        {"name": "Ellianos Coffee opens on Airline Rd", "description": "Double drive-thru at 605 E. Airline Road.",
         "tag": "new", "icon": "food", "url": "https://www.victoriaadvocate.com/news/ellianos"},
        {"name": "Made-up bistro", "description": "x", "tag": "coming", "icon": "food",
         "url": "https://invented.example/bistro"},
        {"name": "New church campus opens", "description": "A new worship center.", "tag": "new",
         "icon": "community", "url": "https://www.victoriaadvocate.com/news/church"},
        {"name": "No link shop", "description": "x", "tag": "new", "icon": "shopping", "url": ""},
        {"name": "Odd icon arcade", "description": "Arcade on Navarro.", "tag": "weird", "icon": "laser",
         "url": "https://www.victoriaadvocate.com/news/arcade"},
    ]
    calls = []

    def post(url, json=None, timeout=None, headers=None):
        calls.append(json)
        return _gemini_reply(items, hosts=("victoriaadvocate.com",))

    class Page:
        def __init__(self, url):
            self.url, self.status_code = url, 200
            self.text = {"ellianos": "Ellianos Coffee opens on Airline Rd", "arcade": "Odd icon arcade opens"}.get(url.rsplit("/", 1)[-1], "")

    out = ce.fetch_gemini_notable(post=post, get=Page)
    assert [n["name"] for n in out] == ["Ellianos Coffee opens on Airline Rd", "Odd icon arcade"]
    assert out[0]["url"].startswith("https://www.victoriaadvocate.com/")
    assert out[0]["added"] == ce.now_central().date().isoformat()
    assert out[0]["checked"] is True
    assert out[1]["tag"] == "new" and out[1]["icon"] == "community"  # unknown values fall back
    assert calls[0]["tools"] == [{"google_search": {}}]


def test_gemini_notable_checks_links_even_on_cited_sites(monkeypatch):
    # Virginia Beach, Oct 2026: a cited site's page that 404s, a city page that
    # doesn't name the item, and one made-up Instagram post given for three
    # different places all reached the homepage box.
    import collect_events as ce
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    post_url = "https://www.instagram.com/p/C4O0513u457/"
    items = [
        {"name": "Front Porch Cafe", "description": "x", "tag": "coming", "icon": "food",
         "url": "https://frontporchcafe.com/virginia-beach/"},
        {"name": "Where Wonder Grows art installation", "description": "x", "tag": "coming", "icon": "arts",
         "url": "https://www.virginiabeach.gov/venues"},
        {"name": "Abercrombie & Fitch at Town Center", "description": "x", "tag": "coming", "icon": "shopping", "url": post_url},
        {"name": "Safari Fun Park", "description": "x", "tag": "coming", "icon": "family", "url": post_url},
        {"name": "Fogo de Chao at Pembroke", "description": "x", "tag": "coming", "icon": "food", "url": post_url},
        {"name": "Grand Bakery opens downtown", "description": "x", "tag": "new", "icon": "food",
         "url": "https://www.instagram.com/p/GrandBakery1/"},
        {"name": "Tide Taproom on Atlantic", "description": "x", "tag": "new", "icon": "drinks",
         "url": "https://www.instagram.com/tidetaproom"},
    ]

    def post(url, json=None, timeout=None, headers=None):
        return _gemini_reply(items, hosts=("frontporchcafe.com", "virginiabeach.gov", "instagram.com"))

    class Page:
        def __init__(self, url):
            self.url = url
            self.status_code = 404 if "frontporch" in url else 200
            self.text = "Venues: Sandler Center, Convention Center"

    out = ce.fetch_gemini_notable(post=post, get=Page)
    # Only the one Instagram post given for one place stands: the 404, the
    # page that doesn't name its item, the shared post and a bare profile go.
    assert [n["name"] for n in out] == ["Grand Bakery opens downtown"]


def test_gemini_notable_off_without_key(monkeypatch):
    import collect_events as ce
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    assert ce.fetch_gemini_notable(post=lambda *a, **k: 1 / 0) == []


def test_library_guessed_venue_merges_with_the_real_place():
    # 2026-10-06: the library calendar files every program under the library;
    # the city calendar says this one meets at Vida Cafe. Same event.
    city = ev("Bookish Society Book Club", date="2026-10-06", venue="Vida Cafe",
              address="105 Spring Green Blvd", time="6:00 PM – 7:00 PM", source="city_calendar",
              url="https://www.victoriatx.gov/Calendar.aspx?EID=3969")
    lib = ev("Bookish Society Book Club", date="2026-10-06", venue="Victoria Public Library",
             address="302 N. Main St.", time="6:00PM – 7:00PM", source="library", _venue_guess=True,
             url="https://victoriapl.librarycalendar.com/event/bookish-society-book-club-8996")
    assert ce.is_same_event(city, lib)
    for order in ([city, lib], [lib, city]):
        out = ce.merge_events([dict(e) for e in order], venues=[])
        assert len(out) == 1
        assert out[0]["venue"] == "Vida Cafe"
        assert out[0]["address"] == "105 Spring Green Blvd"
        assert "_venue_guess" not in out[0]


def test_guessed_venue_still_needs_the_same_start_time():
    lib = ev("Book Club", date="2026-10-06", venue="Victoria Public Library", time="6:00 PM", _venue_guess=True)
    assert not ce.is_same_event(lib, ev("Book Club", date="2026-10-06", venue="Vida Cafe", time="10:00 AM"))
    assert not ce.is_same_event(lib, ev("Book Club", date="2026-10-06", venue="Vida Cafe"))
    # Two places that both stated their venue stay apart, as before.
    assert not ce.is_same_event(ev("Open Mic Night", venue="Weber Brewing", time="7:00 PM"),
                                ev("Open Mic Night", venue="Aero Crafters", time="7:00 PM"))



def test_cut_off_names_are_caught_and_dropped():
    # 2026-10-08: post text cut at 400 chars became these names.
    assert ce.cut_off_name_reason("Scenic Root — Plant a")
    assert ce.cut_off_name_reason("Scenic Root — Once Upon...")
    assert ce.cut_off_name_reason("Live Music with…")
    assert ce.cut_off_name_reason("Paint and Sip with the")
    # Real names the first version caught (review of #83).
    for ok in ["Plant and Sip with Scenic Root", "Paint & Sip", "Once Upon A Time", "Bring Your Own",
               "Q&A", "Trivia w/ Sam", "Stand By Me", "A",
               "2026 Stroman High School Mega Reunion Class of 1969-2000", "Countdown to 2027", "Taste of 361",
               "Teen Lock-In", "Cruise-In", "Sonic Cruise In", "Bring It On", "Game On", "Hands On",
               "Stand By", "Plan A", "Vitamin A", "Opt In", "Check-in", "Drive-In Movie Night"]:
        assert ce.cut_off_name_reason(ok) is None, ok
    out = ce.merge_events([
        ev("Scenic Root — Plant a", date="2026-10-08", venue="Moonshine Drinkery", source="apify_instagram_posts"),
        ev("Once Upon A Plant: Maas Edition", date="2026-10-08", venue="Moonshine Drinkery", source="allevents"),
    ], venues=[])
    assert [e["name"] for e in out] == ["Once Upon A Plant: Maas Edition"]
    # Only AI-written names are dropped; an official calendar's name stays
    # even if it looks odd (the event check flags it instead).
    out = ce.merge_events([ev("Story Time with the", date="2026-10-08", venue="Library", source="library")], venues=[])
    assert [e["name"] for e in out] == ["Story Time with the"]


def test_post_text_is_cut_on_a_word_and_marked():
    long = "Big week! " * 100 + "Scenic Root will be out on Thursday, 10/8 for a Plant and Sip!!"
    cut = ce._trim_post_text(long, limit=1000)
    assert cut.endswith(" [post continues]")
    assert not cut[:-len(" [post continues]")].endswith(("Bi", "wee"))
    short = "Scenic Root will be out on Thursday, 10/8 for a Plant and Sip!!"
    assert ce._trim_post_text(short) == short


def test_post_prompt_gets_the_whole_post_and_the_naming_rules(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    caption = ("🌿 " + "Fall is here and we have so much going on this month at the bar. " * 6 +
               "Scenic Root will be out on Thursday, 10/8 for a Plant and Sip!!🪴")
    assert len(caption) > 400
    seen = {}
    def fake_chat(key, messages, max_tokens, timeout):
        seen["prompt"] = messages[0]["content"]
        return "[]"
    monkeypatch.setattr(ce, "_openai_chat", fake_chat)
    ce._extract_events_from_posts_via_ai("Moonshine Drinkery", [{"text": caption, "timestamp": "2026-10-04"}])
    assert "for a Plant and Sip!!" in seen["prompt"]
    assert "Plant and Sip with Scenic Root" in seen["prompt"]
    assert "Don't add performers" in seen["prompt"]


def test_guessed_library_venue_needs_more_than_a_shared_start():
    lib = lambda name, time: ev(name, date="2026-10-06", venue="Victoria Public Library", address="302 N. Main St.",
                                time=time, source="library", _venue_guess=True)
    # Generic name at another venue, same start: two events (review finding).
    assert not ce.is_same_event(lib("Story Time", "10:00AM – 10:30AM"),
                                ev("Story Time", date="2026-10-06", venue="Barnes & Noble", time="10:00 AM", source="allevents"))
    # The city calendar republishes library programs: same event.
    assert ce.is_same_event(lib("Pickleball Games", "6:00PM – 7:30PM"),
                            ev("Pickleball Games", date="2026-10-06", venue="Youth Sports Complex",
                               time="6:00 PM – 7:30 PM", source="city_calendar"))
    # Anyone else: only with the same full time range.
    assert ce.is_same_event(lib("Teen Craft", "4:00PM – 5:00PM"),
                            ev("Teen Craft", date="2026-10-06", venue="Nave Museum", time="4:00 PM - 5:00 PM", source="allevents"))
    # "6-8 PM" starts at 6, so it doesn't match an 8 PM listing.
    assert not ce.is_same_event(lib("Live Music", "6-8 PM"),
                                ev("Live Music", date="2026-10-06", venue="Pumphouse", time="8:00 PM", source="city_calendar"))


def test_guessed_venue_never_gives_way_to_an_organizer_or_a_copy_of_itself():
    venues = [{"name": "Discover Victoria Texas", "category": "Tourism / Events Aggregator"}]
    out = ce.merge_events([
        ev("Teen Book Club", date="2026-10-06", venue="Victoria Public Library", address="302 N. Main St.",
           time="6:00PM", source="library", _venue_guess=True),
        ev("Teen Book Club", date="2026-10-06", venue="Discover Victoria Texas", time="6:00 PM",
           source="apify_facebook_posts"),
    ], venues=venues)
    assert len(out) == 1 and out[0]["venue"] == "Victoria Public Library" and out[0]["address"] == "302 N. Main St."
    # An aggregator repeating the library's venue keeps the guess, so the
    # city calendar's real place still merges in afterwards.
    out = ce.merge_events([
        ev("Book Club", date="2026-10-06", venue="Victoria Public Library", time="6:00PM – 7:00PM",
           source="library", _venue_guess=True),
        ev("Book Club", date="2026-10-06", venue="Victoria Public Library", time="6:00 PM", source="gemini_search"),
        ev("Book Club", date="2026-10-06", venue="Vida Cafe", time="6:00 PM – 7:00 PM", source="city_calendar"),
    ], venues=[])
    assert [e["venue"] for e in out] == ["Vida Cafe"]


def test_start_minutes_reads_ranges_and_words():
    assert ce._start_minutes("6-8 PM") == 18 * 60
    assert ce._start_minutes("6:30-8 PM") == 18 * 60 + 30
    assert ce._start_minutes("Noon") == 12 * 60
    assert ce._start_minutes("6 p.m.") == 18 * 60
    assert ce._start_minutes("All day") is None
