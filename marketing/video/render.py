"""Render an analyze.py cut plan into the finished subscribe video.

One ffmpeg run per layout does the whole edit: it trims and joins the plan's
segments on the frame grid, applies the plan's speed-up, tone maps iPhone
HDR to SDR, fits the take to the canvas, lays the town's end card over the
tail and burns in one generated ASS file of text (hook sticker, event chips,
word-by-word captions, end card lines). The audio is cleaned up and brought
to -14 LUFS in two loudnorm passes.

    import render
    render.render(plan, "out/renders/victoria-1", layout="9x16")

The plan contract is analyze.py's (see its docstring); this module only draws
it. Needs ffmpeg/ffprobe built with libass (zscale and tonemap for HDR takes,
with a 3D LUT fallback) and the stdlib. The Fredoka fonts and their licence
are in fonts/.

    python3 render.py PLAN.json [--out DIR] [--formats 9x16,4x5]

re-renders a saved plan (or an edit.py report.json) after a hand fix.
"""
import argparse
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
    # Reels: the app's own UI covers the top ~13% and the bottom ~23%.
    "9x16": {"size": (1080, 1920), "safe": (60, 250, 1020, 1480), "file": "reel-9x16.mp4", "scale": 1.0},
    # Feed ads have no UI over the video; a plain 60 px margin, and the type
    # a little smaller because the canvas is 70% as tall.
    "4x5": {"size": (1080, 1350), "safe": (60, 60, 1020, 1290), "file": "feed-4x5.mp4", "scale": 0.9},
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

# Type, as em sizes in canvas pixels (what a designer means by "68 px");
# Font.ass_size() turns them into libass font sizes.
HOOK_EM = (96, 52)
HOOK_TILT = 2.0           # degrees counter-clockwise: a sticker, not a title card
HOOK_GONE = 0.1           # s before its end the fading hook no longer counts as on screen
END_TILT = -1.5           # the end card's domain sticker leans the other way
# Every chip of a video at the same size: one line if it fits, else two;
# smaller only when even two lines won't fit.
CHIP_EM = (52, 40)
CAPTION_EM = 72
CAPTION_Y = 0.68          # caption centre, as a share of the canvas height
CAPTION_MAX_WORDS = 3
CAPTION_PAUSE = 0.35      # a silence this long always starts a new caption
CAPTION_HOLD = 0.45       # a caption stays this long after its last word if nothing follows
END_LINE1_EM = 64
END_LINE2_EM = (100, 56)
LOGO_SHARE = {"9x16": 0.55, "4x5": 0.46}
SQUEEZE_MIN = 80          # % width: past this, type gets smaller instead


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
    return _FONTS["bold"], _FONTS["semibold"]


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


# ------------------------------------------------------------------ ASS overlay

def _round_rect(w, h, r):
    """An ASS drawing of a w x h rounded rectangle from 0,0 (libass anchors a
    drawing at its origin, so starting anywhere else would shift it)."""
    w, h = int(round(w)), int(round(h))
    r = int(round(min(r, w / 2, h / 2)))
    k = int(round(r * 0.4477))  # 1 - 0.5523: the cubic bezier quarter circle
    return (f"m {r} 0 l {w - r} 0 b {w - k} 0 {w} {k} {w} {r} l {w} {h - r} "
            f"b {w} {h - k} {w - k} {h} {w - r} {h} l {r} {h} b {k} {h} 0 {h - k} 0 {h - r} "
            f"l 0 {r} b 0 {k} {k} 0 {r} 0")


def _event(layer, start, end, name, text, style="Bold"):
    return f"Dialogue: {layer},{_ts(start)},{_ts(end)},{style},{name},0,0,0,,{text}"


def _pop(cx, cy, y, s0, ms, dy=0):
    """Tags that grow a group from s0 to 100% around (cx, cy) in `ms`.

    libass scales each event around its own anchor, so every line of a
    multi-line sticker also moves toward the group centre; \\move and \\t
    are both linear, so they stay in step. dy slides the group in from below.
    """
    y0 = cy + (y - cy) * s0 / 100 + dy
    move = (f"\\move({_num(cx)},{_num(y0)},{_num(cx)},{_num(y)},0,{ms})"
            if abs(y0 - y) > 0.4 else f"\\pos({_num(cx)},{_num(y)})")
    return move, f"\\fscx{_num(s0)}\\fscy{_num(s0)}", ms


def _sticker(events, *, layer, start, end, name, cx, cy, lines, font, em, squeeze,
             fill, border, text_runs, border_px, shadow_px, pad_x, pad_y, radius,
             tilt=0.0, pop_from=85, pop_ms=120, slide=0, fade=(70, 180), text_bord=0,
             text_bord_color=None):
    """A rounded box with lines of text on it, popping in as one piece.

    text_runs(line_index, line) returns the line's ASS text, so a chip can
    colour its day differently. Returns the box's bounds (with border,
    shadow and tilt) as (x0, y0, x1, y1).
    """
    pitch = em * 1.04
    widths = [font.width(x, em) * squeeze / 100 for x in lines]
    text_h = font.cap * em + (len(lines) - 1) * pitch
    box_w = max(widths) + 2 * pad_x
    box_h = text_h + 2 * pad_y
    fad = f"\\fad({fade[0]},{fade[1]})"
    rot = f"\\org({_num(cx)},{_num(cy)})\\frz{_num(tilt)}" if tilt else ""
    move, scale0, ms = _pop(cx, cy, cy, pop_from, pop_ms, slide)
    grow = f"\\t(0,{ms},\\fscx100\\fscy100)"
    events.append(_event(layer, start, end, name,
                         f"{{\\an5{move}{rot}{scale0}{grow}{fad}\\bord{border_px}\\shad0"
                         f"\\xshad0\\yshad{shadow_px}\\1c{_ass_color(fill)}\\3c{_ass_color(border)}"
                         f"\\4c{_ass_color(border)}\\1a&H00&\\4a&H00&\\p1}}"
                         f"{_round_rect(box_w, box_h, radius)}"))
    top = cy - text_h / 2
    fs = font.ass_size(em)
    for i, line in enumerate(lines):
        y = top + font.cap * em / 2 + i * pitch - font.cap_offset(em)
        move, _, _ = _pop(cx, cy, y, pop_from, pop_ms, slide)
        sq0 = f"\\fscx{_num(squeeze * pop_from / 100)}\\fscy{_num(pop_from)}"
        grow_l = f"\\t(0,{ms},\\fscx{squeeze}\\fscy100)"
        outline = (f"\\bord{_num(text_bord)}\\3c{_ass_color(text_bord_color)}"
                   if text_bord else "\\bord0")
        events.append(_event(layer + 1, start, end, name,
                             f"{{\\an5{move}{rot}\\fs{_num(round(fs, 1))}{sq0}{grow_l}{fad}"
                             f"{outline}\\shad0\\blur0.6}}{text_runs(i, line)}",
                             style="Bold" if font.bold else "Semi"))
    # Bounds after the tilt: the corners swing out by the other side's sine.
    t = math.radians(abs(tilt))
    half_w = (box_w * math.cos(t) + box_h * math.sin(t)) / 2 + border_px
    half_h = (box_w * math.sin(t) + box_h * math.cos(t)) / 2 + border_px
    return (cx - half_w, cy - half_h, cx + half_w, cy + half_h + shadow_px)


def _hook(events, plan, geo, bold, pal, s):
    hook = plan.get("hook") or {}
    text = clean_text(str(hook.get("text") or "").upper(), bold)
    L, T, R, _ = geo["safe"]
    cx = (L + R) / 2
    border, shadow = 6, 9
    if not text or float(hook.get("end", 0)) <= float(hook.get("start", 0)):
        return None
    hi, lo = (round(e * s) for e in HOOK_EM)
    # Room for the border and the tilt's swing on each side.
    max_w = (R - L) - 2 * (border + 0.42 * hi) - 40
    em, lines, squeeze = fit_text(text, bold, max_w, hi, hi, two_lines_from=hi, two_lines_to=lo)
    pad_x, pad_y = 0.42 * em, 0.36 * em
    box_h = bold.cap * em + (len(lines) - 1) * em * 1.04 + 2 * pad_y
    box_w = max(bold.width(x, em) for x in lines) * squeeze / 100 + 2 * pad_x
    t = math.radians(HOOK_TILT)
    half_h = (box_w * math.sin(t) + box_h * math.cos(t)) / 2 + border
    cy = T + 22 + half_h
    ink = pal["ink"]
    return _sticker(events, layer=20, start=float(hook["start"]), end=float(hook["end"]),
                    name="hook", cx=cx, cy=cy, lines=lines, font=bold, em=em, squeeze=squeeze,
                    fill=pal["highlight"], border=ink, border_px=border, shadow_px=shadow,
                    pad_x=pad_x, pad_y=pad_y, radius=0.3 * em, tilt=HOOK_TILT,
                    # Opaque from the first frame (it may be the preview a
                    # platform shows); only the scale pops.
                    fade=(0, 180),
                    text_runs=lambda i, line: f"{{\\1c{_ass_color(ink)}}}{ass_escape(line)}",
                    text_bord=1.2, text_bord_color=ink)


_DAY = re.compile(r"^((?:MON|TUE|WED|THU|FRI|SAT|SUN)(?:[-\u2013](?:MON|TUE|WED|THU|FRI|SAT|SUN))?)\b")


def _chips(events, plan, geo, bold, semi, pal, s, hook_box, cta, end_card_start):
    chips = plan.get("chips") or []
    L, T, R, _ = geo["safe"]
    cx = (L + R) / 2
    border, shadow = 5, 7
    hi, lo = (round(e * s) for e in CHIP_EM)
    max_w = (R - L) - 2 * (border + 0.55 * hi) - 12
    ordered = sorted((c for c in chips if c.get("text")), key=lambda c: float(c["start"]))
    # Chips go under the hook while it is still up (a chip cued in the first
    # ~1.5 s). Once it has gone they take its slot at the top instead: just
    # under the hook band is eye level in a selfie framed face-in-top-half.
    # Its last frames don't count: it is all but faded out by then, and a
    # chip cued 10 ms before its end (analyze.py's 1.6 s floor) used to send
    # every chip of the video down to eye level.
    hook = plan.get("hook") or {}
    up_until = float(hook.get("end", 0)) - HOOK_GONE
    overlaps = hook_box is not None and any(float(c["start"]) < up_until for c in ordered)
    top = hook_box[3] + round(26 * s) if overlaps else T + 22
    out = []
    for n, chip in enumerate(ordered):
        start = float(chip["start"])
        # The plan's own rule (next chip, else the sign-up line), enforced
        # again so a hand-edited plan can't stack two chips.
        end = min(float(chip["end"]), end_card_start)
        if n + 1 < len(ordered):
            end = min(end, float(ordered[n + 1]["start"]))
        elif cta is not None and float(cta) > start:
            end = min(end, float(cta))
        if end - start < 0.1:
            continue
        text = clean_text(chip["text"], semi)
        if not text:
            continue
        em, lines, squeeze = fit_text(text, semi, max_w, hi, hi, two_lines_from=hi, two_lines_to=lo)
        pad_x, pad_y = 0.55 * em, 0.42 * em
        box_h = semi.cap * em + (len(lines) - 1) * em * 1.04 + 2 * pad_y
        cy = top + border + box_h / 2
        day = _DAY.match(lines[0])

        def runs(i, line, day=day):
            paper, hl = _ass_color(pal["paper"]), _ass_color(pal["highlight"])
            if i == 0 and day:
                d = day.group(1)
                return f"{{\\1c{hl}}}{ass_escape(d)}{{\\1c{paper}}}{ass_escape(line[len(d):])}"
            return f"{{\\1c{paper}}}{ass_escape(line)}"

        box = _sticker(events, layer=10, start=start, end=end, name=f"chip{n + 1}", cx=cx, cy=cy,
                       lines=lines, font=semi, em=em, squeeze=squeeze, fill=pal["primary"],
                       border=pal["ink"], border_px=border, shadow_px=shadow, pad_x=pad_x,
                       pad_y=pad_y, radius=min(box_h / 2, 0.8 * em), pop_from=90, pop_ms=160,
                       slide=round(28 * s), fade=(110, 110), text_runs=runs)
        out.append({"text": text, "start": start, "end": end, "box": box, "em": em,
                    "lines": lines})
    return out


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


def _captions(events, plan, geo, bold, pal, s, until):
    words = plan.get("words") or []
    L, _, R, _ = geo["safe"]
    W, H = geo["canvas"]
    em = round(CAPTION_EM * s)
    bord = round(7 * s)
    max_w = (R - L) - 2 * bord - 24
    groups = caption_groups(words, bold, em, max_w, until)
    cx, cy = W / 2, round(H * CAPTION_Y)
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
            # Under the words, a soft shadow: their shape, blurred and offset
            # down, with the fill and outline themselves invisible.
            events.append(_event(0, start, end, "caption-shadow",
                                 f"{{{base}\\bord{bord}\\1a&HFF&\\3a&HFF&\\4c{ink}\\4a&H60&"
                                 f"\\xshad0\\yshad{round(5 * s)}\\blur{round(7 * s)}}}"
                                 + " ".join(texts)))
            events.append(_event(1, start, end, "caption",
                                 f"{{{base}\\bord{bord}\\shad0\\1c{white}\\3c{ink}\\blur0.8}}{body}"))
        out.append({"text": line, "start": group[0]["start"], "end": group_end,
                    "words": [x["text"] for x in group], "width": width * squeeze / 100})
    return out


def _end_card(events, plan, geo, bold, pal, s, layout, domain):
    """The end card's text: line1 in the primary colour, then the domain,
    big, in ink on a highlight sticker like the hook's, so the one thing to
    type is the loudest thing on screen. The logo above it is ffmpeg's."""
    ec = plan.get("end_card") or {}
    if not ec:
        return None
    L, T, R, B = geo["safe"]
    W, _ = geo["canvas"]
    cx = W / 2
    start, end = float(ec["start"]), float(ec.get("end") or plan["duration"])
    line1 = clean_text(ec.get("line1") or "", bold)
    line2 = clean_text(str(ec.get("line2") or "").replace("{domain}", domain), bold)
    logo = round(W * LOGO_SHARE[layout] / 2) * 2
    em1 = round(END_LINE1_EM * s)
    hi2, lo2 = (round(e * s) for e in END_LINE2_EM)
    border, shadow = 6, 9
    em1, l1, sq1 = fit_text(line1, bold, (R - L) - 40, em1, round(em1 * 0.6)) if line1 else (em1, [""], 100)
    # The sticker's padding, border and lean come out of the same width.
    max_w2 = (R - L) - 2 * (border + 0.42 * hi2) - 30
    em2, l2, sq2 = fit_text(line2, bold, max_w2, hi2, lo2) if line2 else (hi2, [""], 100)
    pad_x2, pad_y2 = 0.42 * em2, 0.34 * em2
    box_h2 = bold.cap * em2 + 2 * pad_y2 + 2 * border
    gap1, gap2 = round(0.1 * logo), round(0.45 * em1)
    h1 = bold.cap * em1 if line1 else 0
    total = logo + (gap1 + h1 if line1 else 0) + (gap2 + box_h2 if line2 else 0)
    # Upper-middle: a little above the safe zone's centre.
    top = T + max(0, (B - T - total) * 0.42)
    y = top + logo
    out = {"start": start, "end": end,
           "logo": {"x": int(cx - logo / 2), "y": int(round(top)), "size": logo},
           "lines": [], "bounds": []}
    if line1:
        y += gap1 + h1 / 2
        t0 = min(start + 0.12, end - 0.1)
        fs = bold.ass_size(em1)
        events.append(_event(30, t0, end, "end-line1",
                             f"{{\\an5\\pos({_num(cx)},{_num(round(y - bold.cap_offset(em1), 1))})"
                             f"\\fs{_num(round(fs, 1))}\\fscx{_num(sq1 * 0.88)}\\fscy88"
                             f"\\t(0,180,\\fscx{sq1}\\fscy100)\\fad(160,0)\\bord0\\shad0"
                             f"\\1c{_ass_color(pal['primary'])}}}{ass_escape(l1[0])}"))
        w = bold.width(l1[0], em1) * sq1 / 100
        out["lines"].append({"name": "end-line1", "text": l1[0], "em": em1})
        out["bounds"].append((cx - w / 2, y - h1 / 2, cx + w / 2, y + h1 / 2))
        y += h1 / 2
    if line2:
        cy = y + gap2 + box_h2 / 2
        ink = pal["ink"]
        box = _sticker(events, layer=30, start=min(start + 0.24, end - 0.1), end=end, name="end-line2",
                       cx=cx, cy=cy, lines=l2, font=bold, em=em2, squeeze=sq2, fill=pal["highlight"],
                       border=ink, border_px=border, shadow_px=shadow, pad_x=pad_x2, pad_y=pad_y2,
                       radius=0.3 * em2, tilt=END_TILT, pop_from=80, pop_ms=160, fade=(120, 0),
                       text_runs=lambda i, line: f"{{\\1c{_ass_color(ink)}}}{ass_escape(line)}",
                       text_bord=1.2, text_bord_color=ink)
        out["lines"].append({"name": "end-line2", "text": l2[0], "em": em2})
        out["bounds"].append(box)
    return out


def build_ass(plan, layout="9x16"):
    """The text overlay for one layout, as an ASS script, and its geometry:
    where every box landed and where the end card's logo goes (ffmpeg draws
    the logo and the end card's background; libass draws all the text)."""
    if layout not in LAYOUTS:
        raise ValueError(f"unknown layout {layout!r}; one of {', '.join(LAYOUTS)}")
    spec = LAYOUTS[layout]
    W, H = spec["size"]
    s = spec["scale"]
    town = towns.town(plan["town"])
    pal = town["palette"]
    bold, semi = fonts()
    duration = float(plan["duration"])
    ec = plan.get("end_card") or {}
    es = float(ec["start"]) if ec else duration
    geo = {"canvas": (W, H), "safe": spec["safe"]}
    events = []
    hook_box = _hook(events, plan, geo, bold, pal, s)
    chips = _chips(events, plan, geo, bold, semi, pal, s, hook_box, plan.get("cta_start"), es)
    captions = _captions(events, plan, geo, bold, pal, s, es)
    end = _end_card(events, plan, geo, bold, pal, s, layout, town["domain"])
    geo.update({"hook": hook_box, "chips": chips, "captions": captions, "end_card": end})
    header = "\n".join([
        "[Script Info]",
        f"; render.py overlay for {re.sub(r'[^A-Za-z0-9._-]', '?', str(plan.get('video_id', '?')))} ({layout})",
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
        f"Style: Semi,{semi.family},{_num(round(semi.ass_size(CHIP_EM[0]), 1))},&H00FFFFFF,&H00FFFFFF,"
        "&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ])
    return header + "\n" + "\n".join(events) + "\n", geo


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


def card_seconds(cut, ec):
    """How long the end card's own streams run: to the end, plus a margin."""
    return max(0.5, cut["duration"] - ec["start"]) + 0.5


def _graph(info, cut, layout, geo, town, mode, has_logo, audio_label, loud):
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
    ec = geo.get("end_card")
    if ec:
        # The card's background and logo exist only from the card's start
        # (overlay passes frames through until its second input begins), and
        # run a little past the end so shortest=1 stops with the take.
        es = ec["start"]
        paper = town["palette"]["paper"].lstrip("#")
        chains.append(f"color=c=0x{paper}:s={W}x{H}:r={FPS}:d={card_seconds(cut, ec):.3f},format=gbrap,"
                      f"fade=t=in:st=0:d=0.15:alpha=1,setpts=PTS+{es:.4f}/TB[paper]")
        chains.append(f"{cur}[paper]overlay=x=0:y=0:format=gbrp:shortest=1"
                      f":enable='gte(t,{es:.4f})'[ecbg]")
        cur = "[ecbg]"
        if has_logo:
            lg = ec["logo"]
            chains.append(f"[1:v]scale={lg['size']}:-2:flags=lanczos,format=gbrap,"
                          f"fade=t=in:st=0.06:d=0.25:alpha=1,setpts=PTS+{es:.4f}/TB[logo]")
            chains.append(f"{cur}[logo]overlay=x={lg['x']}:y={lg['y']}:format=gbrp:shortest=1"
                          f":enable='gte(t,{es:.4f})'[eclogo]")
            cur = "[eclogo]"
    # Text last, on RGB frames: on YUV, libass's colours go through BT.601
    # and the brand yellow comes out a shade off in a BT.709 file.
    chains.append(f"{cur}subtitles=filename=overlay.ass:fontsdir=fonts,"
                  "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,"
                  "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv[vout]")
    chains += _audio_final(audio_label, cut, loud)
    return ";".join(chains)


def render(plan, out_dir, layout="9x16", *, info=None):
    """Render `plan` for one layout into out_dir; returns the .mp4's path.

    Pass a dict as `info` to get back what was done (probe, kept frames,
    HDR handling, loudness pass) for a report.
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
    logo = logo_file(town) if geo.get("end_card") else None
    if geo.get("end_card") and not logo:
        notes.append(f"no logo at {town['logo_path']}; end card without it")
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
        inputs = 1
        if logo:
            cmd += ["-loop", "1", "-framerate", str(FPS), "-t", f"{card_seconds(cut, geo['end_card']):.3f}",
                    "-i", logo]
            inputs += 1
        audio_label = None
        if wav:
            cmd += ["-i", wav]
            audio_label = f"[{inputs}:a]"
        graph = _graph(src, cut, layout, geo, town, mode, bool(logo), audio_label, loud)
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
            "overlay": {"hook": geo.get("hook"), "chips": geo.get("chips"),
                        "captions": len(geo.get("captions") or []),
                        "end_card": geo.get("end_card")},
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
    ap.add_argument("--formats", default="9x16,4x5")
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
