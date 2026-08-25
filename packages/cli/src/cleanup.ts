export type Cleanup = () => void

function collectCleanupFailures(cleanups: readonly Cleanup[]): unknown[] {
  const failures: unknown[] = []
  for (const cleanup of cleanups) {
    try {
      cleanup()
    } catch (error) {
      failures.push(error)
    }
  }
  return failures
}

/** Attempt every disposer even when an earlier cleanup fails. */
export function cleanupAll(
  cleanups: readonly Cleanup[],
  message: string
): void {
  const failures = collectCleanupFailures(cleanups)
  if (failures.length > 0) {
    throw new AggregateError(failures, message)
  }
}

/** Preserve the operation failure together with every cleanup failure. */
export function throwWithCleanup(
  operationError: unknown,
  cleanups: readonly Cleanup[],
  message: string
): never {
  const cleanupFailures = collectCleanupFailures(cleanups)
  if (cleanupFailures.length > 0) {
    throw new AggregateError([operationError, ...cleanupFailures], message)
  }
  throw operationError
}
