import { test } from "node:test"
import assert from "node:assert/strict"
import { editCredentialFields } from "../dist/src/commands/builder.js"
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
