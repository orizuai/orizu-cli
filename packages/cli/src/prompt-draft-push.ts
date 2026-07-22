import { authedFetch } from './http.js'
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

// Mirrors index.ts `sanitizeTerminalText` (precedent: artifact-pull.ts keeps
// its own copy to avoid importing the CLI entrypoint).
function sanitizeTerminalText(value: unknown): string {
  return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
}

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
  /** Test seam; defaults to the authenticated CLI fetcher. */
  fetcher?: (path: string, init?: RequestInit) => Promise<Response>
}

export interface PushPromptDraftResult {
  data: Record<string, unknown>
  message: string
}

export async function pushPromptDraft(input: PushPromptDraftInput): Promise<PushPromptDraftResult> {
  const { kind, manifest } = input
  const files = buildPromptDraftFiles(input.primaryBody, input.sidecars)
  const fetcher = input.fetcher ?? authedFetch
  const baseBundle = isRecord(manifest.bundle) ? manifest.bundle : {}

  const response = await fetcher(`/api/cli/prompts/drafts?project=${encodeURIComponent(input.project)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
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
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to push ${kind}: ${await response.text()}`)
  }

  const rawBody = await response.text()
  let data: Record<string, unknown>
  try {
    data = JSON.parse(rawBody) as Record<string, unknown>
  } catch {
    throw new Error(
      `${kind} draft push returned invalid JSON (status ${response.status}). ` +
      `Body preview: ${sanitizeTerminalText(rawBody.slice(0, 180))}`
    )
  }

  const versionId = sanitizeTerminalText(String(data.prompt_version_id || 'unknown version'))
  const commit = sanitizeTerminalText(String(data.commit_sha || 'unknown commit')).slice(0, 12)
  const message = appendRegistrationTagWarning(
    `Pushed ${kind} ${sanitizeTerminalText(input.displayName)} as draft ${versionId} ` +
      `(commit ${commit}); it seals when the session branch merges`,
    data
  )
  return { data, message }
}
