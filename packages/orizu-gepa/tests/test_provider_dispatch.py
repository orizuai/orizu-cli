"""ORI-2032 rows 8 and 9: the connector reads the registry, not a prefix."""

from __future__ import annotations

import importlib.resources
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import unittest
from unittest.mock import patch

from orizu_gepa.providers import load_provider_registry, protocol_for_identity
from orizu_gepa.reflection import complete_reflection_messages
from orizu_gepa_connector.runtime import build_config_from_environment
from orizu_gepa_connector.skilled_proposer_bridge import _failure_event_provider


class OutputCapRuleTests(unittest.TestCase):
    """Row 8: the launch contract's cap rule keys on the wire protocol.

    Same four cases as `test/cli-gepa-engine-dispatch.test.ts`, because the
    rule has one implementation per language (T2 plan section 10, ruling 3).
    """

    def tearDown(self) -> None:
        load_provider_registry.cache_clear()

    def test_a_chat_completions_provider_needs_no_output_cap(self):
        """Mutant killed: `not model.startswith("openai/")`, which refused
        every OpenRouter run before it could reach the transport."""
        with patch.dict(os.environ, {"ORIZU_REFLECTION_MODEL": "openrouter/anthropic/claude-x"}, clear=True):
            config = build_config_from_environment()

        self.assertEqual(config.reflection_model, "openrouter/anthropic/claude-x")
        self.assertIsNone(config.reflection_max_tokens)

    def test_a_responses_provider_still_needs_no_output_cap(self):
        with patch.dict(os.environ, {"ORIZU_REFLECTION_MODEL": "openai/gpt-test"}, clear=True):
            self.assertIsNone(build_config_from_environment().reflection_max_tokens)

    def test_unset_sampling_settings_survive_the_runner_environment_to_the_chat_transport(self):
        """Kills an upstream default that makes unset indistinguishable from explicit."""
        request_bodies: list[dict[str, object]] = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers["content-length"])
                request_bodies.append(json.loads(self.rfile.read(length)))
                response = json.dumps({
                    "choices": [{"message": {"content": "candidate"}}],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                }).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(response)))
                self.end_headers()
                self.wfile.write(response)

            def log_message(self, _format, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        endpoint = f"http://127.0.0.1:{server.server_port}/chat/completions"
        try:
            with patch.dict(os.environ, {"ORIZU_REFLECTION_MODEL": "openrouter/gpt-x"}, clear=True):
                default_config = build_config_from_environment()
            complete_reflection_messages(
                model=default_config.reflection_model,
                messages=[{"role": "user", "content": "prompt"}],
                config=default_config,
                endpoint_override=endpoint,
                api_key_override="fixture-key",
            )

            with patch.dict(os.environ, {
                "ORIZU_REFLECTION_MODEL": "openrouter/gpt-x",
                "ORIZU_REFLECTION_TEMPERATURE": "0.3",
                "ORIZU_REFLECTION_PROVIDER_SETTINGS": '{"top_p":0.9}',
            }, clear=True):
                explicit_config = build_config_from_environment()
            complete_reflection_messages(
                model=explicit_config.reflection_model,
                messages=[{"role": "user", "content": "prompt"}],
                config=explicit_config,
                endpoint_override=endpoint,
                api_key_override="fixture-key",
            )
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

        self.assertIsNone(default_config.reflection_temperature)
        self.assertNotIn("temperature", request_bodies[0])
        self.assertNotIn("top_p", request_bodies[0])
        self.assertEqual(request_bodies[1]["temperature"], 0.3)
        self.assertEqual(request_bodies[1]["top_p"], 0.9)

    def test_the_messages_protocol_still_requires_an_output_cap(self):
        with patch.dict(os.environ, {"ORIZU_REFLECTION_MODEL": "anthropic/claude-haiku-4-5"}, clear=True):
            with self.assertRaisesRegex(
                RuntimeError,
                r"anthropic-messages protocol.*provider anthropic.*requires --reflection-max-tokens",
            ):
                build_config_from_environment()

    def test_an_unregistered_provider_still_fails_closed(self):
        """Mutant killed: a rule written as `protocol == "anthropic-messages"`,
        which would let azure/x through with no cap and fail at the provider."""
        self.assertIsNone(protocol_for_identity("azure/gpt-x"))
        with patch.dict(os.environ, {"ORIZU_REFLECTION_MODEL": "azure/gpt-x"}, clear=True):
            with self.assertRaisesRegex(
                RuntimeError,
                r'identity "azure/gpt-x" is not a registered provider identity',
            ):
                build_config_from_environment()

    def test_an_unqualified_reflection_model_still_fails_closed(self):
        with patch.dict(os.environ, {"ORIZU_REFLECTION_MODEL": "claude-x"}, clear=True):
            with self.assertRaisesRegex(
                RuntimeError,
                r'identity "claude-x" is not a registered provider identity',
            ):
                build_config_from_environment()


class FailureEventProviderTests(unittest.TestCase):
    """Row 9: the skilled-proposer failure event names the real provider."""

    def tearDown(self) -> None:
        load_provider_registry.cache_clear()

    def test_the_failure_event_names_the_provider_segment(self):
        """Mutant killed: `"openai" if model.startswith("openai/") else
        "anthropic"`, which labelled every OpenRouter proposal failure as an
        Anthropic failure — the label a human reads when a run loses money."""
        self.assertEqual(_failure_event_provider("openrouter/anthropic/claude-x"), "openrouter")
        self.assertEqual(_failure_event_provider("openai/gpt-x"), "openai")
        self.assertEqual(_failure_event_provider("anthropic/claude-x"), "anthropic")
        self.assertEqual(_failure_event_provider("azure/gpt-x"), "azure")
        # An unqualified identity has no provider. Say so rather than name one
        # we invented; the transport refuses it by name anyway.
        self.assertEqual(_failure_event_provider("claude-x"), "unknown")


class VendoredRegistryCopyTests(unittest.TestCase):
    """Both independently vendored packages must carry the same registry.

    The connector's own copy is declared in its `pyproject.toml` package data
    and is the standalone-packaging fallback ALI-1503 would need. Until then
    the loader reads `orizu_gepa`'s copy, so without this test the connector's
    copy could silently rot into a different provider list.
    """

    def test_the_connector_copy_is_byte_identical_to_the_copy_the_loader_reads(self):
        loader_copy = (
            importlib.resources.files("orizu_gepa")
            .joinpath("providers.generated.json")
            .read_bytes()
        )
        connector_copy = (
            importlib.resources.files("orizu_gepa_connector")
            .joinpath("providers.generated.json")
            .read_bytes()
        )

        self.assertEqual(connector_copy, loader_copy)


if __name__ == "__main__":
    unittest.main()
