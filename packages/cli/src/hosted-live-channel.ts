/**
 * ORI-2200 slice 2 (ADR-040): the sandbox's socket to its session coordinator.
 * The coordinator sends "check now" when someone presses Stop; the sandbox
 * then reads its session at once instead of waiting for the next regular read.
 * The message carries no instruction of its own: the session record decides
 * whether this run was interrupted, so a forged or stray check costs one read.
 *
 * Best effort. If the socket cannot open (an older coordinator, a network
 * rule), the regular read every few seconds still catches the Stop.
 */

const RECONNECT_MAX_MS = 30_000
const PASS_TIMEOUT_MS = 10_000
// The coordinator closes an old socket with this code instead of sending it the
// update that arrived, so the close counts as a check; reconnect at once.
const RECHECK_CLOSE_CODE = 4001

export interface HostedLiveChannel {
  /** Resolves on the next "check now" (or at once if one arrived since the last call), or when `signal` aborts. */
  nextCheck(signal: AbortSignal): Promise<void>
  /** How many checks have arrived so far, read or not. */
  checkCount(): number
  close(): void
}

export function openHostedLiveChannel(opts: {
  /** `<coordinator>/sessions/<id>/live/sandbox-pass`. */
  sandboxPassUrl: string
  bootSecret: string
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>
  log?: (line: string) => void
}): HostedLiveChannel {
  const fetchImpl = opts.fetchImpl ?? fetch
  let isClosed = false
  let socket: WebSocket | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let failures = 0
  let hasPendingCheck = false
  let checks = 0
  const waiters = new Set<() => void>()

  const diagnose = (line: string) => {
    try { opts.log?.(line) } catch { /* diagnostics are best-effort */ }
  }
  const retry = (delayMs: number) => {
    if (isClosed) return
    timer = setTimeout(() => { void connect() }, delayMs)
  }
  const backoff = () => Math.min(1_000 * (2 ** failures++), RECONNECT_MAX_MS)
  const deliverCheck = () => {
    checks += 1
    if (waiters.size === 0) {
      hasPendingCheck = true
      return
    }
    for (const wake of [...waiters]) wake()
  }

  const connect = async () => {
    let url: string
    try {
      const response = await fetchImpl(opts.sandboxPassUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${opts.bootSecret}` },
        signal: AbortSignal.timeout(PASS_TIMEOUT_MS),
      })
      if (!response.ok) {
        await response.body?.cancel()
        // Fixed, value-free diagnostics: no secret, pass or URL is logged.
        diagnose(`hosted live channel refused (${response.status}); the regular session read continues`)
        return retry(backoff())
      }
      url = (await response.json() as { url: string }).url
    } catch {
      diagnose('hosted live channel unavailable; the regular session read continues')
      return retry(backoff())
    }
    if (isClosed) return
    let opened: WebSocket
    try {
      opened = new WebSocket(url)
    } catch {
      return retry(backoff())
    }
    socket = opened
    opened.onopen = () => { failures = 0 }
    opened.onmessage = event => {
      let message: unknown
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message && typeof message === 'object' && (message as { kind?: unknown }).kind === 'check') deliverCheck()
    }
    opened.onclose = event => {
      if (socket !== opened) return
      socket = null
      if (event.code === RECHECK_CLOSE_CODE) {
        deliverCheck()
        return retry(0)
      }
      retry(backoff())
    }
  }

  void connect()

  return {
    nextCheck(signal) {
      if (hasPendingCheck) {
        hasPendingCheck = false
        return Promise.resolve()
      }
      return new Promise<void>(resolve => {
        if (signal.aborted) return resolve()
        const wake = () => {
          waiters.delete(wake)
          signal.removeEventListener('abort', wake)
          resolve()
        }
        waiters.add(wake)
        signal.addEventListener('abort', wake, { once: true })
      })
    },
    checkCount: () => checks,
    close() {
      isClosed = true
      if (timer) clearTimeout(timer)
      const open = socket
      socket = null
      open?.close(1000)
      for (const wake of [...waiters]) wake()
    },
  }
}
