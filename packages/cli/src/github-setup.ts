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
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'

import { authedFetch } from './http.js'
import { assertWorkspaceDirUsable } from './workspace.js'

export type SetupFetcher = (path: string, init?: RequestInit) => Promise<Response>

/**
 * Strip terminal control characters from server-supplied strings before they
 * are printed (mirrors index.ts `sanitizeTerminalText`), so a hostile or
 * mangled provisioning `warnings[]`/`defaultBranch` value can't inject escape
 * sequences into the user's terminal.
 */
function sanitizeServerText(value: unknown): string {
  return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
}

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
// ALI-1141: long enough for a slow org-picker + repo-selection walk, but the
// wait MUST be finite — when the App is already installed in the target org,
// GitHub only offers "Configure" and never redirects to our setup callback, so
// an unbounded poll would spin forever. (Still under the server's 15-minute
// nonce TTL, so the poll times out before the server would report `expired`.)
const DEFAULT_POLL_TIMEOUT_MS = 600000
// ALI-1141: after this long with no callback, the likeliest cause is the
// already-installed org above — surface it instead of heartbeating silently.
const ALREADY_INSTALLED_HINT_MS = 90000

/**
 * Why the poll can never succeed when the App is already installed in the org
 * (ALI-1141): GitHub's `installations/new?state=` page then only offers
 * "Configure", and completing configuration does NOT redirect to the App's
 * Setup URL with our state nonce — the callback that flips the row out of
 * `pending` never fires. Printed as a mid-poll hint and folded into the
 * timeout error so the user is never left with an unexplained hang.
 */
function alreadyInstalledHintLines(teamSlug: string): string[] {
  return [
    '   ⚠ GitHub has not called back yet. The most likely cause: the Orizu GitHub',
    '     App is ALREADY INSTALLED in that org — GitHub then only offers',
    '     "Configure", and finishing configuration never notifies Orizu, so this',
    '     wait cannot succeed. Remedies:',
    '     • Install the App into a DIFFERENT GitHub org for this team (each org',
    '       installation can be linked to exactly one Orizu team).',
    '     • If the org is not linked to any Orizu team, uninstall the Orizu App',
    '       from the org (GitHub → org Settings → GitHub Apps) and re-run',
    `       \`orizu github link --team ${teamSlug}\` to do a fresh install.`,
  ]
}

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
  // Bug 2: personal accounts cannot host an auto-provisioned workbench.
  io.print('   • Install into a GitHub ORGANIZATION, not a personal account. Personal')
  io.print('     accounts are not supported for auto-provisioning; creating an org is free.')
  // Bug 4: repo selection guidance — GitHub forces picking at least one repo.
  io.print('   • On the "Repository access" step choose "Only select repositories" and pick')
  io.print('     any one repo (GitHub requires at least one). Orizu adds the workbench repo')
  io.print('     it creates automatically — do NOT choose "All repositories".')
  if (io.openUrl) {
    io.openUrl(installUrl)
    io.print('   Opened the install page in your browser.')
  } else {
    io.print('   Open the URL above and install the App, then return here.')
  }
  io.print(
    `   Waiting for you to finish installing in the browser… (Ctrl+C to abort; resume later with \`orizu github link --team ${teamSlug}\`).`
  )

  const now = io.now ?? (() => Date.now())
  const sleep = io.sleep ?? defaultSleep
  const interval = io.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const timeout = io.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
  const started = now()
  const deadline = started + timeout
  // Periodic heartbeat so a long install does not look hung; never echoes state.
  const HEARTBEAT_MS = 15000
  let lastHeartbeat = started
  let printedAlreadyInstalledHint = false

  for (;;) {
    const poll = await fetcher(`/api/cli/github/link?state=${encodeURIComponent(state)}`)
    if (poll.ok) {
      const data = (await poll.json()) as {
        status: string
        orgLogin?: string | null
        error?: string
      }
      if (data.status === 'active') {
        io.print(`   GitHub org connected${data.orgLogin ? ` (${data.orgLogin})` : ''}.`)
        return { status: 'active', orgLogin: data.orgLogin ?? null, alreadyLinked: false }
      }
      if (data.status === 'pending_confirmation') {
        return await confirmLink(teamSlug, data.orgLogin ?? null, io, fetcher)
      }
      // Distinguishable terminal errors (personal account / expired nonce): print
      // the server's reason and exit non-zero instead of polling until timeout.
      if (data.status === 'unsupported_account' || data.status === 'expired') {
        throw new Error(
          data.error ??
            `GitHub link could not be completed. Re-run \`orizu github link --team ${teamSlug}\`.`
        )
      }
      // status 'pending' → keep waiting.
    }
    if (now() >= deadline) {
      // Same actionable message as the mid-poll hint: an already-installed org
      // is the one known way to reach this timeout with nothing else wrong.
      throw new Error(
        `Timed out waiting for the GitHub App install to complete after ${Math.round(timeout / 60000)} minutes. ` +
          'If the Orizu GitHub App is already installed in that org, GitHub never notifies Orizu when you finish the "Configure" flow — ' +
          'install the App into a DIFFERENT GitHub org for this team (or uninstall it from the org first if no other Orizu team uses it). ' +
          `Resume with \`orizu github link --team ${teamSlug}\` after finishing the install.`
      )
    }
    if (!printedAlreadyInstalledHint && now() - started >= ALREADY_INSTALLED_HINT_MS) {
      for (const line of alreadyInstalledHintLines(teamSlug)) io.print(line)
      io.print(
        `   Still waiting (Ctrl+C to abort; resume later with \`orizu github link --team ${teamSlug}\`)…`
      )
      printedAlreadyInstalledHint = true
      lastHeartbeat = now()
    }
    if (now() - lastHeartbeat >= HEARTBEAT_MS) {
      io.print('   …still waiting for the GitHub install to complete.')
      lastHeartbeat = now()
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
  /** True when `targetDir` already holds the cloned workbench repo (an
   *  idempotent `orizu setup` re-run). Overridable for tests; defaults to a
   *  `.git` presence check. */
  repoAlreadyCloned?: (targetDir: string) => boolean
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
    const data = (await response.json()) as {
      repo: string
      defaultBranch?: string
      rulesetApplied?: boolean
      warnings?: string[]
    }
    repoFullName = data.repo
    provisioned = true

    if (data.rulesetApplied === true) {
      io.print(
        `   Default-branch protection applied (ruleset "orizu-default-branch-protection"${
          data.defaultBranch ? ` on ${sanitizeServerText(data.defaultBranch)}` : ''
        }).`
      )
    }
    for (const warning of data.warnings ?? []) {
      io.print(`   ⚠ ${sanitizeServerText(warning)}`)
    }
  }

  const cleanUrl = `https://github.com/${repoFullName}.git`

  const ensureOrizuDir = io.ensureOrizuDir ?? ((repoDir: string) => mkdirSync(join(repoDir, '.orizu'), { recursive: true }))

  // Idempotent re-run (ALI-1069): `orizu setup` in an ALREADY-attached workspace
  // reaches here with `targetDir` holding the prior clone (its `.git` plus the
  // committed orizu.team.json — `assertWorkspaceDirUsable` deliberately exempts
  // that dir as the idempotent case). `git clone` refuses ANY non-empty dir, so
  // an unconditional clone would abort the re-run with a misleading "not an empty
  // directory" error. Short-circuit: re-affirm the credential helper config
  // (idempotent) and return without recloning.
  const repoAlreadyCloned = io.repoAlreadyCloned ?? ((dir: string) => existsSync(join(dir, '.git')))
  if (repoAlreadyCloned(options.targetDir)) {
    io.print('   Workbench repo already attached — skipping clone.')
    gitOrThrow(io.git, ['config', 'credential.helper', CREDENTIAL_HELPER], { cwd: options.targetDir })
    gitOrThrow(io.git, ['config', 'credential.useHttpPath', 'true'], { cwd: options.targetDir })
    ensureOrizuDir(options.targetDir)
    io.print('   Attached. Configured the Orizu credential helper for git.')
    return { repoFullName, provisioned, targetDir: options.targetDir }
  }

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

  ensureOrizuDir(options.targetDir)

  io.print('   Attached. Configured the Orizu credential helper for git.')
  return { repoFullName, provisioned, targetDir: options.targetDir }
}

// -- Interactive setup dispatch (ALI-996 / WS-C crumb) ----------------------

function defaultGitRunner(args: string[], opts?: { cwd?: string }): GitRunResult {
  // Strip repo-context env (set by git when running inside hooks) so the
  // child git is scoped strictly to cwd/args — see daytona-slice-rehearsal.ts.
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  const result = spawnSync('git', args, { cwd: opts?.cwd, encoding: 'utf8', env })
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

  // The hosted paths (attach / provision-then-attach) clone the workbench repo
  // into targetDir, and `git clone` refuses ANY non-empty directory. Fail fast
  // here — before the provision call and the clone's git invocation, so no
  // partial server/git state is created — with a friendly, actionable message
  // (including the `--local` escape hatch). Only this real-clone path is gated;
  // --local, --skip-login (not signed in), and a declined connect prompt never
  // reach here, so they scaffold locally unblocked.
  assertWorkspaceDirUsable(input.targetDir)

  const result = await runHostedAttach(
    { workspaceId: workspace.id, repoFullName, targetDir: input.targetDir },
    { print: io.print, fetcher, git: io.git ?? defaultGitRunner, ensureOrizuDir: io.ensureOrizuDir }
  )
  return { mode, attached: true, repoFullName: result.repoFullName }
}
