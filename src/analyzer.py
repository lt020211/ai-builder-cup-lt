"""算力浪费识别与折算模型。

本模块是纯计算层，不依赖网络与 AI，可独立单元测试。

简化模型的全部假设（详见 docs/architecture.md）：

1. 浪费卡时 = 申请未用卡时 + 低效折算卡时
   - 申请未用卡时 = max(申请卡数 - 实际使用卡数, 0) x 时长
   - 低效折算卡时 = 使用卡数 x 时长 x (1 - 平均利用率)，仅当平均利用率 < 30%
2. 浪费电耗 = 浪费卡时 x 单卡 TDP x 空转功率系数 / 1000
   空转功率系数取 0.25（业界经验值：闲置 GPU 功率约为 TDP 的 20%~30%）
3. 浪费电费 = 浪费电耗 x 工业电价
4. 浪费碳排 = 浪费电耗 x 全国电网平均排放因子
"""

from __future__ import annotations

import datetime as _dt
from typing import Any, Dict, List, Optional

PRICE_PER_KWH_CNY = 0.70
CARBON_FACTOR_KG_PER_KWH = 0.581
IDLE_POWER_RATIO = 0.25
LOW_UTIL_THRESHOLD_PCT = 30.0
IDLE_UTIL_THRESHOLD_PCT = 5.0
TREE_ANNUAL_CARBON_KG = 18.0

GPU_SPECS: Dict[str, Dict[str, float]] = {
    "H800": {"tdp_w": 700, "price_per_card_hour_cny": 24.0},
    "H100": {"tdp_w": 700, "price_per_card_hour_cny": 28.0},
    "A100": {"tdp_w": 400, "price_per_card_hour_cny": 15.0},
    "V100": {"tdp_w": 300, "price_per_card_hour_cny": 8.0},
    "H20": {"tdp_w": 400, "price_per_card_hour_cny": 12.0},
}
DEFAULT_SPEC = {"tdp_w": 400.0, "price_per_card_hour_cny": 15.0}


def active_power_ratio(util_pct: float) -> float:
    """利用率到功耗占比的线性近似。

    利用率 0% 时取空转功率系数（0.25），100% 时取满功耗（1.0），中间线性插值。
    真实 GPU 功耗对利用率并非严格线性，此处为简化模型；因为是单调映射，
    不改变「利用率越高越费电」的结论方向。
    """
    return IDLE_POWER_RATIO + (1.0 - IDLE_POWER_RATIO) * max(
        min(util_pct, 100.0), 0.0
    ) / 100.0

PATTERN_LABELS = {
    "over_request": "超额申请",
    "idle": "长期空转",
    "low_util": "低效运行",
    "efficient": "使用充分",
}

SEVERITY_HIGH_COST = 5000.0
SEVERITY_MEDIUM_COST = 1000.0


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _to_int(value: Any, default: int = 0) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _severity(cost_cny: float) -> str:
    if cost_cny >= SEVERITY_HIGH_COST:
        return "high"
    if cost_cny >= SEVERITY_MEDIUM_COST:
        return "medium"
    return "low"


def analyze_record(rec: Dict[str, Any]) -> Dict[str, Any]:
    """对单条算力记录做浪费识别与折算。"""
    cloud = str(rec.get("cloud") or "unknown")
    node = str(rec.get("node") or "unknown")
    gpu_type = str(rec.get("gpu_type") or "unknown")
    spec = GPU_SPECS.get(gpu_type, DEFAULT_SPEC)

    requested = max(_to_int(rec.get("requested_cards")), 0)
    used = max(_to_int(rec.get("used_cards")), 0)
    hours = max(_to_float(rec.get("hours")), 0.0)
    util = min(max(_to_float(rec.get("avg_util_pct")), 0.0), 100.0)
    start_hour = _to_int(rec.get("start_hour"), 19) % 24

    unused_cards = max(requested - used, 0)
    unused_card_hours = unused_cards * hours

    low_eff_card_hours = 0.0
    if used > 0 and util < LOW_UTIL_THRESHOLD_PCT:
        low_eff_card_hours = used * hours * (1.0 - util / 100.0)

    waste_card_hours = unused_card_hours + low_eff_card_hours

    patterns: List[str] = []
    if unused_cards > 0:
        patterns.append("over_request")
    if used > 0 and util < IDLE_UTIL_THRESHOLD_PCT:
        patterns.append("idle")
    elif used > 0 and util < LOW_UTIL_THRESHOLD_PCT:
        patterns.append("low_util")
    if not patterns:
        patterns.append("efficient")

    if "over_request" in patterns:
        dominant = "over_request"
    elif "idle" in patterns:
        dominant = "idle"
    elif "low_util" in patterns:
        dominant = "low_util"
    else:
        dominant = "efficient"

    energy_kwh = waste_card_hours * spec["tdp_w"] * IDLE_POWER_RATIO / 1000.0
    workload_energy_kwh = (
        used * hours * spec["tdp_w"] * active_power_ratio(util) / 1000.0
    )
    cost_cny = waste_card_hours * spec["price_per_card_hour_cny"]
    carbon_kg = energy_kwh * CARBON_FACTOR_KG_PER_KWH

    reserved_card_hours = requested * hours
    if reserved_card_hours > 0:
        efficiency = max(0.0, 100.0 * (1.0 - waste_card_hours / reserved_card_hours))
    else:
        efficiency = 100.0

    return {
        "cloud": cloud,
        "node": node,
        "gpu_type": gpu_type,
        "requested_cards": requested,
        "used_cards": used,
        "hours": round(hours, 2),
        "avg_util_pct": round(util, 2),
        "start_hour": start_hour,
        "unused_card_hours": round(unused_card_hours, 2),
        "low_eff_card_hours": round(low_eff_card_hours, 2),
        "waste_card_hours": round(waste_card_hours, 2),
        "waste_cost_cny": round(cost_cny, 2),
        "waste_energy_kwh": round(energy_kwh, 2),
        "workload_energy_kwh": round(workload_energy_kwh, 2),
        "waste_carbon_kg": round(carbon_kg, 2),
        "efficiency_pct": round(efficiency, 2),
        "patterns": patterns,
        "dominant_pattern": dominant,
        "pattern_label": PATTERN_LABELS[dominant],
        "severity": _severity(cost_cny),
    }


def _group_sum(rows: List[Dict[str, Any]], key: str) -> Dict[str, Any]:
    """按指定字段分组求和。"""
    out: Dict[str, Any] = {}
    for r in rows:
        bucket = out.setdefault(
            r[key],
            {
                "records": 0,
                "waste_card_hours": 0.0,
                "waste_cost_cny": 0.0,
                "waste_energy_kwh": 0.0,
                "waste_carbon_kg": 0.0,
            },
        )
        bucket["records"] += 1
        bucket["waste_card_hours"] += r["waste_card_hours"]
        bucket["waste_cost_cny"] += r["waste_cost_cny"]
        bucket["waste_energy_kwh"] += r["waste_energy_kwh"]
        bucket["waste_carbon_kg"] += r["waste_carbon_kg"]
    for bucket in out.values():
        for field in ("waste_card_hours", "waste_cost_cny", "waste_energy_kwh", "waste_carbon_kg"):
            bucket[field] = round(bucket[field], 2)
    return out


def analyze_batch(
    records: List[Dict[str, Any]], window: Optional[str] = None
) -> Dict[str, Any]:
    """对一批算力记录做整体审计，返回汇总、明细与分组统计。"""
    analyses = [analyze_record(r) for r in records]

    findings = sorted(
        [a for a in analyses if a["waste_card_hours"] > 0],
        key=lambda a: a["waste_cost_cny"],
        reverse=True,
    )

    total_waste = sum(a["waste_card_hours"] for a in analyses)
    total_cost = sum(a["waste_cost_cny"] for a in analyses)
    total_energy = sum(a["waste_energy_kwh"] for a in analyses)
    total_carbon = sum(a["waste_carbon_kg"] for a in analyses)
    total_reserved = sum(a["requested_cards"] * a["hours"] for a in analyses)
    total_used = sum(a["used_cards"] * a["hours"] for a in analyses)

    by_pattern: Dict[str, Any] = {}
    for a in analyses:
        if a["dominant_pattern"] == "efficient":
            continue
        bucket = by_pattern.setdefault(
            a["dominant_pattern"],
            {"label": PATTERN_LABELS[a["dominant_pattern"]], "records": 0, "waste_cost_cny": 0.0},
        )
        bucket["records"] += 1
        bucket["waste_cost_cny"] = round(bucket["waste_cost_cny"] + a["waste_cost_cny"], 2)

    summary = {
        "generated_at": _dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "window": window or "未指定",
        "record_count": len(analyses),
        "total_reserved_card_hours": round(total_reserved, 2),
        "total_used_card_hours": round(total_used, 2),
        "total_waste_card_hours": round(total_waste, 2),
        "waste_ratio_pct": round(100.0 * total_waste / total_reserved, 2) if total_reserved else 0.0,
        "total_waste_cost_cny": round(total_cost, 2),
        "total_waste_energy_kwh": round(total_energy, 2),
        "total_waste_carbon_kg": round(total_carbon, 2),
        "carbon_tree_equivalent": round(total_carbon / TREE_ANNUAL_CARBON_KG, 1),
        "reclaimable_h800_card_hours": round(
            total_cost / GPU_SPECS["H800"]["price_per_card_hour_cny"], 1
        ),
        "high_severity_count": len([a for a in findings if a["severity"] == "high"]),
        "model_assumptions": {
            "price_per_kwh_cny": PRICE_PER_KWH_CNY,
            "carbon_factor_kg_per_kwh": CARBON_FACTOR_KG_PER_KWH,
            "idle_power_ratio": IDLE_POWER_RATIO,
            "low_util_threshold_pct": LOW_UTIL_THRESHOLD_PCT,
            "idle_util_threshold_pct": IDLE_UTIL_THRESHOLD_PCT,
        },
    }

    return {
        "summary": summary,
        "findings": findings[:20],
        "records": analyses,
        "by_cloud": _group_sum(analyses, "cloud"),
        "by_gpu_type": _group_sum(analyses, "gpu_type"),
        "by_pattern": by_pattern,
    }
