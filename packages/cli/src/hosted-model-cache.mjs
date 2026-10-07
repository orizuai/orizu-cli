import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// The pinned runtime reads this file once: only replace it with a valid list containing the required models.
export async function refreshHostedModels({ env = process.env, required = [], strict = false, fetchImpl = fetch, signal } = {}) {
  signal?.throwIfAborted()
  const path = env.OPENCODE_MODELS_PATH || join(env.XDG_CACHE_HOME || join(env.HOME || homedir(), '.cache'), 'opencode', 'models.json')
  const temporary = `${path}.${process.pid}.tmp`
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  const strings = (value, keys) => keys.every(key => value[key] === undefined || typeof value[key] === 'string')
  const cost = value => value === undefined || (record(value) && ['input', 'output', 'cache_read', 'cache_write'].every(key => value[key] === undefined || Number.isFinite(value[key])) && cost(value.context_over_200k))
  const providerOptions = value => value === undefined || (record(value) && strings(value, ['api', 'npm']) &&
    (value.body === undefined || record(value.body)) && (value.headers === undefined || (record(value.headers) && Object.values(value.headers).every(header => typeof header === 'string'))))
  const optionalModelFields = model => {
    if (!strings(model, ['family']) || (model.status !== undefined && !['alpha', 'beta', 'deprecated', 'active'].includes(model.status)) || !cost(model.cost) || !providerOptions(model.provider)) return false
    if (model.limit.input !== undefined && !Number.isFinite(model.limit.input)) return false
    if (model.interleaved !== undefined && typeof model.interleaved !== 'boolean' && (!record(model.interleaved) || !['reasoning_content', 'reasoning_details'].includes(model.interleaved.field))) return false
    if (model.modalities !== undefined && (!record(model.modalities) || !['input', 'output'].every(key => Array.isArray(model.modalities[key]) && model.modalities[key].every(value => ['text', 'audio', 'image', 'video', 'pdf'].includes(value))))) return false
    if (model.experimental !== undefined && (!record(model.experimental) || (model.experimental.modes !== undefined && (!record(model.experimental.modes) || Object.entries(model.experimental.modes).some(([name, mode]) => !name || !record(mode) || !cost(mode.cost) || !providerOptions(mode.provider)))))) return false
    return true
  }
  const identities = text => {
    const catalog = JSON.parse(text)
    if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) throw new Error('Invalid model catalog')
    return Object.entries(catalog).flatMap(([provider, value]) => {
      if (!value || value.id !== provider || !strings(value, ['api', 'npm']) || typeof value.name !== 'string' || !Array.isArray(value.env) || value.env.some(name => typeof name !== 'string') || typeof value.models !== 'object' || !value.models || Array.isArray(value.models)) throw new Error('Invalid model provider')
      return Object.entries(value.models).map(([id, model]) => {
        if (!model || model.id !== id || typeof model.name !== 'string' || typeof model.release_date !== 'string' || ['attachment', 'reasoning', 'tool_call'].some(key => typeof model[key] !== 'boolean') || (model.temperature !== undefined && typeof model.temperature !== 'boolean') || !Number.isFinite(model.limit?.context) || !Number.isFinite(model.limit?.output)) throw new Error('Invalid model entry')
        if (!optionalModelFields(model)) throw new Error('Invalid optional model metadata')
        return ['alpha', 'deprecated'].includes(model.status) ? null : `${provider}/${id}`
      }).filter(Boolean)
    })
  }
  try {
    const response = await fetchImpl(`${env.OPENCODE_MODELS_URL || 'https://models.dev'}/api.json`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`Model catalog download failed: ${response.status}`)
    const text = await response.text()
    const models = new Set(identities(text))
    if (!models.size || required.some(id => !models.has(id))) throw new Error('Model catalog is missing required models')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(temporary, text)
    signal?.throwIfAborted()
    await rename(temporary, path)
  } catch (error) {
    signal?.throwIfAborted()
    if (strict) throw error
  } finally { await rm(temporary, { force: true }) }
  signal?.throwIfAborted()
  return path
}

export const bakeHostedModels = () => refreshHostedModels({ strict: true, required: process.env.HOSTED_WORKSPACE_DEFAULT_MODEL ? [process.env.HOSTED_WORKSPACE_DEFAULT_MODEL] : ['openai/gpt-5.6', 'openai/gpt-6-luna', 'anthropic/claude-opus-4-8'] })
