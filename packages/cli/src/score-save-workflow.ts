import diagnostics from 'node:diagnostics_channel'

import { Cause, Effect, Exit, Result, Schema } from 'effect'

import { datasetTransferTimeoutMs } from './dataset-transfer-policy.js'
import { extractErrorMessage } from './error-response.js'
import { appErrorOf, unreachedCode } from './request-outcome.js'

// Loaded only through `await import(...)`, like the dataset workflows.

const SavedScore = Schema.Struct({ scoreRun: Schema.Struct({ id: Schema.NonEmptyString }) })
const SavedRun = Schema.Struct({ run: Schema.Struct({ id: Schema.NonEmptyString }) })

// `serverMayBeSaved` is what the route says when it cannot tell whether the run was saved.
const COMMANDS = {
  submit: { label: 'Score submit', failed: 'Failed to submit score', serverMayBeSaved: 'Score run may already be saved', saved: SavedScore },
  exec: { label: 'Scorer exec', failed: 'Failed to execute scorer', serverMayBeSaved: 'Score run may already be saved', saved: SavedScore },
  run: { label: 'Run submit', failed: 'Failed to submit run', serverMayBeSaved: 'Run may already be saved', saved: SavedRun },
} as const

// Node's fetch publishes this once a request's whole body has been written.
const BODY_SENT = 'undici:request:bodySent'

interface SaveRequest {
  /** The route path with its query, as sent. */
  path: string
  body: string
  project: string
  /** False for `scorers exec --no-submit`, which saves nothing. */
  saves: boolean
}

/** `scores submit` and `scorers exec`, or `runs submit` (ORI-1097 S3b). */
export type ScoreSave =
  | SaveRequest & { command: 'submit' | 'exec'; scorerVersionId: string }
  | SaveRequest & { command: 'run'; promptVersionId: string }

/** Sends one request; calls `onRequestStart` just before anything goes out. */
export type ScoreSaveRequest = (path: string, init: RequestInit, onRequestStart?: () => void) => Promise<Response>

const mayBeSaved = (save: ScoreSave) => save.command === 'run'
  ? `The run may already be saved: run \`orizu runs list --project ${save.project} --prompt-version ${save.promptVersionId}\` and check its newest runs before running this again.`
  : `The score may already be saved: run \`orizu scorers detail ${save.scorerVersionId} --project ${save.project}\` and check its newest score runs before running this again.`

// The run may be saved when the server says so, when the reply was lost, late
// or unreadable after the request was sent, when a 5xx did not come from the
// app (a gateway giving up while the app kept working), or when the reply has
// no run. Any other error reply is a clear refusal.
class ScoreSaveFailure extends Error {
  readonly _tag = 'ScoreSaveFailure'
  constructor(message: string, readonly mayBeSaved: boolean) { super(message) }
}

// One request, never retried: a retry after an unknown outcome could save a
// second run. The deadline starts once the whole body has been sent, so a
// large upload on a slow link takes as long as it did before.
function scoreSave(save: ScoreSave, request: ScoreSaveRequest, timeoutMs: number): Effect.Effect<Record<string, unknown>, ScoreSaveFailure> {
  const { label, failed, serverMayBeSaved, saved } = COMMANDS[save.command]
  return Effect.suspend(() => {
    let sent = false
    let timedOut = false
    return Effect.tryPromise({
      try: async signal => {
        const controller = new AbortController()
        const abort = () => controller.abort()
        let timer: ReturnType<typeof setTimeout> | undefined
        // Started (again, after a sign-in refresh) when this request's body has been sent.
        const onBodySent = (message: unknown) => {
          const sentRequest = (message as { request?: { method?: string; path?: string } }).request
          if (sentRequest?.method !== 'POST' || sentRequest.path !== save.path) return
          clearTimeout(timer)
          timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
        }
        diagnostics.subscribe(BODY_SENT, onBodySent)
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
        try {
          const response = await request(save.path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: save.body,
            signal: controller.signal,
          }, () => { sent = true })
          if (!response.ok) {
            const appError = await appErrorOf(response.clone())
            const detail = await extractErrorMessage(response)
            if (appError === serverMayBeSaved) throw new ScoreSaveFailure(appError, true)
            if (response.status < 400 || (response.status >= 500 && appError === null)) {
              throw new ScoreSaveFailure(`${label} got no clear answer (status ${response.status}).`, true)
            }
            throw new ScoreSaveFailure(detail.startsWith(failed) ? detail : `${failed}: ${detail}`, false)
          }
          // Reading the body can still fail or stall; that stays under the deadline.
          const text = await response.text()
          let data: unknown
          try {
            data = JSON.parse(text)
          } catch {
            data = undefined
          }
          const usable = save.saves
            ? Result.isSuccess(Schema.decodeUnknownResult(saved)(data))
            : typeof data === 'object' && data !== null && !Array.isArray(data)
          if (!usable) {
            throw new ScoreSaveFailure(`${label} returned an unexpected response (status ${response.status}).`, true)
          }
          return data as Record<string, unknown>
        } finally {
          diagnostics.unsubscribe(BODY_SENT, onBodySent)
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          controller.abort()
        }
      },
      catch: cause => {
        if (cause instanceof ScoreSaveFailure) return cause
        if (timedOut) return new ScoreSaveFailure(`${label} exceeded its deadline.`, sent)
        const unreached = unreachedCode(cause)
        if (unreached) return new ScoreSaveFailure(`${failed}: could not reach the server (${unreached}).`, false)
        const message = cause instanceof Error ? cause.message : String(cause)
        if (!sent || message.startsWith('ORIZU_AUTH_CONTEXT_CHANGED:')) return new ScoreSaveFailure(message, false)
        // Also reached when a sign-in refresh fails after a 401: still told to
        // check, so say only that the save did not finish.
        return new ScoreSaveFailure(`${label} did not finish: ${message}`, true)
      },
    })
  })
}

/** `orizu scores submit`, `orizu scorers exec` and `orizu runs submit`: the reply, or an error saying whether the save may have happened. */
export async function sendScoreSave(save: ScoreSave, request: ScoreSaveRequest): Promise<Record<string, unknown>> {
  const exit = await Effect.runPromiseExit(scoreSave(save, request, datasetTransferTimeoutMs()).pipe(
    Effect.mapError(failure => new Error(failure.mayBeSaved && save.saves ? `${failure.message}\n${mayBeSaved(save)}` : failure.message)),
  ))
  if (Exit.isSuccess(exit)) return exit.value
  throw Cause.squash(exit.cause)
}
