import {
  parseJsonResponse,
  sanitizeHumanInlineText,
} from './json-response.js'

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

  const response = await ctx.authedFetch(
    `/api/cli/optimization-runs/${encodeURIComponent(runId)}/export`
  )
  if (!response.ok) {
    throw new Error(`Failed to export optimization run: ${await response.text()}`)
  }

  const data = await parseJsonResponse<Record<string, unknown>>(
    response,
    'Optimization export'
  )
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
  printDiffCommentsSuppressionMarker(ctx, data)
}
