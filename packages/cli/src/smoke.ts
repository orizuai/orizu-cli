/**
 * Terminal-only Phase 2 smoke workflow (ALI-908).
 *
 * Pure, importable step logic with an injected fetcher factory. It drives the
 * REAL Phase 2 CLI command modules (workbench-cli sessions/runs/tail/terminal)
 * plus the RunAPI / promotion-manifest routes over HTTP. The `scripts/workbench-
 * smoke.mjs` driver supplies a live-server fetcher from env; the unit test
 * supplies an in-memory fake server. No process/argv/print here.
 *
 * The workflow proves, against server-side state only:
 *  - create-or-attach workspace idempotency (reused on a second run),
 *  - a session + workbench run with persisted append-only events,
 *  - terminal-death reconnect (a fresh client re-reads every prior event),
 *  - promotion-manifest create + apply idempotency,
 *  - run-completion idempotency (one terminal event under a retried PATCH).
 *
 * Phase 2 boundaries: no OpenInspect, no hosted sandbox, no Slack/web entry,
 * no Cloudflare Artifacts, no durable overnight jobs.
 */

import {
  runSessionEnd,
  runSessionStart,
  runWorkbenchRunStart,
  runWorkbenchRunStatus,
  runWorkbenchRunTerminal,
  tailOnce,
} from './workbench-cli.js'

export interface SmokeFetcher {
  (path: string, init?: RequestInit): Promise<Response>
}

export interface SmokeConfig {
  teamSlug: string
  projectSlug: string
  workspaceSlug: string
  /** Optional real score-run id to reference from the eval_scored event. */
  scoreRunId?: string | null
}

export type SmokeDisposition = 'created' | 'reused' | 'verified'

export interface SmokeStepReport {
  index: number
  key: string
  title: string
  ok: boolean
  disposition: SmokeDisposition
  detail: string
}

export interface SmokeStepPlan {
  index: number
  key: string
  title: string
  plan: string
}

export interface SmokeSummary {
  created: string[]
  reused: string[]
  verified: string[]
}

export interface SmokeReport {
  ok: boolean
  steps: SmokeStepReport[]
  failedStep: SmokeStepReport | null
  summary: SmokeSummary
  ids: {
    workspaceId?: string
    sessionId?: string
    runId?: string
    manifestId?: string
  }
}

export interface RunSmokeOptions {
  config: SmokeConfig
  /** Returns a fresh, stateless HTTP client. Called for the primary flow and
   *  again to simulate a terminal kill/reconnect. */
  makeFetcher: () => SmokeFetcher
  now?: () => string
  onStep?: (step: SmokeStepReport) => void
}

export const SMOKE_RUN_TITLE = 'smoke: highlight-derived workflow'

// Deterministic, HIP/highlight-shaped events appended after run start (seq 1 is
// the server-emitted run_started). Stable event_ids make the append idempotent.
export const SMOKE_EVENTS = [
  {
    eventId: 'smoke-evt-1',
    eventType: 'highlight_ingested',
    sequence: 2,
    payload: { highlightId: 'hl-smoke-001', source: 'hip', span: { start: 0, end: 42 } },
  },
  {
    eventId: 'smoke-evt-2',
    eventType: 'eval_scored',
    sequence: 3,
    payload: { metricKey: 'faithfulness', score: 0.87, comparable: true },
  },
  {
    eventId: 'smoke-evt-3',
    eventType: 'notes_recorded',
    sequence: 4,
    payload: { note: 'Highlight-derived smoke: no regression detected.' },
  },
] as const

const STEP_PLAN: ReadonlyArray<{ key: string; title: string; plan: string }> = [
  { key: 'workspace', title: 'Workspace resolve-or-attach', plan: 'POST /api/cli/workspaces (idempotent on team+slug)' },
  { key: 'session', title: 'Session start', plan: 'POST /api/cli/workspaces/{id}/sessions' },
  { key: 'run', title: 'Workbench run start', plan: 'POST /api/cli/workbench-runs + verify seq-1 run_started via tail' },
  { key: 'events', title: 'Append highlight-derived events', plan: 'POST /workbench-runs/{id}/events x3 (smoke-evt-1..3)' },
  { key: 'reconnect', title: 'Terminal-death reconnect', plan: 'fresh client re-fetches run + tails from cursor 0' },
  { key: 'manifest', title: 'Promotion manifest no_change', plan: 'create (idempotent) -> approve -> apply -> re-apply' },
  { key: 'complete', title: 'Complete run + end session', plan: 'PATCH succeeded (idempotent) + PATCH session ended' },
  { key: 'summary', title: 'Re-run accounting', plan: 'classify reused vs created rows' },
]

export function planSmokeSteps(_config: SmokeConfig): SmokeStepPlan[] {
  return STEP_PLAN.map((step, i) => ({ index: i + 1, key: step.key, title: step.title, plan: step.plan }))
}

function titleFor(key: string): string {
  return STEP_PLAN.find(step => step.key === key)?.title ?? key
}

function indexFor(key: string): number {
  return STEP_PLAN.findIndex(step => step.key === key) + 1
}

async function readBody(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>
  } catch {
    return {}
  }
}

async function errorMessage(response: Response): Promise<string> {
  const body = await readBody(response.clone())
  const error = typeof body.error === 'string' ? body.error : null
  return error || response.statusText || String(response.status)
}

async function postJson(
  fetcher: SmokeFetcher,
  path: string,
  payload: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetcher(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    throw new Error(`${path} failed (${response.status}): ${await errorMessage(response)}`)
  }
  return { status: response.status, body: await readBody(response) }
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} missing from response`)
  }
  return value as Record<string, unknown>
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} missing from response`)
  }
  return value
}

export async function runSmokeWorkflow(opts: RunSmokeOptions): Promise<SmokeReport> {
  const { config } = opts
  const fetcher = opts.makeFetcher()
  const steps: SmokeStepReport[] = []
  const summary: SmokeSummary = { created: [], reused: [], verified: [] }
  const ids: SmokeReport['ids'] = {}

  const record = (key: string, disposition: SmokeDisposition, detail: string): SmokeStepReport => {
    const step: SmokeStepReport = { index: indexFor(key), key, title: titleFor(key), ok: true, disposition, detail }
    steps.push(step)
    if (disposition === 'created') summary.created.push(key)
    if (disposition === 'reused') summary.reused.push(key)
    if (disposition === 'verified') summary.verified.push(key)
    opts.onStep?.(step)
    return step
  }

  try {
    // 1 — Workspace resolve-or-attach (201 created / 200 reused).
    const workspace = await postJson(fetcher, '/api/cli/workspaces', {
      teamSlug: config.teamSlug,
      name: config.workspaceSlug,
      slug: config.workspaceSlug,
    })
    const workspaceId = requireId(requireObject(workspace.body.workspace, 'workspace').id, 'workspace id')
    ids.workspaceId = workspaceId
    const workspaceDisposition: SmokeDisposition = workspace.status === 201 ? 'created' : 'reused'
    record('workspace', workspaceDisposition, `${workspaceDisposition} workspace ${workspaceId} (slug=${config.workspaceSlug})`)

    // 2 — Session start (always a new row).
    const session = await runSessionStart({
      fetcher,
      workspaceId,
      projectSlug: config.projectSlug,
      clientInfo: { source: 'orizu-smoke' },
    })
    const sessionId = requireId(session.session.id, 'session id')
    ids.sessionId = sessionId
    record('session', 'created', `created session ${sessionId}`)

    // 3 — Workbench run start + verify the server-emitted seq-1 run_started.
    const runStart = await runWorkbenchRunStart({ fetcher, sessionId, title: SMOKE_RUN_TITLE, projectSlug: config.projectSlug })
    const runId = requireId(runStart.run.id, 'run id')
    ids.runId = runId
    const opening = await tailOnce(fetcher, runId, 0)
    const started = opening.events.find(event => event.sequence === 1)
    if (!started || started.eventType !== 'run_started') {
      throw new Error('seq-1 run_started event was not present on tail')
    }
    record('run', 'created', `created run ${runId}; verified seq-1 run_started`)

    // 4 — Append the three highlight-derived events (deterministic ids).
    for (const event of SMOKE_EVENTS) {
      const payload: Record<string, unknown> = { ...event.payload }
      if (event.eventType === 'eval_scored' && config.scoreRunId) {
        payload.scoreRunId = config.scoreRunId
      }
      const appended = await postJson(fetcher, `/api/cli/workbench-runs/${encodeURIComponent(runId)}/events`, {
        eventId: event.eventId,
        eventType: event.eventType,
        sequence: event.sequence,
        payload,
      })
      if (appended.status !== 201 && appended.status !== 200) {
        throw new Error(`unexpected append status ${appended.status} for ${event.eventId}`)
      }
    }
    record('events', 'created', `appended ${SMOKE_EVENTS.length} events (${SMOKE_EVENTS.map(e => e.eventId).join(', ')})`)

    // 5 — Simulated terminal death: a fresh, stateless client re-reads the run.
    const reconnectFetcher = opts.makeFetcher()
    const reread = await runWorkbenchRunStatus({ fetcher: reconnectFetcher, runId })
    if (reread.run.id !== runId) {
      throw new Error('reconnected client resolved a different run id')
    }
    const replay = await tailOnce(reconnectFetcher, runId, 0)
    const expectedTypes = ['run_started', ...SMOKE_EVENTS.map(e => e.eventType)]
    const seenTypes = replay.events.filter(e => e.sequence <= expectedTypes.length).map(e => e.eventType)
    for (const expected of expectedTypes) {
      if (!seenTypes.includes(expected)) {
        throw new Error(`reconnect did not see ${expected}; state was lost`)
      }
    }
    record('reconnect', 'verified', `fresh client re-read ${expectedTypes.length} events after kill (${expectedTypes.join(', ')})`)

    // 6 — Promotion manifest: create (idempotent), approve, apply, re-apply.
    const projectRef = `${config.teamSlug}/${config.projectSlug}`
    const idempotencyKey = `smoke:no_change:${runId}`
    const manifestBody = {
      actionType: 'no_change',
      idempotencyKey,
      workspaceId,
      workspaceSessionId: sessionId,
      workbenchRunId: runId,
      impactNotes: 'Smoke workflow: no primitive change; substrate proof only.',
      rollbackNotes: 'No-op; nothing to roll back.',
      evidence: { workbench_run_ids: [runId], notes: ['highlight-derived smoke run'] },
      currentState: {},
      proposedState: {},
    }
    const manifestPath = `/api/cli/promotion-manifests?project=${encodeURIComponent(projectRef)}`
    const created = await postJson(fetcher, manifestPath, manifestBody)
    const manifestId = requireId(requireObject(created.body.manifest, 'manifest').id, 'manifest id')
    ids.manifestId = manifestId
    // Create idempotency: same key returns the same row.
    const recreated = await postJson(fetcher, manifestPath, manifestBody)
    const recreatedId = requireId(requireObject(recreated.body.manifest, 'manifest').id, 'manifest id')
    if (recreatedId !== manifestId) {
      throw new Error('manifest create was not idempotent on the idempotency key')
    }

    const actionPath = `/api/cli/promotion-manifests/${encodeURIComponent(manifestId)}`
    await postJson(fetcher, actionPath, { action: 'approve' })
    const applied = await postJson(fetcher, actionPath, { action: 'apply' })
    const appliedOutcome = requireObject(applied.body.manifest, 'manifest').outcome
    const reapplied = await postJson(fetcher, actionPath, { action: 'apply' })
    const reappliedOutcome = requireObject(reapplied.body.manifest, 'manifest').outcome
    if (JSON.stringify(appliedOutcome) !== JSON.stringify(reappliedOutcome)) {
      throw new Error('manifest re-apply produced a different outcome (not idempotent)')
    }
    record('manifest', 'created', `manifest ${manifestId} no_change applied; re-apply idempotent`)

    // 7 — Complete the run (idempotent) + end the session.
    await runWorkbenchRunTerminal({
      fetcher,
      runId,
      status: 'succeeded',
      summary: 'smoke workflow completed with no promotion change',
      evidence: { promotion_manifest_ids: [manifestId] },
    })
    // Retry the terminal PATCH: still exactly one terminal event server-side.
    await runWorkbenchRunTerminal({ fetcher, runId, status: 'succeeded', summary: 'idempotent retry' })
    const finalTail = await tailOnce(fetcher, runId, 0, 500)
    const terminalCount = finalTail.events.filter(e => e.eventType === 'run_completed').length
    if (terminalCount !== 1) {
      throw new Error(`expected exactly one run_completed event, saw ${terminalCount}`)
    }
    await runSessionEnd({ fetcher, sessionId })
    record('complete', 'verified', `run completed (single terminal event) and session ${sessionId} ended`)

    // 8 — Re-run accounting: distinguish reused vs created rows.
    record(
      'summary',
      'verified',
      `reused=[${summary.reused.join(', ') || 'none'}] created=[${summary.created.join(', ')}]`
    )

    return { ok: true, steps, failedStep: null, summary, ids }
  } catch (error) {
    const key = STEP_PLAN[steps.length]?.key ?? 'unknown'
    const failedStep: SmokeStepReport = {
      index: indexFor(key),
      key,
      title: titleFor(key),
      ok: false,
      disposition: 'verified',
      detail: error instanceof Error ? error.message : String(error),
    }
    steps.push(failedStep)
    opts.onStep?.(failedStep)
    return { ok: false, steps, failedStep, summary, ids }
  }
}
