import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const cliRoot = resolve(scriptDir, '..')
const repoRoot = resolve(cliRoot, '..', '..')
const sourceRoot = resolve(repoRoot, 'packages', 'orizu-gepa-python')
const vendorRoot = resolve(cliRoot, 'vendor', 'orizu-gepa-python')
const shouldClean = process.argv.includes('--clean')
const sourceSrc = resolve(sourceRoot, 'src')
const sourcePyproject = resolve(sourceRoot, 'pyproject.toml')
const sourceManifest = resolve(sourceRoot, 'manifest.json')
const vendoredSrc = resolve(vendorRoot, 'src')
const vendoredPyproject = resolve(vendorRoot, 'pyproject.toml')
const vendoredManifest = resolve(vendorRoot, 'manifest.json')
const hasSourcePackage = existsSync(sourceSrc)
  && existsSync(sourcePyproject)
  && existsSync(sourceManifest)
const hasVendoredPackage = existsSync(vendoredSrc)
  && existsSync(vendoredPyproject)
  && existsSync(vendoredManifest)

if (shouldClean) {
  if (hasSourcePackage) {
    rmSync(vendorRoot, { recursive: true, force: true })
  }
  process.exit(0)
}

if (!hasSourcePackage) {
  if (hasVendoredPackage) {
    process.exit(0)
  }
  throw new Error(`Unable to vendor orizu-gepa-python: source package not found at ${sourceRoot}`)
}

rmSync(vendorRoot, { recursive: true, force: true })
mkdirSync(vendorRoot, { recursive: true })
cpSync(sourcePyproject, resolve(vendorRoot, 'pyproject.toml'))
cpSync(sourceManifest, resolve(vendorRoot, 'manifest.json'))
cpSync(sourceSrc, resolve(vendorRoot, 'src'), {
  recursive: true,
  filter: sourcePath => {
    const normalizedPath = sourcePath.replace(/\\/g, '/')
    return !normalizedPath.endsWith('/__pycache__')
      && !normalizedPath.includes('/__pycache__/')
      && !normalizedPath.endsWith('.pyc')
      && !normalizedPath.endsWith('.pyo')
      && !normalizedPath.endsWith('/.pytest_cache')
      && !normalizedPath.includes('/.pytest_cache/')
      && !normalizedPath.endsWith('/.DS_Store')
  },
})
