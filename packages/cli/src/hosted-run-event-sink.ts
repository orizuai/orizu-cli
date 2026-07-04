/**
 * RunEventSink — the RunAPI event bridge (ALI-926 / P3.4, interface 2 of
 * ADR-005's swappability contract; the full realization of audit §4b).
 *
 * This is the transport half that `bridge.py`'s WebSocket client is NOT: it maps
 * normalized `HarnessEvent`s onto Orizu's append-only, client-sequenced
 * `workbench_run_events` and terminal PATCH. It extends the seed
 * `createBootstrapRunEventSink` (`hosted-bootstrap.ts`) into the complete bridge:
 * kind-to-event-type mapping, token coalescing, monotonic client-sequenced
 * allocation (gaps tolerated on an ambiguous append failure, but NEVER a content
 * swap at a committed sequence — see the P2-4 burn rule in `postEvent`),
 * critical-event delivery guarantees, terminal-via-PATCH, reconnect/resume, and
 * the "Orizu records win" disagreement rule. A retried POST is an idempotent 200
 * ONLY for a content-identical replay (same eventId, same sequence, same
 * payload); a burned sequence after an ambiguous error leaves a server-visible
 * gap, which is acceptable.
 *
 * ── Disagreement rule (Orizu records win) ────────────────────────────────────
 * Orizu's RunAPI is the source of truth; the OpenCode-side session state is a
 * cache/UX layer. If the harness reports state that CONTRADICTS a terminal Orizu
 * run status — e.g. it keeps streaming parts after the run was finished — the
 * sink REFUSES to append: once `finish()` succeeds the sink is SEALED, and any
 * later `append()` throws `RunTerminalError` locally rather than POSTing. The
 * sink never un-terminates a run and never invents a new one. A run-gone/terminal
 * signal from the server (append 404/410, or a persistent terminal-status 409 on
 * the finish PATCH) is likewise accepted as truth, sealing the sink. Note the
 * narrow classifications: a 403 is NOT "terminal" — it is a `RunAuthError`
 * (revoked bearer or lost access) that does not seal, and a 409 whose run is
 * still running does NOT report success. The harness is a subordinate producer;
 * the server record wins every disagreement.
 *
 * ── Artifact-ref decision (transcript/summary) ───────────────────────────────
 * The audit points at `lib/primitive-artifact-writer.server.ts`, but that is
 * server-only Supabase/object-store code the sandbox cannot import, and the
 * CLI's existing artifact write paths (`orizu runners/prompts/... push`) are all
 * PROJECT-scoped versioned-primitive uploads — there is NO run-scoped artifact
 * write path today. Per ADR-003 (do not invent a new storage convention), a
 * transcript is recorded as a BOUNDED-TAIL run event (`agent_transcript`,
 * `TRANSCRIPT_TAIL_MAX_CHARS`) appended BEFORE the terminal PATCH (a post-terminal
 * append would be refused by the seal). TODO(P3.6/ALI-928): when a run-scoped
 * artifact-ref CLI path lands, swap the tail event for a real object ref.
 */

import type { HarnessEvent, HarnessEventKind } from './hosted-harness.js'
import { isHarnessTerminalKind } from './hosted-harness.js'
import { redactSecrets } from './secret-redaction.js'

export type HostedFetch = (url: string, init?: RequestInit) => Promise<Response>

// -- Egress-audit vocabulary (G5 / ALI-1006) ---------------------------------
// The startup egress CANARY (in-sandbox loop, `hosted-loop.ts`) emits ONE of
// these right after bootstrap: `egress_blocked` when a known non-allowlisted
// host is correctly denied (the firewall is live → proof), or `egress_allowed`
// when it is UNEXPECTEDLY reachable (the policy did NOT take → the loop then
// fails the run closed). Emitted through the loop's single sink (single-writer
// invariant preserved — no host-side second writer). See
// docs/.../sandbox-egress-policy.md and t1-t7-adversarial-results.md (T1).
export const EGRESS_ALLOWED_EVENT_TYPE = 'egress_allowed'
export const EGRESS_BLOCKED_EVENT_TYPE = 'egress_blocked'

// -- Mapping table (audit §4b, in-scope rows) --------------------------------
// Kinds NOT present here are handled out-of-band:
//   execution_complete / error → terminal PATCH (never a raw event);
//   push_complete / push_error → deferred to P3.5;
//   heartbeat / user_message   → never emitted by the harness (dropped at source).
const EVENT_TYPE_BY_KIND: Partial<Record<HarnessEventKind, string>> = {
  ready: 'agent_ready',
  token: 'agent_token',
  tool_call: 'agent_tool_call',
  tool_result: 'agent_tool_result',
  step_start: 'agent_step_start',
  step_finish: 'agent_step_finish',
  git_sync: 'repo_sync',
  artifact: 'artifact',
  session_title: 'session_title',
  // Egress-canary proof events (G5 / ALI-1006) — emitted by the in-sandbox loop
  // through this SAME sink (single writer). See EGRESS_*_EVENT_TYPE below.
  egress_blocked: EGRESS_BLOCKED_EVENT_TYPE,
  egress_allowed: EGRESS_ALLOWED_EVENT_TYPE,
}

/** The RunAPI event type a harness kind maps to, or null if it is not appendable
 *  (terminal kinds route through the PATCH; deferred kinds have no mapping yet). */
export function eventTypeForKind(kind: HarnessEventKind): string | null {
  return EVENT_TYPE_BY_KIND[kind] ?? null
}

export const AGENT_TOKEN_EVENT_TYPE = 'agent_token'
export const AGENT_TRANSCRIPT_EVENT_TYPE = 'agent_transcript'
/** Bounded tail size for the transcript stopgap (see artifact-ref decision). */
export const TRANSCRIPT_TAIL_MAX_CHARS = 16_384

// -- Reserved credential-use audit vocabulary (G6 / ALI-1007, NOT emitted) ----
// The DURABLE credential-use audit is the per-mint DB row (agent_session_tokens
// for agent-token mints; repo_token_mints for repo tokens): each rotation writes
// a fresh row with created_at/expires_at/revoked_at, which IS the credential-use
// trail. These event-type constants RESERVE the run-timeline vocabulary but are
// NOT emitted today: a run's event/sequence space has a SINGLE writer (the
// in-sandbox loop — see app/api/cli/workbench-runs/[id]/events/route.ts), and a
// host-side append here would race that writer (409 → a healthy run killed). A
// FUTURE emitter must run in-sandbox (single-writer) or be out-of-band
// coordinated before these are wired to the stream.
export const CREDENTIAL_ROTATED_EVENT_TYPE = 'credential_rotated'
export const CREDENTIAL_MINT_FAILED_EVENT_TYPE = 'credential_mint_failed'

export type TerminalStatus = 'succeeded' | 'failed' | 'cancelled'

export interface FinishOptions {
  summary?: Record<string, unknown>
  evidence?: Record<string, unknown>
  /** Full agent transcript; stored as a bounded-tail `agent_transcript` event
   *  BEFORE the terminal PATCH (see the artifact-ref decision docblock). */
  transcript?: string
}

export interface RunEventSink {
  /** Map + coalesce + POST a harness event. Owns per-run monotonic sequence.
   *  Terminal kinds are rejected (they must go through `finish`). */
  append(event: HarnessEvent): Promise<void>
  /** Force-flush any coalesced token snapshots (also runs on every structural
   *  event and on `finish`). Exposed so callers can flush on a timer if desired. */
  flushTokens(): Promise<void>
  /** Terminal transition via PATCH; records the transcript tail first, then CAS. */
  finish(status: TerminalStatus, opts?: FinishOptions): Promise<void>
  /** True once a terminal transition has landed and the sink is sealed. */
  readonly sealed: boolean
  /** The next sequence the sink will attempt to allocate (test/resume aid). */
  readonly nextSequence: number
  /** Events the sink has confirmed appended, in order (redacted payloads). */
  readonly recorded: readonly AppendedRunEvent[]
}

export interface AppendedRunEvent {
  eventId: string
  sequence: number
  eventType: string
  payload: Record<string, unknown>
}

/** Raised when an append is attempted against a run the sink knows is terminal. */
export class RunTerminalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RunTerminalError'
  }
}

/** Raised when a critical event (or the terminal PATCH) is undeliverable after
 *  the bounded retry budget — the caller MUST treat the run as compromised. */
export class CriticalDeliveryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CriticalDeliveryError'
  }
}

/**
 * Raised on a 403 from the RunAPI. Named for what a 403 actually is — NOT "the
 * run is terminal" (that is 404/410). A 403 means the caller may no longer write
 * this run: the session bearer was revoked, OR the agent lost access to the run
 * (e.g. its session was reassigned). The write definitely did not land, so the
 * sink does NOT seal and does NOT burn the sequence; the caller decides whether
 * to re-authenticate or abandon the run.
 */
export class RunAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RunAuthError'
  }
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['succeeded', 'failed', 'cancelled'])

function isTerminalStatus(status: string | null): boolean {
  return status !== null && TERMINAL_STATUSES.has(status)
}

export interface CreateRunEventSinkOptions {
  apiBaseUrl: string
  runId: string
  /**
   * The Orizu bearer, EITHER a fixed string OR a provider resolved per request.
   * A provider (e.g. one that reads the rotated 0600 bearer file) lets the sink
   * pick up a host-side token rotation without being rebuilt: every request
   * resolves the current value, and on a 401/403 the sink re-resolves ONCE and
   * retries before classifying the failure (fresh token after rotation).
   */
  bearer: string | (() => string)
  fetchImpl?: HostedFetch
  /**
   * Verbatim secrets to strip from every payload before it leaves the sandbox.
   *
   * THIS IS THE REDACTION GUARANTEE. Exact-match on these values is the control
   * we rely on — ANY secret that is present in the sandbox (the run bearer is
   * added automatically; also pass every minted repo token, model-provider API
   * key, and any credential a customer setup step injects) MUST appear in this
   * list. Whatever is here is scrubbed wherever it appears, even mid-string and
   * regardless of its shape. The token-shape patterns in `secret-redaction.ts`
   * are only defense-in-depth for credentials no one declared; never treat a
   * shape match as the primary safeguard.
   */
  redactSecretsList?: readonly string[]
  now?: () => number
  /** First sequence to allocate (resume sets this to server cursor + 1). */
  startSequence?: number
  /** eventId namespace; deterministic ids `<prefix>:<sequence>` make a replayed
   *  event an idempotent 200 (never a 409 same-sequence-different-eventId). */
  eventIdPrefix?: string
  /** Bounded retry budget for critical deliveries (append critical + finish). */
  maxCriticalAttempts?: number
  /** Injectable backoff sleep (tests pass a no-op to avoid real delays). */
  sleepImpl?: (ms: number) => Promise<void>
  /** Local diagnostic sink for disagreement-rule logs (never throws). */
  onDiagnostic?: (message: string) => void
}

const DEFAULT_MAX_CRITICAL_ATTEMPTS = 4

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function tail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max)
}

export function createRunEventSink(options: CreateRunEventSinkOptions): RunEventSink {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as HostedFetch)
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleepImpl ?? defaultSleep
  const base = options.apiBaseUrl.replace(/\/$/, '')
  const eventIdPrefix = options.eventIdPrefix ?? options.runId
  const bearerOption = options.bearer
  const bearerIsRotatable = typeof bearerOption === 'function'
  const resolveBearer = bearerIsRotatable ? bearerOption : (): string => bearerOption
  const extraSecrets = options.redactSecretsList ?? []
  // Resolve the CURRENT bearer for every redaction pass so a rotated token is
  // scrubbed too (the fixed-string case still resolves the same value).
  const currentSecrets = (): string[] => [resolveBearer(), ...extraSecrets]
  const maxCriticalAttempts = options.maxCriticalAttempts ?? DEFAULT_MAX_CRITICAL_ATTEMPTS
  const diag = options.onDiagnostic ?? ((): void => {})

  const eventsUrl = `${base}/api/cli/workbench-runs/${encodeURIComponent(options.runId)}/events`
  const runUrl = `${base}/api/cli/workbench-runs/${encodeURIComponent(options.runId)}`
  const authHeaders = (): Record<string, string> => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${resolveBearer()}`,
  })

  // One request with a single re-auth retry: a 401/403 may just mean the bearer
  // was rotated mid-flight, so re-resolve it ONCE and retry before the caller
  // classifies the failure. Only meaningful when the bearer is a PROVIDER (a
  // rotated file yields a new value); a fixed string re-resolves identically, so
  // we skip the wasted retry and let the caller classify the first response.
  async function requestWithReauth(url: string, init: RequestInit): Promise<Response> {
    const first = await fetchImpl(url, { ...init, headers: authHeaders() })
    if (!bearerIsRotatable || (first.status !== 401 && first.status !== 403)) return first
    return fetchImpl(url, { ...init, headers: authHeaders() })
  }

  const recorded: AppendedRunEvent[] = []
  // Insertion-ordered coalescing buffer: one latest snapshot per messageId.
  // A token event carries the FULL accumulated text, so we replace (not append)
  // — N deltas collapse to one `agent_token` at the next flush boundary.
  const tokenBuffer = new Map<string, string>()

  let nextSequence = options.startSequence ?? 1
  let sealed = false

  function assertWritable(): void {
    if (sealed) {
      throw new RunTerminalError('run is terminal server-side — refusing to append (Orizu records win)')
    }
  }

  // POST one event. The sequence is allocated as a CANDIDATE and committed
  // (counter advanced, event recorded) after a 2xx. On failure the candidate is
  // handled by the "gaps tolerated, swaps NOT" rule (P2-4):
  //
  //   • AMBIGUOUS failure — a network throw, a 5xx, or a sequence-conflict 409
  //     (anything where the server MAY already hold this sequence, or where the
  //     sequence is now unusable) — BURNS the candidate: the counter advances so
  //     a later append can never reuse this sequence with DIFFERENT content. The
  //     cost is a possible server-visible gap, which is acceptable; a silent
  //     content swap at a committed sequence is not.
  //   • CLEAN failure — a 400 validation error, where the server definitely did
  //     not commit — KEEPS the candidate: the next append reuses this sequence.
  //   • 404 / 410 seal the sink (the run is gone/terminal server-side).
  //   • 403 throws RunAuthError WITHOUT sealing (bearer revoked or access lost).
  //
  // Because the eventId is derived from the candidate sequence, a retry of the
  // SAME content within the critical budget is an idempotent replay (same
  // eventId), never a same-sequence-different-eventId 409.
  async function postEvent(
    eventType: string,
    payload: Record<string, unknown>,
    critical: boolean
  ): Promise<void> {
    const sequence = nextSequence
    const eventId = `${eventIdPrefix}:${sequence}`
    const redactedPayload = redactSecrets(payload, { secrets: currentSecrets() })
    const body = JSON.stringify({
      eventId,
      sequence,
      eventType,
      occurredAt: new Date(now()).toISOString(),
      payload: redactedPayload,
    })

    const attempts = critical ? maxCriticalAttempts : 1
    let lastDetail = ''
    // Burn the candidate sequence on exit unless we prove the server did not
    // (and cannot have) committed it — i.e. a clean 4xx.
    let burnSequence = false
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let response: Response
      try {
        response = await requestWithReauth(eventsUrl, { method: 'POST', body })
      } catch (error) {
        // Network throw: the request may have reached and committed on the
        // server — ambiguous, so burn.
        lastDetail = error instanceof Error ? error.message : String(error)
        burnSequence = true
        if (critical && attempt < attempts) {
          await sleep(2 ** (attempt - 1) * 50)
          continue
        }
        break
      }
      if (response.ok) {
        nextSequence = sequence + 1
        recorded.push({ eventId, sequence, eventType, payload: redactedPayload })
        return
      }
      // Run gone/terminal server-side: seal and stop (Orizu records win).
      if (response.status === 404 || response.status === 410) {
        sealed = true
        diag(`append rejected (${response.status}) for ${eventType} — sealing sink (run terminal)`)
        throw new RunTerminalError(`append rejected (${response.status}) — run is terminal server-side`)
      }
      // Not authorized to write this run: revoked bearer OR lost access. The
      // re-auth retry above already re-resolved the bearer once (a rotation), so
      // a persistent 401/403 is a real auth failure. The write did not land;
      // surface a distinct error and do NOT seal or burn.
      if (response.status === 401 || response.status === 403) {
        diag(`append rejected (${response.status}) for ${eventType} — bearer revoked or run access lost`)
        throw new RunAuthError(
          `append rejected (${response.status}) for ${eventType} — bearer revoked or run access lost`
        )
      }
      lastDetail = `status ${response.status}`
      // 5xx (server may have committed) or 409 (sequence taken/unusable): burn.
      if (response.status >= 500 || response.status === 409) {
        burnSequence = true
        if (critical && response.status >= 500 && attempt < attempts) {
          await sleep(2 ** (attempt - 1) * 50)
          continue
        }
        break
      }
      // Clean 4xx (e.g. 400 validation): server did not commit — keep the
      // sequence for the next append.
      break
    }
    if (burnSequence) nextSequence = sequence + 1
    if (critical) {
      throw new CriticalDeliveryError(
        `critical event ${eventType} undeliverable after ${attempts} attempts (${lastDetail})`
      )
    }
    throw new Error(`run-event append failed (${lastDetail}) for ${eventType}`)
  }

  async function flushTokens(): Promise<void> {
    if (tokenBuffer.size === 0) return
    const pending = [...tokenBuffer.entries()]
    tokenBuffer.clear()
    for (const [messageId, text] of pending) {
      await postEvent(AGENT_TOKEN_EVENT_TYPE, { messageId, text }, false)
    }
  }

  async function append(event: HarnessEvent): Promise<void> {
    assertWritable()
    if (isHarnessTerminalKind(event.kind)) {
      throw new Error(`${event.kind} is terminal — route it through finish(), not append()`)
    }
    if (event.kind === 'token') {
      const messageId = event.messageId ?? '_'
      const text = typeof event.payload.text === 'string' ? event.payload.text : ''
      tokenBuffer.set(messageId, text)
      return
    }
    const eventType = eventTypeForKind(event.kind)
    if (!eventType) {
      // Deferred kinds (push_*) have no mapping in this slice — drop explicitly.
      diag(`no event-type mapping for kind ${event.kind} — dropped (deferred)`)
      return
    }
    // Any structural (non-token) event is a coalescing boundary.
    await flushTokens()
    await postEvent(eventType, event.payload, event.critical === true)
  }

  // GET the run's server-side status (run detail route). Best-effort: returns
  // null on any transport/parse failure or non-2xx so the caller can decide.
  async function fetchRunStatus(): Promise<string | null> {
    try {
      const res = await requestWithReauth(runUrl, { method: 'GET' })
      if (!res.ok) return null
      const data = (await res.json()) as { run?: { status?: unknown } }
      const status = data.run?.status
      return typeof status === 'string' ? status : null
    } catch {
      return null
    }
  }

  // PATCH the terminal transition. The route ingests the terminal event BEFORE
  // the status CAS and retries once internally on a sequence conflict; we add a
  // bounded critical-retry on transient transport/5xx failures and honor the
  // route's already-terminal semantics (Orizu records win).
  async function patchTerminal(status: TerminalStatus, opts?: FinishOptions): Promise<void> {
    const eventId = `${eventIdPrefix}:terminal:${status}`
    const patchBody: Record<string, unknown> = { status, eventId }
    if (opts?.summary) patchBody.summary = redactSecrets(opts.summary, { secrets: currentSecrets() })
    if (opts?.evidence) patchBody.evidence = redactSecrets(opts.evidence, { secrets: currentSecrets() })
    const body = JSON.stringify(patchBody)

    let sequenceRetried = false
    let lastDetail = ''
    for (let attempt = 1; attempt <= maxCriticalAttempts; attempt += 1) {
      let response: Response
      try {
        response = await requestWithReauth(runUrl, { method: 'PATCH', body })
      } catch (error) {
        lastDetail = error instanceof Error ? error.message : String(error)
        if (attempt < maxCriticalAttempts) {
          await sleep(2 ** (attempt - 1) * 50)
          continue
        }
        break
      }
      if (response.ok) {
        sealed = true
        return
      }
      if (response.status === 409) {
        // A 409 is either a sequence conflict (the route retries its own ingest;
        // one more attempt here may clear it) or an already-terminal run (a
        // concurrent finisher won). Retry once; if it STILL 409s, do not guess —
        // ask the server what the run's status actually is. Only a terminal
        // status lets us seal (Orizu records win); a run still running/pending
        // means our transition did not happen and we must NOT report success.
        if (!sequenceRetried) {
          sequenceRetried = true
          continue
        }
        const serverStatus = await fetchRunStatus()
        if (isTerminalStatus(serverStatus)) {
          sealed = true
          diag(`terminal PATCH 409 — server run already ${serverStatus} (Orizu records win)`)
          return
        }
        lastDetail = `409 conflict, server status ${serverStatus ?? 'unknown'}`
        break
      }
      lastDetail = `status ${response.status}`
      if (response.status >= 500 && attempt < maxCriticalAttempts) {
        await sleep(2 ** (attempt - 1) * 50)
        continue
      }
      break
    }
    throw new CriticalDeliveryError(`terminal PATCH (${status}) undeliverable (${lastDetail})`)
  }

  async function finish(status: TerminalStatus, opts?: FinishOptions): Promise<void> {
    if (sealed) {
      diag(`finish(${status}) called on an already-sealed sink — ignored (idempotent)`)
      return
    }
    // Pre-terminal appends (still writable): flush coalesced tokens, then the
    // bounded transcript tail (the seal below refuses any later append).
    await flushTokens()
    if (opts?.transcript) {
      await postEvent(
        AGENT_TRANSCRIPT_EVENT_TYPE,
        { text: tail(opts.transcript, TRANSCRIPT_TAIL_MAX_CHARS), truncated: opts.transcript.length > TRANSCRIPT_TAIL_MAX_CHARS },
        true
      )
    }
    await patchTerminal(status, opts)
  }

  return {
    append,
    flushTokens,
    finish,
    get sealed() {
      return sealed
    },
    get nextSequence() {
      return nextSequence
    },
    recorded,
  }
}

// -- Reconnect / resume ------------------------------------------------------

export interface ResumeRunEventSinkOptions extends Omit<CreateRunEventSinkOptions, 'startSequence'> {
  /** Page size for the cursor tail while discovering the latest sequence. */
  pageSize?: number
}

/**
 * Rebuild a sink after a restart WITHOUT losing run continuity (acceptance:
 * "reconnect/resume without losing run continuity"). Walks the events GET
 * cursor tail to the end to learn the server's latest sequence, then returns a
 * fresh sink whose first allocation is `latest + 1`.
 *
 * ── QUIESCE PRECONDITION (single-writer handoff) ─────────────────────────────
 * This is safe ONLY when the predecessor sink has FULLY STOPPED before resume
 * runs — the RunAPI is single-writer-per-run (see the events route), and resume
 * assumes it is the sole writer while it reads the tail and picks the next
 * sequence. It does NOT coordinate with a live predecessor. If a still-in-flight
 * commit from a not-yet-dead sink lands AFTER we read the cursor, that sink and
 * this one can both target the same next sequence. We do not claim "no
 * collision": deterministic eventIds (`<runId>:<sequence>`) make an identical
 * replay an idempotent 200, but two DIFFERENT payloads racing one sequence is a
 * real conflict — bounded, not eliminated, by the P2-4 burn rule (the loser
 * burns its candidate and advances rather than swapping committed content).
 * Callers MUST ensure the predecessor is quiesced; treat overlap as a bug.
 *
 * ── STUCK-RUNNING RECOVERY (out of scope here) ───────────────────────────────
 * If a sink crashes BETWEEN its last append and finish(), the run is left with
 * status='running' server-side and no terminal event — resume can continue
 * appending, but nothing in THIS module will time out and finalize an abandoned
 * run whose writer never came back. A server-side watchdog owns that recovery
 * (G6 / ALI-1007); it is deliberately not implemented in the sandbox client.
 */
export async function resumeRunEventSink(
  options: ResumeRunEventSinkOptions
): Promise<RunEventSink> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as HostedFetch)
  const base = options.apiBaseUrl.replace(/\/$/, '')
  const pageSize = options.pageSize ?? 500
  const bearerOption = options.bearer
  const resolveBearer = typeof bearerOption === 'function' ? bearerOption : (): string => bearerOption

  let cursor = 0
  for (;;) {
    const url = `${base}/api/cli/workbench-runs/${encodeURIComponent(options.runId)}/events?after=${cursor}&limit=${pageSize}`
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${resolveBearer()}` },
    })
    if (!response.ok) {
      throw new Error(`resume cursor read failed (${response.status})`)
    }
    const data = (await response.json()) as { cursor?: number; events?: unknown[] }
    const nextCursor = typeof data.cursor === 'number' ? data.cursor : cursor
    const count = Array.isArray(data.events) ? data.events.length : 0
    cursor = nextCursor
    if (count < pageSize) break
  }

  return createRunEventSink({ ...options, startSequence: cursor + 1 })
}

// -- Bridge glue: drive a harness stream into a sink -------------------------

export interface DrainOptions {
  /** Transcript captured by the caller, stored on the terminal transition. */
  transcript?: string
  summary?: Record<string, unknown>
  evidence?: Record<string, unknown>
}

/**
 * Consume a harness `runPrompt` stream into a sink: structural events are
 * appended (with token coalescing), and the single terminal event
 * (`execution_complete` / `error`) is routed to `finish()` — NEVER appended.
 * This is the event bridge's happy-path driver; the terminal event decides the
 * run's final status.
 */
export async function drainHarnessToSink(
  events: AsyncIterable<HarnessEvent>,
  sink: RunEventSink,
  opts: DrainOptions = {}
): Promise<TerminalStatus> {
  for await (const event of events) {
    if (event.kind === 'execution_complete') {
      // A prompt the caller/agent stopped is a cancellation, not a failure: the
      // driver flags it with `aborted: true` (P2-2) for both the signal-abort
      // and stop()-initiated paths. A genuine failure (success:false, no abort
      // flag) still lands 'failed'.
      if (event.payload.aborted === true) {
        await sink.finish('cancelled', {
          summary: opts.summary,
          evidence: opts.evidence,
          transcript: opts.transcript,
        })
        return 'cancelled'
      }
      const success = event.payload.success !== false
      const status: TerminalStatus = success ? 'succeeded' : 'failed'
      const summary = success
        ? opts.summary
        : { ...(opts.summary ?? {}), error: event.payload.error ?? 'execution failed' }
      await sink.finish(status, { summary, evidence: opts.evidence, transcript: opts.transcript })
      return status
    }
    if (event.kind === 'error') {
      await sink.finish('failed', {
        summary: { ...(opts.summary ?? {}), error: event.payload.error ?? 'agent error' },
        evidence: opts.evidence,
        transcript: opts.transcript,
      })
      return 'failed'
    }
    await sink.append(event)
  }
  // The harness contract guarantees a terminal event; reaching here means the
  // stream ended abnormally. Fail closed so the run never dangles non-terminal.
  await sink.finish('failed', {
    summary: { ...(opts.summary ?? {}), error: 'harness stream ended without a terminal event' },
    transcript: opts.transcript,
  })
  return 'failed'
}
