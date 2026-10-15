/**
 * Workspace session/run visibility commands (ALI-902 CLI half).
 *
 * Pure logic + injected HTTP: command functions do not parse process.argv and
 * do not print. The thin `workbenchCommand` entry point owns CLI argument
 * parsing and human/JSON output.
 */

import { findUnknownOption } from './option-validation.js'
import { formatRunEventDigest } from './run-event-digest.js'
import type { StartIntentIdGenerator } from './start-intent.js'
import type { StoppableOutcome } from './workbench-workflows.js'

export interface WorkbenchFetcher {
  (path: string, init?: RequestInit): Promise<Response>
}

export interface WorkbenchSleep {
  (ms: number): Promise<void>
}

// Per-run model cost/token totals (ALI-1089), aggregated server-side from
// agent_step_finish event payloads. Null/absent = "no cost data reported"
// (distinct from a genuine $0 run).
export interface WorkbenchRunCosts {
  modelCostUsd?: number | null
  tokensInput?: number | null
  tokensOutput?: number | null
  tokensCacheRead?: number | null
  tokensCacheWrite?: number | null
  tokensReasoning?: number | null
  costUpdatedAt?: string | null
}

export interface WorkbenchRunSummary extends WorkbenchRunCosts {
  id: string
  status: string
  /** Why a failed run failed, in plain words, mapped by the server (ORI-2264). */
  failureReason?: string
}

export interface WorkbenchSession {
  id: string
  workspaceId?: string
  projectId?: string | null
  actorUserId?: string
  actorType?: string
  status: string
  clientInfo?: Record<string, unknown>
  startedAt?: string | null
  endedAt?: string | null
  createdAt?: string
  updatedAt?: string
  runs?: WorkbenchRunSummary[]
  /** Session rollup: sum of the runs' server-aggregated cost totals (ALI-1089). */
  costs?: WorkbenchRunCosts
  [key: string]: unknown
}

export interface WorkbenchRun extends WorkbenchRunCosts {
  id: string
  workspaceSessionId?: string
  workspaceId?: string
  projectId?: string | null
  actorUserId?: string
  actorType?: string
  title?: string
  status: string
  evidence?: Record<string, unknown>
  summary?: Record<string, unknown>
  /** Why a failed run failed, in plain words, mapped by the server (ORI-2264). */
  failureReason?: string
  latestSequence?: number
  startedAt?: string | null
  finishedAt?: string | null
  createdAt?: string
  updatedAt?: string
  [key: string]: unknown
}

export interface WorkbenchRunEvent {
  sequence: number
  eventId: string
  eventType: string
  occurredAt?: string | null
  payload?: Record<string, unknown>
  [key: string]: unknown
}

export interface CommonWorkbenchOptions {
  fetcher?: WorkbenchFetcher
  cwd?: string
}

// -- Local session-branch ergonomics (ALI-1028) ------------------------------
// `session start` cuts `orizu/session-<id>` REMOTELY; a human still needs the
// branch fetched + checked out locally, exact next commands, and a finish-time
// warning when local work has not reached the remote branch. All of it is
// best-effort convenience for the NON-hosted human path: git failures degrade
// to hints, never to a failed session command (except the explicit opt-in
// `finish --push`, which must fail loudly rather than silently drop work).

export interface SessionGitResult {
  status: number
  stdout: string
  stderr: string
}

/** Injectable git seam (tests use a recording fake; prod spawns git). */
export type SessionGitRunner = (args: string[], opts?: { cwd?: string }) => SessionGitResult

export interface SessionCheckout {
  branch: string
  state: 'checked-out' | 'skipped'
  detail: string
}

export interface SessionBranchSync {
  branch: string
  /** Local-only commit count vs origin/<branch>; null when not computable. */
  ahead: number | null
  /** origin/<branch>-only commit count; null when not computable. */
  behind: number | null
}

export interface SessionStartOptions extends CommonWorkbenchOptions {
  workspaceId?: string | null
  projectSlug?: string | null
  clientInfo?: Record<string, unknown>
  git?: SessionGitRunner
  /**
   * Opt-in local ergonomics (ALI-1028): fetch + check out the session branch
   * when cwd is the workbench clone. Off by default so library callers (e.g.
   * smoke) never mutate the local checkout; the human CLI path turns it on.
   */
  localCheckout?: boolean
  /** Injectable bounded repository-readiness delay for tests. */
  sleep?: WorkbenchSleep
  /** Injectable UUIDv4 generator; one value is replayed for every retry. */
  generateStartIntentId?: StartIntentIdGenerator
  /** Existing immutable intent when resuming a bounded pending start. */
  startIntentId?: string | null
  /** Existing session bound to startIntentId when resuming provisioning. */
  reconcileSessionId?: string | null
}

export interface SessionStatusOptions extends CommonWorkbenchOptions {
  workspaceId?: string | null
  sessionId?: string | null
  status?: string | null
  git?: SessionGitRunner
}

export interface SessionEndOptions {
  fetcher?: WorkbenchFetcher
  sessionId: string
}

export interface SessionFinishOptions {
  fetcher?: WorkbenchFetcher
  sessionId: string
  projectSlug?: string | null
  cwd?: string
  git?: SessionGitRunner
  /** Opt-in: stage/commit/push local session-branch work before finishing. */
  push?: boolean
  /** Commit message for --push; a default is used when omitted. */
  message?: string | null
}

export interface SessionFinishResult {
  outcome: string
  branch?: string
  branchDeleted?: boolean
  manifest?: Record<string, unknown>
  /** Local uncommitted/unpushed work detected at finish time (ALI-1028). */
  localWarnings?: string[]
  /** True when --push staged/committed/pushed local work before finishing. */
  pushed?: boolean
}

export interface SessionStartResult {
  session: WorkbenchSession
  /** Local checkout attempt for the session branch; null when the session has no branch. */
  checkout?: SessionCheckout | null
}

/** A bounded repository wait exhausted without losing the immutable identity
 * needed to resume safely. CLI callers can show the command; library callers
 * can use the structured fields directly. */
export class SessionRepositoryPendingError extends Error {
  readonly sessionId: string
  readonly startIntentId: string
  readonly resumeCommand: string

  constructor(input: {
    readonly sessionId: string
    readonly startIntentId: string
    readonly projectSlug: string | null
    readonly workspaceDirectory: string | null
  }) {
    const quoteForShell = (value: string): string =>
      `'${value.replaceAll("'", "'\"'\"'")}'`
    const projectArg = input.projectSlug
      ? ` --project ${quoteForShell(input.projectSlug)}`
      : ''
    const workspaceArg = input.workspaceDirectory
      ? ` --workspace ${quoteForShell(input.workspaceDirectory)}`
      : ''
    const resumeCommand =
      `orizu session start --start-intent ${quoteForShell(input.startIntentId)}` +
      ` --session ${quoteForShell(input.sessionId)}${projectArg}${workspaceArg}`
    super(
      'Session repository is still provisioning after the bounded retry window. ' +
        `Resume the same session without creating a duplicate: ${resumeCommand}`
    )
    this.name = 'SessionRepositoryPendingError'
    this.sessionId = input.sessionId
    this.startIntentId = input.startIntentId
    this.resumeCommand = resumeCommand
  }
}

export interface SessionStatusResult {
  session?: WorkbenchSession
  sessions?: WorkbenchSession[]
  /** Local ahead/behind vs the remote session branch (single-session status only). */
  branchSync?: SessionBranchSync | null
}

export interface SessionEndResult {
  session: WorkbenchSession
  branchStatus?: string
}

export interface WorkbenchRunStartOptions {
  fetcher?: WorkbenchFetcher
  sessionId: string
  title: string
  projectSlug?: string | null
}

export interface WorkbenchRunStatusOptions {
  fetcher?: WorkbenchFetcher
  runId: string
}

export interface WorkbenchRunTerminalOptions {
  fetcher?: WorkbenchFetcher
  runId: string
  status: string
  summary?: string | null
  evidence?: Record<string, unknown> | null
}

export interface WorkbenchRunResult {
  run: WorkbenchRun
}

export interface TailOnceResult {
  events: WorkbenchRunEvent[]
  cursor: number
  runStatus: string
}

export interface TailWorkbenchRunOptions {
  fetcher?: WorkbenchFetcher
  runId: string
  after?: number
  limit?: number
  intervalSeconds?: number
  once?: boolean
  sleep?: WorkbenchSleep
  onEvent?: (event: WorkbenchRunEvent) => void
}

export interface WorkbenchCommandIo {
  json: boolean
  print: (line: string) => void
  fetcher?: WorkbenchFetcher
  sleep?: WorkbenchSleep
  /** Injectable git for the session-branch ergonomics (ALI-1028). */
  git?: SessionGitRunner
  /** Test seam for the session-start idempotency UUID. */
  generateStartIntentId?: StartIntentIdGenerator
}

const SESSION_STATUSES = new Set(['active', 'ended'])
const SESSION_START_OPTIONS = new Set([
  '--project',
  '--workspace',
  '--start-intent',
  '--session',
  '--json',
])
const SESSION_PUBLISH_OPTIONS = new Set(['--message', '--json'])
const WORKBENCH_VALUE_OPTIONS = new Set([
  '--after',
  '--interval',
  '--message',
  '--project',
  '--run',
  '--session',
  '--status',
  '--start-intent',
  '--summary',
  '--title',
  '--workspace',
])

export const SESSION_REPOSITORY_PENDING_RETRY_MS = 2_000
export const SESSION_REPOSITORY_PENDING_MAX_RETRIES = 30

// The workflows run on Effect in workbench-workflows (ORI-2734), loaded only
// when a command runs, so CLI startup and the hosted session CLI never load
// Effect. These exports keep their signatures and add no stop handlers.
const workflows = () => import('./workbench-workflows.js')

export async function runSessionStart(opts: SessionStartOptions = {}): Promise<SessionStartResult> {
  const { runPlain, sessionStart } = await workflows()
  return runPlain(sessionStart(opts))
}

export async function runSessionStatus(opts: SessionStatusOptions = {}): Promise<SessionStatusResult> {
  const { runPlain, sessionStatus } = await workflows()
  return runPlain(sessionStatus(opts))
}

export async function runSessionEnd(opts: SessionEndOptions): Promise<SessionEndResult> {
  const { runPlain, sessionEnd } = await workflows()
  return runPlain(sessionEnd(opts))
}

export async function runSessionFinish(opts: SessionFinishOptions): Promise<SessionFinishResult> {
  const { runPlain, sessionFinish } = await workflows()
  return runPlain(sessionFinish(opts))
}

export async function runWorkbenchRunStart(opts: WorkbenchRunStartOptions): Promise<WorkbenchRunResult> {
  const { runPlain, runStart } = await workflows()
  return runPlain(runStart(opts))
}

export async function runWorkbenchRunStatus(opts: WorkbenchRunStatusOptions): Promise<WorkbenchRunResult> {
  const { runPlain, runStatus } = await workflows()
  return runPlain(runStatus(opts))
}

export async function runWorkbenchRunTerminal(opts: WorkbenchRunTerminalOptions): Promise<WorkbenchRunResult> {
  const { runPlain, runTerminal } = await workflows()
  return runPlain(runTerminal(opts))
}

export async function tailOnce(
  fetcher: WorkbenchFetcher,
  runId: string,
  cursor: number,
  limit?: number
): Promise<TailOnceResult> {
  const workflow = await workflows()
  return workflow.runPlain(workflow.tailOnce(fetcher, runId, cursor, limit))
}

/** Also the hosted session CLI's attached tail: same signature, no stop handlers. */
export async function tailWorkbenchRun(opts: TailWorkbenchRunOptions): Promise<TailOnceResult> {
  const { runPlain, tail } = await workflows()
  return runPlain(tail(opts))
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag)
}

function argValue(args: string[], flag: string): string | null {
  const inlinePrefix = `${flag}=`
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg.startsWith(inlinePrefix)) {
      return arg.slice(inlinePrefix.length)
    }
    if (arg === flag) {
      return index + 1 < args.length && !args[index + 1].startsWith('--')
        ? args[index + 1]
        : null
    }
  }
  return null
}

function numberArg(args: string[], flag: string): number | undefined {
  const raw = argValue(args, flag)
  if (!raw) {
    return undefined
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

function positionalArgs(args: string[]): string[] {
  const values: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg.startsWith('--')) {
      if (!arg.includes('=') && WORKBENCH_VALUE_OPTIONS.has(arg) && argValue(args.slice(i), arg) !== null) {
        i += 1
      }
      continue
    }
    values.push(arg)
  }
  return values
}

function emit(io: WorkbenchCommandIo, human: string, payload: Record<string, unknown>) {
  io.print(io.json ? JSON.stringify(payload) : human)
}

/**
 * Human output for `session start`: always name the branch and the exact next
 * commands (ALI-1028) — checked-out, skipped-with-hint, or no-branch.
 */
function formatSessionStart(result: SessionStartResult): string {
  const lines = [`session started: ${result.session.id}`]
  const checkout = result.checkout
  if (checkout) {
    if (checkout.state === 'checked-out') {
      lines.push(`branch: ${checkout.branch} (checked out locally, ${checkout.detail})`)
    } else {
      lines.push(`branch: ${checkout.branch} (not checked out locally: ${checkout.detail})`)
      lines.push(`  check it out with: git fetch origin ${checkout.branch} && git checkout ${checkout.branch}`)
    }
    lines.push('next steps:')
    lines.push('  git add <files> && git commit -m "<what changed>"')
    lines.push(`  git push origin ${checkout.branch}`)
    lines.push(`  orizu session finish --session ${result.session.id}`)
  }
  return lines.join('\n')
}

// -- Cost/duration rendering (ALI-1089) ---------------------------------------

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`
}

/** `tokens: in 2, out 181, cache-read 126968, ...` — only the reported fields. */
function formatTokenBreakdown(costs: WorkbenchRunCosts): string | null {
  const parts: string[] = []
  const push = (label: string, value: unknown) => {
    const parsed = finiteOrNull(value)
    if (parsed !== null) {
      parts.push(`${label} ${parsed}`)
    }
  }
  push('in', costs.tokensInput)
  push('out', costs.tokensOutput)
  push('cache-read', costs.tokensCacheRead)
  push('cache-write', costs.tokensCacheWrite)
  push('reasoning', costs.tokensReasoning)
  return parts.length > 0 ? `tokens: ${parts.join(', ')}` : null
}

/** `cost $0.0697  tokens: ...` or null when nothing was reported. */
function formatCostSummary(costs: WorkbenchRunCosts): string | null {
  const cost = finiteOrNull(costs.modelCostUsd)
  const tokens = formatTokenBreakdown(costs)
  if (cost === null && tokens === null) {
    return null
  }
  const parts: string[] = []
  if (cost !== null) {
    parts.push(`cost ${formatUsd(cost)}`)
  }
  if (tokens) {
    parts.push(tokens)
  }
  return parts.join('  ')
}

function formatDurationMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

/**
 * Session wall-clock from the existing startedAt/endedAt columns — no cost
 * math, just duration (infra $ estimation is a later phase). Active sessions
 * measure up to `now` and say so.
 */
function formatSessionDuration(session: WorkbenchSession, now = Date.now()): string | null {
  const startedAt = typeof session.startedAt === 'string' ? Date.parse(session.startedAt) : Number.NaN
  if (!Number.isFinite(startedAt)) {
    return null
  }
  const endedAt = typeof session.endedAt === 'string' ? Date.parse(session.endedAt) : Number.NaN
  return Number.isFinite(endedAt)
    ? `duration ${formatDurationMs(endedAt - startedAt)}`
    : `duration ${formatDurationMs(now - startedAt)} (so far)`
}

function formatSessionStatus(result: SessionStatusResult): string {
  if (result.session) {
    const lines = [`session ${result.session.id}  ${result.session.status}`]
    const duration = formatSessionDuration(result.session)
    if (duration) {
      lines.push(`  ${duration}`)
    }
    const rollup = result.session.costs ? formatCostSummary(result.session.costs) : null
    if (rollup) {
      lines.push(`  ${rollup}`)
    }
    const sync = result.branchSync
    if (sync) {
      lines.push(
        sync.ahead !== null && sync.behind !== null
          ? `  branch ${sync.branch}  ahead ${sync.ahead}, behind ${sync.behind} (vs origin/${sync.branch})`
          : `  branch ${sync.branch}`
      )
    }
    for (const run of result.session.runs ?? []) {
      const cost = finiteOrNull(run.modelCostUsd)
      const suffix = cost !== null ? `  ${formatUsd(cost)}` : ''
      lines.push(`  run ${run.id}  ${run.status}${suffix}`)
      const why = failedRunLine(run)
      if (why) lines.push(`    ${why}`)
    }
    return lines.join('\n')
  }
  const sessions = result.sessions ?? []
  return ['workspace sessions', ...sessions.map(session => `${session.id}  ${session.status}`)].join('\n')
}

function formatSessionFinish(result: SessionFinishResult): string {
  const prefix: string[] = []
  for (const warning of result.localWarnings ?? []) {
    prefix.push(`warning: ${warning}`)
  }
  if (result.pushed) {
    prefix.push('pushed local session-branch work to origin before finishing')
  }
  return prefix.length > 0
    ? `${prefix.join('\n')}\n${formatSessionFinishOutcome(result)}`
    : formatSessionFinishOutcome(result)
}

function formatSessionFinishOutcome(result: SessionFinishResult): string {
  if (result.outcome === 'no-changes') {
    const branch = result.branch ?? 'the session branch'
    return result.branchDeleted === false
      ? `no changes on ${branch}; branch NOT deleted (delete it manually or retry \`orizu session finish\`)`
      : `no changes on ${branch}; branch deleted`
  }
  const manifest = result.manifest ?? {}
  const id = typeof manifest.id === 'string' ? manifest.id : '(unknown)'
  const status = typeof manifest.status === 'string' ? manifest.status : '(unknown)'
  const proposed = (manifest.proposedState ?? {}) as Record<string, unknown>
  const files = typeof proposed.filesChanged === 'number' ? proposed.filesChanged : 0
  const additions = typeof proposed.additions === 'number' ? proposed.additions : 0
  const deletions = typeof proposed.deletions === 'number' ? proposed.deletions : 0
  return `manifest ${id}  ${status}  repo_merge  (${files} files, +${additions}/-${deletions})`
}

// The web page's failed line, with the reason the server mapped (ORI-2264).
function failedRunLine(run: { status: string; failureReason?: unknown }): string | null {
  return run.status === 'failed' && typeof run.failureReason === 'string' && run.failureReason
    ? run.failureReason === 'The selected model is unavailable in this session.' ? run.failureReason : `The agent stopped: ${run.failureReason}.`
    : null
}

function formatRunStatus(run: WorkbenchRun): string {
  const sequence = typeof run.latestSequence === 'number' ? `  latestSequence=${run.latestSequence}` : ''
  const costLine = formatCostSummary(run)
  const why = failedRunLine(run)
  return `run ${run.id}  ${run.status}${sequence}${costLine ? `\n  ${costLine}` : ''}${why ? `\n  ${why}` : ''}`
}

// ALI-1045: one compact digest line per event — shared with the attached
// `session start --hosted --tail` stream. Full fidelity stays in `--json`.
function formatEventLine(event: WorkbenchRunEvent): string {
  return formatRunEventDigest(event)
}

function terminalStatusForCommand(command: string): string | null {
  if (command === 'complete') return 'succeeded'
  if (command === 'fail') return 'failed'
  if (command === 'cancel') return 'cancelled'
  return null
}

const USAGE_LINE =
  'Usage: orizu session <start|status|end|finish|publish> ... | orizu run <start|status|tail|complete|fail|cancel> ...  (run tail --once drains all currently persisted events, then exits without following)'

// In --json mode ANY command failure — bad usage, or an operational failure
// such as a 401/403/404/409/network error surfaced by assertOk — must still
// land as a single machine-readable document (`{"error": ...}`) on stdout,
// never human help text and never a plain-text message on stderr. An agent
// parsing --json stdout should never have to also watch stderr for the most
// common failure modes. Non-JSON mode is unchanged: the message prints as-is.
// Stack traces are never printed either way (only `error.message`).
function emitJsonError(io: WorkbenchCommandIo, message: string): number {
  io.print(io.json ? JSON.stringify({ error: message }) : message)
  return 1
}

export async function workbenchCommand(args: string[], io: WorkbenchCommandIo): Promise<number> {
  try {
    return await dispatchWorkbenchCommand(args, io)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (io.json) {
      if (error instanceof SessionRepositoryPendingError) {
        io.print(
          JSON.stringify({
            error: message,
            sessionId: error.sessionId,
            startIntentId: error.startIntentId,
            resumeCommand: error.resumeCommand,
          })
        )
        return 1
      }
      return emitJsonError(io, message)
    }
    throw error
  }
}

/**
 * Ctrl-C (130) and SIGTERM (143) end a local command's waits and reads. A
 * write already sent finishes and its reply prints before the stop's exit
 * code. A session start stopped while its repository is pending prints how to
 * resume it.
 */
function finishStoppable<A>(io: WorkbenchCommandIo, outcome: StoppableOutcome<A>, print: (value: A) => void): number {
  if ('value' in outcome) {
    print(outcome.value)
    return outcome.interrupted ?? 0
  }
  if (outcome.pending) {
    const { sessionId, startIntentId, resumeCommand } = new SessionRepositoryPendingError(outcome.pending)
    const message =
      'Session start interrupted while its repository is still provisioning. ' +
      `Resume the same session without creating a duplicate: ${resumeCommand}`
    io.print(io.json ? JSON.stringify({ error: message, sessionId, startIntentId, resumeCommand }) : message)
  }
  return outcome.interrupted
}

async function dispatchWorkbenchCommand(args: string[], io: WorkbenchCommandIo): Promise<number> {
  const positional = positionalArgs(args)
  const group = positional[0]
  const subcommand = positional[1]
  const fetcher = io.fetcher

  if (group === 'session') {
    // `--workspace <dir>`: the workbench clone directory when the command is
    // not run from inside it (defaults to cwd).
    const workspaceDir = argValue(args, '--workspace') ?? undefined
    if (subcommand === 'publish') {
      const unknownOption = findUnknownOption(args, SESSION_PUBLISH_OPTIONS, WORKBENCH_VALUE_OPTIONS)
      if (unknownOption) {
        return emitJsonError(io, `unknown option ${unknownOption}\nUsage: orizu session publish [--message <text>] [--json]`)
      }
      const stray = positional[2]
      if (stray !== undefined) {
        return emitJsonError(io, `unexpected argument ${stray}\nUsage: orizu session publish [--message <text>] [--json]`)
      }
      const { runSessionPublish } = await import('./session-publish.js')
      return runSessionPublish(io, { message: argValue(args, '--message') })
    }
    if (subcommand === 'start') {
      const unknownOption = findUnknownOption(args, SESSION_START_OPTIONS, WORKBENCH_VALUE_OPTIONS)
      if (unknownOption) {
        return emitJsonError(
          io,
          `unknown option ${unknownOption}\nUsage: orizu session start [--project <team/project>] [--workspace <dir>] [--start-intent <uuid> --session <uuid>] [--json]`
        )
      }
      const { runStoppable, sessionStart } = await workflows()
      const outcome = await runStoppable<SessionStartResult>((settled, stop) => sessionStart({
        fetcher,
        cwd: workspaceDir,
        git: io.git,
        localCheckout: true,
        projectSlug: argValue(args, '--project'),
        startIntentId: argValue(args, '--start-intent'),
        reconcileSessionId: argValue(args, '--session'),
        clientInfo: { source: 'orizu-cli' },
        generateStartIntentId: io.generateStartIntentId,
        sleep: io.sleep,
      }, settled, stop))
      return finishStoppable(io, outcome, result => emit(io, formatSessionStart(result), result as unknown as Record<string, unknown>))
    }
    if (subcommand === 'status') {
      const status = argValue(args, '--status')
      if (status && !SESSION_STATUSES.has(status)) {
        throw new Error('Usage: orizu session status [--session <id> | --status active|ended] [--json]')
      }
      const { runStoppable, sessionStatus } = await workflows()
      const outcome = await runStoppable<SessionStatusResult>(() => sessionStatus({
        fetcher,
        cwd: workspaceDir,
        git: io.git,
        sessionId: argValue(args, '--session'),
        status,
      }, true))
      return finishStoppable(io, outcome, result => emit(io, formatSessionStatus(result), result as unknown as Record<string, unknown>))
    }
    if (subcommand === 'end') {
      const { runStoppable, sessionEnd } = await workflows()
      const outcome = await runStoppable<SessionEndResult>(settled => sessionEnd({ fetcher, sessionId: argValue(args, '--session') || '' }, settled))
      return finishStoppable(io, outcome, result => {
        const hint =
          result.branchStatus === 'has-changes'
            ? '\nsession branch has changes — run `orizu session finish --session ' + result.session.id + '` to promote them'
            : ''
        emit(io, `session ended: ${result.session.id}${hint}`, result as unknown as Record<string, unknown>)
      })
    }
    if (subcommand === 'finish') {
      const message = argValue(args, '--message')
      const push = hasFlag(args, '--push')
      if (message && !push) {
        throw new Error('`--message` only applies with `--push` (orizu session finish --session <id> --push --message <text>)')
      }
      const { runStoppable, sessionFinish } = await workflows()
      const outcome = await runStoppable<SessionFinishResult>(settled => sessionFinish({
        fetcher,
        cwd: workspaceDir,
        git: io.git,
        sessionId: argValue(args, '--session') || '',
        projectSlug: argValue(args, '--project'),
        push,
        message,
      }, settled, true))
      return finishStoppable(io, outcome, result => emit(io, formatSessionFinish(result), result as unknown as Record<string, unknown>))
    }
  }

  if (group === 'run') {
    if (subcommand === 'start') {
      const { runStoppable, runStart } = await workflows()
      const outcome = await runStoppable<WorkbenchRunResult>(settled => runStart({
        fetcher,
        sessionId: argValue(args, '--session') || '',
        title: argValue(args, '--title') || '',
        projectSlug: argValue(args, '--project'),
      }, settled))
      return finishStoppable(io, outcome, result => emit(io, `run started: ${result.run.id}`, result as unknown as Record<string, unknown>))
    }
    if (subcommand === 'status') {
      const { runStoppable, runStatus } = await workflows()
      const outcome = await runStoppable<WorkbenchRunResult>(() => runStatus({ fetcher, runId: argValue(args, '--run') || '' }, true))
      return finishStoppable(io, outcome, result => emit(io, formatRunStatus(result.run), result as unknown as Record<string, unknown>))
    }
    if (subcommand === 'tail') {
      const { runStoppable, tail } = await workflows()
      const outcome = await runStoppable<TailOnceResult>(() => tail({
        fetcher,
        runId: argValue(args, '--run') || '',
        after: numberArg(args, '--after'),
        intervalSeconds: numberArg(args, '--interval'),
        once: hasFlag(args, '--once'),
        sleep: io.sleep,
        onEvent: event => io.print(io.json ? JSON.stringify(event) : formatEventLine(event)),
      }, true))
      return finishStoppable(io, outcome, () => {})
    }
    const status = terminalStatusForCommand(subcommand || '')
    if (status) {
      const { runStoppable, runTerminal } = await workflows()
      const outcome = await runStoppable<WorkbenchRunResult>(settled => runTerminal({
        fetcher,
        runId: argValue(args, '--run') || '',
        status,
        summary: argValue(args, '--summary'),
      }, settled))
      return finishStoppable(io, outcome, result => emit(io, formatRunStatus(result.run), result as unknown as Record<string, unknown>))
    }
  }

  return emitJsonError(io, USAGE_LINE)
}
