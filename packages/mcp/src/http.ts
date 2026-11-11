import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { createMcpHandler } from "@modelcontextprotocol/server"
import { hostHeaderValidation, originValidation, toNodeHandler } from "@modelcontextprotocol/node"
import type { Config } from "./config.js"
import { createServer as createMcpServer, type TestHooks } from "./tools/index.js"

const METADATA_PATHS = new Set([
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp"
])

// Clients request exactly these. Without them they fall back to every scope
// the authorization server lists, which includes `phone`.
const SCOPES = ["openid", "email", "offline_access"]

export interface McpHttpServer {
  server: Server
  /** Aborts in-flight MCP exchanges (e.g. long polls) so the process can exit. */
  closeMcp: () => Promise<void>
}

export function createHttpServer(config: Config, hooks: TestHooks = {}): McpHttpServer {
  const resource = `${config.publicUrl}/mcp`
  const metadataUrl = `${config.publicUrl}/.well-known/oauth-protected-resource/mcp`
  const metadata = JSON.stringify({
    resource,
    authorization_servers: [config.oauthIssuer],
    scopes_supported: SCOPES,
    bearer_methods_supported: ["header"]
  })
  const publicHost = new URL(config.publicUrl).hostname
  const validateHost = hostHeaderValidation([publicHost])
  const validateOrigin = originValidation([publicHost])

  // The SDK never reads the Authorization header; the gate below hands it the
  // token as authInfo, and each request gets its own McpServer bound to it.
  const mcp = createMcpHandler(({ authInfo }) => createMcpServer(config, authInfo?.token ?? "", hooks))
  const mcpNode = toNodeHandler(mcp)

  const server = createServer((req, res) => {
    const started = Date.now()
    // "close" fires once per response, also when the client drops the request
    // before it finishes; "finish" alone would leave aborted calls unlogged.
    res.on("close", () => logRequest(req, res, started))

    const path = (req.url ?? "/").split("?")[0]
    if (path === "/healthz" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ok")
      return
    }
    if (METADATA_PATHS.has(path) && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(metadata)
      return
    }
    if (path !== "/mcp") {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found")
      return
    }
    if (!validateHost(req, res) || !validateOrigin(req, res)) return

    // GET and DELETE fall through to the SDK, which answers them with 405.
    if (req.method === "POST") {
      const token = bearerToken(req)
      if (!token) {
        res
          .writeHead(401, {
            "Content-Type": "application/json",
            "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}", scope="${SCOPES.join(" ")}"`
          })
          .end(JSON.stringify({ error: "unauthorized", error_description: "Bearer token required" }))
        return
      }
      // Not validated here: the API authorizes every call made with it.
      Object.assign(req, { auth: { token, clientId: "", scopes: [] } })
    }
    void mcpNode(req, res)
  })

  return { server, closeMcp: () => mcp.close() }
}

function bearerToken(req: IncomingMessage): string | undefined {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? "")
  return match?.[1]
}

// Never logs headers: the Authorization header carries the user's token.
function logRequest(req: IncomingMessage, res: ServerResponse, started: number): void {
  console.log(
    JSON.stringify({
      method: req.method,
      path: (req.url ?? "/").split("?")[0],
      status: res.statusCode,
      finished: res.writableFinished,
      ms: Date.now() - started
    })
  )
}
