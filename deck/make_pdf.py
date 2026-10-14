#!/usr/bin/env python3
"""把 render/*.png 合成 deck 的 PDF 提交物。

为什么固定成脚本，而不是每次手敲一条命令：
PDF 是提交物之一，deck 改一个字就要重出一次。手敲参数迟早会把页序、尺寸或底色弄乱，
而这类错误在 PDF 里**不容易一眼看出来**（14 页，谁也不会逐页比对尺寸）。

两个必须照做的细节：

1. **底色必须是白的。** 截出来的是 RGBA，文字边缘带抗锯齿的半透明像素。
   直接把 alpha 丢掉，这些像素会变成黑的，白底页面上就多出一圈灰边。
   所以要显式压到白底上，而不是 `.convert('RGB')` 了事。
2. **`resolution=150`。** 1920px / 150dpi = 12.8in = 921.6pt，这正是上一版 PDF 的纸张尺寸；
   换一个值会让所有页的物理尺寸变化，打印出来就不一样了。

用法：
    python3 make_pdf.py                      # render/*.png → ../docs/…deck.pdf
    python3 make_pdf.py --out /tmp/x.pdf
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
# ★ 输出路径跟着 `HERE` 走，不写绝对路径。
#   这份脚本原来在仓库外（`deck-triage/`），所以要 `HERE.parent / "ai-builder-cup-lt" / "docs"`；
#   现在它自己就在仓库里（`deck/`），仓库根的 docs/ 就是 `HERE.parent / "docs"`。
#   写成相对 HERE 的形式，无论从哪个工作目录调用都对。
DEFAULT_OUT = HERE.parent / "docs" / "Training-Failure-Triage-deck.pdf"
RESOLUTION = 150


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--render", default=str(HERE / "render"), help="render 目录（01.png … 14.png）")
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    args = ap.parse_args()

    render = Path(args.render)
    pngs = sorted(render.glob("[0-9][0-9].png"))
    if len(pngs) < 2:
        sys.exit(f"★ {render} 里的页图不足两张 —— 先跑一遍 slidep screenshot")

    pages: list[Image.Image] = []
    for p in pngs:
        im = Image.open(p)
        if im.mode != "RGB":
            # 压到白底，而不是丢 alpha（丢 alpha 会把半透明边缘变黑，白底页上出现灰边）
            bg = Image.new("RGB", im.size, (255, 255, 255))
            bg.paste(im, (0, 0), im if im.mode in ("RGBA", "LA") else None)
            im = bg
        if im.size != (1920, 1080):
            print(f"  ! {p.name} 是 {im.size[0]}×{im.size[1]}，不是 1920×1080")
        pages.append(im)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    # 只写 title：不填 author —— 署名该由提交人自己决定，脚本不该替他编一个。
    pages[0].save(out, "PDF", save_all=True, append_images=pages[1:],
                  resolution=RESOLUTION, title="Training Failure Triage")

    size_mb = out.stat().st_size / 1024 / 1024
    print(f"✓ {out}  {len(pages)} 页  {size_mb:.2f} MB  ({pages[0].size[0]}×{pages[0].size[1]} "
          f"@ {RESOLUTION}dpi → {pages[0].size[0] / RESOLUTION * 72:.1f}×"
          f"{pages[0].size[1] / RESOLUTION * 72:.1f}pt)")
    print(f"  页序：{', '.join(p.stem for p in pngs)}")


if __name__ == "__main__":
    main()
