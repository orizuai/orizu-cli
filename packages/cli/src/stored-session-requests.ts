import { Cause, Effect, Exit, Result, Schema } from 'effect'

import {
  clearServerCredentialsIfCurrent,
  credentialsEqual,
  getServerCredentials,
  rememberResolvedBearer,
  updateServerCredentialsIfCurrent,
  withCredentialsTransactionLockAsync,
} from './credentials.js'
import { assertSecureTokenTransport, credentialRequestRedirectPolicy } from './http.js'
import { describeLogoutHttpFailure, describeLogoutTransportFailure } from './logout-diagnostic.js'
import { ServerCredentials, SessionServerCredentials } from './types.js'

// Requests signed with a stored login (`orizu login`): the sign-in refresh, the
// request and its one replay after a 401, and logout. Loaded only on that path;
// ORIZU_TOKEN and ORIZU_TOKEN_FILE requests stay in http.ts and never load this.

function isSessionCredentials(credentials: ServerCredentials): credentials is SessionServerCredentials {
  return 'accessToken' in credentials
}

function rememberSessionCredentials(credentials: SessionServerCredentials): SessionServerCredentials {
  rememberResolvedBearer(credentials.accessToken)
  rememberResolvedBearer(credentials.refreshToken)
  return credentials
}

function getAuthorizationToken(credentials: ServerCredentials): string {
  return isSessionCredentials(credentials)
    ? rememberSessionCredentials(credentials).accessToken
    : rememberResolvedBearer(credentials.apiKey)
}

function isExpired(expiresAt: number): boolean {
  const nowUnix = Math.floor(Date.now() / 1000)
  return expiresAt <= nowUnix + 30
}

function boundedTimeoutMs(name: string, fallback: number, maximum: number): number {
  const configured = Number(process.env[name])
  if (!Number.isSafeInteger(configured) || configured <= 0) return fallback
  return Math.min(configured, maximum)
}

const isRedirectRefusal = (error: unknown) => error instanceof TypeError
  && error.cause instanceof Error && /redirect/i.test(error.cause.message)

/** fetch under the CLI's redirect policy, saying so when that policy refused a redirect. */
async function credentialFetch(baseUrl: string, path: string, init: RequestInit): Promise<Response> {
  const policy = credentialRequestRedirectPolicy()
  try {
    return await fetch(`${baseUrl}${path}`, { ...init, ...policy })
  } catch (error) {
    if (policy.redirect === 'error' && isRedirectRefusal(error)) {
      throw new Error(`Refusing to follow a redirect from ${baseUrl} with CLI credentials.`, { cause: error })
    }
    throw error
  }
}

/**
 * Runs `program`, stopped by the caller's signal or `stop`. A stop by either
 * rejects with that signal's reason, as an aborted fetch would.
 */
async function runStoppable<A>(program: Effect.Effect<A, unknown>, ...signals: Array<AbortSignal | null | undefined>): Promise<A> {
  const present = signals.filter((signal): signal is AbortSignal => Boolean(signal))
  const exit = await Effect.runPromiseExit(program, { signal: AbortSignal.any(present) })
  if (Exit.isSuccess(exit)) return exit.value
  const stoppedBy = present.find(signal => signal.aborted)
  if (stoppedBy && Cause.hasInterruptsOnly(exit.cause)) throw stoppedBy.reason
  throw Cause.squash(exit.cause)
}

const RefreshReply = Schema.Struct({
  accessToken: Schema.NonEmptyString,
  refreshToken: Schema.NonEmptyString,
  expiresAt: Schema.Finite,
})

const INVALID_REFRESH = 'Server returned invalid refresh credentials. Run `orizu login` again.'

function refreshRequest(baseUrl: string, credentials: SessionServerCredentials): Effect.Effect<SessionServerCredentials, Error> {
  const timeoutMs = boundedTimeoutMs('ORIZU_CREDENTIALS_REFRESH_TIMEOUT_MS', 10_000, 30_000)
  const refreshToken = rememberResolvedBearer(credentials.refreshToken)
  return Effect.tryPromise({
    try: async signal => {
      const response = await credentialFetch(baseUrl, '/api/cli/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
        signal,
      })
      if (!response.ok) throw new Error('Session expired. Run `orizu login` again.')
      // Reading the body stays under the deadline too.
      try {
        return await response.json() as unknown
      } catch (error) {
        throw error instanceof SyntaxError ? new Error(INVALID_REFRESH) : error
      }
    },
    catch: cause => cause instanceof Error ? cause : new Error(String(cause)),
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () => Effect.fail(new Error(`ORIZU_CREDENTIALS_REFRESH_TIMEOUT: session refresh exceeded ${timeoutMs}ms.`)),
    }),
    Effect.flatMap(data => {
      const decoded = Schema.decodeUnknownResult(RefreshReply)(data)
      if (Result.isFailure(decoded) || decoded.success.expiresAt === 0) return Effect.fail(new Error(INVALID_REFRESH))
      const refreshed = rememberSessionCredentials({ credentialType: 'session', ...decoded.success })
      if (isExpired(refreshed.expiresAt)) {
        return Effect.fail(new Error(
          'ORIZU_CREDENTIALS_REFRESH_UNUSABLE: refreshed session expires within the 30-second safety window.'
        ))
      }
      return Effect.succeed(refreshed)
    }),
  )
}

const LOCK_STOP_SIGNALS = ['SIGINT', 'SIGTERM'] as const

/**
 * Stop handling for the time the credentials lock is held across a refresh.
 * Without it a Ctrl-C ends the CLI with credentials.json.lock left behind, and
 * every later refresh and logout fails until someone deletes it by hand. The
 * handlers are added before the lock is taken and removed after it is
 * released, so no stop lands between the two. A stop aborts the refresh; the
 * lock is released as it unwinds; then the CLI ends by the same signal, unless
 * the caller's own request was cancelled by it: then the command that owns the
 * stop (run-gepa, a download) reports and ends the CLI itself. Other listeners
 * don't count as owners: the git step's listener steps aside whenever another
 * one is present.
 */
function lockStopWindow(callerSignal: AbortSignal | null | undefined) {
  const controller = new AbortController()
  let stoppedBy: NodeJS.Signals | null = null
  const handlers = LOCK_STOP_SIGNALS.map(signal => ({
    signal,
    handle: () => {
      if (stoppedBy) return
      stoppedBy = signal
      controller.abort(new Error(`Session refresh stopped by ${signal}.`))
    },
  }))
  return {
    signal: controller.signal,
    listen(): void { for (const entry of handlers) process.on(entry.signal, entry.handle) },
    unlisten(): void { for (const entry of handlers) process.off(entry.signal, entry.handle) },
    /**
     * After the lock is released and the handlers are gone: end by the stop
     * signal, if there was one. With no listener left the signal ends the CLI
     * at once; a remaining listener gets it when the event loop next polls,
     * which a second check phase is always after. If the CLI is still running
     * then, a listener owns the stop
     * (run-gepa may not have cancelled the request yet), and the refresh fails
     * with the stop as its reason so the command can unwind and end itself.
     */
    async endIfStopped(): Promise<void> {
      if (!stoppedBy || callerSignal?.aborted) return
      process.kill(process.pid, stoppedBy)
      for (let turn = 0; turn < 2; turn += 1) await new Promise(resolve => setImmediate(resolve))
    },
  }
}

interface StoredRefreshResult {
  status: 'refreshed' | 'changed'
  credentials: ServerCredentials | null
}

async function refreshStoredCredentialsIfCurrent(
  baseUrl: string,
  expected: ServerCredentials,
  callerSignal?: AbortSignal | null
): Promise<StoredRefreshResult> {
  if (!isSessionCredentials(expected)) {
    throw new Error('API key credentials do not refresh. Run `orizu login` again if access fails.')
  }
  assertSecureTokenTransport(baseUrl)
  const stop = lockStopWindow(callerSignal)
  stop.listen()
  try {
    return await withCredentialsTransactionLockAsync(async () => {
      const current = getServerCredentials(baseUrl)
      if (!current || !credentialsEqual(current, expected)) {
        return { status: 'changed', credentials: current }
      }
      const refreshed = await runStoppable(refreshRequest(baseUrl, expected), callerSignal, stop.signal)
      // Written inside the lock's own async context, never from the Effect fiber.
      if (!updateServerCredentialsIfCurrent(baseUrl, expected, refreshed)) {
        return { status: 'changed', credentials: getServerCredentials(baseUrl) }
      }
      return { status: 'refreshed', credentials: refreshed }
    })
  } finally {
    stop.unlisten()
    await stop.endIfStopped()
  }
}

function requireCurrentCredentials(baseUrl: string, credentials: ServerCredentials | null): ServerCredentials {
  if (credentials) return credentials
  throw new Error(`Not logged in for ${baseUrl}. Run \`orizu login --server ${baseUrl}\` (or \`--local\`) first.`)
}

/**
 * Marks an error raised after the server answered 401 and before the request
 * was sent again: the server refused the request, so nothing was written
 * (ORI-2431). The message is unchanged.
 */
function markRequestRejected(error: unknown): unknown {
  if (error instanceof Error && Object.isExtensible(error)) Object.assign(error, { requestRejected: true })
  return error
}

export interface StoredRequestOptions {
  baseUrl: string
  credentials: ServerCredentials
  allowRefresh: boolean
  /** Messages when another login replaced the stored one, before the first request and before the replay. */
  changedBeforeRequest: string
  changedBeforeReplay: string
  /** Called with each refreshed login as soon as it is stored, even if the send after it fails. */
  onRefreshed?: (credentials: ServerCredentials) => void
}

/**
 * Refresh first when the login has expired, then send. On a 401, refresh once
 * and send once more, only if the stored login is still the one this request
 * used. `onRequestStart` runs before each send, never for the refresh.
 */
export async function storedRequest(
  options: StoredRequestOptions,
  path: string,
  init: RequestInit,
  onRequestStart?: () => void
): Promise<Response> {
  const { baseUrl } = options
  let credentials = options.credentials
  const refresh = async (changedMessage: string) => {
    const result = await refreshStoredCredentialsIfCurrent(baseUrl, credentials, init.signal)
    if (result.status === 'changed') throw new Error(changedMessage)
    credentials = requireCurrentCredentials(baseUrl, result.credentials)
    options.onRefreshed?.(credentials)
  }
  const send = () => {
    onRequestStart?.()
    return credentialFetch(baseUrl, path, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${getAuthorizationToken(credentials)}` },
    })
  }

  let didRefresh = false
  if (options.allowRefresh && isSessionCredentials(credentials) && isExpired(credentials.expiresAt)) {
    await refresh(options.changedBeforeRequest)
    didRefresh = true
  }
  let response = await send()
  if (options.allowRefresh && response.status === 401 && isSessionCredentials(credentials) && !didRefresh) {
    try {
      await refresh(options.changedBeforeReplay)
    } catch (error) {
      // A stop by the caller's own signal is the caller's to describe.
      throw error === init.signal?.reason ? error : markRequestRejected(error)
    }
    response = await send()
  }
  return response
}

export interface LogoutResult {
  remoteError: string | null
  localCredentialCleared: boolean
}

/**
 * Revoke the login on the server within ORIZU_LOGOUT_TIMEOUT_MS, then remove it
 * locally only if it is still the stored one: another login saved meanwhile is kept.
 */
export async function storedLogout(
  baseUrl: string,
  credentialKey: string,
  credentials: ServerCredentials,
  callerSignal?: AbortSignal | null
): Promise<LogoutResult> {
  const authorizationToken = getAuthorizationToken(credentials)
  const refreshToken = isSessionCredentials(credentials) ? rememberResolvedBearer(credentials.refreshToken) : null
  const secrets = [authorizationToken, ...(refreshToken !== null ? [refreshToken] : [])]
  const timeoutMs = boundedTimeoutMs('ORIZU_LOGOUT_TIMEOUT_MS', 10_000, 30_000)
  const timeoutError = Object.assign(new Error(`ORIZU_LOGOUT_TIMEOUT: remote logout exceeded ${timeoutMs}ms.`), { name: 'TimeoutError' })
  const remote = Effect.tryPromise({
    try: async signal => {
      assertSecureTokenTransport(baseUrl)
      const response = await credentialFetch(baseUrl, '/api/cli/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authorizationToken}` },
        body: refreshToken !== null ? JSON.stringify({ refreshToken }) : undefined,
        signal,
      })
      return response.ok ? null : await describeLogoutHttpFailure(response, secrets)
    },
    catch: error => error,
  }).pipe(Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.fail(timeoutError) }))

  let remoteError: string | null
  try {
    remoteError = await runStoppable(remote, callerSignal)
  } catch (error) {
    remoteError = describeLogoutTransportFailure(error, secrets)
  }
  const localCredentialCleared = clearServerCredentialsIfCurrent(credentialKey, credentials)
  return { remoteError, localCredentialCleared }
}
