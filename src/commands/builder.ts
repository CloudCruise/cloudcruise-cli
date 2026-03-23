import { Command } from "commander"
import { writeFileSync } from "fs"
import { resolveAuth } from "../core/auth.js"
import { ApiClient } from "../core/api-client.js"
import { streamSSE } from "../core/sse-client.js"
import { outputJson, outputError } from "../core/output.js"
import { addAuthOptions, type AuthOptions } from "../core/auth-options.js"
import {
  saveSession,
  deleteSession,
  requireSession,
  loadSession
} from "../core/session.js"
import { processBuilderStream } from "../core/builder-stream.js"

const BASE = "/workflow-builder/agent"

function progress(msg: string): void {
  process.stderr.write(`${msg}\n`)
}

export function registerBuilderCommands(program: Command): void {
  const builder = program
    .command("builder")
    .description("Build and edit workflows with the AI builder agent")

  // ── builder start ──────────────────────────────────────────────
  addAuthOptions(
    builder
      .command("start")
      .description("Start a new builder session")
      .requiredOption("--start-url <url>", "URL to open in the browser")
      .option("--name <name>", "Session name", "Untitled")
      .option("--description <text>", "Session description")
      .option("--credential <id>", "Vault permissioned_user_id for auth")
      .option("--auth-url <url>", "Auth URL (used with --credential)")
      .option(
        "--proxy <setting>",
        "Proxy setting: country, static, random, off"
      )
      .option("--proxy-value <value>", "Country code or IP address")
      .option("--input-schema <json>", "Input schema as JSON")
      .option("--input <json>", "Example input values as JSON")
      .option("--network", "Enable network traffic capture")
  ).action(
    async (
      opts: {
        startUrl: string
        name: string
        description?: string
        credential?: string
        authUrl?: string
        proxy?: string
        proxyValue?: string
        inputSchema?: string
        input?: string
        network?: boolean
      } & AuthOptions
    ) => {
      try {
        const auth = resolveAuth(opts)
        const client = new ApiClient(auth)

        const body: Record<string, unknown> = {
          name: opts.name,
          startUrl: opts.startUrl
        }
        if (opts.description) body.description = opts.description
        if (opts.credential) body.permissionedUserId = opts.credential
        if (opts.authUrl) body.authUrl = opts.authUrl
        if (opts.proxy) body.proxySetting = opts.proxy
        if (opts.proxyValue) body.proxyValue = opts.proxyValue
        if (opts.inputSchema) body.inputSchema = JSON.parse(opts.inputSchema)
        if (opts.input) body.jsonExample = JSON.parse(opts.input)
        if (opts.network) body.enableNetworkListener = true

        const result = await client.post<{
          conversationId: string
          [k: string]: unknown
        }>(`${BASE}/session`, body)

        saveSession({
          conversationId: result.conversationId,
          name: opts.name,
          startedAt: new Date().toISOString()
        })

        outputJson(result)
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    }
  )

  // ── builder edit ───────────────────────────────────────────────
  addAuthOptions(
    builder
      .command("edit")
      .description("Edit an existing workflow in the builder")
      .requiredOption("--workflow <id>", "Workflow ID to edit")
      .option("--target-node <id>", "Start from a specific node")
      .option("--input <json>", "Input variables as JSON")
      .option(
        "--use-last-browser-state",
        "Continue from previous browser state"
      )
  ).action(
    async (
      opts: {
        workflow: string
        targetNode?: string
        input?: string
        useLastBrowserState?: boolean
      } & AuthOptions
    ) => {
      try {
        const auth = resolveAuth(opts)
        const client = new ApiClient(auth)

        const body: Record<string, unknown> = {
          workflowId: opts.workflow
        }
        if (opts.targetNode) body.targetNodeId = opts.targetNode
        if (opts.input) body.inputVariables = JSON.parse(opts.input)
        if (opts.useLastBrowserState) body.useLastBrowserState = true

        const result = await client.post<{
          conversationId: string
          [k: string]: unknown
        }>(`${BASE}/session/from-workflow`, body)

        saveSession({
          conversationId: result.conversationId,
          name: `Edit ${opts.workflow}`,
          startedAt: new Date().toISOString()
        })

        outputJson(result)
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    }
  )

  // ── builder send ───────────────────────────────────────────────
  addAuthOptions(
    builder
      .command("send <message>")
      .description("Send a message to the builder agent")
      .option("--timeout <seconds>", "Timeout in seconds", "300")
  ).action(
    async (
      message: string,
      opts: {
        timeout: string
      } & AuthOptions
    ) => {
      try {
        const auth = resolveAuth(opts)
        const client = new ApiClient(auth)
        const session = requireSession()
        const timeoutMs = parseInt(opts.timeout) * 1000

        const abortController = new AbortController()

        const interruptAndExit = async () => {
          progress("Interrupted — sending interrupt to builder agent...")
          abortController.abort()
          try {
            await client.post(
              `${BASE}/${session.conversationId}/interrupt`
            )
          } catch {
            // Best effort — server may already be done
          }
          process.exit(130)
        }
        process.on("SIGINT", interruptAndExit)
        process.on("SIGTERM", interruptAndExit)

        const timeout = setTimeout(() => {
          abortController.abort()
          progress("Timeout waiting for builder agent")
          process.exit(1)
        }, timeoutMs)

        try {
          const sseUrl = `${BASE}/${session.conversationId}/stream`
          const stream = streamSSE(client, sseUrl, abortController.signal)

          client
            .post(`${BASE}/${session.conversationId}/message`, {
              text: message
            })
            .catch((err: unknown) => {
              progress(
                `Error sending message: ${err instanceof Error ? err.message : String(err)}`
              )
              abortController.abort()
            })

          await processBuilderStream(stream, {
            onDone: () => abortController.abort()
          })
        } finally {
          clearTimeout(timeout)
          process.off("SIGINT", interruptAndExit)
          process.off("SIGTERM", interruptAndExit)
        }
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    }
  )

  // ── builder respond ────────────────────────────────────────────
  addAuthOptions(
    builder
      .command("respond")
      .description("Respond to a human input request from the builder agent")
      .requiredOption("--message-id <id>", "ID of the input request message")
      .requiredOption("--value <value>", "Response value")
  ).action(
    async (
      opts: {
        messageId: string
        value: string
      } & AuthOptions
    ) => {
      try {
        const auth = resolveAuth(opts)
        const client = new ApiClient(auth)
        const session = requireSession()

        // Try to parse as JSON for typed values (number, boolean, null)
        let value: string | number | boolean | null = opts.value
        try {
          const parsed = JSON.parse(opts.value)
          if (
            typeof parsed === "number" ||
            typeof parsed === "boolean" ||
            parsed === null
          ) {
            value = parsed
          }
        } catch {
          // Keep as string
        }

        const result = await client.post(
          `${BASE}/${session.conversationId}/respond`,
          {
            messageId: opts.messageId,
            value
          }
        )
        outputJson(result)
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    }
  )

  // ── builder status ─────────────────────────────────────────────
  addAuthOptions(
    builder.command("status").description("Show current builder session status")
  ).action(async (opts: AuthOptions) => {
    try {
      const session = loadSession()
      if (!session) {
        outputJson({ active: false })
        return
      }

      // Verify session is still alive by fetching workflow
      const auth = resolveAuth(opts)
      const client = new ApiClient(auth)
      try {
        const workflow = await client.get(
          `${BASE}/${session.conversationId}/workflow`
        )
        outputJson({
          active: true,
          conversationId: session.conversationId,
          name: session.name,
          startedAt: session.startedAt,
          ...(workflow as Record<string, unknown>)
        })
      } catch {
        // Session expired on the server
        deleteSession()
        outputJson({ active: false, reason: "session_expired" })
      }
    } catch (err: unknown) {
      outputError(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
  })

  // ── builder screenshot ─────────────────────────────────────────
  addAuthOptions(
    builder
      .command("screenshot")
      .description("Get a screenshot of the current browser state")
      .option("--output <path>", "Write screenshot image to file")
  ).action(
    async (
      opts: {
        output?: string
      } & AuthOptions
    ) => {
      try {
        const auth = resolveAuth(opts)
        const client = new ApiClient(auth)
        const session = requireSession()

        const result = await client.get<{
          url: string | null
          base64: string | null
        }>(`${BASE}/${session.conversationId}/screenshot`)

        if (opts.output && result.base64) {
          const raw = result.base64.replace(/^data:image\/[^;]+;base64,/, "")
          writeFileSync(opts.output, Buffer.from(raw, "base64"))
          outputJson({ url: result.url, file: opts.output })
        } else {
          outputJson(result)
        }
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    }
  )

  // ── builder html ───────────────────────────────────────────────
  addAuthOptions(
    builder
      .command("html")
      .description("Get the HTML of the current page")
      .option("--output <path>", "Write HTML to file")
  ).action(
    async (
      opts: {
        output?: string
      } & AuthOptions
    ) => {
      try {
        const auth = resolveAuth(opts)
        const client = new ApiClient(auth)
        const session = requireSession()

        const result = await client.get<{
          url: string | null
          html: string | null
        }>(`${BASE}/${session.conversationId}/html`)

        if (opts.output && result.html) {
          writeFileSync(opts.output, result.html)
          outputJson({ url: result.url, file: opts.output })
        } else {
          outputJson(result)
        }
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    }
  )

  // ── builder workflow ───────────────────────────────────────────
  addAuthOptions(
    builder
      .command("workflow")
      .description("Get the current workflow definition")
  ).action(async (opts: AuthOptions) => {
    try {
      const auth = resolveAuth(opts)
      const client = new ApiClient(auth)
      const session = requireSession()

      const result = await client.get(
        `${BASE}/${session.conversationId}/workflow`
      )
      outputJson(result)
    } catch (err: unknown) {
      outputError(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
  })

  // ── builder messages ───────────────────────────────────────────
  addAuthOptions(
    builder
      .command("messages")
      .description("Get conversation messages")
      .option("--limit <n>", "Max messages to return")
  ).action(
    async (
      opts: {
        limit?: string
      } & AuthOptions
    ) => {
      try {
        const auth = resolveAuth(opts)
        const client = new ApiClient(auth)
        const session = requireSession()

        const query = opts.limit ? `?limit=${opts.limit}` : ""
        const result = await client.get(
          `${BASE}/${session.conversationId}/messages${query}`
        )
        outputJson(result)
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    }
  )

  // ── builder save ───────────────────────────────────────────────
  addAuthOptions(
    builder.command("save").description("Save the workflow to the database")
  ).action(async (opts: AuthOptions) => {
    try {
      const auth = resolveAuth(opts)
      const client = new ApiClient(auth)
      const session = requireSession()

      const result = await client.post(
        `${BASE}/${session.conversationId}/save`
      )
      outputJson(result)
    } catch (err: unknown) {
      outputError(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
  })

  // ── builder interrupt ──────────────────────────────────────────
  addAuthOptions(
    builder
      .command("interrupt")
      .description("Interrupt the builder agent's current processing")
  ).action(async (opts: AuthOptions) => {
    try {
      const auth = resolveAuth(opts)
      const client = new ApiClient(auth)
      const session = requireSession()

      const result = await client.post(
        `${BASE}/${session.conversationId}/interrupt`
      )
      outputJson(result)
    } catch (err: unknown) {
      outputError(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
  })

  // ── builder end ────────────────────────────────────────────────
  addAuthOptions(
    builder
      .command("end")
      .description("End the builder session and clean up")
  ).action(async (opts: AuthOptions) => {
    try {
      const auth = resolveAuth(opts)
      const client = new ApiClient(auth)
      const session = requireSession()

      try {
        const result = await client.delete(
          `${BASE}/${session.conversationId}`
        )
        deleteSession()
        outputJson(result)
      } catch {
        // Server may be down or session expired — clean up locally anyway
        deleteSession()
        outputJson({ status: "ended", note: "Local session cleared. Server cleanup may have failed." })
      }
    } catch (err: unknown) {
      outputError(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
  })
}
