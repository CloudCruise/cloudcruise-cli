import { detectAgent } from "std-env"
import { CLI_VERSION } from "./version.js"

/** How the CLI identifies itself and the coding agent driving it to the API. */
export function clientIdentity(): { client: string; agent?: string } {
  const agent = detectAgent().name
  return {
    client: `cli/${CLI_VERSION}`,
    ...(agent ? { agent } : {})
  }
}
