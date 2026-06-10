from __future__ import annotations

import contextlib
import io
import json
import tempfile
import time
import urllib.error
import unittest
from pathlib import Path
from unittest import mock

from orizu_gepa.client import OrizuClient, OrizuEventSink
from orizu_gepa.local_log import LocalOptimizationLogger
from orizu_gepa.optimizer import (
    Budget,
    DatasetRow,
    EvaluationCache,
    PromptContext,
    ReflectionResult,
    RetryableReflectionError,
    RowEvaluation,
    RunnerCallResult,
    TextGepaConfig,
    build_reflection_prompt,
    extract_candidate_text,
    optimize_loaded_text_candidate,
    _dspy_auto_metric_budget,
    _pareto_payload,
    _parent_selection_payload,
    _sample_minibatch,
    _score_from_scorer,
    _select_parent_candidate_id,
    resolve_num_threads,
)
from orizu_gepa.reflection import (
    build_anthropic_reflection_payload,
    build_openai_reflection_payload,
    reflect_with_anthropic,
)


class FakeSink:
    def __init__(self):
        self.events = []
        self.finished = None
        self.promotions = []

    def log_event(self, event_type, payload=None, **kwargs):
        self.events.append({"event_type": event_type, "payload": payload or {}, **kwargs})

    def promote_candidate(self, **kwargs):
        self.promotions.append(kwargs)
        return "promoted-version-1"

    def finish_run(self, **kwargs):
        self.finished = kwargs


class OptimizerTests(unittest.TestCase):
    def setUp(self):
        self.prompt = PromptContext(
            body="initial text",
            body_kind="text",
            provider_settings={"model": "anthropic/claude-haiku-4"},
            prompt_version_id="prompt-version-1",
            runner_version_id="runner-version-1",
            prompt_id="prompt-1",
        )
        self.scorer = PromptContext(
            body="score it",
            body_kind="text",
            provider_settings={"model": "anthropic/claude-haiku-4"},
            prompt_version_id="scorer-prompt-version-1",
            runner_version_id="scorer-runner-version-1",
            prompt_id="scorer-1",
            scorer_version_id="scorer-version-1",
            metric_key="accuracy",
            higher_is_better=True,
        )
        self.trainset = [
            DatasetRow("train-1", {"expected": "improved"}),
            DatasetRow("train-2", {"expected": "improved"}),
        ]
        self.valset = [
            DatasetRow("val-1", {"expected": "improved"}),
            DatasetRow("val-2", {"expected": "improved"}),
        ]

    def test_logs_required_gepa_lifecycle_and_promotes_best_child(self):
        sink = FakeSink()

        def candidate_runner(candidate_text, row, prompt_context, candidate_id):
            return RunnerCallResult(model_response={"answer": candidate_text})

        def scorer_runner(row, candidate_result, scorer_context, candidate_id):
            score = 1.0 if candidate_result.model_response["answer"] == row.row["expected"] else 0.2
            return RunnerCallResult(model_response={"score": score, "feedback": f"score={score}"})

        def reflector(parent_text, parent_results, config):
            return ReflectionResult(
                prompt="reflection prompt",
                response="improved",
                candidate_text="improved",
            )

        result = optimize_loaded_text_candidate(
            run_id="run-1",
            prompt_context=self.prompt,
            scorer_context=self.scorer,
            trainset=self.trainset,
            valset=self.valset,
            candidate_runner=candidate_runner,
            scorer_runner=scorer_runner,
            reflector=reflector,
            event_sink=sink,
            config=TextGepaConfig(max_iterations=1, minibatch_size=2, auto_promote=True, log_row_snapshots=True),
        )

        self.assertEqual(result.budget.budget_kind, "max_iterations")
        self.assertEqual(result.budget.used_iterations, 1)
        event_types = [event["event_type"] for event in sink.events]
        run_started = next(event for event in sink.events if event["event_type"] == "run_started")
        self.assertEqual(run_started["payload"]["inference_lm"], "anthropic/claude-haiku-4")
        self.assertEqual(run_started["payload"]["scorer_lm"], "anthropic/claude-haiku-4")
        self.assertEqual(run_started["payload"]["reflection_lm"], TextGepaConfig.reflection_model)
        self.assertEqual(run_started["payload"]["scorer_version_id"], "scorer-version-1")
        self.assertEqual(run_started["payload"]["scorer_prompt_version_id"], "scorer-prompt-version-1")
        self.assertEqual(run_started["payload"]["metric_key"], "accuracy")
        self.assertTrue(run_started["payload"]["higher_is_better"])
        self.assertEqual(run_started["payload"]["config"]["num_threads"], "auto")
        self.assertGreaterEqual(run_started["payload"]["num_threads"]["resolved"], 1)
        self.assertIn("seed_val_set_completed", event_types)
        self.assertIn("iteration_started", event_types)
        self.assertIn("parent_minibatch_completed", event_types)
        self.assertIn("reflection_completed", event_types)
        self.assertIn("child_minibatch_completed", event_types)
        self.assertIn("acceptance_decision_made", event_types)
        self.assertIn("child_val_set_completed", event_types)
        self.assertIn("pareto_front_updated", event_types)
        self.assertIn("budget_updated", event_types)
        self.assertIn("run_completed", event_types)
        decision = next(event for event in sink.events if event["event_type"] == "acceptance_decision_made")
        self.assertTrue(decision["payload"]["proceed_to_full_eval"])
        reflection = next(event for event in sink.events if event["event_type"] == "reflection_completed")
        self.assertEqual(reflection["payload"]["prompt"], "reflection prompt")
        self.assertEqual(reflection["payload"]["response"], "improved")
        child_val = next(event for event in sink.events if event["event_type"] == "child_val_set_completed")
        self.assertEqual(child_val["payload"]["score_mean"], 1.0)
        self.assertEqual(child_val["payload"]["metric_key"], "accuracy")
        self.assertEqual(len(child_val["payload"]["row_results"]), 2)
        pareto = [event for event in sink.events if event["event_type"] == "pareto_front_updated"][-1]
        self.assertEqual(pareto["payload"]["best_candidate_id"], result.best_candidate_id)
        self.assertEqual(result.best_score, 1.0)
        self.assertEqual(result.promoted_prompt_version_id, "promoted-version-1")
        self.assertEqual(sink.finished["status"], "succeeded")

    def test_logs_iteration_progress_with_capped_percent_and_metric_budget_left(self):
        sink = FakeSink()

        def candidate_runner(candidate_text, row, prompt_context, candidate_id):
            return RunnerCallResult(model_response={"answer": candidate_text})

        def scorer_runner(row, candidate_result, scorer_context, candidate_id):
            score = 1.0 if candidate_result.model_response["answer"] == "new" else 0.0
            return RunnerCallResult(model_response={"score": score, "feedback": f"score={score}"})

        def reflector(parent_text, parent_results, config):
            return ReflectionResult(
                prompt="reflection prompt",
                response="new",
                candidate_text="new",
            )

        optimize_loaded_text_candidate(
            run_id="run-1",
            prompt_context=self.prompt,
            scorer_context=self.scorer,
            trainset=self.trainset,
            valset=self.valset,
            candidate_runner=candidate_runner,
            scorer_runner=scorer_runner,
            reflector=reflector,
            event_sink=sink,
            config=TextGepaConfig(max_iterations=1, minibatch_size=2, max_metric_calls=3),
        )

        event_types = [event["event_type"] for event in sink.events]
        progress_index = event_types.index("optimization_progress")
        self.assertGreater(progress_index, event_types.index("iteration_completed"))
        progress = sink.events[progress_index]["payload"]
        self.assertEqual(progress["stage"], "iteration_completed")
        self.assertEqual(progress["iteration"], 1)
        self.assertEqual(progress["percent"], 100.0)
        self.assertEqual(progress["metric_calls_used"], 8)
        self.assertEqual(progress["metric_call_budget"], 3)
        self.assertEqual(progress["metric_calls_remaining"], 0)
        self.assertTrue(progress["is_over_budget"])

    def test_marks_candidate_proposal_progress_complete_when_proposals_exhausted(self):
        sink = FakeSink()

        def candidate_runner(candidate_text, row, prompt_context, candidate_id):
            return RunnerCallResult(model_response={"answer": candidate_text})

        def scorer_runner(row, candidate_result, scorer_context, candidate_id):
            score = 1.0 if candidate_result.model_response["answer"] == "initial text" else 0.0
            return RunnerCallResult(model_response={"score": score, "feedback": f"score={score}"})

        def reflector(parent_text, parent_results, config):
            return ReflectionResult(
                prompt="reflection prompt",
                response="worse",
                candidate_text="worse",
            )

        optimize_loaded_text_candidate(
            run_id="run-1",
            prompt_context=self.prompt,
            scorer_context=self.scorer,
            trainset=self.trainset,
            valset=self.valset,
            candidate_runner=candidate_runner,
            scorer_runner=scorer_runner,
            reflector=reflector,
            event_sink=sink,
            config=TextGepaConfig(
                max_iterations=2,
                minibatch_size=2,
                max_candidate_proposals=1,
                skip_perfect_parent_reflection=False,
            ),
        )

        progress = next(event for event in sink.events if event["event_type"] == "optimization_progress")["payload"]
        self.assertEqual(progress["percent"], 100.0)
        self.assertEqual(progress["metric_calls_used"], 6)
        self.assertEqual(progress["metric_call_budget"], 8)
        self.assertEqual(progress["metric_calls_remaining"], 0)
        self.assertFalse(progress["is_over_budget"])
        self.assertEqual(progress["budget"]["used_candidate_proposals"], 1)
        self.assertEqual(progress["budget"]["remaining"], 0)
        self.assertEqual(progress["budget"]["metric_calls_remaining"], 0)

    def test_retryable_reflection_failure_logs_and_continues_to_next_iteration(self):
        sink = FakeSink()
        reflector_calls = 0

        def candidate_runner(candidate_text, row, prompt_context, candidate_id):
            return RunnerCallResult(model_response={"answer": candidate_text})

        def scorer_runner(row, candidate_result, scorer_context, candidate_id):
            score = 1.0 if candidate_result.model_response["answer"] == "improved" else 0.2
            return RunnerCallResult(model_response={"score": score, "feedback": f"score={score}"})

        def reflector(parent_text, parent_results, config):
            nonlocal reflector_calls
            reflector_calls += 1
            if reflector_calls == 1:
                raise RetryableReflectionError("transient Anthropic timeout")
            return ReflectionResult(
                prompt="reflection prompt",
                response="improved",
                candidate_text="improved",
            )

        result = optimize_loaded_text_candidate(
            run_id="run-1",
            prompt_context=self.prompt,
            scorer_context=self.scorer,
            trainset=self.trainset,
            valset=self.valset,
            candidate_runner=candidate_runner,
            scorer_runner=scorer_runner,
            reflector=reflector,
            event_sink=sink,
            config=TextGepaConfig(max_iterations=2, minibatch_size=2),
        )

        event_types = [event["event_type"] for event in sink.events]
        self.assertEqual(reflector_calls, 2)
        self.assertIn("reflection_failed", event_types)
        self.assertIn("reflection_completed", event_types)
        self.assertLess(event_types.index("reflection_failed"), event_types.index("reflection_completed"))
        self.assertEqual(result.best_score, 1.0)
        self.assertEqual(result.budget.used_candidate_proposals, 2)
        self.assertEqual(result.budget.used_iterations, 2)
        failed = next(event for event in sink.events if event["event_type"] == "reflection_failed")
        self.assertEqual(failed["payload"]["error_type"], "RetryableReflectionError")
        self.assertEqual(failed["payload"]["parent_candidate_id"], "seed")
        self.assertEqual(failed["payload"]["budget"]["used_iterations"], 1)
        failed_iteration = next(
            event
            for event in sink.events
            if event["event_type"] == "iteration_completed" and event["iteration"] == 1
        )
        self.assertTrue(failed_iteration["payload"]["reflection_failed"])
        self.assertIsNone(failed_iteration["payload"]["child_candidate_id"])
        completed = next(event for event in sink.events if event["event_type"] == "run_completed")
        self.assertEqual(completed["payload"]["failed_reflection_count"], 1)

    def test_retryable_reflection_failure_charges_max_iteration_budget(self):
        sink = FakeSink()
        reflector_calls = 0

        def candidate_runner(candidate_text, row, prompt_context, candidate_id):
            return RunnerCallResult(model_response={"answer": candidate_text})

        def scorer_runner(row, candidate_result, scorer_context, candidate_id):
            return RunnerCallResult(model_response={"score": 0.2, "feedback": "score=0.2"})

        def reflector(parent_text, parent_results, config):
            nonlocal reflector_calls
            reflector_calls += 1
            raise RetryableReflectionError("transient Anthropic timeout")

        result = optimize_loaded_text_candidate(
            run_id="run-1",
            prompt_context=self.prompt,
            scorer_context=self.scorer,
            trainset=self.trainset,
            valset=self.valset,
            candidate_runner=candidate_runner,
            scorer_runner=scorer_runner,
            reflector=reflector,
            event_sink=sink,
            config=TextGepaConfig(max_iterations=1, minibatch_size=2),
        )

        event_types = [event["event_type"] for event in sink.events]
        self.assertEqual(reflector_calls, 1)
        self.assertEqual(result.budget.used_iterations, 1)
        self.assertEqual(result.budget.remaining, 0)
        self.assertIn("reflection_failed", event_types)
        self.assertNotIn("reflection_completed", event_types)
        failed_iteration = next(event for event in sink.events if event["event_type"] == "iteration_completed")
        self.assertEqual(failed_iteration["payload"]["budget"]["used_reflection_failure_metric_charges"], 0)
        self.assertEqual(failed_iteration["payload"]["budget"]["used_iterations"], 1)
        self.assertEqual(failed_iteration["payload"]["budget"]["remaining"], 0)

    def test_retryable_reflection_failure_charges_metric_budget(self):
        sink = FakeSink()
        reflector_calls = 0
        trainset = [DatasetRow("train-1", {"expected": "improved"})]
        valset = [DatasetRow("val-1", {"expected": "improved"})]

        def candidate_runner(candidate_text, row, prompt_context, candidate_id):
            return RunnerCallResult(model_response={"answer": candidate_text})

        def scorer_runner(row, candidate_result, scorer_context, candidate_id):
            return RunnerCallResult(model_response={"score": 0.2, "feedback": "score=0.2"})

        def reflector(parent_text, parent_results, config):
            nonlocal reflector_calls
            reflector_calls += 1
            if reflector_calls > 1:
                raise AssertionError("retryable reflection failure did not exhaust metric budget")
            raise RetryableReflectionError("transient Anthropic timeout")

        result = optimize_loaded_text_candidate(
            run_id="run-1",
            prompt_context=self.prompt,
            scorer_context=self.scorer,
            trainset=trainset,
            valset=valset,
            candidate_runner=candidate_runner,
            scorer_runner=scorer_runner,
            reflector=reflector,
            event_sink=sink,
            config=TextGepaConfig(max_metric_calls=3, minibatch_size=1),
        )

        event_types = [event["event_type"] for event in sink.events]
        self.assertEqual(reflector_calls, 1)
        self.assertEqual(result.budget.used_metric_calls, 2)
        self.assertEqual(result.budget.used_reflection_failure_metric_charges, 1)
        self.assertEqual(result.budget.metric_budget_used, 3)
        self.assertEqual(result.budget.remaining, 0)
        self.assertIn("reflection_failed", event_types)
        self.assertIn("budget_exhausted", event_types)
        self.assertIn("run_paused", event_types)
        failed = next(event for event in sink.events if event["event_type"] == "reflection_failed")
        self.assertEqual(failed["payload"]["budget"]["used_metric_calls"], 2)
        self.assertEqual(failed["payload"]["budget"]["used_reflection_failure_metric_charges"], 1)
        self.assertEqual(failed["payload"]["budget"]["metric_budget_used"], 3)
        self.assertEqual(failed["payload"]["budget"]["remaining"], 0)

    def test_redacts_row_snapshots_and_reflection_io_by_default(self):
        sink = FakeSink()
        trainset = [DatasetRow("train-1", {"secret": "customer-input", "expected": "improved"})]
        valset = [DatasetRow("val-1", {"secret": "validation-input", "expected": "initial text"})]

        def candidate_runner(candidate_text, row, prompt_context, candidate_id):
            return RunnerCallResult(model_response={"answer": candidate_text})

        def scorer_runner(row, candidate_result, scorer_context, candidate_id):
            score = 1.0 if candidate_result.model_response["answer"] == row.row["expected"] else 0.0
            return RunnerCallResult(model_response={"score": score, "feedback": f"secret={row.row['secret']}"})

        def reflector(parent_text, parent_results, config):
            return ReflectionResult(
                prompt="reflection prompt includes customer-input",
                response="improved because customer-input",
                candidate_text="improved",
            )

        optimize_loaded_text_candidate(
            run_id="run-1",
            prompt_context=self.prompt,
            scorer_context=self.scorer,
            trainset=trainset,
            valset=valset,
            candidate_runner=candidate_runner,
            scorer_runner=scorer_runner,
            reflector=reflector,
            event_sink=sink,
            config=TextGepaConfig(max_iterations=1, minibatch_size=1),
        )

        parent = next(event for event in sink.events if event["event_type"] == "parent_minibatch_completed")
        self.assertIsNone(parent["payload"]["row_results"][0]["row"])
        self.assertTrue(parent["payload"]["row_results"][0]["row_redacted"])
        self.assertIn("row_sha256", parent["payload"]["row_results"][0])

        reflection = next(event for event in sink.events if event["event_type"] == "reflection_completed")
        self.assertNotIn("prompt", reflection["payload"])
        self.assertTrue(reflection["payload"]["prompt_redacted"])
        self.assertIn("prompt_sha256", reflection["payload"])
        self.assertEqual(reflection["payload"]["response"], "improved because customer-input")

    def test_writes_full_local_optimization_logs_when_requested(self):
        sink = FakeSink()
        trainset = [DatasetRow("train-1", {"secret": "customer-input", "expected": "improved"})]
        valset = [DatasetRow("val-1", {"secret": "validation-input", "expected": "improved"})]

        def candidate_runner(candidate_text, row, prompt_context, candidate_id):
            return RunnerCallResult(model_response={"answer": candidate_text})

        def scorer_runner(row, candidate_result, scorer_context, candidate_id):
            score = 1.0 if candidate_result.model_response["answer"] == row.row["expected"] else 0.0
            return RunnerCallResult(model_response={"score": score, "feedback": f"secret={row.row['secret']}"})

        def reflector(parent_text, parent_results, config):
            return ReflectionResult(
                prompt="reflection prompt includes customer-input",
                response="improved because customer-input",
                candidate_text="improved",
            )

        with tempfile.TemporaryDirectory() as temp_dir:
            logger = LocalOptimizationLogger.create(temp_dir, "run-1")
            logger.write_context(
                project="core/evals",
                run_id="run-1",
                args={"max_iterations": 1},
                prompt_context=self.prompt,
                scorer_context=self.scorer,
                trainset=trainset,
                valset=valset,
                metadata={"mode": "text-candidate"},
            )

            result = optimize_loaded_text_candidate(
                run_id="run-1",
                prompt_context=self.prompt,
                scorer_context=self.scorer,
                trainset=trainset,
                valset=valset,
                candidate_runner=candidate_runner,
                scorer_runner=scorer_runner,
                reflector=reflector,
                event_sink=sink,
                config=TextGepaConfig(max_iterations=1, minibatch_size=1),
                local_logger=logger,
            )
            logger.write_result(result)

            log_dir = Path(temp_dir) / "run-1"
            reflections = [
                json.loads(line)
                for line in (log_dir / "reflections.jsonl").read_text().splitlines()
            ]
            evaluations = [
                json.loads(line)
                for line in (log_dir / "evaluations.jsonl").read_text().splitlines()
            ]
            result_json = json.loads((log_dir / "result.json").read_text())
            train_rows = json.loads((log_dir / "trainset.json").read_text())["rows"]

        self.assertEqual(reflections[0]["prompt"], "reflection prompt includes customer-input")
        self.assertEqual(reflections[0]["response"], "improved because customer-input")
        self.assertIn(
            {"id": "train-1", "row": {"secret": "customer-input", "expected": "improved"}},
            train_rows,
        )
        self.assertTrue(any(item["row"]["secret"] == "customer-input" for item in evaluations))
        self.assertTrue(any(item["feedback"] == "secret=validation-input" for item in evaluations))
        self.assertEqual(result_json["optimization_run_id"], "run-1")
        self.assertEqual(result_json["best_candidate_id"], result.best_candidate_id)

    def test_lower_is_better_acceptance_and_frontier(self):
        sink = FakeSink()
        scorer = PromptContext(
            body="score error",
            body_kind="text",
            provider_settings={"model": "anthropic/claude-haiku-4"},
            prompt_version_id="scorer-prompt-version-1",
            runner_version_id="scorer-runner-version-1",
            scorer_version_id="error-rate-scorer",
            metric_key="error_rate",
            higher_is_better=False,
        )

        def candidate_runner(candidate_text, row, prompt_context, candidate_id):
            return RunnerCallResult(model_response={"answer": candidate_text})

        def scorer_runner(row, candidate_result, scorer_context, candidate_id):
            score = 0.1 if candidate_result.model_response["answer"] == "improved" else 0.8
            return RunnerCallResult(model_response={"score": score, "feedback": f"error={score}"})

        def reflector(parent_text, parent_results, config):
            return ReflectionResult(
                prompt="reflection prompt",
                response="improved",
                candidate_text="improved",
            )

        result = optimize_loaded_text_candidate(
            run_id="run-1",
            prompt_context=self.prompt,
            scorer_context=scorer,
            trainset=self.trainset,
            valset=self.valset,
            candidate_runner=candidate_runner,
            scorer_runner=scorer_runner,
            reflector=reflector,
            event_sink=sink,
            config=TextGepaConfig(max_iterations=1, minibatch_size=2),
        )

        decision = next(event for event in sink.events if event["event_type"] == "acceptance_decision_made")
        self.assertTrue(decision["payload"]["proceed_to_full_eval"])
        self.assertFalse(decision["payload"]["higher_is_better"])
        self.assertEqual(result.best_score, 0.1)
        self.assertNotEqual(result.best_candidate_id, "seed")
        completed = next(event for event in sink.events if event["event_type"] == "run_completed")
        self.assertEqual(completed["payload"]["metric_key"], "error_rate")
        self.assertAlmostEqual(completed["payload"]["improvement"], 0.7)

    def test_rejects_child_without_full_val_eval_when_minibatch_does_not_improve(self):
        sink = FakeSink()

        def candidate_runner(candidate_text, row, prompt_context, candidate_id):
            return RunnerCallResult(model_response={"answer": candidate_text})

        def scorer_runner(row, candidate_result, scorer_context, candidate_id):
            score = 1.0 if candidate_result.model_response["answer"] == "initial text" else 0.0
            return RunnerCallResult(model_response={"score": score, "feedback": f"score={score}"})

        def reflector(parent_text, parent_results, config):
            return ReflectionResult(
                prompt="reflection prompt",
                response="worse",
                candidate_text="worse",
            )

        result = optimize_loaded_text_candidate(
            run_id="run-1",
            prompt_context=self.prompt,
            scorer_context=self.scorer,
            trainset=self.trainset,
            valset=self.valset,
            candidate_runner=candidate_runner,
            scorer_runner=scorer_runner,
            reflector=reflector,
            event_sink=sink,
            config=TextGepaConfig(
                max_iterations=1,
                minibatch_size=2,
                auto_promote=True,
                skip_perfect_parent_reflection=False,
            ),
        )

        event_types = [event["event_type"] for event in sink.events]
        self.assertIn("candidate_rejected", event_types)
        self.assertNotIn("child_val_set_completed", event_types)
        self.assertEqual(result.best_candidate_id, "seed")
        self.assertEqual(sink.promotions, [])

    def test_skips_reflection_by_default_when_parent_minibatch_is_perfect(self):
        sink = FakeSink()
        reflector_calls = 0

        def candidate_runner(candidate_text, row, prompt_context, candidate_id):
            return RunnerCallResult(model_response={"answer": candidate_text})

        def scorer_runner(row, candidate_result, scorer_context, candidate_id):
            return RunnerCallResult(model_response={"score": 1.0, "feedback": "perfect"})

        def reflector(parent_text, parent_results, config):
            nonlocal reflector_calls
            reflector_calls += 1
            return ReflectionResult(
                prompt="reflection prompt",
                response="new",
                candidate_text="new",
            )

        result = optimize_loaded_text_candidate(
            run_id="run-1",
            prompt_context=self.prompt,
            scorer_context=self.scorer,
            trainset=self.trainset,
            valset=self.valset,
            candidate_runner=candidate_runner,
            scorer_runner=scorer_runner,
            reflector=reflector,
            event_sink=sink,
            config=TextGepaConfig(max_iterations=1, minibatch_size=2),
        )

        event_types = [event["event_type"] for event in sink.events]
        self.assertEqual(reflector_calls, 0)
        self.assertIn("reflection_skipped", event_types)
        self.assertNotIn("reflection_started", event_types)
        self.assertNotIn("child_candidate_created", event_types)
        self.assertEqual(result.budget.used_candidate_proposals, 0)
        skipped = next(event for event in sink.events if event["event_type"] == "reflection_skipped")
        self.assertEqual(skipped["payload"]["reason"], "parent_minibatch_perfect")
        completed = next(event for event in sink.events if event["event_type"] == "iteration_completed")
        self.assertTrue(completed["payload"]["skipped_reflection"])
        self.assertIsNone(completed["payload"]["child_candidate_id"])

    def test_can_reflect_when_perfect_parent_skip_is_disabled(self):
        sink = FakeSink()
        reflector_calls = 0

        def candidate_runner(candidate_text, row, prompt_context, candidate_id):
            return RunnerCallResult(model_response={"answer": candidate_text})

        def scorer_runner(row, candidate_result, scorer_context, candidate_id):
            return RunnerCallResult(model_response={"score": 1.0, "feedback": "perfect"})

        def reflector(parent_text, parent_results, config):
            nonlocal reflector_calls
            reflector_calls += 1
            return ReflectionResult(
                prompt="reflection prompt",
                response="new",
                candidate_text="new",
            )

        optimize_loaded_text_candidate(
            run_id="run-1",
            prompt_context=self.prompt,
            scorer_context=self.scorer,
            trainset=self.trainset,
            valset=self.valset,
            candidate_runner=candidate_runner,
            scorer_runner=scorer_runner,
            reflector=reflector,
            event_sink=sink,
            config=TextGepaConfig(
                max_iterations=1,
                minibatch_size=2,
                skip_perfect_parent_reflection=False,
            ),
        )

        event_types = [event["event_type"] for event in sink.events]
        self.assertEqual(reflector_calls, 1)
        self.assertIn("reflection_started", event_types)
        self.assertIn("child_candidate_created", event_types)
        self.assertNotIn("reflection_skipped", event_types)

    def test_final_perfect_parent_skip_can_succeed_after_metric_budget_exhausts(self):
        sink = FakeSink()

        def candidate_runner(candidate_text, row, prompt_context, candidate_id):
            return RunnerCallResult(model_response={"answer": candidate_text})

        def scorer_runner(row, candidate_result, scorer_context, candidate_id):
            return RunnerCallResult(model_response={"score": 1.0, "feedback": "perfect"})

        def reflector(parent_text, parent_results, config):
            return ReflectionResult(
                prompt="reflection prompt",
                response="new",
                candidate_text="new",
            )

        result = optimize_loaded_text_candidate(
            run_id="run-1",
            prompt_context=self.prompt,
            scorer_context=self.scorer,
            trainset=self.trainset,
            valset=self.valset,
            candidate_runner=candidate_runner,
            scorer_runner=scorer_runner,
            reflector=reflector,
            event_sink=sink,
            config=TextGepaConfig(max_iterations=1, minibatch_size=2, max_metric_calls=3),
        )

        event_types = [event["event_type"] for event in sink.events]
        self.assertIn("reflection_skipped", event_types)
        self.assertNotIn("budget_exhausted", event_types)
        self.assertNotIn("run_paused", event_types)
        self.assertIn("run_completed", event_types)
        self.assertEqual(sink.finished["status"], "succeeded")
        self.assertEqual(result.best_candidate_id, "seed")
        self.assertGreater(result.budget.used_metric_calls, result.budget.limit)

    def test_default_minibatch_size_is_three(self):
        rows = [DatasetRow(f"train-{index}", {"index": index}) for index in range(5)]

        minibatch = _sample_minibatch(rows, iteration=1, config=TextGepaConfig())

        self.assertEqual(TextGepaConfig().minibatch_size, 3)
        self.assertEqual(len(minibatch), 3)

    def test_default_reflection_timeout_preserves_previous_window(self):
        self.assertEqual(TextGepaConfig().reflection_http_timeout_seconds, 180)

    def test_pareto_parent_selection_samples_row_winners_instead_of_current_best(self):
        config = TextGepaConfig(seed=4, candidate_selection_strategy="pareto")
        val_scores = {
            "seed": {"val-1": 1.0, "val-2": 0.0, "val-3": 0.0},
            "candidate-a": {"val-1": 0.9, "val-2": 0.9, "val-3": 0.9},
        }

        selected = _select_parent_candidate_id(
            val_scores_by_candidate=val_scores,
            best_candidate_id="candidate-a",
            config=config,
            iteration=1,
        )

        self.assertEqual(selected, "seed")

    def test_pareto_parent_selection_reports_validation_row_win_weights(self):
        val_scores = {
            "seed": {"val-1": 1.0, "val-2": 0.0, "val-3": 0.0, "val-4": 0.0},
            "candidate-a": {"val-1": 0.9, "val-2": 0.9, "val-3": 0.9, "val-4": 0.2},
            "candidate-b": {"val-1": 0.1, "val-2": 0.1, "val-3": 0.1, "val-4": 0.8},
            "candidate-no-wins": {"val-1": 0.0, "val-2": 0.0, "val-3": 0.0, "val-4": 0.0},
        }
        payload = _parent_selection_payload(
            val_scores_by_candidate=val_scores,
            selected_candidate_id="candidate-a",
            best_candidate_id="candidate-a",
            config=TextGepaConfig(candidate_selection_strategy="pareto"),
        )

        self.assertEqual(payload["frontier_counts"], {
            "seed": 1,
            "candidate-a": 2,
            "candidate-b": 1,
        })

    def test_pareto_payload_reports_row_winners_and_best_by_most_rows(self):
        val_scores = {
            "seed": {"val-1": 1.0, "val-2": 0.6, "val-3": 0.6},
            "candidate-a": {"val-1": 0.0, "val-2": 0.7, "val-3": 0.7},
            "candidate-b": {"val-1": 0.5, "val-2": 0.5, "val-3": 0.5},
        }
        best_candidate_id, best_score, payload = _pareto_payload(
            val_scores,
            {candidate_id: candidate_id for candidate_id in val_scores},
        )

        self.assertEqual(best_candidate_id, "candidate-a")
        self.assertEqual(best_score, sum(val_scores["candidate-a"].values()) / 3)
        self.assertEqual(payload["frontier_candidate_ids"], ["candidate-a", "seed"])
        self.assertEqual(payload["frontier_counts"], {"seed": 1, "candidate-a": 2})

    def test_reuses_cached_parent_minibatch_evaluations(self):
        sink = FakeSink()
        trainset = [
            DatasetRow("train-1", {"expected": "initial text"}),
            DatasetRow("train-2", {"expected": "initial text"}),
            DatasetRow("train-3", {"expected": "initial text"}),
        ]
        valset = [DatasetRow("val-1", {"expected": "initial text"})]
        candidate_calls: dict[tuple[str, str], int] = {}

        def candidate_runner(candidate_text, row, prompt_context, candidate_id):
            key = (candidate_id, row.id)
            candidate_calls[key] = candidate_calls.get(key, 0) + 1
            return RunnerCallResult(model_response={"answer": candidate_text})

        def scorer_runner(row, candidate_result, scorer_context, candidate_id):
            score = 1.0 if candidate_result.model_response["answer"] == row.row["expected"] else 0.0
            return RunnerCallResult(model_response={"score": score, "feedback": f"score={score}"})

        def reflector(parent_text, parent_results, config):
            return ReflectionResult(
                prompt="reflection prompt",
                response="worse",
                candidate_text="worse",
            )

        optimize_loaded_text_candidate(
            run_id="run-1",
            prompt_context=self.prompt,
            scorer_context=self.scorer,
            trainset=trainset,
            valset=valset,
            candidate_runner=candidate_runner,
            scorer_runner=scorer_runner,
            reflector=reflector,
            event_sink=sink,
            config=TextGepaConfig(
                max_iterations=2,
                minibatch_size=3,
                auto_promote=True,
                skip_perfect_parent_reflection=False,
            ),
        )

        self.assertEqual(candidate_calls[("seed", "train-1")], 1)
        self.assertEqual(candidate_calls[("seed", "train-2")], 1)
        self.assertEqual(candidate_calls[("seed", "train-3")], 1)
        parent_events = [
            event for event in sink.events
            if event["event_type"] == "parent_minibatch_completed"
        ]
        self.assertEqual(parent_events[0]["payload"]["cache_hits"], 0)
        self.assertEqual(parent_events[1]["payload"]["cache_hits"], 3)

    def test_completes_started_iteration_even_when_metric_budget_exhausts(self):
        sink = FakeSink()

        def candidate_runner(candidate_text, row, prompt_context, candidate_id):
            return RunnerCallResult(model_response={"answer": candidate_text})

        def scorer_runner(row, candidate_result, scorer_context, candidate_id):
            score = 1.0 if candidate_result.model_response["answer"] == "new" else 0.0
            return RunnerCallResult(model_response={"score": score, "feedback": f"score={score}"})

        def reflector(parent_text, parent_results, config):
            return ReflectionResult(
                prompt="reflection prompt",
                response="new",
                candidate_text="new",
            )

        result = optimize_loaded_text_candidate(
            run_id="run-1",
            prompt_context=self.prompt,
            scorer_context=self.scorer,
            trainset=self.trainset,
            valset=self.valset,
            candidate_runner=candidate_runner,
            scorer_runner=scorer_runner,
            reflector=reflector,
            event_sink=sink,
            config=TextGepaConfig(max_iterations=2, minibatch_size=2, max_metric_calls=3),
        )

        event_types = [event["event_type"] for event in sink.events]
        self.assertIn("budget_exhausted", event_types)
        self.assertIn("run_paused", event_types)
        self.assertIn("parent_minibatch_completed", event_types)
        self.assertIn("child_minibatch_completed", event_types)
        self.assertIn("child_val_set_completed", event_types)
        self.assertEqual(sink.finished["status"], "paused")
        self.assertNotEqual(result.best_candidate_id, "seed")
        self.assertGreater(result.budget.used_metric_calls, result.budget.limit)
        child_val = next(event for event in sink.events if event["event_type"] == "child_val_set_completed")
        self.assertEqual(len(child_val["payload"]["row_results"]), len(self.valset))

    def test_final_iteration_can_succeed_after_metric_budget_exhausts(self):
        sink = FakeSink()

        def candidate_runner(candidate_text, row, prompt_context, candidate_id):
            return RunnerCallResult(model_response={"answer": candidate_text})

        def scorer_runner(row, candidate_result, scorer_context, candidate_id):
            score = 1.0 if candidate_result.model_response["answer"] == "new" else 0.0
            return RunnerCallResult(model_response={"score": score, "feedback": f"score={score}"})

        def reflector(parent_text, parent_results, config):
            return ReflectionResult(
                prompt="reflection prompt",
                response="new",
                candidate_text="new",
            )

        result = optimize_loaded_text_candidate(
            run_id="run-1",
            prompt_context=self.prompt,
            scorer_context=self.scorer,
            trainset=self.trainset,
            valset=self.valset,
            candidate_runner=candidate_runner,
            scorer_runner=scorer_runner,
            reflector=reflector,
            event_sink=sink,
            config=TextGepaConfig(max_iterations=1, minibatch_size=2, max_metric_calls=3, auto_promote=True),
        )

        event_types = [event["event_type"] for event in sink.events]
        self.assertNotIn("budget_exhausted", event_types)
        self.assertNotIn("run_paused", event_types)
        self.assertIn("run_completed", event_types)
        self.assertEqual(sink.finished["status"], "succeeded")
        self.assertEqual(result.promoted_prompt_version_id, "promoted-version-1")
        self.assertGreater(result.budget.used_metric_calls, result.budget.limit)

    def test_scorer_cache_identity_uses_scorer_version_separately_from_prompt_version(self):
        first_scorer = PromptContext(
            body="score it",
            body_kind="text",
            provider_settings={"model": "anthropic/claude-haiku-4"},
            prompt_version_id="scorer-prompt-version-1",
            runner_version_id="scorer-runner-version-1",
            scorer_version_id="scorer-version-1",
        )
        second_scorer = PromptContext(
            body="score it",
            body_kind="text",
            provider_settings={"model": "anthropic/claude-haiku-4"},
            prompt_version_id="scorer-prompt-version-1",
            runner_version_id="scorer-runner-version-1",
            scorer_version_id="scorer-version-2",
        )
        cache = EvaluationCache()
        row = DatasetRow("row-1", {"expected": "ok"})

        first_key = cache.key(
            candidate_text="candidate",
            row=row,
            split="validation",
            prompt_context=self.prompt,
            scorer_context=first_scorer,
        )
        second_key = cache.key(
            candidate_text="candidate",
            row=row,
            split="validation",
            prompt_context=self.prompt,
            scorer_context=second_scorer,
        )

        self.assertNotEqual(first_key, second_key)

    def test_client_scorer_exec_context_preserves_backing_prompt_version_id(self):
        class FakeClient(OrizuClient):
            def __init__(self):
                super().__init__("http://localhost:3000", "token", "team/project")

            def _request(self, method, path, body=None):
                self.request = {"method": method, "path": path, "body": body}
                return {
                    "prompt": {
                        "body": "score it",
                        "bodyKind": "text",
                        "providerSettings": {"model": "anthropic/claude-haiku-4"},
                        "promptId": "scorer-prompt-1",
                        "promptVersionId": "scorer-prompt-version-1",
                        "runnerVersionId": "scorer-runner-version-1",
                    },
                    "scorer": {
                        "versionId": "scorer-version-1",
                        "metricKey": "accuracy",
                        "higherIsBetter": False,
                    },
                    "rows": [
                        {"id": "row-1", "row": {"expected": "ok"}},
                    ],
                }

        client = FakeClient()
        context, rows = client.fetch_scorer_exec_context(
            scorer_version_id="scorer-version-1",
            runner_version_id=None,
            dataset_version_id="dataset-version-1",
            split_set_id="split-set-1",
            split="validation",
        )

        self.assertEqual(context.prompt_version_id, "scorer-prompt-version-1")
        self.assertEqual(context.scorer_version_id, "scorer-version-1")
        self.assertEqual(context.metric_key, "accuracy")
        self.assertFalse(context.higher_is_better)
        self.assertEqual(rows[0].id, "row-1")

    def test_event_sink_retries_log_events(self):
        class FlakyClient:
            def __init__(self):
                self.calls = 0

            def log_event(self, *args, **kwargs):
                self.calls += 1
                if self.calls < 2:
                    raise RuntimeError("temporary")

        client = FlakyClient()
        sink = OrizuEventSink(client, "run-1", max_log_retries=2)

        sink.log_event("run_started", {})

        self.assertEqual(client.calls, 2)

    def test_event_sink_prints_progress_percent_and_budget_left(self):
        class FakeClient:
            def log_event(self, *args, **kwargs):
                return None

        sink = OrizuEventSink(FakeClient(), "run-1")
        output = io.StringIO()

        with contextlib.redirect_stdout(output):
            sink.log_event("optimization_progress", {
                "percent": 100,
                "metric_calls_remaining": 0,
                "metric_call_budget": 3,
            })

        self.assertIn("optimization_progress 100%; 0 / 3 metric calls left", output.getvalue())

    def test_auto_num_threads_respects_rows_and_resources(self):
        plan = resolve_num_threads(
            "auto",
            minibatch_size=8,
            validation_count=50,
            cpu_count=32,
            available_memory_bytes=3 * 1024 * 1024 * 1024,
            total_memory_bytes=8 * 1024 * 1024 * 1024,
            fd_limit=256,
            hard_cap=16,
            worker_memory_bytes=512 * 1024 * 1024,
        )

        self.assertEqual(plan.resolved, 2)
        self.assertEqual(plan.limiting_factor, "memory")
        self.assertEqual(plan.row_bound, 50)
        self.assertEqual(plan.cpu_bound, 64)
        self.assertEqual(plan.fd_bound, 12)

    def test_auto_num_threads_default_cap_allows_large_runs_to_scale(self):
        plan = resolve_num_threads(
            "auto",
            minibatch_size=100,
            validation_count=200,
            cpu_count=64,
            available_memory_bytes=128 * 1024 * 1024 * 1024,
            total_memory_bytes=256 * 1024 * 1024 * 1024,
            fd_limit=4096,
            worker_memory_bytes=512 * 1024 * 1024,
        )

        self.assertEqual(plan.resolved, 64)
        self.assertEqual(plan.limiting_factor, "hard_cap")
        self.assertEqual(plan.hard_cap, 64)
        self.assertEqual(plan.cpu_bound, 128)

    def test_auto_num_threads_normalizes_non_positive_cpu_counts(self):
        for cpu_count in (0, -5):
            with self.subTest(cpu_count=cpu_count):
                plan = resolve_num_threads(
                    "auto",
                    minibatch_size=10,
                    validation_count=10,
                    cpu_count=cpu_count,
                    available_memory_bytes=128 * 1024 * 1024 * 1024,
                    total_memory_bytes=256 * 1024 * 1024 * 1024,
                    fd_limit=4096,
                    worker_memory_bytes=512 * 1024 * 1024,
                )

                self.assertEqual(plan.resolved, 2)
                self.assertEqual(plan.limiting_factor, "cpu")
                self.assertEqual(plan.cpu_bound, 2)

    def test_explicit_num_threads_is_preserved(self):
        plan = resolve_num_threads(
            12,
            minibatch_size=2,
            validation_count=3,
            cpu_count=2,
            available_memory_bytes=2 * 1024 * 1024 * 1024,
            total_memory_bytes=8 * 1024 * 1024 * 1024,
            fd_limit=128,
            hard_cap=4,
            worker_memory_bytes=1024 * 1024 * 1024,
        )

        self.assertEqual(plan.resolved, 12)
        self.assertEqual(plan.limiting_factor, "explicit")

    def test_parallel_evaluation_preserves_row_order(self):
        from orizu_gepa.optimizer import evaluate_candidate

        rows = [
            DatasetRow("row-1", {"delay": 0.03}),
            DatasetRow("row-2", {"delay": 0.01}),
            DatasetRow("row-3", {"delay": 0.02}),
        ]

        def candidate_runner(candidate_text, row, prompt_context, candidate_id):
            time.sleep(row.row["delay"])
            return RunnerCallResult(model_response={"row_id": row.id})

        def scorer_runner(row, candidate_result, scorer_context, candidate_id):
            return RunnerCallResult(model_response={"score": 1.0})

        results = evaluate_candidate(
            candidate_text="candidate",
            candidate_id="candidate-1",
            rows=rows,
            split="validation",
            prompt_context=self.prompt,
            scorer_context=self.scorer,
            candidate_runner=candidate_runner,
            scorer_runner=scorer_runner,
            budget=Budget("max_metric_calls", 10),
            num_threads=3,
        )

        self.assertEqual([result.row_id for result in results], ["row-1", "row-2", "row-3"])

    def test_parallel_evaluation_does_not_submit_all_rows_after_failure(self):
        from orizu_gepa.optimizer import evaluate_candidate

        rows = [
            DatasetRow(f"row-{index}", {})
            for index in range(1, 8)
        ]
        calls = []

        def candidate_runner(candidate_text, row, prompt_context, candidate_id):
            calls.append(row.id)
            if row.id == "row-1":
                raise RuntimeError("boom")
            time.sleep(0.05)
            return RunnerCallResult(model_response={"row_id": row.id})

        def scorer_runner(row, candidate_result, scorer_context, candidate_id):
            return RunnerCallResult(model_response={"score": 1.0})

        with self.assertRaisesRegex(RuntimeError, "boom"):
            evaluate_candidate(
                candidate_text="candidate",
                candidate_id="candidate-1",
                rows=rows,
                split="validation",
                prompt_context=self.prompt,
                scorer_context=self.scorer,
                candidate_runner=candidate_runner,
                scorer_runner=scorer_runner,
                budget=Budget("max_metric_calls", 100),
                num_threads=2,
            )

        self.assertLessEqual(len(calls), 2)
        self.assertNotIn("row-3", calls)

    def test_metric_call_budget_counts_uncached_rows_without_truncating_batch(self):
        calls = 0
        rows = [
            DatasetRow("row-1", {"expected": "ok"}),
            DatasetRow("row-2", {"expected": "ok"}),
            DatasetRow("row-3", {"expected": "ok"}),
        ]

        def candidate_runner(candidate_text, row, prompt_context, candidate_id):
            nonlocal calls
            calls += 1
            return RunnerCallResult(model_response={"answer": candidate_text})

        def scorer_runner(row, candidate_result, scorer_context, candidate_id):
            return RunnerCallResult(model_response={"score": 1.0})

        from orizu_gepa.optimizer import evaluate_candidate

        budget = Budget("max_metric_calls", 1)
        results = evaluate_candidate(
            candidate_text="candidate",
            candidate_id="candidate-1",
            rows=rows,
            split="validation",
            prompt_context=self.prompt,
            scorer_context=self.scorer,
            candidate_runner=candidate_runner,
            scorer_runner=scorer_runner,
            budget=budget,
            num_threads=3,
        )

        self.assertEqual(calls, 3)
        self.assertEqual(len(results), 3)
        self.assertEqual(budget.used_metric_calls, 3)
        self.assertEqual(budget.remaining, 0)

    def test_budget_presets_use_dspy_auto_scale(self):
        self.assertEqual(
            Budget.from_config(TextGepaConfig(), trainset_size=100, valset_size=20).limit,
            _dspy_auto_metric_budget(num_components=1, num_candidates=12, valset_size=20),
        )
        self.assertEqual(
            Budget.from_config(TextGepaConfig(budget="light"), trainset_size=100, valset_size=20).limit,
            _dspy_auto_metric_budget(num_components=1, num_candidates=6, valset_size=20),
        )
        self.assertEqual(
            Budget.from_config(TextGepaConfig(budget="medium"), trainset_size=100, valset_size=20).limit,
            _dspy_auto_metric_budget(num_components=1, num_candidates=12, valset_size=20),
        )
        self.assertEqual(
            Budget.from_config(TextGepaConfig(budget="heavy"), trainset_size=100, valset_size=20).limit,
            _dspy_auto_metric_budget(num_components=1, num_candidates=18, valset_size=20),
        )
        self.assertEqual(
            Budget.from_config(TextGepaConfig(budget="high"), trainset_size=100, valset_size=20).limit,
            Budget.from_config(TextGepaConfig(budget="heavy"), trainset_size=100, valset_size=20).limit,
        )

    def test_max_full_evals_maps_to_metric_call_budget_like_dspy(self):
        budget = Budget.from_config(
            TextGepaConfig(max_full_evals=2),
            trainset_size=7,
            valset_size=3,
        )

        self.assertEqual(budget.budget_kind, "max_metric_calls")
        self.assertEqual(budget.limit, 20)

    def test_max_iterations_can_be_the_only_budget(self):
        budget = Budget.from_config(
            TextGepaConfig(budget=None, max_iterations=4),
            trainset_size=7,
            valset_size=3,
        )

        self.assertEqual(budget.budget_kind, "max_iterations")
        self.assertEqual(budget.limit, 4)
        self.assertIsNone(budget.approx_metric_call_limit)
        self.assertEqual(budget.remaining, 4)
        budget.used_iterations = 1
        self.assertEqual(budget.used, 1)
        self.assertEqual(budget.remaining, 3)
        self.assertEqual(budget.progress_percent, 25.0)

    def test_dspy_auto_metric_budget_validates_before_log_math(self):
        with self.assertRaisesRegex(ValueError, "num_candidates must be > 0"):
            _dspy_auto_metric_budget(num_components=1, num_candidates=0, valset_size=20)
        with self.assertRaisesRegex(ValueError, "num_components, valset_size, and minibatch_size"):
            _dspy_auto_metric_budget(num_components=-1, num_candidates=6, valset_size=20)

    def test_invalid_scorer_scores_raise_instead_of_becoming_zero(self):
        with self.assertRaisesRegex(ValueError, "numeric score"):
            _score_from_scorer(RunnerCallResult(model_response={"feedback": "missing score"}))

        with self.assertRaisesRegex(ValueError, "finite"):
            _score_from_scorer(RunnerCallResult(model_response={"score": "nan"}))

    def test_reflection_prompt_is_gepa_style_and_overrideable(self):
        prompt = build_reflection_prompt(
            "old text",
            [RowEvaluation(
                row_id="row-1",
                row={"input": "hello"},
                output={"answer": "bad"},
                score=0.2,
                feedback="Be more specific",
            )],
            TextGepaConfig(),
        )
        self.assertIn("old text", prompt)
        self.assertIn("optimizing a text parameter", prompt)
        self.assertIn("drop-in replacement", prompt)
        self.assertIn("used verbatim as the next candidate", prompt)
        self.assertIn("Be more specific", prompt)
        custom = build_reflection_prompt(
            "old text",
            [],
            TextGepaConfig(reflection_prompt_template="A <current_candidate> B <evaluation_data> C"),
        )
        self.assertEqual(custom, "A old text B {\n  \"objective\": \"Improve this text candidate to maximize evaluator score while preserving intended behavior.\",\n  \"examples\": []\n} C")
        legacy_custom = build_reflection_prompt(
            "old text",
            [],
            TextGepaConfig(reflection_prompt_template="A <curr_instructions> B <inputs_outputs_feedback> C"),
        )
        self.assertEqual(legacy_custom, custom)

    def test_extract_candidate_text_uses_verbatim_response_by_default(self):
        self.assertEqual(extract_candidate_text("```text\nnew text\n```"), "```text\nnew text\n```")
        self.assertEqual(extract_candidate_text("<candidate>new text</candidate>"), "<candidate>new text</candidate>")
        self.assertEqual(
            extract_candidate_text("Analysis first\n```markdown\n# Exact prompt\nUse this."),
            "Analysis first\n```markdown\n# Exact prompt\nUse this.",
        )

    def test_anthropic_reflection_payload_uses_provider_settings(self):
        payload = build_anthropic_reflection_payload(
            "claude-opus-4-7",
            "prompt",
            TextGepaConfig(
                reflection_max_tokens=2048,
                reflection_provider_settings={
                    "thinking": {"type": "adaptive", "display": "omitted"},
                    "output_config": {"effort": "medium"},
                },
            ),
        )
        self.assertEqual(payload["max_tokens"], 2048)
        self.assertEqual(payload["thinking"], {"type": "adaptive", "display": "omitted"})
        self.assertEqual(payload["output_config"], {"effort": "medium"})
        self.assertNotIn("temperature", payload)

        with self.assertRaisesRegex(RuntimeError, "reflection_temperature"):
            build_anthropic_reflection_payload(
                "claude-opus-4-7",
                "prompt",
                TextGepaConfig(
                    reflection_max_tokens=2048,
                    reflection_temperature=0.2,
                    reflection_provider_settings={"thinking": {"type": "adaptive"}},
                ),
            )

    def test_anthropic_reflection_payload_requires_max_tokens(self):
        with self.assertRaisesRegex(RuntimeError, "reflection_max_tokens is required"):
            build_anthropic_reflection_payload(
                "claude-opus-4-7",
                "prompt",
                TextGepaConfig(),
            )

    def test_reflection_payload_rejects_non_positive_max_tokens(self):
        with self.assertRaisesRegex(RuntimeError, "reflection_max_tokens"):
            build_anthropic_reflection_payload(
                "claude-opus-4-7",
                "prompt",
                TextGepaConfig(reflection_max_tokens=0),
            )
        with self.assertRaisesRegex(RuntimeError, "reflection_max_tokens"):
            build_openai_reflection_payload(
                "gpt-5",
                "prompt",
                TextGepaConfig(reflection_max_tokens=-1),
            )

    def test_openai_reflection_payload_uses_reasoning_provider_settings(self):
        payload = build_openai_reflection_payload(
            "gpt-5",
            "prompt",
            TextGepaConfig(
                reflection_provider_settings={
                    "reasoning": {"effort": "medium", "summary": "auto"},
                },
            ),
        )
        self.assertEqual(payload["model"], "gpt-5")
        self.assertEqual(payload["input"], [{"role": "user", "content": "prompt"}])
        self.assertNotIn("max_output_tokens", payload)
        self.assertEqual(payload["reasoning"], {"effort": "medium", "summary": "auto"})

    def test_reflection_payload_uses_explicit_max_tokens(self):
        anthropic_payload = build_anthropic_reflection_payload(
            "claude-opus-4-7",
            "prompt",
            TextGepaConfig(reflection_max_tokens=2048),
        )
        openai_payload = build_openai_reflection_payload(
            "gpt-5",
            "prompt",
            TextGepaConfig(reflection_max_tokens=2048),
        )

        self.assertEqual(anthropic_payload["max_tokens"], 2048)
        self.assertEqual(openai_payload["max_output_tokens"], 2048)

    def test_anthropic_reflection_retries_timeout_then_succeeds(self):
        response = _FakeHttpResponse({"content": [{"type": "text", "text": "improved"}]})

        with mock.patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test-key"}):
            with mock.patch(
                "orizu_gepa.reflection.urllib.request.urlopen",
                side_effect=[TimeoutError("read timed out"), response],
            ) as urlopen:
                with mock.patch("orizu_gepa.reflection.time.sleep") as sleep:
                    with mock.patch("orizu_gepa.reflection.random.uniform", return_value=0.0):
                        result = reflect_with_anthropic(
                            "initial",
                            [],
                            TextGepaConfig(
                                reflection_max_tokens=128,
                                reflection_retry_attempts=2,
                                reflection_http_timeout_seconds=12,
                            ),
                        )

        self.assertEqual(result.candidate_text, "improved")
        self.assertEqual(urlopen.call_count, 2)
        self.assertEqual(urlopen.call_args_list[0].kwargs["timeout"], 12)
        sleep.assert_called_once_with(5.0)

    def test_anthropic_reflection_retries_429_then_succeeds(self):
        too_many_requests = urllib.error.HTTPError(
            "https://api.anthropic.com/v1/messages",
            429,
            "Too Many Requests",
            hdrs=None,
            fp=io.BytesIO(b'{"error":"busy"}'),
        )
        response = _FakeHttpResponse({"content": [{"type": "text", "text": "improved"}]})

        with mock.patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test-key"}):
            with mock.patch(
                "orizu_gepa.reflection.urllib.request.urlopen",
                side_effect=[too_many_requests, response],
            ) as urlopen:
                with mock.patch("orizu_gepa.reflection.time.sleep") as sleep:
                    with mock.patch("orizu_gepa.reflection.random.uniform", return_value=0.0):
                        result = reflect_with_anthropic(
                            "initial",
                            [],
                            TextGepaConfig(
                                reflection_max_tokens=128,
                                reflection_retry_attempts=2,
                                reflection_http_timeout_seconds=12,
                            ),
                        )

        self.assertEqual(result.candidate_text, "improved")
        self.assertEqual(urlopen.call_count, 2)
        sleep.assert_called_once_with(5.0)

    def test_anthropic_reflection_raises_retryable_error_after_timeout_attempts(self):
        with mock.patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test-key"}):
            with mock.patch(
                "orizu_gepa.reflection.urllib.request.urlopen",
                side_effect=TimeoutError("read timed out"),
            ) as urlopen:
                with mock.patch("orizu_gepa.reflection.time.sleep") as sleep:
                    with mock.patch("orizu_gepa.reflection.random.uniform", return_value=0.0):
                        with self.assertRaisesRegex(RetryableReflectionError, "timed out"):
                            reflect_with_anthropic(
                                "initial",
                                [],
                                TextGepaConfig(
                                    reflection_max_tokens=128,
                                    reflection_retry_attempts=2,
                                    reflection_http_timeout_seconds=12,
                                ),
                            )

        self.assertEqual(urlopen.call_count, 2)
        sleep.assert_called_once_with(5.0)


class _FakeHttpResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


if __name__ == "__main__":
    unittest.main()
