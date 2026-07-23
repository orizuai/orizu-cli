from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

from .optimizer import DatasetRow, PromptContext


def _format_number(value: Any) -> str | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return f"{value:g}"
    return None


def _progress_log_suffix(event_type: str, payload: dict[str, Any] | None) -> str:
    if event_type != "optimization_progress" or not isinstance(payload, dict):
        return ""

    percent_value = payload.get("percent")
    if percent_value is None:
        percent_value = payload.get("progress_percent")
    percent = _format_number(percent_value)
    metric_calls_remaining = _format_number(payload.get("metric_calls_remaining"))
    metric_call_budget_value = payload.get("metric_call_budget")
    if metric_call_budget_value is None:
        metric_call_budget_value = payload.get("approx_metric_call_budget")
    metric_call_budget = _format_number(metric_call_budget_value)
    parts: list[str] = []
    if percent is not None:
        parts.append(f"{percent}%")
    if metric_calls_remaining is not None:
        budget_suffix = f" / {metric_call_budget}" if metric_call_budget is not None else ""
        parts.append(f"{metric_calls_remaining}{budget_suffix} metric calls left")

    return f" {'; '.join(parts)}" if parts else ""


@dataclass(frozen=True)
class OrizuClient:
    api_url: str
    token: str
    project: str | None = None
    sequence: int = 0

    @classmethod
    def from_env(cls) -> "OrizuClient":
        api_url = (os.environ.get("ORIZU_API_URL") or "").rstrip("/")
        token = os.environ.get("ORIZU_TOKEN") or ""
        if not api_url or not token:
            raise RuntimeError("ORIZU_API_URL and ORIZU_TOKEN are required. Run: eval \"$(orizu env --project <team>/<project>)\"")
        return cls(api_url=api_url, token=token, project=os.environ.get("ORIZU_PROJECT"))

    def _request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
    ) -> Any:
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            f"{self.api_url}{path}",
            data=data,
            method=method,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                raw = response.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"{method} {path} failed: {error.code} {detail}") from error

    def _request_bytes(self, path: str) -> bytes:
        request = urllib.request.Request(
            f"{self.api_url}{path}",
            method="GET",
            headers={"Authorization": f"Bearer {self.token}"},
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"GET {path} failed: {error.code} {detail}") from error

    def start_run(
        self,
        *,
        project: str,
        optimizer_version_id: str,
        prompt_version_id: str,
        scorer_version_id: str,
        dataset_version_id: str,
        split_set_id: str,
        train_split: str,
        validation_split: str,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        query = urllib.parse.urlencode({"project": project})
        data = self._request("POST", f"/api/cli/optimization-runs?{query}", {
            "optimizerVersionId": optimizer_version_id,
            "promptVersionIds": [prompt_version_id],
            "scorers": [
                {
                    "scorerVersionId": scorer_version_id,
                    "role": "selection",
                },
                {
                    "scorerVersionId": scorer_version_id,
                    "role": "reflection",
                },
            ],
            "datasetVersionId": dataset_version_id,
            "splitSetId": split_set_id,
            "trainSplitName": train_split,
            "validationSplitName": validation_split,
            "metadata": metadata or {},
        })
        return data["optimization_run_id"]

    def fetch_exec_context(
        self,
        *,
        prompt_version_id: str,
        runner_version_id: str,
        dataset_version_id: str,
        split_set_id: str,
        split: str,
    ) -> tuple[PromptContext, list[DatasetRow]]:
        query = urllib.parse.urlencode({
            "promptVersion": prompt_version_id,
            "runnerVersion": runner_version_id,
            "datasetVersion": dataset_version_id,
            "splitSet": split_set_id,
            "split": split,
        })
        data = self._request("GET", f"/api/cli/runners/exec-context?{query}")
        prompt = data["prompt"]
        rows = [
            DatasetRow(id=item["id"], row=item["row"])
            for item in data.get("rows", [])
        ]
        return PromptContext(
            body=prompt.get("body"),
            body_kind=prompt.get("bodyKind") or "text",
            provider_settings=prompt.get("providerSettings") or {},
            prompt_version_id=prompt["promptVersionId"],
            runner_version_id=prompt["runnerVersionId"],
            prompt_id=prompt.get("promptId"),
        ), rows

    def fetch_scorer_exec_context(
        self,
        *,
        scorer_version_id: str,
        runner_version_id: str | None,
        dataset_version_id: str,
        split_set_id: str,
        split: str,
    ) -> tuple[PromptContext, list[DatasetRow]]:
        params = {
            "scorerVersion": scorer_version_id,
            "datasetVersion": dataset_version_id,
            "splitSet": split_set_id,
            "split": split,
        }
        if runner_version_id:
            params["runnerVersion"] = runner_version_id
        query = urllib.parse.urlencode(params)
        data = self._request("GET", f"/api/cli/runners/exec-context?{query}")
        prompt = data["prompt"]
        scorer = data.get("scorer") or {}
        higher_is_better = scorer.get("higherIsBetter")
        if not isinstance(higher_is_better, bool):
            higher_is_better = scorer.get("higher_is_better")
        if not isinstance(higher_is_better, bool):
            higher_is_better = True
        rows = [
            DatasetRow(id=item["id"], row=item["row"])
            for item in data.get("rows", [])
        ]
        return PromptContext(
            body=prompt.get("body"),
            body_kind=prompt.get("bodyKind") or "text",
            provider_settings=prompt.get("providerSettings") or {},
            prompt_version_id=prompt["promptVersionId"],
            runner_version_id=prompt["runnerVersionId"],
            prompt_id=prompt.get("promptId"),
            # The request may use a legacy prompt-version alias. Persist and
            # submit the canonical executable scorer version returned by the
            # server so optimization runs never mix the two ID namespaces.
            scorer_version_id=scorer.get("versionId") or scorer.get("version_id") or scorer_version_id,
            metric_key=scorer.get("metricKey") or scorer.get("metric_key"),
            higher_is_better=higher_is_better,
        ), rows

    def log_event(
        self,
        run_id: str,
        *,
        sequence: int,
        event_type: str,
        payload: dict[str, Any] | None = None,
        event_layer: str = "core",
        optimizer_family: str = "gepa",
        iteration: int | None = None,
        candidate_id: str | None = None,
        parent_candidate_id: str | None = None,
        child_candidate_id: str | None = None,
    ) -> None:
        event_id = f"orizu-gepa-{run_id}-{sequence}"
        self._request("POST", f"/api/cli/optimization-runs/{urllib.parse.quote(run_id)}/events", {
            "eventId": event_id,
            "sequence": sequence,
            "eventType": event_type,
            "eventLayer": event_layer,
            "optimizerFamily": optimizer_family,
            "iteration": iteration,
            "candidateId": candidate_id,
            "parentCandidateId": parent_candidate_id,
            "childCandidateId": child_candidate_id,
            "payload": payload or {},
        })

    def promote_candidate(
        self,
        run_id: str,
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
        data = self._request("POST", f"/api/cli/optimization-runs/{urllib.parse.quote(run_id)}/promote", {
            "candidateId": candidate_id,
            "promptId": prompt_id,
            "parentPromptVersionId": parent_prompt_version_id,
            "body": body,
            "bodyKind": body_kind,
            "providerSettings": provider_settings,
            "runnerVersionId": runner_version_id,
            "label": label,
        })
        return data["promptVersionId"]

    def update_run(
        self,
        run_id: str,
        *,
        status: str,
        best_score: float | None = None,
        best_candidate_id: str | None = None,
        result_prompt_version_id: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        body: dict[str, Any] = {"status": status}
        if best_score is not None:
            body["bestScore"] = best_score
        if best_candidate_id:
            body["bestCandidateId"] = best_candidate_id
        if result_prompt_version_id:
            body["resultPromptVersionId"] = result_prompt_version_id
        if metadata:
            body["metadata"] = metadata
        self._request("PATCH", f"/api/cli/optimization-runs/{urllib.parse.quote(run_id)}", body)


class OrizuEventSink:
    def __init__(
        self,
        client: OrizuClient,
        run_id: str,
        *,
        fail_on_log_error: bool = True,
        max_log_retries: int = 2,
        local_logger: Any | None = None,
    ):
        self.client = client
        self.run_id = run_id
        self.sequence = 0
        self.fail_on_log_error = fail_on_log_error
        self.max_log_retries = max(0, max_log_retries)
        self.local_logger = local_logger

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
        self.sequence += 1
        local_event = {
            "run_id": self.run_id,
            "sequence": self.sequence,
            "event_type": event_type,
            "event_layer": event_layer,
            "optimizer_family": optimizer_family,
            "iteration": iteration,
            "candidate_id": candidate_id,
            "parent_candidate_id": parent_candidate_id,
            "child_candidate_id": child_candidate_id,
            "payload": payload or {},
        }
        if self.local_logger is not None:
            self.local_logger.append_event(local_event)
        last_error: Exception | None = None
        for attempt in range(self.max_log_retries + 1):
            try:
                self.client.log_event(
                    self.run_id,
                    sequence=self.sequence,
                    event_type=event_type,
                    payload=payload,
                    event_layer=event_layer,
                    optimizer_family=optimizer_family,
                    iteration=iteration,
                    candidate_id=candidate_id,
                    parent_candidate_id=parent_candidate_id,
                    child_candidate_id=child_candidate_id,
                )
                print(
                    f"[orizu-gepa] {self.sequence:03d} {event_type}{_progress_log_suffix(event_type, payload)}",
                    flush=True,
                )
                return
            except Exception as exc:
                last_error = exc
                if attempt < self.max_log_retries:
                    time.sleep(0.25 * (2 ** attempt))

        if self.fail_on_log_error and last_error is not None:
            raise last_error
        print(
            f"[orizu-gepa] {self.sequence:03d} {event_type} log failed: {last_error}",
            flush=True,
        )

    def promote_candidate(self, **kwargs: Any) -> str:
        prompt_version_id = self.client.promote_candidate(self.run_id, **kwargs)
        # Promotion writes a system event at max(sequence)+1 in Postgres.
        self.sequence += 1
        if self.local_logger is not None:
            self.local_logger.append_event({
                "run_id": self.run_id,
                "sequence": self.sequence,
                "event_type": "candidate_promoted",
                "event_layer": "system",
                "optimizer_family": "gepa",
                "iteration": None,
                "candidate_id": kwargs.get("candidate_id"),
                "parent_candidate_id": None,
                "child_candidate_id": None,
                "payload": {
                    **kwargs,
                    "prompt_version_id": prompt_version_id,
                },
            })
        return prompt_version_id

    def finish_run(self, **kwargs: Any) -> None:
        if self.local_logger is not None:
            self.sequence += 1
            self.local_logger.append_event({
                "run_id": self.run_id,
                "sequence": self.sequence,
                "event_type": "run_status_updated",
                "event_layer": "system",
                "optimizer_family": "gepa",
                "iteration": None,
                "candidate_id": kwargs.get("best_candidate_id"),
                "parent_candidate_id": None,
                "child_candidate_id": None,
                "payload": kwargs,
            })
        self.client.update_run(self.run_id, **kwargs)
