"""ai 模块的单元测试：重点验证离线降级路径的确定性与排序正确性。

注意：这些测试全部在**无密钥**状态下运行，只覆盖降级路径，
不产生任何外网请求（因此不会消耗配额，也不会在 CI 中变得不稳定）。
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.ai import build_prompt, diagnose, offline_diagnosis  # noqa: E402

FAKE_SUMMARY = {
    "record_count": 3,
    "total_waste_card_hours": 1000.0,
    "waste_ratio_pct": 50.0,
    "total_waste_cost_cny": 30000.0,
    "total_waste_carbon_kg": 100.0,
    "carbon_tree_equivalent": 6.0,
}

FAKE_FINDINGS = [
    {"cloud": "c", "node": "n-idle", "gpu_type": "H800", "requested_cards": 8,
     "used_cards": 8, "avg_util_pct": 1.0, "waste_card_hours": 800.0,
     "waste_cost_cny": 20000.0, "dominant_pattern": "idle", "pattern_label": "长期空转"},
    {"cloud": "c", "node": "n-over", "gpu_type": "H800", "requested_cards": 8,
     "used_cards": 4, "avg_util_pct": 70.0, "waste_card_hours": 200.0,
     "waste_cost_cny": 10000.0, "dominant_pattern": "over_request", "pattern_label": "超额申请"},
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
