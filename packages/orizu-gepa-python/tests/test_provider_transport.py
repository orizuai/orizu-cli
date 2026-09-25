"""H2 (ORI-2032): the Python transport builds every request from the registry.

Outer boundary for hazard H2 in ``docs/requirements/any-provider-support/plan.md``:
a real ``ThreadingHTTPServer`` provider host, real ``urllib``, the real payload
builders and the real registry loader reading a temporary registry JSON whose
``baseUrl`` is that host. The only fake is the provider host itself.
``endpoint_override`` is deliberately never used here: it would bypass the URL
composition under test.
"""

from __future__ import annotations

import json
import os
import ssl
import subprocess
import tempfile
import unittest
import urllib.error
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from unittest import mock

from orizu_gepa import providers
from orizu_gepa.optimizer import TextGepaConfig
from orizu_gepa.providers import (
    ProviderEntry,
    find_provider,
    load_provider_registry,
    parse_model_identity,
    provider_auth_headers,
    provider_endpoint,
    provider_for_identity,
)
from orizu_gepa.reflection import (
    ReflectionProviderError,
    complete_reflection_messages,
    protocol_requires_output_cap,
    reflect_with_provider,
)


MESSAGES_BODY = {
    "id": "msg_fixture",
    "content": [{"type": "text", "text": "ok-messages"}],
    "usage": {"input_tokens": 11, "output_tokens": 3},
}
RESPONSES_BODY = {
    "output_text": "ok-responses",
    "usage": {"input_tokens": 12, "output_tokens": 4, "total_tokens": 16},
}
CHAT_BODY = {
    "id": "chatcmpl_fixture",
    "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok-chat"}}],
    "usage": {"prompt_tokens": 13, "completion_tokens": 5, "total_tokens": 18},
}
RESPONSE_BODY_BY_SUFFIX = {
    "/v1/messages": MESSAGES_BODY,
    "/responses": RESPONSES_BODY,
    "/chat/completions": CHAT_BODY,
}
FIXTURE_CREDENTIAL_ENVS = {
    "anthropic": "ORI2032_FIXTURE_ANTHROPIC_KEY",
    "openai": "ORI2032_FIXTURE_OPENAI_KEY",
    "openrouter": "ORI2032_FIXTURE_OPENROUTER_KEY",
}
FIXTURE_KEYS = {
    "ORI2032_FIXTURE_ANTHROPIC_KEY": "fixture-anthropic-key",
    "ORI2032_FIXTURE_OPENAI_KEY": "fixture-openai-key",
    "ORI2032_FIXTURE_OPENROUTER_KEY": "fixture-openrouter-key",
}


def _shape_violations(path: str, body: dict) -> list[str]:
    """A request whose body does not match the protocol its path names.

    This is the hazard itself: a Responses body delivered to a
    chat-completions endpoint, or a Messages body to either.
    """
    if path.endswith("/chat/completions"):
        problems = []
        if "messages" not in body:
            problems.append(f"{path}: chat completions body has no messages")
        for forbidden in ("input", "max_output_tokens"):
            if forbidden in body:
                problems.append(f"{path}: chat completions body carries {forbidden}")
        return problems
    if path.endswith("/responses"):
        problems = []
        if "input" not in body:
            problems.append(f"{path}: responses body has no input")
        if "messages" in body:
            problems.append(f"{path}: responses body carries messages")
        return problems
    if path.endswith("/v1/messages"):
        problems = []
        if "messages" not in body:
            problems.append(f"{path}: messages body has no messages")
        if "max_tokens" not in body:
            problems.append(f"{path}: messages body has no max_tokens")
        return problems
    return [f"{path}: no protocol owns this path"]


class _ProviderHostHandler(BaseHTTPRequestHandler):
    requests: list[dict] = []
    violations: list[str] = []

    def do_POST(self) -> None:  # noqa: N802 - stdlib callback name
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length).decode("utf-8") if length else ""
        try:
            body = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            body = {}
        type(self).requests.append({
            "path": self.path,
            "headers": {name.lower(): value for name, value in self.headers.items()},
            "header_names": [name for name in self.headers.keys()],
            "body": body,
        })
        type(self).violations.extend(_shape_violations(self.path, body))
        payload = None
        for suffix, response_body in RESPONSE_BODY_BY_SUFFIX.items():
            if self.path.endswith(suffix):
                payload = response_body
                break
        if payload is None:
            self.send_error(404, "no protocol owns this path")
            return
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.send_header("request-id", "req_fixture_messages")
        self.send_header("x-request-id", "req_fixture_openai")
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, *_args) -> None:  # noqa: D102 - silence stdlib logging
        return


@contextmanager
def provider_host():
    _ProviderHostHandler.requests = []
    _ProviderHostHandler.violations = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), _ProviderHostHandler)
    # serve_forever's default 0.5s poll interval is also shutdown's latency, so
    # the default would add half a second per test to this file and push the
    # whole packages/orizu-gepa-python lane past its bun wrapper's budget.
    thread = Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
    thread.start()
    try:
        yield server, f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def fixture_registry(base_url: str) -> dict:
    """Three entries on one host, each with a DIFFERENT base path.

    The differing base paths are deliberate: they reproduce production's
    asymmetric join (`api.anthropic.com` + `/v1/messages` versus
    `api.openai.com/v1` + `/responses`) inside the fixture, so a join that
    drops or doubles a version segment is visible here too.
    """
    return {
        "schemaVersion": "orizu.provider-registry.v1",
        "providers": [
            {
                "id": "anthropic",
                "protocol": "anthropic-messages",
                "baseUrl": base_url,
                "credentialEnv": FIXTURE_CREDENTIAL_ENVS["anthropic"],
                "authHeader": "x-api-key",
                "authValuePrefix": "",
                "builtIn": True,
            },
            {
                "id": "openai",
                "protocol": "openai-responses",
                "baseUrl": f"{base_url}/v1",
                "credentialEnv": FIXTURE_CREDENTIAL_ENVS["openai"],
                "authHeader": "Authorization",
                "authValuePrefix": "Bearer ",
                "builtIn": True,
            },
            {
                "id": "openrouter",
                "protocol": "openai-chat",
                "baseUrl": f"{base_url}/api/v1",
                "credentialEnv": FIXTURE_CREDENTIAL_ENVS["openrouter"],
                "authHeader": "Authorization",
                "authValuePrefix": "Bearer ",
                "builtIn": True,
            },
        ],
    }


@contextmanager
def registry_resource(document) -> Path:
    """Point the real loader at a temporary registry JSON.

    ``_registry_resource`` is the only seam. The loader, the parsing, the
    failure codes and every consumer below it are production code.
    """
    with tempfile.TemporaryDirectory() as root:
        path = Path(root) / "providers.generated.json"
        path.write_text(
            document if isinstance(document, str) else json.dumps(document),
            encoding="utf-8",
        )
        load_provider_registry.cache_clear()
        with mock.patch.object(providers, "_registry_resource", return_value=path):
            try:
                yield path
            finally:
                load_provider_registry.cache_clear()


class ProviderRegistryLoaderTests(unittest.TestCase):
    """Branch audit for every function ORI-2032 adds to orizu_gepa.providers."""

    def tearDown(self) -> None:
        load_provider_registry.cache_clear()

    def test_load_provider_registry_reads_the_three_built_in_entries(self):
        """Kills a loader stub that returns () or drops the protocol field."""
        entries = load_provider_registry()

        self.assertEqual(
            [(entry.id, entry.protocol) for entry in entries],
            [
                ("anthropic", "anthropic-messages"),
                ("openai", "openai-responses"),
                ("openrouter", "openai-chat"),
            ],
        )
        self.assertTrue(all(isinstance(entry, ProviderEntry) for entry in entries))
        self.assertEqual(entries[0].credential_env, "ANTHROPIC_API_KEY")
        self.assertEqual(entries[1].auth_value_prefix, "Bearer ")
        self.assertEqual(entries[0].auth_value_prefix, "")

    def test_find_provider_matches_exactly(self):
        """Kills case folding, prefix matching and an identity passed as an id."""
        self.assertEqual(find_provider("anthropic").id, "anthropic")
        for absent in ("Anthropic", "azure", "", "anthropic/claude", None, "anthropic "):
            with self.subTest(id=absent):
                self.assertIsNone(find_provider(absent))

    def test_parse_model_identity_splits_on_the_first_slash_only(self):
        """Kills a split that discards the vendor segment of a three-part id."""
        self.assertEqual(
            parse_model_identity("openrouter/anthropic/claude-x"),
            ("openrouter", "anthropic/claude-x"),
        )
        self.assertEqual(parse_model_identity("anthropic/"), ("anthropic", ""))
        self.assertEqual(parse_model_identity("claude-x"), (None, "claude-x"))
        self.assertEqual(parse_model_identity(""), (None, ""))

    def test_provider_for_identity_names_an_unqualified_identity(self):
        """Kills the silent default: a bare model id must not become Anthropic."""
        with self.assertRaises(ReflectionProviderError) as raised:
            provider_for_identity("claude-x")

        self.assertEqual(raised.exception.code, "ORI_2032_MODEL_IDENTITY_NOT_QUALIFIED")
        self.assertIn("anthropic/<model id>", str(raised.exception))

    def test_provider_for_identity_names_an_unknown_provider_and_the_registered_ids(self):
        """Kills a fall-through that sends an unregistered provider to Anthropic."""
        with self.assertRaises(ReflectionProviderError) as raised:
            provider_for_identity("azure/gpt-x")

        self.assertEqual(raised.exception.code, "ORI_2032_PROVIDER_UNKNOWN")
        self.assertIn("azure", str(raised.exception))
        self.assertIn("anthropic, openai, openrouter", str(raised.exception))

    def test_provider_for_identity_names_a_protocol_the_transport_cannot_speak(self):
        """Kills a transport that accepts a registry protocol it has no builder for."""
        document = {
            "schemaVersion": "orizu.provider-registry.v1",
            "providers": [{
                "id": "bedrock",
                "protocol": "bedrock-converse",
                "baseUrl": "https://bedrock.invalid",
                "credentialEnv": "BEDROCK_API_KEY",
                "authHeader": "Authorization",
                "authValuePrefix": "Bearer ",
                "builtIn": False,
            }],
        }
        with registry_resource(document), self.assertRaises(ReflectionProviderError) as raised:
            provider_for_identity("bedrock/claude-x")

        self.assertEqual(raised.exception.code, "ORI_2032_PROTOCOL_UNSUPPORTED")
        self.assertIn("bedrock-converse", str(raised.exception))

    def test_registry_failures_are_named_one_by_one(self):
        """Kills a loader that collapses packaging, schema and shape faults into one error."""
        load_provider_registry.cache_clear()
        missing = Path(tempfile.gettempdir()) / "ori2032-absent-registry.json"
        with mock.patch.object(providers, "_registry_resource", return_value=missing), \
             self.assertRaises(ReflectionProviderError) as raised:
            load_provider_registry()
        self.assertEqual(raised.exception.code, "ORI_2032_PROVIDER_REGISTRY_MISSING")
        self.assertIn("orizu_gepa", str(raised.exception))
        self.assertIn("providers.generated.json", str(raised.exception))

        cases = [
            ("not json at all", "ORI_2032_PROVIDER_REGISTRY_INVALID"),
            (json.dumps([]), "ORI_2032_PROVIDER_REGISTRY_INVALID"),
            (json.dumps({"schemaVersion": "orizu.provider-registry.v1"}), "ORI_2032_PROVIDER_REGISTRY_INVALID"),
            (json.dumps({"schemaVersion": "orizu.provider-registry.v2", "providers": []}), "ORI_2032_PROVIDER_REGISTRY_SCHEMA_UNSUPPORTED"),
            (json.dumps({"schemaVersion": "orizu.provider-registry.v1", "providers": [{
                "id": "anthropic",
                "protocol": "anthropic-messages",
                "baseUrl": "https://api.anthropic.com",
                "credentialEnv": "ANTHROPIC_API_KEY",
                "authHeader": "x-api-key",
                "builtIn": True,
            }]}), "ORI_2032_PROVIDER_REGISTRY_INVALID"),
            (json.dumps({"schemaVersion": "orizu.provider-registry.v1", "providers": [{
                "id": "anthropic",
                "protocol": "anthropic-messages",
                "baseUrl": "https://api.anthropic.com",
                "credentialEnv": "ANTHROPIC_API_KEY",
                "authHeader": "x-api-key",
                "authValuePrefix": "",
                "builtIn": "yes",
            }]}), "ORI_2032_PROVIDER_REGISTRY_INVALID"),
        ]
        for document, code in cases:
            with self.subTest(code=code, document=document[:48]):
                with registry_resource(document), self.assertRaises(ReflectionProviderError) as raised:
                    load_provider_registry()
                self.assertEqual(raised.exception.code, code)

        with registry_resource(json.dumps({
            "schemaVersion": "orizu.provider-registry.v2",
            "providers": [],
        })), self.assertRaises(ReflectionProviderError) as raised:
            load_provider_registry()
        self.assertIn("orizu.provider-registry.v1", str(raised.exception))
        self.assertIn("orizu.provider-registry.v2", str(raised.exception))

    def test_provider_auth_headers_reproduce_each_provider_header_bytes(self):
        """Kills a no-op that always emits Authorization, or drops the prefix."""
        entries = {entry.id: entry for entry in load_provider_registry()}

        self.assertEqual(
            provider_auth_headers(entries["anthropic"], "KEY"),
            {"x-api-key": "KEY"},
        )
        self.assertEqual(
            provider_auth_headers(entries["openai"], "KEY"),
            {"Authorization": "Bearer KEY"},
        )
        self.assertEqual(
            provider_auth_headers(entries["openrouter"], "KEY"),
            {"Authorization": "Bearer KEY"},
        )

    def test_protocol_requires_output_cap_fails_closed(self):
        """Kills a rule written as `protocol == 'anthropic-messages'`, which
        would make an unresolved provider skip the mandatory cap."""
        self.assertTrue(protocol_requires_output_cap("anthropic-messages"))
        self.assertFalse(protocol_requires_output_cap("openai-responses"))
        self.assertFalse(protocol_requires_output_cap("openai-chat"))
        self.assertTrue(protocol_requires_output_cap(None))
        self.assertTrue(protocol_requires_output_cap("bedrock-converse"))

    def test_protocol_for_identity_never_raises_for_an_unregistered_provider(self):
        """The cap rule must stay reachable for azure/x: unresolved means the
        cap is required, not that config building explodes with a new code."""
        self.assertEqual(providers.protocol_for_identity("openrouter/x"), "openai-chat")
        self.assertIsNone(providers.protocol_for_identity("azure/x"))
        self.assertIsNone(providers.protocol_for_identity("claude-x"))


class ComposedEndpointTests(unittest.TestCase):
    """OB-H2f: URL literals."""

    def tearDown(self) -> None:
        load_provider_registry.cache_clear()

    def test_the_three_composed_endpoints_equal_todays_literals(self):
        """Mutant killed: a join that drops or doubles a version segment. The
        first two strings are the URLs reflection.py sent before ORI-2032."""
        self.assertEqual(
            provider_endpoint(provider_for_identity("anthropic/claude-x")),
            "https://api.anthropic.com/v1/messages",
        )
        self.assertEqual(
            provider_endpoint(provider_for_identity("openai/gpt-x")),
            "https://api.openai.com/v1/responses",
        )
        self.assertEqual(
            provider_endpoint(provider_for_identity("openrouter/anthropic/claude-x")),
            "https://openrouter.ai/api/v1/chat/completions",
        )

    def test_a_trailing_slash_on_a_base_url_does_not_double_the_separator(self):
        """Kills a naive f"{base_url}{path}" join for a customer base URL
        entered with a trailing slash (ORI-2033 registers these by hand)."""
        entry = ProviderEntry(
            id="proxy",
            protocol="openai-chat",
            base_url="https://proxy.invalid/v1/",
            credential_env="PROXY_API_KEY",
            auth_header="Authorization",
            auth_value_prefix="Bearer ",
            built_in=False,
        )
        self.assertEqual(provider_endpoint(entry), "https://proxy.invalid/v1/chat/completions")


class DeliveredProviderTransportTests(unittest.TestCase):
    """ORI-2037: env delivery through the real packaged loader and HTTP transport."""

    def test_customer_delivery_reaches_real_http_without_packaged_resource_override(self):
        with provider_host() as (_server, base_url):
            entry = {"id": "groq", "protocol": "openai-chat", "baseUrl": base_url,
                     "credentialEnv": "GROQ_API_KEY", "authHeader": "X-Customer-Key", "authValuePrefix": ""}
            dummy = "ORIZU DUMMY NOT A CREDENTIAL:groq:GROQ_API_KEY"
            with mock.patch.dict(os.environ, {"ORIZU_PROVIDER_REGISTRY_EXTRA": json.dumps([entry]), "GROQ_API_KEY": dummy}):
                result = complete_reflection_messages(model="groq/llama-x", messages=[{"role": "user", "content": "prompt"}], config=TextGepaConfig())
            self.assertEqual(result.text, "ok-chat")
            self.assertEqual(_ProviderHostHandler.violations, [])
            self.assertEqual(_ProviderHostHandler.requests[0]["path"], "/chat/completions")
            self.assertEqual(_ProviderHostHandler.requests[0]["body"]["model"], "llama-x")
            self.assertEqual(_ProviderHostHandler.requests[0]["headers"]["x-customer-key"], dummy)
            self.assertNotIn("authorization", _ProviderHostHandler.requests[0]["headers"])

    def test_delivery_changes_are_visible_without_clearing_packaged_cache(self):
        entry = {"id": "groq", "protocol": "openai-chat", "baseUrl": "https://first.example.test/v1",
                 "credentialEnv": "GROQ_API_KEY", "authHeader": "Authorization", "authValuePrefix": "Bearer "}
        with mock.patch.dict(os.environ, {"ORIZU_PROVIDER_REGISTRY_EXTRA": json.dumps([entry])}):
            self.assertEqual(provider_for_identity("groq/llama-x").base_url, entry["baseUrl"])
            entry["baseUrl"] = "https://second.example.test/v1"
            os.environ["ORIZU_PROVIDER_REGISTRY_EXTRA"] = json.dumps([entry])
            self.assertEqual(provider_for_identity("groq/llama-x").base_url, entry["baseUrl"])

    def test_invalid_delivery_is_named_without_echoing_input(self):
        for text in ["{", "{}", '[{"id":"groq"}]']:
            with self.subTest(text=text), mock.patch.dict(os.environ, {"ORIZU_PROVIDER_REGISTRY_EXTRA": text}):
                with self.assertRaises(ReflectionProviderError) as raised:
                    provider_for_identity("groq/llama-x")
                self.assertIn("ORIZU_PROVIDER_REGISTRY_EXTRA", str(raised.exception))

    def test_userinfo_and_duplicate_ids_are_refused_by_delivered_registry(self):
        entry = {"id": "groq", "protocol": "openai-chat", "baseUrl": "https://host.example.test/v1",
                 "credentialEnv": "GROQ_API_KEY", "authHeader": "Authorization", "authValuePrefix": "Bearer "}
        userinfo = f"https://{os.urandom(16).hex()}:{os.urandom(16).hex()}@host.example.test/v1"
        cases = [
            ("URL userinfo", [{**entry, "baseUrl": userinfo}]),
            ("duplicate ids with distinct credential envs", [entry, {**entry, "credentialEnv": "OTHER_API_KEY"}]),
        ]
        for name, rows in cases:
            with self.subTest(name=name), mock.patch.dict(os.environ, {"ORIZU_PROVIDER_REGISTRY_EXTRA": json.dumps(rows)}):
                with self.assertRaises(ReflectionProviderError) as raised:
                    provider_for_identity("groq/llama-x")
                self.assertIn("ORIZU_PROVIDER_REGISTRY_EXTRA", str(raised.exception))

    def test_packaged_builtin_wins_collision_in_real_python_process(self):
        entry = {"id": "anthropic", "protocol": "openai-chat", "baseUrl": "https://wrong.example.test/v1",
                 "credentialEnv": "OTHER_API_KEY", "authHeader": "Authorization", "authValuePrefix": "Bearer "}
        completed = subprocess.run([os.sys.executable, "-c", "from orizu_gepa.providers import provider_for_identity; p=provider_for_identity('anthropic/model'); print(p.base_url, p.credential_env, p.protocol)"],
                                   env={**os.environ, "ORIZU_PROVIDER_REGISTRY_EXTRA": json.dumps([entry])}, capture_output=True, text=True, check=True)
        self.assertEqual(completed.stdout.strip(), "https://api.anthropic.com ANTHROPIC_API_KEY anthropic-messages")


class ProviderTransportAgainstAFakeHostTests(unittest.TestCase):
    """OB-H2a–e: the request that actually leaves the process."""

    def tearDown(self) -> None:
        load_provider_registry.cache_clear()

    def test_ob_h2a_each_identity_reaches_its_protocol_path_with_its_protocol_body(self):
        """Mutant killed: the protocol resolved from the MODEL prefix instead of
        the provider entry. `openrouter/openai/gpt-x` would take the Responses
        branch, arrive at /responses carrying `input`, and the host's own shape
        check would record a violation."""
        with provider_host() as (_server, base_url), \
             registry_resource(fixture_registry(base_url)), \
             mock.patch.dict(os.environ, FIXTURE_KEYS):
            messages = complete_reflection_messages(
                model="anthropic/claude-fixture",
                messages=[{"role": "user", "content": "prompt"}],
                config=TextGepaConfig(reflection_max_tokens=64),
            )
            responses = complete_reflection_messages(
                model="openai/gpt-fixture",
                messages=[{"role": "user", "content": "prompt"}],
                config=TextGepaConfig(reflection_max_tokens=64),
            )
            chat = complete_reflection_messages(
                model="openrouter/openai/gpt-fixture",
                messages=[{"role": "user", "content": "prompt"}],
                config=TextGepaConfig(),
            )

        recorded = _ProviderHostHandler.requests
        self.assertEqual(_ProviderHostHandler.violations, [])
        self.assertEqual(
            [entry["path"] for entry in recorded],
            ["/v1/messages", "/v1/responses", "/api/v1/chat/completions"],
        )

        self.assertEqual(recorded[0]["body"]["messages"], [{"role": "user", "content": "prompt"}])
        self.assertEqual(recorded[0]["body"]["max_tokens"], 64)
        self.assertEqual(recorded[0]["body"]["model"], "claude-fixture")

        self.assertEqual(recorded[1]["body"]["input"], [{"role": "user", "content": "prompt"}])
        self.assertEqual(recorded[1]["body"]["max_output_tokens"], 64)
        self.assertEqual(recorded[1]["body"]["model"], "gpt-fixture")

        # Row 7: the model id keeps every segment after the FIRST slash.
        self.assertEqual(recorded[2]["body"]["model"], "openai/gpt-fixture")
        self.assertEqual(recorded[2]["body"]["messages"], [{"role": "user", "content": "prompt"}])
        self.assertNotIn("reasoning", recorded[2]["body"])
        self.assertNotIn("reasoning_effort", recorded[2]["body"])

        self.assertEqual(messages.text, "ok-messages")
        self.assertEqual(messages.provider, "anthropic")
        self.assertEqual(messages.usage, {"input_tokens": 11, "output_tokens": 3, "total_tokens": 14})
        self.assertEqual(messages.request_id, "req_fixture_messages")

        self.assertEqual(responses.text, "ok-responses")
        self.assertEqual(responses.provider, "openai")
        self.assertEqual(responses.usage, {"input_tokens": 12, "output_tokens": 4, "total_tokens": 16})
        self.assertEqual(responses.request_id, "req_fixture_openai")

        self.assertEqual(chat.text, "ok-chat")
        self.assertEqual(chat.provider, "openrouter")
        # Reported usage, mapped name for name, never summed with anything.
        self.assertEqual(chat.usage, {"input_tokens": 13, "output_tokens": 5, "total_tokens": 18})

    def test_ob_h2b_the_chat_provider_receives_only_its_own_credential_header(self):
        """Mutant killed: a literal env-var name, or an auth header left on the
        Anthropic default. The fixture's credential env names are deliberately
        NOT the production ones, so a hard-coded OPENROUTER_API_KEY fails."""
        with provider_host() as (_server, base_url), \
             registry_resource(fixture_registry(base_url)), \
             mock.patch.dict(os.environ, FIXTURE_KEYS):
            complete_reflection_messages(
                model="openrouter/anthropic/claude-fixture",
                messages=[{"role": "user", "content": "prompt"}],
                config=TextGepaConfig(),
            )

        recorded = _ProviderHostHandler.requests[0]
        self.assertEqual(recorded["headers"]["authorization"], "Bearer fixture-openrouter-key")
        self.assertNotIn("x-api-key", recorded["headers"])
        self.assertNotIn("anthropic-version", recorded["headers"])

    def test_ob_h2b_the_messages_provider_keeps_todays_header_bytes(self):
        """Kills a rework that moves Anthropic onto Authorization: Bearer, or
        drops the API version header the Messages API requires."""
        with provider_host() as (_server, base_url), \
             registry_resource(fixture_registry(base_url)), \
             mock.patch.dict(os.environ, FIXTURE_KEYS):
            complete_reflection_messages(
                model="anthropic/claude-fixture",
                messages=[{"role": "user", "content": "prompt"}],
                config=TextGepaConfig(reflection_max_tokens=64),
            )

        recorded = _ProviderHostHandler.requests[0]
        self.assertEqual(recorded["headers"]["x-api-key"], "fixture-anthropic-key")
        self.assertEqual(recorded["headers"]["anthropic-version"], "2023-06-01")
        self.assertEqual(recorded["headers"]["content-type"], "application/json")
        self.assertNotIn("authorization", recorded["headers"])

    def test_ob_h2c_an_unregistered_provider_is_refused_before_any_request(self):
        """Mutant killed: the silent fall-through that sent azure/gpt-x to
        Anthropic with Anthropic's key."""
        with provider_host() as (_server, base_url), \
             registry_resource(fixture_registry(base_url)), \
             mock.patch.dict(os.environ, FIXTURE_KEYS), \
             self.assertRaises(ReflectionProviderError) as raised:
            complete_reflection_messages(
                model="azure/gpt-x",
                messages=[{"role": "user", "content": "prompt"}],
                config=TextGepaConfig(reflection_max_tokens=64),
            )

        self.assertEqual(raised.exception.code, "ORI_2032_PROVIDER_UNKNOWN")
        self.assertEqual(_ProviderHostHandler.requests, [])

    def test_ob_h2d_a_bare_model_id_is_refused_before_any_request(self):
        """DELIBERATE BEHAVIOUR CHANGE (manager ruling 1): a bare `claude-x` was
        sent to Anthropic; it is now refused by name and the message shows the
        qualified form."""
        with provider_host() as (_server, base_url), \
             registry_resource(fixture_registry(base_url)), \
             mock.patch.dict(os.environ, FIXTURE_KEYS), \
             self.assertRaises(ReflectionProviderError) as raised:
            complete_reflection_messages(
                model="claude-x",
                messages=[{"role": "user", "content": "prompt"}],
                config=TextGepaConfig(reflection_max_tokens=64),
            )

        self.assertEqual(raised.exception.code, "ORI_2032_MODEL_IDENTITY_NOT_QUALIFIED")
        self.assertIn("anthropic/<model id>", str(raised.exception))
        self.assertEqual(_ProviderHostHandler.requests, [])

    def test_ob_h2e_a_broken_registry_stops_the_run_before_any_request(self):
        """Kills a loader failure that degrades to a default provider instead of
        stopping: no request may leave the process on any of these paths."""
        broken = [
            ("ORI_2032_PROVIDER_REGISTRY_MISSING", None),
            ("ORI_2032_PROVIDER_REGISTRY_SCHEMA_UNSUPPORTED", {
                "schemaVersion": "orizu.provider-registry.v0",
                "providers": [],
            }),
            ("ORI_2032_PROVIDER_REGISTRY_INVALID", {
                "schemaVersion": "orizu.provider-registry.v1",
                "providers": [{
                    "id": "anthropic",
                    "protocol": "anthropic-messages",
                    "credentialEnv": "ANTHROPIC_API_KEY",
                    "authHeader": "x-api-key",
                    "authValuePrefix": "",
                    "builtIn": True,
                }],
            }),
        ]
        for code, document in broken:
            with self.subTest(code=code):
                with provider_host(), mock.patch.dict(os.environ, FIXTURE_KEYS):
                    if document is None:
                        load_provider_registry.cache_clear()
                        absent = Path(tempfile.gettempdir()) / "ori2032-absent-registry.json"
                        context = mock.patch.object(providers, "_registry_resource", return_value=absent)
                    else:
                        context = registry_resource(document)
                    with context, self.assertRaises(ReflectionProviderError) as raised:
                        complete_reflection_messages(
                            model="anthropic/claude-fixture",
                            messages=[{"role": "user", "content": "prompt"}],
                            config=TextGepaConfig(reflection_max_tokens=64),
                        )
                    self.assertEqual(raised.exception.code, code)
                    self.assertEqual(_ProviderHostHandler.requests, [])
                load_provider_registry.cache_clear()

    def test_a_missing_credential_names_the_env_var_and_the_provider(self):
        """One template for every provider (manager ruling 2). The two built-in
        codes are unchanged; only the sentence is now uniform."""
        cleared = {name: "" for name in FIXTURE_KEYS}
        with provider_host() as (_server, base_url), \
             registry_resource(fixture_registry(base_url)), \
             mock.patch.dict(os.environ, cleared), \
             self.assertRaises(ReflectionProviderError) as raised:
            complete_reflection_messages(
                model="openrouter/anthropic/claude-fixture",
                messages=[{"role": "user", "content": "prompt"}],
                config=TextGepaConfig(),
            )

        self.assertEqual(raised.exception.code, "ALI_1505_OPENROUTER_API_KEY_MISSING")
        self.assertEqual(
            str(raised.exception),
            'ALI_1505_OPENROUTER_API_KEY_MISSING: ORI2032_FIXTURE_OPENROUTER_KEY is required for provider "openrouter"',
        )
        self.assertEqual(_ProviderHostHandler.requests, [])

    def test_reflect_with_provider_reaches_the_chat_protocol(self):
        """Row 6: one path through complete_reflection_messages. Mutant killed:
        the prefix fork that routed everything non-OpenAI to Anthropic."""
        with provider_host() as (_server, base_url), \
             registry_resource(fixture_registry(base_url)), \
             mock.patch.dict(os.environ, FIXTURE_KEYS):
            result = reflect_with_provider(
                "initial",
                [],
                TextGepaConfig(reflection_model="openrouter/anthropic/claude-fixture"),
            )

        self.assertEqual(result.response, "ok-chat")
        self.assertEqual(_ProviderHostHandler.requests[0]["path"], "/api/v1/chat/completions")
        self.assertEqual(_ProviderHostHandler.requests[0]["body"]["model"], "anthropic/claude-fixture")


class ChatProtocolAtTheRealBoundaryTests(unittest.TestCase):
    """Slice B at the fake host: the measured cap field and detail keys are
    what actually leave the process and what actually comes back."""

    def tearDown(self) -> None:
        load_provider_registry.cache_clear()

    def test_a_capped_chat_run_sends_max_completion_tokens_and_records_its_details(self):
        """Mutant killed: the measured field name changed anywhere between the
        builder and the socket, and detail keys dropped on the way back."""
        with provider_host() as (_server, base_url), \
             registry_resource(fixture_registry(base_url)), \
             mock.patch.dict(os.environ, FIXTURE_KEYS), \
             mock.patch.dict(RESPONSE_BODY_BY_SUFFIX, {"/chat/completions": {
                 "choices": [{"message": {"role": "assistant", "content": "ok-chat"}}],
                 "usage": {
                     "prompt_tokens": 13,
                     "completion_tokens": 5,
                     "total_tokens": 18,
                     "prompt_tokens_details": {"cached_tokens": 8, "audio_tokens": 0},
                     "completion_tokens_details": {"reasoning_tokens": 3, "audio_tokens": 0},
                 },
             }}):
            completion = complete_reflection_messages(
                model="openrouter/openai/gpt-fixture",
                messages=[{"role": "user", "content": "prompt"}],
                config=TextGepaConfig(reflection_max_tokens=48),
            )

        body = _ProviderHostHandler.requests[0]["body"]
        self.assertEqual(_ProviderHostHandler.violations, [])
        self.assertEqual(body["max_completion_tokens"], 48)
        self.assertNotIn("max_tokens", body)
        self.assertNotIn("max_output_tokens", body)
        self.assertEqual(completion.usage, {
            "input_tokens": 13,
            "output_tokens": 5,
            "total_tokens": 18,
            "cached_tokens": 8,
            "reasoning_tokens": 3,
        })


class ChatProtocolBuilderTests(unittest.TestCase):
    """Branch audit for the openai-chat builder, usage and text extraction."""

    def tearDown(self) -> None:
        load_provider_registry.cache_clear()

    def test_chat_payload_rejects_reserved_keys_and_sends_no_responses_fields(self):
        """Kills a chat builder copied from the Responses builder."""
        from orizu_gepa.reflection import _build_openai_chat_completion_payload

        default_payload = _build_openai_chat_completion_payload(
            "gpt-x",
            [{"role": "user", "content": "prompt"}],
            TextGepaConfig(),
        )
        self.assertNotIn("temperature", default_payload)
        self.assertNotIn("top_p", default_payload)

        payload = _build_openai_chat_completion_payload(
            "gpt-x",
            [{"role": "user", "content": "prompt"}],
            TextGepaConfig(reflection_temperature=0.3, reflection_provider_settings={
                "reasoning": {"effort": "medium"},
                "top_p": 0.9,
            }),
        )
        self.assertEqual(payload["model"], "gpt-x")
        self.assertEqual(payload["messages"], [{"role": "user", "content": "prompt"}])
        self.assertNotIn("input", payload)
        self.assertNotIn("max_output_tokens", payload)
        self.assertEqual(payload["temperature"], 0.3)
        # Customer-supplied settings merge verbatim; Orizu maps no reasoning field.
        self.assertEqual(payload["reasoning"], {"effort": "medium"})
        self.assertEqual(payload["top_p"], 0.9)

        with self.assertRaisesRegex(RuntimeError, "reserved request keys"):
            _build_openai_chat_completion_payload(
                "gpt-x",
                [{"role": "user", "content": "prompt"}],
                TextGepaConfig(reflection_provider_settings={"messages": []}),
            )

    def test_chat_payload_sends_the_measured_output_cap_field(self):
        """MEASURED 2026-09-12 against api.openai.com/v1/chat/completions:
        gpt-4o-mini accepts both max_tokens and max_completion_tokens, while
        gpt-5-mini and o4-mini reject max_tokens with unsupported_parameter
        ("Use 'max_completion_tokens' instead"). max_completion_tokens is the
        only field all three accept.

        Mutant killed: `max_tokens` (the documentation-shaped guess, which
        fails on every OpenAI reasoning model) or `max_output_tokens` (the
        Responses field copied across)."""
        from orizu_gepa.reflection import _build_openai_chat_completion_payload

        payload = _build_openai_chat_completion_payload(
            "gpt-x",
            [{"role": "user", "content": "prompt"}],
            TextGepaConfig(reflection_max_tokens=64),
        )
        self.assertEqual(payload["max_completion_tokens"], 64)
        self.assertNotIn("max_tokens", payload)
        self.assertNotIn("max_output_tokens", payload)

        uncapped = _build_openai_chat_completion_payload(
            "gpt-x",
            [{"role": "user", "content": "prompt"}],
            TextGepaConfig(),
        )
        self.assertNotIn("max_completion_tokens", uncapped)

        with self.assertRaisesRegex(RuntimeError, "reserved request keys"):
            _build_openai_chat_completion_payload(
                "gpt-x",
                [{"role": "user", "content": "prompt"}],
                TextGepaConfig(reflection_provider_settings={"max_completion_tokens": 1}),
            )

    def test_chat_usage_records_the_measured_detail_keys_only_when_reported(self):
        """MEASURED 2026-09-12: prompt_tokens_details.cached_tokens and
        completion_tokens_details.reasoning_tokens are both present (type
        number) on gpt-4o-mini, gpt-5-mini and o4-mini.

        Mutant killed: adding either into the three totals — cached_tokens is a
        SUBSET of prompt_tokens and reasoning_tokens a subset of
        completion_tokens, so either sum bills the same tokens twice. Second
        mutant: writing the keys unconditionally, which would record a detail
        a provider never reported."""
        from orizu_gepa.reflection import _openai_chat_usage

        self.assertEqual(
            _openai_chat_usage({"usage": {
                "prompt_tokens": 100,
                "completion_tokens": 10,
                "total_tokens": 110,
                "prompt_tokens_details": {"cached_tokens": 64, "audio_tokens": 0},
                "completion_tokens_details": {"reasoning_tokens": 4, "audio_tokens": 0},
            }}),
            {
                "input_tokens": 100,
                "output_tokens": 10,
                "total_tokens": 110,
                "cached_tokens": 64,
                "reasoning_tokens": 4,
            },
        )

        self.assertEqual(
            _openai_chat_usage({"usage": {
                "prompt_tokens": 100,
                "completion_tokens": 10,
                "total_tokens": 110,
                "prompt_tokens_details": {"audio_tokens": 0},
            }}),
            {"input_tokens": 100, "output_tokens": 10, "total_tokens": 110},
        )

        with self.assertRaises(ReflectionProviderError) as raised:
            _openai_chat_usage({"usage": {
                "prompt_tokens": 100,
                "completion_tokens": 10,
                "total_tokens": 110,
                "prompt_tokens_details": {"cached_tokens": -1},
            }})
        self.assertEqual(raised.exception.code, "ALI_1505_PROVIDER_USAGE_INVALID")

    def test_chat_usage_maps_three_reported_keys_without_summing(self):
        """Kills a mapper that adds prompt_tokens_details.cached_tokens into
        input_tokens the way Anthropic's cache fields are added: for an
        OpenAI-shaped response the detail is a SUBSET of prompt_tokens."""
        from orizu_gepa.reflection import _openai_chat_usage

        mapped = _openai_chat_usage({"usage": {
            "prompt_tokens": 100,
            "completion_tokens": 10,
            "total_tokens": 110,
            "prompt_tokens_details": {"cached_tokens": 64},
            "completion_tokens_details": {"reasoning_tokens": 4},
        }})
        # The three totals are the provider's reported numbers, untouched by
        # any detail beside them. Anthropic's cache fields are added because
        # they are EXCLUSIVE of input_tokens; these are subsets of it.
        self.assertEqual(mapped["input_tokens"], 100)
        self.assertEqual(mapped["output_tokens"], 10)
        self.assertEqual(mapped["total_tokens"], 110)

        for absent in ("prompt_tokens", "completion_tokens", "total_tokens"):
            with self.subTest(absent=absent):
                usage = {"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3}
                del usage[absent]
                with self.assertRaises(ReflectionProviderError) as raised:
                    _openai_chat_usage({"usage": usage})
                self.assertEqual(raised.exception.code, "ALI_1505_PROVIDER_USAGE_INVALID")

        with self.assertRaises(ReflectionProviderError) as raised:
            _openai_chat_usage({})
        self.assertEqual(raised.exception.code, "ALI_1505_PROVIDER_USAGE_MISSING")

    def test_chat_missing_output_text_is_named_and_carries_usage(self):
        """Kills a chat path that returns '' as a successful completion, which
        downstream would bill without a candidate."""
        with provider_host() as (_server, base_url), \
             registry_resource(fixture_registry(base_url)), \
             mock.patch.dict(os.environ, FIXTURE_KEYS), \
             mock.patch.dict(RESPONSE_BODY_BY_SUFFIX, {"/chat/completions": {
                 "choices": [{"message": {"role": "assistant", "content": None}}],
                 "usage": {"prompt_tokens": 13, "completion_tokens": 0, "total_tokens": 13},
             }}), \
             self.assertRaises(ReflectionProviderError) as raised:
            complete_reflection_messages(
                model="openrouter/gpt-fixture",
                messages=[{"role": "user", "content": "prompt"}],
                config=TextGepaConfig(),
            )

        self.assertEqual(raised.exception.code, "ALI_1505_PROVIDER_OUTPUT_TEXT_MISSING")
        self.assertEqual(
            raised.exception.usage,
            {"input_tokens": 13, "output_tokens": 0, "total_tokens": 13},
        )


class CurlFallbackEndpointTests(unittest.TestCase):
    """Row 4: the curl fallback must use the COMPOSED endpoint."""

    def tearDown(self) -> None:
        load_provider_registry.cache_clear()

    def test_the_curl_fallback_posts_to_the_registry_endpoint(self):
        """Mutant killed: the hard-coded https://api.anthropic.com/v1/messages
        literal left behind in the curl config, which would send a customer's
        request to Anthropic even after they pointed the provider elsewhere."""
        captured: list[str] = []

        def fake_curl(arguments, **kwargs):
            captured.append(kwargs["input"])
            headers_path = arguments[arguments.index("--dump-header") + 1]
            Path(headers_path).write_text("HTTP/2 200\r\nrequest-id: req_curl\r\n\r\n", encoding="utf-8")
            return subprocess.CompletedProcess(arguments, 0, stdout=json.dumps({
                "content": [{"type": "text", "text": "improved via curl"}],
                "usage": {"input_tokens": 23, "output_tokens": 7},
            }), stderr="")

        document = fixture_registry("https://anthropic.fixture.invalid")
        ssl_failure = urllib.error.URLError(ssl.SSLCertVerificationError(1, "certificate verify failed"))
        with registry_resource(document), \
             mock.patch.dict(os.environ, FIXTURE_KEYS), \
             mock.patch("orizu_gepa.reflection.urllib.request.urlopen", side_effect=ssl_failure), \
             mock.patch("orizu_gepa.reflection.subprocess.run", side_effect=fake_curl):
            completion = complete_reflection_messages(
                model="anthropic/claude-fixture",
                messages=[{"role": "user", "content": "prompt"}],
                config=TextGepaConfig(reflection_max_tokens=64),
            )

        self.assertEqual(completion.text, "improved via curl")
        self.assertEqual(completion.request_id, "req_curl")
        self.assertIn('url = "https://anthropic.fixture.invalid/v1/messages"', captured[0])
        self.assertIn('header = "x-api-key: fixture-anthropic-key"', captured[0])

    def test_the_openai_protocols_have_no_curl_fallback(self):
        """Kills a rework that wires the Anthropic-only curl escape hatch to
        every protocol, which would send a second billable request."""
        ssl_failure = urllib.error.URLError(ssl.SSLCertVerificationError(1, "certificate verify failed"))
        document = fixture_registry("https://openai.fixture.invalid")
        with registry_resource(document), \
             mock.patch.dict(os.environ, FIXTURE_KEYS), \
             mock.patch("orizu_gepa.reflection.urllib.request.urlopen", side_effect=ssl_failure), \
             mock.patch("orizu_gepa.reflection.subprocess.run") as curl, \
             self.assertRaises(ReflectionProviderError) as raised:
            complete_reflection_messages(
                model="openrouter/gpt-fixture",
                messages=[{"role": "user", "content": "prompt"}],
                config=TextGepaConfig(),
            )

        self.assertEqual(raised.exception.code, "ALI_1505_PROVIDER_CONNECTION_FAILURE")
        curl.assert_not_called()


class ProtocolTableTests(unittest.TestCase):
    """The two halves of the protocol table must name the same protocols."""

    def test_every_addressable_protocol_has_a_transport_row(self):
        """Mutant killed: a protocol added to PROTOCOL_REQUEST_PATHS (so
        provider_for_identity accepts it) with no builder, headers or usage
        mapping — a KeyError mid-run instead of a named refusal at resolution.
        And the reverse: a transport row for a protocol with no request path,
        which would compose a URL equal to the bare base URL."""
        from orizu_gepa.reflection import _PROTOCOL_TRANSPORTS

        self.assertEqual(
            sorted(_PROTOCOL_TRANSPORTS),
            sorted(providers.PROTOCOL_REQUEST_PATHS),
        )
        self.assertEqual(sorted(providers.SUPPORTED_WIRE_PROTOCOLS), sorted(_PROTOCOL_TRANSPORTS))

    def test_each_protocol_keeps_its_own_request_id_header_and_failure_prefix(self):
        """Kills a table collapsed onto one shared header name or message: the
        two existing rows must stay byte-identical to what they sent before."""
        from orizu_gepa.reflection import _PROTOCOL_TRANSPORTS

        self.assertEqual(_PROTOCOL_TRANSPORTS["anthropic-messages"].request_id_header, "request-id")
        self.assertEqual(_PROTOCOL_TRANSPORTS["anthropic-messages"].failure_prefix, "Reflection LM failed")
        self.assertEqual(_PROTOCOL_TRANSPORTS["openai-responses"].request_id_header, "x-request-id")
        self.assertEqual(_PROTOCOL_TRANSPORTS["openai-responses"].failure_prefix, "OpenAI reflection LM failed")
        self.assertEqual(
            _PROTOCOL_TRANSPORTS["openai-responses"].missing_text_code,
            "ALI_1505_OPENAI_OUTPUT_TEXT_MISSING",
        )
        self.assertIsNone(_PROTOCOL_TRANSPORTS["anthropic-messages"].missing_text_code)
        self.assertTrue(_PROTOCOL_TRANSPORTS["anthropic-messages"].curl_fallback)
        self.assertFalse(_PROTOCOL_TRANSPORTS["openai-responses"].curl_fallback)
        self.assertFalse(_PROTOCOL_TRANSPORTS["openai-chat"].curl_fallback)


class RegistryJsonCopyTests(unittest.TestCase):
    """The committed JSON the loader reads is the generated one."""

    def tearDown(self) -> None:
        load_provider_registry.cache_clear()

    def test_the_loader_reads_the_committed_generated_json(self):
        """Kills a loader pointed at a file the generator does not write, which
        test/provider-registry-json-parity.test.ts would then never guard."""
        resource = providers._registry_resource()
        self.assertTrue(resource.is_file())
        self.assertEqual(Path(str(resource)).name, "providers.generated.json")
        document = json.loads(resource.read_text(encoding="utf-8"))
        self.assertEqual(document["schemaVersion"], "orizu.provider-registry.v1")
        self.assertEqual(
            [entry["id"] for entry in document["providers"]],
            ["anthropic", "openai", "openrouter"],
        )


if __name__ == "__main__":
    unittest.main()
