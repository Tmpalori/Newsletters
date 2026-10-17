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
    today = jw.datetime.now(jw.tz()).date().isoformat()
    cand = {"last_updated": "2026-10-07T14:30:00-05:00", "events": [
        {"date": "2000-01-01", "name": "A"}, {"date": today, "name": "B"}, {"date": "2999-01-01", "name": "C"}]}
    meta = {"warnings": {"summary": "1 warning: mona returned 0 events"}, "sources": [{"name": "town_feeds", "count": 120}]}
    status, result = jw.job_collect(site, run=fake_collector(town_dir, cand, meta))
    assert status == "done"
    assert site.puts == ["collection_metadata", "enrichment_cache", "candidates"]
    assert site.files["enrichment_cache"] == {"seen": 2}
    assert result["upcoming"] == 1 and result["events"] == 3   # the past day and the far one are not counted
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
    assert jw.run_one(site, {"id": 2, "kind": "nope", "slot": "s"}) == "failed"

    def boom(*a, **k):
        raise RuntimeError("disk full")
    assert jw.run_one(site, {"id": 3, "kind": "event-check", "slot": "s"}, run=boom) == "failed"
    assert [(f[0], f[1]) for f in site.finished] == [(1, "done"), (2, "failed"), (3, "failed")]
    assert "nope" in site.finished[1][2]["error"]
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


def test_reading_a_file_waits_out_a_redeploy_and_a_missing_one_is_none(monkeypatch):
    monkeypatch.setattr(jw.time, "sleep", lambda s: None)
    site = jw.Site("https://x.example", "s" * 40, session=Session([502, None, 200]))
    assert site.get_file("enrichment_cache") is None         # the fake answers {"ok": true}: no data
    assert site.session.calls == 3                              # 502, a dropped connection, then 200
    site = jw.Site("https://x.example", "s" * 40, session=Session([404]))
    assert site.get_file("candidates") is None and site.session.calls == 1


# ─── The social kit on the worker (JOBS_ON_RAILWAY.md 2b) ───────────────────
# Another town's kit is built, handed to its site and, with SOCIAL_AUTOPOST=1,
# posted with social_post.py's own code. Meta is faked: nothing is posted.

import importlib  # noqa: E402
from datetime import date as _date  # noqa: E402

import requests  # noqa: E402

MEDFORD_PAGE = "1444476842072503"


@pytest.fixture
def medford(monkeypatch):
    """jobs_worker and social_post reloaded as Medford; Victoria put back after."""
    import town as town_mod
    monkeypatch.setenv("TOWN", "medford")
    monkeypatch.delenv("SITE_URL", raising=False)
    for name in ("META_PAGE_ID", "META_PAGE_TOKEN", "IG_USER_ID", "META_TOWN", "SOCIAL_AUTOPOST"):
        monkeypatch.delenv(name, raising=False)
    importlib.reload(town_mod)
    import social_post
    importlib.reload(social_post)
    monkeypatch.setattr(social_post, "RETRY_DELAYS", (0, 0))
    importlib.reload(jw)
    yield jw, social_post
    monkeypatch.delenv("TOWN")
    importlib.reload(town_mod)
    importlib.reload(social_post)
    importlib.reload(jw)


class _Resp:
    def __init__(self, body=None, status=200, raw=b""):
        self._body, self.status_code, self.ok, self.text = body, status, status < 400, json.dumps(body)

    def json(self):
        return self._body


class SocialSite(FakeSite):
    """A town site that keeps the uploaded kit and serves the published one."""

    def __init__(self, files=None):
        super().__init__(files=files)
        self.builds, self.live, self.uploads, self.posted_saves = {}, None, [], []

    def put_social(self, build, name, body):
        self.uploads.append(name)
        self.builds.setdefault(build, {})[name] = body
        return {"ok": True}

    def publish_social(self, build):
        self.live = build
        return {"ok": True}

    def put_file(self, name, data):
        if name == "social_posted":
            self.posted_saves.append(json.loads(json.dumps(data)))
        return super().put_file(name, data)


class Meta:
    """Graph calls recorded and answered; the site's /social/latest/ read from
    the SocialSite (social_post waits for the kit there)."""

    def __init__(self, site, raise_on=None):
        self.site, self.calls, self.raise_on = site, [], raise_on or {}

    def request(self, method, url, data=None, params=None, timeout=None, headers=None):
        path = url.split("/", 4)[-1]
        self.calls.append((method, path))
        for suffix, exc in self.raise_on.items():
            if path.endswith(suffix):
                raise exc
        if method == "GET" and (params or {}).get("fields") == "access_token":
            return _Resp({"id": path})
        if path.endswith("/photos") or path.endswith("/media"):
            return _Resp({"id": f"id{len(self.calls)}"})
        if path.endswith("/feed") or path.endswith("/media_publish"):
            return _Resp({"id": "post1"})
        return _Resp({"status_code": "FINISHED"})

    def _live(self, url):
        name = url.split("/social/latest/")[-1].split("?")[0]
        return (self.site.builds.get(self.site.live) or {}).get(name)

    def get(self, url, timeout=None):
        body = self._live(url)
        return _Resp(json.loads(body) if body else {}, 200 if body else 404)

    def head(self, url, timeout=None):
        return _Resp(None, 200 if self._live(url) else 404)


def fake_kit_build(kinds_seen, featured=0):
    """Stands in for social_kit.py: writes a kit for the kinds asked."""
    def run(args, timeout, env=None):
        out = args[args.index("--out") + 1]
        kinds = args[args.index("--kinds") + 1].split(",")
        kinds_seen.append(kinds)
        kits = {}
        for k in kinds:
            for ext in ("png", "jpg"):
                with open(os.path.join(out, f"{k}-1.{ext}"), "wb") as f:
                    f.write(b"IMG")
            kits[k] = {"slides": [f"{k}-1.png"], "slides_jpg": [f"{k}-1.jpg"], "events": 4,
                       "featured": featured if k == "today" else 0,
                       "captions": {"facebook": f"{k} in Medford", "instagram": f"{k} IG"}}
        with open(os.path.join(out, "kit.json"), "w") as f:
            json.dump({"generated_for": "2026-10-15", "build": env["SOCIAL_BUILD"], "kits": kits}, f)
        with open(os.path.join(out, "outreach-slack.txt"), "w") as f:
            f.write("📣 venues" if "week" in kinds else "")
        with open(os.path.join(out, "reel.txt"), "w") as f:
            f.write("leftover")
        return 0, ["built"]
    return run


POSTING = {"SOCIAL_AUTOPOST": "1", "META_TOWN": "medford", "META_PAGE_ID": MEDFORD_PAGE, "META_PAGE_TOKEN": "tok"}
THU, MON, TUE = _date(2026, 10, 15), _date(2026, 10, 12), _date(2026, 10, 13)


def test_social_plan_follows_the_github_days():
    assert jw.social_plan(MON) == (["week", "weekend", "today"], "week", False)
    assert jw.social_plan(THU) == (["weekend", "today"], "weekend", True)
    assert jw.social_plan(TUE) == (["today"], "today", False)


VIC_PAGE = "1388965530960534"


@pytest.fixture
def victoria(monkeypatch):
    """jobs_worker and social_post reloaded as Victoria (TOWN unset), with no
    Meta settings from the environment."""
    import town as town_mod
    monkeypatch.delenv("TOWN", raising=False)
    monkeypatch.delenv("SITE_URL", raising=False)
    for name in ("META_PAGE_ID", "META_PAGE_TOKEN", "IG_USER_ID", "META_TOWN", "SOCIAL_AUTOPOST"):
        monkeypatch.delenv(name, raising=False)
    importlib.reload(town_mod)
    import social_post
    importlib.reload(social_post)
    monkeypatch.setattr(social_post, "RETRY_DELAYS", (0, 0))
    importlib.reload(jw)
    yield jw, social_post
    importlib.reload(town_mod)
    importlib.reload(social_post)
    importlib.reload(jw)


VIC_POSTING = {"SOCIAL_AUTOPOST": "1", "META_TOWN": "victoria", "META_PAGE_ID": VIC_PAGE, "META_PAGE_TOKEN": "tok"}


def test_victorias_kit_runs_on_her_worker_and_posts_to_her_pinned_page(victoria):
    w, _ = victoria
    site = SocialSite()
    meta = Meta(site)
    status, result = w.job_social_kit(site, run=fake_kit_build([]), env=VIC_POSTING, today=TUE, session=meta)
    assert status == "done", result
    assert site.live == result["build"]
    assert ("POST", f"{VIC_PAGE}/feed") in meta.calls
    assert not any("media" in p for _, p in meta.calls)                       # no Instagram id pinned: Facebook only
    assert site.files["social_posted"] == {"2026-10-15:today": {"facebook": "post1"}}


@pytest.mark.parametrize("env", [
    {**VIC_POSTING, "META_PAGE_ID": MEDFORD_PAGE},       # another town's page on a service left as Victoria
    {**VIC_POSTING, "META_TOWN": "medford"},
])
def test_victorias_worker_never_posts_with_another_towns_settings(victoria, env):
    w, _ = victoria
    site = SocialSite()
    meta = Meta(site)
    status, result = w.job_social_kit(site, run=fake_kit_build([]), env=env, today=TUE, session=meta)
    assert status == "failed" and "aren't victoria's own" in result["error"] and "town.py VICTORIA" in result["error"]
    assert meta.calls == []


def test_switch_day_never_posts_what_github_already_did(victoria):
    """The site seeds social_posted from git's docs/social/latest/posted.json
    (server/jobs.js seeds), so the first worker run skips a slot GitHub posted."""
    w, _ = victoria
    site = SocialSite(files={"social_posted": {"2026-10-15:today": {"facebook": f"{VIC_PAGE}_122111655801492266"}}})
    meta = Meta(site)
    status, _ = w.job_social_kit(site, run=fake_kit_build([]), env=VIC_POSTING, today=TUE, session=meta)
    assert status == "done"
    assert not any(p.endswith("/feed") for _, p in meta.calls)


# ─── the ads report and the digest ───────────────────────────────────────

def fake_ads(report=None, code=0, tail=None):
    calls = []

    def run(args, timeout, env=None):
        calls.append((args, env))
        assert args[1:5] == ["-u", "scripts/meta_ads.py", "report", "--scheduled"]
        if report is not None:
            json.dump({"report": report, "link": "https://adsmanager.facebook.com/x"}, open(args[args.index("--result") + 1], "w"))
        return code, tail or ["ok"]
    run.calls = calls
    return run


def test_victorias_ads_report_runs_on_her_page_token_and_goes_back_to_the_site(victoria):
    w, _ = victoria
    run = fake_ads("📈 Meta ads: yesterday $5")
    status, result = w.job_meta_ads(FakeSite(), run=run, env={"META_PAGE_ID": VIC_PAGE, "META_PAGE_TOKEN": "tok", "SUBMISSION_REVIEW_SECRET": "r" * 40})
    assert status == "done" and result["report"] == "📈 Meta ads: yesterday $5" and result["link"]
    env = run.calls[0][1]
    assert env["META_ADS_TOKEN"] == "tok" and env["ADS_SPEND_SECRET"] == "r" * 40     # meta-ads.yml's fallbacks


def test_ads_report_quiet_week_and_failures(victoria):
    w, _ = victoria
    status, result = w.job_meta_ads(FakeSite(), run=fake_ads(""), env={"META_PAGE_TOKEN": "tok"})
    assert status == "done" and "report" not in result
    status, result = w.job_meta_ads(FakeSite(), run=fake_ads(code=1, tail=["::error::Meta refused API version v19.0"]), env={"META_PAGE_TOKEN": "tok"})
    assert status == "failed" and "v19.0" in result["error"]
    # The real cause is named, not blamed on the token.
    several = "::error::The token sees several ad accounts and none is chosen: A (act_1), B (act_2). Set META_AD_ACCOUNT_ID ..."
    status, result = w.job_meta_ads(FakeSite(), run=fake_ads(code=1, tail=["…", several]), env={"META_PAGE_TOKEN": "tok"})
    assert status == "failed" and "several ad accounts" in result["error"] and "token or ad account" not in result["error"]
    # A crash (no ::error:: line): its last line, not a guess.
    crash = ["Traceback (most recent call last):", "KeyError: 'spend'", ""]
    status, result = w.job_meta_ads(FakeSite(), run=fake_ads(code=1, tail=crash), env={"META_PAGE_TOKEN": "tok"})
    assert status == "failed" and result["error"] == "Meta ads daily check failed: KeyError: 'spend'"
    status, result = w.job_meta_ads(FakeSite(), run=fake_ads("x"), env={"META_PAGE_TOKEN": "tok", "META_PAGE_ID": MEDFORD_PAGE})
    assert status == "failed" and "aren't victoria's own" in result["error"]


def test_ads_report_is_a_clean_no_op_without_ads_settings(medford, monkeypatch):
    w, _ = medford
    run = fake_ads("x")
    # No token at all.
    assert w.job_meta_ads(FakeSite(), run=run, env={}) == ("done", {"skipped": "no ads settings (META_ADS_TOKEN / META_PAGE_TOKEN isn't set)"})
    # Its page token for posting, and the shared ad account pinned in its
    # town.json, but not yet on the jobs service: names the variable.
    status, result = w.job_meta_ads(FakeSite(), run=run, env=POSTING)
    assert status == "failed" and "META_AD_ACCOUNT_ID=act_2614503002399063" in result["error"]
    # No ad account pinned in its town.json: nothing to do.
    monkeypatch.setitem(w.TOWN, "meta", {"page_id": MEDFORD_PAGE})
    status, result = w.job_meta_ads(FakeSite(), run=run, env=POSTING)
    assert status == "done" and "no ad account pinned" in result["skipped"]
    assert run.calls == []


class DigestSession:
    def __init__(self, body):
        self.body, self.urls = body, []

    def get(self, url, timeout=None):
        self.urls.append(url)
        r = _Resp(self.body)
        r.raise_for_status = lambda: None
        return r


def test_digest_mails_the_live_list_and_is_quiet_without_smtp(victoria):
    w, _ = victoria
    calls = []

    def run(args, timeout, env=None):
        calls.append(args)
        assert json.load(open(args[args.index("--candidates") + 1]))["events"] == [{"name": "E"}]
        return 0, ["sent"]
    assert w.job_digest(FakeSite(), run=run, env={})[0] == "done" and calls == []
    sess = DigestSession({"events": [{"name": "E"}]})
    status, result = w.job_digest(FakeSite(), run=run, env={"SMTP_EMAIL": "a@b.c", "SMTP_PASSWORD": "p"}, session=sess)
    assert status == "done" and result["events"] == 1
    assert sess.urls == ["https://www.thevic361.com/events.json?all=1"]
    assert calls[0][2:] == ["send_digest.py", "--candidates", calls[0][4], "--to", "tristen.m.palori@gmail.com", "--all-days"]
    status, _ = w.job_digest(FakeSite(), run=lambda a, t, e=None: (1, ["SMTP auth failed"]),
                             env={"SMTP_EMAIL": "a@b.c", "SMTP_PASSWORD": "p"}, session=sess)
    assert status == "failed"
    # The site's Resend key is enough on its own.
    status, _ = w.job_digest(FakeSite(), run=run, env={"RESEND_API_KEY": "re_x"}, session=sess)
    assert status == "done" and len(calls) == 2


def test_builds_and_hands_over_the_kit_without_posting_when_autopost_is_off(medford):
    w, _ = medford
    site, seen = SocialSite(), []
    meta = Meta(site)
    status, result = w.job_social_kit(site, run=fake_kit_build(seen), env={**POSTING, "SOCIAL_AUTOPOST": "0"}, today=MON, session=meta)
    assert status == "done" and seen == [["week", "weekend", "today"]]
    assert site.uploads[-1] == "kit.json" and "reel.txt" not in site.uploads
    assert {"week-1.png", "week-1.jpg", "today-1.jpg", "outreach-slack.txt"} <= set(site.uploads)
    assert site.live == result["build"]
    assert result["outreach"] == "📣 venues" and "off" in result["posted"]
    assert meta.calls == [] and site.posted_saves == []


def test_posts_to_the_towns_page_facebook_only_and_saves_before_publishing(medford):
    w, _ = medford
    site = SocialSite()
    meta = Meta(site)
    status, result = w.job_social_kit(site, run=fake_kit_build([]), env=POSTING, today=TUE, session=meta)
    assert status == "done", result
    assert ("POST", f"{MEDFORD_PAGE}/feed") in meta.calls
    assert not any("media" in p for _, p in meta.calls)                       # no Instagram id: Facebook only
    # "pending" reached the site before the publish call, then the post id.
    assert site.posted_saves[0] == {"2026-10-15:today": {"facebook": "pending"}}
    assert site.files["social_posted"] == {"2026-10-15:today": {"facebook": "post1"}}


def test_a_retry_or_restart_never_posts_twice(medford):
    w, _ = medford
    site = SocialSite()
    assert w.job_social_kit(site, run=fake_kit_build([]), env=POSTING, today=TUE, session=Meta(site))[0] == "done"
    again = Meta(site)
    status, _ = w.job_social_kit(site, run=fake_kit_build([]), env=POSTING, today=TUE, session=again)
    assert status == "done"
    assert not any(p.endswith("/feed") for _, p in again.calls)


def test_a_publish_that_may_have_gone_out_is_never_retried(medford):
    w, _ = medford
    site = SocialSite()
    status, result = w.job_social_kit(site, run=fake_kit_build([]), env=POSTING, today=TUE,
                                      session=Meta(site, raise_on={"/feed": requests.ReadTimeout()}))
    assert status == "failed" and "may have posted" in result["error"]
    assert site.files["social_posted"] == {"2026-10-15:today": {"facebook": "pending"}}
    retry = Meta(site)
    assert w.job_social_kit(site, run=fake_kit_build([]), env=POSTING, today=TUE, session=retry)[0] == "done"
    assert not any(p.endswith("/feed") for _, p in retry.calls)


def test_nothing_is_published_when_the_pending_mark_cant_be_saved(medford):
    w, _ = medford

    class Down(SocialSite):
        def put_file(self, name, data):
            raise requests.ConnectionError("site down")
    site = Down()
    meta = Meta(site)
    status, result = w.job_social_kit(site, run=fake_kit_build([]), env=POSTING, today=TUE, session=meta)
    assert status == "failed" and "couldn't save" in result["error"]
    assert not any(p.endswith("/feed") for _, p in meta.calls)


def test_thursday_posts_the_weekend_and_today_only_with_a_paid_pick(medford):
    w, _ = medford
    site = SocialSite()
    meta = Meta(site)
    assert w.job_social_kit(site, run=fake_kit_build([]), env=POSTING, today=THU, session=meta)[0] == "done"
    assert sorted(site.files["social_posted"]) == ["2026-10-15:weekend"]
    site2 = SocialSite()
    assert w.job_social_kit(site2, run=fake_kit_build([], featured=1), env=POSTING, today=THU, session=Meta(site2))[0] == "done"
    assert sorted(site2.files["social_posted"]) == ["2026-10-15:today", "2026-10-15:weekend"]


@pytest.mark.parametrize("env, why", [
    ({**POSTING, "META_TOWN": ""}, "aren't medford's own"),
    ({**POSTING, "META_PAGE_ID": "999"}, "aren't medford's own"),          # Victoria's page, say
    ({**POSTING, "IG_USER_ID": "777"}, "Instagram id"),                    # an Instagram id medford doesn't pin
    ({**POSTING, "META_PAGE_TOKEN": ""}, "META_PAGE_TOKEN"),
])
def test_switched_on_but_not_the_towns_own_settings_fails_loudly_and_posts_nothing(medford, env, why):
    w, _ = medford
    site = SocialSite()
    meta = Meta(site)
    status, result = w.job_social_kit(site, run=fake_kit_build([]), env=env, today=TUE, session=meta)
    assert status == "failed" and why in result["error"]
    assert site.live == result["build"]          # the kit is still on the site
    assert meta.calls == []


def test_a_failed_build_hands_over_nothing(medford):
    w, _ = medford
    site = SocialSite()
    status, result = w.job_social_kit(site, run=lambda args, timeout, env=None: (1, ["boom"]), env=POSTING, today=TUE)
    assert status == "failed" and "code 1" in result["error"] and site.uploads == []
