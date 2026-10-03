import { Context, Effect, Result, Schema } from 'effect'

import { authedFetch } from './http.js'
import { providerWireRecord as record } from './provider-wire-record.js'
import { isProviderRefusalCode } from './provider-refusals.js'

import type { ModelConfigsCommandIo } from './model-configs-cli.js'

type ProviderListFailure =
  | { readonly _tag: 'Http'; readonly message: string }
  | { readonly _tag: 'Transport' }
  | { readonly _tag: 'Resolution'; readonly message: string }
  | { readonly _tag: 'Adapter'; readonly message: string }

function providerListFailureMessage(failure: ProviderListFailure): string {
  switch (failure._tag) {
    case 'Http': return failure.message
    case 'Transport': return 'Provider request failed'
    // Project selection remains the existing, separately owned adapter.
    case 'Resolution': case 'Adapter': return failure.message
    default: { const exhaustive: never = failure; return exhaustive }
  }
}

const ProviderListTransport = Context.Service<{
  readonly read: (project: string) => Effect.Effect<Response, ProviderListFailure>
}>('orizu/cli/ProviderListTransport')

const WireRecord = Schema.Record(Schema.String, Schema.Unknown)
const emptyWireRecord: Record<string, unknown> = {}

function providerListProgram(project: string, io: ModelConfigsCommandIo) {
  return Effect.gen(function*() {
    const transport = yield* ProviderListTransport
    const response = yield* transport.read(project)
    // Decode raw wire data; malformed JSON and non-record bodies retain the
    // existing empty record fallback without narrowing accepted record fields.
    const value = yield* Effect.promise(() => response.json().catch(() => null))
    const body = yield* Schema.decodeUnknownEffect(WireRecord)(value).pipe(
      Effect.catch(() => Effect.succeed(emptyWireRecord)),
    )
    if (!response.ok) {
      const message = typeof body.error === 'string' && isProviderRefusalCode(body.error) ? body.error : 'Provider request failed'
      return yield* Effect.fail<ProviderListFailure>({ _tag: 'Http', message })
    }
    yield* Effect.sync(() => {
      if (io.json) io.print(JSON.stringify(body))
      else {
        io.print('ID  PROTOCOL  HOST  CREDENTIAL ENV  BUILT-IN')
        for (const value of Array.isArray(body.providers) ? body.providers : []) {
          const row = record(value)
          io.print(`${row.id}  ${row.protocol}  ${row.host}  ${row.credentialEnv}  ${row.builtIn ? 'yes' : 'no'}`)
        }
      }
    })
  })
}

export async function listProviders(projectArg: string | null, io: ModelConfigsCommandIo): Promise<number> {
  const controller = new AbortController()
  let interrupted: 130 | 143 | undefined
  const interrupt = () => { interrupted = 130; controller.abort() }
  const terminate = () => { interrupted = 143; controller.abort() }
  const transport = {
    read: (project: string) => Effect.tryPromise({
      try: signal => (io.fetcher ?? authedFetch)(`/api/cli/providers?project=${encodeURIComponent(project)}`, {
        method: 'GET', signal: AbortSignal.any([signal, controller.signal]),
      }),
      // The retained HTTP adapter exposes login/config/refresh diagnostics as
      // untyped Error values. Preserve its public messages until ORI-2420
      // supplies typed adapter failures; never expose nested transport causes.
      catch: (cause): ProviderListFailure => cause instanceof Error
        ? { _tag: 'Adapter', message: cause.message }
        : { _tag: 'Transport' },
    }),
  }
  const program = Effect.gen(function*() {
    const project = yield* Effect.tryPromise({
      try: async () => {
        const project = await io.resolveProjectSlug?.(projectArg)
        if (!project) throw new Error('Project resolver unavailable')
        return project
      },
      catch: (cause): ProviderListFailure => ({ _tag: 'Resolution', message: cause instanceof Error ? cause.message : 'Provider request failed' }),
    })
    // The retained resolver is unsignalled. Do not suppress Node's natural
    // termination until the cancellable catalog transport has been admitted.
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => { process.once('SIGINT', interrupt); process.once('SIGTERM', terminate) }),
      () => providerListProgram(project, io).pipe(Effect.provideService(ProviderListTransport, transport)),
      () => Effect.sync(() => {
        process.removeListener('SIGINT', interrupt)
        process.removeListener('SIGTERM', terminate)
      }),
    )
  })
  try {
    const result = await Effect.runPromise(Effect.result(program), { signal: controller.signal })
    if (Result.isSuccess(result)) return 0
    const message = providerListFailureMessage(result.failure)
    io.print(io.json ? JSON.stringify({ error: message }) : message)
    return 1
  } catch {
    if (interrupted !== undefined) return interrupted
    io.print(io.json ? JSON.stringify({ error: 'Provider request failed' }) : 'Provider request failed')
    return 1
  }
}
