// Shared helpers for plugin packaging scripts.
//
// The skill content hash here MUST stay in sync with computeSkillContentHash
// in packages/cli/src/skill-installer.ts (same exclusions, same digest input)
// so the CLI, local skill installs, and plugin bundles can compare hashes.
import { createHash } from 'crypto'
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
} from 'fs'
import { dirname, join, relative, resolve } from 'path'
import { fileURLToPath } from 'url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const SKILL_NAME = 'orizu-cli'
export const SKILL_SOURCE_DIR = join(REPO_ROOT, 'skills', SKILL_NAME)
export const SKILL_META_FILENAME = '.orizu-skill-meta.json'
export const PLUGINS_DIST_DIR = join(REPO_ROOT, 'dist', 'plugins')

export const PLUGIN_PACKAGES = [
  {
    id: 'codex',
    root: join(REPO_ROOT, 'plugins', 'codex'),
    manifest: join(REPO_ROOT, 'plugins', 'codex', '.codex-plugin', 'plugin.json'),
  },
  {
    id: 'claude-code',
    root: join(REPO_ROOT, 'plugins', 'claude-code'),
    manifest: join(REPO_ROOT, 'plugins', 'claude-code', '.claude-plugin', 'plugin.json'),
  },
]

export function shouldIncludeSkillPath(rel) {
  if (!rel) {
    return true
  }
  const parts = rel.split('/')
  return !parts.some(part =>
    part === '.DS_Store' ||
    part === '__pycache__' ||
    part === '.pytest_cache' ||
    part === SKILL_META_FILENAME
  ) && !rel.endsWith('.pyc') && !rel.endsWith('.pyo')
}

function listSkillFiles(root, dir, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name)
    const rel = relative(root, entryPath).replace(/\\/g, '/')
    if (!shouldIncludeSkillPath(rel)) {
      continue
    }
    if (entry.isDirectory()) {
      listSkillFiles(root, entryPath, files)
    } else if (entry.isFile()) {
      files.push(rel)
    }
  }
}

export function computeSkillContentHash(root) {
  const files = []
  listSkillFiles(root, root, files)
  const hash = createHash('sha256')
  for (const rel of files.sort()) {
    hash.update(rel)
    hash.update('\0')
    hash.update(readFileSync(join(root, rel)))
    hash.update('\0')
  }
  return `sha256:${hash.digest('hex')}`
}

export function copySkillTree(sourceDir, targetDir) {
  cpSync(sourceDir, targetDir, {
    recursive: true,
    filter: sourcePath => {
      const rel = relative(sourceDir, sourcePath).replace(/\\/g, '/')
      return shouldIncludeSkillPath(rel)
    },
  })
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function getCliVersion() {
  const packageJson = readJson(join(REPO_ROOT, 'packages', 'cli', 'package.json'))
  if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
    throw new Error('Unable to read packages/cli version.')
  }
  return packageJson.version
}

export function assertSkillSourceExists() {
  if (!existsSync(join(SKILL_SOURCE_DIR, 'SKILL.md'))) {
    throw new Error(`Shared skill source not found at ${SKILL_SOURCE_DIR}`)
  }
}

export function fail(message) {
  console.error(`error: ${message}`)
  process.exit(1)
}
