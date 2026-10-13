"""AI 诊断层：调用 Google Gemini 把审计数字转成可执行诊断。

设计原则：
  1. 只用标准库（urllib），不引入额外依赖，降低部署与演示风险。
  2. 无密钥时降级为离线模板，保证「没网 / 没 key」也能完整演示。
  3. 调用失败不向上抛异常，降级为 fallback，避免现场崩溃。
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List

from src.analyzer import PATTERN_LABELS

PROMPT_PATH = Path(__file__).resolve().parent / "prompts" / "diagnose.md"
GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
DEFAULT_MODEL = "gemini-2.5-flash"
REQUEST_TIMEOUT_SEC = 60

ACTION_BY_PATTERN: Dict[str, Dict[str, str]] = {
    "idle": {
        "name": "空转节点自动回收",
        "desc": "对利用率持续低于 5% 的节点加 TTL，到期自动释放回资源池",
        "cost": "中",
    },
    "over_request": {
        "name": "回收超额预留",
        "desc": "把申请卡数下限与实测峰值用量对齐，砍掉全程占位的空卡",
        "cost": "低",
    },
    "low_util": {
        "name": "低效任务配额重分配",
        "desc": "对利用率长期低于 30% 的任务做配额重分配或合并到同一节点",
        "cost": "中",
    },
}


def _settings() -> Dict[str, str]:
    return {
        "api_key": os.environ.get("GEMINI_API_KEY", "").strip(),
        "model": os.environ.get("GEMINI_MODEL", "").strip() or DEFAULT_MODEL,
    }


def build_prompt(summary: Dict[str, Any], findings: List[Dict[str, Any]]) -> str:
    """用审计结果填充提示词模板。"""
    template_path = PROMPT_PATH
    if template_path.exists():
        template = template_path.read_text(encoding="utf-8")
    else:
        template = (
            "你是资深 AI 基础设施能效专家。以下是多云 GPU 集群的审计结果。\n"
            "## 汇总\n{summary_json}\n\n## 明细\n{findings_json}\n"
        )
    return (
        template.replace("{summary_json}", json.dumps(summary, ensure_ascii=False, indent=2))
        .replace("{findings_json}", json.dumps(findings, ensure_ascii=False, indent=2))
    )


def _extract_text(payload: Dict[str, Any]) -> str:
    candidates = payload.get("candidates") or []
    if not candidates:
        raise ValueError("Gemini 响应中没有 candidates")
    parts = candidates[0].get("content", {}).get("parts", [])
    text = "".join(p.get("text", "") for p in parts).strip()
    if not text:
        raise ValueError("Gemini 响应内容为空")
    return text


def call_gemini(prompt: str, model: str, api_key: str, timeout: int = REQUEST_TIMEOUT_SEC) -> str:
    """调用 Gemini generateContent 接口，返回纯文本。"""
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.2, "maxOutputTokens": 2048},
    }
    request = urllib.request.Request(
        GEMINI_ENDPOINT.format(model=model),
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return _extract_text(json.loads(response.read().decode("utf-8")))


def offline_diagnosis(summary: Dict[str, Any], findings: List[Dict[str, Any]]) -> str:
    """离线降级模板：不依赖网络与密钥，用规则拼出结构化诊断。"""
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
    lines.append("### 3. 优化动作（按可回收金额降序）")
    pattern_totals: Dict[str, float] = {}
    for item in findings:
        pattern_totals[item["dominant_pattern"]] = (
            pattern_totals.get(item["dominant_pattern"], 0.0) + item["waste_cost_cny"]
        )
    for idx, (pattern, amount) in enumerate(
        sorted(pattern_totals.items(), key=lambda kv: kv[1], reverse=True), start=1
    ):
        action = ACTION_BY_PATTERN.get(pattern)
        if action is None:
            lines.append(
                f"{idx}. **{PATTERN_LABELS.get(pattern, pattern)}**"
                f"（预计可回收 ¥{amount:,.0f}）：需人工研判处置方式。"
            )
            continue
        lines.append(
            f"{idx}. **{action['name']}**（预计可回收 ¥{amount:,.0f}，实施成本{action['cost']}）："
            f"{action['desc']}。"
        )
    lines.append("")
    lines.append("### 4. 需要补充的数据")
    lines.append("缺少显存利用率、任务队列等待时长、卡型单价台账，补齐后可将估算升级为逐任务归因。")
    lines.append("")
    lines.append(
        "> 本段为**离线规则模板**输出，未调用大模型。设置 GEMINI_API_KEY 后可获得由模型生成的根因推断。"
    )
    return "\n".join(lines)


def diagnose(summary: Dict[str, Any], findings: List[Dict[str, Any]]) -> Dict[str, Any]:
    """生成 AI 诊断，返回 {mode, model?, text}。失败自动降级。"""
    settings = _settings()
    if not settings["api_key"]:
        return {"mode": "offline", "text": offline_diagnosis(summary, findings)}

    prompt = build_prompt(summary, findings)
    try:
        text = call_gemini(prompt, settings["model"], settings["api_key"])
        return {"mode": "gemini", "model": settings["model"], "text": text}
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError, TimeoutError, OSError) as exc:
        return {
            "mode": "fallback",
            "model": settings["model"],
            "error": f"{type(exc).__name__}: {exc}",
            "text": offline_diagnosis(summary, findings),
        }
