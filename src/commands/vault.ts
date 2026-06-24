import { Command } from "commander"
import { readFileSync } from "fs"
import { resolveAuth, requireEncryptionKey } from "../core/auth.js"
import { ApiClient } from "../core/api-client.js"
import { encrypt, decrypt, validateHexKey } from "../core/crypto.js"
import { outputJson, outputError } from "../core/output.js"
import { addAuthOptions, type AuthOptions } from "../core/auth-options.js"
import { enforceNoArgSecrets } from "../core/secret-args.js"
import type { VaultEntry, VaultEntryPayload } from "../types/vault.js"

const ENCRYPTED_FIELDS = ["user_name", "password", "tfa_secret"] as const
const PROXY_SETTINGS = ["random", "static", "country", "custom"] as const

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
      result[field] = encrypt(JSON.stringify(value), hexKey)
    }
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
    throw new Error(
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
      result.proxy_value = encrypt(JSON.stringify(value), hexKey)
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
    const value = result[field]
    if (typeof value === "string" && value.length > 0) {
      try {
        const raw = decrypt(value, hexKey)
        result[field] = JSON.parse(raw)
      } catch {
        // Leave as-is if decryption fails (field may be null/empty)
      }
    }
  }
  if (result.proxy_setting === "custom") {
    const value = result.proxy_value
    if (typeof value === "string" && value.length > 0) {
      try {
        result.proxy_value = JSON.parse(decrypt(value, hexKey))
      } catch {
        // Leave as-is if decryption fails
      }
    }
  }
  return result
}

function buildPayloadFromFlags(opts: {
  userId: string
  domain: string
  userName?: string
  password?: string
  userAlias?: string
  tfaSecret?: string
  tfaMethod?: string
  proxyEnable?: boolean
  proxyIp?: string
  proxy?: string
  proxyValue?: string
  secretProviderId?: string
  secretRef?: string
  secretCacheTtlSeconds?: string
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    permissioned_user_id: opts.userId,
    domain: opts.domain,
  }
  if (opts.userName !== undefined) payload.user_name = opts.userName
  if (opts.password !== undefined) payload.password = opts.password
  if (opts.userAlias !== undefined) payload.user_alias = opts.userAlias
  if (opts.tfaSecret !== undefined) payload.tfa_secret = opts.tfaSecret
  if (opts.tfaMethod !== undefined) payload.tfa_method = opts.tfaMethod
  if (opts.secretProviderId !== undefined) {
    if (!opts.secretRef) {
      throw new Error("--secret-provider-id requires --secret-ref")
    }
    payload.secret_provider_id = opts.secretProviderId
  }
  if (opts.secretRef !== undefined) {
    if (!opts.secretProviderId) {
      throw new Error("--secret-ref requires --secret-provider-id")
    }
    payload.secret_ref = opts.secretRef
  }
  if (opts.secretCacheTtlSeconds !== undefined) {
    if (!opts.secretProviderId || !opts.secretRef) {
      throw new Error(
        "--secret-cache-ttl-seconds requires --secret-provider-id and --secret-ref"
      )
    }
    const ttl = Number(opts.secretCacheTtlSeconds)
    if (!Number.isInteger(ttl) || ttl < 0) {
      throw new Error("--secret-cache-ttl-seconds must be a non-negative integer")
    }
    payload.secret_cache_ttl_seconds = ttl
  }
  if (opts.proxy !== undefined) {
    if (!PROXY_SETTINGS.includes(opts.proxy as (typeof PROXY_SETTINGS)[number])) {
      throw new Error(
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

function requiresEncryptionKeyForFlags(opts: {
  userName?: string
  password?: string
  passwordStdin?: boolean
  tfaSecret?: string
  tfaSecretStdin?: boolean
  proxy?: string
  proxyValue?: string
  proxyValueStdin?: boolean
}): boolean {
  return Boolean(
    opts.userName !== undefined ||
      opts.password !== undefined ||
      opts.passwordStdin ||
      opts.tfaSecret !== undefined ||
      opts.tfaSecretStdin ||
      (isCustomProxy(opts.proxy) &&
        (opts.proxyValue !== undefined || opts.proxyValueStdin))
  )
}

async function applySecretStdinOptions(opts: {
  password?: string
  passwordStdin?: boolean
  tfaSecret?: string
  tfaSecretStdin?: boolean
  proxy?: string
  proxyValue?: string
  proxyValueStdin?: boolean
}): Promise<void> {
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

  const stdinFlags = [
    opts.passwordStdin,
    opts.tfaSecretStdin,
    opts.proxyValueStdin,
  ].filter(Boolean)
  if (stdinFlags.length > 1) {
    throw new Error(
      "Use only one of --password-stdin, --tfa-secret-stdin, or --proxy-value-stdin"
    )
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
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString("utf-8")
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
        outputJson(data)
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
      outputError(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
  })

  // vault get
  addAuthOptions(
    vault
      .command("get")
      .description("Get a vault entry by user ID and domain")
      .requiredOption("--user-id <id>", "Permissioned user ID")
      .requiredOption("--domain <domain>", "Target domain")
      .option("--decrypt", "Decrypt credential fields client-side")
  ).addHelpText("after", `
Examples:
  $ cloudcruise vault get --user-id f47ac10b-58cc-4372-a567-0e02b2c3d479 --domain "https://app.example.com"
  $ cloudcruise vault get --user-id f47ac10b-58cc-4372-a567-0e02b2c3d479 --domain "https://app.example.com" --decrypt
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
          outputJson(data)
        }
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    }
  )

  // vault create
  addAuthOptions(
    vault
      .command("create")
      .description("Create a new vault entry")
      .option("--user-id <id>", "Permissioned user ID")
      .option("--domain <domain>", "Target domain (valid URI)")
      .option("--user-name <name>", "Username (plaintext, will be encrypted)")
      .option("--password <pass>", "Password (plaintext, will be encrypted). Visible in ps output; prefer --password-stdin")
      .option("--password-stdin", "Read plaintext password from stdin")
      .option("--user-alias <alias>", "Human-readable alias")
      .option("--tfa-secret <secret>", "TOTP secret in base32 (plaintext, will be encrypted). Visible in ps output; prefer --tfa-secret-stdin")
      .option("--tfa-secret-stdin", "Read plaintext TOTP secret from stdin")
      .option("--tfa-method <method>", "TFA method: AUTHENTICATOR, EMAIL, or SMS")
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
  ).addHelpText("after", `
Examples:
  $ cloudcruise vault create --user-id f47ac10b-... --domain "https://app.example.com" --user-name "user@example.com" --password "s3cret"
  $ cloudcruise vault create --user-id acme-prod --domain "https://acme.com" --secret-provider-id 25290e80-bbd5-41b3-861e-dea30cc26e27 --secret-ref "op://vaultId/itemId"
  $ cloudcruise vault create --file payload.json
  $ cat payload.json | cloudcruise vault create --stdin
`).action(
    async (
      opts: {
        userId?: string
        domain?: string
        userName?: string
        password?: string
        passwordStdin?: boolean
        userAlias?: string
        tfaSecret?: string
        tfaSecretStdin?: boolean
        tfaMethod?: string
        secretProviderId?: string
        secretRef?: string
        secretCacheTtlSeconds?: string
        proxyEnable?: boolean
        proxyIp?: string
        proxy?: string
        proxyValue?: string
        proxyValueStdin?: boolean
        file?: string
        stdin?: boolean
      } & AuthOptions
    ) => {
      try {
        if (!opts.stdin && !opts.file) {
          await applySecretStdinOptions(opts)
        }
        const needsEncryptionKey =
          !opts.stdin && !opts.file && requiresEncryptionKeyForFlags(opts)
        const auth = await resolveAuth({
          ...opts,
          requireEncryptionKey: needsEncryptionKey,
        })
        const client = new ApiClient(auth)
        let payload: Record<string, unknown>

        if (opts.stdin) {
          payload = JSON.parse(await readStdin())
        } else if (opts.file) {
          payload = JSON.parse(readFileSync(opts.file, "utf-8"))
        } else {
          if (!opts.userId || !opts.domain) {
            throw new Error(
              "Provide --user-id and --domain, or use --file/--stdin"
            )
          }
          payload = buildPayloadFromFlags(
            opts as Required<Pick<typeof opts, "userId" | "domain">> &
              typeof opts
          )
          if (needsEncryptionKey) {
            const key = requireEncryptionKey(auth)
            validateHexKey(key)
            payload = encryptFields(payload, key)
          }
        }

        const data = await client.post<VaultEntry>("/vault", payload)
        outputJson(data)
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    }
  )

  // vault update
  addAuthOptions(
    vault
      .command("update")
      .description("Update an existing vault entry")
      .option("--user-id <id>", "Permissioned user ID")
      .option("--domain <domain>", "Target domain")
      .option("--user-name <name>", "Username (plaintext, will be encrypted)")
      .option("--password <pass>", "Password (plaintext, will be encrypted). Visible in ps output; prefer --password-stdin")
      .option("--password-stdin", "Read plaintext password from stdin")
      .option("--user-alias <alias>", "Human-readable alias")
      .option("--tfa-secret <secret>", "TOTP secret in base32 (plaintext, will be encrypted). Visible in ps output; prefer --tfa-secret-stdin")
      .option("--tfa-secret-stdin", "Read plaintext TOTP secret from stdin")
      .option("--tfa-method <method>", "TFA method: AUTHENTICATOR, EMAIL, or SMS")
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
  ).addHelpText("after", `
Examples:
  $ cloudcruise vault update --user-id f47ac10b-... --domain "https://app.example.com" --password "new_pass"
  $ cloudcruise vault update --user-id acme-prod --domain "https://acme.com" --secret-provider-id 25290e80-bbd5-41b3-861e-dea30cc26e27 --secret-ref "op://vaultId/itemId"
  $ cloudcruise vault update --file payload.json
  $ cat payload.json | cloudcruise vault update --stdin
`).action(
    async (
      opts: {
        userId?: string
        domain?: string
        userName?: string
        password?: string
        passwordStdin?: boolean
        userAlias?: string
        tfaSecret?: string
        tfaSecretStdin?: boolean
        tfaMethod?: string
        secretProviderId?: string
        secretRef?: string
        secretCacheTtlSeconds?: string
        proxyEnable?: boolean
        proxyIp?: string
        proxy?: string
        proxyValue?: string
        proxyValueStdin?: boolean
        file?: string
        stdin?: boolean
      } & AuthOptions
    ) => {
      try {
        if (!opts.stdin && !opts.file) {
          await applySecretStdinOptions(opts)
        }
        const needsEncryptionKey =
          !opts.stdin && !opts.file && requiresEncryptionKeyForFlags(opts)
        const auth = await resolveAuth({
          ...opts,
          requireEncryptionKey: needsEncryptionKey,
        })
        const client = new ApiClient(auth)
        let payload: Record<string, unknown>

        if (opts.stdin) {
          payload = JSON.parse(await readStdin())
        } else if (opts.file) {
          payload = JSON.parse(readFileSync(opts.file, "utf-8"))
        } else {
          if (!opts.userId || !opts.domain) {
            throw new Error(
              "Provide --user-id and --domain, or use --file/--stdin"
            )
          }
          payload = buildPayloadFromFlags(
            opts as Required<Pick<typeof opts, "userId" | "domain">> &
              typeof opts
          )
          if (needsEncryptionKey) {
            const key = requireEncryptionKey(auth)
            validateHexKey(key)
            payload = encryptFields(payload, key)
          }
        }

        const data = await client.put<VaultEntry>("/vault", payload)
        outputJson(data)
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
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
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
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
          throw new Error("Provide <plaintext> argument or --stdin")
        }

        const toEncrypt = opts.raw ? value : JSON.stringify(value)
        outputJson({ ciphertext: encrypt(toEncrypt, key) })
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
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
          throw new Error("Provide <ciphertext> argument or --stdin")
        }

        const decrypted = decrypt(value, key)
        const result = opts.raw ? decrypted : JSON.parse(decrypted)
        outputJson({ plaintext: result })
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    }
  )
}
