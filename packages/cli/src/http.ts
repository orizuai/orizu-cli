import {
  resolveCredentialServer,
  getActiveBaseUrl,
  getServerCredentials,
  rememberResolvedBearer,
  resolveEnvBearerToken,
} from './credentials.js'
import { canonicalServerUrl, getFlagBaseUrl, GlobalFlags, normalizeBaseUrl } from './global-flags.js'
import { ServerCredentials } from './types.js'

let runtimeFlags: GlobalFlags = { local: false, server: null }
let lastResolvedBaseUrl: string | null = null

function rememberResolvedBaseUrl(baseUrl: string): string {
  lastResolvedBaseUrl = baseUrl
  return baseUrl
}

export function getLastResolvedBaseUrl(): string | null {
  return lastResolvedBaseUrl
}

export function setGlobalFlags(flags: GlobalFlags) {
  runtimeFlags = flags
  lastResolvedBaseUrl = null
}

export function resolveBaseUrl(flags: GlobalFlags = runtimeFlags): string {
  const fromFlags = getFlagBaseUrl(flags)
  if (fromFlags) {
    return rememberResolvedBaseUrl(resolveCredentialServer(fromFlags)!)
  }

  const fromEnv = process.env.ORIZU_BASE_URL
  if (fromEnv) {
    return rememberResolvedBaseUrl(resolveCredentialServer(normalizeBaseUrl(fromEnv))!)
  }

  const fromStored = resolveCredentialServer()
  if (fromStored) {
    return rememberResolvedBaseUrl(fromStored)
  }

  return rememberResolvedBaseUrl('https://app.orizu.ai')
}

interface LogoutTarget {
  baseUrl: string
  credentialBaseUrl: string
}

// Logout is the recovery path for conflicting saved sign-ins. Revoke the
// selected credential on app without moving it over another saved credential.
export function resolveLogoutTarget(override?: string): LogoutTarget {
  const selected = override ?? getFlagBaseUrl(runtimeFlags)
    ?? (process.env.ORIZU_BASE_URL ? normalizeBaseUrl(process.env.ORIZU_BASE_URL) : null)
    ?? getActiveBaseUrl() ?? 'https://app.orizu.ai'
  const baseUrl = rememberResolvedBaseUrl(canonicalServerUrl(selected))
  return { baseUrl, credentialBaseUrl: getServerCredentials(selected) ? selected : baseUrl }
}

interface LoginTarget {
  baseUrl: string
  isDefault: boolean
}

export function resolveLoginTarget(flags: GlobalFlags = runtimeFlags): LoginTarget {
  const fromFlags = getFlagBaseUrl(flags)
  if (fromFlags) {
    return { baseUrl: rememberResolvedBaseUrl(resolveCredentialServer(fromFlags)!), isDefault: false }
  }

  const fromEnv = process.env.ORIZU_BASE_URL
  if (fromEnv) {
    return { baseUrl: rememberResolvedBaseUrl(resolveCredentialServer(normalizeBaseUrl(fromEnv))!), isDefault: false }
  }

  resolveCredentialServer()
  return { baseUrl: rememberResolvedBaseUrl('https://app.orizu.ai'), isDefault: true }
}

export function resolveLoginBaseUrl(flags: GlobalFlags = runtimeFlags): string {
  return resolveLoginTarget(flags).baseUrl
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

export function credentialRequestRedirectPolicy(): Pick<RequestInit, 'redirect'> {
  return process.env.ORIZU_CLI_AUTH_REDIRECT === 'error' ? { redirect: 'error' } : {}
}

const storedSessionRequests = () => import('./stored-session-requests.js')

export type AuthenticatedRequestSource = 'ORIZU_TOKEN' | 'ORIZU_TOKEN_FILE' | 'stored'

export interface AuthenticatedRequestContext {
  readonly baseUrl: string
  readonly source: AuthenticatedRequestSource
  /** `onRequestStart` runs just before each request goes out, as with `authedFetch`. */
  fetch(path: string, init?: RequestInit, onRequestStart?: () => void): Promise<Response>
  logout(signal?: AbortSignal | null): Promise<LogoutResult>
}

export interface LogoutResult {
  remoteError: string | null
  localCredentialCleared: boolean
}

function notLoggedIn(baseUrl: string): Error {
  return new Error(`Not logged in for ${baseUrl}. Run \`orizu login --server ${baseUrl}\` (or \`--local\`) first.`)
}

/**
 * Captures one authenticated server context for a multi-step operation. The
 * returned interface intentionally exposes no credential material. Its closure
 * pins the selected origin and stored/explicit credential; rotating token-file
 * contexts stay fresh unless pinEnvBearerValue is requested for one-shot payloads.
 */
export function captureAuthenticatedRequestContext(
  options: { allowRefresh?: boolean; pinEnvBearerValue?: boolean } = {}
): AuthenticatedRequestContext {
  const baseUrl = resolveBaseUrl()
  const allowRefresh = options.allowRefresh ?? true
  const pinEnvBearerValue = options.pinEnvBearerValue ?? false
  assertSecureTokenTransport(baseUrl)

  const envBearer = resolveEnvBearerToken()
  if (envBearer) {
    const explicitBearer = process.env.ORIZU_TOKEN?.trim() || null
    const source: AuthenticatedRequestSource = explicitBearer
      ? 'ORIZU_TOKEN'
      : 'ORIZU_TOKEN_FILE'
    const resolveRequestBearer = (): string => {
      if (explicitBearer || pinEnvBearerValue) return envBearer
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
      async fetch(path: string, init: RequestInit = {}, onRequestStart?: () => void) {
        const headers = {
          ...(init.headers || {}),
          Authorization: `Bearer ${resolveRequestBearer()}`,
        }
        onRequestStart?.()
        return await fetch(`${baseUrl}${path}`, {
          ...init,
          headers,
          ...credentialRequestRedirectPolicy(),
        })
      },
      async logout() {
        throw new Error(`Authentication is supplied by ${source}; stored logout is unavailable.`)
      },
    }
  }

  const capturedCredentials = getServerCredentials(baseUrl)
  if (!capturedCredentials) throw notLoggedIn(baseUrl)
  rememberStoredBearers(capturedCredentials)
  let activeCredentials = capturedCredentials
  const changed = 'ORIZU_CREDENTIALS_CHANGED: stored credentials changed before the captured session could refresh. Reconfirm the account and retry.'

  return {
    baseUrl,
    source: 'stored',
    async fetch(path: string, init: RequestInit = {}, onRequestStart?: () => void) {
      const { storedRequest } = await storedSessionRequests()
      return await storedRequest({
        baseUrl,
        credentials: activeCredentials,
        allowRefresh,
        changedBeforeRequest: changed,
        changedBeforeReplay: changed,
        onRefreshed: refreshed => { activeCredentials = refreshed },
      }, path, init, onRequestStart)
    },
    async logout(callerSignal?: AbortSignal | null) {
      const { storedLogout } = await storedSessionRequests()
      return await storedLogout(baseUrl, baseUrl, activeCredentials, callerSignal)
    },
  }
}

// Redacts a stored login from diagnostics from the moment it is read.
function rememberStoredBearers(credentials: ServerCredentials): void {
  if ('accessToken' in credentials) {
    rememberResolvedBearer(credentials.accessToken)
    rememberResolvedBearer(credentials.refreshToken)
  } else {
    rememberResolvedBearer(credentials.apiKey)
  }
}

// The optional observer runs immediately before a resource fetch, after auth
// preflight. Authentication refresh requests do not mark the resource as sent.
export async function authedFetch(path: string, init: RequestInit = {}, onRequestStart?: () => void) {
  const fetchResource = (url: string, requestInit: RequestInit) => {
    onRequestStart?.()
    return fetch(url, requestInit)
  }
  const baseUrl = resolveBaseUrl()
  assertSecureTokenTransport(baseUrl)

  // In-sandbox pre-auth (ALI-1044): a bearer supplied via ORIZU_TOKEN /
  // ORIZU_TOKEN_FILE takes precedence over credentials.json. It is externally
  // managed (the hosted loop rotates the token file), so it is read FRESH here on
  // every request and NEVER refreshed by this client — on a 401 the loop rotates
  // the file and the next request naturally picks up the new bearer.
  const envBearer = resolveEnvBearerToken()
  if (envBearer) {
    return await fetchResource(`${baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.headers || {}),
        Authorization: `Bearer ${envBearer}`,
      },
      ...credentialRequestRedirectPolicy(),
    })
  }

  const credentials = getServerCredentials(baseUrl)
  if (!credentials) throw notLoggedIn(baseUrl)

  const { storedRequest } = await storedSessionRequests()
  return await storedRequest({
    baseUrl,
    credentials,
    allowRefresh: true,
    changedBeforeRequest: 'ORIZU_AUTH_CONTEXT_CHANGED: stored credentials changed before this request began; the request was not sent.',
    changedBeforeReplay: 'ORIZU_AUTH_CONTEXT_CHANGED: stored credentials changed after this request began; the request was not replayed.',
  }, path, init, onRequestStart)
}
