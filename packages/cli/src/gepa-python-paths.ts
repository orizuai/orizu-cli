import { existsSync } from 'fs'
import { fileURLToPath } from 'url'

export function bundledOrizuGepaPythonPath(): string | null {
  const candidates = [
    fileURLToPath(new URL('../vendor/orizu-gepa-python/src', import.meta.url)),
    fileURLToPath(new URL('../../orizu-gepa-python/src', import.meta.url)),
  ]

  return candidates.find(candidate => existsSync(candidate)) ?? null
}

export function bundledOfficialGepaPythonPath(): string | null {
  const candidates = [
    fileURLToPath(new URL('../vendor/gepa-python/src', import.meta.url)),
  ]

  return candidates.find(candidate => existsSync(candidate)) ?? null
}

export function getGepaPythonPathEntries(existingPythonPath: string | undefined): string[] {
  const pythonPathEntries = [
    bundledOrizuGepaPythonPath(),
    bundledOfficialGepaPythonPath(),
    existingPythonPath,
  ].filter((entry): entry is string => Boolean(entry))

  return pythonPathEntries
}
