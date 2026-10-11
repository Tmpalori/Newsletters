"""scripts/uptime_check.py: what counts as down, and when it alerts."""
import datetime as dt
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "scripts"))
import uptime_check as uc  # noqa: E402

SITE = "https://www.thevic361.com"
T0 = dt.datetime(2026, 10, 6, 15, 0, tzinfo=dt.timezone.utc)
GOOD = {"/": (200, b"<html>", 0.3), "/api/health?deep=1": (200, b"{}", 0.1),
        "/events.json": (200, json.dumps({"events": [{"name": "x"}]}).encode(), 0.4)}


def fake(overrides=None):
    table = {**GOOD, **(overrides or {})}
    return lambda url: table[url[len(SITE):]]


def test_all_good():
    assert uc.problems(SITE, fake()) == ([], GOOD["/events.json"][1])


def test_each_way_to_be_down():
    found, _ = uc.problems(SITE, fake({"/": (0, b"", 20), "/api/health?deep=1": (503, b"", 0.1),
                                       "/events.json": (200, b'{"events": []}', 0.2)}))
    assert found == ["/ did not answer", "/api/health?deep=1 returned HTTP 503", "events feed is empty"]
    found, _ = uc.problems(SITE, fake({"/": (200, b"", 14.2), "/events.json": (200, b"<html>", 0.2)}))
    assert found == ["/ took 14s", "events feed is unreadable"]


def test_alert_once_remind_hourly_then_recover():
    msg, s = uc.decide({}, ["/ returned HTTP 502"], T0)
    assert msg == "🚨 thevic361.com is DOWN: / returned HTTP 502"
    msg, s = uc.decide(s, ["/ returned HTTP 502"], T0 + dt.timedelta(minutes=5))
    assert msg is None
    msg, s = uc.decide(s, ["/ returned HTTP 502"], T0 + dt.timedelta(minutes=61))
    assert msg == "🚨 thevic361.com still DOWN (61 min): / returned HTTP 502"
    msg, s = uc.decide(s, ["/ returned HTTP 502"], T0 + dt.timedelta(minutes=90))
    assert msg is None
    msg, s = uc.decide(s, [], T0 + dt.timedelta(minutes=95))
    assert msg == "✅ thevic361.com is back up (down about 95 min)"
    assert s == {}
    assert uc.decide({}, [], T0) == (None, {})


def test_main_retries_before_alerting(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    sent = []
    monkeypatch.setattr(uc.slack_notify, "main", lambda a: sent.append(a[0]))
    monkeypatch.setattr(uc, "push", lambda m, s: None)
    calls = {"n": 0}

    def flaky(url):  # down on the first pass (a deploy restart), fine after
        calls["n"] += 1
        return (502, b"", 0.1) if calls["n"] <= 3 else fake()(url)
    waits = []
    assert uc.main([SITE, "s.json"], fetch=flaky, sleep=waits.append, now=T0) == 0
    assert waits == [uc.RETRY_WAIT] and sent == []
    assert json.loads((tmp_path / "events.json").read_text())["events"]

    down = fake({"/": (502, b"", 0.1)})
    assert uc.main([SITE, "s.json"], fetch=down, sleep=lambda s: None, now=T0) == 1
    assert sent == ["🚨 thevic361.com is DOWN: / returned HTTP 502"]
    assert uc.main([SITE, "s.json"], fetch=down, sleep=lambda s: None, now=T0 + dt.timedelta(minutes=5)) == 1
    assert len(sent) == 1
    assert uc.main([SITE, "s.json"], fetch=fake(), sleep=lambda s: None, now=T0 + dt.timedelta(minutes=10)) == 0
    assert sent[-1] == "✅ thevic361.com is back up (down about 10 min)"


def test_corrupt_state_is_treated_as_up(tmp_path):
    p = tmp_path / "s.json"
    p.write_text("not json")
    assert uc.load(str(p)) == {}
    p.write_text("[1]")
    assert uc.load(str(p)) == {}


def test_push_carries_the_town_tag(monkeypatch):
    # The phone push says which town, like the Slack post.
    sent = []

    class _Ok:
        def read(self):
            return b"ok"

    def fake_urlopen(req, timeout=None):
        sent.append((req.data.decode(), req.get_header("Priority")))
        return _Ok()
    monkeypatch.setenv("NTFY_TOPIC", "t")
    monkeypatch.delenv("SLACK_TOWN_TAG", raising=False)
    monkeypatch.delenv("TOWN", raising=False)
    monkeypatch.setattr(uc.urllib.request, "urlopen", fake_urlopen)
    uc.push("🚨 Site down", "https://www.thevic361.com")
    monkeypatch.setenv("SLACK_TOWN_TAG", "Kearney")
    uc.push("✅ Site back up", "https://www.thecrane308.com")
    assert sent == [("[Victoria] 🚨 Site down", "urgent"), ("[Kearney] ✅ Site back up", "default")]
