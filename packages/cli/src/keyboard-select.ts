import { emitKeypressEvents } from 'readline'
import { stdin as input, stdout as output } from 'process'

import { sanitizeTerminalText } from './json-response.js'

interface KeypressInfo {
  name?: string
  ctrl?: boolean
}

interface KeyboardSelectOptions<T> {
  onEscape?: () => T
  escapeLabel?: string
}

type RawInput = typeof input & {
  setRawMode?: (mode: boolean) => void
  isRaw?: boolean
}

export async function promptKeyboardSelect<T>(
  title: string,
  items: T[],
  label: (item: T, index: number) => string,
  options?: KeyboardSelectOptions<T>
): Promise<T> {
  if (items.length === 0) {
    throw new Error(`No options available for ${title.toLowerCase()}`)
  }
  if (!input.isTTY || !output.isTTY) {
    throw new Error(`${title} selection requires interactive terminal. Provide flags explicitly instead.`)
  }

  output.write(`\n${sanitizeTerminalText(title)}\n`)
  output.write(`Use ↑/↓ to choose, Enter to confirm, or Esc to ${options?.escapeLabel || 'cancel'}.\n`)

  let selected = 0
  let rendered = false
  const rawInput = input as RawInput
  const wasRaw = Boolean(rawInput.isRaw)
  emitKeypressEvents(input)

  function render() {
    if (rendered) output.write(`\x1b[${items.length}A`)
    items.forEach((item, index) => {
      output.write('\x1b[2K')
      const marker = index === selected ? '●' : '○'
      output.write(`  ${marker} ${sanitizeTerminalText(label(item, index))}\n`)
    })
    rendered = true
  }

  render()
  output.write('\x1b[?25l')

  return new Promise((resolvePromise, rejectPromise) => {
    function cleanup() {
      input.off('keypress', onKeypress)
      if (rawInput.setRawMode && !wasRaw) rawInput.setRawMode(false)
      input.pause()
      output.write('\x1b[?25h\n')
    }

    function onKeypress(_chunk: string, key: KeypressInfo) {
      if (key.ctrl && key.name === 'c') {
        cleanup()
        rejectPromise(new Error('Setup cancelled.'))
        return
      }
      if (key.name === 'escape') {
        cleanup()
        if (options?.onEscape) resolvePromise(options.onEscape())
        else rejectPromise(new Error('Setup cancelled.'))
        return
      }
      if (key.name === 'up') {
        selected = (selected - 1 + items.length) % items.length
        render()
        return
      }
      if (key.name === 'down') {
        selected = (selected + 1) % items.length
        render()
        return
      }
      if (key.name === 'return' || key.name === 'enter') {
        const item = items[selected]
        cleanup()
        resolvePromise(item)
      }
    }

    input.on('keypress', onKeypress)
    input.resume()
    rawInput.setRawMode?.(true)
  })
}
