from __future__ import annotations

import dataclasses
import hashlib
import json
import math
import random
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol


DEFAULT_REFLECTION_PROMPT_TEMPLATE = """I am optimizing a text parameter in my system.

The current parameter value is:
```
<current_candidate>
```

Below is evaluation data showing how this parameter value performed across multiple test cases. The data contains performance metrics, model outputs, judge feedback, and any relevant diagnostic information from the evaluation:
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
            "cached": self.cached,
        }


@dataclass(frozen=True)
class ReflectionResult:
    prompt: str
    response: str
    candidate_text: str


@dataclass
class Budget:
    budget_kind: str
    limit: int
    used_metric_calls: int = 0
    used_full_evals: int = 0
    used_candidate_proposals: int = 0

    @classmethod
    def from_config(cls, config: "TextGepaConfig") -> "Budget":
        if config.max_metric_calls is not None:
            return cls("max_metric_calls", config.max_metric_calls)
        if config.max_full_evals is not None:
            return cls("max_full_evals", config.max_full_evals)
        if config.max_candidate_proposals is not None:
            return cls("max_candidate_proposals", config.max_candidate_proposals)
        preset_metric_calls = {
            "auto": 64,
            "light": 48,
            "medium": 96,
            "high": 192,
        }.get(config.budget, 48)
        return cls("max_metric_calls", preset_metric_calls)

    @property
    def used(self) -> int:
        if self.budget_kind == "max_full_evals":
            return self.used_full_evals
        if self.budget_kind == "max_candidate_proposals":
            return self.used_candidate_proposals
        return self.used_metric_calls

    @property
    def remaining(self) -> int:
        return max(0, self.limit - self.used)

    def allows_iteration(self) -> bool:
        return self.remaining > 0

    def allows_metric_call(self) -> bool:
        return self.budget_kind != "max_metric_calls" or self.remaining > 0

    def to_payload(self) -> dict[str, Any]:
        return {
            "budget_kind": self.budget_kind,
            "limit": self.limit,
            "used": self.used,
            "remaining": self.remaining,
            "used_metric_calls": self.used_metric_calls,
            "used_full_evals": self.used_full_evals,
            "used_candidate_proposals": self.used_candidate_proposals,
        }


@dataclass(frozen=True)
class TextGepaConfig:
    budget: str = "light"
    max_iterations: int = 3
    minibatch_size: int = 3
    candidate_selection_strategy: str = "pareto"
    epsilon: float = 0.1
    max_metric_calls: int | None = None
    max_full_evals: int | None = None
    max_candidate_proposals: int | None = None
    reflection_model: str = "anthropic/claude-opus-4-7"
    reflection_temperature: float | None = None
    reflection_max_tokens: int | None = None
    reflection_prompt_template: str | None = None
    reflection_provider_settings: dict[str, Any] = field(default_factory=dict)
    objective: str = "Improve this text candidate to maximize evaluator score while preserving intended behavior."
    seed: int = 0
    auto_promote: bool = False
    promotion_label: str | None = None
    fail_on_log_error: bool = True
    log_row_snapshots: bool = False
    cache_evaluations: bool = True


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


def _is_better(challenger: float, incumbent: float, higher_is_better: bool) -> bool:
    return challenger > incumbent if higher_is_better else challenger < incumbent


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
) -> list[RowEvaluation]:
    evaluations: list[RowEvaluation] = []
    for row in rows:
        if not budget.allows_metric_call():
            break

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
                evaluations.append(cached)
                continue

        started = time.time()
        candidate_result = candidate_runner(candidate_text, row, prompt_context, candidate_id)
        scorer_result = scorer_runner(row, candidate_result, scorer_context, candidate_id)
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
        )
        evaluations.append(evaluation)
        if evaluation_cache is not None and cache_key is not None:
            evaluation_cache.set(cache_key, evaluation)
        budget.used_metric_calls += 1
    return evaluations


def _completed_all_rows(results: list[RowEvaluation], rows: list[DatasetRow]) -> bool:
    return len(results) == len(rows)


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
    budget = Budget.from_config(config)
    evaluation_cache = EvaluationCache() if config.cache_evaluations else None
    candidate_text_by_id = {"seed": seed_text}
    val_scores_by_candidate: dict[str, dict[str, float]] = {}
    promoted_prompt_version_id: str | None = None
    scorer_version_id = _scorer_version_id(scorer_context)
    metric_key = _metric_key(scorer_context)
    higher_is_better = scorer_context.higher_is_better
    budget_exhausted = False

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
            "budget": budget.to_payload(),
        })

        event_sink.log_event(
            "seed_val_set_started",
            {"row_ids": [row.id for row in valset]},
            event_layer="extension",
            candidate_id="seed",
        )
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
        )
        if local_logger is not None:
            local_logger.append_evaluations(
                stage="seed_val_set",
                split="validation",
                iteration=None,
                candidate_id="seed",
                results=seed_results,
            )
        if not _completed_all_rows(seed_results, valset):
            raise RuntimeError("Budget exhausted before seed validation completed")
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

        for iteration in range(1, config.max_iterations + 1):
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
            reflection = reflector(parent_text, parent_results, config)
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
        examples.append({
            "row_id": result.row_id,
            "input": result.row,
            "output": result.output,
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
