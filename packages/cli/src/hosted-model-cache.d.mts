export function refreshHostedModels(options?: { env?: Record<string, string | undefined>; required?: string[]; strict?: boolean; fetchImpl?: typeof fetch; signal?: AbortSignal }): Promise<string>
export function bakeHostedModels(): Promise<string>
