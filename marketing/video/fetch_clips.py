#!/usr/bin/env python3
"""Fetch Tristen's raw takes from his shared Google Drive folder.

    python3 fetch_clips.py                     # new takes -> out/raw/
    python3 fetch_clips.py --list              # only show what's there
    python3 fetch_clips.py --folder URL_OR_ID --out DIR

The folder ("Town Newsletters", in Tristen's personal Drive) is shared as
"Anyone with the link", so this needs no Google sign-in. That is the point:
the Google Drive connector in these sessions is signed in to his Foresite
work account, which can't see the folder (and must not hold campaign
files), and the connector hands a download back as base64 in the context,
which a video would blow straight through.

Listing: Drive's embeddedfolderview page (what folder embeds use) lists a
public folder as plain HTML, one <div class="flip-entry" id="entry-<id>">
per file or subfolder, with the name in flip-entry-title and a /file/d/
or /drive/folders/ link. Subfolders are walked a few levels deep, since
Tristen may sort takes by town. A folder that isn't public answers 401 or
a sign-in page instead, which we say plainly.

Downloading: drive.usercontent.google.com/download with confirm=t streams
the file itself (confirm=t skips the "can't scan this for viruses" page
Drive puts in front of big files). If the answer is HTML instead, the file
isn't shared or Drive changed its pages; we stop rather than save a web
page as IMG_1234.MOV.

out/raw/fetched.json remembers each Drive id already fetched, so a re-run
only downloads the takes Tristen added since.
"""
import argparse
import html
import json
import os
import re
import shutil
import subprocess
import sys
import time

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
# Tristen's "Town Newsletters" folder (personal Drive, shared by link on Oct 23).
FOLDER = os.environ.get("VIDEO_DRIVE_FOLDER", "1F77hwtz4YWNGtnEXzs2W2IMHmd3IhTBW")
OUT = os.path.join(HERE, "out", "raw")
LIST_URL = "https://drive.google.com/embeddedfolderview"
DOWNLOAD_URL = "https://drive.usercontent.google.com/download"
# What phones and cameras write. Anything else in the folder (a note, a
# photo, a doc) is left alone unless --all.
VIDEO_EXT = (".mov", ".mp4", ".m4v", ".hevc", ".avi", ".mkv", ".webm", ".3gp")
MAX_DEPTH = 3
LIST_TIMEOUT = 30
# (connect, between chunks): a slow phone upload's file is fine, a stalled
# connection isn't.
DOWNLOAD_TIMEOUT = (15, 120)
CHUNK = 1 << 20

ENTRY = re.compile(r'<div\b[^>]*\bid="entry-([\w-]+)"[^>]*>')
TITLE = re.compile(r'class="flip-entry-title"[^>]*>([^<]*)<')
HREF = re.compile(r'<a\b[^>]*\bhref="([^"]+)"')


class FetchError(RuntimeError):
    pass


def folder_id(raw):
    """The id from a folder link as Drive's Share button copies it
    (.../drive/folders/<id>?usp=sharing), an ?id= link, or a bare id."""
    raw = (raw or "").strip()
    m = re.search(r"/folders/([\w-]{10,})", raw) or re.search(r"[?&]id=([\w-]{10,})", raw)
    if m:
        return m.group(1)
    if re.fullmatch(r"[\w-]{10,}", raw):
        return raw
    raise FetchError(f"not a Google Drive folder link or id: {raw!r}")


def parse_listing(page):
    """[{id, name, folder}] from an embeddedfolderview page, in page order."""
    if 'class="flip-entries"' not in page:
        # A sign-in page (the folder isn't public) or a Drive redesign: either
        # way there is nothing here to trust as a list of takes.
        raise FetchError("Drive didn't return a folder listing. Is the folder shared as "
                         "'Anyone with the link'?")
    marks = list(ENTRY.finditer(page))
    out = []
    for i, m in enumerate(marks):
        chunk = page[m.start():marks[i + 1].start() if i + 1 < len(marks) else len(page)]
        title = TITLE.search(chunk)
        href = HREF.search(chunk)
        out.append({
            "id": m.group(1),
            "name": html.unescape(title.group(1)).strip() if title else m.group(1),
            "folder": bool(href and "/folders/" in href.group(1)),
        })
    return out


def list_folder(session, fid, depth=0, prefix=""):
    """Every file under the folder, as [{id, name, path}]; path shows the
    subfolder it sits in, for the listing only."""
    try:
        r = session.get(LIST_URL, params={"id": fid}, timeout=LIST_TIMEOUT)
    except requests.RequestException as e:
        raise FetchError(f"couldn't reach Google Drive: {type(e).__name__}") from None
    if r.status_code in (401, 403, 404):
        raise FetchError(f"Drive refused the folder listing ({r.status_code}). Is the folder "
                         "shared as 'Anyone with the link', and is the link right?")
    if r.status_code != 200:
        raise FetchError(f"Drive answered {r.status_code} for the folder listing")
    files = []
    for e in parse_listing(r.text):
        if e["folder"]:
            if depth < MAX_DEPTH:
                files += list_folder(session, e["id"], depth + 1, prefix + e["name"] + "/")
            continue
        files.append({"id": e["id"], "name": e["name"], "path": prefix + e["name"]})
    return files


def is_video(name):
    return name.lower().endswith(VIDEO_EXT)


def safe_name(name):
    # Phone names are already tame (IMG_1234.MOV); this only keeps a shared
    # file called "../x" or "a b?.mov" from escaping out/raw or tripping a shell.
    base = re.sub(r"[^\w.-]+", "_", os.path.basename(name)).strip("._") or "clip"
    return base[:120]


def local_name(entry, out_dir, manifest):
    name = safe_name(entry["name"])
    taken = {v.get("file") for k, v in manifest.items() if k != entry["id"]}
    if name in taken or (os.path.exists(os.path.join(out_dir, name))
                         and manifest.get(entry["id"], {}).get("file") != name):
        stem, ext = os.path.splitext(name)
        name = f"{stem}-{entry['id'][:8]}{ext}"
    return name


def download(session, entry, dest):
    """Stream one file to dest (through dest.part, so a cut-off download never
    looks finished). Returns the byte count."""
    params = {"id": entry["id"], "export": "download", "confirm": "t"}
    part = dest + ".part"
    try:
        with session.get(DOWNLOAD_URL, params=params, stream=True, timeout=DOWNLOAD_TIMEOUT) as r:
            if r.status_code != 200:
                raise FetchError(f"{entry['name']}: Drive answered {r.status_code}")
            if r.headers.get("Content-Type", "").lower().startswith("text/html"):
                raise FetchError(f"{entry['name']}: Drive sent a web page, not the video. Is the "
                                 "file shared as 'Anyone with the link'?")
            n = 0
            with open(part, "wb") as f:
                for chunk in r.iter_content(CHUNK):
                    f.write(chunk)
                    n += len(chunk)
    except requests.RequestException as e:
        _drop(part)
        raise FetchError(f"{entry['name']}: download failed ({type(e).__name__})") from None
    except BaseException:
        _drop(part)
        raise
    if n == 0:
        _drop(part)
        raise FetchError(f"{entry['name']}: Drive sent an empty file")
    os.replace(part, dest)
    return n


def _drop(path):
    try:
        os.remove(path)
    except OSError:
        pass


def probe_note(path):
    """A short note when the file doesn't look like a playable video; None when
    it does, or when there's no ffprobe here to ask."""
    if not shutil.which("ffprobe"):
        return None
    try:
        p = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                            "-of", "default=nw=1:nk=1", os.path.abspath(path)],
                           capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return "ffprobe couldn't read it"
    try:
        secs = float(p.stdout.strip())
    except ValueError:
        return "ffprobe found no video in it"
    return None if p.returncode == 0 and secs > 0 else "ffprobe found no video in it"


def load_manifest(out_dir):
    path = os.path.join(out_dir, "fetched.json")
    try:
        with open(path) as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_manifest(out_dir, manifest):
    path = os.path.join(out_dir, "fetched.json")
    with open(path + ".tmp", "w") as f:
        json.dump(manifest, f, indent=2, sort_keys=True)
    os.replace(path + ".tmp", path)


def _mb(n):
    return f"{n / 1e6:.1f} MB"


def main(argv=None, session=None):
    ap = argparse.ArgumentParser(description="Fetch raw takes from the shared Drive folder.")
    ap.add_argument("--folder", default=FOLDER, help="folder link or id (default: Town Newsletters)")
    ap.add_argument("--out", default=OUT, help="where takes go (default out/raw, gitignored)")
    ap.add_argument("--list", action="store_true", help="only list the folder")
    ap.add_argument("--all", action="store_true", help="fetch every file, not only videos")
    args = ap.parse_args(argv)

    session = session or requests.Session()
    try:
        fid = folder_id(args.folder)
        files = list_folder(session, fid)
    except FetchError as e:
        print(f"fetch_clips: {e}", file=sys.stderr)
        return 1

    os.makedirs(args.out, exist_ok=True)
    manifest = load_manifest(args.out)
    wanted = [f for f in files if args.all or is_video(f["name"])]
    skipped = len(files) - len(wanted)

    def fetched(f):
        m = manifest.get(f["id"])
        return bool(m and os.path.exists(os.path.join(args.out, m.get("file", ""))))

    new = [f for f in wanted if not fetched(f)]
    print(f"Folder {fid}: {len(wanted)} video{'s' if len(wanted) != 1 else ''}, {len(new)} new"
          + (f" ({skipped} other file{'s' if skipped != 1 else ''} left alone)" if skipped else ""))
    for f in wanted:
        print(f"  {'new ' if f in new else 'have'}  {f['path']}")
    if args.list or not new:
        return 0

    failed = 0
    for f in new:
        name = local_name(f, args.out, manifest)
        dest = os.path.join(args.out, name)
        t = time.monotonic()
        try:
            n = download(session, f, dest)
        except FetchError as e:
            print(f"  ! {e}", file=sys.stderr)
            failed += 1
            continue
        manifest[f["id"]] = {"name": f["name"], "file": name, "bytes": n,
                             "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        save_manifest(args.out, manifest)
        note = probe_note(dest)
        print(f"  got   {name}  {_mb(n)} in {time.monotonic() - t:.0f} s"
              + (f"  ! {note}" if note else ""))
    if failed:
        print(f"{failed} download{'s' if failed != 1 else ''} failed; the rest are in {args.out}",
              file=sys.stderr)
        return 1
    print(f"Next: python edit.py {os.path.relpath(args.out)}/<file> ...")
    return 0


if __name__ == "__main__":
    sys.exit(main())
