import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'

import {
  defaultGitRunner,
  gitOk,
  redactSecrets,
  revParse,
  type GitAuth,
  type GitRunner,
} from './artifacts-git-runtime.js'

/**
 * The publisher's git step (ORI-2279): merge a session copy into the team
 * copy, ask for permission, then push with compare-and-swap and read back.
 *
 * Runs in a server-owned process with `git` on PATH (the coordinator's merge
 * job), never in an agent's sandbox. It reads no environment and no
 * database: the caller's callbacks carry the permission answer and the
 * one-time team-copy write key.
 */

const SESSION_MERGE_MAX_ATTEMPTS = 3

const CANONICAL_TRACKING_REF = 'refs/remotes/orizu-canonical/head'
const SOURCE_TRACKING_REF = 'refs/remotes/orizu-source/head'

interface SessionMergeEndpoint {
  readonly remote: string
  /** Read access. Omitted only for local remotes in tests. */
  readonly auth?: GitAuth
}

interface PreparedSessionMerge {
  readonly previousCanonicalSha: string
  readonly sourceSha: string
  readonly mergeSha: string
  readonly attempt: number
}

type SessionMergePushResult = 'pushed' | 'stale'

export interface PublishSessionMergeInput {
  /** A writable folder; each attempt merges in its own temporary subfolder. */
  readonly root: string
  readonly canonical: SessionMergeEndpoint
  readonly source: SessionMergeEndpoint
  readonly canonicalRef: string
  readonly sourceRef: string
  /** The session head the publish was approved for. */
  readonly expectedSourceSha: string
  readonly commitMessage: string
  readonly commitIdentityEnv: Readonly<Record<string, string>>
  /** The final permission check, asked after every merge and before any write. */
  readonly authorize: (merge: PreparedSessionMerge) => Promise<boolean>
  /**
   * Mints the one-time team-copy write key, runs `push` once with it, then
   * revokes it. `undefined` is allowed only for local remotes in tests.
   */
  readonly withCanonicalWrite: (
    push: (auth: GitAuth | undefined) => Promise<SessionMergePushResult>
  ) => Promise<SessionMergePushResult>
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  readonly runGit?: GitRunner
}

export type PublishSessionMergeResult =
  | {
      readonly kind: 'merged'
      readonly previousCanonicalSha: string
      readonly sourceSha: string
      readonly mergeSha: string
      readonly attempts: number
    }
  | {
      /** The session head is already in the team copy: nothing to push. */
      readonly kind: 'already_merged'
      readonly canonicalSha: string
      readonly sourceSha: string
    }
  | {
      readonly kind: 'conflict'
      readonly files: readonly string[]
      readonly canonicalSha: string
      readonly sourceSha: string
    }
  | { readonly kind: 'denied' }
  | { readonly kind: 'race_lost'; readonly attempts: number }

type Preparation =
  | { readonly kind: 'merge'; readonly merge: PreparedSessionMerge }
  | Extract<PublishSessionMergeResult, { kind: 'already_merged' | 'conflict' }>

export async function publishSessionMerge(
  input: PublishSessionMergeInput
): Promise<PublishSessionMergeResult> {
  const runGit = input.runGit ?? defaultGitRunner
  for (let attempt = 1; attempt <= SESSION_MERGE_MAX_ATTEMPTS; attempt += 1) {
    const worktree = await mkdtemp(join(input.root, 'session-merge-'))
    try {
      const prepared = await prepareMerge(input, runGit, worktree, attempt)
      if (prepared.kind !== 'merge') return prepared
      if (!(await input.authorize(prepared.merge))) return { kind: 'denied' }
      const pushed = await input.withCanonicalWrite((auth) =>
        pushMerge(input, runGit, worktree, prepared.merge, auth)
      )
      if (pushed === 'stale') continue
      await readBack(input, runGit, worktree, prepared.merge.mergeSha)
      return {
        kind: 'merged',
        previousCanonicalSha: prepared.merge.previousCanonicalSha,
        sourceSha: prepared.merge.sourceSha,
        mergeSha: prepared.merge.mergeSha,
        attempts: attempt,
      }
    } finally {
      await rm(worktree, { recursive: true, force: true })
    }
  }
  return { kind: 'race_lost', attempts: SESSION_MERGE_MAX_ATTEMPTS }
}

async function prepareMerge(
  input: PublishSessionMergeInput,
  runGit: GitRunner,
  worktree: string,
  attempt: number
): Promise<Preparation> {
  await gitOk(runGit, ['init', '-q'], { cwd: worktree }, 'initialise merge folder')
  await fetchInto(input, runGit, worktree, input.canonical, input.canonicalRef, CANONICAL_TRACKING_REF)
  await fetchInto(input, runGit, worktree, input.source, input.sourceRef, SOURCE_TRACKING_REF)
  const canonicalSha = await revParse(runGit, worktree, CANONICAL_TRACKING_REF)
  const sourceSha = await revParse(runGit, worktree, SOURCE_TRACKING_REF)
  if (sourceSha !== input.expectedSourceSha) {
    throw new Error('Session copy moved since the publish was approved')
  }
  if (await isAncestor(runGit, worktree, sourceSha, canonicalSha)) {
    return { kind: 'already_merged', canonicalSha, sourceSha }
  }

  await gitOk(
    runGit,
    ['checkout', '-q', '--detach', canonicalSha],
    { cwd: worktree },
    'check out the team copy head'
  )
  const merge = await runGit(['merge', '--no-ff', '--no-edit', '-m', input.commitMessage, sourceSha], {
    cwd: worktree,
    commitIdentityEnv: input.commitIdentityEnv,
  })
  if (merge.exitCode === 1) {
    const unmerged = await gitOk(
      runGit,
      ['diff', '--name-only', '--diff-filter=U', '-z'],
      { cwd: worktree },
      'list conflicted files'
    )
    const files = unmerged.split('\u0000').filter(Boolean)
    if (files.length > 0) return { kind: 'conflict', files, canonicalSha, sourceSha }
  }
  if (merge.exitCode !== 0) {
    throw new Error(`merge session into team copy failed: ${(merge.stderr || merge.stdout).trim()}`)
  }

  const mergeSha = await revParse(runGit, worktree, 'HEAD')
  const parents = (
    await gitOk(runGit, ['rev-list', '--parents', '-n', '1', mergeSha], { cwd: worktree }, 'inspect merge parents')
  )
    .split(/\s+/)
    .slice(1)
  if (parents.length !== 2 || parents[0] !== canonicalSha || parents[1] !== sourceSha) {
    throw new Error('Merge did not keep the team head and session head as its parents')
  }
  return { kind: 'merge', merge: { previousCanonicalSha: canonicalSha, sourceSha, mergeSha, attempt } }
}

async function pushMerge(
  input: PublishSessionMergeInput,
  runGit: GitRunner,
  worktree: string,
  merge: PreparedSessionMerge,
  auth: GitAuth | undefined
): Promise<SessionMergePushResult> {
  // The lease is the team head this merge was built on, not whatever the
  // remote holds now: if another publish landed after our fetch, the push is
  // refused ("stale info") and the caller merges again on the new head.
  const result = await runGit(
    [
      'push',
      '--porcelain',
      `--force-with-lease=${input.canonicalRef}:${merge.previousCanonicalSha}`,
      input.canonical.remote,
      `${merge.mergeSha}:${input.canonicalRef}`,
    ],
    { cwd: worktree, auth, timeoutMs: input.timeoutMs, signal: input.signal }
  )
  if (result.exitCode === 0) return 'pushed'
  const output = `${result.stdout}\n${result.stderr}`
  if (!result.timedOut && !result.cancelled && /\(stale info\)/.test(output)) return 'stale'
  const detail = redactSecrets(output.trim(), auth ? [auth.token] : [])
  throw new Error(`push merge to team copy failed: ${detail}`)
}

/** Proves the push landed: the team head is the merge, or a later commit containing it. */
async function readBack(
  input: PublishSessionMergeInput,
  runGit: GitRunner,
  worktree: string,
  mergeSha: string
): Promise<void> {
  const listed = await gitOk(
    runGit,
    ['ls-remote', '--refs', input.canonical.remote, input.canonicalRef],
    { cwd: worktree, auth: input.canonical.auth, timeoutMs: input.timeoutMs, signal: input.signal },
    'read back the team copy head'
  )
  const [head, ref] = listed.split(/\s+/)
  if (ref !== input.canonicalRef || !/^[0-9a-f]{40}$/.test(head ?? '')) {
    throw new Error('Team copy read-back returned an unexpected answer')
  }
  if (head === mergeSha) return
  await fetchInto(input, runGit, worktree, input.canonical, input.canonicalRef, CANONICAL_TRACKING_REF)
  const fetched = await revParse(runGit, worktree, CANONICAL_TRACKING_REF)
  if (!(await isAncestor(runGit, worktree, mergeSha, fetched))) {
    throw new Error('Team copy read-back does not contain the pushed merge')
  }
}

async function fetchInto(
  input: PublishSessionMergeInput,
  runGit: GitRunner,
  worktree: string,
  endpoint: SessionMergeEndpoint,
  ref: string,
  trackingRef: string
): Promise<void> {
  await gitOk(
    runGit,
    ['fetch', '-q', '--no-tags', endpoint.remote, `+${ref}:${trackingRef}`],
    { cwd: worktree, auth: endpoint.auth, timeoutMs: input.timeoutMs, signal: input.signal },
    `fetch ${ref}`
  )
}

async function isAncestor(runGit: GitRunner, cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await runGit(['merge-base', '--is-ancestor', ancestor, descendant], { cwd })
  if (result.exitCode === 0) return true
  if (result.exitCode === 1) return false
  throw new Error(`check ancestry failed: ${result.stderr.trim()}`)
}
