import { Context, Effect, Either, Layer } from 'effect'

import { ensureDatasetUploadSnapshot } from './dataset-upload-snapshot.js'
import { datasetTransferTimeoutMs } from './dataset-transfer-policy.js'
import { extractErrorMessage } from './error-response.js'
import { authedFetch } from './http.js'
import { parseJsonResponse, sanitizeTerminalText } from './json-response.js'
import { streamJsonlRowChunks } from './jsonl-stream.js'

export interface DatasetUploadResponse {
  dataset: { id: string; name: string; rowCount: number; sourceType: string; url?: string }
  readmeVersion?: { id: string; version_num: number; created_at: string } | null
}

interface DatasetSnapshot { datasetVersion: { id: string } }
interface DatasetAppendResponse { dataset: { id: string; name: string; rowCount: number }; appendedCount: number }
type UploadRows = Array<Record<string, unknown>>
type UploadSource = { kind: 'jsonl'; file: string } | { kind: 'rows'; rows: UploadRows; sourceType: 'csv' | 'json' | 'jsonl' }

export interface DatasetUploadOptions {
  project: string
  name: string
  source: UploadSource
  readmeMarkdown: string | null
  json: boolean
  onChunk: (index: number, rowCount: number) => void
}

class DatasetWriteFailure extends Error {
  readonly _tag = 'DatasetWriteFailure'
  constructor(message: string, readonly outcome: 'rejected' | 'unknown', options?: ErrorOptions) {
    super(message, options)
  }
}

class DatasetInputFailure extends Error {
  readonly _tag = 'DatasetInputFailure'
  constructor(cause: unknown) { super(cause instanceof Error ? cause.message : String(cause), { cause }) }
}

interface DatasetUploadApi {
  create: (rows: UploadRows, sourceType: string) => Effect.Effect<DatasetUploadResponse, DatasetWriteFailure>
  append: (id: string, rows: UploadRows) => Effect.Effect<DatasetAppendResponse, DatasetWriteFailure>
  snapshot: (id: string) => Effect.Effect<DatasetSnapshot, DatasetWriteFailure>
}
const DatasetUploadApi = Context.GenericTag<DatasetUploadApi>('orizu/DatasetUploadApi')

// Only the existing authentication client's rejected-token refresh may replay a
// request. No transient/transport retries belong around these non-idempotent writes.
function post<T>(path: string, body: unknown, context: string, prefix: string, timeoutMs: number): Effect.Effect<T, DatasetWriteFailure> {
  return Effect.suspend(() => {
    let requestStarted = false
    return Effect.tryPromise({
      try: async signal => {
        const response = await authedFetch(path, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body), signal,
        }, () => { requestStarted = true })
        if (!response.ok) {
          throw new DatasetWriteFailure(`${prefix}: ${await extractErrorMessage(response)}`, response.status >= 500 ? 'unknown' : 'rejected')
        }
        return await parseJsonResponse<T>(response, context)
      },
      catch: cause => cause instanceof DatasetWriteFailure ? cause : new DatasetWriteFailure(
        cause instanceof Error ? cause.message : String(cause), requestStarted ? 'unknown' : 'rejected', { cause },
      ),
    }).pipe(Effect.timeoutFail({
      duration: timeoutMs,
      onTimeout: () => new DatasetWriteFailure(`DATASET_TRANSFER_TIMEOUT: ${context} exceeded its deadline`, requestStarted ? 'unknown' : 'rejected'),
    }))
  })
}

function liveUploadApi(options: DatasetUploadOptions) {
  const timeoutMs = datasetTransferTimeoutMs()
  return Layer.succeed(DatasetUploadApi, {
    create: (rows, sourceType) => post<DatasetUploadResponse>('/api/cli/datasets/upload', {
      projectSlug: options.project, name: options.name, rows, sourceType,
      ...(options.readmeMarkdown !== null ? { readmeMarkdown: options.readmeMarkdown } : {}),
    }, 'Dataset upload', 'Upload failed', timeoutMs),
    append: (id, rows) => post<DatasetAppendResponse>(`/api/cli/datasets/${encodeURIComponent(id)}/rows`, { rows }, 'Dataset append', 'Append failed', timeoutMs),
    snapshot: id => post<DatasetSnapshot>(`/api/cli/datasets/${encodeURIComponent(id)}/versions`, {}, 'Dataset version create', 'Failed to create dataset version', timeoutMs),
  })
}

async function expectedPromise<A, E>(program: Effect.Effect<A, E>): Promise<A> {
  const result = await Effect.runPromise(Effect.either(program))
  if (Either.isLeft(result)) throw result.left
  return result.right
}

function uploadProgram(options: DatasetUploadOptions) {
  return Effect.gen(function* () {
    const api = yield* DatasetUploadApi
    const chunks = yield* Effect.acquireRelease(
      Effect.sync(() => options.source.kind === 'jsonl'
        ? streamJsonlRowChunks(options.source.file)
        : (async function* () { if (options.source.kind === 'rows') yield options.source.rows })()),
      iterator => Effect.promise(async () => { await iterator.return(undefined) }),
    )
    let data: DatasetUploadResponse | undefined
    let confirmedRows = 0
    let chunkIndex = 0
    while (true) {
      const next = yield* Effect.tryPromise({ try: () => chunks.next(), catch: cause => new DatasetInputFailure(cause) }).pipe(
        Effect.mapError(error => new Error(data
          ? `Upload stopped while reading the next JSONL chunk: ${error.message}\nDataset ${sanitizeTerminalText(data.dataset.name)} (${sanitizeTerminalText(data.dataset.id)}) was created and ${confirmedRows} rows were uploaded. Fix the file, remove the first ${confirmedRows} rows, and run orizu datasets append --dataset ${data.dataset.id} --file <remaining-file>.`
          : error.message)),
      )
      if (next.done) break
      chunkIndex++
      if (options.source.kind === 'jsonl') yield* Effect.sync(() => options.onChunk(chunkIndex, next.value.length))
      const write = data
        ? api.append(data.dataset.id, next.value).pipe(Effect.map(result => ({
          data: { ...data!, dataset: { ...data!.dataset, rowCount: result.dataset.rowCount } },
          added: result.appendedCount,
        })))
        : api.create(next.value, options.source.kind === 'jsonl' ? 'jsonl' : options.source.sourceType).pipe(
          Effect.map(result => ({ data: result, added: result.dataset.rowCount })),
        )
      const result = yield* write.pipe(Effect.mapError(error => {
        if (error.outcome === 'unknown') {
          return new Error(`DATASET_UPLOAD_UNCERTAIN: Chunk ${chunkIndex} may have committed, but its outcome could not be confirmed: ${error.message}\n` +
            (data ? `Dataset ${sanitizeTerminalText(data.dataset.id)} has ${confirmedRows} confirmed uploaded rows. ` : 'Dataset creation could not be confirmed. ') +
            'Inspect the dataset and reconcile row IDs before retrying; do not replay this chunk blindly.')
        }
        return new Error(data
          ? `Chunk ${chunkIndex} failed: ${error.message}\nDataset ${sanitizeTerminalText(data.dataset.name)} (${sanitizeTerminalText(data.dataset.id)}) was created and ${confirmedRows} rows were uploaded. To retry, remove the first ${confirmedRows} rows from your file and run orizu datasets append --dataset ${data.dataset.id} --file <remaining-file>.`
          : error.message)
      }))
      data = result.data
      confirmedRows += result.added
    }
    if (!data) return yield* Effect.fail(new Error('Dataset file contains no rows'))
    const version = yield* Effect.tryPromise({
      try: () => ensureDatasetUploadSnapshot(data!.dataset, options.json, id => expectedPromise(api.snapshot(id))),
      catch: cause => cause instanceof Error ? cause : new Error(String(cause)),
    })
    return { data, version }
  })
}

export function transferDatasetUpload(options: DatasetUploadOptions): Promise<{ data: DatasetUploadResponse; version: DatasetSnapshot }> {
  return expectedPromise(uploadProgram(options).pipe(Effect.scoped, Effect.provide(liveUploadApi(options))))
}
