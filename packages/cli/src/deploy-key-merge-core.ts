/**
 * Transport-agnostic deploy-key merge core (ALI-1084, merge-sandbox-job
 * Phase 0). Extracted VERBATIM from `lib/git-ssh-merge.ts` so both the server
 * (`lib/`) and the published CLI (`orizu internal merge-job`, Phase 2) run the
 * EXACT SAME merge logic — no forked implementations, one place where the
 * ADR-007 §4 `--no-ff` invariant is asserted on the exact argv.
 *
 * DELIBERATELY NO `import 'server-only'`: this module runs inside the one-shot
 * merge sandbox (a plain Node process) as well as on the server. It must not
 * import anything outside the CLI package root (bun-bundled) — node builtins
 * only. `lib/git-ssh-merge.ts` re-exports everything here so every existing
 * server import path and test keeps working unchanged.
 *
 * SECURITY PROPERTIES (unchanged from the lib original):
 *   - throwaway temp worktree + isolated SSH identity (key file mode 0600);
 *   - pinned GitHub host keys (StrictHostKeyChecking=yes, own known_hosts);
 *   - expected-head verification: the merge targets the REVIEWED SHA, never a
 *     branch name;
 *   - `merge-base --is-ancestor` alreadyMerged idempotency check;
 *   - argv-asserted commit-preserving `--no-ff` merge (ADR-007 §4).
 */

import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface MergeBranchWithDeployKeyInput {
  base: string
  sourceBranch: string
  expectedHeadSha: string
  commitMessage: string
  privateKeyPem: string
}

export interface GitCommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export type GitCommandRunner = (
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
) => Promise<GitCommandResult>

export interface MergeBranchWithDeployKeyDeps {
  runGit?: GitCommandRunner
}

/**
 * The merge outcome contract. Structurally identical to `MergeResult` in
 * `lib/github-repo-ops.ts` (which cannot be imported from the CLI package —
 * it is server-only); TypeScript's structural typing keeps the two
 * assignable, and `lib/git-ssh-merge.ts` continues to expose the lib-side
 * type to server callers.
 */
export interface DeployKeyMergeResult {
  merged: boolean
  sha: string | null
  /** true when the base already contained head (GitHub 204 equivalent). */
  alreadyMerged: boolean
  /** true when git reported a merge conflict (409 equivalent). */
  conflict: boolean
  status: number
}

/**
 * ADR-007 §4 merge-strategy invariant: the seal merge must stay a COMMIT-
 * PRESERVING merge. `--no-ff` keeps the session-branch head as a parent of the
 * merge commit, so every create-time `commit_sha` pinned by a draft version
 * row stays reachable on the default branch forever. A squash or rebase would
 * rewrite/discard those commits and orphan the pins — "what the label says is
 * live" could then dangle. These flags must never appear in the seal merge.
 */
const FORBIDDEN_SEAL_MERGE_FLAGS = ['--squash', '--ff-only', '--ff', 'rebase'] as const
const REQUIRED_SEAL_MERGE_FLAG = '--no-ff'

/**
 * Assert a git invocation is the commit-preserving seal merge ADR-007 §4
 * requires. Called on the exact argv the merge runs with, so the invariant is
 * enforced where the merge happens rather than by reviewer vigilance.
 */
export function assertCommitPreservingMergeArgs(args: readonly string[]): void {
  if (!args.includes('merge')) {
    throw new Error('seal merge invariant: expected a git merge invocation')
  }
  if (!args.includes(REQUIRED_SEAL_MERGE_FLAG)) {
    throw new Error(
      `seal merge invariant violated: ${REQUIRED_SEAL_MERGE_FLAG} is required (ADR-007 §4 — the merge must keep the session head as a parent)`
    )
  }
  for (const flag of FORBIDDEN_SEAL_MERGE_FLAGS) {
    if (args.includes(flag)) {
      throw new Error(
        `seal merge invariant violated: ${flag} would rewrite or drop session commits and orphan draft version pins (ADR-007 §4)`
      )
    }
  }
}

const LOCAL_BASE_REF = 'refs/heads/__orizu_merge_base'
const LOCAL_SOURCE_REF = 'refs/remotes/origin/__orizu_merge_source'
// GitHub's published SSH host keys:
// https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints
const GITHUB_KNOWN_HOSTS = [
  'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl',
  'github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=',
  'github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=',
].join('\n') + '\n'

/**
 * Strip git's repo-context env vars from a child git's environment. Git
 * EXPORTS these into hook subprocesses (from a linked worktree, GIT_DIR is an
 * ABSOLUTE path into the shared .git), so any descendant git command that
 * inherits the parent env operates on THAT repo instead of its own cwd —
 * `git config` writes land in the shared .git/config and `git init` flips it
 * to core.bare=true (both observed when the pre-push hook ran the test suite
 * from a worktree). Every real-git spawn must build its env through this.
 */
export function scrubGitRepoContextEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const scrubbed = { ...env }
  delete scrubbed.GIT_DIR
  delete scrubbed.GIT_WORK_TREE
  delete scrubbed.GIT_INDEX_FILE
  delete scrubbed.GIT_OBJECT_DIRECTORY
  delete scrubbed.GIT_COMMON_DIR
  delete scrubbed.GIT_NAMESPACE
  return scrubbed
}

// Exported: the ADR-007 P3 read path (lib/artifact-git-read.ts) runs its
// verified reads through the same spawn.
export function defaultRunGit(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ exitCode: code ?? 1, stdout, stderr }))
  })
}

export function sshRemote(repoFullName: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoFullName)) {
    throw new Error(`Invalid repo full name: ${repoFullName}`)
  }
  return `git@github.com:${repoFullName}.git`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/** Exported for `lib/git-ssh-merge.ts` (pushFilesWithDeployKey keeps living
 *  there — D9 scopes the push path as a follow-on, not part of the core). */
export function assertGitOk(result: GitCommandResult, operation: string): void {
  if (result.exitCode === 0) return
  const detail = (result.stderr || result.stdout).trim()
  throw new Error(detail ? `${operation} failed: ${detail}` : `${operation} failed`)
}

function looksLikeMergeConflict(result: GitCommandResult): boolean {
  const output = `${result.stdout}\n${result.stderr}`
  return /CONFLICT|Automatic merge failed|Merge conflict/i.test(output)
}

export interface DeployKeyGitContext {
  dir: string
  git: (args: string[]) => Promise<GitCommandResult>
  gitOk: (args: string[], operation: string) => Promise<GitCommandResult>
}

/**
 * Run a callback inside a throwaway git worktree wired to the repo's merge
 * deploy key (isolated SSH identity + pinned GitHub host keys). Exported for
 * the ADR-007 read path (lib/artifact-git-read.ts), which reuses the same
 * clone/pack infrastructure for bulk artifact reads.
 */
export async function withDeployKeyGit<T>(
  privateKeyPem: string,
  runGit: GitCommandRunner,
  tempPrefix: string,
  callback: (context: DeployKeyGitContext) => Promise<T>
): Promise<T> {
  const tempRoot = await mkdtemp(join(tmpdir(), tempPrefix))
  const dir = join(tempRoot, 'worktree')
  const sshDir = join(tempRoot, 'ssh')
  await mkdir(dir)
  await mkdir(sshDir)
  const keyPath = join(sshDir, 'merge_deploy_key')
  const knownHostsPath = join(sshDir, 'known_hosts')
  const env = {
    // Scrubbed: a leaked GIT_DIR (git exports it into hooks) must never
    // redirect this temp-worktree clone/merge onto another repo.
    ...scrubGitRepoContextEnv(process.env),
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: [
      'ssh',
      '-i',
      shellQuote(keyPath),
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      shellQuote(`UserKnownHostsFile=${knownHostsPath}`),
    ].join(' '),
  }
  const git = (args: string[]) => runGit(args, { cwd: dir, env })
  const gitOk = async (args: string[], operation: string) => {
    const result = await git(args)
    assertGitOk(result, operation)
    return result
  }

  try {
    await writeFile(keyPath, privateKeyPem, { mode: 0o600 })
    await chmod(keyPath, 0o600)
    await writeFile(knownHostsPath, GITHUB_KNOWN_HOSTS, { mode: 0o600 })
    return await callback({ dir, git, gitOk })
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

/**
 * Merge a reviewed session/revert branch head into the default branch using the
 * server-only merge deploy key. The source branch is fetched only so GitHub can
 * prove the reviewed SHA is still the branch tip; the merge itself targets the
 * expected SHA, preserving the manifest CAS guarantee.
 */
export async function mergeBranchWithDeployKey(
  repoFullName: string,
  input: MergeBranchWithDeployKeyInput,
  deps: MergeBranchWithDeployKeyDeps = {}
): Promise<DeployKeyMergeResult> {
  const runGit = deps.runGit ?? defaultRunGit
  return withDeployKeyGit(input.privateKeyPem, runGit, 'orizu-merge-', async ({ git, gitOk }) => {
    await gitOk(['init'], 'git init')
    await gitOk(['remote', 'add', 'origin', sshRemote(repoFullName)], 'git remote add')
    await gitOk(
      ['fetch', '--no-tags', 'origin', `refs/heads/${input.base}:${LOCAL_BASE_REF}`],
      'git fetch default branch'
    )
    await gitOk(['checkout', '-B', '__orizu_merge_base', LOCAL_BASE_REF], 'git checkout default branch')
    await gitOk(
      ['fetch', '--no-tags', 'origin', `refs/heads/${input.sourceBranch}:${LOCAL_SOURCE_REF}`],
      'git fetch reviewed source branch'
    )

    const sourceHead = (await gitOk(['rev-parse', LOCAL_SOURCE_REF], 'git rev-parse source')).stdout.trim()
    if (sourceHead !== input.expectedHeadSha) {
      throw new Error('branch moved since manifest creation; re-finish the session')
    }

    const ancestor = await git(['merge-base', '--is-ancestor', input.expectedHeadSha, 'HEAD'])
    if (ancestor.exitCode === 0) {
      const head = (await gitOk(['rev-parse', 'HEAD'], 'git rev-parse default')).stdout.trim()
      return { merged: false, sha: head, alreadyMerged: true, conflict: false, status: 204 }
    }
    if (ancestor.exitCode !== 1) {
      assertGitOk(ancestor, 'git merge-base')
    }

    // ADR-007 §4: the seal is a commit-preserving --no-ff merge — never squash,
    // never rebase — so every draft version's create-time commit_sha stays
    // reachable once the branch reaches the default branch.
    const mergeArgs = [
      '-c',
      'user.name=Orizu',
      '-c',
      'user.email=bot@orizu.ai',
      'merge',
      '--no-ff',
      '-m',
      input.commitMessage,
      input.expectedHeadSha,
    ]
    assertCommitPreservingMergeArgs(mergeArgs)
    const merge = await git(mergeArgs)
    if (merge.exitCode !== 0) {
      if (looksLikeMergeConflict(merge)) {
        return { merged: false, sha: null, alreadyMerged: false, conflict: true, status: 409 }
      }
      assertGitOk(merge, 'git merge')
    }

    const mergeSha = (await gitOk(['rev-parse', 'HEAD'], 'git rev-parse merge')).stdout.trim()
    await gitOk(['push', 'origin', `HEAD:refs/heads/${input.base}`], 'git push default branch')
    return { merged: true, sha: mergeSha, alreadyMerged: false, conflict: false, status: 201 }
  })
}
