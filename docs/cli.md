# Orizu CLI Guide

This document explains how to use the `orizu` CLI end-to-end.

## What The CLI Covers

The CLI supports:

- Authentication (`login`, `logout`, `whoami`)
- Team management (list/create, members list/add/remove/role)
- Project management (list/create)
- App management (list/create/update/link dataset)
- Task management (list/create/assign/status/export)
- Dataset management (upload/download/append/delete rows: `csv`, `json`, `jsonl`)

## Prerequisites

- Node.js 20+
- Running Orizu web app/API (default: `https://orizu.ai`)
- Valid Orizu account

Optional environment variable:

- `ORIZU_BASE_URL` (example: `https://your-orizu-domain.com`)

If not set, CLI uses `https://orizu.ai`.

Override examples:

```bash
# local development
ORIZU_BASE_URL=http://localhost:3000 orizu login

# preview branch / ephemeral deploy
ORIZU_BASE_URL=https://<preview-domain> orizu login
```

## Install / Build

From this repository:

```bash
bun install
bun x tsc -p packages/cli/tsconfig.json
node packages/cli/dist/index.js --help
```

If installed globally as `orizu`, you can run commands directly.  
From source, use:

```bash
node packages/cli/dist/index.js <command> ...
```

## Authentication

### Login

```bash
orizu login
```

What happens:

1. CLI starts a localhost callback server on `127.0.0.1:43123`.
2. CLI opens browser for approval.
3. After approval, CLI exchanges auth code for tokens.
4. Credentials are stored at:
   - `~/.config/orizu/credentials.json`

### Who Am I

```bash
orizu whoami
```

### Logout

```bash
orizu logout
```

## Command Reference

## Teams

### List teams

```bash
orizu teams list
```

### Create team

```bash
orizu teams create --name "My Team"
```

Interactive fallback:
- If `--name` is omitted in a TTY, CLI prompts for team name.

### List team members

```bash
orizu teams members list --team my-team
```

Interactive fallback:
- If `--team` is omitted, CLI prompts for team selection.

### Add team member

```bash
orizu teams members add --email person@example.com --team my-team
```

Interactive fallback:
- If `--team` is omitted, CLI prompts for team.

Behavior:
- If user does not exist yet, invite flow is used (user creation + invitation email + membership).

### Remove team member

```bash
orizu teams members remove --email person@example.com --team my-team
```

Interactive fallback:
- If `--team` is omitted, CLI prompts for team.

### Change member role

```bash
orizu teams members role --team my-team --email person@example.com --role admin
```

Allowed roles:
- `admin`
- `member`

## Projects

### List projects

```bash
orizu projects list
orizu projects list --team my-team
```

### Create project

```bash
orizu projects create --name "Quality Eval" --team my-team
```

Interactive fallback:
- If `--team` is omitted, CLI prompts for team.

## Apps

### List apps

```bash
orizu apps list --project my-team/quality-eval
```

Interactive fallback:
- If `--project` is omitted, CLI prompts for team then project.

### Create app from file

```bash
orizu apps create \
  --project my-team/quality-eval \
  --name "Labeling App" \
  --dataset <datasetId> \
  --file ./apps/LabelingApp.tsx \
  --input-schema ./schemas/input.json \
  --output-schema ./schemas/output.json
```

Optional:
- `--component <ComponentName>`

Requirements:
- Source file must pass component contract validation.
- `input-schema` and `output-schema` are required JSON object files.
- `--dataset` is required and must reference a dataset in the same project.

### Update app from file (new version)

```bash
orizu apps update \
  --app <appId> \
  --file ./apps/LabelingApp.v2.tsx \
  --input-schema ./schemas/input.json \
  --output-schema ./schemas/output.json
```

Optional:
- `--project my-team/quality-eval`
- `--component <ComponentName>`

Interactive fallback:
- If `--app` is omitted, CLI prompts for app selection.

### Link dataset to app version (for preview/data-backed behavior)

```bash
orizu apps link-dataset --app <appId> --dataset <datasetId>
```

Optional:
- `--version <n>` (defaults to the app's current pinned version)
- `--project my-team/quality-eval` (used when selecting app interactively)

Interactive fallback:
- If `--app` is omitted, CLI prompts for app selection.

## Datasets

Canonical contract reference:
- `docs/contracts/dataset-canonical-contract.md`

### Upload dataset

```bash
orizu datasets upload --file ./data.csv --project my-team/quality-eval --name "Batch 1"
```

Supported file types:
- `.csv`
- `.json` (array of objects)
- `.jsonl` (one object per line)

Interactive fallback:
- If `--project` is omitted, CLI prompts for team then project.

Output:
- dataset id
- row count
- dataset URL

### Download dataset

```bash
orizu datasets download --dataset <datasetId|datasetUrl> --format jsonl --out ./dataset.jsonl
```

Supported formats:
- `csv`
- `json`
- `jsonl` (default)

Ways to identify the dataset:
- `--dataset <datasetId>`
- `--dataset <datasetUrl>` (for example `https://orizu.ai/d/team/project/datasets/<id>`)
- positional dataset value: `orizu datasets download <datasetId-or-url>`

Interactive fallback:
- If `--dataset` (or positional value) is omitted, CLI prompts for:
  1. team
  2. project
  3. dataset

### Append dataset rows

```bash
orizu datasets append --dataset <datasetId|datasetUrl> --file ./new-rows.jsonl
```

Supported file types:
- `.csv`
- `.json` (array of objects)
- `.jsonl` (one object per line)

Behavior:
- Appends rows to the end of the dataset.
- Auto-generates `id` for any appended row that does not include one.

Interactive fallback:
- If `--dataset` is omitted, CLI prompts for team/project/dataset.

### Edit dataset rows

```bash
orizu datasets edit-rows --dataset <datasetId|datasetUrl> --file ./edited-rows.jsonl
```

Supported file types:
- `.csv`
- `.json` (array of objects)
- `.jsonl` (one object per line)

Requirements:
- Every row in the file must include canonical `id` as a non-empty string.

Behavior:
- Updates row payloads by canonical row `id`.
- Does not change row identity.

Interactive fallback:
- If `--dataset` is omitted, CLI prompts for team/project/dataset.

### Delete dataset rows

```bash
orizu datasets delete-rows --dataset <datasetId|datasetUrl> --row-ids row-1,row-2
```

Requirements:
- Provide `--row-ids <id1,id2>`.

Contract note:
- Canonical row identity is row `id`.
- `row_index` selectors are removed from the canonical CLI runtime path.

Interactive fallback:
- If `--dataset` is omitted, CLI prompts for team/project/dataset.

### Lock dataset

```bash
orizu datasets lock --dataset <datasetId|datasetUrl> --reason "Finalize for labeling"
```

Behavior:
- Locks the dataset as a one-way operation.
- Locked datasets reject append/edit/delete mutations.

Interactive fallback:
- If `--dataset` is omitted, CLI prompts for team/project/dataset.

### Clone dataset

```bash
orizu datasets clone --dataset <datasetId|datasetUrl> --name "Batch 1 Copy"
```

Behavior:
- Creates an independent copy with lineage metadata.
- Clone is unlocked by default.

Interactive fallback:
- If `--dataset` is omitted, CLI prompts for team/project/dataset.

## Tasks

### List tasks

```bash
orizu tasks list
orizu tasks list --project my-team/quality-eval
```

### Create task

```bash
orizu tasks create \
  --project my-team/quality-eval \
  --dataset <datasetId> \
  --app <appId> \
  --version 3 \
  --title "Round 1 labeling" \
  --assignees <userId1,userId2> \
  --instructions "Follow rubric v1" \
  --labels-per-item 2
```

Task creation behavior:
- `--assignees` is required.
- `--version <n>` is optional and defaults to the app's current pinned version.
- Assignments are created immediately during `tasks create`.
- The backend resolves and pins either the requested app version or the app's current `version_id` at task-creation time.
- Dataset compatibility is validated against that pinned app version before any task rows are inserted, including per-row input-schema checks.

### Assign task

```bash
orizu tasks assign --task <taskId> --assignees <userId1,userId2>
```

Note:
- `--assignees` currently expects user IDs (comma-separated), not emails.

### Task status

```bash
orizu tasks status --task <taskId>
orizu tasks status --task <taskId> --json
```

Includes:
- task metadata
- progress counts
- per-assignee breakdown
- paused assignments as a distinct count, not folded into pending

### Export task outputs

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
- if `--task` omitted, CLI prompts interactively

## End-to-End Examples

### Example 1: New Team -> Project -> Dataset -> App -> Task

```bash
orizu login
orizu teams create --name "Ops Eval"
orizu projects create --name "Support QA" --team ops-eval

orizu datasets upload --project ops-eval/support-qa --file ./datasets/support.jsonl --name "Support Batch 1"
orizu datasets append --dataset <datasetId> --file ./datasets/support-extra.jsonl
orizu datasets edit-rows --dataset <datasetId> --file ./datasets/support-edits.jsonl
orizu datasets delete-rows --dataset <datasetId> --row-ids row-10,row-11
orizu datasets lock --dataset <datasetId> --reason "Finalize for labeling"
orizu datasets clone --dataset <datasetId> --name "Support Batch 1 Copy"

orizu apps create \
  --project ops-eval/support-qa \
  --name "Support Labeler" \
  --dataset <datasetId> \
  --file ./apps/SupportLabeler.tsx \
  --input-schema ./schemas/support-input.json \
  --output-schema ./schemas/support-output.json

# Link app version to dataset for preview behavior
orizu apps link-dataset --app <appId> --dataset <datasetId>

orizu tasks create \
  --project ops-eval/support-qa \
  --dataset <datasetId> \
  --app <appId> \
  --version 1 \
  --title "Support QA Round 1" \
  --assignees <userId1,userId2> \
  --labels-per-item 2

orizu tasks status --task <taskId>
orizu tasks export --task <taskId> --format csv --out ./support-round1.csv
```

### Example 2: Interactive-first workflow

```bash
orizu apps list
orizu teams members add --email new-person@example.com
orizu datasets upload --file ./data.csv
orizu tasks export
```

The commands above will prompt for team/project/task selection where needed.

## Error Handling Notes

- Missing auth:
  - `Not logged in. Run 'orizu login' first.`
- Non-interactive environments:
  - For required selections, provide explicit flags (team/project/app/task).
- Validation errors:
  - App create/update rejects invalid component contract and invalid schema files.
  - App create requires `--dataset`.
  - Task create requires `--assignees`.

## Current Limitations

- `tasks assign` accepts assignee user IDs, not emails.
- Assignment queue reads are assignee-self-only; use task status/export as the operator summary path.
- Assignment completion payloads are validated against the task's pinned app-version `output_json_schema`.
- Login flow currently expects localhost callback availability (`127.0.0.1:43123`).
- CLI package publishing/distribution is separate from this usage doc (examples assume local build or installed binary).
