import { authedFetch } from './http.js'

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

// Mirrors index.ts `sanitizeTerminalText` (precedent: artifact-pull.ts keeps
// its own copy to avoid importing the CLI entrypoint).
function sanitizeTerminalText(value: unknown): string {
  return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
}

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
  parseJsonResponse: (response: Response, label: string) => Promise<Record<string, unknown>>
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
    const { data, message } = await pushScorerDraft({
      project,
      sessionId,
      name,
      manifest,
      promptVersionId: ctx.getArg('--prompt-version') || undefined,
      runnerVersionId: ctx.getArg('--runner-version') || undefined,
    })
    if (ctx.hasJsonFlag()) ctx.printJson(data)
    else ctx.printLine(message)
    return
  }

  // LEGACY SESSIONLESS PATH (no branch to commit to; the server keeps the
  // DB/object-store manifest). TODO(ALI-1074 P6): retire when sessionless
  // goes git.
  const response = await authedFetch(`/api/cli/scorers?project=${encodeURIComponent(project)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      manifest,
      promptVersionId: ctx.getArg('--prompt-version') || undefined,
      runnerVersionId: ctx.getArg('--runner-version') || undefined,
      label: ctx.getArg('--label') || undefined,
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to register scorer: ${await response.text()}`)
  }

  const data = await ctx.parseJsonResponse(response, 'Scorer register')
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
  /** Test seam; defaults to the authenticated CLI fetcher. */
  fetcher?: (path: string, init?: RequestInit) => Promise<Response>
}

export interface PushScorerDraftResult {
  data: Record<string, unknown>
  message: string
}

export async function pushScorerDraft(input: PushScorerDraftInput): Promise<PushScorerDraftResult> {
  const fetcher = input.fetcher ?? authedFetch

  const response = await fetcher(`/api/cli/scorers/drafts?project=${encodeURIComponent(input.project)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: input.sessionId,
      name: input.name,
      manifest: input.manifest,
      promptVersionId: input.promptVersionId,
      runnerVersionId: input.runnerVersionId,
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to register scorer: ${await response.text()}`)
  }

  const rawBody = await response.text()
  let data: Record<string, unknown>
  try {
    data = JSON.parse(rawBody) as Record<string, unknown>
  } catch {
    throw new Error(
      `scorer draft push returned invalid JSON (status ${response.status}). ` +
      `Body preview: ${sanitizeTerminalText(rawBody.slice(0, 180))}`
    )
  }

  const versionId = sanitizeTerminalText(String(data.scorer_version_id || 'unknown version'))
  const commit = sanitizeTerminalText(String(data.commit_sha || 'unknown commit')).slice(0, 12)
  const message =
    `Registered scorer ${sanitizeTerminalText(input.name)} as draft ${versionId} ` +
    `(commit ${commit}); it seals when the session branch merges`
  return { data, message }
}
