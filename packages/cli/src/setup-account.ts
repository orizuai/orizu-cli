import { hasResolvableAuth } from './credentials.js'
import {
  getBaseUrl,
  type AuthenticatedRequestContext,
} from './http.js'

export interface SetupAuthState {
  state: 'signed-in' | 'signed-out'
  baseUrl: string
}

export function describeSetupAuthState(): SetupAuthState {
  const baseUrl = getBaseUrl()
  return {
    // An environment bearer (ORIZU_TOKEN / ORIZU_TOKEN_FILE) is signed-in too.
    state: hasResolvableAuth(baseUrl) ? 'signed-in' : 'signed-out',
    baseUrl,
  }
}

export function validateSetupIdentityEmail(value: unknown): string {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return ''

  const email = value.trim()
  if (!email || email.length > 254 || /\s/.test(email)) return ''
  const parts = email.split('@')
  if (parts.length !== 2) return ''

  const [localPart, domain] = parts
  if (
    !localPart
    || localPart.length > 64
    || localPart.startsWith('.')
    || localPart.endsWith('.')
    || localPart.includes('..')
    || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(localPart)
  ) return ''

  if (!domain || domain.length > 253) return ''
  const labels = domain.split('.')
  if (labels.some(label =>
    !label
    || label.length > 63
    || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
  )) return ''

  return email
}

function identityRecovery(context: AuthenticatedRequestContext): string {
  if (context.source === 'ORIZU_TOKEN') {
    return 'Rotate or unset ORIZU_TOKEN and rerun `orizu setup`.'
  }
  if (context.source === 'ORIZU_TOKEN_FILE') {
    return 'Fix, rotate, or unset ORIZU_TOKEN_FILE and rerun `orizu setup`.'
  }
  return 'Run `orizu login` and rerun `orizu setup`.'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateAgentUserId(value: unknown): string {
  if (typeof value !== 'string') return ''
  const userId = value.trim()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)
    ? userId
    : ''
}

function isCredentialStoreError(error: unknown): error is Error {
  return error instanceof Error && /^ORIZU_CREDENTIALS_[A-Z_]+:/.test(error.message)
}

async function fetchSetupDisplayIdentity(context: AuthenticatedRequestContext): Promise<string> {
  let response: Response
  try {
    response = await context.fetch('/api/cli/auth/whoami')
  } catch (error) {
    if (isCredentialStoreError(error)) throw error
    throw new Error(`Could not identify the authenticated account. ${identityRecovery(context)}`)
  }
  if (!response.ok) {
    throw new Error(`Could not identify the authenticated account. ${identityRecovery(context)}`)
  }

  let data: unknown
  try {
    data = await response.json()
  } catch {
    throw new Error(`Could not identify the authenticated account. ${identityRecovery(context)}`)
  }
  if (!isRecord(data) || !isRecord(data.user)) {
    throw new Error(`Could not identify the authenticated account. ${identityRecovery(context)}`)
  }

  const email = validateSetupIdentityEmail(data.user.email)
  if (email) return email
  if (data.user.email === null) {
    const agentUserId = validateAgentUserId(data.user.id)
    if (agentUserId) return `Agent ${agentUserId}`
    throw new Error(`The authenticated account has no usable email or agent ID. ${identityRecovery(context)}`)
  }
  throw new Error(`The authenticated account has no usable email. ${identityRecovery(context)}`)
}

export async function confirmExistingSetupAccount(
  context: AuthenticatedRequestContext,
  chooseAccount: (displayIdentity: string) => Promise<'continue' | 'switch'>,
  switchAccount: () => Promise<void>,
  options: { dryRun?: boolean } = {}
): Promise<'continued' | 'switched'> {
  const choice = await chooseAccount(await fetchSetupDisplayIdentity(context))
  if (choice === 'continue') return 'continued'

  if (options.dryRun) {
    throw new Error(
      'Account switching cannot be previewed. Rerun `orizu setup` without `--dry-run` to log in with a different account.'
    )
  }
  if (context.source !== 'stored') {
    throw new Error(
      `Authentication is supplied by ${context.source}. Unset ${context.source} and rerun \`orizu setup\` to log in with a different account.`
    )
  }
  await switchAccount()
  return 'switched'
}
