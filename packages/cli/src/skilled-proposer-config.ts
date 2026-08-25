import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename, dirname, extname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

interface NormalizedTextSource { source: string, content: string, sha256: string, byteLength: number }
interface NormalizedSkill extends NormalizedTextSource { name: string, description: string | null }

const CONFIG_KEYS = new Set(['schemaVersion', 'skills', 'additionalInstructionsFile', 'baseInstructionsFile',
  'maxWords', 'maxTokens', 'maxExamples', 'onError',
])
const PATH_SKILL_KEYS = new Set(['path', 'name', 'description'])
const INLINE_SKILL_KEYS = new Set(['name', 'description', 'inline'])

function configError(field: string, detail: string): never { throw new Error(`--candidate-proposer-config ${field} ${detail}`) }
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function rejectUnknownKeys(value: Record<string, unknown>, allowed: Set<string>, field = ''): void {
  const unknown = Object.keys(value).find(key => !allowed.has(key))
  if (unknown) configError(field ? `${field}.${unknown}` : unknown, 'is not supported')
}
function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
function decodeUtf8(bytes: Uint8Array, field: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    configError(field, 'must contain valid UTF-8 text')
  }
}
function readRegularFile(path: string, field: string): Buffer {
  try {
    if (!statSync(path).isFile()) configError(field, 'must resolve to a file')
    return readFileSync(path)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('--candidate-proposer-config')) throw error
    configError(field, `is missing or unreadable: ${error instanceof Error ? error.message : String(error)}`)
  }
}
function logicalSource(configDirectory: string, path: string): string {
  return relative(configDirectory, path).split(sep).join('/') || basename(path)
}
function normalizedText(bytes: Buffer, source: string, field: string): NormalizedTextSource {
  const content = decodeUtf8(bytes, field)
  if (!content.trim()) configError(field, 'must not be empty')
  return { source, content, sha256: sha256(bytes), byteLength: bytes.byteLength }
}
function parseFrontmatter(content: string, field: string): { name?: string, description?: string, body: string } {
  const lines = content.split(/\r?\n/)
  if (lines[0]?.replace(/^\uFEFF/, '').trim() !== '---') return { body: content }
  const end = lines.slice(1).findIndex(line => line.trim() === '---')
  if (end < 0) configError(field, 'has malformed frontmatter without a closing ---')
  const metadata: Record<string, string> = {}
  for (const raw of lines.slice(1, end + 1)) {
    if (/^[ \t]/.test(raw) || !raw.includes(':')) continue
    const colon = raw.indexOf(':')
    metadata[raw.slice(0, colon).trim()] = raw.slice(colon + 1).trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  return {
    name: metadata.name || undefined,
    description: metadata.description || undefined,
    body: lines.slice(end + 2).join('\n'),
  }
}
function wellFormedString(value: string, field: string): string {
  if (!(value as string & { isWellFormed(): boolean }).isWellFormed()) {
    configError(field, 'must contain well-formed Unicode text')
  }
  return value
}
function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) configError(field, 'must be a non-empty string')
  return wellFormedString(value, field)
}
function nullableDescription(value: unknown, field: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string') configError(field, 'must be a string or null')
  return wellFormedString(value, field) || null
}
function normalizePathSkill(entry: Record<string, unknown>, index: number, configDirectory: string): NormalizedSkill {
  const field = `skills[${index}]`
  rejectUnknownKeys(entry, PATH_SKILL_KEYS, field)
  const configuredPath = nonEmptyString(entry.path, `${field}.path`)
  let resolvedPath = resolve(configDirectory, configuredPath)
  try {
    if (statSync(resolvedPath).isDirectory()) {
      resolvedPath = resolve(resolvedPath, 'SKILL.md')
      try {
        if (!statSync(resolvedPath).isFile()) configError(`${field}.path`, 'directory must contain SKILL.md')
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('--candidate-proposer-config')) throw error
        configError(`${field}.path`, 'directory must contain SKILL.md')
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('--candidate-proposer-config')) throw error
    configError(`${field}.path`, 'is missing or unreadable')
  }
  const text = normalizedText(readRegularFile(resolvedPath, `${field}.path`),
    logicalSource(configDirectory, resolvedPath), `${field}.path`)
  const frontmatter = parseFrontmatter(text.content, `${field}.path`)
  if (!frontmatter.body.trim()) configError(`${field}.path`, 'must contain non-empty skill content')
  const fallbackName = extname(resolvedPath)
    ? basename(resolvedPath, extname(resolvedPath))
    : basename(resolvedPath)
  const name = entry.name === undefined
    ? frontmatter.name ?? (basename(resolvedPath) === 'SKILL.md' ? basename(dirname(resolvedPath)) : fallbackName)
    : nonEmptyString(entry.name, `${field}.name`)
  const description = entry.description === undefined
    ? frontmatter.description ?? null
    : nullableDescription(entry.description, `${field}.description`)
  return { name, description, ...text }
}
function normalizeInlineSkill(entry: Record<string, unknown>, index: number): NormalizedSkill {
  const field = `skills[${index}]`
  rejectUnknownKeys(entry, INLINE_SKILL_KEYS, field)
  const name = nonEmptyString(entry.name, `${field}.name`)
  const description = nonEmptyString(entry.description, `${field}.description`)
  const content = nonEmptyString(entry.inline, `${field}.inline`)
  const bytes = Buffer.from(content, 'utf8')
  return { name, description, source: `inline:${name}`, content,
    sha256: sha256(bytes), byteLength: bytes.byteLength }
}
function normalizeSkill(value: unknown, index: number, configDirectory: string): NormalizedSkill {
  const field = `skills[${index}]`
  if (!isRecord(value)) configError(field, 'must be an object')
  const hasPath = Object.hasOwn(value, 'path')
  const hasInline = Object.hasOwn(value, 'inline')
  if (hasPath === hasInline) configError(field, 'must contain exactly one of path or inline')
  return hasPath ? normalizePathSkill(value, index, configDirectory) : normalizeInlineSkill(value, index)
}
function optionalPositiveInteger(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null
  if (!Number.isSafeInteger(value) || (value as number) <= 0) configError(field, 'must be a positive integer or null')
  return value as number
}
function normalizeInstructionFile(value: unknown, field: string, configDirectory: string): NormalizedTextSource | null {
  if (value === undefined || value === null) return null
  const configuredPath = nonEmptyString(value, field)
  const resolvedPath = resolve(configDirectory, configuredPath)
  return normalizedText(readRegularFile(resolvedPath, field), logicalSource(configDirectory, resolvedPath), field)
}
function lockedPackageVersion(): string {
  const lockPath = fileURLToPath(new URL('../requirements/skilled-proposer.lock', import.meta.url))
  const match = /^skilled-proposer==([^\s\\]+)/m.exec(readFileSync(lockPath, 'utf8'))
  if (!match) throw new Error('ALI_1505_SKILLED_PROPOSER_LOCK_VERSION_MISSING')
  return match[1]
}
export function normalizedSkilledProposerConfig(value: string): string {
  const suppliedPath = nonEmptyString(value.startsWith('@') ? value.slice(1) : value, 'path')
  const configPath = resolve(suppliedPath)
  const configBytes = readRegularFile(configPath, 'path')
  const raw = decodeUtf8(configBytes, 'path').replace(/^\uFEFF/, '')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    configError('path', `must contain valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isRecord(parsed)) configError('path', 'must contain a JSON object')
  rejectUnknownKeys(parsed, CONFIG_KEYS)
  if (parsed.schemaVersion !== 1) configError('schemaVersion', 'must be 1')
  if (!Array.isArray(parsed.skills)) configError('skills', 'must be an array')

  const configDirectory = dirname(configPath)
  const skills = parsed.skills.map((skill, index) => normalizeSkill(skill, index, configDirectory))
  const names = new Set<string>()
  for (const skill of skills) {
    if (names.has(skill.name)) configError('skills', `contains duplicate resolved name ${skill.name}`)
    names.add(skill.name)
  }
  const onError = parsed.onError ?? 'keep'
  if (onError !== 'keep' && onError !== 'raise') configError('onError', 'must be keep or raise')

  const normalized = {
    schemaVersion: 1,
    implementation: 'cmpnd-ai/skilled-proposer',
    packageVersion: lockedPackageVersion(),
    skills,
    additionalInstructions: normalizeInstructionFile(parsed.additionalInstructionsFile,
      'additionalInstructionsFile', configDirectory),
    baseInstructions: normalizeInstructionFile(parsed.baseInstructionsFile, 'baseInstructionsFile', configDirectory),
    maxWords: optionalPositiveInteger(parsed.maxWords, 'maxWords'),
    maxTokens: optionalPositiveInteger(parsed.maxTokens, 'maxTokens'),
    maxExamples: optionalPositiveInteger(parsed.maxExamples, 'maxExamples'),
    onError,
  }
  const configFileSha256 = sha256(configBytes)
  const configSha256 = sha256(Buffer.from(JSON.stringify({ configFileSha256, ...normalized }), 'utf8'))
  return JSON.stringify({ ...normalized, configFileSha256, configSha256 })
}
