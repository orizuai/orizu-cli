from __future__ import annotations
import contextlib
import io
import json
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import get_type_hints
from unittest import mock
from orizu_gepa.client import OrizuClient, OrizuEventSink
from orizu_gepa.optimizer import DatasetRow, PromotionResult, PromptContext, ReflectionResult, RunnerCallResult
PROMOTE_ARGUMENTS = {
    "candidate_id": "candidate-2", "prompt_id": "prompt-1",
    "parent_prompt_version_id": "prompt-version-1", "body": "improved instructions",
    "body_kind": "text", "provider_settings": {"model": "anthropic/claude-haiku-4"},
    "runner_version_id": "runner-version-1", "label": None,
}
class PromotionResponseClient(OrizuClient):
    def __init__(self, promotion_response):
        super().__init__("http://127.0.0.1:3000", "agent-token", "team/project")
        self.promotion_response = promotion_response
        self.requests = []
    def _request(self, method, path, body=None):
        self.requests.append({"method": method, "path": path, "body": body})
        if path.endswith("/promote"):
            return self.promotion_response
        return {}
@contextlib.contextmanager
def serve_http(handler):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


class ClientPromotionContractTests(unittest.TestCase):
    def test_byte_download_refreshes_once_after_hosted_token_expiry(self):
        # Mutant killed: leaving _request_bytes outside the 401 refresh path
        # makes registered artifact downloads fail after a long run's token expires.
        observed = []
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                observed.append((self.path, self.headers.get("Authorization")))
                if self.path == "/refresh":
                    payload = b'{"token":"fresh-token"}'
                    self.send_response(200); self.send_header("Content-Length", str(len(payload)))
                    self.end_headers(); self.wfile.write(payload); return
                if self.path == "/bytes" and self.headers.get("Authorization") == "Bearer fresh-token":
                    payload = b"registered-runner-bytes"
                    self.send_response(200); self.send_header("Content-Length", str(len(payload)))
                    self.end_headers(); self.wfile.write(payload); return
                self.send_response(401); self.end_headers(); self.wfile.write(b"expired")
            def log_message(self, *_args):
                return
        with serve_http(Handler) as url:
            client = OrizuClient(url, "expired-token", token_url=f"{url}/refresh")
            self.assertEqual(client._request_bytes("/bytes"), b"registered-runner-bytes")
        self.assertEqual([path for path, _auth in observed], ["/bytes", "/refresh", "/bytes"])

    def test_concurrent_401s_share_one_hosted_token_refresh(self):
        # Mutant killed: removing the refresh lock/stale-token recheck sends one
        # broker mint per worker at simultaneous expiry and can trip its rate limit.
        expired_requests = threading.Barrier(4)
        refresh_count = 0
        refresh_count_lock = threading.Lock()
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                nonlocal refresh_count
                if self.path == "/refresh":
                    with refresh_count_lock:
                        refresh_count += 1
                    payload = b'{"token":"fresh-token"}'
                    self.send_response(200); self.send_header("Content-Length", str(len(payload)))
                    self.end_headers(); self.wfile.write(payload); return
                if self.headers.get("Authorization") == "Bearer expired-token":
                    expired_requests.wait(timeout=2)
                    self.send_response(401); self.end_headers(); self.wfile.write(b"expired"); return
                payload = b'{"ok":true}'
                self.send_response(200); self.send_header("Content-Length", str(len(payload)))
                self.end_headers(); self.wfile.write(payload)
            def log_message(self, *_args):
                return
        with serve_http(Handler) as url:
            client = OrizuClient(url, "expired-token", token_url=f"{url}/refresh")
            with ThreadPoolExecutor(max_workers=4) as pool:
                results = list(pool.map(lambda _index: client._request("GET", "/data"), range(4)))
        self.assertEqual(results, [{"ok": True}] * 4)
        self.assertEqual(refresh_count, 1)

    def test_hosted_refresh_retries_one_broker_rate_limit(self):
        # Mutant killed: swallowing the broker's first 429 turns a recoverable
        # simultaneous-expiry throttle into an optimizer failure.
        refresh_count = 0
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                nonlocal refresh_count
                if self.path == "/refresh":
                    refresh_count += 1
                    if refresh_count == 1:
                        self.send_response(429); self.send_header("Retry-After", "0")
                        self.end_headers(); return
                    payload = b'{"token":"fresh-token"}'
                    self.send_response(200); self.send_header("Content-Length", str(len(payload)))
                    self.end_headers(); self.wfile.write(payload); return
                if self.headers.get("Authorization") == "Bearer expired-token":
                    self.send_response(401); self.end_headers(); self.wfile.write(b"expired"); return
                payload = b'{"ok":true}'
                self.send_response(200); self.send_header("Content-Length", str(len(payload)))
                self.end_headers(); self.wfile.write(payload)
            def log_message(self, *_args):
                return
        with serve_http(Handler) as url:
            client = OrizuClient(url, "expired-token", token_url=f"{url}/refresh")
            self.assertEqual(client._request("GET", "/data"), {"ok": True})
        self.assertEqual(refresh_count, 2)

    def test_hosted_token_broker_refreshes_without_reintroducing_boot_secret(self):
        # Mutants killed: requiring ORIZU_BOOT_SECRET in the child process after
        # the agent-free entrypoint has scrubbed it, or sending an empty bearer
        # header to the local refresh broker.
        client = OrizuClient(
            "http://127.0.0.1:3000", "expired-token", "team/project",
            token_url="http://127.0.0.1:8765/agent-token",
        )
        observed_headers = []
        class Response:
            def __enter__(self):
                return self
            def __exit__(self, *_args):
                return None
            def read(self):
                return b'{"token":"fresh-token"}'
        def urlopen(request, **_kwargs):
            observed_headers.append(dict(request.header_items()))
            return Response()
        with mock.patch("urllib.request.urlopen", side_effect=urlopen):
            self.assertTrue(client._refresh_token())
        self.assertEqual(client.token, "fresh-token")
        self.assertNotIn("Authorization", observed_headers[0])

    def test_public_client_annotations_match_their_wire_results(self):
        # Mutants killed: swap either public return contract back to the stale opposite type.
        self.assertIs(get_type_hints(OrizuClient.start_run)["return"], str)
        self.assertIs(get_type_hints(OrizuClient.promote_candidate)["return"], PromotionResult)
    def test_legacy_prompt_promotion_is_tagged_and_usable_as_a_prompt_result(self):
        # Mutants killed: continue returning the raw string; tag the legacy
        # response as a profile; or stop exposing its prompt-result identity.
        client = PromotionResponseClient({"promptVersionId": "prompt-version-2"})
        result = client.promote_candidate("run-1", **PROMOTE_ARGUMENTS)
        self.assertEqual(result.kind, "prompt")
        self.assertEqual(result.version_id, "prompt-version-2")
        self.assertEqual(result.prompt_version_id, "prompt-version-2")
        self.assertIsNone(result.profile_version_id)
        self.assertEqual(list(result.components), [])
        self.assertEqual(result.result_prompt_version_id, "prompt-version-2")
    def test_tuple_promotion_is_tagged_and_preserves_changed_and_carried_components(self):
        # Mutants killed: read only promptVersionId; collapse a profile into a
        # prompt result; or discard/relabel either changed/carried component.
        client = PromotionResponseClient({"profileVersionId": "profile-version-2", "components": [
            {"key": "system", "status": "changed"}, {"key": "tools", "status": "carried"},
        ]})
        result = client.promote_candidate("run-1", **PROMOTE_ARGUMENTS)
        self.assertEqual(result.kind, "profile")
        self.assertEqual(result.version_id, "profile-version-2")
        self.assertIsNone(result.prompt_version_id)
        self.assertEqual(result.profile_version_id, "profile-version-2")
        self.assertEqual([(item["key"], item["status"]) for item in result.components],
                         [("system", "changed"), ("tools", "carried")])
        self.assertIsNone(result.result_prompt_version_id)
    def test_tuple_promotion_rejects_a_component_status_outside_the_route_contract(self):
        # Mutant killed: accept an arbitrary server status and let downstream
        # callers mistake it for durable changed/carried promotion evidence.
        client = PromotionResponseClient({"profileVersionId": "profile-version-2",
                                          "components": [{"key": "system", "status": "promoted"}]})
        with self.assertRaisesRegex(RuntimeError, "promotion.*component"):
            client.promote_candidate("run-1", **PROMOTE_ARGUMENTS)
    def test_promotion_response_rejects_both_or_neither_artifact_id(self):
        # Mutants killed: select an arbitrary union arm when both IDs arrive,
        # or manufacture an empty promotion when neither route ID is present.
        responses = ({"promptVersionId": "prompt-version-2", "profileVersionId": "profile-version-2",
                      "components": []}, {})
        for response in responses:
            with self.subTest(response=response):
                client = PromotionResponseClient(response)
                with self.assertRaisesRegex(RuntimeError, "invalid promotion response"):
                    client.promote_candidate("run-1", **PROMOTE_ARGUMENTS)
    def test_promotion_response_rejects_non_string_artifact_ids(self):
        # Mutant killed: allow JSON numbers/booleans to flow into UUID fields.
        responses = ({"promptVersionId": 17}, {"profileVersionId": False, "components": []})
        for response in responses:
            with self.subTest(response=response):
                client = PromotionResponseClient(response)
                with self.assertRaisesRegex(RuntimeError, "invalid promotion response"):
                    client.promote_candidate("run-1", **PROMOTE_ARGUMENTS)
    def test_profile_promotion_requires_an_array_of_components(self):
        # Mutants killed: silently drop absent evidence, or iterate an object as
        # if it were the route's ordered changed/carried component array.
        responses = ({"profileVersionId": "profile-version-2"},
                     {"profileVersionId": "profile-version-2", "components": {}})
        for response in responses:
            with self.subTest(response=response):
                client = PromotionResponseClient(response)
                with self.assertRaisesRegex(RuntimeError, "invalid promotion response"):
                    client.promote_candidate("run-1", **PROMOTE_ARGUMENTS)
    def test_profile_promotion_rejects_malformed_component_keys(self):
        # Mutant killed: accept empty/non-string tuple keys that cannot identify
        # a durable instruction-set component.
        responses = (
            {"profileVersionId": "profile-version-2", "components": [{"key": "", "status": "changed"}]},
            {"profileVersionId": "profile-version-2", "components": [{"key": 9, "status": "carried"}]},
            {"profileVersionId": "profile-version-2", "components": [{"status": "changed"}]},
        )
        for response in responses:
            with self.subTest(response=response):
                client = PromotionResponseClient(response)
                with self.assertRaisesRegex(RuntimeError, "promotion.*component"):
                    client.promote_candidate("run-1", **PROMOTE_ARGUMENTS)
    def test_event_sink_keeps_result_prompt_version_for_legacy_only(self):
        # Mutants killed: regress legacy resultPromptVersionId persistence, or
        # write a tuple profile UUID into the prompt-only run result column.
        cases = (({"promptVersionId": "prompt-version-2"}, "prompt-version-2"),
                 ({"profileVersionId": "profile-version-2",
                   "components": [{"key": "system", "status": "changed"}]}, None))
        for response, expected_prompt_version_id in cases:
            with self.subTest(response=response):
                client = PromotionResponseClient(response)
                sink = OrizuEventSink(client, "run-1")
                promotion = sink.promote_candidate(**PROMOTE_ARGUMENTS)
                sink.finish_run(
                    status="succeeded",
                    result_prompt_version_id=promotion.result_prompt_version_id,
                )
                patch = client.requests[-1]
                self.assertEqual(patch["method"], "PATCH")
                self.assertEqual(patch["path"], "/api/cli/optimization-runs/run-1")
                if expected_prompt_version_id is None:
                    self.assertNotIn("resultPromptVersionId", patch["body"])
                else:
                    self.assertEqual(
                        patch["body"]["resultPromptVersionId"],
                        expected_prompt_version_id,
                    )
    def test_legacy_cli_consumes_prompt_and_profile_promotions_without_corrupting_json(self):
        # Mutants killed: keep assigning the tagged result object as the old
        # prompt string; write profileVersionId into resultPromptVersionId; or
        # defer the mismatch until events/result/summary JSON serialization.
        import orizu_gepa.cli as legacy_cli
        cases = (({"promptVersionId": "prompt-version-2"}, "prompt-version-2"), ({
            "profileVersionId": "profile-version-2", "components": [
                {"key": "system", "status": "changed"}, {"key": "tools", "status": "carried"},
            ]}, None))
        for response, expected_prompt_version_id in cases:
            with self.subTest(response=response), tempfile.TemporaryDirectory() as root:
                client = PromotionResponseClient(response)
                def request(method, path, body=None):
                    client.requests.append({"method": method, "path": path, "body": body})
                    if method == "GET" and "/api/cli/runners/exec-context?" in path:
                        if "scorerVersion=" in path:
                            return {"prompt": {
                                "body": "score it", "bodyKind": "text", "providerSettings": {},
                                "promptId": "scorer-prompt", "promptVersionId": "scorer-prompt-version",
                                "runnerVersionId": "scorer-runner-version",
                            }, "scorer": {"versionId": "scorer-version", "metricKey": "accuracy",
                                           "higherIsBetter": True}, "rows": []}
                        split = "validation" if "split=validation" in path else "train"
                        return {"prompt": {
                            "body": "seed", "bodyKind": "text", "providerSettings": {},
                            "promptId": "prompt-id", "promptVersionId": "prompt-version-1",
                            "runnerVersionId": "runner-version",
                        }, "rows": [{"id": f"{split}-1", "row": {"expected": "improved"}}]}
                    if method == "POST" and path.startswith("/api/cli/optimization-runs?"):
                        return {"optimization_run_id": "run-1"}
                    if path.endswith("/promote"):
                        return response
                    return {}
                client._request = request
                def candidate_runner(candidate_text, _row, _context, _candidate_id):
                    return RunnerCallResult(model_response={"answer": candidate_text})
                def scorer_runner(_row, candidate_result, _context, _candidate_id):
                    score = 1.0 if candidate_result.model_response["answer"] == "improved" else 0.0
                    return RunnerCallResult(model_response={"score": score, "feedback": f"score={score}"})
                arguments = ["orizu-gepa", "--project", "team/project",
                    "--optimizer-version-id", "optimizer-version", "--candidate-version-id", "prompt-version-1",
                    "--runner-version-id", "runner-version", "--candidate-runner-dir", "candidate-dir",
                    "--scorer-version-id", "scorer-version", "--scorer-runner-version-id", "scorer-runner-version",
                    "--scorer-runner-dir", "scorer-dir", "--dataset-version-id", "dataset-version",
                    "--split-set-id", "split-set", "--max-iterations", "1", "--minibatch-size", "1",
                    "--auto-promote", "--allow-degenerate-seed", "--no-skip-perfect-parent-reflection",
                    "--log-dir", root]
                stdout = io.StringIO()
                with contextlib.redirect_stdout(stdout), \
                     mock.patch.object(sys, "argv", arguments), \
                     mock.patch.dict("os.environ", {
                         "ORIZU_VERIFIED_RUNNER_DIRS": json.dumps(["candidate-dir", "scorer-dir"]),
                     }, clear=True), \
                     mock.patch.object(legacy_cli.OrizuClient, "from_env", return_value=client), \
                     mock.patch.object(legacy_cli, "resolve_scorer_input_contract", return_value=("gepa", None)), \
                     mock.patch.object(legacy_cli, "make_candidate_runner", return_value=candidate_runner), \
                     mock.patch.object(legacy_cli, "make_scorer_runner", return_value=scorer_runner), \
                    mock.patch.object(legacy_cli, "reflect_with_provider", return_value=ReflectionResult(
                        prompt="reflection prompt", response="improved", candidate_text="improved")):
                    legacy_cli.main()
                summary = json.loads(stdout.getvalue().splitlines()[-1])
                result_artifact = json.loads((Path(root) / "run-1" / "result.json").read_text())
                events = [json.loads(line) for line in
                          (Path(root) / "run-1" / "events.jsonl").read_text().splitlines()]
                promotion_event = next(event for event in events if event["event_type"] == "candidate_promoted")
                patch_body = next(request["body"] for request in reversed(client.requests)
                                  if request["method"] == "PATCH")
                self.assertEqual(summary["promoted_prompt_version_id"], expected_prompt_version_id)
                self.assertEqual(result_artifact["promoted_prompt_version_id"], expected_prompt_version_id)
                self.assertTrue(events)
                json.dumps(summary)
                json.dumps(result_artifact)
                json.dumps(events)
                json.dumps(patch_body)
                if expected_prompt_version_id is None:
                    self.assertNotIn("resultPromptVersionId", patch_body)
                    self.assertIsNone(promotion_event["payload"].get("prompt_version_id"))
                    self.assertEqual(
                        promotion_event["payload"]["profile_version_id"],
                        "profile-version-2",
                    )
                    self.assertEqual(promotion_event["payload"]["components"], [
                        {"key": "system", "status": "changed"},
                        {"key": "tools", "status": "carried"},
                    ])
                else:
                    self.assertEqual(
                        patch_body["resultPromptVersionId"],
                        expected_prompt_version_id,
                    )
                    self.assertEqual(
                        promotion_event["payload"]["prompt_version_id"],
                        expected_prompt_version_id,
                    )
if __name__ == "__main__":
    unittest.main()
