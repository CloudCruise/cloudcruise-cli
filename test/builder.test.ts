import { test } from "node:test"
import assert from "node:assert/strict"
import {
  editCredentialFields,
  buildSaveBody,
  MAX_VERSION_NOTE
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
