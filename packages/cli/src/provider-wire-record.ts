/** Preserve the provider commands' permissive ordinary-TypeScript row coercion. */
export function providerWireRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {}
}
