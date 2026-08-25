"""Local-only ALI-1505 red gate; intentionally not unittest-discovered in CI.

Run with:
  PYTHONPATH=packages/orizu-gepa/src:packages/orizu-gepa-python/src:.scratch-deps/cli-shaped/gepa-0.1.4 \
    .scratch-deps/venv/bin/python packages/orizu-gepa/red-gate-local/test_ali_1505_skilled_proposer_bridge.py

The loopback endpoint is synthetic, serves no customer data, and never reaches
an LLM provider. These tests are expected to fail until the production bridge
and its selected-proposer wiring exist.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import ssl
import subprocess
import tempfile
from threading import Thread
import unittest
from unittest.mock import MagicMock, patch, sentinel
from urllib.request import urlopen

import dspy
from gepa.core.adapter import EvaluationBatch
from skilled_proposer import SkilledProposer

from orizu_gepa.optimizer import TextGepaConfig
from orizu_gepa_connector.callbacks import LifecycleHooks, OrizuCallback
from orizu_gepa_connector.engine import run_official_gepa
from orizu_gepa_connector.stop_conditions import IterationBoundaryStopper


class _RecordingProvider(BaseHTTPRequestHandler):
    requests: list[dict] = []
    failure_status: int | None = None
    failure_on_request: int | None = None
    completion_texts = [
        "[[ ## answer ## ]]\nbridge answer\n\n[[ ## completed ## ]]",
        "[[ ## new_instruction ## ]]\nthis proposal is deliberately too long\n\n[[ ## completed ## ]]",
        "[[ ## shortened_instruction ## ]]\nshort\n\n[[ ## completed ## ]]",
    ]

    def do_POST(self) -> None:  # noqa: N802 - stdlib callback name
        content_length = int(self.headers["Content-Length"])
        self.__class__.requests.append({
            "path": self.path,
            "headers": dict(self.headers),
            "body": json.loads(self.rfile.read(content_length)),
        })
        if (self.__class__.failure_status is not None and
                (self.__class__.failure_on_request is None or
                 len(self.__class__.requests) == self.__class__.failure_on_request)):
            self.send_error(self.__class__.failure_status, "synthetic provider failure")
            return
        text = self.__class__.completion_texts.pop(0)
        body = json.dumps({
            "id": "loopback-response",
            "output_text": text,
            "usage": {"input_tokens": 17, "output_tokens": 5, "total_tokens": 22},
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: object) -> None:
        return


class _LoopbackProvider:
    def __init__(self, responses: list[str] | None = None, *, certificate: Path | None = None,
                 failure_status: int | None = None, failure_on_request: int | None = None) -> None:
        self.responses = responses or [
            "[[ ## answer ## ]]\nbridge answer\n\n[[ ## completed ## ]]",
        ]
        self.certificate = certificate
        self.failure_status = failure_status
        self.failure_on_request = failure_on_request

    def __enter__(self) -> "_LoopbackProvider":
        _RecordingProvider.requests = []
        _RecordingProvider.failure_status = self.failure_status
        _RecordingProvider.failure_on_request = self.failure_on_request
        # DSPy's formatter can retry an interrupted prediction after our
        # deliberate durable-event write failure. Keep the loopback response
        # canned through that retry path; the test asserts the durable failure,
        # not a one-request transport count.
        _RecordingProvider.completion_texts = list(self.responses) + [self.responses[-1]] * 8
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _RecordingProvider)
        scheme = "http"
        if self.certificate:
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(self.certificate)
            self.server.socket = context.wrap_socket(self.server.socket, server_side=True)
            scheme = "https"
        self.thread = Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"{scheme}://127.0.0.1:{self.server.server_port}/v1"
        return self

    def __exit__(self, *_unused: object) -> None:
        self.server.shutdown()
        self.thread.join(timeout=2)
        self.server.server_close()


class _Echo(dspy.Signature):
    """Answer with the supplied canned result."""

    question: str = dspy.InputField()
    answer: str = dspy.OutputField()


class _OneRowAdapter:
    """Permitted GEPA evaluation seam; GEPA itself remains real."""

    def __init__(self) -> None:
        self.metric_calls = 0

    def evaluate(self, batch, candidate, capture_traces=False):
        self.metric_calls += len(batch)
        return EvaluationBatch(
            outputs=[{"answer": candidate["prompt"]} for _ in batch],
            scores=[0.2 for _ in batch],
            trajectories=[{"feedback": "improve"}] if capture_traces else None,
            num_metric_calls=len(batch),
        )

    def make_reflective_dataset(self, _candidate, _evaluation, components):
        return {component: [{"Feedback": "improve"}] for component in components}


def _bridge_contract():
    """Load the future production API only when the real test starts."""
    from orizu_gepa_connector.skilled_proposer_bridge import (  # type: ignore[import-not-found]
        ProposalCallBudget,
        ProposalObservability,
        make_skilled_proposer_from_environment,
        make_skilled_proposer_bridge,
    )

    return ProposalCallBudget, ProposalObservability, make_skilled_proposer_bridge, make_skilled_proposer_from_environment


def _normalized_config(*, on_error: str = "raise", max_words: int = 120) -> dict:
    skill_content = "---\nname: embedded-name\ndescription: Embedded description.\n---\n# Contract\nKeep stable keys.\n"
    additional = "Keep the proposal capability-agnostic.\n"
    base = "CUSTOM BASE CONTRACT\n"
    payload = {
        "configFileSha256": hashlib.sha256(b"synthetic source config").hexdigest(),
        "schemaVersion": 1,
        "implementation": "cmpnd-ai/skilled-proposer",
        "packageVersion": "0.1.2",
        "skills": [{
            "name": "planner-contract",
            "description": "Stable planner constraints.",
            "source": "skills/planner/SKILL.md",
            "content": skill_content,
            "sha256": hashlib.sha256(skill_content.encode()).hexdigest(),
            "byteLength": len(skill_content.encode()),
        }],
        "additionalInstructions": {
            "source": "additional.md",
            "content": additional,
            "sha256": hashlib.sha256(additional.encode()).hexdigest(),
            "byteLength": len(additional.encode()),
        },
        "baseInstructions": {
            "source": "base.md",
            "content": base,
            "sha256": hashlib.sha256(base.encode()).hexdigest(),
            "byteLength": len(base.encode()),
        },
        "maxWords": max_words,
        "maxTokens": 300,
        "maxExamples": 4,
        "onError": on_error,
    }
    _refresh_config_hash(payload)
    return payload


def _refresh_config_hash(payload: dict) -> None:
    effective = {
        "configFileSha256": payload["configFileSha256"],
        "schemaVersion": payload["schemaVersion"],
        "implementation": payload["implementation"],
        "packageVersion": payload["packageVersion"],
        "skills": payload["skills"],
        "additionalInstructions": payload["additionalInstructions"],
        "baseInstructions": payload["baseInstructions"],
        "maxWords": payload["maxWords"],
        "maxTokens": payload["maxTokens"],
        "maxExamples": payload["maxExamples"],
        "onError": payload["onError"],
    }
    canonical = json.dumps(effective, ensure_ascii=False, separators=(",", ":"))
    payload["configSha256"] = hashlib.sha256(canonical.encode("utf-8")).hexdigest()


class BridgeE2E(unittest.TestCase):
    def make_bridge(self, endpoint: str, *, max_calls: int = 8, max_tokens: int = 200,
                    ssl_cert_file: str | None = None, observability=None):
        ProposalCallBudget, ProposalObservability, make_skilled_proposer_bridge, _factory = _bridge_contract()
        observability = observability or ProposalObservability.local_for_test()
        bridge = make_skilled_proposer_bridge(
            config=TextGepaConfig(
                reflection_model="openai/loopback",
                reflection_temperature=0.375,
                reflection_max_tokens=64,
            ),
            observability=observability,
            budget=ProposalCallBudget(max_calls=max_calls, max_tokens=max_tokens),
            endpoint_override=endpoint,
            ssl_cert_file=ssl_cert_file,
        )
        return bridge, observability

    def test_real_dspy_predict_uses_orizu_bridge_not_litellm(self):
        """Mutant: bypass the bridge, LiteLLM, or ignore the loopback endpoint."""
        with _LoopbackProvider() as provider:
            # This is a route tripwire, not a fake completion: the real DSPy
            # call and real loopback provider still execute. A bridge that
            # reaches LiteLLM fails before it can mask the bypass with a
            # successful local response. The URL guard also makes an ignored
            # endpoint override fail locally instead of sending a test request
            # to a real provider.
            def loopback_only(provider_request, **kwargs):
                if provider_request.full_url != provider.url:
                    raise AssertionError("ALI_1505_ENDPOINT_OVERRIDE_IGNORED")
                return urlopen(provider_request, **kwargs)

            with patch("orizu_gepa.reflection.urllib.request.urlopen", side_effect=loopback_only), \
                 patch("litellm.completion", side_effect=AssertionError("ALI_1505_LITELLM_BYPASS")):
                bridge, observability = self.make_bridge(provider.url)
                prediction = dspy.Predict(_Echo)(question="bridge?", lm=bridge)

        self.assertEqual(prediction.answer, "bridge answer")
        self.assertEqual(len(_RecordingProvider.requests), 1)
        self.assertEqual(_RecordingProvider.requests[0]["body"]["temperature"], 0.375)
        self.assertEqual(_RecordingProvider.requests[0]["body"]["max_output_tokens"], 64)
        self.assertEqual(observability.events[0]["source"], "skilled_proposer")
        self.assertEqual(observability.events[0]["provider"], "openai")
        self.assertNotIn("litellm", observability.events[0])

    def test_selected_factory_reads_opt_in_environment_and_routes_real_proposer_calls(self):
        """Mutant: set ORIZU_CANDIDATE_PROPOSER but ignore it at runtime wiring."""
        _Budget, ProposalObservability, _bridge, factory = _bridge_contract()
        with _LoopbackProvider([
            "[[ ## new_instruction ## ]]\nfactory result\n\n[[ ## completed ## ]]",
        ]) as provider, patch.dict("os.environ", {
            "ORIZU_CANDIDATE_PROPOSER": "skilled-proposer",
            "SSL_CERT_FILE": "/synthetic/ca.pem",
        }, clear=False):
            observability = ProposalObservability.local_for_test()
            proposer = factory(
                config=TextGepaConfig(reflection_model="openai/loopback", reflection_max_tokens=64),
                observability=observability,
                endpoint_override=provider.url,
            )
            proposal = proposer(
                candidate={"system": "old system", "tools": "old tools"},
                reflective_dataset={"system": [{"Feedback": "improve"}], "tools": [{"Feedback": "improve"}]},
                components_to_update=["system", "tools"],
            )

        self.assertIsInstance(proposer, SkilledProposer)
        self.assertEqual(proposal, {"system": "factory result", "tools": "factory result"})
        self.assertEqual(len(_RecordingProvider.requests), 2)
        self.assertEqual(observability.events[0]["source"], "skilled_proposer")

    def test_factory_is_inert_without_the_exact_opt_in_value(self):
        """Mutant: construct skilled-proposer for every run regardless of selection."""
        _Budget, ProposalObservability, _bridge, factory = _bridge_contract()
        for selection in (None, "another-proposer"):
            with self.subTest(selection=selection), patch.dict("os.environ", {}, clear=False):
                if selection is None:
                    os.environ.pop("ORIZU_CANDIDATE_PROPOSER", None)
                else:
                    os.environ["ORIZU_CANDIDATE_PROPOSER"] = selection
                observability = ProposalObservability.local_for_test()
                proposer = factory(
                    config=TextGepaConfig(reflection_model="openai/loopback", reflection_max_tokens=64),
                    observability=observability,
                )
                self.assertIsNone(proposer)

    def test_no_config_factory_preserves_the_exact_upstream_constructor_call(self):
        """Mutant: add any configured/default argument to the no-config constructor."""
        _Budget, ProposalObservability, _bridge, factory = _bridge_contract()
        observability = ProposalObservability.local_for_test()
        with patch.dict("os.environ", {
            "ORIZU_CANDIDATE_PROPOSER": "skilled-proposer",
        }, clear=True), patch("skilled_proposer.SkilledProposer", return_value=sentinel.proposer) as constructor:
            proposer = factory(
                config=TextGepaConfig(reflection_model="openai/loopback", reflection_max_tokens=64),
                observability=observability,
            )

        self.assertIs(proposer, sentinel.proposer)
        constructor.assert_called_once()
        self.assertEqual(set(constructor.call_args.kwargs), {"prompt_model"})
        self.assertFalse((observability.event_log_root.parent / "proposer.json").exists())

    def test_configured_factory_renders_delivered_skills_and_guidance_through_the_real_bridge(self):
        """Mutant: drop bytes/options, bypass Skill, or send proposal work outside the bridge."""
        _Budget, ProposalObservability, _bridge, factory = _bridge_contract()
        payload = _normalized_config()
        with _LoopbackProvider([
            "[[ ## new_instruction ## ]]\nconfigured result\n\n[[ ## completed ## ]]",
        ]) as provider, patch.dict("os.environ", {
            "ORIZU_CANDIDATE_PROPOSER": "skilled-proposer",
            "ORIZU_SKILLED_PROPOSER_CONFIG": json.dumps(payload),
        }, clear=True):
            observability = ProposalObservability.local_for_test()
            proposer = factory(
                config=TextGepaConfig(reflection_model="openai/loopback", reflection_max_tokens=64),
                observability=observability,
                endpoint_override=provider.url,
            )
            proposal = proposer(
                candidate={"system": "old system"},
                reflective_dataset={"system": [{"Feedback": "improve"}]},
                components_to_update=["system"],
            )

        self.assertEqual(proposal, {"system": "configured result"})
        self.assertEqual(len(_RecordingProvider.requests), 1)
        request = json.dumps(_RecordingProvider.requests[0]["body"])
        self.assertIn("<skill name='planner-contract' description='Stable planner constraints.'>", request)
        self.assertIn("name: embedded-name", request)
        self.assertIn("Keep stable keys.", request)
        self.assertIn("Keep the proposal capability-agnostic.", request)
        self.assertIn("CUSTOM BASE CONTRACT", request)

        identity_path = observability.event_log_root.parent / "proposer.json"
        identity_text = identity_path.read_text(encoding="utf8")
        identity = json.loads(identity_text)
        self.assertEqual(identity, {
            "implementation": "cmpnd-ai/skilled-proposer",
            "packageVersion": "0.1.2",
            "configSha256": payload["configSha256"],
            "skills": [{
                "name": "planner-contract",
                "source": "skills/planner/SKILL.md",
                "sha256": payload["skills"][0]["sha256"],
                "byteLength": payload["skills"][0]["byteLength"],
            }],
            "additionalInstructionsSha256": payload["additionalInstructions"]["sha256"],
            "baseInstructionsSha256": payload["baseInstructions"]["sha256"],
            "maxWords": 120,
            "maxTokens": 300,
            "maxExamples": 4,
            "onError": "raise",
        })
        self.assertNotIn("Keep stable keys.", identity_text)
        self.assertNotIn(str(observability.event_log_root.parent), identity_text)

    def test_runtime_redacts_identity_write_path_and_durably_records_local_detail(self):
        """Mutant: let the raw identity-write OSError reach the run status API."""
        from orizu_gepa.local_log import LocalOptimizationLogger
        from orizu_gepa.optimizer import DatasetRow, PromptContext
        import orizu_gepa_connector.runtime as runtime

        payload = _normalized_config()
        env = {
            "ORIZU_PROJECT": "project",
            "ORIZU_OPTIMIZER_VERSION_ID": "optimizer",
            "ORIZU_PROMPT_VERSION_ID": "prompt",
            "ORIZU_DATASET_VERSION_ID": "dataset",
            "ORIZU_SPLIT_SET_ID": "split",
            "ORIZU_SCORER_VERSION_ID": "scorer",
            "ORIZU_RUNNER_VERSION_ID": "runner",
            "ORIZU_CANDIDATE_RUNNER_DIR": "candidate",
            "ORIZU_SCORER_RUNNER_DIR": "scorer-dir",
            "ORIZU_VERIFIED_RUNNER_DIRS": '["candidate", "scorer-dir"]',
            "ORIZU_REFLECTION_MAX_TOKENS": "1024",
            "ORIZU_CANDIDATE_PROPOSER": "skilled-proposer",
            "ORIZU_SKILLED_PROPOSER_CONFIG": json.dumps(payload),
        }
        context = PromptContext(
            body="seed",
            body_kind="text",
            provider_settings={"model": "model"},
            prompt_version_id="prompt",
            runner_version_id="runner",
        )
        client = MagicMock()
        client.fetch_exec_context.side_effect = [
            (context, [DatasetRow(id="train", row={})]),
            (context, [DatasetRow(id="validation", row={})]),
        ]
        client.fetch_scorer_exec_context.return_value = (context, [])
        client.start_run.return_value = "run"
        adapter = MagicMock()
        adapter.num_threads_plan.to_payload.return_value = {}

        with tempfile.TemporaryDirectory(prefix="orizu-ali1505-identity-failure-") as temporary:
            logger = LocalOptimizationLogger.create(temporary, "run")
            identity_path = logger.directory / "proposer.json"
            identity_path.mkdir()
            with patch.dict(os.environ, env, clear=True), \
                 patch.object(runtime.OrizuClient, "from_env", return_value=client), \
                 patch.object(runtime, "resolve_scorer_input_contract", return_value=("flat_row", "model_output")), \
                 patch.object(runtime, "validate_seed_before_run", return_value={
                     "preflight_metric_calls": 0,
                     "warnings": [],
                 }), \
                 patch.object(runtime, "RunnerEvaluationAdapter", side_effect=[adapter, adapter]), \
                 patch.object(runtime, "create_local_logger_from_environment", return_value=logger), \
                 patch.object(runtime, "run_official_gepa") as engine:
                with self.assertRaisesRegex(
                    RuntimeError, "^skilled_proposer_identity_write_failed$",
                ):
                    runtime.run_from_environment()

            engine.assert_not_called()
            failed_status = client.update_run.call_args.kwargs
            self.assertEqual(failed_status["status"], "failed")
            server_reason = failed_status["metadata"]["failure_reason"]
            self.assertEqual(server_reason, "skilled_proposer_identity_write_failed")
            self.assertNotIn(str(identity_path), server_reason)
            self.assertNotIn(os.sep, server_reason)
            local_failure = json.loads(
                (logger.directory / "proposal-failures" / "latest.json").read_text(encoding="utf-8")
            )
            self.assertEqual(local_failure["source"], "skilled_proposer")
            self.assertEqual(local_failure["code"], "skilled_proposer_identity_write_failed")
            self.assertIn(str(identity_path), local_failure["detail"])

    def test_configured_scalar_options_reach_upstream_without_owning_prompt_model(self):
        """Mutant: rename an upstream kwarg, accept config prompt_model, or lose an option."""
        _Budget, ProposalObservability, _bridge, factory = _bridge_contract()
        payload = _normalized_config()
        with patch.dict("os.environ", {
            "ORIZU_CANDIDATE_PROPOSER": "skilled-proposer",
            "ORIZU_SKILLED_PROPOSER_CONFIG": json.dumps(payload),
        }, clear=True):
            proposer = factory(
                config=TextGepaConfig(reflection_model="openai/loopback", reflection_max_tokens=64),
                observability=ProposalObservability.local_for_test(),
            )

        self.assertIsInstance(proposer.proposer, SkilledProposer)
        self.assertEqual(proposer.additional_instructions, payload["additionalInstructions"]["content"].strip())
        self.assertEqual(proposer.base_instructions, payload["baseInstructions"]["content"].strip())
        self.assertEqual(proposer.max_words, 120)
        self.assertEqual(proposer.max_tokens, 300)
        self.assertEqual(proposer.max_examples, 4)
        self.assertEqual(proposer.on_error, "raise")
        self.assertEqual(proposer.skills[0].name, "planner-contract")
        self.assertEqual(proposer.skills[0].content, payload["skills"][0]["content"])
        self.assertIsNotNone(proposer.prompt_model)
        self.assertIn("compress", dict(proposer.proposer.module.named_predictors()))

    def test_python_payload_parser_rejects_unknown_and_missing_fields_with_named_codes(self):
        """Mutant: silently ignore normalized payload drift or construct partial skills."""
        _Budget, ProposalObservability, _bridge, factory = _bridge_contract()
        invalid_payloads = []
        unknown = _normalized_config()
        unknown["future"] = True
        invalid_payloads.append((unknown, "skilled_proposer_config_unknown_field.*future"))
        missing = _normalized_config()
        del missing["skills"][0]["sha256"]
        invalid_payloads.append((missing, r"skilled_proposer_config_missing_field.*skills\[0\]\.sha256"))
        wrong_type = _normalized_config()
        wrong_type["schemaVersion"] = True
        invalid_payloads.append((wrong_type, "skilled_proposer_config_invalid_field.*schemaVersion"))
        wrong_scalar = _normalized_config()
        wrong_scalar["maxWords"] = True
        invalid_payloads.append((wrong_scalar, "skilled_proposer_config_invalid_field.*maxWords"))

        for payload, expected in invalid_payloads:
            with self.subTest(expected=expected), patch.dict("os.environ", {
                "ORIZU_CANDIDATE_PROPOSER": "skilled-proposer",
                "ORIZU_SKILLED_PROPOSER_CONFIG": json.dumps(payload),
            }, clear=True):
                with self.assertRaisesRegex(RuntimeError, expected):
                    factory(
                        config=TextGepaConfig(reflection_model="openai/loopback", reflection_max_tokens=64),
                        observability=ProposalObservability.local_for_test(),
                    )

    def test_python_payload_parser_recomputes_every_delivered_content_hash(self):
        """Mutant: trust syntactically valid hashes supplied beside changed bytes."""
        _Budget, ProposalObservability, _bridge, factory = _bridge_contract()
        for field, expected in (
            ("skills", r"skills\[0\]\.sha256"),
            ("additionalInstructions", r"additionalInstructions\.sha256"),
            ("baseInstructions", r"baseInstructions\.sha256"),
        ):
            payload = _normalized_config()
            target = payload["skills"][0] if field == "skills" else payload[field]
            target["content"] += "tampered"
            target["byteLength"] = len(target["content"].encode())
            with self.subTest(field=field), patch.dict("os.environ", {
                "ORIZU_CANDIDATE_PROPOSER": "skilled-proposer",
                "ORIZU_SKILLED_PROPOSER_CONFIG": json.dumps(payload),
            }, clear=True), self.assertRaisesRegex(RuntimeError, expected):
                factory(
                    config=TextGepaConfig(reflection_model="openai/loopback", reflection_max_tokens=64),
                    observability=ProposalObservability.local_for_test(),
                )

    def test_node_payload_hash_round_trips_through_the_python_factory(self):
        """Mutant: omit configFileSha256 or drift Python's canonical JSON formula."""
        _Budget, ProposalObservability, _bridge, factory = _bridge_contract()
        repository = Path(__file__).resolve().parents[3]
        with tempfile.TemporaryDirectory(prefix="orizu-ali1505-cross-language-") as temporary:
            config_path = Path(temporary) / "config.json"
            config_path.write_text(json.dumps({
                "schemaVersion": 1,
                "skills": [{
                    "name": "plan\U0001f680",
                    "description": "Unicode\u2028separator",
                    "inline": "Crème brûlée \U0001f9ed",
                }],
                "maxWords": 17,
                "onError": "keep",
            }, ensure_ascii=False), encoding="utf-8")
            result = subprocess.run([
                "bun", "-e",
                "import { normalizedSkilledProposerConfig as n } from "
                "'./packages/cli/src/skilled-proposer-config.ts';process.stdout.write(n(process.argv[1]))",
                str(config_path),
            ], cwd=repository, check=True, capture_output=True, text=True)
        payload = json.loads(result.stdout)
        self.assertRegex(payload["configFileSha256"], r"^[a-f0-9]{64}$")
        with patch.dict("os.environ", {
            "ORIZU_CANDIDATE_PROPOSER": "skilled-proposer",
            "ORIZU_SKILLED_PROPOSER_CONFIG": result.stdout,
        }, clear=True):
            proposer = factory(
                config=TextGepaConfig(reflection_model="openai/loopback", reflection_max_tokens=64),
                observability=ProposalObservability.local_for_test(),
            )
        self.assertEqual(proposer.skills[0].content, "Crème brûlée \U0001f9ed")

    def test_python_payload_parser_rejects_a_stale_effective_config_hash(self):
        """Mutant: trust configSha256 after a materialized scalar is changed."""
        _Budget, ProposalObservability, _bridge, factory = _bridge_contract()
        payload = _normalized_config()
        payload["maxWords"] = 121
        with patch.dict("os.environ", {
            "ORIZU_CANDIDATE_PROPOSER": "skilled-proposer",
            "ORIZU_SKILLED_PROPOSER_CONFIG": json.dumps(payload),
        }, clear=True), self.assertRaisesRegex(
            RuntimeError, "skilled_proposer_config_hash_mismatch.*configSha256",
        ):
            factory(
                config=TextGepaConfig(reflection_model="openai/loopback", reflection_max_tokens=64),
                observability=ProposalObservability.local_for_test(),
            )

    def test_python_payload_parser_names_malformed_unicode_fields(self):
        """Mutant: let str.encode raise an unclassified UnicodeEncodeError."""
        _Budget, ProposalObservability, _bridge, factory = _bridge_contract()
        for field, target in (
            ("skills[0].name", ("skills", 0, "name")),
            ("skills[0].description", ("skills", 0, "description")),
            ("skills[0].source", ("skills", 0, "source")),
            ("skills[0].content", ("skills", 0, "content")),
            ("additionalInstructions.source", ("additionalInstructions", "source")),
            ("baseInstructions.content", ("baseInstructions", "content")),
        ):
            payload = _normalized_config()
            value = payload
            for key in target[:-1]:
                value = value[key]
            value[target[-1]] = "\ud800"
            with self.subTest(field=field), patch.dict("os.environ", {
                "ORIZU_CANDIDATE_PROPOSER": "skilled-proposer",
                "ORIZU_SKILLED_PROPOSER_CONFIG": json.dumps(payload),
            }, clear=True), self.assertRaisesRegex(
                RuntimeError, f"skilled_proposer_config_invalid_unicode.*{re.escape(field)}",
            ):
                factory(
                    config=TextGepaConfig(reflection_model="openai/loopback", reflection_max_tokens=64),
                    observability=ProposalObservability.local_for_test(),
                )

    def test_config_payload_file_transport_reaches_the_strict_factory_parser(self):
        """Mutant: treat the controlled @file transport reference as inline JSON."""
        _Budget, ProposalObservability, _bridge, factory = _bridge_contract()
        payload = _normalized_config()
        payload["skills"][0]["content"] = "\ufeff" + payload["skills"][0]["content"]
        payload["skills"][0]["byteLength"] = len(payload["skills"][0]["content"].encode())
        payload["skills"][0]["sha256"] = hashlib.sha256(payload["skills"][0]["content"].encode()).hexdigest()
        _refresh_config_hash(payload)
        with tempfile.TemporaryDirectory(prefix="orizu-skilled-proposer-payload-") as temporary:
            path = Path(temporary) / "payload.json"
            path.write_text(json.dumps(payload), encoding="utf8")
            with patch.dict("os.environ", {
                "ORIZU_CANDIDATE_PROPOSER": "skilled-proposer",
                "ORIZU_SKILLED_PROPOSER_CONFIG": f"@{path}",
            }, clear=True):
                proposer = factory(
                    config=TextGepaConfig(reflection_model="openai/loopback", reflection_max_tokens=64),
                    observability=ProposalObservability.local_for_test(),
                )
            self.assertFalse(path.exists())
            self.assertFalse(Path(temporary).exists())
        self.assertIsInstance(proposer.proposer, SkilledProposer)
        self.assertTrue(proposer.skills[0].content.startswith("\ufeff---"))

    def test_config_payload_cleanup_failure_does_not_abort_the_selected_run(self):
        """Mutant: let best-effort one-shot payload deletion abort launch."""
        _Budget, ProposalObservability, _bridge, factory = _bridge_contract()
        with tempfile.TemporaryDirectory(prefix="orizu-skilled-proposer-payload-") as temporary:
            path = Path(temporary) / "payload.json"
            path.write_text(json.dumps(_normalized_config()), encoding="utf8")
            with patch.dict("os.environ", {
                "ORIZU_CANDIDATE_PROPOSER": "skilled-proposer",
                "ORIZU_SKILLED_PROPOSER_CONFIG": f"@{path}",
            }, clear=True), patch.object(Path, "unlink", side_effect=OSError("synthetic cleanup failure")):
                proposer = factory(
                    config=TextGepaConfig(reflection_model="openai/loopback", reflection_max_tokens=64),
                    observability=ProposalObservability.local_for_test(),
                )
            self.assertTrue(path.exists())
        self.assertIsInstance(proposer.proposer, SkilledProposer)

    def test_on_error_raise_propagates_non_provider_proposer_failures(self):
        """Mutant: configure upstream keep or catch a configured raise failure."""
        _Budget, ProposalObservability, _bridge, factory = _bridge_contract()
        observability = ProposalObservability.local_for_test()
        with patch.dict("os.environ", {
            "ORIZU_CANDIDATE_PROPOSER": "skilled-proposer",
            "ORIZU_SKILLED_PROPOSER_CONFIG": json.dumps(_normalized_config(on_error="raise")),
        }, clear=True), patch.object(
            SkilledProposer, "_propose_one", side_effect=ValueError("synthetic proposer failure"),
        ):
            proposer = factory(
                config=TextGepaConfig(reflection_model="openai/loopback", reflection_max_tokens=64),
                observability=observability,
            )
            with self.assertRaisesRegex(RuntimeError, "^proposal_generation_failed$"):
                proposer({"system": "unchanged"}, {"system": []}, ["system"])
        self.assertIn("synthetic proposer failure", observability.read_durable_failure()["detail"])

    def test_on_error_keep_records_a_durable_component_fallback(self):
        """Mutant: use upstream silent keep, omit fallback fields, or change the candidate."""
        _Budget, ProposalObservability, _bridge, factory = _bridge_contract()
        observability = ProposalObservability.local_for_test()
        with patch.dict("os.environ", {
            "ORIZU_CANDIDATE_PROPOSER": "skilled-proposer",
            "ORIZU_SKILLED_PROPOSER_CONFIG": json.dumps(_normalized_config(on_error="keep")),
        }, clear=True), patch.object(
            SkilledProposer, "_propose_one", side_effect=ValueError("synthetic proposer failure"),
        ):
            proposer = factory(
                config=TextGepaConfig(reflection_model="openai/loopback", reflection_max_tokens=64),
                observability=observability,
            )
            proposal = proposer({"system": "unchanged"}, {"system": []}, ["system"])

        self.assertEqual(proposal, {"system": "unchanged"})
        events = [json.loads(line) for line in (
            observability.event_log_root / "events.jsonl"
        ).read_text(encoding="utf8").splitlines()]
        self.assertEqual(events, [{
            "type": "proposal_component_fallback",
            "component": "system",
            "policy": "keep",
            "errorType": "ValueError",
            "errorMessage": "synthetic proposer failure",
        }])

    def test_on_error_keep_does_not_trust_a_proposer_failure_message(self):
        """Mutant: identify mandatory observability failures by public message alone."""
        _Budget, ProposalObservability, _bridge, factory = _bridge_contract()
        observability = ProposalObservability.local_for_test()
        with patch.dict("os.environ", {
            "ORIZU_CANDIDATE_PROPOSER": "skilled-proposer",
            "ORIZU_SKILLED_PROPOSER_CONFIG": json.dumps(_normalized_config(on_error="keep")),
        }, clear=True), patch.object(
            SkilledProposer, "_propose_one",
            side_effect=ValueError("proposal_observability_event_failed"),
        ):
            proposer = factory(
                config=TextGepaConfig(reflection_model="openai/loopback", reflection_max_tokens=64),
                observability=observability,
            )
            proposal = proposer({"system": "unchanged"}, {"system": []}, ["system"])

        self.assertEqual(proposal, {"system": "unchanged"})
        fallback_events = [event for event in observability.events
                           if event.get("type") == "proposal_component_fallback"]
        self.assertEqual(len(fallback_events), 1)
        self.assertEqual(fallback_events[0]["errorType"], "ValueError")

    def test_on_error_keep_never_swallows_provider_lm_errors(self):
        """Mutant: catch every Exception in the keep wrapper, including LMError."""
        _Budget, ProposalObservability, _bridge, factory = _bridge_contract()
        observability = ProposalObservability.local_for_test()
        with _LoopbackProvider(failure_status=503) as provider, patch.dict("os.environ", {
            "ORIZU_CANDIDATE_PROPOSER": "skilled-proposer",
            "ORIZU_SKILLED_PROPOSER_CONFIG": json.dumps(_normalized_config(on_error="keep")),
        }, clear=True):
            proposer = factory(
                config=TextGepaConfig(reflection_model="openai/loopback", reflection_max_tokens=64),
                observability=observability,
                endpoint_override=provider.url,
            )
            with self.assertRaisesRegex(dspy.LMError, "proposal_provider_transport_failed") as raised:
                proposer({"system": "unchanged"}, {"system": []}, ["system"])

        self.assertEqual(raised.exception.message, "proposal_provider_transport_failed")
        self.assertIn("503", observability.read_durable_failure()["detail"])
        self.assertFalse(any(
            event.get("type") == "proposal_component_fallback"
            for event in observability.events
        ))

    def test_on_error_raise_keeps_initial_parse_response_out_of_public_error(self):
        """Mutant: re-raise DSPy's raw parse error instead of a stable public code."""
        _Budget, ProposalObservability, _bridge, factory = _bridge_contract()
        canary = "CANARY_SKILL_CONTENT_123"
        with _LoopbackProvider([
            f"[[ ## wrong_field ## ]]\n{canary}\n\n[[ ## completed ## ]]",
        ]) as provider, patch.dict("os.environ", {
            "ORIZU_CANDIDATE_PROPOSER": "skilled-proposer",
            "ORIZU_SKILLED_PROPOSER_CONFIG": json.dumps(_normalized_config(on_error="raise")),
        }, clear=True):
            observability = ProposalObservability.local_for_test()
            proposer = factory(
                config=TextGepaConfig(reflection_model="openai/loopback", reflection_max_tokens=64),
                observability=observability,
                endpoint_override=provider.url,
            )
            with self.assertRaisesRegex(RuntimeError, "^proposal_generation_failed$") as raised:
                proposer({"system": "unchanged"}, {"system": []}, ["system"])

        self.assertNotIn(canary, str(raised.exception))
        failure = observability.read_durable_failure()
        self.assertEqual(failure["code"], "proposal_generation_failed")
        self.assertIn(canary, failure["detail"])

    def test_on_error_raise_names_compression_provider_failure_without_returning_truncation(self):
        """Mutant: miss the provider failure swallowed by upstream compression."""
        _Budget, ProposalObservability, _bridge, factory = _bridge_contract()
        payload = _normalized_config(on_error="raise", max_words=1)
        with _LoopbackProvider([
            "[[ ## new_instruction ## ]]\nthis proposal is deliberately too long\n\n[[ ## completed ## ]]",
        ], failure_status=503, failure_on_request=2) as provider, patch.dict("os.environ", {
            "ORIZU_CANDIDATE_PROPOSER": "skilled-proposer",
            "ORIZU_SKILLED_PROPOSER_CONFIG": json.dumps(payload),
        }, clear=True):
            proposer = factory(
                config=TextGepaConfig(
                    reflection_model="openai/loopback", reflection_max_tokens=64,
                    reflection_retry_attempts=1,
                ),
                observability=ProposalObservability.local_for_test(),
                endpoint_override=provider.url,
            )
            with self.assertRaisesRegex(dspy.LMError, "proposal_compression_provider_failed") as raised:
                proposer({"system": "unchanged"}, {"system": []}, ["system"])

        self.assertEqual(raised.exception.code, "proposal_compression_provider_failed")
        self.assertEqual(len(_RecordingProvider.requests), 2)

    def test_on_error_raise_names_compression_parse_failure_without_returning_truncation(self):
        """Mutant: leave module.compress unwrapped and miss its parse failure."""
        _Budget, ProposalObservability, _bridge, factory = _bridge_contract()
        payload = _normalized_config(on_error="raise", max_words=1)
        with _LoopbackProvider([
            "[[ ## new_instruction ## ]]\nthis proposal is deliberately too long\n\n[[ ## completed ## ]]",
            "[[ ## wrong_field ## ]]\nnot a shortened instruction\n\n[[ ## completed ## ]]",
        ]) as provider, patch.dict("os.environ", {
            "ORIZU_CANDIDATE_PROPOSER": "skilled-proposer",
            "ORIZU_SKILLED_PROPOSER_CONFIG": json.dumps(payload),
        }, clear=True):
            proposer = factory(
                config=TextGepaConfig(reflection_model="openai/loopback", reflection_max_tokens=64),
                observability=ProposalObservability.local_for_test(),
                endpoint_override=provider.url,
            )
            with self.assertRaisesRegex(RuntimeError, "proposal_compression_failed"):
                proposer({"system": "unchanged"}, {"system": []}, ["system"])

        # DSPy retries the failed ChatAdapter parse once through JSONAdapter.
        self.assertEqual(len(_RecordingProvider.requests), 3)

    def test_real_gepa_cannot_swallow_the_configured_raise_policy(self):
        """Mutants: swallow the failure, retry its provider, or emit terminal success."""
        ProposalCallBudget, ProposalObservability, _bridge, factory = _bridge_contract()
        payload = _normalized_config(on_error="raise", max_words=1)
        with _LoopbackProvider([
            "[[ ## new_instruction ## ]]\nthis proposal is deliberately too long\n\n[[ ## completed ## ]]",
            "[[ ## wrong_field ## ]]\nnot a shortened instruction\n\n[[ ## completed ## ]]",
        ]) as provider, patch.dict("os.environ", {
            "ORIZU_CANDIDATE_PROPOSER": "skilled-proposer",
            "ORIZU_SKILLED_PROPOSER_CONFIG": json.dumps(payload),
        }, clear=True):
            observability = ProposalObservability.local_for_test()
            proposal_budget = ProposalCallBudget(max_calls=3)
            proposer = factory(
                config=TextGepaConfig(reflection_model="openai/loopback", reflection_max_tokens=64),
                observability=observability,
                budget=proposal_budget,
                endpoint_override=provider.url,
            )
            hooks = LifecycleHooks()
            completed: list[dict] = []
            hooks.add("run_completed", completed.append)
            with self.assertRaisesRegex(RuntimeError, "proposal_compression_failed"):
                run_official_gepa(
                    seed_candidate={"prompt": "old"},
                    trainset=[{"id": "synthetic-row"}],
                    valset=[{"id": "synthetic-row"}],
                    adapter=_OneRowAdapter(),
                    callback=OrizuCallback(MagicMock(), "synthetic-run", hooks),
                    hooks=hooks,
                    max_metric_calls=8,
                    stop_callbacks=[IterationBoundaryStopper(1)],
                    custom_candidate_proposer=proposer,
                    proposal_budget=proposal_budget,
                    config=TextGepaConfig(reflection_model="openai/loopback", reflection_max_tokens=64),
                )

        # GEPA retries a failed batch per task. The engine guard must re-raise
        # its captured first error without paying for another provider call.
        self.assertEqual(len(_RecordingProvider.requests), 3)
        self.assertEqual(completed, [])

    def test_on_error_keep_records_compression_parse_fallback_and_returns_original_component(self):
        """Mutants: miss compression parse failure or return its truncation."""
        _Budget, ProposalObservability, _bridge, factory = _bridge_contract()
        payload = _normalized_config(on_error="keep", max_words=1)
        observability = ProposalObservability.local_for_test()
        with _LoopbackProvider([
            "[[ ## new_instruction ## ]]\nthis proposal is deliberately too long\n\n[[ ## completed ## ]]",
            "[[ ## wrong_field ## ]]\nnot a shortened instruction\n\n[[ ## completed ## ]]",
        ]) as provider, patch.dict("os.environ", {
            "ORIZU_CANDIDATE_PROPOSER": "skilled-proposer",
            "ORIZU_SKILLED_PROPOSER_CONFIG": json.dumps(payload),
        }, clear=True):
            proposer = factory(
                config=TextGepaConfig(reflection_model="openai/loopback", reflection_max_tokens=64),
                observability=observability,
                endpoint_override=provider.url,
            )
            proposal = proposer({"system": "unchanged"}, {"system": []}, ["system"])

        self.assertEqual(proposal, {"system": "unchanged"})
        self.assertEqual(len(_RecordingProvider.requests), 3)
        fallback_events = [event for event in observability.events
                           if event.get("type") == "proposal_component_fallback"]
        self.assertEqual(len(fallback_events), 1)
        self.assertIn("proposal_compression_failed", fallback_events[0]["errorMessage"])

    def test_compression_event_append_failure_escapes_configured_raise_policy(self):
        """Mutant: relabel mandatory observability loss as a compression failure."""
        _Budget, ProposalObservability, _bridge, factory = _bridge_contract()
        payload = _normalized_config(on_error="raise", max_words=1)
        observability = ProposalObservability.local_for_test()
        append_event = observability._append_event
        append_calls = 0

        def fail_second_append(event):
            nonlocal append_calls
            append_calls += 1
            if append_calls == 2:
                raise OSError("synthetic compression event append failure")
            append_event(event)

        with _LoopbackProvider([
            "[[ ## new_instruction ## ]]\nthis proposal is deliberately too long\n\n[[ ## completed ## ]]",
            "[[ ## shortened_instruction ## ]]\nshort\n\n[[ ## completed ## ]]",
            '{"shortened_instruction":"short"}',
        ]) as provider, patch.dict("os.environ", {
            "ORIZU_CANDIDATE_PROPOSER": "skilled-proposer",
            "ORIZU_SKILLED_PROPOSER_CONFIG": json.dumps(payload),
        }, clear=True), patch.object(observability, "_append_event", side_effect=fail_second_append):
            proposer = factory(
                config=TextGepaConfig(reflection_model="openai/loopback", reflection_max_tokens=64),
                observability=observability,
                endpoint_override=provider.url,
            )
            with self.assertRaisesRegex(
                RuntimeError, "^proposal_observability_event_failed$",
            ):
                proposer({"system": "unchanged"}, {"system": []}, ["system"])

        self.assertEqual(len(_RecordingProvider.requests), 3)
        self.assertEqual(observability.read_durable_failure()["code"], "proposal_observability_event_failed")

    def test_compression_event_append_failure_prevents_real_gepa_success_under_keep(self):
        """Mutant: let keep absorb compression observability loss and finish GEPA."""
        ProposalCallBudget, ProposalObservability, _bridge, factory = _bridge_contract()
        payload = _normalized_config(on_error="keep", max_words=1)
        observability = ProposalObservability.local_for_test()
        append_event = observability._append_event
        append_calls = 0

        def fail_second_append(event):
            nonlocal append_calls
            append_calls += 1
            if append_calls == 2:
                raise OSError("synthetic compression event append failure")
            append_event(event)

        with _LoopbackProvider([
            "[[ ## new_instruction ## ]]\nthis proposal is deliberately too long\n\n[[ ## completed ## ]]",
            "[[ ## shortened_instruction ## ]]\nshort\n\n[[ ## completed ## ]]",
            '{"shortened_instruction":"short"}',
        ]) as provider, patch.dict("os.environ", {
            "ORIZU_CANDIDATE_PROPOSER": "skilled-proposer",
            "ORIZU_SKILLED_PROPOSER_CONFIG": json.dumps(payload),
        }, clear=True), patch.object(observability, "_append_event", side_effect=fail_second_append):
            proposal_budget = ProposalCallBudget(max_calls=3)
            proposer = factory(
                config=TextGepaConfig(reflection_model="openai/loopback", reflection_max_tokens=64),
                observability=observability,
                budget=proposal_budget,
                endpoint_override=provider.url,
            )
            hooks = LifecycleHooks()
            completed: list[dict] = []
            hooks.add("run_completed", completed.append)
            with self.assertRaisesRegex(
                RuntimeError, "^proposal_observability_event_failed$",
            ) as raised:
                run_official_gepa(
                    seed_candidate={"prompt": "old"},
                    trainset=[{"id": "synthetic-row"}],
                    valset=[{"id": "synthetic-row"}],
                    adapter=_OneRowAdapter(),
                    callback=OrizuCallback(MagicMock(), "synthetic-run", hooks),
                    hooks=hooks,
                    max_metric_calls=8,
                    stop_callbacks=[IterationBoundaryStopper(1)],
                    custom_candidate_proposer=proposer,
                    proposal_budget=proposal_budget,
                    config=TextGepaConfig(
                        reflection_model="openai/loopback", reflection_max_tokens=64,
                    ),
                )

        self.assertEqual(completed, [])
        self.assertNotIn(str(observability.event_log_root), str(raised.exception))
        self.assertEqual(observability.read_durable_failure()["code"], "proposal_observability_event_failed")
        self.assertFalse(any(
            event.get("type") == "proposal_component_fallback" for event in observability.events
        ))

    def test_generation_event_append_failure_prevents_real_gepa_success_after_adapter_retry(self):
        """Mutant: forget an event failure after DSPy's fallback adapter succeeds."""
        ProposalCallBudget, ProposalObservability, _bridge, factory = _bridge_contract()
        payload = _normalized_config(on_error="keep")
        observability = ProposalObservability.local_for_test()
        append_event = observability._append_event
        append_calls = 0

        def fail_first_append(event):
            nonlocal append_calls
            append_calls += 1
            if append_calls == 1:
                raise OSError("synthetic generation event append failure")
            append_event(event)

        with _LoopbackProvider([
            "[[ ## new_instruction ## ]]\nchanged\n\n[[ ## completed ## ]]",
            '{"new_instruction":"changed"}',
        ]) as provider, patch.dict("os.environ", {
            "ORIZU_CANDIDATE_PROPOSER": "skilled-proposer",
            "ORIZU_SKILLED_PROPOSER_CONFIG": json.dumps(payload),
        }, clear=True), patch.object(observability, "_append_event", side_effect=fail_first_append):
            proposal_budget = ProposalCallBudget(max_calls=2)
            proposer = factory(
                config=TextGepaConfig(reflection_model="openai/loopback", reflection_max_tokens=64),
                observability=observability,
                budget=proposal_budget,
                endpoint_override=provider.url,
            )
            hooks = LifecycleHooks()
            completed: list[dict] = []
            hooks.add("run_completed", completed.append)
            with self.assertRaisesRegex(
                RuntimeError, "^proposal_observability_event_failed$",
            ) as raised:
                run_official_gepa(
                    seed_candidate={"prompt": "old"},
                    trainset=[{"id": "synthetic-row"}],
                    valset=[{"id": "synthetic-row"}],
                    adapter=_OneRowAdapter(),
                    callback=OrizuCallback(MagicMock(), "synthetic-run", hooks),
                    hooks=hooks,
                    max_metric_calls=8,
                    stop_callbacks=[IterationBoundaryStopper(1)],
                    custom_candidate_proposer=proposer,
                    proposal_budget=proposal_budget,
                    config=TextGepaConfig(
                        reflection_model="openai/loopback", reflection_max_tokens=64,
                    ),
                )

        self.assertEqual(completed, [])
        self.assertNotIn(str(observability.event_log_root), str(raised.exception))
        self.assertEqual(len(_RecordingProvider.requests), 2)
        self.assertEqual(observability.read_durable_failure()["code"], "proposal_observability_event_failed")
        self.assertFalse(any(
            event.get("type") == "proposal_component_fallback" for event in observability.events
        ))

    def test_on_error_keep_rejects_a_fallback_event_write_failure(self):
        """Mutant: suppress fallback-event OSError after its local durable record."""
        _Budget, ProposalObservability, _bridge, factory = _bridge_contract()
        payload = _normalized_config(on_error="keep")
        with tempfile.TemporaryDirectory(prefix="orizu-ali1505-fallback-event-") as temporary:
            temporary_path = Path(temporary)
            blocked_event_root = temporary_path / "not-a-directory"
            blocked_event_root.write_text("block event directory creation", encoding="utf-8")
            observability = ProposalObservability.local_for_test(
                event_log_root=blocked_event_root,
                durable_failure_root=temporary_path / "durable-failures",
            )
            with _LoopbackProvider([
                "[[ ## new_instruction ## ]]\nchanged\n\n[[ ## completed ## ]]",
            ]) as provider, patch.dict("os.environ", {
                "ORIZU_CANDIDATE_PROPOSER": "skilled-proposer",
                "ORIZU_SKILLED_PROPOSER_CONFIG": json.dumps(payload),
            }, clear=True), patch.object(
                SkilledProposer, "_propose_one", side_effect=ValueError("synthetic proposer failure"),
            ):
                proposer = factory(
                    config=TextGepaConfig(reflection_model="openai/loopback", reflection_max_tokens=64),
                    observability=observability,
                    endpoint_override=provider.url,
                )
                with self.assertRaisesRegex(
                    RuntimeError, "^proposal_observability_event_failed$",
                ) as raised:
                    proposer({"system": "unchanged"}, {"system": []}, ["system"])

            self.assertNotIn(str(blocked_event_root), str(raised.exception))
            local_failure = observability.read_durable_failure()
            self.assertEqual(local_failure["code"], "proposal_observability_event_failed")
            self.assertIn(str(blocked_event_root), local_failure["detail"])

    def test_on_error_keep_observability_failure_prevents_real_gepa_terminal_success(self):
        """Mutant: let keep absorb a mandatory per-call event failure before GEPA's latch."""
        ProposalCallBudget, ProposalObservability, _bridge, factory = _bridge_contract()
        payload = _normalized_config(on_error="keep")
        with tempfile.TemporaryDirectory(prefix="orizu-ali1505-mandatory-event-") as temporary:
            blocked_event_root = Path(temporary) / "not-a-directory"
            blocked_event_root.write_text("block event directory creation", encoding="utf-8")
            observability = ProposalObservability.local_for_test(
                event_log_root=blocked_event_root,
                durable_failure_root=Path(temporary) / "durable-failures",
            )
            proposal_budget = ProposalCallBudget(max_calls=1)
            with _LoopbackProvider([
                "[[ ## new_instruction ## ]]\nchanged\n\n[[ ## completed ## ]]",
            ]) as provider, patch.dict("os.environ", {
                "ORIZU_CANDIDATE_PROPOSER": "skilled-proposer",
                "ORIZU_SKILLED_PROPOSER_CONFIG": json.dumps(payload),
            }, clear=True), patch.object(
                observability, "_append_event", wraps=observability._append_event,
            ) as append_event:
                proposer = factory(
                    config=TextGepaConfig(reflection_model="openai/loopback", reflection_max_tokens=64),
                    observability=observability,
                    budget=proposal_budget,
                    endpoint_override=provider.url,
                )
                hooks = LifecycleHooks()
                completed: list[dict] = []
                hooks.add("run_completed", completed.append)
                with self.assertRaisesRegex(
                    RuntimeError, "^proposal_observability_event_failed$",
                ) as raised:
                    run_official_gepa(
                        seed_candidate={"prompt": "old"},
                        trainset=[{"id": "synthetic-row"}],
                        valset=[{"id": "synthetic-row"}],
                        adapter=_OneRowAdapter(),
                        callback=OrizuCallback(MagicMock(), "synthetic-run", hooks),
                        hooks=hooks,
                        max_metric_calls=8,
                        stop_callbacks=[IterationBoundaryStopper(1)],
                        custom_candidate_proposer=proposer,
                        proposal_budget=proposal_budget,
                        config=TextGepaConfig(
                            reflection_model="openai/loopback", reflection_max_tokens=64,
                        ),
                    )

            self.assertEqual(completed, [])
            self.assertNotIn(str(blocked_event_root), str(raised.exception))
            attempted_events = [call.args[0] for call in append_event.call_args_list]
            self.assertTrue(attempted_events)
            self.assertFalse(any(
                event.get("type") == "proposal_component_fallback" for event in attempted_events
            ))
            local_failure = observability.read_durable_failure()
            self.assertEqual(local_failure["code"], "proposal_observability_event_failed")
            self.assertIn(str(blocked_event_root), local_failure["detail"])

    def test_on_error_keep_records_compression_fallback_and_returns_original_component(self):
        """Mutants: miss swallowed failure or keep upstream's truncated text."""
        _Budget, ProposalObservability, _bridge, factory = _bridge_contract()
        payload = _normalized_config(on_error="keep", max_words=1)
        observability = ProposalObservability.local_for_test()
        with _LoopbackProvider([
            "[[ ## new_instruction ## ]]\nthis proposal is deliberately too long\n\n[[ ## completed ## ]]",
        ], failure_status=503, failure_on_request=2) as provider, patch.dict("os.environ", {
            "ORIZU_CANDIDATE_PROPOSER": "skilled-proposer",
            "ORIZU_SKILLED_PROPOSER_CONFIG": json.dumps(payload),
        }, clear=True):
            proposer = factory(
                config=TextGepaConfig(
                    reflection_model="openai/loopback", reflection_max_tokens=64,
                    reflection_retry_attempts=1,
                ),
                observability=observability,
                endpoint_override=provider.url,
            )
            proposal = proposer({"system": "unchanged"}, {"system": []}, ["system"])

        self.assertEqual(proposal, {"system": "unchanged"})
        self.assertEqual(len(_RecordingProvider.requests), 2)
        fallback_events = [event for event in observability.events
                           if event.get("type") == "proposal_component_fallback"]
        self.assertEqual(len(fallback_events), 1)
        self.assertEqual(fallback_events[0]["component"], "system")
        self.assertEqual(fallback_events[0]["policy"], "keep")
        self.assertIn("proposal_compression_provider_failed", fallback_events[0]["errorMessage"])

    def test_provider_usage_is_exact_in_every_call_event_and_terminal_stats(self):
        """Mutant: discard provider usage or estimate characters as tokens."""
        with _LoopbackProvider() as provider:
            bridge, observability = self.make_bridge(provider.url)
            dspy.Predict(_Echo)(question="usage?", lm=bridge)

        expected = {"input_tokens": 17, "output_tokens": 5, "total_tokens": 22}
        self.assertEqual(observability.events[0]["usage"], expected)
        self.assertEqual(observability.terminal_stats()["usage"], expected)
        self.assertNotIn("cost_usd", observability.events[0])
        self.assertNotIn("cost_usd", observability.terminal_stats())
        lm_stats = observability.terminal_lm_stats()
        self.assertEqual(lm_stats["total_tokens_in"], 17)
        self.assertEqual(lm_stats["total_tokens_out"], 5)
        self.assertEqual(lm_stats["total_tokens"], 22)
        self.assertNotIn("total_cost", lm_stats)
        artifact = observability.write_terminal_lm_stats_artifact()
        artifact_payload = json.loads(Path(artifact).read_text(encoding="utf8"))
        self.assertEqual(artifact_payload, lm_stats)

    def test_proposal_cache_is_disabled_so_each_call_has_usage_and_an_event(self):
        """Mutant: let DSPy's ambient response cache hide provider proposal calls."""
        with _LoopbackProvider([
            "[[ ## answer ## ]]\nfirst\n\n[[ ## completed ## ]]",
            "[[ ## answer ## ]]\nsecond\n\n[[ ## completed ## ]]",
        ]) as provider:
            bridge, observability = self.make_bridge(provider.url)
            first = dspy.Predict(_Echo)(question="same request", lm=bridge)
            second = dspy.Predict(_Echo)(question="same request", lm=bridge)
            with self.assertRaisesRegex(dspy.LMError, "unsupported DSPy generation configuration"):
                bridge(messages=[{"role": "user", "content": "reject top_p"}], top_p=0.5)

        self.assertEqual(first.answer, "first")
        self.assertEqual(second.answer, "second")
        self.assertEqual(len(_RecordingProvider.requests), 2)
        self.assertEqual(len(observability.events), 2)
        self.assertEqual(observability.terminal_stats()["usage"]["total_tokens"], 44)
        self.assertTrue(all(event["cache_state"] == "disabled" for event in observability.events))

    def test_provider_request_receives_resolved_ssl_cert_file(self):
        """Mutant: pass SSL_CERT_FILE to pip only, not the bridge transport."""
        with tempfile.TemporaryDirectory(prefix="orizu-ali1505-local-ca-") as temporary:
            certificate = Path(temporary) / "loopback.pem"
            generated = subprocess.run([
                "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                "-keyout", str(certificate), "-out", str(certificate), "-days", "1",
                "-subj", "/CN=127.0.0.1",
                "-addext", "subjectAltName=IP:127.0.0.1",
            ], text=True, capture_output=True, check=False)
            self.assertEqual(generated.returncode, 0, generated.stdout + generated.stderr)
            rejected_certificate = Path(temporary) / "wrong-ca.pem"
            rejected_certificate.write_text("not a certificate", encoding="utf8")
            with _LoopbackProvider(certificate=certificate, responses=[
                "[[ ## answer ## ]]\nbridge answer\n\n[[ ## completed ## ]]",
                "[[ ## answer ## ]]\nbridge answer\n\n[[ ## completed ## ]]",
            ]) as provider:
                bridge, _observability = self.make_bridge(
                    provider.url,
                    ssl_cert_file=str(certificate),
                )
                prediction = dspy.Predict(_Echo)(question="TLS?", lm=bridge)
                with self.assertRaises(Exception):
                    rejected_bridge, _rejected_observability = self.make_bridge(
                        provider.url,
                        ssl_cert_file=str(rejected_certificate),
                    )
                    dspy.Predict(_Echo)(question="TLS must verify", lm=rejected_bridge)

        self.assertEqual(prediction.answer, "bridge answer")

    def test_compression_is_a_second_observed_provider_call(self):
        """Mutant: record only SkilledProposer.__call__, not each Predict call."""
        with _LoopbackProvider([
            "[[ ## new_instruction ## ]]\nthis proposal is deliberately too long\n\n[[ ## completed ## ]]",
            "[[ ## shortened_instruction ## ]]\nshort\n\n[[ ## completed ## ]]",
        ]) as provider:
            bridge, observability = self.make_bridge(provider.url)
            proposer = SkilledProposer(prompt_model=bridge, max_words=1)
            proposal = proposer(
                candidate={"prompt": "old"},
                reflective_dataset={"prompt": [{"Feedback": "improve"}]},
                components_to_update=["prompt"],
            )

        self.assertEqual(proposal["prompt"], "short")
        self.assertEqual(len(_RecordingProvider.requests), 2)
        self.assertEqual(len(observability.events), 2)
        self.assertEqual(observability.terminal_stats()["usage"], {
            "input_tokens": 34, "output_tokens": 10, "total_tokens": 44,
        })

    def test_gepa_metric_count_excludes_proposal_calls(self):
        """Mutant: increment GEPAState.total_num_evals for bridge calls."""
        with _LoopbackProvider([
            "[[ ## new_instruction ## ]]\nimproved prompt\n\n[[ ## completed ## ]]",
        ]) as provider:
            bridge, observability = self.make_bridge(provider.url)
            proposer = SkilledProposer(prompt_model=bridge)
            adapter = _OneRowAdapter()
            result = run_official_gepa(
                seed_candidate={"prompt": "old"},
                trainset=[{"id": "synthetic-row"}],
                valset=[{"id": "synthetic-row"}],
                adapter=adapter,
                # This local boundary has no connector callback; runtime owns
                # production callback wiring, so make the absence explicit.
                callback=None,
                hooks=LifecycleHooks(),
                max_metric_calls=2,
                custom_candidate_proposer=proposer,
                proposal_budget=observability.budget,
                config=TextGepaConfig(reflection_model="openai/loopback", reflection_max_tokens=64),
            )

        self.assertEqual(result.total_metric_calls, 2)
        # The connector's mandatory preflight performs one adapter evaluation
        # outside GEPA; GEPA's result excludes it. Proposal calls add neither.
        self.assertEqual(adapter.metric_calls, result.total_metric_calls + 1)
        self.assertEqual(observability.terminal_stats()["call_count"], 1)

    def test_owned_token_and_call_budget_stops_at_safe_boundary(self):
        """Mutant: bind the post-call ledger guard to GEPA reflection_lm only."""
        with _LoopbackProvider([
            "[[ ## new_instruction ## ]]\nimproved prompt\n\n[[ ## completed ## ]]",
        ]) as provider:
            bridge, observability = self.make_bridge(provider.url, max_calls=1, max_tokens=1)
            proposer = SkilledProposer(prompt_model=bridge)
            adapter = _OneRowAdapter()
            result = run_official_gepa(
                seed_candidate={"prompt": "old"},
                trainset=[{"id": "synthetic-row"}],
                valset=[{"id": "synthetic-row"}],
                adapter=adapter,
                callback=None,
                hooks=LifecycleHooks(),
                max_metric_calls=8,
                custom_candidate_proposer=proposer,
                proposal_budget=observability.budget,
                config=TextGepaConfig(reflection_model="openai/loopback", reflection_max_tokens=64),
            )

        self.assertEqual(observability.terminal_stats()["call_count"], 1)
        self.assertEqual(observability.terminal_stats()["usage"]["total_tokens"], 22)
        self.assertTrue(observability.has_safe_boundary_stop())
        self.assertEqual(adapter.metric_calls, result.total_metric_calls + 1)

    def test_owned_budget_does_not_stop_a_custom_proposer_with_headroom(self):
        """Mutant: install an always-stop callback instead of the owned budget guard."""
        with _LoopbackProvider([
            "[[ ## new_instruction ## ]]\nimproved prompt\n\n[[ ## completed ## ]]",
        ]) as provider:
            bridge, observability = self.make_bridge(provider.url, max_calls=8, max_tokens=200)
            proposer = SkilledProposer(prompt_model=bridge)
            adapter = _OneRowAdapter()
            result = run_official_gepa(
                seed_candidate={"prompt": "old"},
                trainset=[{"id": "synthetic-row"}],
                valset=[{"id": "synthetic-row"}],
                adapter=adapter,
                callback=None,
                hooks=LifecycleHooks(),
                max_metric_calls=2,
                custom_candidate_proposer=proposer,
                proposal_budget=observability.budget,
                config=TextGepaConfig(reflection_model="openai/loopback", reflection_max_tokens=64),
            )

        self.assertEqual(observability.terminal_stats()["call_count"], 1)
        self.assertFalse(observability.has_safe_boundary_stop())
        self.assertEqual(adapter.metric_calls, result.total_metric_calls + 1)

    def test_bridge_or_event_failure_creates_named_durable_failure_record(self):
        """Mutant: swallow a provider/event error or only write a console log."""
        _ProposalCallBudget, ProposalObservability, _make_skilled_proposer_bridge, _factory = _bridge_contract()
        with tempfile.TemporaryDirectory(prefix="orizu-ali1505-event-failure-") as temporary:
            temporary_path = Path(temporary)
            blocked_event_root = temporary_path / "not-a-directory"
            blocked_event_root.write_text("deliberately not a directory", encoding="utf8")
            observability = ProposalObservability.local_for_test(
                event_log_root=blocked_event_root,
                durable_failure_root=temporary_path / "durable-failures",
            )
            with _LoopbackProvider() as provider:
                bridge, observability = self.make_bridge(provider.url, observability=observability)
                with self.assertRaisesRegex(RuntimeError, "proposal_observability_event_failed"):
                    dspy.Predict(_Echo)(question="record failure", lm=bridge)

            failure = observability.read_durable_failure()
            self.assertEqual(failure["code"], "proposal_observability_event_failed")
            self.assertEqual(failure["source"], "skilled_proposer")

        with _LoopbackProvider(failure_status=503) as provider:
            bridge, observability = self.make_bridge(provider.url)
            proposer = SkilledProposer(prompt_model=bridge)  # default on_error="keep"
            with self.assertRaisesRegex(dspy.LMError, "proposal_provider_transport_failed"):
                proposer(
                    candidate={"prompt": "old"},
                    reflective_dataset={"prompt": [{"Feedback": "improve"}]},
                    components_to_update=["prompt"],
                )

        failure = observability.read_durable_failure()
        self.assertEqual(failure["code"], "proposal_provider_transport_failed")
        self.assertEqual(failure["source"], "skilled_proposer")
        self.assertEqual(observability.terminal_stats()["call_count"], 1)
        self.assertEqual(observability.terminal_stats()["usage"], {
            "input_tokens": 0, "output_tokens": 0, "total_tokens": 0,
        })

        with _LoopbackProvider(responses=[""]) as provider:
            bridge, observability = self.make_bridge(provider.url)
            with self.assertRaisesRegex(dspy.LMError, "proposal_provider_transport_failed"):
                dspy.Predict(_Echo)(question="known refusal usage", lm=bridge)

        self.assertEqual(observability.terminal_stats()["call_count"], 1)
        self.assertEqual(observability.terminal_stats()["usage"], {
            "input_tokens": 17, "output_tokens": 5, "total_tokens": 22,
        })


if __name__ == "__main__":
    expected_python = Path(__file__).resolve().parents[3] / ".scratch-deps" / "venv" / "bin" / "python"
    if not expected_python.exists():
        raise SystemExit(f"ALI-1505_RED_GATE_SETUP_MISSING: expected {expected_python}")
    unittest.main(verbosity=2)
