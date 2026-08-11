import { randomUUID } from 'crypto'

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type StartIntentIdGenerator = () => string

/** A tiny immediate retry budget for outcomes where the server/provider may
 *  have committed before the HTTP response was lost. The UUID intent makes
 *  these retries safe; this is recovery, not general availability backoff. */
export const START_RESPONSE_LOSS_MAX_RETRIES = 2

export function isAmbiguousStartResponseStatus(
  status: number
): boolean {
  return (
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  )
}

export function isStartIntentId(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value)
}

/** Mint and validate before the first network mutation. Injection keeps retry
 *  identity tests deterministic and prevents a broken generator from sending a
 *  malformed key that the server might treat as a non-idempotent legacy call. */
export function createStartIntentId(
  generate: StartIntentIdGenerator = randomUUID
): string {
  const value = generate()
  if (!isStartIntentId(value)) {
    throw new Error(
      'session start intent generator must return a UUIDv4'
    )
  }
  return value
}
