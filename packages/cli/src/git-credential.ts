/**
 * Git credential helper (ALI-971 / WS-D).
 *
 * Implements git's credential-helper protocol on stdin/stdout so teammates can
 * `git pull`/`git push` the hosted workbench repo with NO GitHub identity: git
 * asks this helper for a credential, we broker a short-lived, downscoped
 * installation token from Orizu and hand it back as `x-access-token:<token>`.
 * The token is never written to disk (60-min TTL is the backstop).
 *
 * Protocol: git runs `orizu git-credential <op>` where op is get|store|erase
 * and feeds `key=value` lines on stdin terminated by a blank line. Only `get`
 * does work; `store`/`erase` are no-ops. For `get` we respond only when the
 * host is github.com AND the cwd resolves to an attached Orizu workspace —
 * otherwise we stay silent so git falls through to its normal handling.
 *
 * Purpose selection: git does not tell us read-vs-write intent, so we mint
 * `write` first (the common push case for curators) and fall back to `read` on
 * a 403 (plain members). Pure logic + injected fetcher/io: index.ts stays thin.
 */

import { existsSync } from 'fs'
import { dirname, join } from 'path'

import { authedFetch } from './http.js'
import { readJsonManifest } from './workspace.js'

export type GitCredentialFetcher = (path: string, init?: RequestInit) => Promise<Response>

export interface GitCredentialIo {
  stdin: string
  cwd: string
  print: (line: string) => void
  printErr: (line: string) => void
  fetcher?: GitCredentialFetcher
  /** Explicit workspace id (tests / clone-time). Overrides env + cwd lookup. */
  workspaceId?: string
  /**
   * Exact logical capability configured for this remote. Artifacts credentials
   * require this value because Git's helper protocol does not identify whether
   * an operation is a fetch or push and host-only selection is unsafe.
   */
  purpose?: RepoTokenPurpose
  /** Injectable clock for strict provider credential expiry validation. */
  nowMs?: () => number
}

const GITHUB_HOST = 'github.com'
const ARTIFACTS_HOST =
  /^[0-9a-f]{32}\.artifacts\.cloudflare\.net$/
/**
 * ALI-1285: the Artifacts contract declares the credential OPAQUE
 * (`plaintext: string`) with no documented body format. Pinning
 * `art_v1_<40 hex>` would reject a contract-conformant credential that the
 * broker and the runtime contract both accept. Only what the git Basic-auth
 * transport requires is enforced: bounded, no whitespace, no control
 * characters, and at least 16 characters (a security floor, not a format
 * claim). Mirrors `workers/artifacts-runtime/contracts.ts` GIT_PASSWORD.
 */
const ARTIFACTS_PASSWORD =
  /^[^\s\u0000-\u001f\u007f]{16,1024}$/
const ARTIFACTS_MAX_EXPIRY_SKEW_MS = 305_000
const SAFE_REMOTE_COMPONENT = /^[^\u0000-\u0020\u007f\\?#]+$/

export const REPO_TOKEN_PURPOSES = [
  'read',
  'write',
] as const

export type RepoTokenPurpose =
  (typeof REPO_TOKEN_PURPOSES)[number]

export interface GitCredentialInvocation {
  readonly operation: 'get' | 'store' | 'erase'
  readonly purpose: RepoTokenPurpose | null
}

function isRepoTokenPurpose(
  value: string
): value is RepoTokenPurpose {
  return REPO_TOKEN_PURPOSES.includes(value as RepoTokenPurpose)
}

/**
 * Git appends get/store/erase after the configured helper command, so an
 * explicit path-aware configuration looks like:
 * `!orizu git-credential --purpose=write`.
 *
 * Session credentials use the hosted runtime helper, which carries the
 * server-bound session ID. This local helper deliberately accepts only
 * sessionless developer read/write purposes.
 */
export function parseGitCredentialInvocation(
  args: readonly string[]
): GitCredentialInvocation | null {
  let operation: GitCredentialInvocation['operation'] | null = null
  let purpose: RepoTokenPurpose | null = null

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--purpose') {
      if (purpose !== null) return null
      const value = args[index + 1]
      if (!value || !isRepoTokenPurpose(value)) return null
      purpose = value
      index += 1
      continue
    }
    if (arg.startsWith('--purpose=')) {
      if (purpose !== null) return null
      const value = arg.slice('--purpose='.length)
      if (!isRepoTokenPurpose(value)) return null
      purpose = value
      continue
    }
    if (arg === 'get' || arg === 'store' || arg === 'erase') {
      if (operation !== null) return null
      operation = arg
      continue
    }
    return null
  }

  return operation === null ? null : { operation, purpose }
}

export async function runGitCredentialInvocation(
  args: readonly string[],
  io: GitCredentialIo
): Promise<number> {
  const invocation = parseGitCredentialInvocation(args)
  if (!invocation) {
    io.printErr('Invalid git-credential invocation')
    return 1
  }
  return runGitCredential(invocation.operation, {
    ...io,
    purpose: invocation.purpose ?? undefined,
  })
}

export function parseCredentialInput(stdin: string): Record<string, string> {
  const map: Record<string, string> = {}
  for (const rawLine of stdin.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (!line) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    map[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return map
}

/**
 * Walk up from `cwd` to the workspace root (the dir holding orizu.team.json) and
 * return its bound workspace id, or null if this is not an attached workspace.
 */
export function resolveAttachedWorkspaceId(cwd: string): string | null {
  let dir = cwd
  for (;;) {
    const manifestPath = join(dir, 'orizu.team.json')
    if (existsSync(manifestPath)) {
      const manifest = readJsonManifest(manifestPath)
      // `setup.attachedWorkspaceId` is the attachment id; `canonical.serviceId`
      // is a legacy duplicate kept only as a read fallback for old repos
      // (ALI-1075: fresh manifests carry no `canonical` block).
      const setup = manifest?.setup
      const attached =
        setup && typeof setup === 'object' && !Array.isArray(setup)
          ? (setup as Record<string, unknown>).attachedWorkspaceId
          : null
      if (typeof attached === 'string' && attached) return attached
      const canonical = manifest?.canonical
      const serviceId =
        canonical && typeof canonical === 'object' && !Array.isArray(canonical)
          ? (canonical as Record<string, unknown>).serviceId
          : null
      return typeof serviceId === 'string' && serviceId ? serviceId : null
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Resolve the workspace id, preferring an explicit override, then the
 * `ORIZU_WORKSPACE_ID` env var (set during `git clone` so the helper works
 * before the working tree — and thus orizu.team.json — exists), then the cwd
 * manifest walk for steady-state pull/push.
 */
export function resolveWorkspaceId(io: GitCredentialIo): string | null {
  if (io.workspaceId) return io.workspaceId
  const fromEnv = process.env.ORIZU_WORKSPACE_ID?.trim()
  if (fromEnv) return fromEnv
  return resolveAttachedWorkspaceId(io.cwd)
}

async function mintToken(
  fetcher: GitCredentialFetcher,
  workspaceId: string,
  purpose: RepoTokenPurpose,
  expectedRepoFullName: string
): Promise<{ ok: true; token: string } | { ok: false; status: number; error: string }> {
  const response = await fetcher(`/api/cli/workspaces/${encodeURIComponent(workspaceId)}/repo-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ purpose }),
  })
  if (response.ok) {
    let data: unknown
    try {
      data = await response.json()
    } catch {
      return {
        ok: false,
        status: response.status,
        error: 'Broker returned invalid JSON',
      }
    }
    if (typeof data !== 'object' || data === null) {
      return {
        ok: false,
        status: response.status,
        error: 'Broker returned an invalid GitHub credential',
      }
    }
    const credential = data as Record<string, unknown>
    if (
      !(
        credential.provider === undefined ||
        credential.provider === 'github'
      ) ||
      credential.remote !== undefined ||
      credential.repo !== expectedRepoFullName ||
      typeof credential.token !== 'string' ||
      credential.token.length === 0 ||
      credential.token.length > 512 ||
      /[\u0000-\u0020\u007f]/u.test(credential.token)
    ) {
      return {
        ok: false,
        status: response.status,
        error:
          'Broker returned a credential for a different repository provider or path',
      }
    }
    return { ok: true, token: credential.token }
  }
  let error = `status ${response.status}`
  try {
    const body = (await response.json()) as { error?: string }
    if (body.error) error = body.error
  } catch {
    // Non-JSON body; keep the status-based message.
  }
  return { ok: false, status: response.status, error }
}

function isArtifactsHost(host: string | undefined): boolean {
  if (!host) return false
  const normalized = host.toLowerCase()
  return ARTIFACTS_HOST.test(normalized)
}

function exactGithubRepoFullName(
  input: Record<string, string>
): string | null {
  const protocol = input.protocol?.toLowerCase()
  const host = input.host?.toLowerCase()
  const rawPath = input.path
  if (
    protocol !== 'https' ||
    host !== GITHUB_HOST ||
    !rawPath ||
    !SAFE_REMOTE_COMPONENT.test(rawPath)
  ) {
    return null
  }
  const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`
  try {
    const url = new URL(`https://${GITHUB_HOST}${path}`)
    if (
      url.origin !== `https://${GITHUB_HOST}` ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      url.pathname !== path
    ) {
      return null
    }
    const segments = url.pathname
      .slice(1)
      .split('/')
      .filter(Boolean)
    if (segments.length !== 2) return null
    const [owner, rawRepository] = segments
    const repository = rawRepository.endsWith('.git')
      ? rawRepository.slice(0, -4)
      : rawRepository
    if (
      !/^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/.test(owner) ||
      !/^[A-Za-z0-9_.-]{1,100}$/.test(repository)
    ) {
      return null
    }
    return `${owner}/${repository}`
  } catch {
    return null
  }
}

function exactArtifactsCredentialKey(
  input: Record<string, string>
): string | null {
  const protocol = input.protocol?.toLowerCase()
  const host = input.host?.toLowerCase()
  const rawPath = input.path
  if (
    protocol !== 'https' ||
    !host ||
    !isArtifactsHost(host) ||
    !rawPath ||
    !SAFE_REMOTE_COMPONENT.test(host) ||
    !SAFE_REMOTE_COMPONENT.test(rawPath)
  ) {
    return null
  }

  const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`
  try {
    const url = new URL(`https://${host}${path}`)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      url.hostname !== host ||
      !ARTIFACTS_HOST.test(url.hostname) ||
      !url.pathname.startsWith('/git/') ||
      !url.pathname.endsWith('.git') ||
      `${url.origin}${url.pathname}` !==
        `https://${host}${path}`
    ) {
      return null
    }
    return `${url.origin}${url.pathname}`
  } catch {
    return null
  }
}

type ArtifactsCredentialResult =
  | {
      readonly ok: true
      readonly username: 'x'
      readonly password: string
    }
  | {
      readonly ok: false
      readonly error: string
    }

async function mintArtifactsCredential(
  fetcher: GitCredentialFetcher,
  workspaceId: string,
  purpose: RepoTokenPurpose,
  expectedCredentialKey: string,
  nowMs: number
): Promise<ArtifactsCredentialResult> {
  const response = await fetcher(
    `/api/cli/workspaces/${encodeURIComponent(workspaceId)}/repo-token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purpose }),
    }
  )

  if (!response.ok) {
    return {
      ok: false,
      error: `repository credential service returned status ${response.status}`,
    }
  }

  let data: unknown
  try {
    data = await response.json()
  } catch {
    return {
      ok: false,
      error: 'repository credential service returned invalid JSON',
    }
  }
  if (typeof data !== 'object' || data === null) {
    return {
      ok: false,
      error: 'repository credential service returned an invalid credential',
    }
  }

  const credential = data as Record<string, unknown>
  const remote =
    typeof credential.remote === 'string'
      ? credential.remote
      : null
  let resolvedCredentialKey: string | null = null
  if (remote !== null) {
    try {
      const url = new URL(remote)
      if (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.port &&
        !url.search &&
        !url.hash &&
        ARTIFACTS_HOST.test(url.hostname) &&
        url.pathname.startsWith('/git/') &&
        url.pathname.endsWith('.git') &&
        url.toString() === remote
      ) {
        resolvedCredentialKey = `${url.origin}${url.pathname}`
      }
    } catch {
      resolvedCredentialKey = null
    }
  }

  if (resolvedCredentialKey !== expectedCredentialKey) {
    return {
      ok: false,
      error:
        'server-resolved repository does not match Git exact path',
    }
  }
  if (
    credential.provider !== 'cloudflare_artifacts' ||
    credential.username !== 'x' ||
    typeof credential.token !== 'string' ||
    !ARTIFACTS_PASSWORD.test(credential.token)
  ) {
    return {
      ok: false,
      error: 'repository credential service returned an invalid credential',
    }
  }
  const expiresAt =
    typeof credential.expiresAt === 'string'
      ? credential.expiresAt
      : ''
  const expiresAtMs = Date.parse(expiresAt)
  if (
    !Number.isSafeInteger(nowMs) ||
    !Number.isFinite(expiresAtMs) ||
    new Date(expiresAtMs).toISOString() !== expiresAt ||
    expiresAtMs <= nowMs ||
    expiresAtMs > nowMs + ARTIFACTS_MAX_EXPIRY_SKEW_MS
  ) {
    return {
      ok: false,
      error:
        'repository credential service returned an invalid credential expiry',
    }
  }

  return {
    ok: true,
    username: 'x',
    password: credential.token,
  }
}

export async function runGitCredential(op: string, io: GitCredentialIo): Promise<number> {
  // store/erase are no-ops: we never persist a credential to disk.
  if (op !== 'get') return 0

  const input = parseCredentialInput(io.stdin)
  const inputHost = input.host?.toLowerCase()

  // Only broker for the legacy GitHub host or the exact Artifacts service.
  // Anything else is git's own business.
  if (
    inputHost &&
    inputHost !== GITHUB_HOST &&
    !isArtifactsHost(inputHost)
  ) {
    return 0
  }

  const workspaceId = resolveWorkspaceId(io)
  if (!workspaceId) {
    // Unattached directory: stay silent so git falls through cleanly.
    return 0
  }

  const fetcher = io.fetcher ?? authedFetch

  if (isArtifactsHost(inputHost)) {
    if (!io.purpose) {
      io.printErr(
        'orizu git-credential: an Artifacts remote requires an explicit repository purpose'
      )
      return 1
    }
    const credentialKey = exactArtifactsCredentialKey(input)
    if (credentialKey === null) {
      io.printErr(
        'orizu git-credential: refusing Artifacts credential selection without an exact repository path'
      )
      return 1
    }

    const minted = await mintArtifactsCredential(
      fetcher,
      workspaceId,
      io.purpose,
      credentialKey,
      (io.nowMs ?? Date.now)()
    )
    if (!minted.ok) {
      io.printErr(
        `orizu git-credential: could not broker an Artifacts credential (${minted.error})`
      )
      return 1
    }
    io.print(`username=${minted.username}`)
    io.print(`password=${minted.password}`)
    io.print('')
    return 0
  }

  // Mint write first (curators/pushers), fall back to read on 403 (members).
  const expectedRepoFullName = exactGithubRepoFullName(input)
  if (!expectedRepoFullName) {
    io.printErr(
      'orizu git-credential: refusing GitHub credential selection without an exact repository path'
    )
    return 1
  }
  const primaryPurpose = io.purpose ?? 'write'
  let minted = await mintToken(
    fetcher,
    workspaceId,
    primaryPurpose,
    expectedRepoFullName
  )
  if (!io.purpose && !minted.ok && minted.status === 403) {
    minted = await mintToken(
      fetcher,
      workspaceId,
      'read',
      expectedRepoFullName
    )
  }

  if (!minted.ok) {
    io.printErr(
      `orizu git-credential: could not broker a token for this workspace (${minted.error}). ` +
        'Ensure you are logged in (`orizu login`) and a team admin/curator has provisioned the repo.'
    )
    return 0
  }

  io.print('username=x-access-token')
  io.print(`password=${minted.token}`)
  io.print('')
  return 0
}
