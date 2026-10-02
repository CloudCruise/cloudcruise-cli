import { test } from "node:test"
import assert from "node:assert/strict"
import { ApiError } from "../dist/src/core/api-client.js"
import {
  buildErrorEnvelope,
  ExitCode,
  exitCodeForApiError
} from "../dist/src/core/exit.js"

const usageLimitBody = JSON.stringify({
  statusCode: 402,
  error: "UsageLimitExceeded",
  code: "USAGE_LIMIT_EXCEEDED",
  reason: "NO_PAYMENT_METHOD",
  currentUsage: 2.482,
  limit: 2,
  message:
    "Starter tier included browser hours exceeded. Please add a card at https://app.cloudcruise.com/billing to continue. Current usage: 2.482, Limit: 2"
})

const usageLimitError = () =>
  new ApiError(
    "Starter tier included browser hours exceeded.",
    402,
    usageLimitBody,
    "USAGE_LIMIT_EXCEEDED"
  )

test("USAGE_LIMIT_EXCEEDED exits 12 (USAGE_LIMIT), so a driver can tell running out of browser hours apart from a bad credential", () => {
  assert.equal(exitCodeForApiError(usageLimitError()), ExitCode.USAGE_LIMIT)
  assert.equal(ExitCode.USAGE_LIMIT, 12)
})

test("a bare 402 without a code still exits 12, because 402 Payment Required only ever means a usage limit from this backend", () => {
  assert.equal(
    exitCodeForApiError(new ApiError("Payment required", 402, "")),
    ExitCode.USAGE_LIMIT
  )
})

test("401 UNAUTHENTICATED still exits 3 (AUTH), because real credential failures must keep their exit code", () => {
  assert.equal(
    exitCodeForApiError(
      new ApiError("Unauthorized", 401, "", "UNAUTHENTICATED")
    ),
    ExitCode.AUTH
  )
})

test("the stderr envelope for a usage limit carries reason, currentUsage and limit, so a driver can branch on why without parsing the message", () => {
  const { exitCode, envelope } = buildErrorEnvelope(usageLimitError())
  assert.equal(exitCode, 12)
  assert.deepEqual(envelope, {
    code: "USAGE_LIMIT_EXCEEDED",
    statusCode: 402,
    message: "Starter tier included browser hours exceeded.",
    reason: "NO_PAYMENT_METHOD",
    currentUsage: 2.482,
    limit: 2,
    exitCode: 12
  })
})

test("a non-usage error does not pick up a reason field from its body, because reason only has a defined meaning for usage limits", () => {
  const { envelope } = buildErrorEnvelope(
    new ApiError(
      "Conflict",
      409,
      JSON.stringify({ code: "SESSION_BUSY", reason: "something" }),
      "SESSION_BUSY"
    )
  )
  assert.equal(envelope.reason, undefined)
  assert.equal(envelope.exitCode, ExitCode.SESSION_BUSY)
})

test("an error body of JSON null is tolerated, because the envelope must still be written when the backend body is not an object", () => {
  const { envelope } = buildErrorEnvelope(
    new ApiError("Payment required", 402, "null", "USAGE_LIMIT_EXCEEDED")
  )
  assert.equal(envelope.exitCode, 12)
  assert.equal(envelope.reason, undefined)
})
