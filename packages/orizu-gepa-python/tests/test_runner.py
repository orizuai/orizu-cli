from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
import uuid
import zipfile
from pathlib import Path
from unittest.mock import patch

from orizu_gepa.runner import _runner_env, _safe_extract_zip, run_file_contract_runner


class RunnerWrapperTests(unittest.TestCase):
    def test_real_scorer_children_forward_registered_keys_and_report_stripping_once(self):
        # ORI-2036: fresh Python process -> production wrapper -> two scorer children.
        for hosted in (False, True):
            with self.subTest(hosted=hosted), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / "manifest.json").write_text(json.dumps({"command": [sys.executable, "scorer.py"]}))
                (root / "scorer.py").write_text(
                    "import json, os\nfrom pathlib import Path\n"
                    "Path(os.environ['ORIZU_RUNNER_OUTPUT_PATH']).write_text(json.dumps({'model_response': sorted(os.environ), 'error': None}))\n"
                )
                quiet_names = ["ORIZU_TOKEN", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "CLAUDE_CODE_MESSAGING_TOKEN", "ORIZU_RUN_API_KEY",
                               "GEMINI_API_KEY", "GOOGLE_API_KEY", "ALI_1505_ENDPOINT_OVERRIDE_API_KEY", "BRAINTRUST_API_KEY",
                               "CF_API_KEY", "CLOUDFLARE_API_KEY", "DAYTONA_API_KEY", "INTERNAL_API_KEY", "LINEAR_API_KEY", "RESEND_API_KEY"]
                names = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "CUSTOM_GATEWAY_API_KEY", "UNREGISTERED_API_KEY", *quiet_names]
                values = {name: str(uuid.uuid4()) for name in names}
                environment = {"PATH": os.environ.get("PATH", ""), "HOME": directory,
                               "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src"),
                               "REQUESTS_CA_BUNDLE": "/trust/example.pem", **values}
                if hosted:
                    environment["ORIZU_PROVIDER_REGISTRY_EXTRA"] = json.dumps([{
                        "id": "gateway", "protocol": "openai-chat", "baseUrl": "https://gateway.example.test/v1",
                        "credentialEnv": "CUSTOM_GATEWAY_API_KEY", "authHeader": "Authorization", "authValuePrefix": "Bearer ",
                    }])
                program = (
                    "import json, sys\nfrom orizu_gepa.runner import run_file_contract_runner\n"
                    "for index in range(2):\n"
                    " result = run_file_contract_runner(runner_dir=sys.argv[1], row={'id': str(index)}, prompt_body='score', body_kind='text', provider_settings={}, prompt_version_id='p', runner_version_id='r', run_id='run')\n"
                    " print(json.dumps(result.model_response))\n"
                )
                result = subprocess.run([sys.executable, "-c", program, directory], env=environment, capture_output=True, text=True, timeout=20)
                self.assertEqual(result.returncode, 0)
                rows = [json.loads(line) for line in result.stdout.splitlines()]
                self.assertEqual(len(rows), 2)
                for received in rows:
                    for name in ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "REQUESTS_CA_BUNDLE", "ORIZU_RUNNER_INPUT_PATH", "ORIZU_RUNNER_OUTPUT_PATH"]:
                        self.assertIn(name, received)
                    self.assertEqual("CUSTOM_GATEWAY_API_KEY" in received, hosted)
                    for name in [*quiet_names, "UNREGISTERED_API_KEY", "ORIZU_PROVIDER_REGISTRY_EXTRA"]:
                        self.assertNotIn(name, received)
                notices = [line for line in result.stderr.splitlines() if "Stripped runner credentials:" in line]
                self.assertEqual(len(notices), 1)
                # F2: infrastructure and historical reservations are stripped silently.
                self.assertIn("UNREGISTERED_API_KEY", notices[0])
                for name in quiet_names:
                    self.assertNotIn(name, notices[0])
                self.assertEqual("CUSTOM_GATEWAY_API_KEY" in notices[0], not hosted)
                self.assertNotIn("Stripped runner credentials:", result.stdout)
                self.assertFalse(any(value in result.stdout + result.stderr for value in values.values()))

    def test_runner_env_forwards_hosted_sandbox_tls_trust_without_inventing_it(self):
        trust_environment = {
            "AWS_CA_BUNDLE": "/sandbox/ca/aws.pem",
            "CURL_CA_BUNDLE": "/sandbox/ca/curl.pem",
            "GIT_SSL_CAINFO": "/sandbox/ca/git.pem",
            "GRPC_DEFAULT_SSL_ROOTS_FILE_PATH": "/sandbox/ca/grpc.pem",
            "NODE_EXTRA_CA_CERTS": "/sandbox/ca/node.pem",
            "NODE_USE_SYSTEM_CA": "1",
            "PIP_CERT": "/sandbox/ca/pip.pem",
            "REQUESTS_CA_BUNDLE": "/sandbox/ca/requests.pem",
            "SSL_CERT_FILE": "/sandbox/ca/ssl.pem",
        }

        with patch.dict(os.environ, trust_environment, clear=True):
            runner_environment = _runner_env(Path("input.json"), Path("output.json"))

        self.assertEqual(
            {key: runner_environment[key] for key in trust_environment if key in runner_environment},
            trust_environment,
        )

        with patch.dict(os.environ, {}, clear=True):
            runner_environment_without_trust = _runner_env(Path("input.json"), Path("output.json"))

        for key in trust_environment:
            self.assertNotIn(key, runner_environment_without_trust)

    def test_runner_subprocess_gets_minimal_env_without_orizu_credentials(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            runner_dir = Path(temp_dir)
            (runner_dir / "manifest.json").write_text(json.dumps({
                "command": [sys.executable, "runner.py"],
            }))
            (runner_dir / "runner.py").write_text(
                """
import json
import os

output_path = os.environ["ORIZU_RUNNER_OUTPUT_PATH"]
with open(output_path, "w") as handle:
    json.dump({
        "model_response": {
            "has_orizu_token": "ORIZU_TOKEN" in os.environ,
            "has_provider_key": "ANTHROPIC_API_KEY" in os.environ,
            "has_input_path": "ORIZU_RUNNER_INPUT_PATH" in os.environ,
        },
        "error": None,
    }, handle)
"""
            )

            old_orizu_token = os.environ.get("ORIZU_TOKEN")
            old_provider_key = os.environ.get("ANTHROPIC_API_KEY")
            os.environ["ORIZU_TOKEN"] = "control-plane-token"
            os.environ["ANTHROPIC_API_KEY"] = "provider-token"
            try:
                result = run_file_contract_runner(
                    runner_dir=runner_dir,
                    row={"id": "row-1"},
                    prompt_body="score it",
                    body_kind="text",
                    provider_settings={},
                    prompt_version_id="prompt-version-1",
                    runner_version_id="runner-version-1",
                    run_id="run-1",
                )
            finally:
                if old_orizu_token is None:
                    os.environ.pop("ORIZU_TOKEN", None)
                else:
                    os.environ["ORIZU_TOKEN"] = old_orizu_token
                if old_provider_key is None:
                    os.environ.pop("ANTHROPIC_API_KEY", None)
                else:
                    os.environ["ANTHROPIC_API_KEY"] = old_provider_key

            self.assertEqual(result.model_response, {
                "has_orizu_token": False,
                "has_provider_key": True,
                "has_input_path": True,
            })

    def test_runner_zip_extraction_rejects_zip_slip_paths(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            zip_path = Path(temp_dir) / "runner.zip"
            destination = Path(temp_dir) / "runner"
            with zipfile.ZipFile(zip_path, "w") as archive:
                archive.writestr("../escape.txt", "nope")

            with self.assertRaisesRegex(RuntimeError, "unsafe path"):
                _safe_extract_zip(zip_path, destination)


if __name__ == "__main__":
    unittest.main()
