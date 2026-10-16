import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { Cause, Effect, Exit, Ref } from 'effect'

import { defaultGitRunner, redactSecrets, type GitAuth, type GitRunOptions } from './artifacts-git-runtime.js'
import type { PublishSessionMergeInput, PublishSessionMergeResult } from './artifacts-session-merge.js'

// ORI-2373 M1: the publisher's git step on Effect, loaded only by
// `publishSessionMerge` (artifacts-session-merge.ts) with `await import`, so
// the merge job's module graph keeps no top-level Effect import. Every git step
// keeps to the caller's per-step limit and stops on the caller's signal (the
// merge job's deadline); each attempt's folder is removed once its steps have
// settled.

const SESSION_MERGE_MAX_ATTEMPTS = 3

const CANONICAL_TRACKING_REF = 'refs/remotes/orizu-canonical/head'
const SOURCE_TRACKING_REF = 'refs/remotes/orizu-source/head'

/** A push refused by compare-and-swap: merge again on the new team head. */
class Stale { readonly _tag = 'Stale' }

type Endpoint = PublishSessionMergeInput['canonical']
type Preparation =
  | { readonly kind: 'merge'; readonly previousCanonicalSha: string; readonly sourceSha: string; readonly mergeSha: string }
  | Extract<PublishSessionMergeResult, { kind: 'already_merged' | 'conflict' }>

export async function runSessionMerge(input: PublishSessionMergeInput): Promise<PublishSessionMergeResult> {
  const runGit = input.runGit ?? defaultGitRunner

  /** One git command with the caller's limit and signal; its result as run. */
  const run = (args: string[], options: Omit<GitRunOptions, 'timeoutMs' | 'signal'>, operation: string) =>
    Effect.promise(() => runGit(args, { ...options, timeoutMs: input.timeoutMs, signal: input.signal })).pipe(
      Effect.flatMap(result => result.timedOut
        ? Effect.fail(new Error(`${operation} timed out`))
        : result.cancelled ? Effect.fail(new Error(`${operation} cancelled`)) : Effect.succeed(result)))

  /** A git command that must succeed; its trimmed output. */
  const ok = (args: string[], options: Omit<GitRunOptions, 'timeoutMs' | 'signal'>, operation: string) =>
    run(args, options, operation).pipe(Effect.flatMap(result => {
      if (result.exitCode === 0) return Effect.succeed(result.stdout.trim())
      const detail = redactSecrets((result.stderr || result.stdout).trim(), options.auth ? [options.auth.token] : [])
      return Effect.fail(new Error(detail ? `${operation} failed: ${detail}` : `${operation} failed`))
    }))

  const revParse = (cwd: string, ref: string) => ok(['rev-parse', '--verify', ref], { cwd }, `resolve ${ref}`)

  const isAncestor = (cwd: string, ancestor: string, descendant: string) =>
    run(['merge-base', '--is-ancestor', ancestor, descendant], { cwd }, 'check ancestry').pipe(Effect.flatMap(result =>
      result.exitCode === 0 ? Effect.succeed(true)
        : result.exitCode === 1 ? Effect.succeed(false)
          : Effect.fail(new Error(`check ancestry failed: ${result.stderr.trim()}`))))

  const fetchInto = (worktree: string, endpoint: Endpoint, ref: string, trackingRef: string) =>
    ok(['fetch', '-q', '--no-tags', endpoint.remote, `+${ref}:${trackingRef}`], { cwd: worktree, auth: endpoint.auth }, `fetch ${ref}`)

  const prepare = (worktree: string) => Effect.gen(function* () {
    yield* ok(['init', '-q'], { cwd: worktree }, 'initialise merge folder')
    yield* fetchInto(worktree, input.canonical, input.canonicalRef, CANONICAL_TRACKING_REF)
    yield* fetchInto(worktree, input.source, input.sourceRef, SOURCE_TRACKING_REF)
    const canonicalSha = yield* revParse(worktree, CANONICAL_TRACKING_REF)
    const sourceSha = yield* revParse(worktree, SOURCE_TRACKING_REF)
    if (sourceSha !== input.expectedSourceSha) return yield* Effect.fail(new Error('Session copy moved since the publish was approved'))
    if (yield* isAncestor(worktree, sourceSha, canonicalSha)) return { kind: 'already_merged', canonicalSha, sourceSha } satisfies Preparation

    yield* ok(['checkout', '-q', '--detach', canonicalSha], { cwd: worktree }, 'check out the team copy head')
    const merge = yield* run(['merge', '--no-ff', '--no-edit', '-m', input.commitMessage, sourceSha],
      { cwd: worktree, commitIdentityEnv: input.commitIdentityEnv }, 'merge session into team copy')
    if (merge.exitCode === 1) {
      const unmerged = yield* ok(['diff', '--name-only', '--diff-filter=U', '-z'], { cwd: worktree }, 'list conflicted files')
      const files = unmerged.split('\u0000').filter(Boolean)
      if (files.length > 0) return { kind: 'conflict', files, canonicalSha, sourceSha } satisfies Preparation
    }
    if (merge.exitCode !== 0) {
      return yield* Effect.fail(new Error(`merge session into team copy failed: ${(merge.stderr || merge.stdout).trim()}`))
    }

    const mergeSha = yield* revParse(worktree, 'HEAD')
    const parents = (yield* ok(['rev-list', '--parents', '-n', '1', mergeSha], { cwd: worktree }, 'inspect merge parents'))
      .split(/\s+/)
      .slice(1)
    if (parents.length !== 2 || parents[0] !== canonicalSha || parents[1] !== sourceSha) {
      return yield* Effect.fail(new Error('Merge did not keep the team head and session head as its parents'))
    }
    return { kind: 'merge', previousCanonicalSha: canonicalSha, sourceSha, mergeSha } satisfies Preparation
  })

  // The lease is the team head this merge was built on, not whatever the
  // remote holds now: if another publish landed after our fetch, the push is
  // refused ("stale info") and the caller merges again on the new head.
  const push = (worktree: string, previousCanonicalSha: string, mergeSha: string, auth: GitAuth | undefined) =>
    Effect.promise(() => runGit(
      ['push', '--porcelain', `--force-with-lease=${input.canonicalRef}:${previousCanonicalSha}`, input.canonical.remote, `${mergeSha}:${input.canonicalRef}`],
      { cwd: worktree, auth, timeoutMs: input.timeoutMs, signal: input.signal },
    )).pipe(Effect.flatMap(result => {
      if (result.exitCode === 0) return Effect.succeed('pushed' as const)
      const output = `${result.stdout}\n${result.stderr}`
      if (!result.timedOut && !result.cancelled && /\(stale info\)/.test(output)) return Effect.succeed('stale' as const)
      return Effect.fail(new Error(`push merge to team copy failed: ${redactSecrets(output.trim(), auth ? [auth.token] : [])}`))
    }))

  /** Proves the push landed: the team head is the merge, or a later commit containing it. */
  const readBack = (worktree: string, mergeSha: string) => Effect.gen(function* () {
    const listed = yield* ok(['ls-remote', '--refs', input.canonical.remote, input.canonicalRef],
      { cwd: worktree, auth: input.canonical.auth }, 'read back the team copy head')
    const [head, ref] = listed.split(/\s+/)
    if (ref !== input.canonicalRef || !/^[0-9a-f]{40}$/.test(head ?? '')) {
      return yield* Effect.fail(new Error('Team copy read-back returned an unexpected answer'))
    }
    if (head === mergeSha) return
    yield* fetchInto(worktree, input.canonical, input.canonicalRef, CANONICAL_TRACKING_REF)
    const fetched = yield* revParse(worktree, CANONICAL_TRACKING_REF)
    if (!(yield* isAncestor(worktree, mergeSha, fetched))) {
      return yield* Effect.fail(new Error('Team copy read-back does not contain the pushed merge'))
    }
  })

  const program = Effect.gen(function* () {
    const attempts = yield* Ref.make(0)
    const attempt = Effect.scoped(Effect.gen(function* () {
      const attemptNumber = yield* Ref.updateAndGet(attempts, n => n + 1)
      // Each attempt merges in its own folder, removed once its steps have settled.
      const worktree = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(input.root, 'session-merge-'))),
        dir => Effect.promise(() => rm(dir, { recursive: true, force: true })),
      )
      const prepared = yield* prepare(worktree)
      if (prepared.kind !== 'merge') return prepared
      const allowed = yield* Effect.tryPromise({
        try: () => input.authorize({ ...prepared, attempt: attemptNumber, worktree }),
        catch: error => error,
      })
      if (!allowed) return { kind: 'denied' } satisfies PublishSessionMergeResult
      const pushed = yield* Effect.tryPromise({
        try: () => input.withCanonicalWrite(auth => Effect.runPromise(push(worktree, prepared.previousCanonicalSha, prepared.mergeSha, auth))),
        catch: error => error,
      })
      if (pushed === 'stale') return yield* Effect.fail(new Stale())
      yield* readBack(worktree, prepared.mergeSha)
      return {
        kind: 'merged',
        previousCanonicalSha: prepared.previousCanonicalSha,
        sourceSha: prepared.sourceSha,
        mergeSha: prepared.mergeSha,
        attempts: attemptNumber,
      } satisfies PublishSessionMergeResult
    }))
    return yield* attempt.pipe(
      Effect.retry({ times: SESSION_MERGE_MAX_ATTEMPTS - 1, while: error => error instanceof Stale }),
      Effect.catchIf(error => error instanceof Stale, () => Effect.succeed({ kind: 'race_lost', attempts: SESSION_MERGE_MAX_ATTEMPTS } satisfies PublishSessionMergeResult)),
    )
  })

  const exit = await Effect.runPromiseExit(program)
  if (Exit.isSuccess(exit)) return exit.value
  // The caller sees the failure it saw before: the step's Error, or its own callback's error unchanged.
  throw Cause.squash(exit.cause)
}
