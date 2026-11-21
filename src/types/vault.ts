export const VAULT_TFA_METHODS = ["AUTHENTICATOR", "EMAIL", "MAGIC_LINK", "SMS"] as const

export type VaultTfaMethod = (typeof VAULT_TFA_METHODS)[number]

export const VAULT_FIELD_TYPES = [
  "Text",
  "Email",
  "Url",
  "Phone",
  "Date",
  "MonthYear",
  "Address",
  "Concealed",
  "Totp",
] as const

export type VaultFieldType = (typeof VAULT_FIELD_TYPES)[number]

/** `value` is workspace-key ciphertext. */
export interface VaultAdditionalField {
  name: string
  type: VaultFieldType
  value: string
}

/** `question` and `answer` are workspace-key ciphertext. */
export interface VaultSecurityQuestion {
  question: string
  answer: string
}

export interface VaultEntry {
  id: string
  permissioned_user_id: string
  /** Null for an entry without a domain. */
  domain: string | null
  user_name: string | null
  password: string | null
  secret_provider_id: string | null
  secret_ref: string | null
  secret_cache_ttl_seconds: number | null
  user_alias: string | null
  tfa_secret: string | null
  tfa_method: VaultTfaMethod | null
  tfa_methods: VaultTfaMethod[]
  tfa_email: string | null
  tfa_phone_number: string | null
  workspace_id: string
  user_id: string | null
  created_at: string | null
  updated_at: string | null
  session_storage: Record<string, unknown> | null
  local_storage: Record<string, unknown> | null
  cookies: VaultCookie[] | null
  persist_local_storage: boolean
  persist_cookies: boolean
  persist_session_storage: boolean
  skip_csrf_cookies: boolean
  cookie_domain_to_store: string | null
  allow_multiple_sessions: boolean
  max_concurrency: number | null
  prevent_concurrency_during_login: boolean | null
  expiry_time_from_last_use: string | null
  expiry_time_from_session_data_set: string | null
  effective_expires_at: string | null
  session_data_set_at: string | null
  ip_address: string | null
  location: string | null
  proxy_string: string | null
  proxy_setting: "random" | "static" | "country" | "custom" | null
  proxy_value: string | null
  additional_fields: VaultAdditionalField[]
  additional_field_warnings?: { name: string; reason: string }[]
  security_questions: VaultSecurityQuestion[]
  security_question_warnings?: { question: string; reason: string }[]
}

/** The settings a domain sets for every vault entry on it; the keys an entry can override. */
export const SITE_SETTING_KEYS = [
  "max_concurrency",
  "allow_multiple_sessions",
  "prevent_concurrency_during_login",
  "expiry_time_from_last_use",
  "expiry_time_from_session_data_set",
  "persist_cookies",
  "persist_local_storage",
  "persist_session_storage",
  "skip_csrf_cookies",
  "cookie_domain_to_store",
  "login_workflow_id",
] as const


export type SiteSettingKey = (typeof SITE_SETTING_KEYS)[number]

export interface VaultEntryPayload {
  id?: string
  permissioned_user_id: string
  domain?: string
  user_name?: string
  password?: string
  secret_provider_id?: string
  secret_ref?: string
  secret_cache_ttl_seconds?: number
  user_alias?: string
  tfa_secret?: string
  tfa_method?: VaultTfaMethod
  tfa_methods?: VaultTfaMethod[]
  additional_fields?: VaultAdditionalField[]
  security_questions?: VaultSecurityQuestion[]
  cookies?: VaultCookie[]
  session_storage?: Record<string, unknown>
  local_storage?: Record<string, unknown>
  persist_local_storage?: boolean
  persist_cookies?: boolean
  persist_session_storage?: boolean
  skip_csrf_cookies?: boolean
  cookie_domain_to_store?: string
  allow_multiple_sessions?: boolean
  max_concurrency?: number
  prevent_concurrency_during_login?: boolean
  expiry_time_from_last_use?: string
  expiry_time_from_session_data_set?: string
  proxy?: {
    enable?: boolean
    target_ip?: string
  }
  proxy_setting?: "random" | "static" | "country" | "custom"
  proxy_value?: string
  /** Request only: settings stored on the entry as its own value even when equal to the domain's. */
  pinned_settings?: SiteSettingKey[]
}

export interface VaultCookie {
  name: string
  value: string
  domain: string
  path: string
  expirationDate?: number
  httpOnly: boolean
  hostOnly: boolean
  secure: boolean
  session: boolean
  storeId: string
  sameSite: string
}

/** A null value means the domain sets nothing and the platform default applies. */
export interface SiteSettingsValues {
  max_concurrency: number | null
  allow_multiple_sessions: boolean | null
  prevent_concurrency_during_login: boolean | null
  expiry_time_from_last_use: string | null
  expiry_time_from_session_data_set: string | null
  persist_cookies: boolean | null
  persist_local_storage: boolean | null
  persist_session_storage: boolean | null
  skip_csrf_cookies: boolean | null
  cookie_domain_to_store: string | null
  login_workflow_id: string | null
}

export interface SiteSettings {
  id: string
  domain: string
  settings: Partial<SiteSettingsValues>
  /** Entries in the workspace on this domain. */
  entry_count: number
  /** For each setting, how many entries on the domain set their own value. */
  overrides: Record<string, number>
}

/** Body of PATCH /vault/site-settings: only the listed settings change, null clears one. */
export type SiteSettingsUpdate = { domain: string } & Partial<SiteSettingsValues>

export interface SiteSettingsEntry {
  id: string
  /** User ID of the vault entry. */
  permissioned_user_id: string
  /** Settings the entry sets itself; every other setting is read from the domain. */
  overridden: string[]
}

export interface ApplySiteSettingsDefaultsRequest {
  domain: string
  entry_ids?: string[]
}

export interface SiteSettingsEntryOverrides {
  id: string
  domain: string | null
  overridden: string[]
}

export interface ClearSiteSettingsOverridesRequest {
  permissioned_user_id: string
  domain?: string
  keys: SiteSettingKey[]
}
