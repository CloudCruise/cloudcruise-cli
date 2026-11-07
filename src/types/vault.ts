export type VaultTfaMethod = "AUTHENTICATOR" | "EMAIL" | "MAGIC_LINK" | "SMS"

export type VaultFieldType =
  | "Text"
  | "Email"
  | "Url"
  | "Phone"
  | "Date"
  | "MonthYear"
  | "Address"
  | "Concealed"
  | "Totp"

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
  domain: string
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

export interface VaultEntryPayload {
  id?: string
  permissioned_user_id: string
  domain: string
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
