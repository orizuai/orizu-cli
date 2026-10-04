import { lstatSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Inspect canonical destinations without following aliases. All callers check
 * the whole set before materializing it; this does not claim race-proof access. */
export function inspectAppDestination(root: string, path: string): boolean {
  const base = resolve(root)
  const destination = resolve(base, path)
  const tail = relative(base, destination)
  if (!tail || tail === '..' || tail.startsWith(`..${sep}`) || isAbsolute(tail)) throw new Error('App destination is outside the workspace')
  const rootStat = lstatSync(base)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('App workspace must be an ordinary directory')
  const segments = tail.split(sep)
  let current = base
  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment)
    const stat = lstatSync(current, { throwIfNoEntry: false })
    if (!stat) return false
    if (stat.isSymbolicLink()) throw new Error('App destination must not contain symbolic links')
    if (index < segments.length - 1) {
      if (!stat.isDirectory()) throw new Error('App destination parent must be an ordinary directory')
    } else if (!stat.isFile() || stat.nlink > 1) {
      throw new Error('App destination must be an ordinary file without hardlink aliases')
    }
  }
  return true
}
