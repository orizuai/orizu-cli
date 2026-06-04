from __future__ import annotations

import dataclasses
import json
from pathlib import Path
from typing import Any

from .optimizer import DatasetRow, PromptContext, RowEvaluation, TextGepaResult


def _json_default(value: Any) -> Any:
    if dataclasses.is_dataclass(value):
        return dataclasses.asdict(value)
    return str(value)


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False, default=_json_default) + "\n",
        encoding="utf-8",
    )


def _append_jsonl(path: Path, payload: dict[str, Any]) -> None:
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False, default=_json_default) + "\n")


class LocalOptimizationLogger:
    def __init__(self, directory: Path):
        self.directory = directory
        self.directory.mkdir(parents=True, exist_ok=True)

    @classmethod
    def create(cls, root: str | Path, run_id: str) -> "LocalOptimizationLogger":
        return cls(Path(root) / run_id)

    @property
    def path(self) -> str:
        return str(self.directory)

    def write_context(
        self,
        *,
        project: str,
        run_id: str,
        args: dict[str, Any],
        prompt_context: PromptContext,
        scorer_context: PromptContext,
        trainset: list[DatasetRow],
        valset: list[DatasetRow],
        metadata: dict[str, Any],
    ) -> None:
        _write_json(self.directory / "run.json", {
            "schema_version": "orizu.optimization-local-log.v1",
            "optimization_run_id": run_id,
            "project": project,
            "args": args,
            "metadata": metadata,
        })
        _write_json(self.directory / "prompt_context.json", dataclasses.asdict(prompt_context))
        _write_json(self.directory / "scorer_context.json", dataclasses.asdict(scorer_context))
        _write_json(self.directory / "trainset.json", {
            "rows": [dataclasses.asdict(row) for row in trainset],
        })
        _write_json(self.directory / "valset.json", {
            "rows": [dataclasses.asdict(row) for row in valset],
        })

    def append_event(self, event: dict[str, Any]) -> None:
        _append_jsonl(self.directory / "events.jsonl", event)

    def append_evaluations(
        self,
        *,
        stage: str,
        split: str,
        iteration: int | None,
        candidate_id: str,
        parent_candidate_id: str | None = None,
        results: list[RowEvaluation],
    ) -> None:
        for result in results:
            _append_jsonl(self.directory / "evaluations.jsonl", {
                "stage": stage,
                "split": split,
                "iteration": iteration,
                "candidate_id": candidate_id,
                "parent_candidate_id": parent_candidate_id,
                **result.to_payload(),
            })

    def append_reflection(
        self,
        *,
        iteration: int,
        parent_candidate_id: str,
        child_candidate_id: str,
        row_ids: list[str],
        prompt: str,
        response: str,
        candidate_text: str,
    ) -> None:
        _append_jsonl(self.directory / "reflections.jsonl", {
            "iteration": iteration,
            "parent_candidate_id": parent_candidate_id,
            "child_candidate_id": child_candidate_id,
            "row_ids": row_ids,
            "prompt": prompt,
            "response": response,
            "candidate_text": candidate_text,
        })

    def write_result(self, result: TextGepaResult) -> None:
        _write_json(self.directory / "result.json", {
            "optimization_run_id": result.run_id,
            "best_candidate_id": result.best_candidate_id,
            "best_candidate_text": result.best_candidate_text,
            "best_score": result.best_score,
            "seed_score": result.seed_score,
            "promoted_prompt_version_id": result.promoted_prompt_version_id,
            "budget": result.budget.to_payload(),
        })
