from __future__ import annotations

import ast
from dataclasses import fields
import os
import sys
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from gepa import optimize
from gepa.core.adapter import EvaluationBatch
from gepa.core.callbacks import (
    BudgetUpdatedEvent,
    MergeAttemptedEvent,
    ProposalEndEvent,
    ValsetEvaluatedEvent,
)

from orizu_gepa.client import OrizuClient
from orizu_gepa.optimizer import Budget, DatasetRow, PromptContext, RowEvaluation
from orizu_gepa.optimizer import TextGepaConfig
from orizu_gepa.local_log import LocalOptimizationLogger
from orizu_gepa.reflection import ReflectionProviderError, RetryableReflectionProviderError
from orizu_gepa_connector.adapter import RunnerEvaluationAdapter, ScorerContractError
from orizu_gepa_connector.callbacks import LifecycleHooks, OrizuCallback
from orizu_gepa_connector.engine import SeedValidationRefused, run_official_gepa
from orizu_gepa_connector.preflight import validate_seed_and_scorer
from orizu_gepa_connector.runtime import MandatoryEventSink, build_config_from_environment, require_durable_logging, run_from_environment
import orizu_gepa_connector.runtime as runtime
from orizu_gepa_connector.reflection import make_gepa_reflection_lm
from orizu_gepa_connector.stop_conditions import IterationBoundaryStopper
from orizu_gepa_connector.translator import translate_callback


# This is an independent literal from the legacy envelope in
# packages/orizu-gepa-python/src/orizu_gepa/client.py:225-237 and the MUST
# checklist in current-observability-inventory.md:577-662.
RUN_ID = "real-gepa-red-run"
REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
SYNTHETIC_REPLAY = json.loads((Path(__file__).parent / "fixtures" / "official-gepa-reflection-replay.json").read_text())

# Independently audited from every ``config.<attribute>`` use in the frozen
# provider transport. Keep this literal exact so a new transport read must be
# reviewed as a connector-config contract change.
FROZEN_REFLECTION_CONFIG_ATTRIBUTES = frozenset({
    "reflection_http_timeout_seconds",
    "reflection_max_tokens",
    "reflection_model",
    "reflection_provider_settings",
    "reflection_retry_attempts",
    "reflection_temperature",
})


def dispatched_synthetic_official_environment() -> dict[str, str]:
    """Run the production dispatcher, rather than reconstructing its env by hand."""
    script = """
import { dispatchGepaEngine } from './packages/cli/src/gepa-engine-dispatch.ts'
const args = JSON.parse(process.env.ORIZU_SYNTHETIC_PARITY_ARGS)
const dispatch = dispatchGepaEngine(args, 'synthetic-team/synthetic-project', {})
process.stdout.write(JSON.stringify(dispatch.environment))
"""
    result = subprocess.run(
        ["bun", "-e", script],
        cwd=REPOSITORY_ROOT,
        env={**os.environ, "ORIZU_SYNTHETIC_PARITY_ARGS": json.dumps(SYNTHETIC_REPLAY["argv"])},
        check=True,
        capture_output=True,
        text=True,
    )
    environment = json.loads(result.stdout)
    return {str(name): str(value) for name, value in environment.items()}


class DeterministicAdapter:
    """Our permitted adapter seam: GEPA itself owns the optimization loop."""

    def evaluate(self, batch, candidate, capture_traces=False):
        candidate_text = candidate.get("prompt", next(iter(candidate.values())))
        score = 1.0 if all(value == "better" for value in candidate.values()) else 0.2
        trajectories = ([{"feedback": "Use better", "row_id": row["id"]} for row in batch]
                        if capture_traces else None)
        return EvaluationBatch(
            outputs=[{"answer": candidate_text, "row_id": row["id"]} for row in batch],
            scores=[score for _ in batch],
            trajectories=trajectories,
            num_metric_calls=len(batch),
        )

    def make_reflective_dataset(self, candidate, eval_batch, components_to_update):
        return {
            component: [{"Feedback": "Use better", "Scores (Higher is Better)": eval_batch.scores}]
            for component in components_to_update
        }

    def propose_new_texts(self, candidate, reflective_dataset, components_to_update):
        return {component: "better" for component in components_to_update}


class SkilledProposerBridgeImportTests(unittest.TestCase):
    def test_bridge_module_imports_without_dspy_and_names_use_refusal(self):
        """Kills a connector import that turns the optional DSPy dependency into a CI/runtime requirement."""
        script = """
import builtins
import importlib

real_import = builtins.__import__
def blocked_dspy(name, globals=None, locals=None, fromlist=(), level=0):
    if name == 'dspy' or name.startswith('dspy.'):
        raise ModuleNotFoundError("No module named 'dspy'", name='dspy')
    return real_import(name, globals, locals, fromlist, level)

builtins.__import__ = blocked_dspy
bridge = importlib.import_module('orizu_gepa_connector.skilled_proposer_bridge')
from orizu_gepa.optimizer import TextGepaConfig
observability = bridge.ProposalObservability.local_for_test()
try:
    bridge.make_skilled_proposer_bridge(
        config=TextGepaConfig(),
        observability=observability,
        budget=bridge.ProposalCallBudget(),
    )
except RuntimeError as error:
    assert str(error) == 'ALI_1505_DSPY_UNAVAILABLE', str(error)
else:
    raise AssertionError('expected ALI_1505_DSPY_UNAVAILABLE')
print('lazy bridge import verified')
"""
        result = subprocess.run(
            [sys.executable, "-c", script],
            cwd=REPOSITORY_ROOT,
            env=dict(os.environ),
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


class CapturingCallback:
    def __init__(self):
        self.events = []

    def on_budget_updated(self, event):
        self.events.append(("on_budget_updated", event))

    def on_iteration_end(self, event):
        self.events.append(("on_iteration_end", event))


class RecordingClient:
    def __init__(self):
        self.events = []

    def log_event(self, run_id, **event):
        self.events.append({"run_id": run_id, **event})

    def update_run(self, *args, **kwargs):
        raise AssertionError("a successful run_note must not patch failure")


class RecordingSink:
    def __init__(self):
        self.sequence = 0
        self.events = []

    def emit(self, event_type, payload, **envelope):
        self.sequence += 1
        self.events.append({"event_type": event_type, "payload": payload, **envelope})

    def run_note(self, note):
        self.emit("run_note", note["payload"])


class ZeroSeedAdapter:
    def evaluate(self, batch, candidate, capture_traces=False):
        return EvaluationBatch(outputs=[], scores=[0.0 for _ in batch], trajectories=[], num_metric_calls=len(batch))


class RecordedPreflightAdapter:
    """Real preflight boundary shape, including runner/scorer diagnostics."""

    def __init__(self, *, scores, outputs):
        self.scores = scores
        self.outputs = outputs
        self.metric_calls_used = len(scores)

    def evaluate(self, batch, candidate, capture_traces=False):
        return EvaluationBatch(
            outputs=self.outputs,
            scores=self.scores,
            trajectories=[] if capture_traces else None,
            num_metric_calls=len(self.scores),
        )


class ReflectionOnlyAdapter:
    """Deterministic adapter that makes the real GEPA reflection path active."""

    propose_new_texts = None

    def evaluate(self, batch, candidate, capture_traces=False):
        score = 1.0 if candidate["prompt"] == "better" else 0.2
        trajectories = ([{"Feedback": "Use better", "row_id": row["id"]} for row in batch]
                        if capture_traces else None)
        return EvaluationBatch(
            outputs=[{"answer": candidate["prompt"], "row_id": row["id"]} for row in batch],
            scores=[score for _ in batch],
            trajectories=trajectories,
            num_metric_calls=len(batch),
        )

    def make_reflective_dataset(self, candidate, eval_batch, components_to_update):
        return {
            component: [{"Feedback": "Use better", "Scores (Higher is Better)": eval_batch.scores}]
            for component in components_to_update
        }


class DurableRecordingClient:
    """The real mandatory sink, backed by a no-network client boundary."""

    def __init__(self):
        self.events = []
        self.notes = []

    def log_event(self, run_id, **event):
        self.events.append({"run_id": run_id, **event})

    def update_run(self, run_id, **kwargs):
        self.notes.append({"run_id": run_id, **kwargs})


class OfficialGepaEngineRedContracts(unittest.TestCase):
    def test_runtime_launches_the_shape_ordered_tuple_through_the_real_engine_boundary(self):
        """Mutants killed: ignore profile/tuple/settings/runner declaration, budget one component, or drop GEPA's selector."""
        instruction_set = {
            "name": "planner", "shape": ["tools", "system"],
            "profile_version_id": "15350000-0000-4000-8000-000000000002",
            "model_config_settings_version_id": "15360000-0000-4000-8000-000000000001",
            "components": {"tools": "Tools bytes\n", "system": "System bytes\n"},
            "pinned_components": {},
        }
        prompt_context = PromptContext(
            body=None, body_kind="text", provider_settings={"model": "gpt-5.4"},
            prompt_version_id="prompt-version-1", runner_version_id="runner-version-1",
            instruction_set=instruction_set, body_present=False,
        )
        scorer_context = PromptContext(
            body="score", body_kind="text", provider_settings={"model": "gpt-5.4"},
            prompt_version_id="scorer-prompt", runner_version_id="runner-version-1",
            scorer_version_id="scorer-version-1",
        )
        client = DurableRecordingClient()
        client.fetch_exec_context = MagicMock(side_effect=[(prompt_context, [{"id": "train"}]), (prompt_context, [{"id": "validation"}])])
        client.fetch_scorer_exec_context = MagicMock(return_value=(scorer_context, []))
        client.start_run = MagicMock(return_value=RUN_ID)
        adapter = MagicMock()
        adapter.last_candidate = {"tools": "better tools", "system": "better system"}
        adapter.last_row_evaluations = []
        adapter.num_threads_plan.to_payload.return_value = {"requested": 1, "effective": 1}
        local_logger = MagicMock()
        budget = Budget("max_metric_calls", 10, 10)
        result = SimpleNamespace(best_idx=0, val_aggregate_scores=[0.5], total_metric_calls=1,
                                 candidates=[{"tools": "better tools", "system": "better system"}], num_full_val_evals=1)
        env = {
            "ORIZU_PROJECT": "team/project", "ORIZU_OPTIMIZER_VERSION_ID": "optimizer-version-1",
            "ORIZU_PROMPT_VERSION_ID": "prompt-version-1", "ORIZU_DATASET_VERSION_ID": "dataset-version-1",
            "ORIZU_SPLIT_SET_ID": "split-set-1", "ORIZU_SCORER_VERSION_ID": "scorer-version-1",
            "ORIZU_RUNNER_VERSION_ID": "runner-version-1", "ORIZU_CANDIDATE_RUNNER_DIR": "/candidate",
            "ORIZU_SCORER_RUNNER_DIR": "/scorer", "ORIZU_INSTRUCTION_SET_PROFILE_VERSION_ID": instruction_set["profile_version_id"],
            "ORIZU_COMPONENT_SELECTOR": "round-robin",
            "ORIZU_VERIFIED_RUNNER_DIRS": "[\"/candidate\", \"/scorer\"]",
        }
        with patch.dict(os.environ, env, clear=True), \
             patch.object(runtime.OrizuClient, "from_env", return_value=client), \
             patch.object(runtime, "build_config_from_environment", return_value=TextGepaConfig(reflection_model="openai/test", reflection_max_tokens=1)), \
             patch.object(runtime, "resolve_scorer_input_contract", return_value=("candidate", "candidate")), \
             patch.object(runtime, "RunnerEvaluationAdapter", return_value=adapter), \
             patch.object(runtime, "validate_seed_before_run", return_value={"preflight_metric_calls": 0}), \
             patch.object(runtime, "resolved_budget", return_value=budget) as resolve_budget, \
             patch.object(runtime, "create_local_logger_from_environment", return_value=local_logger), \
             patch.object(runtime, "make_gepa_reflection_lm") as make_reflection_lm, \
             patch.object(runtime, "run_official_gepa", return_value=result) as run_engine:
            runtime.run_from_environment()

        self.assertEqual(client.fetch_exec_context.call_args_list[0].kwargs["instruction_set_profile_version_id"], instruction_set["profile_version_id"])
        self.assertEqual(run_engine.call_args.kwargs["seed_candidate"], {"tools": "Tools bytes\n", "system": "System bytes\n"})
        self.assertEqual(list(run_engine.call_args.kwargs["seed_candidate"]), ["tools", "system"])
        self.assertEqual(client.start_run.call_args.kwargs["model_config_settings_version_id"], instruction_set["model_config_settings_version_id"])
        self.assertEqual(client.start_run.call_args.kwargs["runner_version_id"], "runner-version-1")
        self.assertIsNone(client.start_run.call_args.kwargs["prompt_version_id"])
        self.assertEqual(
            client.start_run.call_args.kwargs["instruction_set_profile_version_id"],
            instruction_set["profile_version_id"],
        )
        self.assertEqual(resolve_budget.call_args.kwargs["num_components"], 2)
        self.assertEqual(run_engine.call_args.kwargs["module_selector"], "round_robin")
        self.assertEqual(make_reflection_lm.call_args.kwargs["context_supplier"]()[0], adapter.last_candidate)
        self.assertEqual(local_logger.write_result.call_args.args[0].best_candidate_text, result.candidates[0])

    def test_reflection_bridge_reflects_the_selected_tuple_component_not_a_rendered_map(self):
        """Mutant killed: pass the whole tuple JSON to the vendor reflection provider."""
        captured: list[str] = []
        reflection_lm = make_gepa_reflection_lm(
            context_supplier=lambda: ({"tools": "Tools bytes", "system": "System bytes"}, []),
            config=TextGepaConfig(reflection_model="openai/test", reflection_max_tokens=1),
        )
        import orizu_gepa_connector.reflection as reflection
        with patch.object(reflection, "reflect_with_provider", side_effect=lambda parent_text, *_args: (
            captured.append(parent_text) or SimpleNamespace(
                response="better", prompt="provider prompt", usage={"input_tokens": 1, "output_tokens": 1, "total_tokens": 2},
            )
        )):
            proposal, _ = reflection_lm.reflect(
                {"tools": "Tools bytes", "system": "System bytes"}, {}, ["system"]
            )
        self.assertEqual(proposal.new_texts, {"system": "better"})
        self.assertEqual(captured, ["System bytes"])

    def test_reflection_bridge_keeps_a_set_of_one_candidate_as_the_legacy_bare_value(self):
        """Mutant killed: JSON-serialize every candidate map before provider reflection."""
        captured: list[str] = []
        reflection_lm = make_gepa_reflection_lm(
            context_supplier=lambda: ({"prompt": "Legacy prompt bytes\n"}, []),
            config=TextGepaConfig(reflection_model="openai/test", reflection_max_tokens=1),
        )
        import orizu_gepa_connector.reflection as reflection
        with patch.object(reflection, "reflect_with_provider", side_effect=lambda parent_text, *_args: (
            captured.append(parent_text) or SimpleNamespace(
                response="better", prompt="provider prompt", usage={"input_tokens": 1, "output_tokens": 1, "total_tokens": 2},
            )
        )):
            proposal, _ = reflection_lm.reflect({"prompt": "Legacy prompt bytes\n"}, {}, ["prompt"])
        self.assertEqual(proposal.new_texts, {"prompt": "better"})
        self.assertEqual(captured, ["Legacy prompt bytes\n"])

    def test_required_environment_allows_an_explicit_instruction_set_without_a_prompt_id(self):
        """Mutant Q1 killed: require ORIZU_PROMPT_VERSION_ID even on the explicit tuple path."""
        env = {
            "ORIZU_PROJECT": "team/project", "ORIZU_OPTIMIZER_VERSION_ID": "optimizer-version-1",
            "ORIZU_DATASET_VERSION_ID": "dataset-version-1", "ORIZU_SPLIT_SET_ID": "split-set-1",
            "ORIZU_SCORER_VERSION_ID": "scorer-version-1", "ORIZU_RUNNER_VERSION_ID": "runner-version-1",
            "ORIZU_CANDIDATE_RUNNER_DIR": "/candidate", "ORIZU_SCORER_RUNNER_DIR": "/scorer",
            "ORIZU_INSTRUCTION_SET_PROFILE_VERSION_ID": "profile-version-1",
        }
        with patch.dict(os.environ, env, clear=True):
            self.assertNotIn("ORIZU_PROMPT_VERSION_ID", runtime._required_environment())

    def test_required_environment_refuses_a_legacy_launch_without_a_prompt_id(self):
        """Mutant Q1 killed: allow a legacy launch to reach the connector with no prompt id."""
        env = {
            "ORIZU_PROJECT": "team/project", "ORIZU_OPTIMIZER_VERSION_ID": "optimizer-version-1",
            "ORIZU_DATASET_VERSION_ID": "dataset-version-1", "ORIZU_SPLIT_SET_ID": "split-set-1",
            "ORIZU_SCORER_VERSION_ID": "scorer-version-1", "ORIZU_RUNNER_VERSION_ID": "runner-version-1",
            "ORIZU_CANDIDATE_RUNNER_DIR": "/candidate", "ORIZU_SCORER_RUNNER_DIR": "/scorer",
        }
        with patch.dict(os.environ, env, clear=True):
            with self.assertRaisesRegex(RuntimeError, "missing connector environment: ORIZU_PROMPT_VERSION_ID"):
                runtime._required_environment()

    def test_client_omits_prompt_version_query_parameter_for_an_explicit_instruction_set(self):
        """Mutant Q2 killed: serialize promptVersion=None into the exec-context request."""
        response = {"prompt": {"body": None, "bodyKind": "text", "promptVersionId": "prompt", "runnerVersionId": "runner"}, "rows": []}
        with patch.object(OrizuClient, "_request", return_value=response) as request:
            client = OrizuClient(api_url="https://example.invalid", token="test")
            client.fetch_exec_context(
                prompt_version_id=None, runner_version_id="runner", dataset_version_id="dataset",
                split_set_id="split-set", split="train", instruction_set_profile_version_id="profile",
            )
        self.assertNotIn("promptVersion=", request.call_args.args[1])

    def test_runtime_names_an_incomplete_tuple_refusal_before_engine_launch(self):
        """Mutant killed: translate the route's 409 tuple failure into a generic connector crash."""
        client = DurableRecordingClient()
        client.fetch_exec_context = MagicMock(side_effect=RuntimeError("GET /api/cli/runners/exec-context failed: 409 {\"error\":\"instruction_set_tuple_incomplete: tools\"}"))
        env = {
            "ORIZU_PROJECT": "team/project", "ORIZU_OPTIMIZER_VERSION_ID": "optimizer-version-1",
            "ORIZU_PROMPT_VERSION_ID": "prompt-version-1", "ORIZU_DATASET_VERSION_ID": "dataset-version-1",
            "ORIZU_SPLIT_SET_ID": "split-set-1", "ORIZU_SCORER_VERSION_ID": "scorer-version-1",
            "ORIZU_RUNNER_VERSION_ID": "runner-version-1", "ORIZU_CANDIDATE_RUNNER_DIR": "/candidate",
            "ORIZU_SCORER_RUNNER_DIR": "/scorer", "ORIZU_INSTRUCTION_SET_PROFILE_VERSION_ID": "profile-version-1",
        }
        with patch.dict(os.environ, env, clear=True), patch.object(runtime.OrizuClient, "from_env", return_value=client), \
             patch.object(runtime, "build_config_from_environment", return_value=TextGepaConfig(reflection_model="openai/test", reflection_max_tokens=1)), \
             patch.object(runtime, "run_official_gepa") as run_engine:
            with self.assertRaisesRegex(RuntimeError, "instruction_set_tuple_incomplete: tools"):
                runtime.run_from_environment()
        run_engine.assert_not_called()

    def test_runtime_refuses_a_shape_mismatch_before_start_run(self):
        """Mutant killed: bypass the real launch guard and optimize a partial tuple."""
        prompt_context = PromptContext(
            body=None, body_kind="text", provider_settings={"model": "gpt-5.4"},
            prompt_version_id="prompt-version-1", runner_version_id="runner-version-1",
            instruction_set={"shape": ["system", "tools"], "components": {"system": "System bytes\n"}, "pinned_components": {}},
            body_present=False,
        )
        client = DurableRecordingClient()
        client.fetch_exec_context = MagicMock(return_value=(prompt_context, []))
        client.fetch_scorer_exec_context = MagicMock(return_value=(PromptContext(
            body="score", body_kind="text", provider_settings={"model": "gpt-5.4"},
            prompt_version_id="scorer-prompt", runner_version_id="runner-version-1", scorer_version_id="scorer-version-1",
        ), []))
        client.start_run = MagicMock(return_value=RUN_ID)
        adapter = MagicMock()
        adapter.num_threads_plan.to_payload.return_value = {"requested": 1, "effective": 1}
        result = SimpleNamespace(best_idx=0, val_aggregate_scores=[0.5], total_metric_calls=1,
                                 candidates=[{"system": "better system"}], num_full_val_evals=1)
        env = {
            "ORIZU_PROJECT": "team/project", "ORIZU_OPTIMIZER_VERSION_ID": "optimizer-version-1",
            "ORIZU_PROMPT_VERSION_ID": "prompt-version-1", "ORIZU_DATASET_VERSION_ID": "dataset-version-1",
            "ORIZU_SPLIT_SET_ID": "split-set-1", "ORIZU_SCORER_VERSION_ID": "scorer-version-1",
            "ORIZU_RUNNER_VERSION_ID": "runner-version-1", "ORIZU_CANDIDATE_RUNNER_DIR": "/candidate",
            "ORIZU_SCORER_RUNNER_DIR": "/scorer", "ORIZU_INSTRUCTION_SET_PROFILE_VERSION_ID": "profile-version-1",
            "ORIZU_VERIFIED_RUNNER_DIRS": "[\"/candidate\", \"/scorer\"]",
        }
        with patch.dict(os.environ, env, clear=True), patch.object(runtime.OrizuClient, "from_env", return_value=client), \
             patch.object(runtime, "build_config_from_environment", return_value=TextGepaConfig(reflection_model="openai/test", reflection_max_tokens=1)), \
             patch.object(runtime, "resolve_scorer_input_contract", return_value=("candidate", "candidate")), \
             patch.object(runtime, "RunnerEvaluationAdapter", return_value=adapter), \
             patch.object(runtime, "validate_seed_before_run", return_value={"preflight_metric_calls": 0}), \
             patch.object(runtime, "resolved_budget", return_value=Budget("max_metric_calls", 10, 10)), \
             patch.object(runtime, "create_local_logger_from_environment", return_value=None), \
             patch.object(runtime, "run_official_gepa", return_value=result):
            with self.assertRaisesRegex(RuntimeError, "instruction_set_tuple_shape_mismatch: tools"):
                runtime.run_from_environment()
        client.start_run.assert_not_called()

    def test_runtime_refuses_pinned_tuple_before_start_run(self):
        """Mutant killed: omit pinned components when the real launch guard sees the tuple."""
        prompt_context = PromptContext(
            body=None, body_kind="text", provider_settings={"model": "gpt-5.4"},
            prompt_version_id="prompt-version-1", runner_version_id="runner-version-1",
            instruction_set={"shape": ["system", "tools"], "components": {"system": "System bytes\n"},
                             "pinned_components": {"tools": {"repoPath": "skills/tools.md", "contentSha": "a" * 64, "commitSha": "b" * 40}}},
            body_present=False,
        )
        client = DurableRecordingClient()
        client.fetch_exec_context = MagicMock(return_value=(prompt_context, []))
        client.fetch_scorer_exec_context = MagicMock(return_value=(PromptContext(
            body="score", body_kind="text", provider_settings={"model": "gpt-5.4"},
            prompt_version_id="scorer-prompt", runner_version_id="runner-version-1", scorer_version_id="scorer-version-1",
        ), []))
        client.start_run = MagicMock(return_value=RUN_ID)
        adapter = MagicMock()
        adapter.num_threads_plan.to_payload.return_value = {"requested": 1, "effective": 1}
        result = SimpleNamespace(best_idx=0, val_aggregate_scores=[0.5], total_metric_calls=1,
                                 candidates=[{"system": "better system"}], num_full_val_evals=1)
        env = {
            "ORIZU_PROJECT": "team/project", "ORIZU_OPTIMIZER_VERSION_ID": "optimizer-version-1",
            "ORIZU_PROMPT_VERSION_ID": "prompt-version-1", "ORIZU_DATASET_VERSION_ID": "dataset-version-1",
            "ORIZU_SPLIT_SET_ID": "split-set-1", "ORIZU_SCORER_VERSION_ID": "scorer-version-1",
            "ORIZU_RUNNER_VERSION_ID": "runner-version-1", "ORIZU_CANDIDATE_RUNNER_DIR": "/candidate",
            "ORIZU_SCORER_RUNNER_DIR": "/scorer", "ORIZU_INSTRUCTION_SET_PROFILE_VERSION_ID": "profile-version-1",
            "ORIZU_VERIFIED_RUNNER_DIRS": "[\"/candidate\", \"/scorer\"]",
        }
        with patch.dict(os.environ, env, clear=True), patch.object(runtime.OrizuClient, "from_env", return_value=client), \
             patch.object(runtime, "build_config_from_environment", return_value=TextGepaConfig(reflection_model="openai/test", reflection_max_tokens=1)), \
             patch.object(runtime, "resolve_scorer_input_contract", return_value=("candidate", "candidate")), \
             patch.object(runtime, "RunnerEvaluationAdapter", return_value=adapter), \
             patch.object(runtime, "validate_seed_before_run", return_value={"preflight_metric_calls": 0}), \
             patch.object(runtime, "resolved_budget", return_value=Budget("max_metric_calls", 10, 10)), \
             patch.object(runtime, "create_local_logger_from_environment", return_value=None), \
             patch.object(runtime, "run_official_gepa", return_value=result):
            with self.assertRaisesRegex(RuntimeError, "instruction_set_pinned_components_unsupported: tools"):
                runtime.run_from_environment()
        client.start_run.assert_not_called()

    def test_runtime_keeps_an_implicit_instruction_set_launch_on_the_legacy_single_prompt_seed(self):
        """Mutant killed: infer the explicit tuple path from exec-context data alone."""
        prompt_context = PromptContext(
            body="Legacy prompt bytes\n", body_kind="text", provider_settings={"model": "gpt-5.4"},
            prompt_version_id="prompt-version-1", runner_version_id="runner-version-1", prompt_id="prompt-id",
            instruction_set={"shape": ["tools", "system"], "components": {"tools": "Tools bytes\n", "system": "System bytes\n"}, "pinned_components": {}},
        )
        scorer_context = PromptContext(
            body="score", body_kind="text", provider_settings={"model": "gpt-5.4"},
            prompt_version_id="scorer-prompt", runner_version_id="runner-version-1", scorer_version_id="scorer-version-1",
        )
        client = DurableRecordingClient()
        client.fetch_exec_context = MagicMock(side_effect=[(prompt_context, [{"id": "train"}]), (prompt_context, [{"id": "validation"}])])
        client.fetch_scorer_exec_context = MagicMock(return_value=(scorer_context, []))
        client.start_run = MagicMock(return_value=RUN_ID)
        client.promote_candidate = MagicMock(return_value="promoted-version")
        adapter = MagicMock(); adapter.num_threads_plan.to_payload.return_value = {"requested": 1, "effective": 1}
        result = SimpleNamespace(best_idx=1, val_aggregate_scores=[0.2, 0.9], total_metric_calls=1,
                                 candidates=[{"prompt": "Legacy prompt bytes\n"}, {"prompt": "Better legacy prompt\n"}], num_full_val_evals=1)
        env = {
            "ORIZU_PROJECT": "team/project", "ORIZU_OPTIMIZER_VERSION_ID": "optimizer-version-1",
            "ORIZU_PROMPT_VERSION_ID": "prompt-version-1", "ORIZU_DATASET_VERSION_ID": "dataset-version-1",
            "ORIZU_SPLIT_SET_ID": "split-set-1", "ORIZU_SCORER_VERSION_ID": "scorer-version-1",
            "ORIZU_RUNNER_VERSION_ID": "runner-version-1", "ORIZU_CANDIDATE_RUNNER_DIR": "/candidate",
            "ORIZU_SCORER_RUNNER_DIR": "/scorer", "ORIZU_VERIFIED_RUNNER_DIRS": "[\"/candidate\", \"/scorer\"]",
            "ORIZU_AUTO_PROMOTE": "1", "ORIZU_REFLECTION_MODEL": "openai/test",
        }
        with patch.dict(os.environ, env, clear=True), \
             patch.object(runtime.OrizuClient, "from_env", return_value=client), \
             patch.object(runtime, "resolve_scorer_input_contract", return_value=("candidate", "candidate")), \
             patch.object(runtime, "RunnerEvaluationAdapter", return_value=adapter), \
             patch.object(runtime, "validate_seed_before_run", return_value={"preflight_metric_calls": 0}), \
             patch.object(runtime, "resolved_budget", return_value=Budget("max_metric_calls", 10, 10)), \
             patch.object(runtime, "create_local_logger_from_environment", return_value=None), \
             patch.object(runtime, "run_official_gepa", return_value=result) as run_engine:
            runtime.run_from_environment()
        self.assertEqual(run_engine.call_args.kwargs["seed_candidate"], {"prompt": "Legacy prompt bytes\n"})
        self.assertEqual(client.promote_candidate.call_args.kwargs["body"], "Better legacy prompt\n")

    def test_runtime_writes_a_set_of_one_best_candidate_as_the_legacy_result_json_string(self):
        """Mutant killed: write every best candidate map verbatim to result.json."""
        prompt_context = PromptContext(
            body="Legacy prompt bytes\n", body_kind="text", provider_settings={"model": "gpt-5.4"},
            prompt_version_id="prompt-version-1", runner_version_id="runner-version-1", prompt_id="prompt-id",
            instruction_set={"shape": ["prompt"], "components": {"prompt": "Legacy prompt bytes\n"}, "pinned_components": {}},
        )
        scorer_context = PromptContext(
            body="score", body_kind="text", provider_settings={"model": "gpt-5.4"},
            prompt_version_id="scorer-prompt", runner_version_id="runner-version-1", scorer_version_id="scorer-version-1",
        )
        client = DurableRecordingClient()
        client.fetch_exec_context = MagicMock(side_effect=[(prompt_context, [{"id": "train"}]), (prompt_context, [{"id": "validation"}])])
        client.fetch_scorer_exec_context = MagicMock(return_value=(scorer_context, []))
        client.start_run = MagicMock(return_value=RUN_ID)
        adapter = MagicMock(); adapter.num_threads_plan.to_payload.return_value = {"requested": 1, "effective": 1}
        result = SimpleNamespace(best_idx=1, val_aggregate_scores=[0.2, 0.9], total_metric_calls=1,
                                 candidates=[{"prompt": "Legacy prompt bytes\n"}, {"prompt": "Better legacy prompt\n"}], num_full_val_evals=1)
        env = {
            "ORIZU_PROJECT": "team/project", "ORIZU_OPTIMIZER_VERSION_ID": "optimizer-version-1",
            "ORIZU_PROMPT_VERSION_ID": "prompt-version-1", "ORIZU_DATASET_VERSION_ID": "dataset-version-1",
            "ORIZU_SPLIT_SET_ID": "split-set-1", "ORIZU_SCORER_VERSION_ID": "scorer-version-1",
            "ORIZU_RUNNER_VERSION_ID": "runner-version-1", "ORIZU_CANDIDATE_RUNNER_DIR": "/candidate",
            "ORIZU_SCORER_RUNNER_DIR": "/scorer", "ORIZU_VERIFIED_RUNNER_DIRS": "[\"/candidate\", \"/scorer\"]",
            "ORIZU_REFLECTION_MODEL": "openai/test",
        }
        with tempfile.TemporaryDirectory() as root:
            local_logger = LocalOptimizationLogger.create(root, RUN_ID)
            with patch.dict(os.environ, env, clear=True), \
                 patch.object(runtime.OrizuClient, "from_env", return_value=client), \
                 patch.object(runtime, "resolve_scorer_input_contract", return_value=("candidate", "candidate")), \
                 patch.object(runtime, "RunnerEvaluationAdapter", return_value=adapter), \
                 patch.object(runtime, "validate_seed_before_run", return_value={"preflight_metric_calls": 0}), \
                 patch.object(runtime, "resolved_budget", return_value=Budget("max_metric_calls", 10, 10)), \
                 patch.object(runtime, "create_local_logger_from_environment", return_value=local_logger), \
                 patch.object(runtime, "run_official_gepa", return_value=result):
                runtime.run_from_environment()
            artifact = json.loads((Path(root) / RUN_ID / "result.json").read_text())
        self.assertEqual(artifact["best_candidate_text"], "Better legacy prompt\n")

    def test_runtime_refuses_multi_component_auto_promotion_before_start_run(self):
        """Mutant killed: pass a tuple through to prompt-only auto-promotion's first-value body write."""
        prompt_context = PromptContext(
            body=None, body_kind="text", provider_settings={"model": "gpt-5.4"},
            prompt_version_id="prompt-version-1", runner_version_id="runner-version-1", prompt_id="prompt-id",
            instruction_set={"shape": ["system", "tools"], "components": {"system": "System bytes\n", "tools": "Tools bytes\n"}, "pinned_components": {}},
            body_present=False,
        )
        client = DurableRecordingClient()
        client.fetch_exec_context = MagicMock(return_value=(prompt_context, []))
        client.fetch_scorer_exec_context = MagicMock(return_value=(PromptContext(
            body="score", body_kind="text", provider_settings={"model": "gpt-5.4"},
            prompt_version_id="scorer-prompt", runner_version_id="runner-version-1", scorer_version_id="scorer-version-1",
        ), []))
        client.start_run = MagicMock(return_value=RUN_ID)
        client.promote_candidate = MagicMock(return_value="promoted-version")
        adapter = MagicMock()
        adapter.num_threads_plan.to_payload.return_value = {"requested": 1, "effective": 1}
        result = SimpleNamespace(best_idx=1, val_aggregate_scores=[0.2, 0.9], total_metric_calls=1,
                                 candidates=[{"system": "System bytes\n", "tools": "Tools bytes\n"}, {"system": "better system", "tools": "better tools"}], num_full_val_evals=1)
        env = {
            "ORIZU_PROJECT": "team/project", "ORIZU_OPTIMIZER_VERSION_ID": "optimizer-version-1",
            "ORIZU_PROMPT_VERSION_ID": "prompt-version-1", "ORIZU_DATASET_VERSION_ID": "dataset-version-1",
            "ORIZU_SPLIT_SET_ID": "split-set-1", "ORIZU_SCORER_VERSION_ID": "scorer-version-1",
            "ORIZU_RUNNER_VERSION_ID": "runner-version-1", "ORIZU_CANDIDATE_RUNNER_DIR": "/candidate",
            "ORIZU_SCORER_RUNNER_DIR": "/scorer", "ORIZU_INSTRUCTION_SET_PROFILE_VERSION_ID": "profile-version-1",
            "ORIZU_VERIFIED_RUNNER_DIRS": "[\"/candidate\", \"/scorer\"]", "ORIZU_AUTO_PROMOTE": "1",
            "ORIZU_REFLECTION_MODEL": "openai/test",
        }
        with patch.dict(os.environ, env, clear=True), patch.object(runtime.OrizuClient, "from_env", return_value=client), \
             patch.object(runtime, "resolve_scorer_input_contract", return_value=("candidate", "candidate")), \
             patch.object(runtime, "RunnerEvaluationAdapter", return_value=adapter), \
             patch.object(runtime, "validate_seed_before_run", return_value={"preflight_metric_calls": 0}), \
             patch.object(runtime, "resolved_budget", return_value=Budget("max_metric_calls", 10, 10)), \
             patch.object(runtime, "create_local_logger_from_environment", return_value=None), \
             patch.object(runtime, "run_official_gepa", return_value=result):
            with self.assertRaisesRegex(RuntimeError, "instruction_set_candidate_promotion_unsupported"):
                runtime.run_from_environment()
        client.start_run.assert_not_called()

    def test_runtime_keeps_set_of_one_auto_promotion_available(self):
        """Mutant killed: refuse the pre-existing one-component auto-promotion path with tuple protection."""
        prompt_context = PromptContext(
            body="System bytes\n", body_kind="text", provider_settings={"model": "gpt-5.4"},
            prompt_version_id="prompt-version-1", runner_version_id="runner-version-1", prompt_id="prompt-id",
            instruction_set={"shape": ["system"], "components": {"system": "System bytes\n"}, "pinned_components": {}},
        )
        client = DurableRecordingClient()
        client.fetch_exec_context = MagicMock(return_value=(prompt_context, []))
        client.fetch_scorer_exec_context = MagicMock(return_value=(PromptContext(
            body="score", body_kind="text", provider_settings={"model": "gpt-5.4"},
            prompt_version_id="scorer-prompt", runner_version_id="runner-version-1", scorer_version_id="scorer-version-1",
        ), []))
        client.start_run = MagicMock(return_value=RUN_ID)
        client.promote_candidate = MagicMock(return_value="promoted-version")
        adapter = MagicMock()
        adapter.num_threads_plan.to_payload.return_value = {"requested": 1, "effective": 1}
        result = SimpleNamespace(best_idx=1, val_aggregate_scores=[0.2, 0.9], total_metric_calls=1,
                                 candidates=[{"system": "System bytes\n"}, {"system": "better system"}], num_full_val_evals=1)
        env = {
            "ORIZU_PROJECT": "team/project", "ORIZU_OPTIMIZER_VERSION_ID": "optimizer-version-1",
            "ORIZU_PROMPT_VERSION_ID": "prompt-version-1", "ORIZU_DATASET_VERSION_ID": "dataset-version-1",
            "ORIZU_SPLIT_SET_ID": "split-set-1", "ORIZU_SCORER_VERSION_ID": "scorer-version-1",
            "ORIZU_RUNNER_VERSION_ID": "runner-version-1", "ORIZU_CANDIDATE_RUNNER_DIR": "/candidate",
            "ORIZU_SCORER_RUNNER_DIR": "/scorer", "ORIZU_INSTRUCTION_SET_PROFILE_VERSION_ID": "profile-version-1",
            "ORIZU_VERIFIED_RUNNER_DIRS": "[\"/candidate\", \"/scorer\"]", "ORIZU_AUTO_PROMOTE": "1",
            "ORIZU_REFLECTION_MODEL": "openai/test",
        }
        with patch.dict(os.environ, env, clear=True), patch.object(runtime.OrizuClient, "from_env", return_value=client), \
             patch.object(runtime, "resolve_scorer_input_contract", return_value=("candidate", "candidate")), \
             patch.object(runtime, "RunnerEvaluationAdapter", return_value=adapter), \
             patch.object(runtime, "validate_seed_before_run", return_value={"preflight_metric_calls": 0}), \
             patch.object(runtime, "resolved_budget", return_value=Budget("max_metric_calls", 10, 10)), \
             patch.object(runtime, "create_local_logger_from_environment", return_value=None), \
             patch.object(runtime, "run_official_gepa", return_value=result):
            runtime.run_from_environment()
        client.start_run.assert_called_once()
        self.assertEqual(client.start_run.call_args.kwargs["prompt_version_id"], "prompt-version-1")
        self.assertIsNone(client.start_run.call_args.kwargs["instruction_set_profile_version_id"])
        self.assertEqual(client.promote_candidate.call_args.kwargs["body"], "better system")

    def test_pinned_instruction_set_tuple_is_refused_before_a_run_exists(self):
        """Mutant killed: turn a git-pinned component into an empty optimizable body."""
        from orizu_gepa_connector.runtime import validate_launch_contract

        with self.assertRaisesRegex(RuntimeError, "instruction_set_pinned_components_unsupported: tools"):
            validate_launch_contract(
                {"system": "seed system"},
                pinned_components={"tools": {"repoPath": "skills/tools.md", "contentSha": "a" * 64, "commitSha": "b" * 40}},
            )

    def test_client_explicit_profile_fetch_preserves_measured_tuple_shape_and_order(self):
        """Mutant killed: fetch implicitly, use prompt.body, or reorder the server's shape-ordered tuple."""
        from orizu_gepa.client import OrizuClient

        response = {
            "prompt": {"bodyKind": "text", "providerSettings": {"model": "gpt-5.4"}, "promptVersionId": "prompt-version-1", "runnerVersionId": "runner-version-1"},
            "instructionSet": {
                "name": "planner", "modelConfig": {"identity": "openai/gpt-5.4"},
                "shape": ["tools", "system"], "profileVersionId": "15350000-0000-4000-8000-000000000002",
                "versionNumber": 2, "modelConfigSettingsVersionId": "15360000-0000-4000-8000-000000000001",
                "components": {"tools": "Tools bytes\n", "system": "System bytes\n"}, "pinnedComponents": {},
            }, "rows": [],
        }
        client = OrizuClient(api_url="http://example.test", token="test")
        with patch.object(OrizuClient, "_request", return_value=response) as request:
            context, rows = client.fetch_exec_context(
                prompt_version_id="prompt-version-1", runner_version_id="runner-version-1",
                dataset_version_id="dataset-version-1", split_set_id="split-set-1", split="validation",
                instruction_set_profile_version_id="15350000-0000-4000-8000-000000000002",
            )
        self.assertEqual(rows, [])
        self.assertEqual(context.instruction_set["components"], {"tools": "Tools bytes\n", "system": "System bytes\n"})
        self.assertEqual(list(context.instruction_set["components"]), ["tools", "system"])
        self.assertIn("instructionSetProfileVersionId=15350000-0000-4000-8000-000000000002", request.call_args.args[1])

    def test_multi_component_auto_promotion_is_refused_with_a_named_code(self):
        """Mutant killed: post a partial tuple to the prompt-only promotion endpoint."""
        from orizu_gepa_connector.runtime import validate_launch_contract

        with self.assertRaisesRegex(RuntimeError, "instruction_set_candidate_promotion_unsupported"):
            validate_launch_contract({"system": "seed", "tools": "seed"}, auto_promote=True)

    def test_run_creation_sends_the_resolved_runner_declaration(self):
        """Mutants killed: discard the settings or runner declaration after exec-context resolution."""
        from orizu_gepa.client import OrizuClient

        client = OrizuClient(api_url="http://example.test", token="test")
        with patch.object(OrizuClient, "_request", return_value={"optimization_run_id": "run-1"}) as request:
            client.start_run(
                project="team/project", optimizer_version_id="optimizer-version-1", prompt_version_id="prompt-version-1",
                scorer_version_id="scorer-version-1", dataset_version_id="dataset-version-1", split_set_id="split-set-1",
                train_split="train", validation_split="validation",
                model_config_settings_version_id="15360000-0000-4000-8000-000000000001",
                runner_version_id="execution-runner-version-2",
            )
        self.assertEqual(request.call_args.args[2]["modelConfigSettingsVersionId"], "15360000-0000-4000-8000-000000000001")
        self.assertEqual(request.call_args.args[2]["runnerVersionId"], "execution-runner-version-2")

    def test_multi_component_launch_is_accepted_before_a_run_exists(self):
        """Mutant killed: retain the one-component refusal before start_run can execute."""
        from orizu_gepa_connector.runtime import validate_launch_contract

        validate_launch_contract({"system": "seed system", "tools": "seed tools"})

    def test_shape_and_seed_pair_mismatch_is_named_before_a_run_exists(self):
        """Mutant killed: accept a partial tuple merely because it has one valid component key."""
        from orizu_gepa_connector.runtime import validate_launch_contract

        with self.assertRaisesRegex(RuntimeError, "instruction_set_tuple_shape_mismatch: tools"):
            validate_launch_contract(
                {"system": "seed system"},
                instruction_set_shape=["system", "tools"],
            )

    def test_resolved_budget_scales_with_the_tuple_shape(self):
        """Mutant killed: keep num_components fixed at one when resolving a preset budget."""
        from orizu_gepa_connector.runtime import resolved_budget

        one = resolved_budget(TextGepaConfig(budget="light"), trainset_size=2, valset_size=2, num_components=1)
        two = resolved_budget(TextGepaConfig(budget="light"), trainset_size=2, valset_size=2, num_components=2)
        self.assertEqual(one.limit, 388)
        self.assertEqual(one.approx_metric_call_limit, 388)
        self.assertEqual(two.limit, 742)
        self.assertEqual(two.approx_metric_call_limit, 742)

    def test_connector_passes_the_measured_module_selector_to_real_gepa(self):
        """Mutant killed: omit GEPA's module_selector or pass the unrecognized component_selector name."""
        selected_components: list[list[str]] = []

        class SelectorRecordingAdapter(DeterministicAdapter):
            def make_reflective_dataset(self, candidate, evaluation, components_to_update):
                selected_components.append(list(components_to_update))
                return super().make_reflective_dataset(candidate, evaluation, components_to_update)

        run_official_gepa(
            seed_candidate={"system": "seed system", "tools": "seed tools"},
            trainset=[{"id": "train-1"}], valset=[{"id": "validation-1"}],
            adapter=SelectorRecordingAdapter(), callback=OrizuCallback(RecordingSink(), RUN_ID),
            hooks=LifecycleHooks(), stop_callbacks=[IterationBoundaryStopper(max_iterations=1)],
            allow_degenerate_seed=True, module_selector="all",
        )
        self.assertTrue(selected_components)
        self.assertEqual(selected_components[0], ["system", "tools"])

    def test_connector_round_robin_rotates_one_shape_key_each_round(self):
        """Mutant killed: map round-robin to all, or leave GEPA on its accidental historical default."""
        selected_components: list[list[str]] = []

        class SelectorRecordingAdapter(DeterministicAdapter):
            def make_reflective_dataset(self, candidate, evaluation, components_to_update):
                selected_components.append(list(components_to_update))
                return super().make_reflective_dataset(candidate, evaluation, components_to_update)

        run_official_gepa(
            seed_candidate={"system": "seed system", "tools": "seed tools"},
            trainset=[{"id": "train-1"}], valset=[{"id": "validation-1"}],
            adapter=SelectorRecordingAdapter(), callback=OrizuCallback(RecordingSink(), RUN_ID),
            hooks=LifecycleHooks(), stop_callbacks=[IterationBoundaryStopper(max_iterations=2)],
            allow_degenerate_seed=True, module_selector="round_robin",
        )
        self.assertEqual(selected_components[:2], [["system"], ["tools"]])

    def test_real_reflection_bridge_updates_only_the_round_robin_component(self):
        """Mutants killed: P1 serializes the tuple; P4 writes every proposal to the first key."""
        import orizu_gepa_connector.reflection as reflection
        from orizu_gepa.optimizer import build_reflection_prompt

        calls: list[tuple[str, str]] = []
        sink = RecordingSink()
        class BridgeAdapter(DeterministicAdapter):
            propose_new_texts = None
        def provider(parent, rows, config):
            prompt = build_reflection_prompt(parent, rows, config)
            calls.append((parent, prompt))
            return SimpleNamespace(response=f"better {parent}", prompt=prompt,
                                   usage={"input_tokens": 1, "output_tokens": 1, "total_tokens": 2})
        lm = make_gepa_reflection_lm(
            context_supplier=lambda: ({"system": "seed system", "tools": "seed tools"}, []),
            config=TextGepaConfig(reflection_model="openai/test", reflection_max_tokens=1),
        )
        with patch.object(reflection, "reflect_with_provider", side_effect=provider):
            run_official_gepa(
                seed_candidate={"system": "seed system", "tools": "seed tools"},
                trainset=[{"id": "train"}], valset=[{"id": "validation"}], adapter=BridgeAdapter(),
                callback=OrizuCallback(sink, RUN_ID), hooks=LifecycleHooks(), reflection_lm=lm,
                stop_callbacks=[IterationBoundaryStopper(max_iterations=1)], allow_degenerate_seed=True,
                module_selector="round_robin",
            )
        proposal = next(event for event in sink.events if event["event_type"] == "candidate_proposed")["payload"]
        self.assertEqual(calls[0][0], "seed system")
        self.assertIn('Other instruction-set components (read-only): {"tools": "seed tools"}', calls[0][1])
        self.assertEqual(proposal["components_to_update"], ["system"])
        self.assertEqual(proposal["components"], {"system": "better seed system", "tools": "seed tools"})

    def test_real_reflection_bridge_updates_each_all_component_and_keeps_set_of_one_legacy_prompt(self):
        """Mutants killed: P2 adds tuple context to a singleton; P4 aliases all rewrites to one key."""
        import orizu_gepa_connector.reflection as reflection
        from orizu_gepa.optimizer import build_reflection_prompt

        calls: list[tuple[str, str]] = []
        class BridgeAdapter(DeterministicAdapter):
            propose_new_texts = None
        def provider(parent, rows, config):
            prompt = build_reflection_prompt(parent, rows, config)
            calls.append((parent, prompt))
            return SimpleNamespace(response=f"better {parent}", prompt=prompt,
                                   usage={"input_tokens": 1, "output_tokens": 1, "total_tokens": 2})
        lm = make_gepa_reflection_lm(
            context_supplier=lambda: ({"system": "seed system", "tools": "seed tools"}, []),
            config=TextGepaConfig(reflection_model="openai/test", reflection_max_tokens=1),
        )
        sink = RecordingSink()
        with patch.object(reflection, "reflect_with_provider", side_effect=provider):
            run_official_gepa(
                seed_candidate={"system": "seed system", "tools": "seed tools"},
                trainset=[{"id": "train"}], valset=[{"id": "validation"}], adapter=BridgeAdapter(),
                callback=OrizuCallback(sink, RUN_ID), hooks=LifecycleHooks(), reflection_lm=lm,
                stop_callbacks=[IterationBoundaryStopper(max_iterations=1)], allow_degenerate_seed=True,
                module_selector="all",
            )
        proposal = next(event for event in sink.events if event["event_type"] == "candidate_proposed")["payload"]
        self.assertEqual([parent for parent, _ in calls], ["seed system", "seed tools"])
        self.assertEqual(proposal["components"], {"system": "better seed system", "tools": "better seed tools"})
        singleton_calls: list[str] = []
        singleton = make_gepa_reflection_lm(
            context_supplier=lambda: ({"prompt": "Legacy prompt bytes\n"}, []),
            config=TextGepaConfig(reflection_model="openai/test", reflection_max_tokens=1),
        )
        with patch.object(reflection, "reflect_with_provider", side_effect=lambda parent, rows, config: (
            singleton_calls.append(build_reflection_prompt(parent, rows, config)) or
            SimpleNamespace(response="better", prompt=singleton_calls[-1], usage={"input_tokens": 1, "output_tokens": 1, "total_tokens": 2})
        )):
            singleton.reflect({"prompt": "Legacy prompt bytes\n"}, {"prompt": [{}]}, ["prompt"])
        self.assertNotIn("Other instruction-set components", singleton_calls[0])

    def test_tuple_reflection_failure_reports_the_frozen_provider_prompt(self):
        """Mutant R8 killed: report an empty GEPA prompt after the vendor request fails."""
        import orizu_gepa_connector.reflection as reflection

        reports: list[dict[str, object]] = []
        lm = make_gepa_reflection_lm(
            context_supplier=lambda: ({"system": "seed system", "tools": "seed tools"}, []),
            config=TextGepaConfig(reflection_model="openai/test", reflection_max_tokens=1),
            failure_reporter=lambda **report: reports.append(report),
        )
        with patch.object(reflection, "reflect_with_provider", side_effect=RuntimeError("vendor unavailable")):
            with self.assertRaisesRegex(RuntimeError, "vendor unavailable"):
                lm.reflect({"system": "seed system", "tools": "seed tools"}, {}, ["system"])
        self.assertIn("seed system", str(reports[0]["gepa_prompt"]))

    def test_tuple_reflection_uses_gepas_candidate_not_the_adapter_last_candidate(self):
        """Mutant R7 killed: reflect adapter state instead of GEPA's selected parent candidate."""
        import orizu_gepa_connector.reflection as reflection

        captured: list[str] = []
        lm = make_gepa_reflection_lm(
            context_supplier=lambda: ({"system": "stale adapter system", "tools": "stale adapter tools"}, []),
            config=TextGepaConfig(reflection_model="openai/test", reflection_max_tokens=1),
        )
        templates: list[str] = []
        with patch.object(reflection, "reflect_with_provider", side_effect=lambda parent, _results, cfg: (
            captured.append(parent) or templates.append(cfg.reflection_prompt_template) or SimpleNamespace(response="better", prompt="provider", usage={"input_tokens": 1, "output_tokens": 1, "total_tokens": 2})
        )):
            lm.reflect({"system": "GEPA system", "tools": "GEPA tools"}, {}, ["tools"])
        self.assertEqual(captured, ["GEPA tools"])
        self.assertEqual(len(templates), 1)
        self.assertIn('Other instruction-set components (read-only): {"system": "GEPA system"}', templates[0])
        self.assertNotIn("stale adapter", templates[0])

    def test_tuple_reflection_without_a_custom_template_keeps_the_full_default_prompt(self):
        """Mutant killed: tuple reflection falls back to a one-line stub instead of DEFAULT_REFLECTION_PROMPT_TEMPLATE."""
        import orizu_gepa_connector.reflection as reflection
        from orizu_gepa.optimizer import DEFAULT_REFLECTION_PROMPT_TEMPLATE

        templates: list[str] = []
        lm = make_gepa_reflection_lm(
            context_supplier=lambda: ({}, []),
            config=TextGepaConfig(reflection_model="openai/test", reflection_max_tokens=1),
        )
        with patch.object(reflection, "reflect_with_provider", side_effect=lambda _parent, _results, cfg: (
            templates.append(cfg.reflection_prompt_template) or SimpleNamespace(response="better", prompt="provider", usage={"input_tokens": 1, "output_tokens": 1, "total_tokens": 2})
        )):
            lm.reflect({"system": "GEPA system", "tools": "GEPA tools"}, {}, ["tools"])
        self.assertEqual(len(templates), 1)
        self.assertTrue(templates[0].startswith(DEFAULT_REFLECTION_PROMPT_TEMPLATE), templates[0][:120])
        self.assertIn('Other instruction-set components (read-only): {"system": "GEPA system"}', templates[0])

    def test_skilled_proposer_path_receives_every_component_selected_by_gepa(self):
        """Mutant killed: skilled-proposer's historical ['prompt'] loop ignores the selected tuple keys."""
        proposals: list[tuple[dict[str, str], list[str]]] = []

        def skilled_proposer(candidate, reflective_dataset, components_to_update):
            proposals.append((dict(candidate), list(components_to_update)))
            return {key: f"better {key}" for key in components_to_update}

        run_official_gepa(
            seed_candidate={"system": "seed system", "tools": "seed tools"},
            trainset=[{"id": "train-1"}], valset=[{"id": "validation-1"}],
            adapter=DeterministicAdapter(), callback=OrizuCallback(RecordingSink(), RUN_ID),
            hooks=LifecycleHooks(), stop_callbacks=[IterationBoundaryStopper(max_iterations=1)],
            allow_degenerate_seed=True, custom_candidate_proposer=skilled_proposer,
            module_selector="all",
        )
        self.assertEqual(proposals[0], (
            {"system": "seed system", "tools": "seed tools"},
            ["system", "tools"],
        ))

    def test_real_gepa_round_robin_candidate_proposal_carries_the_full_tuple_and_selected_component(self):
        """Mutant killed: read selected keys from ProposalEnd or emit only the rewrite delta."""
        sink = RecordingSink()
        callback = OrizuCallback(sink, RUN_ID)
        run_official_gepa(
            seed_candidate={"system": "seed system", "tools": "seed tools"},
            trainset=[{"id": "train-1"}], valset=[{"id": "validation-1"}],
            adapter=DeterministicAdapter(), callback=callback, hooks=LifecycleHooks(),
            stop_callbacks=[IterationBoundaryStopper(max_iterations=1)], allow_degenerate_seed=True,
            module_selector="round_robin",
        )
        proposal = next(event for event in sink.events if event["event_type"] == "candidate_proposed")
        self.assertEqual(proposal["payload"], {
            "components": {"system": "better", "tools": "seed tools"},
            "components_to_update": ["system"],
            "payload_truncated": False,
        })

    def test_real_gepa_all_candidate_proposal_carries_every_component_without_legacy_body(self):
        """Mutant killed: emit a partial map or a legacy body for a multi-component tuple."""
        sink = RecordingSink()
        callback = OrizuCallback(sink, RUN_ID)
        run_official_gepa(
            seed_candidate={"system": "seed system", "tools": "seed tools"},
            trainset=[{"id": "train-1"}], valset=[{"id": "validation-1"}],
            adapter=DeterministicAdapter(), callback=callback, hooks=LifecycleHooks(),
            stop_callbacks=[IterationBoundaryStopper(max_iterations=1)], allow_degenerate_seed=True,
            module_selector="all",
        )
        proposal = next(event for event in sink.events if event["event_type"] == "candidate_proposed")
        self.assertNotIn("body", proposal["payload"])
        self.assertEqual(proposal["payload"]["components"], {"system": "better", "tools": "better"})
        self.assertEqual(proposal["payload"]["components_to_update"], ["system", "tools"])

    def test_real_gepa_callback_translates_validation_components_and_truncation(self):
        """Kills split rewriting, raw candidate text, and silent payload truncation."""
        event: ValsetEvaluatedEvent = {
            "iteration": 1,
            "candidate_idx": 1,
            "candidate": {"prompt": "better" * 40},
            "scores_by_val_id": {"validation-row-1": 1.0},
            "average_score": 1.0,
            "num_examples_evaluated": 1,
            "total_valset_size": 1,
            "parent_ids": [],
            "is_best_program": True,
            "outputs_by_val_id": {"validation-row-1": {"row_id": "canonical-row", "answer": "better"}},
        }
        translated = translate_callback(
            "on_valset_evaluated", event, run_id=RUN_ID, max_payload_chars=64
        )
        self.assertEqual(translated["eventType"], "child_val_set_completed")
        self.assertEqual(translated["optimizerFamily"], "gepa")
        self.assertEqual(translated["payload"]["split"], "validation")
        self.assertEqual(translated["candidateId"], "1")
        self.assertEqual(translated["payload"]["candidate_id"], "1")
        self.assertEqual(translated["payload"]["score_mean"], 1.0)
        self.assertEqual(translated["payload"]["row_results"], [{
            "row_id": "canonical-row",
            "score": 1.0,
            "feedback": None,
            "error": None,
            "output": {"row_id": "canonical-row", "answer": "better"},
        }])
        self.assertEqual(
            translated["payload"]["components"],
            {"prompt": ("better" * 40)[:64] + "…[truncated]"},
        )
        self.assertTrue(translated["payload"]["payload_truncated"])
        self.assertEqual(translated["payload"]["truncation"], {
            "fields": {"components.prompt": 240},
        })

    def test_real_gepa_seed_valset_callback_uses_the_legacy_seed_wire_event(self):
        """Kills a seed callback translated as a child, which erases seedScore."""
        event: ValsetEvaluatedEvent = {
            "iteration": 0, "candidate_idx": 0, "candidate": {"prompt": "seed"},
            "scores_by_val_id": {"validation-row-1": 0.2}, "average_score": 0.2,
            "num_examples_evaluated": 1, "total_valset_size": 1, "parent_ids": [],
            "is_best_program": True, "outputs_by_val_id": {"validation-row-1": {"answer": "seed"}},
        }
        translated = translate_callback("on_valset_evaluated", event, run_id=RUN_ID)
        self.assertEqual(translated["eventType"], "seed_val_set_completed")
        self.assertEqual(translated["candidateId"], "seed")
        self.assertEqual(translated["payload"]["candidate_id"], "seed")

    def test_translator_refuses_a_positional_valset_id_without_adapter_evidence(self):
        """Kills the silent positional-id fallback that corrupts dashboard joins."""
        with self.assertRaisesRegex(ValueError, "positional row id"):
            translate_callback("on_valset_evaluated", {
                "iteration": 1, "candidate_idx": 1,
                "scores_by_val_id": {0: 0.8}, "outputs_by_val_id": {},
            }, run_id=RUN_ID)

    def test_seed_valset_enriches_gepas_empty_output_map_from_preceding_evaluation(self):
        """Kills a seed baseline whose score exists but per-row evidence is empty."""
        sink = RecordingSink()
        callback = OrizuCallback(sink, RUN_ID, log_row_snapshots=True)
        callback.on_evaluation_start({"iteration": 0, "inputs": [{"id": "dataset-row"}]})
        callback.on_evaluation_end({"iteration": 0, "candidate_idx": 0, "is_seed_candidate": True,
                                    "scores": [0.2], "outputs": [{"row_id": "dataset-row", "output": "seed output"}],
                                    "trajectories": [{"Feedback": "improve", "output": "seed output"}]})
        callback.on_valset_evaluated({"iteration": 0, "candidate_idx": 0, "scores_by_val_id": {"dataset-row": 0.2},
                                      "average_score": 0.2, "outputs_by_val_id": None})
        seed = sink.events[-1]
        self.assertEqual([event["event_type"] for event in sink.events], ["seed_val_set_completed"])
        self.assertEqual(seed["event_type"], "seed_val_set_completed")
        self.assertEqual(seed["payload"]["row_results"][0]["output"], "seed output")
        self.assertEqual(seed["payload"]["row_results"][0]["feedback"], "improve")

    def test_lower_is_better_callback_restores_raw_scores_for_the_dashboard(self):
        """Kills publishing GEPA's inverted optimization score as the scorer value."""
        sink = RecordingSink()
        callback = OrizuCallback(sink, RUN_ID, higher_is_better=False)
        callback.on_valset_evaluated({
            "iteration": 1, "candidate_idx": 1, "candidate": {"prompt": "better"},
            "scores_by_val_id": {"validation-row": 0.8}, "average_score": 0.8,
            "num_examples_evaluated": 1, "total_valset_size": 1, "parent_ids": [0],
            "is_best_program": True, "outputs_by_val_id": {"validation-row": {"answer": "better"}},
        })
        self.assertAlmostEqual(sink.events[0]["payload"]["score_mean"], 0.2)
        self.assertAlmostEqual(sink.events[0]["payload"]["row_results"][0]["score"], 0.2)

    def test_real_gepa_proposal_callback_preserves_reflection_and_candidate_shape(self):
        """Kills a translator that drops reflection text or components maps."""
        event: ProposalEndEvent = {
            "iteration": 1,
            "new_instructions": {"prompt": "better"},
            "prompts": {"prompt": "reflection prompt"},
            "raw_lm_outputs": {"prompt": "<new_text>better</new_text>"},
        }
        translated = translate_callback("on_proposal_end", event, run_id=RUN_ID)
        self.assertEqual(translated["eventType"], "reflection_completed")
        self.assertEqual(translated["payload"]["components"], {"prompt": "better"})
        self.assertEqual(translated["payload"]["response"], "<new_text>better</new_text>")

    def test_optimization_start_preserves_the_full_tuple_seed_map(self):
        """Kills choosing an arbitrary seed component as the tuple seed."""
        translated = translate_callback("on_optimization_start", {
            "seed_candidate": {"system": "system seed", "tools": "tools seed"},
            "trainset_size": 1,
            "valset_size": 1,
        }, run_id=RUN_ID)
        self.assertEqual(translated["eventType"], "run_started")
        self.assertEqual(translated["payload"]["seed_components"], {
            "system": "system seed", "tools": "tools seed",
        })
        self.assertNotIn("components", translated["payload"])

    def test_real_gepa_engine_stops_only_after_a_completed_iteration(self):
        """Kills an iteration stopper that stops during GEPA's evaluation/proposal stages."""
        callback = CapturingCallback()
        result = optimize(
            seed_candidate={"prompt": "seed"},
            trainset=[{"id": "train-1"}],
            valset=[{"id": "validation-1"}],
            adapter=DeterministicAdapter(),
            stop_callbacks=[IterationBoundaryStopper(max_iterations=1)],
            callbacks=[callback],
            display_progress_bar=False,
            raise_on_exception=True,
        )
        # GEPAResult 0.1.4 has no total_iterations field; the real engine
        # callback is the authoritative completed-iteration boundary.
        self.assertEqual(sum(name == "on_iteration_end" for name, _ in callback.events), 1)

    def test_real_gepa_budget_event_translates_in_the_selected_unit(self):
        """Kills a progress translator that always reports metric-call units."""
        event: BudgetUpdatedEvent = {
            "iteration": 1,
            "metric_calls_used": 4,
            "metric_calls_delta": 2,
            "metric_calls_remaining": 0,
        }
        translated = translate_callback("on_budget_updated", event, run_id=RUN_ID)
        self.assertEqual(translated["eventType"], "optimization_progress")
        self.assertEqual(translated["payload"]["budget_kind"], "max_metric_calls")
        self.assertEqual(translated["payload"]["used"], 4)

    def test_real_gepa_merge_callback_is_refused_with_an_explicit_run_note(self):
        """Kills silent rendering of two-parent candidates the current UI cannot show."""
        event: MergeAttemptedEvent = {
            "iteration": 1,
            "parent_ids": [0, 1],
            "merged_candidate": {"prompt": "merged"},
        }
        notes = []
        with self.assertRaisesRegex(ValueError, "unsupported GEPA merge"):
            translate_callback("on_merge_attempted", event, run_id=RUN_ID, run_note_sink=notes.append)
        self.assertEqual(notes, [{
            "eventType": "run_note",
            "eventLayer": "extension",
            "optimizerFamily": "gepa",
            "payload": {
                "code": "unsupported_gepa_merge",
                "message": "unsupported GEPA merge: two-parent candidates cannot be rendered",
            },
        }])

    def test_translator_leaves_sequence_allocation_to_the_production_sink(self):
        """Kills a dead translator sequence authority that competes with the sink."""
        event: ProposalEndEvent = {
            "iteration": 2,
            "new_instructions": {"prompt": "better"},
            "prompts": {"prompt": "reflection prompt"},
            "raw_lm_outputs": {"prompt": "<new_text>better</new_text>"},
        }
        translated = translate_callback("on_proposal_end", event, run_id=RUN_ID)
        self.assertNotIn("sequence", translated)

    def test_real_runner_adapter_uses_the_legacy_file_contract_and_keeps_row_side_info(self):
        """Kills an adapter that bypasses input.json/output.json or loses feedback."""
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            candidate_dir = root_path / "candidate"; scorer_dir = root_path / "scorer"
            candidate_dir.mkdir(); scorer_dir.mkdir()
            (candidate_dir / "manifest.json").write_text(json.dumps({"command": [sys.executable, "runner.py"]}))
            (scorer_dir / "manifest.json").write_text(json.dumps({"command": [sys.executable, "runner.py"], "scorer_input_contract": "gepa"}))
            (candidate_dir / "runner.py").write_text(
                "import json, os\n"
                "data=json.load(open(os.environ['ORIZU_RUNNER_INPUT_PATH']))\n"
                "json.dump({'model_response': data['prompt']['body'] + ':' + data['row']['question']}, open(os.environ['ORIZU_RUNNER_OUTPUT_PATH'],'w'))\n"
            )
            (scorer_dir / "runner.py").write_text(
                "import json, os\n"
                "data=json.load(open(os.environ['ORIZU_RUNNER_INPUT_PATH']))\n"
                "assert data['row']['candidate_id'] == 'prompt'\n"
                "json.dump({'score': 1.5, 'feedback': 'runner feedback'}, open(os.environ['ORIZU_RUNNER_OUTPUT_PATH'],'w'))\n"
            )
            context = PromptContext(body="seed", body_kind="text", provider_settings={}, prompt_version_id="prompt-v", runner_version_id="runner-v")
            adapter = RunnerEvaluationAdapter(candidate_runner_dir=str(candidate_dir), scorer_runner_dir=str(scorer_dir), run_id=RUN_ID, prompt_context=context, scorer_context=context)
            result = adapter.evaluate([DatasetRow(id="row-1", row={"question": "why"})], {"prompt": "better"}, capture_traces=True)
            lower_context = PromptContext(body="seed", body_kind="text", provider_settings={}, prompt_version_id="prompt-v", runner_version_id="runner-v", higher_is_better=False)
            lower_result = RunnerEvaluationAdapter(candidate_runner_dir=str(candidate_dir), scorer_runner_dir=str(scorer_dir), run_id=RUN_ID, prompt_context=context, scorer_context=lower_context).evaluate([DatasetRow(id="row-1", row={"question": "why"})], {"prompt": "better"})
        self.assertEqual(result.scores, [1.0])
        self.assertEqual({key: value for key, value in result.outputs[0].items() if key != "latency_ms"}, {"row_id": "row-1", "output": "better:why", "raw_score": 1.0, "feedback": "runner feedback", "error": None, "error_source": None, "scorer_output": None, "scorer_error": None, "cached": False, "token_in": None, "token_out": None, "cost_usd": None})
        self.assertIsInstance(result.outputs[0]["latency_ms"], int)
        self.assertEqual(result.trajectories[0]["Feedback"], "runner feedback")
        self.assertEqual(lower_result.scores, [0.0])

    def test_real_runner_adapter_passes_a_multi_component_candidate_to_the_runner_as_a_tuple(self):
        """Mutant killed: collapse the candidate at the adapter boundary before the runner subprocess."""
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            candidate_dir = root_path / "candidate"; scorer_dir = root_path / "scorer"
            candidate_dir.mkdir(); scorer_dir.mkdir()
            (candidate_dir / "manifest.json").write_text(json.dumps({"command": [sys.executable, "runner.py"]}))
            (scorer_dir / "manifest.json").write_text(json.dumps({"command": [sys.executable, "runner.py"]}))
            (candidate_dir / "runner.py").write_text(
                "import json, os\n"
                "data=json.load(open(os.environ['ORIZU_RUNNER_INPUT_PATH']))\n"
                "assert 'body' not in data['prompt']\n"
                "json.dump({'model_response': data['instruction_set']['components']}, open(os.environ['ORIZU_RUNNER_OUTPUT_PATH'], 'w'))\n"
            )
            (scorer_dir / "runner.py").write_text(
                "import json, os\njson.dump({'score': 1.0}, open(os.environ['ORIZU_RUNNER_OUTPUT_PATH'], 'w'))\n"
            )
            context = PromptContext(
                body=None, body_kind="text", provider_settings={}, prompt_version_id="prompt-v", runner_version_id="runner-v",
                instruction_set={"name": "planner", "model_config": {"identity": "openai/gpt-5.4"},
                                 "shape": ["tools", "system"], "profile_version_id": "profile-version-1", "version_number": 1,
                                 "prompt_component_key": "system", "components": {"tools": "seed tools", "system": "seed system"}},
                body_present=False,
            )
            adapter = RunnerEvaluationAdapter(candidate_runner_dir=str(candidate_dir), scorer_runner_dir=str(scorer_dir), run_id=RUN_ID, prompt_context=context, scorer_context=context)
            result = adapter.evaluate([DatasetRow(id="row-1", row={})], {"tools": "NEW TOOLS", "system": "NEW SYSTEM"})
        self.assertEqual(result.outputs[0]["output"], {"tools": "NEW TOOLS", "system": "NEW SYSTEM"})

    def test_real_runner_adapter_keeps_a_legacy_candidate_string_inside_a_wrapped_tuple_context(self):
        """Mutant killed: omit legacy prompt.body because the wrapper's shape has multiple keys."""
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            candidate_dir = root_path / "candidate"; scorer_dir = root_path / "scorer"
            candidate_dir.mkdir(); scorer_dir.mkdir()
            (candidate_dir / "manifest.json").write_text(json.dumps({"command": [sys.executable, "runner.py"]}))
            (scorer_dir / "manifest.json").write_text(json.dumps({"command": [sys.executable, "runner.py"]}))
            (candidate_dir / "runner.py").write_text(
                "import json, os\n"
                "input_bytes=open(os.environ['ORIZU_RUNNER_INPUT_PATH']).read()\n"
                "assert input_bytes == '{\"instruction_set\": {\"name\": \"planner\", \"model_config\": {\"identity\": \"openai/gpt-5.4\"}, \"shape\": [\"tools\", \"system\"], \"prompt_component_key\": \"system\", \"components\": {\"tools\": \"seed tools\", \"system\": \"LEGACY CANDIDATE\"}}, \"row\": {}, \"prompt\": {\"body_kind\": \"text\", \"provider_settings\": {}, \"body\": \"LEGACY CANDIDATE\"}, \"prompt_version_id\": \"prompt-v\", \"runner_version_id\": \"runner-v\", \"run_id\": \"real-gepa-red-run\"}'\n"
                "json.dump({'model_response': 'legacy runner ran'}, open(os.environ['ORIZU_RUNNER_OUTPUT_PATH'], 'w'))\n"
            )
            (scorer_dir / "runner.py").write_text(
                "import json, os\njson.dump({'score': 1.0}, open(os.environ['ORIZU_RUNNER_OUTPUT_PATH'], 'w'))\n"
            )
            context = PromptContext(
                body="seed system", body_kind="text", provider_settings={}, prompt_version_id="prompt-v", runner_version_id="runner-v",
                instruction_set={"name": "planner", "model_config": {"identity": "openai/gpt-5.4"},
                                 "shape": ["tools", "system"], "profile_version_id": "profile-version-1", "version_number": 1,
                                 "prompt_component_key": "system", "components": {"tools": "seed tools", "system": "seed system"}},
            )
            adapter = RunnerEvaluationAdapter(candidate_runner_dir=str(candidate_dir), scorer_runner_dir=str(scorer_dir), run_id=RUN_ID, prompt_context=context, scorer_context=context)
            result = adapter.evaluate([DatasetRow(id="row-1", row={})], {"prompt": "LEGACY CANDIDATE"})
        self.assertEqual(result.outputs[0]["output"], "legacy runner ran")

    def test_default_gepa_contract_scorer_launches_without_candidate_field(self):
        """Kills resolved model_output forwarding into the default GEPA contract."""
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            candidate_dir = root_path / "candidate"; scorer_dir = root_path / "scorer"
            candidate_dir.mkdir(); scorer_dir.mkdir()
            (candidate_dir / "manifest.json").write_text(json.dumps({"command": [sys.executable, "runner.py"]}))
            (scorer_dir / "manifest.json").write_text(json.dumps({"command": [sys.executable, "runner.py"]}))
            (candidate_dir / "runner.py").write_text(
                "import json, os\n"
                "json.dump({'model_response': 'candidate'}, open(os.environ['ORIZU_RUNNER_OUTPUT_PATH'], 'w'))\n"
            )
            (scorer_dir / "runner.py").write_text(
                "import json, os\n"
                "json.dump({'model_response': {'score': '0.75', 'reasoning': 'legacy reasoning'}}, open(os.environ['ORIZU_RUNNER_OUTPUT_PATH'], 'w'))\n"
            )
            context = PromptContext(body="seed", body_kind="text", provider_settings={}, prompt_version_id="prompt-v", runner_version_id="runner-v")
            adapter = RunnerEvaluationAdapter(candidate_runner_dir=str(candidate_dir), scorer_runner_dir=str(scorer_dir), run_id=RUN_ID, prompt_context=context, scorer_context=context)
            result = adapter.evaluate([DatasetRow(id="dataset-row-id", row={})], {"prompt": "better"}, capture_traces=True)
            self.assertEqual(result.outputs[0]["row_id"], "dataset-row-id")
            self.assertEqual(result.trajectories[0]["Feedback"], "legacy reasoning")
            self.assertEqual(adapter.metric_calls_used, 1)
            (scorer_dir / "runner.py").write_text(
                "import json, os\n"
                "json.dump({'model_response': {'reasoning': 'missing numeric score'}}, open(os.environ['ORIZU_RUNNER_OUTPUT_PATH'], 'w'))\n"
            )
            with self.assertRaisesRegex(ScorerContractError, "scorer.*numeric score"):
                adapter.evaluate([DatasetRow(id="dataset-row-id", row={})], {"prompt": "better"})
            self.assertEqual(adapter.metric_calls_used, 1)

    def test_runner_adapter_passes_the_nondefault_scorer_candidate_field_to_the_real_runner(self):
        """Kills the connector-only no-op of ORIZU_SCORER_CANDIDATE_FIELD."""
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            candidate_dir = root_path / "candidate"; scorer_dir = root_path / "scorer"
            candidate_dir.mkdir(); scorer_dir.mkdir()
            (candidate_dir / "manifest.json").write_text(json.dumps({"command": [sys.executable, "runner.py"]}))
            (scorer_dir / "manifest.json").write_text(json.dumps({"command": [sys.executable, "runner.py"], "scorer_input_contract": "flat_row"}))
            (candidate_dir / "runner.py").write_text("import json, os\njson.dump({'model_response':'draft'}, open(os.environ['ORIZU_RUNNER_OUTPUT_PATH'], 'w'))\n")
            (scorer_dir / "runner.py").write_text("import json, os\ndata=json.load(open(os.environ['ORIZU_RUNNER_INPUT_PATH']))\nassert data['row']['draft_text'] == 'draft'\njson.dump({'score': 1.0}, open(os.environ['ORIZU_RUNNER_OUTPUT_PATH'], 'w'))\n")
            context = PromptContext(body="seed", body_kind="text", provider_settings={}, prompt_version_id="prompt-v", runner_version_id="runner-v")
            adapter = RunnerEvaluationAdapter(candidate_runner_dir=str(candidate_dir), scorer_runner_dir=str(scorer_dir), run_id=RUN_ID, prompt_context=context, scorer_context=context, scorer_candidate_field="draft_text")
            result = adapter.evaluate([DatasetRow(id="row", row={})], {"prompt": "better"})
        self.assertEqual(result.scores, [1.0])

    def test_explicit_candidate_field_with_gepa_contract_refuses_before_evaluation(self):
        """Keeps the legacy GEPA/flat-row mismatch actionable before budget spend."""
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            candidate_dir = root_path / "candidate"; scorer_dir = root_path / "scorer"
            candidate_dir.mkdir(); scorer_dir.mkdir()
            (candidate_dir / "manifest.json").write_text(json.dumps({"command": [sys.executable, "runner.py"]}))
            (scorer_dir / "manifest.json").write_text(json.dumps({"command": [sys.executable, "runner.py"]}))
            context = PromptContext(body="seed", body_kind="text", provider_settings={}, prompt_version_id="prompt-v", runner_version_id="runner-v")
            with self.assertRaisesRegex(RuntimeError, "active scorer input contract is 'gepa'"):
                RunnerEvaluationAdapter(candidate_runner_dir=str(candidate_dir), scorer_runner_dir=str(scorer_dir), run_id=None,
                                        prompt_context=context, scorer_context=context, scorer_candidate_field="draft_text")

    def test_runner_adapter_parallelizes_file_contract_evaluations_with_the_frozen_plan(self):
        """Kills production adapter serial evaluation despite a resolved multi-thread plan."""
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            candidate_dir = root_path / "candidate"; scorer_dir = root_path / "scorer"
            candidate_dir.mkdir(); scorer_dir.mkdir()
            (candidate_dir / "manifest.json").write_text(json.dumps({"command": [sys.executable, "runner.py"]}))
            (scorer_dir / "manifest.json").write_text(json.dumps({"command": [sys.executable, "runner.py"]}))
            (candidate_dir / "runner.py").write_text(
                "import json, os, time\n"
                "time.sleep(0.2)\n"
                "data=json.load(open(os.environ['ORIZU_RUNNER_INPUT_PATH']))\n"
                "json.dump({'model_response': data['row']['id']}, open(os.environ['ORIZU_RUNNER_OUTPUT_PATH'], 'w'))\n"
            )
            (scorer_dir / "runner.py").write_text(
                "import json, os\n"
                "json.dump({'score': 1.0}, open(os.environ['ORIZU_RUNNER_OUTPUT_PATH'], 'w'))\n"
            )
            context = PromptContext(body="seed", body_kind="text", provider_settings={}, prompt_version_id="prompt-v", runner_version_id="runner-v")
            adapter = RunnerEvaluationAdapter(candidate_runner_dir=str(candidate_dir), scorer_runner_dir=str(scorer_dir), run_id=RUN_ID, prompt_context=context, scorer_context=context, num_threads=2, validation_count=2)
            import time
            started = time.monotonic()
            result = adapter.evaluate([DatasetRow(id="one", row={"id": "one"}), DatasetRow(id="two", row={"id": "two"})], {"prompt": "better"})
            elapsed = time.monotonic() - started
        self.assertEqual(adapter.num_threads_plan.resolved, 2)
        self.assertEqual([output["row_id"] for output in result.outputs], ["one", "two"])
        self.assertLess(elapsed, 0.36)

    def test_real_runner_adapter_lets_official_gepa_generate_a_child_through_the_reflection_bridge(self):
        """Kills the missing GEPA adapter proposal attribute that swallowed every proposal."""
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            candidate_dir = root_path / "candidate"; scorer_dir = root_path / "scorer"
            candidate_dir.mkdir(); scorer_dir.mkdir()
            (candidate_dir / "manifest.json").write_text(json.dumps({"command": [sys.executable, "runner.py"]}))
            (scorer_dir / "manifest.json").write_text(json.dumps({"command": [sys.executable, "runner.py"]}))
            (candidate_dir / "runner.py").write_text(
                "import json, os\n"
                "data=json.load(open(os.environ['ORIZU_RUNNER_INPUT_PATH']))\n"
                "json.dump({'model_response': data['prompt']['body']}, open(os.environ['ORIZU_RUNNER_OUTPUT_PATH'], 'w'))\n"
            )
            (scorer_dir / "runner.py").write_text(
                "import json, os\n"
                "data=json.load(open(os.environ['ORIZU_RUNNER_INPUT_PATH']))\n"
                "score = 1.0 if data['row']['candidate_output'] == 'better' else 0.2\n"
                "json.dump({'score': score, 'feedback': 'recorded runner score'}, open(os.environ['ORIZU_RUNNER_OUTPUT_PATH'], 'w'))\n"
            )
            context = PromptContext(body="seed", body_kind="text", provider_settings={}, prompt_version_id="prompt", runner_version_id="runner")
            adapter = RunnerEvaluationAdapter(
                candidate_runner_dir=str(candidate_dir), scorer_runner_dir=str(scorer_dir), run_id=RUN_ID,
                prompt_context=context, scorer_context=context,
            )
            config = TextGepaConfig(max_iterations=1, minibatch_size=1, reflection_max_tokens=1024)
            reflection_lm = make_gepa_reflection_lm(
                context_supplier=lambda: (next(iter((adapter.last_candidate or {"prompt": "seed"}).values())), adapter.last_row_evaluations),
                config=config,
            )
            import orizu_gepa_connector.reflection as reflection
            with patch.object(reflection, "reflect_with_provider", return_value=SimpleNamespace(
                response="better", prompt="fake reflection",
                usage={"input_tokens": 17, "output_tokens": 5, "total_tokens": 22},
            )):
                result = run_official_gepa(
                    seed_candidate={"prompt": "seed"}, trainset=[DatasetRow(id="train", row={})],
                    valset=[DatasetRow(id="validation", row={})], adapter=adapter,
                    callback=OrizuCallback(RecordingSink(), RUN_ID), hooks=LifecycleHooks(),
                    max_metric_calls=8, stop_callbacks=[IterationBoundaryStopper(max_iterations=1)],
                    reflection_lm=reflection_lm, config=config,
                )
        self.assertEqual(result.best_idx, 1)
        self.assertEqual(result.candidates[1]["prompt"], "better")

    def test_real_gepa_seed_valset_wire_event_uses_adapter_row_ids_not_positions(self):
        """Kills seed enrichment that updates outputs but leaves GEPA's positional scores as wire IDs."""
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            candidate_dir = root_path / "candidate"; scorer_dir = root_path / "scorer"
            candidate_dir.mkdir(); scorer_dir.mkdir()
            (candidate_dir / "manifest.json").write_text(json.dumps({"command": [sys.executable, "runner.py"]}))
            (scorer_dir / "manifest.json").write_text(json.dumps({"command": [sys.executable, "runner.py"]}))
            (candidate_dir / "runner.py").write_text(
                "import json, os\n"
                "data=json.load(open(os.environ['ORIZU_RUNNER_INPUT_PATH']))\n"
                "json.dump({'model_response': data['prompt']['body']}, open(os.environ['ORIZU_RUNNER_OUTPUT_PATH'], 'w'))\n"
            )
            (scorer_dir / "runner.py").write_text(
                "import json, os\n"
                "data=json.load(open(os.environ['ORIZU_RUNNER_INPUT_PATH']))\n"
                "score = 1.0 if data['row']['candidate_output'] == 'better' else 0.2\n"
                "json.dump({'score': score, 'feedback': 'recorded runner score'}, open(os.environ['ORIZU_RUNNER_OUTPUT_PATH'], 'w'))\n"
            )
            context = PromptContext(body="seed", body_kind="text", provider_settings={}, prompt_version_id="prompt", runner_version_id="runner")
            adapter = RunnerEvaluationAdapter(
                candidate_runner_dir=str(candidate_dir), scorer_runner_dir=str(scorer_dir), run_id=RUN_ID,
                prompt_context=context, scorer_context=context,
            )
            sink = RecordingSink()
            callback = OrizuCallback(sink, RUN_ID)
            config = TextGepaConfig(max_iterations=1, minibatch_size=1, reflection_max_tokens=1024)
            reflection_lm = make_gepa_reflection_lm(
                context_supplier=lambda: (next(iter((adapter.last_candidate or {"prompt": "seed"}).values())), adapter.last_row_evaluations),
                config=config,
            )
            import orizu_gepa_connector.reflection as reflection
            with patch.object(reflection, "reflect_with_provider", return_value=SimpleNamespace(
                response="better", prompt="fake reflection",
                usage={"input_tokens": 17, "output_tokens": 5, "total_tokens": 22},
            )):
                run_official_gepa(
                    seed_candidate={"prompt": "seed"}, trainset=[DatasetRow(id="train-row", row={})],
                    valset=[DatasetRow(id="val-uuid-a", row={}), DatasetRow(id="val-uuid-b", row={})],
                    adapter=adapter, callback=callback, hooks=LifecycleHooks(), max_metric_calls=16,
                    stop_callbacks=[IterationBoundaryStopper(max_iterations=1)], reflection_lm=reflection_lm, config=config,
                )

        seed = next(event for event in sink.events if event["event_type"] == "seed_val_set_completed")
        self.assertEqual(
            [row["row_id"] for row in seed["payload"]["row_results"]],
            ["val-uuid-a", "val-uuid-b"],
        )

    def test_real_gepa_child_valset_wire_event_matches_exact_validation_row_ids(self):
        """Kills positional staged-evidence reattachment that substitutes train rows into child validation."""
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            candidate_dir = root_path / "candidate"; scorer_dir = root_path / "scorer"
            candidate_dir.mkdir(); scorer_dir.mkdir()
            (candidate_dir / "manifest.json").write_text(json.dumps({"command": [sys.executable, "runner.py"]}))
            (scorer_dir / "manifest.json").write_text(json.dumps({"command": [sys.executable, "runner.py"]}))
            (candidate_dir / "runner.py").write_text(
                "import json, os\n"
                "data=json.load(open(os.environ['ORIZU_RUNNER_INPUT_PATH']))\n"
                "json.dump({'model_response': {'text': data['prompt']['body'], 'source_id': data['row']['source_id']}}, open(os.environ['ORIZU_RUNNER_OUTPUT_PATH'], 'w'))\n"
            )
            (scorer_dir / "runner.py").write_text(
                "import json, os\n"
                "data=json.load(open(os.environ['ORIZU_RUNNER_INPUT_PATH']))\n"
                "score = 1.0 if data['row']['candidate_output']['text'] == 'better' else 0.2\n"
                "json.dump({'score': score, 'feedback': 'recorded runner score'}, open(os.environ['ORIZU_RUNNER_OUTPUT_PATH'], 'w'))\n"
            )
            context = PromptContext(body="seed", body_kind="text", provider_settings={}, prompt_version_id="prompt", runner_version_id="runner")
            adapter = RunnerEvaluationAdapter(
                candidate_runner_dir=str(candidate_dir), scorer_runner_dir=str(scorer_dir), run_id=RUN_ID,
                prompt_context=context, scorer_context=context,
            )
            sink = RecordingSink()
            callback = OrizuCallback(sink, RUN_ID)
            config = TextGepaConfig(max_iterations=1, minibatch_size=2, reflection_max_tokens=1024)
            reflection_lm = make_gepa_reflection_lm(
                context_supplier=lambda: (next(iter((adapter.last_candidate or {"prompt": "seed"}).values())), adapter.last_row_evaluations),
                config=config,
            )
            import orizu_gepa_connector.reflection as reflection
            with patch.object(reflection, "reflect_with_provider", return_value=SimpleNamespace(
                response="better", prompt="fake reflection",
                usage={"input_tokens": 17, "output_tokens": 5, "total_tokens": 22},
            )):
                run_official_gepa(
                    seed_candidate={"prompt": "seed"},
                    trainset=[DatasetRow(id="train-uuid-a", row={"source_id": "train-uuid-a"}), DatasetRow(id="train-uuid-b", row={"source_id": "train-uuid-b"})],
                    valset=[DatasetRow(id="val-uuid-a", row={"source_id": "val-uuid-a"}), DatasetRow(id="val-uuid-b", row={"source_id": "val-uuid-b"})],
                    adapter=adapter, callback=callback, hooks=LifecycleHooks(), max_metric_calls=24,
                    stop_callbacks=[IterationBoundaryStopper(max_iterations=1)], reflection_lm=reflection_lm, config=config,
                )

        child = next(event for event in sink.events if event["event_type"] == "child_val_set_completed")
        self.assertEqual(
            [row["row_id"] for row in child["payload"]["row_results"]],
            ["val-uuid-a", "val-uuid-b"],
        )
        self.assertEqual(
            [row["output"]["source_id"] for row in child["payload"]["row_results"]],
            ["val-uuid-a", "val-uuid-b"],
        )

    def test_real_callback_buffers_a_proposal_until_gepa_assigns_the_child_id(self):
        """Kills a callback that emits reflection before the lineage can join it."""
        sink = RecordingSink()
        callback = OrizuCallback(sink, RUN_ID, log_row_snapshots=True)
        callback.on_optimization_start({"seed_candidate": {"prompt": "seed"}, "trainset_size": 1, "valset_size": 1, "config": {}})
        callback.on_iteration_start({"iteration": 1})
        callback.on_candidate_selected({"iteration": 1, "candidate_idx": 0, "candidate": {"prompt": "seed"}, "score": 0.2})
        callback.on_proposal_end({"iteration": 1, "new_instructions": {"prompt": "better"}, "prompts": {"prompt": "why"}, "raw_lm_outputs": {"prompt": "better"}})
        self.assertEqual([event["event_type"] for event in sink.events], ["run_started", "iteration_started"])
        callback.on_candidate_accepted({"iteration": 1, "new_candidate_idx": 1, "new_score": 0.9, "parent_ids": [0]})
        self.assertEqual([event["event_type"] for event in sink.events], ["run_started", "iteration_started", "candidate_proposed", "reflection_completed", "acceptance_decision_made"])
        self.assertEqual(sink.events[2]["candidate_id"], "1")
        self.assertEqual(sink.events[2]["parent_candidate_id"], "0")
        self.assertEqual(sink.events[3]["payload"]["response"], "better")

    def test_production_callback_redacts_only_prompt_and_bounds_large_event_fields(self):
        """Kills legacy-incompatible response/candidate redaction and truncation bypass."""
        sink = RecordingSink()
        callback = OrizuCallback(sink, RUN_ID, max_payload_chars=8)
        callback.on_candidate_selected({"iteration": 1, "candidate_idx": 0})
        callback.on_proposal_end({"iteration": 1, "new_instructions": {"prompt": "x" * 40},
                                  "prompts": {"prompt": "secret prompt"},
                                  "raw_lm_outputs": {"prompt": "secret response"}})
        callback.on_candidate_accepted({"iteration": 1, "new_candidate_idx": 1})
        proposed, reflection = sink.events[:2]
        self.assertTrue(proposed["payload"]["payload_truncated"])
        self.assertTrue(proposed["payload"]["body"].endswith("…[truncated]"))
        self.assertNotIn("prompt", reflection["payload"])
        self.assertEqual(reflection["payload"]["response"], "secret response")
        self.assertEqual(reflection["payload"]["candidate_text"], "xxxxxxxx…[truncated]")

    def test_full_valset_evaluation_is_not_published_as_a_parent_minibatch(self):
        """Kills a child full validation published as a train minibatch before its valset event."""
        sink = RecordingSink()
        callback = OrizuCallback(sink, RUN_ID)
        callback.on_optimization_start({"seed_candidate": {"prompt": "seed"}, "trainset_size": 1, "valset_size": 2, "config": {}})
        callback.on_evaluation_start({"iteration": 1, "inputs": [{"id": "val-1"}, {"id": "val-2"}]})
        callback.on_evaluation_end({
            "iteration": 1, "candidate_idx": 1, "is_seed_candidate": False,
            "scores": [0.7, 0.8], "outputs": [], "trajectories": [],
        })
        callback.on_valset_evaluated({
            "iteration": 1, "candidate_idx": 1, "candidate": {"prompt": "child"},
            "scores_by_val_id": {"val-1": 0.7, "val-2": 0.8}, "average_score": 0.75,
            "outputs_by_val_id": {}, "parent_ids": [0],
        })
        self.assertEqual([event["event_type"] for event in sink.events], ["run_started", "child_val_set_completed"])

    def test_parent_minibatch_equal_to_valset_size_stays_a_parent_minibatch(self):
        """Kills row-count inference that turns an equal-size minibatch into child validation."""
        from orizu_gepa.local_log import LocalOptimizationLogger

        with tempfile.TemporaryDirectory() as root:
            logger = LocalOptimizationLogger.create(root, RUN_ID)
            sink = RecordingSink(); sink.local_logger = logger
            callback = OrizuCallback(sink, RUN_ID)
            callback.on_optimization_start({"valset_size": 3})
            callback.on_candidate_selected({"iteration": 1, "candidate_idx": 0})
            rows = [DatasetRow(id=f"row-{index}", row={}) for index in range(3)]
            callback.on_evaluation_start({"iteration": 1, "inputs": rows})
            callback.on_evaluation_end({
                "iteration": 1, "candidate_idx": 0, "is_seed_candidate": True,
                "scores": [0.2, 0.3, 0.4], "outputs": [{"output": "seed"}] * 3,
            })
            callback.on_evaluation_skipped({"iteration": 1, "candidate_idx": 0, "reason": "perfect", "scores": [0.2]})
            record = json.loads((Path(root) / RUN_ID / "evaluations.jsonl").read_text().splitlines()[0])

        self.assertEqual(record["stage"], "parent_minibatch")
        self.assertEqual(record["candidate_id"], "0")

    def test_real_callback_shapes_gepa_evaluations_as_dashboard_minibatches(self):
        """Kills generic evaluation events that the existing derivation ignores."""
        sink = RecordingSink()
        callback = OrizuCallback(sink, RUN_ID)
        callback.on_candidate_selected({"iteration": 1, "candidate_idx": 0, "candidate": {"prompt": "seed"}, "score": 0.2})
        callback.on_evaluation_start({"iteration": 1, "inputs": [{"id": "parent-row"}]})
        callback.on_evaluation_end({"iteration": 1, "candidate_idx": 0, "is_seed_candidate": True, "scores": [0.2], "outputs": [{"answer": "seed"}], "trajectories": [{"Feedback": "improve", "output": "seed"}]})
        callback.on_proposal_start({"iteration": 1, "parent_candidate": {"prompt": "seed"}, "components": ["prompt"], "reflective_dataset": {}})
        callback.on_proposal_end({"iteration": 1, "new_instructions": {"prompt": "better"}, "prompts": {"prompt": "why"}, "raw_lm_outputs": {"prompt": "better"}})
        callback.on_evaluation_start({"iteration": 1, "inputs": [{"id": "child-row"}]})
        callback.on_evaluation_end({"iteration": 1, "candidate_idx": None, "is_seed_candidate": False, "scores": [0.9], "outputs": [{"answer": "better"}], "trajectories": [{"Feedback": "better", "output": "better"}]})
        callback.on_candidate_accepted({"iteration": 1, "new_candidate_idx": 1, "new_score": 0.9, "parent_ids": [0]})
        names = [event["event_type"] for event in sink.events]
        self.assertEqual(names, ["parent_minibatch_completed", "proposal_start", "candidate_proposed", "reflection_completed", "child_minibatch_completed", "acceptance_decision_made"])
        self.assertEqual(sink.events[0]["payload"]["row_results"][0]["feedback"], "improve")
        self.assertEqual(sink.events[0]["payload"]["row_results"][0]["row_id"], "parent-row")
        self.assertEqual(sink.events[-1]["payload"], {"accepted": True, "proceed_to_valset": True, "parent_score_total": 0.2, "child_score_total": 0.9})

    def test_child_minibatch_artifact_rows_use_the_assigned_candidate_id(self):
        """Kills append-only child evidence left at its pending-iteration placeholder."""
        from orizu_gepa.local_log import LocalOptimizationLogger

        with tempfile.TemporaryDirectory() as root:
            logger = LocalOptimizationLogger.create(root, RUN_ID)
            sink = RecordingSink(); sink.local_logger = logger
            callback = OrizuCallback(sink, RUN_ID)
            callback.on_candidate_selected({"iteration": 3, "candidate_idx": 0})
            callback.on_evaluation_start({"iteration": 3, "inputs": [DatasetRow(id="child-train-row", row={})]})
            callback.on_evaluation_end({
                "iteration": 3, "candidate_idx": None, "is_seed_candidate": False,
                "scores": [0.9], "outputs": [{"row_id": "child-train-row", "output": "better"}],
                "trajectories": [{"Feedback": "better"}],
            })
            callback.on_candidate_accepted({"iteration": 3, "new_candidate_idx": 5, "new_score": 0.9})
            rows = [json.loads(line) for line in (Path(root) / RUN_ID / "evaluations.jsonl").read_text().splitlines()]

        child_rows = [row for row in rows if row["stage"] == "child_minibatch"]
        self.assertEqual([row["candidate_id"] for row in child_rows], ["5"])
        self.assertEqual([row["parent_candidate_id"] for row in child_rows], ["0"])

    def test_child_valset_artifact_tolerates_anomalous_scores_and_absent_parent(self):
        """Kills one malformed callback row escalating to a failed local-log write."""
        from orizu_gepa.local_log import LocalOptimizationLogger

        with tempfile.TemporaryDirectory() as root:
            logger = LocalOptimizationLogger.create(root, RUN_ID)
            sink = RecordingSink(); sink.local_logger = logger
            callback = OrizuCallback(sink, RUN_ID)
            callback.on_valset_evaluated({
                "iteration": 2, "candidate_idx": 5,
                "scores_by_val_id": {"valid": 0.9, "malformed": None},
                "outputs_by_val_id": {"valid": {"output": "ok"}, "malformed": {"output": "bad"}},
                "parent_ids": [],
            })
            rows = [json.loads(line) for line in (Path(root) / RUN_ID / "evaluations.jsonl").read_text().splitlines()]

        self.assertFalse(callback.logging_failed)
        self.assertEqual({row["parent_candidate_id"] for row in rows}, {None})
        malformed = next(row for row in rows if row["row_id"] == "malformed")
        self.assertEqual(malformed["score"], 0.0)
        self.assertIn("invalid scorer score", malformed["error"])

    def test_child_valset_artifact_uses_safe_defaults_for_missing_identity_keys(self):
        """Kills direct callback-key reads that turn one incomplete row into a failed run."""
        from orizu_gepa.local_log import LocalOptimizationLogger

        with tempfile.TemporaryDirectory() as root:
            logger = LocalOptimizationLogger.create(root, RUN_ID)
            sink = RecordingSink(); sink.local_logger = logger
            callback = OrizuCallback(sink, RUN_ID)
            callback.on_valset_evaluated({
                "scores_by_val_id": {"row": 0.9},
                "outputs_by_val_id": {"row": {"output": "ok"}},
            })
            row = json.loads((Path(root) / RUN_ID / "evaluations.jsonl").read_text().splitlines()[0])

        self.assertFalse(callback.logging_failed)
        self.assertEqual(row["iteration"], 0)
        self.assertEqual(row["candidate_id"], "unknown")
        self.assertIn("missing candidate_idx", row["error"])

    def test_rejected_gepa_child_still_materializes_its_minibatch_rows(self):
        """Kills the accepted-only flush that hides rejected child evidence."""
        sink = RecordingSink()
        callback = OrizuCallback(sink, RUN_ID)
        callback.on_candidate_selected({"iteration": 2, "candidate_idx": 0, "candidate": {"prompt": "seed"}, "score": 0.2})
        callback.on_evaluation_start({"iteration": 2, "inputs": [{"id": "parent-row"}]})
        callback.on_evaluation_end({"iteration": 2, "candidate_idx": 0, "is_seed_candidate": True, "scores": [0.2], "outputs": [], "trajectories": []})
        callback.on_evaluation_start({"iteration": 2, "inputs": [{"id": "rejected-child-row"}]})
        callback.on_evaluation_end({"iteration": 2, "candidate_idx": None, "is_seed_candidate": False, "scores": [0.1], "outputs": [{"row_id": "rejected-child-row", "output": "bad"}], "trajectories": [{"Feedback": "bad", "output": "bad"}]})
        callback.on_candidate_rejected({"iteration": 2, "old_score": 0.2, "new_score": 0.1, "reason": "worse"})
        self.assertEqual([event["event_type"] for event in sink.events], ["parent_minibatch_completed", "child_minibatch_completed", "acceptance_decision_made"])
        self.assertEqual(sink.events[1]["payload"]["row_results"][0]["row_id"], "rejected-child-row")
        self.assertFalse(sink.events[-1]["payload"]["accepted"])

    def test_rejected_decision_uses_buffered_raw_score_totals_not_gepa_internal_scores(self):
        """Kills lower-is-better rejection totals being overwritten by inverted GEPA values."""
        translated = translate_callback("on_candidate_rejected", {
            "iteration": 2, "candidate_idx": "rejected-2", "old_score": 0.8, "new_score": 0.1,
            "parent_score_total": 0.2, "child_score_total": 0.9, "reason": "worse",
        }, run_id=RUN_ID)
        self.assertEqual(translated["payload"]["parent_score_total"], 0.2)
        self.assertEqual(translated["payload"]["child_score_total"], 0.9)

    def test_rejected_proposal_keeps_lineage_and_reflection_before_its_decision(self):
        """Kills a rejection path that hides the proposal solely because GEPA lacks an id."""
        sink = RecordingSink()
        callback = OrizuCallback(sink, RUN_ID)
        callback.on_candidate_selected({"iteration": 3, "candidate_idx": 0, "candidate": {"prompt": "seed"}, "score": 0.2})
        callback.on_proposal_end({"iteration": 3, "new_instructions": {"prompt": "worse"}, "prompts": {"prompt": "why"}, "raw_lm_outputs": {"prompt": "worse"}})
        callback.on_candidate_rejected({"iteration": 3, "old_score": 0.2, "new_score": 0.1, "reason": "worse"})
        self.assertEqual([event["event_type"] for event in sink.events], ["candidate_proposed", "reflection_completed", "acceptance_decision_made"])
        self.assertEqual(sink.events[0]["candidate_id"], "rejected-3")

    def test_callback_diagnostics_preserve_reflection_error_and_skip_mean(self):
        """Kills empty GEPA diagnostics and a list-valued reflection-skipped mean."""
        sink = RecordingSink()
        callback = OrizuCallback(sink, RUN_ID)
        callback.on_error({"iteration": 1, "exception": RuntimeError("reflection timeout"), "will_continue": False})
        callback.on_evaluation_skipped({"iteration": 1, "candidate_idx": 0, "reason": "perfect", "scores": [0.8, 1.0], "is_seed_candidate": False})
        self.assertEqual(sink.events[0]["event_type"], "reflection_failed")
        self.assertEqual(sink.events[0]["payload"]["message"], "reflection timeout")
        self.assertEqual(sink.events[1]["payload"]["parent_score_mean"], 0.9)

    def test_real_gepa_engine_invokes_the_production_callback(self):
        """Kills production callback methods that only unit-shaped events reach."""
        sink = RecordingSink()
        callback = OrizuCallback(sink, RUN_ID)
        callback.validation_row_ids = ["validation"]
        optimize(seed_candidate={"prompt": "seed"}, trainset=[{"id": "train"}], valset=[{"id": "validation"}],
                 adapter=DeterministicAdapter(), max_metric_calls=8, callbacks=[callback],
                 display_progress_bar=False, raise_on_exception=True)
        names = [event["event_type"] for event in sink.events]
        self.assertIn("seed_val_set_completed", names)
        self.assertIn("parent_minibatch_completed", names)
        self.assertIn("child_minibatch_completed", names)

    def test_real_gepa_budget_terminal_event_suppresses_completed_lifecycle_event(self):
        """Kills a terminal pause gate keyed to a fabricated GEPA event shape."""
        config = TextGepaConfig(max_metric_calls=1)
        budget = Budget.from_config(config, trainset_size=1, valset_size=1)
        sink = RecordingSink()
        observed_terminal_events: list[dict[str, object]] = []
        terminal_decisions: list[bool] = []

        def terminal_budget_exhausted(event):
            observed_terminal_events.append(event)
            decision = runtime._terminal_budget_exhausted(
                event,
                config=config,
                budget=budget,
                preflight_metric_calls=0,
                candidate_proposals=0,
            )
            terminal_decisions.append(decision)
            return decision

        callback = OrizuCallback(sink, RUN_ID, terminal_budget_exhausted=terminal_budget_exhausted)
        optimize(seed_candidate={"prompt": "seed"}, trainset=[{"id": "train"}], valset=[{"id": "validation"}],
                 adapter=DeterministicAdapter(), max_metric_calls=1, callbacks=[callback],
                 display_progress_bar=False, raise_on_exception=True)

        self.assertEqual(set(observed_terminal_events[0]), {
            "best_candidate_idx", "total_iterations", "total_metric_calls", "final_state",
        })
        self.assertEqual(observed_terminal_events[0]["total_metric_calls"], 1)
        self.assertEqual(terminal_decisions, [True])
        self.assertNotIn("run_completed", [event["event_type"] for event in sink.events])

    def test_real_production_run_note_sink_durably_posts_the_merge_refusal(self):
        """Kills a no-op production run_note path hidden by an injected translator sink."""
        from orizu_gepa.local_log import LocalOptimizationLogger

        with tempfile.TemporaryDirectory() as root:
            client = RecordingClient()
            sink = MandatoryEventSink(client, RUN_ID, LocalOptimizationLogger.create(root, RUN_ID))
            callback = OrizuCallback(sink, RUN_ID)
            with self.assertRaisesRegex(ValueError, "unsupported GEPA merge"):
                callback.on_merge_attempted({"iteration": 1, "parent_ids": [0, 1], "merged_candidate": {"prompt": "merged"}})
            local_events = [json.loads(line) for line in (Path(root) / RUN_ID / "events.jsonl").read_text().splitlines()]
        self.assertEqual(client.events[0]["event_type"], "run_note")
        self.assertEqual(local_events[0]["event_type"], "run_note")
        self.assertEqual(local_events[0]["payload"]["code"], "unsupported_gepa_merge")

    def test_production_sink_reserves_a_server_sequence_between_connector_events(self):
        """Kills local +1 sequencing that collides with a live promotion event."""
        from orizu_gepa.local_log import LocalOptimizationLogger

        with tempfile.TemporaryDirectory() as root:
            client = RecordingClient()
            sink = MandatoryEventSink(client, RUN_ID, LocalOptimizationLogger.create(root, RUN_ID))
            sink.emit("run_started", {})
            # A real promotion route writes sequence 2 after the first POST.
            sink.emit("iteration_started", {}, iteration=1)
        self.assertEqual([event["sequence"] for event in client.events], [1, 3])

    def test_durable_logging_failure_cannot_be_promoted_to_success_after_gepa_returns(self):
        """Kills the post-engine success PATCH that masks GEPA's swallowed callback error."""
        sink = SimpleNamespace(failed=True)
        callback = SimpleNamespace(logging_failed=False)
        with self.assertRaisesRegex(RuntimeError, "mandatory event logging failed"):
            require_durable_logging(sink, callback)

    def test_reflection_bridge_reads_the_current_gepa_parent_context_per_call(self):
        """Kills a bridge pinned to the seed rows for every later GEPA proposal."""
        import orizu_gepa_connector.reflection as reflection

        seed_rows = [RowEvaluation("seed-row", {}, "seed", 0.2, "feedback")]
        selected_rows = [RowEvaluation("selected-row", {}, "selected", 0.2, "feedback")]
        context = ["seed", seed_rows]
        seen = []
        original = reflection.reflect_with_provider
        class Result:
            response = "new prompt"
            usage = {"input_tokens": 17, "output_tokens": 5, "total_tokens": 22}
        try:
            reflection.reflect_with_provider = lambda parent, rows, config: (seen.append((parent, rows)) or Result())
            lm = make_gepa_reflection_lm(
                context_supplier=lambda: (context[0], context[1]), config=TextGepaConfig(reflection_max_tokens=1024),
            )
            lm("ignored by the frozen provider layer")
            context[:] = ["selected parent", selected_rows]
            lm("ignored again")
        finally:
            reflection.reflect_with_provider = original
        self.assertEqual(seen, [("seed", seed_rows), ("selected parent", selected_rows)])

    def test_real_gepa_loop_durably_records_a_swallowed_reflection_exception(self):
        """Kills a pass-through reflection bridge whose error GEPA swallows."""
        import orizu_gepa_connector.reflection as reflection
        from orizu_gepa.local_log import LocalOptimizationLogger

        class SentinelReflectionError(RuntimeError):
            pass

        with tempfile.TemporaryDirectory() as root:
            client = DurableRecordingClient()
            logger = LocalOptimizationLogger.create(root, RUN_ID)
            sink = MandatoryEventSink(client, RUN_ID, logger)
            callback = OrizuCallback(sink, RUN_ID)
            rows = [RowEvaluation("recorded-row", {"source": "recorded"}, {"answer": "seed"}, 0.2, "Use better")]
            original = reflection.reflect_with_provider
            try:
                def raise_sentinel(_parent, _rows, _config):
                    raise SentinelReflectionError("recorded reflective payload cannot be parsed")

                reflection.reflect_with_provider = raise_sentinel
                reflection_lm = make_gepa_reflection_lm(
                    context_supplier=lambda: ("x" * 23017, rows),
                    config=TextGepaConfig(reflection_max_tokens=1024),
                    failure_reporter=callback.record_reflection_failure,
                )
                run_official_gepa(
                    seed_candidate={"prompt": "seed"}, trainset=[{"id": "train"}], valset=[{"id": "validation"}],
                    adapter=ReflectionOnlyAdapter(), callback=callback, hooks=LifecycleHooks(),
                    max_metric_calls=8, reflection_lm=reflection_lm, seed_already_validated=True,
                )
            finally:
                reflection.reflect_with_provider = original
            event_rows = [json.loads(line) for line in (Path(root) / RUN_ID / "events.jsonl").read_text().splitlines()]
            reflection_rows = [json.loads(line) for line in (Path(root) / RUN_ID / "reflections.jsonl").read_text().splitlines()]

        failed = next(event for event in event_rows if event["event_type"] == "reflection_failed")
        self.assertEqual(failed["payload"]["error_type"], "SentinelReflectionError")
        self.assertEqual(failed["payload"]["message"], "recorded reflective payload cannot be parsed")
        self.assertEqual(failed["payload"]["parent_text_chars"], 4)
        self.assertEqual(failed["payload"]["parent_result_count"], 1)
        self.assertEqual(reflection_rows[0]["status"], "failed")
        self.assertEqual(reflection_rows[0]["error_type"], "SentinelReflectionError")
        run_note = next(event for event in client.events if event["event_type"] == "run_note")
        self.assertIn("reflection failed: SentinelReflectionError", run_note["payload"]["message"])

    def test_reflection_prompt_validation_failure_is_captured_before_gepa_can_swallow_it(self):
        """Kills a prompt-builder exception outside the durable reflection failure boundary."""
        from orizu_gepa.local_log import LocalOptimizationLogger

        with tempfile.TemporaryDirectory() as root:
            client = DurableRecordingClient()
            sink = MandatoryEventSink(client, RUN_ID, LocalOptimizationLogger.create(root, RUN_ID))
            callback = OrizuCallback(sink, RUN_ID)
            lm = make_gepa_reflection_lm(
                context_supplier=lambda: ("seed", [RowEvaluation("blank-feedback", {}, "output", 0.2, None)]),
                config=TextGepaConfig(reflection_max_tokens=1024),
                failure_reporter=callback.record_reflection_failure,
            )
            with self.assertRaisesRegex(ValueError, "Scorer feedback is required"):
                lm("GEPA-owned renderer input")
            events = [json.loads(line) for line in (Path(root) / RUN_ID / "events.jsonl").read_text().splitlines()]

        failure = next(event for event in events if event["event_type"] == "reflection_failed")
        self.assertEqual(failure["payload"]["error_type"], "ValueError")
        self.assertIn("Scorer feedback is required", failure["payload"]["message"])
        run_note = next(event for event in client.events if event["event_type"] == "run_note")
        self.assertIn("reflection failed: ValueError", run_note["payload"]["message"])

    def test_reflection_usage_validation_failure_is_durably_recorded(self):
        """Kills provider-usage validation outside the durable reflection failure boundary."""
        import orizu_gepa_connector.reflection as reflection
        from orizu_gepa.local_log import LocalOptimizationLogger

        with tempfile.TemporaryDirectory() as root:
            client = DurableRecordingClient()
            sink = MandatoryEventSink(client, RUN_ID, LocalOptimizationLogger.create(root, RUN_ID))
            callback = OrizuCallback(sink, RUN_ID)
            lm = make_gepa_reflection_lm(
                context_supplier=lambda: ("seed", []),
                config=TextGepaConfig(reflection_max_tokens=1024),
                failure_reporter=callback.record_reflection_failure,
            )
            with patch.object(reflection, "reflect_with_provider", return_value=SimpleNamespace(
                response="improved",
                prompt="provider prompt",
                usage=None,
            )), self.assertRaisesRegex(RuntimeError, "ALI_1505_PROVIDER_USAGE_MISSING"):
                lm("GEPA-owned renderer input")
            events = [json.loads(line) for line in (Path(root) / RUN_ID / "events.jsonl").read_text().splitlines()]

        failure = next(event for event in events if event["event_type"] == "reflection_failed")
        self.assertIn("ALI_1505_PROVIDER_USAGE_MISSING", failure["payload"]["message"])

    def test_provider_error_codes_survive_in_the_durable_failure_message(self):
        """Kills provider exceptions whose stable code exists only on a discarded attribute."""
        import orizu_gepa_connector.reflection as reflection
        from orizu_gepa.local_log import LocalOptimizationLogger

        for error_type, code in (
            (ReflectionProviderError, "ALI_1505_PROVIDER_HTTP_FAILURE"),
            (RetryableReflectionProviderError, "ALI_1505_PROVIDER_TIMEOUT"),
        ):
            with self.subTest(error_type=error_type.__name__), tempfile.TemporaryDirectory() as root:
                client = DurableRecordingClient()
                sink = MandatoryEventSink(client, RUN_ID, LocalOptimizationLogger.create(root, RUN_ID))
                callback = OrizuCallback(sink, RUN_ID)
                lm = make_gepa_reflection_lm(
                    context_supplier=lambda: ("seed", []),
                    config=TextGepaConfig(reflection_max_tokens=1024),
                    failure_reporter=callback.record_reflection_failure,
                )
                provider_error = error_type(code, "provider rejected the request")
                with patch.object(reflection, "reflect_with_provider", side_effect=provider_error), \
                     self.assertRaises(error_type):
                    lm("GEPA-owned renderer input")
                events = [
                    json.loads(line)
                    for line in (Path(root) / RUN_ID / "events.jsonl").read_text().splitlines()
                ]

            failure = next(event for event in events if event["event_type"] == "reflection_failed")
            self.assertIn(code, failure["payload"]["message"])

    def test_openai_refusal_still_counts_provider_reported_usage(self):
        """Kills HTTP-200 refusal handling that drops usage before raising the missing-output error."""
        class RefusalResponse:
            headers = {"x-request-id": "req_openai_refusal"}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return json.dumps({
                    "id": "resp_refusal",
                    "status": "incomplete",
                    "output": [{
                        "type": "message",
                        "status": "incomplete",
                        "content": [{"type": "refusal", "refusal": "cannot comply"}],
                    }],
                    "usage": {"input_tokens": 31, "output_tokens": 2, "total_tokens": 33},
                }).encode("utf-8")

        lm = make_gepa_reflection_lm(
            context_supplier=lambda: ("seed", []),
            config=TextGepaConfig(
                reflection_model="openai/gpt-test",
                reflection_max_tokens=128,
            ),
        )
        with patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"}), \
             patch("orizu_gepa.reflection.urllib.request.urlopen", return_value=RefusalResponse()), \
             self.assertRaisesRegex(ReflectionProviderError, "ALI_1505_OPENAI_OUTPUT_TEXT_MISSING"):
            lm("GEPA-owned renderer input")

        self.assertEqual(lm.total_tokens_in, 31)
        self.assertEqual(lm.total_tokens_out, 2)
        self.assertEqual(lm.total_tokens, 33)

    def test_official_gepa_writes_the_frozen_local_artifact_set_and_reflection_usage(self):
        """Kills official event-only logging that omits local evaluation, result, and LM evidence."""
        from orizu_gepa.local_log import LocalOptimizationLogger

        with tempfile.TemporaryDirectory() as root:
            client = DurableRecordingClient()
            logger = LocalOptimizationLogger.create(root, RUN_ID)
            sink = MandatoryEventSink(client, RUN_ID, logger)
            callback = OrizuCallback(sink, RUN_ID)
            rows = [RowEvaluation("recorded-row", {"source": "recorded"}, {"answer": "seed"}, 0.2, "Use better")]
            reflection_lm = make_gepa_reflection_lm(
                context_supplier=lambda: ("recorded prompt", rows),
                config=TextGepaConfig(reflection_max_tokens=1024),
                failure_reporter=callback.record_reflection_failure,
            )
            import orizu_gepa_connector.reflection as reflection
            original = reflection.reflect_with_provider
            try:
                reflection.reflect_with_provider = lambda *_args: SimpleNamespace(
                    response="better", prompt="recorded prompt",
                    usage={"input_tokens": 17, "output_tokens": 5, "total_tokens": 22},
                )
                result = run_official_gepa(
                    seed_candidate={"prompt": "seed"}, trainset=[{"id": "train"}], valset=[{"id": "validation"}],
                    adapter=ReflectionOnlyAdapter(), callback=callback, hooks=LifecycleHooks(),
                    max_metric_calls=8, reflection_lm=reflection_lm, seed_already_validated=True,
                )
            finally:
                reflection.reflect_with_provider = original
            run_dir = Path(root) / RUN_ID
            evaluations = [json.loads(line) for line in (run_dir / "evaluations.jsonl").read_text().splitlines()]
            reflections = [json.loads(line) for line in (run_dir / "reflections.jsonl").read_text().splitlines()]

        self.assertEqual(result.best_idx, 1)
        self.assertIn(evaluations[0]["stage"], {"seed_val_set", "parent_minibatch", "child_minibatch", "child_val_set"})
        self.assertIn("row_id", evaluations[0])
        self.assertEqual(reflections[0]["candidate_text"], "better")

    def test_accepted_child_full_valset_keeps_its_own_local_stage_and_telemetry(self):
        """Kills a child full validation rewritten as the seed's local evidence."""
        from orizu_gepa.local_log import LocalOptimizationLogger

        with tempfile.TemporaryDirectory() as root:
            logger = LocalOptimizationLogger.create(root, RUN_ID)
            sink = RecordingSink()
            sink.local_logger = logger
            callback = OrizuCallback(sink, RUN_ID)
            callback.on_evaluation_start({"iteration": 1, "inputs": [DatasetRow(id="child-val-row", row={})]})
            callback.on_evaluation_end({
                "iteration": 1, "candidate_idx": 4, "is_seed_candidate": False,
                "scores": [0.8], "outputs": [{"row_id": "child-val-row", "output": {"answer": "child"}}],
                "trajectories": [],
            })
            callback.on_valset_evaluated({
                "iteration": 1, "candidate_idx": 4, "candidate": {"prompt": "child"},
                "scores_by_val_id": {"child-val-row": 0.8}, "average_score": 0.8, "parent_ids": [0],
                "outputs_by_val_id": {"child-val-row": {
                    "row_id": "child-val-row", "output": {"answer": "child"},
                    "raw_score": 0.8, "feedback": "improved", "cached": True,
                    "latency_ms": 12, "token_in": 3, "token_out": 5,
                    "cost_usd": 0.01, "error_source": None,
                }},
            })
            records = [json.loads(line) for line in (Path(root) / RUN_ID / "evaluations.jsonl").read_text().splitlines()]

        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["stage"], "child_val_set")
        self.assertEqual(records[0]["candidate_id"], "4")
        self.assertEqual(records[0]["iteration"], 1)
        self.assertEqual(records[0]["output"], {"answer": "child"})
        self.assertEqual(
            {name: records[0][name] for name in ("latency_ms", "token_in", "token_out", "cost_usd", "cached", "error_source")},
            {"latency_ms": 12, "token_in": 3, "token_out": 5, "cost_usd": 0.01, "cached": True, "error_source": None},
        )

    def test_child_valset_artifact_uses_the_adapter_row_id_not_gepas_positional_id(self):
        """Kills local artifacts that lose the runner's stable row identity."""
        from orizu_gepa.local_log import LocalOptimizationLogger

        with tempfile.TemporaryDirectory() as root:
            logger = LocalOptimizationLogger.create(root, RUN_ID)
            sink = RecordingSink(); sink.local_logger = logger
            callback = OrizuCallback(sink, RUN_ID)
            callback.on_valset_evaluated({
                "iteration": 1, "candidate_idx": 4, "candidate": {"prompt": "child"},
                "scores_by_val_id": {0: 0.8}, "average_score": 0.8, "parent_ids": [0],
                "outputs_by_val_id": {0: {"row_id": "adapter-row-id", "output": "child"}},
            })
            record = json.loads((Path(root) / RUN_ID / "evaluations.jsonl").read_text().splitlines()[0])

        self.assertEqual(record["row_id"], "adapter-row-id")

    def test_child_valset_reattaches_staged_adapter_evidence(self):
        """Kills a full child valset artifact that drops the adapter's only row evidence."""
        from orizu_gepa.local_log import LocalOptimizationLogger

        with tempfile.TemporaryDirectory() as root:
            logger = LocalOptimizationLogger.create(root, RUN_ID)
            sink = RecordingSink(); sink.local_logger = logger
            callback = OrizuCallback(sink, RUN_ID)
            callback.on_evaluation_start({"iteration": 1, "inputs": [DatasetRow(id="child-row", row={})]})
            callback.on_evaluation_end({
                "iteration": 1, "candidate_idx": 4, "is_seed_candidate": False,
                "scores": [0.8], "trajectories": [],
                "outputs": [{
                    "row_id": "child-row", "output": {"answer": "child"}, "feedback": "improved",
                    "scorer_output": {"score": 0.8}, "latency_ms": 12, "token_in": 3,
                    "token_out": 5, "cost_usd": 0.01, "cached": True,
                }],
            })
            callback.on_valset_evaluated({
                "iteration": 1, "candidate_idx": 4, "candidate": {"prompt": "child"},
                "scores_by_val_id": {0: 0.8}, "average_score": 0.8, "parent_ids": [0],
                "outputs_by_val_id": {},
            })
            record = json.loads((Path(root) / RUN_ID / "evaluations.jsonl").read_text().splitlines()[0])

        self.assertEqual(record["stage"], "child_val_set")
        self.assertEqual(record["output"], {"answer": "child"})
        self.assertEqual(record["feedback"], "improved")
        self.assertEqual(record["scorer_response"], {"score": 0.8})
        self.assertEqual(
            {name: record[name] for name in ("latency_ms", "token_in", "token_out", "cost_usd", "cached")},
            {"latency_ms": 12, "token_in": 3, "token_out": 5, "cost_usd": 0.01, "cached": True},
        )

    def test_child_valset_uses_the_latest_staged_evaluation_not_train_row_position(self):
        """Kills staged-evidence flattening that treats train order as valset identity."""
        sink = RecordingSink()
        callback = OrizuCallback(sink, RUN_ID)
        callback.on_evaluation_start({"iteration": 1, "inputs": [DatasetRow(id="train-row", row={})]})
        callback.on_evaluation_end({
            "iteration": 1, "candidate_idx": 4, "is_seed_candidate": False,
            "scores": [0.1], "outputs": [{"row_id": "train-row", "output": "train"}],
        })
        callback.on_evaluation_start({"iteration": 1, "inputs": [DatasetRow(id="val-row", row={})]})
        callback.on_evaluation_end({
            "iteration": 1, "candidate_idx": 4, "is_seed_candidate": False,
            "scores": [0.8], "outputs": [{"row_id": "val-row", "output": "validation"}],
        })
        callback.on_valset_evaluated({
            "iteration": 1, "candidate_idx": 4, "scores_by_val_id": {0: 0.8},
            "outputs_by_val_id": {}, "parent_ids": [0],
        })

        child = sink.events[-1]
        self.assertEqual(child["event_type"], "child_val_set_completed")
        self.assertEqual(child["payload"]["row_results"], [{
            "row_id": "val-row", "score": 0.8, "feedback": None,
            "error": None, "output": "validation",
        }])

    def test_local_artifact_failure_marks_the_callback_as_non_durable(self):
        """Kills a swallowed local append failure that otherwise permits success."""
        sink = RecordingSink()
        sink.failed = False
        sink.local_logger = SimpleNamespace(
            append_evaluations=lambda **_kwargs: (_ for _ in ()).throw(OSError("disk full"))
        )
        callback = OrizuCallback(sink, RUN_ID)
        callback.on_evaluation_start({"iteration": 1, "inputs": [DatasetRow(id="row", row={})]})
        callback.on_evaluation_end({"iteration": 1, "candidate_idx": 0, "scores": [0.5], "outputs": [{}]})
        with self.assertRaisesRegex(OSError, "disk full"):
            callback.on_proposal_start({"iteration": 1, "parent_candidate": {"prompt": "seed"}, "components": ["prompt"], "reflective_dataset": {}})
        self.assertTrue(callback.logging_failed)
        with self.assertRaisesRegex(RuntimeError, "mandatory event logging failed"):
            require_durable_logging(sink, callback)

    def test_local_reflection_records_the_frozen_provider_prompt(self):
        """Kills local evidence that records GEPA's discarded rendered prompt."""
        from orizu_gepa.local_log import LocalOptimizationLogger

        with tempfile.TemporaryDirectory() as root:
            logger = LocalOptimizationLogger.create(root, RUN_ID)
            sink = RecordingSink()
            sink.local_logger = logger
            callback = OrizuCallback(sink, RUN_ID)
            callback.on_candidate_selected({"iteration": 1, "candidate_idx": 0})
            callback.on_proposal_start({"iteration": 1})
            callback.record_reflection_prompt("frozen provider prompt")
            callback.on_proposal_end({
                "iteration": 1, "new_instructions": {"prompt": "child"},
                "prompts": {"prompt": "GEPA rendered prompt"},
                "raw_lm_outputs": {"prompt": "<new_text>child</new_text>"},
            })
            callback.on_candidate_accepted({"iteration": 1, "new_candidate_idx": 1, "new_score": 1.0})
            record = json.loads((Path(root) / RUN_ID / "reflections.jsonl").read_text())

        self.assertEqual(record["prompt"], "frozen provider prompt")

    def test_reflection_usage_does_not_estimate_a_failed_provider_attempt(self):
        """Kills character-based accounting when no provider usage was reported."""
        import orizu_gepa_connector.reflection as reflection

        lm = make_gepa_reflection_lm(
            context_supplier=lambda: ("provider input", []), config=TextGepaConfig(reflection_max_tokens=1024),
        )
        with patch.object(reflection, "reflect_with_provider", side_effect=RuntimeError("timeout")):
            with self.assertRaisesRegex(RuntimeError, "timeout"):
                lm("GEPA input")
        self.assertEqual(lm.total_tokens_in, 0)
        self.assertEqual(lm.total_tokens_out, 0)

    def test_reflection_usage_uses_exact_provider_usage_not_character_estimates(self):
        """Kills connector accounting that ignores parsed provider usage."""
        import orizu_gepa_connector.reflection as reflection

        config = TextGepaConfig(reflection_max_tokens=1024)
        parent_text = "short parent"
        parent_rows = [RowEvaluation("row", {"question": "q"}, "output", 0.2, "feedback")]
        lm = make_gepa_reflection_lm(
            context_supplier=lambda: (parent_text, parent_rows), config=config,
        )
        with patch.object(reflection, "reflect_with_provider", return_value=SimpleNamespace(
            response="a response whose character length must not affect usage",
            usage={"input_tokens": 31, "output_tokens": 11, "total_tokens": 42},
        )):
            lm("GEPA renderer input")
        self.assertEqual(lm.total_tokens_in, 31)
        self.assertEqual(lm.total_tokens_out, 11)
        self.assertEqual(lm.total_tokens, 42)

    def test_connector_config_covers_every_frozen_reflection_transport_attribute(self):
        """Kills a connector config missing a frozen transport attribute by name."""
        source = (REPOSITORY_ROOT / "packages/orizu-gepa-python/src/orizu_gepa/reflection.py").read_text()
        tree = ast.parse(source)
        transport_reads = {
            node.attr
            for node in ast.walk(tree)
            if isinstance(node, ast.Attribute)
            and isinstance(node.value, ast.Name)
            and node.value.id == "config"
        }
        self.assertEqual(transport_reads, FROZEN_REFLECTION_CONFIG_ATTRIBUTES)
        connector_fields = {field.name for field in fields(TextGepaConfig)}
        self.assertFalse(
            transport_reads - connector_fields,
            "connector TextGepaConfig is missing frozen reflection fields: "
            f"{', '.join(sorted(transport_reads - connector_fields))}",
        )

    def test_synthetic_official_shape_replays_through_dispatch_and_fake_anthropic_http(self):
        """Kills a lost cap/seed/minibatch translation or a provider-path regression."""
        parent_rows = [
            RowEvaluation(
                row_id=f"synthetic-row-{index:02d}", row={}, output={"answer": "synthetic"}, score=0.2,
                feedback="synthetic scorer feedback", error=None,
            )
            for index in range(SYNTHETIC_REPLAY["parent_rows"])
        ]
        parent_text = "synthetic prompt " + ("x" * (SYNTHETIC_REPLAY["parent_text_chars"] - len("synthetic prompt ")))
        legacy_response = SYNTHETIC_REPLAY["legacy_response"]
        environment = dispatched_synthetic_official_environment()
        self.assertEqual(environment["ORIZU_REFLECTION_MAX_TOKENS"], "1024")
        self.assertEqual(environment["ORIZU_MINIBATCH_SIZE"], "26")
        self.assertEqual(environment["ORIZU_NUM_THREADS"], "6")
        self.assertEqual(environment["ORIZU_SEED"], "1502")
        self.assertEqual(environment["ORIZU_MAX_ITERATIONS"], "2")

        seen_payloads = []

        class FakeAnthropicResponse:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return json.dumps({
                    "content": [{"type": "text", "text": legacy_response}],
                    "usage": {"input_tokens": 17, "output_tokens": 5},
                }).encode("utf-8")

        def fake_urlopen(request, *, timeout):
            seen_payloads.append((json.loads(request.data), timeout))
            return FakeAnthropicResponse()

        self.assertEqual(len(parent_rows), SYNTHETIC_REPLAY["parent_rows"])
        self.assertEqual(len(parent_text), SYNTHETIC_REPLAY["parent_text_chars"])
        with patch.dict(os.environ, {**environment, "ANTHROPIC_API_KEY": "test-key"}, clear=True):
            config = build_config_from_environment()
            reflection_lm = make_gepa_reflection_lm(
                context_supplier=lambda: (parent_text, parent_rows),
                config=config,
            )
            with patch("urllib.request.urlopen", fake_urlopen):
                response = reflection_lm("GEPA-owned renderer input")
                sink = RecordingSink()
                callback = OrizuCallback(sink, RUN_ID)
                run_official_gepa(
                    seed_candidate={"prompt": "seed"},
                    trainset=[{"id": "recorded-train"}],
                    valset=[{"id": "recorded-validation"}],
                    adapter=ReflectionOnlyAdapter(),
                    callback=callback,
                    hooks=LifecycleHooks(),
                    max_metric_calls=8,
                    stop_callbacks=[IterationBoundaryStopper(max_iterations=1)],
                    reflection_lm=reflection_lm,
                    seed_already_validated=True,
                    config=config,
                )

        self.assertEqual(response, legacy_response)
        payload, timeout = seen_payloads[0]
        self.assertEqual(payload["model"], "claude-haiku-4-5")
        self.assertEqual(payload["max_tokens"], 1024)
        self.assertGreater(len(payload["messages"][0]["content"]), 27000)
        self.assertEqual(timeout, 180)
        self.assertIn("reflection_completed", [event["event_type"] for event in sink.events])

    def test_real_preflight_refuses_a_degenerate_seed_before_any_budget_is_spent(self):
        """Kills a refusal that omits the row evidence needed to adjudicate it."""
        refusal = validate_seed_and_scorer(
            scores=[0.0, 0.0, 0.0],
            row_evidence=[
                {"row_id": "validation-a", "score": 0.0, "scorer_output": {"score": 0}, "scorer_error": None},
                {"row_id": "validation-b", "score": 0.0, "scorer_output": {"score": 0}, "scorer_error": None},
                {"row_id": "validation-c", "score": 0.0, "scorer_output": {"score": 0}, "scorer_error": None},
            ],
            allow_degenerate_seed=False,
        )
        self.assertEqual(refusal, {
            "allowed": False,
            "reason": "degenerate_seed",
            "row_evidence": [
                {"row_id": "validation-a", "score": 0.0, "scorer_output": {"score": 0}, "scorer_error": None},
                {"row_id": "validation-b", "score": 0.0, "scorer_output": {"score": 0}, "scorer_error": None},
                {"row_id": "validation-c", "score": 0.0, "scorer_output": {"score": 0}, "scorer_error": None},
            ],
        })

    def test_preflight_refuses_a_lower_is_better_perfect_bound(self):
        """Kills a normalized lower-is-better 1.0 seed that bypasses the legacy perfect-bound guard."""
        verdict = validate_seed_and_scorer(
            scores=[1.0, 1.0],
            row_evidence=[{"row_id": "lower-a"}, {"row_id": "lower-b"}],
            allow_degenerate_seed=False,
            higher_is_better=False,
        )
        self.assertFalse(verdict["allowed"])
        self.assertEqual(verdict["reason"], "degenerate_seed")

    def test_preflight_uses_legacy_float_tolerance_at_both_degeneracy_bounds(self):
        """Kills exact bound comparisons for scorer floats that the connector does not produce."""
        higher = validate_seed_and_scorer(
            scores=[1e-10, 5e-10], allow_degenerate_seed=False,
        )
        lower = validate_seed_and_scorer(
            scores=[1 - 1e-10, 1 - 5e-10], allow_degenerate_seed=False,
            higher_is_better=False,
        )
        self.assertEqual(higher["reason"], "degenerate_seed")
        self.assertEqual(lower["reason"], "degenerate_seed")

    def test_preflight_threads_the_adapters_lower_is_better_direction(self):
        """Kills engine wiring that leaves the lower-is-better perfect-bound guard unreachable."""
        from orizu_gepa_connector.engine import validate_seed_before_run

        adapter = RecordedPreflightAdapter(
            scores=[1.0, 1.0],
            outputs=[
                {"row_id": "lower-a", "scorer_output": {"score": 0.0}, "scorer_error": None},
                {"row_id": "lower-b", "scorer_output": {"score": 0.0}, "scorer_error": None},
            ],
        )
        adapter.scorer_context = SimpleNamespace(higher_is_better=False)
        with self.assertRaisesRegex(SeedValidationRefused, "degenerate_seed"):
            validate_seed_before_run(
                seed_candidate={"prompt": "seed"},
                valset=[DatasetRow(id="lower-a", row={}), DatasetRow(id="lower-b", row={})],
                adapter=adapter,
                hooks=LifecycleHooks(),
                allow_degenerate_seed=False,
            )

    def test_preflight_mixed_working_rows_launch_and_record_failure_warning(self):
        """Kills a transient single-row provider failure that blocks a working pipeline."""
        verdict = validate_seed_and_scorer(
            scores=[1.0, 0.0, 0.0],
            row_evidence=[
                {"row_id": "working-high", "score": 1.0, "scorer_output": {"score": 1}, "scorer_error": None},
                {"row_id": "working-low", "score": 0.0, "scorer_output": {"score": 0}, "scorer_error": None},
                {"row_id": "transient", "score": 0.0, "scorer_output": None, "scorer_error": None,
                 "execution_error": "no JSON object in response", "execution_error_source": "candidate"},
            ],
            allow_degenerate_seed=False,
        )
        self.assertTrue(verdict["allowed"])
        self.assertIsNone(verdict["reason"])
        self.assertEqual(verdict["warnings"], [{
            "reason": "candidate_execution_failed",
            "row_ids": ["transient"],
        }])
        self.assertEqual(verdict["row_evidence"][2]["execution_error"], "no JSON object in response")

    def test_preflight_refuses_when_every_sampled_row_has_the_same_execution_failure(self):
        """Kills a permissive classifier that launches with no working pipeline evidence."""
        verdict = validate_seed_and_scorer(
            scores=[0.0, 0.0, 0.0],
            row_evidence=[
                {"row_id": f"failed-{index}", "score": 0.0, "scorer_output": None, "scorer_error": None,
                 "execution_error": "no JSON object in response", "execution_error_source": "candidate"}
                for index in range(3)
            ],
            allow_degenerate_seed=False,
        )
        self.assertFalse(verdict["allowed"])
        self.assertEqual(verdict["reason"], "candidate_execution_failed")
        self.assertNotIn("warnings", verdict)

    def test_allow_degenerate_seed_bypasses_an_all_error_preflight_with_warning(self):
        """Kills an opt-out that is inert because execution failure returns early."""
        verdict = validate_seed_and_scorer(
            scores=[0.0, 0.0, 0.0],
            row_evidence=[
                {"row_id": f"failed-{index}", "score": 0.0, "scorer_output": None,
                 "scorer_error": "scorer connection reset"}
                for index in range(3)
            ],
            allow_degenerate_seed=True,
        )
        self.assertTrue(verdict["allowed"])
        self.assertIsNone(verdict["reason"])
        self.assertEqual(verdict["warnings"], [{
            "reason": "scorer_execution_failed",
            "row_ids": ["failed-0", "failed-1", "failed-2"],
        }])

    def test_seed_validated_hook_refuses_before_the_official_engine_starts(self):
        """Kills a lifecycle refusal whose exception hides scored-row evidence."""
        hooks = LifecycleHooks()
        observed = []
        hooks.add("seed_validated", observed.append)
        adapter = RecordedPreflightAdapter(
            scores=[0.0],
            outputs=[{
                "row_id": "recorded-validation-row",
                "scorer_output": {"score": 0, "reasoning": "the recorded scorer decision"},
                "scorer_error": None,
            }],
        )
        with self.assertRaisesRegex(SeedValidationRefused, "recorded-validation-row.*recorded scorer decision") as raised:
            run_official_gepa(
                seed_candidate={"prompt": "seed"}, trainset=[{"id": "train"}], valset=[{"id": "validation"}],
                adapter=adapter, callback=OrizuCallback(RecordingSink(), RUN_ID, hooks), hooks=hooks,
                max_metric_calls=1,
            )
        self.assertEqual(raised.exception.verdict["row_evidence"][0]["row_id"], "recorded-validation-row")
        self.assertEqual(observed, [{
            "allowed": False,
            "reason": "degenerate_seed",
            "row_evidence": [{
                "row_id": "recorded-validation-row",
                "score": 0.0,
                "scorer_output": {"score": 0, "reasoning": "the recorded scorer decision"},
                "scorer_error": None,
            }],
            "preflight_metric_calls": 1,
        }])

    def test_preflight_scorer_failure_is_not_misclassified_as_degenerate_seed(self):
        """Kills treating a record-shaped scorer subprocess failure as score zero."""
        hooks = LifecycleHooks()
        observed = []
        hooks.add("seed_validated", observed.append)
        adapter = RecordedPreflightAdapter(
            scores=[0.0],
            outputs=[{
                "row_id": "scorer-timeout-row",
                "scorer_output": None,
                "scorer_error": "runner exited 124: scorer timed out",
            }],
        )
        with self.assertRaisesRegex(SeedValidationRefused, "scorer_execution_failed") as raised:
            run_official_gepa(
                seed_candidate={"prompt": "seed"}, trainset=[{"id": "train"}], valset=[{"id": "validation"}],
                adapter=adapter, callback=OrizuCallback(RecordingSink(), RUN_ID, hooks), hooks=hooks,
                max_metric_calls=1,
            )
        self.assertNotIn("degenerate_seed", str(raised.exception))
        self.assertEqual(raised.exception.verdict["row_evidence"], [{
            "row_id": "scorer-timeout-row",
            "score": 0.0,
            "scorer_output": None,
            "scorer_error": "runner exited 124: scorer timed out",
        }])
        self.assertEqual(observed[0]["reason"], "scorer_execution_failed")

    def test_preflight_candidate_failure_is_not_misclassified_as_degenerate_seed(self):
        """Kills the recorded missing-provider-key failure being reported as a bad seed."""
        hooks = LifecycleHooks()
        adapter = RecordedPreflightAdapter(
            scores=[0.0],
            outputs=[{
                "row_id": "recorded-confirmation-row",
                "scorer_output": None,
                "scorer_error": None,
                "error": "ANTHROPIC_API_KEY not set",
                "error_source": "candidate",
            }],
        )
        with self.assertRaisesRegex(SeedValidationRefused, "candidate_execution_failed.*ANTHROPIC_API_KEY not set") as raised:
            run_official_gepa(
                seed_candidate={"prompt": "seed"}, trainset=[{"id": "train"}], valset=[{"id": "validation"}],
                adapter=adapter, callback=OrizuCallback(RecordingSink(), RUN_ID, hooks), hooks=hooks,
                max_metric_calls=1,
            )
        self.assertNotIn("degenerate_seed", str(raised.exception))
        self.assertEqual(raised.exception.verdict["reason"], "candidate_execution_failed")

    def test_recorded_passing_seed_shape_is_not_refused_by_preflight(self):
        """Kills the regression that converts an identical recorded 0.70 score into a zero verdict."""
        hooks = LifecycleHooks()
        from orizu_gepa_connector.engine import validate_seed_before_run
        verdict = validate_seed_before_run(
            seed_candidate={"prompt": "seed"},
            valset=[DatasetRow(id="recorded-pass-row", row={})],
            adapter=RecordedPreflightAdapter(
                scores=[0.70],
                outputs=[{"row_id": "recorded-pass-row", "scorer_output": {"score": 0.70}, "scorer_error": None}],
            ),
            hooks=hooks,
            allow_degenerate_seed=False,
        )
        self.assertEqual(verdict["allowed"], True)
        self.assertEqual(verdict["row_evidence"][0]["score"], 0.70)

    def test_public_entrypoint_refuses_to_fallback_to_the_retired_fixture_lifecycle(self):
        """Kills a CLI path that emits invented events without verified runner inputs."""
        names = [
            "ORIZU_PROJECT", "ORIZU_OPTIMIZER_VERSION_ID", "ORIZU_PROMPT_VERSION_ID",
            "ORIZU_DATASET_VERSION_ID", "ORIZU_SPLIT_SET_ID", "ORIZU_SCORER_VERSION_ID",
            "ORIZU_RUNNER_VERSION_ID", "ORIZU_CANDIDATE_RUNNER_DIR", "ORIZU_SCORER_RUNNER_DIR",
        ]
        original = {name: os.environ.pop(name, None) for name in names}
        try:
            with self.assertRaisesRegex(RuntimeError, "ORIZU_CANDIDATE_RUNNER_DIR"):
                run_from_environment()
        finally:
            for name, value in original.items():
                if value is not None:
                    os.environ[name] = value


if __name__ == "__main__":
    unittest.main()
