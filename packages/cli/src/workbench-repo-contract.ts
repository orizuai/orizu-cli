/**
 * Workbench repo contract (ALI-971 / WS-C).
 *
 * Pure, dependency-free builders that render the Phase 1 `orizu.workspace.v0`
 * repo contract as an in-memory set of `{ path, content }` files, ready to be
 * committed to a freshly provisioned GitHub repo via the Contents API.
 *
 * This is the server-side sibling of `packages/cli/src/workspace.ts`. It
 * intentionally imports NOTHING node-CLI-specific (no `fs`, no `path`) so the
 * platform can render the contract without touching disk. The content strings
 * are a deliberate copy of the CLI's builders; `test/workbench-repo-contract-
 * bytematch.test.ts` asserts byte-for-byte parity with `initOrizuWorkspace`
 * for the default, normalized mode. The canonical seed's validated-raw mode
 * is deliberately platform-only: it preserves existing ADR-007 `repo_path`
 * directories and the database project slug used as their manifest identity.
 * CLI init creates fresh projects, where normalization remains correct.
 *
 * Symlinks cannot be committed through the Contents API, so `CLAUDE.md` is
 * rendered as a pointer FILE (the CLI's `--no-symlinks` shape). `.orizu/` is
 * gitignored and is materialized locally by `orizu setup` after clone, so it is
 * NOT part of the committed contract. Empty contract directories carry a
 * `.gitkeep` so they survive `git clone` (Git does not track empty dirs).
 */

export const WORKSPACE_SCHEMA_VERSION = 'orizu.workspace.v0'
export const WORKSPACE_SETUP_VERSION = '0.1.0'
export const WORKSPACE_DIR_NAME = '.orizu'

export const PROJECT_PRIMITIVE_DIRS = [
  'datasets',
  'apps',
  'tasks',
  'prompts',
  'judges',
  'scorers',
  'runners',
  'optimizations',
] as const

// Empty contract dirs that must survive `git clone`.
const EMPTY_ROOT_DIRS = ['source-repos', 'sessions'] as const

export interface WorkbenchRepoProjectSeed {
  slug: string
  id?: string | null
  name?: string | null
}

export interface WorkbenchRepoContractOptions {
  teamSlug: string
  teamId?: string | null
  serviceOrigin?: string | null
  attachWorkspaceId?: string | null
  cliVersion?: string | null
  createdBy?: string
  /** ISO string; defaults to now. Kept injectable for deterministic tests. */
  createdAt?: string
  projects: WorkbenchRepoProjectSeed[]
}

export interface WorkbenchRepoFile {
  path: string
  content: string
}

export type WorkbenchRepoProjectSlugMode = 'normalized' | 'validated-raw'

export interface WorkbenchRepoRenderOptions {
  /**
   * Canonical seed inputs have already passed repository path-safety and
   * collision validation, so their database slug must remain byte-exact in
   * both the project directory and its adjacent identity-bearing contract
   * files. All existing callers retain normalized behavior.
   */
  projectSlugMode?: WorkbenchRepoProjectSlugMode
}

// -- Slug normalization (byte-identical to the CLI's normalizeSlug) ----------

export function normalizeContractSlug(value: string | null | undefined, fallback: string): string {
  const normalized = (value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return normalized || fallback
}

export function defaultWorkbenchRepoName(teamSlug: string): string {
  return `orizu-workbench-${normalizeContractSlug(teamSlug, 'local-team')}`
}

// -- Content builders (copied from packages/cli/src/workspace.ts) ------------

function formatJson(value: Record<string, unknown>): string {
  return `${JSON.stringify(value, null, 2)}\n`
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
- \`orizu.*.json\` manifests for machine-readable ids, commands, and object
  refs.

Use \`orizu --help\`, \`orizu <command> --help\`, and
\`orizu capabilities --json\` to discover exact CLI behavior. Do not duplicate
Orizu runtime behavior in repo scripts; go through the CLI.

Treat Git-tracked files as source/context or explicit snapshots. What is live
in production is answered by Orizu (the DB production label), never by a repo
file. Treat \`.orizu/\`, raw logs, raw transcripts, bulky datasets,
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

// The CLI's appendGitignore writes this header + entries for a fresh file.
function gitignoreContent(entries: string[]): string {
  return `# Orizu workspace policy\n${entries.join('\n')}\n`
}

// ALI-1075 / ADR-007: manifests carry machine-readable ids only. The old
// `canonical`/`repoState` liveness fields are no longer emitted — the DB
// production label is the sole production pointer. Legacy manifests that
// still contain them are tolerated (ignored), never rewritten.
function teamManifest(options: WorkbenchRepoContractOptions): string {
  const teamSlug = normalizeContractSlug(options.teamSlug, 'local-team')
  const attachWorkspaceId = options.attachWorkspaceId ?? null
  return formatJson({
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    kind: 'team',
    slug: teamSlug,
    teamId: options.teamId ?? null,
    serviceOrigin: options.serviceOrigin ?? null,
    defaultObjectStore: {
      provider: 'supabase',
      bucket: 'orizu-artifacts',
    },
    setup: {
      setupVersion: WORKSPACE_SETUP_VERSION,
      createdBy: options.createdBy ?? 'orizu setup',
      createdAt: options.createdAt ?? new Date().toISOString(),
      cliVersion: options.cliVersion ?? null,
      attachedWorkspaceId: attachWorkspaceId,
    },
  })
}

function projectManifest(teamSlug: string, project: WorkbenchRepoProjectSeed): string {
  return formatJson({
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    kind: 'project',
    slug: project.slug,
    name: project.name || null,
    projectId: project.id || null,
    teamSlug,
    sourceRepos: [],
  })
}

/**
 * Render the full contract as committable files for a freshly provisioned repo.
 * Deterministic given its options (except `createdAt`, which defaults to now).
 */
export function buildWorkbenchRepoFiles(
  options: WorkbenchRepoContractOptions,
  renderOptions: WorkbenchRepoRenderOptions = {}
): WorkbenchRepoFile[] {
  const teamSlug = normalizeContractSlug(options.teamSlug, 'local-team')
  const seenSlugs = new Set<string>()
  const projects = options.projects
    .map((project) => {
      const normalizedSlug = normalizeContractSlug(project.slug, 'local-project')
      const directorySlug =
        renderOptions.projectSlugMode === 'validated-raw' ? project.slug : normalizedSlug
      return {
        directorySlug,
        slug: directorySlug,
        id: project.id || null,
        name: project.name || null,
      }
    })
    .filter((project) => {
      if (seenSlugs.has(project.directorySlug)) return false
      seenSlugs.add(project.directorySlug)
      return true
    })

  const files: WorkbenchRepoFile[] = []

  // Root contract files.
  files.push({ path: 'README.md', content: rootReadme(teamSlug) })
  files.push({
    path: 'orizu.team.json',
    content: teamManifest({ ...options, teamSlug }),
  })
  files.push({ path: 'AGENTS.md', content: AGENTS_MD })
  files.push({ path: 'CLAUDE.md', content: CLAUDE_POINTER })
  files.push({ path: 'Memory.md', content: MEMORY_MD })
  files.push({
    path: '.gitignore',
    content: gitignoreContent(ROOT_GITIGNORE_ENTRIES),
  })

  // Empty root dirs kept alive across clone.
  for (const dir of EMPTY_ROOT_DIRS) {
    files.push({ path: `${dir}/.gitkeep`, content: '' })
  }

  // Per-project stubs.
  for (const project of projects) {
    const base = `projects/${project.directorySlug}`
    files.push({
      path: `${base}/README.md`,
      content: projectReadme(project.slug),
    })
    files.push({ path: `${base}/memory.md`, content: PROJECT_MEMORY_MD })
    files.push({
      path: `${base}/orizu.project.json`,
      content: projectManifest(teamSlug, project),
    })
    files.push({
      path: `${base}/.gitignore`,
      content: gitignoreContent(PROJECT_GITIGNORE_ENTRIES),
    })
    for (const dir of PROJECT_PRIMITIVE_DIRS) {
      files.push({ path: `${base}/${dir}/.gitkeep`, content: '' })
    }
  }

  return files
}
