import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createServer, type IncomingHttpHeaders, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { loadConfig, type Config } from "../dist/config.js"
import { createHttpServer, type McpHttpServer } from "../dist/http.js"
import { VERSION } from "../dist/tools.js"

const ERAS = [
  { era: "2025-11-25", negotiation: { mode: "legacy" as const } },
  { era: "2026-07-28", negotiation: { mode: { pin: "2026-07-28" } } }
]

// A stand-in for the CloudCruise API: accepts the token "good", records headers.
const apiRequests: { path: string; headers: IncomingHttpHeaders }[] = []
let api: Server
let config: Config
let mcp: McpHttpServer
let mcpUrl: string

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return `http://localhost:${(server.address() as AddressInfo).port}`
}

async function startMcp(): Promise<{ instance: McpHttpServer; url: string }> {
  const instance = createHttpServer(config)
  return { instance, url: `${await listen(instance.server)}/mcp` }
}

before(async () => {
  api = createServer((req, res) => {
    apiRequests.push({ path: req.url ?? "", headers: req.headers })
    if (req.headers.authorization !== "Bearer good") {
      res.writeHead(401, { "Content-Type": "application/json" }).end('{"message":"Unauthorized"}')
      return
    }
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ userId: "u1", email: "u1@example.test", workspaceId: "w1" }))
  })
  const apiUrl = await listen(api)
  // MCP_PUBLIC_URL must name the port before the server starts, so reserve one.
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
  await new Promise<void>((resolve) => mcp.server.listen(port, "127.0.0.1", resolve))
  mcpUrl = `${config.publicUrl}/mcp`
})

after(async () => {
  await mcp.closeMcp()
  mcp.server.closeAllConnections()
  api.closeAllConnections()
  await Promise.all([
    new Promise((resolve) => mcp.server.close(resolve)),
    new Promise((resolve) => api.close(resolve))
  ])
})

async function connect(
  url: string,
  negotiation: (typeof ERAS)[number]["negotiation"],
  token = "good"
): Promise<Client> {
  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { versionNegotiation: { mode: negotiation.mode } }
  )
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    })
  )
  return client
}

function structured(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent
}

test("POST /mcp without a bearer is 401 pointing at the resource metadata", async () => {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
  })
  assert.equal(res.status, 401)
  assert.equal(
    res.headers.get("www-authenticate"),
    `Bearer resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource/mcp"`
  )
})

test("GET and DELETE /mcp are 405", async () => {
  for (const method of ["GET", "DELETE"]) {
    const res = await fetch(mcpUrl, { method, headers: { Authorization: "Bearer good" } })
    assert.equal(res.status, 405, method)
  }
})

test("/healthz is 200 without auth", async () => {
  const res = await fetch(`${config.publicUrl}/healthz`)
  assert.equal(res.status, 200)
})

test("protected-resource metadata names the /mcp resource and one issuer, at both paths", async () => {
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp"
  ]) {
    const res = await fetch(`${config.publicUrl}${path}`)
    assert.equal(res.status, 200, path)
    assert.deepEqual(await res.json(), {
      resource: `${config.publicUrl}/mcp`,
      authorization_servers: ["https://issuer.example.test/auth/v1"],
      bearer_methods_supported: ["header"]
    })
  }
})

test("a foreign Host header is rejected", async () => {
  const { request } = await import("node:http")
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(
      mcpUrl,
      { method: "POST", headers: { Host: "evil.example", Authorization: "Bearer good" } },
      (res) => resolve(res.statusCode ?? 0)
    )
    req.on("error", reject)
    req.end("{}")
  })
  assert.equal(status, 403)
})

// The parts of the conformance scenarios server-stateless and caching that apply
// to this server; the rest of those scenarios need SDK fixture tools.
function modernToolsList(meta: Record<string, unknown>, version = "2026-07-28"): Promise<Response> {
  return fetch(mcpUrl, {
    method: "POST",
    headers: {
      Authorization: "Bearer good",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": version,
      "Mcp-Method": "tools/list"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } })
  })
}

test("[2026-07-28] tools/list carries caching hints", async () => {
  const res = await modernToolsList({
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {}
  })
  assert.equal(res.status, 200)
  const { result } = (await res.json()) as { result: { ttlMs?: unknown; cacheScope?: unknown } }
  assert.equal(typeof result.ttlMs, "number")
  assert.ok(result.cacheScope === "private" || result.cacheScope === "public")
})

test("[2026-07-28] a request whose _meta lacks clientCapabilities is 400 -32602", async () => {
  const res = await modernToolsList({ "io.modelcontextprotocol/protocolVersion": "2026-07-28" })
  assert.equal(res.status, 400)
  assert.equal(((await res.json()) as { error: { code: number } }).error.code, -32602)
})

test("[2026-07-28] an unsupported protocol version is 400 naming the supported ones", async () => {
  const res = await modernToolsList(
    {
      "io.modelcontextprotocol/protocolVersion": "2099-01-01",
      "io.modelcontextprotocol/clientCapabilities": {}
    },
    "2099-01-01"
  )
  assert.equal(res.status, 400)
  const { error } = (await res.json()) as { error: { data: { supported: string[] } } }
  assert.ok(error.data.supported.includes("2026-07-28"))
})

for (const { era, negotiation } of ERAS) {
  test(`[${era}] every tool has a title and a read-only hint`, async () => {
    const client = await connect(mcpUrl, negotiation)
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map((t) => t.name).sort(), ["probe_long", "probe_poll", "whoami"])
    for (const tool of tools) {
      assert.ok(tool.title, `${tool.name} title`)
      assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} readOnlyHint`)
    }
    await client.close()
  })

  test(`[${era}] whoami forwards the token and identifies the server`, async () => {
    apiRequests.length = 0
    const logged: string[] = []
    const realLog = console.log
    console.log = (...args: unknown[]) => logged.push(args.join(" "))
    const client = await connect(mcpUrl, negotiation)
    const result = await client.callTool({ name: "whoami", arguments: {} })
    console.log = realLog
    assert.ok(logged.length > 0, "request lines logged")
    assert.ok(!logged.some((line) => line.includes("good")), "token never logged")
    assert.deepEqual(structured(result), {
      user_id: "u1",
      email: "u1@example.test",
      workspace_id: "w1"
    })
    assert.equal(apiRequests.length, 1)
    const { path, headers } = apiRequests[0]
    assert.equal(path, "/users/me")
    assert.equal(headers.authorization, "Bearer good")
    assert.equal(headers["x-cloudcruise-client"], `mcp/${VERSION}`)
    // Only 2026-07-28 clients send their name on every request.
    assert.equal(
      headers["x-cloudcruise-agent"],
      era === "2026-07-28" ? "test-client" : undefined
    )
    await client.close()
  })

  test(`[${era}] whoami with a rejected token is a tool error asking to reconnect`, async () => {
    const client = await connect(mcpUrl, negotiation, "expired")
    const result = (await client.callTool({ name: "whoami", arguments: {} })) as {
      isError?: boolean
      content: { text: string }[]
    }
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /Reconnect/)
    assert.doesNotMatch(result.content[0].text, /expired|127\.0\.0\.1|localhost/)
    await client.close()
  })
}

test("a probe handle from one instance completes on another", async () => {
  const other = await startMcp()
  try {
    const a = await connect(mcpUrl, ERAS[1].negotiation)
    const started = structured(
      await a.callTool({ name: "probe_long", arguments: { duration_seconds: 1 } })
    )
    assert.match(String(started.handle), /^probe1\./)
    await a.close()

    // A different instance has none of the first one's memory; the handle is enough.
    // Host is checked against MCP_PUBLIC_URL's hostname, so localhost on another port passes.
    const b = await connect(other.url, ERAS[1].negotiation)
    const polled = structured(
      await b.callTool({
        name: "probe_poll",
        arguments: { handle: started.handle, timeout_seconds: 5 }
      })
    )
    assert.deepEqual(polled, { status: "done" })
    await b.close()
  } finally {
    await other.instance.closeMcp()
    other.instance.server.closeAllConnections()
    await new Promise((resolve) => other.instance.server.close(resolve))
  }
})

test("probe_poll without timeout_seconds checks once and returns at once", async () => {
  const client = await connect(mcpUrl, ERAS[1].negotiation)
  const { handle } = structured(
    await client.callTool({ name: "probe_long", arguments: { duration_seconds: 60 } })
  )
  const t0 = Date.now()
  const polled = structured(await client.callTool({ name: "probe_poll", arguments: { handle } }))
  assert.ok(Date.now() - t0 < 1000, "returned without waiting")
  assert.equal(polled.status, "running")
  assert.ok(Number(polled.remaining_seconds) > 50)
  await client.close()
})

test("probe_poll with timeout_seconds waits that long, then reports running", async () => {
  const client = await connect(mcpUrl, ERAS[1].negotiation)
  const { handle } = structured(
    await client.callTool({ name: "probe_long", arguments: { duration_seconds: 60 } })
  )
  const t0 = Date.now()
  const polled = structured(
    await client.callTool({ name: "probe_poll", arguments: { handle, timeout_seconds: 1 } })
  )
  const elapsed = Date.now() - t0
  assert.ok(elapsed >= 900 && elapsed < 3000, `waited ${elapsed} ms`)
  assert.equal(polled.status, "running")
  await client.close()
})

test("probe_poll stops waiting when the client cancels", async () => {
  const own = await startMcp()
  const client = await connect(own.url, ERAS[1].negotiation)
  const { handle } = structured(
    await client.callTool({ name: "probe_long", arguments: { duration_seconds: 600 } })
  )
  const controller = new AbortController()
  const t0 = Date.now()
  const poll = client.callTool(
    { name: "probe_poll", arguments: { handle, timeout_seconds: 600 } },
    { signal: controller.signal }
  )
  setTimeout(() => controller.abort(), 300)
  await assert.rejects(poll)
  assert.ok(Date.now() - t0 < 5000)
  await client.close()
  // The server side must release the wait too, or shutdown would hang on it.
  const t1 = Date.now()
  await own.instance.closeMcp()
  own.instance.server.closeAllConnections()
  await new Promise((resolve) => own.instance.server.close(resolve))
  assert.ok(Date.now() - t1 < 1000, `server released in ${Date.now() - t1} ms`)
})

test("probe_poll rejects a malformed handle", async () => {
  const client = await connect(mcpUrl, ERAS[1].negotiation)
  const result = (await client.callTool({
    name: "probe_poll",
    arguments: { handle: "nope" }
  })) as { isError?: boolean }
  assert.equal(result.isError, true)
  await client.close()
})

test("startup fails naming a missing variable", () => {
  const run = spawnSync(process.execPath, [new URL("../dist/main.js", import.meta.url).pathname], {
    env: { PATH: process.env.PATH, CLOUDCRUISE_API_BASE_URL: "https://api.example.test" },
    encoding: "utf8"
  })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /CLOUDCRUISE_OAUTH_ISSUER is required/)
})

test("config rejects a trailing slash", () => {
  assert.throws(
    () =>
      loadConfig({
        CLOUDCRUISE_API_BASE_URL: "https://api.example.test/",
        CLOUDCRUISE_OAUTH_ISSUER: "https://issuer.example.test",
        MCP_PUBLIC_URL: "https://mcp.example.test"
      }),
    /CLOUDCRUISE_API_BASE_URL must have no trailing slash/
  )
})
