import { sanitizeTerminalText } from './json-response.js'

interface PromptLabelCliContext {
  getArg: (name: string) => string | null
  getPositionalArg: (index: number) => string | null
  json: boolean
  printJson: (value: Record<string, unknown>) => void
  printLine: (value: string) => void
  resolveProjectSlug: (project: string | null) => Promise<string>
}

export async function setPromptLabel(context: PromptLabelCliContext): Promise<void> {
  const promptName = context.getPositionalArg(3)
  const label = context.getPositionalArg(4)
  const project = context.getArg('--project') || await context.resolveProjectSlug(null)
  const promptVersionId = context.getArg('--version')

  if (!promptName || !label || !promptVersionId) {
    throw new Error('Usage: orizu prompts labels set <prompt-name> <label> --version <prompt-version-id> [--project <team/project>] [--json]')
  }

  const writes = await import('./cli-write-commands.js')
  const reply = await writes.sendCommandWrite(writes.labelMove('prompt', project, { promptName, label, promptVersionId }), { json: context.json, print: context.printLine })
  if (reply === null) return
  if (context.json) {
    context.printJson(reply)
    return
  }
  context.printLine(`Moved ${sanitizeTerminalText(label)} to ${sanitizeTerminalText(promptVersionId)}`)
  // The reply is printed whole with --json, so it is kept as the server sent it.
  const owner = reply.owner
  if (typeof owner === 'object' && owner !== null && 'instructionSetSlug' in owner && 'componentKey' in owner) {
    context.printLine(
      `Owner: ${sanitizeTerminalText(promptName)} (${sanitizeTerminalText(String(reply.prompt_id))}) -> ` +
      `${sanitizeTerminalText(String(owner.instructionSetSlug))} / ${sanitizeTerminalText(String(owner.componentKey))}`
    )
  }
}
