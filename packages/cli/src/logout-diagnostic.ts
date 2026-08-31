import { sanitizeHumanInlineText, sanitizeTerminalText } from './json-response.js'
import { redactSecrets } from './secret-redaction.js'

export const LOGOUT_DIAGNOSTIC_LIMIT = 180

function boundedLogoutDiagnostic(value: string, secrets: readonly string[]): string {
  const bounded = sanitizeTerminalText(redactSecrets(value, { secrets }))
    .slice(0, LOGOUT_DIAGNOSTIC_LIMIT)
  return sanitizeHumanInlineText(sanitizeTerminalText, bounded).slice(0, LOGOUT_DIAGNOSTIC_LIMIT)
}

export async function describeLogoutHttpFailure(
  response: Response,
  secrets: readonly string[]
): Promise<string> {
  let body = ''
  try {
    body = await response.text()
  } catch (error) {
    return describeLogoutTransportFailure(error, secrets, `HTTP ${response.status} body error`)
  }
  const detail = body.trim()
  return boundedLogoutDiagnostic(
    detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status}`,
    secrets
  )
}

export function describeLogoutTransportFailure(
  error: unknown,
  secrets: readonly string[],
  prefix?: string
): string {
  const message = error instanceof Error ? error.message : String(error)
  const isTimeout = error instanceof Error
    && (error.name === 'AbortError' || error.name === 'TimeoutError')
  const label = prefix ?? (isTimeout ? 'Timeout' : 'Network error')
  return boundedLogoutDiagnostic(`${label}: ${message || 'remote logout failed'}`, secrets)
}
