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
  let stderr = ""
  child.stderr.on("data", (chunk) => (stderr += chunk))
  child.stdout.resume()
  return new Promise<{ code: number | null; stderr: string }>((resolve) =>
    child.on("close", (code) => resolve({ code, stderr }))
  )
}

// A workflow fetched at v17 is pushed after v18 was saved elsewhere. Like the
// real backend, the stub checks staleness only on base_version_id. The command
// must refuse with exit 12 and name v18, and the --force retry must omit
// base_version_id so the backend accepts the overwrite.
test("workflows update exits 12 with the latest version on a stale body, and --force overwrites it", async () => {
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
    assert.equal(stale.code, 12)
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
