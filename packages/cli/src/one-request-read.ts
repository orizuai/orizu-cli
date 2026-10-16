import { datasetTransferTimeoutMs } from './dataset-transfer-policy.js'
import { resolveEnvBearerToken } from './credentials.js'
import { authedFetch } from './http.js'
import { parseJsonResponse } from './json-response.js'
import { unreachedCode } from './request-outcome.js'

// ORI-2725: one CLI read sent as one request, with a time limit that covers the
// reply's body too, and, for a person signed in at a terminal, Ctrl-C and
// SIGTERM handling. The read twin of `one-request-write.ts`.

export interface OneRequestRead {
  /** For example "Failed to fetch tasks": every failure starts `Failed to fetch tasks:`. */
  failed: string
  /** For example "Tasks list": Ctrl-C prints `Tasks list interrupted.`, a broken 200 is named by it. */
  name: string
  path: string
  /**
   * A reply the server refused. `text` is the body when it is JSON, otherwise
   * a sentence naming the page, so a gateway's HTML is never printed. Throws.
   * The default is `<failed>: <text>`; `tasks status` also prints its `--json` object.
   */
  refused?: (status: number, text: string) => never
  /** A refusal whose body is JSON, in the command's own words (for example `Manifest list failed (403): …`). */
  refusedMessage?: (response: Response) => string | Promise<string>
  /** Stands in for `authedFetch` where a command takes an injected fetcher. */
  fetcher?: (path: string, init: RequestInit) => Promise<Response>
  /** The reply is bytes (an artifact zip), not JSON. Set by `readOneBytes`. */
  bytes?: boolean
}

// Node's fetch reports a connection cut before or during the reply this way.
const isCutConnection = (error: unknown) => error instanceof TypeError && (error.message === 'fetch failed' || error.message === 'terminated')

function namedNetworkFailure(read: OneRequestRead, error: unknown): unknown {
  const code = unreachedCode(error)
  if (code) return new Error(`${read.failed}: could not reach the server (${code})`)
  if (isCutConnection(error)) return new Error(`${read.failed}: the connection closed before the reply arrived`)
  return error
}

/** Sends the read and reads its reply under `signal`. Exported for the stored-login runner only. */
export async function sendOneRequestRead<T>(read: OneRequestRead, signal: AbortSignal): Promise<T> {
  let response: Response
  let raw: Uint8Array
  try {
    response = await (read.fetcher ?? authedFetch)(read.path, { signal })
    raw = new Uint8Array(await response.arrayBuffer())
  } catch (error) {
    // A stop or the time limit is reported by the caller.
    if (signal.aborted) throw error
    throw namedNetworkFailure(read, error)
  }
  const text = new TextDecoder().decode(raw)
  if (!response.ok) {
    let isJson = true
    try { JSON.parse(text) } catch { isJson = false }
    const reason = isJson ? text : `the server returned a page that isn't JSON (status ${response.status})`
    if (read.refused) read.refused(response.status, reason)
    if (isJson && read.refusedMessage) throw new Error(await read.refusedMessage(new Response(text, { status: response.status, headers: response.headers })))
    throw new Error(`${read.failed}: ${reason}`)
  }
  if (read.bytes) return raw as T
  return await parseJsonResponse<T>(new Response(text, { status: response.status, headers: response.headers }), read.name)
}

export const deadlineMessage = (read: OneRequestRead) => `${read.failed}: the request exceeded its deadline`

/**
 * Sends one read and returns its parsed reply, or null when a person stopped
 * it with Ctrl-C or SIGTERM (the stop is already reported and the exit code
 * set). Any other failure throws with the command's own words.
 */
export async function readOne<T>(read: OneRequestRead): Promise<T | null> {
  return await readWith<T>(read, true)
}

/** `readOne` for a reply that is bytes (ORI-1105 V3: an artifact zip). */
export async function readOneBytes(read: Omit<OneRequestRead, 'bytes'>): Promise<Uint8Array | null> {
  return await readWith<Uint8Array>({ ...read, bytes: true }, true)
}

/**
 * The same read inside a longer command (a picker before the command's own
 * request): the time limit and messages, but Ctrl-C keeps Node's default stop,
 * as the team and project lookup does.
 */
export async function readOneWithoutStops<T>(read: OneRequestRead): Promise<T> {
  return (await readWith<T>(read, false)) as T
}

async function readWith<T>(read: OneRequestRead, stops: boolean): Promise<T | null> {
  const timeoutMs = datasetTransferTimeoutMs()
  // A bearer from ORIZU_TOKEN / ORIZU_TOKEN_FILE is how hosted sessions run the
  // CLI. That path keeps a plain time limit: no Effect (about 120 ms to load
  // per command) and no signal handlers, since the hosted loop ends the process
  // itself and nobody presses Ctrl-C there. The same exception ORI-2423 made
  // for the team and project lookup (hosted checklist items 2 and 5).
  if (resolveEnvBearerToken()) {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
    try {
      return await sendOneRequestRead<T>(read, controller.signal)
    } catch (error) {
      if (timedOut) throw new Error(deadlineMessage(read))
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
  const { runOneRequestRead } = await import('./one-request-read-run.js')
  return await runOneRequestRead<T>(read, timeoutMs, stops)
}
