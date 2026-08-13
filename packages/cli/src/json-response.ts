export function sanitizeTerminalText(value: unknown): string {
  return String(value).replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g,
    ''
  )
}

export async function parseJsonResponse<T>(
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
