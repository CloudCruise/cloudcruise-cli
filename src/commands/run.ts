import { Command } from "commander"
import { resolveAuth } from "../core/auth.js"
import { ApiClient } from "../core/api-client.js"
import { outputJson, outputError } from "../core/output.js"
import { addAuthOptions, type AuthOptions } from "../core/auth-options.js"

function parseSince(since: string): Date {
  const match = since.match(/^(\d+)(h|d|m)$/)
  if (!match) {
    throw new Error(`Invalid --since format: "${since}". Use e.g. 24h, 7d, 30m`)
  }
  const amount = parseInt(match[1])
  const unit = match[2]
  const now = new Date()
  switch (unit) {
    case "h":
      return new Date(now.getTime() - amount * 60 * 60 * 1000)
    case "d":
      return new Date(now.getTime() - amount * 24 * 60 * 60 * 1000)
    case "m":
      return new Date(now.getTime() - amount * 60 * 1000)
    default:
      throw new Error(`Unknown time unit: ${unit}`)
  }
}

export function registerRunCommands(program: Command): void {
  const run = program.command("run").description("Manage runs")

  addAuthOptions(
    run
      .command("start <workflow_id>")
      .description("Start a new run")
      .option("--input <json>", "Input variables as JSON string", "{}")
      .option("--debug", "Enable debug snapshots on every node")
  ).addHelpText("after", `
Returns { session_id } immediately. Poll status with 'cloudcruise run get <session_id>'.

Examples:
  $ cloudcruise run start wf_abc123
  $ cloudcruise run start wf_abc123 --debug
  $ cloudcruise run start wf_abc123 --input '{"USER":"f47ac10b-58cc-4372-a567-0e02b2c3d479"}'
`).action(
    async (
      workflowId: string,
      opts: {
        input: string
        debug?: boolean
      } & AuthOptions
    ) => {
      try {
        const auth = await resolveAuth(opts)
        const client = new ApiClient(auth)

        let inputVariables: Record<string, unknown>
        try {
          inputVariables = JSON.parse(opts.input)
        } catch {
          throw new Error(`Invalid --input JSON: ${opts.input}`)
        }

        const body: Record<string, unknown> = {
          workflow_id: workflowId,
          run_input_variables: inputVariables
        }
        if (opts.debug) body.debug = true

        const result = await client.post<{ session_id: string }>("/run", body)
        outputJson(result)
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    }
  )

  addAuthOptions(
    run
      .command("get <session_id>")
      .description("Get run details")
  ).addHelpText("after", `
Examples:
  $ cloudcruise run get sess_abc123
`).action(
    async (
      sessionId: string,
      opts: AuthOptions
    ) => {
      try {
        const auth = await resolveAuth(opts)
        const client = new ApiClient(auth)
        const data = await client.get(`/run/${sessionId}`)
        outputJson(data)
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    }
  )

  addAuthOptions(
    run
      .command("list")
      .description("List runs")
      .option("--workflow <id>", "Filter by workflow ID")
      .option("--status <status>", "Filter by status")
      .option("--limit <n>", "Max results", "100")
      .option("--since <duration>", "Time range (e.g. 24h, 7d, 30m)")
  ).addHelpText("after", `
By default, the API returns runs from the last 24 hours.

Examples:
  $ cloudcruise run list
  $ cloudcruise run list --workflow wf_abc123 --status completed --limit 10
  $ cloudcruise run list --workflow wf_abc123 --since 7d
`).action(
    async (opts: {
      workflow?: string
      status?: string
      limit: string
      since?: string
    } & AuthOptions) => {
      try {
        const auth = await resolveAuth(opts)
        const client = new ApiClient(auth)

        const params = new URLSearchParams()
        if (opts.workflow) params.set("workflow_id", opts.workflow)
        if (opts.status) params.set("status", opts.status)
        if (opts.limit) params.set("limit", opts.limit)
        if (opts.since) params.set("start_time", parseSince(opts.since).toISOString())

        const query = params.toString()
        const path = `/runs${query ? `?${query}` : ""}`

        const response = await client.getStream(path)
        const text = await response.text()
        try {
          const data = JSON.parse(text)
          if (Array.isArray(data) && data.length === 0 && !opts.since) {
            process.stderr.write(
              "No runs found in the default 24h window. Try --since 7d.\n"
            )
          }
          outputJson(data)
        } catch {
          process.stdout.write(text + "\n")
        }
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    }
  )

  addAuthOptions(
    run
      .command("interrupt <session_id>")
      .description("Interrupt a running session")
  ).addHelpText("after", `
Examples:
  $ cloudcruise run interrupt sess_abc123
`).action(
    async (
      sessionId: string,
      opts: AuthOptions
    ) => {
      try {
        const auth = await resolveAuth(opts)
        const client = new ApiClient(auth)
        const data = await client.post(`/run/${sessionId}/interrupt`)
        outputJson(data)
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    }
  )

  addAuthOptions(
    run
      .command("errors <workflow_id>")
      .description("Get error analytics for a workflow")
      .option("--since <duration>", "Time range (e.g. 24h, 7d, 30m)", "24h")
      .option("--limit <n>", "Max results", "1000")
  ).addHelpText("after", `
Examples:
  $ cloudcruise run errors wf_abc123
  $ cloudcruise run errors wf_abc123 --since 7d
  $ cloudcruise run errors wf_abc123 --since 30m --limit 50
`).action(
    async (
      workflowId: string,
      opts: {
        since: string
        limit: string
      } & AuthOptions
    ) => {
      try {
        const auth = await resolveAuth(opts)
        const client = new ApiClient(auth)

        const startTimestamp = parseSince(opts.since).toISOString()
        const endTimestamp = new Date().toISOString()

        const params = new URLSearchParams({
          start_timestamp: startTimestamp,
          end_timestamp: endTimestamp,
          limit: opts.limit
        })

        const data = await client.get(
          `/runs/workflow/${workflowId}/errors?${params}`
        )
        outputJson(data)
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    }
  )

  addAuthOptions(
    run
      .command("snapshots <session_id> <node_id>")
      .description("Get debug snapshots for a node")
  ).addHelpText("after", `
Examples:
  $ cloudcruise run snapshots sess_abc123 node_abc123
`).action(
    async (
      sessionId: string,
      nodeId: string,
      opts: AuthOptions
    ) => {
      try {
        const auth = await resolveAuth(opts)
        const client = new ApiClient(auth)
        const data = await client.get(
          `/run/${sessionId}/debug-snapshots/${nodeId}`
        )
        outputJson(data)
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    }
  )
}
