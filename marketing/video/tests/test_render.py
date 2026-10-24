"""render.py and edit.py: the overlay, the cut, colour, sound and the files
that come out.

The overlay tests are plain Python and run anywhere (the repo's CI collects
this file too). Everything that renders needs ffmpeg/ffprobe with libass and
skips without them; sources are small synthetic clips made here, outputs are
the real 1080-wide canvases but only a few seconds long. The slowest tests
are marked `slow`: they run by default, are skipped on CI unless
VIDEO_SLOW=1, and VIDEO_SKIP_SLOW=1 skips them locally.
"""
import colorsys
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import types

import pytest

VIDEO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, VIDEO)

import render  # noqa: E402
import towns  # noqa: E402

with open(os.environ["VIDEO_SCRIPTS"], encoding="utf-8") as _f:  # the frozen batch (conftest.py)
    SCRIPTS = json.load(_f)
VIDEOS = {v["id"]: v for v in SCRIPTS["videos"]}


def _have_ffmpeg():
    if not (shutil.which("ffmpeg") and shutil.which("ffprobe")):
        return False
    try:
        return "subtitles" in render.ffmpeg_filters()
    except render.RenderError:
        return False


HAVE_FFMPEG = _have_ffmpeg()
needs_ffmpeg = pytest.mark.skipif(not HAVE_FFMPEG, reason="needs ffmpeg/ffprobe built with libass")
slow = pytest.mark.skipif(
    os.environ.get("VIDEO_SKIP_SLOW") == "1"
    or (bool(os.environ.get("CI")) and os.environ.get("VIDEO_SLOW") != "1"),
    reason="slow render test (on CI set VIDEO_SLOW=1 to run it)")
FRAME = 1 / 30


def _encoders():
    if not HAVE_FFMPEG:
        return ""
    return subprocess.run(["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True).stdout


def _filters():
    return render.ffmpeg_filters() if HAVE_FFMPEG else set()


# ---------------------------------------------------------------- helpers

def ff(*args, cwd=None):
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostdin", "-v", "error", "-y", *args],
                       capture_output=True, cwd=cwd)
    assert r.returncode == 0, r.stderr.decode()[-2000:]
    return r.stdout


def streams(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_streams",
                          "-show_format", path], capture_output=True, text=True, check=True).stdout
    data = json.loads(out)
    v = next(s for s in data["streams"] if s["codec_type"] == "video")
    a = next((s for s in data["streams"] if s["codec_type"] == "audio"), None)
    return v, a, data["format"]


def frame_rgb(path, t, w, h):
    """One decoded frame as RGB bytes, read the way a player shows a BT.709 file."""
    return ff("-ss", f"{t:.3f}", "-i", path, "-frames:v", "1", "-vf",
              f"scale={w}:{h}:in_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24",
              "-f", "rawvideo", "-")


def mean_rgb(rgb, w, box):
    x0, y0, x1, y1 = box
    tot, n = [0, 0, 0], 0
    for y in range(y0, y1):
        row = rgb[(y * w + x0) * 3:(y * w + x1) * 3]
        for c in range(3):
            tot[c] += sum(row[c::3])
        n += x1 - x0
    return tuple(t / n for t in tot)


def saturation(rgb, step=7):
    s = n = 0
    for i in range(0, len(rgb) - 2, 3 * step):
        s += colorsys.rgb_to_hsv(rgb[i] / 255, rgb[i + 1] / 255, rgb[i + 2] / 255)[1]
        n += 1
    return s / n


def luma(rgb, step=7):
    s = n = 0
    for i in range(0, len(rgb) - 2, 3 * step):
        s += 0.2126 * rgb[i] + 0.7152 * rgb[i + 1] + 0.0722 * rgb[i + 2]
        n += 1
    return s / n


def pcm(path):
    """The file's audio, mono 48 kHz, as ints."""
    raw = ff("-i", path, "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "s16le", "-")
    return struct.unpack(f"<{len(raw) // 2}h", raw)


def assert_av_and_format(path, plan, size):
    """The checks every render must pass."""
    v, a, fmt = streams(path)
    want = round(plan["duration"] * 30)
    assert (v["width"], v["height"]) == size
    assert v["codec_name"] == "h264" and v["profile"] == "High"
    assert v["pix_fmt"] == "yuv420p"
    assert v["avg_frame_rate"] == "30/1" and v["r_frame_rate"] == "30/1"
    assert (v.get("color_primaries"), v.get("color_transfer"), v.get("color_space")) == ("bt709",) * 3
    assert v.get("color_range") == "tv"
    assert not [sd for sd in v.get("side_data_list") or [] if "rotation" in sd]
    summary = render.summarize(path)
    assert summary["video"]["frames"] == want
    assert abs(float(v["duration"]) - plan["duration"]) <= FRAME + 1e-6
    assert a is not None and a["codec_name"] == "aac"
    assert int(a["sample_rate"]) == 48000 and a["channels"] == 2
    assert abs(float(a["duration"]) - float(v["duration"])) <= FRAME
    # Nothing from the phone's metadata (where it was filmed) survives.
    tags = {k.lower() for k in (fmt.get("tags") or {})}
    assert not tags & {"location", "com.apple.quicktime.location.iso6709", "creation_time"}
    return v, a


# ---------------------------------------------------------------- plans

def norm(w):
    return re.sub(r"[^a-z0-9]", "", w.lower())


def spoken(say, t0=0.07, pace=1.0):
    """Word timings for a script read at an upbeat pace, on the output timeline."""
    out, t = [], t0
    for raw in say.split():
        d = (0.1 + 0.032 * len(norm(raw))) / pace
        out.append({"text": raw, "start": round(t, 3), "end": round(t + d, 3)})
        t += d + ((0.16 if raw[-1] in ".,:" else 0.03) / pace)
    return out


def script_plan(video_id, source="/nonexistent/raw.mov", words=None):
    """A plan for one of the 15 scripts, laid out by the contract's rules."""
    v = VIDEOS[video_id]
    town = towns.town(v["town"])
    words = words or spoken(v["say"])
    chips, after = [], 0.0
    for c in v["chips"]:
        hit = next((w for w in words if w["start"] >= after and norm(w["text"]) in set(c["cue"])), None)
        if hit:
            chips.append({"text": c["text"], "start": hit["start"]})
            after = hit["start"] + 0.01
    speech_end = words[-1]["end"]
    cta = next((w["start"] for w in words if w["start"] >= after and norm(w["text"]) in SCRIPTS["cta_cue"]),
               speech_end - 4)
    for i, c in enumerate(chips):
        c["end"] = chips[i + 1]["start"] if i + 1 < len(chips) else cta
    dom = norm(town["domain"].split(".")[0])
    es = next((w["start"] for w in words if norm(w["text"]).startswith(dom)), speech_end - 1.2)
    end = round(max(speech_end + 0.9, es + 1.5), 3)
    hook_end = max(1.6, min((chips[0]["start"] if chips else 2.6) - 0.15, 2.6))
    return {
        "video_id": video_id, "town": v["town"], "source": source, "similarity": 0.95,
        "takes": [{"start": 0.0, "end": speech_end, "coverage": 1.0}], "take": 0,
        "segments": [{"start": 0.0, "end": round(speech_end + 0.1, 3)}], "speed": 1.0,
        "duration": end, "speech_end": speech_end, "words": words,
        "hook": {"text": v["hook"], "start": 0.0, "end": round(hook_end, 3)},
        "chips": chips, "cta_start": cta,
        "end_card": {"start": es, "end": end, "line1": SCRIPTS["end_card"]["line1"],
                     "line2": SCRIPTS["end_card"]["line2"].replace("{domain}", town["domain"])},
        "diff": [], "warnings": [],
    }


def short_plan(source, *, segments=((0.0, 3.0),), speed=1.0, town="victoria", words=True,
               overlays=True, end_card=True, video_id="test-1"):
    """A few seconds of a source with one of everything on it."""
    content = sum(b - a for a, b in segments) / speed
    duration = round(content + (0.6 if end_card else 0.0), 3)
    domain = towns.town(town)["domain"]
    ws = []
    if words:
        t = 0.07
        for w in ["Victoria:", "eight", "trunk-or-treats,", "Monday,", "Nightmare", "on", "Elm",
                  "Street.", "Sign", "up", "tonight."]:
            if t + 0.3 > content - 0.9:
                break
            ws.append({"text": w, "start": round(t, 3), "end": round(t + 0.24, 3)})
            t += 0.28
    es = round(content - 0.9, 3)
    plan = {
        "video_id": video_id, "town": town, "source": source, "similarity": 0.9,
        "takes": [{"start": segments[0][0], "end": segments[-1][1], "coverage": 1.0}], "take": 0,
        "segments": [{"start": a, "end": b} for a, b in segments], "speed": speed,
        "duration": duration, "speech_end": round(content - 0.1, 3), "words": ws,
        "hook": {"text": "8 TRUNK-OR-TREATS THIS WEEK", "start": 0.0, "end": 1.6} if overlays else None,
        "chips": [{"text": "MON · Nightmare on Elm Street @ Moonshine", "start": 1.7,
                   "end": es - 0.4}] if overlays else [],
        "cta_start": es - 0.4,
        "end_card": {"start": es, "end": duration, "line1": "FREE every Mon & Thu",
                     "line2": domain} if end_card else None,
        "diff": [], "warnings": ["test warning: check the Monday chip"],
    }
    return plan


def events(ass, name=None):
    """Parsed Dialogue lines: (layer, start, end, name, text)."""
    out = []
    for line in ass.splitlines():
        if not line.startswith("Dialogue:"):
            continue
        layer, start, end, _style, nm, _, _, _, _, text = line[len("Dialogue: "):].split(",", 9)
        if name is None or nm == name or (name.endswith("*") and nm.startswith(name[:-1])):
            out.append((int(layer), _secs(start), _secs(end), nm, text))
    return out


def _secs(ts):
    h, m, s = ts.split(":")
    return int(h) * 3600 + int(m) * 60 + float(s)


def plain(text):
    """An event's visible text: override blocks out, escapes resolved."""
    text = re.sub(r"(?<!\\)\{[^}]*\}", "", text)
    return text.replace("\\{", "{").replace("\\}", "}")


def libass_text(text):
    """What libass draws for an event's text, read the way libass reads it:
    a "{" opens an override block when a "}" follows, a backslash before
    N, n, h, { or } is an escape, and any other backslash is drawn."""
    out, i = [], 0
    while i < len(text):
        if text[i] == "{" and "}" in text[i:]:
            i = text.index("}", i) + 1
        elif text[i] == "\\" and text[i + 1:i + 2] in ("N", "n", "h", "{", "}"):
            out.append({"N": "\n", "n": "\n", "h": " "}.get(text[i + 1], text[i + 1]))
            i += 2
        else:
            out.append(text[i])
            i += 1
    return "".join(out)


# ---------------------------------------------------------------- fonts

def test_fonts_are_fredoka_semibold_and_bold_with_licence():
    bold, semi = render.fonts()
    assert (bold.family, bold.bold) == ("Fredoka", True)
    assert (semi.family, semi.bold) == ("Fredoka SemiBold", False)
    for f in ("Fredoka-Bold.ttf", "Fredoka-SemiBold.ttf", "OFL.txt", "Nunito-ExtraBold.ttf", "OFL-Nunito.txt"):
        assert os.path.getsize(os.path.join(render.FONTS_DIR, f)) > 1000
    for lic in ("OFL.txt", "OFL-Nunito.txt"):
        with open(os.path.join(render.FONTS_DIR, lic), encoding="utf-8") as f:
            assert "SIL Open Font License" in f.read()
    # Fredoka's own names, which is what libass matches on.
    for path, family, weight in (("Fredoka-Bold.ttf", "Fredoka", 700),
                                 ("Fredoka-SemiBold.ttf", "Fredoka SemiBold", 600),
                                 ("Nunito-ExtraBold.ttf", "Nunito", 800)):
        with open(os.path.join(render.FONTS_DIR, path), "rb") as fh:
            data = fh.read()
        assert family.encode("utf-16-be") in data
        n = struct.unpack_from(">H", data, 4)[0]
        os2 = next(struct.unpack_from(">I", data, 12 + 16 * i + 8)[0] for i in range(n)
                   if data[12 + 16 * i:16 + 16 * i] == b"OS/2")
        assert struct.unpack_from(">H", data, os2 + 4)[0] == weight
    for ch in "·’$@&,!?é–":
        assert bold.has(ch) and semi.has(ch) and render.body_font().has(ch)
    assert not bold.has("🎃")


# ---------------------------------------------------------------- text

@pytest.mark.parametrize("raw,want", [
    ("8 TRUNK-OR-TREATS THIS WEEK 🎃", "8 TRUNK-OR-TREATS THIS WEEK"),
    ("$1,000 costume contest @ the Royal Grove", "$1,000 costume contest @ the Royal Grove"),
    ("SAT · Boo Bash · Zoo Boo · Malloween", "SAT · Boo Bash · Zoo Boo · Malloween"),
    ("FRI · Calaveras & Cocktails @ The Nave", "FRI · Calaveras & Cocktails @ The Nave"),
    ("HALLOWEEN'S OVER. VICTORIA'S NOT.", "HALLOWEEN’S OVER. VICTORIA’S NOT."),
    ("clean-comedy girls' night out", "clean-comedy girls’ night out"),
    ("the '90s and 'quotes'", "the ’90s and ‘quotes’"),
    ('a "big" show', "a “big” show"),
    ("bat walk 🦇🌊 👨‍👩‍👧 ❤️ ⭐ done", "bat walk done"),
    ("two\nlines\tand  spaces", "two lines and spaces"),
])
def test_clean_text(raw, want):
    bold, _ = render.fonts()
    assert render.clean_text(raw, bold) == want


def test_ass_escape_keeps_text_literal():
    assert render.ass_escape("{\\b1}x\\Ny\\hz\\nw") == "\\{\\b1\\}x/Ny/hz/nw"
    # Braces become \{ \}, which libass draws as braces: no override block can open.
    assert re.search(r"(?<!\\)[{}]", render.ass_escape("a {b} c")) is None


def test_hostile_copy_cannot_reach_the_ass_markup():
    plan = script_plan("victoria-1")
    plan["hook"]["text"] = "{\\fs300\\c&H0000FF&}HUGE\\N🎃 & $1,000"
    plan["chips"][0]["text"] = "MON · {\\pos(0,0)}Moved @ Moonshine"
    plan["words"][3]["text"] = "{\\fs300}big"
    ass, _ = render.build_ass(plan, "9x16")
    # The badge and the cards are pictures: none of their copy is in the ASS at all.
    assert "HUGE" not in ass and "Moved" not in ass and "🎃" not in ass
    assert {e[3] for e in events(ass)} == {"caption", "caption-shadow"}
    for _, _, _, _, text in events(ass):
        # Only render.py's own override blocks; the copy's are escaped text.
        for block in re.findall(r"(?<!\\)\{([^}]*)\}", text):
            assert "fs300" not in block.lower()
    assert any("{\\fs300}big" in plain(e[4]) for e in events(ass, "caption"))
    # The pictures draw the copy as plain text (emoji dropped) and don't choke on it.
    _, geo = render.build_sprites(plan, "9x16")
    hook = next(g for g in geo["badge"] if g["name"] == "badge-hook")
    drawn = " ".join(hook["info"]["lines"])
    assert "HUGE" in drawn and "🎃" not in drawn and "$1,000" in drawn
    assert "{\\pos(0,0)}Moved" in " ".join(geo["cards"][0]["info"]["title"])


def test_a_trailing_backslash_cannot_turn_the_next_tag_into_text():
    # libass reads "\{" as a literal brace, so a word ending in a backslash
    # followed by the caption's own colour tag drew "{\1c&HFFFFFF&}" on screen
    # (and ran the line out of the safe zone).
    assert not render.ass_escape("back\\").endswith("\\")
    plan = script_plan("victoria-1")
    plan["words"][1]["text"] = "back\\"
    plan["words"][2]["text"] = "{x}\\"
    plan["hook"]["text"] = "HOOK\\"
    plan["chips"][0]["text"] = "MON\\ · day\\"
    plan["end_card"]["line1"] = "FREE\\"
    for layout in ("9x16", "4x5"):
        ass, _ = render.build_ass(plan, layout)
        for _, _, _, name, text in events(ass):
            drawn = libass_text(text)
            assert "\\1c" not in drawn and "&H" not in drawn, (name, drawn)
        caps = [libass_text(e[4]) for e in events(ass, "caption")]
        assert any("back/" in c for c in caps) and any("{x}/" in c for c in caps), caps


@pytest.mark.parametrize("layout", ["9x16", "4x5"])
def test_only_render_py_tags_reach_libass_for_every_script(layout):
    """All 15 real scripts: what libass draws is the copy, never a tag."""
    for video_id in sorted(VIDEOS):
        ass, _ = render.build_ass(script_plan(video_id), layout)
        for _, _, _, name, text in events(ass):
            drawn = libass_text(text)
            assert not re.search(r"\\(?:1c|3c|4c|fs|pos|move|an\d|bord|fad|t\()|&H", drawn), \
                (video_id, name, drawn)


@pytest.mark.parametrize("video_id", ["../escaped", "a/b", "victoria-1\n[Events]", "", ".hidden", "x" * 81])
def test_a_video_id_that_is_not_a_plain_name_is_refused(video_id):
    # It names the output folder: "../escaped" would write beside it.
    plan = short_plan("/x.mov", video_id=video_id)
    with pytest.raises(ValueError, match="video_id"):
        render.check_plan(plan)
    # Nor can it add a line to the ASS file through the header's comment.
    plan = script_plan("victoria-1")
    plan["video_id"] = video_id + "\nDialogue: 0,0:00:00.00,0:00:09.00,Bold,x,0,0,0,,INJECTED"
    ass, _ = render.build_ass(plan, "9x16")
    assert not [ln for ln in ass.splitlines() if "INJECTED" in ln and not ln.startswith(";")]
    assert ass.count("[Events]") == 1


@pytest.mark.parametrize("text,font,want", [
    ("MON · Nightmare on Elm Street @ Moonshine", "semi", ["MON · Nightmare on Elm Street", "@ Moonshine"]),
    ("STAPLETON MON · ELLA LANGLEY FRI", "bold", ["STAPLETON MON", "ELLA LANGLEY FRI"]),
    ("HALLOWEEN WEEKEND IN LINCOLN", "bold", ["HALLOWEEN WEEKEND", "IN LINCOLN"]),
    ("HALLOWEEN’S OVER. VICTORIA’S NOT.", "bold", ["HALLOWEEN’S OVER.", "VICTORIA’S NOT."]),
    ("THU · 1926 silent film + live score @ the Ross", "semi", ["THU · 1926 silent film", "+ live score @ the Ross"]),
    ("TUE · Twilight bat walk (register first)", "semi", ["TUE · Twilight bat walk", "(register first)"]),
])
def test_two_line_breaks_fall_where_a_designer_would_put_them(text, font, want):
    bold, semi = render.fonts()
    assert render.split_lines(text.split(), {"bold": bold, "semi": semi}[font], 60) == want


def test_one_long_word_shrinks_before_it_is_squeezed():
    bold, _ = render.fonts()
    em, lines, sq = render.fit_text("TRUNK-OR-TREATS", bold, 700, 96, 96, two_lines_from=96, two_lines_to=52)
    assert lines == ["TRUNK-OR-TREATS"] and sq == 100 and 52 <= em < 96
    assert bold.width("TRUNK-OR-TREATS", em) <= 700 < bold.width("TRUNK-OR-TREATS", em + 2)


def test_fit_text_shrinks_then_wraps_then_squeezes():
    bold, _ = render.fonts()
    em, lines, sq = render.fit_text("FREE", bold, 900, 96, 52)
    assert (em, lines, sq) == (96, ["FREE"], 100)
    em, lines, sq = render.fit_text("HALLOWEEN WEEKEND IN THE ROGUE VALLEY", bold, 830, 96, 96,
                                    two_lines_from=96, two_lines_to=52)
    assert len(lines) == 2 and sq == 100 and max(bold.width(x, em) for x in lines) <= 830
    word = "SUPERCALIFRAGILISTIC"
    limit = bold.width(word, 52) * 0.9  # too wide at the smallest size, by 10%
    em, lines, sq = render.fit_text(word, bold, limit, 96, 52)
    assert em == 52 and 80 <= sq < 100 and bold.width(lines[0], em) * sq / 100 <= limit
    em, lines, sq = render.fit_text("SUPERCALIFRAGILISTICEXPIALIDOCIOUS-AND-THEN-SOME", bold, 500, 96, 52)
    assert em < 52 and sq == 80 and bold.width(lines[0], em) * sq / 100 <= 500


# ---------------------------------------------------------------- the overlay

@pytest.mark.parametrize("layout", ["9x16", "4x5"])
def test_captions_carry_the_plans_times(layout):
    plan = script_plan("victoria-2")
    ass, geo = render.build_ass(plan, layout)
    W, H = render.LAYOUTS[layout]["size"]
    assert f"PlayResX: {W}" in ass and f"PlayResY: {H}" in ass
    es = plan["end_card"]["start"]
    caps = events(ass, "caption")
    shadows = events(ass, "caption-shadow")
    assert len(caps) == len(shadows) > 0
    starts = [w["start"] for w in plan["words"] if w["start"] < es]
    assert all(min(abs(e[1] - t) for t in starts) < 0.006 for e in caps)
    assert abs(caps[0][1] - plan["words"][0]["start"]) < 0.006
    assert max(e[2] for e in caps) <= es + 0.006, "no captions during the end card"


def _near(a, b):
    return abs(a - b) <= 1 / 60 + 1e-9  # on the frame grid


@pytest.mark.parametrize("layout", ["4x5", "9x16"])
def test_pictures_carry_the_plans_times(layout):
    plan = script_plan("victoria-2")
    sprites, geo = render.build_sprites(plan, layout)
    by = {sp["name"]: sp for sp in sprites}
    es = plan["end_card"]["start"]
    assert _near(by["badge-hook"]["start"], 0) and _near(by["badge-hook"]["end"], plan["hook"]["end"])
    # The badge turns into "Subscribe free" as the hook ends, and stays to the end card.
    assert by["badge-subscribe"]["start"] == by["badge-hook"]["end"]
    assert _near(by["badge-subscribe"]["end"], es)
    for n, chip in enumerate(plan["chips"], 1):
        assert _near(by[f"card{n}"]["start"], chip["start"]) and _near(by[f"card{n}"]["end"], chip["end"])
    assert _near(by["end-card"]["start"], es) and _near(by["end-card"]["end"], plan["duration"])
    assert "phone" not in by  # the frozen scripts have no phone cue
    for sp in sprites:
        assert len({fr.size for fr in sp["frames"]}) == 1, sp["name"]
        assert all(fr.mode == "RGBA" for fr in sp["frames"])
        assert abs(sp["start"] * 30 - round(sp["start"] * 30)) < 1e-6


def test_the_badge_fades_from_the_hook_to_subscribe_free():
    plan = script_plan("lincoln-2")
    sprites, geo = render.build_sprites(plan, "4x5")
    hook, sub = (next(sp for sp in sprites if sp["name"] == n) for n in ("badge-hook", "badge-subscribe"))
    assert hook["fade_out"] == render.BADGE_OUT_FRAMES and len(hook["frames"]) == 1
    # Subscribe free fades in: its entrance frames grow more opaque, then rest.
    alpha = [sum(i * n for i, n in enumerate(fr.getchannel("A").histogram())) for fr in sub["frames"]]
    assert len(alpha) == render.FADE_FRAMES + 1 and alpha == sorted(alpha) and alpha[0] < alpha[-1] / 2
    info = next(g for g in geo["badge"] if g["name"] == "badge-subscribe")["info"]
    assert info["em"] == render.BADGE["sub_em"]
    # Both sit centred at the top.
    for sp in (hook, sub):
        x0, y0, x1, _ = sp["box"]
        assert y0 == render.LAYOUTS["4x5"]["badge_top"] and abs((x0 + x1) / 2 - 540) <= 1


def test_a_hook_that_runs_into_the_end_card_leaves_no_subscribe_badge():
    plan = short_plan("/x.mov")
    plan["hook"]["end"] = plan["end_card"]["start"] + 1.0
    sprites, _ = render.build_sprites(plan, "4x5")
    names = [sp["name"] for sp in sprites]
    assert "badge-hook" in names and "badge-subscribe" not in names
    assert _near(sprites[0]["end"], plan["end_card"]["start"])


def test_every_spoken_word_before_the_end_card_is_captioned_once():
    plan = script_plan("medford-2")
    ass, geo = render.build_ass(plan, "9x16")
    es = plan["end_card"]["start"]
    shown = []
    for cap in geo["captions"]:
        shown += cap["words"]
    want = [render.clean_text(w["text"], render.fonts()[0]).rstrip(",.;:")
            for w in plan["words"] if w["start"] < es - 0.03]
    assert shown == want


def test_captions_are_one_line_of_one_to_three_words_with_the_spoken_word_highlighted():
    plan = script_plan("lincoln-2")
    pal = towns.town("lincoln")["palette"]
    hl = render._ass_color(pal["highlight"])
    ass, geo = render.build_ass(plan, "9x16")
    L, _, R, _ = geo["safe"]
    def word_at(t):
        w = min(plan["words"], key=lambda w: abs(w["start"] - t))
        return render.clean_text(w["text"], render.fonts()[0]).rstrip(",.;:")

    for _, start, end, _, text in events(ass, "caption"):
        assert "\\N" not in text and "\\n" not in text
        words = plain(text).split()
        assert 1 <= len(words) <= 3
        lit = re.findall(r"\{\\1c" + re.escape(hl) + r"\}([^{]+)\{", text)
        assert len(lit) == 1, text
        assert lit[0] == word_at(start)
    for cap in geo["captions"]:
        assert cap["width"] <= (R - L)


def test_captions_keep_names_together():
    words = spoken("a thousand-dollar costume contest at the Royal Grove. Sign up")
    groups = render.caption_groups(words, render.fonts()[0], 72, 900, 99)
    texts = [" ".join(w["text"] for w in g) for g in groups]
    assert any("Royal Grove" in t for t in texts), texts


def test_a_pause_always_starts_a_new_caption():
    words = [{"text": "one", "start": 0.0, "end": 0.2}, {"text": "two", "start": 0.25, "end": 0.45},
             {"text": "three", "start": 1.2, "end": 1.4}]
    groups = render.caption_groups(words, render.fonts()[0], 72, 900, 99)
    assert [len(g) for g in groups] == [2, 1]


def test_cards_never_overlap_even_in_a_hand_edited_plan():
    plan = script_plan("medford-2")
    plan["chips"][0]["end"] = plan["chips"][2]["start"] + 1.0  # overlaps the next two
    sprites, _ = render.build_sprites(plan, "9x16")
    spans = sorted((sp["start"], sp["end"]) for sp in sprites if sp["name"].startswith("card"))
    assert len(spans) == len(plan["chips"])
    for (a0, a1), (b0, b1) in zip(spans, spans[1:]):
        assert a1 <= b0 + 1e-9


# ---------------------------------------------------------------- the cards and the face

LO, HI = 282, render._caption_top(render.LAYOUTS["4x5"]) - 16  # under the badge, over the captions (4:5)


def _eye_band(face):
    return face[1], face[1] + render.EYE_BAND * (face[3] - face[1])


def test_a_card_goes_just_under_the_chin_when_there_is_room():
    face = (362, 249, 708, 742)  # a face sitting high
    y, s, slot = render.place_card(238, face, LO, HI)
    assert (slot, s) == ("below-chin", 1.0) and y == 742 + render.CARD_MARGIN
    # A lower chin: pulled up to clear the captions, still under the mouth.
    y, s, slot = render.place_card(238, (362, 330, 708, 960), LO, HI)
    assert slot == "below-chin" and y + 238 == HI and y >= 960 - 0.08 * 630


def test_a_close_selfie_puts_the_cards_over_the_chest_or_above_the_head():
    face = (174, 541, 676, 1228)  # Tristen's own 4:5 ad, as YuNet sees it
    y, s, slot = render.place_card(238, face, LO, HI)
    assert (slot, y, s) == ("above-head", LO, 1.0)
    # A two-line card is too tall for over his head: over the chest, a little smaller.
    y, s, slot = render.place_card(292, face, LO, HI)
    assert slot == "lower-third" and render.CARD_MIN_SCALE <= s < 1
    assert y >= _eye_band(face)[1] and abs(y + 292 * s - HI) < 1e-6


def test_with_no_face_the_card_takes_the_fixed_slot_over_the_captions():
    assert render.place_card(238, None, LO, HI) == (HI - 238, 1.0, "fixed")


def test_no_card_ever_covers_the_eyes():
    for top in range(0, 900, 37):
        for size in range(200, 1000, 61):
            face = (300, top, 300 + size * 0.8, top + size)
            for h in (190, 238, 292, 340):
                for slot, y, s in render.card_slots(h, face, LO, HI):
                    if slot.endswith("small"):
                        continue  # nowhere fits even at CARD_MIN_SCALE: an extreme close-up
                    e0, e1 = _eye_band(face)
                    assert y >= e1 or y + h * s <= e0, (face, h, slot, y, s)
                    assert y >= LO - 1e-6 and y + h * s <= HI + 1e-6, (face, h, slot, y, s)
                    assert s >= render.CARD_MIN_SCALE


def test_a_face_that_fills_the_frame_shrinks_the_card_and_says_so():
    plan = script_plan("victoria-1")
    face = (40, 300, 1040, 1700)  # eyes down to y 1070, forehead at 300
    assert render.card_slots(292, face, LO, HI)[0][0].endswith("-small")
    _, geo = render.build_sprites(plan, "4x5", faces=_faces(face))
    assert all(c["info"]["slot"].endswith("-small") and c["info"]["scale"] < 1 for c in geo["cards"])
    assert any("fills the frame" in n for n in geo["notes"])


def _faces(box, until=16.0, every=0.5):
    return [(round(i * every, 3), box) for i in range(int(until / every) + 1)]


def test_every_card_of_a_video_takes_the_same_place():
    # One-line cards would fit over his head, two-line ones only over his
    # chest: all of them go over his chest, not some up and some down.
    plan = script_plan("victoria-2")
    for chip in plan["chips"]:
        chip.update(tag="Sat, Oct 31", venue="Victoria", title="Malloween")
    plan["chips"][0]["title"] = "Zoo Boo"
    plan["chips"][1]["title"] = "Calaveras and Cocktails at The Nave, the big one"
    face = (174, 541, 676, 1228)
    assert render.place_card(238, face, LO, HI)[2] == "above-head"  # alone, a one-liner would go up
    sprites, geo = render.build_sprites(plan, "4x5", faces=_faces(face))
    cards = geo["cards"]
    assert [len(c["info"]["title"]) for c in cards[:2]] == [1, 2]
    assert {c["info"]["slot"] for c in cards} == {"lower-third"}
    for c in cards:
        e0, e1 = _eye_band(c["info"]["face"])
        assert c["box"][1] >= e1, c


@pytest.mark.parametrize("layout", ["4x5", "9x16"])
def test_cards_follow_the_face_in_both_layouts(layout):
    plan = script_plan("lincoln-2")
    spec = render.LAYOUTS[layout]
    W, H = spec["size"]
    high = (360, spec["safe"][1] + 230, 720, spec["safe"][1] + 700)
    _, geo = render.build_sprites(plan, layout, faces=_faces(high))
    L, T, R, B = spec["safe"]
    assert geo["cards"]
    for c in geo["cards"]:
        assert c["info"]["slot"] == "below-chin" and c["box"][1] == high[3] + render.CARD_MARGIN
        x0, y0, x1, y1 = c["box"]
        assert L <= x0 and x1 <= R and T <= y0 and y1 <= render._caption_top(spec) - 16 + 1


def test_a_card_follows_the_face_while_it_is_up():
    plan = script_plan("victoria-2")
    c0, c1 = plan["chips"][0], plan["chips"][1]
    # He leans in during the second card: that card keeps off the face he has
    # then (and the one he had as it came up); the first card never sees it.
    lean = (c1["start"] + 0.5, c1["end"] - 0.3)
    times = [x / 4 for x in range(64)]
    faces = [(t, (200, 420, 860, 1210) if lean[0] <= t <= lean[1] else (360, 250, 700, 740)) for t in times]
    box = render.face_during(faces, c1["start"], c1["end"])
    assert box[3] == 1210 and box[1] == 250
    assert render.face_during(faces, c0["start"], c0["end"]) == (360, 250, 700, 740)
    # A stray detection far from the face is ignored.
    stray = faces + [(c0["start"], (900, 10, 960, 60))]
    assert render.face_during(stray, c0["start"], c0["end"]) == render.face_during(faces, c0["start"], c0["end"])
    assert render.face_during([], 0, 1) is None


def test_face_boxes_map_onto_each_canvas():
    portrait = {"width": 1080, "height": 1920}
    # 4:5 is cut from the portrait take 171 px down (TOP_BIAS); 9:16 is the take itself.
    assert render.canvas_box((0.25, 0.5, 0.75, 0.75), portrait, "4x5") == (270, 960 - 171, 810, 1440 - 171)
    assert render.canvas_box((0.25, 0.5, 0.75, 0.75), portrait, "9x16") == (270, 960, 810, 1440)
    # A landscape take sits across the middle of the safe zone.
    landscape = {"width": 1920, "height": 1080}
    x0, y0, x1, y1 = render.canvas_box((0.0, 0.0, 1.0, 1.0), landscape, "9x16")
    assert (x0, x1) == (0, 1080) and abs((y0 + y1) / 2 - (250 + 1480) / 2) <= 1


def test_without_opencv_there_is_no_face_and_the_render_says_so(monkeypatch):
    monkeypatch.setitem(sys.modules, "cv2", None)
    meta, faces = render.detect_faces({"path": "/x.mov", "width": 1080, "height": 1920, "video_index": 0},
                                      {"frames": [(0, 90)], "speed": 1.0, "base": 0.0, "length": 3.0}, 3.0)
    assert faces == [] and meta["detector"] is None and "OpenCV" in meta["why"]


def _drawn_face(w=720, h=1280, top=330):
    """A flat cartoon face a detector can find (the shading is what does it)."""
    from PIL import Image as PImage, ImageDraw as PDraw, ImageFilter as PFilter
    im = PImage.new("RGB", (w, h), (226, 222, 210))
    d = PDraw.Draw(im)
    cx, k = w // 2, (h - top) / 950
    def Y(v):
        return top + (v - 330) * k
    d.ellipse([cx - 330, Y(1060), cx + 330, h + 400], fill=(64, 98, 140))
    d.rectangle([cx - 70, Y(860), cx + 70, Y(1110)], fill=(214, 166, 136))
    d.ellipse([cx - 185, Y(330), cx + 185, Y(940)], fill=(232, 190, 160))
    d.chord([cx - 200, Y(250), cx + 210, Y(640)], 180, 360, fill=(40, 30, 26))
    shade = PImage.new("L", im.size, 0)
    sd = PDraw.Draw(shade)
    for x0 in (cx - 185, cx + 95):
        sd.ellipse([x0, Y(330), x0 + 90, Y(940)], fill=110)
    for ex in (cx - 75, cx + 75):
        sd.ellipse([ex - 52, Y(560), ex + 52, Y(640)], fill=150)
    im.paste((150, 100, 80), (0, 0), shade.filter(PFilter.GaussianBlur(18)))
    d = PDraw.Draw(im)
    for ex in (cx - 75, cx + 75):
        d.rounded_rectangle([ex - 45, Y(535), ex + 45, Y(552)], radius=7, fill=(40, 30, 26))
        d.ellipse([ex - 32, Y(583), ex + 32, Y(617)], fill=(250, 250, 250))
        d.ellipse([ex - 14, Y(584), ex + 14, Y(616)], fill=(80, 110, 140))
        d.ellipse([ex - 7, Y(593), ex + 7, Y(607)], fill=(20, 20, 20))
    d.polygon([(cx, Y(610)), (cx - 30, Y(738)), (cx + 26, Y(742))], fill=(214, 166, 136))
    d.ellipse([cx - 58, Y(800), cx + 58, Y(830)], fill=(120, 50, 50))
    return im


@needs_ffmpeg
def test_detect_faces_finds_the_face_in_the_kept_footage(tmp_path):
    pytest.importorskip("cv2")
    still = tmp_path / "face.png"
    _drawn_face().save(still)
    src = str(tmp_path / "face.mp4")
    ff("-loop", "1", "-framerate", "30", "-t", "4", "-i", str(still), "-vf", "format=yuv420p",
       "-c:v", "libx264", "-preset", "ultrafast", src)
    plan = short_plan(src, segments=((0.5, 3.5),))
    info = render.probe(src)
    cut = render.cut_plan(plan, info)
    meta, faces = render.detect_faces(info, cut, 2.0)
    assert meta["samples"] == 5 and faces, meta
    for t, (x0, y0, x1, y1) in faces:
        # The drawn head spans x 175..545 and y 330..940 of 720x1280.
        assert 0.15 < x0 < 0.35 and 0.65 < x1 < 0.85 and 0.2 < y0 < 0.42 and 0.62 < y1 < 0.8, (x0, y0, x1, y1)
    # Asked again for the same cut: the cached answer, no second look.
    assert render.detect_faces(info, cut, 2.0) == (meta, faces)


def _screen():
    """A stand-in for the site's screenshot (390 px wide at 2x)."""
    from PIL import Image as PImage, ImageDraw as PDraw
    im = PImage.new("RGB", (780, 1688), (255, 244, 214))
    d = PDraw.Draw(im)
    d.rectangle([0, 0, 780, 120], fill=(75, 63, 209))
    for y in range(200, 1688, 120):
        d.rounded_rectangle([40, y, 740, y + 90], radius=20, fill=(255, 255, 255), outline=(31, 26, 61), width=4)
    return im


@pytest.mark.parametrize("layout", ["4x5", "9x16"])
@pytest.mark.parametrize("video_id", sorted(VIDEOS))
def test_every_script_lays_out_inside_the_safe_zone(video_id, layout):
    """Geometry check for all 15 real hooks, cards and domains, with a phone."""
    plan = script_plan(video_id)
    es = plan["end_card"]["start"]
    plan["phone"] = {"start": round(es - 2.2, 3), "end": round(es - 0.2, 3)}
    sprites, geo = render.build_sprites(plan, layout, screen=_screen())
    L, T, R, B = geo["safe"]
    for sp in sprites:
        if sp["name"] == "end-card":
            continue
        for fr in sp["frames"]:
            box = fr.getchannel("A").getbbox()
            if box:
                x0, y0, x1, y1 = box[0] + sp["x"], box[1] + sp["y"], box[2] + sp["x"], box[3] + sp["y"]
                assert L <= x0 and x1 <= R and T <= y0 and y1 <= B, (video_id, sp["name"], (x0, y0, x1, y1))
    info = geo["end_card_info"]
    assert T <= info["top"] and info["bottom"] <= B
    assert geo["cards"] and geo["phone"]
    assert all(c["info"]["em"] >= render.CARD["title_min"] - 8 for c in geo["cards"])


@pytest.mark.parametrize("slug,hook,pills,marks", [
    ("victoria", "300+ things to do in Victoria, TX", ["300+"], ["Victoria, TX"]),
    ("victoria", "8 trunk-or-treats this week", ["8"], []),
    ("victoria", "HALLOWEEN'S OVER. VICTORIA'S NOT.", [], ["VICTORIA’S"]),
    ("shoals", "Halloween weekend in the Shoals", [], ["Shoals"]),
    ("medford", "Halloween weekend in the Rogue Valley", [], ["Rogue Valley"]),
    ("virginiabeach", "Halloween weekend in Virginia Beach", [], ["Virginia Beach"]),
    ("medford", "Final week after 16 seasons", ["16"], []),
    ("lincoln", "Stapleton, a $1,000 prize & 21+ night", ["$1,000", "21+"], []),
    ("lincoln", "Who's playing tonight?", [], []),
])
def test_hook_numbers_go_in_pills_and_the_town_is_underlined(slug, hook, pills, marks):
    items = render._hook_items(hook, towns.town(slug))
    assert [it["text"] for it in items if it["kind"] == "pill"] == pills
    assert [it["text"] for it in items if it["kind"] == "mark"] == marks


def _pixels(img):
    return img.get_flattened_data() if hasattr(img, "get_flattened_data") else img.getdata()


def _count(img, hexcolor, tol=12):
    want = [int(hexcolor[i:i + 2], 16) for i in (1, 3, 5)]
    return sum(1 for p in _pixels(img.convert("RGBA"))
               if p[3] > 250 and all(abs(a - b) <= tol for a, b in zip(p, want)))


def test_the_hook_badge_draws_the_pill_and_the_stroke_in_the_towns_colours():
    for slug in ("victoria", "lincoln"):
        town = towns.town(slug)
        pal = town["palette"]
        img, info = render.hook_badge(f"300+ things to do in {town['city']}", town, pal, render._logo(town))
        assert info["lines"] == ["300+ things to do", f"in {town['city']}"]
        assert _count(img, pal["accent"]) > 3000      # the number's pill
        assert _count(img, pal["highlight"]) > 3000   # the stroke under the town's name
        assert _count(img, pal["ink"]) > 10000        # outline, shadow and words
        assert _count(img, "#FFFFFF") > 40000         # the card


@pytest.mark.parametrize("slug,hook,lines", [
    ("victoria", "300+ things to do in Victoria, TX", ["300+ things to do", "in Victoria, TX"]),
    ("lincoln", "80+ things to do this week", ["80+ things to do", "this week"]),
    ("medford", "Final week after 16 seasons", ["Final week", "after 16 seasons"]),
    ("virginiabeach", "Halloween weekend in Virginia Beach", ["Halloween weekend", "in Virginia Beach"]),
    ("medford", "Who's playing at the wineries?", ["Who’s playing", "at the wineries?"]),
    ("shoals", "Live music", ["Live music"]),
])
def test_the_hook_breaks_like_tristens(slug, hook, lines):
    town = towns.town(slug)
    _, info = render.hook_badge(hook, town, town["palette"], render._logo(town))
    assert info["lines"] == lines


def test_break_lines_keeps_names_and_phrases_together():
    def width(ln):
        return render.text_width(" ".join(ln), "body", 58)
    words = "Everything to do in Victoria, in your inbox every Monday and Thursday".split()
    assert [" ".join(x) for x in render.break_lines(words, width, 3)] == [
        "Everything to do in Victoria,", "in your inbox every", "Monday and Thursday"]
    assert render.break_lines(["one"], width, 2) == [["one"]]
    # Never "the" at the end of a line.
    out = render.break_lines("Where's the live music?".split(), width, 2)
    assert out[0][-1] != "the"


@pytest.mark.parametrize("slug,want", [("victoria", ("The Vic", "361")), ("lincoln", ("The Star", "402")),
                                       ("medford", ("The Rogue", "541")), ("shoals", ("Shoals", "Setlist")),
                                       ("virginiabeach", ("The Tide", "757"))])
def test_the_wordmark_is_the_sites_two_tone_name(slug, want):
    assert render.wordmark(towns.town(slug)) == want


def test_card_shows_its_fields_and_falls_back_to_the_text():
    pal = towns.town("victoria")["palette"]
    img, info = render.event_card({"icon": "🎃", "tag": "Pumpkin patch", "venue": "Victoria, TX",
                                   "title": "Titan Factory Direct Pumpkin Patch", "text": "SAT · Pumpkins"}, pal)
    assert info["title"] == ["Titan Factory Direct", "Pumpkin Patch"]
    assert (info["tag"], info["venue"], info["em"]) == ("Pumpkin patch", "Victoria, TX", render.CARD["title_em"])
    assert img.width == render.CARD["width"] + render.CARD["drop"]
    assert _count(img, pal["highlight"]) > 2000  # the tag pill
    assert _count(img, "#FFFFFF") > 100000       # the card
    # A chip from the older scripts: its one line of text is the title, nothing else.
    img, info = render.event_card({"text": "MON · Nightmare on Elm Street @ Moonshine"}, pal)
    assert " ".join(info["title"]) == "MON · Nightmare on Elm Street @ Moonshine"
    assert (info["tag"], info["venue"], info["icon"]) == ("", "", False)
    assert _count(img, pal["highlight"]) < 50
    # FREE: a green pill after the title.
    img, info = render.event_card({"title": "Spooky mini golf", "free": True, "text": "x"}, pal)
    assert _count(img, render.GREEN, tol=10) > 800


@pytest.mark.skipif(not render.emoji_font_path(), reason="no colour emoji font (setup.sh fetches one)")
def test_the_cards_icon_is_the_colour_emoji():
    pal = towns.town("victoria")["palette"]
    img, info = render.event_card({"icon": "🎃", "title": "Pumpkins", "text": "x"}, pal)
    assert info["icon"]
    icon = img.crop((40, 0, 160, img.height))
    orange = sum(1 for p in _pixels(icon) if p[3] > 200 and p[0] > 200 and 80 < p[1] < 170 and p[2] < 80)
    assert orange > 2000, orange
    # A variation selector after the emoji (🛍️, 🎞️ in the live scripts) is fine.
    assert render.emoji_image("🛍️") is not None


def test_without_an_emoji_font_the_card_has_no_icon_and_the_render_says_so(monkeypatch):
    monkeypatch.setattr(render, "emoji_font_path", lambda: None)
    plan = script_plan("victoria-1")
    plan["chips"][0]["icon"] = "🎃"
    _, geo = render.build_sprites(plan, "4x5")
    assert not geo["cards"][0]["info"]["icon"]
    assert any("emoji font" in n and "setup.sh" in n for n in geo["notes"])


def test_the_phone_shows_the_site_and_no_card_is_up_meanwhile():
    plan = script_plan("victoria-2")
    last = plan["chips"][-1]
    plan["phone"] = {"start": round(last["start"] + 0.6, 3), "end": round(last["start"] + 2.6, 3)}
    assert plan["phone"]["end"] < plan["end_card"]["start"]
    sprites, geo = render.build_sprites(plan, "4x5", screen=_screen())
    phone = next(sp for sp in sprites if sp["name"] == "phone")
    assert _near(phone["start"], plan["phone"]["start"]) and _near(phone["end"], plan["phone"]["end"])
    assert phone["fade_out"] == render.PHONE_OUT_FRAMES
    # It pops: smaller and fainter first, then the resting picture.
    a = [fr.getchannel("A").getbbox() for fr in phone["frames"]]
    assert len(a) == render.POP_FRAMES + 1 and (a[0][2] - a[0][0]) < (a[-1][2] - a[-1][0])
    for sp in sprites:
        if sp["name"].startswith("card"):
            assert sp["end"] <= phone["start"] + 1e-9 or sp["start"] >= phone["end"] - 1e-9, sp["name"]
    assert geo["phone"][0]["box"] == phone["box"]
    # The screenshot is what's on its screen: the site's colours show.
    rest = phone["frames"][-1]
    assert _count(rest, "#4B3FD1", tol=6) > 3000


def _overlaps(a0, a1, b0, b1):
    return a0 < b1 and b0 < a1


@pytest.mark.parametrize("face,side,clear", [
    ((430, 300, 900, 900), "left", "face"),          # room beside it: nothing of the face covered
    ((362, 249, 708, 742), "right", "both eyes"),     # a face sitting high and narrow
    ((238, 407, 833, 1243), "right", "far eye"),      # a close selfie: one side of the face at most
    ((24, 200, 1056, 1300), "right", "far eye"),      # the face fills the frame
])
def test_the_phone_keeps_off_the_eyes(face, side, clear):
    width = render.PHONE["width"] + render.PHONE["drop"][0]
    x, scale, got_side, got_clear = render.place_phone(face, 24, 1056, width)
    assert (got_side, got_clear) == (side, clear)
    x1 = x + width * scale
    assert 24 <= x and x1 <= 1056
    (le0, le1), (re0, re1) = render.eye_zones(face)
    far = (re0, re1) if side == "left" else (le0, le1)
    assert not _overlaps(x, x1, *far), "the far eye stays clear"
    if clear in ("face", "both eyes"):
        assert not _overlaps(x, x1, le0, le1) and not _overlaps(x, x1, re0, re1)
    if clear == "face":
        assert not _overlaps(x, x1, face[0], face[2])
    assert render.place_phone(None, 24, 1056, width)[2] == "centre"


@pytest.mark.parametrize("layout", ["4x5", "9x16"])
def test_the_phone_goes_beside_the_face_in_both_layouts(layout):
    plan = script_plan("victoria-2")
    last = plan["chips"][-1]
    plan["phone"] = {"start": round(last["start"] + 0.6, 3), "end": round(last["start"] + 2.6, 3)}
    spec = render.LAYOUTS[layout]
    L, T, R, B = spec["safe"]
    face = (238, spec["safe"][1] + 160, 833, spec["safe"][1] + 1000)  # a close selfie
    sprites, geo = render.build_sprites(plan, layout, screen=_screen(), faces=_faces(face))
    info = geo["phone"][0]["info"]
    assert info["side"] in ("left", "right") and info["clear"] in ("far eye", "both eyes")
    x0, _, x1, _ = geo["phone"][0]["box"]
    assert info["x"] == x0 and L <= x0 and x1 <= R
    left_eye, right_eye = render.eye_zones(face)
    far = right_eye if info["side"] == "left" else left_eye
    assert not _overlaps(x0, x1, *far)
    phone = next(sp for sp in sprites if sp["name"] == "phone")
    for fr in phone["frames"]:
        a = fr.getchannel("A").getbbox()
        assert L <= a[0] + phone["x"] and a[2] + phone["x"] <= R


def test_rapid_cards_are_grouped_into_lists():
    def spans(*starts):
        return [({"text": str(i)}, t, t + 0.3) for i, t in enumerate(starts)]

    def shape(*starts):
        return [len(g) for g in render.card_groups(spans(*starts))]

    assert shape(1.0, 4.0, 7.0) == [1, 1, 1]               # spaced: a card each, as before
    assert shape(7.37, 7.73, 8.48, 8.91) == [4]            # "live music, family nights, markets, festivals"
    assert shape(1.0, 4.4, 6.4, 7.2) == [1, 1, 2]          # "...Zoo Boo and Malloween"
    assert shape(5.57, 6.62, 7.88) == [3]                  # a list keeps growing while items come within 1.5 s
    assert shape(1.0, 2.6, 4.2) == [1, 1, 1]               # 1.6 s apart: no list starts


def _rapid_plan(n=4, gap=0.45):
    plan = script_plan("victoria-2")
    titles = ["Live music", "Family nights", "Farmers market", "Festivals", "Art walks"]
    venues = ["Bars, patios and breweries", "Free and kid-friendly picks", "Victoria Farmers Market",
              "All over the Crossroads", "Downtown"]
    icons = ["🎸", "🎈", "🥕", "🎉", "🎨"]
    t0 = 4.0
    plan["chips"] = [{"text": titles[i], "title": titles[i], "venue": venues[i], "icon": icons[i],
                      "tag": "Every week", "start": round(t0 + i * gap, 3)} for i in range(n)]
    for i, c in enumerate(plan["chips"]):
        c["end"] = plan["chips"][i + 1]["start"] if i + 1 < n else plan["cta_start"]
    return plan


@pytest.mark.parametrize("layout", ["4x5", "9x16"])
def test_rapid_cards_grow_one_list_that_stays_until_the_sign_up_line(layout):
    plan = _rapid_plan()
    sprites, geo = render.build_sprites(plan, layout)
    cards = [sp for sp in sprites if sp["name"].startswith("card")]
    assert [sp["name"] for sp in cards] == ["card1", "card2", "card3", "card4"]
    # One list, a row more as each item is said, all in one place.
    assert [c["info"]["rows"] for c in geo["cards"]] == [1, 2, 3, 4]
    assert all(c["info"]["list"] and c["info"]["of"] == 4 for c in geo["cards"])
    assert len({(sp["x"], sp["y"]) for sp in cards}) == 1
    heights = [c["box"][3] - c["box"][1] for c in geo["cards"]]
    assert heights == sorted(heights) and heights[0] < heights[-1]
    for sp, chip in zip(cards, plan["chips"]):
        assert _near(sp["start"], chip["start"])
    assert _near(cards[-1]["end"], plan["cta_start"]), "the whole list stays up until the sign-up line"
    for a, b in zip(cards, cards[1:]):
        assert a["end"] == b["start"]
    # A new row grows in: the card stretches and the row fades up, a frame at a time.
    grow = cards[2]["frames"]
    assert len(grow) == render.LIST["grow_frames"] + 1
    bottoms = [fr.getchannel("A").getbbox()[3] for fr in grow]
    assert bottoms == sorted(bottoms) and bottoms[0] < bottoms[-1]
    # Their shared tag shows once, on top.
    assert geo["cards"][-1]["info"]["tag"] == "Every week"


def test_a_list_keeps_off_the_eyes_and_drops_its_venues_when_space_is_tight():
    plan = _rapid_plan()
    close = (238, 407, 833, 1243)
    _, geo = render.build_sprites(plan, "4x5", faces=_faces(close))
    e0, e1 = _eye_band(close)
    for c in geo["cards"]:
        assert c["info"]["slot"] == "lower-third" and not c["info"]["venues"]
        assert c["box"][1] >= e1 and c["box"][3] <= HI + 1
    high = (362, 249, 708, 742)
    _, geo = render.build_sprites(plan, "4x5", faces=_faces(high))
    assert all(c["info"]["slot"] == "below-chin" and c["info"]["venues"] and c["info"]["scale"] == 1.0
               for c in geo["cards"])


def _boxes_meet(a, b):
    return _overlaps(a[0], a[2], b[0], b[2]) and _overlaps(a[1], a[3], b[1], b[3])


@pytest.mark.parametrize("layout", ["4x5", "9x16"])
@pytest.mark.parametrize("pose", ["close", "high", "none"])
def test_a_list_stays_up_through_the_phone_which_makes_room_beside_it(layout, pose):
    # "Live music, family nights, markets, festivals. It's all in one free
    # email...": the phone comes in between the last row and the sign-up line.
    plan = _rapid_plan()
    last = plan["chips"][-1]["start"]
    plan["phone"] = {"start": round(last + 0.9, 3), "end": round(last + 2.9, 3)}
    assert plan["phone"]["end"] < plan["cta_start"]
    spec = render.LAYOUTS[layout]
    L, T, R, B = spec["safe"]
    face = {"close": (238, T + 160, 833, T + 1000), "high": (362, T + 20, 708, T + 500), "none": None}[pose]
    sprites, geo = render.build_sprites(plan, layout, screen=_screen(), faces=_faces(face) if face else None)
    phone = next(sp for sp in sprites if sp["name"] == "phone")
    cards = [sp for sp in sprites if sp["name"].startswith("card")]
    assert len(cards) == 4 and _near(cards[-1]["end"], plan["cta_start"]), "the list stays to the sign-up line"
    info = geo["phone"][0]["info"]
    assert info["with_list"] and info["scale"] >= render.PHONE_MIN_SCALE
    assert (info["x"], info["y"]) == tuple(phone["box"][:2])
    for sp in cards:
        if sp["start"] < phone["end"] and sp["end"] > phone["start"]:
            assert not _boxes_meet(sp["box"], phone["box"]), (sp["name"], sp["box"], phone["box"])
    x0, y0, x1, y1 = phone["box"]
    assert L <= x0 and x1 <= R
    assert y0 >= max(b["box"][3] for b in geo["badge"]) and y1 <= render._caption_top(spec)
    for fr in phone["frames"]:
        a = fr.getchannel("A").getbbox()
        assert L <= a[0] + phone["x"] and a[2] + phone["x"] <= R and T <= a[1] + phone["y"]
    if face:
        e0, e1 = _eye_band(face)
        assert all(c["box"][1] >= e1 or c["box"][3] <= e0 for c in geo["cards"])
        left_eye, right_eye = render.eye_zones(face)
        assert not _overlaps(x0, x1, *(right_eye if info["side"] == "left" else left_eye))
    assert not any("no room for the phone" in n for n in geo["notes"])


def test_a_list_drops_its_venues_when_that_gives_the_phone_more_room():
    plan = _rapid_plan()
    last = plan["chips"][-1]["start"]
    _, alone = render.build_sprites(plan, "4x5", screen=_screen())
    assert alone["cards"][-1]["info"]["venues"]
    plan["phone"] = {"start": round(last + 0.9, 3), "end": round(last + 2.9, 3)}
    _, geo = render.build_sprites(plan, "4x5", screen=_screen())
    assert not geo["cards"][-1]["info"]["venues"] and geo["phone"][0]["info"]["with_list"]


def test_with_no_room_for_the_phone_beside_the_list_the_list_makes_way(monkeypatch):
    monkeypatch.setattr(render, "PHONE_MIN_SCALE", 0.98)
    plan = _rapid_plan()
    last = plan["chips"][-1]["start"]
    plan["phone"] = {"start": round(last + 0.9, 3), "end": round(last + 2.9, 3)}
    sprites, geo = render.build_sprites(plan, "4x5", screen=_screen())
    phone = next(sp for sp in sprites if sp["name"] == "phone")
    cards = [sp for sp in sprites if sp["name"].startswith("card")]
    assert len(cards) == 4 and _near(cards[-1]["end"], phone["start"])
    assert [c["end"] for c in geo["cards"]] == [sp["end"] for sp in cards]
    assert not geo["phone"][0]["info"]["with_list"] and geo["phone"][0]["info"]["scale"] == 1.0
    assert any("no room for the phone beside the list" in n for n in geo["notes"])


def test_spaced_cards_stay_single_cards():
    _, geo = render.build_sprites(script_plan("victoria-2"), "4x5")
    assert geo["cards"] and not any(c["info"].get("list") for c in geo["cards"])


def test_no_screenshot_means_no_phone_and_a_note():
    plan = script_plan("victoria-2")
    plan["phone"] = {"start": 10.0, "end": 12.0}
    sprites, geo = render.build_sprites(plan, "4x5", screen=None)
    assert "phone" not in [sp["name"] for sp in sprites]
    assert any("no screenshot of the site" in n for n in geo["notes"])


def test_the_site_screenshot_is_cached_for_the_day_and_old_ones_stand_in(tmp_path, monkeypatch):
    monkeypatch.setenv("VIDEO_EDIT_CACHE", str(tmp_path))
    town = towns.town("lincoln")
    calls = []

    def capture(url, path, timeout=45):
        calls.append(url)
        _screen().save(path)
        return True

    monkeypatch.setattr(render, "capture_site", capture)
    first = render.site_screenshot(town, today="2031-01-05")
    assert first == str(tmp_path / "screens" / "lincoln-2031-01-05.png")
    assert calls == ["https://www.thestar402.com/this-weekend"]
    assert render.site_screenshot(town, today="2031-01-05") == first and len(calls) == 1  # cached
    monkeypatch.setattr(render, "capture_site", lambda url, path, timeout=45: calls.append(url) or False)
    # Offline (or no Chrome) the next day: yesterday's will do, and it isn't retried all run.
    assert render.site_screenshot(town, today="2031-01-06") == first
    assert render.site_screenshot(town, today="2031-01-06") == first and len(calls) == 2
    assert render.site_screenshot(towns.town("medford"), today="2031-01-06") is None
    assert len(calls) == 3
    assert render.site_screenshot(town, today="2031-01-07", capture=False) == first and len(calls) == 3


class _Answer:
    def __init__(self, status, body):
        self.status_code, self._body = status, body

    def json(self):
        if isinstance(self._body, dict):
            return self._body
        raise ValueError("not JSON")


class _HQ:
    """requests.Session as far as newsletter_preview may use it: GET only."""

    def __init__(self, answers):
        self.answers, self.calls = answers, []

    def get(self, url, params=None, headers=None, timeout=None, allow_redirects=True):
        self.calls.append({"url": url, "params": params, "headers": dict(headers or {}),
                           "redirects": allow_redirects, "timeout": timeout})
        a = self.answers.get(url.split("hq.tristenpalori.com", 1)[1], (404, {"ok": False, "error": "not found"}))
        if isinstance(a, Exception):
            raise a
        return _Answer(*a)


ISSUE = "<!DOCTYPE html><html><head><title>This week</title></head><body><p>This week in Victoria</p></body></html>"
HQ_TOWNS = {"ok": True, "towns": [{"slug": "vic", "site": "https://thevic361.com"},
                                  {"slug": "lincoln", "site": "https://www.thestar402.com"}]}


@pytest.fixture
def hq_env(monkeypatch):
    for var in ("HQ_URL", "HQ_ASSISTANT_TOKEN", "HQ_READ_TOKEN"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(render, "_HQ", {})


def test_the_issue_comes_from_hqs_preview_by_get_with_no_key_of_its_own(hq_env, monkeypatch):
    hq = _HQ({"/api/newsletter": (200, HQ_TOWNS),
              "/api/newsletter/vic/newsletter/preview": (200, {"ok": True, "html": ISSUE, "subject": "83 things"}),
              "/api/newsletter/lincoln/newsletter/preview": (200, {"ok": True, "html": ISSUE})})
    assert render.newsletter_preview(towns.town("victoria"), session=hq) == (ISSUE, None)
    # HQ's slug is found by the site's address, not assumed to be the toolkit's.
    assert [c["url"] for c in hq.calls] == ["https://hq.tristenpalori.com/api/newsletter",
                                            "https://hq.tristenpalori.com/api/newsletter/vic/newsletter/preview"]
    assert hq.calls[1]["params"] == {"edition": "week"}
    assert all(c["redirects"] is False and c["timeout"] and "Authorization" not in c["headers"] for c in hq.calls)
    # The list is asked for once a run; a key in the environment goes in the header, as hq_feedback.py sends it.
    monkeypatch.setenv("HQ_ASSISTANT_TOKEN", "k3y-for-the-test-only")
    assert render.newsletter_preview(towns.town("lincoln"), "weekend", session=hq) == (ISSUE, None)
    assert len(hq.calls) == 3 and hq.calls[2]["params"] == {"edition": "weekend"}
    assert hq.calls[2]["headers"]["Authorization"] == "Bearer k3y-for-the-test-only"


@pytest.mark.parametrize("answers, why, down", [
    ({"/api/newsletter": (401, {"ok": False, "error": "unauthorized"})}, "HQ answered 401", True),
    ({"/api/newsletter": (302, None)}, "HQ answered 302", True),
    ({"/api/newsletter": (200, "<html>a login page</html>")}, "HQ answered 200 (not JSON)", False),
    ({"/api/newsletter": (200, HQ_TOWNS)}, "HQ answered 404", False),
    ({"/api/newsletter": (200, HQ_TOWNS),
      "/api/newsletter/vic/newsletter/preview": (200, {"ok": True, "subject": "no html"})},
     "HQ's preview had no email in it", False),
    ({"/api/newsletter": (200, {"ok": True, "towns": [{"slug": "lincoln", "site": "https://www.thestar402.com"}]})},
     "HQ has no newsletter at thevic361.com", False),
    ({"/api/newsletter": (200, {"ok": True, "towns": [{"slug": "../admin", "site": "https://www.thevic361.com"},
                                                       *HQ_TOWNS["towns"][1:]]})},
     "HQ has no newsletter at thevic361.com", False),
])
def test_without_hqs_issue_there_is_a_reason_and_a_refusal_is_not_asked_again(hq_env, answers, why, down):
    hq = _HQ(answers)
    assert render.newsletter_preview(towns.town("victoria"), session=hq) == (None, why)
    n = len(hq.calls)
    assert render.newsletter_preview(towns.town("lincoln"), session=hq)[0] is None
    # A refused key or a redirect stops HQ being asked for the rest of the run.
    assert (len(hq.calls) == n) == down


def test_no_answer_from_hq_or_a_bad_hq_url_leaves_the_issue_out(hq_env, monkeypatch):
    import requests
    hq = _HQ({"/api/newsletter": requests.ConnectionError("offline")})
    assert render.newsletter_preview(towns.town("victoria"), session=hq) == (None, "HQ didn't answer (ConnectionError)")
    assert render.newsletter_preview(towns.town("lincoln"), session=hq)[0] is None and len(hq.calls) == 1
    monkeypatch.setattr(render, "_HQ", {})
    monkeypatch.setenv("HQ_URL", "http://hq.example.com")
    hq = _HQ({})
    html, why = render.newsletter_preview(towns.town("victoria"), session=hq)
    assert html is None and "https://" in why and hq.calls == []


def test_the_phone_shows_the_issue_once_a_day_else_the_weekend_page(tmp_path, monkeypatch):
    monkeypatch.setenv("VIDEO_EDIT_CACHE", str(tmp_path))
    monkeypatch.setattr(render, "chrome_path", lambda: "/usr/bin/chromium")
    town = towns.town("victoria")
    asked, shots = [], []
    monkeypatch.setattr(render, "newsletter_preview", lambda t, edition="week": asked.append(t["slug"]) or (
        "<html><head><title>x</title></head><body><script>alert(1)</script>issue</body></html>", None))

    def capture(url, path, timeout=45):
        page = url[len("file://"):] if url.startswith("file://") else None
        shots.append((url, open(page).read() if page else None))
        _screen().save(path)
        return True

    monkeypatch.setattr(render, "capture_site", capture)
    shot, note = render.phone_screen(town, today="2031-02-02")
    assert shot == str(tmp_path / "screens" / "victoria-email-2031-02-02.png") and note is None
    url, html = shots[0]
    assert url == (tmp_path / "screens" / "victoria-email-2031-02-02.html").as_uri()
    # Opened with scripts, frames and requests other than images and fonts turned off.
    assert html.startswith("<html><head>" + render.EMAIL_CSP + "<title>")
    assert "script-src" not in render.EMAIL_CSP and "default-src 'none'" in render.EMAIL_CSP
    assert not os.path.exists(url[len("file://"):])  # the page itself isn't kept
    assert render.phone_screen(town, today="2031-02-02") == (shot, None) and len(asked) == 1  # cached

    # The next day HQ has no issue to give: the site's weekend page, with a note why.
    monkeypatch.setattr(render, "newsletter_preview", lambda t, edition="week": asked.append(t["slug"]) or
                        (None, "HQ answered 401"))
    page, note = render.phone_screen(town, today="2031-02-03")
    assert page == str(tmp_path / "screens" / "victoria-2031-02-03.png")
    assert shots[-1][0] == "https://www.thevic361.com/this-weekend"
    assert note == "the phone shows the site's /this-weekend page, not the issue: HQ answered 401"
    # Not asked again that run, and an older issue never stands in for today's.
    assert render.phone_screen(town, today="2031-02-03")[0] == page and len(asked) == 2
    assert render.email_screenshot(town, today="2031-02-04", capture=False) == (None, "none taken today")
    assert len(asked) == 2


def test_no_browser_means_no_issue_and_hq_is_not_asked(tmp_path, monkeypatch):
    monkeypatch.setenv("VIDEO_EDIT_CACHE", str(tmp_path))
    monkeypatch.setattr(render, "chrome_path", lambda: None)
    monkeypatch.setattr(render, "newsletter_preview", lambda *a, **k: pytest.fail("HQ asked with no browser"))
    assert render.email_screenshot(towns.town("lincoln"), today="2031-02-05") == (
        None, "no Chrome or Chromium to take it with")


def test_chrome_is_found_by_env_or_playwright(tmp_path, monkeypatch):
    fake = tmp_path / "pw" / "chromium-1234" / "chrome-linux64" / "chrome"
    fake.parent.mkdir(parents=True)
    fake.write_text("#!/bin/sh\n")
    fake.chmod(0o755)
    monkeypatch.delenv("VIDEO_CHROME", raising=False)
    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(tmp_path / "pw"))
    monkeypatch.setattr(render.shutil, "which", lambda name: None)
    assert render.chrome_path() == str(fake)
    monkeypatch.setenv("VIDEO_CHROME", str(fake))
    assert render.chrome_path() == str(fake)


def test_the_end_card_has_the_tagline_button_and_address():
    town = towns.town("virginiabeach")
    plan = script_plan("virginiabeach-1")
    plan["end_card"].update(tagline="Everything to do in {city}, in your inbox every Monday and Thursday",
                            button="Sign up free", url="{domain}/subscribe")
    img, info = render.end_card_picture(plan, town, town["palette"], "4x5")
    assert img.size == (1080, 1350)
    assert " ".join(info["tagline"]) == "Everything to do in Virginia Beach, in your inbox every Monday and Thursday"
    # The town's name never breaks over two lines.
    assert any("Virginia Beach" in line for line in info["tagline"])
    assert (info["button"], info["url"], info["wordmark"]) == ("Sign up free", "thetide757.com/subscribe",
                                                               ["The Tide", "757"])
    pal = town["palette"]
    assert _count(img, pal["primary"], tol=4) > 20000      # the button
    assert _count(img, pal["highlight"], tol=4) > 10000    # the 757 badge and the stroke under the name
    top = img.getpixel((540, 4))[:3]
    bottom = img.getpixel((540, 1345))[:3]
    assert all(abs(a - b) <= 4 for a, b in zip(top, [int(render.SKY[i:i + 2], 16) for i in (1, 3, 5)]))
    assert all(abs(a - b) <= 4 for a, b in zip(bottom, [int(pal["paper"][i:i + 2], 16) for i in (1, 3, 5)]))


def test_an_older_plans_line1_and_line2_still_make_an_end_card():
    town = towns.town("shoals")
    plan = script_plan("shoals-1")
    plan["end_card"]["line2"] = "{domain}"
    for layout in ("4x5", "9x16"):
        img, info = render.end_card_picture(plan, town, town["palette"], layout)
        assert info["tagline"] == ["FREE every Mon & Thu"]
        assert (info["button"], info["url"]) == ("Sign up free", "shoalssetlist.com")
        L, T, R, B = render.LAYOUTS[layout]["safe"]
        assert T <= info["top"] and info["bottom"] <= B


# ---------------------------------------------------------------- the cut

def test_cuts_snap_to_frames_without_drifting():
    plan = short_plan("/x.mov", segments=((0.517, 1.283), (2.011, 3.499), (5.25, 7.004), (7.9, 8.666)))
    info = {"duration": 20.0, "video_duration": 20.0, "audio_duration": 20.0}
    cut = render.cut_plan(plan, info)
    planned, made = 0.0, 0
    for (a, b), (f0, n) in zip(((s["start"], s["end"]) for s in plan["segments"]), cut["frames"]):
        assert abs(f0 / 30 - a) <= FRAME / 2 + 1e-9
        planned += b - a
        made += n
        assert abs(made / 30 - planned) <= FRAME / 2 + 1e-9
    assert cut["total_frames"] == round(plan["duration"] * 30)
    assert cut["total_samples"] == cut["total_frames"] * 1600


def test_a_late_take_is_reached_by_seeking():
    plan = short_plan("/x.mov", segments=((41.3, 44.0), (45.0, 47.2)))
    cut = render.cut_plan(plan, {"duration": 60.0})
    assert abs(cut["base"] - 40.3) < FRAME and abs(cut["base"] * 30 - round(cut["base"] * 30)) < 1e-9
    assert abs(cut["base"] + cut["frames"][0][0] / 30 - 41.3) <= FRAME / 2
    assert cut["kept"][0][0] == pytest.approx(41.3, abs=FRAME / 2)


def test_segments_past_the_end_of_the_source_are_clipped():
    plan = short_plan("/x.mov", segments=((0.0, 2.0), (3.0, 9.0)))
    cut = render.cut_plan(plan, {"duration": 5.0, "video_duration": 5.0, "audio_duration": 4.9})
    assert cut["kept"][-1][1] <= 4.9 + FRAME


def test_a_late_sound_track_is_clipped_where_it_ends_not_at_its_length():
    # The sound starts 0.28 s in, so its 14.72 s run ends at 15.0 like the picture.
    plan = short_plan("/x.mov", segments=((0.0, 2.0), (3.0, 14.9)))
    info = {"duration": 15.0, "video_duration": 15.0, "audio_duration": 14.72,
            "video_end": 15.0, "audio_end": 15.0}
    assert render.cut_plan(plan, info)["kept"][-1][1] == pytest.approx(14.9, abs=FRAME)


@pytest.mark.parametrize("change,err", [
    (lambda p: p.update(segments=[]), "no segments"),
    (lambda p: p.update(segments=[{"start": 2.0, "end": 1.0}]), "empty"),
    (lambda p: p.update(segments=[{"start": 0, "end": 2}, {"start": 1, "end": 3}]), "overlap"),
    (lambda p: p.update(duration=0), "positive"),
    (lambda p: p.update(speed=3.0), "speed"),
    (lambda p: p.pop("source"), "source"),
])
def test_bad_plans_are_refused(change, err):
    plan = short_plan("/x.mov")
    change(plan)
    with pytest.raises(ValueError, match=err):
        render.check_plan(plan)


def test_unknown_town_is_refused():
    plan = short_plan("/x.mov")
    plan["town"] = "kearney"
    with pytest.raises(KeyError):
        render.check_plan(plan)


# ---------------------------------------------------------------- HDR maths

def test_hdr_lut_maps_reference_white_to_sdr_white_and_rolls_off_highlights():
    lut = render.hdr_lut("hlg", size=5).splitlines()
    assert lut[0] == "LUT_3D_SIZE 5"
    grey = [float(lut[1 + i * (1 + 5 + 25)].split()[0]) for i in range(5)]  # r=g=b diagonal
    assert grey[0] == 0.0 and grey == sorted(grey) and grey[-1] <= 1.0
    # HLG 75% is reference white (BT.2408): close to, not past, SDR white.
    big = render.hdr_lut("hlg", size=9).splitlines()
    i = 6 * (1 + 9 + 81)  # 6/8 = 75% on the diagonal
    white = float(big[1 + i].split()[0])
    assert 0.9 < white < 0.99
    pq = render.hdr_lut("pq", size=9).splitlines()
    assert float(pq[1].split()[0]) == 0.0


# ---------------------------------------------------------------- ffmpeg fixtures

@pytest.fixture(scope="module")
def media(tmp_path_factory):
    """Small synthetic takes, made once."""
    if not HAVE_FFMPEG:
        pytest.skip("needs ffmpeg/ffprobe built with libass")
    d = tmp_path_factory.mktemp("media")
    tone = ("aevalsrc=exprs='0.25*sin(2*PI*220*t)*(0.55+0.45*sin(2*PI*1.3*t))*(0.7+0.3*sin(2*PI*0.31*t))'"
            ":s=44100:d={d}")
    out = {}
    # Portrait phone take: moving test pattern, a voice-like modulated tone.
    out["portrait"] = str(d / "portrait.mp4")
    ff("-f", "lavfi", "-i", "testsrc2=s=360x640:r=30:d=8", "-f", "lavfi", "-i", tone.format(d=8),
       "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "1",
       "-metadata", "location=+29.0000-097.0000/", "-shortest", out["portrait"])
    # Stored landscape and turned upright by its display matrix, like an
    # iPhone portrait take: the top of the picture (red) is on the left.
    up = str(d / "upright.mp4")
    ff("-f", "lavfi", "-i", "color=c=blue:s=360x640:r=30:d=4", "-vf",
       "drawbox=x=0:y=0:w=iw:h=100:color=red:t=fill", "-c:v", "libx264", "-preset", "ultrafast",
       "-pix_fmt", "yuv420p", up)
    stored = str(d / "stored.mp4")
    ff("-i", up, "-f", "lavfi", "-i", tone.format(d=4), "-vf", "transpose=2", "-c:v", "libx264",
       "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", stored)
    out["rotated"] = str(d / "rotated.mov")
    ff("-display_rotation:v:0", "-90", "-i", stored, "-c", "copy", out["rotated"])
    # Landscape: green left half, magenta right half, a white frame border.
    out["landscape"] = str(d / "landscape.mp4")
    ff("-f", "lavfi", "-i", "color=c=0x00C000:s=640x360:r=30:d=4", "-f", "lavfi", "-i", tone.format(d=4),
       "-vf", "drawbox=x=320:y=0:w=320:h=360:color=0xC000C0:t=fill,drawbox=x=0:y=0:w=640:h=360:color=white:t=8",
       "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
       out["landscape"])
    # No audio track at all.
    out["silent"] = str(d / "silent.mp4")
    ff("-f", "lavfi", "-i", "testsrc2=s=360x640:r=30:d=4", "-c:v", "libx264", "-preset", "ultrafast",
       "-pix_fmt", "yuv420p", out["silent"])
    return out


def colour_bars(w, h):
    """Saturated bars plus a skin tone and greys, as a lavfi graph (BT.709 RGB)."""
    cols = ["0xD02020", "0x20B030", "0x2040D0", "0xE0C020", "0x20B0C0", "0xC030B0", "0xE0AC8C", "0x808080"]
    bh = h // len(cols)
    parts = [f"color=c={c}:s={w}x{bh}:r=30:d=2[c{i}]" for i, c in enumerate(cols)]
    return ";".join(parts) + ";" + "".join(f"[c{i}]" for i in range(len(cols))) + f"vstack=inputs={len(cols)}"


@pytest.fixture(scope="module")
def hlg(tmp_path_factory):
    """A 10-bit HLG BT.2020 take of known colours, and the same colours in SDR."""
    if not HAVE_FFMPEG:
        pytest.skip("needs ffmpeg/ffprobe built with libass")
    if "libx265" not in _encoders() or "zscale" not in _filters():
        pytest.skip("needs libx265 and zscale to make an HLG clip")
    d = tmp_path_factory.mktemp("hlg")
    src = str(d / "hlg.mov")
    ff("-f", "lavfi", "-i", colour_bars(360, 640), "-f", "lavfi", "-i", "sine=f=300:sample_rate=48000:d=2",
       "-vf", "format=gbrpf32le,zscale=tin=bt709:pin=bt709:t=linear:p=bt2020,"
              "zscale=t=arib-std-b67:npl=203,zscale=m=bt2020nc:r=tv,format=yuv420p10le",
       "-c:v", "libx265", "-x265-params", "log-level=error:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc",
       "-crf", "12", "-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-colorspace", "bt2020nc",
       "-color_range", "tv", "-tag:v", "hvc1", "-c:a", "aac", "-shortest", src)
    ref = ff("-f", "lavfi", "-i", colour_bars(360, 640), "-frames:v", "1", "-vf",
             "scale=1080:1920:flags=neighbor,format=rgb24", "-f", "rawvideo", "-")
    return src, ref


# ---------------------------------------------------------------- probe and fonts in ffmpeg

@needs_ffmpeg
def test_probe_reads_rotation_hdr_depth_and_audio(media, hlg):
    p = render.probe(media["rotated"])
    assert p["rotation"] in (90, 270)
    assert (p["coded_width"], p["coded_height"]) == (640, 360)
    assert (p["width"], p["height"]) == (360, 640)  # what ffmpeg's filters will see
    p = render.probe(media["landscape"])
    assert (p["width"], p["height"], p["rotation"]) == (640, 360, 0)
    p = render.probe(hlg[0])
    assert (p["hdr"], p["bit_depth"], p["color_transfer"]) == ("hlg", 10, "arib-std-b67")
    assert p["has_audio"]
    p = render.probe(media["silent"])
    assert not p["has_audio"] and p["hdr"] is None and p["bit_depth"] == 8 and abs(p["fps"] - 30) < 0.01


@needs_ffmpeg
def test_libass_draws_with_fredoka_not_a_fallback(tmp_path):
    ass, _ = render.build_ass(script_plan("lincoln-2"), "9x16")
    (tmp_path / "o.ass").write_text(ass, encoding="utf-8")
    os.symlink(render.FONTS_DIR, tmp_path / "fonts")
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostdin", "-v", "verbose", "-f", "lavfi", "-i",
                        "color=c=gray:s=1080x1920:r=30:d=8", "-vf", "subtitles=o.ass:fontsdir=fonts",
                        "-f", "null", "-"], cwd=tmp_path, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr[-1500:]
    picks = re.findall(r"fontselect: \(([^,]+), (\d+), \d+\) -> ([^,]+),", r.stderr)
    assert ("Fredoka", "700", "Fredoka-Bold") in picks
    assert all(face.startswith("Fredoka-") for _, _, face in picks), picks
    assert "selecting one more font" not in r.stderr and "fallback" not in r.stderr.lower()


def _ass_frames(tmp_path, ass, size, times, bg=(128, 128, 128)):
    W, H = size
    (tmp_path / "o.ass").write_text(ass, encoding="utf-8")
    if not (tmp_path / "fonts").exists():
        os.symlink(render.FONTS_DIR, tmp_path / "fonts")
    sel = "+".join(f"eq(n,{round(t * 30)})" for t in times)
    raw = ff("-f", "lavfi", "-i", f"color=c=0x{bg[0]:02x}{bg[1]:02x}{bg[2]:02x}:s={W}x{H}:r=30:d={max(times) + 0.2}",
             "-vf", f"format=gbrp,subtitles=o.ass:fontsdir=fonts,select='{sel}',format=rgb24",
             "-fps_mode", "passthrough", "-f", "rawvideo", "-", cwd=tmp_path)
    n = W * H * 3
    return [raw[i:i + n] for i in range(0, len(raw), n)]


@needs_ffmpeg
def test_text_widths_and_anchors_match_what_libass_draws(tmp_path):
    bold, _ = render.fonts()
    em = 80
    text = "TRUNK-OR-TREATS @ $1,000"
    ass = "\n".join([
        "[Script Info]", "ScriptType: v4.00+", "PlayResX: 1080", "PlayResY: 1920", "WrapStyle: 2",
        "ScaledBorderAndShadow: yes", "", "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, "
        "Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, "
        "MarginL, MarginR, MarginV, Encoding",
        f"Style: Bold,Fredoka,{bold.ass_size(em):.2f},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,"
        "100,100,0,0,1,0,0,5,0,0,0,1", "", "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
        f"Dialogue: 0,0:00:00.00,0:00:01.00,Bold,,0,0,0,,{{\\pos(540,600)}}{text}",
        f"Dialogue: 0,0:00:00.00,0:00:01.00,Bold,,0,0,0,,{{\\pos(540,{1300 - bold.cap_offset(em):.1f})}}HOOK",
    ])
    rgb = _ass_frames(tmp_path, ass, (1080, 1920), [0.5], bg=(0, 0, 0))[0]

    def ink(y0, y1):
        xs, ys = [], []
        for y in range(y0, y1):
            row = rgb[y * 1080 * 3:(y + 1) * 1080 * 3]
            hit = [x for x in range(1080) if row[3 * x] > 128]
            if hit:
                xs += [hit[0], hit[-1]]
                ys.append(y)
        return min(xs), max(xs), min(ys), max(ys)

    x0, x1, _, _ = ink(450, 750)
    predicted = bold.width(text, em)
    # Advances without kerning: never narrower than the ink, at most a few % wider.
    assert x1 - x0 + 1 <= predicted <= (x1 - x0 + 1) * 1.06 + 12, (x1 - x0 + 1, predicted)
    # Capitals centred on the anchor once cap_offset is applied.
    _, _, y0, y1 = ink(1150, 1450)
    assert abs((y0 + y1) / 2 - 1300) <= 2.5, (y0, y1)
    assert abs((y1 - y0 + 1) - bold.cap * em) <= 3


@needs_ffmpeg
@pytest.mark.parametrize("layout", ["9x16", "4x5"])
def test_no_caption_leaves_the_safe_zone(tmp_path, layout):
    """Rendered pixels, not geometry: the longest words in the scripts, over grey."""
    plan = script_plan("shoals-2")
    plan["words"][10:13] = [{"text": "trunk-or-treats-hootenanny", "start": 6.7, "end": 7.3},
                            {"text": "Craterian", "start": 7.32, "end": 7.7},
                            {"text": "Washington,", "start": 7.72, "end": 8.1}]
    ass, geo = render.build_ass(plan, layout)
    W, H = render.LAYOUTS[layout]["size"]
    L, T, R, B = geo["safe"]
    # Midway through every caption up to 8 s, the long words among them.
    times = [round((c["start"] + c["end"]) / 2, 3) for c in geo["captions"] if c["end"] < 8.2]
    assert any("hootenanny" in c["text"] for c in geo["captions"])
    grey = bytes([128]) * (W * 3)
    for t, rgb in zip(times, _ass_frames(tmp_path, ass, (W, H), times)):
        drawn = False
        for y in range(H):
            row = rgb[y * W * 3:(y + 1) * W * 3]
            if row == grey:
                continue
            inside = T <= y < B
            if inside and row[:L * 3] == grey[:L * 3] and row[R * 3:] == grey[R * 3:]:
                drawn = True
                continue
            for x in range(W):
                if (not inside or x < L or x >= R) and max(abs(v - 128) for v in row[3 * x:3 * x + 3]) > 6:
                    raise AssertionError(f"{layout} at {t}s: text drawn at x={x}, y={y}")
            drawn = drawn or inside
        assert drawn, f"nothing drawn at {t}"


@needs_ffmpeg
def test_a_word_ending_in_a_backslash_draws_as_the_word(tmp_path):
    """Pixels: the highlighted "back\\" caption is about as wide as its own
    text, not its text plus a colour tag drawn as letters."""
    bold, _ = render.fonts()
    plan = short_plan("/x.mov", overlays=False, end_card=False)
    plan["words"] = [{"text": "back\\", "start": 0.1, "end": 0.5}, {"text": "slash", "start": 0.52, "end": 0.9}]
    ass, geo = render.build_ass(plan, "9x16")
    L, _, R, _ = geo["safe"]
    spec = render.LAYOUTS["9x16"]
    rgb = _ass_frames(tmp_path, ass, (1080, 1920), [0.3], bg=(128, 128, 128))[0]
    cy = spec["caption_y"]
    xs = [x for y in range(cy - 60, cy + 60, 4) for x in range(1080)
          if max(abs(v - 128) for v in rgb[(y * 1080 + x) * 3:(y * 1080 + x) * 3 + 3]) > 40]
    want = bold.width("back/ slash", spec["caption_em"])
    assert L <= min(xs) and max(xs) < R, (min(xs), max(xs))
    assert max(xs) - min(xs) < want + 2 * 8 + 30, (max(xs) - min(xs), want)


# ---------------------------------------------------------------- renders

@pytest.fixture(scope="module")
def portrait_render(media, tmp_path_factory):
    out = tmp_path_factory.mktemp("portrait")
    plan = short_plan(media["portrait"], segments=((0.4, 2.0), (2.9, 4.6)), speed=1.05)
    info = {}
    path = render.render(plan, str(out), "9x16", info=info)
    return plan, path, info


@needs_ffmpeg
def test_portrait_render_format_duration_sync_and_loudness(portrait_render):
    plan, path, info = portrait_render
    assert os.path.basename(path) == "reel-9x16.mp4"
    assert_av_and_format(path, plan, (1080, 1920))
    lufs = render.loudness(path)
    assert abs(lufs["integrated"] - (-14)) <= 1.0, lufs
    assert lufs["true_peak"] <= -1.0
    assert info["hdr_mode"] is None and info["speed"] == 1.05
    assert [round(a, 4) for a, _ in info["kept_segments"]] == [0.4, 2.9]
    assert not [n for n in os.listdir(os.path.dirname(path)) if n.endswith(".part.mp4")]


@needs_ffmpeg
def test_renders_have_a_keyframe_every_two_seconds(portrait_render):
    # Meta asks for a closed GOP of 2-5 s, and post_reel.py warns past 5 s;
    # x264's default put the second keyframe 8.3 s in.
    plan, path, _ = portrait_render
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey",
                          "-show_entries", "frame=pts_time", "-of", "csv=p=0", path],
                         capture_output=True, text=True, check=True).stdout
    keys = sorted(float(line.split(",")[0]) for line in out.split())
    assert keys and keys[0] == 0.0
    stops = keys + [plan["duration"]]
    assert max(b - a for a, b in zip(stops, stops[1:])) <= 2.0 + 1e-3, keys
    with open(path, "rb") as f:
        assert b"open_gop=0" in f.read(), "x264 GOPs are closed"


@needs_ffmpeg
def test_portrait_render_draws_the_brand_colours(portrait_render):
    plan, path, info = portrait_render
    pal = towns.town("victoria")["palette"]

    def near(rgb, hexcolor, tol=10):
        want = [int(hexcolor[i:i + 2], 16) for i in (1, 3, 5)]
        return all(abs(a - b) <= tol for a, b in zip(rgb, want))

    # The hook badge: a white card with the "8" in the accent pill.
    x0, y0, x1, y1 = info["overlay"]["badge"][0]["box"]
    rgb = frame_rgb(path, 0.9, 1080, 1920)
    px = [rgb[(y * 1080 + x) * 3:(y * 1080 + x) * 3 + 3] for y in range(y0, y1, 2) for x in range(x0, x1, 2)]
    want = [int(pal["accent"][i:i + 2], 16) for i in (1, 3, 5)]
    accent = [p for p in px if all(abs(a - b) <= 24 for a, b in zip(p, want))]
    assert len(accent) > 400, "the number's pill is there"
    # Blended on RGB frames, the brand colour comes out as itself in a BT.709 file.
    median = [sorted(p[c] for p in accent)[len(accent) // 2] for c in range(3)]
    assert all(abs(a - b) <= 3 for a, b in zip(median, want)), (median, want)
    assert sum(1 for p in px if min(p) > 245) > 15000, "the white card"
    # The end card: sky at the top, paper at the bottom, the logo and the button.
    end = frame_rgb(path, plan["duration"] - 0.1, 1080, 1920)
    assert near(mean_rgb(end, 1080, (80, 20, 200, 60)), render.SKY, 6)
    assert near(mean_rgb(end, 1080, (80, 1860, 200, 1900)), pal["paper"], 6)
    top = info["overlay"]["end_card"]["info"]["top"]
    logo = mean_rgb(end, 1080, (520, top + 80, 560, top + 120))
    assert not near(logo, render.SKY, 30) and not near(logo, pal["paper"], 30), "the logo is on the card"
    row = [end[(y * 1080 + 540) * 3:(y * 1080 + 540) * 3 + 3] for y in range(top, 1480)]
    assert sum(1 for p in row if near(p, pal["primary"], 8)) > 60, "the Sign up free button"
    # The picture has no face, so the card took the fixed slot over the captions, and said so.
    card = info["overlay"]["cards"][0]["info"]
    assert card["slot"] == "fixed" and info["face"].get("found", 0) == 0
    assert any("no face found" in n for n in info["notes"])


@needs_ffmpeg
def test_rotated_take_renders_upright_in_4x5(media, tmp_path):
    plan = short_plan(media["rotated"], segments=((0.0, 3.0),), words=False, overlays=False, end_card=False)
    path = render.render(plan, str(tmp_path), "4x5")
    assert os.path.basename(path) == "feed-4x5.mp4"
    assert_av_and_format(path, plan, (1080, 1350))
    rgb = frame_rgb(path, 1.0, 108, 135)
    top = mean_rgb(rgb, 108, (10, 0, 98, 6))
    mid = mean_rgb(rgb, 108, (10, 60, 98, 80))
    assert top[0] > 150 and top[2] < 90, top    # red band on top: turned the right way
    assert mid[2] > 150 and mid[0] < 90, mid


@needs_ffmpeg
def test_landscape_take_sits_on_a_blurred_darkened_copy(media, tmp_path):
    plan = short_plan(media["landscape"], segments=((0.0, 3.0),), words=False, overlays=False, end_card=False)
    path = render.render(plan, str(tmp_path), "9x16")
    assert_av_and_format(path, plan, (1080, 1920))
    rgb = frame_rgb(path, 1.0, 1080, 1920)
    fh = 608
    y0 = int((250 + 1480) / 2 - fh / 2)
    fg_left = mean_rgb(rgb, 1080, (100, y0 + 100, 300, y0 + 300))
    fg_right = mean_rgb(rgb, 1080, (780, y0 + 100, 980, y0 + 300))
    assert fg_left[1] > 150 and fg_left[0] < 60      # sharp green
    assert fg_right[0] > 150 and fg_right[1] < 60    # sharp magenta
    bg = mean_rgb(rgb, 1080, (100, 60, 300, 200))
    assert max(bg) < 120 and bg[1] > bg[0]           # the same green, blurred and darkened
    # The frame's white border survives at the top edge of the picture.
    assert min(mean_rgb(rgb, 1080, (400, y0 + 2, 600, y0 + 8))) > 200


@needs_ffmpeg
def test_take_without_audio_gets_silence_of_the_same_length(media, tmp_path, monkeypatch):
    plan = short_plan(media["silent"], segments=((0.5, 3.0),))
    info = {}
    monkeypatch.chdir(tmp_path)  # and a relative output folder
    path = render.render(plan, "renders", "9x16", info=info)
    assert path == str(tmp_path / "renders" / "reel-9x16.mp4")
    assert_av_and_format(path, plan, (1080, 1920))
    assert max(abs(x) for x in pcm(path)) == 0
    assert info["loudness_pass1"] is None


@needs_ffmpeg
def test_a_silent_sound_track_is_flagged_not_posted_unheard(tmp_path):
    # A muted or covered mic still makes an audio track; the render can't
    # fix it, so it must say so (edit.py prints render notes as warnings).
    src = str(tmp_path / "hush.mp4")
    ff("-f", "lavfi", "-i", "testsrc2=s=180x320:r=30:d=3", "-f", "lavfi", "-i", "anoisesrc=a=0.0002:c=pink:d=3",
       "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src)
    plan = short_plan(src, segments=((0.2, 2.2),), words=False, overlays=False, end_card=False)
    info = {}
    path = render.render(plan, str(tmp_path / "out"), "4x5", info=info)
    assert_av_and_format(path, plan, (1080, 1350))
    assert info["loudness_pass1"] is None
    assert any("silent or nearly" in n and "mic" in n for n in info["notes"]), info["notes"]


@needs_ffmpeg
@slow
@pytest.mark.parametrize("mode", ["zscale", "lut"])
def test_hlg_take_is_tone_mapped_not_washed_out(hlg, tmp_path, monkeypatch, mode):
    src, ref = hlg
    if mode == "lut" and "lut3d" not in _filters():
        pytest.skip("no lut3d filter")
    monkeypatch.setattr(render, "hdr_mode", lambda info, filters=None: mode if info.get("hdr") else None)
    plan = short_plan(src, segments=((0.0, 1.5),), words=False, overlays=False, end_card=False)
    info = {}
    path = render.render(plan, str(tmp_path), "9x16", info=info)
    assert info["hdr_mode"] == mode
    v, _ = assert_av_and_format(path, plan, (1080, 1920))
    out = frame_rgb(path, 0.7, 1080, 1920)
    # The naive path: the 10-bit BT.2020 HLG picture shown as if it were BT.709.
    naive = ff("-i", src, "-frames:v", "1", "-vf",
               "scale=1080:1920:out_color_matrix=bt709:out_range=pc,format=rgb24", "-f", "rawvideo", "-")
    s_ref, s_out, s_naive = saturation(ref), saturation(out), saturation(naive)
    assert s_naive < 0.75 * s_ref, "the check can tell washed-out colour apart"
    assert s_out > 0.85 * s_ref, (s_out, s_ref)
    assert 0.85 < luma(out) / luma(ref) < 1.1, (luma(out), luma(ref))
    # Skin tone bar (7th of 8) within a few levels of the SDR original.
    skin_ref = mean_rgb(ref, 1080, (300, 6 * 240 + 60, 780, 6 * 240 + 180))
    skin_out = mean_rgb(out, 1080, (300, 6 * 240 + 60, 780, 6 * 240 + 180))
    assert all(abs(a - b) <= 14 for a, b in zip(skin_ref, skin_out)), (skin_ref, skin_out)


def _flash_and_beep(path, at, length=12.0):
    """Grey video with 3-frame white flashes and a 1 kHz beep starting on the same frames."""
    frames = "+".join(f"between(n,{round(t * 30)},{round(t * 30) + 2})" for t in at)
    beeps = "+".join(f"between(t,{t},{t + 0.06})" for t in at)
    ff("-f", "lavfi", "-i", f"color=c=0x303030:s=360x640:r=30:d={length}",
       "-f", "lavfi", "-i", f"aevalsrc=exprs='0.5*sin(2*PI*1000*t)*({beeps})':s=48000:d={length}",
       "-vf", f"drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='{frames}'",
       "-c:v", "libx264", "-preset", "ultrafast", "-qp", "10", "-pix_fmt", "yuv420p",
       "-c:a", "pcm_s16le", path)


@needs_ffmpeg
@slow
def test_sound_stays_on_the_picture_through_cuts_and_speed_up(tmp_path):
    src = str(tmp_path / "av.mov")
    flashes = [1.5, 2.2, 3.7, 5.4, 6.9, 8.8, 10.1, 11.0]
    _flash_and_beep(src, flashes)
    segments = ((1.0, 4.2), (5.0, 7.7), (8.3, 11.5))
    plan = short_plan(src, segments=segments, speed=1.08, words=False, overlays=False, end_card=False)
    path = render.render(plan, str(tmp_path / "out"), "9x16")
    assert_av_and_format(path, plan, (1080, 1920))
    # Picture: the first bright frame of each flash.
    raw = ff("-i", path, "-vf", "scale=8:8,format=gray", "-f", "rawvideo", "-")
    bright = [sum(raw[i:i + 64]) / 64 > 160 for i in range(0, len(raw), 64)]
    seen = [i / 30 for i, b in enumerate(bright) if b and (i == 0 or not bright[i - 1])]
    # Sound: where each beep starts.
    pcm_ = pcm(path)
    blk = 48
    env = [max(abs(x) for x in pcm_[i:i + blk]) for i in range(0, len(pcm_) - blk, blk)]
    top = max(env)
    heard = []
    for i in range(1, len(env)):
        if env[i] > top * 0.3 >= env[i - 1] and (not heard or i * blk / 48000 - heard[-1] > 0.25):
            heard.append(i * blk / 48000)
    # Where the plan says each flash lands on the output timeline.
    want, before = [], 0.0
    for a, b in segments:
        want += [(before + t - a) / 1.08 for t in flashes if a + 0.05 < t < b - 0.15]
        before += b - a
    assert len(seen) == len(heard) == len(want), (seen, heard, want)
    for w, s, h in zip(want, seen, heard):
        assert abs(s - w) <= FRAME + 0.004, (w, s)
        assert abs(h - s) <= FRAME, f"beep at {h:.3f}s, flash at {s:.3f}s"


def _flash_and_beep_times(path):
    """(first frame of each flash, start of each beep) in a render, seconds."""
    raw = ff("-i", path, "-vf", "scale=8:8,format=gray", "-f", "rawvideo", "-")
    bright = [sum(raw[i:i + 64]) / 64 > 160 for i in range(0, len(raw), 64)]
    seen = [i / 30 for i, b in enumerate(bright) if b and (i == 0 or not bright[i - 1])]
    sound, blk = pcm(path), 48
    env = [max(abs(x) for x in sound[i:i + blk]) for i in range(0, len(sound) - blk, blk)]
    heard = []
    for i in range(1, len(env)):
        if env[i] > max(env) * 0.3 >= env[i - 1] and (not heard or i * blk / 48000 - heard[-1] > 0.25):
            heard.append(i * blk / 48000)
    return seen, heard


@needs_ffmpeg
def test_sound_that_starts_after_the_picture_stays_on_it(tmp_path):
    # Some files' sound track starts a little after the picture. The trims go
    # by timestamp and the joins count samples, so a segment kept from before
    # the sound began came out short and every later beep landed ~0.25 s
    # before its flash.
    flashes, late = [0.9, 1.8, 2.7, 3.6], 0.3
    frames = "+".join(f"between(n,{round(t * 30)},{round(t * 30) + 2})" for t in flashes)
    beeps = "+".join(f"between(t,{t - late},{t - late + 0.06})" for t in flashes)
    ff("-f", "lavfi", "-i", "color=c=0x303030:s=180x320:r=30:d=4.5",
       "-vf", f"drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='{frames}'",
       "-c:v", "libx264", "-preset", "ultrafast", "-qp", "10", "-pix_fmt", "yuv420p", str(tmp_path / "v.mp4"))
    ff("-f", "lavfi", "-i", f"aevalsrc=exprs='0.5*sin(2*PI*1000*t)*({beeps})':s=48000:d={4.5 - late}",
       "-c:a", "aac", str(tmp_path / "a.m4a"))
    src = str(tmp_path / "late.mov")
    ff("-i", str(tmp_path / "v.mp4"), "-itsoffset", str(late), "-i", str(tmp_path / "a.m4a"),
       "-map", "0:v", "-map", "1:a", "-c", "copy", src)
    assert render.probe(src)["audio_start"] > 0.2
    plan = short_plan(src, segments=((0.0, 1.2), (1.6, 2.2), (2.5, 4.2)), words=False, overlays=False,
                      end_card=False)
    info = {}
    path = render.render(plan, str(tmp_path / "out"), "9x16", info=info)
    assert_av_and_format(path, plan, (1080, 1920))
    seen, heard = _flash_and_beep_times(path)
    assert len(seen) == len(heard) == 4, (seen, heard)
    for s, h in zip(seen, heard):
        assert abs(h - s) <= FRAME, f"beep at {h:.3f}s, flash at {s:.3f}s"
    # analyze.py times words from the first sample, so a person should look.
    assert any("sound track starts 0.2" in n or "sound track starts 0.3" in n for n in info["notes"]), info["notes"]


# ---------------------------------------------------------------- edit.py

@needs_ffmpeg
@slow
def test_edit_cli_renders_reports_and_prints_warnings(media, tmp_path, monkeypatch, capsys):
    import edit

    plan = short_plan(media["portrait"], segments=((0.2, 3.4),), video_id="victoria-1")
    calls = []
    fake = types.ModuleType("analyze")

    def fake_plan(source, video_id=None, transcript=None, **kw):
        calls.append((source, video_id, transcript))
        return [dict(plan, source=os.path.abspath(source))]

    fake.plan = fake_plan
    monkeypatch.setitem(sys.modules, "analyze", fake)
    out = tmp_path / "renders"
    code = edit.main([media["portrait"], "--video", "victoria-1", "--out", str(out),
                      "--formats", "9x16,4x5"])
    printed = capsys.readouterr().out
    assert code == 0, printed
    assert calls == [(media["portrait"], "victoria-1", None)]
    d = out / "victoria-1"
    assert sorted(os.listdir(d)) == ["feed-4x5.mp4", "reel-9x16.mp4", "report.json", "thumb.jpg"]
    report = json.loads((d / "report.json").read_text())
    assert report["plan"]["video_id"] == "victoria-1"
    assert report["renders"]["9x16"]["probe"]["video"]["width"] == 1080
    assert report["renders"]["4x5"]["probe"]["video"]["height"] == 1350
    assert abs(report["renders"]["9x16"]["loudness"]["integrated"] + 14) <= 1
    thumb, _, _ = streams(str(d / "thumb.jpg"))
    assert (thumb["width"], thumb["height"]) == (1080, 1920)
    assert "! test warning: check the Monday chip" in printed
    assert "reel-9x16.mp4" in printed and "feed-4x5.mp4" in printed
    # A saved report re-renders as is (after a hand fix to its plan).
    assert render.main([str(d / "report.json"), "--out", str(tmp_path / "again"), "--formats", "4x5"]) == 0
    assert os.path.isfile(tmp_path / "again" / "victoria-1" / "feed-4x5.mp4")


@needs_ffmpeg
def test_edit_cli_refuses_bad_arguments(media, tmp_path, monkeypatch, capsys):
    import edit

    monkeypatch.setitem(sys.modules, "analyze", types.ModuleType("analyze"))
    for argv in ([media["portrait"], "--formats", "16x9"],
                 [media["portrait"], media["silent"], "--transcript", "t.json"],
                 [str(tmp_path / "missing.mov")]):
        with pytest.raises(SystemExit) as e:
            edit.main(argv)
        assert e.value.code == 2
    nothing = types.ModuleType("analyze")
    nothing.plan = lambda source, **kw: []
    monkeypatch.setitem(sys.modules, "analyze", nothing)
    assert edit.main([media["portrait"], "--out", str(tmp_path)]) == 1
    assert "no script found" in capsys.readouterr().out


def _fake_renderer(monkeypatch, fail=()):
    """render.py's outputs without ffmpeg: each "video" holds its source's
    path, so a test can tell which take ended up where."""
    def fake_render(plan, out_dir, layout="9x16", *, info=None):
        if plan["video_id"] in fail:
            raise TypeError(f"{plan['video_id']} is broken")
        render.check_plan(plan)
        os.makedirs(out_dir, exist_ok=True)
        path = os.path.join(out_dir, render.LAYOUTS[layout]["file"])
        with open(path, "w", encoding="utf-8") as f:
            f.write(plan["source"])
        if info is not None:
            info["notes"] = []
        return path

    def fake_thumbnail(video, out_path, at=0.8):
        with open(out_path, "wb") as f:
            f.write(b"jpeg")
        return out_path

    monkeypatch.setattr(render, "render", fake_render)
    monkeypatch.setattr(render, "summarize", lambda p: {"video": {"width": 1080, "height": 1920, "duration": 4.0}})
    monkeypatch.setattr(render, "loudness", lambda p: {"integrated": -14.0, "true_peak": -1.5})
    monkeypatch.setattr(render, "thumbnail", fake_thumbnail)


def _fake_analyze(monkeypatch, plans_for):
    fake = types.ModuleType("analyze")
    fake.plan = lambda source, **kw: plans_for(os.path.abspath(source))
    monkeypatch.setitem(sys.modules, "analyze", fake)


def _raws(tmp_path, *names):
    out = []
    for name in names:
        (tmp_path / name).write_bytes(b"raw")
        out.append(str(tmp_path / name))
    return out


def test_edit_keeps_both_takes_when_two_raw_files_hold_the_same_script(tmp_path, monkeypatch, capsys):
    # The second used to land in the same folder and silently replace the first.
    import edit

    _fake_renderer(monkeypatch)
    _fake_analyze(monkeypatch, lambda src: [short_plan(src, video_id="victoria-1")])
    out = tmp_path / "renders"
    assert edit.main([*_raws(tmp_path, "monday.mov", "tuesday.mov"), "--out", str(out)]) == 0
    printed = capsys.readouterr().out
    assert (out / "victoria-1" / "reel-9x16.mp4").read_text().endswith("monday.mov")
    assert (out / "victoria-1-2" / "reel-9x16.mp4").read_text().endswith("tuesday.mov")
    assert (out / "victoria-1-2" / "feed-4x5.mp4").exists()
    report = json.loads((out / "victoria-1-2" / "report.json").read_text())
    assert report["video_id"] == "victoria-1" and report["plan"]["video_id"] == "victoria-1"
    assert "! victoria-1 was also cut from monday.mov" in printed
    assert "2 videos ready" in printed


def test_edit_carries_on_past_a_plan_that_fails_to_render(tmp_path, monkeypatch, capsys):
    # One bad plan (any error, not only RenderError) must not cost the others.
    import edit

    _fake_renderer(monkeypatch, fail={"victoria-1"})
    _fake_analyze(monkeypatch, lambda src: [short_plan(src, video_id="victoria-1"),
                                            short_plan(src, video_id="shoals-2", town="shoals")])
    out = tmp_path / "renders"
    assert edit.main([*_raws(tmp_path, "two.mov"), "--out", str(out)]) == 1
    printed = capsys.readouterr().out
    assert "FAILED" in printed and "victoria-1 failed to render: victoria-1 is broken" in printed
    assert (out / "shoals-2" / "report.json").exists()
    assert "1 video ready" in printed


def test_edit_summary_shows_script_differences_no_warning_covers():
    # Whisper's slip on an ordinary word ("Fue" for "Free") gets no warning
    # but is burned into the captions as heard, so the summary still says so;
    # a difference a warning already names isn't repeated.
    import edit

    plan = {"video_id": "shoals-1", "takes": [{"start": 0.8, "end": 19.8, "coverage": 0.95}], "take": 0,
            "similarity": 0.95, "duration": 16.0, "speed": 1.049,
            "warnings": ['Wrong name? At 6.7s heard "chord" where the script says "court".'],
            "diff": [{"kind": "substitute", "script": "court", "spoken": "chord", "at": 6.683},
                     {"kind": "substitute", "script": "free", "spoken": "fue", "at": 12.917},
                     {"kind": "omit", "script": "yes that", "spoken": "", "at": 3.0},
                     {"kind": "insert", "script": "", "spoken": "really", "at": 4.31}]}
    lines = edit.summary({"plan": plan, "renders": {}, "notes": [], "dir": "out/renders/shoals-1"}).splitlines()
    assert sum("court" in line for line in lines) == 1
    assert '  ~ At 12.9s heard "fue" where the script says "free" (captioned as heard)' in lines
    assert '  ~ At 3.0s "yes that" was not said' in lines
    assert '  ~ At 4.3s heard "really", which is not in the script (captioned)' in lines
    assert edit.script_diff({"diff": ["junk", None, {"kind": "other", "at": 1.0}]}) == []
    assert edit.script_diff({"warnings": None}) == []


def test_rerendering_a_report_writes_next_to_it(tmp_path, monkeypatch):
    # A second take lives in <video_id>-2/; re-rendering its report used to
    # write into <video_id>/, over the first take's videos.
    import edit

    _fake_renderer(monkeypatch)
    _fake_analyze(monkeypatch, lambda src: [short_plan(src, video_id="victoria-1")])
    out = tmp_path / "renders"
    assert edit.main([*_raws(tmp_path, "monday.mov", "tuesday.mov"), "--out", str(out)]) == 0
    (out / "victoria-1-2" / "reel-9x16.mp4").unlink()
    assert render.main([str(out / "victoria-1-2" / "report.json"), "--formats", "9x16"]) == 0
    assert (out / "victoria-1-2" / "reel-9x16.mp4").read_text().endswith("tuesday.mov")
    assert (out / "victoria-1" / "reel-9x16.mp4").read_text().endswith("monday.mov")
    # --out still means OUT/<video_id>/, and a bare plan still goes to out/renders by default.
    assert render.main([str(out / "victoria-1-2" / "report.json"), "--out", str(tmp_path / "again"),
                        "--formats", "9x16"]) == 0
    assert (tmp_path / "again" / "victoria-1" / "reel-9x16.mp4").read_text().endswith("tuesday.mov")


def test_edit_never_writes_outside_its_out_folder(tmp_path, monkeypatch, capsys):
    import edit

    _fake_renderer(monkeypatch)
    _fake_analyze(monkeypatch, lambda src: [short_plan(src, video_id="../escaped")])
    out = tmp_path / "renders"
    assert edit.main([*_raws(tmp_path, "take.mov"), "--out", str(out)]) == 1
    assert "failed to render" in capsys.readouterr().out
    assert not (tmp_path / "escaped").exists() and not os.path.exists(out / ".." / "escaped")


def test_edit_does_not_import_analyze_until_it_runs():
    r = subprocess.run([sys.executable, "-c", "import sys; sys.path.insert(0, %r); import edit; "
                        "print('analyze' in sys.modules)" % VIDEO], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "False"
