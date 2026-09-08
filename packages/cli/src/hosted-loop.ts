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
 *   5. checkpoint dirty or local-only Git work without replacing the agent's
 *      terminal result, then deliver that original result through the sink.
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
 * `installOpenCode`, `createHarness`, and Git execution, so the whole loop can
 * run in-process against fake boundaries; separate tests exercise the real
 * packaged CLI, HTTPS smart-Git transport, and OpenCode process boundary.
 */

import { spawnSync, spawn as nodeSpawn } from 'child_process'
import { closeSync, existsSync, openSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { isHarnessTerminalKind, type AgentHarness, type HarnessEvent, type HarnessPrompt } from './hosted-harness.js'
import {
  SETUP_HOOK_RELATIVE_PATH,
  composeHostedTaskPrompt,
  parsePrebakedMarker,
  resolveHostedTaskPreamble,
  resolvePrebakedMarkerPath,
} from './hosted-runtime-assets.js'
import { harvestWorkspace, type HarvestExec, type HarvestOutcome } from './hosted-harvest.js'
import { annotateHeadlessQuestions, withIdleWatchdog } from './hosted-headless.js'
import {
  DEFAULT_PROMPT_MAX_DURATION_MS,
  OPENCODE_PINNED_VERSION,
  awaitOpenCodeModelResolvable,
  createOpenCodeHarness,
  spawnOpenCode,
  type ModelValidationOutcome,
  type SpawnOpenCodeOptions,
  type SpawnedOpenCode,
} from './hosted-harness-opencode.js'
import { createClaudeAgentHarness } from './hosted-harness-claude.js'
import { INJECTED_ENV_VARS_ENV } from './hosted-environment.js'
import { interceptHostedQuestions } from './hosted-question.js'
import {
  drainHarnessToSink,
  resumeRunEventSink,
  RunTerminalError,
  TerminalDeliveryError,
  type BeforeFinishResult,
  type HostedFetch,
  type TerminalStatus,
} from './hosted-run-event-sink.js'
import {
  buildOpenCodeSpawnEnv,
  defaultProbeEgress,
  egressCanaryAllowedHost,
  runEgressCanary,
  type EgressCanaryDecision,
  type EgressCanaryTargets,
  type EgressProbeResult,
  type HostedLoopContext,
  type SetupHookOutcome,
} from './hosted-loop-lifecycle.js'

// The lifecycle/orchestration seam moved to `hosted-loop-lifecycle.ts`
// (ALI-1015 Phase 1) so `lib/hosted-runtime/` can share it with a server-side
// coordinator. Re-exported here so this module's public surface is unchanged.
export {
  DEFAULT_EGRESS_CANARY_HOST,
  DEFAULT_HOSTED_MODEL,
  buildOpenCodeSpawnEnv,
  egressCanaryAllowedHost,
  runEgressCanary,
} from './hosted-loop-lifecycle.js'
export type {
  EgressCanaryDecision,
  EgressCanaryTargets,
  EgressProbeResult,
  HostedLoopContext,
  SetupHookOutcome,
} from './hosted-loop-lifecycle.js'

// Time reserved BEFORE the sandbox self-terminates so a duration-capped prompt
// abort still has room to harvest partial work (commit/push) + write the terminal
// event: `promptMaxDurationMs = sandboxBudgetMs − this` (ALI-1061). 5 min is
// comfortably above the observed harvest+flush cost while costing little of a
// multi-hour budget.
export const PROMPT_HARVEST_MARGIN_MS = 5 * 60 * 1000

/**
 * Derive the per-prompt max-duration cap from the sandbox lifetime budget: the
 * budget minus a harvest margin, FLOORED at the harness default so a short or
 * undated run is never shortened below the historical 5400s cap (ALI-1061).
 * Undated runs (`sandboxBudgetMs` unset / non-positive) get exactly the default.
 */
export function derivePromptMaxDurationMs(sandboxBudgetMs: number | undefined): number {
  if (typeof sandboxBudgetMs !== 'number' || !Number.isFinite(sandboxBudgetMs) || sandboxBudgetMs <= 0) {
    return DEFAULT_PROMPT_MAX_DURATION_MS
  }
  return Math.max(DEFAULT_PROMPT_MAX_DURATION_MS, sandboxBudgetMs - PROMPT_HARVEST_MARGIN_MS)
}

export interface InstallResult {
  ok: boolean
  detail: string
}

interface HostedLoopSharedRuntime {
  harness: AgentHarness | null
  spawned: SpawnedOpenCode | null
  agentSessionId: string | null
  installOk: boolean
  startupComplete: boolean
  spawnLogPath: string
  closed: boolean
}

export interface HostedLoopSessionContext extends Omit<HostedLoopContext, 'runId' | 'bearerFile' | 'taskFile' | 'messageId'> {
  sessionId: string
  projectId: string | null
  sessionDir: string
}

export interface HostedLoopTurnContext {
  runId: string
  ordinal: number
  taskFile: string
  messageId: string
  bearerFile: string
}

export interface HostedLoopSessionHandle {
  context: HostedLoopSessionContext
  runtime: HostedLoopSharedRuntime
}

export interface RunHostedLoopOptions {
  context: HostedLoopContext
  /** Internal session runtime used by the public session/turn lifecycle. */
  sharedRuntime?: HostedLoopSharedRuntime
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
  /** Build the harness for a spawned OpenCode base URL (default: OpenCode driver).
   *  `options.promptMaxDurationMs` is the duration-derived per-prompt cap (ALI-1061). */
  createHarness?: (baseUrl: string, options?: { promptMaxDurationMs?: number }) => AgentHarness
  /** Build the in-process Claude-Agent-SDK harness (default: real SDK loader).
   *  Injectable so the swap test drives a fake `query()` with no real SDK. */
  createClaudeHarness?: () => AgentHarness
  spawnOpenCode?: (opts: SpawnOpenCodeOptions) => SpawnedOpenCode | Promise<SpawnedOpenCode>
  installOpenCode?: () => Promise<InstallResult>
  /**
   * Pre-prompt model validation against the RUNNING opencode's resolvable
   * catalog (ALI-1086). Default: `awaitOpenCodeModelResolvable`, which polls
   * `GET /config/providers` briefly so the boot-time models.dev refresh can
   * land. An `unresolvable` outcome fails the run BEFORE the first prompt with
   * an error naming the requested id and the resolvable alternatives; a
   * `skipped` outcome (catalog endpoint unreachable) proceeds — opencode's own
   * `session.error` remains the backstop. Injectable for tests.
   */
  validateModel?: (input: { baseUrl: string; model: string }) => Promise<ModelValidationOutcome>
  now?: () => number
  signal?: AbortSignal
  /** Prompt-only human interrupt. Unlike `signal`, this never controls harness
   *  provisioning or the session-scoped runtime. */
  interruptSignal?: AbortSignal
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
   * Standing preamble wrapped around the user task (ALI-1036/ALI-1867). Defaults
   * according to `context.sessionOrigin`; pass an override to customize it, or
   * an empty string to send the task verbatim (tests). The task stays verbatim
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
   * `agent_stalled` if NO progress event arrives for this many ms. Default: env
   * `ORIZU_AGENT_IDLE_TIMEOUT_MS` or 25 minutes. <= 0 disables the watchdog.
   */
  idleTimeoutMs?: number
  /** Injectable sleep for the terminal-delivery retry backoff (ALI-1065
   *  finding 2). Tests pass a no-op to avoid real delays. */
  sleepImpl?: (ms: number) => Promise<void>
  /** Value-free local diagnostics shared with the event sink. Production routes
   *  this through hosted-boot's stderr seam; consumer failures are ignored. */
  onDiagnostic?: (message: string) => void
}

export interface HostedLoopResult {
  status: TerminalStatus
  agentSessionId: string | null
  installOk: boolean
  error: string | null
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

/**
 * Loop-level retry schedule for an undeliverable TERMINAL transition (ALI-1065
 * finding 2). Each entry is a pause before one more full sink delivery cycle
 * (which itself retries ~4 times over ~350ms), so a transport blip of a few
 * seconds recovers with the ORIGINAL status instead of being re-recorded as
 * 'failed'. Bounded: a persistently unreachable control plane fails the
 * DELIVERY visibly (result.error) without recording a wrong outcome.
 */
export const TERMINAL_DELIVERY_RETRY_DELAYS_MS: readonly number[] = [2_000, 8_000]

/** Model-key env vars whose value must be scrubbed from every run event. */
const MODEL_KEY_ENV_VARS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']

/**
 * Env var naming OTHER env vars whose values were injected as secrets — the
 * server env-bundle pull (ALI-1055: `GET /api/coordinator/sessions/:id/
 * env-bundle` returns `redactEnvVars`) writes it as a comma-separated list of
 * names (e.g. `ANTHROPIC_API_KEY,BRAINTRUST_API_KEY`) so every pulled secret
 * (model key + connector credentials) lands on the run-event redaction list.
 */
export { INJECTED_ENV_VARS_ENV } from './hosted-environment.js'

function redactionListFromEnv(): string[] {
  const secrets: string[] = []
  const injected = (process.env[INJECTED_ENV_VARS_ENV] ?? '')
    .split(',')
    .map(name => name.trim())
    .filter(name => name.length > 0)
  for (const key of [...MODEL_KEY_ENV_VARS, ...injected]) {
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
function hasValidPrebakedMarker(markerPath: string): boolean {
  try {
    return parsePrebakedMarker(readFileSync(markerPath, 'utf8')) !== null
  } catch {
    return false
  }
}

function detectLoopPrebaked(flag: boolean | undefined, markerPath: string): boolean {
  return flag === true || hasValidPrebakedMarker(markerPath)
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
  const diagnose = (message: string): void => {
    try { opts.onDiagnostic?.(message) } catch { /* diagnostics are best-effort */ }
  }

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
    onDiagnostic: diagnose,
  })

  // G5 startup canary (fail-closed, POSITIVE CONTROL): when the host applied an
  // enforced egress policy it sets `egressCanaryHost`; probe BOTH the denied host
  // AND a known-allowed host (the Orizu API base) BEFORE any agent work. Proceed
  // ONLY IF the allowed host is reachable and the denied host is blocked; any
  // other outcome (denied reachable → firewall not enforcing; allowed ALSO
  // unreachable → network broken / indistinguishable from a block) emits
  // `egress_allowed` and finishes the run FAILED rather than touch real customer
  // data. A canary whose own event append fails is likewise fail-closed.
  if (context.egressCanaryHost && !opts.sharedRuntime?.startupComplete) {
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
  if (context.runSetupHook && !opts.sharedRuntime?.startupComplete) {
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

  if (opts.sharedRuntime) opts.sharedRuntime.startupComplete = true

  // End-of-run auto-harvest (ALI-1036): commit + push anything the agent left
  // uncommitted/unpushed so a run NEVER loses work — on BOTH the success and
  // failure paths. Runs at most once (guarded), records exactly one outcome with
  // critical-intent delivery, and NEVER throws or changes the run's terminal
  // status. If the event cannot land, safe outcome metadata rides the already-
  // critical terminal PATCH instead.
  const prebakedMarkerPath = resolvePrebakedMarkerPath()
  let harvested = false
  let checkpointFinishPatch: BeforeFinishResult | void
  const runAutoHarvest = async (): Promise<BeforeFinishResult | void> => {
    if (harvested) return checkpointFinishPatch
    harvested = true
    let outcome: HarvestOutcome
    try {
      const markerValid = hasValidPrebakedMarker(prebakedMarkerPath)
      outcome = !opts.harvestExec && !markerValid
        ? { kind: 'work_persist_failed', error: 'prebaked_marker_invalid' }
        : harvestWorkspace({
            workspaceDir: context.workspaceDir,
            runId: context.runId,
            sessionBranch: context.sessionBranch,
            repositoryRemote: context.repositoryRemote,
            credentialHelper: context.repositoryCredentialHelper,
            author: context.author,
            exec: opts.harvestExec,
            // Real harvest requires a parsed marker from the hosted image;
            // mere path existence must never authorize default Git mutations.
            enabled: markerValid,
          })
    } catch (error) {
      outcome = { kind: 'work_persist_failed', error: error instanceof Error ? error.message : String(error) }
    }
    if (sink.sealed) return
    try {
      if (outcome.kind === 'work_persisted') {
        await sink.append({
          kind: 'work_persisted',
          payload: { sha: outcome.sha, ...(outcome.files ? { files: outcome.files } : {}) },
          critical: true,
        })
      } else if (outcome.kind === 'work_none') {
        await sink.append({ kind: 'work_none', payload: {}, critical: true })
      } else if (outcome.kind === 'work_not_inspected') {
        await sink.append({ kind: 'work_not_inspected', payload: {}, critical: true })
      } else {
        await sink.append({ kind: 'work_persist_failed', payload: { error: outcome.error }, critical: true })
      }
    } catch {
      // Value-free by construction: raw Git/provider errors and credentials must
      // not enter process diagnostics or the terminal summary.
      diagnose('hosted checkpoint event delivery failed')
      const checkpointDelivery = outcome.kind === 'work_persisted'
        ? {
            outcome: 'saved', sha: outcome.sha,
            ...(outcome.files ? { fileCount: outcome.files.length } : {}),
          }
        : outcome.kind === 'work_none'
          ? { outcome: 'no_changes' }
          : outcome.kind === 'work_not_inspected'
            ? { outcome: 'not_inspected' }
            : { outcome: 'unsaved' }
      checkpointFinishPatch = {
        summary: { checkpoint_delivery_failed: checkpointDelivery },
      }
    }
    return checkpointFinishPatch
  }

  let spawned: SpawnedOpenCode | null = opts.sharedRuntime?.spawned ?? null
  let agentSessionId: string | null = opts.sharedRuntime?.agentSessionId ?? null
  let installOk = opts.sharedRuntime?.installOk ?? false
  const harnessKind = context.harness ?? 'opencode'
  try {
    // A session runtime provisions and starts its harness exactly once. Later
    // turns reuse this object and therefore the same native conversation.
    let harness: AgentHarness
    if (opts.sharedRuntime?.harness) {
      harness = opts.sharedRuntime.harness
    } else if (harnessKind === 'claude-agent-sdk') {
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
      const prebaked = detectLoopPrebaked(context.prebaked, prebakedMarkerPath)
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
        logPath: opts.sharedRuntime?.spawnLogPath ?? join(tmpdir(), `opencode-serve-${context.runId}.log`),
        signal,
      })
      if (typeof spawned.readyAfterMs === 'number') {
        await sink.append({
          kind: 'artifact',
          payload: { step: 'opencode_ready', ok: true, waitedMs: spawned.readyAfterMs },
        })
      }

      // Fail-fast model validation (ALI-1086): ask the RUNNING opencode whether
      // the requested model is resolvable BEFORE the first prompt. The pinned
      // opencode's bundled catalog is stale (predates claude-opus-4-8) and only
      // a boot-time models.dev fetch (#1392 allowlists it) refreshes it — when
      // that fetch is blocked, the first prompt used to die inside the SSE
      // stream with an opaque `run_failed: Model not found`. Now the run fails
      // immediately with a structured artifact + an error naming the requested
      // id AND the resolvable alternatives. Fail-open on validator
      // infrastructure: an unreachable catalog endpoint (`skipped`) proceeds
      // silently — opencode's own session.error remains the backstop. Healthy
      // and skipped runs append NO event, so the ALI-929 cross-harness
      // stream-identity invariant is untouched (validation exists only on the
      // opencode path; the Claude-SDK driver resolves models itself).
      const validateModel = opts.validateModel ?? awaitOpenCodeModelResolvable
      const validation = await validateModel({ baseUrl: spawned.baseUrl, model: context.model })
      if (validation.kind === 'unresolvable') {
        await sink.append({
          kind: 'artifact',
          payload: {
            step: 'model_validation',
            ok: false,
            requestedModel: validation.requested,
            resolvableAlternatives: validation.alternatives,
            providerKnown: validation.providerKnown,
            opencodeVersion: pinnedVersion,
            waitedMs: validation.waitedMs,
          },
        })
        throw new Error(
          `requested model ${validation.requested} is not resolvable by the pinned ` +
            `opencode runtime (opencode-ai@${pinnedVersion}); resolvable alternatives: ` +
            `${validation.alternatives.join(', ') || '(none)'} — retry with --model ` +
            `set to one of these (stale bundled catalog + blocked models.dev refresh; ` +
            `see ALI-1086, durable fix ALI-929)`
        )
      }

      // Derive the per-prompt max-duration cap from the sandbox budget so a long
      // `--duration` run is not killed at the hard-coded 90-min cap while its
      // sandbox is still alive; floored at the harness default for short/undated
      // runs (ALI-1061).
      const promptMaxDurationMs = derivePromptMaxDurationMs(context.sandboxBudgetMs)
      harness = (
        opts.createHarness ??
        ((baseUrl: string, options?: { promptMaxDurationMs?: number }) =>
          createOpenCodeHarness({ baseUrl, promptMaxDurationMs: options?.promptMaxDurationMs }))
      )(spawned.baseUrl, { promptMaxDurationMs })
    }

    if (!opts.sharedRuntime?.harness) {
      const started = await harness.start({
        workspaceDir: context.workspaceDir,
        model: context.model,
        reasoningEffort: context.reasoningEffort,
        resumeAgentSessionId: context.resumeAgentSessionId,
      })
      agentSessionId = started.agentSessionId
      if (opts.sharedRuntime) {
        opts.sharedRuntime.harness = harness
        opts.sharedRuntime.spawned = spawned
        opts.sharedRuntime.agentSessionId = agentSessionId
        opts.sharedRuntime.installOk = installOk
      }
    }

    // Prompt scaffolding (ALI-1036): wrap the user task with the standing
    // headless preamble, keeping the task verbatim beneath a delimiter.
    const prompt: HarnessPrompt = {
      runId: context.runId,
      messageId: context.messageId,
      content: composeHostedTaskPrompt(taskPrompt, opts.taskPreamble ?? resolveHostedTaskPreamble(context.sessionOrigin)),
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

    // A human interrupt is prompt-scoped: signal the production driver (whose
    // abort path sends OpenCode POST /session/:id/abort) and invoke stop() as a
    // best-effort belt. This callback is deliberately total. All callers share
    // one promise so the question path can await confirmed quiescence. Once this
    // prompt yields its terminal event, a late marker belongs to the terminal/
    // harvest window and must not abort the next queued prompt.
    let hasPromptTerminal = false
    let quiescencePromise: Promise<void> | null = null
    const beginQuiescence = (): Promise<void> => {
      promptController.abort()
      if (quiescencePromise) return quiescencePromise
      try {
        quiescencePromise = Promise.resolve(harness.stop()).catch(() => {
          diagnose('hosted interrupt stop failed; prompt signal remains authoritative')
        })
      } catch {
        diagnose('hosted interrupt stop failed; prompt signal remains authoritative')
        quiescencePromise = Promise.resolve()
      }
      return quiescencePromise
    }
    const handleInterrupt = (): void => {
      if (hasPromptTerminal) return
      void beginQuiescence()
    }
    const interruptSignal = opts.interruptSignal
    if (interruptSignal?.aborted) handleInterrupt()
    else interruptSignal?.addEventListener('abort', handleInterrupt, { once: true })

    const terminalSummary: Record<string, unknown> = { agentSessionId }
    let hasQuestionOutcome = false
    const annotated = annotateHeadlessQuestions(harness.runPrompt(prompt, promptController.signal))
    const questionAware = harnessKind === 'opencode' && context.sessionOrigin === 'hosted-web'
      ? interceptHostedQuestions(annotated, {
          onDetected: question => {
            hasQuestionOutcome = true
            terminalSummary.outcome = 'question_pending'
            terminalSummary.questionId = question.questionId
          },
          onInvalid: reason => {
            hasQuestionOutcome = true
            terminalSummary.outcome = 'question_invalid'
            terminalSummary.reason = reason
          },
          // Async-generator resumption occurs only after drain appended the
          // yielded critical event. Reuse ALI-1760's single abort owner.
          onPersisted: beginQuiescence,
          onInvalidPersisted: beginQuiescence,
        })
      : annotated
    const interruptAware = (async function* (): AsyncGenerator<HarnessEvent> {
      for await (const event of questionAware) {
        if (isHarnessTerminalKind(event.kind)) {
          hasPromptTerminal = true
          if (hasQuestionOutcome || (interruptSignal?.aborted && event.kind !== 'error')) {
            yield {
              kind: 'execution_complete',
              messageId: prompt.messageId,
              critical: true,
              payload: { success: false, aborted: true },
            }
          } else {
            yield event
          }
          return
        }
        yield event
      }
      // A signal already durable before prompt startup can make a driver end
      // without yielding. It is still an intentional cancellation, not a run
      // failure or a missing-terminal fault.
      if (interruptSignal?.aborted || hasQuestionOutcome) {
        yield {
          kind: 'execution_complete',
          messageId: prompt.messageId,
          critical: true,
          payload: { success: false, aborted: true },
        }
      }
    })()
    if (idleTimeoutMs <= 0) {
      // <= 0 explicitly DISABLES the watchdog (e.g. ORIZU_AGENT_IDLE_TIMEOUT_MS=0):
      // a stalled prompt will hang until the sandbox/prompt hard cap. Record it so
      // a run that never progresses isn't a silent mystery in the timeline (ALI-1069).
      await sink.append({
        kind: 'artifact',
        payload: {
          step: 'idle_watchdog_disabled',
          detail: 'idle watchdog disabled (idle timeout <= 0); a stalled prompt will not auto-fail agent_stalled',
        },
      })
    }
    const drivenStream =
      idleTimeoutMs > 0
        ? withIdleWatchdog(interruptAware, {
            timeoutMs: idleTimeoutMs,
            onTimeout: async () => {
              promptController.abort()
              await harness.stop()
            },
            // The `question` tool is DENIED headless, so a model stuck retrying it
            // emits a stream of synthetic `question_auto_answered` events. Those are
            // NOT progress — excluding them lets a deny/retry loop trip agent_stalled
            // instead of resetting the idle timer forever (ALI-1069).
            isProgress: event => event.kind !== 'question_auto_answered',
          })
        : interruptAware
    let status: TerminalStatus
    try {
      status = await drainHarnessToSink(drivenStream, sink, {
        summary: terminalSummary,
        // Auto-harvest runs on EVERY terminal path, before the sink seals.
        beforeFinish: runAutoHarvest,
      })
    } finally {
      interruptSignal?.removeEventListener('abort', handleInterrupt)
    }
    if (!opts.sharedRuntime) await harness.shutdown()
    if (opts.sharedRuntime) opts.sharedRuntime.agentSessionId = agentSessionId
    return { status, agentSessionId, installOk, error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Harvest FIRST on every abnormal path (partial work is valuable, incl. an
    // idle-watchdog abort) — before any terminal write seals the sink.
    const checkpointPatch = await runAutoHarvest()
    const checkpointSummary = checkpointPatch?.summary ?? {}

    // ALI-1065 finding 2: an undeliverable TERMINAL transition must NEVER be
    // re-recorded as 'failed' — the run's outcome was already decided; only its
    // DELIVERY failed. Retry the delivery with the ORIGINAL status (spaced past
    // the sink's own ~350ms retry window, so a ~1s transport blip recovers),
    // and if it still cannot land, fail the DELIVERY visibly: return the
    // intended status with a non-null error, which the boot reports via its
    // boot-status callback, and the coordinator's session-end finalizer sweeps
    // the still-'running' row server-side with an explicit marker.
    if (error instanceof TerminalDeliveryError) {
      const sleep = opts.sleepImpl ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
      for (const delayMs of TERMINAL_DELIVERY_RETRY_DELAYS_MS) {
        if (sink.sealed) break
        await sleep(delayMs)
        try {
          await sink.finish(error.intendedStatus, error.finishOptions)
          return { status: error.intendedStatus, agentSessionId, installOk, error: null }
        } catch (retryError) {
          // The run went terminal server-side while we were retrying: accept
          // the server record (Orizu records win) instead of retrying further.
          if (retryError instanceof RunTerminalError) {
            return { status: 'cancelled', agentSessionId, installOk, error: null }
          }
          // Otherwise keep retrying within the bounded schedule; never change
          // the status.
        }
      }
      if (sink.sealed) {
        // A concurrent/preceding delivery landed after all — the record is
        // terminal server-side with our intended status semantics preserved.
        return { status: error.intendedStatus, agentSessionId, installOk, error: null }
      }
      return {
        status: error.intendedStatus,
        agentSessionId,
        installOk,
        error: `terminal delivery failed (intended status preserved): ${message}`,
      }
    }

    // The run went terminal SERVER-side (cancel/finish out from under this
    // writer): the sink sealed itself; accept the server record (Orizu records
    // win) instead of fabricating a local failure.
    if (error instanceof RunTerminalError) {
      return { status: 'cancelled', agentSessionId, installOk, error: null }
    }

    // Fail closed: never leave the run non-terminal. finish() is idempotent and
    // no-ops when the drain already sealed the sink.
    if (!sink.sealed) {
      try {
        await sink.finish('failed', { summary: { error: message, ...checkpointSummary } })
      } catch {
        // best-effort — the terminal write itself may be impossible (bearer gone)
      }
    }
    return { status: 'failed', agentSessionId, installOk, error: message }
  } finally {
    if (spawned && (!opts.sharedRuntime || opts.sharedRuntime.spawned !== spawned)) {
      try {
        spawned.stop()
      } catch {
        // ignore teardown failure
      }
    }
  }
}

export async function startHostedLoopSession(
  context: HostedLoopSessionContext
): Promise<HostedLoopSessionHandle> {
  return {
    context,
    runtime: {
      harness: null,
      spawned: null,
      agentSessionId: null,
      installOk: false,
      startupComplete: false,
      spawnLogPath: join(context.sessionDir, `opencode-serve-${context.sessionId}.log`),
      closed: false,
    },
  }
}

export async function runHostedLoopTurn(
  session: HostedLoopSessionHandle,
  turn: HostedLoopTurnContext,
  options: Omit<RunHostedLoopOptions, 'context' | 'taskPrompt' | 'sharedRuntime'> & { taskPrompt: string }
): Promise<HostedLoopResult> {
  if (session.runtime.closed) throw new Error('hosted loop session is closed')
  return runHostedLoop({
    ...options,
    context: {
      ...session.context,
      runId: turn.runId,
      taskFile: turn.taskFile,
      messageId: turn.messageId,
      bearerFile: turn.bearerFile,
      resumeAgentSessionId: session.runtime.agentSessionId ?? session.context.resumeAgentSessionId,
    },
    taskPrompt: options.taskPrompt,
    sharedRuntime: session.runtime,
  })
}

export async function closeHostedLoopSession(session: HostedLoopSessionHandle): Promise<void> {
  if (session.runtime.closed) return
  session.runtime.closed = true
  try {
    await session.runtime.harness?.shutdown()
  } finally {
    session.runtime.spawned?.stop()
    session.runtime.harness = null
    session.runtime.spawned = null
  }
}

// -- Thin CLI entry (`orizu internal hosted-loop --context <path>`) -----------

export interface HostedLoopCommandIo {
  print: (line: string) => void
  printErr?: (line: string) => void
  json?: boolean
}

const REQUIRED_CONTEXT_STRINGS = [
  'apiBaseUrl', 'runId', 'bearerFile', 'taskFile', 'workspaceDir',
  'sessionBranch', 'repositoryRemote', 'model', 'messageId',
] as const
const OPTIONAL_CONTEXT_STRINGS = [
  'reasoningEffort', 'opencodePinnedVersion', 'anthropicDummyKey',
  'resumeAgentSessionId', 'egressCanaryHost', 'repositoryCredentialHelper',
] as const

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function validateHostedLoopContext(value: unknown): { context: HostedLoopContext | null; fields: string[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { context: null, fields: ['root'] }
  const record = value as Record<string, unknown>
  const fields: string[] = REQUIRED_CONTEXT_STRINGS.filter(name => !isNonemptyString(record[name]))
  const branch = record.sessionBranch
  if (typeof branch === 'string' && (branch.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(branch) ||
      branch.includes('..') || branch.includes('//') || branch.endsWith('/') || branch.includes('@{'))) fields.push('sessionBranch')
  const author = record.author
  if (!author || typeof author !== 'object' || Array.isArray(author) ||
      !isNonemptyString((author as Record<string, unknown>).name) || !isNonemptyString((author as Record<string, unknown>).email)) fields.push('author')
  if (record.harness !== undefined && record.harness !== 'opencode' && record.harness !== 'claude-agent-sdk') fields.push('harness')
  if (record.sessionOrigin !== undefined && record.sessionOrigin !== 'hosted-web' && record.sessionOrigin !== 'cli') fields.push('sessionOrigin')
  if (record.sandboxBudgetMs !== undefined && (typeof record.sandboxBudgetMs !== 'number' || !Number.isFinite(record.sandboxBudgetMs) || record.sandboxBudgetMs <= 0)) fields.push('sandboxBudgetMs')
  if (record.opencodePort !== undefined && (typeof record.opencodePort !== 'number' || !Number.isInteger(record.opencodePort) || record.opencodePort <= 0 || record.opencodePort > 65_535)) fields.push('opencodePort')
  for (const name of OPTIONAL_CONTEXT_STRINGS) if (record[name] !== undefined && typeof record[name] !== 'string') fields.push(name)
  for (const name of ['prebaked', 'runSetupHook'] as const) if (record[name] !== undefined && typeof record[name] !== 'boolean') fields.push(name)
  return { context: fields.length === 0 ? value as HostedLoopContext : null, fields: [...new Set(fields)] }
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
  let rawContext: unknown
  try {
    rawContext = JSON.parse(readFileSync(contextPath, 'utf8'))
  } catch (error) {
    io.printErr?.(`unreadable loop context: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  const parsedContext = validateHostedLoopContext(rawContext)
  if (!parsedContext.context) {
    io.printErr?.(`invalid loop context: ${parsedContext.fields.join(', ')}`)
    return 1
  }
  const context = parsedContext.context
  // Read the bearer per request (via the provider) so a host-side rotation that
  // overwrites the 0600 file is picked up without restarting the loop.
  const bearerProvider = (): string => readFileSync(context.bearerFile, 'utf8').trim()
  const taskPrompt = readFileSync(context.taskFile, 'utf8')
  const result = await runHostedLoop({ context, bearerProvider, taskPrompt, onDiagnostic: io.printErr })
  io.print(
    io.json
      ? JSON.stringify({ status: result.status, agentSessionId: result.agentSessionId, error: result.error })
      : `hosted-loop finished: ${result.status}${result.error ? ` (${result.error})` : ''}`
  )
  return result.error ? 1 : 0
}
