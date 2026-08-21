from __future__ import annotations

import json
import os
import random
import socket
import ssl
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .optimizer import (
    ReflectionResult,
    RetryableReflectionError,
    RowEvaluation,
    TextGepaConfig,
    build_reflection_prompt,
    extract_candidate_text,
)


RETRYABLE_HTTP_STATUS_CODES = {429, 500, 502, 503, 504, 529}
RETRY_BACKOFF_BASE_SECONDS = 5.0
RETRY_BACKOFF_JITTER_SECONDS = 5.0
RETRYABLE_DIRECT_ERRORS = (TimeoutError, socket.timeout, ConnectionResetError, ConnectionAbortedError)


@dataclass(frozen=True)
class ProviderCompletion:
    """The provider facts needed by every reflection caller.

    ``usage`` is provider-derived: Anthropic provides input/output counts and
    its total is their exact sum; OpenAI provides all three fields directly.
    No caller is allowed to replace these values with a character estimate.
    """

    text: str
    usage: dict[str, int]
    request_id: str | None
    latency_ms: float
    provider: str


@dataclass(frozen=True)
class _JsonHttpResponse:
    data: dict[str, Any]
    headers: dict[str, str]
    latency_ms: float = 0.0


class ReflectionProviderError(RuntimeError):
    """A provider transport failure with a stable, operator-visible code."""

    def __init__(self, code: str, message: str, *, usage: dict[str, int] | None = None) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.usage = usage


class RetryableReflectionProviderError(RetryableReflectionError):
    """A retryable provider failure which preserves GEPA's existing type check."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code


def _headers_to_dict(headers: Any) -> dict[str, str]:
    if headers is None:
        return {}
    return {str(name): str(value) for name, value in headers.items()}


def _header_value(headers: dict[str, str], name: str) -> str | None:
    for header_name, value in headers.items():
        if header_name.lower() == name.lower():
            return value
    return None


def _read_anthropic_response_with_curl(api_key: str, payload: dict[str, Any]) -> _JsonHttpResponse:
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".json") as body_file, \
         tempfile.NamedTemporaryFile("w+", encoding="utf-8", suffix=".headers") as headers_file:
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
            ["curl", "--config", "-", "--dump-header", headers_file.name],
            input=curl_config,
            text=True,
            capture_output=True,
            check=False,
        )
        headers_file.seek(0)
        header_lines = headers_file.read().splitlines()
    if result.returncode != 0:
        detail = "\n".join(part for part in [result.stderr.strip(), result.stdout.strip()] if part)
        raise ReflectionProviderError("ALI_1505_ANTHROPIC_CURL_FAILURE", f"Reflection LM failed via curl: {detail}")
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise ReflectionProviderError("ALI_1505_PROVIDER_RESPONSE_INVALID_JSON", "Reflection LM curl response was not JSON") from error
    if not isinstance(data, dict):
        raise ReflectionProviderError("ALI_1505_PROVIDER_RESPONSE_INVALID_SHAPE", "Reflection LM curl response must be a JSON object")
    headers: dict[str, str] = {}
    for line in header_lines[1:]:
        if ":" not in line:
            continue
        name, value = line.split(":", 1)
        headers[name.strip()] = value.strip()
    return _JsonHttpResponse(data=data, headers=headers)


def _validate_positive_http_config(value: int, name: str) -> int:
    if value <= 0:
        raise RuntimeError(f"{name} must be positive")
    return value


def _retry_backoff_seconds(attempt: int) -> float:
    return (RETRY_BACKOFF_BASE_SECONDS * (2 ** attempt)) + random.uniform(0, RETRY_BACKOFF_JITTER_SECONDS)


def _is_retryable_http_status(status_code: int) -> bool:
    return status_code in RETRYABLE_HTTP_STATUS_CODES


def _is_retryable_url_error(error: urllib.error.URLError) -> bool:
    return isinstance(error.reason, RETRYABLE_DIRECT_ERRORS)


def _read_json_response_with_retries(
    request: urllib.request.Request,
    *,
    timeout_seconds: int,
    retry_attempts: int,
    failure_prefix: str,
    ssl_fallback: Callable[[], _JsonHttpResponse] | None = None,
) -> _JsonHttpResponse:
    timeout_seconds = _validate_positive_http_config(timeout_seconds, "reflection_http_timeout_seconds")
    retry_attempts = _validate_positive_http_config(retry_attempts, "reflection_retry_attempts")

    for attempt in range(retry_attempts):
        attempt_started = time.monotonic()
        try:
            with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
                try:
                    data = json.loads(response.read().decode("utf-8"))
                except json.JSONDecodeError as error:
                    raise ReflectionProviderError(
                        "ALI_1505_PROVIDER_RESPONSE_INVALID_JSON",
                        f"{failure_prefix}: provider response was not JSON",
                    ) from error
                if not isinstance(data, dict):
                    raise ReflectionProviderError(
                        "ALI_1505_PROVIDER_RESPONSE_INVALID_SHAPE",
                        f"{failure_prefix}: provider response must be a JSON object",
                    )
                return _JsonHttpResponse(
                    data=data,
                    headers=_headers_to_dict(getattr(response, "headers", None)),
                    latency_ms=(time.monotonic() - attempt_started) * 1000,
                )
        except urllib.error.HTTPError as error:
            if _is_retryable_http_status(error.code) and attempt < retry_attempts - 1:
                error.close()
                time.sleep(_retry_backoff_seconds(attempt))
                continue
            try:
                detail = error.read().decode("utf-8", errors="replace")
            finally:
                error.close()
            if _is_retryable_http_status(error.code):
                raise RetryableReflectionProviderError(
                    "ALI_1505_PROVIDER_RETRYABLE_HTTP_FAILURE",
                    f"{failure_prefix} retryable HTTP failure after {retry_attempts} attempts: "
                    f"{error.code} {detail}"
                ) from error
            raise ReflectionProviderError(
                "ALI_1505_PROVIDER_HTTP_FAILURE", f"{failure_prefix}: {error.code} {detail}"
            ) from error
        except urllib.error.URLError as error:
            if isinstance(error.reason, ssl.SSLCertVerificationError) and ssl_fallback is not None:
                fallback_started = time.monotonic()
                response = ssl_fallback()
                return _JsonHttpResponse(
                    data=response.data,
                    headers=response.headers,
                    latency_ms=(time.monotonic() - fallback_started) * 1000,
                )
            if _is_retryable_url_error(error):
                if attempt < retry_attempts - 1:
                    time.sleep(_retry_backoff_seconds(attempt))
                    continue
                raise RetryableReflectionProviderError(
                    "ALI_1505_PROVIDER_RETRYABLE_CONNECTION_FAILURE",
                    f"{failure_prefix} retryable connection failure after {retry_attempts} attempts: "
                    f"{error.reason}"
                ) from error
            raise ReflectionProviderError(
                "ALI_1505_PROVIDER_CONNECTION_FAILURE", f"{failure_prefix}: {error.reason}"
            ) from error
        except RETRYABLE_DIRECT_ERRORS as error:
            if attempt < retry_attempts - 1:
                time.sleep(_retry_backoff_seconds(attempt))
                continue
            raise RetryableReflectionProviderError(
                "ALI_1505_PROVIDER_TIMEOUT",
                f"{failure_prefix} timed out after {retry_attempts} attempts: {error}"
            ) from error

    raise RetryableReflectionProviderError(
        "ALI_1505_PROVIDER_RETRY_EXHAUSTED", f"{failure_prefix} failed after {retry_attempts} attempts"
    )


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


def _build_anthropic_completion_payload(
    model: str, messages: list[dict[str, Any]], config: TextGepaConfig,
) -> dict[str, Any]:
    max_tokens = _require_anthropic_reflection_max_tokens(config.reflection_max_tokens)
    base_payload: dict[str, Any] = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": messages,
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


def build_anthropic_reflection_payload(model: str, prompt: str, config: TextGepaConfig) -> dict[str, Any]:
    """Preserve the frozen single-user prompt payload contract."""
    return _build_anthropic_completion_payload(model, [{"role": "user", "content": prompt}], config)


def _build_openai_completion_payload(
    model: str, messages: list[dict[str, Any]], config: TextGepaConfig,
) -> dict[str, Any]:
    _validate_reflection_max_tokens(config.reflection_max_tokens)
    base_payload: dict[str, Any] = {
        "model": model,
        "input": messages,
    }
    if config.reflection_max_tokens is not None:
        base_payload["max_output_tokens"] = config.reflection_max_tokens
    payload = _merge_provider_settings(
        base_payload,
        config.reflection_provider_settings,
        reserved_keys={"model", "input", "max_output_tokens"},
    )
    return _add_temperature(payload, config)


def build_openai_reflection_payload(model: str, prompt: str, config: TextGepaConfig) -> dict[str, Any]:
    """Preserve the frozen single-user prompt payload contract."""
    return _build_openai_completion_payload(model, [{"role": "user", "content": prompt}], config)


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


def _required_usage_int(usage: Any, field: str, provider: str) -> int:
    if not isinstance(usage, dict):
        raise ReflectionProviderError(
            "ALI_1505_PROVIDER_USAGE_MISSING", f"{provider} reflection response omitted usage"
        )
    value = usage.get(field)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ReflectionProviderError(
            "ALI_1505_PROVIDER_USAGE_INVALID", f"{provider} reflection response has invalid usage.{field}"
        )
    return value


def _optional_usage_int(usage: dict[str, Any], field: str, provider: str) -> int:
    if field not in usage:
        return 0
    return _required_usage_int(usage, field, provider)


def _anthropic_usage(data: dict[str, Any]) -> dict[str, int]:
    usage = data.get("usage")
    input_tokens = _required_usage_int(usage, "input_tokens", "Anthropic")
    output_tokens = _required_usage_int(usage, "output_tokens", "Anthropic")
    cache_input_tokens = (
        _optional_usage_int(usage, "cache_creation_input_tokens", "Anthropic")
        + _optional_usage_int(usage, "cache_read_input_tokens", "Anthropic")
    )
    total_input_tokens = input_tokens + cache_input_tokens
    # Anthropic's measured response has no total_tokens field. This exact sum
    # is accounting arithmetic over its reported counts, never an estimate.
    return {
        "input_tokens": total_input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": total_input_tokens + output_tokens,
    }


def _openai_usage(data: dict[str, Any]) -> dict[str, int]:
    usage = data.get("usage")
    return {
        "input_tokens": _required_usage_int(usage, "input_tokens", "OpenAI"),
        "output_tokens": _required_usage_int(usage, "output_tokens", "OpenAI"),
        "total_tokens": _required_usage_int(usage, "total_tokens", "OpenAI"),
    }


def _provider_model(model: str, provider: str) -> str:
    prefix = f"{provider}/"
    return model.split("/", 1)[1] if model.startswith(prefix) else model


def _model_for_forced_provider(model: str, provider: str) -> str:
    """Keep direct ``reflect_with_<provider>`` calls on their historical provider."""
    return model if model.startswith(f"{provider}/") else f"{provider}/{model}"


def complete_reflection_messages(
    *, model: str, messages: list[dict[str, Any]], config: TextGepaConfig,
) -> ProviderCompletion:
    """Complete explicit provider messages through the frozen sync transport.

    This is deliberately transport-only: callers own their prompt construction
    and candidate extraction. It preserves the existing retry, timeout, key,
    and Anthropic curl-fallback policy while returning provider usage facts.
    """
    provider = "openai" if model.startswith("openai/") else "anthropic"
    provider_model = _provider_model(model, provider)
    if provider == "anthropic":
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise ReflectionProviderError(
                "ALI_1505_ANTHROPIC_API_KEY_MISSING", "ANTHROPIC_API_KEY is required for the default reflective LM"
            )
        payload = _build_anthropic_completion_payload(provider_model, messages, config)
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
        response = _read_json_response_with_retries(
            request,
            timeout_seconds=config.reflection_http_timeout_seconds,
            retry_attempts=config.reflection_retry_attempts,
            failure_prefix="Reflection LM failed",
            ssl_fallback=lambda: _read_anthropic_response_with_curl(api_key, payload),
        )
        parts = response.data.get("content") or []
        text = "".join(part.get("text", "") for part in parts if isinstance(part, dict))
        return ProviderCompletion(
            text=text,
            usage=_anthropic_usage(response.data),
            request_id=_header_value(response.headers, "request-id"),
            latency_ms=response.latency_ms,
            provider=provider,
        )

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise ReflectionProviderError(
            "ALI_1505_OPENAI_API_KEY_MISSING", "OPENAI_API_KEY is required for OpenAI reflection models"
        )
    payload = _build_openai_completion_payload(provider_model, messages, config)
    request = urllib.request.Request(
        "https://api.openai.com/v1/responses",
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    response = _read_json_response_with_retries(
        request,
        timeout_seconds=config.reflection_http_timeout_seconds,
        retry_attempts=config.reflection_retry_attempts,
        failure_prefix="OpenAI reflection LM failed",
    )
    usage = _openai_usage(response.data)
    text = _extract_openai_output_text(response.data)
    if not text:
        raise ReflectionProviderError(
            "ALI_1505_OPENAI_OUTPUT_TEXT_MISSING",
            "OpenAI reflection LM returned no output text",
            usage=usage,
        )
    return ProviderCompletion(
        text=text,
        usage=usage,
        request_id=_header_value(response.headers, "x-request-id"),
        latency_ms=response.latency_ms,
        provider=provider,
    )


def reflect_with_anthropic(parent_text: str, parent_results: list[RowEvaluation], config: TextGepaConfig) -> ReflectionResult:
    prompt = build_reflection_prompt(parent_text, parent_results, config)
    completion = complete_reflection_messages(
        model=_model_for_forced_provider(config.reflection_model, "anthropic"),
        messages=[{"role": "user", "content": prompt}],
        config=config,
    )
    return ReflectionResult(
        prompt=prompt,
        response=completion.text,
        candidate_text=extract_candidate_text(completion.text),
        usage=completion.usage,
        request_id=completion.request_id,
        latency_ms=completion.latency_ms,
    )


def reflect_with_openai(parent_text: str, parent_results: list[RowEvaluation], config: TextGepaConfig) -> ReflectionResult:
    prompt = build_reflection_prompt(parent_text, parent_results, config)
    completion = complete_reflection_messages(
        model=_model_for_forced_provider(config.reflection_model, "openai"),
        messages=[{"role": "user", "content": prompt}],
        config=config,
    )
    return ReflectionResult(
        prompt=prompt,
        response=completion.text,
        candidate_text=extract_candidate_text(completion.text),
        usage=completion.usage,
        request_id=completion.request_id,
        latency_ms=completion.latency_ms,
    )


def reflect_with_provider(parent_text: str, parent_results: list[RowEvaluation], config: TextGepaConfig) -> ReflectionResult:
    if config.reflection_model.startswith("openai/"):
        return reflect_with_openai(parent_text, parent_results, config)
    return reflect_with_anthropic(parent_text, parent_results, config)
