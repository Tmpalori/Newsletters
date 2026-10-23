# Subscribe videos (marketing/video)

Tools that turn Tristen's raw selfie takes into 16-second Facebook Reels for the five towns' free events newsletters, and post them on each town's Page. This folder is separate from the site. Nothing here is imported by `server/`, `scripts/` or the collector, and its dependencies stay out of the root `requirements.txt`.

The campaign itself (which video posts when, where the raw takes are, the posting loop, the rules) is in [HANDOFF.md](HANDOFF.md). The week-to-week routine (write scripts, cut, post) is the `town-videos` skill in `.claude/skills/town-videos/SKILL.md`.

## Setup

```bash
cd marketing/video
bash setup.sh                  # safe to re-run; VIDEO_VENV=/path puts the venv elsewhere
V=~/.venvs/video/bin/python    # the venv setup.sh made; the commands below use it, from this folder
```

`setup.sh` creates a venv with `faster-whisper`, `requests` and `pytest`. It downloads the `small.en` whisper model (about 460 MB, into the Hugging Face cache) and checks that ffmpeg has `subtitles` (libass), `zscale` and `tonemap`. On a fresh container it installs ffmpeg with apt if it's missing. A first run takes about 20 s plus the model download (about 10 s here). A re-run takes about 2 s.

## The tools

| File | What it does |
|---|---|
| `towns.py` | The five towns: name, domain, Facebook Page id, time zone, hashtags, palette, logo. |
| `scripts.json` / `SCRIPTS.md` | The current batch of scripts. Each has the words to say, the hook, the event chips with their cue words, the caption and `post_at_local`. SCRIPTS.md is the same content for people. Keep them in step. Past batches move to `scripts-archive/<first post date>.json`. From November 2026, ids are `<town>-<post date>` (for example `lincoln-2026-11-08`) so they never repeat. |
| `events.py` | Each town's upcoming events from its live `/next-week` or `/this-weekend` page (the sites' Event JSON-LD), by day with each event's own page, for writing scripts. It leaves out weekly regulars unless `--all`. |
| `fetch_clips.py` | Downloads new raw takes from Tristen's shared Drive folder (personal Drive, shared by link, so no sign-in) into `out/raw/`. It remembers what it has fetched, so re-runs only get new takes. |
| `analyze.py` | Raw take to cut plan(s). Whisper gives word timestamps, and every script in the file is found, even several scripts or takes in one file. It picks the best take and cuts restarts, long pauses, fillers and corrected slips ("Monday... no, Thursday"). It lays out the hook, chips, sign-up line and end card on a 16 s timeline, speeding up to at most 1.12x, and writes warnings. The plan format is in its docstring. |
| `render.py` | Plan to MP4. It cuts and joins on the frame grid, applies the speed-up, tone maps iPhone HDR (HLG/PQ) to SDR and burns in the hook, chips, word-by-word captions and end card in the town's colours (Fredoka, `fonts/`). Sound goes to -14 LUFS. |
| `edit.py` | `analyze` + `render` for one or more raw files. It prints a summary per video. `!` lines are warnings. `~` lines are other places where the words differ from the script, and the captions show what was heard there. |
| `post_reel.py` | Posts a finished Reel to its town's Page through Meta's Reels Publishing API, scheduled for `post_at_local` in the town's time zone. Without `--go` it's a dry run that makes no network calls. It keeps a ledger, so a video isn't posted twice. |
| `hq_feedback.py` | Read-only pull of what newsletter readers wrote (reply emails, contact-form messages) from HQ, for hook ideas. It never acks, marks or drafts anything. |
| `tests/` | pytest, no network. |

## Commands

Events, for writing scripts:

```bash
$V events.py                              # next week, every town
$V events.py --when weekend               # this coming weekend
$V events.py --town lincoln --from 2026-11-06 --to 2026-11-08 --json
```

Fetch:

```bash
$V fetch_clips.py --list                 # the folder's videos, new vs already fetched
$V fetch_clips.py                        # download the new ones into out/raw/
$V fetch_clips.py --folder LINK_OR_ID    # another shared folder
```

Cut:

```bash
$V edit.py out/raw/IMG_0412.MOV out/raw/IMG_0413.MOV   # every script found in each file
$V edit.py out/raw/IMG_0412.MOV --video victoria-1     # only that script
$V edit.py out/raw/IMG_0412.MOV --formats 9x16         # the Reel only (default 9x16,4x5)
$V analyze.py out/raw/IMG_0412.MOV > plan.json         # plan only: JSON on stdout, summary on stderr
$V render.py out/renders/victoria-1/report.json        # re-render next to it after hand-editing its plan
```

Keep raw takes in `out/raw/` so git never sees them.

Whisper takes about 0.5-0.8x the clip's length on 4 CPUs, and transcripts are cached per file. Rendering takes 25-30 s per format for a 1080p SDR take, and about 50-60 s for an HDR or 4K one.

Post (`--go` is the only thing that sends anything):

```bash
$V post_reel.py check                         # token, permissions, each Page's token
$V post_reel.py post out/renders/victoria-1/reel-9x16.mp4 --video victoria-1        # dry run
$V post_reel.py post out/renders/victoria-1/reel-9x16.mp4 --video victoria-1 --go   # schedule it
$V post_reel.py status [--town victoria]      # the Page's reels, ours by id, the ledger
```

`post` options:

- `--now`: publish immediately instead of scheduling.
- `--at 2026-10-25T19:00`: town time, instead of `post_at_local`.
- `--caption TEXT`: instead of the caption in scripts.json.
- `--allow-draft`: post a video scripts.json still marks `draft`.
- `--force`: post a video the ledger already has.

It refuses a file that isn't a 9:16 render, such as a raw take (camera tags, HDR) or the 4:5 cut. It also refuses a time less than 10 minutes or more than 29 days ahead, and a 31st reel in 24 hours on one Page.

Feedback:

```bash
$V hq_feedback.py                     # -> out/feedback/<YYYY-MM-DD>/
$V hq_feedback.py --history 30        # read more senders' older messages
$V hq_feedback.py --rebuild out/feedback/2026-10-23/feedback.json   # re-theme, no HQ calls
```

It makes one call per 6 s at most (`--interval`, never under 3 s), because the key shares a 30-calls-a-minute budget with Caspian.

Tests:

```bash
$V -m pytest tests -q                     # about 520 tests, 2.5 min; VIDEO_SKIP_SLOW=1 skips the 4 slowest renders
$V -m pytest tests/test_scripts.py -q     # just the live scripts.json: run it after writing new scripts
```

The suite is pinned to a frozen copy of the October 2026 scripts (`tests/conftest.py`), so rewriting scripts.json for a new week never breaks it. `test_scripts.py` is the one file that reads the live scripts.json.

The repo's CI runs `pytest -q` from the root on Python 3.11 without whisper or numpy. It collects these tests too: the whisper ones skip, and with `CI` set the slow renders skip as well.

## Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `META_TOKEN` | post_reel.py | A Meta system-user token with the five Pages assigned (Create content) and `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, plus `read_insights` for reach. `META_PAGE_TOKEN` is the fallback. Each Page's own token is looked up from it. |
| `GRAPH_API_VERSION` | post_reel.py | The Graph API version. The default is `v23.0`. Set it when Meta retires that version. |
| `HQ_ASSISTANT_TOKEN` | hq_feedback.py | HQ's assistant key, the same one Caspian uses, for read-only use. `HQ_READ_TOKEN` is the fallback. With neither, calls go without an Authorization header, for a network that adds one. |
| `HQ_URL` | hq_feedback.py | The default is `https://hq.tristenpalori.com`. It must be https. |
| `VIDEO_SCRIPTS` | analyze.py, post_reel.py | Another script list instead of scripts.json. The tests use it to pin the October 2026 batch (`tests/fixtures/scripts-2026-10.json`). `tests/test_scripts.py` checks the live scripts.json. |
| `VIDEO_DRIVE_FOLDER` | fetch_clips.py | The shared Drive folder's id. The default is Tristen's Town Newsletters folder. |
| `VIDEO_VENV` | setup.sh | Where the venv goes. The default is `~/.venvs/video`. |
| `VIDEO_WHISPER_MODEL` | setup.sh | The model to pre-download. The default is `small.en`. Use `--model` to cut with another. |
| `VIDEO_EDIT_CACHE` | analyze.py | Where the transcript cache goes. The default is `~/.cache/video-edit`. |
| `VIDEO_SKIP_SLOW`, `VIDEO_SLOW` | tests | Skip the slow render tests, or run them even when `CI` is set. |

Tokens only travel in an Authorization header. They are never printed, logged, put in an error or written to a file. Set them as environment variables, and never paste them into a chat or commit them.

## Outputs

Everything goes under `out/`, which git ignores: raw takes, renders and readers' words never belong in the repo.

| Path | What |
|---|---|
| `out/raw/` | Raw takes from `fetch_clips.py`, plus `fetched.json`, its record of which Drive files are already here. |
| `out/renders/<video_id>/reel-9x16.mp4` | The Reel: 1080x1920, H.264, 30 fps, AAC 48 kHz, -14 LUFS, a keyframe every 2 s, faststart. |
| `out/renders/<video_id>/feed-4x5.mp4` | The same cut at 1080x1350 for feed posts and ads. |
| `out/renders/<video_id>/thumb.jpg` | A frame 0.8 s in, with the hook showing. |
| `out/renders/<video_id>/report.json` | The plan (takes, segments, words, overlay times, `diff`, `warnings`), what each render did, and an ffprobe summary. |
| `out/renders/<video_id>-2/` | A second take of the same script from another file in the same run. It still posts as `<video_id>`, so pick one. |
| `out/posted.json` | post_reel.py's ledger: video id, Page, Meta's video id, state, scheduled time. It only exists on the machine that posted. |
| `out/feedback/<date>/` | `feedback.md` (messages by town, first names only, no addresses or phone numbers), `themes.md` (a keyword tally) and `feedback.json`. |
| `out/samples/` | Example renders. `out/samples/contact-sheet.png` shows hook, chip, caption and end-card frames for every town. |
| `out/fixtures/` | Fake raw takes for tests and samples (piper TTS, test-pattern picture). They're made by `out/fixtures/make_fixtures.py`, which needs `pip install piper-tts`. |

## Limits worth knowing

- Whisper's word timing was tuned on clean TTS audio. Check frames from the first real takes (wind, music and echo are untested), and always read every `!` and `~` line.
- A word whisper hears as a different word is captioned as heard, for example "Fue" for "Free". The analyzer warns when the word is a day, number, name or web address. Any other word shows as a `~` line in `edit.py`'s summary.
- A cut over 16 s is sped up to at most 1.12x and warned. Over 16.5 s it warns again. Script words are never dropped to fit.
- `post_reel.py`'s successful `--go` path has only run against mocks and a local stand-in for Meta. The first real post should be one Tristen has approved, posted while someone watches `status`.
