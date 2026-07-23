interface ErrorResponsePayload {
  error?: string
}

const ERROR_BODY_PREVIEW_LIMIT = 180

function boundedTerminalPreview(value: unknown): string {
  return String(value)
    .replace(
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g,
      ''
    )
    .slice(0, ERROR_BODY_PREVIEW_LIMIT)
}

export async function extractErrorMessage(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') || ''
  const rawBody = await response.text()

  if (contentType.includes('application/json')) {
    try {
      const payload = JSON.parse(rawBody) as ErrorResponsePayload | null
      if (
        payload &&
        typeof payload === 'object' &&
        !Array.isArray(payload) &&
        typeof payload.error === 'string' &&
        payload.error.length > 0
      ) {
        return boundedTerminalPreview(payload.error)
      }
    } catch {
      // Fall through to raw body
    }
  }

  return boundedTerminalPreview(rawBody)
}
