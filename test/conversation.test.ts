import { test } from "node:test"
import assert from "node:assert/strict"
import { resolveConversation } from "../dist/src/core/conversation.js"
import { AmbiguousSessionError, UsageError } from "../dist/src/core/exit.js"

function entry(conversationId: string, workspaceId: string) {
  return { conversationId, workspaceId, status: "idle", startedAt: 0 }
}

function clientWith(sessions: unknown[]) {
  return { get: async () => ({ sessions }) } as any
}

test("--conversation wins and skips the roster entirely", async () => {
  let called = false
  const client = {
    get: async () => {
      called = true
      return { sessions: [] }
    }
  } as any
  const r = await resolveConversation(client, { conversation: "X" }, "ws-1")
  assert.deepEqual(r, { conversationId: "X", source: "flag" })
  assert.equal(called, false)
})

test("CLOUDCRUISE_CONVERSATION is used when no flag, and skips the roster", async () => {
  process.env.CLOUDCRUISE_CONVERSATION = "E"
  try {
    const client = {
      get: async () => {
        throw new Error("roster should not be fetched on the env path")
      }
    } as any
    const r = await resolveConversation(client, {}, "ws-1")
    assert.deepEqual(r, { conversationId: "E", source: "env" })
  } finally {
    delete process.env.CLOUDCRUISE_CONVERSATION
  }
})

test("sole survivor in workspace scope resolves via roster", async () => {
  const client = clientWith([entry("A", "ws-1"), entry("B", "ws-2")])
  const r = await resolveConversation(client, {}, "ws-1")
  assert.deepEqual(r, { conversationId: "A", source: "roster" })
})

test("zero in scope throws UsageError (exit 2)", async () => {
  const client = clientWith([entry("B", "ws-2")])
  await assert.rejects(() => resolveConversation(client, {}, "ws-1"), UsageError)
})

test("more than one in scope throws AmbiguousSessionError (exit 5)", async () => {
  const client = clientWith([entry("A", "ws-1"), entry("B", "ws-1")])
  await assert.rejects(
    () => resolveConversation(client, {}, "ws-1"),
    AmbiguousSessionError
  )
})

test("no workspace filter considers every roster entry", async () => {
  const client = clientWith([entry("A", "ws-1"), entry("B", "ws-2")])
  await assert.rejects(
    () => resolveConversation(client, {}, undefined),
    AmbiguousSessionError
  )
})
