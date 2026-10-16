import { basename } from 'path'

import { zipDirectoryToBase64 } from './artifact-archive.js'
import { sanitizeTerminalText } from './json-response.js'
import { appendRegistrationTagWarning } from './registration-tag-warning.js'

/**
 * ADR-007 P5 (ALI-1074): the session-scoped, commit-first runner/optimizer
 * push.
 *
 * `orizu runners|optimizers push --session <id>` sends the SAME deterministic
 * zip as the legacy push to POST /api/cli/{runners|optimizers}/drafts: the
 * server unpacks the zip's file set and commits it to the session's
 * `orizu/session-*` branch (one Git Data API commit; binary entries travel
 * base64), keeps uploading the zip to storage (dual-write until ALI-1046),
 * and writes a DRAFT row pinning repo_path/content_sha/commit_sha. The draft
 * seals — and gets its version number — when the session branch merges via
 * `orizu session finish` + promotion-manifest apply.
 *
 * Labels cannot ride a draft push (`--label` with `--session` is an error at
 * the command layer): labels address sealed versions only.
 *
 * Lives outside index.ts per the CLI line ratchet (ALI-976); mirrors
 * prompt-draft-push.ts.
 */

/** index.ts helpers injected by the command dispatcher (report-comments-cli
 * precedent: command modules receive a ctx instead of importing the CLI
 * entrypoint). */
export interface ZipArtifactPushContext {
  getArg: (name: string) => string | null
  getPositionalArg: (index: number) => string | null
  resolveProjectSlug: (projectArg: string | null) => Promise<string>
  readManifestFile: (dirArg: string) => Record<string, unknown>
  expandHomePath: (path: string) => string
  hasJsonFlag: () => boolean
  printJson: (value: Record<string, unknown>) => void
  printLine: (message?: string) => void
}

/** The full `orizu runners|optimizers push` command (moved out of index.ts
 * for the CLI line ratchet): --session takes the ADR-007 P5 commit-first
 * draft path, sessionless stays on the legacy zip-only endpoint. */
export async function runZipArtifactPush(
  kind: 'runner' | 'optimizer',
  ctx: ZipArtifactPushContext
): Promise<void> {
  const artifactDir = ctx.getPositionalArg(2)
  const project = ctx.getArg('--project') || await ctx.resolveProjectSlug(null)
  const name = ctx.getArg('--name')
  const label = ctx.getArg('--label') || undefined
  const sessionId = ctx.getArg('--session') || undefined

  if (!artifactDir) {
    throw new Error(`Usage: orizu ${kind === 'runner' ? 'runners' : 'optimizers'} push <dir> --project <team/project> [--name <name>] [--label <label>] [--session <session-id>] [--json]`)
  }

  const manifest = ctx.readManifestFile(artifactDir)
  const artifactName = name || (typeof manifest.name === 'string' ? manifest.name : basename(ctx.expandHomePath(artifactDir)))
  const description = typeof manifest.description === 'string' ? manifest.description : undefined
  const { zipBase64, contentSha256 } = zipDirectoryToBase64(artifactDir)

  // ADR-007 P5 (ALI-1074): in a session the version is a COMMIT-FIRST git
  // draft — the server unpacks the zip into the artifact's repo directory and
  // pins repo_path/content_sha/commit_sha (zip storage stays as a dual-write).
  if (sessionId) {
    if (label) {
      throw new Error('--label cannot be combined with --session: labels address sealed versions; move the label after the session merges')
    }
    const pushed = await pushZipDraft({
      kind,
      project,
      sessionId,
      name: String(artifactName),
      description,
      manifest,
      zipBase64,
      contentSha256,
      json: ctx.hasJsonFlag(),
      print: line => ctx.printLine(line),
    })
    if (!pushed) return
    const { data, message } = pushed
    if (ctx.hasJsonFlag()) ctx.printJson(data)
    else ctx.printLine(message)
    return
  }

  // LEGACY SESSIONLESS PATH (no branch to commit to; zip-only write).
  // TODO(ALI-1074 P6): retire when sessionless goes git.
  const endpoint = kind === 'runner' ? 'runners' : 'optimizers'
  const writes = await import('./cli-write-commands.js')
  const data = await writes.sendCommandWrite(writes.artifactPush(kind, `/api/cli/${endpoint}?project=${encodeURIComponent(project)}`, {
    name: artifactName,
    description,
    label,
    manifest,
    zipBase64,
    contentSha256,
  }), { json: ctx.hasJsonFlag(), print: line => ctx.printLine(line) })
  if (data === null) return
  if (ctx.hasJsonFlag()) {
    ctx.printJson(data)
    return
  }

  const versionId = kind === 'runner' ? data.runner_version_id : data.optimizer_version_id
  ctx.printLine(`Pushed ${kind} ${sanitizeTerminalText(String(artifactName))} (${sanitizeTerminalText(String(versionId || 'unknown version'))})`)
}

export interface PushZipDraftInput {
  kind: 'runner' | 'optimizer'
  project: string
  sessionId: string
  name: string
  description?: string
  manifest: Record<string, unknown>
  zipBase64: string
  contentSha256: string
  /** `--json`: a failure also prints one object on stdout. */
  json?: boolean
  print?: (line: string) => void
  /** Test seam; defaults to the authenticated CLI fetcher. */
  fetcher?: (path: string, init: RequestInit) => Promise<Response>
}

export interface PushZipDraftResult {
  data: Record<string, unknown>
  message: string
}

/** Null when Ctrl-C or SIGTERM stopped the wait; the exit code is already set (ORI-1105). */
export async function pushZipDraft(input: PushZipDraftInput): Promise<PushZipDraftResult | null> {
  const endpoint = input.kind === 'runner' ? 'runners' : 'optimizers'
  const writes = await import('./cli-write-commands.js')
  const data = await writes.sendCommandWrite(writes.draftPush(input.kind, `/api/cli/${endpoint}/drafts?project=${encodeURIComponent(input.project)}`, {
    sessionId: input.sessionId,
    name: input.name,
    description: input.description,
    manifest: input.manifest,
    zipBase64: input.zipBase64,
    contentSha256: input.contentSha256,
  }), { json: input.json ?? false, print: input.print ?? (line => process.stdout.write(`${line}\n`)), ...(input.fetcher ? { fetcher: input.fetcher } : {}) })
  if (data === null) return null

  const versionId = sanitizeTerminalText(String(data[`${input.kind}_version_id`] || 'unknown version'))
  const commit = sanitizeTerminalText(String(data.commit_sha || 'unknown commit')).slice(0, 12)
  const message = appendRegistrationTagWarning(
    `Pushed ${input.kind} ${sanitizeTerminalText(input.name)} as draft ${versionId} ` +
      `(commit ${commit}); it seals when the session branch merges`,
    data
  )
  return { data, message }
}
