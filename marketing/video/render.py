"""Render an analyze.py cut plan into the finished subscribe video.

One ffmpeg run per layout does the whole edit: it trims and joins the plan's
segments on the frame grid, applies the plan's speed-up, tone maps iPhone
HDR to SDR, fits the take to the canvas, lays the overlays over it and burns
in the word-by-word captions. The audio is cleaned up and brought to -14 LUFS
in two loudnorm passes.

The look is Tristen's own Victoria ad (a 4:5 feed ad he made by hand):

  - a badge at the top, white with an ink outline and a hard shadow, holding
    the town's logo and the hook (a number in an accent pill, the town's name
    on a highlighter stroke), which turns into "Subscribe free" over the
    domain when the hook ends and stays until the end card;
  - an event card for each chip, popping up when its cue word is said: an
    emoji icon, a small tag pill, a bold title and a grey venue line;
  - captions low on the picture, white with an ink outline, the word being
    said in the highlight colour;
  - a phone showing the town's site for about 2 s when a phone cue word
    ("email", "inbox") is said;
  - an end card: the logo, the two-tone wordmark, a tagline, a "Sign up free"
    button and the sign-up address, on a sky-to-paper background.

The badge, cards, phone and end card are pictures drawn with Pillow (Fredoka
and Nunito from fonts/, a colour emoji font for the icons) and laid over the
video by ffmpeg, each with its own short entrance (a slide, a pop or a fade)
baked into a few frames. The captions stay an ASS file burned in by libass.

    import render
    render.render(plan, "out/renders/victoria-1", layout="4x5")

The plan contract is analyze.py's (see its docstring); this module only draws
it. Needs ffmpeg/ffprobe built with libass (zscale and tonemap for HDR takes,
with a 3D LUT fallback) and Pillow. The fonts and their licences are in
fonts/. The emoji font is looked up in VIDEO_EMOJI_FONT, the toolkit's cache
(setup.sh puts Noto Color Emoji there) and the system's font folders; without
one the cards are drawn without their icons. The phone's screenshot of the
site is taken with headless Chromium once a day per town and cached; without
a browser or the network the newest cached one is used, and with none at all
the video has no phone.

    python3 render.py PLAN.json [--out DIR] [--formats 4x5,9x16]

re-renders a saved plan (or an edit.py report.json) after a hand fix.
"""
import argparse
import datetime as dt
import glob
import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import unicodedata

from PIL import Image, ImageDraw, ImageFilter, ImageFont

import towns

HERE = os.path.dirname(os.path.abspath(__file__))
# Fredoka SemiBold (600) and Bold (700): static instances of Google Fonts' own
# Fredoka[wdth,wght].ttf (github.com/google/fonts, ofl/fredoka; its OFL.txt is
# alongside), made with fontTools' instancer (wght 600/700, wdth 100,
# updateFontNames=True). The fonts.googleapis.com statics have the very same
# outlines and advances but name every weight "Fredoka Light", which is the
# family libass would then have to be asked for.
FONTS_DIR = os.path.join(HERE, "fonts")

FPS = 30
RATE = 48000
# 48000 / 30: every frame boundary falls on a whole audio sample, so a cut
# made on the frame grid is exact in both streams.
SAMPLES_PER_FRAME = RATE // FPS

LAYOUTS = {
    # The feed ad, and the main output. Nothing of the app covers a feed
    # video, so the overlays sit where Tristen put them in his own ad: the
    # badge 30 px from the top, the captions near the bottom edge.
    "4x5": {"size": (1080, 1350), "safe": (24, 24, 1056, 1326), "file": "feed-4x5.mp4",
            "badge_top": 30, "card_y": 753, "phone_y": 615, "caption_y": 1256, "caption_em": 63},
    # Reels: the app's own UI covers the top ~13% and the bottom ~23%, so
    # everything stays between y 250 and 1480. The card sits on the same
    # part of the picture as on 4:5 (a 4:5 cut of a portrait take starts
    # 171 px down it).
    "9x16": {"size": (1080, 1920), "safe": (60, 250, 1020, 1480), "file": "reel-9x16.mp4",
             "badge_top": 256, "card_y": 924, "phone_y": 905, "caption_y": 1402, "caption_em": 66},
}

LOUDNESS = {"I": -14.0, "TP": -1.5, "LRA": 11.0}
# Portrait takes are cropped a little more from the bottom than the top:
# the face is in the upper half of a selfie, the bottom is chest.
TOP_BIAS = 0.3

# HDR: HLG reference white (75% signal, 203 nits per BT.2408) becomes SDR
# white, and what is brighter rolls off with mobius. The classic recipe
# (npl=100 + hable) leaves faces about 20% darker than the SDR original.
HDR_REF_NITS = 203.0
HDR_ROLLOFF = 0.7
HDR_DESAT = 2.0

# Captions, as em sizes in canvas pixels (what a designer means by "68 px");
# Font.ass_size() turns them into libass font sizes. Each layout has its
# own size and height (LAYOUTS: caption_em, caption_y, the caption's centre).
CAPTION_EM = 72           # the most a caption may be; the layouts use a little less
CAPTION_MAX_WORDS = 3
CAPTION_PAUSE = 0.35      # a silence this long always starts a new caption
CAPTION_HOLD = 0.45       # a caption stays this long after its last word if nothing follows
SQUEEZE_MIN = 80          # % width: past this, type gets smaller instead

# The overlay pictures. Sizes are canvas pixels measured off Tristen's ad
# (both canvases are 1080 wide, so the Reel uses the same ones).
SS = 2                    # drawn at 2x and scaled down, for smooth edges
FONT_FILES = {"bold": "Fredoka-Bold.ttf", "semi": "Fredoka-SemiBold.ttf", "body": "Nunito-ExtraBold.ttf"}
WHITE = "#FFFFFF"
NBSP = "\u00a0"
GREEN = "#2FA876"         # the site's --color-success: a card's FREE pill
SKY = "#DDF2FF"           # the site's --sky-light: the top of the end card's background
LINE = 6                  # ink outline of the badge, its pills and the end card's boxes
DROP = 8                  # the hard ink shadow under them, offset right and down
BADGE = {"radius": 24, "pad_l": 25, "gap": 27, "pad_r": 34, "pad_y": 20,
         "hook_em": 59, "hook_pitch": 75, "hook_logo": 114,
         "sub_em": 68, "sub_pitch": 79, "sub_logo": 132, "domain_em": 61, "min_em": 40}
CARD = {"width": 774, "radius": 26, "line": 7, "drop": 10, "icon": 110, "icon_x": 98, "text_x": 178,
        "pad_r": 40, "pad_t": 31, "pad_b": 40, "title_em": 50, "title_min": 38, "title_pitch": 1.08,
        "tag_em": 29, "tag_h": 41, "venue_em": 30}
PHONE = {"width": 340, "height": 644, "radius": 48, "line": 8, "bezel": 11, "top": 45, "screen_line": 3,
         "screen_radius": 30, "drop": (22, 10), "notch": (106, 22, 30), "dpr": 2, "viewport": (390, 844)}
END = {"logo": 205, "mark_em": 118, "box_line": 7, "box_drop": 10, "tag_em": 58, "tag_min": 50, "tag_w": 860,
       "tag_pitch": 70, "button_em": 65, "button_h": 153, "button_pad": 79, "url_em": 50}
# Entrances, in frames: a card slides up and fades in like the ad's, the
# phone pops, the subscribe badge fades in, the end card comes up from black.
SLIDE_FRAMES, SLIDE_PX = 5, 56
POP_FRAMES, POP_FROM = 4, 0.86
FADE_FRAMES = 4
BLACK_FRAMES = 8
BADGE_OUT_FRAMES = 3      # the hook badge fades out this fast before the switch
PHONE_OUT_FRAMES = 3
# Cards keep off his eyes: the top EYE_BAND of the face box (forehead to just
# under the eyes) is never covered. They go just under the chin, else above
# the head under the badge, else over the chest above the captions, shrunk
# down to CARD_MIN_SCALE if that is what it takes.
FACE_EVERY = 0.5          # s of output time between the frames looked at
FACE_WIDTH = 360          # px wide the frames are looked at
EYE_BAND = 0.55
CARD_MARGIN = 24          # px between the chin (or the head) and a card
CARD_MIN_SCALE = 0.72
YUNET = "face_detection_yunet_2023mar.onnx"
# The town's name is underlined in the hook; these count as its name too.
TOWN_ALIASES = {"medford": ["Rogue Valley"], "shoals": ["Muscle Shoals", "Florence"]}


class RenderError(RuntimeError):
    pass


# ------------------------------------------------------------------ ffmpeg

def _run(cmd, *, cwd=None, timeout=1800, what=None, binary=False):
    what = what or os.path.basename(cmd[0])
    try:
        r = subprocess.run(cmd, cwd=cwd, capture_output=True, timeout=timeout)
    except FileNotFoundError:
        raise RenderError(f"{cmd[0]} not found: install ffmpeg (with libass)") from None
    except subprocess.TimeoutExpired:
        raise RenderError(f"{what} ran over {timeout}s") from None
    r.stderr = r.stderr.decode("utf-8", "replace")
    if not binary:
        r.stdout = r.stdout.decode("utf-8", "replace")
    if r.returncode != 0:
        tail = "\n".join(r.stderr.strip().splitlines()[-12:])
        raise RenderError(f"{what} failed (exit {r.returncode}):\n{tail}")
    return r


_FILTERS = None


def ffmpeg_filters():
    """Names of the filters this ffmpeg was built with."""
    global _FILTERS
    if _FILTERS is None:
        out = _run(["ffmpeg", "-hide_banner", "-filters"], timeout=60).stdout
        _FILTERS = {p[1] for p in (line.split() for line in out.splitlines())
                    if len(p) >= 3 and "->" in p[2]}
    return _FILTERS


def probe(path):
    """What render() needs to know about a source, sizes after rotation.

    ffmpeg rotates on decode (the display matrix, or an old "rotate" tag), so
    width/height here are what the filters will see, not the coded size.
    """
    if not os.path.isfile(path):
        raise RenderError(f"no such file: {path}")
    out = _run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format",
                "-show_streams", path], timeout=120).stdout
    data = json.loads(out or "{}")
    streams = data.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"
                  and not (s.get("disposition") or {}).get("attached_pic")), None)
    # A newer iPhone can add a spatial-audio track (APAC) this ffmpeg can't
    # decode next to the plain stereo one: take the first that has a codec.
    audio = next((s for s in streams if s.get("codec_type") == "audio"
                  and s.get("codec_name") not in (None, "", "none", "unknown")), None)
    if video is None:
        raise RenderError(f"{path} has no video stream")
    rotation = _rotation(video)
    cw, ch = int(video.get("width") or 0), int(video.get("height") or 0)
    w, h = (ch, cw) if rotation % 180 == 90 else (cw, ch)
    pix_fmt = video.get("pix_fmt") or ""
    depth = _int(video.get("bits_per_raw_sample"))
    if not depth:
        m = re.search(r"(\d+)(?:le|be)$", pix_fmt)
        depth = min(int(m.group(1)), 16) if m else 8
    transfer = video.get("color_transfer") or ""
    fmt = data.get("format") or {}
    v_dur = _float(video.get("duration"))
    a_dur = _float(audio.get("duration")) if audio else None
    duration = _float(fmt.get("duration")) or max(v_dur or 0, a_dur or 0)
    # ffmpeg's clock (what the plan's source seconds and the trims count in)
    # starts at the earliest stream; a sound track can start a little later.
    t0 = _float(fmt.get("start_time")) or 0.0

    def offset(stream):
        st = _float(stream.get("start_time"))
        return max(0.0, st - t0) if st is not None else 0.0

    a_start = offset(audio) if audio else None
    v_start = offset(video)
    return {
        "path": os.path.abspath(path),
        "width": w, "height": h, "coded_width": cw, "coded_height": ch,
        "rotation": rotation,
        "fps": _rate(video.get("avg_frame_rate")) or _rate(video.get("r_frame_rate")) or float(FPS),
        "video_codec": video.get("codec_name"),
        "video_index": int(video.get("index", 0)),
        "pix_fmt": pix_fmt, "bit_depth": depth,
        "color_transfer": transfer,
        "color_primaries": video.get("color_primaries") or "",
        "color_space": video.get("color_space") or "",
        "color_range": video.get("color_range") or "",
        "hdr": {"arib-std-b67": "hlg", "smpte2084": "pq"}.get(transfer),
        "peak_nits": _peak_nits(video),
        "has_audio": audio is not None,
        "audio_index": int(audio.get("index", 0)) if audio else None,
        "audio_codec": audio.get("codec_name") if audio else None,
        "audio_rate": _int(audio.get("sample_rate")) if audio else None,
        "audio_channels": _int(audio.get("channels")) if audio else None,
        "duration": duration or 0.0,
        "video_duration": v_dur, "audio_duration": a_dur,
        "audio_start": a_start,
        "video_end": v_start + v_dur if v_dur else None,
        "audio_end": a_start + a_dur if a_dur and a_start is not None else None,
    }


def _rotation(stream):
    """Clockwise degrees the player turns the picture (0, 90, 180, 270)."""
    for sd in stream.get("side_data_list") or []:
        if "rotation" in sd:
            # The display matrix angle is counter-clockwise.
            return int(round(-float(sd["rotation"]))) % 360
    tag = (stream.get("tags") or {}).get("rotate")
    return int(round(float(tag))) % 360 if tag not in (None, "") else 0


def _peak_nits(stream):
    for sd in stream.get("side_data_list") or []:
        if sd.get("max_content"):
            return float(sd["max_content"])
    for sd in stream.get("side_data_list") or []:
        if sd.get("max_luminance"):
            v = _rate(sd["max_luminance"])
            if v:
                return v
    return None


def _rate(v):
    try:
        if isinstance(v, str) and "/" in v:
            n, d = v.split("/", 1)
            return float(n) / float(d) if float(d) else None
        return float(v) if v not in (None, "", "N/A") else None
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def _float(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


# ------------------------------------------------------------------ fonts

class Font:
    """What libass's layout depends on, read from a TrueType file: which
    characters exist, their advance widths, and the OS/2 win metrics libass
    sizes text by (a font size of 100 is winAscent + winDescent = 100 px)."""

    def __init__(self, path, family, bold):
        with open(path, "rb") as f:
            data = f.read()
        tables = {}
        (count,) = struct.unpack_from(">H", data, 4)
        for i in range(count):
            tag, _, off, _ = struct.unpack_from(">4sIII", data, 12 + 16 * i)
            tables[tag.decode("latin-1")] = off
        self.path, self.family, self.bold = path, family, bold
        upem = struct.unpack_from(">H", data, tables["head"] + 18)[0]
        os2 = tables["OS/2"]
        win_ascent, win_descent = struct.unpack_from(">HH", data, os2 + 74)
        self.ascent, self.descent = win_ascent / upem, win_descent / upem
        version = struct.unpack_from(">H", data, os2)[0]
        cap = struct.unpack_from(">h", data, os2 + 88)[0] if version >= 2 else 0
        self.cap = (cap or 0.7 * upem) / upem
        (n_metrics,) = struct.unpack_from(">H", data, tables["hhea"] + 34)
        advances = struct.unpack_from(f">{2 * n_metrics}H", data, tables["hmtx"])[0::2]
        cmap = _read_cmap(data, tables["cmap"])
        self._adv = {cp: advances[min(g, n_metrics - 1)] / upem for cp, g in cmap.items()}

    def has(self, ch):
        return ord(ch) in self._adv

    def width(self, text, em):
        """Advance width in px at em size `em`. No kerning, so it errs a few
        px wide, which only ever adds padding."""
        return sum(self._adv.get(ord(c), 0.0) for c in text) * em

    def ass_size(self, em):
        return em * (self.ascent + self.descent)

    def cap_offset(self, em):
        """How far above a caps line's visual centre libass's \\an5 anchor is."""
        return ((self.ascent - self.descent) / 2 - self.cap / 2) * em


def _read_cmap(data, base):
    (n,) = struct.unpack_from(">H", data, base + 2)
    sub = None
    for i in range(n):
        pid, eid, off = struct.unpack_from(">HHI", data, base + 4 + 8 * i)
        fmt = struct.unpack_from(">H", data, base + off)[0]
        if fmt == 12 and (pid, eid) in ((3, 10), (0, 4), (0, 6)):
            sub = (base + off, 12)
            break
        if fmt == 4 and pid in (0, 3) and sub is None:
            sub = (base + off, 4)
    if sub is None:
        raise RenderError("font has no Unicode cmap")
    at, fmt = sub
    out = {}
    if fmt == 12:
        (groups,) = struct.unpack_from(">I", data, at + 12)
        for i in range(groups):
            first, last, gid = struct.unpack_from(">III", data, at + 16 + 12 * i)
            for cp in range(first, last + 1):
                out[cp] = gid + cp - first
        return out
    seg2 = struct.unpack_from(">H", data, at + 6)[0]
    segs = seg2 // 2
    ends = struct.unpack_from(f">{segs}H", data, at + 14)
    starts = struct.unpack_from(f">{segs}H", data, at + 16 + seg2)
    deltas = struct.unpack_from(f">{segs}h", data, at + 16 + 2 * seg2)
    ro_at = at + 16 + 3 * seg2
    offsets = struct.unpack_from(f">{segs}H", data, ro_at)
    for i in range(segs):
        for cp in range(starts[i], ends[i] + 1):
            if cp == 0xFFFF:
                continue
            if offsets[i] == 0:
                gid = (cp + deltas[i]) & 0xFFFF
            else:
                (gid,) = struct.unpack_from(">H", data, ro_at + 2 * i + offsets[i] + 2 * (cp - starts[i]))
                gid = (gid + deltas[i]) & 0xFFFF if gid else 0
            if gid:
                out[cp] = gid
    return out


_FONTS = {}


def fonts():
    """(bold, semibold): the two Fredoka weights the overlays use."""
    if not _FONTS:
        _FONTS["bold"] = Font(os.path.join(FONTS_DIR, "Fredoka-Bold.ttf"), "Fredoka", True)
        _FONTS["semibold"] = Font(os.path.join(FONTS_DIR, "Fredoka-SemiBold.ttf"), "Fredoka SemiBold", False)
        # The site's body face: the cards' venue line, the end card's tagline and address.
        _FONTS["body"] = Font(os.path.join(FONTS_DIR, FONT_FILES["body"]), "Nunito ExtraBold", True)
    return _FONTS["bold"], _FONTS["semibold"]


def body_font():
    """Nunito ExtraBold's metrics, for clean_text on the body-face lines."""
    fonts()
    return _FONTS["body"]


# ------------------------------------------------------------------ text

def clean_text(text, font):
    """Text as libass should draw it: single-spaced, typographic quotes, and
    nothing Fredoka has no glyph for. An emoji would make libass fall back to
    some other font (a pixel-art pumpkin from Unifont, here) and the boxes,
    sized from Fredoka's widths, would no longer fit."""
    s = unicodedata.normalize("NFC", str(text or ""))
    s = re.sub(r"\s+", " ", s)
    out = []
    for i, ch in enumerate(s):
        prev = s[i - 1] if i else " "
        nxt = s[i + 1] if i + 1 < len(s) else " "
        if ch == "'":
            # it's, girls', '90s: an apostrophe; 'quoted': an opening quote.
            ch = "\u2019" if (prev != " " or nxt.isdigit()) else "\u2018"
        elif ch == '"':
            ch = "\u201d" if prev != " " else "\u201c"
        if ch == " " or font.has(ch):
            out.append(ch)
        elif ch in "\u2018\u2019" and font.has("'"):
            out.append("'")
    return re.sub(r" {2,}", " ", "".join(out)).strip()


def ass_escape(text):
    """Make text literal for libass: braces would open an override block
    and a backslash before n/N/h would be a line break or hard space. A
    backslash at the very end goes too: the caption puts its colour tag
    straight after the word, and libass reads "\\{" as a literal brace, so
    "word\\" + "{\\1c...}" drew the tag on screen as text."""
    text = re.sub(r"\\(?=[nNh]|$)", "/", text)
    return text.replace("{", "\\{").replace("}", "\\}").replace("\n", " ")


def _ass_color(hexcolor):
    h = hexcolor.lstrip("#")
    return f"&H{h[4:6]}{h[2:4]}{h[0:2]}&".upper()


def _ts(t):
    cs = max(0, int(round(t * 100)))
    h, rem = divmod(cs, 360000)
    m, rem = divmod(rem, 6000)
    s, c = divmod(rem, 100)
    return f"{h}:{m:02d}:{s:02d}.{c:02d}"


def _num(v):
    """A short number for ASS tags (libass parses decimals)."""
    return f"{v:.1f}".rstrip("0").rstrip(".") if not float(v).is_integer() else str(int(v))


_SOFT = {"a", "an", "the", "and", "or", "at", "of", "in", "on", "to", "for", "with", "your",
         "our", "my", "is", "it's", "it’s", "+", "&", "@", "·", "-", "–"}
# A line that starts with one of these starts a phrase ("... / in Lincoln").
_LEADS = {"in", "at", "on", "with", "for", "from", "this", "and", "&", "+", "plus"}
_PHRASE_END = ".,!?;:"


def split_lines(words, font, em):
    """The best place to break `words` into two lines: as even as possible,
    preferring a break after punctuation, at a middle dot (which is dropped),
    before an "@ venue", a "(note)" or another phrase ("... / in Lincoln"),
    never leaving "the" or "at" hanging."""
    best = None
    for k in range(1, len(words)):
        left, right = list(words[:k]), list(words[k:])
        bonus = 1.0
        if left[-1] == "·":
            left.pop()
            bonus = 0.8
        elif right[0] == "·":
            right.pop(0)
            bonus = 0.8
        elif left[-1][-1:] in _PHRASE_END:
            bonus = 0.88
        elif right[0] == "@":
            bonus = 0.72
        elif right[0].startswith("("):
            bonus = 0.8
        if not left or not right:
            continue
        if left[-1].lower() in _SOFT:
            bonus *= 1.2
        elif right[0].lower() in _LEADS:
            bonus *= 0.9
        a, b = " ".join(left), " ".join(right)
        score = max(font.width(a, em), font.width(b, em)) * bonus
        if best is None or score < best[0]:
            best = (score, [a, b])
    return best[1] if best else [" ".join(words)]


def fit_text(text, font, max_w, em_hi, em_lo, *, two_lines_from=None, two_lines_to=None):
    """Largest em size (and line split) at which `text` fits `max_w`.

    One line from em_hi down to em_lo; then, if allowed, two lines from
    `two_lines_from` down to `two_lines_to`. Text that still doesn't fit is
    squeezed horizontally (the third value, a percentage, to 80% at most)
    and past that made smaller, but never spills out of the safe zone.
    Returns (em, lines, squeeze).
    """
    words = text.split()
    for em in range(em_hi, em_lo - 1, -2):
        if font.width(text, em) <= max_w:
            return em, [text], 100
    em, lines = em_lo, [text]
    if two_lines_from and len(words) > 1:
        for em in range(two_lines_from, two_lines_to - 1, -2):
            lines = split_lines(words, font, em)
            if max(font.width(x, em) for x in lines) <= max_w:
                return em, lines, 100
    elif two_lines_to:
        # One word can't wrap: let it shrink as far as two lines could.
        for em in range(em_lo, two_lines_to - 1, -2):
            if font.width(text, em) <= max_w:
                return em, [text], 100
    widest = max(font.width(x, em) for x in lines)
    # Rounded down with a hair to spare, so float noise can't round up past max_w.
    if widest * SQUEEZE_MIN / 100 <= max_w:
        return em, lines, max(SQUEEZE_MIN, int(100 * max_w / widest - 1e-6))
    # Absurdly long copy: smaller still, so it can never leave the safe zone.
    return max(8, int(em * max_w / (widest * SQUEEZE_MIN / 100) - 1e-6)), lines, SQUEEZE_MIN


# ------------------------------------------------------------------ captions (ASS)

def _event(layer, start, end, name, text, style="Bold"):
    return f"Dialogue: {layer},{_ts(start)},{_ts(end)},{style},{name},0,0,0,,{text}"


def caption_groups(words, font, em, max_w, until):
    """Split the spoken words into on-screen captions of 1 to 3 words.

    A small search over break points: a pause or a full line always breaks;
    breaking after punctuation is cheap, leaving "the" or "at" at the end of
    a caption or splitting a name is not, and single-word captions cost a
    little.
    """
    items = []
    for w in words:
        start, end = float(w["start"]), float(w["end"])
        if start >= until - 0.03:
            break
        raw = str(w.get("text") or "")
        text = clean_text(raw, font).rstrip(",.;:")
        if not text.strip("’'\"“”-–— "):
            continue
        items.append({"text": text, "raw": raw.strip(), "start": start, "end": min(end, until)})
    n = len(items)
    best = [0.0] + [math.inf] * n
    prev = [0] * (n + 1)
    for j in range(1, n + 1):
        for i in range(max(0, j - CAPTION_MAX_WORDS), j):
            group = items[i:j]
            if any(group[k + 1]["start"] - group[k]["end"] > CAPTION_PAUSE for k in range(len(group) - 1)):
                continue
            if font.width(" ".join(x["text"] for x in group), em) > max_w and len(group) > 1:
                continue
            cost = {1: 1.5, 2: 0.3}.get(len(group), 0.0)
            cost += sum(5.0 for x in group[:-1] if x["raw"][-1:] in _PHRASE_END)
            if j < n and group[-1]["text"].lower() in _SOFT:
                cost += 2.0
            # Don't split a name: "at the Royal / Grove", "Elm / Street".
            if (j < n and group[-1]["text"][:1].isupper() and items[j]["text"][:1].isupper()
                    and group[-1]["raw"][-1:] not in _PHRASE_END):
                cost += 1.6
            if best[i] + cost < best[j]:
                best[j], prev[j] = best[i] + cost, i
    groups, j = [], n
    while j > 0:
        groups.append(items[prev[j]:j])
        j = prev[j]
    return groups[::-1]


def _captions(events, plan, geo, bold, pal, spec, until):
    """White words with a thick ink outline and a soft shadow, the word being
    said in the highlight colour: Tristen's captions, as low as his on 4:5."""
    words = plan.get("words") or []
    L, _, R, _ = geo["safe"]
    W, _ = geo["canvas"]
    em = spec["caption_em"]
    bord = round(em * 0.11)
    max_w = (R - L) - 2 * bord - 24
    groups = caption_groups(words, bold, em, max_w, until)
    cx, cy = W / 2, spec["caption_y"]
    white, ink, hl = "&HFFFFFF&", _ass_color(pal["ink"]), _ass_color(pal["highlight"])
    out = []
    for g, group in enumerate(groups):
        nxt = groups[g + 1][0]["start"] if g + 1 < len(groups) else until
        group_end = min(nxt, group[-1]["end"] + CAPTION_HOLD, until)
        texts = [ass_escape(x["text"]) for x in group]
        line = " ".join(x["text"] for x in group)
        # One line, always: a group too wide (one long word) is squeezed,
        # then made smaller, never wrapped.
        gem, _, squeeze = fit_text(line, bold, max_w, em, em)
        width = bold.width(line, gem)
        fs = bold.ass_size(gem)
        sq = f"\\fscx{squeeze}" if squeeze != 100 else ""
        y = cy - bold.cap_offset(gem)
        for k, word in enumerate(group):
            start = word["start"]
            end = group[k + 1]["start"] if k + 1 < len(group) else group_end
            if end - start < 0.01:
                continue
            pop = (f"\\fscx{_num(squeeze * 0.92)}\\fscy92\\t(0,90,\\fscx{squeeze}\\fscy100)"
                   if k == 0 else "")
            body = " ".join(f"{{\\1c{hl}}}{t}{{\\1c{white}}}" if i == k else t
                            for i, t in enumerate(texts))
            base = f"\\an5\\pos({_num(cx)},{_num(round(y, 1))})\\fs{_num(round(fs, 1))}{sq}{pop}"
            # Under the words, a soft shadow: their shape, a little blurred
            # and dropped down and right, with the fill and outline invisible.
            events.append(_event(0, start, end, "caption-shadow",
                                 f"{{{base}\\bord{bord}\\1a&HFF&\\3a&HFF&\\4c{ink}\\4a&H70&"
                                 f"\\xshad{round(em * 0.03)}\\yshad{round(em * 0.075)}\\blur3}}"
                                 + " ".join(texts)))
            events.append(_event(1, start, end, "caption",
                                 f"{{{base}\\bord{bord}\\shad0\\1c{white}\\3c{ink}\\blur0.8}}{body}"))
        out.append({"text": line, "start": group[0]["start"], "end": group_end,
                    "words": [x["text"] for x in group], "width": width * squeeze / 100})
    return out


def build_ass(plan, layout="4x5"):
    """The captions for one layout, as an ASS script, and their geometry.
    Everything else on screen is a picture (build_sprites)."""
    if layout not in LAYOUTS:
        raise ValueError(f"unknown layout {layout!r}; one of {', '.join(LAYOUTS)}")
    spec = LAYOUTS[layout]
    W, H = spec["size"]
    pal = towns.town(plan["town"])["palette"]
    bold, _ = fonts()
    ec = plan.get("end_card") or {}
    es = float(ec["start"]) if ec else float(plan["duration"])
    geo = {"canvas": (W, H), "safe": spec["safe"]}
    events = []
    geo["captions"] = _captions(events, plan, geo, bold, pal, spec, es)
    header = "\n".join([
        "[Script Info]",
        f"; render.py captions for {re.sub(r'[^A-Za-z0-9._-]', '?', str(plan.get('video_id', '?')))} ({layout})",
        "ScriptType: v4.00+",
        f"PlayResX: {W}",
        f"PlayResY: {H}",
        "WrapStyle: 2",
        "ScaledBorderAndShadow: yes",
        # Colours are plain RGB: ffmpeg blends them onto RGB frames.
        "YCbCr Matrix: None",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, "
        "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, "
        "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: Bold,{bold.family},{_num(round(bold.ass_size(CAPTION_EM), 1))},&H00FFFFFF,&H00FFFFFF,"
        "&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ])
    return header + "\n" + "\n".join(events) + "\n", geo


# ------------------------------------------------------------------ pictures: drawing

def _rgb(color):
    if isinstance(color, str):
        h = color.lstrip("#")
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
    return tuple(color[:3])


def _rgba(color, alpha=255):
    return _rgb(color) + (alpha,)


def _fill(color):
    return tuple(color) if isinstance(color, tuple) and len(color) == 4 else _rgba(color)


def _mix(a, b, t):
    """Colour a moved toward b by t (0..1)."""
    return tuple(round(x + (y - x) * t) for x, y in zip(_rgb(a), _rgb(b)))


_PFONTS = {}


def _pfont(kind, em):
    """Pillow's font for kind ("bold", "semi", "body") at em `em` canvas px,
    at the supersampled size it is drawn at."""
    key = (kind, max(1, int(round(em * SS))))
    if key not in _PFONTS:
        _PFONTS[key] = ImageFont.truetype(os.path.join(FONTS_DIR, FONT_FILES[kind]), key[1])
    return _PFONTS[key]


def text_width(text, kind, em):
    """Advance width in canvas px, kerned the way it is drawn."""
    return _pfont(kind, em).getlength(text) / SS


def _cap(kind, em):
    """Cap height in canvas px."""
    return -_pfont(kind, em).getbbox("H", anchor="ls")[1] / SS


class _Surface:
    """An RGBA picture drawn in canvas pixels, SS times finer, and scaled
    down at the end: Pillow's shapes have no anti-aliasing of their own."""

    def __init__(self, w, h, background=(0, 0, 0, 0)):
        self.w, self.h = int(math.ceil(w)), int(math.ceil(h))
        self.im = Image.new("RGBA", (self.w * SS, self.h * SS), background)
        self.draw = ImageDraw.Draw(self.im)

    def rect(self, x0, y0, x1, y1, r, fill):
        if x1 - x0 <= 0 or y1 - y0 <= 0:
            return
        r = max(0.0, min(r, (x1 - x0) / 2, (y1 - y0) / 2))
        self.draw.rounded_rectangle([round(x0 * SS), round(y0 * SS), round(x1 * SS) - 1, round(y1 * SS) - 1],
                                    radius=round(r * SS), fill=_fill(fill))

    def panel(self, x0, y0, x1, y1, r, fill, ink, line=LINE, drop=DROP):
        """A rounded box filled with `fill`, outlined in ink, on a hard ink
        shadow: the look of everything Tristen's ad puts on the picture."""
        if drop:
            self.rect(x0 + drop, y0 + drop, x1 + drop, y1 + drop, r, ink)
        if line:
            self.rect(x0, y0, x1, y1, r, ink)
        self.rect(x0 + line, y0 + line, x1 - line, y1 - line, r - line, fill)

    def text(self, x, y, text, kind, em, fill, anchor="ls"):
        self.draw.text((x * SS, y * SS), text, font=_pfont(kind, em), fill=_fill(fill), anchor=anchor)

    def paste(self, img, x, y, w, h):
        """img scaled to w x h canvas px, its top-left at (x, y)."""
        im = img.convert("RGBA").resize((max(1, round(w * SS)), max(1, round(h * SS))), Image.LANCZOS)
        X, Y = round(x * SS), round(y * SS)
        # alpha_composite takes no picture that hangs off the edge: crop it.
        cx0, cy0 = max(0, -X), max(0, -Y)
        cx1, cy1 = min(im.width, self.im.width - X), min(im.height, self.im.height - Y)
        if cx1 > cx0 and cy1 > cy0:
            self.im.alpha_composite(im.crop((cx0, cy0, cx1, cy1)), (X + cx0, Y + cy0))

    def image(self):
        return self.im.resize((self.w, self.h), Image.LANCZOS)


def _alpha(img, a):
    """img with its opacity multiplied by a (0..1)."""
    if a >= 1:
        return img
    out = img.copy()
    out.putalpha(img.getchannel("A").point(lambda v: round(v * max(0.0, a))))
    return out


# ------------------------------------------------------------------ pictures: what they show

def _cache_base():
    return os.environ.get("VIDEO_EDIT_CACHE") or os.path.join(os.path.expanduser("~"), ".cache", "video-edit")


_LOGOS = {}


def _logo(town):
    """The town's logo cropped to its circle (None if it has none)."""
    path = logo_file(town)
    if path not in _LOGOS:
        img = None
        if path:
            img = Image.open(path).convert("RGBA")
            box = img.getchannel("A").getbbox()
            img = img.crop(box) if box else img
        _LOGOS[path] = img
    return _LOGOS[path]


EMOJI_FONT = "NotoColorEmoji.ttf"
EMOJI_PATHS = ["/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf", "/usr/share/fonts/noto/NotoColorEmoji.ttf",
               "/usr/share/fonts/google-noto-emoji/NotoColorEmoji.ttf",
               "/usr/share/fonts/noto-color-emoji/NotoColorEmoji.ttf", "/usr/local/share/fonts/NotoColorEmoji.ttf"]


def emoji_font_path():
    """A colour emoji font: VIDEO_EMOJI_FONT, the one setup.sh fetched into
    the toolkit's cache, or the system's Noto Color Emoji."""
    for p in [os.environ.get("VIDEO_EMOJI_FONT"), os.path.join(_cache_base(), "fonts", EMOJI_FONT)] + EMOJI_PATHS:
        if p and os.path.isfile(p):
            return p
    return None


_EMOJI = {}


def emoji_image(icon):
    """The emoji as an RGBA picture cropped to the glyph, or None (no colour
    emoji font, or one without this character)."""
    icon = unicodedata.normalize("NFC", str(icon or "")).strip()
    path = emoji_font_path()
    key = (icon, path)
    if key in _EMOJI:
        return _EMOJI[key]
    img = None
    if icon and path:
        try:
            # A bitmap (CBDT) emoji font comes in one size: Noto's is 109.
            font = ImageFont.truetype(path, 109)
            ok = Font(path, "emoji", False).has(icon[0])
        except (OSError, struct.error, KeyError, RenderError):
            font, ok = None, False
        if font is not None and ok:
            im = Image.new("RGBA", (180 * len(icon) + 40, 200), (0, 0, 0, 0))
            try:
                ImageDraw.Draw(im).text((20, 20), icon, font=font, embedded_color=True)
            except OSError:
                im = None
            box = im.getbbox() if im else None
            img = im.crop(box) if box else None
    _EMOJI[key] = img
    return img


def chrome_path():
    """A Chromium or Chrome to take the phone's screenshot with: VIDEO_CHROME,
    Playwright's (PLAYWRIGHT_BROWSERS_PATH), or one on the PATH."""
    cands = [os.environ.get("VIDEO_CHROME")]
    pw = os.environ.get("PLAYWRIGHT_BROWSERS_PATH") or os.path.expanduser("~/.cache/ms-playwright")
    cands += sorted(glob.glob(os.path.join(pw, "chromium-*", "chrome-*", "chrome")), reverse=True)
    cands += [shutil.which(n) for n in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser")]
    cands += ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    return next((c for c in cands if c and os.path.isfile(c) and os.access(c, os.X_OK)), None)


def capture_site(url, path, timeout=45):
    """Screenshot `url` at a phone's width (390 px, 2x) with headless Chrome
    into `path`. True when it worked."""
    chrome = chrome_path()
    if not chrome:
        return False
    vw, vh = PHONE["viewport"]
    tmp = path + ".part.png"
    # No --user-data-dir: headless makes a throwaway profile of its own, and
    # pointing it at a fresh empty folder made it hang until the timeout.
    cmd = [chrome, "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--mute-audio",
           "--no-first-run", f"--window-size={vw},{vh}", f"--force-device-scale-factor={PHONE['dpr']}",
           "--virtual-time-budget=8000", f"--screenshot={tmp}"]
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    if proxy:
        cmd.append(f"--proxy-server={proxy}")
    try:
        subprocess.run(cmd + [url], capture_output=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        if os.path.exists(tmp):
            os.remove(tmp)
        return False
    try:
        with Image.open(tmp) as im:
            ok = im.width >= vw and im.height >= vh and len(set(im.convert("L").resize((24, 48)).getdata())) > 8
    except (OSError, ValueError):
        ok = False
    if ok:
        os.replace(tmp, path)
    elif os.path.exists(tmp):
        os.remove(tmp)
    return ok


_CAPTURE_FAILED = set()


def site_screenshot(town, *, today=None, capture=True):
    """The phone's picture: a screenshot of the town's /this-weekend page at a
    phone's width. Today's from the cache, else a new one, else the newest
    cached one (offline, or no browser); None when there is none at all. A
    capture that failed isn't tried again in the same run."""
    d = os.path.join(_cache_base(), "screens")
    today = today or dt.date.today().isoformat()
    path = os.path.join(d, f"{town['slug']}-{today}.png")
    if os.path.isfile(path):
        return path
    if capture and path not in _CAPTURE_FAILED:
        os.makedirs(d, exist_ok=True)
        if capture_site(town["site_url"] + "/this-weekend", path):
            return path
        _CAPTURE_FAILED.add(path)
    old = sorted(glob.glob(os.path.join(d, f"{town['slug']}-????-??-??.png")))
    return old[-1] if old else None


def wordmark(town):
    """The site's two-tone name: (text, badge), e.g. ("The Vic", "361"), from
    the town's siteNameHtml (town.py's VICTORIA for Victoria)."""
    html = None
    try:
        if town["slug"] == "victoria":
            with open(os.path.join(towns.REPO, "town.py"), encoding="utf-8") as f:
                m = re.search(r'"site_name_html":\s*"([^"]+)"', f.read())
            html = m.group(1) if m else None
        else:
            with open(os.path.join(towns.REPO, "towns", town["slug"], "town.json"), encoding="utf-8") as f:
                html = json.load(f).get("siteNameHtml")
    except (OSError, ValueError):
        html = None
    m = re.match(r"^\s*(.*?)\s*<span>(.*?)</span>\s*$", html or "")
    if m and m.group(1) and m.group(2):
        return m.group(1), m.group(2)
    name = town["name"].rsplit(" ", 1)
    return (name[0], name[1]) if len(name) == 2 else (town["name"], "")


_NUMBER = re.compile(r"^(\$?\d+(?:[.,]\d+)*\+?)([^\w]*)$")


def _norm_word(w):
    w = unicodedata.normalize("NFKD", w.lower().replace("’", "'"))
    w = re.sub(r"'s$", "", re.sub(r"[^a-z0-9']", "", w))
    return w.replace("'", "")


def town_words(words, town):
    """Indices of the words that name the town (to underline): its city,
    the names in TOWN_ALIASES, and a ", TX" after the city."""
    names = [re.sub(r"(?i)^the\s+", "", town["city"])] + TOWN_ALIASES.get(town["slug"], [])
    keys = [_norm_word(w) for w in words]
    marked = set()
    for name in names:
        parts = [_norm_word(p) for p in name.split()]
        for i in range(len(words) - len(parts) + 1):
            if keys[i:i + len(parts)] == parts:
                span = list(range(i, i + len(parts)))
                j = i + len(parts)
                if j < len(words) and words[j - 1].endswith(",") and re.fullmatch(r"[A-Z]{2}[.,!?]?", words[j]):
                    span.append(j)
                marked.update(span)
    return marked


def _break_bonus(left, right):
    """How much better (under 1) or worse a line break between these words is."""
    if left[-1][-1:] in _PHRASE_END:
        b = 0.88
    elif right[0] == "@":
        b = 0.72
    elif right[0].startswith("("):
        b = 0.8
    elif right[0] == "·" or left[-1] == "·":
        b = 0.8
    else:
        b = 1.0
    if left[-1].lower() in ("the", "a", "an"):
        b *= 2.0  # an article never ends a line
    elif left[-1].lower() in _SOFT:
        b *= 1.2
    elif right[0].lower() in _LEADS or right[0].lower() in ("after", "before", "until", "every"):
        b *= 0.9
    elif right[0].lower() == "to":
        b *= 1.15  # "things / to do"
    # Keep a pair of names together: "Monday and Thursday", "Zoo Boo and Malloween".
    if (right[0].lower() in ("and", "&", "or") and len(right) > 1
            and left[-1][:1].isupper() and right[1][:1].isupper()):
        b *= 1.25
    return b


def break_lines(tokens, measure, n, text=str):
    """`tokens` split into exactly n lines (lists of tokens): the widest line
    as narrow as it can be, breaking where a designer would (after
    punctuation, before "@ venue" or "in Lincoln", never after "the"), as
    split_lines does for two. A middle dot at a break is dropped. text(token)
    is the word a token stands for."""
    tokens = list(tokens)
    if n <= 1 or len(tokens) <= 1:
        return [tokens]
    n = min(n, len(tokens))
    found = []
    for cuts in _combinations(range(1, len(tokens)), n - 1):
        bounds = (0,) + cuts + (len(tokens),)
        lines = [tokens[a:b] for a, b in zip(bounds, bounds[1:])]
        bonus = 1.0
        for left, right in zip(lines, lines[1:]):
            bonus *= _break_bonus([text(t) for t in left], [text(t) for t in right])
        lines = [[t for k, t in enumerate(ln) if not (text(t) == "·" and k in (0, len(ln) - 1))]
                 for ln in lines]
        if not all(lines):
            continue
        widths = [measure(ln) for ln in lines]
        found.append((max(widths) * bonus, max(widths) - min(widths), lines))
    if not found:
        return [tokens]
    # Near-ties (a line that sets the width either way) go to the evener split:
    # "in your inbox every / Monday and Thursday", not "... Monday / and Thursday".
    top = min(f[0] for f in found)
    return min((f for f in found if f[0] <= top * 1.015), key=lambda f: (f[1], f[0]))[2]


def _combinations(items, k):
    items = list(items)
    if k == 0:
        yield ()
        return
    for i in range(len(items) - k + 1):
        for rest in _combinations(items[i + 1:], k - 1):
            yield (items[i],) + rest


def fit_lines(tokens, measure, max_w, plans, text=str):
    """The first of `plans` ((lines, em_hi, em_lo), ...) that fits max_w:
    returns (em, lines). measure(line, em) is a line's width. When none
    fits, the last plan's split at whatever smaller size does."""
    for n, hi, lo in plans:
        for em in range(int(hi), int(lo) - 1, -1):
            lines = break_lines(tokens, lambda ln: measure(ln, em), n, text)
            if max(measure(ln, em) for ln in lines) <= max_w:
                return em, lines
    n, _, em = plans[-1]
    em = int(em)
    while em > 12:
        lines = break_lines(tokens, lambda ln: measure(ln, em), n, text)
        if max(measure(ln, em) for ln in lines) <= max_w:
            return em, lines
        em -= 1
    return em, break_lines(tokens, lambda ln: measure(ln, em), n, text)


# ------------------------------------------------------------------ pictures: the badge

def _pill_metrics(em):
    """A number pill in the hook at em: (padding, height, radius, outline)."""
    k = em / BADGE["hook_em"]
    return 13 * k, 76 * k, 14 * k, max(3, round(4 * k))


def _hook_items(text, town):
    """The hook as words, each plain, a number (accent pill) or part of the
    town's name (highlighter stroke)."""
    bold, _ = fonts()
    words = clean_text(text, bold).split()
    marked = town_words(words, town)
    items = []
    for i, w in enumerate(words):
        m = _NUMBER.match(w)
        if m:
            items.append({"kind": "pill", "text": m.group(1), "tail": m.group(2), "word": w})
        elif i in marked and i - 1 in marked and items and items[-1]["kind"] == "mark":
            # "Virginia Beach", "Victoria, TX": one stroke, never split over two lines.
            items[-1]["text"] += " " + w
            items[-1]["word"] += " " + w
        else:
            items.append({"kind": "mark" if i in marked else "text", "text": w, "tail": "", "word": w})
    return items


def _item_width(it, em):
    w = text_width(it["text"], "bold", em)
    if it["kind"] == "pill":
        pad, _, _, line = _pill_metrics(em)
        w += 2 * (pad + line)
    return w + (text_width(it["tail"], "bold", em) if it["tail"] else 0)


def _gap_after(it, em):
    """The space after an item: a pill's own padding stands in for part of it."""
    space = text_width(" ", "bold", em)
    return space * (0.6 if it["kind"] == "pill" and not it["tail"] else 1.0)


def _line_width(items, em):
    return sum(_item_width(it, em) for it in items) + sum(_gap_after(it, em) for it in items[:-1])


def _badge(rows, block_top, block_bottom, logo, logo_size, pal, *, pad_y, text_w, nudge=0.0):
    """The badge's card around a text block (rows drawn by the callers'
    `draw(surface, x, y_offset)`), with the logo on its left."""
    ink = pal["ink"]
    pad_l, gap, pad_r = BADGE["pad_l"], BADGE["gap"], BADGE["pad_r"]
    k = logo_size / BADGE["hook_logo"]
    pad_l, gap, pad_r = pad_l * k, gap * k, pad_r * k
    block_h = block_bottom - block_top
    inner_h = max(logo_size + 2 * 34 * k, block_h + 2 * pad_y)
    has_logo = logo is not None
    inner_w = pad_l + (logo_size + gap if has_logo else 0) + text_w + pad_r
    w, h = inner_w + 2 * LINE, inner_h + 2 * LINE
    s = _Surface(w + DROP, h + DROP)
    s.panel(0, 0, w, h, BADGE["radius"], WHITE, ink)
    if has_logo:
        s.paste(logo, LINE + pad_l, LINE + (inner_h - logo_size) / 2, logo_size, logo_size)
    x = LINE + pad_l + (logo_size + gap if has_logo else 0)
    dy = LINE + (inner_h - block_h) / 2 - block_top + nudge
    for draw in rows:
        draw(s, x, dy)
    return s.image(), (w, h)


def hook_badge(text, town, pal, logo=None, max_w=960):
    """The badge while the hook is up: the hook in two lines (one if it is
    one or two words), a number in an accent pill and the town's name on a
    highlighter stroke, beside the logo."""
    items = _hook_items(text, town)
    if not items:
        return None
    ink, accent, hl = pal["ink"], pal["accent"], pal["highlight"]
    logo_size = BADGE["hook_logo"]
    room = max_w - DROP - 2 * LINE - (BADGE["pad_l"] + BADGE["pad_r"]) - (logo_size + BADGE["gap"] if logo else 0)
    n = 2 if len(items) >= 3 else 1
    em, lines = fit_lines(items, _line_width, room,
                          [(n, BADGE["hook_em"], BADGE["min_em"]), (n + 1, BADGE["min_em"], 30)],
                          text=lambda it: it["word"])
    pitch = BADGE["hook_pitch"] * em / BADGE["hook_em"]
    cap = _cap("bold", em)
    pad, pill_h, pill_r, pill_line = _pill_metrics(em)
    lift = 0.28 * em  # a pill's centre above the baseline
    # The block's top and bottom, relative to the first baseline.
    top = -max(pill_h / 2 + lift if any(it["kind"] == "pill" for it in lines[0]) else 0,
               -_pfont("bold", em).getbbox(" ".join(it["text"] for it in lines[0]), anchor="ls")[1] / SS)
    last = lines[-1]
    bottom = (len(lines) - 1) * pitch + max(
        0.24 * em if any(it["kind"] == "mark" for it in last) else 0,
        pill_h / 2 - lift if any(it["kind"] == "pill" for it in last) else 0,
        _pfont("bold", em).getbbox(" ".join(it["text"] for it in last), anchor="ls")[3] / SS)

    def draw(s, x0, dy):
        for r, line in enumerate(lines):
            base = dy + r * pitch
            # The highlighter strokes go under the words, one per run.
            x, runs, cur = x0, [], None
            for i, it in enumerate(line):
                w = _item_width(it, em)
                if it["kind"] == "mark":
                    cur = [x, x + w] if cur is None else [cur[0], x + w]
                elif cur is not None:
                    runs.append(cur)
                    cur = None
                x += w + _gap_after(it, em)
            if cur is not None:
                runs.append(cur)
            for a, b in runs:
                s.rect(a - 4, base - 0.2 * em, b + 4, base + 0.24 * em, 0, hl)
            x = x0
            for it in line:
                if it["kind"] == "pill":
                    tw = text_width(it["text"], "bold", em)
                    pw = tw + 2 * (pad + pill_line)
                    yc = base - lift
                    s.panel(x, yc - pill_h / 2, x + pw, yc + pill_h / 2, pill_r, accent, ink,
                            line=pill_line, drop=0)
                    s.text(x + pill_line + pad, base, it["text"], "bold", em, WHITE)
                    x += pw
                    if it["tail"]:
                        s.text(x, base, it["tail"], "bold", em, ink)
                        x += text_width(it["tail"], "bold", em)
                else:
                    s.text(x, base, it["text"], "bold", em, ink)
                    x += text_width(it["text"], "bold", em)
                x += _gap_after(it, em)

    text_w = max(_line_width(ln, em) for ln in lines)
    img, size = _badge([draw], top, bottom, logo, logo_size, pal, pad_y=BADGE["pad_y"], text_w=text_w)
    return img, {"em": em, "lines": [" ".join(it["text"] + it["tail"] for it in ln) for ln in lines],
                 "size": size}


def subscribe_badge(town, pal, logo=None, max_w=960):
    """The badge from the end of the hook to the end card: "Subscribe free"
    over the domain in a highlight pill."""
    ink, hl = pal["ink"], pal["highlight"]
    bold, _ = fonts()
    domain = clean_text(town["domain"], bold)
    logo_size = BADGE["sub_logo"]
    k = logo_size / BADGE["hook_logo"]
    room = (max_w - DROP - 2 * LINE - (BADGE["pad_l"] + BADGE["pad_r"]) * k
            - (logo_size + BADGE["gap"] * k if logo else 0))
    em1, em2 = BADGE["sub_em"], BADGE["domain_em"]
    pill_line, pill_pad = 5, 20
    while em2 > 20 and max(text_width("Subscribe free", "bold", em1),
                           text_width(domain, "bold", em2) + 2 * (pill_pad + pill_line)) > room:
        em1, em2 = em1 - 1, em2 - 1
    pitch = BADGE["sub_pitch"] * em1 / BADGE["sub_em"]
    pill_h = 85 * em2 / BADGE["domain_em"]
    cap1, cap2 = _cap("bold", em1), _cap("bold", em2)
    top = _pfont("bold", em1).getbbox("Subscribe free", anchor="ls")[1] / SS
    bottom = pitch - cap2 / 2 + pill_h / 2
    dw = text_width(domain, "bold", em2)

    def draw(s, x, dy):
        s.text(x, dy, "Subscribe free", "bold", em1, ink)
        yc = dy + pitch - cap2 / 2
        s.panel(x, yc - pill_h / 2, x + dw + 2 * (pill_pad + pill_line), yc + pill_h / 2, 14, hl, ink,
                line=pill_line, drop=0)
        s.text(x + pill_line + pill_pad, dy + pitch, domain, "bold", em2, ink)

    text_w = max(text_width("Subscribe free", "bold", em1), dw + 2 * (pill_pad + pill_line))
    img, size = _badge([draw], top, bottom, logo, logo_size, pal, pad_y=31, text_w=text_w, nudge=3)
    return img, {"em": em1, "domain_em": em2, "size": size}


# ------------------------------------------------------------------ pictures: the event cards

def _ellipsize(text, kind, em, max_w):
    if text_width(text, kind, em) <= max_w:
        return text
    words = text.split()
    while words and text_width(" ".join(words) + "…", kind, em) > max_w:
        words.pop()
    return (" ".join(words) + "…") if words else ""


def event_card(chip, pal):
    """One event's card: the emoji on the left; a tag pill, the title (one
    or two lines) and the venue in grey on the right. A chip without a title
    (the older scripts) shows its one-line text as the title."""
    bold, _ = fonts()
    body = body_font()
    ink, hl = pal["ink"], pal["highlight"]
    muted = _mix(ink, WHITE, 0.27)
    W, line, drop = CARD["width"], CARD["line"], CARD["drop"]
    icon = emoji_image(chip.get("icon")) if chip.get("icon") else None
    text_x = CARD["text_x"] if icon is not None else line + 44
    col_w = W - line - CARD["pad_r"] - text_x
    tag = clean_text(chip.get("tag") or "", bold)
    title = clean_text(chip.get("title") or chip.get("text") or "", bold)
    venue = clean_text(chip.get("venue") or "", body)
    free = chip.get("free") is True
    free_em, free_h, free_pad, free_gap = 26, 36, 12, 10
    free_w = text_width("FREE", "bold", free_em) + 2 * (free_pad + 3) + free_gap if free else 0

    def measure(ln, em):
        return text_width(" ".join(ln), "bold", em)

    words = title.split() or [""]
    hi, lo = CARD["title_em"], CARD["title_min"]
    em, lines = fit_lines(words, measure, col_w,
                          [(1, hi, hi), (2, hi, lo), (3, lo, 30)])
    lines = [" ".join(ln) for ln in lines]
    # The pill may reach a little into the right padding, as it does in the ad.
    if free and measure(lines[-1].split(), em) + free_w > col_w + 12:
        lines.append("")  # the FREE pill gets a line of its own
    pitch = em * CARD["title_pitch"]
    cap = _cap("bold", em)
    tag_em, tag_h = CARD["tag_em"], CARD["tag_h"]
    venue_em = CARD["venue_em"]
    venue = _ellipsize(venue, "body", venue_em, col_w)
    vcap = _cap("body", venue_em)
    # The stack, top to bottom, from the inner top edge.
    y = CARD["pad_t"]
    tag_top = y
    if tag:
        y += tag_h + 22
    title_base = y + cap
    y = title_base + (len(lines) - 1) * pitch
    if venue:
        venue_base = y + 24 + vcap
        y = venue_base
    inner_h = y + CARD["pad_b"] + (6 if not venue else 0)
    h = inner_h + 2 * line
    if icon is not None:
        h = max(h, CARD["icon"] + 2 * (line + 24))
    s = _Surface(W + drop, h + drop)
    s.panel(0, 0, W, h, CARD["radius"], WHITE, ink, line=line, drop=drop)
    off = line + (h - 2 * line - inner_h) / 2  # the text stack, centred
    if icon is not None:
        size = CARD["icon"]
        k = size / max(icon.width, icon.height)
        iw, ih = icon.width * k, icon.height * k
        s.paste(icon, CARD["icon_x"] - iw / 2, h / 2 - ih / 2, iw, ih)
    if tag:
        tag = _ellipsize(tag, "bold", tag_em, col_w - 40)
        tw = text_width(tag, "bold", tag_em)
        top = off + tag_top
        s.panel(text_x, top, text_x + tw + 2 * 18 + 8, top + tag_h, tag_h / 2, hl, ink, line=4, drop=0)
        s.text(text_x + 4 + 18, top + tag_h / 2 + _cap("bold", tag_em) / 2, tag, "bold", tag_em, ink)
    for i, ln in enumerate(lines):
        if ln:
            s.text(text_x, off + title_base + i * pitch, ln, "bold", em, ink)
    if free:
        last = lines[-1]
        x = text_x + (text_width(last, "bold", em) + free_gap if last else 0)
        yc = off + title_base + (len(lines) - 1) * pitch - cap / 2
        fw = free_w - free_gap
        s.panel(x, yc - free_h / 2, x + fw, yc + free_h / 2, free_h / 2, GREEN, ink, line=3, drop=0)
        s.text(x + fw / 2, yc + _cap("bold", free_em) / 2, "FREE", "bold", free_em, WHITE, anchor="ms")
    if venue:
        s.text(text_x, off + venue_base, venue, "body", venue_em, muted)
    return s.image(), {"em": em, "title": [x for x in lines if x], "tag": tag, "venue": venue,
                       "icon": icon is not None, "size": (W, h)}


# ------------------------------------------------------------------ pictures: the phone

def phone_picture(screen, pal):
    """A phone like the one in Tristen's ad: an ink body with a paper bezel,
    a notch, a hard ink shadow thrown right and a soft one beyond it, showing
    the top of `screen`. Returns (picture, (x, y) of the body in it)."""
    ink, paper = pal["ink"], pal["paper"]
    w, h, r = PHONE["width"], PHONE["height"], PHONE["radius"]
    line, bezel, top, sl = PHONE["line"], PHONE["bezel"], PHONE["top"], PHONE["screen_line"]
    dx, dy = PHONE["drop"]
    soft = 22
    s = _Surface(w + dx + 2 * soft, h + dy + 2 * soft)
    ox, oy = 4, 4
    shadow = Image.new("RGBA", s.im.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        [round((ox + dx + 8) * SS), round((oy + dy + 8) * SS), round((ox + w + dx + 8) * SS),
         round((oy + h + dy + 8) * SS)], radius=round(r * SS), fill=_rgba(ink, 70))
    s.im.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(6 * SS)))
    s.rect(ox + dx, oy + dy, ox + w + dx, oy + h + dy, r, ink)
    s.rect(ox, oy, ox + w, oy + h, r, ink)
    s.rect(ox + line, oy + line, ox + w - line, oy + h - line, r - line, paper)
    x0, y0, x1, y1 = ox + line + bezel, oy + top, ox + w - line - bezel, oy + h - line - bezel
    sr = PHONE["screen_radius"]
    s.rect(x0, y0, x1, y1, sr, ink)
    x0, y0, x1, y1 = x0 + sl, y0 + sl, x1 - sl, y1 - sl
    sw, sh = x1 - x0, y1 - y0
    if screen is not None:
        shot = screen.convert("RGBA")
        crop_h = min(shot.height, round(shot.width * sh / sw))
        shot = shot.crop((0, 0, shot.width, crop_h)).resize((round(sw * SS), round(sh * SS)), Image.LANCZOS)
        mask = Image.new("L", shot.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, shot.width - 1, shot.height - 1],
                                               radius=round((sr - sl) * SS), fill=255)
        shot.putalpha(mask)
        s.im.alpha_composite(shot, (round(x0 * SS), round(y0 * SS)))
    else:
        s.rect(x0, y0, x1, y1, sr - sl, WHITE)
    nw, nh, ny = PHONE["notch"]
    s.rect(ox + w / 2 - nw / 2, oy + ny, ox + w / 2 + nw / 2, oy + ny + nh, nh / 2, ink)
    return s.image(), (ox, oy)


# ------------------------------------------------------------------ pictures: the end card

def _gradient(w, h, top, bottom):
    col = Image.new("RGB", (1, 256))
    col.putdata([_mix(top, bottom, i / 255) for i in range(256)])
    return col.resize((w, h), Image.BILINEAR).convert("RGBA")


def end_card_picture(plan, town, pal, layout):
    """The last 1.5-2 s: the logo, the wordmark ("The Vic" + its 361 badge),
    the tagline with the town's name highlighted, a "Sign up free" button and
    the sign-up address, on the site's sky-to-paper background."""
    bold, _ = fonts()
    body = body_font()
    spec = LAYOUTS[layout]
    W, H = spec["size"]
    L, T, R, B = spec["safe"]
    ink, hl, primary = pal["ink"], pal["highlight"], pal["primary"]
    ec = plan.get("end_card") or {}
    city, domain = town["city"], town["domain"]

    def fill(s):
        return str(s or "").replace("{city}", city).replace("{domain}", domain)

    # The older plans (line1/line2) still work: line1 as the tagline, line2
    # (the domain) as the address under the button.
    tagline = clean_text(fill(ec.get("tagline") or ec.get("line1") or ""), body)
    button = clean_text(fill(ec.get("button") or "Sign up free"), bold)
    url = clean_text(fill(ec.get("url") or ec.get("line2") or "{domain}/subscribe"), body)
    room = (R - L) - 40
    s = _Surface(W, H)
    s.im.paste(_gradient(W * SS, H * SS, SKY, pal["paper"]), (0, 0))
    logo = _logo(town)
    mark_text, mark_badge = wordmark(town)
    mark_text, mark_badge = clean_text(mark_text, bold), clean_text(mark_badge, bold)
    # The wordmark: as big as Tristen's, smaller only if it won't fit.
    me = END["mark_em"]
    bl, bd = END["box_line"], END["box_drop"]

    def mark_w(em):
        k = em / END["mark_em"]
        return (text_width(mark_text, "bold", em) + (28 * k + text_width(mark_badge, "bold", em) + 2 * (30 * k + bl)
                if mark_badge else 0) + bd)

    while me > 40 and mark_w(me) > room:
        me -= 2
    k = me / END["mark_em"]
    box_h = 147 * k
    # The tagline: two lines at Tristen's size if they fit, else smaller, else three.
    words = tagline.split()
    # The town's name stays on one line: its words travel as one token.
    marked = town_words(words, town)
    words = [w for w in words]
    for i in sorted(marked, reverse=True):
        if i - 1 in marked and i < len(words):
            words[i - 1:i + 1] = [words[i - 1] + NBSP + words[i]]
    te, tlines = (END["tag_em"], []) if not words else fit_lines(
        words, lambda ln, em: text_width(" ".join(ln), "body", em), min(room, END["tag_w"]),
        [(1, END["tag_em"], END["tag_em"]), (2, END["tag_em"], END["tag_min"]), (3, END["tag_em"], 36)])
    tpitch = END["tag_pitch"] * te / END["tag_em"]
    tcap = _cap("body", te)
    be = END["button_em"]
    bw = text_width(button, "bold", be) + 2 * END["button_pad"]
    while bw > room and be > 30:
        be -= 2
        bw = text_width(button, "bold", be) + 2 * END["button_pad"] * be / END["button_em"]
    bh = END["button_h"] * be / END["button_em"]
    ue = END["url_em"]
    while ue > 24 and text_width(url, "body", ue) > room:
        ue -= 1
    ucap = _cap("body", ue)
    # The stack, from the top of the logo, with Tristen's gaps.
    logo_h = END["logo"] if logo is not None else 0
    y = 0.0
    parts = {}
    parts["logo"] = y
    y += logo_h + (49 if logo is not None else 0)
    parts["box"] = y
    y += box_h + 55
    parts["tag_base"] = y + tcap
    y = parts["tag_base"] + (len(tlines) - 1) * tpitch if tlines else y - 55
    y += 56 if tlines else 49
    parts["button"] = y
    y += bh + 56
    parts["url_base"] = y + ucap
    total = parts["url_base"] + 10
    top = T + max(0.0, (B - T - total) / 2)
    cx = W / 2
    if logo is not None:
        s.paste(logo, cx - logo_h / 2, top + parts["logo"], logo_h, logo_h)
    # Wordmark, centred as a whole; the badge's box is centred on the caps.
    mcap = _cap("bold", me)
    tw1 = text_width(mark_text, "bold", me)
    tw2 = text_width(mark_badge, "bold", me) if mark_badge else 0
    bx_w = tw2 + 2 * (30 * k + bl)
    total_w = tw1 + (28 * k + bx_w if mark_badge else 0)
    x = cx - (total_w + (bd if mark_badge else 0)) / 2
    yc = top + parts["box"] + box_h / 2
    base = yc + mcap / 2
    s.text(x, base, mark_text, "bold", me, ink)
    if mark_badge:
        bx = x + tw1 + 28 * k
        s.panel(bx, yc - box_h / 2, bx + bx_w, yc + box_h / 2, 22 * k, hl, ink, line=bl, drop=bd)
        s.text(bx + bx_w / 2, base, mark_badge, "bold", me, ink, anchor="ms")
    # Tagline, each line centred, the town's name on a highlighter stroke.
    names = [w for w in [re.sub(r"(?i)^the\s+", "", city)] + TOWN_ALIASES.get(town["slug"], [])]
    for i, ln in enumerate(tlines):
        text = " ".join(ln).replace(NBSP, " ")
        lw = text_width(text, "body", te)
        x0 = cx - lw / 2
        yb = top + parts["tag_base"] + i * tpitch
        line_words = text.split(" ")
        marked = sorted(town_words(line_words, town))
        if marked:
            # One stroke from the first word of the name to the end of its last.
            a = text_width(" ".join(line_words[:marked[0]]) + (" " if marked[0] else ""), "body", te)
            b = text_width(" ".join(line_words[:marked[-1]] + [line_words[marked[-1]].rstrip(",.;:!?")]),
                           "body", te)
            s.rect(x0 + a - 8, yb - 0.27 * te, x0 + b + 6, yb + 0.34 * te, 0, hl)
        s.text(x0, yb, text, "body", te, ink)
    # The button and the address under it.
    by = top + parts["button"]
    s.panel(cx - bw / 2, by, cx + bw / 2, by + bh, bh / 2, primary, ink, line=7, drop=10)
    s.text(cx, by + bh / 2 + _cap("bold", be) / 2, button, "bold", be, WHITE, anchor="ms")
    s.text(cx, top + parts["url_base"], url, "body", ue, _mix(ink, WHITE, 0.15), anchor="ms")
    img = s.image().convert("RGB").convert("RGBA")
    return img, {"tagline": [" ".join(ln) for ln in tlines], "button": button, "url": url,
                 "wordmark": [mark_text, mark_badge], "top": round(top), "bottom": round(top + total),
                 "names": names}


# ------------------------------------------------------------------ the face

def face_model_path():
    """YuNet's model (setup.sh fetches it into the cache), or None."""
    for p in (os.environ.get("VIDEO_FACE_MODEL"), os.path.join(_cache_base(), "models", YUNET)):
        if p and os.path.isfile(p):
            return p
    return None


def _source_frame(cut, t):
    """The kept source frame (on the cut's 30 fps grid, from its seek point)
    shown at output time t."""
    c = int(round(t * cut["speed"] * FPS))
    for f0, n in cut["frames"]:
        if c < n:
            return f0 + c
        c -= n
    f0, n = cut["frames"][-1]
    return f0 + n - 1  # the held last frame


_FACES = {}


def detect_faces(info, cut, until, *, every=FACE_EVERY):
    """Where the face is in the kept footage, every `every` s of output time
    up to `until`: ({"detector", "samples"}, [(t, (x0, y0, x1, y1))]) with the
    boxes as fractions of the upright source frame, the biggest face in each
    frame that has one. OpenCV's YuNet when its model is in the cache, else
    (and in a frame where YuNet finds nothing) the Haar cascade OpenCV ships
    with. No OpenCV: no faces, and the cards take a fixed slot."""
    try:
        import cv2
        import numpy as np
    except ImportError:
        return {"detector": None, "samples": 0, "why": "OpenCV is not installed (setup.sh)"}, []
    times = [round(i * every, 3) for i in range(int(max(0.0, until) / every) + 1)]
    key = (info.get("path"), os.path.getmtime(info["path"]) if os.path.exists(info.get("path") or "") else 0,
           tuple(cut["frames"]), cut["speed"], cut["base"], tuple(times))
    if key in _FACES:
        return _FACES[key]
    sw, sh = info.get("width") or 0, info.get("height") or 0
    if not (sw and sh and times):
        return {"detector": None, "samples": 0, "why": "no picture size"}, []
    w = FACE_WIDTH
    h = max(2, int(round(sh * w / sw / 2)) * 2)
    wanted = sorted({_source_frame(cut, t) for t in times})
    sel = "+".join(f"eq(n,{f})" for f in wanted)
    out = _run(["ffmpeg", "-hide_banner", "-nostdin", "-v", "error"] + _input_args(info, cut)
               + ["-map", f"0:{info['video_index']}", "-vf",
                  f"fps={FPS}:start_time=0,select='{sel}',scale={w}:{h},format=bgr24",
                  "-fps_mode", "passthrough", "-f", "rawvideo", "-"], binary=True, what="face frames",
               timeout=600).stdout
    size = w * h * 3
    frames = {f: np.frombuffer(out[i * size:(i + 1) * size], np.uint8).reshape(h, w, 3)
              for i, f in enumerate(wanted) if (i + 1) * size <= len(out)}
    model = face_model_path()
    yunet = None
    if model and hasattr(cv2, "FaceDetectorYN"):
        try:
            yunet = cv2.FaceDetectorYN.create(model, "", (w, h), 0.6)
        except cv2.error:
            yunet = None
    haar = cv2.CascadeClassifier(os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml"))
    used = set()
    found = {}
    for f, img in frames.items():
        boxes = []
        if yunet is not None:
            _, res = yunet.detect(img)
            boxes = [tuple(float(v) for v in r[:4]) for r in (res if res is not None else [])]
            if boxes:
                used.add("yunet")
        if not boxes and not haar.empty():
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            boxes = [tuple(float(v) for v in b) for b in haar.detectMultiScale(
                gray, scaleFactor=1.1, minNeighbors=5, minSize=(w // 10, w // 10))]
            if boxes:
                used.add("haar")
        if boxes:
            x, y, bw, bh = max(boxes, key=lambda b: b[2] * b[3])
            found[f] = (max(0.0, x / w), max(0.0, y / h), min(1.0, (x + bw) / w), min(1.0, (y + bh) / h))
    faces = [(t, found[_source_frame(cut, t)]) for t in times if _source_frame(cut, t) in found]
    meta = {"detector": "+".join(sorted(used)) or None, "samples": len(times), "found": len(faces),
            "yunet_model": bool(yunet)}
    _FACES[key] = (meta, faces)
    return meta, faces


def canvas_box(box, info, layout):
    """A box in fractions of the source frame, in the layout's canvas px
    (the same fit as _canvas: a portrait take covers and is cropped, a
    landscape one sits across the middle of the safe zone)."""
    W, H = LAYOUTS[layout]["size"]
    safe = LAYOUTS[layout]["safe"]
    sw, sh = info.get("width") or W, info.get("height") or H
    x0, y0, x1, y1 = box
    if sh >= sw:
        k = max(W / sw, H / sh)
        cw, ch = max(W, _even(sw * k)), max(H, _even(sh * k))
        ox, oy = (cw - W) // 2, int((ch - H) * TOP_BIAS)
        return (x0 * cw - ox, y0 * ch - oy, x1 * cw - ox, y1 * ch - oy)
    fh = min(H, _even(sh * W / sw))
    oy = int(min(max(0, (safe[1] + safe[3]) / 2 - fh / 2), H - fh))
    return (x0 * W, y0 * fh + oy, x1 * W, y1 * fh + oy)


def _median(vals):
    vals = sorted(vals)
    n = len(vals)
    return (vals[n // 2] + vals[(n - 1) // 2]) / 2 if n else None


def face_during(faces, start, end):
    """The face box to keep a card off between start and end: the median
    box over the whole cut, or, where he moves, the span of every box seen
    while the card is up. Stray detections (far from the median face) are
    ignored. None with no face."""
    if not faces:
        return None
    med = tuple(_median([b[i] for _, b in faces]) for i in range(4))
    mh = med[3] - med[1]
    ok = [b for _, b in faces
          if abs((b[1] + b[3]) / 2 - (med[1] + med[3]) / 2) < 0.6 * mh + 40 and 0.5 < (b[3] - b[1]) / mh < 2.0]
    near = [b for t, b in faces if start - 0.25 <= t <= end + 0.25 and b in ok]
    if not near:
        return med
    return (min(b[0] for b in near), min(b[1] for b in near), max(b[2] for b in near), max(b[3] for b in near))


def place_card(h, face, lo, hi, *, margin=CARD_MARGIN):
    """Where a card h px tall (with its shadow) goes, between lo (under the
    badge) and hi (over the captions): (y, scale, slot), off the eye band
    (the top EYE_BAND of the face box) whatever happens.

    1. just under the chin, pulled up to clear the captions as long as it
       stays under the mouth;
    2. above the head, under the badge;
    3. over the chest: the space between the eyes and the captions, the
       card shrunk (to CARD_MIN_SCALE) if it must be.
    With no face, the fixed slot over the captions."""
    if face is None:
        return hi - h, 1.0, "fixed"
    fy0, fy1 = face[1], face[3]
    fh = max(1.0, fy1 - fy0)
    eye_bottom = fy0 + EYE_BAND * fh
    y = min(fy1 + margin, hi - h)
    if y >= lo and y >= fy1 - 0.08 * fh:
        return y, 1.0, "below-chin"
    if lo + h <= fy0 - 8:
        return lo, 1.0, "above-head"
    top = max(lo, eye_bottom + margin)
    room_low, room_high = hi - top, (fy0 - 8) - lo
    s = min(1.0, room_low / h)
    if s >= CARD_MIN_SCALE:
        return hi - h * s, s, "lower-third"
    # Nowhere it fits at the smallest size: the bigger gap, the card as
    # small as the gap needs (an extreme close-up).
    if room_high > room_low:
        s = max(0.5, room_high / h)
        return lo, s, "above-head-small"
    s = max(0.5, room_low / h)
    return hi - h * s, s, "lower-third-small"


def _caption_top(spec):
    """The top of the captions' ink (ascenders and outline) on this layout."""
    em = spec["caption_em"]
    return spec["caption_y"] - 0.52 * em


# ------------------------------------------------------------------ pictures: timing

def _enter(img, kind, n):
    """The entrance frames, then the resting picture, all one size: "slide"
    rises SLIDE_PX and fades in (Tristen's cards), "pop" grows from POP_FROM
    and fades in, "fade" only fades, "black" comes up from black."""
    if kind == "none" or n <= 0:
        return [img]
    W, H = img.size
    out = []
    for i in range(n):
        p = (i + 1) / (n + 1) if kind != "black" else i / n
        if kind == "slide":
            fr = Image.new("RGBA", (W, H + SLIDE_PX), (0, 0, 0, 0))
            fr.alpha_composite(_alpha(img, min(1.0, p * 1.25)), (0, round(SLIDE_PX * (1 - p))))
        elif kind == "pop":
            e = 1 - (1 - p) ** 2
            sc = POP_FROM + (1 - POP_FROM) * e
            small = img.resize((max(1, round(W * sc)), max(1, round(H * sc))), Image.LANCZOS)
            fr = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            fr.alpha_composite(_alpha(small, min(1.0, p * 1.3)), ((W - small.width) // 2, (H - small.height) // 2))
        elif kind == "fade":
            fr = _alpha(img, p)
        elif kind == "black":
            fr = Image.blend(Image.new("RGBA", (W, H), (0, 0, 0, 255)), img, p)
        else:
            raise ValueError(f"unknown entrance {kind!r}")
        out.append(fr)
    if kind == "slide":
        rest = Image.new("RGBA", (W, H + SLIDE_PX), (0, 0, 0, 0))
        rest.alpha_composite(img, (0, 0))
        out.append(rest)
    else:
        out.append(img)
    return out


def _sprite(name, frames, x, y, start, end, *, fade_out=0, box=None, **extra):
    f0, f1 = round(start * FPS), round(end * FPS)
    if f1 <= f0:
        return None
    w, h = frames[-1].size
    sp = {"name": name, "frames": frames, "x": int(round(x)), "y": int(round(y)), "start": f0 / FPS,
          "end": f1 / FPS, "fade_out": fade_out, "box": box or (int(round(x)), int(round(y)),
                                                                 int(round(x)) + w, int(round(y)) + h)}
    sp.update(extra)
    return sp


def card_spans(plan, es=None):
    """When each chip's card is up: the plan's times with its rules enforced
    again (no two at once, gone by the sign-up line and the end card) and
    none while the phone shows. [(chip, start, end)]"""
    chips = [c for c in plan.get("chips") or [] if c.get("text") or c.get("title")]
    chips = sorted(chips, key=lambda c: float(c["start"]))
    if es is None:
        ec = plan.get("end_card") or {}
        es = float(ec["start"]) if ec else float(plan["duration"])
    cta = plan.get("cta_start")
    phone = plan.get("phone") or None
    p0 = float(phone["start"]) if phone else None
    p1 = min(float(phone["end"]), es) if phone else None
    out = []
    for n, chip in enumerate(chips):
        start = float(chip["start"])
        end = min(float(chip["end"]), es)
        if n + 1 < len(chips):
            end = min(end, float(chips[n + 1]["start"]))
        elif cta is not None and float(cta) > start:
            end = min(end, float(cta))
        if phone and p1 > p0:
            if start < p0:
                end = min(end, p0)
            elif start < p1:
                start = p1
        if end - start >= 0.1:
            out.append((chip, start, end))
    return out


def build_sprites(plan, layout="4x5", *, screen=None, faces=None):
    """The pictures laid over the video for one layout, and where they went.

    Returns (sprites, geo). A sprite is {"name", "frames" (PIL RGBA pictures:
    the entrance, then the one it rests on), "x", "y" (top-left on the
    canvas), "start", "end" (seconds, on the frame grid), "fade_out" (frames),
    "box" (what it covers)}. screen: the site's screenshot for the phone (a
    PIL image or a path); without it there is no phone. faces: [(t, box)]
    where the face is, in canvas px (detect_faces + canvas_box); the cards
    keep off its eyes (place_card). None or []: the cards take a fixed slot.
    """
    if layout not in LAYOUTS:
        raise ValueError(f"unknown layout {layout!r}; one of {', '.join(LAYOUTS)}")
    spec = LAYOUTS[layout]
    W, H = spec["size"]
    L, T, R, B = spec["safe"]
    town = towns.town(plan["town"])
    pal = town["palette"]
    duration = float(plan["duration"])
    ec = plan.get("end_card") or {}
    es = min(float(ec["start"]), duration) if ec else duration
    logo = _logo(town)
    sprites, geo = [], {"canvas": (W, H), "safe": spec["safe"], "notes": []}

    def add(sp, key=None):
        if sp:
            sprites.append(sp)
            if key:
                entry = {k: sp[k] for k in ("name", "start", "end", "box")}
                entry.update({"info": sp["info"]} if "info" in sp else {})
                geo.setdefault(key, []).append(entry)
        return sp

    # The badge: the hook while it is up, then "Subscribe free" to the end card.
    hook = plan.get("hook") or {}
    h_end = min(float(hook.get("end") or 0.0), es)
    sub_from = 0.0
    made = hook_badge(hook.get("text") or "", town, pal, logo, max_w=R - L) if h_end > 0 else None
    if made:
        img, info = made
        x = (W - img.width) / 2
        sp = add(_sprite("badge-hook", [img], x, spec["badge_top"], 0.0, h_end, fade_out=BADGE_OUT_FRAMES,
                         box=(round(x), spec["badge_top"], round(x) + img.width, spec["badge_top"] + img.height),
                         info=info), "badge")
        if sp:
            sub_from = sp["end"]
    if es - sub_from >= 0.1:
        img, info = subscribe_badge(town, pal, logo, max_w=R - L)
        x = (W - img.width) / 2
        add(_sprite("badge-subscribe", _enter(img, "fade", FADE_FRAMES) if sub_from > 0 else [img],
                    x, spec["badge_top"], sub_from, es,
                    box=(round(x), spec["badge_top"], round(x) + img.width, spec["badge_top"] + img.height),
                    info=info), "badge")
    # The event cards, one at a time, kept off his eyes.
    no_icon = []
    badge_bottom = max([b["box"][3] for b in geo.get("badge", [])] or [T])
    lo, hi = badge_bottom + 20, min(B, _caption_top(spec)) - 16
    for n, (chip, start, end) in enumerate(card_spans(plan, es)):
        img, info = event_card(chip, pal)
        if chip.get("icon") and not info["icon"]:
            no_icon.append(chip["icon"])
        face = face_during(faces or [], start, end)
        y, scale, slot = place_card(img.height, face, lo, hi)
        if scale < 1:
            img = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
        x = (W - img.width) / 2
        info.update({"y": round(y), "slot": slot, "scale": round(scale, 3),
                     "face": [round(v) for v in face] if face else None})
        add(_sprite(f"card{n + 1}", _enter(img, "slide", SLIDE_FRAMES), x, y, start, end,
                    box=(round(x), round(y), round(x) + img.width, round(y) + img.height), info=info), "cards")
    if no_icon:
        geo["notes"].append("no colour emoji font for the card icons (%s): run setup.sh, or set "
                            "VIDEO_EMOJI_FONT" % " ".join(no_icon) if not emoji_font_path() else
                            "the emoji font has no %s: those cards have no icon" % " ".join(no_icon))
    # The phone, when a phone cue was said.
    phone = plan.get("phone") or None
    if phone:
        p0, p1 = float(phone["start"]), min(float(phone["end"]), es)
        if screen is None:
            geo["notes"].append("no screenshot of the site for the phone (no Chrome, or it failed, and none "
                                "cached): the video has no phone")
        elif p1 - p0 >= 0.3:
            shot = Image.open(screen) if isinstance(screen, (str, os.PathLike)) else screen
            img, (ox, oy) = phone_picture(shot, pal)
            dx, dy = PHONE["drop"]
            x = W / 2 - (PHONE["width"] + dx) / 2 - ox
            y = spec["phone_y"] - PHONE["height"] / 2 - oy
            add(_sprite("phone", _enter(img, "pop", POP_FRAMES), x, y, p0, p1, fade_out=PHONE_OUT_FRAMES,
                        box=(round(x + ox), round(y + oy), round(x + ox + PHONE["width"] + dx),
                             round(y + oy + PHONE["height"] + dy))), "phone")
    # The end card, up from black, to the last frame.
    if ec:
        img, info = end_card_picture(plan, town, pal, layout)
        add(_sprite("end-card", _enter(img, "black", BLACK_FRAMES), 0, 0, es, duration, info=info,
                    box=(0, 0, W, H)), "end_card")
        geo["end_card_info"] = info
    return sprites, geo


# ------------------------------------------------------------------ the cut

def check_plan(plan):
    for key in ("video_id", "town", "source", "segments", "duration"):
        if key not in plan:
            raise ValueError(f"plan is missing {key!r}")
    # It names the output folder (and a line of the ASS file): a hand-edited
    # "../x" or a stray newline must not write outside it or add a line.
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}", str(plan["video_id"])):
        raise ValueError(f"video_id {plan['video_id']!r} must be a plain name like victoria-1")
    segs = plan["segments"]
    if not segs:
        raise ValueError("plan has no segments")
    last = -1.0
    for seg in segs:
        a, b = float(seg["start"]), float(seg["end"])
        if not b > a:
            raise ValueError(f"segment {a}..{b} is empty")
        if a < last - 1e-6:
            raise ValueError("segments overlap or are out of order")
        last = b
    if not float(plan["duration"]) > 0:
        raise ValueError("plan duration must be positive")
    speed = float(plan.get("speed") or 1.0)
    if not 0.5 <= speed <= 2.0:
        raise ValueError(f"speed {speed} is outside 0.5..2")
    towns.town(plan["town"])


def cut_plan(plan, info):
    """Which source frames to keep, on the 30 fps grid.

    Each segment starts on the frame nearest its planned start, and its
    length is chosen so the joined timeline never drifts more than half a
    frame from the plan's: rounding every cut on its own could walk the
    captions several frames off the voice by the end. Audio is cut at the
    same frame boundaries (1600 samples each), so the streams match exactly.
    """
    end_of_source = info.get("duration") or 0.0
    # Where each stream ends on ffmpeg's clock: a sound track that starts
    # 0.3 s late also ends 0.3 s later than its duration alone says.
    ends = [e for e in (info.get("video_end") or info.get("video_duration"),
                        info.get("audio_end") or info.get("audio_duration")) if e]
    if ends:
        end_of_source = min(ends)
    segs = []
    for seg in plan["segments"]:
        a, b = max(0.0, float(seg["start"])), float(seg["end"])
        if end_of_source:
            b = min(b, end_of_source)
        if b > a:
            segs.append((a, b))
    if not segs:
        raise RenderError("every segment is past the end of the source")
    # Decoding a 4K HEVC take from the top to reach a second take is most of
    # the run time; seek to a second before the first segment instead.
    base = 0.0
    if segs[0][0] > 3.0:
        base = math.floor((segs[0][0] - 1.0) * FPS) / FPS
    frames, planned, have = [], 0.0, 0
    for a, b in segs:
        planned += b - a
        n = round(planned * FPS) - have
        if n <= 0:
            continue
        frames.append((max(0, round((a - base) * FPS)), n))
        have += n
    speed = float(plan.get("speed") or 1.0)
    total = max(1, round(float(plan["duration"]) * FPS))
    content = have / FPS / speed
    return {
        "base": base,
        "length": segs[-1][1] - base + 1.0,
        "frames": frames,
        "speed": speed,
        "total_frames": total,
        "total_samples": total * SAMPLES_PER_FRAME,
        "duration": total / FPS,
        "content": content,
        "kept": [(round(base + f0 / FPS, 4), round(base + (f0 + n) / FPS, 4)) for f0, n in frames],
    }


# ------------------------------------------------------------------ colour

def _in_matrix(info):
    cs = info.get("color_space") or ""
    if cs.startswith("bt2020"):
        return "bt2020"
    if cs in ("smpte170m", "bt470bg"):
        return "bt601"
    if cs == "bt709" or (info.get("height") or 0) >= 720 or (info.get("width") or 0) >= 720:
        return "bt709"
    return "bt601"


def _in_range(info):
    return "pc" if info.get("color_range") == "pc" or "yuvj" in (info.get("pix_fmt") or "") else "tv"


def hdr_mode(info, filters=None):
    """How this render will turn HDR into SDR: "zscale", "lut" or None."""
    if not info.get("hdr"):
        return None
    filters = ffmpeg_filters() if filters is None else filters
    if {"zscale", "tonemap"} <= filters:
        return "zscale"
    if "lut3d" in filters:
        return "lut"
    return None


def _peak(info):
    if info.get("hdr") == "pq":
        return max(HDR_REF_NITS, float(info.get("peak_nits") or 1000.0))
    return 1000.0  # HLG's reference display


def _fit_filters(info, w, h, mode, lut="hdr.cube"):
    """Resize to w x h and convert to SDR BT.709 RGB (gbrp)."""
    if mode == "zscale":
        tin = "arib-std-b67" if info["hdr"] == "hlg" else "smpte2084"
        pin = info.get("color_primaries")
        pin = pin if pin in ("bt709", "bt2020", "smpte431", "smpte432") else "bt2020"
        min_ = "bt2020nc" if not (info.get("color_space") or "").startswith("bt2020c") else "bt2020c"
        rin = "full" if _in_range(info) == "pc" else "limited"
        return [f"zscale=w={w}:h={h}:filter=lanczos:tin={tin}:pin={pin}:min={min_}:rin={rin}"
                f":t=linear:npl={HDR_REF_NITS:g}",
                "format=gbrpf32le", "zscale=p=bt709",
                f"tonemap=tonemap=mobius:param={HDR_ROLLOFF}:desat={HDR_DESAT}"
                f":peak={_peak(info) / HDR_REF_NITS:.4f}",
                "zscale=t=bt709:dither=error_diffusion", "format=gbrp"]
    if mode == "lut":
        return [f"scale=w={w}:h={h}:flags=lanczos+accurate_rnd+full_chroma_int"
                f":in_color_matrix=bt2020:in_range={_in_range(info)}",
                "format=gbrp16le", f"lut3d=file={lut}", "format=gbrp"]
    return [f"scale=w={w}:h={h}:flags=lanczos+accurate_rnd+full_chroma_int"
            f":in_color_matrix={_in_matrix(info)}:in_range={_in_range(info)}", "format=gbrp"]


def hdr_lut(kind, peak_nits=1000.0, size=33):
    """A .cube 3D LUT from HLG or PQ BT.2020 RGB to SDR BT.709 RGB, the same
    curve as the zscale path (ref white to SDR white, mobius roll-off), for
    an ffmpeg without zscale."""
    a, b, c = 0.17883277, 0.28466892, 0.55991073
    m1, m2, c1, c2, c3 = 0.1593017578125, 78.84375, 0.8359375, 18.8515625, 18.6875
    to709 = ((1.6605, -0.5876, -0.0728), (-0.1246, 1.1329, -0.0083), (-0.0182, -0.1006, 1.1187))
    peak = peak_nits / HDR_REF_NITS
    j = HDR_ROLLOFF

    def hlg(e):
        return e * e / 3 if e <= 0.5 else (math.exp((e - c) / a) + b) / 12

    def pq(e):
        p = e ** (1 / m2)
        return (max(p - c1, 0) / (c2 - c3 * p)) ** (1 / m1) * 10000 / HDR_REF_NITS

    def mobius(x):
        if x <= j:
            return x
        aa = -j * j * (peak - 1) / (j * j - 2 * j + peak)
        bb = (j * j - 2 * j * peak + peak) / max(peak - 1, 1e-6)
        return (bb * bb + 2 * bb * j + j * j) / (bb - aa) * (x + aa) / (x + bb)

    def encode(x):
        # Display light to an SDR signal: BT.1886's gamma 2.4, as zscale's
        # t=bt709 does from linear (the camera-side BT.709 OETF would leave
        # midtones a stop darker than the zscale path).
        return min(max(x, 0.0), 1.0) ** (1 / 2.4)

    rows = [f"LUT_3D_SIZE {size}"]
    for bi in range(size):
        for gi in range(size):
            for ri in range(size):
                rgb = [ri / (size - 1), gi / (size - 1), bi / (size - 1)]
                if kind == "hlg":
                    # HLG's system gamma (1.2 on a 1000-nit display) applied
                    # per channel, as zimg does, rather than on luminance as
                    # BT.2100 has it: this LUT stands in for zscale, so both
                    # paths give the same picture.
                    lin = [1000.0 / HDR_REF_NITS * hlg(v) ** 1.2 for v in rgb]
                else:
                    lin = [pq(v) for v in rgb]
                lin = [sum(m * v for m, v in zip(row, lin)) for row in to709]
                luma = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
                if HDR_DESAT > 0 and luma > 0:
                    over = max(luma - HDR_DESAT, 1e-6) / max(luma, 1e-6)
                    lin = [v * (1 - over) + luma * over for v in lin]
                sig = max(max(lin), 1e-6)
                lin = [v * mobius(sig) / sig for v in lin]
                rows.append(" ".join(f"{encode(v):.6f}" for v in lin))
    return "\n".join(rows) + "\n"


def _canvas(info, W, H, mode, safe):
    """Filter chains from [cut] to [canvas]: the take filling W x H as RGB."""
    sw, sh = info["width"] or W, info["height"] or H
    if sh >= sw:
        # Portrait (or square): cover the canvas and crop.
        k = max(W / sw, H / sh)
        cw, ch = max(W, _even(sw * k)), max(H, _even(sh * k))
        x, y = (cw - W) // 2, int((ch - H) * TOP_BIAS)
        return ["[cut]" + ",".join(_fit_filters(info, cw, ch, mode)
                                   + [f"crop={W}:{H}:{x}:{y}", "setsar=1"]) + "[canvas]"]
    # Landscape: the whole frame across the middle, over a blurred and
    # darkened copy of itself filling the canvas. Centred on the safe zone,
    # not the canvas, so on a reel the hook and chips sit above the picture
    # and the captions below it instead of on its bottom edge.
    fh = min(H, _even(sh * W / sw))
    y = int(min(max(0, (safe[1] + safe[3]) / 2 - fh / 2), H - fh))
    small_w, small_h = _even(W / 6), _even(H / 6)
    k = max(small_w / W, small_h / fh)
    bw, bh = max(small_w, _even(W * k)), max(small_h, _even(fh * k))
    fit = _fit_filters(info, W, fh, mode)
    return [
        "[cut]" + ",".join(fit + ["setsar=1", "split=2[fg][bgsrc]"]),
        f"[bgsrc]scale={bw}:{bh}:flags=bilinear,crop={small_w}:{small_h},gblur=sigma=6:steps=2,"
        f"scale={W}:{H}:flags=bicubic,colorchannelmixer=rr=0.5:gg=0.5:bb=0.5,setsar=1[bg]",
        f"[bg][fg]overlay=x=0:y={y}:format=gbrp[canvas]",
    ]


def _even(v):
    return max(2, int(round(v / 2)) * 2)


# ------------------------------------------------------------------ audio

_AFFTDN = "afftdn=nr=10:nf=-50"
_LATENCY = {}


def afftdn_latency():
    """Seconds afftdn delays audio without saying so in its timestamps.

    ffmpeg 6.1 shifts everything 25 ms late, which after a cut is 25 ms of
    lip-sync error; measured once on a click rather than hard-coded, so a
    fixed ffmpeg doesn't get "corrected" the other way.
    """
    if "s" not in _LATENCY:
        out = _run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i",
                    f"aevalsrc=exprs='0.5*sin(2*PI*1000*t)*between(t,0.5,0.7)':s={RATE}:d=1",
                    "-af", f"{_AFFTDN},aformat=sample_fmts=s16:channel_layouts=mono",
                    "-f", "s16le", "-"], timeout=60, binary=True, what="afftdn check")
        _LATENCY["s"] = _onset_delay(out.stdout, 0.5) if out.stdout else 0.0
    return _LATENCY["s"]


def _onset_delay(raw, at):
    n = len(raw) // 2
    samples = struct.unpack(f"<{n}h", raw[:2 * n])
    peak = max((abs(x) for x in samples), default=0)
    for i, x in enumerate(samples):
        if abs(x) > peak * 0.5:
            return max(0.0, round(i / RATE - at, 4))
    return 0.0


_PIN = f"aformat=sample_fmts=flt:sample_rates={RATE}:channel_layouts=stereo"


def _audio_prep(info, cut):
    """Filter chains from the source's audio to [aprep]: the kept audio cut
    on the same frames as the video, joined, retimed and cleaned up, exactly
    as long as the video, 48 kHz stereo float."""
    total = cut["total_samples"]
    n = len(cut["frames"])
    lat = afftdn_latency()
    shift = f",asetpts=PTS-{lat:.4f}/TB" if lat else ""
    # The trims below go by timestamp but the joins count samples, so the
    # two must agree: a sound track that starts after the picture (or has a
    # gap) gets silence there. Otherwise a segment kept from before the
    # sound started came out short and pulled every later word early (0.25 s
    # of lip-sync error for a track that starts 0.28 s in).
    sync = f"aresample={RATE}:async=1:min_hard_comp=0.02:first_pts=0"
    chains = [f"[0:{info['audio_index']}]{sync},{_PIN},highpass=f=80,{_AFFTDN}{shift}"
              + (f",asplit={n}" + "".join(f"[as{i}]" for i in range(n)) if n > 1 else "[as0]")]
    for i, (f0, nf) in enumerate(cut["frames"]):
        d = nf / FPS
        # The same frames as the video, in samples (the time base is 1/48000).
        # 10 ms fades at every cut: a waveform chopped mid-cycle clicks.
        chains.append(f"[as{i}]atrim=start_pts={f0 * SAMPLES_PER_FRAME}:end_pts={(f0 + nf) * SAMPLES_PER_FRAME},"
                      f"asetpts=PTS-STARTPTS,"
                      f"afade=t=in:d=0.01,afade=t=out:st={max(0.0, d - 0.01):.6f}:d=0.01[a{i}]")
    tail = ["".join(f"[a{i}]" for i in range(n)) + (f"concat=n={n}:v=0:a=1" if n > 1 else "anull")]
    if abs(cut["speed"] - 1.0) > 1e-6:
        tail.append(f"atempo={cut['speed']:.6f}")
    # The sample counts here are 48 kHz ones. A filter downstream that takes
    # one rate only (loudnorm: 192 kHz) makes ffmpeg resample as far upstream
    # as it can, which turned these into quarter-length cuts; pinning the
    # rate at both ends keeps the whole chain at 48 kHz.
    tail += [f"apad=whole_len={total}", f"atrim=end_sample={total}", _PIN]
    chains.append(",".join(tail) + "[aprep]")
    return chains


def prepare_audio(info, cut, path):
    """Write the render's audio, before loudness, to `path` (a float WAV).
    None when the source has no audio track."""
    if not info.get("has_audio"):
        return None
    _run(["ffmpeg", "-hide_banner", "-nostdin", "-nostats", "-v", "error", "-y"]
         + _input_args(info, cut)
         + ["-filter_complex", ";".join(_audio_prep(info, cut)), "-map", "[aprep]",
            "-c:a", "pcm_f32le", "-f", "wav", path], what="audio")
    return path


def measure_loudness(wav):
    """loudnorm's first pass over the prepared audio; None for silence."""
    r = _run(["ffmpeg", "-hide_banner", "-nostdin", "-nostats", "-i", wav, "-af",
              f"loudnorm=I={LOUDNESS['I']}:TP={LOUDNESS['TP']}:LRA={LOUDNESS['LRA']}:print_format=json",
              "-f", "null", "-"], what="loudnorm pass 1")
    blob = r.stderr[r.stderr.rfind("{"):r.stderr.rfind("}") + 1]
    try:
        m = json.loads(blob)
        i = float(m["input_i"])
    except (ValueError, KeyError):
        raise RenderError("loudnorm pass 1 printed no measurement") from None
    # Silence (or nearly): nothing to normalise, and -inf would break pass 2.
    if not math.isfinite(i) or i < -60:
        return None
    return m


def _audio_final(label, cut, loud):
    """From the prepared audio (or silence) to [aout]."""
    total = cut["total_samples"]
    if label is None:
        return [f"anullsrc=r={RATE}:cl=stereo,atrim=end_sample={total}[aout]"]
    parts = [label + _PIN]
    if loud:
        # loudnorm runs at 192 kHz; back to 48k and the exact length.
        parts += [_loudnorm_args(loud), f"aresample={RATE}", _PIN,
                  f"apad=whole_len={total}", f"atrim=end_sample={total}"]
    # The end card is the last thing on screen; let the room tone go quietly.
    parts.append(f"afade=t=out:st={max(0.0, cut['duration'] - 0.25):.4f}:d=0.25")
    return [",".join(parts) + "[aout]"]


def _loudnorm_args(m):
    # loudnorm reads measured_LRA=0 as "not measured" and silently switches to
    # its dynamic mode, which lands ~0.5 LU off; a short, even take really
    # can measure 0, so give it the smallest non-zero value instead.
    lra = max(float(m["input_lra"]), 0.01)
    return (f"loudnorm=I={LOUDNESS['I']}:TP={LOUDNESS['TP']}:LRA={LOUDNESS['LRA']}"
            f":measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={lra:g}"
            f":measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true")


def _input_args(info, cut):
    args = []
    if cut["base"] > 0:
        args += ["-ss", f"{cut['base']:.6f}"]
    args += ["-t", f"{cut['length']:.6f}", "-i", info["path"]]
    return args


# ------------------------------------------------------------------ render

def logo_file(town):
    """The town's logo, the 512 px version when there is one: the end card
    shows it ~600 px wide and the 96 px logo.png would be a blur."""
    path = town["logo_path"]
    big = os.path.join(os.path.dirname(path), "logo-512.png")
    for p in (big, path):
        if os.path.isfile(p):
            return p
    return None


def _sprite_chain(sp, index, label):
    """[index:v] (a sprite's frames) to `label`: held on its last frame to
    its end, faded out if it fades, and moved to its start on the video's
    clock. Overlay shows nothing of it before then and passes the video
    through once it has ended."""
    f0, f1 = round(sp["start"] * FPS), round(sp["end"] * FPS)
    total, n = f1 - f0, len(sp["frames"])
    parts = [f"[{index}:v]format=rgba"]
    if n > total:
        parts.append(f"trim=end_frame={total}")
    elif total > n:
        parts.append(f"tpad=stop_mode=clone:stop={total - n}")
    fo = min(int(sp.get("fade_out") or 0), total)
    if fo:
        parts.append(f"fade=t=out:start_frame={total - fo}:nb_frames={fo}:alpha=1")
    parts.append(f"setpts=PTS-STARTPTS+{f0}/({FPS}*TB)")
    return ",".join(parts) + label


def _graph(info, cut, layout, sprites, first_input, mode, audio_label, loud):
    W, H = LAYOUTS[layout]["size"]
    n = len(cut["frames"])
    vin = f"[0:{info['video_index']}]"
    # fps first: a 60 fps or variable-rate take becomes the 30 fps grid every
    # cut below is measured on; start_time=0 fills the grid from zero.
    chains = [f"{vin}fps={FPS}:start_time=0"
              + (f",split={n}" + "".join(f"[vs{i}]" for i in range(n)) if n > 1 else "[vs0]")]
    for i, (f0, nf) in enumerate(cut["frames"]):
        # After fps the time base is 1/30, so these are frame numbers: an
        # exact cut. trim=start=<seconds> is rounded into that time base and
        # can land a frame early.
        chains.append(f"[vs{i}]trim=start_pts={f0}:end_pts={f0 + nf},setpts=PTS-STARTPTS[v{i}]")
    tail = ["".join(f"[v{i}]" for i in range(n)) + (f"concat=n={n}:v=1:a=0" if n > 1 else "null")]
    if abs(cut["speed"] - 1.0) > 1e-6:
        # A fine time base first: PTS/1.08 in 1/30 units would be truncated
        # to whole frames.
        tail += ["settb=AVTB", f"setpts=PTS/{cut['speed']:.6f}"]
    pad = max(0.0, cut["duration"] - cut["content"]) + 1.0
    tail += [f"fps={FPS}", f"tpad=stop_mode=clone:stop_duration={pad:.3f}",
             f"trim=end_frame={cut['total_frames']}", "setpts=PTS-STARTPTS"]
    chains.append(",".join(tail) + "[cut]")
    chains += _canvas(info, W, H, mode, LAYOUTS[layout]["safe"])
    cur = "[canvas]"

    def lay(k, sp, cur):
        chains.append(_sprite_chain(sp, first_input + k, f"[sp{k}]"))
        chains.append(f"{cur}[sp{k}]overlay=x={sp['x']}:y={sp['y']}:format=gbrp:eof_action=pass[ov{k}]")
        return f"[ov{k}]"

    # The badge, the cards and the phone, then the captions over them; the
    # end card covers it all. Everything is blended on RGB frames: on YUV,
    # libass's colours go through BT.601 and the brand yellow comes out a
    # shade off in a BT.709 file.
    for k, sp in enumerate(sprites):
        if sp["name"] != "end-card":
            cur = lay(k, sp, cur)
    chains.append(f"{cur}subtitles=filename=overlay.ass:fontsdir=fonts[subs]")
    cur = "[subs]"
    for k, sp in enumerate(sprites):
        if sp["name"] == "end-card":
            cur = lay(k, sp, cur)
    chains.append(f"{cur}scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,"
                  "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv[vout]")
    chains += _audio_final(audio_label, cut, loud)
    return ";".join(chains)


def render(plan, out_dir, layout="4x5", *, info=None, screen=None):
    """Render `plan` for one layout into out_dir; returns the .mp4's path.

    Pass a dict as `info` to get back what was done (probe, kept frames,
    HDR handling, loudness pass, where each overlay went) for a report.
    screen: the phone's picture (a path or PIL image); by default the
    town's site screenshot (site_screenshot), when the plan has a phone.
    """
    if layout not in LAYOUTS:
        raise ValueError(f"unknown layout {layout!r}; one of {', '.join(LAYOUTS)}")
    check_plan(plan)
    filters = ffmpeg_filters()
    if "subtitles" not in filters:
        raise RenderError("this ffmpeg has no subtitles filter (build it with --enable-libass)")
    src = probe(plan["source"])
    town = towns.town(plan["town"])
    cut = cut_plan(plan, src)
    ass, geo = build_ass(plan, layout)
    if plan.get("phone") and screen is None:
        screen = site_screenshot(town)
    ec = plan.get("end_card") or {}
    face_meta, faces = detect_faces(src, cut, float(ec["start"]) if ec else float(plan["duration"]))
    canvas_faces = [(t, canvas_box(b, src, layout)) for t, b in faces]
    sprites, sgeo = build_sprites(plan, layout, screen=screen, faces=canvas_faces)
    mode = hdr_mode(src, filters)
    notes = []
    if src.get("hdr") and not mode:
        notes.append("HDR source, but this ffmpeg has neither zscale+tonemap nor lut3d: "
                     "colours will look washed out")
    if not src.get("has_audio"):
        notes.append("the take has no (playable) audio track: rendered with silence")
    late = src.get("audio_start") or 0.0
    if late > 1 / FPS:
        # Sound and picture stay together here, but a transcript timed from
        # the first sample (analyze.py's) puts every cut and caption this early.
        notes.append(f"the sound track starts {late:.2f} s after the picture: check that no cut "
                     "clips a word and the captions keep time with the voice")
    logo = logo_file(town)
    if not logo and sprites:
        notes.append(f"no logo at {town['logo_path']}: the badge and the end card are drawn without it")
    notes += sgeo["notes"]
    if (plan.get("chips") or []) and not faces:
        notes.append("no face found (%s): the cards sit in the fixed slot over the captions; check they "
                     "don't cover the eyes" % (face_meta.get("why") or "%d frames looked at"
                                               % face_meta.get("samples", 0)))
    # ffmpeg runs inside the work folder, so a relative out_dir would land there.
    out_dir = os.path.abspath(out_dir)
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, LAYOUTS[layout]["file"])
    tmp_out = os.path.join(out_dir, "." + LAYOUTS[layout]["file"] + ".part.mp4")
    with tempfile.TemporaryDirectory(prefix="render-") as work:
        wav = prepare_audio(src, cut, os.path.join(work, "audio.wav"))
        loud = measure_loudness(wav) if wav else None
        if wav and loud is None:
            # A muted or covered mic: a Reel without a voice must not go out unheard.
            notes.append("the kept sound is silent or nearly (under -60 LUFS), so it was left as is: "
                         "check the mic before posting")
        with open(os.path.join(work, "overlay.ass"), "w", encoding="utf-8") as f:
            f.write(ass)
        # Relative names keep the filter graph free of path escaping.
        try:
            os.symlink(FONTS_DIR, os.path.join(work, "fonts"))
        except OSError:
            shutil.copytree(FONTS_DIR, os.path.join(work, "fonts"))
        if mode == "lut":
            with open(os.path.join(work, "hdr.cube"), "w") as f:
                f.write(hdr_lut(src["hdr"], _peak(src)))
        cmd = ["ffmpeg", "-hide_banner", "-nostdin", "-nostats", "-v", "error", "-y"]
        cmd += _input_args(src, cut)
        for k, sp in enumerate(sprites):
            for i, frame in enumerate(sp["frames"]):
                frame.save(os.path.join(work, f"sprite{k}_{i:03d}.png"), compress_level=1)
            cmd += ["-framerate", str(FPS), "-i", f"sprite{k}_%03d.png"]
        audio_label = None
        if wav:
            cmd += ["-i", wav]
            audio_label = f"[{1 + len(sprites)}:a]"
        graph = _graph(src, cut, layout, sprites, 1, mode, audio_label, loud)
        cmd += ["-filter_complex", graph, "-map", "[vout]", "-map", "[aout]",
                "-c:v", "libx264", "-profile:v", "high", "-preset", "medium", "-crf", "18",
                # A keyframe every 2 s: Meta asks for a closed GOP of 2-5 s and
                # x264's default (250 frames, 8.3 s) gets a warning from
                # post_reel.py. x264's GOPs are closed unless asked otherwise.
                "-g", str(2 * FPS),
                "-pix_fmt", "yuv420p", "-r", str(FPS),
                "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
                "-color_range", "tv",
                "-c:a", "aac", "-b:a", "192k", "-ar", str(RATE), "-ac", "2",
                # An iPhone .MOV carries where it was filmed; the post shouldn't.
                "-map_metadata", "-1", "-map_chapters", "-1",
                "-movflags", "+faststart", tmp_out]
        try:
            _run(cmd, cwd=work, what=f"render {layout}")
        except BaseException:
            if os.path.exists(tmp_out):
                os.remove(tmp_out)
            raise
    os.replace(tmp_out, out_path)
    if info is not None:
        info.update({
            "layout": layout, "output": out_path, "canvas": list(LAYOUTS[layout]["size"]),
            "source": src, "hdr_mode": mode, "kept_segments": cut["kept"],
            "seek": cut["base"], "speed": cut["speed"], "frames": cut["total_frames"],
            "afftdn_latency": afftdn_latency() if src.get("has_audio") else None,
            "loudness_pass1": loud, "logo": logo, "notes": notes,
            "screen": screen if isinstance(screen, str) else None,
            "face": dict(face_meta, median=[round(v) for v in face_during(canvas_faces, -1, -1)]
                         if canvas_faces else None),
            "overlay": {"badge": sgeo.get("badge"), "cards": sgeo.get("cards") or [],
                        "phone": (sgeo.get("phone") or [None])[0],
                        "end_card": (sgeo.get("end_card") or [None])[0],
                        "captions": len(geo.get("captions") or [])},
        })
    return out_path


# ------------------------------------------------------------------ outputs

def summarize(path):
    """An ffprobe summary of a finished render, for report.json and tests."""
    out = _run(["ffprobe", "-v", "error", "-count_frames", "-print_format", "json",
                "-show_format", "-show_streams", path], timeout=300).stdout
    data = json.loads(out or "{}")
    v = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), {})
    a = next((s for s in data.get("streams", []) if s.get("codec_type") == "audio"), {})
    fmt = data.get("format") or {}
    return {
        "file": os.path.basename(path),
        "size_bytes": _int(fmt.get("size")),
        "duration": _float(fmt.get("duration")),
        "video": {
            "codec": v.get("codec_name"), "profile": v.get("profile"),
            "width": v.get("width"), "height": v.get("height"), "pix_fmt": v.get("pix_fmt"),
            "fps": _rate(v.get("avg_frame_rate")), "frames": _int(v.get("nb_read_frames")),
            "duration": _float(v.get("duration")),
            "color_primaries": v.get("color_primaries"), "color_transfer": v.get("color_transfer"),
            "color_space": v.get("color_space"), "color_range": v.get("color_range"),
            "rotation": _rotation(v) if v else 0,
        } if v else None,
        "audio": {
            "codec": a.get("codec_name"), "sample_rate": _int(a.get("sample_rate")),
            "channels": a.get("channels"), "duration": _float(a.get("duration")),
            "bit_rate": _int(a.get("bit_rate")),
        } if a else None,
    }


def loudness(path):
    """Integrated loudness (LUFS) and true peak (dBTP) of a file's audio."""
    r = _run(["ffmpeg", "-hide_banner", "-nostdin", "-nostats", "-i", path, "-map", "0:a:0",
              "-af", "ebur128=peak=true", "-f", "null", "-"], what="ebur128", timeout=300)
    text = r.stderr[r.stderr.rfind("Summary:"):]
    i = re.search(r"I:\s+(-?[\d.]+|-inf) LUFS", text)
    tp = re.search(r"Peak:\s+(-?[\d.]+|-inf) dBFS", text)
    return {"integrated": float(i.group(1)) if i else None,
            "true_peak": float(tp.group(1)) if tp else None}


def thumbnail(video, out_path, at=0.8):
    """A JPEG of one frame (0.8 s in: the hook has popped in, the first words are up)."""
    _run(["ffmpeg", "-hide_banner", "-nostdin", "-v", "error", "-y", "-ss", f"{at:.3f}", "-i", video,
          "-frames:v", "1",
          # JPEG viewers assume BT.601 full range; the video is BT.709 TV range.
          "-vf", "scale=in_color_matrix=bt709:in_range=tv:out_color_matrix=bt601:out_range=pc,format=yuvj420p",
          "-q:v", "2", out_path], what="thumbnail")
    return out_path


def main(argv=None):
    ap = argparse.ArgumentParser(description="Re-render a saved cut plan (or an edit.py report.json).")
    ap.add_argument("plan", help="plan JSON: one plan, a list of plans, or a report.json")
    ap.add_argument("--out", help="renders go to OUT/<video_id>/ (default: a report.json's own folder, "
                                  "else out/renders)")
    ap.add_argument("--formats", default="4x5,9x16")
    args = ap.parse_args(argv)
    with open(args.plan, encoding="utf-8") as f:
        data = json.load(f)
    plans = data if isinstance(data, list) else [data.get("plan", data)]
    here = None
    if isinstance(data, dict) and "plan" in data and not args.out:
        # A report's videos sit next to it. edit.py puts a second take of a
        # script in <video_id>-2/, and re-rendering that into <video_id>/
        # would quietly replace the first take's files.
        here = os.path.dirname(os.path.abspath(args.plan))
    for plan in plans:
        out_dir = here or os.path.join(args.out or os.path.join(HERE, "out", "renders"), plan["video_id"])
        for layout in [x.strip() for x in args.formats.split(",") if x.strip()]:
            print(render(plan, out_dir, layout))
    return 0


if __name__ == "__main__":
    sys.exit(main())
