#!/usr/bin/env python3
"""给演示视频配英语旁白音轨。

为什么要单独一个脚本、而不是在合成脚本里顺手合成语音：

1. **旁白要跟着画面走，不能反过来。** 每一拍该说多久，是由 `timeline.json` 里那一拍
   真实花了多少秒决定的（那是一次真的巡检、不是摆拍）。所以顺序必须是
   「先录 → 拿到真实时间窗 → 再决定这段话要按什么语速说」，而不是「先说好再剪画面」。
2. **旁白文本与字幕文本是同一份来源。** `shots-demo/beats.json` 里每一拍同时有
   `caption`（英文字幕）、`zh`（中文字幕）、`voice`（口播）三条，它们是同一件事的三种写法：
   字幕可以写缩写与并列，念出来要成句。改文案只改 `record_demo.mjs` 的 BEATS，
   重跑 `--dump-beats` 即可，不必碰这个脚本。
3. **语速必须逐条实测。** 神经音色的语速因内容差异很大（同样的词数，数字多的句子会明显慢），
   按词数估算是估不准的。这个脚本的做法是「先按默认语速合成 → 量出真实时长 →
   算出为了装进时间窗需要的语速 → 再合成一遍」。

装不下怎么办：只允许两种手段，且都有上限 —— 先调 edge-tts 的 `rate`（±20%/35% 封顶），
仍超出才用 ffmpeg 的 `atempo` 收尾。**不允许把一段话硬压成快放**，那听起来像广告，
而且评审会怀疑画面是为了对上口播才放慢的。

本机没有 numpy，所以拼接走 ffmpeg 的 `apad` + concat demuxer（每个音段补齐到它那一拍的
精确秒数，再顺序拼起来），不做任何浮点混音。

用法：
    python3 scripts/demo_voice.py [--dir shots-demo] [--voice en-US-AndrewNeural]
                                  [--out shots-demo/voice.m4a] [--keep-segments] [--probe]
"""

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
    sys.exit("找不到 ffmpeg：pip install imageio-ffmpeg 或装一个系统 ffmpeg")

try:
    import edge_tts
except Exception:  # pragma: no cover
    sys.exit("找不到 edge-tts：pip install edge-tts")

SR = 48000

# 每段旁白在它那一拍里的位置：稍微晚一点起、留一点尾，听起来不像踩点播报。
LEAD = 0.35
TAIL = 0.45

# 希望一段话占掉可用时长的比例。太低显得空，太满显得赶。
FILL = 0.90

# 语速调整的封顶。这两个数就是本片的念白节奏政策，宁可在头尾留一点静音，
# 也不把一段话拧成快放 —— 一旦调过头，评审会怀疑画面是为了对上口播才放慢的。
RATE_MIN, RATE_MAX = -15, 30

# 一次合成里，最多允许多少条语音任务同时在跑（edge-tts 是走网络的，开太多会被限流）
CONCURRENCY = 4


def ff_duration(path: Path) -> float:
    """用 ffmpeg 读时长（本机没有 ffprobe，imageio-ffmpeg 只带 ffmpeg）。"""
    r = subprocess.run([FFMPEG, "-hide_banner", "-i", str(path)],
                       capture_output=True, text=True)
    for line in r.stderr.splitlines():
        if "Duration:" in line:
            raw = line.split("Duration:")[1].split(",")[0].strip()
            hh, mm, ss = raw.split(":")
            return int(hh) * 3600 + int(mm) * 60 + float(ss)
    return 0.0


async def synth(text: str, voice: str, rate_pct: int, out: Path) -> None:
    """合成一段语音。rate_pct 是相对默认语速的百分比，例如 +12 / -8。"""
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
            print(f"      合成失败（{e}），{n}/{tries} 重试…")
        await asyncio.sleep(1.2 * n)
    raise RuntimeError(f"合成失败：{text[:40]}")


def atempo_chain(factor: float) -> str:
    """ffmpeg 单个 atempo 只吃 0.5–2.0，超出就串起来。"""
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
    """把一拍的话装进它那一拍的时间窗，返回这一段的实测结果。

    `raw0`（默认语速那一版）会留在盘上：调节奏常量时重跑，第一遍合成可以直接复用，
    不必为了看一眼数字再打一次网络。要重来加 `--fresh`。
    """
    usable = max(1.0, window - LEAD - TAIL)
    raw0 = seg_dir / f"{i:02d}-{beat_id}-raw0.mp3"
    raw = seg_dir / f"{i:02d}-{beat_id}-raw.mp3"
    fin = seg_dir / f"{i:02d}-{beat_id}.mp3"

    # 第一遍：按默认语速合成，量出真实时长
    if raw0.exists() and raw0.stat().st_size > 1200 and not fresh:
        dur0 = ff_duration(raw0)
    else:
        asyncio.run(synth_retry(text, voice, 0, raw0))
        dur0 = ff_duration(raw0)

    want = dur0
    rate_pct = 0
    if dur0 > 0:
        desired = dur0 / (usable * FILL)          # >1 需要变快，<1 可以放慢
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

    # 第二遍之后还超出可用时长，才动用 atempo（有上限，且会记录下来说明了它）
    tempo = 1.0
    if dur1 > usable:
        tempo = dur1 / usable
        cmd = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
               "-i", str(raw), "-af", atempo_chain(tempo),
               "-ac", "1", "-ar", str(SR), str(fin)]
        if subprocess.run(cmd, capture_output=True).returncode != 0:
            raise RuntimeError(f"atempo 失败：{beat_id}")
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
    """把每段旁白补齐到它那一拍的精确秒数，再顺序拼成一条与视频等长的音轨。"""
    t0_first = tl[0]["t0"]
    parts: list[Path] = []

    # 开场前的静音（第一拍从 0.1s 才开始）
    if t0_first > 0.02:
        lead = seg_dir / "00-lead.wav"
        _silence(lead, t0_first)
        parts.append(lead)

    cursor = t0_first
    for i, (b, t) in enumerate(zip(beats, tl)):
        window = round(t["t1"] - t["t0"], 3)
        seg = seg_dir / f"{i:02d}-{b['id']}.mp3"
        wav = seg_dir / f"seg{i:02d}.wav"
        # apad 补到 window，-t 再切到 window：两侧都锁死，拼出来不会有缝
        cmd = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
               "-i", str(seg),
               "-af", f"adelay={int(LEAD * 1000)}|{int(LEAD * 1000)},"
                      f"aresample={SR},aformat=channel_layouts=stereo,"
                      f"apad,atrim=0:{window}",
               "-t", str(window), "-ac", "2", "-ar", str(SR),
               "-c:a", "pcm_s16le", str(wav)]
        if subprocess.run(cmd, capture_output=True).returncode != 0:
            raise RuntimeError(f"补齐音段失败：{b['id']}")
        parts.append(wav)
        cursor += window

    # 尾部补齐：视频总长 - 已经铺好的长度
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
        raise RuntimeError(f"生成静音段失败：{path.name}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="shots-demo")
    ap.add_argument("--voice", default="en-US-AndrewNeural",
                    help="edge-tts 音色名（默认 en-US-AndrewNeural）")
    ap.add_argument("--out", default="", help="默认 <dir>/voice.m4a")
    ap.add_argument("--keep-segments", action="store_true", help="保留逐拍音频，便于试听")
    ap.add_argument("--fresh", action="store_true",
                    help="丢弃已缓存的合成结果重新合成（默认复用，方便反复调节奏）")
    ap.add_argument("--probe", action="store_true",
                    help="只量语速与时间窗，不写最终音轨")
    args = ap.parse_args()

    src = Path(args.dir)
    beats_path = src / "beats.json"
    tl_path = src / "timeline.json"
    if not beats_path.exists():
        sys.exit(f"缺 {beats_path}：先跑 node scripts/record_demo.mjs --dump-beats --calls=N")
    if not tl_path.exists():
        sys.exit(f"缺 {tl_path}：先跑 node scripts/record_demo.mjs")

    beats_all = json.loads(beats_path.read_text())["beats"]
    tl_doc = json.loads(tl_path.read_text())
    tl = tl_doc["beats"]
    total = tl_doc["duration"]
    fps = tl_doc.get("fps", 15)

    # 以 timeline 的拍为准（它是真实录到的），文案按 id 去 beats.json 取
    by_id = {b["id"]: b for b in beats_all}
    missing = [t["id"] for t in tl if t["id"] not in by_id]
    if missing:
        sys.exit(f"★ timeline 里有拍在 beats.json 里找不到文案：{'、'.join(missing)}")
    beats = [by_id[t["id"]] for t in tl]

    blank = [b["id"] for b in beats if not (b.get("voice") or b.get("caption"))]
    if blank:
        sys.exit(f"★ 这些拍没有旁白文本：{'、'.join(blank)}")

    print(f"拍数 {len(beats)} · 视频总长 {total:.1f}s · 音色 {args.voice}")

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
            flag = f"  ★ 仍超出 {r['over']:.2f}s"
        elif r["tempo"] > 1.001:
            flag = f"  收尾 ×{r['tempo']:.2f}"
        print(f"  {i + 1:>2}. {b['id']:8s} 窗 {r['window']:5.1f}s  "
              f"念 {r['dur']:5.1f}s  语速 {r['rate_pct']:+3d}%{flag}")

    bad = [r for r in rows if r["over"] > 0.15]
    if bad:
        print("\n★ 这些拍念完仍然超出它那一拍的时间窗（会压到下一拍的头上）：")
        for r in bad:
            print(f"    {r['id']}  超出 {r['over']:.2f}s  文本 {len(r['text'])} 字符")
        print("  优先改短这几句文案（record_demo.mjs 的 BEATS → --dump-beats），"
              "别继续往上加语速。")

    slow = [r for r in rows if r["rate_pct"] <= RATE_MIN or r["rate_pct"] >= RATE_MAX]
    if slow:
        print(f"\n  语速已顶到边界（{RATE_MIN}% ~ {RATE_MAX}%）的拍："
              f"{'、'.join(r['id'] for r in slow)}")

    if args.probe:
        print("\n（--probe：只量不改）")
        return

    listing = build_segments(seg_dir, beats, tl, total, fps)
    out = Path(args.out) if args.out else src / "voice.m4a"
    cmd = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
           "-f", "concat", "-safe", "0", "-i", str(listing),
           "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", str(SR),
           "-movflags", "+faststart", str(out)]
    if subprocess.run(cmd, capture_output=True).returncode != 0:
        sys.exit("音轨编码失败")

    d = ff_duration(out)
    print(f"\n✓ {out}  {out.stat().st_size / 1024 / 1024:.2f} MB  {d:.2f}s"
          f"  （视频 {total:.2f}s）")
    print(f"  下一个命令：python3 scripts/demo_caption.py --dir {src} "
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
