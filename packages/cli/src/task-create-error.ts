export interface TaskCreateErrorPayload {
  error?: string
  invalidAssigneeErrors?: Array<{
    assignee?: string
    reason?: string
  }>
  missingRequiredFields?: string[]
  incompatibleRowCount?: number
  missingRequiredFieldCounts?: Record<string, number>
  versionId?: string
  versionNum?: number
}

export interface CliErrorWithStatus extends Error {
  httpStatus?: number
  structuredPayload?: Record<string, unknown>
}

function createCliError(
  message: string,
  httpStatus?: number,
  structuredPayload?: Record<string, unknown>
): CliErrorWithStatus {
  const error = new Error(message) as CliErrorWithStatus
  error.httpStatus = httpStatus
  error.structuredPayload = structuredPayload
  return error
}

export async function formatTaskCreateError(response: Response): Promise<CliErrorWithStatus> {
  const contentType = response.headers.get('content-type') || ''
  const rawBody = await response.text()
  const httpStatus = response.status
  let parsedPayload: Record<string, unknown> | undefined

  if (!contentType.includes('application/json')) {
    return createCliError(`Failed to create task: ${rawBody}`, httpStatus)
  }

  try {
    const payload = JSON.parse(rawBody) as TaskCreateErrorPayload
    parsedPayload = payload as unknown as Record<string, unknown>

    if (
      Array.isArray(payload.invalidAssigneeErrors) &&
      payload.invalidAssigneeErrors.length > 0
    ) {
      const details = payload.invalidAssigneeErrors
        .filter(
          item =>
            typeof item.assignee === 'string' &&
            item.assignee.length > 0 &&
            typeof item.reason === 'string' &&
            item.reason.length > 0
        )
        .map(item => `  - ${item.assignee}: ${item.reason}`)
        .join('\n')

      if (details) {
        return createCliError(
          `Failed to create task: ${payload.error || 'Invalid assignees'}\n${details}`,
          httpStatus,
          parsedPayload
        )
      }
    }

    if (
      Array.isArray(payload.missingRequiredFields) &&
      payload.missingRequiredFields.length > 0
    ) {
      const lines: string[] = [
        `Failed to create task: ${payload.error || 'Dataset incompatible'}`,
      ]

      if (payload.versionNum !== undefined) {
        lines.push(`  Version: v${payload.versionNum} (${payload.versionId || 'unknown'})`)
      }

      lines.push(`  Missing required fields: ${payload.missingRequiredFields.join(', ')}`)

      if (typeof payload.incompatibleRowCount === 'number') {
        lines.push(`  Incompatible rows: ${payload.incompatibleRowCount}`)
      }

      if (
        payload.missingRequiredFieldCounts &&
        Object.keys(payload.missingRequiredFieldCounts).length > 0
      ) {
        const fieldCounts = Object.entries(payload.missingRequiredFieldCounts)
          .map(([field, count]) => `    ${field}: ${count} rows`)
          .join('\n')
        lines.push(`  Missing field counts:\n${fieldCounts}`)
      }

      return createCliError(
        lines.join('\n'),
        httpStatus,
        parsedPayload
      )
    }

    if (typeof payload.error === 'string' && payload.error.length > 0) {
      return createCliError(
        `Failed to create task: ${payload.error}`,
        httpStatus,
        parsedPayload
      )
    }
  } catch {
    return createCliError(`Failed to create task: ${rawBody}`, httpStatus)
  }

  return createCliError(`Failed to create task: ${rawBody}`, httpStatus, parsedPayload)
}
