"""post_reel.py: the Facebook Reel poster, with Meta mocked out.

Every Graph and rupload call goes through a fake requests session that
records it, so these tests pin the exact requests (URL, params, form data,
headers, timeout) the Reels Publishing API guide asks for, and none of them
touches the network. ffprobe is faked too, except in the tests at the end
that make tiny clips with a real ffmpeg (skipped without it).
"""
import contextlib
import copy
import datetime as dt
import json
import os
import shutil
import socket
import subprocess
import sys
import types

import pytest
import requests

VIDEO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, VIDEO)

import post_reel as pr  # noqa: E402
import towns  # noqa: E402

with open(os.environ["VIDEO_SCRIPTS"], encoding="utf-8") as _f:  # the frozen batch (conftest.py)
    VIDEOS = {v["id"]: v for v in json.load(_f)["videos"]}

SYSTEM_TOKEN = "EAAsystemUserToken" + "s" * 60
PAGE_TOKEN = "EAAvictoriaPageToken" + "p" * 60
TOKENS = (SYSTEM_TOKEN, PAGE_TOKEN)
VICTORIA = towns.TOWNS["victoria"]["page_id"]
G, R = pr.GRAPH, pr.RUPLOAD
NOW = dt.datetime(2026, 10, 23, 18, 0, tzinfo=dt.timezone.utc)   # a Friday, two days before video 1
OCT25 = 1792971000      # Sun Oct 25 2026 18:30 CDT = 23:30 UTC
NOV1 = 1793579400       # Sun Nov 1 2026 18:30 CST = Mon Nov 2 00:30 UTC
CONTENT = bytes(range(256)) * 20


# ------------------------------------------------------------------ fakes

class Resp:
    def __init__(self, status=200, body=None, text=None):
        self.status_code = status
        self._body = body
        self.text = text if text is not None else json.dumps(body)

    def json(self):
        if self._body is None:
            raise ValueError("not JSON")
        return self._body


class FakeSession:
    """Answers each request with the next queued answer (a Resp, an
    exception to raise, or a function of the call) and records the call."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.calls = []

    def request(self, method, url, params=None, data=None, headers=None, timeout=None, **extra):
        assert not extra, extra
        if hasattr(data, "read"):
            data = data.read()
        call = {"method": method, "url": url, "params": params, "data": data,
                "headers": dict(headers or {}), "timeout": timeout}
        self.calls.append(call)
        if not self.answers:
            raise AssertionError(f"unexpected request {method} {url}")
        answer = self.answers.pop(0)
        if callable(answer) and not isinstance(answer, BaseException):
            answer = answer(call)
        if isinstance(answer, BaseException):
            raise answer
        return answer


def ok(body):
    return Resp(200, body)


def err(status, code, message="boom", subcode=None, trace="AtraceXYZ", **extra):
    e = {"message": message, "type": "OAuthException", "code": code, "fbtrace_id": trace, **extra}
    if subcode is not None:
        e["error_subcode"] = subcode
    return Resp(status, {"error": e})


PAGE = ok({"access_token": PAGE_TOKEN, "name": "The Vic 361", "id": VICTORIA})
UPLOADED = ok({"success": True})
FINISHED = ok({"success": True, "post_id": "555"})


def START(vid="777", url=None):
    return ok({"video_id": vid, "upload_url": url or f"{R}/{vid}"})


def STATUS(up="complete", proc="not_started", pub="not_started", video_status="upload_complete", **more):
    st = {"video_status": video_status, "uploading_phase": {"status": up},
          "processing_phase": {"status": proc}, "publishing_phase": {"status": pub}}
    for key, value in more.items():
        phase, _, field = key.partition("__")
        st[f"{phase}_phase"][field] = value
    return ok({"status": st, "id": "777"})


SCHEDULED = STATUS(publishing__publish_status="scheduled", publishing__publish_time=OCT25)
LIVE = STATUS(proc="complete", pub="complete", video_status="ready", publishing__publish_status="published")

GOOD_PROBE = {
    "streams": [
        {"index": 0, "codec_type": "video", "codec_name": "h264", "profile": "High", "width": 1080, "height": 1920,
         "sample_aspect_ratio": "1:1", "pix_fmt": "yuv420p", "avg_frame_rate": "30/1", "r_frame_rate": "30/1",
         "field_order": "progressive", "color_transfer": "bt709", "duration": "16.000000"},
        {"index": 1, "codec_type": "audio", "codec_name": "aac", "profile": "LC", "sample_rate": "48000",
         "channels": 2, "bit_rate": "182124"},
    ],
    "format": {"format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": "16.000000"},
}
EVERY_2S = [0.0, 2.0, 4.0, 6.0, 8.0, 10.0, 12.0, 14.0]


def probe_with(video=None, audio="same", fmt=None):
    info = copy.deepcopy(GOOD_PROBE)
    info["streams"][0].update(video or {})
    if audio is None:
        del info["streams"][1]
    elif audio != "same":
        info["streams"][1].update(audio)
    info["format"].update(fmt or {})
    return info


@pytest.fixture
def env(monkeypatch, tmp_path):
    """The system-user token set, a fixed clock, no real sleeping, ffprobe
    answering for a good 16-second render, and a ledger in tmp_path."""
    monkeypatch.setenv("META_TOKEN", SYSTEM_TOKEN)
    monkeypatch.delenv("META_PAGE_TOKEN", raising=False)
    e = types.SimpleNamespace(now=NOW, t=0.0, sleeps=[], probe=GOOD_PROBE, keyframes=EVERY_2S,
                              ledger=str(tmp_path / "out" / "posted.json"), tmp=tmp_path)

    def fake_sleep(seconds):
        e.sleeps.append(seconds)
        e.t += seconds

    monkeypatch.setattr(pr, "_sleep", fake_sleep)
    monkeypatch.setattr(pr, "_monotonic", lambda: e.t)
    monkeypatch.setattr(pr, "_utcnow", lambda: e.now)
    monkeypatch.setattr(pr, "probe", lambda path: e.probe)
    monkeypatch.setattr(pr, "keyframe_times", lambda path: e.keyframes)

    def reel(vid="victoria-1", content=CONTENT):
        d = tmp_path / "renders" / vid
        d.mkdir(parents=True, exist_ok=True)
        p = d / "reel-9x16.mp4"
        p.write_bytes(content)
        return str(p)

    def read_ledger():
        with open(e.ledger, encoding="utf-8") as f:
            return json.load(f)

    def write_ledger(data):
        os.makedirs(os.path.dirname(e.ledger), exist_ok=True)
        with open(e.ledger, "w", encoding="utf-8") as f:
            json.dump(data, f)

    e.reel, e.read_ledger, e.write_ledger = reel, read_ledger, write_ledger
    return e


def post(env, session, *flags, vid="victoria-1", path=None):
    return pr.main(["post", path or env.reel(vid), "--video", vid, "--ledger", env.ledger, *flags], session=session)


def routes(session):
    return [(c["method"], c["url"]) for c in session.calls]


def assert_no_tokens(*texts):
    for text in texts:
        for token in TOKENS:
            assert token not in text
            assert token[:30] not in text


# ------------------------------------------------------- the request sequence

def assert_the_guides_requests(s, finish_data):
    """The six calls of a post, in order, exactly as the guide has them."""
    assert routes(s) == [
        ("GET", f"{G}/{VICTORIA}"),                       # the Page's own token
        ("POST", f"{G}/{VICTORIA}/video_reels"),          # Step 1: start
        ("POST", f"{R}/777"),                             # Step 2: the bytes
        ("GET", f"{G}/777"),                              # status: Meta has the file
        ("POST", f"{G}/{VICTORIA}/video_reels"),          # Step 3: finish
        ("GET", f"{G}/777"),                              # status: published or scheduled
    ]
    lookup, start, upload, wait, finish, confirm = s.calls
    assert lookup["params"] == {"fields": "access_token,name"} and lookup["data"] is None
    assert lookup["headers"] == {"Authorization": f"Bearer {SYSTEM_TOKEN}"}
    assert start["data"] == {"upload_phase": "start"} and start["params"] is None
    assert upload["headers"] == {"Authorization": f"OAuth {PAGE_TOKEN}", "offset": "0",
                                 "file_size": str(len(CONTENT)), "Content-Type": "application/octet-stream"}
    assert upload["data"] == CONTENT and upload["params"] is None
    assert wait["params"] == confirm["params"] == {"fields": "status"}
    assert wait["data"] is None and confirm["data"] is None
    assert finish["data"] == finish_data and finish["params"] is None
    for call in (start, wait, finish, confirm):
        assert call["headers"] == {"Authorization": f"Bearer {PAGE_TOKEN}"}
    assert upload["timeout"] == pr.UPLOAD_TIMEOUT and upload["timeout"][1] > pr.TIMEOUT[1]
    assert all(c["timeout"] == pr.TIMEOUT for c in s.calls if c is not upload)


def test_post_now_sends_exactly_the_guides_requests(env, capsys):
    s = FakeSession(PAGE, START(), UPLOADED, STATUS(), FINISHED, LIVE)
    assert post(env, s, "--now", "--go") == 0
    assert_the_guides_requests(s, {"video_id": "777", "upload_phase": "finish", "video_state": "PUBLISHED",
                                   "description": VIDEOS["victoria-1"]["caption"]})
    entry = env.read_ledger()["victoria-1"]
    assert entry["state"] == "published" and entry["confirmed"] is True
    assert (entry["page_id"], entry["fb_video_id"], entry["post_id"]) == (VICTORIA, "777", "555")
    assert "scheduled_publish_time" not in entry
    out = capsys.readouterr().out
    assert "Published: victoria-1 on The Vic 361 (Meta video 777)" in out


def test_post_scheduled_sends_exactly_the_guides_requests_for_post_at_local(env, capsys):
    s = FakeSession(PAGE, START(), UPLOADED, STATUS(), FINISHED, SCHEDULED)
    assert post(env, s, "--go") == 0
    # Sun Oct 25 18:30 in Victoria (CDT) is 23:30 UTC.
    assert_the_guides_requests(s, {"video_id": "777", "upload_phase": "finish", "video_state": "SCHEDULED",
                                   "scheduled_publish_time": str(OCT25),
                                   "description": VIDEOS["victoria-1"]["caption"]})
    entry = env.read_ledger()["victoria-1"]
    assert entry["state"] == "scheduled" and entry["confirmed"] is True
    assert entry["scheduled_for_utc"] == "2026-10-25T23:30:00Z"
    assert entry["scheduled_for_local"] == "2026-10-25T18:30:00-05:00"
    assert entry["scheduled_publish_time"] == OCT25 and entry["timezone"] == "America/Chicago"
    assert entry["meta_status"]["publish_status"] == "scheduled"
    out = capsys.readouterr().out
    assert "Scheduled: victoria-1 goes live Sun Oct 25 2026, 6:30 PM CDT (2026-10-25 23:30 UTC)" in out


def test_nov_1_is_after_dst_ends_so_it_is_0030_utc_on_nov_2(env):
    s = FakeSession(PAGE, START(), UPLOADED, STATUS(), FINISHED,
                    STATUS(publishing__publish_status="scheduled", publishing__publish_time=NOV1))
    assert post(env, s, "--go", "--allow-draft", vid="victoria-3") == 0
    assert s.calls[4]["data"]["scheduled_publish_time"] == str(NOV1)
    entry = env.read_ledger()["victoria-3"]
    assert entry["scheduled_for_utc"] == "2026-11-02T00:30:00Z"
    assert entry["scheduled_for_local"] == "2026-11-01T18:30:00-06:00"


def test_at_overrides_the_time_in_the_towns_own_zone(env):
    medford_page = towns.TOWNS["medford"]["page_id"]
    s = FakeSession(ok({"access_token": PAGE_TOKEN, "name": "The Rogue 541"}), START(), UPLOADED, STATUS(),
                    FINISHED, STATUS(publishing__publish_status="scheduled"))
    assert post(env, s, "--at", "2026-10-28T09:15", "--go", vid="medford-1") == 0
    assert routes(s)[0] == ("GET", f"{G}/{medford_page}")
    want = dt.datetime(2026, 10, 28, 16, 15, tzinfo=dt.timezone.utc)  # PDT is UTC-7
    assert s.calls[4]["data"]["scheduled_publish_time"] == str(int(want.timestamp()))
    assert s.calls[4]["url"] == f"{G}/{medford_page}/video_reels"


def test_caption_override_becomes_the_description(env):
    s = FakeSession(PAGE, START(), UPLOADED, STATUS(), FINISHED, LIVE)
    assert post(env, s, "--now", "--go", "--caption", "Free every Mon & Thu #VictoriaTX") == 0
    assert s.calls[4]["data"]["description"] == "Free every Mon & Thu #VictoriaTX"
    assert env.read_ledger()["victoria-1"]["caption"] == "Free every Mon & Thu #VictoriaTX"


def test_upload_goes_to_metas_upload_url_only_on_rupload():
    assert pr.upload_url(f"{R}/777", "777") == f"{R}/777"
    # The guide's example answer has no version in it; that's Meta's to say.
    assert pr.upload_url("https://rupload.facebook.com/video-upload/777", "777") == \
        "https://rupload.facebook.com/video-upload/777"
    for bad in ("http://rupload.facebook.com/video-upload/777", "https://evil.example/video-upload/777",
                "https://rupload.facebook.com.evil.example/777", "https://me@rupload.facebook.com/777",
                "https://rupload.facebook.com:8443/777", "", None, "https://[::1"):
        assert pr.upload_url(bad, "777") == f"{R}/777"


def test_a_foreign_upload_url_never_gets_the_page_token(env):
    s = FakeSession(PAGE, START(url="https://evil.example/up/777"), UPLOADED, STATUS(), FINISHED, LIVE)
    assert post(env, s, "--now", "--go") == 0
    assert s.calls[2]["url"] == f"{R}/777"
    assert not any("evil.example" in c["url"] for c in s.calls)


# ------------------------------------------------------------------ dry run

def test_dry_run_makes_no_network_calls_and_says_what_it_would_do(env, monkeypatch, capsys):
    def no_network(*args, **kwargs):
        raise AssertionError("a dry run touched the network")

    monkeypatch.setattr(requests.Session, "request", no_network)
    monkeypatch.setattr(socket.socket, "connect", no_network)
    path = env.reel()
    s = FakeSession()
    assert pr.main(["post", path, "--video", "victoria-1", "--ledger", env.ledger], session=s) == 0
    assert pr.main(["post", path, "--video", "victoria-1", "--ledger", env.ledger]) == 0  # its own session
    assert s.calls == []
    out = capsys.readouterr().out
    assert out.startswith("DRY RUN: victoria-1 (Halloween week)")
    assert f"The Vic 361, Page id {VICTORIA}" in out
    assert VIDEOS["victoria-1"]["caption"] in out
    assert "Sun Oct 25 2026, 6:30 PM CDT (America/Chicago)" in out
    assert f"2026-10-25 23:30 UTC, scheduled_publish_time {OCT25}" in out
    assert "ok    video: H.264 1080x1920, 30 fps, 16.0 s" in out
    assert "ok    audio: AAC LC, 48 kHz, stereo, 182 kb/s" in out
    assert f"POST {R}/<video id>  {len(CONTENT):,} bytes, offset 0" in out
    assert "nothing was sent. Add --go to post it." in out
    assert "META_TOKEN is set" in out
    assert_no_tokens(out)
    assert not os.path.exists(env.ledger)


def test_dry_run_with_problems_exits_1_still_without_calls(env, capsys):
    env.probe = probe_with(video={"width": 1080, "height": 1350})
    s = FakeSession()
    assert post(env, s, "--now") == 1
    assert s.calls == []
    out = capsys.readouterr().out
    assert "When:     now (video_state PUBLISHED)" in out
    assert "NO    1080x1350 isn't 9:16" in out
    assert "--go would refuse until these are fixed:\n  - 1080x1350 isn't 9:16" in out


def test_dry_run_needs_no_token(env, monkeypatch, capsys):
    monkeypatch.delenv("META_TOKEN")
    assert post(env, FakeSession()) == 0
    assert "META_TOKEN isn't set (--go needs it)" in capsys.readouterr().out


def test_go_without_a_token_refuses_before_any_call(env, monkeypatch, capsys):
    monkeypatch.delenv("META_TOKEN")
    s = FakeSession()
    assert post(env, s, "--go") == 1
    assert s.calls == []
    assert "META_TOKEN (or META_PAGE_TOKEN) isn't set" in capsys.readouterr().err


def test_meta_page_token_is_the_fallback(env, monkeypatch):
    monkeypatch.delenv("META_TOKEN")
    monkeypatch.setenv("META_PAGE_TOKEN", SYSTEM_TOKEN)
    s = FakeSession(PAGE, START(), UPLOADED, STATUS(), FINISHED, LIVE)
    assert post(env, s, "--now", "--go") == 0
    assert s.calls[0]["headers"] == {"Authorization": f"Bearer {SYSTEM_TOKEN}"}


# ------------------------------------------------------------------ time

@pytest.mark.parametrize("text, zone, utc", [
    ("2026-10-25T18:30", "America/Chicago", dt.datetime(2026, 10, 25, 23, 30)),
    ("2026-11-01T18:30", "America/Chicago", dt.datetime(2026, 11, 2, 0, 30)),   # DST ended that morning
    ("2026-10-25T18:30", "America/Los_Angeles", dt.datetime(2026, 10, 26, 1, 30)),
    ("2026-11-01T18:30", "America/New_York", dt.datetime(2026, 11, 1, 23, 30)),
])
def test_local_time_to_utc(text, zone, utc):
    local, got = pr.local_time(text, zone)
    assert got == utc.replace(tzinfo=dt.timezone.utc)
    assert local.replace(tzinfo=None) == dt.datetime.strptime(text, "%Y-%m-%dT%H:%M")


def test_the_dst_change_moves_the_offset_by_an_hour():
    oct25, _ = pr.local_time("2026-10-25T18:30", "America/Chicago")
    nov1, _ = pr.local_time("2026-11-01T18:30", "America/Chicago")
    assert oct25.utcoffset() == dt.timedelta(hours=-5) and oct25.tzname() == "CDT"
    assert nov1.utcoffset() == dt.timedelta(hours=-6) and nov1.tzname() == "CST"
    assert int(pr.local_time("2026-10-25T18:30", "America/Chicago")[1].timestamp()) == OCT25
    assert int(pr.local_time("2026-11-01T18:30", "America/Chicago")[1].timestamp()) == NOV1


def test_every_scripted_post_time_is_a_real_unambiguous_town_time():
    for v in VIDEOS.values():
        local, utc = pr.local_time(v["post_at_local"], towns.TOWNS[v["town"]]["timezone"])
        assert local.hour == 18 and local.minute == 30
        assert utc.astimezone(local.tzinfo) == local


def test_a_repeated_or_skipped_wall_time_is_refused():
    with pytest.raises(pr.PostError, match="happens twice"):
        pr.local_time("2026-11-01T01:30", "America/Chicago")
    with pytest.raises(pr.PostError, match="doesn't exist"):
        pr.local_time("2027-03-14T02:30", "America/Chicago")
    with pytest.raises(pr.PostError, match="isn't a time like"):
        pr.local_time("2026-10-25 6:30pm", "America/Chicago")


@pytest.mark.parametrize("ahead, problem", [
    (dt.timedelta(minutes=-5), "in the past"),
    (dt.timedelta(0), "in the past"),
    (dt.timedelta(minutes=5), "more than 10 minutes"),
    (dt.timedelta(minutes=10), "more than 10 minutes"),
    (dt.timedelta(minutes=10, seconds=1), None),
    (dt.timedelta(days=29), None),
    (dt.timedelta(days=29, minutes=1), "at most 29 days"),
])
def test_the_scheduling_window_from_the_guide(ahead, problem):
    if problem is None:
        pr.check_window(NOW + ahead, NOW)
    else:
        with pytest.raises(pr.PostError, match=problem):
            pr.check_window(NOW + ahead, NOW)


def test_a_past_post_time_is_refused_before_any_call(env, capsys):
    env.now = dt.datetime(2026, 10, 26, 12, 0, tzinfo=dt.timezone.utc)
    s = FakeSession()
    assert post(env, s, "--go") == 1
    assert s.calls == []
    err_text = capsys.readouterr().err
    assert "2026-10-25 23:30 UTC is in the past; use --now" in err_text


def test_the_window_is_checked_again_before_finishing(env):
    # 15 minutes ahead when it starts, 9 once the upload is done: no finish.
    def slow_upload(call):
        env.now = NOW + dt.timedelta(minutes=6)
        return UPLOADED

    s = FakeSession(PAGE, START(), slow_upload, STATUS())
    assert post(env, s, "--at", "2026-10-23T13:15", "--go") == 1
    assert len(s.calls) == 4
    entry = env.read_ledger()["victoria-1"]
    assert entry["state"] == "failed" and "only 9 minutes away" in entry["error"]["message"]


# ------------------------------------------------------------------ ledger

def _scheduled_entry(**extra):
    return {"video": "victoria-1", "town": "victoria", "page_id": VICTORIA, "state": "scheduled",
            "fb_video_id": "111", "scheduled_for_utc": "2026-10-25T23:30:00Z",
            "finished_at": "2026-10-23T12:00:00Z", **extra}


@pytest.mark.parametrize("state", ["scheduled", "published", "pending"])
def test_a_video_is_not_posted_twice(env, capsys, state):
    env.write_ledger({"victoria-1": _scheduled_entry(state=state)})
    s = FakeSession()
    assert post(env, s, "--go") == 1
    assert s.calls == []
    err_text = capsys.readouterr().err
    assert f"victoria-1 is already {state}" in err_text and "--force" in err_text
    assert env.read_ledger()["victoria-1"]["state"] == state


def test_force_posts_again_and_keeps_the_history(env, capsys):
    env.write_ledger({"victoria-1": _scheduled_entry()})
    s = FakeSession(PAGE, START(), UPLOADED, STATUS(), FINISHED, SCHEDULED)
    assert post(env, s, "--go", "--force") == 0
    entry = env.read_ledger()["victoria-1"]
    assert entry["fb_video_id"] == "777" and entry["state"] == "scheduled"
    assert entry["previous"][0]["fb_video_id"] == "111"
    assert "earlier reel (Meta video 111) stays on the Page" in capsys.readouterr().out


@pytest.mark.parametrize("state", ["failed", "error", "uploaded", "uploading"])
def test_an_attempt_that_never_went_public_does_not_block(env, state):
    env.write_ledger({"victoria-1": _scheduled_entry(state=state)})
    s = FakeSession(PAGE, START(), UPLOADED, STATUS(), FINISHED, SCHEDULED)
    assert post(env, s, "--go") == 0
    assert env.read_ledger()["victoria-1"]["previous"][0]["state"] == state


def test_an_unreadable_ledger_stops_everything(env, capsys):
    os.makedirs(os.path.dirname(env.ledger))
    with open(env.ledger, "w") as f:
        f.write("{not json")
    s = FakeSession()
    assert post(env, s, "--go") == 1
    assert s.calls == [] and "fix or move it first" in capsys.readouterr().err


def test_metas_30_a_day_limit_is_kept_from_the_ledger(env, capsys):
    recent = {f"x{i}": {"page_id": VICTORIA, "state": "published", "finished_at": "2026-10-23T10:00:00Z"}
              for i in range(30)}
    env.write_ledger(recent)
    s = FakeSession()
    assert post(env, s, "--go") == 1
    assert s.calls == [] and "30 reels went to this Page in the last 24 hours" in capsys.readouterr().err
    old = {k: dict(v, finished_at="2026-10-22T10:00:00Z") for k, v in recent.items()}
    assert pr.publishes_last_day(old, VICTORIA, NOW) == 0
    assert pr.publishes_last_day(recent, "other-page", NOW) == 0


def test_the_ledger_is_written_pending_before_the_finish_call(env):
    states = []

    def finish(call):
        states.append(env.read_ledger()["victoria-1"]["state"])
        return FINISHED

    s = FakeSession(PAGE, START(), UPLOADED, STATUS(), finish, SCHEDULED)
    assert post(env, s, "--go") == 0
    assert states == ["pending"]
    assert env.read_ledger()["victoria-1"]["finished_at"] == "2026-10-23T18:00:00Z"


def test_a_draft_needs_allow_draft(env, capsys):
    s = FakeSession()
    assert post(env, s, "--go", vid="victoria-3") == 1
    assert s.calls == [] and "victoria-3 is still a draft" in capsys.readouterr().err


def test_a_file_named_for_another_video_is_refused(env, capsys):
    s = FakeSession()
    assert post(env, s, "--go", path=env.reel("lincoln-2")) == 1
    assert s.calls == [] and "names lincoln-2, not victoria-1" in capsys.readouterr().err
    ids = list(VIDEOS)
    assert pr.other_video_in_path("out/renders/lincoln-2/reel-9x16.mp4", "victoria-1", ids) == "lincoln-2"
    assert pr.other_video_in_path("out/renders/victoria-1/reel-9x16.mp4", "victoria-1", ids) is None
    assert pr.other_video_in_path("out/victoria-10/reel.mp4", "victoria-1", ids) is None
    assert pr.other_video_in_path("/tmp/final.mp4", "victoria-1", ids) is None


def test_an_unknown_video_id(env, capsys):
    assert post(env, FakeSession(), vid="victoria-9") == 1
    assert "no video 'victoria-9' in scripts.json" in capsys.readouterr().err


# ------------------------------------------------------------------ errors

def test_graph_errors_carry_code_subcode_message_and_fbtrace_id():
    e = pr.graph_error({"error": {"message": "(#100) Invalid parameter", "type": "OAuthException", "code": 100,
                                  "error_subcode": 1363128, "fbtrace_id": "AbC123",
                                  "error_user_msg": "The video is too long."}}, 400, "POST /1/video_reels (finish)")
    assert (e.code, e.subcode, e.fbtrace_id, e.status, e.kind) == (100, 1363128, "AbC123", 400, "OAuthException")
    assert e.message == "POST /1/video_reels (finish): (#100) Invalid parameter (The video is too long.)"
    assert not e.transient
    assert str(e) == (e.message + " [code 100, subcode 1363128, HTTP 400, fbtrace_id AbC123]. "
                      "Meta refused the file: the duration must be 3 to 90 seconds")
    assert e.as_dict() == {"message": e.message, "code": 100, "subcode": 1363128, "fbtrace_id": "AbC123",
                           "status": 400, "kind": "OAuthException"}


def test_metas_real_bad_token_answer():
    # What graph.facebook.com answers for a token it can't parse.
    body = {"error": {"message": "Invalid OAuth access token - Cannot parse access token", "type": "OAuthException",
                      "code": 190, "fbtrace_id": "AM0Hbo68eVsiRoUIqi7Y7Ei"}}
    with pytest.raises(pr.PostError) as ei:
        pr._answer(Resp(400, body), "GET /me")
    e = ei.value
    assert (e.code, e.subcode, e.fbtrace_id, e.status) == (190, None, "AM0Hbo68eVsiRoUIqi7Y7Ei", 400)
    assert not e.transient and "invalid or expired" in str(e) and "META_TOKEN" in str(e)


def test_ruploads_debug_info_errors():
    # What rupload.facebook.com answers for a bad token.
    body = {"debug_info": {"retriable": False, "type": "NotAuthorizedError",
                           "message": "User not authorized to perform this request"}}
    e = pr.graph_error(body, 400, "POST rupload.facebook.com upload")
    assert e.kind == "NotAuthorizedError" and not e.transient and e.status == 400
    assert "User not authorized to perform this request (NotAuthorizedError)" in str(e)
    body["debug_info"].update(retriable=True, type="ProcessingFailedError")
    assert pr.graph_error(body, 400, "upload").transient


def test_an_error_body_with_http_200_still_raises():
    with pytest.raises(pr.PostError, match="code 100"):
        pr._answer(Resp(200, {"error": {"message": "nope", "code": 100}}), "GET /x")


def test_non_json_answers():
    with pytest.raises(pr.PostError) as ei:
        pr._answer(Resp(502, None, text="<html>Bad Gateway</html>"), "GET /x")
    assert ei.value.transient and ei.value.status == 502 and "HTTP 502" in str(ei.value)
    with pytest.raises(pr.PostError, match="wasn't a JSON object"):
        pr._answer(Resp(200, ["a list"]), "GET /x")


@pytest.mark.parametrize("code", [1, 2, 4, 17, 341])
def test_metas_wait_and_retry_codes_are_transient(code):
    assert pr.graph_error({"error": {"message": "x", "code": code}}, 400, "x").transient


@pytest.mark.parametrize("code", [10, 100, 190, 200, 368, 506, 613, 6000])
def test_other_codes_are_not_retried(code):
    assert not pr.graph_error({"error": {"message": "x", "code": code}}, 400, "x").transient


def test_5xx_and_is_transient_are_transient():
    assert pr.graph_error({"error": {"message": "x", "code": 100}}, 503, "x").transient
    assert pr.graph_error({"error": {"message": "x", "code": 999, "is_transient": True}}, 400, "x").transient


def test_a_retired_graph_version_is_named():
    e = pr.graph_error({"error": {"message": "Unsupported version", "code": 2635}}, 400, "x")
    assert "GRAPH_API_VERSION" in str(e) and pr.GRAPH_VERSION in str(e)


# ------------------------------------------------------------------ retries

def test_transient_errors_are_retried_with_bounded_backoff(env):
    s = FakeSession(err(500, 2), err(400, 4, "(#4) Application request limit reached"), PAGE)
    assert pr.page_access(pr.Graph(s), VICTORIA, SYSTEM_TOKEN) == (PAGE_TOKEN, "The Vic 361")
    assert len(s.calls) == 3 and env.sleeps == [5, 20]


def test_retries_stop_after_the_last_delay(env):
    s = FakeSession(err(503, 2), err(503, 2), err(503, 2))
    with pytest.raises(pr.PostError) as ei:
        pr.page_access(pr.Graph(s), VICTORIA, SYSTEM_TOKEN)
    assert len(s.calls) == 3 and env.sleeps == [5, 20] and ei.value.code == 2


def test_everything_else_stops_at_once_with_a_clear_message(env, capsys):
    s = FakeSession(err(400, 190, "Invalid OAuth access token - Cannot parse access token"))
    assert post(env, s, "--go") == 1
    assert len(s.calls) == 1 and env.sleeps == []
    err_text = capsys.readouterr().err
    assert "error: GET /1388965530960534?fields=access_token,name: Invalid OAuth access token" in err_text
    assert "code 190" in err_text and "fbtrace_id AtraceXYZ" in err_text and "set META_TOKEN" in err_text
    assert not os.path.exists(env.ledger)  # nothing was started


def test_network_errors_are_retried_and_named_by_type_only(env, capsys):
    s = FakeSession(requests.ConnectionError(f"https://graph.facebook.com/x?access_token={SYSTEM_TOKEN} refused"),
                    PAGE)
    assert pr.page_access(pr.Graph(s), VICTORIA, SYSTEM_TOKEN)[0] == PAGE_TOKEN
    out = capsys.readouterr().out
    assert "GET /1388965530960534?fields=access_token,name: ConnectionError; retrying in 5s" in out
    assert_no_tokens(out)


def test_a_dropped_upload_resumes_from_metas_byte_count(env):
    s = FakeSession(PAGE, START(), requests.ConnectionError("reset"),
                    STATUS(up="in_progress", uploading__bytes_transfered=1000),
                    UPLOADED, STATUS(), FINISHED, LIVE)
    assert post(env, s, "--now", "--go") == 0
    first, resume = s.calls[2], s.calls[4]
    assert first["url"] == resume["url"] == f"{R}/777"
    assert resume["headers"]["offset"] == "1000" and resume["headers"]["file_size"] == str(len(CONTENT))
    assert resume["data"] == CONTENT[1000:]
    assert s.calls[3]["params"] == {"fields": "status"} and env.sleeps[0] == 5


def test_an_offset_error_resumes_too(env):
    offset_error = Resp(400, {"debug_info": {"retriable": False, "type": "OffsetInvalidError",
                                             "message": "Request starting offset is invalid"}})
    s = FakeSession(PAGE, START(), offset_error, STATUS(up="in_progress", uploading__bytes_transfered=4096),
                    UPLOADED, STATUS(), FINISHED, LIVE)
    assert post(env, s, "--now", "--go") == 0
    assert s.calls[4]["headers"]["offset"] == "4096" and s.calls[4]["data"] == CONTENT[4096:]


def test_an_upload_meta_refuses_is_not_retried(env, capsys):
    refused = Resp(400, {"debug_info": {"retriable": False, "type": "NotAuthorizedError",
                                        "message": "User not authorized to perform this request"}})
    s = FakeSession(PAGE, START(), refused)
    assert post(env, s, "--go") == 1
    assert len(s.calls) == 3
    entry = env.read_ledger()["victoria-1"]
    assert entry["state"] == "failed" and entry["error"]["kind"] == "NotAuthorizedError"


def test_a_file_gone_before_the_upload_is_a_clean_failure(env, capsys):
    path = env.reel()

    def start_and_lose_the_file(call):
        os.remove(path)
        return START()

    s = FakeSession(PAGE, start_and_lose_the_file)
    assert post(env, s, "--go", path=path) == 1
    assert len(s.calls) == 2
    assert env.read_ledger()["victoria-1"]["state"] == "failed"
    assert f"error: can't read {path}" in capsys.readouterr().err


def test_a_finish_that_landed_despite_a_5xx_is_not_sent_twice(env):
    s = FakeSession(PAGE, START(), UPLOADED, STATUS(), err(500, 2), SCHEDULED, SCHEDULED)
    assert post(env, s, "--go") == 0
    assert [c["data"].get("upload_phase") for c in s.calls if c["method"] == "POST" and c["url"].startswith(G)] \
        == ["start", "finish"]
    assert env.read_ledger()["victoria-1"]["state"] == "scheduled"


def test_a_finish_that_did_not_land_is_sent_again(env):
    s = FakeSession(PAGE, START(), UPLOADED, STATUS(), err(500, 2), STATUS(), FINISHED, SCHEDULED)
    assert post(env, s, "--go") == 0
    finishes = [c for c in s.calls if isinstance(c["data"], dict) and c["data"].get("upload_phase") == "finish"]
    assert len(finishes) == 2 and finishes[0]["data"] == finishes[1]["data"]
    assert env.sleeps == [5]


def test_a_finish_that_never_answers_stays_pending(env, capsys):
    s = FakeSession(PAGE, START(), UPLOADED, STATUS(),
                    requests.ReadTimeout("read timed out"), STATUS(),
                    requests.ReadTimeout("read timed out"), STATUS(),
                    requests.ReadTimeout("read timed out"), STATUS())
    assert post(env, s, "--go") == 1
    entry = env.read_ledger()["victoria-1"]
    assert entry["state"] == "pending" and entry["fb_video_id"] == "777"
    assert "may have posted anyway" in capsys.readouterr().err
    # ...and a re-run won't post it again without --force.
    s2 = FakeSession()
    assert post(env, s2, "--go") == 1 and s2.calls == []
    assert "victoria-1 is already pending" in capsys.readouterr().err


def test_a_finish_meta_refuses_is_failed_and_not_retried(env, capsys):
    s = FakeSession(PAGE, START(), UPLOADED, STATUS(), err(400, 100, "(#100) Invalid parameter", trace="Ftrace"))
    assert post(env, s, "--go") == 1
    assert len(s.calls) == 5 and env.sleeps == []
    entry = env.read_ledger()["victoria-1"]
    assert entry["state"] == "failed"
    assert entry["error"] == {"message": "POST /1388965530960534/video_reels (finish): (#100) Invalid parameter",
                              "code": 100, "fbtrace_id": "Ftrace", "status": 400, "kind": "OAuthException"}
    assert "fbtrace_id Ftrace" in capsys.readouterr().err


def test_a_refusal_after_a_lost_answer_is_unconfirmed_not_failed(env):
    s = FakeSession(PAGE, START(), UPLOADED, STATUS(), requests.ReadTimeout("x"), STATUS(),
                    err(400, 100, "(#100) The video was already published"))
    assert post(env, s, "--go") == 1
    assert env.read_ledger()["victoria-1"]["state"] == "pending"


# ------------------------------------------------------------------ polling

def test_metas_processing_error_stops_before_finishing(env, capsys):
    bad = STATUS(video_status="processing",
                 processing__error={"message": "Resolution too low. Video must have a minimum resolution of 540p."})
    s = FakeSession(PAGE, START(), UPLOADED, bad)
    assert post(env, s, "--go") == 1
    assert len(s.calls) == 4  # no finish
    entry = env.read_ledger()["victoria-1"]
    assert entry["state"] == "failed" and "Resolution too low" in entry["error"]["message"]
    assert "nothing was published" in capsys.readouterr().err


def test_it_waits_while_meta_is_still_taking_the_file(env):
    s = FakeSession(PAGE, START(), UPLOADED, STATUS(up="in_progress", video_status="uploading"),
                    STATUS(proc="in_progress", video_status="processing"),
                    STATUS(proc="complete", video_status="ready"), FINISHED, SCHEDULED)
    assert post(env, s, "--go") == 0
    assert env.sleeps == [pr.POLL_EVERY, pr.POLL_EVERY]


def test_video_status_counts_when_meta_leaves_the_phases_out(env):
    s = FakeSession(PAGE, START(), UPLOADED, ok({"status": {"video_status": "uploading"}}),
                    ok({"status": {"video_status": "upload_complete"}}), FINISHED, SCHEDULED)
    assert post(env, s, "--go") == 0
    assert env.sleeps == [pr.POLL_EVERY]


def test_the_wait_has_a_deadline(env, monkeypatch, capsys):
    monkeypatch.setattr(pr, "PROCESS_DEADLINE", 12)
    s = FakeSession(PAGE, START(), UPLOADED, *[lambda call: STATUS(up="in_progress", video_status="uploading")] * 10)
    assert post(env, s, "--go") == 1
    polls = [c for c in s.calls if c["params"] == {"fields": "status"}]
    assert len(polls) == 4 and env.sleeps == [5, 5, 5]
    assert env.read_ledger()["victoria-1"]["state"] == "failed"
    assert "still didn't have the file" in capsys.readouterr().err


def test_an_unconfirmed_schedule_is_recorded_but_flagged(env, monkeypatch, capsys):
    monkeypatch.setattr(pr, "CONFIRM_DEADLINE", 8)
    s = FakeSession(PAGE, START(), UPLOADED, STATUS(), FINISHED, STATUS(), STATUS(), STATUS())
    assert post(env, s, "--go") == 0
    entry = env.read_ledger()["victoria-1"]
    assert entry["state"] == "scheduled" and entry["confirmed"] is False
    assert "hadn't confirmed it" in capsys.readouterr().out


def test_a_publishing_error_after_finish_is_recorded(env):
    s = FakeSession(PAGE, START(), UPLOADED, STATUS(), FINISHED,
                    STATUS(pub="error", publishing__error={"message": "Publishing failed"}))
    assert post(env, s, "--go") == 1
    entry = env.read_ledger()["victoria-1"]
    assert entry["state"] == "error" and "Publishing failed" in entry["error"]["message"]


# ------------------------------------------------------------------ the file

def check(tmp_path, info=GOOD_PROBE, keyframes=EVERY_2S, name="reel-9x16.mp4", content=CONTENT):
    p = tmp_path / name
    p.write_bytes(content)
    return pr.check_file(str(p), info=info, keyframes=keyframes)


def test_a_good_render_passes(tmp_path):
    rep = check(tmp_path)
    assert rep["problems"] == [] and rep["warnings"] == []
    assert rep["facts"][:2] == ["video: H.264 1080x1920, 30 fps, 16.0 s", "audio: AAC LC, 48 kHz, stereo, 182 kb/s"]


@pytest.mark.parametrize("info, problem", [
    (probe_with(video={"width": 1080, "height": 1350}), "1080x1350 isn't 9:16"),
    (probe_with(video={"width": 1920, "height": 1080}), "1920x1080 isn't 9:16"),
    (probe_with(video={"width": 360, "height": 640}), "360x640 is under the 540x960 minimum"),
    (probe_with(video={"codec_name": "vp9"}), "video codec is vp9; post H.264 or HEVC"),
    (probe_with(video={"codec_name": "prores"}), "video codec is prores"),
    (probe_with(video={"avg_frame_rate": "20/1", "r_frame_rate": "20/1"}), "20.00 fps; Reels must be 24 to 60"),
    (probe_with(video={"avg_frame_rate": "120/1", "r_frame_rate": "120/1"}), "120.00 fps"),
    (probe_with(fmt={"duration": "2.5"}), "2.5 s long; Reels must be 3 to 90 seconds"),
    (probe_with(fmt={"duration": "95.0"}), "95.0 s long"),
    (probe_with(audio={"codec_name": "mp3"}), "audio codec is mp3; Reels need AAC"),
    (probe_with(audio=None), "no audio track"),
    (probe_with(video={"color_transfer": "arib-std-b67", "pix_fmt": "yuv420p10le", "codec_name": "hevc"}),
     "HDR video (HLG): a raw iPhone take"),
    ({"streams": [GOOD_PROBE["streams"][1]], "format": {"duration": "16"}}, "no video stream"),
])
def test_files_meta_would_refuse(tmp_path, info, problem):
    rep = check(tmp_path, info=info)
    assert any(problem in p for p in rep["problems"]), rep["problems"]


@pytest.mark.parametrize("video", [
    {"codec_name": "hevc"},
    {"avg_frame_rate": "30000/1001", "r_frame_rate": "30000/1001"},
    {"avg_frame_rate": "24000/1001", "r_frame_rate": "24000/1001"},   # a phone's "24"
    {"avg_frame_rate": "60/1", "r_frame_rate": "60/1"},
    {"width": 540, "height": 960},
    {"width": 2160, "height": 3840},
    {"width": 1080, "height": 1918},                                  # within 1% of 9:16
])
def test_files_inside_the_limits(tmp_path, video):
    assert check(tmp_path, info=probe_with(video=video))["problems"] == []


def test_the_frame_rate_is_shown_as_it_is(tmp_path):
    ntsc = probe_with(video={"avg_frame_rate": "30000/1001", "r_frame_rate": "30000/1001"})
    assert check(tmp_path, info=ntsc)["facts"][0] == "video: H.264 1080x1920, 29.97 fps, 16.0 s"
    assert check(tmp_path)["facts"][0] == "video: H.264 1080x1920, 30 fps, 16.0 s"


def test_a_rotated_phone_take_counts_as_vertical(tmp_path):
    rotated = probe_with(video={"width": 1920, "height": 1080, "side_data_list": [{"rotation": -90}]})
    assert check(tmp_path, info=rotated)["problems"] == []
    tagged = probe_with(video={"width": 1920, "height": 1080, "tags": {"rotate": "90"}})
    assert check(tmp_path, info=tagged)["problems"] == []
    assert pr.display_size({"width": 1440, "height": 1920, "sample_aspect_ratio": "3:4"}) == (1080, 1920)


def test_the_recommended_settings_only_warn(tmp_path):
    info = probe_with(video={"avg_frame_rate": "29.5", "r_frame_rate": "30/1", "pix_fmt": "yuv422p",
                             "field_order": "tt"},
                      audio={"profile": "HE-AAC", "sample_rate": "44100", "channels": 1, "bit_rate": "96000"})
    rep = check(tmp_path, info=info, keyframes=[0.0, 8.333, 13.6], name="reel.mov")
    assert rep["problems"] == []
    text = " | ".join(rep["warnings"])
    for needle in ("variable frame rate", "4:2:0", "progressive", "keyframes up to 8.3 s apart", "AAC Low Complexity",
                   "48 kHz", "mono audio", "96 kb/s", "not an .mp4"):
        assert needle in text, needle


def test_the_size_cap_and_missing_or_empty_files(tmp_path, monkeypatch):
    monkeypatch.setattr(pr, "MAX_BYTES", 100)
    assert any("over this tool's" in p for p in check(tmp_path)["problems"])
    assert check(tmp_path, content=b"")["problems"][0] == "the file is empty"
    assert pr.check_file(str(tmp_path / "nope.mp4"))["problems"] == [f"no such file: {tmp_path / 'nope.mp4'}"]


def test_an_unreadable_file_is_a_problem_not_a_crash(tmp_path, monkeypatch):
    def broken(path):
        raise pr.PostError("ffprobe couldn't read the file: moov atom not found")

    monkeypatch.setattr(pr, "probe", broken)
    p = tmp_path / "reel.mp4"
    p.write_bytes(b"not a video")
    assert pr.check_file(str(p))["problems"] == ["ffprobe couldn't read the file: moov atom not found"]


# ------------------------------------------------------------------ tokens

def test_tokens_only_ever_travel_in_the_authorization_header(env):
    s = FakeSession(PAGE, START(), UPLOADED, STATUS(), FINISHED, SCHEDULED)
    assert post(env, s, "--go") == 0
    for c in s.calls:
        visible = c["url"] + json.dumps(c["params"]) + (json.dumps(c["data"]) if isinstance(c["data"], dict) else "")
        visible += json.dumps({k: v for k, v in c["headers"].items() if k != "Authorization"})
        assert_no_tokens(visible)
        assert c["headers"]["Authorization"] in (f"Bearer {SYSTEM_TOKEN}", f"Bearer {PAGE_TOKEN}",
                                                 f"OAuth {PAGE_TOKEN}")
    with open(env.ledger, encoding="utf-8") as f:
        assert_no_tokens(f.read())


def test_a_token_meta_or_the_network_echoes_never_reaches_output_or_exceptions(env, capsys):
    echoed = err(400, 100, f"Bad request for token {PAGE_TOKEN} and {SYSTEM_TOKEN}")
    s = FakeSession(requests.ConnectionError(f"failed for {SYSTEM_TOKEN}"), PAGE, START(), UPLOADED, STATUS(), echoed)
    assert post(env, s, "--go") == 1
    captured = capsys.readouterr()
    assert_no_tokens(captured.out, captured.err)
    assert "[token]" in captured.err
    with open(env.ledger, encoding="utf-8") as f:
        assert_no_tokens(f.read())
    e = pr.graph_error({"error": {"message": f"x {PAGE_TOKEN}", "code": 1, "fbtrace_id": "t"}}, 500, "GET /x")
    assert_no_tokens(str(e), repr(e), repr(e.args), json.dumps(e.as_dict()))


def test_a_token_with_a_line_break_is_refused_without_echoing_it(env, monkeypatch, capsys):
    monkeypatch.setenv("META_TOKEN", "EAAbroken" + "x" * 30 + "\nmore" + "y" * 30)
    s = FakeSession()
    assert pr.main(["check"], session=s) == 1
    assert s.calls == []
    captured = capsys.readouterr()
    assert "META_TOKEN has spaces or line breaks" in captured.err and "EAAbroken" not in captured.err


# ------------------------------------------------------------------ check

def check_answers(perms=pr.POSTING + pr.INSIGHTS, slugs=None):
    answers = [ok({"id": "61550000000", "name": "Reels poster"}),
               ok({"data": [{"permission": p, "status": "granted"} for p in perms]
                   + [{"permission": "ads_read", "status": "declined"}]})]
    for slug in slugs or towns.TOWNS:
        t = towns.TOWNS[slug]
        answers += [ok({"access_token": f"EAApage{slug}" + "q" * 40, "name": t["name"], "id": t["page_id"]}),
                    ok({"data": []})]
    return answers


def test_check_resolves_every_pages_token_and_reports_permissions(env, capsys):
    s = FakeSession(*check_answers())
    assert pr.main(["check"], session=s) == 0
    assert routes(s)[:2] == [("GET", f"{G}/me"), ("GET", f"{G}/me/permissions")]
    assert s.calls[0]["params"] == {"fields": "id,name"}
    for i, (slug, t) in enumerate(towns.TOWNS.items()):
        lookup, reels = s.calls[2 + 2 * i], s.calls[3 + 2 * i]
        assert (lookup["url"], lookup["params"]) == (f"{G}/{t['page_id']}", {"fields": "access_token,name"})
        assert lookup["headers"] == {"Authorization": f"Bearer {SYSTEM_TOKEN}"}
        assert (reels["url"], reels["params"]) == (f"{G}/{t['page_id']}/video_reels", {"limit": "1"})
        assert reels["headers"] == {"Authorization": f"Bearer EAApage{slug}" + "q" * 40}
    out = capsys.readouterr().out
    assert "Token: META_TOKEN, Reels poster (id 61550000000)" in out
    assert "posting reels (pages_show_list, pages_read_engagement, pages_manage_posts): all granted" in out
    assert "insights (read_insights): granted" in out
    assert "ads_read" not in out  # declined isn't granted
    for slug, t in towns.TOWNS.items():
        assert f"{slug}: {t['name']} ({t['page_id']}): Page token OK, can read its reels" in out
    assert out.rstrip().endswith("Ready to post reels.")
    assert_no_tokens(out)
    assert "EAApage" not in out


def test_check_says_what_is_missing(env, capsys):
    s = FakeSession(*check_answers(perms=("pages_show_list", "pages_read_engagement")))
    assert pr.main(["check"], session=s) == 1
    out = capsys.readouterr().out
    assert "MISSING pages_manage_posts" in out and "MISSING read_insights" in out
    assert "Generate new token" in out and "Not ready to post" in out


def test_check_without_read_insights_can_still_post(env, capsys):
    s = FakeSession(*check_answers(perms=pr.POSTING))
    assert pr.main(["check"], session=s) == 0
    assert "insights (read_insights): MISSING read_insights" in capsys.readouterr().out


def test_check_when_meta_wont_list_permissions(env, capsys):
    answers = check_answers()
    answers[1] = err(400, 100, "(#100) Tried accessing nonexisting field (permissions)")
    assert pr.main(["check"], session=FakeSession(*answers)) == 0
    assert "Meta won't list them for this token" in capsys.readouterr().out


def test_check_flags_a_page_the_token_cant_reach(env, capsys):
    answers = check_answers()
    answers[4] = err(400, 100, "(#100) Object with ID '1436967576160283' does not exist", subcode=33)
    assert pr.main(["check"], session=FakeSession(*answers)) == 1
    out = capsys.readouterr().out
    assert "lincoln: Page 1436967576160283: NO Page token:" in out and "subcode 33" in out
    assert "Not ready to post" in out


def test_check_notices_a_page_id_pointing_at_another_page(env, capsys):
    answers = check_answers(slugs=["shoals"])
    answers[2] = ok({"access_token": "EAApageshoals" + "q" * 40, "name": "Some Other Page"})
    assert pr.main(["check", "--town", "shoals"], session=FakeSession(*answers)) == 0
    assert "towns.py says Shoals Setlist: is the page_id right?" in capsys.readouterr().out


def test_check_one_town(env):
    s = FakeSession(*check_answers(slugs=["lincoln"]))
    assert pr.main(["check", "--town", "lincoln"], session=s) == 0
    assert len(s.calls) == 4
    assert all("1436967576160283" in c["url"] for c in s.calls[2:])


def test_check_with_a_dead_token(env, capsys):
    s = FakeSession(err(400, 190, "Invalid OAuth access token - Cannot parse access token"))
    assert pr.main(["check"], session=s) == 1
    out = capsys.readouterr().out
    assert "META_TOKEN doesn't work" in out and "invalid or expired" in out and len(s.calls) == 1


def test_check_without_a_token(env, monkeypatch, capsys):
    monkeypatch.delenv("META_TOKEN")
    s = FakeSession()
    assert pr.main(["check"], session=s) == 1
    assert s.calls == [] and "isn't set" in capsys.readouterr().out


# ------------------------------------------------------------------ status

def _ledger_for_status():
    return {
        "victoria-1": {"video": "victoria-1", "town": "victoria", "page_id": VICTORIA, "state": "scheduled",
                       "fb_video_id": "777", "scheduled_for_utc": "2026-10-25T23:30:00Z"},
        "victoria-2": {"video": "victoria-2", "town": "victoria", "page_id": VICTORIA, "state": "published",
                       "fb_video_id": "888", "updated_at": "2026-10-20T12:00:00Z"},
        "lincoln-1": {"video": "lincoln-1", "town": "lincoln", "page_id": "1436967576160283",
                      "state": "scheduled", "fb_video_id": "999", "scheduled_for_utc": "2026-10-25T23:30:00Z"},
    }


def test_status_shows_the_pages_reels_the_scheduled_ones_and_the_ledger(env, capsys):
    OCT20_NOON = int(dt.datetime(2026, 10, 20, 12, 0, tzinfo=dt.timezone.utc).timestamp())
    env.write_ledger(_ledger_for_status())
    listed = ok({"data": [{"id": "888", "description": "Calaveras & Cocktails, Zoo Boo, Malloween and a free Coco "
                                                       "screening at DeLeon Plaza. Get the full list",
                           "published": True, "created_time": "2026-10-20T12:00:05+0000",
                           "permalink_url": "/1388965530960534/videos/888/",
                           "status": {"video_status": "ready",
                                      "publishing_phase": {"status": "complete", "publish_status": "published",
                                                           "publish_time": OCT20_NOON}}}]})
    scheduled = ok({"id": "777", "description": VIDEOS["victoria-1"]["caption"], "published": False,
                    "scheduled_publish_time": OCT25,
                    "status": {"video_status": "ready",
                               "publishing_phase": {"status": "not_started", "publish_status": "scheduled",
                                                    "publish_time": OCT25}}})
    s = FakeSession(PAGE, listed, scheduled)
    assert pr.main(["status", "--town", "victoria", "--ledger", env.ledger], session=s) == 0
    assert routes(s) == [("GET", f"{G}/{VICTORIA}"), ("GET", f"{G}/{VICTORIA}/video_reels"), ("GET", f"{G}/777")]
    assert s.calls[1]["params"] == {"fields": pr.REEL_FIELDS, "limit": "10"}
    assert s.calls[2]["params"] == {"fields": pr.REEL_FIELDS}
    assert s.calls[1]["headers"] == s.calls[2]["headers"] == {"Authorization": f"Bearer {PAGE_TOKEN}"}
    out = capsys.readouterr().out
    assert '888  published Tue Oct 20 2026, 7:00 AM CDT  "Calaveras & Cocktails' in out
    assert "777  scheduled for Sun Oct 25 2026, 6:30 PM CDT (2026-10-25 23:30 UTC)" in out
    assert '"8 trunk-or-treats, haunted mini golf inside the library..."' in out
    assert 'a free Coco..."  https://www.facebook.com/1388965530960534/videos/888/' in out
    assert "victoria-1  scheduled for Sun Oct 25 2026, 6:30 PM CDT (2026-10-25 23:30 UTC)  Meta video 777" in out
    assert "[Meta: scheduled for" in out and "victoria-2  published" in out
    assert "lincoln-1" not in out
    assert_no_tokens(out)


def test_status_without_a_token_shows_the_ledger_only(env, monkeypatch, capsys):
    monkeypatch.delenv("META_TOKEN")
    env.write_ledger(_ledger_for_status())
    s = FakeSession()
    assert pr.main(["status", "--ledger", env.ledger], session=s) == 0
    assert s.calls == []
    out = capsys.readouterr().out
    assert "local ledger only" in out
    assert "victoria-1  scheduled for Sun Oct 25 2026, 6:30 PM CDT" in out
    assert "lincoln-1  scheduled for Sun Oct 25 2026, 6:30 PM CDT" in out
    assert "medford: The Rogue 541" in out and "nothing posted from here yet" in out


def test_status_falls_back_when_a_field_is_refused(env):
    refused = err(400, 100, "(#100) Tried accessing nonexisting field (scheduled_publish_time)")
    listed = ok({"data": [{"id": "1", "description": "x", "updated_time": "2026-10-22T12:00:00+0000"}]})
    s = FakeSession(PAGE, refused, listed)
    assert pr.main(["status", "--town", "victoria", "--ledger", env.ledger], session=s) == 0
    assert s.calls[2]["params"] == {"limit": "10"}


def test_status_reports_a_page_it_cant_read(env, capsys):
    s = FakeSession(err(400, 200, "(#200) Permissions error"))
    assert pr.main(["status", "--town", "victoria", "--ledger", env.ledger], session=s) == 1
    assert "Couldn't read the Page" in capsys.readouterr().out


# ------------------------------------------------------------------ misc

def test_graph_api_version_overrides_both_hosts():
    code = "import post_reel; print(post_reel.GRAPH); print(post_reel.RUPLOAD)"
    run = subprocess.run([sys.executable, "-c", code], cwd=VIDEO, capture_output=True, text=True, timeout=60,
                         env={**os.environ, "GRAPH_API_VERSION": "24.0"})
    assert run.stdout.split() == ["https://graph.facebook.com/v24.0", "https://rupload.facebook.com/video-upload/v24.0"]
    env = {k: v for k, v in os.environ.items() if k != "GRAPH_API_VERSION"}
    run = subprocess.run([sys.executable, "-c", code], cwd=VIDEO, capture_output=True, text=True, timeout=60, env=env)
    assert run.stdout.split() == ["https://graph.facebook.com/v23.0", "https://rupload.facebook.com/video-upload/v23.0"]


def test_now_and_at_dont_mix(env):
    with pytest.raises(SystemExit) as ei:
        post(env, FakeSession(), "--now", "--at", "2026-10-25T18:30")
    assert ei.value.code == 2


# ------------------------------------------------------------------ real ffprobe

needs_ffmpeg = pytest.mark.skipif(not (shutil.which("ffmpeg") and shutil.which("ffprobe")),
                                  reason="needs ffmpeg and ffprobe")


@pytest.fixture(scope="module")
def clips(tmp_path_factory):
    d = tmp_path_factory.mktemp("clips")

    def make(name, size, seconds):
        out = str(d / name)
        subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y",
                        "-f", "lavfi", "-i", f"testsrc2=size={size}:rate=30:duration={seconds}",
                        "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:duration={seconds}",
                        "-c:v", "libx264", "-preset", "ultrafast", "-g", "60", "-pix_fmt", "yuv420p",
                        "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-shortest", out],
                       check=True, timeout=120, capture_output=True)
        return out

    return {"good": make("good.mp4", "540x960", 3.5), "square": make("square.mp4", "540x540", 3.5),
            "short": make("short.mp4", "540x960", 2)}


@needs_ffmpeg
def test_real_ffprobe_passes_a_good_clip(clips):
    rep = pr.check_file(clips["good"])
    assert rep["problems"] == [] and rep["warnings"] == []
    assert rep["facts"][0].startswith("video: H.264 540x960, 30 fps, 3.5 s")
    assert rep["facts"][1].startswith("audio: AAC LC, 48 kHz, stereo")
    assert pr.keyframe_times(clips["good"])[:2] == [0.0, 2.0]


@needs_ffmpeg
def test_real_ffprobe_refuses_bad_clips(clips):
    assert any("isn't 9:16" in p for p in pr.check_file(clips["square"])["problems"])
    assert any("Reels must be 3 to 90 seconds" in p for p in pr.check_file(clips["short"])["problems"])


# ------------------------------------------------------------------ review fixes
# Each test below failed before its fix, except test_a_renders_own_tags_are_fine,
# which keeps the raw-take guard off real renders.

@pytest.mark.parametrize("failing_write, held", [(4, "pending"), (5, "scheduled")])
def test_a_ledger_write_failing_after_meta_took_the_finish_never_marks_it_failed(env, monkeypatch, capsys,
                                                                                failing_write, held):
    # Writes: uploading, uploaded, pending, then (4) right after Meta took
    # the finish and (5) after confirming. Before: the error handler wrote
    # "failed" over it, so the next run posted a second reel.
    real_save, writes = pr.save_ledger, []

    def flaky_save(path, data):
        writes.append(data["victoria-1"]["state"])
        if len(writes) == failing_write:
            raise OSError(28, "No space left on device")
        real_save(path, data)

    monkeypatch.setattr(pr, "save_ledger", flaky_save)
    s = FakeSession(PAGE, START(), UPLOADED, STATUS(), FINISHED, SCHEDULED)
    assert post(env, s, "--go") == 1
    assert len(writes) == failing_write  # no second try at writing it down
    assert env.read_ledger()["victoria-1"]["state"] == held
    err_text = capsys.readouterr().err
    assert "couldn't write" in err_text and "Meta took the reel all the same (Meta video 777)" in err_text
    monkeypatch.setattr(pr, "save_ledger", real_save)
    again = FakeSession()
    assert post(env, again, "--go") == 1 and again.calls == []
    assert f"victoria-1 is already {held}" in capsys.readouterr().err


def test_a_ledger_write_failing_before_the_finish_sends_nothing_more(env, monkeypatch, capsys):
    real_save, writes = pr.save_ledger, []

    def flaky_save(path, data):
        writes.append(data["victoria-1"]["state"])
        if data["victoria-1"]["state"] == "pending":
            raise OSError(13, "Permission denied")
        real_save(path, data)

    monkeypatch.setattr(pr, "save_ledger", flaky_save)
    s = FakeSession(PAGE, START(), UPLOADED, STATUS())
    assert post(env, s, "--go") == 1
    assert len(s.calls) == 4  # no finish call
    assert writes == ["uploading", "uploaded", "pending"]
    assert env.read_ledger()["victoria-1"]["state"] == "uploaded"
    assert "nothing more was sent to Meta" in capsys.readouterr().err


def test_the_pending_mark_is_on_disk_before_the_finish_goes_out(env, monkeypatch):
    synced = []
    real_fsync = os.fsync
    monkeypatch.setattr(os, "fsync", lambda fd: (synced.append(fd), real_fsync(fd))[1])

    def finish(call):
        assert synced, "the ledger was never fsynced"
        assert env.read_ledger()["victoria-1"]["state"] == "pending"
        return FINISHED

    s = FakeSession(PAGE, START(), UPLOADED, STATUS(), finish, SCHEDULED)
    assert post(env, s, "--go") == 0


@pytest.mark.skipif(pr.fcntl is None, reason="no flock on this platform")
def test_a_second_post_while_one_is_running_is_refused(env, capsys):
    # Before: both ran, and the first to start wrote its ledger over the
    # second's entry when it finished, so lincoln-1 could be posted again.
    lincoln = towns.TOWNS["lincoln"]["page_id"]
    second = {}

    def meanwhile(call):
        s2 = FakeSession()
        second["rc"] = post(env, s2, "--go", vid="lincoln-1")
        second["calls"] = s2.calls
        return STATUS()

    s = FakeSession(PAGE, START(), UPLOADED, meanwhile, FINISHED, SCHEDULED)
    assert post(env, s, "--go") == 0
    assert second == {"rc": 1, "calls": []}
    assert "another `post_reel.py post --go` is using" in capsys.readouterr().err
    # Once the first is done the second goes through, and both stay recorded.
    s3 = FakeSession(ok({"access_token": PAGE_TOKEN, "name": "The Star 402"}), START("888"), UPLOADED, STATUS(),
                     FINISHED, SCHEDULED)
    assert post(env, s3, "--go", vid="lincoln-1") == 0
    assert s3.calls[0]["url"] == f"{G}/{lincoln}"
    ledger = env.read_ledger()
    assert (ledger["victoria-1"]["state"], ledger["lincoln-1"]["state"]) == ("scheduled", "scheduled")


def test_a_post_that_lands_while_this_one_checks_the_file_is_seen_under_the_lock(env, monkeypatch, capsys):
    real_lock = pr.ledger_lock

    @contextlib.contextmanager
    def another_run_got_there_first(path):
        env.write_ledger({"victoria-1": _scheduled_entry()})
        with real_lock(path):
            yield

    monkeypatch.setattr(pr, "ledger_lock", another_run_got_there_first)
    s = FakeSession()
    assert post(env, s, "--go") == 1
    assert s.calls == []
    assert "victoria-1 is already scheduled" in capsys.readouterr().err


def test_a_lost_finish_is_looked_for_after_a_wait_not_at_once(env):
    # Meta's status can trail a finish that landed; read at once it may not
    # show it yet, and then a second finish went out.
    looked = []

    def status(call):
        looked.append(list(env.sleeps))
        return STATUS()

    s = FakeSession(PAGE, START(), UPLOADED, STATUS(), requests.ReadTimeout("read timed out"), status,
                    FINISHED, SCHEDULED)
    assert post(env, s, "--go") == 0
    assert looked == [[5]]
    finishes = [c for c in s.calls if isinstance(c["data"], dict) and c["data"].get("upload_phase") == "finish"]
    assert len(finishes) == 2


def test_the_last_lost_finish_also_waits_before_the_last_look(env, capsys):
    looked = []

    def status(call):
        looked.append(list(env.sleeps))
        return STATUS()

    timeout = requests.ReadTimeout("read timed out")
    s = FakeSession(PAGE, START(), UPLOADED, STATUS(), timeout, status, timeout, status, timeout, status)
    assert post(env, s, "--go") == 1
    assert looked == [[5], [5, 20], [5, 20, pr.POLL_EVERY]]
    assert env.read_ledger()["victoria-1"]["state"] == "pending"


def test_status_still_reads_our_reels_when_the_page_list_is_refused(env, capsys):
    # The Page video_reels reference says that edge can't be read at all.
    env.write_ledger(_ledger_for_status())
    refused = err(400, 100, "(#100) Unsupported get request", subcode=33)
    scheduled = ok({"id": "777", "published": False, "scheduled_publish_time": OCT25,
                    "status": {"publishing_phase": {"publish_status": "scheduled", "publish_time": OCT25}}})
    published = ok({"id": "888", "published": True, "created_time": "2026-10-20T12:00:05+0000"})
    s = FakeSession(PAGE, refused, scheduled, published)
    assert pr.main(["status", "--town", "victoria", "--ledger", env.ledger], session=s) == 1
    assert routes(s) == [("GET", f"{G}/{VICTORIA}"), ("GET", f"{G}/{VICTORIA}/video_reels"), ("GET", f"{G}/777"),
                         ("GET", f"{G}/888")]
    out = capsys.readouterr().out
    assert "Couldn't list the Page's reels" in out and "Ours, by id:" in out
    assert "777  scheduled for Sun Oct 25 2026, 6:30 PM CDT (2026-10-25 23:30 UTC)" in out
    assert "[Meta: scheduled for" in out


def test_a_token_with_a_pasted_curly_quote_is_refused_cleanly(env, monkeypatch, capsys):
    # Before: http.client's UnicodeEncodeError escaped as a traceback.
    monkeypatch.setenv("META_TOKEN", SYSTEM_TOKEN + "\u201d")
    s = FakeSession()
    assert pr.main(["check"], session=s) == 1
    assert s.calls == []
    captured = capsys.readouterr()
    assert "META_TOKEN has a character that isn't plain ASCII" in captured.err
    assert_no_tokens(captured.out, captured.err)
    assert post(env, FakeSession(), "--go") == 1
    assert "isn't plain ASCII" in capsys.readouterr().err


def test_a_header_http_cant_encode_is_a_post_error_not_a_crash():
    s = FakeSession(UnicodeEncodeError("latin-1", "Bearer x\u201d", 8, 9, "ordinal not in range(256)"))
    with pytest.raises(pr.PostError) as ei:
        pr.Graph(s).request("GET", f"{G}/me", "GET /me", "x" * 20)
    assert "can't carry" in str(ei.value) and not ei.value.transient


def test_metas_echoes_never_reach_the_ledger(env):
    # An error's "type" and a finish's post_id went into posted.json as is.
    echo = err(400, 100, "(#100) Invalid parameter", type=f"Bad {PAGE_TOKEN}")
    s = FakeSession(PAGE, START(), UPLOADED, STATUS(), echo)
    assert post(env, s, "--go") == 1
    with open(env.ledger, encoding="utf-8") as f:
        text = f.read()
    assert_no_tokens(text)
    assert env.read_ledger()["victoria-1"]["error"]["kind"] == "Bad [token]"
    s = FakeSession(PAGE, START("778"), UPLOADED, STATUS(), ok({"success": True, "post_id": PAGE_TOKEN}), SCHEDULED)
    assert post(env, s, "--go") == 0
    with open(env.ledger, encoding="utf-8") as f:
        assert_no_tokens(f.read())


IPHONE_TAGS = {"major_brand": "qt  ", "com.apple.quicktime.make": "Apple",
               "com.apple.quicktime.model": "iPhone 15 Pro",
               "com.apple.quicktime.location.ISO6709": "+28.8053-097.0036+030.000/"}


@pytest.mark.parametrize("tags, phone", [
    (IPHONE_TAGS, "iPhone 15 Pro and where it was filmed"),
    ({"com.apple.quicktime.make": "Apple"}, "(Apple)"),
    ({"location": "+28.8053-097.0036/", "com.android.version": "14"}, "a phone and where it was filmed"),
])
def test_a_take_with_the_cameras_tags_is_refused(tmp_path, tags, phone):
    # Before: an SDR iPhone take (HDR off) passed as a render.
    rep = check(tmp_path, info=probe_with(fmt={"tags": tags}), name="IMG_0412.MOV")
    assert any("a raw take, not a render" in p and phone in p for p in rep["problems"]), rep["problems"]


def test_a_renders_own_tags_are_fine(tmp_path):
    info = probe_with(fmt={"tags": {"major_brand": "isom", "compatible_brands": "isomiso2avc1mp41",
                                    "encoder": "Lavf60.16.100"}})
    assert check(tmp_path, info=info)["problems"] == []


def test_a_take_far_longer_than_the_cut_gets_a_note(tmp_path):
    rep = check(tmp_path, info=probe_with(fmt={"duration": "38.505"}))
    assert rep["problems"] == []
    assert "38.5 s long; edit.py cuts these to about 16 s (is this a raw take?)" in rep["warnings"]
    assert check(tmp_path, info=probe_with(fmt={"duration": "16.5"}))["warnings"] == []


@needs_ffmpeg
def test_real_ffprobe_sees_an_iphone_takes_tags(clips, tmp_path):
    out = str(tmp_path / "IMG_0412.MOV")
    subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-i", clips["good"], "-c", "copy",
                    "-movflags", "use_metadata_tags", "-metadata", "com.apple.quicktime.make=Apple",
                    "-metadata", "com.apple.quicktime.model=iPhone 15 Pro",
                    "-metadata", "com.apple.quicktime.location.ISO6709=+28.8053-097.0036+030.000/", out],
                   check=True, timeout=120, capture_output=True)
    assert any("a raw take, not a render" in p for p in pr.check_file(out)["problems"])
    assert pr.check_file(clips["good"])["problems"] == []


@needs_ffmpeg
def test_a_file_named_like_an_option_is_still_probed(clips, tmp_path, monkeypatch):
    # Before: ffprobe read "-final.mp4" as an option and refused a good file.
    shutil.copy(clips["good"], tmp_path / "-final.mp4")
    monkeypatch.chdir(tmp_path)
    rep = pr.check_file("-final.mp4")
    assert rep["problems"] == [] and rep["facts"][0].startswith("video: H.264 540x960")
    assert pr.keyframe_times("-final.mp4")[:2] == [0.0, 2.0]


def test_an_odd_status_answer_does_not_crash_the_run(env, monkeypatch):
    # Phases that aren't objects crashed confirm() with an AttributeError
    # after Meta had taken the finish.
    monkeypatch.setattr(pr, "CONFIRM_DEADLINE", 8)
    odd = ok({"status": {"video_status": "ready", "uploading_phase": "complete", "publishing_phase": "scheduled"}})
    s = FakeSession(PAGE, START(), UPLOADED, STATUS(), FINISHED, odd, odd, odd)
    assert post(env, s, "--go") == 0
    entry = env.read_ledger()["victoria-1"]
    assert entry["state"] == "scheduled" and entry["confirmed"] is False


@pytest.mark.skipif(pr.fcntl is None, reason="no flock on this platform")
def test_the_ledger_lock_holds_across_processes(env):
    # Two terminals are two processes: the lock must be the OS's, not ours.
    code = ("import sys, post_reel; cm = post_reel.ledger_lock(sys.argv[1]); cm.__enter__(); print('held', "
            "flush=True); sys.stdin.read()")
    child = subprocess.Popen([sys.executable, "-c", code, env.ledger], cwd=VIDEO, stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE, text=True)
    try:
        assert child.stdout.readline().strip() == "held"
        with pytest.raises(pr.PostError, match="another `post_reel.py post --go` is using"):
            with pr.ledger_lock(env.ledger):
                pass
    finally:
        child.stdin.close()
        child.wait(timeout=30)
    with pr.ledger_lock(env.ledger):  # free again once that process is gone
        pass


def test_a_lock_file_that_cant_be_opened_is_a_clean_refusal(env, capsys):
    # A folder where the lock file goes stands in for any spot it can't be
    # made (chmod means nothing to root): a clean refusal, not a traceback.
    os.makedirs(env.ledger + ".lock")
    s = FakeSession()
    assert post(env, s, "--go") == 1
    assert s.calls == []
    assert "can't open" in capsys.readouterr().err and not os.path.exists(env.ledger)
