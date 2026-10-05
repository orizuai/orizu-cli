import { statSync } from 'node:fs'
import { extname } from 'node:path'

import { Context, Effect, Result, Schema } from 'effect'

import { parseDatasetFile } from './file-parser.js'
import { datasetTransferTimeoutMs } from './dataset-transfer-policy.js'
import { authedFetch } from './http.js'
import { streamJsonlRowChunks } from './jsonl-stream.js'
import { sanitizeTerminalText } from './json-response.js'

type Rows = ReadonlyArray<Readonly<Record<string, unknown>>>
export interface DatasetAppendInput {
  datasetId: string
  file: string
}
interface AppendIo {
  json: boolean
  print: (message: string) => void
}
type Outcome = 'rejected' | 'unknown' | 'not_sent'
interface FailedChunk { index: number; inputRows: number; outcome: Outcome }
interface Progress {
  datasetId: string | null
  confirmedRows: number
  confirmedChunks: number
  chunk: FailedChunk | null
}
class AppendFailure extends Error {
  readonly _tag = 'AppendFailure'
  constructor(message: string, readonly outcome: Outcome) { super(sanitizeTerminalText(message)) }
}

const Acknowledgement = Schema.Struct({
  dataset: Schema.Struct({ id: Schema.String, name: Schema.String, rowCount: Schema.Natural }),
  appendedCount: Schema.Natural,
})
type Acknowledgement = typeof Acknowledgement.Type
const RowsSchema = Schema.Array(Schema.Record(Schema.String, Schema.Unknown))
const appendTransport = Context.Service<{
  append: (datasetId: string, rows: Rows) => Effect.Effect<Acknowledgement, AppendFailure>
}>('orizu/cli/DatasetAppendTransport')

// Only responses naming an existing rows-route rejection establish a known
// refusal. A proxy body or a lost body is not evidence that nothing committed.
function isKnownRefusal(message: string, status: number): boolean {
  // These exact templates come from artifact preparation before the append RPC.
  // Status alone or an arbitrary artifact/proxy prefix cannot prove rejection.
  if (status === 400 && (
    message === 'Dataset row id cannot be stored as an artifact' ||
    /^Invalid dataset row artifact reference at .+$/.test(message) ||
    /^Dataset row artifact ref at .+ (?:is nested; v1 supports top-level fields only|was not issued by this server|belongs to a different project|has been deleted|has not been finalized|is expired|was issued to a different user|is not attachable|does not match server metadata|targets a different (?:dataset|field|row id))$/.test(message)
  )) return true
  if (status === 413 && (
    /^Dataset row .+ exceeds 65536 bytes after externalizing top-level fields$/.test(message) ||
    /^.+ exceeds (?:26214400 bytes before compression|10485760 bytes after compression)$/.test(message)
  )) return true
  return /^(Missing bearer token|Unauthorized|Dataset not found|Only project curators\/admins can modify dataset rows|Dataset is locked and cannot be mutated|Duplicate row ids provided|One or more row ids already exist in this dataset|rows must contain at least one item|rows\[\d+\] must be an object|Dataset row is too large|Each row in p_rows must)/.test(message)
}

function liveTransport(timeoutMs: number, commandSignal: AbortSignal, progress: Progress) {
  return {
    append: (datasetId: string, rows: Rows) => Effect.suspend(() => {
      let admitted = false
      let timedOut = false
      const attempt = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      return Effect.tryPromise({
        try: async signal => {
          const abortFromEffect = () => attempt.abort(signal.reason)
          const abortFromCommand = () => attempt.abort(commandSignal.reason)
          try {
            // Node 20.0 has no AbortSignal.any. This attempt owns both links
            // and the physical fetch/body signal until its receipt is consumed.
            if (signal.aborted) abortFromEffect()
            else signal.addEventListener('abort', abortFromEffect, { once: true })
            if (commandSignal.aborted) abortFromCommand()
            else commandSignal.addEventListener('abort', abortFromCommand, { once: true })
            const response = await authedFetch(`/api/cli/datasets/${encodeURIComponent(datasetId)}/rows`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ rows }), signal: attempt.signal,
            }, () => {
              admitted = true
              if (progress.chunk) progress.chunk.outcome = 'unknown'
              if (timer) clearTimeout(timer)
              timer = setTimeout(() => { timedOut = true; attempt.abort() }, timeoutMs)
            })
            // The single admitted-attempt deadline includes the complete body.
            const text = await response.text()
            let value: unknown
            try { value = JSON.parse(text) } catch { throw new AppendFailure('Append returned an invalid acknowledgement', 'unknown') }
            if (!response.ok) {
              const message = value && typeof value === 'object' && 'error' in value && typeof value.error === 'string' ? value.error : ''
              const known = response.status >= 400 && response.status < 500 && isKnownRefusal(message, response.status)
              throw new AppendFailure(message ? `Append failed: ${message}` : 'Append failed', known ? 'rejected' : 'unknown')
            }
            const result = Schema.decodeUnknownResult(Acknowledgement)(value)
            if (Result.isFailure(result) || result.success.dataset.id.toLowerCase() !== datasetId.toLowerCase() || result.success.appendedCount !== rows.length) throw new AppendFailure('Append returned an invalid acknowledgement', 'unknown')
            return result.success
          } finally {
            if (timer) clearTimeout(timer)
            signal.removeEventListener('abort', abortFromEffect)
            commandSignal.removeEventListener('abort', abortFromCommand)
            attempt.abort()
          }
        },
        catch: cause => cause instanceof AppendFailure ? cause : new AppendFailure(
          timedOut ? 'DATASET_TRANSFER_TIMEOUT: Dataset append exceeded its deadline' : admitted ? 'fetch failed' : cause instanceof Error ? cause.message : 'Append failed before the request was sent',
          admitted ? 'unknown' : 'not_sent',
        ),
      })
    }),
  }
}

function recovery(progress: Progress): string {
  if (progress.chunk?.outcome === 'unknown') return 'This chunk may already be committed. Inspect the dataset and reconcile its rows before rerunning; do not blindly repeat this write.'
  if (progress.confirmedRows > 0) return 'Earlier acknowledged rows remain appended. Inspect the confirmed source prefix before retrying the remaining input.'
  return 'Resolve the reported error before rerunning the command.'
}

function appendProgram(input: DatasetAppendInput, timeoutMs: number, progress: Progress, io: AppendIo, signal: AbortSignal) {
  return Effect.gen(function*() {
    const rows = yield* Effect.try({
      try: () => {
        if (extname(input.file).toLowerCase() === '.jsonl') return undefined
        let bytes: number
        try { bytes = statSync(input.file).size } catch (cause) {
          const error = cause as NodeJS.ErrnoException
          if (error.code === 'ENOENT') throw new Error(`File not found: ${input.file}. Check the path and filename, then retry.`)
          if (error.code === 'EPERM' || error.code === 'EACCES') throw new Error(`Cannot read file: ${input.file}. Grant folder permission to your terminal app and retry.`)
          throw new Error(`Failed to access file ${input.file}: ${error.message}`)
        }
        if (bytes > 50 * 1024 * 1024) throw new Error(`Input file is ${(bytes / (1024 * 1024)).toFixed(1)} MB, which exceeds the 50 MB limit. Split the file into smaller parts and append each separately.`)
        const parsed = parseDatasetFile(input.file).rows
        if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('Dataset append file must contain at least one row')
        return parsed
      },
      catch: cause => new AppendFailure(cause instanceof Error ? cause.message : 'Could not read append input', 'not_sent'),
    })
    const source = yield* Effect.acquireRelease(
      Effect.sync(() => rows ? (async function*() {
        for (let offset = 0; offset < rows.length; offset += 500) yield rows.slice(offset, offset + 500)
      })() : streamJsonlRowChunks(input.file, { signal })),
      iterator => Effect.promise(async () => { await iterator.return(undefined) }),
    )
    const transport = liveTransport(timeoutMs, signal, progress)
    let acknowledgement: Acknowledgement | undefined
    let index = 0
    while (true) {
      const next = yield* Effect.tryPromise({ try: () => source.next(), catch: cause => new AppendFailure(cause instanceof Error ? cause.message : 'Could not read append input', 'not_sent') })
      if (next.done) break
      index++
      progress.chunk = { index, inputRows: next.value.length, outcome: 'not_sent' }
      const rows = yield* Schema.decodeUnknownEffect(RowsSchema)(next.value).pipe(Effect.mapError(() => new AppendFailure('Dataset rows must be JSON objects', 'not_sent')))
      if (!io.json) yield* Effect.sync(() => io.print(`Uploading chunk ${index} (${rows.length} rows)...`))
      acknowledgement = yield* appendTransport.use(api => api.append(input.datasetId, rows)).pipe(Effect.provideService(appendTransport, transport))
      progress.confirmedRows += acknowledgement.appendedCount
      progress.confirmedChunks++
      progress.chunk = null
    }
    if (!acknowledgement) return yield* Effect.fail(new AppendFailure('Dataset append file must contain at least one row', 'not_sent'))
    return { dataset: acknowledgement.dataset, appendedCount: progress.confirmedRows }
  }).pipe(Effect.scoped)
}

/** Owns standalone append's source, admitted writes, progress and recovery. */
export async function appendDatasetWorkflow(resolveInput: () => Promise<DatasetAppendInput>, io: AppendIo): Promise<number> {
  const controller = new AbortController()
  const progress: Progress = { datasetId: null, confirmedRows: 0, confirmedChunks: 0, chunk: null }
  let interrupted: 130 | 143 | undefined
  const interrupt = () => { interrupted = 130; controller.abort() }
  const terminate = () => { interrupted = 143; controller.abort() }
  const program = Effect.gen(function*() {
    const timeoutMs = yield* Effect.try({ try: datasetTransferTimeoutMs, catch: cause => new AppendFailure(cause instanceof Error ? cause.message : 'Invalid append configuration', 'not_sent') })
    const input = yield* Effect.tryPromise({ try: resolveInput, catch: cause => new AppendFailure(cause instanceof Error ? cause.message : 'Could not resolve append input', 'not_sent') })
    progress.datasetId = input.datasetId
    // Retained interactive selection does not accept a signal. Preserve
    // natural Node termination until we own cancellable source/transport work.
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => { process.once('SIGINT', interrupt); process.once('SIGTERM', terminate) }),
      () => appendProgram(input, timeoutMs, progress, io, controller.signal),
      () => Effect.sync(() => { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate) }),
    )
  })
  const report = (message: string) => {
    const error = sanitizeTerminalText(message)
    const advice = recovery(progress)
    io.print(io.json ? JSON.stringify({ error, datasetId: progress.datasetId, confirmedRows: progress.confirmedRows, confirmedChunks: progress.confirmedChunks, failedChunk: progress.chunk, recovery: advice })
      : `${error}\n${progress.confirmedRows} rows from ${progress.confirmedChunks} chunk(s) were already appended. ${advice}`)
  }
  try {
    const result = await Effect.runPromise(Effect.result(program), { signal: controller.signal })
    if (Result.isFailure(result)) {
      if (progress.chunk) progress.chunk.outcome = result.failure.outcome
      report(result.failure.message)
      return 1
    }
    io.print(io.json ? JSON.stringify(result.success) : `Appended ${result.success.appendedCount} rows to dataset ${sanitizeTerminalText(result.success.dataset.name)} (${sanitizeTerminalText(result.success.dataset.id)}). New row count: ${result.success.dataset.rowCount}`)
    return 0
  } catch {
    report(interrupted ? 'Dataset append interrupted' : 'Dataset append failed')
    return interrupted ?? 1
  }
}
