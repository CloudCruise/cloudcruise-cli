import { Entry } from "@napi-rs/keyring"

const SERVICE = "cloudcruise"

export interface OAuthTokens {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  tokenType?: string
  scope?: string
}

function keychainUnavailableMessage(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err)
  return [
    "No OS credential store is available.",
    "CloudCruise stores reusable credentials only in the OS keychain.",
    "Configure macOS Keychain, Windows Credential Manager, or Linux Secret Service/libsecret.",
    `Keychain error: ${detail}`
  ].join(" ")
}

export function tokenAccountForProfile(profile: string): string {
  return `profile:${profile}`
}

export function apiKeyAccountForProfile(profile: string): string {
  return `api-key:${profile}`
}

export function encryptionKeyAccountForProfile(profile: string): string {
  return `encryption-key:${profile}`
}

export function loadOAuthTokens(account: string): OAuthTokens | null {
  try {
    const raw = new Entry(SERVICE, account).getPassword()
    return raw ? (JSON.parse(raw) as OAuthTokens) : null
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.toLowerCase().includes("noentry")) return null
    throw new Error(keychainUnavailableMessage(err))
  }
}

export function saveOAuthTokens(account: string, tokens: OAuthTokens): void {
  try {
    new Entry(SERVICE, account).setPassword(JSON.stringify(tokens))
  } catch (err: unknown) {
    throw new Error(keychainUnavailableMessage(err))
  }
}

export function deleteOAuthTokens(account: string): void {
  try {
    new Entry(SERVICE, account).deletePassword()
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.toLowerCase().includes("noentry")) return
    throw new Error(keychainUnavailableMessage(err))
  }
}

export function loadApiKey(account: string): string | null {
  try {
    return new Entry(SERVICE, account).getPassword()
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.toLowerCase().includes("noentry")) return null
    throw new Error(keychainUnavailableMessage(err))
  }
}

export function saveApiKey(account: string, apiKey: string): void {
  try {
    new Entry(SERVICE, account).setPassword(apiKey)
  } catch (err: unknown) {
    throw new Error(keychainUnavailableMessage(err))
  }
}

export function deleteApiKey(account: string): void {
  try {
    new Entry(SERVICE, account).deletePassword()
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.toLowerCase().includes("noentry")) return
    throw new Error(keychainUnavailableMessage(err))
  }
}

export function loadEncryptionKey(account: string): string | null {
  return loadApiKey(account)
}

export function saveEncryptionKey(account: string, encryptionKey: string): void {
  saveApiKey(account, encryptionKey)
}

export function deleteEncryptionKey(account: string): void {
  deleteApiKey(account)
}
