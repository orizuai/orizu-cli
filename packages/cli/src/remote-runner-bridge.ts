import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'

import { Data, Effect, Result, Schema, type Scope } from 'effect'

import type { RemoteRunnerCallInput, RemoteRunnerSession } from './remote-runner-call.js'

/** Local packaged inputs may contain large rows; this is separate from the 10 MiB remote reply cap. */
const INPUT_MAX_BYTES = 16 * 1024 * 1024

export class RemoteRunnerBridgeError extends Data.TaggedError('RemoteRunnerBridgeError')<{ message: string }> {}
class RemoteRunnerBridgeInputError extends Data.TaggedError('RemoteRunnerBridgeInputError')<{ message: string; status: number }> {}

export interface RemoteRunnerBridge {
  readonly url: string
  /** Idempotent, synchronous physical cleanup, also registered with the launch scope. */
  readonly close: Effect.Effect<void>
  /** Abort work immediately while retaining GET provenance for Python's bounded stop write. */
  readonly stopCalls: Effect.Effect<void>
}

const ObjectValue = Schema.Record(Schema.String, Schema.Unknown)
const CallInput = Schema.Struct({
  row_id: Schema.String.check(Schema.isNonEmpty()),
  row: ObjectValue,
  prompt: Schema.Struct({
    body: Schema.optionalKey(Schema.NullOr(Schema.String)),
    body_kind: Schema.String,
    provider_settings: Schema.optionalKey(ObjectValue),
  }),
  instruction_set: Schema.optionalKey(Schema.Struct({
    name: Schema.optionalKey(Schema.String),
    shape: Schema.Array(Schema.String),
    components: Schema.Record(Schema.String, Schema.String),
    model_config: ObjectValue,
    model_config_settings_version_id: Schema.optionalKey(Schema.String),
    pinned_components: Schema.optionalKey(ObjectValue),
  })),
  prompt_version_id: Schema.NullOr(Schema.String),
  runner_version_id: Schema.String,
  run_id: Schema.NullOr(Schema.String),
})

function readInput(request: IncomingMessage): Effect.Effect<RemoteRunnerCallInput, RemoteRunnerBridgeInputError> {
  return Effect.gen(function* () {
    const text = yield* Effect.callback<string, RemoteRunnerBridgeInputError>(resume => {
      const chunks: Buffer[] = []
      let size = 0
      const onData = (chunk: Buffer) => {
        size += chunk.length
        if (size > INPUT_MAX_BYTES) {
          request.pause()
          resume(Effect.fail(new RemoteRunnerBridgeInputError({ status: 413, message: `Remote runner bridge input exceeds ${INPUT_MAX_BYTES} bytes` })))
        } else chunks.push(chunk)
      }
      const onEnd = () => resume(Effect.succeed(Buffer.concat(chunks).toString('utf8')))
      const onError = () => resume(Effect.fail(new RemoteRunnerBridgeInputError({ status: 400, message: 'Remote runner bridge input was interrupted' })))
      request.on('data', onData)
      request.once('end', onEnd)
      request.once('error', onError)
      request.once('aborted', onError)
      return Effect.sync(() => {
        request.off('data', onData)
        request.off('end', onEnd)
        request.off('error', onError)
        request.off('aborted', onError)
      })
    })
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch {
      return yield* new RemoteRunnerBridgeInputError({ status: 400, message: 'Remote runner bridge input must be JSON' })
    }
    if (Result.isFailure(Schema.decodeUnknownResult(CallInput)(parsed))) {
      return yield* new RemoteRunnerBridgeInputError({ status: 400, message: 'Remote runner bridge input must be an ordinary runner input with row_id, row, prompt, and version/run identities' })
    }
    // Validation checks required fields without dropping ordinary packaged-input companions.
    return parsed as RemoteRunnerCallInput
  })
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' })
  response.end(JSON.stringify(value))
}

/** A capability-protected, loopback-only adapter; all customer HTTP policy belongs to the session. */
export function startRemoteRunnerBridge(session: RemoteRunnerSession): Effect.Effect<RemoteRunnerBridge, RemoteRunnerBridgeError, Scope.Scope> {
  return Effect.gen(function* () {
    const path = `/${randomUUID()}`
    const sockets = new Set<Socket>()
    const requests = new Set<AbortController>()
    let host = ''
    let closed = false
    let callsStopped = false
    const server = createServer((request, response) => {
      const controller = new AbortController()
      requests.add(controller)
      const abort = () => controller.abort()
      const onResponseClose = () => { if (!response.writableFinished) abort() }
      request.once('aborted', abort)
      // Keep an error listener even after body-reading interruption: socket teardown can emit ECONNRESET later.
      request.once('error', abort)
      response.once('close', onResponseClose)
      const workflow = Effect.gen(function* () {
        if (closed) return yield* Effect.interrupt
        if (request.url !== path || request.headers.host !== host) {
          writeJson(response, 404, { error: 'Remote runner bridge path not found', code: 'RemoteRunnerBridgeNotFound' })
          return
        }
        if (request.method === 'GET') {
          writeJson(response, 200, yield* session.summary)
          return
        }
        if (callsStopped) {
          writeJson(response, 503, { error: 'Remote runner calls have been stopped', code: 'RemoteRunnerStopped' })
          return
        }
        if (request.method !== 'POST') {
          writeJson(response, 405, { error: 'Remote runner bridge accepts GET or POST only', code: 'RemoteRunnerBridgeMethod' })
          return
        }
        if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
          writeJson(response, 415, { error: 'Remote runner bridge accepts application/json only', code: 'RemoteRunnerBridgeContentType' })
          return
        }
        const length = Number(request.headers['content-length'])
        if (length > INPUT_MAX_BYTES) {
          writeJson(response, 413, { error: `Remote runner bridge input exceeds ${INPUT_MAX_BYTES} bytes`, code: 'RemoteRunnerBridgeInputError' })
          return
        }
        const input = yield* readInput(request)
        writeJson(response, 200, yield* session.call(input))
      }).pipe(
        Effect.catch(error => Effect.sync(() => writeJson(response,
          error._tag === 'RemoteRunnerBridgeInputError' ? error.status : 502,
          { error: error.message, code: error._tag },
        ))),
        Effect.ensuring(Effect.sync(() => {
          requests.delete(controller)
          request.off('aborted', abort)
          response.off('close', onResponseClose)
        })),
      )
      // Node's event callback is only an adapter. Effect owns cancellation and the complete request workflow.
      void Effect.runPromiseExit(workflow, { signal: controller.signal }).then(exit => {
        if (exit._tag === 'Failure' && !response.writableEnded) response.destroy()
      })
    })
    server.on('connection', socket => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      if (closed) socket.destroy()
    })
    const stopCalls = Effect.sync(() => {
      callsStopped = true
      for (const controller of requests) controller.abort()
      requests.clear()
    })
    const close = Effect.sync(() => {
      if (closed) return
      closed = true
      Effect.runSync(stopCalls)
      server.close()
      for (const socket of sockets) socket.destroy()
      sockets.clear()
    })
    // Must stay synchronous: the launcher's stop/forced-kill path closes its scope with runSync.
    yield* Effect.addFinalizer(() => close)
    yield* Effect.callback<void, RemoteRunnerBridgeError>(resume => {
      const onError = () => resume(Effect.fail(new RemoteRunnerBridgeError({ message: 'Could not listen on the local remote runner bridge' })))
      server.on('error', onError)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') {
          resume(Effect.fail(new RemoteRunnerBridgeError({ message: 'Local remote runner bridge has no loopback address' })))
          return
        }
        host = `127.0.0.1:${address.port}`
        // Interruption during listen must not leave a listener appearing after synchronous cleanup.
        if (closed) { server.close(); return }
        resume(Effect.void)
      })
    })
    return { url: `http://${host}${path}`, close, stopCalls }
  })
}
