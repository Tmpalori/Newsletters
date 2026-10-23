# Subscribe videos: handoff

This is for a Claude session that has none of the earlier conversation. [README.md](README.md) covers the tools, and the `town-videos` skill (`.claude/skills/town-videos/SKILL.md`) is the routine for every future week: new scripts from `events.py`, then cutting and posting. This file covers this first campaign, access, the loop for each batch of clips, and the rules. It was written Fri Oct 23, 2026.

**After this campaign:** move these 15 videos to `scripts-archive/2026-10-25.json` before writing the next batch. Give the new videos ids like `<town>-<post date>` (for example `lincoln-2026-11-08`), not `-1`, `-2` again: post_reel.py's ledger and the posted log below key on the id.

## The campaign

- **Five towns, five Facebook Pages.** Each town has a free events newsletter: the *week* issue goes out Monday morning and the *weekend* issue Thursday morning. The send times run 7:00-8:03 AM town time; they're in `server/scheduler.js` and each `towns/<slug>/town.json` `schedule`.

  | Slug | Town | Site |
  |---|---|---|
  | `victoria` | The Vic 361 | thevic361.com |
  | `lincoln` | The Star 402 | thestar402.com |
  | `medford` | The Rogue 541 | therogue541.com |
  | `shoals` | Shoals Setlist | shoalssetlist.com |
  | `virginiabeach` | The Tide 757 | thetide757.com |

  `towns.py` has their Page ids, time zones and colours.
- **Kearney and Tupelo are left out on purpose.** Kearney (The Crane 308) and Tupelo (Tupelo Current) have no Facebook Page, so there is nowhere to post their videos.
- **Three videos per town, 15 in all.**
  - Video 1 is the Halloween week.
  - Video 2 is the Halloween weekend.
  - Video 3 is the week of Nov 2. It is still a **draft** (see below).
- **The angle is subscribing, not the events.** Tristen films a 16-second vertical selfie reading the script in `scripts.json` (SCRIPTS.md is the readable copy): a hook about the week's best events, then the sign-up line, "Free." and the web address.
  - Sunday videos, for Monday's week issue: "Sign up tonight and the whole week's in your inbox tomorrow morning."
  - Wednesday videos, for Thursday's weekend issue: "Sign up tonight and it's in your inbox tomorrow morning."
  - Each video posts at 6:30 PM town time the evening before its issue, so "tonight... tomorrow morning" is true. Every video ends on the card "FREE every Mon & Thu / <domain>", and every caption links to `<site>/subscribe`.

## Posting schedule

Times are `post_at_local` in scripts.json. `post_reel.py` converts them itself. US daylight time ends at 2 AM on Nov 1, so video 3 is in standard time.

| Video | Angle | Town time | UTC |
|---|---|---|---|
| victoria-1 | Halloween week | Sun Oct 25, 6:30 PM CDT | Sun Oct 25 23:30 |
| lincoln-1 | Halloween week | Sun Oct 25, 6:30 PM CDT | Sun Oct 25 23:30 |
| medford-1 | Halloween week | Sun Oct 25, 6:30 PM PDT | Mon Oct 26 01:30 |
| shoals-1 | Halloween week | Sun Oct 25, 6:30 PM CDT | Sun Oct 25 23:30 |
| virginiabeach-1 | Halloween week | Sun Oct 25, 6:30 PM EDT | Sun Oct 25 22:30 |
| victoria-2 | Halloween weekend | Wed Oct 28, 6:30 PM CDT | Wed Oct 28 23:30 |
| lincoln-2 | Halloween weekend | Wed Oct 28, 6:30 PM CDT | Wed Oct 28 23:30 |
| medford-2 | Halloween weekend | Wed Oct 28, 6:30 PM PDT | Thu Oct 29 01:30 |
| shoals-2 | Halloween weekend | Wed Oct 28, 6:30 PM CDT | Wed Oct 28 23:30 |
| virginiabeach-2 | Halloween weekend | Wed Oct 28, 6:30 PM EDT | Wed Oct 28 22:30 |
| victoria-3 (draft) | Week of Nov 2 | Sun Nov 1, 6:30 PM CST | Mon Nov 2 00:30 |
| lincoln-3 (draft) | Week of Nov 2 | Sun Nov 1, 6:30 PM CST | Mon Nov 2 00:30 |
| medford-3 (draft) | Week of Nov 2 | Sun Nov 1, 6:30 PM PST | Mon Nov 2 02:30 |
| shoals-3 (draft) | Week of Nov 2 | Sun Nov 1, 6:30 PM CST | Mon Nov 2 00:30 |
| virginiabeach-3 (draft) | Week of Nov 2 | Sun Nov 1, 6:30 PM EST | Sun Nov 1 23:30 |

Meta only schedules more than 10 minutes and at most 29 days ahead. If a slot is missed, post later that same evening with `--at` (town time), or with `--now` if Tristen agrees. Never post after that town's next issue has gone out: by then "tomorrow morning" isn't true.

## Where things live

- **Code, scripts and docs:** `marketing/video/` in this repo. `scripts.json` is the source of truth for the words, hooks, chips, captions and times. `SCRIPTS.md` mirrors it, and it's the copy Tristen reads (send it to him as a file).
- **Raw takes:** Tristen drops them in **Town Newsletters**, a folder in his **personal** Google Drive, shared as "Anyone with the link": https://drive.google.com/drive/folders/1F77hwtz4YWNGtnEXzs2W2IMHmd3IhTBW. `fetch_clips.py` reads it from that link.
- **Not his work accounts.** The Google Drive and Gmail connectors in these sessions are signed in to Tristen's Foresite (work) account. Nothing for this campaign goes there: he asked for it all to live in his personal Drive. (A first "Town Videos" folder made there by mistake on Oct 23 is in that Drive's trash.)
- **Everything made locally** (raw downloads, renders, the post ledger `out/posted.json`, reader feedback) lives under `marketing/video/out/`. Git ignores it, and it doesn't survive a new container.
- **HQ, Tristen's owner dashboard:** https://hq.tristenpalori.com. Reader replies and contact messages land in its inbox.

## Access the session needs

| What | How it gets there | How to check |
|---|---|---|
| `META_TOKEN` | A Meta system-user token with the five Pages assigned (Create content) and `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `read_insights`. Tristen adds it as an environment variable in the cloud environment's settings (the environment menu in the session's title bar, then Edit). A new session picks it up. It must be a plain environment variable: post_reel.py reads it to look up each Page's own token. | `post_reel.py check` should end with "Ready to post reels." and show a "Page token OK" line for each of the five Pages. |
| `HQ_ASSISTANT_TOKEN` | HQ's assistant key, the same key Caspian (Tristen's other assistant) uses. It's for **read-only** use. Tristen adds it the same way. | `hq_feedback.py` writes `out/feedback/<date>/`. A 401 means the key is missing or wrong. |
| The raw takes | Nothing to add: the folder is shared by link (done Oct 23). Don't use the Google Drive connector for it (wrong account, and it returns files as base64). | `fetch_clips.py --list` prints the folder's videos. |
| Network | The cloud environment's network access must allow these hosts: `graph.facebook.com`, `rupload.facebook.com`, `drive.google.com`, `drive.usercontent.google.com`, `hq.tristenpalori.com`, and `huggingface.co` plus PyPI for setup. All were reachable on Oct 23. | `setup.sh` and the checks above. |

Never ask Tristen to paste a token into the chat, and never print one. Until the secrets are added, both checks fail cleanly, which is expected:

- `post_reel.py check` says "META_TOKEN (or META_PAGE_TOKEN) isn't set..." and exits 1.
- `hq_feedback.py` makes one call, gets HQ's 401, explains it and exits 1. It writes no files.

## Fetching clips

From `marketing/video/`:

```bash
$V fetch_clips.py --list    # what's in the folder, new vs already fetched
$V fetch_clips.py           # download the new ones into out/raw/
```

- It lists the folder through Drive's public `embeddedfolderview` page (subfolders too) and downloads from `drive.usercontent.google.com` with `confirm=t`. No sign-in is needed, because the folder is shared by link.
- `out/raw/fetched.json` remembers which Drive files are already down, so a re-run only fetches what Tristen added. That record goes with the container; in a new one, everything counts as new again, which is harmless.
- It refuses to save a web page as a video. That happens when a file or the folder isn't shared, and it says so.
- Checked only on the empty folder (Oct 23). When the first takes arrive, compare `--list` with what Tristen says he uploaded. If it lists nothing while he says the folder has files, Drive's page markup changed: `parse_listing()` is the place to fix.
- Never use the Google Drive connector's `download_file_content` for video. It's signed in to the wrong account anyway, and it returns the file as base64 into the context.

## The loop for each batch of clips

From `marketing/video/`, with `V=~/.venvs/video/bin/python`:

1. **Fetch** the new clips: `$V fetch_clips.py` (above).
2. **Set up:** `bash setup.sh`. The first time in a container it takes about 30 s. After that it does nothing.
3. **Cut:** `$V edit.py out/raw/*.MOV`. Every script in every file is found. A second take of the same script lands in `<id>-2/`. Five clips take about 10 minutes: roughly 20 s of whisper per clip, then 1-2 minutes of rendering per video.
4. **Look.**
   - Read every `!` warning and `~` difference in the summary.
   - Pull frames from `out/renders/<id>/reel-9x16.mp4` with `ffmpeg -ss T -i FILE -frames:v 1 frame.png` and look at them with Read. Use times from `report.json`'s plan: the hook at about 1 s, each chip's start + 0.7 s, a caption, and the end card's start + 1 s.
   - Check that it's the right take, that no flub or restart is left, that the days, numbers and names are right, that captions are readable and off the face, and that the end-card address is right.
   - Listen to it once.
5. **Fix.** Either hand-edit the plan in `report.json` (segments, chip times) and run `$V render.py out/renders/<id>/report.json`, or ask Tristen for a retake.
6. **Approve.** Send Tristen the finished `reel-9x16.mp4` (for example with the session's send-file tool) with the summary lines, and wait for his OK.
7. **Post.**
   - First the dry run: `$V post_reel.py post out/renders/<id>/reel-9x16.mp4 --video <id>`. Read it: Page, time in town time and UTC, caption, file checks.
   - Then the same command with `--go`. It schedules the reel for `post_at_local`.
   - Add a row to the posted log at the end of this file.
8. **Confirm:** `$V post_reel.py status --town <slug>` should show it scheduled, and after the time, published.

## Rules

- **Never post a cut Tristen hasn't seen**, unless he has said to go ahead without him.
- **A warning about a day, number, name or web address blocks posting.** These are "Wrong day?", "Wrong number?", "Wrong name?", "Missing...", "Extra..." and "Wrong web address?". Fix it (re-cut or retake), or post only if Tristen approves it as is. A speed-up warning alone is fine. Over 16.5 s needs a tighter take: cut the middle event, never the sign-up line.
- **Never ack, mark done, draft or otherwise change anything in HQ.** `hq_feedback.py` only reads, so don't reach HQ's other routes by any other means either. Caspian's inbox state depends on it.
- **The ledger doesn't survive a new container.** `out/posted.json` is how `post_reel.py` refuses a double post, and Meta may not list scheduled reels. A fresh container starts with an empty ledger, so nothing stops a second post. Before any `--go` there, read the posted log at the end of this file and run `status`. Use `--force` only when you're sure nothing for that video is live or scheduled.
- **Keep the repo clean.** Raw takes, renders and feedback (readers' words) stay under `out/` and are never committed. Tokens live only in environment variables.
- **Keep the campaign out of his work accounts.** Don't create, store or look for anything for it with the Google Drive or Gmail connectors: they're his Foresite account.
- **Give Tristen one simple step at a time.** He asked for it: one short, numbered instruction per message, then wait for "done".

### Video 3 (week of Nov 2) is a draft

Refresh all five after the **Sunday Nov 1 collect**. The collect runs at 3:23 PM town time, and the site publishes the new list right away.

1. Read each site's `/next-week` page, for example https://www.thestar402.com/next-week. From Mon Oct 26 through Sun Nov 1 it shows Mon Nov 2 to Sun Nov 8, so a draft can be prepared earlier and confirmed after the collect.
2. Open each event's own page and confirm the day, time, place, and that it's still on.
3. Rewrite the script in the same shape, about 42-46 spoken words: hook, two or three events with their days, the sign-up line, "the whole week's in your inbox tomorrow morning", and the domain.
4. In `scripts.json`, update `say`, `hook`, the `chips` (each `cue` must be a word that's actually said) and `caption`, then set `"draft": false`.
5. Mirror the changes in `SCRIPTS.md`.
6. Run `$V -m pytest tests -q`. It checks every script plans cleanly, fits the safe zones and has a real post time.
7. Send Tristen the new lines to film.

The posts are due at 6:30 PM that evening, so the window is short. If a slot is missed, see the schedule note above.

## Pending: Tristen only (as of Oct 23)

1. ~~Share the Drive folder.~~ Done Oct 23: **Town Newsletters** in his personal Drive, shared by link.
2. **Add the two secrets, then start a new session.** He's being walked through it one step at a time:
   - `HQ_ASSISTANT_TOKEN`: the value of `HQ_READ_TOKEN` on Railway (Tristen HQ → hq → Variables), added as an environment variable (the environment menu in the session's title bar → Edit).
   - `META_TOKEN`: in Meta Business Settings → Users → System users, the system user the sites already use: assign the five Pages, then Generate new token (never expires) with `pages_show_list`, `pages_read_engagement`, `pages_manage_posts` and `read_insights`. A new token doesn't revoke the ones on Railway. Added as an environment variable the same way.

   Video 1 posts Sun Oct 25 at 6:30 PM, so this needs to happen before then. If a session starts without them, `post_reel.py check` and `hq_feedback.py` say so.

Filming is his too: two takes of each script, phone at eye level, face in the top half of the frame (SCRIPTS.md has the notes).

## Status on Oct 23

- **Built:** all the tools, reviewed adversarially. Locally, 450 tests pass, slow ones included. The repo-root CI-style run passes on Python 3.11 (1332 passed, 6 skipped).
- **Proven end to end on fake raw takes:** `edit.py` cut every town's video 1 from a TTS voice over a test-pattern picture, with flubs, restarts, pauses, a second take, iPhone-style HEVC HLG and 4K. The results are in `out/samples/e2e/`, and `out/samples/contact-sheet.png` shows the look. Every reel passes `post_reel.py`'s file checks.
- **Not done yet:**
  - No real iPhone take has been cut.
  - Nothing has been posted: the successful `--go` path has only run against mocks and a local stand-in for Meta, so watch the first real post with `status`.
  - No real HQ pull has run, because there is no key.
- **Known limits:**
  - Whisper word timing was tuned on clean TTS audio.
  - Captions use whisper's spelling of matched words, so you can get "weeks" for "week's".
  - A word whisper hears as another one is captioned as heard. It shows as a `~` line, or as a warning when it's a day, number, name or web address.

## Posted log

Add one row per `--go`, straight after it. Once committed, this table is the only record that outlives the container.

| Video | Meta video id | State | Scheduled for (UTC) | Posted by / date |
|---|---|---|---|---|
| (none yet) | | | | |
