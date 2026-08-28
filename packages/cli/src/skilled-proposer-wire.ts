import { createHash } from 'node:crypto'
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const orderedRecord = (value: unknown, keys: string[]): Record<string, unknown> | undefined => isRecord(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) ? Object.fromEntries(keys.map(key => [key, value[key]])) : undefined
export function validNormalizedSkilledProposerConfig(value: unknown): boolean {
  if (!isRecord(value)) return false
  const { configSha256, ...fields } = value
  const keys = ['configFileSha256', 'schemaVersion', 'implementation', 'packageVersion', 'skills',
    'additionalInstructions', 'baseInstructions', 'maxWords', 'maxTokens', 'maxExamples', 'onError']
  if (typeof configSha256 !== 'string' || Object.keys(fields).length !== keys.length
    || keys.some(key => !Object.hasOwn(fields, key))) return false
  if (!Array.isArray(fields.skills)) return false
  const skills = fields.skills.map(skill => orderedRecord(skill, ['name', 'description', 'source', 'content', 'sha256', 'byteLength']))
  const sourceKeys = ['source', 'content', 'sha256', 'byteLength']
  const additionalInstructions = fields.additionalInstructions === null ? null : orderedRecord(fields.additionalInstructions, sourceKeys)
  const baseInstructions = fields.baseInstructions === null ? null : orderedRecord(fields.baseInstructions, sourceKeys)
  if (skills.some(skill => skill === undefined) || additionalInstructions === undefined || baseInstructions === undefined) return false
  const normalized: Record<string, unknown> = { ...fields, skills, additionalInstructions, baseInstructions }
  const canonical = Object.fromEntries(keys.map(key => [key, normalized[key]]))
  return createHash('sha256').update(Buffer.from(JSON.stringify(canonical), 'utf8')).digest('hex') === configSha256
}
