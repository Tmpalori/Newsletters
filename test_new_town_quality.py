"""Junk and duplicate fixes from the 2026-10-17 audit of the four new towns.

Names, venues and times are the listings that were live on thetide757.com,
shoalssetlist.com, therogue541.com and thestar402.com that week.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))
import collect_events as ce


def ev(name, date="2026-10-24", venue="", address="", time="", **kw):
    return {"date": date, "name": name, "venue": venue, "address": address, "time": time,
            "description": kw.pop("description", ""), "url": "", "icons": [], "free": False, **kw}


@pytest.mark.parametrize("name", [
    "Male Strippers UNLEASHED Male Revue Virginia Beach, VA 8-10 PM",
    "Ebony Men Black Male Revue Strip Clubs & Black Male Strippers Virginia Beach, VA",
    "Office Depot 40-Year Anniversary Customer Appreciation Event",
    "FirstBank Customer Appreciation Day",
    "OPEN HOUSE: 1733 Ingleside Ave Florence, Alabama",
    "Guided Hike (for Faculty & Staff)",
    "Optional Choir-Only Rehearsal",
    "PMP Certification In-Person Training in Lincoln, NE",
])
def test_not_public(name):
    assert ce.non_event_reason(ev(name)) == "promo or not public"


@pytest.mark.parametrize("name", [
    "Open House at the Student Observatory Fall 2026",
    "Open Dress Rehearsal: The Nutcracker",
    "Great Neck Library 50th Anniversary Celebration",
    "Member Mondays",
    "Haunted History of the Shoals Ghost Walk",
])
def test_still_events(name):
    assert ce.non_event_reason(ev(name)) is None


def test_same_long_name_at_the_course_and_the_organizer():
    a = ev("Jack Karnes Memorial Golf Tournament", venue="Cypress Lakes")
    b = ev("Jack Karnes Memorial Golf Tournament", venue="North Alabama Athletics (UNA Lions)")
    assert ce.is_same_event(a, b)
    # Two street addresses that disagree are two events.
    assert not ce.is_same_event(dict(a, address="1311 Cypress Lakes Dr"), dict(b, address="500 Pine St"))
    # Library branches run one program at several branches the same day.
    assert not ce.is_same_event(dict(a, _library=True), b)


def test_same_address_and_name():
    a = ev("Alabama Renaissance Faire (Florence, AL) Free Admission & Parking",
           address="217 E Tuscaloosa St", time="10:00 AM")
    b = ev("40th Alabama Renaissance Faire", venue="Wilson Park", address="217 E Tuscaloosa St, Florence",
           time="All day")
    assert ce.is_same_event(a, b)


def test_a_doubleheader_and_two_events_at_one_farm_stay_apart():
    arena = "400 Pinnacle Arena Dr"
    assert not ce.is_same_event(
        ev("Husker Women's Basketball vs. San Jose State", venue="Pinnacle Bank Arena", address=arena),
        ev("Husker Men's Basketball vs. Le Moyne", venue="Pinnacle Bank Arena", address=arena))
    farm = "3639 Jacksonville Hwy, Medford"
    assert not ce.is_same_event(
        ev("Pheasant Fields Farm Harvest Festival", venue="Pheasant Fields Farm", address=farm),
        ev("Fright After Dark at Pheasant Fields Farm", venue="Pheasant Fields Farm", address=farm))


def test_headliner_short_form_at_the_same_start():
    a = ev("Shoals After Dark w/ Them Dirty Roses, Lightwatch and Bluewire",
           venue="Mobile Plaza, Downtown Florence", address="118 E Mobile St", time="8:00 PM")
    b = ev("Shoals After Dark ft. Lightwatch", address="Mobile Street Plaza, Florence, Alabama, 35630",
           time="8:00 PM – 9:00 PM")
    assert ce.is_same_event(a, b)
    assert not ce.is_same_event(a, dict(b, time="6:00 PM"))


def test_venue_spacing():
    assert ce.is_same_event(ev("Howl-O-Ween Party!", venue="RogueX", time="5:00 PM"),
                            ev("Howl-O-Ween Party", venue="Rogue X", time="5:00 PM"))


def test_a_stand_in_live_music_listing_takes_the_acts_name():
    stand_in = ev("Live Music at Aero Crafters", venue="Aero Crafters", time="7:00 PM – 10:00 PM",
                  description="Live music every Friday.", _source="local_events", curated=True)
    act = ev("GLITCH", venue="Aero Crafters", time="8 PM", icons=["music"], _source="apify_facebook_posts")
    assert ce.is_same_event(stand_in, act)
    merged = ce._merge_pair(stand_in, act)
    assert merged["name"] == "GLITCH" and merged["time"] == "8 PM" and merged["curated"]
    # Swampers' 5 PM happy-hour act isn't its 8 PM headliner.
    swampers = dict(stand_in, name="Live Music at Swampers", venue="Swampers Bar & Grille", time="8:00 PM – 11:00 PM")
    early = dict(act, name="Malcolm Singleton", venue="Swampers Bar & Grille", time="5:00 PM - 7:00 PM")
    assert not ce.is_same_event(swampers, early)
    # Karaoke isn't an act, and another place sharing a word isn't the venue.
    assert not ce.is_same_event(stand_in, dict(act, name="Karaoke Night"))
    assert not ce.is_same_event(dict(stand_in, name="Live Music at Champy's", venue="Champy's Shoals"),
                                dict(act, name="Broadway Bound", venue="Shoals Community Theatre", icons=["music"]))


def test_a_market_organizers_post_matches_the_market_it_runs():
    ce._NON_PLACE_NAMES.add("rogue valley growers & crafters market")
    try:
        yaml_copy = ev("Ashland Tuesday Growers & Crafters Market", date="2026-10-20", venue="ScienceWorks parking lot",
                       address="1500 E Main St, Ashland", time="8:30 AM – 1:30 PM", _source="local_events")
        post = ev("Tuesday Ashland Market", date="2026-10-20", venue="Rogue Valley Growers & Crafters Market",
                  time="8:30 AM-1:30 PM", _source="apify_facebook_posts")
        assert ce.is_same_event(yaml_copy, post)
        assert ce._merge_pair(yaml_copy, post)["venue"] == "ScienceWorks parking lot"
    finally:
        ce._NON_PLACE_NAMES.discard("rogue valley growers & crafters market")
