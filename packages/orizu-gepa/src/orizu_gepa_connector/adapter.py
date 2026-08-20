"""Official GEPA adapter backed by Orizu's existing runner subprocess contract."""

from __future__ import annotations

from typing import Any

from gepa.core.adapter import EvaluationBatch

# Import the frozen contract rather than duplicating subprocess/env handling.
from orizu_gepa.optimizer import Budget, RowEvaluation, evaluate_candidate, resolve_num_threads
from orizu_gepa.runner import make_candidate_runner, make_scorer_runner


class ScorerContractError(RuntimeError):
    """The scorer runner returned a shape the frozen scorer contract rejects."""


class RunnerEvaluationAdapter:
    """GEPAAdapter implementation with per-row Orizu side information."""

    # GEPA 0.1.4 reads this optional protocol member directly. ``None`` hands
    # proposal generation to its ReflectionLM, which is our frozen provider
    # bridge supplied by ``run_official_gepa``.
    propose_new_texts = None

    def __init__(
        self,
        *,
        candidate_runner_dir: str,
        scorer_runner_dir: str,
        run_id: str | None,
        prompt_context: Any,
        scorer_context: Any,
        scorer_input_contract: str | None = None,
        scorer_candidate_field: str | None = None,
        num_threads: int | str = "auto",
        minibatch_size: int | None = None,
        validation_count: int = 0,
    ):
        self.prompt_context = prompt_context
        self.scorer_context = scorer_context
        self.scorer_runner_dir = scorer_runner_dir
        self.candidate_runner = make_candidate_runner(candidate_runner_dir, run_id)
        self.scorer_runner = make_scorer_runner(
            scorer_runner_dir,
            run_id,
            input_contract=scorer_input_contract,
            candidate_field=scorer_candidate_field,
        )
        # Use the frozen memory-/CPU-/FD-bounded plan; the adapter only
        # supplies official GEPA's EvaluationBatch boundary around it.
        self.num_threads_plan = resolve_num_threads(
            num_threads,
            minibatch_size=minibatch_size or 1,
            validation_count=validation_count,
        )
        self.metric_calls_used = 0
        self.last_row_evaluations: list[RowEvaluation] = []
        self.last_candidate: dict[str, str] | None = None

    def evaluate(self, batch: list[Any], candidate: dict[str, str], capture_traces: bool = False) -> EvaluationBatch:
        component = next(iter(candidate))
        candidate_text = candidate[component]
        outputs: list[dict[str, Any]] = []
        scores: list[float] = []
        trajectories: list[dict[str, Any]] = []
        for row in batch:
            if not hasattr(row, "id"):
                raise TypeError("RunnerEvaluationAdapter requires legacy DatasetRow inputs")
        # The frozen evaluator owns both scorer extraction and bounded worker
        # scheduling. In particular, ``score_from_scorer`` preserves the
        # model_response.feedback/reasoning fallback used by legacy runs.
        budget = Budget("max_metric_calls", max(1, len(batch)))
        try:
            row_evaluations = evaluate_candidate(
                candidate_text=candidate_text,
                candidate_id=component,
                rows=batch,
                split="official_gepa",
                prompt_context=self.prompt_context,
                scorer_context=self.scorer_context,
                candidate_runner=self.candidate_runner,
                scorer_runner=self.scorer_runner,
                budget=budget,
                num_threads=self.num_threads_plan.resolved,
            )
        except ValueError as error:
            if str(error).startswith("Scorer result"):
                raise ScorerContractError(
                    "scorer contract failure for "
                    f"{self.scorer_runner_dir}: {error}"
                ) from error
            raise

        self.metric_calls_used += budget.used_metric_calls
        for evaluation in row_evaluations:
            raw_score = evaluation.score
            # Official GEPA maximizes. Preserve the legacy scorer direction by
            # normalizing lower-is-better metrics before they enter its state.
            score = raw_score if self.scorer_context.higher_is_better else 1.0 - raw_score
            scores.append(score)
            outputs.append({
                "row_id": evaluation.row_id,
                "output": evaluation.output,
                "raw_score": raw_score,
                "feedback": evaluation.feedback,
                "error": evaluation.error,
                "error_source": evaluation.error_source,
                "scorer_output": evaluation.scorer_response,
                "scorer_error": evaluation.error if evaluation.error_source == "scorer" else None,
                "cached": evaluation.cached,
                "latency_ms": evaluation.latency_ms,
                "token_in": evaluation.token_in,
                "token_out": evaluation.token_out,
                "cost_usd": evaluation.cost_usd,
            })
            if capture_traces:
                trajectories.append({
                    "row_id": evaluation.row_id,
                    "Feedback": evaluation.feedback,
                    "error": evaluation.error,
                    "output": evaluation.output,
                })
        self.last_row_evaluations = row_evaluations
        self.last_candidate = dict(candidate)
        return EvaluationBatch(outputs=outputs, scores=scores, trajectories=trajectories if capture_traces else None,
                               num_metric_calls=len(batch))

    def make_reflective_dataset(self, candidate: dict[str, str], evaluation: EvaluationBatch,
                                components_to_update: list[str]) -> dict[str, list[dict[str, Any]]]:
        return {component: [{"Feedback": trace.get("Feedback"), "Generated Outputs": trace.get("output")}
                            for trace in (evaluation.trajectories or [])] for component in components_to_update}
