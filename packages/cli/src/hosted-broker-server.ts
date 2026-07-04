/**
 * Standalone fake Orizu control-plane broker for the ALI-925 rehearsal + tests.
 *
 * This runs as its OWN process (spawned via `bun <this file>`), NOT in-process,
 * for a specific reason: the local-sim `SandboxSession.exec` uses a blocking
 * `spawnSync`, and the in-sandbox credential helper it runs makes a real HTTP
 * call back to this broker. An in-process server can't answer that call while
 * the test thread is blocked in `spawnSync` — so the broker must be a separate
 * process with its own event loop.
 *
 * It implements exactly the two contracts the bootstrap depends on:
 *   - POST /api/cli/workspaces/:id/repo-token → {token, expiresAt, repo, mintId}
 *   - POST /api/cli/workbench-runs/:id/events → 201 (rejects reserved run_* 400)
 * and it journals every accepted event / issued token to newline-delimited JSON
 * files so the parent test can read them back. Config comes from env (below).
 *
 * Not shipped to end users — a test/rehearsal fixture only.
 */

import { appendFileSync } from 'fs'

const RESERVED_EVENT_TYPES = new Set(['run_started', 'run_completed', 'run_failed', 'run_cancelled'])

// Mirror the PRODUCTION route (app/api/cli/workspaces/[id]/repo-token/route.ts)
// EXACTLY: today it accepts only 'read' | 'write'. Unknown purpose → 400 with the
// route's error body; a known purpose the caller is not authorized for → 403.
// When the G1/G2 route work flips to session_read/session_write, update this set
// (and the helper's default tokenPurposes) in lockstep.
const VALID_PURPOSES = new Set(['read', 'write'])
const WRITE_PURPOSE = 'write'

interface BunServeLike {
  serve: (options: {
    port: number
    hostname?: string
    fetch: (request: Request) => Promise<Response> | Response
  }) => { port: number; stop: (force?: boolean) => void }
}

function bun(): BunServeLike & { main?: boolean } {
  const b = (globalThis as { Bun?: BunServeLike }).Bun
  if (!b?.serve) throw new Error('hosted-broker-server requires bun')
  return b as BunServeLike
}

export interface BrokerConfig {
  bearer: string
  repo: string
  eventsFile?: string
  tokensFile?: string
  repoTokenStatus?: number
  eventsStatus?: number
  denyWrite?: boolean
  port?: number
}

export function readBrokerConfigFromEnv(env: NodeJS.ProcessEnv): BrokerConfig {
  return {
    bearer: env.HB_BEARER ?? '',
    repo: env.HB_REPO ?? 'acme/repo',
    eventsFile: env.HB_EVENTS_FILE,
    tokensFile: env.HB_TOKENS_FILE,
    repoTokenStatus: env.HB_REPO_TOKEN_STATUS ? Number.parseInt(env.HB_REPO_TOKEN_STATUS, 10) : undefined,
    eventsStatus: env.HB_EVENTS_STATUS ? Number.parseInt(env.HB_EVENTS_STATUS, 10) : undefined,
    denyWrite: env.HB_DENY_WRITE === '1',
    port: env.HB_PORT ? Number.parseInt(env.HB_PORT, 10) : 0,
  }
}

export function startBrokerServer(config: BrokerConfig): { port: number; stop: (force?: boolean) => void } {
  let mints = 0
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  return bun().serve({
    port: config.port ?? 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url)
      const method = request.method.toUpperCase()
      if ((request.headers.get('authorization') ?? '') !== `Bearer ${config.bearer}`) {
        return json({ error: 'Unauthorized' }, 401)
      }
      const body = method === 'POST' ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {}

      const tokenMatch = url.pathname.match(/^\/api\/cli\/workspaces\/([^/]+)\/repo-token$/)
      if (method === 'POST' && tokenMatch) {
        if (config.repoTokenStatus && config.repoTokenStatus >= 400) {
          return json({ error: 'forced broker failure' }, config.repoTokenStatus)
        }
        const purpose = String(body.purpose ?? '')
        // Unknown purpose → 400 with the production route's exact error body.
        if (!VALID_PURPOSES.has(purpose)) {
          return json({ error: 'purpose must be "read" or "write"' }, 400)
        }
        // Simulate a read-only caller: known purpose, but unauthorized to write.
        if (config.denyWrite && purpose === WRITE_PURPOSE) {
          return json({ error: 'Access denied' }, 403)
        }
        mints += 1
        const mintId = `mint-${mints}`
        const token = `ghs_sim_${purpose}_${mintId}_${Math.random().toString(36).slice(2)}`
        if (config.tokensFile) appendFileSync(config.tokensFile, `${token}\n`)
        return json({ token, expiresAt: new Date(Date.now() + 3600_000).toISOString(), repo: config.repo, mintId })
      }

      const eventsMatch = url.pathname.match(/^\/api\/cli\/workbench-runs\/([^/]+)\/events$/)
      if (method === 'POST' && eventsMatch) {
        if (config.eventsStatus && config.eventsStatus >= 400) {
          return json({ error: 'forced events failure' }, config.eventsStatus)
        }
        const eventType = String(body.eventType ?? '')
        const sequence = body.sequence
        const eventId = String(body.eventId ?? '')
        if (!eventId) return json({ error: 'eventId is required' }, 400)
        if (!Number.isInteger(sequence) || Number(sequence) <= 0) {
          return json({ error: 'sequence must be a positive integer' }, 400)
        }
        if (!eventType) return json({ error: 'eventType is required' }, 400)
        if (RESERVED_EVENT_TYPES.has(eventType)) return json({ error: `${eventType} is a lifecycle event` }, 400)
        if (config.eventsFile) {
          appendFileSync(
            config.eventsFile,
            `${JSON.stringify({ runId: eventsMatch[1], eventId, sequence: Number(sequence), eventType, payload: body.payload })}\n`
          )
        }
        return json({ eventId, id: `stored-${eventId}` }, 201)
      }

      return json({ error: `unexpected ${method} ${url.pathname}` }, 404)
    },
  })
}

// When executed directly (`bun hosted-broker-server.ts`), start the server and
// print `LISTENING <port>` so the spawning parent can resolve the port.
if ((import.meta as { main?: boolean }).main) {
  const server = startBrokerServer(readBrokerConfigFromEnv(process.env))
  process.stdout.write(`LISTENING ${server.port}\n`)
}
