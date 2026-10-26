import { Command } from "commander"
import { resolveAuth } from "../core/auth.js"
import { ApiClient } from "../core/api-client.js"
import { outputJson } from "../core/output.js"
import { fail, UsageError } from "../core/exit.js"
import { addAuthOptions, type AuthOptions } from "../core/auth-options.js"
import {
  branchesPath,
  findBranch,
  listBranches,
  resolveBranch,
  resolveVersionId,
  withBranchHint,
  type WorkflowBranch
} from "../core/workflow-branches.js"

type WorkflowOption = { workflow: string }

/** Request body for POST /workflows/:id/branches. */
export function buildCreateBranchBody(
  name: string,
  from: { branchId?: string; versionId?: string }
): Record<string, unknown> {
  const body: Record<string, unknown> = { name }
  if (from.versionId) body.fromVersionId = from.versionId
  else if (from.branchId) body.fromBranchId = from.branchId
  return body
}

export function buildDeleteBranchPath(
  workflowId: string,
  branchId: string,
  closeOpenPullRequests: boolean
): string {
  const path = `${branchesPath(workflowId)}/${encodeURIComponent(branchId)}`
  return closeOpenPullRequests ? `${path}?closeOpenPullRequests=true` : path
}

function workflowOption(cmd: Command): Command {
  return cmd.requiredOption("--workflow <id>", "Workflow ID")
}

export function registerBranchCommands(program: Command): void {
  const branches = program
    .command("branches")
    .description("Manage a workflow's branches")

  // ── list ───────────────────────────────────────────────────────
  addAuthOptions(
    workflowOption(
      branches.command("list").description("List a workflow's branches, oldest first")
    )
  )
    .addHelpText(
      "after",
      `
"is_default" marks the branch runs, \`workflows get\` and the builder use when
no --branch or --version is given. "effectiveProtection" says whether direct
saves are blocked and how many approvals a pull request into it needs.

Example:
  $ cloudcruise branches list --workflow <workflow_id>`
    )
    .action(async (opts: WorkflowOption & AuthOptions) => {
      try {
        const client = new ApiClient(await resolveAuth(opts))
        outputJson(await listBranches(client, opts.workflow))
      } catch (err: unknown) {
        fail(err)
      }
    })

  // ── create ─────────────────────────────────────────────────────
  addAuthOptions(
    workflowOption(
      branches
        .command("create <name>")
        .description("Create a branch from the default branch, another branch or a version")
        .option("--from <branch>", "Branch (name or id) to start from; default: the default branch")
        .option("--from-version <version>", "Exact version (e.g. 2.1.0) to start from")
    )
  )
    .addHelpText(
      "after",
      `
Names follow git's branch-name rules. --from and --from-version are mutually
exclusive.

Examples:
  $ cloudcruise branches create fix-login --workflow <workflow_id>
  $ cloudcruise branches create hotfix --workflow <workflow_id> --from-version 2.1.0`
    )
    .action(
      async (
        name: string,
        opts: WorkflowOption & { from?: string; fromVersion?: string } & AuthOptions
      ) => {
        try {
          if (opts.from !== undefined && opts.fromVersion !== undefined) {
            throw new UsageError("Pass only one of --from, --from-version")
          }
          const client = new ApiClient(await resolveAuth(opts))
          const body = buildCreateBranchBody(name, {
            branchId: opts.from
              ? (await resolveBranch(client, opts.workflow, opts.from)).id
              : undefined,
            versionId: opts.fromVersion
              ? await resolveVersionId(client, opts.workflow, opts.fromVersion)
              : undefined
          })
          outputJson(await client.post(branchesPath(opts.workflow), body))
        } catch (err: unknown) {
          fail(withBranchHint(err))
        }
      }
    )

  // ── delete ─────────────────────────────────────────────────────
  addAuthOptions(
    workflowOption(
      branches
        .command("delete <branch>")
        .description("Delete a branch (name or id); its versions stay in the history")
        .option("--close-open-prs", "Also close the open pull requests from or into it")
    )
  )
    .addHelpText(
      "after",
      `
The default branch can't be deleted; make another branch the default first.
Without --close-open-prs, a branch with open pull requests is not deleted.

Example:
  $ cloudcruise branches delete fix-login --workflow <workflow_id>`
    )
    .action(
      async (
        ref: string,
        opts: WorkflowOption & { closeOpenPrs?: boolean } & AuthOptions
      ) => {
        try {
          const client = new ApiClient(await resolveAuth(opts))
          const branch = await resolveBranch(client, opts.workflow, ref)
          await client.delete(
            buildDeleteBranchPath(opts.workflow, branch.id, !!opts.closeOpenPrs)
          )
          outputJson({ deleted: true, id: branch.id, name: branch.name })
        } catch (err: unknown) {
          fail(withBranchHint(err))
        }
      }
    )

  // ── set-default ────────────────────────────────────────────────
  addAuthOptions(
    workflowOption(
      branches
        .command("set-default <branch>")
        .description("Make a branch (name or id) the one unpinned runs use")
    )
  )
    .addHelpText(
      "after",
      `
Runs, \`workflows get\` and the builder use the default branch's latest
version when no --branch or --version is given.

Example:
  $ cloudcruise branches set-default main --workflow <workflow_id>`
    )
    .action(async (ref: string, opts: WorkflowOption & AuthOptions) => {
      try {
        const client = new ApiClient(await resolveAuth(opts))
        const all = await listBranches(client, opts.workflow)
        const branch: WorkflowBranch = findBranch(all, ref)
        await client.post(
          `${branchesPath(opts.workflow)}/${encodeURIComponent(branch.id)}/set-default`
        )
        outputJson({ default_branch_id: branch.id, name: branch.name })
      } catch (err: unknown) {
        fail(withBranchHint(err))
      }
    })
}
