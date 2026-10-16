import { sanitizeHumanInlineText } from './json-response.js'
import { readOne } from './one-request-read.js'

/**
 * Human-output helpers for `orizu optimizations export`.
 *
 * Lives outside index.ts per the CLI line ratchet (ALI-976).
 */

export interface OptimizationExportCliContext {
  getArg: (name: string) => string | null
  getPositionalArg: (index: number) => string | null
  authedFetch: (path: string, init?: RequestInit) => Promise<Response>
  hasJsonFlag: () => boolean
  printJson: (value: Record<string, unknown>) => void
  printLine: (message?: string) => void
  expandHomePath: (path: string) => string
  writeTextFileEnsuringDir: (path: string, content: string) => void
  sanitizeTerminalText: (value: unknown) => string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function printTruncatedCandidateFlags(
  ctx: OptimizationExportCliContext,
  data: Record<string, unknown>
): void {
  if (!Array.isArray(data.candidates)) return
  const ids = data.candidates.flatMap(candidate => {
    if (!isRecord(candidate) || candidate.truncated !== true) return []
    const id = candidate.id
    return typeof id === 'string' && id.length > 0 ? [id] : []
  })
  if (ids.length === 0) return
  ctx.printLine(
    `Truncated candidates: ${ids
      .map(id => `${sanitizeHumanInlineText(ctx.sanitizeTerminalText, id)} (truncated: true)`)
      .join(', ')}`
  )
}

export function printDiffCommentsSuppressionMarker(
  ctx: OptimizationExportCliContext,
  data: Record<string, unknown>
): void {
  const reason = data.diffCommentsSuppressedReason
  if (typeof reason !== 'string' || reason.length === 0) {
    return
  }

  ctx.printLine(
    `Diff comments suppressed: ${sanitizeHumanInlineText(ctx.sanitizeTerminalText, reason)}`
  )
}

export async function exportOptimizationRunCommand(
  ctx: OptimizationExportCliContext
): Promise<void> {
  const runId = ctx.getPositionalArg(2) || ctx.getArg('--run-id')
  const outPathArg = ctx.getArg('--out')

  if (!runId) {
    throw new Error('Usage: orizu optimizations export <run-id> [--out <path>] [--json]')
  }

  // The file is written only after the whole reply is read, so a stop writes nothing.
  const data = await readOne<Record<string, unknown>>({
    failed: 'Failed to export optimization run', name: 'Optimization export',
    path: `/api/cli/optimization-runs/${encodeURIComponent(runId)}/export`, fetcher: ctx.authedFetch,
  })
  if (!data) return
  if (ctx.hasJsonFlag() && !outPathArg) {
    ctx.printJson(data)
    return
  }

  const filename = outPathArg
    ? ctx.expandHomePath(outPathArg)
    : `${runId}.optimization.json`
  ctx.writeTextFileEnsuringDir(filename, `${JSON.stringify(data, null, 2)}\n`)
  ctx.printLine(
    `Saved optimization export to ${ctx.sanitizeTerminalText(filename)}`
  )
  printTruncatedCandidateFlags(ctx, data)
  printDiffCommentsSuppressionMarker(ctx, data)
}
