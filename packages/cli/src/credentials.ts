import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { randomBytes } from 'crypto'
import {
  ServerCredentials,
  StoredCredentialsV1,
  StoredCredentialsV2,
  StoredCredentialsV3,
} from './types.js'

function getConfigDir(): string {
  if (process.env.ORIZU_CONFIG_DIR) {
    return process.env.ORIZU_CONFIG_DIR
  }
  return join(homedir(), '.config', 'orizu')
}

function getCredentialsPath(): string {
  return join(getConfigDir(), 'credentials.json')
}

function isStoredCredentialsV2(value: unknown): value is StoredCredentialsV2 {
  if (!value || typeof value !== 'object') {
    return false
  }

  const typed = value as Partial<StoredCredentialsV2>
  return typed.version === 2 && !!typed.servers && typeof typed.servers === 'object'
}

function isStoredCredentialsV3(value: unknown): value is StoredCredentialsV3 {
  if (!value || typeof value !== 'object') {
    return false
  }

  const typed = value as Partial<StoredCredentialsV3>
  return typed.version === 3 && !!typed.servers && typeof typed.servers === 'object'
}

function isStoredCredentialsV1(value: unknown): value is StoredCredentialsV1 {
  if (!value || typeof value !== 'object') {
    return false
  }

  const typed = value as Partial<StoredCredentialsV1>
  return (
    typeof typed.baseUrl === 'string' &&
    typeof typed.accessToken === 'string' &&
    typeof typed.refreshToken === 'string' &&
    typeof typed.expiresAt === 'number'
  )
}

function migrateToV2(stored: StoredCredentialsV1): StoredCredentialsV2 {
  return {
    version: 2,
    activeBaseUrl: stored.baseUrl,
    servers: {
      [stored.baseUrl]: {
        accessToken: stored.accessToken,
        refreshToken: stored.refreshToken,
        expiresAt: stored.expiresAt,
      },
    },
  }
}

function writeCredentials(config: StoredCredentialsV2 | StoredCredentialsV3) {
  const dir = getConfigDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)

  const path = getCredentialsPath()
  const tempPath = join(
    dir,
    `.credentials.json.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  )
  const payload = JSON.stringify(config, null, 2) + '\n'
  const fd = openSync(tempPath, 'wx', 0o600)

  try {
    writeFileSync(fd, payload, 'utf-8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }

  chmodSync(tempPath, 0o600)
  try {
    renameSync(tempPath, path)
  } catch (error: any) {
    if (process.platform === 'win32' && error?.code === 'EEXIST') {
      rmSync(path, { force: true })
      renameSync(tempPath, path)
    } else {
      rmSync(tempPath, { force: true })
      throw error
    }
  }
  chmodSync(path, 0o600)
}

function createEmptyCredentialsConfig(): StoredCredentialsV3 {
  return {
    version: 3 as const,
    activeBaseUrl: null,
    servers: {},
  }
}

function loadCredentialsConfigForWrite(): StoredCredentialsV2 | StoredCredentialsV3 {
  try {
    return loadCredentialsConfig() || createEmptyCredentialsConfig()
  } catch {
    return createEmptyCredentialsConfig()
  }
}

export function loadCredentialsConfig(): StoredCredentialsV2 | StoredCredentialsV3 | null {
  const path = getCredentialsPath()
  if (!existsSync(path)) {
    return null
  }

  const raw = readFileSync(path, 'utf-8')

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.warn('Warning: credentials file contains invalid JSON — please re-login with `orizu login`')
    return null
  }

  if (isStoredCredentialsV3(parsed)) {
    return parsed
  }

  if (isStoredCredentialsV2(parsed)) {
    return parsed
  }

  if (isStoredCredentialsV1(parsed)) {
    return migrateToV2(parsed)
  }

  console.warn('Warning: credentials file has unrecognized format — please re-login with `orizu login`')
  return null
}

export function getServerCredentials(baseUrl: string): ServerCredentials | null {
  const config = loadCredentialsConfig()
  if (!config) {
    return null
  }

  if (!Object.hasOwn(config.servers, baseUrl)) {
    return null
  }

  return config.servers[baseUrl] || null
}

export function saveServerCredentials(baseUrl: string, credentials: ServerCredentials) {
  const loaded = loadCredentialsConfigForWrite()
  const config: StoredCredentialsV3 = loaded.version === 3
    ? loaded
    : {
      version: 3,
      activeBaseUrl: loaded.activeBaseUrl,
      servers: loaded.servers,
    }

  config.servers[baseUrl] = credentials
  config.activeBaseUrl = baseUrl
  writeCredentials(config)
}

export function updateServerCredentials(baseUrl: string, credentials: ServerCredentials) {
  const loaded = loadCredentialsConfigForWrite()
  const config: StoredCredentialsV3 = loaded.version === 3
    ? loaded
    : {
      version: 3,
      activeBaseUrl: loaded.activeBaseUrl,
      servers: loaded.servers,
    }
  config.servers[baseUrl] = credentials
  writeCredentials(config)
}

export function getActiveBaseUrl(): string | null {
  const config = loadCredentialsConfig()
  return config?.activeBaseUrl || null
}

export function setActiveBaseUrl(baseUrl: string | null) {
  const config = loadCredentialsConfigForWrite()
  config.activeBaseUrl = baseUrl
  writeCredentials(config)
}

export function clearServerCredentials(baseUrl: string): boolean {
  const config = loadCredentialsConfig()
  if (!config || !Object.hasOwn(config.servers, baseUrl)) {
    return false
  }

  delete config.servers[baseUrl]
  if (config.activeBaseUrl === baseUrl) {
    config.activeBaseUrl = null
  }
  writeCredentials(config)
  return true
}

export function clearCredentialsFile() {
  const path = getCredentialsPath()
  if (existsSync(path)) {
    rmSync(path)
  }
}
