import { test } from "node:test"
import assert from "node:assert/strict"
import { buildDecideBody } from "../dist/src/commands/run.js"
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
