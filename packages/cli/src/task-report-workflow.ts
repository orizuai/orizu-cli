import { Cause, Effect, Exit, Result, Schema } from 'effect'

import { datasetTransferTimeoutMs } from './dataset-transfer-policy.js'
import { isJsonErrorResponsePayload } from './error-response.js'
import { authedFetch } from './http.js'
import { parseJsonResponse } from './json-response.js'

// Loaded only through `await import(...)` from task-commands. One request per
// command, never retried, with the same deadline as the dataset workflows.

const mayBeSaved = (taskId: string) =>
  `The task report may already be saved: check with \`orizu tasks report get --task ${taskId}\` before setting it again.`

const SetReply = Schema.Struct({
  task: Schema.Struct({
    id: Schema.String,
    status: Schema.String,
    report: Schema.Struct({
      markdown: Schema.String,
      sourceName: Schema.NullOr(Schema.String),
      createdAt: Schema.NullOr(Schema.String),
    }),
  }),
})

// title, status and updatedAt stay optional, as in the payload type this replaced.
const GetReply = Schema.Struct({
  task: Schema.Struct({
    id: Schema.String,
    title: Schema.optionalKey(Schema.NullOr(Schema.String)),
    status: Schema.optionalKey(Schema.NullOr(Schema.String)),
    report: Schema.Struct({
      markdown: Schema.String,
      sourceName: Schema.NullOr(Schema.String),
      createdAt: Schema.NullOr(Schema.String),
      updatedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  }),
})

type TaskReportSetReply = typeof SetReply.Type
export type TaskReportGetReply = typeof GetReply.Type

// `mayBeSaved` (the #2164 rule): an error reply in the app's own `{ error }`
// shape is reported plainly, whatever its status. A lost, stalled or unreadable
// reply, a 5xx that did not come from the app (a gateway giving up while the
// app kept working), or a reply of the wrong shape means it may have been saved.
class ReportRequestFailure extends Error {
  constructor(message: string, readonly mayBeSaved: boolean, cause?: unknown) { super(message, { cause }) }
}

function isAppError(response: Response, text: string): boolean {
  try {
    return isJsonErrorResponsePayload(response, JSON.parse(text))
  } catch {
    return false
  }
}

/** One request with a deadline. Returns the reply as parsed once `accepts` agrees with its shape. */
function reportRequest(input: {
  taskId: string
  init: RequestInit
  failurePrefix: string
  label: string
  accepts: (data: unknown) => boolean
  deadlineMessage: string
  timeoutMs: number
  onSent?: () => void
}) {
  return Effect.suspend(() => {
    let sent = false
    let timedOut = false
    return Effect.tryPromise({
      try: async signal => {
        const request = new AbortController()
        const abort = () => request.abort()
        const timer = setTimeout(() => { timedOut = true; request.abort() }, input.timeoutMs)
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
        try {
          const response = await authedFetch(
            `/api/cli/tasks/${encodeURIComponent(input.taskId)}/report`,
            { ...input.init, signal: request.signal },
            () => { sent = true; input.onSent?.() }
          )
          if (!response.ok) {
            const text = await response.text()
            const fromApp = isAppError(response, text)
            throw new ReportRequestFailure(`${input.failurePrefix}: ${text}`, response.status < 400 || (response.status >= 500 && !fromApp))
          }
          const data = await parseJsonResponse<unknown>(response, input.label)
          if (!input.accepts(data)) {
            throw new ReportRequestFailure(`${input.label} returned an unexpected response (status ${response.status}).`, true)
          }
          return data
        } finally {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          request.abort()
        }
      },
      catch: cause => {
        if (timedOut) return new ReportRequestFailure(input.deadlineMessage, sent, cause)
        if (cause instanceof ReportRequestFailure) return cause
        return new ReportRequestFailure(cause instanceof Error ? cause.message : String(cause), sent, cause)
      },
    })
  })
}

const accepts = (schema: typeof SetReply | typeof GetReply) => (data: unknown) => Result.isSuccess(Schema.decodeUnknownResult(schema)(data))

export type TaskReportSetOutcome =
  | { kind: 'saved'; reply: TaskReportSetReply }
  | { kind: 'interrupted'; exitCode: 130 | 143 }

/**
 * `orizu tasks report set`. Ctrl-C or SIGTERM aborts the request and, once it
 * was sent, says the report may already be saved: the server finishes on its
 * own. Other failures throw, adding the same line when the outcome is unknown.
 */
export async function setTaskReport(taskId: string, report: { markdown: string; sourceName: string | null }): Promise<TaskReportSetOutcome> {
  const timeoutMs = datasetTransferTimeoutMs()
  const controller = new AbortController()
  let interrupted: 130 | 143 | undefined
  let sent = false
  const interrupt = () => { interrupted ??= 130; controller.abort() }
  const terminate = () => { interrupted ??= 143; controller.abort() }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  try {
    const exit = await Effect.runPromiseExit(reportRequest({
      taskId,
      init: {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reportMarkdown: report.markdown, reportSourceName: report.sourceName }),
      },
      failurePrefix: 'Failed to update task report',
      label: 'Task report update',
      accepts: accepts(SetReply),
      deadlineMessage: 'Task report save exceeded its deadline',
      timeoutMs,
      onSent: () => { sent = true },
    }), { signal: controller.signal })
    if (interrupted !== undefined) {
      process.stderr.write(sent ? `Task report save interrupted. ${mayBeSaved(taskId)}\n` : 'Task report save interrupted.\n')
      return { kind: 'interrupted', exitCode: interrupted }
    }
    if (Exit.isSuccess(exit)) return { kind: 'saved', reply: exit.value as TaskReportSetReply }
    throw withMayBeSaved(Cause.squash(exit.cause), taskId)
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', terminate)
  }
}

function withMayBeSaved(failure: unknown, taskId: string): unknown {
  if (!(failure instanceof ReportRequestFailure)) return failure
  const message = failure.mayBeSaved ? `${failure.message}\n${mayBeSaved(taskId)}` : failure.message
  return new Error(message, { cause: failure.cause })
}

/** `orizu tasks report get`: one read with a deadline. Signals keep Node's default handling. */
export async function getTaskReport(taskId: string): Promise<TaskReportGetReply> {
  const exit = await Effect.runPromiseExit(reportRequest({
    taskId,
    init: {},
    failurePrefix: 'Failed to read task report',
    label: 'Task report get',
    accepts: accepts(GetReply),
    deadlineMessage: 'Task report read exceeded its deadline',
    timeoutMs: datasetTransferTimeoutMs(),
  }))
  if (Exit.isSuccess(exit)) return exit.value as TaskReportGetReply
  const failure = Cause.squash(exit.cause)
  throw failure instanceof ReportRequestFailure ? new Error(failure.message, { cause: failure.cause }) : failure
}
