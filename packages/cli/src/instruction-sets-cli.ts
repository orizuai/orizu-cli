import { authedFetch } from './http.js'
import { loadInstructionSetManifest, MAX_INSTRUCTION_SET_COMPONENT_BYTES, type InstructionSetManifest } from './instruction-set-manifest.js'
import { sanitizeHumanInlineText, sanitizeTerminalText } from './json-response.js'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

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
export interface SyncComponent { body?: string; repoPath?: string; contentSha?: string; commitSha?: string }
export interface SyncMaterial { profileVersionId: string; versionNumber: number; modelConfigIdentity: string; resolvedFrom: string; components: Record<string, SyncComponent> }
export interface SyncProfile { modelConfigIdentity: string; resolvedFrom: string; production: SyncMaterial | null }
export interface SyncSet {
  projectId?: string
  instructionSetId?: string
  name: string
  slug?: string
  description?: string | null
  shape: string[]
  default: SyncMaterial
  profiles: SyncProfile[]
  filteredTo?: string[]
}
function safeSegment(value: string) { if (!SAFE_SEGMENT.test(value) || value === '.' || value === '..' || value.startsWith('.')) throw new Error('instruction_set_path_unsafe') }
function isSafeSegment(value: string) {
  try { safeSegment(value); return true } catch { return false }
}
function slug(identity: string) { return identity.replaceAll('/', '__').replace(/[^A-Za-z0-9._-]/gu, '_') }
function stable(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n` }
function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }

export interface SyncFileOps {
  writeFileSync: typeof writeFileSync
  renameSync?: typeof renameSync
  rmSync?: typeof rmSync
}

function writeMaterial(root: string, material: SyncMaterial, shape: string[], manifestRoot: string, fileOps: SyncFileOps = { writeFileSync }) {
  const files: Record<string, string> = {}
  const syncedContentSha256: Record<string, string> = {}
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
      syncedContentSha256[key] = sha256(component.body)
    } else if (component?.repoPath && component?.contentSha && component?.commitSha) pinnedComponents[key] = { repoPath: component.repoPath, contentSha: component.contentSha, commitSha: component.commitSha }
    else throw new Error('instruction_set_unresolvable')
  }
  return { profileVersionId: material.profileVersionId, versionNumber: material.versionNumber, modelConfigIdentity: material.modelConfigIdentity, resolvedFrom: material.resolvedFrom, files, syncedContentSha256, ...(Object.keys(pinnedComponents).length ? { pinnedComponents } : {}) }
}

// Only the scratch paths THIS run created are ever removed; a user's own
// `.<set>.*.bak` in --out is never touched (PR #1668 review).
function removeOwnScratch(paths: Array<string | null>) {
  for (const path of paths) if (path && existsSync(path)) rmSync(path, { recursive: true, force: true })
}

function existingDestinationIsSynced(
  destination: string,
  set: Pick<SyncSet, 'projectId' | 'instructionSetId' | 'name' | 'slug'>
) {
  if (
    set.slug &&
    set.projectId === undefined &&
    set.instructionSetId === undefined
  ) {
    return existingDestinationIsLegacySynced(destination, set.name, set.slug)
  }
  try {
    if (!statSync(destination).isDirectory()) return false
    const manifest = JSON.parse(readFileSync(join(destination, 'manifest.json'), 'utf8')) as {
      manifestVersion?: number
      projectId?: string
      instructionSetId?: string
      name?: string
      slug?: string
    }
    return manifest.manifestVersion === 1 && (set.slug
      ? manifest.slug === set.slug &&
        manifest.projectId === set.projectId &&
        manifest.instructionSetId === set.instructionSetId
      : manifest.name === set.name)
  } catch { return false }
}

function existingDestinationIsLegacySynced(
  destination: string,
  name: string,
  slug?: string
) {
  try {
    if (!statSync(destination).isDirectory()) return false
    const manifest = JSON.parse(readFileSync(join(destination, 'manifest.json'), 'utf8')) as {
      manifestVersion?: number
      name?: string
      slug?: string
    }
    return manifest.manifestVersion === 1 &&
      manifest.name === name &&
      manifest.slug === slug
  } catch { return false }
}

function removePublishedBackups(
  paths: string[],
  remove: typeof rmSync
) {
  let firstError: unknown = null
  for (const path of paths) {
    if (!existsSync(path)) continue
    try {
      remove(path, { recursive: true, force: true })
    } catch (error) {
      firstError ??= error
    }
  }
  if (firstError) throw new Error('instruction_set_sync_cleanup_failed')
}

export function syncToDisk(out: string, set: SyncSet, fileOps: SyncFileOps = { writeFileSync }) {
  const directoryName = set.slug || set.name
  safeSegment(directoryName)
  const hasProjectId = set.projectId !== undefined
  const hasInstructionSetId = set.instructionSetId !== undefined
  if (set.slug && hasProjectId !== hasInstructionSetId) {
    throw new Error('instruction_set_sync_identity_missing')
  }
  for (const key of set.shape) safeSegment(key)
  const profileSlugs = new Set<string>()
  for (const profile of set.profiles) {
    const value = slug(profile.modelConfigIdentity)
    safeSegment(value)
    if (profileSlugs.has(value)) throw new Error('instruction_set_slug_collision')
    profileSlugs.add(value)
  }
  mkdirSync(out, { recursive: true })
  const destination = join(out, directoryName)
  const legacyDestination = set.slug && set.name !== set.slug && isSafeSegment(set.name)
    ? join(out, set.name)
    : null
  if (existsSync(destination)) {
    if (set.slug && existingDestinationIsLegacySynced(destination, set.name)) {
      throw new Error('instruction_set_sync_legacy_identity_required')
    }
    if (!existingDestinationIsSynced(destination, set)) {
      throw new Error('instruction_set_sync_destination_not_synced')
    }
  }
  if (legacyDestination && existsSync(legacyDestination)) {
    if (existingDestinationIsLegacySynced(legacyDestination, set.name)) {
      throw new Error('instruction_set_sync_legacy_identity_required')
    }
    throw new Error('instruction_set_sync_destination_not_synced')
  }
  const priorDestinations = [destination]
  const temp = join(out, `.${directoryName}.${randomUUID()}.tmp`)
  const move = fileOps.renameSync || renameSync
  const backups: Array<{ original: string; backup: string }> = []
  mkdirSync(temp)
  try {
    const defaultMaterial = writeMaterial(temp, set.default, set.shape, 'default', fileOps)
    const profiles = set.profiles.map(profile => ({
      modelConfigIdentity: profile.modelConfigIdentity, slug: slug(profile.modelConfigIdentity), resolvedFrom: profile.resolvedFrom,
      production: profile.production ? writeMaterial(temp, profile.production, set.shape, `profiles/${slug(profile.modelConfigIdentity)}`, fileOps) : null,
    })).sort((a, b) => a.modelConfigIdentity.localeCompare(b.modelConfigIdentity))
    const components = [
      ...Object.entries(defaultMaterial.files).map(([key, path]) => ({ key, path, syncedContentSha256: defaultMaterial.syncedContentSha256[key] })),
      ...profiles.flatMap(profile => profile.production
        ? Object.entries(profile.production.files).map(([key, path]) => ({ key, modelConfig: profile.modelConfigIdentity, path, syncedContentSha256: profile.production!.syncedContentSha256[key] }))
        : []),
    ]
    const manifest = {
      manifestVersion: 1,
      ...(set.projectId ? { projectId: set.projectId } : {}),
      ...(set.instructionSetId ? { instructionSetId: set.instructionSetId } : {}),
      name: set.name,
      ...(set.slug ? { slug: set.slug } : {}),
      ...(Object.hasOwn(set, 'description') ? { description: set.description ?? null } : {}),
      shape: set.shape,
      components,
      default: defaultMaterial,
      profiles,
      ...(set.filteredTo ? { filteredTo: [...set.filteredTo].sort() } : {}),
    }
    fileOps.writeFileSync(join(temp, 'manifest.json'), stable(manifest))
    for (const prior of priorDestinations) {
      if (!existsSync(prior)) continue
      const backup = join(out, `.${directoryName}.${randomUUID()}.bak`)
      move(prior, backup)
      backups.push({ original: prior, backup })
    }
    move(temp, destination)
  } catch (error) {
    removeOwnScratch([temp])
    for (const { original, backup } of [...backups].reverse()) {
      if (existsSync(backup) && !existsSync(original)) move(backup, original)
    }
    removeOwnScratch(backups.map(entry => entry.backup))
    throw error
  }
  removePublishedBackups(
    backups.map(entry => entry.backup),
    fileOps.rmSync || rmSync
  )
  return destination
}

export async function instructionSetsCommand(args: string[], io: InstructionSetsCommandIo): Promise<number> {
  const positionals = positionalArgs(args)
  const [subcommand, reference] = positionals
  if (subcommand === 'default' && reference === 'move') {
    const version = argValue(args, '--version')
    if (!version || !/^[0-9]+$/u.test(version) || Number(version) < 1) throw new Error('--version must be a positive integer')
  }
  let writeManifest: InstructionSetManifest | undefined
  if (subcommand === 'create' || subcommand === 'push') {
    if (!reference || reference.startsWith('--')) throw new Error(subcommand === 'create'
      ? 'Usage: orizu instructions create <manifest> --project <team/project> [--runner-version <id>] [--model-config <identity>] [--json]'
      : 'Usage: orizu instructions push <manifest> --project <team/project> [--set <slug-or-exact-name>] [--runner-version <id>] [--json]')
    writeManifest = loadInstructionSetManifest(reference)
  }
  const project = await io.resolveProjectSlug(argValue(args, '--project'))
  if (subcommand === 'scorers') {
    const action = reference
    const set = positionals[2]
    const componentKey = argValue(args, '--key')
    const scorerVersionId = argValue(args, '--scorer-version')
    if (
      (action !== 'set-headline' && action !== 'add') ||
      !set ||
      !componentKey ||
      !scorerVersionId
    ) {
      throw new Error(
        'Usage: orizu instructions scorers set-headline|add <set> --key <component-key> --scorer-version <id> --project <team/project> [--dataset-version <id> --split-set <id> --split <name>] [--json]'
      )
    }
    const payload = await responsePayload(await authedFetch(
      `/api/cli/instruction-sets/${encodeURIComponent(set)}/scorers?project=${encodeURIComponent(project)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          componentKey,
          scorerVersionId,
          role: action === 'set-headline' ? 'headline' : 'tracked',
          datasetVersionId: argValue(args, '--dataset-version') || undefined,
          splitSetId: argValue(args, '--split-set') || undefined,
          splitName: argValue(args, '--split') || undefined,
        }),
      }
    ), `Instruction sets scorers ${action}`)
    if (io.json) io.print(JSON.stringify(payload))
    else {
      io.print(
        `${action === 'set-headline' ? 'Set headline' : 'Added'} scorer ${sanitizeTerminalText(scorerVersionId)} for ${sanitizeTerminalText(set)} / ${sanitizeTerminalText(componentKey)}`
      )
    }
    return 0
  }
  if (subcommand === 'default') {
    const operation = reference; const set = positionals[2]; const identity = argValue(args, '--model-config'); const version = argValue(args, '--version')
    if ((operation !== 'show' && operation !== 'move') || !set) throw new Error('Usage: orizu instructions default show|move <set> --project <team/project> [--model-config <identity> --version <n>] [--json]')
    if (operation === 'move' && (!identity || !version || !/^[0-9]+$/u.test(version) || Number(version) < 1)) throw new Error('--version must be a positive integer')
    const path = `/api/cli/instruction-sets/${encodeURIComponent(set)}/default?project=${encodeURIComponent(project)}`
    if (operation === 'show') {
      const payload = await responsePayload(await authedFetch(path, { method: 'GET' }), 'Instruction sets default show')
      if (io.json) io.print(JSON.stringify(payload)); else io.print(`Default: v${(payload.default as { versionNumber?: number } | undefined)?.versionNumber ?? '?'}`)
      return 0
    }
    if (!io.json) {
      const impact = await responsePayload(await authedFetch(path, { method: 'GET' }), 'Instruction sets default show')
      const resolvesToDefault = Array.isArray(impact.resolvesToDefault) ? impact.resolvesToDefault.filter((item): item is string => typeof item === 'string') : []
      io.print(`These model configs resolve to the default: ${resolvesToDefault.join(', ')}`)
    }
    const payload = await responsePayload(await authedFetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelConfigIdentity: identity, versionNumber: Number(version) }) }), 'Instruction sets default move')
    if (io.json) io.print(JSON.stringify(payload)); else io.print(`Default moved to ${identity} v${version}`)
    return 0
  }
  if (subcommand === 'shape') {
    const operation = reference; const set = positionals[2]; const key = argValue(args, '--key'); const from = argValue(args, '--from')
    if ((operation !== 'add' && operation !== 'remove') || !set || !key || (operation === 'add' && !from)) throw new Error('Usage: orizu instructions shape add|remove <set> --project <team/project> --key <key> [--from <manifest>] [--json]')
    let component: { body: string } | undefined
    if (operation === 'add') {
      let manifest: unknown
      try { manifest = JSON.parse(readFileSync(from!, 'utf8')) } catch { throw new Error('instruction_set_manifest_invalid_json') }
      const source = manifest && typeof manifest === 'object' && Array.isArray((manifest as { components?: unknown }).components)
        ? (manifest as { components: unknown[] }).components.find((item): item is { key?: unknown; text?: unknown } => Boolean(item && typeof item === 'object' && (item as { key?: unknown }).key === key))
        : undefined
      if (!source || typeof source.text !== 'string' || Buffer.byteLength(source.text, 'utf8') > MAX_INSTRUCTION_SET_COMPONENT_BYTES) throw new Error(`Instruction set manifest has no component for key: ${key}`)
      component = { body: source.text }
    }
    const payload = await responsePayload(await authedFetch(`/api/cli/instruction-sets/${encodeURIComponent(set)}/shape?project=${encodeURIComponent(project)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation, key, ...(component ? { component } : {}) }) }), `Instruction sets shape ${operation}`)
    if (io.json) io.print(JSON.stringify(payload)); else {
      io.print(`Shape ${operation === 'add' ? 'added' : 'removed'}: ${key}`)
      const affected = Array.isArray(payload.affected) ? payload.affected : []
      const identities = [...new Set(affected.flatMap(pointer => pointer && typeof pointer === 'object' && typeof (pointer as { modelConfigIdentity?: unknown }).modelConfigIdentity === 'string' ? [(pointer as { modelConfigIdentity: string }).modelConfigIdentity] : []))]
      if (identities.length) io.print(`${set} does not resolve for these model configs until the pointers move: ${identities.join(', ')}`)
      for (const pointer of affected) if (pointer && typeof pointer === 'object') {
        const item = pointer as { modelConfigIdentity?: unknown; pointer?: unknown; stalePointerVersionNumber?: unknown; headVersionNumber?: unknown; branchedFromVersionNumber?: unknown }
        if (typeof item.modelConfigIdentity === 'string' && (item.pointer === 'production' || item.pointer === 'default') && typeof item.headVersionNumber === 'number') {
          const command = item.pointer === 'production' ? 'profiles promote' : 'default move'
          const operatorAction = item.pointer === 'production' ? 'promote' : 'default move'
          if (typeof item.stalePointerVersionNumber === 'number' && typeof item.branchedFromVersionNumber === 'number' && item.branchedFromVersionNumber !== item.stalePointerVersionNumber) io.print(`${operatorAction} would move ${item.pointer} from v${item.stalePointerVersionNumber}'s text to v${item.headVersionNumber} = v${item.branchedFromVersionNumber}'s text + ${key}`)
          io.print(`Follow up: instructions ${command} ${set} --project ${project} --model-config ${item.modelConfigIdentity} --version ${item.headVersionNumber}`)
        }
      }
    }
    return 0
  }
  if (subcommand === 'profiles') {
    const operation = reference; const set = positionals[2]; const identity = argValue(args, '--model-config')
    if ((operation !== 'new' && operation !== 'promote' && operation !== 'rollback') || !set || !identity) throw new Error('Usage: orizu instructions profiles new|promote|rollback <set> --project <team/project> --model-config <identity> [--version <n>|--to <n>] [--json]')
    const encodedSet = encodeURIComponent(set); const encodedIdentity = encodeURIComponent(identity)
    const version = argValue(args, '--version'); const to = argValue(args, '--to')
    if ((operation === 'promote' && (!version || !/^[0-9]+$/u.test(version) || Number(version) < 1)) || (operation === 'rollback' && (!to || !/^[0-9]+$/u.test(to) || Number(to) < 1))) throw new Error(operation === 'promote' ? '--version must be a positive integer' : '--to must be a positive integer')
    const path = operation === 'new' ? `/api/cli/instruction-sets/${encodedSet}/profiles` : operation === 'promote' ? `/api/cli/instruction-sets/${encodedSet}/profiles/${encodedIdentity}/label` : `/api/cli/instruction-sets/${encodedSet}/profiles/${encodedIdentity}/rollback`
    const body = operation === 'new' ? { modelConfigIdentity: identity } : operation === 'promote' ? { versionNumber: Number(version) } : { to: Number(to) }
    const payload = await responsePayload(await authedFetch(`${path}?project=${encodeURIComponent(project)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), `Instruction sets profiles ${operation}`)
    if (io.json) io.print(JSON.stringify(payload))
    else {
      const profile = payload.profile as { modelConfigIdentity?: string; versionNumber?: number } | undefined
      io.print(`${profile?.modelConfigIdentity || identity}: v${profile?.versionNumber ?? '?'} ${operation === 'new' ? 'created' : operation === 'promote' ? 'promoted' : 'rolled back'}`)
      const mirrored = payload.mirroredPromptLabel as { promptName?: unknown; promptId?: unknown } | undefined
      if (mirrored && (typeof mirrored.promptName === 'string' || typeof mirrored.promptId === 'string')) io.print(`also moved production for prompt ${typeof mirrored.promptName === 'string' ? mirrored.promptName : mirrored.promptId} (default profile → prompt label)`)
    }
    return 0
  }
  if (subcommand === 'create' || subcommand === 'push') {
    const manifest = writeManifest!; const modelConfig = argValue(args, '--model-config'); const runnerVersion = argValue(args, '--runner-version')
    const setReference = argValue(args, '--set') || manifest.name
    const path = subcommand === 'create' ? '/api/cli/instruction-sets' : `/api/cli/instruction-sets/${encodeURIComponent(setReference)}/versions`
    const body = subcommand === 'create'
      ? { ...manifest, ...(modelConfig ? { modelConfigIdentity: modelConfig } : {}), ...(runnerVersion ? { runnerVersionId: runnerVersion } : {}) }
      : { shape: manifest.shape, components: manifest.components, ...(Object.hasOwn(manifest, 'description') ? { description: manifest.description } : {}), ...(runnerVersion ? { runnerVersionId: runnerVersion } : {}) }
    const payload = await responsePayload(await authedFetch(`${path}?project=${encodeURIComponent(project)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), `Instruction sets ${subcommand}`)
    if (io.json) io.print(JSON.stringify(payload))
    else {
      const set = payload.instructionSet as { name?: string; profiles?: unknown[] } | undefined
      const pushed = Array.isArray(payload.pushed) ? payload.pushed : []
      const unchanged = Array.isArray(payload.unchanged) ? payload.unchanged : []
      const skipped = Array.isArray(payload.skipped) ? payload.skipped : []
      if (subcommand === 'create') {
        const profiles = Array.isArray(set?.profiles) ? set.profiles : []
        io.print(`${set?.name || manifest.name}: ${profiles.length} profile(s) created`)
      } else {
        const describe = (value: unknown) => {
          if (typeof value === 'string') return value
          if (value && typeof value === 'object') {
            const row = value as { modelConfigIdentity?: unknown; versionNumber?: unknown }
            return `${typeof row.modelConfigIdentity === 'string' ? row.modelConfigIdentity : 'unknown'}${typeof row.versionNumber === 'number' ? ` v${row.versionNumber}` : ''}`
          }
          return 'unknown'
        }
        io.print(`${set?.name || manifest.name}: pushed ${pushed.map(describe).join(', ') || 'none'}; unchanged ${unchanged.map(describe).join(', ') || 'none'}; skipped ${skipped.map(describe).join(', ') || 'none'}`)
      }
    }
    return 0
  }
  if (subcommand === 'archive' || subcommand === 'restore') {
    if (!reference || reference.startsWith('--')) throw new Error(`Usage: orizu instructions ${subcommand} <slug-or-exact-name> --project <team/project> [--json]`)
    const archived = subcommand === 'archive'
    const payload = await responsePayload(await authedFetch(`/api/cli/instruction-sets/${encodeURIComponent(reference)}?project=${encodeURIComponent(project)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ archived }),
    }), `Instructions ${subcommand}`)
    if (io.json) io.print(JSON.stringify(payload))
    else {
      const set = payload.instructionSet as { name?: string; slug?: string } | undefined
      const identity = set?.slug && set.slug !== set.name ? `${set.name || reference} (${set.slug})` : set?.name || set?.slug || reference
      io.print(`${archived ? 'Archived' : 'Restored'} instruction set ${identity}`)
    }
    return 0
  }
  const status = argValue(args, '--status') || 'active'
  if (subcommand !== 'list' && subcommand !== 'show' && subcommand !== 'sync') throw new Error('Usage: orizu instructions list|show|sync|archive|restore')
  if (subcommand === 'sync') {
    const output = argValue(args, '--out')
    if (!reference || !output) throw new Error('Usage: orizu instructions sync <set> --out <dir> --project <team/project> [--model-config <identity>] [--json]')
    const modelConfig = argValue(args, '--model-config')
    const path = `/api/cli/instruction-sets/${encodeURIComponent(reference)}/sync?project=${encodeURIComponent(project)}${modelConfig ? `&modelConfig=${encodeURIComponent(modelConfig)}` : ''}`
    const payload = await responsePayload(await authedFetch(path, { method: 'GET' }), 'Instruction sets sync')
    const set = payload.instructionSet as SyncSet
    if (!set || (set.slug !== reference && set.name !== reference) || (modelConfig && (!Array.isArray(set.filteredTo) || set.filteredTo.length !== 1 || set.filteredTo[0] !== modelConfig))) {
      throw new Error('instruction_set_sync_response_mismatch')
    }
    const destination = syncToDisk(output, set)
    if (io.json) io.print(JSON.stringify(payload)); else io.print(`Synced ${set.name} to ${destination}`)
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
      const set = item as { name?: string; slug?: string; description?: string | null; shape?: string[]; status?: string }
      io.print(`${set.name || 'unnamed'}${set.slug ? ` [${set.slug}]` : ''}${set.status === 'archived' ? ' [archived]' : ''}${set.shape ? ` (${set.shape.join(', ')})` : ''}`)
      if (set.description) io.print(`  ${sanitizeHumanInlineText(sanitizeTerminalText, set.description)}`)
    }
    return 0
  }
  const set = payload.instructionSet as { name?: string; description?: string | null; shape?: string[]; status?: string; default?: { versionNumber?: number } | null; profiles?: Array<{ modelConfigIdentity?: string | null; production?: { versionNumber?: number } | null; latestVersionNumber?: number | null }> } | undefined
  io.print(`${set?.name || reference}${set?.status === 'archived' ? ' [archived]' : ''}: ${set?.shape?.join(', ') || ''}`)
  if (set?.description) io.print(`Description: ${sanitizeHumanInlineText(sanitizeTerminalText, set.description)}`)
  if (set?.default) io.print(`Default: v${set.default.versionNumber ?? '?'}`)
  for (const profile of set?.profiles || []) {
    io.print(`${profile.modelConfigIdentity || 'unspecified'}: production ${profile.production ? `v${profile.production.versionNumber}` : '—'}, latest ${profile.latestVersionNumber ?? '—'}`)
  }
  return 0
}
