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

with open(os.path.join(VIDEO, "scripts.json"), encoding="utf-8") as _f:
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
    for f in ("Fredoka-Bold.ttf", "Fredoka-SemiBold.ttf", "OFL.txt"):
        assert os.path.getsize(os.path.join(render.FONTS_DIR, f)) > 1000
    with open(os.path.join(render.FONTS_DIR, "OFL.txt"), encoding="utf-8") as f:
        assert "SIL Open Font License" in f.read()
    # Fredoka's own names, which is what libass matches on.
    for path, family, weight in (("Fredoka-Bold.ttf", "Fredoka", 700),
                                 ("Fredoka-SemiBold.ttf", "Fredoka SemiBold", 600)):
        with open(os.path.join(render.FONTS_DIR, path), "rb") as fh:
            data = fh.read()
        assert family.encode("utf-16-be") in data
        n = struct.unpack_from(">H", data, 4)[0]
        os2 = next(struct.unpack_from(">I", data, 12 + 16 * i + 8)[0] for i in range(n)
                   if data[12 + 16 * i:16 + 16 * i] == b"OS/2")
        assert struct.unpack_from(">H", data, os2 + 4)[0] == weight
    for ch in "·’$@&,!?é–":
        assert bold.has(ch) and semi.has(ch)
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
    ass, _ = render.build_ass(plan, "9x16")
    assert "🎃" not in ass
    for _, _, _, _, text in events(ass, "hook") + events(ass, "chip1"):
        # Only render.py's own override blocks; the copy's are escaped text.
        for block in re.findall(r"(?<!\\)\{([^}]*)\}", text):
            assert "fs300" not in block.lower() and "pos(0,0)" not in block
    hook = " ".join(plain(e[4]) for e in events(ass, "hook") if e[0] == 21)
    assert "{\\FS300\\C&H0000FF&}HUGE/N & $1,000" in hook
    chip = "".join(plain(e[4]) for e in events(ass, "chip1") if e[0] == 11)
    assert "{\\pos(0,0)}Moved" in chip


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
def test_ass_carries_the_plans_times(layout):
    plan = script_plan("victoria-2")
    ass, geo = render.build_ass(plan, layout)
    W, H = render.LAYOUTS[layout]["size"]
    assert f"PlayResX: {W}" in ass and f"PlayResY: {H}" in ass
    hook = events(ass, "hook")
    assert hook and all(abs(e[1] - plan["hook"]["start"]) < 0.006 and abs(e[2] - plan["hook"]["end"]) < 0.006
                        for e in hook)
    for n, chip in enumerate(plan["chips"], 1):
        evs = events(ass, f"chip{n}")
        assert evs, chip
        assert all(abs(e[1] - chip["start"]) < 0.006 and abs(e[2] - chip["end"]) < 0.006 for e in evs)
    es = plan["end_card"]["start"]
    caps = events(ass, "caption")
    shadows = events(ass, "caption-shadow")
    assert len(caps) == len(shadows) > 0
    starts = [w["start"] for w in plan["words"] if w["start"] < es]
    assert all(min(abs(e[1] - t) for t in starts) < 0.006 for e in caps)
    assert abs(caps[0][1] - plan["words"][0]["start"]) < 0.006
    assert max(e[2] for e in caps) <= es + 0.006, "no captions during the end card"
    for name in ("end-line1", "end-line2"):
        evs = events(ass, name)
        assert evs and all(e[1] >= es - 0.006 and abs(e[2] - plan["end_card"]["end"]) < 0.006 for e in evs)
    assert geo["end_card"]["start"] == es


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


def test_chips_never_overlap_even_in_a_hand_edited_plan():
    plan = script_plan("medford-2")
    plan["chips"][0]["end"] = plan["chips"][2]["start"] + 1.0  # overlaps the next two
    ass, _ = render.build_ass(plan, "9x16")
    spans = sorted({(e[1], e[2]) for e in events(ass, "chip*")})
    for (a0, a1), (b0, b1) in zip(spans, spans[1:]):
        assert a1 <= b0 + 0.006


def test_chips_take_the_top_slot_once_the_hook_is_gone_and_sit_under_it_otherwise():
    plan = script_plan("victoria-1")
    _, geo = render.build_ass(plan, "9x16")
    T = geo["safe"][1]
    assert all(abs(c["box"][1] - (T + 22)) < 1 for c in geo["chips"])
    plan["chips"][0]["start"] = 1.0  # cued while the hook is still up
    _, geo = render.build_ass(plan, "9x16")
    assert all(c["box"][1] >= geo["hook"][3] for c in geo["chips"])


def test_a_chip_cued_as_the_hook_fades_out_still_takes_the_top_slot():
    # analyze.py ends the hook at 1.6 s at the earliest, so a chip cued at
    # 1.593 s (lincoln-2's fixture) overlapped it by one invisible frame, and
    # that sent all four chips down to eye level for ten seconds.
    plan = script_plan("victoria-1")
    plan["hook"]["end"] = 1.6
    plan["chips"][0]["start"] = 1.593
    _, geo = render.build_ass(plan, "9x16")
    T = geo["safe"][1]
    assert all(abs(c["box"][1] - (T + 22)) < 1 for c in geo["chips"]), [c["box"] for c in geo["chips"]]


@pytest.mark.parametrize("layout", ["9x16", "4x5"])
@pytest.mark.parametrize("video_id", sorted(VIDEOS))
def test_every_script_lays_out_inside_the_safe_zone(video_id, layout):
    """Geometry check for all 15 real hooks, chips and domains."""
    _, geo = render.build_ass(script_plan(video_id), layout)
    L, T, R, B = geo["safe"]
    boxes = [geo["hook"]] + [c["box"] for c in geo["chips"]] + list(geo["end_card"]["bounds"])
    lg = geo["end_card"]["logo"]
    boxes.append((lg["x"], lg["y"], lg["x"] + lg["size"], lg["y"] + lg["size"]))
    for x0, y0, x1, y1 in boxes:
        assert L <= x0 and x1 <= R and T <= y0 and y1 <= B, (video_id, (x0, y0, x1, y1))
    assert len(geo["chips"]) == len(script_plan(video_id)["chips"])
    assert all(c["em"] >= render.CHIP_EM[1] * render.LAYOUTS[layout]["scale"] - 1 for c in geo["chips"])


def test_end_card_line2_is_the_towns_domain():
    plan = script_plan("shoals-1")
    plan["end_card"]["line2"] = "{domain}"
    ass, geo = render.build_ass(plan, "9x16")
    assert [x["text"] for x in geo["end_card"]["lines"]] == ["FREE every Mon & Thu", "shoalssetlist.com"]


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
    assert ("Fredoka SemiBold", "400", "Fredoka-SemiBold") in picks
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
def test_no_text_leaves_the_safe_zone(tmp_path, layout):
    """Rendered pixels, not geometry: the longest copy in the scripts, over grey."""
    plan = script_plan("shoals-2")
    plan["hook"]["text"] = VIDEOS["medford-1"]["hook"]
    plan["chips"] = [
        {"text": "THU · 1926 silent film + live score @ the Ross", "start": 3.0, "end": 4.2},
        {"text": "Live music in a cave @ Rattlesnake Saloon 🎸", "start": 4.2, "end": 5.4},
        {"text": "FRI · Corrosion of Conformity + The Sword", "start": 5.4, "end": 6.6},
    ]
    plan["words"][10:13] = [{"text": "trunk-or-treats-hootenanny", "start": 6.7, "end": 7.3},
                            {"text": "Craterian", "start": 7.32, "end": 7.7},
                            {"text": "Washington,", "start": 7.72, "end": 8.1}]
    ass, geo = render.build_ass(plan, layout)
    W, H = render.LAYOUTS[layout]["size"]
    L, T, R, B = geo["safe"]
    es = plan["end_card"]["start"]
    times = [0.13, 0.9, 3.08, 3.6, 4.8, 6.0, 6.9, 7.5, es + 0.3, es + 1.0]
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
    rgb = _ass_frames(tmp_path, ass, (1080, 1920), [0.3], bg=(128, 128, 128))[0]
    cy = round(1920 * render.CAPTION_Y)
    xs = [x for y in range(cy - 60, cy + 60, 4) for x in range(1080)
          if max(abs(v - 128) for v in rgb[(y * 1080 + x) * 3:(y * 1080 + x) * 3 + 3]) > 40]
    want = bold.width("back/ slash", render.CAPTION_EM)
    assert L <= min(xs) and max(xs) < R, (min(xs), max(xs))
    assert max(xs) - min(xs) < want + 2 * 7 + 30, (max(xs) - min(xs), want)


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

    x0, y0, x1, y1 = (int(v) for v in info["overlay"]["hook"])
    rgb = frame_rgb(path, 0.9, 1080, 1920)
    want = [int(pal["highlight"][i:i + 2], 16) for i in (1, 3, 5)]
    yellow = [rgb[(y * 1080 + x) * 3:(y * 1080 + x) * 3 + 3] for y in range(y0, y1, 3) for x in range(x0, x1, 3)]
    yellow = [p for p in yellow if all(abs(a - b) <= 24 for a, b in zip(p, want))]
    assert len(yellow) > 2000, "the sticker is there"
    # On YUV frames libass blends through BT.601 and this lands 5-7 levels
    # off in a BT.709 file; composited on RGB it is the brand colour.
    median = [sorted(p[c] for p in yellow)[len(yellow) // 2] for c in range(3)]
    assert all(abs(a - b) <= 3 for a, b in zip(median, want)), (median, want)
    end = frame_rgb(path, plan["duration"] - 0.1, 1080, 1920)
    assert near(mean_rgb(end, 1080, (80, 1600, 200, 1700)), pal["paper"], 4)
    lg = info["overlay"]["end_card"]["logo"]
    logo = mean_rgb(end, 1080, (lg["x"] + lg["size"] // 2 - 20, lg["y"] + lg["size"] // 2 - 20,
                                lg["x"] + lg["size"] // 2 + 20, lg["y"] + lg["size"] // 2 + 20))
    assert not near(logo, pal["paper"], 30), "the logo is on the card"


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
