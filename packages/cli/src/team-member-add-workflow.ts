import { Cause, Effect, Exit, Result, Schema } from 'effect'

import { datasetTransferTimeoutMs } from './dataset-transfer-policy.js'
import { extractErrorMessage } from './error-response.js'
import { sanitizeTerminalText } from './json-response.js'
import { appErrorOf, unreachedCode } from './request-outcome.js'

// Loaded only through `await import(...)`, like the dataset workflows.

const FAILED = 'Failed to add team member'
// What the route says when it cannot tell whether the invite was saved (ORI-2383 slice A).
const SERVER_MAY_BE_SAVED = 'Invite may already be saved. Refresh the member list before inviting again.'

// The route saves the address trimmed and lowercased, so the check names that address.
const mayBeInvited = (teamSlug: string, email: string) => {
  const saved = sanitizeTerminalText(email.trim().toLowerCase())
  return `${saved} may already be invited: run \`orizu teams members list --team ${teamSlug}\` and look for ${saved}. If they are listed, they were invited; don't invite them again.`
}

const AddReply = Schema.Struct({
  member: Schema.Struct({
    id: Schema.NonEmptyString,
    email: Schema.String,
  }),
})

/** The member as the server sent it; `--json` prints every field it has. */
export type AddedMember = typeof AddReply.Type['member'] & Readonly<Record<string, unknown>>

/** Sends one request; calls `onRequestStart` just before anything goes out. */
export type TeamMemberAddRequest = (path: string, init: RequestInit, onRequestStart?: () => void) => Promise<Response>

// The invite may be saved when the server says so, when the reply was lost,
// late or unreadable after the request was sent, when a 5xx did not come from
// the app (a gateway giving up while the app kept working), or when the reply
// has no member. Any other error reply is a clear refusal.
class TeamMemberAddFailure extends Error {
  readonly _tag = 'TeamMemberAddFailure'
  constructor(message: string, readonly mayBeSaved: boolean) { super(message) }
}

// One request, never retried: a retry after a saved invite is refused as
// "already a member", which hides that the first one worked.
function memberAdd(teamSlug: string, email: string, request: TeamMemberAddRequest, timeoutMs: number): Effect.Effect<AddedMember, TeamMemberAddFailure> {
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
          const response = await request(`/api/cli/teams/${encodeURIComponent(teamSlug)}/members`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email }),
            signal: controller.signal,
          }, () => { sent = true })
          if (!response.ok) {
            const appError = await appErrorOf(response.clone())
            const detail = await extractErrorMessage(response)
            if (appError === SERVER_MAY_BE_SAVED) throw new TeamMemberAddFailure(appError, true)
            if (response.status < 400 || (response.status >= 500 && appError === null)) {
              throw new TeamMemberAddFailure(`Member add got no clear answer (status ${response.status}).`, true)
            }
            // The route's own failures already say what failed.
            throw new TeamMemberAddFailure(detail.startsWith('Failed to ') ? detail : `${FAILED}: ${detail}`, false)
          }
          // Reading the body can still fail or stall; that stays under the deadline.
          const body = await response.text()
          let data: unknown
          try {
            data = JSON.parse(body)
          } catch {
            data = undefined
          }
          if (Result.isFailure(Schema.decodeUnknownResult(AddReply)(data))) {
            throw new TeamMemberAddFailure(`Member add returned an unexpected response (status ${response.status}).`, true)
          }
          // Decoding keeps only the named fields; the reply's member is returned whole.
          return (data as { member: AddedMember }).member
        } finally {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          controller.abort()
        }
      },
      catch: cause => {
        if (cause instanceof TeamMemberAddFailure) return cause
        if (timedOut) return new TeamMemberAddFailure('Member add exceeded its deadline.', sent)
        const unreached = unreachedCode(cause)
        if (unreached) return new TeamMemberAddFailure(`${FAILED}: could not reach the server (${unreached}).`, false)
        const message = cause instanceof Error ? cause.message : String(cause)
        if (!sent || message.startsWith('ORIZU_AUTH_CONTEXT_CHANGED:')) return new TeamMemberAddFailure(message, false)
        // Also reached when a sign-in refresh fails after a 401: still told to
        // check, so say only that the invite did not finish.
        return new TeamMemberAddFailure(`Member add did not finish: ${message}`, true)
      },
    })
  })
}

/** `orizu teams members add`: the invited member, or an error saying whether the invite may be saved. */
export async function addTeamMemberWithDeadline(teamSlug: string, email: string, request: TeamMemberAddRequest): Promise<AddedMember> {
  const exit = await Effect.runPromiseExit(memberAdd(teamSlug, email, request, datasetTransferTimeoutMs()).pipe(
    Effect.mapError(failure => new Error(failure.mayBeSaved ? `${failure.message}\n${mayBeInvited(teamSlug, email)}` : failure.message)),
  ))
  if (Exit.isSuccess(exit)) return exit.value
  throw Cause.squash(exit.cause)
}
