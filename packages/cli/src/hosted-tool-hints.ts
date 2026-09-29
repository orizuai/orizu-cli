/**
 * Tool display hints (ORI-2160, moved here for ORI-2167).
 *
 * Each harness driver has its own built-in tools. This module holds, per
 * driver, what the chat needs to show a call without switching on its name:
 * a category (icon), a label (the verb on the row), the input key that
 * summarizes the call, how to show the output, and input keys to hide.
 *
 * It has no imports with side effects, so both the CLI and the web app
 * (the chat renderer, and the activity projection that picks which input
 * key reaches the browser) import it directly.
 */
// Type-only, so the web build never has to load the harness module itself.
import type { HARNESS_NAMES } from './hosted-harness.js'

type HarnessNames = typeof HARNESS_NAMES
const OPENCODE: HarnessNames['opencode'] = 'opencode'
const CLAUDE_AGENT_SDK: HarnessNames['claudeAgentSdk'] = 'claude-agent-sdk'

/** What kind of thing a tool does — the renderer picks an icon/layout from
 *  this, never from the tool name. */
export const TOOL_CATEGORIES = {
  file: 'file',
  command: 'command',
  search: 'search',
  network: 'network',
  question: 'question',
  subAgent: 'sub-agent',
  list: 'list',
  plug: 'plug',
  other: 'other',
} as const

export type ToolCategory = (typeof TOOL_CATEGORIES)[keyof typeof TOOL_CATEGORIES]

/** How the tool's output text should be shown. */
export const TOOL_OUTPUT_KINDS = {
  text: 'text',
  diff: 'diff',
  markdown: 'markdown',
  json: 'json',
  list: 'list',
} as const

type ToolOutputKind = (typeof TOOL_OUTPUT_KINDS)[keyof typeof TOOL_OUTPUT_KINDS]

/** Per-tool display hint. Each driver owns a table of these for its built-in
 *  tools, so tool-name knowledge lives behind the seam. */
export interface ToolHint {
  category: ToolCategory
  /** The verb the chat row shows ("Read", "Ran"). A tool without a hint shows
   *  its own name instead. */
  label?: string
  /** The input key whose value summarizes the call (e.g. `command`), or null
   *  when the tool takes no input worth summarizing. */
  summaryKey: string | null
  outputKind: ToolOutputKind
  /** Input keys whose values must not be shown as-is (large bodies such as a
   *  file's full new content, or likely secrets). */
  redactKeys: readonly string[]
}

export type ToolHintTable = Readonly<Record<string, ToolHint>>

// Argument names that look like they hold a credential. Redacted for every
// tool, and never used as the fallback summary.
const SECRET_LOOKING_KEY = /token|secret|password|passwd|api[_-]?key|authorization|credential/i

/**
 * Look a tool up in a driver's hint table. A tool the table does not know (an
 * MCP tool, a plug-in) falls back to the `plug` category, summarized by its
 * first non-empty string argument that does not look like a secret.
 */
export function resolveToolHint(
  table: ToolHintTable,
  tool: string,
  args: Record<string, unknown> = {}
): ToolHint {
  const known = Object.hasOwn(table, tool) ? table[tool] : undefined
  const secretKeys = Object.keys(args).filter(key => SECRET_LOOKING_KEY.test(key))
  const redactKeys = [...new Set([...(known?.redactKeys ?? []), ...secretKeys])]
  if (known) return { ...known, redactKeys }
  const summaryKey =
    Object.keys(args).find(key => {
      const value = args[key]
      return typeof value === 'string' && value.length > 0 && !redactKeys.includes(key)
    }) ?? null
  return { category: TOOL_CATEGORIES.plug, summaryKey, outputKind: TOOL_OUTPUT_KINDS.text, redactKeys }
}

// OpenCode's built-in tools, as the pinned opencode-ai@1.14.41 tool registry
// lists them, with the input key that summarizes each call. Tools not listed
// here (MCP tools, plug-ins) resolve to `plug` through resolveToolHint.
export const OPENCODE_TOOL_HINTS: ToolHintTable = {
  read: { category: 'file', label: 'Read', summaryKey: 'filePath', outputKind: 'text', redactKeys: [] },
  edit: { category: 'file', label: 'Edited', summaryKey: 'filePath', outputKind: 'diff', redactKeys: ['oldString', 'newString'] },
  write: { category: 'file', label: 'Wrote', summaryKey: 'filePath', outputKind: 'text', redactKeys: ['content'] },
  apply_patch: { category: 'file', label: 'Edited', summaryKey: 'patchText', outputKind: 'diff', redactKeys: [] },
  lsp: { category: 'file', label: 'Checked', summaryKey: 'filePath', outputKind: 'json', redactKeys: [] },
  bash: { category: 'command', label: 'Ran', summaryKey: 'command', outputKind: 'text', redactKeys: [] },
  glob: { category: 'search', label: 'Listed', summaryKey: 'pattern', outputKind: 'list', redactKeys: [] },
  grep: { category: 'search', label: 'Searched', summaryKey: 'pattern', outputKind: 'text', redactKeys: [] },
  webfetch: { category: 'network', label: 'Fetched', summaryKey: 'url', outputKind: 'markdown', redactKeys: [] },
  websearch: { category: 'network', label: 'Searched', summaryKey: 'query', outputKind: 'text', redactKeys: [] },
  question: { category: 'question', label: 'Asked', summaryKey: 'questions', outputKind: 'text', redactKeys: [] },
  plan_exit: { category: 'question', label: 'Asked', summaryKey: null, outputKind: 'text', redactKeys: [] },
  task: { category: 'sub-agent', label: 'Sub-agent', summaryKey: 'description', outputKind: 'markdown', redactKeys: [] },
  todowrite: { category: 'list', label: 'Planned', summaryKey: 'todos', outputKind: 'json', redactKeys: [] },
  skill: { category: 'other', label: 'Loaded', summaryKey: 'name', outputKind: 'markdown', redactKeys: [] },
  invalid: { category: 'other', label: 'Invalid', summaryKey: 'tool', outputKind: 'text', redactKeys: [] },
}

// The Claude Agent SDK's built-in tools (SDK 0.3.201: input types in
// sdk-tools.d.ts, names from the SDK; `Task` is the older name of `Agent`),
// with the input key that summarizes each call. MCP tools
// (`mcp__<server>__<tool>`) are not listed and resolve to `plug` through
// resolveToolHint. This driver sends no `title` or `metadata`: the SDK has no
// equivalent of OpenCode's.
export const CLAUDE_TOOL_HINTS: ToolHintTable = {
  Read: { category: 'file', label: 'Read', summaryKey: 'file_path', outputKind: 'text', redactKeys: [] },
  Edit: { category: 'file', label: 'Edited', summaryKey: 'file_path', outputKind: 'text', redactKeys: ['old_string', 'new_string'] },
  Write: { category: 'file', label: 'Wrote', summaryKey: 'file_path', outputKind: 'text', redactKeys: ['content'] },
  NotebookEdit: { category: 'file', label: 'Edited', summaryKey: 'notebook_path', outputKind: 'text', redactKeys: ['new_source'] },
  Bash: { category: 'command', label: 'Ran', summaryKey: 'command', outputKind: 'text', redactKeys: [] },
  TaskOutput: { category: 'command', label: 'Checked', summaryKey: 'task_id', outputKind: 'text', redactKeys: [] },
  TaskStop: { category: 'command', label: 'Stopped', summaryKey: 'task_id', outputKind: 'text', redactKeys: [] },
  Glob: { category: 'search', label: 'Listed', summaryKey: 'pattern', outputKind: 'list', redactKeys: [] },
  Grep: { category: 'search', label: 'Searched', summaryKey: 'pattern', outputKind: 'text', redactKeys: [] },
  WebFetch: { category: 'network', label: 'Fetched', summaryKey: 'url', outputKind: 'markdown', redactKeys: [] },
  WebSearch: { category: 'network', label: 'Searched', summaryKey: 'query', outputKind: 'text', redactKeys: [] },
  AskUserQuestion: { category: 'question', label: 'Asked', summaryKey: 'questions', outputKind: 'text', redactKeys: [] },
  ExitPlanMode: { category: 'question', label: 'Asked', summaryKey: null, outputKind: 'markdown', redactKeys: [] },
  Agent: { category: 'sub-agent', label: 'Sub-agent', summaryKey: 'description', outputKind: 'markdown', redactKeys: [] },
  Task: { category: 'sub-agent', label: 'Sub-agent', summaryKey: 'description', outputKind: 'markdown', redactKeys: [] },
  TodoWrite: { category: 'list', label: 'Planned', summaryKey: 'todos', outputKind: 'text', redactKeys: [] },
  ListMcpResourcesTool: { category: 'plug', label: 'Listed', summaryKey: 'server', outputKind: 'json', redactKeys: [] },
  ReadMcpResourceTool: { category: 'plug', label: 'Read', summaryKey: 'uri', outputKind: 'text', redactKeys: [] },
  Skill: { category: 'other', label: 'Loaded', summaryKey: 'skill', outputKind: 'markdown', redactKeys: [] },
}

const NO_HINTS: ToolHintTable = {}

/**
 * The hint table for the harness that produced an event. Events recorded
 * before the seam named its harness came from OpenCode, the default driver.
 * A harness with no table here (a future pi driver, say) gets none, so every
 * tool falls back to its own name and first string argument.
 */
export function toolHintsFor(harness: string | undefined): ToolHintTable {
  if (harness === undefined || harness === OPENCODE) return OPENCODE_TOOL_HINTS
  if (harness === CLAUDE_AGENT_SDK) return CLAUDE_TOOL_HINTS
  return NO_HINTS
}
