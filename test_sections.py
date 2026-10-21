"""scripts/sections.py: the newsletter's extra sections and their editor pass."""
import json
import os
import sys
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "scripts"))

import sections as s  # noqa: E402

TODAY = date(2026, 10, 18)   # a Sunday: the evening build


def test_names_read_like_a_person_wrote_them():
    assert s.business_name("PETCO #2464") == "Petco"
    assert s.business_name("JOJO & COCO, LLC") == "Jojo & Coco"
    assert s.business_name("CHEDDARS SCRATCH KITCHEN #2228") == "Cheddars Scratch Kitchen"
    assert s.business_name("MCDONALD'S") == "McDonald's"
    assert s.business_name("Already Fine Co.") == "Already Fine"
    assert s.street_of("8106 NE ZAC LENTZ PKWY STE 100") == "NE Zac Lentz Pkwy"
    assert s.street_of("1102 S MOODY ST") == "S Moody St"
    assert s.strip_dashes("Fresh bread — every morning") == "Fresh bread, every morning"


def test_the_rules_stop_what_the_editor_might_miss():
    assert s.rule_problems("Chai: Filipino food, permit filed Oct 2.", "place") == ["mentions where it came from"]
    assert s.rule_problems("A hidden gem nestled downtown.", "place") == ["sounds like AI"]
    assert "not good news" in s.rule_problems("Council considers a rezoning on Bonney Rd.", "good")
    assert "not good news" in s.rule_problems("A $5,000 donation to the Sheriff's Office.", "good")
    assert s.rule_problems("Plans to fix up the playground at Riverside Park are on the agenda.", "good") == []
    assert s.rule_problems("Filipino food, now open on NE Zac Lentz Pkwy.", "place") == []


def test_question_matches_the_site():
    cfg = {"questions": ["A", "B", "C"]}
    # server/sections.js questionFor: weeks since 2026-01-05, mod the list.
    assert s.question_for(cfg, date(2026, 1, 5)) == "A"
    assert s.question_for(cfg, date(2026, 1, 12)) == "B"
    assert s.question_for(cfg, date(2026, 10, 5)) == ["A", "B", "C"][39 % 3]
    assert s.question_for({}, date(2026, 10, 5)) is None


PET = {"id": "pp-1", "name": "Chloe", "species": "Dog", "breed": "Pit Bull mix", "sex": "Female", "age": "2 years",
       "photo_url": "https://g.petango.com/photos/1.jpg", "url": "https://x/1", "since": None, "bio": ""}


def _no_network(monkeypatch, pets=(PET,), places=()):
    monkeypatch.setitem(s.PET_READERS, "fake", lambda src: [dict(p) for p in pets])
    monkeypatch.setitem(s.NEW_READERS, "fake", lambda src, today: [dict(x) for x in places])
    monkeypatch.setattr(s, "resize_photo", lambda raw: "UEhPVE8=")

    class R:
        content = b"jpeg"
    monkeypatch.setattr(s, "get", lambda url, **kw: R())


CFG = {"pets": [{"name": "County Shelter", "source": "fake", "address": "1 Main"}],
       "new_in_town": {"source": "fake"}, "questions": ["Best kolache?"]}


def test_without_the_ai_only_the_pet_runs_with_its_plain_line(monkeypatch):
    _no_network(monkeypatch, places=[{"key": "k1", "name": "Chai", "what": "restaurant", "street": "Main St", "status": "open", "raw": "x"}])
    out = s.build(CFG, {}, [], TODAY, api_key="")
    assert out["pet"]["name"] == "Chloe"
    assert out["pet"]["photo"] == "UEhPVE8="
    assert out["pet"]["blurb"] == s.pet_plain_blurb({**PET, "shelter": "County Shelter"})
    assert out["new_in_town"] == [] and out["good_news"] is None and out["roundup"] is None
    assert out["week"] == "2026-10-19"   # Sunday evening builds for tomorrow's issue


def test_a_pet_with_no_real_photo_or_featured_lately_is_skipped(monkeypatch):
    other = dict(PET, id="pp-2", name="Rex")
    nophoto = dict(PET, id="pp-3", name="Blank", photo_url="https://g.petango.com/shared/Photo-Not-Available-dog.gif")
    _no_network(monkeypatch, pets=[nophoto, PET, other])
    prev = {"pet_history": [{"id": "pp-1", "date": "2026-10-01"}]}
    assert s.build(CFG, prev, [], TODAY, api_key="")["pet"]["name"] == "Rex"


def test_the_editor_and_the_rules_decide_what_runs(monkeypatch):
    places = [{"key": "k1", "name": "Chai Filipino Food", "what": "restaurant", "street": "NE Zac Lentz Pkwy", "status": "open", "raw": "a"},
              {"key": "k2", "name": "Vega Lawn", "what": "", "street": "Cherry St", "status": "open", "raw": "b"},
              {"key": "k3", "name": "Bao Bao Bakery", "what": "", "street": "Main St", "status": "soon", "raw": "c"}]
    _no_network(monkeypatch, places=places)
    replies = [{"at": "2026-10-13T15:00:00Z", "name": "Maria", "text": "Sausage and cheese!"},
               {"at": "2026-10-14T15:00:00Z", "name": "Dale", "text": "Fruit ones."}]
    calls = []

    def fake_ai(key, system, user, max_tokens=6000):
        calls.append(system[:40])
        if "editor" in system:
            items = json.loads(user)
            return [{"id": it["id"], "verdict": "drop" if it["id"] == "place:k2" else "keep", "why": "lawn care"} for it in items]
        return {"pet": {"blurb": "Chloe loves long walks — and belly rubs!"},
                "new_places": [{"key": "k1", "name": "Chai Filipino Food", "line": "Filipino food, now open on NE Zac Lentz Pkwy."},
                               {"key": "k2", "name": "Vega Lawn", "line": "Lawn care."},
                               {"key": "k3", "name": "Bao Bao Bakery", "line": "Buns and pastries, permit filed, coming soon."}],
                "good_news": [{"title": "Playground", "line": "New swings for Riverside Park are on the agenda."},
                              {"title": "Rezoning", "line": "A rezoning on Bonney Rd is on the agenda."}],
                "roundup": [{"i": 0, "quote": "Sausage and cheese!", "name": "Maria"}, {"i": 1, "quote": "Fruit ones.", "name": "Dale"}]}
    monkeypatch.setattr(s, "ai_json", fake_ai)
    monkeypatch.setattr(s, "build_agendas", lambda cfg, today: [{"body": "City", "items": ["x"], "url": "https://x/agenda"}])
    wed = date(2026, 10, 14)
    out = s.build({**CFG, "good_news": {"sources": []}}, {}, replies, wed, api_key="k")
    # New questions (none in this fake), the writer, then one editor pass for the pet and one for the rest.
    assert len(calls) == 4
    assert [x["name"] for x in out["new_in_town"]] == ["Chai Filipino Food"]   # k2 the editor, k3 the rules (permit)
    assert out["pet"]["blurb"] == "Chloe loves long walks, and belly rubs!"   # no dashes
    assert [g["title"] for g in out["good_news"]["items"]] == ["Playground"]   # the rezoning never runs
    assert [a["name"] for a in out["roundup"]["answers"]] == ["Maria", "Dale"]
    dropped = {r["id"] for r in out["review"] if r["verdict"] == "drop"}
    assert {"place:k2", "place:k3", "good:1"} <= dropped
    assert out["new_shown"] == {"k1": "2026-10-14"}


def test_an_editor_that_doesnt_answer_publishes_nothing_it_wrote(monkeypatch):
    places = [{"key": "k1", "name": "Chai", "what": "", "street": "", "status": "open", "raw": "a"}]
    _no_network(monkeypatch, places=places)
    monkeypatch.setattr(s, "ai_json", lambda key, system, user, max_tokens=6000:
                        None if "editor" in system else {"pet": None, "new_places": [{"key": "k1", "name": "Chai", "line": "Food."}]})
    out = s.build(CFG, {}, [], TODAY, api_key="k")
    assert out["new_in_town"] == []
    assert out["pet"]["blurb"] == s.pet_plain_blurb({**PET, "shelter": "County Shelter"})


def test_before_send_only_swaps_an_adopted_pet(monkeypatch):
    _no_network(monkeypatch, pets=[dict(PET, id="pp-9", name="Rex")])
    prev = {"week": "2026-10-12", "pet": {"id": "pp-1", "name": "Chloe", "shelter": "County Shelter"},
            "new_in_town": [{"key": "k1", "name": "Chai", "line": "Food.", "status": "open"}], "pet_history": []}
    out = s.build(CFG, prev, [], date(2026, 10, 12), api_key="", before_send=True)
    assert out["pet"]["name"] == "Rex"              # Chloe isn't listed any more
    assert out["new_in_town"] == prev["new_in_town"]
    still = s.build(CFG, {**prev, "pet": {"id": "pp-9", "name": "Rex", "shelter": "County Shelter"}}, [], date(2026, 10, 12), "", True)
    assert still["pet"]["name"] == "Rex"


def test_every_town_with_sections_has_a_complete_file():
    import glob
    root = os.path.dirname(__file__)
    files = [os.path.join(root, "sections.json")] + glob.glob(os.path.join(root, "towns", "*", "sections.json"))
    assert len(files) >= 5
    for f in files:
        cfg = json.load(open(f))
        assert cfg["enabled"] is False, f"{f}: on only after the owner's OK"
        assert all(p["source"] in s.PET_READERS for p in cfg["pets"]), f
        assert cfg["new_in_town"]["source"] in s.NEW_READERS, f
        assert all(g["source"] in s.AGENDA_READERS for g in cfg["good_news"]["sources"]), f
        assert len(cfg["questions"]) >= 8 and len(cfg["polls"]) >= 3, f


def test_tall_and_wide_photos_are_cropped_for_the_email():
    import base64
    import io
    from PIL import Image

    def shape(w, h):
        buf = io.BytesIO()
        Image.new("RGB", (w, h), "white").save(buf, "JPEG")
        return Image.open(io.BytesIO(base64.b64decode(s.resize_photo(buf.getvalue())))).size
    assert shape(900, 1600) == (720, 720)
    assert shape(3000, 1000) == (720, 480)
    assert shape(1200, 900) == (720, 540)
    assert s.resize_photo(b"not an image") is None


ISSUE = {"edition": "weekend", "week": "2026-10-15", "total": 9,
         "top": [{"name": "Zoo Boo", "day": "Saturday", "venue": "The Texas Zoo"},
                 {"name": "Boo-Fest", "day": "Saturday", "venue": "Downtown"}]}


def test_the_opening_paragraph_is_written_checked_and_names_only_the_issues_events(monkeypatch):
    def ai(text, verdict="keep"):
        def fake(key, system, user, max_tokens=6000):
            if "editor" in system:
                return [{"id": "intro", "verdict": verdict, "why": "x"}]
            return {"intro": text}
        return fake
    out = {"roundup": {"answers": [1, 2]}, "good_news": None}
    monkeypatch.setattr(s, "ai_json", ai("Happy Thursday, Victoria. Zoo Boo and Boo-Fest — both Saturday — lead the weekend."))
    review = []
    got = s.write_intro("k", ISSUE, out, CFG, date(2026, 10, 12), review)
    assert got == {"edition": "weekend", "week": "2026-10-15", "mentions": ["Zoo Boo", "Boo-Fest"],
                   "text": "Happy Thursday, Victoria. Zoo Boo and Boo-Fest, both Saturday, lead the weekend."}
    # Names none of the issue's events, sounds like AI, or the editor says no: the site writes a plain one.
    monkeypatch.setattr(s, "ai_json", ai("Something for everyone this weekend in Victoria."))
    assert s.write_intro("k", ISSUE, out, CFG, date(2026, 10, 12), review) is None
    monkeypatch.setattr(s, "ai_json", ai("Zoo Boo is a hidden gem nestled in the park."))
    assert s.write_intro("k", ISSUE, out, CFG, date(2026, 10, 12), review) is None
    monkeypatch.setattr(s, "ai_json", ai("Zoo Boo leads the weekend.", verdict="drop"))
    assert s.write_intro("k", ISSUE, out, CFG, date(2026, 10, 12), review) is None
    assert s.write_intro("", ISSUE, out, CFG, date(2026, 10, 12), review) is None


def test_before_send_writes_the_paragraph_for_this_issue(monkeypatch):
    _no_network(monkeypatch)
    monkeypatch.setattr(s, "write_intro", lambda key, issue, out, config, monday, review: {"text": "Hi", "edition": issue["edition"]})
    prev = {"week": "2026-10-12", "pet": {"id": "pp-1", "name": "Chloe", "shelter": "County Shelter"}, "pet_history": []}
    out = s.build(CFG, prev, [], date(2026, 10, 15), api_key="k", before_send=True, issue=ISSUE)
    assert out["intro"] == {"text": "Hi", "edition": "weekend"}
    assert out["pet"]["name"] == "Chloe"


def test_more_ai_speak_is_caught():
    for t in ("Here it is in plain English.", "Plain-English updates from the council.", "Let's dive in!", "A seamless night out."):
        assert "sounds like AI" in s.rule_problems(t, "good"), t


def test_the_ai_writes_new_questions_monthly_and_each_monday_uses_the_next(monkeypatch):
    calls = []

    def fake_ai(key, system, user, max_tokens=6000):
        calls.append(system[:30])
        if "editor" in system:
            return [{"id": it["id"], "verdict": "keep"} for it in json.loads(user)]
        return {"questions": ["Best spot for a fall picnic in Victoria?", "Who has the best Halloween decorations in town?",
                              "Which candidate gets your vote?", "Best kolache or breakfast taco in Victoria? Tell us where, and what you order.",
                              "What's a hidden gem nestled downtown?"]}
    monkeypatch.setattr(s, "ai_json", fake_ai)
    cfg = {"questions": ["Best kolache or breakfast taco in Victoria? Tell us where, and what you order.", "Best burger?"]}
    out = {"review": []}
    q = s.plan_questions(cfg, {}, date(2026, 10, 19), "k", out)
    assert q == "Best spot for a fall picnic in Victoria?"
    # Politics, the town's own question again and AI-speak never get in.
    assert [b["q"] for b in out["question_bank"]] == ["Who has the best Halloween decorations in town?"]
    assert out["questions_added"] == ["Best spot for a fall picnic in Victoria?", "Who has the best Halloween decorations in town?"]
    assert {r["why"] for r in out["review"] if r["verdict"] == "drop"} == {"not good news", "sounds like AI"}
    # Next week: same month, but fewer than 4 left, so it writes more; then the bank's next one runs.
    prev = {k: out[k] for k in ("question_bank", "questions_asked", "questions_generated")}
    calls.clear()
    out2 = {"review": []}
    q2 = s.plan_questions(cfg, prev, date(2026, 10, 26), "k", out2)
    assert q2 == "Who has the best Halloween decorations in town?" and len(calls) == 2
    # Without the AI: the town's own list, in order.
    out3 = {"review": []}
    assert s.plan_questions(cfg, {}, date(2026, 10, 19), "", out3) == s.question_for(cfg, date(2026, 10, 19))
    assert out3["questions_added"] == []


def test_a_bank_full_enough_this_month_writes_nothing_new(monkeypatch):
    monkeypatch.setattr(s, "ai_json", lambda *a, **k: (_ for _ in ()).throw(AssertionError("no AI call expected")))
    bank = [{"id": f"{i:010d}", "q": f"Question {i}?", "added": "2026-10-05"} for i in range(5)]
    out = {"review": []}
    q = s.plan_questions({}, {"question_bank": bank, "questions_generated": "2026-10"}, date(2026, 10, 19), "k", out)
    assert q == "Question 0?" and len(out["question_bank"]) == 4
