#!/usr/bin/env node
/**
 * Build + push the Orizu hosted-sandbox runtime image to Vercel's Container
 * Registry (VCR) so `Sandbox.create({ image })` can use it (ALI-1017).
 *
 * FOUNDER-RUN ONLY. This needs `docker buildx` (with a builder that can output
 * linux/amd64) AND Vercel VCR push auth (`docker login` against vcr.vercel.com,
 * or a Vercel token the daemon is configured with). NEITHER is available in CI /
 * the agent environment, so this script is written to be run by a human.
 *
 * Usage:
 *   node build-and-push.mjs --team <slug> --project <slug> [--tag <tag>] [--dry-run]
 *   ORIZU_VCR_TEAM=<slug> ORIZU_VCR_PROJECT=<slug> [ORIZU_HOSTED_IMAGE_TAG=<tag>] \
 *     node build-and-push.mjs
 *
 *   --tag       override the default git-describe tag (still slug-validated)
 *   --dry-run   print the plan (bundle build + buildx command) without running it
 *   --opencode-version / --claude-sdk-version / --node-major
 *   --braintrust-py-version / --braintrust-npm-version
 *               override the pinned build ARGs (defaults live in the Dockerfile).
 *               The Docker/VCR image path still bakes the CLI FROM SOURCE; the
 *               published-package `--cli-version` mode is snapshot-only.
 */

import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildCliBundle, resolveGitVersion } from './build-cli-bundle.mjs'
// Shared strict version shapes (ALI-1048) — BOTH bake recipes validate
// identically (the values land in docker --build-arg here). The npm shape
// doubles as the validator for every npm-pinned override (opencode / Claude
// SDK), not just the braintrust one. Importing provision-snapshot.mjs is
// side-effect free (its main() is guarded by import.meta.main).
import { BRAINTRUST_NPM_VERSION_RE, BRAINTRUST_PY_VERSION_RE, sourceAssetPayload } from './provision-snapshot.mjs'

const IMAGE_NAME = 'orizu-hosted-runtime'
const REGISTRY_HOST = 'vcr.vercel.com'
// A conservative slug shape shared by team/project/tag — reject anything a shell
// or a registry path could mis-parse rather than trust it.
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function parseArgs(argv) {
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

function fail(message) {
  process.stderr.write(`error: ${message}\n`)
  process.exit(1)
}

function requireSlug(value, label) {
  if (!value) fail(`missing ${label} (pass --${label} or set its env var)`)
  if (!SLUG_RE.test(value)) fail(`invalid ${label} "${value}" — must match ${SLUG_RE}`)
  return value
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url))
  const contextDir = resolve(here, '..', '..', '..')
  const args = parseArgs(process.argv.slice(2))

  const team = requireSlug(args.values.team ?? process.env.ORIZU_VCR_TEAM, 'team')
  const project = requireSlug(args.values.project ?? process.env.ORIZU_VCR_PROJECT, 'project')
  const dryRun = args.flags.has('dry-run')

  const gitVersion = resolveGitVersion()
  const tag = requireSlug(
    args.values.tag ?? process.env.ORIZU_HOSTED_IMAGE_TAG ?? gitVersion,
    'tag'
  )

  const registryRef = `${REGISTRY_HOST}/${team}/${project}/${IMAGE_NAME}:${tag}`
  const shortRef = `${IMAGE_NAME}:${tag}`

  const buildArgs = ['--build-arg', `ORIZU_CLI_GIT_VERSION=${gitVersion}`]
  // Optional pin overrides for the npm-pinned externals → forwarded as --build-arg
  // (defaults live in the Dockerfile, the source-of-truth for those pins).
  const argMap = {
    'opencode-version': 'OPENCODE_VERSION',
    'claude-sdk-version': 'CLAUDE_SDK_VERSION',
    'braintrust-py-version': 'BRAINTRUST_PY_VERSION',
    'braintrust-npm-version': 'BRAINTRUST_NPM_VERSION',
    'node-major': 'NODE_MAJOR',
  }
  // EVERY forwarded override is validated strictly (ALI-1048): a value-less
  // flag is an error (the parser would treat it as a boolean and silently drop
  // it), and the value must match the shape for its registry — npm semver for
  // the npm pins, the restricted PyPI shape for the PyPI pin, a bare integer
  // for --node-major. The values land in docker --build-arg.
  for (const [flag, re, example] of [
    ['braintrust-py-version', BRAINTRUST_PY_VERSION_RE, '0.30.0'],
    ['braintrust-npm-version', BRAINTRUST_NPM_VERSION_RE, '3.23.1'],
    ['opencode-version', BRAINTRUST_NPM_VERSION_RE, '1.14.41'],
    ['claude-sdk-version', BRAINTRUST_NPM_VERSION_RE, '0.3.201'],
    ['node-major', /^[0-9]+$/, '24'],
  ]) {
    if (args.flags.has(flag)) fail(`--${flag} requires a value (e.g. ${example})`)
    const value = args.values[flag]
    if (value !== undefined && !re.test(value)) fail(`invalid --${flag} "${value}" — expected a value like ${example}`)
  }
  for (const [flag, name] of Object.entries(argMap)) {
    const value = args.values[flag]
    if (value !== undefined) buildArgs.push('--build-arg', `${name}=${value}`)
  }

  const bundleOut = resolve(here, 'dist', 'orizu.js')
  const assetsOut = resolve(here, 'dist', 'skilled-proposer-assets.json')

  const outputSpec = [
    'type=image',
    `name=${registryRef}`,
    'push=true',
    'oci-mediatypes=true',
    'compression=zstd',
    'compression-level=3',
    'force-compression=true',
  ].join(',')

  const commandArgs = [
    'buildx',
    'build',
    '--platform',
    'linux/amd64',
    '--file',
    resolve(here, 'Dockerfile'),
    ...buildArgs,
    '--output',
    outputSpec,
    contextDir,
  ]

  const printable = `docker ${commandArgs.map(a => (/[\s,]/.test(a) ? JSON.stringify(a) : a)).join(' ')}`

  process.stdout.write(`Image ref (registry): ${registryRef}\n`)
  process.stdout.write(`Sandbox.create({ image }) / ORIZU_HOSTED_IMAGE: ${shortRef}\n`)
  process.stdout.write(`CLI provenance (git-describe, baked from source): ${gitVersion}\n\n`)
  process.stdout.write(`1. bun build → ${bundleOut}\n`)
  process.stdout.write(`2. ${printable}\n\n`)

  if (dryRun) {
    process.stdout.write('--dry-run: not building the bundle or executing docker.\n')
    return
  }

  process.stdout.write('Baking the CLI from source (bun build)…\n')
  buildCliBundle(bundleOut)
  writeFileSync(assetsOut, sourceAssetPayload())

  process.stdout.write('Building + pushing (requires docker buildx + VCR auth)…\n')
  const result = spawnSync('docker', commandArgs, { stdio: 'inherit' })
  if (result.error) fail(`failed to spawn docker: ${result.error.message}`)
  if (result.status !== 0) fail(`docker buildx exited ${result.status}`)

  process.stdout.write('\nPush complete.\n\n')
  process.stdout.write('VCR readiness:\n')
  process.stdout.write(
    '  Vercel prepares a linux/amd64 variant asynchronously. Wait until the image\n' +
      '  shows status "Ready" for linux/amd64 in the Vercel dashboard (Project →\n' +
      '  Storage/Registry) or via the API before creating a sandbox with it — a\n' +
      '  create against a "Preparing" image throws image_not_ready (the provider\n' +
      '  retries that with backoff, but a first live run should wait for Ready).\n\n',
  )
  process.stdout.write(`Then run a session with:\n  ORIZU_HOSTED_IMAGE=${shortRef} orizu session start --hosted --task "…"\n`)
}

main()
