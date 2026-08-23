import { test } from "node:test"
import assert from "node:assert/strict"
import {
  editCredentialFields,
  buildSaveBody,
  MAX_VERSION_NOTE,
  parseBuilderResponseValue,
  pickConversationSelector,
  parseTranscriptLimit,
  tailChat,
  buildArchiveOutput
} from "../dist/src/commands/builder.js"
import { UsageError } from "../dist/src/core/exit.js"

test("editCredentialFields maps both flags to permissionedUserId/authUrl", () => {
  const fields = editCredentialFields({
    vaultUserId: "user-123",
    vaultDomain: "example.com"
  })
  assert.deepEqual(fields, {
    permissionedUserId: "user-123",
    authUrl: "example.com"
  })
})

test("editCredentialFields returns {} when neither flag is set", () => {
  assert.deepEqual(editCredentialFields({}), {})
})

test("editCredentialFields throws UsageError when only --vault-user-id is set", () => {
  assert.throws(
    () => editCredentialFields({ vaultUserId: "user-123" }),
    UsageError
  )
})

test("editCredentialFields throws UsageError when only --vault-domain is set", () => {
  assert.throws(
    () => editCredentialFields({ vaultDomain: "example.com" }),
    UsageError
  )
})

test("buildSaveBody returns undefined when no message is given", () => {
  assert.equal(buildSaveBody({}), undefined)
})

test("buildSaveBody returns undefined for whitespace-only message", () => {
  assert.equal(buildSaveBody({ message: "   " }), undefined)
})

test("buildSaveBody trims and wraps a message as versionNote", () => {
  assert.deepEqual(buildSaveBody({ message: "  hi  " }), { versionNote: "hi" })
})

test("buildSaveBody accepts a message at the max length", () => {
  const note = "x".repeat(MAX_VERSION_NOTE)
  assert.deepEqual(buildSaveBody({ message: note }), { versionNote: note })
})

test("buildSaveBody throws UsageError when over the max length", () => {
  assert.throws(
    () => buildSaveBody({ message: "x".repeat(MAX_VERSION_NOTE + 1) }),
    UsageError
  )
})

test("parseBuilderResponseValue parses an error suggestion response", () => {
  assert.deepEqual(parseBuilderResponseValue('{"kind":"accept_suggestion"}'), {
    kind: "accept_suggestion"
  })
})

test("parseBuilderResponseValue preserves plain text", () => {
  assert.equal(parseBuilderResponseValue("accepted"), "accepted")
})

test("parseBuilderResponseValue parses existing typed primitive responses", () => {
  assert.equal(parseBuilderResponseValue("42"), 42)
  assert.equal(parseBuilderResponseValue("false"), false)
  assert.equal(parseBuilderResponseValue("null"), null)
})

test("parseBuilderResponseValue does not treat arrays as response objects", () => {
  assert.equal(parseBuilderResponseValue('["one","two"]'), '["one","two"]')
})

test("pickConversationSelector prefers the positional id", () => {
  assert.equal(pickConversationSelector("conv-1", undefined), "conv-1")
})

test("pickConversationSelector falls back to --conversation", () => {
  assert.equal(pickConversationSelector(undefined, "conv-1"), "conv-1")
})

test("pickConversationSelector returns undefined when neither is given", () => {
  assert.equal(pickConversationSelector(undefined, undefined), undefined)
})

test("pickConversationSelector accepts a matching id and flag", () => {
  assert.equal(pickConversationSelector("conv-1", "conv-1"), "conv-1")
})

test("pickConversationSelector throws UsageError on conflicting ids", () => {
  assert.throws(
    () => pickConversationSelector("conv-1", "conv-2"),
    UsageError
  )
})

const CHAT = [1, 2, 3, 4, 5]

test("parseTranscriptLimit returns undefined when no limit is given", () => {
  assert.equal(parseTranscriptLimit(undefined), undefined)
})

test("parseTranscriptLimit accepts 0 for metadata only", () => {
  assert.equal(parseTranscriptLimit("0"), 0)
})

test("parseTranscriptLimit has no upper bound (the window is local)", () => {
  assert.equal(parseTranscriptLimit("1000"), 1000)
  assert.equal(parseTranscriptLimit("50000"), 50000)
})

test("parseTranscriptLimit rejects a negative or non-numeric limit", () => {
  assert.throws(() => parseTranscriptLimit("-1"), UsageError)
  assert.throws(() => parseTranscriptLimit("all"), UsageError)
})

test("parseTranscriptLimit rejects an unsafe integer", () => {
  assert.throws(() => parseTranscriptLimit("99999999999999999999"), UsageError)
})

test("tailChat returns the whole transcript when no limit is given", () => {
  assert.deepEqual(tailChat(CHAT), {
    chat: [1, 2, 3, 4, 5],
    total: 5,
    limit: null,
    hasMore: false
  })
})

test("tailChat keeps the newest messages under a limit", () => {
  const t = tailChat(CHAT, 2)
  assert.deepEqual(t.chat, [4, 5])
  assert.equal(t.total, 5)
  assert.equal(t.hasMore, true)
})

test("tailChat with limit 0 returns no messages but still counts them", () => {
  const t = tailChat(CHAT, 0)
  assert.deepEqual(t.chat, [])
  assert.equal(t.total, 5)
  assert.equal(t.limit, 0)
  assert.equal(t.hasMore, true)
})

test("tailChat reports hasMore false when the limit covers everything", () => {
  const t = tailChat(CHAT, 5)
  assert.deepEqual(t.chat, CHAT)
  assert.equal(t.hasMore, false)
  assert.equal(tailChat(CHAT, 99).hasMore, false)
})

test("tailChat handles an empty transcript", () => {
  const t = tailChat([], 10)
  assert.deepEqual(t.chat, [])
  assert.equal(t.total, 0)
  assert.equal(t.hasMore, false)
})

test("buildArchiveOutput tails the chat and puts it last", () => {
  const out = buildArchiveOutput(
    "conv-1",
    { conversation: { conversation_id: "conv-1" }, chat: CHAT },
    { limit: 2 }
  )
  assert.deepEqual(Object.keys(out), [
    "conversationId",
    "conversation",
    "chat_error",
    "total",
    "limit",
    "hasMore",
    "chat"
  ])
  assert.deepEqual(out.chat, [4, 5])
  assert.equal(out.total, 5)
})

test("buildArchiveOutput drops the snapshot unless asked", () => {
  const raw = { chat: CHAT, workflow_snapshot: { id: "wf-1" } }
  assert.equal("workflow_snapshot" in buildArchiveOutput("conv-1", raw), false)
  assert.deepEqual(
    buildArchiveOutput("conv-1", raw, { snapshot: true }).workflow_snapshot,
    { id: "wf-1" }
  )
})

test("buildArchiveOutput drops the sharing flags", () => {
  const out = buildArchiveOutput("conv-1", {
    chat: CHAT,
    ...{ can_reshare: true, workflow_accessible: true }
  })
  assert.equal("can_reshare" in out, false)
  assert.equal("workflow_accessible" in out, false)
})

test("buildArchiveOutput surfaces a snapshot error without --snapshot", () => {
  const out = buildArchiveOutput("conv-1", {
    chat: CHAT,
    workflow_snapshot_error: "signer down"
  })
  assert.equal(out.workflow_snapshot_error, "signer down")
})

test("buildArchiveOutput passes through a missing transcript with no page", () => {
  const out = buildArchiveOutput("conv-1", { conversation: {}, chat: null })
  assert.equal(out.chat, null)
  assert.equal(out.chat_error, null)
  assert.equal("total" in out, false)
})

test("buildArchiveOutput reports a fetch error for an unreadable transcript", () => {
  const out = buildArchiveOutput("conv-1", {
    chat: null,
    chat_error: "Failed to fetch chat file: 403"
  })
  assert.equal(out.chat, null)
  assert.equal(out.chat_error, "Failed to fetch chat file: 403")
})

const MIXED_CHAT = [
  { role: "user", text: "build it" },
  { role: "system", event_type: "network_traffic_batch" },
  { role: "assistant", text: "done" },
  { role: "system", event_type: "execution.dispatch_run" }
]

test("buildArchiveOutput drops system messages and counts them", () => {
  const out = buildArchiveOutput("conv-1", { chat: MIXED_CHAT })
  assert.deepEqual(out.chat, [
    { role: "user", text: "build it" },
    { role: "assistant", text: "done" }
  ])
  assert.equal(out.total, 2)
  assert.equal(out.systemMessagesOmitted, 2)
})

test("buildArchiveOutput keeps system messages with includeSystem", () => {
  const out = buildArchiveOutput("conv-1", { chat: MIXED_CHAT }, {
    includeSystem: true
  })
  assert.equal((out.chat as unknown[]).length, 4)
  assert.equal(out.total, 4)
  assert.equal("systemMessagesOmitted" in out, false)
})

test("buildArchiveOutput omits systemMessagesOmitted when there are none", () => {
  const out = buildArchiveOutput("conv-1", {
    chat: [{ role: "user", text: "hi" }]
  })
  assert.equal("systemMessagesOmitted" in out, false)
})

test("buildArchiveOutput tails the filtered transcript, not the raw one", () => {
  const out = buildArchiveOutput("conv-1", { chat: MIXED_CHAT }, { limit: 1 })
  assert.deepEqual(out.chat, [{ role: "assistant", text: "done" }])
  assert.equal(out.total, 2)
  assert.equal(out.hasMore, true)
})

test("buildArchiveOutput tolerates non-object entries in the transcript", () => {
  const out = buildArchiveOutput("conv-1", { chat: [null, "note", 7] })
  assert.deepEqual(out.chat, [null, "note", 7])
  assert.equal(out.total, 3)
})

test("buildArchiveOutput reports --output's file with the metadata, not after the chat", () => {
  const out = buildArchiveOutput("conv-1", { chat: MIXED_CHAT }, {
    file: "/tmp/raw.json"
  })
  const keys = Object.keys(out)
  assert.equal(out.file, "/tmp/raw.json")
  assert.ok(keys.indexOf("file") < keys.indexOf("chat"))
})

test("buildArchiveOutput omits file when --output was not passed", () => {
  assert.equal("file" in buildArchiveOutput("conv-1", { chat: MIXED_CHAT }), false)
})

test("buildArchiveOutput with limit 0 keeps the metadata and empties the chat", () => {
  const out = buildArchiveOutput("conv-1", { chat: MIXED_CHAT }, { limit: 0 })
  assert.deepEqual(out.chat, [])
  assert.equal(out.total, 2)
  assert.equal(out.limit, 0)
  assert.equal(out.hasMore, true)
  assert.equal(out.systemMessagesOmitted, 2)
})
