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
- A hosted session is pre-authenticated via `ORIZU_TOKEN_FILE` (no `orizu login` needed); an explicit `ORIZU_TOKEN` env var overrides both the token file and stored credentials when set.

### Agent Setup

```bash
orizu capabilities --json
orizu skills path [--skill-md] [--json]
orizu skills status [--json]
orizu skills update [--dry-run] [--json]
orizu install-skill [--agent <claude|codex|pi|devin|droid|grok|windsurf|opencode>]... [--scope global|project] [--mode auto|link|copy] [--yes] [--dry-run] [--json]
orizu setup [--team <slug>|--create-team <name>] [--project <slug>|--create-project <name>] [--agent <agent>]... [--workspace [path]|--no-workspace] [--validate] [--fix] [--no-symlinks] [--verbose] [--no-install] [--handoff|--no-handoff] [--launch <claude|codex|pi|opencode|cursor>] [--skip-login] [--dry-run] [--no-input|--non-interactive] [--json]
orizu setup prompt [--json]
```

Behavior:
- `capabilities --json` returns the full machine-readable command manifest, including `globalOptions`.
- `skills path --json` returns where this skill's source lives (`root`, `skillMd`, `source`, `cliVersion`, `skillHash`) so you can read it without installing, and verify an installed copy matches the CLI.
- `skills status` reports each install target as missing/current/stale/broken-link; `skills update` refreshes stale copies and repairs broken symlinks.
- `install-skill` selects targets by agent name; `--scope global` (default) installs user-level (`~/.agents/skills`, `~/.claude/skills`), `--scope project` installs into the repo. Project-scope installs always copy; global installs symlink when the CLI path is stable. Advanced target IDs remain available via `--target`.
- `orizu setup` is the guided onboarding flow (login → choose/create team → choose/create project → workspace contract → coding-agent skill → optional launch). Non-interactive setup requires authentication plus explicit team and project choose/create flags; run `orizu login --headless` first when needed. After interactive skill-installation consent, a destination picker starts with `Universal (.agents — Codex and others) — ~/.agents/skills/orizu` and shows each detected native target with its `~/.../orizu` destination on the same line before any write. Config-root detection requires a directory rather than a same-named regular file. Every visible destination starts selected, but every destination can be deselected. Universal and OpenCode are independent choices, so either can be installed without the other. Confirming an empty selection skips skill installation successfully. Non-interactive `--agent` semantics are unchanged: repeat `--agent` to opt into installs, each selected agent always includes Universal plus its native target only where needed, duplicate destinations are removed, and no agent flags writes no skills. Non-interactive setup never launches. Interactive setup can hand off to installed Claude, Codex, Pi, OpenCode, and Cursor commands. Available commands appear in that order, with the first available command selected by default. Other is always last and is the only option when no supported command is installed. Enter launches the highlighted agent; Esc skips agent launch and completes setup. A selected agent receives one positional prompt naming the selected `team/project` and `https://orizu.ai/llms.txt`, without shell interpolation. Selecting Other prints the complete prompt for copying without launching anything. `--handoff` explicitly prints the prompt; `--launch claude|codex|pi|opencode|cursor` explicitly selects an installed agent, still requires an interactive terminal, and asks for confirmation unless `--yes` is supplied. OpenCode launches as `opencode run <prompt>`. Cursor uses the `agent` executable, not the Cursor editor `cursor` command. The official [Cursor CLI overview](https://cursor.com/docs/cli/overview) and [parameter reference](https://cursor.com/docs/cli/reference/parameters), retrieved 2026-08-30, document direct `agent "prompt"` and `agent -p "prompt"` initial prompts; setup uses the direct positional form without a shell. Authenticated workspace setup still materializes every project in the team. The contract uses root `AGENTS.md`, `CLAUDE.md`, `Memory.md`, `orizu.team.json`, project manifests, primitive directories, and gitignore policy. `.orizu/` and `.logs/` are ignored cache/generated state, not the durable contract.

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
- `curator`
- `judge`

### Projects

```bash
orizu projects list
orizu projects list --team my-team
orizu projects create --name "Quality Eval" --team my-team
```

### Instruction sets

Follow the [Authority map](authority-map.md) for the executor on the current surface.

```bash
orizu instructions list --project my-team/quality-eval [--status active|archived|all] [--json]
orizu instructions show <set> --project my-team/quality-eval [--status active|archived|all] [--json]
orizu instructions create ./orizu.instruction-set.json --project my-team/quality-eval [--runner-version <id>] [--model-config <identity>] [--json]
orizu instructions push ./orizu.instruction-set.json --project my-team/quality-eval [--set <slug-or-exact-name>] [--runner-version <id>] [--json]
orizu instructions sync <set|set/profile|set/profile@vN> [--version <n>] [--out <app-root>] [--target ts] [--force-helpers] --project my-team/quality-eval [--json]
orizu instructions update [--out <app-root>] --project my-team/quality-eval [--no-sync] [--yes] [--json]
orizu instructions prune [--out <app-root>] [--keep <set/profile@vN>]... [--yes] [--json]
orizu instructions verify [--out <app-root>] [--json]
orizu instructions profiles new <set> --project my-team/quality-eval --model-config <identity> [--json]
orizu instructions profiles promote <set> --project my-team/quality-eval --model-config <identity> --version <n> [--json]
orizu instructions profiles rollback <set> --project my-team/quality-eval --model-config <identity> --to <n> [--json]
orizu instructions default show <set> --project my-team/quality-eval [--json]
orizu instructions default move <set> --project my-team/quality-eval --model-config <identity> [--json]
orizu instructions shape add <set> --project my-team/quality-eval --key <key> --from <manifest> [--json]
orizu instructions shape remove <set> --project my-team/quality-eval --key <key> [--json]
orizu instructions archive <slug-or-exact-name> --project my-team/quality-eval [--json]
orizu instructions restore <slug-or-exact-name> --project my-team/quality-eval [--json]
```

`instructions` is the customer-facing command namespace. The legacy
`instruction-sets` spelling remains a compatibility alias, but new workflows
should not teach it. A set can be addressed by its stable slug or exact name;
the slug does not change when the display name changes. `list` returns each
instruction set and its ordered shape. `show` returns the default and every
model-config profile's production state. Use `--status archived` or `--status
all` to include archived sets. The [Authority map](authority-map.md) selects the
executor for each surface. Archive and restore change visibility only:
archived sets continue to resolve and sync. `create` and `push` read a local
manifest; JSON output is one document per line. `push --set` updates the named
or slug-addressed set independently of the manifest's display name.

`profiles new` copies the default component map into a model-config profile without
changing its production resolution. `profiles promote` moves that profile to a
version, and `profiles rollback` creates a new version copied from `--to`,
including that target version's settings version, before moving production.
`authority-map.md` supplies the promotion-decision execution hand-off. For a
single-component set that wraps a prompt, only default-profile promote and rollback also move the wrapped
prompt's production label in the same transaction and print `default profile →
prompt label`. This coupling is one-way: moving the prompt label directly does
not repoint the profile.

`default show` reports the Default Profile and the version its Production
currently points at, or `null` when that Profile is unpromoted. Default names a
Profile, never a version, and exposes no fallback or affected-Profile list.
`default move` repoints
Default to the named Profile without moving Production; if that Profile is
unpromoted, bare resolution refuses with `instruction_set_profile_not_promoted`.
`shape add` and `shape remove` create a new complete version for every profile;
they never move Default or a Production label. The set does not resolve for affected model
configs until those pointers move to the new shape-change profile versions; the
text CLI prints the required follow-up commands.

The manifest is a JSON object with `name`, optional unversioned `description`,
ordered `shape`, and `components`. The description belongs to the instruction
set rather than any profile; `instructions show` and `instructions list` report
it, while sync emits it into no Version artifact. Every component
supplies `{ key, text }` or `{ key, path }`; paths are relative to the manifest.
Set-wide components must cover the complete shape. A component may add
`modelConfig` for a profile override: `create` materializes that named profile
with the set-wide component map plus its overrides, while `push` updates named
profiles already present on the set. `push` refuses a manifest whose shape
differs from the stored set.

`sync --target ts` (the default and currently the only supported target) writes
one immutable Synced version under
`<out>/orizu/instruction-sets/<set-slug>/<profile-slug>/vN/`: exact Component
bytes in `components/<name>.prompt.md`, a Version manifest, and
`components.generated.ts` for runtimes without filesystem access. The Version
manifest and its generated `manifest` export include the Profile Version's
frozen `settings`; `instructions show --json` exposes settings for every Version.
Non-empty settings participate in the Version digest but settings do not appear
in the Lock. Sync updates `<out>/orizu/orizu.lock.json`, whose IDs and hashes
attest the same Synced version. A runtime selects committed material from the
Lock without calling Orizu. The shipped legacy TypeScript and Python loaders
fail paved trees with `instruction_set_legacy_loader_retired` and migration
guidance; do not infer a fallback from another Profile.

Sync vendors eight fingerprinted Helper files: `load.ts`, `model-config.ts`,
`provenance.ts`, `verify.ts`, and one matching `.selfcheck.ts` file for each.
`loadModelConfig` exposes `PROVIDER`, `MODEL`, `CONFIG_IDENTITY`, `PROTOCOL`,
`THINKING_LEVEL`, `MAX_OUTPUT_TOKENS`, `TEMPERATURE`, `TOP_P`,
`STRICT_JSON_SCHEMA`, and the whole settings object as `RAW`. The loader imports Version material only from `generated/index.ts`, whose static
imports are reconciled by sync and prune; it uses no filesystem or computed
dynamic imports. Re-sync refreshes an unedited Helper and its pristine
fingerprint. Customer edits are preserved unless `--force-helpers` is supplied.
The generated tree is marked with `orizu/generated/** linguist-generated=true`.

The retired set-level `manifest.json`, `default/`, and `profiles/` tree is never
written or loaded by the paved path. If it exists, sync preserves it and refuses
with `instruction_set_sync_legacy_layout`; follow the migration guide in
`docs/cli.md` and then use the paved-path Lock and generated module.

`update` is the only command that re-resolves recorded Default and Production
Pointers. It prints every before/after value and is a no-op until `--yes`.
Approved updates sync newly referenced Versions by default. `--no-sync` records
the new Pointer values without materializing absent Versions and names every
absent exact Specifier. `update --no-sync` validates every referenced Version offline against the Lock whenever all are materialized and never executes a generated module; when Versions are missing, it records the Pointers and warns.
When every referenced Version is already materialized and
an `orizu/generated/index.ts` already exists, it also rewrites that index so the
runtime resolves the new Pointers; when either prerequisite is absent it leaves the index alone
and says so. Follow it with exact sync commands before verify or runtime use. An unset Production refuses with
`instruction_set_pointer_unresolved:production`; it never falls back.

`prune` first runs the real offline verify gate, then lists unreferenced Version
folders. It is also a no-op until `--yes`. It retains every Production Pointer,
reserved Lock Pins already written by tooling, and each repeatable exact `--keep <set/profile@vN>`.
Do not hand-edit Pins; until a Pin command ships, `--keep` applies only to that invocation.
Malformed Specifiers refuse rather than broadening retention. Value-less
`--out`/`--keep` options refuse with
`instruction_set_prune_option_missing_value:<flag>`, and unknown prune options
refuse with `instruction_set_prune_option_unknown:<flag>` before planning or
applying. A `--keep` or Lock Pin that resolves to no recorded Version refuses
with `instruction_set_prune_keep_unresolved:<specifier>`; the diagnostic names
whether each unresolved Specifier came from `--keep` or `lock.pins`. If a
Profile's final managed Version is beside unmanaged entries,
prune skips that Version so the Profile stays referenced and reports the entry
names.

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
- Every `--file` row must carry a non-empty string `id`.

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

Complete:

```bash
orizu tasks complete --task <taskId>
```

Mark an active or paused task completed only after its required response-bearing export has been verified. Completion does not publish the task report; use the Report commands above after completion.

### Instruction Control Plane

For instruction sets, judges, runners, run submission, optimizer artifacts,
live event logging, and accepted-candidate promotion, read
`prompt-control-plane.md`. For markdown reports attached to optimization runs,
read `optimization-reports.md`.

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
a hosted session exports a run outside its assigned project. In that case
`diffComments` is empty, and the marker reveals nothing about whether comments
exist.

Optimization trace commands:

```bash
orizu optimizations run-gepa ... [--scorer-input-contract gepa|flat_row] [--scorer-candidate-field <row-field>] [--allow-degenerate-seed] [--candidate-selection-strategy pareto|current_best|epsilon_greedy] [--epsilon N] [--objective <text>] [--candidate-proposer skilled-proposer] [--candidate-proposer-config @file] [--proposal-max-calls N] [--proposal-max-tokens N] [--python <command>] [--num-threads auto|N] [--reflection-retry-attempts 3] [--reflection-http-timeout-seconds 180] [--log-dir logs] [--no-local-log]
orizu optimizations run-gepa --hosted ... --budget auto|light|medium|heavy [--launch-intent-id <uuid>]
orizu optimizations export <optimization-run-id> --out ./optimization.json
orizu optimizations export <optimization-run-id> --json
```

Behavior:
- Hosted optimization is a human/PAT-only handoff for enabled teams. It makes
  one server launch request, does not require local runner/log directories,
  refuses numeric budget controls, and queues the run for the hosted
  coordinator. Reuse `--launch-intent-id` after response loss.
- `run-gepa` sends the scorer runner a GEPA-shaped row (`{source_row, candidate_output, …}`) by default. Judge runners written for flat-row score runs (`runners exec --scorer-version`) need `--scorer-input-contract flat_row` (plus `--scorer-candidate-field <row-field>` when the judge reads the candidate output from a named row field) or they silently score everything 0. `run-gepa` validates the contract on the seed at launch and refuses a uniformly-worst seed unless `--allow-degenerate-seed` is set. See `prompt-control-plane.md` ("Scorer-Runner Input Contracts").
- `run-gepa` defaults `--num-threads` to `auto`, resolving a row-evaluation parallelism cap from mini-batch size, validation-set size, 2x CPU count, memory estimate, file-descriptor limit, and a 64-thread default ceiling. Set `ORIZU_GEPA_AUTO_THREADS_MAX` or use `--num-threads <n>` only when the runner/provider capacity is known.
- `run-gepa` retries transient reflection-provider failures by default. If retries are exhausted, it logs `reflection_failed`, counts that reflection proposal against budget, and continues with the next iteration.
- The skilled proposer is official-engine-only and prepares its managed Python environment on the selected run. `--candidate-proposer-config @file` adds explicit skills/guidance and requires that selection; the selection itself is incompatible with `--reflection-prompt-template`. Schema, proposal budgets, and recovery: `prompt-control-plane.md` ("Skilled proposer").
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

- `--json` may appear before or after a command. Non-streaming commands emit one JSON document, with long-running summaries on the final stdout line; streaming `orizu run tail --json` instead emits JSONL, one event object per line.
- `tasks create` creates a draft by default, does not require `--assignees`, and pins the app's current version when the task is created.
- `tasks create --publish --assignees <...>` intentionally creates and ships immediately.
- `--assignees` and assignment-file rows accept member emails or user IDs. Email selectors resolve to canonical member IDs within the task's project team; ambiguous or unknown emails are rejected.
- `tasks create|publish|assign --assignment-file <path>` is mutually exclusive with `--assignees`.
- Assignment queue reads are assignee-self-only; use task status/export as the operator summary path.
- Assignment completion payloads are validated against the pinned app-version `output_json_schema`.
- `datasets delete-rows` requires `--row-ids`.
- `datasets delete` requires interactive terminal confirmation and has no non-interactive confirmation flag.
- `datasets edit-rows --file` requires every row to carry a non-empty string `id`.
- `--row-ids` is the canonical row selection for delete operations.
- Locked datasets reject append/edit/delete row mutations, but whole-dataset deletion does not check the lock.
- Row deletes are rejected when targeted rows are assignment-referenced.
- Login callback binding defaults to `127.0.0.1:43123`. If that port is unavailable, set `ORIZU_AUTH_PORT` to an available port from 1024–65535.
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

`orizu instructions sync` accepts `set`, `set/profile`, and `set/profile@vN`
Specifiers; `--version N` is the exact-Version equivalent when a Profile is
present. The retired sync `--model-config` option refuses; use `set/profile`.
Unknown sync flags refuse with `instruction_set_sync_option_unknown:<flag>`.
Value-less `--project`, `--out`, and `--version` options refuse by name. `--target` defaults
to `ts`; unsupported values refuse before network or disk access with
`instruction_set_sync_target_unsupported:<value>`. The target selects generated
modules and Helpers only and is not recorded in the Lock or Version manifest.
`--out` names the app root and defaults to `.`. It writes exact Component bytes,
a Version manifest, and `components.generated.ts` under
`<out>/orizu/instruction-sets/<set-slug>/<profile-slug>/vN/`. It also writes
eight vendored Helper files (`helpers/load.ts`, `helpers/model-config.ts`,
`helpers/provenance.ts`, `helpers/verify.ts`, and their runner-agnostic
`.selfcheck.ts` files), a static-only `generated/index.ts` import map,
and `<out>/orizu/orizu.lock.json`. For the TypeScript target, only
`components.generated.ts`, `generated/index.ts`, and `helpers/*.ts` are
target-specific; Component files, Version manifests, and the Lock remain
language-neutral. Every relative import the CLI emits carries an explicit `.js`
extension so the tree compiles under `moduleResolution` `nodenext` and `bundler`
alike. Put compiled JavaScript in an `outDir`. Verification rejects every
in-place `.js` sibling of an emitted `.ts` file; a fresh in-place compile is also
refused because this is a layout rule, not a staleness check. Direct
`node --experimental-strip-types` execution cannot resolve the vendored `.ts`
files through those `.js` specifiers; compile first or use a TypeScript-aware
runtime. The loader returns Components and Version-manifest settings
plus Provenance. `loadModelConfig` names the selected Version's `PROVIDER`,
`MODEL`, `CONFIG_IDENTITY`, `PROTOCOL`, `THINKING_LEVEL`, `MAX_OUTPUT_TOKENS`,
`TEMPERATURE`, `TOP_P`, and `STRICT_JSON_SCHEMA`, and retains all settings under
`RAW`. It resolves through the same Specifier and Lock entry. The loader reads
from the selected Lock entry without calling Orizu or re-resolving a Pointer. It also retains the generated module's Provenance claim
for offline integrity cross-checking. An existing Lock Version whose immutable
IDs or hashes disagree refuses with `instruction_set_sync_version_conflict`;
only its `syncedAt` observation is preserved. `attachProvenance(target, loaded)`
sets `orizu.instruction_set.id`, `orizu.profile_version.id`, and
`orizu.instruction_set.digest` on a span-like target or plain attribution object.
Filter read-back with `scorers detail --profile-version <id>`,
`optimizations list --profile-version <id>`, or `runs list --profile-version <id>`.
For `runs submit`, `scorers exec`, and `scores submit`, `--instructions <specifier>`
with optional `--instructions-root <dir>` resolves Provenance only through the
Lock and never calls Orizu. Bare and `set/profile` specifiers require a promoted
Production version; an exact `set/profile@vN` specifier resolves that locked
version without requiring Production.

The Lock fingerprints exact pristine Helper bytes, including runner-safe
`load.selfcheck.ts`, `provenance.selfcheck.ts`, and `verify.selfcheck.ts` files. These self-checks read the customer's generated map and synced bytes and refuse an empty map instead of using synthetic fixtures. Re-sync warns and preserves
an edited Helper; `--force-helpers` overwrites it and refreshes the fingerprint.
A hand-written or older Lock without `helpers` fingerprints conservatively treats
older differing Helper bytes as edited; re-run sync with `--force-helpers` to
replace them. Bytes matching the current template recover an interrupted upgrade without a
warning. `sync --json` includes every warning in one document's always-present
`warnings` array. `verifyIntegrity({ ...loaded, digest:
loaded.provenance.digest }, lock)` cross-checks generated Provenance and hashes
the strings and required Version-manifest settings the process loaded, detecting
identity substitution, whitespace-only mutation, or a mismatched digest. The supplied digest must equal the Provenance-selected Lock entry: a digest belonging only to another Version fails with `instruction_set_integrity_digest_unselected`, while one absent from the Lock fails with `instruction_set_integrity_digest_unknown`.
Managed artifact writes are symlink-confined. Emitted code imports no `fs` runtime and
is suitable for Workers and Node TypeScript targets. The app-root
`.gitattributes` applies `orizu/** -text` so Git EOL conversion cannot alter fingerprinted bytes, and marks `orizu/generated/** linguist-generated=true`.

Sync reuses non-null Default and Production Pointer values recorded in the Lock
and prints an `update` hint; a null value was never resolved and may be filled
once. Unset Production is
a hard error with a `profiles promote` command. A second identical sync writes
nothing, and another Version is additive. A retired set-level `manifest.json` /
`default/` / `profiles/` tree refuses as `instruction_set_sync_legacy_layout`;
follow the migration guide in `docs/cli.md` rather than mixing layouts.

### Offline instruction-set verification

Use this copy-pasteable CI gate after sync and on every committed change:

```bash
orizu instructions verify --out .
```

It is fully offline: do not add credentials or a project flag. It exits non-zero
for Lock, Version manifest, exact Component byte, generated-module,
runtime-loaded byte, Pointer, folder, import-map, or missing-Helper failures.
`--json` emits `{ ok, failures, warnings }` with stable `group`, `code`, `path`,
`expected`, and `found` fields. A customer-modified fingerprinted Helper is a
warning and does not change the exit status; a missing fingerprinted Helper is a
failure. A `default` Profile absent from the synced `profiles` map is valid and
is not probed. Runtime probes execute only integrity-checked generated modules
and scrub Orizu credentials and unrelated CI secrets from the child environment.
