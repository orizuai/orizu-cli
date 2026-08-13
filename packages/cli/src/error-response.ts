import { sanitizeTerminalText } from './json-response.js'

interface ErrorResponsePayload {
  error?: string
}

const ERROR_BODY_PREVIEW_LIMIT = 180

export function isJsonErrorResponsePayload(
  response: Response,
  payload: unknown
): payload is ErrorResponsePayload & { error: string } {
  const contentType = response.headers.get('content-type') || ''
  return (
    contentType.includes('application/json') &&
    payload !== null &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    typeof (payload as ErrorResponsePayload).error === 'string'
  )
}

function boundedTerminalPreview(value: unknown): string {
  return sanitizeTerminalText(value).slice(0, ERROR_BODY_PREVIEW_LIMIT)
}

export async function extractErrorMessage(response: Response): Promise<string> {
  const rawBody = await response.text()

  try {
    const payload: unknown = JSON.parse(rawBody)
    if (isJsonErrorResponsePayload(response, payload) && payload.error.length > 0) {
      return boundedTerminalPreview(payload.error)
    }
  } catch {
    // Fall through to raw body
  }

  return boundedTerminalPreview(rawBody)
}
