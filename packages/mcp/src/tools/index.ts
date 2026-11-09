import { McpServer } from "@modelcontextprotocol/server"
import type { Config } from "../config.js"
import { registerCall } from "./call.js"
import { VERSION } from "./common.js"
import { registerProbes } from "./probe.js"
import { registerSearch } from "./search.js"
import { registerWhoami } from "./whoami.js"

export { VERSION } from "./common.js"

/** One server per HTTP request: the token is that request's, never shared. */
export async function createServer(config: Config, token: string): Promise<McpServer> {
  const server = new McpServer({ name: "cloudcruise", version: VERSION })
  const tool = { config, token }
  await registerSearch(server, tool)
  registerCall(server, tool)
  registerWhoami(server, tool)
  registerProbes(server)
  return server
}
