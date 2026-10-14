"""ai 模块的单元测试：重点验证离线降级路径的确定性与排序正确性。

注意：这些测试全部在**无密钥**状态下运行，只覆盖降级路径，
不产生任何外网请求（因此不会消耗配额，也不会在 CI 中变得不稳定）。
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.ai import build_prompt, diagnose, offline_actions, offline_diagnosis  # noqa: E402

FAKE_SUMMARY = {
    "record_count": 3,
    "total_waste_card_hours": 1000.0,
    "waste_ratio_pct": 50.0,
    "total_waste_cost_cny": 30000.0,
    "total_waste_carbon_kg": 100.0,
    "carbon_tree_equivalent": 6.0,
}

# 字段结构与 src/analyzer.py::analyze_record 的真实返回值对齐，
# 避免「测试靠猜字段名」——夹具缺字段时应当直接暴露为失败，而不是被静默跳过。
FAKE_FINDINGS = [
    {
        "cloud": "c", "node": "n-idle", "gpu_type": "H800",
        "requested_cards": 8, "used_cards": 8, "hours": 100.0,
        "avg_util_pct": 1.0, "start_hour": 20,
        "unused_card_hours": 0.0, "low_eff_card_hours": 792.0,
        "waste_card_hours": 792.0, "waste_cost_cny": 20000.0,
        "waste_energy_kwh": 138.6, "workload_energy_kwh": 17.85,
        "waste_carbon_kg": 80.53, "efficiency_pct": 1.0,
        "patterns": ["idle"], "dominant_pattern": "idle",
        "pattern_label": "长期空转", "severity": "high",
    },
    {
        "cloud": "c", "node": "n-over", "gpu_type": "H800",
        "requested_cards": 8, "used_cards": 4, "hours": 50.0,
        "avg_util_pct": 70.0, "start_hour": 10,
        "unused_card_hours": 200.0, "low_eff_card_hours": 0.0,
        "waste_card_hours": 200.0, "waste_cost_cny": 10000.0,
        "waste_energy_kwh": 35.0, "workload_energy_kwh": 114.45,
        "waste_carbon_kg": 20.33, "efficiency_pct": 50.0,
        "patterns": ["over_request"], "dominant_pattern": "over_request",
        "pattern_label": "超额申请", "severity": "high",
    },
]


class TestOfflineDiagnosis(unittest.TestCase):
    def test_actions_sorted_by_amount_desc(self):
        """优化动作必须按金额降序：空转(20000) 应排在超额预留(10000) 之前。"""
        text = offline_diagnosis(FAKE_SUMMARY, FAKE_FINDINGS)
        section = text.split("### 3.")[1]

        self.assertIn("空转节点自动回收", section)
        self.assertIn("回收超额预留", section)
        self.assertLess(
            section.index("空转节点自动回收"),
            section.index("回收超额预留"),
            "金额更高的空转动作必须排在前面",
        )

    def test_all_four_sections_present(self):
        text = offline_diagnosis(FAKE_SUMMARY, FAKE_FINDINGS)
        for marker in ("### 1.", "### 2.", "### 3.", "### 4."):
            self.assertIn(marker, text)

    def test_summary_numbers_are_echoed(self):
        text = offline_diagnosis(FAKE_SUMMARY, FAKE_FINDINGS)
        self.assertIn("1,000", text)   # 浪费卡时
        self.assertIn("¥30,000", text)  # 浪费电费

    def test_empty_findings_does_not_crash(self):
        text = offline_diagnosis(FAKE_SUMMARY, [])
        self.assertIn("### 1.", text)
        self.assertIn("### 3.", text)


class TestOfflineActions(unittest.TestCase):
    def test_actions_carry_carbon_reduction(self):
        """每条按模式汇总的动作都要带上对应的减碳量，不能只有金额。"""
        actions = offline_actions(FAKE_FINDINGS)
        idle = next(a for a in actions if a["title"] == "空转节点自动回收")
        self.assertAlmostEqual(idle["expected_carbon_reduction_kg"], 80.53, places=2)

    def test_carbon_aware_action_is_appended(self):
        """电耗最大的节点应产出一条「挪到低碳时段」的动作，且金额为 0、减碳为正。"""
        actions = offline_actions(FAKE_FINDINGS)
        defer = next(a for a in actions if "低碳时段" in a["title"])
        self.assertEqual(defer["expected_cost_recovery_cny"], 0.0)
        self.assertGreater(defer["expected_carbon_reduction_kg"], 0.0)
        # 权重最大的节点 n-over（workload_energy_kwh 最大）应当被选中
        self.assertIn("n-over", defer["detail"])

    def test_missing_optional_fields_do_not_crash(self):
        """findings 缺 waste_carbon_kg / workload_energy_kwh 时不得抛异常。"""
        sparse = [
            {"node": "n-x", "dominant_pattern": "idle", "waste_cost_cny": 100.0}
        ]
        actions = offline_actions(sparse)
        self.assertEqual(actions[0]["expected_carbon_reduction_kg"], 0.0)

    def test_no_defer_action_when_no_energy(self):
        """全零电耗时不应产出高耗节点挪时段建议（避免给空建议）。"""
        zero = [dict(f, workload_energy_kwh=0.0) for f in FAKE_FINDINGS]
        actions = offline_actions(zero)
        self.assertFalse(any("低碳时段" in a["title"] for a in actions))


class TestDiagnoseDegradation(unittest.TestCase):
    def test_without_key_returns_offline_mode(self):
        saved = os.environ.pop("GEMINI_API_KEY", None)
        try:
            result = diagnose(FAKE_SUMMARY, FAKE_FINDINGS)
        finally:
            if saved is not None:
                os.environ["GEMINI_API_KEY"] = saved
        self.assertEqual(result["mode"], "offline")
        self.assertIn("### 1.", result["text"])


class TestBuildPrompt(unittest.TestCase):
    def test_prompt_contains_data_and_guardrails(self):
        prompt = build_prompt(FAKE_SUMMARY, FAKE_FINDINGS)
        self.assertNotIn("{summary_json}", prompt)
        self.assertNotIn("{findings_json}", prompt)
        self.assertIn("n-idle", prompt)
        self.assertIn("不要编造数据中没有的数字", prompt)


if __name__ == "__main__":
    unittest.main(verbosity=2)
