import { Cause, Effect, Exit, Result, Schema } from 'effect'

import { datasetTransferTimeoutMs } from './dataset-transfer-policy.js'
import { extractErrorMessage } from './error-response.js'
import { sanitizeTerminalText } from './json-response.js'
import { appErrorOf, unreachedCode } from './request-outcome.js'

// Loaded only through `await import(...)`, like the dataset workflows.

/** A new role for the member with this email, or their removal from the team. */
export type TeamMemberChange =
  | { readonly kind: 'role'; readonly teamSlug: string; readonly email: string; readonly role: string }
  | { readonly kind: 'remove'; readonly teamSlug: string; readonly email: string }

/** Sends one request; calls `onRequestStart` just before anything goes out. */
export type TeamMemberChangeRequest = (path: string, init: RequestInit, onRequestStart?: () => void) => Promise<Response>

interface ListedMember { readonly id: string; readonly email: string }

const texts = {
  role: {
    failed: 'Failed to update member role',
    label: 'Role change',
    // What the route says when it cannot tell whether the change was saved (#2291).
    serverMay: 'Role change may already be saved. Refresh the member list to check.',
    check: (change: TeamMemberChange) =>
      `The role may already be changed: run \`orizu teams members list --team ${change.teamSlug}\` and check the role of ${sanitizeTerminalText(change.email)}.`,
  },
  remove: {
    failed: 'Failed to remove team member',
    label: 'Member removal',
    serverMay: 'Member may already be removed. Refresh the member list before trying again.',
    check: (change: TeamMemberChange) =>
      `${sanitizeTerminalText(change.email)} may already be removed: run \`orizu teams members list --team ${change.teamSlug}\` and check whether they are still listed.`,
  },
} as const

const ChangeReply = Schema.Struct({ success: Schema.Literal(true) })

// The change may have happened when the server says so, when the reply was
// lost, late or unreadable after the request was sent, when a 5xx did not come
// from the app (a gateway giving up while the app kept working), or when the
// reply does not say it succeeded. Any other error reply is a clear refusal.
class TeamMemberChangeFailure extends Error {
  readonly _tag = 'TeamMemberChangeFailure'
  constructor(message: string, readonly mayHaveHappened: boolean) { super(message) }
}

// The member lookup changes nothing; only a server it never reached gets a
// plainer message than its own.
function findMember(change: TeamMemberChange, lookup: () => Promise<ListedMember[]>): Effect.Effect<ListedMember, TeamMemberChangeFailure> {
  const text = texts[change.kind]
  return Effect.tryPromise({
    try: lookup,
    catch: cause => {
      const unreached = unreachedCode(cause)
      return new TeamMemberChangeFailure(unreached ? `${text.failed}: could not reach the server (${unreached}).` : cause instanceof Error ? cause.message : String(cause), false)
    },
  }).pipe(Effect.flatMap(members => {
    const member = members.find(item => item.email.toLowerCase() === change.email.toLowerCase())
    return member
      ? Effect.succeed(member)
      : Effect.fail(new TeamMemberChangeFailure(`No member found with email '${change.email}' in team '${change.teamSlug}'`, false))
  }))
}

// One request, never retried: repeating a removal after an unknown outcome is
// refused as "Member not found", which hides that the first one worked.
function sendChange(change: TeamMemberChange, member: ListedMember, request: TeamMemberChangeRequest, timeoutMs: number): Effect.Effect<void, TeamMemberChangeFailure> {
  const text = texts[change.kind]
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
          const path = `/api/cli/teams/${encodeURIComponent(change.teamSlug)}/members/${encodeURIComponent(member.id)}`
          const init: RequestInit = change.kind === 'role'
            ? { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: change.role }), signal: controller.signal }
            : { method: 'DELETE', signal: controller.signal }
          const response = await request(path, init, () => { sent = true })
          if (!response.ok) {
            const appError = await appErrorOf(response.clone())
            const detail = await extractErrorMessage(response)
            if (appError === text.serverMay) throw new TeamMemberChangeFailure(appError, true)
            if (response.status < 400 || (response.status >= 500 && appError === null)) {
              throw new TeamMemberChangeFailure(`${text.label} got no clear answer (status ${response.status}).`, true)
            }
            // The route's own refusals already say what failed.
            throw new TeamMemberChangeFailure(detail.startsWith('Failed to ') ? detail : `${text.failed}: ${detail}`, false)
          }
          // Reading the body can still fail or stall; that stays under the deadline.
          const body = await response.text()
          let data: unknown
          try {
            data = JSON.parse(body)
          } catch {
            data = undefined
          }
          if (Result.isFailure(Schema.decodeUnknownResult(ChangeReply)(data))) {
            throw new TeamMemberChangeFailure(`${text.label} returned an unexpected response (status ${response.status}).`, true)
          }
        } finally {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          controller.abort()
        }
      },
      catch: cause => {
        if (cause instanceof TeamMemberChangeFailure) return cause
        if (timedOut) return new TeamMemberChangeFailure(`${text.label} exceeded its deadline.`, sent)
        const unreached = unreachedCode(cause)
        if (unreached) return new TeamMemberChangeFailure(`${text.failed}: could not reach the server (${unreached}).`, false)
        const message = cause instanceof Error ? cause.message : String(cause)
        if (!sent || message.startsWith('ORIZU_AUTH_CONTEXT_CHANGED:')) return new TeamMemberChangeFailure(message, false)
        // Also reached when a sign-in refresh fails after a 401: still told to
        // check, so say only that the change did not finish.
        return new TeamMemberChangeFailure(`${text.label} did not finish: ${message}`, true)
      },
    })
  })
}

/**
 * `orizu teams members role` and `orizu teams members remove`: looks up the
 * member by email, then changes them with one request. Returns the member, or
 * throws an error saying whether the change may already have happened.
 */
export async function changeTeamMemberWithDeadline(
  change: TeamMemberChange,
  lookup: () => Promise<ListedMember[]>,
  request: TeamMemberChangeRequest,
): Promise<ListedMember> {
  const text = texts[change.kind]
  const exit = await Effect.runPromiseExit(findMember(change, lookup).pipe(
    Effect.tap(member => sendChange(change, member, request, datasetTransferTimeoutMs())),
    Effect.mapError(failure => new Error(failure.mayHaveHappened ? `${failure.message}\n${text.check(change)}` : failure.message)),
  ))
  if (Exit.isSuccess(exit)) return exit.value
  throw Cause.squash(exit.cause)
}
