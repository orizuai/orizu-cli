import { stdin as input, stdout as output } from 'process'

import { sanitizeTerminalText } from './json-response.js'

interface KeyboardSelectOptions<T> {
  onEscape?: () => T
  escapeLabel?: string
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
  const onEscape = options?.onEscape
  const { readKeys } = await import('./terminal-key-session.js')
  let choice: { item: T } | { escaped: true }
  try {
    choice = await readKeys<{ item: T } | { escaped: true }>(key => {
      if (key.name === 'escape') return onEscape ? { kind: 'done', value: { escaped: true } } : { kind: 'cancel' }
      if (key.name === 'up' || key.name === 'down') {
        selected = (selected + (key.name === 'up' ? -1 : 1) + items.length) % items.length
        render()
        return { kind: 'wait' }
      }
      if (key.name === 'return' || key.name === 'enter') return { kind: 'done', value: { item: items[selected] } }
      return { kind: 'wait' }
    }, { hideCursor: true })
  } finally {
    output.write('\n')
  }
  if ('item' in choice) return choice.item
  if (!onEscape) throw new Error('Setup cancelled.')
  return onEscape()
}
