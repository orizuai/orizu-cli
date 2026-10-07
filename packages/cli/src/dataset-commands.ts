// ORI-2044: moved from index.ts to keep dataset commands together.

import { readFileSync, writeFileSync } from 'fs'
import { basename, extname } from 'path'
import { createInterface } from 'readline/promises'
import { stdin as input, stdout as output } from 'process'
import {
  getArg,
  hasArg,
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

function readReadmeFile(readmeFile: string): string {
  try {
    return readFileSync(expandHomePath(readmeFile), 'utf8')
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT'
    const reason = missing ? 'file not found' : error instanceof Error ? error.message : String(error)
    throw new Error(`Could not read README file ${readmeFile}: ${reason}`)
  }
}

function readReadmeMarkdownFromArgs(usage: string): string | null {
  const readmeFile = getArg('--readme-file')
  const readmeText = getArg('--readme-text')

  if (readmeFile !== null && readmeText !== null) {
    throw new Error(`Use either --readme-file or --readme-text, not both.\n${usage}`)
  }

  const markdown = readmeFile !== null
    ? readReadmeFile(readmeFile)
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

async function listDatasetSplitSets() {
  const versionId = getPositionalArg(3)
  if (!versionId) throw new Error('Usage: orizu datasets splits list <datasetVersionId> [--json]')
  const { listDatasetSplits } = await import('./dataset-split-reads.js')
  const data = await listDatasetSplits(versionId)
  if (hasJsonFlag()) return printJson({ ...data })
  printLine(`Dataset version ${sanitizeTerminalText(data.dataset_version_id)}`)
  for (const set of data.split_sets) {
    printLine(`${sanitizeTerminalText(set.name)} (${sanitizeTerminalText(set.id)})`)
    for (const partition of set.partitions) printLine(`  ${sanitizeTerminalText(partition.name)}: ${partition.row_count} rows`)
  }
  if (!data.split_sets.length) printLine('No saved split sets.')
}

async function showDatasetSplitSet() {
  const setId = getPositionalArg(3)
  if (!setId) throw new Error('Usage: orizu datasets splits show <splitSetId> [--json]')
  const { showDatasetSplit } = await import('./dataset-split-reads.js')
  const data = await showDatasetSplit(setId)
  if (hasJsonFlag()) return printJson({ ...data })
  printLine(`${sanitizeTerminalText(data.name)} (${sanitizeTerminalText(data.split_set_id)})`)
  printLine(`Dataset version: ${sanitizeTerminalText(data.dataset_version_id)}`)
  printLine(`Strategy: ${sanitizeTerminalText(data.strategy)}; seed: ${data.seed ?? 'none'}`)
  printLine(`Metadata: ${sanitizeTerminalText(JSON.stringify(data.metadata))}`)
  for (const partition of data.partitions) {
    printLine(`${sanitizeTerminalText(partition.name)}: ${partition.row_ids.length} rows`)
    for (const id of partition.row_ids) printLine(`  ${sanitizeTerminalText(id)}`)
  }
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
  const metadata = splitSpec && Object.prototype.hasOwnProperty.call(splitSpec, 'metadata')
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
  const { saveDatasetReadme } = await import('./dataset-readme-workflow.js')
  const version = await saveDatasetReadme(resolvedDatasetId, readmeMarkdown)

  if (hasJsonFlag()) {
    printJson({
      dataset_id: version.dataset_id,
      readme_version_id: version.id,
      readme_version_num: version.version_num,
    })
    return
  }

  printLine(
    `Saved README v${version.version_num} for dataset ` +
    `${sanitizeTerminalText(version.dataset_id)} (${sanitizeTerminalText(version.id)}).`
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

  const versionId = getArg('--dataset-version'), setId = getArg('--split-set')
  const inlineSplit = cliArgs.find(argument => argument.startsWith('--split='))
  const split = inlineSplit === undefined ? getArg('--split') : inlineSplit.slice('--split='.length)
  if (['--dataset-version', '--split-set', '--split'].some(flag => hasArg(flag) || cliArgs.some(argument => argument.startsWith(`${flag}=`)))) {
    if (!versionId || !setId || !split || [versionId, setId].some(value => value.startsWith('--')) || (inlineSplit === undefined && split.startsWith('--'))) throw new Error('Pinned download requires --dataset-version, --split-set and --split together')
    if (datasetInput) throw new Error('Use --dataset-version with split selectors without a live --dataset or dataset argument')
    if (format === 'csv') throw new Error('Pinned download format must be json or jsonl')
    const filename = outPathArg ? expandHomePath(outPathArg) : `${versionId}.${format}`
    const { downloadPinnedDatasetSplit } = await import('./dataset-split-reads.js')
    await downloadPinnedDatasetSplit(versionId, setId, split, format, filename)
    if (hasJsonFlag()) return printJson({ dataset_version_id: versionId, split_set_id: setId, split, format, savedTo: filename })
    printLine(`Saved split ${sanitizeTerminalText(split)} from dataset version ${sanitizeTerminalText(versionId)} (${format.toUpperCase()}) to ${sanitizeTerminalText(filename)}`)
    return
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

async function appendDatasetRows() {
  const { appendDatasetWorkflow } = await import('./dataset-append-workflow.js')
  process.exitCode = await appendDatasetWorkflow(async () => {
    const projectArg = getArg('--project')
    const datasetInput = getDatasetReferenceInput()
    const fileArg = getArg('--file')
    if (!fileArg) throw new Error('Usage: orizu datasets append [--dataset <datasetId|datasetUrl>] [--project <team/project>] --file <path>')
    const datasetId = datasetInput ? parseDatasetReference(datasetInput).datasetId : (await selectDatasetInteractively(projectArg)).datasetId
    return { datasetId, file: expandHomePath(fileArg) }
  }, { json: hasJsonFlag(), print: printLine })
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

  const { editDatasetRows: runEditDatasetRows } = await import('./dataset-row-workflow.js')
  const exitCode = await runEditDatasetRows({
    datasetId,
    file: expandHomePath(fileArg),
    json: hasJsonFlag(),
    printJson,
    printLine,
    sanitize: sanitizeTerminalText,
  })
  if (exitCode !== 0) process.exitCode = exitCode
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

  const { deleteDatasetRows: runDeleteDatasetRows } = await import('./dataset-row-workflow.js')
  const exitCode = await runDeleteDatasetRows({
    datasetId,
    rowIds,
    json: hasJsonFlag(),
    printJson,
    printLine,
    sanitize: sanitizeTerminalText,
  })
  if (exitCode !== 0) process.exitCode = exitCode
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

  const { deleteDataset: requestDelete } = await import('./dataset-delete-workflow.js')
  // Only a dataset picked from a project's list has a known project; with
  // --dataset, --project is never checked against the dataset.
  const deleted = await requestDelete(dataset.datasetId, dataset.project ?? null)

  if (hasJsonFlag()) {
    printJson({ dataset: deleted, deleted: true })
    return
  }
  printLine(`Deleted dataset ${sanitizeTerminalText(deleted.id)}.`)
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

  const { lockDataset: requestLock } = await import('./dataset-lock-workflow.js')
  const dataset = await requestLock(datasetId, reason)

  if (hasJsonFlag()) {
    printJson({ dataset })
    return
  }
  printLine(
    `Locked dataset ${sanitizeTerminalText(dataset.name)} (${sanitizeTerminalText(dataset.id)}) at ${sanitizeTerminalText(dataset.lockedAt)}. Row count: ${dataset.rowCount}`
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
  listDatasetSplitSets,
  showDatasetSplitSet,
  editDatasetRows,
  deleteDatasetRows,
  deleteDataset,
  lockDataset,
  cloneDataset,
  downloadAnnotations,
}
