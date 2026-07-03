import { createHash } from 'crypto'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

export interface StoredZipEntry {
  path: string
  data: Buffer
}

export interface ArtifactArchive {
  zipBase64: string
  contentSha256: string
}

const ARTIFACT_EXCLUDED_PATH_NAMES = new Set([
  '.git',
  '.DS_Store',
  '__pycache__',
  '.pytest_cache',
  '.orizu',
])

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error
}

function expandHomePath(path: string): string {
  if (path.startsWith('~/')) {
    const home = process.env.HOME || ''
    return `${home}/${path.slice(2)}`
  }

  return path
}

/**
 * Archives must be byte-identical for identical logical content across machines
 * because content-addressed deduplication depends on deterministic inputs.
 *
 * Tradeoff: runner artifacts are downloaded, unzipped, and executed directly
 * (there is no install step), so vendored dependency trees such as
 * node_modules, .venv/venv, and build outputs are legitimate runtime payload
 * and are deliberately NOT excluded — hash reproducibility therefore depends
 * on the author shipping identical vendored trees across machines. Only true
 * junk (.git, .DS_Store, __pycache__, .pytest_cache, .orizu) and secrets
 * (.env, .env.*) are stripped: secrets must never ship, because runners
 * receive their configuration at exec time.
 */
export function shouldExcludeArtifactPath(relativePath: string): boolean {
  const parts = relativePath.split('/')
  return parts.some(part =>
    ARTIFACT_EXCLUDED_PATH_NAMES.has(part) ||
    part === '.env' ||
    part.startsWith('.env.')
  )
}

export function collectArtifactFiles(sourceDir: string, relativeDir = ''): string[] {
  const absoluteDir = relativeDir ? join(sourceDir, relativeDir) : sourceDir
  return readdirSync(absoluteDir, { withFileTypes: true })
    .flatMap(entry => {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      if (shouldExcludeArtifactPath(relativePath)) {
        return []
      }
      if (entry.isDirectory()) {
        return collectArtifactFiles(sourceDir, relativePath)
      }
      return entry.isFile() ? [relativePath] : []
    })
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
}

export const ZIP_GENERAL_PURPOSE_UTF8 = 0x0800
export const ZIP_DOS_TIME_2000_01_01 = 0
export const ZIP_DOS_DATE_2000_01_01 = ((2000 - 1980) << 9) | (1 << 5) | 1

const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
  }
  return value >>> 0
})

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export function createStoredZip(entries: StoredZipEntry[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8')
    const crc = crc32(entry.data)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(10, 4)
    localHeader.writeUInt16LE(ZIP_GENERAL_PURPOSE_UTF8, 6)
    localHeader.writeUInt16LE(0, 8)
    localHeader.writeUInt16LE(ZIP_DOS_TIME_2000_01_01, 10)
    localHeader.writeUInt16LE(ZIP_DOS_DATE_2000_01_01, 12)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(entry.data.length, 18)
    localHeader.writeUInt32LE(entry.data.length, 22)
    localHeader.writeUInt16LE(name.length, 26)
    localHeader.writeUInt16LE(0, 28)

    localParts.push(localHeader, name, entry.data)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(10, 6)
    centralHeader.writeUInt16LE(ZIP_GENERAL_PURPOSE_UTF8, 8)
    centralHeader.writeUInt16LE(0, 10)
    centralHeader.writeUInt16LE(ZIP_DOS_TIME_2000_01_01, 12)
    centralHeader.writeUInt16LE(ZIP_DOS_DATE_2000_01_01, 14)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(entry.data.length, 20)
    centralHeader.writeUInt32LE(entry.data.length, 24)
    centralHeader.writeUInt16LE(name.length, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(0, 38)
    centralHeader.writeUInt32LE(offset, 42)
    centralParts.push(centralHeader, name)

    offset += localHeader.length + name.length + entry.data.length
  }

  const centralDirectoryOffset = offset
  const centralDirectory = Buffer.concat(centralParts)
  const endOfCentralDirectory = Buffer.alloc(22)
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0)
  endOfCentralDirectory.writeUInt16LE(0, 4)
  endOfCentralDirectory.writeUInt16LE(0, 6)
  endOfCentralDirectory.writeUInt16LE(entries.length, 8)
  endOfCentralDirectory.writeUInt16LE(entries.length, 10)
  endOfCentralDirectory.writeUInt32LE(centralDirectory.length, 12)
  endOfCentralDirectory.writeUInt32LE(centralDirectoryOffset, 16)
  endOfCentralDirectory.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, centralDirectory, endOfCentralDirectory])
}

export function zipDirectoryToBase64(dirArg: string): ArtifactArchive {
  const sourceDir = expandHomePath(dirArg)
  try {
    const stats = statSync(sourceDir)
    if (!stats.isDirectory()) {
      throw new Error(`${sourceDir} is not a directory`)
    }
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new Error(`Directory not found: ${sourceDir}`)
    }
    throw error
  }

  const files = collectArtifactFiles(sourceDir)
  if (files.length === 0) {
    throw new Error(`Directory contains no artifact files: ${sourceDir}`)
  }

  const bytes = createStoredZip(files.map(relativePath => ({
    path: relativePath,
    data: readFileSync(join(sourceDir, relativePath)),
  })))
  return {
    zipBase64: bytes.toString('base64'),
    contentSha256: createHash('sha256').update(bytes).digest('hex'),
  }
}
