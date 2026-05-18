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
  if (opts.proxyEnable !== undefined || opts.proxyIp !== undefined) {
    payload.proxy = {
      ...(opts.proxyEnable !== undefined && { enable: opts.proxyEnable }),
      ...(opts.proxyIp !== undefined && { target_ip: opts.proxyIp }),
    }
  }
  return payload
}

async function applySecretStdinOptions(opts: {
  password?: string
  passwordStdin?: boolean
  tfaSecret?: string
  tfaSecretStdin?: boolean
}): Promise<void> {
  enforceNoArgSecrets(
    { "--password": opts.password, "--tfa-secret": opts.tfaSecret },
    "vault credential fields"
  )

  if (opts.passwordStdin && opts.tfaSecretStdin) {
    throw new Error("Use only one of --password-stdin or --tfa-secret-stdin")
  }
  if (opts.passwordStdin) {
    opts.password = (await readStdin()).trimEnd()
  }
  if (opts.tfaSecretStdin) {
    opts.tfaSecret = (await readStdin()).trimEnd()
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
        const auth = await resolveAuth(opts)
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
      .option("--proxy-enable", "Enable proxy for this entry")
      .option("--proxy-ip <ip>", "Target IP for proxy assignment")
      .option("--file <path>", "Path to JSON payload (assumed pre-encrypted)")
      .option("--stdin", "Read JSON payload from stdin (assumed pre-encrypted)")
  ).addHelpText("after", `
Examples:
  $ cloudcruise vault create --user-id f47ac10b-... --domain "https://app.example.com" --user-name "user@example.com" --password "s3cret"
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
        proxyEnable?: boolean
        proxyIp?: string
        file?: string
        stdin?: boolean
      } & AuthOptions
    ) => {
      try {
        if (!opts.stdin && !opts.file) {
          await applySecretStdinOptions(opts)
        }
        const auth = await resolveAuth(opts)
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
          const key = requireEncryptionKey(auth)
          validateHexKey(key)
          payload = encryptFields(
            buildPayloadFromFlags(
              opts as Required<Pick<typeof opts, "userId" | "domain">> &
                typeof opts
            ),
            key
          )
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
      .option("--proxy-enable", "Enable proxy for this entry")
      .option("--proxy-ip <ip>", "Target IP for proxy assignment")
      .option("--file <path>", "Path to JSON payload (assumed pre-encrypted)")
      .option("--stdin", "Read JSON payload from stdin (assumed pre-encrypted)")
  ).addHelpText("after", `
Examples:
  $ cloudcruise vault update --user-id f47ac10b-... --domain "https://app.example.com" --password "new_pass"
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
        proxyEnable?: boolean
        proxyIp?: string
        file?: string
        stdin?: boolean
      } & AuthOptions
    ) => {
      try {
        if (!opts.stdin && !opts.file) {
          await applySecretStdinOptions(opts)
        }
        const auth = await resolveAuth(opts)
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
          const key = requireEncryptionKey(auth)
          validateHexKey(key)
          payload = encryptFields(
            buildPayloadFromFlags(
              opts as Required<Pick<typeof opts, "userId" | "domain">> &
                typeof opts
            ),
            key
          )
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
        const auth = await resolveAuth(opts)
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
        const auth = await resolveAuth(opts)
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
