// ORI-2764 (ORI-2735c): `orizu team egress-allowlist` on Effect. Loaded only
// through `await import(...)` from egress-allowlist-cli.ts, so other commands
// never load Effect.
//
// - Each request has the dataset-transfer deadline (120 s by default).
// - The PUT is the only write. Once it was sent, a lost or late reply may
//   still be saved. Every change is safe to repeat (`--set`/`--clear` replace
//   the list, `--add`/`--remove` read it again first), so the CLI says
//   running the same command again is safe.
// - Ctrl-C and SIGTERM stop a wait with 130 and 143.
import { Cause, Effect, Exit } from 'effect'

import { datasetTransferTimeoutMs } from './dataset-transfer-policy.js'
import {
  deriveCapped,
  emit,
  splitDomains,
  type CliFetcher,
  type CurrentAllowlist,
  type EgressAllowlistCommandIo,
  stringArray,
} from './egress-allowlist-cli.js'
import { authedFetch } from './http.js'
import { mayAlreadyBeSavedLine } from './one-request-write.js'
import { unreachedCode } from './request-outcome.js'

const MAY_BE = mayAlreadyBeSavedLine('egress allowlist', 'updated', 'running the same command again is safe')

/** A failure the command prints as one message, plus the may-be line when the update may be saved. */
class EgressFailure {
  constructor(readonly message: string, readonly mayBeSaved = false) {}
}

interface Reply { status: number; ok: boolean; statusText: string; text: string }

/** Whether the PUT has been sent, so an interruption can say it may be saved. */
interface Progress { putSent: boolean }

/** The server's `{ error }`, else the status text, else the status, as before. */
function replyMessage(reply: Reply): string {
  try {
    const data = JSON.parse(reply.text) as Record<string, unknown>
    const error = typeof data.error === 'string' ? data.error : null
    return error || reply.statusText || String(reply.status)
  } catch {
    return reply.statusText || String(reply.status)
  }
}

/**
 * One request. A deadline says so under `label`; any other failure keeps
 * today's text. For the PUT, a failure after sending may be saved.
 */
function request(fetcher: CliFetcher | undefined, path: string, init: RequestInit, label: string, timeoutMs: number, progress: Progress | null): Effect.Effect<Reply, EgressFailure> {
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
        const markSent = () => { sent = true; if (progress) progress.putSent = true }
        try {
          const requestInit = { ...init, signal: controller.signal }
          const response = fetcher
            ? (markSent(), await fetcher(path, requestInit))
            : await authedFetch(path, requestInit, markSent)
          return { status: response.status, ok: response.ok, statusText: response.statusText, text: await response.text() }
        } finally {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          controller.abort()
        }
      },
      catch: cause => {
        const mayBeSaved = progress !== null && sent
        if (timedOut) return new EgressFailure(`${label}: the request exceeded its deadline`, mayBeSaved)
        // Refused before it reached the server, or a 401 whose sign-in could not be renewed: nothing saved.
        const refused = unreachedCode(cause) !== null || (cause as { requestRejected?: unknown } | null)?.requestRejected === true
        return new EgressFailure(cause instanceof Error ? cause.message : String(cause), mayBeSaved && !refused)
      },
    })
  })
}

/** A 2xx reply's JSON object; a non-JSON reply fails with the parse error, as before. */
function parseReply(reply: Reply): Effect.Effect<Record<string, unknown>, EgressFailure> {
  return Effect.try({
    try: () => JSON.parse(reply.text) as Record<string, unknown>,
    catch: cause => new EgressFailure(cause instanceof Error ? cause.message : String(cause)),
  })
}

function readCurrent(fetcher: CliFetcher | undefined, path: string, timeoutMs: number): Effect.Effect<CurrentAllowlist, EgressFailure> {
  return Effect.gen(function* () {
    const reply = yield* request(fetcher, path, { method: 'GET' }, 'show failed', timeoutMs, null)
    if (!reply.ok) return yield* Effect.fail(new EgressFailure(`show failed (${reply.status}): ${replyMessage(reply)}`))
    const data = yield* parseReply(reply)
    return { domains: stringArray(data.extraDomains), invalid: stringArray(data.invalidDomains), capped: stringArray(data.cappedDomains) }
  })
}

/** What one run does: show the list, or change it. */
export interface EgressAllowlistRun {
  teamSlug: string
  path: string
  setValue: string | null
  addValue: string | null
  removeValue: string | null
  clear: boolean
}

const isMutation = (run: EgressAllowlistRun) => run.setValue !== null || run.addValue !== null || run.removeValue !== null || run.clear

function egressAllowlist(run: EgressAllowlistRun, io: EgressAllowlistCommandIo, timeoutMs: number, progress: Progress): Effect.Effect<number, EgressFailure> {
  return Effect.gen(function* () {
    if (!isMutation(run)) {
      emit(io, run.teamSlug, yield* readCurrent(io.fetcher, run.path, timeoutMs))
      return 0
    }

    // --set/--clear replace; --add/--remove change the list read first.
    let next: string[]
    if (run.setValue !== null) {
      next = splitDomains(run.setValue)
    } else if (run.clear) {
      next = []
    } else {
      const current = yield* readCurrent(io.fetcher, run.path, timeoutMs)
      const set = new Set(current.domains)
      if (run.addValue) for (const d of splitDomains(run.addValue)) set.add(d)
      if (run.removeValue) for (const d of splitDomains(run.removeValue)) set.delete(d)
      next = [...set]
    }

    const label = 'egress-allowlist update failed'
    const reply = yield* request(io.fetcher, run.path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domains: next }),
    }, label, timeoutMs, progress)
    if (!reply.ok) {
      // A refusal (4xx) saved nothing; a 5xx after the PUT may have.
      return yield* Effect.fail(new EgressFailure(`${label} (${reply.status}): ${replyMessage(reply)}`, reply.status >= 500))
    }
    const data = yield* parseReply(reply)
    const stored = Array.isArray(data.extraDomains) ? stringArray(data.extraDomains) : next
    const invalid = stringArray(data.invalidDomains)
    // Grandfathered retention: a successful PUT may still STORE legacy
    // invalid entries the admin retained — the server flags them and we show
    // it. Round 5 (P2): a >100-entry legacy row can only shrink one entry per
    // PUT (the write RPC's GREATEST(100, stored-1) bound), so the returned
    // set can still be OVER the cap. Re-derive the cap annotations from the
    // returned set — same positional logic GET uses — instead of assuming
    // the RPC left it at/under 100.
    emit(io, run.teamSlug, { domains: stored, invalid, capped: deriveCapped(stored, invalid) })
    return 0
  })
}

/**
 * Runs one `orizu team egress-allowlist` command to its exit code. Ctrl-C or
 * SIGTERM ends the wait with 130 or 143; once the PUT was sent the person is
 * told the update may be saved.
 */
export async function runEgressAllowlist(run: EgressAllowlistRun, io: EgressAllowlistCommandIo): Promise<number> {
  const printErr = io.printErr ?? io.print
  const controller = new AbortController()
  const progress: Progress = { putSent: false }
  let interrupted: 130 | 143 | undefined
  const interrupt = () => { interrupted ??= 130; controller.abort() }
  const terminate = () => { interrupted ??= 143; controller.abort() }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  try {
    const exit = await Effect.runPromiseExit(egressAllowlist(run, io, datasetTransferTimeoutMs(), progress), { signal: controller.signal })
    if (Exit.isSuccess(exit)) return exit.value
    if (interrupted !== undefined) {
      const message = isMutation(run) ? 'Egress allowlist update interrupted.' : 'Egress allowlist read interrupted.'
      printErr(progress.putSent ? `${message}\n${MAY_BE}` : message)
      return interrupted
    }
    // Anything else that went wrong prints its message with exit 1, as before.
    const failure = Cause.squash(exit.cause)
    if (!(failure instanceof EgressFailure)) {
      printErr(failure instanceof Error ? failure.message : String(failure))
      return 1
    }
    printErr(failure.mayBeSaved ? `${failure.message}\n${MAY_BE}` : failure.message)
    return 1
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', terminate)
  }
}
