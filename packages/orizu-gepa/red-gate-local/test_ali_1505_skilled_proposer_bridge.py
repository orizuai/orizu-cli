"""Local-only ALI-1505 red gate; intentionally not unittest-discovered in CI.

Run with:
  PYTHONPATH=packages/orizu-gepa/src:packages/orizu-gepa-python/src:.scratch-deps/cli-shaped/gepa-0.1.4 \
    .scratch-deps/venv/bin/python packages/orizu-gepa/red-gate-local/test_ali_1505_skilled_proposer_bridge.py

The loopback endpoint is synthetic, serves no customer data, and never reaches
an LLM provider. These tests are expected to fail until the production bridge
and its selected-proposer wiring exist.
"""

from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import ssl
import subprocess
import tempfile
from threading import Thread
import unittest
from unittest.mock import patch
from urllib.request import urlopen

import dspy
from gepa.core.adapter import EvaluationBatch
from skilled_proposer import SkilledProposer

from orizu_gepa.optimizer import TextGepaConfig
from orizu_gepa_connector.callbacks import LifecycleHooks
from orizu_gepa_connector.engine import run_official_gepa


class _RecordingProvider(BaseHTTPRequestHandler):
    requests: list[dict] = []
    failure_status: int | None = None
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
        if self.__class__.failure_status is not None:
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
                 failure_status: int | None = None) -> None:
        self.responses = responses or [
            "[[ ## answer ## ]]\nbridge answer\n\n[[ ## completed ## ]]",
        ]
        self.certificate = certificate
        self.failure_status = failure_status

    def __enter__(self) -> "_LoopbackProvider":
        _RecordingProvider.requests = []
        _RecordingProvider.failure_status = self.failure_status
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
