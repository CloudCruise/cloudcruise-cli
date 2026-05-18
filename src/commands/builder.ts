import { Command } from "commander"
import { writeFileSync } from "fs"
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
import {
  processBuilderStream,
  pollBuilderStream
} from "../core/builder-stream.js"
import { enforceNoArgSecrets } from "../core/secret-args.js"

const BASE = "/workflow-builder/agent"

function progress(msg: string): void {
  process.stderr.write(`${msg}\n`)
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString("utf-8")
}

function parseLimit(limit: string | undefined): number | undefined {
  if (limit === undefined) return undefined
  if (!/^[1-9]\d*$/.test(limit)) {
    throw new Error("--limit must be a positive integer")
  }
  const parsed = Number.parseInt(limit, 10)
  if (!Number.isSafeInteger(parsed) || parsed > 1000) {
    throw new Error("--limit must be between 1 and 1000")
  }
  return parsed
}

/**
 * Resolve auth for builder commands. Uses non-secret session metadata as
 * fallback so profile/base URL/workspace only need to be passed at session start.
 */
async function resolveBuilderAuth(opts: AuthOptions) {
  const session = loadSession()
  const merged = { ...opts }
  if (session) {
    if (!merged.baseUrl && session.baseUrl) merged.baseUrl = session.baseUrl
    if (!merged.profile && session.profile) merged.profile = session.profile
    if (!merged.workspaceId && session.workspaceId) {
      merged.workspaceId = session.workspaceId
    }
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
        const auth = await resolveAuth(opts)
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
          baseUrl: auth.baseUrl,
          profile: opts.profile,
          workspaceId: auth.workspaceId
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
        const auth = await resolveAuth(opts)
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
          baseUrl: auth.baseUrl,
          profile: opts.profile,
          workspaceId: auth.workspaceId
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
      .option("--no-wait", "Return immediately without waiting for completion")
      .option("--timeout <seconds>", "Timeout in seconds (ignored with --no-wait)", "300")
  ).action(
    async (
      message: string,
      opts: {
        wait: boolean  // commander inverts --no-wait to opts.wait = false
        timeout: string
      } & AuthOptions
    ) => {
      try {
        const auth = await resolveBuilderAuth(opts)
        const client = new ApiClient(auth)
        const session = requireSession()

        if (opts.wait === false) {
          let messageCountBefore: number | undefined
          try {
            const { messages } = await fetchMessages(
              client,
              session.conversationId
            )
            messageCountBefore = messages.length
            updateSession({ lastMessageCount: messages.length })
          } catch {
            // Best effort — poll still works with the previous index.
          }

          // Async mode: fire request with a 5s abort — enough for the
          // server to accept and start processing, but don't wait for
          // the full response (which blocks until the agent turn ends).
          const ac = new AbortController()
          const timer = setTimeout(() => ac.abort(), 5000)
          try {
            await fetch(
              `${auth.baseUrl}${BASE}/${session.conversationId}/message`,
              {
                method: "POST",
                headers: client.authHeaders({
                  "Content-Type": "application/json"
                }),
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
          outputJson({ status: "sent", messageCountBefore })
          process.exit(0)
        }

        // Blocking mode: POST + stream SSE until done
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

          let postError: string | undefined
          client
            .post(`${BASE}/${session.conversationId}/message`, {
              text: message
            })
            .catch((err: unknown) => {
              postError =
                err instanceof Error ? err.message : String(err)
              abortController.abort()
            })

          const result = await processBuilderStream(stream, {
            onDone: () => abortController.abort()
          })

          if (postError && !result.finalText) {
            outputError(postError)
            process.exit(1)
          }
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

  // ── builder poll (helpers) ──────────────────────────────────────
  interface PollFromMessagesResult {
    status: "processing" | "done" | "error" | "waiting_for_input" | "idle"
    text?: string
    waitingForInput?: { messageId: string; description: string }
    waitingForInputs?: { messageId: string; inputs: HumanInputField[] }
    tools: { tool: string; status: string; text?: string }[]
    newMessageCount: number
    totalMessageCount: number
  }

  interface HumanInputField {
    name: string
    type: string
    description: string
    default?: string
    options?: string[]
  }

  interface MessagesResponse {
    messages: Record<string, unknown>[]
    isProcessing: boolean
  }

  async function fetchMessages(
    client: ApiClient,
    conversationId: string
  ): Promise<MessagesResponse> {
    const raw = await client.get<MessagesResponse | Record<string, unknown>[]>(
      `${BASE}/${conversationId}/messages`
    )

    if (Array.isArray(raw)) {
      return { messages: raw, isProcessing: false }
    }
    return {
      messages: Array.isArray(raw.messages) ? raw.messages : [],
      isProcessing: Boolean(raw.isProcessing)
    }
  }

  async function checkMessagesForStatus(
    client: ApiClient,
    conversationId: string,
    sinceIndex: number
  ): Promise<PollFromMessagesResult | null> {
    const { messages: allMessages, isProcessing } = await fetchMessages(
      client,
      conversationId
    )

    const newMessages = allMessages.slice(sinceIndex)
    const tools = newMessages
      .filter((m) => m.role === "tool" && m.toolName)
      .map((m) => ({
        tool: m.toolName as string,
        status: m.status as string,
        text: (m.text as string)?.slice(0, 100)
      }))

    for (let i = newMessages.length - 1; i >= 0; i--) {
      const msg = newMessages[i]
      const msgStatus = msg.status as string
      const eventType = msg.event_type as string

      if (
        eventType === "interaction.inputs" ||
        msgStatus === "waiting_for_input"
      ) {
        const content = msg.content as Record<string, unknown> | undefined
        const humanInputs =
          (content?.humanInputs as Record<string, unknown>[] | undefined) ?? []
        const humanInput = content?.humanInput as
          | Record<string, unknown>
          | undefined ?? humanInputs[0]
        const messageId = msg.id as string
        const result: PollFromMessagesResult = {
          status: "waiting_for_input",
          waitingForInput: {
            messageId,
            description:
              (humanInput?.description as string) ??
              (humanInput?.name as string) ??
              (msg.text as string) ??
              "Input requested"
          },
          tools,
          newMessageCount: newMessages.length,
          totalMessageCount: allMessages.length
        }

        if (humanInputs.length > 0) {
          result.waitingForInputs = {
            messageId,
            inputs: humanInputs.map((input) => {
              const field: HumanInputField = {
                name: input.name as string,
                type: input.type as string,
                description: input.description as string
              }
              if (input.default !== undefined) {
                field.default = input.default as string
              }
              if (input.options) field.options = input.options as string[]
              return field
            })
          }
        }

        updateSession({ lastMessageCount: allMessages.length })
        return result
      }
    }

    if (isProcessing) {
      updateSession({ lastMessageCount: allMessages.length })
      return {
        status: "processing",
        tools,
        newMessageCount: newMessages.length,
        totalMessageCount: allMessages.length
      }
    }

    if (newMessages.length === 0) {
      updateSession({ lastMessageCount: allMessages.length })
      return {
        status: "idle",
        tools: [],
        newMessageCount: 0,
        totalMessageCount: allMessages.length
      }
    }

    let status: PollFromMessagesResult["status"] = "idle"
    let text: string | undefined

    for (let i = newMessages.length - 1; i >= 0; i--) {
      const msg = newMessages[i]
      const role = msg.role as string
      const msgStatus = msg.status as string

      if (msgStatus === "error") {
        status = "error"
        text = msg.text as string
        break
      }

      if (role === "assistant" && msgStatus === "success") {
        status = "done"
        text = msg.text as string
        break
      }
    }

    updateSession({ lastMessageCount: allMessages.length })

    return {
      status,
      text,
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
  ).action(
    async (
      opts: {
        wait?: string
      } & AuthOptions
    ) => {
      try {
        const auth = await resolveBuilderAuth(opts)
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
      .option("--value <value>", "Response value (rejected by default; use --value-stdin)")
      .option("--value-stdin", "Read response value from stdin")
      .option("--responses-stdin", "Read JSON object of name-to-value responses from stdin")
  ).action(
    async (
      opts: {
        messageId: string
        value?: string
        valueStdin?: boolean
        responsesStdin?: boolean
      } & AuthOptions
    ) => {
      try {
        enforceNoArgSecrets({ "--value": opts.value }, "builder respond")
        const providedCount = [
          opts.value !== undefined,
          Boolean(opts.valueStdin),
          Boolean(opts.responsesStdin)
        ].filter(Boolean).length
        if (providedCount === 0) {
          throw new Error("Provide --value, --value-stdin, or --responses-stdin")
        }
        if (providedCount > 1) {
          throw new Error("Use only one of --value, --value-stdin, or --responses-stdin")
        }

        const auth = await resolveBuilderAuth(opts)
        const client = new ApiClient(auth)
        const session = requireSession()

        try {
          const { messages } = await fetchMessages(
            client,
            session.conversationId
          )
          updateSession({ lastMessageCount: messages.length })
        } catch {
          // Best effort — response can still be sent.
        }

        const body: Record<string, unknown> = { messageId: opts.messageId }

        if (opts.responsesStdin) {
          const rawResponses = (await readStdin()).trimEnd()
          try {
            body.responses = JSON.parse(rawResponses)
          } catch {
            throw new Error("--responses-stdin must contain valid JSON")
          }
          if (
            body.responses === null ||
            Array.isArray(body.responses) ||
            typeof body.responses !== "object"
          ) {
            throw new Error("--responses-stdin must contain a JSON object")
          }
        } else {
          const rawValue = opts.valueStdin
            ? (await readStdin()).trimEnd()
            : opts.value as string

          // Try to parse as JSON for typed values (number, boolean, null)
          let value: string | number | boolean | null = rawValue
          try {
            const parsed = JSON.parse(rawValue)
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
          body.value = value
        }

        const result = await client.post(
          `${BASE}/${session.conversationId}/respond`,
          body
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
      const auth = await resolveBuilderAuth(opts)
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
        const auth = await resolveBuilderAuth(opts)
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
        const auth = await resolveBuilderAuth(opts)
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
      const auth = await resolveBuilderAuth(opts)
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
        const limit = parseLimit(opts.limit)
        const auth = await resolveBuilderAuth(opts)
        const client = new ApiClient(auth)
        const session = requireSession()

        const query = limit !== undefined ? `?limit=${limit}` : ""
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
  ).action(async (opts: AuthOptions) => {
    try {
      const auth = await resolveBuilderAuth(opts)
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
      const auth = await resolveBuilderAuth(opts)
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
      const auth = await resolveBuilderAuth(opts)
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
