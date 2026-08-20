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
    GEPA's safe helper and exposes the same estimated usage shape as GEPA's
    ``TrackingLM``.
    """

    _CHARS_PER_TOKEN = 4

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

    @property
    def total_cost(self) -> float:
        return 0.0

    @property
    def total_tokens_in(self) -> int:
        return self._total_tokens_in

    @property
    def total_tokens_out(self) -> int:
        return self._total_tokens_out

    def __call__(self, gepa_prompt: str) -> str:
        parent_text, parent_results = self._context_supplier()
        try:
            # Prompt validation is part of the provider attempt. Keep it
            # inside this boundary so GEPA cannot silently swallow its error.
            provider_prompt = build_reflection_prompt(parent_text, parent_results, self._config)
            self._total_tokens_in += max(1, len(provider_prompt) // self._CHARS_PER_TOKEN)
            result = reflect_with_provider(parent_text, parent_results, self._config)
        except Exception as error:
            if self._failure_reporter is not None:
                self._failure_reporter(
                    error=error,
                    gepa_prompt=gepa_prompt,
                    parent_text=parent_text,
                    parent_results=parent_results,
                )
            raise
        response = result.response
        provider_prompt = getattr(result, "prompt", provider_prompt)
        self._total_tokens_out += max(1, len(response) // self._CHARS_PER_TOKEN)
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
