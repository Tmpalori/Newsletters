#!/usr/bin/env python3
"""Post a finished subscribe video as a Facebook Reel on its town's Page.

    python3 post_reel.py check [--town SLUG]
    python3 post_reel.py post out/renders/victoria-1/reel-9x16.mp4 --video victoria-1
    python3 post_reel.py post VIDEO.mp4 --video victoria-1 --go         # schedule it
    python3 post_reel.py post VIDEO.mp4 --video victoria-1 --now --go   # publish it now
    python3 post_reel.py post VIDEO.mp4 --video victoria-1 --at 2026-10-25T19:00 --go
    python3 post_reel.py status [--town SLUG]

`post` is a dry run unless --go: it checks the file (ffprobe) and the time,
then prints what it would send, without a single network call. With --go it
follows Meta's Reels Publishing API guide
(developers.facebook.com/documentation/video-api/guides/reels-publishing):
POST /{page-id}/video_reels upload_phase=start, the bytes to
rupload.facebook.com, GET /{video-id}?fields=status until Meta has the file,
then POST /{page-id}/video_reels upload_phase=finish with video_state
PUBLISHED (--now) or SCHEDULED plus scheduled_publish_time, and the caption
(scripts.json's, or --caption) as the description. The time is the video's
post_at_local in the town's time zone unless --at gives another.

Needs a system-user token with the five Pages assigned (Create content) and
pages_show_list, pages_read_engagement and pages_manage_posts (read_insights
too, for reach): the environment's network secret for graph-video.facebook.com
(how Tristen's cloud environment has it; see NETWORK_HOST), or META_TOKEN
(else META_PAGE_TOKEN). Each Page's own token is looked up from it
(GET /{page-id}?fields=access_token,name) and used for every call on that
Page. Tokens only ever travel in an Authorization header, never in a URL,
and are never printed, logged, raised or written down.

out/posted.json records what went out: video id -> Page, Meta's video id,
state and scheduled time. A video that is scheduled, published or possibly
published (pending) isn't posted again without --force. One --go runs at a
time (out/posted.json.lock); a second one stops before sending anything.

GRAPH_API_VERSION overrides the Graph version (default v23.0), as for the
site's scripts/social_post.py and scripts/meta_ads.py.
"""
import argparse
import contextlib
import datetime as dt
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
from zoneinfo import ZoneInfo

import requests

import towns

try:
    import fcntl
except ImportError:  # Windows: no flock, so one --go at a time is on the owner there
    fcntl = None

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS_PATH = os.path.join(HERE, "scripts.json")
# out/ is gitignored: the ledger is this machine's record of what it sent.
LEDGER_PATH = os.path.join(HERE, "out", "posted.json")

# One place for the Graph version, as in scripts/social_post.py: moving off a
# version Meta retires needs only GRAPH_API_VERSION, no code change.
GRAPH_VERSION = os.environ.get("GRAPH_API_VERSION", "").strip() or "v23.0"
GRAPH_VERSION = GRAPH_VERSION if GRAPH_VERSION.startswith("v") else f"v{GRAPH_VERSION}"
GRAPH = f"https://graph.facebook.com/{GRAPH_VERSION}"
# Reel bytes go to their own host (the guide's Step 2), same version.
RUPLOAD_HOST = "rupload.facebook.com"
RUPLOAD = f"https://{RUPLOAD_HOST}/video-upload/{GRAPH_VERSION}"
# Without META_TOKEN, the system-user token can be a network secret: the
# environment's proxy puts it on every request to one host, replacing any
# Authorization header there. Every Page call carries the Page's own token,
# so that host can't be graph.facebook.com. It is graph-video.facebook.com,
# Meta's other Graph API host, used here only for the calls that need the
# system user: each Page's token, and the token's own name and permissions.
NETWORK_HOST = "graph-video.facebook.com"
NETWORK_GRAPH = f"https://{NETWORK_HOST}/{GRAPH_VERSION}"


class _NetworkKey:
    """Stands in for the system-user token when the network adds it."""

    def __repr__(self):
        return "<network key>"


NETWORK_KEY = _NetworkKey()

# Meta's "wait and retry" codes (Graph error-handling guide: unknown,
# service, throttling, app limit), plus is_transient and any 5xx: the site's
# social_post.py set without Instagram's image-fetch codes. Bounded, so a
# dead API fails in under a minute instead of hanging the session.
TRANSIENT_CODES = {1, 2, 4, 17, 341}
RETRY_DELAYS = (5, 20)
TIMEOUT = (10, 60)           # (connect, read) for every Graph call
UPLOAD_TIMEOUT = (10, 600)   # the bytes themselves: minutes on a slow uplink
POLL_EVERY = 5
PROCESS_DEADLINE = 600       # for Meta to take the upload before finishing
CONFIRM_DEADLINE = 180       # for Meta's status to show the finish landed
DONE = ("complete", "completed")  # the guide spells the phase status both ways

# The guide's Video Specifications. These refuse a file; its recommended
# settings (closed 2-5 s GOP, 4:2:0, stereo 48 kHz AAC LC at 128 kb/s+,
# fixed frame rate, progressive) only warn, since Meta re-encodes anyway.
MIN_SIZE = (540, 960)
ASPECT = 9 / 16
ASPECT_TOLERANCE = 0.01      # 1%, so an odd-pixel render still counts
DURATION = (3.0, 90.0)
# 24 to 60 fps; a phone's 23.976 counts as 24 (Meta's own sample app lists
# a minimum of 23).
FPS = (24000 / 1001 - 0.001, 60.001)
VIDEO_CODECS = {"h264": "H.264", "hevc": "HEVC"}
GOP_MAX = 5.0
# The guide names no file size limit (Meta's sample app says n/a), so this
# cap is ours: a 16-second render is a few MB, and anything near 1 GB is a
# raw take or the wrong file, and would take minutes in one upload request.
MAX_BYTES = 1_000_000_000
# Raw-take tells of ours, not Meta's. render.py drops every tag a camera
# writes (-map_metadata -1), so a file that still has the phone's make,
# model or location is the take itself: no captions, hook or end card, and
# where it was filmed would go to Meta with it. HDR (below) catches iPhone
# takes shot in HDR; these catch the ones shot in SDR.
CAMERA_TAGS = ("com.apple.quicktime.make", "com.apple.quicktime.model", "com.apple.quicktime.location.iso6709",
               "location", "location-eng", "com.android.version")
# analyze.py cuts to 16 s (TARGET; 16.5 s at most), so anything much longer
# is likely a take with every restart still in it. Only a note: a longer
# hand-made reel is still a reel.
CUT_LONG = 18.0

# "Greater than 10 minutes from the current time and within 29 days", and
# "30 API-published posts within a 24-hour moving period" per Page, which
# the guide asks apps that schedule to enforce themselves too.
SCHEDULE_MIN = dt.timedelta(minutes=10)
SCHEDULE_MAX = dt.timedelta(days=29)
REELS_PER_DAY = 30

POSTING = ("pages_show_list", "pages_read_engagement", "pages_manage_posts")
INSIGHTS = ("read_insights",)
REEL_FIELDS = "id,description,created_time,updated_time,published,scheduled_publish_time,permalink_url,status"

# Ledger states that stop a second post without --force: the reel is live,
# queued, or may be (pending: the finish call's answer never came).
# uploading/uploaded/failed/error never went public.
BLOCKING = ("pending", "scheduled", "published")

# Seams for the tests: no real sleeping, a fixed clock.
_sleep = time.sleep
_monotonic = time.monotonic


def _utcnow():
    return dt.datetime.now(dt.timezone.utc)


# ------------------------------------------------------------ secrets, output

_SECRETS = set()


def _secret(value):
    """Remember a token so scrub() masks it wherever it might surface (an
    error message Meta echoes it in, say)."""
    if value and len(value) >= 8:
        _SECRETS.add(value)
    return value


def scrub(text):
    text = str(text)
    for s in sorted(_SECRETS, key=len, reverse=True):
        text = text.replace(s, "[token]")
    return text


def say(*parts, file=None):
    print(scrub(" ".join(str(p) for p in parts)), file=file or sys.stdout)


class PostError(RuntimeError):
    """A refusal or failure, with Meta's code, subcode, message and
    fbtrace_id (what Meta support asks for) and the HTTP status when there
    was one. Built from scrubbed text only and never holding the request or
    response, so no token can ride along."""

    def __init__(self, message, *, code=None, subcode=None, fbtrace_id=None, status=None,
                 kind=None, transient=False, hint=None):
        self.message = scrub(message)
        self.code = code
        self.subcode = subcode
        self.fbtrace_id = scrub(fbtrace_id) if fbtrace_id else None
        self.status = status
        self.kind = scrub(kind) if kind else None  # Meta's own "type" text: it goes to the ledger too
        self.transient = transient
        self.hint = scrub(hint) if hint else None
        super().__init__(self._text())

    def _text(self):
        ids = [f"code {self.code}" if self.code is not None else "",
               f"subcode {self.subcode}" if self.subcode is not None else "",
               f"HTTP {self.status}" if self.status else "",
               f"fbtrace_id {self.fbtrace_id}" if self.fbtrace_id else ""]
        ids = ", ".join(i for i in ids if i)
        return self.message + (f" [{ids}]" if ids else "") + (f". {self.hint}" if self.hint else "")

    def as_dict(self):
        out = {"message": self.message, "code": self.code, "subcode": self.subcode,
               "fbtrace_id": self.fbtrace_id, "status": self.status, "kind": self.kind}
        return {k: v for k, v in out.items() if v is not None}


class Unconfirmed(PostError):
    """The finish call may have gone through, but Meta never said so. Never
    sent again blindly: the ledger keeps the video pending."""

    @classmethod
    def wrap(cls, e, note):
        return cls(f"{e.message}; {note}", code=e.code, subcode=e.subcode, fbtrace_id=e.fbtrace_id,
                   status=e.status, kind=e.kind, hint=e.hint)


class LedgerError(PostError):
    """posted.json couldn't be written. Kept apart from Meta's errors: after
    the finish call lands, a failed write must never be answered by writing
    the post down as failed, or the next run would post it again."""


def _int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


# Meta's spec errors (the guide's Error Codes table), as subcodes or codes.
SPEC_ERRORS = {1363040: "the aspect ratio must be 9:16", 1363127: "the resolution must be at least 540x960",
               1363128: "the duration must be 3 to 90 seconds", 1363129: "the frame rate must be 24 to 60 fps"}


def _hint(code, subcode, message):
    """What to do about a Graph error, in the owner's terms."""
    if code in (12, 2635) or re.search(r"(deprecated|unsupported|unknown|invalid)\W+(api\W+)?version", message, re.I):
        return (f"Meta refused Graph API {GRAPH_VERSION} (retired?): set GRAPH_API_VERSION to a current "
                "version, e.g. v24.0")
    if code in (102, 190):
        return ("The token is invalid or expired: generate a new system-user token (Business settings > "
                "System users) and set META_TOKEN")
    if code == 10 or (code is not None and 200 <= code <= 299):
        return "A permission is missing: run post_reel.py check"
    if code == 100 and subcode == 33:
        return ("The id doesn't exist or this token can't see it: check the Page id and that the system user "
                "has the Page")
    if code == 368:
        return "Meta has blocked this for now (policy); wait and try later"
    if code == 506:
        return "Meta refuses the same post twice in a row: change the caption"
    if code == 613:
        return f"Rate limited: Meta allows {REELS_PER_DAY} API-published reels per Page in 24 hours"
    if code == 6000:
        return "Meta couldn't use the file: re-render it and try again"
    for c in (subcode, code):
        if c in SPEC_ERRORS:
            return f"Meta refused the file: {SPEC_ERRORS[c]}"
    return None


def graph_error(body, status, what):
    """A PostError from an error answer: Graph's {"error": {...}},
    rupload's {"debug_info": {...}} (its OffsetInvalidError and friends), or
    anything else (a proxy's HTML 502)."""
    if isinstance(body, dict) and isinstance(body.get("error"), dict):
        e = body["error"]
        code, sub = _int(e.get("code")), _int(e.get("error_subcode"))
        msg = str(e.get("message") or f"HTTP {status}")
        user = str(e.get("error_user_msg") or "").strip()
        if user and user not in msg:
            msg += f" ({user})"
        transient = status >= 500 or code in TRANSIENT_CODES or e.get("is_transient") is True
        return PostError(f"{what}: {msg}", code=code, subcode=sub, fbtrace_id=e.get("fbtrace_id"),
                         status=status, kind=e.get("type"), transient=transient, hint=_hint(code, sub, msg))
    if isinstance(body, dict) and isinstance(body.get("debug_info"), dict):
        d = body["debug_info"]
        kind = str(d.get("type") or "") or None
        msg = str(d.get("message") or f"HTTP {status}")
        return PostError(f"{what}: {msg}" + (f" ({kind})" if kind else ""), status=status, kind=kind,
                         transient=status >= 500 or d.get("retriable") is True)
    return PostError(f"{what}: HTTP {status}", status=status, transient=status >= 500)


def _answer(r, what):
    try:
        body = r.json()
    except ValueError:
        body = None
    if r.status_code >= 400 or (isinstance(body, dict) and ("error" in body or "debug_info" in body)):
        raise graph_error(body, r.status_code, what)
    if not isinstance(body, dict):
        raise PostError(f"{what}: Meta's answer wasn't a JSON object", status=r.status_code)
    return body


# ------------------------------------------------------------------ the API

class Graph:
    """Graph API and rupload calls on one session: every call has a timeout,
    tokens go only in the Authorization header, and Meta's transient errors
    get a bounded retry where repeating the call is safe."""

    def __init__(self, session=None):
        self.s = session or requests.Session()

    def request(self, method, url, what, token, *, params=None, data=None, headers=None,
                timeout=TIMEOUT, scheme="Bearer"):
        if token is NETWORK_KEY:
            # Nothing to send: the network adds the key, and only on its host.
            # Anywhere else this would be an unsigned call.
            if urllib.parse.urlsplit(url).hostname != NETWORK_HOST:
                raise PostError(f"{what}: the network key only works on {NETWORK_HOST}")
            h = {}
        else:
            h = {"Authorization": f"{scheme} {token}"}
        h.update(headers or {})
        try:
            r = self.s.request(method, url, params=params, data=data, headers=h, timeout=timeout)
        except requests.RequestException as e:
            # Only the type: requests' messages can carry the URL or a header,
            # and its exception holds the request; `from None` keeps both out
            # of any traceback.
            raise PostError(f"{what}: {type(e).__name__}", kind="network", transient=True) from None
        except UnicodeError:
            # http.client encodes headers as Latin-1 before connecting and
            # raises this outside requests' own errors: a crash mid-post.
            raise PostError(f"{what}: a header had a character HTTP can't carry (check META_TOKEN)") from None
        return _answer(r, what)

    def call(self, method, path, what, token, **kw):
        """A Graph call that is safe to repeat (reads, starting an upload
        session: a repeat leaves at most an unused session behind)."""
        base = NETWORK_GRAPH if token is NETWORK_KEY else GRAPH
        for delay in RETRY_DELAYS + (None,):
            try:
                return self.request(method, f"{base}/{path}", what, token, **kw)
            except PostError as e:
                if not e.transient or delay is None:
                    raise
                say(f"{e}; retrying in {delay}s")
                _sleep(delay)

    def status(self, video_id, token):
        body = self.call("GET", video_id, f"GET /{video_id}?fields=status", token, params={"fields": "status"})
        st = body.get("status")
        return st if isinstance(st, dict) else {}

    def uploaded_bytes(self, video_id, token, size):
        """How much of the file Meta has (the guide's resume offset), 0 when
        it won't say."""
        try:
            up = _phase(self.status(video_id, token), "uploading_phase")
        except PostError:
            return 0
        n = _int(up.get("bytes_transfered", up.get("bytes_transferred")))  # the guide spells it "transfered"
        return max(0, min(n or 0, size))

    def upload(self, url, path, size, token, video_id):
        """The guide's "Upload a Local File": the bytes in one POST with
        offset and file_size headers. After a dropped connection, a 5xx or
        one of rupload's offset/partial/processing errors it resumes from
        the byte count Meta reports, as its "Resume an Interrupted Upload"
        says, a bounded number of times."""
        offset = 0
        for delay in RETRY_DELAYS + (None,):
            try:
                try:
                    f = open(path, "rb")
                except OSError as e:
                    raise PostError(f"can't read {path}: {e.strerror or type(e).__name__}") from None
                with f:
                    f.seek(offset)
                    body = self.request("POST", url, f"POST {RUPLOAD_HOST} upload", token, scheme="OAuth", data=f,
                                        headers={"offset": str(offset), "file_size": str(size),
                                                 "Content-Type": "application/octet-stream"},
                                        timeout=UPLOAD_TIMEOUT)
            except PostError as e:
                resumable = e.transient or e.kind in ("OffsetInvalidError", "PartialRequestError",
                                                      "ProcessingFailedError")
                if not resumable or delay is None:
                    raise
                say(f"{e}; resuming in {delay}s")
                _sleep(delay)
                offset = self.uploaded_bytes(video_id, token, size)
                if offset >= size:
                    return
                continue
            if body.get("success") is not True:
                raise PostError(f"POST {RUPLOAD_HOST} upload: Meta didn't confirm the upload ({_brief(body)})")
            return


def _brief(body):
    return scrub(json.dumps(body, sort_keys=True))[:200]


def upload_url(given, video_id):
    """Where the bytes go: the upload_url Meta's start answer names, when it
    is https on rupload.facebook.com, else the guide's own URL. The Page
    token rides in the header, so it must never go to any other host."""
    default = f"{RUPLOAD}/{video_id}"
    try:
        u = urllib.parse.urlsplit(str(given or ""))
        ok = u.scheme == "https" and u.hostname == RUPLOAD_HOST and u.port in (None, 443) and not u.username
    except ValueError:
        ok = False
    return str(given) if ok else default


def token_from_env():
    """(variable name, token) from META_TOKEN, else META_PAGE_TOKEN."""
    for name in ("META_TOKEN", "META_PAGE_TOKEN"):
        value = os.environ.get(name, "").strip()
        if value:
            if any(c.isspace() or ord(c) < 32 for c in value):
                # requests would put the header value in its error message.
                raise PostError(f"{name} has spaces or line breaks in it; set it again")
            if not value.isascii() or not value.isprintable():
                # A curly quote pasted along with it can't go in a header.
                raise PostError(f"{name} has a character that isn't plain ASCII in it (a pasted quote?); set it "
                                "again")
            return name, _secret(value)
    return None, None


def system_token():
    """(what to call it, token): META_TOKEN or META_PAGE_TOKEN when set, else
    the network key. Whether the network really has one, only Meta's answer
    can tell (no_key() reads it)."""
    name, token = token_from_env()
    return (name, token) if token else (f"the network secret for {NETWORK_HOST}", NETWORK_KEY)


def no_key(e):
    """Meta's answer when a call reached it with no token at all: no
    META_TOKEN, and no network secret for NETWORK_HOST either."""
    text = str(e)
    return e.code in (104, 200) and ("app ID" in text or "access token is required" in text)


NO_KEY_HELP = (f"No Facebook key: META_TOKEN isn't set, and Meta got no key on {NETWORK_HOST}. Add the system "
               "user's token as a network secret for that host (Bearer, Authorization header), or set META_TOKEN.")


def page_access(graph, page_id, token):
    """(the Page's own token, its name), looked up with the system-user
    token. Posting as the Page needs the Page's token; the system user only
    has to have the Page assigned."""
    try:
        body = graph.call("GET", page_id, f"GET /{page_id}?fields=access_token,name", token,
                          params={"fields": "access_token,name"})
    except PostError as e:
        if token is NETWORK_KEY and no_key(e):
            raise PostError(NO_KEY_HELP, code=e.code, fbtrace_id=e.fbtrace_id, status=e.status) from None
        raise
    page_token = body.get("access_token")
    if not page_token:
        raise PostError(f"Meta gave no Page token for {page_id}: assign the Page to the system user (Business "
                        "settings > System users > Assign assets > Pages, with Create content) and give the token "
                        "pages_show_list and pages_manage_posts")
    return _secret(str(page_token)), str(body.get("name") or "")


def _phase(st, name):
    """One phase of Meta's status, {} when it's missing or not an object: an
    odd answer must not crash a run between the finish call and the ledger."""
    p = st.get(name) if isinstance(st, dict) else None
    return p if isinstance(p, dict) else {}


def phase_error(st):
    """Meta's own words for a failed upload, processing or publish, or None."""
    for phase in ("uploading_phase", "processing_phase", "publishing_phase"):
        p = st.get(phase)
        if not isinstance(p, dict):
            continue
        err = p.get("error") or p.get("errors")
        if err or p.get("status") == "error":
            return f"{phase.split('_')[0]}: {_err_text(err) or 'error'}"
    if st.get("video_status") in ("error", "upload_failed", "expired"):
        return f"video_status {st['video_status']}"
    return None


def _err_text(err):
    if isinstance(err, dict):
        return str(err.get("message") or json.dumps(err, sort_keys=True))
    if isinstance(err, list):
        return "; ".join(filter(None, (_err_text(e) for e in err)))
    return str(err or "")


def wait_for_upload(graph, video_id, token):
    """Poll the video's status until Meta has the whole file and isn't in
    the middle of processing it, so a refused file (too small, too long)
    shows up before anything is published."""
    deadline = _monotonic() + PROCESS_DEADLINE
    while True:
        st = graph.status(video_id, token)
        err = phase_error(st)
        if err:
            raise PostError(f"Meta couldn't use the upload: {err}; nothing was published")
        up = _phase(st, "uploading_phase").get("status")
        proc = _phase(st, "processing_phase").get("status")
        # The phase says it best; video_status only when Meta leaves it out.
        uploaded = up in DONE if up else st.get("video_status") in ("upload_complete", "ready")
        if uploaded and proc != "in_progress":
            return st
        if _monotonic() >= deadline:
            raise PostError(f"Meta still didn't have the file after {PROCESS_DEADLINE // 60} minutes (upload "
                            f"{up or '?'}, processing {proc or '?'}); nothing was published")
        _sleep(POLL_EVERY)


def accepted(graph, video_id, token):
    """Whether Meta's status shows a finish call landed."""
    try:
        pub = _phase(graph.status(video_id, token), "publishing_phase")
    except PostError:
        return False
    return pub.get("publish_status") in ("scheduled", "published") or pub.get("status") in ("in_progress",) + DONE


def finish(graph, page_id, video_id, token, caption, when_utc):
    """The guide's Step 3: publish now or schedule. A try whose answer was
    lost (timeout, 5xx) may still have landed, so before sending it again
    this waits, then asks Meta's status whether it did; whatever is still
    unclear after the last try is Unconfirmed."""
    data = {"video_id": video_id, "upload_phase": "finish",
            "video_state": "SCHEDULED" if when_utc else "PUBLISHED", "description": caption}
    if when_utc:
        data["scheduled_publish_time"] = str(int(when_utc.timestamp()))
    what = f"POST /{page_id}/video_reels (finish)"
    maybe_sent = False
    for delay in RETRY_DELAYS + (None,):
        try:
            body = graph.request("POST", f"{GRAPH}/{page_id}/video_reels", what, token, data=data)
            if body.get("success") is False:
                raise PostError(f"{what}: Meta answered success=false"
                                + (f" ({body['message']})" if body.get("message") else ""))
            return body
        except PostError as e:
            if not e.transient:
                if maybe_sent:
                    raise Unconfirmed.wrap(e, "an earlier try may have gone through") from None
                raise
            maybe_sent = True
            # The wait comes first: asked at once, Meta's status can trail
            # a finish that did land, and a second one would go out.
            _sleep(delay if delay is not None else POLL_EVERY)
            if accepted(graph, video_id, token):
                return {"success": True}
            if delay is None:
                raise Unconfirmed.wrap(e, "Meta may have taken it anyway") from None
            say(f"{e}; after {delay}s Meta's status still doesn't show it, so sending it again")


def confirm(graph, video_id, token, scheduled):
    """After finish: ("scheduled" | "published", status) once Meta's status
    shows it, or (None, last status) at the deadline. A processing or
    publishing error raises: Meta took the reel but won't show it."""
    deadline = _monotonic() + CONFIRM_DEADLINE
    st = {}
    while True:
        try:
            st = graph.status(video_id, token)
        except PostError as e:
            say(f"Couldn't read the reel's status ({e}); check it later with status.")
            return None, st
        err = phase_error(st)
        if err:
            raise PostError(f"Meta took the reel, then failed it: {err}")
        pub = _phase(st, "publishing_phase")
        if pub.get("publish_status") in ("scheduled", "published"):
            return pub["publish_status"], st
        if not scheduled and pub.get("status") in DONE:
            return "published", st
        if _monotonic() >= deadline:
            return None, st
        _sleep(POLL_EVERY)


def brief_status(st):
    """The parts of Meta's status worth keeping in the ledger."""
    out = {"video_status": st.get("video_status")}
    for phase in ("uploading_phase", "processing_phase", "publishing_phase"):
        p = st.get(phase)
        if isinstance(p, dict) and p.get("status"):
            out[phase.split("_")[0]] = p["status"]
    pub = _phase(st, "publishing_phase")
    for k in ("publish_status", "publish_time"):
        if pub.get(k) is not None:
            out[k] = pub[k]
    return {k: v for k, v in out.items() if v is not None}


# ------------------------------------------------------------------ the file

def probe(path):
    """ffprobe's streams and format for path."""
    try:
        # Absolute: a name like -final.mp4 would be read as an option.
        r = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams",
                            os.path.abspath(path)], capture_output=True, text=True, timeout=60)
    except FileNotFoundError:
        raise PostError("ffprobe not found; install ffmpeg") from None
    except subprocess.TimeoutExpired:
        raise PostError("ffprobe took over a minute to read the file") from None
    if r.returncode != 0:
        raise PostError(f"ffprobe couldn't read the file: {(r.stderr or '').strip()[-300:] or 'no reason given'}")
    try:
        return json.loads(r.stdout or "{}")
    except ValueError:
        raise PostError("ffprobe's answer wasn't JSON") from None


def keyframe_times(path):
    """Keyframe times of the first video stream, from packet flags (no
    decoding, so it's quick), or None when ffprobe can't say."""
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                            "packet=pts_time,flags", "-print_format", "json", os.path.abspath(path)],
                           capture_output=True, text=True, timeout=60)
        packets = json.loads(r.stdout or "{}").get("packets") or []
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    out = []
    for p in packets:
        t = _num(p.get("pts_time"))
        if "K" in (p.get("flags") or "") and t is not None:
            out.append(t)
    return sorted(out)


def _num(v):
    try:
        return float(v) if v not in (None, "", "N/A") else None
    except (TypeError, ValueError):
        return None


def _rate(v):
    """'30000/1001' or '30' as a number, None for '0/0' and the like."""
    if isinstance(v, str) and "/" in v:
        n, d = (_num(x) for x in v.split("/", 1))
        return n / d if n and d else None
    return _num(v)


def _rotation(stream):
    """Clockwise degrees a player turns the picture: an iPhone take's display
    matrix (counter-clockwise in ffprobe), or an old rotate tag."""
    for sd in stream.get("side_data_list") or []:
        if "rotation" in sd:
            r = _num(sd.get("rotation"))
            return int(round(-r)) % 360 if r is not None else 0
    r = _num((stream.get("tags") or {}).get("rotate"))
    return int(round(r)) % 360 if r is not None else 0


def display_size(stream):
    """(width, height) as viewers see it: rotation and non-square pixels
    applied."""
    w, h = int(stream.get("width") or 0), int(stream.get("height") or 0)
    sar = _rate(str(stream.get("sample_aspect_ratio") or "").replace(":", "/"))
    if sar and sar > 0:
        w = round(w * sar)
    if _rotation(stream) % 180 == 90:
        w, h = h, w
    return w, h


def check_file(path, info=None, keyframes=None):
    """{"problems", "warnings", "facts", "size", "duration"} for a file about
    to become a Reel. Problems are the guide's limits (Meta would refuse the
    file) plus guards of ours: the size cap and a raw take (HDR, or the
    camera's tags); warnings are the guide's recommended settings and a
    length far past the 16-second cut.
    `info` (ffprobe's JSON) and `keyframes` are for tests; without info the
    file is probed and its keyframes read."""
    rep = {"problems": [], "warnings": [], "facts": [], "size": 0, "duration": None}
    problems, warnings, facts = rep["problems"], rep["warnings"], rep["facts"]
    if not os.path.isfile(path):
        problems.append(f"no such file: {path}")
        return rep
    size = rep["size"] = os.path.getsize(path)
    if size == 0:
        problems.append("the file is empty")
    elif size > MAX_BYTES:
        problems.append(f"{size / 1e6:,.0f} MB is over this tool's {MAX_BYTES / 1e6:,.0f} MB cap (a 16-second render "
                        "is a few MB: is this a raw take?)")
    if os.path.splitext(path)[1].lower() != ".mp4":
        warnings.append("not an .mp4 (Meta recommends MP4 for Reels)")
    if info is None:
        try:
            info = probe(path)
        except PostError as e:
            problems.append(str(e))
            return rep
        keyframes = keyframe_times(path)
    streams = info.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"
                  and not (s.get("disposition") or {}).get("attached_pic")), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    duration = _num((info.get("format") or {}).get("duration")) or _num((video or {}).get("duration"))
    rep["duration"] = duration
    if duration is None:
        problems.append("ffprobe couldn't tell the duration")
    elif not DURATION[0] <= duration <= DURATION[1]:
        problems.append(f"{duration:.1f} s long; Reels must be {DURATION[0]:.0f} to {DURATION[1]:.0f} seconds")
    elif duration > CUT_LONG:
        warnings.append(f"{duration:.1f} s long; edit.py cuts these to about 16 s (is this a raw take?)")
    tags = {str(k).lower(): str(v) for k, v in ((info.get("format") or {}).get("tags") or {}).items()}
    camera = [k for k in CAMERA_TAGS if k in tags]
    if camera:
        phone = tags.get("com.apple.quicktime.model") or tags.get("com.apple.quicktime.make") or "a phone"
        where = " and where it was filmed" if any("location" in k for k in camera) else ""
        problems.append(f"the camera's own tags ({phone}{where}): a raw take, not a render; post the render's "
                        "reel-9x16.mp4")

    if video is None:
        problems.append("no video stream")
    else:
        codec = video.get("codec_name") or "unknown"
        if codec not in VIDEO_CODECS:
            problems.append(f"video codec is {codec}; post H.264 or HEVC")
        w, h = display_size(video)
        if not w or not h:
            problems.append("ffprobe couldn't tell the picture size")
        else:
            if abs(w / h - ASPECT) > ASPECT * ASPECT_TOLERANCE:
                problems.append(f"{w}x{h} isn't 9:16; Reels are vertical 9:16 (is this the 4:5 feed cut?)")
            if w < MIN_SIZE[0] or h < MIN_SIZE[1]:
                problems.append(f"{w}x{h} is under the {MIN_SIZE[0]}x{MIN_SIZE[1]} minimum")
        fps = _rate(video.get("avg_frame_rate")) or _rate(video.get("r_frame_rate"))
        nominal = _rate(video.get("r_frame_rate"))
        if not fps:
            problems.append("ffprobe couldn't tell the frame rate")
        elif not FPS[0] <= fps <= FPS[1]:
            problems.append(f"{fps:.2f} fps; Reels must be 24 to 60 fps")
        elif nominal and abs(nominal - fps) / fps > 0.01:
            warnings.append(f"variable frame rate ({fps:.2f} fps average, {nominal:g} nominal); Meta asks for a "
                            "fixed one")
        pix = video.get("pix_fmt") or ""
        if pix and not re.match(r"(yuvj?420p|nv12|p010)", pix):
            warnings.append(f"pixel format {pix}; Meta asks for 4:2:0 chroma")
        transfer = video.get("color_transfer") or ""
        if transfer in ("arib-std-b67", "smpte2084"):
            # Meta takes HDR, but render.py only ever writes SDR, so this is
            # an unedited iPhone take: no captions, hook or end card.
            problems.append(f"HDR video ({'HLG' if transfer == 'arib-std-b67' else 'PQ'}): a raw iPhone take, not "
                            "a render; post the render's reel-9x16.mp4")
        if (video.get("field_order") or "progressive") not in ("progressive", "unknown"):
            warnings.append(f"interlaced ({video.get('field_order')}); Meta asks for progressive scan")
        facts.append(f"video: {VIDEO_CODECS.get(codec, codec)} {w}x{h}"
                     + (f", {round(fps) if abs(fps - round(fps)) < 0.005 else round(fps, 3)} fps" if fps else "")
                     + (f", {duration:.1f} s" if duration else ""))

    if keyframes and video is not None:
        stops = sorted(keyframes) + ([duration] if duration else [])
        gap = max((b - a for a, b in zip(stops, stops[1:])), default=0.0)
        if gap > GOP_MAX + 0.01:
            warnings.append(f"keyframes up to {gap:.1f} s apart; Meta recommends a closed GOP of 2-5 s "
                            "(x264 -g 60 at 30 fps)")

    if audio is None:
        problems.append("no audio track")
    else:
        acodec = audio.get("codec_name") or "unknown"
        profile = audio.get("profile") or ""
        if acodec != "aac":
            problems.append(f"audio codec is {acodec}; Reels need AAC")
        elif profile and profile.upper() != "LC":
            warnings.append(f"AAC profile {profile}; Meta asks for AAC Low Complexity")
        rate, channels, bits = _num(audio.get("sample_rate")), _int(audio.get("channels")), _num(audio.get("bit_rate"))
        if rate and rate != 48000:
            warnings.append(f"audio at {rate / 1000:g} kHz; Meta asks for 48 kHz")
        if channels and channels != 2:
            warnings.append(f"{'mono' if channels == 1 else f'{channels}-channel'} audio; Meta asks for stereo")
        # ffprobe reports the measured average, a little under the encoder's
        # nominal 128k, so only a clearly lower rate warns.
        if bits and bits < 124000:
            warnings.append(f"audio at {bits / 1000:.0f} kb/s; Meta asks for 128 kb/s or more")
        facts.append(f"audio: {acodec.upper()}" + (f" {profile}" if profile else "")
                     + (f", {rate / 1000:g} kHz" if rate else "")
                     + (f", {'stereo' if channels == 2 else 'mono' if channels == 1 else f'{channels} channels'}"
                        if channels else "") + (f", {bits / 1000:.0f} kb/s" if bits else ""))
    facts.append(f"size: {size / 1e6:.1f} MB ({size:,} bytes)")
    return rep


def other_video_in_path(path, video_id, ids):
    """Another video's id named in the file's path (out/renders/lincoln-2/...
    posted as victoria-1), or None: the cheapest guard against putting one
    town's video on another town's Page."""
    name = os.path.abspath(path).lower()
    hits = [i for i in ids if re.search(rf"(?<![a-z0-9]){re.escape(i.lower())}(?![0-9])", name)]
    return None if video_id in hits or not hits else hits[0]


# ------------------------------------------------------------------ time

def local_time(text, tzname):
    """(aware local time, UTC time) for 'YYYY-MM-DDTHH:MM' in tzname. A wall
    time the DST change skips or repeats is refused: guessing could post an
    hour off."""
    try:
        naive = dt.datetime.strptime(text.strip(), "%Y-%m-%dT%H:%M")
    except ValueError:
        raise PostError(f"{text!r} isn't a time like 2026-10-25T18:30") from None
    tz = ZoneInfo(tzname)
    first, second = naive.replace(tzinfo=tz, fold=0), naive.replace(tzinfo=tz, fold=1)
    if first.utcoffset() != second.utcoffset():
        if first.astimezone(dt.timezone.utc).astimezone(tz).replace(tzinfo=None) != naive:
            raise PostError(f"{naive:%Y-%m-%d %H:%M} doesn't exist in {tzname} (clocks spring forward); pick "
                            "another time")
        raise PostError(f"{naive:%Y-%m-%d %H:%M} happens twice in {tzname} (clocks fall back); pick another time")
    return first, first.astimezone(dt.timezone.utc)


def check_window(when_utc, now):
    """Meta's scheduling window: more than 10 minutes and at most 29 days
    ahead. A past time is refused outright."""
    ahead = when_utc - now
    if ahead <= dt.timedelta(0):
        raise PostError(f"{fmt_utc(when_utc)} is in the past; use --now to post right away, or --at for a new time")
    if ahead <= SCHEDULE_MIN:
        raise PostError(f"{fmt_utc(when_utc)} is only {_span(ahead)} away; Meta needs more than 10 minutes to "
                        "schedule (use --now, or a later --at)")
    if ahead > SCHEDULE_MAX:
        raise PostError(f"{fmt_utc(when_utc)} is {_span(ahead)} away; Meta schedules at most 29 days ahead")


def fmt_local(d, tz):
    t = d.astimezone(tz)
    return f"{t:%a %b} {t.day} {t.year}, {t.hour % 12 or 12}:{t:%M} {'AM' if t.hour < 12 else 'PM'} {t:%Z}"


def fmt_utc(d):
    return f"{d.astimezone(dt.timezone.utc):%Y-%m-%d %H:%M} UTC"


def fmt_both(d, tz):
    return f"{fmt_local(d, tz)} ({fmt_utc(d)})"


def _span(delta):
    mins = int(delta.total_seconds() // 60)
    days, mins = divmod(mins, 1440)
    hours, mins = divmod(mins, 60)
    parts = [f"{days} day{'s' * (days != 1)}" if days else "", f"{hours} hour{'s' * (hours != 1)}" if hours else "",
             f"{mins} minute{'s' * (mins != 1)}" if mins and not days else ""]
    return " ".join(p for p in parts if p) or "under a minute"


def _iso(d):
    return d.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _time(v):
    """A Graph time (unix seconds, or '2026-10-25T23:30:00+0000') in UTC."""
    if v in (None, "") or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)) or (isinstance(v, str) and v.strip().isdigit()):
        return dt.datetime.fromtimestamp(int(v), dt.timezone.utc)
    for f in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%SZ"):
        try:
            t = dt.datetime.strptime(str(v), f)
            return (t if t.tzinfo else t.replace(tzinfo=dt.timezone.utc)).astimezone(dt.timezone.utc)
        except ValueError:
            pass
    return None


# ------------------------------------------------------------------ ledger

def load_scripts(path=None):
    # VIDEO_SCRIPTS: see analyze.load_scripts.
    with open(path or os.environ.get("VIDEO_SCRIPTS") or SCRIPTS_PATH, encoding="utf-8") as f:
        return {v["id"]: v for v in json.load(f).get("videos") or []}


def load_ledger(path):
    """The ledger, {} before the first post. An unreadable one stops
    everything: without it there's no telling what already went out."""
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        raise PostError(f"can't read {path} ({type(e).__name__}); fix or move it first") from None
    if not isinstance(data, dict):
        raise PostError(f"{path} isn't a JSON object; fix or move it first")
    return data


def save_ledger(path, data):
    # Written whole and renamed, so a crash mid-write can't leave half a file.
    # Scrubbed as a whole too: Meta's answers (an error's type, a post id)
    # land in it, and a token must never be written down.
    text = scrub(json.dumps(data, indent=2, ensure_ascii=False, sort_keys=True)) + "\n"
    folder = os.path.dirname(path) or "."
    os.makedirs(folder, exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
        # On disk before the call it guards goes out: "pending" lost to a
        # power cut after the finish call would let the next run post twice.
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    try:
        fd = os.open(folder, os.O_RDONLY)
    except OSError:  # Windows can't open a folder; the rename is all there is
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


@contextlib.contextmanager
def ledger_lock(path):
    """One --go at a time per ledger. Two at once (two terminals, a command
    run twice) could both post the same video, and whichever wrote last
    would drop the other's entry, so a later run would post that one again."""
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        f = open(f"{path}.lock", "a")
    except OSError as e:
        raise PostError(f"can't open {path}.lock ({type(e).__name__}); nothing was sent") from None
    with f:
        if fcntl is not None:
            try:
                fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                raise PostError(f"another `post_reel.py post --go` is using {path}; let it finish, then run this "
                                "again") from None
        yield  # the lock goes with the file when it's closed, or when the process dies


def _attempts(ledger):
    for e in ledger.values():
        if isinstance(e, dict):
            yield e
            yield from (p for p in e.get("previous") or [] if isinstance(p, dict))


def publishes_last_day(ledger, page_id, now):
    """Finish calls to this Page in the last 24 hours, by the ledger."""
    n = 0
    for e in _attempts(ledger):
        t = _time(e.get("finished_at"))
        if e.get("page_id") == page_id and t and now - t < dt.timedelta(hours=24):
            n += 1
    return n


def ledger_problems(ledger, vid, page_id, now, force):
    """Why the ledger says not to post vid: it's out already (or may be),
    or the Page is at Meta's daily limit."""
    out = []
    prior = ledger.get(vid) if isinstance(ledger.get(vid), dict) else None
    if prior and prior.get("state") in BLOCKING and not force:
        out.append(f"{vid} is already {prior['state']} on {prior.get('page_name') or page_id} (Meta video "
                   f"{prior.get('fb_video_id') or '?'}); check it with status, and pass --force to post it again")
    recent = publishes_last_day(ledger, page_id, now)
    if recent >= REELS_PER_DAY:
        out.append(f"{recent} reels went to this Page in the last 24 hours; Meta allows {REELS_PER_DAY}")
    return out


# ------------------------------------------------------------------ commands

def cmd_post(args, session=None):
    scripts = load_scripts()
    video = scripts.get(args.video)
    if video is None:
        raise PostError(f"no video {args.video!r} in scripts.json; one of {', '.join(scripts)}")
    try:
        town = towns.town(video["town"])
    except KeyError as e:
        raise PostError(str(e.args[0] if e.args else e)) from None
    tz = ZoneInfo(town["timezone"])
    vid, page_id = video["id"], town["page_id"]
    now = _utcnow()
    caption = (args.caption if args.caption is not None else video.get("caption") or "").strip()
    ledger_path = args.ledger or LEDGER_PATH
    ledger = load_ledger(ledger_path)
    prior = ledger.get(vid) if isinstance(ledger.get(vid), dict) else None

    problems, when, when_error = [], None, None
    if not args.now:
        text = args.at or video.get("post_at_local")
        try:
            if not text:
                raise PostError(f"{vid} has no post_at_local in scripts.json; pass --at or --now")
            when = local_time(text, town["timezone"])
            check_window(when[1], now)
        except PostError as e:
            when_error = str(e)
            problems.append(when_error)
    report = check_file(args.file)
    problems += report["problems"]
    other = other_video_in_path(args.file, vid, scripts)
    if other:
        problems.append(f"the file's path names {other}, not {vid}: is this the right video?")
    if not caption:
        problems.append("the caption is empty")
    if video.get("draft") and not args.allow_draft:
        problems.append(f"{vid} is still a draft in scripts.json (its caption may be stale): finish the script "
                        "and set draft to false, or pass --allow-draft")
    problems += ledger_problems(ledger, vid, page_id, now, args.force)
    token_name = next((n for n in ("META_TOKEN", "META_PAGE_TOKEN") if os.environ.get(n, "").strip()), None)

    say(f"{'POST' if args.go else 'DRY RUN'}: {vid} ({video.get('angle') or 'video'}) as a Facebook Reel")
    say(f"  Page:     {town['name']}, Page id {page_id}")
    if when_error:
        say(f"  When:     {when_error}")
    elif when:
        say(f"  When:     {fmt_local(when[0], tz)} ({town['timezone']}), {_span(when[1] - now)} from now")
        say(f"            {fmt_utc(when[1])}, scheduled_publish_time {int(when[1].timestamp())}")
    else:
        say("  When:     now (video_state PUBLISHED)")
    say(f"  File:     {os.path.abspath(args.file)}")
    for f in report["facts"]:
        say(f"    ok    {f}")
    for w in report["warnings"]:
        say(f"    note  {w}")
    for p in report["problems"]:
        say(f"    NO    {p}")
    source = "from --caption" if args.caption is not None else "from scripts.json"
    say(f"  Caption:  {len(caption)} characters, {source}")
    for line in caption.splitlines():
        say(f"    {line}")
    say(f"  Token:    {token_name} is set" if token_name
        else f"  Token:    no META_TOKEN: --go uses the network secret for {NETWORK_HOST}")
    say(f"  Ledger:   {ledger_path}: "
        + (f"{vid} is {prior.get('state')} (Meta video {prior.get('fb_video_id') or '?'})" if prior
           else f"no entry for {vid} yet"))
    state = (f"video_state=SCHEDULED, scheduled_publish_time={int(when[1].timestamp())}" if when
             else "video_state=PUBLISHED")
    say("  With --go:" if not args.go else "  Steps:")
    say(f"    1. GET  {GRAPH if token_name else NETWORK_GRAPH}/{page_id}?fields=access_token,name  "
        "(the Page's own token)")
    say(f"    2. POST {GRAPH}/{page_id}/video_reels  upload_phase=start")
    say(f"    3. POST {RUPLOAD}/<video id>  {report['size']:,} bytes, offset 0")
    say(f"    4. GET  {GRAPH}/<video id>?fields=status  until Meta has the file (up to {PROCESS_DEADLINE // 60} min)")
    say(f"    5. POST {GRAPH}/{page_id}/video_reels  upload_phase=finish, {state}, description=<caption>")
    if not args.go:
        if not problems:
            say("DRY RUN: nothing was sent. Add --go to post it.")
            return 0
        say("DRY RUN: nothing was sent, and --go would refuse until these are fixed:")
        for p in problems:
            say(f"  - {p}")
        return 1
    if problems:
        say("Not posting:", file=sys.stderr)
        for p in problems:
            say(f"  - {p}", file=sys.stderr)
        return 1
    _, token = system_token()
    with ledger_lock(ledger_path):
        # Again under the lock: another run may have posted this video (or
        # others) while this one was checking the file.
        ledger = load_ledger(ledger_path)
        prior = ledger.get(vid) if isinstance(ledger.get(vid), dict) else None
        late = ledger_problems(ledger, vid, page_id, _utcnow(), args.force)
        if late:
            say("Not posting:", file=sys.stderr)
            for p in late:
                say(f"  - {p}", file=sys.stderr)
            return 1
        if prior and prior.get("state") in BLOCKING:
            say(f"--force: posting {vid} again. The earlier reel (Meta video {prior.get('fb_video_id') or '?'}) "
                "stays on the Page unless you delete it there.")
        return publish(Graph(session), token, town, video, args.file, report["size"], caption, when,
                       ledger, ledger_path, prior)


def publish(graph, token, town, video, path, size, caption, when, ledger, ledger_path, prior):
    """The --go half of post: upload, wait, finish, confirm, with the ledger
    written at every step, "pending" just before the finish call, so a crash
    or a lost answer can never lead to a second post."""
    vid, page_id, slug = video["id"], town["page_id"], town["slug"]
    tz = ZoneInfo(town["timezone"])
    entry = {"video": vid, "town": slug, "page_id": page_id, "page_name": town["name"],
             "file": os.path.abspath(path), "file_bytes": size, "caption": caption, "timezone": town["timezone"],
             "video_state": "SCHEDULED" if when else "PUBLISHED", "graph_version": GRAPH_VERSION}
    if when:
        entry.update(scheduled_for_local=when[0].isoformat(), scheduled_for_utc=_iso(when[1]),
                     scheduled_publish_time=int(when[1].timestamp()))
    if prior:
        earlier = {k: v for k, v in prior.items() if k != "previous"}
        entry["previous"] = ((prior.get("previous") or []) + [earlier])[-10:]

    def record(state, **extra):
        entry.update(extra)
        entry.update(state=state, updated_at=_iso(_utcnow()))
        ledger[vid] = entry
        try:
            save_ledger(ledger_path, ledger)
        except OSError as e:
            raise LedgerError(f"couldn't write {ledger_path} ({type(e).__name__})") from None

    def record_quietly(state, **extra):
        try:
            record(state, **extra)
        except PostError as e:
            say(f"warning: {e}", file=sys.stderr)

    stage, fb_id, want = "lookup", "?", "scheduled" if when else "published"
    try:
        page_token, page_name = page_access(graph, page_id, token)
        entry["page_name"] = page_name or town["name"]
        say(f"Page token for {entry['page_name']} ({page_id}) looked up.")
        start = graph.call("POST", f"{page_id}/video_reels", f"POST /{page_id}/video_reels (start)", page_token,
                           data={"upload_phase": "start"})
        fb_id = str(start.get("video_id") or "")
        if not fb_id.isdigit():
            raise PostError(f"POST /{page_id}/video_reels (start): no video id in Meta's answer ({_brief(start)})")
        stage = "upload"
        record("uploading", fb_video_id=fb_id)
        say(f"Upload session started: Meta video {fb_id}.")
        graph.upload(upload_url(start.get("upload_url"), fb_id), path, size, page_token, fb_id)
        say(f"Sent {size:,} bytes; waiting for Meta to take the file.")
        wait_for_upload(graph, fb_id, page_token)
        record("uploaded")
        if when:
            check_window(when[1], _utcnow())  # the upload took time
        record("pending", finished_at=_iso(_utcnow()))
        stage = "finish"
        body = finish(graph, page_id, fb_id, page_token, caption, when[1] if when else None)
        # Meta has the reel: from here on nothing may write it down as failed.
        stage = "finished"
        record(want, post_id=body.get("post_id"), confirmed=False)
        stage = "confirm"
        seen, st = confirm(graph, fb_id, page_token, scheduled=bool(when))
        record(seen or want, confirmed=seen is not None, meta_status=brief_status(st))
    except Unconfirmed as e:
        record_quietly("pending", error=e.as_dict())
        say(f"error: {e}", file=sys.stderr)
        say(f"It may have posted anyway. Run `post_reel.py status --town {slug}`; the ledger keeps {vid} "
            "pending, so posting it again needs --force.", file=sys.stderr)
        return 1
    except LedgerError as e:
        # No second try at writing: whatever the file last held stands, and
        # from "pending" on that already stops a second post.
        say(f"error: {e}", file=sys.stderr)
        if stage in ("finished", "confirm"):
            held = "pending" if stage == "finished" else want
            say(f"Meta took the reel all the same (Meta video {fb_id}). The ledger still has {vid} {held}, so "
                f"it won't be posted twice; fix what stopped the write (a full disk?) and check the reel with "
                f"`post_reel.py status --town {slug}`.", file=sys.stderr)
        else:
            say("Stopped there: nothing more was sent to Meta, and nothing was published.", file=sys.stderr)
        return 1
    except PostError as e:
        # Only Meta's own refusals and failures land here (LedgerError is
        # above): before the finish nothing went public; after it, confirm()
        # raises only for an error Meta's status reports.
        if stage == "confirm":
            record_quietly("error", error=e.as_dict())
        elif stage in ("upload", "finish"):
            record_quietly("failed", error=e.as_dict())
        raise

    if seen == "scheduled":
        at = _time(_phase(st, "publishing_phase").get("publish_time"))
        if at and when and abs((at - when[1]).total_seconds()) > 60:
            say(f"Note: Meta has it for {fmt_both(at, tz)}, not {fmt_both(when[1], tz)}.")
    if entry["state"] == "scheduled":
        say(f"Scheduled: {vid} goes live {fmt_both(when[1], tz)} on {entry['page_name']} (Meta video {fb_id}).")
    else:
        say(f"Published: {vid} on {entry['page_name']} (Meta video {fb_id}).")
    if seen is None:
        say(f"Meta hadn't confirmed it after {CONFIRM_DEADLINE // 60} minutes; check with "
            f"`post_reel.py status --town {slug}`.")
    say(f"Ledger: {ledger_path}")
    return 0


def granted_permissions(graph, token):
    """The token's granted permissions, or None when Meta won't list them
    (a Page token, or a system user that can't read /me/permissions)."""
    try:
        body = graph.call("GET", "me/permissions", "GET /me/permissions", token)
    except PostError:
        return None
    return {str(p.get("permission")) for p in body.get("data") or []
            if isinstance(p, dict) and p.get("status") == "granted"}


def cmd_check(args, session=None):
    name, token = system_token()
    graph = Graph(session)
    try:
        me = graph.call("GET", "me", "GET /me", token, params={"fields": "id,name"})
    except PostError as e:
        say(NO_KEY_HELP if token is NETWORK_KEY and no_key(e) else f"{name} doesn't work: {e}")
        return 1
    say(f"Token: {name}, {me.get('name') or '?'} (id {me.get('id') or '?'})")
    ready = True
    granted = granted_permissions(graph, token)
    if granted is None:
        say("Permissions: Meta won't list them for this token; the Page checks below still show whether it can post.")
    else:
        say("Permissions granted: " + (", ".join(sorted(granted)) or "none"))
        missing_post = [p for p in POSTING if p not in granted]
        missing_insights = [p for p in INSIGHTS if p not in granted]
        say(f"  posting reels ({', '.join(POSTING)}): "
            + ("all granted" if not missing_post else "MISSING " + ", ".join(missing_post)))
        say(f"  insights ({', '.join(INSIGHTS)}): "
            + ("granted" if not missing_insights else "MISSING " + ", ".join(missing_insights)))
        if missing_post or missing_insights:
            say("  To add them: Business settings > System users > your system user > Generate new token, tick "
                f"them, and put the new token where the old one was (META_TOKEN, or the network secret for "
                f"{NETWORK_HOST}).")
        ready = ready and not missing_post
    say("Pages:")
    for slug in [args.town] if args.town else list(towns.TOWNS):
        t = towns.town(slug)
        try:
            page_token, page_name = page_access(graph, t["page_id"], token)
        except PostError as e:
            ready = False
            say(f"  {slug}: Page {t['page_id']}: NO Page token: {e}")
            continue
        try:
            graph.call("GET", f"{t['page_id']}/video_reels", f"GET /{t['page_id']}/video_reels", page_token,
                       params={"limit": "1"})
            reels = "can read its reels"
        except PostError as e:
            reels = f"couldn't read its reels ({e})"
        named = "" if t["name"].lower() in page_name.lower() else f" (towns.py says {t['name']}: is the page_id right?)"
        say(f"  {slug}: {page_name or '?'} ({t['page_id']}): Page token OK, {reels}{named}")
    say("Ready to post reels." if ready else "Not ready to post: fix what's marked above.")
    return 0 if ready else 1


def reel_state(r, tz):
    """'published Sun Oct 25 ...', 'scheduled for ...', 'processing'... for
    one reel as Meta describes it."""
    st = r.get("status") if isinstance(r.get("status"), dict) else {}
    err = phase_error(st)
    if err:
        return f"error ({err})"
    pub = _phase(st, "publishing_phase")
    ps = pub.get("publish_status")
    if r.get("published") is True or ps == "published":
        at = _time(pub.get("publish_time")) or _time(r.get("created_time"))
        return "published" + (f" {fmt_local(at, tz)}" if at else "")
    at = _time(r.get("scheduled_publish_time")) or (_time(pub.get("publish_time")) if ps == "scheduled" else None)
    if ps == "scheduled" or at:
        return "scheduled" + (f" for {fmt_both(at, tz)}" if at else "")
    if ps:
        return ps
    if st.get("video_status"):
        return st["video_status"]
    if r.get("published") is False:
        return "unpublished"
    at = _time(r.get("updated_time"))
    return f"updated {fmt_local(at, tz)}" if at else "state unknown"


def reel_line(r, tz):
    desc = " ".join(str(r.get("description") or "").split())
    if len(desc) > 60:
        desc = desc[:60].rsplit(" ", 1)[0].rstrip(" ,;:.-") + "..."
    link = str(r.get("permalink_url") or "")
    if link.startswith("/"):
        link = "https://www.facebook.com" + link  # Graph gives videos a site-relative permalink
    return f"{r.get('id')}  {reel_state(r, tz)}" + (f'  "{desc}"' if desc else "") + (f"  {link}" if link else "")


def _reels(graph, path, what, token, params):
    """A reels read with REEL_FIELDS, falling back to Meta's default fields
    when this Graph version refuses one of them (#100)."""
    try:
        return graph.call("GET", path, what, token, params={"fields": REEL_FIELDS, **params})
    except PostError as e:
        if e.code != 100 or e.subcode == 33:
            raise
        return graph.call("GET", path, what, token, params=params)


def _ledger_order(item):
    """Ledger entries by when they go (or went) live."""
    vid, e = item
    return e.get("scheduled_for_utc") or e.get("updated_at") or "", vid


def cmd_status(args, session=None):
    ledger_path = args.ledger or LEDGER_PATH
    ledger = load_ledger(ledger_path)
    _, token = system_token()
    graph = Graph(session)
    rc = 0
    for slug in [args.town] if args.town else list(towns.TOWNS):
        t = towns.town(slug)
        tz = ZoneInfo(t["timezone"])
        say(f"{slug}: {t['name']} (Page {t['page_id']})")
        mine = {k: e for k, e in ledger.items() if isinstance(e, dict) and e.get("page_id") == t["page_id"]}
        seen = {}
        page_token = None
        if graph:
            try:
                page_token, _ = page_access(graph, t["page_id"], token)
            except PostError as e:
                if token is NETWORK_KEY and str(e).startswith(NO_KEY_HELP):
                    # No key anywhere: the ledger is all there is to show, for
                    # every town, without asking Meta four more times.
                    graph = None
                    say(f"  {NO_KEY_HELP} Showing the local ledger only.")
                else:
                    rc = 1
                    say(f"  Couldn't read the Page: {e}")
        if page_token:
            listed = True
            try:
                reels = [r for r in _reels(graph, f"{t['page_id']}/video_reels", f"GET /{t['page_id']}/video_reels",
                                           page_token, {"limit": "10"}).get("data") or [] if isinstance(r, dict)]
                say("  On the Page, newest first:" if reels else "  No reels on the Page yet.")
                for r in reels:
                    seen[str(r.get("id"))] = r
                    say(f"    {reel_line(r, tz)}")
            except PostError as e:
                rc, listed = 1, False
                say(f"  Couldn't list the Page's reels: {e}")
            # Scheduled reels may not be listed, and the Page video_reels
            # reference says that edge can't be read at all (the guide says it
            # can): ask for ours by id either way, a pending one most of all.
            ours = [str(e["fb_video_id"]) for e in mine.values() if e.get("fb_video_id")]
            extra = [i for i in dict.fromkeys(ours) if i not in seen]
            if extra:
                say("  Ours, not in that list (scheduled or unpublished):" if listed else "  Ours, by id:")
            for i in extra:
                try:
                    r = _reels(graph, i, f"GET /{i}", page_token, {})
                    seen[i] = r
                    say(f"    {reel_line(r, tz)}")
                except PostError as e:
                    say(f"    {i}: couldn't read it ({e})")
        say("  Ledger:" if mine else "  Ledger: nothing posted from here yet.")
        for k, e in sorted(mine.items(), key=_ledger_order):
            at = _time(e.get("scheduled_for_utc"))
            line = f"    {k}  {e.get('state')}" + (f" for {fmt_both(at, tz)}" if at else "")
            line += f"  Meta video {e.get('fb_video_id') or '-'}"
            meta = seen.get(str(e.get("fb_video_id")))
            if meta is not None:
                line += f"  [Meta: {reel_state(meta, tz)}]"
            if e.get("error"):
                line += f"  ({e['error'].get('message') if isinstance(e['error'], dict) else e['error']})"
            say(line)
    return rc


def main(argv=None, session=None):
    ap = argparse.ArgumentParser(prog="post_reel.py", description="Post subscribe videos as Facebook Reels.")
    sub = ap.add_subparsers(dest="command", required=True)
    c = sub.add_parser("check", help="the token's permissions and each town's Page token")
    c.add_argument("--town", choices=list(towns.TOWNS))
    p = sub.add_parser("post", help="post (or, without --go, dry-run) one video")
    p.add_argument("file", metavar="VIDEO.mp4")
    p.add_argument("--video", required=True, metavar="ID", help="scripts.json id, e.g. victoria-1")
    when = p.add_mutually_exclusive_group()
    when.add_argument("--now", action="store_true", help="publish right away instead of scheduling")
    when.add_argument("--at", metavar="YYYY-MM-DDTHH:MM", help="town time; default the video's post_at_local")
    p.add_argument("--go", action="store_true", help="really post; without it nothing is sent")
    p.add_argument("--caption", metavar="TEXT", help="instead of scripts.json's caption")
    p.add_argument("--force", action="store_true", help="post again although the ledger has it")
    p.add_argument("--allow-draft", action="store_true", help="post a video scripts.json still marks draft")
    p.add_argument("--ledger", help=argparse.SUPPRESS)
    s = sub.add_parser("status", help="the Pages' recent and scheduled reels, and the ledger")
    s.add_argument("--town", choices=list(towns.TOWNS))
    s.add_argument("--ledger", help=argparse.SUPPRESS)
    args = ap.parse_args(argv)
    try:
        return {"check": cmd_check, "post": cmd_post, "status": cmd_status}[args.command](args, session)
    except PostError as e:
        say(f"error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
