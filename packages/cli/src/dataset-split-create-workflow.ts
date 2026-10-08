import { Cause, Effect, Exit, Result, Schema } from 'effect'

import { datasetTransferTimeoutMs } from './dataset-transfer-policy.js'
import { authedFetch } from './http.js'
import { parseJsonResponse } from './json-response.js'

// Loaded only through `await import(...)` from dataset-commands, like clone.

const SERVER_MAY_BE_CREATED = 'Dataset split set may already be created'
// Ratios like 0.7 + 0.2 + 0.1 don't add up to exactly 1 in floating point.
const RATIO_GAP = 1e-9

const CreateReply = Schema.Struct({ splitSet: Schema.Struct({ id: Schema.String }) })
const ErrorReply = Schema.Struct({ error: Schema.String })

export interface SplitSetRequest {
  versionId: string
  name: string
  strategy: string
  seed: unknown
  train: number
  validation: number
  /** Absent means "whatever train and validation leave". */
  test: number | undefined
  partitions: unknown
  metadata: unknown
}

const shown = (value: number) => Math.round(value * 1e12) / 1e12

/** The same rule the app enforces, checked before anything is sent. */
export function splitRatioProblem(train: number, validation: number, test: number | undefined): string | null {
  if (train + validation > 1 + RATIO_GAP) return `--train plus --validation must not be more than 1 (they add up to ${shown(train + validation)})`
  if (test !== undefined && Math.abs(train + validation + test - 1) > RATIO_GAP) {
    return `--train, --validation and --test must add up to 1 (they add up to ${shown(train + validation + test)})`
  }
  return null
}

// A refusal means nothing was saved. After any other failure once the request
// was sent, the set may exist. The version allows one set per name, so running
// the same command again can't make a second copy; it is still never retried
// automatically, and the user is told how to check.
class SplitSetFailure extends Error {
  constructor(message: string, readonly mayBeCreated: boolean) { super(message) }
}

function mayBeCreatedGuidance(request: SplitSetRequest): string {
  return `The split set ${JSON.stringify(request.name)} may already have been created. Run \`orizu datasets splits list ${request.versionId}\` to check. Running the same command again is safe: a set with that name is refused, not duplicated.`
}

// authedFetch raises this code only when it sent nothing, or when the server
// answered 401 and the changed credentials stopped a replay. Nothing was saved.
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

function createRequest(request: SplitSetRequest, timeoutMs: number) {
  return Effect.suspend(() => {
    let sent = false
    let timedOut = false
    return Effect.tryPromise({
      try: async signal => {
        const abortController = new AbortController()
        const abort = () => abortController.abort()
        const timer = setTimeout(() => { timedOut = true; abortController.abort() }, timeoutMs)
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
        try {
          const response = await authedFetch(`/api/cli/dataset-versions/${encodeURIComponent(request.versionId)}/split-sets`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: request.name,
              strategy: request.strategy,
              seed: request.seed,
              train: request.train,
              validation: request.validation,
              test: request.test,
              partitions: request.partitions,
              metadata: request.metadata,
            }),
            signal: abortController.signal,
          }, () => { sent = true })
          if (!response.ok) {
            const text = await response.text()
            const error = serverError(text)
            // The app's own 5xx bodies name what happened; anything else at 5xx
            // (a gateway page, an empty body) says nothing about the set.
            const mayBeCreated = response.status < 400 || error === SERVER_MAY_BE_CREATED || (response.status >= 500 && error === null)
            throw new SplitSetFailure(`Failed to create dataset split set: ${text}`, mayBeCreated)
          }
          const data = await parseJsonResponse<unknown>(response, 'Dataset split set create')
          const decoded = Schema.decodeUnknownResult(CreateReply)(data)
          if (Result.isFailure(decoded)) {
            throw new SplitSetFailure(`Dataset split set create returned an unexpected response (status ${response.status}).`, true)
          }
          return decoded.success.splitSet.id
        } finally {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          abortController.abort()
        }
      },
      catch: cause => {
        if (timedOut) return new SplitSetFailure('DATASET_TRANSFER_TIMEOUT: Dataset split set create exceeded its deadline', sent)
        if (cause instanceof SplitSetFailure) return cause
        return new SplitSetFailure(cause instanceof Error ? cause.message : String(cause), sent && !isAuthContextChange(cause))
      },
    })
  }).pipe(Effect.mapError(failure => new Error(failure.mayBeCreated ? `${failure.message}\n${mayBeCreatedGuidance(request)}` : failure.message)))
}

// Nothing to clean up, so signals keep Node's default handling.
export async function createSplitSet(request: SplitSetRequest): Promise<string> {
  const exit = await Effect.runPromiseExit(createRequest(request, datasetTransferTimeoutMs()))
  if (Exit.isSuccess(exit)) return exit.value
  throw Cause.squash(exit.cause)
}
