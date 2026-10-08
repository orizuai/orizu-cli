/** ORI-2280 (2280-B2): in a hosted session, an app is published from git. The
 * CLI writes the app into its folder in the workspace, commits those three files
 * alone, and pushes the session copy; the web app then merges that commit into
 * the team copy before it records the version. Written with Effect: git, the
 * files and the web app are services, and each way this can stop is a tagged
 * failure. It holds no key (the clone's credential helper asks for one per git
 * command) and makes no temporary folder, so it has nothing to scope. */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Context, Data, Effect, Layer } from 'effect'

import { isValidCloudflareArtifactsGitRemote } from './cloudflare-artifacts-git-remote.js'
import { AppPublishFailure } from './app-publish-failure.js'
import { inspectAppDestination } from './app-publish-paths.js'
import { resolveAttachedWorkspaceId } from './git-credential.js'
import { authedFetch, getBaseUrl } from './http.js'

/** The session copy's branch, which the publish merge reads (ORI-2279). */
const SESSION_BRANCH_REF = 'refs/heads/main'
const TEAM_REMOTE_NAME = 'orizu-team'
const PROJECT_SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/
const APP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Where an app lives in the team repository. */
function appFolder(projectSlug: string, appId: string): string {
  if (!PROJECT_SLUG.test(projectSlug)) throw new Error(`Invalid project slug for the app folder: ${projectSlug}`)
  if (!APP_ID.test(appId)) throw new Error(`Invalid app id for the app folder: ${appId}`)
  return `projects/${projectSlug}/apps/${appId}`
}

export interface AppFiles {
  readonly sourceCode: string
  readonly inputSchema: string
  readonly outputSchema: string
}

// -- Failures --------------------------------------------------------------------

class PushRejected extends Data.TaggedError('PushRejected') {}
class GitFailed extends Data.TaggedError('GitFailed')<{ step: string; detail: string }> {}
class TeamRemoteUnavailable extends Data.TaggedError('TeamRemoteUnavailable')<{ reason: string }> {}

// -- Services --------------------------------------------------------------------

interface GitResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

class WorkspaceGit extends Context.Service<WorkspaceGit, { readonly run: (args: readonly string[]) => Effect.Effect<GitResult> }>()('WorkspaceGit') {}
class WorkspaceFiles extends Context.Service<WorkspaceFiles, { readonly write: (files: readonly { path: string; content: string }[]) => Effect.Effect<void, GitFailed> }>()('WorkspaceFiles') {}
class PublishApi extends Context.Service<PublishApi, { readonly teamReadRemote: (workspaceId: string) => Effect.Effect<string, TeamRemoteUnavailable>; readonly teamRemoteHelper: string }>()('PublishApi') {}

function liveLayer(root: string, attempt?: { filesMaterialized: boolean }) {
  const serverOrigin = getBaseUrl()
  const teamRemoteHelper = `!orizu --server '${serverOrigin.replace(/'/g, "'\\''")}' git-credential --purpose=team_read`
  const git = WorkspaceGit.of({
    run: (args) =>
      Effect.callback<GitResult>((resume) => {
        const child = spawn('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk) => (stdout += chunk))
        child.stderr.on('data', (chunk) => (stderr += chunk))
        child.on('error', (error) => resume(Effect.succeed({ code: 127, stdout, stderr: error.message })))
        child.on('close', (code) => resume(Effect.succeed({ code: code ?? 1, stdout, stderr })))
      }),
  })
  const files = WorkspaceFiles.of({
    write: (files) =>
      Effect.try({
        try: () => {
          for (const file of files) inspectAppDestination(root, file.path)
          for (const file of files) {
            mkdirSync(join(root, file.path, '..'), { recursive: true })
            writeFileSync(join(root, file.path), file.content)
          }
          if (attempt) attempt.filesMaterialized = true
        },
        catch: (error) => new GitFailed({ step: 'write the app files', detail: String(error) }),
      }),
  })
  const api = PublishApi.of({
    teamRemoteHelper,
    teamReadRemote: (workspaceId) =>
      Effect.tryPromise({
        try: async (signal) => {
          const response = await authedFetch(`/api/cli/workspaces/${encodeURIComponent(workspaceId)}/repo-token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Orizu-Session-Seed-Protocol': '1' },
            body: JSON.stringify({ purpose: 'team_read', sessionId: process.env.ORIZU_SESSION_ID?.trim() }),
            signal,
          })
          if (!response.ok) throw new Error(`the repository key service answered ${response.status}`)
          const remote = ((await response.json()) as { remote?: unknown }).remote
          if (!isValidCloudflareArtifactsGitRemote(remote)) throw new Error('the repository key service named no team copy')
          return remote
        },
        catch: (error) => new TeamRemoteUnavailable({ reason: error instanceof Error ? error.message : String(error) }),
      }),
  })
  return Layer.mergeAll(Layer.succeed(WorkspaceGit, git), Layer.succeed(WorkspaceFiles, files), Layer.succeed(PublishApi, api))
}

const gitOrFail = (step: string, args: readonly string[]) =>
  Effect.flatMap(WorkspaceGit, (git) => git.run(args)).pipe(
    Effect.filterOrFail(
      (result) => result.code === 0,
      (result) => new GitFailed({ step, detail: (result.stderr || result.stdout).trim() })
    )
  )

// -- Commit and push -------------------------------------------------------------

/** Writes the app into its folder, commits those three files alone (other work in
 * the workspace stays as it is), and pushes the session copy. Answers the
 * commit the web app should publish: the new one, or HEAD if nothing changed. */
const commitAndPush = (folder: string, files: AppFiles, appId: string) =>
  Effect.gen(function* () {
    const workspaceFiles = yield* WorkspaceFiles
    yield* workspaceFiles.write([
      { path: `${folder}/App.tsx`, content: files.sourceCode },
      { path: `${folder}/input.schema.json`, content: files.inputSchema },
      { path: `${folder}/output.schema.json`, content: files.outputSchema },
    ])
    const paths = ['App.tsx', 'input.schema.json', 'output.schema.json'].map(filename => `${folder}/${filename}`)
    yield* gitOrFail('stage the app files', ['add', '--', ...paths])
    const git = yield* WorkspaceGit
    // Exit 1: the three app files differ from HEAD.
    const changed = yield* git.run(['diff', '--cached', '--quiet', 'HEAD', '--', ...paths])
    if (changed.code === 1) {
      yield* gitOrFail('commit the app files', ['commit', '-q', '-m', `Publish app ${appId}`, '--', ...paths])
    } else if (changed.code !== 0) {
      return yield* new GitFailed({ step: 'compare the app folder', detail: changed.stderr.trim() })
    }
    const sha = (yield* gitOrFail('read the commit', ['rev-parse', 'HEAD'])).stdout.trim()
    const pushed = yield* git.run(['push', '-q', 'origin', `HEAD:${SESSION_BRANCH_REF}`])
    if (pushed.code !== 0) {
      if (/\[rejected\]|non-fast-forward|fetch first/.test(pushed.stderr)) return yield* new PushRejected()
      return yield* new GitFailed({ step: 'push the session copy', detail: pushed.stderr.trim() })
    }
    return sha
  })

/** Commits and pushes the app, answering the commit to publish. Throws the
 * message the agent should act on. */
export async function pushAppToSessionCopy(root: string, input: { projectSlug: string; appId: string; files: AppFiles }): Promise<string> {
  const program = commitAndPush(appFolder(input.projectSlug, input.appId), input.files, input.appId).pipe(
    Effect.catchTags({
      PushRejected: () =>
        Effect.fail(new Error('Publish stopped: your session copy has commits this workspace does not. Run "git pull --no-rebase --no-edit" in the workspace, then run this command again.')),
      GitFailed: (failure) => Effect.fail(new Error(`Publish stopped before anything was sent: could not ${failure.step} (${failure.detail}).`)),
    })
  )
  const attempt = { filesMaterialized: false }
  try {
    return await Effect.runPromise(Effect.provide(program, liveLayer(root, attempt)))
  } catch (error) {
    throw new AppPublishFailure(error instanceof Error ? error.message : String(error), attempt.filesMaterialized)
  }
}

// -- The team copy, after a conflict ---------------------------------------------

/** Adds the `orizu-team` remote so the agent can pull the team copy and fix a
 * conflict. It reads with its own team_read key: an empty helper entry first
 * stops the session copy's helper from answering for it. Refreshes the URL and
 * helper each time so interrupted recovery or an old remote is repaired. */
const addTeamRemote = (workspaceId: string | null) =>
  Effect.gen(function* () {
    const git = yield* WorkspaceGit
    const hasRemote = (yield* git.run(['remote', 'get-url', TEAM_REMOTE_NAME])).code === 0
    if (!workspaceId) return yield* new TeamRemoteUnavailable({ reason: 'this workspace names no Orizu workspace id' })
    const api = yield* PublishApi
    const remote = yield* api.teamReadRemote(workspaceId)
    const failed = (step: string) => (failure: GitFailed) => new TeamRemoteUnavailable({ reason: `${step}: ${failure.detail}` })
    const remoteAction = hasRemote ? 'set-url' : 'add'
    yield* gitOrFail(remoteAction, ['remote', remoteAction, TEAM_REMOTE_NAME, remote]).pipe(Effect.mapError(failed(`git remote ${remoteAction}`)))
    const cleared = yield* git.run(['config', '--unset-all', `credential.${remote}.helper`])
    // Git exits 5 when there was no matching key, which is normal on first use.
    if (cleared.code !== 0 && cleared.code !== 5) {
      return yield* new TeamRemoteUnavailable({ reason: `git config: ${(cleared.stderr || cleared.stdout).trim()}` })
    }
    for (const [operation, key, value] of [
      ['--add', `credential.${remote}.helper`, ''],
      ['--add', `credential.${remote}.helper`, api.teamRemoteHelper],
      ['--replace-all', `credential.${remote}.useHttpPath`, 'true'],
    ] as const) {
      yield* gitOrFail('config', ['config', operation, key, value]).pipe(Effect.mapError(failed('git config')))
    }
  })

/** Adds the team copy remote; answers a sentence to add to the conflict
 * message when it could not, else null. */
export function addTeamCopyRemote(root: string): Promise<string | null> {
  const workspaceId = process.env.ORIZU_WORKSPACE_ID?.trim() || resolveAttachedWorkspaceId(root)
  const program = addTeamRemote(workspaceId).pipe(
    Effect.as(null),
    Effect.catchTag('TeamRemoteUnavailable', (failure) =>
      Effect.succeed(`The ${TEAM_REMOTE_NAME} remote could not be added (${failure.reason}); add it with "git remote add ${TEAM_REMOTE_NAME} <team copy>".`)
    )
  )
  return Effect.runPromise(Effect.provide(program, liveLayer(root)))
}
