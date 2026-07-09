/**
 * Headless-run helpers (ALI-1037) for the in-sandbox loop.
 *
 *   - `withIdleWatchdog`: wraps a harness event stream and aborts a prompt that
 *     makes NO progress (no harness event) for a bounded window, so a stalled
 *     agent can never hang a hosted run forever. On idle it invokes `onTimeout`
 *     (the loop aborts the harness) then throws `AgentStalledError`, which the
 *     loop turns into a `failed` terminal — AFTER running the end-of-run harvest.
 *
 *   - `annotateHeadlessQuestions`: observability for the question-tool deny path.
 *     The interactive `question` tool is DENIED via OpenCode's permission map
 *     (see HEADLESS_DENIED_TOOLS in hosted-harness-opencode.ts), so a headless
 *     run never blocks on it. When the agent nonetheless attempts a `question`
 *     tool call, this wrapper emits a `question_auto_answered` event recording the
 *     question and the option that WOULD be recommended, so the run timeline shows
 *     the auto-handling. It touches only the normalized event stream — never the
 *     fragile OpenCode SSE transform.
 */

import type { HarnessEvent } from './hosted-harness.js'

/** Thrown by `withIdleWatchdog` when the stream is idle past its timeout. */
export class AgentStalledError extends Error {
  readonly idleMs: number
  constructor(idleMs: number) {
    super(`agent_stalled: no progress for ${formatIdleWindow(idleMs)}`)
    this.name = 'AgentStalledError'
    this.idleMs = idleMs
  }
}

/** Render the idle window for the error message. Minutes (the operator-facing
 *  unit; default window is 25m), rounded to one decimal so sub-minute test
 *  windows still read sensibly. */
export function formatIdleWindow(ms: number): string {
  const minutes = Math.round((ms / 60000) * 10) / 10
  return `${minutes}m`
}

export interface IdleWatchdogOptions<T> {
  /** No harness event within this many ms aborts the prompt. <= 0 disables. */
  timeoutMs: number
  /** Invoked once on idle (the loop aborts the harness) before the throw. */
  onTimeout: () => Promise<void> | void
  /**
   * Whether a value counts as PROGRESS (resets the idle timer). Values passed
   * through as non-progress are still yielded downstream but do NOT extend the
   * idle deadline. Defaults to treating every value as progress. Used to exclude
   * synthetic deny-path events (e.g. `question_auto_answered`) so a model stuck
   * in a denied-question retry loop still trips `agent_stalled` (ALI-1069).
   */
  isProgress?: (value: T) => boolean
}

const IDLE_SENTINEL = Symbol('idle')

/**
 * Wrap `source` so that if no PROGRESS arrives within `timeoutMs`, `onTimeout`
 * runs and `AgentStalledError` is thrown. The idle deadline advances only on
 * values `opts.isProgress` accepts (default: all), so it measures gaps between
 * real progress events, not total duration — a stream of non-progress values
 * (e.g. `question_auto_answered` deny-path events) passes through WITHOUT
 * resetting the timer, so a stuck loop still stalls. The still-pending `next()`
 * is not left as an unhandled rejection, and the underlying iterator is
 * returned/closed on any early exit.
 */
export async function* withIdleWatchdog<T>(
  source: AsyncIterable<T>,
  opts: IdleWatchdogOptions<T>
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]()
  const isProgress = opts.isProgress ?? ((): boolean => true)
  // Absolute deadline so a non-progress value can be yielded WITHOUT extending
  // the window (each iteration arms the timer for whatever remains).
  let deadline = Date.now() + opts.timeoutMs
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const idle = new Promise<typeof IDLE_SENTINEL>(resolve => {
        timer = setTimeout(() => resolve(IDLE_SENTINEL), Math.max(0, deadline - Date.now()))
      })
      const nextResult = iterator.next()
      let raced: IteratorResult<T> | typeof IDLE_SENTINEL
      try {
        raced = await Promise.race([nextResult, idle])
      } finally {
        if (timer) clearTimeout(timer)
      }
      if (raced === IDLE_SENTINEL) {
        // Swallow the abandoned next() so it never surfaces as an unhandled
        // rejection once the underlying stream tears down.
        void Promise.resolve(nextResult).catch(() => {})
        await opts.onTimeout()
        throw new AgentStalledError(opts.timeoutMs)
      }
      if (raced.done) return
      // Only genuine progress pushes the deadline out; non-progress values are
      // relayed but leave the existing deadline intact.
      if (isProgress(raced.value)) deadline = Date.now() + opts.timeoutMs
      yield raced.value
    }
  } finally {
    if (iterator.return) {
      try {
        await iterator.return()
      } catch {
        // best-effort close
      }
    }
  }
}

// -- Headless question annotation --------------------------------------------

function optionText(option: unknown): string {
  if (typeof option === 'string') return option
  if (option && typeof option === 'object') {
    const rec = option as Record<string, unknown>
    for (const key of ['label', 'text', 'value', 'title', 'option', 'name']) {
      if (typeof rec[key] === 'string') return rec[key] as string
    }
  }
  return ''
}

export interface ParsedHeadlessQuestion {
  question: string
  chosenOption: string
}

/**
 * Parse the OpenCode `question` tool args into the question text and the option
 * we would pick headless: the one labeled "(Recommended)" if present, else the
 * first. Defensive against the tool's shape drifting (options as strings or
 * objects; the question under any of several keys).
 */
export function parseHeadlessQuestion(args: unknown): ParsedHeadlessQuestion {
  const rec = args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
  const questions = Array.isArray(rec.questions) ? rec.questions : []
  const first = questions[0]

  let question = ''
  let options: unknown[] = []
  if (typeof first === 'string') {
    question = first
  } else if (first && typeof first === 'object') {
    const q = first as Record<string, unknown>
    for (const key of ['question', 'prompt', 'text', 'title', 'message']) {
      if (typeof q[key] === 'string') {
        question = q[key] as string
        break
      }
    }
    if (Array.isArray(q.options)) options = q.options
  }
  if (options.length === 0 && Array.isArray(rec.options)) options = rec.options
  if (!question && typeof rec.question === 'string') question = rec.question

  const texts = options.map(optionText).filter(text => text.length > 0)
  const recommended = texts.find(text => /\(recommended\)/i.test(text))
  const chosenOption = recommended ?? texts[0] ?? ''
  return { question, chosenOption }
}

/**
 * Pass every harness event through unchanged; when a `question` tool call/result
 * is seen, additionally emit a `question_auto_answered` event (deduped per
 * callId+message) recording the auto-handling. The tool is denied at the
 * permission layer, so this is a record — not an interactive reply.
 */
export async function* annotateHeadlessQuestions(
  source: AsyncIterable<HarnessEvent>
): AsyncGenerator<HarnessEvent> {
  const seen = new Set<string>()
  for await (const event of source) {
    yield event
    if (event.kind !== 'tool_call' && event.kind !== 'tool_result') continue
    const payload = event.payload as Record<string, unknown>
    if (payload.tool !== 'question') continue
    const callId = typeof payload.callId === 'string' ? payload.callId : ''
    const key = `${callId}:${event.messageId ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    const parsed = parseHeadlessQuestion(payload.args)
    yield {
      kind: 'question_auto_answered',
      messageId: event.messageId,
      payload: {
        question: parsed.question,
        chosenOption: parsed.chosenOption,
        note: 'auto-answered: headless run, no human available',
        resolution: 'denied_headless',
      },
    }
  }
}
