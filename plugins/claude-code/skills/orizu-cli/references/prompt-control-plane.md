# Prompt Control Plane

Use this reference for the Phase 0 prompt, judge, scorer, runner, score, run, and optimization event control plane. These commands are for coding agents that need to push local artifacts into Orizu, run them locally, submit scores, and stream optimization progress back to the platform.

## Contents

- [Default Command Strategy](#default-command-strategy)
- [Artifact Contracts](#artifact-contracts)
- [Command Matrix](#command-matrix)
- [Optimization Event Logging](#optimization-event-logging)
- [End-to-End Flow](#end-to-end-flow)
- [Notes and Limits](#notes-and-limits)

## Default Command Strategy

1. Verify auth: `orizu --local whoami`.
2. Export API context for scripts: `eval "$(orizu --local env --project <team>/<project>)"`.
3. Create immutable dataset versions before creating splits.
4. Push runners before prompts, judges, or prompt-runner scorers; prompt versions pin runner versions.
5. Register scorers after their backing prompt/runner exists, then bind headline/tracked scorers to prompts when the UI should show those metrics.
6. Use `runners exec` to prove the runner contract locally before submitting runs or score runs.
7. For common text-candidate optimization, prefer `orizu optimizations run-gepa`; it starts the run and logs events for you.
8. After `run-gepa`, inspect `logs/<optimization_run_id>` first; it is the complete local trace for coding-agent analysis.
9. Use `orizu optimizations export <run-id> --out <run-id>.optimization.json` when the local log is missing or the run happened elsewhere.
10. Write and attach a markdown report for finished, failed, or cancelled runs; use `optimization-reports.md` for structure and diagnostic guidance.
11. For custom optimizers, start an optimization run before local execution, then stream events into that run.
12. Use bare HTTP for optimization events; use `orizu log` only as a shell fallback.
13. Promote only accepted candidates; rejected candidates stay in optimization events.

Customer model-provider secrets stay local. Do not upload Anthropic/OpenAI/etc. API keys to Orizu.

Execution/privacy defaults:

- Runner subprocesses receive only the file-contract paths plus a small allowlist of provider/runtime environment variables. Orizu API tokens are not passed into runner processes.
- `orizu optimizations run-gepa` redacts dataset row payloads and reflection text in logged events by default. Use `--log-row-snapshots` only when the customer explicitly wants raw row and prompt text in the optimization event stream.
- `run-gepa` still writes complete local traces under `logs/<optimization_run_id>` by default. Treat those logs as sensitive: they include row inputs, model outputs, scores, feedback, scorer responses, reflection prompts, reflection responses, and candidate text.
- Runner artifacts, runner output, score result uploads, and optimization event payloads are size-capped. If a run needs larger observability payloads, store the large artifact separately and log a pointer.

## Artifact Contracts

### Runner Directory

Required file: `manifest.json`.

```json
{
  "name": "hip-note-judge-runner",
  "description": "Scores one HIP note row with the judge prompt.",
  "language": "python",
  "command": ["python3", "runner.py"],
  "supports_body_kinds": ["text"]
}
```

For `runners exec`, the command must read input JSON from `ORIZU_RUNNER_INPUT_PATH` and write output JSON to `ORIZU_RUNNER_OUTPUT_PATH`.

Input shape:

```json
{
  "row": { "opaque": "dataset row object" },
  "prompt": {
    "body": "prompt body or null",
    "body_kind": "text",
    "provider_settings": {
      "model": "claude-sonnet-4-6",
      "temperature": 0,
      "max_tokens": 4096
    }
  },
  "prompt_version_id": "uuid",
  "runner_version_id": "uuid",
  "run_id": null
}
```

Output shape:

```json
{
  "model_response": "parsed response or structured JSON",
  "raw_api_response": {},
  "token_in": 1234,
  "token_out": 567,
  "latency_ms": 1890,
  "cost_usd": 0.0123,
  "score": 0.8,
  "feedback": "optional judge rationale",
  "error": null
}
```

Exit non-zero only for infrastructure failures. Row-level model or parsing errors should usually be represented in the output JSON with `error`.

### Prompt Or Judge Directory

Required files: `orizu.prompt.json` plus the body file referenced by `body_file`.

Generator prompt:

```json
{
  "name": "hip-note-generator",
  "role": "production_inference",
  "description": "Generates a HIP note label.",
  "body_file": "prompt.md",
  "body_kind": "text",
  "version_label": "v1",
  "provider_settings": {
    "model": "claude-sonnet-4-6",
    "temperature": 0,
    "max_tokens": 4096
  },
  "provenance": {
    "kind": "coding-agent-edit"
  }
}
```

Judge prompt:

```json
{
  "name": "hip-note-judge",
  "role": "judge_per_row",
  "description": "Scores generated HIP notes row by row.",
  "body_file": "judge.md",
  "body_kind": "text",
  "version_label": "v1",
  "provider_settings": {
    "model": "claude-sonnet-4-6",
    "temperature": 0,
    "max_tokens": 4096
  },
  "provenance": {
    "kind": "coding-agent-edit"
  }
}
```

Judges are prompts with `role: "judge_per_row"` or `role: "judge_per_run"`.

### Scorer Manifest

Scorers define metrics. The executable code still lives in a runner version, and LLM judge text still lives in a prompt version.

Prompt-runner row scorer:

```json
{
  "name": "hip-note-judge-score",
  "description": "Scores HIP note candidates row by row.",
  "mode": "row",
  "implementation_kind": "prompt_runner",
  "metric_key": "judge_score",
  "metric_label": "Judge score",
  "score_format": "percent",
  "higher_is_better": true,
  "requires_dataset": true,
  "prompt_version_id": "judge-prompt-version-uuid",
  "runner_version_id": "judge-runner-version-uuid"
}
```

Set scorers aggregate over a set and can be used for headline, selection, or tracked reporting. They cannot be used as GEPA reflection scorers because reflection needs per-row feedback.

Use `orizu scorers exec` for scorer-level evaluation. Builtin set scorers run server-side over dataset rows plus subject results or dependency score-run evidence, then submit one canonical `score_runs` row by default. `runners exec --scorer-version` remains a low-level compatibility command that invokes a runner once per dataset row and writes JSONL row results.

Set scorer example for judge-vs-gold Cohen's kappa:

```json
{
  "name": "staged-actions-judge-kappa",
  "description": "Measures batch-level agreement between the staged-actions judge and human labels.",
  "mode": "set",
  "implementation_kind": "builtin_metric",
  "builtin_metric": "cohens_kappa",
  "metric_key": "cohens_kappa",
  "metric_label": "Cohen's kappa",
  "score_format": "number",
  "score_min": -1,
  "score_max": 1,
  "higher_is_better": true,
  "requires_dataset": true,
  "dependencies": [
    {
      "kind": "row_scorer",
      "alias": "judge",
      "scorer_version_id": "row-scorer-version-uuid"
    }
  ],
  "input_mapping": {
    "gold_label": "$row.gold_label",
    "predicted_label": "$dependencies.judge.model_response.label"
  },
  "builtin_metric_config": {
    "positive_class": "flag"
  },
  "dataset_requirements": {
    "required_fields": ["gold_label"]
  },
  "diagnostics_schema": {
    "sample_size": "number",
    "accuracy": "number",
    "confusion_matrix": "object",
    "flag_recall": "number",
    "flag_precision": "number",
    "ok_recall": "number",
    "ok_precision": "number"
  }
}
```

### Optimizer Directory

Required file: `manifest.json`.

```json
{
  "name": "hip-gepa-optimizer",
  "description": "Local GEPA-style optimizer for HIP judge prompt.",
  "language": "python",
  "entrypoint": "run_logged_optimization.py",
  "optimizer_family": "gepa"
}
```

The CLI stores optimizer zips and metadata. Phase 0 optimizer execution remains local.

## Command Matrix

### Environment

```bash
orizu --local login
orizu --local whoami
eval "$(orizu --local env --project <team>/<project>)"
```

`orizu env` exports `ORIZU_API_URL`, `ORIZU_TOKEN`, `ORIZU_PROJECT_ID`, and `ORIZU_PROJECT`.

### Dataset Versions And Splits

```bash
orizu --local datasets versions create <dataset-id-or-name> \
  --project <team>/<project> \
  --label v1 \
  --json
```

Returns `dataset_version_id`.

Create ratio-based splits:

```bash
orizu --local datasets splits create <dataset-version-id> \
  --name default \
  --seed 42 \
  --train 0.6 \
  --validation 0.4 \
  --test 0 \
  --json
```

Create predefined, Hugging Face-style splits:

```json
{
  "name": "default",
  "strategy": "predefined",
  "seed": 42,
  "partitions": [
    { "name": "train", "row_ids": ["row-1", "row-2"] },
    { "name": "validation", "row_ids": ["row-3"] },
    { "name": "test", "row_ids": [] }
  ]
}
```

```bash
orizu --local datasets splits create <dataset-version-id> \
  --from-file ./split.json \
  --json
```

Returns `split_set_id`.

### Runners

```bash
orizu --local runners push ./runner \
  --project <team>/<project> \
  --name hip-note-judge-runner \
  --label default \
  --json
```

Returns `runner_version_id`.

Execute against a dataset split:

```bash
orizu --local runners exec \
  --prompt-version <prompt-version-id> \
  --runner-version <runner-version-id> \
  --dataset-version <dataset-version-id> \
  --split-set <split-set-id-or-name> \
  --split validation \
  --runner-dir ./runner \
  --out ./results.jsonl
```

Omit `--runner-dir` to download and materialize the pinned runner version from Orizu. `--out` may end in `.jsonl` or `.jsonl.gz`.

### Prompts And Judges

```bash
orizu --local prompts push ./prompt \
  --project <team>/<project> \
  --runner-version <runner-version-id> \
  --json

orizu --local judges push ./judge \
  --project <team>/<project> \
  --runner-version <judge-runner-version-id> \
  --json
```

Both commands return `prompt_version_id`.

List:

```bash
orizu --local prompts list --project <team>/<project>
orizu --local prompts list --project <team>/<project> --status archived
orizu --local prompts list --project <team>/<project> --status all
orizu --local judges list --project <team>/<project>
```

Prompt and judge lists show active artifacts by default. Use `--status archived`
or `--status all` when you need archived artifacts.

Archive or restore a prompt:

```bash
orizu --local prompts archive <prompt-id-or-name> --project <team>/<project>
orizu --local prompts restore <prompt-id-or-name> --project <team>/<project>
```

List prompt comment threads for the latest version, or a specific label/version:

```bash
orizu --local prompts comments <prompt-id-or-name> \
  --project <team>/<project> \
  [--label production | --version <prompt-version-id>] \
  [--json]
```

Human output shows the thread count, open/resolved counts, selected prompt text or source line, each top-level comment body, and replies. Use `--json` when an agent or script needs structured `summary` and `comments` data. Check unresolved comments before drafting or pushing the next prompt version.

Move a mutable label:

```bash
orizu --local prompts labels set hip-note-judge production \
  --project <team>/<project> \
  --version <prompt-version-id> \
  --json
```

### Scorers And Scores

Register a scorer after its backing prompt and runner versions exist:

```bash
orizu --local scorers register \
  --project <team>/<project> \
  --name hip-note-judge-score \
  --manifest ./scorer.manifest.json \
  --prompt-version <judge-prompt-version-id> \
  --runner-version <judge-runner-version-id> \
  --label production \
  --json
```

Returns `scorer_version_id`.

Inspect scorers:

```bash
orizu --local scorers list --project <team>/<project>
orizu --local scorers detail <scorer-id-or-name> --project <team>/<project> --json
orizu --local scorers labels set hip-note-judge-score production \
  --project <team>/<project> \
  --version <scorer-version-id> \
  --json
```

Use scorer versions directly with the runner contract:

```bash
orizu --local runners exec \
  --scorer-version <scorer-version-id> \
  --dataset-version <dataset-version-id> \
  --split-set <split-set-id-or-name> \
  --split validation \
  --runner-dir ./scorer-runner \
  --out ./scores.jsonl
```

Submit score results for a prompt version:

```bash
orizu --local scores submit ./scores.jsonl \
  --project <team>/<project> \
  --scorer-version <scorer-version-id> \
  --subject-version <prompt-version-id> \
  --dataset-version <dataset-version-id> \
  --split-set <split-set-id> \
  --split validation \
  --json
```

For row scorer files, `.jsonl`, `.jsonl.gz`, or `.json` arrays are normalized into `resultsJsonl` and the server computes the mean unless the request body supplies an explicit score. Row objects may use `row_score`, `rowScore`, `score`, `judge_score`, or `passed`.

```bash
orizu --local scorers exec \
  --project <team>/<project> \
  --scorer-version <set-scorer-version-id> \
  --subject-version <prompt-version-id> \
  --dataset-version <dataset-version-id> \
  --split-set <split-set-id> \
  --split validation \
  --dependency-score-run judge=<row-score-run-id> \
  --out ./set-score.json
```

For builtin set scorers, `scorers exec` computes the aggregate and submits it by default. Use `--no-submit` to only write the aggregate object. Use `--dependency-results judge=./judge-results.jsonl` when the row-scorer evidence is local instead of already stored in a score run; use `--subject-results ./outputs.jsonl` for direct subject-output aggregation. Current builtin metrics are `cohens_kappa`, `accuracy`, `precision`, `recall`, and `f1`.

If you already computed the aggregate locally, submit the aggregate object explicitly:

```bash
orizu --local scores submit ./set-score.json \
  --aggregate \
  --project <team>/<project> \
  --scorer-version <set-scorer-version-id> \
  --subject-version <prompt-version-id> \
  --dataset-version <dataset-version-id> \
  --split-set <split-set-id> \
  --split validation
```

Aggregate JSON shape:

```json
{
  "scorerVersionId": "set-scorer-version-uuid",
  "subjectPromptVersionId": "prompt-version-uuid",
  "datasetVersionId": "dataset-version-uuid",
  "splitSetId": "split-set-uuid",
  "splitName": "validation",
  "scoreValue": 0.42,
  "rowCount": 15,
  "scoredRowCount": 15,
  "diagnostics": {
    "sample_size": 15,
    "accuracy": 0.73,
    "confusion_matrix": {
      "tp": 5,
      "fn": 1,
      "fp": 3,
      "tn": 6,
      "positive_class": "flag"
    },
    "flag_recall": 0.83,
    "flag_precision": 0.63,
    "ok_recall": 0.67,
    "ok_precision": 0.86
  },
  "feedbackSummary": "Kappa is positive but noisy on n=15; misses are concentrated in borderline staged-action rows.",
  "rowEvidence": [
    {
      "row_id": "row-1",
      "gold_label": "flag",
      "predicted_label": "flag",
      "row_score": 1
    },
    {
      "row_id": "row-2",
      "gold_label": "ok",
      "predicted_label": "flag",
      "row_score": 0
    }
  ],
  "dependencyScoreRunIds": [
    {
      "alias": "judge",
      "scoreRunId": "row-score-run-uuid"
    }
  ]
}
```

For optimization candidate set scores, replace `subjectPromptVersionId` with `optimizationRunId` plus `candidateId`.

When `--aggregate` is omitted, the CLI still detects aggregate-looking JSON objects and preserves them with a warning. Use `--aggregate` in automation so intent is unambiguous.

Submit score results for an optimization candidate:

```bash
orizu --local scores submit ./candidate-scores.jsonl \
  --project <team>/<project> \
  --scorer-version <scorer-version-id> \
  --optimization-run <optimization-run-id> \
  --candidate <candidate-id> \
  --dataset-version <dataset-version-id> \
  --split-set <split-set-id> \
  --split validation \
  --json
```

Bind scorers to prompt UI surfaces:

```bash
orizu --local prompts scorers set-headline <prompt-id> \
  --project <team>/<project> \
  --scorer-version <scorer-version-id> \
  --dataset-version <dataset-version-id> \
  --split-set <split-set-id> \
  --split validation \
  --json

orizu --local prompts scorers add <prompt-id> \
  --project <team>/<project> \
  --scorer-version <scorer-version-id> \
  --dataset-version <dataset-version-id> \
  --split-set <split-set-id> \
  --split validation \
  --json
```

### Runs

Submit local runner output:

```bash
orizu --local runs submit ./results.jsonl \
  --project <team>/<project> \
  --prompt-version <prompt-version-id> \
  --runner-version <runner-version-id> \
  --dataset-version <dataset-version-id> \
  --split-set <split-set-id> \
  --split validation
```

For generator runs scored by a judge:

```bash
orizu --local runs submit ./generator-results.jsonl \
  --project <team>/<project> \
  --prompt-version <generator-version-id> \
  --runner-version <generator-runner-version-id> \
  --dataset-version <dataset-version-id> \
  --split-set <split-set-id> \
  --split validation \
  --judge-version <judge-version-id> \
  --judge-runner-version <judge-runner-version-id>
```

### Optimizers

```bash
orizu --local optimizers push ./optimizer \
  --project <team>/<project> \
  --name hip-gepa-optimizer \
  --label gepa-v1 \
  --json
```

Returns `optimizer_version_id`.

Start a local optimization run before the optimizer process begins:

```bash
orizu --local optimizations start \
  --project <team>/<project> \
  --optimizer-version <optimizer-version-id> \
  --prompt-version <prompt-version-id> \
  --selection-scorer <scorer-version-id> \
  --reflection-scorer <row-scorer-version-id> \
  --dataset-version <dataset-version-id> \
  --split-set <split-set-id> \
  --train-split train \
  --validation-split validation \
  --metadata '{"source":"local-gepa"}' \
  --json
```

Returns `optimization_run_id`. Pass that ID to the local optimizer as `ORIZU_RUN_ID`.

Optional tracked scorers:

- `--pareto-scorer <scorer-version-id>` runs a scorer for Pareto candidates.
- `--best-scorer <scorer-version-id>` runs a scorer for the current best candidate.

For bundled text-candidate GEPA-style optimization, let the CLI manage start/event/finish wiring:

```bash
orizu --local optimizations run-gepa \
  --project <team>/<project> \
  --optimizer-version-id <optimizer-version-id> \
  --candidate-version-id <prompt-version-id> \
  --runner-version-id <runner-version-id> \
  --candidate-runner-dir ./candidate-runner \
  --scorer-version-id <row-scorer-version-id> \
  --scorer-runner-version-id <scorer-runner-version-id> \
  --scorer-runner-dir ./scorer-runner \
  --dataset-version-id <dataset-version-id> \
  --split-set-id <split-set-id> \
  --train-split train \
  --val-split validation \
  --log-dir ./logs \
  --minibatch-size 3 \
  --num-threads auto
```

Useful GEPA flags:

- Budget controls are mutually exclusive: choose at most one of `--budget auto|light|medium|heavy`, `--max-metric-calls <n>`, `--max-full-evals <n>`, or `--max-iterations <n>`. With none provided, `run-gepa` defaults to `--budget auto`, the balanced medium preset.
- `--minibatch-size <n>` defaults to 3.
- `--num-threads auto|N` defaults to `auto`; auto caps row-evaluation concurrency from mini-batch size, validation-set size, 2x CPU count, memory estimate, file-descriptor limit, and a 64-thread default ceiling. Set `ORIZU_GEPA_AUTO_THREADS_MAX` or use `--num-threads <n>` only when the runner/provider capacity is known.
- `--candidate-selection-strategy pareto|current_best|epsilon_greedy`; default is `pareto`.
- `--reflection-model <provider/model>`, `--reflection-temperature <n>`, `--reflection-prompt-template <text|@file>`.
- `--reflection-max-tokens <n>` is explicit provider config, not a global default. It maps to Anthropic `max_tokens` and OpenAI `max_output_tokens`; Anthropic native Messages reflection requires it, while OpenAI can omit it unless the user wants a cap.
- `--reflection-retry-attempts` and `--reflection-http-timeout-seconds` tune transient reflection-provider retries. Exhausted retryable failures log `reflection_failed`, count against candidate-proposal budget, and continue with the next iteration.
- `--reflection-provider-settings <json|@file>` passes provider-native reflection settings separately from the prompt text. Anthropic example: `{"thinking":{"type":"adaptive","display":"omitted"},"output_config":{"effort":"medium"}}`. OpenAI example: `{"reasoning":{"effort":"medium","summary":"auto"}}`.
- `--disable-evaluation-cache` turns off candidate/row/scorer cache reuse.
- `--auto-promote --promotion-label <label>` promotes the best candidate at the end.
- `--log-row-snapshots` includes raw row and reflection text in events; leave off by default.
- `--log-dir <dir>` controls the local log root; default is `logs`.
- `--no-local-log` disables local trace files. Use this only when the environment must not persist raw rows or reflection context.

Local `run-gepa` logs:

- The optimizer prints `[orizu-gepa] local log: <path>` after the run starts.
- The default path is `logs/<optimization_run_id>`.
- `run.json` stores run metadata, CLI args, and project/run ids.
- `prompt_context.json` and `scorer_context.json` store the candidate and scorer prompt contexts.
- `trainset.json` and `valset.json` store the full split row payloads.
- `events.jsonl` mirrors the optimization event stream, including redacted server payload fields where applicable.
- `evaluations.jsonl` stores each row evaluation with row input, output, score, feedback, raw/scorer responses, latency, tokens, cost, error, and cache status.
- `reflections.jsonl` stores each reflection prompt, response, child candidate text, parent/child ids, and minibatch row ids.
- `result.json` stores best candidate id/text, best score, seed score, promoted prompt version id, and final budget state.

For coding-agent insight generation, prefer reading the local log files in this order:

1. `result.json` for the final winner and aggregate outcome.
2. `evaluations.jsonl` to cluster failures, improvements, regressions, and scorer feedback by row.
3. `reflections.jsonl` to understand why each child candidate was proposed.
4. `events.jsonl` to reconstruct iteration order, Pareto updates, decisions, pauses, and promotions.

Optimization export:

```bash
orizu --local optimizations export <optimization-run-id> \
  --out ./<optimization-run-id>.optimization.json
```

Use export when the local log is unavailable, the run happened on another machine, or a coding agent needs a portable single JSON artifact. The export fetches all optimization events, derives seed vs best, Pareto frontier, score-over-time, candidates, iterations, minibatch rows, and validation rows, and rehydrates row inputs from the dataset version artifact when possible. Server events may not contain row snapshots or reflection prompts unless the run used `--log-row-snapshots`; reflection responses are included for bundled `run-gepa` runs.

Lifecycle controls:

```bash
orizu --local optimizations pause <optimization-run-id> --reason "inspect candidate"
orizu --local optimizations resume <optimization-run-id>
orizu --local optimizations finish <optimization-run-id> \
  --best-score 0.82 \
  --best-candidate candidate-7 \
  --result-prompt-version <prompt-version-id> \
  --report-file ./reports/<optimization-run-id>.md
orizu --local optimizations fail <optimization-run-id> --reason "provider outage" --report-file ./reports/<optimization-run-id>.md
orizu --local optimizations cancel <optimization-run-id> --reason "user stopped" --report "## Cancelled\n\nStopped after manual inspection."
```

`pause` and `cancel` store `metadata.reason`. `fail` stores `metadata.failure_reason`.
`finish` marks the run `succeeded`; use it after accepted candidates have been promoted and the final prompt version is known.
Use `--report-file <path>` or `--report <markdown|@file>` on `finish`, `fail`, or `cancel` to attach the markdown report shown in the optimization detail Report tab. Prefer generating this from the local GEPA logs (`result.json`, `evaluations.jsonl`, `reflections.jsonl`, and `events.jsonl`) after the run ends. Report structure and interpretation rules: `optimization-reports.md`.

## Optimization Event Logging

Custom optimizers use bare HTTP. Optimizer scripts should start a run through the CLI and POST each event as it happens:

```bash
curl -sS -X POST "$ORIZU_API_URL/api/cli/optimization-runs/$ORIZU_RUN_ID/events" \
  -H "Authorization: Bearer $ORIZU_TOKEN" \
  -H "Content-Type: application/json" \
  -d @event.json
```

Event envelope:

```json
{
  "eventId": "seed-completed-1",
  "sequence": 3,
  "eventType": "seed_val_set_completed",
  "eventLayer": "extension",
  "optimizerFamily": "gepa",
  "iteration": null,
  "candidateId": null,
  "parentCandidateId": null,
  "childCandidateId": null,
  "occurredAt": "2026-05-26T16:00:00.000Z",
  "payload": {
    "mean_score": 0.35,
    "per_row_scores": [
      {
        "row_id": "row-1",
        "score": 0.4,
        "feedback": "rationale"
      }
    ]
  }
}
```

Rules:

- `sequence` is client-supplied, positive, and monotonic within one optimization run.
- `eventId` must be stable and unique within one optimization run.
- `eventLayer` is `core`, `extension`, or `system`.
- Generic core events: `run_started`, `iteration_started`, `candidate_proposed`, `candidate_scored`, `candidate_recommended`, `iteration_completed`, `run_completed`, `run_failed`.
- GEPA extension events: `seed_val_set_started`, `seed_val_set_completed`, `parent_minibatch_started`, `parent_minibatch_completed`, `reflection_started`, `reflection_completed`, `child_candidate_created`, `child_minibatch_started`, `child_minibatch_completed`, `acceptance_decision_made`, `optimization_progress`, `merge_started`, `merge_completed`.
- Emit `optimization_progress` after each completed iteration with `percent`, `metric_calls_used`, `metric_call_budget`, and `metric_calls_remaining`. Cap displayed `percent` at `100` and floor `metric_calls_remaining` at `0`; a started iteration may spend past the nominal metric-call budget before the optimizer pauses.
- Do not send per-LM-call telemetry to this endpoint in Phase 0. Put aggregate call/token/cost stats in iteration or run payloads.

Shell fallback:

```bash
orizu --local log seed_val_set_completed \
  --run-id "$ORIZU_RUN_ID" \
  --sequence 3 \
  --event-layer extension \
  --optimizer-family gepa \
  --payload @event-payload.json
```

`orizu log` creates an `eventId` unless `--event-id` is provided. `event-payload.json` is the payload object only, not the full envelope.

### Candidate Promotion

Promotion creates a new immutable `prompt_versions` row and appends a system event to the optimization run.

```bash
curl -sS -X POST "$ORIZU_API_URL/api/cli/optimization-runs/$ORIZU_RUN_ID/promote" \
  -H "Authorization: Bearer $ORIZU_TOKEN" \
  -H "Content-Type: application/json" \
  -d @promotion.json
```

```json
{
  "candidateId": "candidate-7",
  "promptId": "prompt-uuid",
  "parentPromptVersionId": "parent-prompt-version-uuid",
  "body": "new prompt body",
  "bodyKind": "text",
  "providerSettings": {
    "model": "claude-sonnet-4-6",
    "temperature": 0,
    "max_tokens": 4096
  },
  "runnerVersionId": "runner-version-uuid",
  "label": "production"
}
```

Response:

```json
{
  "promptVersionId": "new-prompt-version-uuid"
}
```

## End-to-End Flow

```bash
eval "$(orizu --local env --project hip/judge-optimization)"

DATASET_VERSION_ID="$(orizu --local datasets versions create hip-note-judge-labels --project hip/judge-optimization --label v1 --json | jq -r .dataset_version_id)"
SPLIT_SET_ID="$(orizu --local datasets splits create "$DATASET_VERSION_ID" --name default --seed 42 --train 0.6 --validation 0.4 --test 0 --json | jq -r .split_set_id)"

RUNNER_VERSION_ID="$(orizu --local runners push ./runner --project hip/judge-optimization --name hip-note-judge-runner --label default --json | jq -r .runner_version_id)"
JUDGE_VERSION_ID="$(orizu --local judges push ./judge --project hip/judge-optimization --runner-version "$RUNNER_VERSION_ID" --json | jq -r .prompt_version_id)"
SCORER_VERSION_ID="$(orizu --local scorers register --project hip/judge-optimization --name hip-note-judge-score --manifest ./scorer.manifest.json --prompt-version "$JUDGE_VERSION_ID" --runner-version "$RUNNER_VERSION_ID" --label production --json | jq -r .scorer_version_id)"
OPTIMIZER_VERSION_ID="$(orizu --local optimizers push ./optimizer --project hip/judge-optimization --name hip-gepa-optimizer --label gepa-v1 --json | jq -r .optimizer_version_id)"
OPTIMIZATION_RUN_ID="$(orizu --local optimizations start --project hip/judge-optimization --optimizer-version "$OPTIMIZER_VERSION_ID" --prompt-version "$JUDGE_VERSION_ID" --selection-scorer "$SCORER_VERSION_ID" --reflection-scorer "$SCORER_VERSION_ID" --dataset-version "$DATASET_VERSION_ID" --split-set "$SPLIT_SET_ID" --json | jq -r .optimization_run_id)"
export ORIZU_RUN_ID="$OPTIMIZATION_RUN_ID"

orizu --local runners exec \
  --prompt-version "$JUDGE_VERSION_ID" \
  --runner-version "$RUNNER_VERSION_ID" \
  --dataset-version "$DATASET_VERSION_ID" \
  --split-set "$SPLIT_SET_ID" \
  --split validation \
  --runner-dir ./runner \
  --out ./judge-results.jsonl

orizu --local runs submit ./judge-results.jsonl \
  --project hip/judge-optimization \
  --prompt-version "$JUDGE_VERSION_ID" \
  --runner-version "$RUNNER_VERSION_ID" \
  --dataset-version "$DATASET_VERSION_ID" \
  --split-set "$SPLIT_SET_ID" \
  --split validation

orizu --local scores submit ./judge-results.jsonl \
  --project hip/judge-optimization \
  --scorer-version "$SCORER_VERSION_ID" \
  --subject-version "$JUDGE_VERSION_ID" \
  --dataset-version "$DATASET_VERSION_ID" \
  --split-set "$SPLIT_SET_ID" \
  --split validation

# After the local optimizer has logged events and promoted its accepted candidate:
orizu --local optimizations finish "$OPTIMIZATION_RUN_ID" \
  --best-score 0.82 \
  --best-candidate candidate-7 \
  --result-prompt-version "$JUDGE_VERSION_ID"
```

## Notes And Limits

- All HTTP endpoints require `Authorization: Bearer $ORIZU_TOKEN`.
- Runner and optimizer zips are content-hashed. Re-uploading the same zip dedupes at the version layer.
- Prompt and judge versions are immutable. Labels move; versions do not.
- Scorers are first-class metric contracts. A score is meaningful as `(scorer version, subject or candidate, dataset version, split set, split)`.
- GEPA reflection scorers must be row-mode scorers so reflection has per-row feedback.
- Dataset splits are tied to a specific dataset version.
- `runners exec` writes runner-level row results locally; `runs submit` uploads and aggregates prompt-run results.
- `scorers exec` is the preferred path for scorer evaluation, especially builtin set scorers that aggregate dependency evidence.
- `scores submit --aggregate` is the supported path for precomputed set-score objects; `scores submit` without `--aggregate` remains the row-result path.
- `optimizations start` creates the live run row up front so local scripts can stream events immediately.
- Rejected optimizer candidates should remain in the event stream. Only accepted candidates should be promoted.
