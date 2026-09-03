# Orizu CLI Guide

This document explains how to use the `orizu` CLI end-to-end.

## What The CLI Covers

The CLI supports:

- Authentication (`login`, `logout`, `whoami`)
- Team management (list/create, members list/add/remove/role)
- Project management (list/create)
- App management (list/create/update/detail/link dataset)
- Task management (list/create/assign/status/report/pause/unpause/export)
- Dataset management (upload/download/append/delete rows: `csv`, `json`, `jsonl`)

## Prerequisites

- Node.js 20+
- Running Orizu web app/API (default: `https://orizu.ai`)
- Valid Orizu account

Optional environment variable:

- `ORIZU_BASE_URL` (example: `https://your-orizu-domain.com`)
- `ORIZU_AUTH_PORT` (example: `44123`, used for the localhost login callback)

If not set, CLI uses `https://orizu.ai`.

Override examples:

```bash
# local development
ORIZU_BASE_URL=http://localhost:3000 orizu login

# preview branch / ephemeral deploy
ORIZU_BASE_URL=https://<preview-domain> orizu login
```

## Install / Build

From npm:

```bash
npm i -g orizu
orizu install-skill --target codex-user --yes
orizu --help
```

The npm package includes the `orizu` coding-agent skill. The install command
can write the skill to user-level agent paths, project-level Codex/Claude paths,
or a managed `AGENTS.md` section:

```bash
orizu install-skill --help
orizu install-skill --target codex-project --target agents-md
orizu capabilities --json
```

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

1. CLI starts a localhost callback server on `127.0.0.1:43123` by default, or the port from `ORIZU_AUTH_PORT` if set.
2. CLI opens browser for approval.
3. After approval, Orizu creates a user-owned personal access token for the CLI and returns it once through the encrypted auth-code handoff.
4. The CLI stores a v3 API-key credential at:
   - `~/.config/orizu/credentials.json`

On an SSH host or Linux host without `DISPLAY`/`WAYLAND_DISPLAY`, login automatically
uses a headless flow: the CLI prints the browser approval URL and polls until approval
completes. Force this behavior when automatic detection is not appropriate with:

```bash
orizu login --headless
```

The browser shows an Orizu-hosted completion page; return to the original terminal and
wait for its login confirmation. The raw personal access token and PKCE verifier are
never shown or copied between machines.

The raw personal access token cannot be shown again after creation. It authenticates
as the owning user and inherits that user's current team/project access. Role
changes, team removal, token expiry, or token revocation take effect on later CLI
requests. Older session credentials are still read during rollout, but new
`orizu login` runs replace them with PAT credentials.

### Who Am I

```bash
orizu whoami
```

### Logout

```bash
orizu logout
```

For PAT credentials, logout attempts to revoke the current token remotely and then
clears the local server credentials. Other CLI tokens can be revoked from the
Personal Tokens page in Orizu.

### Auth Rate Limits

CLI auth endpoints apply fixed-window abuse controls per route and actor. Normal
`orizu login`, legacy token refresh, and `orizu logout` flows are below these limits.
Repeated requests from the same trusted client, or with the same token-like auth
material, return HTTP `429` with `{ "error": "Too many requests" }` and a
`Retry-After` header.

Rate-limit buckets are stored in PostgreSQL and shared across serverless instances.
Client buckets use `CLI_AUTH_RATE_LIMIT_TRUSTED_CLIENT_HEADER` when configured;
Vercel deployments default to its proxy-overwritten `x-vercel-forwarded-for`.
Other deployments should configure an equivalent trusted header. Without one,
request-specific actor buckets remain active without a product-wide client cap. During a rolling deploy
where the new rate-limit RPC is not present yet, auth routes temporarily retain the
previous per-process limiter for compatibility.

## Command Reference

Use `orizu --help`, `orizu <group> --help`, or
`orizu <group> <command> --help` for command-specific usage, options, and
examples. Agents and scripts can run `orizu capabilities --json` for a structured
command manifest.

### GEPA engine selection

`orizu optimizations run-gepa` uses the vendored official GEPA connector by
default. Pass `--engine legacy` only to use the frozen compatibility loop while
investigating a migration issue. The selected engine is recorded in run metadata;
the local command preserves the runner-byte verification boundary for both engines.
Choose one local budget control: a named `--budget` preset,
`--max-metric-calls`, `--max-full-evals`, `--max-iterations`, or
`--max-candidate-proposals`.
`--max-candidate-proposals` is available only with the default official engine.

`--hosted` is the human/PAT launch path for a staff-enabled team. It sends one
version-ID job specification to Orizu and prints the queued monitor URL; it
does not require `--candidate-runner-dir`, `--scorer-runner-dir`, or
`--log-dir`, and no local runner bytes or provider credentials are sent. A
hosted launch accepts only a named `--budget auto|light|medium|heavy` preset so
the server can compare it to the team's spend ceiling; numeric budget controls
fail closed. Eligibility also requires a staff-enabled team with available
concurrency, an optimizer version in the launch project whose validated
`manifest.optimizer_family` is `gepa`, registered candidate/scorer runners,
and an `anthropic/` or `openai/` reflection model. Supplied runner directories
must byte-match their registered versions and carry a snapshot-confined
`manifest.json`; duplicate runner identity flags are refused.

With `--json`, hosted eligibility catalog refusals return stable
`error`, `code`, and actionable `remediation` fields. Refusals may include a
bounded `detail` field with the underlying verifier cause. A concurrency-cap refusal
additionally returns
`runningRunUrls` for the active runs to inspect or cancel. On acceptance, the
printed monitor URL is the durable contract for watching Queued → running → a
terminal state; the initial Queued line does not claim completion. Pass
`--launch-intent-id <uuid>` when a caller needs to retry after response loss
without creating a second run.

### JSON output everywhere

Agents are first-class users of this CLI: **every command supports `--json`**,
either as a global prefix (`orizu --json teams list`) or a trailing flag
(`orizu teams list --json`). With the flag set, the command's result is emitted
as a single JSON document on stdout instead of human-formatted text (a few
long-running commands, such as `setup` and `optimizations run-gepa`, stream
progress first and emit the JSON summary as the final line). Errors still exit
non-zero with a message on stderr. The `capabilities --json` manifest lists
`--json` under `globalOptions`.

## Agent Setup

The mental model: the **CLI is the runtime and source of truth** (auth,
scorers, runners, optimizers, score submission); the **skill is the agent
workflow layer** that teaches a coding agent to use it. Interactive setup offers
the shared `~/.agents/skills/orizu` destination for compatible agents, including
Codex and Pi, plus detected native destinations such as Claude Code. Plugins
remain an optional distribution experiment, not the default onboarding path.

### Guided setup

`orizu setup` is the recommended onboarding command. It walks through login,
the local workspace contract, global coding-agent skill install, and optional
coding-agent handoff, then ends with a quiet summary of auth state, workspace
path, skill install status, validation status, and the next step.

```bash
orizu setup
orizu setup --team highlight --project support-agent
orizu setup --create-team "Acme" --create-project "Support Agent"
orizu setup --team highlight --project support-agent --agent codex --agent claude --non-interactive
orizu setup --workspace ./workbench --validate
```

- Interactive runs open login directly, ask which team to use or create, then
  ask which project the user intends to work in or create. Authenticated setup
  still materializes stubs for every project in the selected team: root
  `AGENTS.md`, `CLAUDE.md`, `Memory.md`,
  `orizu.team.json`, project manifests under `projects/`, source repo/session
  folders, primitive directories, and gitignore policy.
- Non-interactive runs (`--no-input`, CI, or no TTY) require existing
  authentication and explicit choose/create pairs: `--team <slug>` or
  `--create-team <name>`, plus `--project <slug>` or
  `--create-project <name>`. Run `orizu login --headless` first when needed.
  Use `--workspace <path>` only when setting up or validating another
  directory. `--non-interactive` is an alias for `--no-input`.
- A directory can only be attached to one team. To set up another team, run
  `orizu setup --team <other-slug>` from another directory.
- Setup offers a third step to install global coding-agent skills. After you
  accept, a destination picker shows `Universal (.agents — Codex and others) —
  ~/.agents/skills/orizu` and each detected native target with its
  `~/.../orizu` destination on the same line before any write. Every
  visible choice starts selected, and every choice—including Universal—can be
  deselected; confirming with none selected skips skill installation. Detection
  uses user-global config directories (not same-named regular files) and known
  agent binaries. In non-interactive setup,
  `--agent` opts into skill installation. Every accepted `--agent` always
  includes Universal, plus that agent's native destination where needed.
  Duplicate destinations are removed. With no `--agent` flags, setup writes no
  skills. Installs symlink to the CLI-managed
  source and replace the exact Orizu destination while preserving sibling
  skills.
- Validation details are written to ignored `.logs/<hash>.log` files when
  findings exist; the terminal summary shows counts by severity.
- `.orizu/` remains a gitignored cache/generated directory for exports,
  temporary runner materialization, and local state that may drift. The durable
  contract lives in root/project READMEs and `orizu.*.json` manifests.
- `CLAUDE.md` is a symlink to `AGENTS.md` when supported. Use
  `--no-symlinks` to write a pointer file instead.
- `--validate` inspects the contract without writing. `--fix` applies only
  safe idempotent repairs, such as missing starter files, directories, and
  gitignore defaults. It also repairs old `Agents.md`/`Claude.md` casing when
  there is no canonical conflict.
- Interactive setup can hand off to Claude, Codex, Pi, OpenCode, and Cursor
  when their commands are installed. Available commands appear in that order,
  with the first available command selected by default. Other is always last.
  Enter launches the highlighted agent; Esc skips agent launch and completes setup.
  A selected agent receives one positional prompt naming the selected team/project
  and `https://orizu.ai/llms.txt`, without shell interpolation. Selecting Other
  prints that complete prompt for copying without launching anything.
  Non-interactive setup never launches. `--handoff` explicitly prints the prompt;
  `--launch claude|codex|pi|opencode|cursor` explicitly selects an installed agent,
  still requires an interactive terminal, and asks for confirmation unless `--yes`
  is supplied. Cursor uses the `agent` executable, not the Cursor editor `cursor`
  command. Cursor's direct `agent "prompt"` and `agent -p "prompt"` initial-prompt
  forms were verified from the official
  [CLI overview](https://cursor.com/docs/cli/overview) and
  [parameter reference](https://cursor.com/docs/cli/reference/parameters), retrieved
  2026-08-30; setup uses the direct positional form without a shell.
- Human setup summaries abbreviate skill destinations inside the resolved setup
  home as `~/…`; destinations outside that home remain absolute. `--json` keeps
  integration paths absolute and emits the setup summary as machine-readable JSON.

### Skill install

`orizu setup` calls this installer for the normal onboarding path. You can also
run it directly to repair or customize skill installs. Pick your coding agents
by name; the CLI maps them to the right install paths:

```bash
orizu install-skill --agent claude --agent codex --yes
```

- `--agent <claude|codex|pi|devin|droid|grok|windsurf|opencode>` (repeatable) selects agents. Prefer explicit flags
  for compatibility installs. Without flags in a terminal, an interactive
  chooser is still available.
- `--scope global|project`: `global` (default) installs for you across all
  projects (`~/.claude/skills`, `~/.agents/skills`); `project` installs into
  the current repo (`./.claude/skills`, `./.agents/skills`).
- `--mode auto|link|copy` controls how installs stay in sync with the CLI:
  `auto` (default) symlinks to the CLI-managed skill when the CLI install path
  is stable and copies otherwise (for example `npx` cache paths); `link` and
  `copy` force a mode. Project-scope installs always copy, and copied installs
  include a `.orizu-skill-meta.json` (skill hash, CLI version, source) used for
  drift detection.
- `--yes` replaces an existing managed install without prompting.
- `--dry-run` prints the write plan without changing files. Interactive and
  normal runs print the same plan before writing, including how a managed
  `AGENTS.md` section would be created or replaced.

Advanced target IDs (stable machine flags, repeatable via `--target`):

- `agent-user`: `~/.agents/skills/orizu` (standard shared user target; Codex and Pi)
- `codex-user`: `~/.codex/skills/orizu` (legacy explicit target)
- `agents-project`: `./.agents/skills/orizu`
- `codex-project`: `./.codex/skills/orizu` (legacy Codex project folder)
- `claude-user`: `~/.claude/skills/orizu`
- `claude-project`: `./.claude/skills/orizu`
- `devin-user`: `~/.devin/skills/orizu`
- `droid-user`: `~/.factory/skills/orizu`
- `grok-user`: `~/.grok/skills/orizu`
- `windsurf-user`: `~/.windsurf/skills/orizu`
- `agents-md`: managed Orizu CLI section in `./AGENTS.md` for non-workspace
  repos. Initialized Orizu workspaces keep root `AGENTS.md` as concise
  workspace guidance instead.

Alias:

```bash
orizu skills install --agent claude --yes
```

### Keep installs in sync

```bash
orizu skills status [--json]
orizu skills update [--dry-run] [--json]
```

- `skills status` reports every known target: missing, current, stale, broken
  symlink, or unmanaged (an `AGENTS.md` without the managed section), plus the
  install mode and content hashes.
- `skills update` refreshes stale copied installs, re-renders stale `AGENTS.md`
  sections, and repairs broken symlinks. Missing targets are left alone.
- Symlinked installs track the CLI package automatically; copied installs are
  refreshed by `skills update` after a CLI upgrade. `npx` runs get copies
  because the cache path is ephemeral.

### Discover bundled skill (read-only)

Coding agents can locate and read the bundled skill without installing it into
any agent-specific folder:

```bash
orizu skills path
orizu skills path --skill-md
orizu skills path --json
```

- Plain output prints the skill root directory (or the `SKILL.md` path with
  `--skill-md`).
- `--json` emits stable machine-readable fields: `name`, `root`, `skillMd`,
  `source` (`override` | `packaged` | `repo-fallback`), `cliVersion`, and
  `skillHash` (sha256 over the skill content), which lets tooling verify that
  installed or bundled skill copies match the CLI runtime that supplied them.

Expected agent bootstrap flow: run `npx orizu --help`, discover
`skills path`, run `orizu skills path --json`, then read `SKILL.md` directly.

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

Output columns:
- `MEMBER ID`: the `team_memberships` row ID
- `USER ID`: the canonical user identity used for task assignment and assignment storage
- `EMAIL`
- `ROLE`

Notes:
- `tasks create --assignees` accepts `USER ID` values, emails, or a mix of both.
- `tasks assign --assignees` and `tasks publish --assignees` still expect canonical `USER ID` values.
- `tasks create|publish|assign --assignment-file <path>` accepts emails or canonical `USER ID` values inside the manifest.

Interactive fallback:
- If `--team` is omitted, CLI prompts for team selection.

### Add team member

```bash
orizu teams members add --email person@example.com --team my-team
```

Interactive fallback:
- If `--team` is omitted, CLI prompts for team.

Behavior:
- Orizu first tries to create the auth user.
- If the email already belongs to an existing account, Orizu reuses that account, sends the existing-user invitation email, and adds the team membership directly.
- If the email is new, invite flow is used (user creation + invitation email + membership).

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
- `curator`
- `judge`

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
orizu apps list --project my-team/quality-eval --status archived
orizu apps list --project my-team/quality-eval --status all --json
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

### Preview app locally

```bash
orizu apps preview \
  --file ./apps/LabelingApp.tsx \
  --input-schema ./schemas/input.json \
  --output-schema ./schemas/output.json \
  --sample-row ./fixtures/sample-row.json \
  --screenshot ./preview.png
```

Optional:
- `--headed` launches Chromium visibly for human review.
- `--keep-open` leaves the headed preview running until the command is stopped.
- `--component <ComponentName>` enforces the expected default export name.

The preview command validates the app contract, allowed imports, schema subset, and sample row before rendering. It serves a temporary local page with Orizu-style props: `inputData`, `initialValues`, and `onComplete`. When run from the web app checkout it uses the live Orizu component tree and global Tailwind CSS; when run from the mirrored/published CLI package it falls back to the bundled preview runtime snapshot so agents can still render and inspect local apps before upload.

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

### Inspect app detail

```bash
orizu apps detail --app <appId>
orizu apps detail --app <appId> --project my-team/quality-eval --json
```

Returns:
- app metadata
- pinned `currentVersion` information
- compatible dataset counts

Notes:
- `--json` returns the full app detail payload for automation or inspection.
- If `--project` is omitted, the CLI resolves the app from the selected project context.

### Export app source

```bash
orizu apps export --app <appId> --project my-team/quality-eval --out ./apps/LabelingApp.tsx
orizu apps export --app <appId> --version 2
```

Exports the stored `.tsx` source for the app's current version by default. Use `--version <n>` to inspect an older implementation. When `--out` is omitted, the CLI writes `<app-name>.v<version>.tsx` in the current directory.

## Instructions

Use the customer-facing `orizu instructions …` namespace for instruction-set
workflows. The legacy `orizu instruction-sets …` spelling remains a
compatibility alias, but new workflows should not teach it. The on-disk
`orizu.lock.json` contract is specified in [Instruction set Lock v1](instruction-set-lock.md).

```bash
orizu instructions list --project my-team/quality-eval --status active
orizu instructions show planner --project my-team/quality-eval
orizu instructions sync planner/openai/gpt-5.6-luna@v2 --out . --target ts --project my-team/quality-eval
orizu instructions update --out . --project my-team/quality-eval
orizu instructions prune --out . --keep planner/openai/gpt-5.6-luna@v2
orizu instructions profiles new planner --project my-team/quality-eval --model-config anthropic/claude-haiku
# After prior plan ratification, a local agent under the user's token runs create/push; hosted sessions hand them to a human.
orizu instructions push ./orizu.instruction-set.json --project my-team/quality-eval --set planner --json
```

### Specifiers

`sync` accepts `set`, `set/profile`, and `set/profile@vN` Specifiers; `--version N`
is equivalent to `@vN` when a Profile is present. A bare set resolves its Default
Profile and then that Profile's Production Version. A Profile Specifier resolves
its Production Version. Unset Production is a hard error that names the exact
`profiles promote` command; it never falls back. The retired sync-only
`--model-config` option refuses with guidance to use `set/profile`. Supplying
`--project`, `--out`, or `--version` without a value is an error naming that
option. Any other unrecognized sync flag refuses as
`instruction_set_sync_option_unknown:<flag>`. If an existing app root belongs
to another project, sync refuses before writing with the bare code
`instruction_set_sync_project_mismatch`; it does not name the two projects or
migrate the existing tree.

The Default names a Profile, never a version. `default move` therefore accepts
`--model-config` and rejects `--version`; move Production first with
`instructions profiles promote`.

`default show --json` returns:

```json
{"default":{"profileId":"<uuid>","modelConfigIdentity":"openai/gpt-5.4-mini","production":{"profileVersionId":"<uuid>","versionNumber":8}}}
```

`production` is `null` when the Default Profile is not promoted, and `default`
is `null` when the Default is unset. `default move --json` returns the standard
`{"instructionSet": ...}` envelope. Neither payload contains
`resolvesToDefault` or a `resolvedFrom: "default"` fallback report.

`--target` selects the generated modules and Helpers and defaults to `ts`.
TypeScript is currently the only target; any other value refuses before network
or disk access with `instruction_set_sync_target_unsupported:<value>`. The target
is not recorded in the Lock or Version manifest: those files and exact
`components/*.prompt.md` bytes are language-neutral.

`--out` names the app root and defaults to `.`. Sync writes one atomic Synced
version under:

```text
<out>/orizu/instruction-sets/<set-slug>/<profile-slug>/v<N>/
  manifest.json
  components/<name>.prompt.md
  components.generated.ts
<out>/orizu/helpers/load.ts, provenance.ts, verify.ts (+ matching .selfcheck.ts files)
<out>/orizu/generated/index.ts
<out>/orizu/orizu.lock.json
<out>/.gitattributes              # orizu/** -text; generated files marked linguist-generated
```

For the `ts` target, the only target-specific files are
`components.generated.ts`, `generated/index.ts`, and `helpers/*.ts`.
`generated/index.ts` contains static imports for every Synced version in the
Lock. Every relative import emitted by the CLI carries an explicit `.js`
extension, so the tree compiles with TypeScript `moduleResolution` set to either
`nodenext` or `bundler`. Direct execution of the vendored `.ts` files with
`node --experimental-strip-types` is not supported: compile them first or use a
TypeScript-aware runtime. `loadInstructions(specifier)` uses only that generated
map and the Lock values embedded from sync time: it never calls Orizu,
dynamically imports a path, or re-resolves a Pointer. It returns Components, settings from the Version
manifest, and exact Provenance from the selected Lock entry atomically. The
returned `generatedProvenance` retains the Version module's claim so
`verifyIntegrity({ ...loaded, digest: loaded.provenance.digest }, lock)` can
cross-check it against the Lock before hashing the strings and settings the
process actually loaded. Identity substitution and whitespace-only changes are
detected. `settings` is required on verifier input, including when it is `{}`. Non-empty settings
use sorted-key, whitespace-free canonical JSON in the whole-Version digest;
missing or non-finite settings fail closed. The supplied digest must equal the
Provenance-selected Lock entry's digest: a digest found only on another Version
fails with `instruction_set_integrity_digest_unselected`, while a digest absent
from the Lock fails with `instruction_set_integrity_digest_unknown`.

The vendored `*.selfcheck.ts` files use no runner globals and avoid test-runner
discovery globs. They export `runLoadSelfCheck()` and `runVerifySelfCheck()` so
a customer's Bun, Vitest, or other runner can invoke them from an ordinary test
wrapper. Both checks read the customer's generated map and synced bytes and
refuse an empty map rather than relying on synthetic fixtures.

`provenanceOf(loaded)` returns the loaded Synced version's exact Provenance.
`attachProvenance(target, loaded)` writes the stable attributes
`orizu.instruction_set.id`, `orizu.profile_version.id`, and
`orizu.instruction_set.digest` to a duck-typed OpenTelemetry span or merges them
into a plain attribution object. See [Instruction Set Helpers](instruction-set-helpers.md)
for both ingestion paths and read-back commands.

The Lock fingerprints every vendored Helper. On re-sync, a Helper whose bytes no
longer match its recorded pristine fingerprint is preserved and named in a
warning. Pass `--force-helpers` to overwrite edited Helpers and refresh their
fingerprints. Helpers whose bytes already match the current template are also
pristine, allowing a re-sync to recover if a prior upgrade wrote a Helper but
was interrupted before writing the Lock. In `--json` mode every warning appears
in the single output document's always-present `warnings` array. Managed
artifact paths are symlink-confined beneath the app root. The generated import
map is machine-owned and is marked through the app root's `.gitattributes`.
That file also applies `orizu/** -text`, so Git EOL conversion never changes any
fingerprinted bytes (including Component bodies that intentionally use CRLF).

Component files preserve the API bytes exactly. The Version manifest includes
that Profile Version's frozen Model Config `settings`; `components.generated.ts`
exports the same object through its `manifest` export. Settings live only in the
Version manifest, not the Lock, and non-empty settings participate in the
whole-Version digest. `instructions show --json` exposes every Profile Version
as a `versions` entry with its `settings`. The Version manifest and Lock carry
the same Component hashes and whole-Version digest. If an existing Lock entry
disagrees on any immutable Version field, sync refuses with
`instruction_set_sync_version_conflict:<set>/<profile>@vN`; only `syncedAt` is
preserved independently. Re-syncing a present Version writes nothing and
preserves `syncedAt`; syncing another Version is additive. If the Lock records a
non-null Default or Production Pointer needed by
the Specifier, `sync` uses that value and prints an `update` hint rather than
re-resolving it; `null` means the Pointer was never resolved, so `sync` may fill
it once.

### Updating Pointers and pruning Versions

`update` is the only verb that re-resolves recorded Pointers. It reads the
current Default for every set and the current Production for every Profile in
the Lock, then prints a before/after plan. It changes no files without `--yes`:

```bash
orizu instructions update --out . --project my-team/quality-eval
orizu instructions update --out . --project my-team/quality-eval --yes
```

Approved updates sync newly referenced Versions by default, so the repository
is not left pointing at absent material. `--no-sync` opts out: the Lock records
the fresh Pointers and output names every referenced-but-absent exact Specifier.
Sync those Specifiers before verify or runtime use. Existing Versions retain
their original `syncedAt`; Pins and unrelated Lock fields are preserved. Any
unset Production refuses with `instruction_set_pointer_unresolved:production`
and never falls back.

`prune` runs offline verify first and refuses with
`instruction_set_prune_unverified` if verification has failures (warnings are
allowed). It prints each unreferenced Version folder and does nothing without
`--yes`:

```bash
orizu instructions prune --out .
orizu instructions prune --out . --keep planner/openai/gpt-5.6-luna@v2 --yes
```

Production Pointers, customer-owned Lock Pins, and repeatable exact `--keep`
Specifiers are retained. Lock Pins are durable; `--keep` is invocation-local.
Malformed Specifiers refuse rather than silently retaining a wider set.
Value-less `--out`/`--keep` options refuse with
`instruction_set_prune_option_missing_value:<flag>`, and every unknown prune
option refuses with `instruction_set_prune_option_unknown:<flag>` before a plan
or deletion. A `--keep` or Lock Pin that resolves to no recorded Version refuses
with `instruction_set_prune_keep_unresolved:<specifier>`; the diagnostic names
whether each unresolved Specifier came from `--keep` or `lock.pins`. If a
Profile's final managed Version is beside unmanaged entries,
prune skips that Version so the Profile stays referenced and reports the entry
names.

### Offline verification and CI step

`verify` reads only the target tree. It requires no credentials, never calls
Orizu, exits 1 when any check fails, and leaves the exit status at 0 for warnings
alone:

```bash
orizu instructions verify --out .
```

A GitHub Actions step can use the same command:

```yaml
- name: Verify synced Orizu instructions
  run: npx orizu instructions verify --out .
```

The four output groups check the Version manifests against the Lock, exact
Component bytes and imported `components.generated.ts` values, bytes returned by
the vendored `loadInstructions` Helper through `verifyIntegrity`, and Pointer /
folder / import-map / Helper consistency. Runtime verification binds the supplied
digest to the Provenance-selected Lock Version; it reports
`instruction_set_integrity_digest_unselected` when another locked Version owns
the digest and `instruction_set_integrity_digest_unknown` when none does. A modified fingerprinted Helper is a
warning because Helpers are customer-editable; a fingerprinted Helper missing
from disk is a failure. A missing `generated/index.ts` causes `helper_import_failed` and exit 1
because the runtime load Helper consumes that map; a present incomplete map is
also a failure. Runtime probes execute only integrity-checked generated modules
and scrub the child environment to basic process paths and `NO_COLOR`; Orizu
credentials and unrelated CI secrets are not inherited. A `default` Profile
that has not been synced is valid Lock state and is not probed or reported.

`--json` emits one document with this stable shape:

```json
{
  "ok": false,
  "groups": { "group1": "PASS", "group2": "FAIL", "group3": "PASS", "group4": "PASS" },
  "failures": [
    { "group": "group2", "code": "component_hash_mismatch", "path": "instruction-sets/planner/openai__gpt/v2/components/system.prompt.md", "expected": "sha256:…", "found": "sha256:…" }
  ],
  "warnings": []
}
```

Every failure uses one of these named codes:

- Group 1: `version_manifest_invalid`, directory identity and Provenance mismatch codes,
  `manifest_instruction_set_id_mismatch`, `manifest_profile_version_id_mismatch`,
  `manifest_version_number_mismatch`, `manifest_digest_mismatch`.
- Group 2: `component_missing`, `component_not_regular_file`, `component_unreadable`,
  `component_unexpected:<name>`, `component_hash_mismatch`,
  `manifest_component_hash_mismatch`, `manifest_component_not_locked`,
  `version_digest_mismatch`, `generated_components_missing`,
  `generated_components_invalid`, `generated_components_import_failed`,
  `generated_component_mismatch`, `generated_manifest_invalid`,
  `generated_manifest_mismatch:<field>`, `generated_module_drift`.
- Group 3: `helpers_missing`, `helper_import_failed`, `helper_import_timeout`,
  `helper_exports_invalid`, `load_failed`, `pointer_load_failed`, `integrity_failed`,
  `helper_integrity_inert`, `helper_provenance_mismatch`, `helper_rejection_inert`,
  and loaded/Pointer identity mismatch codes.
- Group 4: `lock_invalid`, `default_pointer_target_missing`, `pointer_target_missing`,
  `lock_version_folder_missing`, `orphan_version_folder`,
  `orphan_instruction_set_folder`, `orphan_profile_folder`,
  `helper_path_unsafe`, `helper_missing`, `helper_fingerprint_missing`,
  `generated_lock_stale`, `generated_module_drift`, `import_map_mismatch`,
  `import_map_destination_mismatch:<specifier>`.

Warnings use `helper_modified` or `import_map_missing` and never change the exit
status. Each finding names a path; hash comparisons also include `expected` and
`found`.

### Migrating the legacy sync layout

The retired set-level `manifest.json`, `default/`, and `profiles/` tree cannot be
mixed with the paved-path layout. If `<out>` contains that legacy tree for the
set, sync refuses with `instruction_set_sync_legacy_layout`. Move the old tree
aside, verify the intended project and Profile Version, run the version-addressed
sync, then review and remove the old tree. The CLI never auto-deletes it.

The shipped legacy TypeScript and Python loaders do not read the paved tree. If
they see one, they fail with `instruction_set_legacy_loader_retired` and this
migration anchor instead of reporting it as generically not synced. Paved-path
replacement loaders arrive with the later Helper work.

## Legacy prompt reads

```bash
orizu prompts list --project my-team/quality-eval [--status active|archived|all]
```

Use this read-only compatibility command to locate legacy material and its
owning instruction set. The table includes `ID`, `NAME`, `ROLE`, `STATUS`, `TOKENS`, `LINES`, `CHARS`,
and `WORDS`. Measurements describe the latest sealed prompt version. `—` means
the canonical body could not be measured; zero is shown as `0`. Token values
carry a `~` prefix because one fixed, model-agnostic `gpt-tokenizer` encoding is
used for every prompt and is an approximation of any particular model's usage.
With `--json`, failed or deliberately skipped enrichment carries a named
`lengthStatsUnavailableReason`. Measured summaries also include
`lengthStatsVersionId` and `lengthStatsVersionNumber`, identifying the latest
sealed version the stats belong to even when its canonical body could not be
measured. Length enrichment is best-effort: if its supporting query fails, the
list still succeeds with null stats and `enrichment_failed`. To bound request
work, at most the first 500 sorted summaries are enriched and canonical-body
resolution has a 15-second server budget. A summary skipped by either bound
carries null stats and `measurement_cap_exceeded`.

## Report comments

Report comments use one command family across prompt version reports, optimization run reports, task reports, and dataset current READMEs.

```bash
orizu comments list --prompt <promptIdOrName> --project my-team/quality-eval [--label production | --version <promptVersionId>]
orizu comments list --run <optimizationRunId>
orizu comments list --task <taskId>
orizu comments list --dataset <datasetIdOrName> --project my-team/quality-eval
orizu comments add --run <optimizationRunId> --body @comment.md --anchor "Score summary" --lines 4:6
orizu comments add --dataset <datasetIdOrName> --project my-team/quality-eval --body @comment.md --anchor "README quote" --lines 4:6
orizu comments reply <commentId> --body "Fixed in the next pass"
orizu comments resolve <commentId>
orizu comments unresolve <commentId>
orizu comments edit <commentId> --body @updated-comment.md
```

Behavior:
- `list` prints threads with open/resolved status, anchors, and replies
- `add` accepts `--body <text|@file>`, optional `--anchor`, optional `--lines <start:end>`, and optional `--via <name>`
- `reply`, `resolve`, `unresolve`, and `edit` use only the globally unique comment ID
- `--json` returns the full API payload

## Diff comments

Diff comments are inline comments on a recomputed diff between two immutable
prompt revisions. Export them for every commented pair, or select one pair
with `--from` and `--to`:

```bash
orizu comments diff --run <optimizationRunId>
orizu comments diff --run <optimizationRunId> --from <candidateId> --to <candidateId> --detail full
orizu comments diff --prompt <promptId> --from 3 --to 4 --detail diff --json
```

Exactly one of `--run` and `--prompt` is required. `--from` and `--to` must be
provided together; prompt revisions must be integer version numbers. Detail
levels are:

- `hunk`: anchored line and its complete changed run, with up to three
  unchanged lines of padding on each side
- `diff` (default): hunk context plus the pair's whole-document unified diff
- `full`: diff context plus both complete revision bodies

Human output groups comments beneath their revision-pair header and renders
each hunk as an indented diff snippet. Untrusted multiline blocks (diffs,
revision bodies, and comment bodies) are rendered behind a `│ ` quote gutter,
so unquoted rows are the only genuine hunk rows: `>` marks the anchored row,
while a space marks the other hunk rows. `--json` emits the endpoint payload as
one JSON line. Comments are never omitted when context cannot be reconstructed;
the payload and human output instead name `diff_degraded_size_limit`,
`diff_degraded_cell_limit`, `bodies_unavailable_event_cap`, `body_unresolvable`,
`anchor_out_of_range`, or `pair_budget_exceeded` (for commented pairs after the
first 100). For an in-range anchor the cell-limit case retains exact
`context.lineText` while `context.lineOp` and `context.hunk` are `null`; an
out-of-range anchor under the same degradation reports `anchor_out_of_range`
with a null `context`. If a null context arrives without a reason, human output
says `Context unavailable (no reason supplied)`. If a non-null context arrives
with `hunk: null` and no reason, the anchored line is still printed.
Each available side prints a `From:` or `To:` length-stat line. Side
measurements are independent: an unavailable side is shown as `unavailable`
with its reason while the other side remains visible. The JSON pair likewise
allows `lengthStats.from` and `lengthStats.to` to be independently `null`, with
`fromUnavailableReason` and `toUnavailableReason` naming failures. When the
whole pair has neither side stats nor a delta, human output prints
`Length: unavailable` and includes the pair degradation reason when present.
Otherwise `Tokens:`, `Lines:`, `Chars:`, and `Words:` show removed/added/net
rows. If exact split churn is unavailable, `Split unavailable:` names the
guard; removed and added display as `—` while the independently measured net
value remains real. A missing delta is printed as `Length delta: unavailable`
with its named measurement failure when available.
Optimization export bundles expose the same comments at `diffComments` using
`hunk` detail. They also include `diffCommentsSuppressedReason`, normally
`null`. For a hosted agent exporting a run outside its assigned project, the
value is `agent_project_scope` and `diffComments` remains empty; the marker
does not reveal whether any comments exist. All degradation reasons above are
shared with the bundle except `bodies_unavailable_event_cap`: the bundle reuses
its uncapped event derivation, so that endpoint-specific reason is not reachable
there.

The v1 optimization export preserves the run row's `best_candidate_id` in
`summary.bestCandidateId` when event derivation names an unknown candidate and
therefore cannot select it. This is a compatibility fallback: candidate detail
may be absent for that identifier. If both derivation and the run row omit a
best candidate, `summary.bestCandidateId` is `null`.

## Datasets

Canonical contract reference:
- `docs/contracts/dataset-canonical-contract.md`

### List datasets

```bash
orizu datasets list --project my-team/quality-eval
orizu datasets list --project my-team/quality-eval --status archived
```

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

### Delete dataset

```bash
orizu datasets delete --dataset <datasetId|datasetUrl>
```

Behavior:
- Permanently deletes the dataset when project-curator/admin checks and dependency checks pass.
- Requires an interactive terminal confirmation by typing the dataset id exactly.
- There is no non-interactive confirmation flag.

Interactive fallback:
- If `--dataset` is omitted, CLI prompts for team/project/dataset before the confirmation prompt.

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
orizu tasks list --project my-team/quality-eval --status archived
```

### Archive and restore artifacts

Archive is reversible visibility state. It does not delete versions, rows,
assignments, responses, reports, optimization pins, or change task/run
lifecycle status. List commands default to active inventory; use
`--status archived` for only archived items or `--status all` for both.

```bash
orizu apps archive <app-id> --project my-team/quality-eval
orizu datasets archive <dataset-id> --project my-team/quality-eval
orizu tasks archive <task-id> --project my-team/quality-eval
orizu scorers archive <scorer-id> --project my-team/quality-eval
orizu optimizations archive <run-id> --project my-team/quality-eval
orizu instructions archive <slug-or-exact-name> --project my-team/quality-eval

# Use the same command families with restore.
orizu apps restore <app-id> --project my-team/quality-eval
orizu instructions restore <slug-or-exact-name> --project my-team/quality-eval

# Assignment ids are task ids because the artifact is one recipient's grouped
# queue. Omit --assignee to target the signed-in recipient.
orizu assignments list --project my-team/quality-eval --status archived
orizu assignments archive <task-id> --project my-team/quality-eval
orizu assignments restore <task-id> --project my-team/quality-eval

# Curator-equivalent operators may target a specific recipient.
orizu assignments archive <task-id> \
  --project my-team/quality-eval \
  --assignee <user-id>
```

All archive/restore commands support `--json` and return the canonical,
idempotent server result. Instruction sets use their stable slug or exact name;
standalone prompt lifecycle mutations deliberately refuse and print the
corresponding `orizu instructions` replacement.

### Create task

```bash
orizu tasks create \
  --project my-team/quality-eval \
  --dataset <datasetId> \
  --app <appId> \
  --version 3 \
  --title "Round 1 labeling" \
  --instructions "Follow rubric v1" \
  --labels-per-item 2 \
  --json
```

Task creation behavior:
- Tasks are created as drafts by default.
- Use `--publish --assignees <...>` to create, assign, and publish in one command.
- Use `--assignment-file <path>` instead of `--assignees` when specific rows should go to specific labellers.
- Without `--publish`, the response includes a task URL and reminds operators to test the draft manually before assigning.
- `--assignees` accepts canonical user IDs, emails, or a comma-separated mix during create.
- `--assignment-file` is mutually exclusive with `--assignees`.
- `--version <n>` is optional and defaults to the app's current pinned version.
- Assignments are only shipped immediately when `--publish` is present.
- The backend resolves and pins either the requested app version or the app's current `version_id` at task-creation time.
- Dataset compatibility is validated against that pinned app version before any task rows are inserted, including per-row input-schema checks.
- Invalid assignee selectors return per-assignee validation output so operators can fix specific emails or user IDs.

Explicit assignment manifest:

```jsonl
{"rowId":"row-001","assignee":"labeler@example.com"}
{"rowId":"row-002","assignees":["user-id-1","labeler2@example.com"]}
```

Manifest rules:
- `rowId` is the canonical dataset row `id` from upload, download, and edit flows.
- `assignee` assigns one labeller; `assignees` expands to multiple row/labeller pairs.
- Assignees may be emails or canonical user IDs. The server stores canonical `assignee_id` values.
- V1 publish requires whole-dataset, uniform row coverage.

Output:
- Plain text prints task ID, dataset ID, pinned version metadata, assignments created, and the task URL.
- Draft output states that the task should be tested manually before assigning and shows the publish command shape.
- `--json` returns `taskId`, `datasetId`, `versionId`, `versionNum`, `taskUrl`, `status`, `assignmentsCreated`, `draft`, and optional `assignmentShortfall` / `warning`.
- JSON failures preserve the structured API payload and append `httpStatus` for automation.

### Publish task

```bash
orizu tasks publish --task <taskId> --assignees <userId1,userId2>
orizu tasks publish --task <taskId> --assignment-file ./assignments.jsonl
orizu tasks create ... --publish --assignees <userIdOrEmail1,userIdOrEmail2>
orizu tasks create ... --publish --assignment-file ./assignments.jsonl
```

Notes:
- `tasks publish` replaces draft assignments with the provided user IDs, then activates the task through the draft-publish guardrails.
- `tasks publish --assignees` currently expects user IDs.
- `tasks publish --assignment-file` replaces draft assignments with the exact manifest pairs and accepts emails or user IDs.

### Assign task

```bash
orizu tasks assign --task <taskId> --assignees <userId1,userId2>
orizu tasks assign --task <taskId> --assignment-file ./assignments.jsonl --replace-existing
```

Note:
- `--assignees` currently expects user IDs (comma-separated), not emails.
- `--assignment-file` assigns exact row/labeller pairs and accepts emails or user IDs.

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

Notes:
- task status reads and updates are curator-only operator surfaces
- `--json` returns the full status payload on success
- `--json` failures preserve the API error payload and append `httpStatus`

### Pause task

```bash
orizu tasks pause --task <taskId>
```

Behavior:
- pauses an active task through the curator-only task status mutation route
- pauses in-flight assignments so operators can stop new work cleanly

### Task report

```bash
orizu tasks report set --task <taskId> --report-file ./report.md
orizu tasks report set --task <taskId> --report "## Findings"
orizu tasks report upload --task <taskId> --report @./report.md
orizu tasks report get --task <taskId>
```

Behavior:
- replaces the current task report if one already exists
- accepts reports only when the task status is `paused` or `completed`
- `get` reads the current report so humans and scoped agent sessions can inspect it before commenting
- `--json` returns the updated or fetched report payload

### Unpause task

```bash
orizu tasks unpause --task <taskId>
```

Behavior:
- resumes a previously paused task through the curator-only task status mutation route
- restores paused assignments to pending so work can continue

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

Notes:
- task export is curator-only
- JSON exports return `{ metadata, responses }`
- JSONL exports emit one canonical response record per line using the same response shape as JSON

## Instruction and Evaluation Control Plane

Instruction and evaluation control-plane commands use version ids for datasets,
split sets, instruction components or judge artifacts, runners, scorers,
optimizers, and score runs. Compatibility selectors may still spell a stored
component or judge version as a prompt version id.

### Scorers

List active scorers by default or select archive visibility explicitly. Scorer
detail lists recent Score runs and can filter them by the exact Profile Version
recorded in their Provenance:

```bash
orizu scorers list --project my-team/quality-eval
orizu scorers list --project my-team/quality-eval --status archived
orizu scorers detail accuracy --project my-team/quality-eval --profile-version <profile-version-id>
orizu optimizations list --project my-team/quality-eval --profile-version <profile-version-id>
orizu runs list --project my-team/quality-eval --profile-version <profile-version-id>
```

When submitting runs or scores, or executing a scorer, pass `--instructions <specifier>` and optionally `--instructions-root <dir>` to attach the exact loaded Provenance triple. The CLI resolves the specifier only through `<dir>/orizu/orizu.lock.json`; it never calls Orizu and refuses when the selected profile has no promoted Production version.

Register a scorer:

```bash
orizu scorers register \
  --project my-team/quality-eval \
  --name "Judge kappa" \
  --manifest ./scorer.manifest.json \
  --json
```

Execute a builtin set scorer such as Cohen's kappa:

```bash
orizu scorers exec \
  --project my-team/quality-eval \
  --scorer-version <set-scorer-version-id> \
  --subject-version <prompt-version-id> \
  --dataset-version <dataset-version-id> \
  --split-set <split-set-id> \
  --split validation \
  --dependency-score-run judge=<row-score-run-id> \
  --out ./set-score.json
```

`scorers exec` submits the score run by default. Add `--no-submit` to only write the aggregate object.

Submit precomputed aggregate results:

```bash
orizu scores submit ./set-score.json \
  --aggregate \
  --project my-team/quality-eval \
  --scorer-version <set-scorer-version-id> \
  --subject-version <prompt-version-id> \
  --dataset-version <dataset-version-id> \
  --split-set <split-set-id> \
  --split validation
```

Row-result files still use plain `scores submit <results.jsonl|results.json>`. `runners exec --scorer-version` remains available for low-level row scorer runner execution.

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
orizu datasets delete --dataset <datasetId>
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
  --labels-per-item 2

orizu tasks publish --task <taskId> --assignees <userId1,userId2>
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
  - Task create publishes only with `--publish --assignees` or `--publish --assignment-file`; draft creation does not require assignees.
  - `tasks create --json` and `tasks status --json` preserve structured error payloads for automation.

## Current Limitations

- `tasks assign --assignees` and `tasks publish --assignees` accept assignee user IDs, not emails; `--assignment-file` accepts emails or user IDs.
- Assignment queue reads default to the signed-in recipient. Curator-equivalent
  operators may supply `--assignee <user-id>` for a managed recipient.
- Assignment completion payloads are validated against the task's pinned app-version `output_json_schema`.
- Graphical login uses a localhost callback on `127.0.0.1` with `ORIZU_AUTH_PORT` or port `43123`; headless login uses browser approval plus secure polling and does not bind that callback port.
- CLI package publishing/distribution is separate from this usage doc (examples assume local build or installed binary).
