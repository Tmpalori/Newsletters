"""scripts/launch_check.py (MULTI_CITY_PLAN.md 5.3): a new town's live site
checked read-only against a fake site."""
import datetime as dt
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "scripts"))
import launch_check  # noqa: E402
import new_town  # noqa: E402

SITE = "https://www.thebay979.com"
BAY = ["--slug", "bay", "--name", "The Bay 979", "--domain", "thebay979.com", "--city", "Bay City", "--state", "TX",
       "--state-name", "Texas", "--timezone", "America/Chicago", "--yes"]


def _feed(n=12, collected_days_ago=2):
    """A live feed with n events from today on and a collect some days ago."""
    now = dt.datetime.now(dt.timezone.utc)
    days = [(now + dt.timedelta(days=i % 7 + 1)).date().isoformat() for i in range(n)]
    feed = {"events": [{"name": f"Event {i}", "date": d} for i, d in enumerate(days)]}
    if collected_days_ago is not None:
        feed["collected_at"] = (now - dt.timedelta(days=collected_days_ago)).isoformat()
    return json.dumps(feed)


def fake_site(**override):
    pages = {
        "/api/health?deep=1": (200, json.dumps({"ok": True, "storage": "postgres"})),
        "/api/config": (200, json.dumps({"town": {"id": "bay", "domain": "thebay979.com"},
                                         "github_events_path": "towns/bay/public/events.json",
                                         "turnstile_required": True, "turnstile_site_key": "0x4AAA",
                                         "town_workflows": True})),
        "/robots.txt": (200, f"User-agent: *\nSitemap: {SITE}/sitemap.xml\n"),
        "/sitemap.xml": (200, f"<urlset><url><loc>{SITE}/</loc></url></urlset>"),
        "/events.json": (200, _feed()),
        "/api/hq/summary": (200, json.dumps({"ok": True, "town": {"id": "bay"}})),
        **{p: (200, f"<h1>The Bay 979</h1> Bay City, TX {p}") for p in launch_check.PAGES},
    }
    pages.update(override)
    seen = []

    def get(url, headers=None):
        path = url[len(SITE):]
        seen.append((path, (headers or {}).get("Authorization")))
        status, body = pages.get(path, (404, "Not found"))
        return status, "", "", body
    return get, seen


def seed_venues(tmp_path):
    (tmp_path / "bay" / "venues.json").write_text(json.dumps([{"name": "Bay Hall"}]))


def run(tmp_path, monkeypatch, get, hq_key="", seed=True):
    assert new_town.main([*BAY, "--towns-dir", str(tmp_path)]) == 0
    if seed:
        seed_venues(tmp_path)
    if hq_key:
        monkeypatch.setenv("HQ_API_KEY", hq_key)
    else:
        monkeypatch.delenv("HQ_API_KEY", raising=False)
    return launch_check.main(["--town", "bay", "--towns-dir", str(tmp_path)], get=get)


def test_a_ready_town_passes(tmp_path, monkeypatch, capsys):
    get, seen = fake_site()
    assert run(tmp_path, monkeypatch, get, hq_key="k" * 20) == 0
    out = capsys.readouterr().out
    assert "All automatic checks passed." in out and "❌" not in out
    assert "delivered@resend.dev" in out
    assert ("/api/hq/summary", "Bearer " + "k" * 20) in seen
    assert all(auth is None for path, auth in seen if path != "/api/hq/summary")   # the key goes only to HQ


def test_a_copy_of_victoria_fails(tmp_path, monkeypatch, capsys):
    get, _ = fake_site(**{
        "/api/health?deep=1": (200, json.dumps({"ok": True, "storage": "file"})),
        "/api/config": (200, json.dumps({"town": {"id": "victoria", "domain": "thevic361.com"}, "github_events_path": "docs/events.json"})),
        "/about": (200, "About The Vic 361, Victoria, TX"),
        "/": (200, '<script src="https://www.googletagmanager.com/gtag/js?id=G-52YHD3X3C2"></script>'),
        "/robots.txt": (200, "Sitemap: https://www.thevic361.com/sitemap.xml"),
        "/events.json": (500, "oops"),
    })
    assert run(tmp_path, monkeypatch, get) == 1
    out = capsys.readouterr().out
    for line in ["❌ runs on its own Postgres (storage: file)", "❌ runs as TOWN=bay (says 'victoria')",
                 "❌ /about answers without Victoria's name (found The Vic 361, Vic 361, Victoria, TX)",
                 "❌ / answers without Victoria's name (found G-52YHD3X3C2)", "❌ robots.txt points at its own sitemap",
                 "❌ /events.json answers (HTTP 500)", "❌ Turnstile is on", "(HQ feed not checked"]:
        assert line in out, line


def test_refuses_victoria_and_an_unknown_town(tmp_path, capsys):
    assert launch_check.main(["--town", "victoria"], get=lambda *a, **k: None) == 2
    assert launch_check.main(["--town", "nope", "--towns-dir", str(tmp_path)], get=lambda *a, **k: None) == 2
    assert "Can't read the town" in capsys.readouterr().err


def test_reads_TOWNS_DIR_and_refuses_Victoria_in_any_case(tmp_path, monkeypatch, capsys):
    assert new_town.main([*BAY, "--towns-dir", str(tmp_path)]) == 0
    seed_venues(tmp_path)
    monkeypatch.setenv("TOWNS_DIR", str(tmp_path))
    monkeypatch.delenv("HQ_API_KEY", raising=False)
    get, _ = fake_site()
    assert launch_check.main(["--town", "bay"], get=get) == 0
    assert launch_check.main(["--town", " Victoria "], get=get) == 2


def test_lists_the_email_settings_only_a_person_can_check(tmp_path, monkeypatch, capsys):
    # The site never says whether RESEND_API_KEY or NEWSLETTER_ADDRESS is
    # set, so they are on the manual list; Turnstile is checked from its
    # public /api/config flags.
    get, _ = fake_site()
    assert run(tmp_path, monkeypatch, get) == 0
    out = capsys.readouterr().out
    assert "✅ Turnstile is on" in out
    for name in ["RESEND_API_KEY", "NEWSLETTER_ADDRESS", "NEWSLETTER_REPLY_TO", "NEWSLETTER_CRON_SECRET", "TURNSTILE_SECRET_KEY",
                 "email.bounced", "email.complained"]:
        assert name in out, name


def test_an_empty_or_stale_town_fails(tmp_path, monkeypatch, capsys):
    # Every page answers, but nothing is collecting: the launch must not pass.
    get, _ = fake_site(**{
        "/events.json": (200, _feed(n=3, collected_days_ago=12)),
        "/api/config": (200, json.dumps({"town": {"id": "bay", "domain": "thebay979.com"},
                                         "github_events_path": "towns/bay/public/events.json"})),
    })
    assert run(tmp_path, monkeypatch, get, seed=False) == 1
    out = capsys.readouterr().out
    for line in ["❌ at least 10 upcoming events (3)", "❌ a collect in the last 8 days (12 days ago)",
                 "❌ its workflows are on (\"workflows\": true in town.json, after its GitHub Environment) (says None)",
                 "❌ towns/bay/venues.json is seeded (0 venues)"]:
        assert line in out, line


def test_past_events_and_no_collected_at_fail(tmp_path, monkeypatch, capsys):
    past = json.dumps({"events": [{"name": "Old", "date": "2020-01-01"}] * 20})
    get, _ = fake_site(**{"/events.json": (200, past)})
    assert run(tmp_path, monkeypatch, get) == 1
    out = capsys.readouterr().out
    assert "❌ at least 10 upcoming events (0)" in out
    assert "❌ a collect in the last 8 days (no collected_at)" in out


def test_missing_venues_file_fails(tmp_path, monkeypatch, capsys):
    get, _ = fake_site()
    assert new_town.main([*BAY, "--towns-dir", str(tmp_path)]) == 0
    os.remove(tmp_path / "bay" / "venues.json")
    monkeypatch.delenv("HQ_API_KEY", raising=False)
    assert launch_check.main(["--town", "bay", "--towns-dir", str(tmp_path)], get=get) == 1
    assert "❌ towns/bay/venues.json is seeded (0 venues, missing or unreadable)" in capsys.readouterr().out


def test_manual_list_names_the_deferred_plan_items(tmp_path, monkeypatch, capsys):
    get, _ = fake_site()
    run(tmp_path, monkeypatch, get)
    out = capsys.readouterr().out
    assert "Must be done before launch" in out
    for item in ("3.3", "3.4", "3.5", "3.7", "2.6", "New town on Railway"):
        assert item in out, item
