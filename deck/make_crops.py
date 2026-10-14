#!/usr/bin/env python3
"""从线上截图里裁出 deck 需要的证据图。

这份脚本里**没有一个手写的坐标数字**，两个输入都是量出来的：

  1. 裁哪一块 ← `<shots>/<分组>/boxes.json`
     由 `scripts/capture_shots.mjs <url> <shots>/<分组> --boxes <shots>/<分组>/boxes.json`
     在**截图的那一次会话里**量好写出。为什么要这样，看那个脚本里的注释；这里只说结论：
     2026-10-14 界面从「卡片 + 右栏」改成「单栏工作台」，上一版手写的 6 组坐标
     **一个都没用了** —— 数字还是那些数字，元素全挪了位置，照旧坐标裁出来的图
     会切在半个面板上，而脚本一声不吭。而且旧坐标其实早就漂了：
     上一版 `crop-tooltrace.png` / `crop-bench-table.png` 的实际尺寸
     和那份列表里写的对不上，说明它们中途被重新裁过、列表没跟着改。

  2. 图要多大 ← `slides/*.slide` 里的 `<Image style={{ width, height }}>`
     图片框尺寸是写死在幻灯片里的，图片比例不符就会被拉伸。所以这里**反过来**
     从幻灯片里把框读出来，按框的比例裁 —— 让数据迁就版式，而不是让版式迁就数据。
     读不到某个 crop 的框就直接报错，不猜。

为什么要分两组截图（`clean/` 与 `shift/`）：

  同一时刻的界面只有一个状态，但 deck 需要两个：
    · `clean/`  刚重置完 —— 集群卡片与节点行要的是这个（幻灯片 07 说的是
                「页面加载时的样子」，那时还没有任何节点被 cordon）
    · `shift/`  跑完一次值班之后 —— 操作日志那一屏要的是这个（日志里得有东西），
                单次分诊的工具轨迹也只在这里（那一次真的跑了模型）
  拿巡检后的状态去配「加载时」的说明，或者拿空日志去配「执行是真的」，都是图与话对不上。
  两组各自带自己的 boxes.json —— 节点行高会随状态变（cordon 会多一行），
  用一组的几何去裁另一组的图，就会错位。

坐标单位是 CSS px（文档坐标，y 从页面顶端算），截图是 2 倍像素密度，裁切统一 ×2。

用法：
    python3 make_crops.py                    # 默认从 ../shots 读（仓库根下的截图目录）
    python3 make_crops.py --shots /tmp/shots
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from PIL import Image

# ★ 单位换算，必须显式写出来并校验。
#   截图是 2 倍像素密度（capture_shots.mjs 里 --force-device-scale-factor=2），
#   而 boxes.json 里的框是 CSS px。混用这两种单位不会报错，
#   只会让裁切位置悄悄偏一倍 —— 或者更阴的：算出一个比画面还大的框，
#   PIL 帮你把越界部分填成黑的，你只会觉得「边上多了条黑边」。
SCALE = 2
VIEWPORT_W = 1440

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "assets"
SLIDES = ROOT / "slides"

# 默认从仓库的 shots/ 直接读 —— 不在 assets/ 里留第二份拷贝。
# 留拷贝的下场是「截图重采了、裁剪还在读旧的」，而这种错不会报错，只会出图。
# 路径相对本文件：本文件在 `<仓库>/deck/` 下，所以 `<仓库>/shots/` 就是 `ROOT.parent / "shots"`。
DEFAULT_SHOTS = ROOT.parent / "shots"

# (输出文件, 源截图（相对 shots/）, 框来源, 说明)
#   框来源三选一：
#     ("<标签页>", "<元素键>", "panel")   元素所在的那个 .panel 整卡
#     ("<标签页>", "<元素键>", "self")    元素自己
#     ("<标签页>", "nodeRows", (i, j))    第 i..j 行节点的并集
CROPS: list[tuple[str, str, tuple, str]] = [
    ("crop-node-lyg2103.png", "clean/live-02-patrol.png", ("patrol", "nodeRows", (1, 2)),
     "05 · lyg2103 那一行（Xid 94 单次 · ECC 平稳 → 不报修）"),
    ("crop-node-lyg2112.png", "clean/live-02-patrol.png", ("patrol", "nodeRows", (4, 5)),
     "05 · lyg2112 那一行（Xid 94 累计 53 · ECC 118 且上升 → 报修）"),
    ("crop-cluster-card.png", "clean/live-02-patrol.png", ("patrol", "nodes", "panel"),
     "07 · 集群状态整卡（刚重置：6 节点 · 4 个有色标记 · 无一 cordon）"),
    ("crop-oplog.png", "shift/live-02-patrol.png", ("patrol", "events", "panel"),
     "08 · 操作日志整卡（一次值班之后，含每条的「回验通过」结论）"),
    # ★ 这里取 panel 而不是 self：self 只有那三张卡片（136px 高），
    #   按目标比例补高会以卡片为中心上下各补一截 —— 上面把面板标题切掉一半，
    #   下面漏进下一个面板的顶边。以整个面板为中心补，才刚好框住它。
    ("crop-risks.png", "clean/live-04-actions.png", ("actions", "riskLevels", "panel"),
     "09 · 三级风险与审批要求整块"),
    ("crop-tooltrace.png", "shift/live-01-triage.png", ("case", "tools", "self"),
     "10 · AI 工具调用轨迹（参数原样展示；只有这一组真跑过分诊）"),
    ("crop-bench-table.png", "clean/live-03-benchmark.png", ("bench", "benchTable", "self"),
     "12 · 基准对照逐案例表（表头 + 14 行）"),
]


def frame_sizes() -> dict[str, tuple[int, int]]:
    """从 slides/*.slide 里读出每个 crop 的图片框尺寸（CSS px）。"""
    found: dict[str, tuple[int, int]] = {}
    pat = re.compile(
        r"assets/(crop-[a-z0-9\-]+\.png)'\s*style=\{\{\s*width:\s*(\d+),\s*height:\s*(\d+)"
    )
    for f in sorted(SLIDES.glob("*.slide")):
        for name, w, h in pat.findall(f.read_text(encoding="utf-8")):
            prev = found.get(name)
            if prev and prev != (int(w), int(h)):
                raise SystemExit(
                    f"{name} 在不同幻灯片里的图片框尺寸不一致：{prev} vs {(int(w), int(h))}"
                )
            found[name] = (int(w), int(h))
    return found


_BOXES_CACHE: dict[str, dict] = {}


def load_boxes(shots: Path, group: str) -> dict:
    """读某一组截图对应的 boxes.json。同一组只读一次。"""
    if group in _BOXES_CACHE:
        return _BOXES_CACHE[group]
    p = shots / group / "boxes.json"
    if not p.exists():
        raise SystemExit(
            f"缺少 {p}\n它由截图那一步生成：\n"
            f"  node scripts/capture_shots.mjs <url> {shots / group} --boxes {p}"
        )
    _BOXES_CACHE[group] = json.loads(p.read_text(encoding="utf-8"))
    return _BOXES_CACHE[group]


def resolve(spec: tuple, boxes: dict) -> tuple[int, int, int, int]:
    """把「框来源」解析成 CSS px 的 (x0, y0, x1, y1)。"""
    tab, key, mode = spec
    page = boxes.get(tab)
    if not page:
        raise SystemExit(f"boxes.json 里没有标签页 {tab}")

    if isinstance(mode, tuple):                     # 若干行节点的并集
        i, j = mode
        rows = page.get("nodeRows") or []
        picked = rows[i:j]
        if len(picked) < j - i:
            raise SystemExit(f"{tab}.nodeRows 只有 {len(rows)} 行，取不到 {i}..{j}")
        return (min(r["x"] for r in picked), min(r["y"] for r in picked),
                max(r["x"] + r["w"] for r in picked), max(r["y"] + r["h"] for r in picked))

    node = page.get(key)
    if not node:
        raise SystemExit(f"boxes.json 里没有 {tab}.{key}")
    b = node if mode == "self" else (node.get("panel") or node)
    return b["x"], b["y"], b["x"] + b["w"], b["y"] + b["h"]


def fit_to_ratio(box, ratio, size):
    """把框调成目标长宽比，返回 ((x0, y0, x1, y1), 调整方式) 或 (None, 原因)。

    **优先只补不切。** 界面上每一块都是实测量的，切掉一截就意味着拿掉了一条证据，
    而「图看起来还挺正常」不会让人发现。所以顺序是：
      保宽补高   → 宽度不动，上下补到目标比例（内容一个不丢）
      保高补宽   → 高度不动，左右补到目标比例（同上）
      都做不到   → 报错，交给人决定「是改幻灯片里的框，还是换个裁切对象」
    最后那种情况不动手：一个悄悄切掉内容的裁图，比一张没裁出来的图危险得多。
    """
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    sw, sh = size

    def place(nw: int, nh: int, how: str):
        """把 nw×nh 的框居中放在原框上，再整体收回画面内。"""
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        nx0 = max(0, min(round(cx - nw / 2), sw - nw))
        ny0 = max(0, min(round(cy - nh / 2), sh - nh))
        return (nx0, ny0, nx0 + nw, ny0 + nh), how

    # 保宽补高
    nh = round(w / ratio)
    if nh >= h and nh <= sh:
        return place(w, nh, "保宽补高")

    # 保高补宽。夹到画面宽度之后高度可能掉一点点（不足 1%），那种误差
    # 落在缩放的采样里看不出来，远好过为了凑比例去切内容。
    nw = min(round(h * ratio), sw)
    nh2 = round(nw / ratio)
    if nw >= w and nh2 >= h * 0.99:
        return place(nw, nh2, "保高补宽")

    return None, f"原始框 {w}×{h}（比例 {w / h:.2f}）放不进目标比例 {ratio:.2f}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shots", default=str(DEFAULT_SHOTS),
                    help="截图根目录（下面按分组放 clean/ 与 shift/）")
    args = ap.parse_args()

    shots = Path(args.shots).resolve()
    frames = frame_sizes()

    # ★ 不用 mkdir(exist_ok=True)：本机沙箱下它会抛 PermissionError: EEXIST，
    #   明明目录已经在了却被拦下来。先判存在再建。
    if not ASSETS.exists():
        ASSETS.mkdir(parents=True)

    print(f"截图根目录：{shots}")
    print(f"图片框来源：slides/*.slide（{len(frames)} 个写死的尺寸）\n")

    problems: list[str] = []
    for out_name, src_name, spec, note in CROPS:
        src = shots / src_name
        group = Path(src_name).parent.name
        if not src.exists():
            problems.append(f"{out_name}：找不到源图 {src}")
            continue
        frame = frames.get(out_name)
        if not frame:
            problems.append(f"{out_name}：在 slides/*.slide 里找不到它的图片框尺寸")
            continue

        im = Image.open(src).convert("RGB")
        # 校验像素密度：对不上就说明截图参数变了，所有裁切坐标一起失效。
        # 与其裁出一堆错位的图，不如在这里停下。
        if im.width != VIEWPORT_W * SCALE:
            problems.append(
                f"{out_name}：{src_name} 宽 {im.width}px，"
                f"与 VIEWPORT_W×SCALE = {VIEWPORT_W * SCALE} 对不上 —— "
                f"视口宽度或截图密度变了，裁切坐标全部失效"
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
        out = im.crop((x0 * SCALE, y0 * SCALE, x1 * SCALE, y1 * SCALE))
        target = (frame[0] * SCALE, frame[1] * SCALE)
        out = out.resize(target, Image.LANCZOS)
        out.save(ASSETS / out_name)
        print(f"{out_name:24s} {note}")
        print(f"    来源       {src_name}　（几何来自 {group}/boxes.json）")
        print(f"    量到的框   ({box[0]}, {box[1]}) → ({box[2]}, {box[3]})"
              f"   {box[2] - box[0]}×{box[3] - box[1]}")
        print(f"    {how:10s} → ({x0}, {y0}) → ({x1}, {y1})   {x1 - x0}×{y1 - y0}"
              f"   目标比例 {ratio:.3f}")
        print(f"    输出       {out.width}×{out.height}（框 {frame[0]}×{frame[1]} 的 {SCALE} 倍）\n")

    if problems:
        print("✗ 没能全部裁出来：")
        for p in problems:
            print(f"   · {p}")
        return 1
    print(f"完成：{len(CROPS)} 张")
    return 0


if __name__ == "__main__":
    sys.exit(main())
