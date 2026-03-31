# Orizu CLI Reference

## Contents

- [Default Command Strategy](#default-command-strategy)
- [Command Matrix](#command-matrix)
- [End-to-End Flows](#end-to-end-flows)
- [Notes and Limits](#notes-and-limits)

## Default Command Strategy

1. Verify auth first: `orizu whoami`.
2. Prefer explicit flags over prompts.
3. Use interactive fallback only in TTY sessions.
4. Validate command output before proceeding.
5. On failure, fix flags/identifiers and rerun.

## Command Matrix

### Authentication

```bash
orizu login
orizu whoami
orizu logout
```

### Teams

```bash
orizu teams list
orizu teams create --name "My Team"
orizu teams members list --team my-team
orizu teams members add --email person@example.com --team my-team
orizu teams members remove --email person@example.com --team my-team
orizu teams members role --team my-team --email person@example.com --role admin
```

Allowed roles:
- `admin`
- `member`

### Projects

```bash
orizu projects list
orizu projects list --team my-team
orizu projects create --name "Quality Eval" --team my-team
```

### Apps

```bash
orizu apps list --project my-team/quality-eval
```

Create from file:

```bash
orizu apps create \
  --project my-team/quality-eval \
  --name "Labeling App" \
  --dataset <datasetId> \
  --file ./apps/LabelingApp.tsx \
  --input-schema ./schemas/input.json \
  --output-schema ./schemas/output.json
```

Update from file:

```bash
orizu apps update \
  --app <appId> \
  --file ./apps/LabelingApp.v2.tsx \
  --input-schema ./schemas/input.json \
  --output-schema ./schemas/output.json
```

Link dataset:

```bash
orizu apps link-dataset --app <appId> --dataset <datasetId>
```

### Datasets

```bash
orizu datasets upload --file ./data.csv --project my-team/quality-eval --name "Batch 1"
orizu datasets download --dataset <datasetId|datasetUrl> --format jsonl --out ./dataset.jsonl
orizu datasets append --dataset <datasetId|datasetUrl> --file ./new-rows.jsonl
orizu datasets edit-rows --dataset <datasetId|datasetUrl> --file ./edited-rows.jsonl
orizu datasets delete-rows --dataset <datasetId|datasetUrl> --row-ids row-1,row-2
orizu datasets lock --dataset <datasetId|datasetUrl> --reason "Finalize for labeling"
orizu datasets clone --dataset <datasetId|datasetUrl> --name "Batch 1 Copy"
```

Supported file types:
- `.csv`
- `.json` (array of objects)
- `.jsonl` (one object per line)

Delete rows selectors:
- `--row-ids <id1,id2>` (canonical selector)

Edit rows requirements:
- `--file` rows must include canonical `id` for each row being updated.

### Tasks

```bash
orizu tasks list
orizu tasks list --project my-team/quality-eval
```

Create:

```bash
orizu tasks create \
  --project my-team/quality-eval \
  --dataset <datasetId> \
  --app <appId> \
  --title "Round 1 labeling" \
  --assignees <userId1,userId2> \
  --instructions "Follow rubric v1" \
  --labels-per-item 2
```

Behavior:
- task creation resolves and stores the app's pinned current `version_id` at create time
- dataset compatibility is validated against that pinned app version before the task is inserted
- malformed JSON and mixed-type assignee arrays fail with deterministic `400` responses

Assign:

```bash
orizu tasks assign --task <taskId> --assignees <userId1,userId2>
```

Status:

```bash
orizu tasks status --task <taskId>
orizu tasks status --task <taskId> --json
```

Includes:
- task metadata
- progress counts
- per-assignee breakdown
- paused assignments as a distinct count, not folded into pending

Export:

```bash
orizu tasks export --task <taskId> --format jsonl --out ./labels.jsonl
```

Formats:
- `csv`
- `json`
- `jsonl`

Defaults:
- format defaults to `jsonl`
- output file defaults to `<taskId>.<format>`

## End-to-End Flows

### New Team to Export

```bash
orizu login
orizu teams create --name "Ops Eval"
orizu projects create --name "Support QA" --team ops-eval

orizu datasets upload --project ops-eval/support-qa --file ./datasets/support.jsonl --name "Support Batch 1"
orizu datasets append --dataset <datasetId> --file ./datasets/support-extra.jsonl
orizu datasets edit-rows --dataset <datasetId> --file ./datasets/support-edits.jsonl
orizu datasets delete-rows --dataset <datasetId> --row-ids row-10,row-11
orizu datasets lock --dataset <datasetId> --reason "Freeze for labeling"
orizu datasets clone --dataset <datasetId> --name "Support Batch 1 Copy"

orizu apps create \
  --project ops-eval/support-qa \
  --name "Support Labeler" \
  --dataset <datasetId> \
  --file ./apps/SupportLabeler.tsx \
  --input-schema ./schemas/support-input.json \
  --output-schema ./schemas/support-output.json

orizu apps link-dataset --app <appId> --dataset <datasetId>

orizu tasks create \
  --project ops-eval/support-qa \
  --dataset <datasetId> \
  --app <appId> \
  --title "Support QA Round 1" \
  --assignees <userId1,userId2> \
  --labels-per-item 2

orizu tasks status --task <taskId>
orizu tasks export --task <taskId> --format csv --out ./support-round1.csv
```

### Interactive-First Shortcuts

```bash
orizu apps list
orizu teams members add --email new-person@example.com
orizu datasets upload --file ./data.csv
orizu tasks export
```

Use these shortcuts only in TTY environments where prompts can run.

## Notes and Limits

- `tasks assign` expects user IDs, not emails.
- `tasks create` requires `--assignees`, creates assignments at creation time, and pins the app's current version when the task is created.
- Assignment queue reads are assignee-self-only; use task status/export as the operator summary path.
- Assignment completion payloads are validated against the pinned app-version `output_json_schema`.
- `datasets delete-rows` requires `--row-ids`.
- `datasets edit-rows` requires row objects in `--file` to include canonical `id`.
- `--row-ids` is the canonical row selection for delete operations.
- Locked datasets reject append/edit/delete row mutations.
- Row deletes are rejected when targeted rows are assignment-referenced.
- Login currently requires callback availability on `127.0.0.1:43123`.
- In non-interactive contexts, pass explicit selection flags.
- Dataset contract and HF compatibility profile: `references/dataset-canonical-contract.md`.
- Task contract and pinned-version rules: `references/task-canonical-contract.md`.
- Assignment ownership/response rules: `references/assignment-canonical-contract.md`.
