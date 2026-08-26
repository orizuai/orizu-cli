from __future__ import annotations

import argparse
import json
import os
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from orizu_gepa import cli
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


class CliLaunchTests(unittest.TestCase):
    def test_main_declares_the_resolved_prompt_runner_when_starting_the_run(self):
        """Mutant killed: delete runner_version_id from the start_run call."""
        start_requests: list[dict[str, object]] = []
        prompt_context = SimpleNamespace(
            provider_settings={"model": "openai/gpt-5.4"},
            runner_version_id="resolved-prompt-runner-version",
        )
        scorer_context = SimpleNamespace(
            provider_settings={"model": "openai/gpt-5.4-mini"},
            scorer_version_id="resolved-scorer-version",
        )

        class FakeClient:
            def fetch_exec_context(self, **_kwargs):
                return prompt_context, []

            def fetch_scorer_exec_context(self, **_kwargs):
                return scorer_context, []

            def start_run(self, **kwargs):
                start_requests.append(kwargs)
                return "run-1"

        result = SimpleNamespace(
            run_id="run-1",
            best_candidate_id="0",
            best_score=1.0,
            seed_score=1.0,
            promoted_prompt_version_id=None,
            budget=SimpleNamespace(to_payload=lambda: {}),
        )
        candidate_runner_dir = "/tmp/verified-candidate-runner"
        scorer_runner_dir = "/tmp/verified-scorer-runner"
        argv = [
            "orizu-gepa",
            "--project", "team/project",
            "--optimizer-version-id", "optimizer-version-1",
            "--candidate-version-id", "prompt-version-1",
            "--runner-version-id", "requested-prompt-runner-version",
            "--candidate-runner-dir", candidate_runner_dir,
            "--scorer-version-id", "scorer-version-1",
            "--scorer-runner-version-id", "scorer-runner-version-1",
            "--scorer-runner-dir", scorer_runner_dir,
            "--dataset-version-id", "dataset-version-1",
            "--split-set-id", "split-set-1",
            "--no-local-log",
        ]

        with (
            patch.object(sys, "argv", argv),
            patch.dict(os.environ, {
                "ORIZU_VERIFIED_RUNNER_DIRS": json.dumps([
                    candidate_runner_dir,
                    scorer_runner_dir,
                ]),
            }),
            patch.object(cli.OrizuClient, "from_env", return_value=FakeClient()),
            patch.object(cli, "resolve_scorer_input_contract", return_value=("gepa", "model_output")),
            patch.object(cli, "make_candidate_runner", return_value=object()),
            patch.object(cli, "make_scorer_runner", return_value=object()),
            patch.object(cli, "optimize_loaded_text_candidate", return_value=result),
        ):
            cli.main()

        self.assertEqual(
            start_requests[0].get("runner_version_id"),
            "resolved-prompt-runner-version",
        )


if __name__ == "__main__":
    unittest.main()
