#!/usr/bin/env python3
"""Find the subscribe-video scripts in a raw selfie take and plan the cut.

    python3 marketing/video/analyze.py RAW.MOV [--video ID] [--transcript JSON] [--model M]

prints a JSON list of plans, one per script found in the file. render.py
draws exactly what a plan says, so every editing decision lives here: which
take, which words survive, where the jump cuts go, and when the hook, the
event chips, the sign-up line and the end card show.

A raw iPhone file can hold flubs, restarts, long pauses, several takes and
even several different scripts. Whisper gives word timestamps; the
transcript and the scripts are normalized to one token form (numbers both
ways, the domain however it was said, hyphens split), every script is
aligned against the whole transcript with a Viterbi pass that allows
restarts, and the best take of each script is tightened (restarts spliced,
fillers and corrected slips like "Monday... no, Thursday" cut) and laid out
on the 16-second timeline.

Plan fields (seconds; "output" = after the cuts and the speed-up):
  video_id, town, source      which script, whose Page, the raw file
  similarity                  the chosen take against its script, 0..1
  takes, take                 every take found (source times, coverage) and
                              the index of the one used
  segments                    source ranges to keep, in order
  speed                       1.0 to 1.12, applied after joining segments
  duration, speech_end        output length (= end_card.end); last word end
  words                       kept words on the output timeline (captions)
  hook, chips, cta_start, phone, end_card   overlay timing on the output timeline
  diff                        script vs spoken, non-filler words
  warnings                    what a human must check before posting

The overlays, on the output timeline:
  hook        {text, start, end}: the badge shows the hook until end, then
              "Subscribe free" and the domain until the end card
  chips       [{text, start, end}], one event card each, from its first cue
              word to the next card (the last to cta_start). The script's
              card fields ride along when it has them: icon (one emoji),
              tag, title, venue, and free (true: a FREE pill). A card
              without a title shows text as its title. The renderer makes
              chips cued in quick succession one list card, a row each.
  cta_start   when the sign-up line (cta_cue) starts
  phone       {start, end}: a phone showing the town's next newsletter
              issue (else its site), from the first phone_cue word said
              after the cards (and after the hook) for PHONE_SECONDS, cut
              short at the end card; null when scripts.json has no
              phone_cue or none was said. The renderer hides a lone card
              while the phone is up; a list stays, and the phone makes room.
  end_card    {start, end, line1, line2}, plus tagline, button and url when
              scripts.json's end_card has them, with {city} and {domain}
              filled in. Older plans with only line1/line2 still render.

The video after the last segment (speech_end + 0.10 to duration) has no
source footage in the plan: the renderer holds the last frame under the end
card, because the raw file usually goes on with "okay, cut" or the next take.
"""
import argparse
import difflib
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import time
import unicodedata
import wave
from collections import namedtuple

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import towns  # noqa: E402  (marketing/video/towns.py, not the repo's towns/ folder)

SCRIPTS_PATH = os.path.join(HERE, "scripts.json")
DEFAULT_MODEL = "small.en"
SAMPLE_RATE = 16000

# The cut (shared with render.py through the plan).
PAD_BEFORE = 0.07      # lead-in kept before every word: onsets clip first
PAD_AFTER = 0.10       # tail after every word
LONG_GAP = 0.30        # a pause longer than this gets shortened...
GAP_TO = 0.12          # ...to this much silence
MERGE_UNDER = 0.05     # a cut removing less than this is just a picture jump
TARGET = 16.0
HARD_MAX = 16.5
MAX_SPEED = 1.12       # faster than this and Tristen sounds like a podcast ad
HOOK_MIN, HOOK_MAX, HOOK_LEAD = 1.6, 2.6, 0.15
END_TAIL, END_MIN, END_FALLBACK = 0.9, 1.5, 1.2
CTA_FALLBACK = 4.0
PHONE_SECONDS, PHONE_MIN = 2.0, 1.0   # the phone mockup; shorter than PHONE_MIN before the end card, none
# The event card's own fields, passed through from scripts.json to render.py.
CARD_FIELDS = ("icon", "tag", "title", "venue", "free")
END_CARD_FIELDS = ("tagline", "button", "url")

# Which takes count.
MIN_COVERAGE = 0.6
FORCED_COVERAGE = 0.35  # with --video the human has said which script it is
TIE = 0.03             # takes this close count as a tie; the later one wins
SIMILARITY_WARN = 0.85
LOW_PROB = 0.5         # whisper hears days at 0.9+; below this, have a listen

# Viterbi costs. A match earns 1; everything else costs. Leaving a take is
# free (coverage already punishes a short take), entering one costs, so a
# few stray common words ("and the") never form a take of their own.
MATCH = 1.0
INSERT = 0.6           # a spoken word that isn't in the script
SUBSTITUTE = 0.7       # cheaper than insert + omit, so "thursday" for "friday" pairs up
OMIT = 0.45            # per script word skipped
JUMP = 1.2             # going back in the script (a restart)
ENTER = 2.0
ENTER_SKIP = 0.03      # per script word skipped when a take starts mid-script
FUZZY = 0.84           # spelling-level ratio for names whisper bends a little
DOMAIN_FUZZ = 0.85
DOMAIN_DIGITS_FUZZ = 0.6  # letters can be rougher when the digits are exact
FUZZY_RUN = 0.85       # one misheard word for a run of script words
# Words whisper glues onto the address ("Freethevic361"), split back off.
_ADDRESS_LEADS = ("free", "at", "visit", "and", "its")
ADDRESS_SUB = 0.3      # gain for lining a wrong address up against the right one
# The right address is worth reaching past a slip ("thevic316.com, sorry,
# thevic361.com" keeps the second): 2.5 bridges four inserted words, yet a
# lone address elsewhere still can't pay for entering the script (2.87 for
# the shortest one), so it never forms a take of its own.
ADDRESS_WEIGHT = 2.5
# A jump back to the first word is a new take; any other jump back is a
# restart, however far (Tristen redoes the sentence before a late flub),
# and the first words of the try before it stay ("Victoria: nine... sorry,
# eight" keeps "Victoria").
REJOIN = 8.0           # an off-script aside longer than this ends the take
# Off-script words just before a script word are a slip he corrected, and
# get cut, when they end in one of these, trail off ("Moon..."), stutter
# into it ("lib library") or are a day, number or address followed by
# another one ("Monday... no, Thursday"). Longer runs are an ad-lib.
CORRECTIONS = frozenset("sorry no nope wait oops whoops ugh mean again scratch redo".split())
SLIP_MAX = 8
# Another script's take starting this close before a try ends still sits
# "between" it and the next one (its first words can overlap the last).
BETWEEN_SLACK = 0.5
PLAUSIBLE = 0.35       # share of a script's words that must occur at all

FILLERS = frozenset("um umm uh uhh uhm er erm ah ahh hmm hm mm mmm".split())


# --- normalization -----------------------------------------------------------

Tok = namedtuple("Tok", "text w0 w1")  # w0..w1: the source words it came from

_QUOTES = str.maketrans({"\u2018": "'", "\u2019": "'", "\u201a": "'", "\u201b": "'",
                         "\u2032": "'", "\u00b4": "'", "`": "'", "\u201c": '"',
                         "\u201d": '"', "\u201e": '"', "\u2033": '"'})
_DASHES = re.compile("[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]")
_UNITS = {w: i for i, w in enumerate(
    "zero one two three four five six seven eight nine ten eleven twelve thirteen "
    "fourteen fifteen sixteen seventeen eighteen nineteen".split())}
_TENS = {w: 10 * (i + 2) for i, w in enumerate(
    "twenty thirty forty fifty sixty seventy eighty ninety".split())}
_SCALES = {"thousand": 1000, "million": 1000000}
_NUMWORDS = frozenset(_UNITS) | frozenset(_TENS) | frozenset(_SCALES) | {"hundred"}
_ORDINALS = {"1": "first", "2": "second", "3": "third", "4": "fourth", "5": "fifth",
             "6": "sixth", "7": "seventh", "8": "eighth", "9": "ninth", "10": "tenth"}
_ALIASES = {"dollars": "dollar", "mt": "mount", "st": "street"}
# "week is" and "week's" (whisper writes either) share one key.
_CONTRACTIONS = {"is": "s", "are": "re", "will": "ll", "have": "ve", "not": "nt",
                 "am": "m", "would": "d", "had": "d"}

_DAYS = frozenset(
    "monday tuesday wednesday thursday friday saturday sunday today tonight tomorrow "
    "weekend january february march april may june july august september october "
    "november december".split())
_DAY_ABBR = frozenset("mon tue tues wed thu thur thurs fri sat sun".split())
_STOP = frozenset("a an and at the of on in to with for from plus vs is it its this that "
                  "your you up".split())

_DOMAIN_KEYS = {}   # "thevic361com" -> "thevic361.com"
_DOMAIN_NAMES = {}  # "thevic361" -> "thevic361.com"
for _t in towns.TOWNS.values():
    _DOMAIN_KEYS[re.sub(r"[^a-z0-9]", "", _t["domain"])] = _t["domain"]
    _DOMAIN_NAMES[re.sub(r"[^a-z0-9]", "", _t["domain"].rsplit(".", 1)[0])] = _t["domain"]
DOMAINS = frozenset(_DOMAIN_KEYS.values())


def _pieces(word):
    """One word -> lowercase alphanumeric pieces ("trunk-or-treats" -> 3)."""
    w = unicodedata.normalize("NFKD", str(word))
    w = "".join(c for c in w if not unicodedata.combining(c))
    w = _DASHES.sub("-", w.translate(_QUOTES).lower())
    # "$1,000" is how whisper writes the script's "thousand-dollar".
    w = re.sub(r"\$\s*(\d[\d,]*)", r"\1 dollar ", w)
    w = re.sub(r"(?<=\d),(?=\d{3}(?!\d))", "", w)
    w = w.replace("&", " and ").replace("@", " at ").replace("+", " plus ").replace("%", " percent ")
    out = []
    # Punctuation between two words splits them ("Monday,Nightmare").
    for part in re.split(r"[\s\-/_,;:!?]+", w):
        if re.fullmatch(r"(?:[a-z]\.){2,}[a-z]?", part):  # u.n.a. -> una
            part = part.replace(".", "")
        for sub in part.split("."):  # thevic361.com -> thevic361, com
            sub = re.sub(r"[^a-z0-9]", "", sub)  # apostrophes too: they're -> theyre
            if not sub:
                continue
            m = re.fullmatch(r"(\d+)(?:st|nd|rd|th)", sub)
            if m:
                out.append(_ORDINALS.get(m.group(1), m.group(1)))
                continue
            out.extend(re.findall(r"[a-z]+|[0-9]+", sub))  # 10k -> 10 k
    return out


def _number_text(words):
    """['three', 'sixty', 'one'] -> '361'; ['two', 'thousand', 'six'] -> '2006'.

    Groups that can't combine are written side by side, which is how people
    read web addresses and years ("three sixty one", "nineteen twenty six").
    """
    chunks = []
    total, group, last = 0, None, None

    def flush():
        nonlocal total, group, last
        if group is not None or total:
            chunks.append(str(total + (group or 0)))
        total, group, last = 0, None, None

    for w in words:
        if w.isdigit():
            flush()
            chunks.append(w)
        elif w in ("oh", "o"):
            flush()
            chunks.append("0")
        elif w == "and":
            continue
        elif w in _UNITS:
            v = _UNITS[w]
            if last == "tens" and 0 < v < 10:
                group += v
            elif last in ("hundred", "scale"):
                group = (group or 0) + v
            else:
                flush()
                group = v
            last = "unit" if v < 10 else "teen"
        elif w in _TENS:
            if last in ("hundred", "scale"):
                group = (group or 0) + _TENS[w]
            else:
                flush()
                group = _TENS[w]
            last = "tens"
        elif w == "hundred":
            if group is None:
                group = 100
            elif group < 100 and last != "hundred":
                group *= 100
            else:
                flush()
                group = 100
            last = "hundred"
        elif w in _SCALES:
            total += (group if group is not None else 1) * _SCALES[w]
            group, last = None, "scale"
    flush()
    return "".join(chunks)


def _isnum(t):
    return t.isdigit() or t in _NUMWORDS


def _numbers(toks):
    """Number words and digits collapse to one digit-string token, so "8",
    "eight", "two thousand six" and "2006" compare equal."""
    out, i = [], 0
    while i < len(toks):
        if not _isnum(toks[i].text):
            out.append(toks[i])
            i += 1
            continue
        j = i + 1
        while j < len(toks):
            t = toks[j].text
            nxt = toks[j + 1].text if j + 1 < len(toks) else ""
            if _isnum(t):
                j += 1
            elif (t == "and" and toks[j - 1].text in ("hundred", "thousand", "million")
                  and nxt in _NUMWORDS and nxt not in ("hundred", "thousand", "million")):
                j += 1  # "two thousand and six"
            elif t in ("oh", "o") and (nxt.isdigit() or nxt in _UNITS):
                j += 1  # "four oh two"
            else:
                break
        run = toks[i:j]
        out.append(Tok(_number_text([r.text for r in run]), run[0].w0, run[-1].w1))
        i = j
    return out


def _domain_match(key):
    """The address a run of tokens ending in "com" spells, and how surely.

    Letters may be a little off ("thevick"); digits must be exact. The
    right name with the wrong digits ("thevic316") becomes an address token
    of its own, so it lines up against the real one as a substitution and
    gets flagged: a wrong address is the costliest mistake a video can make.
    """
    if key in _DOMAIN_KEYS:
        return _DOMAIN_KEYS[key], 1.0
    digits, letters = re.sub(r"\D", "", key), re.sub(r"\d", "", key)
    best = (None, 0.0)
    for k, d in _DOMAIN_KEYS.items():
        kd = re.sub(r"\D", "", k)
        r = difflib.SequenceMatcher(None, letters, re.sub(r"\d", "", k)).ratio()
        if kd and kd == digits and r >= DOMAIN_DIGITS_FUZZ:
            # The town's own digits plus "com" say which address it is,
            # even when whisper mangles "thevic" into "thavoc".
            cand = (d, r)
        elif r >= DOMAIN_FUZZ:
            cand = (d, r) if kd == digits else (key[:-3] + ".com", r - 0.5)
        else:
            continue
        if cand[1] > best[1]:
            best = cand
    return best


def _domains(toks):
    """Every spoken form of a town's address -> one token ("thevic361.com"):
    thevic361.com, The Vic 361.com, the vic three sixty one dot com, ..."""
    texts = [t.text for t in toks]
    spans = []  # (first token, last token, address, glued lead word or None)

    def key_of(parts):
        return "".join(x for x in parts if x not in ("dot", "www"))

    for j, t in enumerate(texts):
        if t != "com" or j == 0:
            continue
        best = None
        for i in range(j - 1, max(-1, j - 9), -1):
            d, r = _domain_match(key_of(texts[i:j + 1]))
            # Strictly better only: the shortest window wins a tie, so "free"
            # before the address stays a word of its own.
            if d and (best is None or r > best[0] + 1e-9):
                best = (r, i, d, None)
        if best:
            r, i, d, _ = best
            for lead in _ADDRESS_LEADS:
                if texts[i].startswith(lead) and len(texts[i]) - len(lead) >= 3:
                    d2, r2 = _domain_match(key_of([texts[i][len(lead):]] + texts[i + 1:j + 1]))
                    if d2 and r2 > r:
                        r, d, best = r2, d2, (r2, i, d2, lead)
            i = best[1] - 1 if best[1] > 0 and texts[best[1] - 1] == "www" else best[1]
            spans.append((i, j, best[2], best[3]))
    taken = {k for i, j, _, _ in spans for k in range(i, j + 1)}
    # Without "dot com" only an exact spelling counts.
    for i in range(len(texts)):
        if i in taken:
            continue
        key = ""
        for j in range(i, min(len(texts), i + 7)):
            if j in taken:
                break
            key += texts[j]
            if key in _DOMAIN_NAMES:
                spans.append((i, j, _DOMAIN_NAMES[key], None))
                taken.update(range(i, j + 1))
                break
            if not any(n.startswith(key) for n in _DOMAIN_NAMES):
                break
    if not spans:
        return toks
    spans.sort()
    out, i, k = [], 0, 0
    while i < len(toks):
        while k < len(spans) and spans[k][0] < i:
            k += 1  # overlaps one already used
        if k < len(spans) and spans[k][0] == i:
            a, b, d, lead = spans[k]
            if lead:
                out.append(Tok(lead, toks[a].w0, toks[a].w0))
            out.append(Tok(d, toks[a].w0, toks[b].w1))
            i, k = b + 1, k + 1
        else:
            out.append(toks[i])
            i += 1
    return out


def normalize(words):
    """Word strings -> Tok list, one canonical form for the script and for
    whatever whisper wrote. Each Tok remembers its source words."""
    units = []
    for i, w in enumerate(words):
        w = str(w)
        if units and re.search(r"\d$", units[-1][0]) and re.match(r"[,.]\d{3}(?!\d)", w):
            units[-1] = (units[-1][0] + w, units[-1][1], i)  # whisper split "$1" ",000"
        else:
            units.append((w, i, i))
    raw = [Tok(p, a, b) for text, a, b in units for p in _pieces(text)]
    toks = _domains(_numbers(raw))
    return [Tok(_ALIASES.get(t.text, t.text), t.w0, t.w1) for t in toks]


def tokens(text):
    """Normalized tokens of a string (for tests and quick checks)."""
    return [t.text for t in normalize(str(text).split())]


def _ckey(texts):
    return (texts[0] + "".join(_CONTRACTIONS.get(t, t) for t in texts[1:])) if texts else ""


def _stem(t):
    return t[:-1] if len(t) > 3 and t.endswith("s") and not t.endswith("ss") else t


def _is_day(t):
    return t in _DAYS or (t.endswith("s") and t[:-1] in _DAYS)


def _is_address(t):
    return t.endswith(".com")  # a town's domain, or one said with the wrong digits


def _critical(t):
    return _is_day(t) or t.isdigit() or _is_address(t)


def _spoken_kind(t):
    if _is_day(t):
        return "day"
    if t.isdigit():
        return "number"
    if _is_address(t):
        return "domain"
    return None


def _is_filler(text):
    p = _pieces(text)
    return bool(p) and all(x in FILLERS for x in p)


# --- scripts -----------------------------------------------------------------

def load_scripts(path=None):
    # VIDEO_SCRIPTS points at another script list: the tests pin a frozen
    # batch with it, since scripts.json is rewritten every week.
    with open(path or os.environ.get("VIDEO_SCRIPTS") or SCRIPTS_PATH, encoding="utf-8") as f:
        return json.load(f)


class Script:
    """One scripts.json video with what the aligner needs precomputed."""

    def __init__(self, video):
        self.video = video
        self.id = video["id"]
        self.town = video["town"]
        self.say_words = video["say"].split()
        toks = normalize(self.say_words)
        self.tokens = [t.text for t in toks]
        self.word_of = [t.w0 for t in toks]  # script word each token came from
        self.vocab = frozenset(self.tokens)
        self.pos = {}
        for q, t in enumerate(self.tokens):
            self.pos.setdefault(t, []).append(q)
        # Runs of 2-4 script tokens, for whisper gluing or splitting words
        # differently ("trunkortreats", "Art Walk" for "Artwalk").
        self.runs, self.ngrams = {}, set()
        for k in (2, 3, 4):
            for i in range(len(self.tokens) - k + 1):
                run = tuple(self.tokens[i:i + k])
                self.ngrams.add(run)
                self.runs.setdefault(_ckey(run), run)
        self.names = self._names()
        self.cues = [_cue_set(c.get("cue", [])) for c in video.get("chips", [])]
        self.weight = [ADDRESS_WEIGHT if _is_address(t) else 1.0 for t in self.tokens]
        self._hits = {}
        self._fuzzy_runs = {}

    def fuzzy_run(self, w):
        """The script run one misheard word stands for ("retreats" for
        "or treats"), when no single script word is close. Never for days,
        numbers or the address: those must be heard right."""
        if w in self._fuzzy_runs:
            return self._fuzzy_runs[w]
        best, score = None, FUZZY_RUN
        if len(w) >= 6 and not _critical(w) and not self.hits(w):
            for key, run in self.runs.items():
                if abs(len(key) - len(w)) > 3 or any(_critical(x) for x in run):
                    continue
                m = difflib.SequenceMatcher(None, w, key)
                if m.quick_ratio() >= score and m.ratio() >= score:
                    best, score = run, m.ratio()
        self._fuzzy_runs[w] = best
        return best

    def _names(self):
        """The chip proper nouns: chip text words, the town's own name
        (wherever it sits: "Victoria:" opens a script), plus every
        capitalized word that isn't just starting a sentence."""
        names = set()

        def add(ts):
            names.update(t for t in ts if t not in _STOP and t not in _DAY_ABBR
                         and not _critical(t))
        for chip in self.video.get("chips", []):
            add(tokens(chip["text"]))
        city = towns.TOWNS.get(self.town, {}).get("city", "")
        add(t for t in self.tokens if _stem(t) in {_stem(c) for c in tokens(city)})
        words = self.video["say"].split()
        for k, w in enumerate(words):
            starts = k == 0 or words[k - 1].endswith((".", "!", "?"))
            if not starts and w[:1].isupper():
                add(tokens(w))
        return frozenset(names)

    def kind(self, t):
        return _spoken_kind(t) or ("name" if t in self.names else None)

    def hits(self, w):
        """[(script position, gain, op)] for spoken token w; op is "match",
        or "sub" for an address said wrong (aligned, never counted)."""
        h = self._hits.get(w)
        if h is None:
            h = [(q, 1.0, "match") for q in self.pos.get(w, ())]
            for t, qs in self.pos.items():
                if t == w:
                    continue
                if _stem(t) == _stem(w) and not t.isdigit():
                    h.extend((q, 0.9, "match") for q in qs)  # plural/possessive: friday(s)
                elif _is_address(w) and _is_address(t):
                    # Worth a little, so the take keeps a misspoken address
                    # instead of ending just before it.
                    h.extend((q, ADDRESS_SUB, "sub") for q in qs)
                elif (len(w) >= 5 and len(t) >= 5 and t[0] == w[0] and abs(len(t) - len(w)) <= 3
                      and not _critical(w) and not _critical(t)
                      and difflib.SequenceMatcher(None, w, t).ratio() >= FUZZY):
                    # Days, numbers and the domain never match loosely:
                    # "tuesday" is 80% "thursday".
                    h.extend((q, 0.7, "match") for q in qs)
            self._hits[w] = h
        return h


def _cue_set(cues):
    out = set()
    for c in cues:
        out.update(tokens(c))
        out.add("".join(_pieces(c)))
    out.discard("")
    return frozenset(out | {_stem(c) for c in out})


def _library(scripts=None):
    data = scripts if scripts is not None else load_scripts()
    return [Script(v) for v in data["videos"]]


def _retokenize(toks, s):
    """Match whisper's word boundaries to this script's: merge "art walk"
    into "artwalk" and split "trunkortreats" when the script spells it the
    other way, and "week is" vs "week's" either way."""
    out, i = [], 0
    while i < len(toks):
        merged = False
        for k in (4, 3, 2):
            run = toks[i:i + k]
            if len(run) < k:
                continue
            texts = tuple(t.text for t in run)
            key = _ckey(texts)
            if key in s.vocab and texts not in s.ngrams and not all(t in s.vocab for t in texts):
                out.append(Tok(key, run[0].w0, run[-1].w1))
                i += k
                merged = True
                break
        if merged:
            continue
        tok = toks[i]
        run = None
        if tok.text not in s.vocab:
            run = s.runs.get(tok.text) or s.fuzzy_run(tok.text)
        if run:
            out.extend(Tok(p, tok.w0, tok.w1) for p in run)
        else:
            out.append(tok)
        i += 1
    return out


# --- alignment ---------------------------------------------------------------

Step = namedtuple("Step", "op how q prev state g")
# op: out | ins | sub | match; how (match, or an address sub): adv | skip |
# jump | enter; q: script position; prev/state: script position before/after
# (-1 = out); g: match quality.


def _viterbi(s, toks):
    """Best path through the whole transcript for one script.

    States are script positions plus "out" (not in a take). A spoken token
    matches the next script word, skips ahead (omission), jumps back (the
    speaker restarted), enters a take from "out", or is an insertion or a
    substitution. Jumps make restarts cheap: re-saying four words after a
    flub earns four matches instead of four insertions.
    """
    n = len(s.tokens)
    neg = float("-inf")
    V = [neg] * (n + 1)
    out = 0.0
    back = []
    for tok in toks:
        nv = [v - INSERT for v in V]
        nb = [None] * (n + 1)  # None: an insertion, same state
        for p in range(n):
            v = V[p] - SUBSTITUTE
            if v > nv[p + 1]:
                nv[p + 1] = v
                nb[p + 1] = ("sub", "adv", p, p, 0.0)
        hits = s.hits(tok.text)
        if hits:
            pre_v, pre_a = [neg] * (n + 1), [0] * (n + 1)  # best p < q, skip cost folded in
            bv, ba = neg, 0
            for p in range(n + 1):
                pre_v[p], pre_a[p] = bv, ba
                x = V[p] + OMIT * p
                if x > bv:
                    bv, ba = x, p
            suf_v, suf_a = [neg] * (n + 1), [0] * (n + 1)  # best p > q
            bv, ba = neg, 0
            for p in range(n, -1, -1):
                suf_v[p], suf_a[p] = bv, ba
                if V[p] > bv:
                    bv, ba = V[p], p
            for q, g, op in hits:
                best, src, how = V[q], q, "adv"
                x = pre_v[q] - OMIT * q
                if x > best:
                    best, src, how = x, pre_a[q], "skip"
                x = suf_v[q] - JUMP
                if x > best:
                    best, src, how = x, suf_a[q], "jump"
                x = out - ENTER - ENTER_SKIP * q
                if x > best:
                    best, src, how = x, -1, "enter"
                x = best + MATCH * g * (s.weight[q] if op == "match" else 1.0)
                if x > nv[q + 1]:
                    nv[q + 1] = x
                    nb[q + 1] = (op, how, q, src, g)
        bi = max(range(n + 1), key=V.__getitem__)
        if V[bi] > out:
            nout, ob = V[bi], bi
        else:
            nout, ob = out, -1
        back.append((ob, nb))
        V, out = nv, nout

    bi = max(range(n + 1), key=V.__getitem__)
    state = bi if V[bi] > out else -1
    steps = [None] * len(toks)
    for t in range(len(toks) - 1, -1, -1):
        ob, nb = back[t]
        if state == -1:
            steps[t] = Step("out", None, None, ob, -1, 0.0)
            state = ob
            continue
        e = nb[state]
        if e is None:
            steps[t] = Step("ins", None, None, state, state, 0.0)
        else:
            op, how, q, src, g = e
            steps[t] = Step(op, how, q, src, state, g)
            state = src
    return steps


def _recover_openings(s, toks, words, steps):
    """Give a take back its first words when a slip right after them made
    the aligner skip them: for "Victoria: nine... sorry, eight", entering
    at "eight" is cheaper than two insertions, and the town name is lost.
    Only when what sits between is a slip (it gets cut), never an aside."""
    steps = list(steps)
    for t, st in enumerate(steps):
        if st.op == "out" or st.how != "enter" or st.q == 0:
            continue
        for a in range(t - 1, max(-1, t - st.q - SLIP_MAX - 1), -1):
            if steps[a].op != "out":
                break  # only words the aligner left out of every take
            if toks[a].text != s.tokens[0]:
                continue
            m = 1  # how many of the script's first words were said there
            while m < st.q and a + m < t and toks[a + m].text == s.tokens[m]:
                m += 1
            junk = list(range(a + m, t))
            if (len(junk) > SLIP_MAX
                    or words[toks[t].w0]["start"] - words[toks[a].w1]["end"] > REJOIN):
                continue
            if not junk or _is_slip(s, toks, words, steps, junk, t):
                steps[a:t + 1] = (
                    [Step("match", "adv" if k else "enter", k, k if k else -1, k + 1, 1.0)
                     for k in range(m)]
                    + [Step("ins", None, None, m, m, 0.0)] * len(junk)
                    + [Step(st.op, "adv" if st.q == m else "skip", st.q, m, st.state, st.g)])
                break
    return steps


def _tries(s, toks, words, steps):
    """Split the Viterbi path into tries: [(token indices, joinable)].

    Back to the first word is a fresh take, and so is coming back after
    stepping out of a try that said the address: that take is over (an
    ending redone straight away is still a restart). Any other return to
    the script is the same take going on (a restart after a flub, however
    far back, or the read resuming after an aside), unless more than
    REJOIN seconds of other talk came first. When it stepped out of the
    script to get there, the try is only joinable: find_scripts joins it
    unless another script was read in between, since a second script's
    sign-up line reads like a restart of the first one's.
    """
    n = len(s.tokens)
    tries, cur, done, last_end = [], None, False, 0.0
    for t, st in enumerate(steps):
        if st.op == "out":
            continue
        if (cur is None or (st.how in ("jump", "enter") and st.q == 0)
                or (st.how == "enter" and done)):
            cur, done = [], False
            tries.append((cur, False))
        elif st.how == "enter":
            cur = []
            tries.append((cur, words[toks[t].w0]["start"] - last_end <= REJOIN))
        cur.append(t)
        # A wrong address (a "sub") is worth redoing, so only a right one ends the take.
        done = done or (st.op == "match" and st.q == n - 1)
        last_end = words[toks[t].w1]["end"]
    return tries


def _join_tries(s, toks, words, tries, others):
    """Token groups, one per take: each joinable try joined to the one
    before it unless a take of another script (others: [(video_id,
    start)]) starts in between."""
    groups = []
    for g, join in tries:
        if groups and join:
            a = words[toks[groups[-1][-1]].w1]["end"] - BETWEEN_SLACK
            b = words[toks[g[0]].w0]["start"]
            if not any(v != s.id and a <= start < b for v, start in others):
                groups[-1] = groups[-1] + g
                continue
        groups.append(list(g))
    return groups


def _take(s, toks, words, steps, group):
    """One take: the tokens to keep, with restarts spliced and slips cut.

    A restart (a jump back in the script) replaces what was said before
    only once two script words follow in a row: until then it may be a
    flub fragment the aligner lined up with an earlier line ("the vic..."
    against "the best"). From there on the restart wins (keep the last
    continuous run); the words before that point stay as first said.
    """
    kept = []     # (token index, script position; insertions sit between)
    strays = []   # off-script runs cut from inside the take: [token indices]
    run = []
    pending = None  # a restart not yet confirmed: [(token index, position)]

    def reached(entries):
        return max((p for _, p in entries), default=-1)

    def splice(entries, at):
        # Nothing the first try never reached is dropped from the restart.
        cut = min(at, math.floor(reached(kept)) + 1)
        while kept and kept[-1][1] >= cut - 0.5:
            kept.pop()
        first = next(k for k, (_, p) in enumerate(entries) if p >= cut)
        kept.extend(entries[first:])

    for t in range(group[0], group[-1] + 1):
        st = steps[t]
        if st.op == "out":
            run.append(t)  # an aside the aligner stepped out for
            continue
        pos = st.q if st.q is not None else st.state - 0.5
        if (st.how in ("jump", "enter") and kept
                and st.q <= max(reached(kept), reached(pending or []))):
            # A restart (a newer one replaces one not yet confirmed); the
            # flub and any "sorry" before it need no mention.
            pending, run = [(t, pos)], []
            continue
        if run:
            strays.append(run)
        run = []
        if pending is None:
            kept.append((t, pos))
            continue
        pending.append((t, pos))
        (t1, p1), (t2, p2) = pending[-2], pending[-1]
        if steps[t1].op == steps[t2].op == "match" and p2 == p1 + 1:
            splice(pending, p1)
            pending = None
    if pending:
        # Never confirmed by two words in a row (one word redone, or the
        # take ends): it still wins from where it said something the first
        # try didn't (the right address after a wrong one), or if it said
        # as much of its stretch of the script (the last run wins a tie:
        # "thevic361.com... ugh. thevic361.com"), but not a fragment that
        # merely echoes it ("the vic..." against "the best part").
        have = {steps[t].q for t, _ in kept if steps[t].op == "match"}
        said = [p for t, p in pending if steps[t].op == "match"]
        better = next((p for p in said if p not in have), None)
        if better is not None:
            splice(pending, better)
        elif said:
            hi = max(p for _, p in pending)
            if len(said) >= sum(1 for p in have if said[0] <= p <= hi):
                splice(pending, said[0])
    while kept and steps[kept[-1][0]].op == "ins":
        kept.pop()  # what led into a restart that didn't hold up
    kept, slips = _cut_slips(s, toks, words, steps, kept)
    n = len(s.tokens)
    matched = [t for t, _ in kept if steps[t].op == "match"]
    stray = sum(len(r) for r in strays)
    return {
        "start": words[toks[group[0]].w0]["start"],
        "end": words[toks[group[-1]].w1]["end"],
        "coverage": len({steps[t].q for t in matched}) / n,
        # An aside cut from the middle still counts against the take.
        "similarity": 2 * len(matched) / (n + len(kept) + stray) if kept else 0.0,
        "_kept": kept,
        "_kept_words": sorted({i for t, _ in kept for i in range(toks[t].w0, toks[t].w1 + 1)}),
        "_strays": strays,
        "_slips": slips,
        "_steps": steps,
        "_toks": toks,
    }


def _is_slip(s, toks, words, steps, run, nxt):
    """Whether the off-script tokens `run`, said right before script token
    `nxt`, are a slip he corrected (see CORRECTIONS)."""
    if len(run) > SLIP_MAX:
        return False
    last = toks[run[-1]].text
    target, spoken = s.tokens[steps[nxt].q], toks[nxt].text
    if last in CORRECTIONS:
        return True
    if re.search(r"(-|\.\.\.|\u2026)$", words[toks[run[-1]].w1]["text"]):
        return True  # whisper marks a word cut off: "Cock-", "Moon..."
    if len(last) >= 2 and any(x.startswith(last) and x != last for x in (target, spoken)):
        return True
    kind = _spoken_kind(target)
    return kind is not None and any(_spoken_kind(toks[t].text) == kind for t in run)


def _cut_slips(s, toks, words, steps, kept):
    """kept without corrected slips, and the slips: [[token indices]]."""
    out, slips, i = [], [], 0
    while i < len(kept):
        j = i
        while j < len(kept) and steps[kept[j][0]].op == "ins":
            j += 1
        if j == i:
            out.append(kept[i])
            i += 1
            continue
        run = [t for t, _ in kept[i:j]]
        if j < len(kept) and _is_slip(s, toks, words, steps, run, kept[j][0]):
            slips.append(run)
        else:
            out.extend(kept[i:j])
        i = j
    return out, slips


def _overlap(a, b):
    inter = min(a["end"], b["end"]) - max(a["start"], b["start"])
    shorter = min(a["end"] - a["start"], b["end"] - b["start"])
    return inter / shorter if shorter > 0 else 0.0


def _drop_overlaps(found):
    """One stretch of audio belongs to one script. Scripts that share the
    sign-up line can clear 0.6 on each other's takes; the better fit wins."""
    ranked = sorted(((t["coverage"], t["similarity"], f["video_id"], t)
                     for f in found for t in f["takes"]), key=lambda x: (-x[0], -x[1]))
    kept = []
    for cov, sim, vid, t in ranked:
        if not any(v != vid and _overlap(t, u) > 0.5 for _, _, v, u in kept):
            kept.append((cov, sim, vid, t))
    ok = {id(x[3]) for x in kept}
    out = []
    for f in found:
        f["takes"] = [t for t in f["takes"] if id(t) in ok]
        if f["takes"]:
            out.append(f)
    return out


def _best_take(takes):
    top = max(t["coverage"] for t in takes)
    # Tristen usually gets better as he goes, so a near-tie goes to the later take.
    return max(i for i, t in enumerate(takes) if t["coverage"] >= top - TIE - 1e-9)


def _clean_words(words):
    out = []
    for w in words:
        text = str(w.get("text", w.get("word", ""))).strip()
        if not text:
            continue
        start = float(w["start"])
        end = max(start, float(w.get("end", start)))
        d = {"text": text, "start": start, "end": end}
        p = w.get("prob", w.get("probability"))
        if p is not None:
            d["prob"] = float(p)
        out.append(d)
    out.sort(key=lambda d: d["start"])
    return out


def find_scripts(words, scripts=None, video_id=None, min_coverage=MIN_COVERAGE):
    """Every take of every script in a transcript.

    Returns [{"video_id", "town", "script", "takes": [{"start", "end",
    "coverage", "similarity", ...}], "best"}] in the order the scripts were
    spoken; takes are in source order and "best" indexes the one to use.
    Keys starting with "_" are working state for plan().
    """
    words = _clean_words(words)
    lib = _library(scripts)
    if video_id is not None and not any(s.id == video_id for s in lib):
        raise KeyError(f"unknown video {video_id!r}")
    base = normalize([w["text"] for w in words])
    fill = {i for i, w in enumerate(words) if _is_filler(w["text"])}
    present = {t.text for t in base} | {_stem(t.text) for t in base}
    paths = []
    for s in lib:
        if sum(1 for t in s.vocab if t in present or _stem(t) in present) < PLAUSIBLE * len(s.vocab):
            continue  # not worth a Viterbi pass
        toks = _retokenize([t for t in base if not (t.w0 in fill and t.text not in s.vocab)], s)
        if not toks:
            continue
        steps = _recover_openings(s, toks, words, _viterbi(s, toks))
        paths.append((s, toks, steps, _tries(s, toks, words, steps)))
    # Where each script was read in one go. Every script counts here, even
    # with video_id: they tell a restart from a return after reading another.
    others = [(s.id, t["start"]) for s, toks, steps, tries in paths for g, _ in tries
              for t in [_take(s, toks, words, steps, g)] if t["coverage"] >= MIN_COVERAGE - 1e-9]
    found = []
    for s, toks, steps, tries in paths:
        if video_id is not None and s.id != video_id:
            continue
        takes = [_take(s, toks, words, steps, g) for g in _join_tries(s, toks, words, tries, others)]
        takes = [t for t in takes if t["coverage"] >= min_coverage - 1e-9]
        if takes:
            found.append({"video_id": s.id, "town": s.town, "script": s, "takes": takes})
    found = _drop_overlaps(found)
    for f in found:
        f["best"] = _best_take(f["takes"])
    found.sort(key=lambda f: f["takes"][f["best"]]["start"])
    return found


# --- the cut and the timeline ------------------------------------------------

def _cut(words, kept):
    """Source segments for the kept word indices."""
    keep = set(kept)
    segs, prev = [], None
    for i in kept:
        s, e = words[i]["start"], words[i]["end"]
        lo, hi = s - PAD_BEFORE, e + PAD_AFTER
        # Never pad into a word we cut (a filler, a flub, another take).
        if i > 0 and i - 1 not in keep:
            lo = max(lo, min(s, words[i - 1]["end"]))
        if i + 1 < len(words) and i + 1 not in keep:
            hi = min(hi, max(e, words[i + 1]["start"]))
        lo = max(lo, 0.0)
        if prev is not None:
            pe = words[prev]["end"]
            if i == prev + 1 and s - pe <= LONG_GAP:
                segs[-1][1] = max(segs[-1][1], hi)  # a natural pause stays whole
                prev = i
                continue
            if s - pe > LONG_GAP:
                # Shrink the pause to GAP_TO: the full lead-in, the rest as tail.
                segs[-1][1] = min(segs[-1][1], pe + max(0.0, GAP_TO - (s - lo)))
            lo = max(lo, segs[-1][1])
        segs.append([lo, hi])
        prev = i
    merged = []
    for a, b in segs:
        if merged and a - merged[-1][1] < MERGE_UNDER:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    # A word whisper pinned to an instant, between two cut words that touch
    # it, has nothing left to keep; an empty segment would stop the render.
    return [x for x in merged if x[1] - x[0] > 1e-3]


def _mapper(segs, speed):
    """Source time -> output time. Times inside a cut snap to the next kept frame."""
    offs, acc = [], 0.0
    for a, b in segs:
        offs.append(acc)
        acc += b - a

    def f(x):
        for (a, b), o in zip(segs, offs):
            if x <= a:
                return o / speed
            if x <= b:
                return (o + x - a) / speed
        return acc / speed
    return f


def _cue_hit(norm, cues):
    return bool(norm & cues)


def _word_norms(words):
    """Per source word, every normalized form that can trigger a cue."""
    norms = [set() for _ in words]
    for t in normalize([w["text"] for w in words]):
        for i in range(t.w0, t.w1 + 1):
            norms[i].add(t.text)
    for i, w in enumerate(words):
        norms[i].add("".join(_pieces(w["text"])))  # Howl-o-ween -> howloween
        norms[i] |= {_stem(x) for x in norms[i]}
        norms[i].discard("")
    return norms


def _layout(s, cta, words, kept, segs, speed, dom_word, norms, dom_frac=0.0, aligned=None,
            phone_cues=frozenset()):
    """Words, hook, chips, CTA, phone and end card on the output timeline.
    dom_frac: how far into its first word the address starts (whisper
    glued "Free" onto it). aligned: per kept word, the script words the
    aligner lined it up with (so a misheard cue still places its chip)."""
    aligned = aligned or {}
    f = _mapper(segs, speed)
    out = []
    for i in kept:
        a = f(words[i]["start"])
        out.append({"text": words[i]["text"], "start": a, "end": max(a, f(words[i]["end"]))})
    speech_end = out[-1]["end"]
    notes = []
    k_of = {i: k for k, i in enumerate(kept)}
    # The aligner's word for it too: whisper glues "Signup" into one word.
    cta_ks = [k for k, i in enumerate(kept)
              if _cue_hit(norms[i], cta) or aligned.get(i, frozenset()) & cta]
    dom_k = k_of.get(dom_word)
    # Chips are events, said before the sign-up line.
    limit = cta_ks[-1] if cta_ks else (dom_k if dom_k is not None else len(out))
    appeared, after = [], -1
    for chip, cues in zip(s.video.get("chips", []), s.cues):
        hit = next((k for k in range(after + 1, limit) if _cue_hit(norms[kept[k]], cues)), None)
        if hit is None:
            # Whisper misheard the cue ("Hucky" for "Hockey"), but the word
            # said in its place is known.
            hit = next((k for k in range(after + 1, limit)
                        if aligned.get(kept[k], frozenset()) & cues), None)
            if hit is not None:
                notes.append('chip "%s" placed on "%s", said where its cue (%s) belongs'
                             % (chip["text"], out[hit]["text"], ", ".join(chip.get("cue", []))))
        if hit is None:
            notes.append('chip "%s" dropped: none of its cue words (%s) was said'
                         % (chip["text"], ", ".join(chip.get("cue", []))))
            continue
        appeared.append((chip, hit))
        after = hit
    cta_k = next((k for k in cta_ks if k > after), None)
    if cta_k is not None:
        cta_start = out[cta_k]["start"]
    else:
        cta_start = max(0.0, speech_end - CTA_FALLBACK)
        if appeared:  # keep the last chip up for a second at least
            cta_start = max(cta_start, min(speech_end, out[appeared[-1][1]]["start"] + 1.0))
        notes.append("no sign-up line heard (cue: %s); the CTA is placed %.0f s before the end"
                     % (", ".join(sorted(cta)), CTA_FALLBACK))
    if dom_k is not None:
        ec_start = out[dom_k]["start"] + dom_frac * (out[dom_k]["end"] - out[dom_k]["start"])
    else:
        ec_start = max(0.0, speech_end - END_FALLBACK)
        notes.append("the web address was not heard; the end card starts %.1f s before the end"
                     % END_FALLBACK)
    ec_end = max(speech_end + END_TAIL, ec_start + END_MIN)
    chips = []
    for j, (chip, k) in enumerate(appeared):
        end = out[appeared[j + 1][1]]["start"] if j + 1 < len(appeared) else cta_start
        chips.append({"text": chip["text"], "start": out[k]["start"], "end": end,
                      **{f: chip[f] for f in CARD_FIELDS if chip.get(f) not in (None, "")}})
    hook_end = HOOK_MAX if not chips else min(chips[0]["start"] - HOOK_LEAD, HOOK_MAX)
    # The phone: the first of its cue words said after the cards and the
    # hook, before the address.
    phone = None
    if phone_cues:
        stop = dom_k if dom_k is not None else len(out)
        k = next((k for k in range(after + 1, stop) if out[k]["start"] >= max(hook_end, HOOK_MIN) - 1e-9
                  and (_cue_hit(norms[kept[k]], phone_cues) or aligned.get(kept[k], frozenset()) & phone_cues)),
                 None)
        if k is not None and min(out[k]["start"] + PHONE_SECONDS, ec_start) - out[k]["start"] >= PHONE_MIN:
            phone = (out[k]["start"], min(out[k]["start"] + PHONE_SECONDS, ec_start))
        elif k is None:
            notes.append("no phone: none of its cue words (%s) was said after the cards"
                         % ", ".join(sorted(phone_cues)))
    return {
        "words": out,
        "start_of": {i: out[k]["start"] for i, k in k_of.items()},
        "speech_end": speech_end,
        "hook": {"text": s.video.get("hook", ""), "start": 0.0, "end": max(hook_end, HOOK_MIN)},
        "chips": chips,
        "cta_start": cta_start,
        "phone": phone,
        "end_card": (ec_start, ec_end),
        "duration": ec_end,
        "notes": notes,
    }


def _fit_speed(lay):
    """The smallest speed (to the thousandth) that fits TARGET, at most MAX_SPEED."""
    if lay(1.0)["duration"] <= TARGET + 1e-9:
        return 1.0
    if lay(MAX_SPEED)["duration"] > TARGET:
        return MAX_SPEED
    lo, hi = 1.0, MAX_SPEED
    while hi - lo > 1e-5:
        mid = (lo + hi) / 2
        if lay(mid)["duration"] <= TARGET:
            hi = mid
        else:
            lo = mid
    return min(MAX_SPEED, math.ceil(hi * 1000 - 1e-6) / 1000)


def _diff(s, take, at, speech_end):
    """Script vs what was kept, from the alignment itself, so the diff and
    the coverage can't disagree. Fuzzy matches count as said."""
    toks, steps = take["_toks"], take["_steps"]
    S = s.tokens
    out, nxt, prev = [], 0, None

    def add(kind, script, spoken, when):
        nonlocal prev
        if out and prev == kind and kind != "omit":
            out[-1]["script"] = (out[-1]["script"] + " " + script).strip()
            out[-1]["spoken"] = (out[-1]["spoken"] + " " + spoken).strip()
        else:
            out.append({"kind": kind, "script": script, "spoken": spoken, "at": when})
        prev = kind

    for t, _ in take["_kept"]:
        st, when = steps[t], at(toks[t].w0)
        if st.q is not None and st.q > nxt:
            add("omit", " ".join(S[nxt:st.q]), "", when)
        if st.op == "match":
            prev = None
        elif st.op == "sub":
            add("substitute", S[st.q], toks[t].text, when)
        else:
            add("insert", "", toks[t].text, when)
        if st.q is not None:
            nxt = max(nxt, st.q + 1)
    if nxt < len(S):
        add("omit", " ".join(S[nxt:]), "", speech_end)
    return out


_KIND_ORDER = ("day", "number", "domain", "name")
_HEADS = {
    "substitute": {"day": "Wrong day?", "number": "Wrong number?",
                   "domain": "Wrong web address?", "name": "Wrong name?"},
    "omit": {"day": "Missing day.", "number": "Missing number.",
             "domain": "Missing web address.", "name": "Missing name."},
    "insert": {"day": "Extra day.", "number": "Extra number.",
               "domain": "Extra web address.", "name": "Extra name."},
}


def _diff_warnings(s, diff):
    """A wrong day in an ad is the worst failure, so every day, number,
    address or chip name that differs is called out by itself."""
    out = []
    for d in diff:
        kinds = set()
        if d["kind"] != "insert":
            kinds.update(s.kind(t) for t in d["script"].split())
        if d["kind"] != "omit":
            kinds.update(_spoken_kind(t) for t in d["spoken"].split())
        kinds.discard(None)
        if not kinds:
            continue
        head = _HEADS[d["kind"]][next(k for k in _KIND_ORDER if k in kinds)]
        if d["kind"] == "substitute":
            out.append('%s At %.1fs heard "%s" where the script says "%s".'
                       % (head, d["at"], d["spoken"], d["script"]))
        elif d["kind"] == "omit":
            out.append('%s At %.1fs "%s" was not said.' % (head, d["at"], d["script"]))
        else:
            out.append('%s At %.1fs heard "%s", which is not in the script.'
                       % (head, d["at"], d["spoken"]))
    return out


def _lead_frac(take, text, t_addr):
    """Share of the address's first word taken by words whisper glued in
    front of it ("Freethevic361": "free" is about a third)."""
    toks = take["_toks"]
    a = toks[t_addr].w0
    lead = [toks[t].text for t, _ in take["_kept"] if t < t_addr and toks[t].w0 == a == toks[t].w1]
    if not lead:
        return 0.0
    total = len(re.sub(r"[^A-Za-z0-9]", "", text)) or 1
    return min(0.9, sum(len(x) for x in lead) / total)


def _match_case(text, ref, at_start):
    """Whisper's word with the script's first-letter case (it sometimes
    title-cases a whole read, or lowercases a venue)."""
    a = next((j for j, c in enumerate(text) if c.isalnum()), None)
    b = next((c for c in ref if c.isalnum()), None)
    if a is None or b is None or not text[a].isalpha() or not b.isalpha():
        return text
    if b.islower() and text[a].isupper() and not at_start and not text[a:].isupper():
        return text[:a] + text[a].lower() + text[a + 1:]
    if b.isupper() and text[a].islower():
        return text[:a] + text[a].upper() + text[a + 1:]
    return text


def _misheard(s, take, kept, by_word, texts):
    """Kept words whisper misspelled but the aligner still matched ("trunk
    retreats" for "trunk-or-treats", "Calaveres"): {first word index:
    (last word index, the script's words)}. A word heard as a different
    one (a substitution) is not here: that one stays as spoken."""
    toks, steps = take["_toks"], take["_steps"]
    script_words, bent = {}, set()
    for i in kept:
        ts = by_word.get(i, [])
        if ts and all(steps[t].op == "match" and not _is_address(toks[t].text) for t in ts):
            script_words[i] = {s.word_of[steps[t].q] for t in ts}
            base = [x.text for x in normalize([texts[i]])]
            # Spelled close to a script word (0.7), or one word for a run.
            if any(steps[t].g < 0.9 for t in ts) or (
                    len(base) == 1 and base[0] not in s.vocab and base[0] not in s.runs
                    and s.fuzzy_run(base[0])):
                bent.add(i)
    out, k = {}, 0
    while k < len(kept):
        i = kept[k]
        span, sw = [i], set(script_words.get(i) or ())
        while (sw and k + len(span) < len(kept) and kept[k + len(span)] == span[-1] + 1
               and sw & (script_words.get(span[-1] + 1) or set())):
            span.append(span[-1] + 1)
            sw |= script_words[span[-1]]
        k += len(span)
        if not (bent & set(span)) or max(sw) - min(sw) + 1 != len(sw):
            continue
        said = {steps[t].q for i2 in span for t in by_word[i2]}
        if said == {q for q, j in enumerate(s.word_of) if j in sw}:
            out[span[0]] = (span[-1], " ".join(s.say_words[j] for j in sorted(sw)))
    return out


def _captions(s, take, kept, out_words):
    """Caption entries for the kept words: the address as one entry, spelled
    right ("Freethavoc361" + ".com." would be an embarrassing caption), a
    word whisper misspelled as the script spells it, and the script's
    capitalization where whisper's differs."""
    toks, steps = take["_toks"], take["_steps"]
    by_word = {}
    for t, _ in take["_kept"]:
        for i in range(toks[t].w0, toks[t].w1 + 1):
            by_word.setdefault(i, []).append(t)
    k_of = {i: k for k, i in enumerate(kept)}
    fixed = _misheard(s, take, kept, by_word, {i: out_words[k]["text"] for k, i in enumerate(kept)})
    caps, skip = [], set()
    for k, i in enumerate(kept):
        if i in skip:
            continue
        w, ts = out_words[k], by_word.get(i, [])
        if i in fixed:
            last, text = fixed[i]
            skip.update(range(i, last + 1))
            caps.append({"text": text, "start": w["start"], "end": out_words[k_of[last]]["end"]})
            continue
        addr = next((t for t in ts if _is_address(toks[t].text) and toks[t].w0 == i), None)
        if addr is not None:
            last = toks[addr].w1
            skip.update(range(i, last + 1))
            end = out_words[k_of[last]]["end"] if last in k_of else w["end"]
            start = w["start"]
            frac = _lead_frac(take, w["text"], addr)
            if frac:
                split = start + frac * (w["end"] - start)
                lead = " ".join(toks[t].text for t in ts if t < addr and toks[t].w1 == i)
                caps.append({"text": _match_case(lead, w["text"], True), "start": start, "end": split})
                start = split
            caps.append({"text": toks[addr].text, "start": start, "end": end})
            continue
        text = w["text"]
        if caps and kept[k - 1] == i - 1 and re.match(r"-\w|[,.]\d", text):
            # Whisper's fragments of one word: "Howl" "-O" "-Ween", "$1" ",000".
            caps[-1]["text"] += text
            caps[-1]["end"] = w["end"]
            continue
        m = next((t for t in ts if steps[t].op == "match" and steps[t].g >= 0.9), None)
        if m is not None:
            at_start = not caps or caps[-1]["text"].endswith((".", "!", "?", ":"))
            text = _match_case(text, s.say_words[s.word_of[steps[m].q]], at_start)
        caps.append({"text": text, "start": w["start"], "end": w["end"]})
    return caps


def _r(x):
    return round(float(x), 3)


def _build_plan(source, words, norms, found, data, forced=False):
    s, take = found["script"], found["takes"][found["best"]]
    toks, steps = take["_toks"], take["_steps"]
    kept = take["_kept_words"]
    segs = _cut(words, kept)
    dom = [t for t, _ in take["_kept"] if _is_address(toks[t].text)]
    dom_word = toks[dom[-1]].w0 if dom else None
    dom_frac = _lead_frac(take, words[dom_word]["text"], dom[-1]) if dom else 0.0
    cta = _cue_set(data.get("cta_cue", ["sign"]))
    phone_cues = _cue_set(data.get("phone_cue") or [])

    aligned = {}
    for t, _ in take["_kept"]:
        if steps[t].q is not None:
            for i in range(toks[t].w0, toks[t].w1 + 1):
                aligned.setdefault(i, set()).add(s.tokens[steps[t].q])

    def lay(speed):
        return _layout(s, cta, words, kept, segs, speed, dom_word, norms, dom_frac, aligned, phone_cues)

    speed = _fit_speed(lay)
    L = lay(speed)
    diff = _diff(s, take, lambda i: L["start_of"].get(i, L["speech_end"]), L["speech_end"])
    for d in diff:
        d["at"] = _r(d["at"])

    warnings = []
    if s.video.get("draft"):
        warnings.append("%s is still a draft in scripts.json; check the events before posting"
                        % s.id)
    if forced:
        warnings.append("only %.0f%% of the script was found; it was used because --video "
                        "named it" % (100 * take["coverage"]))
    warnings += _diff_warnings(s, diff)
    for t, _ in take["_kept"]:
        st = steps[t]
        # Days only: whisper is sure of a day it heard (0.9+ on every
        # fixture), while "8" vs "eight" splits its confidence on numbers
        # and odd spellings sink it on the address, both even when right.
        if st.op != "match" or s.kind(s.tokens[st.q]) != "day":
            continue
        w = words[toks[t].w0]
        if w.get("prob") is not None and w["prob"] < LOW_PROB:
            warnings.append('Check "%s" at %.1fs: whisper was only %.0f%% sure of it.'
                            % (w["text"], L["start_of"][toks[t].w0], 100 * w["prob"]))
    for run in take["_strays"]:
        idx = sorted({i for t in run for i in range(toks[t].w0, toks[t].w1 + 1)})
        nxt = next((i for i in kept if i > idx[-1]), None)
        warnings.append('Cut %d word%s that %s not in the script at %.1fs: "%s"'
                        % (len(idx), "" if len(idx) == 1 else "s", "is" if len(idx) == 1 else "are",
                           L["start_of"].get(nxt, L["speech_end"]),
                           " ".join(words[i]["text"] for i in idx)))
    for run in take["_slips"]:
        # A stutter needs no mention; a day, number or address taken out does.
        if any(_spoken_kind(toks[t].text) for t in run):
            idx = sorted({i for t in run for i in range(toks[t].w0, toks[t].w1 + 1)})
            nxt = next((i for i in kept if i > idx[-1]), None)
            warnings.append('Cut "%s" at %.1fs: said, then corrected right after.'
                            % (" ".join(words[i]["text"] for i in idx),
                               L["start_of"].get(nxt, L["speech_end"])))
    if take["similarity"] < SIMILARITY_WARN:
        warnings.append("similarity %.2f: this take strays from the script; read the diff"
                        % take["similarity"])
    warnings += L["notes"]
    if speed > 1.0:
        warnings.append("sped up %.3fx to fit %.0f s" % (speed, TARGET))
    if L["duration"] > HARD_MAX:
        warnings.append("runs %.1f s even at %.2fx (limit %.1f s): cut a line or re-film"
                        % (L["duration"], speed, HARD_MAX))

    town = towns.town(s.town)
    ec = data.get("end_card", {})

    def fill(text):
        return str(text).replace("{city}", town["city"]).replace("{domain}", town["domain"])

    return {
        "video_id": s.id,
        "town": s.town,
        "source": source,
        "similarity": _r(take["similarity"]),
        "takes": [{"start": _r(t["start"]), "end": _r(t["end"]), "coverage": _r(t["coverage"])}
                  for t in found["takes"]],
        "take": found["best"],
        "segments": [{"start": _r(a), "end": _r(b)} for a, b in segs],
        "speed": speed,
        "duration": _r(L["duration"]),
        "speech_end": _r(L["speech_end"]),
        "words": [{"text": w["text"], "start": _r(w["start"]), "end": _r(w["end"])}
                  for w in _captions(s, take, kept, L["words"])],
        "hook": {"text": L["hook"]["text"], "start": 0.0, "end": _r(L["hook"]["end"])},
        "chips": [{"text": c["text"], "start": _r(c["start"]), "end": _r(c["end"]),
                   **{f: c[f] for f in CARD_FIELDS if f in c}} for c in L["chips"]],
        "cta_start": _r(L["cta_start"]),
        "phone": {"start": _r(L["phone"][0]), "end": _r(L["phone"][1])} if L["phone"] else None,
        "end_card": {"start": _r(L["end_card"][0]), "end": _r(L["end_card"][1]),
                     "line1": ec.get("line1", ""),
                     "line2": ec.get("line2", "{domain}").format(domain=town["domain"]),
                     **{f: fill(ec[f]) for f in END_CARD_FIELDS if ec.get(f)}},
        "diff": diff,
        "warnings": warnings,
    }


def _load_transcript(transcript):
    if isinstance(transcript, (str, bytes, os.PathLike)):
        with open(transcript, encoding="utf-8") as f:
            transcript = json.load(f)
    if isinstance(transcript, dict):
        # Ours ({"words": [...]}) or whisper's own ({"segments": [{"words": [...]}]}).
        if "words" not in transcript and "segments" in transcript:
            return [w for seg in transcript["segments"] for w in seg.get("words") or ()]
        transcript = transcript.get("words", [])
    return transcript


def plan(source_path, video_id=None, transcript=None, model=DEFAULT_MODEL, scripts=None):
    """Plans for every script found in source_path (see the module docstring).

    transcript: word dicts or a JSON file of them (skips whisper).
    video_id: plan only that script; if its takes fall short of the usual
    coverage bar, the best one still gets a plan, with a warning.
    """
    source = os.path.abspath(source_path)
    data = scripts if scripts is not None else load_scripts()
    if video_id is not None and video_id not in {v["id"] for v in data["videos"]}:
        raise KeyError(f"unknown video {video_id!r}")  # before half a minute of whisper
    words = _clean_words(_load_transcript(transcript) if transcript is not None
                         else transcribe(source, model=model, scripts=data))
    found = find_scripts(words, scripts=data, video_id=video_id)
    forced = False
    if not found and video_id is not None:
        found = find_scripts(words, scripts=data, video_id=video_id, min_coverage=FORCED_COVERAGE)
        forced = bool(found)
    norms = _word_norms(words)
    return [_build_plan(source, words, norms, f, data, forced) for f in found]


# --- transcription -----------------------------------------------------------

_PRIMER = "Um, uh, okay, so."  # whisper keeps fillers it has seen in the prompt
# Whisper reads at most the last 223 prompt tokens; these names run ~3 chars
# a token, so this leaves room.
PROMPT_CHARS = 680
# Sentence starters that aren't names.
_PROMPT_SKIP = frozenset("sign plus free yes your the a and halloween".split())
# Words whisper spells right by itself: a name made only of these ("Hot Rod
# Riot") isn't worth prompt room. A name missing here just costs a few tokens.
_COMMON = frozenset("""
a after an and aquarium art at auditorium band beach big boat boo club cocktails comedy court
dark dash elm farm fest festival fields first fright frights grove halloween heights hockey
horror hot hunt in lights los mechanics mount muscle nightmare of on riot rock rocky rod royal
scary sharks songwriters stars street sword talent terrors the valley walk wicked zoo""".split())
_LINKS = frozenset("and of los".split())


def _name_phrases(say):
    """Capitalized runs in a script ("Hasta los Huesos Fest", "Rogue X"),
    minus sentence starters, days and runs of everyday words."""
    words = say.split()
    out, cur = [], []

    def close():
        while cur and cur[-1].lower() in _LINKS:
            cur.pop()
        if any(w.lower() not in _COMMON for w in cur):
            out.append(" ".join(cur))
        cur.clear()

    for k, raw in enumerate(words):
        w = re.sub(r"'s$", "", re.sub(r"^[^\w$]+|[^\w]+$", "", raw.translate(_QUOTES)))
        low = w.lower()
        starts = k == 0 or words[k - 1].endswith((".", "!", "?"))
        if w[:1].isupper() and not _is_day(low) and not (starts and low in _PROMPT_SKIP):
            if cur or low not in ("the", "a"):
                cur.append(w)
        elif cur and low in _LINKS:
            cur.append(w)
        else:
            close()
        if raw.endswith((",", ".", ":", ";", "!", "?")):
            close()
    close()
    return out


def whisper_prompt(scripts=None):
    """Spellings whisper can't guess: event and venue names, the towns and
    the five web addresses. Most important last, since whisper drops the
    beginning of an overlong prompt (and so does the budget here)."""
    data = scripts if scripts is not None else load_scripts()
    seen = set()

    def fresh(x):
        if x.lower() in seen:
            return False
        seen.add(x.lower())
        return True

    places = [x for x in (t["city"].replace("the ", "") for t in towns.TOWNS.values()) if fresh(x)]
    names = [p for v in data["videos"] for p in _name_phrases(v["say"]) if fresh(p)]
    tail = ", ".join(places) + ". " + ", ".join(sorted(DOMAINS)) + "."
    budget = PROMPT_CHARS - len(_PRIMER) - len(tail) - 4
    body = []
    for x in reversed(names):
        if len(x) + 2 > budget:
            break
        body.append(x)
        budget -= len(x) + 2
    body.reverse()
    return "%s %s. %s" % (_PRIMER, ", ".join(body), tail)


def _cache_dir():
    base = os.environ.get("VIDEO_EDIT_CACHE") or os.path.join(
        os.path.expanduser("~"), ".cache", "video-edit")
    return os.path.join(base, "transcripts")


def _sha1(path):
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _audio_stream(src):
    """Index of the first audio stream ffmpeg can decode. New iPhones put
    an APAC (spatial audio) track next to the AAC one, and ffmpeg can't
    read APAC."""
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a",
                            "-show_entries", "stream=index,codec_name", "-of", "json", src],
                           capture_output=True, text=True, timeout=60, check=True)
        streams = json.loads(r.stdout).get("streams", [])
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    good = [x for x in streams if x.get("codec_name", "").startswith(
        ("aac", "alac", "mp3", "opus", "vorbis", "flac", "pcm_"))]
    pick = (good or streams or [None])[0]
    return pick["index"] if pick else None


def _extract_audio(src, dst):
    idx = _audio_stream(src)
    cmd = ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", src,
           "-map", "0:%d" % idx if idx is not None else "0:a:0",
           "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-c:a", "pcm_s16le", dst]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    if r.returncode != 0:
        raise RuntimeError("ffmpeg could not read the audio of %s: %s"
                           % (src, r.stderr.strip()[-400:]))


def _read_wav(path):
    import numpy as np  # comes with faster-whisper
    with wave.open(path, "rb") as f:
        pcm = f.readframes(f.getnframes())
    return np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0


CHUNK_MAX = 28.0       # seconds; whisper's window is 30
LONG_SILENCE = 3.0     # silences longer than this are skipped...
SILENCE_PAD = 0.75     # ...keeping this much on each side


def _chunks(total, regions, sr=SAMPLE_RATE):
    """Sample ranges of at most ~28 s, split in the middle of pauses.

    With condition_on_previous_text off (so restarts aren't smoothed away),
    faster-whisper applies initial_prompt to the first 30 s window only;
    transcribing each chunk on its own gives every take the spellings. A
    chunk ends at its widest pause, not the last one before the limit (a
    breath mid-sentence). Only silences over 3 s are skipped, padded, so
    short words the VAD misses still reach whisper.
    """
    if total <= CHUNK_MAX * sr:
        return [(0, total)]
    limit = int(CHUNK_MAX * sr)
    if not regions:
        return [(a, min(total, a + limit)) for a in range(0, total, limit)]
    pad, long_gap = int(SILENCE_PAD * sr), int(LONG_SILENCE * sr)
    spans = [(int(s * sr), int(e * sr)) for s, e in regions]
    a = 0 if spans[0][0] <= long_gap else spans[0][0] - pad
    chunks, gaps, last = [], [], spans[0][1]
    for s, e in spans[1:]:
        if s - last > long_gap:
            chunks.append((a, min(total, last + pad)))
            a, gaps = s - pad, []
        else:
            gaps.append((last, s))
            if e - a > limit and gaps:
                late = [g for g in gaps if (g[0] + g[1]) // 2 - a >= limit // 3] or gaps
                g = max(late, key=lambda g: g[1] - g[0])
                mid = (g[0] + g[1]) // 2
                chunks.append((a, mid))
                a, gaps = mid, [x for x in gaps if x[0] >= mid]
        last = max(last, e)
    chunks.append((a, total if total - last <= long_gap else min(total, last + pad)))
    return [(max(0, x), y) for x, y in chunks if y > x]


_MODELS = {}


def _model(name):
    m = _MODELS.get(name)
    if m is None:
        from faster_whisper import WhisperModel
        kw = {"device": "cpu", "compute_type": "int8", "cpu_threads": os.cpu_count() or 4}
        try:
            m = WhisperModel(name, local_files_only=True, **kw)  # setup.sh fetched it
        except Exception:  # noqa: BLE001 - not cached yet: download it once
            m = WhisperModel(name, **kw)
        _MODELS[name] = m
    return m


def _settings(prompt):
    return {"language": "en", "beam_size": 5, "word_timestamps": True,
            "condition_on_previous_text": False, "vad_filter": False,
            "initial_prompt": prompt}


REFINE = "vad7"        # chunking + word-boundary version (part of the cache key)
REFINE_MIN = 0.1       # a smaller speech overlap means the VAD missed a quiet word
REFINE_JOIN = 0.25     # speech bits this close inside one word belong to it
SEC_PER_CHAR = 0.065   # a brisk read, ~15 letters a second
FRAME = 0.01           # energy frame hop, seconds
QUIET_DB = 8.0         # this far above the noise floor still counts as silence
VALLEY_DB = 15.0       # a dip this deep below both sides is a break between words
SPEECH_DB = 25.0       # within this of the median is a word's own sound, not a breath


def _speech_regions(audio):
    """Speech stretches in seconds (Silero VAD, tuned to see ~0.15 s pauses)."""
    try:
        from faster_whisper.vad import VadOptions, get_speech_timestamps
        speech = get_speech_timestamps(audio, VadOptions(
            threshold=0.35, min_silence_duration_ms=150, speech_pad_ms=40,
            min_speech_duration_ms=50))
    except Exception:  # noqa: BLE001 - without a VAD whisper's times stand
        return []
    # Silero's sample counts are numpy ints; plain floats keep the words
    # transcribe() returns the same whether or not they came from the cache.
    return [(float(s["start"]) / SAMPLE_RATE, float(s["end"]) / SAMPLE_RATE) for s in speech]


def _refine(words, regions, energy=None):
    """Trim each word to the speech inside it.

    Whisper's word times stretch over silence: the first word of a file
    often starts at 0.0, and a word after a pause swallows the pause ("and"
    13.44-14.88 around 0.3 s of speech). Left alone, the cut keeps that dead
    air however hard it shrinks the gaps between words. A word the VAD
    barely saw (a quiet "a") keeps whisper's times. Then squashed words get
    their length back (_uncollapse) and the edges move to the real breaks
    between words (_snap, with the take's _Energy).
    """
    out = []
    for w in words:
        a, b = w["start"], w["end"]
        ov = [(max(a, s), min(b, e)) for s, e in regions if s < b and e > a]
        if ov:
            k = max(range(len(ov)), key=lambda j: ov[j][1] - ov[j][0])
            lo = hi = k
            while lo > 0 and ov[lo][0] - ov[lo - 1][1] <= REFINE_JOIN:
                lo -= 1
            while hi + 1 < len(ov) and ov[hi + 1][0] - ov[hi][1] <= REFINE_JOIN:
                hi += 1
            na, nb = ov[lo][0], ov[hi][1]
            if nb - na >= REFINE_MIN or nb - na >= 0.3 * (b - a):
                w = dict(w, start=round(na, 3), end=round(nb, 3))
        out.append(w)
    return _snap(_uncollapse(out, regions), energy)


def _uncollapse(words, regions):
    """Give back the length of words whisper squashed to (nearly) nothing.

    Its alignment sometimes pins a whole word to an instant ("Thursday,"
    7.98-7.98 for speech at 7.5-7.95); the cut would then keep a 0.12 s
    sliver of a day name. The word grows back toward the speech just before
    it (where it nearly always is), never past the previous word or the
    start of that stretch of speech; failing room there, forward.
    """
    out = [dict(w) for w in words]
    for i, w in enumerate(out):
        expect = SEC_PER_CHAR * len(re.sub(r"[^A-Za-z0-9]", "", w["text"]))
        if expect < 0.2 or w["end"] - w["start"] >= 0.4 * expect:
            continue
        floor = out[i - 1]["end"] if i else 0.0
        reg = next(((s, e) for s, e in regions if s <= w["end"] <= e), None)
        if reg:
            floor = max(floor, reg[0])
        start = max(floor, w["end"] - expect)
        if w["end"] - start >= 0.5 * expect:
            w["start"] = round(min(start, w["start"]), 3)
            continue
        ceil = out[i + 1]["start"] if i + 1 < len(out) else w["start"] + expect
        if reg:
            ceil = min(ceil, reg[1])
        w["end"] = round(max(w["end"], min(ceil, w["start"] + expect)), 3)
    return out


class _Energy:
    """Frame energy of a take (10 ms hop): where one word ends and the next
    begins, and how far a word's own sound reaches.

    Two levels: quiet (room tone, within QUIET_DB of the floor) finds the
    breaks; speech (within SPEECH_DB of the median) is what a word may grow
    over, so a breath or a decay isn't mistaken for part of a word.
    """

    def __init__(self, db):
        self.db = [float(x) for x in db]
        srt = sorted(self.db)
        floor, median = srt[len(srt) // 20], srt[len(srt) // 2]
        # A take with no silence at all has a high "floor": never call
        # anything within 15 dB of the median quiet.
        self.quiet = min(floor + QUIET_DB, median - 15)
        self.speech = max(self.quiet, median - SPEECH_DB)
        self.breaks = self._breaks()

    @classmethod
    def of(cls, audio):
        import numpy as np
        hop = int(FRAME * SAMPLE_RATE)
        n = len(audio) // hop - 1
        if n < 10:
            return None
        frames = np.lib.stride_tricks.sliding_window_view(audio, 2 * hop)[::hop][:n]
        return cls(10 * np.log10(np.mean(frames.astype(np.float64) ** 2, axis=1) + 1e-12))

    def _breaks(self):
        """Silences of 20 ms or more as (start, end), and deep dips between
        sounds as (t, t): "um" fading into "spooky" never reaches the
        room-tone floor, but drops 25 dB below both sides for an instant."""
        db, n = self.db, len(self.db)
        runs, run = [], None
        for i in range(n + 1):
            if i < n and db[i] < self.quiet:
                run = i if run is None else run
            elif run is not None:
                if i - run >= 2:
                    s, e = round((run + 0.5) * FRAME, 3), round((i + 0.5) * FRAME, 3)
                    if runs and s - runs[-1][1] <= 0.05:
                        runs[-1] = (runs[-1][0], e)  # one noise blip doesn't end a pause
                    else:
                        runs.append((s, e))
                run = None
        out = list(runs)
        w = int(0.15 / FRAME)
        for i in range(2, n - 2):
            if (db[i] >= self.quiet and db[i] <= db[i - 1] and db[i] <= db[i + 1]
                    and db[i] < db[i - 2] and db[i] < db[i + 2]):
                side = min(max(db[max(0, i - w):i]), max(db[i + 1:i + 1 + w]))
                if side - db[i] >= VALLEY_DB:
                    t = round((i + 1) * FRAME, 3)
                    out.append((t, t))
        return sorted(out)

    def _frame(self, t):
        return min(len(self.db) - 1, max(0, int(round(t / FRAME)) - 1))

    def reach(self, t, limit):
        """How far speech runs from t toward limit (either direction),
        over dips of up to 60 ms (stop closures), never past limit."""
        step = 1 if limit > t else -1
        i, end, best, dip = self._frame(t), self._frame(limit), t, 0
        while i != end:
            i += step
            if self.db[i] >= self.speech:
                dip, best = 0, (i + 1 + 0.5 * step) * FRAME
            else:
                dip += 1
                if dip > 6:
                    break
        return min(best, limit) if step > 0 else max(best, limit)


def _snap(words, energy):
    """Move word edges out to the real break between them.

    Whisper puts onsets late and squashes fillers ("um" 10.84-10.88 for
    sound at 10.68-11.02, then "spooky" from 11.28 though its "s" starts at
    11.08), so a lead-in measured from its times clips the word after a cut
    filler. In each gap, the break nearest the middle (a stop closure inside
    a word is usually off-center) bounds both words, and each grows over
    its own speech up to it (reach() crosses a stop closure, never a pause
    or a breath), so pauses still get shortened; words only grow, so kept
    speech is never clipped.
    """
    if energy is None or not energy.breaks:
        return words
    out = [dict(w) for w in words]
    for a, b in zip(out, out[1:]):
        lo, hi = a["end"] - 0.03, b["start"] + 0.03
        if hi - lo < 0.05:
            continue
        mid = (a["end"] + b["start"]) / 2
        cands = [(s, e) for s, e in energy.breaks if s >= lo and e <= hi]
        if not cands:
            continue
        s, e = min(cands, key=lambda x: abs((x[0] + x[1]) / 2 - mid))
        if s > a["end"]:
            a["end"] = round(energy.reach(a["end"], s), 3)
        if e < b["start"]:
            b["start"] = round(max(energy.reach(b["start"], e), a["end"]), 3)
    return out


def _run_whisper(wav, model, prompt):
    audio = _read_wav(wav)
    regions = _speech_regions(audio)
    m = _model(model)
    words = []
    for a, b in _chunks(len(audio), regions):
        segments, _ = m.transcribe(audio[a:b], **_settings(prompt))
        off = a / SAMPLE_RATE
        for seg in segments:
            for w in seg.words or ():
                text = w.word.strip()
                if text:
                    words.append({"text": text, "start": round(float(w.start) + off, 3),
                                  "end": round(float(w.end) + off, 3),
                                  "prob": round(float(w.probability), 3)})
    return _refine(words, regions, _Energy.of(audio))


def transcribe(path, model=DEFAULT_MODEL, scripts=None):
    """[{"text", "start", "end", "prob"}] for the whole file, cached by
    sha1(file) + model (+ a fingerprint of the whisper settings, so editing
    the scripts' names re-runs it). Word times are whisper's, corrected
    against the audio itself (see _refine): cuts land where its times are
    most often wrong, at pauses and around fillers."""
    prompt = whisper_prompt(scripts)
    fp = hashlib.sha1(json.dumps([_settings(prompt), REFINE, CHUNK_MAX, LONG_SILENCE],
                                 sort_keys=True).encode()).hexdigest()[:8]
    name = "%s-%s-%s.json" % (_sha1(path), re.sub(r"[^A-Za-z0-9._-]", "_", model), fp)
    cache = os.path.join(_cache_dir(), name)
    try:
        with open(cache, encoding="utf-8") as f:
            return json.load(f)["words"]
    except (OSError, ValueError, KeyError):
        pass
    t0 = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="video-edit-") as tmp:
        wav = os.path.join(tmp, "audio.wav")
        _extract_audio(path, wav)
        words = _run_whisper(wav, model, prompt)
    os.makedirs(os.path.dirname(cache), exist_ok=True)
    tmp_path = cache + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump({"source": os.path.abspath(path), "model": model,
                   "seconds": round(time.monotonic() - t0, 2), "words": words}, f)
    os.replace(tmp_path, cache)  # atomic: a killed run never leaves half a cache
    return words


# --- CLI -----------------------------------------------------------------------

def _summary(p):
    t = p["takes"][p["take"]]
    lines = ["%s: take %d of %d (%.1f-%.1f s, coverage %.2f, similarity %.2f), %.2f s at %.3fx"
             % (p["video_id"], p["take"] + 1, len(p["takes"]), t["start"], t["end"],
                t["coverage"], p["similarity"], p["duration"], p["speed"])]
    lines += ["  ! " + w for w in p["warnings"]]
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Find the scripts in a raw take and plan the cut.")
    ap.add_argument("raw", help="the raw video (or audio) file")
    ap.add_argument("--video", help="only this script id, e.g. victoria-1")
    ap.add_argument("--transcript", help="word-timestamp JSON to use instead of whisper")
    ap.add_argument("--model", default=DEFAULT_MODEL, help="whisper model (default %(default)s)")
    args = ap.parse_args(argv)
    if args.transcript is None and not os.path.exists(args.raw):
        ap.error("no such file: %s" % args.raw)
    if args.transcript is not None and not os.path.exists(args.transcript):
        ap.error("no such transcript: %s" % args.transcript)
    ids = [v["id"] for v in load_scripts()["videos"]]
    if args.video is not None and args.video not in ids:
        ap.error("unknown video %r; one of %s" % (args.video, ", ".join(ids)))
    plans = plan(args.raw, video_id=args.video, transcript=args.transcript, model=args.model)
    json.dump(plans, sys.stdout, indent=2)
    sys.stdout.write("\n")
    for p in plans:
        print(_summary(p), file=sys.stderr)
    if not plans:
        print("no script found in %s" % args.raw, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
