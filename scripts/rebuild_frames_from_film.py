#!/usr/bin/env python3
"""从已经烧过字幕的成片里把画面取回来（去掉字幕条与进度条），用于重烧一版字幕。

**什么时候需要它：** 帧序列（`shots-demo/frames/`，几百 MB）被清掉之后，又要改字幕。

这时候另外两条路都不好走：

· **重录一遍** —— 花掉一次模型配额，而且一次巡检的真实结果是会变的（调用次数、
  被 cordon 的节点）。deck 与 README 引用的正是那一组数字，一重录整套证据链就散了，
  视频里那句「共 17 次调用」也不再是画面上那一轮的数字。
· **将就着用旧字幕** —— 那正好是这次要改的东西。

所以第三条路：**把成片本身当画面源**。字幕条只盖住画面最下面 `BAND_H` 行，
把它裁掉就取回了未被遮挡的全部像素；进度条那 4px 也在这条带子里。屏幕内容一个像素都没有动，
换掉的只是我们自己写的那层字幕。

★ **代价要说清楚：这是一次额外的编码**（源已经是 H.264）。所以这里默认 CRF 16 + preset slow，
  让这一代尽量接近透明 —— 不要图省事用默认参数，屏幕上的小字经不起两代 crf20。

产出（写到 `--out` 目录，不动原始 timeline.json）：

    frames/f000001.jpg …     裁掉字幕条后的画面（1600×900；下半 BAND_H 行填成字幕条底色，
                             新字幕条不长到那么高也看不出来）
    timeline.json            重建的帧表（按 1/fps 均匀铺开）+ **原封不动沿用原 timeline 的 beats**，
                             所以每一拍的真实起止时间没变，新字幕仍然落在原来那一刻

用法：
    python3 scripts/rebuild_frames_from_film.py \\
        --film docs/Training-Failure-Triage-demo.mp4 \\
        --timeline shots-demo/timeline.json \\
        --out shots-reburn

    # 然后
    python3 scripts/demo_caption.py --dir shots-reburn --beats shots-demo/beats.json \\
            --voice shots-demo/voice.m4a --out docs/Training-Failure-Triage-demo.mp4
"""

from __future__ import annotations

import argparse
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
    sys.exit("找不到 ffmpeg：pip install imageio-ffmpeg 或装一个系统 ffmpeg")

# 字幕条的底色。★ 与 demo_caption.py 的 INK 必须一致：
# 裁掉字幕条之后，这块区域要填成**同一个颜色**，而不是黑 ——
# 新字幕条万一比旧的那条矮，露出来的那几行才是背景色，不是一条黑边。
INK = (11, 18, 32)

# 旧字幕条的高度。demo_caption.py 每次跑都会打印「字幕条高度 Npx」，
# 这里填的必须是**那一版成片**用的值。填小了会留一条旧字，填大了会多裁掉真实画面。
DEFAULT_BAND_H = 133


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--film", default="docs/Training-Failure-Triage-demo.mp4")
    ap.add_argument("--timeline", default="shots-demo/timeline.json")
    ap.add_argument("--out", default="shots-reburn")
    ap.add_argument("--band-h", type=int, default=DEFAULT_BAND_H,
                    help=f"旧字幕条高度（默认 {DEFAULT_BAND_H}，必须等于当时那个「字幕条高度 Npx」）")
    ap.add_argument("--crf", type=int, default=16, help="JPEG 质量（数字越小越好，默认 16）")
    args = ap.parse_args()

    film = Path(args.film)
    tl_path = Path(args.timeline)
    if not film.exists():
        sys.exit(f"★ 找不到成片：{film}")
    if not tl_path.exists():
        sys.exit(f"★ 找不到 timeline：{tl_path}")

    old = json.loads(tl_path.read_text())
    fps = int(old.get("fps", 15))
    vw, vh = int(old.get("vw", 1600)), int(old.get("vh", 900))
    band_h = args.band_h
    keep_h = vh - band_h
    if keep_h <= 0:
        sys.exit(f"★ --band-h {band_h} 比画面高度 {vh} 还大")

    out = Path(args.out)
    if out.exists():
        shutil.rmtree(out)
    (out / "frames").mkdir(parents=True)

    # 裁掉字幕条 → 再把下半截填成字幕条底色（不是黑：见上面 INK 的说明）
    vf = (f"crop={vw}:{keep_h}:0:0,"
          f"pad={vw}:{vh}:0:0:color=0x{INK[0]:02X}{INK[1]:02X}{INK[2]:02X}")
    cmd = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
           "-i", str(film),
           "-vf", vf, "-q:v", str(args.crf), "-vsync", "0",
           str(out / "frames" / "f%06d.jpg")]
    print(f"从成片取回画面：裁掉下面 {band_h}px，保留 {keep_h}px（CRF {args.crf}）")
    if subprocess.run(cmd, capture_output=True, text=True).returncode != 0:
        sys.exit("★ ffmpeg 取帧失败")

    files = sorted((out / "frames").glob("f*.jpg"))
    n = len(files)
    if n < 2:
        sys.exit("★ 没取到帧")
    duration = n / fps

    # 重建帧表：成片已经是被摊平过的固定帧率，所以每帧等间隔
    frames = [{"file": f.name, "t": round(i / fps, 4)} for i, f in enumerate(files)]

    # ★ beats 原封不动搬过来：每一拍的真实起止时间来自原始录制，不能在这里重新算。
    rebuilt = {
        "app": old.get("app", ""),
        "fps": fps,
        "vw": vw,
        "vh": vh,
        "dry": old.get("dry", False),
        "duration": round(duration, 3),
        "frameCount": n,
        "rebuilt_from_film": str(film),
        "rebuilt_note": (f"帧表由 scripts/rebuild_frames_from_film.py 从成片重建"
                         f"（裁掉下面 {band_h}px 字幕条）；beats 沿用原 timeline，未重新计算"),
        "frames": frames,
        "beats": old["beats"],
    }
    (out / "timeline.json").write_text(json.dumps(rebuilt, ensure_ascii=False, indent=1))

    print(f"✓ {n} 帧 → {out / 'frames'}（{duration:.2f}s @ {fps}fps）")
    print(f"✓ {out / 'timeline.json'}（beats 沿用原文件：{len(old['beats'])} 拍）")
    print("\n下一步（★ --min-band-h 必须给，且等于这里裁掉的高度）：")
    print(f"  python3 scripts/demo_caption.py --dir {out} "
          f"--beats {tl_path.parent / 'beats.json'} \\")
    print(f"          --voice {tl_path.parent / 'voice.m4a'} --min-band-h {band_h} \\")
    print("          --out docs/Training-Failure-Triage-demo.mp4")
    print(f"\n  新字幕条按文案算出来可能比 {band_h}px 矮（新文案折行更短），")
    print(f"  --min-band-h 会把它抬回 {band_h}px，否则内容与蓝线之间会露出一条底色边。")
    print("\n★ 出片后抽一帧看一眼：字幕条上下边缘不能有旧字幕的残影。")


if __name__ == "__main__":
    main()
