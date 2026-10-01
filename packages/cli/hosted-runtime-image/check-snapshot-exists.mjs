#!/usr/bin/env node
/** ORI-2239: check a snapshot id exists on Vercel with status `created` before
 * the rollback workflow makes it current. Anything else, including an API
 * error, refuses it: a rollback must never point the coordinator at a snapshot
 * nobody could confirm. It reuses the cleanup script's SDK path.
 *
 * Usage: bun check-snapshot-exists.mjs --snapshot <snap_…>
 * Credentials come from VERCEL_TOKEN (or VERCEL_OIDC_TOKEN), VERCEL_PROJECT_ID
 * and VERCEL_TEAM_ID. Exit 0 = exists and created; 1 = refused (::error says
 * why); 2 = bad input, before any request. */

import { parseArgs } from 'node:util'

import { defaultLoadSdk } from './gc-snapshots.mjs'
import { resolveCredsOrFail } from './provision-snapshot.mjs'

const SNAPSHOT_RE = /^snap_[A-Za-z0-9]+$/
const message = error => (error instanceof Error ? error.message : String(error))

export async function checkSnapshotExists(argv = process.argv.slice(2), env = process.env, out = s => process.stdout.write(s), errOut = s => process.stderr.write(s)) {
  const usage = text => { errOut(`error: ${text}\n`); return 2 }
  let values
  try { ({ values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: { snapshot: { type: 'string' } } })) }
  catch (error) { return usage(message(error)) }
  const snapshot = values.snapshot ?? ''
  if (!SNAPSHOT_RE.test(snapshot)) return usage(`--snapshot must be a snapshot id like snap_abc123, got "${snapshot}"`)
  const missing = []
  const creds = resolveCredsOrFail(env, text => missing.push(text))
  if (missing.length) return usage(missing.join('; '))

  const refuse = text => { errOut(`::error title=Snapshot not usable::${text}\n`); return 1 }
  let status
  try {
    const sdk = await defaultLoadSdk()
    const found = await sdk.Snapshot.get({ snapshotId: snapshot, token: creds.token, projectId: creds.projectId, teamId: creds.teamId })
    status = found.status
  } catch (error) {
    return refuse(`could not confirm ${snapshot} exists on Vercel (${message(error)}); nothing was changed`)
  }
  if (status !== 'created') return refuse(`${snapshot} has status "${status}" on Vercel (expected "created"); nothing was changed`)
  out(`${snapshot} exists on Vercel (status created)\n`)
  return 0
}

if (import.meta.main) process.exitCode = await checkSnapshotExists()
