import { test } from "node:test"
import assert from "node:assert/strict"
import {
  buildErrorCodeBody,
  buildListErrorCodesPath
} from "../dist/src/commands/error-codes.js"

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

test("buildErrorCodeBody maps flags to the API's snake_case fields", () => {
  const body = buildErrorCodeBody({
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

test("buildErrorCodeBody sends only the flags that were passed", () => {
  assert.deepEqual(buildErrorCodeBody({ action: "cancel" }), {
    error_action: "cancel"
  })
})

test("buildErrorCodeBody passes stdin fields through unchanged, with flags winning", () => {
  const body = buildErrorCodeBody(
    { description: "From the flag" },
    { error_code: "PORTAL_DOWN", description: "From stdin", future_field: true }
  )
  assert.deepEqual(body, {
    error_code: "PORTAL_DOWN",
    description: "From the flag",
    future_field: true
  })
})
