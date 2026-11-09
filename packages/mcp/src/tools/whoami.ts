import type { StrataClient } from "@cloudcruise/strata"
import type { McpServer } from "@modelcontextprotocol/server"
import { apiFailure, client, type ToolContext } from "./common.js"

interface Me {
  userId?: string
  email?: string
}

interface MyWorkspace {
  id: string
  name: string
  organization_name: string | null
  role: string | null
}

export function registerWhoami(server: McpServer, tool: ToolContext): void {
  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description: "Show the signed-in CloudCruise user and the workspaces they belong to.",
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async (ctx) => {
      const api = client(tool, ctx)
      try {
        const [me, workspaces] = await Promise.all([api.get<Me>("/users/me"), listWorkspaces(api)])
        const out = { user_id: me.userId ?? null, email: me.email ?? null, workspaces }
        return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out }
      } catch (err) {
        return apiFailure(err)
      }
    }
  )
}

async function listWorkspaces(api: StrataClient) {
  const rows = await api.get<MyWorkspace[]>("/me/workspaces")
  return rows.map(({ id, name, organization_name, role }) => ({
    id,
    name,
    organization: organization_name,
    role
  }))
}
