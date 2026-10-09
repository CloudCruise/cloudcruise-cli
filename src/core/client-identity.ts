import { detectAgent } from "std-env"
import { CLI_VERSION } from "./version.js"

export function clientIdentityHeaders(): Record<string, string> {
  const agent = detectAgent().name
  return {
    "X-CloudCruise-Client": `cli/${CLI_VERSION}`,
    ...(agent ? { "X-CloudCruise-Agent": agent } : {})
  }
}
