// ORI-2762 (ORI-2735a): `orizu workspace` on Effect. Loaded only through
// `await import(...)` from workspace-sync.ts, so other commands never load
// Effect.
//
// - Each request has the dataset-transfer deadline (120 s by default).
// - Once a write was sent, a lost or late reply may still be saved. Every
//   workspace write is safe to repeat (attach is keyed by team, sync records
//   the same facts again, apply answers a repeat as a no-op), so the CLI says
//   running the same command again is safe.
// - Ctrl-C and SIGTERM stop a wait with 130 and 143. Once a reply has
//   arrived, its local writes always finish first.
// - Each local file is replaced whole (temp file, then rename).
// - Only one command at a time may change a folder: sync, pull, apply and
//   `status --remote` hold `.orizu/cache/sync.lock`. A lock whose process is
//   gone is taken over.
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { Cause, Context, Effect, Exit } from 'effect'

import { datasetTransferTimeoutMs } from './dataset-transfer-policy.js'
import { authedFetch } from './http.js'
import { sanitizeTerminalText } from './json-response.js'
import { mayAlreadyBeSavedFields, mayAlreadyBeSavedLine } from './one-request-write.js'
import { unreachedCode } from './request-outcome.js'
import { getWorkspaceRoot, type CanonicalOwner, type RepoState, WORKSPACE_DIR_NAME } from './workspace.js'
import {
  attachedWorkspaceId,
  cacheResourceIdWrite,
  cacheSnapshotWrite,
  canonicalPatchWrite,
  collectInventory,
  collectUntrackedPaths,
  defaultGitRef,
  missingCachePaths,
  readCacheSnapshot,
  stringOrNull,
  syncBody,
  teamSlugOf,
  teamWorkspaceIdWrite,
  writeFileWhole,
  type CommonOptions,
  type GitRefReader,
  type InventoryEntry,
  type PlannedWrite,
  type TrackedResourceKind,
  type WorkspaceSyncFetcher,
  type WorkspaceSyncIo,
} from './workspace-sync.js'

// ---- Requests -------------------------------------------------------------

const SAFE_AGAIN = 'running the same command again is safe'

/** What may be saved when a write's reply never came. */
interface MayBeSaved { thing: string; done: string }
const ATTACH_NOTE: MayBeSaved = { thing: 'workspace', done: 'attached' }
const SYNC_NOTE: MayBeSaved = { thing: 'workspace sync', done: 'recorded' }
const APPLY_NOTE: MayBeSaved = { thing: 'change', done: 'applied' }

/** A failure the command prints as one message, plus the may-be line when a write may be saved. */
class WorkspaceFailure {
  constructor(readonly message: string, readonly mayBeSaved: MayBeSaved | null = null) {}
}

interface Reply {
  status: number
  ok: boolean
  /** The JSON object the server sent; `{}` for anything else, as before. */
  data: Record<string, unknown>
}

/** The write whose reply is still out, so an interruption can say it may be saved. */
interface InFlight { note: MayBeSaved | null }

/** Where requests go, their deadline, and the write whose reply is still out. */
class RequestContext extends Context.Service<RequestContext, {
  readonly fetcher: WorkspaceSyncFetcher | undefined
  readonly timeoutMs: number
  readonly inFlight: InFlight
}>()('orizu/WorkspaceRequestContext') {}

/** Every local file replacement. Tests swap the rename to make one fail. */
const LocalFileRename = Context.Reference<(from: string, to: string) => void>('orizu/WorkspaceFileRename', {
  defaultValue: () => renameSync,
})

const MAX_ERROR_LENGTH = 180

/**
 * One request. `label` starts every failure (`Sync failed`); `note` is set
 * for a write, so a reply lost after sending says what may be saved.
 */
function request(path: string, init: RequestInit, label: string, note: MayBeSaved | null): Effect.Effect<Reply, WorkspaceFailure, RequestContext> {
  return Effect.gen(function*() {
    const context = yield* RequestContext
    return yield* Effect.suspend(() => {
      let sent = false
      let timedOut = false
      return Effect.tryPromise({
        try: async signal => {
          const controller = new AbortController()
          const abort = () => controller.abort()
          const timer = setTimeout(() => { timedOut = true; controller.abort() }, context.timeoutMs)
          if (signal.aborted) abort()
          else signal.addEventListener('abort', abort, { once: true })
          const markSent = () => { sent = true; context.inFlight.note = note }
          try {
            const requestInit = { ...init, signal: controller.signal }
            const response = context.fetcher
              ? (markSent(), await context.fetcher(path, requestInit))
              : await authedFetch(path, requestInit, markSent)
            const text = await response.text()
            let data: Record<string, unknown> = {}
            try {
              const parsed: unknown = JSON.parse(text)
              if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>
            } catch { /* not JSON: read as {} as before */ }
            context.inFlight.note = null
            return { status: response.status, ok: response.ok, data }
          } finally {
            clearTimeout(timer)
            signal.removeEventListener('abort', abort)
            controller.abort()
          }
        },
        catch: cause => {
          const failed = (reason: string, mayBeSaved: boolean) => new WorkspaceFailure(`${label}: ${reason}`, mayBeSaved ? note : null)
          if (timedOut) return failed('the request exceeded its deadline', true)
          const code = unreachedCode(cause)
          if (code) return failed(`could not reach the server (${code})`, false)
          const reason = sanitizeTerminalText(cause instanceof Error ? cause.message : String(cause))
          // A 401 whose sign-in could not be renewed was refused: nothing saved.
          if ((cause as { requestRejected?: unknown } | null)?.requestRejected === true) return new WorkspaceFailure(reason)
          // Before sending (for example, not signed in) the message stands alone.
          return sent ? failed(reason, true) : new WorkspaceFailure(reason)
        },
      })
    })
  })
}

/** A non-2xx reply as today's `<label>: <error or status>`; a 5xx after a write may be saved. */
function failUnlessOk(reply: Reply, label: string, note: MayBeSaved | null): Effect.Effect<Reply, WorkspaceFailure> {
  if (reply.ok) return Effect.succeed(reply)
  const reason = stringOrNull(reply.data.error)
  const text = reason ? sanitizeTerminalText(reason).slice(0, MAX_ERROR_LENGTH) : String(reply.status)
  const refused = reply.status >= 400 && reply.status < 500
  return Effect.fail(new WorkspaceFailure(`${label}: ${text}`, refused ? null : note))
}

const post = (path: string, body: unknown, label: string, note: MayBeSaved) =>
  request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, label, note)

// ---- Local writes ---------------------------------------------------------

/** Replaces each file whole, in order. */
function writeLocalFiles(writes: ReadonlyArray<PlannedWrite | null>): Effect.Effect<void, WorkspaceFailure> {
  return Effect.gen(function*() {
    const rename = yield* LocalFileRename
    for (const write of writes) {
      if (!write) continue
      yield* Effect.try({
        try: () => writeFileWhole(write, rename),
        catch: cause => new WorkspaceFailure(`Could not write ${write.path}: ${cause instanceof Error ? cause.message : String(cause)}`),
      })
    }
  })
}

/**
 * Sends `send`, then writes what its reply calls for. Only the wait can be
 * interrupted: once the reply is in, its writes all finish, so Ctrl-C never
 * leaves some files written and others not.
 */
function thenWrite<A, R>(send: Effect.Effect<A, WorkspaceFailure, R>, writes: (reply: A) => ReadonlyArray<PlannedWrite | null>): Effect.Effect<A, WorkspaceFailure, R> {
  return Effect.uninterruptibleMask(restore => restore(send).pipe(
    Effect.tap(reply => writeLocalFiles(writes(reply))),
  ))
}

// ---- Folder lock ----------------------------------------------------------

const lockPath = (root: string) => join(root, WORKSPACE_DIR_NAME, 'cache', 'sync.lock')

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: alive, owned by someone else.
    return (error as { code?: string }).code === 'EPERM'
  }
}

const lockHolder = (path: string): number | null => {
  try {
    const pid = Number(readFileSync(path, 'utf8').trim())
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

// The pid is written to a temp file first and linked into place, so the lock
// file, once it exists, always holds a whole pid.
function takeLock(root: string): Effect.Effect<string, WorkspaceFailure> {
  return Effect.try({
    try: () => {
      const path = lockPath(root)
      mkdirSync(dirname(path), { recursive: true })
      const temp = `${path}.${process.pid}.tmp`
      writeFileSync(temp, `${process.pid}\n`)
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            linkSync(temp, path)
            return path
          } catch (error) {
            if ((error as { code?: string }).code !== 'EEXIST') throw error
            const holder = lockHolder(path)
            if (holder !== null && processAlive(holder)) {
              throw new WorkspaceFailure(`Another orizu workspace command is running in this folder (pid ${holder}); wait for it to finish.`)
            }
            // Left by a process that is gone: take it over.
            rmSync(path, { force: true })
          }
        }
        throw new WorkspaceFailure('Another orizu workspace command is starting in this folder; wait for it to finish.')
      } finally {
        rmSync(temp, { force: true })
      }
    },
    catch: cause => cause instanceof WorkspaceFailure ? cause : new WorkspaceFailure(`Could not lock this folder: ${cause instanceof Error ? cause.message : String(cause)}`),
  })
}

// Removed only while it still names this process.
const releaseLock = (path: string) => Effect.sync(() => {
  if (lockHolder(path) === process.pid) rmSync(path, { force: true })
})

const withFolderLock = <A, E, R>(root: string, program: Effect.Effect<A, E, R>) =>
  Effect.scoped(Effect.acquireRelease(takeLock(root), releaseLock).pipe(Effect.andThen(program)))

// ---- Server calls ---------------------------------------------------------

interface SyncResourceResult {
  /** Server tracked-resource ROW id (null for untracked — no row exists). */
  id: string | null
  path: string
  status: string
  serverVersionId: string | null
  serverSha256: string | null
  lastSyncedAt: string | null
}

// Create-or-attach the server workspace. Deliberately does NOT write the
// manifest: the caller persists the id only after the first sync round-trip
// succeeds, so a failed sync never leaves a partially-attached manifest.
function createOrAttachWorkspace(root: string) {
  return Effect.gen(function*() {
    const teamSlug = teamSlugOf(root)
    const label = 'Failed to attach workspace'
    const reply = yield* post('/api/cli/workspaces', { teamSlug, name: teamSlug, slug: teamSlug }, label, ATTACH_NOTE).pipe(
      Effect.flatMap(answer => failUnlessOk(answer, label, ATTACH_NOTE)))
    const workspace = reply.data.workspace as Record<string, unknown> | undefined
    const id = stringOrNull(workspace?.id)
    if (!id) return yield* Effect.fail(new WorkspaceFailure('Workspace attach response did not include an id', ATTACH_NOTE))
    return id
  })
}

function requireAttachedWorkspaceId(root: string, opts: CommonOptions): Effect.Effect<string, WorkspaceFailure> {
  const known = stringOrNull(opts.workspaceId ?? undefined) || attachedWorkspaceId(root)
  return known
    ? Effect.succeed(known)
    : Effect.fail(new WorkspaceFailure('This workspace is not attached yet. Run `orizu workspace sync` first to attach it.'))
}

function callSync(root: string, workspaceId: string, entries: InventoryEntry[]) {
  const label = 'Sync failed'
  return post(`/api/cli/workspaces/${workspaceId}/sync`, syncBody(root, entries), label, SYNC_NOTE).pipe(
    Effect.flatMap(reply => failUnlessOk(reply, label, SYNC_NOTE)),
    Effect.map(reply => (Array.isArray(reply.data.resources) ? reply.data.resources : []) as SyncResourceResult[]),
  )
}

// ---- status ---------------------------------------------------------------

interface StatusResourceLine {
  path: string
  kind: TrackedResourceKind | null
  owner: CanonicalOwner | null
  repoState: RepoState | null
  localSha: string | null
  baseSha: string | null
  dirty: boolean
  /**
   * Metadata-only-pull guard (spec §3.3): the base was pulled ahead of the
   * working content, so `apply` will refuse until the bytes are delivered.
   */
  contentPending?: boolean
  /** Definitional local statuses: cache-known-but-deleted / rule-less files. */
  localStatus?: 'missing' | 'untracked'
  remoteStatus?: string
  serverVersionId?: string | null
}

/**
 * "repo moved since your last pull" — the server's recorded DEFAULT-branch push
 * SHA differs from what the LOCAL repo knows the default branch to be. Compared
 * against the default-branch ref (never bare HEAD) so being on a feature branch
 * or carrying local commits never triggers a false positive.
 */
interface FreshnessSignal {
  serverSha: string
  branch: string | null
  pushedAt: string | null
  localDefaultSha: string
}

/** A session branch worth reporting: an old active session or an ended, unmerged one. */
interface StaleSessionBranch {
  sessionId: string
  branch: string
  startedAt: string | null
  reason: 'active-stale' | 'unmerged'
}

const STALE_ACTIVE_MS = 24 * 60 * 60 * 1000

// A best-effort read: any failure, the deadline included, reads as nothing.
const readBestEffort = (path: string) => request(path, { method: 'GET' }, 'Read failed', null).pipe(
  Effect.map(reply => reply.ok ? reply.data : null),
  Effect.catch(() => Effect.succeed(null)),
)

// Fetch the workspace record and compare its recorded DEFAULT-branch push SHA
// against what the local repo knows that same branch to be. Best-effort: any
// server/non-hosted/non-git/unknown-branch condition yields null so `status`
// never fails — and never false-warns — for a local-only, offline, or
// feature-branch checkout.
function fetchFreshness(root: string, workspaceId: string, gitRef: GitRefReader) {
  return readBestEffort(`/api/cli/workspaces?team=${encodeURIComponent(teamSlugOf(root))}`).pipe(Effect.map((data): FreshnessSignal | null => {
    if (!data) return null
    const workspaces = Array.isArray(data.workspaces) ? (data.workspaces as Array<Record<string, unknown>>) : []
    const ws = workspaces.find(item => stringOrNull(item.id) === workspaceId) ?? null
    const serverSha = ws ? stringOrNull(ws.repoLastPushSha) : null
    const branch = ws ? stringOrNull(ws.repoLastPushBranch) : null
    // Without the server's default-branch name we cannot locate the right local
    // ref to compare — stay silent rather than compare against the wrong branch.
    if (!serverSha || !branch) return null
    // Prefer the remote-tracking ref (what the last fetch/pull observed on the
    // default branch); fall back to the local branch. HEAD is deliberately NOT
    // used: a feature-branch checkout must never read as "repo moved".
    const localDefaultSha = gitRef(root, `origin/${branch}`) ?? gitRef(root, branch)
    if (!localDefaultSha || localDefaultSha === serverSha) return null
    return { serverSha, branch, pushedAt: stringOrNull(ws?.repoLastPushAt ?? null), localDefaultSha }
  }))
}

// List the workspace's branched sessions and flag the stale ones. Report,
// don't reap (ALI-972): active sessions still holding a branch past 24h, and
// ended sessions whose branch metadata persists (unmerged write-back).
function fetchStaleSessionBranches(workspaceId: string, now: number) {
  return readBestEffort(`/api/cli/workspaces/${workspaceId}/sessions?branched=true`).pipe(Effect.map(data => {
    const sessions = data && Array.isArray(data.sessions) ? (data.sessions as Array<Record<string, unknown>>) : []
    const stale: StaleSessionBranch[] = []
    for (const session of sessions) {
      // Artifacts uses compatibility repoBranch=main for its separate private
      // working repository. It is never a stale branch in the caller's legacy
      // GitHub workbench checkout.
      if (stringOrNull(session.workingRepositoryId)) continue
      const branch = stringOrNull(session.repoBranch)
      if (!branch) continue
      const status = stringOrNull(session.status)
      const startedAt = stringOrNull(session.startedAt)
      const sessionId = stringOrNull(session.id) ?? ''
      if (status === 'active') {
        const started = startedAt ? Date.parse(startedAt) : NaN
        if (!Number.isNaN(started) && now - started > STALE_ACTIVE_MS) {
          stale.push({ sessionId, branch, startedAt, reason: 'active-stale' })
        }
      } else if (status === 'ended') {
        stale.push({ sessionId, branch, startedAt, reason: 'unmerged' })
      }
    }
    return stale
  }))
}

interface StatusResult {
  root: string
  workspaceId: string | null
  remote: boolean
  resources: StatusResourceLine[]
  /** Set only when the hosted repo's default branch moved past the local ref (ALI-996). */
  freshness?: FreshnessSignal | null
  /** Branched sessions worth attention; empty for local-only workspaces (ALI-972). */
  staleSessionBranches?: StaleSessionBranch[]
}

type StatusOptions = CommonOptions & { remote?: boolean; gitRef?: GitRefReader; now?: () => number }

function workspaceStatus(opts: StatusOptions) {
  return Effect.gen(function*() {
    const root = getWorkspaceRoot(opts.cwd)
    const inventory = collectInventory(root)

    const lines: StatusResourceLine[] = inventory.map(entry => {
      const snapshot = readCacheSnapshot(root, entry.path)
      const base = snapshot?.baseSha256 ?? null
      // Surface the §3.3 guard only while it still bites: if the working content
      // has since reconciled to the pending base, apply would clear it and proceed.
      const pendingBase = snapshot?.contentPending === true
        ? stringOrNull(snapshot.pendingBaseSha256 ?? snapshot.baseSha256 ?? null)
        : null
      const contentPending = pendingBase !== null && pendingBase !== entry.contentSha256
      return {
        path: entry.path,
        kind: entry.kind,
        owner: entry.owner,
        repoState: entry.repoState,
        localSha: entry.contentSha256,
        baseSha: base,
        dirty: base !== null && base !== entry.contentSha256,
        ...(contentPending ? { contentPending: true } : {}),
      }
    })

    // Cache-known paths that no longer exist on disk (spec §3.2 `missing`).
    for (const path of missingCachePaths(root, inventory)) {
      lines.push({ path, kind: null, owner: null, repoState: null, localSha: null, baseSha: readCacheSnapshot(root, path)?.baseSha256 ?? null, dirty: false, localStatus: 'missing' })
    }

    // Rule-less files under managed dirs (spec §3.2 `untracked`) — local only.
    for (const path of collectUntrackedPaths(root, inventory)) {
      lines.push({ path, kind: null, owner: null, repoState: null, localSha: null, baseSha: null, dirty: false, localStatus: 'untracked' })
    }

    let workspaceId: string | null = opts.workspaceId ?? attachedWorkspaceId(root)
    if (opts.remote) {
      // No read-only remote status exists in v0 (spec §3.1): this is the same
      // server-side reconciliation as `sync` (it registers/updates records).
      // It never writes the local cache, though.
      workspaceId = yield* requireAttachedWorkspaceId(root, opts)
      const remote = yield* callSync(root, workspaceId, inventory)
      const byPath = new Map(remote.map(item => [item.path, item]))
      for (const line of lines) {
        const match = byPath.get(line.path)
        if (match) {
          line.remoteStatus = match.status
          line.serverVersionId = match.serverVersionId
        }
      }
    }

    // Hosted-repo freshness + stale-branch report (best-effort): only for attached
    // workspaces, and every server/non-git failure is swallowed so a local-only or
    // offline `status` behaves exactly as before.
    let freshness: FreshnessSignal | null = null
    let staleSessionBranches: StaleSessionBranch[] = []
    if (workspaceId) {
      const now = (opts.now ?? (() => Date.now()))()
      freshness = yield* fetchFreshness(root, workspaceId, opts.gitRef ?? defaultGitRef)
      staleSessionBranches = yield* fetchStaleSessionBranches(workspaceId, now)
    }

    return { root, workspaceId, remote: Boolean(opts.remote), resources: lines, freshness, staleSessionBranches } satisfies StatusResult
  })
}

// ---- sync -----------------------------------------------------------------

interface SyncResultLine extends SyncResourceResult {
  cacheAdvanced: boolean
}

interface SyncResult {
  root: string
  workspaceId: string
  resources: SyncResultLine[]
}

function workspaceSync(opts: CommonOptions) {
  return Effect.gen(function*() {
    const root = getWorkspaceRoot(opts.cwd)
    const knownId = stringOrNull(opts.workspaceId ?? undefined) || attachedWorkspaceId(root)
    const workspaceId = knownId ?? (yield* createOrAttachWorkspace(root))
    const inventory = collectInventory(root)
    const resources: SyncResultLine[] = []
    yield* thenWrite(callSync(root, workspaceId, inventory), remote => {
      const writes: Array<PlannedWrite | null> = []
      for (const item of remote) {
        // Cache base advances ONLY on a `clean` convergence confirmation; every
        // other status leaves the last-sync base untouched (spec §3.1 metadata-first).
        // The server row id, however, is recorded for EVERY returned resource —
        // it is what `apply` addresses, so losing it would strand new resources.
        const resourceId = stringOrNull(item.id) ?? readCacheSnapshot(root, item.path)?.resourceId ?? null
        const clean = item.status === 'clean'
        writes.push(clean
          ? cacheSnapshotWrite(root, { path: item.path, baseSha256: item.serverSha256, versionId: item.serverVersionId, lastSyncedAt: item.lastSyncedAt, resourceId })
          : cacheResourceIdWrite(root, item.path, resourceId))
        resources.push({ ...item, cacheAdvanced: clean })
      }
      // Persist the attachment only after the sync round-trip succeeded, so a
      // failed first sync leaves orizu.team.json byte-identical.
      if (!knownId) writes.push(teamWorkspaceIdWrite(root, workspaceId))
      return writes
    })
    return { root, workspaceId, resources } satisfies SyncResult
  })
}

// ---- pull -----------------------------------------------------------------

interface PullResult {
  path: string
  status: 'converged' | 'refused' | 'noop'
  remoteStatus: string | null
  reason?: string
  note?: string
  manifestUpdated: boolean
  cacheAdvanced: boolean
}

function workspacePull(targetPath: string, opts: CommonOptions) {
  return Effect.gen(function*() {
    const root = getWorkspaceRoot(opts.cwd)
    const entry = collectInventory(root).find(item => item.path === targetPath)
    if (!entry) {
      const known = readCacheSnapshot(root, targetPath)
      return {
        path: targetPath,
        status: 'noop',
        remoteStatus: null,
        reason: known
          ? `File is missing locally at ${targetPath}. Restore it via Git; v0 pull reconciles metadata only and does not materialize content.`
          : `No tracked resource at ${targetPath}`,
        manifestUpdated: false,
        cacheAdvanced: false,
      } satisfies PullResult
    }

    const workspaceId = yield* requireAttachedWorkspaceId(root, opts)
    let result: PullResult | null = null
    yield* thenWrite(callSync(root, workspaceId, [entry]), results => {
      const remote = results.find(item => item.path === entry.path) ?? null
      const remoteStatus = remote?.status ?? null

      if (remoteStatus === 'divergent' || remoteStatus === 'conflicted') {
        result = {
          path: targetPath,
          status: 'refused',
          remoteStatus,
          reason: 'Pull refused: local edits are ahead of the last-sync base; resolve in the working tree (Git) or `apply` to promote.',
          manifestUpdated: false,
          cacheAdvanced: false,
        }
        return []
      }

      // Fast-forward ONLY from server-carried truth. Truthless statuses
      // (local-only/stale/missing/untracked) have nothing to pull; fabricating a
      // base from local bytes is forbidden (spec §3.2).
      const serverSha256 = stringOrNull(remote?.serverSha256 ?? null)
      const serverVersionId = stringOrNull(remote?.serverVersionId ?? null)
      if (!remote || serverSha256 === null) {
        const reason = remoteStatus === 'stale'
          ? 'Nothing to pull: no verifiable server truth for this resource. Refresh it through the primitive-specific command (e.g. `orizu prompts pull`, `orizu datasets download`), then sync.'
          : 'Nothing to pull: this resource has no server truth yet. `orizu workspace apply` promotes repo-owned resources; run `orizu workspace sync` first if it is not registered.'
        result = { path: targetPath, status: 'noop', remoteStatus, reason, manifestUpdated: false, cacheAdvanced: false }
        return []
      }

      // Metadata fast-forward: advance cache base + manifest canonical to the
      // SERVER truth (never local bytes). v0 is metadata-level: source bytes
      // converge through Git; DB-native/object bytes materialize via the
      // primitive-specific commands.
      //
      // Metadata-only-pull guard (spec §3.3): this pull advanced the base to the
      // server hash WITHOUT delivering the bytes. For a repo-owned resource whose
      // working content does not already match that hash, the working tree is now
      // BEHIND the base — a naive three-way read would call it `divergent` and a
      // CAS `apply` would pass (base == server truth) and silently revert the
      // pulled version. Mark the resource content-pending so `apply` refuses until
      // Git delivers the bytes (working == base again). If the content already
      // matches (Git first, the §7 happy path), leave it unmarked.
      const contentPending = entry.owner === 'repo' && entry.contentSha256 !== serverSha256
      const syncedAt = remote.lastSyncedAt ?? new Date().toISOString()
      const note = contentPending
        ? 'Base advanced to the server version but the working content has not been delivered yet (content-pending). `apply` will refuse until Git delivers the new bytes (working == base); run `git pull` to fetch them first.'
        : entry.owner === 'repo'
          ? undefined
          : 'v0 pull reconciles metadata only; materialize bulk content with the primitive-specific command (e.g. `orizu prompts pull`, `orizu datasets download`).'
      result = { path: targetPath, status: 'converged', remoteStatus, note, manifestUpdated: Boolean(entry.manifestPath), cacheAdvanced: true }
      return [
        cacheSnapshotWrite(root, {
          path: entry.path,
          baseSha256: serverSha256,
          versionId: serverVersionId,
          lastSyncedAt: syncedAt,
          resourceId: stringOrNull(remote.id) ?? readCacheSnapshot(root, entry.path)?.resourceId ?? null,
          ...(contentPending ? { contentPending: true, pendingBaseSha256: serverSha256 } : {}),
        }),
        entry.manifestPath
          ? canonicalPatchWrite(entry.manifestPath, { versionId: serverVersionId, contentSha256: serverSha256, lastPulledAt: syncedAt })
          : null,
      ]
    })
    return result!
  })
}

// ---- apply ----------------------------------------------------------------

interface ApplyResult {
  path: string
  status: 'applied' | 'refused' | 'noop'
  reason?: string
  /** Recovery guidance for server 409 refusals (re-sync, then re-drive). */
  hint?: string
  versionId?: string | null
  contentSha256?: string | null
  lastSyncedAt?: string | null
  manifestUpdated: boolean
  cacheAdvanced: boolean
}

function workspaceApply(targetPath: string, opts: CommonOptions) {
  return Effect.gen(function*() {
    const root = getWorkspaceRoot(opts.cwd)
    const entry = collectInventory(root).find(item => item.path === targetPath)
    if (!entry) {
      return { path: targetPath, status: 'noop', reason: `No tracked resource at ${targetPath}`, manifestUpdated: false, cacheAdvanced: false } satisfies ApplyResult
    }
    if (entry.owner !== 'repo') {
      return {
        path: targetPath,
        status: 'refused',
        reason: `Apply refused: ${entry.owner} resources are pull-only; change DB-native state through the primitive's own command and promotion flow.`,
        manifestUpdated: false,
        cacheAdvanced: false,
      } satisfies ApplyResult
    }
    // Apply identity (spec §3.1): STRICTLY the sync-recorded tracked-resource
    // row id. The manifest's canonical.serviceId is informational/legacy and is
    // never used — the API resolves by row id only, so a serviceId would 404.
    const snapshot = readCacheSnapshot(root, entry.path)
    const resourceId = stringOrNull(snapshot?.resourceId ?? null)
    if (!resourceId) {
      return {
        path: targetPath,
        status: 'noop',
        reason: 'No server tracked-resource id is recorded for this path. Run `orizu workspace sync` first to register it and record its row id, then retry apply.',
        manifestUpdated: false,
        cacheAdvanced: false,
      } satisfies ApplyResult
    }

    // Metadata-only-pull guard (spec §3.3): a prior `pull` advanced the base to
    // the server hash without delivering the bytes. If the working content still
    // doesn't match that pulled base, the working tree is BEHIND and a CAS apply
    // would pass (base == server truth) and silently revert the pulled version.
    // Refuse before any server call. Once Git delivers the bytes (working ==
    // pending base), clear the mark and proceed — a genuine later edit off that
    // base is then a legitimate, applyable `divergent`.
    if (snapshot?.contentPending === true) {
      const pendingBase = stringOrNull(snapshot.pendingBaseSha256 ?? snapshot.baseSha256 ?? null)
      if (pendingBase !== null && entry.contentSha256 !== pendingBase) {
        return {
          path: targetPath,
          status: 'refused',
          reason: 'Apply refused: this resource is content-pending — a metadata-only pull advanced its base but the working file still holds the old content. Reconcile the working file to the pulled base first (e.g. `git pull`, or re-pull once Git has delivered the content), then retry apply.',
          manifestUpdated: false,
          cacheAdvanced: false,
        } satisfies ApplyResult
      }
      // Working content now matches the pulled base — the pull is fully realized.
      yield* writeLocalFiles([cacheSnapshotWrite(root, { ...snapshot, contentPending: false, pendingBaseSha256: null })])
    }

    const workspaceId = yield* requireAttachedWorkspaceId(root, opts)
    const baseSha = snapshot?.baseSha256 ?? null
    const label = 'Apply failed'
    let result: ApplyResult | null = null
    yield* thenWrite(post(`/api/cli/workspaces/${workspaceId}/resources/${resourceId}/apply`, { contentSha256: entry.contentSha256, baseSha256: baseSha }, label, APPLY_NOTE).pipe(
      Effect.flatMap(reply => reply.status === 409 ? Effect.succeed(reply) : failUnlessOk(reply, label, APPLY_NOTE)),
    ), reply => {
      if (reply.status === 409) {
        // Owner refusal, conflicted, remote-newer, or CAS loss — in every case
        // the recovery loop is the same: re-sync, converge, retry.
        result = {
          path: targetPath,
          status: 'refused',
          reason: stringOrNull(reply.data.error) || 'Apply refused',
          hint: 'Run `orizu workspace sync` to refresh statuses, converge per the reported status (pull/merge), then retry the apply.',
          manifestUpdated: false,
          cacheAdvanced: false,
        }
        return []
      }
      const resource = (reply.data.resource as Record<string, unknown>) ?? {}
      const versionId = stringOrNull(resource.versionId)
      const contentSha256 = stringOrNull(resource.contentSha256) ?? entry.contentSha256
      const lastSyncedAt = stringOrNull(resource.lastSyncedAt) ?? new Date().toISOString()
      result = { path: targetPath, status: 'applied', versionId, contentSha256, lastSyncedAt, manifestUpdated: Boolean(entry.manifestPath), cacheAdvanced: true }
      return [
        entry.manifestPath ? canonicalPatchWrite(entry.manifestPath, { versionId, contentSha256, lastPulledAt: lastSyncedAt }) : null,
        cacheSnapshotWrite(root, { path: entry.path, baseSha256: contentSha256, versionId, lastSyncedAt, resourceId: stringOrNull(resource.id) ?? resourceId }),
      ]
    })
    return result!
  })
}

// ---- Running ---------------------------------------------------------------

interface RunOptions extends CommonOptions {
  /** Stands in for `renameSync` in every local file replacement (tests). */
  rename?: (from: string, to: string) => void
  signal?: AbortSignal
}

/** Runs one command program to a value, or throws its failure as an Error. */
async function runToPromise<A>(program: Effect.Effect<A, WorkspaceFailure, RequestContext>, opts: RunOptions, inFlight: InFlight = { note: null }): Promise<A> {
  const provided = program.pipe(
    Effect.provideService(RequestContext, { fetcher: opts.fetcher, timeoutMs: datasetTransferTimeoutMs(), inFlight }),
    opts.rename ? Effect.provideService(LocalFileRename, opts.rename) : effect => effect,
  )
  const exit = await Effect.runPromiseExit(provided, opts.signal ? { signal: opts.signal } : undefined)
  if (Exit.isSuccess(exit)) return exit.value
  if (opts.signal?.aborted && Cause.hasInterruptsOnly(exit.cause)) throw new WorkspaceInterrupted()
  const failure = Cause.squash(exit.cause)
  if (!(failure instanceof WorkspaceFailure)) throw failure
  throw new Error(failure.mayBeSaved ? `${failure.message}\n${mayAlreadyBeSavedLine(failure.mayBeSaved.thing, failure.mayBeSaved.done, SAFE_AGAIN)}` : failure.message)
}

class WorkspaceInterrupted extends Error {
  constructor() { super('interrupted') }
}

const lockedIn = <A>(opts: CommonOptions, program: Effect.Effect<A, WorkspaceFailure, RequestContext>) =>
  withFolderLock(getWorkspaceRoot(opts.cwd), program)

export const runWorkspaceStatus = (opts: StatusOptions & RunOptions = {}) =>
  runToPromise(opts.remote ? lockedIn(opts, workspaceStatus(opts)) : workspaceStatus(opts), opts)
export const runWorkspaceSync = (opts: RunOptions = {}) => runToPromise(lockedIn(opts, workspaceSync(opts)), opts)
export const runWorkspacePull = (targetPath: string, opts: RunOptions = {}) => runToPromise(lockedIn(opts, workspacePull(targetPath, opts)), opts)
export const runWorkspaceApply = (targetPath: string, opts: RunOptions = {}) => runToPromise(lockedIn(opts, workspaceApply(targetPath, opts)), opts)

function emit(io: WorkspaceSyncIo, human: string, payload: object) {
  io.print(io.json ? JSON.stringify(payload) : human)
}

const COMMAND_NAMES = { status: 'Workspace status', sync: 'Workspace sync', pull: 'Workspace pull', apply: 'Workspace apply' } as const

interface WorkspaceCommand {
  subcommand: keyof typeof COMMAND_NAMES
  target: string | null
  remote: boolean
}

/**
 * Runs one `orizu workspace` command. Ctrl-C or SIGTERM ends the wait with
 * 130 or 143, saying what may be saved when a write's reply was still out.
 */
export async function runWorkspaceCommand(command: WorkspaceCommand, io: WorkspaceSyncIo): Promise<number> {
  const controller = new AbortController()
  let interrupted: 130 | 143 | undefined
  const interrupt = () => { interrupted ??= 130; controller.abort() }
  const terminate = () => { interrupted ??= 143; controller.abort() }
  const inFlight: InFlight = { note: null }
  const opts: RunOptions = { fetcher: io.fetcher, signal: controller.signal }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  try {
    return await printed(command, io, opts, inFlight)
  } catch (error) {
    if (!(error instanceof WorkspaceInterrupted) || interrupted === undefined) throw error
    const message = `${COMMAND_NAMES[command.subcommand]} interrupted.`
    const note = inFlight.note
    if (io.json) io.print(JSON.stringify({ error: message, ...(note ? mayAlreadyBeSavedFields(SAFE_AGAIN) : {}) }))
    process.stderr.write(note ? `${message}\n${mayAlreadyBeSavedLine(note.thing, note.done, SAFE_AGAIN)}\n` : `${message}\n`)
    return interrupted
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', terminate)
  }
}

async function printed(command: WorkspaceCommand, io: WorkspaceSyncIo, opts: RunOptions, inFlight: InFlight): Promise<number> {
  const { subcommand, target, remote } = command
  if (subcommand === 'status') {
    const status = workspaceStatus({ ...opts, remote })
    const result = await runToPromise(remote ? lockedIn(opts, status) : status, opts, inFlight)
    const lines = result.resources.map(r =>
      `${r.dirty ? '*' : ' '} ${r.path}  [${r.kind ?? '?'}/${r.owner ?? '?'}/${r.repoState ?? '?'}]`
      + `${r.localStatus ? `  ${r.localStatus}` : ''}${r.remoteStatus ? `  ${r.remoteStatus}` : ''}`
      + `${r.contentPending ? '  (content-pending)' : ''}`
    )
    if (result.freshness) {
      const { serverSha, branch, pushedAt } = result.freshness
      lines.push(
        `repo moved since your last pull: ${serverSha}`
        + `${branch ? ` on ${branch}` : ''}${pushedAt ? ` at ${pushedAt}` : ''}`
      )
    }
    if (result.staleSessionBranches && result.staleSessionBranches.length > 0) {
      lines.push('stale session branches:')
      for (const stale of result.staleSessionBranches) {
        const detail = stale.reason === 'active-stale' ? 'active >24h' : 'unmerged'
        lines.push(`  ${stale.branch} (started ${stale.startedAt ?? '?'}, ${detail})`)
      }
    }
    emit(io, ['workspace status', ...lines].join('\n'), result)
    return 0
  }
  if (subcommand === 'sync') {
    const result = await runToPromise(lockedIn(opts, workspaceSync(opts)), opts, inFlight)
    const lines = result.resources.map(r => `${r.status.padEnd(13)} ${r.path}`)
    emit(io, [`workspace sync (workspace ${result.workspaceId})`, ...lines].join('\n'), result)
    return 0
  }
  if (subcommand === 'pull') {
    const result = await runToPromise(lockedIn(opts, workspacePull(target!, opts)), opts, inFlight)
    const human = [`${result.status}: ${result.path}${result.reason ? ` — ${result.reason}` : ''}`, result.note].filter(Boolean).join('\n')
    emit(io, human, result)
    return result.status === 'refused' ? 1 : 0
  }
  const result = await runToPromise(lockedIn(opts, workspaceApply(target!, opts)), opts, inFlight)
  const human = [`${result.status}: ${result.path}${result.reason ? ` — ${result.reason}` : ''}`, result.hint]
    .filter(Boolean)
    .join('\n')
  emit(io, human, result)
  return result.status === 'applied' ? 0 : 1
}
