/**
 * Workspace tracked-resource sync commands (ALI-976 CLI half, revised spec).
 *
 * Pure logic + injected HTTP: no process.argv parsing and no printing live in
 * the command functions (the thin `workspaceSyncCommand` entry point prints).
 * This module implements the client side of the ALI-933 sync semantics:
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
import { createHash } from 'crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'fs'
import { join, relative, sep } from 'path'

import { authedFetch } from './http.js'
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

export function writeCacheSnapshot(cwd: string, snapshot: CacheSnapshot): void {
  const file = cacheSnapshotPath(cwd, snapshot.path)
  mkdirSync(join(getWorkspaceRoot(cwd), CACHE_SYNC_SUBDIR), { recursive: true })
  writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`)
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
function missingCachePaths(cwd: string, inventory: InventoryEntry[]): string[] {
  const inventoryPaths = new Set(inventory.map(entry => entry.path))
  return listCacheSnapshots(cwd)
    .map(snapshot => snapshot.path)
    .filter(path => !inventoryPaths.has(path))
}

// Record the server row id WITHOUT advancing the base: base/versionId move
// only on a clean confirmation or on pull/apply; the row id is pure identity
// and is safe to persist for every sync response.
function recordCacheResourceId(cwd: string, path: string, resourceId: string | null): void {
  if (!resourceId) {
    return
  }
  const existing = readCacheSnapshot(cwd, path)
  if (existing?.resourceId === resourceId) {
    return
  }
  // Preserve every other field (base/version/lastSynced AND the §3.3
  // content-pending guard): recording a row id must never advance the base nor
  // silently clear a pending mark. A non-clean sync between pull and apply keeps
  // the guard intact; only a `clean` convergence (or a reconciled apply/pull)
  // clears it.
  writeCacheSnapshot(cwd, {
    ...(existing ?? { path, baseSha256: null, versionId: null, lastSyncedAt: null }),
    path,
    resourceId,
  })
}

// ---- Manifest edits (preserve all other fields + formatting) --------------

function writeManifest(absPath: string, manifest: Record<string, unknown>): void {
  writeFileSync(absPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

function patchCanonical(absPath: string, patch: Record<string, unknown>): void {
  const manifest = readJsonManifest(absPath) ?? {}
  const canonical = { ...readCanonical(manifest), ...patch }
  writeManifest(absPath, { ...manifest, canonical })
}

// Attach writes ONLY `setup.attachedWorkspaceId` (ALI-1075: fresh manifests
// carry no `canonical` block and attach must not resurrect one). A legacy
// manifest that still has `canonical.serviceId` gets it updated in place so
// the two ids can never disagree; it is never created.
function patchTeamWorkspaceId(root: string, workspaceId: string): void {
  const absPath = join(root, 'orizu.team.json')
  const manifest = readJsonManifest(absPath) ?? {}
  const legacyCanonical = readCanonical(manifest)
  const canonicalPatch = 'serviceId' in legacyCanonical
    ? { canonical: { ...legacyCanonical, serviceId: workspaceId } }
    : {}
  const setupRaw = manifest.setup
  const setup = { ...(setupRaw && typeof setupRaw === 'object' && !Array.isArray(setupRaw) ? setupRaw : {}), attachedWorkspaceId: workspaceId }
  writeManifest(absPath, { ...manifest, ...canonicalPatch, setup })
}

// ---- HTTP helpers ---------------------------------------------------------

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>
  } catch {
    return {}
  }
}

interface SyncResourceResult {
  /** Server tracked-resource ROW id (null for untracked — no row exists). */
  id: string | null
  path: string
  status: string
  serverVersionId: string | null
  serverSha256: string | null
  lastSyncedAt: string | null
}

function teamSlugOf(root: string): string {
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

// Create-or-attach the server workspace. Deliberately does NOT write the
// manifest: the caller persists the id only after the first sync round-trip
// succeeds, so a failed sync never leaves a partially-attached manifest.
async function createOrAttachWorkspace(root: string, fetcher: WorkspaceSyncFetcher): Promise<string> {
  const teamSlug = teamSlugOf(root)
  const response = await fetcher('/api/cli/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamSlug, name: teamSlug, slug: teamSlug }),
  })
  if (!response.ok) {
    const error = await readJson(response)
    throw new Error(`Failed to attach workspace: ${stringOrNull(error.error) || response.status}`)
  }
  const data = await readJson(response)
  const workspace = data.workspace as Record<string, unknown> | undefined
  const id = stringOrNull(workspace?.id)
  if (!id) {
    throw new Error('Workspace attach response did not include an id')
  }
  return id
}

function requireAttachedWorkspaceId(root: string, opts: CommonOptions): string {
  const known = stringOrNull(opts.workspaceId ?? undefined) || attachedWorkspaceId(root)
  if (!known) {
    throw new Error('This workspace is not attached yet. Run `orizu workspace sync` first to attach it.')
  }
  return known
}

// One entry per inventoried path plus `{path, missing: true}` for every
// cache-known path absent from the inventory (spec §3.1 missing transport).
function syncBody(root: string, entries: InventoryEntry[]) {
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

async function callSync(root: string, workspaceId: string, entries: InventoryEntry[], fetcher: WorkspaceSyncFetcher): Promise<SyncResourceResult[]> {
  const response = await fetcher(`/api/cli/workspaces/${workspaceId}/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(syncBody(root, entries)),
  })
  if (!response.ok) {
    const error = await readJson(response)
    throw new Error(`Sync failed: ${stringOrNull(error.error) || response.status}`)
  }
  const data = await readJson(response)
  return (Array.isArray(data.resources) ? data.resources : []) as SyncResourceResult[]
}

// ---- Commands -------------------------------------------------------------

export interface StatusResourceLine {
  path: string
  kind: TrackedResourceKind | null
  owner: CanonicalOwner | null
  repoState: RepoState | null
  localSha: string | null
  baseSha: string | null
  dirty: boolean
  /**
   * Metadata-only-pull guard (spec §3.3): the base was pulled ahead of the
   * working content, so `apply` will refuse until the bytes are delivered.
   */
  contentPending?: boolean
  /** Definitional local statuses: cache-known-but-deleted / rule-less files. */
  localStatus?: 'missing' | 'untracked'
  remoteStatus?: string
  serverVersionId?: string | null
}

// -- Hosted-repo freshness + stale-branch report (ALI-996 / WS-G, ALI-972) ----

/** Resolves a git ref (e.g. `origin/main`) to a SHA; null when absent/non-git. */
export type GitRefReader = (cwd: string, ref: string) => string | null

function defaultGitRef(cwd: string, ref: string): string | null {
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

/**
 * "repo moved since your last pull" — the server's recorded DEFAULT-branch push
 * SHA differs from what the LOCAL repo knows the default branch to be. Compared
 * against the default-branch ref (never bare HEAD) so being on a feature branch
 * or carrying local commits never triggers a false positive.
 */
export interface FreshnessSignal {
  serverSha: string
  branch: string | null
  pushedAt: string | null
  localDefaultSha: string
}

/** A session branch worth reporting: an old active session or an ended, unmerged one. */
export interface StaleSessionBranch {
  sessionId: string
  branch: string
  startedAt: string | null
  reason: 'active-stale' | 'unmerged'
}

const STALE_ACTIVE_MS = 24 * 60 * 60 * 1000

// Fetch the workspace record and compare its recorded DEFAULT-branch push SHA
// against what the local repo knows that same branch to be. Best-effort: any
// server/non-hosted/non-git/unknown-branch condition yields null so `status`
// never fails — and never false-warns — for a local-only, offline, or
// feature-branch checkout.
async function fetchFreshness(
  root: string,
  workspaceId: string,
  fetcher: WorkspaceSyncFetcher,
  gitRef: GitRefReader
): Promise<FreshnessSignal | null> {
  const teamSlug = teamSlugOf(root)
  const response = await fetcher(`/api/cli/workspaces?team=${encodeURIComponent(teamSlug)}`)
  if (!response.ok) return null
  const data = await readJson(response)
  const workspaces = Array.isArray(data.workspaces) ? (data.workspaces as Array<Record<string, unknown>>) : []
  const ws = workspaces.find(item => stringOrNull(item.id) === workspaceId) ?? null
  const serverSha = ws ? stringOrNull(ws.repoLastPushSha) : null
  const branch = ws ? stringOrNull(ws.repoLastPushBranch) : null
  // Without the server's default-branch name we cannot locate the right local
  // ref to compare — stay silent rather than compare against the wrong branch.
  if (!serverSha || !branch) return null
  // Prefer the remote-tracking ref (what the last fetch/pull observed on the
  // default branch); fall back to the local branch. HEAD is deliberately NOT
  // used: a feature-branch checkout must never read as "repo moved".
  const localDefaultSha = gitRef(root, `origin/${branch}`) ?? gitRef(root, branch)
  if (!localDefaultSha || localDefaultSha === serverSha) return null
  return {
    serverSha,
    branch,
    pushedAt: stringOrNull(ws?.repoLastPushAt ?? null),
    localDefaultSha,
  }
}

// List the workspace's branched sessions and flag the stale ones. Report,
// don't reap (ALI-972): active sessions still holding a branch past 24h, and
// ended sessions whose branch metadata persists (unmerged write-back).
async function fetchStaleSessionBranches(
  workspaceId: string,
  fetcher: WorkspaceSyncFetcher,
  now: number
): Promise<StaleSessionBranch[]> {
  const response = await fetcher(`/api/cli/workspaces/${workspaceId}/sessions?branched=true`)
  if (!response.ok) return []
  const data = await readJson(response)
  const sessions = Array.isArray(data.sessions) ? (data.sessions as Array<Record<string, unknown>>) : []
  const stale: StaleSessionBranch[] = []
  for (const session of sessions) {
    const branch = stringOrNull(session.repoBranch)
    if (!branch) continue
    const status = stringOrNull(session.status)
    const startedAt = stringOrNull(session.startedAt)
    const sessionId = stringOrNull(session.id) ?? ''
    if (status === 'active') {
      const started = startedAt ? Date.parse(startedAt) : NaN
      if (!Number.isNaN(started) && now - started > STALE_ACTIVE_MS) {
        stale.push({ sessionId, branch, startedAt, reason: 'active-stale' })
      }
    } else if (status === 'ended') {
      stale.push({ sessionId, branch, startedAt, reason: 'unmerged' })
    }
  }
  return stale
}

export interface StatusResult {
  root: string
  workspaceId: string | null
  remote: boolean
  resources: StatusResourceLine[]
  /** Set only when the hosted repo's default branch moved past the local ref (ALI-996). */
  freshness?: FreshnessSignal | null
  /** Branched sessions worth attention; empty for local-only workspaces (ALI-972). */
  staleSessionBranches?: StaleSessionBranch[]
}

export async function runWorkspaceStatus(
  opts: CommonOptions & { remote?: boolean; gitRef?: GitRefReader; now?: () => number } = {}
): Promise<StatusResult> {
  const root = getWorkspaceRoot(opts.cwd)
  const fetcher = opts.fetcher ?? authedFetch
  const inventory = collectInventory(root)

  const lines: StatusResourceLine[] = inventory.map(entry => {
    const snapshot = readCacheSnapshot(root, entry.path)
    const base = snapshot?.baseSha256 ?? null
    // Surface the §3.3 guard only while it still bites: if the working content
    // has since reconciled to the pending base, apply would clear it and proceed.
    const pendingBase = snapshot?.contentPending === true
      ? stringOrNull(snapshot.pendingBaseSha256 ?? snapshot.baseSha256 ?? null)
      : null
    const contentPending = pendingBase !== null && pendingBase !== entry.contentSha256
    return {
      path: entry.path,
      kind: entry.kind,
      owner: entry.owner,
      repoState: entry.repoState,
      localSha: entry.contentSha256,
      baseSha: base,
      dirty: base !== null && base !== entry.contentSha256,
      ...(contentPending ? { contentPending: true } : {}),
    }
  })

  // Cache-known paths that no longer exist on disk (spec §3.2 `missing`).
  for (const path of missingCachePaths(root, inventory)) {
    lines.push({
      path,
      kind: null,
      owner: null,
      repoState: null,
      localSha: null,
      baseSha: readCacheSnapshot(root, path)?.baseSha256 ?? null,
      dirty: false,
      localStatus: 'missing',
    })
  }

  // Rule-less files under managed dirs (spec §3.2 `untracked`) — local only.
  for (const path of collectUntrackedPaths(root, inventory)) {
    lines.push({
      path,
      kind: null,
      owner: null,
      repoState: null,
      localSha: null,
      baseSha: null,
      dirty: false,
      localStatus: 'untracked',
    })
  }

  let workspaceId: string | null = opts.workspaceId ?? attachedWorkspaceId(root)
  if (opts.remote) {
    // No read-only remote status exists in v0 (spec §3.1): this is the same
    // server-side reconciliation as `sync` (it registers/updates records).
    // It never writes the local cache, though.
    workspaceId = requireAttachedWorkspaceId(root, opts)
    const remote = await callSync(root, workspaceId, inventory, fetcher)
    const byPath = new Map(remote.map(item => [item.path, item]))
    for (const line of lines) {
      const match = byPath.get(line.path)
      if (match) {
        line.remoteStatus = match.status
        line.serverVersionId = match.serverVersionId
      }
    }
  }

  // Hosted-repo freshness + stale-branch report (best-effort): only for attached
  // workspaces, and every server/non-git failure is swallowed so a local-only or
  // offline `status` behaves exactly as before.
  let freshness: FreshnessSignal | null = null
  let staleSessionBranches: StaleSessionBranch[] = []
  if (workspaceId) {
    const gitRef = opts.gitRef ?? defaultGitRef
    const now = (opts.now ?? (() => Date.now()))()
    try {
      freshness = await fetchFreshness(root, workspaceId, fetcher, gitRef)
    } catch {
      freshness = null
    }
    try {
      staleSessionBranches = await fetchStaleSessionBranches(workspaceId, fetcher, now)
    } catch {
      staleSessionBranches = []
    }
  }

  return { root, workspaceId, remote: Boolean(opts.remote), resources: lines, freshness, staleSessionBranches }
}

export interface SyncResultLine extends SyncResourceResult {
  cacheAdvanced: boolean
}

export interface SyncResult {
  root: string
  workspaceId: string
  resources: SyncResultLine[]
}

export async function runWorkspaceSync(opts: CommonOptions = {}): Promise<SyncResult> {
  const root = getWorkspaceRoot(opts.cwd)
  const fetcher = opts.fetcher ?? authedFetch
  const knownId = stringOrNull(opts.workspaceId ?? undefined) || attachedWorkspaceId(root)
  const workspaceId = knownId ?? await createOrAttachWorkspace(root, fetcher)
  const inventory = collectInventory(root)
  const remote = await callSync(root, workspaceId, inventory, fetcher)

  // Persist the attachment only after the sync round-trip succeeded, so a
  // failed first sync leaves orizu.team.json byte-identical.
  if (!knownId) {
    patchTeamWorkspaceId(root, workspaceId)
  }

  const resources: SyncResultLine[] = remote.map(item => {
    // Cache base advances ONLY on a `clean` convergence confirmation; every
    // other status leaves the last-sync base untouched (spec §3.1 metadata-first).
    // The server row id, however, is recorded for EVERY returned resource —
    // it is what `apply` addresses, so losing it would strand new resources.
    const resourceId = stringOrNull(item.id) ?? readCacheSnapshot(root, item.path)?.resourceId ?? null
    let cacheAdvanced = false
    if (item.status === 'clean') {
      writeCacheSnapshot(root, {
        path: item.path,
        baseSha256: item.serverSha256,
        versionId: item.serverVersionId,
        lastSyncedAt: item.lastSyncedAt,
        resourceId,
      })
      cacheAdvanced = true
    } else {
      recordCacheResourceId(root, item.path, resourceId)
    }
    return { ...item, cacheAdvanced }
  })

  return { root, workspaceId, resources }
}

export interface PullResult {
  path: string
  status: 'converged' | 'refused' | 'noop'
  remoteStatus: string | null
  reason?: string
  note?: string
  manifestUpdated: boolean
  cacheAdvanced: boolean
}

export async function runWorkspacePull(targetPath: string, opts: CommonOptions = {}): Promise<PullResult> {
  const root = getWorkspaceRoot(opts.cwd)
  const fetcher = opts.fetcher ?? authedFetch
  const entry = collectInventory(root).find(item => item.path === targetPath)
  if (!entry) {
    const known = readCacheSnapshot(root, targetPath)
    return {
      path: targetPath,
      status: 'noop',
      remoteStatus: null,
      reason: known
        ? `File is missing locally at ${targetPath}. Restore it via Git; v0 pull reconciles metadata only and does not materialize content.`
        : `No tracked resource at ${targetPath}`,
      manifestUpdated: false,
      cacheAdvanced: false,
    }
  }

  const workspaceId = requireAttachedWorkspaceId(root, opts)
  const results = await callSync(root, workspaceId, [entry], fetcher)
  const remote = results.find(item => item.path === entry.path) ?? null
  const remoteStatus = remote?.status ?? null

  if (remoteStatus === 'divergent' || remoteStatus === 'conflicted') {
    return {
      path: targetPath,
      status: 'refused',
      remoteStatus,
      reason: 'Pull refused: local edits are ahead of the last-sync base; resolve in the working tree (Git) or `apply` to promote.',
      manifestUpdated: false,
      cacheAdvanced: false,
    }
  }

  // Fast-forward ONLY from server-carried truth. Truthless statuses
  // (local-only/stale/missing/untracked) have nothing to pull; fabricating a
  // base from local bytes is forbidden (spec §3.2).
  const serverSha256 = stringOrNull(remote?.serverSha256 ?? null)
  const serverVersionId = stringOrNull(remote?.serverVersionId ?? null)
  if (!remote || serverSha256 === null) {
    const reason = remoteStatus === 'stale'
      ? 'Nothing to pull: no verifiable server truth for this resource. Refresh it through the primitive-specific command (e.g. `orizu prompts pull`, `orizu datasets download`), then sync.'
      : 'Nothing to pull: this resource has no server truth yet. `orizu workspace apply` promotes repo-owned resources; run `orizu workspace sync` first if it is not registered.'
    return { path: targetPath, status: 'noop', remoteStatus, reason, manifestUpdated: false, cacheAdvanced: false }
  }

  // Metadata fast-forward: advance cache base + manifest canonical to the
  // SERVER truth (never local bytes). v0 is metadata-level: source bytes
  // converge through Git; DB-native/object bytes materialize via the
  // primitive-specific commands.
  //
  // Metadata-only-pull guard (spec §3.3): this pull advanced the base to the
  // server hash WITHOUT delivering the bytes. For a repo-owned resource whose
  // working content does not already match that hash, the working tree is now
  // BEHIND the base — a naive three-way read would call it `divergent` and a
  // CAS `apply` would pass (base == server truth) and silently revert the
  // pulled version. Mark the resource content-pending so `apply` refuses until
  // Git delivers the bytes (working == base again). If the content already
  // matches (Git first, the §7 happy path), leave it unmarked.
  const contentPending = entry.owner === 'repo' && entry.contentSha256 !== serverSha256
  writeCacheSnapshot(root, {
    path: entry.path,
    baseSha256: serverSha256,
    versionId: serverVersionId,
    lastSyncedAt: remote.lastSyncedAt ?? new Date().toISOString(),
    resourceId: stringOrNull(remote.id) ?? readCacheSnapshot(root, entry.path)?.resourceId ?? null,
    ...(contentPending
      ? { contentPending: true, pendingBaseSha256: serverSha256 }
      : {}),
  })
  let manifestUpdated = false
  if (entry.manifestPath) {
    patchCanonical(entry.manifestPath, {
      versionId: serverVersionId,
      contentSha256: serverSha256,
      lastPulledAt: remote.lastSyncedAt ?? new Date().toISOString(),
    })
    manifestUpdated = true
  }

  const note = contentPending
    ? 'Base advanced to the server version but the working content has not been delivered yet (content-pending). `apply` will refuse until Git delivers the new bytes (working == base); run `git pull` to fetch them first.'
    : entry.owner === 'repo'
      ? undefined
      : 'v0 pull reconciles metadata only; materialize bulk content with the primitive-specific command (e.g. `orizu prompts pull`, `orizu datasets download`).'
  return { path: targetPath, status: 'converged', remoteStatus, note, manifestUpdated, cacheAdvanced: true }
}

export interface ApplyResult {
  path: string
  status: 'applied' | 'refused' | 'noop'
  reason?: string
  /** Recovery guidance for server 409 refusals (re-sync, then re-drive). */
  hint?: string
  versionId?: string | null
  contentSha256?: string | null
  lastSyncedAt?: string | null
  manifestUpdated: boolean
  cacheAdvanced: boolean
}

export async function runWorkspaceApply(targetPath: string, opts: CommonOptions = {}): Promise<ApplyResult> {
  const root = getWorkspaceRoot(opts.cwd)
  const fetcher = opts.fetcher ?? authedFetch
  const entry = collectInventory(root).find(item => item.path === targetPath)
  if (!entry) {
    return { path: targetPath, status: 'noop', reason: `No tracked resource at ${targetPath}`, manifestUpdated: false, cacheAdvanced: false }
  }
  if (entry.owner !== 'repo') {
    return {
      path: targetPath,
      status: 'refused',
      reason: `Apply refused: ${entry.owner} resources are pull-only; change DB-native state through the primitive's own command and promotion flow.`,
      manifestUpdated: false,
      cacheAdvanced: false,
    }
  }
  // Apply identity (spec §3.1): STRICTLY the sync-recorded tracked-resource
  // row id. The manifest's canonical.serviceId is informational/legacy and is
  // never used — the API resolves by row id only, so a serviceId would 404.
  const snapshot = readCacheSnapshot(root, entry.path)
  const resourceId = stringOrNull(snapshot?.resourceId ?? null)
  if (!resourceId) {
    return {
      path: targetPath,
      status: 'noop',
      reason: 'No server tracked-resource id is recorded for this path. Run `orizu workspace sync` first to register it and record its row id, then retry apply.',
      manifestUpdated: false,
      cacheAdvanced: false,
    }
  }

  // Metadata-only-pull guard (spec §3.3): a prior `pull` advanced the base to
  // the server hash without delivering the bytes. If the working content still
  // doesn't match that pulled base, the working tree is BEHIND and a CAS apply
  // would pass (base == server truth) and silently revert the pulled version.
  // Refuse before any server call. Once Git delivers the bytes (working ==
  // pending base), clear the mark and proceed — a genuine later edit off that
  // base is then a legitimate, applyable `divergent`.
  if (snapshot?.contentPending === true) {
    const pendingBase = stringOrNull(snapshot.pendingBaseSha256 ?? snapshot.baseSha256 ?? null)
    if (pendingBase !== null && entry.contentSha256 !== pendingBase) {
      return {
        path: targetPath,
        status: 'refused',
        reason: 'Apply refused: this resource is content-pending — a metadata-only pull advanced its base but the working file still holds the old content. Reconcile the working file to the pulled base first (e.g. `git pull`, or re-pull once Git has delivered the content), then retry apply.',
        manifestUpdated: false,
        cacheAdvanced: false,
      }
    }
    // Working content now matches the pulled base — the pull is fully realized.
    writeCacheSnapshot(root, { ...snapshot, contentPending: false, pendingBaseSha256: null })
  }

  const workspaceId = requireAttachedWorkspaceId(root, opts)
  const baseSha = snapshot?.baseSha256 ?? null
  const response = await fetcher(`/api/cli/workspaces/${workspaceId}/resources/${resourceId}/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentSha256: entry.contentSha256, baseSha256: baseSha }),
  })

  if (response.status === 409) {
    // Owner refusal, conflicted, remote-newer, or CAS loss — in every case
    // the recovery loop is the same: re-sync, converge, retry.
    const error = await readJson(response)
    return {
      path: targetPath,
      status: 'refused',
      reason: stringOrNull(error.error) || 'Apply refused',
      hint: 'Run `orizu workspace sync` to refresh statuses, converge per the reported status (pull/merge), then retry the apply.',
      manifestUpdated: false,
      cacheAdvanced: false,
    }
  }
  if (!response.ok) {
    const error = await readJson(response)
    throw new Error(`Apply failed: ${stringOrNull(error.error) || response.status}`)
  }

  const data = await readJson(response)
  const resource = (data.resource as Record<string, unknown>) ?? {}
  const versionId = stringOrNull(resource.versionId)
  const contentSha256 = stringOrNull(resource.contentSha256) ?? entry.contentSha256
  const lastSyncedAt = stringOrNull(resource.lastSyncedAt) ?? new Date().toISOString()

  if (entry.manifestPath) {
    patchCanonical(entry.manifestPath, { versionId, contentSha256, lastPulledAt: lastSyncedAt })
  }
  writeCacheSnapshot(root, {
    path: entry.path,
    baseSha256: contentSha256,
    versionId,
    lastSyncedAt,
    resourceId: stringOrNull(resource.id) ?? resourceId,
  })

  return {
    path: targetPath,
    status: 'applied',
    versionId,
    contentSha256,
    lastSyncedAt,
    manifestUpdated: Boolean(entry.manifestPath),
    cacheAdvanced: true,
  }
}

// ---- Thin entry point (index.ts dispatch calls this) ----------------------

export interface WorkspaceSyncIo {
  json: boolean
  print: (line: string) => void
  fetcher?: WorkspaceSyncFetcher
}

function emit(io: WorkspaceSyncIo, human: string, payload: Record<string, unknown>) {
  io.print(io.json ? JSON.stringify(payload) : human)
}

export async function workspaceSyncCommand(args: string[], io: WorkspaceSyncIo): Promise<number> {
  const positional = args.filter(arg => !arg.startsWith('--'))
  const subcommand = positional[0]
  const target = positional[1]
  const remote = args.includes('--remote')
  const fetcher = io.fetcher

  if (subcommand === 'status') {
    const result = await runWorkspaceStatus({ remote, fetcher })
    const lines = result.resources.map(r =>
      `${r.dirty ? '*' : ' '} ${r.path}  [${r.kind ?? '?'}/${r.owner ?? '?'}/${r.repoState ?? '?'}]`
      + `${r.localStatus ? `  ${r.localStatus}` : ''}${r.remoteStatus ? `  ${r.remoteStatus}` : ''}`
      + `${r.contentPending ? '  (content-pending)' : ''}`
    )
    if (result.freshness) {
      const { serverSha, branch, pushedAt } = result.freshness
      lines.push(
        `repo moved since your last pull: ${serverSha}`
        + `${branch ? ` on ${branch}` : ''}${pushedAt ? ` at ${pushedAt}` : ''}`
      )
    }
    if (result.staleSessionBranches && result.staleSessionBranches.length > 0) {
      lines.push('stale session branches:')
      for (const stale of result.staleSessionBranches) {
        const detail = stale.reason === 'active-stale' ? 'active >24h' : 'unmerged'
        lines.push(`  ${stale.branch} (started ${stale.startedAt ?? '?'}, ${detail})`)
      }
    }
    emit(io, ['workspace status', ...lines].join('\n'), result as unknown as Record<string, unknown>)
    return 0
  }
  if (subcommand === 'sync') {
    const result = await runWorkspaceSync({ fetcher })
    const lines = result.resources.map(r => `${r.status.padEnd(13)} ${r.path}`)
    emit(io, [`workspace sync (workspace ${result.workspaceId})`, ...lines].join('\n'), result as unknown as Record<string, unknown>)
    return 0
  }
  if (subcommand === 'pull' && target) {
    const result = await runWorkspacePull(target, { fetcher })
    const human = [`${result.status}: ${result.path}${result.reason ? ` — ${result.reason}` : ''}`, result.note].filter(Boolean).join('\n')
    emit(io, human, result as unknown as Record<string, unknown>)
    return result.status === 'refused' ? 1 : 0
  }
  if (subcommand === 'apply' && target) {
    const result = await runWorkspaceApply(target, { fetcher })
    const human = [`${result.status}: ${result.path}${result.reason ? ` — ${result.reason}` : ''}`, result.hint]
      .filter(Boolean)
      .join('\n')
    emit(io, human, result as unknown as Record<string, unknown>)
    return result.status === 'applied' ? 0 : 1
  }

  io.print('Usage: orizu workspace <status|sync|pull|apply> [<path>] [--remote] [--json]')
  return 1
}
