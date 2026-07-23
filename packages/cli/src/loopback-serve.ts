export interface LoopbackServer {
  port: number
  stop: (force?: boolean) => void
}

interface LoopbackServeOptions {
  port: number
  hostname: '127.0.0.1'
  fetch: (request: Request) => Promise<Response> | Response
}

export interface LoopbackServeRuntime {
  serve: (options: LoopbackServeOptions) => { port?: number; stop: (force?: boolean) => void }
}

function candidateLoopbackPorts(requestedPort?: number): number[] {
  if (requestedPort && requestedPort > 0) return [requestedPort]
  const min = 49152
  const width = 16_000
  const seed = (process.pid * 131 + Math.floor(Math.random() * width)) % width
  return Array.from({ length: 100 }, (_, index) => min + ((seed + index) % width))
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/**
 * Bind a separate-process test server to loopback.
 *
 * The full parallel suite exposed intermittent Bun `port: 0` startup failures,
 * so these fixtures use explicit high-port candidates. `serve()` still performs
 * the atomic bind; a collision retries only when Bun reports `EADDRINUSE`.
 */
export function serveOnLoopback(
  runtime: LoopbackServeRuntime,
  requestedPort: number | undefined,
  fetch: (request: Request) => Promise<Response> | Response,
  serverName: string
): LoopbackServer {
  let lastError: unknown
  for (const port of candidateLoopbackPorts(requestedPort)) {
    try {
      const server = runtime.serve({ port, hostname: '127.0.0.1', fetch })
      if (server.port === undefined) throw new Error(`${serverName} started without a port`)
      return { port: server.port, stop: force => server.stop(force) }
    } catch (error) {
      lastError = error
      if (requestedPort || errorCode(error) !== 'EADDRINUSE') throw error
    }
  }
  throw lastError ?? new Error(`failed to bind ${serverName}`)
}
