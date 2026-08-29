import { existsSync } from 'fs'
import { delimiter, join, resolve } from 'path'

import { isSkillInstallAgent, SKILL_INSTALL_AGENTS } from './skill-installer.js'

export const LAUNCHABLE_AGENTS: Readonly<Record<string, string>> = {
  claude: 'claude',
  codex: 'codex',
  pi: 'pi',
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
  if (launchAgent && !(launchAgent in LAUNCHABLE_AGENTS)) {
    throw new Error(`Unknown --launch agent '${launchAgent}'. Choices: ${Object.keys(LAUNCHABLE_AGENTS).join(', ')}.`)
  }
}

export function setupLaunchPrompt(teamSlug?: string, projectSlug?: string): string {
  const context = teamSlug && projectSlug ? ` in ${teamSlug}/${projectSlug}` : ''
  return `Read https://orizu.ai/llms.txt, then help me get started with Orizu${context}.`
}

export function findExecutable(name: string, pathValue = process.env.PATH || ''): string | null {
  for (const directory of pathValue.split(delimiter)) {
    if (directory && existsSync(join(directory, name))) return resolve(directory, name)
  }
  return null
}
