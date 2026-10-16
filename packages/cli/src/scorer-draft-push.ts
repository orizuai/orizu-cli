import { sanitizeTerminalText } from './json-response.js'
import { appendRegistrationTagWarning } from './registration-tag-warning.js'

/**
 * ADR-007 P5 (ALI-1074): the session-scoped, commit-first scorer push.
 *
 * `orizu scorers register --session <id>` creates the version through
 * POST /api/cli/scorers/drafts: the server commits the scorer's canonical
 * `manifest.json` to the session's `orizu/session-*` branch (one Git Data API
 * commit) and then writes a DRAFT row pinning
 * repo_path/content_sha/commit_sha. The draft seals — and gets its version
 * number — when the session branch merges via `orizu session finish` +
 * promotion-manifest apply.
 *
 * The git filename is ALWAYS `manifest.json`: the server read side
 * (lib/artifact-git-read.ts SCORER_MANIFEST_FILENAMES) prefers that name.
 *
 * Lives outside index.ts per the CLI line ratchet (ALI-976); mirrors
 * prompt-draft-push.ts.
 */

/** index.ts helpers injected by the command dispatcher (report-comments-cli
 * precedent: command modules receive a ctx instead of importing the CLI
 * entrypoint). */
export interface ScorersRegisterContext {
  getArg: (name: string) => string | null
  resolveProjectSlug: (projectArg: string | null) => Promise<string>
  readJsonFile: (pathArg: string) => Record<string, unknown>
  hasJsonFlag: () => boolean
  printJson: (value: Record<string, unknown>) => void
  printLine: (message?: string) => void
}

/** The full `orizu scorers register` command (moved out of index.ts for the
 * CLI line ratchet): --session takes the ADR-007 P5 commit-first draft path,
 * sessionless stays on the legacy create endpoint. */
export async function runScorersRegister(ctx: ScorersRegisterContext): Promise<void> {
  const project = ctx.getArg('--project') || await ctx.resolveProjectSlug(null)
  const name = ctx.getArg('--name')
  const manifestPath = ctx.getArg('--manifest')
  const sessionId = ctx.getArg('--session') || undefined

  if (!name || !manifestPath) {
    throw new Error('Usage: orizu scorers register --project <team/project> --name <name> --manifest <manifest.json> [--prompt-version <id>] [--runner-version <id>] [--label <label>] [--session <session-id>] [--json]')
  }

  const manifest = ctx.readJsonFile(manifestPath)

  // ADR-007 P5 (ALI-1074): in a session the version is a COMMIT-FIRST git
  // draft (pins repo_path/content_sha/commit_sha).
  if (sessionId) {
    if (ctx.getArg('--label')) {
      throw new Error('--label cannot be combined with --session: labels address sealed versions; move the label after the session merges')
    }
    const pushed = await pushScorerDraft({
      project,
      sessionId,
      name,
      manifest,
      promptVersionId: ctx.getArg('--prompt-version') || undefined,
      runnerVersionId: ctx.getArg('--runner-version') || undefined,
      json: ctx.hasJsonFlag(),
      print: line => ctx.printLine(line),
    })
    if (!pushed) return
    const { data, message } = pushed
    if (ctx.hasJsonFlag()) ctx.printJson(data)
    else ctx.printLine(message)
    return
  }

  // LEGACY SESSIONLESS PATH (no branch to commit to; the server keeps the
  // DB/object-store manifest). TODO(ALI-1074 P6): retire when sessionless
  // goes git.
  const writes = await import('./cli-write-commands.js')
  const data = await writes.sendCommandWrite(writes.artifactPush('scorer', `/api/cli/scorers?project=${encodeURIComponent(project)}`, {
    name,
    manifest,
    promptVersionId: ctx.getArg('--prompt-version') || undefined,
    runnerVersionId: ctx.getArg('--runner-version') || undefined,
    label: ctx.getArg('--label') || undefined,
  }), { json: ctx.hasJsonFlag(), print: line => ctx.printLine(line) })
  if (data === null) return
  if (ctx.hasJsonFlag()) {
    ctx.printJson(data)
    return
  }

  ctx.printLine(`Registered scorer ${sanitizeTerminalText(name)} (${sanitizeTerminalText(String(data.scorer_version_id || 'unknown version'))})`)
}

export interface PushScorerDraftInput {
  project: string
  sessionId: string
  name: string
  /** The parsed scorer manifest (the artifact's canonical bytes). */
  manifest: Record<string, unknown>
  promptVersionId?: string
  runnerVersionId?: string
  /** `--json`: a failure also prints one object on stdout. */
  json?: boolean
  print?: (line: string) => void
  /** Test seam; defaults to the authenticated CLI fetcher. */
  fetcher?: (path: string, init: RequestInit) => Promise<Response>
}

export interface PushScorerDraftResult {
  data: Record<string, unknown>
  message: string
}

/** Null when Ctrl-C or SIGTERM stopped the wait; the exit code is already set (ORI-1105). */
export async function pushScorerDraft(input: PushScorerDraftInput): Promise<PushScorerDraftResult | null> {
  const writes = await import('./cli-write-commands.js')
  const data = await writes.sendCommandWrite(writes.draftPush('scorer', `/api/cli/scorers/drafts?project=${encodeURIComponent(input.project)}`, {
    sessionId: input.sessionId,
    name: input.name,
    manifest: input.manifest,
    promptVersionId: input.promptVersionId,
    runnerVersionId: input.runnerVersionId,
  }), { json: input.json ?? false, print: input.print ?? (line => process.stdout.write(`${line}\n`)), ...(input.fetcher ? { fetcher: input.fetcher } : {}) })
  if (data === null) return null

  const versionId = sanitizeTerminalText(String(data.scorer_version_id || 'unknown version'))
  const commit = sanitizeTerminalText(String(data.commit_sha || 'unknown commit')).slice(0, 12)
  const message = appendRegistrationTagWarning(
    `Registered scorer ${sanitizeTerminalText(input.name)} as draft ${versionId} ` +
      `(commit ${commit}); it seals when the session branch merges`,
    data
  )
  return { data, message }
}
