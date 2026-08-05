import { test, mock } from "node:test"
import assert from "node:assert/strict"
import { Command } from "commander"
import { buildDecideBody, registerRunCommands } from "../dist/src/commands/run.js"
import { ApiClient } from "../dist/src/core/api-client.js"
import { UsageError } from "../dist/src/core/exit.js"

test("buildDecideBody maps option to chosen_option, save_decision defaults false", () => {
  assert.deepEqual(buildDecideBody({ option: "Reschedule" }), {
    chosen_option: "Reschedule",
    save_decision: false
  })
})

test("buildDecideBody sets save_decision true when --save is passed", () => {
  assert.deepEqual(buildDecideBody({ option: "Reschedule", save: true }), {
    chosen_option: "Reschedule",
    save_decision: true
  })
})

test("buildDecideBody trims the option label", () => {
  assert.deepEqual(buildDecideBody({ option: "  Reschedule  " }), {
    chosen_option: "Reschedule",
    save_decision: false
  })
})

test("buildDecideBody throws UsageError when --option is missing", () => {
  assert.throws(() => buildDecideBody({}), UsageError)
})

test("buildDecideBody throws UsageError when --option is blank", () => {
  assert.throws(() => buildDecideBody({ option: "   " }), UsageError)
})

test("run decide command wires option/save through to POST /run/:id/new_input_variables", async () => {
  const calls: Array<{ path: string; body: unknown }> = []
  const postMock = mock.method(
    ApiClient.prototype,
    "post",
    async function (path: string, body: unknown) {
      calls.push({ path, body })
      return {}
    }
  )
  const prevKey = process.env.CLOUDCRUISE_API_KEY
  process.env.CLOUDCRUISE_API_KEY = "test-key"
  try {
    const program = new Command()
    program.exitOverride()
    registerRunCommands(program)
    await program.parseAsync(
      ["run", "decide", "sess-x", "--option", "Reschedule", "--save"],
      { from: "user" }
    )
  } finally {
    postMock.mock.restore()
    if (prevKey === undefined) delete process.env.CLOUDCRUISE_API_KEY
    else process.env.CLOUDCRUISE_API_KEY = prevKey
  }
  assert.equal(calls.length, 1)
  assert.equal(calls[0].path, "/run/sess-x/new_input_variables")
  assert.deepEqual(calls[0].body, {
    chosen_option: "Reschedule",
    save_decision: true
  })
})
