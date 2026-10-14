import { existsSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isOrizuSourceCheckout } from './orizu-source-checkout.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const cliRoot = resolve(scriptDir, '..')
const repoRoot = resolve(cliRoot, '..', '..')
const packedEntrypoint = resolve(cliRoot, 'dist', 'index.js')

// A source checkout has the compiler and must always rebuild before packing so
// ignored dist cannot carry an old CLI. A published tarball has no dev compiler;
// it may be repacked only when it already carries the built entrypoint.
if (!isOrizuSourceCheckout(resolve(repoRoot, 'package.json'))) {
  if (!existsSync(packedEntrypoint)) {
    throw new Error('Unable to pack CLI: published package is missing dist/index.js')
  }
  process.exit(0)
}

// ORI-2425: in a source checkout Effect owns the build's lifetime. The build
// runs in its own process group, so a stop of the pack (SIGTERM from a
// cancelled job or a test timeout, or Ctrl-C) ends the compiler too, and the
// script then ends by that signal. The published branch above never loads it.
const { Effect } = await import('effect')
const isWindows = process.platform === 'win32'
const npm = isWindows ? 'npm.cmd' : 'npm'
const buildFailed = message => new Error(`Unable to build CLI dist before packing: ${message}`)
const build = Effect.callback(resume => {
  // stdin is not passed on: a process group outside the terminal's foreground would be stopped reading it.
  // Windows has no process groups (and detached opens a console), so there it stays attached.
  const child = spawn(npm, ['run', 'build'], { cwd: cliRoot, stdio: ['ignore', 'inherit', 'inherit'], detached: !isWindows })
  child.once('error', error => resume(Effect.fail(buildFailed(error.message))))
  child.once('close', status => resume(status === 0 ? Effect.void : Effect.fail(buildFailed('npm run build failed'))))
  // Interrupted: end the whole build group; the next pack rebuilds dist anyway.
  return Effect.sync(() => {
    try { if (isWindows) child.kill(); else process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
  })
})

const STOP_SIGNALS = ['SIGINT', 'SIGTERM']
const controller = new AbortController()
let stopSignal
const handlers = STOP_SIGNALS.map(signal => [signal, () => { stopSignal ??= signal; controller.abort() }])
for (const [signal, handler] of handlers) process.on(signal, handler)
// npm stops a pack by signalling only the shell running prepack; this script
// is then re-parented and gets no signal. A changed parent means the pack is
// gone, so stop the same way.
const parentAtStart = process.ppid
const parentWatch = setInterval(() => {
  if (process.ppid !== parentAtStart) { stopSignal ??= 'SIGTERM'; controller.abort() }
}, 200)
let failure
try {
  // Delete old compiler output first: npm pack must never retain a module whose
  // TypeScript source was renamed or removed since the previous build.
  rmSync(resolve(cliRoot, 'dist'), { recursive: true, force: true })
  await Effect.runPromise(build, { signal: controller.signal })
} catch (error) {
  failure = error
} finally {
  clearInterval(parentWatch)
  for (const [signal, handler] of handlers) process.off(signal, handler)
}
if (stopSignal) process.kill(process.pid, stopSignal)
else if (failure) throw failure
