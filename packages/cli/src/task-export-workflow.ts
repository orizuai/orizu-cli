import { Effect, Exit, Result } from 'effect'
import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { authedFetch } from './http.js'

export type TaskExportFormat = 'csv' | 'json' | 'jsonl'

// Node's "CODE: description, syscall 'path'" without the syscall and path, so a
// failed save names the user's target rather than the temp file.
function saveFailureReason(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  return message.replace(/, \w+( '.*')?$/, '')
}

/**
 * Writes the export beside `target` and renames it over the target, so a failed
 * or interrupted save never touches the file the user already has. The temp file
 * is removed whenever the save does not finish.
 */
function saveExportFile(target: string, bytes: Uint8Array) {
  const temp = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`)
  return Effect.acquireUseRelease(
    Effect.succeed(temp),
    path => Effect.try({
      try: () => {
        writeFileSync(path, bytes, { flag: 'wx' })
        renameSync(path, target)
      },
      catch: cause => new Error(`Could not save export to ${target}: ${saveFailureReason(cause)}`, { cause }),
    }),
    (path, exit) => Exit.isSuccess(exit) ? Effect.void : Effect.sync(() => rmSync(path, { force: true }))
  )
}

/**
 * `orizu tasks export`: one GET of the export, never retried, then a safe save.
 * A refused export fails with `Download failed: <body>` before anything is written.
 */
function downloadTaskExport(taskId: string, format: TaskExportFormat, target: string) {
  return Effect.gen(function* () {
    const response = yield* Effect.promise(() => authedFetch(`/api/cli/tasks/${taskId}/export?format=${format}`))
    if (!response.ok) {
      const body = yield* Effect.promise(() => response.text())
      return yield* Effect.fail(new Error(`Download failed: ${body}`))
    }
    const bytes = new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()))
    yield* saveExportFile(target, bytes)
  })
}

/** Promise runner for the command: rejects with the message the CLI prints. */
export async function runTaskExportDownload(taskId: string, format: TaskExportFormat, target: string): Promise<void> {
  const result = await Effect.runPromise(Effect.result(downloadTaskExport(taskId, format, target)))
  if (Result.isFailure(result)) throw result.failure
}
