#!/usr/bin/env python3
"""Fit English narration to the recorded beat windows.

Read caption, zh, and voice text from beats.json and timing from timeline.json.
Measure synthesized clips, adjust speech rate, then apply atempo if needed.
Cache synthesized clips unless --fresh is passed.
Usage: python3 scripts/demo_voice.py [--dir shots-demo] [--voice en-US-AndrewNeural]
                                   [--out shots-demo/voice.m4a] [--keep-segments] [--probe]"""

from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import subprocess
import sys
from pathlib import Path

try:
    import imageio_ffmpeg
    FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
except Exception:  # pragma: no cover
    FFMPEG = shutil.which("ffmpeg")
if not FFMPEG:
    sys.exit("ffmpeg not found: pip install imageio-ffmpeg or install system ffmpeg")

try:
    import edge_tts
except Exception:  # pragma: no cover
    sys.exit("edge-tts not found: pip install edge-tts")

SR = 48000

# Leave silence before and after each beat's narration.
LEAD = 0.35
TAIL = 0.45

# Target fraction of the available narration window.
FILL = 0.90

# Bound speech-rate adjustments before applying atempo.
RATE_MIN, RATE_MAX = -15, 30

# Limit simultaneous network synthesis requests.
CONCURRENCY = 4


def ff_duration(path: Path) -> float:
    """Read duration from ffmpeg output; no ffprobe is required."""
    r = subprocess.run([FFMPEG, "-hide_banner", "-i", str(path)],
                       capture_output=True, text=True)
    for line in r.stderr.splitlines():
        if "Duration:" in line:
            raw = line.split("Duration:")[1].split(",")[0].strip()
            hh, mm, ss = raw.split(":")
            return int(hh) * 3600 + int(mm) * 60 + float(ss)
    return 0.0


async def synth(text: str, voice: str, rate_pct: int, out: Path) -> None:
    """Synthesize one clip; rate_pct is relative to the default speech rate."""
    rate = f"{rate_pct:+d}%" if rate_pct else "+0%"
    comm = edge_tts.Communicate(text, voice, rate=rate)
    await comm.save(str(out))


async def synth_retry(text: str, voice: str, rate_pct: int, out: Path,
                      tries: int = 4) -> None:
    for n in range(1, tries + 1):
        try:
            await synth(text, voice, rate_pct, out)
            if out.exists() and out.stat().st_size > 1200:
                return
        except Exception as e:  # noqa: BLE001
            if n == tries:
                raise
            print(f"      Synthesis failed ({e}); retry {n}/{tries}...")
        await asyncio.sleep(1.2 * n)
    raise RuntimeError(f"Synthesis failed: {text[:40]}")


def atempo_chain(factor: float) -> str:
    """Chain atempo filters so each factor stays within 0.5 to 2.0."""
    parts: list[float] = []
    f = factor
    while f > 2.0:
        parts.append(2.0)
        f /= 2.0
    while f < 0.5:
        parts.append(0.5)
        f /= 0.5
    parts.append(f)
    return ",".join(f"atempo={p:.6f}" for p in parts)


def fit_one(seg_dir: Path, i: int, beat_id: str, text: str, voice: str,
            window: float, fresh: bool = False) -> dict:
    """Fit narration to its beat window and return measured timing. Cache the default-rate clip unless fresh is set."""
    usable = max(1.0, window - LEAD - TAIL)
    raw0 = seg_dir / f"{i:02d}-{beat_id}-raw0.mp3"
    raw = seg_dir / f"{i:02d}-{beat_id}-raw.mp3"
    fin = seg_dir / f"{i:02d}-{beat_id}.mp3"


    if raw0.exists() and raw0.stat().st_size > 1200 and not fresh:
        dur0 = ff_duration(raw0)
    else:
        asyncio.run(synth_retry(text, voice, 0, raw0))
        dur0 = ff_duration(raw0)

    want = dur0
    rate_pct = 0
    if dur0 > 0:
        desired = dur0 / (usable * FILL)
        rate_pct = round((desired - 1) * 100)
        rate_pct = max(RATE_MIN, min(RATE_MAX, rate_pct))
        if abs(rate_pct) < 5:
            rate_pct = 0

    key = seg_dir / f"{i:02d}-{beat_id}-rate{rate_pct:+03d}.mp3"
    if rate_pct:
        if key.exists() and key.stat().st_size > 1200 and not fresh:
            shutil.copyfile(key, raw)
        else:
            asyncio.run(synth_retry(text, voice, rate_pct, raw))
            shutil.copyfile(raw, key)
        dur1 = ff_duration(raw)
    else:
        shutil.copyfile(raw0, raw)
        dur1 = dur0


    tempo = 1.0
    if dur1 > usable:
        tempo = dur1 / usable
        cmd = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
               "-i", str(raw), "-af", atempo_chain(tempo),
               "-ac", "1", "-ar", str(SR), str(fin)]
        if subprocess.run(cmd, capture_output=True).returncode != 0:
            raise RuntimeError(f"atempo failed: {beat_id}")
    else:
        shutil.copyfile(raw, fin)

    dur = ff_duration(fin)
    return {
        "id": beat_id, "window": round(window, 2), "usable": round(usable, 2),
        "dur_raw": round(dur0, 2), "rate_pct": rate_pct,
        "dur_after_rate": round(dur1, 2), "tempo": round(tempo, 3),
        "dur": round(dur, 2), "over": round(max(0.0, dur - usable), 2),
        "text": text,
    }


def build_segments(seg_dir: Path, beats: list[dict], tl: list[dict],
                   total: float, fps: int) -> Path:
    """Pad each clip to its beat window and concatenate an audio track matching the video duration."""
    t0_first = tl[0]["t0"]
    parts: list[Path] = []


    if t0_first > 0.02:
        lead = seg_dir / "00-lead.wav"
        _silence(lead, t0_first)
        parts.append(lead)

    cursor = t0_first
    for i, (b, t) in enumerate(zip(beats, tl)):
        window = round(t["t1"] - t["t0"], 3)
        seg = seg_dir / f"{i:02d}-{b['id']}.mp3"
        wav = seg_dir / f"seg{i:02d}.wav"

        cmd = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
               "-i", str(seg),
               "-af", f"adelay={int(LEAD * 1000)}|{int(LEAD * 1000)},"
                      f"aresample={SR},aformat=channel_layouts=stereo,"
                      f"apad,atrim=0:{window}",
               "-t", str(window), "-ac", "2", "-ar", str(SR),
               "-c:a", "pcm_s16le", str(wav)]
        if subprocess.run(cmd, capture_output=True).returncode != 0:
            raise RuntimeError(f"Failed to pad audio segment: {b['id']}")
        parts.append(wav)
        cursor += window


    if cursor < total - 0.02:
        tail = seg_dir / "99-tail.wav"
        _silence(tail, total - cursor)
        parts.append(tail)

    listing = seg_dir / "concat.txt"
    listing.write_text("".join(f"file '{p.resolve()}'\n" for p in parts))
    return listing


def _silence(path: Path, seconds: float) -> None:
    cmd = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
           "-f", "lavfi", "-t", f"{seconds:.3f}",
           "-i", f"anullsrc=channel_layout=stereo:sample_rate={SR}",
           "-c:a", "pcm_s16le", str(path)]
    if subprocess.run(cmd, capture_output=True).returncode != 0:
        raise RuntimeError(f"Failed to generate silence: {path.name}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="shots-demo")
    ap.add_argument("--voice", default="en-US-AndrewNeural",
                    help="edge-tts voice name (default: en-US-AndrewNeural)")
    ap.add_argument("--out", default="", help="Default: <dir>/voice.m4a")
    ap.add_argument("--keep-segments", action="store_true", help="Keep per-beat audio clips for review")
    ap.add_argument("--fresh", action="store_true",
                    help="Synthesize again instead of reusing cached clips")
    ap.add_argument("--probe", action="store_true",
                    help="Measure speech rate and beat windows without writing the final track")
    args = ap.parse_args()

    src = Path(args.dir)
    beats_path = src / "beats.json"
    tl_path = src / "timeline.json"
    if not beats_path.exists():
        sys.exit(f"Missing {beats_path}: run node scripts/record_demo.mjs --dump-beats --calls=N first")
    if not tl_path.exists():
        sys.exit(f"Missing {tl_path}: run node scripts/record_demo.mjs first")

    beats_all = json.loads(beats_path.read_text())["beats"]
    tl_doc = json.loads(tl_path.read_text())
    tl = tl_doc["beats"]
    total = tl_doc["duration"]
    fps = tl_doc.get("fps", 15)


    by_id = {b["id"]: b for b in beats_all}
    missing = [t["id"] for t in tl if t["id"] not in by_id]
    if missing:
        sys.exit(f"Timeline beats missing text in beats.json: {', '.join(missing)}")
    beats = [by_id[t["id"]] for t in tl]

    blank = [b["id"] for b in beats if not (b.get("voice") or b.get("caption"))]
    if blank:
        sys.exit(f"Beats missing narration: {', '.join(blank)}")

    print(f"Beats {len(beats)}; video duration {total:.1f}s; voice {args.voice}")

    seg_dir = src / "voice"
    if seg_dir.exists() and args.fresh:
        shutil.rmtree(seg_dir)
    seg_dir.mkdir(parents=True, exist_ok=True)

    rows: list[dict] = []
    for i, (b, t) in enumerate(zip(beats, tl)):
        text = b.get("voice") or b["caption"]
        window = t["t1"] - t["t0"]
        r = fit_one(seg_dir, i, b["id"], text, args.voice, window, fresh=args.fresh)
        rows.append(r)
        flag = ""
        if r["over"] > 0.05:
            flag = f"  over by {r['over']:.2f}s"
        elif r["tempo"] > 1.001:
            flag = f"  atempo x{r['tempo']:.2f}"
        print(f"  {i + 1:>2}. {b['id']:8s} window {r['window']:5.1f}s  "
              f"speech {r['dur']:5.1f}s  rate {r['rate_pct']:+3d}%{flag}")

    bad = [r for r in rows if r["over"] > 0.15]
    if bad:
        print("\nNarration exceeds these beat windows and would overlap the next beat:")
        for r in bad:
            print(f"    {r['id']}  over by {r['over']:.2f}s; text {len(r['text'])} characters")
        print("  Shorten these lines in record_demo.mjs BEATS, then run --dump-beats. "
              "Keep the current speech-rate limits.")

    slow = [r for r in rows if r["rate_pct"] <= RATE_MIN or r["rate_pct"] >= RATE_MAX]
    if slow:
        print(f"\n  Beats at speech-rate limits ({RATE_MIN}% to {RATE_MAX}%):"
              f"{'、'.join(r['id'] for r in slow)}")

    if args.probe:
        print("\n(--probe: measurements only)")
        return

    listing = build_segments(seg_dir, beats, tl, total, fps)
    out = Path(args.out) if args.out else src / "voice.m4a"
    cmd = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
           "-f", "concat", "-safe", "0", "-i", str(listing),
           "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", str(SR),
           "-movflags", "+faststart", str(out)]
    if subprocess.run(cmd, capture_output=True).returncode != 0:
        sys.exit("Audio encoding failed")

    d = ff_duration(out)
    print(f"\n✓ {out}  {out.stat().st_size / 1024 / 1024:.2f} MB  {d:.2f}s"
          f"  (video {total:.2f}s)")
    print(f"  Next command:python3 scripts/demo_caption.py --dir {src} "
          f"--out docs/Training-Failure-Triage-demo.mp4 --voice {out}")

    if not args.keep_segments:
        for p in seg_dir.glob("seg*.wav"):
            p.unlink(missing_ok=True)
        for p in seg_dir.glob("*-lead.wav"):
            p.unlink(missing_ok=True)
        for p in seg_dir.glob("*-tail.wav"):
            p.unlink(missing_ok=True)
        listing.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
