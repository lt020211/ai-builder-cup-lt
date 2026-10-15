#!/usr/bin/env python3
"""Crop deck images using measured bounds and slide image dimensions.

Read each capture group's boxes.json from the same session as its screenshots.
Use clean/ for reset cluster views and shift/ for operation logs and tool traces.
Read image aspect ratios from slides/*.slide. Expand bounds where possible;
fail when the requested ratio cannot fit without removing content.
Bounds use CSS document pixels; screenshots use twice that resolution.
Usage: python3 deck/make_crops.py [--shots <directory>]"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from PIL import Image


# Convert measured CSS bounds to screenshot pixels.
SCALE = 2
VIEWPORT_W = 1440

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "assets"
SLIDES = ROOT / "slides"


DEFAULT_SHOTS = ROOT.parent / "shots"


CROPS: list[tuple[str, str, tuple, str]] = [
    ("crop-node-lyg2103.png", "clean/live-02-patrol.png", ("patrol", "nodeRows", (1, 2)),
     "05: lyg2103 row (one Xid 94; stable ECC; no RMA)"),
    ("crop-node-lyg2112.png", "clean/live-02-patrol.png", ("patrol", "nodeRows", (4, 5)),
     "05: lyg2112 row (53 Xid 94 events; ECC 118 and rising; RMA)"),
    ("crop-cluster-card.png", "clean/live-02-patrol.png", ("patrol", "nodes", "panel"),
     "07: cluster panel after reset (6 nodes; 4 colored alerts; none cordoned)"),
    ("crop-oplog.png", "shift/live-02-patrol.png", ("patrol", "events", "panel"),
     "08: operation-log panel after patrol, including verification outcomes"),


    # Use the panel bounds so the crop includes the heading.
    ("crop-risks.png", "clean/live-04-actions.png", ("actions", "riskLevels", "panel"),
     "09: three risk levels and approval requirements"),
    ("crop-tooltrace.png", "shift/live-01-triage.png", ("case", "tools", "self"),
     "10: AI tool trace with original arguments from the triage capture"),
    ("crop-bench-table.png", "clean/live-03-benchmark.png", ("bench", "benchTable", "panel"),
     "12: per-case benchmark table (header and 14 rows)"),
]


def frame_sizes() -> dict[str, tuple[int, int]]:
    """Read crop image dimensions in CSS pixels from slides/*.slide."""
    found: dict[str, tuple[int, int]] = {}
    pat = re.compile(
        r"assets/(crop-[a-z0-9\-]+\.png)'\s*style=\{\{\s*width:\s*(\d+),\s*height:\s*(\d+)"
    )
    for f in sorted(SLIDES.glob("*.slide")):
        for name, w, h in pat.findall(f.read_text(encoding="utf-8")):
            prev = found.get(name)
            if prev and prev != (int(w), int(h)):
                raise SystemExit(
                    f"{name} has inconsistent image dimensions across slides:{prev} vs {(int(w), int(h))}"
                )
            found[name] = (int(w), int(h))
    return found


_BOXES_CACHE: dict[str, dict] = {}


def load_boxes(shots: Path, group: str) -> dict:
    """Load and cache the bounds for one screenshot group."""
    if group in _BOXES_CACHE:
        return _BOXES_CACHE[group]
    p = shots / group / "boxes.json"
    if not p.exists():
        raise SystemExit(
            f"Missing {p}\nGenerate it while capturing screenshots:\n"
            f"  node scripts/capture_shots.mjs <url> {shots / group} --boxes {p}"
        )
    _BOXES_CACHE[group] = json.loads(p.read_text(encoding="utf-8"))
    return _BOXES_CACHE[group]


def resolve(spec: tuple, boxes: dict) -> tuple[int, int, int, int]:
    """Resolve an element, panel, or node-row range to CSS pixel bounds."""
    tab, key, mode = spec
    page = boxes.get(tab)
    if not page:
        raise SystemExit(f"Tab {tab} missing from boxes.json")

    if isinstance(mode, tuple):
        i, j = mode
        rows = page.get("nodeRows") or []
        picked = rows[i:j]
        if len(picked) < j - i:
            raise SystemExit(f"{tab}.nodeRows has only {len(rows)} rows; cannot select {i}..{j}")
        return (min(r["x"] for r in picked), min(r["y"] for r in picked),
                max(r["x"] + r["w"] for r in picked), max(r["y"] + r["h"] for r in picked))

    node = page.get(key)
    if not node:
        raise SystemExit(f"{tab}.{key} missing from boxes.json")
    b = node if mode == "self" else (node.get("panel") or node)
    return b["x"], b["y"], b["x"] + b["w"], b["y"] + b["h"]


def fit_to_ratio(box, ratio, size):
    """Expand bounds to the target aspect ratio, or return a reason if they cannot fit."""
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    sw, sh = size

    def place(nw: int, nh: int, how: str):
        """Center the requested bounds and clamp them to the image."""
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        nx0 = max(0, min(round(cx - nw / 2), sw - nw))
        ny0 = max(0, min(round(cy - nh / 2), sh - nh))
        return (nx0, ny0, nx0 + nw, ny0 + nh), how


    nh = round(w / ratio)
    if nh >= h and nh <= sh:
        return place(w, nh, "keep width, expand height")


    nw = min(round(h * ratio), sw)
    nh2 = round(nw / ratio)
    if nw >= w and nh2 >= h * 0.99:
        return place(nw, nh2, "keep height, expand width")

    return None, f"Original bounds {w}x{h} (ratio {w / h:.2f}) cannot fit target ratio {ratio:.2f}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shots", default=str(DEFAULT_SHOTS),
                    help="Screenshot root directory containing clean/ and shift/ groups")
    args = ap.parse_args()

    shots = Path(args.shots).resolve()
    frames = frame_sizes()


    if not ASSETS.exists():
        ASSETS.mkdir(parents=True)

    print(f"Screenshot root: {shots}")
    print(f"Image dimensions: slides/*.slide ({len(frames)} fixed sizes)\n")

    problems: list[str] = []
    for out_name, src_name, spec, note in CROPS:
        src = shots / src_name
        group = Path(src_name).parent.name
        if not src.exists():
            problems.append(f"{out_name}: source image not found: {src}")
            continue
        frame = frames.get(out_name)
        if not frame:
            problems.append(f"{out_name}: image dimensions missing from slides/*.slide")
            continue

        im = Image.open(src).convert("RGB")


        if im.width != VIEWPORT_W * SCALE:
            problems.append(
                f"{out_name}: {src_name} is {im.width}px wide; "
                f"expected VIEWPORT_W x SCALE = {VIEWPORT_W * SCALE}; "
                f"viewport width or screenshot scale changed; crop coordinates are invalid"
            )
            continue
        css_size = (im.width // SCALE, im.height // SCALE)

        ratio = frame[0] / frame[1]
        box = resolve(spec, load_boxes(shots, group))
        fitted, how = fit_to_ratio(box, ratio, css_size)
        if fitted is None:
            problems.append(f"{out_name}：{how}")
            continue

        x0, y0, x1, y1 = fitted
        # Keep the tool trace's top edge below its heading. Centered expansion
        # otherwise includes a clipped fragment of the call-count badge.
        if out_name == "crop-tooltrace.png":
            crop_h = y1 - y0
            y0 = min(box[1], css_size[1] - crop_h)
            y1 = y0 + crop_h
        out = im.crop((x0 * SCALE, y0 * SCALE, x1 * SCALE, y1 * SCALE))
        target = (frame[0] * SCALE, frame[1] * SCALE)
        out = out.resize(target, Image.LANCZOS)
        out.save(ASSETS / out_name)
        print(f"{out_name:24s} {note}")
        print(f"    Source     {src_name} (bounds from {group}/boxes.json)")
        print(f"    Measured bounds ({box[0]}, {box[1]}) → ({box[2]}, {box[3]})"
              f"   {box[2] - box[0]}×{box[3] - box[1]}")
        print(f"    {how:10s} → ({x0}, {y0}) → ({x1}, {y1})   {x1 - x0}×{y1 - y0}"
              f"   Target ratio {ratio:.3f}")
        print(f"    Output     {out.width}x{out.height} (frame {frame[0]}x{frame[1]} at {SCALE}x)\n")

    if problems:
        print("✗ Some crops failed:")
        for p in problems:
            print(f"   · {p}")
        return 1
    print(f"Completed: {len(CROPS)} images")
    return 0


if __name__ == "__main__":
    sys.exit(main())
