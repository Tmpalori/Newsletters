"""Properties of the GitHub Actions workflows that keep scheduled jobs from
failing silently or being dropped. The newsletter's send step is run for
real against a fake curl."""
import os
import stat
import subprocess
import sys

import pytest
import yaml

WF = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".github", "workflows")


def load(name):
    with open(os.path.join(WF, name)) as f:
        return yaml.safe_load(f)


def step(job, name):
    return next(s for s in job["steps"] if s.get("name") == name)


def _exe(path, body):
    path.write_text(body)
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


def run_newsletter_send(tmp_path, codes):
    """Run the send step with curl answering `codes` in turn."""
    script = step(load("newsletter.yml")["jobs"]["send"], "Send this week's newsletter")["run"]
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (tmp_path / "codes").write_text("\n".join(codes) + "\n")
    _exe(bin_dir / "curl", """#!/bin/sh
echo "$*" >> "$STATE/calls"
n=$(wc -l < "$STATE/calls")
code=$(sed -n "${n}p" "$STATE/codes")
while [ $# -gt 0 ]; do [ "$1" = -o ] && echo '{"ok":true}' > "$2"; shift; done
printf '%s' "$code"
[ "$code" = 000 ] && exit 28
exit 0
""")
    _exe(bin_dir / "sleep", '#!/bin/sh\necho "$1" >> "$STATE/sleeps"\n')
    env = dict(os.environ, PATH=f"{bin_dir}:{os.environ['PATH']}", STATE=str(tmp_path),
               SECRET="s3cret", SITE="https://example.test")
    r = subprocess.run(["bash", "-e", "-o", "pipefail", "-c", script], cwd=tmp_path, env=env,
                       capture_output=True, text=True, timeout=30)
    calls = (tmp_path / "calls").read_text().splitlines()
    sleeps = (tmp_path / "sleeps").read_text().split() if (tmp_path / "sleeps").exists() else []
    return r.returncode, calls, sleeps


def test_newsletter_retries_server_errors_and_no_answer(tmp_path):
    rc, calls, sleeps = run_newsletter_send(tmp_path, ["502", "000", "200"])
    assert rc == 0 and len(calls) == 3 and len(sleeps) == 2
    assert all("--max-time" in c for c in calls)


def test_newsletter_gives_up_after_three_tries(tmp_path):
    rc, calls, _ = run_newsletter_send(tmp_path, ["500", "500", "500", "200"])
    assert rc == 1 and len(calls) == 3


def test_newsletter_does_not_retry_a_wrong_secret(tmp_path):
    rc, calls, sleeps = run_newsletter_send(tmp_path, ["401", "200"])
    assert rc == 1 and len(calls) == 1 and sleeps == []


def test_newsletter_job_timeout_fits_the_retries():
    job = load("newsletter.yml")["jobs"]["send"]
    assert job["timeout-minutes"] >= 25
    assert step(job, "Tell Slack it failed")["if"] == "failure() || cancelled()"


def test_social_kit_fits_its_worst_case_and_alerts_on_cancel():
    wf = load("social-kit.yml")
    job = wf["jobs"]["build"]
    post = step(job, "Post to Facebook + Instagram")
    # Deploy wait (10 min) + Reel processing (6 min) + Thursday's second post.
    assert post["timeout-minutes"] >= 18
    assert job["timeout-minutes"] >= post["timeout-minutes"] + 10
    assert "cancelled()" in step(job, "Tell Slack it failed")["if"]
    assert step(job, "Save posted ids")["if"].startswith("always()")


def test_social_kit_posting_runs_have_their_own_concurrency_group():
    # One pending run per group: a push rebuild must not replace a queued post.
    group = load("social-kit.yml")["concurrency"]["group"]
    assert "github.event_name == 'schedule'" in group and "inputs.post" in group
    # The site scheduler dispatches the daily post with scheduled=true (and
    # post=false); it must queue with the posts, not the push rebuilds.
    assert "inputs.scheduled" in group


def test_event_check_wait_step_can_alert_slack():
    # A collect whose candidates never go live alerts from the wait step.
    job = load("event-check.yml")["jobs"]["check"]
    env = step(job, "Wait for the new events to go live")["env"]
    assert "SLACK_ALERTS_WEBHOOK_URL" in env["SLACK_WEBHOOK_URL"]


def test_uptime_stale_feed_check_is_not_in_the_five_minute_group():
    wf = load("uptime.yml")
    assert "concurrency" not in wf  # per job, below
    check, stale = wf["jobs"]["check"], wf["jobs"]["stale-feed"]
    assert check["concurrency"]["group"] != stale["concurrency"]["group"]
    assert stale["if"] == "github.event.schedule == '17 15 * * *'"
    assert "17 15 * * *" in [c["cron"] for c in wf[True]["schedule"]]
    assert "feed_age.py" in step(stale, "Stale feed")["run"]


def test_meta_ads_failure_alerts_slack():
    job = load("meta-ads.yml")["jobs"]["ads"]
    alert = step(job, "Tell Slack it failed")
    assert "failure()" in alert["if"] and "slack_notify.py" in alert["run"]


@pytest.mark.parametrize("name", sorted(f for f in os.listdir(WF) if f.endswith(".yml")))
def test_every_workflow_parses(name):
    assert load(name)["jobs"]


def town_env(town=None):
    """What the workflows' "Town paths" step puts in GITHUB_ENV (TOWN unset = Victoria)."""
    env = {k: v for k, v in os.environ.items() if k not in ("TOWN", "TOWNS_DIR")}
    out = subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "town.py"), "paths"],
                         env=env, capture_output=True, text=True, check=True).stdout
    return dict(line.split("=", 1) for line in out.splitlines())


def _git(cwd, *args):
    # The machine's own git config (hooks, signing, default branch) stays out of it.
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *args], cwd=cwd, check=True,
                   capture_output=True, text=True, env={**os.environ, "GIT_CONFIG_GLOBAL": os.devnull})


def run_kit_commit(tmp_path, posting):
    """Run social-kit's Commit step after another run pushed a different kit."""
    origin, other, mine = tmp_path / "origin.git", tmp_path / "other", tmp_path / "mine"
    _git(tmp_path, "init", "-q", "--bare", "-b", "main", str(origin))
    _git(tmp_path, "clone", "-q", str(origin), str(other))
    kit = other / "docs" / "social" / "latest"
    kit.mkdir(parents=True)
    (kit / "kit.json").write_text('{"v": "base"}\n')
    _git(other, "add", ".")
    _git(other, "commit", "-qm", "base")
    _git(other, "push", "-q", "origin", "HEAD:main")
    _git(tmp_path, "clone", "-q", str(origin), str(mine))
    (kit / "kit.json").write_text('{"v": "theirs"}\n')   # the concurrent run lands first
    _git(other, "commit", "-qam", "other kit")
    _git(other, "push", "-q", "origin", "HEAD:main")
    (mine / "docs" / "social" / "latest" / "kit.json").write_text('{"v": "mine"}\n')
    script = step(load("social-kit.yml")["jobs"]["build"], "Commit")["run"]
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _exe(bin_dir / "sleep", "#!/bin/sh\nexit 0\n")
    env = dict(os.environ, PATH=f"{bin_dir}:{os.environ['PATH']}", POSTING="true" if posting else "false",
               GIT_CONFIG_GLOBAL=os.devnull, **town_env())
    r = subprocess.run(["bash", "-e", "-o", "pipefail", "-c", script], cwd=mine, env=env,
                       capture_output=True, text=True, timeout=60)
    _git(other, "pull", "-q", "--rebase", "origin", "main")
    return r.returncode, (kit / "kit.json").read_text()


def test_social_kit_posting_run_wins_a_kit_conflict(tmp_path):
    # A push rebuild committed docs/social/latest first: the posting run's
    # retries all conflicted and it exited 1 before posting.
    rc, on_main = run_kit_commit(tmp_path, posting=True)
    assert rc == 0 and '"mine"' in on_main


def test_social_kit_rebuild_yields_to_a_newer_kit(tmp_path):
    rc, on_main = run_kit_commit(tmp_path, posting=False)
    assert rc == 0 and '"theirs"' in on_main


def test_social_kit_installs_ffmpeg_only_for_the_reel_and_bounded():
    job = load("social-kit.yml")["jobs"]["build"]
    ff = step(job, "Install ffmpeg")
    assert "weekend" in ff["if"] and ff["timeout-minutes"] <= 5 and ff["continue-on-error"] is True


def run_gate(tmp_path, wf, schedule, now, ran=False, event="schedule"):
    """Run a fallback cron's gate step at `now` with the site answering `ran`."""
    g = next(s for s in load(wf)["jobs"]["gate"]["steps"] if s.get("id") == "g")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    _exe(bin_dir / "curl", '#!/bin/sh\necho \'{"ok":true,"ran":%s}\'\n' % ("true" if ran else "false"))
    out = tmp_path / "out"
    out.write_text("")
    env = dict(os.environ, PATH=f"{bin_dir}:{os.environ['PATH']}", GITHUB_OUTPUT=str(out),
               GATE_NOW=now, EVENT=event, SCHEDULE=schedule, SITE="https://example.test",
               **{k: v for k, v in g["env"].items() if k.endswith("CRON")})
    r = subprocess.run(["bash", "-e", "-o", "pipefail", "-c", g["run"]], env=env,
                       capture_output=True, text=True, timeout=30)
    assert r.returncode == 0, r.stderr
    lines = out.read_text().strip().splitlines()
    run_gate.outputs = dict(x.split("=", 1) for x in lines)
    return next(x for x in lines if x.startswith("run="))


SUMMER, WINTER = "2026-07-06T18:00:00Z", "2026-12-07T18:00:00Z"


@pytest.mark.parametrize("wf,cdt,cst", [("event-check.yml", "43 11 * * 1", "43 12 * * 1"),
                                        ("newsletter.yml", "43 12 * * 1", "43 13 * * 1"),
                                        ("meta-ads.yml", "37 13 * * *", "37 14 * * *"),
                                        ("social-kit.yml", "47 13 * * *", "47 14 * * *")])
def test_fallback_crons_fire_at_the_slot_in_both_cdt_and_cst(tmp_path, wf, cdt, cst):
    # Pinned to CDT alone, the winter run came an hour before the slot,
    # when the scheduler's "ran" still answered for the previous slot.
    crons = [c["cron"] for c in load(wf)[True]["schedule"]]
    assert cdt in crons and cst in crons
    assert run_gate(tmp_path, wf, cdt, SUMMER) == "run=true"
    assert run_gate(tmp_path, wf, cst, SUMMER) == "run=false"
    assert run_gate(tmp_path, wf, cst, WINTER) == "run=true"
    assert run_gate(tmp_path, wf, cdt, WINTER) == "run=false"
    # Still skipped when the site's scheduler already ran the slot; by-hand
    # runs are never gated.
    assert run_gate(tmp_path, wf, cst, WINTER, ran=True) == "run=false"
    assert run_gate(tmp_path, wf, "", WINTER, ran=True, event="workflow_dispatch") == "run=true"


def test_newsletter_thursday_cron_sends_the_weekend_issue(tmp_path):
    crons = [c["cron"] for c in load("newsletter.yml")[True]["schedule"]]
    assert "13 12 * * 4" in crons and "13 13 * * 4" in crons
    thu_summer, thu_winter = "2026-07-09T18:00:00Z", "2026-12-10T18:00:00Z"
    assert run_gate(tmp_path, "newsletter.yml", "13 12 * * 4", thu_summer) == "run=true"
    assert run_gate.outputs["edition"] == "weekend"
    assert run_gate(tmp_path, "newsletter.yml", "13 12 * * 4", thu_winter) == "run=false"
    assert run_gate(tmp_path, "newsletter.yml", "13 13 * * 4", thu_winter, ran=True) == "run=false"
    assert run_gate(tmp_path, "newsletter.yml", "43 12 * * 1", SUMMER) == "run=true"
    assert run_gate.outputs["edition"] == "weekly"
    send = step(load("newsletter.yml")["jobs"]["send"], "Send this week's newsletter")
    assert "X-Newsletter-Edition: $EDITION" in send["run"]


@pytest.mark.parametrize("name,job,post,script", [("meta-ads.yml", "ads", "Meta ads", "meta_ads.py"),
                                                  ("social-kit.yml", "build", "Post to Facebook + Instagram",
                                                   "social_post.py")])
def test_meta_workflows_pass_the_graph_version_and_slack_names_a_refused_one(name, job, post, script):
    # A retired Graph version must be fixable from the repo variable, and
    # the alert must say so instead of blaming the token.
    steps = load(name)["jobs"][job]
    call = step(steps, post)
    assert call["env"]["GRAPH_API_VERSION"] == "${{ vars.GRAPH_API_VERSION || 'v23.0' }}"
    alert = step(steps, "Tell Slack it failed")
    assert alert["env"]["ALERT"] == "${{ steps.%s.outputs.alert }}" % call["id"]
    out = subprocess.run(["bash", "-c", 'printf "%s" "' + alert["run"].split('"')[1] + '"'],
                         env={"ALERT": "named v23.0"}, capture_output=True, text=True).stdout
    assert out == "named v23.0"
    with open(os.path.join(os.path.dirname(WF), "..", "scripts", script)) as f:
        assert "set_output(\"alert\"" in f.read()


# ─── weekly-collect push retry ──────────────────────────────────────────────

def _collect_push_loop():
    script = step(load("weekly-collect.yml")["jobs"]["collect"], "Commit and push")["run"]
    return script[script.index("for i in"):script.index("done")]


def test_weekly_collect_push_retry_aborts_a_failed_rebase():
    # Without the abort, one conflict left a rebase in progress and every
    # retry failed at once, losing the paid collect.
    loop = _collect_push_loop()
    assert "git rebase --abort" in loop
    assert loop.index("git pull --rebase") < loop.index("git rebase --abort") < loop.index("sleep")


def test_weekly_collect_keeps_its_files_when_main_changed_them(tmp_path):
    # A merge touched candidates.json during the collect.
    origin, other, mine = tmp_path / "origin.git", tmp_path / "other", tmp_path / "mine"
    _git(tmp_path, "init", "-q", "--bare", "-b", "main", str(origin))
    _git(tmp_path, "clone", "-q", str(origin), str(other))
    for f in ("candidates.json", "enrichment_cache.json"):
        (other / f).write_text('{"v": "base"}\n')
    _git(other, "add", ".")
    _git(other, "commit", "-qm", "base")
    _git(other, "push", "-q", "origin", "HEAD:main")
    _git(tmp_path, "clone", "-q", str(origin), str(mine))
    (other / "candidates.json").write_text('{"v": "merged pr"}\n')
    _git(other, "commit", "-qam", "pr")
    _git(other, "push", "-q", "origin", "HEAD:main")
    (mine / "candidates.json").write_text('{"v": "this collect"}\n')
    script = step(load("weekly-collect.yml")["jobs"]["collect"], "Commit and push")["run"]
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _exe(bin_dir / "sleep", "#!/bin/sh\nexit 0\n")
    env = dict(os.environ, PATH=f"{bin_dir}:{os.environ['PATH']}", GIT_CONFIG_GLOBAL=os.devnull, **town_env())
    r = subprocess.run(["bash", "-e", "-o", "pipefail", "-c", script], cwd=mine, env=env,
                       capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    _git(other, "pull", "-q", "--rebase", "origin", "main")
    assert '"this collect"' in (other / "candidates.json").read_text()


@pytest.mark.parametrize("name", sorted(os.listdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".github", "workflows"))))
def test_town_paths_are_set_before_use(name):
    # A step that reads $TOWN_CANDIDATES etc. after no "Town paths" step
    # would see an empty path (git add "" fails; --candidates "./" worse).
    for job_name, job in load(name)["jobs"].items():
        seen = False
        for st in job.get("steps", []):
            if st.get("name") == "Town paths":
                assert st["run"].strip() == 'python3 town.py paths >> "$GITHUB_ENV"'
                seen = True
                continue
            uses = "TOWN_" in yaml.safe_dump(st)
            assert seen or not uses, f"{name} {job_name}: {st.get('name')} uses TOWN_* before the Town paths step"


TOWN_WORKFLOWS = ["event-check.yml", "meta-ads.yml", "newsletter.yml", "social-kit.yml", "submission-review.yml",
                  "uptime.yml", "weekly-collect.yml", "weekly-digest.yml"]
VIC_EMPTY_SUFFIX = "${{ inputs.town && inputs.town != 'victoria' && format('-{0}', inputs.town) || '' }}"
VIC_EMPTY_PREFIX = "${{ inputs.town && inputs.town != 'victoria' && format('{0}-', inputs.town) || '' }}"


# 3.4: these run one job per town (a matrix); the town is the job's, not the workflow's.
MATRIX_JOBS = {"weekly-collect.yml": "collect", "event-check.yml": "check"}


@pytest.mark.parametrize("name", TOWN_WORKFLOWS)
def test_town_input_defaults_to_victoria(name):
    # MULTI_CITY_PLAN.md 3.1: a dispatch can name a town; scheduled runs and
    # dispatches without it stay Victoria's.
    wf = load(name)
    on = wf.get("on", wf.get(True))
    assert on["workflow_dispatch"]["inputs"]["town"]["default"] == "victoria"
    if name in MATRIX_JOBS:
        job = wf["jobs"][MATRIX_JOBS[name]]
        assert "env" not in wf
        assert job["env"]["TOWN"] == "${{ matrix.town }}"
        assert job["strategy"]["fail-fast"] is False
        assert job["name"] == MATRIX_JOBS[name] + " ${{ matrix.town }}"
    else:
        assert wf["env"]["TOWN"] == "${{ inputs.town || 'victoria' }}"


def test_town_groups_and_cache_keys_keep_victorias_names():
    # 3.2: another town's concurrency groups and cache keys get its slug;
    # Victoria's (no input, or "victoria") come out exactly as before.
    groups = {
        "meta-ads.yml": "meta-ads" + VIC_EMPTY_SUFFIX,
        "submission-review.yml": "submission-review" + VIC_EMPTY_SUFFIX,
        "social-kit.yml": "social-kit-${{ (github.event_name == 'schedule' || inputs.post || inputs.scheduled) && 'post' || 'build' }}" + VIC_EMPTY_SUFFIX,
    }
    for name, group in groups.items():
        assert load(name)["concurrency"]["group"] == group
    assert load("uptime.yml")["jobs"]["check"]["concurrency"]["group"] == "uptime" + VIC_EMPTY_SUFFIX
    assert "concurrency" not in load("weekly-collect.yml")
    assert load("weekly-collect.yml")["jobs"]["collect"]["concurrency"]["group"] == \
        "weekly-collect${{ matrix.town != 'victoria' && format('-{0}', matrix.town) || '' }}"
    for name, stem in (("submission-review.yml", "review-state-"), ("uptime.yml", "uptime-state-")):
        text = open(os.path.join(WF, name)).read()
        # A town's prefix goes in front, so Victoria's "review-state-" restore
        # prefix can never pick up another town's state.
        assert text.count(f"key: {VIC_EMPTY_PREFIX}{stem}${{{{ github.run_id }}}}") == 2
        assert text.count(f"restore-keys: {VIC_EMPTY_PREFIX}{stem}\n") == 1


def _changes(tmp_path, files, tracked):
    """weekly-collect's 'Check for changes' step in a repo holding `files`."""
    tmp_path.mkdir(parents=True)
    _git(tmp_path, "init", "-q", "-b", "main")
    for name in tracked:
        (tmp_path / name).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / name).write_text("old\n")
    if tracked:
        _git(tmp_path, "add", ".")
        _git(tmp_path, "commit", "-qm", "base")
    for name, text in files.items():
        (tmp_path / name).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / name).write_text(text)
    out = tmp_path / "out"
    env = dict(os.environ, GITHUB_OUTPUT=str(out), TOWN_CANDIDATES="towns/bay/candidates.json",
               TOWN_COLLECTION_METADATA="towns/bay/collection_metadata.json", TOWN_ENRICHMENT_CACHE="towns/bay/enrichment_cache.json")
    script = step(load("weekly-collect.yml")["jobs"]["collect"], "Check for changes")["run"]
    subprocess.run(["bash", "-e", "-o", "pipefail", "-c", script], cwd=tmp_path, env=env, check=True)
    return out.read_text().strip()


def test_collect_commits_a_new_towns_first_files(tmp_path):
    # git diff calls untracked files unchanged, so a new town's first
    # collect was thrown away every time.
    assert _changes(tmp_path / "a", {"towns/bay/candidates.json": "{}"}, tracked=[]) == "changed=true"
    assert _changes(tmp_path / "b", {}, tracked=["towns/bay/candidates.json"]) == "changed=false"
    assert _changes(tmp_path / "c", {"towns/bay/candidates.json": "new\n"}, tracked=["towns/bay/candidates.json"]) == "changed=true"


def _newsletter_town_guard(town):
    g = step(load("newsletter.yml")["jobs"]["gate"], "Only Victoria until per-town Environments")
    env = dict(os.environ, RUN_TOWN=town)
    return subprocess.run(["bash", "-e", "-o", "pipefail", "-c", g["run"]], env=env,
                          capture_output=True, text=True, timeout=30)


def test_newsletter_refuses_another_towns_dispatch():
    # The send reaches the repo-level SITE_URL and NEWSLETTER_CRON_SECRET
    # (Victoria's): a dispatch for another town would send Victoria's issue.
    # Until that town has its GitHub Environment (plan 3.3) it fails fast.
    g = step(load("newsletter.yml")["jobs"]["gate"], "Only Victoria until per-town Environments")
    assert g["env"]["RUN_TOWN"] == "${{ inputs.town || 'victoria' }}"
    assert _newsletter_town_guard("victoria").returncode == 0
    r = _newsletter_town_guard("bay")
    assert r.returncode == 1
    assert "needs its GitHub Environment (MULTI_CITY_PLAN.md 3.3)" in r.stdout
    # The send job waits on the gate, so nothing is sent.
    assert load("newsletter.yml")["jobs"]["send"]["needs"] == "gate"


@pytest.mark.parametrize("name", TOWN_WORKFLOWS)
def test_town_slack_tag_is_empty_for_victoria(name):
    # Another town's Slack posts carry vars.SLACK_TOWN_TAG (slack_notify.py
    # falls back to its city, Victoria's included); scheduled and Victoria
    # runs pass "" so Victoria is tagged with its city.
    wf = load(name)
    if name in MATRIX_JOBS:
        assert wf["jobs"][MATRIX_JOBS[name]]["env"]["SLACK_TOWN_TAG"] == \
            "${{ matrix.town != 'victoria' && vars.SLACK_TOWN_TAG || '' }}"
    else:
        assert wf["env"]["SLACK_TOWN_TAG"] == "${{ inputs.town && inputs.town != 'victoria' && vars.SLACK_TOWN_TAG || '' }}"


@pytest.mark.parametrize("name", TOWN_WORKFLOWS)
def test_town_jobs_use_the_towns_environment_and_none_for_victoria(name):
    # MULTI_CITY_PLAN.md 3.3: another town's jobs read its GitHub Environment
    # (SITE_URL, cron secrets, Meta ids); Victoria's ("" = none) keep the
    # repo-level ones. The newsletter waits until a town can send by dispatch.
    for job_name, job in load(name)["jobs"].items():
        env = job.get("environment")
        if name == "newsletter.yml" or (name == "weekly-collect.yml" and job_name == "towns"):
            assert env is None, job_name        # "towns" only lists the matrix
        elif MATRIX_JOBS.get(name) == job_name:
            assert env == "${{ matrix.town != 'victoria' && matrix.town || '' }}", job_name
        else:
            assert env == "${{ inputs.town && inputs.town != 'victoria' && inputs.town || '' }}", job_name


# ─── 3.4: which towns a run covers ──────────────────────────────────────────

def _ready_towns(tmp_path, towns):
    """A towns/ folder: {slug: workflows flag, or "broken"}; returns its path."""
    import json
    base = tmp_path / "towns"
    base.mkdir()
    (base / "index.json").write_text(json.dumps({"towns": ["victoria", *towns]}))
    for slug, flag in towns.items():
        (base / slug).mkdir()
        raw = {"siteName": "The Bay 979", "domain": f"{slug}979.com", "city": "Bay City", "state": "TX",
               "stateName": "Texas", "timezone": "America/Chicago", "workflows": flag}
        (base / slug / "town.json").write_text("{nope" if flag == "broken" else json.dumps(raw))
    return base


def _collect_towns(tmp_path, event, town="", towns_dir=None):
    """weekly-collect's towns step, run from a copy of the repo's town.py."""
    import shutil
    work = tmp_path / "work"
    work.mkdir()
    shutil.copy(os.path.join(os.path.dirname(WF), "..", "town.py"), work / "town.py")
    if towns_dir:
        shutil.copytree(towns_dir, work / "towns")
    g = next(s for s in load("weekly-collect.yml")["jobs"]["towns"]["steps"] if s.get("id") == "t")
    out = tmp_path / "out"
    env = {k: v for k, v in os.environ.items() if k not in ("TOWN", "TOWNS_DIR")}
    env.update(GITHUB_OUTPUT=str(out), EVENT=event, INPUT_TOWN=town or "victoria")
    r = subprocess.run(["bash", "-e", "-o", "pipefail", "-c", g["run"]], cwd=work, env=env,
                       capture_output=True, text=True, timeout=30)
    assert r.returncode == 0, r.stderr
    import json
    return json.loads(out.read_text().strip().split("=", 1)[1])


def test_scheduled_collect_covers_victoria_and_ready_towns_only(tmp_path):
    # A town joins the scheduled runs once its town.json says "workflows":
    # true (with its GitHub Environment, 3.3); a broken town.json is skipped,
    # never a reason to drop Victoria's collect.
    towns = _ready_towns(tmp_path, {"bay": True, "cuero": False, "edna": "broken"})
    assert _collect_towns(tmp_path, "schedule", towns_dir=towns) == ["victoria", "bay"]


def test_scheduled_collect_without_towns_is_victoria(tmp_path):
    assert _collect_towns(tmp_path, "schedule") == ["victoria"]


def test_manual_collect_is_the_town_asked_for(tmp_path):
    assert _collect_towns(tmp_path, "workflow_dispatch") == ["victoria"]
    (tmp_path / "b").mkdir()
    assert _collect_towns(tmp_path / "b", "workflow_dispatch", town="bay") == ["bay"]


def test_scheduled_towns_survives_a_broken_index(tmp_path):
    sys.path.insert(0, os.path.join(os.path.dirname(WF), ".."))
    import town
    (tmp_path / "index.json").write_text("{nope")
    warnings = []
    assert town.scheduled_towns(str(tmp_path), warn=warnings.append) == ["victoria"]
    assert warnings and "unreadable" in warnings[0]


def _collect_skip(tmp_path, event, towns, ran=(), schedule="23 20 * * 0", ran_later=(), towns_dir=None):
    """weekly-collect's fallback gate: drops towns whose site already started
    this slot's collect. curl answers ran:true for sites in `ran` (and, after
    the one sleep, `ran_later`); every URL asked is recorded."""
    import json
    import shutil
    work = tmp_path / "work"
    work.mkdir(parents=True)
    shutil.copy(os.path.join(os.path.dirname(WF), "..", "town.py"), work / "town.py")
    if towns_dir:
        shutil.copytree(towns_dir, work / "towns")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (tmp_path / "ran").write_text("\n".join(ran) + "\n")
    (tmp_path / "ran_later").write_text("\n".join(ran_later) + "\n")
    # curl -fsS --max-time 20 <url>: the URL is the last argument.
    _exe(bin_dir / "curl", '#!/bin/sh\nfor u; do :; done\necho "$u" >> "$STATE/asked"\n'
         'host=$(echo "$u" | sed -E "s#https://([^/]+)/.*#\\1#")\n'
         'if grep -qx "$host" "$STATE/ran" || { [ -f "$STATE/slept" ] && grep -qx "$host" "$STATE/ran_later"; }; then '
         'echo \'{"ok":true,"ran":true}\'; else echo \'{"ok":true,"ran":false}\'; fi\n')
    _exe(bin_dir / "sleep", '#!/bin/sh\ntouch "$STATE/slept"\n')
    g = next(s for s in load("weekly-collect.yml")["jobs"]["towns"]["steps"] if s.get("id") == "s")
    out = tmp_path / "out"
    env = {k: v for k, v in os.environ.items() if k not in ("TOWN", "TOWNS_DIR", "SITE_URL")}
    env.update(PATH=f"{bin_dir}:{os.environ['PATH']}", GITHUB_OUTPUT=str(out), STATE=str(tmp_path), EVENT=event,
               SCHEDULE=schedule if event == "schedule" else "", LIST=json.dumps(towns),
               VICTORIA_SITE="https://www.thevic361.com")
    r = subprocess.run(["bash", "-e", "-o", "pipefail", "-c", g["run"]], cwd=work, env=env,
                       capture_output=True, text=True, timeout=30)
    assert r.returncode == 0, r.stderr
    asked = (tmp_path / "asked").read_text().split() if (tmp_path / "asked").exists() else []
    return json.loads(out.read_text().strip().split("=", 1)[1]), asked, (tmp_path / "slept").exists()


def test_late_cron_skips_a_collect_the_site_already_started(tmp_path):
    # GitHub skipped or delayed the Sunday cron for hours (Oct 4, Oct 11);
    # the site starts the collect at 3:23 PM and the late cron stands down.
    towns, asked, slept = _collect_skip(tmp_path, "schedule", ["victoria"], ran=["www.thevic361.com"])
    assert towns == []
    assert asked == ["https://www.thevic361.com/api/scheduler/ran?job=weekly-collect"]
    assert not slept
    assert load("weekly-collect.yml")["jobs"]["collect"]["if"] == "needs.towns.outputs.list != '[]'"


def test_cron_collects_when_the_site_did_not(tmp_path):
    # The site down or its dispatch refused: the cron is the fallback, after
    # one more look (a cron on time races the site's 3:23 tick).
    towns, asked, slept = _collect_skip(tmp_path, "schedule", ["victoria"])
    assert towns == ["victoria"] and slept and len(asked) == 2


def test_on_time_cron_waits_for_the_sites_tick(tmp_path):
    towns, _, slept = _collect_skip(tmp_path, "schedule", ["victoria"], ran_later=["www.thevic361.com"])
    assert towns == [] and slept


def test_midweek_cron_asks_about_the_midweek_slot_per_town(tmp_path):
    (tmp_path / "t").mkdir()
    towns_dir = _ready_towns(tmp_path / "t", {"bay": True})
    towns, asked, _ = _collect_skip(tmp_path, "schedule", ["victoria", "bay"], ran=["www.thevic361.com"],
                                    schedule="23 20 * * 3", towns_dir=towns_dir)
    assert towns == ["bay"]
    assert asked[0] == "https://www.thevic361.com/api/scheduler/ran?job=weekly-collect-midweek"
    assert "https://www.bay979.com/api/scheduler/ran?job=weekly-collect-midweek" in asked


def test_manual_and_site_started_collects_never_ask(tmp_path):
    towns, asked, slept = _collect_skip(tmp_path, "workflow_dispatch", ["bay"])
    assert towns == ["bay"] and asked == [] and not slept


def _check_gate(tmp_path, jobs, conclusion="success", gh_fails=False):
    """event-check's gate after a Weekly Collect run whose jobs are `jobs`."""
    import json
    g = next(s for s in load("event-check.yml")["jobs"]["gate"]["steps"] if s.get("id") == "g")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(parents=True)
    (tmp_path / "jobs.json").write_text(json.dumps({"jobs": [{"name": n, "conclusion": c} for n, c in jobs]}))
    # gh api <url> --jq <filter>: the filter on the run's jobs, printed raw like gh.
    _exe(bin_dir / "gh", "#!/bin/sh\nexit 1\n" if gh_fails else
         '#!/bin/sh\n[ "$3" = --jq ] || exit 2\njq -r "$4" "$STATE/jobs.json"\n')
    out = tmp_path / "out"
    out.write_text("")
    env = dict(os.environ, PATH=f"{bin_dir}:{os.environ['PATH']}", GITHUB_OUTPUT=str(out), STATE=str(tmp_path),
               EVENT="workflow_run", RUN_ID="1", CONCLUSION=conclusion, GITHUB_REPOSITORY="o/r", SCHEDULE="",
               **{k: v for k, v in g["env"].items() if k.endswith("CRON")})
    env.pop("INPUT_TOWN", None)
    r = subprocess.run(["bash", "-e", "-o", "pipefail", "-c", g["run"]], env=env,
                       capture_output=True, text=True, timeout=30)
    assert r.returncode == 0, r.stderr
    o = dict(x.split("=", 1) for x in out.read_text().strip().splitlines())
    return o["run"], json.loads(o["towns"])


def test_event_check_checks_each_town_whose_collect_succeeded(tmp_path):
    # Another town's collect no longer starts Victoria's check, and a town
    # whose collect failed isn't checked while the others are.
    jobs = [("towns", "success"), ("collect victoria", "success"), ("collect bay", "failure"), ("collect cuero", "success")]
    assert _check_gate(tmp_path, jobs, conclusion="failure") == ("true", ["cuero", "victoria"])


def test_event_check_skips_when_no_collect_succeeded(tmp_path):
    assert _check_gate(tmp_path, [("towns", "success"), ("collect victoria", "failure")], conclusion="failure") == ("false", [])


def test_event_check_reads_a_pre_matrix_collect_as_victorias(tmp_path):
    assert _check_gate(tmp_path, [("collect", "success")]) == ("true", ["victoria"])


def test_event_check_falls_back_to_victoria_when_jobs_cannot_be_listed(tmp_path):
    assert _check_gate(tmp_path / "a", [], gh_fails=True) == ("true", ["victoria"])
    assert _check_gate(tmp_path / "b", [], conclusion="failure", gh_fails=True) == ("false", [])


def test_event_check_gate_may_read_the_collect_runs_jobs():
    wf = load("event-check.yml")
    assert wf["permissions"]["actions"] == "read"
    assert "if" not in wf["jobs"]["gate"]  # partial success still checks the towns that collected
    assert wf["jobs"]["check"]["strategy"]["matrix"]["town"] == "${{ fromJSON(needs.gate.outputs.towns) }}"


@pytest.mark.parametrize("name", sorted(os.listdir(WF)))
def test_town_workflows_sparse_checkout_includes_towns(name):
    # town.py reads towns/<slug>/town.json at import: a sparse checkout
    # without towns/ fails every run for another town.
    wf = load(name)
    on = wf.get("on", wf.get(True)) or {}
    if not ((on.get("workflow_dispatch") or {}).get("inputs") or {}).get("town"):
        return
    for job in wf["jobs"].values():
        for st in job.get("steps", []):
            sparse = (st.get("with") or {}).get("sparse-checkout")
            if sparse is not None:
                assert "towns" in str(sparse).split(), f"{name}: sparse checkout without towns/"


def test_every_alert_step_also_reports_to_the_site():
    # Each step that posts to the alerts webhook also gives slack_notify.py
    # the site and secret, so the alert lands in the owner inbox (HQ, the
    # owner's assistant). Same secret fallback as server/opsReport.js.
    import glob
    want_secret = ("${{ secrets.OPS_REPORT_SECRET || secrets.SUBMISSION_REVIEW_SECRET || "
                   "secrets.EVENT_CHECK_SECRET || secrets.NEWSLETTER_CRON_SECRET }}")
    alert_hook = "${{ secrets.SLACK_ALERTS_WEBHOOK_URL || secrets.SLACK_WEBHOOK_URL }}"
    found = 0
    for path in glob.glob(os.path.join(WF, "*.yml")):
        wf = load(os.path.basename(path))
        for job in wf["jobs"].values():
            for st in job.get("steps", []):
                env = st.get("env") or {}
                if env.get("SLACK_WEBHOOK_URL") == alert_hook:
                    found += 1
                    assert env.get("OPS_REPORT_SECRET") == want_secret, (path, st.get("name"))
                    assert env.get("OPS_REPORT_URL", "").startswith("${{ vars.SITE_URL"), (path, st.get("name"))
    assert found >= 12


def test_failure_alerts_cover_timeouts_and_cancels():
    # A job-level timeout is a cancellation, which failure() alone misses.
    # (Not tests.yml: a newer push cancels those runs on purpose.)
    import glob
    for path in glob.glob(os.path.join(WF, "*.yml")):
        if path.endswith("tests.yml"):
            continue
        text = open(path).read()
        assert "if: failure()\n" not in text, path
