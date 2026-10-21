#!/usr/bin/env python3
"""Build the weekly social kit from the live published events.

Runs daily on the town's jobs worker (scripts/jobs_worker.py, which hands
the kit to the site's database, served at /social/latest/) and writes to
--out (docs/social/latest/ by default, Victoria's git copy before she moved):
  - week-N.png / weekend-N.png / today-N.png   Instagram/Facebook slides (1080x1350): at most
                                 three, a teaser (cover, day-by-day peek, see-all),
                                 each with a .jpg twin (Instagram only takes JPEG)
  - weekend.mp4                  the weekend slides as a vertical Reel (needs ffmpeg)
  - outreach.txt                 venues on this week's list, to send their link
  - outreach-slack.txt           the short Monday Slack version (taggable venues only)
  - captions.txt                 Facebook + Instagram captions
  - index.html                   phone-friendly page to save slides and copy captions

The page is served at /social/latest/ (noindex, disallowed in robots.txt),
so posting each week is: open the page, save the slides, paste a caption.

Pure helpers (select_events, captions) have no Pillow dependency so they
test without it.
"""
import argparse
import html
import json
import os
import re
import shutil
import subprocess
import sys
import textwrap
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from town import TOWN, brand_palette, site_url, town_asset, town_paths  # noqa: E402  (repo root; TOWN unset = Victoria)

SITE = site_url()
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", *town_paths()["social"].strip("/").split("/"))
# A sneak peek, not the whole list: two per day (Vic's Picks / sponsored
# first; select_events sorts them to the top), then "+ N more" and the link.
PER_DAY_CAPTION = 2

HASHTAGS = TOWN["hashtags"]
VENUES_FILE = os.path.join(os.path.dirname(__file__), "..", *town_paths()["venues"].split("/"))
KINDS = ("week", "weekend", "today")
# The newsletter sections' posts (SECTIONS.md): Tuesday's pet of the week,
# Wednesday's New in Town, from the site's sections file, when the town has
# its sections on.
SECTION_KINDS = ("pet", "new")
TITLES = {
    "week": (f"This week in {TOWN['city_state']}", f"This Week in {TOWN['city']}", "/"),
    "weekend": (f"This weekend in {TOWN['city_state']}", f"This Weekend in {TOWN['city']}", "/this-weekend"),
    "today": (f"Today in {TOWN['city_state']}", f"Today in {TOWN['city']}", "/today"),
}
MAX_TAGS = 15  # Instagram allows 20 @mentions per caption
IG_MAX_CAPTION = 2200  # Instagram rejects longer captions
MORE_ONLINE = f"+ more at {TOWN['domain']}"
TRIM_NAME = 50  # a long name or venue is cut to this when a caption runs long
# Venue names too generic to tag anyone by (an event "@ Victoria" is not
# Theatre Victoria): the town's own name, alone or with its state.
_c, _st, _stn = TOWN["city"].lower(), TOWN["state"].lower(), TOWN["state_name"].lower()
GENERIC_VENUES = {_c, f"{_c} {_st}", f"{_c} {_stn}", "downtown", f"downtown {_c}",
                  "tba", "tbd", "online", "various", "various locations", _stn, _st}


def pick_rank(e):
    """Paid Vic's Picks first, then editor's picks (server/scoring.js), then the rest."""
    return 0 if e.get("featured") and not e.get("editor_pick") else 1 if e.get("featured") else 2


AD_TAG = "#ad"  # opens a caption with paid content (captions)


def is_paid_pick(e):
    return bool(e.get("featured")) and not e.get("editor_pick")


# "CT" in the social kit page's timestamp; another zone's short name.
_ZONE_LABELS = {"America/Chicago": "CT", "America/New_York": "ET", "America/Denver": "MT", "America/Los_Angeles": "PT"}


def zone_label():
    tzname = TOWN["timezone"]
    return _ZONE_LABELS.get(tzname) or (datetime.now(ZoneInfo(tzname)).strftime("%Z") if ZoneInfo else tzname)


def today_central():
    if ZoneInfo:
        return datetime.now(ZoneInfo(TOWN["timezone"])).date()
    return date.today()


def today_bounds(today):
    return today, today


def week_bounds(today):
    """Rest of this week: today (or Monday) through Sunday. The Thursday
    run shouldn't post Monday–Wednesday events that already happened."""
    monday = today - timedelta(days=today.weekday())
    return max(monday, today), monday + timedelta(days=6)


def weekend_bounds(today):
    monday = today - timedelta(days=today.weekday())
    friday, sunday = monday + timedelta(days=4), monday + timedelta(days=6)
    return max(friday, today), sunday


def _time_key(t):
    import re
    m = re.search(r"(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m", t or "", re.I)
    if not m:
        return 9999
    h = int(m.group(1)) % 12 + (12 if m.group(3).lower() == "p" else 0)
    return h * 60 + int(m.group(2) or 0)


def select_events(events, start, end):
    """Events between start and end (dates), grouped by date, featured first."""
    out = {}
    for ev in events or []:
        if not isinstance(ev, dict):
            continue
        try:
            d = date.fromisoformat(str(ev.get("date") or "")[:10])
        except (TypeError, ValueError):
            continue
        if start <= d <= end and ev.get("name"):
            out.setdefault(d, []).append(ev)
    for d in out:
        out[d].sort(key=lambda e: (pick_rank(e), _time_key(e.get("time"))))
    return dict(sorted(out.items()))


def _short_time(t):
    """'7:00 PM – 10:00 PM' → '7 PM'; '10am - 3pm' → '10 AM'."""
    import re
    m = re.search(r"(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m", t or "", re.I)
    if not m:
        return ""
    mins = f":{m.group(2)}" if m.group(2) and m.group(2) != "00" else ""
    return f"{int(m.group(1))}{mins} {m.group(3).upper()}M"


_ZIP = re.compile(r"\b\d{5}(?:-\d{4})?\b")
# Where a geocoder string's town tail starts: ", Victoria", ", TX", ", Texas"
# for Victoria (the old literal), the town's own city and state elsewhere.
_PLACE_TAIL = re.compile(r",\s*(?:" + "|".join(re.escape(w.lower()) + r"\b" for w in (TOWN["city"], TOWN["state"], TOWN["state_name"]))
                         + r"|united states\b|usa\b)", re.I)


def clean_venue(venue):
    """A venue as people say it, not a geocoder string: '3102 Miori Ln.,
    Victoria, TX, United States, Texas 77901' → '3102 Miori Ln.'."""
    v = re.sub(r"\s+", " ", str(venue or "")).strip()
    cut = _PLACE_TAIL.search(v)
    if cut and cut.start() > 0:
        v = v[:cut.start()]
    v = re.sub(r",?\s*\bunited states\b", "", v, flags=re.I)
    v = _ZIP.sub("", v)
    return re.sub(r"[\s,]+$", "", v).strip()


def _clip(text, limit):
    return text if not limit or len(text) <= limit else text[:limit - 1].rstrip() + "…"


def _line(ev, limit=None):
    t = _short_time(ev.get("time"))
    v = clean_venue(ev.get("venue"))
    venue = f" @ {_clip(v, limit)}" if v else ""
    free = " (free)" if ev.get("free") else ""
    ad = f" {AD_TAG}" if is_paid_pick(ev) else ""  # a paid pick's line ends with #ad
    mark = "⭐ " if ev.get("featured") else "• "  # Vic's Picks / sponsored stand out
    return f"{mark}{t + ' ' if t else ''}{_clip(ev['name'], limit)}{venue}{free}{ad}"


def _range_label(start, end):
    if start.month == end.month:
        return f"{start.strftime('%b')} {start.day}–{end.day}" if start != end else f"{start.strftime('%b')} {start.day}"
    return f"{start.strftime('%b')} {start.day}–{end.strftime('%b')} {end.day}"


def _norm(name):
    return re.sub(r"[^a-z0-9]+", " ", (name or "").lower()).strip()


def load_venue_handles(path=VENUES_FILE):
    """Venue name → Instagram handle, from venues.json."""
    try:
        with open(path) as f:
            venues = json.load(f)
    except (OSError, ValueError):
        return {}
    out = {}
    for v in venues if isinstance(venues, list) else []:
        handles = v.get("instagrams") or []
        if v.get("name") and handles:
            out[_norm(v["name"])] = handles[0].lstrip("@")
    return out


def match_venue(key, table):
    """table[key] for a normalized venue name, or a close match: only when
    the shorter name is specific (2+ words, 8+ characters) and the other
    contains it as whole words. Generic names ('victoria', 'downtown') never
    match, so an event "@ Victoria" doesn't tag Theatre Victoria."""
    if not key or key in GENERIC_VENUES:
        return None
    if key in table:
        return table[key]
    for n, val in table.items():
        if not n or n in GENERIC_VENUES:
            continue
        short, long_ = (n, key) if len(n) <= len(key) else (key, n)
        if len(short.split()) >= 2 and len(short) >= 8 and f" {short} " in f" {long_} ":
            return val
    return None


def _venue_key(ev):
    return _norm(clean_venue(ev.get("venue")))


def venue_tags(groups, handles):
    """@mentions for venues on the list, so they get notified and reshare."""
    tags = []
    for evs in groups.values():
        for e in evs:
            h = match_venue(_venue_key(e), handles)
            if h and f"@{h}" not in tags:
                tags.append(f"@{h}")
    return tags[:MAX_TAGS]


def _shown(evs):
    """A day's events in the caption: the first PER_DAY_CAPTION, but every
    Vic's Pick (sorted first) even past that; a paid pick is never cut."""
    return evs[:max(PER_DAY_CAPTION, sum(1 for e in evs if e.get("featured")))]


def _body(groups, kind, limit=None, keep=None):
    """Caption body lines: each day's heading, its first PER_DAY_CAPTION
    events (all Vic's Picks first), "+ N more". keep, when given, is how many
    of the non-pick event lines survive (earliest first); the rest fold into
    a "+ more at thevic361.com" line. Vic's Picks are never dropped."""
    if not groups:
        return [f"Nothing listed yet. Know something happening? Submit it at {TOWN['domain']}/submit", ""]
    body, plain = [], 0
    for d, evs in groups.items():
        lines = []
        shown = _shown(evs)
        for e in shown:
            if not e.get("featured") and keep is not None:
                plain += 1
                if plain > keep:
                    continue
            lines.append(_line(e, limit))
        if keep is None and len(evs) > len(shown):
            lines.append(f"+ {len(evs) - len(shown)} more")
        if not lines:
            continue  # every event that day folded into "+ more"
        if kind != "today":
            body.append(d.strftime("%A").upper())
        body += lines + [""]
    if keep is not None:
        body += [MORE_ONLINE, ""]
    return body


def sponsor_lines(sponsor, start, platform):
    """The paid weekly sponsor's shout-out in a caption, only in kits for its
    own week (sponsor['week'] is that Monday). Facebook gets the click-counted
    /go/s/<week>?src=social link (the sponsor's report counts it); Instagram
    captions can't link, so it's the name and message."""
    if not sponsor or not sponsor.get("name"):
        return []
    week = sponsor.get("week") or ""
    if week != (start - timedelta(days=start.weekday())).isoformat():
        return []
    text = f"🙌 This week is brought to you by {sponsor['name']}" + (f": {sponsor['text']}" if sponsor.get("text") else "")
    if platform == "facebook":
        return [text, f"👉 {SITE}/go/s/{week}?src=social", ""]
    return [text, ""]


def thanks_lines(partners, today):
    """The monthly Facebook thank-you to the town's category partners
    (server/partners.js), promised on /advertise as "a monthly Facebook
    thank-you naming your business": in the kits built on the 1st of the
    month, so the month's first post carries it. One line naming them and
    one link to the town's /partners page (a link per partner cluttered
    the post); each partner's own link there is click-counted for its
    report. Facebook only: no town posts to Instagram yet. Never a price."""
    if not partners or not today or today.day != 1:
        return []
    names = [p["name"] for p in partners if isinstance(p, dict) and p.get("name") and p.get("id")]
    if not names:
        return []
    listed = names[0] if len(names) == 1 else f"{', '.join(names[:-1])} and {names[-1]}"
    return [f"🙏 Thanks to our local partners for keeping {TOWN['site_name']} free: {listed}. "
            f"Meet them 👉 {SITE}/partners {AD_TAG}", ""]


def captions(groups, start, end, kind, handles=None, sponsor=None, partners=None, today=None):
    """Return {'facebook': str, 'instagram': str} for a kit. partners: the
    live category partners from /events.json (thanked on the 1st)."""
    title, _, path = TITLES[kind]
    total = sum(len(v) for v in groups.values())
    head = f"{title} ({_range_label(start, end)})" + (f": {total} event{'s' if total != 1 else ''}" if total else "")
    # A caption with paid content (a paid pick, which is never cut, or the
    # weekly sponsor's shout-out) opens with #ad: the FTC wants the
    # disclosure where people see it before "more", not among the hashtags.
    paid = any(is_paid_pick(e) for evs in groups.values() for e in _shown(evs)) or \
        bool(sponsor_lines(sponsor, start, "facebook"))
    if paid:
        head = f"{AD_TAG} {head}"
    # The partners' thank-you is paid content too (Facebook only); it is
    # labeled on its own line (thanks_lines ends it with #ad), like a paid
    # pick's line, so the post doesn't open with #ad for it.
    thanks = thanks_lines(partners, today)
    fb_head = head
    tags = venue_tags(groups, handles or {})
    # Same call to action as the ad, the slides and the site: the newsletter.
    see_all = "👉 Full list: " if not total else "👉 Details: " if total == 1 else f"👉 See all {total}: "
    body = _body(groups, kind)
    fb = "\n".join([fb_head, ""] + sponsor_lines(sponsor, start, "facebook") + body + thanks + [f"{see_all}{SITE}{path}",
                                          f"Don't miss a thing: get every event free in your inbox every Monday and Thursday 👉 {SITE}/subscribe", "", HASHTAGS])

    def ig_caption(body, tags):
        return "\n".join([head, ""] + sponsor_lines(sponsor, start, "instagram") + body + [f"{see_all}link in bio ({TOWN['domain']})",
                                                "Don't miss a thing: get every event free in your inbox every Monday and Thursday (subscribe at the link in bio)", ""]
                         + ([" ".join(tags), ""] if tags else []) + [HASHTAGS]).strip() + "\n"

    # Instagram stops at 2,200 characters, and a busy week of long names can
    # go over: drop @tags from the end, then shorten long names and venues,
    # then fold events (never Vic's Picks) into "+ more at thevic361.com".
    ig = ig_caption(body, tags)
    while len(ig) > IG_MAX_CAPTION and tags:
        tags = tags[:-1]
        ig = ig_caption(body, tags)
    if len(ig) > IG_MAX_CAPTION:
        body = _body(groups, kind, limit=TRIM_NAME)
        ig = ig_caption(body, tags)
    keep = sum(1 for evs in groups.values() for e in _shown(evs) if not e.get("featured"))
    while len(ig) > IG_MAX_CAPTION and keep > 0:
        keep -= 1
        ig = ig_caption(_body(groups, kind, limit=TRIM_NAME, keep=keep), tags)
    if len(ig) > IG_MAX_CAPTION:  # nothing left but picks and still too long
        ig = ig[:IG_MAX_CAPTION - len(MORE_ONLINE) - 3].rstrip() + "…\n" + MORE_ONLINE + "\n"
    return {"facebook": fb.strip() + "\n", "instagram": ig}


# ─── Rendering (Pillow) ──────────────────────────────────────────────────

W, H = 1080, 1350
# Site theme (docs/style.css): cream page, ink text, sun header, sunset accents.
BG = (255, 248, 231)
INK = (31, 26, 61)
MUTED = (92, 86, 120)
ACCENT = (232, 96, 38)   # sunset, darkened a touch for contrast on cream
SUN = (255, 201, 60)
CARD = (255, 255, 255)
if TOWN["id"] != "victoria":
    # Another town's plain slides in its own colors (towns/<slug>/BRAND.md).
    _hex = lambda h: tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))
    _pal = brand_palette()
    BG, INK, SUN, ACCENT = _hex(_pal["paper"]), _hex(_pal["ink"]), _hex(_pal["highlight"]), _hex(_pal["primary"])
    MUTED = tuple(round(c + (255 - c) * 0.3) for c in INK)

FONT_DIRS = ["/usr/share/fonts/truetype/dejavu", "/usr/share/fonts/dejavu", "/Library/Fonts"]


def _font(bold, size):
    from PIL import ImageFont
    name = "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"
    for d in FONT_DIRS:
        p = os.path.join(d, name)
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def _wrap(draw, text, font, width):
    words, lines, cur = text.split(), [], ""
    for w in words:
        trial = f"{cur} {w}".strip()
        if draw.textlength(trial, font=font) <= width:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


# The town's own badge (Victoria's docs/logo.png); none rather than Victoria's.
LOGO = town_asset("logo.png")


def _header(draw, kicker, title):
    draw.rectangle([0, 0, W, 300], fill=SUN)
    draw.rectangle([0, 300, W, 310], fill=INK)
    try:
        from PIL import Image
        if not LOGO:
            raise FileNotFoundError("no logo")
        logo = Image.open(LOGO).convert("RGBA").resize((128, 128))
        draw._image.paste(logo, (W - 72 - 128, 60), logo)
    except Exception:
        pass  # slides are fine without the badge
    draw.text((72, 70), kicker.upper(), font=_font(True, 34), fill=INK)
    y = 120
    for line in _wrap(draw, title, _font(True, 70), W - 144 - 150)[:2]:
        draw.text((72, y), line, font=_font(True, 70), fill=INK)
        y += 84


def _footer(draw, text=None):
    draw.text((72, H - 100), text or TOWN["domain"], font=_font(True, 36), fill=ACCENT)


def shown_pages(groups, kind):
    """Pages of the events the post names: each day's first few on the
    sneak-peek slide (every Vic's Pick, then the best; scripts/social_slides.py
    digest_html), the same few the captions name."""
    per_day = 6 if kind == "today" else 2  # social_slides DIGEST_TODAY / DIGEST_PER_DAY
    out = []
    for evs in groups.values():
        n = max(per_day, sum(1 for e in evs if e.get("featured")))
        out += [e["page"] for e in evs[:n] if isinstance(e.get("page"), str) and e["page"]]
    return list(dict.fromkeys(out))


def render_slides(groups, start, end, kind, out_dir):
    """The branded slides (scripts/social_slides.py: the site's fonts, colors,
    icons and skyline, rendered with headless Chrome); the plain Pillow
    slides below if that can't run, so a post always goes out."""
    try:
        import social_slides
        names = social_slides.render(groups, start, end, kind, out_dir)
    except Exception as e:  # noqa: BLE001 - styling must never stop the kit
        print(f"Branded slides failed ({e}); using plain slides.")
        names = None
    return names or render_plain_slides(groups, start, end, kind, out_dir)


def jpeg_copies(out_dir, names, quality=92):
    """Instagram's publishing API takes JPEG only for image_url, so every
    slide also gets a .jpg twin (same pixels, flattened to RGB). Facebook
    and the kit page keep the PNGs."""
    from PIL import Image
    out = []
    for name in names:
        jpg = os.path.splitext(name)[0] + ".jpg"
        with Image.open(os.path.join(out_dir, name)) as img:
            img.convert("RGB").save(os.path.join(out_dir, jpg), "JPEG", quality=quality, optimize=True,
                                    subsampling=0)
        out.append(jpg)
    return out


def render_plain_slides(groups, start, end, kind, out_dir):
    from PIL import Image, ImageDraw
    title = TITLES[kind][1]
    files = []

    def new():
        img = Image.new("RGB", (W, H), BG)
        return img, ImageDraw.Draw(img)

    # Cover
    img, d = new()
    _header(d, TOWN["site_name"], title)
    total = sum(len(v) for v in groups.values())
    d.text((72, 380), start.strftime("%A, %b ") + str(start.day) if kind == "today" else _range_label(start, end),
           font=_font(True, 64), fill=INK)
    d.text((72, 470), f"{total} things to do" if total else "Nothing listed yet", font=_font(False, 48), fill=MUTED)
    y = 600
    for e in sorted([e for evs in groups.values() for e in evs if e.get("featured")], key=pick_rank)[:3] or \
             [e for evs in groups.values() for e in evs][:3]:
        for line in _wrap(d, f"• {e['name']}" + (f" {AD_TAG}" if is_paid_pick(e) else ""), _font(True, 40), W - 144)[:2]:
            d.text((72, y), line, font=_font(True, 40), fill=INK)
            y += 54
        y += 10
    d.text((72, H - 200), "Swipe for the full list →", font=_font(False, 40), fill=MUTED)
    _footer(d)
    files.append(img)

    # No per-day slides: a post is a teaser (max 3 images); the site has the list.

    # CTA
    img, d = new()
    _header(d, "Never miss a thing", "Get the full list every Monday & Thursday")
    for i, line in enumerate(["Every event, every day, in one place:", TOWN["domain"], "",
                              "Have an event? Submit it free.", f"Own a venue? Become a {TOWN['pick_name']}."]):
        d.text((72, 400 + i * 80), line, font=_font(i in (1,), 52 if i == 1 else 44), fill=ACCENT if i == 1 else INK)
    _footer(d)
    files.append(img)

    names = []
    for n, img in enumerate(files, 1):
        name = f"{kind}-{n}.png"
        img.save(os.path.join(out_dir, name), optimize=True)
        names.append(name)
    return names


def make_reel(out_dir, slides, name="weekend.mp4", seconds=4):
    """Stitch slides into a vertical 1080x1920 video for Instagram Reels.

    Returns the file name, or None without ffmpeg (the carousel still posts).
    A silent audio track is included; some players reject video-only files.
    """
    if not slides or not shutil.which("ffmpeg"):
        return None
    listing = os.path.join(out_dir, "reel.txt")
    with open(listing, "w") as f:
        for s in slides:
            f.write(f"file '{s}'\nduration {seconds}\n")
        f.write(f"file '{slides[-1]}'\n")  # concat demuxer needs the last frame repeated
    bg = "0x" + brand_palette()["paper"].lstrip("#")  # the slides' paper, so the Reel's padding blends in
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", "reel.txt",
           "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
           "-vf", f"scale=1080:1350,pad=1080:1920:0:285:color={bg},fps=30,format=yuv420p",
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-c:a", "aac", "-b:a", "64k",
           "-shortest", "-movflags", "+faststart", name]
    try:
        subprocess.run(cmd, cwd=out_dir, check=True, timeout=300)
    except (subprocess.SubprocessError, OSError) as e:
        print(f"Reel skipped: {e}")
        return None
    finally:
        os.remove(listing)
    return name


def outreach(groups, venues_path=VENUES_FILE):
    """Venues on this week's list with their social links and event pages.

    Venues reshare a post that features them; this is the list to send.
    """
    try:
        with open(venues_path) as f:
            venues = {_norm(v.get("name")): v for v in json.load(f) if v.get("name")}
    except (OSError, ValueError):
        venues = {}
    seen, lines = set(), []
    for evs in groups.values():
        for e in evs:
            key = _venue_key(e)
            if not key or key in seen:
                continue
            seen.add(key)
            v = match_venue(key, venues) or {}
            where = v.get("instagram_url") or v.get("facebook_page") or ""
            page = f"{SITE}{e['page']}" if e.get("page") else f"{SITE}/"
            lines.append(f"• {clean_venue(e['venue'])}: {e['name']} {page}" + (f" ({where})" if where else ""))
    return lines


def outreach_slack(groups, venues_path=VENUES_FILE, limit=8):
    """The Monday Slack nudge: short. Only venues with an Instagram/Facebook
    to send to, one line each with the long URLs behind Slack links, and a
    pointer to outreach.txt for the rest. (It used to paste 25 raw lines.)"""
    try:
        with open(venues_path) as f:
            venues = {_norm(v.get("name")): v for v in json.load(f) if v.get("name")}
    except (OSError, ValueError):
        venues = {}
    seen, rows = set(), []
    for evs in groups.values():
        for e in evs:
            key = _venue_key(e)
            if not key or key in seen:
                continue
            seen.add(key)
            v = match_venue(key, venues) or {}
            where = v.get("instagram_url") or v.get("facebook_page") or ""
            if not where:
                continue
            page = f"{SITE}{e['page']}" if e.get("page") else f"{SITE}/"
            clean = lambda t: str(t).replace("|", "/").replace("<", "").replace(">", "")
            rows.append(f"• <{where}|{clean(clean_venue(e['venue']))}> → <{page}|{clean(e['name'])}>")
    if not rows:
        return ""
    more = len(rows) - limit
    lines = [f"📣 *{len(rows)} venues on this week's list you can tag.* Send each its event link; they often reshare."]
    lines += rows[:limit]
    if more > 0:
        lines.append(f"…and {more} more: <{SITE}/social/latest/outreach.txt|full list>")
    return "\n".join(lines)


def render_page(kits, generated_at):
    sections = []
    for kind, kit in kits.items():
        imgs = "".join(f'<a href="{n}" download><img src="{n}" alt="{kind} slide {i}" loading="lazy"></a>'
                       for i, n in enumerate(kit["slides"], 1))
        caps = "".join(
            f'<h3>{label}</h3><textarea id="{kind}-{key}" readonly>{html.escape(kit["captions"][key])}</textarea>'
            f'<button type="button" data-copy="{kind}-{key}">Copy {label} caption</button>'
            for key, label in (("facebook", "Facebook"), ("instagram", "Instagram")))
        sections.append(f'<section><h2>{TITLES[kind][1]}</h2>'
                        f'<div class="slides">{imgs}</div>{caps}</section>')
    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Social kit | {TOWN['site_name']}</title>
<style>
body{{font:16px/1.5 system-ui,sans-serif;background:#FAF5E4;color:#1E1B33;margin:0;padding:16px;max-width:900px;margin-inline:auto}}
h1{{font-size:1.5rem;margin:0 0 4px}} .meta{{color:#5C5878;margin:0 0 16px}}
.slides{{display:flex;gap:8px;overflow-x:auto;padding-bottom:8px}} .slides img{{height:260px;border-radius:6px;border:1px solid #CFC9B2}}
textarea{{width:100%;min-height:180px;font:14px/1.4 ui-monospace,monospace;box-sizing:border-box;padding:8px;border:1px solid #CFC9B2;border-radius:6px}}
button{{font:inherit;margin:6px 0 16px;padding:8px 14px;border-radius:999px;border:0;background:#4E47B8;color:#fff}}
</style></head><body>
<h1>Social kit</h1><p class="meta">Generated {html.escape(generated_at)} from the published events. Tap a slide to save it, then copy a caption.</p>
{''.join(sections)}
<script>
document.addEventListener('click',function(e){{var b=e.target.closest('[data-copy]');if(!b)return;
var t=document.getElementById(b.getAttribute('data-copy'));t.select();
(navigator.clipboard?navigator.clipboard.writeText(t.value):Promise.reject()).then(function(){{b.textContent='Copied';}},function(){{document.execCommand('copy');b.textContent='Copied';}});}});
</script></body></html>
"""


# Waits between tries of /events.json. The site scheduler marks the day's
# run done once the dispatch succeeds, so the fallback cron won't retry a
# failed build: a restart or a brief 5xx at 8:47 would lose the day's post.
FETCH_BACKOFF = (30, 60, 120)


def _transient(err):
    """Worth trying again: no answer, a timeout or a 5xx. A 4xx won't fix
    itself."""
    if isinstance(err, urllib.error.HTTPError):
        return err.code >= 500
    return isinstance(err, OSError)  # URLError, timeouts, resets


def fetch_events(url, sleep=time.sleep):
    return fetch_payload(url, sleep)["events"]


def fetch_payload(url, sleep=time.sleep):
    """/events.json as {'events': [...], 'sponsor': {...} or None,
    'partners': [...live category partners]}."""
    req = urllib.request.Request(url, headers={"User-Agent": "TheVic361-SocialKit/1.0"})
    for i, wait in enumerate((*FETCH_BACKOFF, None)):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.loads(r.read().decode("utf-8"))
            break
        except OSError as e:
            if wait is None or not _transient(e):
                raise
            print(f"::warning::{url} failed ({e}); trying again in {wait}s "
                  f"(try {i + 2} of {len(FETCH_BACKOFF) + 1})")
            sleep(wait)
    events = data.get("events", []) if isinstance(data, dict) else []
    for ev in events:  # older data can carry "&amp;"
        for k in ("name", "venue"):
            if isinstance(ev.get(k), str):
                ev[k] = html.unescape(ev[k])
    sponsor = data.get("sponsor") if isinstance(data, dict) and isinstance(data.get("sponsor"), dict) else None
    return {"events": events, "sponsor": sponsor, "partners": live_partners(data)}


def live_partners(data):
    """The live category partners in /events.json's `partners` (absent until
    a town has had one; a paused town has none)."""
    p = data.get("partners") if isinstance(data, dict) else None
    active = p.get("active") if isinstance(p, dict) else None
    return [x for x in active if isinstance(x, dict)] if isinstance(active, list) else []


def sections_on():
    """The town's sections are on: its sections.json says so, or SECTIONS=1
    (SECTIONS=0 turns them off), like server/sections.js."""
    flag = os.environ.get("SECTIONS", "").strip()
    if flag in ("0", "1"):
        return flag == "1"
    try:
        with open(os.path.join(os.path.dirname(__file__), "..", town_paths()["dir"], "sections.json")) as f:
            return json.load(f).get("enabled") is True
    except (OSError, ValueError):
        return False


def section_captions(kind, data):
    """Facebook and Instagram captions for a sections post. Instagram links
    don't click, so it points at the site by name."""
    domain = TOWN["domain"]
    if kind == "pet":
        where = ", ".join(x for x in (data.get("shelter"), data.get("shelter_address")) if x)
        body = [f"🐾 Meet {data['name']}, our pet of the week!", "", data.get("blurb") or "",
                "", " · ".join(x for x in (data.get("facts"), f"At {where}" if where else "") if x)]
        tail = f"Every week we feature a pet from a {TOWN['city']} shelter."
        # Our own page (with the shelter's link on it), not the shelter's long URL.
        fb = "\n".join(body + ["", tail, f"Meet {data['name']}: {SITE}/pets", "", HASHTAGS + " #AdoptDontShop"])
        ig = "\n".join(body + ["", tail, f"More at {domain}/pets", "", HASHTAGS + " #AdoptDontShop"])
    else:
        # Each line already says "now open" or "coming soon".
        lines = [f"• {x['name']}: {x.get('line') or ''}".rstrip(": ") for x in data[:6]]
        head = [f"🏪 New in {TOWN['city']}", ""] + lines
        fb = "\n".join(head + ["", f"Every new spot, month by month: {SITE}/new-in-town", "", HASHTAGS])
        ig = "\n".join(head + ["", f"Every new spot at {domain}/new-in-town", "", HASHTAGS])
    return {"facebook": fb.strip(), "instagram": ig.strip()[:IG_MAX_CAPTION]}


def build_section_kit(kind, sections, out_dir, render=None):
    """A sections post's kit, or None when there's nothing to post (no pet
    with a photo, no new places) or the slides can't be drawn."""
    if kind == "pet":
        data = (sections or {}).get("pet")
        if not data or not data.get("photo") or not data.get("name"):
            return None
    else:
        data = [x for x in (sections or {}).get("new_in_town") or [] if x.get("name")]
        if not data:
            return None
    if render is None:
        import social_slides
        render = social_slides.render_section
    slides = render(kind, data, out_dir)
    if not slides:
        print(f"{kind}: slides couldn't be drawn; no {kind} post")
        return None
    return {"slides": slides, "slides_jpg": jpeg_copies(out_dir, slides), "captions": section_captions(kind, data),
            "events": 0, "featured": 0, "pages": []}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--events-url", default=f"{SITE}/events.json")
    ap.add_argument("--events-file", help="Read events from a local JSON file instead")
    ap.add_argument("--out", default=OUT_DIR)
    ap.add_argument("--today", help="YYYY-MM-DD (for testing)")
    ap.add_argument("--kinds", default=",".join(KINDS),
                    help="Comma list of kits to rebuild; others keep their last build")
    ap.add_argument("--sections", help="the site's sections file (the pet and new-in-town posts)")
    args = ap.parse_args(argv)
    asked = args.kinds.split(",")
    kinds = [k for k in asked if k in KINDS]
    section_kinds = [k for k in asked if k in SECTION_KINDS] if sections_on() else []

    if args.events_file:
        with open(args.events_file) as f:
            data = json.load(f)
        events, sponsor, partners = data.get("events", []), data.get("sponsor"), live_partners(data)
    else:
        payload = fetch_payload(args.events_url)
        events, sponsor, partners = payload["events"], payload["sponsor"], payload["partners"]
    today = date.fromisoformat(args.today) if args.today else today_central()
    os.makedirs(args.out, exist_ok=True)
    for old in os.listdir(args.out):
        if any(old.startswith(f"{k}-") and old.endswith((".png", ".jpg")) for k in kinds) or \
                ("weekend" in kinds and old == "weekend.mp4"):
            os.remove(os.path.join(args.out, old))

    # Kits not rebuilt this run keep their last manifest entry.
    manifest_path = os.path.join(args.out, "kit.json")
    try:
        with open(manifest_path) as f:
            kits = {k: v for k, v in json.load(f).get("kits", {}).items() if k in KINDS + SECTION_KINDS}
    except (OSError, ValueError):
        kits = {}
    handles = load_venue_handles()
    bounds = {"week": week_bounds, "weekend": weekend_bounds, "today": today_bounds}
    week_groups = None
    for kind in kinds:
        start, end = bounds[kind](today)
        groups = select_events(events, start, end)
        if kind == "week":
            week_groups = groups
        slides = render_slides(groups, start, end, kind, args.out)
        # featured: Vic's Picks in the kit (the Thursday run posts "today"
        # too when it has one; see scripts/jobs_worker.py social_plan).
        kit = {"slides": slides, "slides_jpg": jpeg_copies(args.out, slides),
               "captions": captions(groups, start, end, kind, handles, sponsor, partners, today),
               "events": sum(len(v) for v in groups.values()),
               # Paid picks only: the Thursday "today" post exists so a paid
               # pick that day is always posted, not for editor's picks.
               "featured": sum(1 for v in groups.values() for e in v if is_paid_pick(e)),
               # The event pages the post shows, kept with what was posted
               # (social_posted) for the event reports (server/eventReach.js).
               "pages": shown_pages(groups, kind)}
        # The Reel is for Instagram only (Facebook gets the photos), so a
        # town with no Instagram linked (IG_USER_ID unset) skips the build.
        if kind == "weekend" and os.environ.get("IG_USER_ID", "").strip():
            reel = make_reel(args.out, slides)
            if reel:
                kit["reel"] = reel
            elif slides:
                print("::warning::Weekend Reel skipped (ffmpeg missing or failed); Instagram will get the carousel.")
        kits[kind] = kit
        print(f"{kind}: {kit['events']} events, {len(slides)} slides" + (", reel" if kit.get("reel") else ""))

    if section_kinds:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        try:
            with open(args.sections) as f:
                sections = json.load(f)
        except (TypeError, OSError, ValueError):
            sections = {}
        for kind in section_kinds:
            for old in os.listdir(args.out):
                if old.startswith(f"{kind}-") and old.endswith((".png", ".jpg")):
                    os.remove(os.path.join(args.out, old))
            kit = build_section_kit(kind, sections, args.out)
            kits.pop(kind, None)
            if kit:
                kits[kind] = kit
                print(f"{kind}: {len(kit['slides'])} slides")

    # Manifest for scripts/social_post.py (auto-posting).
    with open(manifest_path, "w") as f:
        # `build` changes every run, so the poster can tell this deploy from an
        # earlier one the same day before it posts (see wait_for_deploy).
        # SOCIAL_BUILD: the jobs worker's own id for this run (scripts/jobs_worker.py).
        build = os.environ.get("SOCIAL_BUILD", "").strip() or os.environ.get("GITHUB_RUN_ID") and f"{os.environ['GITHUB_RUN_ID']}-{os.environ.get('GITHUB_RUN_ATTEMPT', '1')}"
        json.dump({"generated_for": today.isoformat(), "build": build or datetime.now().isoformat(timespec="seconds"),
                   "kits": kits}, f, indent=2, ensure_ascii=False)

    if week_groups is not None:
        with open(os.path.join(args.out, "outreach.txt"), "w") as f:
            f.write("\n".join(outreach(week_groups)) + "\n")
        with open(os.path.join(args.out, "outreach-slack.txt"), "w") as f:
            f.write(outreach_slack(week_groups))

    kits = {k: kits[k] for k in KINDS + SECTION_KINDS if k in kits}
    with open(os.path.join(args.out, "captions.txt"), "w") as f:
        for kind, kit in kits.items():
            f.write(f"===== {kind.upper()} · FACEBOOK =====\n{kit['captions']['facebook']}\n")
            f.write(f"===== {kind.upper()} · INSTAGRAM =====\n{kit['captions']['instagram']}\n")
    stamp = datetime.now(ZoneInfo(TOWN["timezone"])).strftime("%a %b %d, %I:%M %p ") + zone_label() if ZoneInfo else str(today)
    with open(os.path.join(args.out, "index.html"), "w") as f:
        f.write(render_page(kits, stamp))
    return 0


if __name__ == "__main__":
    sys.exit(main())
