"""Tests for scripts/meta_ads.py, the Meta ads reader/manager."""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "scripts"))
import meta_ads as ma  # noqa: E402

TOKEN = "SECRET-TOKEN-123"


class Resp:
    def __init__(self, body, status=200):
        self.body, self.status_code = body, status

    def json(self):
        return self.body


class FakeMeta:
    """Answers the few Graph calls the script makes; records every call."""

    def __init__(self, accounts=None, scopes=("ads_read", "ads_management"), spend="12.34"):
        self.calls = []
        self.accounts = [{"id": "act_1", "name": "The Vic 361", "currency": "USD"}] if accounts is None else accounts
        self.scopes = scopes
        self.spend = spend
        self.objects = {"999": {"name": "Visitors ad set", "effective_status": "ACTIVE", "daily_budget": "1000"}}

    def request(self, method, url, headers=None, timeout=None, params=None, data=None):
        path = url.split("/v23.0/")[1]
        self.calls.append((method, path, headers, params, data))
        if method == "GET" and path == "me/permissions":
            return Resp({"data": [{"permission": p, "status": "granted"} for p in self.scopes]})
        if path == "me/adaccounts":
            return Resp({"data": self.accounts})
        if path.endswith("/insights"):
            return Resp({"data": [{"spend": self.spend, "reach": "800", "frequency": "1.4", "inline_link_clicks": "40",
                                   "inline_link_click_ctr": "1.9", "actions": [{"action_type": "landing_page_view", "value": "31"}]}]})
        if path.endswith("/campaigns"):
            return Resp({"data": [{"id": "1", "name": "Vic361 – Visitors", "effective_status": "ACTIVE", "objective": "OUTCOME_TRAFFIC"}]})
        if path.endswith("/adsets"):
            return Resp({"data": [{"id": "999", "name": "Victoria 25mi", "campaign_id": "1", "effective_status": "ACTIVE",
                                   "daily_budget": "1000", "optimization_goal": "LANDING_PAGE_VIEWS"}]})
        if path.endswith("/ads"):
            return Resp({"data": [{"id": "5", "name": "Video", "adset_id": "999", "effective_status": "PENDING_REVIEW"}]})
        if path in self.objects:
            if method == "POST":
                self.objects[path].update(data)
                if "status" in data:
                    self.objects[path]["effective_status"] = data["status"]
                return Resp({"success": True})
            return Resp(dict(self.objects[path]))
        return Resp({"error": {"message": "Unsupported request"}}, 400)


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv("META_ADS_TOKEN", TOKEN)
    monkeypatch.delenv("META_AD_ACCOUNT_ID", raising=False)
    monkeypatch.delenv("GITHUB_STEP_SUMMARY", raising=False)
    monkeypatch.setattr(ma.slack_notify, "main", lambda args: sent.append(args) or 0)
    sent.clear()


sent = []


def test_status_shows_structure_and_numbers_and_never_puts_the_token_in_a_url(capsys):
    meta = FakeMeta()
    assert ma.main(["status"], session=meta) == 0
    out = capsys.readouterr().out
    assert "ads_read and ads_management ✓" in out
    assert "Vic361 – Visitors" in out and "$10.00/day" in out and "pending_review" in out
    assert "31 landing page views ($0.40 each)" in out
    for method, path, headers, params, data in meta.calls:
        assert headers["Authorization"] == f"Bearer {TOKEN}"
        assert TOKEN not in path and TOKEN not in str(params) and TOKEN not in str(data)
    assert TOKEN not in out


def test_missing_permissions_and_no_ad_account_are_explained(capsys):
    assert ma.main(["status"], session=FakeMeta(accounts=[])) == 1
    assert "Assign assets → Ad accounts" in capsys.readouterr().out
    assert ma.main(["status"], session=FakeMeta(scopes=("pages_manage_posts",))) == 0
    assert "missing ads_read, ads_management" in capsys.readouterr().out


def test_scheduled_run_with_a_setup_problem_warns_but_does_not_fail(capsys):
    assert ma.main(["report", "--scheduled"], session=FakeMeta(accounts=[])) == 0
    assert "::warning::" in capsys.readouterr().out
    assert sent == []


def test_scheduled_run_with_a_dead_token_fails(capsys):
    # An expired or revoked token must turn the daily run red (the workflow's
    # failure step alerts Slack), not pass quietly every morning.
    class Expired(FakeMeta):
        def request(self, method, url, **k):
            return Resp({"error": {"message": "Error validating access token: Session has expired"}}, 400)
    assert ma.main(["report", "--scheduled"], session=Expired()) == 1
    assert "::error::" in capsys.readouterr().out


def test_scheduled_run_fails_when_the_configured_account_is_gone(monkeypatch, capsys):
    monkeypatch.setenv("META_AD_ACCOUNT_ID", "act_1")
    assert ma.main(["report", "--scheduled"], session=FakeMeta(accounts=[])) == 1
    assert "::error::" in capsys.readouterr().out


def test_report_goes_to_slack_only_when_something_spent():
    assert ma.main(["report"], session=FakeMeta()) == 0
    assert len(sent) == 1 and "📈 Meta ads: yesterday $12.34 spent" in sent[0][0]
    sent.clear()
    assert ma.main(["report"], session=FakeMeta(spend="0")) == 0
    assert sent == []


def test_zero_spend_is_reported_when_ads_should_be_running():
    # Nothing spent but an ad is on (or the account is disabled): that's a
    # stalled campaign, not a quiet week.
    class Live(FakeMeta):
        def request(self, method, url, **k):
            if url.endswith("/ads"):
                return Resp({"data": [{"id": "5", "name": "Video", "adset_id": "999", "effective_status": "ACTIVE"}]})
            return super().request(method, url, **k)
    assert ma.main(["report"], session=Live(spend="0")) == 0
    assert len(sent) == 1 and "$0 spent in the last 7 days" in sent[0][0] and "1 ad on" in sent[0][0]
    sent.clear()
    disabled = [{"id": "act_1", "name": "The Vic 361", "currency": "USD", "account_status": 2}]
    assert ma.main(["report"], session=FakeMeta(accounts=disabled, spend="0")) == 0
    assert len(sent) == 1 and "account is disabled" in sent[0][0]
    sent.clear()
    disapproved = [{"id": "5", "name": "Video", "adset_id": "999", "effective_status": "DISAPPROVED"}]

    class Rejected(FakeMeta):
        def request(self, method, url, **k):
            if url.endswith("/ads"):
                return Resp({"data": disapproved})
            return super().request(method, url, **k)
    assert ma.main(["report"], session=Rejected(spend="0")) == 0
    assert len(sent) == 1 and "Ad *Video* is disapproved" in sent[0][0]


def test_pause_resume_and_budget_with_a_safety_limit(capsys):
    meta = FakeMeta()
    assert ma.main(["pause", "999"], session=meta) == 0
    assert meta.objects["999"]["status"] == "PAUSED"
    assert ma.main(["resume", "999"], session=meta) == 0
    assert meta.objects["999"]["status"] == "ACTIVE"
    assert "paused → active" in capsys.readouterr().out
    assert ma.main(["budget", "999", "15"], session=meta) == 0
    assert meta.objects["999"]["daily_budget"] == "1500"
    assert "$10.00 → $15.00" in capsys.readouterr().out
    assert ma.main(["budget", "999", "500"], session=meta) == 1
    assert meta.objects["999"]["daily_budget"] == "1500"
    assert "safety limit" in capsys.readouterr().out
    assert ma.main(["budget", "999", "500", "--force"], session=meta) == 0
    assert meta.objects["999"]["daily_budget"] == "50000"


def test_several_ad_accounts_need_the_variable(monkeypatch, capsys):
    two = [{"id": "act_1", "name": "A"}, {"id": "act_2", "name": "B"}]
    assert ma.main(["status"], session=FakeMeta(accounts=two)) == 1
    assert "META_AD_ACCOUNT_ID" in capsys.readouterr().out
    monkeypatch.setenv("META_AD_ACCOUNT_ID", "2")
    assert ma.main(["status"], session=FakeMeta(accounts=two)) == 0


def test_network_errors_carry_no_token():
    class Boom:
        def request(self, *a, **k):
            raise ma.requests.ConnectionError(f"https://graph.facebook.com/x?access_token={TOKEN}")
    with pytest.raises(ma.AdsError) as e:
        ma.Api(TOKEN, Boom()).call("GET", "me")
    assert TOKEN not in str(e.value) and e.value.__cause__ is None


def test_an_ad_that_started_today_is_not_a_stalled_campaign():
    # last_7d ends yesterday, so a new ad shows $0 there while it spends.
    import datetime as dt

    class StartedToday(FakeMeta):
        def __init__(self, today_spend, created):
            super().__init__(spend="0")
            self.today_spend, self.created = today_spend, created

        def request(self, method, url, **k):
            if url.endswith("/ads"):
                return Resp({"data": [{"id": "5", "name": "Video", "adset_id": "999",
                                       "effective_status": "ACTIVE", "created_time": self.created}]})
            if url.endswith("/insights") and (k.get("params") or {}).get("date_preset") == "today":
                return Resp({"data": [{"spend": self.today_spend, "reach": "300", "inline_link_clicks": "7"}]})
            return super().request(method, url, **k)

    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+0000")
    assert ma.main(["report"], session=StartedToday("4.10", now)) == 0
    assert len(sent) == 1 and sent[0][0].startswith("📈 Meta ads: today so far $4.10 spent")
    sent.clear()
    # Made today, nothing delivered yet: quiet, not a $0 alarm.
    assert ma.main(["report"], session=StartedToday("0", now)) == 0
    assert sent == []
    # Running for weeks with nothing spent is still reported.
    assert ma.main(["report"], session=StartedToday("0", "2026-09-01T09:00:00-0500")) == 0
    assert len(sent) == 1 and "$0 spent in the last 7 days" in sent[0][0]


def test_a_retired_api_version_is_named_not_blamed_on_the_token(tmp_path, monkeypatch, capsys):
    # Once Meta retires the version, every Marketing API call answers #2635.
    class Retired(FakeMeta):
        def request(self, method, url, **kw):
            self.calls.append((method, url))
            return Resp({"error": {"message": "(#2635) You are calling a deprecated version of the Ads API. "
                                              "Please update to the latest version.", "code": 2635}}, 400)
    out = tmp_path / "gh_output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    assert ma.main(["report", "--scheduled"], session=Retired()) == 1
    printed = capsys.readouterr().out
    assert ma.GRAPH_VERSION in printed and "GRAPH_API_VERSION" in printed
    alert = out.read_text()
    assert alert.startswith("alert=") and ma.GRAPH_VERSION in alert and "token" not in alert


def test_graph_version_comes_from_the_repo_variable_with_a_default(monkeypatch):
    import importlib
    try:
        monkeypatch.setenv("GRAPH_API_VERSION", "")
        assert importlib.reload(ma).GRAPH.endswith("/v23.0")
        monkeypatch.setenv("GRAPH_API_VERSION", "v25.0")
        assert importlib.reload(ma).GRAPH.endswith("/v25.0")
    finally:
        monkeypatch.delenv("GRAPH_API_VERSION")
        importlib.reload(ma)


def test_an_ad_under_a_finished_ad_set_or_campaign_is_not_on():
    # Ads keep reading ACTIVE after their ad set or campaign ends; counting
    # them made a finished boost send "$0 spent ... with 1 ad on" daily.
    class Finished(FakeMeta):
        def __init__(self, adset=None, campaign=None):
            super().__init__(spend="0")
            self.adset, self.campaign = adset or {}, campaign or {}

        def request(self, method, url, **k):
            if url.endswith("/ads"):
                return Resp({"data": [{"id": "5", "name": "Video", "adset_id": "999", "effective_status": "ACTIVE",
                                       "created_time": "2026-09-01T09:00:00-0500"}]})
            if url.endswith("/adsets"):
                return Resp({"data": [{"id": "999", "name": "Victoria", "campaign_id": "1",
                                       "effective_status": "ACTIVE", **self.adset}]})
            if url.endswith("/campaigns"):
                return Resp({"data": [{"id": "1", "name": "Boost", "effective_status": "ACTIVE", **self.campaign}]})
            if url.endswith("/insights"):
                return Resp({"data": [{"spend": "0"}]})
            return super().request(method, url, **k)

    assert ma.main(["report"], session=Finished(adset={"end_time": "2026-09-20T23:59:00-0500"})) == 0
    assert sent == []
    assert ma.main(["report"], session=Finished(campaign={"stop_time": "2026-09-20T23:59:00-0500"})) == 0
    assert sent == []
    assert ma.main(["report"], session=Finished(campaign={"effective_status": "PAUSED"})) == 0
    assert sent == []
    # Still running (end date ahead): a stalled campaign, reported.
    assert ma.main(["report"], session=Finished(adset={"end_time": "2099-01-01T00:00:00-0500"})) == 0
    assert len(sent) == 1 and "1 ad on" in sent[0][0]


def test_a_refused_slack_webhook_fails_the_daily_report(monkeypatch):
    monkeypatch.setattr(ma.slack_notify, "main", lambda args: 2)
    assert ma.main(["report"], session=FakeMeta()) == 2


def test_report_sends_daily_spend_to_the_site_and_adds_the_real_cost(monkeypatch):
    monkeypatch.setenv("ADS_SPEND_SECRET", "s3cret")
    posted = []

    class WithSite(FakeMeta):
        def request(self, method, url, **k):
            if url.startswith(ma.SITE):
                posted.append((url, k))
                return Resp({"ok": True, "yesterday": {"joined": 31, "cost_per_sub": 0.92},
                             "last_7_days": {"joined": 120, "cost_per_sub": 1.05}})
            if url.endswith("/insights") and (k.get("params") or {}).get("time_increment") == 1:
                return Resp({"data": [{"date_start": "2026-10-07", "spend": "28.37", "impressions": "1500",
                                       "inline_link_clicks": "57", "actions": [{"action_type": "lead", "value": "9"}]}]})
            return super().request(method, url, **k)
    assert ma.main(["report"], session=WithSite()) == 0
    [(url, k)] = posted
    assert url == f"{ma.SITE}/api/ads/spend" and k["headers"]["X-Cron-Secret"] == "s3cret"
    days = k["json"]["days"]
    # 30 days ending yesterday (Central); days Meta left out are $0.
    assert len(days) == 30
    assert days[-1]["day"] == (ma.dt.datetime.now(ma.CENTRAL).date() - ma.dt.timedelta(days=1)).isoformat()
    by_day = {d["day"]: d for d in days}
    if "2026-10-07" in by_day:
        assert by_day["2026-10-07"] == {"day": "2026-10-07", "spend": 28.37, "impressions": 1500, "clicks": 57, "leads": 9}
    assert all(d["spend"] == 0 for d in days if d["day"] != "2026-10-07")
    assert TOKEN not in str(k)
    assert "✅ Real, from the site: yesterday: 31 new subscribers ($0.92 each) · last 7 days: 120 new subscribers ($1.05 each)" in sent[0][0]


def test_report_still_goes_out_when_the_site_is_down(monkeypatch, capsys):
    monkeypatch.setenv("ADS_SPEND_SECRET", "s3cret")

    class SiteDown(FakeMeta):
        def request(self, method, url, **k):
            if url.startswith(ma.SITE):
                raise ma.requests.ConnectionError("down")
            return super().request(method, url, **k)
    assert ma.main(["report"], session=SiteDown()) == 0
    assert len(sent) == 1 and "Real" not in sent[0][0]
    assert "Couldn't send ad spend" in capsys.readouterr().out


def test_daily_rows_fill_days_meta_left_out_with_zero():
    class Rows(FakeMeta):
        def request(self, method, url, **k):
            if url.endswith("/insights"):
                return Resp({"data": [{"date_start": "2026-10-07", "spend": "28.37", "impressions": "1500", "inline_link_clicks": "57"}]})
            return super().request(method, url, **k)
    api = ma.Api(TOKEN, Rows())
    rows = ma.daily_rows(api, "act_1", today=ma.dt.date(2026, 10, 9))
    assert [r["day"] for r in rows][:1] == ["2026-09-09"] and rows[-1]["day"] == "2026-10-08"
    assert {r["day"]: r["spend"] for r in rows}["2026-10-07"] == 28.37
    assert {r["day"]: r["spend"] for r in rows}["2026-10-08"] == 0


def test_a_quiet_week_still_sends_the_days(monkeypatch):
    monkeypatch.setenv("ADS_SPEND_SECRET", "s3cret")
    posted = []

    class Quiet(FakeMeta):
        def request(self, method, url, **k):
            if url.startswith(ma.SITE):
                posted.append(k["json"])
                return Resp({"ok": True})
            return super().request(method, url, **k)
    assert ma.main(["report"], session=Quiet(spend="0")) == 0
    assert len(posted) == 1 and len(posted[0]["days"]) == 30


def test_another_town_never_uses_ads_credentials_not_its_own(monkeypatch, capsys):
    monkeypatch.setenv("META_ADS_TOKEN", "tok")
    monkeypatch.setattr(ma, "meta_allowed", lambda **k: False)
    monkeypatch.setattr(ma, "Api", lambda *a, **k: pytest.fail("no Graph call for another town's credentials"))
    assert ma.main(["report", "--scheduled"]) == 0
    assert "aren't" in capsys.readouterr().out
