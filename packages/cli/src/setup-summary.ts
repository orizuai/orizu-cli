import { isAbsolute, relative, sep } from 'node:path'

import { sanitizeHumanInlineText, sanitizeTerminalText } from './json-response.js'
import type { SkillInstallTarget } from './skill-installer.js'

const SETUP_SKILL_FRIENDLY_NAMES: Record<SkillInstallTarget, string> = {
  'agent-user': 'Universal',
  'agents-project': 'Universal (project)',
  'codex-user': 'Codex',
  'codex-project': 'Codex (project)',
  'claude-user': 'Claude',
  'claude-project': 'Claude (project)',
  'devin-user': 'Devin',
  'droid-user': 'Droid',
  'grok-user': 'Grok Build',
  'windsurf-user': 'Windsurf',
  'opencode-user': 'OpenCode',
  'opencode-project': 'OpenCode (project)',
  'agents-md': 'Project instructions (AGENTS.md)',
}

export interface SetupSkillSummaryOutcome {
  target: SkillInstallTarget
  path: string
  action: 'created' | 'updated' | 'skipped' | 'failed'
  error?: string
}

export function setupSkillFriendlyName(target: SkillInstallTarget): string {
  return SETUP_SKILL_FRIENDLY_NAMES[target]
}

export function sanitizeSetupHumanInlineText(value: unknown): string {
  return sanitizeHumanInlineText(sanitizeTerminalText, value)
}

export function formatSetupSkillDestination(destination: string, setupHome: string): string {
  if (!isAbsolute(destination) || !isAbsolute(setupHome)) return destination
  const relativeDestination = relative(setupHome, destination)
  if (relativeDestination === '') return '~'
  if (
    !isAbsolute(relativeDestination) &&
    relativeDestination !== '..' &&
    !relativeDestination.startsWith(`..${sep}`)
  ) {
    return `~/${relativeDestination.split(sep).join('/')}`
  }
  return destination
}

export function renderSetupSkillSummary(
  outcomes: SetupSkillSummaryOutcome[],
  setupHome: string
): string[] {
  const successful = outcomes.filter(outcome =>
    outcome.action === 'created' || outcome.action === 'updated'
  )
  const failures = outcomes.filter(outcome => outcome.action === 'failed')
  const lines: string[] = []

  if (successful.length > 0) {
    lines.push('Skills installed to the following directories:')
    const nameWidth = Math.max(...successful.map(outcome => setupSkillFriendlyName(outcome.target).length))
    for (const outcome of successful) {
      const destination = formatSetupSkillDestination(outcome.path, setupHome)
      lines.push(`  ${setupSkillFriendlyName(outcome.target).padEnd(nameWidth)}  ${sanitizeSetupHumanInlineText(destination)}`)
    }
  } else {
    lines.push('Skills not installed. To install them, run `orizu install-skill`.')
  }

  for (const failure of failures) {
    lines.push(`${setupSkillFriendlyName(failure.target)} failed: ${sanitizeSetupHumanInlineText(failure.error || 'Unknown error')}`)
  }

  return lines
}
