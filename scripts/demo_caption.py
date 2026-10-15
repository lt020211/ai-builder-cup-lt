#!/usr/bin/env python3
"""Compose recorded frames, timed bilingual subtitles, and optional narration.

Use beats.json for text and timeline.json for timing. English appears above Chinese.
Usage: python3 scripts/demo_caption.py [--dir shots-demo] [--out docs/Training-Failure-Triage-demo.mp4]
                                     [--fps 15] [--sub-lang both] [--voice shots-demo/voice.m4a] [--keep]
Use --attach <existing.mp4> --voice <voice.m4a> to replace audio without re-encoding video.
To change subtitles after deleting frames, restore them with scripts/rebuild_frames_from_film.py."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

try:
    import imageio_ffmpeg
    FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
except Exception:  # pragma: no cover
    FFMPEG = shutil.which("ffmpeg")
if not FFMPEG:
    sys.exit("ffmpeg not found: pip install imageio-ffmpeg or install system ffmpeg")


FONT_EN = "/System/Library/Fonts/Supplemental/Arial.ttf"
FONT_EN_BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
FONT_ZH_CANDIDATES = [
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
]

INK = (11, 18, 32)
BLUE = (47, 107, 255)
WHITE = (255, 255, 255)
DIM = (148, 163, 184)
ZH_TINT = (203, 213, 225)

PAD = 56
PAD_TOP = 20
PAD_BOTTOM = 18
RESERVE_RIGHT = 104
LINE_GAP = 6

SZ_EN = 24
LH_EN = 30
SZ_ZH = 22
LH_ZH = 29
SZ_PAGE = 15

MAX_EN_LINES = 2
MAX_ZH_LINES = 2


def pick_zh_font() -> str:
    for p in FONT_ZH_CANDIDATES:
        if Path(p).exists():
            return p
    sys.exit("No Chinese font found (tried Hiragino Sans GB / STHeiti / Arial Unicode)")


def wrap(draw: ImageDraw.ImageDraw, text: str, font, max_w: int) -> list[str]:
    """Wrap CJK text by character and English text by word."""
    if not text:
        return []

    if any("\u4e00" <= c <= "\u9fff" or "\u3000" <= c <= "\u303f" for c in text):
        lines, cur = [], ""
        for ch in text:
            if draw.textlength(cur + ch, font=font) <= max_w or not cur:
                cur += ch
            else:
                lines.append(cur)
                cur = ch
        if cur:
            lines.append(cur)
        return lines
    words, lines, cur = text.split(), [], ""
    for w in words:
        probe = f"{cur} {w}".strip()
        if draw.textlength(probe, font=font) <= max_w or not cur:
            cur = probe
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


class Band:
    """Render a subtitle band with English above Chinese and a page number at right."""

    def __init__(self, width: int, en: str, zh: str, page: str, band_h: int, zh_font: str):
        self.width, self.height = width, band_h
        self.en, self.zh, self.page = en, zh, page
        self.zh_font_path = zh_font
        self.en_lines: list[str] = []
        self.zh_lines: list[str] = []

    def measure(self, draw: ImageDraw.ImageDraw) -> int:
        f_en = ImageFont.truetype(FONT_EN, SZ_EN)
        f_zh = ImageFont.truetype(self.zh_font_path, SZ_ZH)
        max_w = self.width - PAD * 2 - RESERVE_RIGHT
        self.en_lines = wrap(draw, self.en, f_en, max_w)
        self.zh_lines = wrap(draw, self.zh, f_zh, max_w)
        h = PAD_TOP + len(self.en_lines) * LH_EN
        if self.zh_lines:
            h += LINE_GAP + len(self.zh_lines) * LH_ZH
        return h + PAD_BOTTOM

    def render(self) -> Image.Image:
        band = Image.new("RGBA", (self.width, self.height), (0, 0, 0, 0))
        d = ImageDraw.Draw(band)
        d.rectangle([0, 0, self.width, self.height], fill=INK + (224,))
        d.rectangle([0, 0, self.width, 3], fill=BLUE)

        f_en = ImageFont.truetype(FONT_EN, SZ_EN)
        f_zh = ImageFont.truetype(self.zh_font_path, SZ_ZH)
        f_page = ImageFont.truetype(FONT_EN_BOLD, SZ_PAGE)

        y = PAD_TOP
        for ln in self.en_lines:
            d.text((PAD, y), ln, font=f_en, fill=WHITE)
            y += LH_EN
        if self.zh_lines:
            y += LINE_GAP
            for ln in self.zh_lines:
                d.text((PAD, y), ln, font=f_zh, fill=ZH_TINT)
                y += LH_ZH
        if self.page:
            d.text((self.width - PAD, self.height // 2), self.page,
                   font=f_page, fill=DIM, anchor="rm")
        return band


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="shots-demo")
    ap.add_argument("--out", default="docs/Training-Failure-Triage-demo.mp4")
    ap.add_argument("--fps", type=int, default=15)
    ap.add_argument("--sub-lang", choices=["both", "en", "zh"], default="both",
                    help="both = English and Chinese (default; see docs/demo-script.md)")
    ap.add_argument("--beats", default="",
                    help="Subtitle text source (default: <dir>/beats.json)")
    ap.add_argument("--voice", default="",
                    help="Narration track produced by scripts/demo_voice.py. "
                         "Omit for a silent track.")
    ap.add_argument("--attach", default="",
                    help="Replace audio on this existing mp4 using -c:v copy. "
                         "Use when source frames are no longer available.")
    ap.add_argument("--allow-gaps", action="store_true",
                    help="Allow long frozen-frame gaps (rejected by default)")
    ap.add_argument("--allow-long", action="store_true",
                    help="Allow duration over 180s (rejected by default; submission must be under 3 minutes)")
    ap.add_argument("--min-band-h", type=int, default=0,
                    help="Minimum subtitle-band height when restoring frames from an existing video. "
                         "Match the removed band height to avoid a visible gap. "
                         "See scripts/rebuild_frames_from_film.py")
    ap.add_argument("--keep", action="store_true", help="Keep intermediate frame directories")
    args = ap.parse_args()


    if args.attach:
        src_video = Path(args.attach)
        if not src_video.exists():
            sys.exit(f"Source video not found: {src_video}")
        if not args.voice:
            sys.exit("--attach requires --voice for the replacement track")
        vpath = Path(args.voice)
        if not vpath.exists():
            sys.exit(f"Narration track not found: {vpath}")
        out = Path(args.out)
        tmp = out.with_name(out.stem + ".muxing.mp4")
        cmd = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
               "-i", str(src_video), "-i", str(vpath),
               "-map", "0:v", "-map", "1:a",
               "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
               "-shortest", "-movflags", "+faststart", str(tmp)]
        print(f"Replace audio: {src_video} + {vpath} -> {out} (video copied without re-encoding)")
        if subprocess.run(cmd, capture_output=True, text=True).returncode != 0:
            sys.exit("Audio replacement failed")
        tmp.replace(out)
        print(f"\n✓ {out}  {out.stat().st_size / 1024 / 1024:.1f} MB")
        return

    src = Path(args.dir)
    tl = json.loads((src / "timeline.json").read_text())
    frames = tl["frames"]
    beats = tl["beats"]
    total = tl["duration"]
    w, h = tl["vw"], tl["vh"]
    n_beats = len(beats)


    beats_path = Path(args.beats) if args.beats else src / "beats.json"
    if beats_path.exists():
        doc = json.loads(beats_path.read_text())
        by_id = {b["id"]: b for b in doc["beats"]}
        missing = [b["id"] for b in beats if b["id"] not in by_id]
        if missing:
            sys.exit(f"Beats missing text in {beats_path}:{', '.join(missing)}\n"
                     "  timeline.json and beats.json do not match. Export beats.json again "
                     "or use --beats to select the matching file.")
        for b in beats:
            nb = by_id[b["id"]]
            b["caption"] = nb.get("caption", "")
            b["zh"] = nb.get("zh", "")
        print(f"Subtitle text {beats_path} ({len(beats)} beats)")
    else:
        print(f"Subtitle text {src / 'timeline.json'} (beats.json absent; using text saved at recording time).\n"
              "  After editing text, run node scripts/record_demo.mjs --dump-beats --calls=N")

    if not frames:
        sys.exit("No frames in timeline.json")


    probe_frame = src / "frames" / frames[0]["file"]
    if not probe_frame.exists():
        sys.exit(f"Source frames not found ({probe_frame}).\n"
                 "  Record again with `node scripts/record_demo.mjs` (uses model quota; \n"
                 "  patrol results may change, so update figures in the deck and docs), \n"
                 "  or use `--attach <existing.mp4> --voice <track>` to replace only the audio.")

    zh_font = pick_zh_font()
    print(f"Frames {len(frames)}; duration {total:.1f}s; canvas {w}x{h}; beats {n_beats}")
    print(f"Fonts: English {Path(FONT_EN).name} / Chinese {Path(zh_font).name}")


    MAX_TOTAL = 180.0
    if total > MAX_TOTAL and not args.allow_long:
        sys.exit(f"\nVideo duration {total:.1f}s exceeds the {MAX_TOTAL:.0f}s limit (submission must be under 3 minutes).\n"
                 "  Record again or pass --allow-long to retain this version.")


    GAP_WARN, GAP_FAIL = 1.2, 4.0
    gaps = []
    for i in range(len(frames) - 1):
        d = frames[i + 1]["t"] - frames[i]["t"]
        if d > GAP_WARN:
            gaps.append((d, frames[i]["t"]))
    if gaps:
        frozen = sum(g[0] for g in gaps)
        print(f"\nFrozen frames: {len(gaps)} gaps; total {frozen:.1f}s / {total:.1f}s ({frozen / total * 100:.1f}%)")
        for d, at in sorted(gaps, reverse=True)[:8]:

            mid = at + d / 2
            beat = next((b["id"] for b in beats if b["t0"] <= mid < b["t1"]), "?")
            print(f"    {at:7.1f}s gap {d:5.1f}s (beat: {beat})")
        worst = max(g[0] for g in gaps)
        if worst > GAP_FAIL and not args.allow_gaps:
            sys.exit(f"\nLongest frozen frame {worst:.1f}s exceeds the {GAP_FAIL}s limit.\n"
                     "  Check that beat's wait conditions, or pass --allow-gaps to accept the gap.")
    else:
        print(f"Frozen frames: none (all gaps <= {GAP_WARN}s)")


    probe = ImageDraw.Draw(Image.new("RGB", (8, 8)))
    bands: dict[int, Band] = {}
    for i, b in enumerate(beats):
        en = b.get("caption", "") if args.sub_lang in ("both", "en") else ""
        zh = b.get("zh", "") if args.sub_lang in ("both", "zh") else ""
        bands[i] = Band(w, en, zh, f"{i + 1} / {n_beats}", 0, zh_font)


    over: list[str] = []
    for i, b in enumerate(beats):
        bands[i].measure(probe)
        if len(bands[i].en_lines) > MAX_EN_LINES or len(bands[i].zh_lines) > MAX_ZH_LINES:
            over.append(f"    {i + 1:>2}. {b['id']}  English {len(bands[i].en_lines)} lines / Chinese {len(bands[i].zh_lines)} lines")
    if over:
        print("Subtitles exceed the line limit. Shorten the text before encoding:")
        print("\n".join(over))
        sys.exit(1)

    band_h = max(bands[i].measure(probe) for i in range(n_beats))
    if band_h < args.min_band_h:
        print(f"Subtitle band measured {band_h}px; increased to --min-band-h {args.min_band_h}px"
              f"(extra height adds bottom padding)")
        band_h = args.min_band_h


    if args.sub_lang in ("both", "zh"):
        missing = [b["id"] for i, b in enumerate(beats) if not bands[i].zh_lines]
        if missing:
            sys.exit(f"Chinese subtitles requested but missing in these beats: {', '.join(missing)}\n"
                     "  Check the zh fields in record_demo.mjs BEATS and timeline.json.")
    print(f"Subtitle-band height {band_h}px (maximum across all beats)")

    for i in range(n_beats):
        bands[i].height = band_h
    band_img = {i: bands[i].render() for i in range(n_beats)}


    def beat_of(t: float) -> int:


        for i, b in enumerate(beats):
            if t < b["t1"]:
                return i
        return n_beats - 1


    n_out = max(1, round(total * args.fps))
    plan: list[int] = []
    j = 0
    for n in range(n_out):
        t = n / args.fps
        while j + 1 < len(frames) and frames[j + 1]["t"] <= t:
            j += 1
        plan.append(j)


    drift = total - len(plan) / args.fps
    print(f"Resampled {len(plan)} frames @ {args.fps}fps = {len(plan) / args.fps:.2f}s "
          f"(recorded {total:.2f}s; drift {drift:+.2f}s)")
    if abs(drift) > 1.0:
        sys.exit(f"Resampled duration differs from recording by {drift:+.2f}s; encoding stopped to prevent audio drift.\n"
                 "  Check frame sampling in the plan loop; drift must stay within half a frame.")

    cap_dir = src / "captioned"
    if cap_dir.exists():
        shutil.rmtree(cap_dir)
    cap_dir.mkdir(parents=True)

    seq = 0
    last_beat = -1
    band = None
    for idx in plan:
        t = frames[idx]["t"]
        bi = beat_of(t)
        if bi != last_beat:
            band = band_img[bi]
            last_beat = bi
        im = Image.open(src / "frames" / frames[idx]["file"]).convert("RGB")
        if im.size != (w, h):
            im = im.resize((w, h))
        im.paste(band, (0, h - band_h), band)
        d = ImageDraw.Draw(im)
        prog = int(w * min(1.0, t / total))
        d.rectangle([0, h - 4, max(2, prog), h], fill=BLUE)
        seq += 1
        im.save(cap_dir / f"c{seq:06d}.jpg", quality=88, subsampling=0)

    print(f"Subtitles rendered on {seq} frames ({seq / args.fps:.1f}s @ {args.fps}fps) -> {cap_dir}")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)


    voice = Path(args.voice) if args.voice else None
    if voice and not voice.exists():
        sys.exit(f"Narration track not found: {voice}")
    if voice:
        audio_in = ["-i", str(voice)]
        audio_map = ["-map", "0:v", "-map", "1:a", "-c:a", "aac", "-b:a", "128k"]
        print(f"Audio: {voice} (narration)")
    else:
        audio_in = ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]
        audio_map = ["-c:a", "aac", "-b:a", "96k"]
        print("Audio: silent (see scripts/demo_voice.py for narration)")


    cmd = [
        FFMPEG, "-y",
        "-framerate", str(args.fps),
        "-i", str(cap_dir / "c%06d.jpg"),
        *audio_in,
        "-vf", "scale=in_range=full:out_range=tv:flags=bicubic,format=yuv420p",
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-pix_fmt", "yuv420p", "-color_range", "tv", "-movflags", "+faststart",
        *audio_map, "-shortest",
        str(out),
    ]
    print("Encoding...")
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stderr[-3000:])
        sys.exit(f"ffmpeg failed ({r.returncode})")

    size_mb = out.stat().st_size / 1024 / 1024
    print(f"\n✓ {out}  {size_mb:.1f} MB  {total:.1f}s  {args.fps}fps  {w}×{h}")
    if voice:
        print("  Workflow: record, synthesize narration, compose.")
    else:
        print(f"  Next:python3 scripts/demo_voice.py --dir {src}")
        print(f"          python3 scripts/demo_caption.py --dir {src} --out {out} "
              f"--voice {src}/voice.m4a")

    if not args.keep:
        shutil.rmtree(cap_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
