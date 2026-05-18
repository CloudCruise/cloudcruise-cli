import { Command } from "commander"
import { resolveAuth } from "../core/auth.js"
import { ApiClient } from "../core/api-client.js"
import { addAuthOptions, type AuthOptions } from "../core/auth-options.js"
import { fetchWorkspaceChoices } from "../core/workspaces.js"
import { outputError, outputJson } from "../core/output.js"
import {
  clearWorkspaceProfile,
  showWorkspaceProfile,
  useWorkspaceProfile,
} from "./workspace-profile.js"

export function registerWorkspaceCommands(program: Command): void {
  const workspaces = program
    .command("workspaces")
    .description("Manage CloudCruise workspaces")

  addAuthOptions(
    workspaces
      .command("list")
      .description("List workspaces available to the authenticated user")
      .option("--organization-id <id>", "List workspaces for an organization using the existing /workspaces endpoint")
      .option("--load-members", "Include workspace members when using --organization-id")
  ).action(
    async (
      opts: {
        organizationId?: string
        loadMembers?: boolean
      } & AuthOptions
    ) => {
      try {
        const auth = await resolveAuth(opts)
        const client = new ApiClient(auth)
        const workspaceChoices = await fetchWorkspaceChoices(client, {
          organizationId: opts.organizationId,
          loadMembers: opts.loadMembers,
        })

        outputJson(
          workspaceChoices.map((workspace) => ({
            workspace_id: workspace.workspace_id,
            workspace_name: workspace.workspace_name ?? null,
            organization_id: workspace.organization_id ?? null,
            organization_name: workspace.organization_name ?? null,
            role: workspace.role ?? null,
          }))
        )
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    }
  )

  workspaces
    .command("show")
    .description("Show the active workspace for an auth profile")
    .option("--profile <name>", "Profile to inspect")
    .action((opts: { profile?: string }, cmd?: Command) => {
      try {
        showWorkspaceProfile(opts, cmd)
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    })

  workspaces
    .command("use <id>")
    .description("Set the active workspace for an auth profile")
    .option("--profile <name>", "Profile to update")
    .action((id: string, opts: { profile?: string }, cmd?: Command) => {
      try {
        useWorkspaceProfile(id, opts, cmd)
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    })

  workspaces
    .command("clear")
    .description("Clear the active workspace for an auth profile")
    .option("--profile <name>", "Profile to update")
    .action((opts: { profile?: string }, cmd?: Command) => {
      try {
        clearWorkspaceProfile(opts, cmd)
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    })
}
