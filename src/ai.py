"""AI 决策层：让 Gemini 先调用工具取数，再基于工具返回值给出可执行决策。

与「读一段数字然后写一段话」的区别：
  1. AI 必须通过 `query_metrics` 拿数据，数字不能自己编；
  2. 涉及碳排的结论必须先跑 `simulate_defer` / `estimate_carbon`；
  3. 每条建议必须用 `propose_action` 登记，前端据此渲染「接受 / 拒绝」按钮——
     交互从「看报告」变成「做决策」。

设计原则：
  - 只用标准库（urllib），不引入额外依赖，降低部署与演示风险。
  - 无密钥时降级为离线模板（同样产出结构化 actions），保证离线也能完整演示。
  - 调用失败不向上抛异常，降级为 fallback，避免现场崩溃。
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

from src import carbon
from src.tools import TOOL_SPECS, ToolState, dispatch_tool

PROMPT_PATH = Path(__file__).resolve().parent / "prompts" / "diagnose.md"
GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
DEFAULT_MODEL = "gemini-2.5-flash"
REQUEST_TIMEOUT_SEC = 90
MAX_TOOL_TURNS = 8


def _settings() -> Dict[str, str]:
    return {
        "api_key": os.environ.get("GEMINI_API_KEY", "").strip(),
        "model": os.environ.get("GEMINI_MODEL", "").strip() or DEFAULT_MODEL,
    }


def build_prompt(
    summary: Dict[str, Any],
    findings: List[Dict[str, Any]],
    records: Optional[List[Dict[str, Any]]] = None,
) -> str:
    if PROMPT_PATH.exists():
        template = PROMPT_PATH.read_text(encoding="utf-8")
    else:
        template = (
            "你是资深 AI 基础设施能效专家。\n## 汇总\n{summary_json}\n"
            "## 明细\n{findings_json}\n## 全量\n{records_json}\n"
        )
    return (
        template.replace("{summary_json}", json.dumps(summary, ensure_ascii=False, indent=2))
        .replace("{findings_json}", json.dumps(findings, ensure_ascii=False, indent=2))
        .replace("{records_json}", json.dumps(records or [], ensure_ascii=False, indent=2))
    )


# ------------------------------------------------------------------ 网络
def _post_gemini(
    payload: Dict[str, Any], model: str, api_key: str, timeout: int = REQUEST_TIMEOUT_SEC
) -> Dict[str, Any]:
    request = urllib.request.Request(
        GEMINI_ENDPOINT.format(model=model),
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _agentic_diagnose(
    summary: Dict[str, Any],
    findings: List[Dict[str, Any]],
    records: List[Dict[str, Any]],
    model: str,
    api_key: str,
) -> Dict[str, Any]:
    """工具调用循环：模型 → 工具 → 模型 → … → 最终文本。"""
    state = ToolState(records=records, findings=findings, summary=summary)
    contents: List[Dict[str, Any]] = [
        {"role": "user", "parts": [{"text": build_prompt(summary, findings, records)}]}
    ]
    tool_calls: List[Dict[str, Any]] = []

    for _ in range(MAX_TOOL_TURNS):
        payload = {
            "contents": contents,
            "tools": [{"functionDeclarations": TOOL_SPECS}],
            "generationConfig": {"temperature": 0.2, "maxOutputTokens": 4096},
        }
        data = _post_gemini(payload, model, api_key)

        candidates = data.get("candidates") or []
        if not candidates:
            raise ValueError("Gemini 响应中没有 candidates")
        parts = (candidates[0].get("content") or {}).get("parts") or []

        calls = [p["functionCall"] for p in parts if p.get("functionCall")]
        if calls:
            contents.append({"role": "model", "parts": parts})
            responses: List[Dict[str, Any]] = []
            for call in calls:
                name = call.get("name", "")
                args = call.get("args") or {}
                tool_calls.append({"name": name, "args": args})
                result = dispatch_tool(name, args, state)
                responses.append(
                    {"functionResponse": {"name": name, "response": {"result": result}}}
                )
            contents.append({"role": "user", "parts": responses})
            continue

        text = "".join(p.get("text", "") for p in parts).strip()
        if text:
            return {
                "mode": "gemini",
                "model": model,
                "text": text,
                "actions": state.actions,
                "tool_calls": tool_calls,
            }

    raise RuntimeError(f"连续 {MAX_TOOL_TURNS} 轮只调用工具，未产出最终结论")


# ------------------------------------------------------------------ 离线降级
def offline_actions(findings: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """不依赖模型，用规则产出与在线模式同构的结构化建议。"""
    totals: Dict[str, float] = {}
    carbon_by_pattern: Dict[str, float] = {}
    for item in findings:
        pattern = item.get("dominant_pattern") or "unknown"
        totals[pattern] = totals.get(pattern, 0.0) + float(item.get("waste_cost_cny") or 0.0)
        carbon_by_pattern[pattern] = carbon_by_pattern.get(pattern, 0.0) + float(
            item.get("waste_carbon_kg") or 0.0
        )

    catalog = {
        "idle": (
            "空转节点自动回收",
            "对利用率持续低于 5% 的节点加 TTL，到期自动释放回资源池。",
            "中",
        ),
        "over_request": (
            "回收超额预留",
            "把申请卡数下限与实测峰值用量对齐，砍掉全程占位的空卡。",
            "低",
        ),
        "low_util": (
            "低效任务配额重分配",
            "对利用率长期低于 30% 的任务做配额重分配或合并到同一节点。",
            "中",
        ),
    }

    actions: List[Dict[str, Any]] = []
    for pattern, amount in sorted(totals.items(), key=lambda kv: kv[1], reverse=True):
        entry = catalog.get(pattern)
        if entry is None:
            continue
        actions.append(
            {
                "id": f"A{len(actions) + 1}",
                "title": entry[0],
                "detail": entry[1],
                "expected_cost_recovery_cny": round(amount, 2),
                "expected_carbon_reduction_kg": round(carbon_by_pattern.get(pattern, 0.0), 2),
                "effort": entry[2],
                "evidence": f"该模式合计浪费 ¥{amount:,.0f}",
            }
        )

    # 碳感知建议：挑电耗最大的节点，算挪时段能省多少碳
    if findings:
        heaviest = max(findings, key=lambda f: f.get("workload_energy_kwh", 0.0))
        if heaviest.get("workload_energy_kwh", 0.0) > 0:
            impact = carbon.defer_impact(
                heaviest["workload_energy_kwh"],
                heaviest.get("start_hour", 19),
                carbon.best_hour(),
            )
            if impact["carbon_reduction_kg"] > 0:
                actions.append(
                    {
                        "id": f"A{len(actions) + 1}",
                        "title": "把高耗节点挪到低碳时段",
                        "detail": (
                            f"{heaviest['node']} 当前在 {impact['from_hour']}:00 运行，"
                            f"挪到 {impact['to_hour']}:00 电网碳强度更低"
                            f"（{impact['intensity_from_kg_per_kwh']} → "
                            f"{impact['intensity_to_kg_per_kwh']} kgCO2e/kWh），"
                            f"电耗不变，碳排降 {impact['carbon_reduction_pct']}%。"
                        ),
                        "expected_cost_recovery_cny": 0.0,
                        "expected_carbon_reduction_kg": impact["carbon_reduction_kg"],
                        "effort": "中",
                        "evidence": (
                            f"{heaviest['node']} 周期电耗 "
                            f"{heaviest['workload_energy_kwh']:,.0f} kWh"
                        ),
                    }
                )
    return actions


def offline_diagnosis(
    summary: Dict[str, Any],
    findings: List[Dict[str, Any]],
    actions: Optional[List[Dict[str, Any]]] = None,
) -> str:
    actions = actions if actions is not None else offline_actions(findings)
    top = findings[:3]
    lines: List[str] = []

    lines.append("### 1. 浪费画像")
    lines.append(
        f"本批次共审计 {summary['record_count']} 条算力记录，浪费卡时 "
        f"{summary['total_waste_card_hours']:,.0f} 卡时，占预留卡时的 "
        f"{summary['waste_ratio_pct']:.1f}%，折合电费 ¥{summary['total_waste_cost_cny']:,.0f}、"
        f"碳排 {summary['total_waste_carbon_kg']:,.0f} kgCO2e"
        f"（约合 {summary['carbon_tree_equivalent']:,.0f} 棵成年树一年的固碳量）。"
    )
    if top:
        worst = top[0]
        lines.append(
            f"浪费最集中的节点是 {worst['cloud']} / {worst['node']}（{worst['gpu_type']}，"
            f"模式：{worst['pattern_label']}），单项浪费 ¥{worst['waste_cost_cny']:,.0f}。"
        )

    lines.append("")
    lines.append("### 2. 根因推断（离线规则版）")
    for item in top:
        if item["dominant_pattern"] == "over_request":
            reason = (
                f"申请 {item['requested_cards']} 卡但实际仅用 {item['used_cards']} 卡，"
                f"差 {item['requested_cards'] - item['used_cards']} 卡全程占位未参与计算"
            )
        elif item["dominant_pattern"] == "idle":
            reason = f"平均利用率仅 {item['avg_util_pct']}%，卡被占用但几乎不产出"
        else:
            reason = f"平均利用率 {item['avg_util_pct']}%，低于 30% 的低效阈值"
        lines.append(
            f"- **{item['node']}**（{item['gpu_type']}）：{reason}，浪费 "
            f"{item['waste_card_hours']:,.0f} 卡时 / ¥{item['waste_cost_cny']:,.0f}。"
            f"此结论由数据直接确认。"
        )

    lines.append("")
    lines.append("### 3. 优化动作（与下方决策清单一一对应）")
    for idx, action in enumerate(actions, start=1):
        benefit = []
        if action["expected_cost_recovery_cny"] > 0:
            benefit.append(f"回收 ¥{action['expected_cost_recovery_cny']:,.0f}")
        if action["expected_carbon_reduction_kg"] > 0:
            benefit.append(f"减碳 {action['expected_carbon_reduction_kg']:,.1f} kgCO2e")
        lines.append(
            f"{idx}. **{action['title']}**（{'、'.join(benefit) or '收益待评估'}，"
            f"实施成本{action['effort']}）：{action['detail']}"
        )

    lines.append("")
    lines.append("### 4. 需要补充的数据")
    lines.append(
        "缺少显存利用率、任务队列等待时长、任务时限约束与卡型单价台账，"
        "补齐后可将估算升级为逐任务归因，并判断哪些任务真的可以延后。"
    )
    lines.append("")
    lines.append(
        "> 本段为**离线规则模板**输出，未调用大模型。设置 GEMINI_API_KEY 后，"
        "将由模型自主调用工具取数并生成决策。"
    )
    return "\n".join(lines)


# ------------------------------------------------------------------ 入口
def _fallback(
    mode: str,
    summary: Dict[str, Any],
    findings: List[Dict[str, Any]],
    error: str,
    model: str = "",
) -> Dict[str, Any]:
    actions = offline_actions(findings)
    result = {
        "mode": mode,
        "text": offline_diagnosis(summary, findings, actions),
        "actions": actions,
        "tool_calls": [],
        "error": error,
    }
    if model:
        result["model"] = model
    return result


def diagnose(
    summary: Dict[str, Any],
    findings: List[Dict[str, Any]],
    records: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """生成 AI 诊断，返回 {mode, text, actions, tool_calls, ...}。失败自动降级。"""
    settings = _settings()
    records = records if records is not None else findings

    if not settings["api_key"]:
        return _fallback("offline", summary, findings, "未配置 GEMINI_API_KEY")

    try:
        return _agentic_diagnose(
            summary, findings, records, settings["model"], settings["api_key"]
        )
    except (
        urllib.error.URLError,
        urllib.error.HTTPError,
        ValueError,
        RuntimeError,
        TimeoutError,
        OSError,
    ) as exc:
        return _fallback(
            "fallback", summary, findings, f"{type(exc).__name__}: {exc}", settings["model"]
        )
