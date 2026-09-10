import { randomBytes } from 'crypto'
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import {
  getConfigDir,
  getSecretsSeenThisProcess,
  resolveAuthTokenForBaseUrl,
  resolveEnvBearerToken,
} from './credentials.js'
import { scrubFeedbackText } from './feedback-scrub.js'
import { getBaseUrl } from './http.js'
import {
  LAST_ERROR_ARG_MAX_CHARS,
  LAST_ERROR_CODE_MAX_CHARS,
  LAST_ERROR_FILE_MAX_BYTES,
  LAST_ERROR_MAX_ARGS,
  LAST_ERROR_MESSAGE_MAX_CHARS,
  LAST_ERROR_SERVER_BASE_URL_MAX_BYTES,
} from './last-error-caps.js'
import { runnerForwardedSecretValues } from './runner-env.js'

export interface LastErrorRecord {
  version: 1
  recordedAt: string
  cliVersion: string | null
  code: string | null
  serverBaseUrl: string | null
  teamSlug: string | null
  command: string | null
  argv: string[]
  argvTruncated: boolean
  message: string
  messageTruncated: boolean
}

export const LAST_ERROR_RECORD_VERSION = 1
export const LAST_ERROR_FILENAME = 'last-error.json'
export const LAST_ERROR_ATTACH_MAX_AGE_MS = 86_400_000
export const LAST_ERROR_TRUNCATION_MARKER = '[truncated]'

const LAST_ERROR_MESSAGE_PRE_SCRUB_MAX_CHARS = 65_536
const CREDENTIAL_BEARING_FLAGS = new Set([
  '--model-key',
  '--token',
  '--api-key',
  '--password',
  '--secret',
  '--access-token',
  '--refresh-token',
  '--private-key',
  '--client-secret',
])

export interface LastErrorRecordInput {
  argv: readonly string[]
  message: string
  cliVersion: string | null
  code?: string | null
  serverBaseUrl?: string | null
  teamSlug?: string | null
  homeDir?: string | null
  secrets?: readonly string[]
  now?: Date
}

export interface WriteLastErrorRecordOptions {
  configDir?: string
}

interface ScrubContext {
  homeDir: string | null
  secrets: readonly string[]
}

function removeTrailingCredentialResidue(input: string): string {
  const hasMarker = input.endsWith(LAST_ERROR_TRUNCATION_MARKER)
  const body = hasMarker
    ? input.slice(0, -LAST_ERROR_TRUNCATION_MARKER.length)
    : input
  const withoutResidue = body.replace(
    /(?:\borizu_(?:agent|pat)_|\bgithub_pat_|\bgh[posur]_?|\bsk-(?:ant-|proj-)?)[^\s]*$/i,
    ''
  )
  return hasMarker
    ? `${withoutResidue}${LAST_ERROR_TRUNCATION_MARKER}`
    : withoutResidue
}

function scrubWithContext(input: string, context: ScrubContext): string {
  return scrubFeedbackText(input, {
    reporterEmail: undefined,
    homeDir: context.homeDir,
    secrets: context.secrets,
  })
}

function scrubAndCap(
  input: string,
  maximumCharacters: number,
  context: ScrubContext
): { value: string; wasTruncated: boolean } {
  const scrubbed = scrubWithContext(input, context)
  const wasTruncated = scrubbed.length > maximumCharacters
  const capped = wasTruncated
    ? `${scrubbed.slice(0, maximumCharacters)}${LAST_ERROR_TRUNCATION_MARKER}`
    : scrubbed
  const withoutResidue = removeTrailingCredentialResidue(capped)
  const finalScrubbed = scrubWithContext(withoutResidue, context)
  const finalBody = wasTruncated && finalScrubbed.endsWith(LAST_ERROR_TRUNCATION_MARKER)
    ? finalScrubbed.slice(0, -LAST_ERROR_TRUNCATION_MARKER.length)
    : finalScrubbed
  return {
    value: wasTruncated
      ? `${finalBody.slice(0, maximumCharacters)}${LAST_ERROR_TRUNCATION_MARKER}`
      : finalBody.slice(0, maximumCharacters),
    wasTruncated,
  }
}

function isCredentialBearingFlag(argument: string): boolean {
  const normalizedArgument = argument.toLowerCase()
  return CREDENTIAL_BEARING_FLAGS.has(normalizedArgument)
    || /^--.+[_.-](?:key|token|secret|password)$/.test(normalizedArgument)
}

function credentialBearingArgvSecrets(argv: readonly string[]): string[] {
  const secrets: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const equalsIndex = argument.indexOf('=')
    if (equalsIndex > 0 && isCredentialBearingFlag(argument.slice(0, equalsIndex))) {
      const value = argument.slice(equalsIndex + 1)
      if (value.length >= 8) secrets.push(value)
      continue
    }

    if (!isCredentialBearingFlag(argument)) continue
    const value = argv[index + 1]
    if (value && !value.startsWith('--') && value.length >= 8) secrets.push(value)
    index += 1
  }
  return secrets
}

function maskCredentialBearingArgument(
  argv: readonly string[],
  index: number
): string {
  const argument = argv[index]
  if (
    index > 0
    && isCredentialBearingFlag(argv[index - 1])
  ) {
    return '[redacted]'
  }

  const equalsIndex = argument.indexOf('=')
  if (
    equalsIndex > 0
    && isCredentialBearingFlag(argument.slice(0, equalsIndex))
  ) {
    return `${argument.slice(0, equalsIndex + 1)}[redacted]`
  }
  return argument
}

function commandAfterGlobalFlags(argv: readonly string[]): string | null {
  const commandArguments: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--local') continue
    if (argument === '--server') {
      index += 1
      continue
    }
    commandArguments.push(argument)
  }
  if (commandArguments[0] === '--json') commandArguments.shift()
  return commandArguments[0] ?? null
}

function serializeRecord(record: LastErrorRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`
}

function isSerializedRecordTooLarge(record: LastErrorRecord): boolean {
  return Buffer.byteLength(serializeRecord(record), 'utf8') > LAST_ERROR_FILE_MAX_BYTES
}

function resolveActiveProcessSecrets(): readonly string[] {
  const rememberedSecrets = getSecretsSeenThisProcess()
  try {
    const environmentBearer = resolveEnvBearerToken()
    const currentBearer = environmentBearer ?? resolveAuthTokenForBaseUrl(getBaseUrl())
    return [...new Set([...rememberedSecrets, currentBearer])]
  } catch {
    return rememberedSecrets
  }
}

function propertyValue(value: unknown, key: string, ownOnly = false): unknown {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return undefined
  try {
    return !ownOnly || Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined
  } catch {
    return undefined
  }
}

export function extractLastErrorCode(error: unknown): string | null {
  const ownCode = propertyValue(error, 'code', true)
  if (typeof ownCode === 'string') return ownCode
  const causeCode = propertyValue(propertyValue(error, 'cause'), 'code')
  return typeof causeCode === 'string' ? causeCode : null
}

function resolveHomeDir(): string | null {
  try {
    return homedir()
  } catch {
    return null
  }
}

function isStringWithinCap(
  value: unknown,
  maximumCharacters: number,
  wasTruncated: boolean
): value is string {
  if (typeof value !== 'string') return false
  if (value.length <= maximumCharacters) return true
  return wasTruncated
    && value.length <= maximumCharacters + LAST_ERROR_TRUNCATION_MARKER.length
    && value.endsWith(LAST_ERROR_TRUNCATION_MARKER)
}

function boundedServerBaseUrl(value: string | null | undefined): string | null {
  return value && Buffer.byteLength(value, 'utf8') <= LAST_ERROR_SERVER_BASE_URL_MAX_BYTES
    ? value
    : null
}

function isLastErrorRecord(value: unknown): value is LastErrorRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<LastErrorRecord>
  if (record.version !== LAST_ERROR_RECORD_VERSION) return false
  if (typeof record.recordedAt !== 'string' || !Number.isFinite(Date.parse(record.recordedAt))) return false
  if (typeof record.cliVersion !== 'string' && record.cliVersion !== null) return false
  if (record.code !== undefined && record.code !== null && (
    typeof record.code !== 'string'
    || Array.from(record.code).length > LAST_ERROR_CODE_MAX_CHARS
  )) return false
  if (record.serverBaseUrl !== undefined && typeof record.serverBaseUrl !== 'string' && record.serverBaseUrl !== null) return false
  if (record.teamSlug !== undefined && typeof record.teamSlug !== 'string' && record.teamSlug !== null) return false
  if (typeof record.argvTruncated !== 'boolean') return false
  const argvTruncated = record.argvTruncated
  if (record.command !== null && !isStringWithinCap(
    record.command,
    LAST_ERROR_ARG_MAX_CHARS,
    argvTruncated
  )) return false
  if (!Array.isArray(record.argv) || record.argv.length > LAST_ERROR_MAX_ARGS) return false
  if (!record.argv.every(argument => isStringWithinCap(
    argument,
    LAST_ERROR_ARG_MAX_CHARS,
    argvTruncated
  ))) return false
  if (typeof record.messageTruncated !== 'boolean') return false
  return isStringWithinCap(
    record.message,
    LAST_ERROR_MESSAGE_MAX_CHARS,
    record.messageTruncated
  )
}

export function buildLastErrorRecord(input: LastErrorRecordInput): LastErrorRecord {
  const context: ScrubContext = {
    homeDir: input.homeDir ?? null,
    secrets: [
      ...(input.secrets ?? []),
      ...credentialBearingArgvSecrets(input.argv),
    ],
  }
  const messageInput = input.message.slice(0, LAST_ERROR_MESSAGE_PRE_SCRUB_MAX_CHARS)
  const cappedMessage = scrubAndCap(messageInput, LAST_ERROR_MESSAGE_MAX_CHARS, context)
  const retainedArguments = input.argv.slice(0, LAST_ERROR_MAX_ARGS)
  let argvTruncated = input.argv.length > LAST_ERROR_MAX_ARGS
  const argv = retainedArguments.map((_argument, index) => {
    const maskedArgument = maskCredentialBearingArgument(input.argv, index)
    const cappedArgument = scrubAndCap(maskedArgument, LAST_ERROR_ARG_MAX_CHARS, context)
    argvTruncated ||= cappedArgument.wasTruncated
    return cappedArgument.value
  })
  const rawCommand = commandAfterGlobalFlags(input.argv)
  const command = rawCommand === null
    ? null
    : scrubAndCap(rawCommand, LAST_ERROR_ARG_MAX_CHARS, context).value
  const code = input.code === undefined || input.code === null
    ? null
    : Array.from(scrubAndCap(
      input.code, LAST_ERROR_CODE_MAX_CHARS * 2, context
    ).value).slice(0, LAST_ERROR_CODE_MAX_CHARS).join('')

  const record: LastErrorRecord = {
    version: LAST_ERROR_RECORD_VERSION,
    recordedAt: (input.now ?? new Date()).toISOString(),
    cliVersion: input.cliVersion,
    code,
    serverBaseUrl: boundedServerBaseUrl(input.serverBaseUrl),
    teamSlug: input.teamSlug ?? null,
    command,
    argv,
    argvTruncated,
    message: cappedMessage.value,
    messageTruncated: cappedMessage.wasTruncated || input.message.length > LAST_ERROR_MESSAGE_PRE_SCRUB_MAX_CHARS,
  }

  if (isSerializedRecordTooLarge(record)) {
    record.argv = []
    record.argvTruncated = true
  }
  while (isSerializedRecordTooLarge(record) && record.message.length > LAST_ERROR_TRUNCATION_MARKER.length) {
    const content = record.message.endsWith(LAST_ERROR_TRUNCATION_MARKER)
      ? record.message.slice(0, -LAST_ERROR_TRUNCATION_MARKER.length)
      : record.message
    record.message = scrubAndCap(content, Math.floor(content.length / 2), context).value
    if (!record.message.endsWith(LAST_ERROR_TRUNCATION_MARKER)) {
      record.message += LAST_ERROR_TRUNCATION_MARKER
    }
    record.messageTruncated = true
  }

  return record
}

export function getLastErrorRecordPath(configDir?: string): string {
  return join(configDir ?? getConfigDir(), LAST_ERROR_FILENAME)
}

export function writeLastErrorRecord(
  input: LastErrorRecordInput,
  options: WriteLastErrorRecordOptions = {}
): void {
  try {
    const configDirectory = options.configDir ?? getConfigDir()
    mkdirSync(configDirectory, { recursive: true, mode: 0o700 })
    chmodSync(configDirectory, 0o700)

    const record = buildLastErrorRecord({
      ...input,
      homeDir: input.homeDir === undefined ? resolveHomeDir() : input.homeDir,
      secrets: [
        ...resolveActiveProcessSecrets(),
        ...runnerForwardedSecretValues(),
        ...(input.secrets ?? []),
      ],
    })
    const serialized = serializeRecord(record)
    if (Buffer.byteLength(serialized, 'utf8') > LAST_ERROR_FILE_MAX_BYTES) return

    const path = getLastErrorRecordPath(configDirectory)
    const temporaryPath = join(
      configDirectory,
      `.${LAST_ERROR_FILENAME}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    )

    try {
      const fileDescriptor = openSync(temporaryPath, 'wx', 0o600)
      try {
        writeFileSync(fileDescriptor, serialized, 'utf8')
        fsyncSync(fileDescriptor)
      } finally {
        closeSync(fileDescriptor)
      }
      chmodSync(temporaryPath, 0o600)
      renameSync(temporaryPath, path)
      chmodSync(path, 0o600)
    } finally {
      rmSync(temporaryPath, { force: true })
    }
  } catch {
    // A diagnostic record is best effort and must never replace the original CLI failure.
  }
}

export function readLastErrorRecord(configDir?: string): LastErrorRecord | null {
  try {
    const path = getLastErrorRecordPath(configDir)
    if (statSync(path).size > LAST_ERROR_FILE_MAX_BYTES) return null
    const record = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return isLastErrorRecord(record)
      ? {
          ...record,
          code: record.code ?? null,
          serverBaseUrl: boundedServerBaseUrl(record.serverBaseUrl),
          teamSlug: record.teamSlug ?? null,
        }
      : null
  } catch {
    return null
  }
}
