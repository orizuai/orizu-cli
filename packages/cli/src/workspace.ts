import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { dirname, join, relative, resolve } from 'path'

export const WORKSPACE_DIR_NAME = '.orizu'
export const WORKSPACE_SCHEMA_VERSION = 'orizu.workspace.v0'
export const WORKSPACE_SETUP_VERSION = '0.1.0'

export const WORKSPACE_ROOT_FILES = [
  'README.md',
  'orizu.team.json',
  'AGENTS.md',
  'CLAUDE.md',
  'Memory.md',
  '.gitignore',
] as const

export const WORKSPACE_ROOT_DIRS = [
  WORKSPACE_DIR_NAME,
  'source-repos',
  'projects',
  'sessions',
] as const

export const PROJECT_ROOT_FILES = [
  'README.md',
  'memory.md',
  'orizu.project.json',
  '.gitignore',
] as const

export const PROJECT_PRIMITIVE_DIRS = [
  'datasets',
  'apps',
  'tasks',
  'prompts',
  'scorers',
  'optimizations',
] as const

export const REPO_STATES = [
  'source',
  'draft',
  'snapshot',
  'mirror',
  'cache',
  'object_ref_only',
] as const

export const CANONICAL_OWNERS = [
  'repo',
  'orizu-db',
  'object-storage',
  'local',
] as const

export type RepoState = typeof REPO_STATES[number]
export type CanonicalOwner = typeof CANONICAL_OWNERS[number]

export type WorkspaceOperationAction =
  | 'create_file'
  | 'create_dir'
  | 'append_gitignore'
  | 'create_symlink'
  | 'write_pointer_file'
  | 'rename_file'
  | 'replace_file'
  | 'replace_symlink'

export interface WorkspaceOperation {
  action: WorkspaceOperationAction
  path: string
  safe: boolean
  reason: string
  content?: string
  entries?: string[]
  sourcePath?: string
  target?: string
}

export interface WorkspaceProjectSeed {
  slug: string
  id?: string | null
  name?: string | null
}

export type WorkspaceFindingSeverity = 'error' | 'warning' | 'info'

export interface WorkspaceFinding {
  severity: WorkspaceFindingSeverity
  code: string
  path?: string
  message: string
  fixable: boolean
}

export interface WorkspaceInitOptions {
  cwd?: string
  workspaceRoot?: string
  teamSlug?: string | null
  teamId?: string | null
  projectSlug?: string | null
  projects?: WorkspaceProjectSeed[]
  baseUrl?: string | null
  serviceOrigin?: string | null
  attachWorkspaceId?: string | null
  cliVersion?: string | null
  dryRun?: boolean
  validateOnly?: boolean
  fix?: boolean
  noSymlinks?: boolean
}

export interface WorkspaceInitResult {
  root: string
  state: 'created' | 'exists' | 'would-create' | 'validated' | 'invalid' | 'repaired'
  gitignoreUpdated: boolean
  actions: string[]
  operations: WorkspaceOperation[]
  findings: WorkspaceFinding[]
}

interface WorkspaceSetupPlan {
  root: string
  teamSlug: string
  projects: WorkspaceProjectSeed[]
  operations: WorkspaceOperation[]
  findings: WorkspaceFinding[]
  exists: boolean
}

function hasAllowedValue(values: readonly string[], value: unknown): value is string {
  return typeof value === 'string' && values.includes(value)
}

function normalizeSlug(value: string | null | undefined, fallback: string): string {
  const normalized = (value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return normalized || fallback
}

function normalizeProjectSeeds(options?: WorkspaceInitOptions): WorkspaceProjectSeed[] {
  const explicitProjects = options?.projects?.length
    ? options.projects
    : [{ slug: options?.projectSlug || 'local-project', id: null, name: null }]
  const bySlug = new Map<string, WorkspaceProjectSeed>()

  for (const project of explicitProjects) {
    const slug = normalizeSlug(project.slug, 'local-project')
    if (!bySlug.has(slug)) {
      bySlug.set(slug, {
        slug,
        id: project.id || null,
        name: project.name || null,
      })
    }
  }

  return Array.from(bySlug.values())
}

function resolveWorkspaceRoot(options?: WorkspaceInitOptions): string {
  return resolve(options?.workspaceRoot || options?.cwd || process.cwd())
}

export function getWorkspaceRoot(cwd?: string): string {
  return resolve(cwd || process.cwd())
}

export function workspaceExists(cwd?: string): boolean {
  return existsSync(join(getWorkspaceRoot(cwd), 'orizu.team.json'))
}

function formatJson(value: Record<string, unknown>): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function createTeamManifest(options: {
  teamSlug: string
  teamId: string | null
  serviceOrigin: string | null
  attachWorkspaceId: string | null
  cliVersion: string | null
}): string {
  return formatJson({
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    kind: 'team',
    slug: options.teamSlug,
    teamId: options.teamId,
    serviceOrigin: options.serviceOrigin,
    defaultObjectStore: {
      provider: 'supabase',
      bucket: 'orizu-artifacts',
    },
    canonical: {
      owner: 'repo',
      repoState: 'source',
      serviceId: options.attachWorkspaceId,
      versionId: null,
      contentSha256: null,
      lastPulledAt: null,
      objectRef: null,
      notes: null,
    },
    setup: {
      setupVersion: WORKSPACE_SETUP_VERSION,
      createdBy: 'orizu setup',
      createdAt: new Date().toISOString(),
      cliVersion: options.cliVersion,
      attachedWorkspaceId: options.attachWorkspaceId,
    },
  })
}

function createProjectManifest(teamSlug: string, project: WorkspaceProjectSeed): string {
  return formatJson({
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    kind: 'project',
    slug: project.slug,
    name: project.name || null,
    projectId: project.id || null,
    teamSlug,
    sourceRepos: [],
    policies: {
      defaultRepoState: 'draft',
    },
    canonical: {
      owner: 'repo',
      repoState: 'draft',
      serviceId: null,
      versionId: null,
      contentSha256: null,
      lastPulledAt: null,
      objectRef: null,
      notes: null,
    },
  })
}

function rootReadme(teamSlug: string): string {
  return `# ${teamSlug} Orizu workbench

This repository is the portable Orizu workbench for this team. Durable context,
manifests, intentional snapshots, summaries, and promotion artifacts live in
Git. Live product state remains in Orizu DB/storage unless a repo file is
explicitly applied through Orizu.

Generated exports, local caches, raw logs, raw transcripts, bulky datasets, and
temporary runner materialization belong in ignored or object-backed locations.
`
}

function projectReadme(projectSlug: string): string {
  return `# ${projectSlug}

Project-level Orizu context. Add human notes here and keep machine-readable
state in the adjacent \`orizu.project.json\` manifest and primitive manifests.
`
}

const AGENTS_MD = `# Orizu Agent Instructions

This is a team-level Orizu workbench. Use this file for durable, human-readable
agent guidance; keep detailed CLI manuals in installed skills or reference
docs instead of pasting them here.

Before changing anything, read:

- \`README.md\` for the team workbench overview.
- \`Memory.md\` for durable team preferences and decisions.
- \`projects/*/README.md\` and \`projects/*/memory.md\` for project context.
- \`orizu.*.json\` manifests for machine-readable ids, ownership, source-of-truth
  state, commands, and object refs.

Use \`orizu --help\`, \`orizu <command> --help\`, and
\`orizu capabilities --json\` to discover exact CLI behavior. Do not duplicate
Orizu runtime behavior in repo scripts; go through the CLI.

Treat Git-tracked files as source/context or explicit snapshots. Live Orizu
state remains in Orizu DB/storage unless a manifest says a repo file is the
source of truth. Treat \`.orizu/\`, raw logs, raw transcripts, bulky datasets,
and local source checkouts as ignored cache or object-backed state unless
explicitly promoted.

Ask before creating Orizu server state or changing human-authored repo files.
`

const MEMORY_MD = `# Orizu Memory

Record durable team-level preferences, decisions, and lessons here.
`

const PROJECT_MEMORY_MD = `# Project Memory

Record durable project-level preferences, decisions, and lessons here.
`

const CLAUDE_POINTER = `# Claude Instructions

Read \`AGENTS.md\` in this directory for the canonical Orizu agent instructions.
`

const OLD_CLAUDE_POINTER = `# Claude Instructions

Read \`Agents.md\` in this directory for the canonical Orizu agent instructions.
`

const ORIZU_CLI_AGENTS_START_MARKER = '<!-- orizu-cli:start -->'
const ORIZU_CLI_AGENTS_END_MARKER = '<!-- orizu-cli:end -->'

const LOCAL_WORKSPACE_README = `# Local Orizu cache

This directory is ignored by default. Use it for generated exports, local
caches, temporary runner materialization, and server-derived files that may
drift. The durable workspace contract lives in the root and project manifests
outside this directory.
`

const ROOT_GITIGNORE_ENTRIES = [
  '.orizu/',
  '.logs/',
  '**/raw_transcript/',
  '**/*.raw.jsonl',
  '**/*.log',
  '**/log_dir/',
  '**/downloaded-datasets/',
  '**/trace-pulls/',
  'source-repos/*/checkout/',
  'source-repos/*/worktree/',
  '.env',
  '.env.*',
  'node_modules/',
  '.next/',
  'dist/',
  'build/',
  '.venv/',
  '__pycache__/',
]

const PROJECT_GITIGNORE_ENTRIES = [
  '.orizu/',
  '.logs/',
  '**/raw_transcript/',
  '**/*.raw.jsonl',
  '**/*.log',
  '**/log_dir/',
  '**/downloaded-datasets/',
  '**/trace-pulls/',
  '.env',
  '.env.*',
  '.venv/',
  '__pycache__/',
]

function operation(action: WorkspaceOperationAction, path: string, reason: string, extra?: Partial<WorkspaceOperation>): WorkspaceOperation {
  return {
    action,
    path,
    reason,
    safe: extra?.safe ?? true,
    ...extra,
  }
}

function lstatIfExists(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

function pathExists(path: string): boolean {
  return existsSync(path) || lstatIfExists(path) !== null
}

function rootEntryCaseMatches(root: string, canonical: string): { hasCanonical: boolean, nonCanonical: string[] } {
  const matches = rootEntryNames(root).filter(name => name.toLowerCase() === canonical.toLowerCase())
  return {
    hasCanonical: matches.includes(canonical),
    nonCanonical: matches.filter(name => name !== canonical),
  }
}

function pushCreateDir(operations: WorkspaceOperation[], path: string, reason: string) {
  if (!pathExists(path)) {
    operations.push(operation('create_dir', path, reason))
  }
}

function pushCreateFile(operations: WorkspaceOperation[], path: string, content: string, reason: string) {
  if (!pathExists(path)) {
    operations.push(operation('create_file', path, reason, { content }))
  }
}

function pushCreateRootFile(operations: WorkspaceOperation[], root: string, filename: string, content: string, reason: string) {
  const { hasCanonical, nonCanonical } = rootEntryCaseMatches(root, filename)
  if (!hasCanonical && nonCanonical.length === 0) {
    operations.push(operation('create_file', join(root, filename), reason, { content }))
  }
}

function pushCaseRename(operations: WorkspaceOperation[], root: string, filename: string, fix: boolean | undefined) {
  if (!fix) {
    return
  }

  const { hasCanonical, nonCanonical } = rootEntryCaseMatches(root, filename)
  if (!hasCanonical && nonCanonical.length === 1) {
    operations.push(operation('rename_file', join(root, filename), `rename ${nonCanonical[0]} to ${filename}`, {
      sourcePath: join(root, nonCanonical[0]),
    }))
  }
}

function isKnownClaudePointer(path: string): boolean {
  try {
    const trimmed = readFileSync(path, 'utf8').trim()
    return trimmed === CLAUDE_POINTER.trim() ||
      trimmed === OLD_CLAUDE_POINTER.trim()
  } catch {
    return false
  }
}

function pushClaudeMigrationRepair(operations: WorkspaceOperation[], root: string, sourceName: string, options?: WorkspaceInitOptions) {
  if (!options?.fix) {
    return
  }

  const sourcePath = join(root, sourceName)
  const claudePath = join(root, 'CLAUDE.md')
  let repairable = false
  try {
    const stat = lstatSync(sourcePath)
    repairable = stat.isSymbolicLink() || isKnownClaudePointer(sourcePath)
  } catch {
    repairable = false
  }

  if (!repairable) {
    return
  }

  operations.push(options.noSymlinks
    ? operation('replace_file', claudePath, 'repair CLAUDE.md pointer file', { content: CLAUDE_POINTER })
    : operation('replace_symlink', claudePath, 'repair CLAUDE.md symlink target', { target: 'AGENTS.md' }))
}

function pushExistingClaudeRepair(operations: WorkspaceOperation[], root: string, options?: WorkspaceInitOptions) {
  if (!options?.fix) {
    return
  }

  const claudePath = join(root, 'CLAUDE.md')
  if (!rootEntryCaseMatches(root, 'CLAUDE.md').hasCanonical) {
    return
  }

  try {
    const stat = lstatSync(claudePath)
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(claudePath)
      if (options.noSymlinks) {
        operations.push(operation('replace_file', claudePath, 'repair CLAUDE.md pointer file', { content: CLAUDE_POINTER }))
      } else if (target !== 'AGENTS.md') {
        operations.push(operation('replace_symlink', claudePath, 'repair CLAUDE.md symlink target', { target: 'AGENTS.md' }))
      }
      return
    }

    if (isKnownClaudePointer(claudePath)) {
      operations.push(options.noSymlinks
        ? operation('replace_file', claudePath, 'repair CLAUDE.md pointer file', { content: CLAUDE_POINTER })
        : operation('replace_symlink', claudePath, 'repair CLAUDE.md symlink target', { target: 'AGENTS.md' }))
    }
  } catch {
    // Validation will report unreadable or missing files.
  }
}

function gitignoreHasEntry(content: string, entry: string): boolean {
  return content
    .split('\n')
    .map(line => line.trim())
    .some(line => line === entry || line === entry.replace(/\/$/, ''))
}

function missingGitignoreEntries(path: string, entries: string[]): string[] {
  if (!existsSync(path)) {
    return entries
  }

  const content = readFileSync(path, 'utf8')
  return entries.filter(entry => !gitignoreHasEntry(content, entry))
}

function pushGitignore(operations: WorkspaceOperation[], path: string, entries: string[], reason: string) {
  const missing = missingGitignoreEntries(path, entries)
  if (missing.length > 0) {
    operations.push(operation('append_gitignore', path, reason, { entries: missing }))
  }
}

function existingTeamSlug(root: string): string | null {
  const manifest = readJsonManifest(join(root, 'orizu.team.json'))
  return typeof manifest?.slug === 'string' ? manifest.slug : null
}

function buildSetupPlan(options?: WorkspaceInitOptions, includeFindings = true): WorkspaceSetupPlan {
  const root = resolveWorkspaceRoot(options)
  const currentTeamSlug = existingTeamSlug(root)
  const requestedTeamSlug = options?.teamSlug ? normalizeSlug(options.teamSlug, 'local-team') : null
  const normalizedCurrentTeamSlug = currentTeamSlug ? normalizeSlug(currentTeamSlug, 'local-team') : null
  if (requestedTeamSlug && normalizedCurrentTeamSlug && requestedTeamSlug !== normalizedCurrentTeamSlug) {
    throw new Error(
      `This directory is already an Orizu workspace for team '${normalizedCurrentTeamSlug}'. `
      + `Run setup in another directory to set up team '${requestedTeamSlug}'.`
    )
  }
  const teamSlug = requestedTeamSlug || normalizedCurrentTeamSlug || 'local-team'
  const existingProjectSlugs = projectDirectoryNames(join(root, 'projects'))
  const projects = normalizeProjectSeeds({
    ...options,
    projects: options?.projects?.length
      ? options.projects
      : (!options?.projectSlug && existingProjectSlugs.length > 0
        ? existingProjectSlugs.map(slug => ({ slug }))
        : undefined),
  })
  const serviceOrigin = options?.serviceOrigin || options?.baseUrl || null
  const attachWorkspaceId = options?.attachWorkspaceId || null
  const operations: WorkspaceOperation[] = []

  pushCreateDir(operations, root, 'create workspace root')
  for (const dir of WORKSPACE_ROOT_DIRS) {
    pushCreateDir(operations, join(root, dir), `create root ${dir}/ directory`)
  }
  pushCreateDir(operations, join(root, WORKSPACE_DIR_NAME, 'generated'), 'create local generated cache directory')
  pushCreateDir(operations, join(root, WORKSPACE_DIR_NAME, 'cache'), 'create local cache directory')

  for (const project of projects) {
    const projectRoot = join(root, 'projects', project.slug)
    pushCreateDir(operations, projectRoot, `create ${project.slug} project directory`)
    for (const dir of PROJECT_PRIMITIVE_DIRS) {
      pushCreateDir(operations, join(projectRoot, dir), `create ${project.slug} ${dir}/ directory`)
    }
  }

  pushCaseRename(operations, root, 'README.md', true)
  pushCreateRootFile(operations, root, 'README.md', rootReadme(teamSlug), 'create team workbench README')
  pushCreateFile(
    operations,
    join(root, 'orizu.team.json'),
    createTeamManifest({ teamSlug, teamId: options?.teamId || null, serviceOrigin, attachWorkspaceId, cliVersion: options?.cliVersion || null }),
    'create team manifest'
  )
  pushCaseRename(operations, root, 'AGENTS.md', options?.fix)
  pushCaseRename(operations, root, 'CLAUDE.md', options?.fix)
  for (const variant of rootEntryCaseMatches(root, 'CLAUDE.md').nonCanonical) {
    pushClaudeMigrationRepair(operations, root, variant, options)
  }
  pushExistingClaudeRepair(operations, root, options)
  pushCreateRootFile(operations, root, 'AGENTS.md', AGENTS_MD, 'create canonical agent instructions')
  pushCreateRootFile(operations, root, 'Memory.md', MEMORY_MD, 'create team memory file')

  const claudePath = join(root, 'CLAUDE.md')
  const claudeMatches = rootEntryCaseMatches(root, 'CLAUDE.md')
  if (!claudeMatches.hasCanonical && claudeMatches.nonCanonical.length === 0) {
    operations.push(options?.noSymlinks
      ? operation('write_pointer_file', claudePath, 'create Claude pointer file', { content: CLAUDE_POINTER })
      : operation('create_symlink', claudePath, 'link Claude instructions to AGENTS.md', { target: 'AGENTS.md' }))
  }

  pushGitignore(operations, join(root, '.gitignore'), ROOT_GITIGNORE_ENTRIES, 'seed root gitignore policy')
  pushCreateFile(operations, join(root, WORKSPACE_DIR_NAME, 'README.md'), LOCAL_WORKSPACE_README, 'create local cache README')
  for (const project of projects) {
    const projectRoot = join(root, 'projects', project.slug)
    pushCaseRename(operations, projectRoot, 'README.md', true)
    pushCreateRootFile(operations, projectRoot, 'README.md', projectReadme(project.slug), 'create project README')
    pushCreateFile(operations, join(projectRoot, 'memory.md'), PROJECT_MEMORY_MD, 'create project memory file')
    pushCreateFile(operations, join(projectRoot, 'orizu.project.json'), createProjectManifest(teamSlug, project), 'create project manifest')
    pushGitignore(operations, join(projectRoot, '.gitignore'), PROJECT_GITIGNORE_ENTRIES, 'seed project gitignore policy')
  }

  return {
    root,
    teamSlug,
    projects,
    operations,
    findings: includeFindings ? validateWorkspaceContract({ ...options, workspaceRoot: root }) : [],
    exists: workspaceExists(root),
  }
}

export function planWorkspaceSetup(options?: WorkspaceInitOptions): WorkspaceSetupPlan {
  return buildSetupPlan(options)
}

function ensureParent(path: string) {
  mkdirSync(dirname(path), { recursive: true })
}

function appendGitignore(path: string, entries: string[]) {
  ensureParent(path)
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const terminator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
  const gap = existing.length > 0 ? '\n' : ''
  const prefix = `${terminator}${gap}# Orizu workspace policy\n`
  writeFileSync(path, `${existing}${prefix}${entries.join('\n')}\n`, 'utf8')
}

function applyOperation(op: WorkspaceOperation): boolean {
  if (!op.safe) {
    return false
  }

  if (op.action === 'create_dir') {
    mkdirSync(op.path, { recursive: true })
    return true
  }

  if (op.action === 'create_file' || op.action === 'write_pointer_file') {
    if (pathExists(op.path)) {
      return false
    }
    ensureParent(op.path)
    writeFileSync(op.path, op.content || '', 'utf8')
    return true
  }

  if (op.action === 'append_gitignore') {
    appendGitignore(op.path, op.entries || [])
    return true
  }

  if (op.action === 'create_symlink') {
    if (pathExists(op.path)) {
      return false
    }
    ensureParent(op.path)
    try {
      symlinkSync(op.target || 'AGENTS.md', op.path)
    } catch {
      writeFileSync(op.path, CLAUDE_POINTER, 'utf8')
    }
    return true
  }

  if (op.action === 'rename_file') {
    if (!op.sourcePath || !pathExists(op.sourcePath)) {
      return false
    }
    ensureParent(op.path)
    const sameCaseFoldedPath = op.sourcePath.toLowerCase() === op.path.toLowerCase()
    if (sameCaseFoldedPath) {
      const tempPath = `${op.path}.orizu-rename-${Date.now()}`
      renameSync(op.sourcePath, tempPath)
      renameSync(tempPath, op.path)
    } else {
      if (pathExists(op.path)) {
        return false
      }
      renameSync(op.sourcePath, op.path)
    }
    return true
  }

  if (op.action === 'replace_file') {
    ensureParent(op.path)
    if (pathExists(op.path)) {
      unlinkSync(op.path)
    }
    writeFileSync(op.path, op.content || '', 'utf8')
    return true
  }

  if (op.action === 'replace_symlink') {
    ensureParent(op.path)
    if (pathExists(op.path)) {
      unlinkSync(op.path)
    }
    try {
      symlinkSync(op.target || 'AGENTS.md', op.path)
    } catch {
      writeFileSync(op.path, CLAUDE_POINTER, 'utf8')
    }
    return true
  }

  return false
}

function relativePath(root: string, path: string): string {
  const rel = relative(root, path)
  return rel || '.'
}

function operationLabel(root: string, op: WorkspaceOperation): string {
  const path = relativePath(root, op.path)
  if (op.action === 'create_dir') return `create ${path}/`
  if (op.action === 'create_file') return `create ${path}`
  if (op.action === 'append_gitignore') return `append ${op.entries?.join(', ')} to ${path}`
  if (op.action === 'create_symlink') return `link ${path} -> ${op.target}`
  if (op.action === 'write_pointer_file') return `create ${path} pointer file`
  if (op.action === 'rename_file') return `rename ${relativePath(root, op.sourcePath || '')} -> ${path}`
  if (op.action === 'replace_file') return `repair ${path} pointer file`
  if (op.action === 'replace_symlink') return `repair ${path} -> ${op.target}`
  return `repair ${path}`
}

function finding(severity: WorkspaceFindingSeverity, code: string, message: string, path?: string, fixable = false): WorkspaceFinding {
  return { severity, code, path, message, fixable }
}

function rootEntryNames(root: string): string[] {
  try {
    return readdirSync(root)
  } catch {
    return []
  }
}

function checkCanonicalCase(root: string, canonical: string, findings: WorkspaceFinding[]) {
  const matches = rootEntryNames(root).filter(name => name.toLowerCase() === canonical.toLowerCase())
  const hasCanonical = matches.includes(canonical)
  const nonCanonical = matches.filter(name => name !== canonical)
  const canAutoRepair = !hasCanonical && nonCanonical.length <= 1

  if (!hasCanonical) {
    findings.push(finding('error', 'missing_required_file', `Missing required root file ${canonical}.`, join(root, canonical), canAutoRepair))
  }
  for (const variant of nonCanonical) {
    findings.push(finding('warning', 'non_canonical_case', `${variant} should be named ${canonical}.`, join(root, variant), canAutoRepair))
  }
  if (hasCanonical && nonCanonical.length > 0) {
    findings.push(finding('error', 'case_conflict', `Both ${canonical} and non-canonical variants exist. Resolve manually.`, join(root, canonical), false))
  }
}

function checkProjectFileCanonicalCase(projectRoot: string, projectName: string, canonical: string, findings: WorkspaceFinding[], fixable: boolean) {
  const matches = rootEntryNames(projectRoot).filter(name => name.toLowerCase() === canonical.toLowerCase())
  const hasCanonical = matches.includes(canonical)
  const nonCanonical = matches.filter(name => name !== canonical)

  if (!hasCanonical) {
    findings.push(finding('error', 'missing_project_file', `Missing project file projects/${projectName}/${canonical}.`, join(projectRoot, canonical), fixable))
  }
  for (const variant of nonCanonical) {
    findings.push(finding('warning', 'non_canonical_case', `projects/${projectName}/${variant} should be named ${canonical}.`, join(projectRoot, variant), fixable))
  }
  if (hasCanonical && nonCanonical.length > 0) {
    findings.push(finding('error', 'case_conflict', `Both projects/${projectName}/${canonical} and non-canonical variants exist. Resolve manually.`, join(projectRoot, canonical), false))
  }
}

function readJsonManifest(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function validateManifest(path: string, findings: WorkspaceFinding[]) {
  const parsed = readJsonManifest(path)
  if (!parsed) {
    findings.push(finding('error', 'invalid_manifest_json', 'Manifest must be valid JSON with an object root.', path, false))
    return
  }

  if (parsed.schemaVersion !== WORKSPACE_SCHEMA_VERSION) {
    findings.push(finding('error', 'invalid_schema_version', `Manifest schemaVersion must be ${WORKSPACE_SCHEMA_VERSION}.`, path, false))
  }
  if (typeof parsed.kind !== 'string' || parsed.kind.length === 0) {
    findings.push(finding('error', 'missing_manifest_kind', 'Manifest must include kind.', path, false))
  }
  if (typeof parsed.slug !== 'string' && typeof parsed.runId !== 'string' && typeof parsed.sessionId !== 'string') {
    findings.push(finding('error', 'missing_manifest_identity', 'Manifest must include slug, runId, or sessionId.', path, false))
  }

  const canonical = parsed.canonical
  if (!canonical || typeof canonical !== 'object' || Array.isArray(canonical)) {
    findings.push(finding('error', 'missing_canonical', 'Manifest must include canonical owner and repoState.', path, false))
    return
  }

  const canonicalRecord = canonical as Record<string, unknown>
  if (!hasAllowedValue(CANONICAL_OWNERS, canonicalRecord.owner)) {
    findings.push(finding('error', 'invalid_canonical_owner', `canonical.owner must be one of ${CANONICAL_OWNERS.join(', ')}.`, path, false))
  }
  if (!hasAllowedValue(REPO_STATES, canonicalRecord.repoState)) {
    findings.push(finding('error', 'invalid_repo_state', `canonical.repoState must be one of ${REPO_STATES.join(', ')}.`, path, false))
  }

  if (parsed.kind === 'team') {
    const setup = parsed.setup
    if (!setup || typeof setup !== 'object' || Array.isArray(setup)) {
      findings.push(finding('warning', 'missing_setup_metadata', 'Team manifest should include setup metadata.', path, false))
    }
  }
}

function collectManagedWorkspaceManifestPaths(root: string): string[] {
  const paths: string[] = []
  const ignored = new Set(['.git', 'node_modules', '.next', 'dist', 'build', WORKSPACE_DIR_NAME])
  const rootManifest = join(root, 'orizu.team.json')
  if (existsSync(rootManifest)) {
    paths.push(rootManifest)
  }

  function walk(dir: string, depth: number) {
    if (depth > 8 || !existsSync(dir)) {
      return
    }

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name)) {
        continue
      }
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path, depth + 1)
      } else if (/^orizu\..+\.json$/.test(entry.name)) {
        paths.push(path)
      }
    }
  }

  const projectsRoot = join(root, 'projects')
  for (const projectName of projectDirectoryNames(projectsRoot)) {
    const projectRoot = join(projectsRoot, projectName)
    const projectManifest = join(projectRoot, 'orizu.project.json')
    if (existsSync(projectManifest)) {
      paths.push(projectManifest)
    }

    for (const primitiveDir of PROJECT_PRIMITIVE_DIRS) {
      walk(join(projectRoot, primitiveDir), 0)
    }
  }

  return paths
}

function collectNamedPaths(root: string, name: string): string[] {
  const paths: string[] = []
  const ignored = new Set(['.git', 'node_modules', '.next', 'dist', 'build', WORKSPACE_DIR_NAME])

  function walk(dir: string, depth: number) {
    if (depth > 8 || !existsSync(dir)) {
      return
    }

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name)) {
        continue
      }
      const path = join(dir, entry.name)
      if (entry.name === name) {
        paths.push(path)
      }
      if (entry.isDirectory()) {
        walk(path, depth + 1)
      }
    }
  }

  walk(root, 0)
  return paths
}

function validateClaudeFile(root: string, noSymlinks: boolean, findings: WorkspaceFinding[]) {
  const path = join(root, 'CLAUDE.md')
  const stat = lstatIfExists(path)
  if (!stat) {
    return
  }

  if (stat.isSymbolicLink()) {
    const target = readlinkSync(path)
    if (target !== 'AGENTS.md') {
      findings.push(finding('error', 'invalid_claude_symlink', 'CLAUDE.md must symlink to AGENTS.md.', path, true))
    }
    if (noSymlinks) {
      findings.push(finding('warning', 'unexpected_claude_symlink', 'CLAUDE.md is a symlink but --no-symlinks expects a pointer file.', path, true))
    }
    return
  }

  const content = readFileSync(path, 'utf8')
  if (!content.includes('AGENTS.md')) {
    findings.push(finding('error', 'invalid_claude_pointer', 'CLAUDE.md must point readers to AGENTS.md when it is not a symlink.', path, false))
  }
}

function validateAgentsFile(root: string, findings: WorkspaceFinding[]) {
  const path = join(root, 'AGENTS.md')
  if (!existsSync(path)) {
    return
  }

  const content = readFileSync(path, 'utf8')
  const hasSkillBlock = content.includes(ORIZU_CLI_AGENTS_START_MARKER) &&
    content.includes(ORIZU_CLI_AGENTS_END_MARKER)
  if (hasSkillBlock) {
    findings.push(finding(
      'error',
      'embedded_skill_block',
      'AGENTS.md contains the full Orizu CLI skill block. Keep root AGENTS.md concise and move detailed CLI guidance to installed skills or `orizu --help`.',
      path,
      false
    ))
  }
}

function projectDirectoryNames(projectsRoot: string): string[] {
  try {
    return readdirSync(projectsRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
  } catch {
    return []
  }
}

function validateProjectContract(root: string, options: WorkspaceInitOptions | undefined, findings: WorkspaceFinding[]) {
  const projectsRoot = join(root, 'projects')
  if (!existsSync(projectsRoot)) {
    return
  }

  const expectedProjects = options?.projects?.length
    ? options.projects.map(project => normalizeSlug(project.slug, 'local-project'))
    : (options?.projectSlug ? [normalizeSlug(options.projectSlug, 'local-project')] : null)
  const projectNames = expectedProjects || projectDirectoryNames(projectsRoot)
  const canRepairProject = Boolean(expectedProjects?.length)

  if (projectNames.length === 0) {
    findings.push(finding(
      'error',
      'missing_project_directory',
      'Workspace must include at least one project directory under projects/.',
      projectsRoot,
      canRepairProject
    ))
    return
  }

  for (const name of projectNames) {
    const projectRoot = join(projectsRoot, name)
    if (!existsSync(projectRoot)) {
      findings.push(finding('error', 'missing_project_directory', `Missing project directory projects/${name}/.`, projectRoot, canRepairProject))
      continue
    }

    for (const file of PROJECT_ROOT_FILES) {
      if (/^[A-Z]/.test(file)) {
        checkProjectFileCanonicalCase(projectRoot, name, file, findings, canRepairProject)
      } else {
        const path = join(projectRoot, file)
        if (!existsSync(path)) {
          findings.push(finding('error', 'missing_project_file', `Missing project file projects/${name}/${file}.`, path, canRepairProject))
        }
      }
    }

    for (const dir of PROJECT_PRIMITIVE_DIRS) {
      const path = join(projectRoot, dir)
      if (!existsSync(path)) {
        findings.push(finding('error', 'missing_project_dir', `Missing project directory projects/${name}/${dir}/.`, path, canRepairProject))
      }
    }

    const projectGitignore = join(projectRoot, '.gitignore')
    if (existsSync(projectGitignore) && missingGitignoreEntries(projectGitignore, [`${WORKSPACE_DIR_NAME}/`]).length > 0) {
      findings.push(finding('error', 'missing_project_orizu_gitignore', `.orizu/ must be ignored by default in projects/${name}/.`, projectGitignore, canRepairProject))
    }
  }
}

export function validateWorkspaceContract(options?: WorkspaceInitOptions): WorkspaceFinding[] {
  const root = resolveWorkspaceRoot(options)
  const findings: WorkspaceFinding[] = []

  if (!existsSync(root)) {
    findings.push(finding('error', 'missing_workspace_root', 'Workspace root does not exist.', root, true))
    return findings
  }

  for (const file of WORKSPACE_ROOT_FILES) {
    if (/^[A-Z]/.test(file)) {
      checkCanonicalCase(root, file, findings)
    } else {
      const path = join(root, file)
      if (!existsSync(path)) {
        findings.push(finding('error', 'missing_required_file', `Missing required root file ${file}.`, path, true))
      }
    }
  }

  for (const dir of WORKSPACE_ROOT_DIRS) {
    const path = join(root, dir)
    if (!existsSync(path)) {
      findings.push(finding('error', 'missing_required_dir', `Missing required root directory ${dir}/.`, path, true))
    }
  }

  const rootGitignore = join(root, '.gitignore')
  if (existsSync(rootGitignore) && missingGitignoreEntries(rootGitignore, [`${WORKSPACE_DIR_NAME}/`]).length > 0) {
    findings.push(finding('error', 'missing_orizu_gitignore', '.orizu/ must be ignored by default.', rootGitignore, true))
  }

  validateClaudeFile(root, Boolean(options?.noSymlinks), findings)
  validateAgentsFile(root, findings)
  validateProjectContract(root, options, findings)

  for (const path of collectManagedWorkspaceManifestPaths(root)) {
    validateManifest(path, findings)
  }

  for (const path of collectNamedPaths(root, '.gitadd')) {
    findings.push(finding('error', 'gitadd_not_supported', '.gitadd is not part of the Orizu workspace contract.', path, false))
  }

  return findings
}

export function initOrizuWorkspace(options?: WorkspaceInitOptions): WorkspaceInitResult {
  const dryRun = Boolean(options?.dryRun)
  const validateOnly = Boolean(options?.validateOnly)
  const plan = buildSetupPlan(options, dryRun || validateOnly)
  const beforeExists = plan.exists

  if (dryRun) {
    return {
      root: plan.root,
      state: beforeExists ? 'exists' : 'would-create',
      gitignoreUpdated: false,
      actions: plan.operations.map(op => operationLabel(plan.root, op)),
      operations: plan.operations,
      findings: plan.findings,
    }
  }

  if (validateOnly) {
    const hasErrors = plan.findings.some(item => item.severity === 'error')
    return {
      root: plan.root,
      state: hasErrors ? 'invalid' : 'validated',
      gitignoreUpdated: false,
      actions: [],
      operations: [],
      findings: plan.findings,
    }
  }

  let applied = 0
  let gitignoreUpdated = false
  for (const op of plan.operations) {
    const didApply = applyOperation(op)
    if (didApply) {
      applied += 1
      if (op.action === 'append_gitignore') {
        gitignoreUpdated = true
      }
    }
  }

  const findings = validateWorkspaceContract({ ...options, workspaceRoot: plan.root })
  return {
    root: plan.root,
    state: beforeExists ? (applied > 0 ? 'repaired' : 'exists') : 'created',
    gitignoreUpdated,
    actions: plan.operations.map(op => operationLabel(plan.root, op)),
    operations: plan.operations,
    findings,
  }
}
