from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

from orizu_gepa.runner import _safe_extract_zip, run_file_contract_runner


class RunnerWrapperTests(unittest.TestCase):
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
