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
import { readFileSync } from 'fs'

import type { AgentHarness, HarnessPrompt } from './hosted-harness.js'
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
   * Non-secret placeholder key OpenCode is given so it FORMS model requests; the
   * sandbox firewall's request transform overrides the real auth header at the
   * proxy (model-key brokering, G3). Never a real key.
   */
  anthropicDummyKey?: string
  /** OpenCode session id to resume on reconnect. */
  resumeAgentSessionId?: string
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
  spawnOpenCode?: (opts: SpawnOpenCodeOptions) => SpawnedOpenCode
  installOpenCode?: () => Promise<InstallResult>
  now?: () => number
  signal?: AbortSignal
  /** Extra verbatim secrets to redact (the bearer is added by the sink itself). */
  redactSecretsList?: readonly string[]
}

export interface HostedLoopResult {
  status: TerminalStatus
  agentSessionId: string | null
  installOk: boolean
  error: string | null
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
 *  runtime-agnostic spawner). */
function nodeChildSpawner(
  cmd: string[],
  opts: { cwd?: string; env: Record<string, string> }
): { kill: () => void } {
  const child = nodeSpawn(cmd[0], cmd.slice(1), {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: 'ignore',
  })
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
      const install = opts.installOpenCode
        ? await opts.installOpenCode()
        : installOpenCodePinned(pinnedVersion)
      installOk = install.ok
      await sink.append({
        kind: 'artifact',
        payload: { step: 'opencode_install', ok: install.ok, detail: install.detail },
      })

      const spawnImpl = opts.spawnOpenCode ?? spawnOpenCode
      spawned = spawnImpl({
        model: context.model,
        cwd: context.workspaceDir,
        port: context.opencodePort,
        env: context.anthropicDummyKey ? { ANTHROPIC_API_KEY: context.anthropicDummyKey } : undefined,
        spawn: nodeChildSpawner,
      })

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

    const prompt: HarnessPrompt = {
      runId: context.runId,
      messageId: context.messageId,
      content: taskPrompt,
      author: context.author,
    }
    const status = await drainHarnessToSink(harness.runPrompt(prompt, signal), sink, {
      summary: { agentSessionId },
    })
    await harness.shutdown()
    return { status, agentSessionId, installOk, error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Fail closed: never leave the run non-terminal. finish() is idempotent and
    // no-ops when the drain already sealed the sink.
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
