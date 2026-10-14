// The team and project lists that setup, `teams list` and `projects list`
// read. Plain TypeScript on purpose: hosted sessions list teams and projects
// with ORIZU_TOKEN or ORIZU_TOKEN_FILE set, and that path loads no Effect.
import { parseJsonResponse } from './json-response.js'

type ListRequest = (path: string, init: RequestInit) => Promise<Response>

interface ListShape<T> {
  /** How the list is named in messages: "team list". */
  what: string
  /** The words before a refused reply's text, as before: "Failed to fetch teams". */
  failed: string
  /** The label for a reply that isn't JSON: "Teams list". */
  label: string
  /** The reply's field holding the list: "teams". */
  field: string
  /** The item with any missing optional field filled in, or null when the CLI can't use it. */
  read: (value: unknown) => T | null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

// Every command that names a project reads these lists, and none of them read
// ORIZU_DATASET_TRANSFER_TIMEOUT_MS before, so they get a fixed limit. Setup
// passes the setting, as its team and project creates already use it.
const DEFAULT_LIST_TIMEOUT_MS = 120_000

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/** A field the CLI only shows: absent, null or a string. */
const isOptionalString = (value: unknown): value is string | null | undefined =>
  value === undefined || value === null || typeof value === 'string'

export interface ListedTeam {
  id: string
  name: string
  slug: string
  role: string
}

export interface ListedProject {
  id: string
  name: string
  slug: string
  teamId: string
  teamName: string
  teamSlug: string
  role: string
}

// The CLI needs a team's id and slug. Its name and role are only shown, and a
// missing role was already shown as "-", so those may be missing; any other
// field the server sends is kept as it came.
export const TEAM_LIST: ListShape<ListedTeam> = {
  what: 'team list',
  failed: 'Failed to fetch teams',
  label: 'Teams list',
  field: 'teams',
  read: value => {
    if (!isRecord(value) || !isNonEmptyString(value.id) || !isNonEmptyString(value.slug)) return null
    if (!isOptionalString(value.name) || !isOptionalString(value.role)) return null
    return { ...value, id: value.id, slug: value.slug, name: value.name ?? value.slug, role: value.role ?? '' }
  },
}

// Setup files each project by its slug and records its id, under its team's
// slug, so those three must be there; the rest are only shown.
export const PROJECT_LIST: ListShape<ListedProject> = {
  what: 'project list',
  failed: 'Failed to fetch projects',
  label: 'Projects list',
  field: 'projects',
  read: value => {
    if (!isRecord(value) || !isNonEmptyString(value.id) || !isNonEmptyString(value.slug) || !isNonEmptyString(value.teamSlug)) return null
    if (!isOptionalString(value.name) || !isOptionalString(value.teamId) || !isOptionalString(value.teamName) || !isOptionalString(value.role)) return null
    return {
      ...value,
      id: value.id,
      slug: value.slug,
      teamSlug: value.teamSlug,
      name: value.name ?? value.slug,
      teamId: value.teamId ?? '',
      teamName: value.teamName ?? value.teamSlug,
      role: value.role ?? '',
    }
  },
}

/**
 * One request with a time limit, its reply read under the same limit. A list
 * Orizu can't read stops here, before any caller writes a file.
 */
export async function readDirectoryList<T>(
  request: ListRequest,
  path: string,
  shape: ListShape<T>,
  timeoutMs = DEFAULT_LIST_TIMEOUT_MS,
): Promise<T[]> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  try {
    const response = await request(path, { signal: controller.signal })
    if (!response.ok) throw new Error(`${shape.failed}: ${await response.text()}`)
    const data = await parseJsonResponse<unknown>(response, shape.label)
    const list = isRecord(data) ? data[shape.field] : undefined
    const unreadable = new Error(`The server sent a ${shape.what} Orizu can't read. Run \`orizu update\` and try again; if it still fails, the server may be having trouble.`)
    if (!Array.isArray(list)) throw unreadable
    const items: T[] = []
    for (const value of list) {
      const item = shape.read(value)
      if (item === null) throw unreadable
      items.push(item)
    }
    return items
  } catch (error: unknown) {
    if (timedOut) throw new Error(`Orizu didn't get the ${shape.what} within ${timeoutMs / 1000} s. Check your connection and try again.`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}
