"""Production lifecycle for an official-GEPA optimization run."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any
from uuid import uuid4

# Deliberately import—not copy—the frozen M1 transport, local artifacts, and
# runner contract. The connector owns only the official-GEPA adaptation.
from orizu_gepa.client import OrizuClient, OrizuEventSink
from orizu_gepa.local_log import LocalOptimizationLogger
from orizu_gepa.optimizer import TextGepaConfig, TextGepaResult
from orizu_gepa.runner import resolve_scorer_input_contract

from .adapter import RunnerEvaluationAdapter, ScorerContractError
from .callbacks import LifecycleHooks, OrizuCallback
from .engine import SeedValidationRefused, run_official_gepa, validate_seed_before_run
from .reflection import make_gepa_reflection_lm
from .stop_conditions import (
    IterationBoundaryStopper,
    MandatoryLoggingStopper,
    MaxCandidateProposalsStopper,
)


class MandatoryEventSink:
    """Write locally before POSTing; a failed POST makes the run fail honestly."""

    def __init__(self, client: OrizuClient, run_id: str, local_logger: LocalOptimizationLogger | None):
        self.client = client
        self.run_id = run_id
        self.local_logger = local_logger
        # Connector events occupy odd slots. A promotion/status system event
        # written by the server can take the even slot between any two GEPA
        # callbacks without colliding with the next local event.
        self.sequence = -1
        self.failed = False
        self._failed_status_reason: str | None = None
        # Reuse the frozen sink's measured retry/backoff policy.  It owns the
        # local-first write and three total POST attempts; this adapter only
        # reserves the even server sequence slot for a live promotion.
        self._retry_sink = OrizuEventSink(
            client,
            run_id,
            fail_on_log_error=True,
            max_log_retries=2,
            local_logger=local_logger,
        )

    def emit(self, event_type: str, payload: dict[str, Any], *, iteration: int | None = None,
             candidate_id: str | None = None, parent_candidate_id: str | None = None) -> None:
        next_sequence = self.sequence + 2
        self._retry_sink.sequence = next_sequence - 1
        try:
            self._retry_sink.log_event(
                event_type,
                payload,
                event_layer="core",
                optimizer_family="gepa",
                iteration=iteration,
                candidate_id=candidate_id,
                parent_candidate_id=parent_candidate_id,
            )
            self.sequence = next_sequence
        except Exception as error:
            self.sequence = next_sequence
            self.failed = True
            self._failed_status_reason = f"API logging failed: {error}"
            # ``OrizuEventSink.log_event`` has already written this exact
            # event locally before it attempted the POST. Do not duplicate its
            # sequence record on the failure path.
            self._record_failed_status()
            raise

    def _record_failed_status(self) -> None:
        if self._failed_status_reason is None:
            return
        try:
            self.client.update_run(
                self.run_id,
                status="failed",
                metadata={"failure_reason": self._failed_status_reason},
            )
        except Exception:
            # Keep the reason for the one later retry at the terminal boundary.
            return
        self._failed_status_reason = None

    def retry_failed_status(self) -> None:
        """Give a recovered API one terminal opportunity to learn failure."""
        self._record_failed_status()

    def run_note(self, note: dict[str, Any]) -> None:
        """Production sink used by the merge translator, never a test callback."""
        self.emit("run_note", note["payload"])

    def promote_candidate(self, **kwargs: Any) -> str:
        """Delegate promotion to the frozen client; its route owns sequence 2n."""
        return self.client.promote_candidate(self.run_id, **kwargs)


def _required_environment() -> dict[str, str]:
    names = (
        "ORIZU_PROJECT", "ORIZU_OPTIMIZER_VERSION_ID", "ORIZU_PROMPT_VERSION_ID",
        "ORIZU_DATASET_VERSION_ID", "ORIZU_SPLIT_SET_ID", "ORIZU_SCORER_VERSION_ID",
        "ORIZU_RUNNER_VERSION_ID", "ORIZU_CANDIDATE_RUNNER_DIR", "ORIZU_SCORER_RUNNER_DIR",
    )
    missing = [name for name in names if not os.environ.get(name)]
    if missing:
        raise RuntimeError("missing connector environment: " + ", ".join(missing))
    return {name: os.environ[name] for name in names}


def _optional_int(name: str, *, allow_zero: bool = False) -> int | None:
    raw = os.environ.get(name)
    if raw is None:
        return None
    try:
        value = int(raw)
    except ValueError as error:
        raise RuntimeError(f"{name} must be an integer") from error
    if value < 0 or (value == 0 and not allow_zero):
        raise RuntimeError(f"{name} must be greater than zero")
    return value


def _signed_int(name: str) -> int | None:
    raw = os.environ.get(name)
    if raw is None:
        return None
    try:
        return int(raw)
    except ValueError as error:
        raise RuntimeError(f"{name} must be an integer") from error


def _optional_float(name: str) -> float | None:
    raw = os.environ.get(name)
    if raw is None:
        return None
    try:
        return float(raw)
    except ValueError as error:
        raise RuntimeError(f"{name} must be a number") from error


def _enabled(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes"}


def _num_threads_from_environment() -> int | str:
    raw = os.environ.get("ORIZU_NUM_THREADS", "auto").strip()
    if raw.lower() == "auto":
        return "auto"
    try:
        value = int(raw)
    except ValueError as error:
        raise RuntimeError("ORIZU_NUM_THREADS must be a positive integer or 'auto'") from error
    if value <= 0:
        raise RuntimeError("ORIZU_NUM_THREADS must be a positive integer or 'auto'")
    return value


def _metadata_from_environment() -> dict[str, Any]:
    raw = os.environ.get("ORIZU_METADATA", "{}")
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RuntimeError("ORIZU_METADATA must be a JSON object") from error
    if not isinstance(value, dict):
        raise RuntimeError("ORIZU_METADATA must be a JSON object")
    return value


def _json_object_environment(name: str) -> dict[str, Any]:
    raw = os.environ.get(name, "{}")
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"{name} must be a JSON object") from error
    if not isinstance(value, dict):
        raise RuntimeError(f"{name} must be a JSON object")
    return value


def build_config_from_environment() -> TextGepaConfig:
    """Parse the ALI-1502 wrapper contract before client creation or spend."""
    reflection_model = os.environ.get("ORIZU_REFLECTION_MODEL", TextGepaConfig.reflection_model)
    reflection_max_tokens = _optional_int("ORIZU_REFLECTION_MAX_TOKENS")
    if not reflection_model.startswith("openai/") and reflection_max_tokens is None:
        raise RuntimeError("--reflection-max-tokens is required for Anthropic reflection models")
    return TextGepaConfig(
        budget=os.environ.get("ORIZU_BUDGET", "auto"),
        max_metric_calls=_optional_int("ORIZU_MAX_METRIC_CALLS"),
        max_iterations=_optional_int("ORIZU_MAX_ITERATIONS"),
        max_full_evals=_optional_int("ORIZU_MAX_FULL_EVALS"),
        max_candidate_proposals=_optional_int("ORIZU_MAX_CANDIDATE_PROPOSALS"),
        minibatch_size=_optional_int("ORIZU_MINIBATCH_SIZE") or TextGepaConfig.minibatch_size,
        num_threads=_num_threads_from_environment(),
        reflection_model=reflection_model,
        reflection_temperature=_optional_float("ORIZU_REFLECTION_TEMPERATURE"),
        reflection_max_tokens=reflection_max_tokens,
        reflection_retry_attempts=_optional_int("ORIZU_REFLECTION_RETRY_ATTEMPTS") or TextGepaConfig.reflection_retry_attempts,
        reflection_http_timeout_seconds=_optional_int("ORIZU_REFLECTION_HTTP_TIMEOUT_SECONDS") or TextGepaConfig.reflection_http_timeout_seconds,
        reflection_prompt_template=os.environ.get("ORIZU_REFLECTION_PROMPT_TEMPLATE"),
        reflection_provider_settings=_json_object_environment("ORIZU_REFLECTION_PROVIDER_SETTINGS"),
        epsilon=_optional_float("ORIZU_EPSILON") if os.environ.get("ORIZU_EPSILON") else TextGepaConfig.epsilon,
        candidate_selection_strategy=os.environ.get("ORIZU_CANDIDATE_SELECTION_STRATEGY", TextGepaConfig.candidate_selection_strategy),
        objective=os.environ.get("ORIZU_OBJECTIVE", TextGepaConfig.objective),
        seed=_signed_int("ORIZU_SEED") if "ORIZU_SEED" in os.environ else TextGepaConfig.seed,
        auto_promote=_enabled("ORIZU_AUTO_PROMOTE"),
        promotion_label=os.environ.get("ORIZU_PROMOTION_LABEL"),
        log_row_snapshots=_enabled("ORIZU_LOG_ROW_SNAPSHOTS"),
        cache_evaluations=not _enabled("ORIZU_DISABLE_EVALUATION_CACHE"),
        allow_degenerate_seed=_enabled("ORIZU_ALLOW_DEGENERATE_SEED"),
        skip_perfect_parent_reflection=os.environ.get("ORIZU_SKIP_PERFECT_PARENT_REFLECTION", "1").strip().lower() not in {"0", "false", "no"},
    )


def resolved_budget(config: TextGepaConfig, *, trainset_size: int, valset_size: int):
    """Resolve the frozen legacy budget once for display *and* enforcement."""
    from orizu_gepa.optimizer import Budget

    return Budget.from_config(
        config,
        trainset_size=trainset_size,
        valset_size=valset_size,
        num_components=1,
    )


def selected_budget(config: TextGepaConfig, *, trainset_size: int, valset_size: int) -> tuple[str, int]:
    """Return the display unit and exact limit that this launch selected."""
    budget = resolved_budget(config, trainset_size=trainset_size, valset_size=valset_size)
    return budget.budget_kind, budget.limit


def validate_launch_contract(
    seed_candidate: dict[str, str],
    *,
    candidate_runner_dir: str | None = None,
    scorer_runner_dir: str | None = None,
) -> None:
    """Refuse M1-unsupported topology before creating a run row."""
    if _enabled("ORIZU_USE_MERGE") or os.environ.get("ORIZU_MAX_MERGE_INVOCATIONS"):
        raise RuntimeError("merge is unsupported by the official GEPA connector (ALI-1506)")
    if len(seed_candidate) != 1:
        raise RuntimeError("multi-component candidates are unsupported by the official GEPA connector (ALI-1507)")
    if os.environ.get("ORIZU_SAMPLING_STRATEGY") or os.environ.get("ORIZU_SELECTION_STRATEGY"):
        raise RuntimeError("P×N sampling/selection is unsupported by the official GEPA connector (ALI-1507)")
    if candidate_runner_dir is None or scorer_runner_dir is None:
        return
    try:
        verified_dirs = json.loads(os.environ.get("ORIZU_VERIFIED_RUNNER_DIRS", "[]"))
    except json.JSONDecodeError as error:
        raise RuntimeError("ORIZU_VERIFIED_RUNNER_DIRS must be a JSON array") from error
    if not isinstance(verified_dirs, list) or not all(isinstance(value, str) for value in verified_dirs):
        raise RuntimeError("ORIZU_VERIFIED_RUNNER_DIRS must be a JSON array")
    for label, directory in (("candidate", candidate_runner_dir), ("scorer", scorer_runner_dir)):
        if directory not in verified_dirs:
            raise RuntimeError(
                f"{label} runner directory {directory!r} was not verified against a registered runner version; "
                "launch through `orizu optimizations run-gepa` (ADR-007 / ALI-1159)"
            )


def require_durable_logging(sink: MandatoryEventSink, callback: OrizuCallback) -> None:
    """Prevent GEPA's observational callback catcher from masking a POST failure."""
    if sink.failed or callback.logging_failed:
        raise RuntimeError("mandatory event logging failed during official GEPA execution")


def create_local_logger_from_environment(
    *,
    run_id: str,
    env: dict[str, str],
    prompt_context: Any,
    scorer_context: Any,
    trainset: list[Any],
    valset: list[Any],
    metadata: dict[str, Any],
) -> LocalOptimizationLogger | None:
    """Use the frozen logger exactly as legacy ``--no-local-log`` does."""
    if _enabled("ORIZU_NO_LOCAL_LOG"):
        return None
    local_logger = LocalOptimizationLogger.create(os.environ.get("ORIZU_LOCAL_LOG_DIR", "logs"), run_id)
    local_logger.write_context(project=env["ORIZU_PROJECT"], run_id=run_id, args=dict(env),
                               prompt_context=prompt_context, scorer_context=scorer_context,
                               trainset=trainset, valset=valset, metadata=metadata)
    return local_logger


def _preflight_record_verdict(verdict: dict[str, Any], *, include_row_content: bool) -> dict[str, Any]:
    """Keep refusal diagnosis without writing scorer/dataset content by default."""
    if include_row_content:
        return verdict
    record = {**verdict, "row_evidence": []}
    for original in verdict.get("row_evidence", []):
        row = {"row_id": original.get("row_id"), "score": original.get("score")}
        if original.get("scorer_error"):
            row["error_class"] = "scorer_execution_failed"
        elif original.get("execution_error"):
            source = original.get("execution_error_source")
            row["error_class"] = f"{source}_execution_failed" if source in {"candidate", "scorer"} else "runner_execution_failed"
        else:
            row["error_class"] = None
        record["row_evidence"].append(row)
    return record


def write_preflight_refusal_record(*, env: dict[str, str], verdict: dict[str, Any],
                                   include_row_content: bool = False) -> str | None:
    """Persist the evidence for a refusal that intentionally has no run row."""
    # A refused launch has no remote event stream, but it still follows legacy
    # --no-local-log semantics and never writes scorer/dataset content unless
    # row snapshots were explicitly requested.
    if _enabled("ORIZU_NO_LOCAL_LOG"):
        return None
    record_id = f"preflight-refused-{uuid4()}"
    logger = LocalOptimizationLogger.create(os.environ.get("ORIZU_LOCAL_LOG_DIR", "logs"), record_id)
    path = logger.write_preflight(
        project=env["ORIZU_PROJECT"],
        verdict=_preflight_record_verdict(verdict, include_row_content=include_row_content),
    )
    return str(path)


def _record_result_budget(*, budget: Any, result: Any, callback: OrizuCallback,
                          preflight_metric_calls: int) -> None:
    """Reconcile GEPA's result counters with the pre-launch seed work."""
    budget.used_metric_calls = preflight_metric_calls + int(result.total_metric_calls or 0)
    # Official GEPA returns full-valset and metric counters in its result. Its
    # completed iteration and proposal counts are emitted only through the
    # callback trace we observed for this run.
    budget.used_full_evals = int(result.num_full_val_evals or 0)
    budget.used_candidate_proposals = callback.candidate_proposals
    budget.used_iterations = callback.completed_iterations


def _is_budget_exhausted(*, config: TextGepaConfig, budget: Any,
                         metric_calls_used: int | None = None,
                         candidate_proposals: int | None = None) -> bool:
    """Match legacy terminal semantics, not merely a zero remaining display.

    ``--max-iterations`` is an intentional completion boundary in the frozen
    loop. Every metric/candidate budget that reaches zero while more work was
    otherwise possible is a pause, which must never auto-promote.
    """
    if config.max_iterations is not None:
        return False
    if budget.budget_kind == "max_metric_calls":
        used = budget.metric_budget_used if metric_calls_used is None else metric_calls_used
        return used >= budget.limit
    if budget.budget_kind == "max_candidate_proposals":
        used = budget.used_candidate_proposals if candidate_proposals is None else candidate_proposals
        return used >= budget.limit
    return budget.remaining == 0


def _terminal_budget_exhausted(event: dict[str, Any], *, config: TextGepaConfig, budget: Any,
                              preflight_metric_calls: int, candidate_proposals: int) -> bool:
    """Classify the measured official-GEPA terminal callback before completion emits."""
    metric_calls = event.get("total_metric_calls")
    if not isinstance(metric_calls, int):
        return False
    return _is_budget_exhausted(
        config=config,
        budget=budget,
        metric_calls_used=preflight_metric_calls + metric_calls,
        candidate_proposals=candidate_proposals,
    )


def _result_summary(*, run_id: str, best_id: str, best_score: float, seed_score: float,
                    promoted_prompt_version_id: str | None, budget: Any,
                    local_logger: LocalOptimizationLogger | None) -> dict[str, Any]:
    return {
        "optimization_run_id": run_id,
        "best_candidate_id": best_id,
        "best_score": best_score,
        "seed_score": seed_score,
        "promoted_prompt_version_id": promoted_prompt_version_id,
        "budget": budget.to_payload(),
        "local_log_dir": str(local_logger.path) if local_logger is not None else None,
    }


def run_from_environment() -> dict[str, Any]:
    """Run official GEPA over the verified legacy runner subprocess contract.

    ALI-1502 supplies these variables after verifying runner bytes. Scorer
    contract resolution and seed validation intentionally happen before
    ``start_run`` so either refusal leaves no stranded running record.
    """
    env = _required_environment()
    train_split = os.environ.get("ORIZU_TRAIN_SPLIT", "train")
    validation_split = os.environ.get("ORIZU_VALIDATION_SPLIT", "validation")
    config = build_config_from_environment()
    client = OrizuClient.from_env()
    prompt_context, trainset = client.fetch_exec_context(
        prompt_version_id=env["ORIZU_PROMPT_VERSION_ID"], runner_version_id=env["ORIZU_RUNNER_VERSION_ID"],
        dataset_version_id=env["ORIZU_DATASET_VERSION_ID"], split_set_id=env["ORIZU_SPLIT_SET_ID"], split=train_split,
    )
    _, valset = client.fetch_exec_context(
        prompt_version_id=env["ORIZU_PROMPT_VERSION_ID"], runner_version_id=env["ORIZU_RUNNER_VERSION_ID"],
        dataset_version_id=env["ORIZU_DATASET_VERSION_ID"], split_set_id=env["ORIZU_SPLIT_SET_ID"], split=validation_split,
    )
    scorer_context, _ = client.fetch_scorer_exec_context(
        scorer_version_id=env["ORIZU_SCORER_VERSION_ID"], runner_version_id=os.environ.get("ORIZU_SCORER_RUNNER_VERSION_ID"),
        dataset_version_id=env["ORIZU_DATASET_VERSION_ID"], split_set_id=env["ORIZU_SPLIT_SET_ID"], split=validation_split,
    )
    raw_scorer_candidate_field = os.environ.get("ORIZU_SCORER_CANDIDATE_FIELD")
    try:
        scorer_input_contract, scorer_candidate_output_field = resolve_scorer_input_contract(
            env["ORIZU_SCORER_RUNNER_DIR"],
            input_contract=os.environ.get("ORIZU_SCORER_INPUT_CONTRACT"),
            candidate_field=raw_scorer_candidate_field,
        )
    except RuntimeError as error:
        raise RuntimeError(
            f"scorer-contract failure before launch for {env['ORIZU_SCORER_VERSION_ID']}: {error}"
        ) from error
    hooks = LifecycleHooks()
    seed_candidate = {"prompt": prompt_context.body or ""}
    validate_launch_contract(
        seed_candidate,
        candidate_runner_dir=env["ORIZU_CANDIDATE_RUNNER_DIR"],
        scorer_runner_dir=env["ORIZU_SCORER_RUNNER_DIR"],
    )
    preflight_adapter = RunnerEvaluationAdapter(
        candidate_runner_dir=env["ORIZU_CANDIDATE_RUNNER_DIR"], scorer_runner_dir=env["ORIZU_SCORER_RUNNER_DIR"],
        run_id=None, prompt_context=prompt_context, scorer_context=scorer_context,
        scorer_input_contract=scorer_input_contract,
        scorer_candidate_field=raw_scorer_candidate_field,
        num_threads=config.num_threads, minibatch_size=config.minibatch_size, validation_count=len(valset),
    )
    try:
        preflight_verdict = validate_seed_before_run(
            seed_candidate=seed_candidate, valset=valset, adapter=preflight_adapter,
            hooks=hooks, allow_degenerate_seed=config.allow_degenerate_seed,
        )
    except SeedValidationRefused as error:
        record_path = write_preflight_refusal_record(
            env=env, verdict=error.verdict, include_row_content=config.log_row_snapshots,
        )
        raise SeedValidationRefused(error.verdict, preflight_record_path=record_path) from error
    except ScorerContractError as error:
        raise RuntimeError(f"scorer-contract failure before launch for {env['ORIZU_SCORER_VERSION_ID']}: {error}") from error
    preflight_metric_calls = int(preflight_verdict.get("preflight_metric_calls", 0))
    budget = resolved_budget(config, trainset_size=len(trainset), valset_size=len(valset))
    budget_kind, budget_limit = budget.budget_kind, budget.limit
    metadata = {
        **_metadata_from_environment(),
        "optimizer_family": "gepa", "optimizer_package": "orizu-gepa",
        "engine": "official",
        "scorer_input_contract": scorer_input_contract,
        "scorer_candidate_output_field": scorer_candidate_output_field,
        "reflection_lm": config.reflection_model,
        "inference_lm": prompt_context.provider_settings.get("model"),
        "scorer_lm": scorer_context.provider_settings.get("model"),
        "dataset_size": len(trainset) + len(valset), "train_count": len(trainset), "validation_count": len(valset),
        "num_threads": preflight_adapter.num_threads_plan.to_payload(),
    }
    run_id = client.start_run(
        project=env["ORIZU_PROJECT"], optimizer_version_id=env["ORIZU_OPTIMIZER_VERSION_ID"],
        prompt_version_id=env["ORIZU_PROMPT_VERSION_ID"], scorer_version_id=scorer_context.scorer_version_id or env["ORIZU_SCORER_VERSION_ID"],
        dataset_version_id=env["ORIZU_DATASET_VERSION_ID"], split_set_id=env["ORIZU_SPLIT_SET_ID"],
        train_split=train_split, validation_split=validation_split, metadata=metadata,
    )
    print(json.dumps({"optimization_run_id": run_id}), flush=True)
    # The frozen sink treats ``None`` as no local artifact writer.  Keep that
    # legacy behavior rather than maintaining a connector-local no-op logger.
    local_logger = create_local_logger_from_environment(
        run_id=run_id, env=env, prompt_context=prompt_context, scorer_context=scorer_context,
        trainset=trainset, valset=valset, metadata=metadata,
    )
    if local_logger is not None:
        print(f"[orizu-gepa] local log: {local_logger.path}", flush=True)
    if local_logger is not None and preflight_verdict.get("warnings"):
        local_logger.write_preflight(
            project=env["ORIZU_PROJECT"],
            verdict=_preflight_record_verdict(
                preflight_verdict, include_row_content=config.log_row_snapshots,
            ),
            kind="preflight_warning",
        )
    sink = MandatoryEventSink(client, run_id, local_logger)
    def terminal_budget_exhausted(event: dict[str, Any]) -> bool:
        return _terminal_budget_exhausted(
            event,
            config=config,
            budget=budget,
            preflight_metric_calls=preflight_metric_calls,
            candidate_proposals=callback.candidate_proposals,
        )

    callback = OrizuCallback(
        sink,
        run_id,
        hooks,
        higher_is_better=scorer_context.higher_is_better,
        budget_kind=budget_kind,
        budget_limit=budget_limit,
        approx_metric_call_limit=budget.approx_metric_call_limit,
        max_payload_chars=_optional_int("ORIZU_MAX_PAYLOAD_CHARS") or 16000,
        log_row_snapshots=config.log_row_snapshots,
        terminal_budget_exhausted=terminal_budget_exhausted,
    )
    adapter = RunnerEvaluationAdapter(
        candidate_runner_dir=env["ORIZU_CANDIDATE_RUNNER_DIR"], scorer_runner_dir=env["ORIZU_SCORER_RUNNER_DIR"],
        run_id=run_id, prompt_context=prompt_context, scorer_context=scorer_context,
        scorer_input_contract=scorer_input_contract,
        scorer_candidate_field=raw_scorer_candidate_field,
        num_threads=config.num_threads, minibatch_size=config.minibatch_size, validation_count=len(valset),
    )
    stoppers = [MandatoryLoggingStopper(lambda: sink.failed or callback.logging_failed)]
    if config.max_iterations is not None:
        stoppers.append(IterationBoundaryStopper(config.max_iterations))
    if config.max_candidate_proposals is not None:
        stoppers.append(MaxCandidateProposalsStopper(
            config.max_candidate_proposals,
            proposal_count=lambda: callback.candidate_proposals,
        ))
    try:
        proposal_observability: Any | None = None
        proposal_budget: Any | None = None
        custom_candidate_proposer = None
        if os.environ.get("ORIZU_CANDIDATE_PROPOSER") == "skilled-proposer":
            # DSPy and skilled-proposer are installed only in the manager
            # published opt-in venv.  Keeping this import inside the exact
            # selection branch preserves the established no-flag process.
            from .skilled_proposer_bridge import (
                ProposalCallBudget,
                ProposalObservability,
                make_skilled_proposer_from_environment,
            )
            artifact_root = (local_logger.directory if local_logger is not None
                             else Path.cwd() / ".orizu" / "proposal-observability" / run_id)
            proposal_budget = ProposalCallBudget(
                max_calls=_optional_int("ORIZU_PROPOSAL_MAX_CALLS"),
                max_tokens=_optional_int("ORIZU_PROPOSAL_MAX_TOKENS"),
            )
            proposal_observability = ProposalObservability(
                event_log_root=artifact_root / "proposal-observability",
                durable_failure_root=artifact_root / "proposal-failures",
                budget=proposal_budget,
            )
            custom_candidate_proposer = make_skilled_proposer_from_environment(
                config=config,
                observability=proposal_observability,
                budget=proposal_budget,
            )
            if custom_candidate_proposer is None:
                raise RuntimeError("ALI_1505_PROPOSER_FACTORY_REFUSED_SELECTED_VALUE")

        reflection_lm = None if custom_candidate_proposer is not None else make_gepa_reflection_lm(
            context_supplier=lambda: (
                next(iter((adapter.last_candidate or seed_candidate).values())),
                adapter.last_row_evaluations,
            ),
            config=config,
            failure_reporter=callback.record_reflection_failure,
            success_reporter=callback.record_reflection_prompt,
        )
        # ``Budget.from_config`` turns every default/preset into a concrete
        # metric limit. Passing that limit is the spend-safety boundary; it is
        # never merely display metadata.
        effective_metric_limit = budget.limit if budget.budget_kind == "max_metric_calls" else None
        result = run_official_gepa(seed_candidate=seed_candidate, trainset=trainset, valset=valset, adapter=adapter,
                                   callback=callback, hooks=hooks, max_metric_calls=effective_metric_limit,
                                   stop_callbacks=stoppers, allow_degenerate_seed=config.allow_degenerate_seed,
                                   reflection_lm=reflection_lm, seed_already_validated=True,
                                   custom_candidate_proposer=custom_candidate_proposer,
                                   proposal_budget=proposal_budget,
                                   config=config)
        require_durable_logging(sink, callback)
        best_id = str(result.best_idx)
        best_score = float(result.val_aggregate_scores[result.best_idx])
        if not scorer_context.higher_is_better:
            best_score = 1.0 - best_score
        seed_score = (float(result.val_aggregate_scores[0]) if scorer_context.higher_is_better
                      else 1.0 - float(result.val_aggregate_scores[0]))
        promoted_prompt_version_id = None
        _record_result_budget(
            budget=budget, result=result, callback=callback,
            preflight_metric_calls=preflight_metric_calls,
        )
        budget_exhausted = _is_budget_exhausted(config=config, budget=budget)
        if budget_exhausted:
            sink.emit(
                "budget_exhausted",
                {
                    "stage": "optimization_completed",
                    "budget": budget.to_payload(),
                    "decision_rule": "budget is checked only between iterations",
                },
                iteration=None,
                candidate_id=best_id,
                parent_candidate_id=None,
            )
            sink.emit(
                "run_paused",
                {
                    "reason": "budget_exhausted",
                    "best_candidate_id": best_id,
                    "best_validation_score": best_score,
                    "seed_validation_score": seed_score,
                    "budget": budget.to_payload(),
                },
                iteration=None,
                candidate_id=best_id,
                parent_candidate_id=None,
            )
        elif config.auto_promote and best_id != "0":
            prompt_id = getattr(prompt_context, "prompt_id", None)
            if not prompt_id:
                raise RuntimeError("Cannot auto-promote without prompt_id in prompt context")
            best_candidate = result.candidates[result.best_idx]
            promoted_prompt_version_id = sink.promote_candidate(
                candidate_id=best_id,
                prompt_id=prompt_id,
                parent_prompt_version_id=env["ORIZU_PROMPT_VERSION_ID"],
                body=next(iter(best_candidate.values())),
                body_kind=prompt_context.body_kind,
                provider_settings=prompt_context.provider_settings,
                runner_version_id=env["ORIZU_RUNNER_VERSION_ID"],
                label=config.promotion_label,
            )
        if local_logger is not None:
            local_logger.write_result(TextGepaResult(
                run_id=run_id,
                best_candidate_id=best_id,
                best_candidate_text=next(iter(result.candidates[result.best_idx].values())),
                best_score=best_score,
                seed_score=seed_score,
                promoted_prompt_version_id=promoted_prompt_version_id,
                budget=budget,
            ))
            if proposal_observability is not None:
                proposal_observability.write_terminal_lm_stats_artifact()
            else:
                local_logger.write_lm_stats(
                    total_cost=float(getattr(reflection_lm, "total_cost", 0.0)),
                    total_tokens_in=int(getattr(reflection_lm, "total_tokens_in", 0)),
                    total_tokens_out=int(getattr(reflection_lm, "total_tokens_out", 0)),
                    total_tokens=int(getattr(reflection_lm, "total_tokens", 0)),
                )
        if budget_exhausted:
            client.update_run(
                run_id,
                status="paused",
                best_score=best_score,
                best_candidate_id=best_id,
                metadata={
                    "seed_score": seed_score,
                    "budget": budget.to_payload(),
                    "pause_reason": "budget_exhausted",
                },
            )
        else:
            client.update_run(run_id, status="succeeded", best_score=best_score, best_candidate_id=best_id,
                              result_prompt_version_id=promoted_prompt_version_id)
        summary = _result_summary(
            run_id=run_id, best_id=best_id, best_score=best_score, seed_score=seed_score,
            promoted_prompt_version_id=promoted_prompt_version_id, budget=budget,
            local_logger=local_logger,
        )
        return summary
    except Exception as error:
        if sink.failed:
            sink.retry_failed_status()
        else:
            client.update_run(
                run_id,
                status="failed",
                metadata={"failure_reason": str(error)},
            )
        raise
