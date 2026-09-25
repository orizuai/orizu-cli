// ORI-2044: moved from index.ts to keep app commands together.

import {
  readFileSync,
  mkdirSync,
  writeFileSync,
  realpathSync,
} from 'fs'
import {
  normalize,
  isAbsolute,
  join,
  dirname,
} from 'path'
import { createHash } from 'crypto'
import {
  getArg,
  getArchiveListStatus,
  hasJsonFlag,
  expandHomePath,
  hasArg,
} from './command-line-arguments.js'
import { resolveProjectSlug, fetchApps, selectAppIdInteractively } from './account-directory.js'
import { printJson, printLine, getErrorMessage } from './cli-console-output.js'
import { printAppSummaries } from './archive-artifacts-cli.js'
import { isNodeError, formatTerminalLink } from './auth-commands.js'
import { authedFetch } from './http.js'
import { parseJsonResponse, sanitizeTerminalText } from './json-response.js'
import { runLocalAppPreview } from './preview-runtime.js'



async function listApps() {
  const project = getArg('--project') || await resolveProjectSlug(null)
  const apps = await fetchApps(project, getArchiveListStatus('apps'))
  if (hasJsonFlag()) {
    printJson({ apps })
    return
  }
  printAppSummaries(apps, printLine)
}

function readSourceFile(pathArg: string): string {
  const expandedPath = expandHomePath(pathArg)
  try {
    return readFileSync(expandedPath, 'utf-8')
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new Error(`File not found: ${expandedPath}`)
    }
    throw new Error(`Failed to read file '${expandedPath}': ${getErrorMessage(error)}`)
  }
}

function readSourceBytes(pathArg: string): Buffer {
  const expandedPath = expandHomePath(pathArg)
  try {
    return readFileSync(expandedPath)
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new Error(`File not found: ${expandedPath}`)
    }
    throw new Error(`Failed to read file '${expandedPath}': ${getErrorMessage(error)}`)
  }
}

function readJsonFile(pathArg: string): Record<string, unknown> {
  const raw = readSourceFile(pathArg)
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('JSON root must be an object')
    }

    return parsed as Record<string, unknown>
  } catch (error: unknown) {
    throw new Error(`Invalid JSON file '${pathArg}': ${getErrorMessage(error)}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringFromRecord(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function safeRelativePath(value: string, fallback: string): string {
  const raw = value && value.trim() ? value.trim() : fallback
  if (raw.includes('\0')) {
    throw new Error(`Unsafe relative path: ${raw}`)
  }
  const normalized = normalize(raw)
  if (isAbsolute(raw) || normalized === '..' || normalized.startsWith('../') || normalized.startsWith('..\\')) {
    throw new Error(`Unsafe relative path: ${raw}`)
  }
  return normalized === '.' ? fallback : normalized
}

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function readPromptPrimaryText(manifest: Record<string, unknown>, promptDir: string): {
  body: string
  bodyKind: string
  path: string
} {
  const primaryText = isRecord(manifest.primary_text) ? manifest.primary_text : null
  const pathValue = primaryText
    ? stringFromRecord(primaryText, 'path')
    : stringFromRecord(manifest, 'body_file')
  const bodyPath = safeRelativePath(pathValue || 'prompt.md', 'prompt.md')
  const bodyKind = primaryText
    ? stringFromRecord(primaryText, 'kind') || stringFromRecord(manifest, 'body_kind') || 'text'
    : stringFromRecord(manifest, 'body_kind') || 'text'

  return {
    body: readSourceFile(join(promptDir, bodyPath)),
    bodyKind,
    path: bodyPath,
  }
}

function readPromptSidecars(manifest: Record<string, unknown>, promptDir: string) {
  const sidecars = Array.isArray(manifest.sidecars) ? manifest.sidecars : []
  return sidecars
    .filter(isRecord)
    .map(sidecar => {
      const pathValue = stringFromRecord(sidecar, 'path')
      if (!pathValue) {
        throw new Error('Prompt sidecar entries require path')
      }
      const relativePath = safeRelativePath(pathValue, pathValue)
      const content = readSourceFile(join(promptDir, relativePath))
      const { content: _ignoredContent, content_sha256: _ignoredSnake, contentSha256: _ignoredCamel, ...metadata } = sidecar
      return {
        ...metadata,
        type: stringFromRecord(sidecar, 'type') || 'file',
        path: relativePath,
        content,
        contentSha256: sha256Hex(content),
      }
    })
}

function writeTextFileEnsuringDir(pathArg: string, content: string) {
  mkdirSync(dirname(pathArg), { recursive: true })
  writeFileSync(pathArg, content)
}

function readManifestFile(dirArg: string): Record<string, unknown> {
  return readJsonFile(join(expandHomePath(dirArg), 'manifest.json'))
}

async function createAppFromFile() {
  const project = getArg('--project')
  const name = getArg('--name')
  const datasetId = getArg('--dataset')
  const filePath = getArg('--file')
  const inputSchemaPath = getArg('--input-schema')
  const outputSchemaPath = getArg('--output-schema')
  const component = getArg('--component') || undefined

  if (!project || !name || !datasetId || !filePath || !inputSchemaPath || !outputSchemaPath) {
    throw new Error('Usage: orizu apps create --project <team/project> --name <name> --dataset <datasetId> --file <path> --input-schema <json-path> --output-schema <json-path> [--component <name>]')
  }

  const sourceCode = readSourceFile(filePath)
  const inputJsonSchema = readJsonFile(inputSchemaPath)
  const outputJsonSchema = readJsonFile(outputSchemaPath)
  const response = await authedFetch('/api/cli/apps/create-from-file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectSlug: project,
      name,
      datasetId,
      sourceCode,
      componentName: component,
      inputJsonSchema,
      outputJsonSchema,
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to create app: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{
    app: { id: string; name: string; versionNum: number; componentName?: string; url?: string }
    warnings?: string[]
  }>(response, 'App create')
  if (hasJsonFlag()) {
    printJson({ app: data.app, warnings: data.warnings || [] })
    return
  }
  printLine(`Created app ${sanitizeTerminalText(data.app.name)} (${sanitizeTerminalText(data.app.id)}) v${data.app.versionNum}`)
  if (data.app.url) {
    printLine(`View app: ${formatTerminalLink(data.app.url)}`)
  }
  if (data.warnings?.length) {
    printLine(`Warnings: ${sanitizeTerminalText(data.warnings.join('; '))}`)
  }
}

async function previewAppFromFile() {
  const filePath = getArg('--file')
  const inputSchemaPath = getArg('--input-schema')
  const outputSchemaPath = getArg('--output-schema')
  const sampleRowPath = getArg('--sample-row')
  const screenshotPath = getArg('--screenshot')
  const component = getArg('--component') || undefined
  const headed = hasArg('--headed')
  const keepOpen = hasArg('--keep-open')

  if (!filePath || !inputSchemaPath || !outputSchemaPath || !sampleRowPath) {
    throw new Error('Usage: orizu apps preview --file <path> --input-schema <json-path> --output-schema <json-path> --sample-row <json-path> [--screenshot <png-path>] [--headed] [--keep-open] [--component <name>]')
  }

  const expandedFilePath = realpathSync(expandHomePath(filePath))
  const inputJsonSchema = readJsonFile(inputSchemaPath)
  const outputJsonSchema = readJsonFile(outputSchemaPath)
  const sampleRow = readJsonFile(sampleRowPath)
  const expandedScreenshotPath = screenshotPath ? expandHomePath(screenshotPath) : undefined

  const result = await runLocalAppPreview({
    filePath: expandedFilePath,
    inputSchema: inputJsonSchema,
    outputSchema: outputJsonSchema,
    sampleRow,
    screenshotPath: expandedScreenshotPath,
    componentName: component,
    headed,
    keepOpen,
  })

  if (hasJsonFlag()) {
    printJson({
      url: result.url,
      screenshotPath: result.screenshotPath || null,
      warnings: result.warnings,
    })
    return
  }
  printLine(`Preview rendered: ${formatTerminalLink(result.url)}`)
  if (result.screenshotPath) {
    printLine(`Screenshot: ${sanitizeTerminalText(result.screenshotPath)}`)
  }
  if (headed || keepOpen) {
    printLine('Headed preview is running. Close Chromium or stop the command when you are done.')
  }
  if (result.warnings.length > 0) {
    printLine(`Warnings: ${sanitizeTerminalText(result.warnings.join('; '))}`)
  }
}

async function updateAppFromFile() {
  const filePath = getArg('--file')
  const inputSchemaPath = getArg('--input-schema')
  const outputSchemaPath = getArg('--output-schema')
  const component = getArg('--component') || undefined
  let appId = getArg('--app')
  const project = getArg('--project')

  if (!filePath || !inputSchemaPath || !outputSchemaPath) {
    throw new Error('Usage: orizu apps update [--app <appId>] [--project <team/project>] --file <path> --input-schema <json-path> --output-schema <json-path> [--component <name>]')
  }

  if (!appId) {
    const selected = await selectAppIdInteractively(project)
    appId = selected.appId
  }

  const sourceCode = readSourceFile(filePath)
  const inputJsonSchema = readJsonFile(inputSchemaPath)
  const outputJsonSchema = readJsonFile(outputSchemaPath)
  const response = await authedFetch(`/api/cli/apps/${encodeURIComponent(appId)}/update-from-file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceCode,
      componentName: component,
      inputJsonSchema,
      outputJsonSchema,
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to update app: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{
    app: { id: string; name: string; versionNum: number; componentName?: string }
    warnings?: string[]
  }>(response, 'App update')
  if (hasJsonFlag()) {
    printJson({ app: data.app, warnings: data.warnings || [] })
    return
  }
  printLine(`Updated app ${sanitizeTerminalText(data.app.name)} (${sanitizeTerminalText(data.app.id)}) to v${data.app.versionNum}`)
  if (data.warnings?.length) {
    printLine(`Warnings: ${sanitizeTerminalText(data.warnings.join('; '))}`)
  }
}

async function linkAppDataset() {
  const datasetId = getArg('--dataset')
  const project = getArg('--project')
  let appId = getArg('--app')
  const versionArg = getArg('--version')
  const parsedVersionNum = versionArg ? Number(versionArg) : Number.NaN
  const versionNum =
    Number.isInteger(parsedVersionNum) && parsedVersionNum > 0 ? parsedVersionNum : undefined

  if (!datasetId) {
    throw new Error('Usage: orizu apps link-dataset --dataset <datasetId> [--app <appId>] [--project <team/project>] [--version <n>]')
  }

  if (versionArg && versionNum === undefined) {
    throw new Error('--version must be a positive integer')
  }

  if (!appId) {
    const selected = await selectAppIdInteractively(project)
    appId = selected.appId
  }

  const response = await authedFetch(`/api/cli/apps/${encodeURIComponent(appId)}/link-dataset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      datasetId,
      versionNum,
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to link dataset: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{
    app: { id: string; name: string }
    linkedDataset: { id: string; name: string }
    versionNum: number
  }>(response, 'App link dataset')

  if (hasJsonFlag()) {
    printJson({ app: data.app, linkedDataset: data.linkedDataset, versionNum: data.versionNum })
    return
  }
  printLine(
    `Linked dataset ${sanitizeTerminalText(data.linkedDataset.name)} (${sanitizeTerminalText(data.linkedDataset.id)}) to app ${sanitizeTerminalText(data.app.name)} (${sanitizeTerminalText(data.app.id)}) version ${data.versionNum}`
  )
}

interface AppDetailPayload {
  id: string
  name: string
  currentVersionNum: number | null
  currentVersion: {
    versionId: string
    versionNum: number
    inputJsonSchema: unknown
    outputJsonSchema: unknown
  } | null
  createdAt: string
  updatedAt: string
  projectId: string | null
  compatibleDatasetsCount: number
  totalDatasetsCount: number
  createdByName: string | null
  createdByEmail: string | null
  teamSlug: string
  teamName: string
  projectSlug: string
  projectName: string
}

interface AppExportPayload {
  app: {
    id: string
    name: string
  }
  version: {
    id: string
    versionNum: number
    createdAt?: string
    code: string
  }
}

function defaultAppExportFilename(appName: string, versionNum: number): string {
  const safeName = appName
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100)
  return `${safeName || 'app'}.v${versionNum}.tsx`
}

async function appDetail() {
  const appId = getArg('--app')
  const project = getArg('--project')

  if (!appId) {
    throw new Error('Usage: orizu apps detail --app <appId> [--project <team/project>] [--json]')
  }

  const projectSlug = project || await resolveProjectSlug(null)

  // Single fetch — the apps endpoint already returns full detail (ALI-544)
  const detailResponse = await authedFetch(`/api/cli/apps?project=${encodeURIComponent(projectSlug)}`)
  if (!detailResponse.ok) {
    throw new Error(`Failed to fetch app detail: ${await detailResponse.text()}`)
  }

  const detailData = await parseJsonResponse<{ apps: AppDetailPayload[] }>(detailResponse, 'App detail')
  const detail = detailData.apps.find(a => a.id === appId)

  if (!detail) {
    throw new Error(`App '${appId}' not found in project '${projectSlug}'`)
  }

  if (hasJsonFlag()) {
    printLine(JSON.stringify(detail, null, 2))
    return
  }

  printLine(`App: ${sanitizeTerminalText(detail.name)} (${sanitizeTerminalText(detail.id)})`)
  printLine(`  Project: ${sanitizeTerminalText(`${detail.teamSlug}/${detail.projectSlug}`)}`)
  if (detail.currentVersion) {
    printLine(`  Current version: v${detail.currentVersion.versionNum} (${sanitizeTerminalText(detail.currentVersion.versionId)})`)
    printLine(`  Input schema: ${detail.currentVersion.inputJsonSchema ? 'defined' : 'none'}`)
    printLine(`  Output schema: ${detail.currentVersion.outputJsonSchema ? 'defined' : 'none'}`)
  } else {
    printLine(`  Current version: none`)
  }
  printLine(`  Compatible datasets: ${detail.compatibleDatasetsCount}/${detail.totalDatasetsCount}`)
  if (detail.createdByEmail) {
    printLine(`  Created by: ${sanitizeTerminalText(detail.createdByName || detail.createdByEmail)}`)
  }
  printLine(`  Created: ${sanitizeTerminalText(detail.createdAt)}`)
  printLine(`  Updated: ${sanitizeTerminalText(detail.updatedAt)}`)
}

async function exportAppSource() {
  const project = getArg('--project')
  const versionArg = getArg('--version')
  const outPathArg = getArg('--out')
  let appId = getArg('--app')

  const versionNum = versionArg && /^[1-9]\d*$/.test(versionArg)
    ? Number.parseInt(versionArg, 10)
    : undefined

  if (versionArg && versionNum === undefined) {
    throw new Error('--version must be a positive integer')
  }

  if (!appId) {
    const selected = await selectAppIdInteractively(project)
    appId = selected.appId
  }

  const query = new URLSearchParams()
  if (project) {
    query.set('project', project)
  }
  if (versionNum) {
    query.set('version', String(versionNum))
  }

  const suffix = query.toString() ? `?${query.toString()}` : ''
  const response = await authedFetch(`/api/cli/apps/${encodeURIComponent(appId)}/export${suffix}`)
  if (!response.ok) {
    throw new Error(`Failed to export app (${response.status}): ${await response.text()}`)
  }

  const data = await parseJsonResponse<AppExportPayload>(response, 'App export')
  const filename = outPathArg
    ? expandHomePath(outPathArg)
    : defaultAppExportFilename(data.app.name, data.version.versionNum)

  writeTextFileEnsuringDir(filename, data.version.code)
  if (hasJsonFlag()) {
    printJson({
      app: { id: data.app.id, name: data.app.name },
      versionNum: data.version.versionNum,
      savedTo: filename,
    })
    return
  }
  printLine(
    `Saved app ${sanitizeTerminalText(data.app.name)} v${data.version.versionNum} source to ${sanitizeTerminalText(filename)}`
  )
}

export {
  readSourceFile,
  readJsonFile,
  readManifestFile,
  readPromptPrimaryText,
  readPromptSidecars,
  stringFromRecord,
  isRecord,
  safeRelativePath,
  writeTextFileEnsuringDir,
  sha256Hex,
  readSourceBytes,
  listApps,
  createAppFromFile,
  previewAppFromFile,
  updateAppFromFile,
  linkAppDataset,
  appDetail,
  exportAppSource,
}
