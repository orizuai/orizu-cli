import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// ORI-2805: telling a remote runner (ADR-042) from a packaged one. Kept apart
// from remote-runner-manifest.ts so packaged runners and other commands never
// load Effect.

/** True for a manifest that describes a remote runner; a missing kind is a packaged runner. */
export function isRemoteManifest(manifest: unknown): boolean {
  return Boolean(manifest) && typeof manifest === 'object' && (manifest as { kind?: unknown }).kind === 'remote'
}

/** The parsed manifest.json of a runner folder, or null when it has none or it is not JSON. */
export function readRawRunnerManifest(runnerDir: string): unknown {
  const path = join(runnerDir, 'manifest.json')
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}
