/**
 * Runner/optimizer artifact commands: list (discover names, version ids, and
 * labels) and pull (symmetric with `runners push` / `optimizers push` —
 * resolve by id or name, download the content-addressed zip from storage,
 * and extract it into --out). Pull writes version metadata to
 * .orizu/pull.json — .orizu/ is excluded from artifact zips (see
 * artifact-archive.ts), so a pulled directory re-pushes with an identical
 * content hash.
 *
 * Lives outside index.ts per the CLI index line ratchet (ALI-976): this module
 * owns its own argument parsing and printing via injected io.
 */

import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

import { authedFetch } from './http.js'

export type PullableArtifactKind = 'runner' | 'optimizer'

export interface PullArtifactIo {
  json: boolean
  print: (line: string) => void
  resolveProjectSlug: (projectArg: string | null) => Promise<string>
  fetcher?: (path: string, init?: RequestInit) => Promise<Response>
}

// Shared with the runners exec download path in index.ts.
export const ARTIFACT_MAX_BYTES = 25 * 1024 * 1024

function sanitizeTerminalText(value: unknown): string {
  return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
}

function expandHomePath(path: string): string {
  if (path.startsWith('~/')) {
    const home = process.env.HOME || ''
    return `${home}/${path.slice(2)}`
  }

  return path
}

function argValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag)
  if (index === -1 || index + 1 >= args.length || args[index + 1].startsWith('--')) {
    return null
  }
  return args[index + 1]
}

async function parseJsonPayload<T>(response: Response, context: string): Promise<T> {
  const contentType = response.headers.get('content-type') || ''
  const rawBody = await response.text()

  if (!contentType.includes('application/json')) {
    throw new Error(
      `${context} returned non-JSON response (status ${response.status}). ` +
      `Body preview: ${sanitizeTerminalText(rawBody.slice(0, 180))}`
    )
  }

  try {
    return JSON.parse(rawBody) as T
  } catch {
    throw new Error(
      `${context} returned invalid JSON (status ${response.status}). ` +
      `Body preview: ${sanitizeTerminalText(rawBody.slice(0, 180))}`
    )
  }
}

interface PullArtifactResponse {
  runner?: { id: string; name: string }
  optimizer?: { id: string; name: string }
  version: {
    id: string
    contentSha256?: string
    manifest?: Record<string, unknown>
    uploadedAt?: string
  }
  labels?: Array<{ label: string; runnerVersionId?: string; optimizerVersionId?: string }>
}

interface ArtifactListEntry {
  id: string
  name: string
  description?: string | null
  optimizerFamily?: string | null
  latestVersionId?: string | null
  versionCount?: number
  labels?: Array<{ label: string; runnerVersionId?: string; optimizerVersionId?: string }>
}

export async function runnerOptimizerCommand(args: string[], io: PullArtifactIo) {
  if (args[1] === 'list') {
    await listArtifactsCommand(args, io)
    return
  }
  await pullArtifactCommand(args, io)
}

async function listArtifactsCommand(args: string[], io: PullArtifactIo) {
  const kind: PullableArtifactKind = args[0] === 'runners' ? 'runner' : 'optimizer'
  const plural = kind === 'runner' ? 'runners' : 'optimizers'
  const fetcher = io.fetcher || authedFetch
  const project = argValue(args, '--project') || await io.resolveProjectSlug(null)

  const response = await fetcher(`/api/cli/${plural}?project=${encodeURIComponent(project)}`)
  if (!response.ok) {
    throw new Error(`Failed to fetch ${plural}: ${await response.text()}`)
  }

  const data = await parseJsonPayload<Record<string, ArtifactListEntry[]>>(response, `${plural} list`)
  if (io.json) {
    io.print(JSON.stringify(data))
    return
  }

  const items = data[plural] || []
  if (items.length === 0) {
    io.print(`No ${plural} found.`)
    return
  }

  const rows = items.map(item => ({
    id: sanitizeTerminalText(item.id),
    name: sanitizeTerminalText(item.name),
    versions: String(item.versionCount ?? 0),
    latest: sanitizeTerminalText(item.latestVersionId || '-'),
    labels: sanitizeTerminalText((item.labels || []).map(entry => entry.label).join(', ') || '-'),
  }))
  const idWidth = Math.max('ID'.length, ...rows.map(row => row.id.length))
  const nameWidth = Math.max('NAME'.length, ...rows.map(row => row.name.length))
  const versionsWidth = Math.max('VERSIONS'.length, ...rows.map(row => row.versions.length))
  const latestWidth = Math.max('LATEST VERSION'.length, ...rows.map(row => row.latest.length))

  io.print(`${'ID'.padEnd(idWidth)}  ${'NAME'.padEnd(nameWidth)}  ${'VERSIONS'.padEnd(versionsWidth)}  ${'LATEST VERSION'.padEnd(latestWidth)}  LABELS`)
  io.print(`${'-'.repeat(idWidth)}  ${'-'.repeat(nameWidth)}  ${'-'.repeat(versionsWidth)}  ${'-'.repeat(latestWidth)}  ${'-'.repeat('LABELS'.length)}`)
  rows.forEach(row => {
    io.print(`${row.id.padEnd(idWidth)}  ${row.name.padEnd(nameWidth)}  ${row.versions.padEnd(versionsWidth)}  ${row.latest.padEnd(latestWidth)}  ${row.labels}`)
  })
}

async function pullArtifactCommand(args: string[], io: PullArtifactIo) {
  const kind: PullableArtifactKind = args[0] === 'runners' ? 'runner' : 'optimizer'
  const fetcher = io.fetcher || authedFetch
  const positionalRef = args[2]
  const artifactRef = positionalRef && !positionalRef.startsWith('--') ? positionalRef : null
  const outDir = argValue(args, '--out')
  const label = argValue(args, '--label')
  const version = argValue(args, '--version')

  // Argument errors surface before project resolution, which may prompt
  // interactively when --project is omitted.
  const plural = kind === 'runner' ? 'runners' : 'optimizers'
  if (!artifactRef || !outDir) {
    throw new Error(`Usage: orizu ${plural} pull <${kind}-id-or-name> --project <team/project> --out <dir> [--label <label> | --version <version-id>] [--json]`)
  }
  if (label && version) {
    throw new Error('Use either --label or --version, not both')
  }

  const project = argValue(args, '--project') || await io.resolveProjectSlug(null)

  const params = new URLSearchParams({ project })
  if (label) params.set('label', label)
  if (version) params.set('version', version)

  const response = await fetcher(`/api/cli/${plural}/${encodeURIComponent(artifactRef)}?${params.toString()}`)
  if (!response.ok) {
    throw new Error(`Failed to pull ${kind}: ${await response.text()}`)
  }

  const data = await parseJsonPayload<PullArtifactResponse>(response, `${kind} pull`)
  const artifact = kind === 'runner' ? data.runner : data.optimizer
  if (!artifact) {
    throw new Error(`Failed to pull ${kind}: malformed response`)
  }
  // Every stored version is content-addressed; a missing hash would silently
  // void the integrity check and the pull.json anchor, so fail instead.
  if (!data.version.contentSha256) {
    throw new Error(`Failed to pull ${kind}: version ${data.version.id} has no content hash`)
  }

  const downloadResponse = await fetcher(`/api/cli/${kind}-versions/${encodeURIComponent(data.version.id)}/download`)
  if (!downloadResponse.ok) {
    throw new Error(`Failed to download ${kind} artifact: ${await downloadResponse.text()}`)
  }

  const zipBytes = new Uint8Array(await downloadResponse.arrayBuffer())
  if (zipBytes.byteLength > ARTIFACT_MAX_BYTES) {
    throw new Error(`${kind} artifact exceeds ${ARTIFACT_MAX_BYTES} bytes`)
  }

  // Versions are content-addressed by zip SHA256 (see the push routes), so a
  // corrupted or mismatched download is detectable before anything is written.
  const actualSha256 = createHash('sha256').update(zipBytes).digest('hex')
  if (actualSha256 !== data.version.contentSha256.toLowerCase()) {
    throw new Error(`${kind} artifact hash mismatch: expected ${data.version.contentSha256}, got ${actualSha256}`)
  }

  // Extraction is additive, so a dirty directory would mix files from other
  // versions and break the pull -> identical re-push hash guarantee.
  const targetDir = expandHomePath(outDir)
  mkdirSync(targetDir, { recursive: true })
  if (readdirSync(targetDir).length > 0) {
    throw new Error(`Output directory is not empty: ${targetDir}`)
  }

  const tempDir = mkdtempSync(join(tmpdir(), `orizu-${kind}-pull-`))
  try {
    const zipPath = join(tempDir, 'artifact.zip')
    writeFileSync(zipPath, zipBytes)
    // Artifacts are self-authored, hash-verified above, and served only to
    // authenticated project members; Info-ZIP additionally strips ../ path
    // components on extraction (same trust model as materializeRunnerVersion).
    const result = spawnSync('unzip', ['-q', zipPath, '-d', targetDir], {
      encoding: 'utf8',
    })
    if (result.error || result.status !== 0) {
      // targetDir was verified empty above, so everything in it came from
      // this extraction — clear it so a re-pull isn't rejected as non-empty.
      for (const entry of readdirSync(targetDir)) {
        rmSync(join(targetDir, entry), { recursive: true, force: true })
      }
      if (result.error) {
        throw result.error
      }
      throw new Error(`unzip failed: ${sanitizeTerminalText(result.stderr || result.stdout || '')}`)
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }

  const versionLabels = (data.labels || [])
    .filter(item => (kind === 'runner' ? item.runnerVersionId : item.optimizerVersionId) === data.version.id)
    .map(item => item.label)

  const pullMetadataPath = join(targetDir, '.orizu', 'pull.json')
  mkdirSync(dirname(pullMetadataPath), { recursive: true })
  writeFileSync(pullMetadataPath, `${JSON.stringify({
    schema_version: `orizu.${kind}-pull.v1`,
    name: artifact.name,
    [`${kind}_id`]: artifact.id,
    version_id: data.version.id,
    content_sha256: data.version.contentSha256,
    labels: versionLabels,
  }, null, 2)}\n`)

  if (io.json) {
    io.print(JSON.stringify({
      [`${kind}_id`]: artifact.id,
      [`${kind}_version_id`]: data.version.id,
      path: targetDir,
    }))
    return
  }

  io.print(`Pulled ${kind} ${sanitizeTerminalText(artifact.name)} to ${sanitizeTerminalText(targetDir)}`)
}
