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


class Resp:
    def __init__(self, code, body=None):
        self.status_code, self._body = code, body or {}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise jw.requests.HTTPError(f"{self.status_code}", response=self)

    def json(self):
        return self._body


class Session:
    def __init__(self, codes):
        self.codes = list(codes)
        self.calls = 0

    def _next(self, *a, **k):
        self.calls += 1
        code = self.codes.pop(0)
        if code is None:
            raise jw.requests.ConnectionError("reset")
        return Resp(code, {"ok": True})
    post = put = get = _next


def test_reports_and_uploads_wait_out_a_redeploy_but_not_a_refusal(monkeypatch):
    monkeypatch.setattr(jw.time, "sleep", lambda s: None)
    site = jw.Site("https://x.example", "s" * 40, session=Session([502, None, 200]))
    site.finish(1, "done", {})
    assert site.session.calls == 3
    site = jw.Site("https://x.example", "s" * 40, session=Session([404]))
    with pytest.raises(jw.requests.HTTPError):
        site.finish(1, "done", {})
    assert site.session.calls == 1
    site = jw.Site("https://x.example", "s" * 40, session=Session([503, 200]))
    assert site.put_file("candidates", {}) == {"ok": True}


def test_a_report_the_site_refuses_doesnt_stop_the_worker():
    class Refusing(FakeSite):
        def finish(self, *a):
            raise jw.requests.HTTPError("404")
    assert jw.run_one(Refusing(), {"id": 1, "kind": "event-check", "slot": "s"}, run=lambda a, t, e=None: (0, [])) == "done"


def test_run_script_caps_lines_survives_odd_bytes_and_stops_what_it_started(tmp_path):
    import io
    import time as _t
    out = io.StringIO()
    code, tail = jw.run_script([sys.executable, "-c", "import sys; sys.stdout.buffer.write(b'x' * 5000 + b'\\n\\xff\\xfe bad\\n')"], 30, out=out)
    assert code == 0 and len(tail[0]) == jw.LINE_MAX and "bad" in tail[1]
    marker = tmp_path / "alive"
    child = f"import time; time.sleep(4); open({str(marker)!r}, 'w').write('x')"
    started = _t.monotonic()
    code, tail = jw.run_script([sys.executable, "-c", f"import subprocess, sys, time; subprocess.Popen([sys.executable, '-c', {child!r}]); time.sleep(30)"], 1, out=out)
    assert code == 124 and _t.monotonic() - started < 10
    _t.sleep(4.5)
    assert not marker.exists()          # the grandchild went with it
