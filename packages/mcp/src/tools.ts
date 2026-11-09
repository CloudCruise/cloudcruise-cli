import { readFileSync } from "node:fs"
import { ApiError, CallError, SpecCache, Strata, StrataClient } from "@cloudcruise/strata"
import {
  CLIENT_INFO_META_KEY,
  McpServer,
  type CallToolResult,
  type ServerContext
} from "@modelcontextprotocol/server"
import * as z from "zod/v4"
import type { Config } from "./config.js"

export const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string
  }
).version

// Longer waits outlive client request timeouts: the MCP TS SDK gives up after
// 60 s, and Claude Code reports that as "The operation timed out".
export const MAX_POLL_SECONDS = 45
const HANDLE_PREFIX = "probe1."

// One per process: every request's Strata shares it, so the spec is fetched once per
// TTL, not once per request.
const specs = new SpecCache({ client: `mcp/${VERSION}` })
// The areas in search's description, from the last spec read. Only the first
// request waits for them; later ones refresh them in the background, so a slow
// spec fetch never delays a request.
let areas: string[] | undefined

// The API's 401s for a bad, expired or missing credential. Other 401s ("Missing
// privileges") and 403s (MFA, workspace access) aren't fixed by signing in again.
const TOKEN_REJECTED = /invalid or expired|missing authorization|missing or invalid|missing user id/i
const RECONNECT =
  "The CloudCruise API rejected your token. Reconnect the CloudCruise connector to sign in again."

interface Me {
  userId?: string
  email?: string
  workspaceId?: string
}

/** One server per HTTP request: the token is that request's, never shared. */
export async function createServer(config: Config, token: string): Promise<McpServer> {
  const server = new McpServer({ name: "cloudcruise", version: VERSION })
  const strata = (ctx?: ServerContext) =>
    new Strata({
      client: new StrataClient({
        baseUrl: config.apiBaseUrl,
        token,
        authScheme: "bearer",
        client: `mcp/${VERSION}`,
        agent: ctx && clientName(ctx)
      }),
      surface: "mcp",
      specs
    })
  const next = strata()
    .categories()
    .catch(() => [])
    .then((found) => (areas = found))
  const categories = areas ?? (await next)

  server.registerTool(
    "search",
    {
      title: "Search CloudCruise operations",
      description: [
        "Find the CloudCruise API operations that do what the user asked.",
        categories.length ? `Areas: ${categories.join(", ")}.` : "",
        "Describe the task in plain words, e.g. \"list my workflows\". Each result gives an operation's name, what it does and returns, and the arguments `call` takes. Search before `call`."
      ]
        .filter(Boolean)
        .join(" "),
      inputSchema: z.object({
        query: z.string().describe("The task in plain words"),
        limit: z.number().int().min(1).max(10).optional().describe("How many operations to return, default 5")
      }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ query, limit }, ctx) => {
      const found = await strata(ctx).search(query, { limit })
      if (!found.length) return text("No operations match. Try other words.")
      // The description says what an operation returns; output schemas would only cost tokens.
      return text(
        JSON.stringify(
          found.map(({ name, summary, description, hints, input }) => ({ name, summary, description, hints, input }))
        )
      )
    }
  )

  server.registerTool(
    "call",
    {
      title: "Call a CloudCruise operation",
      description:
        "Run a CloudCruise API operation found with `search`, as the signed-in user. Pass its name and arguments that fit its input schema: path and query parameters at the top level, the request body under `body`. Some operations change data.",
      inputSchema: z.object({
        operation: z.string().describe("The operation's name from search, e.g. workflows.list"),
        arguments: z.record(z.string(), z.unknown()).optional().describe("Arguments that fit the operation's input schema")
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
    },
    async ({ operation, arguments: args }, ctx) => {
      try {
        const { data } = await strata(ctx).call(operation, args ?? {})
        return text(data === undefined ? "Done. The API returned no content." : JSON.stringify(data))
      } catch (err) {
        // Anything else thrown becomes an error result with its message, via the SDK.
        if (err instanceof CallError && err.status === 401 && TOKEN_REJECTED.test(err.message)) {
          return errorResult(RECONNECT)
        }
        throw err
      }
    }
  )

  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description:
        "Show the CloudCruise account this connector is signed in as: user id, email and workspace id.",
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async (ctx) => {
      const client = new StrataClient({
        baseUrl: config.apiBaseUrl,
        token,
        authScheme: "bearer",
        client: `mcp/${VERSION}`,
        agent: clientName(ctx)
      })
      try {
        const me = await client.get<Me>("/users/me")
        const out = {
          user_id: me.userId ?? null,
          email: me.email ?? null,
          workspace_id: me.workspaceId ?? null
        }
        return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out }
      } catch (err) {
        return apiFailure(err)
      }
    }
  )

  server.registerTool(
    "probe_long",
    {
      title: "Start a test job",
      description:
        "Start a fake job that finishes after duration_seconds. Returns a handle; pass it to probe_poll until the job is done.",
      inputSchema: z.object({
        duration_seconds: z.number().int().min(1).max(3600).default(120)
      }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ duration_seconds }) => {
      const handle = encodeHandle({ s: Date.now(), d: duration_seconds * 1000 })
      const out = { handle, duration_seconds }
      return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out }
    }
  )

  server.registerTool(
    "probe_poll",
    {
      title: "Wait for a test job",
      description:
        "Check a job started by probe_long. Pass timeout_seconds (30-45 for a normal poll) to wait up to that long, at most 45 s, for it to finish; omit it to check once and return at once. If the result says running, call probe_poll again with the same handle.",
      inputSchema: z.object({
        handle: z.string(),
        timeout_seconds: z.number().int().min(1).optional()
      }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ handle, timeout_seconds }, ctx) => {
      const job = decodeHandle(handle)
      if (!job) {
        return errorResult("Invalid handle. Pass the handle exactly as probe_long returned it.")
      }
      const doneAt = job.s + job.d
      if (timeout_seconds !== undefined) {
        const waitSeconds = Math.min(timeout_seconds, MAX_POLL_SECONDS)
        const waitMs = Math.min(doneAt - Date.now(), waitSeconds * 1000)
        if (waitMs > 0) {
          await sleep(waitMs, ctx.mcpReq.signal)
        }
      }
      const remainingMs = doneAt - Date.now()
      const out =
        remainingMs <= 0
          ? { status: "done" }
          : {
              status: "running",
              remaining_seconds: Math.ceil(remainingMs / 1000),
              next: "call probe_poll again with the same handle"
            }
      return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out }
    }
  )

  return server
}

// Only 2026-07-28 clients send clientInfo on every request; 2025 clients sent it
// once in initialize, a separate stateless request, so there is none to read.
function clientName(ctx: ServerContext): string | undefined {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined
  const info = envelope?.[CLIENT_INFO_META_KEY] as { name?: unknown } | undefined
  return typeof info?.name === "string" && info.name ? info.name : undefined
}

function apiFailure(err: unknown): CallToolResult {
  if (err instanceof ApiError) {
    if (err.status === 401 && TOKEN_REJECTED.test(err.body)) return errorResult(RECONNECT)
    const message = apiMessage(err.body)
    return errorResult(
      `The CloudCruise API returned ${err.status}${err.code ? ` (${err.code})` : ""}${message ? `: ${message}` : "."}`
    )
  }
  return errorResult("Could not reach the CloudCruise API.")
}

function apiMessage(body: string): string | undefined {
  try {
    const message = (JSON.parse(body) as { message?: unknown }).message
    return typeof message === "string" ? message : undefined
  } catch {
    return undefined
  }
}

function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] }
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] }
}

interface ProbeJob {
  /** Start time, epoch ms. */
  s: number
  /** Duration, ms. */
  d: number
}

// The handle carries its own state so any replica can answer for it. Unsigned:
// a forged handle only changes the timing of the forger's own fake job.
function encodeHandle(job: ProbeJob): string {
  return HANDLE_PREFIX + Buffer.from(JSON.stringify(job)).toString("base64url")
}

function decodeHandle(handle: string): ProbeJob | undefined {
  if (!handle.startsWith(HANDLE_PREFIX)) return undefined
  try {
    const job = JSON.parse(
      Buffer.from(handle.slice(HANDLE_PREFIX.length), "base64url").toString("utf8")
    ) as Partial<ProbeJob>
    if (Number.isFinite(job.s) && Number.isFinite(job.d)) {
      return { s: job.s as number, d: job.d as number }
    }
  } catch {
    // Not base64url JSON.
  }
  return undefined
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
  })
}
