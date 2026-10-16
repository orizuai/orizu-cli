import type { GitAuth, GitRunner } from './artifacts-git-runtime.js'

/**
 * The publisher's git step (ORI-2279): merge a session copy into the team
 * copy, ask for permission, then push with compare-and-swap and read back.
 *
 * Runs in a server-owned process with `git` on PATH (the coordinator's merge
 * job), never in an agent's sandbox. It reads no environment and no
 * database: the caller's callbacks carry the permission answer and the
 * one-time team-copy write key.
 */

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
  /** The merge folder: both copies' fetched objects plus the merge commit. */
  readonly worktree: string
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

/**
 * The git step itself runs on Effect (ORI-2373, artifacts-session-merge-run.ts),
 * loaded here on first use so this module, and the merge job that imports it,
 * load no Effect until a publish actually merges.
 */
export async function publishSessionMerge(
  input: PublishSessionMergeInput
): Promise<PublishSessionMergeResult> {
  const { runSessionMerge } = await import('./artifacts-session-merge-run.js')
  return runSessionMerge(input)
}
