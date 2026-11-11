import { McpServer } from "@modelcontextprotocol/server"
import type { Config } from "../config.js"
import { registerBuild, type BuildTiming } from "./build.js"
import { registerCall } from "./call.js"
import { errorResult, VERSION } from "./common.js"
import { stepUpMessage } from "../step-up.js"
import { registerObserve, type ObserveTiming } from "./observe.js"
import { registerRun } from "./run.js"
import { registerSearch } from "./search.js"
import { registerWhoami } from "./whoami.js"

export { VERSION } from "./common.js"
export type { BuildTiming } from "./build.js"
export type { ObserveTiming } from "./observe.js"

export interface TestHooks {
  /** How observe paces its reads; only tests change it. */
  observeTiming?: ObserveTiming
  /** How often build reports progress while a builder starts; only tests change it. */
  buildTiming?: BuildTiming
}

/** One server per HTTP request: the token is that request's, never shared. */
export async function createServer(
  config: Config,
  token: string,
  hooks: TestHooks = {},
  stepUpUrl?: string
): Promise<McpServer> {
  const server = new McpServer({ name: "cloudcruise", version: VERSION })
  // Until the user confirms this connector, every tool, whoami included, answers with
  // the link. The tool list stays the same, so the client sees nothing else change.
  if (stepUpUrl) {
    const register = server.registerTool.bind(server)
    server.registerTool = ((name: string, toolConfig: unknown) =>
      register(name, toolConfig as never, (() => errorResult(stepUpMessage(stepUpUrl))) as never)) as typeof server.registerTool
  }
  const tool = { config, token }
  await registerSearch(server, tool)
  registerCall(server, tool)
  registerWhoami(server, tool)
  registerRun(server, tool)
  registerObserve(server, tool, hooks.observeTiming)
  registerBuild(server, tool, hooks.buildTiming)
  return server
}
