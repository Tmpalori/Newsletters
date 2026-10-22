"""scripts/new_town.py (MULTI_CITY_PLAN.md 5.1): a new town's files from a
few answers, checked like the server checks them, never Victoria's."""
import importlib
import json
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "scripts"))
import new_town  # noqa: E402
import town as town_mod  # noqa: E402

BAY = ["--slug", "bay", "--name", "The Bay 979", "--domain", "thebay979.com", "--city", "Bay City", "--state", "TX",
       "--state-name", "Texas", "--timezone", "America/Chicago", "--county", "Matagorda County", "--area-code", "979",
       "--zips", "77414, 77404", "--other-towns", "Wharton, Palacios", "--yes"]


def run(tmp_path, *args):
    return new_town.main([*args, "--towns-dir", str(tmp_path)])


def test_creates_the_town(tmp_path, capsys):
    assert run(tmp_path, *BAY) == 0
    out = capsys.readouterr().out
    assert json.loads((tmp_path / "bay" / "town.json").read_text()) == {
        "siteName": "The Bay 979", "domain": "thebay979.com", "city": "Bay City", "state": "TX", "stateName": "Texas",
        "timezone": "America/Chicago", "county": "Matagorda County", "areaCode": "979",
        "areaZips": ["77414", "77404"], "otherTowns": ["wharton", "palacios"]}
    assert (tmp_path / "bay" / "local_events.yaml").read_text().endswith("events: []\n")
    assert json.loads((tmp_path / "bay" / "venues.json").read_text()) == []   # never Victoria's root list
    # The newsletter sections: off, no sources yet, questions and polls to start.
    sx = json.loads((tmp_path / "bay" / "sections.json").read_text())
    assert sx["enabled"] is False and sx["pets"] == [] and sx["new_in_town"] == {}
    assert len(sx["questions"]) >= 8 and len(sx["polls"]) >= 3
    assert "Bay City" in sx["questions"][0] and "The Bay 979" in sx["polls"][0]["question"]
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "scripts"))
    import sections
    for q in sx["questions"]:
        assert not sections.rule_problems(q, "question"), q        # the same rules as the AI's
    assert (tmp_path / "bay" / "public").is_dir()
    assert json.loads((tmp_path / "index.json").read_text()) == {"towns": ["victoria", "bay"]}
    # town.py reads it back as the server would at boot.
    t = town_mod.town_config({"TOWN": "bay"}, towns_dir=str(tmp_path))
    assert t["site_url"] == "https://www.thebay979.com" and t["area_zips"] == ["77414", "77404"]
    assert "TOWN=bay python3 discover_venues.py --repo-root towns/bay" in out
    assert "SITE_URL=https://www.thebay979.com" in out and "NEWSLETTER_FROM=\"The Bay 979 <news@thebay979.com>\"" in out
    # Every email setting sending depends on is on the owner's list.
    for name in ["RESEND_API_KEY", "NEWSLETTER_ADDRESS", "NEWSLETTER_REPLY_TO", "NEWSLETTER_CRON_SECRET", "TURNSTILE_SECRET_KEY",
                 "RESEND_WEBHOOK_SECRET", "email.bounced", "email.complained"]:
        assert name in out, name
    assert "thevic361" not in out
    # The Railway-era runbooks are named; nothing points at GitHub.
    for item in ("LAUNCH_CHECKLIST.md", "RAILWAY.md \"New town, the simple way\"", "RAILWAY.md \"New town on Railway\"",
                 "JOBS_ON_RAILWAY=1", "META_TOWN=bay", '"workflows": false', "/towns/bay/**",
                 "shared account", "metadata.town=bay", "invoice.paid", "scripts/launch_check.py --town bay"):
        assert item in out, item
    for stale in ("GitHub Environment", '"workflows": true', "New\n    account", "own Stripe account"):
        assert stale not in out, stale


def test_index_stays_sorted_with_victoria_first(tmp_path):
    assert run(tmp_path, *BAY) == 0
    tulsa = ["--slug", "abilene", "--name", "Abilene Now", "--domain", "abilenenow.com", "--city", "Abilene", "--state", "TX",
             "--state-name", "Texas", "--timezone", "America/Chicago", "--yes"]
    assert run(tmp_path, *tulsa) == 0
    assert json.loads((tmp_path / "index.json").read_text())["towns"] == ["victoria", "abilene", "bay"]
    assert "county" not in json.loads((tmp_path / "abilene" / "town.json").read_text())


@pytest.mark.parametrize("change, error", [
    ({"--slug": "victoria"}, "victoria is The Vic 361"),
    ({"--slug": "Bay City"}, "slug must be"),
    ({"--domain": "thevic361.com"}, "Victoria's domain"),
    ({"--domain": "not a domain"}, "doesn't look like a domain"),
    ({"--timezone": "Mars/Base"}, "unknown timezone"),
    ({"--area-code": "97"}, "area_code"),
    ({"--zips": "7741"}, "5-digit"),
])
def test_refuses_bad_settings(tmp_path, capsys, change, error):
    args = list(BAY)
    for k, v in change.items():
        args[args.index(k) + 1] = v
    assert run(tmp_path, *args) == 1
    assert error in capsys.readouterr().err
    assert not (tmp_path / "index.json").exists()


def test_refuses_an_existing_town_and_missing_answers(tmp_path, capsys):
    assert run(tmp_path, *BAY) == 0
    before = (tmp_path / "bay" / "town.json").read_text()
    assert run(tmp_path, *BAY) == 1
    assert "already exists" in capsys.readouterr().err
    assert (tmp_path / "bay" / "town.json").read_text() == before
    with pytest.raises(SystemExit):
        run(tmp_path, "--slug", "x", "--yes")


def test_discover_venues_searches_the_town(tmp_path, monkeypatch):
    import discover_venues
    assert discover_venues.LOCATION_QUERY == "Victoria, TX"
    assert run(tmp_path, *BAY) == 0
    monkeypatch.setenv("TOWN", "bay")
    monkeypatch.setenv("TOWNS_DIR", str(tmp_path))
    try:
        importlib.reload(town_mod)
        assert importlib.reload(discover_venues).LOCATION_QUERY == "Bay City, TX"
    finally:
        monkeypatch.delenv("TOWN")
        monkeypatch.delenv("TOWNS_DIR")
        importlib.reload(town_mod)
        importlib.reload(discover_venues)
    assert discover_venues.LOCATION_QUERY == "Victoria, TX"


def test_a_bad_index_stops_before_anything_is_written(tmp_path, capsys):
    (tmp_path / "index.json").write_text("{not json")
    assert run(tmp_path, *BAY) == 1
    assert "isn't valid JSON" in capsys.readouterr().err
    assert not (tmp_path / "bay").exists()
    (tmp_path / "index.json").write_text("[]")
    assert run(tmp_path, *BAY) == 1
    assert not (tmp_path / "bay").exists()


def test_runs_with_TOWN_already_set_to_the_new_slug(tmp_path):
    import subprocess
    env = {**os.environ, "TOWN": "bay", "TOWNS_DIR": str(tmp_path)}
    r = subprocess.run([sys.executable, os.path.join(HERE, "scripts", "new_town.py"), *BAY, "--towns-dir", str(tmp_path)],
                       env=env, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert (tmp_path / "bay" / "town.json").exists()


def test_railway_runbook_covers_a_new_town():
    # new_town.py's checklist points at this section; it must hold every
    # setting a town's Railway project needs.
    with open(os.path.join(HERE, "RAILWAY.md"), encoding="utf-8") as f:
        doc = f.read()
    assert "## New town on Railway" in doc
    section = doc.split("## New town on Railway", 1)[1].split("\n## ", 1)[0]
    for item in ("TOWN=<slug>", "SITE_URL", "DATABASE_URL", "ADMIN_SESSION_SECRET", "openssl rand -hex 32",
                 "NEWSLETTER_CRON_SECRET", "EVENT_CHECK_SECRET", "SUBMISSION_REVIEW_SECRET", "ADS_SPEND_SECRET",
                 "RESEND_API_KEY", "NEWSLETTER_FROM", "NEWSLETTER_ADDRESS", "NEWSLETTER_REPLY_TO", "RESEND_WEBHOOK_SECRET",
                 "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "checkout.session.completed", "checkout.session.expired",
                 "charge.refunded", "charge.dispute.created", "TREMENDOUS_CAMPAIGN_ID", "TURNSTILE_SITE_KEY",
                 "GITHUB_TOKEN", "HQ_API_KEY", "HQ_TOWNS", "SLACK_TOWN_TAG", "META_TOWN=<slug>", "apex",
                 "PR environments", "Never", "launch_check.py"):
        assert item in section, item
