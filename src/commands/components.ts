import { Command, InvalidArgumentError } from "commander"
import { readFileSync } from "fs"
import { resolveAuth } from "../core/auth.js"
import { ApiClient } from "../core/api-client.js"
import { outputJson } from "../core/output.js"
import { fail, UsageError } from "../core/exit.js"
import { addAuthOptions, type AuthOptions } from "../core/auth-options.js"

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

// Fields stripped from any payload before being sent as componentData.
// Two groups, one list for simpler review:
//   • Response metadata that would clobber server state if echoed back
//     (id, version_*, created_*, etc.).
//   • Workflow-only fields that leak credential material or workflow-
//     scoped runtime config if a user pipes `workflows get` into a
//     component command. encrypted_keys + loginStructure carry credential
//     material; proxy_value/proxy_setting are workflow-scoped runtime
//     config with no place in a reusable component definition.
const READONLY_FIELDS = [
  "id",
  "component_id",
  "version_id",
  "version_number",
  "version_note",
  "created_at",
  "created_by",
  "updated_at",
  "workspace_id",
  "encrypted_keys",
  "loginStructure",
  "proxy_value",
  "proxy_setting"
]

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString("utf-8")
}

function assertJsonObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new UsageError("Expected a JSON object")
  }
  return value as Record<string, unknown>
}

async function readPayload(opts: {
  file?: string
  stdin?: boolean
}): Promise<Record<string, unknown>> {
  if (opts.stdin && opts.file) {
    throw new UsageError("Pass either --file or --stdin, not both")
  }
  if (opts.stdin) {
    return assertJsonObject(JSON.parse(await readStdin()))
  }
  if (opts.file) {
    return assertJsonObject(JSON.parse(readFileSync(opts.file, "utf-8")))
  }
  throw new UsageError("Provide --file <path> or --stdin")
}

function extractComponentData(
  raw: Record<string, unknown>
): Record<string, unknown> {
  const wrapped =
    (raw.componentData as unknown) ?? (raw.component_data as unknown)
  const inner = wrapped !== undefined ? assertJsonObject(wrapped) : raw
  for (const field of READONLY_FIELDS) {
    delete inner[field]
  }
  return inner
}

// Endpoint DTO uses camelCase (workflow-components.dto.ts) — intentionally
// asymmetric with the workflows endpoint, which uses snake_case (version_note).
// Each CLI command mirrors its own endpoint's contract.
type CreateComponentBody = {
  name: string
  componentData: Record<string, unknown>
}
type UpdateComponentBody = {
  componentData: Record<string, unknown>
  versionNote?: string
  propagate?: boolean
  sourceWorkflowId?: string
}

export function registerComponentCommands(program: Command): void {
  const components = program
    .command("components")
    .description("Manage workflow components (reusable sub-workflows)")

  // ── list ───────────────────────────────────────────────────────
  addAuthOptions(
    components
      .command("list")
      .description("List all workflow components in your workspace")
      .option("--full", "Show all fields (default shows summary only)")
  )
    .addHelpText(
      "after",
      `
Examples:
  $ cloudcruise components list
  $ cloudcruise components list --full
`
    )
    .action(async (opts: { full?: boolean } & AuthOptions) => {
      try {
        const auth = await resolveAuth(opts)
        const client = new ApiClient(auth)
        const data = await client.get<Record<string, unknown>[]>(
          "/workflow-components"
        )
        if (opts.full) {
          outputJson(data)
        } else {
          const summary = data.map((c) => ({
            id: c.id,
            name: c.name,
            created_at: c.created_at,
            updated_at: c.updated_at
          }))
          outputJson(summary)
        }
      } catch (err: unknown) {
        fail(err)
      }
    })

  // ── get ────────────────────────────────────────────────────────
  addAuthOptions(
    components
      .command("get <id>")
      .description(
        "Get a workflow component (latest version by default)"
      )
      .option(
        "--version-number <n>",
        "Fetch a specific historical version (use `components versions <id>` to list)",
        parsePositiveInt
      )
  )
    .addHelpText(
      "after",
      `
Examples:
  $ cloudcruise components get wc_abc123
  $ cloudcruise components get wc_abc123 > component.json
  $ cloudcruise components get wc_abc123 --version-number 3
`
    )
    .action(
      async (id: string, opts: { versionNumber?: number } & AuthOptions) => {
        try {
          const auth = await resolveAuth(opts)
          const client = new ApiClient(auth)
          const path =
            opts.versionNumber !== undefined
              ? `/workflow-components/${id}/versions/${opts.versionNumber}`
              : `/workflow-components/${id}`
          const data = await client.get(path)
          outputJson(data)
        } catch (err: unknown) {
          fail(err)
        }
      }
    )

  // ── versions ───────────────────────────────────────────────────
  addAuthOptions(
    components
      .command("versions <id>")
      .description("List version history for a component (newest first)")
      .option(
        "--limit <n>",
        "Cap the number of versions returned (client-side slice)",
        parsePositiveInt
      )
  )
    .addHelpText(
      "after",
      `
Examples:
  $ cloudcruise components versions wc_abc123
  $ cloudcruise components versions wc_abc123 --limit 10
`
    )
    .action(async (id: string, opts: { limit?: number } & AuthOptions) => {
      try {
        const auth = await resolveAuth(opts)
        const client = new ApiClient(auth)
        const data = await client.get<Record<string, unknown>[]>(
          `/workflow-components/${id}/versions`
        )
        const sliced =
          opts.limit !== undefined ? data.slice(0, opts.limit) : data
        outputJson(sliced)
      } catch (err: unknown) {
        fail(err)
      }
    })

  // ── usage ──────────────────────────────────────────────────────
  addAuthOptions(
    components
      .command("usage <id>")
      .description("List workflows that use this component")
  )
    .addHelpText(
      "after",
      `
Examples:
  $ cloudcruise components usage wc_abc123
`
    )
    .action(async (id: string, opts: AuthOptions) => {
      try {
        const auth = await resolveAuth(opts)
        const client = new ApiClient(auth)
        const data = await client.get(`/workflow-components/${id}/usage`)
        outputJson(data)
      } catch (err: unknown) {
        fail(err)
      }
    })

  // ── create ─────────────────────────────────────────────────────
  addAuthOptions(
    components
      .command("create")
      .description("Create a new workflow component")
      .requiredOption("--name <name>", "Component name (max 100 chars)")
      .option(
        "--file <path>",
        "Path to JSON file containing componentData (the nodes/edges payload)"
      )
      .option("--stdin", "Read componentData JSON from stdin")
  )
    .addHelpText(
      "after",
      `
Examples:
  $ cloudcruise components create --name "Login flow" --file login-component.json
  $ cat data.json | cloudcruise components create --name "Login flow" --stdin
`
    )
    .action(
      async (
        opts: { name: string; file?: string; stdin?: boolean } & AuthOptions
      ) => {
        try {
          const raw = await readPayload(opts)
          const componentData = extractComponentData(raw)
          const body: CreateComponentBody = { name: opts.name, componentData }
          const auth = await resolveAuth(opts)
          const client = new ApiClient(auth)
          const data = await client.post(`/workflow-components`, body)
          outputJson(data)
        } catch (err: unknown) {
          fail(err)
        }
      }
    )

  // ── rename ─────────────────────────────────────────────────────
  addAuthOptions(
    components
      .command("rename <id>")
      .description("Rename a workflow component")
      .requiredOption("--name <name>", "New component name (max 100 chars)")
  )
    .addHelpText(
      "after",
      `
Examples:
  $ cloudcruise components rename wc_abc123 --name "Renamed flow"
`
    )
    .action(async (id: string, opts: { name: string } & AuthOptions) => {
      try {
        const auth = await resolveAuth(opts)
        const client = new ApiClient(auth)
        const data = await client.patch(`/workflow-components/${id}`, {
          name: opts.name
        })
        outputJson(data)
      } catch (err: unknown) {
        fail(err)
      }
    })

  // ── update ─────────────────────────────────────────────────────
  addAuthOptions(
    components
      .command("update <id>")
      .description(
        "Update component data (creates a new version, propagates to all instances by default)"
      )
      .option("--file <path>", "Path to component JSON file")
      .option("--stdin", "Read component JSON from stdin")
      .option(
        "--version-note <note>",
        "Description of changes for this version"
      )
      .option(
        "--no-propagate",
        "Do not propagate the update to workflows that use this component"
      )
      .option(
        "--source-workflow-id <id>",
        "Workflow id that triggered the update (skipped during propagation)"
      )
  )
    .addHelpText(
      "after",
      `
Examples:
  $ cloudcruise components update wc_abc123 --file component.json --version-note "Fixed login XPath"
  $ cloudcruise components get wc_abc123 | cloudcruise components update wc_abc123 --stdin
  $ cloudcruise components update wc_abc123 --file component.json --no-propagate
`
    )
    .action(
      async (
        id: string,
        opts: {
          file?: string
          stdin?: boolean
          versionNote?: string
          propagate?: boolean
          sourceWorkflowId?: string
        } & AuthOptions
      ) => {
        try {
          const raw = await readPayload(opts)
          const componentData = extractComponentData(raw)

          const body: UpdateComponentBody = { componentData }
          if (opts.versionNote) body.versionNote = opts.versionNote
          if (opts.propagate === false) body.propagate = false
          if (opts.sourceWorkflowId) {
            body.sourceWorkflowId = opts.sourceWorkflowId
          }

          const auth = await resolveAuth(opts)
          const client = new ApiClient(auth)
          const data = await client.put(`/workflow-components/${id}`, body)
          outputJson(data)
        } catch (err: unknown) {
          fail(err)
        }
      }
    )

  // ── delete ─────────────────────────────────────────────────────
  addAuthOptions(
    components
      .command("delete <id>")
      .description("Delete a workflow component")
  )
    .addHelpText(
      "after",
      `
Examples:
  $ cloudcruise components delete wc_abc123
`
    )
    .action(async (id: string, opts: AuthOptions) => {
      try {
        const auth = await resolveAuth(opts)
        const client = new ApiClient(auth)
        try {
          await client.delete(`/workflow-components/${id}`)
        } catch (err) {
          // Backend returns 204; ApiClient.delete() throws SyntaxError parsing
          // the empty body. Only swallow that — real HTTP errors must surface.
          if (!(err instanceof SyntaxError)) {
            throw err
          }
        }
        outputJson({ id, status: "deleted" })
      } catch (err: unknown) {
        fail(err)
      }
    })
}
