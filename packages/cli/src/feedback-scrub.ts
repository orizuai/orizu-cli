import { domainToASCII } from 'node:url'

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
  'expired', 'required', 'absent', 'set',
])
const DIAGNOSTIC_CREDENTIAL_LIKE_KEYS = new Set(['haspassword', 'issecret'])
const CREDENTIAL_PAIR_PATTERNS = [
  ...new Set(CREDENTIAL_KEYS.map(key => key.replaceAll('_', '(?:[_.-]|[ \\t])?'))),
]
const IDENTIFIER_START_BOUNDARY = '(?<![A-Za-z0-9])'
const CREDENTIAL_PAIR_KEY = `${IDENTIFIER_START_BOUNDARY}(?:${CREDENTIAL_PAIR_PATTERNS.join('|')})`
const BARE_CREDENTIAL_PAIR_PATTERNS = CREDENTIAL_PAIR_PATTERNS
  .filter(key => key !== 'authorization')
const BARE_CREDENTIAL_PAIR_KEY = `${IDENTIFIER_START_BOUNDARY}(?:${BARE_CREDENTIAL_PAIR_PATTERNS
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

function replaceHomesInUrls(input: string): string {
  return input.replace(
    /\b([A-Za-z][A-Za-z\d+.-]*:\/\/[^\s/?#]*\/)(?:Users|home)\/[A-Za-z0-9_][A-Za-z0-9._-]{0,63}(?=\/)/g,
    (_match, prefix: string) => `${prefix}${FEEDBACK_SCRUB_PLACEHOLDERS.home}`
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

function normalizeEmailAddress(address: string): string | null {
  const at = address.lastIndexOf('@')
  if (at <= 0 || at === address.length - 1) return null
  const local = address.slice(0, at)
  const isQuoted = /^"(?:\\.|[^"\\\r\n])*"$/.test(local)
  if (!isQuoted && (/\s|["()<>\[\],;:@]/.test(local)
    || /^\.|\.$|\.\./.test(local))) return null

  const domain = domainToASCII(address.slice(at + 1).normalize('NFC').toLowerCase())
  const labels = domain.split('.')
  const topLevelDomain = labels[labels.length - 1] ?? ''
  if (!domain || labels.length < 2
    || !labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
    || !/^(?:[a-z]{2,}|xn--[a-z0-9-]{2,})$/i.test(topLevelDomain)) return null
  return `${local.toLowerCase().normalize('NFC')}@${domain}`
}

const EMAIL_LOCAL_MAX_CHARS = 64
const EMAIL_DOMAIN_MAX_CHARS = 253

function isEmailLocalCharacter(character: string): boolean {
  // &, =, /, and ? stay boundaries because they collide with URL queries and email= diagnostics.
  return character !== '' && !/[\s"()<>\[\],;:@=&?/]/.test(character)
}

function isEmailDomainCharacter(character: string): boolean {
  return /^[A-Za-z0-9.-]$/.test(character)
    || (character !== '' && character.charCodeAt(0) > 127 && !/\s/.test(character))
}

function isEscapedCharacter(input: string, index: number): boolean {
  let backslashes = 0
  for (let cursor = index - 1; cursor >= 0 && input[cursor] === '\\'; cursor -= 1) backslashes += 1
  return backslashes % 2 === 1
}

function previousCodePointStart(input: string, end: number): number {
  const finalCodeUnit = input.charCodeAt(end - 1)
  const precedingCodeUnit = input.charCodeAt(end - 2)
  const isSurrogatePair = finalCodeUnit >= 0xdc00 && finalCodeUnit <= 0xdfff
    && precedingCodeUnit >= 0xd800 && precedingCodeUnit <= 0xdbff
  return end - (isSurrogatePair ? 2 : 1)
}

function nextCodePointEnd(input: string, start: number): number {
  const firstCodeUnit = input.charCodeAt(start)
  const followingCodeUnit = input.charCodeAt(start + 1)
  const isSurrogatePair = firstCodeUnit >= 0xd800 && firstCodeUnit <= 0xdbff
    && followingCodeUnit >= 0xdc00 && followingCodeUnit <= 0xdfff
  return start + (isSurrogatePair ? 2 : 1)
}

interface EmailBounds {
  start: number
  end: number
  canTrimLeading: boolean
}

function emailBoundsAt(input: string, at: number): EmailBounds | null {
  let start = at
  let canTrimLeading = false
  if (input[at - 1] === '"') {
    let scannedCodePoints = 0
    let foundOpeningQuote = false
    start = at - 1
    while (start > 0 && scannedCodePoints < EMAIL_LOCAL_MAX_CHARS) {
      start = previousCodePointStart(input, start)
      if (input[start] === '"' && !isEscapedCharacter(input, start)) {
        foundOpeningQuote = true
        break
      }
      scannedCodePoints += 1
    }
    canTrimLeading = !foundOpeningQuote
  } else {
    let scannedCodePoints = 0
    while (start > 0 && scannedCodePoints < EMAIL_LOCAL_MAX_CHARS) {
      const previousStart = previousCodePointStart(input, start)
      if (!isEmailLocalCharacter(input.slice(previousStart, start))) break
      start = previousStart
      scannedCodePoints += 1
    }
    if (start === at) return null

    const previousStart = start > 0 ? previousCodePointStart(input, start) : start
    canTrimLeading = start > 0
      && isEmailLocalCharacter(input.slice(previousStart, start))
    if (canTrimLeading) {
      const asciiSuffix = /[A-Za-z0-9.!#$%'*+\-^_`{|}~]+$/.exec(input.slice(start, at))
      if (asciiSuffix !== null) start = at - asciiSuffix[0].length
    }
  }

  let end = at + 1
  let scannedCodePoints = 0
  while (end < input.length && scannedCodePoints < EMAIL_DOMAIN_MAX_CHARS) {
    const nextEnd = nextCodePointEnd(input, end)
    if (!isEmailDomainCharacter(input.slice(end, nextEnd))) break
    end = nextEnd
    scannedCodePoints += 1
  }
  if (end === at + 1) return null
  while (input[end - 1] === '.') end -= 1
  return end === at + 1 ? null : { start, end, canTrimLeading }
}

interface NormalizedEmailCandidate {
  address: string
  normalized: string
  leadingOffset: number
}

function normalizeEmailCandidate(
  address: string, canTrimLeading: boolean
): NormalizedEmailCandidate | null {
  const at = address.lastIndexOf('@')
  let candidateStart = 0
  while (candidateStart < at) {
    let candidateEnd = address.length
    while (candidateEnd > at + 1) {
      const candidate = address.slice(candidateStart, candidateEnd)
      const normalized = normalizeEmailAddress(candidate)
      if (normalized !== null) {
        return { address: candidate, normalized, leadingOffset: candidateStart }
      }
      candidateEnd = previousCodePointStart(address, candidateEnd)
    }
    if (!canTrimLeading) break
    candidateStart = nextCodePointEnd(address, candidateStart)
  }
  return null
}

function replaceEmails(input: string, reporterEmail: string | null): string {
  const reporter = reporterEmail === null ? null : normalizeEmailAddress(reporterEmail.trim())
  let copiedUntil = 0
  let searchFrom = 0
  let result = ''
  for (let at = input.indexOf('@', searchFrom); at >= 0; at = input.indexOf('@', searchFrom)) {
    searchFrom = at + 1
    const bounds = emailBoundsAt(input, at)
    if (bounds === null) continue
    const candidate = normalizeEmailCandidate(
      input.slice(bounds.start, bounds.end), bounds.canTrimLeading
    )
    if (candidate === null) continue
    const addressStart = bounds.start + candidate.leadingOffset
    const addressEnd = addressStart + candidate.address.length
    result += input.slice(copiedUntil, addressStart)
      + (reporter === candidate.normalized
        ? candidate.address
        : FEEDBACK_SCRUB_PLACEHOLDERS.email)
    copiedUntil = addressEnd
    searchFrom = addressEnd
  }
  return copiedUntil === 0 ? input : result + input.slice(copiedUntil)
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
const QUOTED_CREDENTIAL_MAX_LINES = 8
const QUOTED_CREDENTIAL_START = new RegExp(
  String.raw`((${OPTIONAL_ESCAPED_QUOTE}${CREDENTIAL_PAIR_KEY}${OPTIONAL_ESCAPED_QUOTE})\s*[:=]\s*)(\\?)(["'])`,
  'gi'
)
const CAMEL_QUOTED_CREDENTIAL_START = new RegExp(
  String.raw`((${OPTIONAL_ESCAPED_QUOTE}${CAMEL_CREDENTIAL_PAIR_KEY}${OPTIONAL_ESCAPED_QUOTE})\s*[:=]\s*)(\\?)(["'])`,
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
const CREDENTIAL_PROSE_START = String.raw`(?:^[ \t]*(?:[-*+>][ \t]+)?|(?:;|,|\(|\[|\{|\|)[ \t]*|--?)`
const BARE_CREDENTIAL_PROSE_PAIR = new RegExp(
  `((${CREDENTIAL_PROSE_START}${OPTIONAL_ESCAPED_QUOTE}(?:${BARE_CREDENTIAL_PAIR_PATTERNS.join('|')})${OPTIONAL_ESCAPED_QUOTE})[ \\t]*[:=][ \\t]*)((?!${ESCAPED_QUOTE})[^\\r\\n]*)`,
  'gim'
)
const CAMEL_CREDENTIAL_PROSE_PAIR = new RegExp(
  `((${OPTIONAL_ESCAPED_QUOTE}${CAMEL_CREDENTIAL_PAIR_KEY}${OPTIONAL_ESCAPED_QUOTE})[ \\t]*[:=][ \\t]*)((?!${ESCAPED_QUOTE})[^\\r\\n]*)`,
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

function replaceCredentialProsePair(
  match: string, prefix: string, _key: string, value: string
): string {
  // Separators need whitespace/end; the existing numeric next=1 trailer stays unambiguous.
  const nextField = /[ \t]+[A-Za-z0-9_.-]+[ \t]*(?:[:=](?=[ \t]|$)|=(?=\d+(?:[ \t]|$)))/.exec(value)
  const core = nextField ? value.slice(0, nextField.index) : value
  if (!/[ \t]/.test(core.trim()) || isNonCredentialStatus(core)) return match
  return `${prefix}${FEEDBACK_SCRUB_PLACEHOLDERS.secret}${nextField ? value.slice(nextField.index) : ''}`
}

function replaceCamelCredentialProsePair(
  match: string, prefix: string, key: string, value: string, offset: number, input: string
): string {
  return isDiagnosticCamelPair(key, offset, input)
    ? match
    : replaceCredentialProsePair(match, prefix, key, value)
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

interface QuotedValueScan {
  end: number
  valueEnd: number
  closingQuote: string
  keepsOpeningQuote: boolean
}

function lineIndentationAt(input: string, index: number): number {
  const lineStart = Math.max(
    input.lastIndexOf('\r', index - 1),
    input.lastIndexOf('\n', index - 1)
  ) + 1
  return /^[ \t]*/.exec(input.slice(lineStart, index))?.[0].length ?? 0
}

function scanQuotedValue(
  input: string,
  valueStart: number,
  credentialIndentation: number,
  openingEscape: string,
  quote: string
): QuotedValueScan {
  let lineCount = 1
  for (let cursor = valueStart; cursor < input.length; cursor += 1) {
    const hasClosingQuote = openingEscape
      ? input[cursor] === '\\' && input[cursor + 1] === quote
        && !isEscapedCharacter(input, cursor)
      : input[cursor] === quote && !isEscapedCharacter(input, cursor)
    if (hasClosingQuote) {
      const closingQuote = `${openingEscape}${quote}`
      return {
        end: cursor + closingQuote.length,
        valueEnd: cursor,
        closingQuote,
        keepsOpeningQuote: false,
      }
    }

    if (input[cursor] === '\r' || input[cursor] === '\n') {
      const lineBreakLength = input[cursor] === '\r' && input[cursor + 1] === '\n' ? 2 : 1
      const nextLineStart = cursor + lineBreakLength
      let nextLineEnd = nextLineStart
      while (nextLineEnd < input.length
        && input[nextLineEnd] !== '\r' && input[nextLineEnd] !== '\n') nextLineEnd += 1
      const nextLine = input.slice(nextLineStart, nextLineEnd)
      const nextIndentation = /^[ \t]*/.exec(nextLine)?.[0].length ?? 0
      const isBoundary = nextLine.trim() === '' || (
        nextIndentation <= credentialIndentation && CREDENTIAL_FIELD_START.test(nextLine)
      )
      if (isBoundary || lineCount === QUOTED_CREDENTIAL_MAX_LINES) {
        return { end: cursor, valueEnd: cursor, closingQuote: '', keepsOpeningQuote: true }
      }
      lineCount += 1
      if (lineBreakLength === 2) cursor += 1
    }
  }
  return {
    end: input.length,
    valueEnd: input.length,
    closingQuote: '',
    keepsOpeningQuote: false,
  }
}

function replaceQuotedCredentialPairsForPattern(
  input: string,
  pattern: RegExp,
  isCamel: boolean
): string {
  pattern.lastIndex = 0
  let copiedUntil = 0
  let result = ''
  for (let match = pattern.exec(input); match !== null; match = pattern.exec(input)) {
    const [wholeMatch, prefix, key, openingEscape, quote] = match
    const valueStart = match.index + wholeMatch.length
    const scan = scanQuotedValue(
      input, valueStart, lineIndentationAt(input, match.index), openingEscape, quote
    )
    pattern.lastIndex = Math.max(pattern.lastIndex, scan.end)
    const value = input.slice(valueStart, scan.valueEnd)
    const valueAfterRedaction = value.slice(FEEDBACK_SCRUB_PLACEHOLDERS.secret.length)
    const isUnclosedRedaction = !scan.closingQuote
      && value.startsWith(FEEDBACK_SCRUB_PLACEHOLDERS.secret)
      && (valueAfterRedaction === '' || /^(?:\r\n|\r|\n)/.test(valueAfterRedaction))
    if ((isCamel && isDiagnosticCamelPair(key, match.index, input))
      || (scan.closingQuote && isNonCredentialStatus(value))
      || isUnclosedRedaction) continue

    const quotedRedaction = scan.closingQuote
      ? `${openingEscape}${quote}${FEEDBACK_SCRUB_PLACEHOLDERS.secret}${scan.closingQuote}`
      : scan.keepsOpeningQuote
        ? `${openingEscape}${quote}${FEEDBACK_SCRUB_PLACEHOLDERS.secret}`
        : FEEDBACK_SCRUB_PLACEHOLDERS.secret
    result += input.slice(copiedUntil, match.index) + prefix + quotedRedaction
    copiedUntil = scan.end
  }
  return copiedUntil === 0 ? input : result + input.slice(copiedUntil)
}

function replaceQuotedCredentialPairs(input: string): string {
  const standard = replaceQuotedCredentialPairsForPattern(
    input, QUOTED_CREDENTIAL_START, false
  )
  return replaceQuotedCredentialPairsForPattern(
    standard, CAMEL_QUOTED_CREDENTIAL_START, true
  )
}

function replaceSingleLineCredentialPairs(input: string): string {
  return input
    .replace(BARE_CREDENTIAL_PROSE_PAIR, replaceCredentialProsePair)
    .replace(CAMEL_CREDENTIAL_PROSE_PAIR, replaceCamelCredentialProsePair)
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

const CREDENTIAL_FIELD_START = /^([ \t]*)(?:\\?["'])?([A-Za-z0-9_.-]+)(?:\\?["'])?[ \t]*[:=]/

function credentialFieldIndentation(line: string): number | null {
  const field = CREDENTIAL_FIELD_START.exec(line)
  if (!field) return null
  return isStructuredCredentialKey(field[2]) ? field[1].length : null
}

function hasUnclosedQuotedRedaction(line: string): boolean {
  return /[:=][ \t]*\\?["']\[redacted\]$/.test(line)
}

function replaceCredentialPairs(input: string): string {
  const quoted = replaceQuotedCredentialPairs(input)
  const original = quoted.split(/(\r\n|\r|\n)/)
  const scrubbed = replaceSingleLineCredentialPairs(quoted).split(/(\r\n|\r|\n)/)
  let credentialIndentation: number | null = null
  let isUnclosedQuotedBlock = false
  let previousContinues = false
  let result = ''

  // A credential normally continues deeper than its key or after a trailing backslash.
  // An unclosed quoted value also continues at the key's depth until a blank or new field.
  for (let index = 0; index < original.length; index += 2) {
    const line = original[index]
    const indentation = /^[ \t]*/.exec(line)?.[0] ?? ''
    const fieldIndentation = credentialFieldIndentation(line)
    const isField = CREDENTIAL_FIELD_START.test(line)
    const isDeeper = credentialIndentation !== null
      && indentation.length > credentialIndentation
    const isAtCredentialDepth = credentialIndentation !== null
      && indentation.length >= credentialIndentation
    const isContinuation = credentialIndentation !== null && (
      isDeeper
      || (previousContinues && !isField)
      || (isUnclosedQuotedBlock && isAtCredentialDepth && !isField)
    )
    let output = scrubbed[index]

    if (line.trim() === '') {
      credentialIndentation = null
      isUnclosedQuotedBlock = false
      previousContinues = false
    } else if (isContinuation) {
      output = `${indentation}${FEEDBACK_SCRUB_PLACEHOLDERS.secret}`
      previousContinues = /\\[ \t]*$/.test(line)
      if (!isDeeper && !previousContinues && !isUnclosedQuotedBlock) {
        credentialIndentation = null
      }
    } else {
      credentialIndentation = fieldIndentation
      isUnclosedQuotedBlock = fieldIndentation !== null
        && hasUnclosedQuotedRedaction(output)
      previousContinues = fieldIndentation !== null && /\\[ \t]*$/.test(line)
    }
    result += output + (original[index + 1] ?? '')
  }
  return result
}

export function scrubFeedbackText(
  input: string,
  options: FeedbackScrubOptions = {}
): string {
  const reporterEmail = options.reporterEmail ?? null
  const exactSecrets = [...new Set(options.secrets ?? [])]
    .sort((left, right) => right.length - left.length)
  let scrubbed = replaceGoogleApiKeys(input)
  scrubbed = replacePemPrivateKeys(scrubbed)
  scrubbed = redactSecrets(scrubbed, { secrets: exactSecrets })
  scrubbed = replaceUrlUserInfo(scrubbed)
  scrubbed = replaceHomesInUrls(scrubbed)
  scrubbed = replaceExactHome(scrubbed, options.homeDir ?? null)
  scrubbed = replaceConventionalHomes(scrubbed)
  scrubbed = replaceEmails(scrubbed, reporterEmail)
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
