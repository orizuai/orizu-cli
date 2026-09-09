import { redactSecrets } from './secret-redaction.js'

export const FEEDBACK_SCRUB_PLACEHOLDERS = {
  email: '[email]',
  ip: '[ip]',
  phone: '[phone]',
  home: '~',
  secret: '[redacted]',
  privateKey: '[redacted-private-key]',
} as const

export interface FeedbackScrubOptions {
  secrets?: readonly string[]
  reporterEmail?: string | null
  homeDir?: string | null
}

const CREDENTIAL_KEYS = [
  'password',
  'passwd',
  'secret',
  'token',
  'api_key',
  'apikey',
  'access_token',
  'refresh_token',
  'authorization',
  'bearer',
  'private_key',
  'client_secret',
  'secret_access_key',
  'access_key',
  'secret_key',
  'aws_secret_access_key',
] as const
function normalizeCredentialKey(key: string): string {
  return key.toLowerCase().replace(/[_.-]/g, '')
}

const NORMALIZED_CREDENTIAL_KEYS = [
  ...new Set(CREDENTIAL_KEYS.map(normalizeCredentialKey)),
]
const NON_CREDENTIAL_STATUS_VALUES = new Set([
  'true', 'false', 'null', 'yes', 'no', 'none', 'invalid', 'missing',
  'expired', 'required', 'absent',
])
const DIAGNOSTIC_CREDENTIAL_LIKE_KEYS = new Set(['haspassword', 'issecret'])
const CREDENTIAL_PAIR_PATTERNS = [
  ...new Set(CREDENTIAL_KEYS.map(key => key.replaceAll('_', '(?:[_.-]|[ \\t])?'))),
]
const IDENTIFIER_START_BOUNDARY = '(?<![A-Za-z0-9])'
const CREDENTIAL_PAIR_KEY = `${IDENTIFIER_START_BOUNDARY}(?:${CREDENTIAL_PAIR_PATTERNS.join('|')})`
const BARE_CREDENTIAL_PAIR_KEY = `${IDENTIFIER_START_BOUNDARY}(?:${CREDENTIAL_PAIR_PATTERNS
  .filter(key => key !== 'authorization')
  .join('|')})`
const CAMEL_CREDENTIAL_PAIR_KEY = `(?<=[a-z])(?:${[
  ...new Set(CREDENTIAL_KEYS.map(key => key
    .split('_')
    .map(word => word[0].toUpperCase() + word.slice(1))
    .join(''))),
].join('|')})`

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function replaceGoogleApiKeys(input: string): string {
  return input.replace(
    /(^|[^0-9A-Za-z_-])(AIza[0-9A-Za-z_-]{35})(?![0-9A-Za-z_-])/g,
    (_match, prefix: string) => `${prefix}${FEEDBACK_SCRUB_PLACEHOLDERS.secret}`
  )
}

function replacePemPrivateKeys(input: string): string {
  return input.replace(
    /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g,
    FEEDBACK_SCRUB_PLACEHOLDERS.privateKey
  )
}

function replaceUrlUserInfo(input: string): string {
  return input.replace(
    /\b([A-Za-z][A-Za-z\d+.-]*:\/\/)([^\s/?#]+)@(?=[^\s/?#])/g,
    (_match, scheme: string) => `${scheme}${FEEDBACK_SCRUB_PLACEHOLDERS.secret}@`
  )
}

function replaceExactHome(input: string, homeDir: string | null): string {
  const normalizedHome = homeDir?.trim().replace(/[\\/]+$/, '') ?? ''
  if (!normalizedHome) return input

  if (/^[A-Za-z]:\\/.test(normalizedHome)) {
    const drive = normalizedHome.slice(0, 2)
    const components = normalizedHome.slice(2).split(/\\+/).filter(Boolean)
    const separatorPattern = '\\\\{1,2}'
    const windowsHomePattern = new RegExp(
      `${escapeRegExp(drive)}${separatorPattern}${components.map(escapeRegExp).join(separatorPattern)}(?=$|[^A-Za-z0-9_.-])`,
      'gi'
    )
    return input.replace(windowsHomePattern, FEEDBACK_SCRUB_PLACEHOLDERS.home)
  }

  const homePattern = new RegExp(`${escapeRegExp(normalizedHome)}(?=$|[^A-Za-z0-9_.-])`, 'g')
  return input.replace(homePattern, FEEDBACK_SCRUB_PLACEHOLDERS.home)
}

function replaceConventionalHomes(input: string): string {
  const accountHomeWithChildPattern = /(^|[\s"'=(:])(\/(?:Users|home)\/[A-Za-z0-9_][A-Za-z0-9._-]{0,63})(?=\/)/g
  const terminalAccountHomePattern = /(["'=])(\/(?:Users|home)\/[A-Za-z0-9_][A-Za-z0-9._-]{0,63})(?=$|[^A-Za-z0-9_.-])/g
  const rootHomePattern = /(^|[\s"'=(:])(\/root)(?=$|\/)/g
  return input
    .replace(accountHomeWithChildPattern, (_match, context: string) =>
      `${context}${FEEDBACK_SCRUB_PLACEHOLDERS.home}`
    )
    .replace(terminalAccountHomePattern, (_match, context: string) =>
      `${context}${FEEDBACK_SCRUB_PLACEHOLDERS.home}`
    )
    .replace(rootHomePattern, (_match, context: string) =>
      `${context}${FEEDBACK_SCRUB_PLACEHOLDERS.home}`
    )
    .replace(/\b[A-Za-z]:(\\{1,2})Users\1[^\s/\\"']+/gi, FEEDBACK_SCRUB_PLACEHOLDERS.home)
}

function isValidIpv4(candidate: string): boolean {
  const octets = candidate.split('.')
  return octets.length === 4 && octets.every(octet => {
    if (!/^\d{1,3}$/.test(octet)) return false
    const value = Number(octet)
    return value >= 0 && value <= 255
  })
}

function replaceIpv4(input: string): string {
  return input.replace(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g, candidate =>
    isValidIpv4(candidate) ? FEEDBACK_SCRUB_PLACEHOLDERS.ip : candidate
  )
}

function isValidIpv6Candidate(candidate: string): boolean {
  const compressionCount = candidate.match(/::/g)?.length ?? 0
  if (compressionCount > 1) return false

  const groups = candidate.split(':').filter(group => group !== '')
  if (groups.length === 0 || !groups.every(group => /^[a-f\d]{1,4}$/i.test(group))) return false
  return compressionCount === 1
    ? groups.length <= 7
    : groups.length === 8
}

function isValidMixedIpv6Candidate(candidate: string): boolean {
  const lastColon = candidate.lastIndexOf(':')
  const ipv6Prefix = candidate.slice(0, lastColon + 1)
  const ipv4 = candidate.slice(lastColon + 1)
  if (!isValidIpv4(ipv4)) return false

  const compressionCount = ipv6Prefix.match(/::/g)?.length ?? 0
  if (compressionCount > 1) return false
  const groups = ipv6Prefix.split(':').filter(group => group !== '')
  if (!groups.every(group => /^[a-f\d]{1,4}$/i.test(group))) return false
  return compressionCount === 1
    ? groups.length <= 5
    : groups.length === 6
}

function replaceIpv6(input: string): string {
  const ipv4Mapped = input.replace(
    /(?<![A-Fa-f\d:])::ffff:((?:\d{1,3}\.){3}\d{1,3})(?![\d.])/gi,
    (candidate, ipv4: string) => isValidIpv4(ipv4) ? FEEDBACK_SCRUB_PLACEHOLDERS.ip : candidate
  )
  const mixedIpv6 = ipv4Mapped.replace(
    /(?<![A-Za-z0-9_])[A-Fa-f\d:]*:(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g,
    candidate => isValidMixedIpv6Candidate(candidate) ? FEEDBACK_SCRUB_PLACEHOLDERS.ip : candidate
  )

  return mixedIpv6.replace(/(?<![A-Za-z0-9_])[A-Fa-f\d:]{2,}(?![A-Za-z0-9_])/g, candidate =>
    isValidIpv6Candidate(candidate) ? FEEDBACK_SCRUB_PLACEHOLDERS.ip : candidate
  )
}

function replacePhones(input: string): string {
  return input.replace(/(?<![\d])\+?\d[\d\s().-]{7,}\d(?![\d])/g, (candidate, offset: number) => {
    const digitCount = candidate.replace(/\D/g, '').length
    const hasSeparator = candidate.startsWith('+') || /[\s().-]/.test(candidate)
    const isDateTime = /^\d{4}-\d{2}-\d{2}(?:\s+\d{1,2})?$/.test(candidate)
    const isDottedQuad = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(candidate)
    const surroundingText = input.slice(Math.max(0, offset - 24), offset + candidate.length + 24)
    const isPartOfUuid = /\b[\da-f]{8}-[\da-f]{4}-[1-5][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}\b/i.test(surroundingText)
    const hasTimeSuffix = /^:\d{2}(?::\d{2})?/.test(input.slice(offset + candidate.length))
    return digitCount >= 10 && digitCount <= 15 && hasSeparator
      && !isDateTime && !hasTimeSuffix && !isDottedQuad && !isPartOfUuid
      ? FEEDBACK_SCRUB_PLACEHOLDERS.phone
      : candidate
  })
}

const OPTIONAL_ESCAPED_QUOTE = String.raw`(?:\\?["'])?`
const ESCAPED_QUOTE = String.raw`\\?["']`
const QUOTED_CREDENTIAL_PAIR = new RegExp(
  String.raw`((${OPTIONAL_ESCAPED_QUOTE}${CREDENTIAL_PAIR_KEY}${OPTIONAL_ESCAPED_QUOTE})\s*[:=]\s*)(\\?)(["'])((?:\\.|(?!\4)[^\\\r\n])*?)\3\4`,
  'gi'
)
const CAMEL_QUOTED_CREDENTIAL_PAIR = new RegExp(
  String.raw`((${OPTIONAL_ESCAPED_QUOTE}${CAMEL_CREDENTIAL_PAIR_KEY}${OPTIONAL_ESCAPED_QUOTE})\s*[:=]\s*)(\\?)(["'])((?:\\.|(?!\4)[^\\\r\n])*?)\3\4`,
  'g'
)
const AUTHORIZATION_SCHEME_PAIR = new RegExp(
  String.raw`((${IDENTIFIER_START_BOUNDARY}${OPTIONAL_ESCAPED_QUOTE}authorization${OPTIONAL_ESCAPED_QUOTE})[ \t]*[:=][ \t]*)((?:[A-Za-z][A-Za-z0-9_-]*))([ \t]+)([^\r\n]*)`,
  'gi'
)
const BARE_CREDENTIAL_VALUE = String.raw`(?:[^\s,;&}"')\[\]>]|&(?![A-Za-z_][\w.-]*[ \t]*=))+`
const AUTHORIZATION_BARE_PAIR = new RegExp(
  String.raw`((${IDENTIFIER_START_BOUNDARY}${OPTIONAL_ESCAPED_QUOTE}authorization${OPTIONAL_ESCAPED_QUOTE})[ \t]*[:=][ \t]*)((?!${ESCAPED_QUOTE})${BARE_CREDENTIAL_VALUE})`,
  'gi'
)
const BARE_CREDENTIAL_PAIR = new RegExp(
  `((${OPTIONAL_ESCAPED_QUOTE}${BARE_CREDENTIAL_PAIR_KEY}${OPTIONAL_ESCAPED_QUOTE})[ \\t]*[:=][ \\t]*)((?!${ESCAPED_QUOTE})${BARE_CREDENTIAL_VALUE})`,
  'gi'
)
const CAMEL_BARE_CREDENTIAL_PAIR = new RegExp(
  `((${OPTIONAL_ESCAPED_QUOTE}${CAMEL_CREDENTIAL_PAIR_KEY}${OPTIONAL_ESCAPED_QUOTE})[ \\t]*[:=][ \\t]*)((?!${ESCAPED_QUOTE})${BARE_CREDENTIAL_VALUE})`,
  'g'
)

function isNonCredentialStatus(value: string): boolean {
  return NON_CREDENTIAL_STATUS_VALUES.has(value.trim().toLowerCase())
}

function rawIndexForNormalizedOffset(key: string, normalizedOffset: number): number {
  let offset = 0
  for (let index = 0; index < key.length; index += 1) {
    if (/[_.-]/.test(key[index])) continue
    if (offset === normalizedOffset) return index
    offset += 1
  }
  return key.length
}

function isStructuredCredentialKey(key: string): boolean {
  const normalizedKey = normalizeCredentialKey(key)
  if (/^(?:hasPassword|isSecret)$/.test(key)) return false
  return NORMALIZED_CREDENTIAL_KEYS.some(credentialKey => {
    if (!normalizedKey.endsWith(credentialKey)) return false
    const normalizedStart = normalizedKey.length - credentialKey.length
    if (normalizedStart === 0) return true

    const rawStart = rawIndexForNormalizedOffset(key, normalizedStart)
    const previousCharacter = key[rawStart - 1]
    return /[_.-]/.test(previousCharacter)
      || (/[a-z]/.test(previousCharacter) && /[A-Z]/.test(key[rawStart]))
  })
}

function isNonCredentialStructuredValue(value: unknown): boolean {
  return value === null
    || typeof value === 'boolean'
    || (typeof value === 'string' && isNonCredentialStatus(value))
}

function isCredentialLikeAuthorizationToken(token: string): boolean {
  return token.length >= 8 || /[^A-Za-z]/.test(token)
}

function isCredentialLikeUnknownAuthorizationToken(token: string): boolean {
  return token.length >= 8 || /[^A-Za-z]/.test(token)
}

function splitAuthorizationTrailer(value: string): { core: string; trailer: string } {
  const punctuation = value.match(/([.,)\]>,])$/)
  return punctuation
    ? { core: value.slice(0, -1), trailer: punctuation[1] }
    : { core: value, trailer: '' }
}

function replaceQuotedCredentialPair(
  match: string,
  prefix: string,
  _key: string,
  openingEscape: string,
  quote: string,
  value: string
): string {
  return isNonCredentialStatus(value)
    ? match
    : `${prefix}${openingEscape}${quote}${FEEDBACK_SCRUB_PLACEHOLDERS.secret}${openingEscape}${quote}`
}

function isDiagnosticCamelPair(
  key: string,
  offset: number,
  input: string
): boolean {
  const identifierPrefix = /[A-Za-z0-9_]+$/.exec(input.slice(0, offset))?.[0] ?? ''
  const unquotedKey = key.replace(/\\?["']/g, '')
  return DIAGNOSTIC_CREDENTIAL_LIKE_KEYS.has(
    normalizeCredentialKey(`${identifierPrefix}${unquotedKey}`)
  )
}

function replaceCamelQuotedCredentialPair(
  match: string,
  prefix: string,
  key: string,
  openingEscape: string,
  quote: string,
  value: string,
  offset: number,
  input: string
): string {
  return isDiagnosticCamelPair(key, offset, input)
    ? match
    : replaceQuotedCredentialPair(match, prefix, key, openingEscape, quote, value)
}

function splitBareCredentialTrailer(
  match: string,
  value: string,
  offset: number,
  input: string
): { core: string; trailer: string } {
  const following = input.slice(offset + match.length)
  const isBeforeAnotherField = /^(?:\s+|&)[A-Za-z_][\w.-]*[ \t]*[:=]/.test(following)
  const hasSentencePeriod = value.endsWith('.') && !isBeforeAnotherField
  return hasSentencePeriod
    ? { core: value.slice(0, -1), trailer: '.' }
    : { core: value, trailer: '' }
}

function replaceBareCredentialPair(
  match: string,
  prefix: string,
  _key: string,
  value: string,
  offset: number,
  input: string
): string {
  const { core, trailer } = splitBareCredentialTrailer(match, value, offset, input)
  return isNonCredentialStatus(core)
    ? match
    : `${prefix}${FEEDBACK_SCRUB_PLACEHOLDERS.secret}${trailer}`
}

function replaceCamelBareCredentialPair(
  match: string,
  prefix: string,
  key: string,
  value: string,
  offset: number,
  input: string
): string {
  return isDiagnosticCamelPair(key, offset, input)
    ? match
    : replaceBareCredentialPair(match, prefix, key, value, offset, input)
}

function replaceBareAuthorizationPair(
  match: string,
  prefix: string,
  key: string,
  value: string,
  offset: number,
  input: string
): string {
  const { core } = splitBareCredentialTrailer(match, value, offset, input)
  return isCredentialLikeAuthorizationToken(core)
    ? replaceBareCredentialPair(match, prefix, key, value, offset, input)
    : match
}

function replaceCredentialPairs(input: string): string {
  return input
    .replace(QUOTED_CREDENTIAL_PAIR, replaceQuotedCredentialPair)
    .replace(CAMEL_QUOTED_CREDENTIAL_PAIR, replaceCamelQuotedCredentialPair)
    .replace(AUTHORIZATION_SCHEME_PAIR, (
      match,
      prefix: string,
      _key: string,
      scheme: string,
      schemeGap: string,
      value: string
    ) => {
      const normalizedScheme = scheme.toLowerCase()
      const isKnownScheme = /^(?:bearer|basic|digest|aws4-hmac-sha256|token)$/.test(normalizedScheme)
      const isMultipartScheme = /^(?:digest|aws4-hmac-sha256)$/.test(normalizedScheme)
      if (!isKnownScheme && isNonCredentialStatus(normalizedScheme)) return match

      const isTrailingField = /^[A-Za-z_][\w.-]*[ \t]*[:=]/.test(value)
      if (!isKnownScheme && isTrailingField) {
        return isCredentialLikeAuthorizationToken(scheme)
          ? `${prefix}${FEEDBACK_SCRUB_PLACEHOLDERS.secret}${schemeGap}${value}`
          : match
      }

      let credential = value
      let remainder = ''
      if (!isMultipartScheme) {
        const credentialParts = /^(\S+)(.*)$/.exec(value)
        if (!credentialParts) return match
        credential = credentialParts[1]
        remainder = credentialParts[2]
      }
      const { core, trailer } = splitAuthorizationTrailer(credential)
      const shouldRedact = isKnownScheme
        || isCredentialLikeUnknownAuthorizationToken(core)
      return shouldRedact
        ? `${prefix}${FEEDBACK_SCRUB_PLACEHOLDERS.secret}${trailer}${remainder}`
        : match
    })
    .replace(AUTHORIZATION_BARE_PAIR, replaceBareAuthorizationPair)
    .replace(BARE_CREDENTIAL_PAIR, replaceBareCredentialPair)
    .replace(CAMEL_BARE_CREDENTIAL_PAIR, replaceCamelBareCredentialPair)
}

export function scrubFeedbackText(
  input: string,
  options: FeedbackScrubOptions = {}
): string {
  const reporterEmail = options.reporterEmail?.trim().toLowerCase() ?? null
  const exactSecrets = [...new Set(options.secrets ?? [])]
    .sort((left, right) => right.length - left.length)
  let scrubbed = replaceGoogleApiKeys(input)
  scrubbed = replacePemPrivateKeys(scrubbed)
  scrubbed = redactSecrets(scrubbed, { secrets: exactSecrets })
  scrubbed = replaceUrlUserInfo(scrubbed)
  scrubbed = replaceExactHome(scrubbed, options.homeDir ?? null)
  scrubbed = replaceConventionalHomes(scrubbed)
  scrubbed = scrubbed.replace(/(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}(?![A-Z0-9._%+-])/gi, address =>
    reporterEmail && address.toLowerCase() === reporterEmail
      ? address
      : FEEDBACK_SCRUB_PLACEHOLDERS.email
  )
  scrubbed = replaceIpv6(scrubbed)
  scrubbed = replaceIpv4(scrubbed)
  scrubbed = replacePhones(scrubbed)
  return replaceCredentialPairs(scrubbed)
}

export function scrubFeedbackValue<T>(
  value: T,
  options: FeedbackScrubOptions = {}
): T {
  if (typeof value === 'string') {
    return scrubFeedbackText(value, options) as T
  }
  if (Array.isArray(value)) {
    return value.map(item => scrubFeedbackValue(item, options)) as T
  }
  if (value && typeof value === 'object') {
    const scrubbed = Object.create(null) as Record<string, unknown>
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      const scrubbedKey = scrubFeedbackText(key, options)
      let uniqueKey = scrubbedKey
      let collisionIndex = 2
      while (Object.prototype.hasOwnProperty.call(scrubbed, uniqueKey)) {
        uniqueKey = `${scrubbedKey}#${collisionIndex}`
        collisionIndex += 1
      }
      const isCredentialValue = isStructuredCredentialKey(key)
        && !isNonCredentialStructuredValue(inner)
      scrubbed[uniqueKey] = isCredentialValue
        ? FEEDBACK_SCRUB_PLACEHOLDERS.secret
        : scrubFeedbackValue(inner, options)
    }
    return scrubbed as T
  }
  return value
}
