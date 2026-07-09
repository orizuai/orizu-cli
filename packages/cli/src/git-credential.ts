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
}

const GITHUB_HOST = 'github.com'

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
  purpose: 'read' | 'write'
): Promise<{ ok: true; token: string } | { ok: false; status: number; error: string }> {
  const response = await fetcher(`/api/cli/workspaces/${encodeURIComponent(workspaceId)}/repo-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ purpose }),
  })
  if (response.ok) {
    const data = (await response.json()) as { token?: string }
    if (data.token) return { ok: true, token: data.token }
    return { ok: false, status: response.status, error: 'Broker returned no token' }
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

export async function runGitCredential(op: string, io: GitCredentialIo): Promise<number> {
  // store/erase are no-ops: we never persist a credential to disk.
  if (op !== 'get') return 0

  const input = parseCredentialInput(io.stdin)

  // Only broker for github.com; anything else is git's own business.
  if (input.host && input.host !== GITHUB_HOST) return 0

  const workspaceId = resolveWorkspaceId(io)
  if (!workspaceId) {
    // Unattached directory: stay silent so git falls through cleanly.
    return 0
  }

  const fetcher = io.fetcher ?? authedFetch

  // Mint write first (curators/pushers), fall back to read on 403 (members).
  let minted = await mintToken(fetcher, workspaceId, 'write')
  if (!minted.ok && minted.status === 403) {
    minted = await mintToken(fetcher, workspaceId, 'read')
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
