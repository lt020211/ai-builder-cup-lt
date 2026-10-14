"""电网碳强度模型：把「什么时候跑」纳入碳排计算。

为什么需要它：同样的电耗，在不同时段跑，碳排不一样——正午光伏出力高峰时碳强度最低，
晚高峰火电调峰时最高。这是「碳感知调度」的物理依据。

⚠️ 本模块的时段曲线与区域系数是公开资料的**简化近似**，不是实测数据。
   接入真实碳强度数据源（如 Electricity Maps）后可整体替换，对外接口保持不变。
"""

from __future__ import annotations

from typing import Any, Dict

# 全国电网平均排放因子（kgCO2e/kWh）
BASE_CARBON_FACTOR_KG_PER_KWH = 0.581

# 24 小时相对强度，全天均值为 1.0。
# 依据：光伏出力高峰在正午 → 碳强度最低（0.82）；晚高峰火电调峰 → 最高（1.10）。
HOURLY_PROFILE = (
    0.92, 0.90, 0.88, 0.87, 0.86, 0.87, 0.90, 0.95,
    1.00, 1.02, 0.98, 0.90, 0.84, 0.82, 0.83, 0.87,
    0.92, 0.98, 1.06, 1.10, 1.08, 1.04, 1.00, 0.96,
)

# 区域电网结构差异带来的系数（火电占比高的区域系数更大）
REGION_FACTORS: Dict[str, float] = {
    "default": 1.00,
    "north": 1.05,
    "east": 1.00,
    "south": 0.85,
    "southwest": 0.55,
}


def normalize_hour(hour: Any) -> int:
    try:
        return int(round(float(hour))) % 24
    except (TypeError, ValueError):
        return 0


def hourly_factor(hour: Any) -> float:
    """返回该小时的相对碳强度系数（全天均值为 1.0）。"""
    return HOURLY_PROFILE[normalize_hour(hour)]


def region_factor(region: str | None) -> float:
    return REGION_FACTORS.get((region or "default"), REGION_FACTORS["default"])


def intensity_kg_per_kwh(hour: Any, region: str | None = "default") -> float:
    """某小时某区域的电网碳强度（kgCO2e/kWh）。"""
    return round(
        BASE_CARBON_FACTOR_KG_PER_KWH * hourly_factor(hour) * region_factor(region), 4
    )


def carbon_kg(energy_kwh: float, hour: Any, region: str | None = "default") -> float:
    return round(max(float(energy_kwh), 0.0) * intensity_kg_per_kwh(hour, region), 2)


def best_hour() -> int:
    """全天碳强度最低的小时。"""
    return min(range(24), key=lambda h: HOURLY_PROFILE[h])


def worst_hour() -> int:
    """全天碳强度最高的小时。"""
    return max(range(24), key=lambda h: HOURLY_PROFILE[h])


def defer_impact(
    energy_kwh: float,
    from_hour: Any,
    to_hour: Any = None,
    region: str | None = "default",
) -> Dict[str, Any]:
    """把一段固定电耗从 from_hour 挪到 to_hour，碳排如何变化。

    to_hour 缺省时给出全天最优时段（碳强度最低的小时）。
    """
    src = normalize_hour(from_hour)
    dst = normalize_hour(to_hour) if to_hour is not None else best_hour()

    before = carbon_kg(energy_kwh, src, region)
    after = carbon_kg(energy_kwh, dst, region)
    reduction = round(before - after, 2)
    pct = round(100.0 * reduction / before, 2) if before > 0 else 0.0

    return {
        "energy_kwh": round(max(float(energy_kwh), 0.0), 2),
        "region": region or "default",
        "from_hour": src,
        "to_hour": dst,
        "intensity_from_kg_per_kwh": intensity_kg_per_kwh(src, region),
        "intensity_to_kg_per_kwh": intensity_kg_per_kwh(dst, region),
        "carbon_before_kg": before,
        "carbon_after_kg": after,
        "carbon_reduction_kg": reduction,
        "carbon_reduction_pct": pct,
        "energy_unchanged": True,
    }


def profile_snapshot() -> Dict[str, Any]:
    """返回全天碳强度曲线，供前端画图或 AI 参考。"""
    return {
        "base_factor_kg_per_kwh": BASE_CARBON_FACTOR_KG_PER_KWH,
        "hourly_factor": list(HOURLY_PROFILE),
        "best_hour": best_hour(),
        "worst_hour": worst_hour(),
        "note": "相对强度，全天均值为 1.0；简化近似，非实测数据",
    }
