#!/usr/bin/env node
/** ORI-2248: delete a snapshot the bake's start check rejected, best-effort.
 * Nothing ever uses it (a failed bake job is re-run whole, which bakes a fresh
 * one), and every bake snapshot never expires, so left behind it would take one
 * of cleanup's retention slots. The bake runs this only after the start check
 * rejected the id, and it never deletes the id the
 * coordinator currently serves (or when that can't be read). It reuses the
 * cleanup script's SDK path and readiness read.
 *
 * Usage: bun delete-rejected-snapshot.mjs --snapshot <snap_…>
 *   [--coordinator-url <origin>]   default: ORIZU_COORDINATOR_URL in wrangler.toml
 * Credentials come from VERCEL_TOKEN (or VERCEL_OIDC_TOKEN), VERCEL_PROJECT_ID
 * and VERCEL_TEAM_ID. Exit 0 whether or not it deleted (a failure is a
 * ::warning, so the release's own failure stays the one to read); 2 = bad input. */

import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

import { COORDINATOR_URL_RULE, defaultLoadSdk, isAllowedCoordinatorUrl, parseCoordinatorUrl, readCurrentSnapshotIds, WRANGLER_TOML_PATH } from './gc-snapshots.mjs'
import { resolveCredsOrFail } from './provision-snapshot.mjs'

const SNAPSHOT_RE = /^snap_[A-Za-z0-9]+$/
const message = error => (error instanceof Error ? error.message : String(error))

export async function deleteRejectedSnapshot(argv = process.argv.slice(2), env = process.env, out = s => process.stdout.write(s), errOut = s => process.stderr.write(s)) {
  const usage = text => { errOut(`error: ${text}\n`); return 2 }
  let values
  try { ({ values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: { snapshot: { type: 'string' }, 'coordinator-url': { type: 'string' } } })) }
  catch (error) { return usage(message(error)) }
  const snapshot = values.snapshot ?? ''
  if (!SNAPSHOT_RE.test(snapshot)) return usage(`--snapshot must be a snapshot id like snap_abc123, got "${snapshot}"`)
  let origin = values['coordinator-url']
  if (origin === undefined) {
    try { origin = parseCoordinatorUrl(readFileSync(WRANGLER_TOML_PATH, 'utf8')) } catch (error) { return usage(`cannot read ${WRANGLER_TOML_PATH}: ${message(error)}`) }
  }
  if (!origin || !isAllowedCoordinatorUrl(origin)) return usage(`--coordinator-url ${COORDINATOR_URL_RULE} (got "${origin ?? ''}")`)
  const missing = []
  const creds = resolveCredsOrFail(env, text => missing.push(text))
  if (missing.length) return usage(missing.join('; '))

  const warn = text => { errOut(`::warning title=Rejected snapshot not deleted::${text}\n`); return 0 }
  const current = await readCurrentSnapshotIds({ origin, fetch: globalThis.fetch, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) })
  if (!current.ok) return warn(`${snapshot} kept: cannot confirm it is not the current snapshot (${current.error})`)
  if (current.ids.includes(snapshot)) return warn(`${snapshot} kept: the coordinator currently serves ${snapshot}`)
  try {
    const sdk = await defaultLoadSdk()
    const found = await sdk.Snapshot.get({ snapshotId: snapshot, token: creds.token, projectId: creds.projectId, teamId: creds.teamId })
    await found.delete()
  } catch (error) {
    return warn(`${snapshot} kept: delete failed (${message(error)})`)
  }
  out(`deleted ${snapshot}\n`)
  return 0
}

if (import.meta.main) process.exitCode = await deleteRejectedSnapshot()
