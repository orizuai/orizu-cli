/**
 * `orizu session start --hosted` — host-side driver for a CLI-triggered hosted
 * agent session (ALI-928 / P3.5, per ADR-005). Also the thin dispatch home for
 * the in-sandbox `orizu internal hosted-loop` (delegated to `hosted-loop.ts`).
 *
 * A human runs this with their NORMAL login. `startHostedSession` then:
 *   (a) opens a workspace session (its own session branch is cut server-side);
 *   (b) mints a session-scoped AGENT token (the sandbox's Orizu bearer);
 *   (c) starts a workbench run WITH THE AGENT BEARER (actor_type='agent');
 *   (d) creates the sandbox via a SandboxProvider (timeout from --duration,
 *       default 60m, cap 24h — never Vercel's 5m default);
 *   (e) bootstraps the sandbox (agent bearer in a 0600 file; broker purposes
 *       session_write/session_read chosen from bearerKind='agent');
 *   (f) launches the hosted-loop DETACHED so the CLI can exit;
 *   (g) READINESS-GATES on the loop's first event (bounded); on failure it
 *       destroys the sandbox + exits non-zero. Detached mode then prints when the
 *       sandbox self-terminates (it lives to --duration; session-end reaping is
 *       G6/ALI-1007). Attached (--tail) mode rotates + keeps the box alive +
 *       streams the tail, and REAPS the sandbox when the run terminates.
 *
 * TOKEN TTL vs LONG SESSIONS (decided): while attached (--tail), the CLI
 * re-mints the agent token before expiry (default 55m) and ATOMICALLY overwrites
 * the 0600 bearer file (temp + mv). Rotation keeps BOTH git ops and event
 * recording alive: the in-sandbox credential helper reads the bearer per-op, AND
 * the loop's RunEventSink resolves it per request (bearer PROVIDER + a one-shot
 * re-resolve-and-retry on 401/403). Each rotation also extendTimeout()s the
 * sandbox by the rotation interval (bounded by the 24h cap). A failed mint
 * fast-retries (60s) and gives up loudly before expiry. If the host disconnects,
 * tokens expire within the TTL (≤60m) and the loop finishes 'failed' cleanly; the
 * sandbox timeout is independent (configurable to 24h). Documented in the
 * secrets-policy doc §8 + the command help.
 *
 * Everything the command needs (provider, fetch, repo resolution, loop launch)
 * is injectable, so the whole flow runs in-process against fakes in the
 * local-sim end-to-end test.
 */

import {
  createLocalSimProvider,
  type SandboxEgressPolicy,
  type SandboxProvider,
  type SandboxSession,
} from './sandbox-provider.js'
import {
  bootstrapHostedSandbox,
  createBootstrapRunEventSink,
  type BootstrapRunEventSink,
  type HostedFetch,
  type HostedRuntimePaths,
} from './hosted-bootstrap.js'
import { resumeRunEventSink } from './hosted-run-event-sink.js'
import { AGENT_GIT_IDENTITY, BEARER_BASENAME } from './hosted-runtime-assets.js'
import { createVercelProvider } from './vercel-sandbox-provider.js'
import { buildEgressPolicy, DEFAULT_EGRESS_CANARY_HOST } from './egress-policy.js'
import { hostedLoopCommand, type HostedLoopContext } from './hosted-loop.js'
import { hostedBootCommand } from './hosted-boot.js'
import { mergeJobCommand } from './merge-job.js'
import { authedFetch } from './http.js'
import { resolveBaseUrl } from './http.js'
import { getWorkspaceRoot } from './workspace.js'
import { attachedWorkspaceId } from './workspace-sync.js'
import { tailWorkbenchRun } from './workbench-cli.js'

export const DEFAULT_HOSTED_MODEL = 'anthropic/claude-opus-4-8'
export const DEFAULT_DURATION_MINUTES = 60
export const MAX_DURATION_MINUTES = 24 * 60
export const DEFAULT_ROTATION_INTERVAL_MS = 55 * 60 * 1000
/** After a mint failure, retry the rotation on this short interval (not the full
 *  55m) so a transient outage does not silently ride the token to expiry. */
export const ROTATION_FAST_RETRY_MS = 60 * 1000
export const DEFAULT_AGENT_TOKEN_TTL_MINUTES = 60
/** Readiness gate: how long to poll the run's events for the loop's first event
 *  before declaring the detached launch a failure. */
export const DEFAULT_READINESS_TIMEOUT_MS = 30 * 1000
export const DEFAULT_READINESS_POLL_MS = 500
/** Non-secret placeholder OpenCode uses to form requests; the firewall proxy
 *  overrides the real Anthropic header (model-key brokering). NEVER a real key. */
export const ANTHROPIC_DUMMY_KEY = 'sk-ant-orizu-proxy-broker-placeholder'

// -- Injectable HTTP -----------------------------------------------------------

/** Base-relative fetch (base already applied) — the host-side human fetcher. */
export type HostFetcher = (path: string, init?: RequestInit) => Promise<Response>

/** Build a base-relative fetcher that authenticates with a specific bearer
 *  (used for the AGENT-bearer run-start against the absolute API base). */
export function bearerFetcher(
  apiBaseUrl: string,
  bearer: string,
  rawFetch: HostedFetch
): HostFetcher {
  const base = apiBaseUrl.replace(/\/$/, '')
  return (path, init = {}) =>
    rawFetch(`${base}${path}`, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${bearer}` },
    })
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>
  } catch {
    return {}
  }
}

async function postJson(
  fetcher: HostFetcher,
  path: string,
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await fetcher(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    const body = await readJson(response)
    const error = typeof body.error === 'string' ? body.error : `${response.status}`
    throw new Error(`${path} failed (${response.status}): ${error}`)
  }
  return readJson(response)
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} missing from response`)
  }
  return value
}

// -- Loop launch seam ---------------------------------------------------------

export interface LaunchLoopParams {
  session: SandboxSession
  context: HostedLoopContext
  /** Sandbox-relative + absolute paths for the run-scoped loop files. */
  taskRel: string
  contextRel: string
  contextAbs: string
  logRel: string
  taskPrompt: string
  /** Agent bearer, handed through so an injected in-process launcher can run
   *  the loop without re-reading the 0600 file. */
  bearer: string
}

/** Default launch: write the task + loop-context files (0600), then start the
 *  loop DETACHED via nohup so the host CLI can exit. */
async function defaultLaunchLoop(p: LaunchLoopParams): Promise<void> {
  await p.session.writeFile(p.taskRel, p.taskPrompt)
  await p.session.writeFile(p.contextRel, JSON.stringify(p.context))
  await p.session.exec(`chmod 600 ${p.contextRel} ${p.taskRel}`)
  await p.session.exec(
    `nohup orizu internal hosted-loop --context ${p.contextAbs} > ${p.logRel} 2>&1 &`
  )
}

// -- start options / result ---------------------------------------------------

export interface RepoResolution {
  repoFullName: string
  cloneUrl: string
}

export interface StartHostedSessionOptions {
  /** Host-side human fetcher (base-relative, authed with the human login). */
  fetcher: HostFetcher
  /** Absolute Orizu API base — baked into the sandbox boot context. */
  apiBaseUrl: string
  provider: SandboxProvider
  workspaceId: string
  task: string
  projectSlug?: string | null
  model?: string
  reasoningEffort?: string
  /** Sandbox session length (minutes); default 60, hard-capped at 24h. */
  durationMinutes?: number
  runtime?: string
  /**
   * Pre-baked custom VCR image ref (ALI-1017), e.g. 'orizu-hosted-runtime:v1'.
   * When set, it is passed to `Sandbox.create({ image })` AND flips the `prebaked`
   * flag on BOTH the bootstrap and the loop together — so the sandbox image and
   * the install-skip decision can never disagree. When unset, the from-scratch
   * install path runs (local-sim / base runtime). Default: env ORIZU_HOSTED_IMAGE.
   */
  hostedImage?: string
  /**
   * Pre-baked Vercel Sandbox SNAPSHOT id (ALI-1017, zero-Docker path). Parallel to
   * `hostedImage`: when set it is passed to `Sandbox.create({ source:{ type:'snapshot' }})`
   * AND flips the `prebaked` flag on bootstrap + loop together. Mutually exclusive
   * with `hostedImage` — both set is a hard error. Default: env ORIZU_HOSTED_SNAPSHOT.
   */
  hostedSnapshot?: string
  title?: string
  /** Attach: rotate the bearer + stream the run tail until it terminates. */
  tail?: boolean
  /** Host-side model key; injected at the firewall proxy, never into the sandbox. */
  modelApiKey?: string
  /** VCS host the credential helper serves (default github.com; rehearsal only). */
  host?: string
  /** Loopback hosts the helper may serve over plain HTTP (rehearsal only). */
  insecureHttpHosts?: readonly string[]
  // -- injectables (production defaults provided) --
  rawFetch?: HostedFetch
  resolveRepo?: (workspaceId: string) => Promise<RepoResolution>
  launchLoop?: (params: LaunchLoopParams) => Promise<void>
  /** Build the sandbox egress policy from the resolved inputs. Default: G5
   *  `buildEgressPolicy` — DEFAULT-DENY base allowlist (Orizu API + model provider
   *  + git) with the model-key broker composed on, plus the per-team additive
   *  domains. Injectable for tests. */
  buildEgressPolicy?: (input: { modelApiKey?: string; extraDomains: readonly string[] }) => SandboxEgressPolicy | undefined
  /** Resolve the per-team ADDITIVE egress domains for this workspace's team
   *  (base hosts are code-owned and always present). Default: no extra domains —
   *  the production CLI injects a route-backed resolver. */
  resolveExtraEgressDomains?: (workspaceId: string) => Promise<readonly string[]>
  rotationIntervalMs?: number
  agentTokenTtlMinutes?: number
  now?: () => number
  /** Readiness gate bound (ms); default 30s. */
  readinessTimeoutMs?: number
  /** Readiness poll interval (ms); default 500ms. */
  readinessPollMs?: number
  /** Test seam: override the readiness probe entirely (resolves ready/not). */
  waitForReady?: (params: ReadinessParams) => Promise<boolean>
  logLine?: (line: string) => void
  onTailEvent?: (event: Record<string, unknown>) => void
  /** Test hook: the live sandbox + its run-scoped paths, after a successful
   *  bootstrap (used by the e2e for residue-sweep + bearer-file inspection). */
  onSandboxReady?: (info: { session: SandboxSession; paths: HostedRuntimePaths }) => void
  /** Await the tail loop when attached (tests pass a bounded tailer). */
  tailImpl?: (params: TailParams) => Promise<void>
}

export interface TailParams {
  fetcher: HostFetcher
  runId: string
  onEvent?: (event: Record<string, unknown>) => void
}

export interface ReadinessParams {
  fetcher: HostFetcher
  runId: string
  timeoutMs: number
  pollMs: number
  now: () => number
  sleep: (ms: number) => Promise<void>
  log: (line: string) => void
}

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(['succeeded', 'failed', 'cancelled'])

/**
 * The loop's FIRST server-visible event: either `agent_ready` (harness
 * connected) or its startup `artifact` (the opencode_install record it appends
 * before spawning). Presence of either proves the detached loop actually
 * launched and is talking to the RunAPI.
 */
function isLoopStartupEvent(event: Record<string, unknown>): boolean {
  const type = event.eventType
  if (type === 'agent_ready') return true
  if (type === 'artifact') {
    const payload = event.payload
    if (payload && typeof payload === 'object') {
      // The loop's first artifact — either the OpenCode install (from-scratch) or
      // the opencode_prebaked record (pre-baked runtime, ALI-1017). Presence of
      // either proves the detached loop launched and is talking to the RunAPI.
      const step = (payload as Record<string, unknown>).step
      if (step === 'opencode_install' || step === 'opencode_prebaked') return true
    }
  }
  return false
}

/**
 * Poll the run's events (bounded) for the loop's first event before we declare
 * the session ready. Returns true once seen. Returns false if the run reaches a
 * TERMINAL status first (the loop died before signaling) or the budget expires.
 */
async function pollLoopReady(params: ReadinessParams): Promise<boolean> {
  const deadline = params.now() + params.timeoutMs
  for (;;) {
    try {
      const res = await params.fetcher(`/api/cli/workbench-runs/${encodeURIComponent(params.runId)}/events?after=0&limit=500`)
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as { events?: unknown; runStatus?: unknown }
        const events = Array.isArray(body.events) ? (body.events as Record<string, unknown>[]) : []
        if (events.some(isLoopStartupEvent)) return true
        const runStatus = typeof body.runStatus === 'string' ? body.runStatus : null
        if (runStatus && TERMINAL_RUN_STATUSES.has(runStatus)) return false
      }
    } catch {
      // transient — keep polling within the budget
    }
    if (params.now() >= deadline) return false
    await params.sleep(params.pollMs)
  }
}

export interface StartHostedSessionResult {
  ok: boolean
  sessionId: string
  runId: string
  sandboxId: string
  repoFullName: string
  sessionBranch: string
  agentUserId: string | null
  bootstrapOk: boolean
  error: string | null
}

function clampDuration(minutes: number | undefined): number {
  const base = typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_DURATION_MINUTES
  return Math.min(Math.max(1, Math.floor(base)), MAX_DURATION_MINUTES)
}

/** Overwrite the 0600 bearer file ATOMICALLY: write a sibling temp file (created
 *  under umask 077 so it is 0600 from birth — never a world-readable window) then
 *  `mv` it into place. The rename is atomic on POSIX, so a concurrent reader (the
 *  in-sandbox credential helper / loop reading the bearer per-op) always sees
 *  either the whole old token or the whole new one, never a torn write. Matches
 *  the bootstrap's G3 discipline — never in argv-persisted config. Used by both
 *  the initial write path and rotation. */
async function writeBearerFile(session: SandboxSession, bearerRel: string, bearer: string): Promise<void> {
  const quoted = `'${bearer.replace(/'/g, `'\\''`)}'`
  const tmpRel = `${bearerRel}.tmp`
  await session.exec(
    `umask 077 && printf '%s\\n' ${quoted} > ${tmpRel} && mv -f ${tmpRel} ${bearerRel}`
  )
}

/** Default repo resolution: mint a session_read token (human bearer) to learn
 *  the repo full name, build the GitHub clone URL, then revoke the mint. */
async function defaultResolveRepo(
  fetcher: HostFetcher,
  workspaceId: string,
  sessionId: string
): Promise<RepoResolution> {
  const minted = await postJson(fetcher, `/api/cli/workspaces/${encodeURIComponent(workspaceId)}/repo-token`, {
    purpose: 'session_read',
    sessionId,
  })
  const repoFullName = requireString(minted.repo, 'repo')
  const token = typeof minted.token === 'string' ? minted.token : null
  const mintId = typeof minted.mintId === 'string' ? minted.mintId : null
  if (token && mintId) {
    try {
      await fetcher(`/api/cli/workspaces/${encodeURIComponent(workspaceId)}/repo-token`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mintId, token }),
      })
    } catch {
      // best-effort revoke — the 60-min TTL is the backstop.
    }
  }
  return { repoFullName, cloneUrl: `https://github.com/${repoFullName}.git` }
}

export async function startHostedSession(
  opts: StartHostedSessionOptions
): Promise<StartHostedSessionResult> {
  // ALI-1035 fail-fast: a hosted run cannot reach the model provider without a key
  // (the firewall brokers the real key onto egress). Refuse BEFORE creating any
  // session, run row, or sandbox — no orphaned rows, no paid box, instant error.
  if (!opts.modelApiKey) {
    throw new Error('hosted session needs a model API key: set ANTHROPIC_API_KEY (or pass --model-key)')
  }
  const rawFetch = opts.rawFetch ?? (globalThis.fetch as HostedFetch)
  const log = opts.logLine ?? ((): void => {})
  const model = opts.model ?? DEFAULT_HOSTED_MODEL
  // ALI-1017: a pre-baked custom image both selects the sandbox image AND flips
  // the prebaked skip-install flag — derived ONCE so bootstrap, the loop, and the
  // create call can never disagree. Env is the default (matches the provider's
  // own ORIZU_HOSTED_IMAGE default) so the flag and the image stay in lockstep.
  const hostedImage = opts.hostedImage ?? process.env.ORIZU_HOSTED_IMAGE
  const hostedSnapshot = opts.hostedSnapshot ?? process.env.ORIZU_HOSTED_SNAPSHOT
  // image and snapshot are two mutually-exclusive prebaked-runtime paths; a run
  // must pick ONE. Fail loudly rather than silently preferring one.
  if (hostedImage && hostedSnapshot) {
    throw new Error(
      'hosted runtime: set EITHER a pre-baked image (--image / ORIZU_HOSTED_IMAGE) OR a snapshot ' +
        '(--snapshot / ORIZU_HOSTED_SNAPSHOT), not both.'
    )
  }
  // Either prebaked source ships the CLI + OpenCode, so the install-skip flag keys
  // on both — derived ONCE so bootstrap, the loop, and the create call agree.
  const prebakedImage = Boolean(hostedImage || hostedSnapshot)
  // G5: DEFAULT-DENY egress with the code-owned base allowlist (Orizu API + model
  // provider + git host), the model-key broker composed onto the model rule, and
  // the resolved per-team additive domains. The Orizu host is derived from the
  // API base URL so a self-hosted / staging base allowlists the right host.
  const buildEgress =
    opts.buildEgressPolicy ??
    ((input: { modelApiKey?: string; extraDomains: readonly string[] }): SandboxEgressPolicy | undefined =>
      buildEgressPolicy({
        orizuBaseUrl: opts.apiBaseUrl,
        extraDomains: input.extraDomains,
        modelKeyBroker: input.modelApiKey ? { apiKey: input.modelApiKey } : undefined,
      }))

  // (a) open a workspace session (its own session branch is cut server-side).
  const sessionResp = await postJson(
    opts.fetcher,
    `/api/cli/workspaces/${encodeURIComponent(opts.workspaceId)}/sessions`,
    { repoBranch: true, projectSlug: opts.projectSlug ?? undefined, clientInfo: { source: 'orizu-cli-hosted' } }
  )
  const session = sessionResp.session as { id?: unknown; repoBranch?: unknown } | undefined
  const sessionId = requireString(session?.id, 'session id')
  const sessionBranch = requireString(session?.repoBranch, 'session repoBranch')
  log(`session ${sessionId} on ${sessionBranch}`)

  // (b) mint the session-scoped agent token (the sandbox's Orizu bearer).
  const ttlMinutes = opts.agentTokenTtlMinutes ?? DEFAULT_AGENT_TOKEN_TTL_MINUTES
  const tokenResp = await postJson(
    opts.fetcher,
    `/api/cli/sessions/${encodeURIComponent(sessionId)}/agent-token`,
    { ttlMinutes }
  )
  let agentBearer = requireString(tokenResp.token, 'agent token')
  const agentUserId = typeof tokenResp.agentUserId === 'string' ? tokenResp.agentUserId : null
  const agentFetch = bearerFetcher(opts.apiBaseUrl, agentBearer, rawFetch)

  // (c) start the run WITH THE AGENT BEARER (actor_type='agent', own session).
  const runResp = await postJson(agentFetch, '/api/cli/workbench-runs', {
    workspaceSessionId: sessionId,
    title: opts.title ?? `Hosted session ${sessionId}`,
  })
  const run = runResp.run as { id?: unknown } | undefined
  const runId = requireString(run?.id, 'run id')
  log(`run ${runId} started`)

  // (e-pre) resolve the repo + clone URL.
  const repo = await (opts.resolveRepo
    ? opts.resolveRepo(opts.workspaceId)
    : defaultResolveRepo(opts.fetcher, opts.workspaceId, sessionId))

  // (d) create the sandbox — timeout ALWAYS set from --duration.
  // Resolve the per-team ADDITIVE egress domains (best-effort: a resolution
  // failure falls back to the base allowlist only — never widens on error).
  let extraEgressDomains: readonly string[] = []
  if (opts.resolveExtraEgressDomains) {
    try {
      extraEgressDomains = await opts.resolveExtraEgressDomains(opts.workspaceId)
    } catch (error) {
      log(`egress allowlist resolve failed (using base allowlist only): ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const egressPolicy = buildEgress({ modelApiKey: opts.modelApiKey, extraDomains: extraEgressDomains })
  const sandbox = await opts.provider.createSandbox({
    timeoutMs: clampDuration(opts.durationMinutes) * 60 * 1000,
    runtime: opts.runtime,
    // Exactly one of image/snapshot is set (guarded above); pass both through and
    // let the provider apply the snapshot-wins precedence defensively.
    image: hostedImage,
    snapshot: hostedSnapshot,
    egressPolicy,
  })
  // Arm the in-sandbox startup canary ONLY for providers that actually enforce
  // egress at the firewall (Vercel). local-sim ignores the policy, so probing a
  // denied host there would hit the real network and wrongly fail the run closed.
  const egressCanaryHost = opts.provider.kind === 'vercel' ? DEFAULT_EGRESS_CANARY_HOST : undefined
  log(`sandbox ${sandbox.id} (${clampDuration(opts.durationMinutes)}m)`)

  const base: StartHostedSessionResult = {
    ok: false,
    sessionId,
    runId,
    sandboxId: sandbox.id,
    repoFullName: repo.repoFullName,
    sessionBranch,
    agentUserId,
    bootstrapOk: false,
    error: null,
  }

  // (e) bootstrap — the run-start already consumed sequence 1, so the bootstrap
  // sink starts at 2 (the loop later RESUMES from the true server cursor).
  const bootstrapSink: BootstrapRunEventSink = createBootstrapRunEventSink({
    apiBaseUrl: opts.apiBaseUrl,
    runId,
    bearer: agentBearer,
    fetchImpl: rawFetch,
    startSequence: 2,
  })
  const bootstrap = await bootstrapHostedSandbox({
    session: sandbox,
    apiBaseUrl: opts.apiBaseUrl,
    bearer: agentBearer,
    workspaceId: opts.workspaceId,
    sessionId,
    runId,
    sessionBranch,
    repoFullName: repo.repoFullName,
    resolveCloneUrl: () => repo.cloneUrl,
    bearerKind: 'agent',
    sink: bootstrapSink,
    fetchImpl: rawFetch,
    host: opts.host,
    insecureHttpHosts: opts.insecureHttpHosts,
    // ALI-1017: skip the in-sandbox CLI install when the pre-baked image ships it.
    prebaked: prebakedImage,
    // P3-a: when egress is enforced (canary armed), DEFER the customer setup hook
    // to the loop so it runs only AFTER the canary proves the firewall is live.
    deferSetupHook: egressCanaryHost !== undefined,
  })

  if (!bootstrap.ok) {
    // Finish the run 'failed' (bootstrap only records bootstrap_failed + tears
    // down its run dir; it never PATCHes the run terminal), then drop the box.
    const failSink = await resumeRunEventSink({ apiBaseUrl: opts.apiBaseUrl, runId, bearer: agentBearer, fetchImpl: rawFetch })
    try {
      await failSink.finish('failed', { summary: { error: bootstrap.failure?.error ?? 'bootstrap failed' } })
    } catch {
      // best-effort terminal
    }
    try {
      await sandbox.destroy()
    } catch {
      // best-effort teardown
    }
    return { ...base, error: bootstrap.failure?.error ?? 'bootstrap failed' }
  }
  base.bootstrapOk = true
  log(`bootstrap ok — cloned ${sessionBranch}`)

  // (f) launch the hosted-loop DETACHED.
  const paths = bootstrap.paths
  opts.onSandboxReady?.({ session: sandbox, paths })
  const bearerRel = `${paths.runDirRel}/${BEARER_BASENAME}`
  const taskRel = `${paths.runDirRel}/task.txt`
  const contextRel = `${paths.runDirRel}/loop-context.json`
  const contextAbs = `${paths.runDirAbs}/loop-context.json`
  const logRel = `${paths.runDirRel}/loop.log`
  const loopContext: HostedLoopContext = {
    apiBaseUrl: opts.apiBaseUrl,
    runId,
    bearerFile: paths.bearerFileAbs,
    taskFile: `${paths.runDirAbs}/task.txt`,
    workspaceDir: paths.repoDirRel,
    model,
    reasoningEffort: opts.reasoningEffort,
    messageId: `${runId}:task`,
    author: AGENT_GIT_IDENTITY,
    anthropicDummyKey: opts.modelApiKey ? ANTHROPIC_DUMMY_KEY : undefined,
    // Same budget the sandbox timeout uses (line above): the loop derives the
    // per-prompt max-duration cap from it so a long --duration run is not killed
    // at the hard-coded 90-min prompt cap (ALI-1061).
    sandboxBudgetMs: clampDuration(opts.durationMinutes) * 60 * 1000,
    // ALI-1017: skip the in-sandbox opencode install when the image ships it.
    prebaked: prebakedImage,
    egressCanaryHost,
    // Run the DEFERRED setup hook in the loop iff bootstrap deferred it (same
    // condition: an enforced-egress provider armed the canary).
    runSetupHook: egressCanaryHost !== undefined,
  }
  await (opts.launchLoop ?? defaultLaunchLoop)({
    session: sandbox,
    context: loopContext,
    taskRel,
    contextRel,
    contextAbs,
    logRel,
    taskPrompt: opts.task,
    bearer: agentBearer,
  })
  log(`hosted-loop launched (run ${runId})`)

  const now = opts.now ?? ((): number => Date.now())
  const defaultSleep = (ms: number): Promise<void> => new Promise<void>(resolve => setTimeout(resolve, ms))
  const durationMs = clampDuration(opts.durationMinutes) * 60 * 1000

  // Readiness gate: confirm the DETACHED loop actually started (first event) —
  // or reached terminal early — before we call the session ready. On failure,
  // destroy the sandbox and return non-zero (never leave a paid box orphaned
  // behind a launch that never came up).
  const ready = await (opts.waitForReady ?? pollLoopReady)({
    fetcher: opts.fetcher,
    runId,
    timeoutMs: opts.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
    pollMs: opts.readinessPollMs ?? DEFAULT_READINESS_POLL_MS,
    now,
    sleep: defaultSleep,
    log,
  })
  if (!ready) {
    log('hosted session failed: the agent loop did not report ready — destroying the sandbox')
    try {
      await sandbox.destroy()
    } catch {
      // best-effort teardown
    }
    return { ...base, ok: false, error: 'agent loop did not become ready' }
  }
  base.ok = true
  log('agent loop ready')

  // (g) detached mode: the sandbox lives to its --duration timeout (v0). Print
  // exactly when it self-terminates + its id (session-end reaping is G6/ALI-1007).
  if (!opts.tail) {
    const selfTerminateAt = new Date(now() + durationMs).toISOString()
    log(
      `sandbox ${sandbox.id} will self-terminate at ${selfTerminateAt} ` +
        `(v0: detached sandboxes live to their --duration timeout; no session-end reaping yet)`
    )
    return base
  }

  // (g') attached mode: rotate the bearer before expiry, keep the sandbox alive,
  // stream the tail, and reap the sandbox when the run terminates.
  const rotationIntervalMs = opts.rotationIntervalMs ?? DEFAULT_ROTATION_INTERVAL_MS
  const sandboxCapMs = MAX_DURATION_MINUTES * 60 * 1000
  let sandboxBudgetMs = durationMs
  let tokenExpiresAtMs = now() + ttlMinutes * 60 * 1000
  let stopped = false

  // ALI-1037 host-side idle gate: only KEEP a sandbox alive while its run is
  // making progress. Before each keepalive extension we cheaply check whether any
  // new run event landed since the last check; a run with NO new events since the
  // previous rotation cycle is not extended (the in-sandbox watchdog is the
  // primary stall killer — this stops the HOST from paying to keep a dead box
  // alive). "Can't tell" (non-2xx / transport error) never starves a healthy run.
  let lastEventCursor = 0
  const hasEventProgress = async (): Promise<boolean> => {
    try {
      const res = await opts.fetcher(
        `/api/cli/workbench-runs/${encodeURIComponent(runId)}/events?after=${lastEventCursor}&limit=500`
      )
      if (!res.ok) return true
      const body = (await res.json().catch(() => ({}))) as { events?: unknown }
      const events = Array.isArray(body.events) ? (body.events as Record<string, unknown>[]) : []
      if (events.length === 0) return false
      lastEventCursor = events.reduce((max, event) => {
        const seq = typeof event.sequence === 'number' ? event.sequence : 0
        return seq > max ? seq : max
      }, lastEventCursor)
      return true
    } catch {
      return true
    }
  }
  let cancelSleep: (() => void) | null = null
  const stop = (): void => {
    stopped = true
    cancelSleep?.()
  }
  // Abortable delay: stop() clears the pending timer so an attached CLI exits
  // PROMPTLY when the tail ends, instead of blocking on a 55-minute sleep.
  const abortableSleep = (ms: number): Promise<void> =>
    new Promise<void>(resolve => {
      if (stopped) {
        resolve()
        return
      }
      const timer = setTimeout(() => {
        cancelSleep = null
        resolve()
      }, ms)
      cancelSleep = (): void => {
        clearTimeout(timer)
        cancelSleep = null
        resolve()
      }
    })

  // Best-effort diagnostic run event when rotation is abandoned. Uses a resumed
  // sink (single append) — the run is dying anyway; a burned sequence is fine.
  const emitRotationFailureEvent = async (): Promise<void> => {
    try {
      const diagSink = await resumeRunEventSink({
        apiBaseUrl: opts.apiBaseUrl,
        runId,
        bearer: agentBearer,
        fetchImpl: rawFetch,
      })
      await diagSink.append({
        kind: 'artifact',
        payload: {
          step: 'bearer_rotation_abandoned',
          detail: 'host could not refresh the agent bearer before expiry',
        },
      })
    } catch {
      // best-effort — the bearer may already be unusable
    }
  }

  const rotate = async (): Promise<void> => {
    let delayMs = rotationIntervalMs
    while (!stopped) {
      await abortableSleep(delayMs)
      if (stopped) break
      try {
        const fresh = await postJson(
          opts.fetcher,
          `/api/cli/sessions/${encodeURIComponent(sessionId)}/agent-token`,
          { ttlMinutes }
        )
        const freshToken = requireString(fresh.token, 'rotated agent token')
        agentBearer = freshToken
        await writeBearerFile(sandbox, bearerRel, freshToken)
        tokenExpiresAtMs = now() + ttlMinutes * 60 * 1000
        delayMs = rotationIntervalMs
        // The DURABLE credential-use audit for this rotation is the fresh
        // agent_session_tokens row minted above (created_at/expires_at/revoked_at
        // per mint). We do NOT emit a run event: the in-sandbox loop is the sole
        // writer on this run's event/sequence space (single-writer invariant, see
        // app/api/cli/workbench-runs/[id]/events/route.ts) and a host-side append
        // here races the loop → 409 → a healthy run killed. Operator visibility is
        // the local stderr log below.
        log('rotated agent bearer (file overwritten)')
        // Keepalive: extend the sandbox by one rotation interval each rotation
        // while attached (SDK supports extendTimeout(ms)), bounded by the 24h cap
        // so a long attached session outlives the initial --duration window — BUT
        // only while the run is making progress (ALI-1037). A run with no new
        // events since the last rotation is not extended: the box is left to wind
        // down to its current budget instead of the host paying for a stalled run.
        if (sandbox.extendTimeout && sandboxBudgetMs + rotationIntervalMs <= sandboxCapMs) {
          if (!(await hasEventProgress())) {
            log('sandbox timeout NOT extended: no run events since the last rotation (agent stalled) — letting the box wind down')
          } else {
            try {
              await sandbox.extendTimeout(rotationIntervalMs)
              sandboxBudgetMs += rotationIntervalMs
              log(`extended sandbox timeout (+${Math.round(rotationIntervalMs / 1000)}s, budget ${Math.round(sandboxBudgetMs / 60000)}m)`)
            } catch (error) {
              log(`sandbox extendTimeout failed: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
        }
      } catch (error) {
        // No run-event emit on failure either: the host is not the run's event
        // writer (see the successful-rotation note above). Failure visibility is
        // this local log plus, if the token will lapse, emitRotationFailureEvent()
        // below — which fires ONLY on the terminal/dying path, not the live stream.
        log(`bearer rotation failed: ${error instanceof Error ? error.message : String(error)}`)
        // Fast-retry on the short interval — never silently ride the token to
        // expiry. Give up loudly if the current token will lapse before another
        // retry could land (leave-to-expire is the documented v0 behavior).
        if (now() + ROTATION_FAST_RETRY_MS >= tokenExpiresAtMs) {
          log(
            'CRITICAL: cannot refresh the agent bearer before it expires; the hosted run will ' +
              'lose its Orizu credential and finish when the token lapses. Reconnect with `orizu run tail`.'
          )
          await emitRotationFailureEvent()
          stop()
          break
        }
        delayMs = ROTATION_FAST_RETRY_MS
      }
    }
  }
  const tailer =
    opts.tailImpl ??
    (async (): Promise<void> => {
      // Production default is `orizu run tail` (existing command); the caller
      // wires it. Without an injected tailer we simply return so the CLI can
      // hand off to the standard tail command.
    })
  const rotationTask = rotate()
  try {
    await tailer({ fetcher: opts.fetcher, runId, onEvent: opts.onTailEvent })
  } finally {
    stop()
    await rotationTask
    // Reap: the tail returns once the run reaches terminal — destroy the box.
    try {
      await sandbox.destroy()
      log(`sandbox ${sandbox.id} destroyed (run terminal)`)
    } catch (error) {
      log(`sandbox teardown failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return base
}

// -- Thin CLI dispatch (`session start --hosted` + `internal hosted-loop`) -----

export interface HostedCommandIo {
  print: (line: string) => void
  printErr?: (line: string) => void
  json?: boolean
}

function argVal(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag)
  if (index === -1 || index + 1 >= args.length) return null
  const value = args[index + 1]
  return value.startsWith('--') ? null : value
}

function hasFlag(args: readonly string[], flag: string): boolean {
  return args.includes(flag)
}

function numFlag(args: readonly string[], flag: string): number | undefined {
  const raw = argVal(args, flag)
  if (!raw) return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

const HOSTED_USAGE =
  'Usage: orizu session start --hosted --task "<prompt>" [--duration <min> (default 60, max 1440)] ' +
  '[--model <provider/model>] [--reasoning-effort <level>] [--project <team/project>] ' +
  '[--title <title>] [--tail]\n' +
  'Default: the Orizu server provisions the sandbox (no VERCEL_* or model key needed on your machine); ' +
  'the session coordinator owns its lifetime (ALI-1055).\n' +
  'DEPRECATED escape hatch: --operator provisions from THIS machine (requires VERCEL_* + ANTHROPIC_API_KEY ' +
  'or --model-key; extra flags: [--provider vercel|local-sim] [--image <ref>] [--snapshot <id>]). ' +
  'Removal is planned after DO-coordinator validation (ALI-1055).\n' +
  'Note (v0, --operator only): if you disconnect, the agent token expires within its TTL (<=60m) and the run ' +
  'finishes cleanly; reconnect with `orizu run tail --run <id>`. The sandbox timeout is independent (up to 24h).'

/** Printed on EVERY `--operator` use (founder-locked: deprecate NOW, remove
 *  after Phase 6 validation). Loud on purpose. */
export const OPERATOR_DEPRECATION_WARNING =
  '! DEPRECATED: --operator (operator-provisioned hosted sessions) is deprecated; ' +
  'removal planned after DO-coordinator validation — ALI-1055. ' +
  'The default server path needs no VERCEL_* or model key on your machine.'

/**
 * Default hosted path (ALI-1055 cutover): POST the server's hosted-sessions
 * route and let the Durable Object coordinator own the sandbox lifetime. The
 * CLI never reads VERCEL_* or a model key on this path — the server holds them.
 */
export async function startHostedViaServer(
  args: readonly string[],
  workspaceId: string,
  task: string,
  tail: boolean,
  io: HostedCommandIo,
  fetcher: HostFetcher = (path, init) => authedFetch(path, init)
): Promise<number> {
  const payload: Record<string, unknown> = {
    workspaceId,
    task,
    durationMinutes: numFlag(args, '--duration'),
    model: argVal(args, '--model') ?? undefined,
    reasoningEffort: argVal(args, '--reasoning-effort') ?? undefined,
    projectSlug: argVal(args, '--project') ?? undefined,
    title: argVal(args, '--title') ?? undefined,
  }
  let response: Response
  try {
    response = await fetcher('/api/cli/hosted-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (error) {
    io.printErr?.(`hosted session request failed: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
  const errorMessage = typeof body.error === 'string' ? body.error : `${response.status}`

  if (response.status === 503) {
    io.printErr?.(errorMessage)
    io.printErr?.(
      'Re-run with `orizu session start --hosted --operator ...` to provision from your machine ' +
        '(deprecated escape hatch; requires the Vercel token + snapshot on your side).'
    )
    return 1
  }
  if (!response.ok) {
    io.print(io.json ? JSON.stringify({ ok: false, error: errorMessage }) : `hosted session failed: ${errorMessage}`)
    return 1
  }

  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
  const runId = typeof body.runId === 'string' ? body.runId : ''
  if (io.json) {
    io.print(JSON.stringify({ ok: true, sessionId, runId: runId || null, coordinator: body.coordinator ?? null }))
  } else {
    io.print(
      `hosted session started: session ${sessionId}` +
        (runId ? `, run ${runId}` : '') +
        ' (coordinator-managed sandbox)'
    )
    if (!tail && runId) io.print(`stream it: orizu run tail --run ${runId}`)
  }

  if (tail && runId) {
    await tailWorkbenchRun({
      fetcher,
      runId,
      onEvent: event =>
        io.print(
          io.json
            ? JSON.stringify(event)
            : `#${String((event as Record<string, unknown>).sequence ?? '?')} ${String((event as Record<string, unknown>).eventType ?? '')}`
        ),
    })
  }
  return 0
}

/** Test seams for `hostedCommand` dispatch (server default vs operator hatch). */
export interface HostedCommandDeps {
  startViaServer?: typeof startHostedViaServer
  startViaOperator?: (args: string[], workspaceId: string, task: string, tail: boolean, io: HostedCommandIo) => Promise<number>
}

/**
 * Dispatch `orizu internal hosted-loop` (in-sandbox) and `orizu session start
 * --hosted` (host-side). Kept out of index.ts so the CLI entrypoint stays a thin
 * dispatcher (ALI-976 ratchet).
 *
 * ALI-1055 cutover: the DEFAULT is the server path (POST /api/cli/hosted-sessions
 * → DO coordinator). `--operator` keeps the old client-provisioned flow as a
 * DEPRECATED escape hatch (loud warning on every use; removal after Phase 6).
 */
export async function hostedCommand(
  args: string[],
  io: HostedCommandIo,
  deps: HostedCommandDeps = {}
): Promise<number> {
  const positional = args.filter(arg => !arg.startsWith('--'))
  if (positional[0] === 'internal') {
    if (positional[1] === 'hosted-loop') {
      return hostedLoopCommand(args, io)
    }
    // ALI-1057: the DO-path in-sandbox boot entrypoint (ORIZU_SANDBOX_ENTRYPOINT).
    if (positional[1] === 'hosted-boot') {
      return hostedBootCommand(io)
    }
    // ALI-1084: the one-shot merge sandbox entrypoint (MergeJobCoordinator DO).
    if (positional[1] === 'merge-job') {
      return mergeJobCommand(io)
    }
    io.printErr?.('Usage: orizu internal <hosted-loop --context <path> | hosted-boot | merge-job>')
    return 1
  }

  const task = argVal(args, '--task')
  if (!task) {
    io.printErr?.(HOSTED_USAGE)
    return 1
  }
  const workspaceId = argVal(args, '--workspace') ?? attachedWorkspaceId(getWorkspaceRoot(process.cwd()))
  if (!workspaceId) {
    io.printErr?.('No attached workspace — run `orizu workspace sync` first, or pass --workspace <id>.')
    return 1
  }
  const tail = hasFlag(args, '--tail')

  if (!hasFlag(args, '--operator')) {
    // DEFAULT (ALI-1055): server-provisioned. No provider, no VERCEL_* read, no
    // model key on the customer machine — the coordinator owns the lifetime.
    return (deps.startViaServer ?? startHostedViaServer)(args, workspaceId, task, tail, io)
  }

  // DEPRECATED operator escape hatch — warn LOUDLY on every use.
  io.printErr?.(OPERATOR_DEPRECATION_WARNING)
  if (deps.startViaOperator) {
    return deps.startViaOperator(args, workspaceId, task, tail, io)
  }
  const providerKind = (argVal(args, '--provider') ?? 'vercel').toLowerCase()
  const provider: SandboxProvider =
    providerKind === 'local-sim' ? createLocalSimProvider() : createVercelProvider()

  const hostFetcher: HostFetcher = (path, init) => authedFetch(path, init)
  const result = await startHostedSession({
    fetcher: hostFetcher,
    apiBaseUrl: resolveBaseUrl(),
    provider,
    workspaceId,
    task,
    // Resolve the per-team additive egress domains at create (best-effort — a
    // failure falls back to the base allowlist only). Human-scoped read.
    resolveExtraEgressDomains: async (id: string): Promise<readonly string[]> => {
      const response = await hostFetcher(`/api/cli/workspaces/${encodeURIComponent(id)}/egress-allowlist`)
      if (!response.ok) return []
      const data = (await response.json().catch(() => ({}))) as { extraDomains?: unknown }
      return Array.isArray(data.extraDomains) ? data.extraDomains.filter((d): d is string => typeof d === 'string') : []
    },
    projectSlug: argVal(args, '--project'),
    model: argVal(args, '--model') ?? undefined,
    durationMinutes: numFlag(args, '--duration'),
    runtime: argVal(args, '--runtime') ?? undefined,
    // Pre-baked runtime (ALI-1017): flag wins, else env. Image = Docker/VCR path,
    // snapshot = zero-Docker path; both flip the install-skip flag. startHostedSession
    // enforces mutual exclusion.
    hostedImage: argVal(args, '--image') ?? process.env.ORIZU_HOSTED_IMAGE ?? undefined,
    hostedSnapshot: argVal(args, '--snapshot') ?? process.env.ORIZU_HOSTED_SNAPSHOT ?? undefined,
    tail,
    // Model key: explicit --model-key wins, else ANTHROPIC_API_KEY. Falsy → the
    // fail-fast in startHostedSession throws before any session/sandbox is made.
    modelApiKey: argVal(args, '--model-key') ?? (process.env.ANTHROPIC_API_KEY || undefined),
    logLine: line => io.print(line),
    onTailEvent: event =>
      io.print(io.json ? JSON.stringify(event) : `#${String(event.sequence ?? '?')} ${String(event.eventType ?? '')}`),
    tailImpl: tail
      ? async ({ fetcher, runId, onEvent }) => {
          await tailWorkbenchRun({ fetcher, runId, onEvent: event => onEvent?.(event as Record<string, unknown>) })
        }
      : undefined,
  })

  if (io.json) {
    io.print(JSON.stringify({ ok: result.ok, sessionId: result.sessionId, runId: result.runId, sandboxId: result.sandboxId, error: result.error }))
  } else if (result.ok) {
    io.print(`hosted session ready: session ${result.sessionId}, run ${result.runId}`)
    if (!tail) io.print(`stream it: orizu run tail --run ${result.runId}`)
  } else {
    io.print(`hosted session failed: ${result.error ?? 'unknown error'}`)
  }
  return result.ok ? 0 : 1
}
