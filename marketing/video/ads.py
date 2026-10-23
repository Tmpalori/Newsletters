#!/usr/bin/env python3
"""Run a finished subscribe video as an ad in its town's Meta campaign.

    python3 ads.py plan   out/renders/victoria-1/feed-4x5.mp4 --video victoria-1
    python3 ads.py upload out/renders/victoria-1/feed-4x5.mp4 --video victoria-1 --go
    python3 ads.py go     --video victoria-1 [--go]
    python3 ads.py stop   --video victoria-1 [--campaign] [--go]
    python3 ads.py status [--town SLUG]

Every town has one campaign in the shared ad account (act_2614503002399063,
"The Vic Ads"), named exactly its "meta".campaign_prefix (towns/<slug>/
town.json; Victoria's in town.py VICTORIA): "Vic Newsletter Leads", "The Star
402 Newsletter Leads"... An exact name, never a prefix: "Vic Newsletter Leads
- Copy" is another campaign. Its one original ad set ("<Town> October",
Victoria's "Halloween Ad") is the template: each video gets a copy of it, so
the targeting, pixel and optimization Tristen set up carry over, with the
video's own run window.

plan (and upload without --go) only reads: the campaign with its status and
daily budget, the template ad set, the run window (scripts.json
post_at_local to run_until_local, town time and UTC; no run_until_local runs
until stopped), the file against Meta's video ad specs, the ad's words and
link, the spend, and every other ad set or ad in the campaign that would
deliver if the campaign were on. Its Graph client refuses anything but a GET.

upload --go makes the ad, PAUSED: the 4:5 video to the account's library
(POST act_/advideos), a wait until Meta has processed it, a thumbnail (POST
act_/adimages), the creative (POST act_/adcreatives: the Page, video_data
with the caption as primary text, the headline, CTA SUBSCRIBE to the town's
/subscribe with url_tags the site reads as a paid Meta visit), a copy of the
template ad set (POST /{adset}/copies, status_option PAUSED, the window as
start_time/end_time) and the ad in it (POST act_/ads, status PAUSED). Nothing
is turned on. The 9:16 cut isn't used: Meta's placement asset customization
doesn't fit here (see STORY_NOT_USED), so the 4:5 runs everywhere.

go shows what turns on (this video's ad and ad set, and the campaign if it's
paused), what gets paused so only this video spends (every other active ad
set and ad in the campaign: the old "October" ones, the town's previous
video) and the spend; go --go pauses those first, then turns these on. stop
pauses the video's ad and ad set (--campaign: the campaign too). status
shows each town's campaign, what's on, spend today and over the last 7 days,
results (Meta's lead count, the pixel's Lead event) and their cost, and the
ledger. Nothing here ever changes a budget: it's shown, with a note when
it's over scripts/meta_ads.py's MAX_DAILY_BUDGET.

The token is post_reel.py's: the system user's key as the environment's
network secret on graph-video.facebook.com (so every call goes there, with
no Authorization of ours), or META_TOKEN (else META_PAGE_TOKEN) on
graph.facebook.com. It only travels in an Authorization header and is never
printed, logged, raised or written down. The Marketing API version is
v26.0 unless GRAPH_API_VERSION says otherwise (see GRAPH_VERSION: post_reel's
v23.0 has expired for the Marketing API).

out/ads.json is the ledger: per video, every id made and the step each
reached, written before each create ("pending") and after it, so a second
upload is refused (--force makes a new set) and a run that stopped midway
picks up where it was, looking up by name anything whose answer was lost
before making it again. One --go at a time (out/ads.json.lock).
"""
import argparse
import ast
import base64
import contextlib
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
from zoneinfo import ZoneInfo

import requests

import post_reel as pr
import towns

PostError = pr.PostError
say = pr.say

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = towns.REPO
LEDGER_PATH = os.path.join(HERE, "out", "ads.json")
THUMBS = os.path.join(HERE, "out", "ads")  # the thumbnail frames uploaded with each ad

# The ad account every town's campaign lives in, and the other one the
# system user's token also sees, which belongs to something else: no call
# may name it (AdsGraph refuses the URL).
AD_ACCOUNT = "act_2614503002399063"
NEVER = ("263113944523091",)

# The Marketing API retires versions on its own, faster schedule: v23.0
# (post_reel's default, fine for Pages and Reels until 2027) expired for it
# on June 9, 2026 and v24.0 in October. A call to an expired version is only
# upgraded when nothing changed for that endpoint since, and v24.0-v26.0
# changed POST act_/adcreatives, /{adset}/copies, act_/ads and /{ad}, so
# those would fail. So ads.py defaults to v26.0, the current one (Graph API
# changelog, "Marketing API" table); GRAPH_API_VERSION overrides it, as for
# every other script here.
GRAPH_VERSION = os.environ.get("GRAPH_API_VERSION", "").strip() or "v26.0"
GRAPH_VERSION = GRAPH_VERSION if GRAPH_VERSION.startswith("v") else f"v{GRAPH_VERSION}"
GRAPH = f"https://graph.facebook.com/{GRAPH_VERSION}"
NETWORK_GRAPH = f"https://{pr.NETWORK_HOST}/{GRAPH_VERSION}"

# What the ad says and where it goes, after the Tide's "the tide october",
# the account's one video ad (Ads Manager made it): CTA SUBSCRIBE to the
# town's /subscribe, the domain as the display link, and its description.
CTA = "SUBSCRIBE"
HEADLINE = "Everything to do in {city}, free"
LINK_DESCRIPTION = "Free every Monday and Thursday"
# The site counts a visit as paid Meta traffic when utm_medium=paid and
# utm_source is Meta's {{site_source_name}} (fb, ig, an, msg): server/
# analytics.js paidSource(), docs/track.js (a signup in that visit is
# "<form>:ad"). AGENTS.md: ad links end in exactly the first three; the
# video id rides in utm_content, which only Google Analytics keeps.
URL_TAGS = "utm_source={{site_source_name}}&utm_medium=paid&utm_campaign={{campaign.name}}&utm_content={vid}"

# Advantage+ creative features (degrees_of_freedom_spec.creative_features_spec),
# one by one as Meta's "Get Started with Advantage+ Creative" asks since
# v22.0. As the Tide's video ad has them, except:
# - standard_enhancements is left out: that guide deprecates opting in to it;
# - image_touchups is left out: "Only applicable to image ads";
# - video_auto_crop is out: it crops the 4:5 to fit taller placements, which
#   would cut the burned-in hook, chips and captions at the sides
#   (video_uncrop and pac_relaxation fit it without cutting);
# - the AI voice and translation features (not on the Tide's ad either) are
#   out explicitly: Tristen's own voice and words, as filmed.
CREATIVE_FEATURES = {
    "inline_comment": {"enroll_status": "OPT_IN"},
    "enhance_cta": {"enroll_status": "OPT_IN", "customizations": {"text_extraction": {"enroll_status": "OPT_IN"}}},
    "pac_relaxation": {"enroll_status": "OPT_IN"},
    "video_uncrop": {"enroll_status": "OPT_IN"},
    "video_auto_crop": {"enroll_status": "OPT_OUT"},
    "video_filtering": {"enroll_status": "OPT_OUT"},
    "text_optimizations": {"enroll_status": "OPT_OUT"},
    "translate_voiceover": {"enroll_status": "OPT_OUT"},
    "text_translation": {"enroll_status": "OPT_OUT"},
    "creative_stickers": {"enroll_status": "OPT_OUT"},
}

# Why --story (a 9:16 cut for Stories and Reels) isn't used. The only
# documented way is placement asset customization, and here it isn't
# straightforward: its customization_spec position lists have no Reels
# (facebook_reels, reels); the asset feed rules say "If you use Instagram as
# your placement, only square videos or landscape videos allowed", and two
# towns' ad sets deliver on Instagram; its supported objectives are the
# legacy names (no OUTCOME_LEADS); and it replaces the Tide's video_data
# creative with an asset_feed_spec one, whose thumbnails are URLs only. So
# the 4:5 runs everywhere, and Meta fits it to the taller placements.
STORY_NOT_USED = ("the 9:16 cut isn't used: Meta's placement asset customization doesn't fit these ads (no Reels "
                  "positions in its rules, no vertical video with Instagram in an asset feed, legacy objectives "
                  "only), so the ad runs the 4:5 cut in every placement and Meta fits it to Stories and Reels")

# Meta Ads Guide, video: Facebook Feed is the main placement ("Ratio: 4:5",
# "Video Duration: 1 second to 241 minutes", "Maximum File Size: 4GB",
# "Minimum Width: 120 pixels Minimum Height: 120 pixels", "Primary Text:
# 50-150 characters Headline: 27 characters"); Stories and Reels are 9:16
# ("Aspect Ratio Tolerance: 1%"). render.py makes the 4:5 at 1080x1350.
FEED_RATIO, STORY_RATIO = 4 / 5, 9 / 16
RATIO_TOLERANCE = 0.01
MIN_SIDE = 120
DURATION = (1.0, 241 * 60.0)
MAX_BYTES = 4_000_000_000
PRIMARY_TEXT_FEED = 150
HEADLINE_FEED = 27
CUT_LONG = pr.CUT_LONG
THUMB_AT = 0.8   # render.py's thumbnail time: the hook is up

# Meta's processing of an uploaded ad video, and how long to wait for it.
POLL_EVERY = 5
PROCESS_DEADLINE = 600
RETRY_DELAYS = pr.RETRY_DELAYS
MAX_PAGES = 20
TIME_SLACK = 120  # seconds Meta may round a start or end time by
MIN_WINDOW = dt.timedelta(hours=24)

# Reads. An ad's creative comes as creative{id}: Meta drops a nested
# object_story_spec{...} on this edge without saying so.
ACCOUNT_FIELDS = "id,name,currency,timezone_name,account_status"
CAMPAIGN_FIELDS = "id,name,account_id,status,effective_status,objective,daily_budget,lifetime_budget,stop_time"
ADSET_FIELDS = ("id,name,account_id,campaign_id,status,effective_status,start_time,end_time,daily_budget,"
                "lifetime_budget,optimization_goal,promoted_object,targeting,created_time")
AD_FIELDS = "id,name,account_id,campaign_id,adset_id,status,effective_status,created_time,creative{id}"
INSIGHT_FIELDS = "spend,impressions,reach,inline_link_clicks,actions"

# Seams for the tests: no real sleeping, a fixed clock.
_sleep = time.sleep
_monotonic = time.monotonic


def _utcnow():
    return dt.datetime.now(dt.timezone.utc)


# ------------------------------------------------------------- the settings

def _assigned(path, name):
    """The literal value of a top-level `name = ...` in a Python file, read
    without importing it (town.py reads TOWN from the environment when
    imported; scripts/meta_ads.py needs the site's settings)."""
    with open(path, encoding="utf-8") as f:
        tree = ast.parse(f.read())
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
            return ast.literal_eval(node.value)
    raise KeyError(name)


def _budget_cap():
    """scripts/meta_ads.py's MAX_DAILY_BUDGET (dollars): its budget command
    refuses more, and its daily report notes a campaign above it. 50 if the
    file can't be read."""
    try:
        return float(_assigned(os.path.join(REPO, "scripts", "meta_ads.py"), "MAX_DAILY_BUDGET"))
    except (OSError, SyntaxError, ValueError, KeyError, TypeError):
        return 50.0


MAX_DAILY_BUDGET = _budget_cap()


def town_meta(slug):
    """The town's Meta pins: towns/<slug>/town.json "meta", Victoria's from
    town.py VICTORIA."""
    try:
        if slug == "victoria":
            meta = _assigned(os.path.join(REPO, "town.py"), "VICTORIA").get("meta")
        else:
            with open(os.path.join(REPO, "towns", slug, "town.json"), encoding="utf-8") as f:
                meta = json.load(f).get("meta")
    except (OSError, ValueError, SyntaxError, KeyError, AttributeError) as e:
        raise PostError(f"can't read {slug}'s Meta settings ({type(e).__name__})") from None
    return meta if isinstance(meta, dict) else {}


def campaign_name(slug):
    """The town's campaign's exact name, its "meta".campaign_prefix. A town
    pinned to another ad account is refused here, before any call."""
    meta = town_meta(slug)
    pin = str(meta.get("ad_account_id") or "").strip()
    if pin and f"act_{pin.removeprefix('act_')}" != AD_ACCOUNT:
        raise PostError(f"{slug}'s town.json pins ad account {pin}, not {AD_ACCOUNT}; ads.py only works in "
                        f"{AD_ACCOUNT}")
    name = str(meta.get("campaign_prefix") or "").strip()
    if not name:
        raise PostError(f"{slug} has no \"meta\".campaign_prefix, so there's no campaign to put its videos in")
    return name


def find_town(vid, entry=None, scripts=None):
    """The town a video belongs to: the ledger's, scripts.json's, else the
    id's own prefix (victoria-1, lincoln-2026-11-08), so a video from an
    archived batch can still be stopped."""
    slug = (entry or {}).get("town") or ((scripts or {}).get(vid) or {}).get("town")
    if not slug:
        hits = [t for t in towns.TOWNS if vid == t or vid.startswith(t + "-")]
        slug = max(hits, key=len) if hits else None
    if slug not in towns.TOWNS:
        raise PostError(f"no town for {vid!r}: not in scripts.json or the ledger, and its id names none of "
                        f"{', '.join(towns.TOWNS)}")
    return towns.town(slug)


def url_tags(vid):
    return URL_TAGS.replace("{vid}", vid)


def ad_text(video, town):
    """The ad's words and link: scripts.json's caption as the primary text,
    its headline (default HEADLINE), CTA SUBSCRIBE to the town's /subscribe."""
    return {"message": str(video.get("caption") or "").strip(),
            "title": str(video.get("headline") or "").strip() or HEADLINE.format(city=town["city"]),
            "headline_from": "scripts.json" if str(video.get("headline") or "").strip() else "default",
            "link": town["subscribe_url"], "link_caption": town["domain"], "link_description": LINK_DESCRIPTION,
            "cta": CTA, "url_tags": url_tags(video["id"])}


def next_attempt(entry, force):
    """The attempt an upload --go makes: the ledger's own when it resumes
    one that stopped midway, the next with --force, else the first."""
    if not entry:
        return 1
    if force:
        return int(entry.get("attempt") or 1) + 1
    return int(entry.get("attempt") or 1)


def names(vid, video, template_name, attempt):
    """What each object is called. The ad set keeps the template's name with
    the video's id in brackets, the one mark that finds it again (MARKER)."""
    n = f" #{attempt}" if attempt > 1 else ""
    angle = str(video.get("angle") or "").strip()
    return {"video": f"{vid} 4x5{n}", "creative": f"{vid} video ad{n}",
            "adset_suffix": f" [{vid}{n}]", "adset": f"{template_name} [{vid}{n}]",
            "ad": f"{vid} ({angle}){n}" if angle else f"{vid} video{n}"}


MARKER = re.compile(r"\[(?P<vid>[a-z0-9][a-z0-9-]*)(?: #(?P<n>\d+))?\]")


def marker(name):
    """(video id, attempt) from an ad set name ads.py made, else (None, None).
    Only a town's video id counts ("Promo [test]" is someone's own name), and
    anywhere in the name: the copies reference leaves it open whether Meta
    still adds its " - Copy" after a suffix given."""
    for m in reversed(list(MARKER.finditer(str(name or "")))):
        if any(m["vid"].startswith(t + "-") for t in towns.TOWNS):
            return m["vid"], int(m["n"] or 1)
    return None, None


# ------------------------------------------------------------------ time

def graph_time(d):
    return d.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+0000")


def _end(v):
    """An ad set's end_time, None when it has none (runs until stopped)."""
    t = pr._time(v)
    return t if t and t.year > 1970 else None


def ended(obj, now, key="end_time"):
    t = _end(obj.get(key))
    return bool(t and t <= now)


def run_window(video, town, now):
    """{"start": (local, utc), "end": (local, utc) or None, "problems",
    "notes"}: scripts.json post_at_local to run_until_local in the town's
    time zone; run_until_local missing or null runs until stopped."""
    out = {"start": None, "end": None, "problems": [], "notes": []}
    vid, tzname = video["id"], town["timezone"]
    try:
        if not video.get("post_at_local"):
            raise PostError(f"{vid} has no post_at_local in scripts.json, so there's no start for its ad")
        out["start"] = pr.local_time(video["post_at_local"], tzname)
        if video.get("run_until_local"):
            out["end"] = pr.local_time(video["run_until_local"], tzname)
    except PostError as e:
        out["problems"].append(str(e))
        return out
    start, end = out["start"][1], out["end"][1] if out["end"] else None
    if end and end <= start:
        out["problems"].append(f"run_until_local {video['run_until_local']} isn't after post_at_local "
                               f"{video['post_at_local']}")
    elif end and end <= now:
        out["problems"].append(f"the run window ended {pr.fmt_both(end, ZoneInfo(tzname))}: nothing would deliver")
    elif end and end - start < MIN_WINDOW:
        out["notes"].append(f"the window is only {pr._span(end - start)}; Meta's budget pacing works in days")
    if start <= now:
        out["notes"].append("the window's start has passed, so the ad set starts as soon as it's turned on")
    return out


def days(start, end):
    return (end - start).total_seconds() / 86400


def n_days(n):
    """'6 days', '5.96 days', '1 day'."""
    text = f"{n:.2f}".rstrip("0").rstrip(".")
    return f"{text} day{'s' * (text != '1')}"


# ------------------------------------------------------------------ the API

def version_note():
    """Why GRAPH_API_VERSION, when it's set to a Marketing API version Meta
    has retired, will make creating ads fail; None for a current one."""
    m = re.match(r"v(\d+)", GRAPH_VERSION)
    if m and int(m.group(1)) < 25:
        return (f"Marketing API {GRAPH_VERSION} has expired (v23.0 on June 9, 2026, v24.0 in October): Meta still "
                "answers reads on it, but creating and changing ads fails; unset GRAPH_API_VERSION (ads.py then "
                "uses v26.0) or set a current version")
    return None


def _guard(url, what):
    """Only The Vic Ads: a URL naming the other ad account, or any act_ but
    ours, never goes out."""
    path = urllib.parse.urlsplit(url).path
    for n in NEVER:
        if re.search(rf"(?<!\d){n}(?!\d)", url):
            raise PostError(f"{what}: refused: ad account {n} isn't The Vic Ads ({AD_ACCOUNT})")
    for acct in re.findall(r"act_(\d+)", path):
        if f"act_{acct}" != AD_ACCOUNT:
            raise PostError(f"{what}: refused: act_{acct} isn't The Vic Ads ({AD_ACCOUNT})")


class AdsGraph(pr.Graph):
    """post_reel's Graph client (timeouts, the token only in the header or
    left to the network, Meta's errors as PostError, retries where repeating
    is safe), for the Marketing API: multipart for the video upload, the
    account guard, and writes only when built with writes=True, so a dry run
    can't change anything even by mistake."""

    def __init__(self, session=None, writes=False):
        super().__init__(session)
        self.writes = writes

    def request(self, method, url, what, token, *, files=None, **kw):
        _guard(url, what)
        if method != "GET" and not self.writes:
            raise PostError(f"{what}: refused, this run only reads (it takes --go to change anything)")
        try:
            return self._send(method, url, what, token, files, **kw)
        except PostError as e:
            if e.code in (12, 2635):  # post_reel's hint names its own version
                raise PostError(f"{what}: Meta refused Marketing API {GRAPH_VERSION}", code=e.code,
                                fbtrace_id=e.fbtrace_id, status=e.status,
                                hint="set GRAPH_API_VERSION to the current Marketing API version") from None
            raise

    def _send(self, method, url, what, token, files, **kw):
        if files is None:
            return super().request(method, url, what, token, **kw)
        if token is pr.NETWORK_KEY:
            if urllib.parse.urlsplit(url).hostname != pr.NETWORK_HOST:
                raise PostError(f"{what}: the network key only works on {pr.NETWORK_HOST}")
            headers = {}
        else:
            headers = {"Authorization": f"Bearer {token}"}
        try:
            r = self.s.request(method, url, data=kw.get("data"), files=files, headers=headers,
                               timeout=kw.get("timeout", pr.UPLOAD_TIMEOUT))
        except requests.RequestException as e:
            # Only the type, as in post_reel: requests' text can carry a header.
            raise PostError(f"{what}: {type(e).__name__}", kind="network", transient=True) from None
        except UnicodeError:
            raise PostError(f"{what}: a header had a character HTTP can't carry (check META_TOKEN)") from None
        return pr._answer(r, what)

    @staticmethod
    def base(token):
        return NETWORK_GRAPH if token is pr.NETWORK_KEY else GRAPH

    def call(self, method, path, what, token, **kw):
        """post_reel's call (a bounded retry of Meta's transient errors),
        on this file's Marketing API version."""
        for delay in RETRY_DELAYS + (None,):
            try:
                return self.request(method, f"{self.base(token)}/{path}", what, token, **kw)
            except PostError as e:
                if not e.transient or delay is None:
                    raise
                say(f"{e}; retrying in {delay}s")
                _sleep(delay)

    def get(self, path, token, what=None, **params):
        return self.call("GET", path, what or f"GET /{path}", token, params=params or None)

    def all(self, path, token, what=None, **params):
        """Every page of a list edge (a few dozen objects at most here)."""
        out, after = [], None
        for _ in range(MAX_PAGES):
            body = self.get(path, token, what, **params, **({"after": after} if after else {}))
            out += [x for x in body.get("data") or [] if isinstance(x, dict)]
            paging = body.get("paging") if isinstance(body.get("paging"), dict) else {}
            after = (paging.get("cursors") or {}).get("after")
            if not after or not paging.get("next"):
                break
        return out

    def once(self, path, token, what, data=None, files=None):
        """A create, sent once: whether to send it again is create()'s call."""
        kw = {"timeout": pr.UPLOAD_TIMEOUT} if files else {}
        return self.request("POST", f"{self.base(token)}/{path}", what, token, data=data, files=files, **kw)

    def set_status(self, obj_id, status, token, what):
        # Setting a status twice is harmless, so Meta's transient errors get
        # post_reel's bounded retry here.
        return self.call("POST", obj_id, what, token, data={"status": status})


def create(step, what, send, lookup, record):
    """One create call, which is not safe to repeat blindly. The ledger has
    the step "pending" before the call goes out. When the answer is lost
    (timeout, 5xx), it waits, then looks for the object by its name, and
    sends again only if Meta has none, a bounded number of times; still
    unclear after the last, it stays pending and the next run looks first.
    A refusal (Meta's 4xx) made nothing: the step is "failed"."""
    for delay in RETRY_DELAYS + (None,):
        record(step, "pending")
        try:
            return send()
        except PostError as e:
            if not e.transient:
                record(step, "failed", error=e.as_dict())
                raise
            if delay is None:
                raise pr.Unconfirmed.wrap(e, f"Meta may have made the {what} anyway; the next upload --go looks "
                                             "for it before making another") from None
            say(f"{e}; looking for the {what} in {delay}s before sending it again")
            _sleep(delay)
            try:
                found = lookup()
            except PostError as le:
                raise pr.Unconfirmed.wrap(e, f"and looking for the {what} failed too ({le.message})") from None
            if found:
                return found
            say(f"Meta has no {what} by that name, so sending it again.")


# ------------------------------------------------------------------ Meta's side

def no_key_help(e):
    return f"{pr.NO_KEY_HELP} ({e.message})"


def survey(graph, token, slug):
    """The town's campaign as Meta has it: the account, the campaign with
    exactly the town's name, its ad sets and ads, and any other campaign
    whose name starts with it (never touched, only shown)."""
    name = campaign_name(slug)
    try:
        account = graph.get(AD_ACCOUNT, token, fields=ACCOUNT_FIELDS)
    except PostError as e:
        if token is pr.NETWORK_KEY and pr.no_key(e):
            raise PostError(no_key_help(e)) from None
        raise
    if account.get("id") != AD_ACCOUNT:
        raise PostError(f"Meta answered for {account.get('id')!r}, not {AD_ACCOUNT}")
    campaigns = graph.all(f"{AD_ACCOUNT}/campaigns", token, fields=CAMPAIGN_FIELDS, limit="100")
    live = [c for c in campaigns if c.get("status") not in ("DELETED", "ARCHIVED")]
    exact = [c for c in live if c.get("name") == name]
    if not exact:
        raise PostError(f"no campaign named exactly {name!r} in {AD_ACCOUNT}; make it in Ads Manager (a campaign "
                        "named for another prefix, or with more after it, doesn't count)")
    if len(exact) > 1:
        raise PostError(f"{len(exact)} campaigns are named exactly {name!r} ({', '.join(c['id'] for c in exact)}); "
                        "rename or archive the extra ones in Ads Manager")
    campaign = exact[0]
    if str(campaign.get("account_id") or AD_ACCOUNT[4:]) != AD_ACCOUNT[4:]:
        raise PostError(f"campaign {campaign['id']} is in account {campaign.get('account_id')}, not {AD_ACCOUNT}")
    cid = campaign["id"]
    adsets = [s for s in graph.all(f"{cid}/adsets", token, fields=ADSET_FIELDS, limit="100")
              if s.get("campaign_id", cid) == cid]
    ads = [a for a in graph.all(f"{cid}/ads", token, fields=AD_FIELDS, limit="100") if a.get("campaign_id", cid) == cid]
    siblings = [c for c in live if c is not campaign and str(c.get("name") or "").startswith(name)]
    return {"slug": slug, "name": name, "account": account, "campaign": campaign, "adsets": adsets, "ads": ads,
            "siblings": siblings}


def in_campaign(sv, obj_id):
    """A write's id must be the town's campaign or something in it."""
    ids = {sv["campaign"]["id"]} | {s["id"] for s in sv["adsets"]} | {a["id"] for a in sv["ads"]}
    if obj_id not in ids:
        raise PostError(f"refused: {obj_id} isn't in {sv['name']} ({sv['campaign']['id']})")
    return obj_id


def ledger_ids(ledger):
    """Every ad set and ad id the ledger has made, all attempts."""
    out = set()
    for e in pr._attempts(ledger):
        for step in ("adset", "ad"):
            i = ((e.get("steps") or {}).get(step) or {}).get("id")
            if i:
                out.add(str(i))
    return out


def template_adset(sv, ledger, wanted=None):
    """The ad set each video's is copied from: the campaign's own, the one
    ads.py didn't make. --template picks one when there are several."""
    sets = [s for s in sv["adsets"] if s.get("status") not in ("DELETED", "ARCHIVED")]
    if wanted:
        hit = [s for s in sets if s["id"] == str(wanted)]
        if not hit:
            raise PostError(f"--template {wanted} isn't an ad set of {sv['name']} ({sv['campaign']['id']})")
        return hit[0]
    mine = ledger_ids(ledger)
    candidates = [s for s in sets if s["id"] not in mine and marker(s.get("name"))[0] is None]
    if len(candidates) == 1:
        return candidates[0]
    if not candidates:
        raise PostError(f"{sv['name']} has no ad set of its own to copy (every one is a video's); make one in Ads "
                        "Manager, or pass --template ADSET_ID")
    listed = "; ".join(f"{s.get('name')} ({s['id']})" for s in candidates)
    raise PostError(f"{sv['name']} has {len(candidates)} ad sets that could be the template ({listed}); pass "
                    "--template ADSET_ID")


def instagram_account(graph, token, sv, template, page_id):
    """(Instagram account id or None, where it came from, whether the ad set
    can deliver on Instagram). The id comes from an ad already in the
    campaign for the same Page (the Tide's "the tide october" has one), the
    template's first: the Page doesn't list it to the system user."""
    platforms = (template.get("targeting") or {}).get("publisher_platforms")
    if platforms and "instagram" not in platforms:
        return None, "", False
    for a in sorted(sv["ads"], key=lambda a: a.get("adset_id") != template["id"]):
        cid = (a.get("creative") or {}).get("id")
        if not cid:
            continue
        try:
            spec = graph.get(cid, token, fields="object_story_spec").get("object_story_spec") or {}
        except PostError:
            continue  # an old creative Meta won't show: the next ad may say
        ig = str(spec.get("instagram_user_id") or "")
        if ig.isdigit() and str(spec.get("page_id") or page_id) == str(page_id):
            return ig, f"the campaign's ad {a.get('name')!r}", True
    return None, "", True


def would_deliver(sv, now, skip=()):
    """(ad sets, ads) in the campaign, other than `skip`, that would deliver
    if the campaign were on now: ACTIVE and not past their end, under an ad
    set that would."""
    sets = [s for s in sv["adsets"] if s["id"] not in skip and s.get("status") == "ACTIVE" and not ended(s, now)]
    ids = {s["id"] for s in sets}
    ads = [a for a in sv["ads"] if a["id"] not in skip and a.get("status") == "ACTIVE" and a.get("adset_id") in ids
           and a.get("effective_status") != "DISAPPROVED"]
    return sets, ads


def money(cents):
    return f"${float(cents) / 100:,.2f}"


def budget(sv, adset=None):
    """(cents per day or None, cents lifetime or None, where it's set). The
    campaign's (Advantage campaign budget), else the ad set's own."""
    c = sv["campaign"]
    if _cents(c.get("daily_budget")) or _cents(c.get("lifetime_budget")):
        return _cents(c.get("daily_budget")), _cents(c.get("lifetime_budget")), "campaign budget"
    if adset and (_cents(adset.get("daily_budget")) or _cents(adset.get("lifetime_budget"))):
        return _cents(adset.get("daily_budget")), _cents(adset.get("lifetime_budget")), "the ad set's own budget"
    return None, None, "no budget"


def _cents(v):
    try:
        return float(v) if v not in (None, "") and float(v) > 0 else None
    except (TypeError, ValueError):
        return None


def budget_lines(sv, adset=None):
    daily, life, where = budget(sv, adset)
    out = []
    if daily:
        out.append(f"{money(daily)}/day ({where})")
        if daily > MAX_DAILY_BUDGET * 100:
            out.append(f"note: that's over the ${MAX_DAILY_BUDGET:,.0f}/day scripts/meta_ads.py's budget command "
                       "allows (Meta doesn't enforce it). Nothing here changes a budget: change it in Ads Manager "
                       "if that's not what you want.")
    elif life:
        out.append(f"{money(life)} lifetime ({where})")
    else:
        out.append("no budget set: nothing would deliver")
    return out


def spend_lines(sv, adset, start, end, now):
    """The spend for a window: the daily budget times its days, or per day
    when it has no end."""
    daily, life, where = budget(sv, adset)
    start = max(start, now)
    if life:
        return [f"up to {money(life)} in all (a lifetime budget)"]
    if not daily:
        return ["nothing: there's no budget"]
    if end is None:
        return [f"{money(daily)} a day until it's stopped (no run_until_local: open-ended)",
                "Meta can spend up to 75% over the daily budget on one day; it evens out over the week"]
    n = max(days(start, end), 0.0)
    return [f"about {money(daily * n)}: {money(daily)}/day x {n_days(n)}",
            "Meta can spend up to 75% over the daily budget on one day; it evens out over the week"]


def describe_targeting(t):
    t = t or {}
    geo = t.get("geo_locations") or {}
    where = []
    for key in ("cities", "places", "regions", "zips", "custom_locations"):
        for g in geo.get(key) or []:
            unit = {"mile": "mi", "kilometer": "km"}.get(g.get("distance_unit"), g.get("distance_unit") or "mi")
            r = f" +{g['radius']} {unit}" if g.get("radius") else ""
            where.append(f"{g.get('name') or g.get('key') or '?'}{r}")
    where += geo.get("countries") or []
    ages = f"ages {t.get('age_min', '?')}-{t.get('age_max', '?')}"
    platforms = t.get("publisher_platforms")
    if platforms:
        placed = "; ".join(f"{p} ({', '.join(t[p + '_positions'])})" if t.get(p + "_positions") else p
                           for p in platforms)
    else:
        placed = "automatic placements (Facebook, Instagram, Messenger, Audience Network)"
    return f"{', '.join(where) or 'anywhere'}, {ages}, {placed}"


def goal_line(s):
    po = s.get("promoted_object") or {}
    goal = s.get("optimization_goal") or "?"
    px = f" for pixel {po['pixel_id']} {po.get('custom_event_type', '')}".rstrip() if po.get("pixel_id") else ""
    return f"{goal}{px}"


def obj_line(kind, o, tz, now):
    status = o.get("status") or "?"
    eff = o.get("effective_status")
    eff = f" (Meta: {eff})" if eff and eff != status else ""
    when = ""
    if kind == "ad set":
        start, end = pr._time(o.get("start_time")), _end(o.get("end_time"))
        if end and end <= now:
            when = f", ended {pr.fmt_local(end, tz)}"
        elif end:
            when = f", until {pr.fmt_local(end, tz)}"
        elif start and start > now:
            when = f", from {pr.fmt_local(start, tz)}, no end"
        else:
            when = ", no end"
    return f"{kind} {o.get('name')!r} ({o['id']}): {status}{eff}{when}"


# ------------------------------------------------------------------ the file

def check_file(path, role="main"):
    """{"problems", "warnings", "facts", "size", "duration", "ratio"} for a
    video about to be an ad, against Meta's video ad specs (Ads Guide):
    the main one should be the 4:5 (Feed's ratio, 1080x1350 from render.py),
    a 9:16 only fits Stories and Reels. Plus post_reel's guards against a raw
    take (the camera's tags, HDR)."""
    rep = {"problems": [], "warnings": [], "facts": [], "size": 0, "duration": None, "ratio": None}
    problems, warnings, facts = rep["problems"], rep["warnings"], rep["facts"]
    if not os.path.isfile(path):
        problems.append(f"no such file: {path}")
        return rep
    size = rep["size"] = os.path.getsize(path)
    if size == 0:
        problems.append("the file is empty")
    elif size > MAX_BYTES:
        problems.append(f"{size / 1e9:,.1f} GB is over Meta's 4 GB for a video ad")
    try:
        info = pr.probe(path)
    except PostError as e:
        problems.append(str(e))
        return rep
    streams = info.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"
                  and not (s.get("disposition") or {}).get("attached_pic")), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    duration = pr._num((info.get("format") or {}).get("duration")) or pr._num((video or {}).get("duration"))
    rep["duration"] = duration
    if duration is None:
        problems.append("ffprobe couldn't tell the duration")
    elif not DURATION[0] <= duration <= DURATION[1]:
        problems.append(f"{duration:.1f} s long; a video ad runs 1 second to 241 minutes")
    elif duration > CUT_LONG:
        warnings.append(f"{duration:.1f} s long; edit.py cuts these to about 16 s (is this a raw take?)")
    tags = {str(k).lower(): str(v) for k, v in ((info.get("format") or {}).get("tags") or {}).items()}
    if any(k in tags for k in pr.CAMERA_TAGS):
        problems.append("the camera's own tags: a raw take, not a render; use the render's "
                        + ("reel-9x16.mp4" if role == "story" else "feed-4x5.mp4"))
    if video is None:
        problems.append("no video stream")
        return rep
    codec = video.get("codec_name") or "unknown"
    if codec not in pr.VIDEO_CODECS:
        problems.append(f"video codec is {codec}; Meta asks for H.264")
    w, h = pr.display_size(video)
    label = None
    if not w or not h:
        problems.append("ffprobe couldn't tell the picture size")
    else:
        r = w / h
        rep["ratio"] = label = next((name for name, want in (("4:5", FEED_RATIO), ("9:16", STORY_RATIO), ("1:1", 1.0))
                                     if abs(r - want) <= want * RATIO_TOLERANCE), None)
        if w < MIN_SIDE or h < MIN_SIDE:
            problems.append(f"{w}x{h} is under Meta's 120x120 minimum")
        if role == "story":
            if label != "9:16":
                problems.append(f"{w}x{h} isn't 9:16; --story takes the render's reel-9x16.mp4")
        elif label == "9:16":
            warnings.append(f"{w}x{h} is 9:16: right for Stories and Reels, but Feed (most of the delivery) shows "
                            "at most 4:5, so the top and bottom (the hook, the captions) get cut there; the ad "
                            "should get the render's feed-4x5.mp4")
        elif label == "1:1":
            warnings.append(f"{w}x{h} is square: Feed takes it, but render.py's ad cut is feed-4x5.mp4")
        elif label is None:
            problems.append(f"{w}x{h} is neither 4:5 nor 9:16: not one of render.py's cuts (feed-4x5.mp4 is the ad's)")
    fps = pr._rate(video.get("avg_frame_rate")) or pr._rate(video.get("r_frame_rate"))
    nominal = pr._rate(video.get("r_frame_rate"))
    if not fps:
        problems.append("ffprobe couldn't tell the frame rate")
    elif nominal and abs(nominal - fps) / fps > 0.01:
        warnings.append(f"variable frame rate ({fps:.2f} fps average, {nominal:g} nominal); Meta asks for a fixed one")
    transfer = video.get("color_transfer") or ""
    if transfer in ("arib-std-b67", "smpte2084"):
        problems.append("HDR video: a raw iPhone take, not a render")
    if (video.get("field_order") or "progressive") not in ("progressive", "unknown"):
        warnings.append(f"interlaced ({video.get('field_order')}); Meta asks for progressive scan")
    pix = video.get("pix_fmt") or ""
    if pix and not re.match(r"(yuvj?420p|nv12|p010)", pix):
        warnings.append(f"pixel format {pix}; Meta asks for 4:2:0")
    facts.append(f"video: {pr.VIDEO_CODECS.get(codec, codec)} {w}x{h}" + (f" ({label})" if label else "")
                 + (f", {round(fps) if abs(fps - round(fps)) < 0.005 else round(fps, 3)} fps" if fps else "")
                 + (f", {duration:.1f} s" if duration else ""))
    if audio is None:
        warnings.append("no audio track: is this the render? Every cut has Tristen's voice")
    else:
        acodec = audio.get("codec_name") or "unknown"
        rate, channels, bits = pr._num(audio.get("sample_rate")), pr._int(audio.get("channels")), \
            pr._num(audio.get("bit_rate"))
        if acodec != "aac":
            warnings.append(f"audio codec is {acodec}; Meta asks for AAC")
        if channels and channels != 2:
            warnings.append(f"{'mono' if channels == 1 else f'{channels}-channel'} audio; Meta asks for stereo")
        if bits and bits < 124000:
            warnings.append(f"audio at {bits / 1000:.0f} kb/s; Meta asks for 128 kb/s or more")
        facts.append(f"audio: {acodec.upper()}" + (f", {rate / 1000:g} kHz" if rate else "")
                     + (f", {'stereo' if channels == 2 else 'mono' if channels == 1 else f'{channels} channels'}"
                        if channels else "") + (f", {bits / 1000:.0f} kb/s" if bits else ""))
    facts.append(f"size: {size / 1e6:.1f} MB ({size:,} bytes)")
    return rep


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def frame_jpeg(video_path, out_path, at=THUMB_AT):
    """One frame of the uploaded cut as the ad's thumbnail, the way
    render.py makes thumb.jpg (that one is the 9:16's)."""
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    try:
        r = subprocess.run(["ffmpeg", "-hide_banner", "-nostdin", "-v", "error", "-y", "-ss", f"{at:.3f}",
                            "-i", os.path.abspath(video_path), "-frames:v", "1",
                            "-vf", "scale=in_color_matrix=bt709:in_range=tv:out_color_matrix=bt601:out_range=pc,"
                                   "format=yuvj420p", "-q:v", "2", out_path],
                           capture_output=True, text=True, timeout=120)
    except FileNotFoundError:
        raise PostError("ffmpeg not found; install ffmpeg") from None
    except subprocess.TimeoutExpired:
        raise PostError("ffmpeg took over 2 minutes for one thumbnail frame") from None
    if r.returncode != 0 or not os.path.isfile(out_path) or not os.path.getsize(out_path):
        raise PostError(f"ffmpeg couldn't grab the thumbnail: {(r.stderr or '').strip()[-300:] or 'no reason given'}")
    return out_path


# ------------------------------------------------------------------ ledger

@contextlib.contextmanager
def ads_lock(path):
    """One --go at a time per ledger: two at once could both make the same
    video's ad, and the last ledger write would drop the other's ids."""
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        f = open(f"{path}.lock", "a")
    except OSError as e:
        raise PostError(f"can't open {path}.lock ({type(e).__name__}); nothing was sent") from None
    with f:
        if pr.fcntl is not None:
            try:
                pr.fcntl.flock(f.fileno(), pr.fcntl.LOCK_EX | pr.fcntl.LOCK_NB)
            except OSError:
                raise PostError(f"another ads.py --go is using {path}; let it finish, then run this again") from None
        yield


def _save(ledger_path, ledger):
    try:
        pr.save_ledger(ledger_path, ledger)
    except OSError as e:
        raise pr.LedgerError(f"couldn't write {ledger_path} ({type(e).__name__})") from None


STEPS = ("video", "image", "creative", "adset", "ad")


def complete(entry):
    return isinstance(entry, dict) and ((entry.get("steps") or {}).get("ad") or {}).get("state") == "done"


def progress(entry):
    steps = entry.get("steps") or {}
    done = [s for s in STEPS if (steps.get(s) or {}).get("state") == "done"]
    pending = [s for s in STEPS if (steps.get(s) or {}).get("state") == "pending"]
    out = f"steps done: {', '.join(done) or 'none'}"
    if pending:
        out += f"; answer lost for: {', '.join(pending)} (upload --go looks for it before making another)"
    return out


def entry_line(vid, e, tz):
    steps = e.get("steps") or {}
    ids = ", ".join(f"{s} {(steps.get(s) or {}).get('id') or (steps.get(s) or {}).get('hash')}" for s in STEPS
                    if (steps.get(s) or {}).get("id") or (steps.get(s) or {}).get("hash"))
    w = e.get("window") or {}
    start, end = pr._time(w.get("start_utc")), pr._time(w.get("end_utc"))
    when = (f"{pr.fmt_local(start, tz)} -> {pr.fmt_local(end, tz) if end else 'until stopped'}" if start else "")
    state = e.get("state")
    if state in ("uploading", "failed"):
        state += f" ({progress(e)})"
    return f"{vid}  {state}" + (f"  {when}" if when else "") + (f"  [{ids}]" if ids else "")


# ------------------------------------------------------------------ plan / upload

def video_and_town(vid):
    scripts = pr.load_scripts()
    video = scripts.get(vid)
    if video is None:
        raise PostError(f"no video {vid!r} in scripts.json; one of {', '.join(scripts)}")
    try:
        return video, towns.town(video["town"]), scripts
    except KeyError as e:
        raise PostError(str(e.args[0] if e.args else e)) from None


def fingerprint(ctx):
    """What an upload is made of: a run that stopped midway resumes only if
    none of it changed since (the file, the words and link, the window, the
    campaign), else --force starts over. The template ad set and Instagram
    account a resumed run uses are the ledger's, so they don't count."""
    keep = {"file": ctx["file_sha256"], "text": ctx["text"], "window": ctx["window_json"],
            "campaign": ctx["campaign"]["id"]}
    return hashlib.sha256(json.dumps(keep, sort_keys=True).encode()).hexdigest()[:16]


def window_json(win):
    if not win["start"]:
        return None
    return {"start_local": win["start"][0].isoformat(), "start_utc": pr._iso(win["start"][1]),
            "end_local": win["end"][0].isoformat() if win["end"] else None,
            "end_utc": pr._iso(win["end"][1]) if win["end"] else None}


def existing_for(sv, vid):
    """Ad sets in the campaign that ads.py made for this video (by the
    bracketed id in the name), newest attempt last."""
    hits = [(marker(s.get("name"))[1], s) for s in sv["adsets"] if marker(s.get("name"))[0] == vid
            and s.get("status") not in ("DELETED", "ARCHIVED")]
    return [s for _, s in sorted(hits, key=lambda x: x[0])]


def cmd_plan(args, session=None):
    """plan, and upload (which is the plan without --go)."""
    go = bool(getattr(args, "go", False))
    video, town, scripts = video_and_town(args.video)
    vid, slug, tz = video["id"], town["slug"], ZoneInfo(town["timezone"])
    now = _utcnow()
    ledger_path = args.ledger or LEDGER_PATH
    ledger = pr.load_ledger(ledger_path)
    entry = ledger.get(vid) if isinstance(ledger.get(vid), dict) else None
    problems = []

    win = run_window(video, town, now)
    problems += win["problems"]
    text = ad_text(video, town)
    if not text["message"]:
        problems.append("the caption (the ad's primary text) is empty")
    if video.get("draft") and not args.allow_draft:
        problems.append(f"{vid} is still a draft in scripts.json (its caption may be stale): finish the script and "
                        "set draft to false, or pass --allow-draft")
    report = check_file(args.file)
    problems += report["problems"]
    other = pr.other_video_in_path(args.file, vid, scripts)
    if other:
        problems.append(f"the file's path names {other}, not {vid}: is this the right video?")
    story = None
    if args.story:
        story = check_file(args.story, role="story")
        problems.append(f"--story: {STORY_NOT_USED}; drop --story to go ahead with the 4:5 alone")
    if complete(entry) and not args.force:
        problems.append(f"{vid} is already uploaded (ad {entry['steps']['ad'].get('id')}, {entry.get('state')}); "
                        "check it with status, and pass --force to make another ad for it")
    if version_note():
        problems.append(version_note())

    token_name = next((n for n in ("META_TOKEN", "META_PAGE_TOKEN") if os.environ.get(n, "").strip()), None)
    graph = AdsGraph(session, writes=go)
    sv = template = ig = token = None
    ig_from, ig_wanted, meta_error = "", False, None
    try:
        _, token = pr.system_token()
        sv = survey(graph, token, slug)
        template = template_adset(sv, ledger, args.template)
        ig, ig_from, ig_wanted = instagram_account(graph, token, sv, template, town["page_id"])
    except PostError as e:
        meta_error = str(e)
        problems.append(f"Meta: {e}")
    attempt = next_attempt(entry, args.force)

    say(f"{'UPLOAD' if go else 'PLAN'}: {vid} ({video.get('angle') or 'video'}) as a paused ad in {town['name']}'s "
        "campaign")
    say(f"  Town:      {town['name']} ({slug}), {town['timezone']}, Page {town['page_id']}")
    if sv:
        acct, c = sv["account"], sv["campaign"]
        say(f"  Account:   {acct.get('name')} ({AD_ACCOUNT}), {acct.get('currency') or '?'}, "
            f"{acct.get('timezone_name') or '?'}" + ("" if acct.get("account_status") in (None, 1)
                                                     else f", status {acct.get('account_status')}: ON HOLD"))
        say(f"  Campaign:  {c['name']} ({c['id']}): {c.get('status')}"
            + (f" (Meta: {c.get('effective_status')})" if c.get("effective_status") not in (None, c.get("status"))
               else "") + f", {str(c.get('objective') or '?').replace('OUTCOME_', '').lower()}")
        for line in budget_lines(sv, template):
            say(f"             {line}")
        for s in sv["siblings"]:
            say(f"             not touched: campaign {s.get('name')!r} ({s['id']}), {s.get('status')}")
        if template:
            nm = (entry or {}).get("names") if entry and not complete(entry) and not args.force else None
            nm = nm or names(vid, video, template.get("name") or "", attempt)
            say(f"  Ad set:    a copy of {template.get('name')!r} ({template['id']}), PAUSED, named {nm['adset']!r}")
            say(f"             {goal_line(template)}; {describe_targeting(template.get('targeting'))}")
            po = template.get("promoted_object") or {}
            if template.get("optimization_goal") != "OFFSITE_CONVERSIONS" or po.get("custom_event_type") != "LEAD":
                say("             note: the template doesn't optimize for the pixel's Lead event; the copy won't "
                    "either")
    elif meta_error:
        say(f"  Meta:      couldn't read the campaign: {meta_error}")
    if win["start"]:
        start, end = win["start"], win["end"]
        say(f"  Window:    {pr.fmt_local(start[0], tz)} -> "
            + (f"{pr.fmt_local(end[0], tz)} ({n_days(days(start[1], end[1]))})" if end
               else "no end: runs until stopped (no run_until_local)"))
        say(f"             {pr.fmt_utc(start[1])} -> " + (pr.fmt_utc(end[1]) if end else "-"))
    for n in win["problems"]:
        say(f"  Window:    NO  {n}")
    for n in win["notes"]:
        say(f"             note: {n}")
    if sv and win["start"] and not win["problems"]:
        for i, line in enumerate(spend_lines(sv, template, win["start"][1], win["end"][1] if win["end"] else None,
                                             win["start"][1])):
            say(f"  {'Spend:' if i == 0 else '':10} {line}")
    say(f"  File:      {os.path.abspath(args.file)}")
    for f in report["facts"]:
        say(f"    ok    {f}")
    for w in report["warnings"]:
        say(f"    note  {w}")
    for p in report["problems"]:
        say(f"    NO    {p}")
    if story is not None:
        say(f"  Story:     {os.path.abspath(args.story)}")
        for f in story["facts"]:
            say(f"    ok    {f}")
        for p in story["problems"] + story["warnings"]:
            say(f"    note  {p}")
        say(f"    NOT USED: {STORY_NOT_USED}")
    else:
        say("  Stories/Reels: the 4:5 cut too, fitted by Meta (no 9:16 version: see --story)")
    say(f"  Primary text ({len(text['message'])} characters, scripts.json caption"
        + (f"; Meta suggests {PRIMARY_TEXT_FEED} at most for Feed, the rest folds under \"See more\")"
           if len(text["message"]) > PRIMARY_TEXT_FEED
           else ")") + ":")
    for line in text["message"].splitlines() or [""]:
        say(f"    {line}")
    say(f"  Headline:  {text['title']} ({text['headline_from']}, {len(text['title'])} characters"
        + (f"; Meta suggests {HEADLINE_FEED} for Feed, where a longer one can be cut short)"
           if len(text["title"]) > HEADLINE_FEED else ")"))
    say(f"  Button:    {CTA} -> {text['link']}  (display {text['link_caption']}, \"{text['link_description']}\")")
    say(f"  URL tags:  {text['url_tags']}")
    say("             (the site's paid attribution: utm_medium=paid, utm_source fb/ig/an/msg)")
    if ig:
        say(f"  Instagram: account {ig}, from {ig_from}")
    elif ig_wanted and sv:
        say("  Instagram: the ad set delivers there, but no ad in the campaign names an Instagram account; Meta "
            "shows the Page's name and picture there")
    say(f"  Thumbnail: a frame {THUMB_AT:g} s in, uploaded with the ad")
    say("  Advantage+ creative: " + ", ".join(f"{k} {v['enroll_status'].replace('OPT_', '').lower()}"
                                             for k, v in CREATIVE_FEATURES.items()))
    if sv:
        sets, ads = would_deliver(sv, now)
        if sets or ads:
            say("  On if the campaign were turned on now (go pauses these before turning this video on):")
            for s in sets:
                say(f"    {obj_line('ad set', s, tz, now)}")
            for a in ads:
                say(f"    {obj_line('ad', a, tz, now)}")
        else:
            say("  Nothing else in the campaign would deliver if it were turned on.")
        live = {o["id"] for o in sets + ads}
        idle = [("ad set", s) for s in sv["adsets"] if s.get("status") == "ACTIVE" and s["id"] not in live] \
            + [("ad", a) for a in sv["ads"] if a.get("status") == "ACTIVE" and a["id"] not in live]
        if idle:
            say("  Set to ACTIVE but not delivering (past their end, or under a paused or ended ad set); go pauses "
                "them too:")
            for kind, o in idle:
                say(f"    {obj_line(kind, o, tz, now)}")
        # A video this machine's ledger has never heard of, already in the
        # campaign: made from another container, whose ledger is gone.
        stray = [s for s in existing_for(sv, vid) if s["id"] not in ledger_ids(ledger)]
        if stray and entry is None and not args.force:
            problems.append(f"the campaign already has an ad set for {vid} ({stray[-1].get('name')!r}, "
                            f"{stray[-1]['id']}) that this machine's ledger doesn't know (a new container?); check "
                            "it in Ads Manager, and pass --force to make another")
    say(f"  Token:     {token_name} is set (graph.facebook.com)" if token_name
        else f"  Token:     no META_TOKEN: the network secret on {pr.NETWORK_HOST}")
    say(f"  API:       Marketing API {GRAPH_VERSION}")
    say(f"  Ledger:    {ledger_path}: " + (entry_line(vid, entry, tz) if entry else f"no entry for {vid} yet"))
    if entry and not complete(entry) and not args.force:
        say("             upload --go resumes it")

    base = GRAPH if token_name else NETWORK_GRAPH
    tmpl = (entry or {}).get("template_adset_id") if entry and not complete(entry) and not args.force else None
    tmpl = tmpl or (template["id"] if template else "<template ad set>")
    say("  With --go:" if not go else "  Steps:")
    say(f"    1. POST {base}/{AD_ACCOUNT}/advideos  source=<the file, {report['size']:,} bytes>, name/title")
    say(f"    2. GET  {base}/<video id>?fields=status  until Meta has processed it (up to "
        f"{PROCESS_DEADLINE // 60} min)")
    say(f"    3. POST {base}/{AD_ACCOUNT}/adimages  bytes=<the thumbnail frame, base64>")
    say(f"    4. POST {base}/{AD_ACCOUNT}/adcreatives  object_story_spec (Page {town['page_id']}, video_data), "
        "url_tags, degrees_of_freedom_spec")
    say(f"    5. POST {base}/{tmpl}/copies  status_option=PAUSED, deep_copy=false, start_time, end_time, "
        "rename_options")
    say(f"    6. POST {base}/{AD_ACCOUNT}/ads  adset_id=<the copy>, creative={{creative_id}}, status=PAUSED")
    say("    Nothing turns on: `ads.py go --video " + vid + "` does that, once you've looked at it.")
    if not go:
        if not problems:
            say(f"{'UPLOAD' if go else 'PLAN'}: nothing was sent. `ads.py upload {args.file} --video {vid} --go` "
                "makes the paused ad.")
            return 0
        say("PLAN: nothing was sent, and upload --go would refuse until these are fixed:")
        for p in problems:
            say(f"  - {p}")
        return 1
    if problems:
        say("Not uploading:", file=sys.stderr)
        for p in problems:
            say(f"  - {p}", file=sys.stderr)
        return 1
    ctx = {"video": video, "town": town, "sv": sv, "template": template, "ig": ig, "text": text, "win": win,
           "window_json": window_json(win), "file": os.path.abspath(args.file), "size": report["size"],
           "campaign": sv["campaign"]}
    ctx["file_sha256"] = sha256(args.file)
    with ads_lock(ledger_path):
        ledger = pr.load_ledger(ledger_path)
        entry = ledger.get(vid) if isinstance(ledger.get(vid), dict) else None
        if complete(entry) and not args.force:
            say(f"Not uploading: {vid} was uploaded meanwhile (ad {entry['steps']['ad'].get('id')}).", file=sys.stderr)
            return 1
        return upload(graph, token, ctx, entry, ledger, ledger_path, args.force)


def upload(graph, token, ctx, entry, ledger, ledger_path, force):
    """The --go half of upload: each step written to the ledger before and
    after, so a second run resumes rather than repeats."""
    video, town, sv, template, text, win = (ctx[k] for k in ("video", "town", "sv", "template", "text", "win"))
    vid, slug, tz = video["id"], town["slug"], ZoneInfo(town["timezone"])
    fp = fingerprint(ctx)
    if entry and not complete(entry) and not force:
        if entry.get("fingerprint") != fp:
            say(f"Not uploading: {vid}'s upload stopped midway ({progress(entry)}), and the file, the words, the "
                "window or the template changed since. Pass --force to start over (the paused leftovers stay in "
                "the account, unused).", file=sys.stderr)
            return 1
        say(f"Resuming {vid}'s upload ({progress(entry)}).")
    else:
        prior = entry
        attempt = next_attempt(prior, force=True)
        entry = {"video": vid, "town": slug, "account": AD_ACCOUNT, "campaign_id": sv["campaign"]["id"],
                 "campaign_name": sv["campaign"]["name"], "template_adset_id": template["id"],
                 "template_adset_name": template.get("name"), "attempt": attempt, "fingerprint": fp,
                 "file": ctx["file"], "file_bytes": ctx["size"], "file_sha256": ctx["file_sha256"],
                 "window": ctx["window_json"], "page_id": town["page_id"], "instagram_user_id": ctx["ig"],
                 "ad_text": text, "names": names(vid, video, template.get("name") or "", attempt), "steps": {},
                 "state": "uploading", "graph_version": GRAPH_VERSION, "started_at": pr._iso(_utcnow())}
        if prior:
            earlier = {k: v for k, v in prior.items() if k != "previous"}
            entry["previous"] = ((prior.get("previous") or []) + [earlier])[-10:]
            say(f"--force: making a new ad for {vid} (attempt {attempt}); the earlier one stays as it is.")
    nm, steps = entry["names"], entry.setdefault("steps", {})

    def record(step, state, **extra):
        s = steps.setdefault(step, {})
        s.update(extra)
        s.update(state=state, at=pr._iso(_utcnow()))
        entry["state"] = "failed" if state == "failed" else entry.get("state", "uploading")
        entry["updated_at"] = pr._iso(_utcnow())
        ledger[vid] = entry
        _save(ledger_path, ledger)

    def done(step):
        return (steps.get(step) or {}).get("state") == "done"

    def pending(step):
        return (steps.get(step) or {}).get("state") == "pending"

    def lost(step, finder):
        """A step whose answer was lost last time: Meta's object if it made it."""
        if not pending(step):
            return None
        found = finder()
        if found:
            say(f"Found the {step} the last run made: {found}.")
        return found

    entry["state"] = "uploading"
    acct = AD_ACCOUNT
    try:
        # 1. The video, into the ad account's library.
        if not done("video"):
            bad = set((steps.get("video") or {}).get("bad") or [])

            def find_video():
                hits = [v for v in graph.all(f"{acct}/advideos", token, fields="id,title,created_time", limit="100")
                        if v.get("title") == nm["video"] and str(v.get("id")) not in bad]
                return str(max(hits, key=lambda v: v.get("created_time") or "")["id"]) if hits else None

            def send_video():
                say(f"Uploading {ctx['size']:,} bytes to {acct}'s video library as {nm['video']!r}.")
                try:
                    f = open(ctx["file"], "rb")
                except OSError as e:
                    raise PostError(f"can't read {ctx['file']}: {e.strerror or type(e).__name__}") from None
                with f:
                    body = graph.once(f"{acct}/advideos", token, f"POST /{acct}/advideos",
                                      data={"name": nm["video"], "title": nm["video"]},
                                      files={"source": (os.path.basename(ctx["file"]), f, "video/mp4")})
                vid_id = str(body.get("id") or body.get("video_id") or "")
                if not vid_id.isdigit():
                    raise PostError(f"POST /{acct}/advideos: no video id in Meta's answer ({pr._brief(body)})")
                return vid_id

            vid_id = lost("video", find_video) or create("video", "video", send_video, find_video, record)
            record("video", "done", id=vid_id, ready=False)
        vid_id = steps["video"]["id"]
        if not steps["video"].get("ready"):
            say(f"Meta video {vid_id}: waiting for Meta to process it.")
            try:
                st = wait_for_video(graph, token, vid_id)
            except ProcessingFailed as e:
                # Meta won't use that upload: the next run uploads it again
                # (and never takes this one for it).
                record("video", "failed", error=e.as_dict(),
                       bad=sorted(set(steps["video"].get("bad") or []) | {vid_id}))
                raise
            record("video", "done", ready=True, length=st.get("length"))
            say(f"Meta video {vid_id} is ready.")

        # 2. The thumbnail: a frame of this cut. Same bytes, same hash, so
        # sending it twice makes nothing new.
        if not done("image"):
            thumb = frame_jpeg(ctx["file"], os.path.join(THUMBS, vid, f"thumb-{entry['attempt']}.jpg"))
            with open(thumb, "rb") as f:
                data = base64.b64encode(f.read()).decode("ascii")
            body = graph.call("POST", f"{acct}/adimages", f"POST /{acct}/adimages", token, data={"bytes": data})
            image_hash = next((str(i["hash"]) for i in (body.get("images") or {}).values()
                               if isinstance(i, dict) and i.get("hash")), "")
            if not image_hash:
                raise PostError(f"POST /{acct}/adimages: no image hash in Meta's answer ({pr._brief(body)})")
            record("image", "done", hash=image_hash, file=thumb)
            say(f"Thumbnail uploaded (image {image_hash}).")
        image_hash = steps["image"]["hash"]

        # 3. The creative: the Tide's video ad, with this video's words.
        if not done("creative"):
            def find_creative():
                hits = [c for c in graph.all(f"{acct}/adcreatives", token, fields="id,name", limit="100")
                        if c.get("name") == nm["creative"]]
                return str(hits[-1]["id"]) if hits else None

            params = creative_params(town, entry["ad_text"], vid_id, image_hash, entry.get("instagram_user_id"),
                                     nm["creative"])

            def send_creative():
                body = graph.once(f"{acct}/adcreatives", token, f"POST /{acct}/adcreatives", data=params)
                if not str(body.get("id") or "").isdigit():
                    raise PostError(f"POST /{acct}/adcreatives: no id in Meta's answer ({pr._brief(body)})")
                return str(body["id"])

            creative_id = lost("creative", find_creative) or create("creative", "creative", send_creative,
                                                                    find_creative, record)
            record("creative", "done", id=creative_id)
            say(f"Creative {creative_id} ({nm['creative']!r}).")
        creative_id = steps["creative"]["id"]

        # 4. The ad set: a PAUSED copy of the template, with the window.
        end_utc = pr._time((entry.get("window") or {}).get("end_utc"))
        tmpl = entry["template_adset_id"]
        if not done("adset"):
            def find_adset():
                hits = [s for s in graph.all(f"{entry['campaign_id']}/adsets", token, fields="id,name", limit="100")
                        if nm["adset_suffix"].strip() in str(s.get("name") or "")]
                return str(hits[-1]["id"]) if hits else None

            sent = steps.get("adset") or {}
            adset_id = None
            if pending("adset") and sent.get("start_time"):
                # The copy the last run may have made had these times.
                params = copy_params(pr._time(sent["start_time"]), end_utc, nm["adset_suffix"])
                adset_id = lost("adset", find_adset)
            else:
                # A start already past goes as now: the copy is paused anyway.
                start_utc = pr._time((entry.get("window") or {}).get("start_utc"))
                params = copy_params(max(start_utc, _utcnow().replace(second=0, microsecond=0)), end_utc,
                                     nm["adset_suffix"])
                record("adset", "pending", start_time=params["start_time"], end_time=params["end_time"])

            def send_copy():
                body = graph.once(f"{tmpl}/copies", token, f"POST /{tmpl}/copies", data=params)
                copied = str(body.get("copied_adset_id") or "")
                if not copied.isdigit():
                    raise PostError(f"POST /{tmpl}/copies: no copied_adset_id in Meta's answer ({pr._brief(body)})")
                return copied

            adset_id = adset_id or create("adset", "ad set copy", send_copy, find_adset, record)
            record("adset", "done", id=adset_id, start_time=params["start_time"], end_time=params["end_time"])
        adset_id = steps["adset"]["id"]
        if not steps["adset"].get("checked"):
            got = check_copy(graph, token, adset_id, entry["campaign_id"], pr._time(steps["adset"]["start_time"]),
                             end_utc, tz)
            record("adset", "done", checked=True, name=got.get("name"))
            say(f"Ad set {adset_id} ({got.get('name')!r}): PAUSED, {window_text(got, tz)}.")

        # 5. The ad, PAUSED, in the new ad set.
        if not done("ad"):
            def find_ad():
                hits = [a for a in graph.all(f"{adset_id}/ads", token, fields="id,name", limit="100")
                        if a.get("name") == nm["ad"]]
                return str(hits[-1]["id"]) if hits else None

            params = {"name": nm["ad"], "adset_id": adset_id, "creative": json.dumps({"creative_id": creative_id}),
                      "status": "PAUSED", "conversion_domain": town["domain"]}

            def send_ad():
                body = graph.once(f"{acct}/ads", token, f"POST /{acct}/ads", data=params)
                if not str(body.get("id") or "").isdigit():
                    raise PostError(f"POST /{acct}/ads: no id in Meta's answer ({pr._brief(body)})")
                return str(body["id"])

            ad_id = lost("ad", find_ad) or create("ad", "ad", send_ad, find_ad, record)
            entry["state"] = "uploaded"
            record("ad", "done", id=ad_id)
        ad_id = steps["ad"]["id"]
        ad = check_ad(graph, token, ad_id, adset_id)
        entry["state"] = "uploaded"
        record("ad", "done", review=ad.get("effective_status"))
    except pr.Unconfirmed as e:
        say(f"error: {e}", file=sys.stderr)
        say("Nothing is on. Run the same upload --go again: it looks for what Meta may have made before making "
            "anything twice.", file=sys.stderr)
        return 1
    except pr.LedgerError as e:
        say(f"error: {e}", file=sys.stderr)
        say("Stopped there; nothing is on. Fix what stopped the write (a full disk?) and run upload --go again.",
            file=sys.stderr)
        return 1
    except PostError as e:
        say(f"error: {e}", file=sys.stderr)
        say(f"Nothing is on. {progress(entry)}; upload --go again picks up from there.", file=sys.stderr)
        return 1

    say(f"Ad {ad_id} ({nm['ad']!r}): PAUSED, Meta: {ad.get('effective_status')}"
        + (" (Meta reviews every new ad; it stays paused)" if ad.get("effective_status") == "PENDING_REVIEW" else ""))
    if ad.get("preview_shareable_link"):
        say(f"Preview: {ad['preview_shareable_link']}")
    say(f"Ads Manager: https://adsmanager.facebook.com/adsmanager/manage/ads?act={AD_ACCOUNT[4:]}"
        f"&selected_ad_ids={ad_id}")
    say(f"Uploaded: nothing is on. `ads.py go --video {vid}` shows what turning it on does.")
    say(f"Ledger: {ledger_path}")
    return 0


def creative_params(town, text, video_id, image_hash, ig, name):
    """POST act_/adcreatives: the Tide's video ad's shape (object_story_spec
    with video_data, its CTA and link), with this video's words."""
    story = {"page_id": town["page_id"]}
    if ig:
        story["instagram_user_id"] = ig
    story["video_data"] = {
        "video_id": video_id, "image_hash": image_hash, "message": text["message"], "title": text["title"],
        "link_description": text["link_description"],
        "call_to_action": {"type": text["cta"], "value": {"link": text["link"], "link_caption": text["link_caption"]}},
    }
    return {"name": name, "object_story_spec": json.dumps(story, ensure_ascii=False, separators=(",", ":")),
            "url_tags": text["url_tags"],
            "degrees_of_freedom_spec": json.dumps({"creative_features_spec": CREATIVE_FEATURES},
                                                  separators=(",", ":"))}


def copy_params(start_utc, end_utc, suffix):
    """POST /{adset}/copies: the copy PAUSED (status_option), without the
    template's ads (deep_copy false), with the window (without one it would
    inherit the template's, which has ended: end_time 0 is "ongoing"), and
    named the template's name plus the video id (rename_suffix; a suffix
    given replaces Meta's " - Copy")."""
    return {"deep_copy": "false", "status_option": "PAUSED", "start_time": graph_time(start_utc),
            "end_time": graph_time(end_utc) if end_utc else "0",
            "rename_options": json.dumps({"rename_strategy": "ONLY_TOP_LEVEL_RENAME", "rename_suffix": suffix})}


def window_text(adset, tz):
    start, end = pr._time(adset.get("start_time")), _end(adset.get("end_time"))
    return (f"{pr.fmt_local(start, tz) if start else '?'} -> " + (pr.fmt_local(end, tz) if end else "no end"))


class ProcessingFailed(PostError):
    """Meta took the upload but won't use it: the next run uploads again."""


def wait_for_video(graph, token, video_id):
    """Poll the ad video until Meta has processed it (video_status ready),
    or fail on Meta's own error, or at PROCESS_DEADLINE."""
    deadline = _monotonic() + PROCESS_DEADLINE
    while True:
        body = graph.get(video_id, token, fields="status,length")
        st = body.get("status") if isinstance(body.get("status"), dict) else {}
        err = pr.phase_error(st)
        if err:
            raise ProcessingFailed(f"Meta couldn't process video {video_id}: {err}")
        proc = pr._phase(st, "processing_phase").get("status")
        if st.get("video_status") == "ready" and proc in (None, "complete", "completed"):
            return body
        if _monotonic() >= deadline:
            raise PostError(f"Meta was still processing video {video_id} after {PROCESS_DEADLINE // 60} minutes "
                            f"(video_status {st.get('video_status') or '?'}); run upload --go again later")
        _sleep(POLL_EVERY)


def check_copy(graph, token, adset_id, campaign_id, want_start, want_end, tz):
    """The copy as Meta has it: in the campaign, PAUSED, with the window
    asked for. A copy that came out ACTIVE is paused at once (nothing may be
    on before go); a start or end Meta didn't take is set again."""
    fields = "id,name,campaign_id,status,effective_status,start_time,end_time"
    s = graph.get(adset_id, token, fields=fields)
    if str(s.get("campaign_id")) != str(campaign_id):
        raise PostError(f"the copy {adset_id} landed in campaign {s.get('campaign_id')}, not {campaign_id}")
    if s.get("status") != "PAUSED":
        say(f"The copy {adset_id} came out {s.get('status')}: pausing it now.")
        graph.set_status(adset_id, "PAUSED", token, f"POST /{adset_id} status=PAUSED")
    fix = {}
    got_start, got_end = pr._time(s.get("start_time")), _end(s.get("end_time"))
    if not got_start or abs((got_start - want_start).total_seconds()) > TIME_SLACK:
        fix["start_time"] = graph_time(want_start)
    if (want_end is None) != (got_end is None) or (want_end and abs((got_end - want_end).total_seconds()) > TIME_SLACK):
        fix["end_time"] = graph_time(want_end) if want_end else "0"
    if fix:
        say(f"Meta gave the copy {window_text(s, tz)}; setting " + ", ".join(f"{k}={v}" for k, v in fix.items()))
        graph.call("POST", adset_id, f"POST /{adset_id} (window)", token, data=fix)
    if fix or s.get("status") != "PAUSED":
        s = graph.get(adset_id, token, fields=fields)
        got_start, got_end = pr._time(s.get("start_time")), _end(s.get("end_time"))
        bad = s.get("status") != "PAUSED" or not got_start \
            or abs((got_start - want_start).total_seconds()) > TIME_SLACK \
            or (want_end is None) != (got_end is None) \
            or (want_end and abs((got_end - want_end).total_seconds()) > TIME_SLACK)
        if bad:
            raise PostError(f"the copy {adset_id} is {s.get('status')}, {window_text(s, tz)}, not PAUSED for the "
                            "window asked for; fix it in Ads Manager before go")
    return s


def check_ad(graph, token, ad_id, adset_id):
    """The new ad as Meta has it: in its ad set and PAUSED (paused at once
    if not), with its review state and preview link."""
    a = graph.get(ad_id, token, fields="id,name,adset_id,status,effective_status,preview_shareable_link")
    if str(a.get("adset_id")) != str(adset_id):
        raise PostError(f"ad {ad_id} is in ad set {a.get('adset_id')}, not {adset_id}")
    if a.get("status") != "PAUSED":
        say(f"Ad {ad_id} came out {a.get('status')}: pausing it now.")
        graph.set_status(ad_id, "PAUSED", token, f"POST /{ad_id} status=PAUSED")
        a = graph.get(ad_id, token, fields="id,name,adset_id,status,effective_status,preview_shareable_link")
    return a


# ------------------------------------------------------------------ go / stop

def find_ours(sv, entry, vid):
    """(ad set, ad) of this video in the campaign: the ledger's ids, else
    the ad set named with its id (a container that lost the ledger)."""
    sets = {s["id"]: s for s in sv["adsets"]}
    ads = {a["id"]: a for a in sv["ads"]}
    steps = (entry or {}).get("steps") or {}
    sid, aid = (steps.get("adset") or {}).get("id"), (steps.get("ad") or {}).get("id")
    if entry and not complete(entry):
        raise PostError(f"{vid}'s upload didn't finish ({progress(entry)}): run upload --go again first")
    if sid or aid:
        if sid not in sets:
            raise PostError(f"the ledger's ad set {sid} for {vid} isn't in {sv['name']} any more (deleted or "
                            "archived?)")
        if aid not in ads:
            raise PostError(f"the ledger's ad {aid} for {vid} isn't in {sv['name']} any more (deleted or archived?)")
        return sets[sid], ads[aid], "the ledger"
    mine = existing_for(sv, vid)
    if not mine:
        raise PostError(f"{vid} has no ad in {sv['name']}: upload it first (ads.py upload ... --go)")
    s = mine[-1]
    in_set = [a for a in sv["ads"] if a.get("adset_id") == s["id"] and a.get("status") not in ("DELETED", "ARCHIVED")]
    if len(in_set) != 1:
        raise PostError(f"ad set {s['id']} ({s.get('name')!r}) has {len(in_set)} ads, so which is {vid}'s isn't "
                        "clear; this machine's ledger has none (a new container?)")
    return s, in_set[0], f"the ad set's name ({s.get('name')!r}; not in this machine's ledger)"


def cmd_go(args, session=None):
    go = bool(args.go)
    ledger_path = args.ledger or LEDGER_PATH
    ledger = pr.load_ledger(ledger_path)
    entry = ledger.get(args.video) if isinstance(ledger.get(args.video), dict) else None
    try:
        scripts = pr.load_scripts()
    except (OSError, ValueError):
        scripts = {}
    town = find_town(args.video, entry, scripts)
    vid, slug, tz = args.video, town["slug"], ZoneInfo(town["timezone"])
    _, token = pr.system_token()
    graph = AdsGraph(session, writes=go)
    sv = survey(graph, token, slug)
    adset, ad, where = find_ours(sv, entry, vid)
    now = _utcnow()
    c = sv["campaign"]
    problems, notes = [], []
    if adset.get("status") in ("DELETED", "ARCHIVED") or ad.get("status") in ("DELETED", "ARCHIVED"):
        problems.append(f"{vid}'s ad set or ad is {adset.get('status')}/{ad.get('status')}: it can't be turned on")
    if ad.get("effective_status") == "DISAPPROVED":
        problems.append(f"Meta disapproved {vid}'s ad ({ad['id']}); see why in Ads Manager")
    elif ad.get("effective_status") in ("PENDING_REVIEW", "IN_PROCESS"):
        notes.append("Meta is still reviewing the ad: it starts once it's approved")
    elif ad.get("effective_status") == "WITH_ISSUES":
        notes.append("Meta says the ad has issues; look at it in Ads Manager")
    end = _end(adset.get("end_time"))
    start = pr._time(adset.get("start_time"))
    if end and end <= now:
        problems.append(f"{vid}'s ad set ended {pr.fmt_both(end, tz)}: turning it on would deliver nothing")
    if sv["account"].get("account_status") not in (None, 1):
        notes.append(f"the ad account is on hold (status {sv['account']['account_status']}): nothing delivers")
    planned = (entry or {}).get("window") or {}
    want_end = pr._time(planned.get("end_utc"))
    if entry and ((want_end is None) != (end is None) or (want_end and end and abs((want_end - end).total_seconds())
                                                          > TIME_SLACK)):
        notes.append(f"Meta's end ({pr.fmt_local(end, tz) if end else 'none'}) isn't the ledger's "
                     f"({pr.fmt_local(want_end, tz) if want_end else 'none'}); Meta's is what runs")

    on = [(k, o) for k, o in (("ad", ad), ("ad set", adset), ("campaign", c)) if o.get("status") != "ACTIVE"]
    off_sets = [s for s in sv["adsets"] if s["id"] != adset["id"] and s.get("status") == "ACTIVE"]
    off_ads = [a for a in sv["ads"] if a["id"] != ad["id"] and a.get("status") == "ACTIVE"]
    live_sets, live_ads = would_deliver(sv, now, skip=(adset["id"], ad["id"]))
    live = {o["id"] for o in live_sets + live_ads}

    say(f"{'GO' if go else 'GO (dry run)'}: {vid} in {c['name']} ({c['id']}), found by {where}")
    if version_note():
        say(f"  note: {version_note()}")
    say("  Turns ON:" if on else "  Turns ON: nothing, this video's ad, ad set and the campaign are on already")
    for kind, o in on:
        say(f"    {obj_line(kind, o, tz, now)} -> ACTIVE")
    say(f"  This video's window: {window_text(adset, tz)}"
        + (f" (starts in {pr._span(start - now)})" if start and start > now else ""))
    if off_sets or off_ads:
        say("  PAUSED first, so only this video spends:")
        for kind, o in [("ad set", s) for s in off_sets] + [("ad", a) for a in off_ads]:
            say(f"    {obj_line(kind, o, tz, now)} -> PAUSED" + ("  (would deliver)" if o["id"] in live else ""))
    else:
        say("  Pauses: nothing, nothing else in the campaign is on")
    say("  Budget:  " + "\n           ".join(budget_lines(sv, adset)))
    for i, line in enumerate(spend_lines(sv, adset, start or now, end, now)):
        say(f"  {'Spend:' if i == 0 else '':8} {line}")
    for s in sv["siblings"]:
        if s.get("status") == "ACTIVE":
            notes.append(f"campaign {s.get('name')!r} ({s['id']}) is also on and also spends for {town['name']}; "
                         "ads.py doesn't touch it")
    for n in notes:
        say(f"  note: {n}")
    writes = [("PAUSED", "ad set", s) for s in off_sets] + [("PAUSED", "ad", a) for a in off_ads] \
        + [("ACTIVE", k, o) for k, o in on]
    base = AdsGraph.base(token)
    if writes:
        say("  With --go, in this order:" if not go else "  Steps:")
        for i, (status, kind, o) in enumerate(writes, 1):
            say(f"    {i}. POST {base}/{o['id']}  status={status}  ({kind} {o.get('name')!r})")
    if problems:
        say(("Not turning it on:" if go else "GO (dry run): nothing was sent, and go --go would refuse:"),
            file=sys.stderr if go else None)
        for p in problems:
            say(f"  - {p}", file=sys.stderr if go else None)
        return 1
    if not go:
        say(f"GO (dry run): nothing was sent. `ads.py go --video {vid} --go` does it.")
        return 0
    if not writes:
        say("Nothing to change.")
        return 0
    with ads_lock(ledger_path):
        done = []
        try:
            for status, kind, o in writes:
                in_campaign(sv, o["id"])
                graph.set_status(o["id"], status, token, f"POST /{o['id']} status={status} ({kind})")
                done.append((status, kind, o))
                say(f"{kind} {o.get('name')!r} ({o['id']}): {status}")
        except PostError as e:
            say(f"error: {e}", file=sys.stderr)
            if not any(s == "ACTIVE" for s, _, _ in done):
                say("Nothing was turned on." + (" Paused so far: " + ", ".join(o["id"] for _, _, o in done)
                                                if done else ""), file=sys.stderr)
            else:
                say("Turned on so far: " + ", ".join(o["id"] for s, _, o in done if s == "ACTIVE") + "; run go "
                    "--go again to finish, or stop to undo.", file=sys.stderr)
            _note_go(ledger_path, vid, entry, town, sv, adset, ad, done, ok=False)
            return 1
        _note_go(ledger_path, vid, entry, town, sv, adset, ad, done, ok=True)
    try:
        after = survey(graph, token, slug)
    except PostError as e:
        say(f"{vid} is on; reading it back failed ({e}): check with `ads.py status --town {slug}`.")
        return 0
    a2 = next((a for a in after["ads"] if a["id"] == ad["id"]), {})
    s2 = next((s for s in after["adsets"] if s["id"] == adset["id"]), {})
    say(f"Now: campaign {after['campaign'].get('effective_status')}, ad set {s2.get('effective_status')}, ad "
        f"{a2.get('effective_status')}.")
    still = [o for o in after["adsets"] + after["ads"] if o["id"] not in (ad["id"], adset["id"])
             and o.get("status") == "ACTIVE"]
    if still:
        say("Still on besides this video: " + ", ".join(f"{o.get('name')!r} ({o['id']})" for o in still))
    say(f"{vid} is on. `ads.py status --town {slug}` shows its spend; `ads.py stop --video {vid} --go` turns it off.")
    return 0


def _note_go(ledger_path, vid, entry, town, sv, adset, ad, done, ok):
    ledger = pr.load_ledger(ledger_path)
    e = ledger.get(vid) if isinstance(ledger.get(vid), dict) else {
        "video": vid, "town": town["slug"], "account": AD_ACCOUNT, "campaign_id": sv["campaign"]["id"],
        "campaign_name": sv["campaign"]["name"], "steps": {"adset": {"state": "done", "id": adset["id"]},
                                                           "ad": {"state": "done", "id": ad["id"]}},
        "found_by_name": True}
    now = pr._iso(_utcnow())
    if ok:
        e["state"] = "live"
        e["live_since"] = now
    e.setdefault("changes", []).append({"at": now, "command": "go", "ok": ok,
                                        "set": [{"id": o["id"], "kind": k, "name": o.get("name"), "status": s}
                                                for s, k, o in done]})
    e["changes"] = e["changes"][-20:]
    e["updated_at"] = now
    ledger[vid] = e
    _save(ledger_path, ledger)


def cmd_stop(args, session=None):
    go = bool(args.go)
    ledger_path = args.ledger or LEDGER_PATH
    ledger = pr.load_ledger(ledger_path)
    entry = ledger.get(args.video) if isinstance(ledger.get(args.video), dict) else None
    try:
        scripts = pr.load_scripts()
    except (OSError, ValueError):
        scripts = {}
    town = find_town(args.video, entry, scripts)
    vid, slug, tz = args.video, town["slug"], ZoneInfo(town["timezone"])
    _, token = pr.system_token()
    graph = AdsGraph(session, writes=go)
    sv = survey(graph, token, slug)
    adset, ad, where = find_ours(sv, entry, vid)
    now = _utcnow()
    c = sv["campaign"]
    # The widest first: each pause stops the spend on its own.
    todo = ([("campaign", c)] if args.campaign else []) + [("ad set", adset), ("ad", ad)]
    todo = [(k, o) for k, o in todo if o.get("status") == "ACTIVE"]
    say(f"{'STOP' if go else 'STOP (dry run)'}: {vid} in {c['name']} ({c['id']}), found by {where}")
    if version_note():
        say(f"  note: {version_note()}")
    for kind, o in [("ad", ad), ("ad set", adset)] + ([("campaign", c)] if args.campaign else []):
        say(f"    {obj_line(kind, o, tz, now)}" + (" -> PAUSED" if any(o is t for _, t in todo) else ""))
    if not args.campaign and c.get("status") == "ACTIVE":
        say("  The campaign stays on (--campaign pauses it too); anything else on in it keeps spending.")
    if not todo:
        say("Nothing to pause.")
        return 0
    base = AdsGraph.base(token)
    say("  With --go, in this order:" if not go else "  Steps:")
    for i, (kind, o) in enumerate(todo, 1):
        say(f"    {i}. POST {base}/{o['id']}  status=PAUSED  ({kind} {o.get('name')!r})")
    if not go:
        say(f"STOP (dry run): nothing was sent. `ads.py stop --video {vid}{' --campaign' if args.campaign else ''} "
            "--go` does it.")
        return 0
    done = []
    with ads_lock(ledger_path):
        try:
            for kind, o in todo:
                in_campaign(sv, o["id"])
                graph.set_status(o["id"], "PAUSED", token, f"POST /{o['id']} status=PAUSED ({kind})")
                done.append(("PAUSED", kind, o))
                say(f"{kind} {o.get('name')!r} ({o['id']}): PAUSED")
        except PostError as e:
            say(f"error: {e}", file=sys.stderr)
            _note_stop(ledger_path, vid, done, ok=False)
            return 1
        _note_stop(ledger_path, vid, done, ok=True)
    say(f"{vid} is paused.")
    return 0


def _note_stop(ledger_path, vid, done, ok):
    ledger = pr.load_ledger(ledger_path)
    e = ledger.get(vid)
    if not isinstance(e, dict):
        return
    now = pr._iso(_utcnow())
    if ok:
        e["state"] = "stopped"
        e["stopped_at"] = now
    e.setdefault("changes", []).append({"at": now, "command": "stop", "ok": ok,
                                        "set": [{"id": o["id"], "kind": k, "name": o.get("name"), "status": s}
                                                for s, k, o in done]})
    e["changes"] = e["changes"][-20:]
    e["updated_at"] = now
    ledger[vid] = e
    _save(ledger_path, ledger)


# ------------------------------------------------------------------ status

def action(row, kind):
    for a in row.get("actions") or []:
        if isinstance(a, dict) and a.get("action_type") == kind:
            try:
                return int(float(a.get("value") or 0))
            except (TypeError, ValueError):
                return 0
    return 0


def results(row):
    """Leads, as scripts/meta_ads.py counts them: Meta's lead count, else the
    pixel's Lead event."""
    return action(row, "lead") or action(row, "offsite_conversion.fb_pixel_lead")


def numbers_line(row):
    spend = float(row.get("spend") or 0)
    leads = results(row)
    clicks = int(float(row.get("inline_link_clicks") or 0))
    out = f"${spend:,.2f} spent, {leads} result{'s' * (leads != 1)}"
    out += f" (${spend / leads:,.2f} each)" if leads else ""
    out += f", {clicks:,} link click{'s' * (clicks != 1)}"
    return out


def insights(graph, token, obj_id, preset, **extra):
    rows = graph.get(f"{obj_id}/insights", token, fields=extra.pop("fields", INSIGHT_FIELDS), date_preset=preset,
                     **extra).get("data") or []
    return [r for r in rows if isinstance(r, dict)]


def cmd_status(args, session=None):
    ledger_path = args.ledger or LEDGER_PATH
    ledger = pr.load_ledger(ledger_path)
    _, token = pr.system_token()
    graph = AdsGraph(session, writes=False)
    now = _utcnow()
    rc = 0
    reach = True
    for slug in [args.town] if args.town else list(towns.TOWNS):
        t = towns.town(slug)
        tz = ZoneInfo(t["timezone"])
        mine = {k: e for k, e in ledger.items() if isinstance(e, dict) and e.get("town") == slug}
        sv = None
        if reach:
            try:
                sv = survey(graph, token, slug)
            except PostError as e:
                rc = 1
                say(f"{slug}: {t['name']}: {e}")
                if token is pr.NETWORK_KEY and str(e).startswith(pr.NO_KEY_HELP):
                    reach = False  # no key at all: the ledgers are all there is
        if sv:
            c = sv["campaign"]
            say(f"{slug}: {t['name']}, campaign {c['name']!r} ({c['id']})")
            say(f"  Campaign: {c.get('status')}" + (f" (Meta: {c.get('effective_status')})"
                                                    if c.get("effective_status") not in (None, c.get("status")) else "")
                + "; " + "\n            ".join(budget_lines(sv)))
            on_sets = [s for s in sv["adsets"] if s.get("status") == "ACTIVE"]
            on_ads = [a for a in sv["ads"] if a.get("status") == "ACTIVE"]
            if on_sets or on_ads:
                say("  Set to ACTIVE" + ("" if c.get("status") == "ACTIVE"
                                         else " (the campaign is paused, so none of it delivers)") + ":")
                for s in on_sets:
                    say(f"    {obj_line('ad set', s, tz, now)}")
                for a in on_ads:
                    say(f"    {obj_line('ad', a, tz, now)}")
            else:
                say("  Set to ACTIVE: nothing")
            for s in sv["siblings"]:
                say(f"  Also named like it (not ads.py's): campaign {s.get('name')!r} ({s['id']}), {s.get('status')}")
            try:
                today = insights(graph, token, c["id"], "today")
                week = insights(graph, token, c["id"], "last_7d")
                per_ad = insights(graph, token, c["id"], "last_7d", level="ad",
                                  fields="ad_id,ad_name," + INSIGHT_FIELDS, limit="100")
                say(f"  Today: {numbers_line(today[0] if today else {})}  (the ad account's day, "
                    f"{sv['account'].get('timezone_name') or 'Central'})")
                span = f" ({week[0].get('date_start')} to {week[0].get('date_stop')})" if week else ""
                say(f"  Last 7 days{span}: {numbers_line(week[0] if week else {})}")
                ours = {str(((e.get('steps') or {}).get('ad') or {}).get('id')): k for k, e in mine.items()}
                for r in per_ad:
                    if str(r.get("ad_id")) in ours:
                        say(f"    {ours[str(r.get('ad_id'))]} (ad {r.get('ad_id')}): {numbers_line(r)}")
            except PostError as e:
                rc = 1
                say(f"  Couldn't read the spend: {e}")
        say("  Ledger:" if mine else "  Ledger: no ads made from here yet.")
        for k, e in sorted(mine.items(), key=lambda kv: ((kv[1].get("window") or {}).get("start_utc") or "", kv[0])):
            say(f"    {entry_line(k, e, tz)}")
    return rc


# ------------------------------------------------------------------ main

def main(argv=None, session=None):
    ap = argparse.ArgumentParser(prog="ads.py", description="Run the subscribe videos as paused Meta ads, and turn "
                                                            "them on only on an explicit go.")
    sub = ap.add_subparsers(dest="command", required=True)

    def file_args(p):
        p.add_argument("file", metavar="VIDEO.mp4", help="the render's feed-4x5.mp4")
        p.add_argument("--video", required=True, metavar="ID", help="scripts.json id, e.g. victoria-1")
        p.add_argument("--story", metavar="9x16.mp4", help="the 9:16 cut for Stories/Reels (not used yet: see plan)")
        p.add_argument("--template", metavar="ADSET_ID", help="the ad set to copy, when the campaign has several")
        p.add_argument("--force", action="store_true", help="make another ad for a video the ledger already has")
        p.add_argument("--allow-draft", action="store_true", help="a video scripts.json still marks draft")
        p.add_argument("--ledger", help=argparse.SUPPRESS)

    p = sub.add_parser("plan", help="what upload would make (reads Meta, writes nothing)")
    file_args(p)
    u = sub.add_parser("upload", help="make the paused ad (a dry run without --go)")
    file_args(u)
    u.add_argument("--go", action="store_true", help="really make it; without it nothing is sent")
    g = sub.add_parser("go", help="turn a video's ad on and pause the campaign's others (a dry run without --go)")
    g.add_argument("--video", required=True, metavar="ID")
    g.add_argument("--go", action="store_true", help="really do it")
    g.add_argument("--ledger", help=argparse.SUPPRESS)
    s = sub.add_parser("stop", help="pause a video's ad and ad set (a dry run without --go)")
    s.add_argument("--video", required=True, metavar="ID")
    s.add_argument("--campaign", action="store_true", help="pause the town's campaign too")
    s.add_argument("--go", action="store_true", help="really do it")
    s.add_argument("--ledger", help=argparse.SUPPRESS)
    st = sub.add_parser("status", help="each town's campaign, what's on, spend and results, and the ledger")
    st.add_argument("--town", choices=list(towns.TOWNS))
    st.add_argument("--ledger", help=argparse.SUPPRESS)
    args = ap.parse_args(argv)
    try:
        if args.command in ("plan", "upload"):
            return cmd_plan(args, session)
        return {"go": cmd_go, "stop": cmd_stop, "status": cmd_status}[args.command](args, session)
    except PostError as e:
        say(f"error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
