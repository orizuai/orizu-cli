// ORI-2044: moved from index.ts to keep app commands together.

import {
  readFileSync,
  statSync,
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
import { createHash, randomUUID } from 'crypto'
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
import { parseCliProjectSlug } from './cli-project-slug.js'
import { AppPublishFailure } from './app-publish-failure.js'
import { inspectAppDestination } from './app-publish-paths.js'
import { authedFetch, getBaseUrl } from './http.js'
import { appPageUrl } from './app-page-url.js'
import { parseJsonResponse, sanitizeHumanInlineText, sanitizeTerminalText } from './json-response.js'
import { runLocalAppPreview } from './preview-runtime.js'
import type { AppFiles } from './app-publish-workspace.js'
import { findWorkspaceRoot } from './workspace.js'



async function listApps() {
  const project = getArg('--project') || await resolveProjectSlug(null)
  const baseUrl = getBaseUrl()
  const apps = (await fetchApps(project, getArchiveListStatus('apps')))
    .map(app => ({ ...app, pageUrl: appPageUrl(baseUrl, app.id) }))
  if (hasJsonFlag()) {
    printJson({ apps })
    return
  }
  printAppSummaries(apps, printLine)
  // An archived app's page still renders as if live, so it gets no link line.
  apps
    .filter(app => app.status !== 'archived')
    .forEach(app => printLine(`Link: ${sanitizeHumanInlineText(sanitizeTerminalText, app.name || app.id)} ${formatTerminalLink(app.pageUrl)}`))
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
  return parseJsonFileContents(readSourceFile(pathArg), pathArg)
}

function parseJsonFileContents(raw: string, pathArg: string): Record<string, unknown> {
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

const LOCAL_PUBLISH_NOTE =
  'Note: this app version is not in the team repository yet; it reaches git when published from a hosted session.'
const APP_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

interface PublishedCommit {
  outcome: 'merged' | 'already_merged'
  sha: string
}

/** The workspace root when this runs in a hosted session, else null. */
function hostedWorkspaceRoot(): string | null {
  if (!process.env.ORIZU_SESSION_ID?.trim()) return null
  const workspaceRoot = findWorkspaceRoot(process.cwd())
  if (!workspaceRoot) throw new Error('Hosted app publishing must run inside the attached workspace. Run this command from the workspace containing orizu.team.json.')
  return workspaceRoot
}

/** The hosted publish path, loaded only when it runs: it needs Effect, which
 * the rest of the CLI does not load at startup. */
function loadAppPublishWorkspace() {
  return import('./app-publish-workspace.js')
}

/** The app as committed into its folder: the files exactly as the agent wrote them. */
function appFilesFromArgs(filePath: string, inputSchemaPath: string, outputSchemaPath: string): AppFiles {
  return { sourceCode: readSourceFile(filePath), inputSchema: readSourceFile(inputSchemaPath), outputSchema: readSourceFile(outputSchemaPath) }
}

/** ORI-2280: a hosted publish the merge stopped. The server's text says what to
 * do; a create's rerun must name the same app id, so its folder is reused. A
 * conflict also adds the team copy remote the text tells the agent to pull. */
async function publishRefusalError(responseText: string, workspaceRoot: string): Promise<Error | null> {
  let body: unknown
  try {
    body = JSON.parse(responseText)
  } catch {
    return null
  }
  if (!isRecord(body) || typeof body.error !== 'string' || typeof body.code !== 'string' || !body.code.startsWith('publish_')) return null
  let message = sanitizeTerminalText(body.error)
  if (body.code === 'publish_conflict') {
    const { addTeamCopyRemote } = await loadAppPublishWorkspace()
    const remoteNote = await addTeamCopyRemote(workspaceRoot)
    if (remoteNote) message = `${message} ${remoteNote}`
  }
  return new Error(message)
}

function printPublishedCommit(commit: PublishedCommit | null | undefined, isHosted: boolean) {
  if (commit) {
    const where = commit.outcome === 'merged' ? 'Merged into' : 'Already in'
    printLine(`${where} the team copy: ${sanitizeTerminalText(commit.sha.slice(0, 7))}`)
  } else if (!isHosted) {
    printLine(LOCAL_PUBLISH_NOTE)
  }
}

/** Quote each original argument so spaces and quotes survive a copied retry. */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function canonicalRetryInputPath(workspaceRoot: string, folder: string, filename: string, originalPath: string): string {
  const canonicalPath = join(workspaceRoot, folder, filename)
  try {
    return inspectAppDestination(workspaceRoot, join(folder, filename)) ? canonicalPath : originalPath
  } catch {
    return originalPath
  }
}

async function createAppFromFile() {
  const workspaceRoot = hostedWorkspaceRoot()
  let project = getArg('--project')
  const name = getArg('--name')
  const datasetId = getArg('--dataset')
  const filePath = getArg('--file')
  const inputSchemaPath = getArg('--input-schema')
  const outputSchemaPath = getArg('--output-schema')
  const component = getArg('--component') || undefined
  const requestedAppId = getArg('--id') ?? undefined

  if (!project || !name || !datasetId || !filePath || !inputSchemaPath || !outputSchemaPath) {
    throw new Error('Usage: orizu apps create --project <team/project> --name <name> --dataset <datasetId> --file <path> --input-schema <json-path> --output-schema <json-path> [--component <name>] [--id <app-id>]')
  }
  if (requestedAppId !== undefined && !APP_ID_PATTERN.test(requestedAppId)) {
    throw new Error('--id must be a lowercase app id (UUID), as printed by the earlier publish')
  }

  if (workspaceRoot) {
    const parsedProject = parseCliProjectSlug(project)
    const slug = /^[a-z0-9][a-z0-9-]{0,99}$/
    if (!parsedProject || !slug.test(parsedProject.teamSlug) || !slug.test(parsedProject.projectSlug)) {
      throw new Error('--project must be a valid <team/project> reference')
    }
    project = `${parsedProject.teamSlug}/${parsedProject.projectSlug}`
  }

  const files = appFilesFromArgs(filePath, inputSchemaPath, outputSchemaPath)
  const sourceCode = files.sourceCode
  const inputJsonSchema = parseJsonFileContents(files.inputSchema, inputSchemaPath)
  const outputJsonSchema = parseJsonFileContents(files.outputSchema, outputSchemaPath)

  // In a hosted session the app is committed into its folder and pushed first;
  // the server merges that commit into the team copy before recording the app.
  let appId = requestedAppId
  let sessionCommitSha: string | undefined
  let recoveryFolder: string | undefined
  let filesMaterialized = false
  try {
    if (workspaceRoot) {
      const projectSlug = parseCliProjectSlug(project)!.projectSlug
      appId ??= randomUUID()
      recoveryFolder = `projects/${projectSlug}/apps/${appId}`
      const { pushAppToSessionCopy } = await loadAppPublishWorkspace()
      sessionCommitSha = await pushAppToSessionCopy(workspaceRoot, {
        projectSlug,
        appId,
        files,
      })
      filesMaterialized = true
    }

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
        ...(appId !== undefined ? { appId } : {}),
        ...(sessionCommitSha !== undefined ? { sessionCommitSha } : {}),
      }),
    })

    if (!response.ok) {
      const text = await response.text()
      const refusal = workspaceRoot ? await publishRefusalError(text, workspaceRoot) : null
      throw refusal ?? new Error(`Failed to create app: ${text}`)
    }

    const data = await parseJsonResponse<{
      app: { id: string; name: string; versionNum: number; componentName?: string; url?: string; publishedCommit?: PublishedCommit | null }
      warnings?: string[]
    }>(response, 'App create')
    if (hasJsonFlag()) {
      printJson({ app: { ...data.app, pageUrl: data.app.url || appPageUrl(getBaseUrl(), data.app.id) }, warnings: data.warnings || [] })
      return
    }
    printLine(`Created app ${sanitizeTerminalText(data.app.name)} (${sanitizeTerminalText(data.app.id)}) v${data.app.versionNum}`)
    if (data.app.url) {
      printLine(`View app: ${formatTerminalLink(data.app.url)}`)
    }
    printPublishedCommit(data.app.publishedCommit, workspaceRoot !== null)
    if (data.warnings?.length) {
      printLine(`Warnings: ${sanitizeTerminalText(data.warnings.join('; '))}`)
    }
  } catch (error) {
    if (!workspaceRoot || !appId || !recoveryFolder) throw error
    const useCanonicalInputs = filesMaterialized || (error instanceof AppPublishFailure && error.filesMaterialized)
    const retryArgs = ['orizu', '--server', getBaseUrl(), 'apps', 'create', '--project', project, '--name', name, '--dataset', datasetId,
      '--file', useCanonicalInputs ? canonicalRetryInputPath(workspaceRoot, recoveryFolder, 'App.tsx', filePath) : filePath, '--input-schema', useCanonicalInputs ? canonicalRetryInputPath(workspaceRoot, recoveryFolder, 'input.schema.json', inputSchemaPath) : inputSchemaPath,
      '--output-schema', useCanonicalInputs ? canonicalRetryInputPath(workspaceRoot, recoveryFolder, 'output.schema.json', outputSchemaPath) : outputSchemaPath,
      ...(component ? ['--component', component] : []), ...(hasJsonFlag() ? ['--json'] : []), '--id', appId]
    throw new Error(`${getErrorMessage(error)}\nApp ID: ${appId}\nFolder: ${recoveryFolder}\nRetry: ${retryArgs.map(shellSingleQuote).join(' ')}`)
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
  const workspaceRoot = hostedWorkspaceRoot()
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

  const files = appFilesFromArgs(filePath, inputSchemaPath, outputSchemaPath)
  const sourceCode = files.sourceCode
  const inputJsonSchema = parseJsonFileContents(files.inputSchema, inputSchemaPath)
  const outputJsonSchema = parseJsonFileContents(files.outputSchema, outputSchemaPath)

  // In a hosted session the app is committed into its folder and pushed first;
  // the server merges that commit into the team copy before recording the version.
  let recoveryFolder: string | undefined
  let filesMaterialized = false
  try {
    let sessionCommitSha: string | undefined
    if (workspaceRoot) {
      const folderResponse = await authedFetch(`/api/cli/apps/${encodeURIComponent(appId)}`)
      if (!folderResponse.ok) {
        throw new Error(`Failed to find the app's project: ${await folderResponse.text()}`)
      }
      const folder = await parseJsonResponse<{ appId: string; projectSlug: string }>(folderResponse, 'App folder')
      recoveryFolder = `projects/${folder.projectSlug}/apps/${folder.appId}`
      const { pushAppToSessionCopy } = await loadAppPublishWorkspace()
      sessionCommitSha = await pushAppToSessionCopy(workspaceRoot, {
        projectSlug: folder.projectSlug,
        appId: folder.appId,
        files,
      })
      filesMaterialized = true
    }

    const response = await authedFetch(`/api/cli/apps/${encodeURIComponent(appId)}/update-from-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceCode,
        componentName: component,
        inputJsonSchema,
        outputJsonSchema,
        ...(sessionCommitSha !== undefined ? { sessionCommitSha } : {}),
      }),
    })

    if (!response.ok) {
      const text = await response.text()
      const refusal = workspaceRoot ? await publishRefusalError(text, workspaceRoot) : null
      throw refusal ?? new Error(`Failed to update app: ${text}`)
    }

    const data = await parseJsonResponse<{
      app: { id: string; name: string; versionNum: number; componentName?: string; publishedCommit?: PublishedCommit | null }
      warnings?: string[]
    }>(response, 'App update')
    const pageUrl = appPageUrl(getBaseUrl(), data.app.id)
    if (hasJsonFlag()) {
      printJson({ app: { ...data.app, pageUrl }, warnings: data.warnings || [] })
      return
    }
    printLine(`Updated app ${sanitizeTerminalText(data.app.name)} (${sanitizeTerminalText(data.app.id)}) to v${data.app.versionNum}`)
    printLine(`View app: ${formatTerminalLink(pageUrl)}`)
    printPublishedCommit(data.app.publishedCommit, workspaceRoot !== null)
    if (data.warnings?.length) {
      printLine(`Warnings: ${sanitizeTerminalText(data.warnings.join('; '))}`)
    }
  } catch (error) {
    if (!workspaceRoot || !recoveryFolder) throw error
    const useCanonicalInputs = filesMaterialized || (error instanceof AppPublishFailure && error.filesMaterialized)
    const retryArgs = ['orizu', '--server', getBaseUrl(), 'apps', 'update', '--app', appId,
      '--file', useCanonicalInputs ? canonicalRetryInputPath(workspaceRoot, recoveryFolder, 'App.tsx', filePath) : filePath,
      '--input-schema', useCanonicalInputs ? canonicalRetryInputPath(workspaceRoot, recoveryFolder, 'input.schema.json', inputSchemaPath) : inputSchemaPath,
      '--output-schema', useCanonicalInputs ? canonicalRetryInputPath(workspaceRoot, recoveryFolder, 'output.schema.json', outputSchemaPath) : outputSchemaPath,
      ...(component ? ['--component', component] : []), ...(hasJsonFlag() ? ['--json'] : [])]
    throw new Error(`${getErrorMessage(error)}\nApp ID: ${appId}\nFolder: ${recoveryFolder}\nRetry: ${retryArgs.map(shellSingleQuote).join(' ')}`)
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

/** `--out` may be a file path or a directory; a directory gets the default file name. */
export function resolveAppExportPath(outPathArg: string | null | undefined, defaultFilename: string): string {
  if (!outPathArg) return defaultFilename
  const expanded = expandHomePath(outPathArg)
  const isDirectory = /[\\/]$/.test(outPathArg) || statSync(expanded, { throwIfNoEntry: false })?.isDirectory() === true
  return isDirectory ? join(expanded, defaultFilename) : expanded
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
  const filename = resolveAppExportPath(
    outPathArg,
    defaultAppExportFilename(data.app.name, data.version.versionNum)
  )

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
