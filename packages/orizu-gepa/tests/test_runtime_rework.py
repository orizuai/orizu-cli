"""Production-path contracts added by the ALI-1501 adversarial rework."""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import MagicMock, patch

from gepa.core.adapter import EvaluationBatch
from orizu_gepa.local_log import LocalOptimizationLogger
from orizu_gepa.optimizer import DatasetRow, PromptContext, TextGepaConfig
from orizu_gepa_connector.engine import SeedValidationRefused, run_official_gepa
from orizu_gepa_connector.runtime import (
    MandatoryEventSink,
    build_config_from_environment,
    create_local_logger_from_environment,
    resolved_budget,
    selected_budget,
    validate_launch_contract,
    write_preflight_refusal_record,
)


class _FlakyClient:
    def __init__(self, failures: int = 0, update_failures: int = 0) -> None:
        self.failures = failures
        self.update_failures = update_failures
        self.calls = 0
        self.update_calls = 0
        self.updated = []

    def log_event(self, _run_id, **_event):
        self.calls += 1
        if self.calls <= self.failures:
            raise RuntimeError("temporary API failure")

    def update_run(self, *args, **kwargs):
        self.update_calls += 1
        self.updated.append((args, kwargs))
        if self.update_calls <= self.update_failures:
            raise RuntimeError("temporary PATCH failure")


class RuntimeReworkContracts(unittest.TestCase):
    def test_production_sink_reuses_three_attempt_transport_retry_before_failing(self):
        """Kills a mandatory sink that marks a run failed after one transient POST."""
        with tempfile.TemporaryDirectory() as root:
            client = _FlakyClient(failures=2)
            sink = MandatoryEventSink(client, "run", LocalOptimizationLogger.create(root, "run"))
            with patch("orizu_gepa.client.time.sleep") as sleep:
                sink.emit("run_started", {})
        self.assertFalse(sink.failed)
        self.assertEqual(client.calls, 3)
        self.assertEqual(sleep.call_count, 2)

    def test_failed_patch_gets_one_production_retry_on_the_next_opportunity(self):
        """Kills a sink that permanently loses the terminal failed status after an outage."""
        with tempfile.TemporaryDirectory() as root:
            client = _FlakyClient(failures=3, update_failures=1)
            sink = MandatoryEventSink(client, "run", LocalOptimizationLogger.create(root, "run"))
            with patch("orizu_gepa.client.time.sleep"):
                with self.assertRaisesRegex(RuntimeError, "temporary API failure"):
                    sink.emit("run_started", {})
            sink.retry_failed_status()
        self.assertEqual(len(client.updated), 2)
        self.assertEqual(client.updated[-1][1]["status"], "failed")

    def test_runtime_environment_selects_candidate_budget_and_reflection_settings(self):
        """Kills production env wiring that leaves callback progress unconfigured."""
        env = {
            "ORIZU_MAX_CANDIDATE_PROPOSALS": "4",
            "ORIZU_MINIBATCH_SIZE": "7",
            "ORIZU_NUM_THREADS": "3",
            "ORIZU_SEED": "9",
            "ORIZU_REFLECTION_MODEL": "openai/gpt-test",
            "ORIZU_REFLECTION_TEMPERATURE": "0.25",
            "ORIZU_REFLECTION_MAX_TOKENS": "123",
            "ORIZU_REFLECTION_RETRY_ATTEMPTS": "4",
            "ORIZU_REFLECTION_HTTP_TIMEOUT_SECONDS": "45",
            "ORIZU_REFLECTION_PROMPT_TEMPLATE": "custom <curr_param>",
            "ORIZU_REFLECTION_PROVIDER_SETTINGS": '{"top_p":0.8}',
            "ORIZU_EPSILON": "0.3",
            "ORIZU_CANDIDATE_SELECTION_STRATEGY": "epsilon_greedy",
            "ORIZU_OBJECTIVE": "minimize errors",
            "ORIZU_SKIP_PERFECT_PARENT_REFLECTION": "0",
            "ORIZU_LOG_ROW_SNAPSHOTS": "1",
        }
        with patch.dict(os.environ, env, clear=True):
            config = build_config_from_environment()
        self.assertEqual(config.max_candidate_proposals, 4)
        self.assertEqual(config.minibatch_size, 7)
        self.assertEqual(config.num_threads, 3)
        self.assertEqual(config.seed, 9)
        self.assertEqual(config.reflection_model, "openai/gpt-test")
        self.assertEqual(config.reflection_temperature, 0.25)
        self.assertEqual(config.reflection_max_tokens, 123)
        self.assertEqual(config.reflection_retry_attempts, 4)
        self.assertEqual(config.reflection_http_timeout_seconds, 45)
        self.assertEqual(config.reflection_prompt_template, "custom <curr_param>")
        self.assertEqual(config.reflection_provider_settings, {"top_p": 0.8})
        self.assertEqual(config.epsilon, 0.3)
        self.assertEqual(config.candidate_selection_strategy, "epsilon_greedy")
        self.assertEqual(config.objective, "minimize errors")
        self.assertFalse(config.skip_perfect_parent_reflection)
        self.assertTrue(config.log_row_snapshots)
        self.assertEqual(selected_budget(config, trainset_size=5, valset_size=2), ("max_candidate_proposals", 4))
        with patch.dict(os.environ, {
            "ORIZU_SKIP_PERFECT_PARENT_REFLECTION": "1",
            "ORIZU_REFLECTION_MAX_TOKENS": "1",
        }, clear=True):
            self.assertTrue(build_config_from_environment().skip_perfect_parent_reflection)
        with patch.dict(os.environ, {"ORIZU_SEED": "0", "ORIZU_REFLECTION_MAX_TOKENS": "1"}, clear=True):
            self.assertEqual(build_config_from_environment().seed, 0)
        with patch.dict(os.environ, {"ORIZU_SEED": "-7", "ORIZU_REFLECTION_MAX_TOKENS": "1"}, clear=True):
            self.assertEqual(build_config_from_environment().seed, -7)
        with patch.dict(os.environ, {"ORIZU_SEED": "not-an-integer", "ORIZU_REFLECTION_MAX_TOKENS": "1"}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "ORIZU_SEED must be an integer"):
                build_config_from_environment()
        with patch.dict(os.environ, {"ORIZU_REFLECTION_MODEL": "anthropic/claude-haiku-4-5"}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "--reflection-max-tokens"):
                build_config_from_environment()
        with patch.dict(os.environ, {"ORIZU_REFLECTION_MODEL": "openai/gpt-test"}, clear=True):
            self.assertIsNone(build_config_from_environment().reflection_max_tokens)

    def test_production_engine_forwards_legacy_selection_and_skip_configuration(self):
        """Kills an engine that parses legacy env settings but leaves GEPA defaults active."""
        config = TextGepaConfig(
            candidate_selection_strategy="epsilon_greedy",
            epsilon=0.3,
            seed=9,
            skip_perfect_parent_reflection=False,
            minibatch_size=7,
            cache_evaluations=False,
        )
        with patch("orizu_gepa_connector.engine.optimize") as optimize:
            run_official_gepa(
                seed_candidate={"prompt": "seed"}, trainset=[], valset=[], adapter=object(),
                callback=object(), hooks=type("Hooks", (), {"emit": lambda *_: None})(),
                max_metric_calls=4, seed_already_validated=True, config=config,
            )
        kwargs = optimize.call_args.kwargs
        selector = kwargs["candidate_selection_strategy"]
        self.assertEqual(selector.epsilon, 0.3)
        self.assertFalse(kwargs["skip_perfect_score"])
        self.assertEqual(kwargs["reflection_minibatch_size"], 7)
        self.assertFalse(kwargs["cache_evaluation"])
        self.assertEqual(kwargs["seed"], 9)

    def test_production_engine_kwargs_bind_against_the_real_gepa_signature(self):
        """Kills a MagicMock-only optimize contract that real GEPA rejects."""
        import inspect
        from gepa import optimize as real_optimize
        import orizu_gepa_connector.engine as engine

        with patch.object(engine, "optimize") as optimize:
            run_official_gepa(seed_candidate={"prompt": "seed"}, trainset=[], valset=[], adapter=object(),
                              callback=object(), hooks=type("Hooks", (), {"emit": lambda *_: None})(),
                              max_metric_calls=1, seed_already_validated=True)
        inspect.signature(real_optimize).bind(**optimize.call_args.kwargs)

    def test_no_local_log_skips_the_production_frozen_logger(self):
        """Kills a --no-local-log env path that still constructs local artifacts."""
        with patch.dict(os.environ, {"ORIZU_NO_LOCAL_LOG": "1"}, clear=True), \
             patch("orizu_gepa_connector.runtime.LocalOptimizationLogger.create") as create:
            logger = create_local_logger_from_environment(
                run_id="run", env={"ORIZU_PROJECT": "project"}, prompt_context=object(),
                scorer_context=object(), trainset=[], valset=[], metadata={},
            )
        self.assertIsNone(logger)
        create.assert_not_called()

    def test_runtime_rejects_merge_multi_component_and_pxn_before_start(self):
        """Kills launch guards that GEPA callback exceptions cannot enforce."""
        for env, seed, name in (
            ({"ORIZU_USE_MERGE": "1"}, {"prompt": "seed"}, "merge"),
            ({}, {"prompt": "seed", "other": "second"}, "multi-component"),
            ({"ORIZU_SAMPLING_STRATEGY": "pxn"}, {"prompt": "seed"}, "P×N"),
            ({"ORIZU_SELECTION_STRATEGY": "top_k"}, {"prompt": "seed"}, "P×N"),
        ):
            with self.subTest(name=name), patch.dict(os.environ, env, clear=True):
                with self.assertRaisesRegex(RuntimeError, name):
                    validate_launch_contract(seed)

    def test_verified_runner_directories_are_the_required_trust_boundary(self):
        """Kills an env entrypoint that accepts arbitrary local executables."""
        with patch.dict(os.environ, {"ORIZU_VERIFIED_RUNNER_DIRS": json.dumps(["candidate"])}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "scorer"):
                validate_launch_contract({"prompt": "seed"}, candidate_runner_dir="candidate", scorer_runner_dir="scorer")

    def test_default_budget_resolves_to_a_real_metric_spend_ceiling(self):
        """Kills a default run that publishes a preset but calls GEPA unbounded."""
        budget = resolved_budget(TextGepaConfig(), trainset_size=4, valset_size=2)
        self.assertEqual(budget.budget_kind, "max_metric_calls")
        self.assertGreater(budget.limit, 0)
        self.assertEqual(budget.approx_metric_call_limit, budget.limit)

    def test_runtime_passes_the_default_resolved_budget_to_the_real_engine_call(self):
        """Kills runtime wiring that leaves a no-maximum launch unbounded."""
        from orizu_gepa.optimizer import DatasetRow, PromptContext
        import orizu_gepa_connector.runtime as runtime

        env = {
            "ORIZU_PROJECT": "project", "ORIZU_OPTIMIZER_VERSION_ID": "optimizer",
            "ORIZU_PROMPT_VERSION_ID": "prompt", "ORIZU_DATASET_VERSION_ID": "dataset",
            "ORIZU_SPLIT_SET_ID": "split", "ORIZU_SCORER_VERSION_ID": "scorer",
            "ORIZU_RUNNER_VERSION_ID": "runner", "ORIZU_CANDIDATE_RUNNER_DIR": "candidate",
            "ORIZU_SCORER_RUNNER_DIR": "scorer-dir",
            "ORIZU_VERIFIED_RUNNER_DIRS": '["candidate", "scorer-dir"]',
            "ORIZU_REFLECTION_MAX_TOKENS": "1024",
        }
        context = PromptContext(body="real seed", body_kind="text", provider_settings={"model": "model"},
                                prompt_version_id="prompt", runner_version_id="runner", prompt_id="prompt-id")
        client = MagicMock()
        client.fetch_exec_context.side_effect = [(context, [DatasetRow(id="train", row={})]), (context, [DatasetRow(id="val", row={})])]
        client.fetch_scorer_exec_context.return_value = (context, [])
        client.start_run.return_value = "run"
        adapter = MagicMock()
        adapter.num_threads_plan.to_payload.return_value = {}
        result = MagicMock(best_idx=0, val_aggregate_scores=[1.0], total_metric_calls=1, candidates=[{"prompt": "real seed"}])
        with patch.dict(os.environ, env, clear=True), \
             patch.object(runtime.OrizuClient, "from_env", return_value=client), \
             patch.object(runtime, "resolve_scorer_input_contract", return_value=("flat_row", "model_output")), \
             patch.object(runtime, "validate_seed_before_run"), \
             patch.object(runtime, "RunnerEvaluationAdapter", side_effect=[adapter, adapter]), \
             patch.object(runtime, "create_local_logger_from_environment", return_value=None), \
             patch.object(runtime, "MandatoryEventSink", return_value=MagicMock(failed=False)), \
             patch.object(runtime, "run_official_gepa", return_value=result) as engine:
            runtime.run_from_environment()
        self.assertGreater(engine.call_args.kwargs["max_metric_calls"], 0)
        self.assertEqual(engine.call_args.kwargs["seed_candidate"], {"prompt": "real seed"})
        self.assertEqual(client.start_run.call_args.kwargs["metadata"]["inference_lm"], "model")
        self.assertEqual(client.start_run.call_args.kwargs["metadata"]["scorer_lm"], "model")
        # A completed-but-unpromoted run must leave the result prompt column
        # null; the dashboard treats a non-null value as a real promotion.
        self.assertIsNone(client.update_run.call_args.kwargs["result_prompt_version_id"])

    def test_runtime_writes_direction_correct_result_after_promotion(self):
        """Kills result artifacts written before score inversion or promotion completes."""
        from types import SimpleNamespace
        import orizu_gepa_connector.runtime as runtime

        with tempfile.TemporaryDirectory() as root:
            env = {
                "ORIZU_PROJECT": "project", "ORIZU_OPTIMIZER_VERSION_ID": "optimizer",
                "ORIZU_PROMPT_VERSION_ID": "prompt", "ORIZU_DATASET_VERSION_ID": "dataset",
                "ORIZU_SPLIT_SET_ID": "split", "ORIZU_SCORER_VERSION_ID": "scorer",
                "ORIZU_RUNNER_VERSION_ID": "runner", "ORIZU_CANDIDATE_RUNNER_DIR": "candidate",
                "ORIZU_SCORER_RUNNER_DIR": "scorer-dir", "ORIZU_VERIFIED_RUNNER_DIRS": '["candidate", "scorer-dir"]',
                "ORIZU_REFLECTION_MAX_TOKENS": "1024", "ORIZU_AUTO_PROMOTE": "1",
                "ORIZU_MAX_ITERATIONS": "2",
            }
            prompt = PromptContext(body="seed", body_kind="text", provider_settings={}, prompt_version_id="prompt", runner_version_id="runner", prompt_id="prompt-id")
            scorer = PromptContext(body="score", body_kind="text", provider_settings={}, prompt_version_id="scorer", runner_version_id="runner", higher_is_better=False)
            client = MagicMock()
            client.fetch_exec_context.side_effect = [(prompt, [DatasetRow(id="train", row={})]), (prompt, [DatasetRow(id="val", row={})])]
            client.fetch_scorer_exec_context.return_value = (scorer, [])
            client.start_run.return_value = "run"
            adapter = MagicMock(); adapter.num_threads_plan.to_payload.return_value = {}
            sink = MagicMock(failed=False); sink.promote_candidate.return_value = "promoted-prompt"
            logger = LocalOptimizationLogger.create(root, "run")
            result = SimpleNamespace(
                best_idx=1, val_aggregate_scores=[0.8, 0.2], total_metric_calls=4,
                candidates=[{"prompt": "seed"}, {"prompt": "child"}],
                num_full_val_evals=1,
            )
            reflection_lm = SimpleNamespace(total_cost=0.0, total_tokens_in=4, total_tokens_out=2)

            def two_iteration_engine(**kwargs):
                """Recorded official-GEPA callback/result shape: two proposals, one full eval."""
                callback = kwargs["callback"]
                for iteration in (1, 2):
                    callback.on_iteration_start({"iteration": iteration})
                    callback.on_proposal_end({
                        "iteration": iteration,
                        "new_instructions": {"prompt": f"child-{iteration}"},
                        "prompts": {"prompt": "reflection prompt"},
                        "raw_lm_outputs": {"prompt": "reflection response"},
                    })
                    callback.on_candidate_rejected({
                        "iteration": iteration,
                        "old_score": 0.2,
                        "new_score": 0.1,
                        "reason": "known two-iteration fixture",
                    })
                    callback.on_iteration_end({"iteration": iteration, "proposal_accepted": False})
                return result

            stdout = StringIO()
            with redirect_stdout(stdout), \
                 patch.dict(os.environ, env, clear=True), \
                 patch.object(runtime.OrizuClient, "from_env", return_value=client), \
                 patch.object(runtime, "resolve_scorer_input_contract", return_value=("gepa", None)), \
                 patch.object(runtime, "validate_seed_before_run", return_value={"preflight_metric_calls": 3}), \
                 patch.object(runtime, "RunnerEvaluationAdapter", side_effect=[adapter, adapter]), \
                 patch.object(runtime, "create_local_logger_from_environment", return_value=logger), \
                 patch.object(runtime, "MandatoryEventSink", return_value=sink), \
                 patch.object(runtime, "make_gepa_reflection_lm", return_value=reflection_lm), \
                 patch.object(runtime, "run_official_gepa", side_effect=two_iteration_engine):
                returned_summary = runtime.run_from_environment()
            artifact = json.loads((Path(root) / "run" / "result.json").read_text())

        self.assertAlmostEqual(artifact["best_score"], 0.8)
        self.assertAlmostEqual(artifact["seed_score"], 0.2)
        self.assertEqual(artifact["promoted_prompt_version_id"], "promoted-prompt")
        # Runtime owns lifecycle output only. The connector entry point prints
        # the one final machine-readable summary after this return value.
        stdout_lines = stdout.getvalue().splitlines()
        self.assertIn(f"[orizu-gepa] local log: {Path(root) / 'run'}", stdout_lines)
        self.assertEqual(len([line for line in stdout_lines if line.startswith('{')]), 1)
        summary = returned_summary
        self.assertEqual({key: value for key, value in summary.items() if key not in {"best_score", "seed_score", "budget"}}, {
            "optimization_run_id": "run",
            "best_candidate_id": "1",
            "promoted_prompt_version_id": "promoted-prompt",
            "local_log_dir": str(Path(root) / "run"),
        })
        self.assertAlmostEqual(summary["best_score"], 0.8)
        self.assertAlmostEqual(summary["seed_score"], 0.2)
        self.assertEqual(summary["budget"], artifact["budget"])
        self.assertEqual(artifact["budget"], {
            "budget_kind": "max_iterations",
            "limit": 2,
            "used": 2,
            "remaining": 0,
            "approx_metric_call_limit": None,
            "metric_call_budget": None,
            "metric_calls_remaining": 0,
            "metric_budget_used": 7,
            "used_metric_calls": 7,
            "used_reflection_failure_metric_charges": 0,
            "used_iterations": 2,
            "used_candidate_proposals": 2,
            "used_full_evals": 1,
            "iteration_budget": 2,
            "iterations_remaining": 0,
        })

    def test_connector_entrypoint_prints_the_final_summary_once(self):
        """Kills duplicate final JSON records from runtime and the module entry point."""
        import orizu_gepa_connector.cli as connector_cli

        summary = {"optimization_run_id": "run", "best_candidate_id": "1"}
        stdout = StringIO()
        def completed_run():
            print("[orizu-gepa] 001 run_started")
            return summary

        with redirect_stdout(stdout), patch.object(connector_cli, "run_from_environment", side_effect=completed_run):
            connector_cli.main()

        lines = stdout.getvalue().splitlines()
        self.assertEqual(lines[-1], json.dumps(summary))
        self.assertEqual(len([line for line in lines if line.startswith("{")]), 1)

    def test_budget_exhaustion_pauses_and_never_auto_promotes(self):
        """Kills a budget stop reported as success, which could promote an unfinished prompt."""
        from types import SimpleNamespace
        import orizu_gepa_connector.runtime as runtime

        env = {
            "ORIZU_PROJECT": "project", "ORIZU_OPTIMIZER_VERSION_ID": "optimizer",
            "ORIZU_PROMPT_VERSION_ID": "prompt", "ORIZU_DATASET_VERSION_ID": "dataset",
            "ORIZU_SPLIT_SET_ID": "split", "ORIZU_SCORER_VERSION_ID": "scorer",
            "ORIZU_RUNNER_VERSION_ID": "runner", "ORIZU_CANDIDATE_RUNNER_DIR": "candidate",
            "ORIZU_SCORER_RUNNER_DIR": "scorer-dir", "ORIZU_VERIFIED_RUNNER_DIRS": '["candidate", "scorer-dir"]',
            "ORIZU_REFLECTION_MAX_TOKENS": "1024", "ORIZU_AUTO_PROMOTE": "1",
            "ORIZU_MAX_METRIC_CALLS": "3",
        }
        prompt = PromptContext(body="seed", body_kind="text", provider_settings={}, prompt_version_id="prompt", runner_version_id="runner", prompt_id="prompt-id")
        client = MagicMock()
        client.fetch_exec_context.side_effect = [(prompt, [DatasetRow(id="train", row={})]), (prompt, [DatasetRow(id="val", row={})])]
        client.fetch_scorer_exec_context.return_value = (prompt, [])
        client.start_run.return_value = "run"
        adapter = MagicMock(); adapter.num_threads_plan.to_payload.return_value = {}
        sink = MagicMock(failed=False)
        sink.promote_candidate.return_value = "should-not-promote"
        result = SimpleNamespace(
            best_idx=1, val_aggregate_scores=[0.2, 0.9], total_metric_calls=3,
            candidates=[{"prompt": "seed"}, {"prompt": "child"}], num_full_val_evals=1,
        )

        def exhausted_engine(**kwargs):
            callback = kwargs["callback"]
            callback.on_iteration_start({"iteration": 1})
            callback.on_iteration_end({"iteration": 1, "proposal_accepted": False})
            callback.on_optimization_end({"total_metric_calls": 3})
            return result

        with patch.dict(os.environ, env, clear=True), \
             patch.object(runtime.OrizuClient, "from_env", return_value=client), \
             patch.object(runtime, "resolve_scorer_input_contract", return_value=("gepa", None)), \
             patch.object(runtime, "validate_seed_before_run", return_value={"preflight_metric_calls": 0}), \
             patch.object(runtime, "RunnerEvaluationAdapter", side_effect=[adapter, adapter]), \
             patch.object(runtime, "create_local_logger_from_environment", return_value=None), \
             patch.object(runtime, "MandatoryEventSink", return_value=sink), \
             patch.object(runtime, "make_gepa_reflection_lm", return_value=MagicMock()), \
             patch.object(runtime, "run_official_gepa", side_effect=exhausted_engine):
            runtime.run_from_environment()

        sink.promote_candidate.assert_not_called()
        event_names = [call.args[0] for call in sink.emit.call_args_list]
        self.assertIn("budget_exhausted", event_names)
        self.assertIn("run_paused", event_names)
        self.assertNotIn("run_completed", event_names)
        sink.emit.assert_any_call(
            "run_paused",
            unittest.mock.ANY,
            iteration=None,
            candidate_id="1",
            parent_candidate_id=None,
        )
        self.assertEqual(client.update_run.call_args.kwargs["status"], "paused")
        self.assertEqual(client.update_run.call_args.kwargs["metadata"]["pause_reason"], "budget_exhausted")

    def test_max_full_evals_uses_legacy_metric_budget_without_a_second_full_eval_stopper(self):
        """Kills a connector-only full-eval stopper that ends a one-eval budget at seed validation."""
        from types import SimpleNamespace
        import orizu_gepa_connector.runtime as runtime

        env = {
            "ORIZU_PROJECT": "project", "ORIZU_OPTIMIZER_VERSION_ID": "optimizer",
            "ORIZU_PROMPT_VERSION_ID": "prompt", "ORIZU_DATASET_VERSION_ID": "dataset",
            "ORIZU_SPLIT_SET_ID": "split", "ORIZU_SCORER_VERSION_ID": "scorer",
            "ORIZU_RUNNER_VERSION_ID": "runner", "ORIZU_CANDIDATE_RUNNER_DIR": "candidate",
            "ORIZU_SCORER_RUNNER_DIR": "scorer-dir", "ORIZU_VERIFIED_RUNNER_DIRS": '["candidate", "scorer-dir"]',
            "ORIZU_REFLECTION_MAX_TOKENS": "1024", "ORIZU_MAX_FULL_EVALS": "1",
        }
        prompt = PromptContext(body="seed", body_kind="text", provider_settings={}, prompt_version_id="prompt", runner_version_id="runner")
        client = MagicMock()
        client.fetch_exec_context.side_effect = [(prompt, [DatasetRow(id="train", row={})]), (prompt, [DatasetRow(id="val", row={})])]
        client.fetch_scorer_exec_context.return_value = (prompt, [])
        client.start_run.return_value = "run"
        adapter = MagicMock(); adapter.num_threads_plan.to_payload.return_value = {}
        result = SimpleNamespace(best_idx=0, val_aggregate_scores=[0.5], total_metric_calls=1,
                                 candidates=[{"prompt": "seed"}], num_full_val_evals=1)

        with patch.dict(os.environ, env, clear=True), \
             patch.object(runtime.OrizuClient, "from_env", return_value=client), \
             patch.object(runtime, "resolve_scorer_input_contract", return_value=("gepa", None)), \
             patch.object(runtime, "validate_seed_before_run", return_value={"preflight_metric_calls": 0}), \
             patch.object(runtime, "RunnerEvaluationAdapter", side_effect=[adapter, adapter]), \
             patch.object(runtime, "create_local_logger_from_environment", return_value=None), \
             patch.object(runtime, "MandatoryEventSink", return_value=MagicMock(failed=False)), \
             patch.object(runtime, "make_gepa_reflection_lm", return_value=MagicMock()), \
             patch.object(runtime, "run_official_gepa", return_value=result) as engine:
            runtime.run_from_environment()

        self.assertEqual(engine.call_args.kwargs["max_metric_calls"], 2)
        self.assertEqual(
            [type(stopper).__name__ for stopper in engine.call_args.kwargs["stop_callbacks"]],
            ["MandatoryLoggingStopper"],
        )

    def test_preflight_refusal_writes_a_durable_record_before_a_run_exists(self):
        """Kills a pre-start seed refusal that cannot be adjudicated from local artifacts."""
        import orizu_gepa_connector.runtime as runtime

        with tempfile.TemporaryDirectory() as root:
            env = {
                "ORIZU_PROJECT": "project", "ORIZU_OPTIMIZER_VERSION_ID": "optimizer",
                "ORIZU_PROMPT_VERSION_ID": "prompt", "ORIZU_DATASET_VERSION_ID": "dataset",
                "ORIZU_SPLIT_SET_ID": "split", "ORIZU_SCORER_VERSION_ID": "scorer",
                "ORIZU_RUNNER_VERSION_ID": "runner", "ORIZU_CANDIDATE_RUNNER_DIR": "candidate",
                "ORIZU_SCORER_RUNNER_DIR": "scorer-dir",
                "ORIZU_VERIFIED_RUNNER_DIRS": '["candidate", "scorer-dir"]',
                "ORIZU_REFLECTION_MAX_TOKENS": "1024", "ORIZU_LOCAL_LOG_DIR": root,
            }
            context = PromptContext(body="seed", body_kind="text", provider_settings={}, prompt_version_id="prompt", runner_version_id="runner")
            client = MagicMock()
            client.fetch_exec_context.side_effect = [
                (context, [DatasetRow(id="train", row={})]),
                (context, [DatasetRow(id="refusal-row", row={})]),
            ]
            client.fetch_scorer_exec_context.return_value = (context, [])
            preflight_adapter = MagicMock()
            preflight_adapter.metric_calls_used = 1
            preflight_adapter.evaluate.return_value = EvaluationBatch(
                outputs=[{
                    "row_id": "refusal-row",
                    "scorer_output": {"score": 0, "reasoning": "bad seed"},
                    "scorer_error": None,
                }],
                scores=[0.0], trajectories=[], num_metric_calls=1,
            )
            with patch.dict(os.environ, env, clear=True), \
                 patch.object(runtime.OrizuClient, "from_env", return_value=client), \
                 patch.object(runtime, "resolve_scorer_input_contract", return_value=("gepa", None)), \
                 patch.object(runtime, "RunnerEvaluationAdapter", return_value=preflight_adapter):
                with self.assertRaisesRegex(SeedValidationRefused, "refusal-row.*bad seed") as raised:
                    runtime.run_from_environment()

            records = list(Path(root).glob("preflight-refused-*/preflight.json"))
            self.assertEqual(len(records), 1)
            record = json.loads(records[0].read_text())
            self.assertEqual(record["verdict"]["row_evidence"], [{
                "row_id": "refusal-row",
                "score": 0.0,
                "error_class": None,
            }])
            client.start_run.assert_not_called()

    def test_no_local_log_skips_the_preflight_refusal_file(self):
        """Kills a refusal writer that bypasses legacy --no-local-log semantics."""
        verdict = {"allowed": False, "reason": "degenerate_seed", "row_evidence": []}
        with patch.dict(os.environ, {"ORIZU_NO_LOCAL_LOG": "1"}, clear=True), \
             patch("orizu_gepa_connector.runtime.LocalOptimizationLogger.create") as create:
            path = write_preflight_refusal_record(env={"ORIZU_PROJECT": "project"}, verdict=verdict)
        self.assertIsNone(path)
        create.assert_not_called()

    def test_runtime_post_engine_check_blocks_success_after_a_swallowed_logging_failure(self):
        """Kills deletion of runtime's real post-engine durable-logging check."""
        from orizu_gepa.optimizer import DatasetRow, PromptContext
        import orizu_gepa_connector.runtime as runtime

        env = {
            "ORIZU_PROJECT": "project", "ORIZU_OPTIMIZER_VERSION_ID": "optimizer", "ORIZU_PROMPT_VERSION_ID": "prompt",
            "ORIZU_DATASET_VERSION_ID": "dataset", "ORIZU_SPLIT_SET_ID": "split", "ORIZU_SCORER_VERSION_ID": "scorer",
            "ORIZU_RUNNER_VERSION_ID": "runner", "ORIZU_CANDIDATE_RUNNER_DIR": "candidate", "ORIZU_SCORER_RUNNER_DIR": "scorer-dir",
            "ORIZU_VERIFIED_RUNNER_DIRS": '["candidate", "scorer-dir"]',
            "ORIZU_REFLECTION_MAX_TOKENS": "1024",
        }
        context = PromptContext(body="seed", body_kind="text", provider_settings={}, prompt_version_id="prompt", runner_version_id="runner")
        client = MagicMock()
        client.fetch_exec_context.side_effect = [(context, [DatasetRow(id="train", row={})]), (context, [DatasetRow(id="val", row={})])]
        client.fetch_scorer_exec_context.return_value = (context, [])
        client.start_run.return_value = "run"
        adapter = MagicMock(); adapter.num_threads_plan.to_payload.return_value = {}
        result = MagicMock(best_idx=0, val_aggregate_scores=[1.0], total_metric_calls=1, candidates=[{"prompt": "seed"}])
        sink = MagicMock(failed=True)
        with patch.dict(os.environ, env, clear=True), \
             patch.object(runtime.OrizuClient, "from_env", return_value=client), \
             patch.object(runtime, "resolve_scorer_input_contract", return_value=("flat_row", "model_output")), \
             patch.object(runtime, "validate_seed_before_run"), \
             patch.object(runtime, "RunnerEvaluationAdapter", side_effect=[adapter, adapter]), \
             patch.object(runtime, "create_local_logger_from_environment", return_value=None), \
             patch.object(runtime, "MandatoryEventSink", return_value=sink), \
             patch.object(runtime, "run_official_gepa", return_value=result):
            with self.assertRaisesRegex(RuntimeError, "mandatory event logging failed"):
                runtime.run_from_environment()
        sink.retry_failed_status.assert_called_once()
        client.update_run.assert_not_called()

    def test_explicit_gepa_candidate_field_is_a_named_pre_start_scorer_refusal(self):
        """Kills an actionable legacy contract refusal replaced by a launch crash."""
        from orizu_gepa.optimizer import DatasetRow, PromptContext
        import orizu_gepa_connector.runtime as runtime

        env = {
            "ORIZU_PROJECT": "project", "ORIZU_OPTIMIZER_VERSION_ID": "optimizer", "ORIZU_PROMPT_VERSION_ID": "prompt",
            "ORIZU_DATASET_VERSION_ID": "dataset", "ORIZU_SPLIT_SET_ID": "split", "ORIZU_SCORER_VERSION_ID": "scorer",
            "ORIZU_RUNNER_VERSION_ID": "runner", "ORIZU_CANDIDATE_RUNNER_DIR": "candidate", "ORIZU_SCORER_RUNNER_DIR": "scorer-dir",
            "ORIZU_SCORER_CANDIDATE_FIELD": "draft_text",
            "ORIZU_REFLECTION_MAX_TOKENS": "1024",
        }
        context = PromptContext(body="seed", body_kind="text", provider_settings={}, prompt_version_id="prompt", runner_version_id="runner")
        client = MagicMock()
        client.fetch_exec_context.side_effect = [(context, [DatasetRow(id="train", row={})]), (context, [DatasetRow(id="val", row={})])]
        client.fetch_scorer_exec_context.return_value = (context, [])
        with patch.dict(os.environ, env, clear=True), \
             patch.object(runtime.OrizuClient, "from_env", return_value=client), \
             patch.object(runtime, "resolve_scorer_input_contract", side_effect=RuntimeError("active scorer input contract is 'gepa'")):
            with self.assertRaisesRegex(RuntimeError, "scorer-contract failure before launch"):
                runtime.run_from_environment()
        client.start_run.assert_not_called()
