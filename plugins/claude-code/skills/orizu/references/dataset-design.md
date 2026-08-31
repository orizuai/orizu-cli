# Dataset design

Use this reference during First win's dataset-curation stage after the improvement plan is ratified and before annotation or judge work. Treat the plan's approved source choice and named scenario classes as input constraints rather than reopening them while moving data.

## Carry the approved source choice into the dataset

Inventory each approved source and record its owner, row shape, time range, scenario-class coverage, ground-truth field, and whether the human spot-check approved it. When existing golden data is available from an observability provider, eval store, or user behavior, import those rows and preserve their approved ground truth. Do not propose a new annotation round for ground truth the customer already has; record why annotation is skipped or reduced.

If there is no approved golden data, continue with representative production traces, a random sample, and structured synthetic cases for scenario classes that real traces do not cover. Keep provenance on every row so later versions can be audited, and have the human ratify the source choice and spot-check examples before the dataset is used.

## Getting data in

Use agent glue to move data from each ratified source into Orizu:

1. **Pull from the source.** Use the source provider's own CLI or API to export the approved rows. Follow that source's authentication and pagination contract, and preserve its stable locator and provenance without teaching a provider-specific path here.
2. **Normalize locally.** Transform the export into CSV, JSON, or JSONL with stable row IDs and the fields required by the ratified plan. Validate row shape and provenance before sending the file to Orizu.
3. **Load into Orizu.** Use `orizu datasets upload` for an initial dataset, or use `orizu datasets push <path>` as the path-first, automation-friendly alternative for creating an initial dataset from a CSV, JSON, or JSONL file. Use `orizu datasets append` for approved additional rows. Then follow the version and split procedure below; loading rows does not waive its coverage or review gates.

We deliberately do not build per-provider connectors while this agent-glue method covers the need. Revisit that decision only when an approved source cannot be reached by an agent-driven pull, such as streaming-only telemetry or push-based webhooks.

## Build a diverse sample and make coverage visible

Create a coverage table from the ratified plan before sampling. Give every scenario class a planned row count, source, ground-truth status, and actual row count. Preserve the production distribution with a random sample, then deliberately add rare, costly, new, and previously failing cases. Keep successful cases as controls. Deduplicate repeated traces and keep stable row IDs; do not let one conversation or near-duplicate appear on both sides of the split.

Before upload, fail the coverage check if any scenario class from the plan has zero rows. Report both the natural distribution and any deliberate over-sampling so later results are interpreted per scenario class rather than as an unexplained aggregate.

## Design train, validation, final-held-out, and the mini-batch together

Build one predefined split with exactly three application partitions for the primary dataset at dataset-build time: train, validation, and final-held-out. Auxiliary partitions, such as a migration-only parity corpus, may coexist in specialized workflows without changing this three-partition application doctrine. Validation is the valset that ranks candidates during optimization. Apply the Vocabulary contract to final-held-out: exclude its rows from candidate ranking, selection, reflection, and judge development.

**Judge-development data** comes from the labeled export, and `references/building-judges.md` owns its split mechanics; exclude final-held-out rows from all judge-development material (judge-dev and judge-test/alignment) because judge selection on final-held-out labels biases the final comparison through the judge itself.

Final-held-out rows need no human labels; exclude their row IDs from annotation tasks.

Put representative, approved rows from every scenario class in both validation and final-held-out, isolate both from training and from each other, and keep their intended membership unchanged. Record all three partitions' row IDs in the predefined split file so the decisions can be reproduced. Every scenario class in validation or final-held-out must also have training rows; otherwise the optimizer is being assessed on a class it had no opportunity to learn.

Size the mini-batch from the least common training class. For `K` scenario classes and a desired 95% chance that all classes appear, use the conservative miss bound `0.05 / K`. For each scenario class `i`, let `p_i` be that class's share of the training-split rows; choose the smallest positive integer mini-batch size `b` where `(1 - p_i)^b <= 0.05 / K` for every `i`. Pass the computed value to `orizu optimizations run-gepa --minibatch-size <b>`; `--minibatch-size` defaults to `3`, so do not omit it when the computed value differs.

Budget this together with the valset. With the skilled/custom proposer, the engine can silently clamp the reflection mini-batch to `max(1, max_metric_calls - len(valset))`. Do not infer safety from the user-facing budget flag: explicit `--max-metric-calls`, `--max-full-evals`, named `--budget` presets, and the default `--budget auto` all resolve to a metric-call limit that can trigger this clamp. With the default proposer, this clamp does not apply.

No budget dry-run exists, so calculate the resolved metric-call limit before launching a skilled/custom proposer. Explicit `--max-metric-calls n` resolves to `n`; `--max-full-evals f` resolves to `f * (len(trainset) + len(valset))`; and named/default `--budget` presets resolve through the formula in `packages/orizu-gepa-python/src/orizu_gepa/optimizer.py:361-405` using the chosen preset, component count, and valset size. Require `resolved_metric_calls - len(valset) >= b`; otherwise increase or change the budget, or record that the coverage guarantee does not hold. If the available rows or optimization budget cannot support the computed size, add rows, combine only genuinely equivalent scenario classes with human approval, or record that the plan is not ready for optimization.

The canonical split-file schema and version/split command contract live in `references/prompt-control-plane.md` under “Dataset Versions And Splits.” First win's dataset-curation stage adds the coverage requirement: use a predefined three-way split when scenario-class coverage matters, and build its partitions from the independently reviewed coverage table rather than a random split that could omit a class. For example:

```json
{
  "name": "v1",
  "strategy": "predefined",
  "seed": 42,
  "partitions": [
    { "name": "train", "row_ids": ["policy-1", "escalation-1", "safety-1"] },
    { "name": "validation", "row_ids": ["policy-2", "escalation-2", "safety-2"] },
    { "name": "final-held-out", "row_ids": ["policy-3", "escalation-3", "safety-3"] }
  ]
}
```

For the Final-held-out seed-vs-selected procedure and its supported-surface stop conditions, follow step 5 under “How To Build The Report” in `references/optimization-reports.md`.

## Upload, version, and create the split set

Normalize approved rows to CSV, JSON, or JSONL, with stable row identity and provenance fields, then upload them and request the machine-readable result:

```bash
orizu datasets upload --file ./dataset.jsonl --project <team/project> --name "<dataset-name>" --readme-file ./dataset-readme.md --json
```

Upload already creates the first immutable snapshot (labelled `v1` by default). Retain the returned `dataset_id` and `dataset_version_id`; use that `dataset_version_id` directly to create the split set, and retain its returned `split_set_id` in the improvement plan:

```bash
orizu datasets splits create <upload-returned-dataset-version-id> --from-file ./split.json --json
```

Reserve `orizu datasets versions create` for a subsequent snapshot, and give it a new label such as `v2`; labels are unique within a dataset. The dataset README should record source approval, source locators, sampling decisions, deduplication rules, the coverage table, ground-truth status, and the split rationale.

The dataset version freezes its rows. Server-side split membership is mutable, but the CLI exposes no split-set read operation, so membership cannot be re-read through the CLI. Treat the independently reviewed local split file plus the returned split-set ID as the canonical record available to this workflow. Do not mutate that server-side split set; pass the recorded `--dataset-version-id` and `--split-set-id` to `orizu optimizations run-gepa`, and record the CLI verification gap explicitly rather than claiming the server membership was re-verified.

## Guard live rows before annotation and version later data

Use the dataset mutation contract in `cli-reference.md` rather than inferring lock or row-edit semantics here.

After source approval and the split audit, the dataset must be locked before annotation starts because tasks pin live dataset rows rather than the immutable version:

```bash
orizu datasets lock --dataset <dataset-id> --project <team/project> --reason "Approved dataset v1"
```

The lock is a hard gate. If the user refuses it, annotation cannot proceed safely: labelers and exports dereference live row data, while responses store no response-time row snapshot. A mutate-label-restore sequence could therefore attach a label to different content without leaving evidence in the final rows.

When new data arrives, keep the prior dataset version, reviewed split file, and recorded split-set ID unchanged. Clone the locked dataset, add the approved rows to the unlocked clone, repeat the scenario-class coverage and split audit, and create a subsequent snapshot with a non-default label plus a new split set:

```bash
orizu datasets clone --dataset <dataset-id> --project <team/project> --name "<dataset-name>-v2"
orizu datasets append --dataset <cloned-dataset-id> --project <team/project> --file ./new-rows.jsonl
orizu datasets versions create <cloned-dataset-id> --project <team/project> --label v2 --readme-file ./dataset-readme-v2.md --json
orizu datasets splits create <new-dataset-version-id> --from-file ./split-v2.json --json
```

Never rewrite a prior version to make later labels or corrections appear historical.

## Exit criterion

Dataset curation exits only when the evidence records all of the following:

- the human-ratified source choice and spot-check;
- the plan's complete scenario-class list, with nonzero total, training, validation, and final-held-out counts for every scenario class;
- an immutable dataset version ID plus the reviewed local split file and recorded split-set ID whose predefined train, validation, and final-held-out rows match that coverage table;
- final-held-out row IDs excluded from all judge-development material (judge-dev and judge-test/alignment) and reserved for Promote's final comparison;
- for the annotation path, proof that the dataset was locked before any task was created; and
- either approved golden ground truth with annotation skipped or reduced, or rows ready for the eval-strategy and annotation path.
