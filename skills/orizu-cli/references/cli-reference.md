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

Behavior:
- `orizu login` opens browser approval and creates a user-owned personal access token for the CLI.
- New logins store v3 API-key credentials in `~/.config/orizu/credentials.json`.
- The CLI still reads older session credentials during rollout, but new logins replace them with PAT credentials.
- `orizu logout` revokes the current PAT remotely when possible and then clears local credentials.
- PATs can also be revoked from the Personal Tokens page in Orizu.
- PAT authorization follows the owning user's current team/project roles, so demotion or removal takes effect without rotating the token.

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

Preview locally before upload:

```bash
orizu apps preview \
  --file ./apps/LabelingApp.tsx \
  --input-schema ./schemas/input.json \
  --output-schema ./schemas/output.json \
  --sample-row ./fixtures/sample-row.json \
  --screenshot ./preview.png
```

Use `--headed` for visible Chromium review and `--keep-open` to leave the browser running.

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

Export app source:

```bash
orizu apps export --app <appId> --project my-team/quality-eval --out ./apps/LabelingApp.tsx
orizu apps export --app <appId> --version 2
```

### Datasets

Row identity contract:
- `row.id` is the canonical row identifier; the rest of the JSON object is the payload.
- `row_index` is not part of canonical runtime selection. CLI flags like `--row-ids` always take canonical `id` values.

```bash
orizu datasets upload --file ./data.csv --project my-team/quality-eval --name "Batch 1"
orizu datasets download --dataset <datasetId|datasetUrl> --format jsonl --out ./dataset.jsonl
orizu datasets append --dataset <datasetId|datasetUrl> --file ./new-rows.jsonl
orizu datasets edit-rows --dataset <datasetId|datasetUrl> --file ./edited-rows.jsonl
orizu datasets delete-rows --dataset <datasetId|datasetUrl> --row-ids row-1,row-2
orizu datasets delete --dataset <datasetId|datasetUrl>
orizu datasets lock --dataset <datasetId|datasetUrl> --reason "Finalize for labeling"
orizu datasets clone --dataset <datasetId|datasetUrl> --name "Batch 1 Copy"
```

Dataset version and split-set commands used by prompt runs are covered in `prompt-control-plane.md`.

Supported file types:
- `.csv`
- `.json` (array of objects)
- `.jsonl` (one object per line)

Delete rows selectors:
- `--row-ids <id1,id2>` (canonical selector)

Delete dataset:
- `datasets delete` permanently deletes the dataset and requires an interactive terminal confirmation.
- There is no non-interactive confirmation flag.

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
  --instructions "Follow rubric v1" \
  --labels-per-item 2
```

Behavior:
- task creation creates a draft by default and returns a task URL to test manually before assigning
- use `--publish --assignees <userIdOrEmail1,userIdOrEmail2>` only when you intentionally want to create and ship immediately
- after manually approving a draft, run `orizu tasks publish --task <taskId> --assignees <userId1,userId2>`
- task creation resolves and stores the app's pinned current `version_id` at create time
- downstream consumers (exports, judges, optimization) should trust the task's pinned `version_id`, not the app's current pointer
- dataset compatibility is validated against that pinned app version before the task is inserted
- malformed JSON and mixed-type assignee arrays fail with deterministic `400` responses
- assignment fanout enforces unique `(assignee, row)` pairs; `--labels-per-item` cannot exceed the number of unique assignees, and the backend shortfalls instead of duplicating

Publish:

```bash
orizu tasks publish --task <taskId> --assignees <userId1,userId2>
```

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

Report:

```bash
orizu tasks report set --task <taskId> --report-file ./task-report.md
orizu tasks report upload --task <taskId> --report @./task-report.md
```

Behavior:
- replaces the current task report if one already exists
- accepted only when the task is `paused` or `completed`
- accepts the same `--report`, `--report @file`, and `--report-file` Markdown inputs as optimization reports

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

### Prompt Control Plane

For prompts, judges, runners, run submission, optimizer artifacts, live event logging, and accepted-candidate promotion, read `prompt-control-plane.md`. For markdown reports attached to optimization runs, read `optimization-reports.md`.

Optimization trace commands:

```bash
orizu optimizations run-gepa ... [--num-threads auto|N] [--log-dir logs] [--no-local-log]
orizu optimizations export <optimization-run-id> --out ./optimization.json
orizu optimizations export <optimization-run-id> --json
```

Behavior:
- `run-gepa` defaults `--num-threads` to `auto`, resolving a conservative row-evaluation parallelism cap from mini-batch size, validation-set size, CPU count, memory estimate, file-descriptor limit, and an 8-thread hard cap.
- `run-gepa` writes a complete local trace under `logs/<optimization_run_id>` by default.
- The local trace is the best artifact for coding-agent analysis because it includes full rows, outputs, scores, feedback, scorer responses, reflection prompts, reflection responses, candidate text, and `result.json`.
- `optimizations export` writes a portable JSON artifact from server data when the local log is unavailable or the run happened elsewhere.
- Server optimization events redact row snapshots and reflection prompts by default; export rehydrates row inputs from dataset artifacts when possible and includes bundled `run-gepa` reflection responses.

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
orizu datasets delete --dataset <datasetId>
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
  --labels-per-item 2

# Open the returned task URL and test the draft manually before assigning.
orizu tasks publish --task <taskId> --assignees <userId1,userId2>

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

- `tasks create` creates a draft by default, does not require `--assignees`, and pins the app's current version when the task is created.
- `tasks create --publish --assignees <...>` intentionally creates and ships immediately.
- `tasks assign` and `tasks publish` expect user IDs, not emails.
- Assignment queue reads are assignee-self-only; use task status/export as the operator summary path.
- Assignment completion payloads are validated against the pinned app-version `output_json_schema`.
- `datasets delete-rows` requires `--row-ids`.
- `datasets delete` requires interactive terminal confirmation and has no non-interactive confirmation flag.
- `datasets edit-rows` requires row objects in `--file` to include canonical `id`.
- `--row-ids` is the canonical row selection for delete operations.
- Locked datasets reject append/edit/delete row mutations.
- Row deletes are rejected when targeted rows are assignment-referenced.
- Login currently requires callback availability on `127.0.0.1:43123`.
- New CLI logins use personal access tokens rather than short-lived Supabase session credentials.
- In non-interactive contexts, pass explicit selection flags.

Output-schema validation surface:
- `--output-schema` JSON is validated against a subset of JSON Schema only: `type`, `required`, `properties`, `items`, `enum`. Other keywords (`pattern`, `format`, `oneOf`, etc.) are ignored. See `building-apps.md` for the contract.

Hugging Face / external dataset auth:
- Never persist auth tokens in row payloads, dataset metadata, exports, or logs.
- Store only non-secret credential references (e.g. `huggingface.token_ref`) in source metadata.

Worker assignment reads are self-only:
- Regular members cannot see other assignees' queues or response payloads.
- Use `tasks status` and `tasks export` for operator-side reporting.
