import { Command } from "commander"
import { readFileSync } from "fs"
import { resolveAuth } from "../core/auth.js"
import { ApiClient } from "../core/api-client.js"
import { outputJson, outputError } from "../core/output.js"
import { addAuthOptions, type AuthOptions } from "../core/auth-options.js"

export function registerWorkflowCommands(program: Command): void {
  const workflows = program.command("workflows").description("Manage workflows")

  addAuthOptions(
    workflows
      .command("list")
      .description("List all workflows in your workspace")
      .option("--full", "Show all fields (default shows summary only)")
  ).action(
    async (opts: { full?: boolean } & AuthOptions) => {
      try {
        const auth = resolveAuth(opts)
        const client = new ApiClient(auth)
        const data = await client.get<Record<string, unknown>[]>(
          "/workflows"
        )
        if (opts.full) {
          outputJson(data)
        } else {
          const summary = data.map((w) => ({
            id: w.id,
            name: w.name,
            description: w.description,
            created_at: w.created_at,
            updated_at: w.updated_at
          }))
          outputJson(summary)
        }
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    }
  )

  addAuthOptions(
    workflows
      .command("get <id>")
      .description("Get workflow with nodes")
  ).action(async (id: string, opts: AuthOptions) => {
    try {
      const auth = resolveAuth(opts)
      const client = new ApiClient(auth)
      const data = await client.get(`/workflows/${id}`)
      outputJson(data)
    } catch (err: unknown) {
      outputError(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
  })

  const READONLY_FIELDS = [
    "id",
    "version_id",
    "version_number",
    "created_at",
    "created_by",
    "updated_at",
    "workspace_id",
    "workflow_id",
    "loginStructure",
  ]

  addAuthOptions(
    workflows
      .command("update <id>")
      .description("Update workflow (creates new version)")
      .option("--file <path>", "Path to workflow JSON file")
      .option("--stdin", "Read workflow JSON from stdin")
      .option("--version-note <note>", "Description of changes for this version")
  ).action(
    async (
      id: string,
      opts: {
        file?: string
        stdin?: boolean
        versionNote?: string
      } & AuthOptions
    ) => {
      try {
        let body: Record<string, unknown>
        if (opts.stdin) {
          const chunks: Buffer[] = []
          for await (const chunk of process.stdin) {
            chunks.push(chunk as Buffer)
          }
          body = JSON.parse(Buffer.concat(chunks).toString("utf-8"))
        } else if (opts.file) {
          body = JSON.parse(readFileSync(opts.file, "utf-8"))
        } else {
          throw new Error("Provide --file <path> or --stdin")
        }

        for (const field of READONLY_FIELDS) {
          delete body[field]
        }

        if (opts.versionNote) {
          body.version_note = opts.versionNote
        }

        const auth = resolveAuth(opts)
        const client = new ApiClient(auth)
        const data = await client.put(`/workflows/${id}`, body)
        outputJson(data)
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    }
  )
}
