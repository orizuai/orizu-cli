"""GEPA reflection callable delegated to Orizu's existing provider layer."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from orizu_gepa.optimizer import build_reflection_prompt
from orizu_gepa.reflection import reflect_with_provider


def provider_reflection_lm(parent_text: str, parent_results: list[Any], config: Any) -> str:
    """Run the frozen provider layer and return its raw response.

    ``reflect_with_provider`` owns retries, HTTP timeouts, token accounting and
    candidate extraction.  The connector intentionally does not recreate any
    of that transport policy.
    """
    result = reflect_with_provider(parent_text, parent_results, config)
    return result.response


class GepaReflectionLM:
    """Reflection bridge that preserves provider failures before GEPA isolates them.

    GEPA intentionally catches reflection failures per proposal.  That keeps an
    optimization alive, but means the connector is the final durable boundary
    for the actual exception.  This wrapper records it *before* re-raising to
    GEPA's safe helper and exposes provider-measured token usage in GEPA's
    ``TrackingLM``-shaped fields.
    """

    def __init__(
        self,
        *,
        context_supplier: Callable[[], tuple[str, list[Any]]],
        config: Any,
        failure_reporter: Callable[..., None] | None,
        success_reporter: Callable[[str], None] | None,
    ) -> None:
        self._context_supplier = context_supplier
        self._config = config
        self._failure_reporter = failure_reporter
        self._success_reporter = success_reporter
        self._total_tokens_in = 0
        self._total_tokens_out = 0
        self._total_tokens = 0

    @property
    def total_cost(self) -> float:
        return 0.0

    @property
    def total_tokens_in(self) -> int:
        return self._total_tokens_in

    @property
    def total_tokens_out(self) -> int:
        return self._total_tokens_out

    @property
    def total_tokens(self) -> int:
        return self._total_tokens

    def _account_usage(self, usage: Any) -> None:
        if not isinstance(usage, dict):
            raise RuntimeError("ALI_1505_PROVIDER_USAGE_MISSING: reflection transport returned no provider usage")
        try:
            input_tokens = int(usage["input_tokens"])
            output_tokens = int(usage["output_tokens"])
            total_tokens = int(usage["total_tokens"])
        except (KeyError, TypeError, ValueError) as error:
            raise RuntimeError("ALI_1505_PROVIDER_USAGE_INVALID: reflection transport returned invalid provider usage") from error
        if min(input_tokens, output_tokens, total_tokens) < 0:
            raise RuntimeError("ALI_1505_PROVIDER_USAGE_INVALID: reflection transport returned negative provider usage")
        self._total_tokens_in += input_tokens
        self._total_tokens_out += output_tokens
        self._total_tokens += total_tokens

    def __call__(self, gepa_prompt: str) -> str:
        parent_text, parent_results = self._context_supplier()
        try:
            # Prompt validation is part of the provider attempt. Keep it
            # inside this boundary so GEPA cannot silently swallow its error.
            provider_prompt = build_reflection_prompt(parent_text, parent_results, self._config)
            result = reflect_with_provider(parent_text, parent_results, self._config)
            response = result.response
            provider_prompt = getattr(result, "prompt", provider_prompt)
            self._account_usage(getattr(result, "usage", None))
        except Exception as error:
            billable_usage = getattr(error, "usage", None)
            if billable_usage is not None:
                self._account_usage(billable_usage)
            if self._failure_reporter is not None:
                self._failure_reporter(
                    error=error,
                    gepa_prompt=gepa_prompt,
                    parent_text=parent_text,
                    parent_results=parent_results,
                )
            raise
        if self._success_reporter is not None:
            self._success_reporter(str(provider_prompt))
        return response


def make_gepa_reflection_lm(
    *,
    context_supplier: Callable[[], tuple[str, list[Any]]],
    config: Any,
    failure_reporter: Callable[..., None] | None = None,
    success_reporter: Callable[[str], None] | None = None,
) -> GepaReflectionLM:
    """Adapt GEPA's ``Callable[[rendered_prompt], str]`` contract.

    GEPA owns its rendered prompt. The frozen provider layer owns the
    production prompt and retry policy. ``context_supplier`` is read at each
    invocation, after GEPA's selected-parent minibatch evaluation, so a later
    proposal cannot accidentally reflect on the seed's rows.
    """
    return GepaReflectionLM(
        context_supplier=context_supplier,
        config=config,
        failure_reporter=failure_reporter,
        success_reporter=success_reporter,
    )
