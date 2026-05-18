import { createInterface } from "readline/promises"
import { stdin as input, stderr as output } from "process"
import { ApiClient } from "./api-client.js"

export interface WorkspaceChoice {
  workspace_id: string
  workspace_name?: string
  organization_id?: string
  organization_name?: string
  role?: string
  raw: Record<string, unknown>
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export function normalizeWorkspaceRows(rows: unknown): WorkspaceChoice[] {
  if (!Array.isArray(rows)) return []

  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return []
    const record = row as Record<string, unknown>
    const workspaceId = stringValue(record.workspace_id) ?? stringValue(record.id)
    if (!workspaceId) return []

    const organization = record.organization as Record<string, unknown> | undefined
    const workspace = record.workspace as Record<string, unknown> | undefined

    return [
      {
        workspace_id: workspaceId,
        workspace_name:
          stringValue(record.workspace_name) ??
          stringValue(record.name) ??
          stringValue(workspace?.name),
        organization_id:
          stringValue(record.organization_id) ??
          stringValue(organization?.id),
        organization_name:
          stringValue(record.organization_name) ??
          stringValue(organization?.name),
        role: stringValue(record.role),
        raw: record,
      },
    ]
  })
}

export async function fetchWorkspaceChoices(
  client: ApiClient,
  opts: { organizationId?: string; loadMembers?: boolean } = {}
): Promise<WorkspaceChoice[]> {
  const path = opts.organizationId
    ? `/workspaces?organization_id=${encodeURIComponent(opts.organizationId)}${
        opts.loadMembers ? "&load_members=true" : ""
      }`
    : "/me/workspaces"

  const rows = await client.get<unknown>(path)
  return normalizeWorkspaceRows(rows)
}

export function formatWorkspaceLabel(workspace: WorkspaceChoice): string {
  const parts = [
    workspace.workspace_name ?? workspace.workspace_id,
    workspace.organization_name,
    workspace.role,
  ].filter(Boolean)
  return parts.join(" - ")
}

export async function promptForWorkspace(
  workspaces: WorkspaceChoice[]
): Promise<WorkspaceChoice | null> {
  if (!input.isTTY || !output.isTTY || workspaces.length === 0) return null
  if (workspaces.length === 1) return workspaces[0]

  output.write("\nSelect a CloudCruise workspace:\n")
  workspaces.forEach((workspace, index) => {
    output.write(`  ${index + 1}. ${formatWorkspaceLabel(workspace)}\n`)
  })

  const rl = createInterface({ input, output })
  try {
    while (true) {
      const answer = await rl.question("Workspace number: ")
      const index = Number.parseInt(answer.trim(), 10)
      if (Number.isInteger(index) && index >= 1 && index <= workspaces.length) {
        return workspaces[index - 1]
      }
      output.write(`Enter a number from 1 to ${workspaces.length}.\n`)
    }
  } finally {
    rl.close()
  }
}
