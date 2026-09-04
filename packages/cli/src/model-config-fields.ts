export const MODEL_CONFIG_FIELDS = [
  // The pilot's frozen settings carry the provider model name under `model`.
  { field: 'MODEL', settingsKeys: ['model'], kind: 'string' },
  // `protocol` names the transport/API protocol selected for a customer model call.
  { field: 'PROTOCOL', settingsKeys: ['protocol'], kind: 'string' },
  // The pilot uses `reasoning_effort`; hosted settings accept OpenAI `reasoning.effort` and Anthropic `output_config.effort`.
  { field: 'THINKING_LEVEL', settingsKeys: ['reasoning_effort', 'reasoning.effort', 'output_config.effort'], kind: 'string' },
  // Responses uses `max_output_tokens`; Messages uses `max_tokens` for the output limit.
  { field: 'MAX_OUTPUT_TOKENS', settingsKeys: ['max_output_tokens', 'max_tokens'], kind: 'number' },
  // `temperature` feeds the temperature call option for both supported providers.
  { field: 'TEMPERATURE', settingsKeys: ['temperature'], kind: 'number' },
  // `top_p` feeds the top-p call option accepted by both supported providers.
  { field: 'TOP_P', settingsKeys: ['top_p'], kind: 'number' },
  // `strict_json_schema` controls strict schema enforcement in a structured-output call.
  { field: 'STRICT_JSON_SCHEMA', settingsKeys: ['strict_json_schema'], kind: 'boolean' },
] as const

export type ModelConfigField = typeof MODEL_CONFIG_FIELDS[number]['field']

// Dotted settings keys resolve exactly one object level; they are not a general path language.
export const PROVIDER_REQUEST_FIELDS: Record<ModelConfigField, { openai: string | null; anthropic: string | null }> = {
  MODEL: { openai: 'model', anthropic: 'model' },
  // Orizu consumes protocol selection; it is not a provider request field.
  PROTOCOL: { openai: null, anthropic: null },
  THINKING_LEVEL: { openai: 'reasoning.effort', anthropic: 'output_config.effort' },
  MAX_OUTPUT_TOKENS: { openai: 'max_output_tokens', anthropic: 'max_tokens' },
  TEMPERATURE: { openai: 'temperature', anthropic: 'temperature' },
  TOP_P: { openai: 'top_p', anthropic: 'top_p' },
  // Orizu consumes strict schema selection; it is not a provider request field.
  STRICT_JSON_SCHEMA: { openai: null, anthropic: null },
}
