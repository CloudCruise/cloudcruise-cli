import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildWorkflowUpdateBody } from "../dist/src/commands/workflows.js"

const fetchedWorkflow = {
  id: "d413c71b-841e-40e6-8765-29df2968af26",
  version_id: "7b0f1e2a-0000-4000-8000-000000000017",
  version_number: 17,
  created_at: "2026-09-29T10:00:00Z",
  created_by: "user_1",
  workspace_id: "ws_123",
  encrypted_keys: ["password"],
  loginStructure: null,
  name: "Claims lookup",
  nodes: [],
  edges: []
}

test("buildWorkflowUpdateBody bases the update on the fetched version_id so a newer save is detected", () => {
  const body = buildWorkflowUpdateBody(fetchedWorkflow, {})
  assert.equal(body.base_version_id, fetchedWorkflow.version_id)
})

// The backend runs the stale check only on base_version_id and ignores the
// echoed version fields, so dropping base_version_id is enough to overwrite.
test("buildWorkflowUpdateBody with force sends no base_version_id and leaves the rest of the body unchanged", () => {
  const body = buildWorkflowUpdateBody(
    { ...fetchedWorkflow, base_version_id: fetchedWorkflow.version_id },
    { force: true }
  )
  assert.deepEqual(body, fetchedWorkflow)
})

test("buildWorkflowUpdateBody keeps a base_version_id the caller set explicitly instead of deriving it from version_id", () => {
  const explicitBase = "7b0f1e2a-0000-4000-8000-000000000018"
  const body = buildWorkflowUpdateBody(
    { ...fetchedWorkflow, base_version_id: explicitBase },
    {}
  )
  assert.equal(body.base_version_id, explicitBase)
})

test("buildWorkflowUpdateBody derives base_version_id from version_id when the body carries base_version_id: null", () => {
  const body = buildWorkflowUpdateBody(
    { ...fetchedWorkflow, base_version_id: null },
    {}
  )
  assert.equal(body.base_version_id, fetchedWorkflow.version_id)
})

// A fetched body's version_note describes the version it was fetched at.
// Sending it back would label the new version with the old version's note.
test("buildWorkflowUpdateBody without --version-note drops the version_note from the file", () => {
  const body = buildWorkflowUpdateBody(
    { ...fetchedWorkflow, version_note: "note of v17" },
    {}
  )
  assert.equal("version_note" in body, false)
})

test("buildWorkflowUpdateBody lets --version-note replace the version_note from the file", () => {
  const body = buildWorkflowUpdateBody(
    { ...fetchedWorkflow, version_note: "note of v17" },
    { versionNote: "Fixed login XPath" }
  )
  assert.equal(body.version_note, "Fixed login XPath")
})

// The backend accepts echoed read-only fields and keeps the previous
// encrypted_keys when they are absent, so dropping any field would silently
// discard an edit. Everything the caller sent must reach the backend.
test("buildWorkflowUpdateBody without force sends every field of the fetched workflow unchanged", () => {
  const body = buildWorkflowUpdateBody(fetchedWorkflow, {})
  const { base_version_id: _base, ...rest } = body
  assert.deepEqual(rest, fetchedWorkflow)
})

test("buildWorkflowUpdateBody without a version_id sends no base_version_id, so the update is not checked for staleness", () => {
  const { version_id: _versionId, ...handWritten } = fetchedWorkflow
  const body = buildWorkflowUpdateBody(handWritten, {})
  assert.equal("base_version_id" in body, false)
})

const latestVersionId = "7b0f1e2a-0000-4000-8000-000000000018"

async function startWorkflowBackend() {
  const received: Record<string, unknown>[] = []
  const server = createServer((req, res) => {
    let raw = ""
    req.on("data", (chunk) => (raw += chunk))
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as Record<string, unknown>
      received.push(body)
      if (
        body.base_version_id !== undefined &&
        body.base_version_id !== latestVersionId
      ) {
        res.writeHead(409, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            code: "WORKFLOW_VERSION_CONFLICT",
            message: "This workflow was updated by another session.",
            latestVersionId,
            latestVersionNumber: 18,
            latestCreatedBy: "user_2",
            latestCreatedAt: "2026-09-30T08:15:00Z",
            latestVersionNote: "Healed submit XPath",
            statusCode: 409
          })
        )
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: fetchedWorkflow.id, version_number: 19 }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${port}`, received, server }
}

function runCli(args: string[]) {
  const home = mkdtempSync(join(tmpdir(), "cloudcruise-test-"))
  const child = spawn(process.execPath, ["dist/bin/cloudcruise.js", ...args], {
    env: { ...process.env, HOME: home, CLOUDCRUISE_API_KEY: "test_key" }
  })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => (stdout += chunk))
  child.stderr.on("data", (chunk) => (stderr += chunk))
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve) => child.on("close", (code) => resolve({ code, stdout, stderr }))
  )
}

// A workflow fetched at v17 is pushed after v18 was saved elsewhere. Like the
// real backend, the stub checks staleness only on base_version_id. The command
// must refuse with exit 13 and name v18, and the --force retry must omit
// base_version_id so the backend accepts the overwrite.
test("workflows update exits 13 with the latest version on a stale body, and --force overwrites it", async () => {
  const backend = await startWorkflowBackend()
  try {
    const dir = mkdtempSync(join(tmpdir(), "cloudcruise-workflow-"))
    const file = join(dir, "workflow.json")
    writeFileSync(file, JSON.stringify(fetchedWorkflow))
    const baseArgs = [
      "workflows",
      "update",
      fetchedWorkflow.id,
      "--file",
      file,
      "--base-url",
      backend.baseUrl
    ]

    const stale = await runCli(baseArgs)
    assert.equal(stale.code, 13)
    const envelope = JSON.parse(stale.stderr.trim().split("\n").at(-1)!)
    assert.equal(envelope.code, "WORKFLOW_VERSION_CONFLICT")
    assert.equal(envelope.latestVersion.number, 18)
    assert.equal(backend.received[0].base_version_id, fetchedWorkflow.version_id)

    const forced = await runCli([...baseArgs, "--force"])
    assert.equal(forced.code, 0)
    assert.equal("base_version_id" in backend.received[1], false)
  } finally {
    backend.server.close()
  }
})

const deletableIds = [
  "1f9c7a52-0000-4000-8000-000000000001",
  "1f9c7a52-0000-4000-8000-000000000002"
]

const referenceBlockedId = "1f9c7a52-0000-4000-8000-0000000000aa"

const emptyResponseDeletableId = "1f9c7a52-0000-4000-8000-0000000000bb"

async function startDeleteBackend() {
  const requests: { method?: string; url?: string; ccKey?: string }[] = []
  const server = createServer((req, res) => {
    requests.push({
      method: req.method,
      url: req.url,
      ccKey: req.headers["cc-key"] as string | undefined
    })
    const id = req.url?.replace(/^\/workflows\//, "") ?? ""
    res.setHeader("content-type", "application/json")
    if (req.method === "DELETE" && id === emptyResponseDeletableId) {
      res.writeHead(204)
      res.end()
      return
    }
    if (req.method === "DELETE" && deletableIds.includes(id)) {
      res.writeHead(200)
      res.end(JSON.stringify({ success: true }))
      return
    }
    if (!/^[0-9a-f-]{36}$/.test(id)) {
      res.writeHead(400)
      res.end(
        JSON.stringify({
          message: `invalid input syntax for type uuid: "${id}"`,
          error: "Bad Request",
          code: "BAD_REQUEST",
          statusCode: 400
        })
      )
      return
    }
    if (id === referenceBlockedId) {
      res.writeHead(400)
      res.end(
        JSON.stringify({
          message:
            'update or delete on table "workflows" violates foreign key constraint "tfa_setup_recovery_log_workflow_id_fkey" on table "tfa_setup_recovery_log"',
          error: "Bad Request",
          code: "BAD_REQUEST",
          statusCode: 400
        })
      )
      return
    }
    res.writeHead(404)
    res.end(
      JSON.stringify({
        message: `Workflow ${id} not found`,
        code: "NOT_FOUND",
        statusCode: 404
      })
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${port}`, requests, server }
}

test("workflows delete with several ids sends one DELETE per id and prints one deleted result per id, in order", async () => {
  const backend = await startDeleteBackend()
  try {
    const result = await runCli([
      "workflows",
      "delete",
      ...deletableIds,
      "--base-url",
      backend.baseUrl
    ])
    assert.equal(result.code, 0)
    assert.deepEqual(JSON.parse(result.stdout), [
      { id: deletableIds[0], status: "deleted" },
      { id: deletableIds[1], status: "deleted" }
    ])
    assert.deepEqual(
      backend.requests.map((r) => [r.method, r.url, r.ccKey]),
      deletableIds.map((id) => ["DELETE", `/workflows/${id}`, "test_key"])
    )
  } finally {
    backend.server.close()
  }
})

const unknownId = "1f9c7a52-0000-4000-8000-0000000000ff"

// An unknown id must not stop the remaining deletes. Exit 4 is what the CLI's
// exit-code taxonomy assigns to a 404 when every failure is "not found".
test("workflows delete reports an unknown id as not_found, still deletes the other ids, and exits 4", async () => {
  const backend = await startDeleteBackend()
  try {
    const result = await runCli([
      "workflows",
      "delete",
      unknownId,
      deletableIds[0],
      "--base-url",
      backend.baseUrl
    ])
    assert.equal(result.code, 4)
    const [missing, deleted] = JSON.parse(result.stdout)
    assert.equal(missing.id, unknownId)
    assert.equal(missing.status, "not_found")
    assert.deepEqual(deleted, { id: deletableIds[0], status: "deleted" })
  } finally {
    backend.server.close()
  }
})

// The backend passes the Postgres FK violation through as a 400. The user needs
// to learn which kind of record blocks the delete, not the constraint name, and
// that only support can remove it: no API deletes these records.
// Exit 2 is the taxonomy's code for a 400 BAD_REQUEST.
test("workflows delete of a workflow still referenced by TFA setup recovery log entries reports an error naming them instead of the raw Postgres message, and exits 2", async () => {
  const backend = await startDeleteBackend()
  try {
    const result = await runCli([
      "workflows",
      "delete",
      referenceBlockedId,
      "--base-url",
      backend.baseUrl
    ])
    assert.equal(result.code, 2)
    const [blocked] = JSON.parse(result.stdout)
    assert.equal(blocked.status, "error")
    assert.match(blocked.message, /TFA setup recovery log entries/)
    assert.match(blocked.message, /contact CloudCruise support/i)
    assert.doesNotMatch(blocked.message, /foreign key|fkey/)
  } finally {
    backend.server.close()
  }
})

// Workflow ids are UUIDs, so a malformed id names no workflow. The backend
// rejects it with a Postgres 400, but for the user it is just an unknown id.
test("workflows delete reports an id that is not a UUID as not_found and exits 4", async () => {
  const backend = await startDeleteBackend()
  try {
    const result = await runCli([
      "workflows",
      "delete",
      "not-a-uuid",
      "--base-url",
      backend.baseUrl
    ])
    assert.equal(result.code, 4)
    const [missing] = JSON.parse(result.stdout)
    assert.equal(missing.status, "not_found")
    assert.doesNotMatch(missing.message, /invalid input syntax/)
  } finally {
    backend.server.close()
  }
})

// not_found maps to exit 4 and a 400 to exit 2. No single specific code
// describes both, so the command falls back to the generic failure code 1.
test("workflows delete exits 1 when ids fail for different reasons", async () => {
  const backend = await startDeleteBackend()
  try {
    const result = await runCli([
      "workflows",
      "delete",
      unknownId,
      referenceBlockedId,
      "--base-url",
      backend.baseUrl
    ])
    assert.equal(result.code, 1)
    assert.deepEqual(
      JSON.parse(result.stdout).map((r: { status: string }) => r.status),
      ["not_found", "error"]
    )
  } finally {
    backend.server.close()
  }
})

// A successful DELETE may answer 204 with no body. That is still a successful
// delete, so it must not be reported as an error.
test("workflows delete reports a delete answered with an empty 204 as deleted and exits 0", async () => {
  const backend = await startDeleteBackend()
  try {
    const result = await runCli([
      "workflows",
      "delete",
      emptyResponseDeletableId,
      "--base-url",
      backend.baseUrl
    ])
    assert.equal(result.code, 0)
    assert.deepEqual(JSON.parse(result.stdout), [
      { id: emptyResponseDeletableId, status: "deleted" }
    ])
  } finally {
    backend.server.close()
  }
})

// Unencoded, "<id>#x" would send DELETE /workflows/<id> because the fragment
// never reaches the server, deleting a workflow the user did not name. The id
// is sent encoded, so the backend sees a malformed id and nothing is deleted.
test("workflows delete sends an id containing URL syntax encoded, so it cannot delete the workflow whose id it starts with", async () => {
  const backend = await startDeleteBackend()
  try {
    const result = await runCli([
      "workflows",
      "delete",
      `${deletableIds[0]}#x`,
      "--base-url",
      backend.baseUrl
    ])
    assert.equal(result.code, 4)
    assert.deepEqual(
      backend.requests.map((r) => r.url),
      [`/workflows/${deletableIds[0]}%23x`]
    )
    assert.equal(JSON.parse(result.stdout)[0].status, "not_found")
  } finally {
    backend.server.close()
  }
})
