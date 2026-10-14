// ORI-2425: Effect owns the lifetime of what the plugin scripts write: the
// bundled skill in each plugin package and the staged release artifacts. Each
// is assembled in a staging folder that the scope removes if the run fails or
// is interrupted, then swapped in whole, so a stop never leaves a half-written
// bundle and a failed pack keeps the previous artifacts. Hashing, manifest and
// metadata checks stay plain functions in lib.mjs and problems.mjs.
import { spawn } from 'child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'
import { Effect } from 'effect'

import {
  assertSkillSourceExists,
  computeSkillContentHash,
  copySkillTree,
  getCliVersion,
  PLUGIN_PACKAGES,
  PLUGINS_DIST_DIR,
  readJson,
  SKILL_META_FILENAME,
  SKILL_NAME,
  SKILL_SOURCE_DIR,
  STAGING_PREFIX,
} from './lib.mjs'
import { findPluginProblems } from './problems.mjs'

/** An expected failure: its lines are printed as `error: …`, never a stack trace. */
class PluginScriptError extends Error {
  constructor(problems) {
    super(problems.join('\n'))
    this.problems = problems
  }
}

const fail = (...problems) => Effect.fail(new PluginScriptError(problems))

// A fresh folder next to `target` (same filesystem, so renames are atomic),
// removed when the scope closes unless it was swapped in by then.
const stagingFor = (target, label) => Effect.acquireRelease(
  Effect.sync(() => {
    mkdirSync(dirname(target), { recursive: true })
    const staging = mkdtempSync(join(dirname(target), `.${label}-staging-`))
    // mkdtemp makes 0700 folders; keep the permissions a plain mkdir gave before.
    chmodSync(staging, 0o755)
    return staging
  }),
  staging => Effect.sync(() => rmSync(staging, { recursive: true, force: true })),
)

const clearStaleStaging = (target, label) => Effect.sync(() => {
  if (!existsSync(dirname(target))) return
  for (const name of readdirSync(dirname(target))) {
    if (name.startsWith(`.${label}-staging-`)) rmSync(join(dirname(target), name), { recursive: true, force: true })
  }
})

// Replace `target` with the complete `staging` folder: two renames, then the
// old copy goes. Nothing else next to `target` is touched.
const swapIn = (staging, target) => Effect.uninterruptible(Effect.sync(() => {
  const previous = existsSync(target) ? `${staging}-previous` : undefined
  if (previous) renameSync(target, previous)
  renameSync(staging, target)
  if (previous) rmSync(previous, { recursive: true, force: true })
}))

const readManifest = plugin => Effect.try({
  try: () => readJson(plugin.manifest),
  catch: error => new PluginScriptError([`${plugin.id}: manifest is not valid JSON (${error?.message || error})`]),
})

// Run a child to completion; interrupting kills it, a nonzero exit fails.
const runChild = (command, args, label) => Effect.callback(resume => {
  const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'] })
  child.once('error', error => resume(fail(`${label}: ${error.message}`)))
  child.once('close', (status, signal) => resume(status === 0
    ? Effect.void
    : fail(`${label} exited with ${signal ?? `status ${status}`}`)))
  return Effect.sync(() => { child.kill('SIGKILL') })
})

/** Materialize the shared skill into each plugin package (deterministic output). */
export const buildPlugins = Effect.gen(function* () {
  yield* Effect.try({ try: assertSkillSourceExists, catch: error => new PluginScriptError([error.message]) })
  const skillHash = computeSkillContentHash(SKILL_SOURCE_DIR)
  const cliVersion = getCliVersion()
  // Every manifest is read first, so a bad one stops the build before any plugin is touched.
  const plugins = []
  for (const plugin of PLUGIN_PACKAGES) plugins.push({ plugin, manifest: yield* readManifest(plugin) })
  for (const { plugin, manifest } of plugins) {
    const target = join(plugin.root, 'skills', SKILL_NAME)
    // A run killed outright (SIGKILL, a crash) runs no cleanup; clear what it left.
    yield* clearStaleStaging(target, SKILL_NAME)
    yield* Effect.scoped(Effect.gen(function* () {
      const staging = yield* stagingFor(target, SKILL_NAME)
      copySkillTree(SKILL_SOURCE_DIR, staging)
      const meta = {
        name: SKILL_NAME,
        skillHash,
        cliVersion,
        pluginVersion: manifest.version ?? null,
        source: 'plugin-bundle',
        sourceRoot: 'skills/orizu',
      }
      writeFileSync(join(staging, SKILL_META_FILENAME), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
      yield* swapIn(staging, target)
    }))
    console.log(`built ${plugin.id}: skills/${SKILL_NAME} (${skillHash.slice(0, 19)}…, cli ${cliVersion})`)
  }
})

/** Stage validated plugin packages and their tarballs into dist/plugins. */
export const packPlugins = Effect.gen(function* () {
  const { problems } = yield* Effect.try({ try: findPluginProblems, catch: error => new PluginScriptError([error.message]) })
  if (problems.length > 0) return yield* fail(...problems)
  yield* Effect.scoped(Effect.gen(function* () {
    yield* clearStaleStaging(PLUGINS_DIST_DIR, 'plugins')
    const staging = yield* stagingFor(PLUGINS_DIST_DIR, 'plugins')
    const packed = []
    for (const plugin of PLUGIN_PACKAGES) {
      const manifest = yield* readManifest(plugin)
      // A staging folder left by a killed build never reaches a release artifact.
      cpSync(plugin.root, join(staging, plugin.id), { recursive: true, filter: source => !basename(source).startsWith(STAGING_PREFIX) })
      const tarName = `orizu-${plugin.id}-plugin-${manifest.version}.tgz`
      yield* runChild('tar', ['-czf', join(staging, tarName), '-C', staging, plugin.id], `tar for ${plugin.id}`)
      packed.push(`packed ${plugin.id} -> dist/plugins/${tarName}`)
    }
    yield* swapIn(staging, PLUGINS_DIST_DIR)
    for (const line of packed) console.log(line)
  }))
})

/** Remove dist/plugins; with --skills, the bundled skills too (they are committed source). */
export const cleanPlugins = withSkills => Effect.sync(() => {
  rmSync(PLUGINS_DIST_DIR, { recursive: true, force: true })
  console.log('removed dist/plugins')
  if (!withSkills) return
  for (const plugin of PLUGIN_PACKAGES) {
    rmSync(join(plugin.root, 'skills', SKILL_NAME), { recursive: true, force: true })
    console.log(`removed ${plugin.id}/skills/${SKILL_NAME}`)
  }
})

const STOP_SIGNALS = ['SIGINT', 'SIGTERM']

/**
 * Entry adapter: run `program`; a stop signal interrupts it (its scope removes
 * any staging folder and kills a running child), then the script ends by that
 * signal. An expected failure prints its lines and exits 1.
 */
export async function runPluginScript(program) {
  const controller = new AbortController()
  let stopSignal
  const handle = signal => { stopSignal ??= signal; controller.abort() }
  const handlers = STOP_SIGNALS.map(signal => [signal, () => handle(signal)])
  for (const [signal, handler] of handlers) process.on(signal, handler)
  try {
    await Effect.runPromise(program, { signal: controller.signal })
  } catch (error) {
    if (!stopSignal) {
      const lines = error instanceof PluginScriptError ? error.problems : [error?.message || String(error)]
      for (const line of lines) console.error(`error: ${line}`)
      process.exitCode = 1
    }
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler)
  }
  if (stopSignal) process.kill(process.pid, stopSignal)
}
