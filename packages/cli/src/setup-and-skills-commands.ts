// ORI-2044: moved from index.ts to keep setup and skills commands together.

import { createInterface } from 'readline/promises'
import { stdin as input, stdout as output } from 'process'
import { emitKeypressEvents } from 'readline'
import { join, relative, resolve } from 'path'
import { mkdirSync, writeFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { spawnSync } from 'child_process'
import {
  isInteractiveTerminal,
  getArg,
  getArgs,
  hasJsonFlag,
  hasArg,
  normalizeSlugInput,
  getOptionalArgValue,
  expandHomePath,
  cliArgs,
} from './command-line-arguments.js'
import {
  printLine,
  getCliVersion,
  getErrorMessage,
  printJson,
  printBannerIfInteractive,
} from './cli-console-output.js'
import { sanitizeTerminalText } from './json-response.js'
import {
  SKILL_INSTALL_AGENTS,
  SKILL_INSTALL_TARGETS,
  SkillInstallTarget,
  SkillInstallScope,
  getTargetForAgent,
  getSkillInstallPath,
  SkillInstallMode,
  isSkillInstallAgent,
  isSkillInstallTarget,
  installSkillTarget,
  targetNeedsOverwrite,
  SkillTargetStatus,
  resolveSkillSource,
  getSkillTargetStatus,
  computeSkillContentHash,
} from './skill-installer.js'
import {
  createTeamOnServer,
  fetchTeams,
  fetchProjects,
  createProjectOnServer,
} from './account-directory.js'
import { authedFetch, captureAuthenticatedRequestContext } from './http.js'
import { promptKeyboardSelect } from './keyboard-select.js'
import {
  inspectExistingWorkspaceTeam,
  initOrizuWorkspace,
  workspaceExists,
  getWorkspaceRoot,
} from './workspace.js'
import {
  setupNativeTargetForAgent,
  resolveSetupSkillHome,
  validateSetupFlagValues,
  validateSetupSelectionArgs,
  validateSetupAgentArgs,
  detectedSetupSkillChoices,
  setupLaunchPrompt,
  AGENT_LAUNCH_SPECS,
  findExecutable,
} from './setup-onboarding.js'
import { describeSetupAuthState, confirmExistingSetupAccount } from './setup-account.js'
import { login } from './auth-commands.js'
import { sanitizeSetupHumanInlineText, renderSetupSkillSummary } from './setup-summary.js'
import { renderAgentSetupPrompt } from './setup-prompt.js'
import type { Team, AuthenticatedRequest, Project } from './account-directory.js'
import type { AuthenticatedRequestContext } from './http.js'
import type { WorkspaceProjectSeed } from './workspace.js'



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
    printLine('Validation passed.')
    return
  }

  printLine('Validation findings:')
  for (const finding of findings) {
    const path = finding.path ? ` ${finding.path}` : ''
    printLine(`- ${finding.severity.toUpperCase()} ${finding.code}:${path} ${finding.message}`)
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
  if (target === 'devin-user') return 'Devin, for you across all projects'
  if (target === 'droid-user') return 'Droid, for you across all projects'
  if (target === 'grok-user') return 'Grok Build, for you across all projects'
  if (target === 'windsurf-user') return 'Windsurf, for you across all projects'
  if (target === 'opencode-user') return 'OpenCode, for you across all projects'
  if (target === 'opencode-project') return 'OpenCode, only for this project'
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

type SetupTeamChoice =
  | { kind: 'team', team: Team }
  | { kind: 'create' }

async function resolveSetupTeam(
  teamSlugArg: string | null,
  createTeamName: string | null,
  noInput: boolean,
  dryRun: boolean,
  workspaceTeamSlug: string | null,
  request: AuthenticatedRequest = authedFetch
): Promise<Team> {
  if (teamSlugArg && createTeamName) {
    throw new Error('Use either --team <slug> or --create-team <name>, not both.')
  }
  if (createTeamName) {
    if (dryRun) {
      throw new Error('--create-team cannot be used with --dry-run because setup cannot preview a server-generated team slug.')
    }
    if (workspaceTeamSlug) throw new Error(`This directory is already an Orizu workspace for team '${workspaceTeamSlug}'. Create the new team from another directory.`)
    const name = createTeamName.trim()
    if (!name) throw new Error('--create-team requires a non-empty team name.')
    const team = await createTeamOnServer(name, request)
    printLine(`Created team ${sanitizeTerminalText(team.slug)}`)
    return team
  }
  const teams = await fetchTeams(request)
  const normalizedTeamSlug = teamSlugArg ? normalizeSlugInput(teamSlugArg) : null
  if (normalizedTeamSlug) {
    const team = teams.find(candidate => candidate.slug === normalizedTeamSlug)
    if (!team) {
      throw new Error(`Team '${normalizedTeamSlug}' was not found in your accessible teams.`)
    }
    return team
  }
  if (noInput || dryRun) {
    throw new Error('Non-interactive setup requires --team <slug> or --create-team <name>.')
  }
  const choices: SetupTeamChoice[] = [
    ...teams.map(team => ({ kind: 'team' as const, team })),
    ...(teams.some(team => team.role === 'agent') ? [] : [{ kind: 'create' as const }]),
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
  const name = await askText('Team name?', '')
  if (!name) {
    throw new Error('Team name is required to create a team.')
  }
  if (workspaceTeamSlug) throw new Error(`This directory is already an Orizu workspace for team '${workspaceTeamSlug}'. Create the new team from another directory.`)
  const team = await createTeamOnServer(name, request)
  printLine(`Created team ${sanitizeTerminalText(team.slug)}`)
  return team
}

interface SetupProjectSelection {
  selected: Project
  projects: Project[]
}

type SetupProjectChoice =
  | { kind: 'project', project: Project }
  | { kind: 'create' }
async function resolveSetupProjects(
  team: Team,
  projectSlugArg: string | null,
  createProjectName: string | null,
  noInput: boolean,
  dryRun: boolean,
  request: AuthenticatedRequest
): Promise<SetupProjectSelection> {
  if (projectSlugArg && createProjectName) {
    throw new Error('Use either --project <slug> or --create-project <name>, not both.')
  }
  if ((noInput || dryRun) && !projectSlugArg && !createProjectName) {
    throw new Error('Non-interactive setup requires --project <slug> or --create-project <name>.')
  }
  const canCreateProject = team.role === 'admin' || team.role === 'agent'
  if (createProjectName && !canCreateProject) {
    throw new Error(`Only team admins can create projects in '${team.slug}'. Choose an existing project or ask a team admin to create one.`)
  }
  const projects = await fetchProjects(team.slug, request)
  if (createProjectName) {
    if (dryRun) {
      throw new Error('--create-project cannot be used with --dry-run because setup cannot preview a server-generated project slug.')
    }
    const name = createProjectName.trim()
    if (!name) throw new Error('--create-project requires a non-empty project name.')
    const selected = await createProjectOnServer(team.slug, name, request)
    printLine(`Created project ${sanitizeTerminalText(`${selected.teamSlug}/${selected.slug}`)}`)
    return { selected, projects: [...projects, selected] }
  }
  const normalizedProjectSlug = projectSlugArg ? normalizeSlugInput(projectSlugArg) : null
  if (normalizedProjectSlug) {
    const selected = projects.find(project => project.slug === normalizedProjectSlug)
    if (!selected) {
      throw new Error(`Project '${team.slug}/${normalizedProjectSlug}' was not found.`)
    }
    return { selected, projects }
  }
  if (projects.length === 0) {
    if (!canCreateProject) throw new Error(`Team '${team.slug}' has no accessible projects, and only team admins can create one.`)
    printLine(`Team '${sanitizeTerminalText(team.slug)}' has no projects yet. Let's create the first one.`)
    const name = await askText('Project name?', '')
    if (!name) throw new Error('Project name is required to create a project.')
    const selected = await createProjectOnServer(team.slug, name, request)
    printLine(`Created project ${sanitizeTerminalText(`${selected.teamSlug}/${selected.slug}`)}`)
    return { selected, projects: [selected] }
  }
  const choices: SetupProjectChoice[] = [
    ...projects.map(project => ({ kind: 'project' as const, project })),
    ...(canCreateProject ? [{ kind: 'create' as const }] : []),
  ]
  const choice = await promptKeyboardSelect(
    'Choose the project you want to work in',
    choices,
    item => item.kind === 'create'
      ? 'Create a new project'
      : `${item.project.name} (${item.project.slug})`
  )
  if (choice.kind === 'project') {
    return { selected: choice.project, projects }
  }
  const name = await askText('Project name?', '')
  if (!name) throw new Error('Project name is required to create a project.')
  const selected = await createProjectOnServer(team.slug, name, request)
  printLine(`Created project ${sanitizeTerminalText(`${selected.teamSlug}/${selected.slug}`)}`)
  return { selected, projects: [...projects, selected] }
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

function setupSkillTargetsFromArgs(): SkillInstallTarget[] {
  const targets: SkillInstallTarget[] = []
  for (const agent of getArgs('--agent')) {
    if (!isSkillInstallAgent(agent)) {
      throw new Error(
        `Unknown agent '${agent}'. Available agents: ${SKILL_INSTALL_AGENTS.join(', ')}`
      )
    }
    if (!targets.includes('agent-user')) {
      targets.push('agent-user')
    }
    const nativeTarget = setupNativeTargetForAgent(agent)
    if (nativeTarget && !targets.includes(nativeTarget)) {
      targets.push(nativeTarget)
    }
  }
  return targets
}

function setupSkillLabel(target: SkillInstallTarget): string {
  if (target === 'agent-user' || target === 'agents-project') return 'Shared agent skill'
  if (target === 'codex-user' || target === 'codex-project') return 'Legacy Codex skill'
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
  const inputDisabled = hasArg('--no-input') || hasArg('--non-interactive')
  const noInput = inputDisabled || !isInteractiveTerminal()
  const workspaceArg = getOptionalArgValue('--workspace')
  const workspaceRoot = workspaceArg ? resolve(expandHomePath(workspaceArg)) : process.cwd()
  const teamArg = getOptionalArgValue('--team')
  const createTeamArg = getOptionalArgValue('--create-team')
  const projectArg = getOptionalArgValue('--project')
  const createProjectArg = getOptionalArgValue('--create-project')
  const setupSkillHome = resolveSetupSkillHome()
  const installMode: SkillInstallMode = getArg('--mode') ? parseSkillInstallMode() : 'link'
  validateSetupFlagValues(cliArgs)
  validateSetupSelectionArgs({ team: teamArg, createTeam: createTeamArg, project: projectArg, createProject: createProjectArg, noInput, dryRun, isRepairOrValidation: fix || validateOnly })
  validateSetupAgentArgs(getArgs('--agent'), getArg('--launch'))
  const workspaceManifest = hasArg('--no-workspace') ? { state: 'absent' as const } : inspectExistingWorkspaceTeam(workspaceRoot)
  if (workspaceManifest.state === 'invalid-root' && !validateOnly) throw new Error('The workspace path is not a readable directory. Choose a directory before creating remote resources.')
  if (workspaceManifest.state === 'invalid' && !validateOnly && !fix) throw new Error('The existing orizu.team.json is invalid or unreadable. Repair it before creating remote resources.')
  const workspaceTeamSlug = workspaceManifest.state === 'valid' ? workspaceManifest.slug : null
  if (createTeamArg !== null && workspaceTeamSlug) throw new Error(`This directory is already an Orizu workspace for team '${workspaceTeamSlug}'. Create the new team from another directory.`)
  printBannerIfInteractive()
  printLine('Orizu setup')
  printLine('')
  // Step 1: login
  printLine('Step 1: Login')
  let auth = describeSetupAuthState()
  let setupAuthContext: AuthenticatedRequestContext | null = null
  if (hasArg('--skip-login')) {
    printLine('Skipped (--skip-login).')
  } else if (auth.state === 'signed-in') {
    if (!validateOnly) {
      setupAuthContext = captureAuthenticatedRequestContext({ allowRefresh: !dryRun })
    }
    if (!noInput && !validateOnly) {
      const confirmation = await confirmExistingSetupAccount(
        setupAuthContext!,
        email => promptKeyboardSelect(
          'Confirm the account to use for setup',
          ['continue', 'switch'] as const,
          item => item === 'continue'
            ? `Continue as ${email}`
            : 'Log in with a different account'
        ),
        async () => {
          const context = setupAuthContext!
          const logoutResult = await context.logout()
          if (logoutResult.remoteError) {
            const localOutcome = logoutResult.localCredentialCleared
              ? 'Local credentials were cleared.'
              : 'Local credentials were not cleared because a newer login is active.'
            console.warn(
              `Warning: remote logout failed: ${logoutResult.remoteError} ${localOutcome}`
            )
          } else if (!logoutResult.localCredentialCleared) {
            console.warn('Warning: local credentials were not cleared because a newer login is active.')
          }
          printLine(logoutResult.localCredentialCleared
            ? `Logged out from ${sanitizeTerminalText(context.baseUrl)}.`
            : `Kept the newer login for ${sanitizeTerminalText(context.baseUrl)}.`)
          await login(context.baseUrl)
        },
        { dryRun }
      )
      if (confirmation === 'switched') {
        setupAuthContext = captureAuthenticatedRequestContext({ allowRefresh: !dryRun })
      }
      auth = { state: 'signed-in', baseUrl: setupAuthContext!.baseUrl }
    } else {
      printLine(`Already authenticated with ${sanitizeTerminalText(auth.baseUrl)}.`)
    }
  } else if (noInput || dryRun) {
    printLine('Not signed in. Run `orizu login` to authenticate.')
  } else if (await waitForAnyKeyOrEscape('Press any key to connect your account, or Esc to cancel.')) {
    await login()
    auth = describeSetupAuthState()
  } else {
    throw new Error('Setup cancelled.')
  }
  if (auth.state === 'signed-in' && !validateOnly && !setupAuthContext) {
    setupAuthContext = captureAuthenticatedRequestContext({ allowRefresh: !dryRun })
  }
  if (setupAuthContext) auth = { state: 'signed-in', baseUrl: setupAuthContext.baseUrl }
  const serverCreateRequested = createTeamArg !== null || createProjectArg !== null
  if ((noInput || serverCreateRequested) && auth.state === 'signed-out' && !dryRun && !validateOnly && !fix) {
    throw new Error(
      'Non-interactive setup requires authentication. Run `orizu login --headless`, then retry `orizu setup`.'
    )
  }
  printLine('')
  let setupTeam: Team | null = null
  let selectedProject: Project | null = null
  let setupProjects: Project[] = []
  if (auth.state === 'signed-in' && !validateOnly) {
    const setupRequest = setupAuthContext!.fetch.bind(setupAuthContext)
    setupTeam = await resolveSetupTeam(teamArg, createTeamArg, noInput, dryRun, workspaceTeamSlug, setupRequest)
    if (workspaceTeamSlug && setupTeam.slug !== workspaceTeamSlug) {
      throw new Error(`This directory is already an Orizu workspace for team '${workspaceTeamSlug}'. Run setup in another directory to set up team '${setupTeam.slug}'.`)
    }
    if (fix) {
      setupProjects = await fetchProjects(setupTeam.slug, setupRequest)
      if (setupProjects.length === 0) throw new Error(`Team '${setupTeam.slug}' has no projects to restore.`)
    } else {
      const selection = await resolveSetupProjects(setupTeam, projectArg, createProjectArg, noInput, dryRun, setupRequest)
      selectedProject = selection.selected
      setupProjects = selection.projects
      printLine(`Selected project ${sanitizeTerminalText(`${setupTeam.slug}/${selectedProject.slug}`)}`)
      printLine('')
    }
  }

  // Step 2: local workspace
  printLine('Step 2: Setup your workspace')
  let workspaceState: 'created' | 'exists' | 'skipped' | 'would-create' | 'validated' | 'invalid' | 'repaired' = 'skipped'
  let workspaceResult: ReturnType<typeof initOrizuWorkspace> | null = null
  let validationLogPath: string | null = null
  if (hasArg('--no-workspace') && !validateOnly && !fix) {
    printLine('Skipped (--no-workspace).')
  } else {
    const wantsWorkspace = validateOnly
      || fix
      || hasArg('--workspace')
      || Boolean(setupTeam || teamArg || projectArg)
      || workspaceExists(workspaceRoot)
      || !noInput
    if (wantsWorkspace) {
      let teamSlug = teamArg
      const projectSlug = projectArg
      let teamId: string | null = null
      let projects: WorkspaceProjectSeed[] | undefined
      if (setupTeam && !validateOnly) {
        teamSlug = setupTeam.slug
        teamId = setupTeam.id
        projects = projectSeedsFromProjects(setupProjects)
        printLine(formatProjectSetupProgress(projects.length))
      } else if (!teamSlug && !noInput && !validateOnly) {
        teamSlug = await askText('Team slug?', 'local-team')
      }
      if (auth.state !== 'signed-in' && (!teamSlug || !projectSlug) && noInput && hasArg('--workspace')) {
        printLine('Using starter local-only team/project. Pass --team with authentication to materialize server projects.')
      }
      if (projectSlug && auth.state !== 'signed-in') {
        projects = [{ slug: projectSlug }]
      }
      if (auth.state !== 'signed-in' && !validateOnly) {
        const localProjectCount = projects?.length || 1
        printLine(formatProjectSetupProgress(localProjectCount))
      }
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
          printLine(`${dryRun ? 'Would ' : 'Did '}${action}`)
        }
      } else if (result.actions.length > 0) {
        printLine(validateOnly ? 'Workspace validation complete' : 'Workspace setup complete')
      } else if (!validateOnly) {
        printLine('Workspace setup complete')
      }
      validationLogPath = writeWorkspaceValidationLog(result.root, result.findings, dryRun)
      if (verbose) {
        printWorkspaceFindings(result.findings)
      }
      if ((validateOnly || fix) && result.findings.some(finding => finding.severity === 'error')) {
        process.exitCode = 1
      }
    } else {
      printLine('Skipped. Rerun with --workspace to initialize the workspace contract.')
    }
  }
  printLine('')
  // Step 3: global coding-agent skills
  let installOutcomes: SkillInstallOutcome[] = []
  printLine('Step 3: Install coding agent skills')
  if (hasArg('--no-install') || validateOnly || fix) {
    printLine(hasArg('--no-install') ? 'Skipped (--no-install).' : 'Skipped for validation/repair.')
  } else {
    let targets = setupSkillTargetsFromArgs()
    if (targets.length === 0 && !noInput && !dryRun) {
      if (await askYesNo('Install the Orizu skill for your coding agents?', true)) {
        const selectedChoices = await promptKeyboardMultiSelect(
          'Choose skill installation destinations',
          detectedSetupSkillChoices(setupSkillHome),
          choice => choice.label,
          () => true
        )
        targets = selectedChoices.map(choice => choice.target)
      }
    }
    if (targets.length === 0) {
      printLine('Skipped skill install.')
    } else {
      printLine('Installing skills...')
      installOutcomes = await applySkillInstallTargets(targets, {
        mode: installMode,
        skipConfirm: true,
        dryRun,
        cwd: workspaceRoot,
        homeDir: setupSkillHome,
        showPlan: false,
        printResults: false,
      })
      if (dryRun) {
        printLine('Dry run: no skill files were changed.')
      }
      for (const outcome of installOutcomes) {
        const label = setupSkillLabel(outcome.target)
        if (outcome.action === 'failed') {
          printLine(`${label} failed: ${sanitizeSetupHumanInlineText(outcome.error)}`)
        } else if (outcome.action === 'skipped') {
          printLine(`${label} skipped`)
        } else {
          printLine(`${label} installed`)
        }
      }
    }
  }
  printLine('')
  // Phase 4: coding-agent handoff
  const handoffTeamSlug = setupTeam?.slug || workspaceResult?.teamSlug || null
  const handoffProjectSlug = selectedProject?.slug || (workspaceResult?.projectSlugs.length === 1 ? workspaceResult.projectSlugs[0] : null)
  const handoffPrompt = setupLaunchPrompt(handoffTeamSlug || undefined, handoffProjectSlug || undefined)
  let launchedAgent: string | null = null
  if (!hasArg('--no-handoff') && !validateOnly && !fix && (isInteractiveTerminal() || handoffRequested)) {
    printLine('Step 4: Coding-agent handoff')
    if (handoffRequested) {
      printLine('--- prompt start ---')
      printLine(handoffPrompt)
      printLine('--- prompt end ---')
      printLine('')
    }
    const detected = Object.entries(AGENT_LAUNCH_SPECS)
      .filter(([, spec]) => findExecutable(spec.command))
      .map(([agent]) => agent)
    let launchAgent = getArg('--launch')
    let completedInteractiveHandoff = false
    if (launchAgent && !(launchAgent in AGENT_LAUNCH_SPECS)) {
      throw new Error(`Unknown --launch agent '${launchAgent}'. Choices: ${Object.keys(AGENT_LAUNCH_SPECS).join(', ')}.`)
    }

    if (!launchAgent && !noInput && isInteractiveTerminal() && !dryRun) {
      const launchChoice = await promptKeyboardSelect(
        'Choose an agent to launch',
        [...detected, 'other'],
        agent => agent === 'other' ? 'Other' : AGENT_LAUNCH_SPECS[agent].displayLabel,
        { onEscape: () => 'escape', escapeLabel: 'skip' }
      )
      completedInteractiveHandoff = true
      if (launchChoice === 'other') {
        if (!handoffRequested) {
          printLine('--- prompt start ---')
          printLine(handoffPrompt)
          printLine('--- prompt end ---')
          printLine('')
        }
      } else if (launchChoice !== 'escape') {
        launchAgent = launchChoice
      }
    }
    if (launchAgent) {
      const launchSpec = AGENT_LAUNCH_SPECS[launchAgent]
      const binary = findExecutable(launchSpec.command)
      if (inputDisabled) {
        printLine('Not launching: setup is non-interactive.')
      } else if (!isInteractiveTerminal()) {
        printLine('Not launching: --launch requires an interactive terminal.')
      } else if (!binary) {
        printLine(`Not launching: '${launchSpec.command}' was not found on PATH.`)
      } else if (dryRun) {
        printLine(`Would launch ${binary} with the setup prompt.`)
      } else if (!getArg('--launch') || skipConfirm || await askYesNo(`Launch ${launchSpec.displayLabel} with the setup prompt now?`, true)) {
        printLine(`Launching ${binary}…`)
        const launched = spawnSync(binary, launchSpec.buildPromptArgs(handoffPrompt), {
          cwd: workspaceRoot,
          stdio: 'inherit',
          shell: false,
        })
        if (!launched.error) launchedAgent = launchAgent
        if (launched.error || (launched.status !== null && launched.status !== 0)) {
          printLine(`${launchSpec.displayLabel} exited without completing successfully.`)
        }
      }
    } else if (detected.length === 0 && !completedInteractiveHandoff) {
      printLine('No launchable coding agent was found. Read https://orizu.ai/llms.txt to get started.')
    }
    printLine('')
  }

  // Setup summary (success criteria checklist)
  const source = resolveSkillSource()
  if (hasJsonFlag()) {
    printJson({
      auth: { state: auth.state, server: auth.baseUrl },
      selection: handoffTeamSlug && handoffProjectSlug
        ? { team: handoffTeamSlug, project: handoffProjectSlug }
        : null,
      launch: {
        prompt: handoffPrompt,
        spawned: launchedAgent !== null,
        agent: launchedAgent,
      },
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
  for (const line of renderSetupSkillSummary(installOutcomes, setupSkillHome)) {
    printLine(line)
  }
  printLine(`  Workspace:    ${workspaceState === 'skipped' ? 'skipped' : getWorkspaceRoot(workspaceRoot)}`)
  if (workspaceResult) {
    printLine(`  Validation:   ${validationSummary(workspaceResult.findings, validationLogPath)}`)
  }
  printLine(`  Next:         ${handoffPrompt}`)
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

export {
  setupPromptCommand,
  setupCommand,
  installSkillCommand,
  skillsPathCommand,
  skillsStatusCommand,
  skillsUpdateCommand,
  resolveSetupTeam,
  askYesNo,
}
