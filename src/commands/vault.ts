import { Command } from "commander"
import { resolveAuth, requireEncryptionKey } from "../core/auth.js"
import { ApiClient } from "../core/api-client.js"
import { encrypt, decrypt, validateHexKey } from "../core/crypto.js"
import { outputJson } from "../core/output.js"
import { fail, UsageError } from "../core/exit.js"
import { addAuthOptions, type AuthOptions } from "../core/auth-options.js"
import { enforceNoArgSecrets } from "../core/secret-args.js"
import {
  hasJsonObjectSource,
  readJsonArray,
  readJsonObject,
  readStdin,
  type JsonObjectSource,
} from "../core/input.js"
import {
  VAULT_FIELD_TYPES,
  VAULT_TFA_METHODS,
  type VaultAdditionalField,
  type VaultEntry,
  type VaultEntryPayload,
  type VaultSecurityQuestion,
  type VaultFieldType,
  type VaultTfaMethod,
} from "../types/vault.js"

const ENCRYPTED_FIELDS = ["user_name", "password", "tfa_secret"] as const
const PROXY_SETTINGS = ["random", "static", "country", "custom"] as const

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value]
}

function assertTfaMethod(flag: string, method: string): asserts method is VaultTfaMethod {
  if (!VAULT_TFA_METHODS.includes(method as VaultTfaMethod)) {
    throw new UsageError(
      `Invalid ${flag} value "${method}". Must be one of: ${VAULT_TFA_METHODS.join(", ")}.`
    )
  }
}

function assertTfaMethods(methods: string[]): void {
  for (const method of methods) assertTfaMethod("--tfa-method", method)
  if (new Set(methods).size !== methods.length) {
    throw new UsageError("Each --tfa-method may be given only once")
  }
}

function encryptValue(value: unknown, hexKey: string): string {
  return encrypt(JSON.stringify(value), hexKey)
}

/** The plaintext of a ciphertext, or the input unchanged when it does not decrypt. */
function decryptValue(value: unknown, hexKey: string): unknown {
  if (typeof value !== "string" || value.length === 0) return value
  try {
    return JSON.parse(decrypt(value, hexKey))
  } catch {
    return value
  }
}

function isCustomProxy(setting?: string): boolean {
  return typeof setting === "string" && setting.toLowerCase() === "custom"
}

function encryptFields(
  payload: Record<string, unknown>,
  hexKey: string
): Record<string, unknown> {
  const result = { ...payload }
  for (const field of ENCRYPTED_FIELDS) {
    const value = result[field]
    if (typeof value === "string" && value.length > 0) {
      result[field] = encryptValue(value, hexKey)
    }
  }
  if (Array.isArray(result.additional_fields)) {
    result.additional_fields = (result.additional_fields as AdditionalField[]).map(
      (field) => ({ ...field, value: encryptValue(field.value, hexKey) })
    )
  }
  if (Array.isArray(result.security_questions)) {
    result.security_questions = (result.security_questions as SecurityQuestion[]).map(
      ({ question, answer }) => ({
        question: encryptValue(question, hexKey),
        answer: encryptValue(answer, hexKey),
      })
    )
  }
  // proxy_value is meaningless to the backend without proxy_setting, which is
  // also the discriminator that decides whether to encrypt. Fail closed so a
  // custom proxy URL (often with embedded credentials) is never sent in
  // plaintext because --proxy was omitted alongside --proxy-value.
  if (
    typeof result.proxy_value === "string" &&
    result.proxy_value.length > 0 &&
    (result.proxy_setting === undefined || result.proxy_setting === null)
  ) {
    throw new UsageError(
      "proxy_value requires proxy_setting. Pass --proxy custom for a bring-your-own " +
        "proxy URL (encrypted before sending), or --proxy static/country for a managed proxy."
    )
  }
  // proxy_value is the bring-your-own proxy URL only for the "custom" setting;
  // for "static"/"country" it is a plaintext IP/country code and must not be
  // encrypted. The backend decrypts it to SSRF-validate, then re-encrypts.
  if (result.proxy_setting === "custom") {
    const value = result.proxy_value
    if (typeof value === "string" && value.length > 0) {
      result.proxy_value = encryptValue(value, hexKey)
    }
  }
  return result
}

function decryptFields(
  entry: Record<string, unknown>,
  hexKey: string
): Record<string, unknown> {
  const result = { ...entry }
  for (const field of ENCRYPTED_FIELDS) {
    result[field] = decryptValue(result[field], hexKey)
  }
  if (result.proxy_setting === "custom") {
    result.proxy_value = decryptValue(result.proxy_value, hexKey)
  }
  if (Array.isArray(result.additional_fields)) {
    result.additional_fields = (result.additional_fields as AdditionalField[]).map(
      (field) => ({ ...field, value: decryptValue(field.value, hexKey) })
    )
  }
  if (Array.isArray(result.security_questions)) {
    result.security_questions = (result.security_questions as SecurityQuestion[]).map(
      ({ question, answer }) => ({
        question: decryptValue(question, hexKey),
        answer: decryptValue(answer, hexKey),
      })
    )
  }
  return result
}

function withoutListValues(entry: Record<string, unknown>): Record<string, unknown> {
  const result = { ...entry }
  if (Array.isArray(result.additional_fields)) {
    result.additional_fields = (result.additional_fields as AdditionalField[]).map(
      ({ name, type }) => ({ name, type })
    )
  }
  if (Array.isArray(result.security_questions)) {
    result.security_questions = (result.security_questions as SecurityQuestion[]).map(
      ({ question }) => ({ question })
    )
  }
  return result
}

type AdditionalField = Omit<VaultAdditionalField, "value"> & { value: unknown }
type SecurityQuestion = VaultSecurityQuestion

type EntryFlags = {
  userId?: string
  domain?: string
  userName?: string
  password?: string
  passwordStdin?: boolean
  userAlias?: string
  tfaSecret?: string
  tfaSecretStdin?: boolean
  tfaMethod?: string[]
  secretProviderId?: string
  secretRef?: string
  secretCacheTtlSeconds?: string
  proxyEnable?: boolean
  proxyIp?: string
  proxy?: string
  proxyValue?: string
  proxyValueStdin?: boolean
  additionalFieldsFile?: string
  additionalFieldsStdin?: boolean
  securityQuestionsFile?: string
  securityQuestionsStdin?: boolean
  additionalFields?: AdditionalField[]
  securityQuestions?: SecurityQuestion[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseAdditionalFields(flag: string, items: unknown[]): AdditionalField[] {
  return items.map((item, index) => {
    const at = `${flag} item ${index + 1}`
    if (!isObject(item)) throw new UsageError(`${at} must be an object {name, type, value}`)
    const { name, type, value } = item
    if (typeof name !== "string" || name.length === 0) {
      throw new UsageError(`${at}: name must be a non-empty string`)
    }
    if (!VAULT_FIELD_TYPES.includes(type as VaultFieldType)) {
      throw new UsageError(
        `${at} (${name}): type must be one of: ${VAULT_FIELD_TYPES.join(", ")}`
      )
    }
    if (type === "Address" ? !isObject(value) : typeof value !== "string") {
      throw new UsageError(
        `${at} (${name}): value must be ${type === "Address" ? "an object {street, city, state, zip, country}" : "a string"}`
      )
    }
    return { name, type: type as VaultFieldType, value }
  })
}

function parseSecurityQuestions(flag: string, items: unknown[]): SecurityQuestion[] {
  return items.map((item, index) => {
    const at = `${flag} item ${index + 1}`
    if (
      !isObject(item) ||
      typeof item.question !== "string" ||
      typeof item.answer !== "string"
    ) {
      throw new UsageError(`${at} must be an object {question, answer} of strings`)
    }
    return { question: item.question, answer: item.answer }
  })
}

function buildPayloadFromFlags(
  opts: EntryFlags & { userId: string; domain: string }
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    permissioned_user_id: opts.userId,
    domain: opts.domain,
  }
  if (opts.userName !== undefined) payload.user_name = opts.userName
  if (opts.password !== undefined) payload.password = opts.password
  if (opts.userAlias !== undefined) payload.user_alias = opts.userAlias
  if (opts.tfaSecret !== undefined) payload.tfa_secret = opts.tfaSecret
  if (opts.tfaMethod !== undefined) payload.tfa_methods = opts.tfaMethod
  if (opts.additionalFields !== undefined) payload.additional_fields = opts.additionalFields
  if (opts.securityQuestions !== undefined) payload.security_questions = opts.securityQuestions
  if (opts.secretProviderId !== undefined) {
    if (!opts.secretRef) {
      throw new UsageError("--secret-provider-id requires --secret-ref")
    }
    payload.secret_provider_id = opts.secretProviderId
  }
  if (opts.secretRef !== undefined) {
    if (!opts.secretProviderId) {
      throw new UsageError("--secret-ref requires --secret-provider-id")
    }
    payload.secret_ref = opts.secretRef
  }
  if (opts.secretCacheTtlSeconds !== undefined) {
    if (!opts.secretProviderId || !opts.secretRef) {
      throw new UsageError(
        "--secret-cache-ttl-seconds requires --secret-provider-id and --secret-ref"
      )
    }
    const ttl = Number(opts.secretCacheTtlSeconds)
    if (!Number.isInteger(ttl) || ttl < 0) {
      throw new UsageError("--secret-cache-ttl-seconds must be a non-negative integer")
    }
    payload.secret_cache_ttl_seconds = ttl
  }
  if (opts.proxy !== undefined) {
    if (!PROXY_SETTINGS.includes(opts.proxy as (typeof PROXY_SETTINGS)[number])) {
      throw new UsageError(
        `Invalid --proxy value "${opts.proxy}". Must be one of: ${PROXY_SETTINGS.join(", ")}.`
      )
    }
    payload.proxy_setting = opts.proxy
  }
  if (opts.proxyValue !== undefined) payload.proxy_value = opts.proxyValue
  if (opts.proxyEnable !== undefined || opts.proxyIp !== undefined) {
    payload.proxy = {
      ...(opts.proxyEnable !== undefined && { enable: opts.proxyEnable }),
      ...(opts.proxyIp !== undefined && { target_ip: opts.proxyIp }),
    }
  }
  return payload
}

function requiresEncryptionKeyForFlags(opts: EntryFlags): boolean {
  return Boolean(
    opts.userName !== undefined ||
      opts.password !== undefined ||
      opts.passwordStdin ||
      opts.tfaSecret !== undefined ||
      opts.tfaSecretStdin ||
      opts.additionalFields?.length ||
      opts.securityQuestions?.length ||
      (isCustomProxy(opts.proxy) &&
        (opts.proxyValue !== undefined || opts.proxyValueStdin))
  )
}

async function applyFlagInputs(opts: EntryFlags): Promise<void> {
  const secrets: Record<string, unknown> = {
    "--password": opts.password,
    "--tfa-secret": opts.tfaSecret,
  }
  // A custom proxy URL can embed credentials (e.g. socks5://user:pass@host);
  // treat it like other secrets and refuse it on argv. For static/country the
  // value is a non-secret IP/country code, so it stays allowed as an argument.
  if (isCustomProxy(opts.proxy)) {
    secrets["--proxy-value"] = opts.proxyValue
  }
  enforceNoArgSecrets(secrets, "vault credential fields")
  if (opts.tfaMethod !== undefined) assertTfaMethods(opts.tfaMethod)

  const stdinFlags = [
    opts.passwordStdin && "--password-stdin",
    opts.tfaSecretStdin && "--tfa-secret-stdin",
    opts.proxyValueStdin && "--proxy-value-stdin",
    opts.additionalFieldsStdin && "--additional-fields-stdin",
    opts.securityQuestionsStdin && "--security-questions-stdin",
  ].filter(Boolean)
  if (stdinFlags.length > 1) {
    throw new UsageError(
      `Only one flag can read stdin (got ${stdinFlags.join(", ")})`
    )
  }
  if (opts.additionalFieldsFile !== undefined && opts.additionalFieldsStdin) {
    throw new UsageError("Pass only one of --additional-fields-file, --additional-fields-stdin")
  }
  if (opts.securityQuestionsFile !== undefined && opts.securityQuestionsStdin) {
    throw new UsageError("Pass only one of --security-questions-file, --security-questions-stdin")
  }
  if (opts.passwordStdin) {
    opts.password = (await readStdin()).trimEnd()
  }
  if (opts.tfaSecretStdin) {
    opts.tfaSecret = (await readStdin()).trimEnd()
  }
  if (opts.proxyValueStdin) {
    opts.proxyValue = (await readStdin()).trimEnd()
  }
  const fieldsFlag = opts.additionalFieldsStdin
    ? "--additional-fields-stdin"
    : "--additional-fields-file"
  const fields = await readJsonArray(fieldsFlag, {
    file: opts.additionalFieldsFile,
    stdin: opts.additionalFieldsStdin,
  })
  if (fields) opts.additionalFields = parseAdditionalFields(fieldsFlag, fields)
  const questionsFlag = opts.securityQuestionsStdin
    ? "--security-questions-stdin"
    : "--security-questions-file"
  const questions = await readJsonArray(questionsFlag, {
    file: opts.securityQuestionsFile,
    stdin: opts.securityQuestionsStdin,
  })
  if (questions) opts.securityQuestions = parseSecurityQuestions(questionsFlag, questions)
}

const FIELD_FLAGS = {
  userId: "--user-id",
  domain: "--domain",
  userName: "--user-name",
  password: "--password",
  passwordStdin: "--password-stdin",
  userAlias: "--user-alias",
  tfaSecret: "--tfa-secret",
  tfaSecretStdin: "--tfa-secret-stdin",
  tfaMethod: "--tfa-method",
  secretProviderId: "--secret-provider-id",
  secretRef: "--secret-ref",
  secretCacheTtlSeconds: "--secret-cache-ttl-seconds",
  proxyEnable: "--proxy-enable",
  proxyIp: "--proxy-ip",
  proxy: "--proxy",
  proxyValue: "--proxy-value",
  proxyValueStdin: "--proxy-value-stdin",
  additionalFieldsFile: "--additional-fields-file",
  additionalFieldsStdin: "--additional-fields-stdin",
  securityQuestionsFile: "--security-questions-file",
  securityQuestionsStdin: "--security-questions-stdin",
} as const

/**
 * The entry comes from the field flags or from --file/--stdin, never both, so
 * no flag is silently dropped.
 */
export function assertFlagsOrPayload(
  opts: Partial<Record<keyof typeof FIELD_FLAGS, unknown>> & JsonObjectSource
): void {
  if (!hasJsonObjectSource(opts)) return
  const passed = (Object.keys(FIELD_FLAGS) as (keyof typeof FIELD_FLAGS)[])
    .filter((key) => opts[key] !== undefined)
    .map((key) => FIELD_FLAGS[key])
  if (passed.length > 0) {
    throw new UsageError(
      `Pass the entry as flags or as a JSON object via --file/--stdin, not both (got ${passed.join(", ")})`
    )
  }
}

function addEntryOptions(command: Command, domainHelp: string): Command {
  return command
    .option("--user-id <id>", "Permissioned user ID")
    .option("--domain <domain>", domainHelp)
    .option("--user-name <name>", "Username (plaintext, will be encrypted)")
    .option("--password <pass>", "Password (plaintext, will be encrypted). Visible in ps output; prefer --password-stdin")
    .option("--password-stdin", "Read plaintext password from stdin")
    .option("--user-alias <alias>", "Human-readable alias")
    .option("--tfa-secret <secret>", "TOTP secret in base32 (plaintext, will be encrypted). Visible in ps output; prefer --tfa-secret-stdin")
    .option("--tfa-secret-stdin", "Read plaintext TOTP secret from stdin")
    .option("--tfa-method <method>", "TFA method: AUTHENTICATOR, EMAIL, MAGIC_LINK, or SMS. Repeat for several methods", collect)
    .option("--additional-fields-file <path>", "JSON array of plaintext additional fields [{name, type, value}] (values will be encrypted). Replaces the entry's list")
    .option("--additional-fields-stdin", "Read the additional fields JSON array from stdin")
    .option("--security-questions-file <path>", "JSON array of plaintext security questions [{question, answer}] (will be encrypted). Replaces the entry's list")
    .option("--security-questions-stdin", "Read the security questions JSON array from stdin")
    .option("--secret-provider-id <id>", "Secret-provider connection ID for provider-backed credentials")
    .option("--secret-ref <ref>", "Secret-provider item reference, for example op://vaultId/itemId")
    .option("--secret-cache-ttl-seconds <seconds>", "Override provider cache TTL for this credential")
    .option("--proxy-enable", "Enable proxy for this entry")
    .option("--proxy-ip <ip>", "Target IP for proxy assignment")
    .option("--proxy <setting>", "Proxy setting: random, static, country, or custom")
    .option("--proxy-value <value>", "For static: target IP. For country: country code. For custom: proxy URL — may contain credentials; prefer --proxy-value-stdin")
    .option("--proxy-value-stdin", "Read the custom proxy URL from stdin (avoids leaking credentials into shell history)")
    .option("--file <path>", "Path to JSON payload (assumed pre-encrypted)")
    .option("--stdin", "Read JSON payload from stdin (assumed pre-encrypted)")
}

const ENTRY_LISTS_HELP = `
Additional fields (--additional-fields-file/-stdin), plaintext; the CLI encrypts each value:
  [{"name": "Member ID", "type": "Text", "value": "M-123"},
   {"name": "Home", "type": "Address", "value": {"street": "1 Main St", "city": "Springfield", "state": "IL", "zip": "62701", "country": "US"}},
   {"name": "Backup OTP", "type": "Totp", "value": "JBSWY3DPEHPK3PXP..."}]
  Types: ${VAULT_FIELD_TYPES.join(", ")}. Address values are objects, all others strings.

Security questions (--security-questions-file/-stdin), plaintext; the CLI encrypts question and answer:
  [{"question": "What is your mother's maiden name?", "answer": "Smith"}]

A list replaces the entry's stored list; [] clears it; omit the flag to keep it.
Only one flag can read stdin.
Pass the entry as flags or as a JSON object via --file/--stdin, not both.
`

async function writeEntry(
  method: "post" | "put",
  opts: EntryFlags & JsonObjectSource & AuthOptions
): Promise<void> {
  assertFlagsOrPayload(opts)
  if (!opts.stdin && !opts.file) {
    await applyFlagInputs(opts)
  }
  const needsEncryptionKey =
    !opts.stdin && !opts.file && requiresEncryptionKeyForFlags(opts)
  const auth = await resolveAuth({
    ...opts,
    requireEncryptionKey: needsEncryptionKey,
  })
  const client = new ApiClient(auth)
  let payload: Record<string, unknown>

  const input = await readJsonObject(opts)
  if (input) {
    payload = input
  } else {
    if (!opts.userId || !opts.domain) {
      throw new UsageError(
        "Provide --user-id and --domain, or use --file/--stdin"
      )
    }
    payload = buildPayloadFromFlags({ ...opts, userId: opts.userId, domain: opts.domain })
    if (needsEncryptionKey) {
      const key = requireEncryptionKey(auth)
      validateHexKey(key)
      payload = encryptFields(payload, key)
    }
  }

  const data = await client[method]<VaultEntry>("/vault", payload)
  outputJson(data)
}

export function registerVaultCommands(program: Command): void {
  const vault = program.command("vault").description("Manage vault credentials")

  // vault list
  addAuthOptions(
    vault
      .command("list")
      .description("List all vault entries in your workspace")
      .option("--full", "Show all fields (default shows summary only)")
  ).addHelpText("after", `
Examples:
  $ cloudcruise vault list
  $ cloudcruise vault list --full
`).action(async (opts: { full?: boolean } & AuthOptions) => {
    try {
      const auth = await resolveAuth(opts)
      const client = new ApiClient(auth)
      const data = await client.get<VaultEntry[]>("/vault")
      if (opts.full) {
        outputJson(
          data.map((e) => withoutListValues(e as unknown as Record<string, unknown>))
        )
      } else {
        const summary = data.map((e) => ({
          id: e.id,
          permissioned_user_id: e.permissioned_user_id,
          domain: e.domain,
          secret_provider_id: e.secret_provider_id,
          user_alias: e.user_alias,
          created_at: e.created_at,
        }))
        outputJson(summary)
      }
    } catch (err: unknown) {
      fail(err)
    }
  })

  // vault get
  addAuthOptions(
    vault
      .command("get")
      .description("Get a vault entry by user ID and domain")
      .requiredOption("--user-id <id>", "Permissioned user ID")
      .requiredOption("--domain <domain>", "Target domain")
      .option("--decrypt", "Decrypt credential fields client-side, including additional field values and security question answers")
  ).addHelpText("after", `
Examples:
  $ cloudcruise vault get --user-id f47ac10b-58cc-4372-a567-0e02b2c3d479 --domain "https://app.example.com"
  $ cloudcruise vault get --user-id f47ac10b-58cc-4372-a567-0e02b2c3d479 --domain "https://app.example.com" --decrypt

Without --decrypt, additional fields show name and type only, and security
questions show the encrypted question only. --decrypt adds field values and
decrypts questions and answers.
`).action(
    async (
      opts: {
        userId: string
        domain: string
        decrypt?: boolean
      } & AuthOptions
    ) => {
      try {
        const auth = await resolveAuth({
          ...opts,
          requireEncryptionKey: Boolean(opts.decrypt),
        })
        const client = new ApiClient(auth)
        const params = new URLSearchParams({
          permissioned_user_id: opts.userId,
          domain: opts.domain,
        })
        const data = await client.get<VaultEntry>(`/vault?${params}`)
        if (opts.decrypt) {
          const key = requireEncryptionKey(auth)
          validateHexKey(key)
          outputJson(decryptFields(data as unknown as Record<string, unknown>, key))
        } else {
          outputJson(withoutListValues(data as unknown as Record<string, unknown>))
        }
      } catch (err: unknown) {
        fail(err)
      }
    }
  )

  // vault create
  addAuthOptions(
    addEntryOptions(
      vault.command("create").description("Create a new vault entry"),
      "Target domain (valid URI)"
    )
  ).addHelpText("after", `
Examples:
  $ cloudcruise vault create --user-id f47ac10b-... --domain "https://app.example.com" --user-name "user@example.com" --password "s3cret"
  $ cloudcruise vault create --user-id f47ac10b-... --domain "https://app.example.com" --tfa-method AUTHENTICATOR --tfa-method EMAIL --additional-fields-file fields.json --security-questions-file questions.json
  $ cloudcruise vault create --user-id acme-prod --domain "https://acme.com" --secret-provider-id 25290e80-bbd5-41b3-861e-dea30cc26e27 --secret-ref "op://vaultId/itemId"
  $ cloudcruise vault create --file payload.json
  $ cat payload.json | cloudcruise vault create --stdin
${ENTRY_LISTS_HELP}`).action(async (opts: EntryFlags & JsonObjectSource & AuthOptions) => {
    try {
      await writeEntry("post", opts)
    } catch (err: unknown) {
      fail(err)
    }
  })

  // vault update
  addAuthOptions(
    addEntryOptions(
      vault.command("update").description("Update an existing vault entry"),
      "Target domain"
    )
  ).addHelpText("after", `
Examples:
  $ cloudcruise vault update --user-id f47ac10b-... --domain "https://app.example.com" --password "new_pass"
  $ cat fields.json | cloudcruise vault update --user-id f47ac10b-... --domain "https://app.example.com" --additional-fields-stdin
  $ cloudcruise vault update --user-id acme-prod --domain "https://acme.com" --secret-provider-id 25290e80-bbd5-41b3-861e-dea30cc26e27 --secret-ref "op://vaultId/itemId"
  $ cloudcruise vault update --file payload.json
  $ cat payload.json | cloudcruise vault update --stdin
${ENTRY_LISTS_HELP}`).action(async (opts: EntryFlags & JsonObjectSource & AuthOptions) => {
    try {
      await writeEntry("put", opts)
    } catch (err: unknown) {
      fail(err)
    }
  })

  // vault tfa-code
  addAuthOptions(
    vault
      .command("tfa-code")
      .description("Get the current 2FA code of a vault entry")
      .requiredOption("--user-id <id>", "Permissioned user ID")
      .requiredOption("--domain <domain>", "Target domain")
      .option("--method <method>", "TFA method to read: AUTHENTICATOR or EMAIL. Required when the entry has several methods")
      .option("--field <name>", "Name of a Totp additional field to generate the code from instead of the built-in TFA secret")
  ).addHelpText("after", `
Examples:
  $ cloudcruise vault tfa-code --user-id f47ac10b-... --domain "https://app.example.com"
  $ cloudcruise vault tfa-code --user-id f47ac10b-... --domain "https://app.example.com" --method EMAIL
  $ cloudcruise vault tfa-code --user-id f47ac10b-... --domain "https://app.example.com" --field "Backup OTP"

AUTHENTICATOR returns a fresh code with expires_in_seconds. EMAIL returns the
latest received code with received_at, or 404 when none arrived recently.
SMS and MAGIC_LINK codes cannot be read (409).
`).action(
    async (
      opts: { userId: string; domain: string; method?: string; field?: string } & AuthOptions
    ) => {
      try {
        if (opts.method !== undefined) assertTfaMethod("--method", opts.method)
        const auth = await resolveAuth(opts)
        const client = new ApiClient(auth)
        const params = new URLSearchParams({
          permissioned_user_id: opts.userId,
          domain: opts.domain,
        })
        if (opts.method !== undefined) params.set("method", opts.method)
        if (opts.field !== undefined) params.set("field", opts.field)
        outputJson(await client.get(`/vault/tfa-code?${params}`))
      } catch (err: unknown) {
        fail(err)
      }
    }
  )

  // vault clear-state
  addAuthOptions(
    vault
      .command("clear-state")
      .description("Clear stored browser state (cookies, localStorage, sessionStorage) for a vault entry")
      .requiredOption("--user-id <id>", "Permissioned user ID")
      .requiredOption("--domain <domain>", "Target domain")
  ).addHelpText("after", `
Examples:
  $ cloudcruise vault clear-state --user-id f47ac10b-... --domain "https://app.example.com"
`).action(
    async (opts: { userId: string; domain: string } & AuthOptions) => {
      try {
        const auth = await resolveAuth(opts)
        const client = new ApiClient(auth)
        const data = await client.patch<{ success: boolean }>(
          "/vault/clear-browser-state",
          {
            permissioned_user_id: opts.userId,
            domain: opts.domain,
          }
        )
        outputJson(data)
      } catch (err: unknown) {
        fail(err)
      }
    }
  )

  // vault encrypt
  addAuthOptions(
    vault
      .command("encrypt [plaintext]")
      .description("Encrypt a string with the workspace encryption key (no API call)")
      .option("--stdin", "Read plaintext from stdin")
      .option("--raw", "Skip JSON serialization (encrypt raw bytes)")
  ).addHelpText("after", `
Examples:
  $ cloudcruise vault encrypt "my secret value"
  $ echo "secret" | cloudcruise vault encrypt --stdin
`).action(
    async (
      plaintext: string | undefined,
      opts: { stdin?: boolean; raw?: boolean } & AuthOptions
    ) => {
      try {
        if (!opts.stdin && plaintext !== undefined) {
          enforceNoArgSecrets({ plaintext }, "vault encrypt")
        }
        const auth = await resolveAuth({ ...opts, requireEncryptionKey: true })
        const key = requireEncryptionKey(auth)
        validateHexKey(key)

        let value: string
        if (opts.stdin) {
          value = (await readStdin()).trimEnd()
        } else if (plaintext !== undefined) {
          value = plaintext
        } else {
          throw new UsageError("Provide <plaintext> argument or --stdin")
        }

        const toEncrypt = opts.raw ? value : JSON.stringify(value)
        outputJson({ ciphertext: encrypt(toEncrypt, key) })
      } catch (err: unknown) {
        fail(err)
      }
    }
  )

  // vault decrypt
  addAuthOptions(
    vault
      .command("decrypt [ciphertext]")
      .description("Decrypt a ciphertext with the workspace encryption key (no API call)")
      .option("--stdin", "Read ciphertext from stdin")
      .option("--raw", "Skip JSON deserialization (return raw decrypted bytes)")
  ).addHelpText("after", `
Examples:
  $ cloudcruise vault decrypt "abc123encrypted..."
  $ echo "abc123encrypted..." | cloudcruise vault decrypt --stdin
`).action(
    async (
      ciphertext: string | undefined,
      opts: { stdin?: boolean; raw?: boolean } & AuthOptions
    ) => {
      try {
        const auth = await resolveAuth({ ...opts, requireEncryptionKey: true })
        const key = requireEncryptionKey(auth)
        validateHexKey(key)

        let value: string
        if (opts.stdin) {
          value = (await readStdin()).trimEnd()
        } else if (ciphertext !== undefined) {
          value = ciphertext
        } else {
          throw new UsageError("Provide <ciphertext> argument or --stdin")
        }

        const decrypted = decrypt(value, key)
        const result = opts.raw ? decrypted : JSON.parse(decrypted)
        outputJson({ plaintext: result })
      } catch (err: unknown) {
        fail(err)
      }
    }
  )
}
