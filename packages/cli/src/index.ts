#!/usr/bin/env node
import { createHash, randomBytes } from 'crypto'
import { basename, extname } from 'path'
import { createServer } from 'http'
import { readFileSync, statSync, writeFileSync } from 'fs'
import { spawn } from 'child_process'
import { createInterface } from 'readline/promises'
import { stdin as input, stdout as output } from 'process'
import { clearServerCredentials, getServerCredentials, saveServerCredentials } from './credentials.js'
import { parseDatasetFile } from './file-parser.js'
import { streamJsonlRowChunks } from './jsonl-stream.js'
import { parseDatasetReference } from './dataset-download.js'
import { parseGlobalFlags } from './global-flags.js'
import { authedFetch, getBaseUrl, resolveLoginBaseUrl, setGlobalFlags } from './http.js'
import { formatTaskCreateError } from './task-create-error.js'
import { LoginResponse } from './types.js'

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

type DatasetUploadSourceType = 'csv' | 'json' | 'jsonl'

interface DatasetUploadResponse {
  dataset: {
    id: string
    name: string
    rowCount: number
    sourceType: string
    url?: string
  }
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

function printUsage() {
  console.log(`orizu global options:\n\n  --local                 Use http://localhost:3000\n  --server <url>          Use a specific server origin (for example: https://preview.example.com)\n\norizu commands:\n\n  orizu login\n  orizu logout\n  orizu whoami\n  orizu teams list\n  orizu teams create [--name <name>]\n  orizu teams members list [--team <teamSlug>]\n  orizu teams members add --email <email> [--team <teamSlug>]\n  orizu teams members remove --email <email> [--team <teamSlug>]\n  orizu teams members role --team <teamSlug> --email <email> --role <admin|member>\n  orizu projects list [--team <teamSlug>]\n  orizu projects create --name <name> [--team <teamSlug>]\n  orizu apps list [--project <team/project>]\n  orizu apps create --project <team/project> --name <name> --dataset <datasetId> --file <path> --input-schema <json-path> --output-schema <json-path> [--component <name>]\n  orizu apps update [--app <appId>] [--project <team/project>] --file <path> --input-schema <json-path> --output-schema <json-path> [--component <name>]\n  orizu apps link-dataset --dataset <datasetId> [--app <appId>] [--project <team/project>] [--version <n>]\n  orizu apps detail --app <appId> [--project <team/project>] [--json]\n  orizu tasks list [--project <team/project>]\n  orizu tasks create --project <team/project> --dataset <datasetId> --app <appId> --title <title> --assignees <userIdOrEmail1,userIdOrEmail2> [--version <n>] [--instructions <text>] [--labels-per-item <n>] [--json]\n  orizu tasks assign --task <taskId> --assignees <userId1,userId2>\n  orizu tasks status --task <taskId> [--json]\n  orizu tasks pause --task <taskId>\n  orizu tasks unpause --task <taskId>\n  orizu datasets upload --file <path> [--project <team/project>] [--name <name>]\n  orizu datasets download [--dataset <datasetId|datasetUrl>] [--project <team/project>] [--format <csv|json|jsonl>] [--out <path>]\n  orizu datasets append [--dataset <datasetId|datasetUrl>] [--project <team/project>] --file <path>\n  orizu datasets edit-rows [--dataset <datasetId|datasetUrl>] [--project <team/project>] --file <path>\n  orizu datasets delete-rows [--dataset <datasetId|datasetUrl>] [--project <team/project>] --row-ids <id1,id2>\n  orizu datasets lock [--dataset <datasetId|datasetUrl>] [--project <team/project>] [--reason <text>]\n  orizu datasets clone [--dataset <datasetId|datasetUrl>] [--project <team/project>] [--name <name>]\n  orizu tasks export [--task <taskId>] [--format <csv|json|jsonl>] [--out <path>]`)
}

let cliArgs = process.argv.slice(2)

function getArg(name: string): string | null {
  const index = cliArgs.indexOf(name)
  if (index === -1 || index + 1 >= cliArgs.length) {
    return null
  }

  return cliArgs[index + 1]
}

function normalizeSlugInput(slug: string): string {
  return slug.trim().toLowerCase()
}

function isInteractiveTerminal() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

function hasArg(name: string): boolean {
  return cliArgs.includes(name)
}

function expandHomePath(path: string): string {
  if (path.startsWith('~/')) {
    const home = process.env.HOME || ''
    return `${home}/${path.slice(2)}`
  }

  return path
}

function createCodeVerifier(): string {
  return randomBytes(32).toString('base64url')
}

function createCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

function openInBrowser(url: string) {
  const platform = process.platform
  if (platform === 'darwin') {
    spawn('open', [url], {
      detached: true,
      stdio: 'ignore',
    }).unref()
    return
  }

  if (platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref()
    return
  }

  spawn('xdg-open', [url], {
    detached: true,
    stdio: 'ignore',
  }).unref()
}

function formatTerminalLink(url: string): string {
  if (!isInteractiveTerminal()) {
    return url
  }

  return `\u001B]8;;${url}\u0007${url}\u001B]8;;\u0007`
}

async function parseJsonResponse<T>(response: Response, context: string): Promise<T> {
  const contentType = response.headers.get('content-type') || ''
  const rawBody = await response.text()

  if (!contentType.includes('application/json')) {
    throw new Error(
      `${context} returned non-JSON response (status ${response.status}). ` +
      `Body preview: ${rawBody.slice(0, 180)}`
    )
  }

  try {
    return JSON.parse(rawBody) as T
  } catch {
    throw new Error(
      `${context} returned invalid JSON (status ${response.status}). ` +
      `Body preview: ${rawBody.slice(0, 180)}`
    )
  }
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

  console.log(`\n${title}`)
  items.forEach((item, index) => {
    console.log(`  ${index + 1}. ${label(item, index)}`)
  })

  const rl = createInterface({ input, output })
  try {
    while (true) {
      const answer = (await rl.question('Choose a number: ')).trim()
      const chosenIndex = Number(answer)
      if (Number.isInteger(chosenIndex) && chosenIndex >= 1 && chosenIndex <= items.length) {
        return items[chosenIndex - 1]
      }

      console.log('Invalid selection. Enter a valid number from the list.')
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

async function resolveProjectSlug(projectArg: string | null): Promise<string> {
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

    return `${project.teamSlug}/${project.slug}`
  }

  const segments = projectArg.split('/')
  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    throw new Error('Project must be in format teamSlug/projectSlug')
  }
  const [teamSlug, projectSlug] = segments.map(normalizeSlugInput)

  const matchedTeam = teams.find(team => team.slug === teamSlug)
  if (!matchedTeam) {
    console.error(`Team '${teamSlug}' not found in your accessible teams.`)
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

    return `${selectedProject.teamSlug}/${selectedProject.slug}`
  }

  const projects = await fetchProjects(matchedTeam.slug)
  const matchedProject = projects.find(project => project.slug === projectSlug)

  if (!matchedProject) {
    console.error(`Project '${projectSlug}' not found in team '${matchedTeam.slug}'.`)
    const selectedProject = await promptSelect(
      `Select a project in ${matchedTeam.slug}`,
      projects,
      project => `${project.name} (${project.teamSlug}/${project.slug})`
    )

    return `${selectedProject.teamSlug}/${selectedProject.slug}`
  }

  return `${matchedTeam.slug}/${matchedProject.slug}`
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

async function selectDatasetInteractively(projectArg: string | null): Promise<{ datasetId: string; project: string }> {
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
  }
}

function printTeams(teams: Team[]) {
  if (teams.length === 0) {
    console.log('No teams found.')
    return
  }

  const rows = teams.map(team => ({
    slug: team.slug,
    name: team.name || '-',
    role: team.role || '-',
  }))

  const slugWidth = Math.max('TEAM SLUG'.length, ...rows.map(row => row.slug.length))
  const nameWidth = Math.max('TEAM NAME'.length, ...rows.map(row => row.name.length))
  const roleWidth = Math.max('ROLE'.length, ...rows.map(row => row.role.length))

  console.log(
    `${'TEAM SLUG'.padEnd(slugWidth)}  ${'TEAM NAME'.padEnd(nameWidth)}  ${'ROLE'.padEnd(roleWidth)}`
  )
  console.log(
    `${'-'.repeat(slugWidth)}  ${'-'.repeat(nameWidth)}  ${'-'.repeat(roleWidth)}`
  )

  rows.forEach(row => {
    console.log(`${row.slug.padEnd(slugWidth)}  ${row.name.padEnd(nameWidth)}  ${row.role.padEnd(roleWidth)}`)
  })
}

function printProjects(projects: Project[]) {
  if (projects.length === 0) {
    console.log('No projects found.')
    return
  }

  const rows = projects.map(project => ({
    project: `${project.teamSlug}/${project.slug}`,
    name: project.name || '-',
    role: project.role || '-',
  }))

  const projectWidth = Math.max('TEAM/PROJECT'.length, ...rows.map(row => row.project.length))
  const nameWidth = Math.max('PROJECT NAME'.length, ...rows.map(row => row.name.length))
  const roleWidth = Math.max('ROLE'.length, ...rows.map(row => row.role.length))

  console.log(
    `${'TEAM/PROJECT'.padEnd(projectWidth)}  ${'PROJECT NAME'.padEnd(nameWidth)}  ${'ROLE'.padEnd(roleWidth)}`
  )
  console.log(
    `${'-'.repeat(projectWidth)}  ${'-'.repeat(nameWidth)}  ${'-'.repeat(roleWidth)}`
  )

  rows.forEach(row => {
    console.log(
      `${row.project.padEnd(projectWidth)}  ${row.name.padEnd(nameWidth)}  ${row.role.padEnd(roleWidth)}`
    )
  })
}

function printTasks(tasks: Task[]) {
  if (tasks.length === 0) {
    console.log('No tasks found.')
    return
  }

  const rows = tasks.map(task => ({
    id: task.id,
    name: task.title || '-',
    status: task.status || '-',
    project: task.teamSlug && task.projectSlug
      ? `${task.teamSlug}/${task.projectSlug}`
      : 'unknown-project',
  }))

  const idWidth = Math.max('TASK ID'.length, ...rows.map(row => row.id.length))
  const nameWidth = Math.max('TASK NAME'.length, ...rows.map(row => row.name.length))
  const statusWidth = Math.max('STATUS'.length, ...rows.map(row => row.status.length))

  console.log(
    `${'TASK ID'.padEnd(idWidth)}  ${'TASK NAME'.padEnd(nameWidth)}  ${'STATUS'.padEnd(statusWidth)}  TEAM/PROJECT`
  )
  console.log(
    `${'-'.repeat(idWidth)}  ${'-'.repeat(nameWidth)}  ${'-'.repeat(statusWidth)}  ------------`
  )

  rows.forEach(row => {
    console.log(
      `${row.id.padEnd(idWidth)}  ${row.name.padEnd(nameWidth)}  ${row.status.padEnd(statusWidth)}  ${row.project}`
    )
  })
}

function printApps(apps: AppSummary[]) {
  if (apps.length === 0) {
    console.log('No apps found.')
    return
  }

  const rows = apps.map(app => ({
    id: app.id,
    name: app.name || '-',
    version: `v${app.currentVersionNum || 1}`,
  }))

  const idWidth = Math.max('APP ID'.length, ...rows.map(row => row.id.length))
  const nameWidth = Math.max('APP NAME'.length, ...rows.map(row => row.name.length))
  const versionWidth = Math.max('VERSION'.length, ...rows.map(row => row.version.length))

  console.log(`${'APP ID'.padEnd(idWidth)}  ${'APP NAME'.padEnd(nameWidth)}  ${'VERSION'.padEnd(versionWidth)}`)
  console.log(`${'-'.repeat(idWidth)}  ${'-'.repeat(nameWidth)}  ${'-'.repeat(versionWidth)}`)

  rows.forEach(row => {
    console.log(`${row.id.padEnd(idWidth)}  ${row.name.padEnd(nameWidth)}  ${row.version.padEnd(versionWidth)}`)
  })
}

function printTeamMembers(members: TeamMember[]) {
  if (members.length === 0) {
    console.log('No team members found.')
    return
  }

  const rows = members.map(member => ({
    id: member.id,
    userId: member.user_id || '-',
    email: member.email || '-',
    role: member.role || '-',
  }))

  const idWidth = Math.max('MEMBER ID'.length, ...rows.map(row => row.id.length))
  const userIdWidth = Math.max('USER ID'.length, ...rows.map(row => row.userId.length))
  const emailWidth = Math.max('EMAIL'.length, ...rows.map(row => row.email.length))
  const roleWidth = Math.max('ROLE'.length, ...rows.map(row => row.role.length))

  console.log(
    `${'MEMBER ID'.padEnd(idWidth)}  ${'USER ID'.padEnd(userIdWidth)}  ${'EMAIL'.padEnd(emailWidth)}  ${'ROLE'.padEnd(roleWidth)}`
  )
  console.log(
    `${'-'.repeat(idWidth)}  ${'-'.repeat(userIdWidth)}  ${'-'.repeat(emailWidth)}  ${'-'.repeat(roleWidth)}`
  )
  rows.forEach(row => {
    console.log(
      `${row.id.padEnd(idWidth)}  ${row.userId.padEnd(userIdWidth)}  ${row.email.padEnd(emailWidth)}  ${row.role.padEnd(roleWidth)}`
    )
  })
}

function printTaskStatusSummary(data: TaskStatusPayload) {
  const task = data.task
  console.log(`Task: ${task.title} (${task.id})`)
  console.log(`Status: ${task.status}`)
  console.log(`Project: ${task.teamSlug}/${task.projectSlug}`)
  console.log(`Progress: ${task.progressPercentage}%`)
  console.log(`Counts: completed=${task.counts.completed}, in_progress=${task.counts.inProgress}, pending=${task.counts.pending}, skipped=${task.counts.skipped}`)
  console.log(`Required assignments: ${task.totalRequiredAssignments} (${task.datasetRowCount} rows x ${task.requiredAssignmentsPerRow})`)

  if (task.assignees.length > 0) {
    console.log('\nAssignees')
    task.assignees.forEach(assignee => {
      console.log(
        `  ${assignee.email}: total=${assignee.total}, completed=${assignee.completed}, in_progress=${assignee.inProgress}, pending=${assignee.pending}, skipped=${assignee.skipped}`
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
  const baseUrl = resolveLoginBaseUrl()
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
        console.log(`Opening browser for login: ${authorizeUrl}`)
        openInBrowser(authorizeUrl)
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
  saveServerCredentials(baseUrl, {
    accessToken: loginData.accessToken,
    refreshToken: loginData.refreshToken,
    expiresAt: loginData.expiresAt,
  })

  console.log(`Logged in as ${loginData.user.email ?? loginData.user.id}`)
}

async function whoami() {
  const response = await authedFetch('/api/cli/auth/whoami')
  if (!response.ok) {
    throw new Error(`whoami failed: ${await response.text()}`)
  }

  const data = await response.json() as { user: { id: string; email: string | null } }
  console.log(data.user.email ?? data.user.id)
}

async function logout() {
  const baseUrl = getBaseUrl()
  const credentials = getServerCredentials(baseUrl)
  if (!credentials) {
    console.log(`Already logged out for ${baseUrl}.`)
    return
  }

  await fetch(`${baseUrl}/api/cli/auth/logout`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${credentials.accessToken}`,
    },
    body: JSON.stringify({ refreshToken: credentials.refreshToken }),
  }).catch(() => undefined)

  clearServerCredentials(baseUrl)
  console.log(`Logged out from ${baseUrl}.`)
}

async function listTeams() {
  printTeams(await fetchTeams())
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

  const response = await authedFetch('/api/cli/teams', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })

  if (!response.ok) {
    throw new Error(`Failed to create team: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{ team: Team }>(response, 'Team create')
  console.log(`Created team: ${data.team.name} (${data.team.slug})`)
}

async function listProjects() {
  const teamSlugArg = getArg('--team')
  const teamSlug = teamSlugArg ? normalizeSlugInput(teamSlugArg) : null
  printProjects(await fetchProjects(teamSlug || undefined))
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

  const response = await authedFetch('/api/cli/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamSlug, name }),
  })

  if (!response.ok) {
    throw new Error(`Failed to create project: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{
    project: { id: string; name: string; slug: string; teamSlug: string }
  }>(response, 'Project create')
  console.log(`Created project ${data.project.teamSlug}/${data.project.slug}`)
}

async function listTasks() {
  const project = getArg('--project')
  printTasks(await fetchTasks(project || undefined))
}

async function listApps() {
  const project = getArg('--project') || await resolveProjectSlug(null)
  printApps(await fetchApps(project))
}

function readSourceFile(pathArg: string): string {
  const expandedPath = expandHomePath(pathArg)
  try {
    return readFileSync(expandedPath, 'utf-8')
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      throw new Error(`File not found: ${expandedPath}`)
    }
    throw new Error(`Failed to read file '${expandedPath}': ${error?.message || String(error)}`)
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
  } catch (error: any) {
    throw new Error(`Invalid JSON file '${pathArg}': ${error?.message || String(error)}`)
  }
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
    app: { id: string; name: string; versionNum: number; componentName?: string }
    warnings?: string[]
  }>(response, 'App create')
  console.log(`Created app ${data.app.name} (${data.app.id}) v${data.app.versionNum}`)
  if (data.warnings?.length) {
    console.log(`Warnings: ${data.warnings.join('; ')}`)
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
  console.log(`Updated app ${data.app.name} (${data.app.id}) to v${data.app.versionNum}`)
  if (data.warnings?.length) {
    console.log(`Warnings: ${data.warnings.join('; ')}`)
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

  console.log(
    `Linked dataset ${data.linkedDataset.name} (${data.linkedDataset.id}) to app ${data.app.name} (${data.app.id}) version ${data.versionNum}`
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

async function createTask() {
  const projectSlug = getArg('--project')
  const datasetId = getArg('--dataset')
  const appId = getArg('--app')
  const title = getArg('--title')
  const assignees = parseCommaSeparated(getArg('--assignees'))
  const versionArg = getArg('--version')
  const instructions = getArg('--instructions')
  const labelsPerItemArg = getArg('--labels-per-item')
  const labelsPerItem = labelsPerItemArg ? Number(labelsPerItemArg) : 1
  const parsedVersionNum = versionArg ? Number(versionArg) : Number.NaN
  const versionNum =
    Number.isInteger(parsedVersionNum) && parsedVersionNum > 0 ? parsedVersionNum : null

  if (!projectSlug || !datasetId || !appId || !title || assignees.length === 0) {
    throw new Error('Usage: orizu tasks create --project <team/project> --dataset <datasetId> --app <appId> --title <title> --assignees <userIdOrEmail1,userIdOrEmail2> [--version <n>] [--instructions <text>] [--labels-per-item <n>] [--json]')
  }

  if (versionArg && versionNum === null) {
    throw new Error('--version must be a positive integer')
  }

  const response = await authedFetch('/api/cli/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectSlug,
      datasetId,
      appId,
      versionNum,
      title,
      memberIds: assignees,
      instructions,
      requiredAssignmentsPerRow: labelsPerItem,
    }),
  })

  if (!response.ok) {
    const cliError = await formatTaskCreateError(response)
    if (hasArg('--json')) {
      const payload = cliError.structuredPayload ?? { error: cliError.message }
      console.log(JSON.stringify({
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

  if (hasArg('--json')) {
    console.log(JSON.stringify({
      taskId: data.task.id,
      datasetId,
      versionId: data.task.versionId,
      versionNum: data.task.versionNum,
      taskUrl: `${getBaseUrl()}/d/${projectSlug}/tasks/${data.task.id}`,
      title: data.task.title,
      status: data.task.status,
      requiredAssignmentsPerRow: data.task.requiredAssignmentsPerRow,
      assignmentsCreated: data.assignmentsCreated,
      ...(data.assignmentShortfall !== undefined ? { assignmentShortfall: data.assignmentShortfall } : {}),
      ...(data.warning ? { warning: data.warning } : {}),
    }, null, 2))
    return
  }

  const baseUrl = getBaseUrl()
  const taskUrl = `${baseUrl}/d/${projectSlug}/tasks/${data.task.id}`
  console.log(
    `Created task ${data.task.title} (${data.task.id}) [${data.task.status}]` +
    `\n  Task ID:    ${data.task.id}` +
    `\n  Dataset ID: ${datasetId}` +
    `\n  Version:    v${data.task.versionNum} (${data.task.versionId})` +
    `\n  Labels/row: ${data.task.requiredAssignmentsPerRow}` +
    `\n  Assignments: ${data.assignmentsCreated}` +
    (data.warning ? `\n  Warning:    ${data.warning}` : '') +
    `\n  URL:        ${taskUrl}`
  )
}

async function assignTask() {
  const taskId = getArg('--task')
  const assignees = parseCommaSeparated(getArg('--assignees'))

  if (!taskId || assignees.length === 0) {
    throw new Error('Usage: orizu tasks assign --task <taskId> --assignees <userId1,userId2>')
  }

  const response = await authedFetch(`/api/cli/tasks/${encodeURIComponent(taskId)}/assign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberIds: assignees }),
  })

  if (!response.ok) {
    throw new Error(`Failed to assign task: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{ assignmentsCreated: number }>(response, 'Task assign')
  console.log(`Created ${data.assignmentsCreated} assignments.`)
}

async function taskStatus() {
  const taskId = getArg('--task')
  if (!taskId) {
    throw new Error('Usage: orizu tasks status --task <taskId> [--json]')
  }

  const response = await authedFetch(`/api/cli/tasks/${encodeURIComponent(taskId)}/status`)
  if (!response.ok) {
    const rawBody = await response.text()
    if (hasArg('--json')) {
      let errorPayload: Record<string, unknown> = { error: rawBody }
      try {
        const parsed = JSON.parse(rawBody)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          errorPayload = parsed as Record<string, unknown>
        }
      } catch {
        // keep raw body as error
      }
      console.log(JSON.stringify({
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
  if (hasArg('--json')) {
    console.log(JSON.stringify(data, null, 2))
    return
  }

  printTaskStatusSummary(data)
}

async function updateTaskStatus(targetStatus: 'paused' | 'active') {
  const taskId = getArg('--task')
  if (!taskId) {
    const verb = targetStatus === 'paused' ? 'pause' : 'unpause'
    throw new Error(`Usage: orizu tasks ${verb} --task <taskId>`)
  }

  const response = await authedFetch(`/api/cli/tasks/${encodeURIComponent(taskId)}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: targetStatus }),
  })

  if (!response.ok) {
    const verb = targetStatus === 'paused' ? 'pause' : 'unpause'
    throw new Error(`Failed to ${verb} task: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{ task: { id: string; status: string } }>(response, 'Task status update')
  const action = targetStatus === 'paused' ? 'Paused' : 'Unpaused'
  console.log(`${action} task ${data.task.id} [${data.task.status}]`)
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

  if (hasArg('--json')) {
    console.log(JSON.stringify(detail, null, 2))
    return
  }

  console.log(`App: ${detail.name} (${detail.id})`)
  console.log(`  Project: ${detail.teamSlug}/${detail.projectSlug}`)
  if (detail.currentVersion) {
    console.log(`  Current version: v${detail.currentVersion.versionNum} (${detail.currentVersion.versionId})`)
    console.log(`  Input schema: ${detail.currentVersion.inputJsonSchema ? 'defined' : 'none'}`)
    console.log(`  Output schema: ${detail.currentVersion.outputJsonSchema ? 'defined' : 'none'}`)
  } else {
    console.log(`  Current version: none`)
  }
  console.log(`  Compatible datasets: ${detail.compatibleDatasetsCount}/${detail.totalDatasetsCount}`)
  if (detail.createdByEmail) {
    console.log(`  Created by: ${detail.createdByName || detail.createdByEmail}`)
  }
  console.log(`  Created: ${detail.createdAt}`)
  console.log(`  Updated: ${detail.updatedAt}`)
}

async function listTeamMembers() {
  const teamSlug = await resolveTeamSlug(getArg('--team'))

  printTeamMembers(await fetchTeamMembers(teamSlug))
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
  console.log(`Added team member ${data.member.email} (${data.member.id})`)
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
  console.log(`Removed team member ${member.email}`)
}

async function changeTeamMemberRole() {
  const teamSlugArg = getArg('--team')
  const teamSlug = teamSlugArg ? normalizeSlugInput(teamSlugArg) : null
  const email = getArg('--email')
  const role = getArg('--role')
  if (!teamSlug || !email || !role) {
    throw new Error('Usage: orizu teams members role --team <teamSlug> --email <email> --role <admin|member>')
  }
  if (!['admin', 'member'].includes(role)) {
    throw new Error('role must be one of: admin, member')
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

  console.log(`Updated ${member.email} role to ${role}`)
}

async function createDatasetFromRows(
  project: string,
  name: string,
  sourceType: DatasetUploadSourceType,
  rows: Array<Record<string, unknown>>
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
  datasetName: string
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
        `Dataset ${dataset.name} (${dataset.id}) was created and ${totalUploaded} rows were uploaded. ` +
        `Fix the file, remove the first ${totalUploaded} rows, and run ` +
        `orizu datasets append --dataset ${dataset.id} --file <remaining-file>.`
      )
    }

    if (nextChunk.done) {
      break
    }

    const chunk = nextChunk.value
    chunkIndex += 1
    console.log(`Uploading chunk ${chunkIndex} (${chunk.length} rows)...`)

    try {
      if (!dataset) {
        const data = await createDatasetFromRows(project, datasetName, 'jsonl', chunk)
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

  console.log(`Uploaded dataset ${dataset.name} (${dataset.id}) with ${dataset.rowCount} rows.`)
  if (dataset.url) {
    console.log(`View dataset: ${formatTerminalLink(dataset.url)}`)
  }
}

async function uploadDataset() {
  const projectArg = getArg('--project')
  const fileArg = getArg('--file')
  const name = getArg('--name')

  if (!fileArg) {
    throw new Error('Usage: orizu datasets upload --file <path> [--project <team/project>] [--name <name>]')
  }

  const file = expandHomePath(fileArg)
  const project = await resolveProjectSlug(projectArg)
  const datasetName = name || basename(file)

  if (extname(file).toLowerCase() === '.jsonl') {
    await uploadJsonlDatasetInChunks(file, project, datasetName)
    return
  }

  const { rows, sourceType } = parseDatasetFile(file)
  const data = await createDatasetFromRows(project, datasetName, sourceType, rows)

  console.log(`Uploaded dataset ${data.dataset.name} (${data.dataset.id}) with ${data.dataset.rowCount} rows.`)
  if (data.dataset.url) {
    console.log(`View dataset: ${formatTerminalLink(data.dataset.url)}`)
  }
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

  console.log(`Saved dataset ${datasetId} (${format.toUpperCase()}) to ${filename}`)
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
    console.log(`Uploading chunk ${chunkIndex} (${chunk.length} rows)...`)

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

  console.log(
    `Appended ${totalAppended} rows to dataset ${lastResult.dataset.name} (${lastResult.dataset.id}). New row count: ${lastResult.dataset.rowCount}`
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
    console.log(
      `Appended ${data.appendedCount} rows to dataset ${data.dataset.name} (${data.dataset.id}). New row count: ${data.dataset.rowCount}`
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

    console.log(`Uploading chunk ${chunkIndex}/${totalChunks} (${chunk.length} rows)...`)
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
    console.log(
      `Appended ${totalAppended} rows to dataset ${lastResult.dataset.name} (${lastResult.dataset.id}). New row count: ${lastResult.dataset.rowCount}`
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

  console.log(
    `Updated ${data.updatedCount} rows in dataset ${data.dataset.name} (${data.dataset.id}). Current row count: ${data.dataset.rowCount}`
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

  console.log(
    `Deleted ${data.deletedCount} rows from dataset ${data.dataset.name} (${data.dataset.id}). New row count: ${data.dataset.rowCount}`
  )
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

  console.log(
    `Locked dataset ${data.dataset.name} (${data.dataset.id}) at ${data.dataset.lockedAt}. Row count: ${data.dataset.rowCount}`
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

  console.log(
    `Cloned dataset ${data.dataset.parentDatasetId} -> ${data.dataset.name} (${data.dataset.id}). Row count: ${data.dataset.rowCount}`
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

  console.log(`Saved ${format.toUpperCase()} export to ${filename}`)
}

async function main() {
  const parsed = parseGlobalFlags(process.argv.slice(2))
  setGlobalFlags(parsed.flags)
  cliArgs = parsed.args

  const command = cliArgs[0]
  const subcommand = cliArgs[1]

  if (!command) {
    printUsage()
    process.exit(1)
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

  if (command === 'apps' && subcommand === 'list') {
    await listApps()
    return
  }

  if (command === 'apps' && subcommand === 'create') {
    await createAppFromFile()
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

  if (command === 'tasks' && subcommand === 'list') {
    await listTasks()
    return
  }

  if (command === 'tasks' && subcommand === 'create') {
    await createTask()
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

  if (command === 'tasks' && subcommand === 'pause') {
    await updateTaskStatus('paused')
    return
  }

  if (command === 'tasks' && subcommand === 'unpause') {
    await updateTaskStatus('active')
    return
  }

  if (command === 'datasets' && subcommand === 'upload') {
    await uploadDataset()
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

  if (command === 'datasets' && subcommand === 'edit-rows') {
    await editDatasetRows()
    return
  }

  if (command === 'datasets' && subcommand === 'delete-rows') {
    await deleteDatasetRows()
    return
  }

  if (command === 'datasets' && subcommand === 'lock') {
    await lockDataset()
    return
  }

  if (command === 'datasets' && subcommand === 'clone') {
    await cloneDataset()
    return
  }

  if (command === 'tasks' && subcommand === 'export') {
    await downloadAnnotations()
    return
  }

  printUsage()
  process.exit(1)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Unknown error')
  process.exit(1)
})
