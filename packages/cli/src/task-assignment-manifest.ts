export interface ParsedAssignmentManifestEntry {
  rowId: string
  assignee: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseAssignmentManifestJsonl(
  content: string
): ParsedAssignmentManifestEntry[] {
  // Keep these JSONL field rules in sync with the server's explicitAssignments parser.
  const entries: ParsedAssignmentManifestEntry[] = []
  const lines = content.split(/\r?\n/)

  lines.forEach((line, lineIndex) => {
    const trimmed = line.trim()
    if (!trimmed) {
      return
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
