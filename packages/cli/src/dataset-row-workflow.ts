import { Cause, Effect, Exit, Result, Schema } from 'effect'

import { datasetTransferTimeoutMs } from './dataset-transfer-policy.js'
import { extractErrorMessage } from './error-response.js'
import { parseDatasetFile } from './file-parser.js'
import { authedFetch } from './http.js'
import { parseJsonResponse } from './json-response.js'

// Loaded only through `await import(...)` from dataset-commands, like append.

const MAX_REQUEST_BYTES = 3 * 1024 * 1024
const MAX_CHUNK_ROWS = 10
const EMPTY_REQUEST_BYTES = Buffer.byteLength('{"rows":[]}', 'utf8')

type DatasetRowEdit = Record<string, unknown> & { id: string }

// 'rejected': the server answered with a refusal, so nothing was written.
// 'unknown': the request was sent but no trustworthy answer came back.
type Outcome = 'rejected' | 'unknown' | 'not_sent'
class RowsRequestFailure extends Error {
  readonly _tag = 'RowsRequestFailure'
  constructor(message: string, readonly outcome: Outcome) { super(message) }
}

const Dataset = Schema.Struct({ id: Schema.String, name: Schema.String, rowCount: Schema.Number })
const EditAcknowledgement = Schema.Struct({ dataset: Dataset, updatedCount: Schema.Number })
type EditAcknowledgement = typeof EditAcknowledgement.Type

export interface DatasetRowsOptions {
  datasetId: string
  json: boolean
  printJson: (value: Record<string, unknown>) => void
  printLine: (value: string) => void
  sanitize: (value: string) => string
}

function normalizeRows(rows: Array<Record<string, unknown>>): DatasetRowEdit[] {
  if (rows.length === 0) {
    throw new Error('Dataset edit file must contain at least one row')
  }

  const seenRowIds = new Set<string>()
  return rows.map((row, index) => {
    const rowId = typeof row.id === 'string' ? row.id.trim() : ''
    if (!rowId) {
      throw new Error(`Dataset edit file rows[${index}] must include a non-empty string id`)
    }
    if (seenRowIds.has(rowId)) {
      throw new Error(`Dataset edit file rows[${index}].id duplicates a previous row id`)
    }
    seenRowIds.add(rowId)
    return { ...row, id: rowId }
  })
}

function chunkRows(rows: DatasetRowEdit[], sanitize: (value: string) => string): DatasetRowEdit[][] {
  const chunks: DatasetRowEdit[][] = []
  let currentChunk: DatasetRowEdit[] = []
  let currentBytes = EMPTY_REQUEST_BYTES

  for (const row of rows) {
    const rowBytes = Buffer.byteLength(JSON.stringify(row), 'utf8')
    const framedRowBytes = rowBytes + (currentChunk.length > 0 ? 1 : 0)
    if (
      currentChunk.length > 0 &&
      (currentChunk.length >= MAX_CHUNK_ROWS || currentBytes + framedRowBytes > MAX_REQUEST_BYTES)
    ) {
      chunks.push(currentChunk)
      currentChunk = []
      currentBytes = EMPTY_REQUEST_BYTES
    }

    const singleRowRequestBytes = EMPTY_REQUEST_BYTES + rowBytes
    if (singleRowRequestBytes > MAX_REQUEST_BYTES) {
      throw new Error(
        `Dataset edit row ${sanitize(row.id)} is ${singleRowRequestBytes} bytes, ` +
        `which exceeds the ${MAX_REQUEST_BYTES}-byte edit request limit`
      )
    }

    currentChunk.push(row)
    currentBytes += rowBytes + (currentChunk.length > 1 ? 1 : 0)
  }

  if (currentChunk.length > 0) chunks.push(currentChunk)
  return chunks
}

// One rows request with a deadline that covers the whole reply. A deadline,
// a lost connection or a broken reply after sending is an unknown outcome.
function rowsRequest<A>(
  datasetId: string,
  method: 'PATCH' | 'DELETE',
  body: unknown,
  label: string,
  timeoutMs: number,
  read: (response: Response) => Promise<A>,
) {
  return Effect.suspend(() => {
    let sent = false
    let timedOut = false
    return Effect.tryPromise({
      try: async signal => {
        const request = new AbortController()
        const abort = () => request.abort()
        const timer = setTimeout(() => { timedOut = true; request.abort() }, timeoutMs)
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
        try {
          const response = await authedFetch(`/api/cli/datasets/${encodeURIComponent(datasetId)}/rows`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: request.signal,
          }, () => { sent = true })
          return await read(response)
        } finally {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          request.abort()
        }
      },
      catch: cause => {
        if (timedOut) {
          return sent
            ? new RowsRequestFailure(`DATASET_TRANSFER_TIMEOUT: ${label} exceeded its deadline`, 'unknown')
            : new RowsRequestFailure(`DATASET_TRANSFER_TIMEOUT: ${label} exceeded its deadline before the request was sent`, 'not_sent')
        }
        if (cause instanceof RowsRequestFailure) return cause
        return new RowsRequestFailure(cause instanceof Error ? cause.message : String(cause), sent ? 'unknown' : 'not_sent')
      },
    })
  })
}

function refusalOutcome(status: number): Outcome {
  return status >= 400 && status < 500 ? 'rejected' : 'unknown'
}

function editProgram(options: DatasetRowsOptions & { file: string }, timeoutMs: number) {
  return Effect.gen(function*() {
    const chunks = yield* Effect.try({
      try: () => chunkRows(normalizeRows(parseDatasetFile(options.file).rows), options.sanitize),
      catch: cause => cause,
    })
    let totalUpdated = 0
    // normalizeRows refuses an empty file, so the loop always sets this.
    let lastResult!: EditAcknowledgement

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]
      if (!options.json && chunks.length > 1) {
        options.printLine(`Updating chunk ${index + 1}/${chunks.length} (${chunk.length} rows)...`)
      }
      const acknowledged = yield* Effect.result(rowsRequest(options.datasetId, 'PATCH', { rows: chunk }, 'Dataset row edit', timeoutMs, async response => {
        if (!response.ok) {
          throw new RowsRequestFailure(`HTTP ${response.status}: ${await extractErrorMessage(response)}`, refusalOutcome(response.status))
        }
        const data: unknown = await response.json()
        const decoded = Schema.decodeUnknownResult(EditAcknowledgement)(data)
        if (Result.isFailure(decoded)) {
          throw new RowsRequestFailure(`Server returned an unreadable acknowledgement for a ${chunk.length}-row chunk`, 'unknown')
        }
        if (!Number.isInteger(decoded.success.updatedCount) || decoded.success.updatedCount !== chunk.length) {
          throw new RowsRequestFailure(`Server reported ${String(decoded.success.updatedCount)} updated rows for a ${chunk.length}-row chunk`, 'unknown')
        }
        return decoded.success
      }))
      if (Result.isFailure(acknowledged)) {
        const { message, outcome } = acknowledged.failure
        const advice = outcome === 'unknown'
          ? 'This chunk may already be applied: check these rows in the dataset before retrying.'
          : 'Retry with a file containing only the remaining row edits.'
        return yield* Effect.fail(new Error(
          `Chunk ${index + 1}/${chunks.length} failed: ${message}\n` +
          `${totalUpdated} rows from ${index} chunk(s) were already updated. ${advice}`
        ))
      }
      totalUpdated += acknowledged.success.updatedCount
      lastResult = acknowledged.success
    }

    if (options.json) {
      options.printJson({ dataset: lastResult.dataset, updatedCount: totalUpdated })
      return
    }
    options.printLine(
      `Updated ${totalUpdated} rows in dataset ${options.sanitize(lastResult.dataset.name)} ` +
      `(${options.sanitize(lastResult.dataset.id)}). Current row count: ${lastResult.dataset.rowCount}`
    )
  })
}

function deleteProgram(options: DatasetRowsOptions & { rowIds: string[] }, timeoutMs: number) {
  return Effect.gen(function*() {
    const deleted = yield* rowsRequest(options.datasetId, 'DELETE', { rowIds: options.rowIds }, 'Dataset row removal', timeoutMs, async response => {
      if (!response.ok) {
        throw new RowsRequestFailure(await response.text(), refusalOutcome(response.status))
      }
      return parseJsonResponse<{
        dataset: { id: string; name: string; rowCount: number }
        deletedCount: number
      }>(response, 'Dataset delete rows')
    }).pipe(Effect.mapError(({ message, outcome }) => new Error(
      `Delete rows failed: ${message}` +
      (outcome === 'unknown' ? '\nThe rows may already be removed: check the dataset before retrying.' : '')
    )))
    if (options.json) {
      options.printJson({ dataset: deleted.dataset, deletedCount: deleted.deletedCount })
      return
    }
    options.printLine(
      `Deleted ${deleted.deletedCount} rows from dataset ${options.sanitize(deleted.dataset.name)} (${options.sanitize(deleted.dataset.id)}). New row count: ${deleted.dataset.rowCount}`
    )
  })
}

// Ctrl-C or SIGTERM aborts the request in flight. Returns the exit code for
// an interruption; other failures throw their original error.
async function runRowsCommand(name: string, program: (timeoutMs: number) => Effect.Effect<void, unknown>): Promise<0 | 130 | 143> {
  const timeoutMs = datasetTransferTimeoutMs()
  const controller = new AbortController()
  let interrupted: 130 | 143 | undefined
  const interrupt = () => { interrupted ??= 130; controller.abort() }
  const terminate = () => { interrupted ??= 143; controller.abort() }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  try {
    const exit = await Effect.runPromiseExit(program(timeoutMs), { signal: controller.signal })
    if (interrupted !== undefined) {
      process.stderr.write(`${name} interrupted. The request in flight may already be applied: check the dataset before retrying.\n`)
      return interrupted
    }
    if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
    return 0
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', terminate)
  }
}

export function editDatasetRows(options: DatasetRowsOptions & { file: string }): Promise<0 | 130 | 143> {
  return runRowsCommand('Dataset row edit', timeoutMs => editProgram(options, timeoutMs))
}

export function deleteDatasetRows(options: DatasetRowsOptions & { rowIds: string[] }): Promise<0 | 130 | 143> {
  return runRowsCommand('Dataset row removal', timeoutMs => deleteProgram(options, timeoutMs))
}
