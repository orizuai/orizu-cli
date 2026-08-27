interface HeadlessLoginStartResponse {
  authorizeUrl: string
  requestId: string
  pollToken: string
  expiresInSeconds: number
}

interface HeadlessLoginPollResponse {
  status: 'pending' | 'approved' | 'expired'
  code?: string
}

interface HeadlessLoginDependencies {
  parseJsonResponse: <T>(response: Response, context: string) => Promise<T>
  printProgress: (message: string) => void
  sanitizeTerminalText: (text: string) => string
  validateBrowserUrl: (url: string, expectedOrigin?: string) => URL
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

const POLL_INTERVAL_MS = 2_000
const POLL_REQUEST_TIMEOUT_MS = 15_000
const MAX_RETRY_DELAY_MS = 60_000
const MAX_CONSECUTIVE_TRANSPORT_ERRORS = 3

function retryDelayMs(response: Response): number {
  if (response.status !== 429) return POLL_INTERVAL_MS
  const retryAfterHeader = response.headers.get('retry-after')
  const retryAfterSeconds = retryAfterHeader === null ? NaN : Number(retryAfterHeader)
  return Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
    ? Math.min(retryAfterSeconds * 1000, MAX_RETRY_DELAY_MS)
    : POLL_INTERVAL_MS
}

async function sleepWithinDeadline(delayMs: number, expiresAt: number): Promise<void> {
  const remainingMs = expiresAt - Date.now()
  if (remainingMs <= 0) return
  await new Promise(resolve => setTimeout(resolve, Math.min(delayMs, remainingMs)))
}

async function retryAfterTransportError(
  error: unknown,
  consecutiveErrors: number,
  expiresAt: number
): Promise<number> {
  const nextCount = consecutiveErrors + 1
  if (nextCount >= MAX_CONSECUTIVE_TRANSPORT_ERRORS) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Headless login could not reach the server after ${nextCount} attempts: ${detail}`
    )
  }
  await sleepWithinDeadline(POLL_INTERVAL_MS, expiresAt)
  return nextCount
}

export async function waitForHeadlessAuthorization(
  {
    baseUrl,
    codeChallenge,
  }: {
    baseUrl: string
    codeChallenge: string
  },
  dependencies: HeadlessLoginDependencies
): Promise<string> {
  const startResponse = await fetch(`${baseUrl}/api/cli/auth/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codeChallenge, flow: 'headless' }),
    signal: AbortSignal.timeout(POLL_REQUEST_TIMEOUT_MS),
  })

  if (!startResponse.ok) {
    throw new Error(`Failed to start login: ${await startResponse.text()}`)
  }

  const started = await dependencies.parseJsonResponse<HeadlessLoginStartResponse>(
    startResponse,
    'CLI headless auth start'
  )
  const authorizeUrl = dependencies.validateBrowserUrl(started.authorizeUrl, baseUrl).href
  if (!started.requestId || !started.pollToken || !Number.isFinite(started.expiresInSeconds)) {
    throw new Error('Server returned an invalid headless login response.')
  }

  dependencies.printProgress(
    `Open this URL to log in: ${dependencies.sanitizeTerminalText(authorizeUrl)}`
  )
  const expiresAt = Date.now() + (started.expiresInSeconds * 1000)

  let consecutiveTransportErrors = 0
  while (Date.now() < expiresAt) {
    const remainingMs = expiresAt - Date.now()
    let pollResponse: Response
    try {
      pollResponse = await fetch(`${baseUrl}/api/cli/auth/poll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId: started.requestId,
          pollToken: started.pollToken,
        }),
        signal: AbortSignal.timeout(Math.max(1, Math.min(POLL_REQUEST_TIMEOUT_MS, remainingMs))),
      })
    } catch (error) {
      consecutiveTransportErrors = await retryAfterTransportError(
        error,
        consecutiveTransportErrors,
        expiresAt
      )
      continue
    }

    if (!pollResponse.ok) {
      if (pollResponse.status === 429) {
        consecutiveTransportErrors = 0
        await sleepWithinDeadline(retryDelayMs(pollResponse), expiresAt)
        continue
      }
      if (pollResponse.status >= 500) {
        const detail = await pollResponse.text().catch(() => 'response body unavailable')
        consecutiveTransportErrors = await retryAfterTransportError(
          new Error(`Server returned ${pollResponse.status}: ${detail}`),
          consecutiveTransportErrors,
          expiresAt
        )
        continue
      }
      throw new Error(`Failed to poll login: ${await pollResponse.text()}`)
    }

    let polled: HeadlessLoginPollResponse
    try {
      polled = await dependencies.parseJsonResponse<HeadlessLoginPollResponse>(
        pollResponse,
        'CLI headless auth poll'
      )
    } catch (error) {
      consecutiveTransportErrors = await retryAfterTransportError(
        error,
        consecutiveTransportErrors,
        expiresAt
      )
      continue
    }
    consecutiveTransportErrors = 0

    if (polled.status === 'approved' && polled.code) {
      return polled.code
    }
    if (polled.status === 'expired') {
      break
    }
    if (polled.status !== 'pending') {
      throw new Error('Server returned an invalid headless login status.')
    }

    await sleepWithinDeadline(POLL_INTERVAL_MS, expiresAt)
  }

  throw new Error('Headless login expired. Run `orizu login --headless` to try again.')
}
