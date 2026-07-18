import { Command } from "commander"
import { exec } from "child_process"
import { writeFileSync } from "fs"
import { resolveAuth } from "../core/auth.js"
import { ApiClient, ApiError } from "../core/api-client.js"
import { outputJson, outputError, stripBase64 } from "../core/output.js"
import { addAuthOptions, type AuthOptions } from "../core/auth-options.js"
import {
  saveSession,
  deleteSession,
  requireSession,
  loadSession,
  updateSession
} from "../core/session.js"
import { enforceNoArgSecrets } from "../core/secret-args.js"

const BASE = "/workflow-builder/agent"

// Exit codes for the 409 error taxonomy so scripts can distinguish outcomes.
const EXIT_SESSION_BUSY = 6 // a turn is already running (busy guard)
const EXIT_ALREADY_ANSWERED = 7 // lost the human-input race

/**
 * Uniform error handling for builder commands. Maps the backend's coded 409
 * responses to distinct exit codes and prints the code so the outcome is
 * observable from a script; everything else falls back to a generic exit 1.
 */
function failBuilder(err: unknown): never {
  if (err instanceof ApiError && err.code) {
    let messageId: string | undefined
    try {
      messageId = (JSON.parse(err.body) as { messageId?: string }).messageId
    } catch {
      // Non-JSON body — nothing more to surface.
    }
    outputError(
      `${err.code} (HTTP ${err.status})${messageId ? ` messageId=${messageId}` : ""}`
    )
    if (err.code === "SESSION_BUSY") process.exit(EXIT_SESSION_BUSY)
    if (err.code === "ALREADY_ANSWERED") process.exit(EXIT_ALREADY_ANSWERED)
  }
  outputError(err instanceof Error ? err.message : String(err))
  process.exit(1)
}

function openInBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open"
  exec(`${cmd} ${JSON.stringify(url)}`, () => {
    // Best effort — ignore errors such as headless Linux.
  })
}

function progress(msg: string): void {
  process.stderr.write(`${msg}\n`)
}

function normalizeUrl(value: string, flagName: string): string {
  const trimmed = value.trim()
  const withScheme = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`
  try {
    return new URL(withScheme).href
  } catch {
    outputError(`${flagName}: Invalid URL (${JSON.stringify(value)})`)
    process.exit(1)
  }
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

function parseOffset(offset: string | undefined): number | undefined {
  if (offset === undefined) return undefined
  if (!/^\d+$/.test(offset)) {
    throw new Error("--offset must be a non-negative integer")
  }
  const parsed = Number.parseInt(offset, 10)
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("--offset is too large")
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
      .option(
        "--vault-user-id <id>",
        "Vault entry's permissioned_user_id to log in with (requires --vault-domain; see `vault list`)"
      )
      .option(
        "--vault-domain <domain>",
        "Vault entry's domain (required with --vault-user-id; must match the domain from `vault list`)"
      )
      .option("--credential <id>", "[Deprecated] Alias for --vault-user-id")
      .option("--auth-url <url>", "[Deprecated] Alias for --vault-domain")
      .option(
        "--proxy <setting>",
        "Proxy setting: country, static, random, off"
      )
      .option("--proxy-value <value>", "Country code or IP address")
      .option("--input-schema <json>", "Input schema as JSON")
      .option("--input <json>", "Example input values as JSON")
      .option("--network", "Enable network traffic capture")
      .option("--no-open", "Don't open the live browser URL in the default browser")
  ).action(
    async (
      opts: {
        startUrl: string
        name: string
        description?: string
        vaultUserId?: string
        vaultDomain?: string
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
        if (opts.vaultUserId && opts.credential) {
          throw new Error("--vault-user-id and --credential are aliases; pass only one")
        }
        if (opts.vaultDomain && opts.authUrl) {
          throw new Error("--vault-domain and --auth-url are aliases; pass only one")
        }
        if (opts.credential) {
          progress("[deprecated] --credential is deprecated; use --vault-user-id instead.")
        }
        if (opts.authUrl) {
          progress("[deprecated] --auth-url is deprecated; use --vault-domain instead.")
        }

        const vaultUserId = opts.vaultUserId ?? opts.credential
        const vaultDomain = opts.vaultDomain ?? opts.authUrl
        if (Boolean(vaultUserId) !== Boolean(vaultDomain)) {
          throw new Error(
            "--vault-user-id and --vault-domain must be used together. Pass both to pre-configure login, or omit both to let the builder prompt for credentials."
          )
        }

        const startUrl = normalizeUrl(opts.startUrl, "--start-url")
        const auth = await resolveAuth(opts)
        const client = new ApiClient(auth)

        const body: Record<string, unknown> = {
          name: opts.name,
          startUrl
        }
        if (opts.description) body.description = opts.description
        if (vaultUserId) body.permissionedUserId = vaultUserId
        // Send the vault domain verbatim. The vault stores it exactly as
        // registered (the `vault` commands do no normalization) and the
        // credential lookup is an exact-string match, so normalizing here
        // (e.g. URL.href appending a trailing slash) would break matching.
        if (vaultDomain) body.authUrl = vaultDomain
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
      .description(
        "Send a message to the builder agent (returns immediately)"
      )
  ).addHelpText("after", `
Returns { status: "sent" } once the agent accepts the message. Poll for the
agent's response with 'cloudcruise builder poll'.
`).action(
    async (message: string, opts: AuthOptions) => {
      try {
        const auth = await resolveBuilderAuth(opts)
        const client = new ApiClient(auth)
        const session = requireSession()

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

        // Fire the request with a 5s abort — enough for the server to
        // accept and start processing, but don't wait for the full
        // response (which blocks until the agent turn ends). Poll for
        // completion with `builder poll`.
        const ac = new AbortController()
        const timer = setTimeout(() => ac.abort(), 5000)
        try {
          const res = await fetch(
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
          if (!res.ok) {
            // Surface the coded 409 taxonomy (e.g. SESSION_BUSY) so the
            // catch below can map it to a distinct exit code.
            throw await ApiError.from(
              "POST",
              `${BASE}/${session.conversationId}/message`,
              res
            )
          }
        } catch (err: unknown) {
          if (!(err instanceof DOMException && err.name === "AbortError")) {
            throw err
          }
          // AbortError is expected — server accepted but we're not
          // waiting for the full response.
        } finally {
          clearTimeout(timer)
        }
        outputJson({ status: "sent", messageCountBefore })
      } catch (err: unknown) {
        failBuilder(err)
      }
    }
  )

  // ── builder poll (helpers) ──────────────────────────────────────
  // Status taxonomy emitted by GET /:id/status. `terminal` marks the states
  // that will never change without a new turn (completed, agent-errored, ended).
  type BuilderStatus =
    | "processing"
    | "awaiting-human-input"
    | "agent-errored"
    | "completed"
    | "idle"
    | "ended"

  interface StatusResponse {
    conversationId: string
    status: BuilderStatus
    terminal: boolean
    isProcessing: boolean
    workflowId?: string
  }

  interface HumanInputField {
    name: string
    type: string
    description: string
    default?: string
    options?: string[]
  }

  interface WaitingInput {
    waitingForInput: { messageId: string; description: string }
    waitingForInputs?: { messageId: string; inputs: HumanInputField[] }
  }

  interface MessagesResponse {
    messages: Record<string, unknown>[]
    total?: number
    offset?: number
    limit?: number
    tail?: boolean
    hasMore?: boolean
    isProcessing: boolean
  }

  async function fetchMessages(
    client: ApiClient,
    conversationId: string,
    query = ""
  ): Promise<MessagesResponse> {
    const raw = await client.get<MessagesResponse | Record<string, unknown>[]>(
      `${BASE}/${conversationId}/messages${query}`
    )

    if (Array.isArray(raw)) {
      return { messages: raw, isProcessing: false }
    }
    return {
      ...raw,
      messages: Array.isArray(raw.messages) ? raw.messages : [],
      isProcessing: Boolean(raw.isProcessing)
    }
  }

  /**
   * Pull the human-input request details out of the message log. The /status
   * endpoint reports `awaiting-human-input` but not *what* is being asked, so we
   * scan for the most recent interaction.inputs message to surface the
   * messageId and field schema needed by `builder respond`.
   */
  function extractWaitingInput(
    messages: Record<string, unknown>[]
  ): WaitingInput | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      const msgStatus = msg.status as string
      const eventType = msg.event_type as string
      if (
        eventType !== "interaction.inputs" &&
        msgStatus !== "waiting_for_input"
      ) {
        continue
      }

      const content = msg.content as Record<string, unknown> | undefined
      const humanInputs =
        (content?.humanInputs as Record<string, unknown>[] | undefined) ?? []
      const humanInput =
        (content?.humanInput as Record<string, unknown> | undefined) ??
        humanInputs[0]
      const messageId = msg.id as string
      const result: WaitingInput = {
        waitingForInput: {
          messageId,
          description:
            (humanInput?.description as string) ??
            (humanInput?.name as string) ??
            (msg.text as string) ??
            "Input requested"
        }
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
      return result
    }
    return null
  }

  // ── builder poll ────────────────────────────────────────────────
  addAuthOptions(
    builder
      .command("poll")
      .description("Check builder agent status (one-shot snapshot)")
  ).addHelpText("after", `
Hits the /status endpoint, which reports the status taxonomy (processing,
awaiting-human-input, agent-errored, completed, idle, ended) and doubles as the
session keepalive. When the agent is awaiting human input, the request/field
details for 'builder respond' are attached.
`).action(async (opts: AuthOptions) => {
    try {
      const auth = await resolveBuilderAuth(opts)
      const client = new ApiClient(auth)
      const session = requireSession()

      // GET /status is the keepalive (it touches lastApiActivityAt). Poll must
      // hit it — not the side-effect-free /messages — or idle sessions get
      // reaped despite active polling.
      const status = await client.get<StatusResponse>(
        `${BASE}/${session.conversationId}/status`
      )

      let waiting: WaitingInput | null = null
      if (status.status === "awaiting-human-input") {
        try {
          const { messages } = await fetchMessages(
            client,
            session.conversationId
          )
          updateSession({ lastMessageCount: messages.length })
          waiting = extractWaitingInput(messages)
        } catch {
          // Best effort — status is still returned without input detail.
        }
      }

      outputJson({ ...status, ...(waiting ?? {}) })
    } catch (err: unknown) {
      failBuilder(err)
    }
  })

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

        let inputMessages: Record<string, unknown>[] = []
        let fetchedMessageCount: number | undefined
        try {
          const { messages } = await fetchMessages(
            client,
            session.conversationId
          )
          inputMessages = messages
          fetchedMessageCount = messages.length
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

        const targetMsg = inputMessages.find(
          (message) => (message.id as string) === opts.messageId
        )
        if (targetMsg) {
          const content = targetMsg.content as Record<string, unknown> | undefined
          const humanInputs =
            (content?.humanInputs as Record<string, unknown>[] | undefined) ?? []
          const authInputs = humanInputs.filter((input) => input.type === "auth")

          if (authInputs.length > 0) {
            const responses = body.responses as Record<string, unknown> | undefined
            for (const input of authInputs) {
              const name = input.name as string
              const value =
                responses?.[name] ??
                (humanInputs.length === 1 ? body.value : undefined)
              if (value === undefined) continue

              const isValid =
                typeof value === "object" &&
                value !== null &&
                typeof (value as Record<string, unknown>).permissioned_user_id === "string" &&
                typeof (value as Record<string, unknown>).domain === "string"

              if (!isValid) {
                throw new Error(
                  `Auth input "${name}" requires an object with "permissioned_user_id" and "domain" strings. Use --responses-stdin with {"${name}":{"permissioned_user_id":"<user_id>","domain":"<domain>"}}.`
                )
              }
            }
          }
        }

        const result = await client.post(
          `${BASE}/${session.conversationId}/respond`,
          body
        )
        if (fetchedMessageCount !== undefined) {
          updateSession({ lastMessageCount: fetchedMessageCount })
        }
        outputJson(result)
      } catch (err: unknown) {
        // Maps ALREADY_ANSWERED (lost the human-input race) to its exit code.
        failBuilder(err)
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

      // Verify liveness via /status. This is also the keepalive (it touches
      // lastApiActivityAt) and returns the status taxonomy + terminal flag.
      const auth = await resolveBuilderAuth(opts)
      const client = new ApiClient(auth)
      try {
        const status = await client.get<StatusResponse>(
          `${BASE}/${session.conversationId}/status`
        )
        outputJson({
          active: true,
          name: session.name,
          startedAt: session.startedAt,
          ...status
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

  // ── builder sessions ───────────────────────────────────────────
  addAuthOptions(
    builder
      .command("sessions")
      .description("List active builder sessions for the workspace (newest first)")
  ).action(async (opts: AuthOptions) => {
    try {
      const auth = await resolveBuilderAuth(opts)
      const client = new ApiClient(auth)
      const result = await client.get<{
        sessions: {
          conversationId: string
          workflowId?: string
          status: string
          startedAt: string
          title?: string
        }[]
      }>(`${BASE}/sessions`)
      outputJson(result)
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
      .option("--offset <n>", "Skip N messages (from the end unless --no-tail)")
      .option(
        "--no-tail",
        "Page from the start of the conversation instead of the end"
      )
  ).addHelpText("after", `
Returns a pagination envelope: { messages, total, offset, limit, tail, hasMore,
isProcessing }. By default offset counts from the newest message (tail); pass
--no-tail to make offset count from the oldest.
`).action(
    async (
      opts: {
        limit?: string
        offset?: string
        tail: boolean
      } & AuthOptions
    ) => {
      try {
        const limit = parseLimit(opts.limit)
        const offset = parseOffset(opts.offset)
        const auth = await resolveBuilderAuth(opts)
        const client = new ApiClient(auth)
        const session = requireSession()

        const params = new URLSearchParams()
        if (limit !== undefined) params.set("limit", String(limit))
        if (offset !== undefined) params.set("offset", String(offset))
        // Only send `tail` when the caller cares (an offset is in play or they
        // explicitly asked to page from the start); otherwise use the backend
        // default (tail=true).
        if (offset !== undefined || opts.tail === false) {
          params.set("tail", String(opts.tail))
        }

        const query = params.toString() ? `?${params.toString()}` : ""
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
