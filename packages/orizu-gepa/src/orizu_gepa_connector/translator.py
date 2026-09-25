"""Translate official-GEPA callbacks into Orizu's established event envelope."""

from __future__ import annotations

from collections.abc import Callable
import json
from typing import Any


TRUNCATION_MARKER = "…[truncated]"


def _candidate_id(value: Any) -> str | None:
    if value is None:
        return None
    return str(value)


def bounded(value: Any, limit: int | None) -> tuple[Any, int | None]:
    """Cap one disclosure value; return it and, if cut, its original UTF-8 byte length.

    This is the single bounding primitive for the connector; ``callbacks``
    imports it for the minibatch row outputs it bounds before translation.

    Strings are cut as text. Dicts and lists are cut as their rendered JSON so a
    large structured sample output is bounded the same way as a large string.
    """
    if isinstance(value, str):
        rendered = value
    elif isinstance(value, (dict, list)):
        rendered = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    else:
        return value, None
    if limit is None or len(rendered) <= limit:
        return value, None
    return rendered[:limit] + TRUNCATION_MARKER, len(rendered.encode("utf-8"))


def _bounded_map(values: Any, limit: int | None, prefix: str) -> tuple[Any, dict[str, int]]:
    """Bound a per-component map, or a bare legacy value, and name every cut.

    GEPA's ``prompts``/``raw_lm_outputs`` are normally ``{component: text}``:
    each value is bounded on its own and a cut is disclosed as
    ``"<prefix>.<component>"``. A non-dict value (the legacy single-callable
    shape) is bounded as one value and a cut is disclosed under the bare
    ``"<prefix>"`` key. The returned value keeps the input's shape.
    """
    if not isinstance(values, dict):
        bounded_value, cut = bounded(values, limit)
        return bounded_value, ({prefix: cut} if cut is not None else {})
    result: dict[Any, Any] = {}
    truncated: dict[str, int] = {}
    for key, value in values.items():
        bounded_value, cut = bounded(value, limit)
        result[key] = bounded_value
        if cut is not None:
            truncated[f"{prefix}.{key}"] = cut
    return result, truncated


def _components(candidate: Any) -> dict[str, str]:
    """Return the candidate's components exactly as evaluated.

    A candidate is the thing an optimization run exists to produce (ORI-2027):
    it is never bounded by ``max_payload_chars``, which exists for sample
    outputs and reflection material. A cut candidate could not be read back or
    promoted faithfully.
    """
    if not isinstance(candidate, dict):
        return {}
    return {
        key: value for key, value in candidate.items()
        if isinstance(key, str) and isinstance(value, str)
    }


def _row_results(event: dict[str, Any], limit: int | None) -> tuple[list[dict[str, Any]], dict[str, int]]:
    scores = event.get("scores_by_val_id") or event.get("scores_by_id") or {}
    outputs = event.get("outputs_by_val_id") or event.get("outputs_by_id") or {}
    feedbacks = event.get("feedbacks_by_val_id") or {}
    errors = event.get("errors_by_val_id") or {}
    truncated: dict[str, int] = {}
    if not isinstance(scores, dict):
        return [], truncated
    rows = []
    for row_id, score in scores.items():
        output = outputs.get(row_id) if isinstance(outputs, dict) else None
        side_info = output if isinstance(output, dict) else {}
        adapter_row_id = side_info.get("row_id")
        if adapter_row_id is None and str(row_id).isdigit():
            raise ValueError(
                "official GEPA callback carried positional row id without adapter row identity"
            )
        feedback = feedbacks.get(row_id) if isinstance(feedbacks, dict) else None
        error = errors.get(row_id) if isinstance(errors, dict) else None
        resolved_row_id = str(adapter_row_id if adapter_row_id is not None else row_id)
        bounded_output, cut = bounded(side_info.get("output", output), limit)
        if cut is not None:
            truncated[f"row_results.{resolved_row_id}.output"] = cut
        rows.append({
            "row_id": resolved_row_id,
            "score": score if isinstance(score, (int, float)) else None,
            # Official GEPA's typed callback has no feedback fields. The
            # adapter therefore carries them in its rollout side-info; accept
            # explicit callback maps too for forward compatibility.
            "feedback": feedback if feedback is not None else side_info.get("feedback"),
            "error": error if error is not None else side_info.get("error"),
            "output": bounded_output,
        })
    return rows, truncated


def translate_callback(event_name: str, event: dict[str, Any], *, run_id: str, **options: Any) -> dict[str, Any]:
    """Return an Orizu event for one official callback.

    ``max_payload_chars`` is deliberately characters, not bytes: the payload
    disclosure retains original UTF-8 byte lengths for auditability. It bounds
    sample outputs and reflection prompts/responses only; candidate components
    are always carried whole.
    """
    max_chars = options.get("max_payload_chars")
    if max_chars is not None and (not isinstance(max_chars, int) or max_chars <= 0):
        raise ValueError("max_payload_chars must be a positive integer")

    iteration = event.get("iteration")
    candidate_id = _candidate_id(event.get("candidate_idx", event.get("new_candidate_idx")))
    parent_ids = event.get("parent_ids")
    parent_candidate_id = (
        _candidate_id(parent_ids[0])
        if isinstance(parent_ids, (list, tuple)) and parent_ids else None
    )
    candidate = (
        event.get("candidate")
        or event.get("new_instructions")
        or event.get("seed_candidate")
        or event.get("parent_candidate")
        or {}
    )
    components = _components(candidate)
    truncation: dict[str, int] = {}
    payload: dict[str, Any] = {"components": components} if components else {}
    translated_name = event_name.removeprefix("on_")
    event_type = translated_name

    if event_name == "on_optimization_start":
        event_type = "run_started"
        payload.pop("components", None)
        payload.update({
            "seed_candidate_text": next(iter(components.values()), None),
            "seed_components": components,
            "trainset_size": event.get("trainset_size"),
            "valset_size": event.get("valset_size"),
        })
    elif event_name == "on_iteration_start":
        event_type = "iteration_started"
    elif event_name == "on_iteration_end":
        event_type = "iteration_completed"
        payload.update({
            "accepted": event.get("proposal_accepted"),
            "skipped_reflection": event.get("skipped_reflection", False),
        })
    elif event_name == "on_optimization_end":
        event_type = "run_completed"
        payload.update({
            "best_candidate_id": _candidate_id(event.get("best_candidate_idx")),
            "total_iterations": event.get("total_iterations"),
            "total_metric_calls": event.get("total_metric_calls"),
        })
    elif event_name == "on_candidate_accepted":
        event_type = "acceptance_decision_made"
        payload.update({
            "accepted": True,
            "proceed_to_valset": True,
            "parent_score_total": event.get("parent_score_total"),
            "child_score_total": event.get("child_score_total", event.get("new_score")),
        })
    elif event_name == "on_candidate_rejected":
        event_type = "acceptance_decision_made"
        payload.update({
            "accepted": False,
            "proceed_to_valset": False,
            "parent_score_total": event.get("parent_score_total", event.get("old_score")),
            "child_score_total": event.get("child_score_total", event.get("new_score")),
            "reason": event.get("reason"),
        })
    elif event_name == "on_evaluation_skipped":
        event_type = "reflection_skipped"
        skipped_scores = event.get("scores") or []
        payload.update({"reason": event.get("reason"), "parent_score_mean": (sum(skipped_scores) / len(skipped_scores)) if skipped_scores else None})
    elif event_name == "on_valset_evaluated":
        is_seed = iteration == 0 and candidate_id in {"0", "seed"}
        event_type = "seed_val_set_completed" if is_seed else "child_val_set_completed"
        rows, row_truncation = _row_results(event, max_chars)
        truncation.update(row_truncation)
        payload.update({
            "candidate_id": "seed" if is_seed else candidate_id,
            "split": "validation",
            "score_mean": event.get("average_score"),
            "row_results": rows,
            "is_new_best": bool(event.get("is_best_program")),
        })
    elif event_name == "on_proposal_end":
        event_type = "reflection_completed"
        # GEPA fills these maps per component (one entry per selected
        # component under ``all``). ``prompt``/``response`` keep the legacy
        # first-entry dashboard shape; ``prompts``/``responses`` carry every
        # component's reflection so none is lost (ORI-2030).
        raw = event.get("raw_lm_outputs")
        response = next(iter(raw.values()), None) if isinstance(raw, dict) else raw
        prompts = event.get("prompts")
        prompt = next(iter(prompts.values()), None) if isinstance(prompts, dict) else prompts
        bounded_prompt, prompt_cut = bounded(prompt, max_chars)
        bounded_response, response_cut = bounded(response, max_chars)
        if prompt_cut is not None:
            truncation["prompt"] = prompt_cut
        if response_cut is not None:
            truncation["response"] = response_cut
        payload.update({
            "prompt": bounded_prompt,
            "response": bounded_response,
            "candidate_text": next(iter(components.values()), None),
        })
        if isinstance(prompts, dict):
            payload["prompts"], prompts_truncation = _bounded_map(prompts, max_chars, "prompts")
            truncation.update(prompts_truncation)
        if isinstance(raw, dict):
            payload["responses"], responses_truncation = _bounded_map(raw, max_chars, "responses")
            truncation.update(responses_truncation)
    elif event_name == "on_budget_updated":
        budget_kind = options.get("budget_kind", "max_metric_calls")
        budget_limit = options.get("budget_limit")
        if budget_kind == "max_metric_calls":
            used = event.get("metric_calls_used")
            remaining = event.get("metric_calls_remaining")
        elif budget_kind == "max_iterations":
            used = event.get("iteration", 0)
            remaining = max(0, budget_limit - used) if isinstance(budget_limit, int) else None
        else:
            used = event.get("num_full_ds_evals", event.get("iteration", 0))
            remaining = max(0, budget_limit - used) if isinstance(budget_limit, int) else None
        event_type = "optimization_progress"
        payload = {
            "budget_kind": budget_kind,
            "used": used,
            "metric_calls_used": event.get("metric_calls_used"),
            "metric_calls_remaining": event.get("metric_calls_remaining"),
            "limit": budget_limit,
            "budget_limit": budget_limit,
            "metric_call_budget": options.get("approx_metric_call_limit") if budget_kind != "max_iterations" else None,
            "remaining": remaining,
        }
    elif event_name == "on_merge_attempted":
        note = {
            "eventType": "run_note", "eventLayer": "extension", "optimizerFamily": "gepa",
            "payload": {"code": "unsupported_gepa_merge", "message": "unsupported GEPA merge: two-parent candidates cannot be rendered"},
        }
        sink = options.get("run_note_sink")
        if isinstance(sink, Callable):
            sink(note)
        raise ValueError("unsupported GEPA merge: two-parent candidates cannot be rendered")

    if truncation:
        payload["payload_truncated"] = True
        payload["truncation"] = {"fields": truncation}
    return {
        "runId": run_id, "eventType": event_type, "optimizerFamily": "gepa", "iteration": iteration,
        "candidateId": "seed" if event_name == "on_valset_evaluated" and iteration == 0 and candidate_id in {"0", "seed"} else candidate_id,
        "parentCandidateId": parent_candidate_id, "childCandidateId": None,
        "payload": payload,
    }
