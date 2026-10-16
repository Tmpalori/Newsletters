"""Tests for scripts/sweep_events.py, the post-publish event check."""
import json
import os
import sys
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "scripts"))
import sweep_events as sw  # noqa: E402


def ev(name, date="2026-10-06", time="", venue="", description="", page=None, **extra):
    return {"name": name, "date": date, "time": time, "venue": venue, "description": description,
            "address": "", "page": page or f"/events/{date}-x", **extra}


def kinds(findings):
    return [(i, k) for i, k, _ in findings]


def test_rules_catch_wrong_weekday_odd_time_church_and_duplicates():
    events = [
        ev("Monday Night Bingo", date="2026-10-06", time="6:00 PM"),        # Oct 6 is a Tuesday
        ev("Taco Tuesday", date="2026-10-06", time="5:00 PM"),             # right day
        ev("Monday–Friday Camp", date="2026-10-06"),                       # several weekdays: skip
        ev("Late Show", date="2026-10-06", time="3:00 AM"),
        ev("St. Mary's Parish Fall Festival", date="2026-10-06", venue="St. Mary's Church"),
        ev("Trivia Night", date="2026-10-06", time="7:00 PM", venue="Weber Brewing"),
        ev("Trivia Night!", date="2026-10-06", time="7:00 PM", venue="Weber Brewing"),
        ev("Trivia Night", date="2026-10-06", time="7:00 PM", venue="Aero Crafters"),  # other bar: fine
    ]
    got = kinds(sw.rule_findings(events))
    assert (0, "wrong_date") in got
    assert (3, "odd_time") in got
    assert (4, "religious") in got
    assert (6, "duplicate") in got
    assert not any(i in (1, 2, 5, 7) for i, _ in got)


def test_ai_findings_parse_and_name_the_duplicate():
    events = [ev("Bookish Society Book Club", venue="Vida Cafe", time="6:00 PM"),
              ev("Bookish Society Book Club", venue="Victoria Public Library", time="6:00PM")]
    answer = ('Here you go: [{"i": 1, "kind": "duplicate", "why": "same club, same time", "dup_of": 0},'
              ' {"i": 9, "kind": "other", "why": "bad index"}, {"i": 0, "kind": "made_up", "why": "x"}]')
    with patch.object(sw.ce, "_openai_chat", return_value=answer) as chat:
        out = sw.ai_findings(events, "sk-test")
    assert out == [(1, "duplicate", "same as “Bookish Society Book Club” at Vida Cafe (same club, same time)")]
    sent = chat.call_args[0][1][1]["content"]
    assert "0 | 2026-10-06 (tue) | 6:00 PM | Bookish Society Book Club | Vida Cafe" in sent


def test_ai_failure_falls_back_to_rules():
    with patch.object(sw.ce, "_openai_chat", side_effect=RuntimeError("timeout")):
        assert sw.ai_findings([ev("X")], "sk-test") is None
    head, lines = sw.report([ev("X")], [], ai_ran=False, days=14)
    assert "nothing looks off" in head and "AI check didn't run" in head and lines == []


def test_report_lists_each_problem_once_with_links():
    events = [ev("Monday Bingo", date="2026-10-06", venue="Palace Bingo", page="/events/2026-10-06-monday-bingo")]
    found = sw.combine([(0, "wrong_date", "name says Monday")], [(0, "wrong_date", "dup from AI"), (0, "other", "x")])
    assert kinds(found) == [(0, "other"), (0, "wrong_date")]
    head, lines = sw.report(events, found, ai_ran=True, days=14)
    assert head.startswith("🔎 Event check: 1 to look at (1 events in the next 14 days)")
    assert lines[0] == "*To look at:*"
    assert "<https://www.thevic361.com/events/2026-10-06-monday-bingo|Monday Bingo>" in lines[2]
    assert "Tue Oct 6" in lines[2] and "*wrong day?*" in lines[2]


def test_window_is_today_through_n_days():
    import datetime
    events = [ev("Past", date="2026-10-03"), ev("Today", date="2026-10-04"),
              ev("Last day", date="2026-10-17"), ev("Too far", date="2026-10-18")]
    got = sw.upcoming(events, datetime.date(2026, 10, 4), 14)
    assert [e["name"] for e in got] == ["Today", "Last day"]


def test_a_lone_cut_off_name_is_flagged_not_hidden():
    events = [ev("Scenic Root — Plant a", venue="Moonshine Drinkery", page="/events/a")]
    found = sw.rule_findings(events)
    assert [(i, k) for i, k, _ in found] == [(0, "cut_off")]
    assert "cut off" in found[0][2]
    assert sw.to_hide(events, found)[0] == []   # could be the only listing: reported only


def test_cut_off_names_beside_the_whole_listing_are_hidden():
    # Live 2026-10-08 at Moonshine Drinkery: two cut-off post names next to
    # the AllEvents listing of the same night.
    events = [ev("Once Upon A Plant: Maas Edition", date="2026-10-08", time="06:30 PM", venue="Moonshine Drinkery",
                 page="/events/2026-10-08-once-upon-a-plant-maas-edition"),
              ev("Scenic Root — Once Upon...", date="2026-10-08", venue="Moonshine Drinkery",
                 page="/events/2026-10-08-scenic-root-once-upon"),
              ev("Scenic Root — Plant a", date="2026-10-08", venue="Moonshine Drinkery",
                 page="/events/2026-10-08-scenic-root-plant-a"),
              ev("Paint and Sip with the", date="2026-10-08", venue="Aero Crafters", page="/events/z")]
    picks, _ = sw.to_hide(events, sw.rule_findings(events))
    assert [(i, k) for i, k, _ in picks] == [(1, "cut_off"), (2, "cut_off")]
    assert "Once Upon A Plant: Maas Edition" in picks[0][2]


def test_a_cut_off_name_beside_an_unrelated_event_at_the_venue_stays():
    # Another event at the bar that night is not the cut-off one's full
    # listing; hiding on that pulls the only copy.
    events = [ev("Live Music with Jake and the", time="8:00 PM", venue="Moonshine Drinkery", page="/events/a"),
              ev("Trivia Night", time="6:00 PM", venue="Moonshine Drinkery", page="/events/b")]
    found = sw.rule_findings(events)
    assert (0, "cut_off") in kinds(found)
    assert sw.to_hide(events, found)[0] == []
    # The real full listing still gets the cut-off copy hidden.
    events.append(ev("Live Music with Jake and the Fatman", time="8:00 PM", venue="Moonshine Drinkery",
                     page="/events/c"))
    picks, _ = sw.to_hide(events, sw.rule_findings(events))
    assert [(i, k) for i, k, _ in picks] == [(0, "cut_off")]


def test_a_vague_venue_is_no_proof_of_the_same_place():
    # "Victoria" is inside "Victoria Public Library" but names no place.
    events = [ev("Story Time with the", venue="Victoria", page="/events/a"),
              ev("Story Time with Ms. Ann", venue="Victoria Public Library", page="/events/b")]
    assert sw.to_hide(events, sw.rule_findings(events))[0] == []
    events = [ev("Story Time with the", venue="Victoria Public Library", page="/events/a"),
              ev("Story Time with Ms. Ann", venue="Downtown Victoria", page="/events/b")]
    assert sw.to_hide(events, sw.rule_findings(events))[0] == []


def test_library_copy_of_a_city_calendar_program_is_hidden():
    # Live 2026-10-06/07: the same program at the library (its default
    # venue) and at its real place from the city calendar.
    lib = ev("Bookish Society Book Club", time="6:00PM – 7:00PM", venue="Victoria Public Library",
             url="https://victoriapl.librarycalendar.com/event/bookish-society-book-club-8996", page="/events/a",
             description="Monthly book club.")
    city = ev("Bookish Society Book Club", time="6:00 PM – 7:00 PM", venue="Vida Cafe",
              url="https://www.victoriatx.gov/Calendar.aspx?EID=3969", page="/events/b")
    for events in ([lib, city], [city, lib]):
        rules = sw.rule_findings(events)
        assert (1, "duplicate") in kinds(rules)
        picks, _ = sw.to_hide(events, rules)
        assert [events[i]["page"] for i, _, _ in picks] == ["/events/a"]
        assert "Vida Cafe" in picks[0][2]
    # Different hours, or no city calendar link: not certain, nothing hidden.
    other = dict(city, time="7:00 PM – 8:00 PM")
    assert sw.to_hide([lib, other], sw.rule_findings([lib, other]))[0] == []
    other = dict(city, url="https://allevents.in/victoria/bookish/1")
    assert sw.to_hide([lib, other], sw.rule_findings([lib, other]))[0] == []


def test_night_events_in_the_morning_are_reported():
    events = [ev("Comedy Night in Victoria w/Crux Crawford", date="2026-10-07", time="10:00 AM",
                 venue="Moonshine Drinkery", page="/events/a"),
              ev("Farmers Market", time="8:00 AM", venue="Market Square", page="/events/b")]
    rules = sw.rule_findings(events)
    assert kinds(rules) == [(0, "odd_time")]
    assert sw.to_hide(events, rules)[0] == []


def test_description_only_religious_words_are_reported_not_hidden():
    events = [ev("Community Night", description="An evening of praise and worship.", page="/events/a"),
              ev("Live Music", description="Come hear Hope Revival play country hits", page="/events/b")]
    rules = sw.rule_findings(events)
    assert kinds(rules) == [(0, "other")]
    assert sw.to_hide(events, rules)[0] == []


class FakeResp:
    def __init__(self, data):
        self.data = data

    def raise_for_status(self):
        pass

    def json(self):
        return self.data


def test_only_certain_rule_findings_get_hidden():
    events = [ev("Monday Night Bingo", page="/events/a"), ev("St. Mary's Parish Fall Festival", page="/events/b"),
              ev("Late Show", time="3:00 AM", page="/events/c")]
    picks, _ = sw.to_hide(events, sw.rule_findings(events))
    assert [(i, k) for i, k, _ in picks] == [(1, "religious")]   # wrong day and odd time stay flags


def test_duplicates_hidden_only_when_exact_unfeatured_and_the_poorer_copy_goes():
    rich = dict(url="https://x.example", description="All the details.")
    # Exact twins: the copy with less detail is hidden, wherever it sits.
    events = [ev("Trivia Night", venue="Weber Brewing", time="7:00 PM", page="/events/a"),
              ev("Trivia Night!", venue="Weber Brewing", time="7 PM", page="/events/b", **rich)]
    picks, resolved = sw.to_hide(events, sw.rule_findings(events))
    assert [(i, k) for i, k, _ in picks] == [(0, "duplicate")]
    assert resolved == {1: 0}
    # Fuzzy matches (name contains the other) are reported, not hidden.
    events = [ev("Fall Festival", venue="DeLeon Plaza", time="10:00 AM", page="/events/a"),
              ev("Victoria Fall Festival", venue="DeLeon Plaza", time="10:00 AM", page="/events/b")]
    rules = sw.rule_findings(events)
    assert any(k == "duplicate" for _, k, _ in rules)
    assert sw.to_hide(events, rules)[0] == []
    # A featured (paid) listing is never auto-hidden, nor is its twin.
    events = [ev("Trivia Night", venue="Weber Brewing", time="7:00 PM", page="/events/a", featured=True),
              ev("Trivia Night", venue="Weber Brewing", time="7:00 PM", page="/events/b")]
    assert sw.to_hide(events, sw.rule_findings(events))[0] == []


class FakeResp:
    def __init__(self, data, status=200):
        self.data, self.status_code = data, status
        self.ok = status < 400
        self.headers = {"content-type": "application/json"}

    def json(self):
        return self.data


def test_hide_posts_pages_and_reads_back_what_happened():
    events = [ev("A", page="/events/a"), ev("B", page="/events/b"), ev("C", page="/events/c")]
    picks = [(0, "religious", "church event"), (1, "duplicate", "same as X"), (2, "not_an_event", "job post")]
    answer = {"ok": True, "hidden": [{"page": "/events/a"}],
              "skipped": [{"page": "/events/b", "why": "restored-by-admin"}, {"page": "/events/c", "why": "not-live"}]}
    with patch.object(sw.requests, "post", return_value=FakeResp(answer)) as post:
        hidden, restored, problem = sw.hide(events, picks, "s3cret")
    assert hidden == {0} and restored == {1} and problem is None
    kw = post.call_args.kwargs
    assert kw["headers"]["X-Cron-Secret"] == "s3cret"
    assert kw["json"]["hide"][0] == {"page": "/events/a", "reason": "religious / church event: church event"}


def test_hide_failures_are_reported_not_swallowed():
    events = [ev("A", page="/events/a")]
    picks = [(0, "religious", "church event")]
    with patch.object(sw.requests, "post", return_value=FakeResp({"ok": False, "error": "unauthorized"}, 401)):
        assert "rejected the secret" in sw.hide(events, picks, "wrong")[2]
    with patch.object(sw.requests, "post", return_value=FakeResp({"ok": False, "error": "too-many", "message": "Refusing to hide 11"}, 400)):
        assert "Refusing to hide 11" in sw.hide(events, picks, "s3cret")[2]
    with patch.object(sw.requests, "post", side_effect=OSError("timeout")):
        assert "timeout" in sw.hide(events, picks, "s3cret")[2]
    with patch.object(sw.requests, "post") as post:
        assert sw.hide(events, picks, "") == (set(), set(), None)   # report-only setup
    post.assert_not_called()
    head, _ = sw.report(events, [(0, "religious", "church event")], ai_ran=True, days=14,
                        problem="auto-hide failed: HTTP 500")
    assert "⚠️ auto-hide failed: HTTP 500" in head


def test_report_splits_hidden_from_flags():
    events = [ev("Church Fish Fry", venue="St. Mary's", page="/events/a"), ev("Monday Bingo", page="/events/b")]
    found = [(0, "religious", "church event"), (1, "wrong_date", "name says Monday")]
    head, lines = sw.report(events, found, ai_ran=True, days=14, hidden={0})
    assert head.startswith("🔎 Event check: hid 1, 1 to look at")
    assert lines[0].startswith("*Hidden automatically*")
    assert "Church Fish Fry" in lines[1]
    assert lines[2] == "*To look at:*" and "Monday Bingo" in lines[3]


def test_ai_reasons_name_events_instead_of_index_numbers():
    events = [ev("Victoria Texas Historic Mystery"), ev("Spooky Season: Victoria Historic Ghost Mystery")]
    answer = '[{"i": 0, "kind": "other", "why": "Same ghost tour as index 1, same plaza; not index 7"}]'
    with patch.object(sw.ce, "_openai_chat", return_value=answer) as chat:
        out = sw.ai_findings(events, "sk-test")
    assert out == [(0, "other", "Same ghost tour as “Spooky Season: Victoria Historic Ghost Mystery”, same plaza; not another listing")]
    assert "never by their index number" in chat.call_args[0][1][0]["content"]



def test_ai_reasons_name_hash_and_event_references_but_leave_names_alone():
    events = [ev("Trivia"), ev("Karaoke"), ev("Line Dancing")]
    assert sw._named("same as #1", events) == "same as “Karaoke”"
    assert sw._named("duplicate of event 2 (see #0)", events) == "duplicate of “Line Dancing” (see “Trivia”)"
    assert sw._named("same as line 1", events) == "same as “Karaoke”"
    assert sw._named("Line 2 Dance Night at the hall", events) == "Line 2 Dance Night at the hall"
    assert sw._named("#1 Fan Day is not an event", events) == "#1 Fan Day is not an event"


def test_curated_events_are_not_auto_hidden_or_flagged_for_what_a_person_checked():
    events = [
        {"date": "2026-10-24", "name": "Kingdom Church Fall Fest & Trunk or Treat", "venue": "Kingdom Church",
         "time": "6:00 PM", "curated": True},
        {"date": "2026-10-19", "name": "Movie Night: Friday the 13th", "venue": "Moonshine Drinkery",
         "time": "7:00 PM", "curated": True},
        {"date": "2026-10-24", "name": "Goliad Scare on the Square", "venue": "Goliad Courthouse Square",
         "time": "6:00 PM", "town": "Goliad", "curated": True},
    ]
    found = sw.trusted(events, sw.rule_findings(events))
    assert found == []
    # Without the mark, the same church event is still caught.
    plain = [dict(events[0], curated=False)]
    assert any(k == "religious" for _, k, _ in sw.trusted(plain, sw.rule_findings(plain)))


def test_an_editors_pick_does_not_shield_its_duplicate():
    twin = {"date": "2026-10-10", "name": "Harvest Festival", "venue": "DeLeon Plaza", "time": "5:00 PM", "page": "/events/x"}
    events = [dict(twin, featured=True, editor_pick=True, url="https://x"), dict(twin)]
    picks, _ = sw.to_hide(events, sw.rule_findings(events))
    assert [p[1] for p in picks] == ["duplicate"]
    paid = [dict(twin, featured=True), dict(twin)]
    assert sw.to_hide(paid, sw.rule_findings(paid))[0] == []


def test_hide_batch_stays_under_the_server_limit_and_day_lists_go_first():
    events = []
    names = ["Pumpkin Patch", "Quilt Show", "Car Rally", "Book Swap", "Jazz Brunch", "Rodeo Night", "Taco Crawl",
             "Kite Day", "Chili Cookoff", "Art Walk", "Salsa Social", "Bike Parade", "Yoga Picnic", "Pottery Sale"]
    for i, name in enumerate(names):
        twin = {"date": "2026-10-10", "name": name, "venue": f"{name} Grounds", "time": f"{i % 9 + 1}:00 PM", "page": f"/events/{i}"}
        events += [dict(twin, url="https://x", overflow=i < 7), dict(twin, overflow=i < 7)]
    picks, _ = sw.to_hide(events, sw.rule_findings(events))
    assert len(picks) > sw.MAX_PER_RUN
    capped = sw.cap_picks(events, picks)
    assert len(capped) == sw.MAX_PER_RUN
    shown_first = [bool(events[i].get("overflow")) for i, _, _ in capped]
    assert shown_first == sorted(shown_first) and shown_first.count(False) == 7


def _cands(tmp_path, events, made="2026-10-04T20:27:09-05:00"):
    p = tmp_path / "candidates.json"
    p.write_text(json.dumps({"last_updated": made, "events": [
        {"date": d, "name": n, "venue": "Hall", "_source": "x"} for d, n in events]}))
    return str(p)


def test_wait_ignores_a_publish_that_did_not_bring_the_new_candidates(tmp_path):
    # A submissions-only auto-publish (or an admin publish) in the deploy
    # window bumps last_updated without the new candidates: keep waiting.
    old = [{"date": "2026-10-10", "name": "Bingo", "venue": "Hall"}]
    new = old + [{"date": "2026-10-10", "name": n, "venue": "Hall"} for n in ("Rodeo", "Fair", "Gala")]
    answers = iter([
        {"last_updated": "2026-10-05T01:00:00Z", "events": old},     # before the deploy
        {"last_updated": "2026-10-05T01:30:00Z", "events": old},     # submission approved: newer, same list
        {"last_updated": "2026-10-05T01:40:00Z", "events": new},     # boot auto-publish
    ])
    sleeps = []
    # Swap was rejected in admin (never published); Past is already over.
    path = _cands(tmp_path, [("2026-10-10", n) for n in ("Bingo", "Rodeo", "Fair", "Gala", "Swap")] +
                  [("2026-10-01", "Past")])
    assert sw.wait_for_publish(path, lambda: next(answers), sleep=sleeps.append, today="2026-10-06") is True
    assert len(sleeps) == 2


def test_wait_times_out_with_a_warning(tmp_path, capsys):
    stale = {"last_updated": "2026-10-05T03:00:00Z", "events": []}
    path = _cands(tmp_path, [("2026-10-10", "Rodeo"), ("2026-10-10", "Fair")])
    assert sw.wait_for_publish(path, lambda: stale, sleep=lambda s: None, tries=3, today="2026-10-06") is False
    assert "::warning::" in capsys.readouterr().out


def test_wait_with_nothing_new_only_needs_the_newer_list(tmp_path):
    live = {"last_updated": "2026-10-05T03:00:00Z", "events": [{"date": "2026-10-10", "name": "Bingo", "venue": "Hall"}]}
    path = _cands(tmp_path, [("2026-10-10", "Bingo")])
    assert sw.wait_for_publish(path, lambda: live, sleep=lambda s: None, tries=1, today="2026-10-06") is True
    older = dict(live, last_updated="2026-10-04T00:00:00Z")
    assert sw.wait_for_publish(path, lambda: older, sleep=lambda s: None, tries=1, today="2026-10-06") is False


def test_wait_timeout_alerts_slack(tmp_path):
    # Candidates that never go live (Railway didn't deploy) must reach
    # Slack, not only a ::warning:: in a green run.
    path = _cands(tmp_path, [("2026-10-10", "Rodeo")])
    with patch.object(sw, "wait_for_publish", return_value=False), \
            patch.object(sw.slack_notify, "main") as notify:
        assert sw.main(["--wait-for", path]) == 0
    assert notify.call_count == 1
    assert "didn't go live" in notify.call_args[0][0][0]


def test_wait_success_sends_no_alert(tmp_path):
    path = _cands(tmp_path, [("2026-10-10", "Rodeo")])
    with patch.object(sw, "wait_for_publish", return_value=True), \
            patch.object(sw.slack_notify, "main") as notify:
        assert sw.main(["--wait-for", path]) == 0
    notify.assert_not_called()


def test_slack_text_escapes_names_venues_and_reasons():
    events = [ev("Fall Fest <Kids> & | Teens", venue="Bar <!channel>", page="/events/2026-10-06-fall-fest")]
    head, lines = sw.report(events, [(0, "other", "AI says <!here> & more")], ai_ran=True, days=14)
    line = lines[1]
    assert "<!channel>" not in line and "<!here>" not in line and "<Kids>" not in line
    # A "|" would end the link's URL part early, so the link text swaps it.
    assert "|Fall Fest &lt;Kids&gt; &amp; ¦ Teens>" in line
    assert "(Bar &lt;!channel&gt;)" in line and "AI says &lt;!here&gt; &amp; more" in line
    # The link markup itself stays intact.
    assert line.count("<https://www.thevic361.com/events/2026-10-06-fall-fest|") == 1


def test_paid_picks_are_never_auto_hidden_whatever_the_rule():
    # A sold Vic's Pick the owner approved: a rule match is a sales call,
    # not a removal (religious / not_an_event used to slip through).
    paid = dict(featured=True)
    events = [ev("Gospel Brunch", page="/events/a", **paid),
              ev("Grand Opening Giveaway", page="/events/b", **paid),
              ev("St. Mary's Parish Fall Festival", page="/events/c", **paid),
              ev("St. Joseph Parish Fall Festival", page="/events/d")]
    rules = sw.rule_findings(events)
    assert any(i in (0, 1, 2) and k in sw.AUTO_HIDE for i, k, _ in rules)
    picks, _ = sw.to_hide(events, rules)
    assert [i for i, _, _ in picks] == [3]
    flagged = sw.paid_findings(events, rules)
    assert {i for i, _, _ in flagged} == {i for i, k, _ in rules if i in (0, 1, 2) and k in sw.AUTO_HIDE}
    # An editor's pick is featured for its score only; it gets no shield.
    events = [ev("St. Mary's Parish Fall Festival", page="/events/c", featured=True, editor_pick=True)]
    assert [i for i, _, _ in sw.to_hide(events, sw.rule_findings(events))[0]] == [0]


def test_paid_picks_flagged_go_to_the_sales_channel(monkeypatch):
    events = [ev("St. Mary's Parish Fall Festival", page="/events/c", featured=True)]
    flagged = sw.paid_findings(events, sw.rule_findings(events))
    monkeypatch.setenv("SLACK_SALES_WEBHOOK_URL", "https://hooks.slack.com/sales")
    monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/activity")
    seen = []
    with patch.object(sw.slack_notify, "main", side_effect=lambda a: seen.append((os.environ["SLACK_WEBHOOK_URL"], a[0]))):
        sw.notify_sales(events, flagged)
    assert seen and seen[0][0] == "https://hooks.slack.com/sales" and "paid Vic's Pick" in seen[0][1]
    assert os.environ["SLACK_WEBHOOK_URL"] == "https://hooks.slack.com/activity"


def test_an_approved_submission_is_reported_not_auto_hidden():
    # The owner approved it in admin over the same rule ("rules say: ..."),
    # and the submitter was told it's live: report it, don't hide it.
    church = ev("St. Mary's Parish Fall Festival", page="/events/b", submitted=True)
    found = sw.trusted([church], sw.rule_findings([church]))
    assert [k for _, k, _ in found] == ["religious"]          # still in the report
    assert sw.to_hide([church], found)[0] == []               # but never hidden
    assert sw.to_hide([dict(church, submitted=False)], found)[0] != []
    # Nor is it the copy hidden for an exact duplicate.
    twin = {"date": "2026-10-10", "name": "Harvest Festival", "venue": "DeLeon Plaza", "time": "5:00 PM"}
    dups = [dict(twin, page="/events/a", submitted=True), dict(twin, page="/events/b", url="https://x")]
    assert sw.to_hide(dups, sw.rule_findings(dups))[0] == []


def test_wait_ends_once_collected_at_shows_these_candidates_are_live(tmp_path):
    # Auto-publish ran before the first fetch, and some candidates never
    # show live (hidden, rejected or merged): collected_at is the proof.
    made = "2026-10-04T20:27:09-05:00"
    live = {"last_updated": "2026-10-05T01:40:00Z", "collected_at": made,
            "events": [{"date": "2026-10-10", "name": "Bingo", "venue": "Hall"}]}
    path = _cands(tmp_path, [("2026-10-10", n) for n in ("Bingo", "Rodeo", "Fair", "Gala", "Swap")], made=made)
    sleeps = []
    assert sw.wait_for_publish(path, lambda: live, sleep=sleeps.append, tries=30, today="2026-10-06") is True
    assert sleeps == []
    # An older collect still live (no deploy yet) keeps waiting, even when
    # last_updated moved and the keys happen to be there.
    old = dict(live, collected_at="2026-10-03T20:00:00-05:00", events=[
        {"date": "2026-10-10", "name": n, "venue": "Hall"} for n in ("Bingo", "Rodeo", "Fair", "Gala", "Swap")])
    assert sw.wait_for_publish(path, lambda: old, sleep=lambda s: None, tries=2, today="2026-10-06") is False


def test_a_long_check_is_split_across_slack_messages_not_cut():
    # Railway has no run summary: findings past the first 12 used to be lost.
    lines = [f"• finding {n}" for n in range(30)]
    msgs = sw.slack_messages("🔎 Event check: 30 to look at", lines)
    assert len(msgs) == 3
    assert msgs[0].startswith("🔎 Event check: 30 to look at") and "18 more in the next message" in msgs[0]
    assert msgs[2].startswith("Event check, continued (3 of 3)") and "more in the next" not in msgs[2]
    assert all(f"• finding {n}" in "\n".join(msgs) for n in range(30))
    assert "run summary" not in "\n".join(msgs)
    assert sw.slack_messages("🔎 Event check: nothing looks off.", []) == ["🔎 Event check: nothing looks off."]
