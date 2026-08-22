import { authedFetch } from './http.js'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface InstructionSetsCommandIo {
  json: boolean
  print: (line: string) => void
  resolveProjectSlug: (provided: string | null) => Promise<string>
}

function positionalArgs(args: string[]): string[] {
  const values: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!
    if (value.startsWith('--')) {
      if (argValue(args, value) !== null) index += 1
      continue
    }
    values.push(value)
  }
  return values
}

function argValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag)
  return index === -1 || !args[index + 1] || args[index + 1]!.startsWith('--')
    ? null
    : args[index + 1]!
}

async function responsePayload(response: Response, action: string): Promise<Record<string, unknown>> {
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) {
    throw new Error(`${action} failed (${response.status}): ${typeof payload.error === 'string' ? payload.error : response.statusText}`)
  }
  return payload
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/u
interface SyncComponent { body?: string; repoPath?: string; contentSha?: string; commitSha?: string }
interface SyncMaterial { profileVersionId: string; versionNumber: number; modelConfigIdentity: string; resolvedFrom: string; components: Record<string, SyncComponent> }
interface SyncProfile { modelConfigIdentity: string; resolvedFrom: string; production: SyncMaterial | null }
interface SyncSet { name: string; shape: string[]; default: SyncMaterial; profiles: SyncProfile[]; filteredTo?: string[] }
function safeSegment(value: string) { if (!SAFE_SEGMENT.test(value) || value === '.' || value === '..' || value.startsWith('.')) throw new Error('instruction_set_path_unsafe') }
function slug(identity: string) { return identity.replaceAll('/', '__').replace(/[^A-Za-z0-9._-]/gu, '_') }
function stable(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n` }

export interface SyncFileOps { writeFileSync: typeof writeFileSync; renameSync?: typeof renameSync }

function writeMaterial(root: string, material: SyncMaterial, shape: string[], manifestRoot: string, fileOps: SyncFileOps = { writeFileSync }) {
  const files: Record<string, string> = {}
  const pinnedComponents: Record<string, unknown> = {}
  for (const key of [...shape].sort()) {
    safeSegment(key)
    const component = material.components[key]
    if (typeof component?.body === 'string') {
      const relative = `${manifestRoot}/${key}.md`
      files[key] = relative
      const target = join(root, ...relative.split('/'))
      mkdirSync(join(target, '..'), { recursive: true })
      fileOps.writeFileSync(target, component.body)
    } else if (component?.repoPath && component?.contentSha && component?.commitSha) pinnedComponents[key] = { repoPath: component.repoPath, contentSha: component.contentSha, commitSha: component.commitSha }
    else throw new Error('instruction_set_unresolvable')
  }
  return { profileVersionId: material.profileVersionId, versionNumber: material.versionNumber, modelConfigIdentity: material.modelConfigIdentity, resolvedFrom: material.resolvedFrom, files, ...(Object.keys(pinnedComponents).length ? { pinnedComponents } : {}) }
}

// Only the scratch paths THIS run created are ever removed; a user's own
// `.<set>.*.bak` in --out is never touched (PR #1668 review).
function removeOwnScratch(paths: Array<string | null>) {
  for (const path of paths) if (path && existsSync(path)) rmSync(path, { recursive: true, force: true })
}

function existingDestinationIsSynced(destination: string, name: string) {
  try {
    if (!statSync(destination).isDirectory()) return false
    const manifest = JSON.parse(readFileSync(join(destination, 'manifest.json'), 'utf8')) as { manifestVersion?: number; name?: string }
    return manifest.manifestVersion === 1 && manifest.name === name
  } catch { return false }
}

export function syncToDisk(out: string, set: SyncSet, fileOps: SyncFileOps = { writeFileSync }) {
  safeSegment(set.name)
  for (const key of set.shape) safeSegment(key)
  const profileSlugs = new Set<string>()
  for (const profile of set.profiles) {
    const value = slug(profile.modelConfigIdentity)
    safeSegment(value)
    if (profileSlugs.has(value)) throw new Error('instruction_set_slug_collision')
    profileSlugs.add(value)
  }
  mkdirSync(out, { recursive: true })
  const destination = join(out, set.name)
  if (existsSync(destination) && !existingDestinationIsSynced(destination, set.name)) throw new Error('instruction_set_sync_destination_not_synced')
  const temp = join(out, `.${set.name}.${randomUUID()}.tmp`)
  const move = fileOps.renameSync || renameSync
  let backup: string | null = null
  mkdirSync(temp)
  try {
    const defaultMaterial = writeMaterial(temp, set.default, set.shape, 'default', fileOps)
    const profiles = set.profiles.map(profile => ({
      modelConfigIdentity: profile.modelConfigIdentity, slug: slug(profile.modelConfigIdentity), resolvedFrom: profile.resolvedFrom,
      production: profile.production ? writeMaterial(temp, profile.production, set.shape, `profiles/${slug(profile.modelConfigIdentity)}`, fileOps) : null,
    })).sort((a, b) => a.modelConfigIdentity.localeCompare(b.modelConfigIdentity))
    const manifest = { manifestVersion: 1, name: set.name, shape: set.shape, default: defaultMaterial, profiles, ...(set.filteredTo ? { filteredTo: [...set.filteredTo].sort() } : {}) }
    fileOps.writeFileSync(join(temp, 'manifest.json'), stable(manifest))
    backup = join(out, `.${set.name}.${randomUUID()}.bak`)
    if (existsSync(destination)) move(destination, backup)
    try { move(temp, destination) } catch (error) { if (existsSync(backup)) move(backup, destination); throw error }
    removeOwnScratch([backup])
  } catch (error) {
    removeOwnScratch([temp])
    if (backup && existsSync(backup) && !existsSync(destination)) move(backup, destination)
    removeOwnScratch([backup])
    throw error
  }
}

export async function instructionSetsCommand(args: string[], io: InstructionSetsCommandIo): Promise<number> {
  const [subcommand, reference] = positionalArgs(args)
  const project = await io.resolveProjectSlug(argValue(args, '--project'))
  const status = argValue(args, '--status') || 'active'
  if (subcommand !== 'list' && subcommand !== 'show' && subcommand !== 'sync') throw new Error('Usage: instruction-sets list|show|sync')
  if (subcommand === 'sync') {
    const output = argValue(args, '--out')
    if (!reference || !output) throw new Error('Usage: instruction-sets sync <set> --out <dir> --project <team/project> [--model-config <identity>] [--json]')
    const modelConfig = argValue(args, '--model-config')
    const path = `/api/cli/instruction-sets/${encodeURIComponent(reference)}/sync?project=${encodeURIComponent(project)}${modelConfig ? `&modelConfig=${encodeURIComponent(modelConfig)}` : ''}`
    const payload = await responsePayload(await authedFetch(path, { method: 'GET' }), 'Instruction sets sync')
    const set = payload.instructionSet as SyncSet
    if (!set || set.name !== reference || (modelConfig && (!Array.isArray(set.filteredTo) || set.filteredTo.length !== 1 || set.filteredTo[0] !== modelConfig))) {
      throw new Error('instruction_set_sync_response_mismatch')
    }
    syncToDisk(output, set)
    if (io.json) io.print(JSON.stringify(payload)); else io.print(`Synced ${set.name} to ${join(output, set.name)}`)
    return 0
  }
  if (subcommand === 'show' && (!reference || reference.startsWith('--'))) throw new Error('Instruction set name is required')
  if (status !== 'active' && status !== 'archived' && status !== 'all') throw new Error('--status must be active, archived, or all')

  const query = `project=${encodeURIComponent(project)}&status=${encodeURIComponent(status)}`
  const path = subcommand === 'list'
    ? `/api/cli/instruction-sets?${query}`
    : `/api/cli/instruction-sets/${encodeURIComponent(reference!)}?${query}`
  const payload = await responsePayload(await authedFetch(path, { method: 'GET' }), `Instruction sets ${subcommand}`)
  if (io.json) {
    io.print(JSON.stringify(payload))
    return 0
  }
  if (subcommand === 'list') {
    const sets = Array.isArray(payload.instructionSets) ? payload.instructionSets : []
    for (const item of sets) {
      const set = item as { name?: string; shape?: string[]; status?: string }
      io.print(`${set.name || 'unnamed'}${set.status === 'archived' ? ' [archived]' : ''}${set.shape ? ` (${set.shape.join(', ')})` : ''}`)
    }
    return 0
  }
  const set = payload.instructionSet as { name?: string; shape?: string[]; status?: string; default?: { versionNumber?: number } | null; profiles?: Array<{ modelConfigIdentity?: string | null; production?: { versionNumber?: number } | null; latestVersionNumber?: number | null }> } | undefined
  io.print(`${set?.name || reference}${set?.status === 'archived' ? ' [archived]' : ''}: ${set?.shape?.join(', ') || ''}`)
  if (set?.default) io.print(`Default: v${set.default.versionNumber ?? '?'}`)
  for (const profile of set?.profiles || []) {
    io.print(`${profile.modelConfigIdentity || 'unspecified'}: production ${profile.production ? `v${profile.production.versionNumber}` : '—'}, latest ${profile.latestVersionNumber ?? '—'}`)
  }
  return 0
}
