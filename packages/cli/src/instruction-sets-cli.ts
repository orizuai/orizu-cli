import { authedFetch } from './http.js'
import { INSTRUCTION_SET_COMPONENT_KEY } from './instruction-set-lock/index.js'
import { loadInstructionSetManifest, MAX_INSTRUCTION_SET_COMPONENT_BYTES, type InstructionSetManifest } from './instruction-set-manifest.js'
import { sanitizeHumanInlineText, sanitizeTerminalText } from './json-response.js'
import { parseSyncTarget, planSyncRequest, syncPayloadToDisk, type SyncPayload, type SyncTarget } from './instruction-set-sync/index.js'
import { applyPrune, applyUpdate, lockedProfileIdentity, makeUpdatePlan, planPrune, PruneKeepUnresolvedError, readUpdateLock } from './instruction-set-update/index.js'
import { printVerifyReport, verifyInstructionSetTree } from './instruction-set-verify/index.js'
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

function requiredOptionValue(args: string[], subcommand: string, flag: string): string | null {
  const value = argValue(args, flag)
  if (args.includes(flag) && value === null) {
    throw new Error(`instruction_set_${subcommand}_option_value_missing:${flag}`)
  }
  return value
}

function waitAtPrunePlanBarrierForProcessTest(): void {
  const readyPath = process.env.ORIZU_TEST_PRUNE_PLAN_READY_PATH
  const releasePath = process.env.ORIZU_TEST_PRUNE_PLAN_RELEASE_PATH
  if (readyPath === undefined && releasePath === undefined) return
  if (!readyPath || !releasePath) throw new Error('instruction_set_prune_test_barrier_invalid')
  writeFileSync(readyPath, `${process.pid}\n`, { flag: 'wx' })
  const deadline = Date.now() + 10_000
  while (!existsSync(releasePath)) {
    if (Date.now() >= deadline) throw new Error('instruction_set_prune_test_barrier_timeout')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  }
}

function unknownPruneOption(args: string[]): string | undefined {
  const allowed = new Set(['--out', '--keep', '--yes', '--json'])
  return args.find(value => value.startsWith('--') && !allowed.has(value))
}

function lifecycleOptionValues(args: string[], command: 'update' | 'prune', flag: string): string[] {
  const values: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag) continue
    const value = args[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`instruction_set_${command}_option_missing_value:${flag}`)
    }
    values.push(value)
  }
  return values
}

async function responsePayload(response: Response, action: string): Promise<Record<string, unknown>> {
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) {
    throw new Error(`${action} failed (${response.status}): ${typeof payload.error === 'string' ? payload.error : response.statusText}`)
  }
  return payload
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/u
const WINDOWS_RESERVED_COMPONENT_KEY = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu

export interface SyncComponent { body?: string; repoPath?: string; contentSha?: string; commitSha?: string }
export interface SyncMaterial { profileVersionId: string; versionNumber: number; modelConfigIdentity: string; resolvedFrom: string; components: Record<string, SyncComponent> }
export interface SyncProfile { modelConfigIdentity: string; resolvedFrom: string; production: SyncMaterial | null }
export interface SyncSet {
  name: string
  description?: string | null
  shape: string[]
  default: SyncMaterial
  profiles: SyncProfile[]
  filteredTo?: string[]
}
function safeSegment(value: string) {
  if (!SAFE_SEGMENT.test(value) || value === '.' || value === '..' || value.startsWith('.')) {
    throw new Error('instruction_set_path_unsafe')
  }
}
function safeComponentKey(value: string, platform: NodeJS.Platform) {
  if (
    !INSTRUCTION_SET_COMPONENT_KEY.test(value) ||
    (platform === 'win32' && WINDOWS_RESERVED_COMPONENT_KEY.test(value))
  ) {
    throw new Error('instruction_set_path_unsafe')
  }
}
function slug(identity: string) { return identity.replaceAll('/', '__').replace(/[^A-Za-z0-9._-]/gu, '_') }
function stable(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n` }
function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }

export interface SyncFileOps {
  writeFileSync: typeof writeFileSync
  renameSync?: typeof renameSync
  rmSync?: typeof rmSync
}

function writeMaterial(root: string, material: SyncMaterial, shape: string[], manifestRoot: string, platform: NodeJS.Platform, fileOps: SyncFileOps = { writeFileSync }) {
  const files: Record<string, string> = Object.create(null)
  const syncedContentSha256: Record<string, string> = Object.create(null)
  const pinnedComponents: Record<string, unknown> = Object.create(null)
  for (const key of [...shape].sort()) {
    safeComponentKey(key, platform)
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

function existingDestinationIsSynced(destination: string, set: Pick<SyncSet, 'name'>) {
  try {
    if (!statSync(destination).isDirectory()) return false
    const manifest = JSON.parse(readFileSync(join(destination, 'manifest.json'), 'utf8')) as {
      manifestVersion?: number
      name?: string
    }
    return manifest.manifestVersion === 1 && manifest.name === set.name
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

export function syncToDisk(
  out: string,
  set: SyncSet,
  fileOps: SyncFileOps = { writeFileSync },
  platform: NodeJS.Platform = process.platform
) {
  const directoryName = set.name
  safeSegment(directoryName)
  for (const key of set.shape) safeSegment(key)
  for (const profile of set.profiles) safeSegment(slug(profile.modelConfigIdentity))
  mkdirSync(out, { recursive: true })
  const destination = join(out, directoryName)
  if (existsSync(destination) && !existingDestinationIsSynced(destination, set)) {
    throw new Error('instruction_set_sync_destination_not_synced')
  }
  const priorDestinations = [destination]
  const temp = join(out, `.${directoryName}.${randomUUID()}.tmp`)
  const move = fileOps.renameSync || renameSync
  const backups: Array<{ original: string; backup: string }> = []
  mkdirSync(temp)
  try {
    const defaultMaterial = writeMaterial(
      temp,
      set.default,
      set.shape,
      'default',
      platform,
      fileOps
    )
    const profiles = set.profiles.map(profile => ({
      modelConfigIdentity: profile.modelConfigIdentity, slug: slug(profile.modelConfigIdentity), resolvedFrom: profile.resolvedFrom,
      production: profile.production ? writeMaterial(
        temp,
        profile.production,
        set.shape,
        `profiles/${slug(profile.modelConfigIdentity)}`,
        platform,
        fileOps
      ) : null,
    })).sort((a, b) => a.modelConfigIdentity.localeCompare(b.modelConfigIdentity))
    const components = [
      ...Object.entries(defaultMaterial.files).map(([key, path]) => ({ key, path, syncedContentSha256: defaultMaterial.syncedContentSha256[key] })),
      ...profiles.flatMap(profile => profile.production
        ? Object.entries(profile.production.files).map(([key, path]) => ({ key, modelConfig: profile.modelConfigIdentity, path, syncedContentSha256: profile.production!.syncedContentSha256[key] }))
        : []),
    ]
    const manifest = {
      manifestVersion: 1,
      name: set.name,
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
  const knownSubcommands = new Set([
    'archive', 'create', 'default', 'list', 'profiles', 'prune', 'push',
    'restore', 'scorers', 'shape', 'show', 'sync', 'update', 'verify',
  ])
  if (!subcommand || !knownSubcommands.has(subcommand)) {
    throw new Error('Usage: orizu instructions list|show|sync|update|prune|verify|archive|restore')
  }
  if (subcommand === 'verify') {
    const report = await verifyInstructionSetTree(requiredOptionValue(args, subcommand, '--out') ?? '.')
    printVerifyReport(report, io.json, io.print)
    return report.ok ? 0 : 1
  }
  if (subcommand === 'prune') {
    const unknownOption = unknownPruneOption(args)
    if (unknownOption) {
      const code = `instruction_set_prune_option_unknown:${unknownOption}`
      if (!io.json) throw new Error(code)
      io.print(JSON.stringify({ removals: [], applied: false, error: code }))
      return 1
    }
    const output = lifecycleOptionValues(args, 'prune', '--out')[0] ?? '.'
    const keepSpecifiers = lifecycleOptionValues(args, 'prune', '--keep')
    let plan: Awaited<ReturnType<typeof planPrune>>
    try {
      plan = await planPrune(output, keepSpecifiers)
    } catch (error) {
      if (!(io.json && error instanceof PruneKeepUnresolvedError)) throw error
      io.print(JSON.stringify({ removals: [], applied: false, error: error.code, unresolved: error.unresolved }))
      return 1
    }
    const isApproved = args.includes('--yes')
    if (!isApproved) {
      if (io.json) io.print(JSON.stringify({ removals: plan.removals, skipped: [], applied: false }))
      else {
        for (const removal of plan.removals) io.print(`Remove ${removal.key}: ${removal.reason}`)
        io.print('Plan only; pass --yes to prune.')
      }
      return 0
    }
    waitAtPrunePlanBarrierForProcessTest()
    try {
      const result = await applyPrune(output, plan, keepSpecifiers)
      if (io.json) io.print(JSON.stringify({ removals: plan.removals, skipped: result.skipped, applied: true }))
      else {
        for (const removal of plan.removals) io.print(`Remove ${removal.key}: ${removal.reason}`)
        for (const removal of result.skipped) {
          const reason = removal.reason === 'profile_directory_has_unmanaged_files'
            ? `profile directory contains unmanaged files (${removal.unmanagedEntries!.join(', ')})`
            : 'became referenced after planning'
          io.print(`Skipped ${removal.key}: ${reason}`)
        }
      }
      return 0
    } catch (error) {
      if (!io.json) throw error
      const code = error instanceof Error ? error.message : String(error)
      io.print(JSON.stringify({ removals: plan.removals, applied: false, error: code }))
      return 1
    }
  }
  if (subcommand === 'default' && reference === 'move' && args.some(arg => arg === '--version' || arg.startsWith('--version='))) {
    throw new Error('--version is not valid for default move; use instructions profiles promote')
  }
  let writeManifest: InstructionSetManifest | undefined
  if (subcommand === 'create' || subcommand === 'push') {
    if (!reference || reference.startsWith('--')) throw new Error(subcommand === 'create'
      ? 'Usage: orizu instructions create <manifest> --project <team/project> [--runner-version <id>] [--model-config <identity>] [--json]'
      : 'Usage: orizu instructions push <manifest> --project <team/project> [--set <slug-or-exact-name>] [--runner-version <id>] [--json]')
    writeManifest = loadInstructionSetManifest(reference)
  }
  let syncTarget: SyncTarget | undefined
  if (subcommand === 'sync') {
    for (const option of ['--project', '--out', '--version', '--target']) {
      if (args.filter(value => value === option).length > 1) {
        throw new Error(`instruction_set_sync_option_duplicate:${option}`)
      }
    }
    const suppliedTarget = argValue(args, '--target')
    syncTarget = parseSyncTarget(args.includes('--target') ? suppliedTarget ?? '' : undefined)
  }
  const projectOption = subcommand === 'update'
    ? lifecycleOptionValues(args, 'update', '--project')[0] ?? null
    : requiredOptionValue(args, subcommand, '--project')
  const project = await io.resolveProjectSlug(projectOption)
  if (subcommand === 'update') {
    const output = lifecycleOptionValues(args, 'update', '--out')[0] ?? '.'
    const lock = readUpdateLock(output, project)
    const payloads: SyncPayload[] = []
    for (const [setSlug, set] of Object.entries(lock.instructionSets)) {
      const barePath = `/api/cli/instruction-sets/${encodeURIComponent(setSlug)}/sync?project=${encodeURIComponent(project)}`
      payloads.push(await responsePayload(await authedFetch(barePath, { method: 'GET' }), 'Instruction sets update') as unknown as SyncPayload)
      for (const profileSlugValue of Object.keys(set.profiles)) {
        const identity = lockedProfileIdentity(output, setSlug, profileSlugValue)
        const query = new URLSearchParams({ project, profile: identity })
        const path = `/api/cli/instruction-sets/${encodeURIComponent(setSlug)}/sync?${query.toString()}`
        payloads.push(await responsePayload(await authedFetch(path, { method: 'GET' }), 'Instruction sets update') as unknown as SyncPayload)
      }
    }
    const plan = makeUpdatePlan(project, lock, payloads)
    const isApproved = args.includes('--yes')
    const result = isApproved
      ? await applyUpdate(output, project, plan, args.includes('--no-sync'))
      : { absent: [], warnings: [] }
    if (io.json) io.print(JSON.stringify({ plan: plan.lines, applied: isApproved, absent: result.absent, warnings: result.warnings }))
    else {
      for (const line of plan.lines) io.print(line)
      for (const specifier of result.absent) io.print(`Referenced but absent: ${specifier}`)
      for (const warning of result.warnings) io.print(warning)
      if (!isApproved) io.print('Plan only; pass --yes to update.')
    }
    return 0
  }
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
    const operation = reference; const set = positionals[2]; const identity = argValue(args, '--model-config')
    if ((operation !== 'show' && operation !== 'move') || !set) throw new Error('Usage: orizu instructions default show|move <set> --project <team/project> [--model-config <identity>] [--json]')
    if (operation === 'move' && !identity) throw new Error('--model-config is required')
    const path = `/api/cli/instruction-sets/${encodeURIComponent(set)}/default?project=${encodeURIComponent(project)}`
    if (operation === 'show') {
      const payload = await responsePayload(await authedFetch(path, { method: 'GET' }), 'Instruction sets default show')
      const current = payload.default as { modelConfigIdentity?: string; production?: { versionNumber?: number } | null } | null
      if (io.json) io.print(JSON.stringify(payload))
      else if (!current?.modelConfigIdentity) io.print('Default: unset')
      else io.print(`Default: ${sanitizeTerminalText(current.modelConfigIdentity)} (${current.production ? `production v${current.production.versionNumber ?? '?'}` : 'not promoted'})`)
      return 0
    }
    const payload = await responsePayload(await authedFetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelConfigIdentity: identity }) }), 'Instruction sets default move')
    if (io.json) io.print(JSON.stringify(payload)); else io.print(`Default moved to ${sanitizeTerminalText(identity!)}`)
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
        if (typeof item.modelConfigIdentity === 'string' && item.pointer === 'production' && typeof item.headVersionNumber === 'number') {
          const command = 'profiles promote'
          if (typeof item.stalePointerVersionNumber === 'number' && typeof item.branchedFromVersionNumber === 'number' && item.branchedFromVersionNumber !== item.stalePointerVersionNumber) io.print(`promote would move ${item.pointer} from v${item.stalePointerVersionNumber}'s text to v${item.headVersionNumber} = v${item.branchedFromVersionNumber}'s text + ${key}`)
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
  if (subcommand === 'sync') {
    if (!reference) throw new Error('Usage: orizu instructions sync <specifier> [--version <n>] [--out <app-root>] [--target <ts>] [--force-helpers] --project <team/project> [--json]')
    if (args.includes('--model-config')) {
      throw new Error('instruction_set_sync_option_retired:--model-config; use <set>/<profile> (see docs/cli.md#specifiers)')
    }
    const allowedOptions = new Set(['--project', '--out', '--version', '--target', '--json', '--force-helpers'])
    const unknownOption = args.find(value => value.startsWith('--') && !allowedOptions.has(value))
    if (unknownOption) throw new Error(`instruction_set_sync_option_unknown:${unknownOption}`)
    const output = requiredOptionValue(args, subcommand, '--out') ?? '.'
    const plan = planSyncRequest(reference, requiredOptionValue(args, subcommand, '--version'), output, project)
    const payload = await responsePayload(await authedFetch(plan.path, { method: 'GET' }), 'Instruction sets sync') as unknown as SyncPayload
    const result = syncPayloadToDisk(output, project, plan, payload, {
      forceHelpers: args.includes('--force-helpers'),
      target: syncTarget!,
    })
    if (io.json) io.print(JSON.stringify({ ...payload, warnings: result.warnings }))
    else {
      io.print(`Synced ${reference} to ${result.destination}`)
      for (const warning of result.warnings) io.print(`Warning: ${warning}`)
      if (plan.usedRecordedPointer) io.print('Using recorded Pointer values; run orizu instructions update to re-resolve them.')
    }
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
  const set = payload.instructionSet as { name?: string; description?: string | null; shape?: string[]; status?: string; default?: { modelConfigIdentity?: string } | null; profiles?: Array<{ modelConfigIdentity?: string | null; production?: { versionNumber?: number } | null; latestVersionNumber?: number | null }> } | undefined
  io.print(`${set?.name || reference}${set?.status === 'archived' ? ' [archived]' : ''}: ${set?.shape?.join(', ') || ''}`)
  if (set?.description) io.print(`Description: ${sanitizeHumanInlineText(sanitizeTerminalText, set.description)}`)
  if (set?.default?.modelConfigIdentity) io.print(`Default: ${sanitizeTerminalText(set.default.modelConfigIdentity)}`)
  for (const profile of set?.profiles || []) {
    io.print(`${profile.modelConfigIdentity || 'unspecified'}: production ${profile.production ? `v${profile.production.versionNumber}` : '—'}, latest ${profile.latestVersionNumber ?? '—'}`)
  }
  return 0
}
