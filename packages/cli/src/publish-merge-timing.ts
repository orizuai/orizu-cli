/** ORI-2280: the publish merge job's wall, shared by the coordinator, which
 * stops the sandbox at it, and the CLI job, which must report before it. No
 * Node or Worker imports: both sides compile this file. */

/** From the coordinator creating the job to it stopping the sandbox. */
export const PUBLISH_MERGE_COORDINATOR_WALL_MS = 2 * 60 * 1000
/** The coordinator sets this on the sandbox to `createdAt + PUBLISH_MERGE_COORDINATOR_WALL_MS`, in epoch milliseconds. */
export const PUBLISH_MERGE_WALL_AT_ENV = 'ORIZU_PUBLISH_MERGE_WALL_AT'

/** A conflict result names at most this many paths, each at most
 * PUBLISH_MERGE_CONFLICT_PATH_MAX characters, and counts the rest, so the
 * result always fits the coordinator's result body limit. */
export const PUBLISH_MERGE_CONFLICT_FILES_LIMIT = 200
export const PUBLISH_MERGE_CONFLICT_PATH_MAX = 1024

/** The failure codes the sandbox may report. The coordinator's own codes
 * (`timed_out`, `provider_unavailable`, `snapshot_missing_command`, ...) are
 * not among them, so a reported failure always says which side saw it. */
export const PUBLISH_MERGE_JOB_FAILURE_CODES = [
  'scope_refused',
  'admission_refused',
  'credentials_pending',
  'api_unavailable',
  'job_timed_out',
  'publish_failed',
] as const
export type PublishMergeJobFailureCode = (typeof PUBLISH_MERGE_JOB_FAILURE_CODES)[number]
