/**
 * Workspace session/run visibility commands (ALI-902 CLI half).
 *
 * Pure logic + injected HTTP: command functions do not parse process.argv and
 * do not print. The thin `workbenchCommand` entry point owns CLI argument
 * parsing and human/JSON output.
 */

import { spawnSync } from 'child_process'

import { authedFetch } from './http.js'
import { findUnknownOption } from './option-validation.js'
import { getWorkspaceRoot, workspaceExists } from './workspace.js'
import { attachedWorkspaceId, stringOrNull } from './workspace-sync.js'

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

function defaultSessionGit(args: string[], opts?: { cwd?: string }): SessionGitResult {
  try {
    // Strip repo-context env (set by git when running inside hooks) so the
    // child git is scoped strictly to cwd/args (same pattern as github-setup).
    const env: NodeJS.ProcessEnv = { ...process.env }
    delete env.GIT_DIR
    delete env.GIT_WORK_TREE
    delete env.GIT_INDEX_FILE
    const result = spawnSync('git', args, { cwd: opts?.cwd, encoding: 'utf8', env })
    return {
      status: result.status ?? 1,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
    }
  } catch {
    return { status: 1, stdout: '', stderr: 'git is not available' }
  }
}

/** True when `root` is the workbench clone: contract marker + a git repo. */
function isWorkbenchClone(root: string, git: SessionGitRunner): boolean {
  return workspaceExists(root) && git(['rev-parse', '--git-dir'], { cwd: root }).status === 0
}

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
const SESSION_START_OPTIONS = new Set(['--project', '--workspace', '--json'])
const WORKBENCH_VALUE_OPTIONS = new Set([
  '--after',
  '--interval',
  '--message',
  '--project',
  '--run',
  '--session',
  '--status',
  '--summary',
  '--title',
  '--workspace',
])

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

/**
 * Fetch the freshly-cut remote session branch and check out a local tracking
 * branch, so a human can start committing immediately. Best-effort by design:
 * every failure (not the clone, no git, fetch/checkout error) returns a
 * 'skipped' result with a human-usable detail — it NEVER throws, because
 * checkout ergonomics must never fail a successfully started session.
 */
function checkoutSessionBranchLocally(
  cwd: string | undefined,
  branch: string,
  git: SessionGitRunner
): SessionCheckout {
  const root = getWorkspaceRoot(cwd)
  try {
    if (!isWorkbenchClone(root, git)) {
      return { branch, state: 'skipped', detail: 'not inside the workbench clone' }
    }
    if (git(['fetch', 'origin', branch], { cwd: root }).status !== 0) {
      return { branch, state: 'skipped', detail: `could not fetch origin/${branch}` }
    }
    const haveLocal =
      git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: root }).status === 0
    const checkout = haveLocal
      ? git(['checkout', branch], { cwd: root })
      : git(['checkout', '-b', branch, '--track', `origin/${branch}`], { cwd: root })
    if (checkout.status !== 0) {
      const reason = checkout.stderr.trim() || `exit ${checkout.status}`
      return { branch, state: 'skipped', detail: `checkout failed: ${reason}` }
    }
    return {
      branch,
      state: 'checked-out',
      detail: haveLocal ? `switched to existing local branch ${branch}` : `tracking origin/${branch}`,
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { branch, state: 'skipped', detail: reason }
  }
}

/** Local ahead/behind vs origin/<branch>; counts are null when not computable. */
function computeSessionBranchSync(
  cwd: string | undefined,
  branch: string,
  git: SessionGitRunner
): SessionBranchSync {
  const root = getWorkspaceRoot(cwd)
  try {
    if (!isWorkbenchClone(root, git)) {
      return { branch, ahead: null, behind: null }
    }
    const counts = git(
      ['rev-list', '--left-right', '--count', `origin/${branch}...${branch}`],
      { cwd: root }
    )
    if (counts.status !== 0) {
      return { branch, ahead: null, behind: null }
    }
    // `--left-right --count origin/b...b` prints "<origin-only>\t<local-only>".
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(counts.stdout)
    if (!match) {
      return { branch, ahead: null, behind: null }
    }
    return { branch, ahead: Number(match[2]), behind: Number(match[1]) }
  } catch {
    return { branch, ahead: null, behind: null }
  }
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
  const session = sessionFrom(data, 'Session start')
  // The session is started; local checkout is best-effort ergonomics only,
  // and only when explicitly requested (the CLI human path).
  const branch = stringOrNull(session.repoBranch)
  const checkout = branch && opts.localCheckout
    ? checkoutSessionBranchLocally(opts.cwd, branch, opts.git ?? defaultSessionGit)
    : branch
      ? { branch, state: 'skipped' as const, detail: 'local checkout not requested' }
      : null
  return { session, checkout }
}

export async function runSessionStatus(opts: SessionStatusOptions = {}): Promise<SessionStatusResult> {
  const fetcher = fetcherFrom(opts)
  const sessionId = stringOrNull(opts.sessionId ?? undefined)
  if (sessionId) {
    const response = await fetcher(`/api/cli/sessions/${encodeURIComponent(sessionId)}`)
    await assertOk(response, 'Session status')
    const data = await readJson(response)
    const session = sessionFrom(data, 'Session status')
    const branch = stringOrNull(session.repoBranch)
    const branchSync = branch
      ? computeSessionBranchSync(opts.cwd, branch, opts.git ?? defaultSessionGit)
      : null
    return { session, branchSync }
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
  return {
    session: sessionFrom(data, 'Session end'),
    branchStatus: stringOrNull(data.branchStatus) ?? undefined,
  }
}

/**
 * Finish-time local checks (ALI-1028): when run inside the workbench clone
 * with the session branch checked out, uncommitted or unpushed local work is
 * reported (it would silently miss the manifest otherwise), and the opt-in
 * `--push` stages/commits/pushes it first. Raw git remains the default
 * workflow — without --push nothing local is mutated.
 */
async function prepareLocalSessionBranch(
  opts: SessionFinishOptions,
  fetcher: WorkbenchFetcher
): Promise<{ localWarnings: string[]; pushed: boolean }> {
  const git = opts.git ?? defaultSessionGit
  const root = getWorkspaceRoot(opts.cwd)
  const localWarnings: string[] = []

  if (!isWorkbenchClone(root, git)) {
    if (opts.push) {
      throw new Error(
        'session finish --push must run inside the workbench clone (it stages, commits, and pushes the session branch checkout)'
      )
    }
    return { localWarnings, pushed: false }
  }

  // Learn the session branch name (the finish call itself does not return it
  // until after the branch is finished).
  const response = await fetcher(`/api/cli/sessions/${encodeURIComponent(opts.sessionId)}`)
  if (!response.ok) {
    // Best-effort: the finish call right after will surface the real error.
    return { localWarnings, pushed: false }
  }
  const branch = stringOrNull(sessionFrom(await readJson(response), 'Session status').repoBranch)
  if (!branch) {
    return { localWarnings, pushed: false }
  }

  const head = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root })
  const onSessionBranch = head.status === 0 && head.stdout.trim() === branch
  if (!onSessionBranch) {
    if (opts.push) {
      const current = head.status === 0 ? head.stdout.trim() : '(unknown)'
      throw new Error(
        `session finish --push requires the session branch checkout: HEAD is ${current}, not ${branch}`
      )
    }
    return { localWarnings, pushed: false }
  }

  const status = git(['status', '--porcelain'], { cwd: root })
  const hasUncommitted = status.status === 0 && status.stdout.trim() !== ''

  if (opts.push) {
    if (hasUncommitted) {
      const add = git(['add', '-A'], { cwd: root })
      if (add.status !== 0) {
        throw new Error(`session finish --push: git add failed: ${add.stderr.trim() || `exit ${add.status}`}`)
      }
      const message = stringOrNull(opts.message) ?? `Session ${opts.sessionId} work (orizu session finish --push)`
      const commit = git(['commit', '-m', message], { cwd: root })
      if (commit.status !== 0) {
        throw new Error(`session finish --push: git commit failed: ${commit.stderr.trim() || `exit ${commit.status}`}`)
      }
    }
    const push = git(['push', 'origin', branch], { cwd: root })
    if (push.status !== 0) {
      throw new Error(`session finish --push: git push failed: ${push.stderr.trim() || `exit ${push.status}`}`)
    }
    return { localWarnings, pushed: true }
  }

  if (hasUncommitted) {
    localWarnings.push(
      `uncommitted changes in your ${branch} checkout — they won't be in the manifest. ` +
        `Commit and push them first (git add/commit/push), or re-run with --push.`
    )
  }
  const counts = git(['rev-list', '--count', `origin/${branch}..${branch}`], { cwd: root })
  const unpushed = counts.status === 0 ? Number.parseInt(counts.stdout.trim(), 10) : 0
  if (Number.isFinite(unpushed) && unpushed > 0) {
    localWarnings.push(
      `${unpushed} unpushed commit${unpushed === 1 ? '' : 's'} on ${branch} — they won't be in the manifest. ` +
        `Run \`git push origin ${branch}\` first, or re-run with --push.`
    )
  }
  return { localWarnings, pushed: false }
}

export async function runSessionFinish(opts: SessionFinishOptions): Promise<SessionFinishResult> {
  const fetcher = fetcherFrom(opts)
  if (!stringOrNull(opts.sessionId)) {
    throw new Error(
      'Usage: orizu session finish --session <id> [--project <team/project>] [--push [--message <text>]] [--json]'
    )
  }
  const { localWarnings, pushed } = await prepareLocalSessionBranch(opts, fetcher)
  const body: Record<string, unknown> = {}
  const projectSlug = normalizeProjectSlug(opts.projectSlug)
  if (projectSlug) {
    body.projectSlug = projectSlug
  }
  const response = await fetcher(`/api/cli/sessions/${encodeURIComponent(opts.sessionId)}/finish-branch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  await assertOk(response, 'Session finish')
  const data = await readJson(response)
  const manifest =
    data.manifest && typeof data.manifest === 'object' && !Array.isArray(data.manifest)
      ? (data.manifest as Record<string, unknown>)
      : undefined
  return {
    outcome: stringOrNull(data.outcome) || 'unknown',
    branch: stringOrNull(data.branch) ?? undefined,
    branchDeleted: typeof data.branchDeleted === 'boolean' ? data.branchDeleted : undefined,
    manifest,
    localWarnings: localWarnings.length > 0 ? localWarnings : undefined,
    pushed: pushed || undefined,
  }
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

function formatRunStatus(run: WorkbenchRun): string {
  const sequence = typeof run.latestSequence === 'number' ? `  latestSequence=${run.latestSequence}` : ''
  const costLine = formatCostSummary(run)
  return `run ${run.id}  ${run.status}${sequence}${costLine ? `\n  ${costLine}` : ''}`
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
  'Usage: orizu session <start|status|end|finish> ... | orizu run <start|status|tail|complete|fail|cancel> ...  (run tail --once drains all currently persisted events, then exits without following)'

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
    // `--workspace <dir>`: the workbench clone directory when the command is
    // not run from inside it (defaults to cwd).
    const workspaceDir = argValue(args, '--workspace') ?? undefined
    if (subcommand === 'start') {
      const unknownOption = findUnknownOption(args, SESSION_START_OPTIONS, WORKBENCH_VALUE_OPTIONS)
      if (unknownOption) {
        return emitJsonError(
          io,
          `unknown option ${unknownOption}\nUsage: orizu session start [--project <team/project>] [--workspace <dir>] [--json]`
        )
      }
      const result = await runSessionStart({
        fetcher,
        cwd: workspaceDir,
        git: io.git,
        localCheckout: true,
        projectSlug: argValue(args, '--project'),
        clientInfo: { source: 'orizu-cli' },
      })
      emit(io, formatSessionStart(result), result as unknown as Record<string, unknown>)
      return 0
    }
    if (subcommand === 'status') {
      const status = argValue(args, '--status')
      if (status && !SESSION_STATUSES.has(status)) {
        throw new Error('Usage: orizu session status [--session <id> | --status active|ended] [--json]')
      }
      const result = await runSessionStatus({
        fetcher,
        cwd: workspaceDir,
        git: io.git,
        sessionId: argValue(args, '--session'),
        status,
      })
      emit(io, formatSessionStatus(result), result as unknown as Record<string, unknown>)
      return 0
    }
    if (subcommand === 'end') {
      const result = await runSessionEnd({ fetcher, sessionId: argValue(args, '--session') || '' })
      const hint =
        result.branchStatus === 'has-changes'
          ? '\nsession branch has changes — run `orizu session finish --session ' + result.session.id + '` to promote them'
          : ''
      emit(io, `session ended: ${result.session.id}${hint}`, result as unknown as Record<string, unknown>)
      return 0
    }
    if (subcommand === 'finish') {
      const message = argValue(args, '--message')
      const push = hasFlag(args, '--push')
      if (message && !push) {
        throw new Error('`--message` only applies with `--push` (orizu session finish --session <id> --push --message <text>)')
      }
      const result = await runSessionFinish({
        fetcher,
        cwd: workspaceDir,
        git: io.git,
        sessionId: argValue(args, '--session') || '',
        projectSlug: argValue(args, '--project'),
        push,
        message,
      })
      emit(io, formatSessionFinish(result), result as unknown as Record<string, unknown>)
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
