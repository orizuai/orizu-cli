// ORI-2044: moved from index.ts to keep auth commands together.
import { randomBytes, createHash } from 'crypto'
import { spawn } from 'child_process'
import { createServer } from 'http'

import { sanitizeTerminalText, parseJsonResponse } from './json-response.js'
import { isInteractiveTerminal, hasArg, hasJsonFlag, getArg } from './command-line-arguments.js'
import {
  getBaseUrl,
  resolveLoginTarget,
  resolveLogoutTarget,
  assertSecureTokenTransport,
  authedFetch,
  credentialRequestRedirectPolicy,
} from './http.js'
import {
  hasResolvableAuth,
  rememberProcessSecret,
  saveServerCredentials,
  getServerCredentials,
  clearServerCredentials,
  resolveAuthTokenForBaseUrl,
} from './credentials.js'
import { printJson, printLine, printLoginProgress } from './cli-console-output.js'
import { shouldUseHeadlessLogin, waitForHeadlessAuthorization } from './headless-login.js'
import { renderCliAuthBrowserPage } from './cli-auth-browser-page.js'
import { describeLogoutHttpFailure, describeLogoutTransportFailure } from './logout-diagnostic.js'
import { resolveProjectSelection } from './account-directory.js'

import type { LoginResponse } from './types.js'

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error
}

function createCodeVerifier(): string {
  return randomBytes(32).toString('base64url')
}

export function createCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

function isStandardOrizuOrigin(url: URL): boolean {
  return url.protocol === 'https:' && !url.port && !url.username && !url.password &&
    url.hostname.length <= 253 &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*orizu\.ai$/.test(url.hostname)
}

export function validateBrowserUrl(url: string, expectedOrigin?: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Server returned an invalid browser URL.')
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Server returned an unsupported browser URL scheme.')
  }

  if (parsed.username || parsed.password) {
    throw new Error('Server returned a browser URL containing credentials.')
  }

  if (expectedOrigin && parsed.origin !== expectedOrigin) {
    const allowsOrizuHandoff = isStandardOrizuOrigin(parsed) && isStandardOrizuOrigin(new URL(expectedOrigin))
    if (!allowsOrizuHandoff) {
      throw new Error('Server returned a browser URL for an unexpected origin.')
    }
  }

  return parsed
}

function openInBrowser(url: string) {
  const parsed = validateBrowserUrl(url)
  const platform = process.platform
  const href = parsed.href
  if (platform === 'darwin') {
    spawn('open', [href], {
      detached: true,
      stdio: 'ignore',
    }).unref()
    return
  }

  if (platform === 'win32') {
    spawn('rundll32.exe', ['url.dll,FileProtocolHandler', href], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref()
    return
  }

  spawn('xdg-open', [href], {
    detached: true,
    stdio: 'ignore',
  }).unref()
}

export function formatTerminalLink(url: string): string {
  const safeUrl = sanitizeTerminalText(url)
  try {
    const parsed = validateBrowserUrl(safeUrl)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return safeUrl
    }
  } catch {
    return safeUrl
  }

  if (!isInteractiveTerminal()) {
    return safeUrl
  }

  return `\u001B]8;;${safeUrl}\u0007${safeUrl}\u001B]8;;\u0007`
}

function shellQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

const DEFAULT_AUTH_CALLBACK_PORT = 43123

function resolveAuthCallbackPort(): number {
  const envPort = process.env.ORIZU_AUTH_PORT
  if (!envPort) {
    return DEFAULT_AUTH_CALLBACK_PORT
  }

  const parsed = parseInt(envPort, 10)
  if (Number.isNaN(parsed) || parsed < 1024 || parsed > 65535) {
    throw new Error(
      `Invalid ORIZU_AUTH_PORT: '${envPort}'. Must be a number between 1024 and 65535.`
    )
  }

  return parsed
}

interface AuthenticatedLoginResponse extends LoginResponse {
  apiKey: string
}

async function login(baseUrlOverride?: string) {
  const target = baseUrlOverride !== undefined
    ? { baseUrl: baseUrlOverride, isDefault: false }
    : hasArg('--no-prompt-if-logged-in')
      ? { baseUrl: getBaseUrl(), isDefault: false }
      : resolveLoginTarget()
  const { baseUrl } = target
  let loginData: AuthenticatedLoginResponse | undefined
  try {
    loginData = await authenticateAtBaseUrl(baseUrl)
    if (!loginData) return
    saveServerCredentials(baseUrl, {
      credentialType: 'pat',
      apiKey: loginData.apiKey,
    })
  } catch (error) {
    if (target.isDefault) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(
        `${detail} Check connectivity to https://app.orizu.ai, then retry \`orizu login\`.`,
        { cause: error }
      )
    }
    throw error
  }

  if (hasJsonFlag()) {
    printJson({
      status: 'logged-in',
      server: baseUrl,
      user: { id: loginData.user.id, email: loginData.user.email ?? null },
    })
    return
  }
  printLine(`Logged in as ${sanitizeTerminalText(loginData.user.email ?? loginData.user.id)}`)
}

async function authenticateAtBaseUrl(baseUrl: string): Promise<AuthenticatedLoginResponse | undefined> {
  assertSecureTokenTransport(baseUrl)

  // hasResolvableAuth (ALI-1090): an env bearer (ORIZU_TOKEN / ORIZU_TOKEN_FILE)
  // counts as logged in — a pre-authenticated hosted sandbox must not fall into
  // the interactive browser flow.
  if (hasArg('--no-prompt-if-logged-in') && hasResolvableAuth(baseUrl)) {
    if (hasJsonFlag()) {
      printJson({ status: 'already-logged-in', server: baseUrl })
      return
    }
    printLine(`Already logged in to ${sanitizeTerminalText(baseUrl)}.`)
    return
  }

  const codeVerifier = rememberProcessSecret(createCodeVerifier())
  const codeChallenge = createCodeChallenge(codeVerifier)
  const isHeadlessLogin = shouldUseHeadlessLogin({ isForced: hasArg('--headless') })
  const callbackPort = isHeadlessLogin ? undefined : resolveAuthCallbackPort()
  const redirectUri = callbackPort === undefined ? undefined : `http://127.0.0.1:${callbackPort}/callback`
  const callbackCode = isHeadlessLogin
    ? await waitForHeadlessAuthorization(
      { baseUrl, codeChallenge },
      {
        parseJsonResponse,
        printProgress: printLoginProgress,
        sanitizeTerminalText,
        validateBrowserUrl,
      }
    )
    : await new Promise<string>((resolve, reject) => {
    const server = createServer((request, response) => {
      try {
        const url = new URL(request.url || '/', `http://127.0.0.1:${callbackPort}`)
        const code = url.searchParams.get('code')

        if (!code) {
          response.statusCode = 400
          response.setHeader('content-type', 'text/html; charset=utf-8')
          response.end(renderCliAuthBrowserPage('error'))
          return
        }

        response.statusCode = 200
        response.setHeader('content-type', 'text/html; charset=utf-8')
        response.end(renderCliAuthBrowserPage('success'))

        server.close()
        resolve(code)
      } catch (error) {
        server.close()
        reject(error)
      }
    })

    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(
          `Port ${callbackPort} is already in use. Set ORIZU_AUTH_PORT to a different port (1024–65535) and retry.`
        ))
      } else {
        reject(error)
      }
    })

    server.listen(callbackPort, '127.0.0.1', async () => {
      try {
        const response = await fetch(`${baseUrl}/api/cli/auth/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ codeChallenge, redirectUri }),
        })

        if (!response.ok) {
          const text = await response.text()
          server.close()
          reject(new Error(`Failed to start login: ${text}`))
          return
        }

        const { authorizeUrl } = await parseJsonResponse<{ authorizeUrl: string }>(
          response,
          'CLI auth start'
        )
        const safeAuthorizeUrl = validateBrowserUrl(authorizeUrl, baseUrl).href
        printLoginProgress(`Opening browser for login: ${sanitizeTerminalText(safeAuthorizeUrl)}`)
        openInBrowser(safeAuthorizeUrl)
      } catch (error) {
        server.close()
        reject(error)
      }
    })
  })

  rememberProcessSecret(callbackCode)
  const exchangeResponse = await fetch(`${baseUrl}/api/cli/auth/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: callbackCode, codeVerifier, redirectUri }),
  })

  if (!exchangeResponse.ok) {
    const text = await exchangeResponse.text()
    throw new Error(`Failed to exchange auth code: ${text}`)
  }

  const loginData = await parseJsonResponse<LoginResponse>(exchangeResponse, 'CLI auth exchange')
  if (!loginData.apiKey) {
    throw new Error('Server did not return an API key. Upgrade the Orizu server and run `orizu login` again.')
  }

  return { ...loginData, apiKey: loginData.apiKey }
}

async function whoami() {
  const response = await authedFetch('/api/cli/auth/whoami')
  if (!response.ok) {
    throw new Error(`whoami failed: ${await response.text()}`)
  }
  const data = await response.json() as { user: { id: string; email: string | null } }
  if (hasJsonFlag()) {
    printJson({ user: data.user, server: getBaseUrl() })
    return
  }
  printLine(sanitizeTerminalText(data.user.email ?? data.user.id))
}

async function logout(baseUrlOverride?: string) {
  const { baseUrl, credentialBaseUrl } = resolveLogoutTarget(baseUrlOverride)
  const credentials = getServerCredentials(credentialBaseUrl)
  if (!credentials) {
    if (hasJsonFlag()) {
      printJson({ status: 'already-logged-out', server: baseUrl })
      return
    }
    printLine(`Already logged out for ${sanitizeTerminalText(baseUrl)}.`)
    return
  }
  const authorizationToken = 'accessToken' in credentials
    ? credentials.accessToken
    : credentials.apiKey
  const logoutSecrets = [
    authorizationToken,
    ...('refreshToken' in credentials ? [credentials.refreshToken] : []),
  ]
  let remoteLogoutError: string | null = null
  try {
    assertSecureTokenTransport(baseUrl)
    const response = await fetch(`${baseUrl}/api/cli/auth/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authorizationToken}`,
      },
      body: 'refreshToken' in credentials
        ? JSON.stringify({ refreshToken: credentials.refreshToken })
        : undefined,
      ...credentialRequestRedirectPolicy(),
    })
    if (!response.ok) {
      remoteLogoutError = await describeLogoutHttpFailure(response, logoutSecrets)
    }
  } catch (error) {
    remoteLogoutError = describeLogoutTransportFailure(error, logoutSecrets)
  }
  clearServerCredentials(credentialBaseUrl)
  if (hasJsonFlag()) {
    printJson({ status: 'logged-out', server: baseUrl, remoteLogoutError })
    return
  }
  if (remoteLogoutError) {
    console.warn(`Warning: remote logout failed: ${remoteLogoutError}`)
  }
  printLine(`Logged out from ${sanitizeTerminalText(baseUrl)}.`)
}

async function printEnv() {
  const baseUrl = getBaseUrl()
  // Uniform resolution (ALI-1090): env bearer (ORIZU_TOKEN / ORIZU_TOKEN_FILE)
  // wins over credentials.json, so `orizu env` works in hosted sandboxes that
  // never ran `orizu login`.
  const token = resolveAuthTokenForBaseUrl(baseUrl)
  const projectArg = getArg('--project')
  const project = projectArg ? await resolveProjectSelection(projectArg) : null
  const projectId = project?.id || getArg('--project-id') || process.env.ORIZU_PROJECT_ID || ''
  const projectSlug = project ? `${project.teamSlug}/${project.slug}` : process.env.ORIZU_PROJECT || ''

  if (hasJsonFlag()) {
    printJson({
      ORIZU_API_URL: baseUrl,
      ORIZU_TOKEN: token,
      ORIZU_PROJECT_ID: projectId,
      ...(projectSlug ? { ORIZU_PROJECT: projectSlug } : {}),
    })
    return
  }
  printLine(`export ORIZU_API_URL=${shellQuote(baseUrl)}`)
  printLine(`export ORIZU_TOKEN=${shellQuote(token)}`)
  printLine(`export ORIZU_PROJECT_ID=${shellQuote(projectId)}`)
  if (projectSlug) {
    printLine(`export ORIZU_PROJECT=${shellQuote(projectSlug)}`)
  }
}

export { isNodeError, login, shellQuote, logout, whoami, printEnv }
