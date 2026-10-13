import { isJsonErrorResponsePayload } from './error-response.js'

// The request never reached a server, so nothing can have been written.
const UNREACHED_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'])

/** The app's own `{ error }` message, or null when the reply isn't the app's JSON. */
export async function appErrorOf(response: Response): Promise<string | null> {
  try {
    const payload: unknown = await response.json()
    return isJsonErrorResponsePayload(response, payload) ? payload.error : null
  } catch {
    return null
  }
}

// fetch reports a refused connection as `fetch failed` with the reason in
// `cause`. For a name with several addresses (localhost) the cause is an
// AggregateError that carries the same code itself.
/** The code when the request never reached a server, otherwise null. */
export function unreachedCode(error: unknown): string | null {
  let current = error
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth += 1) {
    const { code, cause } = current as { code?: unknown; cause?: unknown }
    if (typeof code === 'string' && UNREACHED_CODES.has(code)) return code
    current = cause
  }
  return null
}
