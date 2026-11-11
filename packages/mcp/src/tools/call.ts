import { CallError } from "@cloudcruise/strata"
import type { McpServer } from "@modelcontextprotocol/server"
import * as z from "zod/v4"
import { RECONNECT, TOKEN_REJECTED, errorResult, strata, text, workspaceIdInput, type ToolContext } from "./common.js"

export function registerCall(server: McpServer, tool: ToolContext): void {
  server.registerTool(
    "call",
    {
      title: "Call a CloudCruise operation",
      description:
        "Run a CloudCruise API operation found with `search`, as the signed-in user. Pass its name and arguments that fit its input schema: path and query parameters at the top level, the request body under `body`.",
      inputSchema: z.object({
        operation: z.string().describe("The operation's name from search, e.g. workflows.list"),
        arguments: z.record(z.string(), z.unknown()).optional().describe("Arguments that fit the operation's input schema"),
        workspace_id: workspaceIdInput
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
    },
    async ({ operation, arguments: args, workspace_id }, ctx) => {
      try {
        const { data } = await strata(tool, ctx, workspace_id).call(operation, args ?? {})
        return text(data === undefined ? "Done. The API returned no content." : JSON.stringify(data))
      } catch (err) {
        // Anything else thrown becomes an error result with its message, via the SDK.
        if (err instanceof CallError && err.status === 401 && TOKEN_REJECTED.test(err.message)) {
          return errorResult(RECONNECT)
        }
        throw err
      }
    }
  )
}
