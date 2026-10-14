#!/usr/bin/env python3
"""差分测试：逐字段比对 Python 参考实现与浏览器端 JS 移植版的输出。

为什么用差分而不是人工核对：
  移植了约 1000 行逻辑，靠眼睛比对必然漏。差分测试把「两份实现是否等价」变成
  一条可以随时重跑的命令——改任何一侧的算法，跑一遍就知道有没有跑偏。
  这比给 JS 再写一套单元测试更省事，也更可信：判据是参考实现的真实行为。

覆盖三组：
  1. analyze_batch 全量输出（含分组统计、汇总指标、每条记录的全部字段）
  2. 工具层 17 次调用，含边界用例——越界 limit、limit=0、limit="abc"、
     未知参数键、energy_kwh 传字符串、不存在的节点、未知工具名
  3. 离线降级引擎（offline_actions / offline_diagnosis 的文本与结构）

用法：
    python3 scripts/diff_port.py
退出码 0 表示完全一致，1 表示存在差异。
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUBLIC_JS = ROOT / "firebase" / "public" / "js"
SAMPLE = ROOT / "data" / "sample_metrics.json"

# ai.js 里那段「设置 GEMINI_API_KEY 后…」的尾注只存在于 Python 版：
# 浏览器版没有 API Key 这个概念，故刻意删去。比对前先规范化掉，避免误报。
PY_ONLY_TAIL = (
    "\n\n> 本段为**离线规则模板**输出，未调用大模型。"
    "设置 GEMINI_API_KEY 后，将由模型自主调用工具取数并生成决策。"
)
NORMALIZED_TAIL = "\n\n> 本段为**离线规则模板**输出，未调用大模型。"

# 提示词按这几个小节标题切成「模板文字 + 三段 JSON」。切分之后再比对，
# 是为了处理一个纯文本层面的差异：
#     Python json.dumps 把浮点整数写成 11328.0
#     JS  JSON.stringify 写成 11328
# 两者数值语义完全相同，直接比字符串会误报。所以 JSON 段解析后按数值比，
# 模板文字仍逐字比——这样既不放过真实的模板差异，也不被序列化格式干扰。
PROMPT_SECTIONS = [
    "## 本次审计的汇总数据\n",
    "## 浪费最严重的节点\n",
    "## 后台可用的节点全量清单（包含 start_hour，即当前负载运行时段）\n",
    "## 输出要求\n",
]

TOOL_SEQUENCE = [
    ("query_metrics", {}),
    ("query_metrics", {"cloud": "cloud-a", "limit": 3}),
    ("query_metrics", {"gpu_type": "H800"}),
    ("query_metrics", {"pattern": "idle"}),
    ("query_metrics", {"pattern": "over_request", "limit": 99}),
    ("query_metrics", {"limit": 0}),
    ("query_metrics", {"limit": "abc"}),
    ("query_metrics", {"unknown_key": 1, "cloud": "cloud-b"}),
    ("estimate_carbon", {"energy_kwh": 812.05, "hour": 19}),
    ("estimate_carbon", {"energy_kwh": 100, "hour": 13, "region": "southwest"}),
    ("estimate_carbon", {"energy_kwh": "x", "hour": 3}),
    ("simulate_defer", {"node": "node-a02", "target_hour": 13}),
    ("simulate_defer", {"node": "node-a02", "target_hour": 13, "region": "north"}),
    ("simulate_defer", {"node": "no-such-node", "target_hour": 5}),
    (
        "propose_action",
        {
            "title": "回收超额预留",
            "detail": "对齐申请与峰值",
            "expected_cost_recovery_cny": 12345.678,
            "expected_carbon_reduction_kg": 12.345,
            "effort": "低",
            "evidence": "node-a01",
        },
    ),
    ("propose_action", {"title": "x" * 80, "detail": "d"}),
    ("no_such_tool", {"a": 1}),
]

# ---- Node 侧脚本 -----------------------------------------------------------
NODE_SCRIPT = """
import { readFileSync, writeFileSync } from 'node:fs';
import { analyzeBatch } from './js/analyzer.js';
import * as carbon from './js/carbon.js';
import { ToolState, dispatchTool } from './js/tools.js';
import { offlineActions, offlineDiagnosis, buildPrompt } from './js/ai.js';

const sample = JSON.parse(readFileSync('./sample.json', 'utf8'));
const out = analyzeBatch(sample.records, sample.meta?.window ?? null);
out.carbon_profile = carbon.profileSnapshot();
out.carbon_peak = { best_hour: carbon.bestHour(), worst_hour: carbon.worstHour() };
delete out.summary.generated_at;
writeFileSync(process.argv[2], JSON.stringify(out));

const state = new ToolState(out.records, out.findings, out.summary);
const seq = JSON.parse(readFileSync('./seq.json', 'utf8'));
const calls = seq.map(([name, args]) => ({
  name, args, result: dispatchTool(name, args, state),
}));
const actions = offlineActions(out.findings);
writeFileSync(process.argv[3], JSON.stringify({
  calls, actions, text: offlineDiagnosis(out.summary, out.findings, actions),
}));

// 提示词渲染：确认没有残留占位符，且两侧渲染结果一致
writeFileSync(process.argv[4], buildPrompt(out.summary, out.findings, out.records));
"""

# ---- Python 侧脚本 ---------------------------------------------------------
PYTHON_SCRIPT = """
import json, sys
from pathlib import Path

# 脚本本身在临时目录里，sys.path[0] 指向那里；参考实现要用仓库根目录
sys.path.insert(0, '.')

from src.analyzer import analyze_batch
from src import carbon
from src.tools import ToolState, dispatch_tool
from src.ai import offline_actions, offline_diagnosis, build_prompt

sample = json.loads(Path('data/sample_metrics.json').read_text())
out = analyze_batch(sample['records'], window=sample.get('meta', {}).get('window'))
out['carbon_profile'] = carbon.profile_snapshot()
out['carbon_peak'] = {'best_hour': carbon.best_hour(), 'worst_hour': carbon.worst_hour()}
del out['summary']['generated_at']
Path(sys.argv[1]).write_text(json.dumps(out, ensure_ascii=False))

state = ToolState(records=out['records'], findings=out['findings'], summary=out['summary'])
seq = json.loads(Path(sys.argv[4]).read_text())
calls = [{'name': n, 'args': a, 'result': dispatch_tool(n, a, state)} for n, a in seq]
actions = offline_actions(out['findings'])
Path(sys.argv[2]).write_text(json.dumps({
    'calls': calls, 'actions': actions,
    'text': offline_diagnosis(out['summary'], out['findings'], actions),
}, ensure_ascii=False))

Path(sys.argv[3]).write_text(
    build_prompt(out['summary'], out['findings'], out['records'])
)
"""


def find_diff(a, b, path="") -> list[str]:
    """递归比对两个 JSON 结构，返回差异描述列表。"""
    diffs: list[str] = []

    both_num = isinstance(a, (int, float)) and isinstance(b, (int, float))
    if type(a) is not type(b) and not both_num:
        return [f"{path}: 类型不同 {type(a).__name__} vs {type(b).__name__} ({a!r} vs {b!r})"]

    if isinstance(a, dict):
        for key in sorted(set(a) | set(b)):
            if key not in a:
                diffs.append(f"{path}.{key}: 只有 JS 侧有")
            elif key not in b:
                diffs.append(f"{path}.{key}: 只有 Python 侧有")
            else:
                diffs.extend(find_diff(a[key], b[key], f"{path}.{key}"))
    elif isinstance(a, list):
        if len(a) != len(b):
            diffs.append(f"{path}: 数组长度 {len(a)} vs {len(b)}")
        for i, (x, y) in enumerate(zip(a, b)):
            diffs.extend(find_diff(x, y, f"{path}[{i}]"))
    elif a != b:
        diffs.append(f"{path}: {a!r} vs {b!r}")
    return diffs


def first_divergence(a: str, b: str, context: int = 60) -> str:
    """定位两段文本的首个分歧点，并给出前后文——比打印整段好定位得多。"""
    limit = min(len(a), len(b))
    i = 0
    while i < limit and a[i] == b[i]:
        i += 1
    if i == limit and len(a) == len(b):
        return "(完全一致)"
    start = max(0, i - context)
    return (
        f"首个分歧在第 {i} 字符\n"
        f"      Python: …{a[start:i + context]!r}\n"
        f"      JS    : …{b[start:i + context]!r}"
    )


def compare_prompts(py_text: str, js_text: str) -> list[str]:
    """结构化比对提示词：模板文字逐字比，JSON 段解析后按数值比。

    返回差异描述列表（空表示一致）。切不出小节时退化为整体字符串比对，
    这样即使模板被改动了结构，也不会静默放过。
    """
    py_parts = split_prompt(py_text)
    js_parts = split_prompt(js_text)
    if py_parts is None or js_parts is None:
        if py_text == js_text:
            return []
        return ["提示词整体不一致（且无法按小节切分，无法进一步定位）"]

    diffs: list[str] = []
    for i, (a, b) in enumerate(zip(py_parts, js_parts)):
        if a == b:
            continue
        if isinstance(a, str) and isinstance(b, str):
            diffs.append(
                f"提示词第 {i} 段（模板文字）不一致 → {first_divergence(a, b)}"
            )
        else:
            diffs.extend(find_diff(a, b, f"提示词第 {i} 段（JSON 数据）"))
    return diffs


def split_prompt(text: str):
    """把提示词切成 [模板文字, 汇总JSON, 模板文字, 明细JSON, 模板文字, 全量JSON, 尾段文字]。

    用四个小节标题作为切点；标题之间的内容是 JSON。返回 None 表示结构不符合预期
    （这时调用方退化为整体字符串比对，不会静默放过差异）。
    """
    parts: list = []
    rest = text
    for i, marker in enumerate(PROMPT_SECTIONS):
        idx = rest.find(marker)
        if idx < 0:
            return None
        parts.append(rest[: idx + len(marker)])
        rest = rest[idx + len(marker) :]

        if i == len(PROMPT_SECTIONS) - 1:
            parts.append(rest)
            rest = ""
            break

        nxt = rest.find(PROMPT_SECTIONS[i + 1])
        if nxt < 0:
            return None
        try:
            parts.append(json.loads(rest[:nxt]))
        except json.JSONDecodeError:
            return None
        rest = rest[nxt:]

    return parts if rest == "" else None


def must_run(cmd: list[str], cwd: Path | None = None, label: str = "") -> None:
    result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        print(f"!! {label or cmd[0]} 执行失败（exit {result.returncode}）")
        print(result.stdout[-3000:])
        print(result.stderr[-3000:])
        sys.exit(1)


def main() -> int:
    work = Path(tempfile.mkdtemp(prefix="gwa-diff-"))
    try:
        # Node 需要 ESM：放一个 type=module 的 package.json 到临时目录
        (work / "package.json").write_text('{"type":"module"}')
        shutil.copytree(PUBLIC_JS, work / "js")
        shutil.copy(SAMPLE, work / "sample.json")
        (work / "seq.json").write_text(json.dumps(TOOL_SEQUENCE))
        (work / "gen.mjs").write_text(NODE_SCRIPT)
        (work / "gen_py.py").write_text(PYTHON_SCRIPT)

        js_analyze, js_tools, js_prompt = (
            work / "js_analyze.json",
            work / "js_tools.json",
            work / "js_prompt.txt",
        )
        py_analyze, py_tools, py_prompt = (
            work / "py_analyze.json",
            work / "py_tools.json",
            work / "py_prompt.txt",
        )

        print("运行 JS 移植版（node）…")
        must_run(["node", "gen.mjs", str(js_analyze), str(js_tools), str(js_prompt)],
                 cwd=work, label="node")
        print("运行 Python 参考版…")
        must_run(
            [sys.executable, str(work / "gen_py.py"),
             str(py_analyze), str(py_tools), str(py_prompt), str(work / "seq.json")],
            cwd=ROOT, label="python",
        )

        py_t = json.loads(py_tools.read_text())
        js_t = json.loads(js_tools.read_text())
        py_t["text"] = py_t["text"].replace(PY_ONLY_TAIL, NORMALIZED_TAIL)

        suites = [
            ("1. analyze_batch 全量输出",
             json.loads(py_analyze.read_text()), json.loads(js_analyze.read_text())),
            (f"2. 工具层 {len(TOOL_SEQUENCE)} 次调用（含边界用例）", py_t, js_t),
        ]

        all_diffs: list[tuple[str, list[str]]] = []
        for name, py, js in suites:
            diffs = find_diff(py, js)
            all_diffs.append((name, diffs))
            mark = "✅ 完全一致" if not diffs else f"❌ {len(diffs)} 处差异"
            print(f"  {name:<44} {mark}")

        prompt_diffs = compare_prompts(py_prompt.read_text(), js_prompt.read_text())
        all_diffs.append(("3. 提示词渲染（模板逐字 + JSON 按数值）", prompt_diffs))
        mark = "✅ 完全一致" if not prompt_diffs else f"❌ {len(prompt_diffs)} 处差异"
        print(f"  {'3. 提示词渲染（模板逐字 + JSON 按数值）':<44} {mark}")

        total = sum(len(d) for _, d in all_diffs)
        print()
        if total:
            print("差异明细：")
            for name, diffs in all_diffs:
                for d in diffs[:20]:
                    print(f"  [{name}] {d}")
            return 1

        print("✅ Python 参考实现与浏览器端 JS 移植版输出逐字段一致。")
        return 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
