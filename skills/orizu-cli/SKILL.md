---
name: orizu-cli
description: Runs and troubleshoots Orizu CLI workflows for auth and workspace operations. Use when a request involves `orizu` commands, flags, interactive fallback behavior, or team/project/app/dataset/task lifecycle actions.
---

# Orizu CLI

## Use This Skill When

- The request asks to run, explain, or debug `orizu` commands.
- The request involves auth (`login`, `logout`, `whoami`) or workspace setup.
- The request involves CLI lifecycle operations for teams, projects, apps, datasets, or tasks.

## Skip This Skill When

- The request is web-UI only and does not involve the CLI.
- The request is unrelated to Orizu workspace operations.

## Prerequisites

- Ensure Node.js 20+ is installed.
- Ensure Orizu API is running (`http://localhost:3000` by default) or set `ORIZU_BASE_URL`.
- Build CLI from source when needed:
  ```bash
  bun install
  bun x tsc -p packages/cli/tsconfig.json
  node packages/cli/dist/index.js --help
  ```
- Use `orizu` directly when globally installed; otherwise run `node packages/cli/dist/index.js ...`.

## Default Workflow

Copy this checklist for complex requests:

```text
CLI Progress:
- [ ] 1. Verify auth and target server (`orizu whoami`)
- [ ] 2. Resolve required identifiers (team/project/app/task/dataset)
- [ ] 3. Run command with explicit flags first
- [ ] 4. Validate output and side effects
- [ ] 5. If failure, read error, fix inputs, rerun
```

## Quick Start

1. Authenticate:
   ```bash
   orizu login
   orizu whoami
   ```
2. Set up workspace:
   ```bash
   orizu teams create --name "Ops Eval"
   orizu projects create --name "Support QA" --team ops-eval
   ```
3. Upload dataset:
   ```bash
   orizu datasets upload --project ops-eval/support-qa --file ./datasets/support.jsonl --name "Support Batch 1"
   ```
4. Optionally append new rows later:
   ```bash
   orizu datasets append --dataset <datasetId> --file ./datasets/support-additional.jsonl
   ```
5. Optionally edit existing rows in place (each row must include canonical `id`):
   ```bash
   orizu datasets edit-rows --dataset <datasetId> --file ./datasets/support-edits.jsonl
   ```
6. Optionally delete incorrect rows:
   ```bash
   orizu datasets delete-rows --dataset <datasetId> --row-ids <rowId1,rowId2>
   ```
7. Optionally lock or clone dataset snapshots:
   ```bash
   orizu datasets lock --dataset <datasetId> --reason "Finalize for labeling"
   orizu datasets clone --dataset <datasetId> --name "Support Batch 1 Copy"
   ```
7. Create or update app from file (dataset is required):
   ```bash
   orizu apps create \
     --project ops-eval/support-qa \
     --name "Support Labeler" \
     --dataset <datasetId> \
     --file ./apps/SupportLabeler.tsx \
     --input-schema ./schemas/support-input.json \
     --output-schema ./schemas/support-output.json
   ```
8. Optionally link a different dataset to an existing app version:
   ```bash
   orizu apps link-dataset --app <appId> --dataset <datasetId>
   ```
9. Run task lifecycle (task create requires assignees and creates assignments immediately):
   ```bash
   orizu tasks create --project ops-eval/support-qa --dataset <datasetId> --app <appId> --title "Support QA Round 1" --assignees <userId1,userId2>
   orizu tasks status --task <taskId>
   orizu tasks export --task <taskId> --format csv --out ./support-round1.csv
   ```

## Execution Rules

- Prefer explicit flags for automation and CI.
- Use interactive fallback only in a TTY when required selectors are omitted.
- Use explicit selectors whenever possible:
  - `--team`, `--project`, `--app`, `--task`, `--dataset`, `--assignees`.
- For `tasks assign`, pass user IDs, not emails.
- For `datasets edit-rows`, each row object in `--file` must include a non-empty string `id`.
- For `datasets delete-rows`, use `--row-ids` selectors.
- Export defaults: `--format jsonl`, output `<taskId>.<format>`.
- Auth failure loop:
  - run `orizu login`
  - confirm with `orizu whoami`
  - rerun command
- Login callback requires `127.0.0.1:43123`.
- Credentials path: `~/.config/orizu/credentials.json`.

## References

- Read `references/cli-reference.md` for complete command examples and end-to-end flows.
- Read `references/dataset-canonical-contract.md` for dataset identity, count, lineage, lock, and HF compatibility rules used by CLI workflows.
