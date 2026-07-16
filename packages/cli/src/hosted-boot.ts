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
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'fs'

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
  runHostedLoop,
  type HostedLoopContext,
  type HostedLoopResult,
} from './hosted-loop.js'
import { DEFAULT_EGRESS_CANARY_HOST } from './hosted-loop-lifecycle.js'
import { resumeRunEventSink } from './hosted-run-event-sink.js'
import { stageOrizuSkill } from './hosted-skill-staging.js'

export type BootFetch = (url: string, init?: RequestInit) => Promise<Response>

/** Non-secret placeholder model key (firewall brokers the real org key on
 *  egress). Byte-for-byte the operator path's constant
 *  (packages/cli/src/hosted-session-cli.ts `ANTHROPIC_DUMMY_KEY` and the
 *  DO-path `workers/session-coordinator/src/bootstrap.ts`); kept in sync by
 *  grep. Inlined (not imported) to avoid a hosted-session-cli import cycle. */
const ANTHROPIC_DUMMY_KEY = 'sk-ant-orizu-proxy-broker-placeholder'
/** Default hosted model — mirrors hosted-session-cli.ts `DEFAULT_HOSTED_MODEL`. */
const DEFAULT_HOSTED_MODEL = 'anthropic/claude-opus-4-8'

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
  status: 'ready' | 'failed' | 'complete'
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

export interface ResolvedSession {
  workspaceId: string
  repoBranch: string
  task: string
  model: string | null
  reasoningEffort: string | null
  /** Session lifetime in minutes (from client_info), if the coordinator recorded
   *  it — used to derive the per-prompt max-duration cap (ALI-1061). */
  durationMinutes: number | null
  /** Most recent existing run id, if any (else the boot creates one). */
  runId: string | null
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
}): Promise<ResolvedSession> {
  const body = await bearerJson(
    opts.fetchImpl,
    `${opts.baseUrl}/api/cli/sessions/${encodeURIComponent(opts.sessionId)}`,
    opts.bearer
  )
  const session = (body.session ?? {}) as Record<string, unknown>
  const workspaceId = asString(session.workspaceId)
  if (!workspaceId) throw new Error('session response carried no workspaceId')
  const repoBranch = asString(session.repoBranch)
  if (!repoBranch) throw new Error('session response carried no repoBranch (branch not provisioned)')
  const clientInfo = (session.clientInfo ?? {}) as Record<string, unknown>
  const task = asString(clientInfo.task)
  if (!task) throw new Error('session client_info carried no task prompt')
  const runs = Array.isArray(session.runs) ? (session.runs as Array<Record<string, unknown>>) : []
  const runId = runs.length > 0 ? asString(runs[0].id) : null
  return {
    workspaceId,
    repoBranch,
    task,
    model: asString(clientInfo.model),
    reasoningEffort: asString(clientInfo.reasoningEffort),
    durationMinutes: asPositiveNumber(clientInfo.durationMinutes),
    runId,
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

  // 1 — Pull the agent bearer (retry/backoff — the DO may still be arming).
  const bearer = await pullAgentBearer({
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
  const session = await resolveSession({ baseUrl: env.baseUrl, sessionId: env.sessionId, bearer: bearer.token, fetchImpl })
  const workspaceId = env.workspaceId ?? session.workspaceId
  const runId = await ensureRun({
    baseUrl: env.baseUrl,
    sessionId: env.sessionId,
    bearer: bearer.token,
    fetchImpl,
    existingRunId: env.runId ?? session.runId,
  })
  // Path-safety BEFORE the run id reaches any `.orizu-run/${runId}` path
  // (ALI-1060): a caller-supplied ORIZU_RUN_ID must not escape the run dir.
  assertSafeRunId(runId)
  // Hand the run id + bearer to the caller so a throw AFTER this point can mark
  // the run failed + report the boot failure (the DO is the backstop otherwise).
  opts.onBootContext?.({ runId, bearer: bearer.token })
  const repo = await resolveRepo({ baseUrl: env.baseUrl, workspaceId, sessionId: env.sessionId, bearer: bearer.token, fetchImpl })
  log(`resolved run ${runId} on ${repo.repoFullName}@${session.repoBranch}`)

  // 4 — Write the run-scoped assets: boot secret + initial bearer (0600), the
  // PULL-MODE credential helper + its boot context. The bearer file feeds the
  // loop's event sink; the boot secret feeds the credential helper's per-op pull.
  const runDirRel = `.orizu-run/${runId}`
  const runDirAbs = `${root}/${runDirRel}`
  const workspaceDir = `${root}/repo`
  assertSafeGitValue('sessionBranch', session.repoBranch)
  assertSafeGitValue('cloneUrl', repo.cloneUrl)
  mkdirp(runDirAbs)

  const bootSecretFileAbs = `${runDirAbs}/boot-secret`
  const bearerFileAbs = `${runDirAbs}/${BEARER_BASENAME}`
  const helperScriptAbs = `${runDirAbs}/${HELPER_SCRIPT_BASENAME}`
  const bootContextAbs = `${runDirAbs}/${BOOT_CONTEXT_BASENAME}`
  const cacheFileAbs = `${runDirAbs}/${REPO_CRED_CACHE_BASENAME}`
  const taskFileAbs = `${runDirAbs}/task.txt`

  writeSecretFile(bootSecretFileAbs, env.bootSecret, writeFile)
  writeSecretFile(bearerFileAbs, bearer.token, writeFile)
  writeFile(taskFileAbs, session.task)
  writeFile(helperScriptAbs, renderCredentialHelperScript())
  const bootContext: HostedBootContext = {
    apiBaseUrl: env.baseUrl,
    workspaceId,
    sessionId: env.sessionId,
    runId,
    sessionBranch: session.repoBranch,
    repoFullName: repo.repoFullName,
    host: 'github.com',
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

  // 5b — Stage the orizu-cli skill into the cloned repo so the agent discovers the
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
    log(`orizu-cli skill staged: ${skillStage.ok ? skillStage.method : 'unresolved'}`)
  } catch (error) {
    log(`orizu-cli skill staging failed: ${error instanceof Error ? error.message : String(error)}`)
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
  const loopContext: HostedLoopContext = {
    apiBaseUrl: env.baseUrl,
    runId,
    bearerFile: bearerFileAbs,
    taskFile: taskFileAbs,
    workspaceDir,
    model,
    reasoningEffort: session.reasoningEffort ?? undefined,
    messageId: `${runId}:task`,
    author: AGENT_GIT_IDENTITY,
    anthropicDummyKey: env.anthropicDummyKey ?? ANTHROPIC_DUMMY_KEY,
    // Derive the per-prompt max-duration cap from the session duration so a long
    // run is not killed at the hard-coded 90-min prompt cap (ALI-1061). Unset →
    // the harness default (5400s) floor holds.
    sandboxBudgetMs: session.durationMinutes != null ? session.durationMinutes * 60 * 1000 : undefined,
    prebaked: true,
    egressCanaryHost: DEFAULT_EGRESS_CANARY_HOST,
    runSetupHook: true,
  }

  const rotation = startBearerRotation({
    agentTokenUrl: env.agentTokenUrl,
    bootSecret: env.bootSecret,
    bearerFileAbs,
    fetchImpl,
    writeFile,
    initialExpiresAtMs: bearer.expiresAtMs,
    now,
    log,
  })
  try {
    const runLoop =
      opts.runLoop ??
      ((input): Promise<HostedLoopResult> =>
        runHostedLoop({
          context: input.context,
          taskPrompt: input.taskPrompt,
          bearerProvider: input.bearerProvider,
          redactSecretsList: input.redactSecretsList,
        }))
    const result = await runLoop({
      context: loopContext,
      taskPrompt: session.task,
      // ALI-1062 exact-value redaction: the boot secret is 64 bare hex chars —
      // no TOKEN_SHAPE_PATTERNS rule can catch it, so it MUST ride the loop's
      // verbatim redaction list or an echoed env dump would land it in
      // workbench_run_events.
      redactSecretsList: [env.bootSecret],
      // Read the bearer FILE fresh per request (review F1): `startBearerRotation`
      // rewrites `bearerFileAbs` before the current bearer expires, so a run
      // exceeding the ~60-min TTL (DO cap is 24h) keeps a valid bearer. A frozen
      // closure over the boot-time token would silently stop recording events at
      // ~TTL. The initial token was written to this file at boot (writeSecretFile
      // above); the write is atomic (F2), so this never reads a torn file.
      bearerProvider: () => readFile(bearerFileAbs).trim(),
    })
    log(`hosted-loop finished: ${result.status}`)
    // ALI-1064: the loop is TERMINAL — the auto-harvest (ALI-1036) and the
    // run's terminal seal already ran INSIDE runHostedLoop, so it is safe to
    // hand the session back. Report `complete` so the DO ends the workspace
    // session server-side and stops/destroys the sandbox NOW instead of
    // extending it until the 24h cap (live 2026-07-15: zombie boxes burned
    // 2×CPU/4GiB for hours after their loops finished). This fires for a
    // failed loop too — the run is terminal either way, and the loop already
    // owns its own run-level terminal state (never a `failed` boot-status
    // here; that would misreport a run failure as a bootstrap failure).
    // Best-effort: the DO's duration/24h caps are the backstop.
    await postBootStatus({
      bootStatusUrl: env.bootStatusUrl,
      bootSecret: env.bootSecret,
      status: 'complete',
      runId,
      reason: result.error ? redactBootReason(result.error, env.bootSecret) : null,
      fetchImpl,
      log,
    })
    return { ok: !result.error, runId, loopStatus: result.status, error: result.error }
  } finally {
    rotation.stop()
  }
}

// -- Bearer rotation (keeps the loop's 0600 bearer file fresh) -----------------

interface BearerRotationHandle {
  stop: () => void
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
function startBearerRotation(opts: {
  agentTokenUrl: string
  bootSecret: string
  bearerFileAbs: string
  fetchImpl: BootFetch
  writeFile: (path: string, contents: string) => void
  initialExpiresAtMs: number | null
  now: () => number
  log: (line: string) => void
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

  const scheduleFrom = (expiresAtMs: number | null): void => {
    if (stopped) return
    const raw = expiresAtMs ? expiresAtMs - opts.now() - REFRESH_BUFFER_MS : FALLBACK_INTERVAL_MS
    const delay = Math.min(MAX_SCHEDULE_MS, Math.max(30_000, raw))
    timer = setTimeout(refresh, delay)
    if (typeof timer.unref === 'function') timer.unref()
  }
  const refresh = async (): Promise<void> => {
    if (stopped) return
    try {
      const fresh = await pullAgentBearer({
        agentTokenUrl: opts.agentTokenUrl,
        bootSecret: opts.bootSecret,
        fetchImpl: opts.fetchImpl,
        attempts: 3,
      })
      const contents = fresh.token.endsWith('\n') ? fresh.token : `${fresh.token}\n`
      opts.writeFile(opts.bearerFileAbs, contents)
      opts.log('rotated agent bearer (0600 file rewritten)')
      scheduleFrom(fresh.expiresAtMs)
    } catch (error) {
      opts.log(`agent bearer rotation failed: ${error instanceof Error ? error.message : String(error)}`)
      scheduleFrom(opts.now() + REFRESH_BUFFER_MS) // retry soon
    }
  }
  scheduleFrom(opts.initialExpiresAtMs)
  return {
    stop: (): void => {
      stopped = true
      if (timer) clearTimeout(timer)
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
    await reportBootFailure({ env, ctx: bootCtx, reason: message, log })
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
  /** Injectable transport (default: global fetch). Exposed for tests. */
  fetchImpl?: BootFetch
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
  await postBootStatus({
    bootStatusUrl: opts.env.bootStatusUrl,
    bootSecret: opts.env.bootSecret,
    status: 'failed',
    runId,
    reason,
    fetchImpl,
    log: opts.log,
  })
}
