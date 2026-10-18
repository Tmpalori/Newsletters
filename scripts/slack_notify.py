#!/usr/bin/env python3
"""Post a one-line message to Slack from a GitHub Actions step.

Reads SLACK_WEBHOOK_URL (repo secret). Unset means do nothing, and a Slack
hiccup (timeout, 5xx) never fails the job: a notification must not turn a
green run red. A refused webhook (archived channel, removed app: HTTP
403/404/410 or no_service, channel_is_archived, ...) exits 2 instead, since
every later alert would vanish too; the red run makes GitHub email the owner.

    python3 scripts/slack_notify.py "🚨 Weekly collect failed" [--link URL]

The text is sent as mrkdwn as given, so callers can include links; run
anything that came from outside (event names, AI text) through escape().
"""
import json
import os
import sys
import urllib.error
import urllib.request

# Slack's answers meaning the webhook is dead, not busy (same list as
# REFUSED_* in server/slack.js).
REFUSED_STATUSES = {403, 404, 410}
REFUSED_ERRORS = {"no_service", "channel_is_archived", "channel_not_found", "invalid_token",
                  "action_prohibited", "no_active_hooks", "team_disabled"}


def escape(text):
    """Text safe to drop into Slack mrkdwn: &, < and > are control characters
    there (a name like "Fest <!channel>" would ping everyone or break a
    link), so they go as entities. Same as slackEscape in server/slack.js."""
    return str(text if text is not None else "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def town_tag(env=None):
    """SLACK_TOWN_TAG when set (the workflows pass vars.SLACK_TOWN_TAG for
    another town). Without one every town, Victoria included, is tagged
    with its city, so posts in the shared channels always say which town."""
    env = os.environ if env is None else env
    tag = env.get("SLACK_TOWN_TAG", "").strip()
    slug = env.get("TOWN", "").strip().lower()
    if tag:
        return tag
    try:
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
        import town as town_mod
        return town_mod.town_config(env)["city"]
    except Exception:  # noqa: BLE001 - an alert must still go out, tagged with the slug
        return slug


def report_to_site(text, link, slack_delivered, env=None, fyi=False):
    """Also tell the site, so the alert lands in the owner inbox (HQ and the
    owner's assistant read it; server/opsReport.js). Only steps that send an
    alert set OPS_REPORT_URL (the site) and OPS_REPORT_SECRET. When Slack
    didn't take the message, the site posts it there too. Best effort: the
    site may be the thing that's down (HQ notices that on its own).
    fyi: a report, not an alert (the event check's list): saved to the
    inbox as fyi, never posted to Slack by the site, and up to 4,000
    characters. True when the site took it."""
    env = os.environ if env is None else env
    site = env.get("OPS_REPORT_URL", "").strip().rstrip("/")
    secret = env.get("OPS_REPORT_SECRET", "").strip()
    if not site.startswith("https://") or not secret:
        return False
    first, _, rest = text.partition("\n")
    # OPS_ALREADY_IN_SLACK: the step showed it in Slack another way.
    delivered = bool(slack_delivered) or env.get("OPS_ALREADY_IN_SLACK") == "1"
    body = {"title": first[:200], "text": rest[:4000 if fyi else 2000], "link": link, "slack_delivered": delivered}
    if fyi:
        body["fyi"] = True
    req = urllib.request.Request(f"{site}/api/ops/report", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "X-Ops-Secret": secret})
    try:
        urllib.request.urlopen(req, timeout=15).read()
        return True
    except Exception as e:  # noqa: BLE001 - best effort by design
        print(f"Couldn't report to the site ({site}): {e}")
        return False


def main(argv):
    args = list(argv)
    link = None
    if "--link" in args:
        i = args.index("--link")
        link = args[i + 1] if i + 1 < len(args) else None
        del args[i:i + 2]
    raw = " ".join(args).strip() or "(no message)"
    rc, delivered = post_to_slack(raw, link)
    report_to_site(raw, link, delivered)
    return rc


def post_to_slack(text, link):
    """(exit code, whether Slack took it)."""
    url = os.environ.get("SLACK_WEBHOOK_URL", "").strip()
    if not url.startswith("https://hooks.slack.com/"):
        print("SLACK_WEBHOOK_URL not set; skipping Slack notification.")
        return 0, False
    # SLACK_TOWN_TAG: "[Bay City] " first, so towns can share channels
    # (MULTI_CITY_PLAN.md 4.3, same as server/slack.js). Unset: the town's
    # city (town_tag).
    tag = town_tag()
    if tag:
        text = f"[{escape(tag)}] {text}"
    if link:
        text += f" <{link}|Open>"
    req = urllib.request.Request(url, data=json.dumps({"text": text}).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=15).read()
        return 0, True
    except urllib.error.HTTPError as e:
        try:
            error = e.read().decode("utf-8", "replace").strip()[:100]
        except Exception:  # noqa: BLE001 - the body is only a detail
            error = ""
        if e.code in REFUSED_STATUSES or error in REFUSED_ERRORS:
            print(f"::error::Slack refused the webhook (HTTP {e.code} {error}). The channel may be archived "
                  "or the Slack app removed; alerts are not arriving. Make a new incoming webhook and "
                  "update the SLACK_*_WEBHOOK_URL secret.")
            return 2, False
        print(f"Slack notification failed: HTTP {e.code} {error}")
    except Exception as e:  # noqa: BLE001 - best effort by design
        print(f"Slack notification failed: {e}")
    return 0, False


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
