import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { loadConfig, type Config } from "../dist/config.js"
import { createHttpServer, type McpHttpServer } from "../dist/http.js"
import { createFakeApi, STARTED_CONVERSATION, VIEWER_TOKEN, WORKSPACE, type FakeApi } from "./fake-api.ts"

const INVOICE = "6f1d2c3a-0b4e-4c5d-9e8f-1a2b3c4d5e6f"
const SUCCESSOR = "d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70"
const TURN_A = "7a1b2c3d-0000-4000-8000-00000000000a"
const TURN_B = "7a1b2c3d-0000-4000-8000-00000000000b"
// Reads every 20 ms, waits at most 400 ms; progress every 40 ms.
const HOOKS = { observeTiming: { delaysMs: [20], capMs: () => 400 }, buildTiming: { progressMs: 40 } }

let api: FakeApi
let mcp: McpHttpServer
let mcpUrl: string
let conversations = 0

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return `http://localhost:${(server.address() as AddressInfo).port}`
}

before(async () => {
  api = createFakeApi()
  const config: Config = loadConfig({
    PORT: "0",
    CLOUDCRUISE_API_BASE_URL: await listen(api.server),
    CLOUDCRUISE_OAUTH_ISSUER: "https://issuer.example.test/auth/v1",
    MCP_PUBLIC_URL: "http://localhost:1"
  })
  mcp = createHttpServer(config, HOOKS)
  mcpUrl = `${await listen(mcp.server)}/mcp`
})

after(async () => {
  await mcp.closeMcp()
  mcp.server.closeAllConnections()
  await new Promise((resolve) => mcp.server.close(resolve))
  api.server.closeAllConnections()
  await new Promise((resolve) => api.server.close(resolve))
})

interface ToolResult {
  isError?: boolean
  content: { text: string }[]
  structuredContent?: Record<string, unknown>
}

async function tool(name: string, args: Record<string, unknown>, onprogress?: (p: unknown) => void): Promise<ToolResult> {
  const client = new Client({ name: "test-client", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } })
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { Authorization: "Bearer good" } } }))
  try {
    return (await client.callTool({ name, arguments: args }, onprogress ? { onprogress } : undefined)) as ToolResult
  } finally {
    await client.close()
  }
}

/** A fresh conversation id with a scripted sequence of turn-state reads, and its handle. */
function conversation(reads: Parameters<FakeApi["scriptTurn"]>[1]): { id: string; handle: string } {
  const id = `c0ffee00-0000-4000-8000-${(++conversations).toString().padStart(12, "0")}`
  api.scriptTurn(id, reads)
  return { id, handle: `v1:turn:${WORKSPACE}:${id}` }
}

function sent(path: string) {
  return api.requests.filter((r) => r.path === path)
}

test("build starts a blank conversation, sends the message and returns a handle and after", async () => {
  api.requests.length = 0
  const result = await tool("build", { workspace_id: WORKSPACE, message: "Log in and download invoices", name: "Invoices", start_url: "https://portal.example.test" })
  assert.ok(!result.isError, result.content[0].text)
  const out = result.structuredContent!
  assert.equal(out.handle, `v1:turn:${WORKSPACE}:${STARTED_CONVERSATION}`)
  assert.match(out.after as string, /^t[0-9a-f]{8}\.processing$/)
  assert.deepEqual(
    api.requests.map((r) => [r.method, r.path, r.body]),
    [
      ["POST", "/workflow-builder/agent/session", { name: "Invoices", startUrl: "https://portal.example.test" }],
      ["POST", `/workflow-builder/agent/${STARTED_CONVERSATION}/message`, { text: "Log in and download invoices" }]
    ]
  )
  for (const r of api.requests) assert.equal(r.headers["x-workspace-id"], WORKSPACE)
  const text = JSON.stringify(result)
  for (const leak of [VIEWER_TOKEN, "builderSession", "viewer.example.test", "nodes"]) assert.ok(!text.includes(leak), `result leaks ${leak}`)
})

test("build starts from a workflow with its example inputs", async () => {
  api.requests.length = 0
  await tool("build", { workspace_id: WORKSPACE, message: "Add a logout step", workflow_id: INVOICE })
  assert.deepEqual(sent("/workflow-builder/agent/session/from-workflow")[0].body, { workflowId: INVOICE, useExampleInputs: true })
})

test("build reports progress while the builder starts", async () => {
  api.startDelayMs = 150
  const progress: unknown[] = []
  try {
    const result = await tool("build", { workspace_id: WORKSPACE, message: "Hi", name: "Slow", start_url: "https://portal.example.test" }, (p) => progress.push(p))
    assert.ok(!result.isError)
  } finally {
    api.startDelayMs = 0
  }
  assert.ok(progress.length >= 2, `got ${progress.length} progress notifications`)
  assert.match(JSON.stringify(progress[0]), /Starting the builder browser/)
})

test("build refuses inputs that don't fit, without a request", async () => {
  const { id } = conversation([{ phase: "idle" }])
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ conversation_id: id }, /either message or responses/],
    [{ conversation_id: id, message: "x", responses: { a: 1 } }, /either message or responses/],
    [{ conversation_id: id, message: "x", workflow_id: INVOICE }, /omit them when continuing/],
    [{ responses: { a: 1 } }, /pass its conversation_id/],
    [{ message: "x", workflow_id: INVOICE, name: "n" }, /omit name and start_url/],
    [{ message: "x", name: "n" }, /needs name and start_url, or workflow_id/],
    [{ message: "x" }, /needs name and start_url, or workflow_id/]
  ]
  api.requests.length = 0
  for (const [args, error] of cases) {
    const result = await tool("build", { workspace_id: WORKSPACE, ...args })
    assert.equal(result.isError, true, JSON.stringify(args))
    assert.match(result.content[0].text, error)
  }
  const missing = await tool("build", { message: "x", conversation_id: id })
  assert.equal(missing.isError, true, "workspace_id is required")
  assert.equal(api.requests.length, 0)
})

test("observe holds through processing and returns the report when the turn completes", async () => {
  // The send's message id is the turn's id, so observe's reads match build's after and it holds.
  const { id, handle } = conversation([
    { phase: "processing", turnId: TURN_A },
    { phase: "processing", turnId: TURN_A },
    { phase: "processing", turnId: TURN_A },
    { phase: "completed", turnId: TURN_A, report: "Added a login step and saved." }
  ])
  api.replyTo(id, "message", { conversationId: id, messageId: TURN_A, turnId: TURN_A, accepted: true })
  api.requests.length = 0
  const built = (await tool("build", { workspace_id: WORKSPACE, conversation_id: id, message: "Add a login step" })).structuredContent!
  assert.equal(built.handle, handle)
  assert.equal(sent(`/workflow-builder/agent/${id}/turn-state`).length, 0, "build reads no turn-state after a send")
  const out = (await tool("observe", { handle, after: built.after })).structuredContent!
  assert.ok(sent(`/workflow-builder/agent/${id}/turn-state`).length >= 4, "observe held through the processing reads")
  assert.equal(out.status, "completed")
  assert.equal(out.done, true)
  assert.equal(out.report, "Added a login step and saved.")
  assert.equal(out.statusMessage, "Was working on it, now finished the turn.")
  assert.notEqual(out.after, built.after)
  assert.equal(out.next, "Send the next message with build.")
})

test("observe without after returns the turn at once", async () => {
  const { handle } = conversation([{ phase: "processing", turnId: TURN_A }])
  const out = (await tool("observe", { handle })).structuredContent!
  assert.equal(out.status, "processing")
  assert.equal(out.done, false)
  assert.equal(out.statusMessage, "The builder is working on it.")
  assert.equal(out.next, "Call observe again with the same handle and this after value.")
})

test("observe returns when the same cursor has nothing new before the wait ends", async () => {
  const { handle } = conversation([{ phase: "processing", turnId: TURN_A }])
  const first = (await tool("observe", { handle })).structuredContent!
  const second = (await tool("observe", { handle, after: first.after })).structuredContent!
  assert.equal(second.after, first.after)
  assert.equal(second.statusMessage, "No change since your last call; the builder is still working on it.")
})

test("a new turn between calls is seen even when both reads say processing", async () => {
  const { handle } = conversation([
    { phase: "processing", turnId: TURN_A },
    { phase: "processing", turnId: TURN_B }
  ])
  const first = (await tool("observe", { handle })).structuredContent!
  const second = (await tool("observe", { handle, after: first.after })).structuredContent!
  assert.equal(second.statusMessage, "A new turn started since your last call; the builder is working on it.")
  assert.notEqual(second.after, first.after)
})

test("a second question in the same turn is seen", async () => {
  const fields = [{ name: "plan", type: "select", description: "Which plan?", options: ["Basic", "Pro"] }]
  const { handle } = conversation([
    { phase: "awaiting-human-input", turnId: TURN_A, humanInput: { messageId: "q1", prompt: "Which plan?", fields } },
    { phase: "awaiting-human-input", turnId: TURN_A, humanInput: { messageId: "q2", prompt: "Which plan now?", fields } }
  ])
  const first = (await tool("observe", { handle })).structuredContent!
  assert.deepEqual(first.question, { prompt: "Which plan?", fields })
  assert.ok(!JSON.stringify(first).includes("q1"), "question id stays with the server")
  const second = (await tool("observe", { handle, after: first.after })).structuredContent!
  assert.equal(second.statusMessage, "The builder asked another question.")
  assert.equal(second.next, "Answer with build (conversation_id and responses, or a message), then observe again.")
})

test("a secret field is marked for the dashboard, not for responses", async () => {
  const { handle } = conversation([
    { phase: "awaiting-human-input", turnId: TURN_A, humanInput: { messageId: "q1", prompt: "Portal password", fields: [{ name: "password", type: "secret" }] } }
  ])
  const out = (await tool("observe", { handle })).structuredContent!
  assert.deepEqual(out.question, { prompt: "Portal password", fields: [{ name: "password", type: "secret", enter_in_dashboard: true }] })
  assert.match(out.next as string, /enter each field marked enter_in_dashboard in the CloudCruise dashboard/)
})

test("observe treats a run's after, or garbage, as none on a turn handle", async () => {
  const { handle } = conversation([{ phase: "processing", turnId: TURN_A }])
  for (const after of ["r0.start", "garbage", "t12345678"]) {
    const out = (await tool("observe", { handle, after })).structuredContent!
    assert.equal(out.history_reset, true, after)
    assert.equal(out.statusMessage, "The builder is working on it.")
  }
})

test("build answers the pending question by its message id", async () => {
  const { id } = conversation([
    { phase: "awaiting-human-input", turnId: TURN_A, humanInput: { messageId: "q7", fields: [{ name: "plan", type: "select" }] } },
    { phase: "processing", turnId: TURN_A }
  ])
  api.requests.length = 0
  const result = await tool("build", { workspace_id: WORKSPACE, conversation_id: id, responses: { plan: "Pro" } })
  assert.ok(!result.isError, result.content[0].text)
  assert.deepEqual(sent(`/workflow-builder/agent/${id}/respond`)[0].body, { messageId: "q7", responses: { plan: "Pro" } })
  assert.equal(sent(`/workflow-builder/agent/${id}/turn-state`).length, 1, "only the read that found the question")
  // The answered turn keeps its id: build's after is what observe reads next.
  const next = (await tool("observe", { handle: result.structuredContent!.handle as string })).structuredContent!
  assert.equal(result.structuredContent!.after, next.after)
})

test("build with responses when no question is pending sends nothing", async () => {
  const { id } = conversation([{ phase: "completed", turnId: TURN_A, report: "Done." }])
  api.requests.length = 0
  const result = await tool("build", { workspace_id: WORKSPACE, conversation_id: id, responses: { plan: "Pro" } })
  assert.equal(result.isError, true)
  assert.equal(result.content[0].text, "The builder isn't waiting on a question; send a message instead.")
  assert.equal(sent(`/workflow-builder/agent/${id}/respond`).length, 0)
})

test("a busy builder and an answered question say what to do", async () => {
  const { id } = conversation([{ phase: "awaiting-human-input", turnId: TURN_A, humanInput: { messageId: "q1" } }])
  api.refuseNext(id, 409, "SESSION_BUSY")
  const busy = await tool("build", { workspace_id: WORKSPACE, conversation_id: id, message: "And another thing" })
  assert.equal(busy.content[0].text, "The builder is still working on the last message. Follow it with observe, then send again.")
  api.refuseNext(id, 409, "ALREADY_ANSWERED")
  const answered = await tool("build", { workspace_id: WORKSPACE, conversation_id: id, responses: { plan: "Pro" } })
  assert.equal(answered.content[0].text, "That question was already answered.")
})

test("a cleared conversation: observe ends with its successor, a message follows it, an answer doesn't", async () => {
  const { id, handle } = conversation([{ phase: "processing", turnId: TURN_A }])
  api.clearConversation(id, SUCCESSOR)
  api.scriptTurn(SUCCESSOR, [{ phase: "processing", turnId: TURN_B }])

  const observed = (await tool("observe", { handle })).structuredContent!
  assert.equal(observed.status, "ended")
  assert.equal(observed.done, true)
  assert.equal(observed.successor_conversation_id, SUCCESSOR)

  const followed = (await tool("build", { workspace_id: WORKSPACE, conversation_id: id, message: "Carry on" })).structuredContent!
  assert.equal(followed.handle, `v1:turn:${WORKSPACE}:${SUCCESSOR}`)
  assert.equal(followed.conversation_cleared, true)
  assert.deepEqual(sent(`/workflow-builder/agent/${SUCCESSOR}/message`).at(-1)!.body, { text: "Carry on" })

  const answer = await tool("build", { workspace_id: WORKSPACE, conversation_id: id, responses: { plan: "Pro" } })
  assert.equal(answer.isError, true)
  assert.match(answer.content[0].text, new RegExp(`continues as ${SUCCESSOR}`))
})

test("a conversation gone without a successor tells the model to start again", async () => {
  const { id, handle } = conversation([{ phase: "processing" }])
  api.clearConversation(id)
  const observed = (await tool("observe", { handle })).structuredContent!
  assert.equal(observed.status, "ended")
  assert.equal(observed.next, "Start a new conversation with build.")
  const sentTo = await tool("build", { workspace_id: WORKSPACE, conversation_id: id, message: "Hello?" })
  assert.match(sentTo.content[0].text, /Start a new one with build/)
})

test("a new conversation whose first message fails still hands back its handle", async () => {
  api.refuseNext(STARTED_CONVERSATION, 500, "INTERNAL_SERVER_ERROR")
  const result = await tool("build", { workspace_id: WORKSPACE, message: "Hi", name: "Invoices", start_url: "https://portal.example.test" })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /^The conversation started, but the message failed: The CloudCruise API returned 500/)
  assert.match(result.content[0].text, new RegExp(`Send the message again with build and conversation_id ${STARTED_CONVERSATION}`))
  assert.equal(result.structuredContent!.handle, `v1:turn:${WORKSPACE}:${STARTED_CONVERSATION}`)
})

test("a reply that names no turn returns the handle without after", async () => {
  const { id, handle } = conversation([{ phase: "processing", turnId: TURN_A }])
  api.replyTo(id, "message", { conversationId: id, messageId: "m1", accepted: true })
  const out = (await tool("build", { workspace_id: WORKSPACE, conversation_id: id, message: "Hi" })).structuredContent!
  assert.deepEqual(out, { handle, next: "To follow the turn, call observe with this handle, without after." })
})

test("an answer typed as a message follows the turn it answers", async () => {
  const { id, handle } = conversation([{ phase: "processing", turnId: TURN_A }])
  api.replyTo(id, "message", { conversationId: id, messageId: "m-chat", turnId: TURN_A, accepted: true, answeredInChat: true })
  const built = (await tool("build", { workspace_id: WORKSPACE, conversation_id: id, message: "Pro, please" })).structuredContent!
  assert.equal(built.handle, handle)
  const first = (await tool("observe", { handle })).structuredContent!
  assert.equal(built.after, first.after, "the open turn's id, not the answer's message id")
})
