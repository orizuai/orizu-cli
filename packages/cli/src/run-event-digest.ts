/**
 * Shared compact per-event digest renderer for workbench-run tails (ALI-1045).
 *
 * Used by BOTH `orizu run tail` (human mode) and the `--tail` attached to
 * `orizu session start --hosted`, so the operator watching a live hosted run
 * can see at a glance what the agent said, which tool it called with what
 * args, and what came back — enough to spot a stall, an unanswerable question,
 * or a misdirection within seconds, without a second terminal.
 *
 * THREAT MODEL: the sandboxed agent AUTHORS these payloads and this renderer
 * writes to the OPERATOR'S terminal — treat every field as hostile.
 *
 * Contract:
 *   - ONE line per event, prefixed `#<sequence> <eventType>`.
 *   - Every field that reaches the output is capped (FIELD_MAX for tool /
 *     status / eventType, TOKEN_TEXT_MAX for prose/output, SUMMARY_MAX for
 *     args/JSON) and the WHOLE assembled line is bounded by LINE_MAX.
 *   - The final line is sanitized as the LAST step: all C0/C1 control bytes
 *     (ESC, BEL, backspace, CR/LF, DEL, 0x80-0x9F, …) are stripped, so a
 *     hostile payload can never emit terminal escape sequences (OSC-52
 *     clipboard writes, CSI clear/spoof) or extra lines at the operator; the
 *     same pass strips Unicode bidi controls, U+2028/U+2029 separators, and
 *     zero-width characters, so a payload cannot visually reorder, split, or
 *     spoof the line either (see CONTROL_CHARS).
 *   - Bounded work per event: raw strings are sliced to a working window of
 *     WORK_FACTOR x the display cap BEFORE any regex normalization; JSON
 *     summaries first take a BOUNDED PROJECTION of the payload (max
 *     PROJECTION_MAX_ITEMS entries per level, PROJECTION_MAX_DEPTH deep,
 *     PROJECTION_MAX_NODES containers) so JSON.stringify never traverses a
 *     payload-sized structure, then slice oversized string fields via the
 *     replacer — a megabyte payload costs O(display size), not O(payload).
 *   - NEVER throws: malformed payloads degrade to the bare `#<seq> <type>`
 *     line; hostile objects (throwing getters) degrade to `#? unknown`. Full
 *     fidelity stays in the JSON streams (`--json` on either command).
 *
 * Event payload shapes come from the hosted harness seam
 * (hosted-harness-{claude,opencode}.ts → hosted-run-event-sink.ts):
 *   agent_token        { messageId, text }                  (coalesced snapshot)
 *   agent_tool_call    { tool, args, callId, status }
 *   agent_tool_result  { callId, status, output[, tool] }
 *   agent_step_finish  { cost, tokens, reason }             (tokens shape varies)
 */

/** Max chars of streamed agent text / tool output shown per digest line. */
export const TOKEN_TEXT_MAX = 120
/** Max chars of arg/JSON summaries shown per digest line. */
export const SUMMARY_MAX = 160
/** Max chars for short identifier-ish fields: tool names, statuses, eventType. */
export const FIELD_MAX = 60
/** Hard backstop for a whole assembled digest line (prefix + segments + slack). */
export const LINE_MAX = 360
/** Raw strings are sliced to `displayMax * WORK_FACTOR` before normalization. */
const WORK_FACTOR = 4

/** Last-resort line when even the event envelope is hostile/unreadable. */
const LAST_RESORT = '#? unknown'

/** Characters stripped from the final line:
 *  - all C0 controls, DEL, and the C1 range (ESC 0x1B, BEL 0x07, backspace,
 *    CR/LF, 0x80-0x9F) — no OSC/CSI/DCS sequence and no extra line survives;
 *  - Unicode bidi controls (U+061C, U+200E/F, U+202A-E embeds/overrides,
 *    U+2066-9 isolates) — an RTL override can visually reorder/spoof a line;
 *  - U+2028/U+2029 line/paragraph separators — JSON.stringify emits them
 *    verbatim, breaking the one-line promise;
 *  - zero-width characters (U+200B-D, U+FEFF) — invisible spoofing padding. */
 
const CONTROL_CHARS =
  /[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * Bounded one-line summary: slice the raw string to a working window BEFORE
 * regex-normalizing (hostile megabyte fields are never fully scanned), collapse
 * whitespace runs, then hard-truncate with an ellipsis. Content cut by the
 * working window also gets the ellipsis — truncation is never silent.
 */
function summarizeText(raw: string, max: number): string {
  const windowSize = max * WORK_FACTOR
  const window = raw.length > windowSize ? raw.slice(0, windowSize) : raw
  const collapsed = window.replace(/\s+/g, ' ').trim()
  if (collapsed.length > max) return `${collapsed.slice(0, max)}…`
  return window.length < raw.length ? `${collapsed}…` : collapsed
}

/** First line only (for tool output), same bounded-window discipline. */
function firstLineSummarize(raw: string, max: number): string {
  const windowSize = max * WORK_FACTOR
  const window = raw.length > windowSize ? raw.slice(0, windowSize) : raw
  const newline = window.indexOf('\n')
  const head = newline === -1 ? window : window.slice(0, newline)
  const collapsed = head.replace(/\s+/g, ' ').trim()
  if (collapsed.length > max) return `${collapsed.slice(0, max)}…`
  // Window cut before any newline: the first line continues beyond view.
  return newline === -1 && window.length < raw.length ? `${collapsed}…` : collapsed
}

/** Traversal budget for JSON summaries (bounded projection, see below). */
const PROJECTION_MAX_ITEMS = 20
const PROJECTION_MAX_DEPTH = 4
const PROJECTION_MAX_NODES = 100
const PROJECTION_CUT = '…'

interface ProjectionState {
  nodes: number
  seen: WeakSet<object>
}

/**
 * Build a bounded clone of a hostile payload BEFORE serialization, so
 * JSON.stringify never traverses payload-sized structures (huge arrays, many
 * properties, deep nesting): at most PROJECTION_MAX_ITEMS entries per level,
 * PROJECTION_MAX_DEPTH levels, PROJECTION_MAX_NODES containers total. Cut
 * points and repeated/cyclic references become the '…' marker. Exported for
 * tests only.
 */
export function boundedJsonProjection(
  value: unknown,
  depth = 0,
  state: ProjectionState = { nodes: 0, seen: new WeakSet() }
): unknown {
  if (value === null || typeof value !== 'object') return value
  if (state.seen.has(value)) return PROJECTION_CUT
  if (depth >= PROJECTION_MAX_DEPTH || state.nodes >= PROJECTION_MAX_NODES) return PROJECTION_CUT
  state.seen.add(value)
  state.nodes += 1
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (let index = 0; index < value.length; index += 1) {
      if (index >= PROJECTION_MAX_ITEMS || state.nodes >= PROJECTION_MAX_NODES) {
        out.push(PROJECTION_CUT)
        break
      }
      out.push(boundedJsonProjection(value[index], depth + 1, state))
    }
    return out
  }
  const record = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  let count = 0
  // for...in with an early break — never materialize a huge key list.
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue
    if (count >= PROJECTION_MAX_ITEMS || state.nodes >= PROJECTION_MAX_NODES) {
      out[PROJECTION_CUT] = PROJECTION_CUT
      break
    }
    out[key] = boundedJsonProjection(record[key], depth + 1, state)
    count += 1
  }
  return out
}

function compactJson(value: unknown, max: number): string | null {
  try {
    // Bound the traversal itself (projection), then belt-and-suspenders slice
    // any oversized STRING fields in the replacer — a hostile megabyte payload
    // contributes O(display size) work, never O(payload size).
    const json = JSON.stringify(boundedJsonProjection(value), (_key, field) =>
      typeof field === 'string' && field.length > max ? field.slice(0, max) : field
    )
    if (typeof json !== 'string' || json === '{}' || json === 'null') return null
    return json.length > max ? `${json.slice(0, max)}…` : json
  } catch {
    // Unserializable values (hostile getters/proxies): no summary, no crash.
    return null
  }
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Extract the question header from the OpenCode `question` tool args.
 * Defensive against shape drift (mirrors hosted-headless.parseHeadlessQuestion,
 * kept dependency-free here): questions[0] as a string or an object with the
 * question under several candidate keys, else a flat `question` key.
 */
function questionHeader(args: Record<string, unknown>): string | null {
  const questions = Array.isArray(args.questions) ? args.questions : []
  const first = questions[0]
  if (typeof first === 'string' && first.length > 0) return first
  const record = asRecord(first)
  if (record) {
    for (const key of ['question', 'prompt', 'text', 'title', 'message']) {
      const value = stringField(record, key)
      if (value) return value
    }
  }
  return stringField(args, 'question')
}

const FILE_PATH_KEYS = ['filePath', 'file_path', 'path', 'file'] as const

/** One-line arg summary: bash command, file path, or question header —
 *  else compact truncated JSON of the args. */
function toolArgsSummary(tool: string | null, args: Record<string, unknown>): string | null {
  if (tool === 'question' || Array.isArray(args.questions)) {
    const header = questionHeader(args)
    if (header) return summarizeText(header, SUMMARY_MAX)
  }
  const command = stringField(args, 'command')
  if (command) return summarizeText(command, SUMMARY_MAX)
  for (const key of FILE_PATH_KEYS) {
    const path = stringField(args, key)
    if (path) return summarizeText(path, SUMMARY_MAX)
  }
  return compactJson(args, SUMMARY_MAX)
}

function tokenDigest(payload: Record<string, unknown>): string | null {
  const text = stringField(payload, 'text')
  return text ? summarizeText(text, TOKEN_TEXT_MAX) : null
}

function toolCallDigest(payload: Record<string, unknown>): string | null {
  const rawTool = stringField(payload, 'tool')
  const tool = rawTool ? summarizeText(rawTool, FIELD_MAX) : null
  const args = asRecord(payload.args)
  const summary = args ? toolArgsSummary(rawTool, args) : null
  if (tool && summary) return `${tool}: ${summary}`
  if (tool) return tool
  return summary
}

function toolResultDigest(payload: Record<string, unknown>): string | null {
  const status = stringField(payload, 'status')
  const tool = stringField(payload, 'tool')
  const output = stringField(payload, 'output')
  // Nothing usable: fall back to the bare `#<seq> <type>` line, not "unknown".
  if (!status && !tool && !output) return null
  const statusText = status ? summarizeText(status, FIELD_MAX) : 'unknown'
  const head = tool ? `${summarizeText(tool, FIELD_MAX)} ${statusText}` : statusText
  const line = output ? firstLineSummarize(output, TOKEN_TEXT_MAX) : ''
  return line ? `${head}: ${line}` : head
}

function stepFinishDigest(payload: Record<string, unknown>): string | null {
  const parts: string[] = []
  const cost = payload.cost
  if (typeof cost === 'number' && Number.isFinite(cost)) {
    parts.push(`cost $${cost.toFixed(4)}`)
  }
  const tokens = asRecord(payload.tokens)
  if (tokens) {
    // Both harness shapes: claude BetaUsage (input_tokens/output_tokens) and
    // opencode step-finish ({ input, output, ... }).
    const input = tokens.input_tokens ?? tokens.input
    const output = tokens.output_tokens ?? tokens.output
    if (typeof input === 'number' && typeof output === 'number') {
      parts.push(`tokens in=${input} out=${output}`)
    } else {
      const json = compactJson(tokens, SUMMARY_MAX)
      if (json) parts.push(`tokens ${json}`)
    }
  }
  return parts.length > 0 ? parts.join(' ') : null
}

function payloadDigest(eventType: string, payload: Record<string, unknown>): string | null {
  switch (eventType) {
    case 'agent_token':
      return tokenDigest(payload)
    case 'agent_tool_call':
      return toolCallDigest(payload)
    case 'agent_tool_result':
      return toolResultDigest(payload)
    case 'agent_step_finish':
      return stepFinishDigest(payload)
    default:
      // Lifecycle / artifact / error events keep their compact payload JSON —
      // they are small by construction, but truncate anyway (bounded always).
      return compactJson(payload, SUMMARY_MAX)
  }
}

function eventPrefix(event: Record<string, unknown> | null): string {
  const sequence =
    event && typeof event.sequence === 'number' && Number.isFinite(event.sequence)
      ? String(event.sequence)
      : '?'
  const rawType = event && typeof event.eventType === 'string' && event.eventType.length > 0 ? event.eventType : 'unknown'
  return `#${sequence} ${summarizeText(rawType, FIELD_MAX)}`
}

/** LAST step for every returned line: strip all C0/C1 control bytes (no
 *  terminal escapes, no extra lines) and enforce the total line budget. */
function sanitizeLine(line: string): string {
  const stripped = line.replace(CONTROL_CHARS, '')
  return stripped.length > LINE_MAX ? `${stripped.slice(0, LINE_MAX)}…` : stripped
}

/** The old (pre-ALI-1045) types-only line — kept for `--quiet`. */
export function formatRunEventTypeLine(event: unknown): string {
  try {
    return sanitizeLine(eventPrefix(asRecord(event)))
  } catch {
    // Hostile objects (throwing getters, revoked proxies) — never crash a tail.
    return LAST_RESORT
  }
}

/**
 * One compact human line for a workbench-run event: `#<seq> <type>  <digest>`.
 * Never throws; degrades to the bare `#<seq> <type>` line on any malformed or
 * missing payload field, and to `#? unknown` when the envelope itself is
 * hostile (throwing getters, revoked proxies).
 */
export function formatRunEventDigest(event: unknown): string {
  try {
    const record = asRecord(event)
    const prefix = eventPrefix(record)
    if (!record) return sanitizeLine(prefix)
    let digest: string | null = null
    try {
      const eventType = typeof record.eventType === 'string' ? record.eventType : ''
      const payload = asRecord(record.payload)
      digest = eventType && payload ? payloadDigest(eventType, payload) : null
    } catch {
      // A hostile payload getter still leaves the operator the type line.
      digest = null
    }
    return sanitizeLine(digest ? `${prefix}  ${digest}` : prefix)
  } catch {
    return LAST_RESORT
  }
}
