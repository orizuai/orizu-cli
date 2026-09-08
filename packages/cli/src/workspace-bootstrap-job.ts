/** Agent-free synthetic workspace bootstrap. Account-level provider authority
 * stays in the isolated broker; this process receives one scoped credential
 * at a time and revokes it before continuing. */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CLOUDFLARE_ARTIFACTS_HOST_PATTERN } from './cloudflare-artifacts-git-remote.js'
import {
  buildSyntheticWorkspaceSeed,
  buildSeedWorktree,
  verifySeedClone,
} from './workspace-bootstrap-seed.js'
import {
  createEphemeralAskPass,
  defaultGitRunner,
  type GitAuth,
  type GitRunner,
} from './artifacts-git-runtime.js'
import { assertSecureTokenTransport } from './http.js'

export const WORKSPACE_BOOTSTRAP_JOB_CAPABILITY = 'workspace-bootstrap-job:v1'
export const WORKSPACE_BOOTSTRAP_NAMESPACE = 'orizu-workbench-dev'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CALLBACK_ATTEMPTS = 3
// The coordinator's eight-minute wall must still leave time for bounded seed
// preparation, revocation, failure reporting, and an independent readback.
// These are intentionally local to the hosted one-shot, never the legacy
// script's longer migration/repository budgets.
export const WORKSPACE_BOOTSTRAP_PUSH_TIMEOUT_MS = 120_000
export const WORKSPACE_BOOTSTRAP_VERIFICATION_CLONE_TIMEOUT_MS = 120_000

export const WORKSPACE_BOOTSTRAP_FAILURE_CODES = [
  'scope_refused',
  'provider_unavailable',
  'create_uncertain',
  'readback_failed',
  'credentials_pending',
  'bootstrap_interrupted',
] as const

export type WorkspaceBootstrapFailureCode = (typeof WORKSPACE_BOOTSTRAP_FAILURE_CODES)[number]
export type WorkspaceBootstrapJobFetch = (url: string, init?: RequestInit) => Promise<Response>

export interface WorkspaceBootstrapJobEnv {
  bootSecret: string
  intentId: string
  attemptId: string
  coordinatorUrl: string
  baseUrl: string
  /** Derived by the coordinator from its pinned operator account id. */
  expectedGitHost: string
}

export interface WorkspaceBootstrapJobCommandIo {
  print: (line: string) => void
  printErr?: (line: string) => void
  json?: boolean
}

interface WorkspaceBootstrapSpec {
  intentId: string
  attemptId: string
  team: { id: string; slug: string }
  project: { id: string; slug: string; name: string | null }
  repository: {
    provider: 'cloudflare_artifacts'
    repositoryId: string
    remote: string
  }
  expectedSeedSha?: string
}

interface WorkspaceBootstrapCredential {
  remote: string
  username: 'x'
  password: string
  tokenId: string
  expiresAt: string
}

interface VerifiedResult {
  state: 'verified'
  seedCommitSha: string
  contentBytes: number
  fileCount: number
}

interface FailedResult {
  state: 'failed'
  diagnostic: WorkspaceBootstrapFailureCode
}

type WorkspaceBootstrapControlResult = VerifiedResult | FailedResult

export interface WorkspaceBootstrapJobRunResult {
  reported: boolean
  state: 'verified' | 'failed'
  diagnostic: WorkspaceBootstrapFailureCode | null
}

class WorkspaceBootstrapFailure extends Error {
  readonly diagnostic: WorkspaceBootstrapFailureCode

  constructor(diagnostic: WorkspaceBootstrapFailureCode) {
    super(diagnostic)
    this.name = 'WorkspaceBootstrapFailure'
    this.diagnostic = diagnostic
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isLoopbackOrigin(value: string): boolean {
  try {
    const host = new URL(value).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
  } catch {
    return false
  }
}

export function resolveWorkspaceBootstrapJobEnv(
  env: Record<string, string | undefined>
):
  | { ok: true; value: WorkspaceBootstrapJobEnv }
  | { ok: false; missing: string[]; invalid: string[] } {
  const names = [
    'ORIZU_BOOT_SECRET',
    'ORIZU_WORKSPACE_BOOTSTRAP_INTENT_ID',
    'ORIZU_WORKSPACE_BOOTSTRAP_ATTEMPT_ID',
    'ORIZU_COORDINATOR_URL',
    'ORIZU_BASE_URL',
    'ORIZU_WORKSPACE_BOOTSTRAP_GIT_HOST',
  ] as const
  const values = Object.fromEntries(names.map((name) => [name, env[name]?.trim() ?? ''])) as Record<
    (typeof names)[number],
    string
  >
  const missing = names.filter((name) => values[name].length === 0)
  if (missing.length > 0) return { ok: false, missing: [...missing], invalid: [] }

  const invalid: string[] = []
  for (const name of ['ORIZU_COORDINATOR_URL', 'ORIZU_BASE_URL'] as const) {
    try {
      const parsed = new URL(values[name])
      if (parsed.username || parsed.password) throw new Error('userinfo')
      assertSecureTokenTransport(values[name])
    } catch {
      invalid.push(name)
    }
  }
  if (!UUID_PATTERN.test(values.ORIZU_WORKSPACE_BOOTSTRAP_INTENT_ID))
    invalid.push('ORIZU_WORKSPACE_BOOTSTRAP_INTENT_ID')
  if (!UUID_PATTERN.test(values.ORIZU_WORKSPACE_BOOTSTRAP_ATTEMPT_ID))
    invalid.push('ORIZU_WORKSPACE_BOOTSTRAP_ATTEMPT_ID')
  const host = values.ORIZU_WORKSPACE_BOOTSTRAP_GIT_HOST.toLowerCase()
  const localHostAllowed =
    isLoopbackOrigin(values.ORIZU_COORDINATOR_URL) &&
    isLoopbackOrigin(values.ORIZU_BASE_URL) &&
    (host === 'localhost' || host === '127.0.0.1')
  if (!CLOUDFLARE_ARTIFACTS_HOST_PATTERN.test(host) && !localHostAllowed) {
    invalid.push('ORIZU_WORKSPACE_BOOTSTRAP_GIT_HOST')
  }
  if (invalid.length > 0) return { ok: false, missing: [], invalid }
  return {
    ok: true,
    value: {
      bootSecret: values.ORIZU_BOOT_SECRET,
      intentId: values.ORIZU_WORKSPACE_BOOTSTRAP_INTENT_ID,
      attemptId: values.ORIZU_WORKSPACE_BOOTSTRAP_ATTEMPT_ID,
      coordinatorUrl: values.ORIZU_COORDINATOR_URL.replace(/\/+$/, ''),
      baseUrl: values.ORIZU_BASE_URL.replace(/\/+$/, ''),
      expectedGitHost: host,
    },
  }
}

export function assertWorkspaceBootstrapRemote(remote: string, expectedGitHost: string): void {
  let parsed: URL
  try {
    parsed = new URL(remote)
  } catch {
    throw new WorkspaceBootstrapFailure('scope_refused')
  }
  const local =
    (expectedGitHost === 'localhost' || expectedGitHost === '127.0.0.1') &&
    parsed.hostname === expectedGitHost
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== expectedGitHost ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    (!local && parsed.port.length > 0) ||
    !new RegExp(`^/git/${WORKSPACE_BOOTSTRAP_NAMESPACE}/[A-Za-z0-9][A-Za-z0-9._-]*\\.git$`).test(
      parsed.pathname
    )
  ) {
    throw new WorkspaceBootstrapFailure('scope_refused')
  }
}

async function postJson(
  url: string,
  token: string,
  body: object,
  fetchImpl: WorkspaceBootstrapJobFetch
): Promise<Response> {
  return fetchImpl(url, {
    method: 'POST',
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

async function exchangeJobToken(
  env: WorkspaceBootstrapJobEnv,
  fetchImpl: WorkspaceBootstrapJobFetch,
  sleep: (ms: number) => Promise<void>
): Promise<string> {
  const url = `${env.coordinatorUrl}/workspace-bootstrap-jobs/${encodeURIComponent(env.intentId)}/claim`
  for (let attempt = 0; attempt < CALLBACK_ATTEMPTS; attempt += 1) {
    try {
      const response = await postJson(url, env.bootSecret, { attemptId: env.attemptId }, fetchImpl)
      if (response.status === 401 || response.status === 403 || response.status === 409) {
        throw new WorkspaceBootstrapFailure('scope_refused')
      }
      if (response.ok) {
        const value: unknown = await response.json().catch(() => null)
        if (
          isObject(value) &&
          typeof value.jobToken === 'string' &&
          value.jobToken.length > 0 &&
          value.attemptId === env.attemptId &&
          typeof value.expiresAt === 'string'
        ) {
          return value.jobToken
        }
        throw new WorkspaceBootstrapFailure('scope_refused')
      }
    } catch (error) {
      if (error instanceof WorkspaceBootstrapFailure) throw error
    }
    if (attempt < CALLBACK_ATTEMPTS - 1) await sleep(250 * 2 ** attempt)
  }
  throw new WorkspaceBootstrapFailure('provider_unavailable')
}

function parseSpec(value: unknown, env: WorkspaceBootstrapJobEnv): WorkspaceBootstrapSpec {
  if (
    !isObject(value) ||
    value.intentId !== env.intentId ||
    value.attemptId !== env.attemptId ||
    !isObject(value.team) ||
    !isObject(value.project) ||
    !isObject(value.repository) ||
    typeof value.team.id !== 'string' ||
    typeof value.team.slug !== 'string' ||
    typeof value.project.id !== 'string' ||
    typeof value.project.slug !== 'string' ||
    (value.project.name !== null && typeof value.project.name !== 'string') ||
    value.repository.provider !== 'cloudflare_artifacts' ||
    typeof value.repository.repositoryId !== 'string' ||
    value.repository.repositoryId.length === 0 ||
    typeof value.repository.remote !== 'string' ||
    (value.expectedSeedSha !== undefined &&
      (typeof value.expectedSeedSha !== 'string' || !/^[0-9a-f]{40}$/.test(value.expectedSeedSha)))
  ) {
    throw new WorkspaceBootstrapFailure('scope_refused')
  }
  assertWorkspaceBootstrapRemote(value.repository.remote, env.expectedGitHost)
  return value as unknown as WorkspaceBootstrapSpec
}

async function fetchSpec(
  env: WorkspaceBootstrapJobEnv,
  token: string,
  fetchImpl: WorkspaceBootstrapJobFetch
): Promise<WorkspaceBootstrapSpec> {
  let response: Response
  try {
    response = await postJson(
      `${env.baseUrl}/api/internal/hosted-workspace-bootstrap/${encodeURIComponent(env.intentId)}/spec`,
      token,
      { attemptId: env.attemptId },
      fetchImpl
    )
  } catch {
    throw new WorkspaceBootstrapFailure('provider_unavailable')
  }
  if (response.status === 401 || response.status === 403 || response.status === 409)
    throw new WorkspaceBootstrapFailure('scope_refused')
  if (!response.ok) throw new WorkspaceBootstrapFailure('provider_unavailable')
  return parseSpec(await response.json().catch(() => null), env)
}

function parseCredential(
  value: unknown,
  expectedRemote: string,
  expectedGitHost: string
): WorkspaceBootstrapCredential {
  if (
    !isObject(value) ||
    value.remote !== expectedRemote ||
    value.username !== 'x' ||
    typeof value.password !== 'string' ||
    value.password.length < 16 ||
    typeof value.tokenId !== 'string' ||
    value.tokenId.length === 0 ||
    typeof value.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(value.expiresAt))
  ) {
    throw new WorkspaceBootstrapFailure('scope_refused')
  }
  assertWorkspaceBootstrapRemote(value.remote, expectedGitHost)
  return value as unknown as WorkspaceBootstrapCredential
}

async function fetchCredential(
  env: WorkspaceBootstrapJobEnv,
  token: string,
  remote: string,
  scope: 'write' | 'read',
  fetchImpl: WorkspaceBootstrapJobFetch
): Promise<WorkspaceBootstrapCredential> {
  let response: Response
  try {
    response = await postJson(
      `${env.baseUrl}/api/internal/hosted-workspace-bootstrap/${encodeURIComponent(env.intentId)}/credential`,
      token,
      { scope },
      fetchImpl
    )
  } catch {
    throw new WorkspaceBootstrapFailure('provider_unavailable')
  }
  if (response.status === 401 || response.status === 403 || response.status === 409)
    throw new WorkspaceBootstrapFailure('scope_refused')
  if (!response.ok) throw new WorkspaceBootstrapFailure('provider_unavailable')
  return parseCredential(await response.json().catch(() => null), remote, env.expectedGitHost)
}

async function revokeCredential(
  env: WorkspaceBootstrapJobEnv,
  token: string,
  tokenId: string,
  fetchImpl: WorkspaceBootstrapJobFetch
): Promise<void> {
  let response: Response
  try {
    response = await postJson(
      `${env.baseUrl}/api/internal/hosted-workspace-bootstrap/${encodeURIComponent(env.intentId)}/revoke`,
      token,
      { tokenId },
      fetchImpl
    )
  } catch {
    throw new WorkspaceBootstrapFailure('credentials_pending')
  }
  const value: unknown = response.ok ? await response.json().catch(() => null) : null
  if (!response.ok || !isObject(value) || value.revoked !== true) {
    throw new WorkspaceBootstrapFailure('credentials_pending')
  }
}

async function withScopedCredential<T>(input: {
  env: WorkspaceBootstrapJobEnv
  token: string
  remote: string
  scope: 'write' | 'read'
  root: string
  fetchImpl: WorkspaceBootstrapJobFetch
  operation: (auth: GitAuth) => Promise<T>
}): Promise<T> {
  const credential = await fetchCredential(
    input.env,
    input.token,
    input.remote,
    input.scope,
    input.fetchImpl
  )
  let result: T | undefined
  let operationError: unknown
  try {
    const askPass = await createEphemeralAskPass(join(input.root, `${input.scope}-credential`))
    try {
      result = await input.operation({
        askPassPath: askPass.path,
        token: credential.password,
      })
    } catch (error) {
      operationError = error
    } finally {
      await askPass.dispose()
    }
  } catch (error) {
    operationError = error
  }
  // Revocation wins over the Git error: uncertain authority is the most
  // safety-relevant recoverable state.
  await revokeCredential(input.env, input.token, credential.tokenId, input.fetchImpl)
  if (operationError) throw operationError
  return result as T
}

function requireGitOk(
  result: { exitCode: number },
  diagnostic: WorkspaceBootstrapFailureCode
): void {
  if (result.exitCode !== 0) throw new WorkspaceBootstrapFailure(diagnostic)
}

async function reportControlResult(
  env: WorkspaceBootstrapJobEnv,
  token: string,
  result: WorkspaceBootstrapControlResult,
  fetchImpl: WorkspaceBootstrapJobFetch,
  sleep: (ms: number) => Promise<void>
): Promise<boolean> {
  const url = `${env.baseUrl}/api/internal/hosted-workspace-bootstrap/${encodeURIComponent(env.intentId)}/result`
  for (let attempt = 0; attempt < CALLBACK_ATTEMPTS; attempt += 1) {
    try {
      const response = await postJson(url, token, result, fetchImpl)
      // Only an authoritative 2xx receipt proves this exact attempt/result was
      // recorded. A generic 409 can describe stale or conflicting state.
      if (response.ok) return true
    } catch {
      /* retry */
    }
    if (attempt < CALLBACK_ATTEMPTS - 1) await sleep(250 * 2 ** attempt)
  }
  return false
}

async function reportCoordinatorResult(
  env: WorkspaceBootstrapJobEnv,
  result: WorkspaceBootstrapControlResult,
  fetchImpl: WorkspaceBootstrapJobFetch,
  sleep: (ms: number) => Promise<void>
): Promise<boolean> {
  const url = `${env.coordinatorUrl}/workspace-bootstrap-jobs/${encodeURIComponent(env.intentId)}/result`
  const body =
    result.state === 'verified'
      ? { state: 'verified', seedCommitSha: result.seedCommitSha }
      : result
  for (let attempt = 0; attempt < CALLBACK_ATTEMPTS; attempt += 1) {
    try {
      const response = await postJson(url, env.bootSecret, body, fetchImpl)
      if (response.ok) return true
    } catch {
      /* retry */
    }
    if (attempt < CALLBACK_ATTEMPTS - 1) await sleep(250 * 2 ** attempt)
  }
  return false
}

export interface RunWorkspaceBootstrapJobOptions {
  env: WorkspaceBootstrapJobEnv
  fetchImpl?: WorkspaceBootstrapJobFetch
  runGit?: GitRunner
  sleep?: (ms: number) => Promise<void>
}

export async function runWorkspaceBootstrapJob(
  options: RunWorkspaceBootstrapJobOptions
): Promise<WorkspaceBootstrapJobRunResult> {
  const { env } = options
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as WorkspaceBootstrapJobFetch)
  const runGit = options.runGit ?? defaultGitRunner
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  let jobToken: string | null = null
  let controlResult: WorkspaceBootstrapControlResult = {
    state: 'failed',
    diagnostic: 'bootstrap_interrupted',
  }
  let root: string | null = null

  try {
    jobToken = await exchangeJobToken(env, fetchImpl, sleep)
    const spec = await fetchSpec(env, jobToken, fetchImpl)
    const files = buildSyntheticWorkspaceSeed({
      team: spec.team,
      project: spec.project,
    })
    root = await mkdtemp(join(tmpdir(), 'orizu-workspace-bootstrap-'))
    const worktree = join(root, 'seed')
    const seedCommitSha = await buildSeedWorktree({
      runGit,
      worktree,
      files,
      commitMessage: 'chore: seed synthetic hosted workspace',
    })
    if (spec.expectedSeedSha && spec.expectedSeedSha !== seedCommitSha) {
      throw new WorkspaceBootstrapFailure('bootstrap_interrupted')
    }

    await withScopedCredential({
      env,
      token: jobToken,
      remote: spec.repository.remote,
      scope: 'write',
      root,
      fetchImpl,
      operation: async (auth) => {
        const pushed = await runGit(['push', spec.repository.remote, 'HEAD:refs/heads/main'], {
          cwd: worktree,
          auth,
          timeoutMs: WORKSPACE_BOOTSTRAP_PUSH_TIMEOUT_MS,
        })
        requireGitOk(pushed, 'create_uncertain')
      },
    })

    const cloneDir = join(root, 'verification-clone')
    await withScopedCredential({
      env,
      token: jobToken,
      remote: spec.repository.remote,
      scope: 'read',
      root,
      fetchImpl,
      operation: async (auth) => {
        await mkdir(root as string, { recursive: true })
        const cloned = await runGit(
          ['clone', '--branch', 'main', '--single-branch', spec.repository.remote, cloneDir],
          {
            cwd: root as string,
            auth,
            timeoutMs: WORKSPACE_BOOTSTRAP_VERIFICATION_CLONE_TIMEOUT_MS,
          }
        )
        requireGitOk(cloned, 'readback_failed')
        try {
          await verifySeedClone({
            runGit,
            cloneDir,
            files,
            expectedSha: seedCommitSha,
          })
        } catch {
          throw new WorkspaceBootstrapFailure('readback_failed')
        }
      },
    })

    controlResult = {
      state: 'verified',
      seedCommitSha,
      contentBytes: files.reduce((sum, file) => sum + file.bytes.byteLength, 0),
      fileCount: files.length,
    }
  } catch (error) {
    controlResult = {
      state: 'failed',
      diagnostic:
        error instanceof WorkspaceBootstrapFailure ? error.diagnostic : 'bootstrap_interrupted',
    }
  } finally {
    if (root) await rm(root, { recursive: true, force: true })
  }

  const controlReported = jobToken
    ? await reportControlResult(env, jobToken, controlResult, fetchImpl, sleep)
    : false
  const effectiveResult: WorkspaceBootstrapControlResult =
    controlResult.state === 'verified' && !controlReported
      ? { state: 'failed', diagnostic: 'bootstrap_interrupted' }
      : controlResult
  const coordinatorReported = await reportCoordinatorResult(env, effectiveResult, fetchImpl, sleep)
  return {
    reported: controlReported && coordinatorReported,
    state: effectiveResult.state,
    diagnostic: effectiveResult.state === 'failed' ? effectiveResult.diagnostic : null,
  }
}

export async function workspaceBootstrapJobCommand(
  args: readonly string[],
  io: WorkspaceBootstrapJobCommandIo
): Promise<number> {
  if (args.includes('--capability-check')) {
    io.print(WORKSPACE_BOOTSTRAP_JOB_CAPABILITY)
    return 0
  }
  const resolved = resolveWorkspaceBootstrapJobEnv(process.env)
  if (!resolved.ok) {
    const detail =
      resolved.missing.length > 0
        ? `missing required env: ${resolved.missing.join(', ')}`
        : `invalid or insecure env: ${resolved.invalid.join(', ')}`
    io.printErr?.(`workspace-bootstrap-job: ${detail}`)
    return 1
  }
  const result = await runWorkspaceBootstrapJob({ env: resolved.value })
  io.print(
    io.json
      ? JSON.stringify(result)
      : `workspace-bootstrap-job finished: ${result.state}${result.diagnostic ? ` (${result.diagnostic})` : ''}`
  )
  return result.reported ? 0 : 1
}
