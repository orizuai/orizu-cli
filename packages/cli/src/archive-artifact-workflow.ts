import { Cause, Effect, Exit, Result, Schema } from 'effect'

import { datasetTransferTimeoutMs } from './dataset-transfer-policy.js'
import { isJsonErrorResponsePayload } from './error-response.js'
import { authedFetch } from './http.js'
import { sanitizeTerminalText } from './json-response.js'

// Loaded only through `await import(...)` from archive-artifacts-cli.

const MAY_BE_SAVED = 'The change may already be saved: running the same command again is safe and shows its current state.'

const ArchiveReply = Schema.Struct({
  artifact: Schema.Struct({
    id: Schema.String,
    type: Schema.String,
    status: Schema.Literals(['active', 'archived']),
    archivedAt: Schema.NullOr(Schema.String),
    assigneeId: Schema.optionalKey(Schema.String),
  }),
})
export type ArchiveReply = typeof ArchiveReply.Type

export interface ArchiveRequest {
  path: string
  body: { archived: boolean; assigneeId?: string }
  // For example "archive dataset": the start of every failure message.
  label: string
  fetcher?: (path: string, init?: RequestInit) => Promise<Response>
}

// A refusal (4xx) means nothing changed. After any other failure once the
// request was sent, the change may have committed; repeating it is harmless.
class ArchiveFailure extends Error {
  constructor(message: string, readonly mayBeSaved: boolean) { super(message) }
}

async function reason(response: Response): Promise<string> {
  const text = await response.text()
  let payload: unknown = null
  try { payload = JSON.parse(text) } catch { /* not JSON */ }
  if (isJsonErrorResponsePayload(response, payload) && payload.error.length > 0) {
    return sanitizeTerminalText(payload.error).slice(0, 180)
  }
  // Never print a page body: a gateway's HTML says nothing useful.
  return `the server returned a page that isn't JSON (status ${response.status})`
}

function archiveRequest(request: ArchiveRequest, timeoutMs: number) {
  return Effect.suspend(() => {
    let sent = false
    let timedOut = false
    return Effect.tryPromise({
      try: async signal => {
        const controller = new AbortController()
        const abort = () => controller.abort()
        const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
        try {
          const init: RequestInit = {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(request.body),
            signal: controller.signal,
          }
          const response = request.fetcher
            ? (sent = true, await request.fetcher(request.path, init))
            : await authedFetch(request.path, init, () => { sent = true })
          if (!response.ok) {
            throw new ArchiveFailure(`Failed to ${request.label}: ${await reason(response)}`, response.status < 400 || response.status >= 500)
          }
          let data: unknown = null
          try { data = JSON.parse(await response.text()) } catch { /* decoded below */ }
          const decoded = Schema.decodeUnknownResult(ArchiveReply)(data)
          if (Result.isFailure(decoded)) {
            throw new ArchiveFailure(`Failed to ${request.label}: the server's answer could not be read (status ${response.status})`, true)
          }
          return decoded.success
        } finally {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          controller.abort()
        }
      },
      catch: cause => {
        if (timedOut) return new ArchiveFailure(`Failed to ${request.label}: the request exceeded its deadline`, true)
        if (cause instanceof ArchiveFailure) return cause
        const message = cause instanceof Error ? cause.message : String(cause)
        // Before sending (for example, not signed in) the message stands alone.
        return new ArchiveFailure(sent ? `Failed to ${request.label}: ${message}` : message, sent)
      },
    })
  }).pipe(Effect.mapError(failure => new Error(failure.mayBeSaved ? `${failure.message}\n${MAY_BE_SAVED}` : failure.message)))
}

// Nothing to clean up, so signals keep Node's default handling.
export async function archiveArtifact(request: ArchiveRequest): Promise<ArchiveReply> {
  const exit = await Effect.runPromiseExit(archiveRequest(request, datasetTransferTimeoutMs()))
  if (Exit.isSuccess(exit)) return exit.value
  throw Cause.squash(exit.cause)
}
