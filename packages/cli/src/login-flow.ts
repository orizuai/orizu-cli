// `orizu login` from the start request to the server's answer (ORI-2422):
// the browser flow's loopback server and launch, the headless poll loop, and
// the code exchange. Loaded by `await import(...)` inside login() only after
// the already-logged-in check, so other commands and the hosted token path
// (ORIZU_TOKEN / ORIZU_TOKEN_FILE) never load Effect. No stop handlers: a
// Ctrl-C ends the process at once, which frees the port and saves nothing.
import { spawn } from 'child_process'
import { createServer, type Server } from 'http'

import { Cause, Effect, Exit, Result, Schema, type Scope } from 'effect'

import { renderCliAuthBrowserPage } from './cli-auth-browser-page.js'
import { rememberProcessSecret } from './credentials.js'

export interface LoginFlowDependencies {
  parseJsonResponse: <T>(response: Response, context: string) => Promise<T>
  printProgress: (message: string) => void
  sanitizeTerminalText: (text: string) => string
  validateBrowserUrl: (url: string, expectedOrigin?: string) => URL
  sleep?: (milliseconds: number) => Promise<void>
}

export interface CompletedLogin {
  apiKey: string
  user: { id: string; email: string | null }
}

export function shouldUseHeadlessLogin({
  isForced,
  platform = process.platform,
  environment = process.env,
}: {
  isForced: boolean
  platform?: NodeJS.Platform
  environment?: Record<string, string | undefined>
}): boolean {
  if (isForced || environment.SSH_CONNECTION || environment.SSH_TTY) {
    return true
  }

  return platform === 'linux' && !environment.DISPLAY && !environment.WAYLAND_DISPLAY
}

const toError = (cause: unknown) => cause instanceof Error ? cause : new Error(String(cause))

/** A request that stops when the run is interrupted, and after `timeoutMs` when given. */
function request(url: string, init: RequestInit, timeoutMs?: number): Effect.Effect<Response, Error> {
  return Effect.tryPromise({
    try: signal => fetch(url, {
      ...init,
      signal: timeoutMs === undefined ? signal : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    }),
    catch: toError,
  })
}

const readText = (response: Response) => Effect.tryPromise({ try: () => response.text(), catch: toError })

const parseJson = <T>(dependencies: LoginFlowDependencies, response: Response, context: string) =>
  Effect.tryPromise({ try: () => dependencies.parseJsonResponse<T>(response, context), catch: toError })

// --- Browser flow -----------------------------------------------------------

interface Loopback {
  server: Server
  code: Promise<string>
}

/**
 * The loopback server the browser returns to. Only `GET /callback` counts:
 * other paths get 404 and the wait goes on, and `/callback` without a code
 * gets the error page and the wait goes on. The release closes the server and
 * drops every connection on every ending. It runs after the success page has
 * been sent, so a browser that keeps its connection open no longer holds the
 * CLI after "Logged in".
 */
function loopback(port: number): Effect.Effect<Loopback, Error, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.callback<Loopback, Error>(resume => {
      let deliver: (code: string) => void = () => {}
      const code = new Promise<string>(resolve => { deliver = resolve })
      const server = createServer((incoming, response) => {
        let url: URL
        try {
          url = new URL(incoming.url || '/', `http://127.0.0.1:${port}`)
        } catch {
          // A malformed request target (from any local process) is refused; the wait goes on.
          response.statusCode = 400
          response.setHeader('content-type', 'text/plain; charset=utf-8')
          response.end('Bad request')
          return
        }
        if (incoming.method !== 'GET' || url.pathname !== '/callback') {
          response.statusCode = 404
          response.setHeader('content-type', 'text/plain; charset=utf-8')
          response.end('Not found')
          return
        }
        const received = url.searchParams.get('code')
        response.setHeader('content-type', 'text/html; charset=utf-8')
        if (!received) {
          response.statusCode = 400
          response.end(renderCliAuthBrowserPage('error'))
          return
        }
        response.statusCode = 200
        response.end(renderCliAuthBrowserPage('success'))
        deliver(received)
      })
      server.once('error', (error: NodeJS.ErrnoException) => {
        resume(Effect.fail(error.code === 'EADDRINUSE'
          ? new Error(`Port ${port} is already in use. Set ORIZU_AUTH_PORT to a different port (1024–65535) and retry.`)
          : error))
      })
      server.listen(port, '127.0.0.1', () => resume(Effect.succeed({ server, code })))
    }),
    ({ server }) => Effect.sync(() => {
      server.close()
      server.closeAllConnections()
    }),
  )
}

const waitForCode = (code: Promise<string>) => Effect.callback<string>(resume => {
  void code.then(value => resume(Effect.succeed(value)))
})

/**
 * Starts the person's browser on `url`. The command is detached and never
 * killed: on Linux `xdg-open` can become the browser itself. If it can't be
 * started or exits with a failure, the URL is printed to open by hand and the
 * wait goes on.
 */
function launchBrowser(url: string, dependencies: LoginFlowDependencies): Effect.Effect<void> {
  return Effect.sync(() => {
    const command = process.platform === 'darwin'
      ? { file: 'open', args: [url] }
      : process.platform === 'win32'
        ? { file: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] }
        : { file: 'xdg-open', args: [url] }
    let toldByHand = false
    const openByHand = () => {
      if (toldByHand) return
      toldByHand = true
      dependencies.printProgress(`Could not open a browser. Open this URL to log in: ${dependencies.sanitizeTerminalText(url)}`)
    }
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.once('error', openByHand)
    child.once('exit', status => { if (status !== 0) openByHand() })
    child.unref()
  })
}

function browserAuthorization(
  { baseUrl, codeChallenge, port }: { baseUrl: string; codeChallenge: string; port: number },
  dependencies: LoginFlowDependencies,
): Effect.Effect<string, Error> {
  const redirectUri = `http://127.0.0.1:${port}/callback`
  return Effect.scoped(Effect.gen(function*() {
    const { code } = yield* loopback(port)
    const response = yield* request(`${baseUrl}/api/cli/auth/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codeChallenge, redirectUri }),
    })
    if (!response.ok) return yield* Effect.fail(new Error(`Failed to start login: ${yield* readText(response)}`))
    const { authorizeUrl } = yield* parseJson<{ authorizeUrl: string }>(dependencies, response, 'CLI auth start')
    const safeAuthorizeUrl = yield* Effect.try({ try: () => dependencies.validateBrowserUrl(authorizeUrl, baseUrl).href, catch: toError })
    dependencies.printProgress(`Opening browser for login: ${dependencies.sanitizeTerminalText(safeAuthorizeUrl)}`)
    yield* launchBrowser(safeAuthorizeUrl, dependencies)
    return yield* waitForCode(code)
  }))
}

// --- Headless flow ----------------------------------------------------------

export const POLL_INTERVAL_MS = 2_000
const POLL_REQUEST_TIMEOUT_MS = 15_000
const MAX_RETRY_DELAY_MS = 60_000
const MAX_CONSECUTIVE_TRANSPORT_ERRORS = 3

const HeadlessStart = Schema.Struct({
  requestId: Schema.NonEmptyString,
  pollToken: Schema.NonEmptyString,
  expiresInSeconds: Schema.Finite,
})

const HeadlessPoll = Schema.Struct({
  status: Schema.Literals(['pending', 'approved', 'expired']),
  code: Schema.optionalKey(Schema.String),
})

function retryDelayMs(response: Response): number {
  if (response.status !== 429) return POLL_INTERVAL_MS
  const retryAfterHeader = response.headers.get('retry-after')
  const retryAfterSeconds = retryAfterHeader === null ? NaN : Number(retryAfterHeader)
  return Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
    ? Math.min(retryAfterSeconds * 1000, MAX_RETRY_DELAY_MS)
    : POLL_INTERVAL_MS
}

function headlessAuthorization(
  { baseUrl, codeChallenge }: { baseUrl: string; codeChallenge: string },
  dependencies: LoginFlowDependencies,
): Effect.Effect<string, Error> {
  const sleep = (milliseconds: number) => dependencies.sleep
    ? Effect.promise(() => dependencies.sleep!(milliseconds))
    : Effect.sleep(milliseconds)
  return Effect.gen(function*() {
    const startResponse = yield* request(`${baseUrl}/api/cli/auth/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codeChallenge, flow: 'headless' }),
    }, POLL_REQUEST_TIMEOUT_MS)
    if (!startResponse.ok) return yield* Effect.fail(new Error(`Failed to start login: ${yield* readText(startResponse)}`))

    const started = yield* parseJson<{ authorizeUrl: string }>(dependencies, startResponse, 'CLI headless auth start')
    const authorizeUrl = yield* Effect.try({ try: () => dependencies.validateBrowserUrl(started.authorizeUrl, baseUrl).href, catch: toError })
    const decodedStart = Schema.decodeUnknownResult(HeadlessStart)(started)
    if (Result.isFailure(decodedStart)) {
      return yield* Effect.fail(new Error('Server returned an invalid headless login response.'))
    }
    const { requestId, pollToken, expiresInSeconds } = decodedStart.success
    rememberProcessSecret(pollToken)

    dependencies.printProgress(`Open this URL to log in: ${dependencies.sanitizeTerminalText(authorizeUrl)}`)
    const expiresAt = Date.now() + (expiresInSeconds * 1000)
    const sleepWithinDeadline = (delayMs: number) => {
      const remainingMs = expiresAt - Date.now()
      return remainingMs <= 0 ? Effect.void : sleep(Math.min(delayMs, remainingMs))
    }
    let consecutiveTransportErrors = 0
    const retryAfterTransportError = (error: Error) => Effect.gen(function*() {
      consecutiveTransportErrors += 1
      if (consecutiveTransportErrors >= MAX_CONSECUTIVE_TRANSPORT_ERRORS) {
        return yield* Effect.fail(new Error(
          `Headless login could not reach the server after ${consecutiveTransportErrors} attempts: ${error.message}`
        ))
      }
      yield* sleepWithinDeadline(POLL_INTERVAL_MS)
    })

    while (Date.now() < expiresAt) {
      const remainingMs = expiresAt - Date.now()
      const polled = yield* Effect.result(request(`${baseUrl}/api/cli/auth/poll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, pollToken }),
      }, Math.max(1, Math.min(POLL_REQUEST_TIMEOUT_MS, remainingMs))))
      if (Result.isFailure(polled)) {
        yield* retryAfterTransportError(polled.failure)
        continue
      }
      const pollResponse = polled.success

      if (!pollResponse.ok) {
        if (pollResponse.status === 429) {
          consecutiveTransportErrors = 0
          yield* sleepWithinDeadline(retryDelayMs(pollResponse))
          continue
        }
        if (pollResponse.status >= 500) {
          const detail = yield* readText(pollResponse).pipe(Effect.orElseSucceed(() => 'response body unavailable'))
          yield* retryAfterTransportError(new Error(`Server returned ${pollResponse.status}: ${detail}`))
          continue
        }
        return yield* Effect.fail(new Error(`Failed to poll login: ${yield* readText(pollResponse)}`))
      }

      const parsed = yield* Effect.result(parseJson<unknown>(dependencies, pollResponse, 'CLI headless auth poll'))
      if (Result.isFailure(parsed)) {
        yield* retryAfterTransportError(parsed.failure)
        continue
      }
      consecutiveTransportErrors = 0

      const decoded = Schema.decodeUnknownResult(HeadlessPoll)(parsed.success)
      if (Result.isFailure(decoded)) {
        return yield* Effect.fail(new Error('Server returned an invalid headless login status.'))
      }
      const { status, code } = decoded.success
      if (status === 'approved' && code) return rememberProcessSecret(code)
      if (status === 'expired') break
      if (status !== 'pending') {
        return yield* Effect.fail(new Error('Server returned an invalid headless login status.'))
      }

      yield* sleepWithinDeadline(POLL_INTERVAL_MS)
    }

    return yield* Effect.fail(new Error('Headless login expired. Run `orizu login --headless` to try again.'))
  })
}

// --- Exchange ---------------------------------------------------------------

const ExchangeReply = Schema.Struct({
  apiKey: Schema.optionalKey(Schema.Unknown),
  user: Schema.Struct({
    id: Schema.String,
    email: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
})

function exchange(
  { baseUrl, code, codeVerifier, redirectUri }: { baseUrl: string; code: string; codeVerifier: string; redirectUri?: string },
  dependencies: LoginFlowDependencies,
): Effect.Effect<CompletedLogin, Error> {
  return Effect.gen(function*() {
    rememberProcessSecret(code)
    const response = yield* request(`${baseUrl}/api/cli/auth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, codeVerifier, redirectUri }),
    })
    if (!response.ok) return yield* Effect.fail(new Error(`Failed to exchange auth code: ${yield* readText(response)}`))

    const data = yield* parseJson<unknown>(dependencies, response, 'CLI auth exchange')
    const decoded = Schema.decodeUnknownResult(ExchangeReply)(data)
    const apiKey = Result.isSuccess(decoded) ? decoded.success.apiKey : (data as { apiKey?: unknown } | null)?.apiKey
    if (typeof apiKey !== 'string' || apiKey === '') {
      return yield* Effect.fail(new Error('Server did not return an API key. Upgrade the Orizu server and run `orizu login` again.'))
    }
    if (Result.isFailure(decoded)) return yield* Effect.fail(new Error('Server returned an invalid login response.'))
    const { user } = decoded.success
    return { apiKey, user: { id: user.id, email: user.email ?? null } }
  })
}

// --- Entry ------------------------------------------------------------------

/** For tests: the headless wait alone, returning the authorization code. */
export function waitForHeadlessAuthorization(
  input: { baseUrl: string; codeChallenge: string },
  dependencies: LoginFlowDependencies,
  signal?: AbortSignal,
): Promise<string> {
  return run(headlessAuthorization(input, dependencies), signal)
}

/**
 * Waits for the person to approve the login (in the browser, or by polling
 * when headless), then exchanges the code. `callbackPort` undefined means
 * headless. `signal` stops it, closing the loopback server.
 */
export function completeLogin(
  input: { baseUrl: string; codeVerifier: string; codeChallenge: string; callbackPort?: number },
  dependencies: LoginFlowDependencies,
  signal?: AbortSignal,
): Promise<CompletedLogin> {
  const { baseUrl, codeVerifier, codeChallenge, callbackPort } = input
  const authorization = callbackPort === undefined
    ? headlessAuthorization({ baseUrl, codeChallenge }, dependencies)
    : browserAuthorization({ baseUrl, codeChallenge, port: callbackPort }, dependencies)
  const redirectUri = callbackPort === undefined ? undefined : `http://127.0.0.1:${callbackPort}/callback`
  return run(Effect.flatMap(authorization, code => exchange({ baseUrl, code, codeVerifier, redirectUri }, dependencies)), signal)
}

async function run<A>(program: Effect.Effect<A, Error>, signal?: AbortSignal): Promise<A> {
  const exit = await Effect.runPromiseExit(program, signal ? { signal } : undefined)
  if (Exit.isSuccess(exit)) return exit.value
  if (signal?.aborted && Cause.hasInterruptsOnly(exit.cause)) throw signal.reason
  throw Cause.squash(exit.cause)
}
