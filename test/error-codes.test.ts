import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildErrorCodeBody,
  buildListErrorCodesPath,
  findErrorCode,
  parseNonNegativeInt,
  readErrorCodeBody
} from "../dist/src/commands/error-codes.js"

const WORKFLOW_ID = "d413c71b-841e-40e6-8765-29df2968af26"

function writeJson(value: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "error-codes-")), "body.json")
  writeFileSync(path, JSON.stringify(value))
  return path
}

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
    action: "alert"
  })
  assert.deepEqual(body, {
    error_code: "CLAIM_NOT_FOUND",
    description: "Claim not found",
    enriched_description: "The claim search returned no rows",
    error_action: "alert"
  })
})

test("buildErrorCodeBody sends only the flags that were passed", () => {
  assert.deepEqual(buildErrorCodeBody({ action: "cancel" }), {
    error_action: "cancel"
  })
})

test("readErrorCodeBody sends a --file object as-is", async () => {
  const fromFile = {
    error_code: "PORTAL_DOWN",
    description: "Portal unavailable",
    future_field: true
  }
  assert.deepEqual(
    await readErrorCodeBody({ file: writeJson(fromFile) }),
    fromFile
  )
})

test("readErrorCodeBody rejects flags combined with --file", async () => {
  await assert.rejects(
    readErrorCodeBody({
      description: "From the flag",
      file: writeJson({ error_code: "PORTAL_DOWN" })
    }),
    { name: "UsageError", message: /not both/ }
  )
})

test("findErrorCode matches ids case-insensitively", () => {
  const codes = [{ id: "3f2b9c1e-aaaa-bbbb-cccc-000000000001" }]
  assert.equal(findErrorCode(codes, "3F2B9C1E-AAAA-BBBB-CCCC-000000000001"), codes[0])
  assert.equal(findErrorCode(codes, "3f2b9c1e-aaaa-bbbb-cccc-000000000002"), undefined)
})

test("buildErrorCodeBody maps the retry settings to retries and retry_after", () => {
  assert.deepEqual(
    buildErrorCodeBody({ action: "retry", retries: 3, retryAfter: 60 }),
    { error_action: "retry", retries: 3, retry_after: 60 }
  )
})

test("buildErrorCodeBody keeps a zero retry setting", () => {
  assert.deepEqual(buildErrorCodeBody({ retries: 0 }), { retries: 0 })
})

test("parseNonNegativeInt accepts whole numbers and rejects anything else", () => {
  assert.equal(parseNonNegativeInt("0"), 0)
  assert.equal(parseNonNegativeInt("60"), 60)
  for (const bad of ["-1", "1.5", "abc", ""]) {
    assert.throws(() => parseNonNegativeInt(bad), /non-negative integer/)
  }
})

test("readErrorCodeBody rejects retry flags combined with --file", async () => {
  await assert.rejects(
    readErrorCodeBody({ retries: 2, file: writeJson({ error_action: "retry" }) }),
    /not both/
  )
})
