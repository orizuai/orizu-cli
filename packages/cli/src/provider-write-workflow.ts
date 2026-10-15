import { Data, Effect, Result } from 'effect'

import { authedFetch } from './http.js'
import { mayAlreadyBeSavedFields, mayAlreadyBeSavedLine } from './one-request-write.js'
import { providerWireRecord as object } from './provider-wire-record.js'
import { isProviderRefusalCode } from './provider-refusals.js'
import { unreachedCode } from './request-outcome.js'

import type { ModelConfigsCommandIo } from './model-configs-cli.js'

// ORI-2719: `orizu providers add` and `remove` as one Effect program. What
// each can run into, answered in one place.
class Failed extends Data.TaggedError('Failed')<{ message: string }> {}
// The request went out and no reply came back: the change may be saved.
class Lost extends Data.TaggedError('Lost') {}

export type ProviderWrite =
  | { readonly kind: 'add'; readonly id: string; readonly body: Record<string, unknown>; readonly before: () => Promise<void> }
  | { readonly kind: 'remove'; readonly id: string }

// The server refused the request (a 401, then the login refresh failed or
// the stored login changed, so it was not sent again; the session client
// marks both as rejected), or it never left this machine: nothing was saved,
// so the error keeps its own message.
function nothingSaved(cause: unknown): boolean {
  return unreachedCode(cause) !== null || (cause instanceof Error && (cause as { requestRejected?: unknown }).requestRejected === true)
}

const ADVICE = {
  add: { done: 'added', advice: 'check `orizu providers list` before adding it again' },
  remove: { done: 'removed', advice: 'check `orizu providers list`' },
} as const

export async function writeProvider(projectArg: string | null, write: ProviderWrite, io: ModelConfigsCommandIo): Promise<number> {
  const controller = new AbortController()
  let interrupted: 130 | 143 | undefined
  let sent = false
  const interrupt = () => { interrupted = 130; controller.abort() }
  const terminate = () => { interrupted = 143; controller.abort() }
  const markSent = () => { sent = true }
  const fetcher = io.fetcher
    ? (path: string, init: RequestInit) => { markSent(); return io.fetcher!(path, init) }
    : (path: string, init: RequestInit) => authedFetch(path, init, markSent)
  const failure = (cause: unknown) => cause instanceof Error ? cause.message : 'Provider request failed'

  const send = (project: string) => Effect.gen(function* () {
    const path = write.kind === 'add'
      ? `/api/cli/providers?project=${encodeURIComponent(project)}`
      : `/api/cli/providers/${encodeURIComponent(write.id)}?project=${encodeURIComponent(project)}`
    const init: RequestInit = write.kind === 'add'
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(write.body) }
      : { method: 'DELETE' }
    const response = yield* Effect.tryPromise({
      try: signal => fetcher(path, { ...init, signal: AbortSignal.any([signal, controller.signal]) }),
      // Login and config problems surface before anything is sent, with their
      // own messages, as do refused logins and connections that never opened.
      catch: cause => sent && !nothingSaved(cause) ? new Lost() : new Failed({ message: failure(cause) }),
    })
    const body: unknown = response.status === 204 ? null : yield* Effect.promise(() => response.json().catch(() => null))
    if (!response.ok) {
      const error = object(body).error
      return yield* new Failed({ message: typeof error === 'string' && isProviderRefusalCode(error) ? error : 'Provider request failed' })
    }
    if (write.kind === 'add') io.print(io.json ? JSON.stringify(object(body)) : `Added provider ${write.id}`)
    else io.print(io.json ? JSON.stringify({ removed: write.id }) : `Removed provider ${write.id}`)
  })

  const program = Effect.gen(function* () {
    const project = yield* Effect.tryPromise({
      try: async () => {
        const project = await io.resolveProjectSlug?.(projectArg)
        if (!project) throw new Error('Project resolver unavailable')
        return project
      },
      catch: cause => new Failed({ message: failure(cause) }),
    })
    if (write.kind === 'add') yield* Effect.tryPromise({ try: write.before, catch: cause => new Failed({ message: failure(cause) }) })
    // The project lookup and the probe save nothing and keep Node's own
    // termination: an aborted probe still mid-handshake would hold the CLI
    // open for Node's 10 s connect timeout. A stop during the request ends
    // it and exits 130 or 143.
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => { process.once('SIGINT', interrupt); process.once('SIGTERM', terminate) }),
      () => send(project),
      () => Effect.sync(() => {
        process.removeListener('SIGINT', interrupt)
        process.removeListener('SIGTERM', terminate)
      }),
    )
  })

  // The request went out and no answer came back, or a stop cut it off.
  const mayAlreadyBeSaved = (message: string) => {
    const { done, advice } = ADVICE[write.kind]
    io.print(io.json ? JSON.stringify({ error: message, ...mayAlreadyBeSavedFields(advice) }) : message)
    process.stderr.write(mayAlreadyBeSavedLine('provider', done, advice) + '\n')
  }
  try {
    const result = await Effect.runPromise(Effect.result(program), { signal: controller.signal })
    if (Result.isSuccess(result)) return 0
    if (result.failure._tag === 'Lost') mayAlreadyBeSaved('Provider request failed')
    else io.print(io.json ? JSON.stringify({ error: result.failure.message }) : result.failure.message)
    return 1
  } catch (error) {
    if (interrupted !== undefined) {
      // Stopped after the request went out: it may already be saved, so say
      // how to check. Stopped before it went out: nothing is saved and nothing
      // new is printed. A refused write has already ended the program with its
      // own message before a stop can land; a stop during the login refresh
      // after a 401 is the stop, so it gets the advice too.
      if (sent) mayAlreadyBeSaved('Provider request interrupted.')
      return interrupted
    }
    io.print(io.json ? JSON.stringify({ error: failure(error) }) : failure(error))
    return 1
  }
}
