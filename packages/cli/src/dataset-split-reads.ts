import { Effect, Result, Schema } from 'effect'
import { writeFileSync } from 'node:fs'

import { authedFetch } from './http.js'
import { extractErrorMessage } from './error-response.js'
import { datasetTransferTimeoutMs } from './dataset-transfer-policy.js'

const SplitExport = Schema.Struct({
  split_set_id: Schema.String, dataset_version_id: Schema.String,
  name: Schema.String, strategy: Schema.String, seed: Schema.NullOr(Schema.Number), metadata: Schema.Unknown,
  partitions: Schema.Array(Schema.Struct({ name: Schema.String, row_ids: Schema.Array(Schema.String), metadata: Schema.Unknown })),
})
const SplitList = Schema.Struct({
  dataset_version_id: Schema.String,
  split_sets: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, strategy: Schema.String, seed: Schema.NullOr(Schema.Number), partitions: Schema.Array(Schema.Struct({ name: Schema.String, row_count: Schema.Number })) })),
})

async function read<A>(path: string, decode: (value: unknown) => A): Promise<A> {
  const result = await Effect.runPromise(Effect.result(Effect.tryPromise({
    try: async signal => {
      const response = await authedFetch(path, { signal })
      if (!response.ok) throw new Error(await extractErrorMessage(response))
      try { return decode(await response.json()) } catch (cause) { throw new Error('Dataset split response is incomplete or unreadable', { cause }) }
    }, catch: cause => cause instanceof Error ? cause : new Error('Dataset split read failed', { cause }),
  }).pipe(Effect.timeoutOrElse({ duration: datasetTransferTimeoutMs(), orElse: () => Effect.fail(new Error('Dataset split read exceeded its deadline')) }))))
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

export function listDatasetSplits(versionId: string) { return read(`/api/cli/dataset-versions/${encodeURIComponent(versionId)}/split-sets`, Schema.decodeUnknownSync(SplitList)) }
export function showDatasetSplit(setId: string) { return read(`/api/cli/split-sets/${encodeURIComponent(setId)}`, Schema.decodeUnknownSync(SplitExport)) }

export async function downloadPinnedDatasetSplit(versionId: string, setId: string, split: string, format: string, filename: string) {
  const query = new URLSearchParams({ split_set: setId, split, format })
  const result = await Effect.runPromise(Effect.result(Effect.tryPromise({
    try: async signal => {
      const response = await authedFetch(`/api/cli/dataset-versions/${encodeURIComponent(versionId)}/download?${query}`, { signal })
      if (!response.ok) throw new Error(`Download failed: ${await extractErrorMessage(response)}`)
      return new Uint8Array(await response.arrayBuffer())
    }, catch: cause => cause instanceof Error ? cause : new Error('Dataset split download failed', { cause }),
  }).pipe(Effect.timeoutOrElse({ duration: datasetTransferTimeoutMs(), orElse: () => Effect.fail(new Error('Dataset split download exceeded its deadline')) }), Effect.flatMap(bytes => Effect.try({ try: () => writeFileSync(filename, bytes, { mode: 0o600 }), catch: cause => new Error('Could not save dataset split download', { cause }) })))))
  if (Result.isFailure(result)) throw result.failure
}
