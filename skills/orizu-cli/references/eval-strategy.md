# Eval strategy and labeler validation

Use this reference only after J3 (journey step 3, Build the dataset) has versioned the PRIMARY dataset and created its three-way split set. If approved golden data already supplies all required ground truth, record the source, approval, and scenario-class coverage, then skip annotation. If only unresolved rows need labels, clone or filter those rows into a separate dataset because automatic assignments cover every current dataset row and explicit assignment files require uniform whole-dataset coverage.

Final-held-out rows need no human labels; exclude their row IDs from annotation tasks and from the unresolved-rows clone/filter.

A derived unresolved-rows dataset is a labeling vehicle, not an optimization dataset. Preserve each source row's canonical `id` field from `datasets download` in the derived row's `row_data`; this is the stable identifier used by split files. Before creating any task, create and record the derived dataset's immutable version ID and lock the live dataset; it does not need its own per-class three-way split. Task creation waits for both records.

## Guide the eval-strategy conversation

Start from the ratified improvement plan and J3 coverage table; do not ask the human to restate facts already recorded. Walk through the decisions below with concrete rows, propose a draft answer where the evidence supports one, and ask the human to correct or ratify it.

1. **Experience and decision.** Ask which exact user experience the eval represents and which change or release decision it must inform. Confirm the unit being judged: one response, conversation, agent step, or complete run.
2. **Good and bad by scenario class.** For every scenario class, show representative rows and draft one binary question per observed failure mode. Ask what visible evidence makes each answer pass, fail, or unlabelable. Do not bundle independent judgments or replace them with a Likert question.
3. **Eval-set composition.** Confirm which versioned rows need human labels, the intended counts per scenario class, and any rare cases that must be present even when production frequency is low. Keep J3 validation for candidate ranking and keep its final-held-out partition under the separate partition doctrine in `references/dataset-design.md`.
4. **Ground truth.** Ask who is qualified to label each question, what context they need, how ambiguity or disagreement will be adjudicated, and whether user behavior or another approved golden-data field already answers it. Import approved golden data instead of relabeling it.
5. **Downstream validation.** Explain that these labels will later validate automated judges. Ask which decision each judge will power and record it for J5 (journey step 5, Judge), where the human sets the numerical judge trust bar from measured agreement, TPR, and TNR rather than accepting a default here.

Persist the ratified eval strategy in project context. It must name the experience and unit, dataset version and split set, scenario classes and row counts, binary questions with pass/fail/unlabelable rules, ground-truth source, labeler qualifications, disagreement path, golden-data decision, and the future decision attached to each judge trust bar. Do not author the labeler until the human ratifies this record.

`references/building-judges.md` owns the J5 input envelope and is being aligned there. This reference records the evidence handed to that contract. For a golden-data-only path, validate the field mapping against the binary questions, spot-check every scenario class with the human, and record the PRIMARY versioned dataset ID plus the approved ground-truth field per failure mode in the plan and report; then skip the remaining J4 annotation path.

For a mixed path, after annotation export, group derived records by the canonical `id` at `dataset_row.row_data.id`, the same identifier emitted by `datasets download` and used by split files, and require each key to match one primary row. Preserve every per-rater record in each row group, including the rater identity from the export, then aggregate according to the eval strategy's agreement rules. Record J5's labeled input as the union of the golden field mapping for golden rows and the grouped task export for annotated rows, keyed by that canonical primary-row `id`. Continue below only for questions or rows whose ground truth still requires human labels.

## Validate the labeler before tasks or labels

After the eval strategy is ratified, author the task-specific app with `references/building-apps.md`. That reference is the single home for the runtime contract, component choices, schemas, smoke test, preview mechanics, and app accessibility rules.

Run the smoke test and preview flow from that reference with representative rows from every scenario class. Inspect the resulting screenshot yourself, then ask the human for pointed feedback: does the app show the evidence needed for each judgment, ask the intended binary question in the plan's language, distinguish unanswered from false, produce useful ground truth, and make the primary action clear? Ask what is confusing or missing and which representative row is hardest to label. Revise and preview again until the human explicitly confirms the app works.

Record the rows previewed, the feedback, the revisions, and the approval. Do not create or publish a task, and do not start labeling, until this labeler-feedback gate is confirmed.

Use the draft-first ordering, URL-approval gate, and assignee-selector contract in `SKILL.md` under “Execution facts”; use `references/cli-reference.md` for the command surface. This reference adds one versioning safeguard: the task pins the app version selected at creation.

If draft testing reveals a problem, revise through `orizu apps update`, repeat the preview and pointed-feedback gate, capture the returned version number `n`, and explicitly repin the draft before testing its URL again:

```bash
orizu tasks update --task <taskId> --app <appId> --version <n>
```

Then return to the approval and publish sequence in “Execution facts.” If the strategy requires an explicit row-to-labeler map, it must still cover every row in this task's separate annotation dataset uniformly.

After labeling, inspect the machine-readable status before task completion or export:

```bash
orizu tasks status --task <task-id> --json
```

Verify that `task.counts.completed` equals `task.totalRequiredAssignments` and that in-progress, pending, paused, and skipped counts are zero. Status proves assignment states, not response custody. After those counts pass, export the response-bearing JSONL before completing the task:

```bash
orizu tasks export --task <task-id> --format jsonl --out ./labels.jsonl
```

Parse every non-empty JSONL line. Require the export row count to equal `task.totalRequiredAssignments`, require each `dataset_row_id` to appear exactly `task.requiredAssignmentsPerRow` times, and require every record to carry a non-null `response_id` and `response_data`. Any mismatch means a planned row lacks a response and blocks completion. Only after this response-level proof may the task be completed and its report published:

```bash
orizu tasks complete --task <task-id>
orizu tasks report set --task <task-id> --report-file ./task-report.md --json
```

## Exit check

The annotation path exits only when the ratified eval strategy, labeler feedback, app approval, complete assignment-status evidence, response-complete exported labels, and published task report are recorded together. The golden-data path exits with the PRIMARY versioned dataset ID and approved per-failure-mode field mapping recorded. The mixed path additionally records the canonical-row-`id`-keyed union of golden mappings and per-rater annotated exports. In every path, report ground-truth and disagreement counts per scenario class so J5 receives auditable evidence rather than only an aggregate.
