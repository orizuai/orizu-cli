/**
 * GitHub link + hosted-repo attach for `orizu setup` (ALI-971 / WS-C + WS-D).
 *
 * Pure logic + injected HTTP/git/io so index.ts stays thin and the flows are
 * unit-testable without a real browser, server, or git. Two responsibilities:
 *
 *   1. `runGithubLink` — the REQUIRED team-setup link step: POST the link route,
 *      open/print the App-install URL, then poll until the org is connected
 *      (with a timeout + resume guidance).
 *   2. `runHostedAttach` — clone the provisioned workbench repo and wire the
 *      repo-local git credential helper so future pull/push flow through the
 *      Orizu broker. Never stores a long-lived credential: the clone uses a
 *      one-shot brokered token embedded only in the transient clone URL, which
 *      is immediately rewritten to a clean origin.
 */

import { spawnSync } from 'child_process'
import { mkdirSync } from 'fs'
import { join } from 'path'

import { authedFetch } from './http.js'

export type SetupFetcher = (path: string, init?: RequestInit) => Promise<Response>

export interface GithubLinkIo {
  print: (line: string) => void
  fetcher?: SetupFetcher
  openUrl?: (url: string) => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  pollIntervalMs?: number
  pollTimeoutMs?: number
  /**
   * Second-factor confirmation of the bound org (confused-deputy defense). The
   * callback binds the installation but parks it in `pending_confirmation`; this
   * asks the human to confirm the org they were shown before it becomes active.
   */
  confirm?: (orgLogin: string | null) => Promise<boolean>
}

export interface GithubLinkResult {
  status: 'active'
  orgLogin: string | null
  alreadyLinked: boolean
}

const DEFAULT_POLL_INTERVAL_MS = 2000
const DEFAULT_POLL_TIMEOUT_MS = 180000

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string }
    if (body.error) return body.error
  } catch {
    // fall through to status text
  }
  return `status ${response.status}`
}

/**
 * Begin (or resume) the required GitHub link for a team and block until the
 * customer org is connected. Throws with resume guidance on timeout.
 */
export async function runGithubLink(teamSlug: string, io: GithubLinkIo): Promise<GithubLinkResult> {
  const fetcher = io.fetcher ?? authedFetch

  const start = await fetcher('/api/cli/github/link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamSlug }),
  })

  if (start.status === 409) {
    io.print('   GitHub org already connected for this team.')
    return { status: 'active', orgLogin: null, alreadyLinked: true }
  }
  if (!start.ok) {
    throw new Error(`Failed to start GitHub link: ${await readError(start)}`)
  }

  const { installUrl, state } = (await start.json()) as { installUrl: string; state: string }

  io.print('   Connect your team GitHub org by installing the Orizu GitHub App:')
  io.print(`     ${installUrl}`)
  if (io.openUrl) {
    io.openUrl(installUrl)
    io.print('   Opened the install page in your browser. Waiting for you to finish...')
  } else {
    io.print('   Open the URL above, install the App, then return here. Waiting...')
  }

  const now = io.now ?? (() => Date.now())
  const sleep = io.sleep ?? defaultSleep
  const interval = io.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const timeout = io.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
  const deadline = now() + timeout

  for (;;) {
    const poll = await fetcher(`/api/cli/github/link?state=${encodeURIComponent(state)}`)
    if (poll.ok) {
      const data = (await poll.json()) as { status: string; orgLogin?: string | null }
      if (data.status === 'active') {
        io.print(`   GitHub org connected${data.orgLogin ? ` (${data.orgLogin})` : ''}.`)
        return { status: 'active', orgLogin: data.orgLogin ?? null, alreadyLinked: false }
      }
      if (data.status === 'pending_confirmation') {
        return await confirmLink(teamSlug, data.orgLogin ?? null, io, fetcher)
      }
    }
    if (now() >= deadline) {
      throw new Error(
        'Timed out waiting for the GitHub App install to complete. ' +
          `Resume with \`orizu github link --team ${teamSlug}\` after finishing the install.`
      )
    }
    await sleep(interval)
  }
}

/**
 * The install callback bound an org but left the row `pending_confirmation`.
 * Confirm the org with the human (second factor), then complete via the
 * authenticated confirm endpoint — this is the only path to `active`.
 */
async function confirmLink(
  teamSlug: string,
  orgLogin: string | null,
  io: GithubLinkIo,
  fetcher: SetupFetcher
): Promise<GithubLinkResult> {
  io.print(`   GitHub reported installation on org: ${orgLogin ?? '(unknown)'}`)
  if (!io.confirm) {
    throw new Error(
      `Org ${orgLogin ?? '(unknown)'} is bound but needs confirmation. ` +
        `Run \`orizu github link --team ${teamSlug}\` interactively to confirm.`
    )
  }
  const approved = await io.confirm(orgLogin)
  if (!approved) {
    throw new Error(
      `Did not confirm org ${orgLogin ?? '(unknown)'}. ` +
        `Re-run \`orizu github link --team ${teamSlug}\` to link the correct org.`
    )
  }
  const resp = await fetcher('/api/cli/github/link/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamSlug, orgLogin }),
  })
  if (!resp.ok) {
    throw new Error(`Failed to confirm GitHub link: ${await readError(resp)}`)
  }
  const confirmed = (await resp.json()) as { orgLogin?: string | null }
  io.print(`   GitHub org connected (${confirmed.orgLogin ?? orgLogin ?? 'linked'}).`)
  return { status: 'active', orgLogin: confirmed.orgLogin ?? orgLogin, alreadyLinked: false }
}

// -- Hosted attach ----------------------------------------------------------

export type SetupMode = 'local' | 'attach' | 'provision-then-attach'

/**
 * Decide how `orizu setup` should materialize the workspace. `--local` (or the
 * absence of a linked org) keeps Phase 1 scaffolding; a linked org with a
 * provisioned repo attaches by clone; a linked org without a repo provisions
 * first, then attaches.
 */
export function decideSetupMode(input: {
  local: boolean
  activeInstallation: boolean
  repoFullName: string | null
}): SetupMode {
  if (input.local || !input.activeInstallation) return 'local'
  return input.repoFullName ? 'attach' : 'provision-then-attach'
}

export interface GitRunResult {
  status: number
  stderr?: string
}

export interface GitRunOpts {
  cwd?: string
  env?: Record<string, string>
}

export type GitRunner = (args: string[], opts?: GitRunOpts) => GitRunResult

export interface HostedAttachIo {
  print: (line: string) => void
  fetcher?: SetupFetcher
  git: GitRunner
  /** Overridable for tests; defaults to creating `.orizu/` on disk. */
  ensureOrizuDir?: (repoDir: string) => void
}

export interface HostedAttachOptions {
  workspaceId: string
  repoFullName: string | null
  targetDir: string
}

export interface HostedAttachResult {
  repoFullName: string
  provisioned: boolean
  targetDir: string
}

function gitOrThrow(git: GitRunner, args: string[], opts?: GitRunOpts) {
  const result = git(args, opts)
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr || `exit ${result.status}`}`)
  }
}

const CREDENTIAL_HELPER = '!orizu git-credential'

/**
 * Provision-if-needed, then clone with the Orizu credential helper already
 * configured so the brokered token NEVER touches argv, the clone URL, or
 * .git/config. The helper resolves the workspace during clone via the
 * `ORIZU_WORKSPACE_ID` env var (the working tree — and orizu.team.json — does
 * not exist yet), then mints on demand. Repo-local config persists the helper
 * for subsequent pull/push, which resolve the workspace from cwd.
 */
export async function runHostedAttach(
  options: HostedAttachOptions,
  io: HostedAttachIo
): Promise<HostedAttachResult> {
  const fetcher = io.fetcher ?? authedFetch
  let repoFullName = options.repoFullName
  let provisioned = false

  if (!repoFullName) {
    io.print('   Provisioning the hosted workbench repo...')
    const response = await fetcher(
      `/api/cli/workspaces/${encodeURIComponent(options.workspaceId)}/provision-repo`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }
    )
    if (!response.ok) {
      throw new Error(`Failed to provision workbench repo: ${await readError(response)}`)
    }
    const data = (await response.json()) as { repo: string }
    repoFullName = data.repo
    provisioned = true
  }

  const cleanUrl = `https://github.com/${repoFullName}.git`

  io.print(`   Cloning ${repoFullName}...`)
  // Clone with the helper inline + the workspace id in the env so the token is
  // brokered on demand and never materializes in the URL or on disk.
  gitOrThrow(
    io.git,
    [
      '-c',
      `credential.helper=${CREDENTIAL_HELPER}`,
      '-c',
      'credential.useHttpPath=true',
      'clone',
      cleanUrl,
      options.targetDir,
    ],
    { env: { ORIZU_WORKSPACE_ID: options.workspaceId } }
  )
  // Persist the helper repo-locally for future pull/push (cwd-resolved).
  gitOrThrow(io.git, ['config', 'credential.helper', CREDENTIAL_HELPER], { cwd: options.targetDir })
  gitOrThrow(io.git, ['config', 'credential.useHttpPath', 'true'], { cwd: options.targetDir })

  const ensureOrizuDir = io.ensureOrizuDir ?? ((repoDir: string) => mkdirSync(join(repoDir, '.orizu'), { recursive: true }))
  ensureOrizuDir(options.targetDir)

  io.print('   Attached. Configured the Orizu credential helper for git.')
  return { repoFullName, provisioned, targetDir: options.targetDir }
}

// -- Interactive setup dispatch (ALI-996 / WS-C crumb) ----------------------

function defaultGitRunner(args: string[], opts?: { cwd?: string }): GitRunResult {
  const result = spawnSync('git', args, { cwd: opts?.cwd, encoding: 'utf8' })
  return { status: result.status ?? 1, stderr: result.stderr }
}

export interface InteractiveHostedSetupInput {
  teamSlug: string
  targetDir: string
  /** The `--local` flag: forces Phase-1 scaffolding regardless of linkage. */
  local: boolean
  /** True once the required github-link step has connected an active org. */
  activeInstallation: boolean
}

export interface InteractiveHostedSetupIo {
  print: (line: string) => void
  fetcher?: SetupFetcher
  git?: GitRunner
  ensureOrizuDir?: (repoDir: string) => void
}

export interface InteractiveHostedSetupResult {
  mode: SetupMode
  /** True when the hosted repo was cloned; false means the caller scaffolds locally. */
  attached: boolean
  repoFullName: string | null
}

/**
 * Bridge the required github-link step to the hosted attach. Create-or-attaches
 * the server workspace (whose response now surfaces repoProvider/repoFullName —
 * ALI-972), then routes through the already-tested `decideSetupMode`:
 *   - `local`                 → returns `attached: false`; the caller scaffolds.
 *   - `attach` / `provision-then-attach` → clones (provisioning first if needed)
 *     via `runHostedAttach` and returns `attached: true`.
 */
export async function runInteractiveHostedSetup(
  input: InteractiveHostedSetupInput,
  io: InteractiveHostedSetupIo
): Promise<InteractiveHostedSetupResult> {
  const fetcher = io.fetcher ?? authedFetch

  const response = await fetcher('/api/cli/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamSlug: input.teamSlug, name: input.teamSlug, slug: input.teamSlug }),
  })
  if (!response.ok) {
    throw new Error(`Failed to attach workspace: ${await readError(response)}`)
  }
  const data = (await response.json()) as {
    workspace?: { id?: string; repoFullName?: string | null }
  }
  const workspace = data.workspace
  if (!workspace?.id) {
    throw new Error('Workspace attach response did not include an id')
  }

  const repoFullName = workspace.repoFullName ?? null
  const mode = decideSetupMode({
    local: input.local,
    activeInstallation: input.activeInstallation,
    repoFullName,
  })
  if (mode === 'local') {
    return { mode, attached: false, repoFullName: null }
  }

  const result = await runHostedAttach(
    { workspaceId: workspace.id, repoFullName, targetDir: input.targetDir },
    { print: io.print, fetcher, git: io.git ?? defaultGitRunner, ensureOrizuDir: io.ensureOrizuDir }
  )
  return { mode, attached: true, repoFullName: result.repoFullName }
}
