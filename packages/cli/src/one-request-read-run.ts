import { Cause, Effect, Exit } from 'effect'

import { runWithStops } from './cli-stops.js'
import { deadlineMessage, sendOneRequestRead, type OneRequestRead } from './one-request-read.js'

// ORI-2725: the stored-login side of `readOne`, loaded only when no bearer
// comes from the environment, so the token path never loads Effect.

export async function runOneRequestRead<T>(read: OneRequestRead, timeoutMs: number, stops: boolean): Promise<T | null> {
  const program = () => Effect.tryPromise({
    try: requestSignal => sendOneRequestRead<T>(read, requestSignal),
    catch: cause => cause,
  }).pipe(Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.fail(new Error(deadlineMessage(read))) }))
  const { exit, interrupted } = stops
    ? await runWithStops(program)
    : { exit: await Effect.runPromiseExit(program()), interrupted: undefined }
  if (Exit.isSuccess(exit)) return exit.value
  if (interrupted !== undefined) {
    process.stderr.write(`${read.name} interrupted.\n`)
    process.exitCode = interrupted
    return null
  }
  throw Cause.squash(exit.cause)
}
