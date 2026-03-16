import { Command } from "commander"
import { randomUUID } from "crypto"
import { resolveAuth } from "../core/auth.js"
import { ApiClient } from "../core/api-client.js"
import { streamSSE } from "../core/sse-client.js"
import { outputJson, outputError, outputEvent } from "../core/output.js"
import { addAuthOptions, type AuthOptions } from "../core/auth-options.js"

const TERMINAL_STATUSES = [
  "execution.success",
  "execution.failed",
  "execution.stopped"
]

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
      .option("--wait", "Wait for completion and print result")
      .option("--debug", "Enable debug snapshots on every node")
  ).action(
    async (
      workflowId: string,
      opts: {
        input: string
        wait?: boolean
        debug?: boolean
      } & AuthOptions
    ) => {
      try {
        const auth = resolveAuth(opts)
        const client = new ApiClient(auth)

        let inputVariables: Record<string, unknown>
        try {
          inputVariables = JSON.parse(opts.input)
        } catch {
          throw new Error(`Invalid --input JSON: ${opts.input}`)
        }

        const clientId = opts.wait ? randomUUID() : undefined

        const body: Record<string, unknown> = {
          workflow_id: workflowId,
          run_input_variables: inputVariables
        }
        if (opts.debug) body.debug = true
        if (clientId) body.client_id = clientId

        const result = await client.post<{ session_id: string }>("/run", body)
        const sessionId = result.session_id

        if (!opts.wait) {
          outputJson(result)
          return
        }

        for await (const event of streamSSE(
          client,
          `/run/clients/${clientId}/events`
        )) {
          if (event.event === "ping") continue

          try {
            const parsed = JSON.parse(event.data) as Record<string, unknown>
            outputEvent(event.event ?? "run.event", parsed)

            const inner = parsed.data as Record<string, unknown> | undefined
            const status =
              (inner?.event as string) ??
              (inner?.payload as Record<string, unknown> | undefined)
                ?.status ??
              (parsed.status as string | undefined)
            if (status && TERMINAL_STATUSES.includes(status)) {
              const finalResult = await client.get(`/run/${sessionId}`)
              outputJson(finalResult)
              process.exit(status === "execution.success" ? 0 : 1)
            }
          } catch {
            outputEvent(event.event ?? "run.event", { raw: event.data })
          }
        }

        const finalResult = await client.get(`/run/${sessionId}`)
        outputJson(finalResult)
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
  ).action(
    async (
      sessionId: string,
      opts: AuthOptions
    ) => {
      try {
        const auth = resolveAuth(opts)
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
      .option("--start-time <iso>", "Start time (ISO 8601)")
      .option("--end-time <iso>", "End time (ISO 8601)")
  ).action(
    async (opts: {
      workflow?: string
      status?: string
      limit: string
      startTime?: string
      endTime?: string
    } & AuthOptions) => {
      try {
        const auth = resolveAuth(opts)
        const client = new ApiClient(auth)

        const params = new URLSearchParams()
        if (opts.workflow) params.set("workflow_id", opts.workflow)
        if (opts.status) params.set("status", opts.status)
        if (opts.limit) params.set("limit", opts.limit)
        if (opts.startTime) params.set("start_time", opts.startTime)
        if (opts.endTime) params.set("end_time", opts.endTime)

        const query = params.toString()
        const path = `/runs${query ? `?${query}` : ""}`

        const response = await client.getStream(path)
        const text = await response.text()
        try {
          const data = JSON.parse(text)
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
  ).action(
    async (
      sessionId: string,
      opts: AuthOptions
    ) => {
      try {
        const auth = resolveAuth(opts)
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
  ).action(
    async (
      workflowId: string,
      opts: {
        since: string
        limit: string
      } & AuthOptions
    ) => {
      try {
        const auth = resolveAuth(opts)
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
  ).action(
    async (
      sessionId: string,
      nodeId: string,
      opts: AuthOptions
    ) => {
      try {
        const auth = resolveAuth(opts)
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
