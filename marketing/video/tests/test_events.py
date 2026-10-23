"""events.py: reading a town's /next-week page into events, offline.

PAGE is shaped like the sites' own pages: schema.org Event JSON-LD, one
script per event plus an ItemList wrapper repeating them (both appear on the
live pages), dates with the town's offset, and a date-only all-day listing.
"""
import datetime as dt
import json
import os
import sys

import pytest

VIDEO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, VIDEO)

import events as ev  # noqa: E402


def ld(obj):
    return f'<script type="application/ld+json">{json.dumps(obj)}</script>'


STAPLETON = {"@type": "MusicEvent", "name": "Chris Stapleton&#39;s Road Show",
             "startDate": "2026-10-26T19:30:00-05:00",
             "location": {"@type": "Place", "name": "Pinnacle Bank Arena"},
             "offers": {"@type": "Offer", "price": "79"},
             "description": "Chris Stapleton with Ricky Skaggs.",
             "url": "https://www.thestar402.com/events/2026-10-26-stapleton"}
ZOO = {"@type": "Event", "name": "Boo at the Zoo", "startDate": "2026-10-26T17:30:00-05:00",
       "location": [{"@type": "Place", "name": "Lincoln Children's Zoo"}],
       "offers": [{"@type": "Offer", "price": "0"}], "description": "x" * 300,
       "url": "https://www.thestar402.com/events/2026-10-26-boo"}
BINGO = {"@type": "Event", "name": "Palace Bingo — Monday", "startDate": "2026-10-26T17:30:00-05:00"}
GAME = {"@type": ["Event", "SportsEvent"], "name": "Husker Football vs. Washington",
        "startDate": "2026-10-31", "location": {"name": "Memorial Stadium"}}
NOT_AN_EVENT = {"@type": "Organization", "name": "The Star 402"}

PAGE = ("<html><head>" + ld(NOT_AN_EVENT) + ld(STAPLETON) + ld(ZOO) + ld(BINGO) + ld(GAME)
        + ld({"@type": "ItemList", "itemListElement": [{"@type": "ListItem", "item": STAPLETON}]})
        + '<script type="application/ld+json">{not json</script></head></html>')


def test_parses_every_event_once_in_start_order():
    got = ev.parse_events(PAGE)
    assert [e["name"] for e in got] == [
        "Boo at the Zoo", "Palace Bingo — Monday", "Chris Stapleton's Road Show",
        "Husker Football vs. Washington"]
    stapleton = got[2]
    assert stapleton["venue"] == "Pinnacle Bank Arena" and not stapleton["free"]
    assert got[0]["free"] and got[0]["venue"] == "Lincoln Children's Zoo"


def test_times_and_all_day_listings():
    got = {e["name"]: e for e in ev.parse_events(PAGE)}
    assert ev.time_of(got["Chris Stapleton's Road Show"]) == "7:30 PM"
    assert ev.time_of(got["Husker Football vs. Washington"]) == ""
    assert ev.day_of(got["Husker Football vs. Washington"]) == dt.date(2026, 10, 31)


def test_regulars_and_dates_are_filtered():
    got = ev.parse_events(PAGE)
    assert "Palace Bingo — Monday" not in [e["name"] for e in ev.pick(got)]
    assert "Palace Bingo — Monday" in [e["name"] for e in ev.pick(got, keep_regulars=True)]
    weekend = ev.pick(got, start=dt.date(2026, 10, 30), end=dt.date(2026, 11, 1))
    assert [e["name"] for e in weekend] == ["Husker Football vs. Washington"]


def test_markdown_groups_by_day_and_links_each_event():
    got = ev.pick(ev.parse_events(PAGE))
    md = ev.markdown("lincoln", "https://www.thestar402.com/next-week", got, 4)
    assert md.startswith("## The Star 402 (Lincoln): 3 events (1 regulars or out-of-range left out)")
    assert "### Mon Oct 26" in md and "### Sat Oct 31" in md
    assert "- 5:30 PM · Boo at the Zoo · Lincoln Children's Zoo · FREE · " in md
    assert "..." in md  # the 300-character description is cut
    assert "<https://www.thestar402.com/events/2026-10-26-stapleton>" in md


class Resp:
    def __init__(self, status, text=""):
        self.status_code, self.text = status, text


class FakeSites:
    def __init__(self, broken=()):
        self.broken, self.urls = set(broken), []

    def get(self, url, timeout=None, headers=None):
        assert timeout, "every request needs a timeout"
        self.urls.append(url)
        if any(b in url for b in self.broken):
            return Resp(503)
        return Resp(200, PAGE)


def test_main_reads_every_town_and_reports_a_down_site(capsys):
    sites = FakeSites(broken=["therogue541"])
    assert ev.main(["--json"], session=sites) == 1
    out = json.loads(capsys.readouterr().out)
    assert sorted(out) == ["lincoln", "shoals", "victoria", "virginiabeach"]
    assert len(sites.urls) == 5 and all(u.endswith("/next-week") for u in sites.urls)


def test_weekend_reads_this_weekend(capsys):
    sites = FakeSites()
    assert ev.main(["--town", "shoals", "--when", "weekend"], session=sites) == 0
    assert sites.urls == ["https://www.shoalssetlist.com/this-weekend"]
    assert capsys.readouterr().out.startswith("## Shoals Setlist")


@pytest.mark.parametrize("bad", [["--town", "kearney"], ["--from", "Oct 30"]])
def test_bad_arguments_are_refused(bad):
    with pytest.raises(SystemExit):
        ev.main(bad, session=FakeSites())
