#!/usr/bin/env node
/**
 * Provision a Vercel Sandbox SNAPSHOT of the Orizu hosted runtime — the ZERO-DOCKER
 * "v0 live" path (ALI-1017). It bakes the SAME runtime as the Docker/VCR image
 * (build-and-push.mjs) but needs NO Docker: it boots a base sandbox with OPEN
 * network, installs the runtime into it, snapshots it, and prints the snapshot id.
 * A later session boots from it via `Sandbox.create({ source:{ type:'snapshot' }})`
 * (see vercel-sandbox-provider.ts) with no runtime egress and no install.
 *
 * TWO CLI-BAKE MODES (ALI-1078):
 *   - PUBLISHED (canonical, CI): `--cli-version X.Y.Z` installs the PUBLISHED npm
 *     package (`npm i -g orizu@X.Y.Z`) — used by publish-cli.yml after each
 *     `cli-v*` tag publish, so the snapshot carries exactly the released CLI.
 *   - FROM SOURCE (manual escape hatch): no `--cli-version` — `bun build`s the
 *     current checkout into a bundle, for pre-publish/hotfix bakes.
 *
 * FOUNDER- or CI-RUN. Needs the Vercel creds (VERCEL_TOKEN / VERCEL_PROJECT_ID /
 * VERCEL_TEAM_ID) but NO Docker. Run it with `bun` (the provider is loaded from
 * TypeScript source, and the from-source mode builds the CLI with `bun build`):
 *
 *   bun packages/cli/hosted-runtime-image/provision-snapshot.mjs \
 *     [--cli-version <X.Y.Z>] [--label <tag>] [--duration <min>] \
 *     [--expiration <ms>] [--id-file <path>] [--dry-run]
 *
 *   --cli-version published-package mode: bake `orizu@<X.Y.Z>` from npm instead of
 *                 building from source
 *   --label       label for the snapshot (DEFAULTS to `cli-v<version>` in published
 *                 mode, else `git describe --tags --always --dirty`, so the snapshot
 *                 is traceable to a release/git ref)
 *   --duration    provisioning sandbox lifetime in minutes (default 30)
 *   --expiration  snapshot TTL in ms (0 = never expire; omitted = SDK default)
 *   --id-file     also write the resulting snapshot id to this file (CI handoff)
 *   --dry-run     print the plan (bundle build + in-sandbox steps) without touching
 *                 Vercel and without building the bundle
 *   --opencode-version / --claude-sdk-version
 *                 override the pinned externals (defaults mirror the Dockerfile).
 *                 In published mode the Claude SDK ships as a dependency of the
 *                 published package; the flag only annotates the marker.
 *   --braintrust-py-version / --braintrust-npm-version
 *                 override the pinned Braintrust eval tooling (ALI-1048): the
 *                 PyPI `braintrust` package (+ python3.11, AL2023's system python
 *                 is too old for it) and the npm `braintrust` package.
 *
 * READINESS: unlike the Docker/VCR image path (which needs an async "Ready"
 * variant preparation), a snapshot is usable as soon as `snapshot()` resolves —
 * the returned id is immediately bootable via
 * `Sandbox.create({ source: { type: 'snapshot', snapshotId } })`.
 *
 * SECURITY: the Vercel token is read from env by the provider and is NEVER printed.
 * This script logs step names + the resulting snapshot id only.
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildCliBundle, resolveGitVersion } from './build-cli-bundle.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

// Pins mirrored from the Dockerfile (source-of-truth for the npm-pinned externals).
export const DEFAULT_OPENCODE_VERSION = '1.14.41'
export const DEFAULT_CLAUDE_SDK_VERSION = '0.3.201'
// Braintrust eval tooling (ALI-1048): the PYTHON package is the primary surface
// (Highlight's harness — adapter evals, `evaluate_files`, the `braintrust` CLI);
// the npm package is baked alongside for its CLI (available as `bt`). NOTE a
// global npm install is NOT on the module-resolution path — workspace code that
// wants the TS SDK must add `braintrust` as a dependency; the global install is
// CLI prebaking only. Two registries, two version lines — pin each explicitly.
export const DEFAULT_BRAINTRUST_PY_VERSION = '0.30.0'
export const DEFAULT_BRAINTRUST_NPM_VERSION = '3.23.1'
// Strict version shapes for the braintrust pins — interpolated into shell
// commands, so reject anything malformed with a clear error instead of letting
// the bake fail (or worse, mis-parse) inside the sandbox. Shared with
// build-and-push.mjs so BOTH recipes validate identically.
// Numeric identifiers are CANONICAL-only (`0|[1-9]\d*` — no leading zeros):
//   PyPI: restricted PEP 440 subset — N.N[.N] plus one optional aN/bN/rcN/.postN/.devN
//   npm:  exact semver — pre-release identifiers non-empty, numeric ids without
//         leading zeros (alphanumeric ids must contain a non-digit, per spec)
export const BRAINTRUST_PY_VERSION_RE =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*))?(?:(?:a|b|rc)(?:0|[1-9][0-9]*)|\.post(?:0|[1-9][0-9]*)|\.dev(?:0|[1-9][0-9]*))?$/
export const BRAINTRUST_NPM_VERSION_RE =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?$/
export const DEFAULT_DURATION_MINUTES = 30

// A conservative label shape (same as the image tag) — reject anything a registry
// path or a shell could mis-parse.
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
// Published-package mode versions: plain semver (optionally with a pre-release
// suffix). Interpolated into a shell command, so keep it strict.
const CLI_VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.]+)?$/

// In-sandbox layout — MUST match the Docker image so the runtime detects the bake
// identically: `orizu` on PATH, the SDK a sibling of the bundle, marker at /opt.
const CLI_DIR = '/opt/orizu/cli'
const CLI_DIST_DIR = `${CLI_DIR}/dist`
const CLI_INDEX = `${CLI_DIST_DIR}/index.js`
const CLI_PKG = `${CLI_DIR}/package.json`
const MARKER_PATH = '/opt/orizu/prebaked.json'
// User-writable staging paths (relative to the sandbox cwd) — session.writeFile
// writes as the sandbox user; a `sudo mv` then places system files.
const STAGE_BUNDLE = 'orizu-cli-bundle.js'
const STAGE_PKG = 'orizu-cli-package.json'
const STAGE_MARKER = 'orizu-prebaked.json'

export function parseArgs(argv) {
  const args = { flags: new Set(), values: {} }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      args.flags.add(key)
    } else {
      args.values[key] = next
      i += 1
    }
  }
  return args
}

function packageJson(gitVersion) {
  return `{\n  "name": "orizu",\n  "version": "${gitVersion}",\n  "type": "module"\n}\n`
}

function markerJson({ cliVersion, cliSource, cliGitVersion, opencodeVersion, claudeSdkVersion, braintrustPyVersion, braintrustNpmVersion }) {
  const gitLine = cliGitVersion ? `  "cliGitVersion": "${cliGitVersion}",\n` : ''
  return (
    `{\n  "cliVersion": "${cliVersion}",\n  "cliSource": "${cliSource}",\n` +
    `${gitLine}  "opencodeVersion": "${opencodeVersion}",\n` +
    `  "claudeSdkVersion": "${claudeSdkVersion}",\n` +
    `  "braintrustPyVersion": "${braintrustPyVersion}",\n` +
    `  "braintrustNpmVersion": "${braintrustNpmVersion}",\n  "builtFor": "vercel-sandbox"\n}\n`
  )
}

/**
 * Braintrust eval-tooling steps (ALI-1048), IDENTICAL in both bake modes.
 * Both packages ship a `braintrust` bin, and the PYTHON CLI must own the PATH
 * name (Highlight's eval harness is python: adapter evals, `evaluate_files`,
 * `braintrust push`). Install order alone only wins when both write the same
 * bin dir — on the hosted sandbox npm's global prefix can differ from python's
 * scripts dir, so ownership is made DETERMINISTIC: npm installs first and its
 * `braintrust` bin is removed (keeping `bt`, the npm CLI's second bin) before
 * pip installs the python entry point. The removal resolves the bin via
 * `command -v braintrust` — the SAME resolution the install just produced —
 * because at that instant the ONLY `braintrust` on PATH is npm's (pip has not
 * run yet); resolving via `npm prefix -g` could differ under sudo env/npmrc
 * and silently no-op. If the removal ever misses anyway, the ANCHORED shebang
 * verify below fails the bake loudly. The global npm install is CLI prebaking
 * only — workspace code that wants the TS SDK adds `braintrust` as a
 * dependency (global installs are not on the module resolution path).
 */
function braintrustSteps({ braintrustPyVersion, braintrustNpmVersion }) {
  return [
    {
      name: `install braintrust npm CLI @${braintrustNpmVersion} (global; kept as \`bt\`, \`braintrust\` link removed)`,
      exec:
        `sudo npm install -g "braintrust@${braintrustNpmVersion}" && sudo npm cache clean --force && ` +
        `sudo rm -f "$(command -v braintrust)"`,
    },
    {
      // AL2023's system python is 3.9 (present for dnf itself); braintrust on
      // PyPI requires >=3.10, so install python3.11 (+pip) from the distro repos
      // and the pinned package system-wide (entry point lands on PATH). The
      // [cli] extra is REQUIRED: a bare `braintrust==X` imports fine but the
      // CLI (`braintrust push`) fails — boto3/uv/etc. live behind the extra.
      // PEP 668: the system-wide pip install relies on AL2023's pip (22.3.1)
      // predating EXTERNALLY-MANAGED enforcement; if the base image ever bumps
      // to an enforcing pip this step fails loudly at bake time (then add
      // --break-system-packages or move to a venv).
      // DEFAULT-python3 visibility: the GEPA runner manifest launches plain
      // `python3` (packages/orizu-gepa-python/manifest.json) and the CLI spawns
      // `process.env.PYTHON || 'python3'` — but /usr/bin/python3 stays 3.9 and
      // cannot import braintrust. /usr/local/bin/python3 -> /usr/bin/python3.11
      // wins by PATH precedence for user-launched processes (hosted-loop spawns
      // inherit the ambient PATH; nothing constructs its own) while dnf's
      // absolute-shebang scripts keep using the untouched /usr/bin/python3.
      name: `install python3.11 + braintrust[cli]==${braintrustPyVersion} (python eval harness; python3 -> 3.11 via /usr/local/bin)`,
      exec:
        `sudo dnf -y install python3.11 python3.11-pip && sudo dnf clean all && ` +
        `sudo python3.11 -m pip install --no-cache-dir "braintrust[cli]==${braintrustPyVersion}" && ` +
        `sudo ln -sf /usr/bin/python3.11 /usr/local/bin/python3 && sudo ln -sf /usr/bin/pip3.11 /usr/local/bin/pip3`,
    },
  ]
}

/**
 * Bake-verification suffix for the Braintrust tooling (both modes): both CLIs
 * resolve AND execute, the PATH `braintrust` is the python one (shebang check,
 * ANCHORED to a shebang line ending in /python3.11 so a lookalike path cannot
 * pass — a silent npm/pip bin-dir mixup must fail the bake, not Highlight's
 * first eval), the DEFAULT `python3` resolves to 3.11 and imports braintrust
 * (the runner exec context launches plain `python3` — this runs in the same
 * ambient PATH the runner spawns inherit, so a precedence surprise fails the
 * bake here), and the python package imports at the pinned version.
 */
function braintrustVerify(braintrustPyVersion) {
  return (
    `command -v braintrust && command -v bt && ` +
    `head -1 "$(command -v braintrust)" | grep -Eq '^#!.*/python3\\.11$' && ` +
    `braintrust --help >/dev/null && bt --help >/dev/null && ` +
    `python3 --version | grep -F "Python 3.11" && python3 -c 'import braintrust' && ` +
    `python3.11 -c 'import braintrust; from importlib.metadata import version; assert version("braintrust") == "${braintrustPyVersion}"'`
  )
}

/** Presence check that never echoes the values (no secret in logs/errors). */
export function resolveCredsOrFail(env, fail) {
  const token = env.VERCEL_TOKEN ?? env.VERCEL_OIDC_TOKEN
  const projectId = env.VERCEL_PROJECT_ID
  const teamId = env.VERCEL_TEAM_ID
  const missing = []
  if (!token) missing.push('VERCEL_TOKEN')
  if (!projectId) missing.push('VERCEL_PROJECT_ID')
  if (!teamId) missing.push('VERCEL_TEAM_ID')
  if (missing.length) fail(`missing Vercel credentials in env: ${missing.join(', ')}`)
  return { token, projectId, teamId }
}

/**
 * The ordered in-sandbox provisioning steps. Pure data (no I/O) so a test can
 * assert the plan without a sandbox. `sudo` assumes Vercel's passwordless-sudo
 * non-root sandbox user; drop it if the runtime ever runs as root.
 *
 * Passing `cliVersion` switches to PUBLISHED-PACKAGE mode: the CLI comes from
 * `npm i -g orizu@<cliVersion>` (which carries its own pinned
 * @anthropic-ai/claude-agent-sdk dependency) instead of a from-source bundle.
 */
export function buildProvisionSteps({
  bundleContent,
  gitVersion,
  opencodeVersion,
  claudeSdkVersion,
  braintrustPyVersion = DEFAULT_BRAINTRUST_PY_VERSION,
  braintrustNpmVersion = DEFAULT_BRAINTRUST_NPM_VERSION,
  cliVersion = null,
}) {
  if (cliVersion) {
    return [
      {
        name: `install published orizu@${cliVersion} (global bin, carries the Claude SDK dep)`,
        exec: `sudo npm install -g "orizu@${cliVersion}" && sudo npm cache clean --force`,
      },
      { name: 'install opencode-ai (global bin)', exec: `sudo npm install -g "opencode-ai@${opencodeVersion}" && sudo npm cache clean --force` },
      ...braintrustSteps({ braintrustPyVersion, braintrustNpmVersion }),
      {
        name: 'stage prebaked marker',
        writeFile: [
          STAGE_MARKER,
          markerJson({ cliVersion, cliSource: 'published-npm', cliGitVersion: null, opencodeVersion, claudeSdkVersion, braintrustPyVersion, braintrustNpmVersion }),
        ],
      },
      { name: 'install prebaked marker', exec: `sudo mkdir -p /opt/orizu && sudo mv ${STAGE_MARKER} ${MARKER_PATH}` },
      {
        // Merge-sandbox-job Phase 0 (ALI-1084): the one-shot merge sandbox
        // needs a REAL git + ssh client. git rode the bake already; ssh was
        // never verified — fail the bake here rather than the first prod merge.
        name: 'verify git + ssh client present (merge-job runtime requirement)',
        exec: 'command -v ssh >/dev/null 2>&1 || sudo dnf -y install openssh-clients; git --version && ssh -V',
      },
      {
        name: 'verify bake (orizu version + opencode + hosted-loop + braintrust)',
        exec:
          `command -v orizu && command -v opencode && orizu --version | grep -F "${cliVersion}" && ` +
          `orizu internal hosted-loop 2>&1 | grep -q 'hosted-loop --context' && ` +
          braintrustVerify(braintrustPyVersion),
      },
    ]
  }
  return [
    { name: 'stage CLI bundle', writeFile: [STAGE_BUNDLE, bundleContent] },
    {
      name: 'install CLI bundle',
      exec: `sudo mkdir -p ${CLI_DIST_DIR} && sudo mv ${STAGE_BUNDLE} ${CLI_INDEX} && sudo chmod +x ${CLI_INDEX}`,
    },
    { name: 'stage package.json', writeFile: [STAGE_PKG, packageJson(gitVersion)] },
    { name: 'install package.json', exec: `sudo mv ${STAGE_PKG} ${CLI_PKG}` },
    { name: 'symlink orizu onto PATH', exec: `sudo ln -sf ${CLI_INDEX} /usr/local/bin/orizu` },
    {
      name: 'install @anthropic-ai/claude-agent-sdk (sibling of bundle)',
      exec: `cd ${CLI_DIR} && sudo npm install --no-save --omit=dev "@anthropic-ai/claude-agent-sdk@${claudeSdkVersion}" && sudo npm cache clean --force`,
    },
    { name: 'install opencode-ai (global bin)', exec: `sudo npm install -g "opencode-ai@${opencodeVersion}" && sudo npm cache clean --force` },
    ...braintrustSteps({ braintrustPyVersion, braintrustNpmVersion }),
    {
      name: 'stage prebaked marker',
      writeFile: [
        STAGE_MARKER,
        markerJson({ cliVersion: gitVersion, cliSource: 'from-source', cliGitVersion: gitVersion, opencodeVersion, claudeSdkVersion, braintrustPyVersion, braintrustNpmVersion }),
      ],
    },
    { name: 'install prebaked marker', exec: `sudo mkdir -p /opt/orizu && sudo mv ${STAGE_MARKER} ${MARKER_PATH}` },
    {
      // Merge-sandbox-job Phase 0 (ALI-1084): fail the bake if git/ssh are
      // absent — the merge job cannot run without them (see published mode).
      name: 'verify git + ssh client present (merge-job runtime requirement)',
      exec: 'git --version && ssh -V',
    },
    {
      name: 'verify bake (orizu + opencode + hosted-loop + braintrust)',
      exec:
        `command -v orizu && command -v opencode && orizu --version && orizu internal hosted-loop 2>&1 | grep -q 'hosted-loop --context' && ` +
        braintrustVerify(braintrustPyVersion),
    },
  ]
}

/** Default real provider loader — imported LAZILY (TS source) so tests that inject
 *  a fake provider never load the SDK. Runs under bun. */
async function defaultCreateProvider() {
  const url = new URL('../src/vercel-sandbox-provider.ts', import.meta.url).href
  const mod = await import(url)
  return mod.createVercelProvider()
}

export async function runProvisionSnapshot(opts = {}) {
  const argv = opts.argv ?? process.argv.slice(2)
  const env = opts.env ?? process.env
  const buildBundle = opts.buildBundle ?? buildCliBundle
  const gitVersion = opts.gitVersion ?? resolveGitVersion()
  const out = opts.stdout ?? (s => process.stdout.write(s))
  const errOut = opts.stderr ?? (s => process.stderr.write(s))
  const createProvider = opts.createProvider ?? defaultCreateProvider

  let failed = false
  const fail = message => {
    failed = true
    errOut(`error: ${message}\n`)
  }

  const args = parseArgs(argv)
  const dryRun = args.flags.has('dry-run')

  // Published-package mode (ALI-1078): bake `orizu@<version>` from npm instead of
  // building the current checkout from source.
  const cliVersion = args.values['cli-version'] ?? null
  if (cliVersion !== null && !CLI_VERSION_RE.test(cliVersion)) {
    fail(`invalid --cli-version "${cliVersion}" — expected a semver like 0.6.0`)
  }

  const label = args.values.label ?? (cliVersion ? `cli-v${cliVersion}` : gitVersion)
  if (!LABEL_RE.test(label)) fail(`invalid label "${label}" — must match ${LABEL_RE}`)

  const idFile = args.values['id-file'] ?? null

  const durationMinutes = Number(args.values.duration ?? DEFAULT_DURATION_MINUTES)
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) fail('--duration must be a positive number of minutes')

  let expiration
  if (args.values.expiration !== undefined) {
    expiration = Number(args.values.expiration)
    if (!Number.isFinite(expiration) || expiration < 0) fail('--expiration must be a non-negative number of ms (0 = never)')
  }

  const opencodeVersion = args.values['opencode-version'] ?? DEFAULT_OPENCODE_VERSION
  const claudeSdkVersion = args.values['claude-sdk-version'] ?? DEFAULT_CLAUDE_SDK_VERSION
  // Braintrust eval tooling pins (ALI-1048). Interpolated into shell commands →
  // strict version shapes only, and a value-less flag is an ERROR (the parser
  // would otherwise treat it as a boolean and silently fall back to the default).
  const braintrustPyVersion = args.values['braintrust-py-version'] ?? DEFAULT_BRAINTRUST_PY_VERSION
  const braintrustNpmVersion = args.values['braintrust-npm-version'] ?? DEFAULT_BRAINTRUST_NPM_VERSION
  for (const [flag, value, re, example] of [
    ['braintrust-py-version', braintrustPyVersion, BRAINTRUST_PY_VERSION_RE, '0.30.0'],
    ['braintrust-npm-version', braintrustNpmVersion, BRAINTRUST_NPM_VERSION_RE, '3.23.1'],
  ]) {
    if (args.flags.has(flag)) fail(`--${flag} requires a value (e.g. ${example})`)
    else if (!re.test(value)) fail(`invalid --${flag} "${value}" — expected a version like ${example}`)
  }

  // Credentials are required for a real run (never printed). Skip the hard check on
  // --dry-run so the plan can be inspected without creds.
  const creds = dryRun ? { token: env.VERCEL_TOKEN, projectId: env.VERCEL_PROJECT_ID, teamId: env.VERCEL_TEAM_ID } : resolveCredsOrFail(env, fail)

  if (failed) return { ok: false }

  if (cliVersion) {
    out(`Snapshot label (published-package bake): ${label}\n`)
    out(`CLI provenance: orizu@${cliVersion} (published npm package)\n`)
  } else {
    out(`Snapshot label (git-describe, baked from source): ${label}\n`)
    out(`CLI provenance: ${gitVersion}\n`)
  }
  out(`Provisioning sandbox lifetime: ${durationMinutes}m\n`)
  out(
    `Pinned externals: opencode-ai@${opencodeVersion}, @anthropic-ai/claude-agent-sdk@${claudeSdkVersion}, ` +
      `braintrust[cli]==${braintrustPyVersion} (PyPI), braintrust@${braintrustNpmVersion} (npm)\n\n`
  )

  const stepsPlan = buildProvisionSteps({ bundleContent: '<bundle>', gitVersion, opencodeVersion, claudeSdkVersion, braintrustPyVersion, braintrustNpmVersion, cliVersion })
  out('Plan:\n')
  let planStep = 1
  if (!cliVersion) {
    out(`  ${planStep}. bun build → self-contained CLI bundle (from source)\n`)
    planStep += 1
  }
  out(`  ${planStep}. create base sandbox (OPEN network — provision-time npm installs need egress)\n`)
  planStep += 1
  stepsPlan.forEach(step => {
    out(`  ${planStep}. ${step.name}\n`)
    planStep += 1
  })
  out(`  ${planStep}. snapshot() → capture snapshot id${expiration !== undefined ? ` (expiration ${expiration}ms)` : ''}\n\n`)

  if (dryRun) {
    out('--dry-run: not building the bundle, not creating a sandbox, not snapshotting.\n')
    return { ok: true, dryRun: true, label, snapshotId: null, cliVersion }
  }

  // 1. Resolve the CLI payload: published mode installs from npm inside the
  //    sandbox (no local build); from-source mode bakes a bundle for upload.
  const bundleFile = resolve(HERE, 'dist', 'orizu.js')
  let bundleContent = null
  if (!cliVersion) {
    out('Baking the CLI from source (bun build)…\n')
    buildBundle(bundleFile)
    bundleContent = readFileSync(bundleFile, 'utf8')
  }

  // 2. Boot a base sandbox with OPEN network (omit egressPolicy → Vercel default is
  //    full internet) so the provision-time installs can reach npm.
  const provider = await createProvider({ ...creds })
  out('Creating base sandbox (open network)…\n')
  const session = await provider.createSandbox({ timeoutMs: durationMinutes * 60 * 1000 })
  out(`sandbox ${session.id}\n`)

  try {
    const steps = buildProvisionSteps({ bundleContent, gitVersion, opencodeVersion, claudeSdkVersion, braintrustPyVersion, braintrustNpmVersion, cliVersion })
    for (const step of steps) {
      out(`- ${step.name}\n`)
      if (step.writeFile) {
        await session.writeFile(step.writeFile[0], step.writeFile[1])
      } else if (step.exec) {
        const res = await session.exec(step.exec)
        if (res.exitCode !== 0) {
          const detail = (res.stderr || res.stdout || `exit ${res.exitCode}`).trim()
          throw new Error(`step "${step.name}" failed: ${detail}`)
        }
      }
    }

    // 3. Snapshot the provisioned sandbox → the id future sessions boot from.
    if (typeof session.snapshot !== 'function') {
      throw new Error('provider session does not support snapshot() — is this the Vercel provider?')
    }
    out('Snapshotting (the sandbox is stopped as part of this)…\n')
    const snapshotId = await session.snapshot(expiration !== undefined ? { expiration } : undefined)

    out(`\nSnapshot ready: ${snapshotId}\n`)
    out('Use it (zero-Docker prebaked runtime):\n')
    out(`  ORIZU_HOSTED_SNAPSHOT=${snapshotId} orizu session start --hosted --task "…"\n`)
    out(`  # or: orizu session start --hosted --snapshot ${snapshotId} --task "…"\n`)
    if (idFile) {
      writeFileSync(idFile, `${snapshotId}\n`)
      out(`Snapshot id written to ${idFile}\n`)
    }
    return { ok: true, snapshotId, label, cliVersion }
  } catch (error) {
    // Best-effort teardown so a failed provision does not leak a paid sandbox.
    try {
      await session.destroy()
    } catch {
      // ignore
    }
    throw error
  } finally {
    // The staged bundle is git-ignored; remove it so the context stays clean.
    try {
      rmSync(bundleFile, { force: true })
    } catch {
      // ignore
    }
  }
}

if (import.meta.main) {
  runProvisionSnapshot()
    .then(result => {
      if (!result.ok) process.exit(1)
    })
    .catch(error => {
      process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    })
}
