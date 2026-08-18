import { test } from "node:test"
import assert from "node:assert/strict"
import { classifyTurnState } from "../dist/src/commands/builder.js"
import { ExitCode } from "../dist/src/core/exit.js"

// `await-turn` polls /turn-state and maps the phase to an exit code. The mapping
// is the whole contract a driver switches on, so it is tested directly.

test("processing keeps polling (null outcome)", () => {
  assert.equal(classifyTurnState({ phase: "processing" }), null)
})

test("an unrecognized future phase keeps polling rather than failing open", () => {
  assert.equal(classifyTurnState({ phase: "queued" }), null)
})

test("completed returns the trimmed report at exit 0", () => {
  const o = classifyTurnState({
    phase: "completed",
    report: "  Implemented the Claims component.\n"
  })
  assert.deepEqual(o, {
    kind: "report",
    exitCode: ExitCode.SUCCESS,
    report: "Implemented the Claims component."
  })
})

test("completed with an empty/whitespace report is a failure (exit 1), not a pass", () => {
  const o = classifyTurnState({ phase: "completed", report: "   " })
  assert.equal(o?.kind, "fail")
  assert.equal(o?.exitCode, ExitCode.FAILURE)
})

test("completed with no report field at all is exit 1", () => {
  const o = classifyTurnState({ phase: "completed" })
  assert.equal(o?.exitCode, ExitCode.FAILURE)
})

test("awaiting-human-input returns exit 7 carrying humanInput", () => {
  const humanInput = { messageId: "m1", prompt: "2FA?", fields: [] }
  const o = classifyTurnState({ phase: "awaiting-human-input", humanInput })
  assert.equal(o?.kind, "json")
  assert.equal(o?.exitCode, ExitCode.AWAITING_HUMAN_INPUT)
  assert.deepEqual(o?.kind === "json" ? o.json : null, {
    phase: "awaiting-human-input",
    humanInput
  })
})

test("agent-errored returns exit 8 with the state json", () => {
  const state = { phase: "agent-errored", conversationId: "c1" }
  const o = classifyTurnState(state)
  assert.equal(o?.exitCode, ExitCode.AGENT_ERROR)
  assert.deepEqual(o?.kind === "json" ? o.json : null, state)
})

test("idle does not masquerade as completed (exit 1)", () => {
  const o = classifyTurnState({ phase: "idle", conversationId: "c1" })
  assert.equal(o?.exitCode, ExitCode.FAILURE)
  assert.match(o?.kind === "fail" ? o.message : "", /idle/)
})

test("ended does not masquerade as completed (exit 1)", () => {
  const o = classifyTurnState({ phase: "ended", conversationId: "c1" })
  assert.equal(o?.exitCode, ExitCode.FAILURE)
  assert.match(o?.kind === "fail" ? o.message : "", /ended/)
})
