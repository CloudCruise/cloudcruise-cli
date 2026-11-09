import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { loadConfig, type Config } from "../dist/config.js"
import { createHttpServer, type McpHttpServer } from "../dist/http.js"
import { OBSERVE_TIMING, waitCapMs } from "../dist/tools/observe.js"
import { createFakeApi, WORKSPACE, type FakeApi } from "./fake-api.ts"

const INVOICE = "6f1d2c3a-0b4e-4c5d-9e8f-1a2b3c4d5e6f"
const OTHER_WORKSPACE = "0d1e2f3a-4b5c-4d6e-8f7a-9b0c1d2e3f4a"
const DONE = "2026-11-09T12:00:00Z"
// Reads every 20 ms, waits at most 400 ms: holds take milliseconds, not minutes.
const TIMING = { delaysMs: [20], capMs: () => 400 }

let api: FakeApi
let mcp: McpHttpServer
let mcpUrl: string
let config: Config
let runId = 0

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return `http://localhost:${(server.address() as AddressInfo).port}`
}

async function startMcp(): Promise<{ instance: McpHttpServer; url: string }> {
  const instance = createHttpServer(config, { observeTiming: TIMING })
  return { instance, url: `${await listen(instance.server)}/mcp` }
}

async function stopMcp(instance: McpHttpServer): Promise<void> {
  await instance.closeMcp()
  instance.server.closeAllConnections()
  await new Promise((resolve) => instance.server.close(resolve))
}

before(async () => {
  api = createFakeApi()
  const apiUrl = await listen(api.server)
  config = loadConfig({
    PORT: "0",
    CLOUDCRUISE_API_BASE_URL: apiUrl,
    CLOUDCRUISE_OAUTH_ISSUER: "https://issuer.example.test/auth/v1",
    MCP_PUBLIC_URL: "http://localhost:1"
  })
  const started = await startMcp()
  mcp = started.instance
  mcpUrl = started.url
})

after(async () => {
  await stopMcp(mcp)
  api.server.closeAllConnections()
  await new Promise((resolve) => api.server.close(resolve))
})

interface ToolResult {
  isError?: boolean
  content: { text: string }[]
  structuredContent?: Record<string, unknown>
}

async function connect(url = mcpUrl): Promise<Client> {
  const client = new Client({ name: "test-client", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: "Bearer good" } } })
  )
  return client
}

async function tool(name: string, args: Record<string, unknown>, url = mcpUrl): Promise<ToolResult> {
  const client = await connect(url)
  try {
    return (await client.callTool({ name, arguments: args })) as ToolResult
  } finally {
    await client.close()
  }
}

/** A fresh run id with a scripted sequence of reads, and its handle. */
function scripted(reads: Parameters<FakeApi["scriptRun"]>[1]): { id: string; handle: string } {
  const id = `run_obs${++runId}`
  api.scriptRun(id, reads)
  return { id, handle: `v1:run:${WORKSPACE}:${id}` }
}

function reads(id: string): number {
  return api.requests.filter((r) => r.path === `/run/${id}`).length
}

test("run starts the workflow in the workspace and returns a handle naming both", async () => {
  api.requests.length = 0
  const result = await tool("run", { workflow_id: INVOICE, inputs: { month: "2026-10" }, workspace_id: WORKSPACE })
  assert.equal(result.isError, undefined)
  const out = result.structuredContent!
  assert.match(String(out.handle), new RegExp(`^v1:run:${WORKSPACE}:run_[0-9a-f]+$`))
  assert.match(String(out.next), /observe/)
  assert.equal(api.requests.length, 1)
  assert.equal(api.requests[0].path, "/run")
  assert.equal(api.requests[0].headers["x-workspace-id"], WORKSPACE)
  assert.deepEqual(api.requests[0].body, { workflow_id: INVOICE, run_input_variables: { month: "2026-10" } })

  // The handle it returns is one observe accepts.
  const observed = await tool("observe", { handle: out.handle })
  assert.equal(observed.structuredContent!.status, "execution.queued")
})

test("run without a workspace, or with a workflow id that isn't one, sends nothing", async () => {
  api.requests.length = 0
  const missing = await tool("run", { workflow_id: INVOICE })
  assert.equal(missing.isError, true)
  assert.match(missing.content[0].text, /workspace_id/)
  const bad = await tool("run", { workflow_id: "invoices", workspace_id: WORKSPACE })
  assert.equal(bad.isError, true)
  assert.match(bad.content[0].text, /workflow_id/)
  assert.equal(api.requests.length, 0)
})

test("run passes the API's refusal through", async () => {
  const result = await tool("run", { workflow_id: "00000000-0000-4000-8000-000000000000", workspace_id: WORKSPACE })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /404.*Workflow not found/)
  const foreign = await tool("run", { workflow_id: INVOICE, workspace_id: OTHER_WORKSPACE })
  assert.match(foreign.content[0].text, /403.*Access denied to this workspace/)
})

test("observe without after returns the current state at once, with a cursor", async () => {
  const { id, handle } = scripted([{ status: "execution.start" }, { status: "execution.success", finalized_at: DONE }])
  const out = (await tool("observe", { handle })).structuredContent!
  assert.equal(reads(id), 1, "read once")
  assert.equal(out.status, "execution.start")
  assert.equal(out.attempt, 1)
  assert.equal(out.done, false)
  assert.equal(typeof out.after, "string")
  assert.match(String(out.statusMessage), /Currently start/)
  assert.match(String(out.next), /same handle and this after/)
  assert.equal(out.history_reset, undefined)
})

test("observe with after holds until the run changes, then says what changed", async () => {
  const { id, handle } = scripted([
    { status: "execution.queued" },
    { status: "execution.queued" },
    { status: "execution.queued" },
    { status: "execution.start" }
  ])
  const first = (await tool("observe", { handle })).structuredContent!
  const second = (await tool("observe", { handle, after: first.after })).structuredContent!
  assert.equal(reads(id), 4, "kept reading until the change")
  assert.equal(second.status, "execution.start")
  assert.match(String(second.statusMessage), /Was queued, now start/)
  assert.notEqual(second.after, first.after)
})

test("observe with after returns the same cursor when nothing changes before the wait ends", async () => {
  const { id, handle } = scripted([{ status: "execution.start" }])
  const first = (await tool("observe", { handle })).structuredContent!
  const t0 = Date.now()
  const second = (await tool("observe", { handle, after: first.after })).structuredContent!
  const elapsed = Date.now() - t0
  assert.ok(elapsed >= 300 && elapsed < 2000, `waited ${elapsed} ms`)
  assert.ok(reads(id) > 3, "read more than once while waiting")
  assert.equal(second.after, first.after)
  assert.match(String(second.statusMessage), /No change since your last call; still start/)
})

test("observe sees a requeue between calls even when both reads say start", async () => {
  const { handle } = scripted([{ status: "execution.start" }, { status: "execution.start", session_retries: 1 }])
  const first = (await tool("observe", { handle })).structuredContent!
  const second = (await tool("observe", { handle, after: first.after })).structuredContent!
  assert.equal(second.attempt, 2)
  assert.equal(second.done, false)
  assert.match(String(second.statusMessage), /Requeued once since your last call.*attempt 2.*now start/)
})

test("a failed run that isn't finalized may still be retried; done comes with finalized_at", async () => {
  const failure = { message: "Login failed: the portal asked for a one-time code", error_code: "AUTH-E0001" }
  const { handle } = scripted([
    { status: "execution.failed", errors: [failure] },
    { status: "execution.failed", errors: [failure], finalized_at: DONE }
  ])
  const first = (await tool("observe", { handle })).structuredContent!
  assert.equal(first.done, false)
  assert.equal(first.errors, undefined)
  assert.match(String(first.statusMessage), /may still be retried/)
  const second = (await tool("observe", { handle, after: first.after })).structuredContent!
  assert.equal(second.done, true)
  assert.deepEqual(second.errors, [{ message: failure.message, code: failure.error_code }])
  assert.equal(second.next, undefined)
  assert.match(String(second.statusMessage), /Finished: failed/)
})

test("a finished run returns its output", async () => {
  const data = { invoices: [{ number: "INV-2041", total: 1820.5 }] }
  const { handle } = scripted([{ status: "execution.success", finalized_at: DONE, data }])
  const out = (await tool("observe", { handle })).structuredContent!
  assert.equal(out.done, true)
  assert.deepEqual(out.data, data)
  assert.equal(out.errors, undefined)
})

test("observe treats an after it can't read as none and says so", async () => {
  const { id, handle } = scripted([{ status: "execution.start", session_retries: 1 }])
  // Garbled, a cursor version it doesn't know, and one ahead of the run.
  for (const after of ["nonsense", "e42", "r5.start"]) {
    const before = reads(id)
    const out = (await tool("observe", { handle, after })).structuredContent!
    assert.equal(reads(id) - before, 1, `${after}: read once`)
    assert.equal(out.history_reset, true, after)
    assert.match(String(out.statusMessage), /Currently start/)
    assert.equal(out.after, "r1.start")
  }
})

test("timeout_seconds 0 reads once even with an after", async () => {
  const { id, handle } = scripted([{ status: "execution.start" }])
  const out = (await tool("observe", { handle, after: "r0.start", timeout_seconds: 0 })).structuredContent!
  assert.equal(reads(id), 1)
  assert.match(String(out.statusMessage), /No change/)
})

test("observe rejects a handle it can't read, without a request", async () => {
  api.requests.length = 0
  for (const handle of [
    "run_8f2c",
    `v2:run:${WORKSPACE}:run_8f2c`,
    `v1:turn:${WORKSPACE}:run_8f2c`,
    "v1:run:not-a-workspace:run_8f2c",
    `v1:run:${WORKSPACE}:run/8f2c`
  ]) {
    const result = await tool("observe", { handle })
    assert.equal(result.isError, true, handle)
    assert.match(result.content[0].text, /Invalid handle/)
  }
  assert.equal(api.requests.length, 0)
})

test("observe reads in the handle's workspace", async () => {
  api.requests.length = 0
  const result = await tool("observe", { handle: `v1:run:${OTHER_WORKSPACE}:run_8f2c` })
  assert.equal(api.requests[0].headers["x-workspace-id"], OTHER_WORKSPACE)
  assert.match(result.content[0].text, /403.*Access denied/)
})

test("a handle from one instance is served by another", async () => {
  const { handle } = scripted([{ status: "execution.start" }, { status: "execution.success", finalized_at: DONE }])
  const first = (await tool("observe", { handle })).structuredContent!
  const other = await startMcp()
  try {
    const second = (await tool("observe", { handle, after: first.after }, other.url)).structuredContent!
    assert.equal(second.done, true)
  } finally {
    await stopMcp(other.instance)
  }
})

test("observe stops reading when the client cancels", async () => {
  const own = createHttpServer(config, { observeTiming: { delaysMs: [20], capMs: () => 60_000 } })
  const url = `${await listen(own.server)}/mcp`
  const { id, handle } = scripted([{ status: "execution.start" }])
  const client = await connect(url)
  const controller = new AbortController()
  const call = client.callTool({ name: "observe", arguments: { handle, after: "r0.start" } }, { signal: controller.signal })
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.ok(reads(id) > 1, "server is waiting")
  controller.abort()
  await assert.rejects(call)
  await new Promise((resolve) => setTimeout(resolve, 100))
  const settled = reads(id)
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(reads(id), settled, "no reads after the cancel")
  await client.close()
  await stopMcp(own)
})

test("reads back off 1, 2, 5, then every 10 s", () => {
  assert.deepEqual(OBSERVE_TIMING.delaysMs, [1000, 2000, 5000, 10_000])
})

test("the wait cap follows the client", () => {
  assert.equal(waitCapMs("claude-code"), 50_000)
  assert.equal(waitCapMs("claude-ai"), 200_000)
  assert.equal(waitCapMs("openai-mcp"), 45_000)
  assert.equal(waitCapMs(undefined), 45_000)
})
