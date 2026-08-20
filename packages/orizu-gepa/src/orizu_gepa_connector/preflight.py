"""Launch-time safety checks performed before an optimization run exists."""

from __future__ import annotations

import math
from typing import Any


def validate_seed_and_scorer(
    *,
    scores: list[float],
    row_evidence: list[dict[str, Any]] | None = None,
    allow_degenerate_seed: bool,
    higher_is_better: bool = True,
) -> dict[str, Any]:
    """Classify a sampled seed without treating a transient row failure as global.

    A row that returns a score, including the worst score, proves the runner
    and scorer pipeline executed.  Only a sample containing *no* such row is
    an execution refusal.  Successful worst-score rows remain the separate,
    deliberately bypassable ``degenerate_seed`` condition.
    """
    evidence = list(row_evidence or [])
    successful_scores: list[float] = []
    failures: dict[str, list[str | None]] = {}
    for index, score in enumerate(scores):
        row = evidence[index] if index < len(evidence) else {}
        if row.get("scorer_error"):
            reason = "scorer_execution_failed"
        elif row.get("execution_error"):
            source = row.get("execution_error_source")
            reason = f"{source}_execution_failed" if source in {"candidate", "scorer"} else "runner_execution_failed"
        else:
            successful_scores.append(score)
            continue
        failures.setdefault(reason, []).append(row.get("row_id"))

    warnings = [
        {"reason": reason, "row_ids": row_ids}
        for reason, row_ids in failures.items()
    ]
    if failures and not successful_scores and not allow_degenerate_seed:
        # Every sampled row failed before yielding a usable score. Preserve a
        # precise source when the failure mode is uniform, otherwise name the
        # shared runner pipeline rather than pretending one source won.
        reason = next(iter(failures)) if len(failures) == 1 else "runner_execution_failed"
        return {"allowed": False, "reason": reason, "row_evidence": evidence}

    worst_bound = all(math.isclose(score, 0.0, abs_tol=1e-9) for score in successful_scores)
    # The adapter normalizes lower-is-better scores into GEPA's higher-is-
    # better orientation. Legacy still refuses a uniform raw 0.0 lower-bound
    # (normalized 1.0): it is a perfect seed or a silent contract mismatch,
    # neither of which gives reflection a useful gradient.
    lower_perfect_bound = not higher_is_better and all(
        math.isclose(score, 1.0, abs_tol=1e-9) for score in successful_scores
    )
    degenerate = bool(successful_scores) and (worst_bound or lower_perfect_bound)
    if degenerate and not allow_degenerate_seed:
        verdict: dict[str, Any] = {"allowed": False, "reason": "degenerate_seed", "row_evidence": evidence}
    else:
        verdict = {"allowed": True, "reason": None, "row_evidence": evidence}
    if warnings:
        verdict["warnings"] = warnings
    return verdict
