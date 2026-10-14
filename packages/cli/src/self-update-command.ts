// `orizu update` of an npm-global install (ORI-2424). self-update.ts loads
// this only once it has found such an install, so no other command, and not
// the daily background cache refresh, loads Effect. Effect owns the children
// this starts: each runs in the command's fiber, and a stop interrupts that
// fiber, which passes the signal on to the running child and waits for it
// within the stop cap.
import { spawn } from 'child_process'
import { stderr as errorOutput, stdout as output } from 'process'

import { Cause, Effect, Exit, Fiber, Schema } from 'effect'

import { sanitizeTerminalText } from './json-response.js'
import {
  cliInvocation,
  compareSemver,
  MANUAL_INSTALL_COMMAND,
  npmInvocation,
  resolveLatest,
  resolveUpdateRegistry,
  tryWriteCache,
  type GlobalInstall,
  type SelfUpdateIo,
} from './self-update.js'

const CHILD_TIMEOUT_MS = 60_000
const STDERR_TAIL_CHARS = 4_000
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const
// The CLI's stop cap (ORI-2402) is 15 s. A stopped child gets 10 s to exit,
// then is killed; reading which version is installed gets the last 5 s.
const STOP_CHILD_WAIT_MS = 10_000
const STOP_VERSION_CHECK_MS = 5_000
const PIPE_GRACE_MS = 200

interface CommandResult { status: number; stderr: string; stdout: string; timedOut: boolean }
interface CaptureResult { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; error: Error | null; timedOut: boolean }

// What the skills refresh child reports (`orizu skills update --json`).
const SkillUpdate = Schema.Struct({
  path: Schema.String,
  action: Schema.String,
  backup: Schema.optionalKey(Schema.String),
  warning: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
})
const SkillsReport = Schema.Struct({ updates: Schema.Array(SkillUpdate) })
type SkillUpdate = typeof SkillUpdate.Type

type SkillsRefreshStatus = 'none' | 'refreshed' | 'already-current'

interface SkillsRefreshResult { status: number; timedOut: boolean; skills: SkillsRefreshStatus; updates: readonly SkillUpdate[] | null }

interface UpdateResult {
  installed: string; latest: string | null; action: string; prefix: string | null; skills: string
  skillUpdates?: readonly SkillUpdate[]
}

// Where the command is, so a stop can say what it left behind.
type UpdateStep = 'installing' | 'verifying' | 'refreshing-skills'
interface Progress { step: UpdateStep | null; install: GlobalInstall | null; latest: string | null; installedNow: string }

// A stop: its signal, and when waiting for a child must end.
interface StopState { signal: NodeJS.Signals | null; deadline: number }

function testMs(name: string, fallback: number): number {
  const override = process.env[name]
  if (override === undefined) return fallback
  const parsed = Number(override)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

const verifyTimeoutMs = () => testMs('ORIZU_UPDATE_TEST_VERIFY_TIMEOUT_MS', CHILD_TIMEOUT_MS)

// Stops reading a child's output, so a process it started that still holds
// the pipes can't keep this command waiting.
function releasePipes(child: ReturnType<typeof spawn>): void {
  child.stdout?.destroy()
  child.stderr?.destroy()
}

/**
 * Passes the stop's signal on to a running child, waits for it to exit until
 * the stop's deadline, then kills it. Runs when the command's fiber is
 * interrupted while it waits for the child. It waits for the child itself
 * ('exit'), not its output pipes ('close'): a process the child started can
 * hold those open long after the child is gone.
 */
function stopChild(child: ReturnType<typeof spawn>, stop: StopState): Effect.Effect<void> {
  return Effect.callback<void>(resume => {
    if (child.exitCode !== null || child.signalCode !== null) {
      releasePipes(child)
      resume(Effect.void)
      return
    }
    const kill = setTimeout(() => child.kill('SIGKILL'), Math.max(0, stop.deadline - Date.now()))
    child.once('exit', () => {
      clearTimeout(kill)
      releasePipes(child)
      resume(Effect.void)
    })
    child.kill(stop.signal ?? 'SIGTERM')
  })
}

function runStreaming(
  command: string,
  args: string[],
  io: SelfUpdateIo,
  stop: StopState,
  options: { timeoutMs?: number; captureStdout?: boolean } = {}
): Effect.Effect<CommandResult> {
  return Effect.callback<CommandResult>(resume => {
    let stderr = ''
    let stdout = ''
    let settled = false
    let timedOut = false
    let timer: NodeJS.Timeout | undefined
    const finish = (status: number): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resume(Effect.succeed({ status, stderr: stderr.slice(-STDERR_TAIL_CHARS), stdout, timedOut }))
    }
    const child = spawn(command, args, {
      env: { ...process.env, ORIZU_NO_UPDATE_CHECK: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, options.timeoutMs)
    }
    child.stdout?.on('data', chunk => {
      const text = sanitizeTerminalText(chunk)
      if (options.captureStdout) {
        stdout = `${stdout}${text}`
        return
      }
      if (io.json) errorOutput.write(text)
      else output.write(text)
    })
    child.stderr?.on('data', chunk => {
      const text = sanitizeTerminalText(chunk)
      stderr = `${stderr}${text}`.slice(-STDERR_TAIL_CHARS)
      errorOutput.write(text)
    })
    child.once('error', error => {
      stderr = `${stderr}${sanitizeTerminalText(error.message)}`
      finish(1)
    })
    child.once('close', code => finish(code ?? 1))
    return Effect.suspend(() => {
      if (timer) clearTimeout(timer)
      return stopChild(child, stop)
    })
  })
}

// Runs a child to completion and keeps all it said; used for version checks.
function runCaptured(command: string, args: string[], timeoutMs: number, stop: StopState | null): Effect.Effect<CaptureResult> {
  return Effect.callback<CaptureResult>(resume => {
    let stdout = ''
    let stderr = ''
    let error: Error | null = null
    let timedOut = false
    const child = spawn(command, args, {
      env: { ...process.env, ORIZU_NO_UPDATE_CHECK: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { stdout += chunk })
    child.stderr?.on('data', (chunk: string) => { stderr += chunk })
    let settled = false
    let grace: NodeJS.Timeout | undefined
    const settle = (status: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (grace) clearTimeout(grace)
      releasePipes(child)
      resume(Effect.succeed({ status, signal, stdout, stderr, error, timedOut }))
    }
    child.once('error', failure => {
      error = failure
      if (child.pid === undefined) settle(null, null)
    })
    child.once('close', (status, signal) => settle(status, signal))
    // Once the process is gone, its output gets a moment to arrive; a process
    // it started that holds the pipes doesn't extend the timeout.
    child.once('exit', (status, signal) => { grace = setTimeout(() => settle(status, signal), PIPE_GRACE_MS) })
    return Effect.suspend(() => {
      clearTimeout(timer)
      if (grace) clearTimeout(grace)
      return stop ? stopChild(child, stop) : Effect.sync(() => { child.kill('SIGKILL'); releasePipes(child) })
    })
  })
}

/**
 * Refresh managed skills through the given CLI binary and classify the outcome
 * from the child's --json report, never from its human text: an install with
 * no skill targets reports 'none', the one state a caller of `update --json`
 * most needs to see (ADR-001 coupling). The report's backups, warnings and
 * failures are passed on, in human and JSON output alike.
 */
function refreshManagedSkills(command: string, args: string[], io: SelfUpdateIo, stop: StopState): Effect.Effect<SkillsRefreshResult> {
  return Effect.gen(function* () {
    const child = yield* runStreaming(command, [...args, 'skills', 'update', '--json'], io, stop, { timeoutMs: CHILD_TIMEOUT_MS, captureStdout: true })
    const report = Schema.decodeUnknownOption(Schema.fromJsonString(SkillsReport))(child.stdout || '')
    const updates = report._tag === 'Some' ? report.value.updates : null
    if (updates !== null && !io.json) printSkillUpdates(io, updates, child.status === 0)
    if (child.status !== 0) return { status: child.status, timedOut: child.timedOut, skills: 'none', updates }
    if (updates === null) return { status: 1, timedOut: false, skills: 'none', updates }
    if (updates.length === 0) return { status: 0, timedOut: false, skills: 'none', updates }
    const refreshed = updates.some(update => update.action !== 'already-current')
    return { status: 0, timedOut: false, skills: refreshed ? 'refreshed' : 'already-current', updates }
  })
}

// The same lines `orizu skills update` prints for each install.
function printSkillUpdates(io: SelfUpdateIo, updates: readonly SkillUpdate[], succeeded: boolean): void {
  if (updates.length === 0 && succeeded) io.printLine('No Orizu skill installs found. Run `orizu install-skill` first.')
  for (const update of updates) {
    const path = sanitizeTerminalText(update.path)
    const backup = update.backup ? `; moved your earlier folder to ${sanitizeTerminalText(update.backup)}` : ''
    if (update.action === 'already-current') io.printLine(`Current ${path}`)
    else if (update.action === 'relinked') io.printLine(`Relinked ${path}`)
    else if (update.action === 'rewrote') io.printLine(`Rewrote ${path} from the installed CLI skill${backup}`)
    else if (update.action === 'failed') io.printLine(`Failed ${path}: ${sanitizeTerminalText(update.error ?? 'unknown error')}`)
    else io.printLine(`Updated ${path}${backup}`)
    if (update.warning) io.printLine(`Warning: ${sanitizeTerminalText(update.warning)}`)
  }
}

function withSkillUpdates(result: UpdateResult, skills: SkillsRefreshResult): UpdateResult {
  return skills.updates === null ? result : { ...result, skillUpdates: skills.updates }
}

function emit(io: SelfUpdateIo, result: UpdateResult): void {
  if (io.json) io.printLine(JSON.stringify(result))
}

function fail(io: SelfUpdateIo, code: string, detail: string, result: UpdateResult): number {
  io.printError(`${code}: ${detail}`)
  emit(io, result)
  return 1
}

function selfUpdate(io: SelfUpdateIo, install: GlobalInstall, progress: Progress, stop: StopState): Effect.Effect<number> {
  return Effect.gen(function* () {
    progress.install = install

    const checked = yield* Effect.promise(async () => {
      try {
        const registry = resolveUpdateRegistry()
        const latest = await resolveLatest(registry)
        tryWriteCache(latest)
        return { ok: true as const, registry, latest }
      } catch (error) {
        return { ok: false as const, error }
      }
    })
    if (!checked.ok) {
      const { error } = checked
      return fail(io, 'update_check_failed', sanitizeTerminalText(error instanceof Error ? error.message : error), {
        installed: io.installed, latest: null, action: 'check-failed', prefix: install.prefix, skills: 'not-run',
      })
    }
    const { latest, registry } = checked
    progress.latest = latest

    if (compareSemver(io.installed, latest) >= 0) {
      if (!io.json) io.printLine(`orizu ${io.installed} is already the latest.`)
      if (io.dryRun) {
        emit(io, { installed: io.installed, latest, action: 'already-latest', prefix: install.prefix, skills: 'not-run' })
        return 0
      }
      progress.step = 'refreshing-skills'
      const skills = yield* refreshManagedSkills(install.binPath, [], io, stop)
      progress.step = null
      if (skills.status !== 0) {
        const detail = skills.timedOut
          ? 'orizu is already the latest, but its managed skills refresh timed out.'
          : 'orizu is already the latest, but its managed skills could not be refreshed.'
        return fail(io, 'update_skills_refresh_failed', detail, withSkillUpdates({
          installed: io.installed, latest, action: 'already-latest', prefix: install.prefix, skills: 'refresh-failed',
        }, skills))
      }
      emit(io, withSkillUpdates({ installed: io.installed, latest, action: 'already-latest', prefix: install.prefix, skills: skills.skills }, skills))
      return 0
    }

    if (io.dryRun) {
      if (!io.json) io.printLine(`Would update orizu ${io.installed} → ${latest} in ${install.prefix}.`)
      emit(io, { installed: io.installed, latest, action: 'would-update', prefix: install.prefix, skills: 'would-refresh' })
      return 0
    }

    const npmCommand = npmInvocation()
    const registryArgs = process.env.ORIZU_UPDATE_REGISTRY !== undefined
      ? ['--registry', registry]
      : []
    progress.step = 'installing'
    const npm = yield* runStreaming(npmCommand.command, [...npmCommand.args,
      'install', '-g', `orizu@${latest}`, '--prefix', install.prefix, '--no-audit', '--no-fund',
      ...registryArgs,
    ], io, stop)
    progress.step = null
    if (npm.status !== 0) {
      const tail = npm.stderr.trim() ? ` npm stderr tail: ${npm.stderr.trim()}` : ''
      return fail(io, 'update_install_failed', `${tail} Run \`${MANUAL_INSTALL_COMMAND}\`.`, {
        installed: io.installed, latest, action: 'install-failed', prefix: install.prefix, skills: 'not-run',
      })
    }

    const verifyCommand = cliInvocation(install, ['--version'])
    const verificationTimeoutMs = verifyTimeoutMs()
    progress.step = 'verifying'
    const verified = yield* runCaptured(verifyCommand.command, verifyCommand.args, verificationTimeoutMs, stop)
    progress.step = null
    const observed = sanitizeTerminalText(verified.stdout).trim()
    if (verified.timedOut) {
      return fail(io, 'update_verify_mismatch', `verification timed out after ${verificationTimeoutMs} ms.`, {
        installed: io.installed, latest, action: 'verify-mismatch', prefix: install.prefix, skills: 'not-run',
      })
    }
    if (verified.status !== 0 || observed !== `orizu ${latest}`) {
      const launchError = verified.error ? ` launch error: ${sanitizeTerminalText(verified.error.message)}.` : ''
      const exit = verified.status === null ? `signal ${verified.signal ?? 'unknown'}` : `exit ${verified.status}`
      const errorTail = sanitizeTerminalText(verified.stderr).trim().split('\n').slice(-3).join(' ')
      const detail = `expected orizu ${latest}, observed ${observed || '<no version>'} (${exit}).${launchError}${errorTail ? ` ${errorTail}` : ''}`
      return fail(io, 'update_verify_mismatch', `${detail} Run \`${MANUAL_INSTALL_COMMAND}\` to reinstall.`, {
        installed: io.installed, latest, action: 'verify-mismatch', prefix: install.prefix, skills: 'not-run',
      })
    }
    progress.installedNow = latest

    if (!io.json) io.printLine(`orizu ${latest} installed.`)
    const skillsCommand = cliInvocation(install, [])
    progress.step = 'refreshing-skills'
    const skills = yield* refreshManagedSkills(skillsCommand.command, skillsCommand.args, io, stop)
    progress.step = null
    if (skills.status !== 0) {
      const detail = skills.timedOut
        ? 'the CLI was updated, but its managed skills refresh timed out.'
        : 'the CLI was updated, but its managed skills could not be refreshed.'
      return fail(io, 'update_skills_refresh_failed', detail, withSkillUpdates({
        installed: io.installed, latest, action: 'updated', prefix: install.prefix, skills: 'refresh-failed',
      }, skills))
    }
    emit(io, withSkillUpdates({ installed: io.installed, latest, action: 'updated', prefix: install.prefix, skills: skills.skills }, skills))
    return 0
  })
}

// After a stop: which orizu the global install runs now, read once in the stop cap's last 5 s.
async function installedVersionAfterStop(install: GlobalInstall): Promise<string | null> {
  const command = cliInvocation(install, ['--version'])
  const checked = await Effect.runPromise(runCaptured(command.command, command.args, STOP_VERSION_CHECK_MS, null))
  const match = /^orizu (\S+)$/u.exec(sanitizeTerminalText(checked.stdout).trim())
  return checked.status === 0 && match ? match[1]! : null
}

async function reportStop(io: SelfUpdateIo, progress: Progress): Promise<void> {
  const { step, install, latest } = progress
  if (!step || !install || !latest) return
  if (step === 'refreshing-skills') {
    io.printError(`update_stopped: stopped while refreshing the managed skills. orizu ${progress.installedNow} is installed now. Run \`orizu skills update\` to finish the refresh.`)
    emit(io, { installed: io.installed, latest, action: 'stopped', prefix: install.prefix, skills: 'refresh-stopped' })
    return
  }
  const now = await installedVersionAfterStop(install)
  const doing = step === 'installing' ? `npm was installing orizu ${latest}` : `checking the new orizu ${latest}`
  const state = now ? `orizu ${now} is installed now.` : 'Could not tell which orizu is installed now.'
  io.printError(`update_stopped: stopped while ${doing}. ${state} Run \`${MANUAL_INSTALL_COMMAND}\` to finish the update.`)
  emit(io, { installed: io.installed, latest, action: 'stopped', prefix: install.prefix, skills: 'not-run' })
}

/**
 * Runs the update with stop handlers installed for exactly its duration. A
 * stop interrupts it: the running child gets the same signal and the stop cap
 * to exit, the command says what is installed now, then ends by that signal.
 */
export async function runSelfUpdate(io: SelfUpdateIo, install: GlobalInstall): Promise<number> {
  const progress: Progress = { step: null, install: null, latest: null, installedNow: io.installed }
  const stop: StopState = { signal: null, deadline: 0 }
  // eslint-disable-next-line prefer-const -- assigned after the handlers that read it
  let fiber: Fiber.Fiber<number>
  const handlers = STOP_SIGNALS.map(signal => ({
    signal,
    handle: () => {
      if (stop.signal) return
      stop.signal = signal
      stop.deadline = Date.now() + testMs('ORIZU_UPDATE_TEST_STOP_WAIT_MS', STOP_CHILD_WAIT_MS)
      void Effect.runPromise(Fiber.interrupt(fiber))
    },
  }))
  const removeHandlers = () => { for (const entry of handlers) process.off(entry.signal, entry.handle) }
  for (const entry of handlers) process.on(entry.signal, entry.handle)
  fiber = Effect.runFork(selfUpdate(io, install, progress, stop))
  try {
    const exit = await Effect.runPromise(Effect.exit(Fiber.join(fiber)))
    if (stop.signal) {
      await reportStop(io, progress)
      removeHandlers()
      process.kill(process.pid, stop.signal)
      return await new Promise<never>(() => {})
    }
    if (Exit.isSuccess(exit)) return exit.value
    throw Cause.squash(exit.cause)
  } finally {
    removeHandlers()
  }
}
