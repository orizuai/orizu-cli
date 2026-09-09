import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'fs'
import { homedir, release } from 'os'
import {
  basename,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'path'

import { parseCliProjectSlug } from './cli-project-slug.js'
import {
  FEEDBACK_ATTACHMENT_EXTENSIONS,
  FEEDBACK_CAPS,
  FROM_FILE_KEYS,
  hasValidProductFeedbackAttachmentNameSyntax,
  hasValidProductFeedbackSlugSyntax,
  isLastErrorRecordShape,
  PRODUCT_FEEDBACK_ROUTE,
  PRODUCT_FEEDBACK_UNAUTHENTICATED_MESSAGE,
  type ProductFeedbackAttachment,
  type ProductFeedbackRequest,
  type ProductFeedbackSuccess,
  validateProductFeedbackRequest,
} from './feedback-contract.js'
import {
  getSecretsSeenThisProcess,
  getConfigDir,
  getServerCredentials,
  resolveEnvBearerToken,
} from './credentials.js'
import { scrubFeedbackText, scrubFeedbackValue } from './feedback-scrub.js'
import {
  LAST_ERROR_ATTACH_MAX_AGE_MS,
  readLastErrorRecord,
  type LastErrorRecord,
} from './last-error-record.js'
import { captureAuthenticatedRequestContext } from './http.js'
import {
  parseJsonResponse,
  sanitizeHumanInlineText,
  sanitizeTerminalText,
} from './json-response.js'
import {
  existingWorkspaceTeamSlug,
  getWorkspaceRoot,
  workspaceExists,
} from './workspace.js'

export interface FeedbackCliIo {
  json: boolean
  print: (message: string) => void
  printErr: (message: string) => void
  fetcher?: (path: string, init?: RequestInit) => Promise<Response>
  configDir?: string
  cwd?: string
  now?: () => number
  homeDir?: string
  hasAuth?: (baseUrl: string) => boolean
}

interface ParsedFeedbackArgs {
  values: Record<string, string>
  attachments: string[]
  fromFile: string | null
  project: string | null
  suppressLastError: boolean
}

interface ProjectContext {
  teamSlug: string | null
  projectSlug: string | null
}

const VALUE_FLAGS = [
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
] as const
const REPEATABLE_FLAGS = new Set(['--attach'])
const FATAL_TEXT_DECODER = new TextDecoder('utf-8', { fatal: true })
const FROM_FILE_KEY_SET = new Set<string>(FROM_FILE_KEYS)
const FROM_FILE_MAX_BYTES = 65_536

function clientRefusal(code: string, reason: string): string {
  return `${code}: ${reason}`
}

function getCliVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  ) as { version?: unknown }
  if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
    throw new Error('Unable to read orizu CLI version.')
  }
  return packageJson.version
}

function safeCliVersion(): string | null {
  try {
    return getCliVersion()
  } catch {
    return null
  }
}

function expandHomePath(path: string, homeDirectory: string): string {
  return path === '~'
    ? homeDirectory
    : path.startsWith('~/')
      ? resolve(homeDirectory, path.slice(2))
      : path
}

function parseFeedbackArgs(args: readonly string[]): ParsedFeedbackArgs | string {
  const values: Record<string, string> = {}
  const attachments: string[] = []
  const seen = new Set<string>()
  let fromFile: string | null = null
  let project: string | null = null
  let suppressLastError = false

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--json') continue
    if (argument === '--no-last-error') {
      if (seen.has(argument)) {
        return clientRefusal('invalid_flag_repeated', '--no-last-error may be given only once')
      }
      seen.add(argument)
      suppressLastError = true
      continue
    }

    let flag = argument
    let value: string | null = null
    const equalsIndex = argument.indexOf('=')
    if (equalsIndex > 0) {
      flag = argument.slice(0, equalsIndex)
      value = argument.slice(equalsIndex + 1)
    }

    if (!(VALUE_FLAGS as readonly string[]).includes(flag)) {
      return clientRefusal('invalid_flag_value', `unknown argument ${argument}`)
    }
    if (!REPEATABLE_FLAGS.has(flag) && seen.has(flag)) {
      return clientRefusal('invalid_flag_repeated', `${flag} may be given only once`)
    }
    if (value === null) {
      const candidate = args[index + 1]
      if (!candidate) return clientRefusal('invalid_flag_value', `${flag} requires a value`)
      if (candidate.startsWith('-')) {
        return clientRefusal(
          'invalid_flag_value',
          `${flag} needs a value (use ${flag}=<text> for values that start with a dash)`
        )
      }
      value = candidate
      index += 1
    }
    if (value.length === 0) return clientRefusal('invalid_flag_value', `${flag} requires a value`)

    seen.add(flag)
    if (flag === '--attach') attachments.push(value)
    else if (flag === '--from-file') fromFile = value
    else if (flag === '--project') project = value
    else values[flag.slice(2)] = value
  }

  if (attachments.length > FEEDBACK_CAPS.maxAttachments) {
    return clientRefusal(
      'invalid_attachment_count',
      `at most ${FEEDBACK_CAPS.maxAttachments} user attachments are allowed`
    )
  }
  return { values, attachments, fromFile, project, suppressLastError }
}

function readFromFile(path: string, homeDirectory: string): Record<string, unknown> | string {
  const expandedPath = expandHomePath(path, homeDirectory)
  let descriptor: number
  try {
    descriptor = openSync(
      expandedPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ELOOP'
      ? clientRefusal('invalid_from_file', '--from-file must be a regular file, not a link')
      : clientRefusal('invalid_from_file_unreadable', '--from-file could not be opened')
  }

  let contents: string
  try {
    const entry = fstatSync(descriptor)
    if (!entry.isFile()) {
      return clientRefusal('invalid_from_file', '--from-file must be a regular file')
    }
    if (entry.size > FROM_FILE_MAX_BYTES) {
      return clientRefusal('invalid_from_file', `--from-file exceeds ${FROM_FILE_MAX_BYTES} bytes`)
    }
    contents = readFileSync(descriptor, 'utf8')
  } catch {
    return clientRefusal('invalid_from_file_unreadable', '--from-file could not be read')
  } finally {
    closeSync(descriptor)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(contents) as unknown
  } catch {
    return clientRefusal('invalid_from_file_json', '--from-file contains invalid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return clientRefusal('invalid_from_file_json', '--from-file must contain one JSON object')
  }
  const entries = Object.entries(parsed as Record<string, unknown>)
  const unknownEntry = entries.find(([key]) => !FROM_FILE_KEY_SET.has(key))
  if (unknownEntry) {
    return clientRefusal('invalid_from_file_json', `--from-file contains unknown field ${unknownEntry[0]}`)
  }
  const invalidEntry = entries.find(([, value]) => value !== null && typeof value !== 'string')
  if (invalidEntry) {
    return clientRefusal('invalid_from_file_json', `${invalidEntry[0]} must be a string or null`)
  }
  return Object.fromEntries(entries)
}

function canonicalConfigRoot(configDirectory: string): string {
  try {
    return realpathSync(configDirectory)
  } catch {
    return resolve(configDirectory)
  }
}

function attachmentIsInsideConfig(path: string, canonicalConfigDirectory: string): boolean {
  const pathFromConfig = relative(canonicalConfigDirectory, path)
  return pathFromConfig === ''
    || (
      pathFromConfig !== '..'
      && !pathFromConfig.startsWith(`..${sep}`)
      && !isAbsolute(pathFromConfig)
    )
}

function readAttachment(
  inputPath: string,
  attachmentIndex: number,
  options: {
    canonicalConfigDirectory: string
    homeDirectory: string
    secrets: readonly string[]
    onRename: (originalName: string, attachmentName: string) => void
  }
): ProductFeedbackAttachment | string {
  const resolvedPath = resolve(expandHomePath(inputPath, options.homeDirectory))
  const name = basename(resolvedPath)

  if (name.toLowerCase() === 'last-error.json') {
    return clientRefusal('invalid_attachment_name', 'last-error.json is reserved for the automatic last-error record')
  }
  if (!FEEDBACK_ATTACHMENT_EXTENSIONS.includes(extname(name).toLowerCase() as typeof FEEDBACK_ATTACHMENT_EXTENSIONS[number])) {
    return clientRefusal('invalid_attachment_extension', `attachment ${name} is not a supported text file`)
  }

  let descriptor: number
  try {
    descriptor = openSync(
      resolvedPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ELOOP'
      ? clientRefusal('invalid_attachment_path', `${name} must be a regular file, not a link or directory`)
      : clientRefusal('invalid_attachment_unreadable', `cannot open attachment ${name}`)
  }

  let bytes: Uint8Array
  try {
    const entry = fstatSync(descriptor)
    if (entry.isFIFO()) {
      return clientRefusal('invalid_attachment_unreadable', `${name} must not be a pipe`)
    }
    if (!entry.isFile()) {
      return clientRefusal('invalid_attachment_path', `${name} must be a regular file, not a link or directory`)
    }
    if (entry.size > FEEDBACK_CAPS.attachmentBytes) {
      return clientRefusal('too_large_attachment', `${name} exceeds ${FEEDBACK_CAPS.attachmentBytes} bytes`)
    }

    const canonicalPath = realpathSync(resolvedPath)
    if (attachmentIsInsideConfig(canonicalPath, options.canonicalConfigDirectory)) {
      return clientRefusal('invalid_attachment_path', `${name} is inside the Orizu config directory and cannot be attached`)
    }
    bytes = readFileSync(descriptor)
  } catch {
    return clientRefusal('invalid_attachment_unreadable', `cannot read attachment ${name}`)
  } finally {
    closeSync(descriptor)
  }
  let contents: string
  try {
    contents = FATAL_TEXT_DECODER.decode(bytes)
  } catch {
    return clientRefusal('invalid_attachment_content', `${name} is not a UTF-8 text file`)
  }
  if (contents.includes('\0')) {
    return clientRefusal('invalid_attachment_content', `${name} is not a UTF-8 text file`)
  }

  const scrubOptions = {
    reporterEmail: null,
    homeDir: options.homeDirectory,
    secrets: options.secrets,
  }
  const scrubbed = scrubFeedbackText(contents, scrubOptions)
  const scrubbedName = scrubFeedbackText(name, scrubOptions)
  const attachmentName = scrubbedName === name
    && hasValidProductFeedbackAttachmentNameSyntax(name)
    ? name
    : `attachment-${attachmentIndex}${extname(name)}`
  if (attachmentName !== name) options.onRename(scrubbedName, attachmentName)
  return { name: attachmentName, contentBase64: btoa(unescape(encodeURIComponent(scrubbed))) }
}

function firstUnusedAttachmentName(
  extension: string,
  attachments: readonly ProductFeedbackAttachment[]
): string {
  const usedNames = new Set(attachments.map(attachment => attachment.name.toLowerCase()))
  for (let number = 1; ; number += 1) {
    const candidate = `attachment-${number}${extension}`
    if (!usedNames.has(candidate.toLowerCase())) return candidate
  }
}

function activeCredentialSecrets(baseUrl: string): string[] {
  const credentials = getServerCredentials(baseUrl)
  if (!credentials) return []
  return 'accessToken' in credentials
    ? [credentials.accessToken, credentials.refreshToken]
    : [credentials.apiKey]
}

function activeCredentialSecretsBestEffort(baseUrl: string): string[] {
  try {
    return activeCredentialSecrets(baseUrl)
  } catch {
    return []
  }
}

function resolveScrubSecrets(baseUrl: string, envBearer: string | null): string[] {
  return [...new Set([
    ...(envBearer ? [envBearer] : []),
    ...getSecretsSeenThisProcess(),
    ...activeCredentialSecretsBestEffort(baseUrl),
  ])]
}

function currentEnvironmentBearerBestEffort(): string | null {
  try {
    return resolveEnvBearerToken()
  } catch {
    return null
  }
}

function currentScrubSecrets(baseUrl: string, initialSecrets: readonly string[]): string[] {
  return [...new Set([
    ...initialSecrets,
    ...getSecretsSeenThisProcess(),
    ...activeCredentialSecretsBestEffort(baseUrl),
  ])]
}

function parsedProjectContext(value: string): ProjectContext | null {
  const parsed = parseCliProjectSlug(value)
  return parsed
    && hasValidProductFeedbackSlugSyntax(parsed.teamSlug)
    && hasValidProductFeedbackSlugSyntax(parsed.projectSlug)
    ? parsed
    : null
}

function resolveProjectContext(
  explicitProject: string | null,
  cwd: string
): ProjectContext | string {
  const invalidProject = clientRefusal(
    'invalid_flag_value',
    '--project must be <team-slug>/<project-slug>'
  )
  if (explicitProject) return parsedProjectContext(explicitProject) ?? invalidProject
  if (process.env.ORIZU_PROJECT) {
    return parsedProjectContext(process.env.ORIZU_PROJECT) ?? invalidProject
  }
  const workspaceTeam = existingWorkspaceTeamSlug(getWorkspaceRoot(cwd))
  return { teamSlug: workspaceTeam, projectSlug: null }
}

function lastErrorForContext(
  configDirectory: string,
  serverBaseUrl: string,
  teamSlug: string | null,
  now: number,
  printErr: (message: string) => void,
  scrubNotice: (message: string) => string
): LastErrorRecord | null {
  const record = readLastErrorRecord(configDirectory)
  if (!record || !isLastErrorRecordShape(record)) return null
  if (teamSlug === null) {
    printErr('last error not attached: no team context')
    return null
  }
  if (record.serverBaseUrl !== null && record.serverBaseUrl !== serverBaseUrl) {
    printErr('last error not attached: recorded for a different server or team')
    return null
  }
  if (record.teamSlug !== null && record.teamSlug !== teamSlug) {
    printErr('last error not attached: recorded for a different team')
    return null
  }

  const recordedAt = Date.parse(record.recordedAt)
  const age = now - recordedAt
  const descriptor = lastErrorDescriptor(record)
  if (age >= 0 && age <= LAST_ERROR_ATTACH_MAX_AGE_MS) return record
  printErr(scrubNotice(`Ignored stale ${descriptor}.`))
  return null
}

function lastErrorDescriptor(record: LastErrorRecord): string {
  return `last-error record for ${record.command ?? 'unknown'} at ${record.recordedAt}`
}

function scrubLastErrorRecord(
  record: LastErrorRecord | null,
  scrubOptions: { reporterEmail: null; homeDir: string; secrets: readonly string[] }
): unknown | null {
  if (record === null) return null
  const scrubbed = scrubFeedbackValue(record, scrubOptions) as unknown as Record<string, unknown>
  scrubbed.serverBaseUrl = record.serverBaseUrl
  scrubbed.teamSlug = record.teamSlug
  return scrubbed
}

function runtimeDescription(): string {
  const bunRuntime = (globalThis as { Bun?: { version: string } }).Bun
  return bunRuntime
    ? `bun ${bunRuntime.version}`
    : `node ${process.versions.node}`
}

function isProductFeedbackSuccess(value: unknown): value is ProductFeedbackSuccess {
  return value !== null
    && typeof value === 'object'
    && typeof (value as Record<string, unknown>).id === 'string'
    && ((value as Record<string, unknown>).id as string).trim().length > 0
    && typeof (value as Record<string, unknown>).message === 'string'
    && ((value as Record<string, unknown>).message as string).trim().length > 0
}

const INVALID_TOKEN_FILE_MESSAGE = 'invalid_token_file: ORIZU_TOKEN_FILE is set but could not be read; fix the sandbox or email feedback@orizu.ai'
const DEFAULT_FEEDBACK_TIMEOUT_MS = 30_000
const FEEDBACK_TIMEOUT_MESSAGE = `feedback_timeout: no response within ${DEFAULT_FEEDBACK_TIMEOUT_MS / 1_000} s. Email feedback@orizu.ai`
const FEEDBACK_STORAGE_UNCERTAINTY_MESSAGE = 'The report may or may not have been stored; retrying can file it twice. Email feedback@orizu.ai'

function printFeedbackTimeout(printErr: (message: string) => void): void {
  printErr(FEEDBACK_TIMEOUT_MESSAGE)
  printErr(FEEDBACK_STORAGE_UNCERTAINTY_MESSAGE)
}

export function resolveFeedbackTimeoutMs(baseUrl: string): number {
  const hostname = new URL(baseUrl).hostname.toLowerCase()
  const isLoopback = hostname === 'localhost'
    || hostname === '[::1]'
    || /^127(?:\.\d{1,3}){3}$/.test(hostname)
  if (!isLoopback) return DEFAULT_FEEDBACK_TIMEOUT_MS

  const configured = Number(process.env.ORIZU_FEEDBACK_TIMEOUT_MS)
  return Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, DEFAULT_FEEDBACK_TIMEOUT_MS)
    : DEFAULT_FEEDBACK_TIMEOUT_MS
}

function endpointUnavailableMessage(status: number): string {
  return `Feedback endpoint unavailable (status ${status}). Email feedback@orizu.ai`
}

function ambiguousEndpointFailureMessage(status: number): string {
  return `Feedback endpoint unavailable (status ${status}). The report may or may not have been stored; retrying can file it twice. Email feedback@orizu.ai`
}

function isInvalidTokenFileError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('ORIZU_TOKEN_FILE')
}

function scrubbedErrorMessage(error: unknown, secrets: readonly string[], homeDirectory: string): string {
  return scrubFeedbackText(error instanceof Error ? error.message : String(error), {
    reporterEmail: null,
    homeDir: homeDirectory,
    secrets,
  })
}

function scrubbedInlineErrorMessage(
  error: unknown,
  secrets: readonly string[],
  homeDirectory: string
): string {
  return sanitizeHumanInlineText(
    sanitizeTerminalText,
    scrubbedErrorMessage(error, secrets, homeDirectory)
  )
}

export async function feedbackCommand(args: string[], io: FeedbackCliIo): Promise<number> {
  const configDirectory = io.configDir ?? getConfigDir()
  const canonicalConfigDirectory = canonicalConfigRoot(configDirectory)
  const cwd = io.cwd ?? process.cwd()
  const homeDirectory = io.homeDir ?? homedir()
  const now = io.now ?? Date.now
  let requestContext: ReturnType<typeof captureAuthenticatedRequestContext>
  try {
    requestContext = captureAuthenticatedRequestContext({ pinEnvBearerValue: true })
  } catch (error) {
    if (isInvalidTokenFileError(error)) {
      io.printErr(INVALID_TOKEN_FILE_MESSAGE)
    } else if (error instanceof Error && error.message.startsWith('Not logged in for ')) {
      io.printErr(clientRefusal('unauthenticated', PRODUCT_FEEDBACK_UNAUTHENTICATED_MESSAGE))
    } else {
      io.printErr(`network_error: ${scrubbedErrorMessage(error, getSecretsSeenThisProcess(), homeDirectory)}. Email feedback@orizu.ai`)
    }
    return 1
  }
  const baseUrl = requestContext.baseUrl
  const isHosted = requestContext.source !== 'stored'
  let secrets = resolveScrubSecrets(baseUrl, null)
  const scrubNotice = (message: string) => scrubFeedbackText(message, {
    reporterEmail: null,
    homeDir: homeDirectory,
    secrets,
  })

  try {
    const parsed = parseFeedbackArgs(args)
    if (typeof parsed === 'string') {
      io.printErr(scrubNotice(parsed))
      return 1
    }

    const fromFile = parsed.fromFile
      ? readFromFile(parsed.fromFile, homeDirectory)
      : {}
    if (typeof fromFile === 'string') {
      io.printErr(scrubNotice(fromFile))
      return 1
    }

    const projectContext = resolveProjectContext(parsed.project, cwd)
    if (typeof projectContext === 'string') {
      io.printErr(scrubNotice(projectContext))
      return 1
    }
    if (parsed.attachments.length > 0 && projectContext.teamSlug === null) {
      io.printErr(clientRefusal(
        'invalid_attachments',
        'attachments need a project: pass --project <team/project> or set ORIZU_PROJECT'
      ))
      return 1
    }

    const attachments: ProductFeedbackAttachment[] = []
    for (const [index, path] of parsed.attachments.entries()) {
      const attachment = readAttachment(path, index + 1, {
        canonicalConfigDirectory,
        homeDirectory,
        secrets,
        onRename: (originalName, attachmentName) => {
          io.printErr(`attachment renamed: ${originalName} -> ${attachmentName}`)
        },
      })
      if (typeof attachment === 'string') {
        io.printErr(scrubNotice(attachment))
        return 1
      }
      let acceptedAttachment: ProductFeedbackAttachment = attachment
      if (attachments.some(
        existing => existing.name.toLowerCase() === acceptedAttachment.name.toLowerCase()
      )) {
        const renamedAttachment = firstUnusedAttachmentName(
          extname(acceptedAttachment.name),
          attachments
        )
        io.printErr(`attachment renamed: ${acceptedAttachment.name} -> ${renamedAttachment}`)
        acceptedAttachment = { ...acceptedAttachment, name: renamedAttachment }
      }
      attachments.push(acceptedAttachment)
    }

    secrets = resolveScrubSecrets(baseUrl, currentEnvironmentBearerBestEffort())
    const values = { ...fromFile, ...parsed.values }
    const lastError = parsed.suppressLastError
      ? null
      : lastErrorForContext(
        configDirectory,
        baseUrl,
        projectContext.teamSlug,
        now(),
        io.printErr,
        scrubNotice
      )
    const scrubOptions = { reporterEmail: null, homeDir: homeDirectory, secrets }
    const scrubbedFields = scrubFeedbackValue({
      category: values.category,
      severity: values.severity,
      summary: values.summary,
      actual: values.actual,
      tried: values.tried ?? null,
      expected: values.expected ?? null,
      impact: values.impact ?? null,
      repro: values.repro ?? null,
    }, scrubOptions) as Omit<ProductFeedbackRequest, 'attachments' | 'environment' | 'lastError'>
    const requestCandidate: Omit<ProductFeedbackRequest, 'attachments'> = {
      ...scrubbedFields,
      lastError: scrubLastErrorRecord(lastError, scrubOptions),
      environment: {
        cliVersion: safeCliVersion(),
        os: `${process.platform} ${release()}`,
        runtime: runtimeDescription(),
        serverBaseUrl: baseUrl,
        hosted: isHosted,
        teamSlug: projectContext.teamSlug,
        projectSlug: projectContext.projectSlug,
        workspaceRootFound: workspaceExists(cwd),
      },
    }
    const validation = validateProductFeedbackRequest({ ...requestCandidate, attachments })
    if (!validation.ok) {
      io.printErr(scrubNotice(validation.refusal.message))
      return 1
    }

    if (lastError !== null) {
      io.printErr(scrubNotice(`Attached ${lastErrorDescriptor(lastError)}.`))
    }

    const fetcher = io.fetcher ?? requestContext.fetch
    const feedbackSignal = AbortSignal.timeout(resolveFeedbackTimeoutMs(baseUrl))
    let response: Response
    try {
      response = await fetcher(PRODUCT_FEEDBACK_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validation.request),
        signal: feedbackSignal,
      })
    } catch (error) {
      if (feedbackSignal.aborted) {
        printFeedbackTimeout(io.printErr)
        return 1
      }
      throw error
    }
    const responseSecrets = currentScrubSecrets(baseUrl, secrets)
    let responseBody: unknown
    try {
      responseBody = await parseJsonResponse<unknown>(response, 'Product feedback')
    } catch {
      if (feedbackSignal.aborted) {
        printFeedbackTimeout(io.printErr)
        return 1
      }
      if (response.status !== 429) {
        io.printErr(response.status >= 500 && response.status <= 599
          ? ambiguousEndpointFailureMessage(response.status)
          : endpointUnavailableMessage(response.status))
        return 1
      }
      responseBody = null
    }
    if (response.status === 429) {
      const responseError = responseBody !== null
        && typeof responseBody === 'object'
        && typeof (responseBody as Record<string, unknown>).error === 'string'
        ? (responseBody as Record<string, unknown>).error as string
        : 'rate limited'
      const detail = responseError.replace(/^rate_limited:\s*/i, '').trim() || 'rate limited'
      const retryAfter = response.headers.get('Retry-After')
      const retryInstruction = retryAfter === null
        ? ''
        : /^\d+$/.test(retryAfter)
          ? `; retry after ${retryAfter} s`
          : `; retry at ${retryAfter}`
      io.printErr(scrubbedInlineErrorMessage(
        `rate_limited: ${detail}${retryInstruction}`,
        responseSecrets,
        homeDirectory
      ))
      return 1
    }
    if (!response.ok) {
      const serverError = responseBody !== null
        && typeof responseBody === 'object'
        && typeof (responseBody as Record<string, unknown>).error === 'string'
        ? (responseBody as Record<string, unknown>).error as string
        : `Product feedback failed with status ${response.status}.`
      if (response.status >= 500 && response.status <= 599) {
        if (response.status === 500 && /^storage_failed(?:\b|:)/.test(serverError)) {
          io.printErr(scrubbedInlineErrorMessage(serverError, responseSecrets, homeDirectory))
          io.printErr('Nothing was stored; try again in a minute or email feedback@orizu.ai')
        } else {
          io.printErr(ambiguousEndpointFailureMessage(response.status))
        }
        return 1
      }
      io.printErr(scrubbedInlineErrorMessage(serverError, responseSecrets, homeDirectory))
      return 1
    }
    if (!isProductFeedbackSuccess(responseBody)) {
      io.printErr(endpointUnavailableMessage(response.status))
      return 1
    }

    const success = scrubFeedbackValue(responseBody, {
      ...scrubOptions,
      secrets: responseSecrets,
      reporterEmail: 'feedback@orizu.ai',
    }) as unknown as ProductFeedbackSuccess
    if (io.json) io.print(JSON.stringify(success))
    else {
      io.print(sanitizeHumanInlineText(
        sanitizeTerminalText,
        `Reported (id ${success.id}). ${success.message}`
      ))
    }
    return 0
  } catch (error) {
    io.printErr(isInvalidTokenFileError(error)
      ? INVALID_TOKEN_FILE_MESSAGE
      : `network_error: ${scrubbedErrorMessage(error, currentScrubSecrets(baseUrl, secrets), homeDirectory)}. Email feedback@orizu.ai`)
    return 1
  }
}
