// Waiting for the credentials lock without freezing the process (ORI-2421).
// Loaded only by stored-login code (refresh, logout, login), never on the
// ORIZU_TOKEN / ORIZU_TOKEN_FILE path, which must not load Effect.
import { Cause, Effect, Exit } from 'effect'

import {
  CREDENTIALS_LOCK_RETRY_MS,
  credentialsLockTimeoutError,
  credentialsLockTimeoutMs,
  type HeldCredentialsLock,
  releaseCredentialsLock,
  tryAcquireCredentialsLock,
  withCredentialsTransactionLockAsync,
} from './credentials.js'

/**
 * Try the lock, sleep, try again, until ORIZU_CREDENTIALS_LOCK_TIMEOUT_MS.
 * Timers and stop handlers keep running while it waits, and `signal` stops
 * the wait. A try is one synchronous step, so a stop never lands inside it.
 * A lock a try takes is noted at once, and handed back if the run then ends
 * any way other than returning it, wherever a stop lands.
 */
function acquireLock(signal: AbortSignal | null | undefined): Promise<HeldCredentialsLock> {
  const timeoutMs = credentialsLockTimeoutMs()
  const deadline = Date.now() + timeoutMs
  let taken: HeldCredentialsLock | null = null
  const attempt = Effect.try({
    try: () => (taken = tryAcquireCredentialsLock()),
    catch: cause => cause instanceof Error ? cause : new Error(String(cause)),
  })
  const program = Effect.gen(function*() {
    while (true) {
      const lock = yield* attempt
      if (lock) return lock
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) return yield* Effect.fail(credentialsLockTimeoutError(timeoutMs))
      yield* Effect.sleep(Math.min(CREDENTIALS_LOCK_RETRY_MS, remainingMs))
    }
  })
  return run(program, signal, () => {
    if (!taken) return
    try {
      releaseCredentialsLock(taken)
    } catch {
      // The stop or failure is what the caller needs to see.
    }
  })
}

/** A stop by `signal` rejects with its reason, as an aborted fetch would. */
async function run<A>(
  program: Effect.Effect<A, Error>,
  signal: AbortSignal | null | undefined,
  onNotReturned: () => void
): Promise<A> {
  const exit = await Effect.runPromiseExit(program, signal ? { signal } : undefined)
  if (Exit.isSuccess(exit)) return exit.value
  onNotReturned()
  if (signal?.aborted && Cause.hasInterruptsOnly(exit.cause)) throw signal.reason
  throw Cause.squash(exit.cause)
}

/**
 * A credentials transaction whose wait for the lock stays responsive. The
 * in-process rules are credentials.ts's: one holder per process, and nested
 * writes only from the holder's own async context.
 */
export function withCredentialsTransaction<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal | null
): Promise<T> {
  return withCredentialsTransactionLockAsync(operation, () => acquireLock(signal))
}
