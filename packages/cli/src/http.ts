import { getActiveBaseUrl, getServerCredentials, updateServerCredentials } from './credentials.js'
import { getFlagBaseUrl, GlobalFlags, normalizeBaseUrl } from './global-flags.js'
import { LoginResponse, ServerCredentials } from './types.js'

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

function isExpired(expiresAt: number): boolean {
  const nowUnix = Math.floor(Date.now() / 1000)
  return expiresAt <= nowUnix + 30
}

async function refreshCredentials(baseUrl: string, credentials: ServerCredentials): Promise<ServerCredentials> {
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
  const refreshed = {
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
  const credentials = getServerCredentials(baseUrl)
  if (!credentials) {
    throw new Error(`Not logged in for ${baseUrl}. Run \`orizu login --server ${baseUrl}\` (or \`--local\`) first.`)
  }

  let activeCredentials = credentials
  if (isExpired(activeCredentials.expiresAt)) {
    activeCredentials = await refreshCredentials(baseUrl, activeCredentials)
  }

  let response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${activeCredentials.accessToken}`,
    },
  })

  if (response.status === 401) {
    activeCredentials = await refreshCredentials(baseUrl, activeCredentials)
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.headers || {}),
        Authorization: `Bearer ${activeCredentials.accessToken}`,
      },
    })
  }

  return response
}
