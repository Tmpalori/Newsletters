#!/usr/bin/env bash
# One-time (and safe to re-run) setup for the subscribe-video toolkit:
# a virtualenv with faster-whisper, Pillow and OpenCV, the default whisper
# model on disk, a colour emoji font and the face detector's model in the
# toolkit's cache, and a check that this ffmpeg can burn captions.
#
# Its own venv because the system pip is externally managed on the cloud
# containers, and because whisper's runtimes must stay out of the site's
# requirements.txt. Every step checks before it acts, so a second run is a
# quick no-op.
#
#   VIDEO_VENV=~/.venvs/video        where the venv lives
#   VIDEO_WHISPER_MODEL=small.en     the model analyze.py uses by default
#   VIDEO_EDIT_CACHE=~/.cache/video-edit   the cache (transcripts, the emoji
#                                    font, the face model, site screenshots)
#   PYTHON=python3.13                the interpreter to build the venv from
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="${VIDEO_VENV:-$HOME/.venvs/video}"
MODEL="${VIDEO_WHISPER_MODEL:-small.en}"
CACHE="${VIDEO_EDIT_CACHE:-$HOME/.cache/video-edit}"

# The event cards' icons: Noto Color Emoji (Apache 2.0), a release pinned by
# its checksum. Not in the repo: it's 10 MB, and render.py finds it here.
EMOJI_URL="https://raw.githubusercontent.com/googlefonts/noto-emoji/v2.051/fonts/NotoColorEmoji.ttf"
EMOJI_SHA256="72a635cb3d2f3524c51620cdde406b217204e8a6a06c6a096ff8ed4b5fd6e27b"
# The face detector that keeps the cards off the eyes: OpenCV Zoo's YuNet
# (MIT), 230 KB, pinned to a commit. Without it render.py falls back to the
# Haar cascade inside OpenCV.
YUNET_URL="https://media.githubusercontent.com/media/opencv/opencv_zoo/48b10fa505aeb51fbd127fc60a5c660040e823b7/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"
YUNET_SHA256="8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"

say() { printf '==> %s\n' "$*"; }
die() { printf 'setup.sh: %s\n' "$*" >&2; exit 1; }

# ffmpeg first: without it nothing else is worth installing. A fresh Ubuntu
# container may lack it, and apt is the only sane source there.
if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  if [ "$(id -u)" = 0 ] && command -v apt-get >/dev/null 2>&1; then
    say "installing ffmpeg (apt)"
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg >/dev/null
  else
    die "ffmpeg/ffprobe not found; install ffmpeg (with libass) and re-run"
  fi
fi

# The repo targets Python 3.13; fall back to whatever python3 is, since
# faster-whisper runs on anything from 3.9.
PY="${PYTHON:-}"
if [ -z "$PY" ]; then
  for c in python3.13 python3; do
    if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
  done
fi
[ -n "$PY" ] || die "no python3 found"

if [ ! -x "$VENV/bin/python" ]; then
  say "creating venv at $VENV ($("$PY" --version 2>&1))"
  mkdir -p "$(dirname "$VENV")"
  "$PY" -m venv "$VENV" || die "'$PY -m venv' failed; on Debian/Ubuntu: apt-get install python3-venv"
else
  say "venv already at $VENV ($("$VENV/bin/python" --version 2>&1))"
fi

say "installing requirements"
"$VENV/bin/python" -m pip install --disable-pip-version-check -q -r "$HERE/requirements.txt"

# Pre-fetch the model so the first real cut doesn't stall on a ~250 MB
# download, and so analyze.py can load it with local_files_only.
say "whisper model: $MODEL"
"$VENV/bin/python" - "$MODEL" <<'PY'
import sys
from faster_whisper import download_model

name = sys.argv[1]
try:
    path = download_model(name, local_files_only=True)
    print(f"    already cached: {path}")
except Exception:
    path = download_model(name)
    print(f"    downloaded: {path}")
PY

# A file the renderer wants, downloaded once and checked against its sha256.
# A failed download is reported, not fatal: render.py does without (a system
# emoji font or no icons; the Haar cascade for faces).
fetch() {
  local url="$1" sum="$2" dest="$3" what="$4" n
  if [ -f "$dest" ] && "$VENV/bin/python" - "$dest" "$sum" <<'PY'
import hashlib, sys
sys.exit(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest() != sys.argv[2])
PY
  then
    say "$what: already at $dest"
    return 0
  fi
  mkdir -p "$(dirname "$dest")"
  for n in 1 2 3; do
    # Big files through a proxy sometimes stop short (curl exit 18): retry.
    if curl -fsSL -o "$dest.part" "$url" && "$VENV/bin/python" - "$dest.part" "$sum" <<'PY'
import hashlib, sys
sys.exit(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest() != sys.argv[2])
PY
    then
      mv "$dest.part" "$dest"
      say "$what: downloaded to $dest"
      return 0
    fi
    sleep 2
  done
  rm -f "$dest.part"
  say "$what: download FAILED (render.py will do without; re-run setup.sh to try again)"
  return 0
}
fetch "$EMOJI_URL" "$EMOJI_SHA256" "$CACHE/fonts/NotoColorEmoji.ttf" "emoji font (the cards' icons)"
fetch "$YUNET_URL" "$YUNET_SHA256" "$CACHE/models/face_detection_yunet_2023mar.onnx" "face model (YuNet)"

# The phone shows a screenshot of the town's site, taken with headless
# Chrome or Chromium (Playwright's counts) and cached for the day. Without
# one the newest cached screenshot is used, and with none the video has no
# phone: report, don't fail.
CHROME="$("$VENV/bin/python" -c "import sys; sys.path.insert(0, '$HERE'); import render; print(render.chrome_path() or '')")"
if [ -n "$CHROME" ]; then say "chrome (the phone's screenshot): $CHROME"; else say "chrome: NOT FOUND (no new site screenshots for the phone; set VIDEO_CHROME)"; fi

# Captions are burned in with the subtitles filter, so libass is required.
# zscale + tonemap only matter for iPhone HDR (HLG) takes; without them the
# renderer has to fall back to a plainer conversion, so report, don't fail.
FILTERS="$(ffmpeg -hide_banner -filters 2>/dev/null | awk '{print $2}')"
has_filter() { printf '%s\n' "$FILTERS" | grep -qx "$1"; }
has_filter subtitles || die "this ffmpeg has no 'subtitles' filter (needs --enable-libass)"
say "ffmpeg: subtitles (libass) yes"
for f in zscale tonemap; do
  if has_filter "$f"; then say "ffmpeg: $f yes"; else say "ffmpeg: $f NO (HDR takes will look washed out)"; fi
done

echo
echo "Ready. Next:"
if [ -f "$HERE/edit.py" ]; then
  echo "  $VENV/bin/python $HERE/edit.py RAW.MOV                    # raw take in, finished Reels out"
fi
cat <<EOF
  $VENV/bin/python $HERE/analyze.py RAW.MOV > plan.json     # just find the scripts and plan the cut
  $VENV/bin/python $HERE/analyze.py RAW.MOV --video victoria-1
  $VENV/bin/python -m pytest $HERE/tests -q
EOF
if [ -f "$HERE/post_reel.py" ]; then
  echo "  $VENV/bin/python $HERE/post_reel.py check                 # META_TOKEN and the five Pages"
fi
if [ -f "$HERE/hq_feedback.py" ]; then
  echo "  $VENV/bin/python $HERE/hq_feedback.py                     # what readers wrote (HQ_ASSISTANT_TOKEN)"
fi
echo "How it all fits: $HERE/README.md; the campaign and the posting loop: $HERE/HANDOFF.md"
