/**
 * Host-driven hosted-sandbox bootstrap (ALI-925 / P3.3, per ADR-005 §8).
 *
 * Given a live `SandboxSession` (from the Orizu `SandboxProvider` seam — works
 * with BOTH the Daytona adapter and local-sim), an Orizu API base URL, a bearer,
 * and the workspace/session/run ids + session branch, `bootstrapHostedSandbox`
 * performs the in-sandbox boot flow forked in DESIGN from OpenInspect's
 * `entrypoint.py` supervisor:
 *
 *   1. inject boot context (env/config) as run-scoped files — the bearer only in
 *      a 0600 file reaped at teardown, never in git config or the clone URL (G3);
 *   2. install the git credential helper (self-contained script asset) and scope
 *      it to the repo dir ONLY (never --global);
 *   3. clone the session branch via the helper (no token in URL / .git/config);
 *   4. install the Orizu CLI (non-fatal, recorded);
 *   5. run the customer `.orizu/setup.sh` hook if present (fresh-boot, non-fatal);
 *   6. record lifecycle events to the RunAPI with client-assigned sequences
 *      (generic event types only — never the reserved run_* lifecycle types);
 *   7. on failure, record `bootstrap_failed`, tear down, and sweep for residue.
 *
 * P3.4/P3.5 (OpenCode driver, event bridge, `orizu session start --hosted`)
 * build ON TOP of this — `bootstrapHostedSandbox` is the single writer for the
 * run at this stage and returns the run cursor so a follow-on can continue it.
 */

import type { SandboxSession } from './sandbox-provider.js'
import { sweepForTokenResidue, type HygieneFinding } from './daytona-slice.js'
import { redactSecrets } from './secret-redaction.js'
import {
  BEARER_BASENAME,
  BOOT_CONTEXT_BASENAME,
  DEFAULT_CACHE_REFRESH_BUFFER_MS,
  HELPER_SCRIPT_BASENAME,
  PREBAKED_MARKER_PATH,
  REPO_CRED_CACHE_BASENAME,
  SETUP_HOOK_RELATIVE_PATH,
  parsePrebakedMarker,
  renderCredentialHelperScript,
  serializeBootContext,
  type HostedBootContext,
} from './hosted-runtime-assets.js'

export type HostedFetch = (url: string, init?: RequestInit) => Promise<Response>

// -- Run-event sink (client-sequenced, redacted) -----------------------------

export interface AppendedRunEvent {
  eventId: string
  sequence: number
  eventType: string
  /** Already redacted — safe to inspect / serialize in tests. */
  payload: Record<string, unknown>
}

/**
 * The bootstrap orchestrator is the single writer for the run at this stage, so
 * it owns a local monotonic sequence (per §4b). Every payload is redacted with
 * the bearer before it leaves the process — a run-event body must never carry
 * the bearer or a minted token. Lifecycle run_* types are rejected server-side;
 * the orchestrator only emits generic types.
 */
export interface BootstrapRunEventSink {
  append(eventType: string, payload?: Record<string, unknown>): Promise<AppendedRunEvent>
  readonly recorded: readonly AppendedRunEvent[]
}

export interface CreateRunEventSinkOptions {
  apiBaseUrl: string
  runId: string
  bearer: string
  fetchImpl?: HostedFetch
  /** Extra verbatim secrets to redact from payloads (e.g. minted tokens). */
  redactSecretsList?: readonly string[]
  now?: () => number
  /** Sequence to start at (defaults to 1). */
  startSequence?: number
}

function newEventId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID()
  return `evt-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function createBootstrapRunEventSink(options: CreateRunEventSinkOptions): BootstrapRunEventSink {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as HostedFetch)
  const now = options.now ?? (() => Date.now())
  const base = options.apiBaseUrl.replace(/\/$/, '')
  const secretList = [options.bearer, ...(options.redactSecretsList ?? [])]
  const recorded: AppendedRunEvent[] = []
  let sequence = options.startSequence ?? 1

  return {
    recorded,
    async append(eventType, payload = {}) {
      const redactedPayload = redactSecrets(payload, { secrets: secretList })
      const event: AppendedRunEvent = {
        eventId: newEventId(),
        sequence: sequence,
        eventType,
        payload: redactedPayload,
      }
      const response = await fetchImpl(
        `${base}/api/cli/workbench-runs/${encodeURIComponent(options.runId)}/events`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.bearer}` },
          body: JSON.stringify({
            eventId: event.eventId,
            sequence: event.sequence,
            eventType: event.eventType,
            occurredAt: new Date(now()).toISOString(),
            payload: redactedPayload,
          }),
        }
      )
      if (!response.ok) {
        // Best-effort: the event log must not sink the whole boot. Surface the
        // status but never the body (could echo internals); never a token. The
        // sequence number is NOT consumed on failure (P3d) — a failed POST must
        // not leave a server-visible gap in the run's sequence.
        throw new Error(`run-event append failed (${response.status}) for ${eventType}`)
      }
      sequence += 1
      recorded.push(event)
      return event
    },
  }
}

// -- Bootstrap orchestration -------------------------------------------------

export interface HostedBootstrapOptions {
  session: SandboxSession
  apiBaseUrl: string
  /** Opaque bearer — a PAT in rehearsal, a G2 session token in production. */
  bearer: string
  workspaceId: string
  sessionId: string
  runId: string
  sessionBranch: string
  repoFullName: string
  /** Map the broker repo full-name → a clone URL the provider understands.
   *  Live: `https://github.com/<repo>.git`. Local-sim: the bare repo path. */
  resolveCloneUrl: (repo: string) => string
  /** Directory (relative to the sandbox root) the session branch clones into. */
  workspaceDir?: string
  /** VCS host the credential helper serves (default github.com). */
  host?: string
  /**
   * Broker purpose vocabulary the helper mints with. When omitted, the default
   * is chosen from `bearerKind` (below): a human bearer mints `write`/`read`, an
   * agent bearer mints `session_write`/`session_read`. Injectable so a caller can
   * override without editing the credential-helper script.
   */
  tokenPurposes?: { primary: string; fallback: string }
  /**
   * Kind of bearer in the 0600 file — the orchestrator KNOWS what it minted, so
   * the default broker purposes are chosen from this EXPLICIT signal, never by
   * sniffing the token. 'agent' → session_write/session_read; 'human' (default)
   * → write/read. Ignored when `tokenPurposes` is passed explicitly.
   */
  bearerKind?: 'agent' | 'human'
  /**
   * Hosts the credential helper may serve over plain HTTP (loopback rehearsal
   * only). Production omits this → the helper stays https-only.
   */
  insecureHttpHosts?: readonly string[]
  /** Helper cache refresh buffer (ms) — overridable so tests can force refresh. */
  cacheBufferMs?: number
  /**
   * Defer the customer `.orizu/setup.sh` hook to the in-sandbox loop (P3-a). When
   * true, bootstrap does NOT run the hook; it records `setup_hook_deferred` and
   * the loop runs it AFTER its egress canary passes. The host sets this for
   * enforced-egress providers so the hook's network access cannot precede the
   * canary's detection of a silent firewall failure. Default false (run inline).
   */
  deferSetupHook?: boolean
  /** Published CLI version to install in-sandbox (default 'latest'). */
  cliVersion?: string
  /** Override the CLI-install shell command (tests inject a deterministic one). */
  cliInstallCommand?: string
  /**
   * Pre-baked runtime (ALI-1017): the image already ships the Orizu CLI on PATH,
   * so the CLI-install step is SKIPPED (it would fail under G5 default-deny egress
   * anyway) and a `cli_prebaked` event is recorded instead of `cli_installed`.
   * The host sets this together with the sandbox `image` so the two never
   * disagree. When unset, bootstrap ALSO belt-checks the `/opt/orizu/prebaked.json`
   * marker on the sandbox filesystem; either signal skips the install.
   */
  prebaked?: boolean
  /** Inject a RunAPI sink (tests/production); default builds one over apiBaseUrl. */
  sink?: BootstrapRunEventSink
  fetchImpl?: HostedFetch
  now?: () => number
}

export interface HostedBootstrapStep {
  key: string
  ok: boolean
  detail: string
}

export interface HostedBootstrapResult {
  ok: boolean
  steps: HostedBootstrapStep[]
  events: readonly AppendedRunEvent[]
  paths: HostedRuntimePaths
  /** Set on the failure path: the residue sweep result after teardown. */
  sweep: { clean: boolean; findings: HygieneFinding[] } | null
  failure: { step: string; error: string } | null
}

export interface HostedRuntimePaths {
  root: string
  runDirRel: string
  runDirAbs: string
  repoDirRel: string
  helperScriptAbs: string
  bootContextAbs: string
  bearerFileAbs: string
  cacheFileAbs: string
}

const DEFAULT_WORKSPACE_DIR = 'repo'
const DEFAULT_TOKEN_PURPOSES = { primary: 'write', fallback: 'read' } as const
const DEFAULT_AGENT_TOKEN_PURPOSES = { primary: 'session_write', fallback: 'session_read' } as const
const DEFAULT_CLI_INSTALL = (version: string): string =>
  `bun add -g orizu@${version} >/dev/null 2>&1 || npm install -g orizu@${version} >/dev/null 2>&1`

// Values we interpolate into shell commands must contain nothing a shell could
// treat specially. Allow the characters legitimately used by branch names, run
// ids, paths, and clone URLs — reject everything else rather than trust it.
const SAFE_SHELL_VALUE = /^[A-Za-z0-9._/:@-]+$/
function assertSafeShellValue(name: string, value: string): void {
  if (!SAFE_SHELL_VALUE.test(value)) {
    throw new Error(`unsafe characters in ${name} — refusing to interpolate into a shell command`)
  }
}

/** Single-quote a value for safe embedding inside a shell command. */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Resolve the sandbox absolute root so helper paths are cwd-independent. */
async function resolveRoot(session: SandboxSession): Promise<string> {
  const res = await session.exec('pwd')
  const root = res.stdout.trim()
  if (!root) throw new Error('could not resolve sandbox root (pwd returned empty)')
  return root
}

/**
 * The credential helper runs under a JS runtime (node >=18 for global fetch, or
 * bun). If NEITHER is on PATH, the whole credential path is dead — abort before
 * the clone with a message that names the missing runtime.
 */
async function assertJsRuntimeAvailable(session: SandboxSession): Promise<void> {
  const res = await session.exec(
    'if command -v node >/dev/null 2>&1 || command -v bun >/dev/null 2>&1; then echo ok; else echo missing; fi'
  )
  if (res.stdout.trim() !== 'ok') {
    throw new Error('no JS runtime on PATH: the git credential helper requires node (>=18) or bun, neither found')
  }
}

/**
 * Decide whether the sandbox is running the PRE-BAKED runtime image (ALI-1017).
 * Prefers the explicit boot-context flag (the host KNOWS what image it passed —
 * testable, no filesystem dependency); falls back to a belt read of the
 * `/opt/orizu/prebaked.json` marker (validated via `parsePrebakedMarker`, so a
 * stray same-named file cannot trigger a skip). Either signal → pre-baked.
 */
async function detectPrebaked(session: SandboxSession, flag: boolean | undefined): Promise<boolean> {
  if (flag) return true
  try {
    const raw = await session.readFile(PREBAKED_MARKER_PATH)
    return parsePrebakedMarker(raw) !== null
  } catch {
    return false
  }
}

/** Detect a JS runtime on the sandbox PATH for the credential helper. */
async function resolveHelperRuntime(session: SandboxSession): Promise<string> {
  const res = await session.exec(
    'if command -v node >/dev/null 2>&1; then echo node; elif command -v bun >/dev/null 2>&1; then echo bun; else echo node; fi'
  )
  const runtime = res.stdout.trim()
  return runtime === 'bun' ? 'bun' : 'node'
}

function credentialHelperValue(runtime: string, scriptAbs: string, contextAbs: string): string {
  // `!` makes git run the value as a shell command with the action appended.
  // Only PATHS live here — never the bearer (G3).
  return `!${runtime} ${scriptAbs} ${contextAbs}`
}

export function computeRuntimePaths(root: string, runId: string, workspaceDir: string): HostedRuntimePaths {
  const runDirRel = `.orizu-run/${runId}`
  const runDirAbs = `${root}/${runDirRel}`
  return {
    root,
    runDirRel,
    runDirAbs,
    repoDirRel: workspaceDir,
    helperScriptAbs: `${runDirAbs}/${HELPER_SCRIPT_BASENAME}`,
    bootContextAbs: `${runDirAbs}/${BOOT_CONTEXT_BASENAME}`,
    bearerFileAbs: `${runDirAbs}/${BEARER_BASENAME}`,
    cacheFileAbs: `${runDirAbs}/${REPO_CRED_CACHE_BASENAME}`,
  }
}

export async function bootstrapHostedSandbox(opts: HostedBootstrapOptions): Promise<HostedBootstrapResult> {
  const { session } = opts
  const workspaceDir = opts.workspaceDir ?? DEFAULT_WORKSPACE_DIR
  const host = opts.host ?? 'github.com'
  const tokenPurposes =
    opts.tokenPurposes ??
    (opts.bearerKind === 'agent' ? { ...DEFAULT_AGENT_TOKEN_PURPOSES } : { ...DEFAULT_TOKEN_PURPOSES })
  const cloneUrl = opts.resolveCloneUrl(opts.repoFullName)
  const runDirRel = `.orizu-run/${opts.runId}`

  // P3a — refuse shell metacharacters in any value interpolated into a command,
  // BEFORE we touch the sandbox (so a tainted value never reaches a shell).
  assertSafeShellValue('runId', opts.runId)
  assertSafeShellValue('runDirRel', runDirRel)
  assertSafeShellValue('sessionBranch', opts.sessionBranch)
  assertSafeShellValue('workspaceDir', workspaceDir)
  assertSafeShellValue('cloneUrl', cloneUrl)

  const sink =
    opts.sink ??
    createBootstrapRunEventSink({
      apiBaseUrl: opts.apiBaseUrl,
      runId: opts.runId,
      bearer: opts.bearer,
      fetchImpl: opts.fetchImpl,
      now: opts.now,
    })

  const steps: HostedBootstrapStep[] = []
  const record = (key: string, ok: boolean, detail: string): void => {
    steps.push({ key, ok, detail })
  }

  const root = await resolveRoot(session)
  const paths = computeRuntimePaths(root, opts.runId, workspaceDir)
  const runtime = await resolveHelperRuntime(session)
  const helperValue = credentialHelperValue(runtime, paths.helperScriptAbs, paths.bootContextAbs)

  let currentStep = 'sandbox_provisioned'
  try {
    // 0 — Preflight: the credential helper needs a JS runtime; abort before the
    // clone (with a recorded bootstrap_failed) if neither node nor bun is present.
    currentStep = 'runtime_preflight'
    await assertJsRuntimeAvailable(session)

    // Pre-baked detection (ALI-1017): the boot-context flag (preferred) or the
    // filesystem marker. Decided ONCE here; step 4 uses it to skip the CLI install.
    const prebaked = await detectPrebaked(session, opts.prebaked)

    // 1 — Inject boot context. Run dir is 0700; bearer + context are 0600.
    currentStep = 'inject_context'
    await session.exec(`mkdir -p ${paths.runDirRel} && chmod 700 ${paths.runDirRel}`)
    const bootContext: HostedBootContext = {
      apiBaseUrl: opts.apiBaseUrl.replace(/\/$/, ''),
      workspaceId: opts.workspaceId,
      sessionId: opts.sessionId,
      runId: opts.runId,
      sessionBranch: opts.sessionBranch,
      repoFullName: opts.repoFullName,
      host,
      bearerFile: paths.bearerFileAbs,
      cacheFile: paths.cacheFileAbs,
      tokenPurposes,
      insecureHttpHosts: opts.insecureHttpHosts,
      cacheBufferMs: opts.cacheBufferMs ?? DEFAULT_CACHE_REFRESH_BUFFER_MS,
    }
    await session.writeFile(`${paths.runDirRel}/${HELPER_SCRIPT_BASENAME}`, renderCredentialHelperScript())
    await session.writeFile(`${paths.runDirRel}/${BOOT_CONTEXT_BASENAME}`, serializeBootContext(bootContext))
    // P3b — the bearer is the one true secret on disk. Create it ATOMICALLY at
    // 0600 (umask 077 + redirect) so it never exists world-readable, even for an
    // instant — the SandboxSession.writeFile seam cannot express file perms.
    await session.exec(
      `umask 077 && printf '%s\\n' ${shellSingleQuote(opts.bearer)} > ${paths.runDirRel}/${BEARER_BASENAME}`
    )
    // The boot context holds only paths (no secret), but keep it 0600 too.
    await session.exec(`chmod 600 ${paths.runDirRel}/${BOOT_CONTEXT_BASENAME}`)
    await sink.append('sandbox_provisioned', {
      sandboxId: session.id,
      runtime,
      sessionBranch: opts.sessionBranch,
      repo: opts.repoFullName,
    })

    // 2/3 — Clone the session branch VIA the credential helper. The helper is
    // supplied ephemerally with `-c` (persisted nowhere); no token in the URL.
    currentStep = 'repo_cloned'
    const cloneCommand =
      `git clone --depth 1 --branch ${opts.sessionBranch} ` +
      `-c credential.helper=${shellSingleQuote(helperValue)} -c credential.useHttpPath=true ` +
      `${cloneUrl} ${workspaceDir}`
    const clone = await session.exec(cloneCommand)
    if (clone.exitCode !== 0) {
      const detail = (clone.stderr && clone.stderr.trim()) || clone.stdout.trim() || `exit ${clone.exitCode}`
      throw new Error(`git clone failed: ${detail}`)
    }
    // Persist the helper repo-LOCAL (never --global) for subsequent fetch/push.
    await session.exec(`git -C ${workspaceDir} config credential.helper ${shellSingleQuote(helperValue)}`)
    await session.exec(`git -C ${workspaceDir} config credential.useHttpPath true`)
    record('repo_cloned', true, `cloned ${opts.sessionBranch}`)
    await sink.append('repo_cloned', { branch: opts.sessionBranch, workspaceDir })

    // 4 — Provision the Orizu CLI (non-fatal, recorded — OpenInspect setup.sh
    // discipline). PRE-BAKED (ALI-1017): the image already ships `orizu` on PATH,
    // so SKIP the install (npm is blocked under G5 default-deny egress) and record
    // `cli_prebaked` instead. FROM-SCRATCH (local-sim / fallback): install the
    // published `orizu` npm package as before. assertJsRuntimeAvailable already
    // ran in the preflight above, so the pre-baked node/bun is proven present.
    currentStep = 'cli_installed'
    if (prebaked) {
      record('cli_prebaked', true, 'orizu CLI pre-baked in the runtime image')
      await sink.append('cli_prebaked', { detail: 'orizu CLI pre-baked in the runtime image' })
    } else {
      const installCommand = opts.cliInstallCommand ?? DEFAULT_CLI_INSTALL(opts.cliVersion ?? 'latest')
      const install = await session.exec(installCommand, { cwd: workspaceDir })
      const installOk = install.exitCode === 0
      record('cli_installed', installOk, installOk ? 'orizu CLI installed' : `install exit ${install.exitCode}`)
      await sink.append('cli_installed', {
        ok: installOk,
        exitCode: install.exitCode,
        outputTail: tail(install.stdout, install.stderr),
      })
    }

    // 5 — Customer setup hook (fresh-boot only, non-fatal, output captured).
    // P3-a: for enforced-egress providers the host DEFERS this hook to the loop,
    // which runs it AFTER the egress canary proves the firewall is live — so the
    // hook's network access can never precede detection of a silent firewall
    // failure. Here we only record the deferral (the loop emits the real result).
    currentStep = 'setup_hook'
    if (opts.deferSetupHook) {
      record('setup_hook_deferred', true, 'deferred to loop (runs after egress canary)')
      await sink.append('setup_hook_deferred', { reason: 'egress canary must pass before customer setup.sh runs' })
      return { ok: true, steps, events: sink.recorded, paths, sweep: null, failure: null }
    }
    const hookRel = `${workspaceDir}/${SETUP_HOOK_RELATIVE_PATH}`
    if (await session.fileExists(hookRel)) {
      const hook = await session.exec(`bash ${SETUP_HOOK_RELATIVE_PATH}`, { cwd: workspaceDir })
      const hookOk = hook.exitCode === 0
      record('setup_hook_completed', hookOk, hookOk ? 'setup.sh ok' : `setup.sh exit ${hook.exitCode}`)
      await sink.append('setup_hook_completed', {
        ok: hookOk,
        exitCode: hook.exitCode,
        outputTail: tail(hook.stdout, hook.stderr),
      })
    } else {
      record('setup_hook_skipped', true, 'no .orizu/setup.sh')
      await sink.append('setup_hook_skipped', { reason: 'no .orizu/setup.sh' })
    }

    return { ok: true, steps, events: sink.recorded, paths, sweep: null, failure: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    record(currentStep, false, message)
    // Record the failure (redacted), then tear down + prove no residue remains.
    await safeAppend(sink, 'bootstrap_failed', { step: currentStep, error: message })
    const sweep = await teardownHostedSandbox({ session, paths, bearer: opts.bearer, workspaceDir })
    return { ok: false, steps, events: sink.recorded, paths, sweep, failure: { step: currentStep, error: message } }
  }
}

/** Never let a failure-path event append mask the original error. */
async function safeAppend(
  sink: BootstrapRunEventSink,
  eventType: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await sink.append(eventType, payload)
  } catch {
    // The run-event log is best-effort on the failure path; teardown proceeds.
  }
}

function tail(stdout: string, stderr?: string): string {
  const combined = [stdout, stderr ?? ''].join('\n')
  return combined.split('\n').slice(-20).join('\n').trim()
}

// -- Teardown + residue sweep (G3) -------------------------------------------

export interface TeardownOptions {
  session: SandboxSession
  paths: HostedRuntimePaths
  bearer: string
  workspaceDir?: string
  /** Extra token values to sweep for (e.g. a minted repo token a test planted). */
  extraTokens?: readonly string[]
}

/**
 * Tear the run-scoped credential material down and PROVE no token residue
 * remains (G3, extends ALI-973's `sweepForTokenResidue`). Removes the run dir
 * (bearer + boot context + minted-token cache), unsets the repo-local credential
 * helper, then sweeps .git/config, the git credential cache, env, argv, and
 * ~/.git-credentials for the bearer, any extra tokens, and the token markers.
 */
export async function teardownHostedSandbox(
  opts: TeardownOptions
): Promise<{ clean: boolean; findings: HygieneFinding[] }> {
  const { session, paths } = opts
  const workspaceDir = opts.workspaceDir ?? paths.repoDirRel
  // Unset the repo-local helper (no secret in it, but leave nothing behind),
  // then remove the whole run dir (bearer, boot context, minted-token cache).
  await session.exec(`git -C ${workspaceDir} config --unset-all credential.helper 2>/dev/null || true`)
  await session.exec(`rm -rf ${paths.runDirRel}`)

  const findings = await sweepHostedResidue(session, {
    bearer: opts.bearer,
    paths,
    workspaceDir,
    extraTokens: opts.extraTokens,
  })
  return { clean: findings.length === 0, findings }
}

export interface HostedSweepOptions {
  bearer: string
  paths: HostedRuntimePaths
  workspaceDir: string
  extraTokens?: readonly string[]
}

/**
 * Extend the ALI-973 sweep with hosted-specific probes: the run dir (bearer +
 * cache) must be gone, and the standard leak surfaces (.git/config, ~/.git-
 * credentials, credential cache, env, argv) must be free of the bearer.
 */
export async function sweepHostedResidue(
  session: SandboxSession,
  opts: HostedSweepOptions
): Promise<HygieneFinding[]> {
  const tokens = [opts.bearer, ...(opts.extraTokens ?? [])].filter(t => t.length > 0)
  const probes = [
    { location: `${opts.workspaceDir}/.git/config`, command: `cat ${opts.workspaceDir}/.git/config 2>/dev/null || true` },
    {
      location: `${opts.workspaceDir}/.git/logs (reflog)`,
      command: `find ${opts.workspaceDir}/.git/logs -type f -exec cat {} + 2>/dev/null || true`,
    },
    { location: 'run dir (bearer + minted-token cache)', command: `find ${opts.paths.runDirRel} -type f -exec cat {} + 2>/dev/null || true` },
    { location: '~/.git-credentials', command: 'cat "$HOME/.git-credentials" 2>/dev/null || true' },
    { location: '~/.gitconfig (global)', command: 'cat "$HOME/.gitconfig" 2>/dev/null || true' },
    {
      location: 'git credential cache/store',
      command:
        'cat "$HOME/.cache/git/credential/"* "${XDG_CACHE_HOME:-$HOME/.cache}/git/credential/"* 2>/dev/null || true',
    },
    { location: 'shell history', command: 'cat "$HOME/.bash_history" "$HOME/.zsh_history" 2>/dev/null || true' },
    { location: 'process listing / argv', command: 'ps -eo args 2>/dev/null || ps aux 2>/dev/null || true' },
    { location: 'process env', command: 'env' },
  ]
  return sweepForTokenResidue(session, {
    tokens,
    repoPath: opts.workspaceDir,
    markers: ['x-access-token'],
    probes,
  })
}
