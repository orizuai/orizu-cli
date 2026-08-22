from __future__ import annotations

import json
import os
import subprocess
import tempfile
import zipfile
import re
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
    return json.loads(path.read_text(encoding="utf-8"))


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


def _runner_env(input_path: Path, output_path: Path, instruction_set_dir: Path | None = None) -> dict[str, str]:
    env = {
        key: value
        for key, value in os.environ.items()
        if key in ALLOWED_RUNNER_ENV_KEYS
    }
    env["ORIZU_RUNNER_INPUT_PATH"] = str(input_path)
    env["ORIZU_RUNNER_OUTPUT_PATH"] = str(output_path)
    env.pop("ORIZU_INSTRUCTION_SET_DIR", None)
    if instruction_set_dir is not None:
        env["ORIZU_INSTRUCTION_SET_DIR"] = str(instruction_set_dir)
    return env


def _instruction_component(component: Any) -> tuple[str | None, dict[str, str] | None]:
    if isinstance(component, str):
        return component, None
    if not isinstance(component, dict):
        raise RuntimeError("instruction_set_unresolvable")
    body = component.get("body")
    if isinstance(body, str):
        return body, None
    repo_path = component.get("repoPath", component.get("repo_path"))
    content_sha = component.get("contentSha", component.get("content_sha"))
    commit_sha = component.get("commitSha", component.get("commit_sha"))
    if all(isinstance(value, str) and value for value in (repo_path, content_sha, commit_sha)):
        return None, {"repoPath": repo_path, "contentSha": content_sha, "commitSha": commit_sha}
    raise RuntimeError("instruction_set_unresolvable")


SAFE_SEGMENT = re.compile(r"^[A-Za-z0-9._-]+$")


def _safe_segment(value: str) -> None:
    if not SAFE_SEGMENT.fullmatch(value) or value in {".", ".."} or value.startswith("."):
        raise RuntimeError("instruction_set_path_unsafe")


def _slug(identity: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", identity.replace("/", "__"))


def _write_instruction_set_layout(root: Path, instruction_set: dict[str, Any]) -> None:
    """Mirror the CLI syncToDisk manifest/layout for one exact tuple."""
    name = instruction_set.get("name")
    shape = instruction_set.get("shape")
    model_config = instruction_set.get("model_config", instruction_set.get("modelConfig"))
    if not isinstance(name, str) or not isinstance(shape, list) or not all(isinstance(key, str) for key in shape):
        raise RuntimeError("instruction_set_unresolvable")
    if not isinstance(model_config, dict) or not isinstance(model_config.get("identity"), str):
        raise RuntimeError("instruction_set_unresolvable")
    components = dict(instruction_set.get("components") or {})
    components.update(instruction_set.get("pinned_components", instruction_set.get("pinnedComponents", {})) or {})
    if any(key not in components for key in shape):
        raise RuntimeError("instruction_set_tuple_incomplete")
    if not isinstance(components, dict):
        raise RuntimeError("instruction_set_unresolvable")
    profile_version_id = instruction_set.get("profile_version_id", instruction_set.get("profileVersionId"))
    version_number = instruction_set.get("version_number", instruction_set.get("versionNumber"))
    if not isinstance(profile_version_id, str) or not isinstance(version_number, int):
        raise RuntimeError("instruction_set_unresolvable")

    _safe_segment(name)
    for key in shape:
        _safe_segment(key)
    identity = model_config["identity"]
    slug = _slug(identity)
    _safe_segment(slug)
    destination = root / name
    destination.mkdir(parents=True, exist_ok=True)

    def write_material(relative_root: str) -> dict[str, Any]:
        files: dict[str, str] = {}
        pinned_components: dict[str, dict[str, str]] = {}
        for key in sorted(shape):
            if key not in components:
                raise RuntimeError("instruction_set_unresolvable")
            body, pin = _instruction_component(components[key])
            if body is not None:
                relative = f"{relative_root}/{key}.md"
                target = destination / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(body, encoding="utf-8")
                files[key] = relative
            elif pin is not None:
                pinned_components[key] = pin
        material: dict[str, Any] = {
            "profileVersionId": profile_version_id,
            "versionNumber": version_number,
            "modelConfigIdentity": identity,
            "resolvedFrom": "exact_profile_version",
            "files": files,
        }
        if pinned_components:
            material["pinnedComponents"] = pinned_components
        return material

    material = write_material("default")
    profile = {
        "modelConfigIdentity": identity,
        "slug": slug,
        "resolvedFrom": "exact_profile_version",
        "production": write_material(f"profiles/{slug}"),
    }
    manifest = {
        "manifestVersion": 1,
        "name": name,
        "shape": shape,
        "default": material,
        "profiles": [profile],
    }
    (destination / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _runner_instruction_set_payload(instruction_set: dict[str, Any]) -> dict[str, Any]:
    """The runner receives the tuple, while sync-only provenance stays on disk."""
    components: dict[str, Any] = {}
    pinned_components: dict[str, Any] = dict(instruction_set.get("pinned_components", instruction_set.get("pinnedComponents", {})) or {})
    for key, component in (instruction_set.get("components") or {}).items():
        body, pin = _instruction_component(component)
        if body is not None:
            components[key] = body
        elif pin is not None:
            pinned_components[key] = pin
    payload = {
        "name": instruction_set.get("name"),
        "model_config": instruction_set.get("model_config", instruction_set.get("modelConfig")),
        "shape": instruction_set.get("shape"),
        **({"prompt_component_key": instruction_set["prompt_component_key"]} if isinstance(instruction_set.get("prompt_component_key"), str) else {}),
        "components": components,
    }
    if pinned_components:
        payload["pinned_components"] = pinned_components
    return payload


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
    prompt_body_present: bool = True,
    timeout_seconds: int = DEFAULT_RUNNER_TIMEOUT_SECONDS,
    extra_payload: dict[str, Any] | None = None,
) -> RunnerCallResult:
    runner_path = Path(runner_dir)
    manifest = read_manifest(runner_path)
    command = manifest.get("command")
    if not isinstance(command, list) or not all(isinstance(item, str) for item in command):
        raise RuntimeError(f"Runner manifest at {runner_path / 'manifest.json'} must include command: string[]")

    with tempfile.TemporaryDirectory(prefix="orizu-gepa-call-") as temp_dir:
        input_path = Path(temp_dir) / "input.json"
        output_path = Path(temp_dir) / "output.json"
        instruction_set = (extra_payload or {}).get("instruction_set")
        instruction_set_dir = Path(temp_dir) / "instruction-set" if isinstance(instruction_set, dict) else None
        if instruction_set_dir is not None:
            _write_instruction_set_layout(instruction_set_dir, instruction_set)
        # Extra payload first: the core file-contract keys are authoritative
        # and never overridable by adapter-supplied companions.
        prompt = {
            "body_kind": body_kind,
            "provider_settings": provider_settings,
        }
        # The exec-context response decides whether this key exists. Runners
        # mirror it; no local shape heuristic may silently remove body bytes.
        if prompt_body_present:
            prompt["body"] = prompt_body
        payload_extra = dict(extra_payload or {})
        if isinstance(instruction_set, dict):
            payload_extra["instruction_set"] = _runner_instruction_set_payload(instruction_set)
        input_path.write_text(json.dumps({
            **payload_extra,
            "row": row,
            "prompt": prompt,
            "prompt_version_id": prompt_version_id,
            "runner_version_id": runner_version_id,
            "run_id": run_id,
        }, ensure_ascii=False), encoding="utf-8")

        try:
            result = subprocess.run(
                command,
                cwd=runner_path,
                env=_runner_env(input_path, output_path, instruction_set_dir),
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
        data = json.loads(output_path.read_text(encoding="utf-8"))
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
        instruction_set = prompt_context.instruction_set
        if instruction_set:
            prompt_component_key = instruction_set.get("prompt_component_key")
            if not isinstance(prompt_component_key, str):
                raise RuntimeError("instruction_set_candidate_component_unresolvable")
            instruction_set = dict(instruction_set)
            instruction_set["components"] = {
                **dict(instruction_set.get("components") or {}),
                prompt_component_key: candidate_text,
            }
            pinned_components = dict(instruction_set.get("pinned_components") or {})
            pinned_components.pop(prompt_component_key, None)
            instruction_set["pinned_components"] = pinned_components
        return run_file_contract_runner(
            runner_dir=runner_dir,
            row=row.row,
            prompt_body=candidate_text,
            body_kind=prompt_context.body_kind,
            provider_settings=prompt_context.provider_settings,
            prompt_version_id=prompt_context.prompt_version_id,
            runner_version_id=prompt_context.runner_version_id,
            run_id=run_id,
            extra_payload={"instruction_set": instruction_set} if instruction_set else None,
        )
    return _run


# ALI-1158: the two scorer-runner input contracts.
# - "gepa" (default): the historical GEPA shape — `row` is a wrapper object
#   {source_row, candidate_id, candidate_output, candidate_raw_response,
#   candidate_error}.
# - "flat_row": the score-run shape used by `orizu runners exec
#   --scorer-version` — `row` is the flat dataset row with the candidate
#   output injected, plus the top-level `model_output`/`subject`/`scorer`
#   companions. This is the official adapter for judge runners written for
#   flat-row score runs: it applies at launch (CLI flag or runner manifest)
#   without changing the registered runner bytes, so it composes with the
#   ALI-1159 `--scorer-runner-dir` sha verification.
SCORER_INPUT_CONTRACTS = ("gepa", "flat_row")
DEFAULT_CANDIDATE_OUTPUT_FIELD = "model_output"


def resolve_scorer_input_contract(
    runner_dir: str | Path,
    *,
    input_contract: str | None = None,
    candidate_field: str | None = None,
) -> tuple[str, str]:
    """Resolve the scorer input contract and candidate-output row field.

    Precedence: explicit CLI value > runner manifest (`scorer_input_contract`,
    `candidate_output_field`) > defaults ("gepa", "model_output").
    """
    manifest = read_manifest(runner_dir)
    # ALI-1158 review: resolve by PRESENCE, not truthiness — an empty-string
    # manifest value must fail the validation below, not silently fall back to
    # the default and recreate the wrong-shape silent-zero class.
    if input_contract is not None:
        contract = input_contract
    else:
        manifest_contract = manifest.get("scorer_input_contract")
        contract = manifest_contract if manifest_contract is not None else "gepa"
    if contract not in SCORER_INPUT_CONTRACTS:
        raise RuntimeError(
            f"Unknown scorer input contract {contract!r}; expected one of: "
            + ", ".join(SCORER_INPUT_CONTRACTS)
        )
    if candidate_field is not None:
        explicit_field = candidate_field
    else:
        explicit_field = manifest.get("candidate_output_field")
    if contract == "gepa" and explicit_field is not None:
        # ALI-1158 review: a candidate-output field only means something under
        # flat_row. Silently ignoring it here would recreate the silent-no-op
        # failure class this ticket exists to remove, so refuse loudly.
        source = "--scorer-candidate-field" if candidate_field else "manifest candidate_output_field"
        raise RuntimeError(
            f"A candidate output field ({explicit_field!r} via {source}) was provided, but the "
            "active scorer input contract is 'gepa', which ignores it. Pass "
            "--scorer-input-contract flat_row (or declare scorer_input_contract: \"flat_row\" "
            "in the runner manifest) to use the field, or drop it."
        )
    field = explicit_field if explicit_field is not None else DEFAULT_CANDIDATE_OUTPUT_FIELD
    if not isinstance(field, str) or not field.strip():
        raise RuntimeError(
            "candidate output field must be a non-empty string "
            f"(got {field!r} via --scorer-candidate-field / manifest candidate_output_field)"
        )
    if field == "candidate_error":
        # Reserved companion: the adapter always injects the candidate's error
        # under this key AFTER the candidate output, so naming it as the
        # output field would silently hand the judge the error instead of the
        # draft (ALI-1158 review, codex round 6).
        raise RuntimeError(
            "candidate output field 'candidate_error' is reserved for the "
            "adapter's error companion; choose a different row field"
        )
    return contract, field


def make_scorer_runner(
    runner_dir: str | Path,
    run_id: str | None,
    *,
    input_contract: str | None = None,
    candidate_field: str | None = None,
):
    contract, resolved_candidate_field = resolve_scorer_input_contract(
        runner_dir,
        input_contract=input_contract,
        candidate_field=candidate_field,
    )

    def _run(row: DatasetRow, candidate_result: RunnerCallResult, scorer_context: PromptContext, candidate_id: str) -> RunnerCallResult:
        extra_payload: dict[str, Any] | None = None
        if contract == "flat_row":
            source_row = row.row if isinstance(row.row, dict) else {"value": row.row}
            scorer_row = {
                **source_row,
                resolved_candidate_field: candidate_result.model_response,
                # ALI-1158 review: candidate errors are first-class in the row
                # under BOTH contracts — a candidate that errored during
                # generation must be inspectable by the judge, not judged as
                # if it produced an empty draft.
                "candidate_error": candidate_result.error,
            }
            scorer_version_id = scorer_context.scorer_version_id or scorer_context.prompt_version_id
            extra_payload = {
                "model_output": candidate_result.model_response,
                "subject": {
                    "type": "scorer_row",
                    "row_id": row.id,
                    "scorer_version_id": scorer_version_id,
                    "prompt_version_id": scorer_context.prompt_version_id,
                },
                "scorer": {
                    "version_id": scorer_version_id,
                    "metric_key": scorer_context.metric_key or "score",
                    "higher_is_better": scorer_context.higher_is_better,
                },
                # GEPA provenance for adapters that want it, namespaced so it
                # cannot collide with dataset row fields.
                "gepa": {
                    "candidate_id": candidate_id,
                    "candidate_raw_response": candidate_result.raw_api_response,
                    "candidate_error": candidate_result.error,
                },
            }
        else:
            scorer_row = {
                "source_row": row.row,
                "candidate_id": candidate_id,
                "candidate_output": candidate_result.model_response,
                "candidate_raw_response": candidate_result.raw_api_response,
                "candidate_error": candidate_result.error,
            }
        if scorer_context.instruction_set:
            extra_payload = {**(extra_payload or {}), "instruction_set": scorer_context.instruction_set}
        return run_file_contract_runner(
            runner_dir=runner_dir,
            row=scorer_row,
            prompt_body=scorer_context.body,
            prompt_body_present=scorer_context.body_present,
            body_kind=scorer_context.body_kind,
            provider_settings=scorer_context.provider_settings,
            prompt_version_id=scorer_context.prompt_version_id,
            runner_version_id=scorer_context.runner_version_id,
            run_id=run_id,
            extra_payload=extra_payload,
        )
    return _run
