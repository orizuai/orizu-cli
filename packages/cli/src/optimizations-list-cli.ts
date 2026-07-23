/**
 * ALI-1073: `orizu optimizations list` — enumerate the project's optimization
 * runs (id, status, refs, promoted-version link) so an agent/human can
 * discover a prior run.
 *
 * ALI-1175: best scores in this list derive from agent-reported score runs —
 * the human output labels them so the list never implies server-attested
 * evidence.
 *
 * Lives outside index.ts per the CLI index line ratchet (ALI-976): owns its
 * own argument parsing and printing via injected io.
 */

import { authedFetch } from './http.js'
import { extractErrorMessage } from './error-response.js'

export interface OptimizationsListIo {
  json: boolean
  print: (line: string) => void
  resolveProjectSlug: (projectArg: string | null) => Promise<string>
  fetcher?: (path: string, init?: RequestInit) => Promise<Response>
}

interface OptimizationRunSummary {
  id: string
  status: string
  archiveStatus?: string
  archivedAt?: string | null
  optimizerVersionId: string | null
  datasetVersionId: string | null
  bestScore: number | null
  resultPromptVersionId: string | null
  createdAt: string | null
}

// ALI-1175: best scores here derive from agent-reported score runs — nothing is
// server-attested yet. Both the table footer AND the --json payload carry this
// signal so no consumer, human or machine, mistakes the number for attested
// evidence.
const BEST_SCORE_PROVENANCE = 'agent_reported' as const
const BEST_SCORE_PROVENANCE_NOTICE =
  'Best scores are agent-reported evidence (not server-attested).'

function argValue(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag)
  if (index === -1 || index + 1 >= args.length || args[index + 1].startsWith('--')) {
    return null
  }
  return args[index + 1]
}

function sanitizeTerminalText(value: unknown): string {
  return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
}

// Shared-parser behavior (artifact-pull.ts pattern): a non-JSON or malformed
// body becomes a bounded, sanitized error — never a raw JSON.parse throw.
async function parseJsonPayload<T>(response: Response, context: string): Promise<T> {
  const contentType = response.headers.get('content-type') || ''
  const rawBody = await response.text()

  if (!contentType.includes('application/json')) {
    throw new Error(
      `${context} returned non-JSON response (status ${response.status}). ` +
      `Body preview: ${sanitizeTerminalText(rawBody.slice(0, 180))}`
    )
  }

  try {
    return JSON.parse(rawBody) as T
  } catch {
    throw new Error(
      `${context} returned invalid JSON (status ${response.status}). ` +
      `Body preview: ${sanitizeTerminalText(rawBody.slice(0, 180))}`
    )
  }
}

export async function listOptimizationRunsCommand(args: string[], io: OptimizationsListIo): Promise<void> {
  const fetcher = io.fetcher || authedFetch
  const project = argValue(args, '--project') || await io.resolveProjectSlug(null)
  const status = argValue(args, '--status') || 'active'
  if (!['active', 'archived', 'all'].includes(status)) {
    throw new Error(
      'Usage: orizu optimizations list [--project <team/project>] ' +
      '[--status active|archived|all] [--json]'
    )
  }
  const params = new URLSearchParams({ project })
  if (status !== 'active') params.set('status', status)
  const response = await fetcher(`/api/cli/optimization-runs?${params.toString()}`)
  if (!response.ok) {
    throw new Error(
      'Failed to list optimization runs: ' +
      await extractErrorMessage(response)
    )
  }

  const data = await parseJsonPayload<{ optimizationRuns: OptimizationRunSummary[] }>(response, 'Optimization runs list')
  if (io.json) {
    // Parity with the table (thread 3): stamp each row's bestScore provenance
    // and carry the notice as a payload field (a stdout warning line would
    // corrupt the JSON), so JSON consumers see the same provenance signal.
    io.print(JSON.stringify({
      ...data,
      optimizationRuns: (data.optimizationRuns || []).map(run => ({
        ...run,
        provenance: BEST_SCORE_PROVENANCE,
      })),
      scoreProvenanceNotice: BEST_SCORE_PROVENANCE_NOTICE,
    }))
    return
  }

  const rows = data.optimizationRuns || []
  if (rows.length === 0) {
    io.print('No optimization runs found for this project.')
    return
  }

  const idWidth = Math.max(2, ...rows.map(row => String(row.id).length))
  const statusWidth = Math.max(6, ...rows.map(row => String(row.status).length))
  const archiveWidth = Math.max(
    'ARCHIVE'.length,
    ...rows.map(row => String(row.archiveStatus || 'active').length)
  )
  io.print(`${'ID'.padEnd(idWidth)}  ${'STATUS'.padEnd(statusWidth)}  ${'ARCHIVE'.padEnd(archiveWidth)}  BEST   PROMOTED_VERSION`)
  io.print(`${'-'.repeat(idWidth)}  ${'-'.repeat(statusWidth)}  ${'-'.repeat(archiveWidth)}  ${'-'.repeat(5)}  ${'-'.repeat('PROMOTED_VERSION'.length)}`)
  for (const row of rows) {
    const best = row.bestScore === null || row.bestScore === undefined ? '-' : String(row.bestScore)
    const promoted = row.resultPromptVersionId || '-'
    const archiveStatus = row.archiveStatus || 'active'
    io.print(`${String(row.id).padEnd(idWidth)}  ${String(row.status).padEnd(statusWidth)}  ${archiveStatus.padEnd(archiveWidth)}  ${best.padEnd(5)}  ${promoted}`)
  }
  // ALI-1175: label the claim — nothing here is server-attested.
  io.print(BEST_SCORE_PROVENANCE_NOTICE)
}
