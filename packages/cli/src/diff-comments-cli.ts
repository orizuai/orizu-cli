import {
  extractErrorMessage,
  isJsonErrorResponsePayload,
} from './error-response.js'
import { sanitizeHumanInlineText } from './json-response.js'
import {
  formatFiniteLengthCount,
  type CliLengthDelta,
  type CliLengthMeasurementUnavailableReason,
  type CliLengthStats,
  type CliLengthStatsPair,
} from './prompt-length-wire.js'

interface DiffCommentAuthor {
  name?: string
  person?: { name?: string }
}

type DiffCommentContextUnavailableReason =
  | 'diff_degraded_size_limit'
  | 'diff_degraded_cell_limit'
  | 'bodies_unavailable_event_cap'
  | 'body_unresolvable'
  | 'anchor_out_of_range'
  | 'pair_budget_exceeded'

interface DiffCommentContextLine {
  op: 'add' | 'del' | 'context'
  oldLine: number | null
  newLine: number | null
  text: string
}

interface DiffCommentPayloadComment {
  id: string
  body: string
  author: DiffCommentAuthor
  createdAt: string
  anchor: { side: 'old' | 'new'; line: number }
  context: {
    lineText: string
    lineOp: 'add' | 'del' | 'context' | null
    hunk: { lines: DiffCommentContextLine[] } | null
  } | null
  contextUnavailableReason?: DiffCommentContextUnavailableReason
}

interface DiffCommentPayloadPairContext {
  diff: string | null
  bodies: { from: string; to: string } | null
  degraded: { reason: DiffCommentContextUnavailableReason } | null
  lengthStats: CliLengthStatsPair | null
  lengthDelta: (
    Partial<Record<keyof Omit<CliLengthDelta, 'splitUnavailableReason'>, unknown>> & {
      splitUnavailableReason?: unknown
    }
  ) | null
  lengthDeltaUnavailableReason?: CliLengthMeasurementUnavailableReason
  comments: DiffCommentPayloadComment[]
}

type DiffCommentPayloadPair = DiffCommentPayloadPairContext & (
  | {
    from: { candidateId: string }
    to: { candidateId: string }
  }
  | {
    from: { version: number }
    to: { version: number }
  }
)

interface DiffCommentsPayload {
  target: {
    type: 'optimization_run' | 'prompt'
    id: string
    projectId: string
  }
  detail: 'hunk' | 'diff' | 'full'
  pairs: DiffCommentPayloadPair[]
}

interface RenderableLengthMetricDelta {
  removed: number | null
  added: number | null
  net: number | null
}

export interface DiffCommentsCliContext {
  getArg: (name: string) => string | null
  rejectDashPrefixedOptionValue: (name: string, value: string | null) => void
  authedFetch: (path: string, init?: RequestInit) => Promise<Response>
  parseJsonResponse: <T>(response: Response, context: string) => Promise<T>
  hasJsonFlag: () => boolean
  printJson: (value: Record<string, unknown>) => void
  printLine: (message?: string) => void
  sanitizeTerminalText: (value: unknown) => string
}

const DETAIL_LEVELS = ['hunk', 'diff', 'full'] as const
const CONTEXT_UNAVAILABLE_WITHOUT_REASON = '    Context unavailable (no reason supplied)'

function isCandidatePair(
  pair: DiffCommentPayloadPair
): pair is DiffCommentPayloadPairContext & {
  from: { candidateId: string }
  to: { candidateId: string }
} {
  return 'candidateId' in pair.from
}

function usage(): string {
  return 'Usage: orizu comments diff (--run <run-id> | --prompt <prompt-id>) [--from <revision> --to <revision>] [--detail hunk|diff|full] [--json]'
}

function sanitizeHumanText(
  ctx: DiffCommentsCliContext,
  value: unknown
): string {
  return ctx.sanitizeTerminalText(value).replaceAll('\r', '')
}

// Quote untrusted multiline blocks so none of their rows can impersonate a
// genuine hunk row, whose marker begins immediately after the four-space indent.
function printHumanTextBlock(ctx: DiffCommentsCliContext, value: unknown): void {
  for (const line of sanitizeHumanText(ctx, value).split('\n')) {
    ctx.printLine(`    │ ${line}`)
  }
}

function hasExplicitlyEmptyJsonError(response: Response, rawBody: string): boolean {
  try {
    const payload: unknown = JSON.parse(rawBody)
    return isJsonErrorResponsePayload(response, payload) && payload.error.length === 0
  } catch {
    return false
  }
}

async function extractDiffCommentsErrorMessage(response: Response): Promise<string> {
  const statusFallback = `HTTP ${response.status}`

  try {
    const rawBody = await response.text()
    if (hasExplicitlyEmptyJsonError(response, rawBody)) {
      return statusFallback
    }

    const copiedResponse = new Response(rawBody, { headers: response.headers })
    const extractedMessage = await extractErrorMessage(copiedResponse)
    return extractedMessage.trim() ? extractedMessage : statusFallback
  } catch {
    return statusFallback
  }
}

function humanLineNumber(
  ctx: DiffCommentsCliContext,
  line: number | null
): string {
  return line === null
    ? '-'
    : sanitizeHumanInlineText(ctx.sanitizeTerminalText, String(line + 1))
}

function formatStats(stats: CliLengthStats): string {
  const tokens = formatFiniteLengthCount(stats.tokens)
  return `${tokens === null ? '—' : `~${tokens}`} tokens · ` +
    `${formatFiniteLengthCount(stats.lines) ?? '—'} lines · ` +
    `${formatFiniteLengthCount(stats.chars) ?? '—'} chars · ` +
    `${formatFiniteLengthCount(stats.words) ?? '—'} words`
}

function formatDeltaValue(
  value: number | null,
  metric: keyof Omit<CliLengthDelta, 'splitUnavailableReason'>,
  signed = false
): string {
  const formatted = formatFiniteLengthCount(value, signed)
  if (formatted === null) return '—'
  return metric === 'tokens' ? `~${formatted}` : formatted
}

function isLengthMetricDelta(
  value: unknown
): value is RenderableLengthMetricDelta {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const delta = value as Record<string, unknown>
  const isNullableFiniteNumber = (candidate: unknown) =>
    candidate === null || (
      typeof candidate === 'number' && Number.isFinite(candidate)
    )
  return isNullableFiniteNumber(delta.removed) &&
    isNullableFiniteNumber(delta.added) &&
    isNullableFiniteNumber(delta.net)
}

function printLengthMeasurements(
  ctx: DiffCommentsCliContext,
  pair: DiffCommentPayloadPair
) {
  function unavailableSuffix(reason: unknown): string {
    if (typeof reason !== 'string' || reason.length === 0) return ''
    return ` (${sanitizeHumanInlineText(ctx.sanitizeTerminalText, reason)})`
  }

  if (!pair.lengthStats && !pair.lengthDelta) {
    ctx.printLine(
      `  Length: unavailable${unavailableSuffix(
        pair.lengthDeltaUnavailableReason ?? pair.degraded?.reason
      )}`
    )
    return
  }

  if (pair.lengthStats) {
    ctx.printLine(pair.lengthStats.from
      ? `  From: ${formatStats(pair.lengthStats.from)}`
      : `  From: unavailable${unavailableSuffix(
        pair.lengthStats.fromUnavailableReason
      )}`)
    ctx.printLine(pair.lengthStats.to
      ? `  To: ${formatStats(pair.lengthStats.to)}`
      : `  To: unavailable${unavailableSuffix(
        pair.lengthStats.toUnavailableReason
      )}`)
  }
  if (!pair.lengthDelta) {
    ctx.printLine(
      `  Length delta: unavailable${unavailableSuffix(
        pair.lengthDeltaUnavailableReason ?? pair.degraded?.reason
      )}`
    )
    return
  }

  const splitUnavailableReason = pair.lengthDelta.splitUnavailableReason
  if (
    typeof splitUnavailableReason === 'string' &&
    splitUnavailableReason.length > 0
  ) {
    ctx.printLine(
      `  Split unavailable: ${sanitizeHumanInlineText(
        ctx.sanitizeTerminalText,
        splitUnavailableReason
      )}`
    )
  }
  for (const [metric, label] of [
    ['tokens', 'Tokens'],
    ['lines', 'Lines'],
    ['chars', 'Chars'],
    ['words', 'Words'],
  ] as const) {
    const delta = pair.lengthDelta[metric]
    if (!isLengthMetricDelta(delta)) {
      ctx.printLine(`  ${label}: unavailable`)
      continue
    }
    ctx.printLine(
      `  ${label}: removed ${formatDeltaValue(delta.removed, metric)} · ` +
      `added ${formatDeltaValue(delta.added, metric)} · ` +
      `net ${formatDeltaValue(delta.net, metric, true)}`
    )
  }
}

function buildParams(ctx: DiffCommentsCliContext): URLSearchParams {
  const runId = ctx.getArg('--run')
  const promptId = ctx.getArg('--prompt')
  const from = ctx.getArg('--from')
  const to = ctx.getArg('--to')
  const detail = ctx.getArg('--detail') ?? 'diff'

  for (const [name, value] of [
    ['--run', runId],
    ['--prompt', promptId],
    ['--from', from],
    ['--to', to],
    ['--detail', detail],
  ] as const) {
    ctx.rejectDashPrefixedOptionValue(name, value)
  }

  if (runId === '' || promptId === '') {
    throw new Error(usage())
  }
  if (Number(Boolean(runId)) + Number(Boolean(promptId)) !== 1) {
    throw new Error(usage())
  }
  if (from === '' || to === '') {
    throw new Error('--from and --to must not be empty')
  }
  if (Boolean(from) !== Boolean(to)) {
    throw new Error('--from and --to must be provided together')
  }
  if (!DETAIL_LEVELS.includes(detail as typeof DETAIL_LEVELS[number])) {
    throw new Error('--detail must be hunk, diff, or full')
  }
  if (promptId && from && to) {
    if (!Number.isInteger(Number(from)) || !Number.isInteger(Number(to))) {
      throw new Error('--from and --to must be integer prompt versions')
    }
  }

  const params = new URLSearchParams()
  params.set(runId ? 'run' : 'prompt', (runId ?? promptId) as string)
  if (from && to) {
    params.set('from', from)
    params.set('to', to)
  }
  params.set('detail', detail)
  return params
}

function printDiffComments(ctx: DiffCommentsCliContext, payload: DiffCommentsPayload) {
  ctx.printLine(`Diff comments: ${payload.pairs.length} pair${payload.pairs.length === 1 ? '' : 's'}`)

  if (payload.pairs.length === 0) {
    ctx.printLine('')
    ctx.printLine('No diff comments found.')
    return
  }

  for (const pair of payload.pairs) {
    const hasCandidateIds = isCandidatePair(pair)
    const from = hasCandidateIds ? pair.from.candidateId : String(pair.from.version)
    const to = hasCandidateIds ? pair.to.candidateId : String(pair.to.version)
    ctx.printLine('')
    ctx.printLine(
      `${hasCandidateIds ? 'Candidates' : 'Versions'} ` +
      `${sanitizeHumanInlineText(ctx.sanitizeTerminalText, from)} → ` +
      `${sanitizeHumanInlineText(ctx.sanitizeTerminalText, to)}`
    )
    printLengthMeasurements(ctx, pair)
    if (pair.degraded) {
      ctx.printLine(
        `  Context unavailable: ${sanitizeHumanInlineText(ctx.sanitizeTerminalText, pair.degraded.reason)}`
      )
    }
    if (pair.diff !== null) {
      ctx.printLine('  Diff:')
      printHumanTextBlock(ctx, pair.diff)
    }
    if (pair.bodies !== null) {
      for (const [label, body] of [
        ['From body', pair.bodies.from],
        ['To body', pair.bodies.to],
      ] as const) {
        ctx.printLine(`  ${label}:`)
        printHumanTextBlock(ctx, body)
      }
    }

    for (const comment of pair.comments) {
      const authorName = comment.author?.person?.name || comment.author?.name || 'Unknown'
      ctx.printLine(
        `  ${sanitizeHumanInlineText(ctx.sanitizeTerminalText, comment.id)} · ` +
        `${sanitizeHumanInlineText(ctx.sanitizeTerminalText, authorName)} · ` +
        `${sanitizeHumanInlineText(ctx.sanitizeTerminalText, comment.createdAt)} · ` +
        `${sanitizeHumanInlineText(ctx.sanitizeTerminalText, comment.anchor.side)} line ` +
        `${sanitizeHumanInlineText(ctx.sanitizeTerminalText, String(comment.anchor.line + 1))}`
      )
      printHumanTextBlock(ctx, comment.body)

      if (comment.contextUnavailableReason) {
        ctx.printLine(
          `    Context unavailable: ${sanitizeHumanInlineText(ctx.sanitizeTerminalText, comment.contextUnavailableReason)}`
        )
        if (comment.context) {
          ctx.printLine(
            `    Anchored line: ${sanitizeHumanInlineText(ctx.sanitizeTerminalText, comment.context.lineText)}`
          )
        }
        continue
      }
      if (!comment.context) {
        ctx.printLine(CONTEXT_UNAVAILABLE_WITHOUT_REASON)
        continue
      }
      if (!comment.context.hunk) {
        ctx.printLine(CONTEXT_UNAVAILABLE_WITHOUT_REASON)
        ctx.printLine(
          `    Anchored line: ${sanitizeHumanInlineText(ctx.sanitizeTerminalText, comment.context.lineText)}`
        )
        continue
      }

      for (const line of comment.context.hunk.lines) {
        const prefix = line.op === 'add' ? '+' : line.op === 'del' ? '-' : ' '
        const isAnchored = comment.anchor.side === 'old'
          ? line.oldLine === comment.anchor.line
          : line.newLine === comment.anchor.line
        const marker = isAnchored ? '>' : ' '
        ctx.printLine(
          `    ${marker} old:${humanLineNumber(ctx, line.oldLine)} ` +
          `new:${humanLineNumber(ctx, line.newLine)} | ` +
          `${prefix}${sanitizeHumanInlineText(ctx.sanitizeTerminalText, line.text)}`
        )
      }
    }
  }
}

export async function diffCommentsCommand(ctx: DiffCommentsCliContext) {
  const params = buildParams(ctx)
  const response = await ctx.authedFetch(`/api/cli/diff-comments?${params.toString()}`)
  if (!response.ok) {
    const message = await extractDiffCommentsErrorMessage(response)
    throw new Error(
      `Failed to fetch diff comments: ${sanitizeHumanInlineText(ctx.sanitizeTerminalText, message)}`
    )
  }

  const payload = await ctx.parseJsonResponse<DiffCommentsPayload>(response, 'Diff comments')
  if (ctx.hasJsonFlag()) {
    ctx.printJson(payload as unknown as Record<string, unknown>)
    return
  }

  printDiffComments(ctx, payload)
}
