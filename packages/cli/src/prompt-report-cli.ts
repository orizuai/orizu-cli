import { extractErrorMessage } from './error-response.js'
import { authedFetch } from './http.js'
import { parseJsonResponse, sanitizeTerminalText } from './json-response.js'
import { readMarkdownReportInput } from './markdown-report-input.js'

const IDENTICAL_PROMPT_VERSION_ERROR =
  'Prompt version is identical to the current prompt version.'

function getArg(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name)
  if (index === -1 || index + 1 >= args.length) return null
  return args[index + 1]
}

function rejectDashPrefixedOptionValue(name: string, value: string | null) {
  if (value?.startsWith('-')) {
    throw new Error(`Invalid value for ${name}: option values cannot start with a dash`)
  }
}

export interface PromptReportCliContext {
  resolveProjectSlug: (project: string | null) => Promise<string>
  json: boolean
  printJson: (payload: Record<string, unknown>) => void
  printLine: (message?: string) => void
  fetcher?: (path: string, init?: RequestInit) => Promise<Response>
}

interface PromptReportResponse {
  prompt?: { id: string; name: string }
  version?: {
    id: string
    versionNumber: number | null
    status: string
    report: {
      markdown: string
      sourceName: string | null
    }
  }
  promptId?: string
  promptVersionId?: string
}

export async function promptReportCommand(
  args: readonly string[],
  context: PromptReportCliContext
) {
  const prompt = getArg(args, '--prompt')
  const projectArg = getArg(args, '--project')
  const version = getArg(args, '--version')
  const versionId = getArg(args, '--version-id')
  for (const [name, value] of [
    ['--prompt', prompt],
    ['--project', projectArg],
    ['--version-id', versionId],
  ] as const) {
    rejectDashPrefixedOptionValue(name, value)
  }

  if (!prompt) {
    throw new Error(
      'Usage: orizu prompts report set --prompt <id-or-name> [--project <team/project>] ' +
      '(--version <n> | --version-id <id>) ' +
      '(--report <markdown|@file> | --report-file <path>) [--json]'
    )
  }
  if (Boolean(version) === Boolean(versionId)) {
    throw new Error('Exactly one of --version or --version-id is required')
  }
  if (version && (!/^[1-9]\d*$/.test(version) || !Number.isSafeInteger(Number(version)))) {
    throw new Error('--version must be a positive integer')
  }

  const report = readMarkdownReportInput(args, 'Prompt')
  if (!report) {
    throw new Error(
      'Usage: orizu prompts report set --prompt <id-or-name> [--project <team/project>] ' +
      '(--version <n> | --version-id <id>) ' +
      '(--report <markdown|@file> | --report-file <path>) [--json]'
    )
  }

  const project = projectArg || await context.resolveProjectSlug(null)
  const query = new URLSearchParams({ project })
  if (version) query.set('version', version)
  else query.set('versionId', versionId as string)

  const fetcher = context.fetcher ?? authedFetch
  const response = await fetcher(
    `/api/cli/prompts/${encodeURIComponent(prompt)}/report?${query.toString()}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reportMarkdown: report.markdown,
        reportSourceName: report.sourceName,
      }),
    }
  )
  if (!response.ok) {
    throw new Error(`Failed to update prompt report: ${await extractErrorMessage(response)}`)
  }

  const data = await parseJsonResponse<PromptReportResponse>(response, 'Prompt report update')
  if (context.json) {
    context.printJson(data as unknown as Record<string, unknown>)
    return
  }
  const versionLabel = data.version
    ? data.version.versionNumber === null
      ? data.version.id
      : `v${data.version.versionNumber}`
    : data.promptVersionId || versionId || `v${version}`
  const promptName = data.prompt?.name || prompt
  const status = data.version?.status || 'updated'
  context.printLine(
    `Uploaded prompt report for ${sanitizeTerminalText(promptName)} ` +
    `(${sanitizeTerminalText(versionLabel)}) [${sanitizeTerminalText(status)}]`
  )
}

export async function promptPushErrorMessage(
  response: Response,
  kind: 'prompt' | 'judge',
  hasReport: boolean
): Promise<string> {
  const message = await extractErrorMessage(response)
  if (hasReport && response.status === 409 && message === IDENTICAL_PROMPT_VERSION_ERROR) {
    return (
      `${IDENTICAL_PROMPT_VERSION_ERROR} ` +
      'Attach the report to the existing version with `orizu prompts report set`.'
    )
  }
  return `Failed to push ${kind}: ${message}`
}
