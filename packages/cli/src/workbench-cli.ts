/**
 * Workspace session/run visibility commands (ALI-902 CLI half).
 *
 * Pure logic + injected HTTP: command functions do not parse process.argv and
 * do not print. The thin `workbenchCommand` entry point owns CLI argument
 * parsing and human/JSON output.
 */

import { authedFetch } from './http.js'
import { getWorkspaceRoot } from './workspace.js'
import { attachedWorkspaceId, stringOrNull } from './workspace-sync.js'

export interface WorkbenchFetcher {
  (path: string, init?: RequestInit): Promise<Response>
}

export interface WorkbenchSleep {
  (ms: number): Promise<void>
}

export interface WorkbenchRunSummary {
  id: string
  status: string
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
  [key: string]: unknown
}

export interface WorkbenchRun {
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

export interface SessionStartOptions extends CommonWorkbenchOptions {
  workspaceId?: string | null
  projectSlug?: string | null
  clientInfo?: Record<string, unknown>
}

export interface SessionStatusOptions extends CommonWorkbenchOptions {
  workspaceId?: string | null
  sessionId?: string | null
  status?: string | null
}

export interface SessionEndOptions {
  fetcher?: WorkbenchFetcher
  sessionId: string
}

export interface SessionStartResult {
  session: WorkbenchSession
}

export interface SessionStatusResult {
  session?: WorkbenchSession
  sessions?: WorkbenchSession[]
}

export interface SessionEndResult {
  session: WorkbenchSession
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
}

const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'cancelled'])
const SESSION_STATUSES = new Set(['active', 'ended'])
const DEFAULT_TAIL_LIMIT = 100
const MAX_TAIL_LIMIT = 500
const DEFAULT_TAIL_INTERVAL_SECONDS = 2
// Floor for the continuous poll sleep so `--interval 0` (or negatives) cannot
// hot-spin against the API while a non-terminal run is quiet. Draining full
// pages intentionally skips the sleep — that is catch-up, not polling.
const MIN_TAIL_INTERVAL_MS = 500

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function numberOrFallback(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function normalizeTailLimit(limit: number | undefined): number {
  return typeof limit === 'number' && Number.isFinite(limit) && limit > 0
    ? Math.min(Math.floor(limit), MAX_TAIL_LIMIT)
    : DEFAULT_TAIL_LIMIT
}

function normalizeProjectSlug(value: string | null | undefined): string | null {
  const raw = stringOrNull(value)
  if (!raw) {
    return null
  }
  const segments = raw.split('/').map(segment => segment.trim()).filter(Boolean)
  return segments.length > 0 ? segments[segments.length - 1] : null
}

function resolveAttachedWorkspaceId(opts: SessionStartOptions | SessionStatusOptions): string {
  const explicit = stringOrNull(opts.workspaceId ?? undefined)
  if (explicit) {
    return explicit
  }
  const root = getWorkspaceRoot(opts.cwd)
  const attached = attachedWorkspaceId(root)
  if (!attached) {
    throw new Error('This workspace is not attached yet; run `orizu workspace sync` first to attach it.')
  }
  return attached
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>
  } catch {
    return {}
  }
}

async function responseMessage(response: Response): Promise<string> {
  try {
    const data = await response.clone().json() as Record<string, unknown>
    return stringOrNull(data.error) || stringOrNull(data.message) || response.statusText || String(response.status)
  } catch {
    try {
      const text = await response.text()
      return text.trim() || response.statusText || String(response.status)
    } catch {
      return response.statusText || String(response.status)
    }
  }
}

async function assertOk(response: Response, action: string): Promise<void> {
  if (response.ok) {
    return
  }
  throw new Error(`${action} failed (${response.status}): ${await responseMessage(response)}`)
}

function fetcherFrom(opts: { fetcher?: WorkbenchFetcher }): WorkbenchFetcher {
  return opts.fetcher ?? authedFetch
}

function requiredBodyObject(data: Record<string, unknown>, key: string, action: string): Record<string, unknown> {
  const value = data[key]
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${action} response did not include ${key}`)
  }
  return value as Record<string, unknown>
}

function sessionFrom(data: Record<string, unknown>, action: string): WorkbenchSession {
  return requiredBodyObject(data, 'session', action) as WorkbenchSession
}

function runFrom(data: Record<string, unknown>, action: string): WorkbenchRun {
  return requiredBodyObject(data, 'run', action) as WorkbenchRun
}

function sessionsFrom(data: Record<string, unknown>): WorkbenchSession[] {
  return Array.isArray(data.sessions) ? data.sessions as WorkbenchSession[] : []
}

function eventsFrom(data: Record<string, unknown>): WorkbenchRunEvent[] {
  return Array.isArray(data.events) ? data.events as WorkbenchRunEvent[] : []
}

export async function runSessionStart(opts: SessionStartOptions = {}): Promise<SessionStartResult> {
  const fetcher = fetcherFrom(opts)
  const workspaceId = resolveAttachedWorkspaceId(opts)
  const projectSlug = normalizeProjectSlug(opts.projectSlug)
  const body: Record<string, unknown> = {}
  if (projectSlug) {
    body.projectSlug = projectSlug
  }
  if (opts.clientInfo) {
    body.clientInfo = opts.clientInfo
  }

  const response = await fetcher(`/api/cli/workspaces/${encodeURIComponent(workspaceId)}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  await assertOk(response, 'Session start')
  const data = await readJson(response)
  return { session: sessionFrom(data, 'Session start') }
}

export async function runSessionStatus(opts: SessionStatusOptions = {}): Promise<SessionStatusResult> {
  const fetcher = fetcherFrom(opts)
  const sessionId = stringOrNull(opts.sessionId ?? undefined)
  if (sessionId) {
    const response = await fetcher(`/api/cli/sessions/${encodeURIComponent(sessionId)}`)
    await assertOk(response, 'Session status')
    const data = await readJson(response)
    return { session: sessionFrom(data, 'Session status') }
  }

  const workspaceId = resolveAttachedWorkspaceId(opts)
  const status = stringOrNull(opts.status ?? undefined)
  const query = status ? `?status=${encodeURIComponent(status)}` : ''
  const response = await fetcher(`/api/cli/workspaces/${encodeURIComponent(workspaceId)}/sessions${query}`)
  await assertOk(response, 'Session status')
  const data = await readJson(response)
  return { sessions: sessionsFrom(data) }
}

export async function runSessionEnd(opts: SessionEndOptions): Promise<SessionEndResult> {
  const fetcher = fetcherFrom(opts)
  if (!stringOrNull(opts.sessionId)) {
    throw new Error('Usage: orizu session end --session <id> [--json]')
  }
  const response = await fetcher(`/api/cli/sessions/${encodeURIComponent(opts.sessionId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'ended' }),
  })
  await assertOk(response, 'Session end')
  const data = await readJson(response)
  return { session: sessionFrom(data, 'Session end') }
}

export async function runWorkbenchRunStart(opts: WorkbenchRunStartOptions): Promise<WorkbenchRunResult> {
  const fetcher = fetcherFrom(opts)
  if (!stringOrNull(opts.sessionId) || !stringOrNull(opts.title)) {
    throw new Error('Usage: orizu run start --session <id> --title <title> [--project <team/project>] [--json]')
  }
  const projectSlug = normalizeProjectSlug(opts.projectSlug)
  const body: Record<string, unknown> = {
    workspaceSessionId: opts.sessionId,
    title: opts.title,
  }
  if (projectSlug) {
    body.projectSlug = projectSlug
  }

  const response = await fetcher('/api/cli/workbench-runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (response.status === 409) {
    // PR #1284 contract: starting a run on an ended session is a 409.
    const message = await responseMessage(response)
    const hint = /ended/i.test(message) ? ' Run `orizu session start` to open a new session.' : ''
    throw new Error(`Run start failed (409): ${message}${hint}`)
  }
  await assertOk(response, 'Run start')
  const data = await readJson(response)
  return { run: runFrom(data, 'Run start') }
}

export async function runWorkbenchRunStatus(opts: WorkbenchRunStatusOptions): Promise<WorkbenchRunResult> {
  const fetcher = fetcherFrom(opts)
  if (!stringOrNull(opts.runId)) {
    throw new Error('Usage: orizu run status --run <id> [--json]')
  }
  const response = await fetcher(`/api/cli/workbench-runs/${encodeURIComponent(opts.runId)}`)
  await assertOk(response, 'Run status')
  const data = await readJson(response)
  return { run: runFrom(data, 'Run status') }
}

export async function runWorkbenchRunTerminal(opts: WorkbenchRunTerminalOptions): Promise<WorkbenchRunResult> {
  const fetcher = fetcherFrom(opts)
  if (!stringOrNull(opts.runId) || !TERMINAL_RUN_STATUSES.has(opts.status)) {
    throw new Error('Usage: orizu run <complete|fail|cancel> --run <id> [--summary <text>] [--json]')
  }
  const body: Record<string, unknown> = { status: opts.status }
  if (opts.summary) {
    body.summary = { note: opts.summary }
  }
  if (opts.evidence) {
    body.evidence = opts.evidence
  }

  const response = await fetcher(`/api/cli/workbench-runs/${encodeURIComponent(opts.runId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (response.status === 409) {
    // PR #1284 contract: "Run already <status>" names the STORED status when a
    // different terminal status was requested — report it plus a status hint.
    const message = await responseMessage(response)
    const alreadyMatch = /^Run already (\S+)/.exec(message)
    if (alreadyMatch) {
      throw new Error(
        `Run update rejected (409): run is already '${alreadyMatch[1]}' (requested '${opts.status}'). Check \`orizu run status --run ${opts.runId}\`.`
      )
    }
    throw new Error(`Run update failed (409): ${message}`)
  }
  await assertOk(response, 'Run update')
  const data = await readJson(response)
  return { run: runFrom(data, 'Run update') }
}

export async function tailOnce(
  fetcher: WorkbenchFetcher,
  runId: string,
  cursor: number,
  limit = DEFAULT_TAIL_LIMIT
): Promise<TailOnceResult> {
  // The API requires an integer cursor: only send back whole non-negative
  // sequences (PR #1284 contract — non-numeric/negative `after` is a 400).
  const safeCursor = Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : 0
  const safeLimit = normalizeTailLimit(limit)
  const response = await fetcher(
    `/api/cli/workbench-runs/${encodeURIComponent(runId)}/events?after=${safeCursor}&limit=${safeLimit}`
  )
  await assertOk(response, 'Run tail')
  const data = await readJson(response)
  return {
    events: eventsFrom(data),
    cursor: numberOrFallback(data.cursor, safeCursor),
    runStatus: stringOrNull(data.runStatus) || 'unknown',
  }
}

export async function tailWorkbenchRun(opts: TailWorkbenchRunOptions): Promise<TailOnceResult> {
  const fetcher = fetcherFrom(opts)
  if (!stringOrNull(opts.runId)) {
    throw new Error(
      'Usage: orizu run tail --run <id> [--after <seq>] [--interval <seconds>] [--once] [--json]  (--once drains all currently persisted events, then exits without following)'
    )
  }
  const sleep = opts.sleep ?? defaultSleep
  let cursor = typeof opts.after === 'number' && Number.isFinite(opts.after) && opts.after > 0 ? Math.floor(opts.after) : 0
  const intervalMs = Math.max(MIN_TAIL_INTERVAL_MS, Math.round((opts.intervalSeconds ?? DEFAULT_TAIL_INTERVAL_SECONDS) * 1000))
  const pageLimit = normalizeTailLimit(opts.limit)

  while (true) {
    const previousCursor = cursor
    const result = await tailOnce(fetcher, opts.runId, cursor, opts.limit)
    cursor = result.cursor
    for (const event of result.events) {
      opts.onEvent?.(event)
    }
    // A full page means more events may already be persisted — keep draining
    // back-to-back (no sleep). Exit conditions are only evaluated on a SHORT
    // page: a terminal runStatus on a full page would otherwise truncate a
    // completed run that has more unread pages.
    if (result.events.length >= pageLimit) {
      // Protocol invariant: a full page always implies the server advanced
      // the cursor past what we asked for. If it didn't, draining back-to-back
      // would spin hot forever on a misbehaving/stalled server. We pick the
      // simpler of the two acceptable fixes (apply the normal poll sleep
      // before retrying, rather than failing after one retry) because it
      // matches this loop's existing backoff-on-no-progress shape (see the
      // MIN_TAIL_INTERVAL_MS floor above) without introducing a new
      // retry-count/error path.
      if (cursor > previousCursor) {
        continue
      }
      await sleep(intervalMs)
      continue
    }
    if (opts.once || TERMINAL_RUN_STATUSES.has(result.runStatus)) {
      return result
    }
    await sleep(intervalMs)
  }
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag)
}

function argValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag)
  if (index === -1 || index + 1 >= args.length || args[index + 1].startsWith('--')) {
    return null
  }
  return args[index + 1]
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
      if (argValue(args, arg) !== null) {
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

function formatSessionStatus(result: SessionStatusResult): string {
  if (result.session) {
    const lines = [`session ${result.session.id}  ${result.session.status}`]
    for (const run of result.session.runs ?? []) {
      lines.push(`  run ${run.id}  ${run.status}`)
    }
    return lines.join('\n')
  }
  const sessions = result.sessions ?? []
  return ['workspace sessions', ...sessions.map(session => `${session.id}  ${session.status}`)].join('\n')
}

function formatRunStatus(run: WorkbenchRun): string {
  const sequence = typeof run.latestSequence === 'number' ? `  latestSequence=${run.latestSequence}` : ''
  return `run ${run.id}  ${run.status}${sequence}`
}

function formatEventLine(event: WorkbenchRunEvent): string {
  const payload = event.payload && Object.keys(event.payload).length > 0 ? ` ${JSON.stringify(event.payload)}` : ''
  return `${event.sequence} ${event.eventType}${payload}`
}

function terminalStatusForCommand(command: string): string | null {
  if (command === 'complete') return 'succeeded'
  if (command === 'fail') return 'failed'
  if (command === 'cancel') return 'cancelled'
  return null
}

const USAGE_LINE =
  'Usage: orizu session <start|status|end> ... | orizu run <start|status|tail|complete|fail|cancel> ...  (run tail --once drains all currently persisted events, then exits without following)'

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
      return emitJsonError(io, message)
    }
    throw error
  }
}

async function dispatchWorkbenchCommand(args: string[], io: WorkbenchCommandIo): Promise<number> {
  const positional = positionalArgs(args)
  const group = positional[0]
  const subcommand = positional[1]
  const fetcher = io.fetcher

  if (group === 'session') {
    if (subcommand === 'start') {
      const result = await runSessionStart({
        fetcher,
        projectSlug: argValue(args, '--project'),
        clientInfo: { source: 'orizu-cli' },
      })
      emit(io, `session started: ${result.session.id}`, result as unknown as Record<string, unknown>)
      return 0
    }
    if (subcommand === 'status') {
      const status = argValue(args, '--status')
      if (status && !SESSION_STATUSES.has(status)) {
        throw new Error('Usage: orizu session status [--session <id> | --status active|ended] [--json]')
      }
      const result = await runSessionStatus({ fetcher, sessionId: argValue(args, '--session'), status })
      emit(io, formatSessionStatus(result), result as unknown as Record<string, unknown>)
      return 0
    }
    if (subcommand === 'end') {
      const result = await runSessionEnd({ fetcher, sessionId: argValue(args, '--session') || '' })
      emit(io, `session ended: ${result.session.id}`, result as unknown as Record<string, unknown>)
      return 0
    }
  }

  if (group === 'run') {
    if (subcommand === 'start') {
      const result = await runWorkbenchRunStart({
        fetcher,
        sessionId: argValue(args, '--session') || '',
        title: argValue(args, '--title') || '',
        projectSlug: argValue(args, '--project'),
      })
      emit(io, `run started: ${result.run.id}`, result as unknown as Record<string, unknown>)
      return 0
    }
    if (subcommand === 'status') {
      const result = await runWorkbenchRunStatus({ fetcher, runId: argValue(args, '--run') || '' })
      emit(io, formatRunStatus(result.run), result as unknown as Record<string, unknown>)
      return 0
    }
    if (subcommand === 'tail') {
      await tailWorkbenchRun({
        fetcher,
        runId: argValue(args, '--run') || '',
        after: numberArg(args, '--after'),
        intervalSeconds: numberArg(args, '--interval'),
        once: hasFlag(args, '--once'),
        sleep: io.sleep,
        onEvent: event => io.print(io.json ? JSON.stringify(event) : formatEventLine(event)),
      })
      return 0
    }
    const status = terminalStatusForCommand(subcommand || '')
    if (status) {
      const result = await runWorkbenchRunTerminal({
        fetcher,
        runId: argValue(args, '--run') || '',
        status,
        summary: argValue(args, '--summary'),
      })
      emit(io, formatRunStatus(result.run), result as unknown as Record<string, unknown>)
      return 0
    }
  }

  return emitJsonError(io, USAGE_LINE)
}
