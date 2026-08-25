"""Typed DSPy bridge for the opt-in skilled-proposer integration.

This module deliberately owns proposal-LM observability.  It does not use
``dspy.LM`` or LiteLLM: every completion reaches the frozen provider transport
through ``complete_reflection_messages`` and is recorded before DSPy sees its
response.
"""

from __future__ import annotations

import atexit
import dataclasses
import hashlib
import json
import os
import shutil
import tempfile
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import urlparse

try:
    import dspy
except ModuleNotFoundError as error:
    if error.name != "dspy":
        raise
    dspy = None

if TYPE_CHECKING:
    import dspy as dspy_types

from orizu_gepa.reflection import ProviderCompletion, complete_reflection_messages
from orizu_gepa.optimizer import TextGepaConfig

_SELECTION_ENV = "ORIZU_CANDIDATE_PROPOSER"
_SELECTION_VALUE = "skilled-proposer"
_CONFIG_ENV = "ORIZU_SKILLED_PROPOSER_CONFIG"
_SUPPORTED_ROLES = {"system", "user", "assistant"}
_ALLOWED_DSPY_REQUEST_FIELDS = frozenset({"temperature", "max_tokens", "cache"})
_DspyBaseLM = dspy.BaseLM if dspy is not None else object


class _ProposalObservabilityEventFailure(RuntimeError):
    pass


def _require_dspy() -> Any:
    if dspy is None:
        raise RuntimeError("ALI_1505_DSPY_UNAVAILABLE")
    return dspy


def _usage_totals() -> dict[str, int]:
    return {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}


def _require_usage(usage: dict[str, int]) -> dict[str, int]:
    try:
        normalized = {name: int(usage[name]) for name in _usage_totals()}
    except (KeyError, TypeError, ValueError) as error:
        raise RuntimeError("ALI_1505_PROPOSAL_USAGE_INVALID") from error
    if any(value < 0 for value in normalized.values()):
        raise RuntimeError("ALI_1505_PROPOSAL_USAGE_INVALID")
    return normalized


@dataclass
class ProposalCallBudget:
    """The connector-owned proposal ledger; GEPA metric accounting is separate."""

    max_calls: int | None = None
    max_tokens: int | None = None
    call_count: int = 0
    usage: dict[str, int] = field(default_factory=_usage_totals)

    def record(self, usage: dict[str, int] | None = None) -> None:
        self.call_count += 1
        if usage is None:
            return
        normalized = _require_usage(usage)
        for name, value in normalized.items():
            self.usage[name] += value

    def has_safe_boundary_stop(self) -> bool:
        return ((self.max_calls is not None and self.call_count >= self.max_calls) or
                (self.max_tokens is not None and self.usage["total_tokens"] >= self.max_tokens))


class ProposalObservability:
    """Durable per-provider-call proposal evidence and aggregate raw usage."""

    def __init__(self, *, event_log_root: Path, durable_failure_root: Path, budget: ProposalCallBudget | None = None):
        self.event_log_root = event_log_root
        self.durable_failure_root = durable_failure_root
        self.events: list[dict[str, Any]] = []
        self.budget = budget or ProposalCallBudget()
        self._event_failure_count = 0
        self._provider_failure_count = 0
        self._temporary_root: Path | None = None

    @classmethod
    def local_for_test(
        cls,
        *,
        event_log_root: Path | None = None,
        durable_failure_root: Path | None = None,
    ) -> "ProposalObservability":
        root = Path(tempfile.mkdtemp(prefix="orizu-ali1505-proposal-events-"))
        result = cls(
            event_log_root=event_log_root or root / "events",
            durable_failure_root=durable_failure_root or root / "durable-failures",
        )
        result._temporary_root = root
        atexit.register(shutil.rmtree, root, ignore_errors=True)
        return result

    def bind_budget(self, budget: ProposalCallBudget) -> None:
        self.budget = budget

    def close(self) -> None:
        if self._temporary_root is not None:
            shutil.rmtree(self._temporary_root, ignore_errors=True)
            self._temporary_root = None

    def __del__(self) -> None:
        self.close()

    def _append_event(self, event: dict[str, Any]) -> None:
        self.event_log_root.mkdir(parents=True, exist_ok=True)
        with (self.event_log_root / "events.jsonl").open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, sort_keys=True) + "\n")
        self.events.append(event)

    def _write_durable_failure(self, *, code: str, detail: str, correlation_id: str | None = None) -> None:
        try:
            self.durable_failure_root.mkdir(parents=True, exist_ok=True)
            payload: dict[str, Any] = {"source": "skilled_proposer", "code": code, "detail": detail}
            if correlation_id is not None:
                payload["correlation_id"] = correlation_id
            (self.durable_failure_root / "latest.json").write_text(
                json.dumps(payload, sort_keys=True) + "\n", encoding="utf-8",
            )
        except Exception:
            # The original delivery failure remains the actionable error.  A
            # second durable-store failure cannot be made durable by retrying it.
            return

    def record_success(self, event: dict[str, Any], usage: dict[str, int]) -> None:
        self.budget.record(usage)
        self._append_event(event)

    def record_provider_failure(
        self,
        event: dict[str, Any],
        *,
        code: str,
        detail: str,
        usage: dict[str, int] | None = None,
    ) -> None:
        self._provider_failure_count += 1
        self.budget.record(usage)
        self._write_durable_failure(code=code, detail=detail, correlation_id=event.get("correlation_id"))
        self._append_event(event)

    def record_event_failure(self, error: Exception, *, correlation_id: str) -> None:
        self._event_failure_count += 1
        self._write_durable_failure(
            code="proposal_observability_event_failed", detail=str(error), correlation_id=correlation_id,
        )

    def record_proposer_failure(self, error: Exception) -> None:
        self._write_durable_failure(code="proposal_generation_failed", detail=str(error))

    def record_component_fallback(self, *, component: str, error: Exception) -> None:
        event = {
            "type": "proposal_component_fallback",
            "component": component,
            "policy": "keep",
            "errorType": type(error).__name__,
            "errorMessage": str(error),
        }
        try:
            self._append_event(event)
        except OSError as event_error:
            self._write_durable_failure(
                code="proposal_observability_event_failed", detail=str(event_error),
            )
            raise _ProposalObservabilityEventFailure(
                "proposal_observability_event_failed",
            ) from event_error

    def write_proposer_identity(self, identity: dict[str, Any]) -> str:
        root = self.event_log_root.parent
        path = root / "proposer.json"
        try:
            root.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(identity, sort_keys=True) + "\n", encoding="utf-8")
        except OSError as error:
            code = "skilled_proposer_identity_write_failed"
            self._write_durable_failure(code=code, detail=str(error))
            raise RuntimeError(code) from error
        return str(path)

    def terminal_stats(self) -> dict[str, Any]:
        return {"call_count": self.budget.call_count, "usage": dict(self.budget.usage)}

    def terminal_lm_stats(self) -> dict[str, int]:
        return {
            "total_tokens_in": self.budget.usage["input_tokens"],
            "total_tokens_out": self.budget.usage["output_tokens"],
            "total_tokens": self.budget.usage["total_tokens"],
        }

    def write_terminal_lm_stats_artifact(self) -> str:
        self.event_log_root.mkdir(parents=True, exist_ok=True)
        path = self.event_log_root / "lm_stats.json"
        path.write_text(json.dumps(self.terminal_lm_stats(), sort_keys=True) + "\n", encoding="utf-8")
        return str(path)

    def read_durable_failure(self) -> dict[str, Any]:
        return json.loads((self.durable_failure_root / "latest.json").read_text(encoding="utf-8"))

    def has_safe_boundary_stop(self) -> bool:
        return self.budget.has_safe_boundary_stop()

    @property
    def provider_failure_count(self) -> int:
        return self._provider_failure_count

    @property
    def event_failure_count(self) -> int:
        return self._event_failure_count


def _reject(message: str, *, code: str = "proposal_dspy_request_rejected") -> Any:
    return _require_dspy().LMError(message, code=code)


def _provider_messages(request: "dspy_types.LMRequest") -> list[dict[str, str]]:
    if request.tools:
        raise _reject("proposal_dspy_request_rejected: tools are not supported")
    messages: list[dict[str, str]] = []
    for message in request.messages:
        dumped = message.model_dump()
        role = dumped.get("role")
        if role not in _SUPPORTED_ROLES:
            raise _reject(f"proposal_dspy_request_rejected: unsupported message role {role!r}")
        text_parts: list[str] = []
        for part in dumped.get("parts", []):
            if part.get("type") != "text" or not isinstance(part.get("text"), str):
                raise _reject("proposal_dspy_request_rejected: only text message parts are supported")
            text_parts.append(part["text"])
        if not text_parts:
            raise _reject("proposal_dspy_request_rejected: text messages must contain at least one text part")
        messages.append({"role": role, "content": "".join(text_parts)})
    return messages


def _request_config(request: "dspy_types.LMRequest", base: TextGepaConfig) -> TextGepaConfig:
    config = request.config
    unsupported = {
        name: value
        for name, value in config.model_dump().items()
        if name not in _ALLOWED_DSPY_REQUEST_FIELDS and value not in (None, {})
    }
    if unsupported:
        raise _reject("proposal_dspy_request_rejected: unsupported DSPy generation configuration")
    cache = config.cache
    if cache is not None and (getattr(cache, "enabled", False) or getattr(cache, "rollout_id", None) is not None):
        raise _reject("proposal_dspy_cache_rejected: proposal response caching is disabled", code="proposal_dspy_cache_rejected")
    changes: dict[str, Any] = {}
    if config.temperature is not None:
        changes["reflection_temperature"] = config.temperature
    if config.max_tokens is not None:
        if config.max_tokens <= 0:
            raise _reject("proposal_dspy_request_rejected: max_tokens must be positive")
        changes["reflection_max_tokens"] = config.max_tokens
    return dataclasses.replace(base, **changes) if changes else base


def _loopback_endpoint(endpoint: str) -> str:
    parsed = urlparse(endpoint)
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in {"127.0.0.1", "::1", "localhost"}:
        raise ValueError("ALI_1505_BRIDGE_ENDPOINT_OVERRIDE_NOT_LOOPBACK")
    if parsed.username or parsed.password:
        raise ValueError("ALI_1505_BRIDGE_ENDPOINT_OVERRIDE_INVALID")
    return endpoint


class OrizuSkilledProposerLM(_DspyBaseLM):
    """A typed DSPy LM whose only completion path is Orizu's provider transport."""

    forward_contract = "typed_lm"

    def __init__(
        self,
        *,
        config: TextGepaConfig,
        observability: ProposalObservability,
        endpoint_override: str | None = None,
        ssl_cert_file: str | None = None,
    ) -> None:
        # Provider retries belong exclusively to the frozen transport.  DSPy
        # must not retry after a durable-event failure and create unrecorded
        # duplicate proposal attempts.
        _require_dspy().BaseLM.__init__(
            self,
            config.reflection_model,
            temperature=config.reflection_temperature,
            max_tokens=config.reflection_max_tokens,
            cache=False,
            num_retries=0,
        )
        self._config = config
        self._observability = observability
        self._endpoint_override = _loopback_endpoint(endpoint_override) if endpoint_override else None
        self._ssl_cert_file = ssl_cert_file

    def forward(self, request: "dspy_types.LMRequest") -> "dspy_types.LMResponse":
        dspy_module = _require_dspy()
        correlation_id = uuid.uuid4().hex
        if request.model != self.model:
            raise _reject(
                "proposal_dspy_model_rejected: requested model differs from the configured reflection model",
                code="proposal_dspy_model_rejected",
            )
        messages = _provider_messages(request)
        config = _request_config(request, self._config)
        try:
            completion: ProviderCompletion = complete_reflection_messages(
                model=self.model,
                messages=messages,
                config=config,
                endpoint_override=self._endpoint_override,
                ssl_cert_file=self._ssl_cert_file,
                # The explicit loopback harness must never receive a real
                # provider credential from this process.
                api_key_override="loopback-test-key" if self._endpoint_override else None,
            )
        except Exception as error:
            provider_code = getattr(error, "code", None)
            failure_usage = getattr(error, "usage", None)
            failure_event = {
                "source": "skilled_proposer",
                "status": "failure",
                "attempt": 1,
                "correlation_id": correlation_id,
                "provider": "openai" if self.model.startswith("openai/") else "anthropic",
                "cache_state": "disabled",
                "failure_code": provider_code or "ALI_1505_PROPOSAL_TRANSPORT_FAILURE",
            }
            if failure_usage is not None:
                failure_event["usage"] = failure_usage
            try:
                self._observability.record_provider_failure(
                    failure_event,
                    code="proposal_provider_transport_failed",
                    detail=str(error),
                    usage=failure_usage,
                )
            except Exception as event_error:
                self._observability.record_event_failure(event_error, correlation_id=correlation_id)
                raise _ProposalObservabilityEventFailure(
                    "proposal_observability_event_failed",
                ) from event_error
            raise dspy_module.LMError(
                "proposal_provider_transport_failed",
                code="proposal_provider_transport_failed",
                model=self.model,
                provider="orizu",
                provider_code=provider_code,
            ) from error

        usage = _require_usage(completion.usage)
        success_event = {
            "source": "skilled_proposer",
            "status": "success",
            "attempt": 1,
            "correlation_id": correlation_id,
            "provider": completion.provider,
            "model": self.model,
            "request_id": completion.request_id,
            "latency_ms": completion.latency_ms,
            "usage": usage,
            "cache_state": "disabled",
        }
        try:
            self._observability.record_success(success_event, usage)
        except Exception as error:
            self._observability.record_event_failure(error, correlation_id=correlation_id)
            raise _ProposalObservabilityEventFailure(
                "proposal_observability_event_failed",
            ) from error
        return dspy_module.LMResponse.from_text(completion.text, model=self.model, usage=usage, cache_hit=False)


def make_skilled_proposer_bridge(
    *,
    config: TextGepaConfig,
    observability: ProposalObservability,
    budget: ProposalCallBudget,
    endpoint_override: str | None = None,
    ssl_cert_file: str | None = None,
) -> OrizuSkilledProposerLM:
    """Create the cache-disabled typed LM passed to unmodified SkilledProposer."""
    observability.bind_budget(budget)
    return OrizuSkilledProposerLM(
        config=config,
        observability=observability,
        endpoint_override=endpoint_override,
        ssl_cert_file=ssl_cert_file,
    )


@dataclass(frozen=True)
class _NormalizedText:
    source: str
    content: str
    sha256: str
    byte_length: int


@dataclass(frozen=True)
class _NormalizedSkill(_NormalizedText):
    name: str
    description: str | None


@dataclass(frozen=True)
class _SkilledProposerConfig:
    config_file_sha256: str
    implementation: str
    package_version: str
    config_sha256: str
    skills: tuple[_NormalizedSkill, ...]
    additional_instructions: _NormalizedText | None
    base_instructions: _NormalizedText | None
    max_words: int | None
    max_tokens: int | None
    max_examples: int | None
    on_error: str

    def identity(self) -> dict[str, Any]:
        return {
            "implementation": self.implementation,
            "packageVersion": self.package_version,
            "configSha256": self.config_sha256,
            "skills": [{
                "name": skill.name,
                "source": skill.source,
                "sha256": skill.sha256,
                "byteLength": skill.byte_length,
            } for skill in self.skills],
            "additionalInstructionsSha256": (
                self.additional_instructions.sha256 if self.additional_instructions else None
            ),
            "baseInstructionsSha256": self.base_instructions.sha256 if self.base_instructions else None,
            "maxWords": self.max_words,
            "maxTokens": self.max_tokens,
            "maxExamples": self.max_examples,
            "onError": self.on_error,
        }


def _config_error(code: str, field_name: str) -> Any:
    raise RuntimeError(f"{code}: {field_name}")


def _strict_object(value: Any, fields: set[str], field_name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        return _config_error("skilled_proposer_config_invalid_field", field_name)
    unknown = sorted(set(value) - fields)
    if unknown:
        return _config_error(
            "skilled_proposer_config_unknown_field",
            f"{field_name + '.' if field_name else ''}{unknown[0]}",
        )
    missing = sorted(fields - set(value))
    if missing:
        return _config_error(
            "skilled_proposer_config_missing_field",
            f"{field_name + '.' if field_name else ''}{missing[0]}",
        )
    return value


def _required_string(value: Any, field_name: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or (not allow_empty and not value.strip()):
        return _config_error("skilled_proposer_config_invalid_field", field_name)
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return _config_error("skilled_proposer_config_invalid_unicode", field_name)
    return value


def _positive_int_or_none(value: Any, field_name: str) -> int | None:
    if value is None:
        return None
    if type(value) is not int or value <= 0:
        return _config_error("skilled_proposer_config_invalid_field", field_name)
    return value


def _normalized_text(value: Any, field_name: str) -> _NormalizedText:
    raw = _strict_object(value, {"source", "content", "sha256", "byteLength"}, field_name)
    source = _required_string(raw["source"], f"{field_name}.source")
    content = _required_string(raw["content"], f"{field_name}.content")
    digest = _required_string(raw["sha256"], f"{field_name}.sha256")
    byte_length = raw["byteLength"]
    if (len(digest) != 64 or any(character not in "0123456789abcdef" for character in digest)
            or type(byte_length) is not int or byte_length != len(content.encode("utf-8"))):
        return _config_error("skilled_proposer_config_invalid_field", field_name)
    if hashlib.sha256(content.encode()).hexdigest() != digest:
        return _config_error("skilled_proposer_config_invalid_field", f"{field_name}.sha256")
    return _NormalizedText(source, content, digest, byte_length)


def _optional_normalized_text(value: Any, field_name: str) -> _NormalizedText | None:
    return None if value is None else _normalized_text(value, field_name)


def _normalized_text_payload(value: _NormalizedText | None) -> dict[str, Any] | None:
    if value is None:
        return None
    return {
        "source": value.source, "content": value.content,
        "sha256": value.sha256, "byteLength": value.byte_length,
    }


def _parse_skilled_proposer_config(raw_payload: str) -> _SkilledProposerConfig:
    try:
        parsed = json.loads(raw_payload)
    except (json.JSONDecodeError, TypeError) as error:
        raise RuntimeError("skilled_proposer_config_invalid_json") from error
    fields = {
        "configFileSha256", "schemaVersion", "implementation", "packageVersion", "configSha256", "skills",
        "additionalInstructions", "baseInstructions", "maxWords", "maxTokens", "maxExamples", "onError",
    }
    raw = _strict_object(parsed, fields, "")
    if (type(raw["schemaVersion"]) is not int or raw["schemaVersion"] != 1
            or raw["implementation"] != "cmpnd-ai/skilled-proposer"):
        return _config_error("skilled_proposer_config_invalid_field", "schemaVersion or implementation")
    package_version = _required_string(raw["packageVersion"], "packageVersion")
    config_file_sha256 = _required_string(raw["configFileSha256"], "configFileSha256")
    config_sha256 = _required_string(raw["configSha256"], "configSha256")
    for field_name, digest in (("configFileSha256", config_file_sha256), ("configSha256", config_sha256)):
        if len(digest) != 64 or any(character not in "0123456789abcdef" for character in digest):
            return _config_error("skilled_proposer_config_invalid_field", field_name)
    if not isinstance(raw["skills"], list):
        return _config_error("skilled_proposer_config_invalid_field", "skills")
    skills: list[_NormalizedSkill] = []
    for index, value in enumerate(raw["skills"]):
        field_name = f"skills[{index}]"
        skill_raw = _strict_object(
            value, {"name", "description", "source", "content", "sha256", "byteLength"}, field_name,
        )
        text = _normalized_text({key: skill_raw[key] for key in (
            "source", "content", "sha256", "byteLength",
        )}, field_name)
        name = _required_string(skill_raw["name"], f"{field_name}.name")
        description = skill_raw["description"]
        if description is not None:
            description = _required_string(description, f"{field_name}.description", allow_empty=True)
        skills.append(_NormalizedSkill(
            source=text.source, content=text.content, sha256=text.sha256, byte_length=text.byte_length,
            name=name, description=description,
        ))
    if len({skill.name for skill in skills}) != len(skills):
        return _config_error("skilled_proposer_config_invalid_field", "skills duplicate names")
    on_error = raw["onError"]
    if on_error not in ("keep", "raise"):
        return _config_error("skilled_proposer_config_invalid_field", "onError")
    result = _SkilledProposerConfig(
        config_file_sha256=config_file_sha256,
        implementation=raw["implementation"], package_version=package_version,
        config_sha256=config_sha256, skills=tuple(skills),
        additional_instructions=_optional_normalized_text(raw["additionalInstructions"], "additionalInstructions"),
        base_instructions=_optional_normalized_text(raw["baseInstructions"], "baseInstructions"),
        max_words=_positive_int_or_none(raw["maxWords"], "maxWords"),
        max_tokens=_positive_int_or_none(raw["maxTokens"], "maxTokens"),
        max_examples=_positive_int_or_none(raw["maxExamples"], "maxExamples"),
        on_error=on_error,
    )
    effective = {
        "configFileSha256": result.config_file_sha256,
        "schemaVersion": 1,
        "implementation": result.implementation,
        "packageVersion": result.package_version,
        "skills": [{
            "name": skill.name, "description": skill.description, "source": skill.source,
            "content": skill.content, "sha256": skill.sha256, "byteLength": skill.byte_length,
        } for skill in result.skills],
        "additionalInstructions": _normalized_text_payload(result.additional_instructions),
        "baseInstructions": _normalized_text_payload(result.base_instructions),
        "maxWords": result.max_words, "maxTokens": result.max_tokens,
        "maxExamples": result.max_examples, "onError": result.on_error,
    }
    canonical = json.dumps(effective, ensure_ascii=False, separators=(",", ":"))
    if hashlib.sha256(canonical.encode("utf-8")).hexdigest() != result.config_sha256:
        return _config_error("skilled_proposer_config_hash_mismatch", "configSha256")
    return result


class _CompressionFailureObserver:
    def __init__(self) -> None:
        self.failure_count = 0
        self.last_error: Exception | None = None

    def on_module_start(self, **_unused: Any) -> None:
        return

    def on_module_end(self, *, exception: Exception | None = None, **_unused: Any) -> None:
        if exception is not None:
            self.failure_count += 1
            self.last_error = exception


class _ObservableConfiguredProposer:
    def __init__(self, proposer: Any, observability: ProposalObservability, on_error: str) -> None:
        self.proposer = proposer
        self.observability = observability
        self.on_error = on_error
        self.compression_observer = _CompressionFailureObserver()
        proposer.module.compress.callbacks.append(self.compression_observer)

    def __getattr__(self, name: str) -> Any:
        return getattr(self.proposer, name)

    def __call__(self, candidate: dict[str, str], reflective_dataset: Any,
                 components_to_update: list[str]) -> dict[str, str]:
        results: dict[str, str] = {}
        for component in components_to_update:
            compression_failures_before = self.compression_observer.failure_count
            event_failures_before = self.observability.event_failure_count
            failures_before = self.observability.provider_failure_count
            try:
                proposed = self.proposer(candidate, reflective_dataset, [component])
            except Exception as error:
                if self.observability.event_failure_count > event_failures_before:
                    raise RuntimeError("proposal_observability_event_failed") from error
                if isinstance(error, _ProposalObservabilityEventFailure):
                    raise RuntimeError("proposal_observability_event_failed") from error
                if isinstance(error, _require_dspy().LMError) and self.on_error == "keep":
                    raise
                if self.on_error == "raise":
                    code = getattr(error, "code", None)
                    if code != "proposal_provider_transport_failed":
                        code = "proposal_generation_failed"
                        self.observability.record_proposer_failure(error)
                    raise RuntimeError(code or "proposal_observability_event_failed") from error
                self.observability.record_component_fallback(component=component, error=error)
                results[component] = candidate[component]
                continue
            if self.observability.event_failure_count > event_failures_before:
                raise RuntimeError("proposal_observability_event_failed")
            provider_failed = self.observability.provider_failure_count > failures_before
            compression_failed = self.compression_observer.failure_count > compression_failures_before
            if compression_failed or provider_failed:
                compression_error = self.compression_observer.last_error if compression_failed else None
                if isinstance(compression_error, _ProposalObservabilityEventFailure):
                    raise RuntimeError("proposal_observability_event_failed") from compression_error
                error = (_require_dspy().LMError(
                    "proposal_compression_provider_failed: compression provider failure was suppressed upstream",
                    code="proposal_compression_provider_failed",
                ) if provider_failed else RuntimeError("proposal_compression_failed"))
                if self.on_error == "raise":
                    raise error from compression_error
                self.observability.record_component_fallback(component=component, error=error)
                results[component] = candidate[component]
            else:
                results.update(proposed)
        return results


def make_skilled_proposer_from_environment(
    *,
    config: TextGepaConfig,
    observability: ProposalObservability,
    budget: ProposalCallBudget | None = None,
    endpoint_override: str | None = None,
) -> Any | None:
    """Create the opt-in proposer only for the exact selected environment value."""
    if os.environ.get(_SELECTION_ENV) != _SELECTION_VALUE:
        return None
    from skilled_proposer import Skill, SkilledProposer

    bridge = make_skilled_proposer_bridge(
        config=config,
        observability=observability,
        budget=budget or ProposalCallBudget(),
        endpoint_override=endpoint_override,
        ssl_cert_file=os.environ.get("SSL_CERT_FILE"),
    )
    raw_proposer_config = os.environ.get(_CONFIG_ENV)
    if raw_proposer_config is None:
        return SkilledProposer(prompt_model=bridge)
    if raw_proposer_config.startswith("@"):
        payload_path = Path(raw_proposer_config[1:])
        try:
            raw_proposer_config = payload_path.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as error:
            raise RuntimeError("skilled_proposer_config_payload_unreadable") from error
        try:
            payload_path.unlink()
            if payload_path.parent.name.startswith("orizu-skilled-proposer-payload-"):
                payload_path.parent.rmdir()
        except OSError:
            pass
    proposer_config = _parse_skilled_proposer_config(raw_proposer_config)
    proposer = SkilledProposer(
        skills=[Skill(
            name=skill.name, description=skill.description, content=skill.content,
        ) for skill in proposer_config.skills],
        additional_instructions=(
            proposer_config.additional_instructions.content
            if proposer_config.additional_instructions else None
        ),
        base_instructions=(proposer_config.base_instructions.content if proposer_config.base_instructions else None),
        max_words=proposer_config.max_words,
        max_tokens=proposer_config.max_tokens,
        max_examples=proposer_config.max_examples,
        on_error="raise",
        prompt_model=bridge,
    )
    observability.write_proposer_identity(proposer_config.identity())
    return _ObservableConfiguredProposer(proposer, observability, proposer_config.on_error)
