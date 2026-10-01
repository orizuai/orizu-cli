# Orizu hosted-sandbox runtime (ALI-1017)

A pre-baked Vercel Sandbox runtime for the CLI-triggered hosted agent session. It
exists so the hosted runtime works under **G5 default-deny egress** (ALI-1006):
npm and the public internet are unreachable at runtime, so the CLI and OpenCode
can no longer be `npm i -g`'d at boot. The runtime bakes them in at **build /
provision time** (where network egress is allowed).

There are **two interchangeable pre-baked paths** behind the same seam
(`ORIZU_HOSTED_IMAGE` / `--image` vs `ORIZU_HOSTED_SNAPSHOT` / `--snapshot`) — they
are **mutually exclusive** (setting both is a hard error):

| Path | Artifact | Needs Docker? | Script | When |
|------|----------|---------------|--------|------|
| **Docker / VCR image** | reproducible long-term image | **yes** (`docker buildx`) | `build-and-push.mjs` | durable, versioned artifact |
| **Vercel snapshot** | filesystem snapshot of a base sandbox | **no** (Vercel creds only) | `provision-snapshot.mjs` | zero-Docker **v0 live path** |

## How the CLI gets into the runtime: published package (canonical) or from source

The snapshot path has **two CLI-bake modes** (ALI-1078):

- **Published package (canonical, automated):** `provision-snapshot.mjs
  --cli-version X.Y.Z` installs the **published npm package** (`npm i -g
  orizu@X.Y.Z`). This is what CI does — see "Canonical flow" below.
- **From source (manual escape hatch):** without `--cli-version`, the script
  `bun build`s the current checkout into one self-contained bundle. Use it for
  pre-publish testing or when a fix has not shipped in a tag yet. (The Docker/VCR
  image path is from-source only.)

Before using either from-source path, run `bun install --cwd packages/cli`. The
bundle guard requires Effect to be installed from the CLI package's own lockfile.

The from-source build bundles ordinary runtime dependencies, including Effect,
into the single CLI file. Optional preview tooling stays external through explicit
build flags. Provider SDKs still use **lazy, non-literal dynamic `import()`** calls
that resolve from the baked sibling `node_modules`. So the bundle needs no
`node_modules` to *start*; only `@anthropic-ai/claude-agent-sdk` is installed **as
a sibling of the bundle** so its lazy import resolves (the published package
carries the SDK as a normal dependency instead), and `opencode` is a **global
bin** the loop *spawns* (never imports).

### Canonical flow (automated on every `cli-v*` tag)

The project-wide **git-tag** versioning scheme drives the runtime:

1. **Cut a git tag** (e.g. `cli-vX.Y.Z`).
2. **`publish-cli.yml`** publishes the CLI (with the hosted commands) for that tag.
3. The same workflow's **`bake-hosted-snapshot` job** then bakes a fresh snapshot
   **from that published version** (`provision-snapshot.mjs --cli-version X.Y.Z`),
   then starts a sandbox from the captured snapshot and checks it
   (`check-snapshot-starts.mjs`, see [the start check](#the-start-check-before-the-snapshot-becomes-current)).
   If that fails, the bake job fails there, deletes the rejected snapshot, and
   the old snapshot stays current.
   The **`make-snapshot-current` job** then makes it current by itself, with no
   pull request and no human step (ADR-035). The current snapshot id is the
   coordinator's `ORIZU_HOSTED_SNAPSHOT` **worker secret**, not a line in
   `wrangler.toml`, and a deploy never changes a secret. It works from main as it
   is when the job runs, not when the bake started. In order, that job:
   1. checks this is still the newest release. Bakes can overlap, so if a newer
      `cli-v*` tag exists, it skips steps 2 to 7, notes the skip in the job
      summary, and succeeds. The newer release makes its own snapshot current; if
      that fails, production stays on the snapshot that is live now. The skipped
      snapshot is never made current, and cleanup deletes it once three
      snapshots created after it exist;
   2. refuses an id that isn't `snap_` followed by letters and digits, before
      touching anything. Steps 2 to 5 are `scripts/switch-current-snapshot.sh`,
      which the rollback workflow (below) also runs;
   3. reads the current id from the coordinator (`scripts/read-current-snapshot.mjs`,
      three reads 6 s apart that must agree);
   4. sets the new id with `wrangler secret put ORIZU_HOSTED_SNAPSHOT`, which takes
      effect in a few seconds without a deploy;
   5. runs the armed check (below) on the new id. If it fails, the job puts the
      previous id back and fails. It keeps the new snapshot, because the way to
      recover is to re-run this job alone with the same bake output;
   6. writes the snapshot id, the id it replaced, CLI version and run link into
      the "Hosted snapshot" section of the **`cli-v<version>` release notes** on GitHub, replacing that
      section on a re-run. Only when GitHub says the release doesn't exist (404)
      does the job create it, without marking it Latest;
   7. cleans up old snapshots, always keeping the id it replaced (`--protect`), so
      the rollback target survives;
   8. whatever happened above, dispatches `deploy-coordinator.yml` on main.

   Only `make-snapshot-current` holds the coordinator's concurrency group, so the
   long bake doesn't hold up deploys from main. GitHub keeps only one pending run
   per concurrency group, so while the switch waited its turn it may have replaced
   a pending deploy from main; step 8 redoes that deploy. When nothing was
   replaced, the extra deploy is harmless: deploys keep the secret, and its armed
   check verifies the coordinator again. If the job fails before the switch (an
   install, say), re-run that job alone: the bake's result is kept, and the re-run
   uses main as it is then. Do the same if the job was **cancelled** while it
   waited (a newer run took the group's one pending slot): the old snapshot stays
   live until you re-run it (ORI-2298 tracks making a waiting switch safe from
   that). A re-run that finds its snapshot already current doesn't switch again,
   but still runs the armed check. If the check passes, it writes the release
   notes with "Replaced: unknown (re-run)" and skips cleanup, because the id it
   replaced is no longer known. If the check fails, the job fails without
   restoring anything or writing notes: roll back (below).

   The production evidence names no snapshot, so a release never changes it.
   Required repo secrets are documented in the workflow header.
4. `deploy-coordinator.yml` deploys the Worker on pushes to main that touch the
   Worker (it is path-filtered, so not every push to main deploys), and when
   `make-snapshot-current` dispatches it. It reads the
   current snapshot id before deploying, and afterwards checks the coordinator is
   still armed on that same id.

   Both jobs use `scripts/check-coordinator-armed.mjs` as the armed check. It asks
   the live coordinator's public `GET /hosted-optimization/readiness` route which
   snapshot is current and whether hosted optimization is armed, and fails the job
   unless it sees the expected snapshot with `hostedOptimizationArmed: true` on
   several reads in a row within about two minutes. `make-snapshot-current` and
   `deploy-coordinator.yml` share one concurrency group, so a release can't switch
   the snapshot in the middle of a deploy.

   Only reads from the Worker version the job just made live count. Every deploy
   and every `secret put` creates a new version, and for a few seconds Cloudflare
   still sends some requests to the old one, which would answer "armed" for code
   it doesn't run. The route reports the answering version as `workerVersionId`.
   After a deploy, the job takes the new version id from wrangler's output file.
   A `secret put` prints no id, so before each check the switch job reads the
   live version from `wrangler deployments status --json`.
   `scripts/coordinator-version-id.mjs` reads both.

   "Armed" is the same check `start()` makes before it accepts a run. It proves the
   coordinator has all its settings, that they match the production evidence, and
   that the snapshot id is well-formed. It does **not** prove the Vercel token works
   or that the coordinator secret matches the web app's. That the snapshot starts
   is proved earlier, by the start check below. To prove a start works end to end,
   still start one synthetic hosted run by hand.

### The start check (before the snapshot becomes current)

Right after capture, and before any step makes the new id current, the bake runs
`check-snapshot-starts.mjs --snapshot <id> --cli-version X.Y.Z`. It starts a
sandbox from the new snapshot through the CLI's own Vercel provider, then checks:

- `orizu --version` prints **exactly** `orizu X.Y.Z` (the CLI's real output
  shape; the test captures it from the real CLI);
- `/opt/orizu/prebaked.json` (the prebaked marker) passes the coordinator's own
  marker check (`packages/cli/src/hosted-optimization-prebaked-marker.ts`, the
  same code the coordinator runs as its first bootstrap command) and names
  `X.Y.Z`;
- the same boot proof the bake ran before capture (orizu and opencode on `PATH`,
  `orizu internal hosted-loop`, the workspace-bootstrap capability, the
  claude-agent-sdk import, and the braintrust/python3.11 checks). The braintrust
  version it checks is the one the marker records; `--braintrust-py-version` is
  only for an older snapshot whose marker records none;
- `orizu internal verify-skilled-proposer-bake --json`, which checks the baked
  skilled-proposer venv. On a good snapshot it installs nothing; it fails
  instead of rebuilding;
- `git --version && ssh -V`: the merge job runs git over ssh in this snapshot
  (`docs/requirements/merge-sandbox-job/plan.md`, D10). Git must print
  `git version …` and ssh must print `OpenSSH_…` (to stderr, where `ssh -V`
  writes it). Both versions are logged.

It always stops the sandbox, whether the check passes or fails, and logs
`sandbox <id> stopped` when the stop completes. Each call has a deadline
(start 3 min, each of the five checks 3 min, stop 1 min), and the sandbox is
created with a 30-minute lifetime, so Vercel stops it even if the runner dies.
If only the stop fails after a passing check, the job shows a warning and
carries on.

The check runs in the bake job, outside the coordinator's deploy group. If it
fails, the bake job fails, `make-snapshot-current` never runs, and the old
snapshot stays current. The next step, `delete-rejected-snapshot.mjs`, then
deletes the rejected snapshot. Nothing would ever use it: a failed bake job is
re-run whole, which bakes a fresh snapshot. Every bake snapshot never expires,
so left behind it would take one of cleanup's three retention slots. The delete
is best-effort: it only warns when it can't delete, and it never deletes the id
the coordinator currently serves, or anything when that id can't be read.

`make-snapshot-current` never deletes a snapshot. If its switch fails, the
documented recovery re-runs that job alone with the same bake output, which
needs the snapshot to still exist. A snapshot a newer release superseded is
kept too, as a ready fallback if the newer release fails. Cleanup's
`--protect` already keeps the rollback target, so these cost only a retention
slot each.

From-source runtimes are **labelled by git** — the image `--tag` and the snapshot
`--label` DEFAULT to `git describe --tags --always --dirty`; published-mode
snapshots default to `cli-v<version>`. Every artifact is traceable to a
release/git ref.

## What is baked in

| Component | Version | Source of truth |
|-----------|---------|-----------------|
| Base OS (image) | `amazonlinux:2023` | matches Vercel Sandbox's Amazon Linux 2023 / glibc runtime |
| Base runtime (snapshot) | `node24` sandbox | Vercel default runtime |
| Node | 24.x (NodeSource) | `NODE_MAJOR` build ARG |
| Bun | 1.3.13 x64 baseline | `BUN_VERSION` + `BUN_LINUX_X64_BASELINE_SHA256` build ARGs |
| git | AL2023 repo | — |
| **Orizu CLI** | **published `orizu@X.Y.Z`** (CI snapshot bake) or **from source** (`git describe`, escape hatch) | `cli-v*` tag → publish-cli.yml, or this checkout — `bun build src/index.ts` |
| OpenCode | `opencode-ai@1.14.41` | `OPENCODE_PINNED_VERSION` (`hosted-harness-opencode.ts`) — npm-pinned |
| Claude Agent SDK | `@anthropic-ai/claude-agent-sdk@0.3.201` | `packages/cli/package.json` deps — npm-pinned |
| Python | `python3.11` (+ `pip`); `/usr/local/bin/python3` → `python3.11` | AL2023 repo (system python is 3.9 — too old for braintrust, which needs ≥3.10). The symlink wins by PATH precedence so plain `python3` (what the GEPA runner manifest and the CLI launch) resolves to 3.11 and can import braintrust; dnf's absolute-shebang `/usr/bin/python3` scripts stay on 3.9 |
| Braintrust (python) | `braintrust[cli]==0.30.0` (PyPI; the `[cli]` extra carries the CLI's deps) | `DEFAULT_BRAINTRUST_PY_VERSION` (`provision-snapshot.mjs`) / `BRAINTRUST_PY_VERSION` ARG — ALI-1048 |
| Braintrust (npm) | `braintrust@3.23.1` | `DEFAULT_BRAINTRUST_NPM_VERSION` (`provision-snapshot.mjs`) / `BRAINTRUST_NPM_VERSION` ARG — ALI-1048 |

The image deliberately omits a whole-system `dnf -y update`: rebuilds consume
the selected AL2023 base plus explicitly installed repository packages without
an extra unbounded upgrade layer. Base-image rebuild cadence carries OS security
updates; this determinism/security tradeoff is tracked for follow-up review.

Both Braintrust packages ship a `braintrust` bin; the **python** CLI owns the PATH
name **deterministically** (Highlight's eval harness is python): npm installs
first and its `braintrust` bin is removed — resolved via `command -v braintrust`,
which at that instant can only be npm's (pip has not run yet) — before pip
installs the python entry point; the bake-verify's anchored shebang check is the
net if the removal ever misses. The npm CLI stays reachable as
**`bt`**. The global npm install is CLI prebaking only — workspace code that
wants the TS SDK adds `braintrust` as a dependency (global installs are not on
the module-resolution path).

The provenance + pins are written to **`/opt/orizu/prebaked.json`**:

```json
{
  "cliVersion": "cli-v0.4.1-51-gedbe8d42",
  "cliSource": "from-source",
  "cliGitVersion": "cli-v0.4.1-51-gedbe8d42",
  "opencodeVersion": "1.14.41",
  "claudeSdkVersion": "0.3.201",
  "braintrustPyVersion": "0.30.0",
  "braintrustNpmVersion": "3.23.1",
  "builtFor": "vercel-sandbox"
}
```

`cliVersion` records the **git-describe provenance** (not an npm version); the extra
`cliSource` / `cliGitVersion` fields make the from-source origin explicit (the
marker parser ignores unknown fields). The runtime uses that marker (plus the
boot-context `prebaked` flag) to skip the from-scratch install steps — see "How the
runtime detects pre-baked" below.

### Why `amazonlinux:2023`

Vercel Sandbox executes containers on Amazon Linux 2023 (glibc). Baking on the
matching base keeps the compiled/native bits ABI-compatible with the runtime the
platform hands us. A musl base (alpine) or a mismatched glibc can build fine yet
fault at runtime inside the sandbox.

## Path A — Docker / VCR image (`build-and-push.mjs`)

Founder-run only — needs `docker buildx` (linux/amd64 output) and Vercel VCR push
auth (`docker login vcr.vercel.com`, or a token the daemon is configured with).
Neither is available in CI or the agent environment. The script first `bun build`s
the CLI from source into `./dist/orizu.js` (git-ignored, `COPY`d by the Dockerfile),
then builds + pushes.

```bash
# Dry run — prints the plan (bundle build + buildx command), runs nothing:
node packages/cli/hosted-runtime-image/build-and-push.mjs \
  --team <team-slug> --project <project-slug> --dry-run

# Real build + push (tag DEFAULTS to git-describe; --tag overrides):
node packages/cli/hosted-runtime-image/build-and-push.mjs \
  --team <team-slug> --project <project-slug>
```

Env-var form: `ORIZU_VCR_TEAM`, `ORIZU_VCR_PROJECT`, `ORIZU_HOSTED_IMAGE_TAG`.
The CLI is baked **from source** — there is no `--cli-version`. Remaining pin
overrides: `--opencode-version`, `--claude-sdk-version`, `--braintrust-py-version`,
`--braintrust-npm-version`, `--node-major` (defaults live in the `Dockerfile`).
The underlying command is:

```bash
docker buildx build --platform linux/amd64 \
  --file packages/cli/hosted-runtime-image/Dockerfile \
  --build-arg ORIZU_CLI_GIT_VERSION=<git-describe> \
  --output type=image,name=vcr.vercel.com/<team>/<project>/orizu-hosted-runtime:<tag>,push=true,oci-mediatypes=true,compression=zstd,compression-level=3,force-compression=true \
  .
```

## Path B — Vercel snapshot, zero-Docker v0 (`provision-snapshot.mjs`)

Founder-run only, but needs **no Docker** — only the Vercel creds (`VERCEL_TOKEN`,
`VERCEL_PROJECT_ID`, `VERCEL_TEAM_ID`), which exist. Run it with **`bun`** (it loads
the provider from TypeScript source and builds the CLI with `bun build`). It boots a
base sandbox with **OPEN network**, installs the same runtime into it (the CLI
bundle via `writeFile`, `@anthropic-ai/claude-agent-sdk` + `opencode-ai` +
`braintrust` via npm, `python3.11` via dnf + `braintrust` via pip),
writes the marker, verifies the bake, then `snapshot()`s the sandbox and prints the
snapshot id.

```bash
# Dry run — prints the provisioning plan, touches nothing:
bun packages/cli/hosted-runtime-image/provision-snapshot.mjs --dry-run

# PUBLISHED-PACKAGE mode (what CI runs): bake the released orizu@X.Y.Z from npm.
bun packages/cli/hosted-runtime-image/provision-snapshot.mjs \
  --cli-version X.Y.Z --duration 195 --expiration 0 [--id-file /tmp/snapshot-id]

# FROM-SOURCE mode (manual escape hatch; label DEFAULTS to git-describe):
bun packages/cli/hosted-runtime-image/provision-snapshot.mjs \
  --expiration 0
```

`--expiration 0` = never expire (omit for the SDK default). `--id-file` also
writes the snapshot id to a file (CI handoff). Omitting `--duration` selects the
derived safe minimum (195 minutes published, 207 from source); smaller explicit
values are rejected. Pin overrides:
`--opencode-version`, `--claude-sdk-version` (in published mode the Claude SDK
ships inside the package; the flag only annotates the marker), and
`--braintrust-py-version` / `--braintrust-npm-version` (ALI-1048; strictly
validated — a value-less flag or a malformed version is an error, PyPI and npm
version shapes each). The Vercel token is
read from env by the provider and is **never printed** — the script logs step
names + the snapshot id only.

The exact create-from-snapshot call the runtime later makes (verified against
`@vercel/sandbox@1.10.2`) is `Sandbox.create({ source: { type: 'snapshot',
snapshotId } })` — the provider maps `createSandbox({ snapshot })` to it.

## How VCR readiness works

After the push, Vercel asynchronously **prepares** a `linux/amd64` variant. Until
it reaches status **Ready** (visible in the Vercel dashboard under the project's
registry, or via the API), a `Sandbox.create({ image })` throws
**`image_not_ready`**. The provider (`vercel-sandbox-provider.ts`) retries that
with bounded backoff, but the first live run after a push should wait for Ready.

## How the runtime is referenced

**Image (Path A):**
- Registry ref (what the push targets):
  `vcr.vercel.com/<team>/<project>/orizu-hosted-runtime:<tag>`
- Short ref (what the code uses): `orizu-hosted-runtime:<tag>` — Vercel resolves it
  within your team.

```bash
ORIZU_HOSTED_IMAGE=orizu-hosted-runtime:<tag> orizu session start --hosted --task "…"
orizu session start --hosted --image orizu-hosted-runtime:<tag> --task "…"
```

**Snapshot (Path B):** the snapshot id printed by `provision-snapshot.mjs`.

```bash
ORIZU_HOSTED_SNAPSHOT=<snapshot-id> orizu session start --hosted --task "…"
orizu session start --hosted --snapshot <snapshot-id> --task "…"
```

`--image` and `--snapshot` (and their env vars) are **mutually exclusive** — setting
both is a hard error. Whichever is set, the CLI passes it to `Sandbox.create` **and**
flips the `prebaked` flag together (they can never disagree), so bootstrap skips the
CLI install and the loop skips the OpenCode install.

## How the runtime detects pre-baked

Two independent signals (both are honored; the flag is preferred for testability,
the marker is a filesystem belt):

1. **Boot-context flag** — `startHostedSession` sets `prebaked: true` on the
   bootstrap options and the loop context whenever it passed an `image` **or a
   `snapshot`**.
2. **Marker file** — `/opt/orizu/prebaked.json`, parsed by `parsePrebakedMarker`
   in `hosted-runtime-assets.ts`.

When pre-baked:
- bootstrap records **`cli_prebaked`** instead of installing the CLI (but still
  runs `assertJsRuntimeAvailable`);
- the loop records **`opencode_prebaked`** instead of installing OpenCode, then
  spawns `opencode` directly.

The from-scratch install path is kept intact for local-sim / non-prebaked runs.
Pre-baking does **not** disable G5 — the egress canary still runs.

## How to bump

- **CLI**: cut a `cli-vX.Y.Z` tag — publish-cli.yml publishes the package AND
  re-bakes the snapshot from it automatically (see "Canonical flow" above). For a
  pre-publish/hotfix runtime, use the from-source escape hatch (no version bump
  needed; git-describe labels it).
- **OpenCode / Claude SDK**: change `OPENCODE_PINNED_VERSION` / the package.json dep,
  update the matching `ARG` default in the `Dockerfile` (and the snapshot script's
  `DEFAULT_*` constants) + the table above.

Then re-cut the runtime:

- **Image (Path A)**: rebuild + push with a **new `--tag`** (default git-describe is
  already unique per commit; never overwrite a tag a live run may be pinned to). Wait
  for VCR **Ready**, then roll `ORIZU_HOSTED_IMAGE` / `--image`. Roll back by pointing
  at the previous tag.
- **Snapshot (Path B)**: re-run `provision-snapshot.mjs` for a fresh snapshot id, then
  roll `ORIZU_HOSTED_SNAPSHOT` / `--snapshot`. Roll back by pointing at the previous id.

The coordinator's current snapshot is the `ORIZU_HOSTED_SNAPSHOT` worker secret
(ADR-035); rolling or rolling back changes only that. To see the current id, ask
the coordinator (`curl -s https://orizu-session-coordinator.orizu.workers.dev/hosted-optimization/readiness`)
or read the `cli-v<version>` release notes of the release that set it.
`VERCEL_HOSTED_OPTIMIZATION_PRODUCTION_EVIDENCE` in
`workers/session-coordinator/src/vercel-rest-adapter.ts` records the one-time
September 9 drill (team, project, API generation, SDK contract, drill hash) and
names no snapshot (ADR-035); a new build does not require a new drill. The bake
checks the sandbox before capturing it, then starts a sandbox from the captured
snapshot and checks it again (the start check above). A run still in
`preparing` when the snapshot changes starts from whichever snapshot is current when its sandbox is
created. Just before that, the coordinator checks the environment:

- a missing snapshot id makes the run wait for the secret to be set. The wait
  doesn't end at a fixed time: the run fails with
  `hosted_optimization_readiness_timeout` at the first alarm retry after its
  readiness window closes, which is about 6–8 minutes after the run starts at the
  default 30-second cadence, because the retry delay doubles each time;
- a malformed snapshot id fails the run with `hosted_optimization_snapshot_invalid`;
- a team or project that no longer matches the evidence fails the run with
  `hosted_optimization_production_evidence_mismatch`.

### Roll back to the previous snapshot

1. Find the previous id. The safest target is the "Replaced" id in the
   "Hosted snapshot" section of the release you are rolling back from: it is the
   id that was live just before, and cleanup keeps it. If that says "unknown
   (re-run)", use the "Snapshot id" of the newest earlier `cli-v<version>` release
   that has the section. A release after the switch-over with no such section
   either was superseded by a newer one, or switched but then failed to write its
   notes. Open that release's `publish-cli.yml` run to tell which. If its
   `make-snapshot-current` job shows "Snapshot switch skipped", it was superseded
   and never went live, so skip it. Otherwise its snapshot may be live: check
   `currentSnapshot` on the readiness route
   (`curl -s https://orizu-session-coordinator.orizu.workers.dev/hosted-optimization/readiness`)
   before you choose a target. If no release after
   the switch-over has the section (the first rollback after it), use the id
   recorded on ORI-2238 in Linear when the switch-over ran.
   Check the id still exists: cleanup keeps the newest 3 snapshots, the current
   one, and the one the last switch replaced.
2. Check in GitHub Actions whether a `publish-cli.yml` run is still baking a
   snapshot. When its bake finishes, that release makes its own snapshot current,
   over your rollback. Cancel that run if you don't want its snapshot.
3. Run the **Roll back hosted snapshot** workflow
   (`rollback-hosted-snapshot.yml`): Actions > Roll back hosted snapshot > Run
   workflow, with the id from step 1 and, optionally, a reason. It:
   - refuses the id before changing anything, unless Vercel has it with status
     `created`;
   - puts it, waits for the coordinator to report it armed (the same check a
     release runs), and puts the previous id back if it isn't. If the summary
     says the restore FAILED, the failed id may still be live: follow
     [If the workflow can't run](#if-the-workflow-cant-run) now. If it says
     the switch stopped and the target MAY be live, check what is live with
     [Checking by hand](#checking-by-hand) before anything else. A passing
     armed check proves only that the coordinator accepts the id, not that a
     sandbox boots from it, so after a rollback still start one synthetic hosted
     run by hand ([Checking by hand](#checking-by-hand));
   - writes the result, who ran it and why into the job summary. The run list is
     the record of rollbacks: each run is named after the id it rolled back to.
     Release notes are not changed, and the next release's "Replaced" line shows
     the id the rollback left live;
   - dispatches `deploy-coordinator.yml` on main, as a release does.

   It shares the coordinator's concurrency group, so it never runs at the same
   time as a deploy from main or a release's switch, and you don't need to check
   for one. GitHub keeps only one waiting run per group, so a rollback that is
   waiting its turn can be cancelled by a newer deploy or switch. It then shows
   as cancelled and nothing changed: run it again.

#### If the workflow can't run

1. Check in GitHub Actions that no `publish-cli.yml` "Make the new snapshot
   current" job, and no "Roll back hosted snapshot" run, is running or waiting:
   it would put its own id over yours. Don't start a release until step 3
   confirms the rollback.
2. From `workers/session-coordinator` on main, with a Cloudflare token for the
   account:

   ```bash
   printf '%s' '<previous snapshot id>' | bunx wrangler secret put ORIZU_HOSTED_SNAPSHOT
   ```

3. Confirm it from the repo root with the armed check (see
   [Checking by hand](#checking-by-hand)), expecting `<previous snapshot id>`.

Never add `ORIZU_HOSTED_SNAPSHOT` back to `wrangler.toml`: Cloudflare refuses a var
that shares a secret's name (error 10053), so every deploy would fail.

### One-time switch-over from the `wrangler.toml` var to the secret (ORI-2238)

Before ORI-2238 the id was a `[vars]` entry in `wrangler.toml`. The ORI-2234 probe
measured the rules this procedure relies on:

- a deploy that drops the var and passes `--secrets-file` with the same name moves
  it from var to secret with no moment where the Worker has no value;
- a secret can't coexist with a var of the same name (error 10053), whichever
  comes second;
- a secret survives every later deploy.

Order matters, because the merge push runs `deploy-coordinator.yml` (the stack
touches `workers/session-coordinator/**`):

- merge first, with no secret yet → that deploy drops the var and the coordinator
  has no snapshot id. Every new start is refused at once with a 503
  `hosted optimization coordinator misconfigured`, and runs that were already
  preparing wait and then fail with `hosted_optimization_readiness_timeout`;
- set a secret while the deployed toml still has the var → error 10053. The same
  happens to any deploy from a toml that still has the var, so production stays
  up but that deploy fails.

Steps (the manager runs these; production is involved):

1. **Freeze.** No `cli-v*` tag and no merge that touches
   `workers/session-coordinator/**` until step 5 is done.
2. **Check out the exact tree that will land on main.** ORI-2238 lands as part of
   a stack (ORI-2237, ORI-2238, ORI-2248, ORI-2251) that merges atomically with
   `gh stack merge --squash` (ADR-029), so main ends with one commit whose tree is
   the top of the stack, and ORI-2251 changes Worker code. Use the top of the
   stack, rebased on current main, right before `gh stack merge --squash`, not
   this PR's own head. The hand deploy must match what the post-merge main deploy
   ships. Merging the PRs one at a time would break this: each merge deploys a
   different tree, and the ones before ORI-2238 still have the var. Run
   `bun install` and `bun install --cwd workers/session-coordinator`.
3. **Deploy it with the current id as a secret.** From the repo root:

   ```bash
   ID="$(node scripts/read-current-snapshot.mjs)"   # prints snap_…, or exits 1
   umask 077; printf 'ORIZU_HOSTED_SNAPSHOT=%s\n' "$ID" > /tmp/ori2238-secrets.env
   (cd workers/session-coordinator && bun run deploy -- --secrets-file /tmp/ori2238-secrets.env)
   rm /tmp/ori2238-secrets.env
   ```

   `bun run deploy` goes through `scripts/deploy-session-coordinator.sh`, the same
   guard CI uses.
4. **Confirm.** Run the armed check expecting `$ID` (see
   [Checking by hand](#checking-by-hand)). It must pass, and
   `curl -s https://orizu-session-coordinator.orizu.workers.dev/hosted-optimization/readiness`
   must show `"currentSnapshot":"<ID>","hostedOptimizationArmed":true` and a
   `workerVersionId`. Record
   `$ID` on ORI-2238: releases from before the switch have no snapshot section in
   their notes, so this is where a rollback finds it.
5. **Merge the stack right away** with `gh stack merge --squash`. The merge-push
   deploy keeps the secret, and its armed check expects `$ID`. Once that run is green,
   lift the freeze.

**To reverse** (only if the stack itself is reverted): revert the stack on main,
with the restored `ORIZU_HOSTED_SNAPSHOT` line set to the current id (the revert
alone brings back the old id). The revert triggers a deploy. That deploy fails
with 10053 while the secret exists. So first delete the secret
(`cd workers/session-coordinator && bunx wrangler secret delete ORIZU_HOSTED_SNAPSHOT`),
then immediately re-run the failed `deploy-coordinator.yml` run. Between the two,
the coordinator has no id for a few seconds. A new start in that time is refused
with a 503 `hosted optimization coordinator misconfigured`; a run that was
already preparing waits, and carries on once the id is back. The probe didn't
measure a secret-to-var move with no gap.

The re-run's armed check depends on which `deploy-coordinator.yml` it runs. A
re-run uses the workflow file of the commit it deploys:

- If the revert restored the old workflow, the check reads the id from
  `wrangler.toml` and should pass.
- If the new workflow is still in place, the check fails by design. Its
  "Read the current snapshot before deploying" step ran while there was neither
  a secret nor a var, so it has nothing to expect.

Either way, once the deploy step is green, confirm by hand with the armed check
(see [Checking by hand](#checking-by-hand)), expecting `<id>`.

### Checking by hand

After any hand deploy, `secret put` or rollback, run the armed check first, then
start one synthetic hosted run to prove a start works end to end. The check needs
the id of the version that is now live. From the repo root:

```bash
VERSION_ID="$( (cd workers/session-coordinator && bunx wrangler deployments status --json) |
  node scripts/coordinator-version-id.mjs deployments-status)"
node scripts/check-coordinator-armed.mjs --expected-snapshot <snapshot id> --expected-version "$VERSION_ID"
```

`coordinator-version-id.mjs` fails while two versions share traffic; wait for the
rollout to finish and read it again.
Snapshot cleanup (`gc-snapshots.mjs`) protects the id the coordinator reports, so
after setting the snapshot by hand (a rollback), confirm it with the armed check
before running cleanup by hand.
