import { Command } from "commander"

export interface AuthOptions {
  apiKey?: string
  baseUrl?: string
  profile?: string
}

export function addAuthOptions(cmd: Command): Command {
  return cmd
    .option("--api-key <key>", "CloudCruise API key")
    .option("--base-url <url>", "Base URL for CloudCruise API")
    .option("--profile <name>", "Auth profile to use")
}
