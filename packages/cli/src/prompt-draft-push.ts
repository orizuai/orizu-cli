import { sanitizeTerminalText } from './json-response.js'
import { appendRegistrationTagWarning } from './registration-tag-warning.js'

/**
 * ADR-007 P4 (ALI-1074): the session-scoped, commit-first prompt push.
 *
 * `orizu prompts|judges push --session <id>` creates the version through
 * POST /api/cli/prompts/drafts: the server commits the artifact files to the
 * session's `orizu/session-*` branch (one Git Data API commit) and then
 * writes a DRAFT row pinning repo_path/content_sha/commit_sha. The draft
 * seals — and gets its version number — when the session branch merges via
 * `orizu session finish` + promotion-manifest apply.
 *
 * The primary text is ALWAYS committed as `prompt.md`: the server read side
 * (lib/artifact-git-read.ts PROMPT_BODY_FILENAMES) prefers that name, so the
 * git filename stays canonical regardless of what the local bundle calls its
 * body file.
 *
 * Lives outside index.ts per the CLI line ratchet (ALI-976).
 */

export const PROMPT_PRIMARY_GIT_FILENAME = 'prompt.md'

export interface PromptDraftSidecar {
  path: string
  content?: unknown
  [key: string]: unknown
}

export interface PromptDraftFile {
  path: string
  content: string
}

/**
 * Build the git file set for a prompt-version draft: the primary text at the
 * canonical prompt.md plus every sidecar at its own relative path. A sidecar
 * that collides with prompt.md is a hard error (it would silently overwrite
 * the body in the committed tree).
 */
export function buildPromptDraftFiles(
  primaryBody: string,
  sidecars: PromptDraftSidecar[]
): PromptDraftFile[] {
  const files: PromptDraftFile[] = [
    { path: PROMPT_PRIMARY_GIT_FILENAME, content: primaryBody },
  ]
  for (const sidecar of sidecars) {
    const sidecarPath = String(sidecar.path)
    if (sidecarPath === PROMPT_PRIMARY_GIT_FILENAME) {
      throw new Error(`Prompt sidecar path ${PROMPT_PRIMARY_GIT_FILENAME} collides with the primary text file`)
    }
    files.push({ path: sidecarPath, content: String(sidecar.content ?? '') })
  }
  return files
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface PushPromptDraftInput {
  kind: 'prompt' | 'judge'
  project: string
  sessionId: string
  /** The parsed orizu.prompt.json manifest of the local bundle. */
  manifest: Record<string, unknown>
  /** What to call the artifact in the success message (name or directory). */
  displayName: string
  bodyKind: string
  primaryBody: string
  sidecars: PromptDraftSidecar[]
  runnerVersionId: string
  parentVersionId?: string
  report?: { markdown: string; sourceName: string | null } | null
  /** `--json`: a failure also prints one object on stdout. */
  json?: boolean
  print?: (line: string) => void
  /** Test seam; defaults to the authenticated CLI fetcher. */
  fetcher?: (path: string, init: RequestInit) => Promise<Response>
}

export interface PushPromptDraftResult {
  data: Record<string, unknown>
  message: string
}

/**
 * Sends the push with a deadline and Ctrl-C handling (ORI-1105). Null when
 * Ctrl-C or SIGTERM stopped the wait; the exit code is already set.
 */
export async function pushPromptDraft(input: PushPromptDraftInput): Promise<PushPromptDraftResult | null> {
  const { kind, manifest } = input
  const files = buildPromptDraftFiles(input.primaryBody, input.sidecars)
  const baseBundle = isRecord(manifest.bundle) ? manifest.bundle : {}

  const writes = await import('./cli-write-commands.js')
  const data = await writes.sendCommandWrite(writes.draftPush(kind, `/api/cli/prompts/drafts?project=${encodeURIComponent(input.project)}`, {
    sessionId: input.sessionId,
    name: manifest.name,
    role: kind === 'judge' && manifest.role === undefined ? 'judge_per_row' : manifest.role,
    description: manifest.description,
    bodyKind: input.bodyKind,
    providerSettings: manifest.provider_settings || {},
    bundle: {
      ...baseBundle,
      tags: manifest.tags || [],
      provenance: manifest.provenance || {},
      primaryText: {
        path: PROMPT_PRIMARY_GIT_FILENAME,
        kind: input.bodyKind,
      },
      sidecars: input.sidecars,
    },
    runnerVersionId: input.runnerVersionId,
    parentVersionId: input.parentVersionId,
    createdBy: manifest.provenance || { kind: 'human-edit' },
    files,
    ...(input.report
      ? {
          reportMarkdown: input.report.markdown,
          reportSourceName: input.report.sourceName,
        }
      : {}),
  }), { json: input.json ?? false, print: input.print ?? (line => process.stdout.write(`${line}\n`)), ...(input.fetcher ? { fetcher: input.fetcher } : {}) })
  if (data === null) return null

  const versionId = sanitizeTerminalText(String(data.prompt_version_id || 'unknown version'))
  const commit = sanitizeTerminalText(String(data.commit_sha || 'unknown commit')).slice(0, 12)
  const message = appendRegistrationTagWarning(
    `Pushed ${kind} ${sanitizeTerminalText(input.displayName)} as draft ${versionId} ` +
      `(commit ${commit}); it seals when the session branch merges`,
    data
  )
  return { data, message }
}
