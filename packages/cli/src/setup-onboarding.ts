import { accessSync, constants, statSync } from 'fs'
import { homedir } from 'os'
import { delimiter, join, relative, resolve, sep } from 'path'

import { sanitizeHumanInlineText, sanitizeTerminalText } from './json-response.js'
import {
  getSkillInstallPath,
  getTargetForAgent,
  isSkillInstallAgent,
  SKILL_INSTALL_AGENTS,
  type SkillInstallAgent,
  type SkillInstallTarget,
} from './skill-installer.js'

export interface AgentLaunchSpec {
  command: string
  displayLabel: string
  buildPromptArgs: (prompt: string) => string[]
}

const directPromptArgs = (prompt: string): string[] => [prompt]

/**
 * Measured launch contracts:
 * - Local `claude --help`, `codex --help`, and `pi --help` expose a direct
 *   positional prompt/message (observed 2026-08-30).
 * - OpenCode's primary CLI reference documents `opencode run [message..]`.
 * - Cursor's primary CLI overview and parameter reference document the Cursor
 *   Agent executable as `agent`, with direct `agent "prompt"` and
 *   `agent -p "prompt"` initial-prompt forms (retrieved 2026-08-30):
 *   https://cursor.com/docs/cli/overview
 *   https://cursor.com/docs/cli/reference/parameters
 *   Cursor is not installed locally; `cursor` is the editor command and is not
 *   detected as Cursor Agent.
 */
export const AGENT_LAUNCH_SPECS: Readonly<Record<string, AgentLaunchSpec>> = {
  claude: { command: 'claude', displayLabel: 'claude', buildPromptArgs: directPromptArgs },
  codex: { command: 'codex', displayLabel: 'codex', buildPromptArgs: directPromptArgs },
  pi: { command: 'pi', displayLabel: 'pi', buildPromptArgs: directPromptArgs },
  opencode: {
    command: 'opencode',
    displayLabel: 'opencode',
    buildPromptArgs: prompt => ['run', prompt],
  },
  cursor: { command: 'agent', displayLabel: 'cursor', buildPromptArgs: directPromptArgs },
}

export interface SetupSelectionArgs {
  team: string | null
  createTeam: string | null
  project: string | null
  createProject: string | null
  noInput: boolean
  dryRun: boolean
  isRepairOrValidation: boolean
}

export function validateSetupFlagValues(args: string[]): void {
  const valueFlags = new Set(['--team', '--create-team', '--project', '--create-project', '--agent', '--launch', '--mode', '--service-origin', '--attach-workspace'])
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (valueFlags.has(flag) && (!args[index + 1] || args[index + 1].startsWith('-'))) {
      throw new Error(`${flag} requires a value.`)
    }
  }
}

export function validateSetupSelectionArgs(args: SetupSelectionArgs): void {
  if (args.team !== null && args.createTeam !== null) throw new Error('Use either --team <slug> or --create-team <name>, not both.')
  if (args.project !== null && args.createProject !== null) throw new Error('Use either --project <slug> or --create-project <name>, not both.')
  if (args.team !== null && !args.team.trim()) throw new Error('--team requires a non-empty slug.')
  if (args.project !== null && !args.project.trim()) throw new Error('--project requires a non-empty slug.')
  if (args.createTeam !== null && !args.createTeam.trim()) throw new Error('--create-team requires a non-empty team name.')
  if (args.createProject !== null && !args.createProject.trim()) throw new Error('--create-project requires a non-empty project name.')
  if (args.createTeam !== null && args.project !== null) throw new Error('--create-team cannot use --project; pass --create-project or choose one interactively.')
  if (args.isRepairOrValidation && (args.createTeam !== null || args.createProject !== null)) throw new Error('Create selectors cannot be used with --validate or --fix.')
  if (args.dryRun && (args.createTeam !== null || args.createProject !== null)) throw new Error('--dry-run cannot preview server-created team or project slugs; use --team and --project.')
  if (args.noInput && args.createTeam !== null && args.createProject === null) throw new Error('--create-team requires --create-project so the new team cannot be left without a project.')
}

export function validateSetupAgentArgs(agents: string[], launchAgent: string | null): void {
  for (const agent of agents) {
    if (!isSkillInstallAgent(agent)) throw new Error(`Unknown agent '${agent}'. Available agents: ${SKILL_INSTALL_AGENTS.join(', ')}`)
  }
  if (launchAgent && !(launchAgent in AGENT_LAUNCH_SPECS)) {
    throw new Error(`Unknown --launch agent '${launchAgent}'. Choices: ${Object.keys(AGENT_LAUNCH_SPECS).join(', ')}.`)
  }
}

export function setupLaunchPrompt(teamSlug?: string, projectSlug?: string): string {
  const context = teamSlug && projectSlug ? ` in ${teamSlug}/${projectSlug}` : ''
  return `Read https://orizu.ai/llms.txt, then help me get started with Orizu${context}.`
}

export function findExecutable(name: string, pathValue = process.env.PATH || ''): string | null {
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, name)
    try {
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, constants.X_OK)
      return resolve(candidate)
    } catch {
      // A stale PATH entry must not hide a later launchable command.
    }
  }
  return null
}

export interface SetupSkillChoice {
  label: string
  target: SkillInstallTarget
}

const SETUP_NATIVE_SKILL_CHOICES: ReadonlyArray<{
  agent: SkillInstallAgent
  label: string
  directory: string[]
  binary?: string
}> = [
  { agent: 'claude', label: 'Claude Code', directory: ['.claude'], binary: 'claude' },
  { agent: 'devin', label: 'Devin', directory: ['.devin', 'skills'] },
  { agent: 'droid', label: 'Droid', directory: ['.factory', 'skills'] },
  { agent: 'grok', label: 'Grok Build', directory: ['.grok', 'skills'] },
  { agent: 'windsurf', label: 'Windsurf', directory: ['.windsurf', 'skills'] },
  { agent: 'opencode', label: 'OpenCode', directory: ['.config', 'opencode'], binary: 'opencode' },
]

export function setupNativeTargetForAgent(agent: SkillInstallAgent): SkillInstallTarget | null {
  if (agent === 'codex' || agent === 'pi') return null
  return getTargetForAgent(agent, 'global')
}

export function resolveSetupSkillHome(): string {
  return resolve(process.env.HOME || homedir())
}

function isSetupConfigDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

const SETUP_SKILL_CHOICE_MAX_WIDTH = 72

function setupSkillChoiceLabel(name: string, target: SkillInstallTarget, homeDir: string): string {
  const destination = getSkillInstallPath(target, { homeDir })
  const userFacingDestination = `~/${relative(homeDir, destination).split(sep).join('/')}`
  const label = sanitizeHumanInlineText(sanitizeTerminalText, `${name} — ${userFacingDestination}`)
  if (label.length > SETUP_SKILL_CHOICE_MAX_WIDTH) {
    throw new Error(`Setup skill destination label exceeds ${SETUP_SKILL_CHOICE_MAX_WIDTH} columns.`)
  }
  return label
}

export function detectedSetupSkillChoices(homeDir: string): SetupSkillChoice[] {
  const detectedNativeChoices = SETUP_NATIVE_SKILL_CHOICES.filter(choice =>
    isSetupConfigDirectory(join(homeDir, ...choice.directory))
    || Boolean(choice.binary && findExecutable(choice.binary))
  )
  const priority = (choice: typeof SETUP_NATIVE_SKILL_CHOICES[number]) =>
    choice.agent === 'claude' ? 0 : choice.agent === 'opencode' ? 1 : 2
  const universalTarget: SkillInstallTarget = 'agent-user'

  return [{
    label: setupSkillChoiceLabel(
      'Universal (.agents — Codex and others)',
      universalTarget,
      homeDir
    ),
    target: universalTarget,
  }, ...detectedNativeChoices
    .sort((left, right) => priority(left) - priority(right))
    .map(choice => {
      const target = getTargetForAgent(choice.agent, 'global')
      return {
        label: setupSkillChoiceLabel(
          choice.agent === 'claude' ? 'Claude' : choice.label,
          target,
          homeDir
        ),
        target,
      }
    })]
}
