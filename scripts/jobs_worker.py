#!/usr/bin/env python3
"""The town's jobs worker (JOBS_ON_RAILWAY.md): its own Railway service,
always on, asking the town's site for work every JOBS_POLL_SECONDS.

The site's scheduler (server/scheduler.js) and Pull Now queue jobs in the
town's database (server/jobs.js); this claims one, runs the same script the
GitHub workflow ran, and reports back. A collect hands its candidates,
collection metadata and enrichment cache to the site instead of committing
them; the site publishes at once.

Jobs:
  collect            collect_events.py --candidates-only (the weekly collect)
  event-check        scripts/sweep_events.py
  submission-review  scripts/review_submissions.py

Environment (on Railway, the secrets are references to the web service's
own variables, so nothing is copied):
  TOWN, SITE_URL      the town and its site (https://www.<domain>)
  JOBS_SECRET         the site's JOBS_SECRET
  JOBS_POLL_SECONDS   default 30
  plus what the scripts read: OPENAI_API_KEY, APIFY_TOKEN, GEMINI_API_KEY,
  EVENT_CHECK_SECRET, SUBMISSION_REVIEW_SECRET, the Slack webhooks...

The worker never posts to Slack itself: the site says "collect done" and
alerts on a failed job, so a job's outcome reaches Slack and the owner
inbox (and HQ) the same way as everything else.
"""
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
from collections import deque
from datetime import date, timedelta

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from town import TOWN, repo_path, site_url, town_paths  # noqa: E402

# How long each script may run (the site gives up a little later, see
# JOB_KINDS in server/jobs.js). The collect's own budget is 50 minutes.
TIMEOUTS = {"collect": 55 * 60, "event-check": 15 * 60, "submission-review": 8 * 60}
LOG_TAIL = 60
HTTP_TIMEOUT = 60


class Site:
    """The town site's jobs API (server/jobs.js)."""

    def __init__(self, base, secret, session=None):
        self.base = base.rstrip("/")
        self.session = session or requests.Session()
        self.headers = {"Authorization": f"Bearer {secret}"}

    def _url(self, path):
        return f"{self.base}{path}"

    def claim(self):
        r = self.session.post(self._url("/api/jobs/claim"), headers=self.headers, timeout=HTTP_TIMEOUT)
        if r.status_code == 204:
            return None
        r.raise_for_status()
        return r.json().get("job")

    def finish(self, job_id, status, result):
        r = self.session.post(self._url(f"/api/jobs/{job_id}/finish"), headers=self.headers,
                              json={"status": status, "result": result}, timeout=HTTP_TIMEOUT)
        r.raise_for_status()

    def get_file(self, name):
        r = self.session.get(self._url(f"/api/jobs/files/{name}"), headers=self.headers, timeout=HTTP_TIMEOUT)
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.json().get("data")

    def put_file(self, name, data):
        r = self.session.put(self._url(f"/api/jobs/files/{name}"), headers=self.headers, json=data, timeout=300)
        r.raise_for_status()
        return r.json()


def run_script(args, timeout, env=None, out=sys.stdout):
    """Run a script, echoing its output (Railway's log) and keeping the tail.
    → (exit code, last LOG_TAIL lines); stopped at `timeout` seconds even
    when it prints nothing, which is exit code 124."""
    tail = deque(maxlen=LOG_TAIL)
    proc = subprocess.Popen(args, cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    timed_out = threading.Event()

    def stop():
        timed_out.set()
        proc.kill()
    watchdog = threading.Timer(timeout, stop)
    watchdog.daemon = True
    watchdog.start()
    try:
        for line in proc.stdout:
            out.write(line)
            tail.append(line.rstrip("\n"))
        code = proc.wait()
    finally:
        watchdog.cancel()
    if timed_out.is_set():
        tail.append(f"[jobs] stopped after {max(1, timeout // 60)} minute(s)")
        return 124, list(tail)
    return code, list(tail)


def _read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _write_json(path, data):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f)


def upcoming(candidates, days=14, today=None):
    """Events in the next `days` days (hand-added ones run 90 days ahead)."""
    end = ((today or date.today()) + timedelta(days=days)).isoformat()
    events = (candidates or {}).get("events") or []
    return sum(1 for e in events if isinstance(e, dict) and str(e.get("date", "")) <= end)


def job_collect(site, run=run_script, env=None):
    paths = {k: repo_path(k) for k in ("candidates", "collection_metadata", "enrichment_cache")}
    cache = site.get_file("enrichment_cache")
    if cache is not None:
        _write_json(paths["enrichment_cache"], cache)
    with tempfile.TemporaryDirectory() as tmp:
        code, tail = run([sys.executable, "-u", "collect_events.py",
                          "--output", os.path.join(tmp, "events.json"),
                          "--candidates", paths["candidates"],
                          "--local-dir", town_paths()["dir"],
                          "--days", "14", "--candidates-only"], TIMEOUTS["collect"], env)
    if code != 0:
        return "failed", {"error": f"The collector exited with code {code}.", "log_tail": tail}
    candidates = _read_json(paths["candidates"])
    if not candidates:
        return "failed", {"error": "The collector wrote no candidates.json.", "log_tail": tail}
    meta = _read_json(paths["collection_metadata"])
    if meta is not None:
        site.put_file("collection_metadata", meta)
    cache = _read_json(paths["enrichment_cache"])
    if cache is not None:
        site.put_file("enrichment_cache", cache)
    published = site.put_file("candidates", candidates).get("published")    # last: it publishes
    sources = {s.get("name"): s.get("count") for s in (meta or {}).get("sources") or [] if isinstance(s, dict)}
    return "done", {
        "upcoming": upcoming(candidates),
        "events": len(candidates.get("events") or []),
        "warnings": ((meta or {}).get("warnings") or {}).get("summary", ""),
        "sources": sources,
        "published": published,
        "log_tail": tail[-15:],
    }


def job_event_check(site, run=run_script, env=None):
    code, tail = run([sys.executable, "scripts/sweep_events.py"], TIMEOUTS["event-check"], env)
    return ("done" if code == 0 else "failed"), ({"log_tail": tail[-15:]} if code == 0 else
                                                 {"error": f"The event check exited with code {code}.", "log_tail": tail})


REVIEW_STATE = {"review_ai_alert": "AI_ALERT_STATE", "review_attempts": "REVIEW_ATTEMPTS_STATE"}


def job_submission_review(site, run=run_script, env=None):
    env = dict(env if env is not None else os.environ)
    with tempfile.TemporaryDirectory() as tmp:
        for name, var in REVIEW_STATE.items():
            env[var] = os.path.join(tmp, f"{name}.json")
            data = site.get_file(name)
            if data is not None:
                _write_json(env[var], data)
        code, tail = run([sys.executable, "scripts/review_submissions.py"], TIMEOUTS["submission-review"], env)
        for name, var in REVIEW_STATE.items():
            data = _read_json(env[var])
            if data is not None:
                site.put_file(name, data)
    return ("done" if code == 0 else "failed"), ({"log_tail": tail[-10:]} if code == 0 else
                                                 {"error": f"The submission review exited with code {code}.", "log_tail": tail})


JOBS = {"collect": job_collect, "event-check": job_event_check, "submission-review": job_submission_review}


def run_one(site, job, run=run_script, clock=time.monotonic):
    """Run a claimed job and report it. → its status."""
    fn = JOBS.get(job.get("kind"))
    started = clock()
    print(f"[jobs] {job.get('kind')} #{job.get('id')} ({job.get('slot')}) started", flush=True)
    if not fn:
        status, result = "failed", {"error": f"This worker doesn't run {job.get('kind')!r} jobs."}
    else:
        try:
            status, result = fn(site, run=run)
        except Exception as e:      # noqa: BLE001 - any failure is reported, never lost
            status, result = "failed", {"error": f"{type(e).__name__}: {e}"}
    result["seconds"] = round(clock() - started)
    site.finish(job["id"], status, result)
    print(f"[jobs] {job.get('kind')} #{job.get('id')}: {status} in {result['seconds']} s", flush=True)
    return status


def main(argv=None, site=None, sleep=time.sleep, once=False):
    secret = os.environ.get("JOBS_SECRET", "").strip()
    if len(secret) < 32:
        print("JOBS_SECRET isn't set (32+ characters, the site's own): nothing to do.", flush=True)
        return 1
    site = site or Site(site_url(), secret)
    poll = int(os.environ.get("JOBS_POLL_SECONDS", "30") or 30)
    stopping = {"now": False}
    signal.signal(signal.SIGTERM, lambda *_: stopping.update(now=True))
    print(f"[jobs] {TOWN['id']}: asking {site.base} for work every {poll} s", flush=True)
    while not stopping["now"]:
        try:
            job = site.claim()
        except requests.RequestException as e:
            print(f"[jobs] the site didn't answer ({e}); trying again", flush=True)
            job = None
        if job:
            run_one(site, job)
        else:
            sleep(poll)
        if once:
            break
    return 0


if __name__ == "__main__":
    sys.exit(main())
