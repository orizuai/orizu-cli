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

function markerJson({ cliVersion, cliSource, cliGitVersion, opencodeVersion, claudeSdkVersion }) {
  const gitLine = cliGitVersion ? `  "cliGitVersion": "${cliGitVersion}",\n` : ''
  return (
    `{\n  "cliVersion": "${cliVersion}",\n  "cliSource": "${cliSource}",\n` +
    `${gitLine}  "opencodeVersion": "${opencodeVersion}",\n` +
    `  "claudeSdkVersion": "${claudeSdkVersion}",\n  "builtFor": "vercel-sandbox"\n}\n`
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
export function buildProvisionSteps({ bundleContent, gitVersion, opencodeVersion, claudeSdkVersion, cliVersion = null }) {
  if (cliVersion) {
    return [
      {
        name: `install published orizu@${cliVersion} (global bin, carries the Claude SDK dep)`,
        exec: `sudo npm install -g "orizu@${cliVersion}" && sudo npm cache clean --force`,
      },
      { name: 'install opencode-ai (global bin)', exec: `sudo npm install -g "opencode-ai@${opencodeVersion}" && sudo npm cache clean --force` },
      {
        name: 'stage prebaked marker',
        writeFile: [
          STAGE_MARKER,
          markerJson({ cliVersion, cliSource: 'published-npm', cliGitVersion: null, opencodeVersion, claudeSdkVersion }),
        ],
      },
      { name: 'install prebaked marker', exec: `sudo mkdir -p /opt/orizu && sudo mv ${STAGE_MARKER} ${MARKER_PATH}` },
      {
        name: 'verify bake (orizu version + opencode + hosted-loop)',
        exec:
          `command -v orizu && command -v opencode && orizu --version | grep -F "${cliVersion}" && ` +
          `orizu internal hosted-loop 2>&1 | grep -q 'hosted-loop --context'`,
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
    {
      name: 'stage prebaked marker',
      writeFile: [
        STAGE_MARKER,
        markerJson({ cliVersion: gitVersion, cliSource: 'from-source', cliGitVersion: gitVersion, opencodeVersion, claudeSdkVersion }),
      ],
    },
    { name: 'install prebaked marker', exec: `sudo mkdir -p /opt/orizu && sudo mv ${STAGE_MARKER} ${MARKER_PATH}` },
    {
      name: 'verify bake (orizu + opencode + hosted-loop)',
      exec: `command -v orizu && command -v opencode && orizu --version && orizu internal hosted-loop 2>&1 | grep -q 'hosted-loop --context'`,
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
  out(`Pinned externals: opencode-ai@${opencodeVersion}, @anthropic-ai/claude-agent-sdk@${claudeSdkVersion}\n\n`)

  const stepsPlan = buildProvisionSteps({ bundleContent: '<bundle>', gitVersion, opencodeVersion, claudeSdkVersion, cliVersion })
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
    const steps = buildProvisionSteps({ bundleContent, gitVersion, opencodeVersion, claudeSdkVersion, cliVersion })
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
