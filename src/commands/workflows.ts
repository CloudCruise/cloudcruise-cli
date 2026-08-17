import { Command, InvalidArgumentError } from "commander"
import { readFileSync } from "fs"
import { resolveAuth } from "../core/auth.js"
import { ApiClient } from "../core/api-client.js"
import { outputJson } from "../core/output.js"
import { ExitCode, fail, UsageError } from "../core/exit.js"
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

  interface FolderSummary {
    name: string
    path: string
    workflow_count: number
  }

  interface FolderListResponse {
    folderPath: string
    folders: FolderSummary[]
    allFolderPaths: string[]
    workflows: Record<string, unknown>[]
    workflowTotal: number
    page: number
    pageSize: number
  }

  const summarizeWorkflow = (w: Record<string, unknown>) => ({
    id: w.id,
    name: w.name,
    description: w.description,
    folder_path: w.folder_path,
    created_at: w.created_at,
    updated_at: w.updated_at
  })

  // Fetch every workflow in a folder, paging through GET /workflows/folders.
  const fetchWorkflowsInFolder = async (
    client: ApiClient,
    folderPath: string
  ): Promise<{ folderPath: string; workflows: Record<string, unknown>[] }> => {
    const pageSize = 100
    let page = 0
    let total = Infinity
    const collected: Record<string, unknown>[] = []
    let resolvedPath = folderPath
    while (collected.length < total) {
      const params = new URLSearchParams({
        folder_path: folderPath,
        page: String(page),
        page_size: String(pageSize)
      })
      const data = await client.get<FolderListResponse>(
        `/workflows/folders?${params.toString()}`
      )
      resolvedPath = data.folderPath
      total = data.workflowTotal
      collected.push(...data.workflows)
      if (data.workflows.length === 0) break
      page += 1
    }
    return { folderPath: resolvedPath, workflows: collected }
  }

  addAuthOptions(
    workflows
      .command("list")
      .description("List all workflows in your workspace")
      .option(
        "--folder <path>",
        "List only workflows in this folder (e.g. \"Claims/EOB\")"
      )
      .option("--full", "Show all fields (default shows summary only)")
  ).addHelpText("after", `
Without --folder, lists every workflow in the workspace. With --folder, lists
the workflows whose folder_path matches exactly (non-recursive); use
\`workflows folders\` to discover folder paths.

Examples:
  $ cloudcruise workflows list
  $ cloudcruise workflows list --full
  $ cloudcruise workflows list --folder "Claims/EOB"
`).action(
    async (opts: { folder?: string; full?: boolean } & AuthOptions) => {
      try {
        const auth = await resolveAuth(opts)
        const client = new ApiClient(auth)

        if (opts.folder !== undefined) {
          const { folderPath, workflows } = await fetchWorkflowsInFolder(
            client,
            opts.folder
          )
          outputJson({
            folder_path: folderPath,
            workflow_total: workflows.length,
            workflows: opts.full ? workflows : workflows.map(summarizeWorkflow)
          })
          return
        }

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
      .command("folders")
      .description("List workflow folders in your workspace")
      .option(
        "--path <path>",
        "List the direct subfolders under this folder path (default: workspace root)"
      )
      .option("--search <query>", "Filter folders/workflows by name or id")
      .option("--full", "Show the full API response (includes workflows at the path)")
  ).addHelpText("after", `
Folders are virtual: they are derived from each workflow's folder_path plus any
empty placeholder folders. \`allFolderPaths\` is the complete folder tree for the
workspace; \`folders\` lists the direct subfolders under --path with per-folder
workflow counts (this count is not returned when --search is used).

Examples:
  $ cloudcruise workflows folders
  $ cloudcruise workflows folders --path "Claims"
  $ cloudcruise workflows folders --search invoice
`).action(
    async (
      opts: { path?: string; search?: string; full?: boolean } & AuthOptions
    ) => {
      try {
        const auth = await resolveAuth(opts)
        const client = new ApiClient(auth)
        const params = new URLSearchParams()
        if (opts.path) params.set("folder_path", opts.path)
        if (opts.search) params.set("search", opts.search)
        const query = params.toString()
        const data = await client.get<FolderListResponse>(
          `/workflows/folders${query ? `?${query}` : ""}`
        )
        if (opts.full) {
          outputJson(data)
        } else {
          outputJson({
            path: data.folderPath,
            folders: data.folders,
            allFolderPaths: data.allFolderPaths
          })
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

  interface ValidateInputResponse {
    valid: boolean
    schema_error: string | null
    errors:
      | { field: string; message: string; keyword: string; expected: unknown }[]
      | null
  }

  addAuthOptions(
    workflows
      .command("validate-input <id>")
      .description(
        "Validate a run input payload against the workflow's saved input schema"
      )
      .option("--file <path>", "Path to payload JSON file (the run input variables object)")
      .option("--stdin", "Read payload JSON from stdin")
  ).addHelpText("after", `
Validates against the workflow's saved schema — push schema edits
(\`workflows update\`) before validating against them. <alias> vault
placeholders pass validation. Exit 0 means schema-valid, not run-will-succeed.

The result is printed on stdout. Exit codes:
  0  payload is valid
  1  payload is invalid (per-field errors in the "errors" array)
  2  the workflow's input schema does not compile ("schema_error" set);
     fix the schema, no payload can pass

Examples:
  $ cloudcruise workflows validate-input wf_abc123 --file payloads/null.json
  $ cat payload.json | cloudcruise workflows validate-input wf_abc123 --stdin
`).action(
    async (
      id: string,
      opts: { file?: string; stdin?: boolean } & AuthOptions
    ) => {
      try {
        if (opts.stdin && opts.file) {
          throw new UsageError("Pass either --file or --stdin, not both")
        }
        let payload: unknown
        if (opts.stdin) {
          const chunks: Buffer[] = []
          for await (const chunk of process.stdin) {
            chunks.push(chunk as Buffer)
          }
          payload = JSON.parse(Buffer.concat(chunks).toString("utf-8"))
        } else if (opts.file) {
          payload = JSON.parse(readFileSync(opts.file, "utf-8"))
        } else {
          throw new UsageError("Provide --file <path> or --stdin")
        }
        if (
          payload === null ||
          typeof payload !== "object" ||
          Array.isArray(payload)
        ) {
          throw new UsageError(
            "Payload must be a JSON object of run input variables"
          )
        }

        const auth = await resolveAuth(opts)
        const client = new ApiClient(auth)
        const data = await client.post<ValidateInputResponse>(
          `/workflows/${id}/validate-input`,
          { run_input_variables: payload }
        )
        outputJson(data)
        if (!data.valid) {
          process.exit(
            data.schema_error !== null ? ExitCode.BAD_ARGS : ExitCode.FAILURE
          )
        }
      } catch (err: unknown) {
        fail(err)
      }
    }
  )

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
