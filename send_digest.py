#!/usr/bin/env python3
"""
The Vic 361 — Daily Event Digest Email
Reads candidates.json and sends a numbered email digest to Tristen
for screening. He replies with the event numbers he wants to keep.

Usage:
  python send_digest.py                          # sends digest email
  python send_digest.py --to other@email.com     # override recipient
  python send_digest.py --dry-run                # print email, don't send
  python send_digest.py --candidates /path.json  # custom candidates file

Requires either:
  RESEND_API_KEY — sends through Resend as news@<town domain> (the site's
                   own key; NEWSLETTER_FROM overrides the sender)
or:
  SMTP_EMAIL    — sender email address (e.g. Gmail)
  SMTP_PASSWORD — app password (NOT your regular Gmail password)
  SMTP_HOST     — smtp.gmail.com (default)
  SMTP_PORT     — 587 (default)
"""

import argparse
import html
import json
import os
import smtplib
import sys
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from town import TOWN, site_url, town_paths  # TOWN unset = Victoria

# ─── CONFIG ──────────────────────────────────────────────────────────────────

DEFAULT_TO = "tristen.m.palori@gmail.com"
DEFAULT_FROM = "tristen.m.palori@gmail.com"
DEFAULT_FROM_NAME = TOWN["site_name"]

ICON_MAP = {
    "food": "\U0001f354",
    "music": "\U0001f3b5",
    "family": "\U0001f468\u200d\U0001f469\u200d\U0001f467\u200d\U0001f466",
    "drinks": "\U0001f37a",
    "arts": "\U0001f3a8",
    "shopping": "\U0001f6cd\ufe0f",
    "outdoors": "\U0001f3c3",
    "community": "\U0001f4c5",
    "free": "\U0001f193",
}


REVIEW_DAYS = 14


def load_candidates(path, all_days=False):
    """Load candidates.json and return events grouped by date.
    By default, only returns events for day 7 (the new day entering the window).
    Pass all_days=True to return all events."""
    from datetime import timedelta

    with open(path) as f:
        data = json.load(f)

    events = data.get("events", [])
    # The review covers the collector's 14-day window. Hand-added events
    # now run 90 days ahead (local_events.yaml) and would swamp the email.
    from zoneinfo import ZoneInfo
    last = (datetime.now(ZoneInfo(TOWN["timezone"])).date() + timedelta(days=REVIEW_DAYS)).isoformat()
    events = [ev for ev in events if ev.get("date", "") <= last]

    if not all_days:
        all_dates = sorted(set(ev.get("date", "") for ev in events if ev.get("date")))
        target = all_dates[-1] if all_dates else None
        events = [ev for ev in events if ev.get("date", "") == target] if target else []

    # Group by date
    by_date = {}
    for ev in events:
        d = ev.get("date", "")
        if d not in by_date:
            by_date[d] = []
        by_date[d].append(ev)

    return events, by_date


def build_email_body(events, by_date):
    """Build a clean plain-text + HTML email body summarizing what was collected.
    Informational only — Tristen picks events via /admin.html, not by replying."""
    today = datetime.now()
    # Subject line preserved (including digest tag) so existing inbox filters keep working.
    digest_tag = f"[VIC361-DIGEST {today.strftime('%Y-%m-%d')}]"
    subject = f"{TOWN['site_name']} — Events to Screen ({today.strftime('%a %b %d')}) {digest_tag}"

    # www, not the bare domain: Squarespace forwards thevic361.com/<path> to
    # www.thevic361.com//<path>, which 404s.
    admin_url = site_url() + "/admin.html"

    # ── Plain text version ──
    text_lines = [
        f"{TOWN['site_name'].upper()} — WEEKLY EVENT DIGEST",
        f"Collected {today.strftime('%A, %B %d at %I:%M %p')}",
        f"{len(events)} events found across {len(by_date)} days",
        "",
        "This is an informational summary of what was collected this evening.",
        f"Open the admin review page to pick the events you want to publish:",
        f"   {admin_url}",
        "",
        "The newsletter goes out Monday morning (the week) and Thursday morning (the weekend).",
        "",
        "=" * 50,
    ]

    # ── HTML version ──
    html_parts = [
        "<html><body style='font-family: -apple-system, system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #28251D;'>",
        "<div style='text-align: center; margin-bottom: 20px;'>",
        f"<h1 style='color: #1A7A7E; font-size: 24px; margin: 0;'>{TOWN['site_name']}</h1>",
        f"<p style='color: #666; margin: 5px 0;'>Weekly Digest &mdash; {today.strftime('%A, %B %d')}</p>",
        f"<p style='color: #666; margin: 5px 0;'>{len(events)} events collected across {len(by_date)} days</p>",
        "</div>",
        "<div style='background: #F7F6F2; padding: 15px; border-radius: 8px; margin-bottom: 20px;'>",
        "<p style='margin: 0;'><strong>This is an informational summary of what was collected this evening.</strong></p>",
        f"<p style='margin: 8px 0 0 0; color: #666; font-size: 13px;'>Pick the events you want to publish on the admin review page: <a href='{admin_url}'>{admin_url}</a></p>",
        "<p style='margin: 8px 0 0 0; color: #888; font-size: 12px;'>The newsletter goes out Monday morning (the week) and Thursday morning (the weekend).</p>",
        "</div>",
    ]

    num = 0
    for date_str in sorted(by_date.keys()):
        dt = datetime.strptime(date_str, "%Y-%m-%d")
        day_label = dt.strftime("%A, %B %d")
        # Check if it's today
        if dt.date() == today.date():
            day_label += " (TODAY)"

        text_lines.append(f"\n--- {day_label} ---")
        html_parts.append(
            f"<h2 style='color: #1A7A7E; font-size: 16px; border-bottom: 2px solid #1A7A7E; padding-bottom: 5px; margin-top: 25px;'>{html.escape(day_label)}</h2>"
        )

        for ev in by_date[date_str]:
            num += 1
            icons = " ".join(ICON_MAP.get(i, "") for i in ev.get("icons", []))
            name = ev.get("name", "Unknown")
            time = ev.get("time", "")
            venue = ev.get("venue", "")
            desc = ev.get("description", "")
            free_tag = " [FREE]" if ev.get("free") else ""

            # Plain text
            text_lines.append(f"\n  [{num}] {icons} {name}{free_tag}")
            if time:
                text_lines.append(f"      Time: {time}")
            if venue:
                text_lines.append(f"      Venue: {venue}")
            if desc:
                text_lines.append(f"      {desc}")

            # HTML. Scraped text is escaped: the collector unescapes entities,
            # so "&lt;a href…&gt;" in a post arrives here as a live tag.
            name, time, venue, desc = (html.escape(str(v)) for v in (name, time, venue, desc))
            free_badge = '<span style="background: #1A7A7E; color: white; padding: 2px 6px; border-radius: 3px; font-size: 11px; margin-left: 5px;">FREE</span>' if ev.get("free") else ""
            html_parts.append(f"""
            <div style='padding: 10px; margin: 8px 0; background: white; border-radius: 6px; border-left: 3px solid #1A7A7E;'>
                <div style='display: flex; align-items: center;'>
                    <span style='background: #1A7A7E; color: white; width: 28px; height: 28px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 14px; font-weight: bold; margin-right: 10px; flex-shrink: 0;'>{num}</span>
                    <div>
                        <strong>{icons} {name}</strong>{free_badge}<br/>
                        <span style='color: #666; font-size: 13px;'>
                            {f'{time} &bull; ' if time else ''}{venue}
                        </span>
                        {f'<br/><span style="color: #888; font-size: 12px;">{desc}</span>' if desc else ''}
                    </div>
                </div>
            </div>
            """)

    text_lines.append(f"\n{'=' * 50}")
    text_lines.append(f"Pick events at {admin_url}, the newsletter goes out Monday morning (and the weekend issue Thursday).")

    html_parts.append(f"""
    <div style='background: #F7F6F2; padding: 15px; border-radius: 8px; margin-top: 25px; text-align: center;'>
        <p style='margin: 0;'><strong>Pick events on the admin review page.</strong></p>
        <p style='margin: 8px 0 0 0; color: #666; font-size: 13px;'><a href='{admin_url}'>{admin_url}</a></p>
        <p style='margin: 8px 0 0 0; color: #888; font-size: 12px;'>The newsletter goes out Monday morning (the week) and Thursday morning (the weekend).</p>
    </div>
    </body></html>
    """)

    return subject, "\n".join(text_lines), "\n".join(html_parts)


RESEND_URL = "https://api.resend.com/emails"


def _send_resend(subject, text_body, html_body, to_addr, api_key, session=None):
    """Send through Resend, as the town's news@ address (verified there for
    the newsletter)."""
    import requests
    sender = os.environ.get("NEWSLETTER_FROM", "").strip() or f"{DEFAULT_FROM_NAME} <news@{TOWN['domain']}>"
    try:
        r = (session or requests).post(RESEND_URL, timeout=30, headers={"Authorization": f"Bearer {api_key}"},
                                       json={"from": sender, "to": [to_addr], "subject": subject,
                                             "text": text_body, "html": html_body})
    except Exception as e:
        print(f"  Email error: {type(e).__name__}")
        return False
    if r.status_code >= 300:
        print(f"  Email error: Resend HTTP {r.status_code}")
        return False
    print(f"  Email sent to {to_addr}")
    return True


def send_email(subject, text_body, html_body, to_addr, dry_run=False, session=None):
    """Send the digest email via SMTP, or Resend when only its key is set."""
    from_email = os.environ.get("SMTP_EMAIL", DEFAULT_FROM)
    password = os.environ.get("SMTP_PASSWORD", "")
    smtp_host = os.environ.get("SMTP_HOST", "smtp.gmail.com")
    smtp_port = int(os.environ.get("SMTP_PORT", "587"))

    if dry_run:
        print(f"\n{'=' * 50}")
        print(f"DRY RUN — would send to: {to_addr}")
        print(f"Subject: {subject}")
        print(f"{'=' * 50}")
        print(text_body)
        return True

    resend_key = os.environ.get("RESEND_API_KEY", "").strip()
    if resend_key and not password:
        return _send_resend(subject, text_body, html_body, to_addr, resend_key, session)

    if not from_email or not password:
        print("ERROR: Set RESEND_API_KEY, or SMTP_EMAIL and SMTP_PASSWORD.")
        print("For Gmail, use an App Password: https://myaccount.google.com/apppasswords")
        print("\nFalling back to dry-run mode:\n")
        print(text_body)
        return False

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = f"{DEFAULT_FROM_NAME} <{from_email}>"
    msg["To"] = to_addr

    msg.attach(MIMEText(text_body, "plain"))
    msg.attach(MIMEText(html_body, "html"))

    try:
        with smtplib.SMTP(smtp_host, smtp_port) as server:
            server.starttls()
            server.login(from_email, password)
            server.send_message(msg)
        print(f"  Email sent to {to_addr}")
        return True
    except Exception as e:
        print(f"  Email error: {e}")
        return False


def main():
    parser = argparse.ArgumentParser(description=f"{TOWN['site_name']} — Send Event Digest")
    parser.add_argument("--candidates", default="./" + town_paths()["candidates"], help="Path to candidates.json")
    parser.add_argument("--to", default=DEFAULT_TO, help="Recipient email")
    parser.add_argument("--dry-run", action="store_true", help="Print email without sending")
    parser.add_argument("--all-days", action="store_true", help="Include all 7 days instead of just day 7")
    args = parser.parse_args()

    if not os.path.exists(args.candidates):
        print(f"ERROR: {args.candidates} not found. Run collect_events.py first.")
        sys.exit(1)

    events, by_date = load_candidates(args.candidates, all_days=args.all_days)
    if not events:
        print("No events to screen. Skipping digest.")
        sys.exit(0)

    subject, text_body, html_body = build_email_body(events, by_date)
    # A failed send must fail the job, or weekly-digest.yml's Slack alert
    # never fires and the digest just stops arriving.
    sys.exit(0 if send_email(subject, text_body, html_body, args.to, args.dry_run) else 1)


if __name__ == "__main__":
    main()
