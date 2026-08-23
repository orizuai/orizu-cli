"""Production GEPA callback sink and lifecycle hooks."""

from __future__ import annotations

from collections.abc import Callable
import hashlib
import json
from typing import Any

from orizu_gepa.optimizer import RowEvaluation

from .translator import translate_callback


def _bounded(value: Any, limit: int) -> tuple[Any, bool]:
    """Cap disclosure values before they enter the mandatory event transport."""
    if isinstance(value, str):
        if len(value) <= limit:
            return value, False
        return value[:limit] + "…[truncated]", True
    if isinstance(value, (dict, list)):
        rendered = json.dumps(value, ensure_ascii=False, sort_keys=True)
        if len(rendered) <= limit:
            return value, False
        return rendered[:limit] + "…[truncated]", True
    return value, False


def _redacted(name: str, value: Any, *, include_text: bool) -> dict[str, Any]:
    if include_text:
        return {name: value}
    rendered = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    return {f"{name}_sha256": hashlib.sha256(rendered.encode()).hexdigest(), f"{name}_redacted": True}


class LifecycleHooks:
    """Named extension points; callbacks receive immutable observation data."""

    def __init__(self) -> None:
        self._hooks: dict[str, list[Callable[[dict[str, Any]], None]]] = {}

    def add(self, name: str, hook: Callable[[dict[str, Any]], None]) -> None:
        self._hooks.setdefault(name, []).append(hook)

    def emit(self, name: str, payload: dict[str, Any]) -> None:
        for hook in self._hooks.get(name, []):
            hook(payload)


class OrizuCallback:
    """Official callback object wired to the mandatory production event sink."""

    def __init__(self, sink: Any, run_id: str, hooks: LifecycleHooks | None = None,
                 higher_is_better: bool = True, budget_kind: str = "max_metric_calls",
                 budget_limit: int | None = None, max_payload_chars: int = 16000,
                 log_row_snapshots: bool = False, approx_metric_call_limit: int | None = None,
                 terminal_budget_exhausted: Callable[[dict[str, Any]], bool] | None = None,
                 evaluation_adapter: Any | None = None):
        self.sink = sink
        self.run_id = run_id
        self.hooks = hooks or LifecycleHooks()
        self.higher_is_better = higher_is_better
        self.budget_kind = budget_kind
        self.budget_limit = budget_limit
        self.max_payload_chars = max_payload_chars
        self.log_row_snapshots = log_row_snapshots
        self.approx_metric_call_limit = approx_metric_call_limit
        self._terminal_budget_exhausted = terminal_budget_exhausted
        # GEPA does not issue evaluation callbacks for full valset runs. Its
        # adapter is therefore the only authoritative row-id source at the
        # following on_valset_evaluated callback.
        self.evaluation_adapter = evaluation_adapter
        self.validation_row_ids: list[str] = []
        self.logging_failed = False
        self._selected_parent_by_iteration: dict[int, str] = {}
        self._proposals_by_iteration: dict[int, list[dict[str, Any]]] = {}
        self._parent_minibatches: dict[int, list[dict[str, Any]]] = {}
        # A candidate-indexed evaluation can be either a parent minibatch or
        # the row evidence preceding GEPA's authoritative valset callback.
        # Hold it until callback identity, never its row count, decides.
        self._pending_candidate_evaluations: dict[int, list[dict[str, Any]]] = {}
        # Child train rows have no GEPA candidate id until its acceptance or
        # rejection callback. Keep both wire payload and durable row evidence
        # together until that authoritative id arrives.
        self._child_minibatches: dict[int, list[dict[str, Any]]] = {}
        self._seed_valset_rows: list[dict[str, Any]] = []
        self._evaluation_row_ids: dict[int, list[list[str]]] = {}
        self._evaluation_inputs: dict[int, list[list[Any]]] = {}
        self._reflection_contexts: dict[int, dict[str, Any]] = {}
        # GEPAResult deliberately exposes full-validation and metric counts,
        # but iteration/proposal counts live only in its callback trace.
        self.completed_iterations = 0
        self.candidate_proposals = 0

    def _external_score(self, value: Any) -> Any:
        if not isinstance(value, (int, float)):
            return value
        return value if self.higher_is_better else 1.0 - value

    def _emit(self, callback_name: str, event: dict[str, Any]) -> None:
        try:
            translated = translate_callback(
                callback_name,
                event,
                run_id=self.run_id,
                last_server_sequence=self.sink.sequence,
                max_payload_chars=self.max_payload_chars,
                budget_kind=self.budget_kind,
                budget_limit=self.budget_limit,
                approx_metric_call_limit=self.approx_metric_call_limit,
            )
            self.sink.emit(translated["eventType"], translated["payload"],
                           iteration=translated["iteration"], candidate_id=translated["candidateId"],
                           parent_candidate_id=translated["parentCandidateId"])
        except Exception:
            self.logging_failed = True
            raise

    def _write_local(self, write: Any) -> None:
        """Make local-artifact failures visible to the terminal run guard."""
        try:
            write()
        except Exception:
            self.logging_failed = True
            raise

    def on_optimization_start(self, event: dict[str, Any]) -> None:
        self._emit("on_optimization_start", event)

    def on_iteration_start(self, event: dict[str, Any]) -> None:
        self._emit("on_iteration_start", event)

    def _flush_pending_parent_minibatches(self, iteration: int) -> None:
        """Publish candidate-indexed work once it was not identified as valset work."""
        pending = self._pending_candidate_evaluations.pop(iteration, [])
        for item in pending:
            candidate_id = item["candidate_id"]
            payload = item["payload"]
            self._parent_minibatches.setdefault(iteration, []).append(payload)
            self.sink.emit(
                "parent_minibatch_completed",
                payload,
                iteration=iteration,
                candidate_id=self._selected_parent_by_iteration.get(iteration, candidate_id),
            )
            local_logger = getattr(self.sink, "local_logger", None)
            if local_logger is not None:
                self._write_local(lambda: local_logger.append_evaluations(
                    stage="parent_minibatch", split="train", iteration=iteration,
                    candidate_id=candidate_id, parent_candidate_id=item["parent_candidate_id"],
                    results=item["results"],
                ))

    def on_candidate_selected(self, event: dict[str, Any]) -> None:
        iteration = int(event["iteration"])
        self._selected_parent_by_iteration[iteration] = str(event["candidate_idx"])

    def on_minibatch_sampled(self, event: dict[str, Any]) -> None:
        self._emit("on_minibatch_sampled", event)

    def on_evaluation_start(self, event: dict[str, Any]) -> None:
        inputs = list(event.get("inputs") or [])
        row_ids = []
        for index, value in enumerate(inputs):
            row_ids.append(str(getattr(value, "id", value.get("id", index) if isinstance(value, dict) else index)))
        self._evaluation_row_ids.setdefault(int(event["iteration"]), []).append(row_ids)
        self._evaluation_inputs.setdefault(int(event["iteration"]), []).append(inputs)

    def on_evaluation_end(self, event: dict[str, Any]) -> None:
        iteration = int(event["iteration"])
        raw_scores = event.get("scores") or []
        outputs = event.get("outputs") or []
        trajectories = event.get("trajectories") or []
        row_ids = (self._evaluation_row_ids.get(iteration) or [[]]).pop(0)
        inputs = (self._evaluation_inputs.get(iteration) or [[]]).pop(0)
        rows = []
        local_results: list[RowEvaluation] = []
        scores = []
        for index, score in enumerate(raw_scores):
            output = outputs[index] if index < len(outputs) else None
            trace = trajectories[index] if index < len(trajectories) else {}
            trace = trace if isinstance(trace, dict) else {}
            output_info = output if isinstance(output, dict) else {}
            external_score = output_info.get("raw_score", self._external_score(score))
            scores.append(external_score)
            actual_output = output_info.get("output", output)
            bounded_output, output_truncated = _bounded(actual_output, self.max_payload_chars)
            row = {
                "row_id": output_info.get("row_id", row_ids[index] if index < len(row_ids) else str(index)),
                "score": external_score,
                "feedback": output_info.get("feedback", trace.get("Feedback")),
                "error": output_info.get("error", trace.get("error")),
                "output": bounded_output,
            }
            for field in ("latency_ms", "token_in", "token_out", "cost_usd", "cached", "error_source"):
                if field in output_info:
                    row[field] = output_info[field]
            if output_truncated:
                row["output_truncated"] = True
            rows.append(row)
            source = inputs[index] if index < len(inputs) else None
            source_row = getattr(source, "row", source if isinstance(source, dict) else {})
            local_results.append(RowEvaluation(
                row_id=str(row["row_id"]),
                row=source_row if isinstance(source_row, dict) else {},
                output=actual_output,
                score=float(external_score) if isinstance(external_score, (int, float)) else 0.0,
                feedback=row["feedback"],
                scorer_response=output_info.get("scorer_output"),
                latency_ms=output_info.get("latency_ms"),
                token_in=output_info.get("token_in"),
                token_out=output_info.get("token_out"),
                cost_usd=output_info.get("cost_usd"),
                error=row["error"],
                cached=bool(output_info.get("cached", False)),
                error_source=output_info.get("error_source"),
            ))
        payload = {"score_mean": (sum(scores) / len(scores)) if scores else None,
                   "score_total": sum(scores), "row_results": rows}
        is_seed_baseline = iteration == 0 and bool(event.get("is_seed_candidate"))
        if is_seed_baseline:
            # The following valset callback is the authoritative full-eval
            # identity; retain this row evidence only to enrich its outputs.
            self._seed_valset_rows = rows
        elif event.get("candidate_idx") is not None:
            parent_ids = event.get("parent_ids") or []
            self._pending_candidate_evaluations.setdefault(iteration, []).append({
                "candidate_id": str(event["candidate_idx"]),
                "payload": payload,
                "results": local_results,
                "parent_candidate_id": str(parent_ids[0]) if parent_ids else None,
            })
        else:
            parent_ids = event.get("parent_ids") or []
            self._child_minibatches.setdefault(iteration, []).append({
                "payload": payload,
                "results": local_results,
                "parent_candidate_id": str(parent_ids[0]) if parent_ids else None,
            })

    def on_evaluation_skipped(self, event: dict[str, Any]) -> None:
        self._flush_pending_parent_minibatches(int(event["iteration"]))
        self._emit("on_evaluation_skipped", event)

    def on_reflective_dataset_built(self, event: dict[str, Any]) -> None:
        self._emit("on_reflective_dataset_built", event)

    def on_proposal_start(self, event: dict[str, Any]) -> None:
        iteration = int(event["iteration"])
        self._flush_pending_parent_minibatches(iteration)
        parent_candidate = event.get("parent_candidate")
        self._reflection_contexts[iteration] = {
            "iteration": iteration,
            "parent_candidate_id": self._selected_parent_by_iteration.get(iteration),
            "components_to_update": list(event.get("components") or []),
            "parent_candidate": dict(parent_candidate) if isinstance(parent_candidate, dict) else None,
        }
        self._emit("on_proposal_start", event)

    def record_reflection_failure(
        self,
        *,
        error: Exception,
        gepa_prompt: str,
        parent_text: str,
        parent_results: list[Any],
    ) -> None:
        """Persist an exception before GEPA's safe proposal helper can swallow it."""
        latest_iteration = next(reversed(self._reflection_contexts), None)
        context = self._reflection_contexts.get(latest_iteration, {})
        iteration = context.get("iteration")
        parent_candidate_id = context.get("parent_candidate_id")
        row_ids = [str(getattr(result, "row_id", index)) for index, result in enumerate(parent_results)]
        context_chars = len(json.dumps(parent_results, ensure_ascii=False, default=str))
        payload = {
            "error_type": type(error).__name__,
            "message": str(error),
            "gepa_prompt_chars": len(gepa_prompt),
            "parent_text_chars": len(parent_text),
            "parent_result_count": len(parent_results),
            "parent_context_chars": context_chars,
        }
        self.sink.emit(
            "reflection_failed",
            payload,
            iteration=iteration,
            candidate_id=parent_candidate_id,
            parent_candidate_id=parent_candidate_id,
        )
        local_logger = getattr(self.sink, "local_logger", None)
        if local_logger is not None:
            self._write_local(lambda: local_logger.append_reflection_failure(
                iteration=iteration,
                parent_candidate_id=parent_candidate_id,
                row_ids=row_ids,
                error_type=type(error).__name__,
                error_message=str(error),
                gepa_prompt_chars=len(gepa_prompt),
                parent_text_chars=len(parent_text),
                parent_result_count=len(parent_results),
                parent_context_chars=context_chars,
            ))
        self.sink.run_note({"payload": {
            "message": f"reflection failed: {type(error).__name__}: {error}",
            "error_type": type(error).__name__,
        }})

    @staticmethod
    def _adapter_output(result: RowEvaluation) -> dict[str, Any]:
        """Return the adapter-owned evidence for one authoritative row id."""
        return {
            "row_id": result.row_id,
            "output": result.output,
            "raw_score": result.score,
            "feedback": result.feedback,
            "scorer_output": result.scorer_response,
            "latency_ms": result.latency_ms,
            "token_in": result.token_in,
            "token_out": result.token_out,
            "cost_usd": result.cost_usd,
            "error": result.error,
            "cached": result.cached,
            "error_source": result.error_source,
        }

    def _rekey_valset_evidence(
        self, event: dict[str, Any], results: list[RowEvaluation]
    ) -> dict[str, Any]:
        """Replace GEPA's positional score keys with runner-owned row identities.

        GEPA 0.1.4 reports a valset score map keyed by positional indexes. The
        immediately preceding adapter evaluation is the authoritative pairing
        of those scores to dataset rows. Rekey every correlated map here, at
        that callback boundary, so downstream transports never need to guess.
        """
        scores = event.get("scores_by_val_id")
        if not isinstance(scores, dict) or len(scores) != len(results):
            return event

        outputs = event.get("outputs_by_val_id") or {}
        feedbacks = event.get("feedbacks_by_val_id") or {}
        errors = event.get("errors_by_val_id") or {}
        if not isinstance(outputs, dict):
            outputs = {}
        if not isinstance(feedbacks, dict):
            feedbacks = {}
        if not isinstance(errors, dict):
            errors = {}

        rekeyed_scores: dict[str, Any] = {}
        rekeyed_outputs: dict[str, Any] = {}
        rekeyed_feedbacks: dict[str, Any] = {}
        rekeyed_errors: dict[str, Any] = {}
        for (source_id, score), result in zip(scores.items(), results, strict=True):
            row_id = str(result.row_id)
            if row_id in rekeyed_scores:
                raise ValueError(f"adapter returned duplicate valset row id {row_id!r}")
            existing = outputs.get(source_id, outputs.get(row_id, {}))
            output_info = dict(existing) if isinstance(existing, dict) else {"output": existing}
            for name, value in self._adapter_output(result).items():
                if output_info.get(name) is None:
                    output_info[name] = value
            # The adapter id is canonical even when GEPA happened to include
            # another row_id in side information.
            output_info["row_id"] = row_id
            rekeyed_scores[row_id] = score
            rekeyed_outputs[row_id] = output_info
            if source_id in feedbacks:
                rekeyed_feedbacks[row_id] = feedbacks[source_id]
            if source_id in errors:
                rekeyed_errors[row_id] = errors[source_id]

        enriched = dict(event)
        enriched["scores_by_val_id"] = rekeyed_scores
        enriched["outputs_by_val_id"] = rekeyed_outputs
        if feedbacks:
            enriched["feedbacks_by_val_id"] = rekeyed_feedbacks
        if errors:
            enriched["errors_by_val_id"] = rekeyed_errors
        return enriched

    def on_valset_evaluated(self, event: dict[str, Any]) -> None:
        is_seed = int(event.get("iteration", -1)) == 0 and str(event.get("candidate_idx")) in {"0", "seed"}
        iteration = int(event.get("iteration", 0))
        raw_candidate_id = event.get("candidate_idx")
        candidate_id = str(raw_candidate_id) if raw_candidate_id is not None else "unknown"
        # This callback, rather than row count, identifies a child's complete
        # validation. Preserve its staged adapter evidence for the local row
        # artifact before removing it from the pending parent-minibatch queue.
        pending = self._pending_candidate_evaluations.get(iteration, [])
        staged = [item for item in pending if item["candidate_id"] == candidate_id]
        remaining = [item for item in pending if item["candidate_id"] != candidate_id]
        if remaining:
            self._pending_candidate_evaluations[iteration] = remaining
        else:
            self._pending_candidate_evaluations.pop(iteration, None)
        # GEPA's valset callback deliberately omits rollout outputs. Its
        # preceding evaluation callback has the adapter's real row evidence.
        # Reattach that evidence for the seed baseline rather than emitting an
        # empty dashboard baseline.
        adapter_results = list(
            getattr(self.evaluation_adapter, "last_row_evaluations", []) or []
        )
        scores = event.get("scores_by_val_id")
        expected_ids = self.validation_row_ids
        adapter_ids = [str(result.row_id) for result in adapter_results]
        needs_declared_valset_identity = (
            isinstance(scores, dict)
            and len(expected_ids) == len(scores)
            and set(adapter_ids) != set(expected_ids)
        )
        if needs_declared_valset_identity:
            adapter_results = [
                RowEvaluation(row_id=row_id, row={}, output=None, score=0.0, feedback=None)
                for row_id in expected_ids
            ]
        if is_seed and adapter_results:
            event = self._rekey_valset_evidence(event, adapter_results)
        elif is_seed and self._seed_valset_rows:
            seed_results = [
                RowEvaluation(
                    row_id=str(row["row_id"]), row={}, output=row.get("output"),
                    score=float(row["score"]) if isinstance(row.get("score"), (int, float)) else 0.0,
                    feedback=row.get("feedback"), scorer_response=row.get("scorer_output"),
                    latency_ms=row.get("latency_ms"), token_in=row.get("token_in"),
                    token_out=row.get("token_out"), cost_usd=row.get("cost_usd"),
                    error=row.get("error"), cached=bool(row.get("cached", False)),
                    error_source=row.get("error_source"),
                )
                for row in self._seed_valset_rows
            ]
            event = self._rekey_valset_evidence(event, seed_results)
        if not is_seed and adapter_results:
            event = self._rekey_valset_evidence(event, adapter_results)
        elif not is_seed and staged:
            # The most recent same-candidate evaluation is the adapter call
            # immediately before this authoritative valset callback. Earlier
            # entries are child minibatches and must never supply valset rows.
            event = self._rekey_valset_evidence(event, staged[-1]["results"])
        local_logger = getattr(self.sink, "local_logger", None)
        if local_logger is not None:
            outputs_by_val_id = event.get("outputs_by_val_id") or {}
            results: list[RowEvaluation] = []
            parent_ids = event.get("parent_ids") or []
            raw_parent_id = parent_ids[0] if parent_ids else None
            parent_candidate_id = str(raw_parent_id) if raw_parent_id is not None else None
            for row_id, score in (event.get("scores_by_val_id") or {}).items():
                output_info = outputs_by_val_id.get(row_id, {}) if isinstance(outputs_by_val_id, dict) else {}
                output_info = output_info if isinstance(output_info, dict) else {"output": output_info}
                external_score = self._external_score(score)
                row_error = output_info.get("error")
                if isinstance(external_score, (int, float)):
                    recorded_score = float(external_score)
                else:
                    recorded_score = 0.0
                    warning = "invalid scorer score; recorded as 0.0"
                    row_error = f"{row_error}; {warning}" if row_error else warning
                if raw_candidate_id is None:
                    warning = "missing candidate_idx; recorded as unknown"
                    row_error = f"{row_error}; {warning}" if row_error else warning
                results.append(RowEvaluation(
                    row_id=str(output_info.get("row_id", row_id)), row={}, output=output_info.get("output"),
                    score=recorded_score, feedback=output_info.get("feedback"),
                    scorer_response=output_info.get("scorer_output"),
                    latency_ms=output_info.get("latency_ms"), token_in=output_info.get("token_in"),
                    token_out=output_info.get("token_out"), cost_usd=output_info.get("cost_usd"),
                    error=row_error, cached=bool(output_info.get("cached", False)),
                    error_source=output_info.get("error_source"),
                ))
            if results:
                stage = "seed_val_set" if is_seed else "child_val_set"
                self._write_local(lambda: local_logger.append_evaluations(
                    stage=stage, split="validation", iteration=None if is_seed else iteration,
                    candidate_id="seed" if is_seed else candidate_id,
                    parent_candidate_id=None if is_seed else parent_candidate_id,
                    results=results,
                ))
        if self.higher_is_better:
            self._emit("on_valset_evaluated", event)
            return
        external = dict(event)
        external["scores_by_val_id"] = {key: self._external_score(value) for key, value in event.get("scores_by_val_id", {}).items()}
        external["average_score"] = self._external_score(event.get("average_score"))
        self._emit("on_valset_evaluated", external)

    def on_proposal_end(self, event: dict[str, Any]) -> None:
        # GEPA tells us the child index only at acceptance time. Buffer the
        # reflection so the dashboard never sees an unjoinable child.
        self.candidate_proposals += 1
        self._proposals_by_iteration.setdefault(int(event["iteration"]), []).append(event)

    def record_reflection_prompt(self, provider_prompt: str) -> None:
        """Remember the frozen provider prompt, not GEPA's discarded renderer input."""
        latest_iteration = next(reversed(self._reflection_contexts), None)
        if latest_iteration is not None:
            self._reflection_contexts[latest_iteration]["provider_prompt"] = provider_prompt

    def _emit_buffered_proposal(self, event: dict[str, Any], candidate_id: str) -> None:
        iteration = int(event["iteration"])
        parent_id = self._selected_parent_by_iteration.get(iteration)
        context = self._reflection_contexts.get(iteration, {})
        parent_candidate = context.get("parent_candidate")
        new_instructions = event.get("new_instructions") or {}
        components = {
            **(parent_candidate if isinstance(parent_candidate, dict) else {}),
            **(new_instructions if isinstance(new_instructions, dict) else {}),
        }
        bounded_components = {}
        truncated = False
        for key, value in components.items():
            bounded, did_truncate = _bounded(value, self.max_payload_chars)
            bounded_components[key] = bounded
            truncated = truncated or did_truncate
        selected = list(context.get("components_to_update") or [])
        body, body_truncated = _bounded(next(iter(components.values()), None), self.max_payload_chars)
        payload = {"components": bounded_components, "components_to_update": selected,
                   "payload_truncated": truncated or body_truncated}
        if ((isinstance(parent_candidate, dict) and len(parent_candidate) == 1)
                or (parent_candidate is None and len(components) == 1)):
            payload["body"] = body
        self.sink.emit(
            "candidate_proposed",
            payload,
            iteration=iteration,
            candidate_id=candidate_id,
            parent_candidate_id=parent_id,
        )
        translated = translate_callback("on_proposal_end", event, run_id=self.run_id,
                                        max_payload_chars=self.max_payload_chars)
        payload = dict(translated["payload"])
        prompt = payload.pop("prompt", None)
        response = payload.pop("response", None)
        candidate_text = payload.pop("candidate_text", None)
        payload.update(_redacted("prompt", prompt, include_text=self.log_row_snapshots))
        # Frozen legacy behavior deliberately gates only the reflection prompt:
        # the response and extracted candidate are required dashboard evidence.
        payload["response"] = response
        payload["candidate_text"] = candidate_text
        local_logger = getattr(self.sink, "local_logger", None)
        if local_logger is not None:
            parent_rows = (self._parent_minibatches.get(iteration) or [{}])[0].get("row_results", [])
            provider_prompt = self._reflection_contexts.get(iteration, {}).get("provider_prompt", prompt)
            self._write_local(lambda: local_logger.append_reflection(
                iteration=iteration,
                parent_candidate_id=parent_id or "unknown",
                child_candidate_id=candidate_id,
                row_ids=[str(row.get("row_id", index)) for index, row in enumerate(parent_rows)],
                prompt=str(provider_prompt or ""),
                response=str(response or ""),
                candidate_text=str(candidate_text or ""),
            ))
        self.sink.emit(
            "reflection_completed",
            payload,
            iteration=iteration,
            candidate_id=candidate_id,
            parent_candidate_id=parent_id,
        )

    def on_candidate_accepted(self, event: dict[str, Any]) -> None:
        iteration = int(event["iteration"])
        self._flush_pending_parent_minibatches(iteration)
        candidate_id = str(event["new_candidate_idx"])
        proposals = self._proposals_by_iteration.get(iteration) or []
        proposal = proposals.pop(0) if proposals else None
        if proposal is not None:
            self._emit_buffered_proposal(proposal, candidate_id)
        children = self._child_minibatches.get(iteration) or []
        child = children.pop(0) if children else None
        child_minibatch = child["payload"] if child is not None else None
        if child_minibatch is not None:
            self.sink.emit("child_minibatch_completed", child_minibatch, iteration=iteration,
                           candidate_id=candidate_id,
                           parent_candidate_id=self._selected_parent_by_iteration.get(iteration))
            local_logger = getattr(self.sink, "local_logger", None)
            if local_logger is not None:
                self._write_local(lambda: local_logger.append_evaluations(
                    stage="child_minibatch", split="train", iteration=iteration,
                    candidate_id=candidate_id,
                    parent_candidate_id=child["parent_candidate_id"] or self._selected_parent_by_iteration.get(iteration),
                    results=child["results"],
                ))
        parents = self._parent_minibatches.get(iteration) or [{}]
        parent_minibatch = parents[0]
        acceptance = dict(event)
        acceptance["parent_score_total"] = parent_minibatch.get("score_total")
        acceptance["child_score_total"] = (child_minibatch or {}).get("score_total", event.get("new_score"))
        self._emit("on_candidate_accepted", acceptance)

    def on_candidate_rejected(self, event: dict[str, Any]) -> None:
        iteration = int(event["iteration"])
        self._flush_pending_parent_minibatches(iteration)
        proposals = self._proposals_by_iteration.get(iteration) or []
        proposal = proposals.pop(0) if proposals else None
        candidate_id = f"rejected-{iteration}"
        if proposal is not None:
            self._emit_buffered_proposal(proposal, candidate_id)
        children = self._child_minibatches.get(iteration) or []
        child = children.pop(0) if children else None
        child_minibatch = child["payload"] if child is not None else None
        if child_minibatch is not None:
            self.sink.emit("child_minibatch_completed", child_minibatch, iteration=iteration,
                           candidate_id=candidate_id, parent_candidate_id=self._selected_parent_by_iteration.get(iteration))
            local_logger = getattr(self.sink, "local_logger", None)
            if local_logger is not None:
                self._write_local(lambda: local_logger.append_evaluations(
                    stage="child_minibatch", split="train", iteration=iteration,
                    candidate_id=candidate_id,
                    parent_candidate_id=child["parent_candidate_id"] or self._selected_parent_by_iteration.get(iteration),
                    results=child["results"],
                ))
        parents = self._parent_minibatches.get(iteration) or [{}]
        rejection = dict(event)
        rejection["parent_score_total"] = parents[0].get("score_total")
        rejection["child_score_total"] = (child_minibatch or {}).get("score_total", event.get("new_score"))
        rejection["candidate_idx"] = candidate_id
        self._emit("on_candidate_rejected", rejection)

    def on_merge_accepted(self, event: dict[str, Any]) -> None:
        self._emit("on_merge_accepted", event)

    def on_merge_rejected(self, event: dict[str, Any]) -> None:
        self._emit("on_merge_rejected", event)

    def on_pareto_front_updated(self, event: dict[str, Any]) -> None:
        self.sink.emit("pareto_front_updated", {"new_front": event.get("new_front", []), "displaced_candidates": event.get("displaced_candidates", [])}, iteration=event.get("iteration"))

    def on_state_saved(self, event: dict[str, Any]) -> None:
        self._emit("on_state_saved", event)

    def on_budget_updated(self, event: dict[str, Any]) -> None:
        self._emit("on_budget_updated", event)

    def on_error(self, event: dict[str, Any]) -> None:
        error = str(event.get("exception", "unknown GEPA error"))
        event_type = "reflection_failed" if "reflection" in error.lower() else "error"
        self.sink.emit(event_type, {"message": error, "will_continue": bool(event.get("will_continue"))}, iteration=event.get("iteration"))

    def on_iteration_end(self, event: dict[str, Any]) -> None:
        self._emit("on_iteration_end", event)
        self.completed_iterations += 1
        iteration = int(event["iteration"])
        self._flush_pending_parent_minibatches(iteration)
        self._selected_parent_by_iteration.pop(iteration, None)
        self._proposals_by_iteration.pop(iteration, None)
        self._parent_minibatches.pop(iteration, None)
        self._child_minibatches.pop(iteration, None)
        self._evaluation_row_ids.pop(iteration, None)
        self._evaluation_inputs.pop(iteration, None)
        self._reflection_contexts.pop(iteration, None)
        self.hooks.emit("iteration_completed", event)

    def on_optimization_end(self, event: dict[str, Any]) -> None:
        # GEPA calls this on every normal exit. A budget-bound normal exit is
        # a paused optimization in Orizu's lifecycle, not a completed one.
        # Runtime emits the paired budget_exhausted/run_paused events once it
        # has the final, reconciled budget ledger.
        if self._terminal_budget_exhausted is not None and self._terminal_budget_exhausted(event):
            return
        self._emit("on_optimization_end", event)
        self.hooks.emit("run_completed", event)

    def on_merge_attempted(self, event: dict[str, Any]) -> None:
        # This is the production sink, unlike the focused translator unit seam.
        translate_callback("on_merge_attempted", event, run_id=self.run_id,
                           run_note_sink=self.sink.run_note)
