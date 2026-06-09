from __future__ import annotations

import argparse
import unittest

from orizu_gepa.cli import apply_budget_defaults
from orizu_gepa.optimizer import TextGepaConfig


def budget_namespace(**overrides):
    values = {
        "budget": None,
        "max_iterations": None,
        "max_metric_calls": None,
        "max_full_evals": None,
    }
    values.update(overrides)
    return argparse.Namespace(**values)


class CliBudgetTests(unittest.TestCase):
    def test_no_budget_input_defaults_to_auto_without_iteration_cap(self):
        args = budget_namespace()

        apply_budget_defaults(args, [])

        self.assertEqual(args.budget, TextGepaConfig.budget)
        self.assertIsNone(args.max_iterations)
        self.assertIsNone(args.max_metric_calls)
        self.assertIsNone(args.max_full_evals)

    def test_single_budget_preset_keeps_iteration_cap_unset(self):
        args = budget_namespace(budget="medium")

        apply_budget_defaults(args, ["--budget", "medium"])

        self.assertEqual(args.budget, "medium")
        self.assertIsNone(args.max_iterations)

    def test_single_max_iterations_disables_preset_budget(self):
        args = budget_namespace(max_iterations=8)

        apply_budget_defaults(args, ["--max-iterations", "8"])

        self.assertIsNone(args.budget)
        self.assertEqual(args.max_iterations, 8)

    def test_multiple_budget_controls_error_with_explanation(self):
        args = budget_namespace(budget="medium", max_iterations=8)

        with self.assertRaisesRegex(
            ValueError,
            "Budget options are mutually exclusive; choose at most one",
        ):
            apply_budget_defaults(args, ["--budget", "medium", "--max-iterations", "8"])

    def test_repeated_budget_control_errors(self):
        args = budget_namespace(budget="heavy")

        with self.assertRaisesRegex(ValueError, "--budget \\(2 times\\)"):
            apply_budget_defaults(args, ["--budget", "light", "--budget", "heavy"])

    def test_equals_form_counts_as_budget_control(self):
        args = budget_namespace(budget="medium", max_full_evals=2)

        with self.assertRaisesRegex(ValueError, "--budget"):
            apply_budget_defaults(args, ["--budget=medium", "--max-full-evals=2"])


if __name__ == "__main__":
    unittest.main()
