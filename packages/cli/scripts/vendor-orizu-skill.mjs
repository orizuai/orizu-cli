import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const cliRoot = resolve(scriptDir, '..')
const repoRoot = resolve(cliRoot, '..', '..')
const sourceRoot = resolve(repoRoot, 'skills', 'orizu')
const vendorRoot = resolve(cliRoot, 'vendor', 'skills', 'orizu')
const shouldClean = process.argv.includes('--clean')
const hasSourceSkill = existsSync(resolve(sourceRoot, 'SKILL.md'))
const hasVendoredSkill = existsSync(resolve(vendorRoot, 'SKILL.md'))

function isSafeRelativeSkillPath(rel) {
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)
}

function shouldCopyPath(sourcePath) {
  const rel = relative(sourceRoot, sourcePath).replace(/\\/g, '/')
  if (!rel) {
    return true
  }
  if (!isSafeRelativeSkillPath(rel)) {
    return false
  }

  const parts = rel.split('/')
  return !parts.some(part =>
    part === '.DS_Store' ||
    part === '__pycache__' ||
    part === '.pytest_cache'
  ) && !rel.endsWith('.pyc') && !rel.endsWith('.pyo')
}

const STAGING_PREFIX = '.orizu-staging-'
// A pack killed outright leaves its staging folder next to the vendored skill.
function removeStaleStaging() {
  const vendorParent = dirname(vendorRoot)
  if (!existsSync(vendorParent)) return
  for (const name of readdirSync(vendorParent)) {
    if (name.startsWith(STAGING_PREFIX)) rmSync(resolve(vendorParent, name), { recursive: true, force: true })
  }
}

if (shouldClean) {
  if (hasSourceSkill) {
    rmSync(vendorRoot, { recursive: true, force: true })
    removeStaleStaging()
  }
  process.exit(0)
}

if (!hasSourceSkill) {
  if (hasVendoredSkill) {
    process.exit(0)
  }
  throw new Error(`Unable to vendor orizu skill: source skill not found at ${sourceRoot}`)
}

// ORI-2425: in a source checkout Effect owns the vendored copy's lifetime. It
// is copied into a staging folder that the scope removes if the copy fails or
// the pack is stopped, then swapped in whole, so the CLI (which prefers this
// copy over skills/orizu) never finds a half-vendored skill.
const { Effect } = await import('effect')
const vendorParent = dirname(vendorRoot)
const vendor = Effect.scoped(Effect.gen(function* () {
  mkdirSync(vendorParent, { recursive: true })
  removeStaleStaging()
  const staging = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const staging = mkdtempSync(resolve(vendorParent, STAGING_PREFIX))
      // mkdtemp makes 0700 folders; keep the permissions a plain mkdir gave before.
      chmodSync(staging, 0o755)
      return staging
    }),
    staging => Effect.sync(() => rmSync(staging, { recursive: true, force: true })),
  )
  cpSync(sourceRoot, staging, { recursive: true, filter: shouldCopyPath })
  yield* Effect.uninterruptible(Effect.sync(() => {
    rmSync(vendorRoot, { recursive: true, force: true })
    renameSync(staging, vendorRoot)
  }))
}))

const STOP_SIGNALS = ['SIGINT', 'SIGTERM']
const controller = new AbortController()
let stopSignal
const handlers = STOP_SIGNALS.map(signal => [signal, () => { stopSignal ??= signal; controller.abort() }])
for (const [signal, handler] of handlers) process.on(signal, handler)
let failure
try {
  await Effect.runPromise(vendor, { signal: controller.signal })
} catch (error) {
  failure = error
} finally {
  for (const [signal, handler] of handlers) process.off(signal, handler)
}
if (stopSignal) process.kill(process.pid, stopSignal)
else if (failure) throw failure
