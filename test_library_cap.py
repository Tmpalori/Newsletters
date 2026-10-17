"""Tests for cap_library_events, the fuzzy merge_events dedupe, and _parse_ai_json_array.

These tests don't hit the network — they construct synthetic event lists and
verify the deterministic logic.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import collect_events as ce


def _lib(date, name, url="https://victoriapl.librarycalendar.com/event/x", **extra):
    base = {
        "date": date,
        "name": name,
        "time": "",
        "venue": "Victoria Public Library",
        "address": "302 N. Main St.",
        "description": "x",
        "icons": [],
        "free": True,
        "url": url,
    }
    base.update(extra)
    return base


def _other(date, name, venue="Aero Crafters"):
    return {
        "date": date, "name": name, "time": "", "venue": venue, "address": "",
        "description": "", "icons": [], "free": True, "url": "https://aerocrafters.pub",
    }


class TestParseAiJsonArray(unittest.TestCase):
    def test_clean_array(self):
        out = ce._parse_ai_json_array('[{"date":"2026-05-01","name":"X"}]')
        self.assertEqual(out, [{"date": "2026-05-01", "name": "X"}])

    def test_prose_wrapped(self):
        out = ce._parse_ai_json_array('Here are the events: [{"date":"2026-05-01","name":"X"}] cheers!')
        self.assertEqual(out, [{"date": "2026-05-01", "name": "X"}])

    def test_citation_prefix_picks_largest_array(self):
        # Models sometimes prepend "[1]" — should not be treated as the result
        out = ce._parse_ai_json_array('[1] These events: [{"date":"2026-05-01","name":"Y"},{"date":"2026-05-02","name":"Z"}]')
        self.assertEqual(len(out), 2)

    def test_dict_with_events_key(self):
        out = ce._parse_ai_json_array('{"events":[{"date":"2026-05-01","name":"X"}]}')
        self.assertEqual(out, [{"date": "2026-05-01", "name": "X"}])

    def test_garbage_returns_none(self):
        self.assertIsNone(ce._parse_ai_json_array("No events found."))

    def test_empty_string(self):
        self.assertIsNone(ce._parse_ai_json_array(""))

    def test_empty_array_is_valid(self):
        self.assertEqual(ce._parse_ai_json_array("[]"), [])


class TestLibraryCap(unittest.TestCase):
    def test_per_day_cap(self):
        # 5 adult library events on the same date — only 2 should survive
        events = [_lib("2026-05-05", f"Lecture {i}", url=f"https://victoriapl.librarycalendar.com/event/{i}") for i in range(5)]
        out = ce.cap_library_events(events)
        self.assertEqual(len(out), 2)

    def test_per_week_cap(self):
        # 12 adult library events spread across 1 week (Mon–Sun) — cap is 8
        # Use 2 different events per day Mon..Sun + extras to push over
        events = []
        for day in range(7):
            date = (ce.datetime.strptime("2026-05-04", "%Y-%m-%d") + ce.timedelta(days=day)).strftime("%Y-%m-%d")
            for i in range(2):
                events.append(_lib(date, f"Adult Event {day}-{i}",
                                    url=f"https://victoriapl.librarycalendar.com/event/{day}{i}"))
        # 14 events, 2/day, week cap = 8 → keep 8, drop 6
        out = ce.cap_library_events(events)
        self.assertEqual(len(out), 8)

    def test_kid_programs_collapse_to_one_per_week(self):
        # 4 Toddler Story Times across 4 weeks, alone (no competition)
        events = [
            _lib("2026-04-23", "Toddler Story Time", url="https://victoriapl.librarycalendar.com/event/a"),
            _lib("2026-04-30", "Toddler Story Time", url="https://victoriapl.librarycalendar.com/event/b"),
            _lib("2026-05-07", "Toddler Story Time", url="https://victoriapl.librarycalendar.com/event/c"),
            _lib("2026-05-14", "Toddler Story Time", url="https://victoriapl.librarycalendar.com/event/d"),
        ]
        out = ce.cap_library_events(events)
        # Each is in a different week → all 4 kept
        self.assertEqual(len(out), 4)

    def test_duplicate_kid_programs_within_same_week_collapse(self):
        # 3 Toddler Story Times in the same week (somehow scraper duplicated)
        events = [
            _lib("2026-04-21", "Toddler Story Time", url="https://victoriapl.librarycalendar.com/event/a"),
            _lib("2026-04-22", "Toddler Story Time", url="https://victoriapl.librarycalendar.com/event/b"),
            _lib("2026-04-23", "Toddler Story Time", url="https://victoriapl.librarycalendar.com/event/c"),
        ]
        out = ce.cap_library_events(events)
        # Same week (Mon Apr 20 anchor) → only 1 kept
        self.assertEqual(len(out), 1)

    def test_non_library_events_pass_through_untouched(self):
        events = [
            _other("2026-05-05", "Trivia at Aero"),
            _other("2026-05-05", "Live Music"),
            _lib("2026-05-05", "Library Lecture"),
        ]
        out = ce.cap_library_events(events)
        self.assertEqual(len(out), 3)
        non_lib = [e for e in out if "library" not in e["venue"].lower()]
        self.assertEqual(len(non_lib), 2)

    def test_adult_programs_preferred_over_kid_in_tight_day(self):
        # Day has 1 adult + 2 kid programs, cap = 2/day. Adult should win.
        events = [
            _lib("2026-05-05", "True Crime Book Club"),
            _lib("2026-05-05", "Toddler Story Time", url="https://victoriapl.librarycalendar.com/event/a"),
            _lib("2026-05-05", "Baby Hour: Pages to Play", url="https://victoriapl.librarycalendar.com/event/b"),
        ]
        out = ce.cap_library_events(events)
        names = [e["name"] for e in out]
        self.assertIn("True Crime Book Club", names)
        self.assertEqual(len(out), 2)

    def test_empty_input(self):
        self.assertEqual(ce.cap_library_events([]), [])

    def test_no_library_events(self):
        events = [_other("2026-05-05", "Trivia")]
        self.assertEqual(ce.cap_library_events(events), events)


class TestMergeFuzzyDedupe(unittest.TestCase):
    def setUp(self):
        ce._WINDOW_START = ce.datetime.strptime("2026-04-20", "%Y-%m-%d").date()
        ce._WINDOW_END = ce.datetime.strptime("2026-05-15", "%Y-%m-%d").date()

    def test_collapses_suffix_variants(self):
        # Real-world case from production: same event with different name lengths
        events = [
            {"date": "2026-05-04", "name": "Baddie Basics: Hair Styling Guide with Angie Knix",
             "time": "5:30 PM", "venue": "Library", "address": "", "description": "a",
             "icons": [], "free": True, "url": ""},
            {"date": "2026-05-04", "name": "Baddie Basics: Hair Styling Guide with Angie Knix, Hair Artist",
             "time": "5:30 PM – 7:00 PM", "venue": "Library", "address": "302 N Main",
             "description": "more complete", "icons": [], "free": True, "url": ""},
        ]
        out = ce.merge_events(events)
        self.assertEqual(len(out), 1)
        # Should keep the shorter, cleaner name
        self.assertEqual(out[0]["name"], "Baddie Basics: Hair Styling Guide with Angie Knix")
        # But the more complete fields (address, description)
        self.assertEqual(out[0]["address"], "302 N Main")

    def test_keeps_distinct_events_distinct(self):
        events = [
            {"date": "2026-05-04", "name": "Trivia Night", "time": "7 PM",
             "venue": "Aero", "address": "", "description": "", "icons": [],
             "free": True, "url": ""},
            {"date": "2026-05-04", "name": "Live Music", "time": "9 PM",
             "venue": "Aero", "address": "", "description": "", "icons": [],
             "free": False, "url": ""},
        ]
        out = ce.merge_events(events)
        self.assertEqual(len(out), 2)


    def test_a_town_library_feed_is_still_capped_after_the_merge(self):
        # Oct 2026: merge_events dropped the feed's _library flag, so only
        # Victoria's library (matched by URL and venue) was capped and Virginia
        # Beach's library feed put ~10 programs a day on the site.
        names = ["Baby Paint", "Teen Anime Chat", "Lego Builders", "Zine Making", "Mahjong", "Film Club"]
        events = [{"date": "2026-05-04", "name": n, "time": f"{i}:00 AM",
                   "venue": "Bayside Area Library", "address": "", "description": "a", "icons": [],
                   "free": True, "url": f"https://vbpl.librarymarket.com/event/{i}", "_library": True}
                  for i, n in enumerate(names, 1)]
        events.append({"date": "2026-05-04", "name": "Baby Paint", "time": "1:00 AM", "venue": "Bayside Area Library",
                       "address": "", "description": "a", "icons": [], "free": True, "url": "", "_source": "allevents"})
        out = ce.cap_library_events(ce.merge_events(events))
        self.assertEqual(len(out), 2)
        self.assertFalse(any("_library" in e for e in out))   # never reaches candidates.json


if __name__ == "__main__":
    unittest.main()
