import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { extractErrorMessage } from './error-response.js'
import { getGepaPythonCommand } from './gepa-python-command.js'
import { authedFetch } from './http.js'
import { sanitizeTerminalText } from './json-response.js'
import { assertSnapshotManifestConfined, verifyRunnerDirRegistered } from './runner-dir-verify.js'
import { runnerInputPrompt } from './runner-instruction-set-contract.js'
import { PARITY_BRIDGE_SOURCE } from './scorers-verify-parity-bridge.js'

/**
 * `orizu scorers verify-parity` (ALI-1554): prove a migrated Orizu scorer
 * runner scores the same rows the same way the customer's original Python
 * metric does, UNDER THE PAYLOAD `run-gepa` sends the runner, before the first
 * optimization spends tokens on a scorer that silently disagrees.
 *
 * Honesty note: `run-gepa` executes runners through the vendored Python
 * `run_file_contract_runner`, not this TypeScript path. What this proves is
 * "the runner, under the run-gepa flat_row payload, via the CLI's file
 * contract". The payload is asserted key-for-key by
 * test/scorers-verify-parity.test.ts (H9) against a literal hand-derived from
 * `make_scorer_runner`'s flat_row branch — NOT against a fixture shared with
 * `test_flat_row_payload_shape_mirrors_score_run_exec`, so a rename on the
 * Python side turns only the Python test red until the shared fixture lands
 * (ALI-1556). The env allowlist is the TypeScript one.
 */
export interface VerifyParityIo {
  json: boolean
  print: (line: string) => void
  printErr: (line: string) => void
  materializeRunnerVersion: (runnerVersionId: string) => Promise<{ runnerDir: string; cleanup: () => void }>
  readRunnerManifest: (runnerDir: string) => { command: string[]; supports_body_kind?: string[] }
  runnerSubprocessEnv: (inputPath: string, outputPath: string) => NodeJS.ProcessEnv
  timeoutMs: number
  maxOutputBytes: number
  fetcher?: (path: string, init?: RequestInit) => Promise<Response>
  /** Test seam for the pairing tests (H8); production always uses the embedded bridge. */
  bridgeSource?: string
}

interface ParityMismatch { row_id: string; orizu: number; original: number }
interface ParityError { row_id: string | null; side: 'orizu' | 'original'; message: string }
interface ParityClamp { row_id: string; side: 'orizu' | 'original'; raw: number; score: number }
interface ExtractedScore { raw: number; score: number }
interface SampleRow { id: string; row: Record<string, unknown> }

const USAGE = 'Usage: orizu scorers verify-parity --scorer-version <id> --dataset-version <id> --split-set <id> [--split <name>] --outputs <outputs.jsonl> --original <module:function> [--scorer-input-contract gepa|flat_row] [--scorer-candidate-field <row-field>] [--runner-dir <dir>] [--python <cmd>] [--tolerance <float>] [--limit <n>] [--json]'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * LAST occurrence wins, mirroring run-gepa's scalar options
 * (`gepa-engine-dispatch.ts` `translateOfficialOptions` assigns
 * `connectorEnvironment[option.environment]` on every occurrence, so the final
 * value overwrites earlier ones). First-wins would check parity against a
 * wrapper's default while the optimization used the operator's override.
 */
function option(args: readonly string[], name: string): string | null {
  const index = args.lastIndexOf(name)
  const value = index === -1 ? undefined : args[index + 1]
  return value === undefined || value.startsWith('--') ? null : value
}

function messageOf(error: unknown): string {
  return sanitizeTerminalText(error instanceof Error ? error.message : String(error))
}

/**
 * The score extraction rule, mirroring `orizu_gepa.optimizer._score_from_scorer`
 * so the number this command compares is the number GEPA would optimize:
 * a top-level `score` beats `model_response.score`, numeric strings coerce,
 * non-finite is an error, and the result clamps to [0, 1].
 */
const PYTHON_FLOAT_SPECIAL = /^[+-]?(inf(inity)?|nan)$/i
const PYTHON_FLOAT_DECIMAL = /^[+-]?(\d(_?\d)*(\.(\d(_?\d)*)?)?|\.\d(_?\d)*)([eE][+-]?\d(_?\d)*)?$/

/**
 * Python's `float()` grammar, not JavaScript's `Number()`. Measured 2026-08-23:
 * `float` REJECTS '0x10', '0b1', '0o7', '' and '1,5' (all of which `Number`
 * happily converts or turns into 0), and ACCEPTS '  0.5  ', '1e3', '1_0', '.5',
 * '5.', '+3', 'inf', 'Infinity' and 'nan'. Anything `_score_from_scorer` would
 * refuse during the real optimization must be refused here too, or this gate
 * certifies a scorer run-gepa cannot use. `inf`/`nan` parse and are then
 * rejected by the finite check, exactly as Python does.
 */
export function pythonFloat(text: string): number | null {
  const trimmed = text.trim()
  if (PYTHON_FLOAT_SPECIAL.test(trimmed)) return Number(trimmed.replace(/infinity/i, 'Infinity'))
  if (!PYTHON_FLOAT_DECIMAL.test(trimmed)) return null
  const parsed = Number(trimmed.replace(/_/g, ''))
  return Number.isNaN(parsed) ? null : parsed
}

export function extractParityScore(value: unknown, label: string): ExtractedScore {
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object with a numeric score`)
  const source = !('score' in value) && isRecord(value.model_response)
    ? { ...value.model_response, ...value }
    : value
  let raw = source.score
  // Measured: `_score_from_scorer(extra={'score': True})` -> (1.0, None) and
  // `False` -> (0.0, None) — bool is an int subclass, so Python's numeric branch
  // accepts it. An exact-match DSPy metric returning a bool must compare, not error.
  if (typeof raw === 'boolean') raw = raw ? 1 : 0
  if (typeof raw === 'string') {
    const parsed = pythonFloat(raw)
    raw = parsed === null ? undefined : parsed
  }
  if (typeof raw !== 'number') throw new Error(`${label} must include a numeric score`)
  if (!Number.isFinite(raw)) throw new Error(`${label} score must be finite`)
  return { raw, score: clamp(raw) }
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value))
}

interface OutputsFile { byRowId: Map<string, string> }

function readOutputs(path: string): OutputsFile {
  const byRowId = new Map<string, string>()
  const text = readFileSync(path, 'utf8')
  let lineNumber = 0
  for (const line of text.split('\n')) {
    lineNumber += 1
    if (!line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new Error(`--outputs line ${lineNumber} is not valid JSON`)
    }
    if (!isRecord(parsed) || typeof parsed.row_id !== 'string' || !parsed.row_id) {
      throw new Error(`--outputs line ${lineNumber} must have a non-empty string row_id`)
    }
    if (typeof parsed.model_output !== 'string') {
      throw new Error(`--outputs line ${lineNumber} (row ${parsed.row_id}) must have a string model_output`)
    }
    if (byRowId.has(parsed.row_id)) {
      throw new Error(`--outputs has duplicate row_id ${parsed.row_id} on line ${lineNumber}`)
    }
    byRowId.set(parsed.row_id, parsed.model_output)
  }
  return { byRowId }
}

interface ExecContext {
  prompt: { body?: string | null; bodyKind: string; providerSettings: Record<string, unknown>; promptVersionId: string; runnerVersionId: string }
  scorer?: { versionId: string; metricKey: string; higherIsBetter: boolean } | null
  /**
   * Declared so it cannot be silently dropped: the route returns it for
   * scorerVersion queries too, and `run-gepa` sends both the `instruction_set`
   * payload key and ORIZU_INSTRUCTION_SET_DIR. Building that payload here is
   * ALI-1556; until then an instruction-set-backed scorer is REFUSED, because
   * proving parity for a payload the optimization will not send is the exact
   * silent agreement this command exists to prevent.
   */
  instructionSet?: Record<string, unknown> | null
  rows: SampleRow[]
}

/** One hour / 64 MiB: a bridge asking for more is a runaway, not a big split. */
const BRIDGE_MAX_TIMEOUT_MS = 60 * 60_000
const BRIDGE_MAX_OUTPUT_BYTES = 64 * 1024 * 1024

/**
 * The Orizu side spawns the runner ONCE PER ROW, so each row gets the full
 * per-row budget. The original side scores the whole sample in ONE bridge
 * process, so handing it the per-row budget gives an N-row split 1/N of the
 * time the Orizu side had: a 40-row split with an LLM-judge metric is SIGTERMed
 * before it can write output.json and every row's work is lost (round-2 review).
 * Scale by the sample length, bounded so a huge split cannot ask for forever.
 */
export function bridgeBudget(
  perRowTimeoutMs: number,
  perRowMaxOutputBytes: number,
  sampleLength: number
): { timeoutMs: number; maxOutputBytes: number } {
  // Never 0: spawnSync reads a 0 timeout/maxBuffer as "kill immediately".
  const rows = Math.max(1, sampleLength)
  return {
    timeoutMs: Math.min(perRowTimeoutMs * rows, BRIDGE_MAX_TIMEOUT_MS),
    maxOutputBytes: Math.min(perRowMaxOutputBytes * rows, BRIDGE_MAX_OUTPUT_BYTES),
  }
}

const SCORER_INPUT_CONTRACTS = ['gepa', 'flat_row'] as const
const DEFAULT_CANDIDATE_OUTPUT_FIELD = 'model_output'

/**
 * Resolve the scorer input contract and candidate-output row field with the
 * SAME precedence `run-gepa` uses (`orizu_gepa.runner.resolve_scorer_input_contract`):
 * explicit flag > runner manifest (`scorer_input_contract`, `candidate_output_field`)
 * > defaults (`gepa`, `model_output`). Resolution is by PRESENCE, not truthiness,
 * so a blank manifest value fails validation instead of silently defaulting.
 *
 * Parity may only be claimed for the payload run-gepa will actually send, so a
 * contract that resolves to anything but `flat_row` is refused here rather than
 * assumed: proving parity on a shape the optimization never uses is the exact
 * silent-agreement failure this command exists to prevent.
 */
export function resolveScorerInputContract(
  manifest: Record<string, unknown>,
  flagContract: string | null,
  flagField: string | null
): { contract: string; field: string } {
  const manifestContract = manifest.scorer_input_contract
  const contract = flagContract !== null ? flagContract : manifestContract !== undefined ? manifestContract : 'gepa'
  if (typeof contract !== 'string' || !(SCORER_INPUT_CONTRACTS as readonly string[]).includes(contract)) {
    throw new Error(`Unknown scorer input contract ${JSON.stringify(contract)}; expected one of: ${SCORER_INPUT_CONTRACTS.join(', ')}`)
  }
  if (contract !== 'flat_row') {
    throw new Error(
      `The scorer runner's input contract resolves to '${contract}', but verify-parity can only prove parity ` +
      "under the 'flat_row' payload. Declare \"scorer_input_contract\": \"flat_row\" in the runner manifest " +
      '(or pass --scorer-input-contract flat_row), and pass the same --scorer-input-contract flat_row to ' +
      '`orizu optimizations run-gepa` so the payload proven here is the payload the optimization sends.'
    )
  }
  const explicitField = flagField !== null ? flagField : manifest.candidate_output_field
  const field = explicitField !== undefined ? explicitField : DEFAULT_CANDIDATE_OUTPUT_FIELD
  if (typeof field !== 'string' || field.trim() === '') {
    throw new Error(
      `candidate output field must be a non-empty string (got ${JSON.stringify(field)} via ` +
      '--scorer-candidate-field / manifest candidate_output_field)'
    )
  }
  if (field === 'candidate_error') {
    throw new Error("candidate output field 'candidate_error' is reserved for the adapter's error companion; choose a different row field")
  }
  return { contract, field }
}

/** The runner manifest's raw JSON, for the two keys `readRunnerManifest` does not surface. */
function readManifestExtras(runnerDir: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(join(runnerDir, 'manifest.json'), 'utf8')) as unknown
  return isRecord(parsed) ? parsed : {}
}

/**
 * The flat_row payload EXACTLY as `run-gepa` builds it
 * (`orizu_gepa.runner.make_scorer_runner`, flat_row branch): the dataset row
 * with the candidate output injected under the candidate field, `candidate_error`
 * reserved, plus the top-level score-run companions. Not the bare `runners exec`
 * shape, which reads `model_output` from a stale dataset field.
 */
function flatRowInput(context: ExecContext, entry: SampleRow, candidate: string, candidateField: string): Record<string, unknown> {
  const scorerVersionId = context.scorer?.versionId ?? context.prompt.promptVersionId
  return {
    model_output: candidate,
    subject: { type: 'scorer_row', row_id: entry.id, scorer_version_id: scorerVersionId, prompt_version_id: context.prompt.promptVersionId },
    scorer: { version_id: scorerVersionId, metric_key: context.scorer?.metricKey ?? 'score', higher_is_better: context.scorer?.higherIsBetter ?? true },
    gepa: { candidate_id: 'verify-parity', candidate_raw_response: null, candidate_error: null },
    row: { ...entry.row, [candidateField]: candidate, candidate_error: null },
    prompt: runnerInputPrompt(context.prompt),
    prompt_version_id: context.prompt.promptVersionId,
    runner_version_id: context.prompt.runnerVersionId,
    run_id: null,
  }
}

export async function verifyScorerParityCommand(args: string[], io: VerifyParityIo): Promise<number> {
  const tolerance = Number(option(args, '--tolerance') ?? '0')
  const clamped: ParityClamp[] = []
  const mismatches: ParityMismatch[] = []
  const errors: ParityError[] = []
  // Resolved from the runner manifest once it is readable; reported either way so
  // the operator can see which payload parity was (or was not) proven under.
  let resolved: { contract: string; field: string } | null = null

  const fail = (message: string): number => {
    io.printErr(sanitizeTerminalText(message))
    if (io.json) {
      // Carry the evidence already collected: row errors gathered before the
      // failure are exactly what the agent has to fix next, and dropping them
      // leaves an empty `errors` behind an opaque "could not run".
      io.print(JSON.stringify({
        parity: false, compared: 0, mismatches: [], errors, tolerance, clamped,
        scorer_input_contract: resolved?.contract ?? null,
        candidate_output_field: resolved?.field ?? null,
        error: sanitizeTerminalText(message),
      }))
    }
    return 2
  }

  let python: string
  let rest: string[]
  try {
    const pythonCommand = getGepaPythonCommand(args, process.env)
    python = pythonCommand.python
    rest = pythonCommand.args
  } catch (error) {
    return fail(messageOf(error))
  }

  const scorerVersion = option(rest, '--scorer-version')
  const datasetVersion = option(rest, '--dataset-version')
  const splitSet = option(rest, '--split-set')
  const split = option(rest, '--split') ?? 'validation'
  const outputsPath = option(rest, '--outputs')
  const original = option(rest, '--original')
  const contractFlag = option(rest, '--scorer-input-contract')
  const candidateFieldFlag = option(rest, '--scorer-candidate-field')
  const runnerDirArg = option(rest, '--runner-dir')
  const limitArg = option(rest, '--limit')
  if (!scorerVersion || !datasetVersion || !splitSet || !outputsPath || !original) return fail(USAGE)
  if (!Number.isFinite(tolerance) || tolerance < 0) return fail('--tolerance must be a finite number >= 0')
  const limit = limitArg === null ? null : Number(limitArg)
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) return fail('--limit must be a positive integer')

  let outputs: OutputsFile
  try {
    outputs = readOutputs(outputsPath)
  } catch (error) {
    return fail(messageOf(error))
  }

  const fetcher = io.fetcher ?? authedFetch
  const query = new URLSearchParams({ scorerVersion, datasetVersion, splitSet, split })
  let contextResponse: Response
  try {
    // A transport rejection (server unreachable) is a check that COULD NOT RUN,
    // not a mismatch: uncaught it escapes the command, exits 1 and prints no
    // --json failure report at all.
    contextResponse = await fetcher(`/api/cli/runners/exec-context?${query.toString()}`)
  } catch (error) {
    return fail(`Failed to reach the server for the runner execution context: ${messageOf(error)}`)
  }
  if (!contextResponse.ok) {
    return fail(`Failed to fetch runner execution context: ${await extractErrorMessage(contextResponse)}`)
  }
  let context: ExecContext
  try {
    context = await contextResponse.json() as ExecContext
  } catch (error) {
    return fail(`Runner exec context was not valid JSON: ${messageOf(error)}`)
  }
  if (!Array.isArray(context.rows)) return fail('Runner exec context did not return rows')
  if (context.instructionSet !== undefined && context.instructionSet !== null) {
    return fail(
      'This scorer is backed by an instruction set, and verify-parity cannot yet prove parity for one: ' +
      'run-gepa sends the runner an `instruction_set` payload key and an ORIZU_INSTRUCTION_SET_DIR that ' +
      'this command does not build (ALI-1556). Refusing rather than proving parity for a payload the ' +
      'optimization will not send.'
    )
  }
  const sample = limit === null ? context.rows : context.rows.slice(0, limit)
  if (sample.length === 0) {
    return fail('The selected split has no rows, so parity cannot be proven. Pick a split with rows.')
  }

  const sampleIds = new Set(sample.map(entry => entry.id))
  // Outputs must COVER the limited sample, but membership is checked against the
  // whole partition: `--limit` is a smoke check over the head of the same
  // outputs.jsonl the recipe builds for the full split, not a reason to hand-trim it.
  const partitionIds = new Set(context.rows.map(entry => entry.id))
  for (const entry of sample) {
    if (!outputs.byRowId.has(entry.id)) return fail(`--outputs has no model_output for sample row ${entry.id}`)
  }
  for (const rowId of outputs.byRowId.keys()) {
    if (!partitionIds.has(rowId)) return fail(`--outputs row_id ${rowId} is not in the ${split} rows of this split set`)
  }

  const runnerVersionId = context.prompt?.runnerVersionId
  if (!runnerVersionId) return fail('Runner exec context did not resolve a runner version id for this scorer')

  let runner: { runnerDir: string; cleanup: () => void }
  try {
    runner = runnerDirArg
      ? await (async () => {
          const verified = await verifyRunnerDirRegistered({ runnerVersionId, dir: runnerDirArg, flag: '--runner-dir', fetcher: io.fetcher })
          return { runnerDir: verified.snapshotDir, cleanup: verified.cleanup }
        })()
      : await io.materializeRunnerVersion(runnerVersionId)
  } catch (error) {
    return fail(messageOf(error))
  }

  const orizuScores = new Map<string, ExtractedScore>()
  // Resolved from the runner manifest below; the ORIGINAL side must see the row
  // injected at the SAME field, or the two sides read different candidates.
  let candidateField = DEFAULT_CANDIDATE_OUTPUT_FIELD
  try {
    let manifest: { command: string[] }
    try {
      assertSnapshotManifestConfined(runner.runnerDir, runnerDirArg ? '--runner-dir' : '--runner-version')
      manifest = io.readRunnerManifest(runner.runnerDir)
      resolved = resolveScorerInputContract(readManifestExtras(runner.runnerDir), contractFlag, candidateFieldFlag)
      candidateField = resolved.field
      // run-gepa overwrites a colliding key too (`{**source_row, field: ...}`,
      // runner.py:449-458), but the CUSTOMER'S ORIGINAL run never did: their
      // metric read the row's own value. Injecting over it hands both sides the
      // candidate, they agree, and the agreement says nothing about the run being
      // migrated. Refuse and make the operator pick a free field.
      const collision = sample.find(entry => Object.prototype.hasOwnProperty.call(entry.row, candidateField))
      if (collision) {
        throw new Error(
          `Dataset row ${collision.id} already has a '${candidateField}' field, so injecting the candidate ` +
          'there would replace a value the original metric reads. run-gepa overwrites it silently, but the ' +
          "customer's own run never did, so parity proven this way would be meaningless. Pass " +
          '--scorer-candidate-field <a row field that does not exist> (and the same value to run-gepa).'
        )
      }
    } catch (error) {
      return fail(messageOf(error))
    }

    for (const entry of sample) {
      const candidate = outputs.byRowId.get(entry.id)!
      const tempDir = mkdtempSync(join(tmpdir(), 'orizu-parity-runner-'))
      const inputPath = join(tempDir, 'input.json')
      const outputPath = join(tempDir, 'output.json')
      try {
        writeFileSync(inputPath, JSON.stringify(flatRowInput(context, entry, candidate, candidateField)))
        const result = spawnSync(manifest.command[0]!, manifest.command.slice(1), {
          cwd: runner.runnerDir,
          env: io.runnerSubprocessEnv(inputPath, outputPath),
          encoding: 'utf8',
          maxBuffer: io.maxOutputBytes,
          timeout: io.timeoutMs,
        })
        if (result.error) throw result.error
        if (result.status !== 0) {
          throw new Error(`runner exited with code ${result.status}: ${(result.stderr || result.stdout || '').slice(0, 500)}`)
        }
        if (statSync(outputPath).size > io.maxOutputBytes) throw new Error('runner output.json exceeds the output size limit')
        const runnerOutput = JSON.parse(readFileSync(outputPath, 'utf8')) as unknown
        // `run_file_contract_runner` preserves output.json `error` as
        // RunnerCallResult.error and run-gepa records it on the RowEvaluation, so a
        // seed answering `{score, error}` on every row is rejected as an all-error
        // scorer. Accepting the score here would certify exactly that scorer.
        const reportedError = isRecord(runnerOutput) ? runnerOutput.error : undefined
        if (typeof reportedError === 'string' && reportedError.trim() !== '') {
          throw new Error(`runner reported an error alongside its score: ${reportedError}`)
        }
        const extracted = extractParityScore(runnerOutput, 'Runner output.json')
        orizuScores.set(entry.id, extracted)
        if (extracted.raw !== extracted.score) clamped.push({ row_id: entry.id, side: 'orizu', raw: extracted.raw, score: extracted.score })
      } catch (error) {
        errors.push({ row_id: entry.id, side: 'orizu', message: messageOf(error) })
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    }
  } finally {
    runner.cleanup()
  }

  const bridgeDir = mkdtempSync(join(tmpdir(), 'orizu-parity-bridge-'))
  const originalScores = new Map<string, ExtractedScore>()
  try {
    const bridgePath = join(bridgeDir, 'orizu_parity_bridge.py')
    const bridgeInput = join(bridgeDir, 'input.json')
    const bridgeOutput = join(bridgeDir, 'output.json')
    writeFileSync(bridgePath, io.bridgeSource ?? PARITY_BRIDGE_SOURCE)
    writeFileSync(bridgeInput, JSON.stringify({
      rows: sample.map(entry => {
        const candidate = outputs.byRowId.get(entry.id)!
        return { row_id: entry.id, row: { ...entry.row, [candidateField]: candidate, candidate_error: null }, model_output: candidate }
      }),
    }))
    // The customer's full environment, inherited UNSCRUBBED: it is their
    // metric in their process, exactly as their own script would run it.
    // (The runner side stays scrubbed by runnerSubprocessEnv.)
    const budget = bridgeBudget(io.timeoutMs, io.maxOutputBytes, sample.length)
    const result = spawnSync(python, [bridgePath], {
      cwd: process.cwd(),
      env: { ...process.env, ORIZU_PARITY_INPUT_PATH: bridgeInput, ORIZU_PARITY_OUTPUT_PATH: bridgeOutput, ORIZU_PARITY_ORIGINAL: original },
      encoding: 'utf8',
      maxBuffer: budget.maxOutputBytes,
      timeout: budget.timeoutMs,
    })
    if (result.error) return fail(`Failed to run the original metric with '${python}': ${messageOf(result.error)}`)
    if (result.status !== 0) {
      return fail(`The original metric could not run: ${(result.stderr || result.stdout || '').trim().slice(0, 1000)}`)
    }
    let bridgeScores: unknown
    try {
      bridgeScores = (JSON.parse(readFileSync(bridgeOutput, 'utf8')) as { scores?: unknown }).scores
    } catch (error) {
      return fail(`The original metric produced no readable result: ${messageOf(error)}`)
    }
    if (!Array.isArray(bridgeScores)) return fail('The original metric produced no scores array')

    for (const item of bridgeScores) {
      if (!isRecord(item) || typeof item.row_id !== 'string') {
        errors.push({ row_id: null, side: 'original', message: 'original result entry has no string row_id' })
        continue
      }
      if (!sampleIds.has(item.row_id)) {
        errors.push({ row_id: item.row_id, side: 'original', message: `original scored row_id ${item.row_id}, which is not in the sample` })
        continue
      }
      if (typeof item.error === 'string') {
        errors.push({ row_id: item.row_id, side: 'original', message: sanitizeTerminalText(item.error) })
        continue
      }
      try {
        const extracted = extractParityScore({ score: item.score }, `Original metric result for row ${item.row_id}`)
        originalScores.set(item.row_id, extracted)
        if (extracted.raw !== extracted.score) clamped.push({ row_id: item.row_id, side: 'original', raw: extracted.raw, score: extracted.score })
      } catch (error) {
        errors.push({ row_id: item.row_id, side: 'original', message: messageOf(error) })
      }
    }
  } finally {
    rmSync(bridgeDir, { recursive: true, force: true })
  }

  // Pairing is by row_id on BOTH sides, never positional: the bridge is a
  // separate process whose result order is not this loop's order.
  let compared = 0
  for (const entry of sample) {
    const orizu = orizuScores.get(entry.id)
    const originalScore = originalScores.get(entry.id)
    if (!orizu) continue
    if (!originalScore) {
      if (!errors.some(item => item.row_id === entry.id && item.side === 'original')) {
        errors.push({ row_id: entry.id, side: 'original', message: 'the original metric returned no score for this row' })
      }
      continue
    }
    compared += 1
    if (Math.abs(orizu.score - originalScore.score) > tolerance) {
      mismatches.push({ row_id: entry.id, orizu: orizu.score, original: originalScore.score })
    }
  }

  // `compared >= 1` is NOT a conjunct here: the empty-split refusal guarantees
  // sample.length >= 1 and every row that fails to pair pushes an error, so
  // `compared === 0` already implies `errors.length > 0`. No test can reach a
  // zero-compared, zero-error state, so asserting it would be an unkillable check.
  const clean = mismatches.length === 0 && errors.length === 0
  const total = context.rows.length
  // A limited run never looked at rows compared+1..total, so a mismatch there is
  // indistinguishable from a proof unless the two results are named differently.
  const parity = clean && compared === total
  if (io.json) {
    io.print(JSON.stringify({
      parity, compared, scope: { compared, total }, mismatches, errors, tolerance, clamped,
      scorer_input_contract: resolved?.contract ?? null,
      candidate_output_field: resolved?.field ?? null,
    }))
  } else {
    io.print(parity
      ? `Parity proven on all ${total} rows (tolerance ${tolerance}).`
      : clean
        ? `Smoke check passed on ${compared} of ${total} rows — rerun without --limit to prove parity.`
        : `Parity NOT proven: ${compared} of ${total} rows compared, ${mismatches.length} mismatches, ${errors.length} errors (tolerance ${tolerance}).`)
    for (const item of mismatches) io.print(`mismatch ${sanitizeTerminalText(item.row_id)}: orizu ${item.orizu} vs original ${item.original}`)
    for (const item of errors) io.print(`error ${sanitizeTerminalText(item.row_id ?? '-')} (${item.side}): ${item.message}`)
    for (const item of clamped) io.print(`clamped ${sanitizeTerminalText(item.row_id)} (${item.side}): raw ${item.raw} -> ${item.score}`)
  }
  // Exit 0 covers a clean full proof AND a clean smoke check; the report is what
  // distinguishes them, so a limited run cannot be mistaken for a proof by a
  // reader while still being usable as a fast pre-flight. Exit 2 is reserved for
  // the fail() paths above — checks that could not run at all.
  return clean ? 0 : 1
}
