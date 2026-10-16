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
  social-kit         scripts/social_kit.py, then scripts/social_post.py's
                     posting (every town's, Victoria's included)
  meta-ads           scripts/meta_ads.py report --scheduled (the daily ads
                     report; nothing when the town has no ads settings)
  digest             send_digest.py (Sunday night's email of what's
                     collected; nothing without SMTP_EMAIL / SMTP_PASSWORD)

Environment (on Railway, the secrets are references to the web service's
own variables, so nothing is copied):
  TOWN, SITE_URL      the town and its site (https://www.<domain>)
  JOBS_SECRET         the site's JOBS_SECRET
  JOBS_POLL_SECONDS   default 30
  SOCIAL_AUTOPOST     1 lets the social kit post (else it only builds the
                      kit and hands it to the site)
  META_TOWN, META_PAGE_ID, META_PAGE_TOKEN, IG_USER_ID (optional),
  GRAPH_API_VERSION   the town's own Meta settings (town.py meta_allowed)
  META_ADS_TOKEN, META_AD_ACCOUNT_ID (optional) the ads report's; without
                      META_ADS_TOKEN it uses META_PAGE_TOKEN
  ADS_SPEND_SECRET    optional; else SUBMISSION_REVIEW_SECRET (the site's
                      fallback): the ads report sends the daily spend
  SMTP_EMAIL, SMTP_PASSWORD, DIGEST_TO (default the owner's) the digest
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
from contextlib import redirect_stdout
from datetime import date, datetime, timedelta

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from town import TOWN, VICTORIA, meta_allowed, repo_path, site_url, town_paths, tz  # noqa: E402

# How long each script may run (the site gives up a little later, see
# JOB_KINDS in server/jobs.js). The collect's own budget is 50 minutes.
TIMEOUTS = {"collect": 55 * 60, "event-check": 15 * 60, "submission-review": 8 * 60, "social-kit": 10 * 60,
            "meta-ads": 5 * 60, "digest": 5 * 60}
LOG_TAIL = 60
LINE_MAX = 500          # a log line's length in a report (one line can be megabytes)
HTTP_TIMEOUT = 60
RETRY_WAITS = (5, 20, 60)   # a web redeploy takes about a minute

# The script running now, so SIGTERM (a redeploy of this service) can stop it.
CURRENT = {"proc": None, "stopping": False}


def _retry(fn, sleep=None):
    """fn(), tried again after RETRY_WAITS when the site doesn't answer or
    answers 5xx (it redeploys several times a day); a 4xx is final."""
    for wait in (*RETRY_WAITS, None):
        try:
            return fn()
        except requests.HTTPError as e:
            if e.response is not None and e.response.status_code < 500 or wait is None:
                raise
        except requests.RequestException:
            if wait is None:
                raise
        print(f"[jobs] the site didn't answer; trying again in {wait} s", flush=True)
        (sleep or time.sleep)(wait)


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
        def go():
            r = self.session.post(self._url(f"/api/jobs/{job_id}/finish"), headers=self.headers,
                                  json={"status": status, "result": result}, timeout=HTTP_TIMEOUT)
            r.raise_for_status()
        _retry(go)

    def get_file(self, name):
        def go():
            r = self.session.get(self._url(f"/api/jobs/files/{name}"), headers=self.headers, timeout=HTTP_TIMEOUT)
            if r.status_code == 404:
                return None
            r.raise_for_status()
            return r.json().get("data")
        return _retry(go)

    def put_file(self, name, data):
        def go():
            r = self.session.put(self._url(f"/api/jobs/files/{name}"), headers=self.headers, json=data, timeout=300)
            r.raise_for_status()
            return r.json()
        return _retry(go)

    def put_social(self, build, name, body):
        def go():
            r = self.session.put(self._url(f"/api/jobs/social/{build}/{name}"), data=body, timeout=300,
                                 headers={**self.headers, "Content-Type": "application/octet-stream"})
            r.raise_for_status()
            return r.json()
        return _retry(go)

    def publish_social(self, build):
        def go():
            r = self.session.post(self._url(f"/api/jobs/social/{build}/publish"), headers=self.headers, timeout=HTTP_TIMEOUT)
            r.raise_for_status()
            return r.json()
        return _retry(go)


def run_script(args, timeout, env=None, out=sys.stdout):
    """Run a script, echoing its output (Railway's log) and keeping the tail.
    → (exit code, last LOG_TAIL lines, each at most LINE_MAX characters);
    stopped at `timeout` seconds even when it prints nothing (exit code
    124), and with everything it started (its own process group)."""
    tail = deque(maxlen=LOG_TAIL)
    proc = subprocess.Popen(args, cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, errors="replace", bufsize=1, start_new_session=True)
    CURRENT["proc"] = proc
    timed_out = threading.Event()

    def kill():
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass

    def stop():
        timed_out.set()
        kill()
    watchdog = threading.Timer(timeout, stop)
    watchdog.daemon = True
    watchdog.start()
    try:
        for line in proc.stdout:
            out.write(line)
            tail.append(line.rstrip("\n")[:LINE_MAX])
        code = proc.wait()
    finally:
        watchdog.cancel()
        if proc.poll() is None:
            kill()
            proc.wait()
        CURRENT["proc"] = None
    if timed_out.is_set():
        tail.append(f"[jobs] stopped after {max(1, timeout // 60)} minute(s)")
        return 124, list(tail)
    if CURRENT["stopping"]:
        tail.append("[jobs] stopped: this jobs service is redeploying")
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


class _Tee:
    """Echo to the log and keep the tail (the in-process post's output)."""

    def __init__(self, out):
        self.out, self.tail, self._buf = out, deque(maxlen=LOG_TAIL), ""

    def write(self, text):
        self.out.write(text)
        self._buf += text
        *lines, self._buf = self._buf.split("\n")
        self.tail.extend(line[:LINE_MAX] for line in lines)
        return len(text)

    def flush(self):
        self.out.flush()


def social_plan(today):
    """(kits to build, kit to post, also post "today" when it has a paid
    pick) for a day, as social-kit.yml does: Monday builds the week, the
    weekend and today and posts the week; Thursday builds the weekend and
    today and posts the weekend (and today with a paid pick); other days
    today."""
    dow = today.isoweekday()
    if dow == 1:
        return ["week", "weekend", "today"], "week", False
    if dow == 4:
        return ["weekend", "today"], "weekend", True
    return ["today"], "today", False


SOCIAL_SKIP = {"reel.txt", "posted.json"}


def job_social_kit(site, run=run_script, env=None, post=None, today=None, session=None):
    """Build the day's kit, hand every file to the site (which serves it at
    /social/latest/ and keeps only the latest), then, with SOCIAL_AUTOPOST=1,
    post it with scripts/social_post.py's own code. What went out is kept
    on the site (social_posted) and saved before each publish call, so a
    retry or a restart never posts twice."""
    env = dict(env if env is not None else os.environ)
    today = today or datetime.now(tz()).date()
    kinds, post_kind, extra_today = social_plan(today)
    build = f"w{int(time.time())}-{os.getpid()}"
    env["SOCIAL_BUILD"] = build
    with tempfile.TemporaryDirectory() as kit_dir:
        code, tail = run([sys.executable, "-u", "scripts/social_kit.py", "--out", kit_dir, "--kinds", ",".join(kinds),
                          "--today", today.isoformat()], TIMEOUTS["social-kit"], env)
        if code != 0:
            return "failed", {"error": f"The social kit build exited with code {code}.", "log_tail": tail}
        manifest = _read_json(os.path.join(kit_dir, "kit.json"))
        if not manifest or manifest.get("build") != build:
            return "failed", {"error": "The social kit build wrote no kit.json for this run.", "log_tail": tail}
        names = sorted(n for n in os.listdir(kit_dir) if n not in SOCIAL_SKIP and os.path.isfile(os.path.join(kit_dir, n)))
        names.sort(key=lambda n: n == "kit.json")      # the manifest last
        size = 0
        for name in names:
            with open(os.path.join(kit_dir, name), "rb") as f:
                body = f.read()
            size += len(body)
            site.put_social(build, name, body)
        site.publish_social(build)
        outreach = ""
        if "week" in kinds:
            try:
                with open(os.path.join(kit_dir, "outreach-slack.txt")) as f:
                    outreach = f.read().strip()
            except OSError:
                pass
        result = {"kinds": kinds, "files": len(names), "bytes": size, "build": build,
                  "events": {k: (manifest.get("kits", {}).get(k) or {}).get("events") for k in kinds},
                  "log_tail": tail[-8:]}
        if outreach:
            result["outreach"] = outreach
        if env.get("SOCIAL_AUTOPOST", "").strip() != "1":
            result["posted"] = "off (SOCIAL_AUTOPOST isn't 1)"
            return "done", result
        # Switched on but not set up right: say so (social_post.py would
        # quietly skip), so the owner hears it instead of seeing no posts.
        problem = social_settings_problem(env)
        if problem:
            return "failed", {**result, "error": f"SOCIAL_AUTOPOST is 1 but {problem}; the kit is on the site, nothing was posted."}
        posted = site.get_file("social_posted")
        if isinstance(posted, dict):
            _write_json(os.path.join(kit_dir, "posted.json"), posted)
        post = post or _social_post_main
        tee = _Tee(sys.stdout)
        codes = []
        saved_env = {k: os.environ.get(k) for k in env}
        os.environ.update(env)          # social_post reads its Meta settings from the environment
        try:
            with redirect_stdout(tee):
                save = lambda data: site.put_file("social_posted", data)
                codes.append(post(["--kind", post_kind, "--kit-dir", kit_dir], session=session, on_save=save))
                if extra_today:
                    codes.append(post(["--kind", "today", "--if-featured", "--kit-dir", kit_dir], session=session, on_save=save))
        except Exception as e:      # noqa: BLE001 - reported as the job's failure
            codes.append(1)
            tee.write(f"::error::{type(e).__name__}: {e}\n")
        finally:
            for k, v in saved_env.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        result["post_log"] = list(tee.tail)[-15:]
        if any(codes):
            errors = [line.replace("::error::", "") for line in tee.tail if line.startswith("::error::")]
            return "failed", {**result, "error": "Posting failed: " + ("; ".join(errors)[:600] or "see the log."),
                              "log_tail": list(tee.tail)}
        result["posted"] = post_kind + (" (+ today if it had a paid pick)" if extra_today else "")
        return "done", result


def social_settings_problem(env):
    """Why the town's Meta settings can't post, or None."""
    if not env.get("META_PAGE_ID", "").strip() or not env.get("META_PAGE_TOKEN", "").strip():
        return "META_PAGE_ID or META_PAGE_TOKEN isn't set on the jobs service"
    if not meta_allowed(env=env):
        where = "town.py VICTORIA" if TOWN["id"] == VICTORIA["id"] else f"towns/{TOWN['id']}/town.json"
        return (f"the Meta settings aren't {TOWN['id']}'s own (META_TOWN={TOWN['id']} and the page id"
                f"{' and Instagram id' if env.get('IG_USER_ID', '').strip() else ''} pinned in {where})")
    return None


def _ads_env(env):
    """meta-ads.yml's settings: the ads token, else the Page token; the
    spend secret, else the submission review secret (the site's fallback)."""
    env = dict(env)
    if not env.get("META_ADS_TOKEN", "").strip() and env.get("META_PAGE_TOKEN", "").strip():
        env["META_ADS_TOKEN"] = env["META_PAGE_TOKEN"]
    if not env.get("ADS_SPEND_SECRET", "").strip() and env.get("SUBMISSION_REVIEW_SECRET", "").strip():
        env["ADS_SPEND_SECRET"] = env["SUBMISSION_REVIEW_SECRET"]
    env.pop("GITHUB_OUTPUT", None)
    return env


def job_meta_ads(site, run=run_script, env=None):
    """The daily ads report (meta-ads.yml's scheduled run). The report goes
    back to the site, which posts it to Slack; a town without its own ads
    settings does nothing (done, with why). A dead token, lost account
    access or a retired API version fails the job, which alerts."""
    env = _ads_env(env if env is not None else os.environ)
    pins = TOWN.get("meta") if isinstance(TOWN.get("meta"), dict) else {}
    if not env.get("META_ADS_TOKEN", "").strip():
        return "done", {"skipped": "no ads settings (META_ADS_TOKEN / META_PAGE_TOKEN isn't set)"}
    if not meta_allowed(env=env, use="ads"):
        if TOWN["id"] != VICTORIA["id"] and not str(pins.get("ad_account_id") or "").strip():
            return "done", {"skipped": f"no ad account pinned for {TOWN['id']} (\"meta\".ad_account_id)"}
        return "failed", {"error": f"The Meta ads settings on the jobs service aren't {TOWN['id']}'s own "
                                   "(META_TOWN and the ad account its settings pin); no report."}
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "report.json")
        code, tail = run([sys.executable, "-u", "scripts/meta_ads.py", "report", "--scheduled", "--result", out],
                         TIMEOUTS["meta-ads"], env)
        got = _read_json(out) or {}
    if code != 0:
        errors = [line.replace("::error::", "") for line in tail if line.startswith("::error::")]
        return "failed", {"error": "Meta ads daily check failed: " + ("; ".join(errors)[:600] or "token or ad account access?"),
                          "log_tail": tail}
    result = {"log_tail": tail[-8:]}
    if got.get("report"):
        result["report"] = str(got["report"])
        result["link"] = got.get("link")
    return "done", result


DIGEST_TO = "tristen.m.palori@gmail.com"


def job_digest(site, run=run_script, env=None, session=None):
    """Sunday night's digest of what's collected (weekly-digest.yml), from
    the site's live list, mailed to the owner. Without SMTP settings on the
    jobs service it does nothing (done, with why)."""
    env = dict(env if env is not None else os.environ)
    if not env.get("SMTP_EMAIL", "").strip() or not env.get("SMTP_PASSWORD", "").strip():
        return "done", {"skipped": "SMTP_EMAIL / SMTP_PASSWORD aren't set on the jobs service"}
    env.setdefault("SMTP_HOST", "smtp.gmail.com")
    env.setdefault("SMTP_PORT", "587")
    session = session or requests.Session()
    def fetch():
        r = session.get(f"{site_url()}/events.json?all=1", timeout=HTTP_TIMEOUT)
        r.raise_for_status()
        return r.json()
    events = _retry(fetch)
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "live-events.json")
        _write_json(path, events)
        code, tail = run([sys.executable, "-u", "send_digest.py", "--candidates", path,
                          "--to", env.get("DIGEST_TO", "").strip() or DIGEST_TO, "--all-days"], TIMEOUTS["digest"], env)
    if code != 0:
        return "failed", {"error": f"The digest email exited with code {code}.", "log_tail": tail}
    return "done", {"events": len((events or {}).get("events") or []), "log_tail": tail[-5:]}


def _social_post_main(argv, session=None, on_save=None):
    sys.path.insert(0, os.path.join(ROOT, "scripts"))
    import social_post
    return social_post.main(argv, session=session, on_save=on_save)


JOBS = {"social-kit": job_social_kit, "collect": job_collect, "event-check": job_event_check, "submission-review": job_submission_review,
        "meta-ads": job_meta_ads, "digest": job_digest}


def run_one(site, job, run=run_script, clock=time.monotonic):
    """Run a claimed job and report it. → its status. A run cut short by a
    redeploy says so (the site queues it again, quietly)."""
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
    if CURRENT["stopping"] and status == "failed":
        result["interrupted"] = True
    try:
        site.finish(job["id"], status, result)
    except requests.RequestException as e:
        # The site expires the run later and queues it again.
        print(f"[jobs] couldn't report {job.get('kind')} #{job.get('id')} ({e})", flush=True)
    print(f"[jobs] {job.get('kind')} #{job.get('id')}: {status} in {result['seconds']} s", flush=True)
    return status


def main(argv=None, site=None, sleep=time.sleep, once=False):
    secret = os.environ.get("JOBS_SECRET", "").strip()
    if len(secret) < 32:
        print("JOBS_SECRET isn't set (32+ characters, the site's own): nothing to do.", flush=True)
        return 1
    site = site or Site(site_url(), secret)
    poll = int(os.environ.get("JOBS_POLL_SECONDS", "30") or 30)
    def on_term(*_):
        CURRENT["stopping"] = True
        proc = CURRENT["proc"]
        if proc and proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                pass
    signal.signal(signal.SIGTERM, on_term)
    print(f"[jobs] {TOWN['id']}: asking {site.base} for work every {poll} s", flush=True)
    while not CURRENT["stopping"]:
        try:
            job = site.claim()
        except requests.RequestException as e:
            print(f"[jobs] the site didn't answer ({e}); trying again", flush=True)
            job = None
        if job:
            try:
                run_one(site, job)
            except Exception as e:      # noqa: BLE001 - the worker never dies of one job
                print(f"[jobs] {job.get('kind')} #{job.get('id')} broke the worker loop: {e}", flush=True)
        else:
            sleep(poll)
        if once:
            break
    return 0


if __name__ == "__main__":
    sys.exit(main())
