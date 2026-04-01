interface ErrorResponsePayload {
  error?: string
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
        return payload.error
      }
    } catch {
      // Fall through to raw body
    }
  }

  return rawBody
}
