import { Effect, Either, Schedule } from 'effect'
import { writeFileSync } from 'node:fs'
import { datasetTransferTimeoutMs } from './dataset-transfer-policy.js'
import { authedFetch } from './http.js'

class DownloadHttpError extends Error {
  readonly _tag = 'DownloadHttpError'
  constructor(readonly status: number, detail: string) {
    super(`Download failed (HTTP ${status}): ${detail}`)
  }
}

class DownloadTransportError extends Error {
  readonly _tag = 'DownloadTransportError'
  constructor(cause: unknown) {
    super('Dataset download transport failed', { cause })
  }
}

export async function transferDatasetDownload(datasetId: string, format: string, filename: string): Promise<void> {
  const timeoutMs = datasetTransferTimeoutMs()
  const download = Effect.tryPromise({
    try: async signal => {
      const response = await authedFetch(`/api/cli/datasets/${encodeURIComponent(datasetId)}/download?format=${encodeURIComponent(format)}`, { signal })
      if (!response.ok) throw new DownloadHttpError(response.status, await response.text())
      return new Uint8Array(await response.arrayBuffer())
    },
    catch: cause => {
      if (cause instanceof TypeError) return new DownloadTransportError(cause)
      return cause instanceof Error ? cause : new Error('Dataset download request failed', { cause })
    },
  }).pipe(Effect.timeoutFail({
    duration: timeoutMs,
    onTimeout: () => new Error('DATASET_TRANSFER_TIMEOUT: Dataset download exceeded its deadline'),
  }), Effect.retry({
    times: 2,
    schedule: Schedule.spaced(100),
    while: error => error instanceof DownloadTransportError || (error instanceof DownloadHttpError && [429, 502, 503, 504].includes(error.status)),
  }))
  const fileError = (cause: unknown) => new Error(`DATASET_DOWNLOAD_FILE: Could not save dataset to ${filename}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
  const write = (bytes: Uint8Array) => Effect.try({
    // Wait for the complete response, then retain the CLI's existing in-place
    // write semantics, including inode metadata, hardlinks and symlink targets.
    try: () => writeFileSync(filename, bytes, { mode: 0o600 }),
    catch: fileError,
  })
  const controller = new AbortController()
  const handleInterrupt = () => controller.abort()
  process.once('SIGINT', handleInterrupt)
  process.once('SIGTERM', handleInterrupt)
  try {
    const result = await Effect.runPromise(Effect.either(Effect.flatMap(download, write)), { signal: controller.signal })
    if (Either.isLeft(result)) throw result.left
  } catch (error) {
    if (controller.signal.aborted) throw new Error('DATASET_TRANSFER_INTERRUPTED: Dataset download cancelled')
    throw error
  } finally {
    process.removeListener('SIGINT', handleInterrupt)
    process.removeListener('SIGTERM', handleInterrupt)
  }
}
