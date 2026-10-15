import { Effect } from 'effect'

import { startSyncLockClaim, tryClaimSyncLock } from './instruction-set-sync/index.js'

// Loaded only through `await import(...)` (instruction-delivery, instruction-prune),
// so CLI startup and the published loader never load Effect.

// Existing file steps throw plain errors; keep them as the failure value so the
// CLI prints exactly the same message.
export const attempt = <A>(operation: () => A) => Effect.try({ try: operation, catch: cause => cause })

/**
 * Runs `use` while holding the app folder's sync lock (`.orizu.lock.json.lock`).
 * Waiting for another process's lock never blocks and is the only part a stop
 * can interrupt: nothing is held yet. The lock is released however `use` ends.
 */
export function holdSyncLock<A>(appRoot: string, use: Effect.Effect<A, unknown>) {
  const acquire = Effect.gen(function*() {
    const claim = yield* attempt(() => startSyncLockClaim(appRoot))
    while (true) {
      const claimed = yield* attempt(() => tryClaimSyncLock(claim))
      if (typeof claimed === 'function') return claimed
      yield* Effect.interruptible(Effect.sleep(claimed))
    }
  })
  return Effect.acquireUseRelease(acquire, () => use, release => Effect.sync(release))
}
