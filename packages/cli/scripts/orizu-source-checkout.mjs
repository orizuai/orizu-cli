import { readFileSync } from 'node:fs'

/** True only for the Orizu monorepo, never merely for a consumer Git checkout. */
export function isOrizuSourceCheckout(packageJsonPath) {
  try {
    return JSON.parse(readFileSync(packageJsonPath, 'utf8')).name === 'orizu'
  } catch {
    return false
  }
}
