import { test } from "node:test"
import assert from "node:assert/strict"
import { assertFlagsOrPayload } from "../dist/src/commands/vault.js"

test("assertFlagsOrPayload allows flags alone and a payload alone", () => {
  assert.doesNotThrow(() => assertFlagsOrPayload({ userId: "u", domain: "d" }))
  assert.doesNotThrow(() => assertFlagsOrPayload({ file: "entry.json" }))
  assert.doesNotThrow(() => assertFlagsOrPayload({ stdin: true }))
})

test("assertFlagsOrPayload rejects field flags combined with --file or --stdin", () => {
  assert.throws(
    () => assertFlagsOrPayload({ file: "entry.json", domain: "new.example.com" }),
    { name: "UsageError", message: /not both \(got --domain\)/ }
  )
  assert.throws(
    () => assertFlagsOrPayload({ stdin: true, passwordStdin: true, proxyEnable: true }),
    { name: "UsageError", message: /\(got --password-stdin, --proxy-enable\)/ }
  )
})
