import { existsSync } from 'fs'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'

import { isOrizuSourceCheckout } from '../scripts/orizu-source-checkout.mjs'

function prefersLiveSource(): boolean {
  // The source candidates belong to this monorepo only when the candidate
  // root identifies itself as Orizu. A consumer's .git marker is not proof:
  // npm installs commonly live inside another repository.
  return isOrizuSourceCheckout(fileURLToPath(new URL('../../../package.json', import.meta.url)))
}

export function resolveGepaPythonPath(
  candidates: string[],
  pathExists: (candidate: string) => boolean = existsSync
): string | null {
  return candidates.find(pathExists) ?? null
}

export function bundledOrizuGepaPythonPath(): string | null {
  const source = fileURLToPath(new URL('../../orizu-gepa-python/src', import.meta.url))
  const vendor = fileURLToPath(new URL('../vendor/orizu-gepa-python/src', import.meta.url))
  const candidates = prefersLiveSource() ? [source, vendor] : [vendor]

  return resolveGepaPythonPath(candidates)
}

export function bundledOrizuGepaConnectorPythonPath(): string | null {
  const source = fileURLToPath(new URL('../../orizu-gepa/src', import.meta.url))
  const vendor = fileURLToPath(new URL('../vendor/orizu-gepa/src', import.meta.url))
  const candidates = prefersLiveSource() ? [source, vendor] : [vendor]

  return resolveGepaPythonPath(candidates)
}

export function bundledOfficialGepaPythonPath(): string | null {
  const vendor = fileURLToPath(new URL('../vendor/gepa-python/src', import.meta.url))
  if (prefersLiveSource()) {
    const requiredVendorFiles = [
      fileURLToPath(new URL('../vendor/gepa-python/manifest.json', import.meta.url)),
      fileURLToPath(new URL('../vendor/gepa-python/src/gepa/__init__.py', import.meta.url)),
      fileURLToPath(new URL('../vendor/gepa-python/src/gepa/adapters/optimize_anything_adapter/optimize_anything_adapter.py', import.meta.url)),
    ]
    if (!requiredVendorFiles.every(existsSync)) {
      const vendoringScript = fileURLToPath(new URL('../scripts/vendor-gepa-python.mjs', import.meta.url))
      try {
        execFileSync(process.execPath, [vendoringScript], { stdio: 'pipe' })
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error)
        throw new Error(`Unable to materialize bundled official GEPA: ${details}`)
      }
      if (!requiredVendorFiles.every(existsSync)) {
        throw new Error('Unable to materialize bundled official GEPA: extracted tree is incomplete')
      }
    }
  }

  // zipimport cannot resolve GEPA's namespace-package adapters on every
  // supported Python minor. Both source and published CLIs execute only the
  // verified tree materialized from the pinned wheel.
  return resolveGepaPythonPath([vendor])
}

export function getGepaPythonPathEntries(existingPythonPath: string | undefined): string[] {
  const pythonPathEntries = [
    bundledOrizuGepaConnectorPythonPath(),
    bundledOrizuGepaPythonPath(),
    bundledOfficialGepaPythonPath(),
    existingPythonPath,
  ].filter((entry): entry is string => Boolean(entry))

  return pythonPathEntries
}
