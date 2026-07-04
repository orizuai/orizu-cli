#!/usr/bin/env node
/**
 * Shared helper: build the Orizu CLI FROM SOURCE into a single self-contained
 * bundle, and resolve the git provenance string that labels a built runtime
 * (ALI-1017). Used by BOTH prebaked-runtime provisioners:
 *   - `build-and-push.mjs`   (Docker/VCR image — stages the bundle into dist/)
 *   - `provision-snapshot.mjs` (Vercel snapshot — uploads the bundle into a box)
 *
 * WHY BAKE FROM SOURCE (not `npm i -g orizu@<v>`)
 * The hosted-session commands (`orizu internal hosted-loop`) are not in a
 * PUBLISHED CLI tag yet, so a pinned npm install can't reliably carry them, and
 * an unpublished version 404s the build. Building the CURRENT source guarantees
 * the runtime CLI always matches this checkout. Once a git tag ships the hosted
 * commands via publish-cli.yml, the image/snapshot can instead pin that published
 * version (see README "Canonical long-term flow").
 *
 * HOW THE BUNDLE IS BUILT
 * `bun build src/index.ts --target node --packages external` — the CLI's own 39
 * source modules bundle into ONE file; bare-specifier packages stay external. That
 * is safe because the CLI statically imports NO npm package (only Node built-ins +
 * type-only imports); every heavyweight dep (@vercel/sandbox, @daytonaio/sdk,
 * @anthropic-ai/claude-agent-sdk, esbuild) is reached through a LAZY, non-literal
 * dynamic `import()` that resolves at runtime from the baked global/sibling
 * node_modules. So the bundle is self-contained for the hosted-loop path and needs
 * no `node_modules` of its own to START.
 */

import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
/** packages/cli (the CLI package root — parent of hosted-runtime-image/). */
export const CLI_ROOT = resolve(here, '..')
/** The CLI entrypoint that becomes the `orizu` bin. */
export const CLI_ENTRY = resolve(CLI_ROOT, 'src', 'index.ts')

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
export function buildCliBundle(outFile) {
  const out = resolve(outFile)
  const args = ['build', CLI_ENTRY, '--target', 'node', '--packages', 'external', '--outfile', out]
  const res = spawnSync('bun', args, { cwd: CLI_ROOT, stdio: 'inherit' })
  if (res.error) {
    throw new Error(`failed to spawn bun (is it installed?): ${res.error.message}`)
  }
  if (res.status !== 0) {
    throw new Error(`bun build exited ${res.status}`)
  }
  return out
}
