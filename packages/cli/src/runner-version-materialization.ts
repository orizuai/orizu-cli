import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ARTIFACT_MAX_BYTES } from './artifact-pull.js'
import { cleanupAll, throwWithCleanup } from './cleanup.js'
import { authedFetch } from './http.js'
import { sanitizeTerminalText } from './json-response.js'
function unzip(zipPath: string, runnerDir: string): void {
  const listing = spawnSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
  if (listing.error) throw listing.error
  if (listing.status !== 0) throw new Error(`unzip listing failed: ${sanitizeTerminalText(listing.stderr || listing.stdout || '')}`)
  const unsafe = listing.stdout.split(/\r?\n/u).filter(Boolean).find(name => {
    const normalized = name.replaceAll('\\', '/')
    return normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized)
      || normalized.split('/').some(part => part === '..')
  })
  if (unsafe) throw new Error('Runner archive contains an unsafe path')
  const result = spawnSync('unzip', ['-q', zipPath, '-d', runnerDir], { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`unzip failed: ${sanitizeTerminalText(result.stderr || result.stdout || '')}`)
}
export async function materializeRunnerVersion(runnerVersionId: string, verifyRegisteredDigest = true): Promise<{
  runnerDir: string; cleanup: () => void
}> {
  let contentSha256: string | undefined
  if (verifyRegisteredDigest) {
    const detailResponse = await authedFetch(`/api/cli/runner-versions/${encodeURIComponent(runnerVersionId)}`)
    if (!detailResponse.ok) throw new Error(`Failed to resolve runner version: ${await detailResponse.text()}`)
    const detail = await detailResponse.json() as Record<string, unknown>
    if (detail.runnerVersionId !== runnerVersionId || detail.status !== 'sealed'
      || typeof detail.contentSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(detail.contentSha256)) {
      throw new Error('Runner version detail is invalid')
    }
    contentSha256 = detail.contentSha256
  }
  const response = await authedFetch(`/api/cli/runner-versions/${encodeURIComponent(runnerVersionId)}/download`)
  if (!response.ok) throw new Error(`Failed to download runner version: ${await response.text()}`)
  const tempDir = mkdtempSync(join(tmpdir(), 'orizu-runner-version-'))
  const cleanup = () => rmSync(tempDir, { recursive: true, force: true })
  try {
    const zipBytes = new Uint8Array(await response.arrayBuffer())
    if (zipBytes.byteLength > ARTIFACT_MAX_BYTES) throw new Error(`Runner artifact exceeds ${ARTIFACT_MAX_BYTES} bytes`)
    if (contentSha256 && createHash('sha256').update(zipBytes).digest('hex') !== contentSha256) throw new Error('Runner artifact digest mismatch')
    const zipPath = join(tempDir, 'runner.zip'), runnerDir = join(tempDir, 'runner')
    writeFileSync(zipPath, zipBytes)
    unzip(zipPath, runnerDir)
    return { runnerDir, cleanup }
  } catch (error) {
    throwWithCleanup(error, [cleanup], `Runner ${runnerVersionId} materialization failed and cleanup also failed`)
  }
}
export function cleanupMaterializedRunners(cleanups: Array<() => void>): void {
  cleanupAll(cleanups, 'Failed to clean materialized runner directories')
}
