---
name: town-videos
description: Make the weekly 16-second subscribe videos (Facebook Reels) for the five newsletter towns. Write the scripts from the coming week's events, edit Tristen's raw takes, and schedule them on each town's Facebook Page. Use when Tristen says new videos or clips are in, asks for next week's video or ad scripts, or wants the town videos edited, posted or checked on.
---

# Town videos

Tristen films short selfie videos that get people to subscribe to each town's free events newsletter. You write the scripts, edit his takes and post them. Everything lives in `marketing/video/`: [README.md](../../../marketing/video/README.md) explains the tools, and [HANDOFF.md](../../../marketing/video/HANDOFF.md) has the campaign's current state and the posted log. Read HANDOFF.md first.

## Working with Tristen

- He wants **one simple step at a time**: one short numbered instruction, then wait for "done". No jargon.
- Never ask him to paste a token or key into the chat.
- Everything for this lives in his **personal** Google Drive. The Drive and Gmail connectors here are his Foresite work account, so don't use them for any of this.
- He okays every finished video before it posts.

## Setup, each new session

```bash
cd marketing/video
bash setup.sh                 # about 30 s the first time in a container, then a no-op
V=~/.venvs/video/bin/python
$V post_reel.py check         # Meta access, through the network secret for graph-video.facebook.com
```

If `check` says "No Facebook key", posting is blocked. Walk him through "Access the session needs" in HANDOFF.md, one step at a time. Keys go in the environment's **Add secret** (network secrets), never in its environment variables, which anyone using the environment can see.

## A. New scripts ("make next week's videos")

The five towns are in `towns.py`: The Vic 361, The Star 402, The Rogue 541, Shoals Setlist and The Tide 757. Usually there are two videos per town per week:

| Posts | Covers | Ends with |
|---|---|---|
| Sunday, 6:30 PM town time | the coming week (Monday's issue) | "Sign up tonight and the whole week's in your inbox tomorrow morning. Free. *domain*" |
| Wednesday, 6:30 PM town time | the weekend (Thursday's issue) | "Sign up tonight and it's in your inbox tomorrow morning. *domain*" |

1. **Get the events.** Run `$V events.py` for the week, or `$V events.py --when weekend`. Narrow it with `--from` and `--to`.
2. **Optional: see what readers want.** Run `$V hq_feedback.py`, then read `out/feedback/<date>/themes.md` and lean the hooks toward those themes. It only reads. Never touch HQ's inbox state.
3. **Write each town's script.**
   - Open with a hook that stops the scroll: a count ("eight trunk-or-treats"), a surprise ("dolphin watching in October"), a last chance ("closes for good") or something free.
   - Then two or three specific events with their days, then the sign-up line, then the domain last.
   - Aim for 38-46 spoken words, which fits 16 s. Keep it upbeat and conversational.
4. **Check every fact on the event's own page:** day, time, place, and that it's still on. Never invent or embellish. A wrong day in an ad is the worst failure.
5. **Archive the old batch.** Move scripts.json's `videos` into `scripts-archive/<first post date>.json`, creating the folder if needed.
   - New ids are `<town>-<YYYY-MM-DD>`, using the post date (for example `lincoln-2026-11-08`), so they never collide with anything already posted.
   - Keep `cta_cue` and `end_card` as they are.
6. **Write the new entries in scripts.json,** with the same fields the archived ones have:
   - `say`: the script.
   - `hook`: at most 40 characters, upper case, no emoji.
   - `chips`: 1-4 of them. `text` is like "FRI · Rocky Horror (live shadow cast)". `cue` is words actually said that should pop it.
   - `caption`: a line or two, the `subscribe_url` from towns.py and the town's hashtags. Emoji are fine here.
   - `post_at_local`: `"YYYY-MM-DDT18:30"`.
   - Also `draft: false`, `video` (1, 2...) and `angle`.
7. **Check them.** Run `$V -m pytest tests/test_scripts.py -q`. It checks that every script fits 16 s, every chip's cue is spoken, and "tomorrow morning" is only promised on a Sunday or Wednesday post.
8. **Send them to Tristen.** Rewrite `SCRIPTS.md` to match (same layout: per town, "Say", "On screen", "Caption"). Send it with the send-file tool, plus one line on what to film and by when.
9. **Save.** Commit and push scripts.json, SCRIPTS.md and scripts-archive/.

## B. New clips ("the videos are in")

1. **Fetch.** `$V fetch_clips.py` downloads the new takes from his shared folder into `out/raw/`.
2. **Cut.** `$V edit.py out/raw/<new files>` finds which script or scripts each file holds, cuts them and renders. Whisper takes about 20 s per clip, and rendering 1-2 minutes per video.
3. **Review, before he sees it.**
   - Read every `!` and `~` line. A `!` about a day, number, name or web address blocks posting.
   - Look at frames from the hook, each chip, a caption and the end card (`ffmpeg -ss T -i FILE -frames:v 1 x.png`, then Read).
   - Listen to it once.
4. **Approve.** Send him each `out/renders/<id>/reel-9x16.mp4` with a one-line note, and wait for his OK. Re-cut, or ask for a retake if needed.
5. **Post.**
   - Dry run first: `$V post_reel.py post out/renders/<id>/reel-9x16.mp4 --video <id>`.
   - Then the same command with `--go`, which schedules it for `post_at_local`.
   - If that slot has passed, use `--at` for a later time the same evening, before the next issue goes out, or `--now` if he agrees.
6. **Confirm.** Run `$V post_reel.py status --town <slug>`. Add a row to HANDOFF.md's posted log, then commit and push.

## Rules

- Never post a cut he hasn't okayed, unless he has said to go ahead without him.
- A warning about a day, number, name or web address blocks posting until it's fixed or he approves it.
- Never ack, mark done or draft anything in HQ.
- Raw takes, renders and readers' words stay in `out/`, which git ignores. Never commit them.
- Kearney (The Crane 308) and Tupelo (Tupelo Current) have no Facebook Page. Skip them until they do, then add them to towns.py with their Page id.
- Instagram isn't connected for any town.

## When something's off

- **`fetch_clips.py` lists nothing, but he says he uploaded.** Either the folder isn't shared by link, or Drive changed its page markup (see `parse_listing` in fetch_clips.py).
- **`post_reel.py` fails.** Read the Meta error code and message it prints. `status` shows what Meta has. The ledger (`out/posted.json`) doesn't survive a new container, so check HANDOFF.md's posted log before posting anything again.
- **Whisper keeps mishearing a name.** Spell it in the script exactly as it should appear. Captions use the script's spelling wherever the words match.
