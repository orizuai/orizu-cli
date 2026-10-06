import { Cause, Effect, Exit, Result, Schema } from 'effect'

import { datasetTransferTimeoutMs } from './dataset-transfer-policy.js'
import { authedFetch } from './http.js'
import { parseJsonResponse } from './json-response.js'

// Loaded only through `await import(...)` from dataset-commands, like append.

const MAY_BE_LOCKED = 'The dataset may already be locked: running `orizu datasets lock` again is safe and shows its current state.'

const LockedDataset = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  rowCount: Schema.Number,
  lockedAt: Schema.String,
  lockedBy: Schema.NullOr(Schema.String),
})
const LockReply = Schema.Struct({ dataset: LockedDataset })
export type LockedDataset = typeof LockedDataset.Type

// A refusal (4xx) means nothing was locked. After any other failure once the
// request was sent, the lock may have committed; locking again is harmless.
class LockFailure extends Error {
  constructor(message: string, readonly mayBeLocked: boolean) { super(message) }
}

function lockRequest(datasetId: string, reason: string | null, timeoutMs: number) {
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
          const response = await authedFetch(`/api/cli/datasets/${encodeURIComponent(datasetId)}/lock`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(reason ? { reason } : {}),
            signal: request.signal,
          }, () => { sent = true })
          if (!response.ok) {
            throw new LockFailure(`Lock failed: ${await response.text()}`, response.status < 400 || response.status >= 500)
          }
          const data = await parseJsonResponse<unknown>(response, 'Dataset lock')
          const decoded = Schema.decodeUnknownResult(LockReply)(data)
          if (Result.isFailure(decoded)) {
            throw new LockFailure(`Dataset lock returned an unexpected response (status ${response.status}).`, true)
          }
          return decoded.success.dataset
        } finally {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          request.abort()
        }
      },
      catch: cause => {
        if (timedOut) return new LockFailure('DATASET_TRANSFER_TIMEOUT: Dataset lock exceeded its deadline', true)
        if (cause instanceof LockFailure) return cause
        return new LockFailure(cause instanceof Error ? cause.message : String(cause), sent)
      },
    })
  }).pipe(Effect.mapError(failure => new Error(failure.mayBeLocked ? `${failure.message}\n${MAY_BE_LOCKED}` : failure.message)))
}

// Nothing to clean up, so signals keep Node's default handling.
export async function lockDataset(datasetId: string, reason: string | null): Promise<LockedDataset> {
  const exit = await Effect.runPromiseExit(lockRequest(datasetId, reason, datasetTransferTimeoutMs()))
  if (Exit.isSuccess(exit)) return exit.value
  throw Cause.squash(exit.cause)
}
