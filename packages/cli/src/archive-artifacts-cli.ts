/**
 * ALI-1199 archive/restore commands and assignment inventory.
 *
 * Kept outside index.ts per the CLI line ratchet. The server owns
 * authorization and idempotency; this module validates the CLI grammar and
 * renders the canonical response without inventing client-side state.
 */

import { authedFetch } from './http.js'
import { extractErrorMessage } from './error-response.js'

type ArchiveStatus = 'active' | 'archived' | 'all'
type ArchiveAction = 'archive' | 'restore'
type ArchiveArtifactType =
  | 'app'
  | 'dataset'
  | 'task'
  | 'assignment'
  | 'scorer'
  | 'optimization'

export interface ArchiveArtifactsIo {
  json: boolean
  print: (line: string) => void
  resolveProjectSlug: (projectArg: string | null) => Promise<string>
  fetcher?: (path: string, init?: RequestInit) => Promise<Response>
}

interface ArchiveArtifactResult {
  id: string
  type: ArchiveArtifactType
  status: 'active' | 'archived'
  archivedAt: string | null
  assigneeId?: string
}

interface AssignmentSummary {
  taskId: string
  taskTitle: string
  taskStatus: string
  status: 'active' | 'archived'
  archivedAt: string | null
  assigneeId: string
  totalAssignments: number
  completedAssignments: number
}

interface TaskSummary {
  id: string
  title: string
  status: string
  archiveStatus?: string
  teamSlug?: string
  projectSlug?: string
}

interface AppSummary {
  id: string
  name: string
  currentVersionNum?: number
  status?: string
}

interface DatasetSummary {
  id: string
  name: string
  rowCount: number | string
  status?: string
}

interface ScorerSummary {
  id: string
  name: string
  mode: string
  metricLabel: string
  implementationKind: string
  status?: string
}

type PrintLine = (line: string) => void

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const ARTIFACT_TYPES: Record<string, ArchiveArtifactType> = {
  app: 'app',
  apps: 'app',
  dataset: 'dataset',
  datasets: 'dataset',
  task: 'task',
  tasks: 'task',
  assignment: 'assignment',
  assignments: 'assignment',
  scorer: 'scorer',
  scorers: 'scorer',
  optimization: 'optimization',
  optimizations: 'optimization',
}

function argValue(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag)
  if (
    index === -1 ||
    index + 1 >= args.length ||
    args[index + 1].startsWith('--')
  ) {
    return null
  }
  return args[index + 1]
}

function sanitizeTerminalText(value: unknown): string {
  return String(value).replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g,
    ''
  )
}

function columnWidths(headers: string[], rows: string[][]): number[] {
  return headers.map((header, index) =>
    Math.max(header.length, ...rows.map(row => row[index]?.length || 0))
  )
}

function printTable(headers: string[], rows: string[][], print: PrintLine) {
  const widths = columnWidths(headers, rows)
  print(headers.map((header, index) => header.padEnd(widths[index])).join('  '))
  print(widths.map(width => '-'.repeat(width)).join('  '))
  rows.forEach(row => {
    print(row.map((cell, index) => cell.padEnd(widths[index])).join('  '))
  })
}

export function printTaskSummaries(items: TaskSummary[], print: PrintLine) {
  if (items.length === 0) return print('No tasks found.')
  printTable(
    ['TASK ID', 'TASK NAME', 'STATUS', 'ARCHIVE', 'TEAM/PROJECT'],
    items.map(item => [
      sanitizeTerminalText(item.id),
      sanitizeTerminalText(item.title || '-'),
      sanitizeTerminalText(item.status || '-'),
      sanitizeTerminalText(item.archiveStatus || 'active'),
      item.teamSlug && item.projectSlug
        ? sanitizeTerminalText(`${item.teamSlug}/${item.projectSlug}`)
        : 'unknown-project',
    ]),
    print
  )
}

export function printAppSummaries(items: AppSummary[], print: PrintLine) {
  if (items.length === 0) return print('No apps found.')
  printTable(
    ['APP ID', 'APP NAME', 'VERSION', 'ARCHIVE'],
    items.map(item => [
      sanitizeTerminalText(item.id),
      sanitizeTerminalText(item.name || '-'),
      `v${item.currentVersionNum || 1}`,
      sanitizeTerminalText(item.status || 'active'),
    ]),
    print
  )
}

export function printDatasetSummaries(
  items: DatasetSummary[],
  print: PrintLine
) {
  if (items.length === 0) return print('No datasets found.')
  printTable(
    ['DATASET ID', 'DATASET', 'ROWS', 'ARCHIVE'],
    items.map(item => [
      sanitizeTerminalText(item.id),
      sanitizeTerminalText(item.name || '-'),
      sanitizeTerminalText(item.rowCount),
      sanitizeTerminalText(item.status || 'active'),
    ]),
    print
  )
}

export function printScorerSummaries(
  items: ScorerSummary[],
  print: PrintLine
) {
  if (items.length === 0) return print('No scorers found.')
  printTable(
    ['ID', 'NAME', 'MODE', 'METRIC', 'ARCHIVE', 'IMPLEMENTATION'],
    items.map(item => [
      sanitizeTerminalText(item.id),
      sanitizeTerminalText(item.name),
      sanitizeTerminalText(item.mode),
      sanitizeTerminalText(item.metricLabel),
      sanitizeTerminalText(item.status || 'active'),
      sanitizeTerminalText(item.implementationKind),
    ]),
    print
  )
}

async function parseJsonPayload<T>(
  response: Response,
  context: string
): Promise<T> {
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

function parseStatus(args: readonly string[]): ArchiveStatus {
  const value = argValue(args, '--status') || 'active'
  if (value !== 'active' && value !== 'archived' && value !== 'all') {
    throw new Error('--status must be active, archived, or all')
  }
  return value
}

function artifactUsage() {
  return (
    'Usage: orizu <apps|datasets|tasks|assignments|scorers|optimizations> ' +
    '<archive|restore> <id> [--project <team/project>] ' +
    '[--assignee <user-id>] [--json]'
  )
}

export async function archiveArtifactCommand(
  args: string[],
  io: ArchiveArtifactsIo
): Promise<void> {
  const artifactType = ARTIFACT_TYPES[args[0] || '']
  const action = args[1] as ArchiveAction | undefined
  const artifactId = args[2]
  if (
    !artifactType ||
    (action !== 'archive' && action !== 'restore') ||
    !artifactId ||
    !UUID_PATTERN.test(artifactId)
  ) {
    throw new Error(artifactUsage())
  }

  const assigneeId = argValue(args, '--assignee')
  if (assigneeId && !UUID_PATTERN.test(assigneeId)) {
    throw new Error('--assignee must be a UUID')
  }
  if (artifactType !== 'assignment' && assigneeId) {
    throw new Error('--assignee is only valid for assignment archive commands')
  }

  const projectArg = argValue(args, '--project')
  const project = projectArg || await io.resolveProjectSlug(null)
  const params = new URLSearchParams({ project })
  const body = {
    archived: action === 'archive',
    ...(assigneeId ? { assigneeId } : {}),
  }
  const fetcher = io.fetcher || authedFetch
  const response = await fetcher(
    `/api/cli/archive-artifacts/${artifactType}/${encodeURIComponent(artifactId)}` +
      `?${params.toString()}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }
  )
  if (!response.ok) {
    throw new Error(
      `Failed to ${action} ${artifactType}: ` +
      await extractErrorMessage(response)
    )
  }

  const data = await parseJsonPayload<{ artifact: ArchiveArtifactResult }>(
    response,
    `${action === 'archive' ? 'Archive' : 'Restore'} ${artifactType}`
  )
  if (io.json) {
    io.print(JSON.stringify(data))
    return
  }

  const verb = action === 'archive' ? 'Archived' : 'Restored'
  const assigneeSuffix = data.artifact.assigneeId
    ? ` for ${sanitizeTerminalText(data.artifact.assigneeId)}`
    : ''
  io.print(
    `${verb} ${sanitizeTerminalText(data.artifact.type)} ` +
    `${sanitizeTerminalText(data.artifact.id)}${assigneeSuffix}.`
  )
}

export async function listAssignmentsCommand(
  args: string[],
  io: ArchiveArtifactsIo
): Promise<void> {
  const status = parseStatus(args)
  const assigneeId = argValue(args, '--assignee')
  if (assigneeId && !UUID_PATTERN.test(assigneeId)) {
    throw new Error('--assignee must be a UUID')
  }

  const projectArg = argValue(args, '--project')
  const project = projectArg || await io.resolveProjectSlug(null)
  const params = new URLSearchParams({ project, status })
  if (assigneeId) params.set('assignee', assigneeId)

  const fetcher = io.fetcher || authedFetch
  const response = await fetcher(`/api/cli/assignments?${params.toString()}`)
  if (!response.ok) {
    throw new Error(
      `Failed to list assignments: ${await extractErrorMessage(response)}`
    )
  }

  const data = await parseJsonPayload<{ assignments: AssignmentSummary[] }>(
    response,
    'Assignments list'
  )
  if (io.json) {
    io.print(JSON.stringify(data))
    return
  }

  const rows = data.assignments || []
  if (rows.length === 0) {
    io.print('No assignment task-groups found.')
    return
  }

  const printable = rows.map(row => ({
    id: sanitizeTerminalText(row.taskId),
    title: sanitizeTerminalText(row.taskTitle || '-'),
    lifecycle: sanitizeTerminalText(row.taskStatus || '-'),
    archive: sanitizeTerminalText(row.status || 'active'),
    progress: `${row.completedAssignments}/${row.totalAssignments}`,
  }))
  const idWidth = Math.max('TASK ID'.length, ...printable.map(row => row.id.length))
  const titleWidth = Math.max(
    'TASK'.length,
    ...printable.map(row => row.title.length)
  )
  const lifecycleWidth = Math.max(
    'LIFECYCLE'.length,
    ...printable.map(row => row.lifecycle.length)
  )
  const archiveWidth = Math.max(
    'ARCHIVE'.length,
    ...printable.map(row => row.archive.length)
  )
  io.print(
    `${'TASK ID'.padEnd(idWidth)}  ${'TASK'.padEnd(titleWidth)}  ` +
    `${'LIFECYCLE'.padEnd(lifecycleWidth)}  ` +
    `${'ARCHIVE'.padEnd(archiveWidth)}  PROGRESS`
  )
  io.print(
    `${'-'.repeat(idWidth)}  ${'-'.repeat(titleWidth)}  ` +
    `${'-'.repeat(lifecycleWidth)}  ${'-'.repeat(archiveWidth)}  ` +
    `${'-'.repeat('PROGRESS'.length)}`
  )
  printable.forEach(row => {
    io.print(
      `${row.id.padEnd(idWidth)}  ${row.title.padEnd(titleWidth)}  ` +
      `${row.lifecycle.padEnd(lifecycleWidth)}  ` +
      `${row.archive.padEnd(archiveWidth)}  ${row.progress}`
    )
  })
}
