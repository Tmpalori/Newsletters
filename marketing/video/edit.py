#!/usr/bin/env python3
"""Cut the subscribe videos: raw takes in, finished Reels out.

    python3 marketing/video/edit.py RAW [RAW...] [--video ID] [--transcript JSON]
                                    [--out DIR] [--formats 9x16,4x5] [--model M]

For each raw file, analyze.py finds the scripts in it and plans the cut, and
render.py renders every plan in every format. Per video it writes, under
<out>/<video_id>/ (default out/renders/, which git ignores):

    reel-9x16.mp4   the Reel (1080x1920)
    feed-4x5.mp4    the feed ad (1080x1350)
    thumb.jpg       a frame 0.8 s in, hook up
    report.json     the plan, what each render did and an ffprobe summary
                    of each file; `python3 render.py report.json` re-renders
                    it after a hand fix to the plan

and prints a short summary with every warning a person must read before
anything is posted (a wrong day or number, a low match, a speed-up), then
each other word that differs from the script (~ lines: the captions show
what was heard). When
two raw files hold the same script, the second take goes to <video_id>-2/
(still posted as <video_id>) rather than over the first.
"""
import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import render  # noqa: E402

DEFAULT_OUT = os.path.join(HERE, "out", "renders")


def cut(plan, out_root, formats, log=print, folder=None, notes=()):
    """Render one plan in every format, plus its thumbnail and report.json,
    into <out_root>/<folder or video_id>/. Returns the report."""
    # Before the folder exists: its name comes from the plan's video_id.
    render.check_plan(plan)
    out_dir = os.path.join(out_root, folder or plan["video_id"])
    os.makedirs(out_dir, exist_ok=True)
    report = {"video_id": plan["video_id"], "generated": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
              "plan": plan, "renders": {}, "thumb": None, "notes": list(notes)}
    for layout in formats:
        log(f"  rendering {plan['video_id']} {layout} ...")
        info = {}
        t0 = time.monotonic()
        path = render.render(plan, out_dir, layout, info=info)
        info["seconds"] = round(time.monotonic() - t0, 1)
        report["renders"][layout] = {"file": os.path.basename(path), "render": info,
                                     "probe": render.summarize(path),
                                     "loudness": render.loudness(path)}
    if report["renders"]:
        # The Reel's frame if there is one: that's the thumbnail Facebook shows.
        first = report["renders"].get("9x16") or next(iter(report["renders"].values()))
        render.thumbnail(os.path.join(out_dir, first["file"]), os.path.join(out_dir, "thumb.jpg"))
        report["thumb"] = "thumb.jpg"
    tmp = os.path.join(out_dir, ".report.json.part")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, os.path.join(out_dir, "report.json"))
    report["dir"] = out_dir
    return report


def script_diff(plan):
    """Where the kept words differ from the script and no warning says so
    already. Whisper's slip on an ordinary word ("Fue" for "Free") is no
    warning, but it is burned into the captions as heard, so the person
    approving the cut reads these too."""
    warned = " ".join(str(w) for w in plan.get("warnings") or [])
    out = []
    for d in plan.get("diff") or []:
        if not isinstance(d, dict):
            continue
        try:
            at = f"{float(d.get('at')):.1f}"
        except (TypeError, ValueError):
            at = "?"
        if f"At {at}s" in warned:
            continue  # a wrong day, number, name or address: already a warning
        script, spoken = d.get("script") or "", d.get("spoken") or ""
        if d.get("kind") == "substitute":
            out.append(f'At {at}s heard "{spoken}" where the script says "{script}" (captioned as heard)')
        elif d.get("kind") == "omit":
            out.append(f'At {at}s "{script}" was not said')
        elif d.get("kind") == "insert":
            out.append(f'At {at}s heard "{spoken}", which is not in the script (captioned)')
    return out


def summary(report):
    """The lines a person reads before posting: what was cut, how it came
    out, every warning from the plan and the render, and (~) every other
    place the words differ from the script."""
    p = report["plan"]
    takes = p.get("takes") or []
    take = (p.get("take") or 0) + 1
    lines = [f"{p['video_id']}  take {take} of {len(takes) or 1}, similarity {float(p.get('similarity') or 0):.2f}, "
             f"{p['duration']:.2f} s at {float(p.get('speed') or 1):.3f}x"]
    for layout, r in report["renders"].items():
        v = r["probe"].get("video") or {}
        loud = r["loudness"].get("integrated")
        lines.append(f"  {r['file']:<14} {v.get('width')}x{v.get('height')}  {v.get('duration') or 0:.2f} s"
                     f"  {loud if loud is not None else '?'} LUFS  ({r['render'].get('seconds')} s to render)")
    lines.append(f"  {report['dir']}")
    warnings = list(report.get("notes") or []) + list(p.get("warnings") or [])
    for r in report["renders"].values():
        warnings += [n for n in r["render"].get("notes") or [] if n not in warnings]
    lines += [f"  ! {w}" for w in warnings] or ["  no warnings"]
    lines += [f"  ~ {d}" for d in script_diff(p)]
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Cut raw takes into the subscribe Reels.")
    ap.add_argument("raw", nargs="+", help="raw video file(s) off the phone")
    ap.add_argument("--video", help="only this script id, e.g. victoria-1")
    ap.add_argument("--transcript", help="word-timestamp JSON to use instead of whisper (one RAW only)")
    ap.add_argument("--model", help="whisper model for analyze.py")
    ap.add_argument("--out", default=DEFAULT_OUT, help="output folder (default %(default)s)")
    ap.add_argument("--formats", default="9x16,4x5", help="comma-separated: 9x16, 4x5 (default %(default)s)")
    args = ap.parse_args(argv)

    formats = [f.strip() for f in args.formats.split(",") if f.strip()]
    bad = [f for f in formats if f not in render.LAYOUTS]
    if bad or not formats:
        ap.error(f"unknown format {', '.join(bad) or '(none)'}; choose from {', '.join(render.LAYOUTS)}")
    if args.transcript and len(args.raw) > 1:
        ap.error("--transcript belongs to one recording; give one RAW with it")
    missing = [r for r in args.raw if not os.path.isfile(r)]
    if missing:
        ap.error(f"no such file: {', '.join(missing)}")

    # Here, not at the top: analyze.py pulls in whisper, and render.py (and
    # its tests) must work on a machine without it.
    import analyze

    kwargs = {}
    if args.video:
        kwargs["video_id"] = args.video
    if args.transcript:
        kwargs["transcript"] = args.transcript
    if args.model:
        kwargs["model"] = args.model

    reports, problems = [], []
    # video_id -> the raw files it was cut from in this run, so a second
    # take of the same script (in another file) gets its own folder instead
    # of silently replacing the first one's videos.
    cut_from = {}
    for raw in args.raw:
        print(f"{raw}: finding scripts ...")
        try:
            plans = analyze.plan(raw, **kwargs)
        except Exception as e:  # one bad file shouldn't stop the batch
            problems.append(f"{raw}: analysis failed: {e}")
            continue
        if args.video:
            plans = [p for p in plans if p.get("video_id") == args.video]
        if not plans:
            problems.append(f"{raw}: no script found" + (f" for {args.video}" if args.video else ""))
            continue
        for plan in plans:
            vid = str(plan.get("video_id", "?"))
            before = cut_from.get(vid, [])
            folder, notes = None, []
            if before:
                folder = f"{vid}-{len(before) + 1}"
                notes.append(f"{vid} was also cut from {os.path.basename(before[0])}; this take is in "
                             f"{folder}/ so it doesn't replace that one: pick one to post")
            try:
                reports.append(cut(plan, args.out, formats, folder=folder, notes=notes))
            except Exception as e:  # nor should one bad plan
                problems.append(f"{raw}: {vid} failed to render: {e}")
                continue
            cut_from.setdefault(vid, []).append(raw)

    print()
    for r in reports:
        print(summary(r))
        print()
    for p in problems:
        print(f"FAILED {p}")
    if reports:
        print(f"{len(reports)} video{'s' if len(reports) != 1 else ''} ready in {os.path.abspath(args.out)}")
    return 1 if problems or not reports else 0


if __name__ == "__main__":
    sys.exit(main())
