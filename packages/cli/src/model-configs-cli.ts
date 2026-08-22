import { readFileSync } from 'node:fs'

import { authedFetch } from './http.js'

export type CliFetcher = (path: string, init?: RequestInit) => Promise<Response>

export interface ModelConfigSettingsVersion {
  versionNumber: number
  settings: Record<string, unknown>
}

export interface ModelConfig {
  identity: string
  displayName: string
  currentSettingsVersion: ModelConfigSettingsVersion
  createdAt: string
}

export interface ModelConfigsCommandIo {
  json: boolean
  print: (line: string) => void
  fetcher?: CliFetcher
  resolveProjectSlug?: (arg: string | null) => Promise<string>
}

function argValue(args: string[], flag: string): string | null {
  const index = args.lastIndexOf(flag)
  return index === -1 || !args[index + 1] || args[index + 1]!.startsWith('--') ? null : args[index + 1]!
}

function positionalArgs(args: string[]): string[] {
  const values: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index]!.startsWith('--')) {
      if (args[index + 1] && !args[index + 1]!.startsWith('--')) index += 1
    } else values.push(args[index]!)
  }
  return values
}

function readSettings(value: string | null, defaultToEmpty = false): Record<string, unknown> {
  if (!value) {
    if (defaultToEmpty) return {}
    throw new Error('--settings is required')
  }
  const source = value.startsWith('@') ? readFileSync(value.slice(1), 'utf8') : value
  const parsed: unknown = JSON.parse(source)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('--settings must contain a JSON object')
  }
  return parsed as Record<string, unknown>
}

async function responseMessage(response: Response): Promise<string> {
  try {
    const body = await response.clone().json() as Record<string, unknown>
    return typeof body.error === 'string' ? body.error : response.statusText
  } catch {
    return response.statusText
  }
}

async function requestJson(fetcher: CliFetcher, path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetcher(path, init)
  if (!response.ok) throw new Error(`Model config request failed (${response.status}): ${await responseMessage(response)}`)
  return response.json()
}

function renderModelConfig(config: ModelConfig): string {
  return `${config.identity}  ${config.displayName}  v${config.currentSettingsVersion.versionNumber}`
}

export async function modelConfigsCommand(args: string[], io: ModelConfigsCommandIo): Promise<number> {
  const positional = positionalArgs(args)
  const [command, action, identity] = positional
  const resolveProjectSlug = io.resolveProjectSlug
  if (!resolveProjectSlug) throw new Error('Project resolver unavailable')
  const projectArg = argValue(args, '--project')
  const project = projectArg || await resolveProjectSlug(null)
  const fetcher = io.fetcher ?? authedFetch
  const root = `/api/cli/model-configs?project=${encodeURIComponent(project)}`
  let result: unknown

  if (command === 'list' && !action) {
    result = await requestJson(fetcher, root, { method: 'GET' })
    if (io.json) io.print(JSON.stringify(result))
    else for (const config of ((result as { modelConfigs?: ModelConfig[] }).modelConfigs || [])) io.print(renderModelConfig(config))
    return 0
  }
  if (command === 'show' && action && !identity) {
    result = await requestJson(fetcher, `/api/cli/model-configs/${encodeURIComponent(action)}?project=${encodeURIComponent(project)}`, { method: 'GET' })
  } else if (command === 'create' && action && !identity) {
    result = await requestJson(fetcher, root, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identity: action, displayName: argValue(args, '--name') || action, settings: readSettings(argValue(args, '--settings'), true) }),
    })
  } else if (command === 'settings' && action === 'set' && identity) {
    result = await requestJson(fetcher, `/api/cli/model-configs/${encodeURIComponent(identity)}/settings?project=${encodeURIComponent(project)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings: readSettings(argValue(args, '--settings')) }),
    })
  } else if (command === 'copy' && action && !identity) {
    const to = argValue(args, '--to')
    if (!to) throw new Error('--to is required')
    result = await requestJson(fetcher, `/api/cli/model-configs/${encodeURIComponent(action)}/copy?project=${encodeURIComponent(project)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to }),
    })
  } else {
    io.print('Usage: orizu model-configs <create|list|show|settings set|copy> [--project <team/project>] [--json]')
    return 1
  }

  if (io.json) {
    io.print(JSON.stringify(result))
  } else {
    const config = (result as { modelConfig: ModelConfig }).modelConfig
    io.print(renderModelConfig(config))
  }
  return 0
}
