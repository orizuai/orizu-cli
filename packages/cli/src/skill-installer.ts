import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { dirname, isAbsolute, join, relative, resolve } from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'
import { createHash } from 'crypto'
import { workspaceExists } from './workspace.js'

export const SKILL_NAME = 'orizu-cli'
export const AGENTS_START_MARKER = '<!-- orizu-cli:start -->'
export const AGENTS_END_MARKER = '<!-- orizu-cli:end -->'

export const SKILL_INSTALL_TARGETS = [
  'codex-user',
  'agent-user',
  'agents-project',
  'codex-project',
  'claude-user',
  'claude-project',
  'agents-md',
] as const

export type SkillInstallTarget = typeof SKILL_INSTALL_TARGETS[number]

export const SKILL_META_FILENAME = '.orizu-skill-meta.json'

export const SKILL_INSTALL_AGENTS = ['claude', 'codex'] as const

export type SkillInstallAgent = typeof SKILL_INSTALL_AGENTS[number]

export type SkillInstallScope = 'global' | 'local'

export type SkillInstallMode = 'auto' | 'link' | 'copy'

const PROJECT_LEVEL_TARGETS: readonly SkillInstallTarget[] = [
  'agents-project',
  'codex-project',
  'claude-project',
]

export interface SkillInstallOptions {
  cwd?: string
  homeDir?: string
  overwrite?: boolean
  dryRun?: boolean
  mode?: SkillInstallMode
  cliVersion?: string
}

export interface SkillInstallResult {
  target: SkillInstallTarget
  path: string
  action: 'created' | 'updated' | 'would-create' | 'would-update'
  mode: 'link' | 'copy' | 'section'
}

export interface SkillInstallMeta {
  name: string
  skillHash: string
  cliVersion: string | null
  source: SkillSourceType
  sourceRoot: string
  mode: 'copy'
  installedAt: string
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

export type SkillSourceType = 'override' | 'packaged' | 'repo-fallback'

export interface SkillSourceInfo {
  name: string
  root: string
  skillMd: string
  source: SkillSourceType
}

export function resolveSkillSource(): SkillSourceInfo {
  const override = process.env.ORIZU_SKILL_SOURCE_DIR
  if (override) {
    const resolvedOverride = resolve(override)
    if (!isSkillDir(resolvedOverride)) {
      throw new Error(`ORIZU_SKILL_SOURCE_DIR is not an Orizu skill directory: ${resolvedOverride}`)
    }
    return {
      name: SKILL_NAME,
      root: resolvedOverride,
      skillMd: resolve(resolvedOverride, 'SKILL.md'),
      source: 'override',
    }
  }

  const cliRoot = getCliRoot()
  const packagedSkill = resolve(cliRoot, 'vendor', 'skills', SKILL_NAME)
  if (isSkillDir(packagedSkill)) {
    return {
      name: SKILL_NAME,
      root: packagedSkill,
      skillMd: resolve(packagedSkill, 'SKILL.md'),
      source: 'packaged',
    }
  }

  const repoSkill = resolve(cliRoot, '..', '..', 'skills', SKILL_NAME)
  if (isSkillDir(repoSkill)) {
    return {
      name: SKILL_NAME,
      root: repoSkill,
      skillMd: resolve(repoSkill, 'SKILL.md'),
      source: 'repo-fallback',
    }
  }

  const searchedPaths = [
    `packaged skill: ${packagedSkill}`,
    `repository fallback: ${repoSkill}`,
  ]

  throw new Error(formatMissingSkillSourceError(searchedPaths))
}

export function resolveSkillSourceDir(): string {
  return resolveSkillSource().root
}

function listSkillFiles(root: string, dir: string, files: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name)
    if (!shouldCopySkillPath(root, entryPath)) {
      continue
    }
    if (entry.isDirectory()) {
      listSkillFiles(root, entryPath, files)
    } else if (entry.isFile()) {
      files.push(entryPath)
    }
  }
}

export function computeSkillContentHash(root: string): string {
  const files: string[] = []
  listSkillFiles(root, root, files)
  const hash = createHash('sha256')
  const sorted = files
    .map(file => relative(root, file).replace(/\\/g, '/'))
    .sort()
  for (const rel of sorted) {
    hash.update(rel)
    hash.update('\0')
    hash.update(readFileSync(join(root, rel)))
    hash.update('\0')
  }
  return `sha256:${hash.digest('hex')}`
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

  if (target === 'codex-user') {
    return resolve(home, '.codex', 'skills', SKILL_NAME)
  }

  if (target === 'agent-user') {
    return resolve(home, '.agents', 'skills', SKILL_NAME)
  }

  if (target === 'agents-project') {
    return resolve(cwd, '.agents', 'skills', SKILL_NAME)
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

export function getTargetForAgent(
  agent: SkillInstallAgent,
  scope: SkillInstallScope
): SkillInstallTarget {
  if (agent === 'claude') {
    return scope === 'global' ? 'claude-user' : 'claude-project'
  }
  return scope === 'global' ? 'codex-user' : 'agents-project'
}

export function isSkillInstallAgent(value: string): value is SkillInstallAgent {
  return (SKILL_INSTALL_AGENTS as readonly string[]).includes(value)
}

export function isProjectLevelTarget(target: SkillInstallTarget): boolean {
  return PROJECT_LEVEL_TARGETS.includes(target)
}

const UNSTABLE_SOURCE_PATTERNS = [
  /\/_npx\//,
  /\/\.npm\//,
  /\/npm-cache\//,
  /\/\.bun\/install\/cache\//,
  /\/bunx-/,
  /\/dlx-/,
  /\/\.pnpm-store\//,
  /^\/tmp\//,
  /^\/(private\/)?var\/folders\//,
  /\/Temp\//,
]

export function isStableSkillSourcePath(root: string): boolean {
  const normalized = root.replace(/\\/g, '/')
  return !UNSTABLE_SOURCE_PATTERNS.some(pattern => pattern.test(normalized))
}

export function resolveEffectiveInstallMode(
  target: SkillInstallTarget,
  sourceRoot: string,
  mode: SkillInstallMode = 'auto'
): 'link' | 'copy' | 'section' {
  if (target === 'agents-md') {
    return 'section'
  }

  if (isProjectLevelTarget(target)) {
    if (mode === 'link') {
      throw new Error(
        `--mode link is not supported for project-level target '${target}': committed project files must not symlink to user-local package paths. Use --mode copy.`
      )
    }
    return 'copy'
  }

  if (mode === 'link') {
    return 'link'
  }
  if (mode === 'copy') {
    return 'copy'
  }
  return isStableSkillSourcePath(sourceRoot) ? 'link' : 'copy'
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
    part === '.pytest_cache' ||
    part === SKILL_META_FILENAME
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
  if (workspaceExists(dirname(targetPath))) {
    throw new Error(
      `${targetPath} belongs to an Orizu workspace. Keep root AGENTS.md as concise workspace guidance; use global skill installs or project skill directories for detailed Orizu CLI reference material.`
    )
  }

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
      mode: 'section',
    }
  }

  if (hasManagedSection && !options?.overwrite) {
    throw new Error(`${targetPath} already contains an Orizu CLI section. Pass --yes to replace it.`)
  }

  mkdirSync(dirname(targetPath), { recursive: true })
  if (!exists) {
    writeFileSync(targetPath, section, 'utf8')
    return { target: 'agents-md', path: targetPath, action: 'created', mode: 'section' }
  }

  if (hasManagedSection) {
    const pattern = new RegExp(
      `${escapeRegExp(AGENTS_START_MARKER)}[\\s\\S]*?${escapeRegExp(AGENTS_END_MARKER)}\\n?`
    )
    writeFileSync(targetPath, existing.replace(pattern, section), 'utf8')
    return { target: 'agents-md', path: targetPath, action: 'updated', mode: 'section' }
  }

  const existingPrefix = existing.trim().length === 0 ? '' : existing
  const separator = existingPrefix.endsWith('\n') ? '\n' : '\n\n'
  writeFileSync(targetPath, `${existingPrefix}${existingPrefix ? separator : ''}${section}`, 'utf8')
  return { target: 'agents-md', path: targetPath, action: 'updated', mode: 'section' }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

export function targetNeedsOverwrite(
  target: SkillInstallTarget,
  options?: SkillInstallOptions
): boolean {
  const targetPath = getSkillInstallPath(target, options)
  if (target !== 'agents-md') {
    return pathEntryExists(targetPath)
  }

  if (!existsSync(targetPath)) {
    return false
  }

  const existing = readFileSync(targetPath, 'utf8')
  return existing.includes(AGENTS_START_MARKER) && existing.includes(AGENTS_END_MARKER)
}

function writeSkillMeta(
  targetDir: string,
  source: SkillSourceInfo,
  options?: SkillInstallOptions
): void {
  const meta: SkillInstallMeta = {
    name: source.name,
    skillHash: computeSkillContentHash(source.root),
    cliVersion: options?.cliVersion || null,
    source: source.source,
    sourceRoot: source.root,
    mode: 'copy',
    installedAt: new Date().toISOString(),
  }
  writeFileSync(join(targetDir, SKILL_META_FILENAME), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
}

export function readSkillMeta(targetDir: string): SkillInstallMeta | null {
  const metaPath = join(targetDir, SKILL_META_FILENAME)
  if (!existsSync(metaPath)) {
    return null
  }
  try {
    const parsed = JSON.parse(readFileSync(metaPath, 'utf8')) as SkillInstallMeta
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function linkSkillTree(sourceDir: string, targetDir: string) {
  rmSync(targetDir, { recursive: true, force: true })
  mkdirSync(dirname(targetDir), { recursive: true })
  symlinkSync(sourceDir, targetDir, 'dir')
}

export function installSkillTarget(
  target: SkillInstallTarget,
  options?: SkillInstallOptions
): SkillInstallResult {
  const source = resolveSkillSource()
  const targetPath = getSkillInstallPath(target, options)

  if (target === 'agents-md') {
    return installAgentsMd(source.root, targetPath, options)
  }

  const exists = pathEntryExists(targetPath)
  const mode = resolveEffectiveInstallMode(target, source.root, options?.mode)

  if (options?.dryRun) {
    return {
      target,
      path: targetPath,
      action: exists ? 'would-update' : 'would-create',
      mode,
    }
  }

  if (exists && !options?.overwrite) {
    throw new Error(`${targetPath} already exists. Pass --yes to replace it.`)
  }

  if (mode === 'link') {
    linkSkillTree(source.root, targetPath)
  } else {
    copySkillTree(source.root, targetPath)
    writeSkillMeta(targetPath, source, options)
  }

  return {
    target,
    path: targetPath,
    action: exists ? 'updated' : 'created',
    mode,
  }
}

export type SkillTargetState =
  | 'current'
  | 'stale'
  | 'missing'
  | 'broken-link'
  | 'unmanaged'

export interface SkillTargetStatus {
  target: SkillInstallTarget
  path: string
  state: SkillTargetState
  mode: 'link' | 'copy' | 'section' | null
  linkTarget: string | null
  installedHash: string | null
  sourceHash: string
  meta: SkillInstallMeta | null
}

function getAgentsMdStatus(
  targetPath: string,
  source: SkillSourceInfo,
  sourceHash: string
): SkillTargetStatus {
  const base = {
    target: 'agents-md' as const,
    path: targetPath,
    mode: 'section' as const,
    linkTarget: null,
    installedHash: null,
    sourceHash,
    meta: null,
  }

  if (!existsSync(targetPath)) {
    return { ...base, state: 'missing' }
  }

  const existing = readFileSync(targetPath, 'utf8')
  const start = existing.indexOf(AGENTS_START_MARKER)
  const end = existing.indexOf(AGENTS_END_MARKER)
  if (start === -1 || end === -1) {
    return { ...base, state: 'unmanaged' }
  }

  const actualSection = existing.slice(start, end + AGENTS_END_MARKER.length)
  const expectedSection = buildAgentsSection(source.root).trimEnd()
  return {
    ...base,
    state: actualSection.trimEnd() === expectedSection ? 'current' : 'stale',
  }
}

export function getSkillTargetStatus(
  target: SkillInstallTarget,
  options?: SkillInstallOptions
): SkillTargetStatus {
  const source = resolveSkillSource()
  const sourceHash = computeSkillContentHash(source.root)
  const targetPath = getSkillInstallPath(target, options)

  if (target === 'agents-md') {
    return getAgentsMdStatus(targetPath, source, sourceHash)
  }

  const base = {
    target,
    path: targetPath,
    linkTarget: null as string | null,
    installedHash: null as string | null,
    sourceHash,
    meta: null as SkillInstallMeta | null,
  }

  if (!pathEntryExists(targetPath)) {
    return { ...base, state: 'missing', mode: null }
  }

  const stats = lstatSync(targetPath)
  if (stats.isSymbolicLink()) {
    const linkTarget = readlinkSync(targetPath)
    if (!existsSync(targetPath)) {
      return { ...base, state: 'broken-link', mode: 'link', linkTarget }
    }

    const resolvedLink = realpathSync(targetPath)
    const installedHash = computeSkillContentHash(resolvedLink)
    const state = resolvedLink === realpathSync(source.root) || installedHash === sourceHash
      ? 'current'
      : 'stale'
    return { ...base, state, mode: 'link', linkTarget, installedHash }
  }

  const installedHash = computeSkillContentHash(targetPath)
  const meta = readSkillMeta(targetPath)
  // A differing directory without our meta file was not installed by Orizu
  // (or was hand-customized): treat it as unmanaged so `skills update` never
  // silently overwrites it. Matching content is current regardless of meta.
  const state =
    installedHash === sourceHash ? 'current' : meta ? 'stale' : 'unmanaged'
  return {
    ...base,
    state,
    mode: 'copy',
    installedHash,
    meta,
  }
}

export function isSkillInstallTarget(value: string): value is SkillInstallTarget {
  return (SKILL_INSTALL_TARGETS as readonly string[]).includes(value)
}
