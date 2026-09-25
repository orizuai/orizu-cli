// ORI-2044: moved from index.ts to keep account directory together.
import { stdin as input, stdout as output } from 'process'
import { createInterface } from 'readline/promises'

import { isInteractiveTerminal, normalizeSlugInput, hasJsonFlag, getArg } from './command-line-arguments.js'
import { printLine, printError, printJson } from './cli-console-output.js'
import { sanitizeTerminalText, parseJsonResponse } from './json-response.js'
import { type AuthenticatedRequestContext, authedFetch } from './http.js'

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
  archiveStatus?: string
  archivedAt?: string | null
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
  status?: string
  archivedAt?: string | null
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
  status?: string
  archivedAt?: string | null
}

interface DatasetSelection {
  datasetId: string
  project?: string
  name?: string
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

type AuthenticatedRequest = AuthenticatedRequestContext['fetch']
async function fetchTeams(request: AuthenticatedRequest = authedFetch): Promise<Team[]> {
  const response = await request('/api/cli/teams')
  if (!response.ok) {
    throw new Error(`Failed to fetch teams: ${await response.text()}`)
  }
  const data = await parseJsonResponse<{ teams: Team[] }>(response, 'Teams list')
  return data.teams
}

async function fetchProjects(
  teamSlug?: string,
  request: AuthenticatedRequest = authedFetch
): Promise<Project[]> {
  const normalizedTeamSlug = teamSlug ? normalizeSlugInput(teamSlug) : undefined
  const query = normalizedTeamSlug ? `?teamSlug=${encodeURIComponent(normalizedTeamSlug)}` : ''
  const response = await request(`/api/cli/projects${query}`)
  if (!response.ok) {
    throw new Error(`Failed to fetch projects: ${await response.text()}`)
  }
  const data = await parseJsonResponse<{ projects: Project[] }>(response, 'Projects list')
  return data.projects
}

async function fetchTasks(project?: string, status = 'active'): Promise<Task[]> {
  const params = new URLSearchParams()
  if (project) params.set('project', project)
  if (status !== 'active') params.set('status', status)
  const query = params.size > 0 ? `?${params.toString()}` : ''
  const response = await authedFetch(`/api/cli/tasks${query}`)
  if (!response.ok) {
    throw new Error(`Failed to fetch tasks: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{ tasks: Task[] }>(response, 'Tasks list')
  return data.tasks
}

async function fetchApps(project: string, status = 'active'): Promise<AppSummary[]> {
  const params = new URLSearchParams({ project })
  if (status !== 'active') params.set('status', status)
  const response = await authedFetch(`/api/cli/apps?${params.toString()}`)
  if (!response.ok) {
    throw new Error(`Failed to fetch apps: ${await response.text()}`)
  }

  const data = await parseJsonResponse<{ apps: AppSummary[] }>(response, 'Apps list')
  return data.apps
}

async function fetchDatasets(project: string, status = 'active'): Promise<DatasetSummary[]> {
  const params = new URLSearchParams({ project })
  if (status !== 'active') params.set('status', status)
  const response = await authedFetch(`/api/cli/datasets?${params.toString()}`)
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

async function createTeamOnServer(
  name: string,
  request: AuthenticatedRequest = authedFetch
): Promise<Team> {
  const response = await request('/api/cli/teams', {
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

async function createProjectOnServer(
  teamSlug: string,
  name: string,
  request: AuthenticatedRequest = authedFetch
): Promise<Project> {
  const response = await request('/api/cli/projects', {
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

export {
  resolveProjectSlug,
  fetchDatasets,
  fetchTasks,
  fetchApps,
  createTeamOnServer,
  fetchTeams,
  fetchProjects,
  createProjectOnServer,
  selectAppIdInteractively,
  printTaskStatusSummary,
  TASK_STATUS_ACTION_LABELS,
  selectDatasetInteractively,
  selectTaskIdInteractively,
  listTeams,
  createTeam,
  listTeamMembers,
  addTeamMember,
  removeTeamMember,
  changeTeamMemberRole,
  listProjects,
  createProject,
  resolveProjectSelection,
}

export type { Team, AuthenticatedRequest, Project, TaskStatusPayload, DatasetSelection }
