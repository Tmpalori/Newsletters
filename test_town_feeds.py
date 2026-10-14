"""town_feeds.py: the iCalendar, The Events Calendar and Localist readers
behind the "town_feeds" collector source, and the source itself."""
import glob
import json
import os
from datetime import date
from zoneinfo import ZoneInfo

import pytest

import collect_events
import town
import town_feeds

ROOT = os.path.dirname(os.path.abspath(__file__))
CT = ZoneInfo("America/Chicago")
START, END = date(2026, 10, 12), date(2026, 10, 25)

ICS = (
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"
    # A TZID start and end, a folded description with escapes, a URL.
    "BEGIN:VEVENT\r\nUID:1\r\nSUMMARY:Fall Fest on Fairpark\r\n"
    "DTSTART;TZID=America/Chicago:20261016T190000\r\nDTEND;TZID=America/Chicago:20261016T210000\r\n"
    "LOCATION:Fairpark\\, 100 Main St\\, Tupelo\\, MS\r\n"
    "DESCRIPTION:Live music\\, food trucks\\nand a kids' zone. Bring a\r\n  chair.\r\n"
    "URL:https://example.org/fest\r\nEND:VEVENT\r\n"
    # UTC: 01:30Z on the 18th is 8:30 PM on the 17th in Central.
    "BEGIN:VEVENT\r\nUID:2\r\nSUMMARY:Late Show\r\nDTSTART:20261018T013000Z\r\nEND:VEVENT\r\n"
    # All day.
    "BEGIN:VEVENT\r\nUID:3\r\nSUMMARY:Craft Fair\r\nDTSTART;VALUE=DATE:20261024\r\nDTEND;VALUE=DATE:20261025\r\nEND:VEVENT\r\n"
    # Cancelled, outside the window, no summary: all left out.
    "BEGIN:VEVENT\r\nUID:4\r\nSUMMARY:Called Off\r\nSTATUS:CANCELLED\r\nDTSTART:20261020T180000\r\nEND:VEVENT\r\n"
    "BEGIN:VEVENT\r\nUID:5\r\nSUMMARY:Too Late\r\nDTSTART:20261130T180000\r\nEND:VEVENT\r\n"
    "BEGIN:VEVENT\r\nUID:6\r\nDTSTART:20261020T180000\r\nEND:VEVENT\r\n"
    "END:VCALENDAR\r\n"
)


def test_ics_reads_times_in_the_towns_zone():
    evs = town_feeds.parse_ics(ICS, CT, START, END)
    assert [e["name"] for e in evs] == ["Fall Fest on Fairpark", "Late Show", "Craft Fair"]
    fest, late, fair = evs
    assert fest["date"] == "2026-10-16" and fest["time"] == "7:00 PM – 9:00 PM"
    assert fest["venue"] == "Fairpark" and fest["address"] == "100 Main St, Tupelo, MS"
    assert fest["description"] == "Live music, food trucks and a kids' zone. Bring a chair."
    assert fest["url"] == "https://example.org/fest"
    assert late["date"] == "2026-10-17" and late["time"] == "8:30 PM"
    assert fair["date"] == "2026-10-24" and fair["time"] == ""


def test_ics_floating_time_is_the_towns():
    text = "BEGIN:VEVENT\nSUMMARY:Trivia\nDTSTART:20261014T190000\nEND:VEVENT\n"
    assert town_feeds.parse_ics(text, ZoneInfo("America/Los_Angeles"), START, END)[0]["time"] == "7:00 PM"


TRIBE_PAGE_1 = {
    "events": [
        {"title": "Brews on the Bricks", "start_date": "2026-10-17 18:00:00", "end_date": "2026-10-17 21:00:00",
         "all_day": False, "url": "https://visit.example/event/brews/", "description": "<p>Local breweries pour.</p>",
         "cost": "Free", "venue": {"venue": "Downtown Kearney", "address": "2100 Central Ave", "city": "Kearney"}},
        {"title": "Crane Count", "start_date": "2026-10-20 00:00:00", "end_date": "2026-10-20 23:59:59",
         "all_day": True, "url": "https://visit.example/event/cranes/", "venue": []},
        {"title": "Out of window", "start_date": "2026-11-20 10:00:00", "end_date": "2026-11-20 11:00:00"},
    ],
    "next_rest_url": "https://visit.example/wp-json/tribe/events/v1/events?page=2",
}


def test_tribe_page():
    evs, nxt = town_feeds.parse_tribe(TRIBE_PAGE_1, CT, START, END)
    assert nxt.endswith("page=2")
    brews, cranes = evs
    assert brews["time"] == "6:00 PM – 9:00 PM" and brews["free"] is True
    assert brews["venue"] == "Downtown Kearney" and brews["address"] == "2100 Central Ave, Kearney"
    assert brews["description"] == "Local breweries pour."
    assert cranes["time"] == "" and cranes["venue"] == "" and "free" not in cranes


LOCALIST = {
    "events": [{"event": {
        "title": "Harvest Concert", "localist_url": "https://cal.example/event/harvest", "location_name": "Craterian",
        "address": "23 S Central Ave, Medford", "description_text": "Bluegrass to close the season.", "free": False,
        "event_instances": [
            {"event_instance": {"start": "2026-10-17T19:30:00-07:00", "end": "2026-10-17T21:30:00-07:00"}},
            {"event_instance": {"start": "2026-10-24T19:30:00-07:00", "end": None}},
            {"event_instance": {"start": "2026-12-01T19:30:00-08:00"}},
        ]}}],
    "page": {"current": 1, "size": 100, "total": 3},
}


def test_localist_instances_inside_the_window():
    evs, total = town_feeds.parse_localist(LOCALIST, ZoneInfo("America/Los_Angeles"), START, END)
    assert total == 3
    assert [(e["date"], e["time"]) for e in evs] == [("2026-10-17", "7:30 PM – 9:30 PM"), ("2026-10-24", "7:30 PM")]
    assert evs[0]["venue"] == "Craterian" and evs[0]["url"] == "https://cal.example/event/harvest"


class _Resp:
    def __init__(self, body):
        self.body = body
        self.text = body if isinstance(body, str) else json.dumps(body)

    def json(self):
        return self.body


def test_fetch_feed_follows_pages_and_stops_at_the_cap():
    calls = []

    def get(url):
        calls.append(url)
        return _Resp(TRIBE_PAGE_1)          # every page says there's another

    evs = town_feeds.fetch_feed({"name": "v", "type": "tribe", "url": "https://visit.example/"}, get, CT, START, END)
    assert len(calls) == town_feeds.MAX_PAGES and len(evs) == 2 * town_feeds.MAX_PAGES
    assert calls[0] == "https://visit.example/wp-json/tribe/events/v1/events?start_date=2026-10-12&end_date=2026-10-25%2023:59:59&per_page=50"

    calls.clear()
    town_feeds.fetch_feed({"name": "c", "type": "localist", "url": "https://cal.example"},
                          lambda u: calls.append(u) or _Resp(LOCALIST), CT, START, END)
    assert [c.rsplit("page=", 1)[1] for c in calls] == ["1", "2", "3"]
    assert "start=2026-10-12&days=14" in calls[0]


@pytest.mark.parametrize("feeds,msg", [
    ("x", "must be a list"),
    ([{"name": "Bad Name", "type": "ics", "url": "https://a"}], "snake_case"),
    ([{"name": "a", "type": "rss", "url": "https://a"}], "type must be"),
    ([{"name": "a", "type": "ics", "url": "http://a"}], "https://"),
    ([{"name": "a", "type": "ics", "url": "https://a"}, {"name": "a", "type": "ics", "url": "https://b"}], "unique"),
])
def test_check_feeds_rejects(feeds, msg):
    with pytest.raises(ValueError, match=msg):
        town_feeds.check_feeds(feeds)


@pytest.mark.parametrize("path", sorted(glob.glob(os.path.join(ROOT, "towns", "*", "town.json"))))
def test_every_towns_feeds_are_valid(path):
    town_feeds.check_feeds(json.load(open(path)).get("feeds"))


def test_victoria_does_not_run_feeds():
    assert "town_feeds" not in [n for n, _, _ in collect_events.enabled_web_sources(town.VICTORIA)]


def test_source_keeps_going_when_one_feed_fails(monkeypatch):
    t = town.town_config(town={"id": "bay", "siteName": "The Bay 979", "domain": "thebay979.com", "city": "Bay City",
                               "state": "TX", "stateName": "Texas", "timezone": "America/Chicago",
                               "feeds": [{"name": "broken", "type": "ics", "url": "https://broken.example/c.ics"},
                                         {"name": "good", "type": "ics", "url": "https://good.example/c.ics"}]})
    monkeypatch.setattr(collect_events, "TOWN", t)
    monkeypatch.setattr(collect_events, "_WINDOW_START", START)
    monkeypatch.setattr(collect_events, "_WINDOW_END", END)

    def get(url, **_):
        if "broken" in url:
            raise RuntimeError("HTTP 500")
        return _Resp(ICS)

    monkeypatch.setattr(collect_events, "http_get", get)
    evs = collect_events.safe_fetch("town_feeds", collect_events.fetch_town_feeds, args=(14,), expect_events=False)
    assert [e["name"] for e in evs] == ["Fall Fest on Fairpark", "Late Show", "Craft Fair"]
    assert all(e["_source"] == "town_feeds" and e["_feed"] == "good" and e["icons"] for e in evs)
    stat = [s for s in collect_events._SOURCE_STATS if s["name"] == "town_feeds"][-1]
    assert stat["status"] == "partial" and "broken failed" in stat["message"] and "good 3" in stat["message"]


SQUARESPACE = {"upcoming": [
    {"title": "Lego Club", "startDate": 1791837000000, "endDate": 1791842400000, "fullUrl": "/events/lego",
     "body": "<p>Build &amp; play.</p>",
     "location": {"addressTitle": "Lee County Library", "addressLine1": "219 N Madison St", "addressLine2": "Tupelo, MS, 38804"}},
    {"title": "Too late", "startDate": 1796000000000},
]}


def test_squarespace_events():
    evs = town_feeds.parse_squarespace(SQUARESPACE, CT, START, END, base="https://lib.example")
    assert evs == [{"date": "2026-10-12", "name": "Lego Club", "time": "3:30 PM – 5:00 PM", "venue": "Lee County Library",
                    "address": "219 N Madison St, Tupelo, MS, 38804", "description": "Build & play.",
                    "url": "https://lib.example/events/lego"}]


def _card(day, title, href, address=("Backline Music Hall", "5339 Cliff Gookin Blvd", "Tupelo, MS 38804")):
    spans = "".join(f"<span>{a}</span>" for a in address)
    return (f'<article class="card"><p class="card__date-heading">{day}</p><h2 class="card__heading">'
            f'<a href="{href}">{title}</a></h2><span class="card__address">{spans}</span></article>')


def test_cards_listing():
    page = "".join([
        _card("Oct. 12", "Board Game Night", "https://t.example/events/games/"),
        _card("Oct. 12 to Nov. 25", "Long Exhibit", "https://t.example/events/exhibit/"),      # a run: skipped
        _card("Oct. 13 to Oct. 14", "Flea Market", "https://t.example/events/flea/", ("1879 Coley Rd", "Tupelo, MS")),
        _card("Oct. 30", "Past the window", "https://t.example/events/late/"),
    ])
    evs, past_end = town_feeds.parse_cards(page, START, END)
    assert past_end is True
    assert [(e["date"], e["name"], e["venue"], e["address"]) for e in evs] == [
        ("2026-10-12", "Board Game Night", "Backline Music Hall", "5339 Cliff Gookin Blvd, Tupelo, MS 38804"),
        ("2026-10-13", "Flea Market", "", "1879 Coley Rd, Tupelo, MS")]


def test_cards_year_rolls_over_in_december():
    assert town_feeds._card_day("Jan. 3", date(2026, 12, 28)) == date(2027, 1, 3)
    assert town_feeds._card_day("Dec. 30", date(2026, 12, 28)) == date(2026, 12, 30)


def test_cards_fetch_takes_times_from_each_event_page():
    pages = {
        "https://t.example/events/?page=1": _card("Oct. 12", "Board Game Night", "https://t.example/events/games/")
        + _card("Oct. 13", "Flea Market", "https://t.example/events/flea/") + _card("Oct. 31", "Late", "https://t.example/x/"),
        # A repeating event's startDate is its first date ever: only the time is used.
        "https://t.example/events/games/": '{"startDate":"2025-05-16T18:30:00-05:00","endDate":"2025-05-16T22:00:00-05:00"} Admission <b>Free</b>',
        "https://t.example/events/flea/": '{"startDate":"2026-10-13T00:00:00-05:00","endDate":"2026-10-13T23:59:00-05:00"}',
    }
    calls = []
    evs = town_feeds.fetch_feed({"name": "cvb", "type": "cards", "url": "https://t.example/events/"},
                                lambda u: calls.append(u) or _Resp(pages[u]), CT, START, END)
    assert [(e["date"], e["time"], e.get("free")) for e in evs] == [
        ("2026-10-12", "6:30 PM – 10:00 PM", True), ("2026-10-13", "", None)]
    assert "https://t.example/events/?page=2" not in calls     # page 1 already went past the window


def test_collapse_runs_keeps_a_daily_exhibit_once():
    daily = [{"date": f"2026-10-{d}", "name": "Fall Exhibit", "venue": "Gallery"} for d in range(12, 19)]
    weekly = [{"date": d, "name": "Storytime", "venue": "Library"} for d in ("2026-10-13", "2026-10-20")]
    assert [(e["name"], e["date"]) for e in town_feeds.collapse_runs(daily + weekly)] == [
        ("Fall Exhibit", "2026-10-12"), ("Storytime", "2026-10-13"), ("Storytime", "2026-10-20")]


def test_library_feed_goes_through_the_library_cap():
    ev = {"name": "Storytime", "venue": "Lee County Library", "url": "https://lib.example/e", "_library": True}
    assert collect_events._is_library_event(ev)
    assert not collect_events._is_library_event({**ev, "_library": False})
    with pytest.raises(ValueError, match="library must be"):
        town_feeds.check_feeds([{"name": "a", "type": "ics", "url": "https://a", "library": "yes"}])


WEEKLY = (
    "BEGIN:VEVENT\nUID:story\nSUMMARY:Storytime\nDTSTART;TZID=America/Chicago:20250107T100000\n"
    "DTEND;TZID=America/Chicago:20250107T103000\nRRULE:FREQ=WEEKLY;BYDAY=TU,TH\n"
    "EXDATE;TZID=America/Chicago:20261015T100000\nEND:VEVENT\n"
    # The Oct 20 instance moved to Oct 21 (listed on its own).
    "BEGIN:VEVENT\nUID:story\nRECURRENCE-ID;TZID=America/Chicago:20261020T100000\nSUMMARY:Storytime\n"
    "DTSTART;TZID=America/Chicago:20261021T110000\nEND:VEVENT\n"
    "BEGIN:VEVENT\nUID:club\nSUMMARY:Teen Club\nDTSTART:20261001T210000Z\nRRULE:FREQ=DAILY;INTERVAL=7;COUNT=3\nEND:VEVENT\n"
)


def test_ics_expands_weekly_and_daily_repeats():
    evs = town_feeds.parse_ics(WEEKLY, CT, START, END)
    assert [(e["name"], e["date"], e["time"]) for e in evs] == [
        ("Storytime", "2026-10-13", "10:00 AM – 10:30 AM"),   # Oct 15 is an EXDATE, Oct 20 moved
        ("Storytime", "2026-10-22", "10:00 AM – 10:30 AM"),
        ("Storytime", "2026-10-21", "11:00 AM"),
        ("Teen Club", "2026-10-15", "4:00 PM"),               # Oct 1, 8, 15; COUNT=3 ends it
    ]


def test_exclude_and_place():
    evs = [{"name": "SNAP Available", "venue": "Private Location (sign in to view)"},
           {"name": "Senior Recital", "venue": "Private Location (sign in to view)", "address": "1 Harrison Plaza"},
           {"name": "Teen D&D", "venue": "", "address": ""}]
    kept = town_feeds.excluded(evs, r"snap|^(?!.*recital).*private location")
    assert [e["name"] for e in kept] == ["Senior Recital", "Teen D&D"]
    town_feeds.place(kept, "Public Library", "350 N Wood Ave")
    assert [(e["venue"], e.get("address")) for e in kept] == [("", "1 Harrison Plaza"), ("Public Library", "350 N Wood Ave")]
    with pytest.raises(ValueError, match="regular expression"):
        town_feeds.check_feeds([{"name": "a", "type": "ics", "url": "https://a", "exclude": "("}])
    with pytest.raises(ValueError, match="timeout"):
        town_feeds.check_feeds([{"name": "a", "type": "ics", "url": "https://a", "timeout": 999}])


def test_rename():
    evs = [{"name": "University of Nebraska - Kearney Women's Soccer vs Fort Hays State"},
           {"name": "Tri-City Storm Men's Ice Hockey vs Chicago Steel"}]
    rules = [[r"^University of Nebraska - Kearney ", "UNK "], [r" Men's Ice Hockey", ""]]
    town_feeds.renamed(evs, rules)
    assert [e["name"] for e in evs] == ["UNK Women's Soccer vs Fort Hays State", "Tri-City Storm vs Chicago Steel"]
    assert town_feeds.renamed(evs, None) == evs
    assert town_feeds.check_feeds([{"name": "a", "type": "ics", "url": "https://a", "rename": rules}])
    for bad in ("x", [["("], ["a"]], [["(", "b"]], [[1, "b"]]):
        with pytest.raises(ValueError, match="rename"):
            town_feeds.check_feeds([{"name": "a", "type": "ics", "url": "https://a", "rename": bad}])


def test_growthzone_reads_each_events_calendar_file():
    month = '<a href="https://c.example/events/details/fall-fest-1?calendarMonth=2026-10-01">x</a>' * 2
    ics = "BEGIN:VEVENT\nSUMMARY:Fall Fest\nDTSTART:20261017T140000Z\nLOCATION:Mobile Plaza\\, 18 Mobile St\nEND:VEVENT\n"
    calls = []

    def get(u):
        calls.append(u)
        return _Resp(month if "/calendar/" in u else ics)

    evs = town_feeds.fetch_feed({"name": "c", "type": "growthzone", "url": "https://c.example"}, get, CT, START, END)
    assert [(e["name"], e["date"], e["time"], e["venue"]) for e in evs] == [("Fall Fest", "2026-10-17", "9:00 AM", "Mobile Plaza")]
    assert calls == ["https://c.example/events/calendar/2026-10-01", "https://c.example/events/addtocalendar/fall-fest-1?format=ICal"]


def test_page_builder_shortcodes_are_stripped():
    assert town_feeds.clean("[et_pb_section][et_pb_text]Patchwork quilts[/et_pb_text][/et_pb_section]") == "Patchwork quilts"
