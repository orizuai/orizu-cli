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

import { serveOnLoopback } from './loopback-serve.js'

const RESERVED_EVENT_TYPES = new Set(['run_started', 'run_completed', 'run_failed', 'run_cancelled'])

// Mirror the PRODUCTION route (app/api/cli/workspaces/[id]/repo-token/route.ts):
// it accepts 'read' | 'write' (human) and 'session_read' | 'session_write'
// (agent, ALI-928 — flipped in lockstep with the route). Unknown purpose → 400;
// a known purpose the caller is not authorized for → 403.
const VALID_PURPOSES = new Set(['read', 'write', 'session_read', 'session_write'])
// Purposes that require write access (subject to the denyWrite simulation).
const WRITE_PURPOSES = new Set(['write', 'session_write'])

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
  /**
   * E2E mode: accept ANY non-empty Bearer (the full hosted flow uses a human
   * bearer for session/agent-token mints and a DISTINCT agent bearer for
   * run/events), and serve the full RunAPI + session + agent-token surface so
   * `startHostedSession` can be driven end to end. Off by default so the
   * bootstrap/credential-helper tests keep their strict single-bearer contract.
   */
  fullRunApi?: boolean
  /** E2E: the session id + branch the /sessions endpoint returns (so it matches
   *  a pre-seeded session branch on the local bare repo). */
  sessionId?: string
  sessionBranch?: string
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
    port: env.HB_PORT ? Number.parseInt(env.HB_PORT, 10) : undefined,
    fullRunApi: env.HB_FULL_RUN_API === '1',
    sessionId: env.HB_SESSION_ID,
    sessionBranch: env.HB_SESSION_BRANCH,
  }
}

interface StoredEvent {
  eventId: string
  sequence: number
  eventType: string
  payload: unknown
}

export function startBrokerServer(config: BrokerConfig): { port: number; stop: (force?: boolean) => void } {
  let mints = 0
  let agentTokens = 0
  let sessions = 0
  let runs = 0
  // In-memory RunAPI state (E2E mode): events + status per run, terminal record.
  const runEvents = new Map<string, StoredEvent[]>()
  const runStatus = new Map<string, string>()
  // E2E: the CURRENT valid agent token — the most recently issued by the
  // agent-token endpoint. A rotation (a fresh mint) invalidates the previous
  // token, so agent-authenticated WRITES (run start / events / terminal PATCH)
  // must present the current value; a rotated-out token is 401 (an honest
  // "old token invalidated at the broker"). Reads stay permissive so a fresh
  // human can still tail the run.
  let currentAgentToken: string | null = null
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  const authOk = (header: string): boolean =>
    config.fullRunApi ? header.startsWith('Bearer ') && header.length > 'Bearer '.length : header === `Bearer ${config.bearer}`

  // Agent-write auth (E2E only): once an agent token has been issued, an
  // agent-authenticated write MUST carry the current one.
  const agentWriteOk = (header: string): boolean =>
    currentAgentToken === null || header === `Bearer ${currentAgentToken}`

  const recordEvent = (runId: string, event: StoredEvent): void => {
    const list = runEvents.get(runId) ?? []
    list.push(event)
    runEvents.set(runId, list)
    if (config.eventsFile) {
      appendFileSync(config.eventsFile, `${JSON.stringify({ runId, ...event })}\n`)
    }
  }

  return serveOnLoopback(bun(), config.port, async request => {
    const url = new URL(request.url)
    const method = request.method.toUpperCase()
    if (!authOk(request.headers.get('authorization') ?? '')) {
      return json({ error: 'Unauthorized' }, 401)
    }
    const body =
      method === 'POST' || method === 'PATCH'
        ? ((await request.json().catch(() => ({}))) as Record<string, unknown>)
        : {}

    // -- Full RunAPI + session + agent-token (E2E mode only) --------------
    if (config.fullRunApi) {
      const sessionsMatch = url.pathname.match(/^\/api\/cli\/workspaces\/([^/]+)\/sessions$/)
      if (method === 'POST' && sessionsMatch) {
        sessions += 1
        const id = config.sessionId ?? `sess-e2e-${sessions}`
        const repoBranch = config.sessionBranch ?? `orizu/session-${id}`
        return json(
          { session: { id, workspaceId: sessionsMatch[1], repoBranch, status: 'active' } },
          201
        )
      }
      const agentTokenMatch = url.pathname.match(/^\/api\/cli\/sessions\/([^/]+)\/agent-token$/)
      if (method === 'POST' && agentTokenMatch) {
        agentTokens += 1
        const issued = `orizu_agent_e2e_${agentTokens}_${Math.random().toString(36).slice(2)}`
        // A fresh mint rotates the current token: the previous one is now stale
        // for agent-authenticated writes.
        currentAgentToken = issued
        return json(
          {
            token: issued,
            agentUserId: 'agent-user-e2e',
            sessionId: agentTokenMatch[1],
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          },
          201
        )
      }
      if (method === 'POST' && url.pathname === '/api/cli/workbench-runs') {
        if (!agentWriteOk(request.headers.get('authorization') ?? '')) {
          return json({ error: 'stale agent token' }, 401)
        }
        runs += 1
        const runId = `run-e2e-${runs}`
        runStatus.set(runId, 'running')
        recordEvent(runId, { eventId: 'run_started', sequence: 1, eventType: 'run_started', payload: {} })
        return json({ run: { id: runId, status: 'running' } }, 201)
      }
      const runEventsGet = url.pathname.match(/^\/api\/cli\/workbench-runs\/([^/]+)\/events$/)
      if (method === 'GET' && runEventsGet) {
        const runId = runEventsGet[1]
        const after = Number.parseInt(url.searchParams.get('after') ?? '0', 10) || 0
        const limit = Number.parseInt(url.searchParams.get('limit') ?? '500', 10) || 500
        const all = runEvents.get(runId) ?? []
        const page = all.filter(e => e.sequence > after).slice(0, limit)
        const cursor = page.length > 0 ? page[page.length - 1].sequence : after
        return json({ events: page, cursor, runStatus: runStatus.get(runId) ?? 'running' })
      }
      const runDetail = url.pathname.match(/^\/api\/cli\/workbench-runs\/([^/]+)$/)
      if (method === 'GET' && runDetail) {
        return json({ run: { id: runDetail[1], status: runStatus.get(runDetail[1]) ?? 'running' } })
      }
      if (method === 'PATCH' && runDetail) {
        if (!agentWriteOk(request.headers.get('authorization') ?? '')) {
          return json({ error: 'stale agent token' }, 401)
        }
        const runId = runDetail[1]
        const status = String(body.status ?? '')
        if (!['succeeded', 'failed', 'cancelled'].includes(status)) {
          return json({ error: 'invalid terminal status' }, 400)
        }
        const existing = runStatus.get(runId)
        if (existing && ['succeeded', 'failed', 'cancelled'].includes(existing)) {
          // Already terminal — Orizu records win (concurrent finisher).
          return json({ error: `Run already ${existing}` }, 409)
        }
        runStatus.set(runId, status)
        return json({ run: { id: runId, status } })
      }
    }

    const tokenMatch = url.pathname.match(/^\/api\/cli\/workspaces\/([^/]+)\/repo-token$/)
    if (method === 'POST' && tokenMatch) {
      if (config.repoTokenStatus && config.repoTokenStatus >= 400) {
        return json({ error: 'forced broker failure' }, config.repoTokenStatus)
      }
      const purpose = String(body.purpose ?? '')
      // Unknown purpose → 400 with the production route's exact error body.
      if (!VALID_PURPOSES.has(purpose)) {
        return json({ error: 'purpose must be "read", "write", "session_read", or "session_write"' }, 400)
      }
      // Simulate a read-only caller: known purpose, but unauthorized to write.
      if (config.denyWrite && WRITE_PURPOSES.has(purpose)) {
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
      // E2E: appending events is an agent-authenticated write — a rotated-out
      // token is rejected so the honest rotation test can prove re-resolve.
      if (config.fullRunApi && !agentWriteOk(request.headers.get('authorization') ?? '')) {
        return json({ error: 'stale agent token' }, 401)
      }
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
      const runId = eventsMatch[1]
      const seq = Number(sequence)
      const existingForRun = runEvents.get(runId) ?? []
      // Idempotent replay: same eventId → 201 without re-recording. Same
      // sequence, different eventId → 409 (mirrors the ingest RPC contract).
      if (existingForRun.some(e => e.eventId === eventId)) {
        return json({ eventId, id: `stored-${eventId}`, inserted: false }, 201)
      }
      if (existingForRun.some(e => e.sequence === seq)) {
        return json({ error: 'Workbench event sequence already exists for a different event_id' }, 409)
      }
      recordEvent(runId, { eventId, sequence: seq, eventType, payload: body.payload })
      return json({ eventId, id: `stored-${eventId}` }, 201)
    }

    return json({ error: `unexpected ${method} ${url.pathname}` }, 404)
  }, 'broker server')
}

// When executed directly (`bun hosted-broker-server.ts`), start the server and
// print `LISTENING <port>` so the spawning parent can resolve the port.
if ((import.meta as { main?: boolean }).main) {
  const server = startBrokerServer(readBrokerConfigFromEnv(process.env))
  process.stdout.write(`LISTENING ${server.port}\n`)
}
