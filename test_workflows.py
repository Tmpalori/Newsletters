"""The GitHub Actions workflows that are left (JOBS_ON_RAILWAY.md phase 5):
GitHub holds the code and runs the tests; every town's jobs (collect, event
check, submission review, social kit, ads report, digest, newsletter) run on
Railway. Only tests.yml runs on its own, and nothing runs on a schedule."""
import glob
import os

import pytest
import yaml

WF = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".github", "workflows")

# Manual tools (Actions -> Run workflow); the probes also run on a push to a
# claude/* branch that edits them.
MANUAL = {"apify-probe.yml", "gemini-probe.yml", "market-scan.yml"}
RETIRED = ["event-check.yml", "meta-ads.yml", "newsletter.yml", "social-kit.yml", "submission-review.yml",
           "uptime.yml", "weekly-collect.yml", "weekly-digest.yml", "pr-preview.yml", "staging-deploy.yml"]


def load(name):
    with open(os.path.join(WF, name)) as f:
        return yaml.safe_load(f)


def triggers(wf):
    on = wf.get("on", wf.get(True)) or {}
    return on if isinstance(on, dict) else {t: None for t in ([on] if isinstance(on, str) else on)}


def test_only_the_tests_and_the_manual_tools_are_left():
    assert set(os.listdir(WF)) == {"tests.yml"} | MANUAL
    for name in RETIRED:
        assert not os.path.exists(os.path.join(WF, name)), name


@pytest.mark.parametrize("name", sorted(f for f in os.listdir(WF) if f.endswith(".yml")))
def test_every_workflow_parses_and_none_runs_on_a_schedule(name):
    wf = load(name)
    assert wf["jobs"]
    assert "schedule" not in triggers(wf), f"{name}: jobs run on Railway, not on GitHub's cron"


@pytest.mark.parametrize("name", sorted(MANUAL))
def test_manual_tools_run_by_hand(name):
    on = triggers(load(name))
    assert "workflow_dispatch" in on
    assert set(on) <= {"workflow_dispatch", "push"}
    if "push" in on:
        assert on["push"]["branches"] == ["claude/**"]


def test_tests_run_on_prs_and_main():
    on = triggers(load("tests.yml"))
    assert set(on) == {"pull_request", "push"}
    assert on["push"]["branches"] == ["main"]


def test_every_alert_step_also_reports_to_the_site():
    # Each step that posts to the alerts webhook also gives slack_notify.py
    # the site and secret, so the alert lands in the owner inbox (HQ, the
    # owner's assistant). Same secret fallback as server/opsReport.js.
    want_secret = ("${{ secrets.OPS_REPORT_SECRET || secrets.SUBMISSION_REVIEW_SECRET || "
                   "secrets.EVENT_CHECK_SECRET || secrets.NEWSLETTER_CRON_SECRET }}")
    alert_hook = "${{ secrets.SLACK_ALERTS_WEBHOOK_URL || secrets.SLACK_WEBHOOK_URL }}"
    found = 0
    for path in glob.glob(os.path.join(WF, "*.yml")):
        for job in load(os.path.basename(path))["jobs"].values():
            for st in job.get("steps", []):
                env = st.get("env") or {}
                if env.get("SLACK_WEBHOOK_URL") == alert_hook:
                    found += 1
                    assert env.get("OPS_REPORT_SECRET") == want_secret, (path, st.get("name"))
                    assert env.get("OPS_REPORT_URL", "").startswith("${{ vars.SITE_URL"), (path, st.get("name"))
    assert found >= 2      # tests.yml: the Node and the Python suite
