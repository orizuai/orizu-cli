import { Cause, Effect, Exit, Result, Schema } from 'effect'

import { datasetTransferTimeoutMs } from './dataset-transfer-policy.js'
import { extractErrorMessage, isJsonErrorResponsePayload } from './error-response.js'

// Loaded only through `await import(...)`, like the dataset workflows.

const FAILED = 'Failed to create team'
// What the server says when it cannot tell whether the team was saved.
const SERVER_MAY_BE_CREATED = 'Team may already be created. Check your teams before creating it again.'
// The request never reached a server, so nothing can have been created.
const UNREACHED_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'])

const teamMayBeCreated = (name: string) =>
  `The team may already be created: run \`orizu teams list\` and look for "${name}" before creating it again.`

const CreateReply = Schema.Struct({
  team: Schema.Struct({
    id: Schema.NonEmptyString,
    name: Schema.String,
    slug: Schema.NonEmptyString,
    role: Schema.String,
  }),
})

export type CreatedTeam = typeof CreateReply.Type['team']

/** Sends one request; calls `onRequestStart` just before anything goes out. */
export type TeamCreateRequest = (path: string, init: RequestInit, onRequestStart?: () => void) => Promise<Response>

// The team may exist when the server says so, when the reply was lost, late or
// unreadable after the request was sent, when a 5xx did not come from the app
// (a gateway giving up while the app kept working), or when the reply has no
// team. Any other error reply is a clear refusal.
class TeamCreateFailure extends Error {
  readonly _tag = 'TeamCreateFailure'
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

// fetch reports a refused connection as `fetch failed` with the reason in
// `cause`. For a name with several addresses (localhost) the cause is an
// AggregateError that carries the same code itself.
function unreachedCode(error: unknown): string | null {
  let current = error
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth += 1) {
    const { code, cause } = current as { code?: unknown; cause?: unknown }
    if (typeof code === 'string' && UNREACHED_CODES.has(code)) return code
    current = cause
  }
  return null
}

// One request, never retried: a retry after an unknown outcome could make a
// second team, or be refused as a duplicate of the first.
function teamCreate(name: string, request: TeamCreateRequest, timeoutMs: number): Effect.Effect<CreatedTeam, TeamCreateFailure> {
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
          const response = await request('/api/cli/teams', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
            signal: controller.signal,
          }, () => { sent = true })
          if (!response.ok) {
            const appError = await appErrorOf(response.clone())
            const detail = await extractErrorMessage(response)
            if (appError === SERVER_MAY_BE_CREATED) throw new TeamCreateFailure(appError, true)
            if (response.status < 400 || (response.status >= 500 && appError === null)) {
              throw new TeamCreateFailure(`Team create got no clear answer (status ${response.status}).`, true)
            }
            throw new TeamCreateFailure(detail.startsWith(FAILED) ? detail : `${FAILED}: ${detail}`, false)
          }
          // Reading the body can still fail or stall; that stays under the deadline.
          const body = await response.text()
          let data: unknown
          try {
            data = JSON.parse(body)
          } catch {
            data = undefined
          }
          const decoded = Schema.decodeUnknownResult(CreateReply)(data)
          if (Result.isFailure(decoded)) {
            throw new TeamCreateFailure(`Team create returned an unexpected response (status ${response.status}).`, true)
          }
          return decoded.success.team
        } finally {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          controller.abort()
        }
      },
      catch: cause => {
        if (cause instanceof TeamCreateFailure) return cause
        if (timedOut) return new TeamCreateFailure('Team create exceeded its deadline.', sent)
        const unreached = unreachedCode(cause)
        if (unreached) return new TeamCreateFailure(`${FAILED}: could not reach the server (${unreached}).`, false)
        const message = cause instanceof Error ? cause.message : String(cause)
        if (!sent || message.startsWith('ORIZU_AUTH_CONTEXT_CHANGED:')) return new TeamCreateFailure(message, false)
        // Also reached when a sign-in refresh fails after a 401: still told to
        // check, so say only that the create did not finish.
        return new TeamCreateFailure(`Team create did not finish: ${message}`, true)
      },
    })
  })
}

/** `orizu teams create` and `orizu setup`'s team create: the team, or an error saying whether it may exist. */
export async function createTeamWithDeadline(name: string, request: TeamCreateRequest): Promise<CreatedTeam> {
  const exit = await Effect.runPromiseExit(teamCreate(name, request, datasetTransferTimeoutMs()).pipe(
    Effect.mapError(failure => new Error(failure.mayBeCreated ? `${failure.message}\n${teamMayBeCreated(name)}` : failure.message)),
  ))
  if (Exit.isSuccess(exit)) return exit.value
  throw Cause.squash(exit.cause)
}
