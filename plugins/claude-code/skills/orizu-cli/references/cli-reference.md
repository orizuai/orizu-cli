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
4. Prefer `--json` for machine-readable output — every command supports it (prefix `orizu --json <cmd>` or trailing flag). Long-running commands emit the JSON summary as the final stdout line.
5. Validate command output before proceeding.
6. On failure, fix flags/identifiers and rerun.

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
- Hosted sandboxes are pre-authenticated via `ORIZU_TOKEN_FILE` (no `orizu login` needed); an explicit `ORIZU_TOKEN` env var overrides both the token file and stored credentials when set.

### Agent Setup

```bash
orizu capabilities --json
orizu skills path [--skill-md] [--json]
orizu skills status [--json]
orizu skills update [--dry-run] [--json]
orizu install-skill [--agent <claude|codex>]... [--scope global|project] [--mode auto|link|copy] [--yes] [--dry-run] [--json]
orizu setup [--team <slug>] [--agent <claude|codex>]... [--workspace [path]|--no-workspace] [--validate] [--fix] [--no-symlinks] [--verbose] [--no-install] [--handoff] [--yes] [--dry-run] [--no-input|--non-interactive] [--json]
orizu setup prompt [--json]
```

Behavior:
- `capabilities --json` returns the full machine-readable command manifest, including `globalOptions`.
- `skills path --json` returns where this skill's source lives (`root`, `skillMd`, `source`, `cliVersion`, `skillHash`) so you can read it without installing, and verify an installed copy matches the CLI.
- `skills status` reports each install target as missing/current/stale/broken-link; `skills update` refreshes stale copies and repairs broken symlinks.
- `install-skill` selects targets by agent name; `--scope global` (default) installs user-level (`~/.codex/skills`, `~/.claude/skills`), `--scope project` installs into the repo. Project-scope installs always copy; global installs symlink when the CLI path is stable. Advanced target IDs remain available via `--target`.
- `orizu setup` is the guided onboarding flow (login → team workspace contract → global coding-agent skill install). Use `orizu setup --team <slug>` for agent-friendly setup of the current directory; after authentication it materializes every project in that team. Use `--workspace <path>` only when setting up or validating another directory. Interactive setup offers Codex when `~/.codex` exists and Claude Code when `~/.claude` exists; pass `--agent codex --agent claude` for non-interactive installs. The contract uses root `AGENTS.md`, `CLAUDE.md`, `Memory.md`, `orizu.team.json`, project manifests, primitive directories, and gitignore policy. `.orizu/` and `.logs/` are ignored cache/generated state, not the durable contract. `orizu setup prompt` prints the repo-adoption prompt for handing to a coding agent; pass `orizu setup --handoff` only when you want that prompt printed inline after setup.

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

### Instruction sets

```bash
orizu instruction-sets list --project my-team/quality-eval [--status active|archived|all] [--json]
orizu instruction-sets show <set> --project my-team/quality-eval [--status active|archived|all] [--json]
orizu instruction-sets create ./orizu.instruction-set.json --project my-team/quality-eval [--runner-version <id>] [--model-config <identity>] [--json]
orizu instruction-sets push ./orizu.instruction-set.json --project my-team/quality-eval [--runner-version <id>] [--json]
orizu instruction-sets sync <set> --out ./instructions --project my-team/quality-eval [--model-config <identity>] [--json]
orizu instruction-sets profiles new <set> --project my-team/quality-eval --model-config <identity> [--json]
orizu instruction-sets profiles promote <set> --project my-team/quality-eval --model-config <identity> --version <n> [--json]
orizu instruction-sets profiles rollback <set> --project my-team/quality-eval --model-config <identity> --to <n> [--json]
orizu instruction-sets default show <set> --project my-team/quality-eval [--json]
orizu instruction-sets default move <set> --project my-team/quality-eval --model-config <identity> --version <n> [--json]
orizu instruction-sets shape add <set> --project my-team/quality-eval --key <key> --from <manifest> [--json]
orizu instruction-sets shape remove <set> --project my-team/quality-eval --key <key> [--json]
```

`list` returns each instruction set and its ordered shape. `show` returns the
default and every model-config profile's production state. `create` and `push`
read a local manifest; JSON output is one document per line.

`profiles new` copies the default tuple into a model-config profile without
changing its production resolution; hosted agents may create this seed because
it does not move production. `profiles promote` moves that profile to a
version, and `profiles rollback` creates a new version copied from `--to`,
including that target version's settings version, before moving production.
These label-moving commands are human-only. For a single-component set that
wraps a prompt, only default-profile promote and rollback also move the wrapped
prompt's production label in the same transaction and print `default profile →
prompt label`. This coupling is one-way: moving the prompt label directly does
not repoint the profile.

`default show` reports the default and the model configs that currently resolve
to it. `default move` is human-only and first reads that impact before moving
the pointer to a sealed, commit-anchored profile version. `shape add` and
`shape remove` create a new complete version for every profile; they never move
the default or a production label. The set does not resolve for affected model
configs until those pointers move to the new shape-change profile versions; the
text CLI prints the required follow-up commands.

The manifest is a JSON object with `name`, ordered `shape`, and `components`.
Every component supplies `{ key, text }` or `{ key, path }`; paths are relative
to the manifest. Set-wide components must cover the complete shape. A component
may add `modelConfig` for a profile override: `create` materializes that named
profile with the set-wide tuple plus its overrides, while `push` updates named
profiles already present on the set. `push` refuses a manifest whose shape
differs from the stored set.

`sync` writes `<out>/<set>/manifest.json`, `default/<key>.md`, and
`profiles/<identity-slug>/<key>.md` for offline execution. TypeScript runners
use `loadInstructionSet(dir, name, modelConfigIdentity)` from `orizu`; Python
runners use `orizu_gepa_connector.instruction_set_loader.load_instruction_set`.
Both select that model config's production tuple or the default without a
network call. Git-pinned components have no local bytes: loading one raises
`instruction_set_component_unavailable` until the runner supplies those bytes.
An existing manifest file that cannot be read is instead
`instruction_set_component_unreadable`, which means re-sync or repair disk
state rather than supplying a Git-pinned component.

### Apps

```bash
orizu apps list --project my-team/quality-eval
orizu apps list --project my-team/quality-eval --status archived
orizu apps archive <app-id> --project my-team/quality-eval
orizu apps restore <app-id> --project my-team/quality-eval
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
orizu datasets list --project my-team/quality-eval [--status active|archived|all]
orizu datasets archive <dataset-id> --project my-team/quality-eval
orizu datasets restore <dataset-id> --project my-team/quality-eval
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

### Model configs

```bash
orizu model-configs create azure/gpt-5.4-mini --settings @settings.json --project my-team/quality-eval
orizu model-configs list --project my-team/quality-eval --json
orizu model-configs show azure/gpt-5.4-mini --project my-team/quality-eval
orizu model-configs settings set azure/gpt-5.4-mini --settings '{"temperature":0.3}' --project my-team/quality-eval
orizu model-configs copy openai/gpt-5.4-mini --to azure/gpt-5.4-mini --project my-team/quality-eval
```

Model identities are lowercase `provider/model` values and unique within a project. Creating a config creates settings version 1 (with `{}` when `--settings` is omitted). `settings set` appends a settings version and advances the current pointer; `copy` snapshots the source’s current settings and display name into version 1 for the new identity. `--settings` accepts a JSON object or `@file`; all commands support `--json`.

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
orizu tasks list --project my-team/quality-eval --status archived
orizu tasks archive <task-id> --project my-team/quality-eval
orizu tasks restore <task-id> --project my-team/quality-eval
orizu assignments list --project my-team/quality-eval [--status active|archived|all]
orizu assignments archive <task-id> --project my-team/quality-eval [--assignee <user-id>]
orizu assignments restore <task-id> --project my-team/quality-eval [--assignee <user-id>]
```

Archive is reversible visibility state and never deletes task/assignment data
or changes lifecycle. List commands default to active inventory. Scorers and
optimization runs use the same contract:

```bash
orizu scorers list --project my-team/quality-eval [--status active|archived|all]
orizu scorers archive <scorer-id> --project my-team/quality-eval
orizu scorers restore <scorer-id> --project my-team/quality-eval
orizu optimizations list --project my-team/quality-eval [--status active|archived|all]
orizu optimizations archive <run-id> --project my-team/quality-eval
orizu optimizations restore <run-id> --project my-team/quality-eval
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
- use `--assignment-file <path>` instead of `--assignees` when specific rows should go to specific labellers
- after manually approving a draft, run `orizu tasks publish --task <taskId> --assignees <userId1,userId2>`
- or run `orizu tasks publish --task <taskId> --assignment-file <path>` to publish the exact row map
- task creation resolves and stores the app's pinned current `version_id` at create time
- downstream consumers (exports, judges, optimization) should trust the task's pinned `version_id`, not the app's current pointer
- dataset compatibility is validated against that pinned app version before the task is inserted
- malformed JSON and mixed-type assignee arrays fail with deterministic `400` responses
- assignment fanout enforces unique `(assignee, row)` pairs; `--labels-per-item` cannot exceed the number of unique assignees, and the backend shortfalls instead of duplicating
- explicit assignment manifests are JSONL with `rowId` plus `assignee` or `assignees`; row IDs are canonical dataset row `id` values, assignees may be emails or user IDs, and V1 publish requires whole-dataset uniform coverage

Publish:

```bash
orizu tasks publish --task <taskId> --assignees <userId1,userId2>
orizu tasks publish --task <taskId> --assignment-file ./assignments.jsonl
```

Assign:

```bash
orizu tasks assign --task <taskId> --assignees <userId1,userId2>
orizu tasks assign --task <taskId> --assignment-file ./assignments.jsonl --replace-existing
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

Diff-comment export:

```bash
orizu comments diff --run <optimization-run-id> [--from <candidate-id> --to <candidate-id>] [--detail hunk|diff|full] [--json]
orizu comments diff --prompt <prompt-id> [--from <version> --to <version>] [--detail hunk|diff|full] [--json]
```

Exactly one target is required, and `--from` / `--to` must appear together.
Prompt pair selectors are integer version numbers. Human output groups comments
by pair and renders anchored hunks; `--json` emits the complete machine payload.
Each available side prints `From:` or `To:` length stats; one side can be
`unavailable (<reason>)` while the other remains visible. Machine output allows
`lengthStats.from` and `lengthStats.to` to be independently null and names the
side failures in `fromUnavailableReason` and `toUnavailableReason`. A wholly
unavailable pair prints `Length: unavailable (<reason>)`; a missing delta
prints `Length delta: unavailable`. Otherwise `Tokens:`, `Lines:`, `Chars:`,
and `Words:` show removed/added/net rows. A `Split unavailable:` row names the
exact guard when split churn cannot be computed; removed/added are `—` but the
independent net remains numeric.
Unrecoverable context is retained with a named degradation reason rather than
dropping a comment. Optimization export includes the same data at
`diffComments` using hunk detail. It also includes
`diffCommentsSuppressedReason`: normally `null`, or `agent_project_scope` when
a hosted agent exports a run outside its assigned project. In that case
`diffComments` is empty, and the marker reveals nothing about whether comments
exist.

Optimization trace commands:

```bash
orizu optimizations run-gepa ... [--scorer-input-contract gepa|flat_row] [--scorer-candidate-field <row-field>] [--allow-degenerate-seed] [--candidate-selection-strategy pareto|current_best|epsilon_greedy] [--epsilon N] [--objective <text>] [--candidate-proposer skilled-proposer] [--proposal-max-calls N] [--proposal-max-tokens N] [--python <command>] [--num-threads auto|N] [--reflection-retry-attempts 3] [--reflection-http-timeout-seconds 180] [--log-dir logs] [--no-local-log]
orizu optimizations export <optimization-run-id> --out ./optimization.json
orizu optimizations export <optimization-run-id> --json
```

Behavior:
- `run-gepa` sends the scorer runner a GEPA-shaped row (`{source_row, candidate_output, …}`) by default. Judge runners written for flat-row score runs (`runners exec --scorer-version`) need `--scorer-input-contract flat_row` (plus `--scorer-candidate-field <row-field>` when the judge reads the candidate output from a named row field) or they silently score everything 0. `run-gepa` validates the contract on the seed at launch and refuses a uniformly-worst seed unless `--allow-degenerate-seed` is set. See `prompt-control-plane.md` ("Scorer-Runner Input Contracts").
- `run-gepa` defaults `--num-threads` to `auto`, resolving a row-evaluation parallelism cap from mini-batch size, validation-set size, 2x CPU count, memory estimate, file-descriptor limit, and a 64-thread default ceiling. Set `ORIZU_GEPA_AUTO_THREADS_MAX` or use `--num-threads <n>` only when the runner/provider capacity is known.
- `run-gepa` retries transient reflection-provider failures by default. If retries are exhausted, it logs `reflection_failed`, counts that reflection proposal against budget, and continues with the next iteration.
- The skilled proposer is official-engine-only and prepares its managed Python environment on the selected run. Flag validation, proposal budgets, and recovery: `prompt-control-plane.md` ("Skilled proposer").
- `run-gepa` writes a complete local trace under `logs/<optimization_run_id>` by default.
- The local trace is the best artifact for coding-agent analysis because it includes full rows, outputs, scores, feedback, scorer responses, reflection prompts, reflection responses, candidate text, and `result.json`.
- `optimizations export` writes a portable JSON artifact from server data when the local log is unavailable or the run happened elsewhere.
- The v1 export preserves the run row's `best_candidate_id` in `summary.bestCandidateId` when event derivation rejects it as unknown; candidate detail may be absent, and the field is `null` when neither source names a best candidate.
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
# Or publish a deterministic row map:
orizu tasks publish --task <taskId> --assignment-file ./assignments.jsonl

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
- `tasks create|publish|assign --assignment-file <path>` is mutually exclusive with `--assignees` and accepts emails or user IDs in the JSONL manifest.
- `tasks assign --assignees` and `tasks publish --assignees` expect user IDs, not emails.
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
### Offline instruction-set sync

`orizu instruction-sets sync <set> --project <team/project> --out <dir>` writes
an atomic local manifest. A resolver failure for either the default or any
selected profile refuses the entire sync as `instruction_set_unresolvable`; the
route never silently downgrades a failed production tuple to default bytes. A
filtered `--model-config` sync records `filteredTo`, and a loader must refuse an
identity excluded by that marker with `instruction_set_profile_not_synced`.

Use `import { loadInstructionSet } from 'orizu/instruction-set-loader'` for the
small typed TypeScript loader surface; Python uses
`from orizu_gepa_connector import load_instruction_set`.
