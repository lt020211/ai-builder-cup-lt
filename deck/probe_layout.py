#!/usr/bin/env python3
"""Find card boundaries in screenshots using white cards on a light gray background."""
import sys
from PIL import Image

def runs(im, x):
    w, h = im.size
    px = im.load()
    out = []
    prev = None
    start = 0
    for y in range(h):
        c = px[x, y][:3]
        if prev is None:
            prev, start = c, 0
            continue
        if max(abs(c[i] - prev[i]) for i in range(3)) > 6:
            out.append((start, y - 1, prev))
            prev, start = c, y
    out.append((start, h - 1, prev))
    return [r for r in out if r[1] - r[0] >= 6]

def scan(path, x):
    im = Image.open(path).convert("RGB")
    print(f"### {path}  size={im.size}  column x={x}")
    for a, b, c in runs(im, x):
        print(f"  y {a:5d} - {b:5d}  h={b-a+1:5d}  rgb={c}")

    w, h = im.size
    px = im.load()
    y = h // 2
    bg = px[3, y][:3]
    left = next((xx for xx in range(w) if max(abs(px[xx, y][i] - bg[i]) for i in range(3)) > 6), 0)
    right = next((xx for xx in range(w - 1, -1, -1) if max(abs(px[xx, y][i] - bg[i]) for i in range(3)) > 6), w - 1)
    print(f"  row y={y}  page background={bg}  content x {left} .. {right}")

if __name__ == "__main__":
    for p in sys.argv[1:]:
        scan(p, 720)
        print()
