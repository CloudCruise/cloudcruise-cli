import type { McpServer } from "@modelcontextprotocol/server"
import { apiFailure, client, type ToolContext } from "./common.js"

interface Me {
  userId?: string
  email?: string
  workspaceId?: string
}

export function registerWhoami(server: McpServer, tool: ToolContext): void {
  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description:
        "Show the CloudCruise account this connector is signed in as: user id, email and workspace id.",
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async (ctx) => {
      try {
        const me = await client(tool, ctx).get<Me>("/users/me")
        const out = {
          user_id: me.userId ?? null,
          email: me.email ?? null,
          workspace_id: me.workspaceId ?? null
        }
        return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out }
      } catch (err) {
        return apiFailure(err)
      }
    }
  )
}
