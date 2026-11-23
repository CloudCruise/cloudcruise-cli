import { test } from "node:test"
import assert from "node:assert/strict"
import { ApiError } from "@cloudcruise/strata"
import { apiFailure, RECONNECT } from "../dist/tools/common.js"

function failure(status: number, body: unknown, code?: string): string {
  const text = typeof body === "string" ? body : JSON.stringify(body)
  const result = apiFailure(new ApiError(`GET /x failed (${status}): ${text}`, status, text, code))
  assert.equal(result.isError, true)
  return (result.content[0] as { text: string }).text
}

// A 401 for a bad or expired token is fixed by signing in again, so the agent is told to reconnect, and nothing else.
test("a 401 for a rejected token asks to reconnect", () => {
  assert.equal(failure(401, { message: "Invalid or expired token" }, "UNAUTHENTICATED"), RECONNECT)
})

// A 403 (MFA, workspace role) is not fixed by signing in again, so the agent gets the API's own words, not a reconnect hint.
test("a 403 passes the status, code and message through without a reconnect hint", () => {
  const text = failure(403, { message: "Insufficient workspace role for this action" }, "FORBIDDEN")
  assert.equal(text, "The CloudCruise API returned 403 (FORBIDDEN): Insufficient workspace role for this action")
})

// PE-2387: an unknown or unreachable workspace is a 404 whose message names the id; the agent must see it to fix the id.
test("a 404 with a message passes the status, code and message through", () => {
  const text = failure(404, { message: "Workspace w1 not found or you don't have access" }, "NOT_FOUND")
  assert.equal(text, "The CloudCruise API returned 404 (NOT_FOUND): Workspace w1 not found or you don't have access")
})

// A 5xx often has no JSON body; the agent still learns the status instead of a generic failure.
test("a 5xx without a JSON body still reports the status", () => {
  assert.equal(failure(502, "Bad Gateway"), "The CloudCruise API returned 502.")
})
