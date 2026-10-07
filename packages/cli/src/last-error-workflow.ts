import { randomBytes } from 'crypto'
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'
import { Effect, Schema } from 'effect'

import {
  LAST_ERROR_ARG_MAX_CHARS,
  LAST_ERROR_CODE_MAX_CHARS,
  LAST_ERROR_FILE_MAX_BYTES,
  LAST_ERROR_MAX_ARGS,
  LAST_ERROR_MESSAGE_MAX_CHARS,
} from './last-error-caps.js'
import {
  boundedServerBaseUrl,
  isStringWithinCap,
  LAST_ERROR_FILENAME,
  LAST_ERROR_RECORD_VERSION,
  type LastErrorRecord,
} from './last-error-record.js'

// ORI-2450: Effect owns the last-error file's publication and reading.
// last-error-record.ts loads this module with a literal dynamic import, so the
// npm CLI only loads Effect on a failure or a feedback read, and the source
// bundle still includes it.

class LastErrorFileFailure extends Error {
  constructor(readonly operation: string) {
    super(`Could not ${operation}`)
  }
}

const file = <A>(operation: string, action: () => A) => Effect.try({
  try: action,
  catch: () => new LastErrorFileFailure(operation),
})

const NullableString = Schema.NullOr(Schema.String)

const LastErrorRecordSchema = Schema.Struct({
  version: Schema.Literal(LAST_ERROR_RECORD_VERSION),
  recordedAt: Schema.String.check(Schema.makeFilter(value => Number.isFinite(Date.parse(value)))),
  cliVersion: NullableString,
  code: Schema.optionalKey(NullableString.check(Schema.makeFilter(value =>
    value === null || Array.from(value).length <= LAST_ERROR_CODE_MAX_CHARS))),
  serverBaseUrl: Schema.optionalKey(NullableString),
  teamSlug: Schema.optionalKey(NullableString),
  command: NullableString,
  argv: Schema.Array(Schema.String),
  argvTruncated: Schema.Boolean,
  message: Schema.String,
  messageTruncated: Schema.Boolean,
}).check(Schema.makeFilter(record =>
  (record.command === null || isStringWithinCap(record.command, LAST_ERROR_ARG_MAX_CHARS, record.argvTruncated))
  && record.argv.length <= LAST_ERROR_MAX_ARGS
  && record.argv.every(argument => isStringWithinCap(argument, LAST_ERROR_ARG_MAX_CHARS, record.argvTruncated))
  && isStringWithinCap(record.message, LAST_ERROR_MESSAGE_MAX_CHARS, record.messageTruncated)))

const publication = (configDirectory: string, serialized: string) => Effect.gen(function*() {
  yield* file('create directory', () => mkdirSync(configDirectory, { recursive: true, mode: 0o700 }))
  yield* file('protect directory', () => chmodSync(configDirectory, 0o700))
  const path = join(configDirectory, LAST_ERROR_FILENAME)
  // Write a private temporary file, then rename it over the record, so a
  // reader never sees a half-written record and a failed write keeps the old one.
  yield* Effect.acquireUseRelease(
    Effect.sync(() => join(
      configDirectory,
      `.${LAST_ERROR_FILENAME}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    )),
    temporaryPath => Effect.gen(function*() {
      yield* Effect.acquireUseRelease(
        file('open temporary record', () => openSync(temporaryPath, 'wx', 0o600)),
        descriptor => Effect.gen(function*() {
          yield* file('write temporary record', () => writeFileSync(descriptor, serialized, 'utf8'))
          yield* file('flush temporary record', () => fsyncSync(descriptor))
        }),
        descriptor => Effect.sync(() => closeSync(descriptor)),
      )
      yield* file('protect temporary record', () => chmodSync(temporaryPath, 0o600))
      yield* file('publish record', () => renameSync(temporaryPath, path))
      yield* file('protect published record', () => chmodSync(path, 0o600))
    }),
    temporaryPath => Effect.sync(() => rmSync(temporaryPath, { force: true })),
  )
})

export function publishLastErrorRecord(configDirectory: string, serialized: string): Promise<void> {
  return Effect.runPromise(publication(configDirectory, serialized))
}

const loading = (path: string) => Effect.gen(function*() {
  const stat = yield* file('inspect record', () => statSync(path))
  if (stat.size > LAST_ERROR_FILE_MAX_BYTES) return null
  const text = yield* file('read record', () => readFileSync(path, 'utf8'))
  const raw = yield* file('parse record', () => JSON.parse(text) as unknown)
  const record = yield* Schema.decodeUnknownEffect(LastErrorRecordSchema)(raw)
  // The Schema checks the known fields; the reader has always kept any others.
  const admitted: LastErrorRecord = {
    ...(raw as Record<string, unknown>),
    ...record,
    argv: [...record.argv],
    code: record.code ?? null,
    serverBaseUrl: boundedServerBaseUrl(record.serverBaseUrl),
    teamSlug: record.teamSlug ?? null,
  }
  return admitted
})

export function loadLastErrorRecord(path: string): Promise<LastErrorRecord | null> {
  return Effect.runPromise(loading(path).pipe(Effect.orElseSucceed(() => null)))
}
