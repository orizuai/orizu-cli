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
from .providers import (
    ProviderEntry,
    ReflectionProviderError,
    parse_model_identity,
    provider_auth_headers,
    provider_endpoint,
    provider_for_identity,
)


RETRYABLE_HTTP_STATUS_CODES = {429, 500, 502, 503, 504, 529}
RETRY_BACKOFF_BASE_SECONDS = 5.0
RETRY_BACKOFF_JITTER_SECONDS = 5.0
RETRYABLE_DIRECT_ERRORS = (TimeoutError, socket.timeout, ConnectionResetError, ConnectionAbortedError)


@dataclass(frozen=True)
class ProviderCompletion:
    """The provider facts needed by every reflection caller.

    ``usage`` is REPORTED USAGE, recorded per WIRE PROTOCOL rather than per
    provider, because the response shape belongs to the protocol:

    * Anthropic Messages reports input and output counts, and Orizu's
      ``total_tokens`` is their exact sum (its cache counts are exclusive of
      ``input_tokens``, so they are added in).
    * OpenAI Responses reports all three counts directly.
    * OpenAI chat completions reports all three under ``prompt_tokens``,
      ``completion_tokens`` and ``total_tokens``.

    Optional detail fields appear only when the provider reported them and are
    never folded into the three totals. No caller is allowed to replace these
    values with a character estimate.
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


# ``ReflectionProviderError`` is imported from ``providers.py`` above and
# re-exported by that import: the registry loader has to raise it, and
# importing this module from there would be a cycle. Every existing caller
# imports it from this module and keeps working, because it is the same class.
# No ``__all__`` here on purpose — declaring one would silently narrow every
# other public name in this module.


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


def _read_anthropic_response_with_curl(api_key: str, payload: dict[str, Any], endpoint: str) -> _JsonHttpResponse:
    """The SSL-failure escape hatch, wired to ``anthropic-messages`` only.

    ``endpoint`` is the composed registry endpoint, not a literal, so the
    fallback cannot address a different host from the request it replaces.
    """
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".json") as body_file, \
         tempfile.NamedTemporaryFile("w+", encoding="utf-8", suffix=".headers") as headers_file:
        json.dump(payload, body_file)
        body_file.flush()
        curl_config = "\n".join([
            f'url = "{endpoint}"',
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
    ssl_context: ssl.SSLContext | None = None,
) -> _JsonHttpResponse:
    timeout_seconds = _validate_positive_http_config(timeout_seconds, "reflection_http_timeout_seconds")
    retry_attempts = _validate_positive_http_config(retry_attempts, "reflection_retry_attempts")

    for attempt in range(retry_attempts):
        attempt_started = time.monotonic()
        try:
            urlopen_kwargs: dict[str, Any] = {"timeout": timeout_seconds}
            if ssl_context is not None:
                urlopen_kwargs["context"] = ssl_context
            with urllib.request.urlopen(request, **urlopen_kwargs) as response:
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


#: Protocols whose output-token cap is optional. Anthropic Messages mandates
#: ``max_tokens``; an UNRESOLVED protocol is treated as mandatory so an
#: unregistered provider keeps failing closed.
_OPTIONAL_OUTPUT_CAP_PROTOCOLS = frozenset({"openai-responses", "openai-chat"})


def protocol_requires_output_cap(protocol: str | None) -> bool:
    """Whether a wire protocol makes an output-token cap mandatory.

    The TypeScript copy is ``protocolRequiresOutputCap`` in
    ``packages/cli/src/provider-registry.ts``; matching tests pin both sides
    (T2 plan section 10, ruling 3).
    """
    return protocol not in _OPTIONAL_OUTPUT_CAP_PROTOCOLS


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


def _build_openai_chat_completion_payload(
    model: str, messages: list[dict[str, Any]], config: TextGepaConfig,
) -> dict[str, Any]:
    """The `openai-chat` body, with sampling controls only when explicitly set.

    An unset ``reflection_temperature`` stays absent; ``top_p`` appears only
    through explicit ``reflection_provider_settings``. This matters because
    gpt-5-mini and o4-mini rejected both fields in the 2026-09-15 measurement.

    No reasoning field is mapped here. ``reflection_provider_settings`` merges
    verbatim, so a customer-supplied ``reasoning`` block reaches the provider
    untouched — which is what ``providerSettingKeys('openai-chat')`` promised.
    Orizu invents no reasoning field, because the protocol is not enough to
    decide one (OpenRouter takes ``reasoning.effort``, OpenAI chat takes a
    top-level ``reasoning_effort``).

    The output cap is ``max_completion_tokens``, MEASURED on 2026-09-12
    against ``api.openai.com/v1/chat/completions``: gpt-4o-mini accepts both
    ``max_tokens`` and ``max_completion_tokens``, while gpt-5-mini and o4-mini
    reject ``max_tokens`` with ``unsupported_parameter`` and name
    ``max_completion_tokens`` as the replacement. It is the only field all
    three accepted. The measured contract is in the T2 plan; OpenRouter itself
    is UNMEASURED, and the cap is optional for this protocol, so a run without
    ``--reflection-max-tokens`` sends no cap field at all.
    """
    _validate_reflection_max_tokens(config.reflection_max_tokens)
    base_payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
    }
    if config.reflection_max_tokens is not None:
        base_payload["max_completion_tokens"] = config.reflection_max_tokens
    payload = _merge_provider_settings(
        base_payload,
        config.reflection_provider_settings,
        reserved_keys={"model", "messages", "max_completion_tokens"},
    )
    return _add_temperature(payload, config)


def _extract_anthropic_output_text(data: dict[str, Any]) -> str:
    parts = data.get("content") or []
    return "".join(part.get("text", "") for part in parts if isinstance(part, dict))


def _extract_chat_output_text(data: dict[str, Any]) -> str:
    """``choices[0].message.content`` when it is a string, else empty."""
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    choice = choices[0]
    if not isinstance(choice, dict):
        return ""
    message = choice.get("message")
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    return content if isinstance(content, str) else ""


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


def _openai_chat_usage(data: dict[str, Any]) -> dict[str, int]:
    """Reported usage, mapped name for name, summed with nothing.

    ``prompt_tokens_details.cached_tokens`` is deliberately NOT added into
    ``input_tokens``. Anthropic's cache counts are exclusive of its
    ``input_tokens``, which is why ``_anthropic_usage`` adds them; an
    OpenAI-shaped ``cached_tokens`` is a SUBSET of ``prompt_tokens``, so adding
    it would bill the same tokens twice.

    The two detail keys are recorded beside the totals, never inside them, and
    only when the provider reported them. MEASURED 2026-09-12 on gpt-4o-mini,
    gpt-5-mini and o4-mini: ``prompt_tokens_details.cached_tokens`` and
    ``completion_tokens_details.reasoning_tokens`` were both present. A
    permanent home for them is ORI-2035's per-protocol usage bag.
    """
    usage = data.get("usage")
    mapped = {
        "input_tokens": _required_usage_int(usage, "prompt_tokens", "Chat completions"),
        "output_tokens": _required_usage_int(usage, "completion_tokens", "Chat completions"),
        "total_tokens": _required_usage_int(usage, "total_tokens", "Chat completions"),
    }
    for detail_field, nested_field, reported_as in (
        ("prompt_tokens_details", "cached_tokens", "cached_tokens"),
        ("completion_tokens_details", "reasoning_tokens", "reasoning_tokens"),
    ):
        details = usage.get(detail_field) if isinstance(usage, dict) else None
        if isinstance(details, dict) and nested_field in details:
            mapped[reported_as] = _required_usage_int(details, nested_field, "Chat completions")
    return mapped


@dataclass(frozen=True)
class _ProtocolTransport:
    """Everything that differs between wire protocols, in one row each.

    This table replaced the ``if provider == "anthropic"`` fork. The two
    existing rows are byte-identical to what they sent before ORI-2032,
    including the header-name casing (``content-type`` lowercase for Anthropic,
    ``Content-Type`` for OpenAI) and every operator-visible message prefix.
    """

    build_payload: Callable[[str, list[dict[str, Any]], TextGepaConfig], dict[str, Any]]
    content_headers: dict[str, str]
    request_id_header: str
    failure_prefix: str
    read_usage: Callable[[dict[str, Any]], dict[str, int]]
    extract_text: Callable[[dict[str, Any]], str]
    # Anthropic Messages has always accepted an empty content list as a
    # successful completion; the two OpenAI protocols name it.
    missing_text_code: str | None
    missing_text_message: str
    curl_fallback: bool


_PROTOCOL_TRANSPORTS: dict[str, _ProtocolTransport] = {
    "anthropic-messages": _ProtocolTransport(
        build_payload=_build_anthropic_completion_payload,
        content_headers={"anthropic-version": "2023-06-01", "content-type": "application/json"},
        request_id_header="request-id",
        failure_prefix="Reflection LM failed",
        read_usage=_anthropic_usage,
        extract_text=_extract_anthropic_output_text,
        missing_text_code=None,
        missing_text_message="",
        curl_fallback=True,
    ),
    "openai-responses": _ProtocolTransport(
        build_payload=_build_openai_completion_payload,
        content_headers={"Content-Type": "application/json"},
        request_id_header="x-request-id",
        failure_prefix="OpenAI reflection LM failed",
        read_usage=_openai_usage,
        extract_text=_extract_openai_output_text,
        missing_text_code="ALI_1505_OPENAI_OUTPUT_TEXT_MISSING",
        missing_text_message="OpenAI reflection LM returned no output text",
        curl_fallback=False,
    ),
    "openai-chat": _ProtocolTransport(
        build_payload=_build_openai_chat_completion_payload,
        content_headers={"Content-Type": "application/json"},
        # Measured, not assumed: see the measured-contract section of
        # docs/requirements/any-provider-support/t2-python-transport-plan.md.
        request_id_header="x-request-id",
        failure_prefix="Chat completions reflection LM failed",
        read_usage=_openai_chat_usage,
        extract_text=_extract_chat_output_text,
        missing_text_code="ALI_1505_PROVIDER_OUTPUT_TEXT_MISSING",
        missing_text_message="Chat completions reflection LM returned no output text",
        curl_fallback=False,
    ),
}


def _provider_credential(entry: ProviderEntry) -> str:
    """The provider's key, from the env var its registry entry names.

    The code is derived from the provider id, which reproduces both existing
    codes and extends to any provider. The message is one template for every
    provider (T2 plan section 10, ruling 2).
    """
    api_key = os.environ.get(entry.credential_env)
    if not api_key:
        raise ReflectionProviderError(
            f"ALI_1505_{entry.id.upper()}_API_KEY_MISSING",
            f'{entry.credential_env} is required for provider "{entry.id}"',
        )
    return api_key


def _model_for_forced_provider(model: str, provider: str) -> str:
    """Keep direct ``reflect_with_<provider>`` calls on their historical provider."""
    return model if model.startswith(f"{provider}/") else f"{provider}/{model}"


def complete_reflection_messages(
    *,
    model: str,
    messages: list[dict[str, Any]],
    config: TextGepaConfig,
    endpoint_override: str | None = None,
    ssl_cert_file: str | None = None,
    api_key_override: str | None = None,
) -> ProviderCompletion:
    """Complete explicit provider messages through the frozen sync transport.

    This is deliberately transport-only: callers own their prompt construction
    and candidate extraction. It preserves the existing retry, timeout, key,
    and Anthropic curl-fallback policy while returning provider usage facts.

    Everything provider-specific comes from the registry entry the model
    identity names (ORI-2032): the URL, the auth header bytes, the credential
    env var and, through the entry's wire protocol, the body shape and the
    usage mapping. An unresolvable identity fails by name; it is never sent to
    a default provider.
    """
    entry = provider_for_identity(model)
    transport = _PROTOCOL_TRANSPORTS[entry.protocol]
    provider_model = parse_model_identity(model)[1]
    if endpoint_override is not None and api_key_override is None:
        raise ReflectionProviderError(
            "ALI_1505_ENDPOINT_OVERRIDE_API_KEY_REQUIRED",
            "endpoint_override requires an explicit api_key_override",
        )
    endpoint = endpoint_override or provider_endpoint(entry)
    # The loopback harness uses HTTP and deliberately synthetic certificate
    # paths. Production HTTPS traffic receives the explicitly resolved CA.
    try:
        ssl_context = (
            ssl.create_default_context(cafile=ssl_cert_file)
            if ssl_cert_file and endpoint.startswith("https://")
            else None
        )
    except (FileNotFoundError, ssl.SSLError) as error:
        raise ReflectionProviderError(
            "ALI_1505_SSL_CONTEXT_FAILED",
            f"Reflection LM could not create an SSL context: {error}",
        ) from error

    api_key = api_key_override or _provider_credential(entry)
    payload = transport.build_payload(provider_model, messages, config)
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={**provider_auth_headers(entry, api_key), **transport.content_headers},
    )
    use_curl_fallback = transport.curl_fallback and endpoint_override is None
    response = _read_json_response_with_retries(
        request,
        timeout_seconds=config.reflection_http_timeout_seconds,
        retry_attempts=config.reflection_retry_attempts,
        failure_prefix=transport.failure_prefix,
        ssl_fallback=(
            lambda: _read_anthropic_response_with_curl(api_key, payload, endpoint)
        ) if use_curl_fallback else None,
        ssl_context=ssl_context,
    )
    usage = transport.read_usage(response.data)
    text = transport.extract_text(response.data)
    if not text and transport.missing_text_code is not None:
        raise ReflectionProviderError(
            transport.missing_text_code,
            transport.missing_text_message,
            usage=usage,
        )
    return ProviderCompletion(
        text=text,
        usage=usage,
        request_id=_header_value(response.headers, transport.request_id_header),
        latency_ms=response.latency_ms,
        provider=entry.id,
    )


def _reflect_through_transport(
    parent_text: str,
    parent_results: list[RowEvaluation],
    config: TextGepaConfig,
    model: str,
) -> ReflectionResult:
    prompt = build_reflection_prompt(parent_text, parent_results, config)
    completion = complete_reflection_messages(
        model=model,
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


def reflect_with_anthropic(parent_text: str, parent_results: list[RowEvaluation], config: TextGepaConfig) -> ReflectionResult:
    """Forces the Anthropic provider. Test-only caller; production uses
    ``reflect_with_provider``, which resolves the provider from the identity."""
    return _reflect_through_transport(
        parent_text, parent_results, config,
        _model_for_forced_provider(config.reflection_model, "anthropic"),
    )


def reflect_with_openai(parent_text: str, parent_results: list[RowEvaluation], config: TextGepaConfig) -> ReflectionResult:
    """Forces the OpenAI provider. Test-only caller; see above."""
    return _reflect_through_transport(
        parent_text, parent_results, config,
        _model_for_forced_provider(config.reflection_model, "openai"),
    )


def reflect_with_provider(parent_text: str, parent_results: list[RowEvaluation], config: TextGepaConfig) -> ReflectionResult:
    """The production path: one route for every provider.

    The prefix fork this replaced sent every non-``openai/`` model to
    Anthropic, which is why an unregistered provider used to fail as an
    Anthropic authentication error rather than by name.
    """
    return _reflect_through_transport(parent_text, parent_results, config, config.reflection_model)
