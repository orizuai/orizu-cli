import { randomUUID } from 'node:crypto'

import type { HarnessEvent } from './hosted-harness.js'
import { HOSTED_QUESTION_LIMITS } from './hosted-question-limits.js'
import { redactSecrets } from './secret-redaction.js'

export { HOSTED_QUESTION_LIMITS } from './hosted-question-limits.js'
const QUESTION_MAX = HOSTED_QUESTION_LIMITS.questionMax
const OPTION_LABEL_MAX = HOSTED_QUESTION_LIMITS.optionLabelMax
const OPTION_DESCRIPTION_MAX = HOSTED_QUESTION_LIMITS.optionDescriptionMax
const OPTION_COUNT_MAX = HOSTED_QUESTION_LIMITS.optionCountMax
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ARTIFACTS_LOCATOR = /https:\/\/[0-9a-f]{32}\.artifacts\.cloudflare\.net\/git\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.git/g

export interface HostedPendingQuestionOption {
  label: string
  description: string | null
}

export interface HostedPendingQuestion {
  questionId: string
  question: string
  options: HostedPendingQuestionOption[]
}

export const INVALID_HOSTED_QUESTION_REASON = 'expected_exactly_one_bounded_question'

export class InvalidHostedQuestionError extends Error {
  readonly reason = INVALID_HOSTED_QUESTION_REASON

  constructor() {
    super(`invalid_agent_question: ${INVALID_HOSTED_QUESTION_REASON}`)
    this.name = 'InvalidHostedQuestionError'
  }
}

function bounded(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null
  return redactSecrets(value.replace(ARTIFACTS_LOCATOR, '[redacted locator]')).slice(0, max)
}

function parseOption(value: unknown): HostedPendingQuestionOption | null {
  if (typeof value === 'string') {
    const label = bounded(value, OPTION_LABEL_MAX)
    return label ? { label, description: null } : null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const option = value as Record<string, unknown>
  const label = bounded(option.label, OPTION_LABEL_MAX)
  if (!label) return null
  return {
    label,
    description: bounded(option.description, OPTION_DESCRIPTION_MAX),
  }
}

export function parseHostedQuestion(
  args: unknown,
  createQuestionId: () => string = randomUUID
): HostedPendingQuestion {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new InvalidHostedQuestionError()
  const record = args as Record<string, unknown>
  const questions = Array.isArray(record.questions) ? record.questions : []
  if (questions.length !== 1 || !questions[0] || typeof questions[0] !== 'object' || Array.isArray(questions[0])) {
    throw new InvalidHostedQuestionError()
  }
  const input = questions[0] as Record<string, unknown>
  const question = bounded(input.question, QUESTION_MAX)
  const questionId = createQuestionId()
  if (!question || !UUID_V4.test(questionId)) throw new InvalidHostedQuestionError()
  const rawOptions = Array.isArray(input.options) ? input.options : []
  if (rawOptions.length > OPTION_COUNT_MAX) throw new InvalidHostedQuestionError()
  const options = rawOptions.map(parseOption)
  if (options.some(option => option === null)) throw new InvalidHostedQuestionError()
  return { questionId, question, options: options as HostedPendingQuestionOption[] }
}

export interface InterceptHostedQuestionOptions {
  createQuestionId?: () => string
  onDetected(question: HostedPendingQuestion): void
  onPersisted(question: HostedPendingQuestion): Promise<void>
  onInvalid?(reason: string): void
  onInvalidPersisted?(reason: string): Promise<void>
}

export async function* interceptHostedQuestions(
  source: AsyncIterable<HarnessEvent>,
  options: InterceptHostedQuestionOptions
): AsyncGenerator<HarnessEvent> {
  let hasQuestionOutcome = false
  for await (const event of source) {
    if (hasQuestionOutcome) {
      if (event.kind === 'execution_complete' || event.kind === 'error') yield event
      continue
    }
    yield event
    if (event.kind !== 'tool_call' && event.kind !== 'tool_result') continue
    if (event.payload.tool !== 'question') continue
    let pending: HostedPendingQuestion
    try {
      pending = parseHostedQuestion(event.payload.args, options.createQuestionId)
    } catch (error) {
      if (!(error instanceof InvalidHostedQuestionError)) throw error
      hasQuestionOutcome = true
      options.onInvalid?.(error.reason)
      yield {
        kind: 'question_invalid',
        messageId: event.messageId,
        critical: true,
        payload: { reason: error.reason },
      }
      await options.onInvalidPersisted?.(error.reason)
      continue
    }
    hasQuestionOutcome = true
    options.onDetected(pending)
    yield {
      kind: 'question_pending',
      messageId: event.messageId,
      critical: true,
      payload: {
        questionId: pending.questionId,
        question: pending.question,
        options: pending.options,
      },
    }
    await options.onPersisted(pending)
  }
}

export function composeHostedAnswerPrompt(
  question: Pick<HostedPendingQuestion, 'questionId' | 'question'>,
  answerText: string
): string {
  return [
    `Answer to your pending question (${question.questionId}):`,
    question.question,
    '',
    '--- HUMAN ANSWER (VERBATIM) ---',
    answerText,
    '--- END HUMAN ANSWER ---',
    '',
    'Continue the same task and conversation using this answer.',
  ].join('\n')
}
