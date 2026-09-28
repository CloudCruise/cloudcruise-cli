import { test } from "node:test"
import assert from "node:assert/strict"
import {
  buildCreateErrorCodeBody,
  buildListErrorCodesPath,
  buildUpdateErrorCodeBody
} from "../dist/src/commands/error-codes.js"
import { UsageError } from "../dist/src/core/exit.js"

const WORKFLOW_ID = "d413c71b-841e-40e6-8765-29df2968af26"

test("buildListErrorCodesPath lists the whole workspace by default", () => {
  assert.equal(buildListErrorCodesPath({}), "/error-codes")
})

test("buildListErrorCodesPath filters by workflow", () => {
  assert.equal(
    buildListErrorCodesPath({ workflowId: WORKFLOW_ID }),
    `/error-codes?workflow_id=${WORKFLOW_ID}`
  )
})

test("buildListErrorCodesPath rejects a non-UUID workflow id", () => {
  assert.throws(() => buildListErrorCodesPath({ workflowId: "wf_1" }), UsageError)
})

test("buildCreateErrorCodeBody maps flags to snake_case fields", () => {
  const body = buildCreateErrorCodeBody({
    code: "CLAIM_NOT_FOUND",
    description: "Claim not found",
    enrichedDescription: "The claim search returned no rows",
    action: "retry",
    retries: 2,
    retryAfter: 0
  })
  assert.deepEqual(body, {
    error_code: "CLAIM_NOT_FOUND",
    description: "Claim not found",
    enriched_description: "The claim search returned no rows",
    error_action: "retry",
    retries: 2,
    retry_after: 0
  })
})

test("buildCreateErrorCodeBody requires a code and a description", () => {
  assert.throws(() => buildCreateErrorCodeBody({ description: "x" }), UsageError)
  assert.throws(() => buildCreateErrorCodeBody({ code: "X" }), UsageError)
  assert.throws(
    () => buildCreateErrorCodeBody({ code: "  ", description: "x" }),
    UsageError
  )
})

test("buildCreateErrorCodeBody takes fields from stdin, with flags winning", () => {
  const body = buildCreateErrorCodeBody(
    { description: "From the flag" },
    { error_code: "PORTAL_DOWN", description: "From stdin", error_action: "retry" }
  )
  assert.deepEqual(body, {
    error_code: "PORTAL_DOWN",
    description: "From the flag",
    error_action: "retry"
  })
})

test("buildUpdateErrorCodeBody sends only the fields passed", () => {
  assert.deepEqual(buildUpdateErrorCodeBody({ action: "cancel" }), {
    error_action: "cancel"
  })
})

test("buildUpdateErrorCodeBody requires at least one field", () => {
  assert.throws(() => buildUpdateErrorCodeBody({}), UsageError)
})

test("buildCreateErrorCodeBody rejects invalid stdin fields the flags would reject", () => {
  const base = { error_code: "X", description: "x" }
  assert.throws(
    () => buildCreateErrorCodeBody({}, { ...base, error_action: "invalid" }),
    UsageError
  )
  assert.throws(
    () => buildCreateErrorCodeBody({}, { ...base, retries: "two" }),
    UsageError
  )
  assert.throws(
    () => buildCreateErrorCodeBody({}, { ...base, retry_after: -1 }),
    UsageError
  )
  assert.throws(
    () => buildCreateErrorCodeBody({}, { ...base, retries: 2 ** 53 }),
    UsageError
  )
  assert.throws(
    () => buildCreateErrorCodeBody({}, { ...base, description: 5 }),
    UsageError
  )
})

test("buildUpdateErrorCodeBody rejects unknown stdin fields", () => {
  assert.throws(() => buildUpdateErrorCodeBody({}, { id: "x" }), UsageError)
})
