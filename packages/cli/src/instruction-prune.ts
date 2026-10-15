import { join } from 'node:path'

import { Cause, Effect, Exit } from 'effect'

import { runWithStops, type Interrupted } from './instruction-delivery.js'
import {
  finishPrune,
  rollBackPrune,
  selectPruneRemovals,
  stagePruneRemovals,
  startPrune,
  verifyPrunedTree,
  type PrunePlan,
  type PruneResult,
} from './instruction-set-update/index.js'
import { attempt, holdSyncLock } from './instruction-sync-lock.js'

// Loaded only through `await import(...)` for `instructions prune --yes`, so CLI
// startup and plan-only prune never load Effect.

/** What the removal step did before a stop was handled. */
export type PruneOutcome =
  | { kind: 'not started' }
  | { kind: 'removed'; count: number }
  | { kind: 'rolled back'; error: unknown }
  | { kind: 'rollback failed' }

export type PruneStopped = Interrupted & { outcome: PruneOutcome }

/**
 * Removes the approved Versions under the folder lock. Waiting for the lock
 * and planning again can be stopped and change nothing. The removal itself
 * always settles once it starts: applied and verified, or fully rolled back.
 */
export async function pruneInstructionSets(out: string, plan: PrunePlan, keepSpecifiers: string[]): Promise<PruneResult | PruneStopped> {
  const state: { outcome: PruneOutcome } = { outcome: { kind: 'not started' } }
  const program = holdSyncLock(join(out, 'orizu'), Effect.gen(function*() {
    const selection = yield* Effect.tryPromise({ try: () => selectPruneRemovals(out, plan, keepSpecifiers), catch: cause => cause })
    yield* Effect.uninterruptible(Effect.gen(function*() {
      const prune = yield* attempt(() => startPrune(out))
      yield* Effect.gen(function*() {
        yield* attempt(() => stagePruneRemovals(out, prune, selection))
        yield* Effect.tryPromise({ try: () => verifyPrunedTree(out), catch: cause => cause })
        yield* attempt(() => finishPrune(prune))
      }).pipe(Effect.catch(error => attempt(() => rollBackPrune(prune)).pipe(
        Effect.tapError(() => Effect.sync(() => { state.outcome = { kind: 'rollback failed' } })),
        Effect.andThen(Effect.sync(() => { state.outcome = { kind: 'rolled back', error } })),
        Effect.andThen(Effect.fail(error)),
      )))
      state.outcome = { kind: 'removed', count: selection.removals.length }
    }))
    return { skipped: selection.skipped }
  }))
  const { exit, interrupted } = await runWithStops(() => program)
  // A failed rollback always surfaces its error, stop or not.
  if (interrupted !== undefined && state.outcome.kind !== 'rollback failed') return { interrupted, outcome: state.outcome }
  if (Exit.isSuccess(exit)) return exit.value
  throw Cause.squash(exit.cause)
}
