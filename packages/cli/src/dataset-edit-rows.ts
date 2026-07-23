import { extractErrorMessage } from './error-response.js'
import { parseDatasetFile } from './file-parser.js'
import { authedFetch } from './http.js'

const MAX_REQUEST_BYTES = 3 * 1024 * 1024
const MAX_CHUNK_ROWS = 10
const EMPTY_REQUEST_BYTES = Buffer.byteLength('{"rows":[]}', 'utf8')

type DatasetRowEdit = Record<string, unknown> & { id: string }

type EditRowsResponse = {
  dataset: { id: string; name: string; rowCount: number }
  updatedCount: number
}

export interface DatasetEditRowsOptions {
  datasetId: string
  file: string
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

export async function editDatasetRows(options: DatasetEditRowsOptions): Promise<void> {
  const { rows } = parseDatasetFile(options.file)
  const chunks = chunkRows(normalizeRows(rows), options.sanitize)
  let totalUpdated = 0
  let lastResult: EditRowsResponse | null = null

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]
    if (!options.json && chunks.length > 1) {
      options.printLine(`Updating chunk ${index + 1}/${chunks.length} (${chunk.length} rows)...`)
    }

    try {
      const response = await authedFetch(`/api/cli/datasets/${encodeURIComponent(options.datasetId)}/rows`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: chunk }),
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await extractErrorMessage(response)}`)
      }

      const data = await response.json() as EditRowsResponse
      if (!Number.isInteger(data.updatedCount) || data.updatedCount !== chunk.length) {
        throw new Error(`Server reported ${String(data.updatedCount)} updated rows for a ${chunk.length}-row chunk`)
      }
      totalUpdated += data.updatedCount
      lastResult = data
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `Chunk ${index + 1}/${chunks.length} failed: ${message}\n` +
        `${totalUpdated} rows from ${index} chunk(s) were already updated. ` +
        'Retry with a file containing only the remaining row edits.'
      )
    }
  }

  if (!lastResult) throw new Error('Dataset edit file must contain at least one row')
  if (options.json) {
    options.printJson({ dataset: lastResult.dataset, updatedCount: totalUpdated })
    return
  }
  options.printLine(
    `Updated ${totalUpdated} rows in dataset ${options.sanitize(lastResult.dataset.name)} ` +
    `(${options.sanitize(lastResult.dataset.id)}). Current row count: ${lastResult.dataset.rowCount}`
  )
}
