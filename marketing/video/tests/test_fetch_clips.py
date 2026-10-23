"""fetch_clips.py: listing and downloading from the shared Drive folder, offline.

EMPTY_PAGE is what drive.google.com/embeddedfolderview really answered for
the (then empty) Town Newsletters folder on Oct 23, trimmed of its script.
FULL_PAGE follows the same markup with entries in it; the first real
listing with takes in it is worth checking against parse_listing.
"""
import json
import os
import sys

import pytest

VIDEO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, VIDEO)

import fetch_clips as fc  # noqa: E402

FOLDER = "1F77hwtz4YWNGtnEXzs2W2IMHmd3IhTBW"
SUB = "1SubFolderAAAAAAAAAAAAAAAAAAAAAA"

EMPTY_PAGE = (
    '<!DOCTYPE html><html><head><title>Town Newsletters</title></head>'
    '<body class="flip-embedded"><div id="flip-contents" class="flip-contents flip-list-view">'
    '<div class="flip-entries"></div></div></body></html>')


def entry(fid, name, folder=False):
    href = (f"https://drive.google.com/drive/folders/{fid}" if folder
            else f"https://drive.google.com/file/d/{fid}/view?usp=drive_web")
    return (f'<div class="flip-entry" id="entry-{fid}" tabindex="0" role="link">'
            f'<div class="flip-entry-info"><a href="{href}" target="_blank">'
            f'<div class="flip-entry-thumb"></div><div class="flip-entry-title">{name}</div>'
            f'</a></div><div class="flip-entry-last-modified"><div>4:12 PM</div></div></div>')


def page(*entries):
    return ('<html><body><div id="flip-contents" class="flip-contents flip-list-view">'
            '<div class="flip-entries">' + "".join(entries) + '</div></div></body></html>')


FULL_PAGE = page(entry("1FileAAAAAAAAAAAAAAAAAAAAAAAAAAA", "IMG_0412.MOV"),
                 entry("1FileBBBBBBBBBBBBBBBBBBBBBBBBBBB", "Lincoln &amp; Medford take 2.mp4"),
                 entry("1NoteCCCCCCCCCCCCCCCCCCCCCCCCCCC", "notes.txt"),
                 entry(SUB, "Shoals", folder=True))
SUB_PAGE = page(entry("1FileDDDDDDDDDDDDDDDDDDDDDDDDDDD", "IMG_0500.MOV"))


class Resp:
    def __init__(self, status=200, text="", body=b"", ctype="video/quicktime"):
        self.status_code, self.text, self.body = status, text, body
        self.headers = {"Content-Type": ctype}

    def iter_content(self, n):
        for i in range(0, len(self.body), n):
            yield self.body[i:i + n]

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class FakeDrive:
    """Answers the two Drive URLs fetch_clips uses; anything else fails the test."""

    def __init__(self, pages, files, html_for=()):
        self.pages, self.files, self.html_for = pages, files, set(html_for)
        self.calls = []

    def get(self, url, params=None, timeout=None, stream=False):
        assert timeout, "every request needs a timeout"
        self.calls.append((url, dict(params or {})))
        if url == fc.LIST_URL:
            fid = params["id"]
            if fid not in self.pages:
                return Resp(401, text="<html>Sign in</html>", ctype="text/html")
            return Resp(200, text=self.pages[fid], ctype="text/html")
        if url == fc.DOWNLOAD_URL:
            assert params["confirm"] == "t" and params["export"] == "download"
            if params["id"] in self.html_for:
                return Resp(200, body=b"<html>virus scan</html>", ctype="text/html; charset=utf-8")
            return Resp(200, body=self.files[params["id"]])
        raise AssertionError(f"unexpected URL {url}")


def downloads(drive):
    return [p["id"] for u, p in drive.calls if u == fc.DOWNLOAD_URL]


@pytest.mark.parametrize("raw", [
    f"https://drive.google.com/drive/folders/{FOLDER}?usp=sharing",
    f"https://drive.google.com/drive/u/1/folders/{FOLDER}",
    f"https://drive.google.com/open?id={FOLDER}",
    f"  {FOLDER}  ",
])
def test_folder_id_accepts_share_links_and_bare_ids(raw):
    assert fc.folder_id(raw) == FOLDER


@pytest.mark.parametrize("raw", ["", "https://example.com/x", "not an id!"])
def test_folder_id_refuses_anything_else(raw):
    with pytest.raises(fc.FetchError):
        fc.folder_id(raw)


def test_the_real_empty_folder_lists_nothing():
    assert fc.parse_listing(EMPTY_PAGE) == []


def test_listing_reads_files_folders_and_entities():
    got = fc.parse_listing(FULL_PAGE)
    assert [(e["name"], e["folder"]) for e in got] == [
        ("IMG_0412.MOV", False), ("Lincoln & Medford take 2.mp4", False),
        ("notes.txt", False), ("Shoals", True)]
    assert got[0]["id"] == "1FileAAAAAAAAAAAAAAAAAAAAAAAAAAA"


def test_a_sign_in_page_is_not_a_listing():
    with pytest.raises(fc.FetchError, match="Anyone with the link"):
        fc.parse_listing("<html><title>Sign in - Google Accounts</title></html>")


def test_list_walks_subfolders():
    drive = FakeDrive({FOLDER: FULL_PAGE, SUB: SUB_PAGE}, {})
    files = fc.list_folder(drive, FOLDER)
    assert [f["path"] for f in files] == [
        "IMG_0412.MOV", "Lincoln & Medford take 2.mp4", "notes.txt", "Shoals/IMG_0500.MOV"]


def test_a_private_folder_explains_itself(tmp_path, capsys):
    drive = FakeDrive({}, {})
    assert fc.main(["--folder", FOLDER, "--out", str(tmp_path)], session=drive) == 1
    assert "Anyone with the link" in capsys.readouterr().err


def test_list_only_downloads_nothing(tmp_path, capsys):
    drive = FakeDrive({FOLDER: FULL_PAGE, SUB: SUB_PAGE}, {})
    assert fc.main(["--out", str(tmp_path), "--list"], session=drive) == 0
    assert downloads(drive) == []
    out = capsys.readouterr().out
    assert "3 videos, 3 new" in out and "1 other file left alone" in out


def test_fetches_new_videos_once(tmp_path, monkeypatch):
    monkeypatch.setattr(fc, "probe_note", lambda path: None)
    files = {"1FileAAAAAAAAAAAAAAAAAAAAAAAAAAA": b"a" * 3000000,
             "1FileBBBBBBBBBBBBBBBBBBBBBBBBBBB": b"b" * 10,
             "1FileDDDDDDDDDDDDDDDDDDDDDDDDDDD": b"d" * 20}
    drive = FakeDrive({FOLDER: FULL_PAGE, SUB: SUB_PAGE}, files)
    assert fc.main(["--out", str(tmp_path)], session=drive) == 0
    assert sorted(downloads(drive)) == sorted(files)  # notes.txt left alone
    assert (tmp_path / "IMG_0412.MOV").read_bytes() == files["1FileAAAAAAAAAAAAAAAAAAAAAAAAAAA"]
    # "Lincoln & Medford take 2.mp4" is made shell- and path-safe.
    assert (tmp_path / "Lincoln_Medford_take_2.mp4").exists()
    manifest = json.loads((tmp_path / "fetched.json").read_text())
    assert manifest["1FileDDDDDDDDDDDDDDDDDDDDDDDDDDD"]["file"] == "IMG_0500.MOV"
    assert not list(tmp_path.glob("*.part"))

    # Tristen adds nothing; a re-run downloads nothing.
    again = FakeDrive({FOLDER: FULL_PAGE, SUB: SUB_PAGE}, files)
    assert fc.main(["--out", str(tmp_path)], session=again) == 0
    assert downloads(again) == []


def test_same_name_in_two_folders_keeps_both(tmp_path, monkeypatch):
    monkeypatch.setattr(fc, "probe_note", lambda path: None)
    top = page(entry("1FileAAAAAAAAAAAAAAAAAAAAAAAAAAA", "IMG_0412.MOV"), entry(SUB, "Shoals", folder=True))
    sub = page(entry("1FileZZZZZZZZZZZZZZZZZZZZZZZZZZZ", "IMG_0412.MOV"))
    files = {"1FileAAAAAAAAAAAAAAAAAAAAAAAAAAA": b"one", "1FileZZZZZZZZZZZZZZZZZZZZZZZZZZZ": b"two"}
    assert fc.main(["--out", str(tmp_path)], session=FakeDrive({FOLDER: top, SUB: sub}, files)) == 0
    assert (tmp_path / "IMG_0412.MOV").read_bytes() == b"one"
    assert (tmp_path / "IMG_0412-1FileZZZ.MOV").read_bytes() == b"two"


def test_a_web_page_is_never_saved_as_a_video(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(fc, "probe_note", lambda path: None)
    top = page(entry("1FileAAAAAAAAAAAAAAAAAAAAAAAAAAA", "IMG_0412.MOV"))
    drive = FakeDrive({FOLDER: top}, {}, html_for={"1FileAAAAAAAAAAAAAAAAAAAAAAAAAAA"})
    assert fc.main(["--out", str(tmp_path)], session=drive) == 1
    assert "web page" in capsys.readouterr().err
    assert not (tmp_path / "IMG_0412.MOV").exists()
    assert not list(tmp_path.glob("*.part"))
    assert "1FileAAAAAAAAAAAAAAAAAAAAAAAAAAA" not in fc.load_manifest(str(tmp_path))


def test_safe_name_cannot_escape_the_folder():
    assert fc.safe_name("../../etc/passwd") == "passwd"
    assert fc.safe_name("a b?.mov") == "a_b_.mov"
    assert fc.safe_name("...") == "clip"
