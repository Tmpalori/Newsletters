"""The town's jobs worker (scripts/jobs_worker.py, JOBS_ON_RAILWAY.md): it
claims a job from the site, runs the same script the workflow ran and
reports back; a collect hands its files to the site. The site and the
scripts are faked."""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "scripts"))
import jobs_worker as jw  # noqa: E402


class FakeSite:
    def __init__(self, files=None, jobs=None):
        self.base = "https://www.example.com"
        self.files = dict(files or {})
        self.jobs = list(jobs or [])
        self.finished = []
        self.puts = []

    def claim(self):
        return self.jobs.pop(0) if self.jobs else None

    def finish(self, job_id, status, result):
        self.finished.append((job_id, status, result))

    def get_file(self, name):
        return self.files.get(name)

    def put_file(self, name, data):
        self.puts.append(name)
        self.files[name] = data
        return {"ok": True, "published": {"ok": True}} if name == "candidates" else {"ok": True}


@pytest.fixture
def town_dir(tmp_path, monkeypatch):
    paths = {k: str(tmp_path / f"{k}.json") for k in ("candidates", "collection_metadata", "enrichment_cache")}
    monkeypatch.setattr(jw, "repo_path", lambda key: paths[key])
    return paths


def fake_collector(paths, candidates, meta, code=0):
    calls = []

    def run(args, timeout, env=None):
        calls.append(args)
        assert "--candidates-only" in args          # never writes the curated events.json
        assert json.load(open(paths["enrichment_cache"])) == {"seen": 1}   # the last run's cache came first
        if code == 0:
            json.dump(candidates, open(paths["candidates"], "w"))
            json.dump(meta, open(paths["collection_metadata"], "w"))
            json.dump({"seen": 2}, open(paths["enrichment_cache"], "w"))
        return code, ["…", "done"]
    run.calls = calls
    return run


def test_collect_hands_over_its_files_candidates_last(town_dir):
    site = FakeSite(files={"enrichment_cache": {"seen": 1}})
    cand = {"last_updated": "2026-10-07T14:30:00-05:00", "events": [{"date": "2000-01-01", "name": "A"}, {"date": "2999-01-01", "name": "B"}]}
    meta = {"warnings": {"summary": "1 warning: mona returned 0 events"}, "sources": [{"name": "town_feeds", "count": 120}]}
    status, result = jw.job_collect(site, run=fake_collector(town_dir, cand, meta))
    assert status == "done"
    assert site.puts == ["collection_metadata", "enrichment_cache", "candidates"]
    assert site.files["enrichment_cache"] == {"seen": 2}
    assert result["upcoming"] == 1 and result["events"] == 2
    assert result["warnings"] == "1 warning: mona returned 0 events"
    assert result["sources"] == {"town_feeds": 120}


def test_a_failed_collect_hands_over_nothing(town_dir):
    site = FakeSite(files={"enrichment_cache": {"seen": 1}})
    status, result = jw.job_collect(site, run=fake_collector(town_dir, {}, {}, code=1))
    assert status == "failed" and "code 1" in result["error"] and result["log_tail"]
    assert site.puts == []


def test_submission_review_keeps_its_state_on_the_site(monkeypatch):
    site = FakeSite(files={"review_attempts": {"sub1": 2}})

    def run(args, timeout, env=None):
        assert args[-1] == "scripts/review_submissions.py"
        assert json.load(open(env["REVIEW_ATTEMPTS_STATE"])) == {"sub1": 2}
        assert not os.path.exists(env["AI_ALERT_STATE"])
        json.dump({"sub1": 3}, open(env["REVIEW_ATTEMPTS_STATE"], "w"))
        return 0, ["ok"]
    status, _ = jw.job_submission_review(site, run=run, env={})
    assert status == "done"
    assert site.files["review_attempts"] == {"sub1": 3}
    assert "review_ai_alert" not in site.puts


def test_run_one_reports_every_outcome():
    site = FakeSite()
    assert jw.run_one(site, {"id": 1, "kind": "event-check", "slot": "s"}, run=lambda a, t, e=None: (0, ["fine"])) == "done"
    assert jw.run_one(site, {"id": 2, "kind": "social-kit", "slot": "s"}) == "failed"

    def boom(*a, **k):
        raise RuntimeError("disk full")
    assert jw.run_one(site, {"id": 3, "kind": "event-check", "slot": "s"}, run=boom) == "failed"
    assert [(f[0], f[1]) for f in site.finished] == [(1, "done"), (2, "failed"), (3, "failed")]
    assert "social-kit" in site.finished[1][2]["error"]
    assert "disk full" in site.finished[2][2]["error"]
    assert all("seconds" in f[2] for f in site.finished)


def test_main_needs_the_secret_and_polls(monkeypatch):
    monkeypatch.delenv("JOBS_SECRET", raising=False)
    assert jw.main(site=FakeSite()) == 1
    monkeypatch.setenv("JOBS_SECRET", "s" * 40)
    slept = []
    assert jw.main(site=FakeSite(), sleep=slept.append, once=True) == 0
    assert slept == [30]


def test_run_script_keeps_the_tail_and_stops_at_the_timeout(tmp_path):
    import io
    out = io.StringIO()
    code, tail = jw.run_script([sys.executable, "-c", "print('\\n'.join(str(i) for i in range(100)))"], 30, out=out)
    assert code == 0 and tail[-1] == "99" and len(tail) == jw.LOG_TAIL
    code, tail = jw.run_script([sys.executable, "-c", "import time; time.sleep(5)"], 1, out=out)
    assert code == 124 and "stopped after" in tail[-1]
