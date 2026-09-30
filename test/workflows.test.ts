import { test } from "node:test"
import assert from "node:assert/strict"
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

test("buildWorkflowUpdateBody with force sends no base_version_id, so the update overwrites a newer version", () => {
  const body = buildWorkflowUpdateBody(
    { ...fetchedWorkflow, base_version_id: fetchedWorkflow.version_id },
    { force: true }
  )
  assert.equal("base_version_id" in body, false)
})

test("buildWorkflowUpdateBody keeps a base_version_id the caller set explicitly instead of deriving it from version_id", () => {
  const explicitBase = "7b0f1e2a-0000-4000-8000-000000000018"
  const body = buildWorkflowUpdateBody(
    { ...fetchedWorkflow, base_version_id: explicitBase },
    {}
  )
  assert.equal(body.base_version_id, explicitBase)
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
test("buildWorkflowUpdateBody sends every field of the fetched workflow unchanged", () => {
  const body = buildWorkflowUpdateBody(fetchedWorkflow, {})
  const { base_version_id: _base, ...rest } = body
  assert.deepEqual(rest, fetchedWorkflow)
})

test("buildWorkflowUpdateBody without a version_id sends no base_version_id, so the update is not checked for staleness", () => {
  const { version_id: _versionId, ...handWritten } = fetchedWorkflow
  const body = buildWorkflowUpdateBody(handWritten, {})
  assert.equal("base_version_id" in body, false)
})
