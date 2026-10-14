#!/usr/bin/env python3
"""把 `scripts/record_demo.mjs` 录到的帧序列 + timeline.json 合成为演示视频。

为什么分两步（录制 / 合成）：录制只负责「真的走一遍并记下时间轴」，
字幕、进度条、码率这些**后期的东西一律不写进浏览器**——这样分镜改了只要重跑合成，
不用重录（重录意味着再花一次模型配额）。

字幕内容来自 timeline.json 的 beats，**不做任何剪辑拼接**：
每一句字幕的出现时刻就是那一拍真实开始/结束的时刻，画面与口播天然对齐。

字幕语言：`docs/demo-script.md` 的建议是「英文口播 + 中英双语硬字幕」——
口播用评审听得懂的语言，中文行留着方便自己核对数字（本项目的界面本身就是中文）。
所以每拍两行：英文在上、中文在下，靠那一拍的真实时间戳整段切换。

用法：
    python3 scripts/demo_caption.py [--dir shots-demo] [--out docs/Training-Failure-Triage-demo.mp4]
                                    [--fps 15] [--sub-lang both] [--voice shots-demo/voice.m4a]
                                    [--keep]

    --voice 指到 scripts/demo_voice.py 产出的旁白轨；不给就是静音占位。
    字幕文本默认取 <dir>/beats.json，可用 --beats 指到别处。

    帧序列已被清掉、只想换音轨时：
    python3 scripts/demo_caption.py --attach <已有成片.mp4> --voice shots-demo/voice.m4a \
            --out docs/Training-Failure-Triage-demo.mp4

    帧序列已被清掉、又要改字幕时（先用 scripts/rebuild_frames_from_film.py 从成片取回画面）：
    python3 scripts/demo_caption.py --dir shots-reburn --beats shots-demo/beats.json \
            --voice shots-demo/voice.m4a --out docs/Training-Failure-Triage-demo.mp4
"""

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
    sys.exit("找不到 ffmpeg：pip install imageio-ffmpeg 或装一个系统 ffmpeg")

# Arial 走英文（和被测界面同一族），中文走 Hiragino Sans GB。
# ★ 不要用 Arial 渲染中文：它会掉进 LastResort 变成豆腐块，而**不报错**。
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

PAD = 56              # 字幕条左右留白
PAD_TOP = 20          # 第一条基线之上的留白
PAD_BOTTOM = 18
RESERVE_RIGHT = 104   # 给右下角「第几拍 / 共几拍」预留的固定右栏，避免与中文行抢位
LINE_GAP = 6          # 英中两块之间的间距

SZ_EN = 24
LH_EN = 30
SZ_ZH = 22
LH_ZH = 29
SZ_PAGE = 15

MAX_EN_LINES = 2      # 超过就报错，不静默截断
MAX_ZH_LINES = 2


def pick_zh_font() -> str:
    for p in FONT_ZH_CANDIDATES:
        if Path(p).exists():
            return p
    sys.exit("找不到中文字体（试过 Hiragino Sans GB / STHeiti / Arial Unicode）")


def wrap(draw: ImageDraw.ImageDraw, text: str, font, max_w: int) -> list[str]:
    """按宽度折行。中文没有空格，所以按字符折；英文按词折。"""
    if not text:
        return []
    # 中日韩文本：逐字折行
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
    """一拍的字幕条：英文在上、中文在下，右侧留给页码。"""

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
                    help="both = 中英双语（默认，见 docs/demo-script.md 的建议）")
    ap.add_argument("--beats", default="",
                    help="字幕文本来源（默认 <dir>/beats.json）。见下面「字幕文本只有一个来源」。")
    ap.add_argument("--voice", default="",
                    help="旁白音轨（scripts/demo_voice.py 产出的 voice.m4a）。"
                         "不给就是静音占位。")
    ap.add_argument("--attach", default="",
                    help="换成已有成片的音轨：以这个 mp4 为画面来源（-c:v copy，不重编码）。"
                         "帧序列被清掉之后走这条路，见下面「为什么允许只换音轨」。")
    ap.add_argument("--allow-gaps", action="store_true",
                    help="即使存在超长冻帧也出片（默认拒绝，避免交付一版画面冻住的演示）")
    ap.add_argument("--allow-long", action="store_true",
                    help="即使总时长超过 180s 也出片（默认拒绝，官方要求少于 3 分钟）")
    ap.add_argument("--min-band-h", type=int, default=0,
                    help="字幕条最小高度。用于「从成片取回画面」那条路：裁掉字幕条时裁掉多少，"
                         "新字幕条就得至少长回来多少，否则会在内容与蓝线之间露出一条底色边。"
                         "见 scripts/rebuild_frames_from_film.py")
    ap.add_argument("--keep", action="store_true", help="保留中间帧目录")
    args = ap.parse_args()

    # ---------------------------------------------------------------- 只换音轨
    #
    # 为什么允许这条路：字幕烧完之后的画面（含那条已经核对过数字的字幕）本身就是要交付的东西，
    # 而帧序列是几百 MB 的中间产物，随时可能被清掉——清掉之后为了加一条音轨就重编码整条视频，
    # 甚至重录一遍，是本末倒置。重录更糟：一次巡检的真实结果（调用次数、被 cordon 的节点）
    # 会变，而 deck 与文档里引用的正是那一组数字，一重录全套证据链就对不上了。
    #
    # 所以：画面来源换成已有成片，视频轨 -c:v copy 原样搬过去，只把音轨换掉。
    if args.attach:
        src_video = Path(args.attach)
        if not src_video.exists():
            sys.exit(f"★ 找不到要换音轨的成片：{src_video}")
        if not args.voice:
            sys.exit("★ --attach 必须配 --voice 一起用（要换进去的那条音轨）")
        vpath = Path(args.voice)
        if not vpath.exists():
            sys.exit(f"★ 旁白音轨不存在：{vpath}")
        out = Path(args.out)
        tmp = out.with_name(out.stem + ".muxing.mp4")
        cmd = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
               "-i", str(src_video), "-i", str(vpath),
               "-map", "0:v", "-map", "1:a",
               "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
               "-shortest", "-movflags", "+faststart", str(tmp)]
        print(f"换音轨：{src_video} + {vpath} → {out}（视频轨不重编码）")
        if subprocess.run(cmd, capture_output=True, text=True).returncode != 0:
            sys.exit("★ 换音轨失败")
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

    # ---- 字幕文本只有一个来源：beats.json
    #
    # ★ 这是一个真踩过的坑。原先把字幕从 timeline.json 里读，而 timeline.json 是
    #   **录制那一刻**写下的，里面的文案会冻结在录制时。于是「改文案只要重跑合成、
    #   不用重录」这句话是假的 —— 重写了 20 拍之后重新合成，出来的还是旧字幕，
    #   而且不报错（两份文案都是合法字符串，谁也不会发现对不上）。
    #   现在以 beats.json 为准；它和 `record_demo.mjs --dump-beats` 是同一次导出，
    #   改文案 → 重导 beats.json → 重合成，路径才是通的。
    beats_path = Path(args.beats) if args.beats else src / "beats.json"
    if beats_path.exists():
        doc = json.loads(beats_path.read_text())
        by_id = {b["id"]: b for b in doc["beats"]}
        missing = [b["id"] for b in beats if b["id"] not in by_id]
        if missing:
            sys.exit(f"★ 这些拍在 {beats_path} 里找不到文案：{'、'.join(missing)}\n"
                     "  timeline.json 与 beats.json 不是同一批 —— 重新导一次 beats.json，"
                     "或者用 --beats 指到对的那一份。")
        for b in beats:
            nb = by_id[b["id"]]
            b["caption"] = nb.get("caption", "")
            b["zh"] = nb.get("zh", "")
        print(f"字幕文本 {beats_path}（{len(beats)} 拍）")
    else:
        print(f"字幕文本 {src / 'timeline.json'} —— 没有 beats.json，用的是录制时冻结的那份。\n"
              "  ★ 改过文案的话这份就是旧的：先跑 node scripts/record_demo.mjs --dump-beats --calls=N")

    if not frames:
        sys.exit("timeline.json 里没有帧")

    # 帧序列是几百 MB 的中间产物，可能已经被清掉了。早一点发现，比烧到一半才 FileNotFoundError 好：
    # 那时候报出来的是一句路径找不到，看不出「其实你只是想换条音轨」。
    probe_frame = src / "frames" / frames[0]["file"]
    if not probe_frame.exists():
        sys.exit(f"★ 帧序列不在了（{probe_frame}）。\n"
                 "  要么重跑 `node scripts/record_demo.mjs` 重新录一遍（会花一次模型配额，\n"
                 "  并且巡检的真实结果会变，deck/文档里引用的数字要跟着改）；\n"
                 "  要么用 `--attach <已有成片> --voice <音轨>`：画面原样搬过去，只换音轨。")

    zh_font = pick_zh_font()
    print(f"帧 {len(frames)} 张 · 时长 {total:.1f}s · 画布 {w}×{h} · 拍数 {n_beats}")
    print(f"字体 英文 {Path(FONT_EN).name} / 中文 {Path(zh_font).name}")

    # ---- 总时长闸
    #
    # 官方要求少于 3 分钟。录制脚本把目标定在 165s，但巡检本身耗时是不可控的
    # （顺利 15–40s，撞上游 500 触发续跑可到 90–120s），慢的时候后续停留会被压到
    # 缩放下限 0.5 而仍然超时。超时是「不符合提交要求」，不是「差一点」，所以这里拒绝出片。
    MAX_TOTAL = 180.0
    if total > MAX_TOTAL and not args.allow_long:
        sys.exit(f"\n★ 成片 {total:.1f}s 超过 {MAX_TOTAL:.0f}s 上限（官方要求少于 3 分钟）。\n"
                 "  多半是这次巡检跑得慢。重录一次通常就好；确认要留这一版再加 --allow-long。")

    # ---- 冻帧体检
    #
    # 录制时「暂停抓帧」的每一秒，在成片里都是同一张画面被按住。这是演示视频最会骗人的地方：
    # 观感上像「它在思考」，实际是什么都没动。而如果是一处等待条件写错，会按住几十秒。
    # 所以这里主动量出来：> GAP_WARN 报出来，> GAP_FAIL 直接不出片（除非 --allow-gaps）。
    GAP_WARN, GAP_FAIL = 1.2, 4.0
    gaps = []
    for i in range(len(frames) - 1):
        d = frames[i + 1]["t"] - frames[i]["t"]
        if d > GAP_WARN:
            gaps.append((d, frames[i]["t"]))
    if gaps:
        frozen = sum(g[0] for g in gaps)
        print(f"\n冻帧：{len(gaps)} 处、合计 {frozen:.1f}s / {total:.1f}s（{frozen / total * 100:.1f}%）")
        for d, at in sorted(gaps, reverse=True)[:8]:
            # 归属用区间中点：冻帧往往从上一拍的尾巴开始、落在下一拍里，用起点会指错拍
            mid = at + d / 2
            beat = next((b["id"] for b in beats if b["t0"] <= mid < b["t1"]), "?")
            print(f"    {at:7.1f}s 起 冻 {d:5.1f}s  （拍：{beat}）")
        worst = max(g[0] for g in gaps)
        if worst > GAP_FAIL and not args.allow_gaps:
            sys.exit(f"\n★ 最长冻帧 {worst:.1f}s 超过上限 {GAP_FAIL}s —— 不出一版画面冻住的成片。\n"
                     "  先修录制脚本里那一拍的等待条件；确认可接受再用 --allow-gaps 强制出片。")
    else:
        print(f"冻帧：无（所有间隔 ≤ {GAP_WARN}s）")

    # ---- 组字幕条：先量出每拍需要多高，取最大值作为全片统一高度
    #      （每拍各自变高会让字幕条上下跳动，看着很业余）
    probe = ImageDraw.Draw(Image.new("RGB", (8, 8)))
    bands: dict[int, Band] = {}
    for i, b in enumerate(beats):
        en = b.get("caption", "") if args.sub_lang in ("both", "en") else ""
        zh = b.get("zh", "") if args.sub_lang in ("both", "zh") else ""
        bands[i] = Band(w, en, zh, f"{i + 1} / {n_beats}", 0, zh_font)

    # ★ 超长要报出来，不许静默截断 —— 截断会让字幕与口播对不上
    over: list[str] = []
    for i, b in enumerate(beats):
        bands[i].measure(probe)
        if len(bands[i].en_lines) > MAX_EN_LINES or len(bands[i].zh_lines) > MAX_ZH_LINES:
            over.append(f"    {i + 1:>2}. {b['id']}  英 {len(bands[i].en_lines)} 行 / 中 {len(bands[i].zh_lines)} 行")
    if over:
        print("★ 有字幕超过行数上限，请先把文案改短（不截断）:")
        print("\n".join(over))
        sys.exit(1)

    band_h = max(bands[i].measure(probe) for i in range(n_beats))
    if band_h < args.min_band_h:
        print(f"字幕条按文案算出来是 {band_h}px，抬到 --min-band-h {args.min_band_h}px"
              f"（多出来的是底部留白，不是被拉高的字）")
        band_h = args.min_band_h
    # ★ 硬错误，不是警告：少一行字幕是「交付物悄悄缩水」，不该出片。
    #   上一次就是录制脚本忘了把 zh 写进 timeline.json，合成脚本只小声嘀咕了一句。
    if args.sub_lang in ("both", "zh"):
        missing = [b["id"] for i, b in enumerate(beats) if not bands[i].zh_lines]
        if missing:
            sys.exit(f"★ 需要中文行，但这些拍没有：{'、'.join(missing)}\n"
                     "  检查 record_demo.mjs 的 BEATS 是否写了 `zh`，以及 timeline.json 里是否带上了它。")
    print(f"字幕条高度 {band_h}px（取各拍最大值，全片统一）")

    for i in range(n_beats):
        bands[i].height = band_h
    band_img = {i: bands[i].render() for i in range(n_beats)}

    # ---- 逐帧算「这一帧属于哪一拍」——用帧的真实时间戳，所以字幕切换点就是那一拍的真实边界
    def beat_of(t: float) -> int:
        # ★ 写成「第一拍的 t1 大于 t 就是它」，而不是「t0 <= t < t1 才算」再兜底。
        #   原来那种写法在 t 落在第一拍之前时会掉到兜底值（最后一拍），
        #   于是成片开头那几帧显示的是最后一拍的字幕 —— 从成片里重建帧表（帧从 0 开始，
        #   而第一拍从 0.1s 起）正好会撞上这一点。
        for i, b in enumerate(beats):
            if t < b["t1"]:
                return i
        return n_beats - 1

    # ---- 把变帧率的时间戳摊平成固定帧率
    #
    # ★ 这里原来是「逐帧算自己的持续时间，各自 round(dur*fps) 次」：
    #       dur = frames[i+1].t - frames[i].t ;  plan += [i] * round(dur * fps)
    #   错在**每一帧各自取整**：误差不互相抵消，而是同向累积。
    #   录制抓帧是变帧率的（这一版实测 2412 帧 / 165.77s ≈ 14.55fps），
    #   几乎每帧的 dur*15 都落在 1.03 左右 → round 成 1，每帧白丢 0.03 帧；
    #   2386 帧累下来就是 31 帧 ≈ 2.03s。后果是三重的：
    #     · 视频轨只有 163.73s，而旁白 165.77s；
    #     · 最后那条 ffmpeg 带 -shortest，于是**最后 2 秒旁白被整段切掉**——
    #       最后一拍 "…and this one was acted on." 的尾巴正好落在这 2 秒里；
    #     · 画面整体比真时间快 1.2%，到片尾音画差出 2 秒。
    #   而它**一个错都不报**：163.7s 照样小于 180s 的总长闸，字幕行数也正常，
    #   只有把成片拆开量一下时长才看得见。
    #
    # 改成「按输出时间轴采样」：输出的第 n 帧，取 t = n/fps 那一刻正在显示的那一帧。
    # 输出帧数 = round(total*fps)，与真实时长严格对齐，累积误差恒为 0。
    # 双指针（j 只往前走）而不是每帧二分：帧表是按 t 递增的，整体 O(帧数)。
    n_out = max(1, round(total * args.fps))
    plan: list[int] = []
    j = 0
    for n in range(n_out):
        t = n / args.fps
        while j + 1 < len(frames) and frames[j + 1]["t"] <= t:
            j += 1
        plan.append(j)

    # ★ 量一下摊平后的时长，别让上面那种「悄悄短 2 秒」再回来。
    #   这套算法本身误差上限是半帧（1/(2*fps) ≈ 0.03s），所以 1s 的容差只会在
    #   有人把采样逻辑改回「逐帧取整」时才会触发。
    drift = total - len(plan) / args.fps
    print(f"摊平 {len(plan)} 帧 @ {args.fps}fps = {len(plan) / args.fps:.2f}s "
          f"（真实 {total:.2f}s，差 {drift:+.2f}s）")
    if abs(drift) > 1.0:
        sys.exit(f"★ 摊平后的时长与真实时长差了 {drift:+.2f}s —— 音画会对不上，不出片。\n"
                 "  采样逻辑（上面那个 plan 循环）被改坏了？误差上限应当是半帧。")

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

    print(f"已烧字幕 {seq} 帧（{seq / args.fps:.1f}s @ {args.fps}fps）→ {cap_dir}")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    # 音轨：给了 --voice 就用旁白，否则铺一条等长的静音占位。
    # ★ 静音占位不是「留个位置」这么简单：没有音轨的 mp4 在部分播放器里会被当成损坏文件，
    #   而且不做这一步的话，「出片」和「配音」就绑死了，改一个字都要重录一遍画面。
    voice = Path(args.voice) if args.voice else None
    if voice and not voice.exists():
        sys.exit(f"★ 指定的旁白音轨不存在：{voice}")
    if voice:
        audio_in = ["-i", str(voice)]
        audio_map = ["-map", "0:v", "-map", "1:a", "-c:a", "aac", "-b:a", "128k"]
        print(f"音轨：{voice}（旁白）")
    else:
        audio_in = ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]
        audio_map = ["-c:a", "aac", "-b:a", "96k"]
        print("音轨：静音占位（要配旁白见 scripts/demo_voice.py）")

    # ★ 必须显式把范围转成有限（tv）。
    #   输入帧是 JPEG（sRGB，全范围），ffmpeg 会顺着继承出 `yuvj420p(pc)`——
    #   那个标记本身没错，但**很多播放器/转码链会忽略 range 标记并默认按 tv 解释**，
    #   于是画面发灰。让「内容本身」就是 tv 范围、并且标成 tv，两种情况都不会错。
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
    print("编码中…")
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stderr[-3000:])
        sys.exit(f"ffmpeg 失败（{r.returncode}）")

    size_mb = out.stat().st_size / 1024 / 1024
    print(f"\n✓ {out}  {size_mb:.1f} MB  {total:.1f}s  {args.fps}fps  {w}×{h}")
    if voice:
        print("  完整链路：录 → 配音 → 合成，三步都不需要手工剪辑。")
    else:
        print(f"  下一步：python3 scripts/demo_voice.py --dir {src}")
        print(f"          python3 scripts/demo_caption.py --dir {src} --out {out} "
              f"--voice {src}/voice.m4a")

    if not args.keep:
        shutil.rmtree(cap_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
