import { Effect } from 'effect'

// Loaded only through `await import(...)` chains (instruction delivery and
// prune, the local session and run workflows), so CLI startup never loads Effect.

export interface Interrupted { interrupted: 130 | 143 }

/**
 * Runs the program with Ctrl-C and SIGTERM turned into an interrupt, and says
 * which stop arrived, if any. `once`: a second signal falls through to Node's
 * default kill. The handlers are removed before this returns.
 */
export async function runWithStops<A>(program: (signal: AbortSignal) => Effect.Effect<A, unknown>) {
  const controller = new AbortController()
  let interrupted: Interrupted['interrupted'] | undefined
  const handleInterrupt = () => { interrupted ??= 130; controller.abort() }
  const handleTerminate = () => { interrupted ??= 143; controller.abort() }
  process.once('SIGINT', handleInterrupt)
  process.once('SIGTERM', handleTerminate)
  try {
    const exit = await Effect.runPromiseExit(program(controller.signal), { signal: controller.signal })
    return { exit, interrupted }
  } finally {
    process.removeListener('SIGINT', handleInterrupt)
    process.removeListener('SIGTERM', handleTerminate)
  }
}
