import type { McpServer } from "@modelcontextprotocol/server"
import * as z from "zod/v4"
import { strata, text, type ToolContext } from "./common.js"

// The areas in search's description, from the last spec read. Only the first
// request waits for them; later ones refresh them in the background, so a slow
// spec fetch never delays a request.
let areas: string[] | undefined

export async function registerSearch(server: McpServer, tool: ToolContext): Promise<void> {
  const next = strata(tool)
    .categories()
    .catch(() => [])
    .then((found) => (areas = found))
  const categories = areas ?? (await next)

  server.registerTool(
    "search",
    {
      title: "Search CloudCruise operations",
      description: [
        "Find the CloudCruise API operations that do what the user asked.",
        categories.length ? `Areas: ${categories.join(", ")}.` : "",
        "Describe the task in plain words, e.g. \"list my workflows\". Each result gives an operation's name, what it does and returns, and the arguments `call` takes. Search before `call`."
      ]
        .filter(Boolean)
        .join(" "),
      inputSchema: z.object({
        query: z.string().describe("The task in plain words"),
        limit: z.number().int().min(1).max(10).optional().describe("How many operations to return, default 5")
      }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ query, limit }, ctx) => {
      const found = await strata(tool, ctx).search(query, { limit })
      if (!found.length) return text("No operations match. Try other words.")
      // The description says what an operation returns; output schemas would only cost tokens.
      return text(
        JSON.stringify(
          found.map(({ name, summary, description, hints, input }) => ({ name, summary, description, hints, input }))
        )
      )
    }
  )
}
