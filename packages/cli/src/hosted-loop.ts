/**
 * In-sandbox hosted agent loop (ALI-928 / P3.5, per ADR-005).
 *
 * Runs INSIDE the sandbox (installed by the bootstrap CLI step, launched
 * DETACHED by `orizu session start --hosted`). It composes the ALI-926 pieces:
 *
 *   1. resolve the loop boot context (a run-scoped JSON file written by the host
 *      orchestrator) + read the agent bearer from its 0600 file (G3);
 *   2. install `opencode` pinned to OPENCODE_PINNED_VERSION (non-fatal-RECORDED;
 *      if it is unavailable the spawn/connect below fails and the run finishes
 *      'failed' cleanly — the run never dangles);
 *   3. build a RESUME-AWARE RunEventSink (continues the server's sequence after
 *      the run-start + bootstrap events — so a reconnect loses nothing);
 *   4. provision the `AgentHarness` SELECTED by `context.harness` (default
 *      'opencode': install+spawn `opencode serve` then connect the OpenCode
 *      driver; 'claude-agent-sdk': construct the in-process Claude-Agent-SDK
 *      driver — no server to install or spawn), then drive the SINGLE task prompt
 *      (v0: no queue) through `drainHarnessToSink`;
 *   5. the terminal event decides the run's final status via the sink's PATCH.
 *
 * SWAPPABILITY (ALI-929 / P3.6): harness SELECTION is the ONLY thing that differs
 * between the two drivers — `start()` → `runPrompt()` → `drainHarnessToSink()` →
 * `shutdown()` is byte-identical for both, and the sink, event vocabulary, and
 * terminal-PATCH flow are unchanged. That is the proof: a second harness drops in
 * behind the seam with no change to any consumer beyond the selector.
 *
 * The redaction list carries the agent bearer (added automatically by the sink)
 * plus any model key present in the process env (defense in depth for the G3
 * per-exec fallback — with firewall brokering the real key never reaches here).
 *
 * TESTABILITY: `runHostedLoop` takes injected `fetchImpl`, `spawnOpenCode`,
 * `installOpenCode`, and `createHarness`, so the whole loop runs in-process
 * against a fake broker + fake OpenCode server with no real binary.
 */

import { spawnSync, spawn as nodeSpawn } from 'child_process'
import { closeSync, existsSync, openSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { AgentHarness, HarnessEvent, HarnessPrompt } from './hosted-harness.js'
import {
  HOSTED_TASK_PREAMBLE,
  PREBAKED_MARKER_PATH,
  SETUP_HOOK_RELATIVE_PATH,
  composeHostedTaskPrompt,
  parsePrebakedMarker,
} from './hosted-runtime-assets.js'
import { harvestWorkspace, type HarvestExec, type HarvestOutcome } from './hosted-harvest.js'
import { annotateHeadlessQuestions, withIdleWatchdog } from './hosted-headless.js'
import {
  OPENCODE_PINNED_VERSION,
  createOpenCodeHarness,
  spawnOpenCode,
  type SpawnOpenCodeOptions,
  type SpawnedOpenCode,
} from './hosted-harness-opencode.js'
import { createClaudeAgentHarness } from './hosted-harness-claude.js'
import {
  drainHarnessToSink,
  resumeRunEventSink,
  type HostedFetch,
  type TerminalStatus,
} from './hosted-run-event-sink.js'

/**
 * The run-scoped context the host orchestrator writes for the loop. Paths are
 * ABSOLUTE (or sandbox-root-relative) so the loop resolves them regardless of
 * cwd. NO secret lives here — the bearer is read from `bearerFile` (0600).
 */
export interface HostedLoopContext {
  apiBaseUrl: string
  runId: string
  /** 0600 file holding the agent bearer (never inlined into this context). */
  bearerFile: string
  /** File holding the single task prompt (v0: one prompt, no queue). */
  taskFile: string
  /** Directory the agent operates in (the cloned session-branch workspace). */
  workspaceDir: string
  /** Provider-qualified model, e.g. "anthropic/claude-opus-4-8". */
  model: string
  reasoningEffort?: string
  /** Idempotency / correlation key for the prompt. */
  messageId: string
  /** Git identity for commit attribution during the prompt. */
  author: { name: string; email: string }
  /**
   * Which `AgentHarness` drives the loop (ALI-929 swappability seam). Default
   * 'opencode'. 'claude-agent-sdk' selects the in-process Claude-Agent-SDK driver
   * — no `opencode` install/spawn happens on that path.
   */
  harness?: 'opencode' | 'claude-agent-sdk'
  opencodePort?: number
  opencodePinnedVersion?: string
  /**
   * Pre-baked runtime (ALI-1017): the image already ships the pinned `opencode`
   * on PATH, so the loop SKIPS the `opencode-ai` install (npm is blocked under G5
   * default-deny egress) and spawns `opencode` directly, recording an
   * `opencode_prebaked` artifact instead of `opencode_install`. The host sets this
   * together with the sandbox `image` so the two never disagree. When unset, the
   * loop ALSO belt-checks the `/opt/orizu/prebaked.json` marker; either signal
   * skips the install. Ignored on the claude-agent-sdk path (no server to install).
   */
  prebaked?: boolean
  /**
   * Non-secret placeholder key OpenCode is given so it FORMS model requests; the
   * sandbox firewall's request transform overrides the real auth header at the
   * proxy (model-key brokering, G3). Never a real key.
   */
  anthropicDummyKey?: string
  /** OpenCode session id to resume on reconnect. */
  resumeAgentSessionId?: string
  /**
   * Startup egress-canary probe host (G5 / ALI-1006). When SET, the loop runs a
   * POSITIVE-CONTROL canary before any agent work, probing BOTH this known
   * NON-allowlisted (denied) host AND a known-allowed host (the Orizu API base,
   * derived from `apiBaseUrl`). The run proceeds ONLY IF the allowed host is
   * reachable AND the denied host is blocked (`egress_blocked` proof). Any other
   * outcome FAILS the run closed (`egress_allowed`): the denied host reachable
   * means the firewall did not take; the allowed host ALSO unreachable means the
   * network is broken and we cannot distinguish policy-enforcement from a total
   * outage — either way we must not proceed to real customer data. The host sets
   * this only for providers that actually enforce egress (Vercel); it is UNSET
   * for local-sim / no-policy runs, so the canary is skipped there. Default
   * denied probe target: `example.com`.
   */
  egressCanaryHost?: string
  /**
   * When true, run the customer `.orizu/setup.sh` hook HERE (in the loop), AFTER
   * the egress canary has proven the firewall is live and BEFORE harness work.
   * The host sets this for enforced-egress providers so bootstrap DEFERS the hook
   * (which would otherwise get network access before the canary could detect a
   * silent firewall failure). UNSET for local-sim / no-policy runs, where
   * bootstrap runs the hook inline as before. See docs sandbox-egress-policy §4.
   */
  runSetupHook?: boolean
}

/**
 * Environment injected into the spawned OpenCode server so the AGENT's bash sees a
 * PRE-AUTHENTICATED `orizu` CLI (ALI-1044). ORIZU_TOKEN_FILE points at the 0600
 * rotated bearer file and ORIZU_BASE_URL at the Orizu API — the exact vars the
 * CLI's auth resolution reads (resolveEnvBearerToken + resolveBaseUrl). The dummy
 * ANTHROPIC key (model-key brokering, G3) is preserved. No real secret is carried
 * here: the bearer stays on disk and is read fresh per request from the file.
 */
export function buildOpenCodeSpawnEnv(context: HostedLoopContext): Record<string, string> | undefined {
  const env: Record<string, string> = {}
  if (context.anthropicDummyKey) {
    env.ANTHROPIC_API_KEY = context.anthropicDummyKey
  }
  if (context.bearerFile) {
    env.ORIZU_TOKEN_FILE = context.bearerFile
  }
  if (context.apiBaseUrl) {
    env.ORIZU_BASE_URL = context.apiBaseUrl
  }
  return Object.keys(env).length > 0 ? env : undefined
}

export interface InstallResult {
  ok: boolean
  detail: string
}

export interface RunHostedLoopOptions {
  context: HostedLoopContext
  /**
   * Agent bearer, as a FIXED string (tests / in-process launcher) OR omitted in
   * favor of `bearerProvider`. In production the loop reads the rotated 0600
   * bearer file per request via a provider (see `bearerProvider`), so a
   * host-side rotation is picked up without restarting the loop.
   */
  bearer?: string
  /** Per-request bearer resolver (default: read `context.bearerFile`, trimmed).
   *  Passing a provider is what lets rotation reach the event sink. */
  bearerProvider?: () => string
  /** The single task prompt (already read from the task file by the caller). */
  taskPrompt: string
  fetchImpl?: HostedFetch
  /** Build the harness for a spawned OpenCode base URL (default: OpenCode driver). */
  createHarness?: (baseUrl: string) => AgentHarness
  /** Build the in-process Claude-Agent-SDK harness (default: real SDK loader).
   *  Injectable so the swap test drives a fake `query()` with no real SDK. */
  createClaudeHarness?: () => AgentHarness
  spawnOpenCode?: (opts: SpawnOpenCodeOptions) => SpawnedOpenCode | Promise<SpawnedOpenCode>
  installOpenCode?: () => Promise<InstallResult>
  now?: () => number
  signal?: AbortSignal
  /** Extra verbatim secrets to redact (the bearer is added by the sink itself). */
  redactSecretsList?: readonly string[]
  /** Egress-canary probe (default: a bounded `fetch` to https://<host>/).
   *  Injectable so tests exercise both the blocked and reachable branches with
   *  no real network. Called once per host (allowed + denied) by the canary. */
  probeEgress?: (host: string) => Promise<EgressProbeResult>
  /** Run the deferred customer setup hook (default: `bash .orizu/setup.sh` in the
   *  workspace, non-fatal). Injectable so tests exercise the deferred-hook path
   *  with no real filesystem or child process. */
  runSetupHook?: (input: { workspaceDir: string }) => Promise<SetupHookOutcome> | SetupHookOutcome
  /**
   * Standing preamble wrapped around the user task (ALI-1036). Defaults to
   * `HOSTED_TASK_PREAMBLE`; pass an override to customize it, or an empty string
   * to send the task verbatim (tests). The user task is always kept verbatim
   * beneath a delimiter (see `composeHostedTaskPrompt`).
   */
  taskPreamble?: string
  /**
   * Injectable git runner for the end-of-run auto-harvest (ALI-1036). Default:
   * real `git` via child_process in `context.workspaceDir`.
   */
  harvestExec?: HarvestExec
  /**
   * Idle watchdog window (ALI-1037): abort the prompt + fail the run
   * `agent_stalled` if NO harness event arrives for this many ms. Default: env
   * `ORIZU_AGENT_IDLE_TIMEOUT_MS` or 10 minutes. <= 0 disables the watchdog.
   */
  idleTimeoutMs?: number
}

export interface HostedLoopResult {
  status: TerminalStatus
  agentSessionId: string | null
  installOk: boolean
  error: string | null
}

/** Default egress-canary probe host (a known non-allowlisted destination). */
export const DEFAULT_EGRESS_CANARY_HOST = 'example.com'
/** Bound (ms) on the canary probe — a live firewall resets/times out fast; a
 *  reachable host answers well within this. */
const EGRESS_CANARY_TIMEOUT_MS = 5000

export interface EgressProbeResult {
  /** True when the denied host was reachable (policy did NOT take → fail closed). */
  reachable: boolean
  /** Short human/audit detail (HTTP status on reach, error class on block). */
  detail: string
}

/**
 * Default probe: attempt a bounded HTTPS GET to `host`. A live default-deny
 * firewall makes this THROW for a DENIED host (connection reset / timeout / DNS
 * failure) → `reachable: false`. Any response at all — even an error status —
 * proves the host was reachable → `reachable: true`. Used for BOTH the allowed
 * (positive-control) and denied probes.
 */
async function defaultProbeEgress(host: string): Promise<EgressProbeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), EGRESS_CANARY_TIMEOUT_MS)
  try {
    const response = await fetch(`https://${host}/`, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    })
    return { reachable: true, detail: `reachable (HTTP ${response.status})` }
  } catch (error) {
    return { reachable: false, detail: `blocked (${error instanceof Error ? error.name : 'error'})` }
  } finally {
    clearTimeout(timer)
  }
}

/** The two hosts the positive-control canary probes. */
export interface EgressCanaryTargets {
  /** A known-ALLOWED host (the Orizu API base) that MUST be reachable — the
   *  positive control that distinguishes "policy blocking" from "network dead". */
  allowedHost: string
  /** A known-DENIED, non-allowlisted host that MUST be blocked (`example.com`). */
  deniedHost: string
}

export interface EgressCanaryDecision {
  proceed: boolean
  /** Null on proceed; a human/audit reason for the fail-closed decision. */
  reason: string | null
  allowed: EgressProbeResult
  denied: EgressProbeResult
}

/**
 * Run the startup egress canary as a POSITIVE CONTROL and emit the proof event
 * through the (single-writer) sink. Probes BOTH a known-allowed host and the
 * known-denied host, then decides:
 *
 *   - allowed REACHABLE and denied BLOCKED → the firewall is live AND the network
 *     works → emit `egress_blocked` and PROCEED (the ONLY healthy outcome);
 *   - denied REACHABLE → egress is NOT enforced → emit `egress_allowed`, FAIL
 *     CLOSED;
 *   - allowed ALSO UNREACHABLE (denied blocked but the positive control failed) →
 *     we cannot tell policy-blocking from a total network outage → emit
 *     `egress_allowed`, FAIL CLOSED.
 *
 * The `egress_blocked` kind therefore means EXACTLY "proceeded, positive control
 * passed"; `egress_allowed` means "failed closed" (the payload `result` field
 * distinguishes an unexpectedly-reachable denied host from an unreachable
 * positive control). Old behavior — treating ANY denied-host throw (incl. a
 * timeout under a total outage) as "blocked → proceed" — failed OPEN; this now
 * fails closed on that ambiguity.
 */
export async function runEgressCanary(
  targets: EgressCanaryTargets,
  sink: { append: (event: HarnessEvent) => Promise<void> },
  probe: (host: string) => Promise<EgressProbeResult>,
  now: () => number = () => Date.now()
): Promise<EgressCanaryDecision> {
  const [allowed, denied] = await Promise.all([probe(targets.allowedHost), probe(targets.deniedHost)])
  const checkedAt = new Date(now()).toISOString()
  const positiveControl = {
    host: targets.allowedHost,
    reachable: allowed.reachable,
    detail: allowed.detail,
  }

  // FAIL CLOSED: a denied host answered — the policy is not enforcing egress.
  if (denied.reachable) {
    await sink.append({
      kind: 'egress_allowed',
      critical: true,
      payload: {
        host: targets.deniedHost,
        result: 'unexpectedly_reachable',
        detail: denied.detail,
        positiveControl,
        checkedAt,
      },
    })
    return {
      proceed: false,
      reason: `denied host ${targets.deniedHost} was reachable (${denied.detail}) — egress is not enforced`,
      allowed,
      denied,
    }
  }

  // FAIL CLOSED: the denied host was blocked, but the positive control ALSO did
  // not answer — the environment/network is broken and we cannot distinguish a
  // policy block from a total outage. This is the case the old code got wrong.
  if (!allowed.reachable) {
    await sink.append({
      kind: 'egress_allowed',
      critical: true,
      payload: {
        host: targets.deniedHost,
        result: 'positive_control_unreachable',
        detail: denied.detail,
        positiveControl,
        checkedAt,
      },
    })
    return {
      proceed: false,
      reason: `positive control ${targets.allowedHost} was unreachable (${allowed.detail}) — cannot distinguish egress enforcement from a network outage`,
      allowed,
      denied,
    }
  }

  // HEALTHY: allowed reachable AND denied blocked → the firewall is live.
  await sink.append({
    kind: 'egress_blocked',
    critical: true,
    payload: {
      host: targets.deniedHost,
      result: 'blocked',
      detail: denied.detail,
      positiveControl,
      checkedAt,
    },
  })
  return { proceed: true, reason: null, allowed, denied }
}

/**
 * Derive the known-ALLOWED positive-control host from the run's Orizu API base —
 * always allowlisted (it is the agent's control-plane path) and ours, so it is
 * the safest "must be reachable" signal. Falls back to a lenient host parse if
 * the base is not a well-formed URL.
 */
export function egressCanaryAllowedHost(apiBaseUrl: string): string {
  try {
    return new URL(apiBaseUrl).hostname
  } catch {
    return apiBaseUrl.replace(/^[a-z]+:\/\//i, '').split('/')[0].split(':')[0]
  }
}

/** Outcome of the deferred customer setup hook run inside the loop. */
export interface SetupHookOutcome {
  /** True when a `.orizu/setup.sh` existed and was executed. */
  ran: boolean
  /** True when the hook was absent OR exited 0 (non-fatal either way). */
  ok: boolean
  detail: string
}

/**
 * Default deferred-setup-hook runner (in-sandbox): run `bash .orizu/setup.sh` in
 * the workspace if present. Non-fatal — a missing hook or a non-zero exit is
 * recorded and the loop proceeds, matching the bootstrap's inline behavior.
 */
function defaultRunSetupHook({ workspaceDir }: { workspaceDir: string }): SetupHookOutcome {
  const hookPath = join(workspaceDir, SETUP_HOOK_RELATIVE_PATH)
  if (!existsSync(hookPath)) return { ran: false, ok: true, detail: 'no .orizu/setup.sh' }
  const res = spawnSync('bash', [SETUP_HOOK_RELATIVE_PATH], { cwd: workspaceDir, encoding: 'utf8' })
  const ok = (res.status ?? 1) === 0
  return { ran: true, ok, detail: ok ? 'setup.sh ok' : `setup.sh exit ${res.status ?? 'unknown'}` }
}

/** Default idle-watchdog window (ALI-1037): abort a prompt that makes no progress
 *  for this long. The timer resets on every harness EVENT, and a legitimate long
 *  single tool call (a big `npm install`, a build, an optimization step) emits no
 *  intermediate events — so this must comfortably exceed the longest expected
 *  quiet tool call (review finding #2). Overridable per-run via `idleTimeoutMs` or
 *  the `ORIZU_AGENT_IDLE_TIMEOUT_MS` env var. */
export const DEFAULT_AGENT_IDLE_TIMEOUT_MS = 25 * 60 * 1000

/** Resolve the idle window: explicit option wins, then env, then the default. */
function resolveIdleTimeoutMs(override: number | undefined): number {
  if (typeof override === 'number' && Number.isFinite(override)) return override
  const raw = process.env.ORIZU_AGENT_IDLE_TIMEOUT_MS
  if (raw) {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed)) return parsed
  }
  return DEFAULT_AGENT_IDLE_TIMEOUT_MS
}

/** Model-key env vars whose value must be scrubbed from every run event. */
const MODEL_KEY_ENV_VARS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']

function redactionListFromEnv(): string[] {
  const secrets: string[] = []
  for (const key of MODEL_KEY_ENV_VARS) {
    const value = process.env[key]
    if (value) secrets.push(value)
  }
  return secrets
}

/**
 * Decide whether the loop is running the PRE-BAKED runtime image (ALI-1017).
 * Prefers the explicit boot-context flag (the host KNOWS the image it passed);
 * falls back to a belt read of the `/opt/orizu/prebaked.json` marker (validated
 * via `parsePrebakedMarker`, so a stray file cannot trigger a skip). Either → true.
 */
function detectLoopPrebaked(flag: boolean | undefined): boolean {
  if (flag) return true
  try {
    return parsePrebakedMarker(readFileSync(PREBAKED_MARKER_PATH, 'utf8')) !== null
  } catch {
    return false
  }
}

/** Best-effort global install of the pinned opencode. Non-fatal: a failure is
 *  recorded and the run finishes cleanly when the subsequent connect fails. */
function installOpenCodePinned(version: string): InstallResult {
  const command =
    `bun add -g opencode-ai@${version} >/dev/null 2>&1 || ` +
    `npm install -g opencode-ai@${version} >/dev/null 2>&1`
  const res = spawnSync('bash', ['-c', command], { encoding: 'utf8' })
  const ok = (res.status ?? 1) === 0
  return { ok, detail: ok ? `installed opencode-ai@${version}` : `install exit ${res.status ?? 'unknown'}` }
}

/** Node child_process spawner for `opencode serve` (the sandbox runtime is
 *  node24 — Bun.spawn is not guaranteed present, so spawnOpenCode is given this
 *  runtime-agnostic spawner). When a logPath is provided, opencode's
 *  stdout/stderr land there so a readiness timeout can surface the real boot
 *  failure instead of a bare "fetch failed" (ALI-1034). */
function nodeChildSpawner(
  cmd: string[],
  opts: { cwd?: string; env: Record<string, string>; logPath?: string }
): { kill: () => void } {
  let stdio: 'ignore' | Array<'ignore' | number> = 'ignore'
  let fd: number | null = null
  if (opts.logPath) {
    try {
      fd = openSync(opts.logPath, 'a')
      stdio = ['ignore', fd, fd]
    } catch {
      // log capture is best-effort — never block the spawn on it
    }
  }
  const child = nodeSpawn(cmd[0], cmd.slice(1), {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio,
  })
  if (fd !== null) {
    // The child holds its own copy of the descriptor.
    try {
      closeSync(fd)
    } catch {
      // already closed
    }
  }
  return { kill: () => child.kill() }
}

export async function runHostedLoop(opts: RunHostedLoopOptions): Promise<HostedLoopResult> {
  const { context, taskPrompt } = opts
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as HostedFetch)
  const signal = opts.signal ?? new AbortController().signal
  const pinnedVersion = context.opencodePinnedVersion ?? OPENCODE_PINNED_VERSION

  // Resolve the bearer per request. Precedence: an explicit provider, then a
  // fixed string, else read the rotated 0600 bearer file every time (production
  // + rotation path — a host-side rotation overwrites this file and the sink's
  // next resolve picks it up).
  const fixedBearer = opts.bearer
  const bearerProvider: () => string =
    opts.bearerProvider ??
    (fixedBearer !== undefined
      ? (): string => fixedBearer
      : (): string => readFileSync(context.bearerFile, 'utf8').trim())

  // Build the resume-aware sink FIRST: even if the opencode install/spawn fails,
  // we can record a terminal transition so the run is never left non-terminal.
  const sink = await resumeRunEventSink({
    apiBaseUrl: context.apiBaseUrl,
    runId: context.runId,
    bearer: bearerProvider,
    fetchImpl,
    now: opts.now,
    redactSecretsList: [...(opts.redactSecretsList ?? []), ...redactionListFromEnv()],
  })

  // G5 startup canary (fail-closed, POSITIVE CONTROL): when the host applied an
  // enforced egress policy it sets `egressCanaryHost`; probe BOTH the denied host
  // AND a known-allowed host (the Orizu API base) BEFORE any agent work. Proceed
  // ONLY IF the allowed host is reachable and the denied host is blocked; any
  // other outcome (denied reachable → firewall not enforcing; allowed ALSO
  // unreachable → network broken / indistinguishable from a block) emits
  // `egress_allowed` and finishes the run FAILED rather than touch real customer
  // data. A canary whose own event append fails is likewise fail-closed.
  if (context.egressCanaryHost) {
    const probe = opts.probeEgress ?? defaultProbeEgress
    const targets: EgressCanaryTargets = {
      allowedHost: egressCanaryAllowedHost(context.apiBaseUrl),
      deniedHost: context.egressCanaryHost,
    }
    let canary: EgressCanaryDecision
    try {
      canary = await runEgressCanary(targets, sink, probe, opts.now)
    } catch (error) {
      // The canary's own event append failed — treat as fail-closed: we cannot
      // prove the firewall is live, so do not proceed.
      const message = error instanceof Error ? error.message : String(error)
      if (!sink.sealed) {
        try {
          await sink.finish('failed', { summary: { error: `egress canary error: ${message}` } })
        } catch {
          // best-effort terminal
        }
      }
      return { status: 'failed', agentSessionId: null, installOk: false, error: `egress canary error: ${message}` }
    }
    if (!canary.proceed) {
      const error = `egress canary FAILED: ${canary.reason} — refusing to proceed`
      if (!sink.sealed) {
        try {
          await sink.finish('failed', {
            summary: {
              error,
              egressCanary: {
                deniedHost: targets.deniedHost,
                deniedReachable: canary.denied.reachable,
                deniedDetail: canary.denied.detail,
                allowedHost: targets.allowedHost,
                allowedReachable: canary.allowed.reachable,
                allowedDetail: canary.allowed.detail,
              },
            },
          })
        } catch {
          // best-effort terminal
        }
      }
      return { status: 'failed', agentSessionId: null, installOk: false, error }
    }
  }

  // P3-a: run the DEFERRED customer setup hook now — AFTER the canary proved the
  // firewall is live, BEFORE any harness/network work. bootstrap deferred it (for
  // enforced-egress providers) precisely so its network access could not precede
  // the canary. Non-fatal, single-writer (this loop sink owns the run now).
  if (context.runSetupHook) {
    try {
      const runHook = opts.runSetupHook ?? defaultRunSetupHook
      const outcome = await runHook({ workspaceDir: context.workspaceDir })
      await sink.append({
        kind: 'artifact',
        payload: {
          step: outcome.ran ? 'setup_hook_completed' : 'setup_hook_skipped',
          ok: outcome.ok,
          detail: outcome.detail,
          deferred: true,
        },
      })
    } catch (error) {
      // The hook run/record is best-effort — never block the run on it.
      const message = error instanceof Error ? error.message : String(error)
      if (!sink.sealed) {
        try {
          await sink.append({
            kind: 'artifact',
            payload: { step: 'setup_hook_error', ok: false, detail: message, deferred: true },
          })
        } catch {
          // best-effort
        }
      }
    }
  }

  // End-of-run auto-harvest (ALI-1036): commit + push anything the agent left
  // uncommitted/unpushed so a run NEVER loses work — on BOTH the success and
  // failure paths. Runs at most once (guarded), records exactly one of
  // work_persisted / work_none / work_persist_failed, and NEVER throws or changes
  // the run's terminal status: a harvest failure is recorded and the run proceeds.
  let harvested = false
  const runAutoHarvest = async (): Promise<void> => {
    if (harvested) return
    harvested = true
    let outcome: HarvestOutcome
    try {
      outcome = harvestWorkspace({
        workspaceDir: context.workspaceDir,
        runId: context.runId,
        author: context.author,
        exec: opts.harvestExec,
        // Real harvest only inside a genuine hosted sandbox (prebaked marker
        // present) — never on a host/test working tree (review finding #1).
        enabled: existsSync(PREBAKED_MARKER_PATH),
      })
    } catch (error) {
      outcome = { kind: 'work_persist_failed', error: error instanceof Error ? error.message : String(error) }
    }
    if (sink.sealed) return
    try {
      if (outcome.kind === 'work_persisted') {
        await sink.append({ kind: 'work_persisted', payload: { sha: outcome.sha, files: outcome.files } })
      } else if (outcome.kind === 'work_none') {
        await sink.append({ kind: 'work_none', payload: {} })
      } else {
        await sink.append({ kind: 'work_persist_failed', payload: { error: outcome.error } })
      }
    } catch {
      // Recording harvest is best-effort — never fail the run because the harvest
      // event append failed.
    }
  }

  let spawned: SpawnedOpenCode | null = null
  let agentSessionId: string | null = null
  let installOk = false
  const harnessKind = context.harness ?? 'opencode'
  try {
    // --- Harness PROVISIONING: the ONLY thing that differs between the two
    // drivers (ALI-929). Everything after `harness` is constructed is identical.
    let harness: AgentHarness
    if (harnessKind === 'claude-agent-sdk') {
      // In-process agent loop: no server to install or spawn. Record an
      // analogous setup artifact so the event stream shape is unchanged.
      installOk = true
      await sink.append({
        kind: 'artifact',
        payload: { step: 'harness_select', harness: harnessKind, inProcess: true },
      })
      // G3 parity with the OpenCode path: hand the in-process SDK client the SAME
      // non-secret dummy key (firewall brokers the real key on egress).
      harness = (opts.createClaudeHarness ??
        ((): AgentHarness =>
          createClaudeAgentHarness({ anthropicDummyKey: context.anthropicDummyKey })))()
    } else {
      // PRE-BAKED (ALI-1017): the pinned `opencode` is already on PATH, so SKIP the
      // install (npm is blocked under G5 default-deny egress) and record
      // `opencode_prebaked`. FROM-SCRATCH (local-sim / fallback): install as before.
      const prebaked = detectLoopPrebaked(context.prebaked)
      if (prebaked) {
        installOk = true
        await sink.append({
          kind: 'artifact',
          payload: { step: 'opencode_prebaked', ok: true, detail: `opencode-ai@${pinnedVersion} pre-baked in the runtime image` },
        })
      } else {
        const install = opts.installOpenCode
          ? await opts.installOpenCode()
          : installOpenCodePinned(pinnedVersion)
        installOk = install.ok
        await sink.append({
          kind: 'artifact',
          payload: { step: 'opencode_install', ok: install.ok, detail: install.detail },
        })
      }

      const spawnImpl = opts.spawnOpenCode ?? spawnOpenCode
      // The default spawnOpenCode WAITS for the server to answer HTTP before
      // returning — OpenCode's first boot runs a one-time sqlite migration, and
      // starting the harness before the server listens raced straight into a
      // connection-refused "fetch failed" (ALI-1034).
      spawned = await spawnImpl({
        model: context.model,
        cwd: context.workspaceDir,
        port: context.opencodePort,
        env: buildOpenCodeSpawnEnv(context),
        spawn: nodeChildSpawner,
        logPath: join(tmpdir(), `opencode-serve-${context.runId}.log`),
        signal,
      })
      if (typeof spawned.readyAfterMs === 'number') {
        await sink.append({
          kind: 'artifact',
          payload: { step: 'opencode_ready', ok: true, waitedMs: spawned.readyAfterMs },
        })
      }

      harness = (opts.createHarness ?? ((baseUrl: string) => createOpenCodeHarness({ baseUrl })))(
        spawned.baseUrl
      )
    }

    const started = await harness.start({
      workspaceDir: context.workspaceDir,
      model: context.model,
      reasoningEffort: context.reasoningEffort,
      resumeAgentSessionId: context.resumeAgentSessionId,
    })
    agentSessionId = started.agentSessionId

    // Prompt scaffolding (ALI-1036): wrap the user task with the standing
    // headless preamble, keeping the task verbatim beneath a delimiter.
    const prompt: HarnessPrompt = {
      runId: context.runId,
      messageId: context.messageId,
      content: composeHostedTaskPrompt(taskPrompt, opts.taskPreamble ?? HOSTED_TASK_PREAMBLE),
      author: context.author,
    }
    // Drive the prompt through (a) question auto-handling annotation and (b) the
    // idle watchdog (ALI-1037): no harness event for `idleTimeoutMs` aborts the
    // prompt and throws `AgentStalledError` → the catch below harvests, then
    // finishes the run `failed`. The prompt runs under a CHILD AbortController
    // linked to the loop signal so the watchdog can abort the in-flight prompt
    // (unblocking a signal-respecting harness the same way a cancel would), then
    // best-effort `harness.stop()` the driver.
    const idleTimeoutMs = resolveIdleTimeoutMs(opts.idleTimeoutMs)
    const promptController = new AbortController()
    if (signal.aborted) promptController.abort()
    else signal.addEventListener('abort', () => promptController.abort(), { once: true })
    const annotated = annotateHeadlessQuestions(harness.runPrompt(prompt, promptController.signal))
    const drivenStream =
      idleTimeoutMs > 0
        ? withIdleWatchdog(annotated, {
            timeoutMs: idleTimeoutMs,
            onTimeout: async () => {
              promptController.abort()
              await harness.stop()
            },
          })
        : annotated
    const status = await drainHarnessToSink(drivenStream, sink, {
      summary: { agentSessionId },
      // Auto-harvest runs on EVERY terminal path, before the sink seals.
      beforeFinish: runAutoHarvest,
    })
    await harness.shutdown()
    return { status, agentSessionId, installOk, error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Fail closed: never leave the run non-terminal. finish() is idempotent and
    // no-ops when the drain already sealed the sink. Harvest FIRST (partial work
    // is valuable, incl. an idle-watchdog abort) — before the terminal seals.
    await runAutoHarvest()
    if (!sink.sealed) {
      try {
        await sink.finish('failed', { summary: { error: message } })
      } catch {
        // best-effort — the terminal write itself may be impossible (bearer gone)
      }
    }
    return { status: 'failed', agentSessionId, installOk, error: message }
  } finally {
    if (spawned) {
      try {
        spawned.stop()
      } catch {
        // ignore teardown failure
      }
    }
  }
}

// -- Thin CLI entry (`orizu internal hosted-loop --context <path>`) -----------

export interface HostedLoopCommandIo {
  print: (line: string) => void
  printErr?: (line: string) => void
  json?: boolean
}

function argValue(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag)
  if (index === -1 || index + 1 >= args.length) return null
  const value = args[index + 1]
  return value.startsWith('--') ? null : value
}

/**
 * Read the loop context + bearer + task from disk and run the loop. Invoked
 * in-sandbox as a hidden command; the run's terminal status is recorded
 * server-side regardless of this process's exit code.
 */
export async function hostedLoopCommand(
  args: readonly string[],
  io: HostedLoopCommandIo
): Promise<number> {
  const contextPath = argValue(args, '--context')
  if (!contextPath) {
    io.printErr?.('Usage: orizu internal hosted-loop --context <path>')
    return 1
  }
  let context: HostedLoopContext
  try {
    context = JSON.parse(readFileSync(contextPath, 'utf8')) as HostedLoopContext
  } catch (error) {
    io.printErr?.(`unreadable loop context: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  // Read the bearer per request (via the provider) so a host-side rotation that
  // overwrites the 0600 file is picked up without restarting the loop.
  const bearerProvider = (): string => readFileSync(context.bearerFile, 'utf8').trim()
  const taskPrompt = readFileSync(context.taskFile, 'utf8')
  const result = await runHostedLoop({ context, bearerProvider, taskPrompt })
  io.print(
    io.json
      ? JSON.stringify({ status: result.status, agentSessionId: result.agentSessionId, error: result.error })
      : `hosted-loop finished: ${result.status}${result.error ? ` (${result.error})` : ''}`
  )
  return result.error ? 1 : 0
}
