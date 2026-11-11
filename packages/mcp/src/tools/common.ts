import { readFileSync } from "node:fs"
import { ApiError, SpecCache, Strata, StrataClient } from "@cloudcruise/strata"
import { CLIENT_INFO_META_KEY, type CallToolResult, type ServerContext } from "@modelcontextprotocol/server"
import * as z from "zod/v4"
import type { Config } from "../config.js"

export const VERSION = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: string
  }
).version

// One per process: every request's Strata shares it, so the spec is fetched once per
// TTL, not once per request.
export const specs = new SpecCache({ client: `mcp/${VERSION}` })

// The API's 401s for a bad, expired or missing credential. Other 401s ("Missing
// privileges") and 403s (MFA, workspace access) aren't fixed by signing in again.
export const TOKEN_REJECTED = /invalid or expired|missing authorization|missing or invalid|missing user id/i
export const RECONNECT =
  "The CloudCruise API rejected your token. Reconnect the CloudCruise connector to sign in again."

// Every tool that reaches workspace data requires it. The API answers 503, not 403,
// to an id that isn't a UUID, so the schema refuses one before it is sent.
export const workspaceIdInput = z.guid().describe("The workspace to act in.")

/** What every tool of one request shares: the server's config and the caller's token. */
export interface ToolContext {
  config: Config
  token: string
}

export function client({ config, token }: ToolContext, ctx?: ServerContext, workspaceId?: string): StrataClient {
  return new StrataClient({
    baseUrl: config.apiBaseUrl,
    token,
    authScheme: "bearer",
    workspaceId,
    client: `mcp/${VERSION}`,
    agent: ctx && clientName(ctx)
  })
}

export function strata(tool: ToolContext, ctx?: ServerContext, workspaceId?: string): Strata {
  return new Strata({ client: client(tool, ctx, workspaceId), surface: "mcp", specs })
}

// Only 2026-07-28 clients send clientInfo on every request; 2025 clients sent it
// once in initialize, a separate stateless request, so there is none to read.
function clientName(ctx: ServerContext): string | undefined {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined
  const info = envelope?.[CLIENT_INFO_META_KEY] as { name?: unknown } | undefined
  return typeof info?.name === "string" && info.name ? info.name : undefined
}

export function apiFailure(err: unknown): CallToolResult {
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

export function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] }
}

export function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] }
}
