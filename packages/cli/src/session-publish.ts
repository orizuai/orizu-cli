/** ORI-2653: `orizu session publish`. In a hosted session, `git push` reaches
 * only the session's own copy; this command saves the work there, then asks the
 * web app to merge that commit into the team's main (the publish merge job app
 * publishing already uses). It says "Published" only when the merge landed. */
import { spawnSync } from 'node:child_process'

import { isValidCloudflareArtifactsGitRemote } from './cloudflare-artifacts-git-remote.js'
import { authedFetch } from './http.js'
import { sanitizeTerminalText } from './json-response.js'
import { findWorkspaceRoot } from './workspace.js'

const DEFAULT_MESSAGE = 'Publish from session'
// The web app waits up to 100 s for the merge; leave room for the reply.
const PUBLISH_TIMEOUT_MS = 170_000
// The codes the publish route words itself; their text already says what to do.
const PUBLISH_CODES = new Set(['publish_conflict', 'publish_race_lost', 'publish_still_running', 'publish_denied', 'publish_unavailable', 'publish_failed'])
const CHECK_AGAIN = 'It may have landed: wait a moment, then run `orizu session publish` again to check.'
// ORI-2373 M3: what a stop (Ctrl-C, or SIGTERM from the agent's harness) leaves.
const STOPPED_WHILE_SAVING = "Not published: stopped while saving to the session copy. Nothing was sent to the team's main. Run `orizu session publish` again."
const STOPPED_BEFORE_REMOTE = 'Stopped before the orizu-team remote was added: run `orizu session publish` again to add it.'
const STOPPED_BEFORE_ANSWER = `Not confirmed: stopped before Orizu answered. Your work is saved in this session's copy. ${CHECK_AGAIN}`

export interface SessionPublishIo {
  json: boolean
  print: (line: string) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function loadAppPublishWorkspace() {
  return import('./app-publish-workspace.js')
}

/** Every answer that is not a confirmed merge: its text already leads with
 * "Not published" or "Not confirmed" and ends with what to do. */
function refuse(io: SessionPublishIo, text: string, code: string): number {
  const safe = sanitizeTerminalText(text)
  io.print(io.json ? JSON.stringify({ error: safe, code }) : safe)
  return 1
}

/** A stop: the same answer shape, with the shell's exit code for the signal. */
function answerStop(io: SessionPublishIo, text: string, code: string, exitCode: 130 | 143): number {
  refuse(io, text, code)
  return exitCode
}

/** True when `origin` is this session's own Artifacts copy. In an older
 * GitHub-backed session `origin` is the team's repository itself, where a push
 * of main would skip the merge and its checks. Reads the configured URL, not
 * one rewritten by git's `insteadOf`. */
function originIsThisSessionCopy(root: string, sessionId: string): boolean {
  const read = spawnSync('git', ['config', '--get', 'remote.origin.url'], { cwd: root, encoding: 'utf8' })
  const remote = read.status === 0 ? read.stdout.trim() : ''
  return isValidCloudflareArtifactsGitRemote(remote) &&
    new URL(remote).pathname.endsWith(`/hosted-session-${sessionId.replaceAll('-', '')}.git`)
}

/** Ctrl-C, or SIGTERM from the agent's harness, stops the whole command
 * (ORI-2373 M3), the way cli-stops' runWithStops does for Effect programs:
 * `once`, so a second signal falls through to Node's default kill. Each step
 * gets the stop signal and words what the stop left. Plain listeners, so they
 * are in place before anything loads. */
export async function runSessionPublish(io: SessionPublishIo, options: { message?: string | null } = {}): Promise<number> {
  const controller = new AbortController()
  let stop: 130 | 143 | undefined
  const handleInterrupt = () => { stop ??= 130; controller.abort() }
  const handleTerminate = () => { stop ??= 143; controller.abort() }
  process.once('SIGINT', handleInterrupt)
  process.once('SIGTERM', handleTerminate)
  try {
    return await publish(io, options, controller.signal, () => stop)
  } finally {
    process.removeListener('SIGINT', handleInterrupt)
    process.removeListener('SIGTERM', handleTerminate)
  }
}

async function publish(io: SessionPublishIo, options: { message?: string | null }, signal: AbortSignal, stopped: () => 130 | 143 | undefined): Promise<number> {
  const sessionId = process.env.ORIZU_SESSION_ID?.trim()
  const root = sessionId ? findWorkspaceRoot(process.cwd()) : null
  if (!sessionId || !root) {
    return refuse(io, 'Not published: orizu session publish runs inside a hosted session, from its workspace. In your own clone, push to your team repository instead.', 'publish_not_hosted')
  }
  if (!originIsThisSessionCopy(root, sessionId)) {
    return refuse(io, "Not published: this workspace's origin is not this session's own copy, so publishing from here could write to the team's repository directly. Stop and tell the user.", 'publish_not_session_copy')
  }

  const { addTeamCopyRemote, pushSessionCopy } = await loadAppPublishWorkspace()
  let pushed: Awaited<ReturnType<typeof pushSessionCopy>> | undefined
  try {
    if (!stopped()) pushed = await pushSessionCopy(root, options.message?.trim() || DEFAULT_MESSAGE, signal)
  } catch (error) {
    if (!stopped()) return refuse(io, `Not published: ${error instanceof Error ? error.message : String(error)}`, 'publish_not_sent')
  }
  // Nothing has been sent yet, so a stop up to here is "Not published".
  const stopBeforeSend = stopped()
  if (stopBeforeSend || !pushed) return answerStop(io, STOPPED_WHILE_SAVING, 'publish_not_sent', stopBeforeSend ?? 130)

  // Sent once: a stop from here on can't tell whether the merge ran.
  let response: Response
  let text: string
  try {
    response = await authedFetch(`/api/cli/sessions/${encodeURIComponent(sessionId)}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionCommitSha: pushed.sha }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(PUBLISH_TIMEOUT_MS)]),
    })
  } catch (error) {
    const stop = stopped()
    if (stop) return answerStop(io, STOPPED_BEFORE_ANSWER, 'publish_interrupted', stop)
    return refuse(io, `Not confirmed: could not reach Orizu (${error instanceof Error ? error.message : String(error)}). Your work is saved in this session's copy. ${CHECK_AGAIN}`, 'publish_unreachable')
  }
  try {
    text = await response.text()
  } catch (error) {
    const stop = stopped()
    if (stop) return answerStop(io, STOPPED_BEFORE_ANSWER, 'publish_interrupted', stop)
    // The merge may have run before the answer was cut off.
    return refuse(io, `Not confirmed: could not read the answer from Orizu (${error instanceof Error ? error.message : String(error)}). Your work is saved in this session's copy. ${CHECK_AGAIN}`, 'publish_unreachable')
  }
  // Once the answer is in hand it is reported as it came, even after a stop.
  let body: unknown = null
  try {
    body = JSON.parse(text)
  } catch {
    // An answer that is not JSON is reported below as it came.
  }

  if (response.ok && isRecord(body) && (body.outcome === 'merged' || body.outcome === 'already_merged') && typeof body.sha === 'string') {
    const sha = sanitizeTerminalText(body.sha)
    if (io.json) {
      io.print(JSON.stringify({ outcome: body.outcome, sha }))
    } else if (body.outcome === 'merged') {
      const files = pushed.committed.map(file => `\n  ${sanitizeTerminalText(file)}`).join('')
      io.print(`Published: merged into the team's main as ${sha.slice(0, 7)}. New sessions on this project will see it.${files ? `\nCommitted first:${files}` : ''}`)
    } else {
      io.print(`Already on the team's main (${sha.slice(0, 7)}). Nothing new to publish.`)
    }
    return 0
  }

  if (isRecord(body) && typeof body.error === 'string' && typeof body.code === 'string' && PUBLISH_CODES.has(body.code)) {
    const code = body.code
    let message = body.error
    if (code === 'publish_conflict') {
      let remoteNote: string | null
      try {
        remoteNote = await addTeamCopyRemote(root, signal)
      } catch (error) {
        const stop = stopped()
        if (!stop) throw error
        // Its own line: the recovery line above must stay a runnable command.
        return answerStop(io, `${message}\n${STOPPED_BEFORE_REMOTE}`, code, stop)
      }
      // Its own line: the recovery line above must stay a runnable command.
      if (remoteNote) message = `${message}\n${remoteNote}`
    }
    return refuse(io, message, code)
  }
  // Any other answer is not worded for this command. A 4xx refused the request
  // before any merge; a 5xx, or a 2xx that is not the route's answer, may have
  // come after one.
  const said = sanitizeTerminalText(isRecord(body) && typeof body.error === 'string' ? body.error : text.slice(0, 300))
  if (response.status >= 400 && response.status < 500) {
    return refuse(io, `Not published: Orizu refused the request (${response.status}: ${said}). Stop and tell the user.`, `http_${response.status}`)
  }
  return refuse(io, `Not confirmed: Orizu answered ${response.status} (${said}). ${CHECK_AGAIN}`, `http_${response.status}`)
}
