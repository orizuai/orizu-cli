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
 *   survivors = newest K 'created' snapshots ∪ every current id   (K default 3)
 *   'failed' bakes are ALWAYS deleted (they never consume a retention slot);
 *   'deleted' tombstones are ignored; everything else 'created' is deleted.
 *
 * The current id(s) come from the deployed coordinator's readiness route
 * (`GET <origin>/hosted-optimization/readiness` → `{ currentSnapshot, … }`,
 * ORI-2237 / ADR-035), not from wrangler.toml, and survive REGARDLESS of age —
 * belt-and-braces so a rollback or a stalled release cadence can never GC the
 * snapshot production is booting from. The origin is `ORIZU_COORDINATOR_URL`
 * in workers/session-coordinator/wrangler.toml unless `--coordinator-url` is
 * given; it must be https (http only on a loopback host, for tests).
 * `hostedOptimizationArmed: false` does not abort: a well-formed current id
 * is protected either way.
 *
 * THE READ WINDOW: Cloudflare serves old and new values side by side for
 * about 10 s after a change. The READINESS_READS reads (1 s apart) are
 * best-effort and cannot cover that window alone; every id they see
 * survives. What makes the release safe is ordering: publish-cli.yml runs GC
 * only after scripts/check-coordinator-armed.mjs has seen 5 consecutive
 * matching reads over at least 12 s, which outlasts the overlap. And the
 * previous release's snapshot is the second-newest, so `--keep 3` keeps it
 * anyway. After setting the snapshot by hand (a rollback), run the armed
 * check before running GC by hand.
 *
 * FAIL-CLOSED ORCHESTRATION — this tool deletes; every ambiguity aborts with
 * ZERO deletions:
 *   - CURRENT-ID READS: any readiness read that is unreachable, non-200, not
 *     JSON, or lacks a well-formed `currentSnapshot` (snap_[A-Za-z0-9]+)
 *     aborts BEFORE listing — even one bad read among good ones.
 *   - EXPECTED-PROJECT GUARD: the resolved VERCEL_PROJECT_ID must equal
 *     gc-config.json's expectedProjectId BEFORE any API call — wrong-project
 *     credentials can never GC an unrelated project. GC only ever runs against
 *     the dedicated hosted-runtime snapshot project.
 *   - PIN LIVENESS: after the COMPLETE listing, every current id must be
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
 * VERCEL_TEAM_ID and network access to the coordinator; run with bun from the
 * repo checkout after `bun install --cwd packages/cli`, same as
 * provision-snapshot.mjs):
 *
 *   bun packages/cli/hosted-runtime-image/gc-snapshots.mjs \
 *     [--keep <K>] [--dry-run] [--coordinator-url <origin>] [--protect <snap_id>]...
 *
 *   --keep             how many newest 'created' snapshots survive (default 3, int >= 1)
 *   --dry-run          print the deletion plan without deleting anything
 *   --coordinator-url  coordinator origin (default: ORIZU_COORDINATOR_URL in wrangler.toml)
 *   --protect          an extra id that survives regardless of age, and must pass
 *                      the same liveness check as the current id (repeatable;
 *                      ORI-2238: the release switch protects the id it replaced,
 *                      so the rollback target survives)
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

/** Where the coordinator's address is recorded (repo-relative). */
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
/** The coordinator's own HOSTED_SNAPSHOT_ID_PATTERN (vercel-rest-adapter.ts). */
const SNAPSHOT_ID_PATTERN = /^snap_[A-Za-z0-9]+$/
const READINESS_PATH = '/hosted-optimization/readiness'
/** Readiness reads per run and the gap between them; every id seen survives. */
const READINESS_READS = 3
const READINESS_INTERVAL_MS = 1_000
const READINESS_REQUEST_TIMEOUT_MS = 10_000
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost'])

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
 * Returns `{ ok: true, keep, dryRun, coordinatorUrl, protectedIds }` or `{ ok: false, error }`.
 */
export function parseGcArgs(argv) {
  let keep = DEFAULT_KEEP
  let dryRun = false
  let coordinatorUrl
  const protectedIds = []
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
    } else if (token === '--coordinator-url') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('-')) {
        return { ok: false, error: '--coordinator-url requires a value (an https origin)' }
      }
      if (!isAllowedCoordinatorUrl(value)) {
        return { ok: false, error: `--coordinator-url ${COORDINATOR_URL_RULE} (got "${value}")` }
      }
      coordinatorUrl = value
      i += 1
    } else if (token === '--protect') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('-')) {
        return { ok: false, error: '--protect requires a value (a snap_ id)' }
      }
      if (!SNAPSHOT_ID_PATTERN.test(value)) {
        return { ok: false, error: `--protect must be a snapshot id matching ${SNAPSHOT_ID_PATTERN} (got "${value}")` }
      }
      if (!protectedIds.includes(value)) protectedIds.push(value)
      i += 1
    } else {
      return {
        ok: false,
        error:
          `unrecognized argument "${token}" — allowed: --keep <n>, --dry-run, --coordinator-url <origin>, --protect <snap_id> ` +
          '(no --key=value syntax)',
      }
    }
  }
  return { ok: true, keep, dryRun, coordinatorUrl, protectedIds }
}

export const COORDINATOR_URL_RULE = 'must be an https URL (http only on 127.0.0.1, ::1 or localhost)'

/** https anywhere; plain http only on a loopback host (the tests' local stubs). */
export function isAllowedCoordinatorUrl(value) {
  try {
    const { protocol, hostname } = new URL(value)
    return protocol === 'https:' || (protocol === 'http:' && LOOPBACK_HOSTS.has(hostname))
  } catch {
    return false
  }
}

// -- Current id from the coordinator ------------------------------------------

/**
 * The `ORIZU_COORDINATOR_URL = "…"` value in the wrangler.toml text (same
 * anchored shape scripts/check-coordinator-armed.mjs reads), or null.
 */
export function parseCoordinatorUrl(tomlText) {
  return tomlText.match(/^ORIZU_COORDINATOR_URL = "([^"]+)"$/m)?.[1] ?? null
}

async function readReadinessOnce(url, fetchImpl) {
  let response
  try {
    response = await fetchImpl(url, {
      headers: { 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(READINESS_REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    return { error: `request failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (response.status !== 200) return { error: `HTTP ${response.status}` }
  let body
  try {
    body = await response.json()
  } catch {
    return { error: 'response was not JSON' }
  }
  const id = body?.currentSnapshot
  if (typeof id !== 'string' || !SNAPSHOT_ID_PATTERN.test(id)) {
    return { error: `currentSnapshot is not a well-formed snapshot id (got ${JSON.stringify(id ?? null)})` }
  }
  return { id, armed: body.hostedOptimizationArmed === true }
}

/**
 * Reads the readiness route READINESS_READS times, READINESS_INTERVAL_MS
 * apart, and returns `{ ok: true, ids, notArmed }` with the UNION of every
 * current id seen, or `{ ok: false, error }` if ANY read failed — one bad
 * read aborts the run.
 */
export async function readCurrentSnapshotIds({ origin, fetch: fetchImpl, sleep }) {
  const base = origin.replace(/\/+$/, '')
  const ids = new Set()
  let notArmed = false
  for (let read = 1; read <= READINESS_READS; read += 1) {
    if (read > 1) await sleep(READINESS_INTERVAL_MS)
    const result = await readReadinessOnce(`${base}${READINESS_PATH}?read=${read}`, fetchImpl)
    if (result.error) return { ok: false, error: `readiness read ${read}/${READINESS_READS}: ${result.error}` }
    ids.add(result.id)
    if (!result.armed) notArmed = true
  }
  return { ok: true, ids: [...ids], notArmed }
}

// -- Default (real) dependency loaders ----------------------------------------

/** Real SDK loader — lazy so tests injecting a fake never touch the package. */
export async function defaultLoadSdk() {
  // Assembled specifier (same discipline as vercel-sandbox-provider.ts) so no
  // bundler that ever reaches this file can constant-fold a static dependency.
  const specifier = ['@vercel', 'sandbox'].join('/')
  const mod = await import(specifier)
  if (typeof mod?.Snapshot?.list !== 'function' || typeof mod?.Snapshot?.get !== 'function') {
    throw new Error('@vercel/sandbox did not export Snapshot.list/get — re-verify the SDK pin (see header contract)')
  }
  return mod
}

function defaultReadWranglerToml() {
  return readFileSync(WRANGLER_TOML_PATH, 'utf8')
}

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms))

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
  const readWranglerToml = opts.readWranglerToml ?? defaultReadWranglerToml
  const fetchImpl = opts.fetch ?? globalThis.fetch
  const sleep = opts.sleep ?? defaultSleep
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
  const { keep, dryRun, coordinatorUrl, protectedIds } = args

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

  // Read the current id BEFORE any Vercel API call: if we cannot establish
  // what production boots from, deleting anything would be reckless — abort
  // with NO deletions.
  let origin = coordinatorUrl
  if (origin === undefined) {
    try {
      origin = parseCoordinatorUrl(readWranglerToml())
    } catch (error) {
      return abort(`could not read wrangler.toml: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (origin === null) {
      return abort(
        'no ORIZU_COORDINATOR_URL var found in workers/session-coordinator/wrangler.toml — refusing to GC without the coordinator address'
      )
    }
    if (!isAllowedCoordinatorUrl(origin)) {
      return abort(`ORIZU_COORDINATOR_URL in wrangler.toml ${COORDINATOR_URL_RULE} (got "${origin}")`)
    }
  }
  const current = await readCurrentSnapshotIds({ origin, fetch: fetchImpl, sleep })
  if (!current.ok) {
    return abort(`could not read the current snapshot id from the coordinator: ${current.error} — refusing to GC`)
  }
  const pinnedIds = [...new Set([...current.ids, ...protectedIds])]

  out(`Snapshot GC (ALI-1170): keep newest ${keep} created + current${dryRun ? ' [dry-run]' : ''}\n`)
  out(`Expected project confirmed: ${expectedProjectId}\n`)
  out(`Current (from coordinator readiness; survive regardless of age): ${current.ids.join(', ')}\n`)
  if (protectedIds.length > 0) {
    out(`Protected by --protect (survive regardless of age): ${protectedIds.join(', ')}\n`)
  }
  if (current.notArmed) {
    out('warning: the coordinator reports hostedOptimizationArmed false; the current id is protected anyway\n')
  }

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
      return abort(`current or protected snapshot ${pin} is ABSENT from the inventory — refusing to GC (stale listing or wrong project?)`)
    }
    if (row.status !== 'created') {
      return abort(`current or protected snapshot ${pin} has status "${row.status}" (expected "created") — refusing to GC around a dead pin`)
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
