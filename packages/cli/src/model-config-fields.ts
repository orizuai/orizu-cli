import type { WireProtocol } from './provider-registry.js'

export const MODEL_CONFIG_FIELDS = [
  // The pilot's frozen settings carry the provider model name under `model`.
  { field: 'MODEL', settingsKeys: ['model'], kind: 'string' },
  // `protocol` names the transport/API protocol selected for a customer model call.
  { field: 'PROTOCOL', settingsKeys: ['protocol'], kind: 'string' },
  // The pilot uses `reasoning_effort`; hosted settings accept OpenAI `reasoning.effort` and Anthropic `output_config.effort`.
  { field: 'THINKING_LEVEL', settingsKeys: ['reasoning_effort', 'reasoning.effort', 'output_config.effort'], kind: 'string' },
  // Responses uses `max_output_tokens`; Messages uses `max_tokens` for the output limit.
  { field: 'MAX_OUTPUT_TOKENS', settingsKeys: ['max_output_tokens', 'max_tokens'], kind: 'number' },
  // `temperature` feeds the temperature call option for the applicable protocols.
  { field: 'TEMPERATURE', settingsKeys: ['temperature'], kind: 'number' },
  // `top_p` feeds the top-p call option accepted by the applicable protocols.
  { field: 'TOP_P', settingsKeys: ['top_p'], kind: 'number' },
  // `strict_json_schema` controls strict schema enforcement in a structured-output call.
  { field: 'STRICT_JSON_SCHEMA', settingsKeys: ['strict_json_schema'], kind: 'boolean' },
] as const

export type ModelConfigField = typeof MODEL_CONFIG_FIELDS[number]['field']

// Dotted settings keys resolve exactly one object level; they are not a general path language.
// Keyed by WIRE PROTOCOL, not by provider name: two providers speaking the same
// protocol take the same request fields (ORI-2031 row 3).
//
// Every cell is MEASURED against a live endpoint, never taken from
// documentation (ADR-013). T1 shipped this table without an `openai-chat`
// column because Orizu had never sent a chat-completions request; ORI-2032
// measured that protocol on 2026-09-12 and filled it in. The measured
// contract, including which fields each model accepted, is recorded in
// docs/requirements/any-provider-support/t2-python-transport-plan.md.
export const PROVIDER_REQUEST_FIELDS: Record<ModelConfigField, Record<WireProtocol, string | null>> = {
  MODEL: { 'openai-responses': 'model', 'openai-chat': 'model', 'anthropic-messages': 'model' },
  // Orizu consumes protocol selection; it is not a provider request field.
  PROTOCOL: { 'openai-responses': null, 'openai-chat': null, 'anthropic-messages': null },
  // null for openai-chat: Orizu's chat builder sends NO reasoning field. The
  // protocol is not enough to decide one — OpenRouter takes `reasoning.effort`
  // and OpenAI chat a top-level `reasoning_effort` — and a customer's own
  // reflection_provider_settings reach the provider verbatim either way.
  THINKING_LEVEL: { 'openai-responses': 'reasoning.effort', 'openai-chat': null, 'anthropic-messages': 'output_config.effort' },
  // 'max_completion_tokens' is measured: gpt-4o-mini accepted either field,
  // gpt-5-mini and o4-mini rejected 'max_tokens' with unsupported_parameter.
  MAX_OUTPUT_TOKENS: { 'openai-responses': 'max_output_tokens', 'openai-chat': 'max_completion_tokens', 'anthropic-messages': 'max_tokens' },
  // openai-chat: accepted by gpt-4o-mini; rejected with 400 by gpt-5-mini and o4-mini, so the builder only sends temperature when set.
  TEMPERATURE: { 'openai-responses': 'temperature', 'openai-chat': 'temperature', 'anthropic-messages': 'temperature' },
  // openai-chat: accepted by gpt-4o-mini; rejected with 400 by gpt-5-mini and o4-mini, so the builder only sends top_p when set.
  TOP_P: { 'openai-responses': 'top_p', 'openai-chat': 'top_p', 'anthropic-messages': 'top_p' },
  // Orizu consumes strict schema selection; it is not a provider request field.
  STRICT_JSON_SCHEMA: { 'openai-responses': null, 'openai-chat': null, 'anthropic-messages': null },
}
