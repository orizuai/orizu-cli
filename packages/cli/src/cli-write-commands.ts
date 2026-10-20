import { Schema } from 'effect'

import { sanitizeTerminalText } from './json-response.js'
import { sendOneRequestWrite, type MayAlreadyBeSavedNote, type OneRequestWrite } from './one-request-write.js'

// ORI-2726: what each one-request write command sends, the reply it expects,
// and what to tell a person when the write may already be saved. The advice
// follows what the server does when the same request arrives twice. Loaded
// only through `await import(...)`, so commands that never write skip Effect.

const SAFE = 'running the same command again is safe'
const note = (thing: string, done: string, advice: string): MayAlreadyBeSavedNote => ({ thing, done, advice })

type Write<A> = Pick<OneRequestWrite<A>, 'label' | 'name' | 'path' | 'method' | 'body' | 'reply' | 'mayAlreadyBeSaved' | 'describeError' | 'timeoutMs'>

const task = (id: string) => `/api/cli/tasks/${encodeURIComponent(id)}`
const Count = Schema.Number
const Text = Schema.String
const Assignments = {
  assignmentsCreated: Count,
  assignmentsProcessed: Schema.optionalKey(Count),
  assignmentsRemoved: Schema.optionalKey(Count),
  assignmentShortfall: Schema.optionalKey(Count),
  warning: Schema.optionalKey(Text),
}

const TaskCreated = Schema.Struct({
  task: Schema.Struct({ id: Text, title: Text, status: Text, requiredAssignmentsPerRow: Count, versionId: Text, versionNum: Count }),
  assignmentsCreated: Count,
  assignmentShortfall: Schema.optionalKey(Count),
  warning: Schema.optionalKey(Text),
})

/** Running it again makes a second task (and, with --publish, emails labellers again). */
export const taskCreate = (body: Record<string, unknown>, describeError: Write<typeof TaskCreated.Type>['describeError']): Write<typeof TaskCreated.Type> => ({
  label: 'create task', name: 'Task create', path: '/api/cli/tasks', method: 'POST', body, reply: TaskCreated, describeError,
  mayAlreadyBeSaved: note('task', 'created', 'check `orizu tasks list` before creating it again (running it again makes a second task)'),
})

const Nullable = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema))
const TaskUpdated = Schema.Struct({
  task: Schema.Struct({
    id: Text, title: Nullable(Text), status: Nullable(Text), dataset_id: Nullable(Text), app_id: Nullable(Text),
    version_id: Nullable(Text), required_assignments_per_row: Nullable(Count),
  }),
  assignmentMode: Schema.optionalKey(Text),
  assignmentsCreated: Schema.optionalKey(Count),
})

/** Sets the same values again, so a repeat is safe. */
export const taskUpdate = (id: string, body: Record<string, unknown>): Write<typeof TaskUpdated.Type> => ({
  label: 'update task', name: 'Task update', path: task(id), method: 'PATCH', body, reply: TaskUpdated, mayAlreadyBeSaved: note('task change', 'saved', SAFE),
})

const Discarded = Schema.Struct({ success: Schema.Boolean })
/** Once the draft is gone, a repeat is refused as "not found". */
export const taskDiscard = (id: string): Write<typeof Discarded.Type> => ({
  label: 'discard draft task', name: 'Draft discard', path: task(id), method: 'DELETE', reply: Discarded,
  mayAlreadyBeSaved: note('draft', 'discarded', 'check `orizu tasks list`; once it is gone, running it again answers "Task not found or access denied"'),
})

const Published = Schema.Struct({ task: Schema.Struct({ id: Text, status: Text }), ...Assignments, assignmentsProcessed: Count })
/** Once published, a repeat is refused as "must be a draft". */
export const taskPublish = (id: string, body: Record<string, unknown>): Write<typeof Published.Type> => ({
  label: 'publish task', name: 'Task publish', path: `${task(id)}/publish`, method: 'POST', body, reply: Published,
  mayAlreadyBeSaved: note('task', 'published', `check \`orizu tasks status --task ${id}\`; once published, running it again answers "Task must be a draft before publishing"`),
})

const Assigned = Schema.Struct(Assignments)
/** Adds only missing pairs and emails only new people, so a repeat is safe. */
export const taskAssign = (id: string, body: Record<string, unknown>): Write<typeof Assigned.Type> => ({
  label: 'assign task', name: 'Task assign', path: `${task(id)}/assign`, method: 'POST', body, reply: Assigned, mayAlreadyBeSaved: note('assignments', 'saved', SAFE),
})

const StatusChanged = Schema.Struct({ task: Schema.Struct({ id: Text, status: Text }) })
/** Setting the status a task already has changes nothing. */
export const taskStatus = (id: string, verb: string, status: string): Write<typeof StatusChanged.Type> => ({
  label: `${verb} task`, name: `Task ${verb}`, path: `${task(id)}/status`, method: 'PATCH', body: { status }, reply: StatusChanged,
  mayAlreadyBeSaved: note('task status change', 'saved', SAFE),
})

const RunStarted = Schema.Struct({
  optimization_run_id: Text,
  optimizationRun: Schema.Struct({ id: Text, status: Text, startedAt: Nullable(Text), createdAt: Nullable(Text) }),
})
/** The server picks a new run id per request, so running it again starts a second run. */
export const optimizationStart = (project: string, body: Record<string, unknown>): Write<typeof RunStarted.Type> => ({
  label: 'start optimization run', name: 'Optimization run start', path: `/api/cli/optimization-runs?project=${encodeURIComponent(project)}`, method: 'POST', body, reply: RunStarted,
  mayAlreadyBeSaved: note('run', 'started', 'check `orizu optimizations list` before starting again (running it again starts a second run)'),
})

const RunChanged = Schema.Struct({
  optimizationRun: Schema.Struct({
    id: Text, status: Schema.optionalKey(Text), startedAt: Nullable(Text), finishedAt: Nullable(Text), bestScore: Nullable(Count),
    bestCandidateId: Nullable(Text), resultPromptVersionId: Nullable(Text), metadata: Schema.optionalKey(Schema.Record(Text, Schema.Unknown)),
  }),
  cancellationStatus: Schema.optionalKey(Schema.Literal('already_terminal')),
})
/** Writing the status a run already has again converges, so a repeat is safe. */
export const optimizationLifecycle = (runId: string, body: Record<string, unknown>): Write<typeof RunChanged.Type> => ({
  label: 'update optimization run', name: 'Optimization run update', path: `/api/cli/optimization-runs/${encodeURIComponent(runId)}`, method: 'PATCH', body, reply: RunChanged,
  mayAlreadyBeSaved: note('run status change', 'saved', SAFE),
})

const EventLogged = Schema.Struct({ eventId: Text })
/** A repeat with the same event id changes nothing; a new id is refused as a sequence clash. */
export const optimizationEvent = (runId: string, body: Record<string, unknown> & { eventId: string }): Write<typeof EventLogged.Type> => ({
  label: 'log event', name: 'Event log', path: `/api/cli/optimization-runs/${encodeURIComponent(runId)}/events`, method: 'POST', body, reply: EventLogged,
  mayAlreadyBeSaved: note('event', 'logged', `run the same command again with \`--event-id ${body.eventId}\` (a new id would be refused as a clash)`),
})

const Linked = Schema.Struct({ app: Schema.Struct({ id: Text, name: Text }), linkedDataset: Schema.Struct({ id: Text, name: Text }), versionNum: Count })
/**
 * A plain overwrite, so a repeat is safe; without --version it links the
 * app's current version at the time, which may have moved on.
 */
export const appLinkDataset = (appId: string, body: { datasetId: string; versionNum?: number }): Write<typeof Linked.Type> => ({
  label: 'link dataset', name: 'Dataset link', path: `/api/cli/apps/${encodeURIComponent(appId)}/link-dataset`, method: 'POST', body, reply: Linked,
  mayAlreadyBeSaved: note('link', 'saved', body.versionNum === undefined ? 'running it again with `--version <n>` for the version you meant is safe' : SAFE),
})

// The CLI reads only what it prints; every other key the server sends is kept,
// so `--json` passes the app through as before ORI-2718.
const AppWritten = Schema.Struct({
  app: Schema.StructWithRest(Schema.Struct({
    id: Text,
    name: Text,
    versionNum: Count,
    url: Schema.optionalKey(Text),
    publishedCommit: Schema.optionalKey(Schema.NullOr(Schema.Struct({ outcome: Schema.Literals(['merged', 'already_merged']), sha: Text }))),
  }), [Schema.Record(Text, Schema.Unknown)]),
  warnings: Schema.optionalKey(Schema.Array(Text)),
})
export type AppWritten = typeof AppWritten.Type

/**
 * The server's refusal of an app source names each rule it breaks in
 * `validationErrors`; the person and `--json` both keep them (ORI-2718).
 */
const appWriteError = (label: string): NonNullable<Write<AppWritten>['describeError']> => async response => {
  const data = await response.json() as { error: string; validationErrors?: unknown; validationWarnings?: unknown }
  const texts = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map(sanitizeTerminalText) : []
  const problems = texts(data.validationErrors)
  const reason = [sanitizeTerminalText(data.error), ...(problems.length ? [problems.join('; ')] : [])].join(': ')
  return {
    message: `Failed to ${label}: ${reason}`,
    json: { error: reason, ...(Array.isArray(data.validationErrors) ? { validationErrors: problems, validationWarnings: texts(data.validationWarnings) } : {}), httpStatus: response.status },
  }
}

/** Nothing removes a repeat, so creating it again without `--id` makes a second app (ORI-2718). */
export const appCreate = (body: Record<string, unknown>): Write<AppWritten> => ({
  label: 'create app', name: 'App create', path: '/api/cli/apps/create-from-file', method: 'POST', body, reply: AppWritten,
  describeError: appWriteError('create app'),
  mayAlreadyBeSaved: note('app', 'created', 'check `orizu apps list` before creating it again (running it again makes a second app)'),
})

/** Each update adds a version, so running it again makes another version (ORI-2718). */
export const appUpdate = (appId: string, body: Record<string, unknown>): Write<AppWritten> => ({
  label: 'update app', name: 'App update', path: `/api/cli/apps/${encodeURIComponent(appId)}/update-from-file`, method: 'POST', body, reply: AppWritten,
  describeError: appWriteError('update app'),
  mayAlreadyBeSaved: note('app update', 'saved', `check \`orizu apps detail --app ${sanitizeTerminalText(appId)}\` before updating it again (running it again makes another version)`),
})

const Accepted = Schema.Struct({
  scoreRun: Schema.Struct({ id: Text, provenance: Text, acceptedByUserId: Schema.NullOr(Text), acceptedAt: Schema.NullOr(Text), alreadyAccepted: Schema.Boolean }),
})
/** The first acceptance is kept and a repeat says "already accepted". */
export const scoreAccept = (project: string, scoreRunId: string): Write<typeof Accepted.Type> => ({
  label: 'accept score run', name: 'Score run accept', path: `/api/cli/scores/accept?project=${encodeURIComponent(project)}`, method: 'POST', body: { scoreRunId }, reply: Accepted,
  mayAlreadyBeSaved: note('acceptance', 'saved', SAFE),
})

const ManifestRejected = Schema.Struct({ manifest: Schema.Record(Text, Schema.Unknown) })
/** Once rejected, a repeat is refused, so the advice is to look first. */
export const manifestReject = (id: string): Write<typeof ManifestRejected.Type> => ({
  label: 'reject manifest', name: 'Manifest reject', path: `/api/cli/promotion-manifests/${encodeURIComponent(id)}`, method: 'POST', body: { action: 'reject' }, reply: ManifestRejected,
  mayAlreadyBeSaved: note('manifest', 'rejected', `check \`orizu manifests show ${id}\``),
})

const Reply = Schema.Record(Text, Schema.Unknown)
type Pushed = typeof Reply.Type
type Artifact = 'prompt' | 'judge' | 'runner' | 'optimizer' | 'scorer'
// A runner or optimizer zip is stored and then committed one file at a time,
// which can outlast two minutes; wait as long as the policy allows.
const zipWait = (kind: Artifact) => kind === 'runner' || kind === 'optimizer' ? { timeoutMs: 300_000 } : {}
const pushWords = (kind: Artifact) => kind === 'scorer'
  ? { label: 'register scorer', name: 'Scorer register', done: 'registered' }
  : { label: `push ${kind}`, name: `${kind[0]!.toUpperCase()}${kind.slice(1)} push`, done: 'pushed' }

/**
 * A session push: the server keys the draft by the version's whole identity,
 * so a repeat answers with the same draft and commits nothing new (ORI-1105).
 */
export const draftPush = (kind: Artifact, path: string, body: Record<string, unknown>): Write<Pushed> => ({
  label: pushWords(kind).label, name: pushWords(kind).name, path, method: 'POST', body, reply: Reply, ...zipWait(kind),
  mayAlreadyBeSaved: note(`${kind} draft`, 'saved', `${SAFE} (it reuses the draft)`),
})

/**
 * A push without a session. Runners and optimizers with the same bytes reuse
 * their version. A judge with the same text is refused as identical, and a
 * scorer registered again gets a second version, so their advice is to look first.
 */
export const artifactPush = (kind: Artifact, path: string, body: Record<string, unknown>, describeError?: Write<Pushed>['describeError']): Write<Pushed> => ({
  label: pushWords(kind).label, name: pushWords(kind).name, path, method: 'POST', body, reply: Reply, ...zipWait(kind),
  ...(describeError ? { describeError } : {}),
  mayAlreadyBeSaved: note(kind, pushWords(kind).done, kind === 'scorer'
    ? 'check `orizu scorers list` before registering it again (running it again makes a second version)'
    : kind === 'judge' || kind === 'prompt' ? `check \`orizu ${kind}s list\` before pushing again` : SAFE),
})

/** Points the label at the same version again, so a repeat is safe. */
export const labelMove = (kind: 'prompt' | 'scorer', project: string, body: Record<string, unknown>): Write<Pushed> => ({
  label: `set ${kind} label`, name: kind === 'prompt' ? 'Prompt label move' : 'Scorer label move', path: `/api/cli/${kind}s/labels?project=${encodeURIComponent(project)}`, method: 'POST', body, reply: Reply,
  mayAlreadyBeSaved: note('label move', 'saved', SAFE),
})

/** Replaces the version's report with the same text again, so a repeat is safe. */
export const promptReportSet = (path: string, body: Record<string, unknown>): Write<Pushed> => ({
  label: 'update prompt report', name: 'Prompt report update', path, method: 'PATCH', body, reply: Reply,
  mayAlreadyBeSaved: note('prompt report', 'saved', SAFE),
})

const comment = (id: string) => `/api/cli/report-comments/${encodeURIComponent(id)}`

/** Nothing removes a repeat, so running it again posts a second comment. */
export const commentAdd = (query: string, body: Record<string, unknown>): Write<Pushed> => ({
  label: 'add report comment', name: 'Report comment add', path: `/api/cli/report-comments?${query}`, method: 'POST', body, reply: Reply,
  mayAlreadyBeSaved: note('comment', 'added', 'check `orizu comments list` with the same target before adding it again (running it again posts a second comment)'),
})

/** Nothing removes a repeat, so running it again posts a second reply. */
export const commentReply = (id: string, body: Record<string, unknown>): Write<Pushed> => ({
  label: 'reply to report comment', name: 'Report comment reply', path: comment(id), method: 'POST', body, reply: Reply,
  mayAlreadyBeSaved: note('reply', 'added', 'check its thread with `orizu comments list` before replying again (running it again posts a second reply)'),
})

/** Resolving again only moves its time and the same edit changes nothing, so a repeat is safe. */
export const commentUpdate = (id: string, action: 'resolve' | 'unresolve' | 'edit', body: Record<string, unknown>): Write<Pushed> => ({
  label: `${action} report comment`, name: `Report comment ${action}`, path: comment(id), method: 'PATCH', body, reply: Reply,
  mayAlreadyBeSaved: note(action === 'edit' ? 'comment edit' : 'comment status change', 'saved', SAFE),
})

const Promoted = Schema.Union([
  Schema.Struct({
    profileVersionId: Text,
    versionNumber: Count,
    // An older server sends neither of these; the CLI says so.
    appliedLabel: Schema.optionalKey(Schema.NullOr(Text)),
    runSeedVersionNumber: Schema.optionalKey(Count),
    productionVersionNumber: Schema.optionalKey(Schema.NullOr(Count)),
    components: Schema.Array(Schema.Struct({ key: Text, status: Text })),
  }),
  // Checked second, so a profile reply is never read as a prompt reply.
  Schema.Struct({ promptVersionId: Text }),
])
/**
 * A repeat never makes a second version: an instruction-set candidate answers
 * the version it already made, and a prompt candidate is refused as identical (ORI-1105).
 * Through the GitHub merge job the server can take about 120 s, so the CLI
 * waits as long as the policy allows.
 */
export const candidatePromote = (runId: string, project: string, body: { candidateId: string; label: string | null }): Write<typeof Promoted.Type> => ({
  label: 'promote optimization candidate', name: 'Candidate promotion', path: `/api/cli/optimization-runs/${encodeURIComponent(runId)}/promote?project=${encodeURIComponent(project)}`, method: 'POST', body, reply: Promoted,
  timeoutMs: 300_000,
  mayAlreadyBeSaved: note('candidate promotion', 'saved', `${SAFE}: it never makes a second version, and for a single-prompt run it answers "Prompt version is identical to the current prompt version." once the promotion is saved`),
})

/** Sends a write with this command's `--json` setting and output. Ctrl-C sets the exit code and returns null. */
export async function sendCommandWrite<A>(write: Write<A>, io: Pick<OneRequestWrite<A>, 'json' | 'print' | 'fetcher'>): Promise<A | null> {
  const outcome = await sendOneRequestWrite({ ...write, ...io })
  if (outcome.kind === 'saved') return outcome.reply
  process.exitCode = outcome.exitCode
  return null
}
