import { test } from "node:test"
import assert from "node:assert/strict"
import {
  resolveConversation,
  withAutoFollow
} from "../dist/src/core/conversation.js"
import { AmbiguousSessionError, UsageError } from "../dist/src/core/exit.js"
import { ApiError } from "../dist/src/core/api-client.js"

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

function goneError(successorConversationId?: string) {
  const body = JSON.stringify({
    code: "CONVERSATION_NOT_FOUND",
    ...(successorConversationId ? { successorConversationId } : {})
  })
  return new ApiError("gone", 404, body, "CONVERSATION_NOT_FOUND")
}

const noRoster = {
  get: async () => {
    throw new Error("roster should not be fetched")
  }
} as any

test("withAutoFollow: action succeeds, no reconcile", async () => {
  const r = await withAutoFollow(noRoster, "A", true, "ws-1", async (id) => ({
    id
  }))
  assert.deepEqual(r, { result: { id: "A" }, conversationId: "A" })
})

test("withAutoFollow: eligible follows the enriched successor and retries", async () => {
  const seen: string[] = []
  const r = await withAutoFollow(noRoster, "DEAD", true, "ws-1", async (id) => {
    seen.push(id)
    if (id === "DEAD") throw goneError("TIP")
    return { id }
  })
  assert.deepEqual(seen, ["DEAD", "TIP"])
  assert.deepEqual(r, {
    result: { id: "TIP" },
    conversationId: "TIP",
    reconciledFrom: "DEAD"
  })
})

test("withAutoFollow: eligible falls back to a roster ancestry match", async () => {
  const client = {
    get: async () => ({
      sessions: [
        { conversationId: "TIP", workspaceId: "ws-1", previousConversationIds: ["DEAD"] }
      ]
    })
  } as any
  const seen: string[] = []
  const r = await withAutoFollow(client, "DEAD", true, "ws-1", async (id) => {
    seen.push(id)
    if (id === "DEAD") throw goneError() // no enriched field
    return { id }
  })
  assert.deepEqual(seen, ["DEAD", "TIP"])
  assert.equal(r.reconciledFrom, "DEAD")
})

test("withAutoFollow: whole-chain-dead re-throws (exit 4)", async () => {
  const client = { get: async () => ({ sessions: [] }) } as any
  await assert.rejects(
    () =>
      withAutoFollow(client, "DEAD", true, "ws-1", async (id) => {
        if (id === "DEAD") throw goneError()
        return { id }
      }),
    (err: unknown) =>
      err instanceof ApiError && err.code === "CONVERSATION_NOT_FOUND"
  )
})

test("withAutoFollow: ineligible surfaces successor and never acts again", async () => {
  let calls = 0
  await assert.rejects(
    () =>
      withAutoFollow(noRoster, "DEAD", false, "ws-1", async (id) => {
        calls += 1
        if (id === "DEAD") throw goneError("TIP")
        return { id }
      }),
    (err: unknown) =>
      err instanceof ApiError && err.code === "CONVERSATION_NOT_FOUND"
  )
  assert.equal(calls, 1) // action was NOT retried against the successor
})

test("withAutoFollow: non-404 errors propagate unchanged", async () => {
  const boom = new ApiError("boom", 500, "{}", "INTERNAL")
  await assert.rejects(
    () =>
      withAutoFollow(noRoster, "A", true, "ws-1", async () => {
        throw boom
      }),
    (err: unknown) => err === boom
  )
})
