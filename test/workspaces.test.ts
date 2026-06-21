import { test } from "node:test"
import assert from "node:assert/strict"
import {
  decideWorkspaceSelection,
  needsWorkspaceDiscovery,
  resolveLoginWorkspaceId,
  summarizeWorkspace,
  type WorkspaceChoice,
} from "../dist/src/core/workspaces.js"

function workspace(
  workspace_id: string,
  workspace_name?: string
): WorkspaceChoice {
  return {
    workspace_id,
    workspace_name,
    organization_id: "org-1",
    organization_name: "Org One",
    role: "admin",
    raw: { workspace_id, workspace_name },
  }
}

test("workspace selection auto-selects a single workspace in non-interactive login", () => {
  const only = workspace("ws-1", "Workspace One")
  const decision = decideWorkspaceSelection([only], false)

  assert.deepEqual(decision, { kind: "selected", workspace: only })
})

test("workspace selection requires machine-readable follow-up for multiple non-interactive workspaces", () => {
  const workspaces = [
    workspace("ws-1", "Workspace One"),
    workspace("ws-2", "Workspace Two"),
  ]
  const decision = decideWorkspaceSelection(workspaces, false)

  assert.deepEqual(decision, { kind: "required", workspaces })
  assert.deepEqual(summarizeWorkspace(workspaces[0]), {
    workspace_id: "ws-1",
    workspace_name: "Workspace One",
    organization_id: "org-1",
    organization_name: "Org One",
    role: "admin",
  })
})

test("workspace selection keeps the prompt path for multiple interactive workspaces", () => {
  const workspaces = [
    workspace("ws-1", "Workspace One"),
    workspace("ws-2", "Workspace Two"),
  ]
  const decision = decideWorkspaceSelection(workspaces, true)

  assert.deepEqual(decision, { kind: "prompt", workspaces })
})

test("workspace discovery is skipped when login receives an explicit workspace", () => {
  assert.equal(needsWorkspaceDiscovery("ws-explicit"), false)
  assert.equal(needsWorkspaceDiscovery(undefined), true)
})

test("login workspace resolution prefers an explicit workspace regardless of identity change", () => {
  assert.equal(
    resolveLoginWorkspaceId({
      explicitWorkspaceId: "ws-explicit",
      existingWorkspaceId: "ws-old",
      identityChanged: true,
    }),
    "ws-explicit"
  )
  assert.equal(
    resolveLoginWorkspaceId({
      explicitWorkspaceId: "ws-explicit",
      existingWorkspaceId: "ws-old",
      identityChanged: false,
    }),
    "ws-explicit"
  )
})

test("login workspace resolution keeps the existing workspace for the same identity", () => {
  assert.equal(
    resolveLoginWorkspaceId({
      existingWorkspaceId: "ws-old",
      identityChanged: false,
    }),
    "ws-old"
  )
})

test("login workspace resolution drops the inherited workspace when identity changed", () => {
  assert.equal(
    resolveLoginWorkspaceId({
      existingWorkspaceId: "ws-old",
      identityChanged: true,
    }),
    undefined
  )
})

test("login workspace resolution returns undefined when there is no existing workspace", () => {
  assert.equal(
    resolveLoginWorkspaceId({ identityChanged: false }),
    undefined
  )
})
