#!/usr/bin/env node
/**
 * Shared helper: build the Orizu CLI FROM SOURCE into a single self-contained
 * bundle, and resolve the git provenance string that labels a built runtime
 * (ALI-1017). Used by BOTH prebaked-runtime provisioners:
 *   - `build-and-push.mjs`   (Docker/VCR image — stages the bundle into dist/)
 *   - `provision-snapshot.mjs` (Vercel snapshot — uploads the bundle into a box)
 *
 * WHY THIS HELPER STILL BAKES FROM SOURCE
 * The Docker/VCR image path still stages a source-built bundle, and the snapshot
 * path keeps that same source-built mode as the manual escape hatch. The canonical
 * publish-cli.yml release flow now uses provision-snapshot.mjs --cli-version to
 * bake a snapshot from the published npm package instead.
 *
 * HOW THE BUNDLE IS BUILT
 * `bun build src/index.ts --target node --packages bundle` — ordinary runtime
 * dependencies bundle into one file. Optional preview tooling stays external via
 * explicit flags, while provider SDKs remain lazy, non-literal dynamic imports
 * resolved from the baked global/sibling node_modules. The resulting bundle needs
 * no `node_modules` of its own to start.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
/** packages/cli (the CLI package root — parent of hosted-runtime-image/). */
export const CLI_ROOT = resolve(here, '..')
/** The CLI entrypoint that becomes the `orizu` bin. */
export const CLI_ENTRY = resolve(CLI_ROOT, 'src', 'index.ts')

export function assertEffectDependencyIsInstalled(cliRoot = CLI_ROOT) {
  const cliPackage = JSON.parse(readFileSync(resolve(cliRoot, 'package.json'), 'utf8'))
  const declaredVersion = cliPackage.dependencies?.effect
  if (typeof declaredVersion !== 'string' || !declaredVersion) {
    throw new Error('HOSTED_CLI_BUNDLE_EFFECT_DECLARATION_MISSING: packages/cli/package.json must declare an exact Effect version')
  }

  let installedVersion
  try {
    const effectPackage = JSON.parse(readFileSync(resolve(cliRoot, 'node_modules', 'effect', 'package.json'), 'utf8'))
    installedVersion = effectPackage.version
  } catch {
    throw new Error(`HOSTED_CLI_BUNDLE_EFFECT_MISSING: expected effect@${declaredVersion} in packages/cli/node_modules; run bun install --cwd packages/cli`)
  }
  if (installedVersion !== declaredVersion) {
    throw new Error(`HOSTED_CLI_BUNDLE_EFFECT_VERSION_MISMATCH: packages/cli declares effect@${declaredVersion} but packages/cli/node_modules has effect@${String(installedVersion)}; run bun install --cwd packages/cli`)
  }
}

/**
 * Resolve the git provenance string that labels a built runtime:
 * `git describe --tags --always --dirty` (e.g. `cli-v0.4.1-51-gedbe8d42`). It ties
 * the artifact to a git ref/tag — the project-wide versioning scheme (tags drive
 * publish-cli.yml). Never throws for a clean checkout; returns `'unknown'` only if
 * git is entirely unavailable (e.g. a tarball with no .git).
 */
export function resolveGitVersion(cwd = CLI_ROOT) {
  const res = spawnSync('git', ['describe', '--tags', '--always', '--dirty'], {
    cwd,
    encoding: 'utf8',
  })
  if (res.status === 0 && typeof res.stdout === 'string' && res.stdout.trim()) {
    return res.stdout.trim()
  }
  return 'unknown'
}

/**
 * Build the CLI bundle to `outFile`. Throws (non-zero exit) if `bun` is missing or
 * the build fails — a broken bundle must never be staged into a runtime. Returns
 * the absolute path written.
 */
export function buildCliBundle(outFile, timeout, executable = 'bun', cliRoot = CLI_ROOT) {
  assertEffectDependencyIsInstalled(cliRoot)
  const out = resolve(outFile)
  const args = [
    'build', resolve(cliRoot, 'src', 'index.ts'), '--target', 'node', '--packages', 'bundle',
    '--external', 'esbuild',
    '--external', 'postcss',
    '--external', '@tailwindcss/postcss',
    '--external', '@playwright/test',
    '--external', 'playwright',
    '--outfile', out,
  ]
  const res = spawnSync(executable, args, { cwd: cliRoot, stdio: 'inherit', timeout })
  if (res.error) {
    throw new Error(`failed to spawn bun (is it installed?): ${res.error.message}`)
  }
  if (res.status !== 0) {
    throw new Error(`bun build exited ${res.status}`)
  }
  return out
}
