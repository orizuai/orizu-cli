/**
 * Promotion manifests CLI (ALI-907): list | show | approve | reject | apply.
 * Pure command logic with an injected fetcher and project resolver; the entry
 * point owns argument parsing and human/JSON output. apply is idempotent on the
 * server — re-applying returns the stored outcome.
 */

import { authedFetch } from './http.js'

export type CliFetcher = (path: string, init?: RequestInit) => Promise<Response>

export interface ManifestsCommandIo {
  json: boolean
  print: (line: string) => void
  fetcher?: CliFetcher
  resolveProjectSlug?: (arg: string | null) => Promise<string>
}

const MANIFEST_ACTIONS = new Set(['approve', 'reject', 'apply', 'revert'])

async function responseMessage(response: Response): Promise<string> {
  try {
    const data = (await response.clone().json()) as Record<string, unknown>
    const error = typeof data.error === 'string' ? data.error : null
    const message = typeof data.message === 'string' ? data.message : null
    return error || message || response.statusText || String(response.status)
  } catch {
    return response.statusText || String(response.status)
  }
}

async function requireOk(response: Response, action: string): Promise<Record<string, unknown>> {
  if (!response.ok) {
    throw new Error(`${action} failed (${response.status}): ${await responseMessage(response)}`)
  }
  try {
    return (await response.json()) as Record<string, unknown>
  } catch {
    return {}
  }
}

function fetcherFrom(io: ManifestsCommandIo): CliFetcher {
  return io.fetcher ?? authedFetch
}

function argValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag)
  if (index === -1 || index + 1 >= args.length || args[index + 1].startsWith('--')) {
    return null
  }
  return args[index + 1]
}

function positionalArgs(args: string[]): string[] {
  const values: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg.startsWith('--')) {
      if (argValue(args, arg) !== null) {
        i += 1
      }
      continue
    }
    values.push(arg)
  }
  return values
}

async function requireProjectSlug(io: ManifestsCommandIo, args: string[]): Promise<string> {
  if (!io.resolveProjectSlug) {
    throw new Error('Project resolver unavailable')
  }
  return io.resolveProjectSlug(argValue(args, '--project'))
}

function emit(io: ManifestsCommandIo, payload: Record<string, unknown>, human: string) {
  io.print(io.json ? JSON.stringify(payload) : human)
}

function manifestLine(manifest: Record<string, unknown>): string {
  const id = typeof manifest.id === 'string' ? manifest.id : '(unknown)'
  const status = typeof manifest.status === 'string' ? manifest.status : '(unknown)'
  const actionType = typeof manifest.actionType === 'string' ? manifest.actionType : '(unknown)'
  return `${id}  ${status}  ${actionType}`
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0
}

// Auto-applied manifests (ALI-1040) landed by SERVER POLICY, not a human approver
// (approved_by is NULL). Mark them so a reviewer can tell policy applies from
// human applies at a glance; the reason lives in the outcome for `show`.
function wasAutoApplied(manifest: Record<string, unknown>): boolean {
  return asRecord(manifest.outcome).autoApplied === true
}

/** STATUS cell: `applied*` when the server auto-applied it, else the raw status. */
function statusDisplay(manifest: Record<string, unknown>): string {
  const status = typeof manifest.status === 'string' ? manifest.status : '(unknown)'
  return wasAutoApplied(manifest) ? `${status}*` : status
}

/** One-line auto-apply audit note for `show`, or null when not auto-applied. */
function autoApplyNote(manifest: Record<string, unknown>): string | null {
  if (!wasAutoApplied(manifest)) return null
  const reason = asRecord(manifest.outcome).autoApplyReason
  return typeof reason === 'string' && reason.length > 0
    ? `auto-applied by policy: ${reason}`
    : 'auto-applied by policy'
}

// -- list table (ALI-1038) ----------------------------------------------------

/** "3m" / "4h" / "2d" — enough resolution to pick a manifest out of a list. */
function relativeAge(iso: unknown, now: number): string {
  if (typeof iso !== 'string') return '-'
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return '-'
  const mins = Math.max(0, Math.floor((now - then) / 60_000))
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** One-glance change summary from the stored proposedState — no live API call. */
function changesSummary(manifest: Record<string, unknown>): string {
  if (manifest.actionType !== 'repo_merge') return '-'
  const proposed = asRecord(manifest.proposedState)
  const files = num(proposed.filesChanged)
  const parts = `${files} file${files === 1 ? '' : 's'} +${num(proposed.additions)}/-${num(proposed.deletions)}`
  // Instruction files steer agent behavior — reviewers should see the flag in the list.
  return proposed.touches_instruction_files === true ? `${parts} !instr` : parts
}

/** Reviewable-first (pending_approval, then draft), newest first within a group. */
function listOrder(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const rank = (m: Record<string, unknown>): number =>
    m.status === 'pending_approval' ? 0 : m.status === 'draft' ? 1 : 2
  const byRank = rank(a) - rank(b)
  if (byRank !== 0) return byRank
  const created = (m: Record<string, unknown>): number =>
    typeof m.createdAt === 'string' ? Date.parse(m.createdAt) || 0 : 0
  return created(b) - created(a)
}

/** Render manifests as the standard padEnd table (matches teams/projects list). */
function manifestsTable(manifests: Record<string, unknown>[], now: number): string {
  if (manifests.length === 0) return 'promotion manifests\n(none)'
  const rows = [...manifests].sort(listOrder).map(manifest => ({
    id: typeof manifest.id === 'string' ? manifest.id : '(unknown)',
    status: statusDisplay(manifest),
    type: typeof manifest.actionType === 'string' ? manifest.actionType : '(unknown)',
    changes: changesSummary(manifest),
    author: typeof manifest.authorActorType === 'string' ? manifest.authorActorType : '-',
    age: relativeAge(manifest.createdAt, now),
  }))
  const idWidth = Math.max('ID'.length, ...rows.map(row => row.id.length))
  const statusWidth = Math.max('STATUS'.length, ...rows.map(row => row.status.length))
  const typeWidth = Math.max('TYPE'.length, ...rows.map(row => row.type.length))
  const changesWidth = Math.max('CHANGES'.length, ...rows.map(row => row.changes.length))
  const authorWidth = Math.max('AUTHOR'.length, ...rows.map(row => row.author.length))
  const header =
    `${'ID'.padEnd(idWidth)}  ${'STATUS'.padEnd(statusWidth)}  ${'TYPE'.padEnd(typeWidth)}  ` +
    `${'CHANGES'.padEnd(changesWidth)}  ${'AUTHOR'.padEnd(authorWidth)}  AGE`
  const divider =
    `${'-'.repeat(idWidth)}  ${'-'.repeat(statusWidth)}  ${'-'.repeat(typeWidth)}  ` +
    `${'-'.repeat(changesWidth)}  ${'-'.repeat(authorWidth)}  ---`
  const body = rows.map(
    row =>
      `${row.id.padEnd(idWidth)}  ${row.status.padEnd(statusWidth)}  ${row.type.padEnd(typeWidth)}  ` +
      `${row.changes.padEnd(changesWidth)}  ${row.author.padEnd(authorWidth)}  ${row.age}`
  )
  return [header, divider, ...body].join('\n')
}

// repo_merge manifests (ALI-972) render the compare summary from stored evidence
// — no live GitHub call — so a reviewer can approve informed without a PR.
function repoMergeShow(manifest: Record<string, unknown>): string {
  const proposed = asRecord(manifest.proposedState)
  const compare = asRecord(asRecord(manifest.evidence).compare)
  const branch = typeof proposed.branch === 'string' ? proposed.branch : '(branch)'
  const defaultBranch = typeof proposed.defaultBranch === 'string' ? proposed.defaultBranch : '(default)'
  const files = num(compare.filesChanged || proposed.filesChanged)
  const additions = num(compare.additions ?? proposed.additions)
  const deletions = num(compare.deletions ?? proposed.deletions)
  const lines = [
    manifestLine(manifest),
    `  ${branch} -> ${defaultBranch}`,
    `  ${files} files, +${additions}/-${deletions}`,
  ]
  const compareFiles = Array.isArray(compare.files) ? (compare.files as Record<string, unknown>[]) : []
  for (const file of compareFiles.slice(0, 100)) {
    const status = typeof file.status === 'string' ? file.status : 'modified'
    const filename = typeof file.filename === 'string' ? file.filename : '(file)'
    lines.push(`    ${status} ${filename} (+${num(file.additions)}/-${num(file.deletions)})`)
  }
  return lines.join('\n')
}

export async function manifestsCommand(args: string[], io: ManifestsCommandIo): Promise<number> {
  const positional = positionalArgs(args)
  const subcommand = positional[0]

  if (subcommand === 'list') {
    const projectSlug = await requireProjectSlug(io, args)
    const status = argValue(args, '--status')
    const query = status
      ? `?project=${encodeURIComponent(projectSlug)}&status=${encodeURIComponent(status)}`
      : `?project=${encodeURIComponent(projectSlug)}`
    const response = await fetcherFrom(io)(`/api/cli/promotion-manifests${query}`)
    const data = await requireOk(response, 'Manifest list')
    const manifests = Array.isArray(data.manifests) ? (data.manifests as Record<string, unknown>[]) : []
    emit(io, { manifests }, manifestsTable(manifests, Date.now()))
    return 0
  }

  if (subcommand === 'show') {
    const id = positional[1]
    if (!id) {
      throw new Error('Usage: orizu manifests show <id> [--json]')
    }
    const response = await fetcherFrom(io)(`/api/cli/promotion-manifests/${encodeURIComponent(id)}`)
    const data = await requireOk(response, 'Manifest show')
    const manifest = (data.manifest ?? {}) as Record<string, unknown>
    const base = manifest.actionType === 'repo_merge' ? repoMergeShow(manifest) : manifestLine(manifest)
    const note = autoApplyNote(manifest)
    const human = note ? `${base}\n  ${note}` : base
    emit(io, { manifest }, human)
    return 0
  }

  if (subcommand && MANIFEST_ACTIONS.has(subcommand)) {
    const id = positional[1]
    if (!id) {
      throw new Error(`Usage: orizu manifests ${subcommand} <id> [--json]`)
    }
    const response = await fetcherFrom(io)(`/api/cli/promotion-manifests/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: subcommand }),
    })
    const data = await requireOk(response, `Manifest ${subcommand}`)
    const manifest = (data.manifest ?? {}) as Record<string, unknown>
    const lines = [manifestLine(manifest)]
    // Reject reaps the session branch best-effort; a failed reap must never be
    // silent (ALI-1043) — surface it with the exact cleanup command.
    if (subcommand === 'reject' && manifest.actionType === 'repo_merge') {
      const outcome = asRecord(manifest.outcome)
      const branch = asRecord(manifest.proposedState).branch
      if (outcome.branchDeleted === true) {
        lines.push('session branch deleted')
      } else if (typeof branch === 'string' && branch.length > 0) {
        lines.push(
          `warning: the session branch could not be deleted — remove it with: git push origin --delete ${branch}`
        )
      } else {
        lines.push('warning: the session branch could not be deleted (branch name unavailable)')
      }
    }
    emit(io, { manifest }, lines.join('\n'))
    return 0
  }

  io.print('Usage: orizu manifests <list|show|approve|reject|apply|revert> ... [--json]')
  return 1
}
