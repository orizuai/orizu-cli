import {
  clearServerCredentialsIfCurrent,
  credentialsEqual,
  getActiveBaseUrl,
  getServerCredentials,
  resolveEnvBearerToken,
  updateServerCredentialsIfCurrent,
  withCredentialsTransactionLockAsync,
} from './credentials.js'
import { getFlagBaseUrl, GlobalFlags, normalizeBaseUrl } from './global-flags.js'
import {
  describeLogoutHttpFailure,
  describeLogoutTransportFailure,
} from './logout-diagnostic.js'
import { LoginResponse, ServerCredentials, SessionServerCredentials } from './types.js'

let runtimeFlags: GlobalFlags = { local: false, server: null }

export function setGlobalFlags(flags: GlobalFlags) {
  runtimeFlags = flags
}

export function resolveBaseUrl(flags: GlobalFlags = runtimeFlags): string {
  const fromFlags = getFlagBaseUrl(flags)
  if (fromFlags) {
    return fromFlags
  }

  const fromEnv = process.env.ORIZU_BASE_URL
  if (fromEnv) {
    return normalizeBaseUrl(fromEnv)
  }

  const fromStored = getActiveBaseUrl()
  if (fromStored) {
    return fromStored
  }

  return 'https://orizu.ai'
}

export function resolveLoginBaseUrl(flags: GlobalFlags = runtimeFlags): string {
  const fromFlags = getFlagBaseUrl(flags)
  if (fromFlags) {
    return fromFlags
  }

  const fromEnv = process.env.ORIZU_BASE_URL
  if (fromEnv) {
    return normalizeBaseUrl(fromEnv)
  }

  return 'https://orizu.ai'
}

export function getBaseUrl(): string {
  return resolveBaseUrl()
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return (
    normalized === 'localhost' ||
    normalized === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  )
}

export function assertSecureTokenTransport(baseUrl: string) {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new Error(`Invalid server URL: '${baseUrl}'`)
  }

  if (parsed.protocol === 'https:') {
    return
  }

  if (parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname)) {
    return
  }

  throw new Error(
    `Refusing to send CLI tokens to ${baseUrl}. Use HTTPS, or --local for loopback development.`
  )
}

function isSessionCredentials(credentials: ServerCredentials): credentials is SessionServerCredentials {
  return 'accessToken' in credentials
}

function getAuthorizationToken(credentials: ServerCredentials): string {
  return isSessionCredentials(credentials) ? credentials.accessToken : credentials.apiKey
}

function isExpired(expiresAt: number): boolean {
  const nowUnix = Math.floor(Date.now() / 1000)
  return expiresAt <= nowUnix + 30
}

const DEFAULT_CREDENTIALS_REFRESH_TIMEOUT_MS = 10_000
const MAX_CREDENTIALS_REFRESH_TIMEOUT_MS = 30_000
const DEFAULT_LOGOUT_TIMEOUT_MS = 10_000
const MAX_LOGOUT_TIMEOUT_MS = 30_000

function getCredentialsRefreshTimeoutMs(): number {
  const configured = Number(process.env.ORIZU_CREDENTIALS_REFRESH_TIMEOUT_MS)
  if (!Number.isSafeInteger(configured) || configured <= 0) {
    return DEFAULT_CREDENTIALS_REFRESH_TIMEOUT_MS
  }
  return Math.min(configured, MAX_CREDENTIALS_REFRESH_TIMEOUT_MS)
}

function getLogoutTimeoutMs(): number {
  const configured = Number(process.env.ORIZU_LOGOUT_TIMEOUT_MS)
  if (!Number.isSafeInteger(configured) || configured <= 0) {
    return DEFAULT_LOGOUT_TIMEOUT_MS
  }
  return Math.min(configured, MAX_LOGOUT_TIMEOUT_MS)
}

async function withAbortDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  callerSignal: AbortSignal | null | undefined,
  timeoutMs: number,
  timeoutError: Error
): Promise<T> {
  const controller = new AbortController()
  const handleCallerAbort = () => controller.abort(callerSignal?.reason)
  if (callerSignal?.aborted) handleCallerAbort()
  else callerSignal?.addEventListener('abort', handleCallerAbort, { once: true })

  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs)
  const cancellation = new Promise<never>((_resolve, reject) => {
    const handleAbort = () => reject(controller.signal.reason ?? new Error('Request aborted.'))
    if (controller.signal.aborted) handleAbort()
    else controller.signal.addEventListener('abort', handleAbort, { once: true })
  })

  try {
    return await Promise.race([operation(controller.signal), cancellation])
  } finally {
    clearTimeout(timer)
    callerSignal?.removeEventListener('abort', handleCallerAbort)
  }
}

async function withCredentialsRefreshDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  callerSignal?: AbortSignal | null
): Promise<T> {
  const timeoutMs = getCredentialsRefreshTimeoutMs()
  const timeoutError = new Error(
    `ORIZU_CREDENTIALS_REFRESH_TIMEOUT: session refresh exceeded ${timeoutMs}ms.`
  )
  return await withAbortDeadline(operation, callerSignal, timeoutMs, timeoutError)
}

async function withLogoutDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  callerSignal?: AbortSignal | null
): Promise<T> {
  const timeoutMs = getLogoutTimeoutMs()
  const timeoutError = new Error(
    `ORIZU_LOGOUT_TIMEOUT: remote logout exceeded ${timeoutMs}ms.`
  )
  timeoutError.name = 'TimeoutError'
  return await withAbortDeadline(operation, callerSignal, timeoutMs, timeoutError)
}

export function credentialRequestRedirectPolicy(): Pick<RequestInit, 'redirect'> {
  return process.env.ORIZU_CLI_AUTH_REDIRECT === 'error' ? { redirect: 'error' } : {}
}

async function refreshCredentials(
  baseUrl: string,
  credentials: ServerCredentials,
  callerSignal?: AbortSignal | null
): Promise<ServerCredentials> {
  if (!isSessionCredentials(credentials)) {
    throw new Error('API key credentials do not refresh. Run `orizu login` again if access fails.')
  }

  assertSecureTokenTransport(baseUrl)
  const data = await withCredentialsRefreshDeadline(async signal => {
    const response = await fetch(`${baseUrl}/api/cli/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: credentials.refreshToken }),
      ...credentialRequestRedirectPolicy(),
      signal,
    })

    if (!response.ok) {
      throw new Error('Session expired. Run `orizu login` again.')
    }
    return await response.json() as LoginResponse
  }, callerSignal)
  if (!data.accessToken || !data.refreshToken || !data.expiresAt) {
    throw new Error('Server returned invalid refresh credentials. Run `orizu login` again.')
  }

  const refreshed = {
    credentialType: 'session' as const,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresAt: data.expiresAt,
  }
  if (isExpired(refreshed.expiresAt)) {
    throw new Error(
      'ORIZU_CREDENTIALS_REFRESH_UNUSABLE: refreshed session expires within the 30-second safety window.'
    )
  }
  return refreshed
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
  return await withCredentialsTransactionLockAsync(async () => {
    const current = getServerCredentials(baseUrl)
    if (!current || !credentialsEqual(current, expected)) {
      return { status: 'changed', credentials: current }
    }

    const refreshed = await refreshCredentials(baseUrl, expected, callerSignal)
    if (!updateServerCredentialsIfCurrent(baseUrl, expected, refreshed)) {
      return { status: 'changed', credentials: getServerCredentials(baseUrl) }
    }
    return { status: 'refreshed', credentials: refreshed }
  })
}

function requireCurrentCredentials(baseUrl: string, credentials: ServerCredentials | null): ServerCredentials {
  if (credentials) return credentials
  throw new Error(`Not logged in for ${baseUrl}. Run \`orizu login --server ${baseUrl}\` (or \`--local\`) first.`)
}

interface ResolvedStoredCredentials {
  credentials: ServerCredentials
  didRefresh: boolean
}

async function refreshExpiredStoredCredentials(
  baseUrl: string,
  initial: ServerCredentials,
  callerSignal?: AbortSignal | null
): Promise<ResolvedStoredCredentials> {
  if (!isSessionCredentials(initial) || !isExpired(initial.expiresAt)) {
    return { credentials: initial, didRefresh: false }
  }
  const result = await refreshStoredCredentialsIfCurrent(baseUrl, initial, callerSignal)
  if (result.status === 'changed') {
    throw new Error(
      'ORIZU_AUTH_CONTEXT_CHANGED: stored credentials changed before this request began; the request was not sent.'
    )
  }
  return {
    credentials: requireCurrentCredentials(baseUrl, result.credentials),
    didRefresh: true,
  }
}

export type AuthenticatedRequestSource = 'ORIZU_TOKEN' | 'ORIZU_TOKEN_FILE' | 'stored'

export interface AuthenticatedRequestContext {
  readonly baseUrl: string
  readonly source: AuthenticatedRequestSource
  fetch(path: string, init?: RequestInit): Promise<Response>
  logout(signal?: AbortSignal | null): Promise<LogoutResult>
}

export interface LogoutResult {
  remoteError: string | null
  localCredentialCleared: boolean
}

/**
 * Captures one authenticated server context for a multi-step operation. The
 * returned interface intentionally exposes no credential material: its closure
 * pins the selected origin and bearer/session so later global config changes
 * cannot move an in-flight operation to another account.
 */
export function captureAuthenticatedRequestContext(
  options: { allowRefresh?: boolean } = {}
): AuthenticatedRequestContext {
  const baseUrl = resolveBaseUrl()
  const allowRefresh = options.allowRefresh ?? true
  assertSecureTokenTransport(baseUrl)

  const envBearer = resolveEnvBearerToken()
  if (envBearer) {
    const explicitBearer = process.env.ORIZU_TOKEN?.trim() || null
    const source: AuthenticatedRequestSource = explicitBearer
      ? 'ORIZU_TOKEN'
      : 'ORIZU_TOKEN_FILE'
    const resolveRequestBearer = (): string => {
      if (explicitBearer) return explicitBearer
      try {
        const currentBearer = resolveEnvBearerToken()
        if (currentBearer) return currentBearer
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`${detail} Fix, rotate, or unset ORIZU_TOKEN_FILE and rerun \`orizu setup\`.`)
      }
      throw new Error('ORIZU_TOKEN_FILE no longer supplies a token. Fix, rotate, or unset ORIZU_TOKEN_FILE and rerun `orizu setup`.')
    }
    return {
      baseUrl,
      source,
      async fetch(path: string, init: RequestInit = {}) {
        return await fetch(`${baseUrl}${path}`, {
          ...init,
          headers: {
            ...(init.headers || {}),
            Authorization: `Bearer ${resolveRequestBearer()}`,
          },
          ...credentialRequestRedirectPolicy(),
        })
      },
      async logout() {
        throw new Error(`Authentication is supplied by ${source}; stored logout is unavailable.`)
      },
    }
  }

  const capturedCredentials = getServerCredentials(baseUrl)
  if (!capturedCredentials) {
    throw new Error(`Not logged in for ${baseUrl}. Run \`orizu login --server ${baseUrl}\` (or \`--local\`) first.`)
  }
  let activeCredentials = capturedCredentials

  async function refreshCapturedCredentials(callerSignal?: AbortSignal | null): Promise<void> {
    const result = await refreshStoredCredentialsIfCurrent(baseUrl, activeCredentials, callerSignal)
    if (result.status === 'changed') {
      throw new Error(
        'ORIZU_CREDENTIALS_CHANGED: stored credentials changed before the captured session could refresh. Reconfirm the account and retry.'
      )
    }
    activeCredentials = requireCurrentCredentials(baseUrl, result.credentials)
  }

  return {
    baseUrl,
    source: 'stored',
    async fetch(path: string, init: RequestInit = {}) {
      let didRefresh = false
      if (
        allowRefresh
        && isSessionCredentials(activeCredentials)
        && isExpired(activeCredentials.expiresAt)
      ) {
        await refreshCapturedCredentials(init.signal)
        didRefresh = true
      }

      let response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
          ...(init.headers || {}),
          Authorization: `Bearer ${getAuthorizationToken(activeCredentials)}`,
        },
        ...credentialRequestRedirectPolicy(),
      })

      if (
        allowRefresh
        && response.status === 401
        && isSessionCredentials(activeCredentials)
        && !didRefresh
      ) {
        await refreshCapturedCredentials(init.signal)
        response = await fetch(`${baseUrl}${path}`, {
          ...init,
          headers: {
            ...(init.headers || {}),
            Authorization: `Bearer ${getAuthorizationToken(activeCredentials)}`,
          },
          ...credentialRequestRedirectPolicy(),
        })
      }
      return response
    },
    async logout(callerSignal?: AbortSignal | null) {
      const authorizationToken = getAuthorizationToken(activeCredentials)
      const secrets = [
        authorizationToken,
        ...(isSessionCredentials(activeCredentials) ? [activeCredentials.refreshToken] : []),
      ]
      let remoteLogoutReason: string | null = null
      try {
        remoteLogoutReason = await withLogoutDeadline(async signal => {
          const response = await fetch(`${baseUrl}/api/cli/auth/logout`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${authorizationToken}`,
            },
            body: isSessionCredentials(activeCredentials)
              ? JSON.stringify({ refreshToken: activeCredentials.refreshToken })
              : undefined,
            ...credentialRequestRedirectPolicy(),
            signal,
          })
          return response.ok ? null : await describeLogoutHttpFailure(response, secrets)
        }, callerSignal)
      } catch (error) {
        remoteLogoutReason = describeLogoutTransportFailure(error, secrets)
      }
      const localCredentialCleared = clearServerCredentialsIfCurrent(baseUrl, activeCredentials)
      return { remoteError: remoteLogoutReason, localCredentialCleared }
    },
  }
}

export async function authedFetch(path: string, init: RequestInit = {}) {
  const baseUrl = resolveBaseUrl()
  assertSecureTokenTransport(baseUrl)

  // In-sandbox pre-auth (ALI-1044): a bearer supplied via ORIZU_TOKEN /
  // ORIZU_TOKEN_FILE takes precedence over credentials.json. It is externally
  // managed (the hosted loop rotates the token file), so it is read FRESH here on
  // every request and NEVER refreshed by this client — on a 401 the loop rotates
  // the file and the next request naturally picks up the new bearer.
  const envBearer = resolveEnvBearerToken()
  if (envBearer) {
    return await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.headers || {}),
        Authorization: `Bearer ${envBearer}`,
      },
      ...credentialRequestRedirectPolicy(),
    })
  }

  const credentials = getServerCredentials(baseUrl)
  if (!credentials) {
    throw new Error(`Not logged in for ${baseUrl}. Run \`orizu login --server ${baseUrl}\` (or \`--local\`) first.`)
  }

  const resolved = await refreshExpiredStoredCredentials(baseUrl, credentials, init.signal)
  let activeCredentials = resolved.credentials

  let response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${getAuthorizationToken(activeCredentials)}`,
    },
    ...credentialRequestRedirectPolicy(),
  })

  if (
    response.status === 401
    && isSessionCredentials(activeCredentials)
    && !resolved.didRefresh
  ) {
    const refreshResult = await refreshStoredCredentialsIfCurrent(
      baseUrl,
      activeCredentials,
      init.signal
    )
    if (refreshResult.status === 'changed') {
      throw new Error(
        'ORIZU_AUTH_CONTEXT_CHANGED: stored credentials changed after this request began; the request was not replayed.'
      )
    }
    activeCredentials = requireCurrentCredentials(baseUrl, refreshResult.credentials)
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.headers || {}),
        Authorization: `Bearer ${getAuthorizationToken(activeCredentials)}`,
      },
      ...credentialRequestRedirectPolicy(),
    })
  }

  return response
}
