import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const cliRoot = resolve(scriptDir, '..')
const repoRoot = resolve(cliRoot, '..', '..')
const sourceRoot = resolve(repoRoot, 'skills', 'orizu-cli')
const vendorRoot = resolve(cliRoot, 'vendor', 'skills', 'orizu-cli')
const shouldClean = process.argv.includes('--clean')
const hasSourceSkill = existsSync(resolve(sourceRoot, 'SKILL.md'))
const hasVendoredSkill = existsSync(resolve(vendorRoot, 'SKILL.md'))

function isSafeRelativeSkillPath(rel) {
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)
}

function shouldCopyPath(sourcePath) {
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

if (shouldClean) {
  if (hasSourceSkill) {
    rmSync(vendorRoot, { recursive: true, force: true })
  }
  process.exit(0)
}

if (!hasSourceSkill) {
  if (hasVendoredSkill) {
    process.exit(0)
  }
  throw new Error(`Unable to vendor orizu-cli skill: source skill not found at ${sourceRoot}`)
}

rmSync(vendorRoot, { recursive: true, force: true })
mkdirSync(vendorRoot, { recursive: true })
cpSync(sourceRoot, vendorRoot, {
  recursive: true,
  filter: shouldCopyPath,
})
