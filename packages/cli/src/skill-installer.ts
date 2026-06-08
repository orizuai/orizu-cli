import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { dirname, isAbsolute, relative, resolve } from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'

export const SKILL_NAME = 'orizu-cli'
export const AGENTS_START_MARKER = '<!-- orizu-cli:start -->'
export const AGENTS_END_MARKER = '<!-- orizu-cli:end -->'

export const SKILL_INSTALL_TARGETS = [
  'agent-user',
  'codex-project',
  'claude-user',
  'claude-project',
  'agents-md',
] as const

export type SkillInstallTarget = typeof SKILL_INSTALL_TARGETS[number]

export interface SkillInstallOptions {
  cwd?: string
  homeDir?: string
  overwrite?: boolean
  dryRun?: boolean
}

export interface SkillInstallResult {
  target: SkillInstallTarget
  path: string
  action: 'created' | 'updated' | 'would-create' | 'would-update'
}

function getCliRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

function isSkillDir(path: string): boolean {
  return existsSync(resolve(path, 'SKILL.md'))
}

export function isSafeRelativeSkillPath(rel: string): boolean {
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)
}

export function formatMissingSkillSourceError(paths: string[]): string {
  return `Unable to find bundled ${SKILL_NAME} skill. Reinstall the orizu CLI or run from the Orizu repository.\n`
    + `Searched:\n- ${paths.join('\n- ')}`
}

export function resolveSkillSourceDir(): string {
  const override = process.env.ORIZU_SKILL_SOURCE_DIR
  if (override) {
    const resolvedOverride = resolve(override)
    if (!isSkillDir(resolvedOverride)) {
      throw new Error(`ORIZU_SKILL_SOURCE_DIR is not an Orizu skill directory: ${resolvedOverride}`)
    }
    return resolvedOverride
  }

  const cliRoot = getCliRoot()
  const packagedSkill = resolve(cliRoot, 'vendor', 'skills', SKILL_NAME)
  if (isSkillDir(packagedSkill)) {
    return packagedSkill
  }

  const repoSkill = resolve(cliRoot, '..', '..', 'skills', SKILL_NAME)
  if (isSkillDir(repoSkill)) {
    return repoSkill
  }

  const searchedPaths = [
    `packaged skill: ${packagedSkill}`,
    `repository fallback: ${repoSkill}`,
  ]

  throw new Error(formatMissingSkillSourceError(searchedPaths))
}

function resolveHome(options?: SkillInstallOptions): string {
  return resolve(options?.homeDir || process.env.HOME || homedir())
}

function resolveCwd(options?: SkillInstallOptions): string {
  return resolve(options?.cwd || process.cwd())
}

export function getSkillInstallPath(
  target: SkillInstallTarget,
  options?: SkillInstallOptions
): string {
  const home = resolveHome(options)
  const cwd = resolveCwd(options)

  if (target === 'agent-user') {
    return resolve(home, '.agents', 'skills', SKILL_NAME)
  }

  if (target === 'codex-project') {
    return resolve(cwd, '.codex', 'skills', SKILL_NAME)
  }

  if (target === 'claude-user') {
    return resolve(home, '.claude', 'skills', SKILL_NAME)
  }

  if (target === 'claude-project') {
    return resolve(cwd, '.claude', 'skills', SKILL_NAME)
  }

  return resolve(cwd, 'AGENTS.md')
}

function shouldCopySkillPath(sourceRoot: string, sourcePath: string): boolean {
  const rel = relative(sourceRoot, sourcePath).replace(/\\/g, '/')
  if (!rel) {
    return true
  }
  if (!isSafeRelativeSkillPath(rel)) {
    return false
  }

  const parts = rel.split('/')
  return !parts.some(part =>
    part === '.DS_Store' ||
    part === '__pycache__' ||
    part === '.pytest_cache'
  ) && !rel.endsWith('.pyc') && !rel.endsWith('.pyo')
}

function copySkillTree(sourceDir: string, targetDir: string) {
  rmSync(targetDir, { recursive: true, force: true })
  mkdirSync(dirname(targetDir), { recursive: true })
  cpSync(sourceDir, targetDir, {
    recursive: true,
    filter: sourcePath => shouldCopySkillPath(sourceDir, sourcePath),
  })
}

function stripFrontmatter(markdown: string): string {
  const match = markdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/)
  if (!match) {
    return markdown
  }

  return markdown.slice(match[0].length).replace(/^[\r\n]+/, '')
}

function buildAgentsSection(sourceDir: string): string {
  const skillMarkdown = readFileSync(resolve(sourceDir, 'SKILL.md'), 'utf8')
  const body = stripFrontmatter(skillMarkdown).trimEnd()
  return `${AGENTS_START_MARKER}\n${body}\n${AGENTS_END_MARKER}\n`
}

function installAgentsMd(
  sourceDir: string,
  targetPath: string,
  options?: SkillInstallOptions
): SkillInstallResult {
  const section = buildAgentsSection(sourceDir)
  const exists = existsSync(targetPath)
  const existing = exists ? readFileSync(targetPath, 'utf8') : ''
  const hasManagedSection = existing.includes(AGENTS_START_MARKER)
    && existing.includes(AGENTS_END_MARKER)
  const action = exists ? 'updated' : 'created'

  if (options?.dryRun) {
    return {
      target: 'agents-md',
      path: targetPath,
      action: action === 'updated' ? 'would-update' : 'would-create',
    }
  }

  if (hasManagedSection && !options?.overwrite) {
    throw new Error(`${targetPath} already contains an Orizu CLI section. Pass --yes to replace it.`)
  }

  mkdirSync(dirname(targetPath), { recursive: true })
  if (!exists) {
    writeFileSync(targetPath, section, 'utf8')
    return { target: 'agents-md', path: targetPath, action: 'created' }
  }

  if (hasManagedSection) {
    const pattern = new RegExp(
      `${escapeRegExp(AGENTS_START_MARKER)}[\\s\\S]*?${escapeRegExp(AGENTS_END_MARKER)}\\n?`
    )
    writeFileSync(targetPath, existing.replace(pattern, section), 'utf8')
    return { target: 'agents-md', path: targetPath, action: 'updated' }
  }

  const existingPrefix = existing.trim().length === 0 ? '' : existing
  const separator = existingPrefix.endsWith('\n') ? '\n' : '\n\n'
  writeFileSync(targetPath, `${existingPrefix}${existingPrefix ? separator : ''}${section}`, 'utf8')
  return { target: 'agents-md', path: targetPath, action: 'updated' }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function targetNeedsOverwrite(
  target: SkillInstallTarget,
  options?: SkillInstallOptions
): boolean {
  const targetPath = getSkillInstallPath(target, options)
  if (!existsSync(targetPath)) {
    return false
  }

  if (target !== 'agents-md') {
    return true
  }

  const existing = readFileSync(targetPath, 'utf8')
  return existing.includes(AGENTS_START_MARKER) && existing.includes(AGENTS_END_MARKER)
}

export function installSkillTarget(
  target: SkillInstallTarget,
  options?: SkillInstallOptions
): SkillInstallResult {
  const sourceDir = resolveSkillSourceDir()
  const targetPath = getSkillInstallPath(target, options)
  const exists = existsSync(targetPath)

  if (target === 'agents-md') {
    return installAgentsMd(sourceDir, targetPath, options)
  }

  if (options?.dryRun) {
    return {
      target,
      path: targetPath,
      action: exists ? 'would-update' : 'would-create',
    }
  }

  if (exists && !options?.overwrite) {
    throw new Error(`${targetPath} already exists. Pass --yes to replace it.`)
  }

  copySkillTree(sourceDir, targetPath)
  return {
    target,
    path: targetPath,
    action: exists ? 'updated' : 'created',
  }
}

export function isSkillInstallTarget(value: string): value is SkillInstallTarget {
  return (SKILL_INSTALL_TARGETS as readonly string[]).includes(value)
}
