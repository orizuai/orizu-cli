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

## The Orizu CLI is baked FROM SOURCE (not npm)

Both paths bake the CLI by **`bun build`-ing the current source into one
self-contained bundle** — NOT `npm i -g orizu@<v>`. Why: the just-merged
hosted-session commands (`orizu internal hosted-loop`) are **not in a published CLI
tag yet**, so a pinned npm install can't reliably carry them (and an unpublished
version 404s the build). Baking from source guarantees the runtime CLI **always
matches this checkout**.

The bundle is safe as a single file because `packages/cli` statically imports **no
npm package** (only Node built-ins + type-only imports); every heavyweight dep is
reached through a **lazy, non-literal dynamic `import()`** resolved at runtime. So
the bundle needs no `node_modules` to *start*; only `@anthropic-ai/claude-agent-sdk`
is installed **as a sibling of the bundle** so its lazy import resolves, and
`opencode` is a **global bin** the loop *spawns* (never imports).

### Canonical long-term flow (bake-from-source is the pre-publish BRIDGE)

Baking from source is the bridge until the hosted commands ship in a published tag.
The destination is the project-wide **git-tag** versioning scheme:

1. **Cut a git tag** (e.g. `cli-vX.Y.Z`).
2. **`publish-cli.yml`** publishes the CLI (with the hosted commands) for that tag.
3. The image/snapshot can then **pin that published tagged version** instead of
   building from source (swap the CLI bake step for `npm i -g orizu@<tag-version>`).

Until then, the built runtime is **labelled by git** — the image `--tag` and the
snapshot `--label` DEFAULT to `git describe --tags --always --dirty`, so every
artifact is traceable to a git ref/tag.

## What is baked in

| Component | Version | Source of truth |
|-----------|---------|-----------------|
| Base OS (image) | `amazonlinux:2023` | matches Vercel Sandbox's Amazon Linux 2023 / glibc runtime |
| Base runtime (snapshot) | `node24` sandbox | Vercel default runtime |
| Node | 24.x (NodeSource) | `NODE_MAJOR` build ARG |
| Bun | latest stable | `bun.sh/install` |
| git | AL2023 repo | — |
| **Orizu CLI** | **from source** (`git describe`) | this checkout — `bun build src/index.ts` |
| OpenCode | `opencode-ai@1.14.41` | `OPENCODE_PINNED_VERSION` (`hosted-harness-opencode.ts`) — npm-pinned |
| Claude Agent SDK | `@anthropic-ai/claude-agent-sdk@0.3.201` | `packages/cli/package.json` deps — npm-pinned |

The provenance + pins are written to **`/opt/orizu/prebaked.json`**:

```json
{
  "cliVersion": "cli-v0.4.1-51-gedbe8d42",
  "cliSource": "from-source",
  "cliGitVersion": "cli-v0.4.1-51-gedbe8d42",
  "opencodeVersion": "1.14.41",
  "claudeSdkVersion": "0.3.201",
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
overrides: `--opencode-version`, `--claude-sdk-version`, `--node-major` (defaults
live in the `Dockerfile`). The underlying command is:

```bash
docker buildx build --platform linux/amd64 \
  --build-arg ORIZU_CLI_GIT_VERSION=<git-describe> \
  --output type=image,name=vcr.vercel.com/<team>/<project>/orizu-hosted-runtime:<tag>,push=true,oci-mediatypes=true,compression=zstd,compression-level=3,force-compression=true \
  packages/cli/hosted-runtime-image
```

## Path B — Vercel snapshot, zero-Docker v0 (`provision-snapshot.mjs`)

Founder-run only, but needs **no Docker** — only the Vercel creds (`VERCEL_TOKEN`,
`VERCEL_PROJECT_ID`, `VERCEL_TEAM_ID`), which exist. Run it with **`bun`** (it loads
the provider from TypeScript source and builds the CLI with `bun build`). It boots a
base sandbox with **OPEN network**, installs the same runtime into it (the CLI
bundle via `writeFile`, `@anthropic-ai/claude-agent-sdk` + `opencode-ai` via npm),
writes the marker, verifies the bake, then `snapshot()`s the sandbox and prints the
snapshot id.

```bash
# Dry run — prints the provisioning plan, touches nothing:
bun packages/cli/hosted-runtime-image/provision-snapshot.mjs --dry-run

# Real provision (label DEFAULTS to git-describe; prints the snapshot id at the end):
bun packages/cli/hosted-runtime-image/provision-snapshot.mjs \
  --duration 30 --expiration 0
```

`--expiration 0` = never expire (omit for the SDK default). Pin overrides:
`--opencode-version`, `--claude-sdk-version`. The Vercel token is read from env by
the provider and is **never printed** — the script logs step names + the snapshot id
only.

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

- **CLI**: it is baked **from source**, so just rebuild — the runtime tracks this
  checkout automatically (git-describe labels it). No version bump needed. (Once the
  hosted commands ship in a published tag, switch to pinning that published version —
  see "Canonical long-term flow" above.)
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
