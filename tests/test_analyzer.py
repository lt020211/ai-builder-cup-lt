"""analyzer 模块的单元测试。

运行方式：
    python -m unittest discover -s tests -v
    # 或
    pytest tests/
"""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.analyzer import (  # noqa: E402
    CARBON_FACTOR_KG_PER_KWH,
    GPU_SPECS,
    IDLE_POWER_RATIO,
    analyze_batch,
    analyze_record,
)

SAMPLE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "data",
    "sample_metrics.json",
)


class TestAnalyzeRecord(unittest.TestCase):
    def test_over_request(self):
        """申请 8 卡只用 4 卡：浪费全部来自超额预留。"""
        r = analyze_record(
            {
                "cloud": "c1",
                "node": "n1",
                "gpu_type": "H800",
                "requested_cards": 8,
                "used_cards": 4,
                "hours": 100,
                "avg_util_pct": 60,
            }
        )
        self.assertEqual(r["waste_card_hours"], 400.0)
        self.assertEqual(r["unused_card_hours"], 400.0)
        self.assertEqual(r["low_eff_card_hours"], 0.0)
        self.assertEqual(r["waste_cost_cny"], 400 * 24.0)
        expected_kwh = 400 * GPU_SPECS["H800"]["tdp_w"] * IDLE_POWER_RATIO / 1000
        self.assertAlmostEqual(r["waste_energy_kwh"], expected_kwh, places=2)
        self.assertAlmostEqual(r["waste_carbon_kg"], expected_kwh * CARBON_FACTOR_KG_PER_KWH, places=2)
        self.assertEqual(r["efficiency_pct"], 50.0)
        self.assertEqual(r["dominant_pattern"], "over_request")
        self.assertIn("over_request", r["patterns"])

    def test_idle(self):
        """利用率 0%：全部卡时按低效折算。"""
        r = analyze_record(
            {
                "cloud": "c1",
                "node": "n2",
                "gpu_type": "A100",
                "requested_cards": 4,
                "used_cards": 4,
                "hours": 100,
                "avg_util_pct": 0,
            }
        )
        self.assertEqual(r["unused_card_hours"], 0.0)
        self.assertEqual(r["low_eff_card_hours"], 400.0)
        self.assertEqual(r["waste_card_hours"], 400.0)
        self.assertEqual(r["efficiency_pct"], 0.0)
        self.assertIn("idle", r["patterns"])
        self.assertEqual(r["dominant_pattern"], "idle")

    def test_low_util_partial(self):
        """利用率 12%：只有未利用的那部分计为浪费。"""
        r = analyze_record(
            {
                "cloud": "c1",
                "node": "n3",
                "gpu_type": "H20",
                "requested_cards": 4,
                "used_cards": 4,
                "hours": 100,
                "avg_util_pct": 12,
            }
        )
        self.assertAlmostEqual(r["low_eff_card_hours"], 4 * 100 * 0.88, places=2)
        self.assertAlmostEqual(r["waste_card_hours"], 352.0, places=2)
        self.assertEqual(r["dominant_pattern"], "low_util")

    def test_efficient_has_no_waste(self):
        """利用率 50%：在 30% 阈值之上，不应判定为浪费。"""
        r = analyze_record(
            {
                "cloud": "c1",
                "node": "n4",
                "gpu_type": "V100",
                "requested_cards": 4,
                "used_cards": 4,
                "hours": 100,
                "avg_util_pct": 50,
            }
        )
        self.assertEqual(r["waste_card_hours"], 0.0)
        self.assertEqual(r["waste_cost_cny"], 0.0)
        self.assertEqual(r["efficiency_pct"], 100.0)
        self.assertEqual(r["patterns"], ["efficient"])

    def test_unknown_gpu_type_uses_default_spec(self):
        r = analyze_record(
            {
                "cloud": "c1",
                "node": "n5",
                "gpu_type": "UNKNOWN",
                "requested_cards": 2,
                "used_cards": 1,
                "hours": 10,
                "avg_util_pct": 90,
            }
        )
        self.assertEqual(r["waste_card_hours"], 10.0)
        self.assertEqual(r["waste_cost_cny"], 10 * 15.0)

    def test_missing_fields_do_not_crash(self):
        r = analyze_record({})
        self.assertEqual(r["waste_card_hours"], 0.0)
        self.assertEqual(r["patterns"], ["efficient"])


class TestAnalyzeBatch(unittest.TestCase):
    def setUp(self):
        with open(SAMPLE_PATH, encoding="utf-8") as fh:
            self.payload = json.load(fh)

    def test_sample_file_shape(self):
        self.assertIn("records", self.payload)
        self.assertGreater(len(self.payload["records"]), 0)

    def test_batch_totals_are_consistent(self):
        result = analyze_batch(self.payload["records"], window=self.payload["meta"]["window"])
        summary = result["summary"]
        records = result["records"]

        self.assertEqual(summary["record_count"], len(records))
        self.assertAlmostEqual(
            summary["total_waste_card_hours"],
            round(sum(r["waste_card_hours"] for r in records), 2),
            places=2,
        )
        self.assertAlmostEqual(
            summary["total_waste_cost_cny"],
            round(sum(r["waste_cost_cny"] for r in records), 2),
            places=2,
        )
        self.assertTrue(0.0 <= summary["waste_ratio_pct"] <= 100.0)

    def test_findings_sorted_desc_and_excludes_efficient(self):
        result = analyze_batch(self.payload["records"])
        costs = [f["waste_cost_cny"] for f in result["findings"]]
        self.assertEqual(costs, sorted(costs, reverse=True))
        self.assertTrue(all(c > 0 for c in costs))
        self.assertTrue(all(f["dominant_pattern"] != "efficient" for f in result["findings"]))

    def test_groups_cover_all_records(self):
        result = analyze_batch(self.payload["records"])
        grouped = sum(v["records"] for v in result["by_cloud"].values())
        self.assertEqual(grouped, len(self.payload["records"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
