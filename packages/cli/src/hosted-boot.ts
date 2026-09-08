/**
 * `orizu internal hosted-boot` — the in-sandbox BOOT ENTRYPOINT for the DO-path
 * hosted agent (ALI-1057). The session coordinator's Durable Object launches
 * this DETACHED (`ORIZU_SANDBOX_ENTRYPOINT`, via nohup) once it has verified the
 * pre-baked runtime marker; from here the sandbox bootstraps itself under the
 * PULL model (ALI-1055): no operator writes its credentials, and no bearer or
 * connector secret ever rests in Cloudflare.
 *
 * WHAT DIFFERS FROM THE OPERATOR PATH (packages/cli/src/hosted-session-cli.ts +
 * hosted-bootstrap.ts) — and ONLY this:
 *   (a) credentials are PULLED over HTTP at boot instead of the operator writing
 *       a 0600 bearer file: the boot secret is exchanged for a fresh Orizu agent
 *       bearer at ORIZU_AGENT_TOKEN_URL, and the connector env comes from
 *       ORIZU_ENV_BUNDLE_URL (the 5A contract — connectors only, NO model key);
 *   (b) the git credential helper runs in PULL MODE (hosted-runtime-assets.ts):
 *       it GETs a fresh bearer per git op from the agent-token URL (boot-secret
 *       auth) rather than reading a host-rotated 0600 file.
 * Everything else — the clone via the credential helper, the loop, the event
 * sink, redaction — is REUSED, not reimplemented.
 *
 * FROZEN ENV CONTRACT (workers/session-coordinator/src/bootstrap.ts
 * `planSandboxEnv`). Required (fail-fast if any is missing):
 *   ORIZU_BOOT_SECRET      the per-sandbox durable bootstrap secret;
 *   ORIZU_AGENT_TOKEN_URL  {coordinator}/sessions/:id/agent-token (bearer pull);
 *   ORIZU_ENV_BUNDLE_URL   {orizu}/api/coordinator/sessions/:id/env-bundle;
 *   ORIZU_BASE_URL         the Orizu control-plane origin;
 *   ORIZU_SESSION_ID       this session id.
 * Present-but-optional in the contract, resolved from the control plane when
 * absent: ORIZU_RUN_ID, ORIZU_WORKSPACE_ID (read back from the session), and the
 * non-secret ANTHROPIC_API_KEY dummy placeholder (firewall brokers the real key).
 */

import { spawnSync } from 'child_process'
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeSync } from 'fs'

import { isValidCloudflareArtifactsGitRemote } from './cloudflare-artifacts-git-remote.js'
import {
  AGENT_GIT_IDENTITY,
  BEARER_BASENAME,
  BOOT_CONTEXT_BASENAME,
  DEFAULT_CACHE_REFRESH_BUFFER_MS,
  HELPER_SCRIPT_BASENAME,
  REPO_CRED_CACHE_BASENAME,
  renderCredentialHelperScript,
  serializeBootContext,
  type HostedBootContext,
} from './hosted-runtime-assets.js'
import {
  INJECTED_ENV_VARS_ENV,
  closeHostedLoopSession,
  runHostedLoop,
  runHostedLoopTurn,
  startHostedLoopSession,
  type HostedLoopContext,
  type HostedLoopResult,
  type HostedLoopSessionContext,
} from './hosted-loop.js'
import { DEFAULT_EGRESS_CANARY_HOST, DEFAULT_HOSTED_MODEL } from './hosted-loop-lifecycle.js'
import { composeHostedAnswerPrompt } from './hosted-question.js'
import { resumeRunEventSink } from './hosted-run-event-sink.js'
import { stageOrizuSkill } from './hosted-skill-staging.js'

export type BootFetch = (url: string, init?: RequestInit) => Promise<Response>

/** Non-secret placeholder model key (firewall brokers the real org key on
 *  egress). Byte-for-byte the operator path's constant
 *  (packages/cli/src/hosted-session-cli.ts `ANTHROPIC_DUMMY_KEY` and the
 *  DO-path `workers/session-coordinator/src/bootstrap.ts`); kept in sync by
 *  grep. Inlined (not imported) to avoid a hosted-session-cli import cycle. */
const ANTHROPIC_DUMMY_KEY = 'sk-ant-orizu-proxy-broker-placeholder'

// -- Frozen env contract ------------------------------------------------------

export const REQUIRED_BOOT_ENV_VARS = [
  'ORIZU_BOOT_SECRET',
  'ORIZU_AGENT_TOKEN_URL',
  'ORIZU_ENV_BUNDLE_URL',
  'ORIZU_BASE_URL',
  'ORIZU_SESSION_ID',
] as const

export interface HostedBootEnv {
  bootSecret: string
  agentTokenUrl: string
  /** {coordinator}/sessions/:id/boot-status — the ALI-1060 agent-liveness
   *  callback, derived from agentTokenUrl (same boot-secret auth). */
  bootStatusUrl: string
  envBundleUrl: string
  baseUrl: string
  sessionId: string
  /** Present in the contract only for resume flows; else resolved server-side. */
  runId: string | null
  /** Rarely set by the DO (the start body carries no workspace id); read back
   *  from the session when absent. */
  workspaceId: string | null
  /** Non-secret dummy the firewall rewrites on egress — never a real key. */
  anthropicDummyKey: string | null
}

/** Validate the frozen env contract. A list of missing REQUIRED names means the
 *  boot must FAIL FAST with a clear error (the DO records the non-zero exit). */
export function resolveHostedBootEnv(
  env: Record<string, string | undefined>
): { ok: true; value: HostedBootEnv } | { ok: false; missing: string[] } {
  const missing: string[] = []
  const req = (name: string): string => {
    const value = env[name]?.trim()
    if (!value) missing.push(name)
    return value ?? ''
  }
  const bootSecret = req('ORIZU_BOOT_SECRET')
  const agentTokenUrl = req('ORIZU_AGENT_TOKEN_URL')
  const envBundleUrl = req('ORIZU_ENV_BUNDLE_URL')
  const baseUrl = req('ORIZU_BASE_URL')
  const sessionId = req('ORIZU_SESSION_ID')
  if (missing.length > 0) return { ok: false, missing }
  return {
    ok: true,
    value: {
      bootSecret,
      agentTokenUrl,
      // The boot-status route is the agent-token route's sibling on the same
      // coordinator, same boot-secret auth (ALI-1060). Deriving it here means no
      // new env var in the frozen contract / planSandboxEnv.
      bootStatusUrl: deriveBootStatusUrl(agentTokenUrl),
      envBundleUrl,
      baseUrl: baseUrl.replace(/\/+$/, ''),
      sessionId,
      runId: env.ORIZU_RUN_ID?.trim() || null,
      workspaceId: env.ORIZU_WORKSPACE_ID?.trim() || null,
      anthropicDummyKey: env.ANTHROPIC_API_KEY?.trim() || null,
    },
  }
}

/** The boot-status route is the agent-token route's sibling; swap the trailing
 *  path segment. Falls back to appending when the shape is unexpected. */
export function deriveBootStatusUrl(agentTokenUrl: string): string {
  if (/\/agent-token\/?$/.test(agentTokenUrl)) {
    return agentTokenUrl.replace(/\/agent-token\/?$/, '/boot-status')
  }
  return `${agentTokenUrl.replace(/\/+$/, '')}/boot-status`
}

// -- Boot-status callback (ALI-1060) ------------------------------------------

/** Max chars of the failure reason reported to the coordinator. A boot reason
 *  is never a place for a secret; this bounds it anyway, and we scrub the boot
 *  secret defensively before sending. */
const MAX_BOOT_REASON_CHARS = 800
const TURN_STATUS_ATTEMPT_TIMEOUT_MS = 10_000

function resolveTestPositiveInteger(
  processEnv: Record<string, string | undefined>,
  name: string,
  maximum = Number.MAX_SAFE_INTEGER
): number | undefined {
  const configured = processEnv.NODE_ENV === 'test' ? processEnv[name] : undefined
  if (!configured || !/^\d+$/u.test(configured)) return undefined
  const value = Number(configured)
  return value > 0 && value <= maximum ? value : undefined
}

function resolveTurnStatusAttemptTimeoutMs(
  processEnv: Record<string, string | undefined>
): number | undefined {
  return resolveTestPositiveInteger(processEnv, 'ORIZU_HOSTED_TEST_TURN_STATUS_TIMEOUT_MS')
}

/** Best-effort scrub + truncate for a reported failure reason: never leak the
 *  boot secret (the one credential the boot always holds), and keep it short. */
export function redactBootReason(reason: string, bootSecret: string): string {
  let out = reason
  if (bootSecret && out.includes(bootSecret)) {
    out = out.split(bootSecret).join('[redacted]')
  }
  return out.slice(0, MAX_BOOT_REASON_CHARS)
}

/**
 * Report the boot outcome to the coordinator's boot-status route (ALI-1060),
 * authed with the boot secret (same as the agent-token pull). Best-effort: the
 * DO's own readiness-timeout is the backstop if this never lands, so a failed
 * report must never mask the boot result. NEVER logs the secret.
 */
export async function postBootStatus(opts: {
  bootStatusUrl: string
  bootSecret: string
  /** 'ready' | 'failed' are the ALI-1060 liveness signals; 'complete' is the
   *  ALI-1064 terminal signal — the loop finished (after auto-harvest), so the
   *  DO ends the workspace session and stops instead of extending to 24h. */
  status: 'ready' | 'failed' | 'complete' | 'turn_failed'
  runId: string | null
  reason?: string | null
  fetchImpl: BootFetch
  log?: (line: string) => void
}): Promise<void> {
  try {
    const res = await opts.fetchImpl(opts.bootStatusUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.bootSecret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: opts.status,
        ...(opts.runId ? { runId: opts.runId } : {}),
        ...(opts.reason ? { reason: opts.reason } : {}),
      }),
    })
    opts.log?.(`boot-status ${opts.status} reported (${res.status})`)
  } catch (error) {
    opts.log?.(`boot-status ${opts.status} report failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function postRequiredIdleReady(opts: {
  bootStatusUrl: string
  bootSecret: string
  fetchImpl: BootFetch
  sleep: (ms: number) => Promise<void>
  attemptTimeoutMs?: number
}): Promise<void> {
  let detail = 'not attempted'
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await opts.fetchImpl(opts.bootStatusUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.bootSecret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'ready' }),
        signal: AbortSignal.timeout(opts.attemptTimeoutMs ?? TURN_STATUS_ATTEMPT_TIMEOUT_MS),
      })
      if (response.ok) return
      detail = `status ${response.status}`
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error)
    }
    if (attempt < 4) await opts.sleep(250 * 2 ** attempt)
  }
  throw new Error(`ready acknowledgement failed: ${detail}`)
}

async function postTurnStatus(opts: {
  bootStatusUrl: string
  bootSecret: string
  status: 'turn_started' | 'turn_completed' | 'turn_failed'
  runId: string
  reason?: string | null
  fetchImpl: BootFetch
  sleep?: (ms: number) => Promise<void>
  attemptTimeoutMs?: number
}): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  let detail = 'not attempted'
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await opts.fetchImpl(opts.bootStatusUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.bootSecret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: opts.status,
          runId: opts.runId,
          ...(opts.reason ? { reason: opts.reason } : {}),
        }),
        signal: AbortSignal.timeout(opts.attemptTimeoutMs ?? TURN_STATUS_ATTEMPT_TIMEOUT_MS),
      })
      if (response.ok) return
      detail = `status ${response.status}`
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error)
    }
    if (attempt < 4) await sleep(250 * 2 ** attempt)
  }
  throw new Error(`${opts.status} acknowledgement failed: ${detail}`)
}

// -- Bearer pull (boot secret -> fresh agent bearer, retry/backoff) -----------

export interface PulledBearer {
  token: string
  /** Epoch ms, or null when the response omitted a parseable expiry. */
  expiresAtMs: number | null
}

export interface PullAgentBearerOptions {
  agentTokenUrl: string
  bootSecret: string
  fetchImpl: BootFetch
  /** Total attempts before giving up (the DO may still be arming). Default 5. */
  attempts?: number
  /** Base backoff in ms (doubles each retry). Default 500. */
  backoffMs?: number
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
}

/**
 * Exchange the boot secret for a fresh Orizu agent bearer at the coordinator's
 * agent-token route (`GET`, `Authorization: Bearer <boot secret>` → 200
 * `{token, tokenId, expiresAt}`). Retries with exponential backoff: the DO
 * persists the boot-secret digest and serves this route DURING bootstrap, but a
 * transient mint failure (control-plane blip) should not abort the whole boot.
 * The secret is NEVER logged.
 */
export async function pullAgentBearer(opts: PullAgentBearerOptions): Promise<PulledBearer> {
  const attempts = Math.max(1, opts.attempts ?? 5)
  const baseBackoff = opts.backoffMs ?? 500
  const sleep = opts.sleep ?? ((ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms)))
  let lastDetail = 'no attempt made'
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await opts.fetchImpl(opts.agentTokenUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${opts.bootSecret}` },
      })
      if (res.ok) {
        const data = (await res.json().catch(() => null)) as { token?: unknown; expiresAt?: unknown } | null
        const token = data && typeof data.token === 'string' ? data.token : ''
        if (token) {
          const expiry = data && typeof data.expiresAt === 'string' ? Date.parse(data.expiresAt) : NaN
          return { token, expiresAtMs: Number.isFinite(expiry) ? expiry : null }
        }
        lastDetail = 'agent-token response carried no token'
      } else {
        lastDetail = `agent-token pull returned ${res.status}`
      }
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : String(error)
    }
    if (attempt < attempts - 1) {
      const delay = baseBackoff * 2 ** attempt
      opts.log?.(`agent-token pull attempt ${attempt + 1}/${attempts} failed (${lastDetail}); retrying in ${delay}ms`)
      await sleep(delay)
    }
  }
  throw new Error(`agent-token pull failed after ${attempts} attempts: ${lastDetail}`)
}

// -- Env bundle (connectors only; NO model key) -------------------------------

export interface EnvBundleConnector {
  ref: string
  envVar: string
  value: string
}

export interface EnvBundle {
  sessionId: string | null
  connectors: EnvBundleConnector[]
  redactEnvVars: string[]
}

/**
 * Pull the connector env bundle (5A contract): `GET` with the agent bearer → 200
 * `{sessionId, connectors:[{ref,envVar,value}], redactEnvVars:[...]}`. The model
 * key is DELIBERATELY absent (brokered at the firewall). Never logs a value.
 */
export async function fetchEnvBundle(opts: {
  envBundleUrl: string
  bearer: string
  fetchImpl: BootFetch
}): Promise<EnvBundle> {
  const res = await opts.fetchImpl(opts.envBundleUrl, {
    method: 'GET',
    headers: { Authorization: `Bearer ${opts.bearer}` },
  })
  if (!res.ok) throw new Error(`env-bundle pull returned ${res.status}`)
  const data = (await res.json().catch(() => null)) as Partial<EnvBundle> | null
  if (!data || typeof data !== 'object') throw new Error('env-bundle response was not a JSON object')
  const connectors = Array.isArray(data.connectors)
    ? data.connectors.filter(
        (c): c is EnvBundleConnector =>
          !!c && typeof c === 'object' && typeof (c as EnvBundleConnector).envVar === 'string' && typeof (c as EnvBundleConnector).value === 'string'
      )
    : []
  const redactEnvVars = Array.isArray(data.redactEnvVars)
    ? data.redactEnvVars.filter((v): v is string => typeof v === 'string')
    : connectors.map(c => c.envVar)
  return {
    sessionId: typeof data.sessionId === 'string' ? data.sessionId : null,
    connectors,
    redactEnvVars,
  }
}

/**
 * Export each connector `{envVar: value}` into the environment the loop/agent
 * inherits, and REGISTER every redacted var on `ORIZU_INJECTED_ENV_VARS` — the
 * exact hook the in-sandbox loop reads (`redactionListFromEnv`) to scrub these
 * values from run events. Returns the merged redaction-var list.
 */
export function applyEnvBundle(bundle: EnvBundle, env: Record<string, string | undefined>): string[] {
  if (bundle.connectors.some(connector => connector.envVar.startsWith('ORIZU_'))) {
    throw new Error('reserved_connector_env: connector env vars must not use ORIZU_*')
  }
  for (const connector of bundle.connectors) {
    env[connector.envVar] = connector.value
  }
  const existing = (env[INJECTED_ENV_VARS_ENV] ?? '')
    .split(',')
    .map(name => name.trim())
    .filter(name => name.length > 0)
  // Redact EVERY exported connector var, not only the server's redactEnvVars
  // list (review F4 defense-in-depth): if a compromised/misbehaving bundle
  // returned connectors with a partial/empty redactEnvVars, their values would
  // otherwise reach run events unscrubbed. We export the value, so we redact it.
  const connectorVars = bundle.connectors.map(c => c.envVar)
  const merged = Array.from(new Set([...existing, ...bundle.redactEnvVars, ...connectorVars]))
  env[INJECTED_ENV_VARS_ENV] = merged.join(',')
  return merged
}

// -- Session / run / repo resolution (agent-bearer control-plane reads) --------

export interface PendingHostedTurn {
  turnId: string | null
  ordinal: number
  runId: string
  body: string
  clientMessageId: string
  answerToQuestion: { questionId: string; question: string } | null
}

function promptForPendingHostedTurn(turn: PendingHostedTurn): string {
  return turn.answerToQuestion
    ? composeHostedAnswerPrompt(turn.answerToQuestion, turn.body)
    : turn.body
}

export interface ResolvedSession {
  workspaceId: string
  repoBranch: string
  task: string
  model: string | null
  reasoningEffort: string | null
  surface: string | null
  status: string | null
  pendingTurn: PendingHostedTurn | null
  interruptRequestedRunId: string | null
  agentSessionId: string | null
  projectId: string | null
  /** Session lifetime in minutes (from client_info), if the coordinator recorded
   *  it — used to derive the per-prompt max-duration cap (ALI-1061). */
  durationMinutes: number | null
  /** Existing run selected by the service response, if any. */
  runId: string | null
  runStatus: string | null
}

async function bearerJson(
  fetchImpl: BootFetch,
  url: string,
  bearer: string,
  init: RequestInit = {}
): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${bearer}` },
  })
  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${new URL(url).pathname} failed (${res.status})`)
  }
  return (await res.json().catch(() => ({}))) as Record<string, unknown>
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asPositiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/** GET the session (agent-capable, RLS-scoped) to learn its workspace, branch,
 *  task, and any existing run — the DO start body carries none of these. */
export async function resolveSession(opts: {
  baseUrl: string
  sessionId: string
  bearer: string
  fetchImpl: BootFetch
  signal?: AbortSignal
}): Promise<ResolvedSession> {
  const body = await bearerJson(
    opts.fetchImpl,
    `${opts.baseUrl}/api/cli/sessions/${encodeURIComponent(opts.sessionId)}`,
    opts.bearer,
    opts.signal ? { signal: opts.signal } : {}
  )
  const session = (body.session ?? {}) as Record<string, unknown>
  const workspaceId = asString(session.workspaceId)
  if (!workspaceId) throw new Error('session response carried no workspaceId')
  const repoBranch = asString(session.repoBranch)
  if (!repoBranch) throw new Error('session response carried no repoBranch (branch not provisioned)')
  const clientInfo = (session.clientInfo ?? {}) as Record<string, unknown>
  const initialTask = asString(clientInfo.task)
  if (!initialTask) throw new Error('session client_info carried no task prompt')
  const runs = Array.isArray(session.runs) ? (session.runs as Array<Record<string, unknown>>) : []
  const pending = session.pendingTurn && typeof session.pendingTurn === 'object'
    ? session.pendingTurn as Record<string, unknown> : null
  const answer = pending?.answerToQuestion && typeof pending.answerToQuestion === 'object'
    ? pending.answerToQuestion as Record<string, unknown>
    : null
  const answerToQuestion = answer && asString(answer.questionId) && asString(answer.question)
    ? { questionId: answer.questionId as string, question: answer.question as string }
    : null
  const hasValidTurnId = pending?.turnId === null || asString(pending?.turnId) !== null
  const pendingTurn = pending && hasValidTurnId &&
      Number.isSafeInteger(pending.ordinal) && (pending.ordinal as number) > 0 &&
      asString(pending.runId) && asString(pending.body) && asString(pending.clientMessageId) &&
      (pending.answerToQuestion === null || answerToQuestion)
    ? {
        turnId: pending.turnId === null ? null : pending.turnId as string,
        ordinal: pending.ordinal as number,
        runId: pending.runId as string,
        body: pending.body as string,
        clientMessageId: pending.clientMessageId as string,
        answerToQuestion,
      }
    : null
  if (pending && !pendingTurn) throw new Error('hosted_pending_turn_invalid')
  const unfinishedRun = pendingTurn
    ? runs.find(run => asString(run.id) === pendingTurn.runId &&
        (run.status === 'pending' || run.status === 'running'))
    : null
  // The route orders runs newest-first. Resume the service-selected lowest
  // unfinished turn; only when none exists do we fall back to the initial
  // (oldest) run and its original task.
  const selectedRun = unfinishedRun ?? runs.at(-1)
  const runId = asString(selectedRun?.id)
  return {
    workspaceId,
    repoBranch,
    task: unfinishedRun ? promptForPendingHostedTurn(pendingTurn!) : initialTask,
    model: asString(clientInfo.model),
    reasoningEffort: asString(clientInfo.reasoningEffort),
    surface: asString(clientInfo.surface),
    durationMinutes: asPositiveNumber(clientInfo.durationMinutes),
    runId,
    runStatus: asString(selectedRun?.status),
    status: asString(session.status),
    pendingTurn: unfinishedRun ? pendingTurn : null,
    interruptRequestedRunId: asString(session.interruptRequestedRunId),
    agentSessionId: asString(session.agentSessionId),
    projectId: asString(session.projectId),
  }
}

/** Ride the ALI-1757 session/pending-turn poll while one prompt is active.
 *  This uses the same additive session GET contract, but deliberately shares
 *  none of the between-turn credential cleanup or mint-on-401 behavior: the
 *  session-stable bearer file is live ORIZU_TOKEN_FILE for the prompt. */
export async function pollHostedSessionDuringTurn(opts: {
  baseUrl: string
  sessionId: string
  runId: string
  bearerFileAbs: string
  fetchImpl: BootFetch
  signal: AbortSignal
  onInterrupt: () => void
  onDiagnostic?: (message: string) => void
  readFile?: (path: string) => string
  sleep?: (ms: number) => Promise<void>
}): Promise<void> {
  const diagnose = (message: string): void => {
    try { opts.onDiagnostic?.(message) } catch { /* diagnostics are best-effort */ }
  }
  const readFile = opts.readFile ?? ((path: string): string => readFileSync(path, 'utf8'))
  const sleep = opts.sleep ?? ((ms: number): Promise<void> => new Promise(resolve => {
    if (opts.signal.aborted) { resolve(); return }
    const timer = setTimeout(finish, ms)
    const handleAbort = (): void => finish()
    function finish(): void {
      clearTimeout(timer)
      opts.signal.removeEventListener('abort', handleAbort)
      resolve()
    }
    opts.signal.addEventListener('abort', handleAbort, { once: true })
  }))
  while (!opts.signal.aborted) {
    try {
      const latest = await resolveSession({
        baseUrl: opts.baseUrl,
        sessionId: opts.sessionId,
        bearer: readFile(opts.bearerFileAbs).trim(),
        signal: AbortSignal.any([
          opts.signal,
          AbortSignal.timeout(10_000),
        ]),
        fetchImpl: (url, init) => {
          const headers = new Headers(init?.headers)
          // Additive, authority-free discriminator: existing session GET
          // remains the one endpoint, while fixtures/observability can separate
          // prompt-time health reads from between-turn queue consumption.
          headers.set('x-orizu-hosted-poll', 'during-turn')
          return opts.fetchImpl(url, { ...init, headers })
        },
      })
      if (latest.interruptRequestedRunId === opts.runId) {
        try {
          opts.onInterrupt()
        } catch {
          diagnose('hosted interrupt callback failed; request will not be redelivered')
        }
        return
      }
    } catch {
      // Fixed, value-free diagnostic: bearer values and response bodies never
      // enter logs. A transient read failure cannot fail the running turn.
      diagnose('hosted interrupt poll failed; retrying')
    }
    if (!opts.signal.aborted) await sleep(5_000)
  }
}

/** Reuse an existing run or start one with the AGENT bearer (actor_type='agent'),
 *  exactly like the operator path's run-start step. */
export async function ensureRun(opts: {
  baseUrl: string
  sessionId: string
  bearer: string
  fetchImpl: BootFetch
  existingRunId: string | null
  title?: string
}): Promise<string> {
  if (opts.existingRunId) return opts.existingRunId
  const body = await bearerJson(opts.fetchImpl, `${opts.baseUrl}/api/cli/workbench-runs`, opts.bearer, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspaceSessionId: opts.sessionId,
      title: opts.title ?? `Hosted session ${opts.sessionId}`,
    }),
  })
  const run = (body.run ?? {}) as Record<string, unknown>
  const runId = asString(run.id)
  if (!runId) throw new Error('workbench-run start returned no run id')
  return runId
}

/** Emit the RunAPI-reserved run_started transition for a pre-created turn.
 *  Idempotent for the initial run, which may already be running. */
export async function beginRunExecution(opts: {
  baseUrl: string
  runId: string
  bearer: string
  fetchImpl: BootFetch
  sleep?: (ms: number) => Promise<void>
  attemptTimeoutMs?: number
}): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  let detail = 'not attempted'
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await bearerJson(
        opts.fetchImpl,
        `${opts.baseUrl}/api/cli/workbench-runs/${encodeURIComponent(opts.runId)}`,
        opts.bearer,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
          signal: AbortSignal.timeout(opts.attemptTimeoutMs ?? TURN_STATUS_ATTEMPT_TIMEOUT_MS),
        }
      )
      return
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error)
    }
    if (attempt < 4) await sleep(250 * 2 ** attempt)
  }
  throw new Error(`run_started transition failed: ${detail}`)
}

/** Mint a session_read repo token to learn the repo full name, then build the
 *  GitHub clone URL (mirrors the operator path's `defaultResolveRepo`). */
export async function resolveRepo(opts: {
  baseUrl: string
  workspaceId: string
  sessionId: string
  bearer: string
  fetchImpl: BootFetch
}): Promise<{ repoFullName: string; cloneUrl: string }> {
  const url = `${opts.baseUrl}/api/cli/workspaces/${encodeURIComponent(opts.workspaceId)}/repo-token`
  const minted = await bearerJson(opts.fetchImpl, url, opts.bearer, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ purpose: 'session_read', sessionId: opts.sessionId }),
  })
  const provider = asString(minted.provider)
  const artifactsRemote = asString(minted.remote)
  if (provider === 'cloudflare_artifacts') {
    if (!artifactsRemote) {
      throw new Error(
        'repo-token response carried no Artifacts remote'
      )
    }
    if (!isValidCloudflareArtifactsGitRemote(artifactsRemote)) {
      throw new Error(
        'repo-token response carried an invalid Artifacts remote'
      )
    }
    return {
      repoFullName: artifactsRemote,
      cloneUrl: artifactsRemote,
    }
  }
  if (artifactsRemote) {
    throw new Error(
      'repo-token response carried an unexpected provider remote'
    )
  }
  const repoFullName = asString(minted.repo)
  if (!repoFullName) throw new Error('repo-token response carried no repo')
  // We deliberately do NOT early-revoke this probe token (ALI-1069): the
  // repo-token DELETE route is HUMAN-ONLY (`requireCliSupabase` default-denies
  // agent bearers), so an agent-bearer revoke would always 401 — a guaranteed
  // failed request per boot, not a real revoke. Let the short (~60-min)
  // session_read TTL expire on its own; the credential helper mints its own
  // per-op tokens for the actual clone/fetch/push, so this probe token is never
  // reused after we read `repo` from it.
  return { repoFullName, cloneUrl: `https://github.com/${repoFullName}.git` }
}

// -- Local sandbox filesystem / git seam --------------------------------------

export interface BootExecResult {
  status: number
  stdout: string
  stderr: string
}
export type BootExec = (cmd: string, args: string[], opts?: { cwd?: string }) => BootExecResult

const defaultExec: BootExec = (cmd, args, opts) => {
  const res = spawnSync(cmd, args, { cwd: opts?.cwd, encoding: 'utf8' })
  return { status: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/** Values interpolated into git's credential.helper string / clone args must be
 *  benign. We pass everything via execFile-style arg arrays (no shell), but
 *  still reject anything with newlines/control chars as defense in depth. */
const SAFE_GIT_VALUE = /^[A-Za-z0-9._/:@+ -]+$/
function assertSafeGitValue(name: string, value: string): void {
  if (!SAFE_GIT_VALUE.test(value)) {
    throw new Error(`unsafe characters in ${name}; refusing to pass to git`)
  }
}

/**
 * Path-safety for the run id BEFORE it is interpolated into `.orizu-run/${runId}`
 * (ALI-1060). ORIZU_RUN_ID can be CALLER-SUPPLIED (resume flows), and unlike the
 * boot-created uuid it is untrusted — a `../` value would escape the run dir and
 * let boot assets (0600 bearer/boot-secret files) land outside it. A run id is a
 * single opaque segment: allow only `[A-Za-z0-9._-]` and reject any `..`, so no
 * separators or traversal survive. Stricter than the operator path's shared
 * shell-value assertion (which allows `/`), applied to the same value.
 */
const SAFE_RUN_ID = /^[A-Za-z0-9._-]+$/
export function assertSafeRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId) || runId.includes('..')) {
    throw new Error('unsafe run id; refusing to build run-dir paths')
  }
}

function writeSecretFile(path: string, contents: string, write: (p: string, c: string) => void): void {
  write(path, contents.endsWith('\n') ? contents : `${contents}\n`)
}

// -- Boot orchestration -------------------------------------------------------

export interface RunHostedBootOptions {
  env: HostedBootEnv
  /** Mutable env map the loop/agent inherits (default: process.env). */
  processEnv?: Record<string, string | undefined>
  /** Sandbox root the run dir + repo live under (default: process.cwd()). */
  root?: string
  fetchImpl?: BootFetch
  exec?: BootExec
  /** File writer (default: atomic 0600 temp+rename). Injected in tests. */
  writeFile?: (path: string, contents: string) => void
  /** File reader (default: readFileSync utf8). Injected in tests so the
   *  bearer-provider read is backed by the same store as writeFile. */
  readFile?: (path: string) => string
  /** Dir maker (default: recursive mkdir). Injected in tests. */
  mkdirp?: (path: string) => void
  /** Run the loop (default: `runHostedLoop`). Injected in tests. */
  runLoop?: (input: {
    context: HostedLoopContext
    taskPrompt: string
    bearerProvider: () => string
    /** Verbatim secrets the loop's event redaction must scrub (ALI-1062: the
     *  boot secret — bare hex, so no shape pattern would ever catch it). */
    redactSecretsList: readonly string[]
  }) => Promise<HostedLoopResult>
  now?: () => number
  log?: (line: string) => void
  /** Bearer-pull tuning (passed through to `pullAgentBearer`). */
  bearerAttempts?: number
  bearerBackoffMs?: number
  sleep?: (ms: number) => Promise<void>
  /** ALI-1060: invoked once the run id + agent bearer are known (after
   *  ensureRun), so a caller can report/mark on a LATER throw. */
  onBootContext?: (ctx: { runId: string; bearer: string }) => void
}

class HostedTurnFailure extends Error {}

export interface HostedBootResult {
  ok: boolean
  runId: string | null
  loopStatus: string | null
  error: string | null
}

/**
 * The full in-sandbox boot: validate → pull bearer → pull+apply env bundle →
 * resolve session/run/repo → write the pull-mode credential assets → clone the
 * session branch → launch the hosted loop (reused, in-process) with a bearer
 * provider fed by the same pull-mode source. Returns the loop's terminal status.
 */
export async function runHostedBoot(opts: RunHostedBootOptions): Promise<HostedBootResult> {
  const env = opts.env
  const processEnv = opts.processEnv ?? process.env
  const root = opts.root ?? process.cwd()
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as BootFetch)
  const exec = opts.exec ?? defaultExec
  const mkdirp = opts.mkdirp ?? ((path: string): void => void mkdirSync(path, { recursive: true }))
  const writeFile =
    opts.writeFile ??
    ((path: string, contents: string): void => {
      // Atomic write (review F2): write a 0600 temp then rename, so a reader
      // (the loop reading the bearer file per request, or the credential
      // helper) never observes a truncated file mid-rotation. Single writer
      // per path (the rotation timer), so a fixed .tmp suffix is safe.
      const tmp = `${path}.tmp`
      const fd = openSync(tmp, 'w', 0o600)
      try {
        writeSync(fd, contents)
      } finally {
        closeSync(fd)
      }
      renameSync(tmp, path)
    })
  const readFile = opts.readFile ?? ((path: string): string => readFileSync(path, 'utf8'))
  const log = opts.log ?? ((): void => {})
  const now = opts.now ?? ((): number => Date.now())
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const testRotationMinimum = processEnv.NODE_ENV === 'test'
    ? processEnv.ORIZU_HOSTED_TEST_BEARER_ROTATION_MIN_DELAY_MS
    : undefined
  const bearerRotationMinimumDelayMs = testRotationMinimum && /^\d+$/u.test(testRotationMinimum)
    ? Number(testRotationMinimum)
    : undefined
  const turnStatusAttemptTimeoutMs = resolveTurnStatusAttemptTimeoutMs(processEnv)
  const idlePollMs = resolveTestPositiveInteger(processEnv, 'ORIZU_HOSTED_TEST_IDLE_POLL_MS') ?? 5_000
  const idleReadBackoffCapMs = resolveTestPositiveInteger(
    processEnv, 'ORIZU_HOSTED_TEST_IDLE_READ_BACKOFF_CAP_MS'
  ) ?? 45_000

  // 0 — ENV HYGIENE (ALI-1062): the boot secret is the DO path's only durable
  // credential (it mints agent bearers at the internet-reachable agent-token
  // route for up to 24h), and `env.bootSecret` is already captured — so scrub
  // the raw value from the process env NOW, before anything downstream can
  // inherit it: the opencode/agent process is spawned with `{...process.env}`
  // (nodeChildSpawner) and the customer `.orizu/setup.sh` hook inherits the
  // env too. Nothing reads it from the env after this point — the rotation /
  // boot-status closures hold `env.bootSecret`, and the git credential helper
  // reads the 0600 run-dir boot-secret FILE (written in step 4).
  delete processEnv.ORIZU_BOOT_SECRET
  if (env.runId) assertSafeRunId(env.runId)

  // 1 — Pull the agent bearer (retry/backoff — the DO may still be arming).
  let bearer = await pullAgentBearer({
    agentTokenUrl: env.agentTokenUrl,
    bootSecret: env.bootSecret,
    fetchImpl,
    attempts: opts.bearerAttempts,
    backoffMs: opts.bearerBackoffMs,
    sleep: opts.sleep,
    log,
  })
  log('agent bearer pulled')

  // 2 — Pull the connector env bundle and export it (+ register redaction).
  const bundle = await fetchEnvBundle({ envBundleUrl: env.envBundleUrl, bearer: bearer.token, fetchImpl })
  const redacted = applyEnvBundle(bundle, processEnv)
  log(`env bundle applied (${bundle.connectors.length} connectors, ${redacted.length} redacted vars)`)

  // 3 — Resolve the session (workspace/branch/task) + run + repo from the plane.
  let session = await resolveSession({ baseUrl: env.baseUrl, sessionId: env.sessionId, bearer: bearer.token, fetchImpl })
  let currentNonTerminalRunId = session.runStatus === 'pending' || session.runStatus === 'running'
    ? session.runId
    : null
  // Production restarts with no live run are between turns. Prove this boot is
  // live before waiting so the coordinator's readiness timeout cannot reap an
  // intentionally idle sandbox before the longer hosted idle policy applies.
  if (!opts.runLoop && !currentNonTerminalRunId) {
    await postRequiredIdleReady({
      bootStatusUrl: env.bootStatusUrl,
      bootSecret: env.bootSecret,
      fetchImpl,
      sleep,
      attemptTimeoutMs: turnStatusAttemptTimeoutMs,
    })
  }
  let consecutiveIdleSessionReadFailures = 0
  const recordIdleSessionReadFailure = (detail: string): void => {
    consecutiveIdleSessionReadFailures += 1
    if (consecutiveIdleSessionReadFailures >= 10) {
      throw new Error(`idle session read failed after 10 attempts: ${detail}`)
    }
    log(`idle session resolution failed; retrying (${detail})`)
  }
  while (!opts.runLoop && !currentNonTerminalRunId) {
    await sleep(Math.min(
      idlePollMs * 2 ** consecutiveIdleSessionReadFailures,
      idleReadBackoffCapMs
    ))
    try {
      if (bearer.expiresAtMs !== null && bearer.expiresAtMs <= now() + 60_000) {
        bearer = await pullAgentBearer({
          agentTokenUrl: env.agentTokenUrl, bootSecret: env.bootSecret,
          fetchImpl, attempts: 3, backoffMs: 250, sleep, log,
        })
      }
      session = await resolveSession({
        baseUrl: env.baseUrl, sessionId: env.sessionId, bearer: bearer.token, fetchImpl,
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (detail.startsWith('agent-token pull failed after')) {
        throw new Error(`idle agent-token refresh failed: ${detail}`)
      }
      if (!detail.includes('(401)')) {
        recordIdleSessionReadFailure(detail)
        continue
      }
      try {
        bearer = await pullAgentBearer({
          agentTokenUrl: env.agentTokenUrl, bootSecret: env.bootSecret,
          fetchImpl, attempts: 3, backoffMs: 250, sleep, log,
        })
        session = await resolveSession({
          baseUrl: env.baseUrl, sessionId: env.sessionId, bearer: bearer.token, fetchImpl,
        })
      } catch (retryError) {
        const detail = retryError instanceof Error ? retryError.message : String(retryError)
        if (detail.startsWith('agent-token pull failed after')) {
          throw new Error(`idle agent-token refresh failed: ${detail}`)
        }
        recordIdleSessionReadFailure(detail)
        continue
      }
    }
    consecutiveIdleSessionReadFailures = 0
    if (session.status && session.status !== 'active') {
      return { ok: true, runId: null, loopStatus: null, error: null }
    }
    currentNonTerminalRunId = session.runStatus === 'pending' || session.runStatus === 'running'
      ? session.runId
      : null
  }
  const workspaceId = env.workspaceId ?? session.workspaceId
  // A non-null production run came from current session authority. Only the
  // injected one-shot test seam may create a missing run.
  const runId = currentNonTerminalRunId ?? await ensureRun({
    baseUrl: env.baseUrl,
    sessionId: env.sessionId,
    bearer: bearer.token,
    fetchImpl,
    existingRunId: null,
  })
  // Path-safety BEFORE the run id reaches any `.orizu-run/${runId}` path
  // (ALI-1060): a caller-supplied ORIZU_RUN_ID must not escape the run dir.
  assertSafeRunId(runId)
  // Hand the run id + bearer to the caller so a throw AFTER this point can mark
  // the run failed + report the boot failure (the DO is the backstop otherwise).
  opts.onBootContext?.({ runId, bearer: bearer.token })
  const repo = await resolveRepo({ baseUrl: env.baseUrl, workspaceId, sessionId: env.sessionId, bearer: bearer.token, fetchImpl })
  const repositoryHost = new URL(repo.cloneUrl).host.toLowerCase()
  log(`resolved run ${runId} on ${repo.repoFullName}@${session.repoBranch}`)

  // 4 — Write the run-scoped assets: boot secret + initial bearer (0600), the
  // PULL-MODE credential helper + its boot context. The bearer file feeds the
  // loop's event sink; the boot secret feeds the credential helper's per-op pull.
  const runDirRel = `.orizu-run/${runId}`
  const runDirAbs = `${root}/${runDirRel}`
  const sessionDirAbs = `${root}/.orizu-session/${env.sessionId}`
  const workspaceDir = `${root}/repo`
  assertSafeGitValue('sessionBranch', session.repoBranch)
  assertSafeGitValue('cloneUrl', repo.cloneUrl)
  mkdirp(runDirAbs)
  mkdirp(sessionDirAbs)

  const bootSecretFileAbs = `${sessionDirAbs}/boot-secret`
  const bearerFileAbs = `${sessionDirAbs}/${BEARER_BASENAME}`
  const helperScriptAbs = `${sessionDirAbs}/${HELPER_SCRIPT_BASENAME}`
  const bootContextAbs = `${sessionDirAbs}/${BOOT_CONTEXT_BASENAME}`
  const cacheFileAbs = `${sessionDirAbs}/${REPO_CRED_CACHE_BASENAME}`
  const taskFileAbs = `${runDirAbs}/task.txt`

  writeSecretFile(bootSecretFileAbs, env.bootSecret, writeFile)
  writeSecretFile(bearerFileAbs, bearer.token, writeFile)
  writeFile(taskFileAbs, session.task)
  writeFile(helperScriptAbs, renderCredentialHelperScript())
  // Keep the session-stable cache inode available across turns without ever
  // persisting an Artifacts credential (the helper deliberately leaves it empty).
  writeSecretFile(cacheFileAbs, '', writeFile)
  const bootContext: HostedBootContext = {
    apiBaseUrl: env.baseUrl,
    workspaceId,
    sessionId: env.sessionId,
    runId,
    sessionBranch: session.repoBranch,
    repoFullName: repo.repoFullName,
    host: repositoryHost,
    bearerFile: bearerFileAbs,
    cacheFile: cacheFileAbs,
    // PULL MODE: source the bearer over HTTP from the coordinator per git op.
    agentTokenUrl: env.agentTokenUrl,
    bootSecretFile: bootSecretFileAbs,
    tokenPurposes: { primary: 'session_write', fallback: 'session_read' },
    cacheBufferMs: DEFAULT_CACHE_REFRESH_BUFFER_MS,
  }
  writeFile(bootContextAbs, serializeBootContext(bootContext))

  // 5 — Clone the session branch VIA the pull-mode credential helper (same
  // invocation the operator path makes; no token in the URL/config).
  const helperValue = `!node ${helperScriptAbs} ${bootContextAbs}`
  const clone = exec('git', [
    'clone',
    '--depth',
    '1',
    '--branch',
    session.repoBranch,
    '-c',
    `credential.helper=${helperValue}`,
    '-c',
    'credential.useHttpPath=true',
    repo.cloneUrl,
    workspaceDir,
  ])
  if (clone.status !== 0) {
    const detail = (clone.stderr || clone.stdout || `exit ${clone.status}`).trim()
    throw new Error(`git clone failed: ${detail}`)
  }
  // Persist the helper + agent identity repo-LOCAL for subsequent fetch/push.
  exec('git', ['-C', workspaceDir, 'config', 'credential.helper', helperValue])
  exec('git', ['-C', workspaceDir, 'config', 'credential.useHttpPath', 'true'])
  exec('git', ['-C', workspaceDir, 'config', 'user.name', AGENT_GIT_IDENTITY.name])
  exec('git', ['-C', workspaceDir, 'config', 'user.email', AGENT_GIT_IDENTITY.email])
  log(`cloned ${session.repoBranch}`)

  // 5b — Stage the orizu skill into the cloned repo so the agent discovers the
  // Orizu workflows (ALI-1059). SHARED with the operator path via `stageOrizuSkill`
  // (one resolution chain + the harvest-safe .git/info/exclude append). Non-fatal:
  // a staging failure is logged, never aborts the boot. The DO `BootExec` is
  // shell-less, so the staging script runs under `sh -c`.
  try {
    const skillStage = await stageOrizuSkill({
      workspaceDir,
      exec: async command => {
        const res = exec('sh', ['-c', command])
        return { exitCode: res.status, stdout: res.stdout, stderr: res.stderr ?? '' }
      },
    })
    log(`orizu skill staged: ${skillStage.ok ? skillStage.method : 'unresolved'}`)
  } catch (error) {
    log(`orizu skill staging failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  // ALI-1060: the agent is now genuinely LIVE — bearer minted, connectors
  // applied, session/run resolved, repo cloned, skill staged. Signal the
  // coordinator's readiness gate BEFORE the loop so the DO stops waiting (and
  // never tears down a healthy box on timeout). Best-effort; the DO's timeout is
  // the backstop.
  await postBootStatus({
    bootStatusUrl: env.bootStatusUrl,
    bootSecret: env.bootSecret,
    status: 'ready',
    runId,
    fetchImpl,
    log,
  })

  // 6 — Launch the hosted loop, reused in-process. The bearer PROVIDER keeps the
  // event sink's bearer fresh from the same pull-mode source; the DO-provisioned
  // sandbox always runs the pre-baked image under an enforced egress policy, so
  // the loop's startup egress canary + deferred setup hook are both armed.
  const model = session.model ?? DEFAULT_HOSTED_MODEL
  const configuredOpenCodePort = resolveTestPositiveInteger(
    processEnv, 'ORIZU_HOSTED_TEST_OPENCODE_PORT', 65_535
  ) ?? (processEnv.ORIZU_OPENCODE_PORT
    ? Number(processEnv.ORIZU_OPENCODE_PORT)
    : undefined)
  if (configuredOpenCodePort !== undefined && (!Number.isInteger(configuredOpenCodePort) || configuredOpenCodePort < 1 || configuredOpenCodePort > 65_535)) {
    throw new Error('ORIZU_OPENCODE_PORT must be a valid TCP port')
  }
  const loopContext: HostedLoopContext = {
    apiBaseUrl: env.baseUrl,
    runId,
    bearerFile: bearerFileAbs,
    taskFile: taskFileAbs,
    workspaceDir,
    sessionBranch: session.repoBranch,
    repositoryRemote: repo.cloneUrl,
    repositoryCredentialHelper: helperValue,
    model,
    reasoningEffort: session.reasoningEffort ?? undefined,
    sessionOrigin: session.surface === 'hosted-web' ? 'hosted-web' : 'cli',
    messageId: `${runId}:task`,
    resumeAgentSessionId: session.agentSessionId ?? undefined,
    author: AGENT_GIT_IDENTITY,
    anthropicDummyKey: env.anthropicDummyKey ?? ANTHROPIC_DUMMY_KEY,
    // Derive the per-prompt max-duration cap from the session duration so a long
    // run is not killed at the hard-coded 90-min prompt cap (ALI-1061). Unset →
    // the harness default (5400s) floor holds.
    sandboxBudgetMs: session.durationMinutes != null ? session.durationMinutes * 60 * 1000 : undefined,
    prebaked: true,
    egressCanaryHost: DEFAULT_EGRESS_CANARY_HOST,
    runSetupHook: true,
    opencodePort: configuredOpenCodePort,
  }

  const runLoop =
    opts.runLoop ??
    ((input): Promise<HostedLoopResult> =>
      runHostedLoop({
        context: input.context,
        taskPrompt: input.taskPrompt,
        bearerProvider: input.bearerProvider,
        redactSecretsList: input.redactSecretsList,
        onDiagnostic: log,
      }))

  // Preserve the injected one-shot seam for existing unit callers. Production
  // uses the durable multi-turn branch below (and therefore has no injected
  // loop or harness boundary).
  if (opts.runLoop) {
    const rotation = startBearerRotation({
      agentTokenUrl: env.agentTokenUrl, bootSecret: env.bootSecret, bearerFileAbs,
      fetchImpl, writeFile, initialExpiresAtMs: bearer.expiresAtMs, now, log,
      minimumDelayMs: bearerRotationMinimumDelayMs,
    })
    try {
      const result = await runLoop({
        context: loopContext, taskPrompt: session.task,
        redactSecretsList: [env.bootSecret],
        bearerProvider: () => readFile(bearerFileAbs).trim(),
      })
      // The one-shot compatibility path predates turn callbacks, but its
      // terminal reason has the same custody rule: scrub the bare boot secret
      // before it crosses the boot-status boundary.
      await postBootStatus({
        bootStatusUrl: env.bootStatusUrl, bootSecret: env.bootSecret,
        status: 'complete', runId,
        reason: result.error ? redactBootReason(result.error, env.bootSecret) : null,
        fetchImpl, log,
      })
      return { ok: !result.error, runId, loopStatus: result.status, error: result.error }
    } finally {
      await rotation.stop()
    }
  }

  const {
    runId: _runId,
    bearerFile: _bearerFile,
    taskFile: _taskFile,
    messageId: _messageId,
    ...sessionLoopBase
  } = loopContext
  const sessionContext: HostedLoopSessionContext = {
    ...sessionLoopBase,
    sessionId: env.sessionId,
    projectId: session.projectId,
    sessionDir: sessionDirAbs,
  }
  const hostedLoopSession = await startHostedLoopSession(sessionContext)
  let current = session.pendingTurn?.runId === runId
    ? { runId, ordinal: session.pendingTurn.ordinal, body: promptForPendingHostedTurn(session.pendingTurn) }
    : { runId, ordinal: 1, body: session.task }
  let currentBearer = bearer
  let lastResult: HostedLoopResult = { status: 'succeeded', agentSessionId: session.agentSessionId, installOk: true, error: null }

  let hostedTurnFailure: HostedTurnFailure | null = null
  try {
    for (;;) {
      assertSafeRunId(current.runId)
      const currentRunDir = `${root}/.orizu-run/${current.runId}`
      const currentTaskFile = `${currentRunDir}/task.txt`
      mkdirp(currentRunDir)
      writeFile(currentTaskFile, current.body)
      writeSecretFile(bearerFileAbs, currentBearer.token, writeFile)
      // Keep the failure reporter pinned to the turn that is about to execute;
      // the boot-time run id becomes stale as soon as a follow-up is admitted.
      opts.onBootContext?.({ runId: current.runId, bearer: currentBearer.token })

      await postTurnStatus({
        bootStatusUrl: env.bootStatusUrl, bootSecret: env.bootSecret,
        status: 'turn_started', runId: current.runId, fetchImpl, sleep,
        attemptTimeoutMs: turnStatusAttemptTimeoutMs,
      })
      await beginRunExecution({
        baseUrl: env.baseUrl,
        runId: current.runId,
        bearer: currentBearer.token,
        fetchImpl,
        sleep,
        attemptTimeoutMs: turnStatusAttemptTimeoutMs,
      })
      const rotation = startBearerRotation({
        agentTokenUrl: env.agentTokenUrl, bootSecret: env.bootSecret, bearerFileAbs,
        fetchImpl, writeFile, initialExpiresAtMs: currentBearer.expiresAtMs, now, log,
        minimumDelayMs: bearerRotationMinimumDelayMs,
      })
      const promptInterruptController = new AbortController()
      const interruptPollController = new AbortController()
      const interruptPoll = pollHostedSessionDuringTurn({
        baseUrl: env.baseUrl,
        sessionId: env.sessionId,
        runId: current.runId,
        bearerFileAbs,
        fetchImpl,
        signal: interruptPollController.signal,
        onInterrupt: () => promptInterruptController.abort(),
        onDiagnostic: log,
        readFile,
      })
      try {
        lastResult = await runHostedLoopTurn(
          hostedLoopSession,
          {
            runId: current.runId,
            ordinal: current.ordinal,
            taskFile: currentTaskFile,
            messageId: `${current.runId}:task`,
            bearerFile: bearerFileAbs,
          },
          {
            taskPrompt: current.body,
            redactSecretsList: [env.bootSecret],
            bearerProvider: () => readFile(bearerFileAbs).trim(),
            interruptSignal: promptInterruptController.signal,
            onDiagnostic: log,
          }
        )
      } finally {
        // Stop and join the during-prompt reader BEFORE removing the live
        // ORIZU_TOKEN_FILE. Only the existing between-turn path unlinks it.
        interruptPollController.abort()
        await interruptPoll
        // Remove the active-turn credential before waiting for an in-flight
        // refresh. The post-await stopped check then prevents its recreation.
        try { unlinkSync(bearerFileAbs) } catch { /* already absent */ }
        await rotation.stop()
      }
      log(`hosted-loop turn ${current.ordinal} finished: ${lastResult.status}`)
      await postTurnStatus({
        bootStatusUrl: env.bootStatusUrl, bootSecret: env.bootSecret,
        status: 'turn_completed', runId: current.runId, fetchImpl, sleep,
        attemptTimeoutMs: turnStatusAttemptTimeoutMs,
      })
      if (lastResult.error) {
        throw new Error(`fatal hosted turn exit: ${lastResult.error}`)
      }

      // One boot writer drains the lowest pending ordinal. Idle status reads
      // reuse the current bearer, staying well below the coordinator's mint
      // budget. Refresh proactively near expiry and once on a 401. Exhausting
      // the bounded agent-token pull is fatal and reported for the current run;
      // other transient status-read failures retain the session and back off.
      for (;;) {
        await sleep(5_000)
        let pendingTurn: PendingHostedTurn | null = null
        try {
          if (currentBearer.expiresAtMs !== null && currentBearer.expiresAtMs <= now() + 60_000) {
            currentBearer = await pullAgentBearer({
              agentTokenUrl: env.agentTokenUrl, bootSecret: env.bootSecret,
              fetchImpl, attempts: 3, backoffMs: 250, sleep, log,
            })
          }
          let latest
          try {
            latest = await resolveSession({
              baseUrl: env.baseUrl, sessionId: env.sessionId,
              bearer: currentBearer.token, fetchImpl,
            })
          } catch (error) {
            if (!(error instanceof Error) || !error.message.includes('(401)')) throw error
            currentBearer = await pullAgentBearer({
              agentTokenUrl: env.agentTokenUrl, bootSecret: env.bootSecret,
              fetchImpl, attempts: 3, backoffMs: 250, sleep, log,
            })
            latest = await resolveSession({
              baseUrl: env.baseUrl, sessionId: env.sessionId,
              bearer: currentBearer.token, fetchImpl,
            })
          }
          if (latest.status && latest.status !== 'active') {
            return { ok: true, runId: current.runId, loopStatus: lastResult.status, error: null }
          }
          pendingTurn = latest.pendingTurn
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          if (detail.startsWith('agent-token pull failed after')) {
            throw new Error(`idle agent-token refresh failed: ${detail}`)
          }
          log(`turn poll failed; retrying (${detail})`)
        } finally {
          try { unlinkSync(bearerFileAbs) } catch { /* idle: no readable bearer */ }
        }
        if (pendingTurn) {
          current = {
            runId: pendingTurn.runId,
            ordinal: pendingTurn.ordinal,
            body: promptForPendingHostedTurn(pendingTurn),
          }
          break
        }
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    hostedTurnFailure = new HostedTurnFailure(detail)
  } finally {
    try {
      await closeHostedLoopSession(hostedLoopSession)
    } catch (error) {
      log(`hosted-loop cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    try { unlinkSync(bearerFileAbs) } catch { /* already absent */ }
    try {
      rmSync(sessionDirAbs, { recursive: true, force: true })
    } catch (error) {
      log(`hosted-loop session-dir cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (hostedTurnFailure) throw hostedTurnFailure
  throw new HostedTurnFailure('hosted turn drain exited without a terminal result')
}

// -- Bearer rotation (keeps the loop's 0600 bearer file fresh) -----------------

interface BearerRotationHandle {
  stop: () => Promise<void>
}

/**
 * Background refresher: before the current bearer expires, pull a fresh one from
 * the coordinator (boot-secret auth) and atomically rewrite the 0600 bearer file
 * the loop reads per request. This is the DO-path analogue of the operator's
 * host-side rotation loop — moved in-sandbox because no operator is attached.
 * Best-effort: a failed refresh is logged and retried. The loop's bearerProvider
 * reads this file fresh per request (see runHostedBoot), so a rewritten file is
 * picked up on the next event/request. No-ops when there is no expiry signal.
 */
export function startBearerRotation(opts: {
  agentTokenUrl: string
  bootSecret: string
  bearerFileAbs: string
  fetchImpl: BootFetch
  writeFile: (path: string, contents: string) => void
  initialExpiresAtMs: number | null
  now: () => number
  log: (line: string) => void
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  minimumDelayMs?: number
}): BearerRotationHandle {
  // Refresh ~5 min before expiry; if the server gives no expiry, fall back to a
  // conservative fixed cadence just under a typical 60-min TTL.
  const REFRESH_BUFFER_MS = 5 * 60 * 1000
  const FALLBACK_INTERVAL_MS = 50 * 60 * 1000
  // Cap the delay well under setTimeout's 32-bit ms limit: a far-future (or
  // implausible) expiry just means we re-verify the bearer every few hours.
  const MAX_SCHEDULE_MS = 6 * 60 * 60 * 1000
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let refreshInFlight: Promise<void> | null = null

  const refresh = async (): Promise<void> => {
    if (stopped) return
    try {
      const fresh = await pullAgentBearer({
        agentTokenUrl: opts.agentTokenUrl,
        bootSecret: opts.bootSecret,
        fetchImpl: opts.fetchImpl,
        attempts: 3,
      })
      // stop() may have won while the network pull was in flight. Never
      // recreate the bearer after the turn has entered its credential-free idle.
      if (stopped) return
      const contents = fresh.token.endsWith('\n') ? fresh.token : `${fresh.token}\n`
      opts.writeFile(opts.bearerFileAbs, contents)
      opts.log('rotated agent bearer (0600 file rewritten)')
      scheduleFrom(fresh.expiresAtMs)
    } catch (error) {
      if (stopped) return
      opts.log(`agent bearer rotation failed: ${error instanceof Error ? error.message : String(error)}`)
      scheduleFrom(opts.now() + REFRESH_BUFFER_MS) // retry soon
    }
  }
  const startRefresh = (): void => {
    const operation = refresh()
    refreshInFlight = operation
    void operation.finally(() => {
      if (refreshInFlight === operation) refreshInFlight = null
    })
  }
  const scheduleFrom = (expiresAtMs: number | null): void => {
    if (stopped) return
    const raw = expiresAtMs ? expiresAtMs - opts.now() - REFRESH_BUFFER_MS : FALLBACK_INTERVAL_MS
    const delay = Math.min(MAX_SCHEDULE_MS, Math.max(opts.minimumDelayMs ?? 30_000, raw))
    timer = (opts.schedule ?? setTimeout)(startRefresh, delay)
    if (typeof timer.unref === 'function') timer.unref()
  }
  scheduleFrom(opts.initialExpiresAtMs)
  return {
    stop: async (): Promise<void> => {
      stopped = true
      if (timer) clearTimeout(timer)
      await refreshInFlight
    },
  }
}

// -- CLI entry (`orizu internal hosted-boot`) ---------------------------------

export interface HostedBootCommandIo {
  print: (line: string) => void
  printErr?: (line: string) => void
  json?: boolean
}

/**
 * Read the frozen env contract from the process env and run the boot. Fails fast
 * (exit 1) with a clear message naming every missing required var. The DO records
 * the exit code; run failures beyond the boot itself are recorded server-side.
 */
export async function hostedBootCommand(io: HostedBootCommandIo): Promise<number> {
  const resolved = resolveHostedBootEnv(process.env)
  if (!resolved.ok) {
    io.printErr?.(
      `hosted-boot: missing required env: ${resolved.missing.join(', ')} ` +
        '(the DO sandbox env contract — see planSandboxEnv)'
    )
    return 1
  }
  const env = resolved.value
  const log = (line: string): void => io.printErr?.(`[hosted-boot] ${line}`)
  // Captured once the run id + bearer are known, so a LATER throw can mark the
  // run failed with an authenticated bearer (ALI-1060).
  let bootCtx: { runId: string; bearer: string } | null = null
  try {
    const result = await runHostedBoot({
      env,
      log,
      onBootContext: ctx => {
        bootCtx = ctx
      },
    })
    io.print(
      io.json
        ? JSON.stringify({ ok: result.ok, runId: result.runId, status: result.loopStatus, error: result.error })
        : `hosted-boot finished: ${result.loopStatus ?? 'unknown'}${result.error ? ` (${result.error})` : ''}`
    )
    return result.ok ? 0 : 1
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    io.printErr?.(`hosted-boot failed: ${message}`)
    // A boot THROW (before/around ensureRun) means the agent never came alive.
    // Report it so the DO stops + destroys the sandbox NOW instead of waiting
    // for the readiness timeout, and mark the run failed so it never stays
    // 'running' forever (the DO also marks it — both are idempotent).
    await reportBootFailure({
      env, ctx: bootCtx, reason: message, log,
      status: error instanceof HostedTurnFailure ? 'turn_failed' : 'failed',
      attemptTimeoutMs: resolveTurnStatusAttemptTimeoutMs(process.env),
    })
    return 1
  }
}

/**
 * Failure fan-out on a boot throw (ALI-1060): mark the run terminally `failed`
 * (the operator path's agent-bearer terminal PATCH) and always signal the
 * coordinator's boot-status route so the DO tears the sandbox down promptly.
 * Best-effort throughout — the boot secret is scrubbed from the reported reason.
 *
 * PRE-BEARER failures (a throw before `onBootContext` — `pullAgentBearer` /
 * `fetchEnvBundle` blew up, so `ctx` is null) still have a run id: the server
 * PRE-CREATES it and injects ORIZU_RUN_ID. We attempt a SHORT bearer pull here
 * so we can self-mark that run failed rather than leaving it `running` until the
 * DO's readiness timeout. If even that pull fails, the DO backstop (boot-status
 * failure now, readiness timeout otherwise) is the last line.
 */
export async function reportBootFailure(opts: {
  env: HostedBootEnv
  ctx: { runId: string; bearer: string } | null
  reason: string
  log: (line: string) => void
  status?: 'failed' | 'turn_failed'
  /** Injectable transport (default: global fetch). Exposed for tests. */
  fetchImpl?: BootFetch
  sleep?: (ms: number) => Promise<void>
  attemptTimeoutMs?: number
}): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as BootFetch)
  const reason = redactBootReason(opts.reason, opts.env.bootSecret)
  // The run id is known from the boot context, or (pre-created / resume flows)
  // straight from the env contract.
  const runId = opts.ctx?.runId ?? opts.env.runId
  // Prefer the bearer we already hold; otherwise pull a fresh one (bounded — the
  // DO is the backstop) so a pre-bearer failure can still self-mark the run.
  let bearer = opts.ctx?.bearer ?? null
  if (!bearer && runId) {
    try {
      bearer = (
        await pullAgentBearer({
          agentTokenUrl: opts.env.agentTokenUrl,
          bootSecret: opts.env.bootSecret,
          fetchImpl,
          attempts: 2,
          log: opts.log,
        })
      ).token
    } catch (error) {
      opts.log(`failure-path bearer pull failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (bearer && runId) {
    try {
      const sink = await resumeRunEventSink({
        apiBaseUrl: opts.env.baseUrl,
        runId,
        bearer,
        fetchImpl,
      })
      await sink.finish('failed', { summary: { error: reason } })
      opts.log('marked run failed')
    } catch (error) {
      opts.log(`run-failed mark failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const status = opts.status ?? 'failed'
  if (status === 'turn_failed' && runId) {
    try {
      await postTurnStatus({
        bootStatusUrl: opts.env.bootStatusUrl,
        bootSecret: opts.env.bootSecret,
        status,
        runId,
        reason,
        fetchImpl,
        sleep: opts.sleep,
        attemptTimeoutMs: opts.attemptTimeoutMs,
      })
      opts.log('turn_failed acknowledged')
    } catch (error) {
      opts.log(
        `turn_failed acknowledgement exhausted: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    return
  }
  await postBootStatus({
    bootStatusUrl: opts.env.bootStatusUrl,
    bootSecret: opts.env.bootSecret,
    status,
    runId,
    reason,
    fetchImpl,
    log: opts.log,
  })
}
