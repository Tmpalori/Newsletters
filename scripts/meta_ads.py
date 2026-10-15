#!/usr/bin/env python3
"""Read and manage The Vic 361's Meta ads (Marketing API).

Runs from .github/workflows/meta-ads.yml, so the token never leaves GitHub:

  status            what's running, its delivery/review state, and results
                    (today, yesterday, last 7 days); also checks the token
  report            yesterday + last 7 days to Slack (the daily run); quiet
                    when nothing has spent in the last 7 days and nothing
                    is on, else says so (a disabled account, a rejected ad
                    or an ad that's on but spent $0)
  pause  <id>       pause a campaign, ad set or ad
  resume <id>       turn it back on
  budget <id> <$>   set an ad set's (or campaign's) daily budget, in dollars;
                    refuses more than MAX_DAILY_BUDGET unless --force

Needs (GitHub Actions):
  META_ADS_TOKEN      a system-user token with ads_read (+ ads_management to
                      change anything) and the ad account assigned to that
                      system user; falls back to META_PAGE_TOKEN
  META_AD_ACCOUNT_ID  repo variable, e.g. act_123 (optional when the token
                      sees exactly one ad account)
  ADS_SPEND_SECRET    optional: the daily report also sends the last 30 days'
                      spend per day to the site (Admin → Growth) and adds the
                      real cost per subscriber, from the site's own count, to
                      the Slack report. Same value as Railway's ADS_SPEND_SECRET
                      (meta-ads.yml falls back to SUBMISSION_REVIEW_SECRET).

The token goes in the Authorization header, never a URL, and errors never
include it.
"""
import argparse
import datetime as dt
import os
import re
import sys
from zoneinfo import ZoneInfo

import requests

sys.path.insert(0, os.path.dirname(__file__))
import slack_notify  # noqa: E402
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from town import TOWN, meta_allowed, site_url  # noqa: E402

# One place for the Graph/Marketing API version. The GRAPH_API_VERSION repo
# variable (passed in meta-ads.yml) overrides it, so moving off a version
# Meta retires needs no code change; empty (variable unset) means the default.
GRAPH_VERSION = os.environ.get("GRAPH_API_VERSION", "").strip() or "v23.0"
GRAPH_VERSION = GRAPH_VERSION if GRAPH_VERSION.startswith("v") else f"v{GRAPH_VERSION}"
GRAPH = f"https://graph.facebook.com/{GRAPH_VERSION}"
MAX_DAILY_BUDGET = 50  # dollars; a typo like 1000 shouldn't go live
SITE = site_url()
CENTRAL = ZoneInfo(TOWN["timezone"])  # the town's zone (Central for Victoria)
NEEDS = ("ads_read", "ads_management")


class AdsError(RuntimeError):
    pass


class VersionRetired(AdsError):
    """Meta refused the API version (#2635 once the Marketing API retires
    it). Named as such: otherwise the alert reads like a token problem."""


class NotSetUp(AdsError):
    """Ads were never set up (the token sees no ad account and none is
    named), so the daily run has nothing to report rather than a fault."""


class Api:
    def __init__(self, token, session=None):
        self.token = token
        self.s = session or requests.Session()

    def call(self, method, path, **params):
        headers = {"Authorization": f"Bearer {self.token}"}
        where = {"params": params} if method == "GET" else {"data": params}
        try:
            r = self.s.request(method, f"{GRAPH}/{path}", headers=headers, timeout=60, **where)
        except requests.RequestException as e:
            raise AdsError(f"{method} {path} failed: {type(e).__name__}") from None
        try:
            body = r.json()
        except ValueError:
            body = {}
        if r.status_code >= 400 or (isinstance(body, dict) and body.get("error")):
            err = body.get("error", {}) if isinstance(body, dict) else {}
            if err.get("code") in (12, 2635) or re.search(
                    r"(deprecated|unsupported|unknown|invalid)\W+(api\W+)?version", str(err.get("message") or ""), re.I):
                raise VersionRetired(f"Meta refused API {GRAPH_VERSION} (retired or unsupported?). Set the "
                                     "GRAPH_API_VERSION repo variable to a current version, e.g. v24.0.")
            raise AdsError(f"{method} {path} failed: {err.get('message') or f'HTTP {r.status_code}'}")
        return body

    def all(self, path, **params):
        """Every page of a list edge (small accounts: a page or two)."""
        out, after = [], None
        for _ in range(20):
            body = self.call("GET", path, **params, **({"after": after} if after else {}))
            out += body.get("data") or []
            after = ((body.get("paging") or {}).get("cursors") or {}).get("after")
            if not after or not (body.get("paging") or {}).get("next"):
                break
        return out


def granted_scopes(api):
    """Permissions on the token, or None if Meta won't say (system users
    can't always read /me/permissions)."""
    try:
        return {p["permission"] for p in api.all("me/permissions") if p.get("status") == "granted"}
    except AdsError:
        return None


def find_account(api, wanted=""):
    accounts = api.all("me/adaccounts", fields="id,name,account_status,currency")
    if wanted:
        wanted = wanted if wanted.startswith("act_") else f"act_{wanted}"
        hit = [a for a in accounts if a["id"] == wanted]
        if hit:
            return hit[0], accounts
        # Not in the list (e.g. no access via this route): try it directly.
        try:
            return api.call("GET", wanted, fields="id,name,account_status,currency"), accounts
        except VersionRetired:
            raise
        except AdsError:
            raise AdsError(f"The token can't see ad account {wanted}. In Business settings → System users, "
                           "assign that ad account to the system user (Manage ad account).") from None
    if len(accounts) == 1:
        return accounts[0], accounts
    if not accounts:
        raise NotSetUp("The token sees no ad accounts. In Business settings → System users → your system user → "
                       "Assign assets → Ad accounts, give it the ad account (Manage ad account), and make sure "
                       "the token has ads_read and ads_management.")
    names = ", ".join(f"{a.get('name')} ({a['id']})" for a in accounts)
    raise AdsError(f"The token sees several ad accounts: {names}. Set the META_AD_ACCOUNT_ID repo variable.")


def money(cents_or_dollars, cents=True):
    if cents_or_dollars in (None, ""):
        return "—"
    v = float(cents_or_dollars) / (100 if cents else 1)
    return f"${v:,.2f}"


def action(row, kind):
    for a in row.get("actions") or []:
        if a.get("action_type") == kind:
            return int(float(a.get("value") or 0))
    return 0


INSIGHT_FIELDS = "spend,impressions,reach,frequency,inline_link_clicks,inline_link_click_ctr,actions"


def summarize(row):
    """One line of numbers from an insights row (or an empty one)."""
    spend = float(row.get("spend") or 0)
    lpv = action(row, "landing_page_view")
    clicks = int(float(row.get("inline_link_clicks") or 0))
    leads = action(row, "lead") or action(row, "offsite_conversion.fb_pixel_lead")
    parts = [f"${spend:,.2f} spent", f"{int(float(row.get('reach') or 0)):,} people reached",
             f"{clicks:,} link clicks ({float(row.get('inline_link_click_ctr') or 0):.2f}% CTR)",
             f"{lpv:,} landing page views" + (f" (${spend / lpv:,.2f} each)" if lpv else ""),
             f"frequency {float(row.get('frequency') or 0):.2f}"]
    if leads:
        parts.append(f"{leads} signups (${spend / leads:,.2f} each)")
    return spend, ", ".join(parts)


def insights(api, account_id, preset):
    rows = api.call("GET", f"{account_id}/insights", fields=INSIGHT_FIELDS, date_preset=preset, level="account").get("data") or []
    return rows[0] if rows else {}


def structure(api, account_id):
    fields = "id,name,effective_status"
    # stop_time / end_time: a finished campaign or ad set (and its ads) keeps
    # reading ACTIVE in the API ("Completed" is only an Ads Manager label),
    # so the end date is how running_ads tells it has stopped.
    campaigns = api.all(f"{account_id}/campaigns", fields=fields + ",objective,daily_budget,stop_time")
    adsets = api.all(f"{account_id}/adsets", fields=fields + ",campaign_id,daily_budget,optimization_goal,end_time")
    ads = api.all(f"{account_id}/ads", fields=fields + ",adset_id,ad_review_feedback,created_time")
    return campaigns, adsets, ads


LIVE = {"ACTIVE", "IN_PROCESS", "PENDING_REVIEW", "WITH_ISSUES", "DISAPPROVED", "PREAPPROVED", "PENDING_BILLING_INFO"}


def status_lines(campaigns, adsets, ads):
    lines = []
    for c in campaigns:
        if c.get("effective_status") not in LIVE | {"PAUSED", "CAMPAIGN_PAUSED"}:
            continue  # archived/deleted
        lines.append(f"• Campaign *{c['name']}* ({c['id']}): {c['effective_status'].lower()}, "
                     f"{c.get('objective', '').replace('OUTCOME_', '').lower()}"
                     + (f", {money(c.get('daily_budget'))}/day" if c.get("daily_budget") else ""))
        for s in [s for s in adsets if s.get("campaign_id") == c["id"]]:
            lines.append(f"   ◦ Ad set *{s['name']}* ({s['id']}): {s['effective_status'].lower()}"
                         + (f", {money(s.get('daily_budget'))}/day" if s.get("daily_budget") else "")
                         + (f", goal {s.get('optimization_goal', '').lower()}" if s.get("optimization_goal") else ""))
            for a in [a for a in ads if a.get("adset_id") == s["id"]]:
                review = a.get("ad_review_feedback") or {}
                why = "; ".join(f"{k}: {v}" for k, v in (review.get("global") or {}).items())
                lines.append(f"      ▪ Ad *{a['name']}* ({a['id']}): {a['effective_status'].lower()}" + (f" ({why})" if why else ""))
    return lines or ["• No campaigns yet."]


def cmd_status(api, account, out):
    scopes = granted_scopes(api)
    if scopes is not None:
        missing = [p for p in NEEDS if p not in scopes]
        out.append("Token permissions: " + ("ads_read and ads_management ✓" if not missing
                                            else f"missing {', '.join(missing)} (add them and generate a new token)"))
    out.append(f"Ad account: {account.get('name')} ({account['id']}), {account.get('currency', '')}")
    campaigns, adsets, ads = structure(api, account["id"])
    out += status_lines(campaigns, adsets, ads)
    for label, preset in [("Today", "today"), ("Yesterday", "yesterday"), ("Last 7 days", "last_7d")]:
        _, line = summarize(insights(api, account["id"], preset))
        out.append(f"{label}: {line}")


def _age_days(created, now=None):
    """Days since a Graph created_time ('2026-10-06T09:12:00-0500'); a
    missing or unreadable time counts as old."""
    try:
        t = dt.datetime.strptime(str(created), "%Y-%m-%dT%H:%M:%S%z")
    except ValueError:
        return 99
    return ((now or dt.datetime.now(dt.timezone.utc)) - t).total_seconds() / 86400


def _ended(obj, key, now):
    """True when a Graph end time ('2026-10-06T09:12:00-0500') is past. No
    end time (runs until paused) or an unreadable one counts as running."""
    try:
        return dt.datetime.strptime(str(obj.get(key)), "%Y-%m-%dT%H:%M:%S%z") <= now
    except ValueError:
        return False


def running_ads(campaigns, adsets, ads, now=None):
    """Ads that should be delivering: ACTIVE themselves and under an ACTIVE,
    unfinished ad set and campaign. An ad's own effective_status stays
    ACTIVE after its ad set or campaign ends, which made a finished boost
    read as "$0 spent with 1 ad on" every morning. A parent missing from the
    listing (archived or deleted) doesn't deliver either."""
    now = now or dt.datetime.now(dt.timezone.utc)
    live_campaigns = {c["id"] for c in campaigns
                      if c.get("effective_status") == "ACTIVE" and not _ended(c, "stop_time", now)}
    live_adsets = {s["id"] for s in adsets
                   if s.get("effective_status") == "ACTIVE" and s.get("campaign_id") in live_campaigns
                   and not _ended(s, "end_time", now)}
    return [a for a in ads if a.get("effective_status") == "ACTIVE" and a.get("adset_id") in live_adsets]


def daily_rows(api, account_id, today=None):
    """The last 30 days (in the ad account's time zone, Central for this
    account), one row per day for the site. Meta leaves out days nothing
    spent; those are sent as $0, not left blank."""
    rows = api.call("GET", f"{account_id}/insights", fields="spend,impressions,inline_link_clicks,actions",
                    date_preset="last_30d", time_increment=1, level="account", limit=100).get("data") or []
    got = {r["date_start"]: {"day": r["date_start"], "spend": float(r.get("spend") or 0),
                             "impressions": int(float(r.get("impressions") or 0)),
                             "clicks": int(float(r.get("inline_link_clicks") or 0)),
                             "leads": action(r, "lead") or action(r, "offsite_conversion.fb_pixel_lead")}
           for r in rows if r.get("date_start")}
    today = today or dt.datetime.now(CENTRAL).date()
    days = [(today - dt.timedelta(days=n)).isoformat() for n in range(30, 0, -1)]
    return [got.get(d) or {"day": d, "spend": 0.0, "impressions": 0, "clicks": 0, "leads": 0} for d in days]


def push_spend(api, account):
    """Send the daily spend to the site; it answers with its own subscriber
    counts. None (with a warning) when that isn't set up or fails: the
    Slack report goes out either way."""
    secret = os.environ.get("ADS_SPEND_SECRET", "").strip()
    if not secret:
        return None
    try:
        days = daily_rows(api, account["id"])
        r = api.s.request("POST", f"{SITE}/api/ads/spend", json={"days": days}, timeout=30,
                          headers={"X-Cron-Secret": secret, "User-Agent": "vic361-meta-ads"})
        body = r.json() if r.status_code == 200 else {}
    except (requests.RequestException, AdsError, ValueError) as e:
        print(f"::warning::Couldn't send ad spend to the site: {type(e).__name__}")
        return None
    if not body.get("ok"):
        print(f"::warning::The site didn't take the ad spend (HTTP {r.status_code})")
        return None
    return body


def real_cost(site):
    """'✅ Real: 31 new subscribers yesterday ($0.92 each) · last 7 days: …'"""
    y = (site or {}).get("yesterday") or {}
    w = (site or {}).get("last_7_days") or {}
    if not y and not w:
        return None

    def part(row, label):
        joined = int(row.get("joined") or 0)
        each = f" (${row['cost_per_sub']:,.2f} each)" if row.get("cost_per_sub") is not None else ""
        return f"{label}: {joined} new subscriber{'' if joined == 1 else 's'}{each}"
    bits = []
    if y:
        bits.append(part(y, "yesterday"))
    if w:
        bits.append(part(w, "last 7 days"))
    return "✅ Real, from the site: " + " · ".join(bits)


def cmd_report(api, account, out):
    spend7, week = summarize(insights(api, account["id"], "last_7d"))
    # Every report sends the days (quiet weeks too: Meta revises recent
    # days, and a pause should show as $0 on the site).
    site = push_spend(api, account)
    campaigns, adsets, ads = structure(api, account["id"])
    problems = [f"⚠️ Ad *{a['name']}* is {a['effective_status'].lower()}: check it in Ads Manager"
                for a in ads if a.get("effective_status") in ("DISAPPROVED", "WITH_ISSUES")]
    # account_status 1 is ACTIVE; anything else (disabled, unsettled,
    # closed) stops every ad. Missing means Meta didn't say.
    if account.get("account_status") not in (None, 1):
        problems.insert(0, f"⚠️ The ad account is disabled or on hold (status {account['account_status']}): "
                           "check Ads Manager → Account overview")
    if spend7 <= 0:
        on = running_ads(campaigns, adsets, ads)
        if not problems and not on:
            out.append("No ad spend in the last 7 days and no ads on; no report.")
            return None
        # "last_7d" ends yesterday, so an ad that started today shows $0
        # there while it's already spending: report today instead.
        spend_today, today = summarize(insights(api, account["id"], "today"))
        if spend_today > 0:
            text = "\n".join([f"📈 Meta ads: today so far {today}"] + problems)
            out.append(text)
            return text
        # An ad made in the last 2 days may not have delivered yet; that's
        # not a stalled campaign.
        if not problems and on and all(_age_days(a.get("created_time")) < 2 for a in on):
            out.append("Ads just started; no spend reported yet, no report.")
            return None
        # Zero spend with ads on, or a rejected ad / held account, is a
        # stalled campaign, not a quiet week: say so.
        head = "📉 Meta ads: $0 spent in the last 7 days" + (f" with {len(on)} ad{'s' if len(on) != 1 else ''} on" if on else "")
        text = "\n".join([head] + problems)
        out.append(text)
        return text
    _, yday = summarize(insights(api, account["id"], "yesterday"))
    real = real_cost(site)
    text = "\n".join([f"📈 Meta ads: yesterday {yday}", f"Last 7 days: {week}"] + ([real] if real else []) + problems)
    out.append(text)
    return text


def set_status(api, target, status, out):
    obj = api.call("GET", target, fields="name,effective_status")
    api.call("POST", target, status=status)
    out.append(f"{obj.get('name')} ({target}): {obj.get('effective_status', '').lower()} → {status.lower()}")


def cmd_budget(api, target, dollars, force, out):
    if dollars <= 0:
        raise AdsError("Budget must be more than $0.")
    if dollars > MAX_DAILY_BUDGET and not force:
        raise AdsError(f"${dollars:,.2f}/day is over the ${MAX_DAILY_BUDGET} safety limit; run again with force to confirm.")
    obj = api.call("GET", target, fields="name,daily_budget")
    if not obj.get("daily_budget"):
        raise AdsError(f"{obj.get('name') or target} has no daily budget to change (the budget may be set on the campaign or ad set instead).")
    api.call("POST", target, daily_budget=str(int(round(dollars * 100))))
    out.append(f"{obj.get('name')} ({target}): daily budget {money(obj.get('daily_budget'))} → ${dollars:,.2f}")


def main(argv=None, session=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["status", "report", "pause", "resume", "budget"])
    ap.add_argument("target", nargs="?", default="")
    ap.add_argument("amount", nargs="?", default="")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--scheduled", action="store_true", help="the daily run: ads not set up yet doesn't fail it")
    args = ap.parse_args(argv)

    if not meta_allowed(use="ads"):
        print(f"These Meta ads settings aren't {TOWN['id']}'s own (META_TOWN and the ad account its town.json pins); nothing to do.")
        return 0
    token = os.environ.get("META_ADS_TOKEN", "").strip()
    if not token:
        print("META_ADS_TOKEN / META_PAGE_TOKEN not set; nothing to do.")
        return 0
    api = Api(token, session)
    out = []
    slack_rc = 0
    try:
        account, _ = find_account(api, os.environ.get("META_AD_ACCOUNT_ID", "").strip())
        if args.command == "status":
            cmd_status(api, account, out)
        elif args.command == "report":
            text = cmd_report(api, account, out)
            # A refused webhook (slack_notify returns 2) fails the run below,
            # so GitHub emails the owner instead of the report vanishing.
            if text:
                slack_rc = slack_notify.main([text, "--link", f"https://adsmanager.facebook.com/adsmanager/manage/campaigns?act={account['id'][4:]}"])
        elif args.command in ("pause", "resume"):
            if not args.target:
                raise AdsError("Which campaign, ad set or ad? Pass its id.")
            set_status(api, args.target, "PAUSED" if args.command == "pause" else "ACTIVE", out)
        elif args.command == "budget":
            try:
                dollars = float(args.amount)
            except ValueError:
                raise AdsError("Budget needs an id and an amount in dollars, e.g. budget 1234 15") from None
            cmd_budget(api, args.target, dollars, args.force, out)
    except AdsError as e:
        print("\n".join(out))
        # Only "ads were never set up" is quiet on the daily run; a dead
        # token or lost account access fails it so meta-ads.yml alerts
        # Slack, instead of the daily report just stopping.
        if args.scheduled and isinstance(e, NotSetUp):
            print(f"::warning::{e}")
            return 0
        print(f"::error::{e}")
        if isinstance(e, VersionRetired):
            # meta-ads.yml's Slack alert says this instead of "token or ad
            # account access?".
            set_output("alert", f"🚨 Meta ads daily check failed: {e}")
        return 1
    text = "\n".join(out)
    print(text)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as f:
            f.write(f"### Meta ads: {args.command}\n\n" + "\n".join(f"{x}  " for x in out) + "\n")
    return slack_rc or 0


def set_output(name, value):
    """A step output for the workflow (single line), when run in Actions."""
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a") as f:
            f.write(f"{name}={value.replace(chr(10), ' ')}\n")


if __name__ == "__main__":
    sys.exit(main())
