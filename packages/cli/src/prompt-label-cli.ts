import { authedFetch } from './http.js'
import { parseJsonResponse, sanitizeTerminalText } from './json-response.js'

interface PromptLabelCliContext {
  getArg: (name: string) => string | null
  getPositionalArg: (index: number) => string | null
  json: boolean
  printJson: (value: Record<string, unknown>) => void
  printLine: (value: string) => void
  resolveProjectSlug: (project: string | null) => Promise<string>
}

interface PromptLabelResponse {
  prompt_id: string
  prompt_version_id: string
  label: string
  owner?: {
    instructionSetSlug: string
    componentKey: string
  } | null
}

export async function setPromptLabel(context: PromptLabelCliContext): Promise<void> {
  const promptName = context.getPositionalArg(3)
  const label = context.getPositionalArg(4)
  const project = context.getArg('--project') || await context.resolveProjectSlug(null)
  const promptVersionId = context.getArg('--version')

  if (!promptName || !label || !promptVersionId) {
    throw new Error('Usage: orizu prompts labels set <prompt-name> <label> --version <prompt-version-id> [--project <team/project>] [--json]')
  }

  const response = await authedFetch(`/api/cli/prompts/labels?project=${encodeURIComponent(project)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ promptName, label, promptVersionId }),
  })
  if (!response.ok) {
    throw new Error(`Failed to set prompt label: ${await response.text()}`)
  }

  const data = await parseJsonResponse<PromptLabelResponse>(response, 'Prompt label set')
  if (context.json) {
    context.printJson(data as unknown as Record<string, unknown>)
    return
  }

  context.printLine(`Moved ${sanitizeTerminalText(label)} to ${sanitizeTerminalText(promptVersionId)}`)
  if (data.owner) {
    context.printLine(
      `Owner: ${sanitizeTerminalText(promptName)} (${sanitizeTerminalText(data.prompt_id)}) -> ` +
      `${sanitizeTerminalText(data.owner.instructionSetSlug)} / ${sanitizeTerminalText(data.owner.componentKey)}`
    )
  }
}
