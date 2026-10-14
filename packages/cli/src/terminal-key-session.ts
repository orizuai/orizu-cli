// Reads keys from the person's terminal for setup's pickers. Loaded only
// through `await import(...)`, so commands without a picker never load Effect.
import { emitKeypressEvents } from 'readline'
import { stdin as input, stdout as output } from 'process'

import { Effect } from 'effect'

export interface KeypressInfo {
  name?: string
  sequence?: string
  ctrl?: boolean
}

/** What a key does: nothing yet, finish with a value, or cancel setup. */
export type KeyOutcome<T> = { kind: 'wait' } | { kind: 'done', value: T } | { kind: 'cancel' }

type RawInput = typeof input & {
  setRawMode?: (mode: boolean) => void
  isRaw?: boolean
}

// The terminal goes into raw mode (keys arrive one by one, nothing is echoed)
// and, for pickers, the cursor is hidden. The release always undoes both.
const rawKeys = (hideCursor: boolean) => Effect.acquireRelease(
  Effect.sync(() => {
    const rawInput = input as RawInput
    const wasRaw = Boolean(rawInput.isRaw)
    emitKeypressEvents(input)
    if (hideCursor) output.write('\x1b[?25l')
    input.resume()
    rawInput.setRawMode?.(true)
    return wasRaw
  }),
  wasRaw => Effect.sync(() => {
    const rawInput = input as RawInput
    if (rawInput.setRawMode && !wasRaw) rawInput.setRawMode(false)
    input.pause()
    if (hideCursor) output.write('\x1b[?25h')
  }),
)

const nextOutcome = <T>(onKey: (key: KeypressInfo) => KeyOutcome<T>) => Effect.acquireUseRelease(
  Effect.sync(() => ({ listener: null as ((chunk: string, key: KeypressInfo) => void) | null })),
  held => Effect.callback<T, Error>(resume => {
    held.listener = (_chunk, key) => {
      // Ctrl-C arrives as a key in raw mode, so every picker cancels on it.
      const outcome: KeyOutcome<T> = key.ctrl && key.name === 'c' ? { kind: 'cancel' } : onKey(key)
      if (outcome.kind === 'done') resume(Effect.succeed(outcome.value))
      else if (outcome.kind === 'cancel') resume(Effect.fail(new Error('Setup cancelled.')))
    }
    input.on('keypress', held.listener)
  }),
  held => Effect.sync(() => { if (held.listener) input.off('keypress', held.listener) }),
)

const STOP_SIGNALS = ['SIGINT', 'SIGTERM'] as const

/**
 * Hands each key to `onKey` until it finishes or cancels. A SIGINT or SIGTERM
 * from outside ends the wait, puts the terminal back, then ends the process
 * by that same signal.
 */
export async function readKeys<T>(onKey: (key: KeypressInfo) => KeyOutcome<T>, options: { hideCursor: boolean }): Promise<T> {
  const controller = new AbortController()
  const stop: { by: NodeJS.Signals | null } = { by: null }
  const handlers = STOP_SIGNALS.map(signal => [signal, () => { stop.by = signal; controller.abort() }] as const)
  for (const [signal, handler] of handlers) process.once(signal, handler)
  try {
    const value = await Effect.runPromise(Effect.scoped(Effect.andThen(rawKeys(options.hideCursor), nextOutcome(onKey))), { signal: controller.signal })
    if (stop.by) return await endBy(stop.by, handlers)
    return value
  } catch (error: unknown) {
    if (!stop.by) throw error
    return await endBy(stop.by, handlers)
  } finally {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler)
  }
}

/** Ends the process by the signal that stopped it, once its handlers are gone. */
async function endBy(signal: NodeJS.Signals, handlers: ReadonlyArray<readonly [NodeJS.Signals, () => void]>): Promise<never> {
  for (const [name, handler] of handlers) process.removeListener(name, handler)
  output.write('\n')
  process.kill(process.pid, signal)
  // The signal ends the process; if another listener holds it, exit as a shell would.
  setTimeout(() => process.exit(signal === 'SIGINT' ? 130 : 143), 1_000)
  return await new Promise<never>(() => {})
}
