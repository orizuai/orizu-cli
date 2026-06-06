from __future__ import annotations

import json
import os
import ssl
import subprocess
import tempfile
import urllib.error
import urllib.request
from typing import Any

from .optimizer import ReflectionResult, RowEvaluation, TextGepaConfig, build_reflection_prompt, extract_candidate_text


def _read_anthropic_response_with_curl(api_key: str, payload: dict[str, Any]) -> dict[str, Any]:
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".json") as body_file:
        json.dump(payload, body_file)
        body_file.flush()
        curl_config = "\n".join([
            'url = "https://api.anthropic.com/v1/messages"',
            'request = "POST"',
            'header = "anthropic-version: 2023-06-01"',
            'header = "content-type: application/json"',
            f'header = "x-api-key: {api_key}"',
            f'data-binary = "@{body_file.name}"',
            "fail-with-body",
            "silent",
            "show-error",
        ])
        result = subprocess.run(
            ["curl", "--config", "-"],
            input=curl_config,
            text=True,
            capture_output=True,
            check=False,
        )
    if result.returncode != 0:
        detail = "\n".join(part for part in [result.stderr.strip(), result.stdout.strip()] if part)
        raise RuntimeError(f"Reflection LM failed via curl: {detail}")
    return json.loads(result.stdout)


def _merge_provider_settings(
    payload: dict[str, Any],
    settings: dict[str, Any],
    *,
    reserved_keys: set[str],
) -> dict[str, Any]:
    blocked = reserved_keys.intersection(settings)
    if blocked:
        raise RuntimeError(
            f"reflection_provider_settings cannot override reserved request keys: {', '.join(sorted(blocked))}"
        )
    return {**payload, **settings}


def _add_temperature(payload: dict[str, Any], config: TextGepaConfig) -> dict[str, Any]:
    if config.reflection_temperature is None:
        return payload
    if "temperature" in payload and payload["temperature"] != config.reflection_temperature:
        raise RuntimeError("reflection_temperature conflicts with reflection_provider_settings.temperature")
    return {**payload, "temperature": config.reflection_temperature}


def _validate_reflection_max_tokens(value: int | None) -> None:
    if value is not None and value <= 0:
        raise RuntimeError("reflection_max_tokens must be positive")


def _require_anthropic_reflection_max_tokens(value: int | None) -> int:
    _validate_reflection_max_tokens(value)
    if value is None:
        raise RuntimeError("reflection_max_tokens is required for Anthropic reflection models")
    return value


def build_anthropic_reflection_payload(model: str, prompt: str, config: TextGepaConfig) -> dict[str, Any]:
    max_tokens = _require_anthropic_reflection_max_tokens(config.reflection_max_tokens)
    base_payload: dict[str, Any] = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}],
    }
    payload = _merge_provider_settings(
        base_payload,
        config.reflection_provider_settings,
        reserved_keys={"model", "max_tokens", "messages"},
    )
    payload = _add_temperature(payload, config)
    if "temperature" in payload and "thinking" in payload:
        raise RuntimeError("reflection_temperature cannot be combined with Anthropic thinking")
    return payload


def build_openai_reflection_payload(model: str, prompt: str, config: TextGepaConfig) -> dict[str, Any]:
    _validate_reflection_max_tokens(config.reflection_max_tokens)
    base_payload: dict[str, Any] = {
        "model": model,
        "input": [{"role": "user", "content": prompt}],
    }
    if config.reflection_max_tokens is not None:
        base_payload["max_output_tokens"] = config.reflection_max_tokens
    payload = _merge_provider_settings(
        base_payload,
        config.reflection_provider_settings,
        reserved_keys={"model", "input", "max_output_tokens"},
    )
    return _add_temperature(payload, config)


def _extract_openai_output_text(data: dict[str, Any]) -> str:
    output_text = data.get("output_text")
    if isinstance(output_text, str):
        return output_text
    text_parts: list[str] = []
    for item in data.get("output", []):
        if not isinstance(item, dict) or item.get("type") != "message":
            continue
        for content in item.get("content", []):
            if isinstance(content, dict) and content.get("type") == "output_text":
                text = content.get("text")
                if isinstance(text, str):
                    text_parts.append(text)
    return "".join(text_parts)


def reflect_with_anthropic(parent_text: str, parent_results: list[RowEvaluation], config: TextGepaConfig) -> ReflectionResult:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is required for the default reflective LM")
    model = config.reflection_model
    if model.startswith("anthropic/"):
        model = model.split("/", 1)[1]
    prompt = build_reflection_prompt(parent_text, parent_results, config)
    payload = build_anthropic_reflection_payload(model, prompt, config)
    request = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Reflection LM failed: {error.code} {detail}") from error
    except urllib.error.URLError as error:
        if not isinstance(error.reason, ssl.SSLCertVerificationError):
            raise
        data = _read_anthropic_response_with_curl(api_key, payload)
    parts = data.get("content") or []
    text = "".join(part.get("text", "") for part in parts if isinstance(part, dict))
    return ReflectionResult(
        prompt=prompt,
        response=text,
        candidate_text=extract_candidate_text(text),
    )


def reflect_with_openai(parent_text: str, parent_results: list[RowEvaluation], config: TextGepaConfig) -> ReflectionResult:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is required for OpenAI reflection models")
    model = config.reflection_model
    if model.startswith("openai/"):
        model = model.split("/", 1)[1]
    prompt = build_reflection_prompt(parent_text, parent_results, config)
    payload = build_openai_reflection_payload(model, prompt, config)
    request = urllib.request.Request(
        "https://api.openai.com/v1/responses",
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenAI reflection LM failed: {error.code} {detail}") from error
    text = _extract_openai_output_text(data)
    if not text:
        raise RuntimeError("OpenAI reflection LM returned no output text")
    return ReflectionResult(
        prompt=prompt,
        response=text,
        candidate_text=extract_candidate_text(text),
    )


def reflect_with_provider(parent_text: str, parent_results: list[RowEvaluation], config: TextGepaConfig) -> ReflectionResult:
    if config.reflection_model.startswith("openai/"):
        return reflect_with_openai(parent_text, parent_results, config)
    return reflect_with_anthropic(parent_text, parent_results, config)
