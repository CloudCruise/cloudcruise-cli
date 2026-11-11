import type { McpServer } from "@modelcontextprotocol/server"
import * as z from "zod/v4"
import { apiFailure, client, errorResult, formatHandle, structured, workspaceIdInput, type ToolContext } from "./common.js"

export function registerRun(server: McpServer, tool: ToolContext): void {
  server.registerTool(
    "run",
    {
      title: "Run a workflow",
      description:
        "Start a run of a CloudCruise workflow with its input variables. Returns at once with a handle; the run continues on its own. To follow it, use observe.",
      inputSchema: z.object({
        workflow_id: z.guid().describe("The workflow to run"),
        inputs: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("The workflow's input variables, matching its input schema"),
        workspace_id: workspaceIdInput
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: { "anthropic/alwaysLoad": true }
    },
    async ({ workflow_id, inputs, workspace_id }, ctx) => {
      try {
        const { session_id } = await client(tool, ctx, workspace_id).post<{ session_id: string }>("/run", {
          workflow_id,
          run_input_variables: inputs ?? {}
        })
        if (typeof session_id !== "string" || !session_id) {
          return errorResult("The CloudCruise API started no run: its reply had no session id.")
        }
        const out = {
          handle: formatHandle({ kind: "run", workspaceId: workspace_id, id: session_id }),
          next: "The run continues on its own. To follow it, call observe with this handle."
        }
        return structured(out)
      } catch (err) {
        return apiFailure(err)
      }
    }
  )
}
