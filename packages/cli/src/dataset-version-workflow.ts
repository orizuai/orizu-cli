import { Cause, Effect, Exit, Result, Schema } from 'effect'

import { datasetTransferTimeoutMs } from './dataset-transfer-policy.js'
import { extractErrorMessage, isJsonErrorResponsePayload } from './error-response.js'
import { authedFetch } from './http.js'
import { parseJsonResponse } from './json-response.js'

// Loaded only through `await import(...)`, like the README and delete workflows.

export const VERSION_MAY_BE_CREATED = "The version may already be created: check the dataset's versions in the web app before creating it again."
// What the server says when it cannot tell whether the version was saved.
const SERVER_MAY_BE_CREATED = 'Dataset version may already be created'

const CreateReply = Schema.Struct({
  datasetVersion: Schema.Struct({
    id: Schema.NonEmptyString,
    rowCount: Schema.Number,
    artifactFormat: Schema.optional(Schema.String),
    artifactStoragePath: Schema.optional(Schema.String),
  }),
})

export type DatasetVersionResponse = typeof CreateReply.Type

export interface DatasetVersionRequest {
  versionLabel?: string | null
  readmeMarkdown?: string | null
}

// The version may exist when the server says so, when the reply was lost or
// unreadable after the request was sent, or when a 5xx did not come from the
// app (a gateway giving up while the app kept working). Any other error reply
// is a clear refusal.
export class DatasetVersionFailure extends Error {
  readonly _tag = 'DatasetVersionFailure'
  constructor(message: string, readonly mayBeCreated: boolean) { super(message) }
}

async function appErrorOf(response: Response): Promise<string | null> {
  try {
    const payload: unknown = await response.json()
    return isJsonErrorResponsePayload(response, payload) ? payload.error : null
  } catch {
    return null
  }
}

// One request, never retried: a retry after an unknown outcome could add a
// second version.
export function datasetVersionSnapshot(datasetId: string, options: DatasetVersionRequest, timeoutMs: number): Effect.Effect<DatasetVersionResponse, DatasetVersionFailure> {
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
          const response = await authedFetch(`/api/cli/datasets/${encodeURIComponent(datasetId)}/versions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ...(options.versionLabel ? { versionLabel: options.versionLabel } : {}),
              ...(options.readmeMarkdown !== undefined && options.readmeMarkdown !== null
                ? { readmeMarkdown: options.readmeMarkdown }
                : {}),
            }),
            signal: request.signal,
          }, () => { sent = true })
          if (!response.ok) {
            const serverError = await appErrorOf(response.clone())
            const message = `Failed to create dataset version: ${await extractErrorMessage(response)}`
            throw new DatasetVersionFailure(message, response.status < 400 || serverError === SERVER_MAY_BE_CREATED || (response.status >= 500 && serverError === null))
          }
          const data = await parseJsonResponse<unknown>(response, 'Dataset version create')
          const decoded = Schema.decodeUnknownResult(CreateReply)(data)
          if (Result.isFailure(decoded)) {
            throw new DatasetVersionFailure(`Dataset version create returned an unexpected response (status ${response.status}).`, true)
          }
          return decoded.success
        } finally {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          request.abort()
        }
      },
      catch: cause => {
        if (timedOut) return new DatasetVersionFailure('DATASET_TRANSFER_TIMEOUT: Dataset version create exceeded its deadline', sent)
        if (cause instanceof DatasetVersionFailure) return cause
        return new DatasetVersionFailure(cause instanceof Error ? cause.message : String(cause), sent)
      },
    })
  })
}

export async function createDatasetVersionSnapshot(datasetId: string, options: DatasetVersionRequest): Promise<DatasetVersionResponse> {
  const exit = await Effect.runPromiseExit(datasetVersionSnapshot(datasetId, options, datasetTransferTimeoutMs()).pipe(
    Effect.mapError(failure => new Error(failure.mayBeCreated ? `${failure.message}\n${VERSION_MAY_BE_CREATED}` : failure.message)),
  ))
  if (Exit.isSuccess(exit)) return exit.value
  throw Cause.squash(exit.cause)
}
