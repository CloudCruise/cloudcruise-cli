import { Command } from "commander"
import { exec } from "child_process"
import { writeFileSync } from "fs"
import { resolveAuth } from "../core/auth.js"
import { ApiClient, ApiError } from "../core/api-client.js"
import { outputJson, stripBase64 } from "../core/output.js"
import { fail, echoSession, exitCodeForStatus, UsageError } from "../core/exit.js"
import { addAuthOptions, type AuthOptions } from "../core/auth-options.js"
import { resolveConversation } from "../core/conversation.js"
import type { RosterEntry } from "../core/conversation.js"
import { enforceNoArgSecrets } from "../core/secret-args.js"

/** Options carried by every command that targets an existing conversation. */
type ConversationOptions = AuthOptions & { conversation?: string }

/** Add the --conversation selector to a command. Explicit ids overrule
 * CLOUDCRUISE_CONVERSATION and the implicit workspace-scoped roster lookup. */
function addConversationOption(cmd: Command): Command {
  return cmd.option(
    "--conversation <id>",
    "Target conversation id (overrides CLOUDCRUISE_CONVERSATION and workspace scope)"
  )
}

const BASE = "/workflow-builder/agent"

/** Normalize a timestamp to ISO 8601. The backend stores epoch ms; the contract
 * emits ISO strings so timestamps are one type across every command. */
function toIso(value: unknown): unknown {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString()
  }
  return value
}

/** Return a copy with `startedAt` normalized to ISO (if present). */
function normalizeStartedAt(
  obj: Record<string, unknown>
): Record<string, unknown> {
  if (obj.startedAt !== undefined) {
    return { ...obj, startedAt: toIso(obj.startedAt) }
  }
  return obj
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

/**
 * Build the builder app link for a conversation.
 *
 * When `appUrl` is provided (via --app-url, profile.appUrl, or
 * CLOUDCRUISE_APP_URL) it is used verbatim as the app origin. Otherwise the
 * app host is inferred from the API host (api.* -> app.*, staging-api.* ->
 * staging.*). Localhost has no inferable app host, so it requires an explicit
 * appUrl; any other unrecognized host falls back to prod.
 */
function builderUrl(
  appUrl: string | undefined,
  apiBaseUrl: string,
  conversationId: string
): string {
  if (appUrl) {
    let parsed: URL | null = null
    try {
      parsed = new URL(appUrl.trim())
    } catch {
      parsed = null
    }
    if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      throw new UsageError(
        `Invalid app URL "${appUrl}". Include an http(s) scheme, e.g. http://localhost:3000.`
      )
    }
    return `${parsed.origin}/workflows/builder/${conversationId}`
  }

  let hostname: string
  let host: string
  try {
    const parsed = new URL(apiBaseUrl)
    hostname = parsed.hostname
    host = parsed.host
  } catch {
    return `https://app.cloudcruise.com/workflows/builder/${conversationId}`
  }

  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost")
  ) {
    throw new UsageError(
      "Can't infer the builder app URL for a localhost API. Set the app URL via --app-url, CLOUDCRUISE_APP_URL, or the profile's appUrl (e.g. http://localhost:3000)."
    )
  }

  const appHost = host.startsWith("staging-api.")
    ? host.replace(/^staging-api\./, "staging.")
    : host.startsWith("api.")
      ? host.replace(/^api\./, "app.")
      : "app.cloudcruise.com"
  return `https://${appHost}/workflows/builder/${conversationId}`
}

function normalizeUrl(value: string, flagName: string): string {
  const trimmed = value.trim()
  const withScheme = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`
  try {
    return new URL(withScheme).href
  } catch {
    throw new UsageError(`${flagName}: Invalid URL (${JSON.stringify(value)})`)
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
    throw new UsageError("--limit must be a positive integer")
  }
  const parsed = Number.parseInt(limit, 10)
  if (!Number.isSafeInteger(parsed) || parsed > 1000) {
    throw new UsageError("--limit must be between 1 and 1000")
  }
  return parsed
}

function parseOffset(offset: string | undefined): number | undefined {
  if (offset === undefined) return undefined
  if (!/^\d+$/.test(offset)) {
    throw new UsageError("--offset must be a non-negative integer")
  }
  const parsed = Number.parseInt(offset, 10)
  if (!Number.isSafeInteger(parsed)) {
    throw new UsageError("--offset is too large")
  }
  return parsed
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
      .option("--open-builder", "Open the builder in the default browser")
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
        openBuilder?: boolean
      } & AuthOptions
    ) => {
      try {
        if (opts.vaultUserId && opts.credential) {
          throw new UsageError("--vault-user-id and --credential are aliases; pass only one")
        }
        if (opts.vaultDomain && opts.authUrl) {
          throw new UsageError("--vault-domain and --auth-url are aliases; pass only one")
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
          throw new UsageError(
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

        echoSession(result.conversationId)
        outputJson(normalizeStartedAt(result))

        if (opts.openBuilder) {
          const url = builderUrl(auth.appUrl, auth.baseUrl, result.conversationId)
          openInBrowser(url)
          progress(`Opened builder in default browser: ${url}`)
        }
      } catch (err: unknown) {
        fail(err)
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
      .option("--open-builder", "Open the builder in the default browser")
  ).action(
    async (
      opts: {
        workflow: string
        targetNode?: string
        input?: string
        useLastBrowserState?: boolean
        openBuilder?: boolean
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

        echoSession(result.conversationId)
        outputJson(normalizeStartedAt(result))

        if (opts.openBuilder) {
          const url = builderUrl(auth.appUrl, auth.baseUrl, result.conversationId)
          openInBrowser(url)
          progress(`Opened builder in default browser: ${url}`)
        }
      } catch (err: unknown) {
        fail(err)
      }
    }
  )

  // ── builder send ───────────────────────────────────────────────
  addConversationOption(addAuthOptions(
    builder
      .command("send <message>")
      .description(
        "Send a message to the builder agent (returns immediately)"
      )
  )).addHelpText("after", `
Returns { conversationId, accepted: true } once the agent accepts the message. Poll for the
agent's response with 'cloudcruise builder poll'.
`).action(
    async (message: string, opts: ConversationOptions) => {
      try {
        const auth = await resolveAuth(opts)
        const client = new ApiClient(auth)
        const { conversationId, source } = await resolveConversation(
          client,
          opts,
          auth.workspaceId
        )
        echoSession(conversationId, source)

        // Fire the request with a 5s abort — enough for the server to
        // accept and start processing, but don't wait for the full
        // response (which blocks until the agent turn ends). Poll for
        // completion with `builder poll`.
        const ac = new AbortController()
        const timer = setTimeout(() => ac.abort(), 5000)
        try {
          const res = await fetch(
            `${auth.baseUrl}${BASE}/${conversationId}/message`,
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
              `${BASE}/${conversationId}/message`,
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
        outputJson({ conversationId, accepted: true })
      } catch (err: unknown) {
        fail(err)
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

  interface HumanInput {
    messageId: string
    prompt: string
    fields: HumanInputField[]
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
  function extractHumanInput(
    messages: Record<string, unknown>[]
  ): HumanInput | null {
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
      const prompt =
        (humanInput?.description as string) ??
        (humanInput?.name as string) ??
        (msg.text as string) ??
        "Input requested"
      const fields: HumanInputField[] = humanInputs.map((input) => {
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
      return { messageId, prompt, fields }
    }
    return null
  }

  /**
   * Canonical status object shared by `poll` and `status`: the /status taxonomy
   * plus, when awaiting human input, the request details attached as
   * `humanInput`. /status is also the keepalive (touches lastApiActivityAt).
   */
  async function fetchStatus(
    client: ApiClient,
    conversationId: string
  ): Promise<StatusResponse & { humanInput?: HumanInput }> {
    const status = await client.get<StatusResponse>(
      `${BASE}/${conversationId}/status`
    )
    if (status.status !== "awaiting-human-input") return status
    try {
      const { messages } = await fetchMessages(client, conversationId)
      const humanInput = extractHumanInput(messages)
      return humanInput ? { ...status, humanInput } : status
    } catch {
      // Best effort — status is still returned without input detail.
      return status
    }
  }

  // ── builder poll ────────────────────────────────────────────────
  addConversationOption(addAuthOptions(
    builder
      .command("poll")
      .description("Check builder agent status (one-shot snapshot)")
  )).addHelpText("after", `
Hits the /status endpoint, which reports the status taxonomy (processing,
awaiting-human-input, agent-errored, completed, idle, ended) and doubles as the
session keepalive. When the agent is awaiting human input, the request/field
details for 'builder respond' are attached.
`).action(async (opts: ConversationOptions) => {
    try {
      const auth = await resolveAuth(opts)
      const client = new ApiClient(auth)
      const { conversationId, source } = await resolveConversation(
        client,
        opts,
        auth.workspaceId
      )
      echoSession(conversationId, source)

      const result = await fetchStatus(client, conversationId)
      outputJson(result)
      // The exit code IS the observed status: a driver switches on it (7 answer,
      // 8 intervene, 9 tick+re-arm, 0 proceed) without parsing stdout.
      process.exit(exitCodeForStatus(result.status))
    } catch (err: unknown) {
      fail(err)
    }
  })

  // ── builder respond ────────────────────────────────────────────
  addConversationOption(addAuthOptions(
    builder
      .command("respond")
      .description("Respond to a human input request from the builder agent")
      .requiredOption("--message-id <id>", "ID of the input request message")
      .option("--value <value>", "Response value (rejected by default; use --value-stdin)")
      .option("--value-stdin", "Read response value from stdin")
      .option("--responses-stdin", "Read JSON object of name-to-value responses from stdin")
  )).action(
    async (
      opts: {
        messageId: string
        value?: string
        valueStdin?: boolean
        responsesStdin?: boolean
      } & ConversationOptions
    ) => {
      try {
        enforceNoArgSecrets({ "--value": opts.value }, "builder respond")
        const providedCount = [
          opts.value !== undefined,
          Boolean(opts.valueStdin),
          Boolean(opts.responsesStdin)
        ].filter(Boolean).length
        if (providedCount === 0) {
          throw new UsageError("Provide --value, --value-stdin, or --responses-stdin")
        }
        if (providedCount > 1) {
          throw new UsageError("Use only one of --value, --value-stdin, or --responses-stdin")
        }

        const auth = await resolveAuth(opts)
        const client = new ApiClient(auth)
        const { conversationId, source } = await resolveConversation(
          client,
          opts,
          auth.workspaceId
        )
        echoSession(conversationId, source)

        let inputMessages: Record<string, unknown>[] = []
        try {
          const { messages } = await fetchMessages(client, conversationId)
          inputMessages = messages
        } catch {
          // Best effort — response can still be sent.
        }

        const body: Record<string, unknown> = { messageId: opts.messageId }

        if (opts.responsesStdin) {
          const rawResponses = (await readStdin()).trimEnd()
          try {
            body.responses = JSON.parse(rawResponses)
          } catch {
            throw new UsageError("--responses-stdin must contain valid JSON")
          }
          if (
            body.responses === null ||
            Array.isArray(body.responses) ||
            typeof body.responses !== "object"
          ) {
            throw new UsageError("--responses-stdin must contain a JSON object")
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
                throw new UsageError(
                  `Auth input "${name}" requires an object with "permissioned_user_id" and "domain" strings. Use --responses-stdin with {"${name}":{"permissioned_user_id":"<user_id>","domain":"<domain>"}}.`
                )
              }
            }
          }
        }

        const result = await client.post(
          `${BASE}/${conversationId}/respond`,
          body
        )
        outputJson(result)
      } catch (err: unknown) {
        // Maps ALREADY_ANSWERED (lost the human-input race) to its exit code.
        fail(err)
      }
    }
  )

  // ── builder status ─────────────────────────────────────────────
  addConversationOption(addAuthOptions(
    builder.command("status").description("Show current builder conversation status")
  )).action(async (opts: ConversationOptions) => {
    try {
      const auth = await resolveAuth(opts)
      const client = new ApiClient(auth)
      const { conversationId, source } = await resolveConversation(
        client,
        opts,
        auth.workspaceId
      )
      echoSession(conversationId, source)

      // Canonical status object (identical shape to `poll`); /status is also
      // the keepalive. A gone conversation surfaces as a 404 -> exit 4.
      const result = await fetchStatus(client, conversationId)
      outputJson(result)
    } catch (err: unknown) {
      fail(err)
    }
  })

  // ── builder open ───────────────────────────────────────────────
  addConversationOption(addAuthOptions(
    builder
      .command("open")
      .description("Open the current builder conversation in the default browser")
  )).action(async (opts: ConversationOptions) => {
      try {
        const auth = await resolveAuth(opts)
        const client = new ApiClient(auth)
        const { conversationId, source } = await resolveConversation(
          client,
          opts,
          auth.workspaceId
        )
        echoSession(conversationId, source)
        const url = builderUrl(auth.appUrl, auth.baseUrl, conversationId)
        openInBrowser(url)
        progress(`Opened builder in default browser: ${url}`)
        outputJson({ conversationId, url })
      } catch (err: unknown) {
        fail(err)
      }
    })

  // ── builder conversation list ───────────────────────────────────
  // The server roster is the single source of truth for which conversations
  // exist and are live; the CLI keeps no local conversation store.
  async function listConversations(opts: AuthOptions): Promise<void> {
    const auth = await resolveAuth(opts)
    const client = new ApiClient(auth)
    const result = await client.get<{ sessions: RosterEntry[] }>(
      `${BASE}/sessions`
    )
    outputJson({
      sessions: result.sessions.map((s) => ({
        ...s,
        startedAt: toIso(s.startedAt)
      }))
    })
  }

  const conversation = builder
    .command("conversation")
    .description("Inspect builder conversations")
  addAuthOptions(
    conversation
      .command("list")
      .description("List live builder conversations for the workspace (newest first)")
  ).action(async (opts: AuthOptions) => {
    try {
      await listConversations(opts)
    } catch (err: unknown) {
      fail(err)
    }
  })

  // Hidden legacy alias for `builder conversation list`.
  addAuthOptions(
    builder
      .command("sessions", { hidden: true })
      .description("[deprecated] Alias for 'builder conversation list'")
  ).action(async (opts: AuthOptions) => {
    try {
      await listConversations(opts)
    } catch (err: unknown) {
      fail(err)
    }
  })

  // ── builder screenshot ─────────────────────────────────────────
  addConversationOption(addAuthOptions(
    builder
      .command("screenshot")
      .description("Get a screenshot of the current browser state")
      .option("--output <path>", "Write screenshot image to file")
  )).action(
    async (
      opts: {
        output?: string
      } & ConversationOptions
    ) => {
      try {
        const auth = await resolveAuth(opts)
        const client = new ApiClient(auth)
        const { conversationId, source } = await resolveConversation(
          client,
          opts,
          auth.workspaceId
        )
        echoSession(conversationId, source)

        const result = await client.get<{
          url: string | null
          base64: string | null
        }>(`${BASE}/${conversationId}/screenshot`)

        if (opts.output && result.base64) {
          const raw = result.base64.replace(/^data:image\/[^;]+;base64,/, "")
          writeFileSync(opts.output, Buffer.from(raw, "base64"))
          outputJson({
            conversationId,
            url: result.url,
            file: opts.output
          })
        } else {
          outputJson(result)
        }
      } catch (err: unknown) {
        fail(err)
      }
    }
  )

  // ── builder html ───────────────────────────────────────────────
  addConversationOption(addAuthOptions(
    builder
      .command("html")
      .description("Get the HTML of the current page")
      .option("--output <path>", "Write HTML to file")
  )).action(
    async (
      opts: {
        output?: string
      } & ConversationOptions
    ) => {
      try {
        const auth = await resolveAuth(opts)
        const client = new ApiClient(auth)
        const { conversationId, source } = await resolveConversation(
          client,
          opts,
          auth.workspaceId
        )
        echoSession(conversationId, source)

        const result = await client.get<{
          url: string | null
          html: string | null
        }>(`${BASE}/${conversationId}/html`)

        if (opts.output && result.html) {
          writeFileSync(opts.output, result.html)
          outputJson({
            conversationId,
            url: result.url,
            file: opts.output
          })
        } else {
          outputJson(result)
        }
      } catch (err: unknown) {
        fail(err)
      }
    }
  )

  // ── builder workflow ───────────────────────────────────────────
  addConversationOption(addAuthOptions(
    builder
      .command("workflow")
      .description("Get the current workflow definition")
  )).action(async (opts: ConversationOptions) => {
    try {
      const auth = await resolveAuth(opts)
      const client = new ApiClient(auth)
      const { conversationId, source } = await resolveConversation(
        client,
        opts,
        auth.workspaceId
      )
      echoSession(conversationId, source)

      const result = await client.get(`${BASE}/${conversationId}/workflow`)
      outputJson(result)
    } catch (err: unknown) {
      fail(err)
    }
  })

  // ── builder messages ───────────────────────────────────────────
  addConversationOption(addAuthOptions(
    builder
      .command("messages")
      .description("Get conversation messages")
      .option("--limit <n>", "Max messages to return")
      .option("--offset <n>", "Skip N messages (from the end unless --no-tail)")
      .option(
        "--no-tail",
        "Page from the start of the conversation instead of the end"
      )
  )).addHelpText("after", `
Returns a pagination envelope: { messages, total, offset, limit, tail, hasMore,
isProcessing }. By default offset counts from the newest message (tail); pass
--no-tail to make offset count from the oldest.
`).action(
    async (
      opts: {
        limit?: string
        offset?: string
        tail: boolean
      } & ConversationOptions
    ) => {
      try {
        const limit = parseLimit(opts.limit)
        const offset = parseOffset(opts.offset)
        const auth = await resolveAuth(opts)
        const client = new ApiClient(auth)
        const { conversationId, source } = await resolveConversation(
          client,
          opts,
          auth.workspaceId
        )
        echoSession(conversationId, source)

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
          `${BASE}/${conversationId}/messages${query}`
        )
        outputJson(stripBase64(result))
      } catch (err: unknown) {
        fail(err)
      }
    }
  )

  // ── builder save ───────────────────────────────────────────────
  addConversationOption(addAuthOptions(
    builder.command("save").description("Save the workflow to the database")
  )).action(async (opts: ConversationOptions) => {
    try {
      const auth = await resolveAuth(opts)
      const client = new ApiClient(auth)
      const { conversationId, source } = await resolveConversation(
        client,
        opts,
        auth.workspaceId
      )
      echoSession(conversationId, source)

      const result = await client.post(`${BASE}/${conversationId}/save`)
      outputJson(result)
    } catch (err: unknown) {
      fail(err)
    }
  })

  // ── builder interrupt ──────────────────────────────────────────
  addConversationOption(addAuthOptions(
    builder
      .command("interrupt")
      .description("Interrupt the builder agent's current processing")
  )).action(async (opts: ConversationOptions) => {
    try {
      const auth = await resolveAuth(opts)
      const client = new ApiClient(auth)
      const { conversationId, source } = await resolveConversation(
        client,
        opts,
        auth.workspaceId
      )
      echoSession(conversationId, source)

      const result = await client.post(`${BASE}/${conversationId}/interrupt`)
      outputJson(result)
    } catch (err: unknown) {
      fail(err)
    }
  })

  // ── builder end ────────────────────────────────────────────────
  addConversationOption(addAuthOptions(
    builder
      .command("end")
      .description("End the builder conversation and clean up")
  )).action(async (opts: ConversationOptions) => {
    try {
      const auth = await resolveAuth(opts)
      const client = new ApiClient(auth)
      const { conversationId, source } = await resolveConversation(
        client,
        opts,
        auth.workspaceId
      )
      echoSession(conversationId, source)

      const result = await client.delete(`${BASE}/${conversationId}`)
      outputJson(result)
    } catch (err: unknown) {
      fail(err)
    }
  })
}
