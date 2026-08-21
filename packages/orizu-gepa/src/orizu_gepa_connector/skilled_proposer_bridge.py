"""Typed DSPy bridge for the opt-in skilled-proposer integration.

This module deliberately owns proposal-LM observability.  It does not use
``dspy.LM`` or LiteLLM: every completion reaches the frozen provider transport
through ``complete_reflection_messages`` and is recorded before DSPy sees its
response.
"""

from __future__ import annotations

import atexit
import dataclasses
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
_SUPPORTED_ROLES = {"system", "user", "assistant"}
_ALLOWED_DSPY_REQUEST_FIELDS = frozenset({"temperature", "max_tokens", "cache"})
_DspyBaseLM = dspy.BaseLM if dspy is not None else object


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
        self.budget.record(usage)
        self._write_durable_failure(code=code, detail=detail, correlation_id=event.get("correlation_id"))
        self._append_event(event)

    def record_event_failure(self, error: Exception, *, correlation_id: str) -> None:
        self._write_durable_failure(
            code="proposal_observability_event_failed", detail=str(error), correlation_id=correlation_id,
        )

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
                raise RuntimeError("proposal_observability_event_failed") from event_error
            raise dspy_module.LMError(
                f"proposal_provider_transport_failed: {error}",
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
            raise RuntimeError("proposal_observability_event_failed") from error
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
    from skilled_proposer import SkilledProposer

    bridge = make_skilled_proposer_bridge(
        config=config,
        observability=observability,
        budget=budget or ProposalCallBudget(),
        endpoint_override=endpoint_override,
        ssl_cert_file=os.environ.get("SSL_CERT_FILE"),
    )
    return SkilledProposer(prompt_model=bridge)
