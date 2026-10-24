# Subscribe video ads: handoff

This is for a Claude session that has none of the earlier conversation. The `town-videos` skill (`.claude/skills/town-videos/SKILL.md`) is the routine: write scripts, cut takes, load and launch ads. [README.md](README.md) covers the tools. This file holds the campaign's current state, what's been decided, what's still open, and the ad log. Updated Sat Oct 24, 2026.

## The campaign

- **Five towns, each with a Facebook Page and an ad campaign.** Each has a free events newsletter: the *week* issue on Monday morning and the *weekend* issue on Thursday morning.

  | Slug | Town | Site | Campaign (in "The Vic Ads", act_2614503002399063) |
  |---|---|---|---|
  | `victoria` | The Vic 361 | thevic361.com | Vic Newsletter Leads |
  | `lincoln` | The Star 402 | thestar402.com | The Star 402 Newsletter Leads |
  | `medford` | The Rogue 541 | therogue541.com | The Rogue 541 Newsletter Leads |
  | `shoals` | Shoals Setlist | shoalssetlist.com | Shoals Setlist Newsletter Leads |
  | `virginiabeach` | The Tide 757 | thetide757.com | The Tide 757 Newsletter Leads |

  Kearney (The Crane 308) and Tupelo (Tupelo Current) have no Page or campaign, so they're out.
- **These are ads, not Page posts.**
  - Each campaign is OUTCOME_LEADS, optimizing for the pixel's Lead event (a signup on the site), with a campaign daily budget: $55, or $68 for Victoria.
  - On Oct 23 all five were paused. Their October ad sets had ended that day; Victoria's "Halloween Ad" runs to Sun Oct 25, 6:27 PM CDT.
  - Tristen ran these ads before; the videos replace the creative.
- **Baseline: the 7 days to Oct 23** (`ads.py status`). The new videos need to beat this.

  | Town | Spent | Signups (Lead) | Per signup |
  |---|---|---|---|
  | Star 402 | $360 | 435 | $0.83 |
  | Rogue 541 | $358 | 513 | $0.70 |
  | Shoals Setlist | $353 | 593 | $0.60 |
  | Tide 757 | $357 | 578 | $0.62 |
  | Vic 361 | $17 | 11 | $1.56 |
- **Two ads per town** (scripts.json, SCRIPTS.md):
  - **Video 1, Halloween week:** `<town>-2026-10-25`, running Sun Oct 25 6 PM to Sat Oct 31 5 PM, town time.
  - **Video 2, evergreen:** `<town>-2026-11-01`, from Sun Nov 1 6 AM, with no end date yet (decision 1 below).

  Both are written to stay true all week, with no spoken weekday names and no "tonight". Each ends on the newsletter's name, which is where the end card starts.
- **The look and the style** follow Tristen's own Victoria ad (`TheVic361_signup_B_4x5.mp4`, which he uploaded to the session; it isn't in the repo). It's 4:5 with a corner badge, event cards, word-by-word captions, a phone and his "Sign up free" end card. His spoken style: "There's a lot going on in Victoria that you don't know about, because you're not subscribed... just click the link."
- **What readers want** (`hq_feedback.py`, Oct 23: 72 messages from 61 readers, mostly answers to the welcome email's "what are you into?"): live music first by far, then food and drink, markets and art. Family comes up mostly in Victoria. Medford readers asked who plays at the wineries.

## Where things live

- **Scripts:** `scripts.json` is the source of truth. `SCRIPTS.md` is Tristen's filming sheet, sent to him as a file.
- **Raw takes:** **Town Newsletters**, a folder in his **personal** Google Drive shared as "Anyone with the link": https://drive.google.com/drive/folders/1F77hwtz4YWNGtnEXzs2W2IMHmd3IhTBW. `fetch_clips.py` reads it from that link.
- **Not his work accounts.** The Google Drive and Gmail connectors in these sessions are his Foresite account. Nothing for this campaign goes there.
- **Made locally** (raw takes, renders, `out/ads.json`, `out/posted.json`, reader feedback): under `marketing/video/out/`. Git ignores it, and it doesn't survive a new container.
- **HQ, his owner dashboard:** https://hq.tristenpalori.com. Reader replies land in its inbox.

## Access the session needs (all working on Oct 23)

All of these are network secrets in the cloud environment (environment menu → Edit → **Add secret**). The proxy adds them on one host each, and they reach a running session at once. Never use the environment variables box for keys: anyone using the environment can see it. Never ask Tristen to paste a key into the chat.

| What | Set up as | Check with |
|---|---|---|
| Meta | A never-expiring token of the system user **Tristen's poster**, which has all five Pages (full access) and the ad account. Its permissions include `ads_management`, `ads_read`, `pages_manage_posts`, `pages_read_engagement`, `pages_show_list` and `read_insights`. It's a secret on `graph-video.facebook.com`, Bearer, `Authorization`. Not `graph.facebook.com`: the proxy replaces any Authorization header on a secret's host, and post_reel's Page calls carry each Page's own token there. ads.py sends every Marketing API call to graph-video. | `ads.py status`, `post_reel.py check` |
| HQ | HQ's assistant key (`HQ_READ_TOKEN` on Railway: Tristen HQ → hq), the same key Caspian uses, for **read-only** use. It's a secret on `hq.tristenpalori.com`, Bearer, `Authorization`. | `hq_feedback.py` |
| Raw takes | Nothing to add: the folder is shared by link. | `fetch_clips.py --list` |
| Network | `graph.facebook.com`, `graph-video.facebook.com`, `rupload.facebook.com`, `drive.google.com`, `drive.usercontent.google.com`, `hq.tristenpalori.com`, and `huggingface.co` plus PyPI for setup. | `setup.sh` |

## Pending decisions (ask Tristen, one at a time)

1. **The evergreen ads have no end date.** Each would spend its campaign's daily budget ($55, or $68 for Victoria) until stopped. Should they run until he says stop, with a weekly results check from `ads.py status`, or end on a date? Set `run_until_local` to match before uploading.
2. **Pausing the old ads:** assumed yes unless he objects. `go` pauses each campaign's other ads, including Victoria's "Halloween Ad".
3. **Budgets (just so he knows):** every campaign is over `scripts/meta_ads.py`'s $50/day cap. ads.py never changes a budget.
4. **A separate problem, not this campaign:** the site's `scripts/meta_ads.py` defaults to Marketing API v23.0, which Meta retired on June 9, 2026. No jobs service sets `GRAPH_API_VERSION`. Its daily report still reads, but its pause/resume/budget commands may fail. He was told; it's his call when to fix.

## Status on Oct 24

- **Scripts:** 10 written in his style, checked with `test_scripts.py`, and sent to him as SCRIPTS.md. He's filming. Video 1s are needed by Sunday afternoon.
- **Tools:** the renderer has his look, with face-aware cards (after his feedback that a draft's cards covered his eyes). ads.py is built. 648 tests pass.
  - Being finished on Oct 24: keeping the phone off his eyes, and stacking rapid-fire cards (the evergreen lists) into one list card.
  - Samples are in `out/samples/v2/` (`comparison.png`: his frames over ours).
- **Nothing has been uploaded or turned on.** Watch the first real `upload --go` with `status`. The docs leave two things open: whether an open-ended ad set copy (`end_time=0`) runs under a campaign budget, and whether Meta still appends " - Copy" to the names (name matching tolerates it).
- **Not done:** no real iPhone take has been cut yet. Whisper timing and face detection were tuned on synthetic footage.

## Rules

See the skill. In short:
- never `go --go` without his OK on the video and its spend;
- a warning about a day, number, name or address blocks the ad;
- never change a budget or touch the other ad account (`act_263113944523091`);
- never ack HQ items;
- never commit `out/`;
- one simple step at a time with him.

## Ad log

Add a row for each `upload --go` and `go --go`, straight after it. Once committed, this table is the only record that outlives the container.

| Video | Ad set copy | Ad | State | Window (town time) | When / who |
|---|---|---|---|---|---|
| (none yet) | | | | | |
