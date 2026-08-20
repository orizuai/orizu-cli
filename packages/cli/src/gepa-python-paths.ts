import { existsSync } from 'fs'
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
  const candidates = [
    fileURLToPath(new URL('../vendor/gepa-python/src', import.meta.url)),
  ]

  return resolveGepaPythonPath(candidates)
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
