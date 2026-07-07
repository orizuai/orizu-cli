import {
  getActiveBaseUrl,
  getServerCredentials,
  resolveEnvBearerToken,
  updateServerCredentials,
} from './credentials.js'
import { getFlagBaseUrl, GlobalFlags, normalizeBaseUrl } from './global-flags.js'
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

async function refreshCredentials(baseUrl: string, credentials: ServerCredentials): Promise<ServerCredentials> {
  if (!isSessionCredentials(credentials)) {
    throw new Error('API key credentials do not refresh. Run `orizu login` again if access fails.')
  }

  assertSecureTokenTransport(baseUrl)
  const response = await fetch(`${baseUrl}/api/cli/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: credentials.refreshToken }),
  })

  if (!response.ok) {
    throw new Error('Session expired. Run `orizu login` again.')
  }

  const data = await response.json() as LoginResponse
  if (!data.accessToken || !data.refreshToken || !data.expiresAt) {
    throw new Error('Server returned invalid refresh credentials. Run `orizu login` again.')
  }

  const refreshed = {
    credentialType: 'session' as const,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresAt: data.expiresAt,
  }
  updateServerCredentials(baseUrl, refreshed)
  return refreshed
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
    })
  }

  const credentials = getServerCredentials(baseUrl)
  if (!credentials) {
    throw new Error(`Not logged in for ${baseUrl}. Run \`orizu login --server ${baseUrl}\` (or \`--local\`) first.`)
  }

  let activeCredentials = credentials
  if (isSessionCredentials(activeCredentials) && isExpired(activeCredentials.expiresAt)) {
    activeCredentials = await refreshCredentials(baseUrl, activeCredentials)
  }

  let response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${getAuthorizationToken(activeCredentials)}`,
    },
  })

  if (response.status === 401 && isSessionCredentials(activeCredentials)) {
    activeCredentials = await refreshCredentials(baseUrl, activeCredentials)
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.headers || {}),
        Authorization: `Bearer ${getAuthorizationToken(activeCredentials)}`,
      },
    })
  }

  return response
}
