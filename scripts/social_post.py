#!/usr/bin/env python3
"""Post the social kit to the Facebook Page and Instagram account.

Runs on the town's jobs worker (scripts/jobs_worker.py) after the kit is on
the site, and only when SOCIAL_AUTOPOST is 1 on the jobs service. Monday
posts "this week", Thursday posts "this weekend" (as a Reel on Instagram
when the kit has one; Reels reach people who don't follow us yet), and
the other days post "today". Thursday also posts "today" when it has a
Vic's Pick (--if-featured), so a paid pick that day is always posted.

Needs (the jobs service's variables, with META_TOWN; town.py meta_allowed):
  META_PAGE_ID        Facebook Page id
  META_PAGE_TOKEN     a Page access token, or a system-user token with the
                      Page assigned (the Page's own token is looked up);
                      pages_show_list, pages_read_engagement,
                      pages_manage_posts (+ instagram_basic,
                      instagram_content_publish for Instagram)
  IG_USER_ID          Instagram business account id linked to the Page
                      (optional; Facebook still posts without it)

Instagram fetches images by URL, so the slides must be live on
the town's site first; we wait for them before posting. Instagram only
accepts JPEG there, so it gets the kit's .jpg twins (slides_jpg).
"""
import argparse
import json
import os
import re
import sys
import time

import requests

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from town import TOWN, meta_allowed, site_url, tz, town_paths  # noqa: E402  (repo root; TOWN unset = Victoria)

SITE = site_url()
# One place for the Graph API version. The GRAPH_API_VERSION repo variable
# (passed in social-kit.yml) overrides it, so moving off a version Meta
# retires needs no code change; empty (variable unset) means the default.
GRAPH_VERSION = os.environ.get("GRAPH_API_VERSION", "").strip() or "v23.0"
GRAPH_VERSION = GRAPH_VERSION if GRAPH_VERSION.startswith("v") else f"v{GRAPH_VERSION}"
GRAPH = f"https://graph.facebook.com/{GRAPH_VERSION}"
# Meta errors worth another try: rate limits (4, 17, 341), "unknown/
# temporary" (1, 2), and Instagram failing to fetch the image (9004, 9007),
# plus anything flagged is_transient or a 5xx. Without a retry one blip
# fails the day's post, and the cron fallback skips itself because the
# site's scheduler already ran the job.
TRANSIENT_CODES = {1, 2, 4, 17, 341, 9004, 9007}
RETRY_DELAYS = (5, 20)  # seconds; bounded so the post step stays well inside its timeout
KIT_DIR = os.path.join(os.path.dirname(__file__), "..", *town_paths()["social"].strip("/").split("/"))
MAX_CAROUSEL = 10  # Instagram's carousel limit (Facebook allows more, but keep them in sync)


class PostError(RuntimeError):
    pass


class Unconfirmed(PostError):
    """The final publish call timed out after Meta got it: the post may or
    may not exist. Never retried automatically (it could post twice)."""


class StateNotSaved(PostError):
    """on_save (the jobs worker storing posted.json on the site) failed:
    nothing is published without its "pending" mark saved first."""


class _SentButNoAnswer(PostError):
    """A POST timed out waiting for the answer: Meta may have acted on it."""


class _Transient(PostError):
    """An error Meta says to retry (see TRANSIENT_CODES)."""


class _NotSent(_Transient):
    """The connection never opened (connect timeout): Meta can't have acted."""


def version_problem(err):
    """A message naming the Graph version when Meta refuses it (retired or
    unknown), or None. Otherwise it reads like a token problem."""
    if not isinstance(err, dict):
        return None
    msg = str(err.get("message") or "")
    if err.get("code") in (12, 2635) or re.search(r"(deprecated|unsupported|unknown|invalid)\W+(api\W+)?version",
                                                  msg, re.I):
        return (f"Meta refused Graph API {GRAPH_VERSION} (retired or unsupported?). Set the "
                f"GRAPH_API_VERSION repo variable to a current version, e.g. v24.0.")
    return None


PENDING = "pending"  # posted.json marker for an Unconfirmed post


def pick_slides(slides, limit=MAX_CAROUSEL):
    """Cover first and the call-to-action last; day slides in between."""
    if len(slides) <= limit:
        return list(slides)
    return [slides[0]] + list(slides[1:limit - 1]) + [slides[-1]]


def _graph(method, path, session, _retry=True, **params):
    """One Graph call. Calls safe to repeat (unpublished photo uploads,
    container creates, status reads) are retried on transient errors; a
    repeat only leaves an unused photo or container behind. _publish passes
    _retry=False: a second publish could post twice."""
    for delay in (RETRY_DELAYS if _retry else ()) + (None,):
        try:
            return _graph_once(method, path, session, dict(params))
        except (_Transient, _SentButNoAnswer) as e:
            if delay is None:
                raise
            print(f"{e}; retrying in {delay}s")
            time.sleep(delay)


def _graph_once(method, path, session, params):
    # GET parameters go in the query string; Graph ignores a GET body, so
    # the fields would never arrive. The token goes in a header instead, so
    # it never shows up in a URL (requests puts the URL in its errors).
    if method == "GET":
        token = params.pop("access_token", None)
        where = {"params": params}
        if token:
            where["headers"] = {"Authorization": f"Bearer {token}"}
    else:
        where = {"data": params}
    try:
        r = session.request(method, f"{GRAPH}/{path}", timeout=60, **where)
    except requests.RequestException as e:
        # Only the error type: the message can carry the URL. `from None`
        # keeps the original out of any traceback too.
        if isinstance(e, requests.ConnectTimeout):
            cls = _NotSent
        elif isinstance(e, requests.ReadTimeout) and method == "POST":
            cls = _SentButNoAnswer
        else:
            cls = _Transient
        raise cls(f"{method} {path} failed: {type(e).__name__}") from None
    try:
        body = r.json()
    except ValueError:
        body = {"raw": r.text[:300]}
    if r.status_code >= 400 or (isinstance(body, dict) and body.get("error")):
        err = body.get("error", body) if isinstance(body, dict) else body
        problem = version_problem(err)
        if problem:
            raise PostError(problem)
        transient = r.status_code >= 500 or isinstance(err, dict) and (
            err.get("is_transient") is True or err.get("code") in TRANSIENT_CODES
            or err.get("error_subcode") in TRANSIENT_CODES)
        raise (_Transient if transient else PostError)(f"{method} {path} failed: {json.dumps(err)[:300]}")
    return body


def wait_for_deploy(urls, kit_url, generated_for, session, timeout_s=600, sleep=15, build=None):
    """Wait until the deployed kit.json is this run's kit and the images load.

    `build` (unique per run) beats the date: an earlier kit from the same day
    has the same `generated_for` but older slides."""
    deadline = time.time() + timeout_s
    while True:
        try:
            live = session.get(kit_url, timeout=20)
            body = live.json() if live.ok else {}
            same = body.get("build") == build if build else body.get("generated_for") == generated_for
            if live.ok and same \
                    and all(session.head(u, timeout=20).ok for u in urls):
                return True
        except (requests.RequestException, ValueError):
            pass
        if time.time() >= deadline:
            raise PostError("Slides never appeared on the live site; not posting.")
        time.sleep(sleep)


def post_facebook(page_id, token, image_urls, caption, session, before_publish=None):
    """Upload photos unpublished, then one feed post with all of them attached."""
    media = []
    for url in image_urls:
        photo = _graph("POST", f"{page_id}/photos", session, url=url, published="false", access_token=token)
        media.append({"media_fbid": photo["id"]})
    params = {"message": caption, "access_token": token}
    for i, m in enumerate(media):
        params[f"attached_media[{i}]"] = json.dumps(m)
    return _publish(f"{page_id}/feed", session, before_publish, **params)


def _publish(path, session, before_publish=None, **params):
    """The call that makes the post live. A read timeout, a dropped
    connection, a 5xx or an error Meta flags transient here means Meta may
    have posted it anyway (a 500 {code: 2} can come back after the post was
    made), so it's Unconfirmed and the slot stays pending; only a clear
    refusal (4xx) or a connection that never opened is a plain failure.
    Any earlier error only left unpublished photos or containers behind.
    before_publish runs first (main marks the slot pending on disk), so a
    run killed during this call (cancel, step timeout) can't post twice."""
    if before_publish:
        before_publish()
    try:
        return _graph("POST", path, session, _retry=False, **params)["id"]
    except _NotSent:
        raise
    except (_SentButNoAnswer, _Transient) as e:
        raise Unconfirmed(str(e)) from None


def post_instagram(ig_user_id, token, image_urls, caption, session, poll_sleep=5, before_publish=None):
    """Carousel: one container per image, a carousel container, then publish."""
    children = []
    for url in image_urls:
        item = _graph("POST", f"{ig_user_id}/media", session,
                      image_url=url, is_carousel_item="true", access_token=token)
        children.append(item["id"])
    carousel = _graph("POST", f"{ig_user_id}/media", session, media_type="CAROUSEL",
                      children=",".join(children), caption=caption, access_token=token)
    # Instagram processes containers asynchronously; publish once FINISHED.
    for _ in range(24):
        status = _graph("GET", carousel["id"], session, fields="status_code", access_token=token)
        if status.get("status_code") == "FINISHED":
            break
        if status.get("status_code") == "ERROR":
            raise PostError("Instagram could not process the carousel.")
        time.sleep(poll_sleep)
    else:
        raise PostError("Instagram was still processing the carousel after 2 minutes.")
    return _publish(f"{ig_user_id}/media_publish", session, before_publish,
                    creation_id=carousel["id"], access_token=token)


def post_instagram_reel(ig_user_id, token, video_url, caption, session, poll_sleep=10, before_publish=None):
    """Reel: one video container (also shown in the feed), then publish."""
    item = _graph("POST", f"{ig_user_id}/media", session, media_type="REELS", video_url=video_url,
                  caption=caption, share_to_feed="true", access_token=token)
    # Video takes longer to process than photos.
    for _ in range(36):
        status = _graph("GET", item["id"], session, fields="status_code", access_token=token)
        if status.get("status_code") == "FINISHED":
            break
        if status.get("status_code") == "ERROR":
            raise PostError("Instagram could not process the Reel.")
        time.sleep(poll_sleep)
    else:
        raise PostError("Instagram was still processing the Reel after 6 minutes.")
    return _publish(f"{ig_user_id}/media_publish", session, before_publish,
                    creation_id=item["id"], access_token=token)


def page_token(page_id, token, session):
    """The Page's own access token. Posting photos needs it ("Unpublished
    posts must be posted to a page as the page itself"); a system-user or
    user token with access to the Page can look it up, so META_PAGE_TOKEN may
    hold either. A token that's already the Page's is returned as is."""
    try:
        body = _graph("GET", page_id, session, fields="access_token", access_token=token)
    except PostError as e:
        print(f"Couldn't look up the Page token ({e}); posting with META_PAGE_TOKEN as given.")
        return token
    return body.get("access_token") or token


def main(argv=None, session=None, on_save=None):
    """on_save(posted): called after every write of posted.json with its
    contents. The jobs worker (scripts/jobs_worker.py) stores it on the
    town's site, so a retried or restarted job never posts twice; when it
    raises, the post that was about to go out doesn't."""
    ap = argparse.ArgumentParser()
    ap.add_argument("--kind", choices=["week", "weekend", "today"], required=True)
    ap.add_argument("--kit-dir", default=KIT_DIR)
    ap.add_argument("--no-wait", action="store_true", help="Skip waiting for the deploy (testing)")
    ap.add_argument("--if-featured", action="store_true",
                    help="Only post when the kit has a Vic's Pick (Thursday's extra 'today' post)")
    args = ap.parse_args(argv)
    session = session or requests.Session()

    if not meta_allowed():
        print(f"These Meta settings aren't {TOWN['id']}'s own (META_TOWN and the page and Instagram ids its town.json pins); not posting.")
        return 0
    page_id = os.environ.get("META_PAGE_ID", "").strip()
    token = os.environ.get("META_PAGE_TOKEN", "").strip()
    ig_user = os.environ.get("IG_USER_ID", "").strip()
    if not page_id or not token:
        print("META_PAGE_ID / META_PAGE_TOKEN not set; skipping auto-post.")
        return 0

    with open(os.path.join(args.kit_dir, "kit.json")) as f:
        manifest = json.load(f)
    kit = manifest["kits"][args.kind]
    if not kit.get("events"):
        print(f"No events in the {args.kind} kit; not posting an empty list.")
        return 0
    if args.if_featured and not kit.get("featured"):
        print(f"No {TOWN['pick_name_plain']} in the {args.kind} kit; nothing extra to post.")
        return 0

    looked_up = page_token(page_id, token, session)
    if looked_up != token and os.environ.get("GITHUB_ACTIONS"):
        # GitHub only masks the secret it was given; hide the Page's own
        # token in the log too.
        print(f"::add-mask::{looked_up}")
    token = looked_up
    base = f"{SITE}/social/latest"
    urls = [f"{base}/{name}" for name in pick_slides(kit["slides"])]
    # Instagram takes JPEG only; an older kit without the twins gets the PNGs.
    ig_urls = [f"{base}/{name}" for name in pick_slides(kit.get("slides_jpg") or kit["slides"])]
    reel_url = f"{base}/{kit['reel']}" if kit.get("reel") else None
    if not args.no_wait:
        wait_for_deploy(list(dict.fromkeys(urls + ig_urls)) + ([reel_url] if reel_url else []), f"{base}/kit.json",
                        manifest["generated_for"], session, build=manifest.get("build"))
    if manifest.get("build"):
        # Cache-bust so Meta can't fetch yesterday's image at the same name.
        v = f"?v={manifest['build']}"
        urls = [u + v for u in urls]
        ig_urls = [u + v for u in ig_urls]
        reel_url = reel_url and reel_url + v

    # Posted ids per day + kind, so re-running a half-failed job doesn't post
    # the same thing to Facebook twice.
    posted_path = os.path.join(args.kit_dir, "posted.json")
    try:
        with open(posted_path) as f:
            posted = json.load(f)
    except (OSError, ValueError):
        posted = {}
    slot_key = f"{manifest['generated_for']}:{args.kind}"
    slot = posted.setdefault(slot_key, {})

    def remember(platform, post_id):
        slot[platform] = post_id
        remember_all()

    def remember_all():
        # Keep two weeks of history.
        for k in sorted(posted)[:-30]:
            posted.pop(k, None)
        with open(posted_path, "w") as f:
            json.dump(posted, f, indent=2)
        if on_save:
            try:
                on_save(posted)
            except Exception as e:  # noqa: BLE001 - any failure to store it stops the post
                raise StateNotSaved(f"couldn't save what was posted ({type(e).__name__}: {e})") from None

    failures = []
    where_posted = "the site's social_posted file (RAILWAY.md)" if on_save else "docs/social/latest/posted.json"

    def already(label, platform):
        """True (and says why) when this slot shouldn't be posted again."""
        if slot.get(platform) == PENDING:
            print(f"::warning::{label}: an earlier run timed out publishing {slot_key} and may have posted it. "
                  f"Not posting again; check the {label} account by hand, and to retry remove "
                  f'"{platform}" under "{slot_key}" in {where_posted}.')
            return True
        if slot.get(platform):
            print(f"{label}: already posted {slot[platform]} for {slot_key}; skipping.")
            return True
        return False

    def failed(label, platform, e):
        if isinstance(e, StateNotSaved):
            # Whatever the site last stored stands (a "pending" mark keeps
            # re-runs off this platform); nothing more is written now.
            failures.append(f"{label}: {e}")
            return
        if isinstance(e, Unconfirmed):
            try:
                remember(platform, PENDING)
            except StateNotSaved:
                pass  # saved as "pending" just before the publish call already
            failures.append(f"{label}: {e}; it may have posted anyway. Check {label} by hand; "
                            f"re-runs skip it until \"{platform}\" is removed from posted.json.")
        else:
            # Meta answered with an error: nothing posted, so drop this
            # run's pending mark and let a re-run try again.
            if slot.get(platform) == PENDING:
                slot.pop(platform)
                try:
                    remember_all()
                except StateNotSaved:
                    pass  # the stored "pending" stays: safe, a person clears it
            failures.append(f"{label}: {e}")

    def pending(platform):
        # Written to disk just before the publish call. If the job is
        # cancelled or times out mid-call, the always() save step commits
        # this, and re-runs warn instead of posting a second time.
        return lambda: remember(platform, PENDING)

    if not already("Facebook", "facebook"):
        try:
            fb_id = post_facebook(page_id, token, urls, kit["captions"]["facebook"], session,
                                  before_publish=pending("facebook"))
            remember("facebook", fb_id)
            print(f"Facebook: posted {fb_id}")
        except PostError as e:
            failed("Facebook", "facebook", e)
    if not ig_user:
        # Facebook only is how every town runs today, not a fault.
        print("IG_USER_ID not set; skipping Instagram (Facebook only).")
    elif not already("Instagram", "instagram"):
        try:
            ig_id = None
            if reel_url:
                try:
                    ig_id = post_instagram_reel(ig_user, token, reel_url, kit["captions"]["instagram"], session,
                                                before_publish=pending("instagram"))
                    print(f"Instagram: posted Reel {ig_id}")
                except Unconfirmed:
                    raise  # may be live already: posting the carousel too could double up
                except PostError as e:
                    # Processing ERROR, a 6-minute timeout or a refused
                    # publish: nothing went out, and the kit has the
                    # carousel, so post that instead of nothing.
                    print(f"::warning::Instagram Reel failed ({e}); posting the carousel instead.")
            if ig_id is None:
                ig_id = post_instagram(ig_user, token, ig_urls, kit["captions"]["instagram"], session,
                                       before_publish=pending("instagram"))
                print(f"Instagram: posted {ig_id}")
            remember("instagram", ig_id)
        except PostError as e:
            failed("Instagram", "instagram", e)

    for f in failures:
        print(f"::error::{f}")
    if any(GRAPH_VERSION in f and "GRAPH_API_VERSION" in f for f in failures):
        # social-kit.yml's Slack alert says this instead of its generic text.
        set_output("alert", f"🚨 Social posts failed: Meta refused Graph API {GRAPH_VERSION}. "
                            "Set the GRAPH_API_VERSION repo variable to a current version.")
    return 1 if failures else 0


def set_output(name, value):
    """A step output for the workflow (single line), when run in Actions."""
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a") as f:
            f.write(f"{name}={value.replace(chr(10), ' ')}\n")


if __name__ == "__main__":
    sys.exit(main())
