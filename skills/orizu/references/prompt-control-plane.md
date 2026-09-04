# Instruction Control Plane

Use this reference for the Phase 0 instruction, judge, scorer, runner, score, run, and optimization event control plane. Follow the [Authority map](authority-map.md) before executing its command sequences.

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
4. Push runners before instruction-set mutations, judges, or prompt-runner scorers; instruction components pin runner versions. Follow the Authority map after the runner version exists.
5. Register scorers after their backing judge prompt/runner exists, then bind headline/tracked scorers to instruction components when the UI should show those metrics.
6. Use `runners exec` to prove the runner contract locally before submitting runs or score runs.
7. For common text-candidate optimization, prefer `orizu optimizations run-gepa`; it starts the run and logs events for you.
8. After `run-gepa`, inspect `logs/<optimization_run_id>` first; it is the complete local trace for coding-agent analysis.
9. Use `orizu optimizations export <run-id> --out <run-id>.optimization.json` when the local log is missing or the run happened elsewhere.
10. Write and attach a markdown report for finished, failed, or cancelled runs; use `optimization-reports.md` for structure and diagnostic guidance.
11. Follow the [Authority map](authority-map.md). Simpler one-shot path: after the human accepts the report, a human curator runs `orizu optimizations promote <run-id> --candidate <id> --label production --project <team/project>`, materializing and labeling once. Equivalent two-stage path: an agent runs `orizu optimizations promote <run-id> --candidate <id> --project <team/project>` after acceptance. A human curator re-runs the same promotion as `orizu optimizations promote <run-id> --candidate <id> --label production --project <team/project>`. The idempotent finalizer finds the exact existing materialized version by run and candidate provenance, moves production, and creates no duplicate profile version or candidate-promoted event.
12. For custom optimizers, start an optimization run before local execution, then stream events into that run.
13. Use bare HTTP for optimization events; use `orizu log` only as a shell fallback.
14. Promote only accepted candidates; rejected candidates stay in optimization events.

Customer model-provider secrets stay local. Do not upload Anthropic/OpenAI/etc. API keys to Orizu.

## Instruction sets

Work within the fixed, ordered component shape and model-config profiles defined
for instruction sets in Vocabulary. Existing prompts appear as one-component
sets. Inspect or write them with the customer-facing `orizu instructions`
namespace. Follow the [Authority map](authority-map.md) for mutation
custody before copying a command:

```bash
orizu instructions list --project core/evals --status active --json
orizu instructions show planner --project core/evals --status active --json
orizu instructions create ./orizu.instruction-set.json --project core/evals --model-config anthropic/claude-haiku
orizu instructions push ./orizu.instruction-set.json --project core/evals --set planner
orizu instructions profiles new planner --project core/evals --model-config anthropic/claude-haiku
orizu instructions profiles promote planner --project core/evals --model-config anthropic/claude-haiku --version 2
orizu instructions profiles rollback planner --project core/evals --model-config anthropic/claude-haiku --to 1
orizu instructions default show planner --project core/evals
orizu instructions default move planner --project core/evals --model-config anthropic/claude-haiku
orizu instructions shape add planner --project core/evals --key safety --from ./orizu.instruction-set.json
orizu instructions shape remove planner --project core/evals --key safety
orizu instructions archive planner --project core/evals --json
orizu instructions restore planner --project core/evals --json
```

The manifest contains `name`, optional unversioned `description`, the ordered
component-key `shape`, and `components`; every shape key needs a set-wide
component (`key` plus `text` or a manifest-relative `path`). A component may
additionally specify `modelConfig` to override that key in a named profile.
Create materializes each named profile with its complete base-plus-override
component map. The Default names a Profile, not a version, and newly created
Profiles have no Production until explicitly promoted. Resolution uses only the
requested Profile's Production; an unset Production is a named refusal and
never falls back to the Default. Sets accept either their stable slug or exact
display name. Archiving changes list visibility only, so archived sets still resolve
and sync; use `--status archived` or `--status all` to find them before
restoring.

Shape changes create unpromoted profile heads but leave the default and
production pointers in place. The instruction set does not resolve for affected
model configs until those pointers move to their new shape-change versions; use
the follow-up commands printed by the text CLI.

`default show` reports the Default Profile and the Version its Production
currently names, or `null` when that Profile is unpromoted. `default move`
targets a Profile by model-config identity, never a Version, and does not move
Production. Moving Default to an unpromoted Profile makes bare resolution refuse
with `instruction_set_profile_not_promoted`; no other Profile falls back to it.
Shape changes create a new `shape_change` Version for every Profile; they do not
repoint Default or any Production label.

Sync an offline runner directory with `orizu instructions sync planner
--out . --project core/evals`. Sync resolves the bare Set as
Default Profile → that Profile's Production Version, then writes immutable
material under the version-addressed paved directory documented in
`cli-reference.md` and records Default and Production pointers in
`./orizu/orizu.lock.json`.
A named or Default Profile without Production refuses with
`instruction_set_profile_not_promoted`; nothing falls back. Runtime consumers
use the generated Component module described in `cli-reference.md`. A Git-pinned
component stays recorded rather than downloaded and raises
`instruction_set_component_unavailable` until the application resolves its
canonical Git bytes.

A retired display-name tree containing the set-level `manifest.json`, `default/`,
or `profiles/` layout is never auto-migrated or deleted. Sync preserves it and
refuses with `instruction_set_sync_legacy_layout`, pointing at the paved-path
migration guide in `cli-reference.md`; move the old tree explicitly before re-syncing.

Use `profiles new` to seed an additional model-config profile from the default.
Use `profiles
promote` to move only that profile's production label; use `profiles rollback
--to <n>` to create a new rollback version from the target version's component
map **and settings version** before moving it. Follow the Authority map for
promotion execution.

For a single-component instruction set that wraps an existing prompt, only a
promotion or rollback of the set's default profile also moves that prompt's
`production` label in the same transaction. The coupling is intentionally
one-way: a later direct prompt-label move does not change the instruction-set
profile label. Human CLI output names the prompt as `default profile → prompt
label` when a profile command performed this mirror.

Execution/privacy defaults:

- Runner subprocesses receive the input/output file-contract paths plus a small allowlist of provider/runtime environment variables. Orizu API tokens are not passed into runner processes. When an execution carries an instruction set, `ORIZU_INSTRUCTION_SET_DIR` is set explicitly to a fresh per-row synced layout; it is absent for legacy executions and is never inherited from the shell.
- `orizu optimizations run-gepa` redacts dataset row payloads and reflection text in logged events by default. Use `--log-row-snapshots` only when the customer explicitly wants raw row and component text in the optimization event stream.
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

For `runners exec`, the command must read input JSON from `ORIZU_RUNNER_INPUT_PATH` and write output JSON to `ORIZU_RUNNER_OUTPUT_PATH`. When present, `ORIZU_INSTRUCTION_SET_DIR` contains the same layout written by `instructions sync`; use `loadInstructionSet`/`load_instruction_set` to read materialized component text. Pinned components are represented in the manifest and are intentionally not materialized as `.md` files.

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
  "instruction_set": {
    "name": "planner",
    "model_config": { "identity": "openai/gpt-5.4" },
    "shape": ["system", "tools"],
    "prompt_component_key": "system",
    "components": { "system": "inline component bytes" },
    "pinned_components": {
      "tools": { "repoPath": "skills/tools.md", "contentSha": "…", "commitSha": "…" }
    }
  },
  "prompt_version_id": "uuid",
  "runner_version_id": "uuid",
  "run_id": null
}
```

`instruction_set` is additive. `prompt_component_key` names the component that contains the requested legacy prompt version; candidate evaluation replaces that component's seed bytes with the candidate. `components` contains only inline text; Git-only components are absent there and appear in `pinned_components` with camelCase Git pins. Runners mirror whether the exec-context response contains `prompt.body`; the explicit `instructionSetProfileVersionId` parameter is a server surface that ALI-1536 sends. The route keeps byte-identical `prompt.body` for every implicit prompt-version caller and omits it only for an explicit multi-component map; explicit set-of-one responses retain it. Top-level JSON key order is not part of the contract.

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

### Scorer-Runner Input Contracts (flat-row vs GEPA)

There are TWO distinct input shapes a scorer/judge runner can receive, and
mixing them up silently zeroes every score (the judge sees an empty output in
every field it reads and scores 0 without erroring). Know which one your
runner speaks before wiring it anywhere.

**Flat-row score-run contract** — what `orizu runners exec --scorer-version`
sends. `row` is the flat dataset row; the candidate output lives at the
top-level `model_output` (taken from `row.model_output` / `row.modelOutput` /
`row.output`) and usually also inside the row itself:

```json
{
  "row": { "brief": "…", "reference_sent_text": "…", "draft": "…the output to judge…" },
  "prompt": { "body": "judge prompt", "body_kind": "text", "provider_settings": {} },
  "subject": { "type": "scorer_row", "row_id": "row-1", "scorer_version_id": "uuid", "prompt_version_id": "uuid" },
  "scorer": { "version_id": "uuid", "metric_key": "score", "higher_is_better": true },
  "model_output": "…the output to judge…",
  "prompt_version_id": "uuid",
  "runner_version_id": "uuid",
  "run_id": null
}
```

**GEPA scorer-runner contract** — what `orizu optimizations run-gepa` sends by
default. `row` is a wrapper around the dataset row plus the freshly generated
candidate output:

```json
{
  "row": {
    "source_row": { "…the dataset row…": "…" },
    "candidate_id": "iter-3-child-…",
    "candidate_output": "…the candidate's generated output…",
    "candidate_raw_response": {},
    "candidate_error": null
  },
  "prompt": { "body": "judge prompt", "body_kind": "text", "provider_settings": {} },
  "prompt_version_id": "uuid",
  "runner_version_id": "uuid",
  "run_id": "uuid"
}
```

**The official adapter:** a judge runner written for the flat-row contract can
be used by GEPA as-is — pass `--scorer-input-contract flat_row` to `run-gepa`.
The optimizer then flattens `source_row` into `row`, injects the candidate
output at `model_output` (or the row field named by
`--scorer-candidate-field <field>`, e.g. `draft` for a judge that reads the
candidate from `row.draft`), and adds the `subject`/`scorer`/`model_output`
companions, exactly like a score run. The candidate's `candidate_error` is
kept first-class in the flat row too, so a candidate that errored during
generation is inspectable instead of being judged as an empty draft. GEPA
provenance stays available under a top-level `gepa` key. Specifying a
candidate field while the active contract is `gepa` is refused at launch
rather than silently ignored. Because the adapter is applied by the optimizer harness,
the registered runner bytes are unchanged — this composes with the
`--scorer-runner-dir` content-sha verification (bytes must match the
registered runner version). New runners can instead self-describe by declaring
`"scorer_input_contract": "flat_row"` (and optionally
`"candidate_output_field": "<field>"`) in `manifest.json` and pushing a new
runner version.

**Launch-time validation:** `run-gepa` validates the scorer contract on the
seed before iterating. If the seed scores the worst possible value on every
validation row (0.0 for higher-is-better, 1.0 for lower-is-better), errors on
every row, or returns nothing parseable, the run fails loudly with a
contract-mismatch diagnosis instead of silently burning budget on zeroed
candidates. A uniformly-worst seed is almost always a harness bug, not bad
component values; override with `--allow-degenerate-seed` only when the seed genuinely
deserves the worst score everywhere.

### Judge Directory

Required files: `orizu.prompt.json` plus the body file referenced by `body_file`.

Judge artifact:

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
orizu --local datasets upload \
  --file ./dataset.jsonl \
  --project <team>/<project> \
  --name "<dataset-name>" \
  --readme-file ./dataset-readme.md \
  --json
```

Upload creates the initial immutable `v1` snapshot. Capture its returned
`dataset_version_id`; do not immediately create a colliding `v1` version.

Review and commit a predefined split file with explicit train, validation, and
reserved final-held-out membership:

```json
{
  "name": "default",
  "strategy": "predefined",
  "seed": 42,
  "partitions": [
    { "name": "train", "row_ids": ["row-1", "row-2"] },
    { "name": "validation", "row_ids": ["row-3"] },
    { "name": "final-held-out", "row_ids": ["row-4"] }
  ]
}
```

```bash
orizu --local datasets splits create <upload-returned-dataset-version-id> \
  --from-file ./split.json \
  --json
```

Returns `split_set_id`.

### Runners

```bash
orizu --local runners push ./runner \
  --project <team>/<project> \
  --name hip-note-judge-runner \
  --json
```

Returns `runner_version_id`.

The agent push is unlabeled. No standalone runner-label command exists, so never label by repeating a mutable working directory. If the human accepts the exact version as default, the human curator materializes it with `orizu --local runners pull hip-note-judge-runner --project <team>/<project> --version <reviewed-runner-version-id> --out ./runner-default-handoff`, does not alter that fresh directory, then runs `orizu --local runners push ./runner-default-handoff --project <team>/<project> --name hip-note-judge-runner --label default --json`. Pull verifies the content-addressed archive, and deterministic push excludes the pull sidecar, so this resolves the reviewed version before moving the pointer.

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

### Instructions And Judges

Prepare the complete instruction-set manifest and follow the Authority map for
the push; the judge remains a git-canonical artifact.

```bash
orizu --local instructions push ./orizu.instruction-set.json \
  --project <team>/<project> \
  --set <slug-or-exact-name> \
  --runner-version <runner-version-id> \
  --json

orizu --local judges push ./judge \
  --project <team>/<project> \
  --runner-version <judge-runner-version-id> \
  --json
```

Instruction push returns the updated set and profile versions. Judge push
returns `prompt_version_id` for the judge artifact used by scorer bindings.

List:

```bash
orizu --local instructions list --project <team>/<project>
orizu --local instructions list --project <team>/<project> --status archived
orizu --local instructions list --project <team>/<project> --status all
orizu --local judges list --project <team>/<project>
```

Instruction and judge lists show active artifacts by default. Use `--status
archived` or `--status all` when you need archived artifacts. Existing prompts
appear in the instruction list as one-component sets; see
`instructions-after-prompts.md` for ownership output, deliberate standalone
mutation refusals, and manual consolidation.

Compatibility prompt and judge list tables include `ID`, `NAME`, `ROLE`,
`STATUS`, `TOKENS`, `LINES`, `CHARS`, and `WORDS`, measured from the latest
sealed version. `—`
means the canonical body could not be measured; zero remains `0`. The `~`
prefix on token counts means approximate: Orizu uses one fixed, model-agnostic
`gpt-tokenizer` encoding rather than claiming an exact count for every model.
Failed or deliberately skipped JSON enrichment carries a named
`lengthStatsUnavailableReason`. Measured summaries also include
`lengthStatsVersionId` and `lengthStatsVersionNumber`, identifying the latest
sealed version behind each measurement even when the canonical body could not
be measured. Length enrichment is best-effort: a supporting query failure
leaves the list available with null stats and `enrichment_failed`. At most the
first 500 sorted summaries are enriched per request, and canonical-body
resolution has a 15-second server budget. A summary skipped by either bound
carries null stats and `measurement_cap_exceeded`.

Archive or restore an instruction set by stable slug or exact name, using the
executor selected by the Authority map:

```bash
orizu --local instructions archive <slug-or-exact-name> --project <team>/<project>
orizu --local instructions restore <slug-or-exact-name> --project <team>/<project>
```

Archive and restore affect visibility only. Archived sets still resolve and
sync, and can be inspected with `instructions show --status archived|all`.

List prompt comment threads for the latest version, or a specific label/version:

```bash
orizu --local comments list --prompt <prompt-id-or-name> \
  --project <team>/<project> \
  [--label production | --version <prompt-version-id>] \
  [--json]
```

Human output shows the thread count, open/resolved counts, selected component
text or source line, each top-level comment body, and replies. Use `--json` when
an agent or script needs structured `summary` and `comments` data. Check
unresolved comments before drafting or pushing the next instruction version.

After the promotion decision, move a profile's production pointer
through the Authority map:

```bash
orizu --local instructions profiles promote hip-note-judge \
  --project <team>/<project> \
  --model-config <identity> \
  --version <n> \
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
  --json
```

Returns `scorer_version_id`.

Inspect scorers:

```bash
orizu --local scorers list --project <team>/<project>
orizu --local scorers detail <scorer-id-or-name> --project <team>/<project> --json
```

Production scorer labels are pointer moves. The agent prepares the scorer name, version id, and evidence. After human acceptance, follow the [Authority map](authority-map.md): a human curator runs `orizu --local scorers labels set hip-note-judge-score production --version <scorer-version-id> --project <team>/<project> --json`.

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

Bind the headline scorer to the instruction component that owns the evaluated
text:

```bash
orizu --local instructions scorers set-headline <set> \
  --key <component-key> \
  --project <team>/<project> \
  --scorer-version <scorer-version-id> \
  --dataset-version <dataset-version-id> \
  --split-set <split-set-id> \
  --split validation \
  --json
```

Add tracked scorers to the same set-and-component address:

```bash
orizu --local instructions scorers add <set> \
  --key <component-key> \
  --project <team>/<project> \
  --scorer-version <scorer-version-id> \
  --dataset-version <dataset-version-id> \
  --split-set <split-set-id> \
  --split validation \
  --json
```

The legacy `prompts scorers set-headline` and `prompts scorers add` spellings
refuse before making a request. Their measured replacements are:

- `Use: orizu instructions scorers set-headline <set> --key <component-key> --scorer-version <id> --project <team/project>`
- `Use: orizu instructions scorers add <set> --key <component-key> --scorer-version <id> --project <team/project>`

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
  --json
```

Returns `optimizer_version_id`; the agent-created version is unlabeled. If a human curator accepts that exact version as `gepa-v1`, the human pulls it with `orizu --local optimizers pull hip-gepa-optimizer --project <team>/<project> --version <optimizer-version-id> --out ./optimizer-label-handoff`, leaves that fresh directory unchanged, then runs `orizu --local optimizers push ./optimizer-label-handoff --project <team>/<project> --name hip-gepa-optimizer --label gepa-v1 --json`.

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
  --instruction-set <slug-or-exact-name> \
  --model-config <identity> \
  --component-selector all \
  --runner-version-id <runner-version-id> \
  --candidate-runner-dir ./candidate-runner \
  --scorer-version-id <row-scorer-version-id> \
  --scorer-runner-version-id <scorer-runner-version-id> \
  --scorer-runner-dir ./scorer-runner \
  --dataset-version-id <dataset-version-id> \
  --split-set-id <split-set-id> \
  --train-split train \
  --val-split validation \
  --engine official \
  --log-dir ./logs \
  --minibatch-size 3 \
  --num-threads auto
```

Useful GEPA flags:

- `--instruction-set <slug-or-exact-name> --model-config <identity>` selects a
  resolving instruction-set profile. `--component-selector round-robin|all`
  controls which components GEPA proposes changing; `all` lets it optimize the
  complete component map. `--candidate-version-id` remains a compatibility
  input for a single legacy prompt version and is mutually exclusive with the
  instruction-set selector.
- `--engine official|legacy` defaults to `official`, which runs the bundled official GEPA connector. Use `legacy` only as the frozen recovery hatch; it keeps the historical Python loop and does not support `--max-candidate-proposals` or the skilled proposer.
- `--scorer-input-contract gepa|flat_row` selects the scorer-runner input shape. Use `flat_row` to reuse a judge runner written for `runners exec --scorer-version` without a hand-written adapter; add `--scorer-candidate-field <row-field>` when that judge reads the candidate output from a specific row field (e.g. `draft`). Passing a candidate field under the `gepa` contract is refused at launch, not silently ignored. See "Scorer-Runner Input Contracts" above.
- `--allow-degenerate-seed` opts out of the launch-time refusal when the seed scores the worst possible value on every validation row. Leave it off by default — a uniformly-worst seed is almost always a scorer contract mismatch.
- Budget controls are mutually exclusive: choose at most one of `--budget auto|light|medium|heavy`, `--max-metric-calls <n>`, `--max-full-evals <n>`, `--max-iterations <n>`, or `--max-candidate-proposals <n>`. With none provided, `run-gepa` defaults to `--budget auto`, the balanced medium preset. `--max-candidate-proposals` is available only with `--engine official`.
- Hosted optimization (`--hosted`) is launched only by a human/PAT caller on
  an enabled team. It accepts a named `--budget` preset only, does not require
  candidate/scorer runner directories or local logs, and sends no local runner
  bytes or provider credentials. Reuse `--launch-intent-id <uuid>` after a lost
  response; use a new intent when the project or job specification changes.
- `--minibatch-size <n>` defaults to 3.
- `--num-threads auto|N` defaults to `auto`; auto caps row-evaluation concurrency from mini-batch size, validation-set size, 2x CPU count, memory estimate, file-descriptor limit, and a 64-thread default ceiling. Set `ORIZU_GEPA_AUTO_THREADS_MAX` or use `--num-threads <n>` only when the runner/provider capacity is known.
- `--candidate-selection-strategy pareto|current_best|epsilon_greedy`; default is `pareto`. With `epsilon_greedy`, `--epsilon <n>` controls the random-selection probability (default `0.1`, clamped to `0`–`1`).
- `--objective <text>` replaces the reflection objective when the optimization goal differs from the default instruction to maximize evaluator score while preserving intended behavior.
- `--reflection-model <provider/model>`, `--reflection-temperature <n>`, `--reflection-prompt-template <text|@file>`.
- `--reflection-max-tokens <n>` is explicit provider config, not a global default. It maps to Anthropic `max_tokens` and OpenAI `max_output_tokens`; Anthropic native Messages reflection requires it, while OpenAI can omit it unless the user wants a cap.
- `--reflection-retry-attempts` and `--reflection-http-timeout-seconds` tune transient reflection-provider retries. Exhausted retryable failures log `reflection_failed`, count against candidate-proposal budget, and continue with the next iteration.
- `--reflection-provider-settings <json|@file>` passes provider-native reflection settings separately from the component text. Anthropic example: `{"thinking":{"type":"adaptive"},"output_config":{"effort":"medium"}}`. OpenAI example: `{"reasoning":{"effort":"medium","summary":"auto"}}`.
- `--disable-evaluation-cache` turns off candidate/row/scorer cache reuse.
- `--auto-promote --promotion-label <label>` can move a label to the best candidate at the end. Omit both flags: run without auto-promotion, write the report, obtain the human promotion decision, then route the manual promotion command through the Authority map.
- `--log-row-snapshots` includes raw row and reflection text in events; leave off by default.
- `--log-dir <dir>` controls the local log root; default is `logs`.
- `--no-local-log` disables local trace files. Use this only when the environment must not persist raw rows or reflection context.

### Skilled proposer

`--candidate-proposer skilled-proposer` selects the skilled proposer; omission keeps the default official proposer. The flag is official-engine-only and accepts that one value. A missing value is refused before launch as `--candidate-proposer requires a value that does not start with --`; another value is refused as `--candidate-proposer must be skilled-proposer`; selecting it with `--engine legacy` is refused with `--candidate-proposer is supported by the official GEPA engine only`.

`--candidate-proposer-config <@file|path>` is optional and requires that selection on the official engine. Its strict schema-v1 object requires `schemaVersion: 1` and `skills: []`; each ordered skill is exactly either `{ "path": "..." }` (with optional `name`/`description` overrides) or `{ "name": "...", "description": "...", "inline": "..." }`. Optional fields are `additionalInstructionsFile`, `baseInstructionsFile`, positive-integer-or-null `maxWords`, `maxTokens`, and `maxExamples`, plus `onError: "keep"|"raise"`. Paths are config-file-relative; directories read only `SKILL.md`. Missing, unreadable, empty, malformed, ambiguous, duplicate-name, and unknown-field inputs fail before launch. `baseInstructionsFile` is advanced use: it replaces upstream's built-in anti-overfitting meta-prompt.

`--reflection-prompt-template` is incompatible whenever skilled-proposer is selected, with or without a proposer config; it configures the ordinary GEPA reflection path and would otherwise be silently ignored. The three token controls have different scopes: `--reflection-max-tokens` caps one provider response, config `maxTokens` caps a proposed instruction, and `--proposal-max-tokens` caps aggregate proposal-provider usage.

`--proposal-max-calls <positive-integer>` and `--proposal-max-tokens <positive-integer>` default to unset and are valid only with the skilled proposer. A missing operand names that flag; using either ceiling without the selection produces `--proposal-max-calls and --proposal-max-tokens require --candidate-proposer skilled-proposer`; the legacy-engine error names the individual flag. Integer and positive-value validation happens in the connector after launch and names `ORIZU_PROPOSAL_MAX_CALLS` or `ORIZU_PROPOSAL_MAX_TOKENS`.

The call ceiling counts each transport-bearing proposer bridge call after its success or failure is recorded; provider retries inside one bridge call remain one counted call. The token ceiling uses accumulated provider-derived `total_tokens`, including recorded usage from unsuccessful completions. Both ceilings stop new proposal work at the next safe boundary, so an in-flight call can meet or pass a ceiling. They govern only the skilled proposer and remain independent of overall GEPA controls such as `--max-metric-calls`; set at least one proposal ceiling and one overall GEPA ceiling, then start the run only when both limits match the intended experiment.

#### Managed environment lifecycle and recovery

The selected `run-gepa` invocation prepares the environment automatically. It preflights CPython 3.10–3.14, installs the checked-in exact-version and SHA-256 lock with binary-only selection on first use, smoke-tests the staged environment, and publishes it atomically. Use `--python <command>` to select that interpreter; otherwise a nonempty `PYTHON` is used, falling back to `python3`. Supported wheel targets are macOS arm64 on macOS 15 or later and glibc 2.28 or later on Linux x86_64. Run the selected command; managed-environment readiness is proven when optimizer execution begins without an `ALI_1505_*` environment diagnostic.

Published environments live under the working-directory-relative `.orizu/cache/skilled-proposer/venvs/<publish-key>`. The key covers the manager schema, lock digest, and interpreter/platform identity, so changing working directory, OS, kernel, interpreter, or lock can build another environment. Matching environments are validated before reuse, and concurrent first uses wait for the same atomic publication. Reclaim old environments by deleting the entire regenerable `.orizu/cache/skilled-proposer` directory, then rerun from the intended working directory until preflight completes.

A nonempty `SSL_CERT_FILE` is passed unchanged to both pip and provider traffic. Empty or absent values trigger best-effort system-bundle discovery. `ALI_1505_SSL_CERT_FILE_UNRESOLVED` means pip fell back to its bundled trust store and provider traffic may need an explicit PEM bundle; `ALI_1505_SSL_CONTEXT_FAILED` means the explicit path or PEM contents must be corrected. Set the working bundle and retry until the selected run passes TLS setup.

An interrupted first build leaves no published partial environment, so retry the same selected command. For `ALI_1505_UNSUPPORTED_CPYTHON`, choose an admitted interpreter with `--python` or `PYTHON`; for lock, wheel, install, validation, or publication diagnostics, preserve the named code and retry until the optimization starts. The CLI owns the lock and installation path; lock refresh remains a reviewed release operation.

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

Both diff-comment read routes (`/api/optimization-runs/<run-id>/diff-comments`
and `/api/prompts/<prompt-id>/diff-comments`) return `componentKey` for
multi-component comments. Preserve it on writes and use it in grouping keys:
equal line ranges from different instruction-set components are distinct
comments.

The v1 export keeps the run row's `best_candidate_id` in
`summary.bestCandidateId` when event derivation rejects that identifier as an
unknown candidate. Candidate detail can therefore be absent for the preserved
identifier. If neither source names a best candidate, the field is `null`.

Lifecycle controls:

Agent-run pause and resume controls:

```bash
orizu --local optimizations pause <optimization-run-id> --reason "inspect candidate"
orizu --local optimizations resume <optimization-run-id>
```

**Multi-component instruction-set run.** The agent materializes the candidate
without a label, then finishes without putting the returned profile version ID
in the prompt-only result field:

```bash
orizu --local optimizations promote <optimization-run-id> --candidate <candidate-id>
orizu --local optimizations finish <optimization-run-id> --best-candidate <candidate-id> --report-file ./reports/<optimization-run-id>.md
```

**Plain-prompt run.** A human curator runs the promotion as `orizu --local optimizations promote <optimization-run-id> --candidate <candidate-id> --label production`; this is the one allowed live promotion.

After the human returns `promptVersionId`, the agent records it on finish:

```bash
orizu --local optimizations finish <optimization-run-id> --best-candidate <candidate-id> --result-prompt-version <prompt-version-id> --report-file ./reports/<optimization-run-id>.md
```

**Set-of-one instruction-set run.** The agent must never call `optimizations promote`; follow `optimization-reports.md`'s provenance
stop/doctrine and finish without a result:

```bash
orizu --local optimizations finish <optimization-run-id> --best-candidate <candidate-id> --report-file ./reports/<optimization-run-id>.md
```

Agent-run failure and cancellation controls:

```bash
orizu --local optimizations fail <optimization-run-id> --reason "provider outage" --report-file ./reports/<optimization-run-id>.md
orizu --local optimizations cancel <optimization-run-id> --reason "user stopped" --report "## Cancelled\n\nStopped after manual inspection."
```

`pause` and `cancel` store `metadata.reason`. `fail` stores `metadata.failure_reason`.
`finish` marks the run `succeeded` and attaches its report; it does not authorize promotion. The three subject branches above are normative; see `optimization-reports.md` for seed-selected and no-valid-candidate branches. Finish the report first, then obtain the human decision before materialization or a serving-pointer move.
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
  "runnerVersionId": "runner-version-uuid"
}
```

Response:

```json
{
  "promptVersionId": "new-prompt-version-uuid"
}
```

## End-to-End Flow

Use a JSON array for `dataset.json` in this piped form. JSONL uploads use the
chunked uploader, which writes progress lines to stdout before its final JSON
document even with `--json`, so piping that stdout directly to `jq` is invalid.

```bash
eval "$(orizu --local env --project hip/judge-optimization)"

DATASET_VERSION_ID="$(orizu --local datasets upload --file ./dataset.json --project hip/judge-optimization --name hip-note-judge-labels --readme-file ./dataset-readme.md --json | jq -r .dataset_version_id)"
SPLIT_SET_ID="$(orizu --local datasets splits create "$DATASET_VERSION_ID" --from-file ./split.json --json | jq -r .split_set_id)"

RUNNER_VERSION_ID="$(orizu --local runners push ./runner --project hip/judge-optimization --name hip-note-judge-runner --json | jq -r .runner_version_id)"
JUDGE_VERSION_ID="$(orizu --local judges push ./judge --project hip/judge-optimization --runner-version "$RUNNER_VERSION_ID" --json | jq -r .prompt_version_id)"
SCORER_VERSION_ID="$(orizu --local scorers register --project hip/judge-optimization --name hip-note-judge-score --manifest ./scorer.manifest.json --prompt-version "$JUDGE_VERSION_ID" --runner-version "$RUNNER_VERSION_ID" --json | jq -r .scorer_version_id)"
```

Human curator hand-off through the [Authority map](authority-map.md) (do not run as the agent): no standalone runner-label command exists, so the human first runs `orizu --local runners pull hip-note-judge-runner --project hip/judge-optimization --version "$RUNNER_VERSION_ID" --out ./runner-default-handoff`, leaves that fresh exact-version directory unchanged, then runs `orizu --local runners push ./runner-default-handoff --project hip/judge-optimization --name hip-note-judge-runner --label default --json`. The human curator then runs `orizu --local scorers labels set hip-note-judge-score production --version "$SCORER_VERSION_ID" --project hip/judge-optimization --json`.
The agent continues with an unlabeled optimizer version:

```bash
OPTIMIZER_VERSION_ID="$(orizu --local optimizers push ./optimizer --project hip/judge-optimization --name hip-gepa-optimizer --json | jq -r .optimizer_version_id)"
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

# After the local optimizer has logged events: finish and attach the report, obtain human acceptance, then hand the one-shot promotion to a human curator.
orizu --local optimizations finish "$OPTIMIZATION_RUN_ID" \
  --best-score 0.82 \
  --best-candidate candidate-7 \
  --report-file "./reports/$OPTIMIZATION_RUN_ID.md"
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
