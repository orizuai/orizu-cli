/**
 * reconstructSessionTimeline — the G6 audit-replay proof (ALI-1007).
 *
 * Acceptance ("replaying run events reconstructs the session"): given ONLY the
 * server-side, append-only workbench run events (each `{ sequence, eventType }`,
 * fetched from the events cursor — nothing client-held), rebuild the ordered
 * session timeline and assert its COMPLETENESS as a behavioral proof:
 *   - every lifecycle PHASE is represented (bootstrap → ready → work → completion);
 *   - sequences are gapless, or the gaps are enumerated (the sink documents that
 *     an ambiguous append burns a sequence, so a gap is tolerated-but-recorded);
 *   - the terminal status is derivable (the run row's terminal status, itself
 *     server-side, corroborated by the pre-terminal `agent_transcript` marker).
 *
 * Pure: no I/O, no clock. The caller supplies the events (and the server run
 * status, which is also server-side) so this composes into an e2e test or a
 * server-side watchdog without a network.
 */

export interface TimelineEvent {
  sequence: number
  eventType: string
  payload?: Record<string, unknown>
}

// The lifecycle phases a hosted session passes through, in order. `completion`
// is the transcript tail (an optional pre-terminal event); the actual terminal
// transition is a run-row status set via PATCH, NOT an event — so completeness
// requires the terminal STATUS (see terminalDerivable), while the completion
// EVENT only corroborates it.
export const SESSION_PHASES = ['bootstrap', 'ready', 'work', 'completion'] as const
export type SessionPhase = (typeof SESSION_PHASES)[number]

// The phases that MUST be represented by events for a session to reconstruct.
// `completion` is excluded: the terminal is a PATCH-set run status, not an event.
export const REQUIRED_EVENT_PHASES: readonly SessionPhase[] = ['bootstrap', 'ready', 'work']

// Map each known server-side event type onto its lifecycle phase. Types absent
// here are still ordered in the timeline but tagged `phase: null` (they do not
// satisfy a required phase). Kept as a const map (no enums, per house style).
const PHASE_BY_EVENT_TYPE: Record<string, SessionPhase> = {
  // bootstrap: run start + sandbox/repo/runtime provisioning
  run_started: 'bootstrap',
  sandbox_provisioned: 'bootstrap',
  repo_cloned: 'bootstrap',
  cli_installed: 'bootstrap',
  setup_hook_completed: 'bootstrap',
  setup_hook_skipped: 'bootstrap',
  // ready: the agent harness is up and holds a live credential
  agent_ready: 'ready',
  agent_token: 'ready',
  // credential_rotated / credential_mint_failed are RESERVED vocabulary, NOT
  // emitted today (host-side run-stream emission was rejected as a single-writer
  // violation; the durable credential-use audit is the per-mint DB row). They
  // stay mapped so a FUTURE single-writer emitter classifies correctly, but the
  // `ready` phase is satisfied independently by agent_ready/agent_token — replay
  // completeness never depends on a credential event.
  credential_rotated: 'ready',
  credential_mint_failed: 'ready',
  // work: the agent acts (tool calls/results, steps, repo writes, artifacts)
  agent_tool_call: 'work',
  agent_tool_result: 'work',
  agent_step_start: 'work',
  agent_step_finish: 'work',
  repo_sync: 'work',
  artifact: 'work',
  session_title: 'work',
  // completion: the bounded transcript tail recorded just before the terminal PATCH
  agent_transcript: 'completion',
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['succeeded', 'failed', 'cancelled'])

export interface TimelineEntry {
  sequence: number
  eventType: string
  phase: SessionPhase | null
}

export interface ReconstructedTimeline {
  /** Every event, ordered by sequence, each tagged with its lifecycle phase. */
  ordered: TimelineEntry[]
  /** Which lifecycle phases are represented. */
  phasesPresent: Record<SessionPhase, boolean>
  /** Phases with no representative event (empty when complete). */
  missingPhases: SessionPhase[]
  /** Enumerated sequence gaps as [afterSequence, nextSequence] pairs. */
  sequenceGaps: Array<[number, number]>
  /** True when sequences are strictly contiguous from the first observed. */
  gapless: boolean
  /** The server run's terminal status, when one was supplied and is terminal. */
  terminalStatus: string | null
  /** A terminal status is derivable (the server run status is terminal). */
  terminalDerivable: boolean
  /** All REQUIRED event phases present AND a terminal is derivable. Gaps do NOT
   *  fail this — they are enumerated in `sequenceGaps` (tolerated-but-documented
   *  per the sink). */
  complete: boolean
}

export function reconstructSessionTimeline(
  events: readonly TimelineEvent[],
  opts: { runStatus?: string | null } = {}
): ReconstructedTimeline {
  const ordered: TimelineEntry[] = [...events]
    .sort((a, b) => a.sequence - b.sequence)
    .map(event => ({
      sequence: event.sequence,
      eventType: event.eventType,
      phase: PHASE_BY_EVENT_TYPE[event.eventType] ?? null,
    }))

  const phasesPresent = Object.fromEntries(
    SESSION_PHASES.map(phase => [phase, ordered.some(entry => entry.phase === phase)])
  ) as Record<SessionPhase, boolean>
  const missingPhases = REQUIRED_EVENT_PHASES.filter(phase => !phasesPresent[phase])

  const sequenceGaps: Array<[number, number]> = []
  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1].sequence
    const current = ordered[i].sequence
    if (current > previous + 1) {
      sequenceGaps.push([previous, current])
    }
  }
  const gapless = sequenceGaps.length === 0

  const runStatus = opts.runStatus ?? null
  const terminalStatus = runStatus && TERMINAL_STATUSES.has(runStatus) ? runStatus : null
  // The terminal is the run-row status (PATCH-set, server-side). The completion
  // event (`agent_transcript`), when present, corroborates it but is not required.
  const terminalDerivable = terminalStatus !== null

  const complete = missingPhases.length === 0 && terminalDerivable

  return {
    ordered,
    phasesPresent,
    missingPhases,
    sequenceGaps,
    gapless,
    terminalStatus,
    terminalDerivable,
    complete,
  }
}
