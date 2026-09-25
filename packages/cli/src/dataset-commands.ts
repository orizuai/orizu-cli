// ORI-2044: moved from index.ts to keep dataset commands together.

import { readFileSync, statSync, writeFileSync } from 'fs'
import { basename, extname } from 'path'
import { createInterface } from 'readline/promises'
import { stdin as input, stdout as output } from 'process'
import {
  getArg,
  expandHomePath,
  getPositionalArg,
  hasJsonFlag,
  getArchiveListStatus,
  cliArgs,
  isInteractiveTerminal,
} from './command-line-arguments.js'
import {
  resolveProjectSlug,
  fetchDatasets,
  selectDatasetInteractively,
  selectTaskIdInteractively,
} from './account-directory.js'
import { sanitizeTerminalText, parseJsonResponse } from './json-response.js'
import { authedFetch } from './http.js'
import { extractErrorMessage } from './error-response.js'
import { printJson, printLine } from './cli-console-output.js'
import { readJsonFile } from './app-commands.js'
import { printDatasetSummaries } from './archive-artifacts-cli.js'
import { formatTerminalLink } from './auth-commands.js'
import { parseDatasetFile } from './file-parser.js'
import { parseDatasetReference } from './dataset-download.js'
import { streamJsonlRowChunks } from './jsonl-stream.js'
import { editDatasetRows as runEditDatasetRows } from './dataset-edit-rows.js'
import { parseCommaSeparated } from './task-commands.js'
import type { DatasetSelection } from './account-directory.js'



const MAX_README_LENGTH = 200_000

interface DatasetVersionResponse {
  datasetVersion: {
    id: string
    rowCount: number
    artifactFormat?: string
    artifactStoragePath?: string
  }
}

function readReadmeMarkdownFromArgs(usage: string): string | null {
  const readmeFile = getArg('--readme-file')
  const readmeText = getArg('--readme-text')

  if (readmeFile !== null && readmeText !== null) {
    throw new Error(`Use either --readme-file or --readme-text, not both.\n${usage}`)
  }

  const markdown = readmeFile !== null
    ? readFileSync(expandHomePath(readmeFile), 'utf8')
    : readmeText

  if (markdown !== null && markdown.length > MAX_README_LENGTH) {
    throw new Error(`README markdown is too large. Maximum size is ${MAX_README_LENGTH} characters.`)
  }

  return markdown
}

function parseRatioFlag(name: string, fallback: number): number {
  const value = getArg(name)
  if (!value) {
    return fallback
  }

  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${name} must be a number between 0 and 1`)
  }

  return parsed
}

function parsePositiveIntegerFlag(name: string, fallback: number): number {
  const value = getArg(name)
  if (!value) {
    return fallback
  }

  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }

  return parsed
}

function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

async function resolveDatasetIdForProject(datasetRef: string, projectArg: string | null): Promise<string> {
  if (looksLikeUuid(datasetRef)) {
    return datasetRef
  }

  projectArg = projectArg || process.env.ORIZU_PROJECT || null
  if (!projectArg) {
    return datasetRef
  }

  const project = projectArg || await resolveProjectSlug(null)
  const datasets = await fetchDatasets(project)
  const matches = datasets.filter(dataset => dataset.name === datasetRef || dataset.id === datasetRef)

  if (matches.length === 0) {
    throw new Error(`Dataset '${sanitizeTerminalText(datasetRef)}' not found in ${sanitizeTerminalText(project)}`)
  }

  return matches[0].id
}

async function requestDatasetVersionSnapshot(
  datasetId: string,
  options: { versionLabel?: string | null; readmeMarkdown?: string | null } = {}
): Promise<DatasetVersionResponse> {
  const response = await authedFetch(`/api/cli/datasets/${encodeURIComponent(datasetId)}/versions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(options.versionLabel ? { versionLabel: options.versionLabel } : {}),
      ...(options.readmeMarkdown !== undefined && options.readmeMarkdown !== null
        ? { readmeMarkdown: options.readmeMarkdown }
        : {}),
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to create dataset version: ${await extractErrorMessage(response)}`)
  }

  return parseJsonResponse<DatasetVersionResponse>(response, 'Dataset version create')
}

async function createDatasetVersion() {
  const datasetId = getPositionalArg(3) || getArg('--dataset')
  const versionLabel = getArg('--label') || getArg('--version-label') || null
  const project = getArg('--project')
  const usage = 'Usage: orizu datasets versions create <datasetId|dataset-name> [--project <team/project>] [--label <label>] [--readme-file <README.md> | --readme-text <markdown>] [--json]'

  if (!datasetId) {
    throw new Error(usage)
  }

  const readmeMarkdown = readReadmeMarkdownFromArgs(usage)
  const resolvedDatasetId = await resolveDatasetIdForProject(datasetId, project)
  const data = await requestDatasetVersionSnapshot(resolvedDatasetId, {
    versionLabel,
    readmeMarkdown,
  })

  if (hasJsonFlag()) {
    printJson({
      dataset_version_id: data.datasetVersion.id,
      row_count: data.datasetVersion.rowCount,
    })
    return
  }

  const details = [
    `${data.datasetVersion.rowCount} rows`,
    data.datasetVersion.artifactFormat,
  ].filter(Boolean).join(', ')
  printLine(
    `Created dataset version ${sanitizeTerminalText(data.datasetVersion.id)}` +
    (details ? ` (${sanitizeTerminalText(details)})` : '')
  )
}

async function createDatasetSplitSet() {
  const datasetVersionId = getPositionalArg(3) || getArg('--dataset-version')
  const splitFile = getArg('--from-file')
  const splitSpec = splitFile ? readJsonFile(splitFile) : null
  const name = getArg('--name') || (typeof splitSpec?.name === 'string' ? splitSpec.name : 'default')
  const strategy = getArg('--strategy') || (typeof splitSpec?.strategy === 'string' ? splitSpec.strategy : 'random')
  const seed = splitSpec && (splitSpec.seed === null || typeof splitSpec.seed === 'number')
    ? splitSpec.seed
    : parsePositiveIntegerFlag('--seed', 1)
  const train = parseRatioFlag('--train', 0.7)
  const validation = parseRatioFlag('--validation', 0.2)
  const test = parseRatioFlag('--test', 0.1)

  if (!datasetVersionId) {
    throw new Error(
      'Usage: orizu datasets splits create <datasetVersionId> [--from-file <split.json>] [--name <name>] [--seed <n>] [--train <ratio>] [--validation <ratio>] [--test <ratio>] [--json]'
    )
  }

  const partitions = splitSpec && Array.isArray(splitSpec.partitions) ? splitSpec.partitions : undefined
  const metadata = splitSpec && typeof splitSpec.metadata === 'object' && splitSpec.metadata !== null
    ? splitSpec.metadata
    : undefined

  const response = await authedFetch(`/api/cli/dataset-versions/${encodeURIComponent(datasetVersionId)}/split-sets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      strategy,
      seed,
      train,
      validation,
      test,
      partitions,
      metadata,
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to create dataset split set: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{ splitSet: { id: string } }>(response, 'Dataset split set create')
  if (hasJsonFlag()) {
    printJson({ split_set_id: data.splitSet.id })
    return
  }

  printLine(`Created split set ${sanitizeTerminalText(data.splitSet.id)}`)
}

async function listDatasets() {
  const project = getArg('--project') || await resolveProjectSlug(null)
  const datasets = await fetchDatasets(
    project,
    getArchiveListStatus('datasets')
  )
  if (hasJsonFlag()) {
    printJson({ datasets })
    return
  }
  printDatasetSummaries(datasets, printLine)
}

async function uploadJsonlDatasetInChunks(
  file: string,
  project: string,
  datasetName: string,
  readmeMarkdown: string | null = null
) {
  const { transferDatasetUpload } = await import('./dataset-transfer-upload.js')
  const { data, version } = await transferDatasetUpload({
    project, name: datasetName, source: { kind: 'jsonl', file }, readmeMarkdown,
    json: hasJsonFlag(),
    // JSON mode reserves stderr for structured recovery failures as well.
    onChunk: (index, count) => { if (!hasJsonFlag()) printLine(`Uploading chunk ${index} (${count} rows)...`) },
  })
  const dataset = data.dataset
  if (hasJsonFlag()) return printJson({ dataset_id: dataset.id, dataset, dataset_version_id: version.datasetVersion.id })
  printLine(`Uploaded dataset ${sanitizeTerminalText(dataset.name)} (${sanitizeTerminalText(dataset.id)}) with ${dataset.rowCount} rows.`)
  printLine(`Created dataset version ${sanitizeTerminalText(version.datasetVersion.id)}.`)
  if (dataset.url) printLine(`View dataset: ${formatTerminalLink(dataset.url)}`)
}

async function uploadDataset() {
  const projectArg = getArg('--project')
  const fileArg = getArg('--file')
  const name = getArg('--name')
  const usage = 'Usage: orizu datasets upload --file <path> [--project <team/project>] [--name <name>] [--readme-file <README.md> | --readme-text <markdown>]'

  if (!fileArg) {
    throw new Error(usage)
  }

  const readmeMarkdown = readReadmeMarkdownFromArgs(usage)
  const file = expandHomePath(fileArg)
  const project = await resolveProjectSlug(projectArg)
  const datasetName = name || basename(file)

  if (extname(file).toLowerCase() === '.jsonl') {
    await uploadJsonlDatasetInChunks(file, project, datasetName, readmeMarkdown)
    return
  }

  const { rows, sourceType } = parseDatasetFile(file)
  const { transferDatasetUpload } = await import('./dataset-transfer-upload.js')
  const { data, version } = await transferDatasetUpload({
    project, name: datasetName, source: { kind: 'rows', rows, sourceType }, readmeMarkdown,
    json: hasJsonFlag(), onChunk: () => {},
  })

  if (hasJsonFlag()) return printJson({ dataset_id: data.dataset.id, dataset: data.dataset, dataset_version_id: version.datasetVersion.id })
  printLine(`Uploaded dataset ${sanitizeTerminalText(data.dataset.name)} (${sanitizeTerminalText(data.dataset.id)}) with ${data.dataset.rowCount} rows.`)
  printLine(`Created dataset version ${sanitizeTerminalText(version.datasetVersion.id)}.`)
  if (data.dataset.url) {
    printLine(`View dataset: ${formatTerminalLink(data.dataset.url)}`)
  }
}

async function pushDataset() {
  const projectArg = getArg('--project')
  const fileArg = getPositionalArg(2) || getArg('--file')
  const name = getArg('--name')
  const usage = 'Usage: orizu datasets push <rows.csv|rows.json|rows.jsonl> [--project <team/project>] [--name <name>] [--readme-file <README.md> | --readme-text <markdown>] [--json]'

  if (!fileArg) {
    throw new Error(usage)
  }

  const readmeMarkdown = readReadmeMarkdownFromArgs(usage)
  const file = expandHomePath(fileArg)
  const project = await resolveProjectSlug(projectArg)
  const datasetName = name || basename(file)
  const { rows, sourceType } = parseDatasetFile(file)
  const { transferDatasetUpload } = await import('./dataset-transfer-upload.js')
  const { data, version } = await transferDatasetUpload({
    project, name: datasetName, source: { kind: 'rows', rows, sourceType }, readmeMarkdown,
    json: hasJsonFlag(), onChunk: () => {},
  })

  if (hasJsonFlag()) {
    const payload: Record<string, unknown> = {
      dataset_id: data.dataset.id,
      name: data.dataset.name,
      row_count: data.dataset.rowCount,
      dataset_version_id: version.datasetVersion.id,
    }
    if (data.readmeVersion?.id) {
      payload.readme_version_id = data.readmeVersion.id
    }
    printJson(payload)
    return
  }

  printLine(`Uploaded dataset ${sanitizeTerminalText(data.dataset.name)} (${sanitizeTerminalText(data.dataset.id)}) with ${data.dataset.rowCount} rows.`)
  printLine(`Created dataset version ${sanitizeTerminalText(version.datasetVersion.id)}.`)
  if (data.dataset.url) {
    printLine(`View dataset: ${formatTerminalLink(data.dataset.url)}`)
  }
}

async function setDatasetReadme() {
  const datasetId = getPositionalArg(3) || getArg('--dataset')
  const project = getArg('--project')
  const usage = 'Usage: orizu datasets readme set <datasetId|dataset-name> [--project <team/project>] (--readme-file <README.md> | --readme-text <markdown>) [--json]'

  if (!datasetId) {
    throw new Error(usage)
  }

  const readmeMarkdown = readReadmeMarkdownFromArgs(usage)
  if (readmeMarkdown === null) {
    throw new Error(usage)
  }

  const resolvedDatasetId = await resolveDatasetIdForProject(datasetId, project)
  const response = await authedFetch(`/api/cli/datasets/${encodeURIComponent(resolvedDatasetId)}/readme`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown: readmeMarkdown }),
  })

  if (!response.ok) {
    throw new Error(`Failed to save dataset README: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{
    version: {
      id: string
      dataset_id: string
      version_num: number
      created_at: string
    }
  }>(response, 'Dataset README save')

  if (hasJsonFlag()) {
    printJson({
      dataset_id: data.version.dataset_id,
      readme_version_id: data.version.id,
      readme_version_num: data.version.version_num,
    })
    return
  }

  printLine(
    `Saved README v${data.version.version_num} for dataset ` +
    `${sanitizeTerminalText(data.version.dataset_id)} (${sanitizeTerminalText(data.version.id)}).`
  )
}

function getDatasetReferenceInput(): string | null {
  const fromFlag = getArg('--dataset')
  if (fromFlag) {
    return fromFlag
  }

  const positional = cliArgs[2]
  if (positional && !positional.startsWith('--')) {
    return positional
  }

  return null
}

async function downloadDataset() {
  const projectArg = getArg('--project')
  const datasetInput = getDatasetReferenceInput()
  const format = (getArg('--format') || 'jsonl') as 'csv' | 'json' | 'jsonl'
  const outPathArg = getArg('--out')

  if (!['csv', 'json', 'jsonl'].includes(format)) {
    throw new Error('format must be one of: csv, json, jsonl')
  }

  let datasetId: string
  if (datasetInput) {
    datasetId = parseDatasetReference(datasetInput).datasetId
  } else {
    const selected = await selectDatasetInteractively(projectArg)
    datasetId = selected.datasetId
  }

  const filename = outPathArg
    ? expandHomePath(outPathArg)
    : `${datasetId}.${format}`

  const { transferDatasetDownload } = await import('./dataset-transfer-download.js')
  await transferDatasetDownload(datasetId, format, filename)

  if (hasJsonFlag()) {
    printJson({ datasetId, format, savedTo: filename })
    return
  }
  printLine(`Saved dataset ${sanitizeTerminalText(datasetId)} (${format.toUpperCase()}) to ${sanitizeTerminalText(filename)}`)
}

const MAX_INPUT_FILE_SIZE_BYTES = 50 * 1024 * 1024 // 50 MB
const APPEND_CHUNK_SIZE_ROWS = 500
async function appendChunk(
  datasetId: string,
  rows: Array<Record<string, unknown>>
): Promise<{ dataset: { id: string; name: string; rowCount: number }; appendedCount: number }> {
  const response = await authedFetch(`/api/cli/datasets/${encodeURIComponent(datasetId)}/rows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows }),
  })

  if (!response.ok) {
    throw new Error(`Append failed: ${await response.text()}`)
  }

  return parseJsonResponse<{
    dataset: { id: string; name: string; rowCount: number }
    appendedCount: number
  }>(response, 'Dataset append')
}

async function appendJsonlDatasetRowsInChunks(datasetId: string, file: string) {
  let totalAppended = 0
  let lastResult: { dataset: { id: string; name: string; rowCount: number } } | null = null
  let chunkIndex = 0
  const chunks = streamJsonlRowChunks(file)[Symbol.asyncIterator]()

  while (true) {
    let nextChunk: IteratorResult<Array<Record<string, unknown>>>
    try {
      nextChunk = await chunks.next()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `Append stopped while reading the next JSONL chunk: ${message}\n` +
        `${totalAppended} rows from ${chunkIndex} chunk(s) were already appended. ` +
        `Fix the file, remove the first ${totalAppended} rows, and re-run the command.`
      )
    }

    if (nextChunk.done) {
      break
    }

    const chunk = nextChunk.value
    chunkIndex += 1
    printLine(`Uploading chunk ${chunkIndex} (${chunk.length} rows)...`)

    try {
      const data = await appendChunk(datasetId, chunk)
      totalAppended += data.appendedCount
      lastResult = data
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `Chunk ${chunkIndex} failed: ${message}\n` +
        `${totalAppended} rows from ${chunkIndex - 1} chunk(s) were already appended. ` +
        `To retry, remove the first ${totalAppended} rows from your file and re-run the command.`
      )
    }
  }

  if (!lastResult) {
    throw new Error('Dataset append file must contain at least one row')
  }

  printLine(
    `Appended ${totalAppended} rows to dataset ${sanitizeTerminalText(lastResult.dataset.name)} (${sanitizeTerminalText(lastResult.dataset.id)}). New row count: ${lastResult.dataset.rowCount}`
  )
}

async function appendDatasetRows() {
  const projectArg = getArg('--project')
  const datasetInput = getDatasetReferenceInput()
  const fileArg = getArg('--file')

  if (!fileArg) {
    throw new Error('Usage: orizu datasets append [--dataset <datasetId|datasetUrl>] [--project <team/project>] --file <path>')
  }

  let datasetId: string
  if (datasetInput) {
    datasetId = parseDatasetReference(datasetInput).datasetId
  } else {
    const selected = await selectDatasetInteractively(projectArg)
    datasetId = selected.datasetId
  }

  const file = expandHomePath(fileArg)

  if (extname(file).toLowerCase() === '.jsonl') {
    await appendJsonlDatasetRowsInChunks(datasetId, file)
    return
  }

  // Check file size before reading to prevent OOM on large files (ALI-565).
  // Wrap statSync in try/catch so missing/inaccessible files get friendly
  // errors instead of raw Node.js ENOENT/EPERM (ALI-554).
  let fileSizeBytes: number
  try {
    fileSizeBytes = statSync(file).size
  } catch (error) {
    const maybeError = error as NodeJS.ErrnoException
    if (maybeError.code === 'ENOENT') {
      throw new Error(
        `File not found: ${file}. Check the path and filename, then retry.`
      )
    }
    if (maybeError.code === 'EPERM' || maybeError.code === 'EACCES') {
      throw new Error(
        `Cannot read file: ${file}. Grant folder permission to your terminal app and retry.`
      )
    }
    throw new Error(`Failed to access file ${file}: ${maybeError.message}`)
  }
  if (fileSizeBytes > MAX_INPUT_FILE_SIZE_BYTES) {
    const sizeMb = (fileSizeBytes / (1024 * 1024)).toFixed(1)
    throw new Error(
      `Input file is ${sizeMb} MB, which exceeds the 50 MB limit. Split the file into smaller parts and append each separately.`
    )
  }

  const { rows } = parseDatasetFile(file)
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('Dataset append file must contain at least one row')
  }

  if (rows.length <= APPEND_CHUNK_SIZE_ROWS) {
    const data = await appendChunk(datasetId, rows)
    printLine(
      `Appended ${data.appendedCount} rows to dataset ${sanitizeTerminalText(data.dataset.name)} (${sanitizeTerminalText(data.dataset.id)}). New row count: ${data.dataset.rowCount}`
    )
    return
  }

  // Chunked upload for large row counts (ALI-555: track partial progress)
  let totalAppended = 0
  let lastResult: { dataset: { id: string; name: string; rowCount: number } } | null = null
  const totalChunks = Math.ceil(rows.length / APPEND_CHUNK_SIZE_ROWS)

  for (let offset = 0; offset < rows.length; offset += APPEND_CHUNK_SIZE_ROWS) {
    const chunk = rows.slice(offset, offset + APPEND_CHUNK_SIZE_ROWS)
    const chunkIndex = Math.floor(offset / APPEND_CHUNK_SIZE_ROWS) + 1

    printLine(`Uploading chunk ${chunkIndex}/${totalChunks} (${chunk.length} rows)...`)
    try {
      const data = await appendChunk(datasetId, chunk)
      totalAppended += data.appendedCount
      lastResult = data
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      throw new Error(
        `Chunk ${chunkIndex}/${totalChunks} failed: ${msg}\n` +
        `${totalAppended} rows from ${chunkIndex - 1} chunk(s) were already appended. ` +
        `To retry, remove the first ${totalAppended} rows from your file and re-run the command.`
      )
    }
  }

  if (lastResult) {
    if (hasJsonFlag()) {
      printJson({ dataset: lastResult.dataset, appendedCount: totalAppended })
      return
    }
    printLine(
      `Appended ${totalAppended} rows to dataset ${sanitizeTerminalText(lastResult.dataset.name)} (${sanitizeTerminalText(lastResult.dataset.id)}). New row count: ${lastResult.dataset.rowCount}`
    )
  }
}

async function editDatasetRows() {
  const projectArg = getArg('--project')
  const datasetInput = getDatasetReferenceInput()
  const fileArg = getArg('--file')

  if (!fileArg) {
    throw new Error('Usage: orizu datasets edit-rows [--dataset <datasetId|datasetUrl>] [--project <team/project>] --file <path>')
  }

  let datasetId: string
  if (datasetInput) {
    datasetId = parseDatasetReference(datasetInput).datasetId
  } else {
    const selected = await selectDatasetInteractively(projectArg)
    datasetId = selected.datasetId
  }

  await runEditDatasetRows({
    datasetId,
    file: expandHomePath(fileArg),
    json: hasJsonFlag(),
    printJson,
    printLine,
    sanitize: sanitizeTerminalText,
  })
}

async function deleteDatasetRows() {
  const projectArg = getArg('--project')
  const datasetInput = getDatasetReferenceInput()
  const rowIds = parseCommaSeparated(getArg('--row-ids'))

  if (rowIds.length === 0) {
    throw new Error('Usage: orizu datasets delete-rows [--dataset <datasetId|datasetUrl>] [--project <team/project>] --row-ids <id1,id2>')
  }

  let datasetId: string
  if (datasetInput) {
    datasetId = parseDatasetReference(datasetInput).datasetId
  } else {
    const selected = await selectDatasetInteractively(projectArg)
    datasetId = selected.datasetId
  }

  const response = await authedFetch(`/api/cli/datasets/${encodeURIComponent(datasetId)}/rows`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rowIds,
    }),
  })

  if (!response.ok) {
    throw new Error(`Delete rows failed: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{
    dataset: { id: string; name: string; rowCount: number }
    deletedCount: number
  }>(response, 'Dataset delete rows')

  if (hasJsonFlag()) {
    printJson({ dataset: data.dataset, deletedCount: data.deletedCount })
    return
  }
  printLine(
    `Deleted ${data.deletedCount} rows from dataset ${sanitizeTerminalText(data.dataset.name)} (${sanitizeTerminalText(data.dataset.id)}). New row count: ${data.dataset.rowCount}`
  )
}

async function confirmDatasetDeletion(dataset: DatasetSelection) {
  if (!isInteractiveTerminal()) {
    throw new Error(
      'Dataset deletion requires an interactive terminal confirmation. There is no non-interactive delete option.'
    )
  }

  const safeName = dataset.name ? ` (${sanitizeTerminalText(dataset.name)})` : ''
  printLine(
    `This will permanently delete dataset ${sanitizeTerminalText(dataset.datasetId)}${safeName}.`
  )
  printLine('Type the dataset id exactly to confirm.')

  const rl = createInterface({ input, output })
  try {
    const answer = (await rl.question('Dataset id: ')).trim()
    if (answer !== dataset.datasetId) {
      throw new Error('Dataset deletion cancelled.')
    }
  } finally {
    rl.close()
  }
}

async function deleteDataset() {
  const projectArg = getArg('--project')
  const datasetInput = getDatasetReferenceInput()

  let dataset: DatasetSelection
  if (datasetInput) {
    dataset = { datasetId: parseDatasetReference(datasetInput).datasetId }
  } else {
    dataset = await selectDatasetInteractively(projectArg)
  }

  await confirmDatasetDeletion(dataset)

  const response = await authedFetch(`/api/cli/datasets/${encodeURIComponent(dataset.datasetId)}`, {
    method: 'DELETE',
  })

  if (!response.ok) {
    throw new Error(`Delete failed: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{
    dataset: { id: string }
  }>(response, 'Dataset delete')

  if (hasJsonFlag()) {
    printJson({ dataset: data.dataset, deleted: true })
    return
  }
  printLine(`Deleted dataset ${sanitizeTerminalText(data.dataset.id)}.`)
}

async function lockDataset() {
  const projectArg = getArg('--project')
  const datasetInput = getDatasetReferenceInput()
  const reason = getArg('--reason')

  let datasetId: string
  if (datasetInput) {
    datasetId = parseDatasetReference(datasetInput).datasetId
  } else {
    const selected = await selectDatasetInteractively(projectArg)
    datasetId = selected.datasetId
  }

  const response = await authedFetch(`/api/cli/datasets/${encodeURIComponent(datasetId)}/lock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reason ? { reason } : {}),
  })

  if (!response.ok) {
    throw new Error(`Lock failed: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{
    dataset: {
      id: string
      name: string
      rowCount: number
      lockedAt: string
      lockedBy: string | null
    }
  }>(response, 'Dataset lock')

  if (hasJsonFlag()) {
    printJson({ dataset: data.dataset })
    return
  }
  printLine(
    `Locked dataset ${sanitizeTerminalText(data.dataset.name)} (${sanitizeTerminalText(data.dataset.id)}) at ${sanitizeTerminalText(data.dataset.lockedAt)}. Row count: ${data.dataset.rowCount}`
  )
}

async function cloneDataset() {
  const projectArg = getArg('--project')
  const datasetInput = getDatasetReferenceInput()
  const name = getArg('--name')

  let datasetId: string
  if (datasetInput) {
    datasetId = parseDatasetReference(datasetInput).datasetId
  } else {
    const selected = await selectDatasetInteractively(projectArg)
    datasetId = selected.datasetId
  }

  const response = await authedFetch(`/api/cli/datasets/${encodeURIComponent(datasetId)}/clone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(name ? { name } : {}),
  })

  if (!response.ok) {
    throw new Error(`Clone failed: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{
    dataset: {
      id: string
      name: string
      rowCount: number
      parentDatasetId: string
    }
  }>(response, 'Dataset clone')

  if (hasJsonFlag()) {
    printJson({ dataset: data.dataset })
    return
  }
  printLine(
    `Cloned dataset ${sanitizeTerminalText(data.dataset.parentDatasetId)} -> ${sanitizeTerminalText(data.dataset.name)} (${sanitizeTerminalText(data.dataset.id)}). Row count: ${data.dataset.rowCount}`
  )
}

async function downloadAnnotations() {
  let taskId = getArg('--task')
  const format = (getArg('--format') || 'jsonl') as 'csv' | 'json' | 'jsonl'
  const outPathArg = getArg('--out')

  if (!['csv', 'json', 'jsonl'].includes(format)) {
    throw new Error('format must be one of: csv, json, jsonl')
  }

  if (!taskId) {
    taskId = await selectTaskIdInteractively()
  }

  const response = await authedFetch(`/api/cli/tasks/${taskId}/export?format=${format}`)
  if (!response.ok) {
    throw new Error(`Download failed: ${await response.text()}`)
  }

  const fallbackName = `${taskId}.${format}`
  const filename = outPathArg
    ? expandHomePath(outPathArg)
    : fallbackName

  const bytes = new Uint8Array(await response.arrayBuffer())
  writeFileSync(filename, bytes)

  if (hasJsonFlag()) {
    printJson({ taskId, format, savedTo: filename })
    return
  }
  printLine(`Saved ${format.toUpperCase()} export to ${sanitizeTerminalText(filename)}`)
}

export {
  uploadDataset,
  listDatasets,
  pushDataset,
  downloadDataset,
  appendDatasetRows,
  setDatasetReadme,
  createDatasetVersion,
  createDatasetSplitSet,
  editDatasetRows,
  deleteDatasetRows,
  deleteDataset,
  lockDataset,
  cloneDataset,
  downloadAnnotations,
}
