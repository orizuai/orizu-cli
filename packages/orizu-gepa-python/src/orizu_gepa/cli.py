from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from .client import OrizuClient, OrizuEventSink
from .optimizer import TextGepaConfig, optimize_loaded_text_candidate
from .reflection import reflect_with_provider
from .runner import make_candidate_runner, make_scorer_runner


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be positive")
    return parsed


def read_text_arg(value: str | None) -> str | None:
    if value is None:
        return None
    if value.startswith("@"):
        return Path(value[1:]).read_text()
    path = Path(value)
    if path.exists():
        return path.read_text()
    return value


def read_json_object_arg(value: str | None, flag_name: str) -> dict[str, Any] | None:
    text = read_text_arg(value)
    if text is None:
        return None
    parsed = json.loads(text)
    if not isinstance(parsed, dict):
        raise RuntimeError(f"{flag_name} must be a JSON object")
    return parsed


def main() -> None:
    parser = argparse.ArgumentParser(prog="orizu-gepa")
    parser.add_argument("--project", required=True)
    parser.add_argument("--optimizer-version-id", required=True)
    parser.add_argument("--candidate-version-id", required=True)
    parser.add_argument("--runner-version-id", required=True)
    parser.add_argument("--candidate-runner-dir", required=True)
    parser.add_argument("--scorer-version-id", required=True)
    parser.add_argument("--scorer-runner-version-id", required=True)
    parser.add_argument("--scorer-runner-dir", required=True)
    parser.add_argument("--dataset-version-id", required=True)
    parser.add_argument("--split-set-id", required=True)
    parser.add_argument("--train-split", default="train")
    parser.add_argument("--val-split", default="validation")
    parser.add_argument("--budget", default="light", choices=["auto", "light", "medium", "high"])
    parser.add_argument("--max-iterations", type=positive_int, default=3)
    parser.add_argument("--minibatch-size", type=positive_int, default=3)
    parser.add_argument(
        "--candidate-selection-strategy",
        default=TextGepaConfig.candidate_selection_strategy,
        choices=["pareto", "current_best", "epsilon_greedy"],
    )
    parser.add_argument("--epsilon", type=float, default=TextGepaConfig.epsilon)
    parser.add_argument("--disable-evaluation-cache", action="store_true")
    parser.add_argument("--max-metric-calls", type=positive_int)
    parser.add_argument("--max-full-evals", type=positive_int)
    parser.add_argument("--reflection-model", default=TextGepaConfig.reflection_model)
    parser.add_argument("--reflection-temperature", type=float)
    parser.add_argument("--reflection-prompt-template")
    parser.add_argument("--reflection-provider-settings")
    parser.add_argument("--objective", default=TextGepaConfig.objective)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--auto-promote", action="store_true")
    parser.add_argument("--promotion-label")
    parser.add_argument("--log-row-snapshots", action="store_true")
    parser.add_argument("--metadata", default="{}")
    args = parser.parse_args()

    metadata = json.loads(args.metadata)
    if not isinstance(metadata, dict):
        raise RuntimeError("--metadata must be a JSON object")

    config = TextGepaConfig(
        budget=args.budget,
        max_iterations=args.max_iterations,
        minibatch_size=args.minibatch_size,
        candidate_selection_strategy=args.candidate_selection_strategy,
        epsilon=args.epsilon,
        max_metric_calls=args.max_metric_calls,
        max_full_evals=args.max_full_evals,
        reflection_model=args.reflection_model,
        reflection_temperature=args.reflection_temperature,
        reflection_prompt_template=read_text_arg(args.reflection_prompt_template),
        reflection_provider_settings=read_json_object_arg(args.reflection_provider_settings, "--reflection-provider-settings") or {},
        objective=args.objective,
        seed=args.seed,
        auto_promote=args.auto_promote,
        promotion_label=args.promotion_label,
        cache_evaluations=not args.disable_evaluation_cache,
        log_row_snapshots=args.log_row_snapshots,
    )
    client = OrizuClient.from_env()
    prompt_context, trainset = client.fetch_exec_context(
        prompt_version_id=args.candidate_version_id,
        runner_version_id=args.runner_version_id,
        dataset_version_id=args.dataset_version_id,
        split_set_id=args.split_set_id,
        split=args.train_split,
    )
    _, valset = client.fetch_exec_context(
        prompt_version_id=args.candidate_version_id,
        runner_version_id=args.runner_version_id,
        dataset_version_id=args.dataset_version_id,
        split_set_id=args.split_set_id,
        split=args.val_split,
    )
    scorer_context, _ = client.fetch_scorer_exec_context(
        scorer_version_id=args.scorer_version_id,
        runner_version_id=args.scorer_runner_version_id,
        dataset_version_id=args.dataset_version_id,
        split_set_id=args.split_set_id,
        split=args.val_split,
    )

    run_id = client.start_run(
        project=args.project,
        optimizer_version_id=args.optimizer_version_id,
        prompt_version_id=args.candidate_version_id,
        scorer_version_id=args.scorer_version_id,
        dataset_version_id=args.dataset_version_id,
        split_set_id=args.split_set_id,
        train_split=args.train_split,
        validation_split=args.val_split,
        metadata={
            **metadata,
            "optimizer_package": "orizu-gepa-python",
            "optimizer_family": "gepa",
            "mode": "text-candidate",
            "inference_lm": prompt_context.provider_settings.get("model"),
            "reflection_lm": config.reflection_model,
            "scorer_lm": scorer_context.provider_settings.get("model"),
            "dataset_size": len(trainset) + len(valset),
            "train_count": len(trainset),
            "validation_count": len(valset),
        },
    )
    print(f"[orizu-gepa] started optimization run {run_id}", flush=True)

    result = optimize_loaded_text_candidate(
        run_id=run_id,
        prompt_context=prompt_context,
        scorer_context=scorer_context,
        trainset=trainset,
        valset=valset,
        candidate_runner=make_candidate_runner(Path(args.candidate_runner_dir), run_id),
        scorer_runner=make_scorer_runner(Path(args.scorer_runner_dir), run_id),
        reflector=reflect_with_provider,
        event_sink=OrizuEventSink(client, run_id, fail_on_log_error=config.fail_on_log_error),
        config=config,
    )
    print(json.dumps({
        "optimization_run_id": result.run_id,
        "best_candidate_id": result.best_candidate_id,
        "best_score": result.best_score,
        "seed_score": result.seed_score,
        "promoted_prompt_version_id": result.promoted_prompt_version_id,
        "budget": result.budget.to_payload(),
    }))


if __name__ == "__main__":
    main()
