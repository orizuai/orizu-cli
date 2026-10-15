import { Cause, Effect, Exit, Result, Schema } from 'effect'

import { datasetTransferTimeoutMs } from './dataset-transfer-policy.js'
import { isJsonErrorResponsePayload } from './error-response.js'
import { authedFetch } from './http.js'
import { sanitizeTerminalText } from './json-response.js'
import { errorOutputSecrets } from './last-error-record.js'
import { unreachedCode } from './request-outcome.js'
import { redactSecrets } from './secret-redaction.js'

// ORI-2726: one CLI write sent as one request, with a deadline, Ctrl-C and
// SIGTERM handling, and one way of saying that a write may already be saved
// when no clear answer came back. Shared with `orizu providers` (ORI-2719).

// The words a one-request CLI write uses when its request was sent but no
// reply came back, so the change may already be saved (ORI-2726, ORI-2719).
export interface MayAlreadyBeSaved {
  readonly mayAlreadyBeSaved: true
  readonly advice: string
}

/** `The <thing> may already be <done>: <advice>.` */
export function mayAlreadyBeSavedLine(thing: string, done: string, advice: string): string {
  return `The ${thing} may already be ${done}: ${advice}.`
}

/** The fields a `--json` failure object gains. */
export function mayAlreadyBeSavedFields(advice: string): MayAlreadyBeSaved {
  return { mayAlreadyBeSaved: true, advice }
}

/** What to tell a person when a write may have saved but no clear answer came back. */
export interface MayAlreadyBeSavedNote {
  /** For example "task". */
  thing: string
  /** For example "created". */
  done: string
  /** What to do next, for example "check `orizu tasks list` before creating it again". */
  advice: string
}

const noteLine = (note: MayAlreadyBeSavedNote) => mayAlreadyBeSavedLine(note.thing, note.done, note.advice)

export interface OneRequestWrite<A> {
  /** For example "update task": every failure starts `Failed to update task:`. */
  label: string
  /** For example "Task update": Ctrl-C prints `Task update interrupted.`. */
  name: string
  path: string
  method: 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  reply: Schema.Decoder<A>
  mayAlreadyBeSaved: MayAlreadyBeSavedNote
  /**
   * The message and `--json` object for a reply that is the app's own
   * `{ error }`, when the command words it itself (task create).
   */
  describeError?: (response: Response) => Promise<{ message: string; json: { error: string } & Record<string, unknown> }>
  json: boolean
  print: (line: string) => void
  /** Stands in for `authedFetch` in tests; the request counts as sent once it is called. */
  fetcher?: (path: string, init: RequestInit) => Promise<Response>
}

export type OneRequestWriteOutcome<A> =
  | { kind: 'saved'; reply: A }
  | { kind: 'interrupted'; exitCode: 130 | 143 }

// `mayBeSaved` is false only when the server certainly changed nothing: a
// refusal (4xx), or a request that never left this machine. `json` is the
// `--json` failure object: the server's own `{ error }` text where it gave one,
// as the CLI printed it before, otherwise the reason alone.
class WriteFailure {
  readonly json: Record<string, unknown>
  constructor(readonly message: string, readonly mayBeSaved: boolean, json: { error: string } & Record<string, unknown>) { this.json = json }
}

const MAX_ERROR_LENGTH = 180

function send<A>(write: OneRequestWrite<A>, timeoutMs: number, onSent: () => void): Effect.Effect<A, WriteFailure> {
  const failed = (reason: string) => `Failed to ${write.label}: ${reason}`
  return Effect.suspend(() => {
    let sent = false
    let timedOut = false
    const markSent = () => { sent = true; onSent() }
    return Effect.tryPromise({
      try: async signal => {
        const controller = new AbortController()
        const abort = () => controller.abort()
        const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
        try {
          const init: RequestInit = {
            method: write.method,
            ...(write.body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(write.body) }),
            signal: controller.signal,
          }
          const response = write.fetcher
            ? (markSent(), await write.fetcher(write.path, init))
            : await authedFetch(write.path, init, markSent)
          const text = await response.text()
          let data: unknown = undefined
          try { data = JSON.parse(text) } catch { /* not JSON */ }
          if (!response.ok) {
            // A refusal means nothing changed; any other status may follow a save.
            const refused = response.status >= 400 && response.status < 500
            if (!isJsonErrorResponsePayload(response, data) || data.error.length === 0) {
              // Never print a page body: a gateway's HTML says nothing useful.
              const reason = `the server returned a page that isn't JSON (status ${response.status})`
              throw new WriteFailure(failed(reason), !refused, { error: reason, httpStatus: response.status })
            }
            if (write.describeError) {
              const described = await write.describeError(new Response(text, { status: response.status, headers: response.headers }))
              throw new WriteFailure(described.message, !refused, described.json)
            }
            const reason = sanitizeTerminalText(data.error).slice(0, MAX_ERROR_LENGTH)
            throw new WriteFailure(failed(reason), !refused, { error: reason, httpStatus: response.status })
          }
          const decoded = Schema.decodeUnknownResult(write.reply)(data)
          if (Result.isFailure(decoded)) {
            const reason = `the server's answer could not be read (status ${response.status})`
            throw new WriteFailure(failed(reason), true, { error: reason, httpStatus: response.status })
          }
          return decoded.success
        } finally {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          controller.abort()
        }
      },
      catch: cause => {
        if (cause instanceof WriteFailure) return cause
        const because = (reason: string, mayBeSaved: boolean) => new WriteFailure(failed(reason), mayBeSaved, { error: reason })
        if (timedOut) return because('the request exceeded its deadline', true)
        const code = unreachedCode(cause)
        if (code) return because(`could not reach the server (${code})`, false)
        const reason = sanitizeTerminalText(cause instanceof Error ? cause.message : String(cause))
        // The server answered 401 and the sign-in could not be renewed, or the
        // saved login changed before the resend (both marked `requestRejected`):
        // the write was refused, so the message stands alone as before.
        if ((cause as { requestRejected?: unknown } | null)?.requestRejected === true) return new WriteFailure(reason, false, { error: reason })
        // Before sending (for example, not signed in) the message stands alone.
        return sent ? because(reason, true) : new WriteFailure(reason, false, { error: reason })
      },
    })
  })
}

// A `--json` failure object can quote the server's error text, so secrets this
// process holds (the bearer, a forwarded key) are hidden there as on stderr.
function printJson(write: Pick<OneRequestWrite<unknown>, 'print'>, value: Record<string, unknown>): void {
  write.print(JSON.stringify(redactSecrets(value, { secrets: errorOutputSecrets() })))
}

/**
 * Sends one write. Ctrl-C or SIGTERM stops the wait and returns `interrupted`
 * with the shell's usual exit code; the server may still finish on its own, so
 * once the request was sent the person is told what may be saved. Any other
 * failure throws, adding that line when the outcome is unknown. With `json`,
 * every failure also prints one object on stdout.
 */
export async function sendOneRequestWrite<A>(write: OneRequestWrite<A>): Promise<OneRequestWriteOutcome<A>> {
  const timeoutMs = datasetTransferTimeoutMs()
  const controller = new AbortController()
  let interrupted: 130 | 143 | undefined
  let sent = false
  const interrupt = () => { interrupted ??= 130; controller.abort() }
  const terminate = () => { interrupted ??= 143; controller.abort() }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  try {
    const exit = await Effect.runPromiseExit(send(write, timeoutMs, () => { sent = true }), { signal: controller.signal })
    if (Exit.isSuccess(exit)) return { kind: 'saved', reply: exit.value }
    if (interrupted !== undefined) {
      const message = `${write.name} interrupted.`
      const unknown = sent ? mayAlreadyBeSavedFields(write.mayAlreadyBeSaved.advice) : {}
      if (write.json) printJson(write, { error: message, ...unknown })
      process.stderr.write(sent ? `${message}\n${noteLine(write.mayAlreadyBeSaved)}\n` : `${message}\n`)
      return { kind: 'interrupted', exitCode: interrupted }
    }
    const failure = Cause.squash(exit.cause)
    if (!(failure instanceof WriteFailure)) throw failure
    if (write.json) {
      printJson(write, { ...failure.json, ...(failure.mayBeSaved ? mayAlreadyBeSavedFields(write.mayAlreadyBeSaved.advice) : {}) })
    }
    throw new Error(failure.mayBeSaved ? `${failure.message}\n${noteLine(write.mayAlreadyBeSaved)}` : failure.message)
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', terminate)
  }
}
