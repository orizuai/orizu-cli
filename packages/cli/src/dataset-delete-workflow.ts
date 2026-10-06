import { Cause, Effect, Exit, Result, Schema } from 'effect'

import { datasetTransferTimeoutMs } from './dataset-transfer-policy.js'
import { authedFetch } from './http.js'
import { parseJsonResponse } from './json-response.js'

// Loaded only through `await import(...)` from dataset-commands, like append.

const MAY_BE_DELETED = 'The dataset may already be deleted: check with `orizu datasets list --status all` before retrying.'

const DeleteReply = Schema.Struct({ dataset: Schema.Struct({ id: Schema.String }) })

// A refusal (4xx) means nothing was deleted. After any other failure once the
// request was sent, the delete may have committed, and it cannot be undone.
class DeleteFailure extends Error {
  constructor(message: string, readonly mayBeDeleted: boolean) { super(message) }
}

function deleteRequest(datasetId: string, project: string | null, timeoutMs: number) {
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
          const response = await authedFetch(`/api/cli/datasets/${encodeURIComponent(datasetId)}`, {
            method: 'DELETE',
            signal: request.signal,
          }, () => { sent = true })
          if (!response.ok) {
            const message = `Delete failed: ${await response.text()}`
            // A dependency refusal: archiving keeps the dataset and its references.
            if (response.status === 409) {
              const archive = `orizu datasets archive ${datasetId}${project ? ` --project ${project}` : ''}`
              throw new DeleteFailure(`${message}\nArchive it instead: \`${archive}\``, false)
            }
            throw new DeleteFailure(message, response.status < 400 || response.status >= 500)
          }
          const data = await parseJsonResponse<unknown>(response, 'Dataset delete')
          const decoded = Schema.decodeUnknownResult(DeleteReply)(data)
          if (Result.isFailure(decoded)) {
            throw new DeleteFailure(`Dataset delete returned an unexpected response (status ${response.status}).`, true)
          }
          return decoded.success.dataset
        } finally {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          request.abort()
        }
      },
      catch: cause => {
        if (timedOut) return new DeleteFailure('DATASET_TRANSFER_TIMEOUT: Dataset delete exceeded its deadline', true)
        if (cause instanceof DeleteFailure) return cause
        return new DeleteFailure(cause instanceof Error ? cause.message : String(cause), sent)
      },
    })
  }).pipe(Effect.mapError(failure => new Error(failure.mayBeDeleted ? `${failure.message}\n${MAY_BE_DELETED}` : failure.message)))
}

// Runs after the typed confirmation. Nothing to clean up, so signals keep
// Node's default handling.
// `project` (team/project), when known, goes into the archive hint.
export async function deleteDataset(datasetId: string, project: string | null): Promise<{ id: string }> {
  const exit = await Effect.runPromiseExit(deleteRequest(datasetId, project, datasetTransferTimeoutMs()))
  if (Exit.isSuccess(exit)) return exit.value
  throw Cause.squash(exit.cause)
}
