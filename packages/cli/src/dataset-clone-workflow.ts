import { Cause, Effect, Exit, Result, Schema } from 'effect'

import { datasetTransferTimeoutMs } from './dataset-transfer-policy.js'
import { authedFetch } from './http.js'
import { parseJsonResponse } from './json-response.js'

// Loaded only through `await import(...)` from dataset-commands, like lock.

const SERVER_MAY_BE_CREATED = 'Dataset clone may already be created'

const ClonedDataset = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  rowCount: Schema.Number,
  parentDatasetId: Schema.String,
})
const CloneReply = Schema.Struct({ dataset: ClonedDataset })
const ErrorReply = Schema.Struct({ error: Schema.String })
export type ClonedDataset = typeof ClonedDataset.Type

// A refusal means nothing was cloned. After any other failure once the request
// was sent, the clone may exist. Unlike lock, cloning again is not harmless: it
// makes another copy, so the clone is never retried and the user is told to look.
class CloneFailure extends Error {
  constructor(message: string, readonly mayBeCreated: boolean) { super(message) }
}

function mayBeCreatedGuidance(name: string | null): string {
  const target = name ? `a dataset named ${JSON.stringify(name)}` : 'a new dataset named after the source with " Copy" at the end'
  return `The clone may already have been created. Run \`orizu datasets list\` and look for ${target} before cloning again: running clone again makes another copy.`
}

// authedFetch raises this code only when it sent nothing, or when the server
// answered 401 and the changed credentials stopped a replay. Nothing was cloned.
function isAuthContextChange(cause: unknown): boolean {
  return cause instanceof Error && cause.message.startsWith('ORIZU_AUTH_CONTEXT_CHANGED:')
}

function serverError(text: string): string | null {
  try {
    const decoded = Schema.decodeUnknownResult(ErrorReply)(JSON.parse(text))
    return Result.isSuccess(decoded) ? decoded.success.error : null
  } catch {
    return null
  }
}

function cloneRequest(datasetId: string, name: string | null, timeoutMs: number) {
  return Effect.suspend(() => {
    let sent = false
    let timedOut = false
    return Effect.tryPromise({
      try: async signal => {
        const request = new AbortController()
        const abort = () => request.abort()
        const timer = setTimeout(() => { timedOut = true; request.abort() }, timeoutMs)
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
        try {
          const response = await authedFetch(`/api/cli/datasets/${encodeURIComponent(datasetId)}/clone`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(name ? { name } : {}),
            signal: request.signal,
          }, () => { sent = true })
          if (!response.ok) {
            const text = await response.text()
            const error = serverError(text)
            // The app's own 5xx bodies name what happened; anything else at 5xx
            // (a gateway page, an empty body) says nothing about the clone.
            const mayBeCreated = response.status < 400 || error === SERVER_MAY_BE_CREATED || (response.status >= 500 && error === null)
            throw new CloneFailure(`Clone failed: ${text}`, mayBeCreated)
          }
          const data = await parseJsonResponse<unknown>(response, 'Dataset clone')
          const decoded = Schema.decodeUnknownResult(CloneReply)(data)
          if (Result.isFailure(decoded)) {
            throw new CloneFailure(`Dataset clone returned an unexpected response (status ${response.status}).`, true)
          }
          return decoded.success.dataset
        } finally {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          request.abort()
        }
      },
      catch: cause => {
        if (timedOut) return new CloneFailure('DATASET_TRANSFER_TIMEOUT: Dataset clone exceeded its deadline', true)
        if (cause instanceof CloneFailure) return cause
        return new CloneFailure(cause instanceof Error ? cause.message : String(cause), sent && !isAuthContextChange(cause))
      },
    })
  }).pipe(Effect.mapError(failure => new Error(failure.mayBeCreated ? `${failure.message}\n${mayBeCreatedGuidance(name)}` : failure.message)))
}

// Nothing to clean up, so signals keep Node's default handling.
export async function cloneDataset(datasetId: string, name: string | null): Promise<ClonedDataset> {
  const exit = await Effect.runPromiseExit(cloneRequest(datasetId, name, datasetTransferTimeoutMs()))
  if (Exit.isSuccess(exit)) return exit.value
  throw Cause.squash(exit.cause)
}
