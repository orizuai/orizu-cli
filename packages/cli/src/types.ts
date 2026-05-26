export interface SessionServerCredentials {
  credentialType?: 'session'
  accessToken: string
  refreshToken: string
  expiresAt: number
}

export interface PatServerCredentials {
  credentialType: 'pat'
  apiKey: string
}

export type ServerCredentials = SessionServerCredentials | PatServerCredentials

export interface StoredCredentialsV1 {
  baseUrl: string
  accessToken: string
  refreshToken: string
  expiresAt: number
}

export interface StoredCredentialsV2 {
  version: 2
  activeBaseUrl: string | null
  servers: Record<string, SessionServerCredentials>
}

export interface StoredCredentialsV3 {
  version: 3
  activeBaseUrl: string | null
  servers: Record<string, ServerCredentials>
}

// Backward-compatible alias for legacy callers.
export type StoredCredentials = StoredCredentialsV1

export interface LoginResponse {
  apiKey?: string
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  user: {
    id: string
    email: string | null
  }
}
