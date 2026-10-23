import { randomUUID } from 'node:crypto'

import { Clock, Data, Effect, Result, Schema, SchemaIssue, Semaphore, type Scope } from 'effect'

import { authedFetch } from './http.js'
import { sanitizeTerminalText } from './json-response.js'
import { REDACTION_PLACEHOLDER, redactSecrets } from './secret-redaction.js'
import type { RemoteRunnerManifest } from './remote-runner-manifest.js'
import type { RunnerInstructionSet } from './runner-instruction-set-contract.js'

/** The most a reply body may hold, matching the packaged runner output cap. */
const RESULT_MAX_BYTES = 2 * 1024 * 1024
const PREVIEW_CHARS = 300

class RemoteRunnerUnreachable extends Data.TaggedError('RemoteRunnerUnreachable')<{ message: string }> {}
class RemoteRunnerAuthRefused extends Data.TaggedError('RemoteRunnerAuthRefused')<{ message: string }> {}
class RemoteRunnerModelConfigRefused extends Data.TaggedError('RemoteRunnerModelConfigRefused')<{ message: string }> {}
class RemoteRunnerBadReply extends Data.TaggedError('RemoteRunnerBadReply')<{ message: string }> {}
class RemoteRunnerTimedOut extends Data.TaggedError('RemoteRunnerTimedOut')<{ message: string }> {}
class RemoteRunnerTooLarge extends Data.TaggedError('RemoteRunnerTooLarge')<{ message: string }> {}
class RemoteRunnerVersionMismatch extends Data.TaggedError('RemoteRunnerVersionMismatch')<{ message: string }> {}
class RemoteRunnerPinnedComponentsUnsupported extends Data.TaggedError('RemoteRunnerPinnedComponentsUnsupported')<{ message: string }> {}
class RemoteRunnerRefusedBeforeCall extends Data.TaggedError('RemoteRunnerRefusedBeforeCall')<{ message: string }> {}
class RemoteRunnerTemporaryStatus extends Data.TaggedError('RemoteRunnerTemporaryStatus')<{ message: string }> {}

export type RemoteRunnerSetupError = RemoteRunnerRefusedBeforeCall
export type RemoteRunnerCallError = RemoteRunnerUnreachable | RemoteRunnerAuthRefused | RemoteRunnerModelConfigRefused
  | RemoteRunnerBadReply | RemoteRunnerTimedOut | RemoteRunnerTooLarge | RemoteRunnerVersionMismatch
  | RemoteRunnerPinnedComponentsUnsupported | RemoteRunnerRefusedBeforeCall

type AttemptError = RemoteRunnerCallError | RemoteRunnerTemporaryStatus

export interface RemoteRunnerCallInput extends Record<string, unknown> {
  row_id: string
  row: Record<string, unknown>
  prompt: {
    body?: string | null
    body_kind: string
    provider_settings?: Record<string, unknown>
  }
  instruction_set?: {
    name?: string
    shape: string[]
    components: Record<string, string>
    model_config: Record<string, unknown>
    model_config_settings_version_id?: string
    pinned_components?: Record<string, unknown>
  }
  prompt_version_id: string | null
  runner_version_id: string
  run_id: string | null
}

export interface RemoteRunnerSummary {
  name: string
  runner_version_id: string
  deployed_version: string | null
  live_data_rows: Array<{ row_id: string; live_data_inputs: string[] }>
}

export interface RemoteRunnerSession {
  call(input: RemoteRunnerCallInput): Effect.Effect<Record<string, unknown>, RemoteRunnerCallError>
  readonly summary: Effect.Effect<RemoteRunnerSummary>
}

export interface RemoteRunnerSessionOptions {
  manifest: RemoteRunnerManifest
  runnerVersionId: string
  environment: NodeJS.ProcessEnv
  announce: (line: string) => void
}

const DeployedVersion = Schema.String.check(Schema.isMaxLength(200), Schema.makeFilter(value => value.trim().length > 0 || 'must not be blank'))
const Count = Schema.optionalKey(Schema.NullOr(Schema.Finite))
// Only these fields are kept: any score the endpoint sends is dropped.
const RemoteResult = Schema.Struct({
  model_response: Schema.optionalKey(Schema.Unknown),
  raw_api_response: Schema.optionalKey(Schema.Unknown),
  token_in: Count,
  token_out: Count,
  latency_ms: Count,
  cost_usd: Count,
  error: Schema.optionalKey(Schema.NullOr(Schema.String)),
  deployed_version: DeployedVersion,
  live_data_inputs: Schema.optionalKey(Schema.Array(Schema.String)),
})
const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1()

/** Every form of the secret that can appear in text: as sent, and JSON-escaped. */
const secretForms = (secret: string) => [...new Set([secret, JSON.stringify(secret).slice(1, -1)])]
// Cleanup can join secret fragments separated by control characters. Scrub
// before and after it, and only shorten a preview after the whole text is safe.
const formsOf = (secret: string | readonly string[]) => typeof secret === 'string' ? secretForms(secret) : secret
const clean = (message: string, secret: string | readonly string[]) => redactSecrets(sanitizeTerminalText(redactSecrets(message, { secrets: formsOf(secret) })), { secrets: formsOf(secret) })
const preview = (text: string, secret: string | readonly string[]) => clean(text, secret).slice(0, PREVIEW_CHARS)
/**
 * Removes only the exact secret from every string and object key, however deep.
 * Unlike redactSecrets it leaves token-shaped text alone: it is the customer's output.
 */
function withoutSecret<T>(value: T, forms: readonly string[]): T {
  if (typeof value === 'string') return forms.reduce((text, form) => text.replaceAll(form, REDACTION_PLACEHOLDER), value) as T
  if (Array.isArray(value)) return value.map(item => withoutSecret(item, forms)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [withoutSecret(key, forms), withoutSecret(inner, forms)])) as T
  }
  return value
}

async function boundedText(response: Response): Promise<string | null> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > RESULT_MAX_BYTES) { await reader.cancel(); return null }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function refusalDetail(text: string): { code?: string; message?: string } {
  try {
    const error = (JSON.parse(text) as { error?: { code?: unknown; message?: unknown } })?.error
    return {
      ...(typeof error?.code === 'string' ? { code: error.code } : {}),
      ...(typeof error?.message === 'string' ? { message: error.message } : {}),
    }
  } catch {
    return {}
  }
}

interface RowCall {
  manifest: RemoteRunnerManifest
  secret: string
  rowId: string
  modelConfigIdentity: string | null
  body: string
  controllers: Set<AbortController>
  redactions: string[]
  callbackPath?: string
  onCallback?: (status: 'arrived' | 'not_used' | 'timed_out') => void
  onResponse?: (response: Response) => void
  onReply?: (parsed?: unknown) => void
}

const CallbackRegistration = Schema.Struct({ callback_url: Schema.String, expires_at: Schema.String })
const CallbackState = Schema.Struct({
  status: Schema.Literals(['pending', 'completed', 'expired']),
  expires_at: Schema.String,
  result: Schema.optionalKey(Schema.Unknown),
})

/** Register only once, inside the admitted logical call's deadline, before any endpoint attempt. */
function registerCallback(call: RowCall): Effect.Effect<void, RemoteRunnerCallError> {
  return Effect.scoped(Effect.gen(function* () {
    const controller = yield* Effect.acquireRelease(Effect.sync(() => {
      const controller = new AbortController()
      call.controllers.add(controller)
      return controller
    }), controller => Effect.sync(() => { controller.abort(); call.controllers.delete(controller) }))
    const body = JSON.parse(call.body) as { run_id: string; request_id: string }
    const path = `/api/cli/remote-runner/runs/${encodeURIComponent(body.run_id)}/requests/${encodeURIComponent(body.request_id)}`
    const registration = yield* Effect.tryPromise({
      try: async () => {
        const response = await authedFetch(path, {
          method: 'POST', redirect: 'manual', signal: controller.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ timeout_seconds: call.manifest.timeout_seconds }),
        })
        if (response.status !== 201) throw new Error('registration refused')
        const registration = Schema.decodeUnknownSync(CallbackRegistration)(JSON.parse(await boundedText(response) ?? 'null'))
        const url = new URL(registration.callback_url)
        if (!['https:', 'http:'].includes(url.protocol) || !url.searchParams.get('token')) throw new Error('invalid callback URL')
        return registration
      },
      catch: () => new RemoteRunnerBadReply({ message: 'Orizu could not register the remote runner callback; no endpoint request was sent' }),
    })
    const url = new URL(registration.callback_url)
    const token = url.searchParams.get('token')
    call.redactions.push(...secretForms(registration.callback_url), ...(token ? secretForms(token) : []))
    call.callbackPath = path
    call.body = JSON.stringify({ ...JSON.parse(call.body), callback_url: registration.callback_url })
  }))
}

/** After acceptance, retry only safe reads: never submit the endpoint request again. */
function waitForCallback(call: RowCall, signal: AbortSignal): Effect.Effect<string, RemoteRunnerCallError> {
  return Effect.gen(function* () {
    for (;;) {
      const readStartedAt = yield* Clock.monotonicTimeNanos
      // A slow read already spends the interval; do not add another blind wait.
      const waitForNextRead = Clock.monotonicTimeNanos.pipe(Effect.flatMap(now =>
        Effect.sleep(Math.max(0, 250 - Number(now - readStartedAt) / 1_000_000))))
      const response = yield* Effect.tryPromise({
        try: () => authedFetch(call.callbackPath!, { signal, redirect: 'manual' }),
        catch: () => new RemoteRunnerUnreachable({ message: 'Orizu could not be reached while waiting for the remote runner callback' }),
      }).pipe(Effect.catch(() => Effect.succeed(null)))
      if (!response || [502, 503, 504].includes(response.status)) {
        if (response) yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve())
        yield* waitForNextRead
        continue
      }
      if (!response.ok) return yield* new RemoteRunnerBadReply({ message: `Orizu could not read the remote runner callback (status ${response.status})` })
      const state = yield* Effect.tryPromise({
        try: async () => Schema.decodeUnknownSync(CallbackState)(JSON.parse(await boundedText(response) ?? 'null')),
        catch: () => new RemoteRunnerBadReply({ message: 'Orizu returned an invalid remote runner callback result' }),
      })
      if (state.status === 'completed') {
        call.onCallback?.('arrived')
        return JSON.stringify(state.result) ?? 'null'
      }
      if (state.status === 'expired') {
        call.onCallback?.('timed_out')
        return yield* new RemoteRunnerTimedOut({ message: clean(`Remote runner at ${call.manifest.url} timed out for row ${call.rowId} after ${call.manifest.timeout_seconds} s`, call.redactions) })
      }
      yield* waitForNextRead
    }
  })
}

/** One attempt; the logical call owns the deadline and retry count. */
function remoteRunnerAttempt(call: RowCall): Effect.Effect<typeof RemoteResult.Type, AttemptError> {
  const { manifest, rowId } = call
  const secret = call.redactions
  const where = `Remote runner at ${manifest.url}`
  return Effect.scoped(Effect.gen(function* () {
    const controller = yield* Effect.acquireRelease(Effect.sync(() => {
      const controller = new AbortController()
      call.controllers.add(controller)
      return controller
    }), controller => Effect.sync(() => {
      controller.abort()
      call.controllers.delete(controller)
    }))
    const response = yield* Effect.tryPromise({
      try: () => fetch(manifest.url, {
        method: 'POST',
        // Never follow a redirect: the secret goes only to the registered URL.
        redirect: 'manual',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${call.secret}` },
        body: call.body,
        signal: controller.signal,
      }),
      catch: error => {
        const cause = (error as { cause?: { code?: unknown } }).cause
        const reason = typeof cause?.code === 'string' ? cause.code : error instanceof Error ? error.message : String(error)
        return new RemoteRunnerUnreachable({ message: clean(`${where} could not be reached for row ${rowId}: ${reason}`, secret) })
      },
    })
    call.onResponse?.(response)
    if ([502, 503, 504].includes(response.status)) {
      return yield* new RemoteRunnerTemporaryStatus({ message: clean(`${where} failed row ${rowId} (status ${response.status})`, secret) })
    }
    // Classify before reading diagnostics: a broken 500 body must not become a retryable connection error.
    if (response.status === 202) yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve())
    else call.onCallback?.('not_used')
    const text = response.status === 202 ? yield* waitForCallback(call, controller.signal) : yield* Effect.tryPromise({
      try: () => boundedText(response),
      catch: () => response.ok
        ? new RemoteRunnerUnreachable({ message: clean(`${where} closed the connection before answering row ${rowId}`, secret) })
        : new RemoteRunnerBadReply({ message: clean(`${where} failed row ${rowId} (status ${response.status}); its diagnostic body was interrupted`, secret) }),
    })
    if (text === null) return yield* new RemoteRunnerTooLarge({ message: clean(`${where} answered row ${rowId} with more than ${RESULT_MAX_BYTES} bytes`, secret) })
    if (response.status >= 300 && response.status < 400) {
      return yield* new RemoteRunnerBadReply({ message: clean(`${where} answered row ${rowId} with a redirect (status ${response.status}); redirects are not followed, so the secret only goes to the registered URL. Register the final URL instead.`, secret) })
    }
    if (response.status === 401 || response.status === 403) {
      return yield* new RemoteRunnerAuthRefused({ message: clean(`${where} refused the secret from ${manifest.secret_env} (status ${response.status}) for row ${rowId}: ${preview(text, secret)}`, secret) })
    }
    if (!response.ok) {
      const refusal = refusalDetail(text)
      const detail = refusal.message === undefined ? preview(text, secret) : preview(refusal.message, secret)
      if (refusal.code === 'model_config_unsupported') {
        return yield* new RemoteRunnerModelConfigRefused({ message: clean(`${where} cannot serve model config ${call.modelConfigIdentity ?? '(none)'} (model_config_unsupported) for row ${rowId}: ${detail}`, secret) })
      }
      const what = refusal.code ? `refused row ${rowId} with ${refusal.code}` : `failed row ${rowId}`
      return yield* new RemoteRunnerBadReply({ message: clean(`${where} ${what} (status ${response.status}): ${detail}`, secret) })
    }
    call.onReply?.()
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch {
      return yield* new RemoteRunnerBadReply({ message: clean(`${where}: the result for row ${rowId} is not JSON: ${preview(text, secret)}`, secret) })
    }
    call.onReply?.(parsed)
    const decoded = Schema.decodeUnknownResult(RemoteResult)(parsed)
    if (Result.isFailure(decoded)) {
      const [issue] = formatIssue(decoded.failure.issue).issues
      const field = (issue?.path ?? []).map(String).join('.')
      const problem = !field ? 'is not a JSON object'
        : field === 'deployed_version' ? 'has no deployed_version: every result must name the version of the code that produced it'
          : `has an invalid ${field}: ${issue?.message}`
      return yield* new RemoteRunnerBadReply({ message: clean(`${where}: the result for row ${rowId} ${problem}`, secret) })
    }
    if (decoded.success.model_response == null && typeof decoded.success.error !== 'string') {
      return yield* new RemoteRunnerBadReply({ message: clean(`${where}: the result for row ${rowId} must contain a non-null model_response or a string error`, secret) })
    }
    return decoded.success
  }))
}

export interface RemoteRunnerCheckReport {
  reachable: boolean | null
  secret: 'accepted' | 'refused' | 'not_checked'
  result_shape: 'valid' | 'invalid' | 'not_checked'
  callback: 'arrived' | 'not_used' | 'timed_out' | 'not_checked'
  deployed_version: string | null
  passed: boolean
  message: string | null
}

interface RemoteRunnerCheckInput extends Record<string, unknown> {
  row: Record<string, unknown>
  candidate: {
    components: Record<string, string>
    model_config: { identity: string | null; settings_version_id: string | null; provider_settings?: Record<string, unknown> }
  }
}

/** A single contract check; response contents are never kept in the report. */
export function checkRemoteRunner(manifest: RemoteRunnerManifest, input?: RemoteRunnerCheckInput): Effect.Effect<RemoteRunnerCheckReport> {
  return Effect.gen(function* () {
    const secret = process.env[manifest.secret_env]
    const report: RemoteRunnerCheckReport = { reachable: null, secret: 'not_checked', result_shape: 'not_checked', callback: 'not_checked', deployed_version: null, passed: false, message: null }
    if (!secret) return { ...report, message: `${manifest.secret_env} is not set. Orizu never stores the secret.` }
    let versionWasRedacted = false
    let isWaitingForCallback = false
    const rowId = randomUUID()
    const sample = input ?? { row: { text: 'Reply OK' }, candidate: { components: { prompt: 'Reply OK.' }, model_config: { identity: 'openai/gpt-5.4-mini', settings_version_id: null, provider_settings: {} } } }
    const forms = secretForms(secret)
    const call: RowCall = {
      manifest, secret, redactions: forms, rowId,
      modelConfigIdentity: sample.candidate.model_config.identity,
      onCallback: status => { report.callback = status },
      body: JSON.stringify({ ...sample, run_id: randomUUID(), request_id: randomUUID(), row_id: rowId }),
      controllers: new Set<AbortController>(),
      onResponse: response => {
        isWaitingForCallback = response.status === 202
        report.reachable = true
        report.secret = response.ok ? 'accepted' : response.status === 401 || response.status === 403 ? 'refused' : 'not_checked'
      },
      onReply: parsed => {
        report.result_shape = 'invalid'
        if (parsed && typeof parsed === 'object' && 'deployed_version' in parsed) {
          const version = Schema.decodeUnknownResult(DeployedVersion)(parsed.deployed_version)
          if (Result.isSuccess(version)) {
            const cleanedVersion = clean(version.success, forms)
            versionWasRedacted = cleanedVersion !== version.success
            report.deployed_version = versionWasRedacted ? null : cleanedVersion
          }
        }
      },
    }
    const result = yield* Effect.result(registerCallback(call).pipe(
      Effect.flatMap(() => remoteRunnerAttempt(call)),
      Effect.timeoutOrElse({
        duration: manifest.timeout_seconds * 1000,
        orElse: () => Effect.fail(new RemoteRunnerTimedOut({ message: clean(`Remote runner at ${manifest.url} timed out for row ${rowId} after ${manifest.timeout_seconds} s`, forms) })),
      }),
    ))
    if (Result.isFailure(result)) {
      if (result.failure._tag === 'RemoteRunnerTimedOut' && isWaitingForCallback) report.callback = 'timed_out'
      if (result.failure._tag === 'RemoteRunnerTooLarge' && report.secret === 'accepted') report.result_shape = 'invalid'
      return { ...report, reachable: report.reachable ?? false, message: result.failure.message }
    }
    if (versionWasRedacted) return { ...report, result_shape: 'valid', message: 'The deployed version contains a secret or unsafe text; no passed check can be saved for a changed version.' }
    return { ...report, result_shape: 'valid', passed: true, message: null }
  })
}

/** A launch-scoped owner of credentials, concurrency, version pinning, and provenance. */
export function createRemoteRunnerSession(options: RemoteRunnerSessionOptions): Effect.Effect<RemoteRunnerSession, RemoteRunnerSetupError, Scope.Scope> {
  return Effect.gen(function* () {
    const { manifest } = options
    const secret = options.environment[manifest.secret_env]
    if (!secret) {
      return yield* new RemoteRunnerRefusedBeforeCall({ message: `${manifest.secret_env} is not set. The remote runner at ${manifest.url} needs its secret in that environment variable; Orizu never stores the secret.` })
    }
    const forms = secretForms(secret)
    options.announce(clean(`Calling remote runner at ${new URL(manifest.url).host} with the secret from ${manifest.secret_env}`, secret))
    const semaphore = yield* Semaphore.make(manifest.max_parallel)
    const controllers = new Set<AbortController>()
    const shutdown = new AbortController()
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      shutdown.abort()
      for (const controller of controllers) controller.abort()
      controllers.clear()
    }))
    const fallbackRunId = randomUUID()
    let firstVersion: string | undefined
    const liveData = new Map<string, Set<string>>()
    const stopped = Effect.callback<never>(resume => {
      const stop = () => resume(Effect.interrupt)
      if (shutdown.signal.aborted) stop()
      else shutdown.signal.addEventListener('abort', stop, { once: true })
      return Effect.sync(() => shutdown.signal.removeEventListener('abort', stop))
    })
    const session: RemoteRunnerSession = {
      call: input => Effect.suspend(() => {
        if (shutdown.signal.aborted) return Effect.interrupt
        const pinned = Object.keys(input.instruction_set?.pinned_components ?? {})
        if (pinned.length > 0) {
          return Effect.fail(new RemoteRunnerPinnedComponentsUnsupported({ message: clean(`remote_runner_pinned_components_unsupported: component ${pinned.join(', ')} lives only in git, and a remote runner is sent component text. Save ${pinned.length === 1 ? 'it' : 'them'} as text in the instruction set first.`, secret) }))
        }
        const instructionSet = input.instruction_set
        // Older unpinned contexts may omit settings; pinned or retained snapshots must be preserved.
        const providerSettings = instructionSet
          ? instructionSet.model_config.settings === undefined && !instructionSet.model_config_settings_version_id
            ? {}
            : instructionSet.model_config.settings
          : input.prompt.provider_settings ?? {}
        if (instructionSet && !Schema.is(Schema.JsonObject)(providerSettings)) {
          return Effect.fail(new RemoteRunnerRefusedBeforeCall({ message: 'The execution context has missing or invalid model config settings. Refusing before calling the remote runner; reload the context from a server that supplies the profile settings snapshot.' }))
        }
        const modelConfigIdentity = typeof instructionSet?.model_config.identity === 'string' ? instructionSet.model_config.identity : null
        // A profile's pinned model config wins over legacy component settings,
        // including the ordinary prompt companion sent by the Python runner.
        const prompt = { ...input.prompt }
        if (instructionSet) delete prompt.provider_settings
        // Serialize once per logical evaluation, not per attempt. Caller-owned companions never override these fields.
        const body = JSON.stringify({
          ...input,
          prompt,
          row_id: input.row_id,
          run_id: input.run_id ?? fallbackRunId,
          request_id: randomUUID(),
          candidate: {
            components: instructionSet ? instructionSet.components : { prompt: input.prompt.body ?? '' },
            model_config: {
              identity: modelConfigIdentity,
              settings_version_id: instructionSet?.model_config_settings_version_id ?? null,
              provider_settings: providerSettings,
            },
          },
        })
        const call: RowCall = { manifest, secret, redactions: forms, rowId: input.row_id, modelConfigIdentity, body, controllers }
        const attempt = (retriesLeft: number): Effect.Effect<typeof RemoteResult.Type, RemoteRunnerCallError> => Effect.suspend(() => {
          if (shutdown.signal.aborted) return Effect.interrupt
          return remoteRunnerAttempt(call).pipe(Effect.catch(error => {
            if (error._tag === 'RemoteRunnerUnreachable' || error._tag === 'RemoteRunnerTemporaryStatus') {
              if (retriesLeft > 0) return Effect.sleep(100).pipe(Effect.flatMap(() => attempt(retriesLeft - 1)))
              if (error._tag === 'RemoteRunnerTemporaryStatus') return Effect.fail(new RemoteRunnerBadReply({ message: error.message }))
            }
            return Effect.fail(error as RemoteRunnerCallError)
          }))
        })
        const logicalCall = Effect.gen(function* () {
          // A queued call receives its complete timeout only after admission.
          if (shutdown.signal.aborted) return yield* Effect.interrupt
          const result = yield* registerCallback(call).pipe(Effect.flatMap(() => attempt(2)), Effect.timeoutOrElse({
            duration: manifest.timeout_seconds * 1000,
            orElse: () => Effect.fail(new RemoteRunnerTimedOut({ message: clean(`Remote runner at ${manifest.url} timed out for row ${input.row_id} after ${manifest.timeout_seconds} s`, secret) })),
          }))
          // Compare raw versions atomically, before cleanup could collapse different versions.
          const version = result.deployed_version
          firstVersion ??= version
          if (version !== firstVersion) {
            return yield* new RemoteRunnerVersionMismatch({ message: clean(`Remote runner at ${manifest.url} reported version ${version} for row ${input.row_id}, but this run started on ${firstVersion}. One run never mixes deployed versions; run again once the deploy has settled.`, forms) })
          }
          const inputs = result.live_data_inputs?.filter(value => value.length > 0) ?? []
          if (inputs.length > 0) {
            const accumulated = liveData.get(input.row_id) ?? new Set<string>()
            for (const value of inputs) accumulated.add(value)
            liveData.set(input.row_id, accumulated)
          }
          return withoutSecret(result, forms) as Record<string, unknown>
        })
        return Effect.raceFirst(semaphore.withPermit(logicalCall), stopped)
      }),
      summary: Effect.sync(() => withoutSecret({
        name: manifest.name,
        runner_version_id: options.runnerVersionId,
        deployed_version: firstVersion ?? null,
        live_data_rows: [...liveData].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([row_id, inputs]) => ({ row_id, live_data_inputs: [...inputs].sort() })),
      }, forms)),
    }
    return session
  })
}

export interface RemoteExecInput {
  manifest: RemoteRunnerManifest
  scorerVersion: string | null
  runnerVersionId: string
  rows: Array<{ id: string; row: Record<string, unknown> }>
  prompt: { body?: string | null; providerSettings: Record<string, unknown> }
  instructionSet?: RunnerInstructionSet
  environment: NodeJS.ProcessEnv
  /** Where to say, once, which host gets which secret. */
  announce: (line: string) => void
  /** The ordinary packaged runner input for a row (carried unchanged as companions). */
  inputFor: (row: { id: string; row: Record<string, unknown> }) => Record<string, unknown>
  /** Orizu's identity fields for a result line; they always win over the endpoint's. */
  stamp: (row: { id: string; row: Record<string, unknown> }) => Record<string, unknown>
}

/** Ordered output with bounded, shared-session calls; any failure cancels siblings. */
export function remoteRunnerResults(input: RemoteExecInput): Effect.Effect<string[], RemoteRunnerCallError | RemoteRunnerSetupError> {
  return Effect.scoped(Effect.gen(function* () {
    if (input.scorerVersion) {
      return yield* new RemoteRunnerRefusedBeforeCall({ message: `Runner version ${input.runnerVersionId} is a remote runner: remote runners run candidates; scorers stay on Orizu's side` })
    }
    const session = yield* createRemoteRunnerSession(input)
    return yield* Effect.forEach(input.rows, row => {
      // inputFor is the existing packaged-input owner; this adapter only supplies row/run identity.
      const callInput = { ...input.inputFor(row), row_id: row.id, run_id: null } as RemoteRunnerCallInput
      return session.call(callInput).pipe(Effect.map(result => JSON.stringify({ ...result, ...input.stamp(row) })))
    }, { concurrency: input.manifest.max_parallel })
  }))
}
