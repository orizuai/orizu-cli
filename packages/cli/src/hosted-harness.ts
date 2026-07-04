/**
 * AgentHarness seam (ALI-926 / P3.4, interface 1 of ADR-005's swappability
 * contract; sketch in audit §4a).
 *
 * `AgentHarness` abstracts "what starts and steps the agent" so the OpenCode
 * driver (`hosted-harness-opencode.ts`) can be swapped for a Claude-Agent-SDK
 * loop (ALI-929) WITHOUT touching the event bridge (`hosted-run-event-sink.ts`)
 * or the RunAPI. The interface therefore carries ZERO OpenCode types: it speaks
 * only in normalized `HarnessEvent`s whose `kind` is the audit §4b left column.
 *
 * Shape ported (in DESIGN, not code) from OpenInspect's `bridge.py`:
 *   create session → send prompt → stream parts → detect idle → stop.
 * The OpenCode-specific SSE part schema, message-id correlation, and localhost
 * HTTP driving live entirely behind this seam.
 *
 * Terminal semantics: `execution_complete` and `error` are emitted as ordinary
 * stream events with `critical: true`. The bridge (§4b) routes those to the
 * RunAPI terminal PATCH — they are NEVER appended as raw run events. The harness
 * does not know about run status; "Orizu records win" (the disagreement rule) is
 * enforced by the sink, not here.
 */

/** Minimal MCP server descriptor. Kept structural so the seam does not depend on
 *  any concrete MCP client type; the driver interprets it. */
export interface McpServerConfig {
  name: string
  /** Transport hint the driver understands (e.g. 'stdio' | 'http'). */
  transport?: string
  command?: string
  args?: readonly string[]
  url?: string
  env?: Record<string, string>
}

export interface HarnessStartOptions {
  /** Absolute or repo-relative working directory the agent operates in. */
  workspaceDir: string
  /** Provider-qualified model, e.g. "anthropic/claude-opus-4-8". */
  model: string
  reasoningEffort?: string
  mcpServers?: readonly McpServerConfig[]
  /** OpenCode session id persisted across restarts (reconnect/resume). */
  resumeAgentSessionId?: string
}

export interface HarnessPrompt {
  runId: string
  /** Idempotency / correlation key handed by the caller. */
  messageId: string
  content: string
  /** Git identity used for commit attribution during the prompt. */
  author: { name: string; email: string }
}

/**
 * The normalized event vocabulary — the audit §4b left column. The bridge maps
 * each kind onto a `workbench_run_events.event_type` (or drops it). Kept as a
 * const map (no enums, per project guidelines).
 *
 * `push_complete` / `push_error` are deliberately OMITTED: they belong to the
 * finish-branch / manifest push flow deferred to P3.5. `heartbeat` and
 * `user_message` are not modeled at all — the harness never emits liveness or
 * prompt-echo events (§4b drops both).
 */
export const HARNESS_EVENT_KINDS = {
  ready: 'ready',
  token: 'token',
  tool_call: 'tool_call',
  tool_result: 'tool_result',
  step_start: 'step_start',
  step_finish: 'step_finish',
  git_sync: 'git_sync',
  artifact: 'artifact',
  session_title: 'session_title',
  // Egress-canary results (G5 / ALI-1006). NOT produced by a harness — the
  // in-sandbox loop emits these through the SAME single-writer run-event sink
  // right after bootstrap (the startup canary that proves the firewall is live).
  // They are part of the §4b run-event vocabulary (G6 lists "egress attempt")
  // and never terminal, so they append like any structural event.
  egress_blocked: 'egress_blocked',
  egress_allowed: 'egress_allowed',
  error: 'error',
  execution_complete: 'execution_complete',
} as const

export type HarnessEventKind = keyof typeof HARNESS_EVENT_KINDS

/** The two kinds that must NEVER be appended as raw events — they drive the
 *  terminal PATCH instead (§4b mapping rule). */
export const HARNESS_TERMINAL_KINDS = {
  execution_complete: 'execution_complete',
  error: 'error',
} as const

export function isHarnessTerminalKind(kind: HarnessEventKind): boolean {
  return kind in HARNESS_TERMINAL_KINDS
}

export interface HarnessEvent {
  kind: HarnessEventKind
  /** Correlation key for coalescing (token snapshots) and attribution. */
  messageId?: string
  payload: Record<string, unknown>
  /** Requires guaranteed delivery (execution_complete / error / push_*). */
  critical?: boolean
}

export interface AgentHarness {
  /** Stable driver name — "opencode" | "claude-agent-sdk". */
  readonly name: string
  /** Boot the agent process/session; returns the resumable agent session id. */
  start(opts: HarnessStartOptions): Promise<{ agentSessionId: string }>
  /**
   * Drive one prompt to completion, yielding normalized events. Cancellable via
   * `signal` (abort → the driver requests the agent to stop and ends the stream
   * with a terminal event). The stream ALWAYS ends with exactly one terminal
   * event (`execution_complete` or `error`).
   */
  runPrompt(prompt: HarnessPrompt, signal: AbortSignal): AsyncIterable<HarnessEvent>
  /** Abort the in-flight prompt (e.g. OpenCode POST /session/{id}/abort). */
  stop(): Promise<void>
  /** Release all resources; the harness is unusable afterward. */
  shutdown(): Promise<void>
}
