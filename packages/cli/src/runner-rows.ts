import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect } from 'effect'

import { removeOnClose, type RemovalLedger } from './runner-folders.js'

// ORI-2727: the runner processes and temp folders that `runners exec` and
// `scorers verify-parity` start for each row (and verify-parity's one bridge
// process). Loaded only through `await import(...)` by those two commands.

/** After SIGTERM, how long a runner gets to stop before it is killed. */
const STOP_GRACE_MS = 5_000

/** A temp folder the surrounding scope removes, however the scope ends. */
export function rowFolder(ledger: RemovalLedger, prefix: string) {
  return Effect.gen(function* () {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    yield* removeOnClose(ledger, 'other', () => rmSync(dir, { recursive: true, force: true }))
    return dir
  })
}

export interface RowProcessInput {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  maxOutputBytes: number
  /** The failure for a process past `timeoutMs`, for example "Runner timed out for row one after 120 s". */
  timedOut: string
  /** The failure for stdout or stderr over `maxOutputBytes`. */
  overLimit: string
}

export interface RowProcessResult {
  status: number | null
  stdout: string
  stderr: string
}

export const seconds = (ms: number) => `${ms / 1000} s`

const groupAlive = (pid: number) => { try { process.kill(-pid, 0); return true } catch { return false } }

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null

/** Waits up to `ms` for the process to exit; true when it has. */
function waitForExit(child: ChildProcess, ms: number) {
  if (exited(child)) return Promise.resolve(true)
  return new Promise<boolean>(resolve => {
    const timer = setTimeout(() => { child.off('exit', done); resolve(false) }, ms)
    function done() { clearTimeout(timer); resolve(true) }
    child.once('exit', done)
  })
}

/**
 * Stops the process and everything it started: SIGTERM, then SIGKILL after the
 * grace. Off Windows it has its own process group, so the signals go to the
 * group. Windows has no process groups to signal (`process.kill(-pid)` throws),
 * so there the process itself is killed, as `artifacts-git-runtime.ts` does.
 */
export async function stopProcess(child: ChildProcess, platform: NodeJS.Platform = process.platform, graceMs = STOP_GRACE_MS) {
  const pid = child.pid
  if (pid === undefined) return
  if (platform === 'win32') {
    if (exited(child)) return
    child.kill('SIGTERM')
    if (await waitForExit(child, graceMs)) return
    child.kill('SIGKILL')
    await waitForExit(child, graceMs)
    return
  }
  if (!groupAlive(pid)) return
  try { process.kill(-pid, 'SIGTERM') } catch { return }
  const until = Date.now() + graceMs
  while (Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, 50))
    if (!groupAlive(pid)) return
  }
  try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ }
}

/**
 * Runs one process to its end with a time limit and an output cap. The process
 * gets its own group (off Windows), so ending the scope (finished, failed, over its limit or
 * interrupted by a stop) also stops any child it left running.
 */
export function rowProcess(input: RowProcessInput) {
  return Effect.acquireRelease(
    Effect.sync(() => spawn(input.command, input.args, { cwd: input.cwd, env: input.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })),
    child => Effect.promise(() => stopProcess(child)),
  ).pipe(Effect.flatMap(child => Effect.callback<RowProcessResult, Error>(resume => {
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false
    const settle = (effect: Effect.Effect<RowProcessResult, Error>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resume(effect)
    }
    const collect = (chunks: Buffer[]) => {
      let size = 0
      return (chunk: Buffer) => {
        size += chunk.byteLength
        if (size > input.maxOutputBytes) settle(Effect.fail(new Error(input.overLimit)))
        else chunks.push(chunk)
      }
    }
    const timer = setTimeout(() => settle(Effect.fail(new Error(input.timedOut))), input.timeoutMs)
    child.stdout!.on('data', collect(stdout))
    child.stderr!.on('data', collect(stderr))
    child.on('error', error => settle(Effect.fail(error)))
    child.on('close', status => settle(Effect.succeed({
      status,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    })))
    return Effect.sync(() => clearTimeout(timer))
  })))
}
