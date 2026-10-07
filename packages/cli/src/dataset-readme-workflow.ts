import { Cause, Effect, Exit, Result, Schema } from 'effect'

import { datasetTransferTimeoutMs } from './dataset-transfer-policy.js'
import { authedFetch } from './http.js'
import { parseJsonResponse } from './json-response.js'

// Loaded only through `await import(...)` from dataset-commands, like delete.

const MAY_BE_SAVED = "The README may already be saved as a new version: check the dataset's README tab before saving again."
const SAVED_AT_SAME_TIME = 'Another README save for this dataset happened at the same time, so yours was not saved. Run the command again to save it as the next version.'

const SaveReply = Schema.Struct({
  version: Schema.Struct({
    id: Schema.String,
    dataset_id: Schema.String,
    version_num: Schema.Number,
    created_at: Schema.String,
  }),
})

export type SavedReadmeVersion = typeof SaveReply.Type['version']

// A refusal (4xx) means nothing was saved. After any other failure once the
// request was sent, a new version may exist; saving again would add another.
class SaveFailure extends Error {
  constructor(message: string, readonly mayBeSaved: boolean) { super(message) }
}

function saveRequest(datasetId: string, markdown: string, timeoutMs: number) {
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
          const response = await authedFetch(`/api/cli/datasets/${encodeURIComponent(datasetId)}/readme`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ markdown }),
            signal: request.signal,
          }, () => { sent = true })
          if (!response.ok) {
            const message = `Failed to save dataset README: ${await response.text()}`
            // The unique version number refused a save that lost a race.
            if (response.status === 409) throw new SaveFailure(`${message}\n${SAVED_AT_SAME_TIME}`, false)
            throw new SaveFailure(message, response.status < 400 || response.status >= 500)
          }
          const data = await parseJsonResponse<unknown>(response, 'Dataset README save')
          const decoded = Schema.decodeUnknownResult(SaveReply)(data)
          if (Result.isFailure(decoded)) {
            throw new SaveFailure(`Dataset README save returned an unexpected response (status ${response.status}).`, true)
          }
          return decoded.success.version
        } finally {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          request.abort()
        }
      },
      catch: cause => {
        if (timedOut) return new SaveFailure('DATASET_TRANSFER_TIMEOUT: README save exceeded its deadline', sent)
        if (cause instanceof SaveFailure) return cause
        return new SaveFailure(cause instanceof Error ? cause.message : String(cause), sent)
      },
    })
  }).pipe(Effect.mapError(failure => new Error(failure.mayBeSaved ? `${failure.message}\n${MAY_BE_SAVED}` : failure.message)))
}

// One request, never retried: a retry after an unknown outcome could add a
// duplicate version.
export async function saveDatasetReadme(datasetId: string, markdown: string): Promise<SavedReadmeVersion> {
  const exit = await Effect.runPromiseExit(saveRequest(datasetId, markdown, datasetTransferTimeoutMs()))
  if (Exit.isSuccess(exit)) return exit.value
  throw Cause.squash(exit.cause)
}
