"""leads.py: categories, the towns' areas, picking, task bookkeeping and the
CSV, all offline. Any network call fails the test (no_network)."""
import csv
import json
import os
import re
import sys
import urllib.request

import pytest

LEADS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, LEADS)

import leads  # noqa: E402

REPO = leads.REPO


@pytest.fixture(autouse=True)
def no_network(monkeypatch, tmp_path):
    def refuse(*a, **k):
        raise AssertionError("leads.py tried the network in a test")
    monkeypatch.setattr(urllib.request, "urlopen", refuse)
    monkeypatch.setattr(leads, "OUT", str(tmp_path / "out"))


def row(bid, name, domain, cat="food", reviews=10, stores=1, score=5.0):
    return {"id": bid, "category": cat, "query": "q", "match_score": score,
            "content": {"business_name": name, "root_domain": domain, "website_url": f"https://{domain}",
                        "google_reviews_count": reviews, "google_rating": 4.5, "num_stores": stores,
                        "city": "Victoria", "store_phones": ["+13615550100"]}}


# --- categories and towns ------------------------------------------------------

def test_quotas_fill_the_target_and_ids_are_unique():
    assert sum(c[3] for c in leads.CATEGORIES) == leads.TARGET
    ids = [c[0] for c in leads.CATEGORIES]
    assert len(ids) == len(set(ids)) and "listed" not in ids
    assert all(c[4] for c in leads.CATEGORIES)


def test_partner_categories_exist_on_the_site():
    """Every category pitched as a category partner is one server/town.js sells."""
    src = open(os.path.join(REPO, "server", "town.js")).read()
    sold = set(re.findall(r"id: '([a-z]+)', label: '[^']*', emoji: '[^']*', owner:", src))
    pitched = {c[2] for c in leads.CATEGORIES if c[2]}
    assert pitched and pitched <= sold


@pytest.mark.parametrize("slug", leads.TOWNS)
def test_each_town_has_an_area(slug):
    a = leads.area(slug)
    assert re.fullmatch(r"[A-Z]{2}", a["state"])
    assert a["zips"] and all(re.fullmatch(r"\d{5}", z) for z in a["zips"])
    loc = leads.location(a)
    assert loc == [{"country": "US", "state": a["state"], "zip_code": a["zips"]}]
    assert leads.listed_venues(a), f"{slug}: no venues.json venues"


def test_search_plan_asks_for_enough_per_query():
    a = leads.area("victoria")
    plan = leads.search_plan(a)
    assert len(plan) == sum(len(c[4]) for c in leads.CATEGORIES)
    for cat, q, body, path in plan:
        quota, n = leads.CATEGORY[cat][3], len(leads.CATEGORY[cat][4])
        assert 10 <= body["limit"] <= 100 and body["limit"] * n >= quota
        assert body["has_website"] is True and body["max_locations"] == leads.MAX_STORES
        assert path.endswith(".json") and f"{os.sep}victoria{os.sep}search{os.sep}" in path
    assert {b["limit"] for *_, b, _p in [(p[0], p[1], p[2], p[3]) for p in leads.search_plan(a, ["dental"], 5)]} == {5}


# --- normalizing ---------------------------------------------------------------

@pytest.mark.parametrize("url,want", [
    ("https://www.Example.com/menu?x=1", "example.com"),
    ("example.com", "example.com"),
    ("http://shop.example.co.uk:8080/", "shop.example.co.uk"),
    ("mailto:owner@bakery.com", "bakery.com"),
    ("https://www.facebook.com/aerocrafters", ""),
    ("https://joes.wixsite.com/joes", ""),
    ("https://agents.statefarm.com/tx/victoria/jane", ""),
    ("", ""), ("not a url", ""),
])
def test_domain_of(url, want):
    assert leads.domain_of(url) == want


def test_name_key_is_loose():
    assert leads.name_key("The Moonshine Drinkery, LLC") == leads.name_key("moonshine drinkery")
    assert leads.name_key("Froggy's Grub & Pub") == "froggy s grub and pub"


def test_credits_in_finds_the_number():
    assert leads.credits_in({"remaining_credits": 120}) == 120
    assert leads.credits_in({"data": {"balance": 7.5}}) == 7.5
    assert leads.credits_in(42) == 42
    assert leads.credits_in({"plan": "pro", "ok": True}) is None


# --- pick ----------------------------------------------------------------------

def test_pick_drops_chains_and_repeat_domains():
    rows = [row("a", "Joe's", "joes.com", reviews=100), row("b", "Joe's Too", "joes.com", reviews=5),
            row("c", "Big Chain", "chain.com", stores=400), row("d", "No Site", "facebook.com")]
    got = leads.pick(rows, [])
    assert [l["id"] for l in got] == ["a"]
    assert got[0]["domain"] == "joes.com" and got[0]["listed"] is False


def test_pick_keeps_listed_venues_and_adds_the_ones_search_missed():
    venues = [{"name": "Moonshine Drinkery", "domain": "", "category": "Bar"},
              {"name": "Aero Crafters", "domain": "aerocrafters.pub", "category": "Bar"},
              {"name": "FB Only", "domain": "", "category": "Bar"}]
    rows = [row("m", "Moonshine Drinkery", "moonshinevic.com", reviews=0),
            *[row(f"f{i}", f"Food {i}", f"food{i}.com", reviews=500) for i in range(60)]]
    got = leads.pick(rows, venues, target=55)
    ids = [l["id"] for l in got]
    assert len(got) == 55
    assert "m" in ids, "a listed venue matched by name stays in"
    assert "venue:aerocrafters.pub" in ids, "a listed venue with a site the search missed is added"
    added = next(l for l in got if l["id"] == "venue:aerocrafters.pub")
    assert added["listed"] and added["source"] == "venues.json" and added["category"] == "listed"
    assert not any(l["content"].get("business_name") == "FB Only" for l in got)


def test_pick_fills_quotas_then_the_best_of_the_rest():
    rows = [row(f"d{i}", f"Dentist {i}", f"dent{i}.com", cat="dental", reviews=1000) for i in range(40)]
    rows += [row(f"l{i}", f"Law {i}", f"law{i}.com", cat="legal", reviews=1) for i in range(5)]
    got = leads.pick(rows, [], target=30)
    cats = [l["category"] for l in got]
    assert cats.count("legal") == 5, "a short category keeps every lead it has"
    assert cats.count("dental") == 25, "its quota (20), then the rest of the slots"


def test_searched_keeps_each_business_once_at_its_best_match(tmp_path):
    d = os.path.join(leads.OUT, "victoria", "search")
    os.makedirs(d)
    a, b = row("x", "Bar & Grill", "bg.com"), row("x", "Bar & Grill", "bg.com")
    for name, cat, r, s in (("food__bar.json", "food", a, 2.0), ("entertainment__live.json", "entertainment", b, 9.0)):
        r = dict(r, match_score=s)
        json.dump({"category": cat, "query": "q", "results": [{"id": r["id"], "match_score": s,
                                                                "content": r["content"]}]},
                  open(os.path.join(d, name), "w"))
    got = leads.searched("victoria")
    assert len(got) == 1 and got[0]["category"] == "entertainment"


# --- dry runs and batches --------------------------------------------------------

def test_dry_runs_send_nothing(capsys):
    assert leads.main(["search", "--town", "victoria", "--category", "dental"]) == 0
    out = capsys.readouterr().out
    assert "would search dental" in out and "dry run: nothing sent" in out
    assert not os.path.exists(os.path.join(leads.OUT, "victoria", "search"))


def picked_file(slug, items):
    os.makedirs(os.path.join(leads.OUT, slug), exist_ok=True)
    leads.write_json(os.path.join(leads.OUT, slug, "picked.json"), items)


def test_contacts_skip_what_was_already_sent(capsys):
    a = leads.area("victoria")
    items = [dict(row(f"p{i}", f"Shop {i}", f"shop{i}.com"), domain=f"shop{i}.com", listed=False) for i in range(3)]
    picked_file("victoria", items)
    leads.write_json(leads.batches_file("victoria", "people"), [{"batch_id": "b1", "tracking_ids": ["p0"]}])
    assert leads.main(["contacts", "--town", "victoria"]) == 0
    assert "1 already sent, 2 to send" in capsys.readouterr().out
    t = leads.find_people_task(items[1], a, "Owner or decision maker", 1, False)
    assert t == {"domain": "shop1.com", "company_name": "Shop 1", "title": "Owner or decision maker", "max_k": 1,
                 "info_access": ["EMAIL"], "city": "Victoria", "state": "TX", "country": "US", "tracking_id": "p1"}
    assert leads.find_people_task(items[1], a, "Owner", 2, True)["info_access"] == ["EMAIL", "PHONE"]


def test_emails_skip_picks_the_search_already_gave_an_email(capsys):
    free = row("f", "Has Info", "hasinfo.com")
    free["content"]["business_emails"] = ["info@hasinfo.com"]
    items = [dict(free, domain="hasinfo.com", listed=False),
             dict(row("n", "No Info", "noinfo.com"), domain="noinfo.com", listed=False)]
    picked_file("victoria", items)
    assert leads.main(["emails", "--town", "victoria"]) == 0
    assert "1 picks with no verified person email" in capsys.readouterr().out


def test_submit_records_each_batch_and_splits_at_100(monkeypatch):
    sent = []

    def fake_call(method, path, body=None, timeout=60, tries=3):
        sent.append(len(body))
        return {"batch_id": f"b{len(sent)}", "status": {"batch_ready": False}}

    class NoMeter:
        def check(self):
            pass

    monkeypatch.setattr(leads, "call", fake_call)
    tasks = [{"tracking_id": f"t{i}", "domain": f"d{i}.com"} for i in range(230)]
    leads.submit("victoria", "people", "/api/v1/task/batch/find_people", tasks, NoMeter())
    assert sent == [100, 100, 30]
    assert leads.submitted("victoria", "people") == {f"t{i}" for i in range(230)}


def test_collect_saves_completed_tasks(monkeypatch):
    leads.write_json(leads.batches_file("victoria", "people"), [{"batch_id": "b1", "tracking_ids": ["p1"]}])
    answers = {"/api/v1/task/batch/b1/status": {"processing": 0, "completed": 1, "errored": 0, "batch_ready": True},
               "/api/v1/task/batch/b1/task_ids?status=COMPLETED": ["t1"],
               "/api/v1/task/t1": {"task_id": "t1", "status": "COMPLETED", "tracking_id": "p1",
                                   "data": [{"first_name": "Ann", "email": {"email": "ann@shop1.com", "verified": True}}]}}
    monkeypatch.setattr(leads, "call", lambda method, path, *a, **k: answers[path])
    leads.collect("victoria", "people")
    assert leads.task_results("victoria", "people")["p1"][0]["first_name"] == "Ann"
    assert leads.read_json(leads.batches_file("victoria", "people"))[0]["done"] is True


# --- export --------------------------------------------------------------------

def test_export_writes_the_csv():
    p3 = row("p3", "Shop 3", "shop3.com", cat="pets")
    p3["content"].update(business_emails=["info@shop3.com"], store_emails=["vet@shop3.com"],
                         staffs=[{"name": "Dr. Kim Lee", "role": "Owner"}, {"name": "Sam"}],
                         social_media_links={"FACEBOOK": ["https://www.facebook.com/shop3"], "INSTAGRAM": None})
    items = [dict(row("p1", "Shop 1", "shop1.com", cat="dental"), domain="shop1.com", listed=False),
             dict(row("p2", "Shop 2", "shop2.com", cat="shops"), domain="shop2.com", listed=True),
             {"id": "venue:aero.pub", "category": "listed", "match_score": 0, "listed": True, "domain": "aero.pub",
              "source": "venues.json", "content": {"business_name": "Aero", "website_url": "https://aero.pub"}},
             dict(p3, domain="shop3.com", listed=False)]
    picked_file("victoria", items)
    tdir = os.path.join(leads.OUT, "victoria", "people", "tasks")
    os.makedirs(tdir)
    leads.write_json(os.path.join(tdir, "t1.json"), {"tracking_id": "p1", "data": [
        {"first_name": "Bob", "last_name": "B", "email": {"email": "bob@shop1.com", "verified": False}},
        {"first_name": "Ann", "last_name": "A", "title": "Owner", "email": {"email": "ann@shop1.com", "verified": True},
         "phones": [{"phone_number": "+13615550111", "valid": True}]}]})
    bdir = os.path.join(leads.OUT, "victoria", "business_emails", "tasks")
    os.makedirs(bdir)
    leads.write_json(os.path.join(bdir, "t2.json"), {"tracking_id": "p2", "data": [{"email": "info@shop2.com", "status": "valid"}]})
    leads.cmd_export(["victoria"])
    rows = list(csv.DictReader(open(os.path.join(leads.OUT, "victoria", "leads-victoria.csv"))))
    assert list(rows[0].keys()) == list(leads.COLUMNS)
    one, two, aero, three = rows
    assert three["business_email"] == "info@shop3.com, vet@shop3.com"
    assert three["staff_on_website"] == "Dr. Kim Lee (Owner); Sam"
    assert (three["facebook"], three["instagram"]) == ("https://www.facebook.com/shop3", "")
    assert (one["contact_name"], one["contact_email"], one["email_verified"]) == ("Ann A", "ann@shop1.com", "yes")
    assert one["contact_phone"] == "+13615550111" and one["other_contacts"] == "Bob B <bob@shop1.com>"
    assert one["pitch"] == "Category partner: Dental" and one["newsletter"] == "The Vic 361"
    assert (two["business_email"], two["already_listed"], two["pitch"]) == ("info@shop2.com", "yes", "Weekly sponsor")
    assert aero["category"] == "Already in the newsletter" and aero["openmart_id"] == ""
    assert aero["pitch"] == "Featured events (already listed)"
    assert os.path.exists(os.path.join(leads.OUT, "leads-all.csv"))
