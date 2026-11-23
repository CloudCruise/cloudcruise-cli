import { Command } from "commander"
import { resolveAuth } from "../core/auth.js"
import { ApiClient } from "../core/api-client.js"
import { outputJson } from "../core/output.js"
import { fail, UsageError } from "../core/exit.js"
import { addAuthOptions, type AuthOptions } from "../core/auth-options.js"
import {
  SITE_SETTING_KEYS,
  type ApplySiteSettingsDefaultsRequest,
  type ClearSiteSettingsOverridesRequest,
  type SiteSettingKey,
  type SiteSettings,
  type SiteSettingsEntry,
  type SiteSettingsEntryOverrides,
  type SiteSettingsUpdate,
} from "../types/vault.js"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_COOKIE_DOMAIN_LENGTH = 128

function collect(value: string, previous: string[] | false = []): string[] {
  return [...(previous || []), value]
}

function parseBoolean(flag: string, value: string): boolean {
  if (value === "true") return true
  if (value === "false") return false
  throw new UsageError(`${flag} must be true or false (got "${value}")`)
}

export function assertSettingKey(flag: string, key: string): asserts key is SiteSettingKey {
  if (!SITE_SETTING_KEYS.includes(key as SiteSettingKey)) {
    throw new UsageError(
      `Invalid ${flag} value "${key}". Must be one of: ${SITE_SETTING_KEYS.join(", ")}.`
    )
  }
}

export type SiteSettingsUpdateFlags = {
  domain: string
  maxConcurrency?: string
  allowMultipleSessions?: string
  preventConcurrencyDuringLogin?: string
  expiryTimeFromLastUse?: string
  expiryTimeFromSessionDataSet?: string
  persistCookies?: string
  persistLocalStorage?: string
  persistSessionStorage?: string
  skipCsrfCookies?: string
  cookieDomainToStore?: string
  loginWorkflowId?: string
  clear?: string[] | false
}

/**
 * The PATCH /vault/site-settings body: the domain, each given setting with its
 * value, and each --clear setting as an explicit null (which removes the
 * domain's default; omitting a setting leaves it unchanged).
 */
export function buildSiteSettingsUpdate(opts: SiteSettingsUpdateFlags): SiteSettingsUpdate {
  const body: Record<string, unknown> = { domain: opts.domain }
  if (opts.maxConcurrency !== undefined) {
    const value = Number(opts.maxConcurrency)
    if (!Number.isInteger(value) || value < 1) {
      throw new UsageError("--max-concurrency must be an integer of at least 1")
    }
    body.max_concurrency = value
  }
  const booleans: [string, string, string | undefined][] = [
    ["--allow-multiple-sessions", "allow_multiple_sessions", opts.allowMultipleSessions],
    ["--prevent-concurrency-during-login", "prevent_concurrency_during_login", opts.preventConcurrencyDuringLogin],
    ["--persist-cookies", "persist_cookies", opts.persistCookies],
    ["--persist-local-storage", "persist_local_storage", opts.persistLocalStorage],
    ["--persist-session-storage", "persist_session_storage", opts.persistSessionStorage],
    ["--skip-csrf-cookies", "skip_csrf_cookies", opts.skipCsrfCookies],
  ]
  for (const [flag, key, value] of booleans) {
    if (value !== undefined) body[key] = parseBoolean(flag, value)
  }
  if (opts.expiryTimeFromLastUse !== undefined) {
    body.expiry_time_from_last_use = opts.expiryTimeFromLastUse
  }
  if (opts.expiryTimeFromSessionDataSet !== undefined) {
    body.expiry_time_from_session_data_set = opts.expiryTimeFromSessionDataSet
  }
  if (opts.cookieDomainToStore !== undefined) {
    if (opts.cookieDomainToStore.length > MAX_COOKIE_DOMAIN_LENGTH) {
      throw new UsageError(
        `--cookie-domain-to-store must be at most ${MAX_COOKIE_DOMAIN_LENGTH} characters`
      )
    }
    body.cookie_domain_to_store = opts.cookieDomainToStore
  }
  if (opts.loginWorkflowId !== undefined) {
    if (!UUID.test(opts.loginWorkflowId)) {
      throw new UsageError("--login-workflow-id must be a workflow UUID")
    }
    body.login_workflow_id = opts.loginWorkflowId
  }
  for (const key of opts.clear || []) {
    assertSettingKey("--clear", key)
    if (key in body) {
      throw new UsageError(`${key} is both set and cleared; pass only one of its flag and --clear ${key}`)
    }
    body[key] = null
  }
  if (Object.keys(body).length === 1) {
    throw new UsageError(
      "Pass at least one setting to change (for example --max-concurrency 2) or --clear <setting>"
    )
  }
  return body as SiteSettingsUpdate
}

export function buildApplyDefaultsBody(opts: {
  domain: string
  entryId?: string[] | false
}): ApplySiteSettingsDefaultsRequest {
  const body: ApplySiteSettingsDefaultsRequest = { domain: opts.domain }
  if (opts.entryId && opts.entryId.length > 0) {
    for (const id of opts.entryId) {
      if (!UUID.test(id)) throw new UsageError(`--entry-id must be an entry UUID (got "${id}")`)
    }
    body.entry_ids = opts.entryId
  }
  return body
}

export function buildClearOverridesBody(opts: {
  userId: string
  domain: string
  key: string[] | false
}): ClearSiteSettingsOverridesRequest {
  const keys = opts.key || []
  if (keys.length === 0) {
    throw new UsageError(
      `Pass at least one --key to reset. Keys: ${SITE_SETTING_KEYS.join(", ")}`
    )
  }
  for (const key of keys) assertSettingKey("--key", key)
  return {
    permissioned_user_id: opts.userId,
    domain: opts.domain,
    keys: keys as SiteSettingKey[],
  }
}

const SETTINGS_HELP = `
Settings: ${SITE_SETTING_KEYS.join(", ")}.
A null setting means the domain sets nothing and the platform default applies.
An entry's own value always wins over the domain's. On an entry, max_concurrency
-1 or an expiry of "0 seconds" turns that limit off although the domain sets a
value; null means the entry inherits the domain's.
`

export function registerSiteSettingsCommands(vault: Command): void {
  const siteSettings = vault
    .command("site-settings")
    .description("Manage domain settings: the defaults every vault entry on a domain inherits")

  addAuthOptions(
    siteSettings
      .command("list")
      .description("List the workspace's domain settings with entry counts and override counts")
  ).addHelpText("after", `
Examples:
  $ cloudcruise vault site-settings list

Each item has the domain, its settings, entry_count (entries on the domain) and
overrides (for each setting, how many entries set their own value).
${SETTINGS_HELP}`).action(async (opts: AuthOptions) => {
    try {
      const client = new ApiClient(await resolveAuth(opts))
      outputJson(await client.get<SiteSettings[]>("/vault/site-settings"))
    } catch (err: unknown) {
      fail(err)
    }
  })

  addAuthOptions(
    siteSettings
      .command("update")
      .description("Set the defaults of a domain; only the settings you pass change")
      .requiredOption("--domain <domain>", "Domain the settings apply to. Normalised like entry domains (lowercase, no scheme, path or www)")
      .option("--max-concurrency <n>", "Maximum concurrent sessions per entry (at least 1)")
      .option("--allow-multiple-sessions <true|false>", "Allow several sessions of one entry at once")
      .option("--prevent-concurrency-during-login <true|false>", "Hold other sessions of an entry while one logs in")
      .option("--expiry-time-from-last-use <interval>", 'Session expiry after the last use, for example "7 days"')
      .option("--expiry-time-from-session-data-set <interval>", 'Session expiry after the session data was stored, for example "30 days"')
      .option("--persist-cookies <true|false>", "Keep cookies between runs")
      .option("--persist-local-storage <true|false>", "Keep local storage between runs")
      .option("--persist-session-storage <true|false>", "Keep session storage between runs")
      .option("--skip-csrf-cookies <true|false>", "Do not store CSRF cookies")
      .option("--cookie-domain-to-store <domain>", "Only store cookies of this domain (at most 128 characters)")
      .option("--login-workflow-id <uuid>", "Workflow that logs entries in")
      .option("--clear <setting>", "Remove the domain's default for a setting (sends null). Repeatable", collect)
  ).addHelpText("after", `
Examples:
  $ cloudcruise vault site-settings update --domain app.example.com --max-concurrency 2 --persist-cookies true
  $ cloudcruise vault site-settings update --domain app.example.com --expiry-time-from-last-use "7 days"
  $ cloudcruise vault site-settings update --domain app.example.com --clear max_concurrency --clear login_workflow_id

Creates the domain's settings when it has none yet. Settings you do not pass are
unchanged; --clear removes a default. Entries that set their own value keep it;
use \`vault site-settings apply-defaults\` to reset them. Prints the updated
domain settings.
${SETTINGS_HELP}`).action(async (opts: SiteSettingsUpdateFlags & AuthOptions) => {
    try {
      const body = buildSiteSettingsUpdate(opts)
      const client = new ApiClient(await resolveAuth(opts))
      outputJson(await client.patch<SiteSettings>("/vault/site-settings", body))
    } catch (err: unknown) {
      fail(err)
    }
  })

  addAuthOptions(
    siteSettings
      .command("entries")
      .description("List the vault entries on a domain and the settings each sets itself")
      .requiredOption("--domain <domain>", "Domain to list the entries of")
  ).addHelpText("after", `
Examples:
  $ cloudcruise vault site-settings entries --domain app.example.com

Each item has the entry id, its permissioned_user_id and overridden: the settings
the entry sets itself instead of inheriting the domain default.
`).action(async (opts: { domain: string } & AuthOptions) => {
    try {
      const client = new ApiClient(await resolveAuth(opts))
      const params = new URLSearchParams({ domain: opts.domain })
      outputJson(await client.get<SiteSettingsEntry[]>(`/vault/site-settings/entries?${params}`))
    } catch (err: unknown) {
      fail(err)
    }
  })

  addAuthOptions(
    siteSettings
      .command("apply-defaults")
      .description("Make vault entries read every setting from their domain's defaults")
      .requiredOption("--domain <domain>", "Domain whose defaults the entries use")
      .option("--entry-id <uuid>", "Entry to reset (an id from `site-settings entries`). Repeatable; omit to reset every entry on the domain", collect)
  ).addHelpText("after", `
Examples:
  $ cloudcruise vault site-settings apply-defaults --domain app.example.com
  $ cloudcruise vault site-settings apply-defaults --domain app.example.com --entry-id 3f1c0d7e-... --entry-id 9a2b4c6d-...

Removes every setting the entries set themselves, so they read all settings from
the domain defaults. Without --entry-id it applies to every entry on the domain.
Prints the updated domain settings.
`).action(async (opts: { domain: string; entryId?: string[] | false } & AuthOptions) => {
    try {
      const body = buildApplyDefaultsBody(opts)
      const client = new ApiClient(await resolveAuth(opts))
      outputJson(await client.patch<SiteSettings>("/vault/site-settings/entries", body))
    } catch (err: unknown) {
      fail(err)
    }
  })

  addAuthOptions(
    siteSettings
      .command("overrides")
      .description("Show the settings a vault entry sets itself")
      .requiredOption("--user-id <id>", "Permissioned user ID")
      .requiredOption("--domain <domain>", "Domain of the entry")
  ).addHelpText("after", `
Examples:
  $ cloudcruise vault site-settings overrides --user-id f47ac10b-... --domain app.example.com

Prints the entry id, its domain and overridden: the settings the entry stores
itself. Every other setting is read from the domain.
`).action(async (opts: { userId: string; domain: string } & AuthOptions) => {
    try {
      const client = new ApiClient(await resolveAuth(opts))
      const params = new URLSearchParams({
        permissioned_user_id: opts.userId,
        domain: opts.domain,
      })
      outputJson(
        await client.get<SiteSettingsEntryOverrides>(`/vault/site-settings/overrides?${params}`)
      )
    } catch (err: unknown) {
      fail(err)
    }
  })

  addAuthOptions(
    siteSettings
      .command("reset-overrides")
      .description("Stop a vault entry from overriding settings, so it reads them from its domain again")
      .requiredOption("--user-id <id>", "Permissioned user ID")
      .requiredOption("--domain <domain>", "Domain of the entry")
      .option("--key <setting>", "Setting the entry stops overriding. Repeatable, at least one", collect)
  ).addHelpText("after", `
Examples:
  $ cloudcruise vault site-settings reset-overrides --user-id f47ac10b-... --domain app.example.com --key max_concurrency --key persist_cookies

Prints the settings the entry still overrides.
${SETTINGS_HELP}`).action(
    async (opts: { userId: string; domain: string; key: string[] | false } & AuthOptions) => {
      try {
        const body = buildClearOverridesBody(opts)
        const client = new ApiClient(await resolveAuth(opts))
        outputJson(
          await client.patch<SiteSettingsEntryOverrides>("/vault/site-settings/overrides", body)
        )
      } catch (err: unknown) {
        fail(err)
      }
    }
  )
}
