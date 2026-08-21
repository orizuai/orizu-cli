"""Official GEPA execution wiring for the Orizu adapter and callback bridge."""

from __future__ import annotations

from collections.abc import Callable, Sequence
import dataclasses
import json
import random
from typing import Any

from gepa import optimize
from gepa.strategies.candidate_selector import EpsilonGreedyCandidateSelector
from orizu_gepa.optimizer import TextGepaConfig

from .callbacks import LifecycleHooks, OrizuCallback
from .preflight import validate_seed_and_scorer
from .stop_conditions import ProposalBudgetStopper


def _row_id(row: Any, index: int) -> str:
    value = getattr(row, "id", row.get("id") if isinstance(row, dict) else None)
    if value is None:
        raise ValueError(f"GEPA dataset row at index {index} is missing its id")
    return str(value)


class _RowIdentityLoader:
    """Expose Orizu dataset ids to GEPA instead of its positional list ids."""

    def __init__(self, rows: Sequence[Any]):
        self._rows_by_id = {_row_id(row, index): row for index, row in enumerate(rows)}
        if len(self._rows_by_id) != len(rows):
            raise ValueError("GEPA datasets require unique DatasetRow ids")

    def all_ids(self) -> list[str]:
        return list(self._rows_by_id)

    def fetch(self, row_ids: Sequence[str]) -> list[Any]:
        return [self._rows_by_id[str(row_id)] for row_id in row_ids]

    def __len__(self) -> int:
        return len(self._rows_by_id)


def _with_row_identities(rows: Sequence[Any]) -> Any:
    """Keep caller-supplied loaders, otherwise prevent cross-split cache aliasing."""
    if hasattr(rows, "all_ids") and hasattr(rows, "fetch"):
        return rows
    return _RowIdentityLoader(rows)


class SeedValidationRefused(RuntimeError):
    """Raised before a run is started when the scored seed has no gradient."""

    def __init__(self, verdict: dict[str, Any], *, preflight_record_path: str | None = None):
        self.verdict = verdict
        self.preflight_record_path = preflight_record_path
        message = (
            f"{verdict['reason']}: preflight row evidence="
            f"{json.dumps(verdict.get('row_evidence', []), ensure_ascii=False, default=str)}"
        )
        if preflight_record_path is not None:
            message += f"; preflight record={preflight_record_path}"
        super().__init__(message)


def _preflight_row_evidence(rows: list[Any], scores: list[float], outputs: list[Any]) -> list[dict[str, Any]]:
    """Keep the raw scorer evidence that explains a preflight refusal."""
    evidence: list[dict[str, Any]] = []
    for index, score in enumerate(scores):
        output = outputs[index] if index < len(outputs) and isinstance(outputs[index], dict) else {}
        row = rows[index] if index < len(rows) else None
        scorer_error = output.get("scorer_error")
        if scorer_error is None and output.get("error_source") == "scorer":
            scorer_error = output.get("error")
        item = {
            "row_id": output.get("row_id", getattr(row, "id", None)),
            "score": score,
            "scorer_output": output.get("scorer_output", output.get("scorer_response")),
            "scorer_error": scorer_error,
        }
        if output.get("error") is not None:
            item["execution_error"] = output["error"]
            item["execution_error_source"] = output.get("error_source")
        evidence.append(item)
    return evidence


def _validate_seed_before_run(*, seed_candidate: dict[str, str], valset: list[Any], adapter: Any,
                              hooks: LifecycleHooks, allow_degenerate_seed: bool) -> tuple[dict[str, Any], Any, list[Any]]:
    """Cheap scorer preflight; GEPA owns the single full seed validation."""
    # The approved cap bounds preflight spend. With a binary scorer and a seed
    # that is correct 70% of the time, all three sampled rows can still score
    # zero with probability 0.3**3 = 2.7%; do not silently change that policy.
    preflight_rows = valset[:min(3, len(valset))]
    seed_evaluation = adapter.evaluate(preflight_rows, seed_candidate, capture_traces=True)
    scores = list(seed_evaluation.scores)
    verdict = validate_seed_and_scorer(
        scores=scores,
        row_evidence=_preflight_row_evidence(preflight_rows, scores, list(seed_evaluation.outputs)),
        allow_degenerate_seed=allow_degenerate_seed,
        higher_is_better=getattr(getattr(adapter, "scorer_context", None), "higher_is_better", True),
    )
    verdict["preflight_metric_calls"] = getattr(adapter, "metric_calls_used", seed_evaluation.num_metric_calls)
    hooks.emit("seed_validated", verdict)
    if not verdict["allowed"]:
        raise SeedValidationRefused(verdict)
    return verdict, seed_evaluation, preflight_rows


def validate_seed_before_run(*, seed_candidate: dict[str, str], valset: list[Any], adapter: Any,
                             hooks: LifecycleHooks, allow_degenerate_seed: bool) -> dict[str, Any]:
    """Validate the seed and return the durable public preflight verdict."""
    verdict, _evaluation, _rows = _validate_seed_before_run(
        seed_candidate=seed_candidate,
        valset=valset,
        adapter=adapter,
        hooks=hooks,
        allow_degenerate_seed=allow_degenerate_seed,
    )
    return verdict


class _PreflightReusingAdapter:
    """Serve GEPA's immediate seed evaluation from the completed preflight."""

    def __init__(self, adapter: Any, seed_candidate: dict[str, str], rows: list[Any], evaluation: Any):
        self._adapter = adapter
        self._seed_candidate = seed_candidate
        self._rows = rows
        self._evaluation = evaluation
        self._served_seed = False

    def evaluate(self, batch: list[Any], candidate: dict[str, str], capture_traces: bool = False):
        if (not self._served_seed and not capture_traces and candidate == self._seed_candidate
                and list(batch) == self._rows):
            self._served_seed = True
            return self._evaluation
        return self._adapter.evaluate(batch, candidate, capture_traces=capture_traces)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._adapter, name)


def run_official_gepa(
    *,
    seed_candidate: dict[str, str],
    trainset: list[Any],
    valset: list[Any],
    adapter: Any,
    callback: Any,
    hooks: LifecycleHooks,
    max_metric_calls: int | None = None,
    stop_callbacks: Sequence[Callable[[Any], bool]] = (),
    allow_degenerate_seed: bool = False,
    reflection_lm: Callable[[str], str] | None = None,
    custom_candidate_proposer: Callable[..., dict[str, str]] | None = None,
    proposal_budget: Any | None = None,
    seed_already_validated: bool = False,
    config: TextGepaConfig | None = None,
) -> Any:
    """Run GEPA after the launch-time seed check and emit named lifecycle hooks.

    The seed pass is deliberately outside ``optimize``: a bad scorer/seed is
    refused before an optimization run exists or any configured GEPA budget is
    consumed.  The actual GEPA loop remains responsible for every later
    stopping boundary.
    """
    # Full-valset evaluations bypass GEPA's evaluation callbacks. Give the
    # callback the real adapter so it can turn GEPA's positional score keys
    # into the adapter's durable dataset row identities.
    if isinstance(callback, OrizuCallback):
        callback.evaluation_adapter = adapter
        callback.validation_row_ids = [_row_id(row, index) for index, row in enumerate(valset)]

    preflight_evaluation = None
    preflight_rows: list[Any] = []
    if not seed_already_validated:
        _verdict, preflight_evaluation, preflight_rows = _validate_seed_before_run(
            seed_candidate=seed_candidate,
            valset=valset,
            adapter=adapter,
            hooks=hooks,
            allow_degenerate_seed=allow_degenerate_seed,
        )

    # GEPA 0.1.4 reads this optional protocol attribute directly in its
    # reflective proposer, even when a custom proposer owns the call. Our
    # runner adapter supplies it; lightweight adapters used by the real GEPA
    # boundary do not. Normalize the vendor's optional slot without replacing
    # an adapter-owned proposer.
    if custom_candidate_proposer is not None and not hasattr(adapter, "propose_new_texts"):
        adapter.propose_new_texts = None

    gepa_adapter = adapter
    if custom_candidate_proposer is not None and preflight_evaluation is not None:
        # A one-row low metric ceiling otherwise pays for this same seed row a
        # second time inside GEPA before it reaches the custom proposal. The
        # cached result is already a real evaluator result from this call's
        # mandatory preflight; only the duplicate evaluator invocation is
        # removed, never the separate proposal ledger.
        gepa_adapter = _PreflightReusingAdapter(adapter, seed_candidate, preflight_rows, preflight_evaluation)

    config = config or TextGepaConfig()
    candidate_selection_strategy: Any = config.candidate_selection_strategy
    # Official GEPA's string shortcut fixes epsilon at 0.1.  Use its public
    # selector class so the legacy --epsilon contract remains observable.
    if candidate_selection_strategy == "epsilon_greedy":
        candidate_selection_strategy = EpsilonGreedyCandidateSelector(
            epsilon=max(0.0, min(1.0, config.epsilon)),
            rng=random.Random(config.seed),
        )

    owned_stop_callbacks = list(stop_callbacks)
    if proposal_budget is not None:
        owned_stop_callbacks.append(ProposalBudgetStopper(proposal_budget))

    reflection_minibatch_size = config.minibatch_size
    if custom_candidate_proposer is not None and max_metric_calls is not None:
        # GEPA's metric stopper is evaluated at iteration boundaries.  Do not
        # let its default three-row reflection batch overshoot a deliberately
        # smaller evaluator-only ceiling before that boundary is observed.
        reflection_minibatch_size = min(
            reflection_minibatch_size,
            max(1, max_metric_calls - len(valset)),
        )

    kwargs: dict[str, Any] = {
        "seed_candidate": seed_candidate,
        "trainset": trainset,
        "valset": valset,
        "adapter": gepa_adapter,
        "callbacks": [callback],
        "stop_callbacks": owned_stop_callbacks or None,
        "max_metric_calls": max_metric_calls,
        "candidate_selection_strategy": candidate_selection_strategy,
        "skip_perfect_score": config.skip_perfect_parent_reflection,
        "reflection_minibatch_size": reflection_minibatch_size,
        "cache_evaluation": config.cache_evaluations,
        "seed": config.seed,
        "display_progress_bar": False,
        "raise_on_exception": True,
    }
    if reflection_lm is not None:
        kwargs["reflection_lm"] = reflection_lm
    if custom_candidate_proposer is not None:
        kwargs["custom_candidate_proposer"] = custom_candidate_proposer
    kwargs["trainset"] = _with_row_identities(trainset)
    kwargs["valset"] = _with_row_identities(valset)
    result = optimize(**kwargs)
    if custom_candidate_proposer is not None and preflight_evaluation is not None:
        # GEPA's state correctly counts its seed evaluation, but this run
        # served that evaluation from the already-accounted launch preflight.
        # Its public metric result must consequently retain M1's convention:
        # GEPA result counts exclude the one caller preflight, while the
        # adapter's physical count is result + one.
        total = getattr(result, "total_metric_calls", None)
        if isinstance(total, int):
            result = dataclasses.replace(result, total_metric_calls=max(0, total - len(preflight_rows)))
    return result
