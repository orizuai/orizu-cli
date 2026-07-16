/**
 * OpenCode driver for the AgentHarness seam (ALI-926 / P3.4, per ADR-005 §4a).
 *
 * The `opencode` implementation of `AgentHarness`. Drives a long-running
 * `opencode serve` process over localhost HTTP/SSE, exactly as OpenInspect's
 * `bridge.py` does — this module is a DESIGN port of `bridge.py`'s
 * `_stream_opencode_response_sse` + `_transform_part_to_event` into idiomatic
 * TypeScript. The WebSocket half of `bridge.py` is NOT ported: the transport is
 * the RunAPI event bridge (`hosted-run-event-sink.ts`), not a Durable Object.
 *
 * DRIVING PROTOCOL (all localhost):
 *   - POST /session                          → create an OpenCode session
 *   - GET  /session/{id}                     → validate a resumed session
 *   - GET  /event                            → SSE stream of message parts
 *   - POST /session/{id}/prompt_async        → enqueue a prompt (non-blocking)
 *   - GET  /session/{id}/message             → final-state reconciliation
 *   - POST /session/{id}/abort               → stop the in-flight prompt
 *
 * The stream is opened BEFORE the prompt is POSTed (mirrors bridge.py) so no
 * early parts are missed. Termination is driven by `session.idle` /
 * `session.status{idle}` (→ `execution_complete`) or `session.error` (→
 * `error`). Sub-task / child-session fan-out is intentionally NOT ported —
 * ADR-005 keeps the RunAPI single-writer-per-run, so `spawn-task` is out of P3.
 *
 * TESTABILITY: the driver takes a `baseUrl` (localhost:port) and an injectable
 * `fetchImpl`, so it runs against a fake in-process OpenCode SSE server with no
 * real `opencode` binary. `spawnOpenCode` (below) is the P3.5 in-sandbox launch
 * helper; the driver itself never spawns a process.
 *
 * ── Deliberate deltas from bridge.py (kept in ONE place) ─────────────────────
 * This driver is a faithful port EXCEPT for these consciously-chosen
 * differences — read them before diffing behavior against `bridge.py`:
 *   • Sub-task / child-session fan-out is OUT OF SCOPE. bridge.py tracks
 *     `tracked_child_session_ids`, authorizes child assistant messages, and
 *     emits `isSubtask` events; ADR-005 keeps the RunAPI single-writer-per-run,
 *     so `task`-tool child sessions are neither tracked nor forwarded here.
 *   • Compaction IS NOW PORTED (P2-1). `session.compacted` sets a
 *     `compactionOccurred` flag; thereafter assistant messages whose parentID
 *     no longer matches the user message are accepted (except the compaction
 *     summary itself), in both the live stream and `fetchFinalState` — mirrors
 *     bridge.py lines ~1300-1307 / 1153-1160 / 1421-1425.
 *   • Max prompt duration IS NOW PORTED (P3-1). `PROMPT_MAX_DURATION`
 *     (default 5400s, injectable) runs ALONGSIDE the SSE inactivity deadline;
 *     on breach the prompt is aborted and a terminal `error` is emitted.
 *   • SSE framing assumes LF `\n\n` event separators and `data:` lines, exactly
 *     as OpenCode 1.14.41 emits them (bridge.py `_parse_sse_stream` makes the
 *     same assumption — it splits on `"\n\n"`, never CRLF). This is pinned to
 *     `OPENCODE_PINNED_VERSION`; a bump that switches OpenCode to CRLF framing
 *     would break both ports and must be re-verified.
 */

import { readFileSync } from 'fs'

import type {
  AgentHarness,
  HarnessEvent,
  HarnessPrompt,
  HarnessStartOptions,
} from './hosted-harness.js'

// OpenCode is HARD-PINNED to this version everywhere it is installed/launched.
// AUDIT RISK #1 (SSE fragility): the entire event model rides OpenCode's
// undocumented `/event` SSE part schema (`message.part.updated`, `session.idle`,
// `session.error`, `session.updated`, ...). Versions newer than 1.14.41 broke
// that stream upstream, so the pin is load-bearing and must be re-verified
// before any bump. The AgentHarness seam is the mitigation of last resort: swap
// to a Claude-Agent-SDK loop (ALI-929) rather than chase OpenCode's SSE.
export const OPENCODE_PINNED_VERSION = '1.14.41'

const DEFAULT_OPENCODE_PORT = 4096
const DEFAULT_SSE_INACTIVITY_MS = 120_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
// Wall-clock ceiling on a single prompt (port of bridge.py PROMPT_MAX_DURATION,
// 5400s). Runs alongside the inactivity deadline: inactivity catches a stalled
// stream, this catches a stream that stays busy forever. Exported so the hosted
// loop can use it as the FLOOR when deriving a duration-aware cap (ALI-1061):
// the cap is never shortened below this default for short/undated runs.
export const DEFAULT_PROMPT_MAX_DURATION_MS = 5_400_000

// Placeholder titles OpenCode auto-assigns ("New session - <ISO8601>Z" /
// "Child session - <ISO8601>Z"); noise, never forwarded (port of bridge.py
// OPENCODE_DEFAULT_TITLE_RE).
const OPENCODE_DEFAULT_TITLE_RE =
  /^(new session|child session) - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/i

export type HarnessFetch = (url: string, init?: RequestInit) => Promise<Response>

export interface OpenCodeHarnessOptions {
  /** Base URL of the local `opencode serve`, e.g. "http://localhost:4096". */
  baseUrl: string
  fetchImpl?: HarnessFetch
  /** Inactivity ceiling on the SSE stream (ms); reset on every chunk. */
  sseInactivityMs?: number
  /** Timeout for the discrete (non-streaming) OpenCode requests (ms). */
  requestTimeoutMs?: number
  /** Wall-clock ceiling on a single prompt (ms); breach aborts + errors out. */
  promptMaxDurationMs?: number
  now?: () => number
}

/** Distinct terminal reason emitted when a prompt breaches PROMPT_MAX_DURATION,
 *  so the bridge/tests can tell a duration abort from a model error. */
export const PROMPT_MAX_DURATION_ERROR = 'prompt exceeded max duration'

class SseInactivityError extends Error {
  constructor(ms: number) {
    super(`OpenCode SSE stream inactive for ${ms}ms (no data received)`)
    this.name = 'SseInactivityError'
  }
}

class PromptAbortedError extends Error {
  constructor() {
    super('prompt aborted')
    this.name = 'PromptAbortedError'
  }
}

// -- OpenCode ascending id generator (port of OpenCode's id.ts) --------------
// Monotonic so our user-message id always sorts AFTER any prior assistant
// message id — this is what prevents OpenCode's prompt loop from early-exiting
// on `lastUser.id < lastAssistant.id`.
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
let idLastTimestamp = 0
let idCounter = 0

function randomBase62(length: number): string {
  let out = ''
  for (let i = 0; i < length; i += 1) {
    out += BASE62[Math.floor(Math.random() * 62)]
  }
  return out
}

function ascendingId(prefix: 'ses' | 'msg' | 'prt'): string {
  const nowMs = Date.now()
  if (nowMs !== idLastTimestamp) {
    idLastTimestamp = nowMs
    idCounter = 0
  }
  idCounter += 1
  const encoded = (nowMs * 0x1000 + idCounter) & 0xffffffffffff
  const hex = encoded.toString(16).padStart(12, '0')
  return `${prefix}_${hex}${randomBase62(14)}`
}

// -- Anthropic / OpenAI reasoning-effort mapping (port of bridge.py) ---------
const ANTHROPIC_THINKING_BUDGETS: Record<string, number> = { high: 16_000, max: 31_999 }
const ANTHROPIC_ADAPTIVE_THINKING_MODELS = new Set([
  'claude-fable-5',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-sonnet-4-6',
])
const ANTHROPIC_ADAPTIVE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

/**
 * Split a possibly provider-qualified model string into provider + model id.
 * SINGLE-SLASH ids ("anthropic/claude-opus-4-8") are the assumed form; a bare
 * id defaults to provider "anthropic". This is THE shared parse — consumed by
 * BOTH the prompt path (`buildPromptRequestBody`) and the pre-prompt
 * validation (`awaitOpenCodeModelResolvable`), so the two can never drift:
 * parity is exactly what makes the validation meaningful (ALI-1086).
 * KNOWN LIMIT: `split('/', 2)` drops everything after the second slash, so a
 * 3-part id ("openrouter/anthropic/claude-x") misparses to provider
 * "openrouter" + model "anthropic" — identically in both places (today's
 * pre-existing prompt-path behavior, now shared rather than duplicated).
 */
export function qualifyHostedModel(model: string): { providerId: string; modelId: string } {
  const [providerId, modelId] = model.includes('/') ? model.split('/', 2) : ['anthropic', model]
  return { providerId, modelId }
}

export function buildPromptRequestBody(
  content: string,
  model: string | undefined,
  opencodeMessageId: string,
  reasoningEffort: string | undefined
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    parts: [{ type: 'text', text: content }],
    messageID: opencodeMessageId,
  }
  if (!model) return body

  // Shared parse (see qualifyHostedModel): keeps the prompt path and the
  // ALI-1086 pre-prompt validation in lockstep by construction.
  const { providerId, modelId } = qualifyHostedModel(model)
  const modelSpec: Record<string, unknown> = { providerID: providerId, modelID: modelId }

  if (reasoningEffort) {
    if (providerId === 'anthropic') {
      if (ANTHROPIC_ADAPTIVE_THINKING_MODELS.has(modelId)) {
        const options: Record<string, unknown> = { thinking: { type: 'adaptive' } }
        if (ANTHROPIC_ADAPTIVE_EFFORTS.has(reasoningEffort)) {
          options.outputConfig = { effort: reasoningEffort }
        }
        modelSpec.options = options
      } else {
        const budget = ANTHROPIC_THINKING_BUDGETS[reasoningEffort]
        if (budget !== undefined) {
          modelSpec.options = { thinking: { type: 'enabled', budgetTokens: budget } }
        }
      }
    } else if (providerId === 'openai') {
      modelSpec.options = { reasoningEffort, reasoningSummary: 'auto' }
    }
  }
  body.model = modelSpec
  return body
}

// -- OpenCode part → HarnessEvent transform (port of _transform_part_to_event) -

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function extractErrorMessage(error: unknown): string {
  const rec = asRecord(error)
  const data = asRecord(rec.data)
  if (typeof data.message === 'string') return data.message
  if (typeof rec.message === 'string') return rec.message
  if (typeof rec.name === 'string') return rec.name
  return typeof error === 'string' && error ? error : 'Unknown error'
}

// -- SSE parsing over a fetch ReadableStream ---------------------------------

async function readWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  inactivityMs: number
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new PromptAbortedError())
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new SseInactivityError(inactivityMs))
    }, inactivityMs)
    const onAbort = (): void => {
      cleanup()
      reject(new PromptAbortedError())
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    reader.read().then(
      result => {
        cleanup()
        resolve(result)
      },
      error => {
        cleanup()
        reject(error)
      }
    )
  })
}

async function* parseSseEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  inactivityMs: number
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await readWithDeadline(reader, signal, inactivityMs)
      if (done) break
      if (value) buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const dataLines: string[] = []
        for (const line of rawEvent.split('\n')) {
          if (line.startsWith('data:')) {
            const trimmed = line.slice(5).replace(/^ /, '')
            if (trimmed) dataLines.push(trimmed)
          }
        }
        if (dataLines.length > 0) {
          try {
            yield asRecord(JSON.parse(dataLines.join('\n')))
          } catch {
            // Malformed SSE payload — skip rather than crash the stream.
          }
        }
        boundary = buffer.indexOf('\n\n')
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // reader already released
    }
    try {
      await body.cancel()
    } catch {
      // stream already closed
    }
  }
}

// -- The driver --------------------------------------------------------------

export function createOpenCodeHarness(options: OpenCodeHarnessOptions): AgentHarness {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as HarnessFetch)
  const base = options.baseUrl.replace(/\/$/, '')
  const inactivityMs = options.sseInactivityMs ?? DEFAULT_SSE_INACTIVITY_MS
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const promptMaxDurationMs = options.promptMaxDurationMs ?? DEFAULT_PROMPT_MAX_DURATION_MS
  const now = options.now ?? ((): number => Date.now())

  let opencodeSessionId: string | null = null
  let startModel: string | undefined
  let startReasoningEffort: string | undefined
  let readyEmitted = false
  // Set true by the public stop(); makes the next idle terminal resolve as a
  // cancellation rather than a success (P2-2).
  let stopRequested = false
  // Last title actually forwarded, deduped across the whole harness lifetime so
  // a repeated identical title is emitted once (P3-6).
  let lastForwardedTitle: string | null = null

  /** Drop placeholder/default titles and de-dupe against the last one forwarded;
   *  returns the title to emit, or null to suppress (port of bridge.py
   *  _normalize_forwardable_session_title + _session_title_event_once). */
  function forwardableTitle(rawTitle: unknown): string | null {
    if (typeof rawTitle !== 'string') return null
    const trimmed = rawTitle.trim()
    if (!trimmed || OPENCODE_DEFAULT_TITLE_RE.test(trimmed)) return null
    if (trimmed === lastForwardedTitle) return null
    lastForwardedTitle = trimmed
    return trimmed
  }

  async function timedFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs)
    try {
      return await fetchImpl(url, { ...init, signal: init.signal ?? controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  async function createSession(): Promise<string> {
    const res = await timedFetch(`${base}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    if (!res.ok) throw new Error(`OpenCode session create failed (${res.status})`)
    const data = asRecord(await res.json())
    const id = typeof data.id === 'string' ? data.id : null
    if (!id) throw new Error('OpenCode session create returned no id')
    return id
  }

  async function validateSession(id: string): Promise<boolean> {
    try {
      const res = await timedFetch(`${base}/session/${encodeURIComponent(id)}`)
      return res.ok
    } catch {
      return false
    }
  }

  async function requestStop(): Promise<void> {
    if (!opencodeSessionId) return
    try {
      await timedFetch(`${base}/session/${encodeURIComponent(opencodeSessionId)}/abort`, {
        method: 'POST',
      })
    } catch {
      // best-effort: the stream teardown is the real cancellation
    }
  }

  async function* fetchFinalState(
    sessionId: string,
    userMessageIds: Set<string>,
    allowedAssistantMsgIds: Set<string>,
    messageText: Map<string, string>,
    compactionOccurred: boolean
  ): AsyncGenerator<HarnessEvent> {
    // After idle, re-read the message list to capture any assistant text the SSE
    // stream may have missed due to part-ordering (bridge.py does the same). Any
    // text LONGER than what we already emitted is re-emitted as a token snapshot.
    let messages: unknown
    try {
      const res = await timedFetch(`${base}/session/${encodeURIComponent(sessionId)}/message`)
      if (!res.ok) return
      messages = await res.json()
    } catch {
      return
    }
    if (!Array.isArray(messages)) return
    for (const msg of messages) {
      const info = asRecord(asRecord(msg).info)
      if (info.role !== 'assistant') continue
      const msgId = typeof info.id === 'string' ? info.id : ''
      const parentId = typeof info.parentID === 'string' ? info.parentID : ''
      const isCompactionSummary = info.summary === true
      // Accept if parentID matches our user message, OR it was tracked live, OR
      // compaction re-chained the messages and this isn't the summary itself
      // (port of bridge.py _fetch_final_message_state, lines ~1420-1426).
      const accept =
        userMessageIds.has(parentId) ||
        (msgId !== '' && allowedAssistantMsgIds.has(msgId)) ||
        (compactionOccurred && !isCompactionSummary)
      if (!accept) continue
      const parts = Array.isArray(asRecord(msg).parts) ? (asRecord(msg).parts as unknown[]) : []
      const combined = parts
        .map(p => asRecord(p))
        .filter(p => p.type === 'text')
        .map(p => (typeof p.text === 'string' ? p.text : ''))
        .join('')
      const previous = messageText.get(msgId) ?? ''
      if (combined.length > previous.length) {
        messageText.set(msgId, combined)
        yield { kind: 'token', messageId: msgId, payload: { text: combined } }
      }
    }
  }

  return {
    name: 'opencode',

    async start(opts: HarnessStartOptions): Promise<{ agentSessionId: string }> {
      startModel = opts.model
      startReasoningEffort = opts.reasoningEffort
      if (opts.resumeAgentSessionId && (await validateSession(opts.resumeAgentSessionId))) {
        opencodeSessionId = opts.resumeAgentSessionId
      } else {
        opencodeSessionId = await createSession()
      }
      return { agentSessionId: opencodeSessionId }
    },

    async *runPrompt(prompt: HarnessPrompt, signal: AbortSignal): AsyncIterable<HarnessEvent> {
      if (!opencodeSessionId) opencodeSessionId = await createSession()
      const sessionId = opencodeSessionId

      // Per-prompt state: a fresh stop intent and compaction flag each run.
      stopRequested = false
      let compactionOccurred = false
      const promptStart = now()

      if (!readyEmitted) {
        readyEmitted = true
        yield {
          kind: 'ready',
          messageId: prompt.messageId,
          payload: { agentSessionId: sessionId },
        }
      }

      const opencodeMessageId = ascendingId('msg')
      const requestBody = buildPromptRequestBody(
        prompt.content,
        startModel,
        opencodeMessageId,
        startReasoningEffort
      )

      // Per-part cumulative text, ordered per assistant message so a coalesced
      // token snapshot carries the whole assistant turn (not a single part).
      const partText = new Map<string, string>()
      const messagePartOrder = new Map<string, string[]>()
      const messageText = (msgId: string): string =>
        (messagePartOrder.get(msgId) ?? []).map(pid => partText.get(pid) ?? '').join('')

      const allowedAssistantMsgIds = new Set<string>()
      const userMessageIds = new Set<string>([opencodeMessageId])
      const pendingParts = new Map<string, Array<{ part: Record<string, unknown>; delta: unknown }>>()
      const emittedToolStates = new Set<string>()

      const handlePart = (part: Record<string, unknown>, delta: unknown): HarnessEvent[] => {
        const partType = typeof part.type === 'string' ? part.type : ''
        const partId = typeof part.id === 'string' ? part.id : ''
        const msgId = typeof part.messageID === 'string' ? part.messageID : ''
        const events: HarnessEvent[] = []

        if (partType === 'text') {
          const full = typeof part.text === 'string' ? part.text : ''
          if (typeof delta === 'string' && delta) {
            partText.set(partId, (partText.get(partId) ?? '') + delta)
          } else {
            partText.set(partId, full)
          }
          const order = messagePartOrder.get(msgId) ?? []
          if (!order.includes(partId)) {
            order.push(partId)
            messagePartOrder.set(msgId, order)
          }
          const text = messageText(msgId)
          if (text) events.push({ kind: 'token', messageId: msgId, payload: { text } })
        } else if (partType === 'tool') {
          const state = asRecord(part.state)
          const status = typeof state.status === 'string' ? state.status : ''
          const input = asRecord(state.input)
          if ((status === 'pending' || status === '') && Object.keys(input).length === 0) {
            return events
          }
          const callId = typeof part.callID === 'string' ? part.callID : ''
          const partSid = typeof part.sessionID === 'string' ? part.sessionID : ''
          const toolKey = `tool:${partSid}:${callId}:${status}`
          if (emittedToolStates.has(toolKey)) return events
          emittedToolStates.add(toolKey)
          const terminal = status === 'completed' || status === 'error'
          const payload: Record<string, unknown> = {
            tool: typeof part.tool === 'string' ? part.tool : '',
            args: input,
            callId,
            status,
          }
          if (terminal) payload.output = typeof state.output === 'string' ? state.output : ''
          events.push({ kind: terminal ? 'tool_result' : 'tool_call', messageId: msgId, payload })
        } else if (partType === 'step-start') {
          events.push({ kind: 'step_start', messageId: msgId, payload: {} })
        } else if (partType === 'step-finish') {
          events.push({
            kind: 'step_finish',
            messageId: msgId,
            payload: { cost: part.cost ?? null, tokens: part.tokens ?? null, reason: part.reason ?? null },
          })
        }
        return events
      }

      let sseResponse: Response
      try {
        sseResponse = await fetchImpl(`${base}/event`, {
          headers: { Accept: 'text/event-stream' },
          signal,
        })
      } catch (error) {
        yield errorEvent(prompt.messageId, error)
        return
      }
      if (!sseResponse.ok || !sseResponse.body) {
        // Cancel the body on the failure path too — a non-2xx response can still
        // carry an (unconsumed) body that would otherwise leak (P3-7).
        await cancelBody(sseResponse.body)
        yield errorEvent(prompt.messageId, new Error(`SSE connection failed (${sseResponse.status})`))
        return
      }
      const sseBody = sseResponse.body

      let sawError = false
      let errorText: string | null = null
      let terminalYielded = false
      try {
        const promptRes = await timedFetch(
          `${base}/session/${encodeURIComponent(sessionId)}/prompt_async`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
          }
        )
        if (promptRes.status !== 200 && promptRes.status !== 204) {
          throw new Error(`Async prompt failed (${promptRes.status})`)
        }

        for await (const event of parseSseEvents(sseBody, signal, inactivityMs)) {
          // Wall-clock max-duration guard (P3-1): a stream that stays busy (or
          // heartbeats) forever never trips the inactivity deadline, so bound it
          // here — checked on EVERY event, ahead of the heartbeat/continue paths,
          // so no event class can starve it (port of bridge.py PROMPT_MAX_DURATION).
          if (now() - promptStart > promptMaxDurationMs) {
            await requestStop()
            const durationTextMap = new Map<string, string>()
            for (const [msgId, order] of messagePartOrder.entries()) {
              durationTextMap.set(msgId, order.map(pid => partText.get(pid) ?? '').join(''))
            }
            for await (const ev of fetchFinalState(
              sessionId,
              userMessageIds,
              allowedAssistantMsgIds,
              durationTextMap,
              compactionOccurred
            )) {
              yield ev
            }
            terminalYielded = true
            yield {
              kind: 'error',
              messageId: prompt.messageId,
              critical: true,
              payload: {
                error: `${PROMPT_MAX_DURATION_ERROR} of ${Math.round(promptMaxDurationMs / 1000)}s`,
              },
            }
            return
          }

          const eventType = event.type
          if (eventType === 'server.heartbeat' || eventType === 'server.connected') continue

          const props = asRecord(event.properties)

          // session_title (session.updated → session_title). Placeholder/default
          // titles are dropped and identical repeats are deduped (P3-6).
          if (eventType === 'session.updated') {
            const info = asRecord(props.info)
            const sid = props.sessionID ?? info.id
            if (sid === sessionId) {
              const title = forwardableTitle(info.title)
              if (title) yield { kind: 'session_title', messageId: prompt.messageId, payload: { title } }
            }
            continue
          }

          const eventSessionId =
            (props.sessionID as string | undefined) ?? (asRecord(props.part).sessionID as string | undefined)
          if (eventSessionId && eventSessionId !== sessionId) continue

          if (eventType === 'message.updated') {
            const info = asRecord(props.info)
            if (info.sessionID !== sessionId) continue
            const ocMsgId = typeof info.id === 'string' ? info.id : ''
            const parentId = typeof info.parentID === 'string' ? info.parentID : ''
            const role = info.role
            const isCompactionSummary = info.summary === true
            if (role === 'user' && ocMsgId) userMessageIds.add(ocMsgId)
            // Accept an assistant message when its parentID matches our user
            // message, OR compaction has re-chained the conversation and this is
            // not the compaction summary itself (P2-1; port of bridge.py
            // lines ~1153-1160).
            const acceptAssistant =
              userMessageIds.has(parentId) || (compactionOccurred && !isCompactionSummary)
            if (role === 'assistant' && ocMsgId && acceptAssistant) {
              allowedAssistantMsgIds.add(ocMsgId)
              const buffered = pendingParts.get(ocMsgId)
              if (buffered) {
                pendingParts.delete(ocMsgId)
                for (const { part, delta } of buffered) {
                  for (const ev of handlePart(part, delta)) yield ev
                }
              }
            }
          } else if (eventType === 'message.part.updated') {
            const part = asRecord(props.part)
            const delta = props.delta
            const ocMsgId = typeof part.messageID === 'string' ? part.messageID : ''
            if (allowedAssistantMsgIds.has(ocMsgId)) {
              for (const ev of handlePart(part, delta)) yield ev
            } else if (ocMsgId) {
              const list = pendingParts.get(ocMsgId) ?? []
              list.push({ part, delta })
              pendingParts.set(ocMsgId, list)
            }
          } else if (eventType === 'session.compacted') {
            // Compaction re-chains messages so subsequent assistant parentIDs no
            // longer point at our user message; flip the flag so acceptance falls
            // through to the compaction branch above (P2-1).
            const compactedSid = props.sessionID ?? asRecord(props.info).id
            if (compactedSid === sessionId) compactionOccurred = true
            continue
          } else if (
            eventType === 'session.idle' ||
            (eventType === 'session.status' && asRecord(props.status).type === 'idle')
          ) {
            const messageTextMap = new Map<string, string>()
            for (const [msgId, order] of messagePartOrder.entries()) {
              messageTextMap.set(msgId, order.map(pid => partText.get(pid) ?? '').join(''))
            }
            for await (const ev of fetchFinalState(
              sessionId,
              userMessageIds,
              allowedAssistantMsgIds,
              messageTextMap,
              compactionOccurred
            )) {
              yield ev
            }
            terminalYielded = true
            // A stop()-initiated idle is a cancellation, not a success (P2-2).
            yield {
              kind: 'execution_complete',
              messageId: prompt.messageId,
              critical: true,
              payload: stopRequested ? { success: false, aborted: true } : { success: true },
            }
            return
          } else if (eventType === 'session.error') {
            sawError = true
            errorText = extractErrorMessage(props.error)
            terminalYielded = true
            yield {
              kind: 'error',
              messageId: prompt.messageId,
              critical: true,
              payload: { error: errorText },
            }
            return
          }
        }

        // Stream ended without an explicit idle/error terminal (server closed).
        if (!terminalYielded) {
          yield {
            kind: 'execution_complete',
            messageId: prompt.messageId,
            critical: true,
            payload: sawError ? { success: false, error: errorText } : { success: true },
          }
        }
      } catch (error) {
        if (error instanceof PromptAbortedError) {
          await requestStop()
          if (!terminalYielded) {
            // Signal-abort resolves as a cancellation (P2-2): `aborted: true` is
            // the bridge's cue to finish('cancelled'), never 'failed'.
            yield {
              kind: 'execution_complete',
              messageId: prompt.messageId,
              critical: true,
              payload: { success: false, aborted: true },
            }
          }
          return
        }
        await requestStop()
        if (!terminalYielded) yield errorEvent(prompt.messageId, error)
      } finally {
        // Guaranteed body teardown on EVERY exit — including a prompt POST that
        // throws before parseSseEvents (whose own finally would otherwise be the
        // only canceller) — so the /event response never leaks (P3-7).
        await cancelBody(sseBody)
      }
    },

    async stop(): Promise<void> {
      // Mark intent so the resulting idle terminal is reported as cancelled, not
      // succeeded (P2-2), then best-effort ask OpenCode to abort.
      stopRequested = true
      await requestStop()
    },

    async shutdown(): Promise<void> {
      opencodeSessionId = null
      readyEmitted = false
      stopRequested = false
    },
  }
}

/** Best-effort cancel of a fetch response body; never throws. */
async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) return
  try {
    await body.cancel()
  } catch {
    // already released/closed
  }
}

function errorEvent(messageId: string, error: unknown): HarnessEvent {
  const message = error instanceof Error ? error.message : String(error)
  return { kind: 'error', messageId, critical: true, payload: { error: message } }
}

// -- Pre-prompt model validation (ALI-1086) -----------------------------------
//
// The pinned OpenCode (see OPENCODE_PINNED_VERSION) resolves model ids against
// a catalog that is its BUNDLED snapshot merged with a runtime fetch of
// https://models.dev/api.json (verified empirically on ALI-1086: fetched at
// boot when reachable, cached to <cache>/opencode/models.json, refreshed when
// stale). When models.dev is unreachable the bundled snapshot is stale
// (predates claude-opus-4-8) and the FIRST prompt dies inside the SSE stream
// with an opaque `run_failed: Model not found`. These helpers let the hosted
// loop ask the RUNNING `opencode serve` — `GET /config/providers` is the
// runtime's actual resolvable catalog — whether the requested model resolves,
// BEFORE the prompt is posted, and fail fast naming the alternatives.

/** provider id → model ids the RUNNING opencode instance can resolve. */
export type OpenCodeModelCatalog = ReadonlyMap<string, readonly string[]>

const MODEL_CATALOG_REQUEST_TIMEOUT_MS = 10_000

/**
 * Read the resolvable catalog from a running `opencode serve` via
 * `GET /config/providers` (shape: `{ providers: [{ id, models: { <id>: … } }] }`,
 * verified against opencode-ai@1.14.41). Returns null on ANY transport/shape
 * failure — the caller treats that as "cannot validate", never as "invalid".
 */
export async function fetchOpenCodeModelCatalog(
  baseUrl: string,
  fetchImpl: HarnessFetch = globalThis.fetch as HarnessFetch,
  timeoutMs: number = MODEL_CATALOG_REQUEST_TIMEOUT_MS
): Promise<OpenCodeModelCatalog | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/config/providers`, {
      signal: controller.signal,
    })
    if (!res.ok) return null
    const data = asRecord(await res.json())
    if (!Array.isArray(data.providers)) return null
    const catalog = new Map<string, string[]>()
    for (const entry of data.providers) {
      const provider = asRecord(entry)
      const id = typeof provider.id === 'string' ? provider.id : null
      if (!id) continue
      catalog.set(id, Object.keys(asRecord(provider.models)))
    }
    return catalog
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function sharedPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a[i] === b[i]) i += 1
  return i
}

/** Rank candidate model ids by similarity to the requested id (longest shared
 *  prefix first, ties broken lexicographically DESCENDING so the newest of a
 *  versioned family leads) and cap the list — the fail-fast error should lead
 *  with the closest/newest substitutes, not a full catalog dump. */
export function rankModelAlternatives(
  requested: string,
  candidates: readonly string[],
  limit = 8
): string[] {
  return [...new Set(candidates)]
    .sort((a, b) => {
      const byPrefix = sharedPrefixLength(requested, b) - sharedPrefixLength(requested, a)
      return byPrefix !== 0 ? byPrefix : b.localeCompare(a)
    })
    .slice(0, limit)
}

export type ModelValidationOutcome =
  | { kind: 'resolvable'; waitedMs: number }
  | {
      kind: 'unresolvable'
      /** Provider-qualified requested model, e.g. "anthropic/claude-opus-4-8". */
      requested: string
      /** Provider-qualified resolvable substitutes, closest first. */
      alternatives: string[]
      /** False when the PROVIDER itself is unknown to the runtime. */
      providerKnown: boolean
      waitedMs: number
    }
  | { kind: 'skipped'; reason: string }

export interface AwaitModelResolvableOptions {
  /** Base URL of the running `opencode serve`. */
  baseUrl: string
  /** Requested model, provider-qualified or bare (bare → "anthropic"). */
  model: string
  fetchImpl?: HarnessFetch
  /**
   * Total budget to wait for the model to become resolvable. OpenCode's
   * models.dev refresh runs in the BACKGROUND at boot, so the catalog can be
   * bundled-only for the first seconds after the server answers HTTP; polling
   * bridges that window instead of failing a run the refresh would have fixed.
   */
  timeoutMs?: number
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const MODEL_RESOLVE_TIMEOUT_MS = 30_000
const MODEL_RESOLVE_POLL_MS = 2_000

/**
 * Decide whether the requested model is resolvable by the RUNNING opencode,
 * polling briefly so the boot-time models.dev refresh has time to land.
 * Fail-open on validator infrastructure, with a DELIBERATE asymmetry on null
 * catalog reads:
 *   - null BEFORE any successful read → `skipped` immediately (dead/absent
 *     endpoint; opencode's own `session.error` remains the backstop, and the
 *     early exit keeps absent-endpoint runs — and tests — cheap);
 *   - null AFTER at least one successful read → a transient boot-window blip
 *     (5xx/drop): sleep and keep polling within the budget; a budget that
 *     ends in that state returns `skipped`, NEVER a false `unresolvable` off
 *     a flaky read.
 * Only a HEALTHY catalog that never lists the model within the budget yields
 * `unresolvable`, with ranked, provider-qualified alternatives.
 */
export async function awaitOpenCodeModelResolvable(
  opts: AwaitModelResolvableOptions
): Promise<ModelValidationOutcome> {
  const timeoutMs = opts.timeoutMs ?? MODEL_RESOLVE_TIMEOUT_MS
  const pollMs = opts.pollMs ?? MODEL_RESOLVE_POLL_MS
  const sleep = opts.sleep ?? ((ms: number): Promise<void> => new Promise(r => setTimeout(r, ms)))
  const now = opts.now ?? ((): number => Date.now())
  const { providerId, modelId } = qualifyHostedModel(opts.model)
  const requested = `${providerId}/${modelId}`

  const startedAt = now()
  let lastGoodCatalog: OpenCodeModelCatalog | null = null
  let sawTransientFailure = false
  for (;;) {
    const catalog = await fetchOpenCodeModelCatalog(opts.baseUrl, opts.fetchImpl)
    if (catalog === null) {
      if (lastGoodCatalog === null) {
        // Never answered — the endpoint is dead/absent, not blipping. Skip
        // immediately rather than invent a failure mode (or a slow wait) the
        // run would not otherwise have.
        return { kind: 'skipped', reason: 'opencode /config/providers unavailable' }
      }
      // Transient failure after a successful read (boot-window 5xx/drop) —
      // keep polling within the budget.
      sawTransientFailure = true
    } else {
      lastGoodCatalog = catalog
      sawTransientFailure = false
      if ((catalog.get(providerId) ?? []).includes(modelId)) {
        return { kind: 'resolvable', waitedMs: now() - startedAt }
      }
      // Deliberately NOT failing fast when the provider itself is unknown:
      // the models.dev refresh can add whole providers too, so the poll runs
      // the full budget either way.
    }
    if (now() - startedAt >= timeoutMs) break
    await sleep(pollMs)
  }

  if (sawTransientFailure || lastGoodCatalog === null) {
    // The budget ended on a flaky read — never declare `unresolvable` off it.
    return { kind: 'skipped', reason: 'opencode /config/providers became unavailable mid-poll' }
  }

  const providerKnown = lastGoodCatalog.has(providerId)
  const candidates = providerKnown
    ? (lastGoodCatalog.get(providerId) ?? []).map(id => `${providerId}/${id}`)
    : [...lastGoodCatalog.entries()].flatMap(([pid, ids]) => ids.map(id => `${pid}/${id}`))
  return {
    kind: 'unresolvable',
    requested,
    alternatives: rankModelAlternatives(requested, candidates),
    providerKnown,
    waitedMs: now() - startedAt,
  }
}

// -- spawnOpenCode: the P3.5 in-sandbox launch helper ------------------------

export interface OpenCodeConfigOptions {
  /** Provider-qualified model string, e.g. "anthropic/claude-opus-4-8". */
  model: string
  /** OpenCode permission map; defaults to allow-all EXCEPT the headless-denied
   *  tools below (sandbox is the boundary for everything else). */
  permission?: Record<string, unknown>
}

/**
 * Tools DENIED in a hosted headless run (ALI-1037). OpenCode exposes a `question`
 * permission key (docs/permissions) that gates the interactive "ask the user a
 * question" tool. In an unattended sandbox there is no human to answer it, and
 * OpenCode's only external reply endpoint — `POST /session/{id}/permissions/{permID}`
 * — takes a BOOLEAN allow/deny, so it cannot select one of the tool's multiple
 * options anyway. Denying the tool makes the model's ask fail fast (surfaced back
 * to it as a tool error) so it proceeds autonomously per the standing preamble
 * (HOSTED_TASK_PREAMBLE), instead of blocking the run forever. This is the
 * documented fallback path in ALI-1037 (answer-externally is not cleanly possible).
 */
export const HEADLESS_DENIED_TOOLS = ['question'] as const

/** The default headless permission map: allow everything, deny the interactive
 *  question tool (see HEADLESS_DENIED_TOOLS). */
export function defaultHeadlessPermission(): Record<string, unknown> {
  const permission: Record<string, unknown> = { '*': { '*': 'allow' } }
  for (const tool of HEADLESS_DENIED_TOOLS) permission[tool] = 'deny'
  return permission
}

/**
 * Build the `OPENCODE_CONFIG_CONTENT` payload OpenCode reads at boot (mirrors
 * OpenInspect's `start_opencode`). Kept pure so the launch command and the
 * config are independently testable.
 */
export function buildOpenCodeConfigContent(opts: OpenCodeConfigOptions): string {
  return JSON.stringify({
    model: opts.model,
    permission: opts.permission ?? defaultHeadlessPermission(),
  })
}

export interface SpawnOpenCodeOptions extends OpenCodeConfigOptions {
  port?: number
  /** Directory OpenCode runs in (the cloned workspace). */
  cwd?: string
  /** Extra env merged over the config-content injection. */
  env?: Record<string, string>
  /** Injectable spawner (defaults to Bun.spawn) so this stays unit-testable. */
  spawn?: (
    cmd: string[],
    opts: { cwd?: string; env: Record<string, string>; logPath?: string }
  ) => { kill: () => void }
  /** File the spawner should append opencode's stdout/stderr to. On readiness
   *  timeout its tail is included in the thrown error — the bare "fetch failed"
   *  this replaces was undiagnosable (ALI-1034). */
  logPath?: string
  /** Overall readiness budget. OpenCode's FIRST boot runs a one-time sqlite
   *  migration ("may take a few minutes") before it listens, so this must
   *  comfortably cover a cold snapshot. */
  readyTimeoutMs?: number
  /** Poll interval while waiting for the server to answer. */
  readyPollMs?: number
  /** Abort (e.g. run cancelled) while still waiting for readiness. */
  signal?: AbortSignal
  /** Injectable readiness probe (defaults to global fetch) for tests. */
  fetchImpl?: typeof fetch
}

export interface SpawnedOpenCode {
  baseUrl: string
  port: number
  stop: () => void
  /** How long the server took to answer its first request (set by the real
   *  spawnOpenCode; injected test spawners may omit it). */
  readyAfterMs?: number
}

const OPENCODE_READY_TIMEOUT_MS = 180_000
const OPENCODE_READY_POLL_MS = 500
const OPENCODE_READY_PROBE_TIMEOUT_MS = 2_000
const OPENCODE_LOG_TAIL_BYTES = 2_000

function readLogTail(logPath: string | undefined): string | null {
  if (!logPath) return null
  try {
    const content = readFileSync(logPath, 'utf8')
    if (!content.trim()) return null
    return content.slice(-OPENCODE_LOG_TAIL_BYTES).trim()
  } catch {
    return null
  }
}

/**
 * Launch `opencode serve` locally and WAIT until it answers HTTP. OpenCode's
 * first boot performs a one-time sqlite migration before it listens; returning
 * the baseUrl without waiting raced the harness's first `POST /session` into a
 * connection-refused "fetch failed" (ALI-1034, found live in QA-3). Any HTTP
 * status counts as ready — we only need the socket to be accepting. Process
 * supervision is otherwise intentionally minimal for this slice; the pinned
 * version (`OPENCODE_PINNED_VERSION`) is the one the sandbox image must install
 * (see the SSE-fragility note on that constant).
 */
export async function spawnOpenCode(opts: SpawnOpenCodeOptions): Promise<SpawnedOpenCode> {
  const port = opts.port ?? DEFAULT_OPENCODE_PORT
  const env: Record<string, string> = {
    OPENCODE_CONFIG_CONTENT: buildOpenCodeConfigContent(opts),
    ...(opts.env ?? {}),
  }
  const cmd = ['opencode', 'serve', '--port', String(port)]
  const spawnImpl =
    opts.spawn ??
    ((command: string[], spawnOpts: { cwd?: string; env: Record<string, string> }) => {
      const bun = (globalThis as { Bun?: { spawn: (o: unknown) => { kill: () => void } } }).Bun
      if (!bun?.spawn) throw new Error('spawnOpenCode requires Bun.spawn or an injected spawner')
      return bun.spawn({
        cmd: command,
        cwd: spawnOpts.cwd,
        env: { ...process.env, ...spawnOpts.env },
        stdout: 'ignore',
        stderr: 'ignore',
      })
    })
  const child = spawnImpl(cmd, { cwd: opts.cwd, env, logPath: opts.logPath })
  const baseUrl = `http://localhost:${port}`

  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch)
  const timeoutMs = opts.readyTimeoutMs ?? OPENCODE_READY_TIMEOUT_MS
  const pollMs = opts.readyPollMs ?? OPENCODE_READY_POLL_MS
  const startedAt = Date.now()
  for (;;) {
    if (opts.signal?.aborted) {
      child.kill()
      throw new Error('opencode serve readiness wait aborted')
    }
    try {
      const probe = new AbortController()
      const timer = setTimeout(() => probe.abort(), OPENCODE_READY_PROBE_TIMEOUT_MS)
      // Link the run signal so an abort tears down an in-flight probe
      // immediately instead of waiting out the per-probe timeout.
      const probeSignal = opts.signal ? AbortSignal.any([opts.signal, probe.signal]) : probe.signal
      try {
        // Any HTTP response (even 404) proves the server is accepting.
        const res = await fetchImpl(`${baseUrl}/session`, { signal: probeSignal })
        await cancelBody(res.body)
        break
      } finally {
        clearTimeout(timer)
      }
    } catch {
      // not listening yet — fall through to the timeout check + sleep
    }
    // Soft budget: checked between probes, so the total wait can overrun by up
    // to one probe timeout + poll interval. Negligible against the default.
    if (Date.now() - startedAt >= timeoutMs) {
      child.kill()
      const tail = readLogTail(opts.logPath)
      throw new Error(
        `opencode serve did not become ready on ${baseUrl} within ${timeoutMs}ms` +
          (tail ? ` — log tail: ${tail}` : ' (no log output captured)')
      )
    }
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }

  return { baseUrl, port, stop: () => child.kill(), readyAfterMs: Date.now() - startedAt }
}
