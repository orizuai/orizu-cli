import { Cause, Effect, Exit, Result, Schema } from 'effect'

import { datasetTransferTimeoutMs } from './dataset-transfer-policy.js'
import { extractErrorMessage } from './error-response.js'
import { appErrorOf, unreachedCode } from './request-outcome.js'

// Loaded only through `await import(...)`, like the team create workflow:
// the project create that setup and `orizu projects create` send.

/** Sends one request; calls `onRequestStart` just before anything goes out. */
export type ProjectCreateRequest = (path: string, init: RequestInit, onRequestStart?: () => void) => Promise<Response>

const CreateReply = Schema.Struct({
  project: Schema.Struct({
    id: Schema.NonEmptyString,
    name: Schema.String,
    slug: Schema.NonEmptyString,
    teamSlug: Schema.NonEmptyString,
    teamId: Schema.optional(Schema.String),
    teamName: Schema.optional(Schema.String),
    role: Schema.optional(Schema.String),
  }),
})

export interface CreatedProject {
  id: string
  name: string
  slug: string
  teamId: string
  teamName: string
  teamSlug: string
  role: string
}

/**
 * Runs one request under the time limit. `run` gets the signal to pass on and
 * the hook that marks the request as sent; the body is read inside `run`, so a
 * reply that stalls part way is under the limit too.
 */
function withDeadline<A, E>(
  timeoutMs: number,
  run: (signal: AbortSignal, markSent: () => void) => Promise<A>,
  onFailure: (cause: unknown, outcome: { timedOut: boolean, sent: boolean }) => E,
): Effect.Effect<A, E> {
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
          return await run(controller.signal, () => { sent = true })
        } finally {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          controller.abort()
        }
      },
      catch: cause => onFailure(cause, { timedOut, sent }),
    })
  })
}

async function runToPromise<A>(effect: Effect.Effect<A, Error>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) return exit.value
  throw Cause.squash(exit.cause)
}

const FAILED = 'Failed to create project'

const projectMayBeCreated = (teamSlug: string, name: string) =>
  `The project may already be created: run \`orizu projects list --team ${teamSlug}\` and look for "${name}" before creating it again.`

class ProjectCreateFailure extends Error {
  readonly _tag = 'ProjectCreateFailure'
  constructor(message: string, readonly mayBeCreated: boolean) { super(message) }
}

/**
 * `orizu projects create` and setup's project create: one request with a time
 * limit, never retried, since a retry after an unclear outcome could make a
 * second project. When the outcome is unclear, the error says how to check.
 */
export async function createProjectWithDeadline(teamSlug: string, name: string, request: ProjectCreateRequest): Promise<CreatedProject> {
  const create = withDeadline(datasetTransferTimeoutMs(), async (signal, markSent) => {
    const response = await request('/api/cli/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamSlug, name }),
      signal,
    }, markSent)
    if (!response.ok) {
      const appError = await appErrorOf(response.clone())
      const detail = await extractErrorMessage(response)
      // A 5xx that is not the app's own error may come from a gateway that gave up while the app kept working.
      if (response.status < 400 || (response.status >= 500 && appError === null)) {
        throw new ProjectCreateFailure(`Project create got no clear answer (status ${response.status}).`, true)
      }
      throw new ProjectCreateFailure(detail.startsWith(FAILED) ? detail : `${FAILED}: ${detail}`, false)
    }
    const body = await response.text()
    let data: unknown
    try {
      data = JSON.parse(body)
    } catch {
      data = undefined
    }
    const decoded = Schema.decodeUnknownResult(CreateReply)(data)
    if (Result.isFailure(decoded)) {
      throw new ProjectCreateFailure(`Project create returned an unexpected response (status ${response.status}).`, true)
    }
    const project = decoded.success.project
    return {
      id: project.id,
      name: project.name,
      slug: project.slug,
      teamId: project.teamId || '',
      teamName: project.teamName || project.teamSlug,
      teamSlug: project.teamSlug,
      role: project.role || 'admin',
    }
  }, (cause, { timedOut, sent }) => {
    if (cause instanceof ProjectCreateFailure) return cause
    if (timedOut) return new ProjectCreateFailure('Project create exceeded its deadline.', sent)
    const unreached = unreachedCode(cause)
    if (unreached) return new ProjectCreateFailure(`${FAILED}: could not reach the server (${unreached}).`, false)
    const message = cause instanceof Error ? cause.message : String(cause)
    if (!sent || message.startsWith('ORIZU_AUTH_CONTEXT_CHANGED:')) return new ProjectCreateFailure(message, false)
    return new ProjectCreateFailure(`Project create did not finish: ${message}`, true)
  })
  return await runToPromise(create.pipe(
    Effect.mapError(failure => new Error(failure.mayBeCreated ? `${failure.message}\n${projectMayBeCreated(teamSlug, name)}` : failure.message)),
  ))
}
