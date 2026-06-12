import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'

export const WORKSPACE_DIR_NAME = '.orizu'

export interface WorkspaceInitOptions {
  cwd?: string
  baseUrl?: string | null
  cliVersion?: string | null
  dryRun?: boolean
}

export interface WorkspaceInitResult {
  root: string
  state: 'created' | 'exists' | 'would-create'
  gitignoreUpdated: boolean
  actions: string[]
}

const WORKSPACE_README = `# Orizu workspace

Local Orizu artifacts for this repository. This folder is gitignored by
default: generated and server-derived content here is not guaranteed to stay
in sync with the Orizu server, so checking it in would risk drift. Safe,
user-authored configuration may move to a committed location once a sync model
exists.

- \`workspace.json\`: safe local metadata (no secrets; credentials stay in
  \`~/.config/orizu\`).
- \`generated/\`: runner artifacts, exports, and other generated files.
`

export function getWorkspaceRoot(cwd?: string): string {
  return resolve(cwd || process.cwd(), WORKSPACE_DIR_NAME)
}

export function workspaceExists(cwd?: string): boolean {
  return existsSync(join(getWorkspaceRoot(cwd), 'workspace.json'))
}

function ensureGitignoreEntry(cwd: string, dryRun: boolean): { updated: boolean, action: string | null } {
  const gitignorePath = resolve(cwd, '.gitignore')
  const entry = `${WORKSPACE_DIR_NAME}/`

  if (existsSync(gitignorePath)) {
    const existing = readFileSync(gitignorePath, 'utf8')
    const hasEntry = existing
      .split('\n')
      .some(line => line.trim() === entry || line.trim() === WORKSPACE_DIR_NAME)
    if (hasEntry) {
      return { updated: false, action: null }
    }
    if (!dryRun) {
      const separator = existing.endsWith('\n') || existing.length === 0 ? '' : '\n'
      writeFileSync(gitignorePath, `${existing}${separator}\n# Local Orizu workspace (generated; not synced with the server)\n${entry}\n`, 'utf8')
    }
    return { updated: true, action: `append ${entry} to .gitignore` }
  }

  if (!dryRun) {
    writeFileSync(gitignorePath, `# Local Orizu workspace (generated; not synced with the server)\n${entry}\n`, 'utf8')
  }
  return { updated: true, action: `create .gitignore with ${entry}` }
}

export function initOrizuWorkspace(options?: WorkspaceInitOptions): WorkspaceInitResult {
  const cwd = resolve(options?.cwd || process.cwd())
  const root = getWorkspaceRoot(cwd)
  const dryRun = Boolean(options?.dryRun)
  const exists = workspaceExists(cwd)
  const actions: string[] = []

  if (!exists) {
    actions.push(`create ${WORKSPACE_DIR_NAME}/workspace.json, README.md, and generated/`)
  }

  const gitignore = ensureGitignoreEntry(cwd, dryRun || exists)
  if (!exists && gitignore.action) {
    actions.push(gitignore.action)
  }

  if (dryRun) {
    return {
      root,
      state: exists ? 'exists' : 'would-create',
      gitignoreUpdated: false,
      actions,
    }
  }

  if (exists) {
    return { root, state: 'exists', gitignoreUpdated: false, actions: [] }
  }

  mkdirSync(join(root, 'generated'), { recursive: true })
  writeFileSync(join(root, 'README.md'), WORKSPACE_README, 'utf8')
  writeFileSync(
    join(root, 'workspace.json'),
    `${JSON.stringify(
      {
        version: 1,
        server: options?.baseUrl || null,
        createdByCliVersion: options?.cliVersion || null,
      },
      null,
      2
    )}\n`,
    'utf8'
  )

  return { root, state: 'created', gitignoreUpdated: gitignore.updated, actions }
}
