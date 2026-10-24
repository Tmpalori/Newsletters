---
name: town-videos
description: Make the 16-second subscribe video ads for the five newsletter towns. Write the scripts from the sites' events and readers' feedback, edit Tristen's raw takes, and load them into each town's Meta ad campaign, paused until he says go. Use when Tristen says new videos or clips are in, asks for new video or ad scripts, or wants the town ads edited, launched, paused or checked on.
---

# Town videos

Tristen films short selfie videos that run as **Meta ads** to get people to subscribe to each town's free events newsletter. You write the scripts, edit his takes and load them into the ad campaigns. Everything lives in `marketing/video/`: [README.md](../../../marketing/video/README.md) explains the tools, and [HANDOFF.md](../../../marketing/video/HANDOFF.md) has the current state, pending decisions and the ad log. Read HANDOFF.md first.

## Working with Tristen

- He wants **one simple step at a time**: one short numbered instruction, then wait for "done". No jargon.
- Keys live in the cloud environment's **network secrets** ("Add secret"), never in its environment variables, which anyone using the environment can see. Never ask him to paste a key into the chat.
- Everything for this lives in his **personal** Google Drive. The Drive and Gmail connectors here are his Foresite work account, so don't use them for any of this.
- He okays every finished video, and every `go` that starts spending money.

## Setup, each new session

```bash
cd marketing/video
bash setup.sh                 # the first time in a container, then a no-op
V=~/.venvs/video/bin/python
$V ads.py status              # Meta access, and what each town's ads did this week
```

If Meta says there's no key, walk him through "Access the session needs" in HANDOFF.md, one step at a time.

## A. New scripts ("make new ads")

The ads run **a week or more**, so a script must stay true for the whole run:

- **No weekday names in the spoken lines,** and no "tonight" or "tomorrow morning". Dates go on the event cards (the `tag`), where they read as dates.
- **Two kinds:**
  - A **timely** ad for one week (Sunday to Saturday), built on that week's events.
  - An **evergreen** ad with no dates, built on what readers say they want, which can run for weeks. Run `$V hq_feedback.py` for the themes; live music led in October 2026.
- **His style,** from his own Victoria ad:
  - what you're missing ("There's a lot going on in Victoria you don't know about, because you're not subscribed");
  - a few real examples;
  - "It's all in one free email, every Monday and Thursday";
  - "Just click the link to get The Vic 361."
- **Aim for 38-46 spoken words.**
- **End on the newsletter's name.** The end card starts at the last time the name or address is said.

Steps:

1. **Get the events.** `$V events.py` (next week) or `$V events.py --when weekend`, narrowed with `--from` and `--to`.
2. **Write each town's script.** For a timely ad, check every fact on the event's own page: day, place, and that it's still on. Never invent or embellish.
3. **Archive the old batch.** Move scripts.json's `videos` to `scripts-archive/<first start date>.json`. New ids are `<town>-<start date>`, for example `lincoln-2026-11-08`, so they never collide with anything already loaded.
4. **Fill in scripts.json.** Copy the fields of the entries already there:
   - `say` and `hook` (the corner badge: at most 40 characters, no emoji; a number like "8" or "100+" gets a pill).
   - `chips`, the event cards: `icon` (one emoji), `tag` (a date, or "Every week"), `title`, `venue`, `cue` (the spoken word that pops the card), `text` (a one-line fallback) and optionally `"free": true`.
   - `headline` (at most 40 characters; 27 is Meta's Feed ideal).
   - `caption`, the ad's primary text. About 125-150 characters is ideal, with the town's `subscribe_url`.
   - `post_at_local` and `run_until_local` (`null` = until stopped).
5. **Check them.** Run `$V -m pytest tests/test_scripts.py -q`. It checks the fit in 16 s, that every card's cue is spoken, that the name comes last, and the run window.
6. **Send them to Tristen.** Regenerate `SCRIPTS.md` (same layout: "Say", "Corner badge", "Event cards", "Ad headline", "Ad text") and send it with the send-file tool, plus one line on what to film and by when.
7. **Save.** Commit and push.

## B. New clips ("the videos are in")

1. **Fetch.** `$V fetch_clips.py` downloads the new takes from his shared folder into `out/raw/`.
2. **Cut.** `$V edit.py out/raw/<new files>` works out which script each file holds, cuts out the flubs and pauses, and renders `feed-4x5.mp4` (the ad) and `reel-9x16.mp4`.
3. **Review, before he sees it.**
   - Read every `!` and `~` line. A `!` about a day, number, name or web address blocks the ad.
   - Look at frames of the badge, each card, the phone and the end card. No card or phone should cover his eyes: `report.json` has the face box and each card's slot.
   - Listen to it once.
4. **Approve.** Send him the 4:5 file with a one-line note, and wait for his OK.
5. **Load it.**
   - `$V ads.py plan <feed-4x5.mp4> --video <id>`, then the same `upload ... --go`. This makes the ad, **paused**.
   - Send him the spend line from the plan. On his OK, `$V ads.py go --video <id> --go`, which pauses the campaign's other ads first.
6. **Record it.** Run `$V ads.py status --town <slug>`. Add a row to HANDOFF.md's ad log, then commit and push.

## Rules

- Never `go --go` without his OK for that video and its spend.
- A warning about a day, number, name or web address blocks the ad until it's fixed or he approves it.
- Never change a budget. Never touch the other ad account, `act_263113944523091`.
- Never ack, mark done or draft anything in HQ.
- Raw takes, renders and readers' words stay in `out/`, which git ignores. Never commit them.
- Kearney (The Crane 308) and Tupelo (Tupelo Current) have no Facebook Page or campaign. Skip them until they do.
- Plain Page posts (`post_reel.py`) only if he asks for them.

## When something's off

- **`fetch_clips.py` lists nothing, but he says he uploaded.** Either the folder isn't shared by link, or Drive changed its page markup (see `parse_listing` in fetch_clips.py).
- **`ads.py` fails.** Read the Meta error code and message it prints, then run `status`. The ledger (`out/ads.json`) doesn't survive a new container: check HANDOFF.md's ad log and `status` (it finds our ads by the `[id]` in their names) before uploading again. If Meta won't let the system user use a town's Instagram account, rerun with `--no-instagram`.
- **A card or the phone lands on his face.** Check the face box in report.json. The detector can miss in poor light; a retake in better light fixes it.
- **Whisper keeps mishearing a name.** Spell it in the script exactly as it should appear. Captions use the script's spelling wherever the words match.
