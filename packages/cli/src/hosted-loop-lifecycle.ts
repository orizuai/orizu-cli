/**
 * Hosted-loop LIFECYCLE seam (ALI-1015 Phase 1, per ADR-005 Resolution).
 *
 * The orchestration-facing parts of the hosted loop, extracted VERBATIM from
 * `hosted-loop.ts` so they can be re-exported through the shared
 * `lib/hosted-runtime/` surface and driven by a server-side coordinator (the
 * per-session Durable Object) as well as the CLI. This module deliberately
 * carries NO harness/runtime machinery: its only import is the TYPE-ONLY
 * `HarnessEvent` (erased at compile time), so a Worker bundle that pulls the
 * lifecycle seam never drags in the OpenCode/Claude-SDK drivers or any Node
 * child-process code.
 *
 * Contents (moved, not rewritten — behavior identical):
 *   - `HostedLoopContext` — the run-scoped boot context the host orchestrator
 *     writes for the in-sandbox loop;
 *   - `buildOpenCodeSpawnEnv` — the pre-authenticated agent env (ALI-1044);
 *   - the G5 egress canary: `runEgressCanary`, `egressCanaryAllowedHost`,
 *     `defaultProbeEgress`, and their types/constants;
 *   - `SetupHookOutcome` — the deferred customer-setup-hook contract.
 *
 * `hosted-loop.ts` re-exports everything here, so the CLI's import surface
 * (`@/packages/cli/src/hosted-loop`) is unchanged.
 */

import type { HarnessEvent } from './hosted-harness.js'

/**
 * Default provider-qualified hosted model — the SINGLE source of truth
 * (ALI-1086). Imported by both the operator-path session CLI
 * (`hosted-session-cli.ts`) and the DO-path boot (`hosted-boot.ts`); never
 * re-inline it.
 *
 * PIN CONSTRAINT: the hosted OpenCode runtime is HARD-PINNED to
 * `opencode-ai@1.14.41` (`OPENCODE_PINNED_VERSION`, SSE-fragile — do not bump)
 * whose BUNDLED model catalog predates this model (newest bundled anthropic
 * opus: claude-opus-4-7). Verified empirically on ALI-1086: 1.14.41 DOES fetch
 * `https://models.dev/api.json` at boot when reachable (cached to
 * `~/.cache/opencode/models.json`, refreshed when stale, disabled only by
 * `OPENCODE_DISABLE_MODELS_FETCH`), so with models.dev on the sandbox egress
 * allowlist (#1392, `ORIZU_HOSTED_EGRESS_ALLOWLIST`) this id resolves in new
 * sandboxes. If the catalog fetch is blocked/stale anyway, the loop's
 * pre-prompt validation (`awaitOpenCodeModelResolvable`) fails the run fast,
 * naming the resolvable alternatives. The durable fix for the stale bundled
 * catalog is the ALI-929 harness swap.
 */
export const DEFAULT_HOSTED_MODEL = 'anthropic/claude-opus-4-8'

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
  /**
   * Total sandbox lifetime budget in ms (derived from the session `--duration`).
   * The loop derives the per-prompt max-duration cap from this (budget minus a
   * harvest margin, floored at the harness default) so a long `--duration` run is
   * NOT killed at the hard-coded 90-min prompt cap while its sandbox still lives
   * (ALI-1061). Unset for undated runs → the harness default (5400s) floor holds.
   */
  sandboxBudgetMs?: number
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
export async function defaultProbeEgress(host: string): Promise<EgressProbeResult> {
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
