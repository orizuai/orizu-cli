/** ORI-2280: the publish merge job's wall, shared by the coordinator, which
 * stops the sandbox at it, and the CLI job, which must report before it. No
 * Node or Worker imports: both sides compile this file. */

/** From the coordinator creating the job to it stopping the sandbox. */
export const PUBLISH_MERGE_COORDINATOR_WALL_MS = 2 * 60 * 1000
/** The coordinator sets this on the sandbox to `createdAt + PUBLISH_MERGE_COORDINATOR_WALL_MS`, in epoch milliseconds. */
export const PUBLISH_MERGE_WALL_AT_ENV = 'ORIZU_PUBLISH_MERGE_WALL_AT'
