"""Tests for the feed freshness check (scripts/feed_age.py) and the
Slack notifier's failure handling (scripts/slack_notify.py)."""
import datetime as dt
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "scripts"))
import feed_age  # noqa: E402

NOW = dt.datetime(2026, 10, 7, 15, 0, tzinfo=dt.timezone.utc)  # Wed 10 AM Central


def write(tmp_path, data):
    p = tmp_path / "events.json"
    p.write_text(json.dumps(data))
    return str(p)


def test_age_uses_the_collect_not_the_last_edit(tmp_path):
    # A submission approved today moved last_updated; the collector stalled.
    p = write(tmp_path, {"last_updated": "2026-10-07T14:00:00Z", "collected_at": "2026-09-27T20:27:00-05:00", "events": []})
    assert feed_age.age_days(p, NOW) == 9
    # Feeds from before collected_at existed fall back to last_updated.
    p = write(tmp_path, {"last_updated": "2026-10-04T14:00:00Z", "events": []})
    assert feed_age.age_days(p, NOW) == 3
    assert feed_age.age_days(str(tmp_path / "missing.json"), NOW) == 99


def test_upcoming_counts_events_from_today_in_victoria(tmp_path):
    events = [{"date": "2026-10-06"}, {"date": "2026-10-07"}, {"date": "2026-10-11"}, "junk"]
    p = write(tmp_path, {"events": events})
    assert feed_age.upcoming(p, NOW) == 2
    # 11 PM Wednesday Central is already Thursday in UTC; still Wednesday here.
    late = dt.datetime(2026, 10, 8, 4, 0, tzinfo=dt.timezone.utc)
    assert feed_age.upcoming(p, late) == 2
    # Only last May's bundled list: nothing upcoming.
    assert feed_age.upcoming(write(tmp_path, {"events": [{"date": "2026-05-17"}]}), NOW) == 0
    assert feed_age.upcoming(str(tmp_path / "missing.json"), NOW) == 0


def _slack_answer(monkeypatch, code, body):
    """slack_notify.main against a fake Slack answering code + body."""
    import io
    import urllib.error
    import slack_notify

    def fake_urlopen(req, timeout=None):
        raise urllib.error.HTTPError(req.full_url, code, "x", {}, io.BytesIO(body.encode()))
    monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/T/B/x")
    monkeypatch.setattr(slack_notify.urllib.request, "urlopen", fake_urlopen)
    return slack_notify.main(["hello"])


def test_slack_refused_webhook_fails_the_step(monkeypatch, capsys):
    # An archived channel or removed app would otherwise silence every later
    # alert with only a log line; a red step makes GitHub email the owner.
    assert _slack_answer(monkeypatch, 410, "channel_is_archived") == 2
    assert "::error::Slack refused" in capsys.readouterr().out
    assert _slack_answer(monkeypatch, 404, "no_service") == 2
    assert _slack_answer(monkeypatch, 400, "channel_is_archived") == 2


def test_slack_hiccup_stays_green(monkeypatch):
    assert _slack_answer(monkeypatch, 500, "rollup_error") == 0
    assert _slack_answer(monkeypatch, 429, "rate_limited") == 0


def test_slack_town_tag(monkeypatch):
    # MULTI_CITY_PLAN.md 4.3: SLACK_TOWN_TAG prefixes every message so towns
    # can share channels; unset, Victoria's posts carry its city.
    import json as _json
    import slack_notify
    sent = []

    class _Ok:
        def read(self):
            return b"ok"

    def fake_urlopen(req, timeout=None):
        sent.append(_json.loads(req.data)["text"])
        return _Ok()
    monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/T/B/x")
    monkeypatch.setattr(slack_notify.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.delenv("SLACK_TOWN_TAG", raising=False)
    monkeypatch.delenv("TOWN", raising=False)
    slack_notify.main(["🗓️ Collect done", "--link", "https://x.example/admin.html"])
    monkeypatch.setenv("SLACK_TOWN_TAG", "Bay City")
    slack_notify.main(["🗓️ Collect done"])
    monkeypatch.setenv("SLACK_TOWN_TAG", "A<b>")
    slack_notify.main(["hi"])
    assert sent == ["[Victoria] 🗓️ Collect done <https://x.example/admin.html|Open>", "[Bay City] 🗓️ Collect done", "[A&lt;b&gt;] hi"]


def test_slack_town_tag_defaults_to_another_towns_city(tmp_path):
    # A workflow run as another town with no SLACK_TOWN_TAG variable is
    # still tagged (its city), and so is Victoria (TOWN set or unset).
    import json as _json
    import slack_notify
    (tmp_path / "bay").mkdir()
    (tmp_path / "bay" / "town.json").write_text(_json.dumps({
        "siteName": "The Bay 979", "domain": "thebay979.com", "city": "Bay City", "state": "TX",
        "stateName": "Texas", "timezone": "America/Chicago"}))
    assert slack_notify.town_tag({}) == "Victoria"
    assert slack_notify.town_tag({"TOWN": "victoria", "SLACK_TOWN_TAG": ""}) == "Victoria"
    assert slack_notify.town_tag({"TOWN": "bay", "TOWNS_DIR": str(tmp_path), "SLACK_TOWN_TAG": ""}) == "Bay City"
    assert slack_notify.town_tag({"TOWN": "bay", "TOWNS_DIR": str(tmp_path), "SLACK_TOWN_TAG": "Bay"}) == "Bay"
    assert slack_notify.town_tag({"TOWN": "nowhere", "TOWNS_DIR": str(tmp_path)}) == "nowhere"   # still tagged


def _notify_with_site(monkeypatch, slack_code=None, env=None):
    """slack_notify.main with a fake Slack (None: ok) and a fake site; returns
    (exit code, what the site got, or None)."""
    import io
    import json as _json
    import urllib.error
    import slack_notify
    got = {}

    class _Ok:
        def read(self):
            return b"ok"

    def fake_urlopen(req, timeout=None):
        if req.full_url.startswith("https://hooks.slack.com/"):
            if slack_code:
                raise urllib.error.HTTPError(req.full_url, slack_code, "x", {}, io.BytesIO(b"no_service"))
            return _Ok()
        got["url"] = req.full_url
        got["secret"] = req.get_header("X-ops-secret")
        got["body"] = _json.loads(req.data)
        return _Ok()
    for k in ("OPS_REPORT_URL", "OPS_REPORT_SECRET", "OPS_ALREADY_IN_SLACK", "SLACK_WEBHOOK_URL"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("SLACK_TOWN_TAG", "Victoria")
    for k, v in (env or {}).items():
        monkeypatch.setenv(k, v)
    monkeypatch.setattr(slack_notify.urllib.request, "urlopen", fake_urlopen)
    rc = slack_notify.main(["🚨 Weekly event collect failed", "--link", "https://github.com/x/y/actions/runs/1"])
    return rc, (got or None)


SITE_ENV = {"OPS_REPORT_URL": "https://www.thevic361.com/", "OPS_REPORT_SECRET": "s3cret"}


def test_alerts_also_reach_the_site_inbox(monkeypatch):
    # The owner's assistant reads the site's inbox (via HQ); a workflow's
    # alert that only went to Slack never reached it.
    rc, site = _notify_with_site(monkeypatch, env={"SLACK_WEBHOOK_URL": "https://hooks.slack.com/services/T/B/x", **SITE_ENV})
    assert rc == 0
    assert site["url"] == "https://www.thevic361.com/api/ops/report"
    assert site["secret"] == "s3cret"
    assert site["body"] == {"title": "🚨 Weekly event collect failed", "text": "",
                            "link": "https://github.com/x/y/actions/runs/1", "slack_delivered": True}


def test_without_slack_the_site_is_told_it_wasnt_delivered(monkeypatch):
    rc, site = _notify_with_site(monkeypatch, env=SITE_ENV)                       # no webhook
    assert rc == 0 and site["body"]["slack_delivered"] is False
    rc, site = _notify_with_site(monkeypatch, slack_code=410,                       # refused
                                 env={"SLACK_WEBHOOK_URL": "https://hooks.slack.com/services/T/B/x", **SITE_ENV})
    assert rc == 2 and site["body"]["slack_delivered"] is False
    rc, site = _notify_with_site(monkeypatch, env={"OPS_ALREADY_IN_SLACK": "1", **SITE_ENV})
    assert site["body"]["slack_delivered"] is True


def test_only_alert_steps_report_to_the_site(monkeypatch):
    rc, site = _notify_with_site(monkeypatch, env={"SLACK_WEBHOOK_URL": "https://hooks.slack.com/services/T/B/x"})
    assert rc == 0 and site is None
    rc, site = _notify_with_site(monkeypatch, env={"OPS_REPORT_URL": "http://insecure.example", "OPS_REPORT_SECRET": "s"})
    assert site is None


def test_a_site_thats_down_never_fails_the_alert(monkeypatch, capsys):
    import slack_notify

    def boom(req, timeout=None):
        raise OSError("connection refused")
    monkeypatch.setattr(slack_notify.urllib.request, "urlopen", boom)
    assert slack_notify.report_to_site("🚨 x", None, True, env=SITE_ENV) is False
    assert "Couldn't report to the site" in capsys.readouterr().out


def test_slack_notify_channel_picks_its_own_webhook():
    # On the town services SLACK_WEBHOOK_URL is the sales channel: an alert
    # or report names its channel and falls back to the default only when
    # that channel has no webhook.
    import slack_notify
    env = {"SLACK_WEBHOOK_URL": "https://hooks.slack.com/sales", "SLACK_ALERTS_WEBHOOK_URL": "https://hooks.slack.com/alerts"}
    assert slack_notify.webhook_for("alerts", env) == "https://hooks.slack.com/alerts"
    assert slack_notify.webhook_for("activity", env) == "https://hooks.slack.com/sales"
    assert slack_notify.webhook_for(None, env) == "https://hooks.slack.com/sales"
