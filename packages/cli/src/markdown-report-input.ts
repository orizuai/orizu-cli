import { readFileSync } from 'fs'
import { basename } from 'path'

import { hasCanonicalReportMarkdownContent } from './report-markdown-blankness.js'

export const MARKDOWN_REPORT_MAX_BYTES = 2 * 1024 * 1024

function getArg(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name)
  if (index === -1 || index + 1 >= args.length) return null
  return args[index + 1]
}

function expandHomePath(path: string): string {
  if (!path.startsWith('~/')) return path
  return `${process.env.HOME || ''}/${path.slice(2)}`
}

function rejectDashPrefixedOptionValue(name: string, value: string | null) {
  if (value?.startsWith('-')) {
    throw new Error(`Invalid value for ${name}: option values cannot start with a dash`)
  }
}

function rejectMissingOptionValue(args: readonly string[], name: string) {
  if (args.some((arg, index) => arg === name && index + 1 >= args.length)) {
    throw new Error(`${name} requires a value`)
  }
}

function readSourceFile(pathArg: string): string {
  const expandedPath = expandHomePath(pathArg)
  try {
    return readFileSync(expandedPath, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`File not found: ${expandedPath}`)
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to read file '${expandedPath}': ${message}`)
  }
}

export interface MarkdownReportInput {
  markdown: string
  sourceName: string | null
}

export function readMarkdownReportInput(
  args: readonly string[],
  reportLabel: 'Optimization' | 'Prompt' | 'Task'
): MarkdownReportInput | null {
  if (args.some(arg => arg.startsWith('--report='))) {
    throw new Error('use --report <markdown|@file> with a space, not =')
  }
  if (args.some(arg => arg.startsWith('--report-file='))) {
    throw new Error('use --report-file <path> with a space, not =')
  }

  rejectMissingOptionValue(args, '--report')
  rejectMissingOptionValue(args, '--report-file')

  const report = getArg(args, '--report')
  const reportFile = getArg(args, '--report-file')

  rejectDashPrefixedOptionValue('--report', report)
  rejectDashPrefixedOptionValue('--report-file', reportFile)

  if (report && reportFile) {
    throw new Error('Use either --report or --report-file, not both')
  }
  if (!report && !reportFile) return null

  let markdown: string
  let sourceName: string | null
  if (reportFile) {
    const expandedPath = expandHomePath(reportFile)
    markdown = readSourceFile(reportFile)
    sourceName = basename(expandedPath)
  } else if (report?.startsWith('@')) {
    const path = report.slice(1)
    const expandedPath = expandHomePath(path)
    markdown = readSourceFile(path)
    sourceName = basename(expandedPath)
  } else {
    markdown = report || ''
    sourceName = 'inline'
  }

  if (!hasCanonicalReportMarkdownContent(markdown)) {
    throw new Error(`${reportLabel} report markdown must not be blank`)
  }
  if (Buffer.byteLength(markdown, 'utf8') > MARKDOWN_REPORT_MAX_BYTES) {
    throw new Error(`${reportLabel} report exceeds ${MARKDOWN_REPORT_MAX_BYTES} bytes`)
  }

  return { markdown, sourceName }
}
