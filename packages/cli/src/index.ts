#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from 'crypto'
import { basename, delimiter, dirname, extname, isAbsolute, join, normalize, relative, resolve } from 'path'
import { fileURLToPath } from 'url'
import { createServer } from 'http'
import { gunzipSync, gzipSync } from 'zlib'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { spawn, spawnSync } from 'child_process'
import { homedir, tmpdir } from 'os'
import { createInterface } from 'readline/promises'
import { emitKeypressEvents } from 'readline'
import { stdin as input, stdout as output } from 'process'
import { clearServerCredentials, getServerCredentials, saveServerCredentials } from './credentials.js'
import { parseDatasetFile } from './file-parser.js'
import { streamJsonlRowChunks } from './jsonl-stream.js'
import { parseDatasetReference } from './dataset-download.js'
import { extractErrorMessage } from './error-response.js'
import { parseGlobalFlags } from './global-flags.js'
import { getCapabilities, renderHelpForArgs, renderRootHelp } from './help.js'
import { zipDirectoryToBase64 } from './artifact-archive.js'
import { runLocalAppPreview } from './preview-runtime.js'
import { readAssignmentManifestJsonlFile } from './task-assignment-manifest.js'
import { assertSecureTokenTransport, authedFetch, getBaseUrl, resolveLoginBaseUrl, setGlobalFlags } from './http.js'
import {
  computeSkillContentHash,
  getSkillInstallPath,
  getSkillTargetStatus,
  getTargetForAgent,
  installSkillTarget,
  isSkillInstallAgent,
  isSkillInstallTarget,
  resolveSkillSource,
  SKILL_INSTALL_AGENTS,
  SKILL_INSTALL_TARGETS,
  SkillInstallAgent,
  SkillInstallMode,
  SkillInstallScope,
  SkillInstallTarget,
  SkillTargetStatus,
  targetNeedsOverwrite,
} from './skill-installer.js'
import { renderBanner } from './banner.js'
import { formatTaskCreateError } from './task-create-error.js'
import { renderAgentSetupPrompt } from './setup-prompt.js'
import { LoginResponse } from './types.js'
import {
  getWorkspaceRoot,
  initOrizuWorkspace,
  type WorkspaceProjectSeed,
  workspaceExists,
} from './workspace.js'
import { connectorsCommand } from './connectors-cli.js'
import { ARTIFACT_MAX_BYTES, runnerOptimizerCommand } from './artifact-pull.js'
import { killSwitchCommand } from './kill-switch-cli.js'
import { egressAllowlistCommand } from './egress-allowlist-cli.js'
import { manifestsCommand } from './manifests-cli.js'
import { workbenchCommand } from './workbench-cli.js'
import { hostedCommand } from './hosted-session-cli.js'
import { workspaceSyncCommand } from './workspace-sync.js'
import { runGitCredential } from './git-credential.js'
import { type GithubLinkResult, runGithubLink, runInteractiveHostedSetup } from './github-setup.js'
import {
  reportCommentsCommand,
  throwDeprecatedPromptCommentsCommand,
  type ReportCommentsCliContext,
} from './report-comments-cli.js'

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error
}

interface Team {
  id: string
  name: string
  slug: string
  role: string
}

interface Project {
  id: string
  name: string
  slug: string
  teamId: string
  teamName: string
  teamSlug: string
  role: string
}

interface Task {
  id: string
  title: string
  status: string
  createdAt: string
  projectName?: string
  projectSlug?: string
  teamName?: string
  teamSlug?: string
}

interface AppSummary {
  id: string
  name: string
  currentVersionNum: number
  createdAt: string
  teamSlug: string
  teamName: string
  projectSlug: string
  projectName: string
}

interface DatasetSummary {
  id: string
  name: string
  rowCount: number
  sourceType: string
  createdAt: string
  projectId: string
  projectName: string
  projectSlug: string
  teamName: string
  teamSlug: string
}

interface DatasetSelection {
  datasetId: string
  project?: string
  name?: string
}

interface PromptSummary {
  id: string
  name: string
  role: string
  status?: string
  archivedAt?: string | null
  description?: string | null
}

interface TaskReportPayload {
  task: {
    id: string
    title?: string | null
    status?: string | null
    report: {
      markdown: string
      sourceName: string | null
      createdAt: string | null
      updatedAt?: string | null
    }
  }
}

interface ScorerSummary {
  id: string
  name: string
  mode: string
  metricLabel: string
  implementationKind: string
}

interface ScoreSubmitInput {
  resultsJsonl?: string
  aggregate?: Record<string, unknown>
  aggregateWarning?: string
}

interface RunnerExecContext {
  prompt: {
    body: string | null
    bodyKind: string
    providerSettings: Record<string, unknown>
    promptId?: string
    promptVersionId: string
    runnerVersionId: string
  }
  scorer?: {
    versionId: string
    metricKey: string
    higherIsBetter: boolean
  } | null
  rows: Array<{
    id: string
    row: Record<string, unknown>
  }>
}

type DatasetUploadSourceType = 'csv' | 'json' | 'jsonl'

const MAX_README_LENGTH = 200_000

interface DatasetUploadResponse {
  dataset: {
    id: string
    name: string
    rowCount: number
    sourceType: string
    url?: string
  }
  readmeVersion?: {
    id: string
    version_num: number
    created_at: string
  } | null
}

interface TeamMember {
  id: string
  user_id: string | null
  email: string
  role: string
  joined_at: string
}

interface TaskStatusPayload {
  task: {
    id: string
    title: string
    status: string
    createdAt: string
    teamSlug: string
    teamName: string
    projectSlug: string
    projectName: string
    datasetRowCount: number
    requiredAssignmentsPerRow: number
    totalRequiredAssignments: number
    counts: {
      completed: number
      inProgress: number
      pending: number
      skipped: number
    }
    progressPercentage: number
    assignees: Array<{
      assigneeId: string
      email: string
      completed: number
      inProgress: number
      pending: number
      skipped: number
      total: number
    }>
  }
}

const TASK_STATUS_ACTION_LABELS = {
  paused: {
    verb: 'pause',
    pastTense: 'Paused',
  },
  active: {
    verb: 'unpause',
    pastTense: 'Unpaused',
  },
  completed: {
    verb: 'complete',
    pastTense: 'Completed',
  },
} as const

function getCliVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  ) as { version?: unknown }

  if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
    throw new Error('Unable to read orizu CLI version.')
  }

  return packageJson.version
}

function printLine(message = '') {
  output.write(`${message}\n`)
}

function printVersion() {
  printLine(`orizu ${getCliVersion()}`)
}

function printBannerIfInteractive() {
  if (!process.stdout.isTTY) {
    return
  }
  printLine(renderBanner())
  printLine('')
}

function printUsage() {
  printBannerIfInteractive()
  printLine(renderRootHelp())
}

let cliArgs = process.argv.slice(2)
let cliJsonOutput = false

function getArg(name: string): string | null {
  const index = cliArgs.indexOf(name)
  if (index === -1 || index + 1 >= cliArgs.length) {
    return null
  }

  return cliArgs[index + 1]
}

function getArgs(name: string): string[] {
  const values: string[] = []
  for (let index = 0; index < cliArgs.length; index += 1) {
    if (cliArgs[index] !== name) {
      continue
    }

    const value = cliArgs[index + 1]
    if (!value || value.startsWith('-')) {
      throw new Error(`Usage: ${name} <value>`)
    }

    values.push(value)
    index += 1
  }

  return values
}

function getOptionalArgValue(name: string): string | null {
  const index = cliArgs.indexOf(name)
  if (index === -1 || index + 1 >= cliArgs.length) {
    return null
  }

  const value = cliArgs[index + 1]
  if (!value || value.startsWith('-')) {
    return null
  }

  return value
}

function rejectDashPrefixedOptionValue(name: string, value: string | null) {
  if (value && value.startsWith('-')) {
    throw new Error(`Invalid value for ${name}: option values cannot start with a dash`)
  }
}

export function normalizeSlugInput(slug: string): string {
  return slug.trim().toLowerCase()
}

function isInteractiveTerminal() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

function hasArg(name: string): boolean {
  return cliArgs.includes(name)
}

export function expandHomePath(path: string): string {
  if (path.startsWith('~/')) {
    const home = process.env.HOME || ''
    return `${home}/${path.slice(2)}`
  }

  return path
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

function createCodeVerifier(): string {
  return randomBytes(32).toString('base64url')
}

export function createCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export function sanitizeTerminalText(value: unknown): string {
  return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
}

function printError(message: string): void {
  console.error(sanitizeTerminalText(message))
}

export function validateBrowserUrl(url: string, expectedOrigin?: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Server returned an invalid browser URL.')
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Server returned an unsupported browser URL scheme.')
  }

  if (parsed.username || parsed.password) {
    throw new Error('Server returned a browser URL containing credentials.')
  }

  if (expectedOrigin && parsed.origin !== expectedOrigin) {
    throw new Error('Server returned a browser URL for an unexpected origin.')
  }

  return parsed
}

function openInBrowser(url: string) {
  const parsed = validateBrowserUrl(url)
  const platform = process.platform
  const href = parsed.href
  if (platform === 'darwin') {
    spawn('open', [href], {
      detached: true,
      stdio: 'ignore',
    }).unref()
    return
  }

  if (platform === 'win32') {
    spawn('rundll32.exe', ['url.dll,FileProtocolHandler', href], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref()
    return
  }

  spawn('xdg-open', [href], {
    detached: true,
    stdio: 'ignore',
  }).unref()
}

export function formatTerminalLink(url: string): string {
  const safeUrl = sanitizeTerminalText(url)
  try {
    const parsed = validateBrowserUrl(safeUrl)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return safeUrl
    }
  } catch {
    return safeUrl
  }

  if (!isInteractiveTerminal()) {
    return safeUrl
  }

  return `\u001B]8;;${safeUrl}\u0007${safeUrl}\u001B]8;;\u0007`
}

export async function parseJsonResponse<T>(response: Response, context: string): Promise<T> {
  const contentType = response.headers.get('content-type') || ''
  const rawBody = await response.text()

  if (!contentType.includes('application/json')) {
    throw new Error(
      `${context} returned non-JSON response (status ${response.status}). ` +
      `Body preview: ${sanitizeTerminalText(rawBody.slice(0, 180))}`
    )
  }

  try {
    return JSON.parse(rawBody) as T
  } catch {
    throw new Error(
      `${context} returned invalid JSON (status ${response.status}). ` +
      `Body preview: ${sanitizeTerminalText(rawBody.slice(0, 180))}`
    )
  }
}

function shellQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function getStoredAuthTokenForBaseUrl(baseUrl: string): string {
  const credentials = getServerCredentials(baseUrl)
  if (!credentials) {
    throw new Error(`Not logged in for ${baseUrl}. Run \`orizu login --server ${baseUrl}\` (or \`--local\`) first.`)
  }

  return 'accessToken' in credentials ? credentials.accessToken : credentials.apiKey
}

function printPromptSummaries(items: PromptSummary[], emptyMessage: string) {
  if (items.length === 0) {
    printLine(emptyMessage)
    return
  }

  const rows = items.map(item => ({
    id: sanitizeTerminalText(item.id),
    name: sanitizeTerminalText(item.name),
    role: sanitizeTerminalText(item.role),
    status: sanitizeTerminalText(item.status || 'active'),
  }))
  const idWidth = Math.max('ID'.length, ...rows.map(row => row.id.length))
  const nameWidth = Math.max('NAME'.length, ...rows.map(row => row.name.length))
  const roleWidth = Math.max('ROLE'.length, ...rows.map(row => row.role.length))
  const statusWidth = Math.max('STATUS'.length, ...rows.map(row => row.status.length))

  printLine(`${'ID'.padEnd(idWidth)}  ${'NAME'.padEnd(nameWidth)}  ${'ROLE'.padEnd(roleWidth)}  ${'STATUS'.padEnd(statusWidth)}`)
  printLine(`${'-'.repeat(idWidth)}  ${'-'.repeat(nameWidth)}  ${'-'.repeat(roleWidth)}  ${'-'.repeat(statusWidth)}`)
  rows.forEach(row => {
    printLine(`${row.id.padEnd(idWidth)}  ${row.name.padEnd(nameWidth)}  ${row.role.padEnd(roleWidth)}  ${row.status.padEnd(statusWidth)}`)
  })
}

function printScorerSummaries(items: ScorerSummary[]) {
  if (items.length === 0) {
    printLine('No scorers found.')
    return
  }

  const rows = items.map(item => ({
    id: sanitizeTerminalText(item.id),
    name: sanitizeTerminalText(item.name),
    mode: sanitizeTerminalText(item.mode),
    metric: sanitizeTerminalText(item.metricLabel),
    implementation: sanitizeTerminalText(item.implementationKind),
  }))
  const idWidth = Math.max('ID'.length, ...rows.map(row => row.id.length))
  const nameWidth = Math.max('NAME'.length, ...rows.map(row => row.name.length))
  const modeWidth = Math.max('MODE'.length, ...rows.map(row => row.mode.length))
  const metricWidth = Math.max('METRIC'.length, ...rows.map(row => row.metric.length))

  printLine(`${'ID'.padEnd(idWidth)}  ${'NAME'.padEnd(nameWidth)}  ${'MODE'.padEnd(modeWidth)}  ${'METRIC'.padEnd(metricWidth)}  IMPLEMENTATION`)
  printLine(`${'-'.repeat(idWidth)}  ${'-'.repeat(nameWidth)}  ${'-'.repeat(modeWidth)}  ${'-'.repeat(metricWidth)}  ${'-'.repeat('IMPLEMENTATION'.length)}`)
  rows.forEach(row => {
    printLine(`${row.id.padEnd(idWidth)}  ${row.name.padEnd(nameWidth)}  ${row.mode.padEnd(modeWidth)}  ${row.metric.padEnd(metricWidth)}  ${row.implementation}`)
  })
}

function readJsonObjectArg(valueArg: string | null, label: string): Record<string, unknown> {
  if (!valueArg) {
    return {}
  }

  const trimmed = valueArg.trim()
  const raw = trimmed.startsWith('{')
    ? trimmed
    : readSourceFile(trimmed.startsWith('@') ? trimmed.slice(1) : trimmed)

  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('JSON root must be an object')
    }
    return parsed as Record<string, unknown>
  } catch (error: unknown) {
    throw new Error(`Invalid ${label} '${valueArg}': ${getErrorMessage(error)}`)
  }
}

function readJsonPayloadArg(pathArg: string | null): Record<string, unknown> {
  return readJsonObjectArg(pathArg, 'event payload')
}

async function promptSelect<T>(
  title: string,
  items: T[],
  label: (item: T, index: number) => string,
  options?: { forcePrompt?: boolean }
): Promise<T> {
  if (items.length === 0) {
    throw new Error(`No options available for ${title.toLowerCase()}`)
  }

  if (!isInteractiveTerminal()) {
    throw new Error(
      `${title} selection requires interactive terminal. Provide flags explicitly instead.`
    )
  }

  if (items.length === 1 && !options?.forcePrompt) {
    return items[0]
  }

  printLine(`\n${sanitizeTerminalText(title)}`)
  items.forEach((item, index) => {
    printLine(`  ${index + 1}. ${sanitizeTerminalText(label(item, index))}`)
  })

  const rl = createInterface({ input, output })
  try {
    while (true) {
      const answer = (await rl.question('Choose a number: ')).trim()
      const chosenIndex = Number(answer)
      if (Number.isInteger(chosenIndex) && chosenIndex >= 1 && chosenIndex <= items.length) {
        return items[chosenIndex - 1]
      }

      printLine('Invalid selection. Enter a valid number from the list.')
    }
  } finally {
    rl.close()
  }
}

async function fetchTeams(): Promise<Team[]> {
  const response = await authedFetch('/api/cli/teams')
  if (!response.ok) {
    throw new Error(`Failed to fetch teams: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{ teams: Team[] }>(response, 'Teams list')
  return data.teams
}

async function fetchProjects(teamSlug?: string): Promise<Project[]> {
  const normalizedTeamSlug = teamSlug ? normalizeSlugInput(teamSlug) : undefined
  const query = normalizedTeamSlug ? `?teamSlug=${encodeURIComponent(normalizedTeamSlug)}` : ''
  const response = await authedFetch(`/api/cli/projects${query}`)
  if (!response.ok) {
    throw new Error(`Failed to fetch projects: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{ projects: Project[] }>(response, 'Projects list')
  return data.projects
}

async function fetchTasks(project?: string): Promise<Task[]> {
  const query = project ? `?project=${encodeURIComponent(project)}` : ''
  const response = await authedFetch(`/api/cli/tasks${query}`)
  if (!response.ok) {
    throw new Error(`Failed to fetch tasks: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{ tasks: Task[] }>(response, 'Tasks list')
  return data.tasks
}

async function fetchApps(project: string): Promise<AppSummary[]> {
  const response = await authedFetch(`/api/cli/apps?project=${encodeURIComponent(project)}`)
  if (!response.ok) {
    throw new Error(`Failed to fetch apps: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{ apps: AppSummary[] }>(response, 'Apps list')
  return data.apps
}

async function fetchDatasets(project: string): Promise<DatasetSummary[]> {
  const response = await authedFetch(`/api/cli/datasets?project=${encodeURIComponent(project)}`)
  if (!response.ok) {
    throw new Error(`Failed to fetch datasets: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{ datasets: DatasetSummary[] }>(response, 'Datasets list')
  return data.datasets
}

async function fetchTeamMembers(teamSlug: string): Promise<TeamMember[]> {
  const response = await authedFetch(`/api/cli/teams/${encodeURIComponent(teamSlug)}/members`)
  if (!response.ok) {
    throw new Error(`Failed to fetch team members: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{ members: TeamMember[] }>(response, 'Team members list')
  return data.members
}

async function createTeamOnServer(name: string): Promise<Team> {
  const response = await authedFetch('/api/cli/teams', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })

  if (!response.ok) {
    throw new Error(`Failed to create team: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{ team: Team }>(response, 'Team create')
  return data.team
}

async function createProjectOnServer(teamSlug: string, name: string): Promise<Project> {
  const response = await authedFetch('/api/cli/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamSlug, name }),
  })

  if (!response.ok) {
    throw new Error(`Failed to create project: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{
    project: {
      id: string
      name: string
      slug: string
      teamId?: string
      teamName?: string
      teamSlug: string
      role?: string
    }
  }>(response, 'Project create')

  return {
    id: data.project.id,
    name: data.project.name,
    slug: data.project.slug,
    teamId: data.project.teamId || '',
    teamName: data.project.teamName || data.project.teamSlug,
    teamSlug: data.project.teamSlug,
    role: data.project.role || 'admin',
  }
}

async function resolveProjectSelection(projectArg: string | null): Promise<Project> {
  projectArg = projectArg || process.env.ORIZU_PROJECT || null
  const teams = await fetchTeams()

  if (teams.length === 0) {
    throw new Error('No accessible teams found for this user.')
  }

  if (!projectArg) {
    const team = await promptSelect(
      'Select a team',
      teams,
      teamOption => `${teamOption.name} (${teamOption.slug})`,
      { forcePrompt: true }
    )

    const projects = await fetchProjects(team.slug)
    const project = await promptSelect(
      `Select a project in ${team.slug}`,
      projects,
      projectOption => `${projectOption.name} (${projectOption.teamSlug}/${projectOption.slug})`,
      { forcePrompt: true }
    )

    return project
  }

  const segments = projectArg.split('/')
  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    throw new Error('Project must be in format teamSlug/projectSlug')
  }
  const [teamSlug, projectSlug] = segments.map(normalizeSlugInput)

  const matchedTeam = teams.find(team => team.slug === teamSlug)
  if (!matchedTeam) {
    printError(`Team '${teamSlug}' not found in your accessible teams.`)
    const selectedTeam = await promptSelect(
      'Select a team',
      teams,
      team => `${team.name} (${team.slug})`
    )

    const projects = await fetchProjects(selectedTeam.slug)
    const selectedProject = await promptSelect(
      `Select a project in ${selectedTeam.slug}`,
      projects,
      project => `${project.name} (${project.teamSlug}/${project.slug})`
    )

    return selectedProject
  }

  const projects = await fetchProjects(matchedTeam.slug)
  const matchedProject = projects.find(project => project.slug === projectSlug)

  if (!matchedProject) {
    printError(`Project '${projectSlug}' not found in team '${matchedTeam.slug}'.`)
    const selectedProject = await promptSelect(
      `Select a project in ${matchedTeam.slug}`,
      projects,
      project => `${project.name} (${project.teamSlug}/${project.slug})`
    )

    return selectedProject
  }

  return matchedProject
}

async function resolveProjectSlug(projectArg: string | null): Promise<string> {
  const project = await resolveProjectSelection(projectArg)
  return `${project.teamSlug}/${project.slug}`
}

async function selectTaskIdInteractively(): Promise<string> {
  const team = await promptSelect(
    'Select a team',
    await fetchTeams(),
    item => `${item.name} (${item.slug})`,
    { forcePrompt: true }
  )

  const project = await promptSelect(
    `Select a project in ${team.slug}`,
    await fetchProjects(team.slug),
    item => `${item.name} (${item.teamSlug}/${item.slug})`,
    { forcePrompt: true }
  )

  const tasks = await fetchTasks(`${project.teamSlug}/${project.slug}`)
  const task = await promptSelect(
    `Select a task in ${project.teamSlug}/${project.slug}`,
    tasks,
    item => `${item.title} [${item.status}] (${item.id})`,
    { forcePrompt: true }
  )

  return task.id
}

async function selectAppIdInteractively(projectArg: string | null): Promise<{ appId: string; project: string }> {
  let project = projectArg
  if (!project) {
    project = await resolveProjectSlug(null)
  }

  const apps = await fetchApps(project)
  const app = await promptSelect(
    `Select an app in ${project}`,
    apps,
    item => `${item.name} (id=${item.id}, v${item.currentVersionNum})`,
    { forcePrompt: true }
  )

  return {
    appId: app.id,
    project,
  }
}

async function selectDatasetInteractively(projectArg: string | null): Promise<DatasetSelection> {
  let project = projectArg
  if (!project) {
    project = await resolveProjectSlug(null)
  }

  const datasets = await fetchDatasets(project)
  const dataset = await promptSelect(
    `Select a dataset in ${project}`,
    datasets,
    item => `${item.name} (id=${item.id}, rows=${item.rowCount})`,
    { forcePrompt: true }
  )

  return {
    datasetId: dataset.id,
    project,
    name: dataset.name,
  }
}

function printTeams(teams: Team[]) {
  if (teams.length === 0) {
    printLine('No teams found.')
    return
  }

  const rows = teams.map(team => ({
    slug: sanitizeTerminalText(team.slug),
    name: sanitizeTerminalText(team.name || '-'),
    role: sanitizeTerminalText(team.role || '-'),
  }))

  const slugWidth = Math.max('TEAM SLUG'.length, ...rows.map(row => row.slug.length))
  const nameWidth = Math.max('TEAM NAME'.length, ...rows.map(row => row.name.length))
  const roleWidth = Math.max('ROLE'.length, ...rows.map(row => row.role.length))

  printLine(
    `${'TEAM SLUG'.padEnd(slugWidth)}  ${'TEAM NAME'.padEnd(nameWidth)}  ${'ROLE'.padEnd(roleWidth)}`
  )
  printLine(
    `${'-'.repeat(slugWidth)}  ${'-'.repeat(nameWidth)}  ${'-'.repeat(roleWidth)}`
  )

  rows.forEach(row => {
    printLine(`${row.slug.padEnd(slugWidth)}  ${row.name.padEnd(nameWidth)}  ${row.role.padEnd(roleWidth)}`)
  })
}

function printProjects(projects: Project[]) {
  if (projects.length === 0) {
    printLine('No projects found.')
    return
  }

  const rows = projects.map(project => ({
    project: sanitizeTerminalText(`${project.teamSlug}/${project.slug}`),
    name: sanitizeTerminalText(project.name || '-'),
    role: sanitizeTerminalText(project.role || '-'),
  }))

  const projectWidth = Math.max('TEAM/PROJECT'.length, ...rows.map(row => row.project.length))
  const nameWidth = Math.max('PROJECT NAME'.length, ...rows.map(row => row.name.length))
  const roleWidth = Math.max('ROLE'.length, ...rows.map(row => row.role.length))

  printLine(
    `${'TEAM/PROJECT'.padEnd(projectWidth)}  ${'PROJECT NAME'.padEnd(nameWidth)}  ${'ROLE'.padEnd(roleWidth)}`
  )
  printLine(
    `${'-'.repeat(projectWidth)}  ${'-'.repeat(nameWidth)}  ${'-'.repeat(roleWidth)}`
  )

  rows.forEach(row => {
    printLine(
      `${row.project.padEnd(projectWidth)}  ${row.name.padEnd(nameWidth)}  ${row.role.padEnd(roleWidth)}`
    )
  })
}

function printTasks(tasks: Task[]) {
  if (tasks.length === 0) {
    printLine('No tasks found.')
    return
  }

  const rows = tasks.map(task => ({
    id: sanitizeTerminalText(task.id),
    name: sanitizeTerminalText(task.title || '-'),
    status: sanitizeTerminalText(task.status || '-'),
    project: task.teamSlug && task.projectSlug
      ? sanitizeTerminalText(`${task.teamSlug}/${task.projectSlug}`)
      : 'unknown-project',
  }))

  const idWidth = Math.max('TASK ID'.length, ...rows.map(row => row.id.length))
  const nameWidth = Math.max('TASK NAME'.length, ...rows.map(row => row.name.length))
  const statusWidth = Math.max('STATUS'.length, ...rows.map(row => row.status.length))

  printLine(
    `${'TASK ID'.padEnd(idWidth)}  ${'TASK NAME'.padEnd(nameWidth)}  ${'STATUS'.padEnd(statusWidth)}  TEAM/PROJECT`
  )
  printLine(
    `${'-'.repeat(idWidth)}  ${'-'.repeat(nameWidth)}  ${'-'.repeat(statusWidth)}  ------------`
  )

  rows.forEach(row => {
    printLine(
      `${row.id.padEnd(idWidth)}  ${row.name.padEnd(nameWidth)}  ${row.status.padEnd(statusWidth)}  ${row.project}`
    )
  })
}

function printApps(apps: AppSummary[]) {
  if (apps.length === 0) {
    printLine('No apps found.')
    return
  }

  const rows = apps.map(app => ({
    id: sanitizeTerminalText(app.id),
    name: sanitizeTerminalText(app.name || '-'),
    version: `v${app.currentVersionNum || 1}`,
  }))

  const idWidth = Math.max('APP ID'.length, ...rows.map(row => row.id.length))
  const nameWidth = Math.max('APP NAME'.length, ...rows.map(row => row.name.length))
  const versionWidth = Math.max('VERSION'.length, ...rows.map(row => row.version.length))

  printLine(`${'APP ID'.padEnd(idWidth)}  ${'APP NAME'.padEnd(nameWidth)}  ${'VERSION'.padEnd(versionWidth)}`)
  printLine(`${'-'.repeat(idWidth)}  ${'-'.repeat(nameWidth)}  ${'-'.repeat(versionWidth)}`)

  rows.forEach(row => {
    printLine(`${row.id.padEnd(idWidth)}  ${row.name.padEnd(nameWidth)}  ${row.version.padEnd(versionWidth)}`)
  })
}

function printTeamMembers(members: TeamMember[]) {
  if (members.length === 0) {
    printLine('No team members found.')
    return
  }

  const rows = members.map(member => ({
    id: sanitizeTerminalText(member.id),
    userId: sanitizeTerminalText(member.user_id || '-'),
    email: sanitizeTerminalText(member.email || '-'),
    role: sanitizeTerminalText(member.role || '-'),
  }))

  const idWidth = Math.max('MEMBER ID'.length, ...rows.map(row => row.id.length))
  const userIdWidth = Math.max('USER ID'.length, ...rows.map(row => row.userId.length))
  const emailWidth = Math.max('EMAIL'.length, ...rows.map(row => row.email.length))
  const roleWidth = Math.max('ROLE'.length, ...rows.map(row => row.role.length))

  printLine(
    `${'MEMBER ID'.padEnd(idWidth)}  ${'USER ID'.padEnd(userIdWidth)}  ${'EMAIL'.padEnd(emailWidth)}  ${'ROLE'.padEnd(roleWidth)}`
  )
  printLine(
    `${'-'.repeat(idWidth)}  ${'-'.repeat(userIdWidth)}  ${'-'.repeat(emailWidth)}  ${'-'.repeat(roleWidth)}`
  )
  rows.forEach(row => {
    printLine(
      `${row.id.padEnd(idWidth)}  ${row.userId.padEnd(userIdWidth)}  ${row.email.padEnd(emailWidth)}  ${row.role.padEnd(roleWidth)}`
    )
  })
}

function printTaskStatusSummary(data: TaskStatusPayload) {
  const task = data.task
  printLine(`Task: ${sanitizeTerminalText(task.title)} (${sanitizeTerminalText(task.id)})`)
  printLine(`Status: ${sanitizeTerminalText(task.status)}`)
  printLine(`Project: ${sanitizeTerminalText(`${task.teamSlug}/${task.projectSlug}`)}`)
  printLine(`Progress: ${task.progressPercentage}%`)
  printLine(`Counts: completed=${task.counts.completed}, in_progress=${task.counts.inProgress}, pending=${task.counts.pending}, skipped=${task.counts.skipped}`)
  printLine(`Required assignments: ${task.totalRequiredAssignments} (${task.datasetRowCount} rows x ${task.requiredAssignmentsPerRow})`)

  if (task.assignees.length > 0) {
    printLine('\nAssignees')
    task.assignees.forEach(assignee => {
      printLine(
        `  ${sanitizeTerminalText(assignee.email)}: total=${assignee.total}, completed=${assignee.completed}, in_progress=${assignee.inProgress}, pending=${assignee.pending}, skipped=${assignee.skipped}`
      )
    })
  }
}

const DEFAULT_AUTH_CALLBACK_PORT = 43123

function resolveAuthCallbackPort(): number {
  const envPort = process.env.ORIZU_AUTH_PORT
  if (!envPort) {
    return DEFAULT_AUTH_CALLBACK_PORT
  }

  const parsed = parseInt(envPort, 10)
  if (Number.isNaN(parsed) || parsed < 1024 || parsed > 65535) {
    throw new Error(
      `Invalid ORIZU_AUTH_PORT: '${envPort}'. Must be a number between 1024 and 65535.`
    )
  }

  return parsed
}

function renderCliAuthBrowserPage(status: 'success' | 'error'): string {
  const isSuccess = status === 'success'
  const eyebrow = isSuccess ? '// cli login complete' : '// cli login'
  const title = isSuccess ? 'Browser authorization complete' : 'Missing authorization code'
  const detail = isSuccess
    ? 'Your terminal will finish connecting the Orizu CLI. You can close this tab.'
    : 'Close this tab and run orizu login again to start a fresh browser request.'
  const accent = isSuccess ? '#E8923C' : '#C8442A'

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Orizu CLI Login</title>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500;700&display=swap');
      :root {
        color-scheme: light;
        --paper: #F4EFE3;
        --border: #E6DFCE;
        --ink: #353535;
        --muted: #6B6358;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        background: #FFFFFF;
        color: #4B4B4B;
        font-family: 'Geist Mono', Menlo, Monaco, Consolas, monospace;
        letter-spacing: -0.025em;
      }
      main {
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 48px 24px;
      }
      section {
        width: min(100%, 520px);
        text-align: center;
      }
      .brand {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
        margin-bottom: 28px;
      }
      .brand svg {
        width: 42px;
        height: 42px;
        color: #202124;
      }
      .brand span {
        color: #000000;
        font-size: 16px;
        font-weight: 700;
      }
      .eyebrow {
        margin: 0 0 12px;
        color: ${accent};
        font-size: 12px;
        text-transform: lowercase;
      }
      h1 {
        margin: 0 0 8px;
        color: var(--ink);
        font-size: 24px;
        line-height: 1.15;
        letter-spacing: -0.05em;
      }
      .detail {
        margin: 0;
        color: var(--muted);
        font-size: 13px;
        line-height: 1.6;
      }
    </style>
  </head>
  <body>
    <main>
      <section>
        <div class="brand" aria-hidden="true">
          <svg viewBox="0 0 2048 2048" xmlns="http://www.w3.org/2000/svg">
            <g fill="currentColor">
              <polygon points="1545,879 787,1195 1189,1577"></polygon>
              <polygon points="992,624 444,1104 688,1338"></polygon>
              <polygon points="602,1593 1180,1594 768,1202"></polygon>
              <polygon points="1650,1195 1398,1203 1204,1594 1229,1593"></polygon>
              <polygon points="807,413 751,509 823,744 980,608"></polygon>
              <polygon points="441,1127 592,1572 681,1356"></polygon>
              <polygon points="793,399 611,457 604,471 658,602"></polygon>
              <polygon points="593,493 498,667 636,600"></polygon>
            </g>
          </svg>
          <span>orizu</span>
        </div>
        <p class="eyebrow">${eyebrow}</p>
        <h1>${title}</h1>
        <p class="detail">${detail}</p>
      </section>
    </main>
  </body>
</html>`
}

async function login() {
  const baseUrl = hasArg('--no-prompt-if-logged-in') ? getBaseUrl() : resolveLoginBaseUrl()
  assertSecureTokenTransport(baseUrl)

  if (hasArg('--no-prompt-if-logged-in') && getServerCredentials(baseUrl)) {
    if (hasJsonFlag()) {
      printJson({ status: 'already-logged-in', server: baseUrl })
      return
    }
    printLine(`Already logged in to ${sanitizeTerminalText(baseUrl)}.`)
    return
  }

  const codeVerifier = createCodeVerifier()
  const codeChallenge = createCodeChallenge(codeVerifier)
  const callbackPort = resolveAuthCallbackPort()

  const callbackCode = await new Promise<string>((resolve, reject) => {
    const server = createServer((request, response) => {
      try {
        const url = new URL(request.url || '/', `http://127.0.0.1:${callbackPort}`)
        const code = url.searchParams.get('code')

        if (!code) {
          response.statusCode = 400
          response.setHeader('content-type', 'text/html; charset=utf-8')
          response.end(renderCliAuthBrowserPage('error'))
          return
        }

        response.statusCode = 200
        response.setHeader('content-type', 'text/html; charset=utf-8')
        response.end(renderCliAuthBrowserPage('success'))

        server.close()
        resolve(code)
      } catch (error) {
        server.close()
        reject(error)
      }
    })

    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(
          `Port ${callbackPort} is already in use. Set ORIZU_AUTH_PORT to a different port (1024–65535) and retry.`
        ))
      } else {
        reject(error)
      }
    })

    server.listen(callbackPort, '127.0.0.1', async () => {
      try {
        const redirectUri = `http://127.0.0.1:${callbackPort}/callback`
        const response = await fetch(`${baseUrl}/api/cli/auth/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ codeChallenge, redirectUri }),
        })

        if (!response.ok) {
          const text = await response.text()
          server.close()
          reject(new Error(`Failed to start login: ${text}`))
          return
        }

        const { authorizeUrl } = await parseJsonResponse<{ authorizeUrl: string }>(
          response,
          'CLI auth start'
        )
        const safeAuthorizeUrl = validateBrowserUrl(authorizeUrl, baseUrl).href
        printLine(`Opening browser for login: ${sanitizeTerminalText(safeAuthorizeUrl)}`)
        openInBrowser(safeAuthorizeUrl)
      } catch (error) {
        server.close()
        reject(error)
      }
    })
  })

  const exchangeResponse = await fetch(`${baseUrl}/api/cli/auth/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: callbackCode, codeVerifier }),
  })

  if (!exchangeResponse.ok) {
    const text = await exchangeResponse.text()
    throw new Error(`Failed to exchange auth code: ${text}`)
  }

  const loginData = await parseJsonResponse<LoginResponse>(exchangeResponse, 'CLI auth exchange')
  if (!loginData.apiKey) {
    throw new Error('Server did not return an API key. Upgrade the Orizu server and run `orizu login` again.')
  }

  saveServerCredentials(baseUrl, {
    credentialType: 'pat',
    apiKey: loginData.apiKey,
  })

  if (hasJsonFlag()) {
    printJson({
      status: 'logged-in',
      server: baseUrl,
      user: { id: loginData.user.id, email: loginData.user.email ?? null },
    })
    return
  }
  printLine(`Logged in as ${sanitizeTerminalText(loginData.user.email ?? loginData.user.id)}`)
}

async function whoami() {
  const response = await authedFetch('/api/cli/auth/whoami')
  if (!response.ok) {
    throw new Error(`whoami failed: ${await response.text()}`)
  }

  const data = await response.json() as { user: { id: string; email: string | null } }
  if (hasJsonFlag()) {
    printJson({ user: data.user, server: getBaseUrl() })
    return
  }
  printLine(sanitizeTerminalText(data.user.email ?? data.user.id))
}

async function logout() {
  const baseUrl = getBaseUrl()
  const credentials = getServerCredentials(baseUrl)
  if (!credentials) {
    if (hasJsonFlag()) {
      printJson({ status: 'already-logged-out', server: baseUrl })
      return
    }
    printLine(`Already logged out for ${sanitizeTerminalText(baseUrl)}.`)
    return
  }

  let remoteLogoutError: string | null = null
  try {
    assertSecureTokenTransport(baseUrl)
    const response = await fetch(`${baseUrl}/api/cli/auth/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${'accessToken' in credentials ? credentials.accessToken : credentials.apiKey}`,
      },
      body: 'refreshToken' in credentials
        ? JSON.stringify({ refreshToken: credentials.refreshToken })
        : undefined,
    })

    if (!response.ok) {
      remoteLogoutError = sanitizeTerminalText(await response.text()).slice(0, 180)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    remoteLogoutError = sanitizeTerminalText(message).slice(0, 180)
  }

  clearServerCredentials(baseUrl)
  if (hasJsonFlag()) {
    printJson({ status: 'logged-out', server: baseUrl, remoteLogoutError })
    return
  }
  if (remoteLogoutError) {
    console.warn(`Warning: remote logout failed: ${remoteLogoutError}`)
  }
  printLine(`Logged out from ${sanitizeTerminalText(baseUrl)}.`)
}

async function printEnv() {
  const baseUrl = getBaseUrl()
  const token = getStoredAuthTokenForBaseUrl(baseUrl)
  const projectArg = getArg('--project')
  const project = projectArg ? await resolveProjectSelection(projectArg) : null
  const projectId = project?.id || getArg('--project-id') || process.env.ORIZU_PROJECT_ID || ''
  const projectSlug = project ? `${project.teamSlug}/${project.slug}` : process.env.ORIZU_PROJECT || ''

  if (hasJsonFlag()) {
    printJson({
      ORIZU_API_URL: baseUrl,
      ORIZU_TOKEN: token,
      ORIZU_PROJECT_ID: projectId,
      ...(projectSlug ? { ORIZU_PROJECT: projectSlug } : {}),
    })
    return
  }
  printLine(`export ORIZU_API_URL=${shellQuote(baseUrl)}`)
  printLine(`export ORIZU_TOKEN=${shellQuote(token)}`)
  printLine(`export ORIZU_PROJECT_ID=${shellQuote(projectId)}`)
  if (projectSlug) {
    printLine(`export ORIZU_PROJECT=${shellQuote(projectSlug)}`)
  }
}

async function logOptimizationEvent() {
  const eventType = cliArgs[1]
  const runId = getArg('--run-id')
  const sequenceArg = getArg('--sequence')
  const payload = readJsonPayloadArg(getArg('--payload'))
  const sequence = sequenceArg ? Number(sequenceArg) : Number.NaN

  if (!eventType || eventType.startsWith('--') || !runId || !Number.isInteger(sequence) || sequence <= 0) {
    throw new Error('Usage: orizu log <event_type> --run-id <id> --sequence <n> --payload @event.json')
  }

  const response = await authedFetch(`/api/cli/optimization-runs/${encodeURIComponent(runId)}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventId: getArg('--event-id') || randomUUID(),
      sequence,
      eventType,
      eventLayer: getArg('--event-layer') || 'core',
      optimizerFamily: getArg('--optimizer-family'),
      iteration: getArg('--iteration') ? Number(getArg('--iteration')) : undefined,
      candidateId: getArg('--candidate-id'),
      parentCandidateId: getArg('--parent-candidate-id'),
      childCandidateId: getArg('--child-candidate-id'),
      payload,
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to log event: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{ eventId: string }>(response, 'Optimization event log')
  if (hasJsonFlag()) {
    printJson({ eventId: data.eventId })
    return
  }
  printLine(`Logged event ${sanitizeTerminalText(data.eventId)}`)
}

async function listPrompts() {
  const project = getArg('--project') || await resolveProjectSlug(null)
  const status = getArg('--status') || 'active'
  if (!['active', 'archived', 'all'].includes(status)) {
    throw new Error('Usage: orizu prompts list --project <team/project> [--status active|archived|all]')
  }

  const params = new URLSearchParams({ project, status })
  const response = await authedFetch(`/api/cli/prompts?${params.toString()}`)
  if (!response.ok) {
    throw new Error(`Failed to fetch prompts: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{ prompts: PromptSummary[] }>(response, 'Prompts list')
  if (hasJsonFlag()) {
    printJson(data as unknown as Record<string, unknown>)
    return
  }
  printPromptSummaries(data.prompts, 'No prompts found.')
}

async function listJudges() {
  const project = getArg('--project') || await resolveProjectSlug(null)
  const status = getArg('--status') || 'active'
  if (!['active', 'archived', 'all'].includes(status)) {
    throw new Error('Usage: orizu judges list --project <team/project> [--status active|archived|all]')
  }

  const params = new URLSearchParams({ project, status })
  const response = await authedFetch(`/api/cli/judges?${params.toString()}`)
  if (!response.ok) {
    throw new Error(`Failed to fetch judges: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{ judges: PromptSummary[] }>(response, 'Judges list')
  if (hasJsonFlag()) {
    printJson(data as unknown as Record<string, unknown>)
    return
  }
  printPromptSummaries(data.judges, 'No judges found.')
}

async function listScorers() {
  const project = getArg('--project') || await resolveProjectSlug(null)
  const response = await authedFetch(`/api/cli/scorers?project=${encodeURIComponent(project)}`)
  if (!response.ok) {
    throw new Error(`Failed to fetch scorers: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{ scorers: ScorerSummary[] }>(response, 'Scorers list')
  if (hasJsonFlag()) {
    printJson(data as unknown as Record<string, unknown>)
    return
  }
  printScorerSummaries(data.scorers)
}

async function registerScorer() {
  const project = getArg('--project') || await resolveProjectSlug(null)
  const name = getArg('--name')
  const manifestPath = getArg('--manifest')

  if (!name || !manifestPath) {
    throw new Error('Usage: orizu scorers register --project <team/project> --name <name> --manifest <manifest.json> [--prompt-version <id>] [--runner-version <id>] [--label <label>] [--json]')
  }

  const manifest = readJsonFile(manifestPath)
  const response = await authedFetch(`/api/cli/scorers?project=${encodeURIComponent(project)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      manifest,
      promptVersionId: getArg('--prompt-version') || undefined,
      runnerVersionId: getArg('--runner-version') || undefined,
      label: getArg('--label') || undefined,
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to register scorer: ${await response.text()}`)
  }

  const data = await parseJsonResponse<Record<string, unknown>>(response, 'Scorer register')
  if (hasJsonFlag()) {
    printJson(data)
    return
  }

  printLine(`Registered scorer ${sanitizeTerminalText(name)} (${sanitizeTerminalText(String(data.scorer_version_id || 'unknown version'))})`)
}

async function showScorerDetail() {
  const scorerId = getPositionalArg(2)
  const project = getArg('--project') || await resolveProjectSlug(null)
  if (!scorerId) {
    throw new Error('Usage: orizu scorers detail <scorer-id-or-name> --project <team/project> [--json]')
  }

  const response = await authedFetch(`/api/cli/scorers/${encodeURIComponent(scorerId)}?project=${encodeURIComponent(project)}`)
  if (!response.ok) {
    throw new Error(`Failed to fetch scorer: ${await response.text()}`)
  }

  const data = await parseJsonResponse<Record<string, unknown>>(response, 'Scorer detail')
  if (hasJsonFlag()) {
    printJson(data)
    return
  }

  const scorer = data.scorer as Record<string, unknown> | undefined
  printLine(`${sanitizeTerminalText(String(scorer?.name || scorerId))}`)
  printLine(`Metric: ${sanitizeTerminalText(String(scorer?.metricLabel || 'Score'))}`)
}

async function setScorerLabel() {
  const scorerName = getPositionalArg(3)
  const label = getPositionalArg(4)
  const project = getArg('--project') || await resolveProjectSlug(null)
  const scorerVersionId = getArg('--version')

  if (!scorerName || !label || !scorerVersionId) {
    throw new Error('Usage: orizu scorers labels set <scorer-name> <label> --version <scorer-version-id> [--project <team/project>] [--json]')
  }

  const response = await authedFetch(`/api/cli/scorers/labels?project=${encodeURIComponent(project)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scorerName, label, scorerVersionId }),
  })

  if (!response.ok) {
    throw new Error(`Failed to set scorer label: ${await response.text()}`)
  }

  const data = await parseJsonResponse<Record<string, unknown>>(response, 'Scorer label set')
  if (hasJsonFlag()) {
    printJson(data)
    return
  }

  printLine(`Moved ${sanitizeTerminalText(label)} to ${sanitizeTerminalText(scorerVersionId)}`)
}

async function pushRunnerArtifact(kind: 'runner' | 'optimizer') {
  const artifactDir = getPositionalArg(2)
  const project = getArg('--project') || await resolveProjectSlug(null)
  const name = getArg('--name')
  const label = getArg('--label') || undefined

  if (!artifactDir) {
    throw new Error(`Usage: orizu ${kind === 'runner' ? 'runners' : 'optimizers'} push <dir> --project <team/project> [--name <name>] [--label <label>] [--json]`)
  }

  const manifest = readManifestFile(artifactDir)
  const artifactName = name || (typeof manifest.name === 'string' ? manifest.name : basename(expandHomePath(artifactDir)))
  const description = typeof manifest.description === 'string' ? manifest.description : undefined
  const { zipBase64, contentSha256 } = zipDirectoryToBase64(artifactDir)
  const endpoint = kind === 'runner' ? 'runners' : 'optimizers'
  const response = await authedFetch(`/api/cli/${endpoint}?project=${encodeURIComponent(project)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: artifactName,
      description,
      label,
      manifest,
      zipBase64,
      contentSha256,
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to push ${kind}: ${await response.text()}`)
  }

  const data = await parseJsonResponse<Record<string, unknown>>(response, `${kind} push`)
  if (hasJsonFlag()) {
    printJson(data)
    return
  }

  const versionId = kind === 'runner' ? data.runner_version_id : data.optimizer_version_id
  printLine(`Pushed ${kind} ${sanitizeTerminalText(String(artifactName))} (${sanitizeTerminalText(String(versionId || 'unknown version'))})`)
}

async function pushPromptArtifact(kind: 'prompt' | 'judge') {
  const promptDir = getPositionalArg(2)
  const project = getArg('--project') || await resolveProjectSlug(null)
  const runnerVersionArg = getArg('--runner-version')
  const parentVersionId = getArg('--parent') || undefined

  if (!promptDir) {
    throw new Error(`Usage: orizu ${kind === 'judge' ? 'judges' : 'prompts'} push <dir> --project <team/project> [--runner-version <id>] [--parent <version-id>] [--json]`)
  }

  const promptRoot = expandHomePath(promptDir)
  const manifest = readJsonFile(join(promptRoot, 'orizu.prompt.json'))
  const primaryText = readPromptPrimaryText(manifest, promptRoot)
  const sidecars = readPromptSidecars(manifest, promptRoot)
  const runnerFromManifest = stringFromRecord(manifest, 'runner_version_id') ||
    (isRecord(manifest.runner) ? stringFromRecord(manifest.runner, 'version_id') : undefined)
  const runnerVersionId = runnerVersionArg || runnerFromManifest
  if (!runnerVersionId) {
    throw new Error(`Usage: orizu ${kind === 'judge' ? 'judges' : 'prompts'} push <dir> --project <team/project> [--runner-version <id>] [--parent <version-id>] [--json]`)
  }
  const baseBundle = isRecord(manifest.bundle) ? manifest.bundle : {}
  const endpoint = kind === 'judge' ? 'judges' : 'prompts'
  const response = await authedFetch(`/api/cli/${endpoint}?project=${encodeURIComponent(project)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: manifest.name,
      role: kind === 'judge' && manifest.role === undefined ? 'judge_per_row' : manifest.role,
      description: manifest.description,
      body: primaryText.body,
      bodyKind: primaryText.bodyKind,
      providerSettings: manifest.provider_settings || {},
      bundle: {
        ...baseBundle,
        tags: manifest.tags || [],
        provenance: manifest.provenance || {},
        primaryText: {
          path: primaryText.path,
          kind: primaryText.bodyKind,
        },
        sidecars,
      },
      runnerVersionId,
      parentVersionId,
      versionLabel: manifest.version_label,
      createdBy: manifest.provenance || { kind: 'human-edit' },
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to push ${kind}: ${await response.text()}`)
  }

  const data = await parseJsonResponse<Record<string, unknown>>(response, `${kind} push`)
  if (hasJsonFlag()) {
    printJson(data)
    return
  }

  printLine(`Pushed ${kind} ${sanitizeTerminalText(String(manifest.name || promptDir))} (${sanitizeTerminalText(String(data.prompt_version_id || 'unknown version'))})`)
}

async function pullPromptArtifact(kind: 'prompt' | 'judge') {
  const promptRef = getPositionalArg(2)
  const project = getArg('--project') || await resolveProjectSlug(null)
  const outDir = getArg('--out')
  const label = getArg('--label')
  const version = getArg('--version')

  if (!promptRef || !outDir) {
    throw new Error(`Usage: orizu ${kind === 'judge' ? 'judges' : 'prompts'} pull <prompt-id-or-name> --project <team/project> --out <dir> [--label <label> | --version <version-id>] [--json]`)
  }
  if (label && version) {
    throw new Error('Use either --label or --version, not both')
  }

  const params = new URLSearchParams({ project })
  if (label) params.set('label', label)
  if (version) params.set('version', version)

  const endpoint = kind === 'judge' ? 'judges' : 'prompts'
  const response = await authedFetch(`/api/cli/${endpoint}/${encodeURIComponent(promptRef)}?${params.toString()}`)
  if (!response.ok) {
    throw new Error(`Failed to pull ${kind}: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{
    prompt: {
      id: string
      name: string
      role: string
      description?: string | null
    }
    version: {
      id: string
      versionNumber?: number
      versionLabel?: string | null
      body?: string | null
      bodyKind?: string | null
      providerSettings?: Record<string, unknown>
      runnerVersionId?: string | null
      bundle?: Record<string, unknown>
    }
    labels?: Array<{ label: string; promptVersionId: string }>
  }>(response, `${kind} pull`)

  const targetDir = expandHomePath(outDir)
  mkdirSync(targetDir, { recursive: true })

  const bundle = isRecord(data.version.bundle) ? data.version.bundle : {}
  const bundlePrimaryText = isRecord(bundle.primaryText)
    ? bundle.primaryText
    : isRecord(bundle.primary_text)
      ? bundle.primary_text
      : null
  const primaryPath = safeRelativePath(
    stringFromRecord(bundlePrimaryText || {}, 'path') || 'prompt.md',
    'prompt.md'
  )
  const bodyKind = stringFromRecord(bundlePrimaryText || {}, 'kind') || data.version.bodyKind || 'text'

  writeTextFileEnsuringDir(join(targetDir, primaryPath), data.version.body || '')

  const exportedSidecars: Array<Record<string, unknown>> = []
  const sidecars = Array.isArray(bundle.sidecars) ? bundle.sidecars : []
  for (const rawSidecar of sidecars) {
    if (!isRecord(rawSidecar)) continue
    const sidecarPathValue = stringFromRecord(rawSidecar, 'path')
    if (!sidecarPathValue) continue
    const sidecarPath = safeRelativePath(sidecarPathValue, sidecarPathValue)
    const content = typeof rawSidecar.content === 'string' ? rawSidecar.content : null
    const contentSha256 = stringFromRecord(rawSidecar, 'contentSha256') ||
      stringFromRecord(rawSidecar, 'content_sha256') ||
      (content !== null ? sha256Hex(content) : undefined)
    if (content !== null) {
      writeTextFileEnsuringDir(join(targetDir, sidecarPath), content)
    }
    const { content: _ignoredContent, contentSha256: _ignoredCamel, content_sha256: _ignoredSnake, ...metadata } = rawSidecar
    exportedSidecars.push({
      ...metadata,
      type: stringFromRecord(rawSidecar, 'type') || 'file',
      path: sidecarPath,
      ...(contentSha256 ? { content_sha256: contentSha256 } : {}),
    })
  }

  const labels = (data.labels || [])
    .filter(item => item.promptVersionId === data.version.id)
    .map(item => item.label)

  const manifest: Record<string, unknown> = {
    schema_version: 'orizu.prompt.v1',
    name: data.prompt.name,
    role: data.prompt.role,
    description: data.prompt.description || undefined,
    primary_text: {
      path: primaryPath,
      kind: bodyKind,
    },
    provider_settings: data.version.providerSettings || {},
    runner_version_id: data.version.runnerVersionId || undefined,
    version_id: data.version.id,
    version_number: data.version.versionNumber,
    version_label: data.version.versionLabel || undefined,
    labels,
    sidecars: exportedSidecars,
  }

  writeTextFileEnsuringDir(
    join(targetDir, 'orizu.prompt.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  )

  if (hasJsonFlag()) {
    printJson({
      prompt_id: data.prompt.id,
      prompt_version_id: data.version.id,
      path: targetDir,
    })
    return
  }

  printLine(`Pulled ${kind} ${sanitizeTerminalText(data.prompt.name)} to ${sanitizeTerminalText(targetDir)}`)
}

async function setPromptLabel() {
  const promptName = getPositionalArg(3)
  const label = getPositionalArg(4)
  const project = getArg('--project') || await resolveProjectSlug(null)
  const promptVersionId = getArg('--version')

  if (!promptName || !label || !promptVersionId) {
    throw new Error('Usage: orizu prompts labels set <prompt-name> <label> --version <prompt-version-id> [--project <team/project>] [--json]')
  }

  const response = await authedFetch(`/api/cli/prompts/labels?project=${encodeURIComponent(project)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      promptName,
      label,
      promptVersionId,
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to set prompt label: ${await response.text()}`)
  }

  const data = await parseJsonResponse<Record<string, unknown>>(response, 'Prompt label set')
  if (hasJsonFlag()) {
    printJson(data)
    return
  }

  printLine(`Moved ${sanitizeTerminalText(label)} to ${sanitizeTerminalText(promptVersionId)}`)
}

async function setPromptArchivedState(archived: boolean) {
  const promptRef = getPositionalArg(2)
  const project = getArg('--project') || await resolveProjectSlug(null)
  const command = archived ? 'archive' : 'restore'

  if (!promptRef) {
    throw new Error(`Usage: orizu prompts ${command} <prompt-id-or-name> --project <team/project> [--json]`)
  }

  const response = await authedFetch(`/api/cli/prompts/${encodeURIComponent(promptRef)}?project=${encodeURIComponent(project)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ archived }),
  })

  if (!response.ok) {
    throw new Error(`Failed to ${command} prompt: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{
    prompt: {
      id: string
      name: string
      status: string
    }
  }>(response, `Prompt ${command}`)
  if (hasJsonFlag()) {
    printJson(data)
    return
  }

  printLine(`${archived ? 'Archived' : 'Restored'} prompt ${sanitizeTerminalText(data.prompt.name)} (${sanitizeTerminalText(data.prompt.id)})`)
}

async function bindPromptScorer(role: 'headline' | 'tracked') {
  const promptId = getPositionalArg(3)
  const project = getArg('--project') || await resolveProjectSlug(null)
  const scorerVersionId = getArg('--scorer-version')

  if (!promptId || !scorerVersionId) {
    throw new Error(`Usage: orizu prompts scorers ${role === 'headline' ? 'set-headline' : 'add'} <prompt-id> --scorer-version <id> [--dataset-version <id> --split-set <id> --split <name>] [--project <team/project>] [--json]`)
  }

  const response = await authedFetch(`/api/cli/prompts/scorers?project=${encodeURIComponent(project)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      promptId,
      scorerVersionId,
      role,
      datasetVersionId: getArg('--dataset-version') || undefined,
      splitSetId: getArg('--split-set') || undefined,
      splitName: getArg('--split') || undefined,
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to bind prompt scorer: ${await response.text()}`)
  }

  const data = await parseJsonResponse<Record<string, unknown>>(response, 'Prompt scorer bind')
  if (hasJsonFlag()) {
    printJson(data)
    return
  }

  printLine(`${role === 'headline' ? 'Set headline' : 'Added'} scorer ${sanitizeTerminalText(scorerVersionId)} for ${sanitizeTerminalText(promptId)}`)
}

function getPositionalArg(index: number): string | null {
  const value = cliArgs[index]
  return value && !value.startsWith('--') ? value : null
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

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return 'unscored'
  }

  return `${(value * 100).toFixed(1)}%`
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
  const response = await authedFetch(`/api/cli/datasets/${encodeURIComponent(resolvedDatasetId)}/versions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      versionLabel,
      ...(readmeMarkdown !== null ? { readmeMarkdown } : {}),
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to create dataset version: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{
    datasetVersion: {
      id: string
      rowCount: number
      artifactFormat?: string
      artifactStoragePath?: string
    }
  }>(response, 'Dataset version create')

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

async function submitRunResults() {
  const resultsPath = getPositionalArg(2) || getArg('--file') || getArg('--results')
  const project = getArg('--project') || await resolveProjectSlug(null)
  const promptVersionId = getArg('--prompt-version')
  const runnerVersionId = getArg('--runner-version')
  const datasetVersionId = getArg('--dataset-version')
  const splitSetId = getArg('--split-set')
  const splitName = getArg('--split')

  if (
    !resultsPath ||
    !promptVersionId ||
    !runnerVersionId ||
    !datasetVersionId ||
    !splitSetId ||
    !splitName
  ) {
    throw new Error(
      'Usage: orizu runs submit <results.jsonl> --project <team/project> --prompt-version <id> --runner-version <id> --dataset-version <id> --split-set <id> --split <name> [--judge-version <id>] [--judge-runner-version <id>]'
    )
  }

  const resultBytes = readSourceBytes(resultsPath)
  const resultsJsonl = resultsPath.endsWith('.gz')
    ? gunzipSync(resultBytes).toString('utf8')
    : resultBytes.toString('utf8')
  const response = await authedFetch(`/api/cli/runs/submit?project=${encodeURIComponent(project)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      promptVersionId,
      runnerVersionId,
      datasetVersionId,
      splitSetId,
      splitName,
      judgeVersionId: getArg('--judge-version') || undefined,
      judgeRunnerVersionId: getArg('--judge-runner-version') || undefined,
      resultsJsonl,
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to submit run: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{
    run: {
      id: string
      aggregateScore: number | null
      perRowResultsStoragePath: string
    }
  }>(response, 'Run submit')
  if (hasJsonFlag()) {
    printJson({ run: data.run })
    return
  }
  printLine(
    `Submitted run ${sanitizeTerminalText(data.run.id)} ` +
    `(${formatPercent(data.run.aggregateScore)}) -> ` +
    sanitizeTerminalText(data.run.perRowResultsStoragePath)
  )
}

async function submitScoreResults() {
  const resultsPath = getPositionalArg(2) || getArg('--file') || getArg('--results')
  const project = getArg('--project') || await resolveProjectSlug(null)
  const scorerVersionId = getArg('--scorer-version')
  const subjectPromptVersionId = getArg('--subject-version') || getArg('--prompt-version')
  const optimizationRunId = getArg('--optimization-run')
  const candidateId = getArg('--candidate')

  if (!resultsPath || !scorerVersionId || (!subjectPromptVersionId && (!optimizationRunId || !candidateId))) {
    throw new Error('Usage: orizu scores submit <results.jsonl|results.json> --project <team/project> --scorer-version <id> (--subject-version <prompt-version-id> | --optimization-run <id> --candidate <id>) [--aggregate] [--dataset-version <id> --split-set <id> --split <name>] [--json]')
  }

  const resultBytes = readSourceBytes(resultsPath)
  const raw = resultsPath.endsWith('.gz')
    ? gunzipSync(resultBytes).toString('utf8')
    : resultBytes.toString('utf8')
  const scoreInput = normalizeScoreResultsInput(resultsPath, raw, hasArg('--aggregate'))
  if (scoreInput.aggregateWarning) {
    console.warn(scoreInput.aggregateWarning)
  }
  const aggregatePayload = scoreInput.aggregate || {}
  const response = await authedFetch(`/api/cli/scores/submit?project=${encodeURIComponent(project)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...aggregatePayload,
      scorerVersionId,
      subjectPromptVersionId: subjectPromptVersionId || undefined,
      datasetVersionId: getArg('--dataset-version') || undefined,
      splitSetId: getArg('--split-set') || undefined,
      splitName: getArg('--split') || undefined,
      optimizationRunId: optimizationRunId || undefined,
      candidateId: candidateId || undefined,
      resultsJsonl: scoreInput.resultsJsonl,
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to submit score: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{
    scoreRun: {
      id: string
      scoreValue: number | null
      rowResultsStoragePath?: string | null
    }
  }>(response, 'Score submit')
  if (hasJsonFlag()) {
    printJson(data)
    return
  }

  printLine(
    `Submitted score ${sanitizeTerminalText(data.scoreRun.id)} ` +
    `(${formatPercent(data.scoreRun.scoreValue)})`
  )
}

function looksLikeAggregateScoreObject(value: Record<string, unknown>): boolean {
  return (
    value.scoreValue !== undefined ||
    value.score_value !== undefined ||
    value.diagnostics !== undefined ||
    value.feedbackSummary !== undefined ||
    value.feedback_summary !== undefined ||
    value.rowEvidence !== undefined ||
    value.row_evidence !== undefined ||
    value.dependencyScoreRunIds !== undefined ||
    value.dependency_score_run_ids !== undefined
  )
}

function numberFromUnknown(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  if (typeof value === 'boolean') return value ? 1 : 0
  return null
}

function normalizeScoreResultsInput(sourcePath: string, raw: string, aggregateMode = false): ScoreSubmitInput {
  const logicalPath = sourcePath.endsWith('.gz') ? sourcePath.slice(0, -3) : sourcePath
  if (!logicalPath.endsWith('.json')) return { resultsJsonl: raw }

  try {
    const parsed = JSON.parse(raw) as unknown
    if (aggregateMode) {
      if (!isRecord(parsed)) {
        throw new Error('Aggregate score results JSON must be an object')
      }
      return { aggregate: parsed }
    }
    if (isRecord(parsed) && looksLikeAggregateScoreObject(parsed)) {
      return {
        aggregate: parsed,
        aggregateWarning: 'Warning: aggregate score JSON detected. Pass --aggregate to make this explicit.',
      }
    }
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    if (rows.some(row => !isRecord(row))) {
      throw new Error('JSON score results must be an object or an array of objects')
    }
    return { resultsJsonl: rows.map(row => JSON.stringify(row)).join('\n') }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid score results JSON '${sourcePath}': ${message}`)
  }
}

function readOptionalJsonlFile(pathArg: string | null): string | undefined {
  if (!pathArg) return undefined
  const bytes = readSourceBytes(pathArg)
  return pathArg.endsWith('.gz')
    ? gunzipSync(bytes).toString('utf8')
    : bytes.toString('utf8')
}

function parseAliasAssignments(value: string | null): Record<string, string> {
  const result: Record<string, string> = {}
  if (!value) return result
  for (const item of parseCommaSeparated(value)) {
    const equalsIndex = item.indexOf('=')
    if (equalsIndex <= 0 || equalsIndex === item.length - 1) {
      throw new Error(`Expected alias assignment in form alias=value, got '${item}'`)
    }
    result[item.slice(0, equalsIndex)] = item.slice(equalsIndex + 1)
  }
  return result
}

function readDependencyResultAssignments(value: string | null): Record<string, string> | undefined {
  const assignments = parseAliasAssignments(value)
  const result: Record<string, string> = {}
  for (const [alias, path] of Object.entries(assignments)) {
    result[alias] = readOptionalJsonlFile(path) || ''
  }
  return Object.keys(result).length > 0 ? result : undefined
}

async function execScorer() {
  const project = getArg('--project') || await resolveProjectSlug(null)
  const scorerVersionId = getArg('--scorer-version')
  const subjectPromptVersionId = getArg('--subject-version') || getArg('--prompt-version')
  const optimizationRunId = getArg('--optimization-run')
  const candidateId = getArg('--candidate')
  const datasetVersionId = getArg('--dataset-version')
  const splitSetId = getArg('--split-set')
  const splitName = getArg('--split')
  const outPath = getArg('--out')

  if (
    !scorerVersionId ||
    (!subjectPromptVersionId && (!optimizationRunId || !candidateId)) ||
    !datasetVersionId ||
    !splitSetId ||
    !splitName
  ) {
    throw new Error('Usage: orizu scorers exec --scorer-version <id> (--subject-version <prompt-version-id> | --optimization-run <id> --candidate <id>) --dataset-version <id> --split-set <id> --split <name> [--subject-results <jsonl>] [--dependency-score-run <alias=id>] [--dependency-results <alias=path>] [--no-submit] [--out <score.json>] [--project <team/project>] [--json]')
  }

  const response = await authedFetch(`/api/cli/scorers/exec?project=${encodeURIComponent(project)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scorerVersionId,
      subjectPromptVersionId: subjectPromptVersionId || undefined,
      optimizationRunId: optimizationRunId || undefined,
      candidateId: candidateId || undefined,
      datasetVersionId,
      splitSetId,
      splitName,
      submit: !hasArg('--no-submit'),
      reuseExisting: !hasArg('--no-reuse-existing'),
      subjectResultsJsonl: readOptionalJsonlFile(getArg('--subject-results') || getArg('--outputs')),
      dependencyScoreRunIds: parseAliasAssignments(getArg('--dependency-score-run') || getArg('--dependency-score-runs')),
      dependencyResultsJsonl: readDependencyResultAssignments(getArg('--dependency-results')),
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to execute scorer: ${await response.text()}`)
  }

  const data = await parseJsonResponse<Record<string, unknown>>(response, 'Scorer exec')
  if (outPath) {
    writeFileSync(expandHomePath(outPath), `${JSON.stringify(data.scoreResult || data, null, 2)}\n`)
  }
  if (hasJsonFlag()) {
    printJson(data)
    return
  }

  const scoreRun = isRecord(data.scoreRun) ? data.scoreRun : null
  const scoreResult = isRecord(data.scoreResult) ? data.scoreResult : null
  const scoreValue = scoreRun
    ? scoreRun.scoreValue
    : scoreResult
      ? scoreResult.scoreValue
      : null
  if (scoreRun && typeof scoreRun.id === 'string') {
    printLine(`Executed scorer ${sanitizeTerminalText(scorerVersionId)} -> score ${sanitizeTerminalText(scoreRun.id)} (${formatPercent(numberFromUnknown(scoreValue))})`)
  } else {
    printLine(`Executed scorer ${sanitizeTerminalText(scorerVersionId)} (${formatPercent(numberFromUnknown(scoreValue))})`)
  }
  if (outPath) {
    printLine(`Wrote scorer result to ${sanitizeTerminalText(outPath)}`)
  }
}

type OptimizationLifecycleAction = 'pause' | 'resume' | 'finish' | 'fail' | 'cancel'
const MARKDOWN_REPORT_MAX_BYTES = 2 * 1024 * 1024

function parseOptionalNumberFlag(name: string): number | undefined {
  const value = getArg(name)
  if (!value) {
    return undefined
  }

  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number`)
  }

  return parsed
}

function hasObjectKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0
}

function readMarkdownReportInput(
  reportLabel: 'Optimization' | 'Task'
): { markdown: string; sourceName: string | null } | null {
  const report = getArg('--report')
  const reportFile = getArg('--report-file')

  rejectDashPrefixedOptionValue('--report', report)
  rejectDashPrefixedOptionValue('--report-file', reportFile)

  if (report && reportFile) {
    throw new Error('Use either --report or --report-file, not both')
  }

  if (!report && !reportFile) {
    return null
  }

  let markdown: string
  let sourceName: string | null

  if (reportFile) {
    const expandedPath = expandHomePath(reportFile)
    markdown = readSourceFile(reportFile)
    sourceName = basename(expandedPath)
  } else if (report?.startsWith('@')) {
    const path = report.slice(1)
    const expandedPath = expandHomePath(path)
    markdown = readSourceFile(path)
    sourceName = basename(expandedPath)
  } else {
    markdown = report || ''
    sourceName = 'inline'
  }

  if (!markdown.trim()) {
    throw new Error(`${reportLabel} report markdown must not be blank`)
  }

  if (Buffer.byteLength(markdown, 'utf8') > MARKDOWN_REPORT_MAX_BYTES) {
    throw new Error(`${reportLabel} report exceeds ${MARKDOWN_REPORT_MAX_BYTES} bytes`)
  }

  return { markdown, sourceName }
}

function readOptimizationReportInput(): { markdown: string; sourceName: string | null } | null {
  return readMarkdownReportInput('Optimization')
}

function readTaskReportInput(): { markdown: string; sourceName: string | null } | null {
  return readMarkdownReportInput('Task')
}

async function startOptimizationRun() {
  const project = getArg('--project') || await resolveProjectSlug(null)
  const optimizerVersionId = getArg('--optimizer-version')
  const promptVersionIds = parseCommaSeparated(
    getArg('--prompt-version') || getArg('--prompt-versions')
  )
  const judgeVersionIds = parseCommaSeparated(
    getArg('--judge-version') || getArg('--judge-versions')
  )
  const selectionScorer = getArg('--selection-scorer') || getArg('--scorer-version')
  const reflectionScorer = getArg('--reflection-scorer')
  const paretoScorers = parseCommaSeparated(getArg('--pareto-scorer') || getArg('--pareto-scorers'))
  const bestScorers = parseCommaSeparated(getArg('--best-scorer') || getArg('--best-scorers'))
  const datasetVersionId = getArg('--dataset-version')
  const splitSetId = getArg('--split-set')
  const metadata = readJsonObjectArg(getArg('--metadata'), 'optimization metadata')

  if (
    !optimizerVersionId ||
    promptVersionIds.length === 0 ||
    !selectionScorer ||
    !datasetVersionId ||
    !splitSetId
  ) {
    throw new Error(
      'Usage: orizu optimizations start --project <team/project> --optimizer-version <id> --prompt-version <id[,id]> --selection-scorer <id> [--reflection-scorer <id>] [--pareto-scorer <id>] [--best-scorer <id>] --dataset-version <id> --split-set <id> [--train-split <name>] [--validation-split <name>] [--metadata <json|@file>] [--json]'
    )
  }

  const scorers = [
    { scorerVersionId: selectionScorer, role: 'selection' },
    ...(reflectionScorer ? [{ scorerVersionId: reflectionScorer, role: 'reflection' }] : []),
    ...paretoScorers.map(scorerVersionId => ({
      scorerVersionId,
      role: 'tracked',
      trackedScope: 'pareto_candidates',
    })),
    ...bestScorers.map(scorerVersionId => ({
      scorerVersionId,
      role: 'tracked',
      trackedScope: 'best_candidate',
    })),
  ]

  const response = await authedFetch(`/api/cli/optimization-runs?project=${encodeURIComponent(project)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      optimizerVersionId,
      promptVersionIds,
      judgeVersionIds,
      scorers,
      datasetVersionId,
      splitSetId,
      trainSplitName: getArg('--train-split') || undefined,
      validationSplitName: getArg('--validation-split') || undefined,
      metadata,
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to start optimization run: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{
    optimization_run_id: string
    optimizationRun: {
      id: string
      status: string
      startedAt?: string | null
      createdAt?: string | null
    }
  }>(response, 'Optimization run start')

  if (hasJsonFlag()) {
    printJson(data)
    return
  }

  printLine(
    `Started optimization run ${sanitizeTerminalText(data.optimization_run_id)} ` +
    `(${sanitizeTerminalText(data.optimizationRun.status)})`
  )
}

async function updateOptimizationRunLifecycle(action: OptimizationLifecycleAction) {
  const runId = getPositionalArg(2) || getArg('--run-id')
  if (!runId) {
    throw new Error(`Usage: orizu optimizations ${action} <run-id>`)
  }

  const statusByAction: Record<OptimizationLifecycleAction, string> = {
    pause: 'paused',
    resume: 'running',
    finish: 'succeeded',
    fail: 'failed',
    cancel: 'cancelled',
  }

  const body: Record<string, unknown> = {
    status: statusByAction[action],
  }
  const metadata = readJsonObjectArg(getArg('--metadata'), 'optimization metadata')
  const reason = getArg('--reason')
  const report = readOptimizationReportInput()

  if (report && (action === 'pause' || action === 'resume')) {
    throw new Error(`orizu optimizations ${action} does not accept optimization reports`)
  }

  if ((action === 'pause' || action === 'cancel') && reason) {
    metadata.reason = reason
  }

  if (action === 'fail' && reason) {
    metadata.failure_reason = reason
    body.failureReason = reason
  }

  if (hasObjectKeys(metadata)) {
    body.metadata = metadata
  }

  if (report) {
    body.reportMarkdown = report.markdown
    body.reportSourceName = report.sourceName
  }

  if (action === 'finish') {
    const bestScore = parseOptionalNumberFlag('--best-score')
    if (bestScore !== undefined) {
      body.bestScore = bestScore
    }

    const bestCandidateId = getArg('--best-candidate')
    if (bestCandidateId) {
      body.bestCandidateId = bestCandidateId
    }

    const resultPromptVersionId = getArg('--result-prompt-version')
    if (resultPromptVersionId) {
      body.resultPromptVersionId = resultPromptVersionId
    }
  }

  const response = await authedFetch(`/api/cli/optimization-runs/${encodeURIComponent(runId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    throw new Error(`Failed to update optimization run: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{
    optimizationRun: {
      id: string
      status: string
      startedAt?: string | null
      finishedAt?: string | null
      bestScore?: number | null
      bestCandidateId?: string | null
      resultPromptVersionId?: string | null
      metadata?: Record<string, unknown>
    }
  }>(response, 'Optimization run update')

  if (hasJsonFlag()) {
    printJson(data)
    return
  }

  const id = sanitizeTerminalText(data.optimizationRun.id)
  if (action === 'pause') {
    printLine(`Paused optimization run ${id}`)
  } else if (action === 'resume') {
    printLine(`Resumed optimization run ${id}`)
  } else if (action === 'finish') {
    printLine(`Finished optimization run ${id}`)
  } else if (action === 'fail') {
    printLine(`Marked optimization run ${id} failed`)
  } else {
    printLine(`Cancelled optimization run ${id}`)
  }
}

async function exportOptimizationRun() {
  const runId = getPositionalArg(2) || getArg('--run-id')
  const outPathArg = getArg('--out')

  if (!runId) {
    throw new Error('Usage: orizu optimizations export <run-id> [--out <path>] [--json]')
  }

  const response = await authedFetch(`/api/cli/optimization-runs/${encodeURIComponent(runId)}/export`)
  if (!response.ok) {
    throw new Error(`Failed to export optimization run: ${await response.text()}`)
  }

  const data = await parseJsonResponse<Record<string, unknown>>(response, 'Optimization export')
  if (hasJsonFlag() && !outPathArg) {
    printJson(data)
    return
  }

  const filename = outPathArg
    ? expandHomePath(outPathArg)
    : `${runId}.optimization.json`
  writeTextFileEnsuringDir(filename, `${JSON.stringify(data, null, 2)}\n`)
  printLine(`Saved optimization export to ${sanitizeTerminalText(filename)}`)
}

function removeFlagWithValue(args: string[], flag: string): string[] {
  const filtered: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      index += 1
      continue
    }
    filtered.push(args[index])
  }
  return filtered
}

function bundledOrizuGepaPythonPath(): string | null {
  const candidates = [
    fileURLToPath(new URL('../vendor/orizu-gepa-python/src', import.meta.url)),
    fileURLToPath(new URL('../../orizu-gepa-python/src', import.meta.url)),
  ]

  return candidates.find(candidate => existsSync(candidate)) ?? null
}

async function runGepaOptimization() {
  const project = getArg('--project') || await resolveProjectSlug(null)
  const baseUrl = getBaseUrl()
  const token = getStoredAuthTokenForBaseUrl(baseUrl)
  const python = getArg('--python') || process.env.PYTHON || 'python3'
  const bundledPythonPath = bundledOrizuGepaPythonPath()
  let forwardedArgs = removeFlagWithValue(cliArgs.slice(2), '--python')

  if (!forwardedArgs.includes('--project')) {
    forwardedArgs = ['--project', project, ...forwardedArgs]
  }

  const pythonPathEntries = [
    bundledPythonPath,
    process.env.PYTHONPATH,
  ].filter((entry): entry is string => Boolean(entry))

  const result = spawnSync(python, ['-m', 'orizu_gepa.cli', ...forwardedArgs], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ORIZU_API_URL: baseUrl,
      ORIZU_TOKEN: token,
      ORIZU_PROJECT: project,
      PYTHONPATH: pythonPathEntries.join(delimiter),
      PYTHONUNBUFFERED: process.env.PYTHONUNBUFFERED || '1',
    },
  })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    throw new Error(`orizu-gepa failed with exit code ${result.status}`)
  }

  if (hasJsonFlag()) {
    printJson({ status: 'completed', exitCode: 0 })
  }
}

async function listTeams() {
  const teams = await fetchTeams()
  if (hasJsonFlag()) {
    printJson({ teams })
    return
  }
  printTeams(teams)
}

async function resolveTeamSlug(teamSlugArg: string | null): Promise<string> {
  if (teamSlugArg) {
    return normalizeSlugInput(teamSlugArg)
  }

  const team = await promptSelect(
    'Select a team',
    await fetchTeams(),
    item => `${item.name} (${item.slug})`,
    { forcePrompt: true }
  )

  return team.slug
}

async function createTeam() {
  let name = getArg('--name')

  if (!name && isInteractiveTerminal()) {
    const rl = createInterface({ input, output })
    try {
      name = (await rl.question('Team name: ')).trim()
    } finally {
      rl.close()
    }
  }

  if (!name) {
    throw new Error('Usage: orizu teams create --name <name>')
  }

  const team = await createTeamOnServer(name)
  if (hasJsonFlag()) {
    printJson({ team })
    return
  }
  printLine(`Created team: ${sanitizeTerminalText(team.name)} (${sanitizeTerminalText(team.slug)})`)
}

async function listProjects() {
  const teamSlugArg = getArg('--team')
  const teamSlug = teamSlugArg ? normalizeSlugInput(teamSlugArg) : null
  const projects = await fetchProjects(teamSlug || undefined)
  if (hasJsonFlag()) {
    printJson({ projects })
    return
  }
  printProjects(projects)
}

async function createProject() {
  const name = getArg('--name')
  const teamSlugArg = getArg('--team')
  let teamSlug = teamSlugArg ? normalizeSlugInput(teamSlugArg) : null

  if (!name) {
    throw new Error('Usage: orizu projects create --name <name> [--team <teamSlug>]')
  }

  if (!teamSlug) {
    const team = await promptSelect(
      'Select a team',
      await fetchTeams(),
      item => `${item.name} (${item.slug})`,
      { forcePrompt: true }
    )
    teamSlug = team.slug
  }

  const project = await createProjectOnServer(teamSlug, name)
  if (hasJsonFlag()) {
    printJson({ project })
    return
  }
  printLine(`Created project ${sanitizeTerminalText(`${project.teamSlug}/${project.slug}`)}`)
}

async function listTasks() {
  const project = getArg('--project')
  const tasks = await fetchTasks(project || undefined)
  if (hasJsonFlag()) {
    printJson({ tasks })
    return
  }
  printTasks(tasks)
}

async function listApps() {
  const project = getArg('--project') || await resolveProjectSlug(null)
  const apps = await fetchApps(project)
  if (hasJsonFlag()) {
    printJson({ apps })
    return
  }
  printApps(apps)
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

function hasJsonFlag(): boolean {
  return cliJsonOutput || hasArg('--json')
}

function printJson(value: Record<string, unknown>) {
  printLine(JSON.stringify(value))
}

function createReportCommentsCliContext(): ReportCommentsCliContext {
  return {
    getArg,
    getPositionalArg,
    rejectDashPrefixedOptionValue,
    resolveProjectSlug,
    readSourceFile,
    authedFetch,
    parseJsonResponse,
    hasJsonFlag,
    printJson,
    printLine,
    sanitizeTerminalText,
  }
}

function printCapabilities() {
  const capabilities = getCapabilities(getCliVersion())
  if (hasJsonFlag()) {
    printLine(JSON.stringify(capabilities))
    return
  }

  printLine('orizu capabilities')
  printLine('')
  printLine('Run `orizu capabilities --json` for a machine-readable command manifest.')
  printLine('')
  for (const command of capabilities.commands) {
    printLine(`  ${command.name.padEnd(34)} ${command.help}`)
  }
}

async function askYesNo(question: string, defaultYes: boolean): Promise<boolean> {
  const rl = createInterface({ input, output })
  try {
    const suffix = defaultYes ? 'Y/n' : 'y/N'
    const answer = (await rl.question(`${question} (${suffix}) `)).trim().toLowerCase()
    if (!answer) {
      return defaultYes
    }
    return answer === 'y' || answer === 'yes'
  } finally {
    rl.close()
  }
}

async function askText(question: string, defaultValue: string): Promise<string> {
  const rl = createInterface({ input, output })
  try {
    const suffix = defaultValue ? ` [${defaultValue}]` : ''
    const answer = (await rl.question(`${question}${suffix} `)).trim()
    return answer || defaultValue
  } finally {
    rl.close()
  }
}

type KeypressInfo = {
  name?: string
  sequence?: string
  ctrl?: boolean
}

type RawInput = typeof input & {
  setRawMode?: (mode: boolean) => void
  isRaw?: boolean
}

async function waitForAnyKeyOrEscape(message: string): Promise<boolean> {
  if (!isInteractiveTerminal()) {
    throw new Error('Interactive terminal required.')
  }

  printLine(message)
  const rawInput = input as RawInput
  const wasRaw = Boolean(rawInput.isRaw)
  emitKeypressEvents(input)

  return new Promise((resolvePromise, rejectPromise) => {
    function cleanup() {
      input.off('keypress', onKeypress)
      if (rawInput.setRawMode && !wasRaw) {
        rawInput.setRawMode(false)
      }
      input.pause()
      printLine('')
    }

    function onKeypress(_chunk: string, key: KeypressInfo) {
      cleanup()
      if (key.ctrl && key.name === 'c') {
        rejectPromise(new Error('Setup cancelled.'))
        return
      }
      resolvePromise(key.name !== 'escape')
    }

    input.on('keypress', onKeypress)
    input.resume()
    rawInput.setRawMode?.(true)
  })
}

async function promptKeyboardSelect<T>(
  title: string,
  items: T[],
  label: (item: T, index: number) => string
): Promise<T> {
  if (items.length === 0) {
    throw new Error(`No options available for ${title.toLowerCase()}`)
  }
  if (!isInteractiveTerminal()) {
    throw new Error(`${title} selection requires interactive terminal. Provide flags explicitly instead.`)
  }

  printLine(`\n${sanitizeTerminalText(title)}`)
  printLine('Use ↑/↓ to choose, Enter to confirm, or Esc to cancel.')

  let selected = 0
  let rendered = false
  const rawInput = input as RawInput
  const wasRaw = Boolean(rawInput.isRaw)
  emitKeypressEvents(input)

  function render() {
    if (rendered) {
      output.write(`\x1b[${items.length}A`)
    }
    items.forEach((item, index) => {
      output.write('\x1b[2K')
      const marker = index === selected ? '●' : '○'
      output.write(`  ${marker} ${sanitizeTerminalText(label(item, index))}\n`)
    })
    rendered = true
  }

  render()
  output.write('\x1b[?25l')

  return new Promise((resolvePromise, rejectPromise) => {
    function cleanup() {
      input.off('keypress', onKeypress)
      if (rawInput.setRawMode && !wasRaw) {
        rawInput.setRawMode(false)
      }
      input.pause()
      output.write('\x1b[?25h')
      printLine('')
    }

    function onKeypress(_chunk: string, key: KeypressInfo) {
      if (key.ctrl && key.name === 'c') {
        cleanup()
        rejectPromise(new Error('Setup cancelled.'))
        return
      }
      if (key.name === 'escape') {
        cleanup()
        rejectPromise(new Error('Setup cancelled.'))
        return
      }
      if (key.name === 'up') {
        selected = (selected - 1 + items.length) % items.length
        render()
        return
      }
      if (key.name === 'down') {
        selected = (selected + 1) % items.length
        render()
        return
      }
      if (key.name === 'return' || key.name === 'enter') {
        const item = items[selected]
        cleanup()
        resolvePromise(item)
      }
    }

    input.on('keypress', onKeypress)
    input.resume()
    rawInput.setRawMode?.(true)
  })
}

async function promptKeyboardMultiSelect<T>(
  title: string,
  items: T[],
  label: (item: T, index: number) => string,
  defaultSelected: (item: T, index: number) => boolean
): Promise<T[]> {
  if (items.length === 0) {
    return []
  }
  if (!isInteractiveTerminal()) {
    throw new Error(`${title} selection requires interactive terminal. Provide flags explicitly instead.`)
  }

  printLine(`\n${sanitizeTerminalText(title)}`)
  printLine('Use ↑/↓ to move, Space to toggle, Enter to confirm, or Esc to skip.')

  let selected = 0
  let rendered = false
  const checked = new Set<number>()
  items.forEach((item, index) => {
    if (defaultSelected(item, index)) {
      checked.add(index)
    }
  })
  const rawInput = input as RawInput
  const wasRaw = Boolean(rawInput.isRaw)
  emitKeypressEvents(input)

  function render() {
    if (rendered) {
      output.write(`\x1b[${items.length}A`)
    }
    items.forEach((item, index) => {
      output.write('\x1b[2K')
      const cursor = index === selected ? '›' : ' '
      const marker = checked.has(index) ? '◉' : '○'
      output.write(`${cursor} ${marker} ${sanitizeTerminalText(label(item, index))}\n`)
    })
    rendered = true
  }

  render()
  output.write('\x1b[?25l')

  return new Promise((resolvePromise, rejectPromise) => {
    function cleanup() {
      input.off('keypress', onKeypress)
      if (rawInput.setRawMode && !wasRaw) {
        rawInput.setRawMode(false)
      }
      input.pause()
      output.write('\x1b[?25h')
      printLine('')
    }

    function onKeypress(_chunk: string, key: KeypressInfo) {
      if (key.ctrl && key.name === 'c') {
        cleanup()
        rejectPromise(new Error('Setup cancelled.'))
        return
      }
      if (key.name === 'escape') {
        cleanup()
        resolvePromise([])
        return
      }
      if (key.name === 'up') {
        selected = (selected - 1 + items.length) % items.length
        render()
        return
      }
      if (key.name === 'down') {
        selected = (selected + 1) % items.length
        render()
        return
      }
      if (key.name === 'space') {
        if (checked.has(selected)) {
          checked.delete(selected)
        } else {
          checked.add(selected)
        }
        render()
        return
      }
      if (key.name === 'return' || key.name === 'enter') {
        const selectedItems = items.filter((_item, index) => checked.has(index))
        cleanup()
        resolvePromise(selectedItems)
      }
    }

    input.on('keypress', onKeypress)
    input.resume()
    rawInput.setRawMode?.(true)
  })
}

function formatFindingCount(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? '' : 's'}`
}

function validationSummary(findings: { severity: string }[], logPath: string | null): string {
  if (findings.length === 0) {
    return 'passed'
  }

  const errors = findings.filter(finding => finding.severity === 'error').length
  const warnings = findings.filter(finding => finding.severity === 'warning').length
  const infos = findings.filter(finding => finding.severity === 'info').length
  const parts = [
    errors > 0 ? formatFindingCount(errors, 'error') : null,
    warnings > 0 ? formatFindingCount(warnings, 'warning') : null,
    infos > 0 ? formatFindingCount(infos, 'info') : null,
  ].filter(Boolean)
  const location = logPath ? ` (printed to ${logPath})` : ''
  return `${parts.join(', ')}${location}`
}

function writeWorkspaceValidationLog(
  workspaceRoot: string,
  findings: { severity: string, code: string, path?: string, message: string }[],
  dryRun: boolean
): string | null {
  if (findings.length === 0 || dryRun) {
    return null
  }

  const logsDir = join(workspaceRoot, '.logs')
  mkdirSync(logsDir, { recursive: true })
  const logPath = join(logsDir, `${randomBytes(6).toString('hex')}.log`)
  const lines = [
    'Orizu workspace validation',
    `Generated at: ${new Date().toISOString()}`,
    `Workspace: ${workspaceRoot}`,
    `Summary: ${validationSummary(findings, null)}`,
    '',
    ...findings.map(finding => {
      const path = finding.path ? ` ${finding.path}` : ''
      return `${finding.severity.toUpperCase()} ${finding.code}:${path} ${finding.message}`
    }),
    '',
  ]
  writeFileSync(logPath, lines.join('\n'), 'utf8')
  return relative(workspaceRoot, logPath)
}

function printWorkspaceFindings(findings: { severity: string, code: string, path?: string, message: string }[]) {
  if (findings.length === 0) {
    printLine('   Validation passed.')
    return
  }

  printLine('   Validation findings:')
  for (const finding of findings) {
    const path = finding.path ? ` ${finding.path}` : ''
    printLine(`   - ${finding.severity.toUpperCase()} ${finding.code}:${path} ${finding.message}`)
  }
}

const SKILL_INSTALL_USAGE =
  `Usage: orizu install-skill [--agent <${SKILL_INSTALL_AGENTS.join('|')}>]... [--scope global|project] [--mode auto|link|copy] [--target <${SKILL_INSTALL_TARGETS.join('|')}>]... [--yes] [--dry-run]`

interface SkillInstallChoice {
  label: string
  target: SkillInstallTarget
  defaultYes: boolean
}

function describeSkillTarget(target: SkillInstallTarget): string {
  if (target === 'claude-user') return 'Claude Code, for you across all projects'
  if (target === 'claude-project') return 'Claude Code, only for this project'
  if (target === 'codex-user') return 'Codex, for you across all projects'
  if (target === 'agent-user') return 'Codex / Open Agent Skills, for you across all projects'
  if (target === 'agents-project') return 'Codex / Open Agent Skills, only for this project'
  if (target === 'codex-project') return 'Codex legacy project folder (.codex/skills)'
  return 'Project instructions, managed Orizu section in AGENTS.md'
}

async function promptSkillInstallTargets(scope: SkillInstallScope): Promise<SkillInstallTarget[]> {
  if (!isInteractiveTerminal()) {
    throw new Error(SKILL_INSTALL_USAGE)
  }

  const choices: SkillInstallChoice[] = [
    { label: describeSkillTarget(getTargetForAgent('claude', scope)), target: getTargetForAgent('claude', scope), defaultYes: true },
    { label: describeSkillTarget(getTargetForAgent('codex', scope)), target: getTargetForAgent('codex', scope), defaultYes: true },
    { label: describeSkillTarget('agents-md'), target: 'agents-md', defaultYes: false },
  ]

  printLine('Where should Orizu be available?')
  const targets: SkillInstallTarget[] = []
  for (const choice of choices) {
    const installPath = getSkillInstallPath(choice.target)
    if (await askYesNo(`  ${choice.label}\n    ${installPath}?`, choice.defaultYes)) {
      targets.push(choice.target)
    }
  }

  if (await askYesNo('  Show advanced targets?', false)) {
    for (const target of SKILL_INSTALL_TARGETS) {
      if (targets.includes(target)) {
        continue
      }
      const installPath = getSkillInstallPath(target)
      if (await askYesNo(`  ${describeSkillTarget(target)} [${target}]\n    ${installPath}?`, false)) {
        targets.push(target)
      }
    }
  }

  return targets
}

function parseSkillInstallScope(): SkillInstallScope {
  const raw = getArg('--scope')
  if (raw === null || raw === 'global') {
    return 'global'
  }
  if (raw === 'project') {
    return 'local'
  }
  throw new Error(`Unknown --scope '${raw}'. Choices: global, project.`)
}

function parseSkillInstallMode(): SkillInstallMode {
  const raw = getArg('--mode')
  if (raw === null) {
    return 'auto'
  }
  if (raw !== 'auto' && raw !== 'link' && raw !== 'copy') {
    throw new Error(`Unknown --mode '${raw}'. Choices: auto, link, copy.`)
  }
  return raw
}

function parseSkillInstallTargets(scope: SkillInstallScope): SkillInstallTarget[] {
  const targets: SkillInstallTarget[] = []

  for (const agent of getArgs('--agent')) {
    if (!isSkillInstallAgent(agent)) {
      throw new Error(
        `Unknown agent '${agent}'. Available agents: ${SKILL_INSTALL_AGENTS.join(', ')}`
      )
    }
    const target = getTargetForAgent(agent, scope)
    if (!targets.includes(target)) {
      targets.push(target)
    }
  }

  for (const target of getArgs('--target')) {
    if (!isSkillInstallTarget(target)) {
      throw new Error(
        `Unknown skill install target '${target}'. Available targets: ${SKILL_INSTALL_TARGETS.join(', ')}`
      )
    }
    if (!targets.includes(target)) {
      targets.push(target)
    }
  }

  return targets
}

function formatSkillInstallAction(action: string): string {
  if (action === 'created') return 'Wrote'
  if (action === 'updated') return 'Updated'
  if (action === 'would-create') return 'Would write'
  return 'Would update'
}

function describePlannedWrite(target: SkillInstallTarget, action: string, mode: string, path: string): string {
  const verb = action.includes('create') || action === 'created' ? 'create' : 'replace'
  if (target === 'agents-md') {
    return `  ${path} (${verb} managed Orizu section)`
  }
  if (mode === 'link') {
    return `  ${path} (${verb}, symlink to the CLI-managed skill)`
  }
  return `  ${path} (${verb}, full copy with sync metadata)`
}

interface SkillInstallOutcome {
  target: SkillInstallTarget
  path: string
  action: 'created' | 'updated' | 'skipped' | 'failed'
  mode: 'link' | 'copy' | 'section' | null
  error?: string
}

async function applySkillInstallTargets(
  targets: SkillInstallTarget[],
  options: {
    mode: SkillInstallMode
    skipConfirm: boolean
    dryRun: boolean
    cwd?: string
    homeDir?: string
    showPlan?: boolean
    printResults?: boolean
  }
): Promise<SkillInstallOutcome[]> {
  const cliVersion = getCliVersion()
  const jsonMode = hasJsonFlag()
  const planned = targets.map(target =>
    installSkillTarget(target, {
      cwd: options.cwd,
      homeDir: options.homeDir,
      dryRun: true,
      mode: options.mode,
      cliVersion,
    })
  )
  const showPlan = options.showPlan ?? true
  const printResults = options.printResults ?? true

  if (showPlan && !jsonMode) {
    printLine('Planned writes:')
    for (const plan of planned) {
      printLine(describePlannedWrite(plan.target, plan.action, plan.mode, plan.path))
    }
    printLine('')
  }

  if (options.dryRun) {
    if (printResults && !jsonMode) {
      printLine('Dry run: no files were changed.')
    }
    return planned.map(plan => ({
      target: plan.target,
      path: plan.path,
      action: 'skipped',
      mode: plan.mode,
    }))
  }

  const outcomes: SkillInstallOutcome[] = []
  for (const target of targets) {
    let overwrite = options.skipConfirm
    const installPath = getSkillInstallPath(target, { cwd: options.cwd, homeDir: options.homeDir })
    if (!overwrite && targetNeedsOverwrite(target, { cwd: options.cwd, homeDir: options.homeDir })) {
      if (!isInteractiveTerminal()) {
        throw new Error(`${installPath} already exists. Pass --yes to replace it.`)
      }
      overwrite = await askYesNo(`Replace ${installPath}?`, true)
      if (!overwrite) {
        if (!jsonMode) {
          printLine(`Skipped ${installPath}`)
        }
        outcomes.push({ target, path: installPath, action: 'skipped', mode: null })
        continue
      }
    }

    try {
      const result = installSkillTarget(target, {
        cwd: options.cwd,
        homeDir: options.homeDir,
        overwrite,
        mode: options.mode,
        cliVersion,
      })
      if (printResults && !jsonMode) {
        const suffix = result.mode === 'link' ? ' (symlink)' : ''
        printLine(`${formatSkillInstallAction(result.action)} ${result.path}${suffix}`)
      }
      outcomes.push({
        target,
        path: result.path,
        action: result.action as 'created' | 'updated',
        mode: result.mode,
      })
    } catch (error: unknown) {
      const message = getErrorMessage(error)
      if (printResults && !jsonMode) {
        printLine(`Failed ${installPath}: ${message}`)
      }
      outcomes.push({ target, path: installPath, action: 'failed', mode: null, error: message })
    }
  }

  return outcomes
}

async function installSkillCommand() {
  const skipConfirm = hasArg('--yes')
  const dryRun = hasArg('--dry-run')
  const scope = parseSkillInstallScope()
  const mode = parseSkillInstallMode()
  let targets = parseSkillInstallTargets(scope)
  if (targets.length === 0) {
    targets = await promptSkillInstallTargets(scope)
  }

  if (targets.length === 0) {
    if (hasJsonFlag()) {
      printJson({ installs: [] })
      return
    }
    printLine('No targets selected; nothing to do.')
    return
  }

  const outcomes = await applySkillInstallTargets(targets, { mode, skipConfirm, dryRun })
  if (hasJsonFlag()) {
    printJson({ dryRun, installs: outcomes })
  }
}

function describeSkillTargetState(status: SkillTargetStatus): string {
  if (status.state === 'current') return 'current'
  if (status.state === 'stale') return 'stale (run `orizu skills update`)'
  if (status.state === 'broken-link') return 'broken symlink (run `orizu skills update`)'
  if (status.state === 'unmanaged') return 'exists without a managed Orizu section'
  return 'not installed'
}

function skillsStatusCommand() {
  const source = resolveSkillSource()
  const statuses = SKILL_INSTALL_TARGETS.map(target => getSkillTargetStatus(target))

  if (hasJsonFlag()) {
    printJson({
      name: source.name,
      root: source.root,
      source: source.source,
      cliVersion: getCliVersion(),
      sourceHash: computeSkillContentHash(source.root),
      targets: statuses.map(status => ({
        target: status.target,
        path: status.path,
        state: status.state,
        mode: status.mode,
        linkTarget: status.linkTarget,
        installedHash: status.installedHash,
        meta: status.meta,
      })),
    })
    return
  }

  printLine(`Skill source: ${source.root} (${source.source})`)
  printLine('')
  for (const status of statuses) {
    const mode = status.mode ? `, ${status.mode}` : ''
    printLine(`  ${status.target.padEnd(16)} ${describeSkillTargetState(status)}${mode}`)
    printLine(`  ${''.padEnd(16)} ${status.path}`)
  }
}

async function skillsUpdateCommand() {
  const dryRun = hasArg('--dry-run')
  const cliVersion = getCliVersion()
  const updates: Array<{ target: SkillInstallTarget, path: string, action: string }> = []

  for (const target of SKILL_INSTALL_TARGETS) {
    const status = getSkillTargetStatus(target)
    if (status.state === 'missing' || status.state === 'unmanaged') {
      continue
    }

    if (status.state === 'current') {
      updates.push({ target, path: status.path, action: 'already-current' })
      continue
    }

    if (dryRun) {
      updates.push({ target, path: status.path, action: 'would-update' })
      continue
    }

    const refreshMode: SkillInstallMode = status.mode === 'link' ? 'auto' : 'copy'
    const result = installSkillTarget(target, {
      overwrite: true,
      mode: refreshMode,
      cliVersion,
    })
    updates.push({
      target,
      path: status.path,
      action: status.state === 'broken-link' ? 'relinked' : result.action,
    })
  }

  if (hasJsonFlag()) {
    printJson({ updates })
    return
  }

  if (updates.length === 0) {
    printLine('No Orizu skill installs found. Run `orizu install-skill` first.')
    return
  }

  for (const update of updates) {
    if (update.action === 'already-current') {
      printLine(`Current ${update.path}`)
    } else if (update.action === 'would-update') {
      printLine(`Would update ${update.path}`)
    } else if (update.action === 'relinked') {
      printLine(`Relinked ${update.path}`)
    } else {
      printLine(`Updated ${update.path}`)
    }
  }
}

function skillsPathCommand() {
  const source = resolveSkillSource()

  if (hasJsonFlag()) {
    printJson({
      name: source.name,
      root: source.root,
      skillMd: source.skillMd,
      source: source.source,
      cliVersion: getCliVersion(),
      skillHash: computeSkillContentHash(source.root),
    })
    return
  }

  printLine(hasArg('--skill-md') ? source.skillMd : source.root)
}

const LAUNCHABLE_AGENTS: Record<string, string> = {
  claude: 'claude',
  codex: 'codex',
}

function findExecutable(name: string): string | null {
  const pathValue = process.env.PATH || ''
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) {
      continue
    }
    const candidate = join(dir, name)
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

function describeSetupAuthState(): { state: 'signed-in' | 'signed-out', baseUrl: string } {
  const baseUrl = getBaseUrl()
  return {
    state: getServerCredentials(baseUrl) ? 'signed-in' : 'signed-out',
    baseUrl,
  }
}

type SetupTeamChoice =
  | { kind: 'team', team: Team }
  | { kind: 'create' }

async function resolveSetupTeam(teamSlugArg: string | null, noInput: boolean, dryRun: boolean): Promise<Team> {
  const teams = await fetchTeams()
  const normalizedTeamSlug = teamSlugArg ? normalizeSlugInput(teamSlugArg) : null

  if (normalizedTeamSlug) {
    const team = teams.find(candidate => candidate.slug === normalizedTeamSlug)
    if (!team) {
      throw new Error(`Team '${normalizedTeamSlug}' was not found in your accessible teams.`)
    }
    return team
  }

  if (noInput || dryRun) {
    throw new Error('Authenticated setup requires --team <slug> when running non-interactively.')
  }

  const choices: SetupTeamChoice[] = [
    ...teams.map(team => ({ kind: 'team' as const, team })),
    { kind: 'create' },
  ]
  const choice = await promptKeyboardSelect(
    'Choose the team to set up in this directory',
    choices,
    item => item.kind === 'create'
      ? 'Create a new team'
      : `${item.team.name} (${item.team.slug})`
  )

  if (choice.kind === 'team') {
    return choice.team
  }

  const name = await askText('   Team name?', '')
  if (!name) {
    throw new Error('Team name is required to create a team.')
  }
  return createTeamOnServer(name)
}

async function resolveSetupProjects(team: Team): Promise<Project[]> {
  const projects = await fetchProjects(team.slug)

  if (projects.length === 0) {
    throw new Error(`Team '${team.slug}' has no projects. Create a project before running setup.`)
  }

  return projects
}

function projectSeedsFromProjects(projects: Project[]): WorkspaceProjectSeed[] {
  return projects.map(project => ({
    slug: project.slug,
    id: project.id,
    name: project.name,
  }))
}

function formatProjectSetupProgress(count: number): string {
  return `${count} project${count === 1 ? '' : 's'} being set up in workspace...`
}

interface SetupSkillChoice {
  agent: SkillInstallAgent
  label: string
  target: SkillInstallTarget
}

function setupTargetForAgent(agent: SkillInstallAgent): SkillInstallTarget {
  return agent === 'codex' ? 'codex-user' : 'claude-user'
}

function resolveSetupSkillHome(): string {
  return resolve(process.env.HOME || homedir())
}

function detectedSetupSkillChoices(homeDir: string): SetupSkillChoice[] {
  const choices: SetupSkillChoice[] = []
  if (existsSync(join(homeDir, '.codex'))) {
    choices.push({
      agent: 'codex',
      label: 'Codex',
      target: 'codex-user',
    })
  }

  if (existsSync(join(homeDir, '.claude'))) {
    choices.push({
      agent: 'claude',
      label: 'Claude Code',
      target: 'claude-user',
    })
  }

  return choices
}

function setupSkillTargetsFromArgs(): SkillInstallTarget[] {
  const targets: SkillInstallTarget[] = []
  for (const agent of getArgs('--agent')) {
    if (!isSkillInstallAgent(agent)) {
      throw new Error(
        `Unknown agent '${agent}'. Available agents: ${SKILL_INSTALL_AGENTS.join(', ')}`
      )
    }
    const target = setupTargetForAgent(agent)
    if (!targets.includes(target)) {
      targets.push(target)
    }
  }
  for (const target of getArgs('--target')) {
    if (!isSkillInstallTarget(target)) {
      throw new Error(
        `Unknown skill install target '${target}'. Available targets: ${SKILL_INSTALL_TARGETS.join(', ')}`
      )
    }
    if (!targets.includes(target)) {
      targets.push(target)
    }
  }
  return targets
}

function setupSkillLabel(target: SkillInstallTarget): string {
  if (target === 'codex-user' || target === 'codex-project' || target === 'agent-user' || target === 'agents-project') {
    return 'Codex skill'
  }
  if (target === 'claude-user' || target === 'claude-project') return 'Claude Code skill'
  return 'Orizu skill'
}

async function setupCommand() {
  const dryRun = hasArg('--dry-run')
  const validateOnly = hasArg('--validate') && !hasArg('--fix')
  const fix = hasArg('--fix')
  const verbose = hasArg('--verbose')
  const handoffRequested = hasArg('--handoff') || Boolean(getArg('--launch'))
  const skipConfirm = hasArg('--yes')
  const noInput = hasArg('--no-input') || hasArg('--non-interactive') || !isInteractiveTerminal()
  const workspaceArg = getOptionalArgValue('--workspace')
  const workspaceRoot = workspaceArg ? resolve(expandHomePath(workspaceArg)) : process.cwd() // non-empty-dir guard now lives next to the hosted clone in runInteractiveHostedSetup, so --skip-login / decline-connect / local scaffolds are never blocked
  const teamArg = getOptionalArgValue('--team')
  const projectArg = getOptionalArgValue('--project')
  const setupSkillHome = resolveSetupSkillHome()
  const installMode: SkillInstallMode = getArg('--mode') ? parseSkillInstallMode() : 'link'

  printBannerIfInteractive()
  printLine('Orizu setup')
  printLine('')

  // Step 1: login
  printLine('Step 1: Login')
  let auth = describeSetupAuthState()
  if (hasArg('--skip-login')) {
    printLine('   Skipped (--skip-login).')
  } else if (auth.state === 'signed-in') {
    printLine(`   Already authenticated with ${sanitizeTerminalText(auth.baseUrl)}.`)
  } else if (noInput || dryRun) {
    printLine('   Not signed in. Run `orizu login` to authenticate.')
  } else if (await waitForAnyKeyOrEscape('   Press any key to open a browser and connect to your account, or Esc to cancel.')) {
    await login()
    auth = describeSetupAuthState()
  } else {
    throw new Error('Setup cancelled.')
  }
  printLine('')

  // Step 2: local workspace
  printLine('Step 2: Setup your workspace')
  let workspaceState: 'created' | 'exists' | 'skipped' | 'would-create' | 'validated' | 'invalid' | 'repaired' = 'skipped'
  let workspaceResult: ReturnType<typeof initOrizuWorkspace> | null = null
  let validationLogPath: string | null = null
  let hostedAttached = false
  if (hasArg('--no-workspace') && !validateOnly && !fix) {
    printLine('   Skipped (--no-workspace).')
  } else {
    const wantsWorkspace = validateOnly
      || fix
      || hasArg('--workspace')
      || Boolean(teamArg || projectArg)
      || workspaceExists(workspaceRoot)
      || !noInput
    if (wantsWorkspace) {
      let teamSlug = teamArg
      const projectSlug = projectArg
      let teamId: string | null = null
      let projects: WorkspaceProjectSeed[] | undefined

      if (auth.state === 'signed-in' && !validateOnly) {
        const team = await resolveSetupTeam(teamSlug, noInput, dryRun)
        const serverProjects = await resolveSetupProjects(team)
        teamSlug = team.slug
        teamId = team.id
        projects = projectSeedsFromProjects(serverProjects)
        printLine(`   ${formatProjectSetupProgress(projects.length)}`)
        if (!hasArg('--local') && !noInput && !dryRun) { let link: GithubLinkResult | null = null; try { link = await runGithubLink(team.slug, { print: printLine, fetcher: authedFetch, openUrl: openInBrowser, confirm: (org) => askYesNo(`   Connect this team to GitHub org '${org}'?`, true) }) } catch (error) { printLine(`   GitHub link skipped: ${getErrorMessage(error)} Run \`orizu github link --team ${team.slug}\` to finish.`) }
        if (link) { try { hostedAttached = (await runInteractiveHostedSetup({ teamSlug: team.slug, targetDir: workspaceRoot, local: hasArg('--local'), activeInstallation: link.status === 'active' }, { print: printLine, fetcher: authedFetch })).attached } catch (error) { throw new Error(`Hosted setup failed: ${getErrorMessage(error)} Remove any partial clone in ${workspaceRoot} if one exists, then re-run \`orizu setup\` (or pass --local to scaffold a local-only workspace).`) } } }
      } else if (!teamSlug && !noInput && !validateOnly) {
        teamSlug = await askText('   Team slug?', 'local-team')
      }
      if (auth.state !== 'signed-in' && (!teamSlug || !projectSlug) && noInput && hasArg('--workspace')) {
        printLine('   Using starter local-only team/project. Pass --team with authentication to materialize server projects.')
      }
      if (projectSlug && auth.state !== 'signed-in') {
        projects = [{ slug: projectSlug }]
      }
      if (auth.state !== 'signed-in' && !validateOnly) {
        const localProjectCount = projects?.length || 1
        printLine(`   ${formatProjectSetupProgress(localProjectCount)}`)
      }

      if (hostedAttached) { workspaceState = 'exists' } else {
      const result = initOrizuWorkspace({
        workspaceRoot,
        teamSlug,
        teamId,
        projectSlug: auth.state === 'signed-in' ? null : projectSlug,
        projects,
        baseUrl: auth.baseUrl,
        serviceOrigin: getOptionalArgValue('--service-origin') || auth.baseUrl,
        attachWorkspaceId: getOptionalArgValue('--attach-workspace'),
        cliVersion: getCliVersion(),
        dryRun,
        validateOnly,
        fix,
        noSymlinks: hasArg('--no-symlinks'),
      })
      workspaceResult = result
      workspaceState = result.state
      if (dryRun || verbose) {
        for (const action of result.actions) {
          printLine(`   ${dryRun ? 'Would ' : 'Did '}${action}`)
        }
      } else if (result.actions.length > 0) {
        printLine(validateOnly ? '   Workspace validation complete' : '   Workspace setup complete')
      } else if (!validateOnly) {
        printLine('   Workspace setup complete')
      }
      validationLogPath = writeWorkspaceValidationLog(result.root, result.findings, dryRun)
      if (verbose) {
        printWorkspaceFindings(result.findings)
      }
      if ((validateOnly || fix) && result.findings.some(finding => finding.severity === 'error')) {
        process.exitCode = 1
      }
      }
    } else {
      printLine(`   Skipped. Rerun with --workspace to initialize the workspace contract.`)
    }
  }
  printLine('')

  // Step 3: global coding-agent skills
  let installOutcomes: SkillInstallOutcome[] = []
  printLine('Step 3: Install coding agent skills')
  if (hasArg('--no-install') || validateOnly || fix) {
    printLine(hasArg('--no-install') ? '   Skipped (--no-install).' : '   Skipped for validation/repair.')
  } else {
    let targets = setupSkillTargetsFromArgs()
    if (targets.length === 0 && !noInput && !dryRun) {
      const choices = detectedSetupSkillChoices(setupSkillHome)
      if (choices.length > 0) {
        const selectedChoices = await promptKeyboardMultiSelect(
          'Choose the coding agents that should learn how to use Orizu',
          choices,
          choice => choice.label,
          () => true
        )
        targets = selectedChoices.map(choice => choice.target)
      } else {
        printLine('   No Codex or Claude Code agent folders were detected.')
      }
    }

    if (targets.length === 0) {
      printLine('   Skipped skill install.')
    } else {
      printLine('   Installing skills...')
      installOutcomes = await applySkillInstallTargets(targets, {
        mode: installMode,
        skipConfirm,
        dryRun,
        cwd: workspaceRoot,
        homeDir: setupSkillHome,
        showPlan: false,
        printResults: false,
      })
      if (dryRun) {
        printLine('   Dry run: no skill files were changed.')
      }
      for (const outcome of installOutcomes) {
        const label = setupSkillLabel(outcome.target)
        if (outcome.action === 'failed') {
          printLine(`   ${label} failed: ${outcome.error}`)
        } else if (outcome.action === 'skipped') {
          printLine(`   ${label} skipped`)
        } else {
          printLine(`   ${label} installed`)
        }
      }
    }
  }
  printLine('')

  // Phase 4: coding-agent handoff
  const handoffPrompt = renderAgentSetupPrompt({
    workspacePath: workspaceResult && workspaceState !== 'invalid'
      ? getWorkspaceRoot(workspaceRoot)
      : null,
  })
  if (handoffRequested && !hasArg('--no-handoff')) {
    printLine('Step 4: Coding-agent handoff')
    printLine('   Give your coding agent this prompt to plan repo-specific Orizu adoption:')
    printLine('')
    printLine('--- prompt start ---')
    printLine(handoffPrompt)
    printLine('--- prompt end ---')
    printLine('')

    const detected = Object.keys(LAUNCHABLE_AGENTS).filter(agent => findExecutable(LAUNCHABLE_AGENTS[agent]))
    if (detected.length > 0) {
      printLine(`   Detected agents: ${detected.join(', ')}. Launch one with the prompt, e.g.:`)
      for (const agent of detected) {
        printLine(`     ${LAUNCHABLE_AGENTS[agent]} "$(orizu setup prompt)"`)
      }
    }

    const launchAgent = getArg('--launch')
    if (launchAgent) {
      if (!(launchAgent in LAUNCHABLE_AGENTS)) {
        throw new Error(`Unknown --launch agent '${launchAgent}'. Choices: ${Object.keys(LAUNCHABLE_AGENTS).join(', ')}.`)
      }
      const binary = findExecutable(LAUNCHABLE_AGENTS[launchAgent])
      if (!isInteractiveTerminal()) {
        printLine('   Not launching: --launch requires an interactive terminal.')
      } else if (!binary) {
        printLine(`   Not launching: '${LAUNCHABLE_AGENTS[launchAgent]}' was not found on PATH.`)
      } else if (dryRun) {
        printLine(`   Would launch ${binary} with the setup prompt.`)
      } else if (skipConfirm || await askYesNo(`   Launch ${LAUNCHABLE_AGENTS[launchAgent]} with the setup prompt now?`, true)) {
        printLine(`   Launching ${binary}…`)
        spawnSync(binary, [handoffPrompt], { stdio: 'inherit' })
      }
    }
    printLine('')
  }

  // Setup summary (success criteria checklist)
  const summaryTargets = installOutcomes.length > 0
    ? installOutcomes
      .filter(outcome => outcome.action !== 'failed')
      .map(outcome => ({ outcome, status: getSkillTargetStatus(outcome.target, { cwd: workspaceRoot, homeDir: setupSkillHome }) }))
    : []
  const source = resolveSkillSource()

  if (hasJsonFlag()) {
    printJson({
      auth: { state: auth.state, server: auth.baseUrl },
      integrations: installOutcomes.map(outcome => ({
        target: outcome.target,
        path: outcome.path,
        action: outcome.action,
        mode: outcome.mode,
        error: outcome.error,
      })),
      skill: {
        root: source.root,
        source: source.source,
        cliVersion: getCliVersion(),
        skillHash: computeSkillContentHash(source.root),
      },
      workspace: {
        state: workspaceState,
        path: getWorkspaceRoot(workspaceRoot),
        validationLogPath,
        operations: workspaceResult?.operations.map(op => ({
          action: op.action,
          path: op.path,
          safe: op.safe,
          reason: op.reason,
          entries: op.entries,
          sourcePath: op.sourcePath,
          target: op.target,
        })) || [],
        findings: workspaceResult?.findings || [],
      },
    })
    return
  }

  printLine('Setup summary')
  printLine(`  Auth:         ${auth.state === 'signed-in' ? `signed in (${sanitizeTerminalText(auth.baseUrl)})` : 'not signed in — run `orizu login`'}`)
  if (summaryTargets.length > 0) {
    printLine('  Skills:')
    for (const { outcome, status } of summaryTargets) {
      const modeLabel = status.mode ? `, ${status.mode}` : ''
      printLine(`    ${outcome.target.padEnd(16)} ${status.state}${modeLabel}  ${outcome.path}`)
    }
  } else {
    printLine('  Skills:       none installed this run')
  }
  const failed = installOutcomes.filter(outcome => outcome.action === 'failed')
  for (const failure of failed) {
    printLine(`    ${failure.target.padEnd(16)} failed: ${failure.error}`)
  }
  printLine(`  Workspace:    ${workspaceState === 'skipped' ? 'skipped' : getWorkspaceRoot(workspaceRoot)}`)
  if (workspaceResult) {
    printLine(`  Validation:   ${validationSummary(workspaceResult.findings, validationLogPath)}`)
  }
  printLine('  Next:         run `orizu setup prompt` if you want a coding-agent handoff prompt.')
}

function setupPromptCommand() {
  const prompt = renderAgentSetupPrompt({
    workspacePath: workspaceExists() ? getWorkspaceRoot() : null,
  })
  if (hasJsonFlag()) {
    printJson({ prompt })
    return
  }
  printLine(prompt)
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

function parseCommaSeparated(value: string | null): string[] {
  if (!value) {
    return []
  }
  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
}

function readAssignmentManifest(path: string | null): ReturnType<typeof readAssignmentManifestJsonlFile> | null {
  if (!path) {
    return null
  }

  return readAssignmentManifestJsonlFile(expandHomePath(path))
}

function readOptionalTaskTextArg(
  valueFlag: string,
  fileFlag: string
): string | undefined {
  const value = getArg(valueFlag)
  const file = getArg(fileFlag)
  rejectDashPrefixedOptionValue(valueFlag, value)
  rejectDashPrefixedOptionValue(fileFlag, file)

  if (value !== null && file !== null) {
    throw new Error(`Use either ${valueFlag} or ${fileFlag}, not both.`)
  }

  if (file !== null) {
    return readSourceFile(file)
  }

  return value ?? undefined
}

function readPositiveIntegerFlag(name: string): number | undefined {
  const value = getArg(name)
  rejectDashPrefixedOptionValue(name, value)
  if (value === null) {
    return undefined
  }

  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`)
  }

  return parsed
}

async function createTask() {
  const projectSlug = getArg('--project')
  const datasetId = getArg('--dataset')
  const appId = getArg('--app')
  const title = getArg('--title')
  const assignees = parseCommaSeparated(getArg('--assignees'))
  const assignmentFile = getArg('--assignment-file')
  const publish = hasArg('--publish')
  const versionArg = getArg('--version')
  const instructions = getArg('--instructions')
  const labelsPerItemArg = getArg('--labels-per-item')
  const parsedLabelsPerItem = labelsPerItemArg ? Number(labelsPerItemArg) : 1
  const labelsPerItem =
    Number.isInteger(parsedLabelsPerItem) && parsedLabelsPerItem > 0
      ? parsedLabelsPerItem
      : null
  const parsedVersionNum = versionArg ? Number(versionArg) : Number.NaN
  const versionNum =
    Number.isInteger(parsedVersionNum) && parsedVersionNum > 0 ? parsedVersionNum : null

  if (assignmentFile && assignees.length > 0) {
    throw new Error('Use either --assignment-file or --assignees, not both.')
  }

  const explicitAssignments = readAssignmentManifest(assignmentFile)

  if (!projectSlug || !datasetId || !appId || !title || (publish && assignees.length === 0 && !explicitAssignments)) {
    throw new Error('Usage: orizu tasks create --project <team/project> --dataset <datasetId> --app <appId> --title <title> [--assignees <userIdOrEmail1,userIdOrEmail2> | --assignment-file <path>] [--publish] [--version <n>] [--instructions <text>] [--labels-per-item <n>] [--json]')
  }

  if (versionArg && versionNum === null) {
    throw new Error('--version must be a positive integer')
  }

  if (labelsPerItemArg && labelsPerItem === null) {
    throw new Error('--labels-per-item must be a positive integer')
  }

  const requestBody: Record<string, unknown> = {
    projectSlug,
    datasetId,
    appId,
    versionNum,
    title,
    publish,
    instructions,
  }

  if (explicitAssignments) {
    requestBody.explicitAssignments = explicitAssignments
  } else {
    requestBody.memberIds = assignees
  }

  if (!explicitAssignments || labelsPerItemArg) {
    requestBody.requiredAssignmentsPerRow = labelsPerItem
  }

  const response = await authedFetch('/api/cli/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  })

  if (!response.ok) {
    const cliError = await formatTaskCreateError(response)
    if (hasJsonFlag()) {
      const payload = cliError.structuredPayload ?? { error: cliError.message }
      printLine(JSON.stringify({
        ...payload,
        httpStatus: cliError.httpStatus,
      }, null, 2))
    }
    throw cliError
  }

  const data = await parseJsonResponse<{
    task: {
      id: string
      title: string
      status: string
      requiredAssignmentsPerRow: number
      versionId: string
      versionNum: number
    }
    assignmentsCreated: number
    assignmentShortfall?: number
    warning?: string
  }>(response, 'Task create')

  if (hasJsonFlag()) {
    printLine(JSON.stringify({
      taskId: data.task.id,
      datasetId,
      versionId: data.task.versionId,
      versionNum: data.task.versionNum,
      taskUrl: `${getBaseUrl()}/d/${projectSlug}/tasks/${data.task.id}`,
      title: data.task.title,
      status: data.task.status,
      assignmentMode: explicitAssignments ? 'custom' : 'auto',
      requiredAssignmentsPerRow: data.task.requiredAssignmentsPerRow,
      assignmentsCreated: data.assignmentsCreated,
      draft: data.task.status === 'draft',
      ...(data.task.status === 'draft'
        ? {
            message: 'Draft created. Test it manually before assigning.',
            publishCommand: explicitAssignments
              ? `orizu tasks publish --task ${data.task.id} --assignment-file ${assignmentFile ? shellQuote(assignmentFile) : '<path>'}`
              : `orizu tasks publish --task ${data.task.id} --assignees <userId1,userId2>`,
          }
        : {}),
      ...(data.assignmentShortfall !== undefined ? { assignmentShortfall: data.assignmentShortfall } : {}),
      ...(data.warning ? { warning: data.warning } : {}),
    }, null, 2))
    return
  }

  const baseUrl = getBaseUrl()
  const taskUrl = `${baseUrl}/d/${projectSlug}/tasks/${data.task.id}`
  const isDraft = data.task.status === 'draft'
  printLine(
    `Created ${isDraft ? 'draft ' : ''}task ${sanitizeTerminalText(data.task.title)} (${sanitizeTerminalText(data.task.id)}) [${sanitizeTerminalText(data.task.status)}]` +
    `\n  Task ID:    ${sanitizeTerminalText(data.task.id)}` +
    `\n  Dataset ID: ${sanitizeTerminalText(datasetId)}` +
    `\n  Version:    v${data.task.versionNum} (${sanitizeTerminalText(data.task.versionId)})` +
    `\n  Mode:       ${explicitAssignments ? 'custom row map' : 'auto distribute'}` +
    `\n  Labels/row: ${data.task.requiredAssignmentsPerRow}` +
    `\n  Assignments: ${data.assignmentsCreated}` +
    (data.warning ? `\n  Warning:    ${sanitizeTerminalText(data.warning)}` : '') +
    `\n  URL:        ${sanitizeTerminalText(taskUrl)}` +
    (isDraft
      ? `\n\nThis task is a draft. Test it manually before assigning.\nPublish after approval: ${
          explicitAssignments
            ? `orizu tasks publish --task ${sanitizeTerminalText(data.task.id)} --assignment-file ${sanitizeTerminalText(assignmentFile || '<path>')}`
            : `orizu tasks publish --task ${sanitizeTerminalText(data.task.id)} --assignees <userId1,userId2>`
        }`
      : '')
  )
}

async function updateTask() {
  const taskId = getArg('--task')
  rejectDashPrefixedOptionValue('--task', taskId)
  if (!taskId) {
    throw new Error('Usage: orizu tasks update --task <taskId> [--title <text>] [--description <text>|--description-file <path>] [--instructions <text>|--instructions-file <path>] [--dataset <datasetId>] [--app <appId> [--version <n>]] [--labels-per-item <n>] [--assignees <userIdOrEmail1,userIdOrEmail2> | --assignment-file <path>] [--json]')
  }

  const title = getArg('--title')
  const description = readOptionalTaskTextArg('--description', '--description-file')
  const instructions = readOptionalTaskTextArg('--instructions', '--instructions-file')
  const datasetId = getArg('--dataset')
  const appId = getArg('--app')
  const versionNum = readPositiveIntegerFlag('--version')
  const requiredAssignmentsPerRow = readPositiveIntegerFlag('--labels-per-item')
  const assignees = parseCommaSeparated(getArg('--assignees'))
  const assignmentFile = getArg('--assignment-file')

  rejectDashPrefixedOptionValue('--title', title)
  rejectDashPrefixedOptionValue('--dataset', datasetId)
  rejectDashPrefixedOptionValue('--app', appId)
  rejectDashPrefixedOptionValue('--assignment-file', assignmentFile)

  if (title !== null && title.trim().length === 0) {
    throw new Error('--title must be a non-empty string')
  }

  if (assignmentFile && assignees.length > 0) {
    throw new Error('Use either --assignment-file or --assignees, not both.')
  }

  if (hasArg('--assignees') && assignees.length === 0) {
    throw new Error('--assignees requires at least one user ID or email')
  }

  if (versionNum !== undefined && !appId) {
    throw new Error('--version requires --app')
  }

  const explicitAssignments = readAssignmentManifest(assignmentFile)
  const requestBody: Record<string, unknown> = {}
  if (title !== null) requestBody.title = title.trim()
  if (description !== undefined) requestBody.description = description
  if (instructions !== undefined) requestBody.instructions = instructions
  if (datasetId !== null) requestBody.datasetId = datasetId
  if (appId !== null) requestBody.appId = appId
  if (versionNum !== undefined) requestBody.versionNum = versionNum
  if (requiredAssignmentsPerRow !== undefined) {
    requestBody.requiredAssignmentsPerRow = requiredAssignmentsPerRow
  }
  if (explicitAssignments) {
    requestBody.explicitAssignments = explicitAssignments
  } else if (hasArg('--assignees')) {
    requestBody.memberIds = assignees
  }

  if (Object.keys(requestBody).length === 0) {
    throw new Error('Usage: orizu tasks update --task <taskId> [--title <text>] [--description <text>|--description-file <path>] [--instructions <text>|--instructions-file <path>] [--dataset <datasetId>] [--app <appId> [--version <n>]] [--labels-per-item <n>] [--assignees <userIdOrEmail1,userIdOrEmail2> | --assignment-file <path>] [--json]')
  }

  const response = await authedFetch(`/api/cli/tasks/${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  })

  if (!response.ok) {
    throw new Error(`Failed to update task: ${await extractErrorMessage(response)}`)
  }

  const data = await parseJsonResponse<{
    task: {
      id: string
      title?: string | null
      status?: string | null
      dataset_id?: string | null
      app_id?: string | null
      version_id?: string | null
      required_assignments_per_row?: number | null
    }
    assignmentMode?: string
    assignmentsCreated?: number
  }>(response, 'Task update')

  if (hasJsonFlag()) {
    printJson({
      taskId: data.task.id,
      title: data.task.title ?? null,
      status: data.task.status ?? null,
      datasetId: data.task.dataset_id ?? null,
      appId: data.task.app_id ?? null,
      versionId: data.task.version_id ?? null,
      requiredAssignmentsPerRow: data.task.required_assignments_per_row ?? null,
      ...(data.assignmentMode ? { assignmentMode: data.assignmentMode } : {}),
      ...(data.assignmentsCreated !== undefined
        ? { assignmentsCreated: data.assignmentsCreated }
        : {}),
    })
    return
  }

  printLine(
    `Updated draft task ${sanitizeTerminalText(data.task.title || data.task.id)} (${sanitizeTerminalText(data.task.id)})` +
    (data.task.status ? ` [${sanitizeTerminalText(data.task.status)}]` : '') +
    (data.task.dataset_id ? `\n  Dataset ID: ${sanitizeTerminalText(data.task.dataset_id)}` : '') +
    (data.task.version_id ? `\n  Version ID: ${sanitizeTerminalText(data.task.version_id)}` : '') +
    (data.task.required_assignments_per_row
      ? `\n  Labels/row: ${data.task.required_assignments_per_row}`
      : '') +
    (data.assignmentMode ? `\n  Mode:       ${sanitizeTerminalText(data.assignmentMode === 'custom' ? 'custom row map' : 'auto distribute')}` : '') +
    (data.assignmentsCreated !== undefined ? `\n  Assignments: ${data.assignmentsCreated}` : '')
  )
}

async function discardTask() {
  const taskId = getArg('--task')
  rejectDashPrefixedOptionValue('--task', taskId)
  if (!taskId) {
    throw new Error('Usage: orizu tasks discard --task <taskId> [--yes] [--json]')
  }

  if (!hasArg('--yes')) {
    if (!isInteractiveTerminal()) {
      throw new Error('Refusing to discard a draft in non-interactive mode without --yes')
    }

    const confirmed = await askYesNo(`Discard draft task ${taskId}? This cannot be undone.`, false)
    if (!confirmed) {
      printLine('Discard cancelled.')
      return
    }
  }

  const response = await authedFetch(`/api/cli/tasks/${encodeURIComponent(taskId)}`, {
    method: 'DELETE',
  })

  if (!response.ok) {
    throw new Error(`Failed to discard draft task: ${await extractErrorMessage(response)}`)
  }

  const data = await parseJsonResponse<{ success: boolean }>(response, 'Task discard')
  if (hasJsonFlag()) {
    printJson({ taskId, discarded: data.success })
    return
  }

  printLine(`Discarded draft task ${sanitizeTerminalText(taskId)}.`)
}

async function publishTask() {
  const taskId = getArg('--task')
  const assignees = parseCommaSeparated(getArg('--assignees'))
  const assignmentFile = getArg('--assignment-file')

  if (assignmentFile && assignees.length > 0) {
    throw new Error('Use either --assignment-file or --assignees, not both.')
  }

  const explicitAssignments = readAssignmentManifest(assignmentFile)

  if (!taskId || (assignees.length === 0 && !explicitAssignments)) {
    throw new Error('Usage: orizu tasks publish --task <taskId> (--assignees <userId1,userId2> | --assignment-file <path>) [--json]')
  }

  const response = await authedFetch(`/api/cli/tasks/${encodeURIComponent(taskId)}/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      explicitAssignments
        ? { explicitAssignments }
        : { memberIds: assignees }
    ),
  })

  if (!response.ok) {
    throw new Error(`Failed to publish task: ${await extractErrorMessage(response)}`)
  }

  const data = await parseJsonResponse<{
    task: { id: string; status: string }
    assignmentsProcessed: number
    assignmentsCreated: number
    assignmentsRemoved?: number
    assignmentShortfall?: number
    warning?: string
  }>(
    response,
    'Task publish'
  )

  if (hasJsonFlag()) {
    printLine(JSON.stringify({
      taskId: data.task.id,
      status: data.task.status,
      assignmentMode: explicitAssignments ? 'custom' : 'auto',
      assignmentsCreated: data.assignmentsCreated,
      assignmentsProcessed: data.assignmentsProcessed,
      ...(data.assignmentsRemoved !== undefined
        ? { assignmentsRemoved: data.assignmentsRemoved }
        : {}),
      ...(data.assignmentShortfall !== undefined
        ? { assignmentShortfall: data.assignmentShortfall }
        : {}),
      ...(data.warning ? { warning: data.warning } : {}),
    }, null, 2))
    return
  }

  printLine(
    `Published task ${sanitizeTerminalText(data.task.id)} [${sanitizeTerminalText(data.task.status)}]` +
    `\n  Mode:        ${explicitAssignments ? 'custom row map' : 'auto distribute'}` +
    `\n  Assignments: ${data.assignmentsCreated}` +
    (data.assignmentsRemoved !== undefined
      ? `\n  Replaced:    ${data.assignmentsRemoved} old assignments removed`
      : '') +
    (data.warning ? `\n  Warning:     ${sanitizeTerminalText(data.warning)}` : '')
  )
}

async function assignTask() {
  const taskId = getArg('--task')
  const assignees = parseCommaSeparated(getArg('--assignees'))
  const assignmentFile = getArg('--assignment-file')

  if (assignmentFile && assignees.length > 0) {
    throw new Error('Use either --assignment-file or --assignees, not both.')
  }

  const explicitAssignments = readAssignmentManifest(assignmentFile)

  if (!taskId || (assignees.length === 0 && !explicitAssignments)) {
    throw new Error('Usage: orizu tasks assign --task <taskId> (--assignees <userId1,userId2> | --assignment-file <path>) [--replace-existing] [--json]')
  }

  const requestBody: Record<string, unknown> = explicitAssignments
    ? { explicitAssignments }
    : { memberIds: assignees }
  if (hasArg('--replace-existing')) {
    requestBody.replaceExisting = true
  }

  const response = await authedFetch(`/api/cli/tasks/${encodeURIComponent(taskId)}/assign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  })

  if (!response.ok) {
    throw new Error(`Failed to assign task: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{
    assignmentsProcessed?: number
    assignmentsCreated: number
    assignmentsRemoved?: number
    assignmentShortfall?: number
    warning?: string
  }>(response, 'Task assign')
  if (hasJsonFlag()) {
    printJson({
      assignmentMode: explicitAssignments ? 'custom' : 'auto',
      assignmentsProcessed: data.assignmentsProcessed ?? data.assignmentsCreated,
      assignmentsCreated: data.assignmentsCreated,
      ...(data.assignmentsRemoved !== undefined
        ? { assignmentsRemoved: data.assignmentsRemoved }
        : {}),
      ...(data.assignmentShortfall !== undefined
        ? { assignmentShortfall: data.assignmentShortfall }
        : {}),
      ...(data.warning ? { warning: data.warning } : {}),
    })
    return
  }
  printLine(
    `Created ${data.assignmentsCreated} assignments.` +
    `\n  Mode: ${explicitAssignments ? 'custom row map' : 'auto distribute'}` +
    (data.assignmentsRemoved !== undefined
      ? `\n  Replaced: ${data.assignmentsRemoved} old assignments removed`
      : '') +
    (data.warning ? `\n  Warning: ${sanitizeTerminalText(data.warning)}` : '')
  )
}

async function taskStatus() {
  const taskId = getArg('--task')
  if (!taskId) {
    throw new Error('Usage: orizu tasks status --task <taskId> [--json]')
  }

  const response = await authedFetch(`/api/cli/tasks/${encodeURIComponent(taskId)}/status`)
  if (!response.ok) {
    const rawBody = await response.text()
    if (hasJsonFlag()) {
      let errorPayload: Record<string, unknown> = { error: rawBody }
      try {
        const parsed = JSON.parse(rawBody)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          errorPayload = parsed as Record<string, unknown>
        }
      } catch {
        // keep raw body as error
      }
      printLine(JSON.stringify({
        ...errorPayload,
        httpStatus: response.status,
      }, null, 2))
    }

    let errorMsg = rawBody
    try {
      const parsed = JSON.parse(rawBody)
      if (parsed && typeof parsed === 'object' && typeof parsed.error === 'string') {
        errorMsg = parsed.error
      }
    } catch { /* use rawBody as-is */ }
    throw new Error(`Failed to fetch task status: ${errorMsg}`)
  }

  const data = await parseJsonResponse<TaskStatusPayload>(response, 'Task status')
  if (hasJsonFlag()) {
    printLine(JSON.stringify(data, null, 2))
    return
  }

  printTaskStatusSummary(data)
}

async function updateTaskStatus(targetStatus: 'paused' | 'active' | 'completed') {
  const taskId = getArg('--task')
  const labels = TASK_STATUS_ACTION_LABELS[targetStatus]

  if (!taskId) {
    throw new Error(`Usage: orizu tasks ${labels.verb} --task <taskId>`)
  }

  const response = await authedFetch(`/api/cli/tasks/${encodeURIComponent(taskId)}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: targetStatus }),
  })

  if (!response.ok) {
    throw new Error(`Failed to ${labels.verb} task: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{ task: { id: string; status: string } }>(response, 'Task status update')
  if (hasJsonFlag()) {
    printJson({ task: data.task })
    return
  }
  printLine(`${labels.pastTense} task ${sanitizeTerminalText(data.task.id)} [${sanitizeTerminalText(data.task.status)}]`)
}

async function setTaskReport() {
  const taskId = getArg('--task')
  rejectDashPrefixedOptionValue('--task', taskId)
  if (!taskId) {
    throw new Error(
      'Usage: orizu tasks report set --task <taskId> (--report <markdown|@file> | --report-file <path>) [--json]'
    )
  }

  const report = readTaskReportInput()
  if (!report) {
    throw new Error(
      'Usage: orizu tasks report set --task <taskId> (--report <markdown|@file> | --report-file <path>) [--json]'
    )
  }

  const response = await authedFetch(`/api/cli/tasks/${encodeURIComponent(taskId)}/report`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reportMarkdown: report.markdown,
      reportSourceName: report.sourceName,
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to update task report: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{
    task: {
      id: string
      status: string
      report: {
        markdown: string
        sourceName: string | null
        createdAt: string | null
      }
    }
  }>(response, 'Task report update')

  if (hasJsonFlag()) {
    printJson(data)
    return
  }

  printLine(
    `Uploaded task report for ${sanitizeTerminalText(data.task.id)} ` +
    `[${sanitizeTerminalText(data.task.status)}]`
  )
}

async function getTaskReport() {
  const taskId = getArg('--task')
  rejectDashPrefixedOptionValue('--task', taskId)
  if (!taskId) {
    throw new Error('Usage: orizu tasks report get --task <taskId> [--json]')
  }

  const response = await authedFetch(`/api/cli/tasks/${encodeURIComponent(taskId)}/report`)
  if (!response.ok) {
    throw new Error(`Failed to read task report: ${await response.text()}`)
  }

  const data = await parseJsonResponse<TaskReportPayload>(response, 'Task report get')
  if (hasJsonFlag()) {
    printJson(data as unknown as Record<string, unknown>)
    return
  }

  const title = data.task.title ? `${data.task.title} ` : ''
  printLine(`Task report: ${sanitizeTerminalText(title)}(${sanitizeTerminalText(data.task.id)})`)
  if (data.task.status) {
    printLine(`Status: ${sanitizeTerminalText(data.task.status)}`)
  }
  if (data.task.report.sourceName) {
    printLine(`Source: ${sanitizeTerminalText(data.task.report.sourceName)}`)
  }
  if (data.task.report.createdAt) {
    printLine(`Created: ${sanitizeTerminalText(data.task.report.createdAt)}`)
  }
  printLine('')
  printLine(sanitizeTerminalText(data.task.report.markdown))
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

async function listTeamMembers() {
  const teamSlug = await resolveTeamSlug(getArg('--team'))
  const members = await fetchTeamMembers(teamSlug)
  if (hasJsonFlag()) {
    printJson({ team: teamSlug, members })
    return
  }
  printTeamMembers(members)
}

async function addTeamMember() {
  const teamSlug = await resolveTeamSlug(getArg('--team'))
  const email = getArg('--email')
  if (!email) {
    throw new Error('Usage: orizu teams members add --email <email> [--team <teamSlug>]')
  }

  const response = await authedFetch(`/api/cli/teams/${encodeURIComponent(teamSlug)}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  if (!response.ok) {
    throw new Error(`Failed to add team member: ${await response.text()}`)
  }
  const data = await parseJsonResponse<{ member: TeamMember }>(response, 'Team member add')
  if (hasJsonFlag()) {
    printJson({ member: data.member })
    return
  }
  printLine(`Added team member ${sanitizeTerminalText(data.member.email)} (${sanitizeTerminalText(data.member.id)})`)
}

async function removeTeamMember() {
  const teamSlug = await resolveTeamSlug(getArg('--team'))
  const email = getArg('--email')
  if (!email) {
    throw new Error('Usage: orizu teams members remove --email <email> [--team <teamSlug>]')
  }

  const members = await fetchTeamMembers(teamSlug)
  const member = members.find(item => item.email.toLowerCase() === email.toLowerCase())
  if (!member) {
    throw new Error(`No member found with email '${email}' in team '${teamSlug}'`)
  }

  const response = await authedFetch(
    `/api/cli/teams/${encodeURIComponent(teamSlug)}/members/${encodeURIComponent(member.id)}`,
    { method: 'DELETE' }
  )
  if (!response.ok) {
    throw new Error(`Failed to remove team member: ${await response.text()}`)
  }
  if (hasJsonFlag()) {
    printJson({ removed: { id: member.id, email: member.email } })
    return
  }
  printLine(`Removed team member ${sanitizeTerminalText(member.email)}`)
}

async function changeTeamMemberRole() {
  const teamSlugArg = getArg('--team')
  const teamSlug = teamSlugArg ? normalizeSlugInput(teamSlugArg) : null
  const email = getArg('--email')
  const role = getArg('--role')
  if (!teamSlug || !email || !role) {
    throw new Error('Usage: orizu teams members role --team <teamSlug> --email <email> --role <admin|curator|judge>')
  }
  if (!['admin', 'curator', 'judge'].includes(role)) {
    throw new Error('role must be one of: admin, curator, judge')
  }

  const members = await fetchTeamMembers(teamSlug)
  const member = members.find(item => item.email.toLowerCase() === email.toLowerCase())
  if (!member) {
    throw new Error(`No member found with email '${email}' in team '${teamSlug}'`)
  }

  const response = await authedFetch(
    `/api/cli/teams/${encodeURIComponent(teamSlug)}/members/${encodeURIComponent(member.id)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    }
  )

  if (!response.ok) {
    throw new Error(`Failed to update member role: ${await response.text()}`)
  }

  if (hasJsonFlag()) {
    printJson({ member: { id: member.id, email: member.email, role } })
    return
  }
  printLine(`Updated ${sanitizeTerminalText(member.email)} role to ${sanitizeTerminalText(role)}`)
}

async function createDatasetFromRows(
  project: string,
  name: string,
  sourceType: DatasetUploadSourceType,
  rows: Array<Record<string, unknown>>,
  readmeMarkdown: string | null = null
): Promise<DatasetUploadResponse> {
  const response = await authedFetch('/api/cli/datasets/upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      projectSlug: project,
      name,
      rows,
      sourceType,
      ...(readmeMarkdown !== null ? { readmeMarkdown } : {}),
    }),
  })

  if (!response.ok) {
    const body = await parseJsonResponse<{ error: string; code?: string }>(response, 'Dataset upload')
    throw new Error(`Upload failed: ${body.error}`)
  }

  return parseJsonResponse<DatasetUploadResponse>(response, 'Dataset upload')
}

async function uploadJsonlDatasetInChunks(
  file: string,
  project: string,
  datasetName: string,
  readmeMarkdown: string | null = null
) {
  let dataset: DatasetUploadResponse['dataset'] | null = null
  let totalUploaded = 0
  let chunkIndex = 0
  const chunks = streamJsonlRowChunks(file)[Symbol.asyncIterator]()

  while (true) {
    let nextChunk: IteratorResult<Array<Record<string, unknown>>>
    try {
      nextChunk = await chunks.next()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!dataset) {
        throw new Error(message)
      }

      throw new Error(
        `Upload stopped while reading the next JSONL chunk: ${message}\n` +
        `Dataset ${sanitizeTerminalText(dataset.name)} (${sanitizeTerminalText(dataset.id)}) was created and ${totalUploaded} rows were uploaded. ` +
        `Fix the file, remove the first ${totalUploaded} rows, and run ` +
        `orizu datasets append --dataset ${dataset.id} --file <remaining-file>.`
      )
    }

    if (nextChunk.done) {
      break
    }

    const chunk = nextChunk.value
    chunkIndex += 1
    printLine(`Uploading chunk ${chunkIndex} (${chunk.length} rows)...`)

    try {
      if (!dataset) {
        const data = await createDatasetFromRows(project, datasetName, 'jsonl', chunk, readmeMarkdown)
        dataset = data.dataset
        totalUploaded = data.dataset.rowCount
        continue
      }

      const data = await appendChunk(dataset.id, chunk)
      totalUploaded += data.appendedCount
      dataset = {
        ...dataset,
        rowCount: data.dataset.rowCount,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!dataset) {
        throw new Error(message)
      }

      throw new Error(
        `Chunk ${chunkIndex} failed: ${message}\n` +
        `Dataset ${dataset.name} (${dataset.id}) was created and ${totalUploaded} rows were uploaded. ` +
        `To retry, remove the first ${totalUploaded} rows from your file and run ` +
        `orizu datasets append --dataset ${dataset.id} --file <remaining-file>.`
      )
    }
  }

  if (!dataset) {
    throw new Error('Dataset file contains no rows')
  }

  if (hasJsonFlag()) {
    printJson({ dataset })
    return
  }
  printLine(`Uploaded dataset ${sanitizeTerminalText(dataset.name)} (${sanitizeTerminalText(dataset.id)}) with ${dataset.rowCount} rows.`)
  if (dataset.url) {
    printLine(`View dataset: ${formatTerminalLink(dataset.url)}`)
  }
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
  const data = await createDatasetFromRows(project, datasetName, sourceType, rows, readmeMarkdown)

  if (hasJsonFlag()) {
    printJson({ dataset: data.dataset })
    return
  }
  printLine(`Uploaded dataset ${sanitizeTerminalText(data.dataset.name)} (${sanitizeTerminalText(data.dataset.id)}) with ${data.dataset.rowCount} rows.`)
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
  const data = await createDatasetFromRows(project, datasetName, sourceType, rows, readmeMarkdown)

  if (hasJsonFlag()) {
    const payload: Record<string, unknown> = {
      dataset_id: data.dataset.id,
      name: data.dataset.name,
      row_count: data.dataset.rowCount,
    }
    if (data.readmeVersion?.id) {
      payload.readme_version_id = data.readmeVersion.id
    }
    printJson(payload)
    return
  }

  printLine(`Uploaded dataset ${sanitizeTerminalText(data.dataset.name)} (${sanitizeTerminalText(data.dataset.id)}) with ${data.dataset.rowCount} rows.`)
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

  const response = await authedFetch(
    `/api/cli/datasets/${encodeURIComponent(datasetId)}/download?format=${encodeURIComponent(format)}`
  )
  if (!response.ok) {
    throw new Error(`Download failed: ${await response.text()}`)
  }

  const filename = outPathArg
    ? expandHomePath(outPathArg)
    : `${datasetId}.${format}`

  const bytes = new Uint8Array(await response.arrayBuffer())
  writeFileSync(filename, bytes)

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

  const file = expandHomePath(fileArg)
  const { rows } = parseDatasetFile(file)
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('Dataset edit file must contain at least one row')
  }

  const normalizedRows = rows.map((row, index) => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw new Error(`Dataset edit file rows[${index}] must be an object`)
    }

    const rowRecord = row as Record<string, unknown>
    const rowId = typeof rowRecord.id === 'string' ? rowRecord.id.trim() : ''
    if (!rowId) {
      throw new Error(`Dataset edit file rows[${index}] must include a non-empty string id`)
    }

    return {
      ...rowRecord,
      id: rowId,
    }
  })

  const response = await authedFetch(`/api/cli/datasets/${encodeURIComponent(datasetId)}/rows`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows: normalizedRows }),
  })

  if (!response.ok) {
    throw new Error(`Edit rows failed: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{
    dataset: { id: string; name: string; rowCount: number }
    updatedCount: number
  }>(response, 'Dataset edit rows')

  if (hasJsonFlag()) {
    printJson({ dataset: data.dataset, updatedCount: data.updatedCount })
    return
  }
  printLine(
    `Updated ${data.updatedCount} rows in dataset ${sanitizeTerminalText(data.dataset.name)} (${sanitizeTerminalText(data.dataset.id)}). Current row count: ${data.dataset.rowCount}`
  )
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

function readRunnerManifest(runnerDir: string): { command: string[]; supports_body_kind?: string[] } {
  const manifestPath = join(runnerDir, 'manifest.json')
  const raw = readSourceFile(manifestPath)
  const manifest = JSON.parse(raw) as {
    command?: unknown
    supports_body_kind?: unknown
    supports_body_kinds?: unknown
  }

  if (!Array.isArray(manifest.command) || !manifest.command.every(item => typeof item === 'string')) {
    throw new Error(`Runner manifest at ${manifestPath} must include command: string[]`)
  }

  const supportedBodyKinds = manifest.supports_body_kinds ?? manifest.supports_body_kind
  if (
    supportedBodyKinds !== undefined &&
    (!Array.isArray(supportedBodyKinds) ||
      !supportedBodyKinds.every(item => typeof item === 'string'))
  ) {
    throw new Error(`Runner manifest at ${manifestPath} has invalid supports_body_kinds`)
  }

  return {
    command: manifest.command,
    supports_body_kind: supportedBodyKinds as string[] | undefined,
  }
}

const RUNNER_TIMEOUT_MS = 120_000
const RUNNER_OUTPUT_MAX_BYTES = 2 * 1024 * 1024
const RUNNER_ENV_ALLOWLIST = new Set([
  'PATH',
  'SystemRoot',
  'WINDIR',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'PYTHONPATH',
  'NODE_PATH',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
])

function runnerSubprocessEnv(inputPath: string, outputPath: string): NodeJS.ProcessEnv {
  const env = {} as NodeJS.ProcessEnv
  for (const key of RUNNER_ENV_ALLOWLIST) {
    const value = process.env[key]
    if (value !== undefined) {
      env[key] = value
    }
  }
  env.ORIZU_RUNNER_INPUT_PATH = inputPath
  env.ORIZU_RUNNER_OUTPUT_PATH = outputPath
  return env
}

function boundedRunnerOutput(value: string | Buffer | null | undefined): string {
  if (!value) return ''
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value)
  if (buffer.byteLength <= RUNNER_OUTPUT_MAX_BYTES) {
    return buffer.toString('utf8')
  }
  return `${buffer.subarray(0, RUNNER_OUTPUT_MAX_BYTES).toString('utf8')}\n[truncated]`
}

async function materializeRunnerVersion(runnerVersionId: string): Promise<{ runnerDir: string; cleanup: () => void }> {
  const response = await authedFetch(`/api/cli/runner-versions/${encodeURIComponent(runnerVersionId)}/download`)
  if (!response.ok) {
    throw new Error(`Failed to download runner version: ${await response.text()}`)
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'orizu-runner-version-'))
  const zipPath = join(tempDir, 'runner.zip')
  const runnerDir = join(tempDir, 'runner')
  const zipBytes = new Uint8Array(await response.arrayBuffer())
  if (zipBytes.byteLength > ARTIFACT_MAX_BYTES) {
    rmSync(tempDir, { recursive: true, force: true })
    throw new Error(`Runner artifact exceeds ${ARTIFACT_MAX_BYTES} bytes`)
  }
  writeFileSync(zipPath, zipBytes)

  const result = spawnSync('unzip', ['-q', zipPath, '-d', runnerDir], {
    encoding: 'utf8',
  })
  if (result.error) {
    rmSync(tempDir, { recursive: true, force: true })
    throw result.error
  }
  if (result.status !== 0) {
    rmSync(tempDir, { recursive: true, force: true })
    throw new Error(`unzip failed: ${sanitizeTerminalText(result.stderr || result.stdout || '')}`)
  }

  return {
    runnerDir,
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  }
}

async function runnersExec() {
  const prompt = getArg('--prompt')
  const promptVersion = getArg('--prompt-version')
  const runnerVersion = getArg('--runner-version')
  const scorerVersion = getArg('--scorer-version')
  const datasetVersion = getArg('--dataset-version')
  const splitSet = getArg('--split-set')
  const split = getArg('--split')
  const runnerDirArg = getArg('--runner-dir')
  const outArg = getArg('--out')

  if (
    (!prompt && !promptVersion && !scorerVersion) ||
    (scorerVersion && (prompt || promptVersion)) ||
    (promptVersion && !runnerVersion) ||
    !datasetVersion ||
    !splitSet ||
    !split ||
    !outArg
  ) {
    throw new Error(
      'Usage: orizu runners exec (--prompt <prompt> | --prompt-version <id> --runner-version <id> | --scorer-version <id>) --dataset-version <id> --split-set <id-or-name> --split <name> [--runner-dir <dir>] --out <results.jsonl|results.jsonl.gz>'
    )
  }

  const query = new URLSearchParams()
  if (scorerVersion) {
    query.set('scorerVersion', scorerVersion)
  } else if (promptVersion) {
    query.set('promptVersion', promptVersion)
  } else if (prompt) {
    query.set('prompt', prompt)
  }
  if (runnerVersion) {
    query.set('runnerVersion', runnerVersion)
  }
  query.set('datasetVersion', datasetVersion)
  query.set('splitSet', splitSet)
  query.set('split', split)
  const contextResponse = await authedFetch(`/api/cli/runners/exec-context?${query.toString()}`)
  if (!contextResponse.ok) {
    throw new Error(`Failed to fetch runner execution context: ${await contextResponse.text()}`)
  }

  const context = await parseJsonResponse<RunnerExecContext>(contextResponse, 'Runner exec context')
  const materializedRunner = runnerDirArg
    ? { runnerDir: expandHomePath(runnerDirArg), cleanup: () => {} }
    : await materializeRunnerVersion(runnerVersion || context.prompt.runnerVersionId)
  const runnerDir = materializedRunner.runnerDir
  const manifest = readRunnerManifest(runnerDir)

  try {
    if (manifest.supports_body_kind && !manifest.supports_body_kind.includes(context.prompt.bodyKind)) {
      throw new Error(
        `Runner does not support prompt body kind '${context.prompt.bodyKind}'. Supported kinds: ${manifest.supports_body_kind.join(', ')}`
      )
    }

    const resultLines: string[] = []
    for (const row of context.rows) {
      const tempDir = mkdtempSync(join(tmpdir(), 'orizu-runner-'))
      const inputPath = join(tempDir, 'input.json')
      const outputPath = join(tempDir, 'output.json')

      try {
        const modelOutput = row.row.model_output ?? row.row.modelOutput ?? row.row.output ?? null
        writeFileSync(inputPath, JSON.stringify({
          row: row.row,
          prompt: {
            body: context.prompt.body,
            body_kind: context.prompt.bodyKind,
            provider_settings: context.prompt.providerSettings,
          },
          subject: scorerVersion
            ? {
                type: 'scorer_row',
                row_id: row.id,
                scorer_version_id: context.scorer?.versionId || scorerVersion,
                prompt_version_id: context.prompt.promptVersionId,
              }
            : {
                type: 'prompt_version',
                row_id: row.id,
                prompt_version_id: context.prompt.promptVersionId,
              },
          scorer: scorerVersion
            ? {
                version_id: context.scorer?.versionId || scorerVersion,
                metric_key: context.scorer?.metricKey || 'score',
                higher_is_better: context.scorer?.higherIsBetter ?? true,
              }
            : null,
          model_output: modelOutput,
          prompt_version_id: context.prompt.promptVersionId,
          runner_version_id: context.prompt.runnerVersionId,
          run_id: null,
        }))

        const result = spawnSync(manifest.command[0], manifest.command.slice(1), {
          cwd: runnerDir,
          env: runnerSubprocessEnv(inputPath, outputPath),
          encoding: 'utf8',
          maxBuffer: RUNNER_OUTPUT_MAX_BYTES,
          timeout: RUNNER_TIMEOUT_MS,
        })

        if (result.error) {
          throw result.error
        }

        if (result.status !== 0) {
          throw new Error(
            `Runner failed for row ${row.id} with exit code ${result.status}: ${sanitizeTerminalText(boundedRunnerOutput(result.stderr || result.stdout))}`
          )
        }

        const runnerOutput = JSON.parse(readFileSync(outputPath, 'utf8')) as Record<string, unknown>
        // Spread runner output first: the scorer/prompt context identity fields
        // (row_id, version ids, metric_key) are authoritative, never runner-overridable.
        resultLines.push(JSON.stringify({
          ...runnerOutput,
          row_id: row.id,
          prompt_version_id: context.prompt.promptVersionId,
          runner_version_id: context.prompt.runnerVersionId,
          ...(scorerVersion
            ? { scorer_version_id: context.scorer?.versionId || scorerVersion, metric_key: context.scorer?.metricKey || 'score' }
            : {}),
        }))
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    }

    const outPath = expandHomePath(outArg)
    const resultJsonl = `${resultLines.join('\n')}${resultLines.length > 0 ? '\n' : ''}`
    if (outPath.endsWith('.gz')) {
      writeFileSync(outPath, gzipSync(Buffer.from(resultJsonl, 'utf8')))
    } else {
      writeFileSync(outPath, resultJsonl)
    }
    if (hasJsonFlag()) {
      printJson({ rowCount: context.rows.length, out: outPath })
    } else {
      printLine(`Wrote ${context.rows.length} runner results to ${sanitizeTerminalText(outPath)}`)
    }
  } finally {
    materializedRunner.cleanup()
  }
}

function isHelpToken(value: string): boolean {
  return value === '--help' || value === '-h'
}

function extractHelpTarget(args: string[]): string[] | null {
  if (args[0] === 'help') {
    return helpTargetFromArgs(args.slice(1))
  }

  if (!args.some(isHelpToken)) {
    return null
  }

  return helpTargetFromArgs(args)
}

function helpTargetFromArgs(args: string[]): string[] {
  const targetArgs = args.filter(arg => !isHelpToken(arg) && arg !== '--json')
  const optionIndex = targetArgs.findIndex(arg => arg.startsWith('-'))
  return optionIndex === -1 ? targetArgs : targetArgs.slice(0, optionIndex)
}

export async function main(rawArgs = process.argv.slice(2)) {
  const parsed = parseGlobalFlags(rawArgs)
  setGlobalFlags(parsed.flags)
  cliArgs = parsed.args

  cliJsonOutput = false
  if (cliArgs[0] === '--json') {
    cliJsonOutput = true
    cliArgs = cliArgs.slice(1)
  }

  const helpTarget = extractHelpTarget(cliArgs)
  if (helpTarget !== null) {
    if (helpTarget.length === 0) {
      printBannerIfInteractive()
    }
    printLine(renderHelpForArgs(helpTarget))
    return
  }

  const command = cliArgs[0]
  const subcommand = cliArgs[1]

  if (command === '--version' || command === '-v') {
    printVersion()
    return
  }

  if (!command) {
    printUsage()
    process.exit(1)
  }

  if (command === 'capabilities') {
    printCapabilities()
    return
  }

  if (command === 'setup' && subcommand === 'prompt') {
    setupPromptCommand()
    return
  }

  if (command === 'setup') {
    await setupCommand()
    return
  }

  if (command === 'install-skill') {
    await installSkillCommand()
    return
  }

  if (command === 'skills' && subcommand === 'install') {
    await installSkillCommand()
    return
  }

  if (command === 'skills' && subcommand === 'path') {
    skillsPathCommand()
    return
  }

  if (command === 'skills' && subcommand === 'status') {
    skillsStatusCommand()
    return
  }

  if (command === 'skills' && subcommand === 'update') {
    await skillsUpdateCommand()
    return
  }

  if (command === 'login') {
    await login()
    return
  }

  if (command === 'logout') {
    await logout()
    return
  }

  if (command === 'whoami') {
    await whoami()
    return
  }

  if (command === 'env') {
    await printEnv()
    return
  }

  if (command === 'log') {
    await logOptimizationEvent()
    return
  }

  if (command === 'comments') {
    await reportCommentsCommand(subcommand, createReportCommentsCliContext())
    return
  }

  if (command === 'teams' && subcommand === 'list') {
    await listTeams()
    return
  }

  if (command === 'teams' && subcommand === 'create') {
    await createTeam()
    return
  }

  const teamsMembersAction = cliArgs[2]
  if (command === 'teams' && subcommand === 'members' && teamsMembersAction === 'list') {
    await listTeamMembers()
    return
  }
  if (command === 'teams' && subcommand === 'members' && teamsMembersAction === 'add') {
    await addTeamMember()
    return
  }
  if (command === 'teams' && subcommand === 'members' && teamsMembersAction === 'remove') {
    await removeTeamMember()
    return
  }
  if (command === 'teams' && subcommand === 'members' && teamsMembersAction === 'role') {
    await changeTeamMemberRole()
    return
  }

  if (command === 'projects' && subcommand === 'list') {
    await listProjects()
    return
  }

  if (command === 'projects' && subcommand === 'create') {
    await createProject()
    return
  }

  if (command === 'prompts' && subcommand === 'list') {
    await listPrompts()
    return
  }

  if (command === 'prompts' && subcommand === 'comments') {
    throwDeprecatedPromptCommentsCommand()
  }

  if (command === 'prompts' && subcommand === 'pull') {
    await pullPromptArtifact('prompt')
    return
  }

  if (command === 'prompts' && subcommand === 'push') {
    await pushPromptArtifact('prompt')
    return
  }

  if (command === 'prompts' && subcommand === 'archive') {
    await setPromptArchivedState(true)
    return
  }

  if (command === 'prompts' && subcommand === 'restore') {
    await setPromptArchivedState(false)
    return
  }

  if (command === 'prompts' && subcommand === 'labels' && cliArgs[2] === 'set') {
    await setPromptLabel()
    return
  }

  if (command === 'prompts' && subcommand === 'scorers' && cliArgs[2] === 'set-headline') {
    await bindPromptScorer('headline')
    return
  }

  if (command === 'prompts' && subcommand === 'scorers' && cliArgs[2] === 'add') {
    await bindPromptScorer('tracked')
    return
  }

  if (command === 'judges' && subcommand === 'list') {
    await listJudges()
    return
  }

  if (command === 'judges' && subcommand === 'pull') {
    await pullPromptArtifact('judge')
    return
  }

  if (command === 'judges' && subcommand === 'push') {
    await pushPromptArtifact('judge')
    return
  }

  if (command === 'scorers' && subcommand === 'list') {
    await listScorers()
    return
  }

  if (command === 'scorers' && subcommand === 'register') {
    await registerScorer()
    return
  }

  if (command === 'scorers' && subcommand === 'detail') {
    await showScorerDetail()
    return
  }

  if (command === 'scorers' && subcommand === 'labels' && cliArgs[2] === 'set') {
    await setScorerLabel()
    return
  }

  if (command === 'scorers' && subcommand === 'exec') {
    await execScorer()
    return
  }

  if ((command === 'runners' || command === 'optimizers') && subcommand === 'push') {
    await pushRunnerArtifact(command === 'runners' ? 'runner' : 'optimizer')
    return
  }

  if ((command === 'runners' || command === 'optimizers') && (subcommand === 'pull' || subcommand === 'list')) {
    await runnerOptimizerCommand(cliArgs, { json: hasJsonFlag(), print: printLine, resolveProjectSlug }); return
  }

  if (command === 'runners' && subcommand === 'exec') {
    await runnersExec()
    return
  }

  if (command === 'runs' && subcommand === 'submit') {
    await submitRunResults()
    return
  }

  if (command === 'scores' && subcommand === 'submit') {
    await submitScoreResults()
    return
  }

  if (command === 'optimizations' && subcommand === 'start') {
    await startOptimizationRun()
    return
  }

  if (command === 'optimizations' && subcommand === 'run-gepa') {
    await runGepaOptimization()
    return
  }

  if (command === 'optimizations' && subcommand === 'export') {
    await exportOptimizationRun()
    return
  }

  if (
    command === 'optimizations' &&
    (
      subcommand === 'pause' ||
      subcommand === 'resume' ||
      subcommand === 'finish' ||
      subcommand === 'fail' ||
      subcommand === 'cancel'
    )
  ) {
    await updateOptimizationRunLifecycle(subcommand)
    return
  }

  if (command === 'apps' && subcommand === 'list') {
    await listApps()
    return
  }

  if (command === 'apps' && subcommand === 'create') {
    await createAppFromFile()
    return
  }

  if (command === 'apps' && subcommand === 'preview') {
    await previewAppFromFile()
    return
  }

  if (command === 'apps' && subcommand === 'update') {
    await updateAppFromFile()
    return
  }

  if (command === 'apps' && subcommand === 'link-dataset') {
    await linkAppDataset()
    return
  }

  if (command === 'apps' && subcommand === 'detail') {
    await appDetail()
    return
  }

  if (command === 'apps' && subcommand === 'export') {
    await exportAppSource()
    return
  }

  if (command === 'tasks' && subcommand === 'list') {
    await listTasks()
    return
  }

  if (command === 'tasks' && subcommand === 'create') {
    await createTask()
    return
  }

  if (command === 'tasks' && subcommand === 'update') {
    await updateTask()
    return
  }

  if (command === 'tasks' && subcommand === 'discard') {
    await discardTask()
    return
  }

  if (command === 'tasks' && subcommand === 'publish') {
    await publishTask()
    return
  }

  if (command === 'tasks' && subcommand === 'assign') {
    await assignTask()
    return
  }

  if (command === 'tasks' && subcommand === 'status') {
    await taskStatus()
    return
  }

  if (
    command === 'tasks' &&
    subcommand === 'report' &&
    (cliArgs[2] === 'set' || cliArgs[2] === 'upload')
  ) {
    await setTaskReport()
    return
  }

  if (command === 'tasks' && subcommand === 'report' && cliArgs[2] === 'get') {
    await getTaskReport()
    return
  }

  if (command === 'tasks' && subcommand === 'pause') { await updateTaskStatus('paused'); return }
  if (command === 'tasks' && subcommand === 'unpause') { await updateTaskStatus('active'); return }
  if (command === 'tasks' && subcommand === 'complete') { await updateTaskStatus('completed'); return }

  if (command === 'datasets' && subcommand === 'upload') {
    await uploadDataset()
    return
  }

  if (command === 'datasets' && subcommand === 'push') {
    await pushDataset()
    return
  }

  if (command === 'datasets' && subcommand === 'download') {
    await downloadDataset()
    return
  }
  if (command === 'datasets' && subcommand === 'append') {
    await appendDatasetRows()
    return
  }
  const datasetsAction = cliArgs[2]
  if (command === 'datasets' && subcommand === 'readme' && datasetsAction === 'set') {
    await setDatasetReadme()
    return
  }
  if (command === 'datasets' && subcommand === 'versions' && datasetsAction === 'create') {
    await createDatasetVersion()
    return
  }
  if (command === 'datasets' && subcommand === 'splits' && datasetsAction === 'create') {
    await createDatasetSplitSet()
    return
  }
  if (command === 'datasets' && subcommand === 'edit-rows') {
    await editDatasetRows()
    return
  }
  if (command === 'datasets' && subcommand === 'delete-rows') {
    await deleteDatasetRows()
    return
  }
  if (command === 'datasets' && subcommand === 'delete') {
    await deleteDataset()
    return
  }
  if (command === 'datasets' && subcommand === 'lock') { await lockDataset(); return }
  if (command === 'datasets' && subcommand === 'clone') { await cloneDataset(); return }
  if (command === 'tasks' && subcommand === 'export') { await downloadAnnotations(); return }
  if (command === 'internal' || (command === 'session' && subcommand === 'start' && hasArg('--hosted'))) { process.exitCode = await hostedCommand(cliArgs, { json: hasJsonFlag(), print: printLine, printErr: printError }); return }
  if (command === 'session' || command === 'run') {
    process.exitCode = await workbenchCommand(cliArgs, { json: hasJsonFlag(), print: printLine })
    return
  }
  if (command === 'workspace') {
    process.exitCode = await workspaceSyncCommand(cliArgs.slice(1), { json: hasJsonFlag(), print: printLine })
    return
  }
  if (command === 'git-credential') { process.exitCode = await runGitCredential(subcommand ?? 'get', { stdin: readFileSync(0, 'utf8'), cwd: process.cwd(), print: printLine, printErr: printError }); return }
  if (command === 'github' && subcommand === 'link') { const noInput = hasArg('--no-input') || hasArg('--non-interactive') || !isInteractiveTerminal(); const team = getOptionalArgValue('--team') || (await resolveSetupTeam(null, noInput, false)).slug; await runGithubLink(team, { print: printLine, fetcher: authedFetch, openUrl: openInBrowser, confirm: (org) => askYesNo(`Connect this team to GitHub org '${org}'?`, true) }); return }
  if (command === 'connectors' || command === 'manifests') {
    const moduleCommand = command === 'connectors' ? connectorsCommand : manifestsCommand
    process.exitCode = await moduleCommand(cliArgs.slice(1), { json: hasJsonFlag(), print: printLine, resolveProjectSlug })
    return
  }
  if (command === 'team' && (subcommand === 'kill-agents' || subcommand === 'release-agents')) {
    process.exitCode = await killSwitchCommand(cliArgs.slice(1), { json: hasJsonFlag(), print: printLine, printErr: printError })
    return
  }
  if (command === 'team' && subcommand === 'egress-allowlist') {
    process.exitCode = await egressAllowlistCommand(cliArgs.slice(1), { json: hasJsonFlag(), print: printLine, printErr: printError })
    return
  }

  printUsage()
  process.exit(1)
}

function isCliEntrypoint(): boolean {
  const entry = process.argv[1]
  if (!entry) {
    return false
  }

  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isCliEntrypoint()) {
  main().catch(error => {
    printError(error instanceof Error ? error.message : 'Unknown error')
    process.exit(1)
  })
}
