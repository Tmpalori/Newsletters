"""analyze.py: script identification, take choice, tightening and timeline.

Almost everything runs on synthetic whisper output (word dicts with times),
so the suite needs no audio, no model and no network; the repo's CI collects
it too. One slow test runs real whisper on the TTS fixtures in
out/fixtures/ and skips when they (or faster-whisper) aren't there.
"""
import json
import os
import shutil
import subprocess
import sys

import pytest

VIDEO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, VIDEO)

import analyze  # noqa: E402

DATA = analyze.load_scripts()
SAY = {v["id"]: v["say"] for v in DATA["videos"]}
VIDEOS = {v["id"]: v for v in DATA["videos"]}
FIXTURES = os.path.join(VIDEO, "out", "fixtures")


def speak(text, t0=0.0, rate=1.0, prob=0.95):
    """Fake whisper words for text at an upbeat read (~2.9 words/s).
    "<pause:1.5>" inserts silence. Returns (words, time after the last word)."""
    out, t = [], t0
    for w in text.split():
        if w.startswith("<pause:"):
            t += float(w[7:-1])
            continue
        d = (0.12 + 0.035 * len(w)) / rate
        out.append({"text": w, "start": round(t, 3), "end": round(t + d, 3), "prob": prob})
        t += d + 0.03 / rate
    return out, t


def words_of(text, t0=0.0, **kw):
    return speak(text, t0, **kw)[0]


def plans(words, **kw):
    return analyze.plan("/tmp/raw.mov", transcript=words, **kw)


def one(words, **kw):
    ps = plans(words, **kw)
    assert len(ps) == 1, [p["video_id"] for p in ps]
    check_contract(ps[0])
    return ps[0]


def texts(p):
    return [w["text"] for w in p["words"]]


def find_word(words, text, nth=0):
    hits = [w for w in words if w["text"] == text]
    return hits[nth]


KEYS = ["video_id", "town", "source", "similarity", "takes", "take", "segments", "speed",
        "duration", "speech_end", "words", "hook", "chips", "cta_start", "phone", "end_card", "diff",
        "warnings"]


def check_contract(p):
    """The invariants render.py relies on, for any plan."""
    assert list(p) == KEYS
    assert os.path.isabs(p["source"])
    assert 0 <= p["similarity"] <= 1
    assert 0 <= p["take"] < len(p["takes"])
    for t in p["takes"]:
        assert set(t) == {"start", "end", "coverage"} and t["start"] < t["end"]
        assert t["coverage"] >= analyze.MIN_COVERAGE or any("--video" in w for w in p["warnings"])
    segs = [(s["start"], s["end"]) for s in p["segments"]]
    assert segs and all(a < b for a, b in segs)
    assert all(b1 < a2 for (_, b1), (a2, _) in zip(segs, segs[1:])), "segments overlap"
    assert 1.0 <= p["speed"] <= analyze.MAX_SPEED
    ws = p["words"]
    assert ws and all(w["start"] <= w["end"] for w in ws)
    assert all(a["start"] <= b["start"] for a, b in zip(ws, ws[1:]))
    total = sum(b - a for a, b in segs) / p["speed"]
    assert ws[-1]["end"] <= total + 1e-3
    assert p["speech_end"] == ws[-1]["end"]
    # Output time 0 is the first word's 0.07 s lead-in (less only when the
    # source starts sooner than that).
    assert 0 <= ws[0]["start"] <= analyze.PAD_BEFORE / p["speed"] + 2e-3
    assert p["hook"]["start"] == 0.0 and p["hook"]["end"] >= analyze.HOOK_MIN - 1e-9
    if p["chips"]:
        assert p["hook"]["end"] == pytest.approx(
            max(analyze.HOOK_MIN, min(p["chips"][0]["start"] - 0.15, analyze.HOOK_MAX)), abs=2e-3)
    else:
        assert p["hook"]["end"] == analyze.HOOK_MAX
    for a, b in zip(p["chips"], p["chips"][1:]):
        assert a["end"] <= b["start"] + 1e-9, "chips overlap"
    for c in p["chips"]:
        assert c["start"] < c["end"]
    if p["chips"]:
        assert p["chips"][-1]["end"] == p["cta_start"]
    ph = p["phone"]
    if ph is not None:
        assert set(ph) == {"start", "end"}
        assert p["hook"]["end"] - 1e-9 <= ph["start"] < ph["end"] <= p["end_card"]["start"] + 1e-9
        assert ph["end"] - ph["start"] <= analyze.PHONE_SECONDS + 1e-9
        assert ph["end"] - ph["start"] >= analyze.PHONE_MIN - 1e-9
    for c in p["chips"]:
        assert set(c) <= {"text", "start", "end"} | set(analyze.CARD_FIELDS)
    ec = p["end_card"]
    assert ec["end"] - ec["start"] >= analyze.END_MIN - 1e-3
    assert ec["end"] >= p["speech_end"] + analyze.END_TAIL - 1e-3
    assert p["duration"] == ec["end"]
    assert ec["line1"] == DATA["end_card"]["line1"]
    for d in p["diff"]:
        assert d["kind"] in ("substitute", "omit", "insert")
    # Everything on the output timeline sits inside the video.
    dur = p["duration"]
    assert all(0 <= w["start"] <= w["end"] <= dur for w in ws)
    assert all(0 <= c["start"] < c["end"] <= dur for c in p["chips"])
    assert 0 <= p["cta_start"] <= dur and 0 <= ec["start"] < ec["end"]
    assert all(0 <= d["at"] <= dur for d in p["diff"])
    assert isinstance(p["take"], int) and not isinstance(p["take"], bool)
    assert isinstance(p["speed"], float) and isinstance(dur, float)
    assert [t["start"] for t in p["takes"]] == sorted(t["start"] for t in p["takes"])
    assert p["hook"]["text"] == VIDEOS[p["video_id"]]["hook"]
    assert all(isinstance(w, str) for w in p["warnings"])
    json.dumps(p)  # plain JSON all the way down


# --- normalization -------------------------------------------------------------

@pytest.mark.parametrize("a,b", [
    ("eight trunk-or-treats", "8 trunk or treats"),
    ("sixteen seasons", "16 seasons"),
    ("the Wicked ten K", "the Wicked 10K"),
    ("their whole two thousand six album", "their whole 2006 album"),
    ("twenty oh six", "2006"),
    ("a thousand-dollar costume", "a $1,000 costume"),
    ("one thousand dollars", "1,000-dollar"),
    ("Elevation twenty seven", "Elevation 27"),
    ("twenty-seven", "27"),
    ("a hundred-year-old film", "a 100-year-old film"),
    ("four haunts in one night", "4 haunts in 1 night"),
    ("Mt. Trashmore", "Mount Trashmore"),
    ("1st Friday", "First Friday"),
    ("U.N.A.", "UNA"),
    ("Halloween\u2019s over \u2014 really", "halloween's over - really"),
])
def test_normalize_same_both_ways(a, b):
    assert analyze.tokens(a) == analyze.tokens(b)


@pytest.mark.parametrize("form", [
    "thevic361.com", "The Vic 361.com", "the vic three sixty one dot com",
    "thevic 361 dot com", "the vic three six one dot com", "TheVic361.com.",
    "www.thevic361.com", "the vic three hundred sixty one dot com", "thevic361",
])
def test_domain_forms_are_one_token(form):
    assert analyze.tokens(form) == ["thevic361.com"]


@pytest.mark.parametrize("form,domain", [
    ("thestar four oh two dot com", "thestar402.com"),
    ("the rogue five forty one dot com", "therogue541.com"),
    ("Shoals Setlist dot com", "shoalssetlist.com"),
    ("the tide seven fifty seven dot com", "thetide757.com"),
])
def test_other_domains(form, domain):
    assert analyze.tokens(form) == [domain]


def test_number_split_across_words_is_joined():
    # Whisper wrote the script's "a thousand-dollar" as "a" "$1" ",000".
    toks = analyze.normalize(["a", "$1", ",000", "costume"])
    assert [t.text for t in toks] == ["a", "1000", "dollar", "costume"]
    assert (toks[1].w0, toks[1].w1) == (1, 2)


def test_wrong_digits_are_not_the_domain():
    # A misread address must stay visible to the diff, not be "corrected".
    assert analyze.tokens("thevic316.com") != ["thevic361.com"]
    assert analyze.tokens("free thevic361.com") == ["free", "thevic361.com"]


def test_glued_or_split_words_match_the_script():
    # Whisper's word boundaries differ from the script's; neither costs coverage.
    say = SAY["shoals-2"].replace("Howl-o-ween", "Howloween")
    p = one(words_of(say))
    assert p["takes"][0]["coverage"] == 1.0 and p["diff"] == []
    say = SAY["lincoln-3"].replace("Artwalk", "Art Walk")
    p = one(words_of(say))
    assert p["takes"][0]["coverage"] == 1.0 and p["diff"] == []
    say = SAY["shoals-3"].replace("week is", "week's")
    p = one(words_of(say))
    assert p["takes"][0]["coverage"] == 1.0 and p["diff"] == []


# --- identification ----------------------------------------------------------

@pytest.mark.parametrize("vid", sorted(SAY))
def test_identifies_each_script(vid):
    p = one(words_of(SAY[vid], 0.6))
    assert p["video_id"] == vid and p["town"] == VIDEOS[vid]["town"]
    assert p["takes"][0]["coverage"] == 1.0 and p["similarity"] == 1.0
    assert p["diff"] == []
    assert texts(p) == SAY[vid].split()
    assert p["words"][0]["start"] == pytest.approx(analyze.PAD_BEFORE / p["speed"], abs=2e-3)
    assert len(p["chips"]) == len(VIDEOS[vid]["chips"])
    assert p["hook"]["text"] == VIDEOS[vid]["hook"]
    assert p["end_card"]["line2"] == analyze.towns.TOWNS[VIDEOS[vid]["town"]]["domain"]
    # A clean read at this pace needs no warnings beyond the draft notice.
    assert all("draft" in w or "sped up" in w for w in p["warnings"])


def test_lookalike_scripts_resolve_to_the_right_one():
    # The week-of-Nov-2 drafts share most of their words; the better fit wins.
    for vid in ("medford-3", "lincoln-3", "virginiabeach-3", "victoria-3"):
        found = analyze.find_scripts(words_of(SAY[vid]))
        assert [f["video_id"] for f in found] == [vid]


def test_unknown_speech_finds_nothing():
    w = words_of("so I went to the store and bought some apples and then I went home to "
                 "make a pie for my grandmother who lives down the street")
    assert plans(w) == []


# --- takes ----------------------------------------------------------------------

def two_takes(first, second, gap=1.5):
    w1, t = speak(first, 1.0)
    w2, _ = speak(second, t + gap)
    return w1 + w2, w2[0]["start"]


def test_two_clean_takes_the_later_wins():
    w, second = two_takes(SAY["victoria-1"], SAY["victoria-1"])
    p = one(w)
    assert len(p["takes"]) == 2 and p["take"] == 1
    assert p["takes"][1]["start"] == pytest.approx(second)
    assert p["segments"][0]["start"] >= second - analyze.PAD_BEFORE - 1e-3


def test_clearly_better_earlier_take_wins():
    short = SAY["victoria-1"].replace("Thursday, spooky mini golf, inside the library. ", "")
    w, _ = two_takes(SAY["victoria-1"], short)
    p = one(w)
    assert p["take"] == 0
    assert p["takes"][1]["coverage"] < p["takes"][0]["coverage"] - analyze.TIE


def test_better_later_take_wins():
    flubbed = SAY["victoria-1"].replace("Thursday, spooky mini golf, inside the library. ", "")
    w, _ = two_takes(flubbed, SAY["victoria-1"])
    assert one(w)["take"] == 1


def test_near_tie_goes_to_the_later_take():
    # One word short of the first take is within the 0.03 tie window.
    w, _ = two_takes(SAY["victoria-1"], SAY["victoria-1"].replace(" even", ""))
    p = one(w)
    assert p["takes"][0]["coverage"] - p["takes"][1]["coverage"] <= analyze.TIE
    assert p["take"] == 1
    assert p["diff"] == [{"kind": "omit", "script": "even", "spoken": "",
                          "at": find_word(p["words"], "the")["start"]}]


def test_restart_from_the_top_is_its_own_take():
    say = "Victoria: eight trunk-or-treats this... <pause:0.8> " + SAY["victoria-1"]
    p = one(words_of(say, 0.5))
    assert len(p["takes"]) == 1  # the 4-word flub is far below 0.6
    assert texts(p) == SAY["victoria-1"].split()
    assert p["segments"][0]["start"] > 2.0


def test_mid_sentence_restart_keeps_the_last_run():
    say = SAY["victoria-1"].replace(
        "Monday, Nightmare on Elm Street",
        "Monday, Nightmare on Elm... sorry, Monday, Nightmare on Elm Street")
    w = words_of(say, 0.4)
    p = one(w)
    assert texts(p) == SAY["victoria-1"].split()
    assert p["diff"] == [] and p["similarity"] == 1.0
    first_try = find_word(w, "Elm...")
    second_try = find_word(w, "Monday,", 1)
    for s in p["segments"]:
        assert not (s["start"] < first_try["end"] - 0.01 and s["end"] > first_try["start"] + 0.01)
        assert not (s["start"] < find_word(w, "sorry,")["end"] - 0.01
                    and s["end"] > find_word(w, "sorry,")["start"] + 0.01)
    assert any(s["start"] <= second_try["start"] <= s["end"] for s in p["segments"])


def test_repeated_word_keeps_one():
    say = SAY["victoria-2"].replace("Sign up tonight", "Sign up up tonight")
    p = one(words_of(say))
    assert texts(p) == SAY["victoria-2"].split()


def test_restart_inside_the_cta():
    say = SAY["victoria-1"].replace(
        "Sign up tonight and the whole week's in your inbox",
        "Sign up tonight and the whole week's in your... <pause:0.6> sorry. "
        "Sign up tonight and the whole week's in your inbox")
    w = words_of(say)
    p = one(w)
    assert texts(p) == SAY["victoria-1"].split() and p["diff"] == []
    second = find_word(w, "Sign", 1)
    assert p["cta_start"] == find_word(p["words"], "Sign")["start"]
    assert any(s["start"] <= second["start"] <= s["end"] for s in p["segments"])
    assert not any(s["start"] < find_word(w, "your...")["end"] - 0.01
                   and s["end"] > find_word(w, "your...")["start"] + 0.01 for s in p["segments"])


@pytest.mark.parametrize("flub,redo", [
    # A late flub, then back a whole sentence: once read as a second take
    # (and dropped for low coverage), so the plan kept "tomo... ugh." and
    # lost the address.
    ("Sign up tonight and the whole week's in your inbox tomo... <pause:0.8> ugh. <pause:0.5> ",
     "Thursday, spooky mini golf, inside the library. "),
    # The address flubbed, then back to "Monday": the fragment "the vic..."
    # must not be lined up with "the best" and replace it.
    ("Sign up tonight and the whole week's in your inbox tomorrow morning. Free. the vic... "
     "<pause:0.8> ", "Monday, Nightmare on Elm Street at Moonshine. Thursday, spooky mini golf, "
     "inside the library. "),
])
def test_late_restart_from_an_earlier_line_is_spliced(flub, redo):
    head, tail = SAY["victoria-1"].split("Sign up", 1)
    start = redo.split()[0]
    say = head + flub + redo + "Sign up" + tail
    w = words_of(say, 0.4)
    p = one(w)
    assert texts(p) == SAY["victoria-1"].split()
    assert p["diff"] == [] and p["warnings"] == [] and len(p["takes"]) == 1
    # The first try runs up to the line he went back to; the restart from there.
    redo_word = find_word(w, start, 1)
    assert any(s["start"] <= redo_word["start"] <= s["end"] for s in p["segments"])
    assert p["end_card"]["start"] == find_word(p["words"], "thevic361.com")["start"]


def test_three_takes_the_best_is_used():
    w1, t = speak(SAY["victoria-1"].split(" Monday")[0], 1.0)  # gives up early
    w2, t = speak(SAY["victoria-1"], t + 1.5)
    w3, _ = speak(SAY["victoria-1"], t + 1.5)
    p = one(w1 + w2 + w3)
    assert [t["coverage"] for t in p["takes"]] == [1.0, 1.0] and p["take"] == 1
    assert p["segments"][0]["start"] >= w3[0]["start"] - analyze.PAD_BEFORE - 1e-3
    short = SAY["victoria-1"].replace("Thursday, spooky mini golf, inside the library. ", "")
    w1, t = speak(short, 1.0)
    w2, t = speak(SAY["victoria-1"], t + 1.5)
    w3, _ = speak(short, t + 1.5)
    p = one(w1 + w2 + w3)
    assert len(p["takes"]) == 3 and p["take"] == 1
    assert texts(p) == SAY["victoria-1"].split()


def test_ending_redone_straight_away_uses_the_redo():
    # Positions said twice in a row: the last run wins, even after the address.
    redo = "Sign up tonight and the whole week's in your inbox tomorrow morning. Free. thevic361.com"
    w = words_of(SAY["victoria-1"] + " <pause:1.0> " + redo)
    p = one(w)
    assert texts(p) == SAY["victoria-1"].split() and p["diff"] == [] and len(p["takes"]) == 1
    assert p["cta_start"] == find_word(p["words"], "Sign")["start"]
    second = find_word(w, "Sign", 1)
    assert any(s["start"] <= second["start"] <= s["end"] for s in p["segments"])
    first = find_word(w, "thevic361.com", 0)
    assert not any(s["start"] < first["end"] and s["end"] > first["start"] for s in p["segments"])


def test_aside_mid_take_is_cut_and_reported():
    say = SAY["victoria-1"].replace("Monday,", "hold on, my phone is buzzing, okay. <pause:1.0> Monday,")
    w = words_of(say)
    p = one(w)
    assert texts(p) == SAY["victoria-1"].split()
    assert any(x.startswith("Cut 7 words") and "buzzing" in x for x in p["warnings"])
    phone = find_word(w, "phone")
    assert not any(s["start"] < phone["end"] and s["end"] > phone["start"] for s in p["segments"])


# --- slips he corrected ------------------------------------------------------------

@pytest.mark.parametrize("vid,old,new", [
    ("victoria-1", "Nightmare on Elm Street", "Nightmare on Elk... sorry, Elm Street"),
    ("victoria-2", "Calaveras and Cocktails", "Calaveras and Cock-... Cocktails"),
    ("victoria-1", "at Moonshine.", "at Moon... Moonshine."),
    ("victoria-1", "inside the library.", "inside the lib... ugh... library."),
    ("victoria-1", "spooky mini golf,", "spooky mini, wait, mini golf,"),
])
def test_corrected_flub_is_cut(vid, old, new):
    # These were kept in the video, flub, "sorry" and all, without a warning.
    w = words_of(SAY[vid].replace(old, new))
    p = one(w)
    assert texts(p) == SAY[vid].split()
    assert p["diff"] == [] and all("draft" in x for x in p["warnings"])
    flub = next(x for x in w if x["text"] not in SAY[vid].split())
    assert not any(s["start"] < flub["end"] - 0.01 and s["end"] > flub["start"] + 0.01
                   for s in p["segments"])


@pytest.mark.parametrize("old,new,slip,after", [
    ("Moonshine. Thursday,", "Moonshine. Monday... no, Thursday,", "Monday... no,", "Thursday,"),
    ("Sign up tonight", "Sign up tomorrow... no, tonight", "tomorrow... no,", "tonight"),
    ("Victoria: eight", "Victoria: nine... sorry, eight", "nine... sorry,", "eight"),
    ("Free. thevic361.com", "Free. thevic316.com, sorry, thevic361.com", "thevic316.com, sorry,",
     "thevic361.com"),
    ("Free. thevic361.com", "Free. thestar402.com... thevic361.com", "thestar402.com...",
     "thevic361.com"),
    ("Free. thevic361.com", "Free. the vic three sixteen, sorry, the vic three sixty one dot com",
     "the vic three sixteen, sorry,", "thevic361.com"),
])
def test_corrected_day_number_or_address_is_cut_with_a_warning(old, new, slip, after):
    # The right one said right after the wrong one: the video keeps the
    # right one (before, "Victoria" was lost, the wrong address kept, or the
    # address dropped altogether), and a person hears about the cut.
    p = one(words_of(SAY["victoria-1"].replace(old, new)))
    assert texts(p) == SAY["victoria-1"].split() and p["diff"] == []
    assert p["warnings"] == ['Cut "%s" at %.1fs: said, then corrected right after.'
                             % (slip, find_word(p["words"], after)["start"])]
    assert p["end_card"]["start"] == find_word(p["words"], "thevic361.com")["start"]


def test_a_lone_address_never_pays_for_entering_a_script():
    # ADDRESS_WEIGHT lets a take reach past a slip to the address, but must
    # stay below what entering any script at its last word costs.
    for s in analyze._library():
        n = len(s.tokens)
        assert analyze.ENTER + analyze.ENTER_SKIP * (n - 1) > analyze.ADDRESS_WEIGHT * analyze.MATCH
        assert 4 * analyze.INSERT < analyze.ADDRESS_WEIGHT * analyze.MATCH


# --- tightening -------------------------------------------------------------------

def test_fillers_are_cut():
    say = SAY["victoria-1"].replace("Thursday,", "Thursday, um,").replace("Sign up", "uh, Sign up")
    w = words_of(say)
    p = one(w)
    assert "um," not in texts(p) and "uh," not in texts(p)
    assert p["diff"] == []
    for filler in ("um,", "uh,"):
        f = find_word(w, filler)
        mid = (f["start"] + f["end"]) / 2
        assert not any(s["start"] < mid < s["end"] for s in p["segments"])


def test_long_pause_shrinks_to_012():
    say = SAY["victoria-1"].replace("golf, inside", "golf, <pause:1.5> inside")
    p = one(words_of(say))
    golf, inside = find_word(p["words"], "golf,"), find_word(p["words"], "inside")
    assert inside["start"] - golf["end"] == pytest.approx(analyze.GAP_TO, abs=2e-3)
    assert p["duration"] < 16.0


def test_short_pause_is_kept_whole():
    say = SAY["victoria-1"].replace("golf, inside", "golf, <pause:0.2> inside")
    w = words_of(say)
    p = one(w)
    assert len(p["segments"]) == 1
    gap = find_word(w, "inside")["start"] - find_word(w, "golf,")["end"]
    out_gap = find_word(p["words"], "inside")["start"] - find_word(p["words"], "golf,")["end"]
    assert out_gap == pytest.approx(gap, abs=2e-3)


def test_segments_pad_each_word():
    w = words_of(SAY["lincoln-1"], 2.0)
    p = one(w)
    assert p["segments"][0]["start"] == pytest.approx(w[0]["start"] - analyze.PAD_BEFORE)
    assert p["segments"][-1]["end"] == pytest.approx(w[-1]["end"] + analyze.PAD_AFTER)


def test_instant_word_between_cut_fillers_leaves_no_empty_segment():
    # Whisper pins a short word to an instant now and then (_uncollapse
    # leaves words under ~3 letters alone); between two cut fillers that
    # touch it, the plan held a 0-length segment, which render.py refuses.
    w = words_of(SAY["victoria-1"].replace("Monday,", "uh, Monday, um,"))
    i = next(k for k, x in enumerate(w) if x["text"] == "Monday,")
    w[i]["end"] = w[i - 1]["end"] = w[i + 1]["start"] = w[i]["start"]
    p = one(w)
    assert texts(p) == SAY["victoria-1"].split()
    assert all(s["end"] - s["start"] > 1e-3 for s in p["segments"])


def test_padding_never_reaches_into_a_cut_word():
    # "um" right against "Friday": the lead-in stops where the filler ends.
    say = SAY["victoria-2"].replace("Friday, Calaveras", "um Friday, Calaveras")
    w = words_of(say)
    p = one(w)
    um = find_word(w, "um")
    assert not any(s["start"] < um["end"] - 1e-6 and s["end"] > um["start"] + 1e-6
                   for s in p["segments"])


# --- numbers and the domain -------------------------------------------------------

@pytest.mark.parametrize("vid,old,new", [
    ("victoria-1", "eight", "8"),
    ("medford-1", "sixteen", "16"),
    ("virginiabeach-1", "2006", "two thousand six"),
    ("virginiabeach-1", "2006", "twenty oh six"),
    ("virginiabeach-2", "10K", "ten K"),
    ("lincoln-2", "a thousand-dollar", "a $1,000"),
    ("lincoln-1", "a hundred-year-old", "a 100-year-old"),
    ("virginiabeach-2", "four haunts in one night", "4 haunts in 1 night"),
])
def test_digits_and_words_match(vid, old, new):
    assert old in SAY[vid]
    p = one(words_of(SAY[vid].replace(old, new)))
    assert p["video_id"] == vid
    assert p["takes"][0]["coverage"] == 1.0 and p["diff"] == [] and p["warnings"] == []


@pytest.mark.parametrize("spoken", [
    "thevic361.com", "The Vic 361.com", "the vic three sixty one dot com", "thevic 361 dot com",
])
def test_domain_variants_start_the_end_card(spoken):
    say = SAY["victoria-1"].replace("thevic361.com", spoken)
    p = one(words_of(say))
    assert p["diff"] == [] and p["warnings"] == []
    # However it was said, the caption is the address spelled right, and
    # the end card starts on its first spoken word.
    assert texts(p)[-2:] == ["Free.", "thevic361.com"]
    assert p["end_card"]["start"] == p["words"][-1]["start"] > p["words"][-2]["end"]
    assert p["words"][-1]["end"] == p["speech_end"]
    assert p["end_card"]["line2"] == "thevic361.com"


def test_address_glued_to_free_is_split():
    # Real whisper output on a TTS read: "Freethavoc361" ".com."
    w = words_of(SAY["victoria-1"].replace("Free. thevic361.com", "Freethavoc361 .com."))
    p = one(w)
    assert p["diff"] == [] and p["warnings"] == []
    assert texts(p)[-2:] == ["Free", "thevic361.com"]
    glued = find_word(w, "Freethavoc361")
    out_start = p["words"][-2]["start"]
    assert p["end_card"]["start"] == p["words"][-1]["start"]
    assert out_start < p["end_card"]["start"] < out_start + (glued["end"] - glued["start"]) / 2


def test_captions_take_the_script_case():
    say = ("Victoria, Eight Trunk or Treats This Week, and They're Not Even The Best Part, "
           + SAY["victoria-1"].split("best part. ")[1].replace("Moonshine", "moonshine"))
    p = one(words_of(say))
    assert texts(p)[:8] == ["Victoria,", "eight", "trunk", "or", "treats", "this", "week,", "and"]
    assert "Moonshine." in texts(p)


def test_misheard_word_for_a_script_run():
    # Whisper heard "trunk-or-treats" as "trunk retreats" on a real read.
    p = one(words_of(SAY["victoria-1"].replace("trunk-or-treats", "trunk retreats")))
    assert p["takes"][0]["coverage"] == 1.0 and p["diff"] == []


def test_captions_spell_a_misheard_match_as_the_script():
    # Both TTS victoria fixtures burned "trunk retreats" into the captions.
    w = words_of(SAY["victoria-1"].replace("trunk-or-treats", "trunk retreats"))
    p = one(w)
    assert texts(p) == SAY["victoria-1"].split()
    # One caption from "trunk" through "retreats" (one cut, no speed-up here).
    assert len(p["segments"]) == 1 and p["speed"] == 1.0
    cap, off = find_word(p["words"], "trunk-or-treats"), p["segments"][0]["start"]
    assert cap["start"] == pytest.approx(find_word(w, "trunk")["start"] - off, abs=2e-3)
    assert cap["end"] == pytest.approx(find_word(w, "retreats")["end"] - off, abs=2e-3)
    p = one(words_of(SAY["victoria-2"].replace("Calaveras", "Calaveres")))
    assert "Calaveras" in texts(p) and "Calaveres" not in texts(p)
    # A different word stays as he said it: the diff and warnings own that.
    p = one(words_of(SAY["victoria-2"].replace("Friday,", "Thursday,")))
    assert "Thursday," in texts(p)


def test_glued_signup_still_starts_the_cta():
    # Whisper writes "Signup" now and then; the sign-up line was "not heard".
    p = one(words_of(SAY["victoria-1"].replace("Sign up", "Signup")))
    assert p["cta_start"] == find_word(p["words"], "Signup")["start"]
    assert p["warnings"] == [] and p["chips"][-1]["end"] == p["cta_start"]


def test_punctuation_between_words_splits_them():
    assert analyze.tokens("Monday,Nightmare on Elm") == ["monday", "nightmare", "on", "elm"]
    assert analyze.tokens("Victoria:eight") == ["victoria", "8"]
    assert analyze.tokens("$1,000") == ["1000", "dollar"]  # a thousands comma is no break
    p = one(words_of(SAY["victoria-1"].replace("Monday, Nightmare", "Monday,Nightmare")))
    assert p["warnings"] == []  # no "chip placed on ..." note: the cue was heard
    assert p["chips"][0]["start"] == find_word(p["words"], "Monday,Nightmare")["start"]


def test_wrong_domain_digits_warn():
    p = one(words_of(SAY["victoria-1"].replace("thevic361.com", "thevic316.com")))
    assert any(w.startswith("Wrong web address?") for w in p["warnings"])


# --- several scripts, cut-off takes -----------------------------------------------

def test_two_different_scripts_in_one_file():
    w1, t = speak(SAY["lincoln-2"], 0.8)
    w2, _ = speak(SAY["medford-2"], t + 2.0)
    ps = plans(w1 + w2)
    assert [p["video_id"] for p in ps] == ["lincoln-2", "medford-2"]
    for p in ps:
        check_contract(p)
        assert p["diff"] == []
    assert ps[0]["segments"][-1]["end"] <= w2[0]["start"]
    assert ps[1]["segments"][0]["start"] >= w1[-1]["end"]


@pytest.mark.parametrize("first", ["victoria-1", "lincoln-1", "medford-1", "medford-2", "lincoln-2"])
@pytest.mark.parametrize("gap", [0.6, 1.5])
def test_a_short_script_right_after_another_keeps_both(first, gap):
    # shoals-3's body is short, so the first script's own sign-up line comes
    # round again within seconds. That used to read as a restart of the
    # first script, which then swallowed shoals-3 and was dropped whole.
    w1, t = speak(SAY[first], 0.8)
    w2, _ = speak(SAY["shoals-3"], t + gap)
    ps = plans(w1 + w2)
    assert [p["video_id"] for p in ps] == [first, "shoals-3"]
    for p, w, vid in zip(ps, (w1, w2), (first, "shoals-3")):
        check_contract(p)
        assert texts(p) == SAY[vid].split() and p["diff"] == []
        assert w[0]["start"] - analyze.PAD_BEFORE - 1e-6 <= p["segments"][0]["start"]
        assert p["segments"][-1]["end"] <= w[-1]["end"] + analyze.PAD_AFTER + 1e-6
    # Naming the first one still keeps it to its own take.
    p = one(w1 + w2, video_id=first)
    assert p["segments"][-1]["end"] <= w1[-1]["end"] + analyze.PAD_AFTER + 1e-6


def test_video_id_picks_one_script():
    w1, t = speak(SAY["lincoln-2"], 0.8)
    w2, _ = speak(SAY["medford-2"], t + 2.0)
    ps = plans(w1 + w2, video_id="medford-2")
    assert [p["video_id"] for p in ps] == ["medford-2"]
    with pytest.raises(KeyError):
        plans(w1, video_id="nope-9")


def test_partial_take_needs_video_id():
    half = " ".join(SAY["victoria-2"].split()[:24])
    w = words_of(half)
    assert plans(w) == []
    p = one(w, video_id="victoria-2")
    assert any("--video" in x for x in p["warnings"])


def test_take_cut_off_before_the_cta():
    say = SAY["victoria-1"].split(" Sign up")[0]
    p = one(words_of(say))
    assert 0.6 <= p["takes"][0]["coverage"] < 0.8
    joined = " ".join(p["warnings"])
    assert "no sign-up line heard" in joined and "web address was not heard" in joined
    assert "Missing" in joined  # tonight / tomorrow / the address
    assert p["end_card"]["start"] == pytest.approx(p["speech_end"] - analyze.END_FALLBACK, abs=2e-3)
    last_chip = p["chips"][-1]
    assert p["cta_start"] == pytest.approx(
        max(p["speech_end"] - analyze.CTA_FALLBACK, last_chip["start"] + 1.0), abs=2e-3)
    assert p["diff"][-1]["kind"] == "omit" and p["diff"][-1]["script"].startswith("sign up")


# --- speed --------------------------------------------------------------------------

def test_slow_read_is_sped_up_to_16():
    p = one(words_of(SAY["victoria-2"], rate=0.94))
    assert 1.0 < p["speed"] <= analyze.MAX_SPEED
    assert p["duration"] <= analyze.TARGET + 1e-3
    assert p["duration"] > analyze.TARGET - 0.1  # no faster than needed
    assert any(w.startswith("sped up") for w in p["warnings"])
    assert texts(p) == SAY["victoria-2"].split()  # never drops script words to fit


def test_speed_is_capped_and_overlong_warns():
    p = one(words_of(SAY["medford-2"], rate=0.75))
    assert p["speed"] == analyze.MAX_SPEED
    assert p["duration"] > analyze.HARD_MAX
    assert any(w.startswith("runs ") for w in p["warnings"])
    assert texts(p) == SAY["medford-2"].split()


def test_speed_scales_the_timeline():
    p = one(words_of(SAY["victoria-2"], rate=0.94))
    total = sum(s["end"] - s["start"] for s in p["segments"])
    assert p["speech_end"] == pytest.approx((total - analyze.PAD_AFTER) / p["speed"], abs=2e-3)


# --- overlays -------------------------------------------------------------------------

def test_chips_follow_their_cue_words():
    p = one(words_of(SAY["victoria-2"]))
    starts = [c["start"] for c in p["chips"]]
    assert starts == [find_word(p["words"], "Friday,")["start"],
                      find_word(p["words"], "Saturday,")["start"],
                      find_word(p["words"], "Sunday,")["start"]]
    assert [c["end"] for c in p["chips"]] == starts[1:] + [p["cta_start"]]
    assert p["cta_start"] == find_word(p["words"], "Sign")["start"]
    assert p["hook"]["end"] == pytest.approx(min(starts[0] - 0.15, 2.6), abs=2e-3)


def test_chip_with_unspoken_cue_is_dropped():
    say = SAY["victoria-2"].replace(" Sunday, a free Coco screening at DeLeon Plaza.", "")
    p = one(words_of(say))
    assert [c["text"] for c in p["chips"]] == [c["text"] for c in VIDEOS["victoria-2"]["chips"][:2]]
    assert any(w.startswith('chip "SUN') for w in p["warnings"])
    assert p["chips"][-1]["end"] == p["cta_start"]


def test_misheard_cue_still_places_its_chip():
    # Real whisper output on a TTS read: "Hucky Halloween" for "Hockey".
    p = one(words_of(SAY["lincoln-2"].replace("Hockey", "Hucky")))
    assert len(p["chips"]) == 4
    assert p["chips"][0]["start"] == find_word(p["words"], "Hucky")["start"]
    assert any(w.startswith('chip "FRI') and "placed on" in w for w in p["warnings"])
    assert any(w.startswith("Wrong name?") and "hucky" in w for w in p["warnings"])


def test_later_cue_word_used_when_the_first_is_missing():
    # The chip waits for any of its cues: "spooky" when "Thursday" is skipped.
    say = SAY["victoria-1"].replace("Thursday, spooky", "spooky")
    p = one(words_of(say))
    assert p["chips"][1]["start"] == find_word(p["words"], "spooky")["start"]


# --- the card, phone and end-card fields (scripts.json passes them through) --------------

def _with_fields(**top):
    """The frozen scripts, with the new look's fields on victoria-1 and the
    shared ones given (phone_cue, end_card)."""
    data = json.loads(json.dumps(DATA))
    v = next(v for v in data["videos"] if v["id"] == "victoria-1")
    v["chips"][0].update({"icon": "🎬", "tag": "Mon, Oct 26", "title": "A Nightmare on Elm Street",
                          "venue": "Moonshine Drive-In"})
    v["chips"][1].update({"icon": "⛳", "tag": "Thu, Oct 29", "title": "Spooky mini golf",
                          "venue": "Victoria Public Library", "free": True})
    data.update(top)
    return data


def test_card_fields_pass_through_to_the_plan():
    p = one(words_of(SAY["victoria-1"]), scripts=_with_fields())
    a, b = p["chips"]
    assert (a["icon"], a["tag"], a["title"], a["venue"]) == ("🎬", "Mon, Oct 26", "A Nightmare on Elm Street",
                                                             "Moonshine Drive-In")
    assert "free" not in a and b["free"] is True and b["title"] == "Spooky mini golf"
    assert a["text"] == VIDEOS["victoria-1"]["chips"][0]["text"]  # the fallback rides along
    assert list(a)[:3] == ["text", "start", "end"]
    # The frozen scripts have none of them: chips stay text, start, end.
    plain = one(words_of(SAY["victoria-1"]))
    assert all(set(c) == {"text", "start", "end"} for c in plain["chips"])
    assert plain["phone"] is None


def test_end_card_fields_fill_in_the_city_and_domain():
    ec = dict(DATA["end_card"], tagline="Everything to do in {city}, in your inbox every Monday and Thursday",
              button="Sign up free", url="{domain}/subscribe")
    p = one(words_of(SAY["shoals-2"]), scripts=_with_fields(end_card=ec))
    e = p["end_card"]
    assert e["tagline"] == "Everything to do in the Shoals, in your inbox every Monday and Thursday"
    assert e["button"] == "Sign up free" and e["url"] == "shoalssetlist.com/subscribe"
    assert e["line1"] == DATA["end_card"]["line1"] and e["line2"] == "shoalssetlist.com"
    # Without them (the frozen scripts), only line1 and line2.
    assert set(one(words_of(SAY["shoals-2"]))["end_card"]) == {"start", "end", "line1", "line2"}


def test_phone_shows_from_its_cue_after_the_cards():
    p = one(words_of(SAY["victoria-1"]), scripts=_with_fields(phone_cue=["email", "inbox"]))
    inbox = next(w for w in p["words"] if "inbox" in w["text"].lower())
    assert p["phone"]["start"] == inbox["start"]
    assert p["phone"]["end"] == pytest.approx(min(inbox["start"] + analyze.PHONE_SECONDS,
                                                  p["end_card"]["start"]), abs=2e-3)
    assert p["phone"]["start"] > p["chips"][-1]["start"]
    assert not any("phone" in w for w in p["warnings"])


def test_phone_cue_before_the_cards_waits_for_one_after_them():
    # "inbox" said in the opening line is not the phone's moment; the one
    # after the cards is.
    say = "Your inbox, " + SAY["victoria-1"]
    p = one(words_of(say), scripts=_with_fields(phone_cue=["inbox"]), video_id="victoria-1")
    later = [w for w in p["words"] if "inbox" in w["text"].lower()][-1]
    assert p["phone"]["start"] == later["start"]


def test_no_phone_when_its_cue_is_not_said_or_too_late():
    p = one(words_of(SAY["victoria-1"]), scripts=_with_fields(phone_cue=["newsletter"]))
    assert p["phone"] is None
    assert any(w.startswith("no phone: none of its cue words (newsletter)") for w in p["warnings"])
    # "Free." comes about a second before the address: too short for the phone.
    p = one(words_of(SAY["victoria-1"]), scripts=_with_fields(phone_cue=["free"]))
    free = next(w for w in p["words"] if w["text"].lower().startswith("free"))
    assert p["end_card"]["start"] - free["start"] < analyze.PHONE_MIN
    assert p["phone"] is None


def test_hook_lasts_at_least_16():
    # lincoln-2's first cue ("hockey") comes early; the hook still gets 1.6 s.
    say = "Hockey Halloween with the Stars on Friday, " + SAY["lincoln-2"].split(
        "Hockey Halloween with the Stars on Friday, ")[1]
    p = one(words_of(say), video_id="lincoln-2")
    assert p["chips"][0]["start"] < 1.0
    assert p["hook"]["end"] == analyze.HOOK_MIN


def test_end_card_minimum_length():
    # The address is the last word and said fast: the card still gets 1.5 s.
    w = words_of(SAY["shoals-3"])
    w[-1]["end"] = w[-1]["start"] + 0.2
    p = one(w)
    ec = p["end_card"]
    assert ec["start"] == p["words"][-1]["start"]
    assert ec["end"] == pytest.approx(ec["start"] + analyze.END_MIN, abs=2e-3)
    assert ec["end"] > p["speech_end"] + analyze.END_TAIL


def test_end_card_tail_after_speech():
    p = one(words_of(SAY["victoria-1"]))
    ec = p["end_card"]
    assert ec["end"] == pytest.approx(max(p["speech_end"] + 0.9, ec["start"] + 1.5), abs=2e-3)


# --- diff and warnings ----------------------------------------------------------------

def test_wrong_day_is_a_warning():
    p = one(words_of(SAY["victoria-2"].replace("Friday, Calaveras", "Thursday, Calaveras")))
    assert {"kind": "substitute", "script": "friday", "spoken": "thursday",
            "at": find_word(p["words"], "Thursday,")["start"]} in p["diff"]
    assert any(w.startswith("Wrong day?") and '"thursday"' in w for w in p["warnings"])


def test_wrong_number_is_a_warning():
    p = one(words_of(SAY["victoria-1"].replace("eight", "seven")))
    assert any(w.startswith("Wrong number?") and '"7"' in w for w in p["warnings"])


@pytest.mark.parametrize("said", ["nine", "9", "Nine"])
def test_nine_for_eight_is_a_warning(said):
    p = one(words_of(SAY["victoria-1"].replace("eight", said)))
    assert {"kind": "substitute", "script": "8", "spoken": "9",
            "at": find_word(p["words"], said)["start"]} in p["diff"]
    assert any(w.startswith("Wrong number?") and '"9"' in w and '"8"' in w for w in p["warnings"])


def test_missing_town_name_is_a_warning():
    # "Victoria:" opens the script, so it never counted as a name; dropping
    # the town from its own ad passed without a word.
    p = one(words_of(SAY["victoria-1"].replace("Victoria: ", "")))
    assert any(w.startswith("Missing name.") and '"victoria"' in w for w in p["warnings"])


def test_missing_name_is_a_warning():
    p = one(words_of(SAY["victoria-1"].replace(" at Moonshine", "")))
    assert any(w.startswith("Missing name.") and "moonshine" in w for w in p["warnings"])


def test_extra_day_is_a_warning():
    p = one(words_of(SAY["lincoln-1"].replace("silent film", "silent film Saturday")))
    assert any(w.startswith("Extra day.") for w in p["warnings"])


def test_harmless_diff_is_not_a_warning():
    p = one(words_of(SAY["victoria-1"].replace("not even the best part", "not even the best thing")))
    assert p["diff"] == [{"kind": "substitute", "script": "part", "spoken": "thing",
                          "at": find_word(p["words"], "thing.")["start"]}]
    assert p["warnings"] == []


def test_low_whisper_confidence_on_a_day_warns():
    w = words_of(SAY["victoria-2"])
    find_word(w, "Friday,")["prob"] = 0.2
    p = one(w)
    assert any(x.startswith('Check "Friday,"') for x in p["warnings"])


def test_low_similarity_warns():
    say = SAY["victoria-2"].replace(
        "Saturday, the costume contest at the farmers market, Zoo Boo, then Malloween.",
        "Saturday, like, honestly the most fun thing you could ever do, I promise you all")
    p = one(words_of(say))
    assert any(w.startswith("similarity") for w in p["warnings"])


# --- I/O: transcript files, CLI, cache, chunking, prompt --------------------------------

def test_plan_reads_a_transcript_file(tmp_path):
    w = words_of(SAY["shoals-1"])
    path = tmp_path / "words.json"
    path.write_text(json.dumps({"words": w}))
    p = analyze.plan(str(tmp_path / "raw.mov"), transcript=str(path))[0]
    assert p["video_id"] == "shoals-1" and p["source"] == str(tmp_path / "raw.mov")
    path.write_text(json.dumps(w))  # a bare list works too
    assert analyze.plan("raw.mov", transcript=str(path))[0]["video_id"] == "shoals-1"


def test_plan_reads_whisper_segments_json(tmp_path):
    # faster-whisper / openai-whisper JSON: words nested in segments, under
    # "word" and "probability". It used to read as no words at all.
    w = words_of(SAY["shoals-1"])
    segs = {"segments": [
        {"start": 0, "text": "...", "words": [{"word": " " + x["text"], "start": x["start"],
                                              "end": x["end"], "probability": 0.9} for x in w[:20]]},
        {"start": 7, "text": "...", "words": [{"word": " " + x["text"], "start": x["start"],
                                              "end": x["end"], "probability": 0.9} for x in w[20:]]}]}
    path = tmp_path / "whisper.json"
    path.write_text(json.dumps(segs))
    p = analyze.plan(str(tmp_path / "raw.mov"), transcript=str(path))
    assert [x["video_id"] for x in p] == ["shoals-1"] and texts(p[0]) == SAY["shoals-1"].split()


def test_long_silence_at_the_end_with_a_hallucination():
    # Whisper fills a long silence with "Thank you." now and then.
    w, t = speak(SAY["medford-2"], 0.8)
    junk, _ = speak("Thank you. Thank you.", t + 9.0)
    p = one(w + junk)
    assert texts(p) == SAY["medford-2"].split() and p["warnings"] == []
    assert p["segments"][-1]["end"] == pytest.approx(w[-1]["end"] + analyze.PAD_AFTER)


def test_cli_prints_plans(tmp_path):
    path = tmp_path / "words.json"
    path.write_text(json.dumps(words_of(SAY["virginiabeach-1"])))
    r = subprocess.run([sys.executable, os.path.join(VIDEO, "analyze.py"), "raw.mov",
                        "--transcript", str(path)], capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr
    ps = json.loads(r.stdout)
    assert [p["video_id"] for p in ps] == ["virginiabeach-1"]
    assert "virginiabeach-1: take 1 of 1" in r.stderr
    path.write_text(json.dumps(words_of("nothing to see here at all")))
    r = subprocess.run([sys.executable, os.path.join(VIDEO, "analyze.py"), "raw.mov",
                        "--transcript", str(path)], capture_output=True, text=True, timeout=120)
    assert r.returncode == 1 and json.loads(r.stdout) == []


def test_unknown_video_id_fails_before_whisper(tmp_path, monkeypatch):
    # A typo in --video used to cost a full whisper run, then a traceback.
    raw = tmp_path / "raw.mov"
    raw.write_bytes(b"not really a movie")
    monkeypatch.setattr(analyze, "transcribe", lambda *a, **k: pytest.fail("ran whisper"))
    with pytest.raises(KeyError):
        analyze.plan(str(raw), video_id="victoria-9")
    r = subprocess.run([sys.executable, os.path.join(VIDEO, "analyze.py"), str(raw),
                        "--video", "victoria-9"], capture_output=True, text=True, timeout=120)
    assert r.returncode == 2 and "unknown video 'victoria-9'" in r.stderr and "victoria-1" in r.stderr
    assert "Traceback" not in r.stderr
    r = subprocess.run([sys.executable, os.path.join(VIDEO, "analyze.py"), str(raw),
                        "--transcript", str(tmp_path / "nope.json")],
                       capture_output=True, text=True, timeout=120)
    assert r.returncode == 2 and "no such transcript" in r.stderr and "Traceback" not in r.stderr


def test_transcribe_is_cached_by_file_hash(tmp_path, monkeypatch):
    monkeypatch.setenv("VIDEO_EDIT_CACHE", str(tmp_path / "cache"))
    raw = tmp_path / "raw.mov"
    raw.write_bytes(b"not really a movie")
    calls = []
    fake = words_of(SAY["medford-1"])
    monkeypatch.setattr(analyze, "_extract_audio", lambda src, dst: calls.append(("ffmpeg", src)))
    monkeypatch.setattr(analyze, "_run_whisper", lambda wav, model, prompt: calls.append(
        ("whisper", model, prompt)) or fake)
    assert analyze.transcribe(str(raw)) == fake
    assert analyze.transcribe(str(raw)) == fake
    assert [c[0] for c in calls] == ["ffmpeg", "whisper"]  # second call hit the cache
    assert calls[1][1] == analyze.DEFAULT_MODEL and "thevic361.com" in calls[1][2]
    cached = os.listdir(tmp_path / "cache" / "transcripts")
    assert len(cached) == 1 and cached[0].startswith(analyze._sha1(str(raw)))
    analyze.transcribe(str(raw), model="base.en")  # another model is another entry
    assert len(os.listdir(tmp_path / "cache" / "transcripts")) == 2
    p = analyze.plan(str(raw))[0]  # no transcript: goes through transcribe()
    assert p["video_id"] == "medford-1"


def test_whisper_prompt_spells_the_hard_names():
    prompt = analyze.whisper_prompt()
    assert len(prompt) <= analyze.PROMPT_CHARS
    for name in ("Moonshine", "Calaveras", "Craterian", "Trashmore", "Norton", "Pheasant",
                 "Victoria", "Lincoln", "Medford", "Virginia Beach"):
        assert name in prompt, name
    for d in analyze.DOMAINS:
        assert d in prompt


def test_chunks_split_long_audio_in_pauses():
    sr = analyze.SAMPLE_RATE
    # Speech with a breath at 12.0-12.15, a real pause at 18.0-18.6, and a
    # 6 s silence before the last stretch.
    speech = [(1.0, 12.0), (12.15, 18.0), (18.6, 25.0), (25.6, 38.0), (44.0, 60.0)]
    chunks = [(a / sr, b / sr) for a, b in analyze._chunks(70 * sr, speech)]
    assert chunks[0] == (0.0, 18.3)  # the widest pause, not the breath nearest 28 s
    for a, b in chunks:
        assert b - a <= analyze.CHUNK_MAX + 1e-6
    for a, b in speech:  # every word reaches whisper
        assert any(x <= a < y for x, y in chunks) and any(x < b <= y for x, y in chunks)
    # The 6 s silence is skipped, padded; nothing else is.
    assert any(abs(b - (38.0 + analyze.SILENCE_PAD)) < 1e-3 for _, b in chunks)
    assert any(abs(a - (44.0 - analyze.SILENCE_PAD)) < 1e-3 for a, _ in chunks)
    assert chunks[-1][1] == 60.0 + analyze.SILENCE_PAD
    assert analyze._chunks(20 * sr, speech) == [(0, 20 * sr)]  # short: one window
    assert analyze._chunks(60 * sr, []) == [(0, 28 * sr), (28 * sr, 56 * sr), (56 * sr, 60 * sr)]


def test_refine_trims_words_to_speech():
    # Real cases from the TTS fixtures: whisper stretched the first word
    # over the leading silence and "and" over a 1.5 s pause.
    regions = [(0.76, 4.17), (7.64, 12.97), (14.65, 17.77)]
    words = [{"text": "Virginia", "start": 0.0, "end": 1.1, "prob": 0.9},
             {"text": "Farm,", "start": 12.46, "end": 12.84, "prob": 0.9},
             {"text": "and", "start": 13.44, "end": 14.88, "prob": 0.9},
             {"text": "a", "start": 5.0, "end": 5.1, "prob": 0.9},       # VAD missed it
             {"text": "the", "start": 12.9, "end": 13.4, "prob": 0.9}]   # barely seen
    out = analyze._refine(words, regions)
    assert [(w["start"], w["end"]) for w in out] == [
        (0.76, 1.1), (12.46, 12.84), (14.65, 14.88), (5.0, 5.1), (12.9, 13.4)]
    assert out[0]["prob"] == 0.9 and words[0]["start"] == 0.0  # copies, not edits
    # A word split by a stop consonant keeps both halves; a far sliver goes.
    out = analyze._refine([{"text": "Craterian", "start": 1.0, "end": 3.0}],
                          [(0.5, 1.05), (1.5, 1.9), (2.0, 2.4)])
    assert (out[0]["start"], out[0]["end"]) == (1.5, 2.4)
    assert analyze._refine(words, []) == words


def test_collapsed_word_gets_its_length_back():
    # Real case (iphone_medford fixture): whisper pinned "Thursday," to an
    # instant at 7.98 while the speech ran 7.47-7.98; the cut kept 0.12 s.
    regions = [(0.85, 6.95), (7.47, 11.4)]
    words = [{"text": "Saturday.", "start": 6.48, "end": 6.88},
             {"text": "Thursday,", "start": 7.98, "end": 7.98},
             {"text": "a", "start": 8.42, "end": 8.52},
             {"text": "twilight", "start": 8.52, "end": 8.82}]
    out = analyze._refine(words, regions)
    assert (out[1]["start"], out[1]["end"]) == (7.47, 7.98)
    assert [(w["start"], w["end"]) for w in out[2:]] == [(8.42, 8.52), (8.52, 8.82)]
    # No room before it (the previous word ends right there): it grows forward.
    words = [{"text": "best", "start": 1.0, "end": 1.4},
             {"text": "Thursday,", "start": 1.42, "end": 1.42},
             {"text": "spooky", "start": 2.2, "end": 2.6}]
    out = analyze._refine(words, [])
    assert out[1]["start"] == 1.42 and out[1]["end"] == pytest.approx(1.42 + 8 * analyze.SEC_PER_CHAR)


def test_collapsed_day_survives_the_cut():
    w = words_of(SAY["medford-1"])
    tue = find_word(w, "Tuesday,")
    tue["start"] = tue["end"]  # what whisper did, before the refinement
    fixed = analyze._refine(w, [])
    p = one(fixed)
    day = find_word(p["words"], "Tuesday,")
    assert day["end"] - day["start"] > 0.3


def energy(spans, length=16.0, speech=-22.0, floor=-67.0):
    """An _Energy from a sketch: speech-level sound except the [(start, end,
    dB)] spans, with a second of room tone up front (as every raw take has)."""
    n = int(round(length / analyze.FRAME))
    db = [speech] * n
    for s, e, level in [(0.0, 1.0, floor)] + list(spans):
        for i in range(int(round(s / analyze.FRAME)) - 1, int(round(e / analyze.FRAME)) - 1):
            db[i] = level
    return analyze._Energy(db)


# The raw_victoria-1 fixture around the cut "um": a pause after "Thursday,",
# the "um" to 11.02, a dip (never room tone) at 11.05, the "s" of "spooky"
# from 11.08, the "p" closure 11.18-11.24 (room tone), then "ooky". Whisper
# said "um" 10.84-10.88 and "spooky" from 11.28.
UM_SPOOKY = [(10.5, 10.7, -67), (10.7, 11.02, -30), (11.02, 11.04, -50), (11.04, 11.06, -56),
             (11.06, 11.08, -50), (11.08, 11.18, -32), (11.18, 11.24, -67)]


def test_snap_finds_the_onset_whisper_missed():
    en = energy(UM_SPOOKY)
    assert any(s == e and 11.03 <= s <= 11.08 for s, e in en.breaks)  # the dip
    words = [{"text": "um,", "start": 10.84, "end": 10.88},
             {"text": "spooky", "start": 11.28, "end": 11.46}]
    out = analyze._snap(words, en)
    assert 11.0 <= out[0]["end"] <= 11.05 < out[1]["start"] <= 11.09
    assert words[1]["start"] == 11.28  # copies, not edits


def test_snap_keeps_pauses_and_breaths_out_of_words():
    # A 1.5 s pause split by a noise blip, with a breath before "and": the
    # words reach their own sound's edges and no further.
    en = energy([(12.98, 13.4, -67), (13.4, 13.41, -50), (13.41, 14.3, -67), (14.3, 14.6, -55),
                 (14.6, 14.84, -67)])
    words = [{"text": "Farm,", "start": 12.5, "end": 12.92},
             {"text": "and", "start": 14.84, "end": 15.0}]
    out = analyze._snap(words, en)
    assert out[0]["end"] == pytest.approx(12.98, abs=0.015)
    assert out[1]["start"] == 14.84
    p = one(analyze._refine(words_of(SAY["lincoln-2"].replace(
        "Farm, and", "Farm, <pause:1.5> and")), [], None))
    farm, and_ = find_word(p["words"], "Farm,"), find_word(p["words"], "and", 0)
    assert and_["start"] - farm["end"] == pytest.approx(analyze.GAP_TO, abs=2e-3)


def test_snap_leaves_touching_words_alone():
    en = energy(UM_SPOOKY)
    touching = [{"text": "mini", "start": 11.3, "end": 11.4}, {"text": "golf", "start": 11.4, "end": 11.6}]
    assert analyze._snap(touching, en) == touching
    assert analyze._snap(touching, None) == touching


def test_energy_from_audio():
    np = pytest.importorskip("numpy")
    sr = analyze.SAMPLE_RATE
    t = np.arange(int(3.0 * sr)) / sr
    env = np.ones_like(t)
    env[(t > 1.0) & (t < 1.5)] = 0.0          # a pause
    env[(t > 2.0) & (t < 2.04)] = 0.02        # a brief dip, never silent
    rng = np.random.default_rng(1)
    audio = (0.3 * np.sin(2 * np.pi * 220 * t) * env
             + 0.0005 * rng.standard_normal(len(t))).astype(np.float32)
    en = analyze._Energy.of(audio)
    pauses = [(s, e) for s, e in en.breaks if e - s >= 0.1]
    assert len(pauses) == 1 and abs(pauses[0][0] - 1.0) < 0.03 and abs(pauses[0][1] - 1.5) < 0.03
    assert any(s == e and 1.98 <= s <= 2.06 for s, e in en.breaks)
    assert analyze._Energy.of(audio[:500]) is None


def test_caption_fragments_are_joined():
    say = SAY["shoals-2"].replace("Howl-o-ween", "Howl -O -Ween")
    p = one(words_of(say))
    assert "Howl-O-Ween" in texts(p) and "-O" not in texts(p)
    say = SAY["lincoln-2"].replace("a thousand-dollar", "a $1 ,000")
    p = one(words_of(say))
    assert "$1,000" in texts(p) and p["diff"] == []


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="needs ffmpeg")
def test_extract_audio_makes_16k_mono(tmp_path):
    src = tmp_path / "tone.mov"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=108x192:d=1",
                    "-f", "lavfi", "-i", "sine=frequency=440:duration=1:sample_rate=48000",
                    "-ac", "2", "-shortest", "-c:v", "libx264", "-c:a", "aac", str(src)],
                   check=True, timeout=60)
    dst = tmp_path / "a.wav"
    analyze._extract_audio(str(src), str(dst))
    import wave
    with wave.open(str(dst)) as f:
        assert f.getframerate() == 16000 and f.getnchannels() == 1
        assert 0.9 < f.getnframes() / 16000 < 1.2


# --- the real thing (slow) ----------------------------------------------------------------

def _fixture(name):
    path = os.path.join(FIXTURES, name)
    return path if os.path.exists(path) else None


@pytest.mark.skipif(not _fixture("clean_victoria-1.wav"), reason="no TTS fixture (see out/fixtures)")
def test_real_whisper_on_tts_clip(tmp_path, monkeypatch):
    fw = pytest.importorskip("faster_whisper")
    try:  # never download in a test: setup.sh fetches the model
        fw.download_model(analyze.DEFAULT_MODEL, local_files_only=True)
    except Exception:  # noqa: BLE001
        pytest.skip("whisper model not downloaded (run setup.sh)")
    monkeypatch.setenv("VIDEO_EDIT_CACHE", str(tmp_path))  # really run whisper
    words = analyze.transcribe(_fixture("clean_victoria-1.wav"))
    assert words and all(w["start"] <= w["end"] for w in words)
    assert "thevic361.com" in analyze.tokens(" ".join(w["text"] for w in words))
    p = analyze.plan(_fixture("clean_victoria-1.wav"), transcript=words)
    assert [x["video_id"] for x in p] == ["victoria-1"]
    check_contract(p[0])
    assert p[0]["takes"][0]["coverage"] >= 0.9
