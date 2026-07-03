/**
 * Daytona thin-slice load path — pure step logic (ALI-973 / WS-F).
 *
 * smoke.ts-style: an importable eight-step workflow with an injected fetcher
 * factory + an injected `SandboxProvider` (ADR-003 seam). The `scripts/daytona-
 * workbench-slice.mjs` driver supplies a live-server fetcher + a real provider;
 * the unit test and the local-sim rehearsal supply an in-memory API fake + the
 * local-sim provider. No process/argv/print here.
 *
 * The slice proves the full hosted-agent load path against the GitHub-hosted
 * repo, deliberately thin — its purpose is to pin the token-broker API shape
 * before Phase 3:
 *   1. resolve workspace + start a session on its own repo branch,
 *   2. create a sandbox via the provider,
 *   3. mint a READ token and clone the session branch INSIDE the sandbox,
 *   4. read + parse the root manifests (orizu.team.json, schemaVersion),
 *   5. resolve one object ref WITHOUT committing bytes (falls back to proving
 *      `.orizu/` is the git-ignored materialization target when the exemplar
 *      workspace carries no object refs),
 *   6. write a small generated file + commit inside the sandbox,
 *   7. mint a WRITE token, push the session branch, revoke BOTH tokens,
 *   8. token-hygiene sweep (no token residue on the sandbox fs), then finish-
 *      branch → approve → apply via the API, then destroy the sandbox.
 */

import { WORKSPACE_SCHEMA_VERSION } from './workspace.js'
import type { SandboxProvider, SandboxProviderKind, SandboxSession } from './sandbox-provider.js'

export type SliceFetcher = (path: string, init?: RequestInit) => Promise<Response>

export interface SliceConfig {
  teamSlug: string
  projectSlug: string
  workspaceSlug: string
}

export interface SliceStepPlan {
  index: number
  key: string
  title: string
  plan: string
}

export interface SliceStepReport {
  index: number
  key: string
  title: string
  ok: boolean
  detail: string
  durationMs: number
}

export interface HygieneFinding {
  location: string
  marker: string
}

export interface SliceReport {
  ok: boolean
  provider: SandboxProviderKind
  steps: SliceStepReport[]
  failedStep: SliceStepReport | null
  totalMs: number
  hygiene: { clean: boolean; findings: HygieneFinding[] } | null
  ids: {
    workspaceId?: string
    sessionId?: string
    branch?: string
    repo?: string
    sandboxId?: string
    readMintId?: string
    writeMintId?: string
    manifestId?: string
    commitSha?: string
    mergeOutcome?: string
    /** Set on the error path when a session branch was pushed but the run did
     *  not reach the merge — names the branch left on the remote for cleanup. */
    orphanedBranch?: string
  }
}

export interface SliceHooks {
  /** Test seam: run after commit/push, immediately BEFORE the hygiene sweep.
   *  Used to plant a credential so the sweep's detection power is provable. */
  beforeHygiene?: (session: SandboxSession, ctx: { repoPath: string }) => Promise<void> | void
}

export interface RunSliceOptions {
  config: SliceConfig
  makeFetcher: () => SliceFetcher
  provider: SandboxProvider
  /** Map the broker's repo full-name to a clone URL the provider understands.
   *  Live: `https://github.com/<repo>.git`. Local-sim: the bare repo path. */
  resolveCloneUrl: (repo: string) => string
  now?: () => number
  onStep?: (step: SliceStepReport) => void
  keep?: boolean
  generatedFileName?: string
  generatedFileBody?: string
  hooks?: SliceHooks
}

const REPO_DIR = 'repo'
const DEFAULT_GENERATED_FILE = 'orizu-slice-note.md'

const STEP_PLAN: ReadonlyArray<{ key: string; title: string; plan: string }> = [
  { key: 'session', title: 'Resolve workspace + start session branch', plan: 'POST /api/cli/workspaces (idempotent) then POST .../sessions { repoBranch }' },
  { key: 'sandbox', title: 'Create sandbox via provider', plan: 'provider.createSandbox()' },
  { key: 'clone', title: 'Mint read token + clone session branch', plan: 'POST .../repo-token { read } then sandbox.gitClone(branch)' },
  { key: 'manifests', title: 'Read + parse root manifests', plan: 'sandbox.readFile(orizu.team.json) — schemaVersion check' },
  { key: 'objectref', title: 'Resolve object ref (no bytes in git)', plan: 'materialize into .orizu/ (git-ignored) — bulk bytes stay out of git' },
  { key: 'write', title: 'Write + commit generated file', plan: 'sandbox.writeFile + git commit inside the sandbox' },
  { key: 'push', title: 'Mint write token + push; revoke tokens', plan: 'POST .../repo-token { write }, gitPush, DELETE both mints' },
  { key: 'promote', title: 'Hygiene sweep + finish-branch + approve + apply + destroy', plan: 'sweep (no residue) → finish-branch → approve → apply → destroy' },
]

export function planSliceSteps(): SliceStepPlan[] {
  return STEP_PLAN.map((step, i) => ({ index: i + 1, key: step.key, title: step.title, plan: step.plan }))
}

function titleFor(key: string): string {
  return STEP_PLAN.find(step => step.key === key)?.title ?? key
}

function indexFor(key: string): number {
  return STEP_PLAN.findIndex(step => step.key === key) + 1
}

// -- Provider selection ------------------------------------------------------

export interface ProviderSelectionInput {
  providerFlag?: string | null
  hasDaytonaKey: boolean
}

/**
 * Resolve the provider kind. An explicit `--provider` flag always wins; with no
 * flag the default is `local-sim` when DAYTONA_API_KEY is absent, and `daytona`
 * when it is present (the live run is founder-gated by that key).
 */
export function selectProviderKind(input: ProviderSelectionInput): SandboxProviderKind {
  const flag = input.providerFlag?.trim().toLowerCase()
  if (flag === 'daytona' || flag === 'local-sim') {
    return flag
  }
  if (flag) {
    throw new Error(`Unknown --provider "${input.providerFlag}". Use "daytona" or "local-sim".`)
  }
  return input.hasDaytonaKey ? 'daytona' : 'local-sim'
}

// -- HTTP helpers ------------------------------------------------------------

async function readBody(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>
  } catch {
    return {}
  }
}

async function errorMessage(response: Response): Promise<string> {
  const body = await readBody(response.clone())
  const error = typeof body.error === 'string' ? body.error : null
  return error || response.statusText || String(response.status)
}

async function postJson(
  fetcher: SliceFetcher,
  path: string,
  payload: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetcher(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    throw new Error(`${path} failed (${response.status}): ${await errorMessage(response)}`)
  }
  return { status: response.status, body: await readBody(response) }
}

async function deleteJson(
  fetcher: SliceFetcher,
  path: string,
  payload: Record<string, unknown>
): Promise<void> {
  const response = await fetcher(path, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    throw new Error(`${path} (revoke) failed (${response.status}): ${await errorMessage(response)}`)
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} missing from response`)
  }
  return value
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} missing from response`)
  }
  return value as Record<string, unknown>
}

interface RepoTokenMint {
  token: string
  mintId: string
  repo: string
  expiresAt: string | null
}

async function mintRepoToken(
  fetcher: SliceFetcher,
  workspaceId: string,
  purpose: 'read' | 'write',
  sessionId: string
): Promise<RepoTokenMint> {
  const { body } = await postJson(fetcher, `/api/cli/workspaces/${encodeURIComponent(workspaceId)}/repo-token`, {
    purpose,
    sessionId,
  })
  return {
    token: requireString(body.token, `${purpose} token`),
    mintId: requireString(body.mintId, `${purpose} mintId`),
    repo: requireString(body.repo, `${purpose} repo`),
    expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : null,
  }
}

// -- Token-hygiene sweep -----------------------------------------------------

export interface HygieneProbe {
  location: string
  /** Shell command whose stdout is scanned for tokens + markers. */
  command: string
}

/**
 * The list of places a short-lived git token can leak inside a sandbox after a
 * transient clone+push. List-driven so it is trivial to extend. `${repo}` is
 * substituted with the repo path. Ordered from the repo-local stores outward to
 * global config, the credential cache, the reflog, shell history, and the live
 * process listing / argv — the exact surfaces the Daytona-support question names.
 */
export function tokenLeakProbes(repoPath: string): HygieneProbe[] {
  const R = repoPath
  return [
    { location: `${R}/.git/config`, command: `cat ${R}/.git/config 2>/dev/null || true` },
    { location: `${R}/.git/logs (reflog)`, command: `find ${R}/.git/logs -type f -exec cat {} + 2>/dev/null || true` },
    { location: '~/.git-credentials', command: 'cat "$HOME/.git-credentials" 2>/dev/null || true' },
    { location: '~/.gitconfig (global)', command: 'cat "$HOME/.gitconfig" 2>/dev/null || true' },
    { location: 'git credential cache/store', command: 'cat "$HOME/.cache/git/credential/"* "${XDG_CACHE_HOME:-$HOME/.cache}/git/credential/"* 2>/dev/null || true' },
    { location: 'shell history', command: 'cat "$HOME/.bash_history" "$HOME/.zsh_history" 2>/dev/null || true' },
    { location: 'process listing / argv', command: 'ps -eo args 2>/dev/null || ps aux 2>/dev/null || true' },
    { location: 'process env', command: 'env' },
  ]
}

/**
 * Grep the sandbox filesystem + process table for token values and the
 * `x-access-token` marker across every known leak surface (see `tokenLeakProbes`).
 * Returns every finding; an empty array means the transient operations left no
 * residue. This is the load-bearing check the whole slice exists to make.
 *
 * NOTE (local-sim): the reflog/config/credential-store/history probes run
 * meaningfully in local-sim, but `ps`/argv coverage is only decisive on the live
 * Daytona run (local-sim runs the git clone via a child process on the host, not
 * inside an isolated PID namespace). The WS-F memo marks that probe live-only.
 */
export async function sweepForTokenResidue(
  session: SandboxSession,
  opts: { tokens: string[]; repoPath: string; markers?: string[]; probes?: HygieneProbe[] }
): Promise<HygieneFinding[]> {
  const markers = opts.markers ?? ['x-access-token']
  const tokens = opts.tokens.filter(token => token.length > 0)
  const probes = opts.probes ?? tokenLeakProbes(opts.repoPath)

  const findings: HygieneFinding[] = []
  for (const probe of probes) {
    const { stdout } = await session.exec(probe.command)
    for (const token of tokens) {
      if (stdout.includes(token)) {
        findings.push({ location: probe.location, marker: 'token-value' })
      }
    }
    for (const marker of markers) {
      if (stdout.includes(marker)) {
        findings.push({ location: probe.location, marker })
      }
    }
  }
  return findings
}

// -- The workflow ------------------------------------------------------------

/**
 * Run a command in the sandbox and throw on a non-zero (or missing) exit code,
 * surfacing captured stderr so a live git failure does not read as success.
 */
async function execChecked(
  session: SandboxSession,
  command: string,
  opts: { cwd?: string; label: string }
): Promise<{ stdout: string; exitCode: number; stderr?: string }> {
  const result = await session.exec(command, opts.cwd ? { cwd: opts.cwd } : undefined)
  if (result.exitCode !== 0) {
    const detail = (result.stderr && result.stderr.trim()) || result.stdout.trim() || `exit ${result.exitCode}`
    throw new Error(`${opts.label} failed inside the sandbox: ${detail}`)
  }
  return result
}

export async function runDaytonaSlice(opts: RunSliceOptions): Promise<SliceReport> {
  const { config, provider } = opts
  const fetcher = opts.makeFetcher()
  const now = opts.now ?? (() => Date.now())
  const steps: SliceStepReport[] = []
  const ids: SliceReport['ids'] = {}
  const generatedName = opts.generatedFileName ?? DEFAULT_GENERATED_FILE
  const generatedBody =
    opts.generatedFileBody ??
    `# Orizu Daytona slice\n\nGenerated inside the sandbox by the WS-F load-path slice.\nprovider=${provider.kind}\n`

  let hygiene: SliceReport['hygiene'] = null
  let session: SandboxSession | null = null
  // Token values live only in these locals — never on the report, so a
  // serialized SliceReport can never carry a live credential.
  let readToken = ''
  let writeToken = ''
  const startedAll = now()

  const step = async (
    key: string,
    fn: () => Promise<string>
  ): Promise<void> => {
    const startedAt = now()
    const detail = await fn()
    const report: SliceStepReport = {
      index: indexFor(key),
      key,
      title: titleFor(key),
      ok: true,
      detail,
      durationMs: now() - startedAt,
    }
    steps.push(report)
    opts.onStep?.(report)
  }

  try {
    // 1 — Workspace resolve-or-attach, then a session on its own repo branch.
    await step('session', async () => {
      const workspace = await postJson(fetcher, '/api/cli/workspaces', {
        teamSlug: config.teamSlug,
        name: config.workspaceSlug,
        slug: config.workspaceSlug,
      })
      const workspaceId = requireString(requireObject(workspace.body.workspace, 'workspace').id, 'workspace id')
      ids.workspaceId = workspaceId

      const sessionResp = await postJson(fetcher, `/api/cli/workspaces/${encodeURIComponent(workspaceId)}/sessions`, {
        projectSlug: config.projectSlug,
        repoBranch: true,
        clientInfo: { source: 'orizu-daytona-slice', provider: provider.kind },
      })
      const sessionRow = requireObject(sessionResp.body.session, 'session')
      const sessionId = requireString(sessionRow.id, 'session id')
      const branch = requireString(sessionRow.repoBranch, 'session repoBranch')
      ids.sessionId = sessionId
      ids.branch = branch
      return `workspace ${workspaceId}; session ${sessionId} on ${branch}`
    })

    // 2 — Create the sandbox via the provider seam.
    await step('sandbox', async () => {
      session = await provider.createSandbox({ language: 'typescript', labels: { orizu: 'daytona-slice' } })
      ids.sandboxId = session.id
      return `${provider.kind} sandbox ${session.id}`
    })

    // 3 — Mint a READ token and clone the session branch INSIDE the sandbox.
    await step('clone', async () => {
      const box = session as SandboxSession
      const read = await mintRepoToken(fetcher, ids.workspaceId!, 'read', ids.sessionId!)
      ids.readMintId = read.mintId
      ids.repo = read.repo
      readToken = read.token
      await box.gitClone({
        url: opts.resolveCloneUrl(read.repo),
        path: REPO_DIR,
        branch: ids.branch,
        username: 'x-access-token',
        password: read.token,
      })
      return `cloned ${read.repo}@${ids.branch} with a read mint (${read.mintId})`
    })

    // 4 — Read + parse the root manifests.
    await step('manifests', async () => {
      const box = session as SandboxSession
      const manifestPath = `${REPO_DIR}/orizu.team.json`
      if (!(await box.fileExists(manifestPath))) {
        throw new Error('orizu.team.json is missing from the cloned repo root')
      }
      const raw = await box.readFile(manifestPath)
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>
      } catch (error) {
        throw new Error(`orizu.team.json did not parse: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (parsed.schemaVersion !== WORKSPACE_SCHEMA_VERSION) {
        throw new Error(`orizu.team.json schemaVersion is ${String(parsed.schemaVersion)}, expected ${WORKSPACE_SCHEMA_VERSION}`)
      }
      return `orizu.team.json parsed; schemaVersion=${WORKSPACE_SCHEMA_VERSION} kind=${String(parsed.kind)}`
    })

    // 5 — Resolve one object ref WITHOUT committing bytes to git. The exemplar
    // workspace carries no object refs (canonical.objectRef=null), so we prove
    // the invariant instead: `.orizu/` is the git-ignored materialization target.
    await step('objectref', async () => {
      const box = session as SandboxSession
      const gitignore = await box.readFile(`${REPO_DIR}/.gitignore`)
      if (!gitignore.includes('.orizu')) {
        throw new Error('.gitignore does not ignore .orizu/ — bulk bytes could leak into git')
      }
      // Materialize a would-be object payload into .orizu/ and confirm git
      // ignores it (bytes stay out of the commit).
      await execChecked(box, 'mkdir -p .orizu && printf "object-ref-materialization" > .orizu/slice-object.bin', {
        cwd: REPO_DIR,
        label: 'object-ref materialization',
      })
      const status = await execChecked(box, 'git status --porcelain', { cwd: REPO_DIR, label: 'git status' })
      if (status.stdout.includes('.orizu')) {
        throw new Error('.orizu/ payload showed up in git status — it must be ignored')
      }
      return 'no object refs in exemplar; verified .orizu/ is the git-ignored materialization target'
    })

    // 6 — Write a small generated file + commit inside the sandbox.
    await step('write', async () => {
      const box = session as SandboxSession
      await box.writeFile(`${REPO_DIR}/${generatedName}`, generatedBody)
      await execChecked(box, `git add ${generatedName}`, { cwd: REPO_DIR, label: 'git add' })
      await execChecked(
        box,
        `git -c user.email=orizu-slice@orizu.local -c user.name="Orizu Slice" commit -m "chore: WS-F slice generated ${generatedName}"`,
        { cwd: REPO_DIR, label: 'git commit' }
      )
      const sha = (await execChecked(box, 'git rev-parse HEAD', { cwd: REPO_DIR, label: 'git rev-parse' })).stdout.trim()
      ids.commitSha = sha
      return `committed ${generatedName} (${sha.slice(0, 10)})`
    })

    // 7 — Mint a WRITE token, push the session branch, then revoke BOTH tokens.
    await step('push', async () => {
      const box = session as SandboxSession
      const write = await mintRepoToken(fetcher, ids.workspaceId!, 'write', ids.sessionId!)
      ids.writeMintId = write.mintId
      writeToken = write.token
      await box.gitPush({ path: REPO_DIR, username: 'x-access-token', password: write.token })

      // Early revocation of both mints (60-min TTL is only the backstop).
      await deleteJson(fetcher, `/api/cli/workspaces/${encodeURIComponent(ids.workspaceId!)}/repo-token`, {
        mintId: ids.readMintId,
        token: readToken,
      })
      await deleteJson(fetcher, `/api/cli/workspaces/${encodeURIComponent(ids.workspaceId!)}/repo-token`, {
        mintId: write.mintId,
        token: write.token,
      })
      return `pushed ${ids.branch}; revoked read+write mints (${ids.readMintId}, ${write.mintId})`
    })

    // 8 — Hygiene sweep, then finish-branch → approve → apply, then destroy.
    await step('promote', async () => {
      const box = session as SandboxSession
      if (opts.hooks?.beforeHygiene) {
        await opts.hooks.beforeHygiene(box, { repoPath: REPO_DIR })
      }
      const findings = await sweepForTokenResidue(box, {
        tokens: [readToken, writeToken],
        repoPath: REPO_DIR,
      })
      hygiene = { clean: findings.length === 0, findings }
      if (findings.length > 0) {
        const where = findings.map(f => `${f.location}:${f.marker}`).join(', ')
        throw new Error(`token residue found on the sandbox filesystem: ${where}`)
      }

      const finish = await postJson(fetcher, `/api/cli/sessions/${encodeURIComponent(ids.sessionId!)}/finish-branch`, {
        projectSlug: config.projectSlug,
      })
      const outcome = String(finish.body.outcome)
      if (outcome !== 'manifest') {
        throw new Error(`finish-branch expected a manifest (branch had a commit) but returned "${outcome}"`)
      }
      const manifest = requireObject(finish.body.manifest, 'manifest')
      const manifestId = requireString(manifest.id, 'manifest id')
      ids.manifestId = manifestId

      const actionPath = `/api/cli/promotion-manifests/${encodeURIComponent(manifestId)}`
      await postJson(fetcher, actionPath, { action: 'approve' })
      const applied = await postJson(fetcher, actionPath, { action: 'apply' })
      const appliedManifest = requireObject(applied.body.manifest, 'manifest')
      ids.mergeOutcome = String(appliedManifest.status ?? 'applied')

      if (!opts.keep) {
        await box.destroy()
      }
      return `hygiene clean; manifest ${manifestId} applied (${ids.mergeOutcome})${opts.keep ? '; sandbox kept' : '; sandbox destroyed'}`
    })

    return {
      ok: true,
      provider: provider.kind,
      steps,
      failedStep: null,
      totalMs: now() - startedAll,
      hygiene,
      ids,
    }
  } catch (error) {
    const key = STEP_PLAN[steps.length]?.key ?? 'unknown'
    const failedStep: SliceStepReport = {
      index: indexFor(key),
      key,
      title: titleFor(key),
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      durationMs: 0,
    }
    // Pushed-branch cleanup: if a session branch was pushed (write mint taken)
    // but the run never reached the merge, the branch is now dangling on the
    // remote. Best-effort drive finish-branch to fold it into the WS-E managed
    // path (a repo_merge manifest a curator can reject, or a no-change delete);
    // if that call also fails, name the branch on the report + failed detail so
    // ALI-972's `orizu workspace status` stale-branch report can reap it. We do
    // NOT auto-approve/apply — a failed run must not silently merge.
    if (ids.branch && ids.writeMintId && !ids.mergeOutcome) {
      ids.orphanedBranch = ids.branch
      let handled = 'left on the remote'
      try {
        const finish = await postJson(fetcher, `/api/cli/sessions/${encodeURIComponent(ids.sessionId!)}/finish-branch`, {
          projectSlug: config.projectSlug,
        })
        const outcome = String(finish.body.outcome)
        handled = outcome === 'no-changes' ? 'deleted (no changes)' : 'folded into a pending repo_merge manifest for review'
      } catch {
        // finish-branch itself failed; fall through to the manual-cleanup hint.
      }
      failedStep.detail += ` [session branch ${ids.branch} ${handled}; reap via \`orizu workspace status\` if it lingers]`
    }
    // Best-effort teardown so a failed run does not leak a sandbox. The cast
    // re-asserts the union: `session` is only assigned inside a nested step
    // closure, which TS control-flow does not track (it would narrow to never).
    //
    // ORPHAN-SANDBOX WINDOW (known gap, not fixable from this side of the seam):
    // `session` is only assigned AFTER `provider.createSandbox()` resolves (see
    // the 'sandbox' step above). If the remote sandbox is created but the SDK
    // call throws before returning the session object — a bad response body, a
    // dropped connection on the reply, etc. — `session` stays null here and this
    // teardown is skipped, leaking a live remote sandbox we have no id for.
    // `SandboxProvider.createSandbox()` returns `Promise<SandboxSession>` as a
    // single unit (create-and-return are not separable in the current SDK
    // shape), so there is no id to destroy-by even if we caught it. `--keep`
    // aside, this is covered operationally by manual/scheduled cleanup in the
    // Daytona dashboard, not by this code. If the SDK ever exposes a two-phase
    // create-then-fetch-id (or a create call that returns an id before the rest
    // of provisioning completes), switch to that so this window closes.
    const openSandbox = session as SandboxSession | null
    if (openSandbox && !opts.keep) {
      try {
        await openSandbox.destroy()
      } catch {
        // ignore teardown failures on the error path
      }
    }
    return {
      ok: false,
      provider: provider.kind,
      steps,
      failedStep,
      totalMs: now() - startedAll,
      hygiene,
      ids,
    }
  }
}
