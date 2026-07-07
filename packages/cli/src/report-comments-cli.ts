interface ReportCommentPerson {
  name: string
  initials?: string
  color?: string
}

interface ReportCommentAuthor {
  kind?: 'human'
  person?: ReportCommentPerson
  name?: string
  initials?: string
  color?: string
  via?: string
  actor?: 'agent'
  onBehalfOf?: string
}

interface ReportCommentAnchor {
  text: string | null
  startLine: number | null
  endLine: number | null
}

interface ReportCommentReply {
  id: string
  body: string
  author: ReportCommentAuthor
  createdAt: string
  updatedAt: string
  editedAt?: string | null
}

interface ReportCommentThread {
  id: string
  status: 'open' | 'resolved'
  body: string
  anchor: ReportCommentAnchor | null
  author: ReportCommentAuthor
  createdAt: string
  updatedAt: string
  editedAt?: string | null
  createdByUserId?: string | null
  resolvedAt: string | null
  resolvedByUserId: string | null
  replyCount: number
  replies: ReportCommentReply[]
}

interface ReportCommentMutationPayload {
  comment: ReportCommentThread | ReportCommentReply
}

interface ReportCommentsPayload {
  subject?: {
    type: 'prompt_version' | 'optimization_run_report' | 'task_report'
    id: string
    projectId: string
  }
  project?: {
    id: string
    name: string
    slug: string
    teamName: string | null
    teamSlug: string | null
  } | null
  prompt?: {
    id: string
    name: string
    role: string
    description?: string | null
  }
  version?: {
    id: string
    versionNumber?: number
    versionLabel?: string | null
    status?: string | null
  }
  run?: {
    id: string
  }
  task?: {
    id: string
    title?: string | null
  }
  summary: {
    threadCount: number
    openThreadCount: number
    resolvedThreadCount: number
    replyCount: number
  }
  comments: ReportCommentThread[]
}

export interface ReportCommentsCliContext {
  getArg: (name: string) => string | null
  getPositionalArg: (index: number) => string | null
  rejectDashPrefixedOptionValue: (name: string, value: string | null) => void
  resolveProjectSlug: (preferredProject: string | null) => Promise<string>
  readSourceFile: (pathArg: string) => string
  authedFetch: (path: string, init?: RequestInit) => Promise<Response>
  parseJsonResponse: <T>(response: Response, context: string) => Promise<T>
  hasJsonFlag: () => boolean
  printJson: (value: Record<string, unknown>) => void
  printLine: (message?: string) => void
  sanitizeTerminalText: (value: unknown) => string
}

const COMMENTS_TARGET_USAGE =
  'Use exactly one of --prompt <id-or-name>, --run <run-id>, or --task <task-id>'

function reportCommentsUsage(action: string): string {
  const target =
    '(--prompt <id-or-name> --project <team/project> [--label <label> | --version <id>] | --run <run-id> | --task <task-id>)'
  if (action === 'list') {
    return `Usage: orizu comments list ${target} [--json]`
  }
  if (action === 'add') {
    return `Usage: orizu comments add ${target} --body <text|@file> [--anchor <text>] [--lines <start:end>] [--via <name>] [--json]`
  }
  if (action === 'reply') {
    return 'Usage: orizu comments reply <comment-id> --body <text|@file> [--via <name>] [--json]'
  }
  if (action === 'edit') {
    return 'Usage: orizu comments edit <comment-id> --body <text|@file> [--json]'
  }
  return `Usage: orizu comments ${action} <comment-id> [--json]`
}

function compactTerminalText(
  ctx: ReportCommentsCliContext,
  value: string,
  maxLength = 160
): string {
  const compact = ctx.sanitizeTerminalText(value).replace(/\s+/g, ' ').trim()
  if (compact.length <= maxLength) {
    return compact
  }

  return `${compact.slice(0, Math.max(0, maxLength - 1)).trim()}…`
}

async function readReportCommentError(
  ctx: ReportCommentsCliContext,
  response: Response
): Promise<string> {
  const status = response.status
    ? `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
    : 'request failed'
  const contentType = response.headers.get('content-type') || ''

  if (!contentType.toLowerCase().includes('application/json')) {
    return status
  }

  try {
    const parsed = await response.clone().json()
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const error = (parsed as { error?: unknown }).error
      if (typeof error === 'string' && error.trim()) {
        return compactTerminalText(ctx, error, 220)
      }
    }
  } catch {
    // Fall through to the status-only message for malformed JSON errors.
  }

  return status
}

function printIndentedBody(
  ctx: ReportCommentsCliContext,
  value: string,
  indent: string
) {
  const lines = ctx.sanitizeTerminalText(value || '').split(/\r?\n/)
  for (const line of lines) {
    ctx.printLine(`${indent}${line}`)
  }
}

function formatReportCommentAnchor(
  ctx: ReportCommentsCliContext,
  anchor: ReportCommentAnchor | null
): string | null {
  if (!anchor) {
    return null
  }

  const lineLabel = anchor.startLine && anchor.endLine
    ? anchor.startLine === anchor.endLine
      ? `line ${anchor.startLine}`
      : `lines ${anchor.startLine}-${anchor.endLine}`
    : null
  const selectedText = anchor.text ? `"${compactTerminalText(ctx, anchor.text, 180)}"` : null

  if (lineLabel && selectedText) {
    return `${lineLabel}: ${selectedText}`
  }
  return lineLabel || selectedText
}

function reportCommentAuthorName(author: ReportCommentAuthor | null | undefined): string {
  const personName = author?.person?.name
  const name = personName || author?.name || 'Unknown'
  const via = author?.via ? ` via ${author.via}` : ''
  const agent = author?.actor === 'agent'
    ? author.onBehalfOf
      ? ` (agent on behalf of ${author.onBehalfOf})`
      : ' (agent)'
    : ''
  return `${name}${via}${agent}`
}

function printReportCommentSubject(
  ctx: ReportCommentsCliContext,
  data: ReportCommentsPayload
) {
  if (data.prompt && data.version) {
    const versionLabel = data.version.versionLabel || (
      data.version.versionNumber ? `v${data.version.versionNumber}` : data.version.id
    )
    ctx.printLine(`Prompt: ${ctx.sanitizeTerminalText(data.prompt.name)} (${ctx.sanitizeTerminalText(data.prompt.id)})`)
    ctx.printLine(`Version: ${ctx.sanitizeTerminalText(String(versionLabel))} (${ctx.sanitizeTerminalText(data.version.id)})`)
    return
  }

  if (data.run) {
    ctx.printLine(`Optimization run: ${ctx.sanitizeTerminalText(data.run.id)}`)
    return
  }

  if (data.task) {
    const title = data.task.title ? `${ctx.sanitizeTerminalText(data.task.title)} ` : ''
    ctx.printLine(`Task: ${title}(${ctx.sanitizeTerminalText(data.task.id)})`)
    return
  }

  if (data.subject) {
    ctx.printLine(`Subject: ${ctx.sanitizeTerminalText(data.subject.type)} ${ctx.sanitizeTerminalText(data.subject.id)}`)
  }
}

function printReportComments(
  ctx: ReportCommentsCliContext,
  data: ReportCommentsPayload
) {
  printReportCommentSubject(ctx, data)
  ctx.printLine(
    `Comments: ${data.summary.threadCount} thread${data.summary.threadCount === 1 ? '' : 's'} ` +
    `(${data.summary.openThreadCount} open, ${data.summary.resolvedThreadCount} resolved, ${data.summary.replyCount} replies)`
  )

  if (data.comments.length === 0) {
    ctx.printLine('\nNo comments found for this report.')
    return
  }

  for (const [index, thread] of data.comments.entries()) {
    const authorName = reportCommentAuthorName(thread.author)
    const anchor = formatReportCommentAnchor(ctx, thread.anchor)
    ctx.printLine('')
    ctx.printLine(
      `${index + 1}. [${thread.status}] ${ctx.sanitizeTerminalText(thread.id)} · ` +
      `${ctx.sanitizeTerminalText(authorName)} · ${ctx.sanitizeTerminalText(thread.createdAt)}`
    )
    if (thread.editedAt) {
      ctx.printLine(`   Edited: ${ctx.sanitizeTerminalText(thread.editedAt)}`)
    }
    if (anchor) {
      ctx.printLine(`   Selection: ${anchor}`)
    }
    printIndentedBody(ctx, thread.body, '   ')

    if (thread.replies.length > 0) {
      ctx.printLine(`   Replies (${thread.replies.length})`)
      for (const reply of thread.replies) {
        const replyAuthor = reportCommentAuthorName(reply.author)
        ctx.printLine(
          `   - ${ctx.sanitizeTerminalText(reply.id)} · ` +
          `${ctx.sanitizeTerminalText(replyAuthor)} · ${ctx.sanitizeTerminalText(reply.createdAt)}`
        )
        if (reply.editedAt) {
          ctx.printLine(`     Edited: ${ctx.sanitizeTerminalText(reply.editedAt)}`)
        }
        printIndentedBody(ctx, reply.body, '     ')
      }
    }
  }
}

async function reportCommentsTargetParams(
  ctx: ReportCommentsCliContext,
  action: string
): Promise<URLSearchParams> {
  const promptRef = ctx.getArg('--prompt')
  const runId = ctx.getArg('--run') || ctx.getArg('--run-id')
  const taskId = ctx.getArg('--task')

  ctx.rejectDashPrefixedOptionValue('--prompt', promptRef)
  ctx.rejectDashPrefixedOptionValue('--run', runId)
  ctx.rejectDashPrefixedOptionValue('--task', taskId)

  const present = [
    promptRef ? 'prompt' : null,
    runId ? 'run' : null,
    taskId ? 'task' : null,
  ].filter(Boolean)

  if (present.length !== 1) {
    throw new Error(`${reportCommentsUsage(action)}\n${COMMENTS_TARGET_USAGE}`)
  }

  const params = new URLSearchParams()
  if (promptRef) {
    const project = ctx.getArg('--project') || await ctx.resolveProjectSlug(null)
    const label = ctx.getArg('--label')
    const version = ctx.getArg('--version')
    ctx.rejectDashPrefixedOptionValue('--project', project)
    ctx.rejectDashPrefixedOptionValue('--label', label)
    ctx.rejectDashPrefixedOptionValue('--version', version)
    if (label && version) {
      throw new Error('Use either --label or --version, not both')
    }
    params.set('prompt', promptRef)
    params.set('project', project)
    if (label) params.set('label', label)
    if (version) params.set('version', version)
    return params
  }

  if (runId) {
    params.set('run', runId)
    return params
  }

  params.set('task', taskId as string)
  return params
}

function readReportCommentBodyInput(ctx: ReportCommentsCliContext, action: string): string {
  const body = ctx.getArg('--body')
  ctx.rejectDashPrefixedOptionValue('--body', body)
  if (!body) {
    throw new Error(reportCommentsUsage(action))
  }
  if (body === '@') {
    throw new Error('Usage: --body <text|@file>')
  }

  const value = body.startsWith('@') ? ctx.readSourceFile(body.slice(1)) : body
  if (!value.trim()) {
    throw new Error('Comment body must not be blank')
  }
  return value
}

function readReportCommentAnchorInput(ctx: ReportCommentsCliContext): ReportCommentAnchor | null {
  const anchor = ctx.getArg('--anchor')
  const lines = ctx.getArg('--lines')
  ctx.rejectDashPrefixedOptionValue('--anchor', anchor)
  ctx.rejectDashPrefixedOptionValue('--lines', lines)

  let startLine: number | null = null
  let endLine: number | null = null
  if (lines) {
    const match = lines.match(/^(\d+):(\d+)$/)
    if (!match) {
      throw new Error('--lines must use format <start:end>')
    }
    startLine = Number(match[1])
    endLine = Number(match[2])
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
      throw new Error('--lines must contain positive integers where end is greater than or equal to start')
    }
  }

  if (!anchor && startLine === null) {
    return null
  }

  return {
    text: anchor ? anchor.trim() : null,
    startLine,
    endLine,
  }
}

function readReportCommentViaInput(ctx: ReportCommentsCliContext): string | undefined {
  const via = ctx.getArg('--via')
  ctx.rejectDashPrefixedOptionValue('--via', via)
  return via?.trim() || undefined
}

async function listReportComments(ctx: ReportCommentsCliContext) {
  const params = await reportCommentsTargetParams(ctx, 'list')
  const response = await ctx.authedFetch(`/api/cli/report-comments?${params.toString()}`)
  if (!response.ok) {
    throw new Error(`Failed to fetch report comments: ${await readReportCommentError(ctx, response)}`)
  }

  const data = await ctx.parseJsonResponse<ReportCommentsPayload>(response, 'Report comments')
  if (ctx.hasJsonFlag()) {
    ctx.printJson(data as unknown as Record<string, unknown>)
    return
  }

  printReportComments(ctx, data)
}

async function addReportComment(ctx: ReportCommentsCliContext) {
  const params = await reportCommentsTargetParams(ctx, 'add')
  const body = readReportCommentBodyInput(ctx, 'add')
  const response = await ctx.authedFetch(`/api/cli/report-comments?${params.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      body,
      via: readReportCommentViaInput(ctx),
      anchor: readReportCommentAnchorInput(ctx),
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to add report comment: ${await readReportCommentError(ctx, response)}`)
  }

  const data = await ctx.parseJsonResponse<ReportCommentMutationPayload>(response, 'Report comment add')
  if (ctx.hasJsonFlag()) {
    ctx.printJson(data as unknown as Record<string, unknown>)
    return
  }
  ctx.printLine(`Added comment ${ctx.sanitizeTerminalText(data.comment.id)}`)
}

async function replyReportComment(ctx: ReportCommentsCliContext) {
  const commentId = ctx.getPositionalArg(2)
  if (!commentId) {
    throw new Error(reportCommentsUsage('reply'))
  }

  const response = await ctx.authedFetch(`/api/cli/report-comments/${encodeURIComponent(commentId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      body: readReportCommentBodyInput(ctx, 'reply'),
      via: readReportCommentViaInput(ctx),
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to reply to report comment: ${await readReportCommentError(ctx, response)}`)
  }

  const data = await ctx.parseJsonResponse<ReportCommentMutationPayload>(response, 'Report comment reply')
  if (ctx.hasJsonFlag()) {
    ctx.printJson(data as unknown as Record<string, unknown>)
    return
  }
  ctx.printLine(`Added reply ${ctx.sanitizeTerminalText(data.comment.id)} to ${ctx.sanitizeTerminalText(commentId)}`)
}

async function updateReportComment(
  ctx: ReportCommentsCliContext,
  action: 'resolve' | 'unresolve' | 'edit'
) {
  const commentId = ctx.getPositionalArg(2)
  if (!commentId) {
    throw new Error(reportCommentsUsage(action))
  }

  const payload = action === 'edit'
    ? { body: readReportCommentBodyInput(ctx, 'edit') }
    : { resolved: action === 'resolve' }

  const response = await ctx.authedFetch(`/api/cli/report-comments/${encodeURIComponent(commentId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    throw new Error(`Failed to ${action} report comment: ${await readReportCommentError(ctx, response)}`)
  }

  const data = await ctx.parseJsonResponse<ReportCommentMutationPayload>(response, `Report comment ${action}`)
  if (ctx.hasJsonFlag()) {
    ctx.printJson(data as unknown as Record<string, unknown>)
    return
  }

  const verb = action === 'unresolve' ? 'Reopened' : action === 'edit' ? 'Edited' : 'Resolved'
  ctx.printLine(`${verb} comment ${ctx.sanitizeTerminalText(data.comment.id)}`)
}

export async function reportCommentsCommand(
  action: string | undefined,
  ctx: ReportCommentsCliContext
) {
  if (action === 'list') {
    await listReportComments(ctx)
    return
  }
  if (action === 'add') {
    await addReportComment(ctx)
    return
  }
  if (action === 'reply') {
    await replyReportComment(ctx)
    return
  }
  if (action === 'resolve' || action === 'unresolve' || action === 'edit') {
    await updateReportComment(ctx, action)
    return
  }
  throw new Error(
    'Usage: orizu comments <list|add|reply|resolve|unresolve|edit> ...'
  )
}

export function throwDeprecatedPromptCommentsCommand(): never {
  throw new Error(
    'orizu prompts comments has moved. Use `orizu comments list --prompt <prompt-id-or-name> --project <team/project> [--label <label> | --version <id>]`.'
  )
}
