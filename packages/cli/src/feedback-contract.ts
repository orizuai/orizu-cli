import {
  LAST_ERROR_ARG_MAX_CHARS,
  LAST_ERROR_FILE_MAX_BYTES,
  LAST_ERROR_MAX_ARGS,
  LAST_ERROR_MESSAGE_MAX_CHARS,
} from './last-error-caps.js'

export const FEEDBACK_CATEGORIES = [
  'bug',
  'docs',
  'missing',
  'guidance',
  'friction',
  'other',
] as const

export type FeedbackCategory = typeof FEEDBACK_CATEGORIES[number]

export const FEEDBACK_SEVERITIES = ['blocking', 'major', 'minor'] as const

export type FeedbackSeverity = typeof FEEDBACK_SEVERITIES[number]

export const FEEDBACK_ATTACHMENT_EXTENSIONS = ['.log', '.txt', '.md', '.json'] as const

export const FEEDBACK_CAPS = {
  summaryBytes: 200,
  actualBytes: 1_200,
  triedBytes: 800,
  expectedBytes: 800,
  impactBytes: 800,
  reproBytes: 1_200,
  narrativeTotalBytes: 4_000,
  environmentBytes: 4_096,
  attachmentBytes: 262_144,
  attachmentNameBytes: 128,
  maxAttachments: 5,
  bodyBytes: 2_097_152,
} as const

export const PRODUCT_FEEDBACK_FLAGS = [
  '--category',
  '--severity',
  '--summary',
  '--tried',
  '--expected',
  '--actual',
  '--impact',
  '--repro',
  '--attach',
  '--from-file',
  '--project',
  '--no-last-error',
  '--json',
] as const

const PRODUCT_FEEDBACK_FIRST_TRANSPORT_FLAG = '--attach'
export const FROM_FILE_KEYS = PRODUCT_FEEDBACK_FLAGS
  .slice(0, PRODUCT_FEEDBACK_FLAGS.indexOf(PRODUCT_FEEDBACK_FIRST_TRANSPORT_FLAG))
  .map(flag => flag.slice(2))

export interface ProductFeedbackEnvironment {
  cliVersion: string | null
  os: string
  runtime: string
  serverBaseUrl: string
  hosted: boolean
  teamSlug: string | null
  projectSlug: string | null
  workspaceRootFound: boolean
}

export interface ProductFeedbackAttachment {
  name: string
  contentBase64: string
}

export interface ProductFeedbackRequest {
  category: FeedbackCategory
  severity: FeedbackSeverity
  summary: string
  actual: string
  tried: string | null
  expected: string | null
  impact: string | null
  repro: string | null
  environment: ProductFeedbackEnvironment
  lastError: unknown | null
  attachments: ProductFeedbackAttachment[]
}

export const FEEDBACK_REFUSAL_CODES = [
  'invalid_json',
  'invalid_category',
  'invalid_severity',
  'invalid_summary',
  'invalid_actual',
  'invalid_tried',
  'invalid_expected',
  'invalid_impact',
  'invalid_repro',
  'invalid_environment',
  'invalid_last_error',
  'invalid_attachment_name',
  'invalid_attachment_count',
  'invalid_attachment_content',
  'invalid_attachments',
  'too_large_summary',
  'too_large_actual',
  'too_large_tried',
  'too_large_expected',
  'too_large_impact',
  'too_large_repro',
  'too_large_narrative',
  'too_large_environment',
  'too_large_attachment',
  'too_large_body',
] as const

export type FeedbackRefusalCode = typeof FEEDBACK_REFUSAL_CODES[number]

export interface FeedbackRefusal {
  code: FeedbackRefusalCode
  message: string
}

export type ValidateProductFeedbackResult =
  | { ok: true; request: ProductFeedbackRequest }
  | { ok: false; refusal: FeedbackRefusal }

export const FEEDBACK_CLIENT_REFUSAL_CODES = [
  'invalid_flag_repeated',
  'invalid_flag_value',
  'invalid_attachment_path',
  'invalid_attachment_extension',
  'invalid_attachment_unreadable',
  'invalid_from_file',
  'invalid_from_file_unreadable',
  'invalid_from_file_json',
  'invalid_token_file',
  'unauthenticated',
  'network_error',
  'feedback_timeout',
] as const

export const FEEDBACK_SERVER_REFUSAL_PREFIXES = [
  'unauthorized',
  'forbidden',
  'rate_limited',
  'storage_failed',
] as const

export const PRODUCT_FEEDBACK_ROUTE = '/api/cli/feedback'
export const PRODUCT_FEEDBACK_MESSAGE = 'Thanks, this has been reported. To follow up, email feedback@orizu.ai'
export const PRODUCT_FEEDBACK_UNAUTHENTICATED_MESSAGE = 'Sign in first (orizu login) or email feedback@orizu.ai'

export interface ProductFeedbackSuccess {
  id: string
  message: string
}

const LAST_ERROR_KEYS = [
  'version',
  'recordedAt',
  'cliVersion',
  'command',
  'argv',
  'argvTruncated',
  'message',
  'messageTruncated',
] as const
const LAST_ERROR_OPTIONAL_LOCATOR_KEYS = ['serverBaseUrl', 'teamSlug'] as const
const LAST_ERROR_ALLOWED_KEYS = new Set<string>([
  ...LAST_ERROR_KEYS,
  ...LAST_ERROR_OPTIONAL_LOCATOR_KEYS,
])
const LAST_ERROR_TRUNCATION_MARKER_LENGTH = '[truncated]'.length
const TEXT_ENCODER = new TextEncoder()
const FATAL_TEXT_DECODER = new TextDecoder('utf-8', { fatal: true })
const PRODUCT_FEEDBACK_ATTACHMENT_NAME_PATTERN = new RegExp(
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,${FEEDBACK_CAPS.attachmentNameBytes - 1}}$`
)
const PRODUCT_FEEDBACK_ENVIRONMENT_TEXT_PATTERN = /^[A-Za-z0-9 ._+-]{1,64}$/
const PRODUCT_FEEDBACK_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const PRODUCT_FEEDBACK_RECORDED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const PRODUCT_FEEDBACK_SERVER_BASE_URL_MAX_BYTES = 256

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value)
  return actualKeys.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

export function hasValidProductFeedbackAttachmentNameSyntax(value: unknown): value is string {
  return isNulFreeString(value) && PRODUCT_FEEDBACK_ATTACHMENT_NAME_PATTERN.test(value)
}

function byteLength(value: string): number {
  return TEXT_ENCODER.encode(value).length
}

function serializedByteLength(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value)
    return typeof serialized === 'string' ? byteLength(serialized) : null
  } catch {
    return null
  }
}

function refusal(code: FeedbackRefusalCode, reason: string): ValidateProductFeedbackResult {
  return { ok: false, refusal: { code, message: `${code}: ${reason}` } }
}

function isNulFreeString(value: unknown): value is string {
  if (typeof value !== 'string' || value.includes('\0')) return false
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const nextCodeUnit = value.charCodeAt(index + 1)
      if (!(nextCodeUnit >= 0xDC00 && nextCodeUnit <= 0xDFFF)) return false
      index += 1
    } else if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
      return false
    }
  }
  return true
}

function optionalString(value: unknown): value is string | null {
  return value === null || isNulFreeString(value)
}

function isEnvironmentText(value: unknown): value is string {
  return isNulFreeString(value) && PRODUCT_FEEDBACK_ENVIRONMENT_TEXT_PATTERN.test(value)
}

export function hasValidProductFeedbackSlugSyntax(value: unknown): value is string {
  return isNulFreeString(value) && PRODUCT_FEEDBACK_SLUG_PATTERN.test(value)
}

function isEnvironmentSlug(value: unknown): value is string | null {
  return value === null || hasValidProductFeedbackSlugSyntax(value)
}

function isEnvironmentServerBaseUrl(value: unknown): value is string {
  if (
    !isNulFreeString(value)
    || byteLength(value) > PRODUCT_FEEDBACK_SERVER_BASE_URL_MAX_BYTES
  ) return false

  try {
    const parsed = new URL(value)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.hostname.length > 0
      && parsed.username.length === 0
      && parsed.password.length === 0
      && parsed.pathname === '/'
      && parsed.search.length === 0
      && parsed.hash.length === 0
  } catch {
    return false
  }
}

function isEnvironment(value: unknown): value is ProductFeedbackEnvironment {
  if (!isObject(value)) return false
  if (!hasExactKeys(value, [
    'cliVersion',
    'os',
    'runtime',
    'serverBaseUrl',
    'hosted',
    'teamSlug',
    'projectSlug',
    'workspaceRootFound',
  ])) return false
  return (value.cliVersion === null || isEnvironmentText(value.cliVersion))
    && isEnvironmentText(value.os)
    && isEnvironmentText(value.runtime)
    && isEnvironmentServerBaseUrl(value.serverBaseUrl)
    && typeof value.hosted === 'boolean'
    && isEnvironmentSlug(value.teamSlug)
    && isEnvironmentSlug(value.projectSlug)
    && typeof value.workspaceRootFound === 'boolean'
}

function lastErrorStringWithinCap(value: unknown, maximumCharacters: number): value is string {
  return isNulFreeString(value) && value.length <= maximumCharacters
}

export function isLastErrorRecordShape(value: unknown): boolean {
  try {
    if (!isObject(value)) return false
    if (!LAST_ERROR_KEYS.every(key => Object.hasOwn(value, key))) return false
    if (!Object.keys(value).every(key => LAST_ERROR_ALLOWED_KEYS.has(key))) return false
    if (value.version !== 1) return false
    if (
      !isNulFreeString(value.recordedAt)
      || !PRODUCT_FEEDBACK_RECORDED_AT_PATTERN.test(value.recordedAt)
      || !Number.isFinite(Date.parse(value.recordedAt))
    ) return false
    if (!(value.cliVersion === null || isEnvironmentText(value.cliVersion))) return false
    if (!(value.command === null || lastErrorStringWithinCap(value.command, LAST_ERROR_ARG_MAX_CHARS + LAST_ERROR_TRUNCATION_MARKER_LENGTH))) return false
    if (!Array.isArray(value.argv) || value.argv.length > LAST_ERROR_MAX_ARGS) return false
    if (!value.argv.every(argument => lastErrorStringWithinCap(argument, LAST_ERROR_ARG_MAX_CHARS + LAST_ERROR_TRUNCATION_MARKER_LENGTH))) return false
    if (typeof value.argvTruncated !== 'boolean') return false
    if (!lastErrorStringWithinCap(value.message, LAST_ERROR_MESSAGE_MAX_CHARS + LAST_ERROR_TRUNCATION_MARKER_LENGTH)) return false
    if (typeof value.messageTruncated !== 'boolean') return false
    if (!(value.serverBaseUrl === undefined || value.serverBaseUrl === null || isEnvironmentServerBaseUrl(value.serverBaseUrl))) return false
    if (!(value.teamSlug === undefined || isEnvironmentSlug(value.teamSlug))) return false
    const size = serializedByteLength(value)
    return size !== null && size <= LAST_ERROR_FILE_MAX_BYTES
  } catch {
    return false
  }
}

export function decodedBase64Bytes(value: string): number | null {
  if (value.length === 0) return 0
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null

  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  if (value.endsWith('==')) {
    const finalDataCharacter = value[value.length - 3]
    if ((alphabet.indexOf(finalDataCharacter) & 15) !== 0) return null
    return (value.length / 4) * 3 - 2
  }
  if (value.endsWith('=')) {
    const finalDataCharacter = value[value.length - 2]
    if ((alphabet.indexOf(finalDataCharacter) & 3) !== 0) return null
    return (value.length / 4) * 3 - 1
  }
  return (value.length / 4) * 3
}

function isUtf8TextBase64(value: string): boolean {
  try {
    const bytes = Uint8Array.from(atob(value), character => character.charCodeAt(0))
    if (bytes.includes(0)) return false
    FATAL_TEXT_DECODER.decode(bytes)
    return true
  } catch {
    return false
  }
}

export function feedbackRefusalStatus(code: FeedbackRefusalCode): 400 | 413 {
  return code.startsWith('too_large_') ? 413 : 400
}

export function validateProductFeedbackRequest(input: unknown): ValidateProductFeedbackResult {
  try {
    if (!isObject(input)) return refusal('invalid_json', 'request body must be a JSON object')

    if (!FEEDBACK_CATEGORIES.includes(input.category as FeedbackCategory)) {
      return refusal('invalid_category', 'category is not recognized')
    }
    if (!FEEDBACK_SEVERITIES.includes(input.severity as FeedbackSeverity)) {
      return refusal('invalid_severity', 'severity is not recognized')
    }
    if (!isNulFreeString(input.summary) || input.summary.trim().length === 0) {
      return refusal('invalid_summary', 'summary is required')
    }
    if (!isNulFreeString(input.actual) || input.actual.trim().length === 0) {
      return refusal('invalid_actual', 'actual is required')
    }
    if (!optionalString(input.tried)) return refusal('invalid_tried', 'tried must be text or null')
    if (!optionalString(input.expected)) return refusal('invalid_expected', 'expected must be text or null')
    if (!optionalString(input.impact)) return refusal('invalid_impact', 'impact must be text or null')
    if (!optionalString(input.repro)) return refusal('invalid_repro', 'repro must be text or null')

    if (byteLength(input.summary) > FEEDBACK_CAPS.summaryBytes) return refusal('too_large_summary', `summary exceeds ${FEEDBACK_CAPS.summaryBytes} bytes`)
    if (byteLength(input.actual) > FEEDBACK_CAPS.actualBytes) return refusal('too_large_actual', `actual exceeds ${FEEDBACK_CAPS.actualBytes} bytes`)
    if (input.tried !== null && byteLength(input.tried) > FEEDBACK_CAPS.triedBytes) return refusal('too_large_tried', `tried exceeds ${FEEDBACK_CAPS.triedBytes} bytes`)
    if (input.expected !== null && byteLength(input.expected) > FEEDBACK_CAPS.expectedBytes) return refusal('too_large_expected', `expected exceeds ${FEEDBACK_CAPS.expectedBytes} bytes`)
    if (input.impact !== null && byteLength(input.impact) > FEEDBACK_CAPS.impactBytes) return refusal('too_large_impact', `impact exceeds ${FEEDBACK_CAPS.impactBytes} bytes`)
    if (input.repro !== null && byteLength(input.repro) > FEEDBACK_CAPS.reproBytes) return refusal('too_large_repro', `repro exceeds ${FEEDBACK_CAPS.reproBytes} bytes`)

    const narrativeBytes = byteLength(input.summary)
      + byteLength(input.actual)
      + byteLength(input.tried ?? '')
      + byteLength(input.expected ?? '')
      + byteLength(input.impact ?? '')
      + byteLength(input.repro ?? '')
    if (narrativeBytes > FEEDBACK_CAPS.narrativeTotalBytes) {
      return refusal('too_large_narrative', `narrative exceeds ${FEEDBACK_CAPS.narrativeTotalBytes} bytes`)
    }

    if (!isEnvironment(input.environment)) return refusal('invalid_environment', 'environment has an invalid shape')
    const environmentBytes = byteLength(JSON.stringify(input.environment))
    if (environmentBytes > FEEDBACK_CAPS.environmentBytes) {
      return refusal('too_large_environment', `environment exceeds ${FEEDBACK_CAPS.environmentBytes} bytes`)
    }

    if (!(input.lastError === null || isLastErrorRecordShape(input.lastError))) {
      return refusal('invalid_last_error', 'lastError must be a bounded v1 record or null')
    }
    if (input.lastError !== null && input.environment.teamSlug === null) {
      return refusal('invalid_last_error', 'lastError requires resolved team context')
    }

    if (!Array.isArray(input.attachments)) return refusal('invalid_attachment_count', 'attachments must be an array')
    if (input.attachments.length > FEEDBACK_CAPS.maxAttachments) {
      return refusal('invalid_attachment_count', `at most ${FEEDBACK_CAPS.maxAttachments} attachments are allowed`)
    }
    if (input.attachments.length > 0 && input.environment.teamSlug === null) {
      return refusal('invalid_attachments', 'attachments require resolved team context')
    }

    const attachments: ProductFeedbackAttachment[] = []
    const attachmentNames = new Set<string>()
    for (const [index, attachment] of input.attachments.entries()) {
      const attachmentIndex = `attachment ${index + 1}`
      if (!isObject(attachment) || !hasExactKeys(attachment, ['name', 'contentBase64'])) {
        return refusal('invalid_attachment_name', `${attachmentIndex} must contain only name and contentBase64`)
      }
      if (
        !hasValidProductFeedbackAttachmentNameSyntax(attachment.name)
        || attachment.name.toLowerCase() === 'last-error.json'
      ) {
        return refusal('invalid_attachment_name', `${attachmentIndex} name must be a bounded, non-reserved basename`)
      }
      const lowerName = attachment.name.toLowerCase()
      if (!FEEDBACK_ATTACHMENT_EXTENSIONS.some(extension => lowerName.endsWith(extension))) {
        return refusal('invalid_attachment_name', `${attachment.name} has an unsupported attachment extension`)
      }
      if (attachmentNames.has(lowerName)) {
        return refusal('invalid_attachment_name', `${attachment.name} duplicates an earlier attachment name after case-folding`)
      }
      attachmentNames.add(lowerName)
      const contentBase64 = attachment.contentBase64
      const decodedBytes = typeof contentBase64 === 'string'
        ? decodedBase64Bytes(contentBase64)
        : null
      if (typeof contentBase64 !== 'string' || decodedBytes === null || decodedBytes < 1) {
        return refusal('invalid_attachment_content', `${attachment.name} must contain non-empty UTF-8 text in canonical base64`)
      }
      if (decodedBytes > FEEDBACK_CAPS.attachmentBytes) {
        return refusal('too_large_attachment', `${attachment.name} exceeds ${FEEDBACK_CAPS.attachmentBytes} decoded bytes`)
      }
      if (!isUtf8TextBase64(contentBase64)) {
        return refusal('invalid_attachment_content', `${attachment.name} must contain non-empty UTF-8 text in canonical base64`)
      }
      attachments.push({ name: attachment.name, contentBase64 })
    }

    const bodyBytes = serializedByteLength(input)
    if (bodyBytes === null) return refusal('invalid_json', 'request body is not serializable')
    if (bodyBytes > FEEDBACK_CAPS.bodyBytes) return refusal('too_large_body', `request body exceeds ${FEEDBACK_CAPS.bodyBytes} bytes`)

    return {
      ok: true,
      request: {
        category: input.category as FeedbackCategory,
        severity: input.severity as FeedbackSeverity,
        summary: input.summary,
        actual: input.actual,
        tried: input.tried,
        expected: input.expected,
        impact: input.impact,
        repro: input.repro,
        environment: input.environment,
        lastError: input.lastError,
        attachments,
      },
    }
  } catch {
    return refusal('invalid_json', 'request body could not be inspected')
  }
}
