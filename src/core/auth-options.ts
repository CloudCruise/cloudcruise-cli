import { Command } from "commander"

export interface AuthOptions {
  apiKey?: string
  baseUrl?: string
  appUrl?: string
  profile?: string
  workspaceId?: string
  encryptionKey?: string
}

export function addAuthOptions(cmd: Command): Command {
  return cmd
    .option("--api-key <key>", "Legacy CloudCruise API key (rejected by default; use a profile or environment variable)")
    .option("--base-url <url>", "Base URL for CloudCruise API")
    .option("--app-url <url>", "Frontend app URL for builder links (overrides inference from --base-url)")
    .option("--profile <name>", "Auth profile to use")
    .option("--workspace-id <id>", "Workspace ID to use for OAuth requests")
    .option("--encryption-key <key>", "Hex-encoded AES-256 encryption key for vault operations (rejected by default; use a profile or environment variable)")
}
