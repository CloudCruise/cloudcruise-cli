export type SecretProviderType = "1password"

export interface SecretProvider {
  id: string
  provider_type: SecretProviderType
  name: string
  cache_ttl_seconds?: number | null
}

export interface SecretProviderItem {
  id: string
  title: string
  ref: string
  vaultName?: string | null
}
