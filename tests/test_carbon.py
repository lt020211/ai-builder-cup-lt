"""carbon 模块的单元测试：碳强度曲线与挪时段测算。"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src import carbon  # noqa: E402


class TestProfile(unittest.TestCase):
    def test_profile_covers_24_hours(self):
        self.assertEqual(len(carbon.HOURLY_PROFILE), 24)

    def test_best_and_worst_hours_are_extremes(self):
        best = carbon.best_hour()
        worst = carbon.worst_hour()
        self.assertEqual(carbon.HOURLY_PROFILE[best], min(carbon.HOURLY_PROFILE))
        self.assertEqual(carbon.HOURLY_PROFILE[worst], max(carbon.HOURLY_PROFILE))
        self.assertNotEqual(best, worst)

    def test_best_hour_is_lower_than_worst(self):
        self.assertLess(carbon.hourly_factor(carbon.best_hour()),
                        carbon.hourly_factor(carbon.worst_hour()))

    def test_normalize_hour_handles_junk(self):
        self.assertEqual(carbon.normalize_hour(25), 1)
        self.assertEqual(carbon.normalize_hour(-1), 23)
        self.assertEqual(carbon.normalize_hour("13"), 13)
        self.assertEqual(carbon.normalize_hour(None), 0)
        self.assertEqual(carbon.normalize_hour("abc"), 0)


class TestIntensity(unittest.TestCase):
    def test_intensity_scales_with_base_factor(self):
        mid = carbon.intensity_kg_per_kwh(0)
        self.assertGreater(mid, 0)
        self.assertLess(mid, carbon.BASE_CARBON_FACTOR_KG_PER_KWH * 1.2)

    def test_region_factor_applied(self):
        plain = carbon.intensity_kg_per_kwh(12, "default")
        hydro = carbon.intensity_kg_per_kwh(12, "southwest")
        coal = carbon.intensity_kg_per_kwh(12, "north")
        self.assertLess(hydro, plain)
        self.assertGreater(coal, plain)

    def test_unknown_region_falls_back_to_default(self):
        self.assertEqual(
            carbon.intensity_kg_per_kwh(12, "nowhere"),
            carbon.intensity_kg_per_kwh(12, "default"),
        )

    def test_carbon_kg_is_energy_times_intensity(self):
        energy = 1000.0
        self.assertAlmostEqual(
            carbon.carbon_kg(energy, 12), energy * carbon.intensity_kg_per_kwh(12), places=2
        )

    def test_carbon_kg_clamps_negative_energy(self):
        self.assertEqual(carbon.carbon_kg(-500, 12), 0.0)


class TestDeferImpact(unittest.TestCase):
    def test_moving_from_worst_to_best_reduces_carbon(self):
        result = carbon.defer_impact(
            1000.0, from_hour=carbon.worst_hour(), to_hour=carbon.best_hour()
        )
        self.assertGreater(result["carbon_reduction_kg"], 0)
        self.assertGreater(result["carbon_reduction_pct"], 0)
        self.assertTrue(result["energy_unchanged"])
        self.assertEqual(result["energy_kwh"], 1000.0)

    def test_moving_from_best_to_worst_increases_carbon(self):
        result = carbon.defer_impact(
            1000.0, from_hour=carbon.best_hour(), to_hour=carbon.worst_hour()
        )
        self.assertLess(result["carbon_reduction_kg"], 0)
        self.assertLess(result["carbon_reduction_pct"], 0)

    def test_default_target_is_best_hour(self):
        result = carbon.defer_impact(500.0, from_hour=carbon.worst_hour())
        self.assertEqual(result["to_hour"], carbon.best_hour())
        self.assertGreater(result["carbon_reduction_kg"], 0)

    def test_zero_energy_yields_zero_reduction(self):
        result = carbon.defer_impact(0.0, 19, 13)
        self.assertEqual(result["carbon_reduction_kg"], 0.0)
        self.assertEqual(result["carbon_reduction_pct"], 0.0)


class TestSnapshot(unittest.TestCase):
    def test_snapshot_shape(self):
        snap = carbon.profile_snapshot()
        self.assertEqual(len(snap["hourly_factor"]), 24)
        self.assertIn("best_hour", snap)
        self.assertIn("worst_hour", snap)


if __name__ == "__main__":
    unittest.main(verbosity=2)
