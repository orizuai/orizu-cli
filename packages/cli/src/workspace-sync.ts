/**
 * Workspace tracked-resource sync commands (ALI-976 CLI half, revised spec).
 *
 * This module holds the plain parts: the inventory, hashes, cache and manifest
 * file contents, and the thin `workspaceSyncCommand` entry point. The requests
 * and the commands run on Effect in workspace-sync-workflow.ts (ORI-2762),
 * loaded only when `orizu workspace` runs. Together they implement the client
 * side of the ALI-933 sync semantics:
 *
 *   - Inventory: walk the durable workspace contract (manifests + instruction/
 *     memory/readme files) and compute each tracked file's content sha256.
 *     `.orizu/**` is cache-only by definition (spec §6) and never inventoried.
 *     Symlinked plain files hash the LINK TARGET PATH string (spec §3.1), so
 *     editing `AGENTS.md` never falsely dirties a symlinked `CLAUDE.md`;
 *     pointer files (no-symlinks mode) hash their own bytes.
 *   - Missing/untracked visibility (spec §3.2): cache-known paths absent from
 *     the inventory are reported `missing` locally and sent to sync as
 *     `{path, missing: true}` (the server echoes without touching stored
 *     truth). Files under managed primitive dirs covered by no manifest are
 *     reported `untracked` in LOCAL status only — never sent to sync.
 *   - Cache snapshots: last-sync `base` hashes stored under
 *     `.orizu/cache/sync/<sha256-of-path>.json`. Filenames are path-hashed so
 *     the cache never mirrors the workspace directory structure. Cache is
 *     gitignored and safely deletable (spec §6); it is `local`/`cache`, never a
 *     contract.
 *   - Commands: `status` (local three-way against the cache; `--remote`
 *     performs the SAME server-side reconciliation as `sync` — it registers
 *     and updates tracked-resource records; there is no read-only remote
 *     status in v0, spec §3.1 — but never writes local cache), `sync`
 *     (metadata-first; cache base advances ONLY on a `clean`
 *     convergence-confirmation), `pull` (metadata fast-forward, only when the
 *     server carries real truth), and `apply` (repo → server promotion;
 *     refuses DB-native owners, conflicts, and remote-newer via server 409s).
 *
 * v0 boundary: `pull` reconciles the manifest canonical block + cache only,
 * and ONLY from server-carried truth (serverSha256/serverVersionId) — never
 * from local bytes. It does not materialize bulk primitive content — source
 * files converge through Git, and DB-native/object bytes materialize through
 * the primitive-specific commands (e.g. `orizu prompts pull`,
 * `orizu datasets download`). Full bulk-content pull is deferred (spec §8).
 *
 * Apply identity (spec §3.1): strictly the sync-recorded tracked-resource ROW
 * id from the cache snapshot (`resourceId`). There is NO fallback to the
 * manifest's `canonical.serviceId` (informational/legacy). Without a recorded
 * row id the command directs the user to run `orizu workspace sync` first.
 * On any apply 409 (owner refusal, conflicted, remote-newer, CAS loss) the
 * recovery loop is: re-sync, converge per the reported status, retry.
 */

import { spawnSync } from 'child_process'
import { createHash, randomBytes } from 'crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname, join, relative, sep } from 'path'

import {
  type CanonicalOwner,
  getWorkspaceRoot,
  PROJECT_PRIMITIVE_DIRS,
  readJsonManifest,
  type RepoState,
  WORKSPACE_DIR_NAME,
} from './workspace.js'

export const TRACKED_RESOURCE_KINDS = [
  'team_manifest',
  'project_manifest',
  'instruction_file',
  'memory_file',
  'readme',
  'dataset',
  'app',
  'task',
  'prompt',
  'scorer',
  'optimization',
  'other',
] as const

export type TrackedResourceKind = (typeof TRACKED_RESOURCE_KINDS)[number]

const PRIMITIVE_KINDS: Record<string, TrackedResourceKind> = {
  dataset: 'dataset',
  app: 'app',
  task: 'task',
  prompt: 'prompt',
  scorer: 'scorer',
  optimization: 'optimization',
}

const CACHE_SYNC_SUBDIR = join(WORKSPACE_DIR_NAME, 'cache', 'sync')

export type WorkspaceSyncFetcher = (path: string, init?: RequestInit) => Promise<Response>

export interface InventoryEntry {
  path: string
  absPath: string
  kind: TrackedResourceKind
  owner: CanonicalOwner
  repoState: RepoState
  projectSlug: string | null
  serviceResourceId: string | null
  versionId: string | null
  contentSha256: string
  manifestPath: string | null
  isManifest: boolean
}

export interface CacheSnapshot {
  path: string
  baseSha256: string | null
  versionId: string | null
  lastSyncedAt: string | null
  /** Server tracked-resource ROW id — the ONLY apply identity (spec §3.1). */
  resourceId?: string | null
  /**
   * Metadata-only-pull guard (spec §3.3): set when a `pull` advanced this
   * repo-owned resource's base to a server hash the working content does not
   * yet match — i.e. the base moved without the bytes being delivered. While
   * set, `apply` MUST refuse (a CAS apply would pass and silently revert the
   * pulled version). Absent/false means not pending (backward-compatible with
   * pre-guard snapshots that lack the field).
   */
  contentPending?: boolean
  /** The pulled base hash the working content must reconcile to before apply. */
  pendingBaseSha256?: string | null
}

export interface CommonOptions {
  cwd?: string
  fetcher?: WorkspaceSyncFetcher
  workspaceId?: string | null
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function toPosix(relPath: string): string {
  return relPath.split(sep).join('/')
}

function posixDirname(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

// Content hash of a manifest EXCLUDING its canonical block. The canonical block
// is metadata about the content (versionId/contentSha256/lastPulledAt move on
// apply/pull); hashing the whole file would make every manifest self-dirtying.
function manifestContentSha(manifest: Record<string, unknown>): string {
  const { canonical: _canonical, ...rest } = manifest
  return sha256Hex(JSON.stringify(rest))
}

// Plain-file hash (spec §3.1 "What is hashed"): a symlink hashes its LINK
// TARGET PATH string — never the resolved target's contents, which would make
// every AGENTS.md edit falsely dirty a symlinked CLAUDE.md. Regular files
// (including pointer files in no-symlinks mode) hash their own bytes.
function fileContentSha(absPath: string): string {
  const stat = lstatSync(absPath)
  if (stat.isSymbolicLink()) {
    return sha256Hex(readlinkSync(absPath))
  }
  return sha256Hex(readFileSync(absPath))
}

export function readCanonical(manifest: Record<string, unknown> | null): Record<string, unknown> {
  const canonical = manifest?.canonical
  return canonical && typeof canonical === 'object' && !Array.isArray(canonical)
    ? (canonical as Record<string, unknown>)
    : {}
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function ownerFrom(canonical: Record<string, unknown>): CanonicalOwner {
  const owner = canonical.owner
  return owner === 'orizu-db' || owner === 'object-storage' || owner === 'local' ? owner : 'repo'
}

function repoStateFrom(canonical: Record<string, unknown>, fallback: RepoState): RepoState {
  const value = canonical.repoState
  const allowed: RepoState[] = ['source', 'draft', 'snapshot', 'mirror', 'cache', 'object_ref_only']
  return typeof value === 'string' && (allowed as string[]).includes(value) ? (value as RepoState) : fallback
}

function manifestKind(manifest: Record<string, unknown> | null, basename: string): TrackedResourceKind {
  const kind = manifest?.kind
  if (kind === 'team') return 'team_manifest'
  if (kind === 'project') return 'project_manifest'
  if (typeof kind === 'string' && PRIMITIVE_KINDS[kind]) return PRIMITIVE_KINDS[kind]
  if (basename === 'orizu.team.json') return 'team_manifest'
  if (basename === 'orizu.project.json') return 'project_manifest'
  return 'other'
}

function plainFileKind(basename: string): TrackedResourceKind {
  if (basename === 'AGENTS.md' || basename === 'CLAUDE.md') return 'instruction_file'
  if (basename === 'Memory.md' || basename === 'memory.md') return 'memory_file'
  if (basename === 'README.md') return 'readme'
  return 'other'
}

function manifestEntry(root: string, absPath: string, projectSlug: string | null, repoStateFallback: RepoState): InventoryEntry | null {
  const manifest = readJsonManifest(absPath)
  if (!manifest) {
    return null
  }
  const canonical = readCanonical(manifest)
  const basename = absPath.split(sep).pop() || absPath
  return {
    path: toPosix(relative(root, absPath)),
    absPath,
    kind: manifestKind(manifest, basename),
    owner: ownerFrom(canonical),
    repoState: repoStateFrom(canonical, repoStateFallback),
    projectSlug,
    serviceResourceId: stringOrNull(canonical.serviceId),
    versionId: stringOrNull(canonical.versionId),
    contentSha256: manifestContentSha(manifest),
    manifestPath: absPath,
    isManifest: true,
  }
}

function plainEntry(root: string, absPath: string, projectSlug: string | null): InventoryEntry {
  const basename = absPath.split(sep).pop() || absPath
  return {
    path: toPosix(relative(root, absPath)),
    absPath,
    kind: plainFileKind(basename),
    owner: 'repo',
    repoState: 'source',
    projectSlug,
    serviceResourceId: null,
    versionId: null,
    contentSha256: fileContentSha(absPath),
    manifestPath: null,
    isManifest: false,
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

function walkPrimitiveManifests(dir: string, depth: number, into: string[]) {
  if (depth > 8 || !existsSync(dir)) {
    return
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === WORKSPACE_DIR_NAME || entry.name === '.git') {
      continue
    }
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkPrimitiveManifests(path, depth + 1, into)
    } else if (/^orizu\..+\.json$/.test(entry.name)) {
      into.push(path)
    }
  }
}

function walkAllFiles(dir: string, depth: number, into: string[]) {
  if (depth > 8 || !existsSync(dir)) {
    return
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === WORKSPACE_DIR_NAME || entry.name === '.git') {
      continue
    }
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkAllFiles(path, depth + 1, into)
    } else {
      into.push(path)
    }
  }
}

/** Walk the durable workspace contract and return one entry per tracked file. */
export function collectInventory(cwd?: string): InventoryEntry[] {
  const root = getWorkspaceRoot(cwd)
  const entries: InventoryEntry[] = []

  const teamManifest = join(root, 'orizu.team.json')
  if (existsSync(teamManifest)) {
    const entry = manifestEntry(root, teamManifest, null, 'source')
    if (entry) entries.push(entry)
  }
  for (const name of ['AGENTS.md', 'CLAUDE.md', 'Memory.md', 'README.md']) {
    const path = join(root, name)
    if (existsSync(path)) entries.push(plainEntry(root, path, null))
  }

  const projectsRoot = join(root, 'projects')
  for (const slug of projectDirectoryNames(projectsRoot)) {
    const projectRoot = join(projectsRoot, slug)
    const projectManifest = join(projectRoot, 'orizu.project.json')
    if (existsSync(projectManifest)) {
      const entry = manifestEntry(root, projectManifest, slug, 'draft')
      if (entry) entries.push(entry)
    }
    for (const name of ['README.md', 'memory.md']) {
      const path = join(projectRoot, name)
      if (existsSync(path)) entries.push(plainEntry(root, path, slug))
    }
    for (const primitiveDir of PROJECT_PRIMITIVE_DIRS) {
      const manifests: string[] = []
      walkPrimitiveManifests(join(projectRoot, primitiveDir), 0, manifests)
      for (const path of manifests) {
        const entry = manifestEntry(root, path, slug, 'draft')
        if (entry) entries.push(entry)
      }
    }
  }

  return entries
}

/**
 * Files present under managed primitive dirs that no inventory rule covers
 * (spec §3.2 `untracked`). A file is covered when an inventoried manifest
 * lives in its directory or any ancestor within the managed dir — body files
 * adjacent to their manifest belong to that resource and converge via Git.
 * Reported in LOCAL status only; never sent to sync.
 */
export function collectUntrackedPaths(cwd: string, inventory: InventoryEntry[]): string[] {
  const root = getWorkspaceRoot(cwd)
  const inventoryPaths = new Set(inventory.map(entry => entry.path))
  const manifestDirs = new Set(inventory.filter(entry => entry.isManifest).map(entry => posixDirname(entry.path)))
  const untracked: string[] = []
  const projectsRoot = join(root, 'projects')

  for (const slug of projectDirectoryNames(projectsRoot)) {
    for (const primitiveDir of PROJECT_PRIMITIVE_DIRS) {
      const managedRel = `projects/${slug}/${primitiveDir}`
      const files: string[] = []
      walkAllFiles(join(projectsRoot, slug, primitiveDir), 0, files)
      for (const absPath of files) {
        const relPath = toPosix(relative(root, absPath))
        if (inventoryPaths.has(relPath)) {
          continue
        }
        let dir = posixDirname(relPath)
        let covered = false
        while (dir.length >= managedRel.length) {
          if (manifestDirs.has(dir)) {
            covered = true
            break
          }
          if (dir === managedRel) {
            break
          }
          dir = posixDirname(dir)
        }
        if (!covered) {
          untracked.push(relPath)
        }
      }
    }
  }

  return untracked.sort()
}

// ---- Local files: each one is replaced whole ------------------------------

/** One local file a command is about to replace, with its new contents. */
export interface PlannedWrite {
  path: string
  text: string
}

/**
 * Writes a temp file beside `path`, then renames it over `path`, so the file
 * holds either its old bytes or its new ones, never part of either. The temp
 * file is removed when the rename fails.
 */
export function writeFileWhole(write: PlannedWrite, rename: (from: string, to: string) => void = renameSync): void {
  mkdirSync(dirname(write.path), { recursive: true })
  const temp = `${write.path}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(temp, write.text)
  try {
    rename(temp, write.path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

const jsonText = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

// ---- Cache snapshots ------------------------------------------------------

export function cacheSnapshotPath(cwd: string, relPath: string): string {
  return join(getWorkspaceRoot(cwd), CACHE_SYNC_SUBDIR, `${sha256Hex(relPath)}.json`)
}

export function readCacheSnapshot(cwd: string, relPath: string): CacheSnapshot | null {
  const file = cacheSnapshotPath(cwd, relPath)
  if (!existsSync(file)) {
    return null
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as CacheSnapshot
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

export function cacheSnapshotWrite(cwd: string, snapshot: CacheSnapshot): PlannedWrite {
  return { path: cacheSnapshotPath(cwd, snapshot.path), text: jsonText(snapshot) }
}

export function writeCacheSnapshot(cwd: string, snapshot: CacheSnapshot): void {
  writeFileWhole(cacheSnapshotWrite(cwd, snapshot))
}

/** Every readable cache snapshot (regenerable; unreadable files are skipped). */
function listCacheSnapshots(cwd: string): CacheSnapshot[] {
  const dir = join(getWorkspaceRoot(cwd), CACHE_SYNC_SUBDIR)
  let names: string[]
  try {
    names = readdirSync(dir).filter(name => name.endsWith('.json')).sort()
  } catch {
    return []
  }
  const snapshots: CacheSnapshot[] = []
  for (const name of names) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as CacheSnapshot
      if (parsed && typeof parsed === 'object' && typeof parsed.path === 'string') {
        snapshots.push(parsed)
      }
    } catch {
      // Cache is regenerable by definition (§6); skip unreadable snapshots.
    }
  }
  return snapshots
}

/** Cache-known paths absent from the inventory — the `missing` transport (§3.1). */
export function missingCachePaths(cwd: string, inventory: InventoryEntry[]): string[] {
  const inventoryPaths = new Set(inventory.map(entry => entry.path))
  return listCacheSnapshots(cwd)
    .map(snapshot => snapshot.path)
    .filter(path => !inventoryPaths.has(path))
}

// Record the server row id WITHOUT advancing the base: base/versionId move
// only on a clean confirmation or on pull/apply; the row id is pure identity
// and is safe to persist for every sync response.
export function cacheResourceIdWrite(cwd: string, path: string, resourceId: string | null): PlannedWrite | null {
  if (!resourceId) {
    return null
  }
  const existing = readCacheSnapshot(cwd, path)
  if (existing?.resourceId === resourceId) {
    return null
  }
  // Preserve every other field (base/version/lastSynced AND the §3.3
  // content-pending guard): recording a row id must never advance the base nor
  // silently clear a pending mark. A non-clean sync between pull and apply keeps
  // the guard intact; only a `clean` convergence (or a reconciled apply/pull)
  // clears it.
  return cacheSnapshotWrite(cwd, {
    ...(existing ?? { path, baseSha256: null, versionId: null, lastSyncedAt: null }),
    path,
    resourceId,
  })
}

// ---- Manifest edits (preserve all other fields + formatting) --------------

export function canonicalPatchWrite(absPath: string, patch: Record<string, unknown>): PlannedWrite {
  const manifest = readJsonManifest(absPath) ?? {}
  const canonical = { ...readCanonical(manifest), ...patch }
  return { path: absPath, text: jsonText({ ...manifest, canonical }) }
}

// Attach writes ONLY `setup.attachedWorkspaceId` (ALI-1075: fresh manifests
// carry no `canonical` block and attach must not resurrect one). A legacy
// manifest that still has `canonical.serviceId` gets it updated in place so
// the two ids can never disagree; it is never created.
export function teamWorkspaceIdWrite(root: string, workspaceId: string): PlannedWrite {
  const absPath = join(root, 'orizu.team.json')
  const manifest = readJsonManifest(absPath) ?? {}
  const legacyCanonical = readCanonical(manifest)
  const canonicalPatch = 'serviceId' in legacyCanonical
    ? { canonical: { ...legacyCanonical, serviceId: workspaceId } }
    : {}
  const setupRaw = manifest.setup
  const setup = { ...(setupRaw && typeof setupRaw === 'object' && !Array.isArray(setupRaw) ? setupRaw : {}), attachedWorkspaceId: workspaceId }
  return { path: absPath, text: jsonText({ ...manifest, ...canonicalPatch, setup }) }
}

// ---- Workspace identity ---------------------------------------------------

export function teamSlugOf(root: string): string {
  const manifest = readJsonManifest(join(root, 'orizu.team.json'))
  return stringOrNull(manifest?.slug) || 'local-team'
}

export function attachedWorkspaceId(root: string): string | null {
  const manifest = readJsonManifest(join(root, 'orizu.team.json'))
  const setup = manifest?.setup
  const fromSetup = setup && typeof setup === 'object' && !Array.isArray(setup)
    ? stringOrNull((setup as Record<string, unknown>).attachedWorkspaceId)
    : null
  return fromSetup || stringOrNull(readCanonical(manifest).serviceId)
}

// One entry per inventoried path plus `{path, missing: true}` for every
// cache-known path absent from the inventory (spec §3.1 missing transport).
export function syncBody(root: string, entries: InventoryEntry[]) {
  return {
    resources: [
      ...entries.map(entry => ({
        path: entry.path,
        kind: entry.kind,
        projectSlug: entry.projectSlug,
        canonicalOwner: entry.owner,
        repoState: entry.repoState,
        serviceResourceId: entry.serviceResourceId,
        versionId: entry.versionId,
        contentSha256: entry.contentSha256,
        baseSha256: readCacheSnapshot(root, entry.path)?.baseSha256 ?? null,
      })),
      ...missingCachePaths(root, entries).map(path => ({ path, missing: true })),
    ],
  }
}

/** Resolves a git ref (e.g. `origin/main`) to a SHA; null when absent/non-git. */
export type GitRefReader = (cwd: string, ref: string) => string | null

export function defaultGitRef(cwd: string, ref: string): string | null {
  try {
    // Strip repo-context env (set by git inside hooks) so the query answers
    // about `cwd`, not whatever repo GIT_DIR points at.
    const env: NodeJS.ProcessEnv = { ...process.env }
    delete env.GIT_DIR
    delete env.GIT_WORK_TREE
    delete env.GIT_INDEX_FILE
    const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd, encoding: 'utf8', env })
    if (result.status !== 0 || typeof result.stdout !== 'string') {
      return null
    }
    return result.stdout.trim() || null
  } catch {
    return null
  }
}

// ---- Thin entry point (index.ts dispatch calls this) ----------------------

export interface WorkspaceSyncIo {
  json: boolean
  print: (line: string) => void
  fetcher?: WorkspaceSyncFetcher
}

const WORKSPACE_USAGE = 'Usage: orizu workspace <status|sync|pull|apply> [<path>] [--remote] [--json]'

/**
 * `orizu workspace <status|sync|pull|apply>`. The requests, the deadline,
 * Ctrl-C and the folder lock live in workspace-sync-workflow.ts, loaded only
 * here, so other commands never load Effect.
 */
export async function workspaceSyncCommand(args: string[], io: WorkspaceSyncIo): Promise<number> {
  const positional = args.filter(arg => !arg.startsWith('--'))
  const subcommand = positional[0]
  const target = positional[1]
  const remote = args.includes('--remote')
  if (subcommand === 'status' || subcommand === 'sync' || ((subcommand === 'pull' || subcommand === 'apply') && target)) {
    const { runWorkspaceCommand } = await import('./workspace-sync-workflow.js')
    return await runWorkspaceCommand({ subcommand, target: target ?? null, remote }, io)
  }
  io.print(WORKSPACE_USAGE)
  return 1
}
