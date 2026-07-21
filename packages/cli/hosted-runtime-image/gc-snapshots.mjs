#!/usr/bin/env node
/**
 * GC old hosted-runtime Vercel Sandbox snapshots — keep-newest-K (ALI-1170).
 *
 * Every `cli-v*` release bakes a snapshot with `--expiration 0` (never expire;
 * DELIBERATE — a finite TTL could expire the LIVE pinned snapshot during a slow
 * release stretch) and nothing deleted the old ones, so they accumulated
 * without bound. This script is the CI-side counterweight, run by
 * publish-cli.yml AFTER the bake + Worker deploy succeed:
 *
 *   survivors = newest K 'created' snapshots ∪ every pinned id   (K default 3)
 *   'failed' bakes are ALWAYS deleted (they never consume a retention slot);
 *   'deleted' tombstones are ignored; everything else 'created' is deleted.
 *
 * The pinned id(s) are read from workers/session-coordinator/wrangler.toml
 * (`ORIZU_HOSTED_SNAPSHOT = "…"` — the same anchored var shape publish-cli.yml
 * rewrites) and survive REGARDLESS of age — belt-and-braces so a stalled
 * release cadence can never GC the snapshot production is booting from.
 *
 * FAIL-CLOSED ORCHESTRATION — this tool deletes; every ambiguity aborts with
 * ZERO deletions:
 *   - EXPECTED-PROJECT GUARD: the resolved VERCEL_PROJECT_ID must equal
 *     gc-config.json's expectedProjectId BEFORE any API call — wrong-project
 *     credentials can never GC an unrelated project. GC only ever runs against
 *     the dedicated hosted-runtime snapshot project.
 *   - PIN LIVENESS: after the COMPLETE listing, every pinned id must be
 *     present with status 'created' (absent / failed / deleted pin → abort);
 *     an entirely EMPTY inventory (flaky API) also aborts — the deployed pin
 *     must exist, so an empty list is never trustworthy.
 *   - INVENTORY INTEGRITY: rows are merged by id; identical repeats across
 *     page boundaries are deduped (overlap window), but a duplicate id with
 *     CONFLICTING fields aborts. A repeated pagination cursor aborts (no
 *     loops). Hitting the page cap with a next cursor still present aborts —
 *     never GC a knowingly-partial inventory.
 *   - STATUS ALLOWLIST: any status outside created/failed/deleted aborts (the
 *     SDK's Zod contract made this implicit; a destructive tool makes it
 *     explicit so upstream drift fails closed).
 *   - STRICT ARGV: unknown options, positionals, `--key=value` syntax, or a
 *     missing --keep value are rejected — a `--dryrun` typo must never cause
 *     a real run.
 *
 * SDK CONTRACT (verified against @vercel/sandbox@1.10.2 dist):
 *   - `Snapshot.list({ token, teamId, projectId, limit?, since?, until? })`
 *     → GET /v1/sandboxes/snapshots?project=… ; resolves to a `Parsed` whose
 *     `.json` is `{ snapshots: [{ id, status, createdAt, … }], pagination:
 *     { count, next, prev } }`. Explicit creds in params take precedence over
 *     the OIDC fallback (get-credentials.js), so plain VERCEL_TOKEN /
 *     VERCEL_PROJECT_ID / VERCEL_TEAM_ID env creds work — same as the
 *     provider. NOTE: `next` being a timestamp cursor to feed back as `until`
 *     is an ASSUMPTION from the d.ts field types (`since`/`until` are
 *     timestamps, `next: number | null`), not a documented contract — the
 *     abort guards above contain the blast radius if it is wrong.
 *   - `Snapshot.get({ snapshotId, token, teamId, projectId })` then
 *     `.delete()` → DELETE /v1/sandboxes/snapshots/:id — the SDK's only
 *     public delete path (delete is an instance method; list returns plain
 *     metadata objects, not instances).
 *
 * FAIL-OPEN FOR THE RELEASE: this process exits nonzero on any abort or API
 * error, but the publish-cli.yml step wrapping it is `continue-on-error` + a
 * `::warning` annotation — the release (bake + deploy) already succeeded and
 * must never be failed retroactively by GC.
 *
 * Usage (CI or founder-run; needs VERCEL_TOKEN / VERCEL_PROJECT_ID /
 * VERCEL_TEAM_ID; run with bun from the repo checkout after
 * `bun install --cwd packages/cli`, same as provision-snapshot.mjs):
 *
 *   bun packages/cli/hosted-runtime-image/gc-snapshots.mjs \
 *     [--keep <K>] [--dry-run]
 *
 *   --keep     how many newest 'created' snapshots survive (default 3, int >= 1)
 *   --dry-run  print the deletion plan without deleting anything
 *
 * SECURITY: credentials are read from env and NEVER printed — logs carry
 * snapshot ids and counts only (a Vercel project id is an identifier, not a
 * credential).
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveCredsOrFail } from './provision-snapshot.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Where the live pinned snapshot id is recorded (repo-relative). */
export const WRANGLER_TOML_PATH = resolve(HERE, '..', '..', '..', 'workers', 'session-coordinator', 'wrangler.toml')
/** The checked-in expected-project guard config (non-secret). */
export const GC_CONFIG_PATH = resolve(HERE, 'gc-config.json')

export const DEFAULT_KEEP = 3
/** Page size for Snapshot.list (SDK forwards it as the `limit` query param). */
const LIST_PAGE_LIMIT = 100
/** Hard cap on list pages — hitting it with more pages remaining ABORTS. */
const LIST_MAX_PAGES = 50
/** The full status vocabulary of @vercel/sandbox@1.10.2's Zod validator
 *  (`status: "failed" | "created" | "deleted"`) — explicit here so upstream
 *  drift aborts the GC instead of silently misclassifying a snapshot. */
const KNOWN_STATUSES = new Set(['created', 'failed', 'deleted'])

// -- Pure selection logic -----------------------------------------------------

/**
 * Keep-newest-K selection (PURE — no I/O). Given the retention candidates
 * (the orchestrator passes only status-'created' snapshots), return the ids to
 * DELETE, oldest first:
 *
 *   - the newest `keep` snapshots by `createdAt` always survive;
 *   - every id in `pinnedIds` ALWAYS survives, regardless of age
 *     (belt-and-braces: the pin is what production boots from);
 *   - `createdAt` ties are broken by id (higher id ranks newer) so the
 *     ordering is total and the result deterministic regardless of input
 *     order.
 *
 * `keep: 0` is honoured (deletes everything except pinned) so the function's
 * contract is defensively total; the CLI wrapper enforces keep >= 1.
 */
export function selectSnapshotIdsToDelete({ snapshots, pinnedIds, keep }) {
  const pinned = new Set(pinnedIds)
  const newestFirst = [...snapshots].sort(
    (a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
  )
  return newestFirst
    .slice(keep)
    .filter(s => !pinned.has(s.id))
    .map(s => s.id)
    .reverse()
}

// -- Strict CLI parsing -------------------------------------------------------

/**
 * STRICT argv parsing — this tool deletes, so anything not understood is an
 * error, never a silent default: unknown options (`--dryrun`), positionals,
 * `--key=value` syntax, and a missing `--keep` value are all rejected.
 * Returns `{ ok: true, keep, dryRun }` or `{ ok: false, error }`.
 */
export function parseGcArgs(argv) {
  let keep = DEFAULT_KEEP
  let dryRun = false
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--dry-run') {
      dryRun = true
    } else if (token === '--keep') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('-')) {
        return { ok: false, error: '--keep requires a value (an integer >= 1)' }
      }
      if (!/^[0-9]+$/.test(value) || Number(value) < 1) {
        return { ok: false, error: `--keep must be an integer >= 1 (got "${value}")` }
      }
      keep = Number(value)
      i += 1
    } else {
      return {
        ok: false,
        error: `unrecognized argument "${token}" — allowed: --keep <n>, --dry-run (no --key=value syntax)`,
      }
    }
  }
  return { ok: true, keep, dryRun }
}

// -- Pinned-id extraction -----------------------------------------------------

/**
 * Every `ORIZU_HOSTED_SNAPSHOT = "…"` value in the wrangler.toml text — the
 * same anchored line shape publish-cli.yml's bump step rewrites. All
 * occurrences are collected so a future env-scoped pin also survives GC.
 */
export function parsePinnedSnapshotIds(tomlText) {
  const ids = []
  for (const match of tomlText.matchAll(/^ORIZU_HOSTED_SNAPSHOT = "([^"]*)"$/gm)) {
    if (match[1]) ids.push(match[1])
  }
  return ids
}

// -- Default (real) dependency loaders ----------------------------------------

/** Real SDK loader — lazy so tests injecting a fake never touch the package. */
async function defaultLoadSdk() {
  // Assembled specifier (same discipline as vercel-sandbox-provider.ts) so no
  // bundler that ever reaches this file can constant-fold a static dependency.
  const specifier = ['@vercel', 'sandbox'].join('/')
  const mod = await import(specifier)
  if (typeof mod?.Snapshot?.list !== 'function' || typeof mod?.Snapshot?.get !== 'function') {
    throw new Error('@vercel/sandbox did not export Snapshot.list/get — re-verify the SDK pin (see header contract)')
  }
  return mod
}

function defaultReadPinnedToml() {
  return readFileSync(WRANGLER_TOML_PATH, 'utf8')
}

function defaultReadGcConfig() {
  return readFileSync(GC_CONFIG_PATH, 'utf8')
}

/**
 * Key-order-stable FULL-ROW serialization for the conflicting-duplicate check:
 * sorted [key, value] pairs, so differing key sets always compare unequal and
 * top-level key order never matters. (A `JSON.stringify(row, keys)` replacer
 * array would filter NESTED keys through the same top-level allowlist —
 * genuinely different nested values could compare equal.) Nested objects are
 * serialized verbatim, so a nested key REORDER can still read as a conflict —
 * that direction is fail-closed (abort), which is the safe side.
 */
function stableRecord(row) {
  return JSON.stringify(
    Object.keys(row)
      .sort()
      .map(key => [key, row[key]])
  )
}

// -- Orchestration ------------------------------------------------------------

/**
 * Guards → list → select → delete. Deps are injectable so unit tests drive the
 * whole orchestration against a fake `Snapshot` static surface with zero
 * network. Returns `{ ok, dryRun, deleted }`; `ok: false` on ANY failure or
 * aborted guard (the CLI exit is nonzero, contained by the workflow step's
 * continue-on-error).
 */
export async function runGcSnapshots(opts = {}) {
  const argv = opts.argv ?? process.argv.slice(2)
  const env = opts.env ?? process.env
  const out = opts.stdout ?? (s => process.stdout.write(s))
  const errOut = opts.stderr ?? (s => process.stderr.write(s))
  const loadSdk = opts.loadSdk ?? defaultLoadSdk
  const readPinnedToml = opts.readPinnedToml ?? defaultReadPinnedToml
  const readGcConfig = opts.readGcConfig ?? defaultReadGcConfig

  let failed = false
  const fail = message => {
    failed = true
    errOut(`error: ${message}\n`)
  }
  const abort = message => {
    fail(message)
    return { ok: false, dryRun: false, deleted: [] }
  }

  const args = parseGcArgs(argv)
  if (!args.ok) return abort(args.error)
  const { keep, dryRun } = args

  const creds = resolveCredsOrFail(env, fail)
  if (failed) return { ok: false, dryRun, deleted: [] }

  // EXPECTED-PROJECT GUARD (before ANY API call): GC only ever runs against
  // the dedicated hosted-runtime snapshot project recorded in gc-config.json.
  let expectedProjectId
  try {
    const config = JSON.parse(readGcConfig())
    expectedProjectId = config?.expectedProjectId
  } catch (error) {
    return abort(`could not read gc-config.json: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof expectedProjectId !== 'string' || expectedProjectId.length === 0) {
    return abort('gc-config.json has no expectedProjectId — refusing to GC without the expected-project guard')
  }
  if (creds.projectId !== expectedProjectId) {
    return abort(
      `VERCEL_PROJECT_ID does not match gc-config.json expectedProjectId (${expectedProjectId}) — ` +
        'refusing to GC: these credentials point at a different project than the dedicated snapshot project'
    )
  }

  // Read the pin BEFORE any API call: if we cannot establish what production
  // boots from, deleting anything would be reckless — abort with NO deletions.
  let pinnedIds = []
  try {
    pinnedIds = parsePinnedSnapshotIds(readPinnedToml())
  } catch (error) {
    return abort(`could not read the pinned snapshot id: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (pinnedIds.length === 0) {
    return abort(
      'no ORIZU_HOSTED_SNAPSHOT var found in workers/session-coordinator/wrangler.toml — refusing to GC without a known pin'
    )
  }

  out(`Snapshot GC (ALI-1170): keep newest ${keep} created + pinned${dryRun ? ' [dry-run]' : ''}\n`)
  out(`Expected project confirmed: ${expectedProjectId}\n`)
  out(`Pinned (survive regardless of age): ${pinnedIds.join(', ')}\n`)

  const sdkCreds = { token: creds.token, projectId: creds.projectId, teamId: creds.teamId }

  let sdk
  try {
    sdk = await loadSdk()
  } catch (error) {
    return abort(error instanceof Error ? error.message : String(error))
  }

  // 1. COMPLETE inventory, merged by id with integrity guards:
  //    - identical repeated rows across page boundaries are deduped (an
  //      overlap window is a legitimate pagination artifact);
  //    - a duplicate id with CONFLICTING fields aborts;
  //    - a repeated `next` cursor aborts (no loops);
  //    - the page cap with a cursor still remaining aborts — never GC a
  //      knowingly-partial inventory.
  //    (`next`→`until` is the assumed cursor relationship — see header note.)
  const byId = new Map()
  try {
    const seenCursors = new Set()
    let until
    for (let page = 0; ; page += 1) {
      const res = await sdk.Snapshot.list({
        ...sdkCreds,
        limit: LIST_PAGE_LIMIT,
        ...(until !== undefined ? { until } : {}),
      })
      const { snapshots, pagination } = res.json
      for (const row of snapshots) {
        const prev = byId.get(row.id)
        if (prev !== undefined && stableRecord(prev) !== stableRecord(row)) {
          return abort(
            `inventory integrity: snapshot ${row.id} appeared twice with conflicting fields — refusing to GC an inconsistent listing`
          )
        }
        byId.set(row.id, row)
      }
      const next = pagination?.next
      if (next === null || next === undefined) break
      if (page + 1 >= LIST_MAX_PAGES) {
        return abort(
          `pagination cap (${LIST_MAX_PAGES} pages) reached with a next cursor still present — refusing to GC a knowingly-partial inventory`
        )
      }
      if (seenCursors.has(next)) {
        return abort(`pagination integrity: cursor ${next} repeated — refusing to GC (possible listing loop)`)
      }
      seenCursors.add(next)
      until = next
    }
  } catch (error) {
    return abort(`listing snapshots failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  const inventory = [...byId.values()]

  // 2. Status allowlist: anything outside the SDK's documented vocabulary
  //    means our model of the API drifted — fail closed.
  const unknown = inventory.filter(s => !KNOWN_STATUSES.has(s.status))
  if (unknown.length > 0) {
    return abort(
      `unknown snapshot status(es): ${unknown.map(s => `${s.id}=${s.status}`).join(', ')} — refusing to GC (SDK contract drift?)`
    )
  }

  // 3. Pin liveness on the COMPLETE inventory: the deployed pin MUST exist as
  //    a live snapshot. An empty inventory therefore can never be trusted —
  //    a flaky API returning [] must fail, not report success.
  if (inventory.length === 0) {
    return abort('listing returned an empty inventory but a pinned snapshot is deployed — refusing to trust it (flaky API?)')
  }
  for (const pin of pinnedIds) {
    const row = byId.get(pin)
    if (row === undefined) {
      return abort(`pinned snapshot ${pin} is ABSENT from the inventory — refusing to GC (stale listing or wrong project?)`)
    }
    if (row.status !== 'created') {
      return abort(`pinned snapshot ${pin} has status "${row.status}" (expected "created") — refusing to GC around a dead pin`)
    }
  }

  // 4. Partition: retention applies to 'created' only; 'failed' bakes are
  //    always junk (never consume a retention slot); 'deleted' are tombstones.
  const created = inventory.filter(s => s.status === 'created')
  const failedRows = inventory.filter(s => s.status === 'failed')
  const retentionDeletes = selectSnapshotIdsToDelete({
    snapshots: created.map(s => ({ id: s.id, createdAt: s.createdAt })),
    pinnedIds,
    keep,
  })
  // Oldest first; createdAt ties broken by id ascending (mirrors the pure
  // selector's tiebreak) so the deletion/log order is total and deterministic.
  const toDelete = [
    ...failedRows.map(s => ({ id: s.id, createdAt: s.createdAt })),
    ...retentionDeletes.map(id => ({ id, createdAt: byId.get(id).createdAt })),
  ]
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    .map(s => s.id)

  out(
    `Listed ${inventory.length} snapshot(s): ${created.length} created, ${failedRows.length} failed (always deleted), ` +
      `${inventory.length - created.length - failedRows.length} tombstoned; ` +
      `${created.length - retentionDeletes.length} survive; ${toDelete.length} to delete.\n`
  )

  if (toDelete.length === 0) {
    out('Nothing to delete.\n')
    return { ok: true, dryRun, deleted: [] }
  }

  if (dryRun) {
    out('dry-run plan (NOT deleting):\n')
    for (const id of toDelete) out(`  would delete ${id}\n`)
    return { ok: true, dryRun: true, deleted: [] }
  }

  // 5. Delete, oldest first, best-effort: one failure must not strand the
  //    rest of the backlog, but ANY failure makes the run exit nonzero.
  const deleted = []
  const failures = []
  for (const id of toDelete) {
    try {
      const snapshot = await sdk.Snapshot.get({ snapshotId: id, ...sdkCreds })
      await snapshot.delete()
      deleted.push(id)
      out(`deleted ${id}\n`)
    } catch (error) {
      failures.push(id)
      errOut(`error: deleting ${id} failed: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }

  out(`Done: ${deleted.length} deleted, ${failures.length} failed.\n`)
  return { ok: failures.length === 0, dryRun: false, deleted }
}

if (import.meta.main) {
  runGcSnapshots()
    .then(result => {
      if (!result.ok) process.exit(1)
    })
    .catch(error => {
      process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    })
}
