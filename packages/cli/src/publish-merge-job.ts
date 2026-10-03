/** ORI-2280: the agent-free publish merge one-shot. The coordinator runs it
 * in a sandbox with network access to Artifacts only. It merges one session
 * copy into its team copy with `publishSessionMerge`, getting one scoped key
 * at a time from the web app and revoking every key before it reports. */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { createEphemeralAskPass, type GitAuth } from './artifacts-git-runtime.js'
import { publishSessionMerge, type PublishSessionMergeResult } from './artifacts-session-merge.js'
import { CLOUDFLARE_ARTIFACTS_HOST_PATTERN } from './cloudflare-artifacts-git-remote.js'
import { assertSecureTokenTransport } from './http.js'
import { assertWorkspaceBootstrapRemote, isLoopbackOrigin } from './workspace-bootstrap-job.js'
import { PUBLISH_MERGE_COORDINATOR_WALL_MS, PUBLISH_MERGE_WALL_AT_ENV } from './publish-merge-timing.js'
import { DEFAULT_REPOSITORY_BACKUP_LIMITS } from './repository-backup-core.js'

const PUBLISH_MERGE_JOB_CAPABILITY = 'publish-merge-job:v1'
/** Timing. The job's wall is the earlier of:
 *  - ORIZU_PUBLISH_MERGE_WALL_AT, when set: the epoch-ms moment the
 *    coordinator stops the sandbox (its createdAt + 120 s, so sandbox create
 *    and CLI boot are already counted);
 *  - 110 s from the job's own start, the fallback when it is not set.
 * Within it:
 *  - the merge ends by 90 s from start, and always 10 s before the wall;
 *  - revoking the keys still live ends 10 s before the wall, each call at
 *    most 15 s or whatever is left;
 *  - the last 10 s are kept for posting the result, so it always goes out.
 * All of this is well below the read keys' five-minute life, so no key is
 * ever renewed. */
const JOB_DEADLINE_MS = 90_000
const RESULT_RESERVE_MS = 10_000
const JOB_WALL_MS = PUBLISH_MERGE_COORDINATOR_WALL_MS - RESULT_RESERVE_MS
const LATE_CALL_TIMEOUT_MS = 15_000
const GIT_TIMEOUT_MS = 60_000
/** ADR-012's envelope for a repository's whole object graph. The graph is
 * always larger than the content it was seeded from, so ADR-011's 1 GiB
 * content limit is not the measure here. */
const ADMISSION = {
  totalBytes: DEFAULT_REPOSITORY_BACKUP_LIMITS.maxObjectBytes,
  objectBytes: DEFAULT_REPOSITORY_BACKUP_LIMITS.maxSingleObjectBytes,
  objects: DEFAULT_REPOSITORY_BACKUP_LIMITS.maxObjects,
  commits: DEFAULT_REPOSITORY_BACKUP_LIMITS.maxCommits,
}
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Orizu',
  GIT_AUTHOR_EMAIL: 'publish@orizu.invalid',
  GIT_COMMITTER_NAME: 'Orizu',
  GIT_COMMITTER_EMAIL: 'publish@orizu.invalid',
}

interface PublishMergeJobEnv {
  bootSecret: string
  jobId: string
  coordinatorUrl: string
  baseUrl: string
  /** The Artifacts git host the coordinator expects; localhost only in tests. */
  expectedGitHost: string
  /** The coordinator's wall, epoch ms; see the timing note above. */
  wallAt?: number
}

export type PublishMergeJobOutcome =
  | { outcome: 'merged'; mergeSha: string }
  | { outcome: 'already_merged'; headSha: string }
  | { outcome: 'conflict'; files: readonly string[] }
  | { outcome: 'denied' }
  | { outcome: 'race_lost' }
  | { outcome: 'failed'; code: string }

interface Credential {
  tokenId: string
  plaintext: string
  remote: string
}

class JobFailure extends Error {}

function resolvePublishMergeJobEnv(env: Record<string, string | undefined>): PublishMergeJobEnv | string {
  const value = (name: string) => env[name]?.trim() ?? ''
  const resolved = {
    bootSecret: value('ORIZU_BOOT_SECRET'),
    jobId: value('ORIZU_PUBLISH_MERGE_JOB_ID'),
    coordinatorUrl: value('ORIZU_COORDINATOR_URL').replace(/\/+$/, ''),
    baseUrl: value('ORIZU_BASE_URL').replace(/\/+$/, ''),
    expectedGitHost: value('ORIZU_PUBLISH_MERGE_GIT_HOST').toLowerCase(),
  }
  if (Object.values(resolved).some((item) => item.length === 0)) return 'missing required env'
  const wallAtText = value(PUBLISH_MERGE_WALL_AT_ENV)
  const wallAt = wallAtText ? Number(wallAtText) : undefined
  if (wallAt !== undefined && (!/^[0-9]{13}$/.test(wallAtText) || !Number.isSafeInteger(wallAt))) return 'invalid wall deadline'
  try {
    assertSecureTokenTransport(resolved.coordinatorUrl)
    assertSecureTokenTransport(resolved.baseUrl)
  } catch {
    return 'insecure coordinator or base URL'
  }
  const localGitAllowed = isLoopbackOrigin(resolved.coordinatorUrl) && isLoopbackOrigin(resolved.baseUrl) && resolved.expectedGitHost === 'localhost'
  if (!UUID_PATTERN.test(resolved.jobId) || (!CLOUDFLARE_ARTIFACTS_HOST_PATTERN.test(resolved.expectedGitHost) && !localGitAllowed)) {
    return 'invalid job id or git host'
  }
  return wallAt === undefined ? resolved : { ...resolved, wallAt }
}

/** Every remote must be an https repository in the hosted namespace on the expected host. */
function assertRemote(remote: unknown, expectedGitHost: string): string {
  try {
    assertWorkspaceBootstrapRemote(String(remote), expectedGitHost)
  } catch {
    throw new JobFailure('scope_refused')
  }
  return new URL(String(remote)).toString()
}

async function post(url: string, bearer: string, body: object, signal?: AbortSignal): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    throw new JobFailure(signal?.aborted ? 'timed_out' : 'provider_unavailable')
  }
  const value: unknown = await response.json().catch(() => null)
  const record = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  // The session lost its authority while a key was being minted: a refusal.
  if (response.status === 403 && record?.error === 'gate_denied') throw new JobFailure('denied')
  if (response.status === 401 || response.status === 403) throw new JobFailure('scope_refused')
  if (!response.ok || !record) throw new JobFailure('provider_unavailable')
  return record
}

/** The permission check's answer, or unavailable for anything else. */
function gateAllows(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort().join(',')
  if (keys === 'allowed' && value.allowed === true) return true
  if (keys === 'allowed,reason' && value.allowed === false && typeof value.reason === 'string') return false
  throw new JobFailure('provider_unavailable')
}

/** ADR-012: the team copy is canonical state, so the merged graph must fit
 * the admission envelope before a write key is asked for. The merge folder
 * holds exactly both copies' fetched objects and the merge commit. */
async function assertMergeAdmitted(worktree: string, signal: AbortSignal, narrower: Partial<typeof ADMISSION> = {}): Promise<void> {
  const { stdout } = await promisify(execFile)(
    'git',
    ['cat-file', '--batch-all-objects', '--batch-check=%(objecttype) %(objectsize)'],
    { cwd: worktree, maxBuffer: 64 * 1024 * 1024, signal }
  )
  if (!isMergeInventoryAdmitted(stdout, narrower)) throw new JobFailure('admission_refused')
}

/** One `<type> <size>` line per object, as `git cat-file --batch-check` prints them. */
export function isMergeInventoryAdmitted(inventory: string, narrower: Partial<typeof ADMISSION> = {}): boolean {
  const limits = Object.fromEntries(
    Object.entries(ADMISSION).map(([key, max]) => [key, Math.min(max, narrower[key as keyof typeof ADMISSION] ?? max)])
  ) as typeof ADMISSION
  let totalBytes = 0
  let objects = 0
  let commits = 0
  for (const line of inventory.split('\n')) {
    if (!line) continue
    const [type, size] = line.split(' ')
    const bytes = Number(size)
    objects += 1
    totalBytes += bytes
    if (type === 'commit') commits += 1
    if (!Number.isSafeInteger(bytes) || bytes > limits.objectBytes) return false
  }
  return totalBytes <= limits.totalBytes && objects <= limits.objects && commits <= limits.commits
}

/** A post with its own time limit. An AbortController and timer, as for the
 * deadline: AbortSignal.timeout did not fire inside the job under bun test. */
async function postWithin(timeoutMs: number, url: string, bearer: string, body: object): Promise<Record<string, unknown>> {
  const stop = new AbortController()
  const timer = setTimeout(() => stop.abort(), timeoutMs)
  try {
    return await post(url, bearer, body, stop.signal)
  } finally {
    clearTimeout(timer)
  }
}

function toOutcome(result: PublishSessionMergeResult): PublishMergeJobOutcome {
  switch (result.kind) {
    case 'merged':
      return { outcome: 'merged', mergeSha: result.mergeSha }
    case 'already_merged':
      return { outcome: 'already_merged', headSha: result.canonicalSha }
    case 'conflict':
      return { outcome: 'conflict', files: result.files }
    case 'denied':
      return { outcome: 'denied' }
    case 'race_lost':
      return { outcome: 'race_lost' }
  }
}

export async function runPublishMergeJob(options: {
  env: PublishMergeJobEnv
  deadlineMs?: number
  /** Narrower admission limits; tests only. Never wider than ADMISSION. */
  admission?: Partial<typeof ADMISSION>
  /** Shorter timing; tests only. Each is clamped to its production value. */
  timing?: { resultReserveMs?: number; lateCallMs?: number }
}): Promise<{ reported: boolean; outcome: PublishMergeJobOutcome }> {
  const { env } = options
  const startedAt = Date.now()
  const wallEnd = Math.min(startedAt + JOB_WALL_MS, env.wallAt ?? Number.POSITIVE_INFINITY)
  const reserveMs = Math.min(options.timing?.resultReserveMs ?? RESULT_RESERVE_MS, RESULT_RESERVE_MS)
  const lateCallMs = Math.min(options.timing?.lateCallMs ?? LATE_CALL_TIMEOUT_MS, LATE_CALL_TIMEOUT_MS)
  const stop = new AbortController()
  const timer = setTimeout(() => stop.abort(), Math.max(0, Math.min(options.deadlineMs ?? JOB_DEADLINE_MS, wallEnd - reserveMs - startedAt)))
  const deadline = stop.signal
  const api = (action: string) => `${env.baseUrl}/api/internal/publish-merge/${env.jobId}/${action}`
  const issued: Array<{ target: 'session' | 'team'; tokenId: string }> = []
  let jobToken = ''
  /** A late call's bound: its own limit, or the time left before the last `keepMs` of the wall. */
  const lateBound = (keepMs: number) => Math.min(lateCallMs, wallEnd - keepMs - Date.now())
  const revokeCall = async (target: 'session' | 'team', tokenId: string) => {
    const bound = lateBound(reserveMs)
    if (bound <= 0) throw new JobFailure('credentials_pending')
    return postWithin(bound, api('revoke'), jobToken, { target, tokenId })
  }
  let outcome: PublishMergeJobOutcome
  const root = await mkdtemp(join(tmpdir(), 'orizu-publish-merge-'))
  try {
    const askPass = await createEphemeralAskPass(root)
    const claimed = await post(`${env.coordinatorUrl}/publish-merge-jobs/${env.jobId}/claim`, env.bootSecret, {}, deadline)
    if (typeof claimed.jobToken !== 'string' || !claimed.jobToken) throw new JobFailure('scope_refused')
    jobToken = claimed.jobToken
    const spec = await post(api('spec'), jobToken, {}, deadline)
    const sessionRemote = assertRemote((spec.session as { remote?: unknown } | undefined)?.remote, env.expectedGitHost)
    if (spec.jobId !== env.jobId || typeof spec.sessionCommitSha !== 'string' || spec.ref !== 'refs/heads/main' || typeof spec.commitMessage !== 'string') {
      throw new JobFailure('scope_refused')
    }
    const mint = async (target: 'session' | 'team', scope: 'read' | 'write'): Promise<Credential> => {
      const value = await post(api('credential'), jobToken, { target, scope }, deadline)
      if (typeof value.tokenId !== 'string' || typeof value.plaintext !== 'string') throw new JobFailure('scope_refused')
      issued.push({ target, tokenId: value.tokenId })
      return { tokenId: value.tokenId, plaintext: value.plaintext, remote: assertRemote(value.remote, env.expectedGitHost) }
    }
    const revoke = async (target: 'session' | 'team', tokenId: string) => {
      const value = await revokeCall(target, tokenId)
      if (value.revoked !== true) throw new JobFailure('credentials_pending')
      issued.splice(issued.findIndex((item) => item.tokenId === tokenId), 1)
    }
    const auth = (credential: Credential): GitAuth => ({ askPassPath: askPass.path, token: credential.plaintext })

    const sessionRead = await mint('session', 'read')
    if (sessionRead.remote !== sessionRemote) throw new JobFailure('scope_refused')
    const teamRead = await mint('team', 'read')
    const result = await publishSessionMerge({
      root,
      canonical: { remote: teamRead.remote, auth: auth(teamRead) },
      source: { remote: sessionRemote, auth: auth(sessionRead) },
      canonicalRef: 'refs/heads/main',
      sourceRef: 'refs/heads/main',
      expectedSourceSha: spec.sessionCommitSha,
      commitMessage: spec.commitMessage,
      commitIdentityEnv: IDENTITY,
      authorize: async (merge) => {
        await assertMergeAdmitted(merge.worktree, deadline, options.admission)
        return gateAllows(await post(api('gate'), jobToken, {}, deadline))
      },
      withCanonicalWrite: async (push) => {
        const write = await mint('team', 'write')
        if (write.remote !== teamRead.remote) throw new JobFailure('scope_refused')
        try {
          return await push(auth(write))
        } finally {
          await revoke('team', write.tokenId)
        }
      },
      timeoutMs: GIT_TIMEOUT_MS,
      signal: deadline,
    })
    outcome = toOutcome(result)
  } catch (error) {
    if (error instanceof JobFailure && error.message === 'denied') outcome = { outcome: 'denied' }
    else if (deadline.aborted) outcome = { outcome: 'failed', code: 'timed_out' }
    else outcome = { outcome: 'failed', code: error instanceof JobFailure ? error.message : 'publish_failed' }
  } finally {
    clearTimeout(timer)
    // Revoke whatever is still live, newest first, even past the deadline; an
    // unrevoked key wins over the merge outcome because its authority is then uncertain.
    for (const { target, tokenId } of [...issued].reverse()) {
      try {
        const value = await revokeCall(target, tokenId)
        if (value.revoked !== true) throw new JobFailure('credentials_pending')
      } catch {
        outcome = { outcome: 'failed', code: 'credentials_pending' }
      }
    }
    await rm(root, { recursive: true, force: true })
  }
  let reported = false
  try {
    const bound = lateBound(0)
    if (bound <= 0) throw new JobFailure('timed_out')
    await postWithin(bound, `${env.coordinatorUrl}/publish-merge-jobs/${env.jobId}/result`, env.bootSecret, outcome)
    reported = true
  } catch {
    reported = false
  }
  return { reported, outcome }
}

export async function publishMergeJobCommand(
  args: readonly string[],
  io: { print: (line: string) => void; printErr?: (line: string) => void }
): Promise<number> {
  if (args.includes('--capability-check')) {
    io.print(PUBLISH_MERGE_JOB_CAPABILITY)
    return 0
  }
  const env = resolvePublishMergeJobEnv(process.env)
  if (typeof env === 'string') {
    io.printErr?.(`publish-merge-job: ${env}`)
    return 1
  }
  const result = await runPublishMergeJob({ env })
  io.print(JSON.stringify(result.outcome))
  return result.reported ? 0 : 1
}
