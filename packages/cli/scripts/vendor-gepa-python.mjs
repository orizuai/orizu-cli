import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const cliRoot = resolve(scriptDir, '..')
const repoRoot = resolve(cliRoot, '..', '..')
const sourceRoot = resolve(repoRoot, 'packages', 'orizu-gepa-python')
const vendorRoot = resolve(cliRoot, 'vendor', 'orizu-gepa-python')
const connectorSourceRoot = resolve(repoRoot, 'packages', 'orizu-gepa')
const connectorVendorRoot = resolve(cliRoot, 'vendor', 'orizu-gepa')
const officialArchive = resolve(cliRoot, 'gepa-python-source.zip')
const officialVendorRoot = resolve(cliRoot, 'vendor', 'gepa-python')
const shouldClean = process.argv.includes('--clean')
const shouldRefresh = process.argv.includes('--refresh')
const archiveArgumentIndex = process.argv.indexOf('--archive')
const suppliedArchive = archiveArgumentIndex === -1
  ? null
  : process.argv[archiveArgumentIndex + 1]
const sourceSrc = resolve(sourceRoot, 'src')
const sourcePyproject = resolve(sourceRoot, 'pyproject.toml')
const sourceManifest = resolve(sourceRoot, 'manifest.json')
const vendoredSrc = resolve(vendorRoot, 'src')
const vendoredPyproject = resolve(vendorRoot, 'pyproject.toml')
const vendoredManifest = resolve(vendorRoot, 'manifest.json')
const officialVendoredManifest = resolve(officialVendorRoot, 'manifest.json')
const officialVendoredGepa = resolve(officialVendorRoot, 'src', 'gepa', '__init__.py')
const GEPA_VERSION = '0.1.4'
const GEPA_RELEASE_COMMIT = '8b0ce6cd99a234f6b74daf37558a2ac0ce18f975'
const GEPA_WHEEL_FILENAME = 'gepa-0.1.4-py3-none-any.whl'
const GEPA_WHEEL_SHA256 = '12b971039599625c156d2231f6d72a29c31a22e9c237689459b5f1a3c353f532'
const hasSourcePackage = existsSync(sourceSrc)
  && existsSync(sourcePyproject)
  && existsSync(sourceManifest)
const hasConnectorSourcePackage = existsSync(resolve(connectorSourceRoot, 'src'))
  && existsSync(resolve(connectorSourceRoot, 'pyproject.toml'))
const hasVendoredPackage = existsSync(vendoredSrc)
  && existsSync(vendoredPyproject)
  && existsSync(vendoredManifest)
const hasVendoredConnectorPackage = existsSync(resolve(connectorVendorRoot, 'src', 'orizu_gepa_connector', '__main__.py'))
  && existsSync(resolve(connectorVendorRoot, 'pyproject.toml'))
const hasOfficialVendoredPackage = existsSync(officialVendoredManifest)
  && existsSync(officialVendoredGepa)

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function assertPinnedGepaArchive(path) {
  if (!existsSync(path)) {
    throw new Error(`Unable to vendor official GEPA: source archive not found at ${path}`)
  }

  const actualSha256 = sha256File(path)
  if (actualSha256 !== GEPA_WHEEL_SHA256) {
    throw new Error(
      `Official GEPA source archive sha256 mismatch: expected ${GEPA_WHEEL_SHA256}, got ${actualSha256}`
    )
  }
}

function collectFileHashes(root, prefix = '') {
  const files = {}
  for (const entry of readdirSync(root).sort()) {
    const path = resolve(root, entry)
    const relativePath = prefix ? `${prefix}/${entry}` : entry
    if (statSync(path).isDirectory()) {
      Object.assign(files, collectFileHashes(path, relativePath))
    } else {
      files[relativePath] = sha256File(path)
    }
  }
  return files
}

function assertOfficialVendoredManifest() {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(officialVendoredManifest, 'utf8'))
  } catch (error) {
    throw new Error(`Official GEPA vendored manifest is unreadable: ${error.message}`)
  }

  if (!manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    throw new Error('Official GEPA vendored manifest is missing file hashes')
  }

  const actualFiles = collectFileHashes(officialVendorRoot)
  delete actualFiles['manifest.json']
  const expectedEntries = Object.entries(manifest.files).sort(([left], [right]) => left.localeCompare(right))
  const actualEntries = Object.entries(actualFiles).sort(([left], [right]) => left.localeCompare(right))
  if (expectedEntries.length !== actualEntries.length) {
    throw new Error('Official GEPA vendored manifest file count does not match extracted files')
  }

  for (let index = 0; index < expectedEntries.length; index += 1) {
    const [expectedPath, expectedSha256] = expectedEntries[index]
    const [actualPath, actualSha256] = actualEntries[index]
    if (expectedPath !== actualPath || expectedSha256 !== actualSha256) {
      throw new Error(`Official GEPA vendored manifest mismatch at ${expectedPath}`)
    }
  }
}

function extractPinnedGepa(archivePath) {
  const extractor = String.raw`
from pathlib import Path, PurePosixPath
import shutil
import sys
import zipfile

archive_path = Path(sys.argv[1])
destination_root = Path(sys.argv[2])
license_member = 'gepa-0.1.4.dist-info/licenses/LICENSE'

with zipfile.ZipFile(archive_path) as archive:
    for member in archive.infolist():
        if member.is_dir():
            continue
        if member.filename.startswith('gepa/'):
            relative_path = PurePosixPath('src') / PurePosixPath(member.filename)
        elif member.filename == license_member:
            relative_path = PurePosixPath('LICENSE')
        else:
            continue
        if relative_path.is_absolute() or '..' in relative_path.parts:
            raise ValueError(f'unsafe GEPA wheel member: {member.filename}')
        destination = destination_root.joinpath(*relative_path.parts)
        destination.parent.mkdir(parents=True, exist_ok=True)
        with archive.open(member) as source, destination.open('wb') as output:
            shutil.copyfileobj(source, output)
`
  const result = spawnSync('python3', ['-c', extractor, archivePath, officialVendorRoot], {
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    const details = result.error?.message || result.stderr || result.stdout || 'no subprocess output'
    throw new Error(`Unable to extract verified official GEPA wheel; python3 is required: ${details}`)
  }
}

function vendorOfficialGepa(archivePath) {
  assertPinnedGepaArchive(archivePath)
  rmSync(officialVendorRoot, { recursive: true, force: true })
  mkdirSync(officialVendorRoot, { recursive: true })
  extractPinnedGepa(archivePath)

  const files = collectFileHashes(officialVendorRoot)
  writeFileSync(officialVendoredManifest, `${JSON.stringify({
    schemaVersion: 'gepa-vendor.v1',
    upstream: {
      package: 'gepa',
      version: GEPA_VERSION,
      repositoryCommit: GEPA_RELEASE_COMMIT,
      wheel: {
        filename: GEPA_WHEEL_FILENAME,
        sha256: GEPA_WHEEL_SHA256,
      },
    },
    files,
  }, null, 2)}\n`)
}

if (archiveArgumentIndex !== -1 && (!suppliedArchive || suppliedArchive.startsWith('--'))) {
  throw new Error('Expected a source archive path after --archive')
}

if (shouldRefresh) {
  if (!suppliedArchive) {
    throw new Error('Refreshing official GEPA requires --archive <verified-wheel-path>')
  }
  assertPinnedGepaArchive(suppliedArchive)
  cpSync(suppliedArchive, officialArchive)
}

if (shouldClean) {
  if (hasSourcePackage) {
    rmSync(vendorRoot, { recursive: true, force: true })
  }
  if (hasConnectorSourcePackage) {
    rmSync(connectorVendorRoot, { recursive: true, force: true })
  }
  if (hasSourcePackage || hasConnectorSourcePackage) {
    rmSync(officialVendorRoot, { recursive: true, force: true })
  }
  process.exit(0)
}

if (!hasSourcePackage || !hasConnectorSourcePackage) {
  if (hasVendoredPackage && hasVendoredConnectorPackage && hasOfficialVendoredPackage) {
    assertOfficialVendoredManifest()
    process.exit(0)
  }
  if (hasVendoredPackage || hasVendoredConnectorPackage || hasOfficialVendoredPackage) {
    throw new Error('Unable to vendor GEPA packages: vendored legacy, connector, or official package is incomplete')
  }
  throw new Error(`Unable to vendor GEPA packages: source package not found at ${sourceRoot} or ${connectorSourceRoot}`)
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

rmSync(connectorVendorRoot, { recursive: true, force: true })
mkdirSync(connectorVendorRoot, { recursive: true })
cpSync(resolve(connectorSourceRoot, 'pyproject.toml'), resolve(connectorVendorRoot, 'pyproject.toml'))
cpSync(resolve(connectorSourceRoot, 'src'), resolve(connectorVendorRoot, 'src'), {
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

vendorOfficialGepa(suppliedArchive ?? officialArchive)
