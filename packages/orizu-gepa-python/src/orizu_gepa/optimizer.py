from __future__ import annotations

import dataclasses
import hashlib
import json
import math
import os
import random
import subprocess
import sys
import time
import uuid
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol


DEFAULT_REFLECTION_PROMPT_TEMPLATE = """I am optimizing a text parameter in my system.

The current parameter value is:
```
<current_candidate>
```

Below is evaluation data showing how this parameter value performed across multiple test cases. The data contains performance metrics, scorer feedback, errors, and any relevant diagnostic information from the evaluation:
```
<evaluation_data>
```

Your task is to propose a new, improved parameter value that can be used as a drop-in replacement for the current one.

Carefully analyze all the evaluation data above. Look for patterns that indicate what works and what does not.

Pay special attention to:
- Performance metrics and how they correlate with parameter behavior
- Recurring issues, errors, or failure patterns across multiple test cases
- Successful patterns or behaviors that should be preserved or enhanced
- Any domain-specific requirements, constraints, or factual information revealed in the evaluation data
- Specific technical details that are crucial for understanding the parameter's role

Based on your analysis, produce a new parameter value that addresses the identified issues while preserving or improving what works well.

Return only the complete updated parameter text, exactly as it should be used by the system.
Do not include analysis, explanation, labels, XML tags, or a surrounding markdown code fence.
Your response will be used verbatim as the next candidate."""

AUTO_NUM_THREADS_HARD_CAP = 64
AUTO_NUM_THREADS_WORKER_MEMORY_BYTES = 512 * 1024 * 1024
AUTO_NUM_THREADS_MEMORY_RESERVE_BYTES = 1024 * 1024 * 1024
AUTO_NUM_THREADS_FD_HEADROOM = 64
AUTO_NUM_THREADS_FDS_PER_WORKER = 16


@dataclass(frozen=True)
class NumThreadsPlan:
    requested: int | str
    resolved: int
    row_bound: int
    cpu_bound: int
    memory_bound: int | None
    fd_bound: int | None
    hard_cap: int
    worker_memory_bytes: int
    available_memory_bytes: int | None
    total_memory_bytes: int | None
    memory_reserve_bytes: int | None
    limiting_factor: str

    def to_payload(self) -> dict[str, Any]:
        return dataclasses.asdict(self)


@dataclass(frozen=True)
class DatasetRow:
    id: str
    row: dict[str, Any]


@dataclass(frozen=True)
class PromptContext:
    body: str | None
    body_kind: str
    provider_settings: dict[str, Any]
    prompt_version_id: str
    runner_version_id: str
    prompt_id: str | None = None
    scorer_version_id: str | None = None
    metric_key: str | None = None
    higher_is_better: bool = True


@dataclass(frozen=True)
class RunnerCallResult:
    model_response: Any = None
    raw_api_response: Any = None
    token_in: int | None = None
    token_out: int | None = None
    latency_ms: int | None = None
    cost_usd: float | None = None
    error: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class RowEvaluation:
    row_id: str
    row: dict[str, Any]
    output: Any
    score: float
    feedback: str | None
    raw_response: Any = None
    scorer_response: Any = None
    latency_ms: int | None = None
    token_in: int | None = None
    token_out: int | None = None
    cost_usd: float | None = None
    error: str | None = None
    cached: bool = False
    # ALI-1158 review (codex): which side produced `error` — "candidate" or
    # "scorer". The degeneracy check must not blame the scorer contract for a
    # candidate runner that fails on every row.
    error_source: str | None = None

    def to_payload(self) -> dict[str, Any]:
        return {
            "row_id": self.row_id,
            "row": self.row,
            "output": self.output,
            "score": self.score,
            "feedback": self.feedback,
            "raw_response": self.raw_response,
            "scorer_response": self.scorer_response,
            "latency_ms": self.latency_ms,
            "token_in": self.token_in,
            "token_out": self.token_out,
            "cost_usd": self.cost_usd,
            "error": self.error,
            "error_source": self.error_source,
            "cached": self.cached,
        }


@dataclass(frozen=True)
class ReflectionResult:
    prompt: str
    response: str
    candidate_text: str


class RetryableReflectionError(RuntimeError):
    """Raised when a transient reflection-provider failure remains after retries."""


class CandidateRunnerError(RuntimeError):
    """A candidate-runner invocation raised (ALI-1158 review, codex round 3).

    Tagging the origin at the call site keeps the seed-launch probe from
    mis-diagnosing a candidate-runner crash (missing dependency, non-zero
    subprocess exit) as a scorer-contract mismatch. Subclasses RuntimeError so
    every pre-existing broad handler still catches it.
    """


class ScorerContractError(RuntimeError):
    """Launch-time scorer-runner contract validation failure (ALI-1158).

    Raised before the first iteration when scoring the seed candidate produced
    a degenerate result: the scorer errored on every row, returned nothing
    parseable, or scored every seed validation row at the worst possible value.
    A uniformly-worst seed is almost always a harness bug — typically a judge
    runner written for the flat-row score-run contract being handed GEPA's
    {source_row, candidate_output} shape — not a legitimately terrible prompt.
    """


SCORER_CONTRACT_GUIDANCE = (
    "GEPA hands the scorer runner a row shaped {source_row, candidate_id, "
    "candidate_output, candidate_raw_response, candidate_error}. A judge "
    "runner written for flat-row score runs (`orizu runners exec "
    "--scorer-version`) reads the dataset row fields directly, so under GEPA "
    "it sees an empty draft/output in every field it inspects and scores "
    "everything 0. If this scorer runner speaks the flat-row contract, re-run "
    "with --scorer-input-contract flat_row (add --scorer-candidate-field "
    "<row-field> when the judge reads the candidate output from a specific "
    "row field, e.g. 'draft'), or declare scorer_input_contract / "
    "candidate_output_field in the runner manifest and push a new runner "
    "version. If the seed genuinely deserves the worst score on every "
    "validation row, re-run with --allow-degenerate-seed."
)


def _seed_degeneracy_reason(
    seed_results: list["RowEvaluation"],
    higher_is_better: bool,
) -> str | None:
    """Classify a seed validation set as degenerate, or return None.

    The line we can draw within the contract: a scorer that errors on EVERY
    row, or scores EVERY row at the worst possible bound (0.0 for
    higher-is-better, 1.0 for lower-is-better), gives GEPA no gradient and is
    overwhelmingly a harness/contract bug. Partial zeros or low-but-mixed
    seeds are legitimate scores and pass.
    """
    if not seed_results:
        return None
    if all(result.error for result in seed_results):
        # ALI-1158 review (codex): a candidate runner that fails on every row
        # is a candidate-side failure — scorer-contract guidance would send
        # the user to the wrong component. Only blame the scorer contract when
        # at least one error actually came from the scorer side.
        # Intentional heuristic: ANY scorer-side error keeps the contract
        # framing below — only an all-candidate failure set redirects.
        if all(result.error_source == "candidate" for result in seed_results):
            return (
                "every seed validation row failed in the CANDIDATE runner "
                "(the scorer was never the problem)"
            )
        return "every seed validation row returned a runner/scorer error"
    worst = 0.0 if higher_is_better else 1.0
    # Scores are clamped to [0, 1] in _score_from_scorer, so a true worst-case
    # lands exactly on the bound — but the score is still a float we do not
    # produce ourselves, so compare with a tolerance rather than exact
    # equality (ALI-1158 review): a scorer emitting 0.9999999999 under
    # lower-is-better is the worst bound in every sense that matters.
    if all(math.isclose(result.score, worst, abs_tol=1e-9) for result in seed_results):
        direction = "higher-is-better" if higher_is_better else "lower-is-better"
        return (
            f"every seed validation row scored the worst possible value "
            f"({worst} for this {direction} scorer)"
        )
    # ALI-1158 review (codex round 3): under LOWER-is-better, 0.0 is the
    # PERFECT bound — so a flat-row scorer silently zeroing on the wrong input
    # shape (the exact mismatch this validation exists to catch) would sail
    # through as a flawless seed and burn the run. A uniformly-0.0 seed under
    # lower-is-better is either that mismatch or a seed with nothing left to
    # optimize; refuse either way, with the same opt-out. Higher-is-better
    # uniformly-perfect seeds are deliberately NOT refused here: 1.0 is not a
    # plausible silent-mismatch artifact, and "already perfect" is a
    # legitimate (if pointless) launch.
    if not higher_is_better and all(
        math.isclose(result.score, 0.0, abs_tol=1e-9) for result in seed_results
    ):
        return (
            "every seed validation row scored 0.0 under a lower-is-better "
            "scorer — the perfect bound, which is also exactly what a scorer "
            "silently zeroing on the wrong input shape looks like; GEPA has "
            "no gradient either way"
        )
    return None


def _seed_degeneracy_message(
    reason: str,
    seed_results: list["RowEvaluation"],
) -> str:
    sample_feedback = next(
        (result.feedback for result in seed_results if result.feedback),
        None,
    )
    sample_error = next(
        (result.error for result in seed_results if result.error),
        None,
    )
    details = []
    if sample_feedback:
        details.append(f"first scorer feedback: {str(sample_feedback)[:300]!r}")
    if sample_error:
        details.append(f"first error: {str(sample_error)[:300]!r}")
    detail_text = f" ({'; '.join(details)})" if details else ""
    if "CANDIDATE runner" in reason:
        # Candidate-side failure: scorer-contract remediation would misdirect.
        return (
            f"Seed validation failed at optimization launch: {reason}"
            f"{detail_text}. Fix the candidate runner (--candidate-runner-dir / "
            "its registered version) before optimizing; the scorer input "
            "contract is not implicated. Re-run with --allow-degenerate-seed "
            "only if erroring rows are genuinely expected."
        )
    return (
        f"Scorer contract validation failed at optimization launch: {reason}"
        f"{detail_text}. A degenerate seed is almost always a scorer-runner "
        "contract mismatch, not a bad prompt — refusing to iterate. "
        + SCORER_CONTRACT_GUIDANCE
    )


def _dspy_auto_metric_budget(
    *,
    num_components: int,
    num_candidates: int,
    valset_size: int,
    minibatch_size: int = 35,
    full_eval_steps: int = 5,
) -> int:
    if num_candidates <= 0:
        raise ValueError("num_candidates must be > 0.")
    if num_components < 0 or valset_size < 0 or minibatch_size < 0:
        raise ValueError("num_components, valset_size, and minibatch_size must be >= 0.")
    if full_eval_steps < 1:
        raise ValueError("full_eval_steps must be >= 1.")

    num_trials = int(max(2 * (num_components * 2) * math.log2(num_candidates), 1.5 * num_candidates))
    total = valset_size
    total += num_candidates * 5
    total += num_trials * minibatch_size
    if num_trials == 0:
        return total

    periodic_fulls = (num_trials + 1) // full_eval_steps + 1
    extra_final = 1 if num_trials < full_eval_steps else 0
    total += (periodic_fulls + extra_final) * valset_size
    return total


def _approx_metric_calls_for_candidate_budget(
    *,
    candidate_proposals: int,
    trainset_size: int,
    valset_size: int,
    minibatch_size: int,
) -> int:
    """Estimate row-level metric calls for proposal-count budgets."""
    safe_proposals = max(0, candidate_proposals)
    safe_valset_size = max(0, valset_size)
    safe_trainset_size = max(0, trainset_size)
    safe_minibatch_size = max(0, minibatch_size)
    sampled_train_rows = min(safe_trainset_size, safe_minibatch_size)
    per_iteration = (2 * sampled_train_rows) + safe_valset_size
    return safe_valset_size + (safe_proposals * per_iteration)


@dataclass
class Budget:
    budget_kind: str
    limit: int
    approx_metric_call_limit: int | None = None
    used_metric_calls: int = 0
    used_reflection_failure_metric_charges: int = 0
    used_full_evals: int = 0
    used_candidate_proposals: int = 0
    used_iterations: int = 0

    def __post_init__(self) -> None:
        if self.approx_metric_call_limit is None and self.budget_kind == "max_metric_calls":
            self.approx_metric_call_limit = self.limit

    @classmethod
    def from_config(
        cls,
        config: "TextGepaConfig",
        *,
        trainset_size: int = 0,
        valset_size: int = 0,
        num_components: int = 1,
    ) -> "Budget":
        if config.max_metric_calls is not None:
            return cls(
                "max_metric_calls",
                config.max_metric_calls,
                approx_metric_call_limit=config.max_metric_calls,
            )
        if config.max_full_evals is not None:
            metric_limit = config.max_full_evals * (trainset_size + valset_size)
            return cls(
                "max_metric_calls",
                metric_limit,
                approx_metric_call_limit=metric_limit,
            )
        if config.max_candidate_proposals is not None:
            return cls(
                "max_candidate_proposals",
                config.max_candidate_proposals,
                approx_metric_call_limit=_approx_metric_calls_for_candidate_budget(
                    candidate_proposals=config.max_candidate_proposals,
                    trainset_size=trainset_size,
                    valset_size=valset_size,
                    minibatch_size=config.minibatch_size,
                ),
            )
        if config.max_iterations is not None:
            return cls("max_iterations", config.max_iterations)
        if not config.budget:
            raise ValueError("No optimization budget configured.")
        preset = "medium" if config.budget == "auto" else config.budget
        preset_candidates = {
            "light": 6,
            "medium": 12,
            "heavy": 18,
            "high": 18,
        }.get(preset, 6)
        metric_limit = _dspy_auto_metric_budget(
            num_components=num_components,
            num_candidates=preset_candidates,
            valset_size=valset_size,
        )
        return cls(
            "max_metric_calls",
            metric_limit,
            approx_metric_call_limit=metric_limit,
        )

    @property
    def metric_budget_used(self) -> int:
        return self.used_metric_calls + self.used_reflection_failure_metric_charges

    @property
    def used(self) -> int:
        if self.budget_kind == "max_full_evals":
            return self.used_full_evals
        if self.budget_kind == "max_candidate_proposals":
            return self.used_candidate_proposals
        if self.budget_kind == "max_iterations":
            return self.used_iterations
        return self.metric_budget_used

    @property
    def remaining(self) -> int:
        return max(0, self.limit - self.used)

    @property
    def metric_calls_remaining(self) -> int:
        if self.approx_metric_call_limit is None:
            return 0
        if self.remaining == 0:
            return 0
        return max(0, self.approx_metric_call_limit - self.metric_budget_used)

    @property
    def progress_percent(self) -> float:
        if self.remaining == 0:
            return 100.0
        if self.approx_metric_call_limit is None:
            if self.limit <= 0:
                return 100.0 if self.used > 0 else 0.0
            return min(100.0, max(0.0, (self.used / self.limit) * 100.0))
        if self.approx_metric_call_limit <= 0:
            # A zero-sized budget with any recorded metric work should still read as complete.
            return 100.0 if self.metric_budget_used > 0 else 0.0
        return min(100.0, max(0.0, (self.metric_budget_used / self.approx_metric_call_limit) * 100.0))

    def allows_iteration(self) -> bool:
        return self.remaining > 0

    def charge_retryable_reflection_failure(self) -> None:
        if self.budget_kind == "max_metric_calls":
            self.used_reflection_failure_metric_charges += 1

    def to_payload(self) -> dict[str, Any]:
        return {
            "budget_kind": self.budget_kind,
            "limit": self.limit,
            "used": self.used,
            "remaining": self.remaining,
            "approx_metric_call_limit": self.approx_metric_call_limit,
            "metric_call_budget": self.approx_metric_call_limit,
            "metric_calls_remaining": self.metric_calls_remaining,
            "metric_budget_used": self.metric_budget_used,
            "used_metric_calls": self.used_metric_calls,
            "used_reflection_failure_metric_charges": self.used_reflection_failure_metric_charges,
            "used_full_evals": self.used_full_evals,
            "used_candidate_proposals": self.used_candidate_proposals,
            "used_iterations": self.used_iterations,
            "iteration_budget": self.limit if self.budget_kind == "max_iterations" else None,
            "iterations_remaining": self.remaining if self.budget_kind == "max_iterations" else None,
        }

    def progress_payload(self, *, stage: str, iteration: int | None) -> dict[str, Any]:
        percent = round(self.progress_percent, 1)
        return {
            "stage": stage,
            "iteration": iteration,
            "percent": percent,
            "progress_percent": percent,
            "metric_calls_used": self.used_metric_calls,
            "metric_budget_used": self.metric_budget_used,
            "metric_call_budget": self.approx_metric_call_limit,
            "approx_metric_call_budget": self.approx_metric_call_limit,
            "metric_calls_remaining": self.metric_calls_remaining,
            "is_over_budget": (
                self.approx_metric_call_limit is not None and
                self.metric_budget_used > self.approx_metric_call_limit
            ),
            "budget": self.to_payload(),
        }


@dataclass(frozen=True)
class TextGepaConfig:
    budget: str | None = "auto"
    max_iterations: int | None = None
    minibatch_size: int = 3
    num_threads: int | str = "auto"
    candidate_selection_strategy: str = "pareto"
    epsilon: float = 0.1
    max_metric_calls: int | None = None
    max_full_evals: int | None = None
    max_candidate_proposals: int | None = None
    reflection_model: str = "anthropic/claude-opus-4-7"
    reflection_temperature: float | None = None
    reflection_max_tokens: int | None = None
    reflection_retry_attempts: int = 3
    reflection_http_timeout_seconds: int = 180
    reflection_prompt_template: str | None = None
    reflection_provider_settings: dict[str, Any] = field(default_factory=dict)
    objective: str = "Improve this text candidate to maximize evaluator score while preserving intended behavior."
    seed: int = 0
    auto_promote: bool = False
    promotion_label: str | None = None
    fail_on_log_error: bool = True
    log_row_snapshots: bool = False
    cache_evaluations: bool = True
    skip_perfect_parent_reflection: bool = True
    # ALI-1158: opt-out for the launch-time degenerate-seed refusal, for the
    # rare case where the seed legitimately deserves the worst score on every
    # validation row.
    allow_degenerate_seed: bool = False


@dataclass(frozen=True)
class TextGepaResult:
    run_id: str
    best_candidate_id: str
    best_candidate_text: str
    best_score: float
    seed_score: float
    promoted_prompt_version_id: str | None
    budget: Budget


class EventSink(Protocol):
    def log_event(
        self,
        event_type: str,
        payload: dict[str, Any] | None = None,
        *,
        event_layer: str = "core",
        optimizer_family: str = "gepa",
        iteration: int | None = None,
        candidate_id: str | None = None,
        parent_candidate_id: str | None = None,
        child_candidate_id: str | None = None,
    ) -> None:
        ...

    def promote_candidate(
        self,
        *,
        candidate_id: str,
        prompt_id: str,
        parent_prompt_version_id: str,
        body: str,
        body_kind: str,
        provider_settings: dict[str, Any],
        runner_version_id: str,
        label: str | None,
    ) -> str:
        ...

    def finish_run(
        self,
        *,
        status: str,
        best_score: float | None = None,
        best_candidate_id: str | None = None,
        result_prompt_version_id: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        ...


CandidateRunner = Callable[[str, DatasetRow, PromptContext, str], RunnerCallResult]
ScorerRunner = Callable[[DatasetRow, RunnerCallResult, PromptContext, str], RunnerCallResult]
Reflector = Callable[[str, list[RowEvaluation], TextGepaConfig], ReflectionResult]


def _score_from_scorer(result: RunnerCallResult) -> tuple[float, str | None]:
    source: Any = result.extra
    if "score" not in source and isinstance(result.model_response, dict):
        # `extra` (the runner's TOP-LEVEL output keys) intentionally wins over
        # `model_response` on collision: top-level `score`/`feedback` are the
        # authoritative output-contract locations; model_response is only a
        # fallback when the top level carried no score at all.
        source = {**result.model_response, **result.extra}
    score_value = source.get("score")
    if isinstance(score_value, str):
        try:
            score_value = float(score_value)
        except ValueError:
            score_value = None
    if not isinstance(score_value, (int, float)):
        raise ValueError("Scorer result must include a numeric score")
    score = float(score_value)
    if not math.isfinite(score):
        raise ValueError("Scorer result score must be finite")
    score = max(0.0, min(1.0, score))
    feedback = source.get("feedback")
    if feedback is None and isinstance(result.model_response, dict):
        feedback = result.model_response.get("feedback") or result.model_response.get("reasoning")
    return score, str(feedback) if feedback is not None else None


def _mean(results: list[RowEvaluation]) -> float:
    if not results:
        return 0.0
    return sum(item.score for item in results) / len(results)


def _total(results: list[RowEvaluation]) -> float:
    return sum(item.score for item in results)


def _stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def _hash_payload(value: Any) -> str:
    return hashlib.sha256(_stable_json(value).encode("utf-8")).hexdigest()


def _evaluation_payload(result: RowEvaluation, *, include_row: bool) -> dict[str, Any]:
    payload = result.to_payload()
    if include_row:
        return payload
    payload["row"] = None
    payload["row_sha256"] = _hash_payload(result.row)
    payload["row_redacted"] = True
    return payload


def _text_log_fields(name: str, value: str, *, include_text: bool) -> dict[str, Any]:
    if include_text:
        return {name: value}
    return {
        f"{name}_sha256": _hash_payload(value),
        f"{name}_redacted": True,
    }


def _scorer_version_id(scorer_context: PromptContext) -> str:
    return scorer_context.scorer_version_id or scorer_context.prompt_version_id


def _metric_key(scorer_context: PromptContext) -> str:
    return scorer_context.metric_key or "score"


def _positive_int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def _proc_meminfo_bytes(key: str) -> int | None:
    try:
        with open("/proc/meminfo", encoding="utf-8") as handle:
            for line in handle:
                if not line.startswith(f"{key}:"):
                    continue
                parts = line.split()
                if len(parts) >= 2:
                    return int(parts[1]) * 1024
    except (OSError, ValueError):
        return None
    return None


def _sysconf_memory_bytes(pages_name: str) -> int | None:
    try:
        pages = os.sysconf(pages_name)
        page_size = os.sysconf("SC_PAGE_SIZE")
    except (AttributeError, OSError, ValueError):
        return None
    if not isinstance(pages, int) or not isinstance(page_size, int):
        return None
    if pages <= 0 or page_size <= 0:
        return None
    return pages * page_size


def _darwin_available_memory_bytes() -> int | None:
    if sys.platform != "darwin":
        return None
    try:
        output = subprocess.check_output(["vm_stat"], text=True)
    except (OSError, subprocess.SubprocessError):
        return None

    lines = output.splitlines()
    if not lines:
        return None
    page_size_marker = "page size of "
    if page_size_marker not in lines[0]:
        return None
    try:
        page_size = int(lines[0].split(page_size_marker, 1)[1].split()[0])
    except (IndexError, ValueError):
        return None

    available_pages = 0
    available_keys = {
        "Pages free",
        "Pages inactive",
        "Pages speculative",
        "Pages purgeable",
    }
    for line in lines[1:]:
        key, separator, value = line.partition(":")
        if separator != ":" or key not in available_keys:
            continue
        normalized_value = value.strip().rstrip(".").replace(",", "")
        try:
            available_pages += int(normalized_value)
        except ValueError:
            continue
    return available_pages * page_size if available_pages > 0 else None


def _available_memory_bytes() -> int | None:
    return (
        _proc_meminfo_bytes("MemAvailable")
        or _darwin_available_memory_bytes()
        or _sysconf_memory_bytes("SC_AVPHYS_PAGES")
        or _total_memory_bytes()
    )


def _total_memory_bytes() -> int | None:
    return _proc_meminfo_bytes("MemTotal") or _sysconf_memory_bytes("SC_PHYS_PAGES")


def _open_file_soft_limit() -> int | None:
    try:
        import resource
    except ImportError:
        return None
    try:
        soft_limit, _ = resource.getrlimit(resource.RLIMIT_NOFILE)
    except (OSError, ValueError):
        return None
    if soft_limit <= 0 or soft_limit == resource.RLIM_INFINITY:
        return None
    return int(soft_limit)


def _parse_requested_num_threads(requested: int | str) -> int | str:
    if isinstance(requested, int):
        if requested <= 0:
            raise ValueError("num_threads must be positive or 'auto'")
        return requested
    if isinstance(requested, str):
        normalized = requested.strip().lower()
        if normalized == "auto":
            return "auto"
        try:
            parsed = int(normalized)
        except ValueError as exc:
            raise ValueError("num_threads must be positive or 'auto'") from exc
        if parsed <= 0:
            raise ValueError("num_threads must be positive or 'auto'")
        return parsed
    raise ValueError("num_threads must be positive or 'auto'")


def resolve_num_threads(
    requested: int | str,
    *,
    minibatch_size: int,
    validation_count: int,
    cpu_count: int | None = None,
    available_memory_bytes: int | None = None,
    total_memory_bytes: int | None = None,
    fd_limit: int | None = None,
    hard_cap: int | None = None,
    worker_memory_bytes: int | None = None,
) -> NumThreadsPlan:
    """Resolve an explicit or automatic row-evaluation thread count for one GEPA run."""
    parsed = _parse_requested_num_threads(requested)
    row_bound = max(1, max(minibatch_size, validation_count))
    detected_cpu_count = cpu_count if cpu_count is not None else os.cpu_count()
    normalized_cpu_count = max(1, detected_cpu_count or 1)
    cpu_bound = normalized_cpu_count * 2
    resolved_hard_cap = hard_cap or _positive_int_env(
        "ORIZU_GEPA_AUTO_THREADS_MAX",
        AUTO_NUM_THREADS_HARD_CAP,
    )
    resolved_worker_memory_bytes = worker_memory_bytes or (
        _positive_int_env(
            "ORIZU_GEPA_WORKER_MEMORY_MB",
            AUTO_NUM_THREADS_WORKER_MEMORY_BYTES // (1024 * 1024),
        ) * 1024 * 1024
    )

    detected_total_memory_bytes = (
        total_memory_bytes if total_memory_bytes is not None else _total_memory_bytes()
    )
    detected_available_memory_bytes = (
        available_memory_bytes
        if available_memory_bytes is not None
        else _available_memory_bytes()
    )
    memory_reserve_bytes = None
    memory_bound = None
    if detected_available_memory_bytes is not None:
        total_reserve = (
            detected_total_memory_bytes // 4
            if detected_total_memory_bytes is not None
            else 0
        )
        memory_reserve_bytes = max(AUTO_NUM_THREADS_MEMORY_RESERVE_BYTES, total_reserve)
        usable_memory_bytes = max(0, detected_available_memory_bytes - memory_reserve_bytes)
        memory_bound = max(1, usable_memory_bytes // max(1, resolved_worker_memory_bytes))

    detected_fd_limit = fd_limit if fd_limit is not None else _open_file_soft_limit()
    fd_bound = None
    if detected_fd_limit is not None:
        usable_fds = max(0, detected_fd_limit - AUTO_NUM_THREADS_FD_HEADROOM)
        fd_bound = max(1, usable_fds // AUTO_NUM_THREADS_FDS_PER_WORKER)

    if parsed != "auto":
        return NumThreadsPlan(
            requested=requested,
            resolved=parsed,
            row_bound=row_bound,
            cpu_bound=cpu_bound,
            memory_bound=memory_bound,
            fd_bound=fd_bound,
            hard_cap=resolved_hard_cap,
            worker_memory_bytes=resolved_worker_memory_bytes,
            available_memory_bytes=detected_available_memory_bytes,
            total_memory_bytes=detected_total_memory_bytes,
            memory_reserve_bytes=memory_reserve_bytes,
            limiting_factor="explicit",
        )

    limits = {
        "rows": row_bound,
        "cpu": cpu_bound,
        "hard_cap": resolved_hard_cap,
    }
    if memory_bound is not None:
        limits["memory"] = memory_bound
    if fd_bound is not None:
        limits["file_descriptors"] = fd_bound
    resolved = max(1, min(limits.values()))
    limiting_factor = next(
        name
        for name in ("rows", "cpu", "memory", "file_descriptors", "hard_cap")
        if limits.get(name) == resolved
    )
    return NumThreadsPlan(
        requested=requested,
        resolved=resolved,
        row_bound=row_bound,
        cpu_bound=cpu_bound,
        memory_bound=memory_bound,
        fd_bound=fd_bound,
        hard_cap=resolved_hard_cap,
        worker_memory_bytes=resolved_worker_memory_bytes,
        available_memory_bytes=detected_available_memory_bytes,
        total_memory_bytes=detected_total_memory_bytes,
        memory_reserve_bytes=memory_reserve_bytes,
        limiting_factor=limiting_factor,
    )


def _is_better(challenger: float, incumbent: float, higher_is_better: bool) -> bool:
    return challenger > incumbent if higher_is_better else challenger < incumbent


def _is_perfect_minibatch(results: list[RowEvaluation], higher_is_better: bool) -> bool:
    if not results:
        return False
    if higher_is_better:
        return all(result.score >= 1.0 for result in results)
    return all(result.score <= 0.0 for result in results)


class EvaluationCache:
    def __init__(self):
        self._values: dict[str, RowEvaluation] = {}

    def key(
        self,
        *,
        candidate_text: str,
        row: DatasetRow,
        split: str,
        prompt_context: PromptContext,
        scorer_context: PromptContext,
    ) -> str:
        return _hash_payload({
            "candidate_text_hash": _hash_payload(candidate_text),
            "row_id": row.id,
            "row_hash": _hash_payload(row.row),
            "split": split,
            "prompt_body_kind": prompt_context.body_kind,
            "prompt_provider_settings": prompt_context.provider_settings,
            "prompt_version_id": prompt_context.prompt_version_id,
            "runner_version_id": prompt_context.runner_version_id,
            "scorer_body_kind": scorer_context.body_kind,
            "scorer_provider_settings": scorer_context.provider_settings,
            "scorer_version_id": _scorer_version_id(scorer_context),
            "metric_key": _metric_key(scorer_context),
            "scorer_prompt_version_id": scorer_context.prompt_version_id,
            "scorer_runner_version_id": scorer_context.runner_version_id,
        })

    def get(self, key: str) -> RowEvaluation | None:
        value = self._values.get(key)
        if value is None:
            return None
        return dataclasses.replace(value, cached=True)

    def set(self, key: str, value: RowEvaluation) -> None:
        self._values[key] = dataclasses.replace(value, cached=False)


def _results_payload(
    *,
    candidate_id: str,
    split: str,
    results: list[RowEvaluation],
    log_row_snapshots: bool,
    scorer_version_id: str | None = None,
    metric_key: str | None = None,
    scorer_role: str | None = None,
) -> dict[str, Any]:
    rows = [
        _evaluation_payload(result, include_row=log_row_snapshots)
        for result in results
    ]
    return {
        "candidate_id": candidate_id,
        "split": split,
        "row_results": rows,
        "score_total": _total(results),
        "score_mean": _mean(results),
        "score_value": _mean(results),
        "scorer_version_id": scorer_version_id,
        "metric_key": metric_key,
        "scorer_role": scorer_role,
        "cache_hits": sum(1 for result in results if result.cached),
        "cache_misses": sum(1 for result in results if not result.cached),
    }


def _frontier_by_row_id(
    val_scores_by_candidate: dict[str, dict[str, float]],
    higher_is_better: bool = True,
) -> dict[str, set[str]]:
    row_ids = sorted({row_id for scores in val_scores_by_candidate.values() for row_id in scores})
    frontier_by_row_id: dict[str, set[str]] = {}
    for row_id in row_ids:
        scored = {
            candidate_id: scores[row_id]
            for candidate_id, scores in val_scores_by_candidate.items()
            if row_id in scores
        }
        if not scored:
            continue
        best_score = max(scored.values()) if higher_is_better else min(scored.values())
        frontier_by_row_id[row_id] = {
            candidate_id
            for candidate_id, score in scored.items()
            if score == best_score
        }
    return frontier_by_row_id


def _aggregate_scores(
    val_scores_by_candidate: dict[str, dict[str, float]],
) -> dict[str, float]:
    return {
        candidate_id: (sum(scores.values()) / max(len(scores), 1))
        for candidate_id, scores in val_scores_by_candidate.items()
    }


def _frontier_counts(frontier_by_row_id: dict[str, set[str]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for candidate_ids in frontier_by_row_id.values():
        for candidate_id in candidate_ids:
            counts[candidate_id] = counts.get(candidate_id, 0) + 1
    return counts


def _select_parent_candidate_id(
    *,
    val_scores_by_candidate: dict[str, dict[str, float]],
    best_candidate_id: str,
    config: TextGepaConfig,
    iteration: int,
    higher_is_better: bool = True,
) -> str:
    strategy = config.candidate_selection_strategy
    candidate_ids = sorted(val_scores_by_candidate)
    if not candidate_ids:
        return best_candidate_id
    rng = random.Random(config.seed + iteration)

    if strategy == "current_best":
        return best_candidate_id
    if strategy == "epsilon_greedy":
        epsilon = max(0.0, min(1.0, config.epsilon))
        if rng.random() < epsilon:
            return rng.choice(candidate_ids)
        return best_candidate_id
    if strategy != "pareto":
        raise ValueError(
            "candidate_selection_strategy must be one of: pareto, current_best, epsilon_greedy"
        )

    frontier_counts = _frontier_counts(_frontier_by_row_id(val_scores_by_candidate, higher_is_better))
    sampling_list: list[str] = []
    for candidate_id, count in sorted(frontier_counts.items()):
        sampling_list.extend([candidate_id] * count)
    if not sampling_list:
        return best_candidate_id
    return rng.choice(sampling_list)


def _parent_selection_payload(
    *,
    val_scores_by_candidate: dict[str, dict[str, float]],
    selected_candidate_id: str,
    best_candidate_id: str,
    config: TextGepaConfig,
    higher_is_better: bool = True,
) -> dict[str, Any]:
    aggregate_scores = _aggregate_scores(val_scores_by_candidate)
    frontier_counts = _frontier_counts(_frontier_by_row_id(val_scores_by_candidate, higher_is_better))
    return {
        "strategy": config.candidate_selection_strategy,
        "selected_candidate_id": selected_candidate_id,
        "selected_validation_score": aggregate_scores.get(selected_candidate_id),
        "best_candidate_id": best_candidate_id,
        "best_validation_score": aggregate_scores.get(best_candidate_id),
        "frontier_counts": frontier_counts,
        "epsilon": config.epsilon if config.candidate_selection_strategy == "epsilon_greedy" else None,
    }


def _pareto_payload(
    val_scores_by_candidate: dict[str, dict[str, float]],
    val_text_by_candidate: dict[str, str],
    higher_is_better: bool = True,
) -> tuple[str, float, dict[str, Any]]:
    frontier_by_row_id: dict[str, dict[str, Any]] = {}
    raw_frontier = _frontier_by_row_id(val_scores_by_candidate, higher_is_better)
    for row_id, candidate_ids in raw_frontier.items():
        row_scores = [val_scores_by_candidate[candidate_id][row_id] for candidate_id in candidate_ids]
        best_score = max(row_scores) if higher_is_better else min(row_scores)
        frontier_by_row_id[row_id] = {
            "candidate_ids": sorted(candidate_ids),
            "score": best_score,
        }

    aggregate_scores = _aggregate_scores(val_scores_by_candidate)
    frontier_counts = _frontier_counts(raw_frontier)
    if frontier_counts:
        best_candidate_id = max(
            sorted(frontier_counts),
            key=lambda candidate_id: (
                frontier_counts[candidate_id],
                aggregate_scores.get(candidate_id, 0.0) if higher_is_better else -aggregate_scores.get(candidate_id, 0.0),
            ),
        )
    else:
        best_candidate_id = max(aggregate_scores, key=aggregate_scores.get) if higher_is_better else min(aggregate_scores, key=aggregate_scores.get)
    best_score = aggregate_scores[best_candidate_id]
    return best_candidate_id, best_score, {
        "frontier_by_row_id": frontier_by_row_id,
        "frontier_candidate_ids": sorted(frontier_counts),
        "candidate_scores": aggregate_scores,
        "frontier_counts": frontier_counts,
        "best_candidate_id": best_candidate_id,
        "best_score_mean": best_score,
        "best_candidate_preview": val_text_by_candidate[best_candidate_id][:1200],
    }


def _sample_minibatch(rows: list[DatasetRow], iteration: int, config: TextGepaConfig) -> list[DatasetRow]:
    if len(rows) <= config.minibatch_size:
        return list(rows)
    minibatch_size = max(1, config.minibatch_size)
    epoch_length = max(1, (len(rows) + minibatch_size - 1) // minibatch_size)
    epoch = max(iteration - 1, 0) // epoch_length
    offset = (max(iteration - 1, 0) % epoch_length) * minibatch_size
    shuffled = list(rows)
    random.Random(config.seed + epoch).shuffle(shuffled)
    minibatch = shuffled[offset:offset + minibatch_size]
    if len(minibatch) < minibatch_size:
        minibatch.extend(shuffled[:minibatch_size - len(minibatch)])
    return minibatch


def _candidate_id(iteration: int, text: str) -> str:
    compact = uuid.uuid5(uuid.NAMESPACE_URL, f"orizu-gepa:{iteration}:{text}").hex[:10]
    return f"iter-{iteration}-child-{compact}"


def evaluate_candidate(
    *,
    candidate_text: str,
    candidate_id: str,
    rows: list[DatasetRow],
    split: str,
    prompt_context: PromptContext,
    scorer_context: PromptContext,
    candidate_runner: CandidateRunner,
    scorer_runner: ScorerRunner,
    budget: Budget,
    evaluation_cache: EvaluationCache | None = None,
    num_threads: int = 1,
) -> list[RowEvaluation]:
    """Evaluate one candidate over rows, preserving row order while parallelizing uncached calls."""
    evaluations_by_index: dict[int, RowEvaluation] = {}
    pending: list[tuple[int, DatasetRow, str | None]] = []

    for index, row in enumerate(rows):
        cache_key = None
        if evaluation_cache is not None:
            cache_key = evaluation_cache.key(
                candidate_text=candidate_text,
                row=row,
                split=split,
                prompt_context=prompt_context,
                scorer_context=scorer_context,
            )
            cached = evaluation_cache.get(cache_key)
            if cached is not None:
                evaluations_by_index[index] = cached
                continue

        pending.append((index, row, cache_key))

    def run_uncached_row(index: int, row: DatasetRow, cache_key: str | None) -> tuple[int, str | None, RowEvaluation]:
        started = time.time()
        try:
            candidate_result = candidate_runner(candidate_text, row, prompt_context, candidate_id)
        except Exception as error:
            # Tag candidate-side raises so launch-time diagnosis does not send
            # the user to the scorer (ALI-1158 review, codex round 3). Any
            # Exception counts — an OSError/KeyError crash is just as much a
            # candidate failure, and an un-tagged one would regress to the
            # opaque wrong-component guidance this PR removes.
            raise CandidateRunnerError(
                f"candidate runner failed on row {row.id}: {error}"
            ) from error
        try:
            scorer_result = scorer_runner(row, candidate_result, scorer_context, candidate_id)
        except Exception as error:
            if candidate_result.error:
                # ALI-1158 review (codex round 5): the candidate failed SOFTLY
                # (error field, no raise) and the scorer then choked on its
                # null/errored output — the root cause is candidate-side; no
                # valid scorer contract was ever probed.
                raise CandidateRunnerError(
                    f"candidate runner failed on row {row.id} "
                    f"({candidate_result.error}); scoring its errored output "
                    f"then raised: {error}"
                ) from error
            raise
        score, feedback = _score_from_scorer(scorer_result)
        latency_ms = None
        if candidate_result.latency_ms is not None or scorer_result.latency_ms is not None:
            latency_ms = (candidate_result.latency_ms or 0) + (scorer_result.latency_ms or 0)
        elif started:
            latency_ms = int((time.time() - started) * 1000)
        evaluation = RowEvaluation(
            row_id=row.id,
            row=row.row,
            output=candidate_result.model_response,
            score=score,
            feedback=feedback,
            raw_response=candidate_result.raw_api_response,
            scorer_response=scorer_result.model_response,
            latency_ms=latency_ms,
            token_in=(candidate_result.token_in or 0) + (scorer_result.token_in or 0)
            if candidate_result.token_in is not None or scorer_result.token_in is not None else None,
            token_out=(candidate_result.token_out or 0) + (scorer_result.token_out or 0)
            if candidate_result.token_out is not None or scorer_result.token_out is not None else None,
            cost_usd=(candidate_result.cost_usd or 0.0) + (scorer_result.cost_usd or 0.0)
            if candidate_result.cost_usd is not None or scorer_result.cost_usd is not None else None,
            error=candidate_result.error or scorer_result.error,
            error_source=(
                "candidate" if candidate_result.error
                else ("scorer" if scorer_result.error else None)
            ),
        )
        return index, cache_key, evaluation

    worker_count = max(1, min(max(1, num_threads), len(pending) or 1))
    if worker_count == 1:
        completed = [run_uncached_row(index, row, cache_key) for index, row, cache_key in pending]
    else:
        completed = []
        next_pending_index = 0
        executor = ThreadPoolExecutor(max_workers=worker_count)
        futures = set()

        def submit_next_pending() -> bool:
            nonlocal next_pending_index
            if next_pending_index >= len(pending):
                return False
            index, row, cache_key = pending[next_pending_index]
            next_pending_index += 1
            futures.add(executor.submit(run_uncached_row, index, row, cache_key))
            return True

        try:
            for _ in range(worker_count):
                if not submit_next_pending():
                    break
            while futures:
                done, _ = wait(futures, return_when=FIRST_COMPLETED)
                batch = []
                for future in done:
                    futures.remove(future)
                    batch.append(future.result())
                completed.extend(batch)
                for _ in batch:
                    submit_next_pending()
        except BaseException:
            for future in futures:
                future.cancel()
            executor.shutdown(wait=True)
            raise
        else:
            executor.shutdown(wait=True)

    for index, cache_key, evaluation in completed:
        evaluations_by_index[index] = evaluation
        if evaluation_cache is not None and cache_key is not None:
            evaluation_cache.set(cache_key, evaluation)
        budget.used_metric_calls += 1

    return [
        evaluations_by_index[index]
        for index in sorted(evaluations_by_index)
    ]


def _log_iteration_progress(
    event_sink: EventSink,
    *,
    budget: Budget,
    iteration: int,
    candidate_id: str | None,
) -> None:
    event_sink.log_event(
        "optimization_progress",
        budget.progress_payload(stage="iteration_completed", iteration=iteration),
        event_layer="extension",
        iteration=iteration,
        candidate_id=candidate_id,
    )


def _completed_all_rows(results: list[RowEvaluation], rows: list[DatasetRow]) -> bool:
    return len(results) == len(rows)


def _has_future_iteration(config: TextGepaConfig, iteration: int) -> bool:
    return config.max_iterations is None or iteration < config.max_iterations


def optimize_loaded_text_candidate(
    *,
    run_id: str,
    prompt_context: PromptContext,
    scorer_context: PromptContext,
    trainset: list[DatasetRow],
    valset: list[DatasetRow],
    candidate_runner: CandidateRunner,
    scorer_runner: ScorerRunner,
    reflector: Reflector,
    event_sink: EventSink,
    config: TextGepaConfig,
    local_logger: Any | None = None,
) -> TextGepaResult:
    seed_text = prompt_context.body or ""
    budget = Budget.from_config(
        config,
        trainset_size=len(trainset),
        valset_size=len(valset),
        num_components=1,
    )
    num_threads_plan = resolve_num_threads(
        config.num_threads,
        minibatch_size=config.minibatch_size,
        validation_count=len(valset),
    )
    evaluation_cache = EvaluationCache() if config.cache_evaluations else None
    candidate_text_by_id = {"seed": seed_text}
    val_scores_by_candidate: dict[str, dict[str, float]] = {}
    promoted_prompt_version_id: str | None = None
    scorer_version_id = _scorer_version_id(scorer_context)
    metric_key = _metric_key(scorer_context)
    higher_is_better = scorer_context.higher_is_better
    budget_exhausted = False
    failed_reflection_count = 0

    try:
        event_sink.log_event("run_started", {
            "prompt_version_id": prompt_context.prompt_version_id,
            "runner_version_id": prompt_context.runner_version_id,
            "scorer_version_id": scorer_version_id,
            "scorer_prompt_version_id": scorer_context.prompt_version_id,
            "scorer_runner_version_id": scorer_context.runner_version_id,
            "seed_candidate_id": "seed",
            "seed_candidate_text": seed_text,
            "body_kind": prompt_context.body_kind,
            "inference_lm": prompt_context.provider_settings.get("model"),
            "reflection_lm": config.reflection_model,
            "scorer_lm": scorer_context.provider_settings.get("model"),
            "metric_key": metric_key,
            "higher_is_better": higher_is_better,
            "train_count": len(trainset),
            "validation_count": len(valset),
            "config": dataclasses.asdict(config),
            "num_threads": num_threads_plan.to_payload(),
            "budget": budget.to_payload(),
        })

        event_sink.log_event(
            "seed_val_set_started",
            {"row_ids": [row.id for row in valset]},
            event_layer="extension",
            candidate_id="seed",
        )
        try:
            seed_results = evaluate_candidate(
                candidate_text=seed_text,
                candidate_id="seed",
                rows=valset,
                split="validation",
                prompt_context=prompt_context,
                scorer_context=scorer_context,
                candidate_runner=candidate_runner,
                scorer_runner=scorer_runner,
                budget=budget,
                evaluation_cache=evaluation_cache,
                num_threads=num_threads_plan.resolved,
            )
        except ScorerContractError:
            raise
        except CandidateRunnerError as error:
            # ALI-1158 review (codex round 3): a candidate-runner crash during
            # the seed pass is NOT a scorer-contract problem — do not send the
            # user to the scorer. Same structured-event discipline, accurate
            # source.
            message = (
                "Seed validation failed at optimization launch: the CANDIDATE "
                f"runner raised while generating the seed output: {error}. Fix "
                "the candidate runner (--candidate-runner-dir / its registered "
                "version); the scorer input contract is not implicated."
            )
            event_sink.log_event(
                "seed_validation_failed",
                {
                    "source": "candidate_runner",
                    "message": message,
                    "error": str(error)[:500],
                },
                event_layer="extension",
                candidate_id="seed",
            )
            raise RuntimeError(message) from error
        except Exception as error:
            # ALI-1158: the seed evaluation doubles as the launch-time scorer
            # contract probe — a scorer that crashes or returns nothing
            # parseable while scoring the seed is a harness bug, so surface
            # the contract diagnosis instead of a bare parse error. Any
            # Exception counts (codex round 4): a scorer subprocess that
            # exits without output.json or a missing executable raises
            # FileNotFoundError/OSError, and candidate-side raises were
            # already tagged CandidateRunnerError above — everything reaching
            # this branch is scorer-side seed-probe failure.
            message = (
                "Scorer contract validation failed at optimization launch: "
                f"scoring the seed candidate failed with: {error}. "
                + SCORER_CONTRACT_GUIDANCE
            )
            # ALI-1158 review (codex): crash/unparseable refusals must leave
            # the same structured event the degenerate-seed path does — the
            # outer generic run_failed alone loses the diagnosis.
            event_sink.log_event(
                "scorer_contract_check_failed",
                {
                    "reason": "seed evaluation crashed or returned unparseable scorer output",
                    "message": message,
                    "error": str(error)[:500],
                    "scorer_version_id": scorer_version_id,
                    "decision_rule": (
                        "a scorer that crashes or returns nothing parseable "
                        "while scoring the seed is a harness/contract bug"
                    ),
                },
                event_layer="extension",
                candidate_id="seed",
            )
            raise ScorerContractError(message) from error
        if local_logger is not None:
            local_logger.append_evaluations(
                stage="seed_val_set",
                split="validation",
                iteration=None,
                candidate_id="seed",
                results=seed_results,
            )
        if not _completed_all_rows(seed_results, valset):
            raise RuntimeError("Seed validation did not complete all requested rows")
        budget.used_full_evals += 1
        seed_score = _mean(seed_results)
        val_scores_by_candidate["seed"] = {result.row_id: result.score for result in seed_results}
        event_sink.log_event(
            "seed_val_set_completed",
            _results_payload(
                candidate_id="seed",
                split="validation",
                results=seed_results,
                log_row_snapshots=config.log_row_snapshots,
                scorer_version_id=scorer_version_id,
                metric_key=metric_key,
                scorer_role="selection",
            ),
            event_layer="extension",
            candidate_id="seed",
        )

        # ALI-1158: refuse to iterate on a degenerate seed (uniform worst
        # score or all-errored rows) unless explicitly allowed — it is almost
        # always a scorer-runner contract mismatch silently zeroing every
        # candidate, and it gives GEPA no gradient either way.
        degeneracy_reason = _seed_degeneracy_reason(seed_results, higher_is_better)
        if degeneracy_reason is not None and not config.allow_degenerate_seed:
            message = _seed_degeneracy_message(degeneracy_reason, seed_results)
            payload = {
                "reason": degeneracy_reason,
                "message": message,
                "seed_score_mean": seed_score,
                "row_count": len(seed_results),
                "errored_row_count": sum(1 for result in seed_results if result.error),
                "higher_is_better": higher_is_better,
                "scorer_version_id": scorer_version_id,
                "decision_rule": (
                    "a seed that scores the worst possible value on every "
                    "validation row (or errors on every row) is treated as "
                    "a harness/contract bug unless --allow-degenerate-seed"
                ),
            }
            # ALI-1158 review (codex round 4): when the degeneracy is
            # candidate-side, the EVENT TYPE and EXCEPTION CLASS must not
            # blame the scorer either — dashboards/automation key off those,
            # not the message text.
            if "CANDIDATE runner" in degeneracy_reason:
                event_sink.log_event(
                    "seed_validation_failed",
                    {**payload, "source": "candidate_runner"},
                    event_layer="extension",
                    candidate_id="seed",
                )
                raise RuntimeError(message)
            event_sink.log_event(
                "scorer_contract_check_failed",
                payload,
                event_layer="extension",
                candidate_id="seed",
            )
            raise ScorerContractError(message)

        best_candidate_id, best_score, pareto = _pareto_payload(
            val_scores_by_candidate,
            candidate_text_by_id,
            higher_is_better,
        )
        event_sink.log_event(
            "pareto_front_updated",
            pareto,
            event_layer="extension",
            candidate_id=best_candidate_id,
        )
        event_sink.log_event("budget_updated", budget.to_payload(), event_layer="extension")
        if not budget.allows_iteration():
            event_sink.log_event(
                "budget_exhausted",
                {
                    "stage": "seed_val_set_completed",
                    "requested_rows": len(valset),
                    "completed_rows": len(seed_results),
                    "budget": budget.to_payload(),
                    "decision_rule": "budget is checked only after completing seed validation or a full iteration",
                },
                event_layer="extension",
                candidate_id="seed",
            )
            budget_exhausted = True

        iteration = 1
        while config.max_iterations is None or iteration <= config.max_iterations:
            if not budget.allows_iteration():
                break

            parent_candidate_id = _select_parent_candidate_id(
                val_scores_by_candidate=val_scores_by_candidate,
                best_candidate_id=best_candidate_id,
                config=config,
                iteration=iteration,
                higher_is_better=higher_is_better,
            )
            parent_text = candidate_text_by_id[parent_candidate_id]
            parent_val_score = _aggregate_scores(val_scores_by_candidate).get(parent_candidate_id)
            minibatch = _sample_minibatch(trainset, iteration, config)

            event_sink.log_event(
                "iteration_started",
                {
                    "parent_candidate_id": parent_candidate_id,
                    "parent_val_score": parent_val_score,
                    "best_candidate_id": best_candidate_id,
                    "best_val_score": best_score,
                    "row_ids": [row.id for row in minibatch],
                    "budget": budget.to_payload(),
                    "minibatch_size": config.minibatch_size,
                    "candidate_selection_strategy": config.candidate_selection_strategy,
                },
                iteration=iteration,
                candidate_id=parent_candidate_id,
            )
            event_sink.log_event(
                "parent_candidate_selected",
                _parent_selection_payload(
                    val_scores_by_candidate=val_scores_by_candidate,
                    selected_candidate_id=parent_candidate_id,
                    best_candidate_id=best_candidate_id,
                    config=config,
                    higher_is_better=higher_is_better,
                ),
                event_layer="extension",
                iteration=iteration,
                candidate_id=parent_candidate_id,
            )
            event_sink.log_event(
                "parent_minibatch_started",
                {"row_ids": [row.id for row in minibatch]},
                event_layer="extension",
                iteration=iteration,
                candidate_id=parent_candidate_id,
            )
            parent_results = evaluate_candidate(
                candidate_text=parent_text,
                candidate_id=parent_candidate_id,
                rows=minibatch,
                split="train",
                prompt_context=prompt_context,
                scorer_context=scorer_context,
                candidate_runner=candidate_runner,
                scorer_runner=scorer_runner,
                budget=budget,
                evaluation_cache=evaluation_cache,
                num_threads=num_threads_plan.resolved,
            )
            if local_logger is not None:
                local_logger.append_evaluations(
                    stage="parent_minibatch",
                    split="train",
                    iteration=iteration,
                    candidate_id=parent_candidate_id,
                    results=parent_results,
                )
            if not _completed_all_rows(parent_results, minibatch):
                event_sink.log_event(
                    "budget_exhausted",
                    {
                        "stage": "parent_minibatch",
                        "requested_rows": len(minibatch),
                        "completed_rows": len(parent_results),
                        "budget": budget.to_payload(),
                    },
                    event_layer="extension",
                    iteration=iteration,
                    candidate_id=parent_candidate_id,
                )
                budget_exhausted = True
                break
            parent_total = _total(parent_results)
            event_sink.log_event(
                "parent_minibatch_completed",
                _results_payload(
                    candidate_id=parent_candidate_id,
                    split="train",
                    results=parent_results,
                    log_row_snapshots=config.log_row_snapshots,
                    scorer_version_id=scorer_version_id,
                    metric_key=metric_key,
                    scorer_role="reflection",
                ),
                event_layer="extension",
                iteration=iteration,
                candidate_id=parent_candidate_id,
            )

            parent_is_perfect = _is_perfect_minibatch(parent_results, higher_is_better)
            if config.skip_perfect_parent_reflection and parent_is_perfect:
                event_sink.log_event(
                    "reflection_skipped",
                    {
                        "reason": "parent_minibatch_perfect",
                        "parent_candidate_id": parent_candidate_id,
                        "parent_score_total": parent_total,
                        "parent_score_mean": _mean(parent_results),
                        "row_ids": [row.id for row in minibatch],
                        "higher_is_better": higher_is_better,
                        "decision_rule": "skip reflection when every parent minibatch row is already perfect",
                    },
                    event_layer="extension",
                    iteration=iteration,
                    candidate_id=parent_candidate_id,
                )
                budget.used_iterations += 1
                event_sink.log_event("budget_updated", budget.to_payload(), event_layer="extension", iteration=iteration)
                event_sink.log_event(
                    "iteration_completed",
                    {
                        "parent_candidate_id": parent_candidate_id,
                        "child_candidate_id": None,
                        "parent_train_score_total": parent_total,
                        "child_train_score_total": None,
                        "child_validation_score": None,
                        "best_candidate_id": best_candidate_id,
                        "best_validation_score": best_score,
                        "skipped_reflection": True,
                        "skip_reason": "parent_minibatch_perfect",
                        "budget": budget.to_payload(),
                    },
                    iteration=iteration,
                    candidate_id=best_candidate_id,
                )
                _log_iteration_progress(
                    event_sink,
                    budget=budget,
                    iteration=iteration,
                    candidate_id=best_candidate_id,
                )
                if _has_future_iteration(config, iteration) and not budget.allows_iteration():
                    event_sink.log_event(
                        "budget_exhausted",
                        {
                            "stage": "iteration_completed",
                            "completed_iteration": iteration,
                            "budget": budget.to_payload(),
                            "decision_rule": "budget is checked only between iterations",
                        },
                        event_layer="extension",
                        iteration=iteration,
                        candidate_id=best_candidate_id,
                    )
                    budget_exhausted = True
                    break
                iteration += 1
                continue

            event_sink.log_event(
                "reflection_started",
                {
                    "parent_candidate_id": parent_candidate_id,
                    "row_ids": [row.id for row in minibatch],
                    "objective": config.objective,
                },
                event_layer="extension",
                iteration=iteration,
                candidate_id=parent_candidate_id,
            )
            try:
                reflection = reflector(parent_text, parent_results, config)
            except RetryableReflectionError as error:
                failed_reflection_count += 1
                budget.used_candidate_proposals += 1
                budget.used_iterations += 1
                budget.charge_retryable_reflection_failure()
                event_sink.log_event(
                    "reflection_failed",
                    {
                        "parent_candidate_id": parent_candidate_id,
                        "row_ids": [row.id for row in minibatch],
                        "error": str(error),
                        "error_type": type(error).__name__,
                        "budget": budget.to_payload(),
                    },
                    event_layer="extension",
                    iteration=iteration,
                    candidate_id=parent_candidate_id,
                )
                event_sink.log_event("budget_updated", budget.to_payload(), event_layer="extension", iteration=iteration)
                event_sink.log_event(
                    "iteration_completed",
                    {
                        "parent_candidate_id": parent_candidate_id,
                        "child_candidate_id": None,
                        "parent_train_score_total": parent_total,
                        "child_train_score_total": None,
                        "child_validation_score": None,
                        "best_candidate_id": best_candidate_id,
                        "best_validation_score": best_score,
                        "reflection_failed": True,
                        "reflection_error": str(error),
                        "reflection_error_type": type(error).__name__,
                        "budget": budget.to_payload(),
                    },
                    iteration=iteration,
                    candidate_id=best_candidate_id,
                )
                _log_iteration_progress(
                    event_sink,
                    budget=budget,
                    iteration=iteration,
                    candidate_id=best_candidate_id,
                )
                if _has_future_iteration(config, iteration) and not budget.allows_iteration():
                    event_sink.log_event(
                        "budget_exhausted",
                        {
                            "stage": "iteration_completed",
                            "completed_iteration": iteration,
                            "budget": budget.to_payload(),
                            "decision_rule": "budget is checked only between iterations",
                        },
                        event_layer="extension",
                        iteration=iteration,
                        candidate_id=best_candidate_id,
                    )
                    budget_exhausted = True
                    break
                iteration += 1
                continue
            child_id = _candidate_id(iteration, reflection.candidate_text)
            child_text = reflection.candidate_text
            candidate_text_by_id[child_id] = child_text
            budget.used_candidate_proposals += 1
            if local_logger is not None:
                local_logger.append_reflection(
                    iteration=iteration,
                    parent_candidate_id=parent_candidate_id,
                    child_candidate_id=child_id,
                    row_ids=[row.id for row in minibatch],
                    prompt=reflection.prompt,
                    response=reflection.response,
                    candidate_text=reflection.candidate_text,
                )
            event_sink.log_event(
                "reflection_completed",
                {
                    **_text_log_fields("prompt", reflection.prompt, include_text=config.log_row_snapshots),
                    "response": reflection.response,
                    "child_candidate_id": child_id,
                    "candidate_text": child_text,
                },
                event_layer="extension",
                iteration=iteration,
                candidate_id=parent_candidate_id,
                child_candidate_id=child_id,
            )
            event_sink.log_event(
                "child_candidate_created",
                {
                    "candidate_text": child_text,
                    "candidate_preview": child_text[:1200],
                },
                event_layer="extension",
                iteration=iteration,
                candidate_id=child_id,
                parent_candidate_id=parent_candidate_id,
            )
            event_sink.log_event(
                "candidate_proposed",
                {
                    "body_kind": "text",
                    "prompt_body": child_text,
                    "source": "reflection",
                },
                iteration=iteration,
                candidate_id=child_id,
                parent_candidate_id=parent_candidate_id,
            )

            event_sink.log_event(
                "child_minibatch_started",
                {"row_ids": [row.id for row in minibatch]},
                event_layer="extension",
                iteration=iteration,
                candidate_id=child_id,
                parent_candidate_id=parent_candidate_id,
            )
            child_results = evaluate_candidate(
                candidate_text=child_text,
                candidate_id=child_id,
                rows=minibatch,
                split="train",
                prompt_context=prompt_context,
                scorer_context=scorer_context,
                candidate_runner=candidate_runner,
                scorer_runner=scorer_runner,
                budget=budget,
                evaluation_cache=evaluation_cache,
                num_threads=num_threads_plan.resolved,
            )
            if local_logger is not None:
                local_logger.append_evaluations(
                    stage="child_minibatch",
                    split="train",
                    iteration=iteration,
                    candidate_id=child_id,
                    parent_candidate_id=parent_candidate_id,
                    results=child_results,
                )
            if not _completed_all_rows(child_results, minibatch):
                event_sink.log_event(
                    "budget_exhausted",
                    {
                        "stage": "child_minibatch",
                        "requested_rows": len(minibatch),
                        "completed_rows": len(child_results),
                        "budget": budget.to_payload(),
                    },
                    event_layer="extension",
                    iteration=iteration,
                    candidate_id=child_id,
                    parent_candidate_id=parent_candidate_id,
                )
                budget_exhausted = True
                break
            child_total = _total(child_results)
            event_sink.log_event(
                "child_minibatch_completed",
                _results_payload(
                    candidate_id=child_id,
                    split="train",
                    results=child_results,
                    log_row_snapshots=config.log_row_snapshots,
                    scorer_version_id=scorer_version_id,
                    metric_key=metric_key,
                    scorer_role="reflection",
                ),
                event_layer="extension",
                iteration=iteration,
                candidate_id=child_id,
                parent_candidate_id=parent_candidate_id,
            )

            proceed_to_full_eval = _is_better(child_total, parent_total, higher_is_better)
            event_sink.log_event(
                "acceptance_decision_made",
                {
                    "accepted": proceed_to_full_eval,
                    "proceed_to_full_eval": proceed_to_full_eval,
                    "parent_score_total": parent_total,
                    "child_score_total": child_total,
                    "higher_is_better": higher_is_better,
                    "decision_rule": "child minibatch total must beat parent minibatch total using the scorer direction",
                },
                event_layer="extension",
                iteration=iteration,
                candidate_id=child_id,
                parent_candidate_id=parent_candidate_id,
            )

            child_val_score = None
            if proceed_to_full_eval:
                event_sink.log_event(
                    "child_val_set_started",
                    {"row_ids": [row.id for row in valset]},
                    event_layer="extension",
                    iteration=iteration,
                    candidate_id=child_id,
                    parent_candidate_id=parent_candidate_id,
                )
                child_val_results = evaluate_candidate(
                    candidate_text=child_text,
                    candidate_id=child_id,
                    rows=valset,
                    split="validation",
                    prompt_context=prompt_context,
                    scorer_context=scorer_context,
                    candidate_runner=candidate_runner,
                    scorer_runner=scorer_runner,
                    budget=budget,
                    evaluation_cache=evaluation_cache,
                    num_threads=num_threads_plan.resolved,
                )
                if local_logger is not None:
                    local_logger.append_evaluations(
                        stage="child_val_set",
                        split="validation",
                        iteration=iteration,
                        candidate_id=child_id,
                        parent_candidate_id=parent_candidate_id,
                        results=child_val_results,
                    )
                if not _completed_all_rows(child_val_results, valset):
                    event_sink.log_event(
                        "budget_exhausted",
                        {
                            "stage": "child_val_set",
                            "requested_rows": len(valset),
                            "completed_rows": len(child_val_results),
                            "budget": budget.to_payload(),
                        },
                        event_layer="extension",
                        iteration=iteration,
                        candidate_id=child_id,
                        parent_candidate_id=parent_candidate_id,
                    )
                    budget_exhausted = True
                    break
                budget.used_full_evals += 1
                child_val_score = _mean(child_val_results)
                val_scores_by_candidate[child_id] = {
                    result.row_id: result.score for result in child_val_results
                }
                event_sink.log_event(
                    "child_val_set_completed",
                    _results_payload(
                        candidate_id=child_id,
                        split="validation",
                        results=child_val_results,
                        log_row_snapshots=config.log_row_snapshots,
                        scorer_version_id=scorer_version_id,
                        metric_key=metric_key,
                        scorer_role="selection",
                    ),
                    event_layer="extension",
                    iteration=iteration,
                    candidate_id=child_id,
                    parent_candidate_id=parent_candidate_id,
                )
                event_sink.log_event(
                    "candidate_scored",
                    {
                        "split": "validation",
                        "score": child_val_score,
                        "score_value": child_val_score,
                        "scorer_version_id": scorer_version_id,
                        "metric_key": metric_key,
                        "scorer_role": "selection",
                        "higher_is_better": higher_is_better,
                        "baseline_score": seed_score,
                        "delta": child_val_score - seed_score,
                        "per_row_scores": [
                            _evaluation_payload(result, include_row=config.log_row_snapshots)
                            for result in child_val_results
                        ],
                    },
                    iteration=iteration,
                    candidate_id=child_id,
                    parent_candidate_id=parent_candidate_id,
                )

                best_candidate_id, best_score, pareto = _pareto_payload(
                    val_scores_by_candidate,
                    candidate_text_by_id,
                    higher_is_better,
                )
                event_sink.log_event(
                    "pareto_front_updated",
                    pareto,
                    event_layer="extension",
                    iteration=iteration,
                    candidate_id=best_candidate_id,
                )
                if best_candidate_id == child_id:
                    improvement = (best_score - seed_score) if higher_is_better else (seed_score - best_score)
                    event_sink.log_event(
                        "candidate_recommended",
                        {
                            "score": best_score,
                            "delta": best_score - seed_score,
                            "improvement": improvement,
                            "higher_is_better": higher_is_better,
                        },
                        iteration=iteration,
                        candidate_id=child_id,
                    )
            else:
                event_sink.log_event(
                    "candidate_rejected",
                    {
                        "reason": "child minibatch total did not beat parent",
                        "parent_score_total": parent_total,
                        "child_score_total": child_total,
                        "higher_is_better": higher_is_better,
                    },
                    iteration=iteration,
                    candidate_id=child_id,
                    parent_candidate_id=parent_candidate_id,
                )

            budget.used_iterations += 1
            event_sink.log_event("budget_updated", budget.to_payload(), event_layer="extension", iteration=iteration)
            event_sink.log_event(
                "iteration_completed",
                {
                    "parent_candidate_id": parent_candidate_id,
                    "child_candidate_id": child_id,
                    "parent_train_score_total": parent_total,
                    "child_train_score_total": child_total,
                    "child_validation_score": child_val_score,
                    "best_candidate_id": best_candidate_id,
                    "best_validation_score": best_score,
                    "budget": budget.to_payload(),
                },
                iteration=iteration,
                candidate_id=best_candidate_id,
            )
            _log_iteration_progress(
                event_sink,
                budget=budget,
                iteration=iteration,
                candidate_id=best_candidate_id,
            )
            if _has_future_iteration(config, iteration) and not budget.allows_iteration():
                event_sink.log_event(
                    "budget_exhausted",
                    {
                        "stage": "iteration_completed",
                        "completed_iteration": iteration,
                        "budget": budget.to_payload(),
                        "decision_rule": "budget is checked only between iterations",
                    },
                    event_layer="extension",
                    iteration=iteration,
                    candidate_id=best_candidate_id,
                )
                budget_exhausted = True
                break
            iteration += 1

        if budget_exhausted:
            event_sink.log_event(
                "run_paused",
                {
                    "reason": "budget_exhausted",
                    "best_candidate_id": best_candidate_id,
                    "best_validation_score": best_score,
                    "seed_validation_score": seed_score,
                    "higher_is_better": higher_is_better,
                    "budget": budget.to_payload(),
                    "failed_reflection_count": failed_reflection_count,
                },
            )
            event_sink.finish_run(
                status="paused",
                best_score=best_score,
                best_candidate_id=best_candidate_id,
                metadata={
                    "seed_score": seed_score,
                    "budget": budget.to_payload(),
                    "pause_reason": "budget_exhausted",
                    "failed_reflection_count": failed_reflection_count,
                },
            )
            return TextGepaResult(
                run_id=run_id,
                best_candidate_id=best_candidate_id,
                best_candidate_text=candidate_text_by_id[best_candidate_id],
                best_score=best_score,
                seed_score=seed_score,
                promoted_prompt_version_id=promoted_prompt_version_id,
                budget=budget,
            )

        if config.auto_promote and best_candidate_id != "seed":
            if not prompt_context.prompt_id:
                raise RuntimeError("Cannot auto-promote without prompt_id in prompt context")
            promoted_prompt_version_id = event_sink.promote_candidate(
                candidate_id=best_candidate_id,
                prompt_id=prompt_context.prompt_id,
                parent_prompt_version_id=prompt_context.prompt_version_id,
                body=candidate_text_by_id[best_candidate_id],
                body_kind=prompt_context.body_kind,
                provider_settings=prompt_context.provider_settings,
                runner_version_id=prompt_context.runner_version_id,
                label=config.promotion_label,
            )

        event_sink.log_event(
            "run_completed",
            {
                "final_prompt_version_id": promoted_prompt_version_id,
                "best_candidate_id": best_candidate_id,
                "best_validation_score": best_score,
                "seed_validation_score": seed_score,
                "delta": best_score - seed_score,
                "improvement": (best_score - seed_score) if higher_is_better else (seed_score - best_score),
                "metric_key": metric_key,
                "higher_is_better": higher_is_better,
                "budget": budget.to_payload(),
                "failed_reflection_count": failed_reflection_count,
            },
        )
        event_sink.finish_run(
            status="succeeded",
            best_score=best_score,
            best_candidate_id=best_candidate_id,
            result_prompt_version_id=promoted_prompt_version_id,
            metadata={
                "seed_score": seed_score,
                "metric_key": metric_key,
                "higher_is_better": higher_is_better,
                "budget": budget.to_payload(),
                "failed_reflection_count": failed_reflection_count,
            },
        )
        return TextGepaResult(
            run_id=run_id,
            best_candidate_id=best_candidate_id,
            best_candidate_text=candidate_text_by_id[best_candidate_id],
            best_score=best_score,
            seed_score=seed_score,
            promoted_prompt_version_id=promoted_prompt_version_id,
            budget=budget,
        )
    except Exception as exc:
        try:
            event_sink.log_event("run_failed", {"error": str(exc)})
        except Exception:
            pass
        try:
            event_sink.finish_run(status="failed", metadata={"error": str(exc)})
        except Exception:
            pass
        raise


def build_reflection_prompt(parent_text: str, parent_results: list[RowEvaluation], config: TextGepaConfig) -> str:
    examples = []
    for result in parent_results:
        if result.feedback is None or not result.feedback.strip():
            raise ValueError(
                f"Scorer feedback is required for reflection row {result.row_id}"
            )
        examples.append({
            "row_id": result.row_id,
            "score": result.score,
            "feedback": result.feedback,
            "error": result.error,
        })
    examples_text = json.dumps({
        "objective": config.objective,
        "examples": examples,
    }, ensure_ascii=False, indent=2)
    template = config.reflection_prompt_template or DEFAULT_REFLECTION_PROMPT_TEMPLATE
    if "<current_candidate>" in template and "<evaluation_data>" in template:
        return (
            template
            .replace("<current_candidate>", parent_text)
            .replace("<evaluation_data>", examples_text)
        )
    if "<curr_instructions>" in template and "<inputs_outputs_feedback>" in template:
        return (
            template
            .replace("<curr_instructions>", parent_text)
            .replace("<inputs_outputs_feedback>", examples_text)
        )
    raise ValueError(
        "reflection_prompt_template must include either "
        "<current_candidate>/<evaluation_data> or "
        "<curr_instructions>/<inputs_outputs_feedback>"
    )


def extract_candidate_text(response: str) -> str:
    return response.strip()


optimize_text_candidate = optimize_loaded_text_candidate
