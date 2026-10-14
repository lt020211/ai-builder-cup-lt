"""AI 可调用的工具集。

这是本项目的关键设计：AI 不是「读一段数字然后写一段话」，而是**先调用工具取数、
再基于工具返回值下结论**。工具返回的所有数字都来自确定性代码，AI 无法凭空生成。

工具清单：
    query_metrics      按条件查节点指标
    estimate_carbon    估算某电耗在某小时的碳排，并给出最优时段
    simulate_defer     模拟「把某节点的负载挪到另一个小时」的碳排变化
    propose_action     登记一条优化建议（前端据此渲染「接受/拒绝」按钮）
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from src import carbon

# ---------------------------------------------------------------- 工具声明
# 格式遵循 Gemini functionDeclarations
TOOL_SPECS: List[Dict[str, Any]] = [
    {
        "name": "query_metrics",
        "description": (
            "按条件查询集群节点的算力浪费指标。不传参数则返回浪费金额最高的若干节点。"
            "每次分析请先调用本工具取数，再下结论。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "cloud": {"type": "string", "description": "云厂商标识，如 cloud-a"},
                "gpu_type": {"type": "string", "description": "卡型，如 H800"},
                "pattern": {
                    "type": "string",
                    "description": "浪费模式：over_request / idle / low_util",
                },
                "limit": {"type": "integer", "description": "返回条数上限，默认 10"},
            },
        },
    },
    {
        "name": "estimate_carbon",
        "description": (
            "估算给定电耗在指定小时的碳排，并返回全天碳强度最低与最高的时段。"
            "用于判断「什么时候跑更低碳」。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "energy_kwh": {"type": "number", "description": "电耗，单位 kWh"},
                "hour": {"type": "integer", "description": "小时（0-23）"},
                "region": {
                    "type": "string",
                    "description": "电网区域：north / east / south / southwest，缺省 default",
                },
            },
            "required": ["energy_kwh", "hour"],
        },
    },
    {
        "name": "simulate_defer",
        "description": (
            "模拟把某个节点的负载从当前时段挪到 target_hour 运行，碳排会变化多少。"
            "电耗不变，只改变碳强度。用于给出「推迟到几点」的具体建议。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "node": {"type": "string", "description": "节点标识，如 node-a02"},
                "target_hour": {"type": "integer", "description": "目标小时（0-23）"},
                "region": {"type": "string", "description": "电网区域，缺省 default"},
            },
            "required": ["node", "target_hour"],
        },
    },
    {
        "name": "propose_action",
        "description": (
            "登记一条优化建议。每给出一条建议都必须调用本工具登记，"
            "否则该建议不会出现在交付给用户的决策清单里。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "动作名称，不超过 20 字"},
                "detail": {"type": "string", "description": "具体怎么做，一到两句话"},
                "expected_cost_recovery_cny": {
                    "type": "number",
                    "description": "预计可回收金额（元）",
                },
                "expected_carbon_reduction_kg": {
                    "type": "number",
                    "description": "预计可减少碳排（kgCO2e）",
                },
                "effort": {
                    "type": "string",
                    "description": "实施成本：低 / 中 / 高",
                },
                "evidence": {
                    "type": "string",
                    "description": "支撑该建议的具体节点或数字",
                },
            },
            "required": ["title", "detail"],
        },
    },
]


# ---------------------------------------------------------------- 执行状态
class ToolState:
    """承载一次分析会话的数据与产出。"""

    def __init__(
        self,
        records: List[Dict[str, Any]],
        findings: List[Dict[str, Any]],
        summary: Dict[str, Any],
    ) -> None:
        self.records = records
        self.findings = findings
        self.summary = summary
        self.actions: List[Dict[str, Any]] = []
        self._by_node = {r["node"]: r for r in records}

    # --- 工具实现 -------------------------------------------------
    def query_metrics(
        self,
        cloud: Optional[str] = None,
        gpu_type: Optional[str] = None,
        pattern: Optional[str] = None,
        limit: Any = 10,
    ) -> Dict[str, Any]:
        rows = self.records
        if cloud:
            rows = [r for r in rows if r["cloud"] == cloud]
        if gpu_type:
            rows = [r for r in rows if r["gpu_type"] == gpu_type]
        if pattern:
            rows = [
                r
                for r in rows
                if pattern == r["dominant_pattern"] or pattern in r["patterns"]
            ]

        try:
            cap = max(1, min(int(limit), 50))
        except (TypeError, ValueError):
            cap = 10

        rows = sorted(rows, key=lambda r: r["waste_cost_cny"], reverse=True)[:cap]
        fields = (
            "cloud",
            "node",
            "gpu_type",
            "requested_cards",
            "used_cards",
            "hours",
            "avg_util_pct",
            "start_hour",
            "waste_card_hours",
            "waste_cost_cny",
            "waste_energy_kwh",
            "waste_carbon_kg",
            "workload_energy_kwh",
            "dominant_pattern",
            "pattern_label",
            "severity",
        )
        return {
            "matched": len(rows),
            "nodes": [{k: r[k] for k in fields} for r in rows],
            "total_waste_cost_cny": round(sum(r["waste_cost_cny"] for r in rows), 2),
        }

    def estimate_carbon(
        self, energy_kwh: Any, hour: Any, region: Optional[str] = None
    ) -> Dict[str, Any]:
        try:
            energy = float(energy_kwh)
        except (TypeError, ValueError):
            return {"error": "energy_kwh 必须是数字"}
        hour_i = carbon.normalize_hour(hour)
        return {
            "energy_kwh": energy,
            "hour": hour_i,
            "region": region or "default",
            "intensity_kg_per_kwh": carbon.intensity_kg_per_kwh(hour_i, region),
            "carbon_kg": carbon.carbon_kg(energy, hour_i, region),
            "best_hour": carbon.best_hour(),
            "worst_hour": carbon.worst_hour(),
            "best_hour_intensity_kg_per_kwh": carbon.intensity_kg_per_kwh(
                carbon.best_hour(), region
            ),
        }

    def simulate_defer(
        self, node: Any, target_hour: Any, region: Optional[str] = None
    ) -> Dict[str, Any]:
        record = self._by_node.get(str(node))
        if record is None:
            return {
                "error": f"找不到节点 {node}",
                "available_nodes": sorted(self._by_node)[:20],
            }
        result = carbon.defer_impact(
            energy_kwh=record["workload_energy_kwh"],
            from_hour=record["start_hour"],
            to_hour=target_hour,
            region=region,
        )
        result["node"] = record["node"]
        result["gpu_type"] = record["gpu_type"]
        result["current_start_hour"] = record["start_hour"]
        result["note"] = (
            "仅考虑运行时段变化带来的碳强度差异，电耗本身不变；"
            "未计入任务时限约束，需人工确认可延后性。"
        )
        return result

    def propose_action(
        self,
        title: Any,
        detail: Any,
        expected_cost_recovery_cny: Any = 0,
        expected_carbon_reduction_kg: Any = 0,
        effort: Any = "中",
        evidence: Any = "",
    ) -> Dict[str, Any]:
        def _num(v: Any) -> float:
            try:
                return round(float(v), 2)
            except (TypeError, ValueError):
                return 0.0

        action = {
            "id": f"A{len(self.actions) + 1}",
            "title": str(title)[:60],
            "detail": str(detail),
            "expected_cost_recovery_cny": _num(expected_cost_recovery_cny),
            "expected_carbon_reduction_kg": _num(expected_carbon_reduction_kg),
            "effort": str(effort),
            "evidence": str(evidence),
        }
        self.actions.append(action)
        return {"registered": action["id"], "total_actions": len(self.actions)}


# ---------------------------------------------------------------- 分发
_HANDLERS = {
    "query_metrics": ("query_metrics", {"cloud", "gpu_type", "pattern", "limit"}),
    "estimate_carbon": ("estimate_carbon", {"energy_kwh", "hour", "region"}),
    "simulate_defer": ("simulate_defer", {"node", "target_hour", "region"}),
    "propose_action": (
        "propose_action",
        {
            "title",
            "detail",
            "expected_cost_recovery_cny",
            "expected_carbon_reduction_kg",
            "effort",
            "evidence",
        },
    ),
}


def dispatch_tool(name: str, args: Dict[str, Any], state: ToolState) -> Dict[str, Any]:
    """执行一次工具调用。参数名不匹配时只取认识的字段，避免模型传错键导致崩溃。"""
    entry = _HANDLERS.get(name)
    if entry is None:
        return {"error": f"未知工具 {name}", "available_tools": sorted(_HANDLERS)}

    method_name, allowed = entry
    clean = {k: v for k, v in (args or {}).items() if k in allowed}
    try:
        return getattr(state, method_name)(**clean)
    except Exception as exc:  # 工具异常不应中断整个会话
        return {"error": f"{type(exc).__name__}: {exc}"}
