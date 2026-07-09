/**
 * Self-contained rehearsal harness for the Daytona slice (ALI-973 / WS-F).
 *
 * Extends the smoke test's in-memory fake-server technique to the WS-F broker /
 * session-branch / finish-branch / apply contracts, and backs it with a REAL
 * local bare git repo so the whole flow (clone → commit → push → merge) runs
 * against genuine git. Consumed by BOTH the unit test and the local-sim
 * rehearsal in `scripts/daytona-workbench-slice.mjs`, so the two never drift.
 *
 * This is the piece that makes `--provider local-sim` a rehearsal, not a mock:
 * `finish-branch` and `apply` shell out to git on the bare repo (rev-list /
 * update-ref), so a session branch really is merged into `main`.
 */

import { spawnSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { WORKSPACE_SCHEMA_VERSION } from './workspace.js'
import type { SliceConfig, SliceFetcher } from './daytona-slice.js'
import { createLocalSimProvider } from './sandbox-provider.js'
import type { SandboxProvider } from './sandbox-provider.js'

function git(args: string[], cwd?: string): { stdout: string; stderr: string; status: number } {
  // Strip git's repo-context env vars before spawning. When this code runs
  // inside a git hook (e.g. the pre-push hook running `bun test`), git sets
  // GIT_DIR in the environment — and `git init --bare <dir>` with GIT_DIR set
  // REINITIALIZES the repo GIT_DIR points at as bare (core.bare=true in the
  // shared config), breaking every linked worktree. Scope every child git
  // strictly to its cwd/args instead.
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  delete env.GIT_OBJECT_DIRECTORY
  delete env.GIT_COMMON_DIR
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', env })
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status ?? 1 }
}

function gitOrThrow(args: string[], cwd?: string): string {
  const r = git(args, cwd)
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim() || `exit ${r.status}`}`)
  }
  return r.stdout
}

export interface SeededBareRepo {
  gitDir: string
  repoFullName: string
  defaultBranch: string
}

/**
 * Create a bare git repo seeded with the Phase-1 workbench contract (matching
 * `lib/workbench-repo-contract.ts`) on a `main` branch: root manifests, a
 * `.gitignore` that ignores `.orizu/`, and a project stub.
 */
export function seedLocalBareRepo(baseDir: string, config: SliceConfig): SeededBareRepo {
  const gitDir = join(baseDir, 'workbench.git')
  gitOrThrow(['init', '--bare', '--initial-branch=main', gitDir])

  const work = mkdtempSync(join(baseDir, 'seed-'))
  gitOrThrow(['init', '--initial-branch=main', work])
  const ident = ['-c', 'user.email=seed@orizu.local', '-c', 'user.name=Seed']

  // ALI-1075: no `canonical`/`repoState` liveness fields — manifests carry
  // machine-readable ids only; the DB label is the sole production pointer.
  const teamManifest = {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    kind: 'team',
    slug: config.teamSlug,
  }
  const projectManifest = {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    kind: 'project',
    slug: config.projectSlug,
  }
  writeFileSync(join(work, 'orizu.team.json'), `${JSON.stringify(teamManifest, null, 2)}\n`)
  writeFileSync(join(work, '.gitignore'), '# Orizu workspace policy\n.orizu/\n')
  writeFileSync(join(work, 'AGENTS.md'), '# Workbench\n')
  const projectDir = join(work, 'projects', config.projectSlug)
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, 'orizu.project.json'), `${JSON.stringify(projectManifest, null, 2)}\n`)
  writeFileSync(join(projectDir, '.gitkeep'), '')

  gitOrThrow([...ident, 'add', '-A'], work)
  gitOrThrow([...ident, 'commit', '-m', 'seed workbench contract'], work)
  gitOrThrow(['remote', 'add', 'origin', gitDir], work)
  gitOrThrow(['push', 'origin', 'main'], work)
  rmSync(work, { recursive: true, force: true })

  return { gitDir, repoFullName: `orizu-sim/orizu-workbench-${config.teamSlug}`, defaultBranch: 'main' }
}

interface StoredSession {
  id: string
  workspaceId: string
  branch: string | null
  headSha: string | null
  projectSlug: string | null
}

interface StoredMint {
  id: string
  workspaceId: string
  purpose: string
  revoked: boolean
}

interface StoredManifest {
  id: string
  status: string
  branch: string
  headSha: string
  outcome: Record<string, unknown>
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/**
 * In-memory WS-F control plane over a real bare repo. Session-start cuts a real
 * branch; finish-branch diffs it; apply fast-forwards `main`. Tracks token mints
 * so revocation is observable and asserts tokens never leak into stored state.
 */
export class FakeWorkbenchApi {
  workspaces = new Map<string, { id: string; teamSlug: string; slug: string }>()
  sessions = new Map<string, StoredSession>()
  mints = new Map<string, StoredMint>()
  manifests = new Map<string, StoredManifest>()
  tokensIssued: string[] = []
  private counter = 0

  constructor(private readonly repo: SeededBareRepo) {}

  private id(prefix: string): string {
    this.counter += 1
    return `${prefix}-${this.counter}`
  }

  private branchHead(branch: string): string {
    return gitOrThrow(['--git-dir', this.repo.gitDir, 'rev-parse', branch]).trim()
  }

  newFetcher(): SliceFetcher {
    return async (path: string, init: RequestInit = {}) => {
      const method = (init.method || 'GET').toUpperCase()
      const [rawPath] = path.split('?')
      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}

      // Workspace create-or-attach (idempotent on teamSlug + slug).
      if (method === 'POST' && rawPath === '/api/cli/workspaces') {
        const key = `${body.teamSlug}/${body.slug}`
        const existing = this.workspaces.get(key)
        if (existing) return jsonResponse({ workspace: { ...existing } }, 200)
        const workspace = { id: this.id('ws'), teamSlug: String(body.teamSlug), slug: String(body.slug) }
        this.workspaces.set(key, workspace)
        return jsonResponse({ workspace }, 201)
      }

      // Session start — cut a real `orizu/session-<id>` branch off main.
      const sessMatch = rawPath.match(/^\/api\/cli\/workspaces\/([^/]+)\/sessions$/)
      if (method === 'POST' && sessMatch) {
        const sessionId = this.id('sess')
        const stored: StoredSession = {
          id: sessionId,
          workspaceId: sessMatch[1],
          branch: null,
          headSha: null,
          projectSlug: typeof body.projectSlug === 'string' ? body.projectSlug : null,
        }
        if (body.repoBranch !== false) {
          const branch = `orizu/session-${sessionId}`
          gitOrThrow(['--git-dir', this.repo.gitDir, 'branch', branch, this.repo.defaultBranch])
          stored.branch = branch
          stored.headSha = this.branchHead(branch)
        }
        this.sessions.set(sessionId, stored)
        return jsonResponse(
          { session: { id: sessionId, repoBranch: stored.branch, repoHeadSha: stored.headSha, status: 'active' } },
          201
        )
      }

      // Repo-token mint.
      const tokenMatch = rawPath.match(/^\/api\/cli\/workspaces\/([^/]+)\/repo-token$/)
      if (method === 'POST' && tokenMatch) {
        const purpose = String(body.purpose)
        const mintId = this.id('mint')
        const token = `ghs_sim_${purpose}_${mintId}_${Math.random().toString(36).slice(2)}`
        this.mints.set(mintId, { id: mintId, workspaceId: tokenMatch[1], purpose, revoked: false })
        this.tokensIssued.push(token)
        return jsonResponse({
          token,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          repo: this.repo.repoFullName,
          mintId,
        })
      }

      // Repo-token revoke.
      if (method === 'DELETE' && tokenMatch) {
        const mintId = String(body.mintId)
        const mint = this.mints.get(mintId)
        if (!mint) return jsonResponse({ error: 'Token mint not found' }, 404)
        mint.revoked = true
        return jsonResponse({ revoked: true, mintId })
      }

      // Finish-branch — compare the session branch against main.
      const finishMatch = rawPath.match(/^\/api\/cli\/sessions\/([^/]+)\/finish-branch$/)
      if (method === 'POST' && finishMatch) {
        const session = this.sessions.get(finishMatch[1])
        if (!session || !session.branch) return jsonResponse({ error: 'Session has no repo branch' }, 400)
        const ahead = Number.parseInt(
          gitOrThrow(['--git-dir', this.repo.gitDir, 'rev-list', '--count', `${this.repo.defaultBranch}..${session.branch}`]).trim(),
          10
        )
        if (ahead === 0) {
          gitOrThrow(['--git-dir', this.repo.gitDir, 'branch', '-D', session.branch])
          return jsonResponse({ outcome: 'no-changes', branch: session.branch })
        }
        const headSha = this.branchHead(session.branch)
        const manifestId = this.id('man')
        this.manifests.set(manifestId, {
          id: manifestId,
          status: 'pending_approval',
          branch: session.branch,
          headSha,
          outcome: {},
        })
        return jsonResponse(
          { outcome: 'manifest', manifest: { id: manifestId, status: 'pending_approval', actionType: 'repo_merge' } },
          201
        )
      }

      // Manifest approve / apply / reject.
      const manifestMatch = rawPath.match(/^\/api\/cli\/promotion-manifests\/([^/]+)$/)
      if (method === 'POST' && manifestMatch) {
        const manifest = this.manifests.get(manifestMatch[1])
        if (!manifest) return jsonResponse({ error: 'Promotion manifest not found' }, 404)
        const action = String(body.action)
        if (action === 'approve') {
          if (manifest.status === 'pending_approval' || manifest.status === 'draft') manifest.status = 'approved'
          return jsonResponse({ manifest: { id: manifest.id, status: manifest.status } })
        }
        if (action === 'apply') {
          if (manifest.status === 'applied') {
            return jsonResponse({ manifest: { id: manifest.id, status: 'applied', outcome: manifest.outcome } })
          }
          if (manifest.status !== 'approved') {
            return jsonResponse({ error: 'Manifest must be approved before it can be applied' }, 400)
          }
          // Re-verify the branch head, then fast-forward main to it (real merge).
          const head = this.branchHead(manifest.branch)
          if (head !== manifest.headSha) return jsonResponse({ error: 'branch moved' }, 409)
          gitOrThrow(['--git-dir', this.repo.gitDir, 'update-ref', `refs/heads/${this.repo.defaultBranch}`, head])
          gitOrThrow(['--git-dir', this.repo.gitDir, 'branch', '-D', manifest.branch])
          manifest.status = 'applied'
          manifest.outcome = { merged: true, mergeSha: head }
          return jsonResponse({ manifest: { id: manifest.id, status: 'applied', outcome: manifest.outcome } })
        }
        if (action === 'reject') {
          manifest.status = 'rejected'
          gitOrThrow(['--git-dir', this.repo.gitDir, 'branch', '-D', manifest.branch])
          return jsonResponse({ manifest: { id: manifest.id, status: 'rejected' } })
        }
        return jsonResponse({ error: "action must be one of 'approve', 'reject', 'apply'" }, 400)
      }

      throw new Error(`FakeWorkbenchApi: unexpected fetch ${method} ${path}`)
    }
  }
}

export interface SliceRehearsal {
  config: SliceConfig
  api: FakeWorkbenchApi
  provider: SandboxProvider
  makeFetcher: () => SliceFetcher
  resolveCloneUrl: (repo: string) => string
  bareRepoDir: string
  defaultBranch: () => string
  cleanup: () => void
}

/**
 * Wire a full self-contained rehearsal: seed a bare repo, stand up the fake
 * control plane, and hand back a local-sim provider + resolveCloneUrl that maps
 * the broker's repo name to the bare repo path.
 */
export function createSliceRehearsal(options: { config?: Partial<SliceConfig>; keep?: boolean } = {}): SliceRehearsal {
  const config: SliceConfig = {
    teamSlug: options.config?.teamSlug ?? 'acme',
    projectSlug: options.config?.projectSlug ?? 'support-bot',
    workspaceSlug: options.config?.workspaceSlug ?? 'support-bot-slice',
  }
  const base = mkdtempSync(join(tmpdir(), 'orizu-slice-rehearsal-'))
  const repo = seedLocalBareRepo(base, config)
  const api = new FakeWorkbenchApi(repo)
  const provider = createLocalSimProvider({ rootDir: join(base, 'sandboxes'), keepOnDestroy: Boolean(options.keep) })

  return {
    config,
    api,
    provider,
    makeFetcher: () => api.newFetcher(),
    resolveCloneUrl: () => repo.gitDir,
    bareRepoDir: repo.gitDir,
    defaultBranch: () => gitOrThrow(['--git-dir', repo.gitDir, 'rev-parse', repo.defaultBranch]).trim(),
    cleanup: () => {
      if (!options.keep) rmSync(base, { recursive: true, force: true })
    },
  }
}
