"""ads.py: the subscribe videos as Meta ads, with Meta mocked out.

FakeMeta is a small Marketing API holding an account like the real one on
Oct 23 2026: the five towns' campaigns, paused, each with its own ad set and
ad (Victoria's ends Oct 25; the other four ended Oct 23), and Victoria's
"Vic Newsletter Leads - Copy" campaign. It answers every call ads.py makes,
changes its state on writes and records each request, so these tests pin
the exact requests (URL, form data, files, headers) of upload, go and stop.
None of them touches the network; ffprobe and ffmpeg are faked too.
"""
import base64
import copy
import datetime as dt
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import types
import urllib.parse

import pytest
import requests

VIDEO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, VIDEO)

import ads  # noqa: E402
import post_reel as pr  # noqa: E402
import towns  # noqa: E402

SYSTEM_TOKEN = "EAAsystemUserToken" + "s" * 60
UTC = dt.timezone.utc
NOW = dt.datetime(2026, 10, 23, 18, 0, tzinfo=UTC)   # Friday Oct 23, 1 PM in Victoria
G, N, VERSION = ads.GRAPH, ads.NETWORK_GRAPH, ads.GRAPH_VERSION
ACCOUNT = "act_2614503002399063"
OTHER_ACCOUNT = "act_263113944523091"
CONTENT = bytes(range(256)) * 40
JPEG = b"\xff\xd8\xff\xe0fake-jpeg-frame\xff\xd9"

# The account as read on Oct 23 (ids, names, budgets, ends, pixels).
VIC_CAMPAIGN, VIC_TEMPLATE, VIC_AD, VIC_CREATIVE = ("120250753433250269", "120250753433260269",
                                                    "120250753433270269", "1803108074291925")
VIC_IG = "17841462417680154"
COPY_CAMPAIGN, COPY_ADSET = "120250882002420269", "120250882002430269"
TIDE_CAMPAIGN, TIDE_TEMPLATE, TIDE_AD, TIDE_CREATIVE = ("120250885012130269", "120250885012290269",
                                                        "120250885295370269", "1120797317097243")
TIDE_IG = "17841425202694416"
STAR_CAMPAIGN, STAR_TEMPLATE, STAR_AD, STAR_CREATIVE = ("120250885021260269", "120250885021750269",
                                                        "120250885976460269", "1784502996216411")
ROGUE_CAMPAIGN, SHOALS_CAMPAIGN = "120250885026920269", "120250885034640269"
PAGE = {slug: towns.TOWNS[slug]["page_id"] for slug in towns.TOWNS}
VIC_PIXEL, SHARED_PIXEL = "1879768960047908", "2606572643148400"

VIDEOS = [
    {"id": "victoria-2026-10-25", "town": "victoria", "video": 1, "draft": False, "angle": "Halloween week",
     "post_at_local": "2026-10-25T18:00", "run_until_local": "2026-10-31T17:00",
     "headline": "Everything to do in Victoria, free",
     "caption": "8 trunk-or-treats, spooky mini golf inside the library, Zoo Boo and Malloween \U0001f383 "
                "Everything happening in Victoria, in one free email every Monday and Thursday. Sign up: "
                "https://www.thevic361.com/subscribe"},
    {"id": "victoria-2026-11-01", "town": "victoria", "video": 2, "draft": False, "angle": "Evergreen",
     "post_at_local": "2026-11-01T06:00", "run_until_local": None,
     "caption": "Live music, markets and festivals: everything in Victoria, free every Monday and Thursday."},
    {"id": "virginiabeach-2026-10-25", "town": "virginiabeach", "video": 1, "draft": False, "angle": "Halloween week",
     "post_at_local": "2026-10-25T18:00", "run_until_local": "2026-10-31T17:00",
     "headline": "Everything to do in Virginia Beach, free",
     "caption": "Dolphins, haunts and Hawthorne Heights. Free: https://www.thetide757.com/subscribe"},
    {"id": "lincoln-2026-10-25", "town": "lincoln", "video": 1, "draft": False, "angle": "Halloween week",
     "post_at_local": "2026-10-25T18:00", "run_until_local": "2026-10-31T17:00",
     "caption": "Stapleton, Ella Langley and a silent film with a live score. Free: https://www.thestar402.com/subscribe"},
    {"id": "victoria-draft", "town": "victoria", "video": 9, "draft": True, "angle": "Next week",
     "post_at_local": "2026-11-08T18:00", "run_until_local": "2026-11-14T17:00", "caption": "Soon."},
]
VIC1, VIC2, TIDE1, STAR1 = "victoria-2026-10-25", "victoria-2026-11-01", "virginiabeach-2026-10-25", "lincoln-2026-10-25"

GOOD_PROBE = {
    "streams": [
        {"index": 0, "codec_type": "video", "codec_name": "h264", "profile": "High", "width": 1080, "height": 1350,
         "sample_aspect_ratio": "1:1", "pix_fmt": "yuv420p", "avg_frame_rate": "30/1", "r_frame_rate": "30/1",
         "field_order": "progressive", "color_transfer": "bt709", "duration": "16.000000"},
        {"index": 1, "codec_type": "audio", "codec_name": "aac", "profile": "LC", "sample_rate": "48000",
         "channels": 2, "bit_rate": "183950"},
    ],
    "format": {"format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": "16.000000"},
}


def probe_with(video=None, fmt=None):
    info = copy.deepcopy(GOOD_PROBE)
    info["streams"][0].update(video or {})
    info["format"].update(fmt or {})
    return info


# ------------------------------------------------------------------ fakes

class Resp:
    def __init__(self, status=200, body=None):
        self.status_code = status
        self._body = body
        self.text = json.dumps(body)

    def json(self):
        if self._body is None:
            raise ValueError("not JSON")
        return self._body


def ok(body):
    return Resp(200, body)


def err(status, code, message="boom", **extra):
    return Resp(status, {"error": {"message": message, "type": "OAuthException", "code": code,
                                   "fbtrace_id": "AtraceXYZ", **extra}})


def _campaign(cid, name, budget, stop):
    return {"id": cid, "name": name, "account_id": ACCOUNT[4:], "status": "PAUSED", "objective": "OUTCOME_LEADS",
            "daily_budget": str(budget), "stop_time": stop}


def _adset(sid, cid, name, end, pixel, targeting, start="2026-10-16T03:36:20+0000"):
    return {"id": sid, "name": name, "account_id": ACCOUNT[4:], "campaign_id": cid, "status": "ACTIVE",
            "start_time": start, "end_time": end, "optimization_goal": "OFFSITE_CONVERSIONS",
            "promoted_object": {"custom_event_type": "LEAD", "pixel_id": pixel, "smart_pse_enabled": False},
            "targeting": targeting, "created_time": start}


def _ad(aid, cid, sid, name, creative):
    return {"id": aid, "name": name, "account_id": ACCOUNT[4:], "campaign_id": cid, "adset_id": sid,
            "status": "ACTIVE", "created_time": "2026-10-16T04:22:52+0000", "creative": {"id": creative}}


FB_ONLY = {"publisher_platforms": ["facebook"], "facebook_positions": ["feed", "story", "facebook_reels"]}


class FakeMeta:
    """The Marketing API calls ads.py makes, over a little state. faults are
    one-off answers for a route: (method, path regex, answer, after), where
    `after` means the call takes effect first and its answer is then lost."""

    def __init__(self):
        self.calls = []
        self.faults = []
        self.n = 0
        self.video_states = []
        self.insight_rows = {}
        self.page_size = None
        self.account = {"id": ACCOUNT, "name": "The Vic Ads", "currency": "USD", "timezone_name": "CST6CDT",
                        "account_status": 1}
        self.campaigns = {c["id"]: c for c in [
            _campaign(VIC_CAMPAIGN, "Vic Newsletter Leads", 6800, "2026-10-25T23:27:28+0000"),
            _campaign(COPY_CAMPAIGN, "Vic Newsletter Leads - Copy", 4000, "2026-10-30T04:01:00+0000"),
            _campaign(STAR_CAMPAIGN, "The Star 402 Newsletter Leads", 5500, "2026-10-23T05:00:00+0000"),
            _campaign(ROGUE_CAMPAIGN, "The Rogue 541 Newsletter Leads", 5500, "2026-10-23T05:00:00+0000"),
            _campaign(SHOALS_CAMPAIGN, "Shoals Setlist Newsletter Leads", 5500, "2026-10-23T05:00:00+0000"),
            _campaign(TIDE_CAMPAIGN, "The Tide 757 Newsletter Leads", 5500, "2026-10-23T05:00:00+0000"),
        ]}
        vic_target = {"age_min": 18, "age_max": 65, "geo_locations": {"places": [
            {"name": "Victoria, Tx", "radius": 12, "distance_unit": "mile"}]}}
        tide_target = {"age_min": 18, "age_max": 65, "publisher_platforms": ["facebook", "instagram"],
                       "facebook_positions": ["feed", "story", "facebook_reels"],
                       "instagram_positions": ["stream", "story", "reels"],
                       "geo_locations": {"cities": [{"name": "Virginia Beach", "radius": 25, "distance_unit": "mile"}]}}
        star_target = dict(FB_ONLY, age_min=18, age_max=65,
                           geo_locations={"cities": [{"name": "Lincoln", "radius": 25, "distance_unit": "mile"}]})
        self.adsets = {s["id"]: s for s in [
            _adset(VIC_TEMPLATE, VIC_CAMPAIGN, "Halloween Ad", "2026-10-25T23:27:28+0000", VIC_PIXEL, vic_target,
                   start="2026-10-07T23:27:36+0000"),
            _adset(COPY_ADSET, COPY_CAMPAIGN, "Halloween Ad", "2026-10-30T04:01:00+0000", VIC_PIXEL, vic_target),
            _adset(STAR_TEMPLATE, STAR_CAMPAIGN, "The Star 402 October", "2026-10-23T05:00:00+0000", SHARED_PIXEL,
                   star_target),
            _adset(TIDE_TEMPLATE, TIDE_CAMPAIGN, "The Tide 757 October", "2026-10-23T05:00:00+0000", SHARED_PIXEL,
                   tide_target),
        ]}
        self.ads = {a["id"]: a for a in [
            _ad(VIC_AD, VIC_CAMPAIGN, VIC_TEMPLATE, "New Leads Ad", VIC_CREATIVE),
            _ad("120250882002440269", COPY_CAMPAIGN, COPY_ADSET, "New Leads Ad", "1"),
            _ad(STAR_AD, STAR_CAMPAIGN, STAR_TEMPLATE, "October Ad - star", STAR_CREATIVE),
            _ad(TIDE_AD, TIDE_CAMPAIGN, TIDE_TEMPLATE, "the tide october", TIDE_CREATIVE),
        ]}
        self.creatives = {
            VIC_CREATIVE: {"id": VIC_CREATIVE, "name": "Vic leads", "object_story_spec": {
                "page_id": PAGE["victoria"], "instagram_user_id": VIC_IG}},
            TIDE_CREATIVE: {"id": TIDE_CREATIVE, "name": "Get the free list", "object_story_spec": {
                "page_id": PAGE["virginiabeach"], "instagram_user_id": TIDE_IG,
                "video_data": {"video_id": "970357808901676", "call_to_action": {"type": "SUBSCRIBE"}}}},
            STAR_CREATIVE: {"id": STAR_CREATIVE, "name": "Star", "object_story_spec": {"page_id": PAGE["lincoln"]}},
        }
        self.videos = {}
        self.images = {}

    # -- plumbing

    def new_id(self):
        self.n += 1
        return str(990000000000000 + self.n)

    def request(self, method, url, params=None, data=None, headers=None, timeout=None, files=None, **extra):
        assert not extra, extra
        got_files = None
        if files:
            got_files = {k: (v[0], v[1].read() if hasattr(v[1], "read") else v[1], v[2]) for k, v in files.items()}
        call = {"method": method, "url": url, "params": dict(params) if params else params,
                "data": dict(data) if data else data, "headers": dict(headers or {}), "timeout": timeout,
                "files": got_files}
        self.calls.append(call)
        u = urllib.parse.urlsplit(url)
        assert u.hostname in ("graph-video.facebook.com", "graph.facebook.com"), url
        assert u.path.startswith(f"/{VERSION}/"), url
        path = u.path[len(VERSION) + 2:]
        for i, (m, rx, answer, after) in enumerate(self.faults):
            if m == method and re.fullmatch(rx, path):
                del self.faults[i]
                if after:
                    self.route(method, path, call)
                if isinstance(answer, BaseException):
                    raise answer
                return answer
        return self.route(method, path, call)

    def page(self, items):
        items = [self.view(x) for x in items]
        return ok({"data": items, "paging": {"cursors": {"before": "B", "after": "A"}}})

    def view(self, obj):
        """An object as Meta shows it, with its effective_status."""
        o = copy.deepcopy(obj)
        if "status" in o and o.get("id") not in self.creatives:
            c = self.campaigns.get(o.get("campaign_id")) if o.get("campaign_id") else None
            s = self.adsets.get(o.get("adset_id")) if o.get("adset_id") else None
            eff = o["status"]
            if eff == "ACTIVE" and c and c["status"] == "PAUSED":
                eff = "CAMPAIGN_PAUSED"
            elif eff == "ACTIVE" and s and s["status"] == "PAUSED":
                eff = "ADSET_PAUSED"
            o.setdefault("effective_status", eff)
            if o.get("review"):
                o["effective_status"] = o["review"]
        if o.get("end_time") is None:
            o.pop("end_time", None)
        o.pop("review", None)
        return o

    def obj(self, oid):
        for store in (self.campaigns, self.adsets, self.ads, self.creatives, self.videos):
            if oid in store:
                return store[oid]
        return None

    # -- routes

    def route(self, method, path, call):
        params, data = call["params"] or {}, call["data"] or {}
        obj, _, edge = path.partition("/")
        if method == "GET":
            if obj == ACCOUNT and not edge:
                return ok(self.account)
            if obj == ACCOUNT and edge == "campaigns":
                return self.page(self.campaigns.values())
            if obj == ACCOUNT and edge == "advideos":
                return ok({"data": [{"id": k, "title": v["title"], "created_time": v["created_time"]}
                                    for k, v in self.videos.items()]})
            if obj == ACCOUNT and edge == "adcreatives":
                return ok({"data": [{"id": k, "name": v["name"]} for k, v in self.creatives.items()]})
            if obj in self.campaigns and edge == "adsets":
                return self.page([s for s in self.adsets.values() if s["campaign_id"] == obj])
            if obj in self.campaigns and edge == "ads":
                return self.page([a for a in self.ads.values() if a["campaign_id"] == obj])
            if obj in self.adsets and edge == "ads":
                return self.page([a for a in self.ads.values() if a["adset_id"] == obj])
            if edge == "insights":
                key = (obj, params.get("date_preset"), params.get("level"))
                return ok({"data": self.insight_rows.get(key, [])})
            if obj in self.videos and not edge:
                st = self.video_states.pop(0) if self.video_states else {
                    "video_status": "ready", "uploading_phase": {"status": "complete"},
                    "processing_phase": {"status": "complete"}}
                return ok({"id": obj, "status": st, "length": 16.0})
            if not edge and self.obj(obj) is not None:
                return ok(self.view(self.obj(obj)))
        if method == "POST":
            if obj == ACCOUNT and edge == "advideos":
                vid = self.new_id()
                self.videos[vid] = {"title": data["title"], "bytes": len(call["files"]["source"][1]),
                                    "created_time": f"2026-10-23T18:{len(self.videos):02d}:00+0000"}
                return ok({"id": vid})
            if obj == ACCOUNT and edge == "adimages":
                raw = base64.b64decode(data["bytes"])
                h = f"hash{len(raw)}"
                self.images[h] = raw
                return ok({"images": {"bytes": {"hash": h, "url": "https://scontent.example/x.jpg"}}})
            if obj == ACCOUNT and edge == "adcreatives":
                cid = self.new_id()
                self.creatives[cid] = {"id": cid, "name": data["name"],
                                       "object_story_spec": json.loads(data["object_story_spec"])}
                return ok({"id": cid})
            if obj in self.adsets and edge == "copies":
                src = self.adsets[obj]
                new = copy.deepcopy(src)
                new["id"] = self.new_id()
                rename = json.loads(data.get("rename_options") or "{}")
                new["name"] = src["name"] + rename.get("rename_suffix", " - Copy")
                new["status"] = {"PAUSED": "PAUSED", "ACTIVE": "ACTIVE"}.get(data.get("status_option", "PAUSED"),
                                                                             src["status"])
                new["start_time"] = data.get("start_time", src["start_time"])
                new["end_time"] = None if data.get("end_time") == "0" else data.get("end_time", src["end_time"])
                self.adsets[new["id"]] = new
                return ok({"copied_adset_id": new["id"],
                           "ad_object_ids": [{"ad_object_type": "ad_set", "source_id": obj, "copied_id": new["id"]}]})
            if obj == ACCOUNT and edge == "ads":
                s = self.adsets[data["adset_id"]]
                aid = self.new_id()
                self.ads[aid] = {"id": aid, "name": data["name"], "account_id": ACCOUNT[4:],
                                 "campaign_id": s["campaign_id"], "adset_id": s["id"], "status": data["status"],
                                 "creative": {"id": json.loads(data["creative"])["creative_id"]},
                                 "created_time": "2026-10-23T18:30:00+0000", "review": "PENDING_REVIEW",
                                 "preview_shareable_link": "https://fb.me/preview123"}
                return ok({"id": aid})
            if not edge and self.obj(obj) is not None:
                o = self.obj(obj)
                o.update(data)
                if data.get("end_time") == "0":
                    o["end_time"] = None
                return ok({"success": True})
        raise AssertionError(f"unexpected {method} {path}")


# ------------------------------------------------------------------ fixtures

@pytest.fixture
def env(monkeypatch, tmp_path):
    """The network key (no META_TOKEN), a fixed clock, no real sleeping,
    ffprobe answering for a good 4:5 render, a fake thumbnail grab, these
    tests' own scripts and a ledger in tmp_path."""
    monkeypatch.delenv("META_TOKEN", raising=False)
    monkeypatch.delenv("META_PAGE_TOKEN", raising=False)
    scripts = tmp_path / "scripts.json"
    scripts.write_text(json.dumps({"videos": VIDEOS}), encoding="utf-8")
    monkeypatch.setenv("VIDEO_SCRIPTS", str(scripts))
    e = types.SimpleNamespace(now=NOW, t=0.0, sleeps=[], probe=GOOD_PROBE, frames=[], tmp=tmp_path,
                              ledger=str(tmp_path / "out" / "ads.json"))

    def fake_sleep(seconds):
        e.sleeps.append(seconds)
        e.t += seconds

    monkeypatch.setattr(ads, "_sleep", fake_sleep)
    monkeypatch.setattr(pr, "_sleep", fake_sleep)
    monkeypatch.setattr(ads, "_monotonic", lambda: e.t)
    monkeypatch.setattr(ads, "_utcnow", lambda: e.now)
    monkeypatch.setattr(pr, "_utcnow", lambda: e.now)
    monkeypatch.setattr(pr, "probe", lambda path: e.probe)
    monkeypatch.setattr(ads, "THUMBS", str(tmp_path / "thumbs"))

    def fake_frame(video_path, out_path, at=ads.THUMB_AT):
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        with open(out_path, "wb") as f:
            f.write(JPEG)
        e.frames.append((video_path, out_path, at))
        return out_path

    monkeypatch.setattr(ads, "frame_jpeg", fake_frame)

    def render(vid=VIC1, name="feed-4x5.mp4", content=CONTENT):
        d = tmp_path / "renders" / vid
        d.mkdir(parents=True, exist_ok=True)
        p = d / name
        p.write_bytes(content)
        return str(p)

    def read_ledger():
        with open(e.ledger, encoding="utf-8") as f:
            return json.load(f)

    e.render, e.read_ledger = render, read_ledger
    return e


def run(env, meta, *argv):
    return ads.main([*argv, "--ledger", env.ledger], session=meta)


def upload(env, meta, vid=VIC1, *flags, path=None):
    return run(env, meta, "upload", path or env.render(vid), "--video", vid, "--go", *flags)


def routes(calls):
    return [(c["method"], c["url"]) for c in calls]


def writes(calls):
    return [c for c in calls if c["method"] != "GET"]


def survey_routes(base, campaign):
    return [("GET", f"{base}/{ACCOUNT}"), ("GET", f"{base}/{ACCOUNT}/campaigns"),
            ("GET", f"{base}/{campaign}/adsets"), ("GET", f"{base}/{campaign}/ads")]


def assert_no_token(*texts):
    for text in texts:
        assert SYSTEM_TOKEN not in text
        assert SYSTEM_TOKEN[:30] not in text


def ours(meta, vid):
    """(ad set, ad) the fake account holds for a video."""
    s = next(s for s in meta.adsets.values() if s["name"].endswith(f"[{vid}]"))
    a = next(a for a in meta.ads.values() if a["adset_id"] == s["id"])
    return s, a


# ------------------------------------------------------- the request sequence

def test_upload_go_sends_exactly_these_requests(env, capsys):
    meta = FakeMeta()
    assert upload(env, meta) == 0
    out = capsys.readouterr().out
    copy_id, ad_id = ours(meta, VIC1)[0]["id"], ours(meta, VIC1)[1]["id"]
    video_id, creative_id = next(iter(meta.videos)), max(meta.creatives)
    assert routes(meta.calls) == survey_routes(N, VIC_CAMPAIGN) + [
        ("GET", f"{N}/{VIC_CREATIVE}"),                    # the campaign's Instagram account
        ("POST", f"{N}/{ACCOUNT}/advideos"),               # the 4:5, into the library
        ("GET", f"{N}/{video_id}"),                        # processed?
        ("POST", f"{N}/{ACCOUNT}/adimages"),               # the thumbnail
        ("POST", f"{N}/{ACCOUNT}/adcreatives"),            # the creative
        ("POST", f"{N}/{VIC_TEMPLATE}/copies"),            # the ad set, PAUSED
        ("GET", f"{N}/{copy_id}"),                         # the copy as Meta has it
        ("POST", f"{N}/{ACCOUNT}/ads"),                    # the ad, PAUSED
        ("GET", f"{N}/{ad_id}"),                           # the ad as Meta has it
    ]
    c = meta.calls
    assert c[0]["params"] == {"fields": ads.ACCOUNT_FIELDS}
    assert c[1]["params"] == {"fields": ads.CAMPAIGN_FIELDS, "limit": "100"}
    assert c[2]["params"] == {"fields": ads.ADSET_FIELDS, "limit": "100"}
    assert c[3]["params"] == {"fields": ads.AD_FIELDS, "limit": "100"}
    assert c[4]["params"] == {"fields": "object_story_spec"}
    video = c[5]
    assert video["data"] == {"name": f"{VIC1} 4x5", "title": f"{VIC1} 4x5"}
    assert video["files"] == {"source": ("feed-4x5.mp4", CONTENT, "video/mp4")}
    assert video["timeout"] == pr.UPLOAD_TIMEOUT and video["params"] is None
    assert c[6]["params"] == {"fields": "status,length"}
    assert c[7]["data"] == {"bytes": base64.b64encode(JPEG).decode()}
    creative = c[8]["data"]
    assert set(creative) == {"name", "object_story_spec", "url_tags", "degrees_of_freedom_spec"}
    assert creative["name"] == f"{VIC1} video ad"
    assert json.loads(creative["object_story_spec"]) == {
        "page_id": PAGE["victoria"], "instagram_user_id": VIC_IG,
        "video_data": {"video_id": video_id, "image_hash": f"hash{len(JPEG)}", "message": VIDEOS[0]["caption"],
                       "title": "Everything to do in Victoria, free",
                       "link_description": "Free every Monday and Thursday",
                       "call_to_action": {"type": "SUBSCRIBE", "value": {
                           "link": "https://www.thevic361.com/subscribe", "link_caption": "thevic361.com"}}}}
    assert creative["url_tags"] == ("utm_source={{site_source_name}}&utm_medium=paid&utm_campaign={{campaign.name}}"
                                    f"&utm_content={VIC1}")
    assert json.loads(creative["degrees_of_freedom_spec"]) == {"creative_features_spec": ads.CREATIVE_FEATURES}
    # Sun Oct 25 6 PM CDT to Sat Oct 31 5 PM CDT.
    assert c[9]["data"] == {"deep_copy": "false", "status_option": "PAUSED", "start_time": "2026-10-25T23:00:00+0000",
                            "end_time": "2026-10-31T22:00:00+0000",
                            "rename_options": json.dumps({"rename_strategy": "ONLY_TOP_LEVEL_RENAME",
                                                          "rename_suffix": f" [{VIC1}]"})}
    assert c[10]["params"] == {"fields": "id,name,campaign_id,status,effective_status,start_time,end_time"}
    assert c[11]["data"] == {"name": f"{VIC1} (Halloween week)", "adset_id": copy_id,
                             "creative": json.dumps({"creative_id": creative_id}), "status": "PAUSED",
                             "conversion_domain": "thevic361.com"}
    assert c[12]["params"] == {"fields": "id,name,adset_id,status,effective_status,preview_shareable_link"}
    # The copy and the ad: paused, in Victoria's campaign, with the window.
    s, a = ours(meta, VIC1)
    assert s["name"] == f"Halloween Ad [{VIC1}]" and s["status"] == "PAUSED" and s["campaign_id"] == VIC_CAMPAIGN
    assert (s["start_time"], s["end_time"]) == ("2026-10-25T23:00:00+0000", "2026-10-31T22:00:00+0000")
    assert a["status"] == "PAUSED"
    assert meta.campaigns[VIC_CAMPAIGN]["status"] == "PAUSED"
    entry = env.read_ledger()[VIC1]
    assert entry["state"] == "uploaded" and entry["attempt"] == 1 and entry["town"] == "victoria"
    assert {k: v.get("id") or v.get("hash") for k, v in entry["steps"].items()} == {
        "video": video_id, "image": f"hash{len(JPEG)}", "creative": creative_id, "adset": copy_id, "ad": ad_id}
    assert all(v["state"] == "done" for v in entry["steps"].values())
    assert entry["campaign_id"] == VIC_CAMPAIGN and entry["template_adset_id"] == VIC_TEMPLATE
    assert entry["window"]["end_utc"] == "2026-10-31T22:00:00Z"
    assert f"Ad {ad_id} ('{VIC1} (Halloween week)'): PAUSED, Meta: PENDING_REVIEW" in out
    assert "Preview: https://fb.me/preview123" in out
    assert "Uploaded: nothing is on." in out
    # The thumbnail is a frame of this very file, 0.8 s in.
    assert env.frames == [(entry["file"], os.path.join(ads.THUMBS, VIC1, "thumb-1.jpg"), 0.8)]


def test_the_network_key_mode_sends_no_authorization_and_only_to_graph_video(env):
    meta = FakeMeta()
    assert upload(env, meta) == 0
    assert all(c["url"].startswith(N + "/") for c in meta.calls)
    assert all("Authorization" not in c["headers"] for c in meta.calls)


def test_with_meta_token_every_call_goes_to_graph_with_bearer(env, monkeypatch, capsys):
    monkeypatch.setenv("META_TOKEN", SYSTEM_TOKEN)
    meta = FakeMeta()
    assert upload(env, meta) == 0
    assert all(c["url"].startswith(G + "/") for c in meta.calls)
    assert all(c["headers"] == {"Authorization": f"Bearer {SYSTEM_TOKEN}"} for c in meta.calls)
    assert any(c["files"] for c in meta.calls)  # the upload too
    assert_no_token(capsys.readouterr().out, open(env.ledger, encoding="utf-8").read())


def test_meta_page_token_is_the_fallback(env, monkeypatch):
    monkeypatch.setenv("META_PAGE_TOKEN", SYSTEM_TOKEN)
    meta = FakeMeta()
    assert run(env, meta, "plan", env.render(), "--video", VIC1) == 0
    assert all(c["headers"] == {"Authorization": f"Bearer {SYSTEM_TOKEN}"} for c in meta.calls)


def test_a_facebook_only_town_gets_no_instagram_account(env, capsys):
    meta = FakeMeta()
    assert upload(env, meta, STAR1) == 0
    # Its ad set is Facebook only, so its old creative isn't even read.
    assert ("GET", f"{N}/{STAR_CREATIVE}") not in routes(meta.calls)
    story = json.loads(writes(meta.calls)[2]["data"]["object_story_spec"])
    assert story["page_id"] == PAGE["lincoln"] and "instagram_user_id" not in story
    assert story["video_data"]["title"] == "Everything to do in Lincoln, free"   # the default headline
    s, _ = ours(meta, STAR1)
    assert s["campaign_id"] == STAR_CAMPAIGN and s["name"] == f"The Star 402 October [{STAR1}]"


def test_the_tide_takes_the_instagram_account_of_its_video_ad(env):
    meta = FakeMeta()
    assert upload(env, meta, TIDE1) == 0
    story = json.loads(writes(meta.calls)[2]["data"]["object_story_spec"])
    assert story["instagram_user_id"] == TIDE_IG and story["page_id"] == PAGE["virginiabeach"]
    assert story["video_data"]["call_to_action"]["value"]["link"] == "https://www.thetide757.com/subscribe"
    assert writes(meta.calls)[4]["data"]["conversion_domain"] == "thetide757.com"
    # 6 PM EDT is 22:00 UTC.
    assert writes(meta.calls)[3]["data"]["start_time"] == "2026-10-25T22:00:00+0000"


def test_an_open_ended_video_copies_with_end_time_0(env, capsys):
    meta = FakeMeta()
    assert upload(env, meta, VIC2) == 0
    c = writes(meta.calls)[3]
    assert c["url"] == f"{N}/{VIC_TEMPLATE}/copies"
    # Nov 1 6 AM is after DST ends: CST, UTC-6.
    assert (c["data"]["start_time"], c["data"]["end_time"]) == ("2026-11-01T12:00:00+0000", "0")
    s, _ = ours(meta, VIC2)
    assert s.get("end_time") is None
    assert env.read_ledger()[VIC2]["window"]["end_utc"] is None


def test_a_window_already_started_copies_from_now(env, capsys):
    env.now = dt.datetime(2026, 10, 26, 14, 7, 31, tzinfo=UTC)
    meta = FakeMeta()
    assert upload(env, meta) == 0
    assert writes(meta.calls)[3]["data"]["start_time"] == "2026-10-26T14:07:00+0000"
    assert "the window's start has passed" in capsys.readouterr().out


# ------------------------------------------------------------------ dry runs

def no_network(monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("a test touched the network")

    monkeypatch.setattr(requests.Session, "request", refuse)
    monkeypatch.setattr(socket.socket, "connect", refuse)


class ReadOnlyMeta(FakeMeta):
    def request(self, method, url, **kw):
        assert method == "GET", f"a dry run sent {method} {url}"
        return super().request(method, url, **kw)


def test_dry_runs_never_write(env, monkeypatch, capsys):
    no_network(monkeypatch)
    meta = FakeMeta()
    assert upload(env, meta) == 0
    s, a = ours(meta, VIC1)
    before = copy.deepcopy((meta.campaigns, meta.adsets, meta.ads, meta.creatives, meta.videos))
    ro = ReadOnlyMeta()
    ro.__dict__.update(copy.deepcopy({k: v for k, v in meta.__dict__.items() if k != "calls"}), calls=[])
    path = env.render(VIC2)
    assert run(env, ro, "plan", path, "--video", VIC2) == 0
    assert run(env, ro, "upload", path, "--video", VIC2) == 0          # upload without --go is the plan
    assert run(env, ro, "go", "--video", VIC1) == 0
    assert run(env, ro, "stop", "--video", VIC1, "--campaign") == 0
    assert run(env, ro, "status") == 0
    assert ro.calls and writes(ro.calls) == []
    assert (ro.campaigns, ro.adsets, ro.ads, ro.creatives, ro.videos) == before
    out = capsys.readouterr().out
    assert "PLAN: nothing was sent." in out and "GO (dry run): nothing was sent." in out
    assert VIC2 not in env.read_ledger()


def test_a_dry_runs_graph_refuses_any_write_even_by_mistake():
    g = ads.AdsGraph(FakeMeta(), writes=False)
    for call in (lambda: g.once(f"{ACCOUNT}/ads", pr.NETWORK_KEY, "POST /ads", data={"status": "PAUSED"}),
                 lambda: g.set_status(VIC_AD, "ACTIVE", pr.NETWORK_KEY, "POST status"),
                 lambda: g.call("DELETE", VIC_AD, "DELETE", pr.NETWORK_KEY)):
        with pytest.raises(pr.PostError, match="only reads"):
            call()
    assert g.s.calls == []


def test_plan_says_what_upload_would_make(env, capsys):
    meta = FakeMeta()
    path = env.render()
    assert run(env, meta, "plan", path, "--video", VIC1) == 0
    out = capsys.readouterr().out
    assert writes(meta.calls) == []
    assert out.startswith(f"PLAN: {VIC1} (Halloween week) as a paused ad in The Vic 361's campaign")
    assert "Campaign:  Vic Newsletter Leads (120250753433250269): PAUSED, leads" in out
    assert "$68.00/day (campaign budget)" in out
    assert "over the $50/day scripts/meta_ads.py's budget command allows" in out
    assert "not touched: campaign 'Vic Newsletter Leads - Copy' (120250882002420269), PAUSED" in out
    assert f"a copy of 'Halloween Ad' ({VIC_TEMPLATE}), PAUSED, named 'Halloween Ad [{VIC1}]'" in out
    assert f"OFFSITE_CONVERSIONS for pixel {VIC_PIXEL} LEAD; Victoria, Tx +12 mi, ages 18-65, automatic placements" \
        in out
    assert "Window:    Sun Oct 25 2026, 6:00 PM CDT -> Sat Oct 31 2026, 5:00 PM CDT (5.96 days)" in out
    assert "2026-10-25 23:00 UTC -> 2026-10-31 22:00 UTC" in out
    assert "Spend:     about $405.17: $68.00/day x 5.96 days" in out
    assert "ok    video: H.264 1080x1350 (4:5), 30 fps, 16.0 s" in out
    assert VIDEOS[0]["caption"] in out
    assert "Headline:  Everything to do in Victoria, free (scripts.json, 34 characters" in out
    assert "Button:    SUBSCRIBE -> https://www.thevic361.com/subscribe" in out
    assert "utm_source={{site_source_name}}&utm_medium=paid" in out
    assert f"Instagram: account {VIC_IG}, from the campaign's ad 'New Leads Ad'" in out
    # Halloween Ad runs to Oct 25 6:27 PM: on now if the campaign were.
    assert "On if the campaign were turned on now" in out
    assert f"ad set 'Halloween Ad' ({VIC_TEMPLATE}): ACTIVE (Meta: CAMPAIGN_PAUSED), until Sun Oct 25 2026, " \
           "6:27 PM CDT" in out
    assert f"ad 'New Leads Ad' ({VIC_AD}): ACTIVE (Meta: CAMPAIGN_PAUSED)" in out
    assert f"5. POST {N}/{VIC_TEMPLATE}/copies  status_option=PAUSED" in out
    assert "no META_TOKEN: the network secret on graph-video.facebook.com" in out
    assert f"PLAN: nothing was sent. `ads.py upload {path} --video {VIC1} --go` makes the paused ad." in out
    assert not os.path.exists(env.ledger)


def test_plan_lists_ended_ones_go_still_pauses(env, capsys):
    meta = FakeMeta()
    assert run(env, meta, "plan", env.render(TIDE1), "--video", TIDE1) == 0
    out = capsys.readouterr().out
    assert "Nothing else in the campaign would deliver if it were turned on." in out
    assert "Set to ACTIVE but not delivering" in out
    assert f"ad set 'The Tide 757 October' ({TIDE_TEMPLATE}): ACTIVE (Meta: CAMPAIGN_PAUSED), ended Fri Oct 23 " \
           "2026, 1:00 AM EDT" in out
    assert "facebook (feed, story, facebook_reels); instagram (stream, story, reels)" in out


def test_an_open_ended_plan_shows_the_spend_per_day(env, capsys):
    assert run(env, FakeMeta(), "plan", env.render(VIC2), "--video", VIC2) == 0
    out = capsys.readouterr().out
    assert "no end: runs until stopped (no run_until_local)" in out
    assert "$68.00 a day until it's stopped (no run_until_local: open-ended)" in out
    assert "Headline:  Everything to do in Victoria, free (default, 34 characters" in out


def test_plan_problems_exit_1_without_a_write(env, capsys):
    env.probe = probe_with(video={"width": 1920, "height": 1080})
    meta = FakeMeta()
    assert run(env, meta, "plan", env.render("victoria-draft"), "--video", "victoria-draft") == 1
    out = capsys.readouterr().out
    assert writes(meta.calls) == []
    assert "1920x1080 is neither 4:5 nor 9:16" in out
    assert "victoria-draft is still a draft" in out
    assert "upload --go would refuse until these are fixed" in out


def test_plan_without_any_key_still_shows_the_rest(env, capsys):
    meta = FakeMeta()
    meta.faults.append(("GET", ACCOUNT, err(400, 200, "(#200) Provide valid app ID"), False))
    assert run(env, meta, "plan", env.render(), "--video", VIC1) == 1
    out = capsys.readouterr().out
    assert "No Facebook key" in out
    assert "Window:    Sun Oct 25 2026, 6:00 PM CDT" in out and "ok    video: H.264 1080x1350" in out
    assert routes(meta.calls) == [("GET", f"{N}/{ACCOUNT}")]


# ------------------------------------------------------------------ never ACTIVE without go --go

def test_nothing_becomes_active_without_go_go(env, capsys):
    meta = FakeMeta()
    assert upload(env, meta) == 0
    assert upload(env, meta, TIDE1) == 0
    assert run(env, meta, "go", "--video", VIC1) == 0              # the dry run
    assert run(env, meta, "stop", "--video", TIDE1, "--go") == 0   # already paused: nothing to do
    for c in writes(meta.calls):
        assert "ACTIVE" not in json.dumps(c["data"]), c
    assert all(c["data"].get("status") in (None, "PAUSED") for c in writes(meta.calls))
    for vid in (VIC1, TIDE1):
        s, a = ours(meta, vid)
        assert (s["status"], a["status"]) == ("PAUSED", "PAUSED")
    assert {c["status"] for c in meta.campaigns.values()} == {"PAUSED"}


def test_a_copy_that_comes_out_active_is_paused_at_once(env, capsys):
    meta = FakeMeta()
    real = meta.route

    def active_copy(method, path, call):
        answer = real(method, path, call)
        if path.endswith("/copies"):
            meta.adsets[answer.json()["copied_adset_id"]]["status"] = "ACTIVE"
        return answer

    meta.route = active_copy
    assert upload(env, meta) == 0
    s, _ = ours(meta, VIC1)
    assert s["status"] == "PAUSED"
    pause = [c for c in writes(meta.calls) if c["url"] == f"{N}/{s['id']}"]
    assert [c["data"] for c in pause] == [{"status": "PAUSED"}]
    assert "came out ACTIVE: pausing it now" in capsys.readouterr().out


def test_a_window_meta_did_not_take_is_set_again(env, capsys):
    meta = FakeMeta()
    real = meta.route

    def lost_end(method, path, call):
        answer = real(method, path, call)
        if path.endswith("/copies"):
            meta.adsets[answer.json()["copied_adset_id"]]["end_time"] = "2026-10-23T05:00:00+0000"
        return answer

    meta.route = lost_end
    assert upload(env, meta) == 0
    s, _ = ours(meta, VIC1)
    fix = [c for c in writes(meta.calls) if c["url"] == f"{N}/{s['id']}"]
    assert [c["data"] for c in fix] == [{"end_time": "2026-10-31T22:00:00+0000"}]
    assert s["end_time"] == "2026-10-31T22:00:00+0000" and s["status"] == "PAUSED"


# ------------------------------------------------------------------ go

def test_go_pauses_the_others_first_then_turns_this_video_on(env, capsys):
    meta = FakeMeta()
    assert upload(env, meta) == 0
    s, a = ours(meta, VIC1)
    meta.calls.clear()
    env.now = dt.datetime(2026, 10, 25, 20, 0, tzinfo=UTC)
    assert run(env, meta, "go", "--video", VIC1, "--go") == 0
    out = capsys.readouterr().out
    assert routes(meta.calls) == survey_routes(N, VIC_CAMPAIGN) + [
        ("POST", f"{N}/{VIC_TEMPLATE}"), ("POST", f"{N}/{VIC_AD}"),            # the others, paused first
        ("POST", f"{N}/{a['id']}"), ("POST", f"{N}/{s['id']}"), ("POST", f"{N}/{VIC_CAMPAIGN}"),  # then on
    ] + survey_routes(N, VIC_CAMPAIGN)
    assert [c["data"] for c in writes(meta.calls)] == [{"status": "PAUSED"}] * 2 + [{"status": "ACTIVE"}] * 3
    assert all(c["params"] is None for c in writes(meta.calls))
    last_pause = max(i for i, c in enumerate(meta.calls) if (c["data"] or {}).get("status") == "PAUSED")
    first_on = min(i for i, c in enumerate(meta.calls) if (c["data"] or {}).get("status") == "ACTIVE")
    assert last_pause < first_on
    assert (meta.adsets[VIC_TEMPLATE]["status"], meta.ads[VIC_AD]["status"]) == ("PAUSED", "PAUSED")
    assert (s["status"], a["status"], meta.campaigns[VIC_CAMPAIGN]["status"]) == ("ACTIVE",) * 3
    # Nothing outside Victoria's campaign moved.
    assert meta.campaigns[COPY_CAMPAIGN]["status"] == "PAUSED" and meta.adsets[COPY_ADSET]["status"] == "ACTIVE"
    assert meta.adsets[TIDE_TEMPLATE]["status"] == "ACTIVE"
    entry = env.read_ledger()[VIC1]
    assert entry["state"] == "live" and entry["changes"][-1]["ok"] is True
    assert [x["id"] for x in entry["changes"][-1]["set"]] == [VIC_TEMPLATE, VIC_AD, a["id"], s["id"], VIC_CAMPAIGN]
    assert f"{VIC1} is on." in out
    # The spend was on screen before anything turned on.
    assert out.index("Spend:") < out.index(f"ad '{VIC1} (Halloween week)' ({a['id']}): ACTIVE")


def test_no_command_ever_writes_a_budget_or_anything_but_these(env, capsys):
    meta = FakeMeta()
    assert upload(env, meta) == 0
    assert run(env, meta, "go", "--video", VIC1, "--go") == 0
    assert upload(env, meta, VIC2) == 0
    assert run(env, meta, "go", "--video", VIC2, "--go") == 0
    assert run(env, meta, "stop", "--video", VIC2, "--campaign", "--go") == 0
    allowed = {f"{ACCOUNT}/advideos": {"name", "title"}, f"{ACCOUNT}/adimages": {"bytes"},
               f"{ACCOUNT}/adcreatives": {"name", "object_story_spec", "url_tags", "degrees_of_freedom_spec"},
               f"{VIC_TEMPLATE}/copies": {"deep_copy", "status_option", "start_time", "end_time", "rename_options"},
               f"{ACCOUNT}/ads": {"name", "adset_id", "creative", "status", "conversion_domain"}}
    for c in writes(meta.calls):
        path = urllib.parse.urlsplit(c["url"]).path[len(VERSION) + 2:]
        assert set(c["data"]) == allowed.get(path, {"status"}), c
    assert {c["daily_budget"] for c in meta.campaigns.values()} == {"6800", "4000", "5500"}


def test_go_dry_run_shows_what_turns_on_what_pauses_and_the_spend(env, capsys):
    meta = FakeMeta()
    assert upload(env, meta) == 0
    s, a = ours(meta, VIC1)
    capsys.readouterr()
    meta.calls.clear()
    assert run(env, meta, "go", "--video", VIC1) == 0
    out = capsys.readouterr().out
    assert writes(meta.calls) == []
    assert f"GO (dry run): {VIC1} in Vic Newsletter Leads ({VIC_CAMPAIGN}), found by the ledger" in out
    assert f"ad '{VIC1} (Halloween week)' ({a['id']}): PAUSED (Meta: PENDING_REVIEW) -> ACTIVE" in out
    assert f"ad set 'Halloween Ad [{VIC1}]' ({s['id']}): PAUSED, until Sat Oct 31 2026, 5:00 PM CDT -> ACTIVE" in out
    assert f"campaign 'Vic Newsletter Leads' ({VIC_CAMPAIGN}): PAUSED -> ACTIVE" in out
    assert f"ad set 'Halloween Ad' ({VIC_TEMPLATE}): ACTIVE (Meta: CAMPAIGN_PAUSED), until Sun Oct 25 2026, " \
           "6:27 PM CDT -> PAUSED  (would deliver)" in out
    assert "about $405.17: $68.00/day x 5.96 days" in out
    assert "over the $50/day" in out
    assert "Meta is still reviewing the ad" in out
    assert f"1. POST {N}/{VIC_TEMPLATE}  status=PAUSED" in out and f"5. POST {N}/{VIC_CAMPAIGN}  status=ACTIVE" in out
    assert f"GO (dry run): nothing was sent. `ads.py go --video {VIC1} --go` does it." in out


def test_go_pauses_the_towns_previous_video(env, capsys):
    meta = FakeMeta()
    assert upload(env, meta, VIC1) == 0
    assert run(env, meta, "go", "--video", VIC1, "--go") == 0
    assert upload(env, meta, VIC2) == 0
    s1, a1 = ours(meta, VIC1)
    s2, a2 = ours(meta, VIC2)
    meta.calls.clear()
    assert run(env, meta, "go", "--video", VIC2, "--go") == 0
    assert [(c["url"], c["data"]["status"]) for c in writes(meta.calls)] == [
        (f"{N}/{s1['id']}", "PAUSED"), (f"{N}/{a1['id']}", "PAUSED"),
        (f"{N}/{a2['id']}", "ACTIVE"), (f"{N}/{s2['id']}", "ACTIVE")]     # the campaign is on already
    assert (s1["status"], a1["status"], s2["status"], a2["status"]) == ("PAUSED", "PAUSED", "ACTIVE", "ACTIVE")


def test_go_twice_changes_nothing_the_second_time(env, capsys):
    meta = FakeMeta()
    assert upload(env, meta) == 0
    assert run(env, meta, "go", "--video", VIC1, "--go") == 0
    meta.calls.clear()
    assert run(env, meta, "go", "--video", VIC1, "--go") == 0
    assert writes(meta.calls) == []
    assert "Nothing to change." in capsys.readouterr().out


@pytest.mark.parametrize("review, refused", [("DISAPPROVED", True), ("PENDING_REVIEW", False)])
def test_go_refuses_a_disapproved_ad(env, capsys, review, refused):
    meta = FakeMeta()
    assert upload(env, meta) == 0
    ours(meta, VIC1)[1]["review"] = review
    meta.calls.clear()
    assert run(env, meta, "go", "--video", VIC1, "--go") == (1 if refused else 0)
    assert bool(writes(meta.calls)) is not refused
    if refused:
        assert "Meta disapproved" in capsys.readouterr().err


def test_go_refuses_a_window_that_has_ended(env, capsys):
    meta = FakeMeta()
    assert upload(env, meta) == 0
    env.now = dt.datetime(2026, 11, 2, tzinfo=UTC)
    meta.calls.clear()
    assert run(env, meta, "go", "--video", VIC1, "--go") == 1
    assert writes(meta.calls) == []
    assert "ad set ended Sat Oct 31 2026, 5:00 PM CDT" in capsys.readouterr().err


def test_go_needs_a_finished_upload(env, capsys):
    meta = FakeMeta()
    assert run(env, meta, "go", "--video", VIC1) == 1
    assert f"{VIC1} has no ad in Vic Newsletter Leads: upload it first" in capsys.readouterr().err
    meta.faults.append(("POST", f"{ACCOUNT}/ads", err(400, 100, "Invalid parameter"), False))
    assert upload(env, meta) == 1
    assert run(env, meta, "go", "--video", VIC1) == 1
    assert "upload didn't finish" in capsys.readouterr().err


def test_a_failed_pause_turns_nothing_on(env, capsys):
    meta = FakeMeta()
    assert upload(env, meta) == 0
    meta.calls.clear()
    meta.faults.append(("POST", VIC_AD, err(400, 100, "nope"), False))
    assert run(env, meta, "go", "--video", VIC1, "--go") == 1
    assert [c["data"]["status"] for c in writes(meta.calls)] == ["PAUSED", "PAUSED"]
    assert "Nothing was turned on." in capsys.readouterr().err
    assert all(o["status"] != "ACTIVE" for o in ours(meta, VIC1)) and meta.campaigns[VIC_CAMPAIGN]["status"] == "PAUSED"
    assert env.read_ledger()[VIC1]["changes"][-1]["ok"] is False


def test_go_finds_the_video_by_name_when_the_ledger_is_gone(env, capsys):
    meta = FakeMeta()
    assert upload(env, meta) == 0
    os.remove(env.ledger)
    s, a = ours(meta, VIC1)
    assert run(env, meta, "go", "--video", VIC1, "--go") == 0
    assert "found by the ad set's name" in capsys.readouterr().out
    assert (s["status"], a["status"]) == ("ACTIVE", "ACTIVE")
    assert env.read_ledger()[VIC1]["found_by_name"] is True


# ------------------------------------------------------------------ stop

def test_stop_pauses_the_ad_set_and_the_ad(env, capsys):
    meta = FakeMeta()
    assert upload(env, meta) == 0
    assert run(env, meta, "go", "--video", VIC1, "--go") == 0
    s, a = ours(meta, VIC1)
    meta.calls.clear()
    assert run(env, meta, "stop", "--video", VIC1, "--go") == 0
    assert routes(meta.calls) == survey_routes(N, VIC_CAMPAIGN) + [("POST", f"{N}/{s['id']}"),
                                                                   ("POST", f"{N}/{a['id']}")]
    assert [c["data"] for c in writes(meta.calls)] == [{"status": "PAUSED"}] * 2
    assert (s["status"], a["status"], meta.campaigns[VIC_CAMPAIGN]["status"]) == ("PAUSED", "PAUSED", "ACTIVE")
    assert env.read_ledger()[VIC1]["state"] == "stopped"


def test_stop_campaign_pauses_the_campaign_first(env, capsys):
    meta = FakeMeta()
    assert upload(env, meta) == 0
    assert run(env, meta, "go", "--video", VIC1, "--go") == 0
    s, a = ours(meta, VIC1)
    meta.calls.clear()
    assert run(env, meta, "stop", "--video", VIC1, "--campaign") == 0           # dry run
    assert writes(meta.calls) == []
    assert run(env, meta, "stop", "--video", VIC1, "--campaign", "--go") == 0
    assert [(c["url"], c["data"]) for c in writes(meta.calls)] == [
        (f"{N}/{VIC_CAMPAIGN}", {"status": "PAUSED"}), (f"{N}/{s['id']}", {"status": "PAUSED"}),
        (f"{N}/{a['id']}", {"status": "PAUSED"})]
    out = capsys.readouterr().out
    assert "STOP (dry run): nothing was sent." in out and f"{VIC1} is paused." in out


# ------------------------------------------------------------------ the ledger

def test_a_second_upload_is_refused_without_force(env, capsys):
    meta = FakeMeta()
    assert upload(env, meta) == 0
    meta.calls.clear()
    assert upload(env, meta) == 1
    assert writes(meta.calls) == []
    assert f"{VIC1} is already uploaded" in capsys.readouterr().err


def test_force_makes_a_new_set_and_keeps_the_old_in_the_ledger(env, capsys):
    meta = FakeMeta()
    assert upload(env, meta) == 0
    first = env.read_ledger()[VIC1]
    assert upload(env, meta, VIC1, "--force") == 0
    entry = env.read_ledger()[VIC1]
    assert entry["attempt"] == 2 and entry["previous"][-1]["steps"] == first["steps"]
    assert entry["names"]["adset"] == f"Halloween Ad [{VIC1} #2]" and entry["names"]["ad"].endswith(" #2")
    assert entry["steps"]["ad"]["id"] != first["steps"]["ad"]["id"]
    assert len(meta.videos) == 2 and sum(s["name"].startswith("Halloween Ad [") for s in meta.adsets.values()) == 2


def test_a_crash_after_the_copy_resumes_without_a_second_copy(env, capsys):
    meta = FakeMeta()
    # The copy is made, then the process dies before Meta's answer is read.
    meta.faults.append(("POST", rf"{VIC_TEMPLATE}/copies", RuntimeError("power cut"), True))
    with pytest.raises(RuntimeError, match="power cut"):
        upload(env, meta)
    entry = env.read_ledger()[VIC1]
    assert [s for s in ads.STEPS if entry["steps"].get(s, {}).get("state") == "done"] == ["video", "image", "creative"]
    assert entry["steps"]["adset"]["state"] == "pending"
    meta.calls.clear()
    assert upload(env, meta) == 0
    out = capsys.readouterr().out
    assert "Resuming" in out and "Found the adset the last run made" in out
    w = routes(writes(meta.calls))
    assert w == [("POST", f"{N}/{ACCOUNT}/ads")]              # no second video, creative or copy
    assert sum(s["name"].endswith(f"[{VIC1}]") for s in meta.adsets.values()) == 1
    assert env.read_ledger()[VIC1]["state"] == "uploaded"


def test_a_crash_before_the_copy_went_out_makes_it_on_the_next_run(env, capsys):
    meta = FakeMeta()
    meta.faults.append(("POST", rf"{VIC_TEMPLATE}/copies", KeyboardInterrupt(), False))
    with pytest.raises(KeyboardInterrupt):
        upload(env, meta)
    meta.calls.clear()
    assert upload(env, meta) == 0
    assert routes(writes(meta.calls)) == [("POST", f"{N}/{VIC_TEMPLATE}/copies"), ("POST", f"{N}/{ACCOUNT}/ads")]
    # The resumed copy keeps the start the first try sent.
    assert writes(meta.calls)[0]["data"]["start_time"] == "2026-10-25T23:00:00+0000"


def test_a_crash_during_the_upload_finds_the_video_by_its_title(env, capsys):
    meta = FakeMeta()
    meta.faults.append(("POST", f"{ACCOUNT}/advideos", RuntimeError("killed"), True))
    with pytest.raises(RuntimeError):
        upload(env, meta)
    assert env.read_ledger()[VIC1]["steps"]["video"]["state"] == "pending"
    meta.calls.clear()
    assert upload(env, meta) == 0
    assert ("GET", f"{N}/{ACCOUNT}/advideos") in routes(meta.calls)
    assert ("POST", f"{N}/{ACCOUNT}/advideos") not in routes(meta.calls)
    assert len(meta.videos) == 1


def test_a_lost_answer_is_looked_up_before_sending_again(env, capsys):
    meta = FakeMeta()
    meta.faults.append(("POST", f"{ACCOUNT}/adcreatives", Resp(502, None), True))  # made, answer lost
    assert upload(env, meta) == 0
    made = [c for c in meta.calls if c["url"] == f"{N}/{ACCOUNT}/adcreatives"]
    assert [c["method"] for c in made] == ["POST", "GET"]    # sent once, then found by name
    assert sum(c["name"] == f"{VIC1} video ad" for c in meta.creatives.values()) == 1
    assert env.sleeps == [ads.RETRY_DELAYS[0]]


def test_a_lost_answer_meta_never_got_is_sent_again(env, capsys):
    meta = FakeMeta()
    meta.faults.append(("POST", f"{ACCOUNT}/ads", requests.ConnectionError("reset"), False))
    assert upload(env, meta) == 0
    assert [c["method"] for c in meta.calls if c["url"].endswith("/ads")][-3:] == ["POST", "GET", "POST"]
    assert len([a for a in meta.ads.values() if a["name"].startswith(VIC1)]) == 1


def test_still_unclear_after_the_last_try_stays_pending(env, capsys):
    meta = FakeMeta()
    for _ in range(3):
        meta.faults.append(("POST", f"{ACCOUNT}/ads", Resp(503, None), False))
    assert upload(env, meta) == 1
    assert "Meta may have made the ad anyway" in capsys.readouterr().err
    assert env.read_ledger()[VIC1]["steps"]["ad"]["state"] == "pending"
    assert upload(env, meta) == 0                      # the next run looks, finds none, makes it
    assert env.read_ledger()[VIC1]["state"] == "uploaded"


def test_a_refusal_is_failed_and_the_next_run_redoes_only_that_step(env, capsys):
    meta = FakeMeta()
    meta.faults.append(("POST", f"{ACCOUNT}/adcreatives", err(400, 100, "Invalid parameter",
                                                                error_user_msg="Bad link"), False))
    assert upload(env, meta) == 1
    entry = env.read_ledger()[VIC1]
    assert entry["state"] == "failed" and entry["steps"]["creative"]["state"] == "failed"
    assert entry["steps"]["creative"]["error"]["code"] == 100
    assert "Bad link" in capsys.readouterr().err
    meta.calls.clear()
    assert upload(env, meta) == 0
    assert routes(writes(meta.calls)) == [("POST", f"{N}/{ACCOUNT}/adcreatives"),
                                          ("POST", f"{N}/{VIC_TEMPLATE}/copies"), ("POST", f"{N}/{ACCOUNT}/ads")]
    assert len(meta.videos) == 1


def test_a_changed_file_is_not_resumed_without_force(env, capsys):
    meta = FakeMeta()
    meta.faults.append(("POST", f"{ACCOUNT}/adcreatives", err(400, 100), False))
    assert upload(env, meta) == 1
    path = env.render(content=CONTENT + b"new cut")
    meta.calls.clear()
    assert upload(env, meta, path=path) == 1
    assert writes(meta.calls) == []
    assert "changed since. Pass --force to start over" in capsys.readouterr().err
    assert upload(env, meta, VIC1, "--force", path=path) == 0
    assert env.read_ledger()[VIC1]["attempt"] == 2 and len(meta.videos) == 2


def test_processing_failure_uploads_again_next_time(env, capsys):
    meta = FakeMeta()
    meta.video_states = [{"video_status": "error", "processing_phase": {"status": "error",
                                                                         "errors": [{"message": "corrupt"}]}}]
    assert upload(env, meta) == 1
    assert "Meta couldn't process video" in capsys.readouterr().err
    assert env.read_ledger()[VIC1]["steps"]["video"]["state"] == "failed"
    assert upload(env, meta) == 0
    assert len(meta.videos) == 2


def test_it_waits_for_processing_and_gives_up_at_the_deadline(env, monkeypatch, capsys):
    meta = FakeMeta()
    processing = {"video_status": "processing", "uploading_phase": {"status": "complete"},
                  "processing_phase": {"status": "in_progress"}}
    meta.video_states = [processing, processing]
    assert upload(env, meta) == 0
    assert env.sleeps == [ads.POLL_EVERY, ads.POLL_EVERY]
    monkeypatch.setattr(ads, "PROCESS_DEADLINE", 10)
    meta2 = FakeMeta()
    meta2.video_states = [processing] * 10
    env2_ledger = env.ledger + ".2"
    assert ads.main(["upload", env.render(), "--video", VIC1, "--go", "--ledger", env2_ledger], session=meta2) == 1
    assert "still processing" in capsys.readouterr().err
    with open(env2_ledger, encoding="utf-8") as f:
        assert json.load(f)[VIC1]["steps"]["video"]["ready"] is False


def test_the_campaign_has_a_copy_this_ledger_does_not_know(env, capsys):
    meta = FakeMeta()
    assert upload(env, meta) == 0
    os.remove(env.ledger)                              # a new container
    meta.calls.clear()
    assert upload(env, meta) == 1
    assert writes(meta.calls) == []
    assert "this machine's ledger doesn't know (a new container?)" in capsys.readouterr().err


def test_one_go_at_a_time(env, capsys):
    if ads.pr.fcntl is None:
        pytest.skip("no flock here")
    os.makedirs(os.path.dirname(env.ledger), exist_ok=True)
    with ads.ads_lock(env.ledger):
        meta = FakeMeta()
        assert upload(env, meta) == 1
    assert writes(meta.calls) == []
    assert "another ads.py --go is using" in capsys.readouterr().err


# ------------------------------------------------------------------ secrets

def test_a_token_meta_echoes_never_reaches_output_exceptions_or_the_ledger(env, monkeypatch, capsys):
    monkeypatch.setenv("META_TOKEN", SYSTEM_TOKEN)
    meta = FakeMeta()
    meta.faults.append(("POST", f"{ACCOUNT}/adcreatives",
                        err(400, 100, f"Invalid parameter (access_token={SYSTEM_TOKEN})"), False))
    assert upload(env, meta) == 1
    out, errout = capsys.readouterr()
    assert "[token]" in errout
    assert_no_token(out, errout, open(env.ledger, encoding="utf-8").read())
    g = ads.AdsGraph(FakeMeta(), writes=True)
    g.s.faults.append(("GET", ACCOUNT, err(400, 190, f"bad {SYSTEM_TOKEN}"), False))
    with pytest.raises(pr.PostError) as e:
        g.get(ACCOUNT, SYSTEM_TOKEN)
    assert_no_token(str(e.value), repr(e.value.as_dict()))
    # The token is only ever a header: never in a URL, the params or the form.
    for c in meta.calls:
        assert_no_token(c["url"], json.dumps(c["params"]), json.dumps(c["data"]))


def test_a_network_error_is_named_by_type_only(env, monkeypatch, capsys):
    monkeypatch.setenv("META_TOKEN", SYSTEM_TOKEN)
    meta = FakeMeta()
    meta.faults += [("POST", f"{ACCOUNT}/advideos",
                     requests.ConnectionError(f"https://x?access_token={SYSTEM_TOKEN}"), False)] * 3
    assert upload(env, meta) == 1
    out, errout = capsys.readouterr()
    assert "ConnectionError" in errout
    assert_no_token(out, errout)


# ------------------------------------------------------------------ the account, the campaign, the template

def test_the_other_ad_account_is_never_called():
    g = ads.AdsGraph(FakeMeta(), writes=True)
    for path in (OTHER_ACCOUNT, f"{OTHER_ACCOUNT}/campaigns", "act_999/ads", "263113944523091/insights"):
        with pytest.raises(pr.PostError, match="refused"):
            g.get(path, pr.NETWORK_KEY)
    assert g.s.calls == []
    # An id that merely contains those digits is fine.
    g.s.faults.append(("GET", "12631139445230910", ok({"id": "12631139445230910"}), False))
    assert g.get("12631139445230910", pr.NETWORK_KEY)["id"] == "12631139445230910"


def test_a_town_pinned_to_another_account_is_refused(monkeypatch):
    real = ads.town_meta
    monkeypatch.setattr(ads, "town_meta", lambda slug: dict(real(slug), ad_account_id="263113944523091"))
    with pytest.raises(pr.PostError, match="pins ad account 263113944523091"):
        ads.campaign_name("lincoln")


def test_campaign_names_are_the_towns_prefixes_exactly():
    assert {slug: ads.campaign_name(slug) for slug in towns.TOWNS} == {
        "victoria": "Vic Newsletter Leads", "lincoln": "The Star 402 Newsletter Leads",
        "medford": "The Rogue 541 Newsletter Leads", "shoals": "Shoals Setlist Newsletter Leads",
        "virginiabeach": "The Tide 757 Newsletter Leads"}


def test_only_the_exact_name_counts(env):
    meta = FakeMeta()
    sv = ads.survey(ads.AdsGraph(meta), pr.NETWORK_KEY, "victoria")
    assert sv["campaign"]["id"] == VIC_CAMPAIGN and [c["id"] for c in sv["siblings"]] == [COPY_CAMPAIGN]
    del meta.campaigns[VIC_CAMPAIGN]
    with pytest.raises(pr.PostError, match="no campaign named exactly 'Vic Newsletter Leads'"):
        ads.survey(ads.AdsGraph(meta), pr.NETWORK_KEY, "victoria")
    meta = FakeMeta()
    meta.campaigns["1"] = dict(meta.campaigns[VIC_CAMPAIGN], id="1")
    with pytest.raises(pr.PostError, match="2 campaigns are named exactly"):
        ads.survey(ads.AdsGraph(meta), pr.NETWORK_KEY, "victoria")


def test_the_template_is_the_campaigns_own_ad_set(env):
    meta = FakeMeta()
    assert upload(env, meta) == 0
    sv = ads.survey(ads.AdsGraph(meta), pr.NETWORK_KEY, "victoria")
    assert ads.template_adset(sv, {})["id"] == VIC_TEMPLATE       # the copy has the [id] mark
    meta.adsets["5"] = dict(meta.adsets[VIC_TEMPLATE], id="5", name="Victoria November")
    sv = ads.survey(ads.AdsGraph(meta), pr.NETWORK_KEY, "victoria")
    with pytest.raises(pr.PostError, match="2 ad sets that could be the template"):
        ads.template_adset(sv, {})
    assert ads.template_adset(sv, {}, "5")["id"] == "5"
    with pytest.raises(pr.PostError, match="isn't an ad set of Vic Newsletter Leads"):
        ads.template_adset(sv, {}, TIDE_TEMPLATE)


def test_only_a_towns_video_id_marks_an_ad_set_as_ours():
    assert ads.marker("Halloween Ad [victoria-2026-10-25]") == ("victoria-2026-10-25", 1)
    assert ads.marker("The Tide 757 October [virginiabeach-2026-11-01 #3]") == ("virginiabeach-2026-11-01", 3)
    # If Meta adds its " - Copy" after the suffix after all, it still counts.
    assert ads.marker("Halloween Ad [victoria-2026-10-25] - Copy") == ("victoria-2026-10-25", 1)
    for name in ("Promo [test]", "Halloween Ad", "Fall [kearney-1]", "[2026] plan"):
        assert ads.marker(name) == (None, None)


def test_a_zero_budget_is_no_budget():
    sv = {"campaign": {"daily_budget": "0", "lifetime_budget": "0"}}
    assert ads.budget(sv, {"daily_budget": "2500"}) == (2500.0, None, "the ad set's own budget")
    assert ads.budget(sv) == (None, None, "no budget")
    assert ads.budget_lines(sv) == ["no budget set: nothing would deliver"]


def test_paging_reads_every_page():
    meta = FakeMeta()
    meta.faults.append(("GET", f"{ACCOUNT}/campaigns", ok({"data": [{"id": "1"}],
                                                            "paging": {"cursors": {"after": "P2"}, "next": "x"}}),
                        False))
    meta.faults.append(("GET", f"{ACCOUNT}/campaigns", ok({"data": [{"id": "2"}], "paging": {"cursors": {}}}), False))
    got = ads.AdsGraph(meta).all(f"{ACCOUNT}/campaigns", pr.NETWORK_KEY, fields="id")
    assert [c["id"] for c in got] == ["1", "2"]
    assert [c["params"] for c in meta.calls] == [{"fields": "id"}, {"fields": "id", "after": "P2"}]


def test_the_marketing_api_version_is_current_unless_set():
    code = ("import ads; print(ads.GRAPH); print(ads.NETWORK_GRAPH); print(ads.version_note() is None); "
            "import post_reel; print(post_reel.GRAPH)")
    env = {k: v for k, v in os.environ.items() if k != "GRAPH_API_VERSION"}
    run = subprocess.run([sys.executable, "-c", code], cwd=VIDEO, capture_output=True, text=True, timeout=60, env=env)
    # v23.0 stays post_reel's (Pages and Reels); the Marketing API's expired.
    assert run.stdout.split() == ["https://graph.facebook.com/v26.0", "https://graph-video.facebook.com/v26.0",
                                  "True", "https://graph.facebook.com/v23.0"]
    run = subprocess.run([sys.executable, "-c", code], cwd=VIDEO, capture_output=True, text=True, timeout=60,
                         env={**env, "GRAPH_API_VERSION": "23.0"})
    assert run.stdout.split()[:3] == ["https://graph.facebook.com/v23.0", "https://graph-video.facebook.com/v23.0",
                                      "False"]


def test_an_expired_version_refuses_to_upload(env, monkeypatch, capsys):
    # As if GRAPH_API_VERSION=v23.0 were set (the URLs stay the fake's).
    monkeypatch.setattr(ads, "GRAPH_VERSION", "v23.0")
    meta = FakeMeta()
    assert upload(env, meta) == 1
    assert writes(meta.calls) == []
    assert "Marketing API v23.0 has expired" in capsys.readouterr().err


def test_metas_version_refusal_names_this_files_version(env):
    meta = FakeMeta()
    meta.faults.append(("GET", ACCOUNT, err(400, 2635, "(#2635) You are calling a deprecated version of the Ads "
                                                    "API. Please update to the latest version."), False))
    with pytest.raises(pr.PostError) as e:
        ads.AdsGraph(meta).get(ACCOUNT, pr.NETWORK_KEY)
    assert f"Meta refused Marketing API {ads.GRAPH_VERSION}" in str(e.value)
    assert "set GRAPH_API_VERSION" in str(e.value)


# ------------------------------------------------------------------ the window, the words, the file

@pytest.mark.parametrize("video, problem", [
    ({"post_at_local": "2026-10-25T18:00", "run_until_local": "2026-10-25T17:00"}, "isn't after post_at_local"),
    ({"post_at_local": "2026-10-20T18:00", "run_until_local": "2026-10-22T17:00"}, "the run window ended"),
    ({"post_at_local": "2026-11-01T01:30"}, "happens twice"),
    ({}, "has no post_at_local"),
])
def test_bad_windows(video, problem):
    win = ads.run_window(dict(video, id="x"), towns.town("victoria"), NOW)
    assert any(problem in p for p in win["problems"]), win


def test_a_short_window_is_noted():
    win = ads.run_window({"id": "x", "post_at_local": "2026-10-25T18:00", "run_until_local": "2026-10-26T06:00"},
                         towns.town("victoria"), NOW)
    assert not win["problems"] and "only 12 hours" in win["notes"][0]


def test_the_url_tags_are_what_the_site_reads_as_a_paid_meta_visit():
    tags = dict(p.split("=", 1) for p in ads.url_tags("lincoln-2026-10-25").split("&"))
    assert tags == {"utm_source": "{{site_source_name}}", "utm_medium": "paid", "utm_campaign": "{{campaign.name}}",
                    "utm_content": "lincoln-2026-10-25"}
    with open(os.path.join(towns.REPO, "server", "analytics.js"), encoding="utf-8") as f:
        js = f.read()
    mediums = re.search(r"PAID_MEDIUMS = new Set\(\[([^\]]*)\]", js).group(1)
    assert "'paid'" in mediums
    meta_utm = re.search(r"META_UTM = /(.*)/;", js).group(1)
    for source in ("fb", "ig", "an", "msg"):   # what Meta's {{site_source_name}} fills in
        assert re.fullmatch(meta_utm, source)
    with open(os.path.join(towns.REPO, "AGENTS.md"), encoding="utf-8") as f:
        assert "?utm_source={{site_source_name}}&utm_medium=paid&utm_campaign={{campaign.name}}" in f.read()


def test_the_budget_cap_is_meta_ads_own():
    with open(os.path.join(towns.REPO, "scripts", "meta_ads.py"), encoding="utf-8") as f:
        cap = float(re.search(r"^MAX_DAILY_BUDGET = (\d+)", f.read(), re.M).group(1))
    assert ads.MAX_DAILY_BUDGET == cap == 50


def test_the_headline_defaults_to_everything_to_do_in_the_city():
    assert ads.ad_text({"id": "s", "caption": "x"}, towns.town("shoals"))["title"] == \
        "Everything to do in the Shoals, free"
    assert ads.ad_text({"id": "s", "caption": "x", "headline": " Free stuff "}, towns.town("shoals"))["title"] == \
        "Free stuff"


def test_standard_enhancements_and_auto_crop_stay_off():
    f = ads.CREATIVE_FEATURES
    assert "standard_enhancements" not in f and "image_touchups" not in f
    assert f["video_auto_crop"] == {"enroll_status": "OPT_OUT"}
    assert f["translate_voiceover"] == {"enroll_status": "OPT_OUT"}


def test_the_4x5_render_passes(env):
    rep = ads.check_file(env.render())
    assert rep["problems"] == [] and rep["warnings"] == [] and rep["ratio"] == "4:5"


@pytest.mark.parametrize("video, fmt, problem", [
    ({"width": 1920, "height": 1080}, None, "neither 4:5 nor 9:16"),
    ({"codec_name": "prores"}, None, "Meta asks for H.264"),
    ({"color_transfer": "arib-std-b67"}, None, "HDR video"),
    (None, {"tags": {"com.apple.quicktime.model": "iPhone 15"}}, "a raw take"),
    (None, {"duration": "0.5"}, "1 second to 241 minutes"),
    ({"width": 100, "height": 125}, None, "under Meta's 120x120"),
])
def test_files_meta_or_we_would_refuse(env, video, fmt, problem):
    env.probe = probe_with(video=video, fmt=fmt)
    rep = ads.check_file(env.render())
    assert any(problem in p for p in rep["problems"]), rep


def test_a_9x16_as_the_ad_only_warns(env):
    env.probe = probe_with(video={"width": 1080, "height": 1920})
    rep = ads.check_file(env.render())
    assert rep["problems"] == [] and "Feed (most of the delivery) shows at most 4:5" in rep["warnings"][0]


def test_story_is_refused_with_the_reason(env, capsys):
    meta = FakeMeta()
    env.probe = probe_with(video={"width": 1080, "height": 1920})
    story = env.render(name="reel-9x16.mp4")
    env.probe = GOOD_PROBE
    assert upload(env, meta, VIC1, "--story", story) == 1
    assert writes(meta.calls) == []
    assert "placement asset customization doesn't fit these ads" in capsys.readouterr().err


def test_a_file_named_for_another_video_is_refused(env, capsys):
    meta = FakeMeta()
    assert run(env, meta, "plan", env.render(TIDE1), "--video", VIC1) == 1
    assert f"the file's path names {TIDE1}, not {VIC1}" in capsys.readouterr().out


# ------------------------------------------------------------------ status

def test_status_shows_each_towns_campaign_spend_results_and_ledger(env, capsys):
    meta = FakeMeta()
    assert upload(env, meta) == 0
    assert run(env, meta, "go", "--video", VIC1, "--go") == 0
    _, a = ours(meta, VIC1)
    meta.insight_rows = {
        (VIC_CAMPAIGN, "today", None): [{"spend": "12.40", "inline_link_clicks": "30",
                                         "actions": [{"action_type": "lead", "value": "8"}]}],
        (VIC_CAMPAIGN, "last_7d", None): [{"spend": "17.20", "inline_link_clicks": "42", "date_start": "2026-10-16",
                                           "date_stop": "2026-10-22",
                                           "actions": [{"action_type": "offsite_conversion.fb_pixel_lead",
                                                        "value": "11"}]}],
        (VIC_CAMPAIGN, "last_7d", "ad"): [{"ad_id": a["id"], "spend": "5.00", "actions": [
            {"action_type": "lead", "value": "4"}]}],
    }
    capsys.readouterr()
    meta.calls.clear()
    assert run(env, meta, "status", "--town", "victoria") == 0
    out = capsys.readouterr().out
    assert writes(meta.calls) == []
    assert routes(meta.calls)[-3:] == [("GET", f"{N}/{VIC_CAMPAIGN}/insights")] * 3
    assert [c["params"]["date_preset"] for c in meta.calls[-3:]] == ["today", "last_7d", "last_7d"]
    assert meta.calls[-1]["params"]["level"] == "ad"
    assert "victoria: The Vic 361, campaign 'Vic Newsletter Leads' (120250753433250269)" in out
    assert "Campaign: ACTIVE; $68.00/day (campaign budget)" in out
    assert f"ad set 'Halloween Ad [{VIC1}]'" in out
    assert "Today: $12.40 spent, 8 results ($1.55 each), 30 link clicks" in out
    assert "Last 7 days (2026-10-16 to 2026-10-22): $17.20 spent, 11 results ($1.56 each), 42 link clicks" in out
    assert f"{VIC1} (ad {a['id']}): $5.00 spent, 4 results ($1.25 each)" in out
    assert f"{VIC1}  live  Sun Oct 25 2026, 6:00 PM CDT -> Sat Oct 31 2026, 5:00 PM CDT" in out


def test_status_without_any_key_shows_the_ledgers(env, capsys):
    meta = FakeMeta()
    assert upload(env, meta) == 0
    capsys.readouterr()
    meta.calls.clear()
    meta.faults.append(("GET", ACCOUNT, err(400, 200, "(#200) Provide valid app ID"), False))
    assert run(env, meta, "status") == 1
    out = capsys.readouterr().out
    assert len(meta.calls) == 1 and "No Facebook key" in out
    assert f"{VIC1}  uploaded" in out
    assert out.count("Ledger:") == len(towns.TOWNS)


# ------------------------------------------------------------------ real ffmpeg

needs_ffmpeg = pytest.mark.skipif(not (shutil.which("ffmpeg") and shutil.which("ffprobe")),
                                  reason="needs ffmpeg and ffprobe")


@needs_ffmpeg
def test_real_ffmpeg_checks_a_4x5_clip_and_grabs_its_thumbnail(tmp_path):
    clip = str(tmp_path / "feed-4x5.mp4")
    subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y",
                    "-f", "lavfi", "-i", "testsrc2=size=432x540:rate=30:duration=2",
                    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
                    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-shortest", clip],
                   check=True, timeout=120, capture_output=True)
    rep = ads.check_file(clip)
    assert rep["problems"] == [] and rep["ratio"] == "4:5"
    assert rep["facts"][0].startswith("video: H.264 432x540 (4:5), 30 fps")
    thumb = ads.frame_jpeg(clip, str(tmp_path / "t" / "thumb.jpg"))
    with open(thumb, "rb") as f:
        assert f.read(3) == b"\xff\xd8\xff"   # a JPEG
    with pytest.raises(pr.PostError, match="couldn't grab the thumbnail"):
        ads.frame_jpeg(str(tmp_path / "missing.mp4"), str(tmp_path / "t" / "x.jpg"))
