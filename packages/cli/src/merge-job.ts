/**
 * `orizu internal merge-job` — the one-shot merge sandbox ENTRYPOINT
 * (ALI-1084, merge-sandbox-job Phase 2). The MergeJobCoordinator DO launches
 * this inside a minimal, AGENT-FREE sandbox booted from the hosted snapshot;
 * from here the sandbox pulls its own credentials under the established
 * boot-secret PULL model and runs the SHARED merge core
 * (deploy-key-merge-core.ts — the exact code the server path runs; no forked
 * merge logic).
 *
 * FLOW (plan §2.2 step 4):
 *   a. exchange ORIZU_BOOT_SECRET at the DO for a single-use JOB TOKEN
 *      (`GET {coordinator}/merge-jobs/:jobKey/job-token`) — the token transits
 *      Cloudflare; the DEPLOY KEY never does;
 *   b. pull `{spec, privateKeyPem}` DIRECTLY from the control plane
 *      (`GET {orizu}/api/coordinator/merge-jobs/:jobId/payload`, job-token
 *      auth) — single-use, audited server-side before the key is returned;
 *   c. run the shared merge core (tmp worktree, 0600 key file, pinned GitHub
 *      host keys, expected-head verification, argv-asserted --no-ff merge)
 *      with the D8 PRE-PUSH GATE wired in: immediately before `git push` the
 *      core calls `GET .../gate`; `proceed: false` aborts WITHOUT pushing
 *      (terminal `superseded`). An UNREACHABLE gate also refuses the push
 *      (fail closed) but reports `failed` (retryable) — "unknown" is not
 *      "rejected";
 *   d. POST the terminal result to the DO (boot-secret auth). Reporting the
 *      terminal state — not the merge outcome — is this command's success:
 *      exit 0 on ANY reported terminal (conflict/superseded included), exit 1
 *      only when the env is invalid or the report itself failed.
 *
 * FROZEN ENV CONTRACT (the DO's merge-job sandbox env plan):
 *   ORIZU_BOOT_SECRET       per-sandbox durable bootstrap secret;
 *   ORIZU_MERGE_JOB_ID      the job's DO addressing key
 *                           (`merge:<manifestId>:<expectedHeadSha>` — the
 *                           control-plane job uuid rides the token response);
 *   ORIZU_COORDINATOR_URL   the coordinator Worker origin;
 *   ORIZU_BASE_URL          the Orizu control-plane origin.
 *
 * REDACTION: every reported detail passes through `redactSecrets` with the
 * boot secret, the job token, and the private key PEM on the exact-match list
 * (plus the shape-pattern net). Nothing here ever logs a secret.
 */

import {
  mergeBranchWithDeployKey,
  type DeployKeyMergeResult,
  type GitCommandRunner,
} from './deploy-key-merge-core.js'
import { redactSecrets } from './secret-redaction.js'

export type MergeJobFetch = (url: string, init?: RequestInit) => Promise<Response>

// -- Frozen env contract --------------------------------------------------------

export const REQUIRED_MERGE_JOB_ENV_VARS = [
  'ORIZU_BOOT_SECRET',
  'ORIZU_MERGE_JOB_ID',
  'ORIZU_COORDINATOR_URL',
  'ORIZU_BASE_URL',
] as const

export interface MergeJobEnv {
  bootSecret: string
  /** The DO addressing key (`merge:<manifestId>:<expectedHeadSha>`). */
  jobKey: string
  coordinatorUrl: string
  baseUrl: string
}

export function resolveMergeJobEnv(
  env: Record<string, string | undefined>
): { ok: true; value: MergeJobEnv } | { ok: false; missing: string[] } {
  const missing: string[] = []
  const req = (name: string): string => {
    const value = env[name]?.trim()
    if (!value) missing.push(name)
    return value ?? ''
  }
  const bootSecret = req('ORIZU_BOOT_SECRET')
  const jobKey = req('ORIZU_MERGE_JOB_ID')
  const coordinatorUrl = req('ORIZU_COORDINATOR_URL')
  const baseUrl = req('ORIZU_BASE_URL')
  if (missing.length > 0) return { ok: false, missing }
  return {
    ok: true,
    value: {
      bootSecret,
      jobKey,
      coordinatorUrl: coordinatorUrl.replace(/\/+$/, ''),
      baseUrl: baseUrl.replace(/\/+$/, ''),
    },
  }
}

// -- Terminal statuses (mirrors the merge_jobs enum; terminal subset only) -------

export type MergeJobTerminalStatus = 'succeeded' | 'conflict' | 'superseded' | 'failed'

export interface MergeJobReport {
  status: MergeJobTerminalStatus
  result: {
    merged: boolean
    sha: string | null
    alreadyMerged: boolean
    conflict: boolean
  } | null
  errorDetail: string | null
}

/** Map the shared core's outcome to the job's terminal status. */
export function terminalFromMergeResult(result: DeployKeyMergeResult): MergeJobReport {
  if (result.superseded) {
    return {
      status: 'superseded',
      result: null,
      errorDetail: 'pre-push gate refused: manifest no longer appliable',
    }
  }
  if (result.conflict) {
    return {
      status: 'conflict',
      result: { merged: false, sha: null, alreadyMerged: false, conflict: true },
      errorDetail: null,
    }
  }
  return {
    status: 'succeeded',
    result: {
      merged: result.merged,
      sha: result.sha,
      alreadyMerged: result.alreadyMerged,
      conflict: false,
    },
    errorDetail: null,
  }
}

// -- Step a: boot secret → job token (DO stream-through) ------------------------

export interface ExchangedJobToken {
  token: string
  /** The control-plane job id (merge_jobs uuid) — payload/gate URLs use it. */
  jobId: string
}

export async function exchangeJobToken(opts: {
  coordinatorUrl: string
  jobKey: string
  bootSecret: string
  fetchImpl: MergeJobFetch
  attempts?: number
  backoffMs?: number
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
}): Promise<ExchangedJobToken> {
  const attempts = Math.max(1, opts.attempts ?? 5)
  const baseBackoff = opts.backoffMs ?? 500
  const sleep = opts.sleep ?? ((ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms)))
  const url = `${opts.coordinatorUrl}/merge-jobs/${encodeURIComponent(opts.jobKey)}/job-token`
  let lastDetail = 'no attempt made'
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await opts.fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${opts.bootSecret}` },
      })
      if (res.ok) {
        const data = (await res.json().catch(() => null)) as { token?: unknown; jobId?: unknown } | null
        const token = data && typeof data.token === 'string' ? data.token : ''
        const jobId = data && typeof data.jobId === 'string' ? data.jobId : ''
        if (token && jobId) {
          return { token, jobId }
        }
        lastDetail = 'job-token response carried no token/jobId'
      } else {
        lastDetail = `job-token exchange returned ${res.status}`
      }
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : String(error)
    }
    if (attempt < attempts - 1) {
      const delay = baseBackoff * 2 ** attempt
      opts.log?.(`job-token exchange attempt ${attempt + 1}/${attempts} failed (${lastDetail}); retrying in ${delay}ms`)
      await sleep(delay)
    }
  }
  throw new Error(`job-token exchange failed after ${attempts} attempts: ${lastDetail}`)
}

// -- Step b: payload pull (spec + key, single-use, direct from control plane) ----

export interface MergeJobSpec {
  op: 'merge'
  jobId: string
  manifestId: string
  workspaceId: string
  repoFullName: string
  base: string
  sourceBranch: string
  expectedHeadSha: string
  commitMessage: string
}

export interface MergeJobPayload {
  spec: MergeJobSpec
  privateKeyPem: string
}

export async function fetchMergeJobPayload(opts: {
  baseUrl: string
  jobId: string
  token: string
  fetchImpl: MergeJobFetch
}): Promise<MergeJobPayload> {
  const url = `${opts.baseUrl}/api/coordinator/merge-jobs/${encodeURIComponent(opts.jobId)}/payload`
  const res = await opts.fetchImpl(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${opts.token}` },
  })
  if (!res.ok) {
    throw new Error(`payload pull returned ${res.status}`)
  }
  const data = (await res.json().catch(() => null)) as Partial<MergeJobPayload> | null
  const spec = data?.spec
  const privateKeyPem = typeof data?.privateKeyPem === 'string' ? data.privateKeyPem : ''
  if (!spec || typeof spec !== 'object' || !privateKeyPem) {
    throw new Error('payload response was missing spec/privateKeyPem')
  }
  if (spec.op !== 'merge') {
    // D9 op discriminator: this entrypoint implements ONLY the merge op.
    throw new Error(`unsupported job op: ${String(spec.op)}`)
  }
  for (const field of ['repoFullName', 'base', 'sourceBranch', 'expectedHeadSha', 'commitMessage'] as const) {
    if (typeof spec[field] !== 'string' || spec[field].length === 0) {
      throw new Error(`payload spec is missing ${field}`)
    }
  }
  return { spec: spec as MergeJobSpec, privateKeyPem }
}

// -- Step c helper: the D8 gate (fail closed on the push, honest on the report) --

export type GateOutcome = 'proceed' | 'superseded' | 'unavailable'

export async function checkPrePushGate(opts: {
  baseUrl: string
  jobId: string
  token: string
  fetchImpl: MergeJobFetch
}): Promise<GateOutcome> {
  const url = `${opts.baseUrl}/api/coordinator/merge-jobs/${encodeURIComponent(opts.jobId)}/gate`
  try {
    const res = await opts.fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${opts.token}` },
    })
    if (!res.ok) {
      return 'unavailable'
    }
    const data = (await res.json().catch(() => null)) as { proceed?: unknown } | null
    if (data && data.proceed === true) return 'proceed'
    if (data && data.proceed === false) return 'superseded'
    return 'unavailable'
  } catch {
    return 'unavailable'
  }
}

// -- Step d: report the terminal state to the DO (boot-secret auth) --------------

export async function postMergeJobResult(opts: {
  coordinatorUrl: string
  jobKey: string
  bootSecret: string
  report: MergeJobReport
  fetchImpl: MergeJobFetch
  attempts?: number
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
}): Promise<boolean> {
  const attempts = Math.max(1, opts.attempts ?? 3)
  const sleep = opts.sleep ?? ((ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms)))
  const url = `${opts.coordinatorUrl}/merge-jobs/${encodeURIComponent(opts.jobKey)}/result`
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await opts.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${opts.bootSecret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          status: opts.report.status,
          ...(opts.report.result ? { result: opts.report.result } : {}),
          ...(opts.report.errorDetail ? { errorDetail: opts.report.errorDetail } : {}),
        }),
      })
      if (res.ok) {
        return true
      }
      opts.log?.(`result report attempt ${attempt + 1}/${attempts} returned ${res.status}`)
    } catch (error) {
      opts.log?.(
        `result report attempt ${attempt + 1}/${attempts} failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    if (attempt < attempts - 1) {
      await sleep(500 * 2 ** attempt)
    }
  }
  return false
}

// -- Orchestration ----------------------------------------------------------------

const MAX_DETAIL_LENGTH = 1500

export interface RunMergeJobOptions {
  env: MergeJobEnv
  fetchImpl?: MergeJobFetch
  /** Injectable git runner (tests). Default: the core's real spawn. */
  runGit?: GitCommandRunner
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
  tokenAttempts?: number
  tokenBackoffMs?: number
}

export interface MergeJobRunResult {
  /** Whether the terminal state reached the DO — the command's success bar. */
  reported: boolean
  status: MergeJobTerminalStatus
  detail: string | null
}

export async function runMergeJob(opts: RunMergeJobOptions): Promise<MergeJobRunResult> {
  const env = opts.env
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as MergeJobFetch)
  const log = opts.log ?? ((): void => {})
  const secrets: string[] = [env.bootSecret]
  const redact = (value: string): string =>
    redactSecrets(value, { secrets }).slice(0, MAX_DETAIL_LENGTH)

  let report: MergeJobReport
  try {
    // a. boot secret → single-use job token (+ the control-plane job id).
    const exchanged = await exchangeJobToken({
      coordinatorUrl: env.coordinatorUrl,
      jobKey: env.jobKey,
      bootSecret: env.bootSecret,
      fetchImpl,
      attempts: opts.tokenAttempts,
      backoffMs: opts.tokenBackoffMs,
      sleep: opts.sleep,
      log,
    })
    secrets.push(exchanged.token)
    log(`job token exchanged (job ${exchanged.jobId})`)

    // b. pull spec + key directly from the control plane (single-use release).
    const payload = await fetchMergeJobPayload({
      baseUrl: env.baseUrl,
      jobId: exchanged.jobId,
      token: exchanged.token,
      fetchImpl,
    })
    secrets.push(payload.privateKeyPem)
    log(`payload pulled for ${payload.spec.repoFullName} (${payload.spec.sourceBranch} → ${payload.spec.base})`)

    // c. the SHARED merge core with the D8 gate immediately pre-push.
    // Object wrapper: TS cannot track closure writes to a let across the
    // await below and would narrow the literal type at the read site.
    const gate: { outcome: GateOutcome } = { outcome: 'proceed' }
    const result = await mergeBranchWithDeployKey(
      payload.spec.repoFullName,
      {
        base: payload.spec.base,
        sourceBranch: payload.spec.sourceBranch,
        expectedHeadSha: payload.spec.expectedHeadSha,
        commitMessage: payload.spec.commitMessage,
        privateKeyPem: payload.privateKeyPem,
      },
      {
        runGit: opts.runGit,
        prePushGate: async () => {
          gate.outcome = await checkPrePushGate({
            baseUrl: env.baseUrl,
            jobId: exchanged.jobId,
            token: exchanged.token,
            fetchImpl,
          })
          log(`pre-push gate: ${gate.outcome}`)
          // FAIL CLOSED on the push for both 'superseded' and 'unavailable'.
          return gate.outcome === 'proceed'
        },
      }
    )

    if (result.superseded && gate.outcome === 'unavailable') {
      // The gate could not answer — "unknown" is not "rejected". No push
      // happened (fail closed); report a retryable failure, not superseded.
      report = {
        status: 'failed',
        result: null,
        errorDetail: 'pre-push gate unreachable; aborted without pushing',
      }
    } else {
      report = terminalFromMergeResult(result)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    report = { status: 'failed', result: null, errorDetail: redact(message) }
  }

  if (report.errorDetail) {
    report = { ...report, errorDetail: redact(report.errorDetail) }
  }

  const reported = await postMergeJobResult({
    coordinatorUrl: env.coordinatorUrl,
    jobKey: env.jobKey,
    bootSecret: env.bootSecret,
    report,
    fetchImpl,
    sleep: opts.sleep,
    log,
  })
  log(`terminal ${report.status} ${reported ? 'reported' : 'REPORT FAILED'}`)
  return { reported, status: report.status, detail: report.errorDetail }
}

// -- CLI entry (`orizu internal merge-job`) ---------------------------------------

export interface MergeJobCommandIo {
  print: (line: string) => void
  printErr?: (line: string) => void
  json?: boolean
}

/**
 * Read the frozen env contract and run the job. Exit 0 on ANY reported
 * terminal outcome (the REPORT, not the merge, is the command's success —
 * a conflict is a correctly-completed job); exit 1 when the env is invalid
 * or the terminal report never reached the DO (the DO's job wall is the
 * backstop then).
 */
export async function mergeJobCommand(io: MergeJobCommandIo): Promise<number> {
  const resolved = resolveMergeJobEnv(process.env)
  if (!resolved.ok) {
    io.printErr?.(
      `merge-job: missing required env: ${resolved.missing.join(', ')} ` +
        '(the MergeJobCoordinator sandbox env contract)'
    )
    return 1
  }
  const log = (line: string): void => io.printErr?.(`[merge-job] ${line}`)
  const outcome = await runMergeJob({ env: resolved.value, log })
  io.print(
    io.json
      ? JSON.stringify({ ok: outcome.reported, status: outcome.status, detail: outcome.detail })
      : `merge-job finished: ${outcome.status}${outcome.detail ? ` (${outcome.detail})` : ''}${outcome.reported ? '' : ' [terminal report failed]'}`
  )
  return outcome.reported ? 0 : 1
}
