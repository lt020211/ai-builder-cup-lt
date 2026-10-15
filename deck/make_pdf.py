#!/usr/bin/env python3
"""Combine render/*.png into the submission PDF in page order.

Flatten RGBA images onto white to preserve antialiased edges.
Use 150 dpi to preserve the page dimensions.
Usage: python3 deck/make_pdf.py [--render <directory>] [--out <file>]"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent


DEFAULT_OUT = HERE.parent / "docs" / "Training-Failure-Triage-deck.pdf"
RESOLUTION = 150


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--render", default=str(HERE / "render"), help="Render directory (01.png through 15.png)")
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    args = ap.parse_args()

    render = Path(args.render)
    pngs = sorted(render.glob("[0-9][0-9].png"))
    if len(pngs) < 2:
        sys.exit(f"{render} has fewer than two page images; run slidep screenshot first")

    pages: list[Image.Image] = []
    for p in pngs:
        im = Image.open(p)
        if im.mode != "RGB":
            # Flatten alpha onto white to preserve antialiased text edges.
            bg = Image.new("RGB", im.size, (255, 255, 255))
            bg.paste(im, (0, 0), im if im.mode in ("RGBA", "LA") else None)
            im = bg
        if im.size != (1920, 1080):
            print(f"  ! {p.name} is {im.size[0]}x{im.size[1]}; expected 1920x1080")
        pages.append(im)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    pages[0].save(out, "PDF", save_all=True, append_images=pages[1:],
                  resolution=RESOLUTION, title="Training Failure Triage")

    size_mb = out.stat().st_size / 1024 / 1024
    print(f"✓ {out}  {len(pages)} pages  {size_mb:.2f} MB  ({pages[0].size[0]}×{pages[0].size[1]} "
          f"@ {RESOLUTION}dpi → {pages[0].size[0] / RESOLUTION * 72:.1f}×"
          f"{pages[0].size[1] / RESOLUTION * 72:.1f}pt)")
    print(f"  Page order: {', '.join(p.stem for p in pngs)}")


if __name__ == "__main__":
    main()
