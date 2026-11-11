import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { loadConfig, type Config } from "../dist/config.js"
import { createHttpServer, type McpHttpServer } from "../dist/http.js"
import { createFakeApi, WORKSPACE, type FakeApi } from "./fake-api.ts"

let api: FakeApi
let config: Config
let mcp: McpHttpServer
let mcpUrl: string

const LINK = "https://dash.example.test/auth/connector-verify?id=abc"

async function listen(server: Server, port = 0): Promise<string> {
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve))
  return `http://localhost:${(server.address() as AddressInfo).port}`
}

before(async () => {
  api = createFakeApi()
  const apiUrl = await listen(api.server)
  const probe = createServer()
  const port = Number(new URL(await listen(probe)).port)
  await new Promise((resolve) => probe.close(resolve))
  config = loadConfig({
    PORT: String(port),
    CLOUDCRUISE_API_BASE_URL: apiUrl,
    CLOUDCRUISE_OAUTH_ISSUER: "https://issuer.example.test/auth/v1",
    MCP_PUBLIC_URL: `http://localhost:${port}`
  })
  mcp = createHttpServer(config)
  await listen(mcp.server, port)
  mcpUrl = `${config.publicUrl}/mcp`
})

after(async () => {
  await mcp.closeMcp()
  mcp.server.closeAllConnections()
  api.server.closeAllConnections()
  await Promise.all([
    new Promise((resolve) => mcp.server.close(resolve)),
    new Promise((resolve) => api.server.close(resolve))
  ])
})

let sessions = 0

/** A JWT-shaped token; the server decodes it without verifying, as it does real ones. */
function jwt(claims: Record<string, unknown>): string {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url")
  return `${part({ alg: "ES256" })}.${part({ sub: "u1", ...claims })}.sig`
}

function grant(aal = "aal1"): string {
  return jwt({ aal, client_id: "claude", session_id: `s-${++sessions}` })
}

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "test-client", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } })
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  return client
}

interface ToolResult {
  isError?: boolean
  content: { text: string }[]
}

async function whoami(token: string): Promise<ToolResult> {
  const client = await connect(token)
  try {
    return (await client.callTool({ name: "whoami", arguments: {} })) as ToolResult
  } finally {
    await client.close()
  }
}

const stepUpCalls = (token: string) =>
  api.requests.filter((r) => r.path === "/mcp/step-up" && r.headers.authorization === `Bearer ${token}`).length

test("an aal1 grant of a user without MFA is served, and the API is asked once per session, not once per request", async () => {
  const token = grant()
  api.accept(token)
  api.stepUp(token, { status: "none" })
  assert.equal((await whoami(token)).isError, undefined)
  assert.equal((await whoami(token)).isError, undefined)
  assert.equal(stepUpCalls(token), 1)
})

test("an aal2 token and a token without client_id never cost a step-up call, because only OAuth grants come back aal1 after MFA", async () => {
  const aal2 = grant("aal2")
  const browser = jwt({ aal: "aal1", session_id: "browser" })
  for (const token of [aal2, browser]) {
    api.accept(token)
    api.stepUp(token, { status: "required", url: LINK })
    assert.equal((await whoami(token)).isError, undefined)
    assert.equal(stepUpCalls(token), 0)
  }
})

test("until the user confirms the connector, every tool answers with the link and nothing reaches workspace data", async () => {
  const token = grant()
  api.accept(token)
  api.stepUp(token, { status: "required", url: LINK, expires_at: "2026-11-10T12:00:00Z" })
  const client = await connect(token)
  const { tools } = await client.listTools()
  assert.deepEqual(tools.map((t) => t.name).sort(), ["build", "call", "observe", "run", "search", "whoami"])
  api.requests.length = 0
  const calls: [string, Record<string, unknown>][] = [
    ["whoami", {}],
    ["search", { query: "invoices" }],
    ["call", { operation: "workflows.list", workspace_id: WORKSPACE, arguments: {} }],
    ["run", { workflow_id: "6f1d2c3a-0b4e-4c5d-9e8f-1a2b3c4d5e6f", workspace_id: WORKSPACE, inputs: {} }]
  ]
  for (const [name, args] of calls) {
    const result = (await client.callTool({ name, arguments: args })) as ToolResult
    assert.equal(result.isError, true, name)
    assert.ok(result.content[0].text.includes(LINK), name)
  }
  await client.close()
  assert.deepEqual(
    api.requests.filter((r) => r.path !== "/mcp/step-up").map((r) => r.path),
    [],
    "no API call other than the step-up check"
  )
})

test("after the user confirms, the old aal1 token gets 401 invalid_token so the client refreshes to an aal2 token", async () => {
  const token = grant()
  api.stepUp(token, { status: "refresh" })
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
  })
  assert.equal(res.status, 401)
  const challenge = res.headers.get("www-authenticate") ?? ""
  assert.match(challenge, /^Bearer error="invalid_token"/)
  assert.ok(challenge.includes(`resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource/mcp"`))
})

test("when the API has no step-up endpoint or fails, the request is served as before, because the API still authorizes every call", async () => {
  for (const answer of [undefined, 500]) {
    const token = grant()
    api.accept(token)
    if (answer !== undefined) api.stepUp(token, answer)
    assert.equal((await whoami(token)).isError, undefined, String(answer ?? 404))
  }
})

test("a bearer that isn't a JWT is passed to the API unchanged and never costs a step-up call", async () => {
  assert.equal((await whoami("good")).isError, undefined)
  assert.equal(stepUpCalls("good"), 0)
})
