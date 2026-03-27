import { Command } from "commander"
import { writeFileSync } from "fs"
import { exec } from "child_process"
import { resolveAuth } from "../core/auth.js"
import { ApiClient } from "../core/api-client.js"
import { streamSSE } from "../core/sse-client.js"
import { outputJson, outputError, stripBase64 } from "../core/output.js"
import { addAuthOptions, type AuthOptions } from "../core/auth-options.js"
import {
  saveSession,
  deleteSession,
  requireSession,
  loadSession,
  updateSession
} from "../core/session.js"
import { pollBuilderStream } from "../core/builder-stream.js"

function openInBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open"
  exec(`${cmd} ${JSON.stringify(url)}`, () => {
    // Best effort — ignore errors (e.g. no display server on headless Linux)
  })
}

const BASE = "/workflow-builder/agent"

function progress(msg: string): void {
  process.stderr.write(`${msg}\n`)
}

/**
 * Resolve auth for builder commands. Uses session-stored auth as fallback
 * so --api-key and --base-url only need to be passed at `builder start`.
 */
function resolveBuilderAuth(opts: AuthOptions) {
  const session = loadSession()
  const merged = { ...opts }
  if (session) {
    if (!merged.apiKey && session.apiKey) merged.apiKey = session.apiKey
    if (!merged.baseUrl && session.baseUrl) merged.baseUrl = session.baseUrl
    if (!merged.profile && session.profile) merged.profile = session.profile
  }
  return resolveAuth(merged)
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
      .option("--no-open", "Don't open the live browser URL in the default browser")
  ).addHelpText("after", `
Examples:
  $ cloudcruise builder start --start-url "https://app.example.com" --name "Login flow"
  $ cloudcruise builder start --start-url "https://app.example.com" --credential "f47ac10b-..." --auth-url "https://app.example.com/login"
  $ cloudcruise builder start --start-url "https://app.example.com" --proxy country --proxy-value US
`).action(
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
        open: boolean
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
          startedAt: new Date().toISOString(),
          apiKey: auth.apiKey,
          baseUrl: auth.baseUrl,
          profile: opts.profile
        })

        outputJson(result)

        const sessionUrl = (
          result as { builderSession?: { url?: string } }
        ).builderSession?.url
        if (opts.open && sessionUrl) {
          openInBrowser(sessionUrl)
          progress("Opened live browser session in default browser")
        }
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
      .option("--no-open", "Don't open the live browser URL in the default browser")
  ).addHelpText("after", `
Examples:
  $ cloudcruise builder edit --workflow wf_abc123
  $ cloudcruise builder edit --workflow wf_abc123 --target-node node_abc123
  $ cloudcruise builder edit --workflow wf_abc123 --use-last-browser-state
`).action(
    async (
      opts: {
        workflow: string
        targetNode?: string
        input?: string
        useLastBrowserState?: boolean
        open: boolean
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
          startedAt: new Date().toISOString(),
          apiKey: auth.apiKey,
          baseUrl: auth.baseUrl,
          profile: opts.profile
        })

        outputJson(result)

        const sessionUrl = (
          result as { builderSession?: { url?: string } }
        ).builderSession?.url
        if (opts.open && sessionUrl) {
          openInBrowser(sessionUrl)
          progress("Opened live browser session in default browser")
        }
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
      .description("Send a message to the builder agent (returns immediately; use poll to check status)")
  ).addHelpText("after", `
Examples:
  $ cloudcruise builder send "Click the login button"
  $ cloudcruise builder send "Search for order 12345 and extract the status"
`).action(
    async (
      message: string,
      opts: AuthOptions
    ) => {
      try {
        const auth = resolveBuilderAuth(opts)
        const session = requireSession()

        // Fire request with a 5s abort — enough for the server to accept
        // and start processing, but don't wait for the full response
        // (which blocks until the agent turn ends).
        const ac = new AbortController()
        const timer = setTimeout(() => ac.abort(), 5000)
        try {
          await fetch(
            `${auth.baseUrl}${BASE}/${session.conversationId}/message`,
            {
              method: "POST",
              headers: {
                "cc-key": auth.apiKey,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({ text: message }),
              signal: ac.signal
            }
          )
        } catch {
          // AbortError is expected — server accepted but we're not
          // waiting for the response. Network errors also caught here.
        } finally {
          clearTimeout(timer)
        }
        outputJson({ status: "sent" })
        process.exit(0)
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    }
  )

  // ── builder poll (helpers) ──────────────────────────────────────
  interface PollFromMessagesResult {
    status: "processing" | "done" | "error" | "waiting_for_input"
    text?: string
    waitingForInput?: { messageId: string; description: string }
    tools: { tool: string; status: string; text?: string }[]
    newMessageCount: number
    totalMessageCount: number
  }

  async function checkMessagesForStatus(
    client: ApiClient,
    conversationId: string,
    sinceIndex: number
  ): Promise<PollFromMessagesResult | null> {
    const allMessages = await client.get<Record<string, unknown>[]>(
      `${BASE}/${conversationId}/messages`
    )
    if (!Array.isArray(allMessages)) return null

    const newMessages = allMessages.slice(sinceIndex)

    let status: PollFromMessagesResult["status"] = "processing"
    let text: string | undefined
    let waitingForInput: PollFromMessagesResult["waitingForInput"]

    for (let i = newMessages.length - 1; i >= 0; i--) {
      const msg = newMessages[i]
      const role = msg.role as string
      const msgStatus = msg.status as string
      const eventType = msg.event_type as string

      if (msgStatus === "error") {
        status = "error"
        text = msg.text as string
        break
      }

      if (
        eventType === "interaction.inputs" ||
        msgStatus === "waiting_for_input"
      ) {
        status = "waiting_for_input"
        const content = msg.content as Record<string, unknown> | undefined
        const humanInput = content?.humanInput as
          | Record<string, unknown>
          | undefined
        waitingForInput = {
          messageId: msg.id as string,
          description:
            (humanInput?.description as string) ??
            (humanInput?.name as string) ??
            (msg.text as string) ??
            "Input requested"
        }
        break
      }

      if (role === "assistant" && msgStatus === "success") {
        status = "done"
        text = msg.text as string
        break
      }
    }

    const tools = newMessages
      .filter((m) => m.role === "tool" && m.toolName)
      .map((m) => ({
        tool: m.toolName as string,
        status: m.status as string,
        text: (m.text as string)?.slice(0, 100)
      }))

    updateSession({ lastMessageCount: allMessages.length })

    return {
      status,
      text,
      waitingForInput,
      tools,
      newMessageCount: newMessages.length,
      totalMessageCount: allMessages.length
    }
  }

  // ── builder poll ────────────────────────────────────────────────
  addAuthOptions(
    builder
      .command("poll")
      .description(
        "Check builder agent status. With --wait, blocks until status changes."
      )
      .option(
        "--wait <seconds>",
        "Block until agent finishes, errors, or needs input (max seconds)"
      )
  ).addHelpText("after", `
Examples:
  $ cloudcruise builder poll
  $ cloudcruise builder poll --wait 60
`).action(
    async (
      opts: {
        wait?: string
      } & AuthOptions
    ) => {
      try {
        const auth = resolveBuilderAuth(opts)
        const client = new ApiClient(auth)
        const session = requireSession()
        const sinceIndex = session.lastMessageCount ?? 0

        if (opts.wait) {
          // Step 1: Check messages first — terminal state may already exist
          const immediate = await checkMessagesForStatus(
            client,
            session.conversationId,
            sinceIndex
          )
          if (immediate && immediate.status !== "processing") {
            outputJson(immediate)
            return
          }

          // Step 2: Not done yet — open SSE stream and wait
          const timeoutMs = parseInt(opts.wait) * 1000
          const abortController = new AbortController()

          const timeout = setTimeout(() => {
            abortController.abort()
          }, timeoutMs)

          const interruptAndExit = async () => {
            abortController.abort()
            try {
              await client.post(
                `${BASE}/${session.conversationId}/interrupt`
              )
            } catch {
              // Best effort
            }
            process.exit(130)
          }
          process.on("SIGINT", interruptAndExit)
          process.on("SIGTERM", interruptAndExit)

          try {
            const sseUrl = `${BASE}/${session.conversationId}/stream`
            const stream = streamSSE(
              client,
              sseUrl,
              abortController.signal
            )
            const sseResult = await pollBuilderStream(
              stream,
              abortController.signal
            )

            // Step 3: SSE returned — if timeout, do final message check
            if (sseResult.status === "timeout") {
              const final = await checkMessagesForStatus(
                client,
                session.conversationId,
                sinceIndex
              )
              if (final) {
                outputJson(final)
                return
              }
            }

            outputJson(sseResult)
          } finally {
            clearTimeout(timeout)
            process.off("SIGINT", interruptAndExit)
            process.off("SIGTERM", interruptAndExit)
          }
          return
        }

        // Instant mode: just check messages
        const result = await checkMessagesForStatus(
          client,
          session.conversationId,
          sinceIndex
        )
        if (result) {
          outputJson(result)
        } else {
          outputJson({ status: "error", error: "Unexpected response format" })
          process.exit(1)
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
  ).addHelpText("after", `
Examples:
  $ cloudcruise builder respond --message-id msg_abc123 --value "123456"
`).action(
    async (
      opts: {
        messageId: string
        value: string
      } & AuthOptions
    ) => {
      try {
        const auth = resolveBuilderAuth(opts)
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
  ).addHelpText("after", `
Examples:
  $ cloudcruise builder status
`).action(async (opts: AuthOptions) => {
    try {
      const session = loadSession()
      if (!session) {
        outputJson({ active: false })
        return
      }

      // Verify session is still alive by fetching workflow
      const auth = resolveBuilderAuth(opts)
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
  ).addHelpText("after", `
Examples:
  $ cloudcruise builder screenshot
  $ cloudcruise builder screenshot --output page.png
`).action(
    async (
      opts: {
        output?: string
      } & AuthOptions
    ) => {
      try {
        const auth = resolveBuilderAuth(opts)
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
  ).addHelpText("after", `
Examples:
  $ cloudcruise builder html
  $ cloudcruise builder html --output page.html
`).action(
    async (
      opts: {
        output?: string
      } & AuthOptions
    ) => {
      try {
        const auth = resolveBuilderAuth(opts)
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
  ).addHelpText("after", `
Examples:
  $ cloudcruise builder workflow
`).action(async (opts: AuthOptions) => {
    try {
      const auth = resolveBuilderAuth(opts)
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
  ).addHelpText("after", `
Examples:
  $ cloudcruise builder messages
  $ cloudcruise builder messages --limit 5
`).action(
    async (
      opts: {
        limit?: string
      } & AuthOptions
    ) => {
      try {
        const auth = resolveBuilderAuth(opts)
        const client = new ApiClient(auth)
        const session = requireSession()

        const query = opts.limit ? `?limit=${opts.limit}` : ""
        const result = await client.get(
          `${BASE}/${session.conversationId}/messages${query}`
        )
        outputJson(stripBase64(result))
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    }
  )

  // ── builder save ───────────────────────────────────────────────
  addAuthOptions(
    builder.command("save").description("Save the workflow to the database")
  ).addHelpText("after", `
Examples:
  $ cloudcruise builder save
`).action(async (opts: AuthOptions) => {
    try {
      const auth = resolveBuilderAuth(opts)
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
  ).addHelpText("after", `
Examples:
  $ cloudcruise builder interrupt
`).action(async (opts: AuthOptions) => {
    try {
      const auth = resolveBuilderAuth(opts)
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
  ).addHelpText("after", `
Examples:
  $ cloudcruise builder end
`).action(async (opts: AuthOptions) => {
    try {
      const auth = resolveBuilderAuth(opts)
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
