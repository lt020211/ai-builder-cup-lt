#!/usr/bin/env python3
"""在截图的指定矩形内，按「有内容的行」聚类出文本/表格行带，用于精确定位裁切区间。
用法: probe_bands.py <png> <x0> <y0> <x1> <y1> [min_ink]   —— 坐标均为 CSS px（= device/2）
"""
import sys
from PIL import Image


def bands(path, box, min_ink=6, gap=4):
    im = Image.open(path).convert("RGB")
    px = im.load()
    x0, y0, x1, y1 = [int(v * 2) for v in box]
    rows = []
    for y in range(y0, y1):
        n = 0
        for x in range(x0, x1, 2):
            c = px[x, y]
            # 非白且非浅底 → 视为「墨」
            if c[0] < 236 or c[1] < 236 or c[2] < 236:
                n += 1
        rows.append(n)
    out = []
    cur = None
    blank = 0
    for i, n in enumerate(rows):
        if n >= min_ink:
            if cur is None:
                cur = i
            blank = 0
        elif cur is not None:
            blank += 1
            if blank >= gap:
                out.append((cur, i - blank))
                cur = None
    if cur is not None:
        out.append((cur, len(rows) - 1 - blank))
    return [((a + y0) / 2, (b + y0) / 2) for a, b in out]


if __name__ == "__main__":
    path = sys.argv[1]
    box = tuple(float(v) for v in sys.argv[2:6])
    mi = int(sys.argv[6]) if len(sys.argv) > 6 else 6
    print(f"# {path}  box(css)={box}  min_ink={mi}")
    for a, b in bands(path, box, mi):
        print(f"  css y {a:8.1f} - {b:8.1f}   h={b-a:6.1f}")
