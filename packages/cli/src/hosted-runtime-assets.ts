/**
 * In-sandbox runtime assets for the hosted bootstrap (ALI-925, per ADR-005).
 *
 * Ports the DESIGN — not the code — of OpenInspect's
 * `sandbox_runtime/credentials/git_credential_helper.py` into a self-contained
 * script asset that Orizu writes into the sandbox and registers as a git
 * `credential.helper`. On every git op git spawns the script; the script mints a
 * fresh, downscoped, audited token from Orizu's per-repo broker
 * (`POST /api/cli/workspaces/{id}/repo-token`) and hands it to git, caching to a
 * 0600 run-scoped file with an expiry-refresh buffer. It NEVER echoes the token
 * and reads the bearer only from a run-scoped 0600 file (G3): the bearer is
 * never baked into git config, the clone URL, or any long-lived file.
 *
 * Deliberately self-contained (no `orizu` package import) so it works even when
 * the CLI-install step fails — the credential path must not depend on it. The
 * script is emitted as CommonJS (`.cjs`) so it runs unchanged under both `node`
 * (>=18, for global `fetch`) and `bun`, whichever the sandbox image ships.
 *
 * The boot context is split so no secret lands in a value git persists:
 *   - `boot.json`  — non-secret config + the PATHS of the bearer/cache files;
 *   - `<bearer>`   — the Orizu bearer, 0600, run-scoped, reaped at teardown;
 *   - `<cache>`    — the minted repo token, 0600, written by the script itself.
 * git config holds only `credential.helper = !<runtime> <script> <boot.json>`.
 */

export const HELPER_SCRIPT_BASENAME = 'orizu-git-credential-helper.cjs'
export const BOOT_CONTEXT_BASENAME = 'boot.json'
export const BEARER_BASENAME = 'bearer'
export const REPO_CRED_CACHE_BASENAME = 'repo-cred.json'

/** Refresh a cached token this long before its stated expiry (5 minutes). */
export const DEFAULT_CACHE_REFRESH_BUFFER_MS = 5 * 60 * 1000

/** Customer setup hook path, relative to the repo root (mirrors OpenInspect's
 *  `.openinspect/setup.sh` — fresh-boot only, non-fatal, output captured). */
export const SETUP_HOOK_RELATIVE_PATH = '.orizu/setup.sh'

/**
 * The non-secret boot context the helper script reads. Paths are ABSOLUTE so
 * the helper resolves them regardless of git's cwd at invocation time.
 */
export interface HostedBootContext {
  apiBaseUrl: string
  workspaceId: string
  sessionId: string
  runId: string
  sessionBranch: string
  repoFullName: string
  /** VCS host the helper will serve credentials for (default github.com). */
  host: string
  /** Absolute path to the 0600 file holding the Orizu bearer. */
  bearerFile: string
  /** Absolute path to the 0600 minted-token cache the script maintains. */
  cacheFile: string
  /**
   * Broker purpose vocabulary, INJECTABLE so a later slice can flip the whole
   * script from write/read to session_write/session_read without editing it. The
   * helper POSTs `primary` first and falls back to `fallback` ONLY on a 403
   * (unauthorized-for-primary). A 400 is treated as vocabulary drift and fails
   * loudly — it means the broker does not recognise the requested purpose.
   */
  tokenPurposes: { primary: string; fallback: string }
  /**
   * Hosts (lowercased) for which the helper may serve credentials over plain
   * HTTP instead of HTTPS. Production leaves this UNSET → https-only. The
   * local-sim rehearsal sets it to the loopback git server's host so the
   * clone-through-helper path can be proven without TLS. Secure by default.
   */
  insecureHttpHosts?: readonly string[]
  /** Refresh buffer in ms (overridable so tests can force a refresh). */
  cacheBufferMs: number
}

export function serializeBootContext(ctx: HostedBootContext): string {
  return `${JSON.stringify(ctx, null, 2)}\n`
}

/**
 * The git credential-helper script, as a self-contained CommonJS source string.
 * Implements the `get` action (mint/emit); `store`/`erase` are no-ops because
 * the broker owns credential truth and the script never persists what git hands
 * back. Diagnostics go to stderr only — stdout is reserved for git's protocol.
 *
 * NOTE: this is a rendered ARTIFACT, exercised end-to-end as a subprocess in
 * `test/cli/hosted-credential-helper.test.ts`; that subprocess test is the
 * source of truth for its behavior.
 */
export function renderCredentialHelperScript(): string {
  return `'use strict'
// Orizu in-sandbox git credential helper (ALI-925). Self-contained CommonJS.
// Usage (git invokes it): node ${HELPER_SCRIPT_BASENAME} <boot.json> <get|store|erase>
const fs = require('node:fs')

function log(message) {
  try { process.stderr.write('[orizu-cred] ' + message + '\\n') } catch (_) { /* ignore */ }
}

function readStdin() {
  try { return fs.readFileSync(0, 'utf8') } catch (_) { return '' }
}

function parseProtocolInput(text) {
  const out = {}
  for (const raw of text.split('\\n')) {
    const line = raw.replace(/\\r$/, '')
    if (!line) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    out[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return out
}

function readCache(file, nowMs, bufferMs) {
  let parsed
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (_) { return null }
  if (!parsed || typeof parsed !== 'object') return null
  if (!parsed.username || !parsed.password) return null
  if (typeof parsed.expiresAtMs !== 'number') return null
  if (parsed.expiresAtMs - nowMs <= bufferMs) return null
  return parsed
}

function writeCache(file, cred) {
  try {
    const fd = fs.openSync(file, 'w', 0o600)
    try { fs.writeSync(fd, JSON.stringify(cred)) } finally { fs.closeSync(fd) }
  } catch (e) { log('cache write failed: ' + (e && e.message)) }
}

async function requestToken(url, bearer, purpose, sessionId) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bearer },
    body: JSON.stringify({ purpose: purpose, sessionId: sessionId }),
  })
  if (res.ok) {
    const data = await res.json()
    if (!data || !data.token) throw new Error('broker returned no token')
    const parsedExpiry = Date.parse(data.expiresAt)
    const expiresAtMs = Number.isFinite(parsedExpiry) ? parsedExpiry : Date.now() + 60 * 60 * 1000
    return { cred: { username: 'x-access-token', password: String(data.token), expiresAtMs: expiresAtMs }, status: res.status }
  }
  return { cred: null, status: res.status }
}

async function mint(ctx) {
  const bearer = fs.readFileSync(ctx.bearerFile, 'utf8').trim()
  if (!bearer) throw new Error('empty bearer file')
  const base = String(ctx.apiBaseUrl || '').replace(/\\/$/, '')
  const url = base + '/api/cli/workspaces/' + encodeURIComponent(ctx.workspaceId) + '/repo-token'
  const purposes = ctx.tokenPurposes || {}
  const primary = String(purposes.primary || 'write')
  const fallback = String(purposes.fallback || 'read')

  // Try the primary purpose first. A 403 means "unauthorized for this purpose"
  // (e.g. a read-only caller asking to write) — the ONLY legitimate fallback
  // trigger. A 400 means the broker does not recognise the purpose at all
  // (vocabulary drift): fail loudly rather than silently downgrade.
  const first = await requestToken(url, bearer, primary, ctx.sessionId)
  if (first.cred) return first.cred
  if (first.status === 400) {
    throw new Error('broker rejected purpose "' + primary + '" as unknown (400) — vocabulary drift')
  }
  if (first.status !== 403) throw new Error('broker responded ' + first.status)

  const second = await requestToken(url, bearer, fallback, ctx.sessionId)
  if (second.cred) return second.cred
  if (second.status === 400) {
    throw new Error('broker rejected fallback purpose "' + fallback + '" as unknown (400) — vocabulary drift')
  }
  throw new Error('broker denied purposes "' + primary + '"/"' + fallback + '" (last status ' + second.status + ')')
}

async function main() {
  const contextPath = process.argv[2]
  const action = process.argv[3] || 'get'
  // store/erase: nothing to persist — drain stdin so git sees no SIGPIPE.
  if (action !== 'get') { readStdin(); return 0 }
  if (!contextPath) { log('missing boot context path'); return 1 }

  let ctx
  try { ctx = JSON.parse(fs.readFileSync(contextPath, 'utf8')) } catch (e) {
    log('unreadable boot context: ' + (e && e.message)); return 1
  }
  const input = parseProtocolInput(readStdin())

  // Scope: https only (except explicitly allow-listed loopback hosts, used by the
  // local-sim rehearsal), on the configured host. Empty response (exit 0) lets
  // git fall through cleanly without emitting a token to the wrong remote.
  const protocol = String(input.protocol || '').toLowerCase()
  const host = String(input.host || '').toLowerCase()
  const insecureHosts = Array.isArray(ctx.insecureHttpHosts)
    ? ctx.insecureHttpHosts.map(function (h) { return String(h).toLowerCase() })
    : []
  const httpAllowed = protocol === 'http' && insecureHosts.indexOf(host) !== -1
  if (protocol && protocol !== 'https' && !httpAllowed) { log('refusing non-https protocol'); return 0 }
  const expectedHost = String(ctx.host || 'github.com').toLowerCase()
  if (host && host !== expectedHost) { log('refusing host ' + host); return 0 }

  const bufferMs = typeof ctx.cacheBufferMs === 'number' ? ctx.cacheBufferMs : ${DEFAULT_CACHE_REFRESH_BUFFER_MS}
  let cred = readCache(ctx.cacheFile, Date.now(), bufferMs)
  if (!cred) {
    try { cred = await mint(ctx) } catch (e) { log('mint failed: ' + (e && e.message)); return 1 }
    writeCache(ctx.cacheFile, cred)
  }

  for (const key of Object.keys(input)) {
    if (key === 'username' || key === 'password') continue
    process.stdout.write(key + '=' + input[key] + '\\n')
  }
  process.stdout.write('username=' + cred.username + '\\n')
  process.stdout.write('password=' + cred.password + '\\n')
  process.stdout.write('\\n')
  return 0
}

main().then(code => process.exit(code)).catch(e => { log('fatal: ' + (e && e.message)); process.exit(1) })
`
}
