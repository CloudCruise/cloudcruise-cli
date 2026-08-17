import { Command, InvalidArgumentError } from "commander"
import { readFileSync } from "fs"
import { resolveAuth } from "../core/auth.js"
import { ApiClient } from "../core/api-client.js"
import { outputJson } from "../core/output.js"
import { fail, UsageError } from "../core/exit.js"
import { addAuthOptions, type AuthOptions } from "../core/auth-options.js"

export function registerWorkflowCommands(program: Command): void {
  const workflows = program.command("workflows").description("Manage workflows")

  const parsePositiveInt = (value: string): number => {
    if (!/^\d+$/.test(value)) {
      throw new InvalidArgumentError(
        `Must be a positive integer (got: ${value}).`
      )
    }
    const n = Number(value)
    if (n < 1) {
      throw new InvalidArgumentError(`Must be >= 1 (got: ${value}).`)
    }
    return n
  }

  addAuthOptions(
    workflows
      .command("list")
      .description("List all workflows in your workspace")
      .option("--full", "Show all fields (default shows summary only)")
  ).addHelpText("after", `
Examples:
  $ cloudcruise workflows list
  $ cloudcruise workflows list --full
`).action(
    async (opts: { full?: boolean } & AuthOptions) => {
      try {
        const auth = await resolveAuth(opts)
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
        fail(err)
      }
    }
  )

  addAuthOptions(
    workflows
      .command("get <id>")
      .description("Get workflow with nodes (latest version by default)")
      .option(
        "--version-number <n>",
        "Fetch a specific historical version by version_number (use `workflows versions <id>` to list)",
        parsePositiveInt
      )
  ).addHelpText("after", `
Examples:
  $ cloudcruise workflows get wf_abc123
  $ cloudcruise workflows get wf_abc123 > workflow.json
  $ cloudcruise workflows get wf_abc123 --version-number 18
`).action(async (id: string, opts: { versionNumber?: number } & AuthOptions) => {
    try {
      const auth = await resolveAuth(opts)
      const client = new ApiClient(auth)
      const path =
        opts.versionNumber !== undefined
          ? `/workflows/${id}/versions/${opts.versionNumber}`
          : `/workflows/${id}`
      const data = await client.get(path)
      outputJson(data)
    } catch (err: unknown) {
      fail(err)
    }
  })

  addAuthOptions(
    workflows
      .command("versions <id>")
      .description("List version history for a workflow (newest first)")
      .option(
        "--limit <n>",
        "Cap the number of versions returned (client-side slice)",
        parsePositiveInt
      )
  ).addHelpText("after", `
Examples:
  $ cloudcruise workflows versions wf_abc123
  $ cloudcruise workflows versions wf_abc123 --limit 10
`).action(async (id: string, opts: { limit?: number } & AuthOptions) => {
    try {
      const auth = await resolveAuth(opts)
      const client = new ApiClient(auth)
      const data = await client.get<Record<string, unknown>[]>(
        `/workflows/${id}/versions`
      )
      const sliced =
        opts.limit !== undefined ? data.slice(0, opts.limit) : data
      outputJson(sliced)
    } catch (err: unknown) {
      fail(err)
    }
  })

  addAuthOptions(
    workflows
      .command("gen-payloads <id>")
      .description(
        "Generate schema-derived example payloads for a workflow's input_schema"
      )
  ).addHelpText("after", `
Calls POST /workflows/<id>/example-payloads. The server derives payloads from the
workflow's input_schema with the SAME validator it runs at run-start, so a
generated payload can never be one a run would reject. Returns:
  { payloads: [ { name, payload, expectedOutcome? } ] }
Write each payload into cc-workflows/<wf>/payloads/ for the test loop.

Examples:
  $ cloudcruise workflows gen-payloads wf_abc123
`).action(async (id: string, opts: AuthOptions) => {
    try {
      const auth = await resolveAuth(opts)
      const client = new ApiClient(auth)
      const data = await client.post(`/workflows/${id}/example-payloads`, {})
      outputJson(data)
    } catch (err: unknown) {
      fail(err)
    }
  })

  addAuthOptions(
    workflows
      .command("export <id>")
      .description(
        "Export a workflow as a portable bundle for import into another environment"
      )
  ).addHelpText("after", `
Workspace resolution: --workspace-id, else CLOUDCRUISE_WORKSPACE_ID, else the
profile's default workspace.

Examples:
  $ cloudcruise workflows export wf_abc123 --profile staging > bundle.json
  $ cloudcruise workflows export wf_abc123 --profile prod
  $ cloudcruise workflows export wf_abc123 --profile prod --workspace-id ws_123
`).action(async (id: string, opts: AuthOptions) => {
    try {
      const auth = await resolveAuth(opts)
      const client = new ApiClient(auth)
      const data = await client.get(`/workflows/${id}/export`)
      outputJson(data)
    } catch (err: unknown) {
      fail(err)
    }
  })

  addAuthOptions(
    workflows
      .command("import")
      .description(
        "Import a workflow bundle, creating a new workflow in the target workspace"
      )
      .option("--file <path>", "Path to bundle JSON file")
      .option("--stdin", "Read bundle JSON from stdin")
  ).addHelpText("after", `
Workspace resolution: --workspace-id, else CLOUDCRUISE_WORKSPACE_ID, else the
profile's default workspace. 

Examples:
  $ cloudcruise workflows import --file bundle.json --profile prod
  $ cloudcruise workflows import --file bundle.json --profile prod --workspace-id ws_123
  $ cloudcruise workflows export wf_abc123 --profile staging | cloudcruise workflows import --stdin --profile prod
`).action(
    async (opts: { file?: string; stdin?: boolean } & AuthOptions) => {
      try {
        if (opts.stdin && opts.file) {
          throw new UsageError("Pass either --file or --stdin, not both")
        }
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
          throw new UsageError("Provide --file <path> or --stdin")
        }

        const auth = await resolveAuth(opts)
        const client = new ApiClient(auth)
        const data = await client.post("/workflows/import", body)
        outputJson(data)
      } catch (err: unknown) {
        fail(err)
      }
    }
  )

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
    "encrypted_keys",
  ]

  addAuthOptions(
    workflows
      .command("update <id>")
      .description("Update workflow (creates new version)")
      .option("--file <path>", "Path to workflow JSON file")
      .option("--stdin", "Read workflow JSON from stdin")
      .option("--version-note <note>", "Description of changes for this version")
  ).addHelpText("after", `
Examples:
  $ cloudcruise workflows update wf_abc123 --file workflow.json --version-note "Fixed login XPath"
  $ cat workflow.json | cloudcruise workflows update wf_abc123 --stdin --version-note "Updated selectors"
`).action(
    async (
      id: string,
      opts: {
        file?: string
        stdin?: boolean
        versionNote?: string
      } & AuthOptions
    ) => {
      try {
        if (opts.stdin && opts.file) {
          throw new UsageError("Pass either --file or --stdin, not both")
        }
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
          throw new UsageError("Provide --file <path> or --stdin")
        }

        for (const field of READONLY_FIELDS) {
          delete body[field]
        }

        if (opts.versionNote) {
          body.version_note = opts.versionNote
        }

        const auth = await resolveAuth(opts)
        const client = new ApiClient(auth)
        const data = await client.put(`/workflows/${id}`, body)
        outputJson(data)
      } catch (err: unknown) {
        fail(err)
      }
    }
  )
}
