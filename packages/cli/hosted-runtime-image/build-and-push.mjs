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
 * WHAT IT DOES
 *   1. validates team-slug / project-slug / tag (from flags or env); the TAG
 *      DEFAULTS to the git provenance string (`git describe --tags --always
 *      --dirty`) so a built runtime is traceable to a git ref/tag;
 *   2. builds the Orizu CLI FROM SOURCE into a single self-contained bundle
 *      (`dist/orizu.js` in this build context) so the runtime CLI ALWAYS matches
 *      this checkout — the just-merged `orizu internal hosted-loop` command is not
 *      in a published CLI tag yet, so a pinned `npm i -g orizu@<v>` can't carry it;
 *   3. builds the Dockerfile for linux/amd64 (it COPYs that bundle) and pushes it
 *      to vcr.vercel.com/<team>/<project>/orizu-hosted-runtime:<tag> with the
 *      zstd/oci output flags Vercel Sandbox requires;
 *   4. prints the resulting image ref + the VCR readiness-check instructions.
 *
 * The registry-facing ref is the full `vcr.vercel.com/...` path; the value you
 * pass to `Sandbox.create({ image })` (and to `ORIZU_HOSTED_IMAGE`) is the SHORT
 * ref `orizu-hosted-runtime:<tag>` — the platform resolves it within your team.
 *
 * Usage:
 *   node build-and-push.mjs --team <slug> --project <slug> [--tag <tag>] [--dry-run]
 *   ORIZU_VCR_TEAM=<slug> ORIZU_VCR_PROJECT=<slug> [ORIZU_HOSTED_IMAGE_TAG=<tag>] \
 *     node build-and-push.mjs
 *
 *   --tag       override the default git-describe tag (still slug-validated)
 *   --dry-run   print the plan (bundle build + buildx command) without running it
 *   --opencode-version / --claude-sdk-version / --node-major
 *               override the pinned build ARGs (defaults live in the Dockerfile).
 *               The CLI is baked FROM SOURCE — there is no --cli-version anymore.
 */

import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildCliBundle, resolveGitVersion } from './build-cli-bundle.mjs'

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
  const contextDir = resolve(here)
  const args = parseArgs(process.argv.slice(2))

  const team = requireSlug(args.values.team ?? process.env.ORIZU_VCR_TEAM, 'team')
  const project = requireSlug(args.values.project ?? process.env.ORIZU_VCR_PROJECT, 'project')
  const dryRun = args.flags.has('dry-run')

  // Provenance: the git-describe string labels the runtime AND (as a build ARG)
  // is recorded in /opt/orizu/prebaked.json. The image TAG DEFAULTS to it so a
  // built runtime is traceable to a git ref/tag; an explicit --tag still wins.
  const gitVersion = resolveGitVersion()
  const tag = requireSlug(
    args.values.tag ?? process.env.ORIZU_HOSTED_IMAGE_TAG ?? gitVersion,
    'tag'
  )

  const registryRef = `${REGISTRY_HOST}/${team}/${project}/${IMAGE_NAME}:${tag}`
  const shortRef = `${IMAGE_NAME}:${tag}`

  // The CLI is baked FROM SOURCE; its provenance is the git-describe string, which
  // the Dockerfile records in the marker as `ORIZU_CLI_GIT_VERSION`.
  const buildArgs = ['--build-arg', `ORIZU_CLI_GIT_VERSION=${gitVersion}`]
  // Optional pin overrides for the npm-pinned externals → forwarded as --build-arg
  // (defaults live in the Dockerfile, the source-of-truth for those pins).
  const argMap = {
    'opencode-version': 'OPENCODE_VERSION',
    'claude-sdk-version': 'CLAUDE_SDK_VERSION',
    'node-major': 'NODE_MAJOR',
  }
  for (const [flag, name] of Object.entries(argMap)) {
    const value = args.values[flag]
    if (value !== undefined) buildArgs.push('--build-arg', `${name}=${value}`)
  }

  // Bake the CLI from source: build the self-contained bundle into the Docker
  // build context so the Dockerfile can COPY it. (dist/ is git-ignored.)
  const bundleOut = resolve(contextDir, 'dist', 'orizu.js')

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
