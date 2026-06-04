from __future__ import annotations

import json
import os
import subprocess
import tempfile
import zipfile
from pathlib import Path
from typing import Any

from .client import OrizuClient
from .optimizer import DatasetRow, PromptContext, RunnerCallResult

MAX_RUNNER_ZIP_BYTES = 25 * 1024 * 1024
MAX_RUNNER_ZIP_ENTRIES = 1000
MAX_RUNNER_UNCOMPRESSED_BYTES = 75 * 1024 * 1024
MAX_RUNNER_OUTPUT_BYTES = 2 * 1024 * 1024
DEFAULT_RUNNER_TIMEOUT_SECONDS = 120

ALLOWED_RUNNER_ENV_KEYS = {
    "PATH",
    "SystemRoot",
    "WINDIR",
    "HOME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "PYTHONPATH",
    "NODE_PATH",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
}


def read_manifest(runner_dir: str | Path) -> dict[str, Any]:
    path = Path(runner_dir) / "manifest.json"
    return json.loads(path.read_text())


def _safe_extract_zip(zip_path: Path, destination: Path) -> None:
    if zip_path.stat().st_size > MAX_RUNNER_ZIP_BYTES:
        raise RuntimeError("Runner artifact exceeds the maximum zip size")

    with zipfile.ZipFile(zip_path) as archive:
        infos = archive.infolist()
        if len(infos) > MAX_RUNNER_ZIP_ENTRIES:
            raise RuntimeError("Runner artifact contains too many files")

        total_uncompressed = 0
        destination_resolved = destination.resolve()
        for info in infos:
            total_uncompressed += info.file_size
            if total_uncompressed > MAX_RUNNER_UNCOMPRESSED_BYTES:
                raise RuntimeError("Runner artifact exceeds the maximum expanded size")

            target = (destination / info.filename).resolve()
            if os.path.commonpath([str(destination_resolved), str(target)]) != str(destination_resolved):
                raise RuntimeError("Runner artifact contains an unsafe path")

        archive.extractall(destination)


def _runner_env(input_path: Path, output_path: Path) -> dict[str, str]:
    env = {
        key: value
        for key, value in os.environ.items()
        if key in ALLOWED_RUNNER_ENV_KEYS
    }
    env["ORIZU_RUNNER_INPUT_PATH"] = str(input_path)
    env["ORIZU_RUNNER_OUTPUT_PATH"] = str(output_path)
    return env


def _bounded_stream(value: str) -> str:
    encoded = value.encode("utf-8", errors="replace")
    if len(encoded) <= MAX_RUNNER_OUTPUT_BYTES:
        return value
    return encoded[:MAX_RUNNER_OUTPUT_BYTES].decode("utf-8", errors="replace") + "\n[truncated]"


def materialize_runner_version(client: OrizuClient, runner_version_id: str) -> tempfile.TemporaryDirectory[str]:
    temp_dir = tempfile.TemporaryDirectory(prefix="orizu-gepa-runner-")
    data = client._request_bytes(f"/api/cli/runner-versions/{runner_version_id}/download")
    zip_path = Path(temp_dir.name) / "runner.zip"
    runner_dir = Path(temp_dir.name) / "runner"
    zip_path.write_bytes(data)
    _safe_extract_zip(zip_path, runner_dir)
    return temp_dir


def run_file_contract_runner(
    *,
    runner_dir: str | Path,
    row: dict[str, Any],
    prompt_body: str | None,
    body_kind: str,
    provider_settings: dict[str, Any],
    prompt_version_id: str,
    runner_version_id: str,
    run_id: str | None,
    timeout_seconds: int = DEFAULT_RUNNER_TIMEOUT_SECONDS,
) -> RunnerCallResult:
    runner_path = Path(runner_dir)
    manifest = read_manifest(runner_path)
    command = manifest.get("command")
    if not isinstance(command, list) or not all(isinstance(item, str) for item in command):
        raise RuntimeError(f"Runner manifest at {runner_path / 'manifest.json'} must include command: string[]")

    with tempfile.TemporaryDirectory(prefix="orizu-gepa-call-") as temp_dir:
        input_path = Path(temp_dir) / "input.json"
        output_path = Path(temp_dir) / "output.json"
        input_path.write_text(json.dumps({
            "row": row,
            "prompt": {
                "body": prompt_body,
                "body_kind": body_kind,
                "provider_settings": provider_settings,
            },
            "prompt_version_id": prompt_version_id,
            "runner_version_id": runner_version_id,
            "run_id": run_id,
        }, ensure_ascii=False))

        try:
            result = subprocess.run(
                command,
                cwd=runner_path,
                env=_runner_env(input_path, output_path),
                text=True,
                capture_output=True,
                check=False,
                timeout=timeout_seconds,
            )
        except subprocess.TimeoutExpired as exc:
            stdout = _bounded_stream(exc.stdout or "")
            stderr = _bounded_stream(exc.stderr or "")
            raise RuntimeError(
                f"Runner timed out after {timeout_seconds}s: {stderr or stdout}"
            ) from exc

        if result.returncode != 0:
            stdout = _bounded_stream(result.stdout or "")
            stderr = _bounded_stream(result.stderr or "")
            raise RuntimeError(
                f"Runner failed with exit code {result.returncode}: {stderr or stdout}"
            )
        data = json.loads(output_path.read_text())
        known = {
            "model_response",
            "raw_api_response",
            "token_in",
            "token_out",
            "latency_ms",
            "cost_usd",
            "error",
        }
        return RunnerCallResult(
            model_response=data.get("model_response"),
            raw_api_response=data.get("raw_api_response"),
            token_in=data.get("token_in"),
            token_out=data.get("token_out"),
            latency_ms=data.get("latency_ms"),
            cost_usd=data.get("cost_usd"),
            error=data.get("error"),
            extra={key: value for key, value in data.items() if key not in known},
        )


def make_candidate_runner(runner_dir: str | Path, run_id: str | None):
    def _run(candidate_text: str, row: DatasetRow, prompt_context: PromptContext, candidate_id: str) -> RunnerCallResult:
        return run_file_contract_runner(
            runner_dir=runner_dir,
            row=row.row,
            prompt_body=candidate_text,
            body_kind=prompt_context.body_kind,
            provider_settings=prompt_context.provider_settings,
            prompt_version_id=prompt_context.prompt_version_id,
            runner_version_id=prompt_context.runner_version_id,
            run_id=run_id,
        )
    return _run


def make_scorer_runner(runner_dir: str | Path, run_id: str | None):
    def _run(row: DatasetRow, candidate_result: RunnerCallResult, scorer_context: PromptContext, candidate_id: str) -> RunnerCallResult:
        scorer_row = {
            "source_row": row.row,
            "candidate_id": candidate_id,
            "candidate_output": candidate_result.model_response,
            "candidate_raw_response": candidate_result.raw_api_response,
            "candidate_error": candidate_result.error,
        }
        return run_file_contract_runner(
            runner_dir=runner_dir,
            row=scorer_row,
            prompt_body=scorer_context.body,
            body_kind=scorer_context.body_kind,
            provider_settings=scorer_context.provider_settings,
            prompt_version_id=scorer_context.prompt_version_id,
            runner_version_id=scorer_context.runner_version_id,
            run_id=run_id,
        )
    return _run
