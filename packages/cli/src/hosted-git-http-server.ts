/**
 * Standalone authenticated smart-HTTP git server for the ALI-925 rehearsal.
 *
 * Runs as its OWN process (spawned via `bun <this file>`), for the same reason
 * the fake broker does: the local-sim `SandboxSession.exec` blocks on a
 * `spawnSync` git clone, and the in-sandbox credential helper that clone drives
 * makes real HTTP calls out. A server sharing the test's event loop could not
 * answer while that loop is blocked — so the git server must be its own process.
 *
 * It proves the integrated credential path end-to-end: it (a) requires HTTP Basic
 * auth and rejects unauthenticated requests with 401 + `WWW-Authenticate`, forcing
 * git to invoke the credential helper, and (b) on authenticated requests serves a
 * real bare repo by shelling to `git http-backend` as CGI. Every Basic-auth
 * password it receives is journaled to a file so the rehearsal can assert the
 * password git presented equals the token the broker minted (git → helper →
 * broker → token → authenticated clone).
 *
 * Not shipped to end users — a test/rehearsal fixture only.
 */

import { execFileSync } from 'child_process'
import { appendFileSync } from 'fs'
import { basename, dirname, join } from 'path'

import { serveOnLoopback } from './loopback-serve.js'

interface BunLike {
  serve: (options: {
    port: number
    hostname?: string
    fetch: (request: Request) => Promise<Response> | Response
  }) => { port: number; stop: (force?: boolean) => void }
  spawn: (options: {
    cmd: string[]
    env?: Record<string, string | undefined>
    stdin?: Uint8Array | 'ignore'
    stdout?: 'pipe' | 'inherit' | 'ignore'
    stderr?: 'pipe' | 'inherit' | 'ignore'
  }) => { stdout: ReadableStream<Uint8Array>; exited: Promise<number> }
}

function bun(): BunLike {
  const b = (globalThis as { Bun?: BunLike }).Bun
  if (!b?.serve || !b?.spawn) throw new Error('hosted-git-http-server requires bun')
  return b
}

/** Resolve the `git-http-backend` CGI binary from git's exec-path. */
function resolveHttpBackend(): string {
  const execPath = execFileSync('git', ['--exec-path']).toString().trim()
  return join(execPath, 'git-http-backend')
}

export interface GitHttpConfig {
  /** Absolute path to the bare repo (e.g. `<root>/workbench.git`). */
  repoDir: string
  /** File the server appends every received `{ user, pass }` to (NDJSON). */
  authLogFile?: string
  port?: number
}

export function readGitHttpConfigFromEnv(env: NodeJS.ProcessEnv): GitHttpConfig {
  return {
    repoDir: env.HG_REPO_DIR ?? '',
    authLogFile: env.HG_AUTH_LOG,
    port: env.HG_PORT ? Number.parseInt(env.HG_PORT, 10) : undefined,
  }
}

/** The env keys the server reads (kept here so callers do not hand-roll them). */
export function gitHttpEnv(config: GitHttpConfig): Record<string, string> {
  const env: Record<string, string> = { HG_REPO_DIR: config.repoDir }
  if (config.authLogFile) env.HG_AUTH_LOG = config.authLogFile
  if (config.port !== undefined) env.HG_PORT = String(config.port)
  return env
}

/** The clone path segment a client uses (the bare repo's basename). */
export function gitHttpRepoSegment(config: GitHttpConfig): string {
  return basename(config.repoDir)
}

export function startGitHttpServer(config: GitHttpConfig): { port: number; stop: (force?: boolean) => void } {
  const backend = resolveHttpBackend()
  const projectRoot = dirname(config.repoDir)
  const unauthorized = (): Response =>
    new Response('authentication required', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="orizu-sim"' },
    })

  return serveOnLoopback(bun(), config.port, async request => {
    // (a) Require Basic auth; reject unauthenticated requests so git invokes the
    // credential helper (which mints from the broker) before retrying.
    const authHeader = request.headers.get('authorization') ?? ''
    if (!authHeader.startsWith('Basic ')) return unauthorized()
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8')
    const sep = decoded.indexOf(':')
    const user = sep >= 0 ? decoded.slice(0, sep) : decoded
    const pass = sep >= 0 ? decoded.slice(sep + 1) : ''
    // Journal the credential git presented (proves password === minted token).
    if (config.authLogFile) appendFileSync(config.authLogFile, `${JSON.stringify({ user, pass })}\n`)
    if (!pass) return unauthorized()

    // (b) Serve the bare repo via `git http-backend` as CGI.
    const url = new URL(request.url)
    const body = request.method === 'POST' ? new Uint8Array(await request.arrayBuffer()) : undefined
    const cgiEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      GIT_PROJECT_ROOT: projectRoot,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.replace(/^\?/, ''),
      REQUEST_METHOD: request.method,
      CONTENT_TYPE: request.headers.get('content-type') ?? '',
      REMOTE_USER: user,
    }
    const contentEncoding = request.headers.get('content-encoding')
    if (contentEncoding) cgiEnv.HTTP_CONTENT_ENCODING = contentEncoding
    if (body) cgiEnv.CONTENT_LENGTH = String(body.length)

    const proc = bun().spawn({
      cmd: [backend],
      env: cgiEnv,
      stdin: body ?? 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const out = Buffer.from(await new Response(proc.stdout).arrayBuffer())
    await proc.exited

    // Split the CGI response (headers, blank line, body) — body may be binary.
    let boundary = out.indexOf('\r\n\r\n')
    let boundaryLen = 4
    if (boundary < 0) {
      boundary = out.indexOf('\n\n')
      boundaryLen = 2
    }
    const headerText = boundary >= 0 ? out.subarray(0, boundary).toString('utf8') : ''
    const payload = boundary >= 0 ? out.subarray(boundary + boundaryLen) : out
    let status = 200
    const headers = new Headers()
    for (const line of headerText.split(/\r?\n/)) {
      const colon = line.indexOf(':')
      if (colon < 0) continue
      const key = line.slice(0, colon).trim()
      const value = line.slice(colon + 1).trim()
      if (key.toLowerCase() === 'status') {
        status = Number.parseInt(value, 10) || 200
        continue
      }
      headers.set(key, value)
    }
    return new Response(payload, { status, headers })
  }, 'git HTTP server')
}

// When executed directly (`bun hosted-git-http-server.ts`), start the server and
// print `LISTENING <port>` so the spawning parent can resolve the port.
if ((import.meta as { main?: boolean }).main) {
  const server = startGitHttpServer(readGitHttpConfigFromEnv(process.env))
  process.stdout.write(`LISTENING ${server.port}\n`)
}
