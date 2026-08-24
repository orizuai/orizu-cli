import { sanitizeTerminalText } from './json-response.js'
import {
  formatFiniteLengthCount,
  type CliLengthStats,
} from './prompt-length-wire.js'

interface PromptSummaryRow {
  id: string
  name: string
  role: string
  status?: string
  lengthStats?: CliLengthStats | null
  owner?: {
    instructionSetSlug: string
    componentKey: string
  } | null
}

export function printPromptSummaryTable(
  items: PromptSummaryRow[],
  emptyMessage: string,
  printLine: (line: string) => void
) {
  if (items.length === 0) {
    printLine(emptyMessage)
    return
  }

  const rows = items.map(item => ({
    id: sanitizeTerminalText(item.id),
    name: sanitizeTerminalText(item.name),
    role: sanitizeTerminalText(item.role),
    status: sanitizeTerminalText(item.status || 'active'),
    tokens: item.lengthStats == null
      ? '—'
      : (() => {
          const count = formatFiniteLengthCount(item.lengthStats.tokens)
          return count === null ? '—' : `~${count}`
        })(),
    lines: item.lengthStats == null
      ? '—'
      : formatFiniteLengthCount(item.lengthStats.lines) ?? '—',
    chars: item.lengthStats == null
      ? '—'
      : formatFiniteLengthCount(item.lengthStats.chars) ?? '—',
    words: item.lengthStats == null
      ? '—'
      : formatFiniteLengthCount(item.lengthStats.words) ?? '—',
  }))
  const headers = ['ID', 'NAME', 'ROLE', 'STATUS', 'TOKENS', 'LINES', 'CHARS', 'WORDS']
  const keys = ['id', 'name', 'role', 'status', 'tokens', 'lines', 'chars', 'words'] as const
  const widths = keys.map((key, index) =>
    Math.max(headers[index].length, ...rows.map(row => row[key].length))
  )

  printLine(headers.map((header, index) => header.padEnd(widths[index])).join('  '))
  printLine(widths.map(width => '-'.repeat(width)).join('  '))
  rows.forEach(row => {
    printLine(keys.map((key, index) => row[key].padEnd(widths[index])).join('  '))
  })
  items.forEach(item => {
    if (item.owner) {
      printLine(
        `Owner: ${sanitizeTerminalText(item.name)} (${sanitizeTerminalText(item.id)}) -> ` +
        `${sanitizeTerminalText(item.owner.instructionSetSlug)} / ${sanitizeTerminalText(item.owner.componentKey)}`
      )
    }
  })
}
