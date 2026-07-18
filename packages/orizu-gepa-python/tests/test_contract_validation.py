from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

from orizu_gepa.optimizer import (
    DatasetRow,
    PromptContext,
    ReflectionResult,
    RunnerCallResult,
    ScorerContractError,
    TextGepaConfig,
    optimize_loaded_text_candidate,
)
from orizu_gepa.runner import make_scorer_runner


# ALI-1158: judge runners written for the FLAT-ROW score-run contract
# (`orizu runners exec --scorer-version` — dataset row fields at the top level
# of `row`, candidate output at `model_output`/a row field) are incompatible
# with GEPA's scorer-runner contract (`row` = {source_row, candidate_id,
# candidate_output, ...}). Fed the GEPA shape, a flat-row judge sees an empty
# draft in every field it reads and silently scores every candidate 0.0 —
# the live failure in GEPA run 822a9ba5 (orizu-workbench-demo session 2).
# These tests pin (1) the launch-time contract validation that refuses the
# silent-zero seed before iterating, and (2) the official flat-row adapter
# that makes such judges usable without hand-writing a wrapper runner.


def write_flat_row_judge(judge_dir: Path) -> None:
    """A stub judge speaking the flat-row score-run contract.

    Mirrors the live incident's judge: it reads the candidate output from the
    row field `draft` and compares it to the row field `reference`. Fed a
    GEPA-shaped row it finds no draft and (correctly, given what it received)
    scores 0.0 without erroring.
    """
    judge_dir.mkdir(parents=True, exist_ok=True)
    (judge_dir / "manifest.json").write_text(json.dumps({
        "command": [sys.executable, "judge.py"],
    }))
    (judge_dir / "judge.py").write_text(
        """
import json
import os

with open(os.environ["ORIZU_RUNNER_INPUT_PATH"]) as handle:
    payload = json.load(handle)

row = payload.get("row") or {}
draft = (row.get("draft") or "").strip()
reference = (row.get("reference") or "").strip()

if not draft:
    result = {"score": 0.0, "feedback": "completely empty draft"}
elif draft == reference:
    result = {"score": 1.0, "feedback": "matches reference"}
else:
    result = {"score": 0.5, "feedback": "differs from reference"}

with open(os.environ["ORIZU_RUNNER_OUTPUT_PATH"], "w") as handle:
    json.dump({
        "model_response": result,
        "score": result["score"],
        "feedback": result["feedback"],
        "error": None,
    }, handle)
"""
    )


def write_echo_judge(judge_dir: Path, manifest_extra: dict | None = None) -> None:
    """A judge that echoes the exact input payload it received back as its response."""
    judge_dir.mkdir(parents=True, exist_ok=True)
    (judge_dir / "manifest.json").write_text(json.dumps({
        "command": [sys.executable, "judge.py"],
        **(manifest_extra or {}),
    }))
    (judge_dir / "judge.py").write_text(
        """
import json
import os

with open(os.environ["ORIZU_RUNNER_INPUT_PATH"]) as handle:
    payload = json.load(handle)

with open(os.environ["ORIZU_RUNNER_OUTPUT_PATH"], "w") as handle:
    json.dump({
        "model_response": {"seen_input": payload},
        "score": 0.5,
        "feedback": "echo",
        "error": None,
    }, handle)
"""
    )


class FakeSink:
    def __init__(self):
        self.events = []
        self.finished = None

    def log_event(self, event_type, payload=None, **kwargs):
        self.events.append({"event_type": event_type, "payload": payload or {}, **kwargs})

    def promote_candidate(self, **kwargs):
        return "promoted-version-1"

    def finish_run(self, **kwargs):
        self.finished = kwargs


def prompt_context(**overrides) -> PromptContext:
    values = dict(
        body="seed prompt",
        body_kind="text",
        provider_settings={"model": "anthropic/claude-haiku-4"},
        prompt_version_id="prompt-version-1",
        runner_version_id="runner-version-1",
        prompt_id="prompt-1",
    )
    values.update(overrides)
    return PromptContext(**values)


def scorer_context(**overrides) -> PromptContext:
    values = dict(
        body="judge instructions",
        body_kind="text",
        provider_settings={"model": "anthropic/claude-haiku-4"},
        prompt_version_id="scorer-prompt-version-1",
        runner_version_id="scorer-runner-version-1",
        scorer_version_id="scorer-version-1",
        metric_key="style_match",
        higher_is_better=True,
    )
    values.update(overrides)
    return PromptContext(**values)


def candidate_runner(candidate_text, row, context, candidate_id):
    # The candidate "model" reproduces the row's reference exactly, so a
    # correctly-wired judge should score it 1.0.
    return RunnerCallResult(model_response=row.row.get("reference"))


ROWS = [
    DatasetRow("row-1", {"brief": "say hi", "reference": "Hey there!"}),
    DatasetRow("row-2", {"brief": "decline politely", "reference": "Thanks, but no."}),
]


class LaunchContractValidationTests(unittest.TestCase):
    def optimize(self, scorer_runner, config=None, sink=None, prompt=None, scorer=None):
        return optimize_loaded_text_candidate(
            run_id="run-1",
            prompt_context=prompt or prompt_context(),
            scorer_context=scorer or scorer_context(),
            trainset=list(ROWS),
            valset=list(ROWS),
            candidate_runner=candidate_runner,
            scorer_runner=scorer_runner,
            reflector=lambda parent_text, parent_results, config: ReflectionResult(
                prompt="reflection prompt",
                response="rewritten prompt",
                candidate_text="rewritten prompt",
            ),
            event_sink=sink or FakeSink(),
            config=config or TextGepaConfig(max_iterations=1, minibatch_size=2),
        )

    def test_flat_row_judge_fed_gepa_shape_is_refused_at_launch(self):
        # THE silent-zero reproduction: a real subprocess judge speaking the
        # flat-row contract, driven through the real GEPA scorer-runner
        # payload. Every seed row scores 0.0 with no error; launch validation
        # must refuse before any iteration instead of burning the budget on
        # a broken harness.
        sink = FakeSink()
        with tempfile.TemporaryDirectory() as temp_dir:
            judge_dir = Path(temp_dir) / "judge"
            write_flat_row_judge(judge_dir)
            scorer_runner = make_scorer_runner(judge_dir, None)

            with self.assertRaises(ScorerContractError) as caught:
                self.optimize(scorer_runner, sink=sink)

        message = str(caught.exception)
        self.assertIn("contract", message.lower())
        self.assertIn("--scorer-input-contract", message)
        event_types = [event["event_type"] for event in sink.events]
        self.assertNotIn("iteration_started", event_types)
        self.assertIn("scorer_contract_check_failed", event_types)
        self.assertEqual(sink.finished["status"], "failed")

    def test_flat_row_adapter_makes_the_same_judge_usable(self):
        # Green path for the official adapter: same judge bytes, adapter
        # selected at launch — the seed scores sanely and the run completes.
        sink = FakeSink()
        with tempfile.TemporaryDirectory() as temp_dir:
            judge_dir = Path(temp_dir) / "judge"
            write_flat_row_judge(judge_dir)
            scorer_runner = make_scorer_runner(
                judge_dir,
                None,
                input_contract="flat_row",
                candidate_field="draft",
            )

            result = self.optimize(scorer_runner, sink=sink)

        self.assertEqual(result.seed_score, 1.0)
        self.assertEqual(sink.finished["status"], "succeeded")

    def test_manifest_can_declare_flat_row_contract_and_candidate_field(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            judge_dir = Path(temp_dir) / "judge"
            write_flat_row_judge(judge_dir)
            manifest = json.loads((judge_dir / "manifest.json").read_text())
            manifest["scorer_input_contract"] = "flat_row"
            manifest["candidate_output_field"] = "draft"
            (judge_dir / "manifest.json").write_text(json.dumps(manifest))

            scorer_runner = make_scorer_runner(judge_dir, None)
            result = scorer_runner(
                ROWS[0],
                RunnerCallResult(model_response="Hey there!"),
                scorer_context(),
                "seed",
            )

        self.assertEqual(result.extra.get("score"), 1.0)

    def test_flat_row_payload_shape_mirrors_score_run_exec(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            judge_dir = Path(temp_dir) / "judge"
            write_echo_judge(judge_dir)
            scorer_runner = make_scorer_runner(
                judge_dir,
                None,
                input_contract="flat_row",
                candidate_field="draft",
            )
            result = scorer_runner(
                ROWS[0],
                RunnerCallResult(model_response="Hey there!", error=None),
                scorer_context(),
                "candidate-7",
            )

        seen = result.model_response["seen_input"]
        # The row is the FLAT dataset row with the candidate output injected.
        self.assertEqual(seen["row"]["brief"], "say hi")
        self.assertEqual(seen["row"]["draft"], "Hey there!")
        self.assertNotIn("source_row", seen["row"])
        # The score-run top-level companions are present.
        self.assertEqual(seen["model_output"], "Hey there!")
        self.assertEqual(seen["subject"]["type"], "scorer_row")
        self.assertEqual(seen["subject"]["row_id"], "row-1")
        self.assertEqual(seen["scorer"]["metric_key"], "style_match")
        self.assertTrue(seen["scorer"]["higher_is_better"])
        # GEPA provenance stays available without polluting the row.
        self.assertEqual(seen["gepa"]["candidate_id"], "candidate-7")

    def test_default_contract_remains_gepa_shaped(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            judge_dir = Path(temp_dir) / "judge"
            write_echo_judge(judge_dir)
            scorer_runner = make_scorer_runner(judge_dir, None)
            result = scorer_runner(
                ROWS[0],
                RunnerCallResult(model_response="Hey there!"),
                scorer_context(),
                "candidate-7",
            )

        seen = result.model_response["seen_input"]
        self.assertEqual(seen["row"]["source_row"], ROWS[0].row)
        self.assertEqual(seen["row"]["candidate_output"], "Hey there!")
        self.assertNotIn("model_output", seen)

    def test_candidate_field_under_gepa_contract_is_refused_not_ignored(self):
        # Review item 6 (ALI-1158): --scorer-candidate-field only means
        # something under flat_row. Silently ignoring it under the default
        # gepa contract would recreate the exact silent-no-op class this
        # ticket fixes, so it must refuse loudly at launch.
        with tempfile.TemporaryDirectory() as temp_dir:
            judge_dir = Path(temp_dir) / "judge"
            write_echo_judge(judge_dir)
            with self.assertRaisesRegex(RuntimeError, "--scorer-input-contract flat_row"):
                make_scorer_runner(judge_dir, None, candidate_field="draft")

    def test_manifest_candidate_field_without_flat_row_contract_is_refused(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            judge_dir = Path(temp_dir) / "judge"
            write_echo_judge(judge_dir, manifest_extra={"candidate_output_field": "draft"})
            with self.assertRaisesRegex(RuntimeError, "candidate_output_field"):
                make_scorer_runner(judge_dir, None)

    def test_flat_row_adapter_propagates_candidate_error_into_the_row(self):
        # Review item 4 (ALI-1158): a candidate that errored during
        # generation must not be judged as if it produced an empty draft —
        # the flat row carries candidate_error first-class, like the gepa
        # contract does.
        with tempfile.TemporaryDirectory() as temp_dir:
            judge_dir = Path(temp_dir) / "judge"
            write_echo_judge(judge_dir)
            scorer_runner = make_scorer_runner(
                judge_dir,
                None,
                input_contract="flat_row",
                candidate_field="draft",
            )
            result = scorer_runner(
                ROWS[0],
                RunnerCallResult(model_response=None, error="candidate exploded"),
                scorer_context(),
                "candidate-7",
            )

        seen = result.model_response["seen_input"]
        self.assertEqual(seen["row"]["candidate_error"], "candidate exploded")
        self.assertEqual(seen["gepa"]["candidate_error"], "candidate exploded")

    def test_unknown_scorer_input_contract_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            judge_dir = Path(temp_dir) / "judge"
            write_echo_judge(judge_dir)
            with self.assertRaisesRegex(RuntimeError, "flat_row"):
                make_scorer_runner(judge_dir, None, input_contract="nonsense")

    def test_empty_manifest_contract_is_rejected_not_defaulted(self):
        # ALI-1158 review (codex): a falsey manifest value must fail loudly,
        # not silently fall back to the default contract.
        with tempfile.TemporaryDirectory() as temp_dir:
            judge_dir = Path(temp_dir) / "judge"
            write_echo_judge(judge_dir, manifest_extra={"scorer_input_contract": ""})
            with self.assertRaisesRegex(RuntimeError, "Unknown scorer input contract"):
                make_scorer_runner(judge_dir, None)

    def test_candidate_error_is_a_reserved_candidate_field(self):
        # ALI-1158 review (codex round 6): the adapter injects candidate_error
        # after the output — naming it as the output field would hand the
        # judge the error instead of the draft.
        with tempfile.TemporaryDirectory() as temp_dir:
            judge_dir = Path(temp_dir) / "judge"
            write_echo_judge(judge_dir, manifest_extra={
                "scorer_input_contract": "flat_row",
                "candidate_output_field": "candidate_error",
            })
            with self.assertRaisesRegex(RuntimeError, "reserved"):
                make_scorer_runner(judge_dir, None)

    def test_empty_manifest_candidate_field_is_rejected_not_defaulted(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            judge_dir = Path(temp_dir) / "judge"
            write_echo_judge(judge_dir, manifest_extra={
                "scorer_input_contract": "flat_row",
                "candidate_output_field": "",
            })
            with self.assertRaisesRegex(RuntimeError, "non-empty string"):
                make_scorer_runner(judge_dir, None)

    def test_allow_degenerate_seed_opts_out_of_the_refusal(self):
        def zero_scorer(row, candidate_result, context, candidate_id):
            return RunnerCallResult(model_response={"score": 0.0, "feedback": "bad"})

        sink = FakeSink()
        result = self.optimize(
            zero_scorer,
            config=TextGepaConfig(
                max_iterations=1,
                minibatch_size=2,
                allow_degenerate_seed=True,
            ),
            sink=sink,
        )
        self.assertEqual(result.seed_score, 0.0)
        self.assertEqual(sink.finished["status"], "succeeded")

    def test_partially_zero_seed_is_a_legitimate_score(self):
        def mixed_scorer(row, candidate_result, context, candidate_id):
            score = 0.0 if row.id == "row-1" else 0.6
            return RunnerCallResult(model_response={"score": score, "feedback": "mixed"})

        sink = FakeSink()
        result = self.optimize(mixed_scorer, sink=sink)
        self.assertAlmostEqual(result.seed_score, 0.3)
        self.assertEqual(sink.finished["status"], "succeeded")

    def test_lower_is_better_uniform_worst_seed_is_refused(self):
        def worst_scorer(row, candidate_result, context, candidate_id):
            return RunnerCallResult(model_response={"score": 1.0, "feedback": "worst"})

        with self.assertRaises(ScorerContractError) as caught:
            self.optimize(worst_scorer, scorer=scorer_context(higher_is_better=False))
        self.assertIn("contract", str(caught.exception).lower())

    def test_all_seed_rows_erroring_is_refused_even_with_nonzero_scores(self):
        def errored_scorer(row, candidate_result, context, candidate_id):
            return RunnerCallResult(
                model_response={"score": 0.4, "feedback": "partial"},
                error="judge provider exploded",
            )

        with self.assertRaises(ScorerContractError) as caught:
            self.optimize(errored_scorer)
        self.assertIn("contract", str(caught.exception).lower())

    def test_unparseable_scorer_output_fails_with_contract_guidance_at_seed(self):
        def text_scorer(row, candidate_result, context, candidate_id):
            return RunnerCallResult(model_response="I liked it")

        with self.assertRaises(ScorerContractError) as caught:
            self.optimize(text_scorer)
        message = str(caught.exception)
        self.assertIn("numeric score", message)
        self.assertIn("--scorer-input-contract", message)

    def test_seed_crash_refusal_emits_contract_check_event(self):
        # ALI-1158 review (codex): crash/unparseable refusals must leave the
        # same structured event the degenerate-seed path does, not just the
        # generic outer run_failed.
        def text_scorer(row, candidate_result, context, candidate_id):
            return RunnerCallResult(model_response="I liked it")

        sink = FakeSink()
        with self.assertRaises(ScorerContractError):
            self.optimize(text_scorer, sink=sink)
        contract_events = [
            event for event in sink.events
            if event["event_type"] == "scorer_contract_check_failed"
        ]
        self.assertEqual(len(contract_events), 1)
        self.assertIn("unparseable", contract_events[0]["payload"]["reason"])

    def test_all_candidate_errors_blame_the_candidate_runner_not_the_scorer(self):
        # ALI-1158 review (codex): a candidate runner that fails on every row
        # must not be diagnosed as a scorer-contract mismatch.
        def failing_candidate(candidate_text, row, context, candidate_id):
            return RunnerCallResult(model_response=None, error="candidate provider exploded")

        def healthy_scorer(row, candidate_result, context, candidate_id):
            return RunnerCallResult(model_response={"score": 0.4, "feedback": "partial"})

        sink = FakeSink()
        # Codex round 4: the exception CLASS and event TYPE must not blame the
        # scorer for a candidate-side degenerate seed either.
        with self.assertRaises(RuntimeError) as caught:
            optimize_loaded_text_candidate(
                run_id="run-1",
                prompt_context=prompt_context(),
                scorer_context=scorer_context(),
                trainset=list(ROWS),
                valset=list(ROWS),
                candidate_runner=failing_candidate,
                scorer_runner=healthy_scorer,
                reflector=lambda parent_text, parent_results, config: ReflectionResult(
                    prompt="reflection prompt",
                    response="rewritten prompt",
                    candidate_text="rewritten prompt",
                ),
                event_sink=sink,
                config=TextGepaConfig(max_iterations=1, minibatch_size=2),
            )
        message = str(caught.exception)
        self.assertIn("CANDIDATE runner", message)
        self.assertNotIn("--scorer-input-contract", message)
        self.assertNotIsInstance(caught.exception, ScorerContractError)
        event_types = [event["event_type"] for event in sink.events]
        self.assertIn("seed_validation_failed", event_types)
        self.assertNotIn("scorer_contract_check_failed", event_types)

    def test_candidate_runner_raise_is_not_diagnosed_as_scorer_contract(self):
        # ALI-1158 review (codex round 3): a candidate runner that RAISES
        # (missing dep, subprocess exit) during the seed pass must not get
        # scorer-contract guidance either.
        def raising_candidate(candidate_text, row, context, candidate_id):
            raise RuntimeError("candidate subprocess exited 1")

        sink = FakeSink()
        with self.assertRaises(RuntimeError) as caught:
            optimize_loaded_text_candidate(
                run_id="run-1",
                prompt_context=prompt_context(),
                scorer_context=scorer_context(),
                trainset=list(ROWS),
                valset=list(ROWS),
                candidate_runner=raising_candidate,
                scorer_runner=lambda row, candidate_result, context, candidate_id: RunnerCallResult(
                    model_response={"score": 0.5, "feedback": "ok"}
                ),
                reflector=lambda parent_text, parent_results, config: ReflectionResult(
                    prompt="reflection prompt",
                    response="rewritten prompt",
                    candidate_text="rewritten prompt",
                ),
                event_sink=sink,
                config=TextGepaConfig(max_iterations=1, minibatch_size=2),
            )
        message = str(caught.exception)
        self.assertIn("CANDIDATE runner", message)
        self.assertNotIn("--scorer-input-contract", message)
        self.assertNotIsInstance(caught.exception, ScorerContractError)
        candidate_events = [
            event for event in sink.events
            if event["event_type"] == "seed_validation_failed"
        ]
        self.assertEqual(len(candidate_events), 1)
        self.assertEqual(candidate_events[0]["payload"]["source"], "candidate_runner")

    def test_soft_candidate_failure_plus_scorer_crash_blames_the_candidate(self):
        # ALI-1158 review (codex round 5): candidate fails SOFTLY (error
        # field), scorer then chokes on the null output — root cause is the
        # candidate, not the scorer contract.
        def soft_failing_candidate(candidate_text, row, context, candidate_id):
            return RunnerCallResult(model_response=None, error="provider 500")

        def choking_scorer(row, candidate_result, context, candidate_id):
            raise ValueError(f"cannot score {candidate_result.model_response['text']}")

        sink = FakeSink()
        with self.assertRaises(RuntimeError) as caught:
            optimize_loaded_text_candidate(
                run_id="run-1",
                prompt_context=prompt_context(),
                scorer_context=scorer_context(),
                trainset=list(ROWS),
                valset=list(ROWS),
                candidate_runner=soft_failing_candidate,
                scorer_runner=choking_scorer,
                reflector=lambda parent_text, parent_results, config: ReflectionResult(
                    prompt="reflection prompt",
                    response="rewritten prompt",
                    candidate_text="rewritten prompt",
                ),
                event_sink=sink,
                config=TextGepaConfig(max_iterations=1, minibatch_size=2),
            )
        message = str(caught.exception)
        self.assertIn("CANDIDATE runner", message)
        self.assertNotIn("--scorer-input-contract", message)
        self.assertNotIsInstance(caught.exception, ScorerContractError)
        self.assertIn(
            "seed_validation_failed",
            [event["event_type"] for event in sink.events],
        )

    def test_scorer_io_failure_at_seed_gets_contract_diagnosis(self):
        # Codex round 4: a scorer subprocess that dies without output.json
        # raises FileNotFoundError/OSError — those must reach the contract
        # diagnosis, not just the generic run_failed.
        def io_failing_scorer(row, candidate_result, context, candidate_id):
            raise FileNotFoundError("output.json was never produced")

        sink = FakeSink()
        with self.assertRaises(ScorerContractError) as caught:
            self.optimize(io_failing_scorer, sink=sink)
        self.assertIn("--scorer-input-contract", str(caught.exception))
        self.assertIn(
            "scorer_contract_check_failed",
            [event["event_type"] for event in sink.events],
        )

    def test_lower_is_better_uniform_zero_seed_is_refused(self):
        # ALI-1158 review (codex round 3): under lower-is-better, a silent
        # wrong-shape zero is the PERFECT bound — it must not pass validation
        # as a flawless seed.
        def zero_scorer(row, candidate_result, context, candidate_id):
            return RunnerCallResult(model_response={"score": 0.0, "feedback": "silent zero"})

        with self.assertRaises(ScorerContractError) as caught:
            self.optimize(
                zero_scorer,
                scorer=scorer_context(higher_is_better=False),
            )
        self.assertIn("lower-is-better", str(caught.exception))

    def test_lower_is_better_uniform_zero_opt_out_still_works(self):
        def zero_scorer(row, candidate_result, context, candidate_id):
            return RunnerCallResult(model_response={"score": 0.0, "feedback": "silent zero"})

        result = self.optimize(
            zero_scorer,
            scorer=scorer_context(higher_is_better=False),
            config=TextGepaConfig(
                max_iterations=1, minibatch_size=2, allow_degenerate_seed=True
            ),
        )
        self.assertIsNotNone(result)


if __name__ == "__main__":
    unittest.main()
