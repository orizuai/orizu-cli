import { readFileSync, statSync } from 'node:fs'

export interface ParsedAssignmentManifestEntry {
  rowId: string
  assignee: string
}

export interface AssignmentManifestLimits {
  maxBytes?: number
  maxLines?: number
}

export const DEFAULT_ASSIGNMENT_MANIFEST_LIMITS = {
  maxBytes: 5 * 1024 * 1024,
  maxLines: 100_000,
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formatLimit(value: number): string {
  return value.toLocaleString('en-US')
}

function resolveLimits(
  limits: AssignmentManifestLimits = {}
): Required<AssignmentManifestLimits> {
  return {
    maxBytes: limits.maxBytes ?? DEFAULT_ASSIGNMENT_MANIFEST_LIMITS.maxBytes,
    maxLines: limits.maxLines ?? DEFAULT_ASSIGNMENT_MANIFEST_LIMITS.maxLines,
  }
}

function assertAssignmentManifestSize(
  bytes: number,
  limits: AssignmentManifestLimits = {}
) {
  const resolvedLimits = resolveLimits(limits)
  if (bytes > resolvedLimits.maxBytes) {
    throw new Error(
      `Assignment manifest file is ${formatLimit(bytes)} bytes; maximum supported size is ${formatLimit(resolvedLimits.maxBytes)} bytes`
    )
  }
}

function assertAssignmentManifestLimits(
  content: string,
  limits: AssignmentManifestLimits = {}
) {
  const resolvedLimits = resolveLimits(limits)
  assertAssignmentManifestSize(Buffer.byteLength(content, 'utf8'), resolvedLimits)
  return resolvedLimits
}

export function parseAssignmentManifestJsonl(
  content: string,
  limits?: AssignmentManifestLimits
): ParsedAssignmentManifestEntry[] {
  const resolvedLimits = assertAssignmentManifestLimits(content, limits)

  // Keep these JSONL field rules in sync with the server's explicitAssignments parser.
  const entries: ParsedAssignmentManifestEntry[] = []
  let records = 0
  const lines = content.split(/\r?\n/)

  lines.forEach((line, lineIndex) => {
    const trimmed = line.trim()
    if (!trimmed) {
      return
    }

    records += 1
    if (records > resolvedLimits.maxLines) {
      throw new Error(
        `Assignment manifest has ${formatLimit(records)} non-empty assignment records; maximum supported record count is ${formatLimit(resolvedLimits.maxLines)}`
      )
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (_error) {
      throw new Error(
        `Assignment manifest line ${lineIndex + 1} is not valid JSON`
      )
    }

    if (!isRecord(parsed)) {
      throw new Error(
        `Assignment manifest line ${lineIndex + 1} must be a JSON object`
      )
    }

    const rowId = typeof parsed.rowId === 'string' ? parsed.rowId.trim() : ''
    if (!rowId) {
      throw new Error(
        `Assignment manifest line ${lineIndex + 1} must include a non-empty rowId`
      )
    }

    const hasAssignee = Object.hasOwn(parsed, 'assignee')
    const hasAssignees = Object.hasOwn(parsed, 'assignees')

    if (hasAssignee && hasAssignees) {
      throw new Error(
        `Assignment manifest line ${lineIndex + 1} must provide either assignee or assignees, not both`
      )
    }

    if (hasAssignee) {
      const assignee =
        typeof parsed.assignee === 'string' ? parsed.assignee.trim() : ''
      if (!assignee) {
        throw new Error(
          `Assignment manifest line ${lineIndex + 1} assignee must be a non-empty string`
        )
      }
      entries.push({ rowId, assignee })
      return
    }

    if (hasAssignees) {
      if (!Array.isArray(parsed.assignees) || parsed.assignees.length === 0) {
        throw new Error(
          `Assignment manifest line ${lineIndex + 1} assignees must be a non-empty string array`
        )
      }

      parsed.assignees.forEach((assigneeValue, assigneeIndex) => {
        const assignee =
          typeof assigneeValue === 'string' ? assigneeValue.trim() : ''
        if (!assignee) {
          throw new Error(
            `Assignment manifest line ${lineIndex + 1} assignees[${assigneeIndex}] must be a non-empty string`
          )
        }
        entries.push({ rowId, assignee })
      })
      return
    }

    throw new Error(
      `Assignment manifest line ${lineIndex + 1} must include assignee or assignees`
    )
  })

  if (entries.length === 0) {
    throw new Error('Assignment manifest must contain at least one assignment')
  }

  return entries
}

export function readAssignmentManifestJsonlFile(
  path: string,
  limits?: AssignmentManifestLimits
): ParsedAssignmentManifestEntry[] {
  const stats = statSync(path)
  assertAssignmentManifestSize(stats.size, limits)

  const content = readFileSync(path, 'utf8')
  return parseAssignmentManifestJsonl(content, limits)
}
