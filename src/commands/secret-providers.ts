import { Command } from "commander"
import { resolveAuth } from "../core/auth.js"
import { ApiClient } from "../core/api-client.js"
import { addAuthOptions, type AuthOptions } from "../core/auth-options.js"
import { outputError, outputJson } from "../core/output.js"
import type { SecretProvider, SecretProviderItem } from "../types/secret-providers.js"

export function registerSecretProviderCommands(program: Command): void {
  const secretProviders = program
    .command("secret-providers")
    .description("Manage secret-provider connections")

  addAuthOptions(
    secretProviders
      .command("list")
      .description("List secret-provider connections in your workspace")
  ).addHelpText("after", `
Examples:
  $ cloudcruise secret-providers list
`).action(async (opts: AuthOptions) => {
    try {
      const auth = await resolveAuth(opts)
      const client = new ApiClient(auth)
      const data = await client.get<SecretProvider[]>("/secret-providers")
      outputJson(data)
    } catch (err: unknown) {
      outputError(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
  })

  addAuthOptions(
    secretProviders
      .command("items <provider-id>")
      .description("List items visible to a secret-provider connection")
  ).addHelpText("after", `
Examples:
  $ cloudcruise secret-providers items 25290e80-bbd5-41b3-861e-dea30cc26e27
`).action(async (providerId: string, opts: AuthOptions) => {
    try {
      const auth = await resolveAuth(opts)
      const client = new ApiClient(auth)
      const data = await client.get<SecretProviderItem[]>(
        `/secret-providers/${providerId}/items`
      )
      outputJson(data)
    } catch (err: unknown) {
      outputError(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
  })
}
