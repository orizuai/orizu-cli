import { spawnSync } from 'child_process'

import { Cause, Effect, Exit } from 'effect'

import { runWithStops, type Interrupted } from './cli-stops.js'
import { authedFetch } from './http.js'
import { hasStagedChanges, NOTHING_STAGED_ERROR, unstageOrizuSkillLinks } from './orizu-skill-links.js'
import {
  createStartIntentId,
  isAmbiguousStartResponseStatus,
  isStartIntentId,
  START_RESPONSE_LOSS_MAX_RETRIES,
} from './start-intent.js'
import {
  SESSION_REPOSITORY_PENDING_MAX_RETRIES,
  SESSION_REPOSITORY_PENDING_RETRY_MS,
  SessionRepositoryPendingError,
} from './workbench-cli.js'
import { getWorkspaceRoot, workspaceExists } from './workspace.js'
import { attachedWorkspaceId, stringOrNull } from './workspace-sync.js'
import type {
  SessionBranchSync,
  SessionCheckout,
  SessionEndOptions,
  SessionEndResult,
  SessionFinishOptions,
  SessionFinishResult,
  SessionGitResult,
  SessionGitRunner,
  SessionStartOptions,
  SessionStartResult,
  SessionStatusOptions,
  SessionStatusResult,
  TailOnceResult,
  TailWorkbenchRunOptions,
  WorkbenchFetcher,
  WorkbenchRun,
  WorkbenchRunEvent,
  WorkbenchRunResult,
  WorkbenchRunStartOptions,
  WorkbenchRunStatusOptions,
  WorkbenchRunTerminalOptions,
  WorkbenchSession,
  WorkbenchSleep,
} from './workbench-cli.js'

// The local `orizu session` and `orizu run` workflows (ORI-2734). Loaded only
// through `await import(...)` from workbench-cli, which CLI startup and the
// hosted session CLI import, so neither loads Effect until one of these runs.
//
// Stops (Ctrl-C, SIGTERM) only end waits and reads. A write already sent is
// never abandoned: it runs to its reply, which still prints.

const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'cancelled'])
const DEFAULT_TAIL_LIMIT = 100
const MAX_TAIL_LIMIT = 500
const DEFAULT_TAIL_INTERVAL_SECONDS = 2
// Floor for the continuous poll sleep so `--interval 0` (or negatives) cannot
// hot-spin against the API while a non-terminal run is quiet. Draining full
// pages intentionally skips the sleep — that is catch-up, not polling.
const MIN_TAIL_INTERVAL_MS = 500

/** Where a write's result lands, inside the step a stop cannot end. */
export interface Settled<A> { value?: A }

/** A session start stopped while its repository was still provisioning. */
export interface PendingStart {
  sessionId: string
  startIntentId: string
  projectSlug: string | null
  workspaceDirectory: string | null
}

/** How a command run with stops ended: its result (maybe with a stop that
 * arrived during a write), or a stop, with the pending start it ended, if any. */
export type StoppableOutcome<A> =
  | { value: A; interrupted?: Interrupted['interrupted'] }
  | { interrupted: Interrupted['interrupted']; pending: PendingStart | null }

// Existing steps throw plain errors; keep them as the failure value so the CLI
// prints exactly the same message.
const attempt = <A>(operation: () => A) => Effect.try({ try: operation, catch: cause => cause })
const call = <A>(operation: () => Promise<A>) => Effect.tryPromise({ try: operation, catch: cause => cause })
const fail = (message: string) => Effect.fail(new Error(message))

/**
 * A read. `abortable` (the local CLI) cancels the request when the command is
 * stopped; library callers, the hosted tail among them, call the fetcher
 * exactly as before, with no second argument.
 */
function read(fetcher: WorkbenchFetcher, path: string, abortable: boolean) {
  return Effect.tryPromise({ try: signal => abortable ? fetcher(path, { signal }) : fetcher(path), catch: cause => cause })
}

function pause(sleep: WorkbenchSleep | undefined, ms: number) {
  // The default is Effect's own sleep, so a stop clears its timer and the
  // process can exit at once.
  return sleep ? call(() => sleep(ms)) : Effect.sleep(ms)
}

/** A write and the reading of its reply, run to the end even after a stop. */
function write<A>(settled: Settled<A>, program: Effect.Effect<A, unknown>) {
  return Effect.uninterruptible(Effect.tap(program, value => Effect.sync(() => { settled.value = value })))
}

/** Runs one command for a library caller: no stop handlers, same errors. */
export async function runPlain<A>(program: Effect.Effect<A, unknown>): Promise<A> {
  const exit = await Effect.runPromiseExit(program)
  if (Exit.isSuccess(exit)) return exit.value
  throw Cause.squash(exit.cause)
}

/** Runs one local CLI command with Ctrl-C and SIGTERM handled. */
export async function runStoppable<A>(
  build: (settled: Settled<A>, stop: { pending: PendingStart | null }) => Effect.Effect<A, unknown>
): Promise<StoppableOutcome<A>> {
  const settled: Settled<A> = {}
  const stop: { pending: PendingStart | null } = { pending: null }
  const { exit, interrupted } = await runWithStops(() => build(settled, stop))
  if (Exit.isSuccess(exit)) return { value: exit.value, interrupted }
  if (interrupted !== undefined && 'value' in settled) return { value: settled.value as A, interrupted }
  if (interrupted !== undefined && Cause.hasInterruptsOnly(exit.cause)) return { interrupted, pending: stop.pending }
  throw Cause.squash(exit.cause)
}

// -- Replies ------------------------------------------------------------------

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

/** A successful reply's JSON body, or the action's failure message. */
function okJson(response: Response, action: string) {
  return call(async () => {
    await assertOk(response, action)
    return await readJson(response)
  })
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

// -- Local session-branch git (ALI-1028) --------------------------------------
// Each git step is one synchronous call, so a stop never lands inside one.

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

// -- Sessions -----------------------------------------------------------------

/**
 * POSTs the start intent, retrying a lost reply or a 500/502/503/504 with the
 * same intent, and polls a pending repository. Only the pending wait can be
 * stopped; `stop.pending` then holds what a resume needs.
 */
export function sessionStart(
  opts: SessionStartOptions = {},
  settled: Settled<SessionStartResult> = {},
  stop: { pending: PendingStart | null } = { pending: null }
): Effect.Effect<SessionStartResult, unknown> {
  return Effect.uninterruptibleMask(restore => Effect.gen(function*() {
    const fetcher = fetcherFrom(opts)
    const workspaceId = yield* attempt(() => resolveAttachedWorkspaceId(opts))
    const projectSlug = normalizeProjectSlug(opts.projectSlug)
    const suppliedStartIntentId = stringOrNull(opts.startIntentId)
    if (suppliedStartIntentId && !isStartIntentId(suppliedStartIntentId)) {
      return yield* fail('session start --start-intent must be a UUIDv4')
    }
    const startIntentId = suppliedStartIntentId ?? (yield* attempt(() => createStartIntentId(opts.generateStartIntentId)))
    const suppliedReconcileSessionId = stringOrNull(opts.reconcileSessionId)
    if (suppliedReconcileSessionId && !suppliedStartIntentId) {
      return yield* fail('session start --session requires --start-intent')
    }
    const body: Record<string, unknown> = { startIntentId }
    if (projectSlug) {
      body.projectSlug = projectSlug
    }
    if (opts.clientInfo) {
      body.clientInfo = opts.clientInfo
    }

    let reconcileSessionId: string | null = suppliedReconcileSessionId
    let repositoryPendingAttempts = 0
    let ambiguousResponseAttempts = 0
    let response: Response
    let data: Record<string, unknown>
    for (;;) {
      const sent = yield* Effect.exit(call(() => fetcher(
        `/api/cli/workspaces/${encodeURIComponent(workspaceId)}/sessions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, ...(reconcileSessionId ? { sessionId: reconcileSessionId } : {}) }),
        }
      )))
      if (Exit.isFailure(sent)) {
        if (ambiguousResponseAttempts < START_RESPONSE_LOSS_MAX_RETRIES) {
          ambiguousResponseAttempts += 1
          continue
        }
        return yield* Effect.failCause(sent.cause)
      }
      response = sent.value
      const reply = response
      data = yield* call(() => readJson(reply.clone()))
      if (isAmbiguousStartResponseStatus(response.status) && ambiguousResponseAttempts < START_RESPONSE_LOSS_MAX_RETRIES) {
        ambiguousResponseAttempts += 1
        continue
      }
      const repository =
        data.repository && typeof data.repository === 'object' && !Array.isArray(data.repository)
          ? data.repository as Record<string, unknown>
          : null
      const replyData = data
      const pendingSession = response.status === 202 && repository?.state === 'pending'
        ? yield* attempt(() => sessionFrom(replyData, 'Session start'))
        : null
      const pendingSessionId = pendingSession ? stringOrNull(pendingSession.id) : null
      if (pendingSessionId) {
        const pending: PendingStart = {
          sessionId: pendingSessionId,
          startIntentId,
          projectSlug,
          workspaceDirectory: stringOrNull(opts.cwd),
        }
        if (repositoryPendingAttempts >= SESSION_REPOSITORY_PENDING_MAX_RETRIES) {
          return yield* Effect.fail(new SessionRepositoryPendingError(pending))
        }
        repositoryPendingAttempts += 1
        ambiguousResponseAttempts = 0
        reconcileSessionId = pendingSessionId
        const retryAfterSeconds =
          typeof repository?.retryAfterSeconds === 'number' &&
          Number.isInteger(repository.retryAfterSeconds) &&
          repository.retryAfterSeconds >= 1 &&
          repository.retryAfterSeconds <= 60
            ? repository.retryAfterSeconds
            : SESSION_REPOSITORY_PENDING_RETRY_MS / 1_000
        stop.pending = pending
        yield* restore(pause(opts.sleep, retryAfterSeconds * 1_000))
        stop.pending = null
        continue
      }
      break
    }
    const finalReply = response
    yield* call(() => assertOk(finalReply, 'Session start'))
    const finalData = data
    const session = yield* attempt(() => sessionFrom(finalData, 'Session start'))
    // The session is started; local checkout is best-effort ergonomics only,
    // and only when explicitly requested (the CLI human path). The temporary
    // Artifacts compatibility branch is `main` in a separate remote; never run
    // the legacy `git fetch origin/main` flow against the caller's current
    // checkout.
    const branch = stringOrNull(session.repoBranch)
    const artifactsRepositoryId = stringOrNull(session.workingRepositoryId)
    const checkout = artifactsRepositoryId
      ? null
      : branch && opts.localCheckout
        ? checkoutSessionBranchLocally(opts.cwd, branch, opts.git ?? defaultSessionGit)
        : branch
          ? { branch, state: 'skipped' as const, detail: 'local checkout not requested' }
          : null
    const result: SessionStartResult = { session, checkout }
    settled.value = result
    return result
  }))
}

export function sessionStatus(opts: SessionStatusOptions = {}, abortable = false): Effect.Effect<SessionStatusResult, unknown> {
  return Effect.gen(function*() {
    const fetcher = fetcherFrom(opts)
    const sessionId = stringOrNull(opts.sessionId ?? undefined)
    if (sessionId) {
      const response = yield* read(fetcher, `/api/cli/sessions/${encodeURIComponent(sessionId)}`, abortable)
      const data = yield* okJson(response, 'Session status')
      const session = yield* attempt(() => sessionFrom(data, 'Session status'))
      const branch = stringOrNull(session.repoBranch)
      const artifactsRepositoryId = stringOrNull(session.workingRepositoryId)
      const branchSync = branch && !artifactsRepositoryId
        ? computeSessionBranchSync(opts.cwd, branch, opts.git ?? defaultSessionGit)
        : null
      return { session, branchSync }
    }

    const workspaceId = yield* attempt(() => resolveAttachedWorkspaceId(opts))
    const status = stringOrNull(opts.status ?? undefined)
    const query = status ? `?status=${encodeURIComponent(status)}` : ''
    const response = yield* read(fetcher, `/api/cli/workspaces/${encodeURIComponent(workspaceId)}/sessions${query}`, abortable)
    const data = yield* okJson(response, 'Session status')
    return { sessions: sessionsFrom(data) }
  })
}

export function sessionEnd(opts: SessionEndOptions, settled: Settled<SessionEndResult> = {}): Effect.Effect<SessionEndResult, unknown> {
  return Effect.gen(function*() {
    const fetcher = fetcherFrom(opts)
    if (!stringOrNull(opts.sessionId)) {
      return yield* fail('Usage: orizu session end --session <id> [--json]')
    }
    return yield* write(settled, Effect.gen(function*() {
      const response = yield* call(() => fetcher(`/api/cli/sessions/${encodeURIComponent(opts.sessionId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'ended' }),
      }))
      const data = yield* okJson(response, 'Session end')
      return {
        session: yield* attempt(() => sessionFrom(data, 'Session end')),
        branchStatus: stringOrNull(data.branchStatus) ?? undefined,
      }
    }))
  })
}

/**
 * Finish-time local checks (ALI-1028): when run inside the workbench clone
 * with the session branch checked out, uncommitted or unpushed local work is
 * reported (it would silently miss the manifest otherwise), and the opt-in
 * `--push` stages/commits/pushes it first. Raw git remains the default
 * workflow — without --push nothing local is mutated.
 */
function prepareLocalSessionBranch(
  opts: SessionFinishOptions,
  session: WorkbenchSession | null
): { localWarnings: string[]; pushed: boolean } {
  const git = opts.git ?? defaultSessionGit
  const localWarnings: string[] = []

  if (!session) {
    // Best-effort: the finish call right after will surface the real error.
    return { localWarnings, pushed: false }
  }
  if (stringOrNull(session.workingRepositoryId)) {
    if (opts.push) {
      throw new Error(
        'session finish --push is not supported for an Artifacts-backed session; the hosted session owns its private repository'
      )
    }
    return { localWarnings, pushed: false }
  }

  const root = getWorkspaceRoot(opts.cwd)
  if (!isWorkbenchClone(root, git)) {
    if (opts.push) {
      throw new Error(
        'session finish --push must run inside the workbench clone (it stages, commits, and pushes the session branch checkout)'
      )
    }
    return { localWarnings, pushed: false }
  }

  const branch = stringOrNull(session.repoBranch)
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
      // A hosted session's Orizu skill links are sandbox-local; never ship
      // them (ORI-2442). Commit only if something else is still staged.
      const skillGit = (args: readonly string[]) => {
        const result = git([...args], { cwd: root })
        return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr }
      }
      const unstage = unstageOrizuSkillLinks(skillGit)
      if (!unstage.ok) {
        throw new Error(`session finish --push: ${unstage.error}`)
      }
      const staged = hasStagedChanges(skillGit)
      if (typeof staged !== 'boolean') {
        throw new Error(`session finish --push: ${staged.error}`)
      }
      if (!staged && unstage.unstaged.length === 0) {
        throw new Error(`session finish --push: ${NOTHING_STAGED_ERROR}`)
      }
      if (staged) {
        const message = stringOrNull(opts.message) ?? `Session ${opts.sessionId} work (orizu session finish --push)`
        const commit = git(['commit', '-m', message], { cwd: root })
        if (commit.status !== 0) {
          throw new Error(`session finish --push: git commit failed: ${commit.stderr.trim() || `exit ${commit.status}`}`)
        }
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

/**
 * Reads the session (a stop can end this), then runs the local git steps and
 * the finish request to the end: once `--push` has changed anything, the
 * finish request always follows.
 */
export function sessionFinish(
  opts: SessionFinishOptions,
  settled: Settled<SessionFinishResult> = {},
  abortable = false
): Effect.Effect<SessionFinishResult, unknown> {
  return Effect.gen(function*() {
    const fetcher = fetcherFrom(opts)
    if (!stringOrNull(opts.sessionId)) {
      return yield* fail(
        'Usage: orizu session finish --session <id> [--project <team/project>] [--push [--message <text>]] [--json]'
      )
    }
    // Resolve the server-owned repository mode before invoking Git at all.
    // Artifacts temporarily exposes repoBranch=main for hosted compatibility,
    // but that branch belongs to the private working repository. Treating it as
    // a legacy branch in the caller's current checkout can stage, commit, and
    // push origin/main before the server has a chance to reject finish-branch.
    const sessionResponse = yield* read(fetcher, `/api/cli/sessions/${encodeURIComponent(opts.sessionId)}`, abortable)
    const session = sessionResponse.ok
      ? yield* call(async () => sessionFrom(await readJson(sessionResponse), 'Session status'))
      : null
    return yield* write(settled, Effect.gen(function*() {
      const { localWarnings, pushed } = yield* attempt(() => prepareLocalSessionBranch(opts, session))
      const body: Record<string, unknown> = {}
      const projectSlug = normalizeProjectSlug(opts.projectSlug)
      if (projectSlug) {
        body.projectSlug = projectSlug
      }
      const response = yield* call(() => fetcher(`/api/cli/sessions/${encodeURIComponent(opts.sessionId)}/finish-branch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }))
      const data = yield* okJson(response, 'Session finish')
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
    }))
  })
}

// -- Runs ---------------------------------------------------------------------

export function runStart(opts: WorkbenchRunStartOptions, settled: Settled<WorkbenchRunResult> = {}): Effect.Effect<WorkbenchRunResult, unknown> {
  return Effect.gen(function*() {
    const fetcher = fetcherFrom(opts)
    if (!stringOrNull(opts.sessionId) || !stringOrNull(opts.title)) {
      return yield* fail('Usage: orizu run start --session <id> --title <title> [--project <team/project>] [--json]')
    }
    const projectSlug = normalizeProjectSlug(opts.projectSlug)
    const body: Record<string, unknown> = {
      workspaceSessionId: opts.sessionId,
      title: opts.title,
    }
    if (projectSlug) {
      body.projectSlug = projectSlug
    }
    return yield* write(settled, Effect.gen(function*() {
      const response = yield* call(() => fetcher('/api/cli/workbench-runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }))
      if (response.status === 409) {
        // PR #1284 contract: starting a run on an ended session is a 409.
        const message = yield* call(() => responseMessage(response))
        const hint = /ended/i.test(message) ? ' Run `orizu session start` to open a new session.' : ''
        return yield* fail(`Run start failed (409): ${message}${hint}`)
      }
      const data = yield* okJson(response, 'Run start')
      return { run: yield* attempt(() => runFrom(data, 'Run start')) }
    }))
  })
}

export function runStatus(opts: WorkbenchRunStatusOptions, abortable = false): Effect.Effect<WorkbenchRunResult, unknown> {
  return Effect.gen(function*() {
    const fetcher = fetcherFrom(opts)
    if (!stringOrNull(opts.runId)) {
      return yield* fail('Usage: orizu run status --run <id> [--json]')
    }
    const response = yield* read(fetcher, `/api/cli/workbench-runs/${encodeURIComponent(opts.runId)}`, abortable)
    const data = yield* okJson(response, 'Run status')
    return { run: yield* attempt(() => runFrom(data, 'Run status')) }
  })
}

export function runTerminal(opts: WorkbenchRunTerminalOptions, settled: Settled<WorkbenchRunResult> = {}): Effect.Effect<WorkbenchRunResult, unknown> {
  return Effect.gen(function*() {
    const fetcher = fetcherFrom(opts)
    if (!stringOrNull(opts.runId) || !TERMINAL_RUN_STATUSES.has(opts.status)) {
      return yield* fail('Usage: orizu run <complete|fail|cancel> --run <id> [--summary <text>] [--json]')
    }
    const body: Record<string, unknown> = { status: opts.status }
    if (opts.summary) {
      body.summary = { note: opts.summary }
    }
    if (opts.evidence) {
      body.evidence = opts.evidence
    }
    return yield* write(settled, Effect.gen(function*() {
      const response = yield* call(() => fetcher(`/api/cli/workbench-runs/${encodeURIComponent(opts.runId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }))
      if (response.status === 409) {
        // PR #1284 contract: "Run already <status>" names the STORED status when a
        // different terminal status was requested — report it plus a status hint.
        const message = yield* call(() => responseMessage(response))
        const alreadyMatch = /^Run already (\S+)/.exec(message)
        if (alreadyMatch) {
          return yield* fail(
            `Run update rejected (409): run is already '${alreadyMatch[1]}' (requested '${opts.status}'). Check \`orizu run status --run ${opts.runId}\`.`
          )
        }
        return yield* fail(`Run update failed (409): ${message}`)
      }
      const data = yield* okJson(response, 'Run update')
      return { run: yield* attempt(() => runFrom(data, 'Run update')) }
    }))
  })
}

export function tailOnce(
  fetcher: WorkbenchFetcher,
  runId: string,
  cursor: number,
  limit = DEFAULT_TAIL_LIMIT,
  abortable = false
): Effect.Effect<TailOnceResult, unknown> {
  return Effect.gen(function*() {
    // The API requires an integer cursor: only send back whole non-negative
    // sequences (PR #1284 contract — non-numeric/negative `after` is a 400).
    const safeCursor = Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : 0
    const safeLimit = normalizeTailLimit(limit)
    const response = yield* read(
      fetcher,
      `/api/cli/workbench-runs/${encodeURIComponent(runId)}/events?after=${safeCursor}&limit=${safeLimit}`,
      abortable
    )
    const data = yield* okJson(response, 'Run tail')
    return {
      events: eventsFrom(data),
      cursor: numberOrFallback(data.cursor, safeCursor),
      runStatus: stringOrNull(data.runStatus) || 'unknown',
    }
  })
}

/**
 * Follows a run's events. A stop ends it between pages or during a wait;
 * a page's events are always handed over whole. The hosted session CLI runs
 * this through `tailWorkbenchRun` with no stop handlers.
 */
export function tail(opts: TailWorkbenchRunOptions, abortable = false): Effect.Effect<TailOnceResult, unknown> {
  return Effect.gen(function*() {
    const fetcher = fetcherFrom(opts)
    if (!stringOrNull(opts.runId)) {
      return yield* fail(
        'Usage: orizu run tail --run <id> [--after <seq>] [--interval <seconds>] [--once] [--json]  (--once drains all currently persisted events, then exits without following)'
      )
    }
    let cursor = typeof opts.after === 'number' && Number.isFinite(opts.after) && opts.after > 0 ? Math.floor(opts.after) : 0
    const intervalMs = Math.max(MIN_TAIL_INTERVAL_MS, Math.round((opts.intervalSeconds ?? DEFAULT_TAIL_INTERVAL_SECONDS) * 1000))
    const pageLimit = normalizeTailLimit(opts.limit)

    while (true) {
      const previousCursor = cursor
      const result = yield* tailOnce(fetcher, opts.runId, cursor, opts.limit, abortable)
      cursor = result.cursor
      yield* attempt(() => {
        for (const event of result.events) {
          opts.onEvent?.(event)
        }
      })
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
        yield* pause(opts.sleep, intervalMs)
        continue
      }
      if (opts.once || TERMINAL_RUN_STATUSES.has(result.runStatus)) {
        return result
      }
      yield* pause(opts.sleep, intervalMs)
    }
  })
}
