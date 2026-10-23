import { readFile } from 'node:fs/promises'

import { Data, Effect, Result, Schema } from 'effect'

import { archiveArtifactEntries } from './artifact-archive.js'
import { authedFetch } from './http.js'
import { parseJsonResponse, sanitizeTerminalText } from './json-response.js'
import { checkRemoteRunner, type RemoteRunnerCheckReport } from './remote-runner-call.js'
import { decodeRemoteRunnerManifest } from './remote-runner-manifest.js'

// ORI-2805 (ADR-042): `orizu runners add-remote` registers a remote runner as
// an ordinary runner version whose zip holds only its manifest, through the
// same route as `runners push`. The same settings give the same bytes, so
// registering twice reuses the version; a new URL or limit makes a new one.

const FLAGS: Record<string, string> = { url: '--url', secret_env: '--secret-env', max_parallel: '--max-parallel', timeout_seconds: '--timeout-seconds' }

class RemoteRunnerRegistrationFailed extends Data.TaggedError('RemoteRunnerRegistrationFailed')<{ message: string }> {}

export interface RemoteRunnerAddContext {
  hasFlag: (flag: string) => boolean
  getArg: (flag: string) => string | undefined | null
  getPositionalArg: (index: number) => string | undefined | null
  resolveProjectSlug: (project: string | null) => Promise<string>
  hasJsonFlag: () => boolean
  printJson: (value: Record<string, unknown>) => void
  printLine: (value: string) => void
}

const whole = (value: string | undefined | null) => value === undefined || value === null ? undefined : Number(value)

function registration(ctx: RemoteRunnerAddContext) {
  return Effect.gen(function* () {
    const name = ctx.getPositionalArg(2)
    if (!name) {
      return yield* new RemoteRunnerRegistrationFailed({ message: 'Usage: orizu runners add-remote <name> --url <https://…> --secret-env <REMOTE_RUNNER_…> [--max-parallel <n>] [--timeout-seconds <n>] [--input <file>] [--no-check] [--project <team/project>] [--json]' })
    }
    if (ctx.getArg('--session')) return yield* new RemoteRunnerRegistrationFailed({ message: 'runners add-remote does not take --session: register remote runners outside a session' })
    // Validate the manifest before checking the endpoint or registering it.
    const given = {
      url: ctx.getArg('--url'), secret_env: ctx.getArg('--secret-env'),
      max_parallel: whole(ctx.getArg('--max-parallel')), timeout_seconds: whole(ctx.getArg('--timeout-seconds')),
    }
    // A flag left out is a missing key, so it takes its default or reads "is required".
    const present = Object.fromEntries(Object.entries(given).filter(([, value]) => value !== undefined && value !== null))
    const manifest = yield* decodeRemoteRunnerManifest({ name, kind: 'remote', ...present }, field => FLAGS[field] ?? field)
    const project = ctx.getArg('--project') || (yield* Effect.promise(() => ctx.resolveProjectSlug(null)))
    const check = ctx.hasFlag('--no-check') ? null : yield* checkRemoteRunner(manifest, yield* checkInput(ctx))
    if (check && !check.passed) {
      printCheck(ctx, { check })
      return yield* new RemoteRunnerRegistrationFailed({ message: check.message ?? 'Remote runner check failed' })
    }
    const { zipBase64, contentSha256 } = archiveArtifactEntries([
      { path: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') },
    ])
    const response = yield* Effect.promise(() => authedFetch(`/api/cli/runners?project=${encodeURIComponent(project)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, manifest, zipBase64, contentSha256 }),
    }))
    if (!response.ok) {
      return yield* new RemoteRunnerRegistrationFailed({ message: `Failed to register remote runner: ${yield* Effect.promise(() => response.text())}` })
    }
    const data = yield* Effect.promise(() => parseJsonResponse<Record<string, unknown>>(response, 'remote runner registration'))
    if (check) {
      const saved = yield* Effect.result(saveCheck(project, String(data.runner_version_id), check))
      if (Result.isFailure(saved)) {
        printCheck(ctx, { runner_version_id: String(data.runner_version_id), check: { ...check, passed: false, message: saved.failure.message } })
        return yield* saved.failure
      }
      data.check = check
    }
    if (ctx.hasJsonFlag()) ctx.printJson(data)
    else {
      if (check) printCheck(ctx, { check })
      ctx.printLine(`Registered remote runner ${sanitizeTerminalText(name)} (${sanitizeTerminalText(String(data.runner_version_id ?? 'unknown version'))}) at ${sanitizeTerminalText(manifest.url)}; calls send the secret from $${manifest.secret_env}`)
    }
  })
}

// Match the normal runner request's row and candidate fields, preserving optional input.
const CheckInput = Schema.StructWithRest(Schema.Struct({
  row: Schema.Record(Schema.String, Schema.Unknown),
  candidate: Schema.Struct({
    components: Schema.Record(Schema.String, Schema.String),
    model_config: Schema.Struct({
      identity: Schema.NullOr(Schema.String),
      settings_version_id: Schema.NullOr(Schema.String),
      provider_settings: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  }),
}), [Schema.Record(Schema.String, Schema.Unknown)])
function checkInput(ctx: RemoteRunnerAddContext) {
  return Effect.gen(function* () {
    const path = ctx.getArg('--input')
    if (!path) {
      if (ctx.hasFlag('--input')) return yield* new RemoteRunnerRegistrationFailed({ message: '--input needs a JSON file' })
      return undefined
    }
    const raw = yield* Effect.tryPromise({
      try: async () => JSON.parse(await readFile(path, 'utf8')) as unknown,
      catch: () => new RemoteRunnerRegistrationFailed({ message: 'Cannot read --input as JSON' }),
    })
    const decoded = Schema.decodeUnknownResult(CheckInput)(raw)
    if (Result.isFailure(decoded)) return yield* new RemoteRunnerRegistrationFailed({ message: '--input must contain row and candidate: components and model_config with identity and settings_version_id; provider_settings is optional' })
    return decoded.success
  })
}

function standaloneCheck(ctx: RemoteRunnerAddContext) {
  return Effect.gen(function* () {
    const name = ctx.getPositionalArg(2)
    if (!name) return yield* new RemoteRunnerRegistrationFailed({ message: 'Usage: orizu runners check <name> [--version <id>] [--input <file>] [--project <team/project>] [--json]' })
    if (ctx.hasFlag('--session')) return yield* new RemoteRunnerRegistrationFailed({ message: 'runners check does not take --session' })
    const project = ctx.getArg('--project') || (yield* Effect.promise(() => ctx.resolveProjectSlug(null)))
    const version = ctx.getArg('--version')
    if (!version && ctx.hasFlag('--version')) return yield* new RemoteRunnerRegistrationFailed({ message: '--version needs a runner version ID' })
    const response = yield* Effect.promise(() => authedFetch(`/api/cli/runners/${encodeURIComponent(name)}?project=${encodeURIComponent(project)}${version ? `&version=${encodeURIComponent(version)}` : ''}`))
    if (!response.ok) return yield* new RemoteRunnerRegistrationFailed({ message: `Failed to resolve remote runner (status ${response.status})` })
    const resolved = yield* Effect.promise(() => parseJsonResponse<{ version: { id: string; manifest: unknown } }>(response, 'remote runner'))
    const manifest = yield* decodeRemoteRunnerManifest(resolved.version.manifest, field => `stored manifest field ${field}`)
    const check = yield* checkRemoteRunner(manifest, yield* checkInput(ctx))
    if (check.passed) {
      const saved = yield* Effect.result(saveCheck(project, resolved.version.id, check))
      if (Result.isFailure(saved)) {
        printCheck(ctx, { runner_version_id: resolved.version.id, check: { ...check, passed: false, message: saved.failure.message } })
        return yield* saved.failure
      }
    }
    printCheck(ctx, { runner_version_id: resolved.version.id, check })
    if (!check.passed) return yield* new RemoteRunnerRegistrationFailed({ message: check.message ?? 'Remote runner check failed' })
  })
}

export function runRemoteRunnerCheck(ctx: RemoteRunnerAddContext): Promise<void> {
  return Effect.runPromise(standaloneCheck(ctx))
}

function printCheck(ctx: RemoteRunnerAddContext, data: { check: RemoteRunnerCheckReport; runner_version_id?: string }): void {
  if (ctx.hasJsonFlag()) ctx.printJson(data)
  else {
    const check = data.check
    ctx.printLine(`Remote runner check: ${check.passed ? 'passed' : 'failed'}; reachable: ${check.reachable ?? 'not checked'}; secret: ${check.secret}; result shape: ${check.result_shape}; callback: ${check.callback}; deployed version: ${check.deployed_version ?? 'not reported'}${check.message ? `; ${check.message}` : ''}`)
  }
}

function saveCheck(project: string, version: string, check: RemoteRunnerCheckReport) {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () => authedFetch(`/api/cli/runner-versions/${encodeURIComponent(version)}/check?project=${encodeURIComponent(project)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deployed_version: check.deployed_version }),
      }),
      catch: () => new RemoteRunnerRegistrationFailed({ message: 'Failed to save remote runner check; no persisted pass was confirmed' }),
    })
    if (!response.ok) return yield* new RemoteRunnerRegistrationFailed({ message: `Failed to save remote runner check (status ${response.status}); no persisted pass was confirmed` })
  })
}

export function runRemoteRunnerAdd(ctx: RemoteRunnerAddContext): Promise<void> {
  return Effect.runPromise(registration(ctx))
}
