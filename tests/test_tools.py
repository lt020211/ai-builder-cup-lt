"""tools 模块的单元测试：AI 可调用的四个工具必须行为确定、不因脏输入崩溃。"""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.analyzer import analyze_batch  # noqa: E402
from src.tools import TOOL_SPECS, ToolState, dispatch_tool  # noqa: E402

SAMPLE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "data",
    "sample_metrics.json",
)


def build_state():
    with open(SAMPLE_PATH, encoding="utf-8") as fh:
        records = json.load(fh)["records"]
    result = analyze_batch(records)
    return ToolState(
        records=result["records"], findings=result["findings"], summary=result["summary"]
    ), result


class TestToolSpecs(unittest.TestCase):
    def test_all_four_tools_declared(self):
        names = {spec["name"] for spec in TOOL_SPECS}
        self.assertEqual(
            names, {"query_metrics", "estimate_carbon", "simulate_defer", "propose_action"}
        )

    def test_every_spec_has_description_and_parameters(self):
        for spec in TOOL_SPECS:
            self.assertTrue(spec.get("description"))
            self.assertEqual(spec["parameters"]["type"], "object")


class TestQueryMetrics(unittest.TestCase):
    def test_default_returns_sorted_by_cost(self):
        state, _ = build_state()
        out = state.query_metrics()
        costs = [n["waste_cost_cny"] for n in out["nodes"]]
        self.assertEqual(costs, sorted(costs, reverse=True))
        self.assertGreater(out["matched"], 0)

    def test_filter_by_cloud(self):
        state, _ = build_state()
        out = state.query_metrics(cloud="cloud-a")
        self.assertTrue(all(n["cloud"] == "cloud-a" for n in out["nodes"]))

    def test_filter_by_pattern(self):
        state, _ = build_state()
        out = state.query_metrics(pattern="idle")
        self.assertTrue(all(n["dominant_pattern"] == "idle" for n in out["nodes"]))

    def test_limit_is_respected_and_capped(self):
        state, _ = build_state()
        self.assertLessEqual(len(state.query_metrics(limit=2)["nodes"]), 2)
        self.assertLessEqual(len(state.query_metrics(limit=9999)["nodes"]), 50)

    def test_bad_limit_falls_back_to_default(self):
        state, _ = build_state()
        self.assertGreater(len(state.query_metrics(limit="abc")["nodes"]), 0)

    def test_nodes_carry_carbon_and_start_hour_fields(self):
        state, _ = build_state()
        node = state.query_metrics(limit=1)["nodes"][0]
        for field in ("workload_energy_kwh", "waste_carbon_kg", "start_hour"):
            self.assertIn(field, node)


class TestEstimateCarbon(unittest.TestCase):
    def test_returns_intensity_and_best_hour(self):
        state, _ = build_state()
        out = state.estimate_carbon(energy_kwh=100, hour=19)
        self.assertGreater(out["carbon_kg"], 0)
        self.assertIn("best_hour", out)
        self.assertLess(out["best_hour_intensity_kg_per_kwh"], out["intensity_kg_per_kwh"])

    def test_bad_energy_returns_error(self):
        state, _ = build_state()
        self.assertIn("error", state.estimate_carbon(energy_kwh="lots", hour=1))


class TestSimulateDefer(unittest.TestCase):
    def test_finds_node_and_reports_reduction(self):
        state, result = build_state()
        target = result["records"][0]
        out = state.simulate_defer(node=target["node"], target_hour=13)
        self.assertEqual(out["node"], target["node"])
        self.assertIn("carbon_reduction_pct", out)
        self.assertTrue(out["energy_unchanged"])

    def test_unknown_node_lists_available(self):
        state, _ = build_state()
        out = state.simulate_defer(node="node-not-exist", target_hour=13)
        self.assertIn("error", out)
        self.assertIn("available_nodes", out)

    def test_node_with_zero_load_is_safe(self):
        state, _ = build_state()
        out = state.simulate_defer(node="node-b03", target_hour=13)
        self.assertNotIn("error", out)


class TestProposeAction(unittest.TestCase):
    def test_registers_and_numbers_sequentially(self):
        state, _ = build_state()
        first = state.propose_action(title="甲", detail="做甲")
        second = state.propose_action(title="乙", detail="做乙")
        self.assertEqual(first["registered"], "A1")
        self.assertEqual(second["registered"], "A2")
        self.assertEqual(len(state.actions), 2)

    def test_missing_numbers_default_to_zero(self):
        state, _ = build_state()
        state.propose_action(title="甲", detail="做甲")
        self.assertEqual(state.actions[0]["expected_cost_recovery_cny"], 0.0)
        self.assertEqual(state.actions[0]["expected_carbon_reduction_kg"], 0.0)

    def test_title_is_truncated(self):
        state, _ = build_state()
        state.propose_action(title="很" * 200, detail="d")
        self.assertLessEqual(len(state.actions[0]["title"]), 60)


class TestDispatch(unittest.TestCase):
    def test_unknown_tool_returns_error_not_raise(self):
        state, _ = build_state()
        out = dispatch_tool("rm_rf", {}, state)
        self.assertIn("error", out)
        self.assertIn("available_tools", out)

    def test_unknown_kwargs_are_ignored(self):
        state, _ = build_state()
        out = dispatch_tool("query_metrics", {"limit": 1, "nonsense": True}, state)
        self.assertNotIn("error", out)

    def test_empty_args_are_tolerated(self):
        state, _ = build_state()
        self.assertNotIn("error", dispatch_tool("query_metrics", {}, state))

    def test_missing_required_argument_returns_error(self):
        state, _ = build_state()
        self.assertIn("error", dispatch_tool("simulate_defer", {"target_hour": 13}, state))


if __name__ == "__main__":
    unittest.main(verbosity=2)
