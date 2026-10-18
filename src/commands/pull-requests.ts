import { readFileSync, writeFileSync } from "node:fs"
import { Command, InvalidArgumentError } from "commander"
import { resolveAuth } from "../core/auth.js"
import { ApiClient } from "../core/api-client.js"
import { outputJson } from "../core/output.js"
import { fail, StalePreviewError, UsageError } from "../core/exit.js"
import { addAuthOptions, type AuthOptions } from "../core/auth-options.js"
import {
  buildDiffOutput,
  buildResolutions,
  buildResolutionsTemplate,
  filterPullRequests,
  findBranch,
  formatMatchHeads,
  getPullRequest,
  listBranches,
  parseMatchHeads,
  parseResolveFlag,
  PR_STATES,
  pullRequestsPath,
  toMergeConflictsError,
  withBranchHint,
  type MergePreview,
  type PullRequest,
  type PullRequestState,
  type ResolveChoice
} from "../core/workflow-branches.js"

type WorkflowOption = { workflow: string }

export type MergeOptions = {
  resolve?: { key: string; choice: ResolveChoice }[]
  take?: "source" | "target"
  resolutionsFile?: string
  matchHeads?: string
  admin?: boolean
}

export function hasResolutionInput(opts: MergeOptions): boolean {
  return (
    (opts.resolve?.length ?? 0) > 0 ||
    opts.take !== undefined ||
    opts.resolutionsFile !== undefined
  )
}

export function readResolutionsFile(path: string): Record<string, unknown> {
  let raw: string
  try {
    raw = readFileSync(path, "utf-8")
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new UsageError(`Cannot read --resolutions-file ${path}: ${reason}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new UsageError(`--resolutions-file ${path} is not valid JSON`)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UsageError(
      `--resolutions-file ${path} must be a JSON object of "<conflict key>": <value>`
    )
  }
  return parsed as Record<string, unknown>
}

/** Flag checks that need no request, so bad flags fail before any API call. */
export function validateMergeOptions(opts: MergeOptions): void {
  if (hasResolutionInput(opts) && !opts.matchHeads) {
    throw new UsageError(
      "Resolving conflicts needs --match-heads <source_head>:<target_head> from `prs diff`, so a branch that moved since is not overwritten"
    )
  }
  if (opts.matchHeads) parseMatchHeads(opts.matchHeads)
}

/**
 * The merge request body. Resolutions are checked against a preview fetched
 * now, and only when its heads are the ones the caller decided against
 * (--match-heads, printed by `prs diff`): a resolution is a literal value, so
 * applying it after a branch moved would silently drop what changed.
 */
export function buildMergeBody(
  preview: MergePreview | undefined,
  opts: MergeOptions,
  custom?: Record<string, unknown>
): Record<string, unknown> {
  validateMergeOptions(opts)
  const body: Record<string, unknown> = {}
  if (opts.admin) body.force = true
  if (!hasResolutionInput(opts)) return body
  const expected = parseMatchHeads(opts.matchHeads as string)
  if (!preview) throw new Error("A merge preview is required to resolve conflicts")
  if (
    expected.sourceHeadVersionId !== preview.sourceHeadVersionId ||
    expected.targetHeadVersionId !== preview.targetHeadVersionId
  ) {
    throw new StalePreviewError(
      `A branch moved since that diff (now ${formatMatchHeads(preview)})`,
      "Run `prs diff` again and decide on the current conflicts."
    )
  }
  body.resolutions = buildResolutions(preview.conflicts, {
    resolve: opts.resolve,
    take: opts.take,
    custom
  })
  body.previewSourceHeadVersionId = preview.sourceHeadVersionId
  body.previewTargetHeadVersionId = preview.targetHeadVersionId
  return body
}

function workflowOption(cmd: Command): Command {
  return cmd.requiredOption("--workflow <id>", "Workflow ID")
}

function prPath(workflowId: string, pr: PullRequest, action?: string): string {
  const base = `${pullRequestsPath(workflowId)}/${encodeURIComponent(pr.id)}`
  return action ? `${base}/${action}` : base
}

const parseState = (value: string): PullRequestState => {
  if (!(PR_STATES as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(`Must be one of ${PR_STATES.join(", ")}.`)
  }
  return value as PullRequestState
}

const parseSide = (value: string): "source" | "target" => {
  if (value !== "source" && value !== "target") {
    throw new InvalidArgumentError("Must be source or target.")
  }
  return value
}

const collectResolve = (
  value: string,
  previous: { key: string; choice: ResolveChoice }[] = []
): { key: string; choice: ResolveChoice }[] => {
  try {
    return [...previous, parseResolveFlag(value)]
  } catch (err: unknown) {
    throw new InvalidArgumentError(err instanceof Error ? err.message : String(err))
  }
}

export function registerPullRequestCommands(program: Command): void {
  const prs = program
    .command("prs")
    .description("Review and merge pull requests between a workflow's branches")

  // ── list ───────────────────────────────────────────────────────
  addAuthOptions(
    workflowOption(
      prs
        .command("list")
        .description("List a workflow's pull requests, newest first")
        .option("--state <state>", "open, merged, closed or all", parseState, "open")
    )
  )
    .addHelpText(
      "after",
      `
Example:
  $ cloudcruise prs list --workflow <workflow_id> --state all`
    )
    .action(async (opts: WorkflowOption & { state: PullRequestState } & AuthOptions) => {
      try {
        const client = new ApiClient(await resolveAuth(opts))
        const all = await client.get<PullRequest[]>(pullRequestsPath(opts.workflow))
        outputJson(filterPullRequests(all, opts.state))
      } catch (err: unknown) {
        fail(err)
      }
    })

  // ── view ───────────────────────────────────────────────────────
  addAuthOptions(
    workflowOption(
      prs
        .command("view <pr>")
        .description("Show a pull request (number, #number or id) and its approvals")
    )
  )
    .addHelpText(
      "after",
      `
Example:
  $ cloudcruise prs view 12 --workflow <workflow_id>`
    )
    .action(async (ref: string, opts: WorkflowOption & AuthOptions) => {
      try {
        const client = new ApiClient(await resolveAuth(opts))
        const pr = await getPullRequest(client, opts.workflow, ref)
        const approvals = await client.get(prPath(opts.workflow, pr, "approvals"))
        outputJson({ ...pr, approvals })
      } catch (err: unknown) {
        fail(err)
      }
    })

  // ── create ─────────────────────────────────────────────────────
  addAuthOptions(
    workflowOption(
      prs
        .command("create")
        .description("Open a pull request to merge one branch into another")
        .requiredOption("--head <branch>", "Branch (name or id) with the changes")
        .option("--base <branch>", "Branch (name or id) to merge into; default: the default branch")
        .option("--title <text>", "Title")
    )
  )
    .addHelpText(
      "after",
      `
Pull requests can point either way. To resolve conflicts on your branch and
test the result before merging, open one from the base into your branch first
(e.g. --head main --base my-branch), merge it with \`prs merge\`, test, then
open and merge the one from your branch: it no longer conflicts.

Examples:
  $ cloudcruise prs create --workflow <workflow_id> --head fix-login --title "Fix login XPath"
  $ cloudcruise prs create --workflow <workflow_id> --head main --base fix-login`
    )
    .action(
      async (
        opts: WorkflowOption & { head: string; base?: string; title?: string } & AuthOptions
      ) => {
        try {
          const client = new ApiClient(await resolveAuth(opts))
          const branches = await listBranches(client, opts.workflow)
          const head = findBranch(branches, opts.head)
          const base = opts.base
            ? findBranch(branches, opts.base)
            : branches.find((b) => b.is_default)
          if (!base) throw new UsageError("The workflow has no default branch; pass --base")
          const body: Record<string, unknown> = {
            sourceBranchId: head.id,
            targetBranchId: base.id
          }
          if (opts.title !== undefined) body.title = opts.title
          outputJson(await client.post(pullRequestsPath(opts.workflow), body))
        } catch (err: unknown) {
          fail(withBranchHint(err))
        }
      }
    )

  // ── diff ───────────────────────────────────────────────────────
  addAuthOptions(
    workflowOption(
      prs
        .command("diff <pr>")
        .description("Preview the merge: conflicts with base/source/target values, and the heads to merge against")
        .option("--merged", "Include the full merged workflow")
        .option(
          "--resolutions-template <path>",
          "Write a --resolutions-file to edit, pre-filled with the source side"
        )
    )
  )
    .addHelpText(
      "after",
      `
"source" is the pull request's branch, "target" the branch it merges into,
"base" their common ancestor. Each conflict has a "key" for \`prs merge
--resolve\` and a one-line "summary". A conflict with "depends_on" follows
the side its driving conflict takes unless resolved itself. Pass the printed
"match_heads" to \`prs merge --match-heads\` when resolving.

Examples:
  $ cloudcruise prs diff 12 --workflow <workflow_id>
  $ cloudcruise prs diff 12 --workflow <workflow_id> --resolutions-template resolutions.json`
    )
    .action(
      async (
        ref: string,
        opts: WorkflowOption & { merged?: boolean; resolutionsTemplate?: string } & AuthOptions
      ) => {
        try {
          const client = new ApiClient(await resolveAuth(opts))
          const pr = await getPullRequest(client, opts.workflow, ref)
          const preview = await client.get<MergePreview>(prPath(opts.workflow, pr, "preview"))
          const output = buildDiffOutput(pr, preview, { includeMerged: opts.merged })
          if (opts.resolutionsTemplate) {
            writeFileSync(
              opts.resolutionsTemplate,
              `${JSON.stringify(buildResolutionsTemplate(preview), null, 2)}\n`
            )
            output.resolutions_template = opts.resolutionsTemplate
          }
          outputJson(output)
        } catch (err: unknown) {
          fail(err)
        }
      }
    )

  // ── approve ────────────────────────────────────────────────────
  addAuthOptions(
    workflowOption(prs.command("approve <pr>").description("Approve a pull request"))
  )
    .addHelpText(
      "after",
      `
You can't approve your own pull request. An API key approves as the user who
created it.

Example:
  $ cloudcruise prs approve 12 --workflow <workflow_id>`
    )
    .action(async (ref: string, opts: WorkflowOption & AuthOptions) => {
      try {
        const client = new ApiClient(await resolveAuth(opts))
        const pr = await getPullRequest(client, opts.workflow, ref)
        outputJson(await client.post(prPath(opts.workflow, pr, "approve")))
      } catch (err: unknown) {
        fail(withBranchHint(err, ref))
      }
    })

  // ── close ──────────────────────────────────────────────────────
  addAuthOptions(
    workflowOption(prs.command("close <pr>").description("Close a pull request without merging"))
  )
    .addHelpText(
      "after",
      `
Example:
  $ cloudcruise prs close 12 --workflow <workflow_id>`
    )
    .action(async (ref: string, opts: WorkflowOption & AuthOptions) => {
      try {
        const client = new ApiClient(await resolveAuth(opts))
        const pr = await getPullRequest(client, opts.workflow, ref)
        await client.post(prPath(opts.workflow, pr, "close"))
        outputJson({ closed: true, id: pr.id, number: pr.number })
      } catch (err: unknown) {
        fail(withBranchHint(err, ref))
      }
    })

  // ── merge ──────────────────────────────────────────────────────
  addAuthOptions(
    workflowOption(
      prs
        .command("merge <pr>")
        .description("Merge a pull request into its target branch")
        .option(
          "--resolve <key=choice>",
          "Resolve one conflict: <conflict key>=source|target|delete (repeatable)",
          collectResolve
        )
        .option("--take <side>", "Resolve every remaining conflict to source or target", parseSide)
        .option("--resolutions-file <path>", "JSON object of \"<conflict key>\": <value> for custom values")
        .option("--match-heads <heads>", "The match_heads printed by `prs diff`; required when resolving")
        .option("--admin", "Merge without the required approvals (needs bypass rights)")
    )
  )
    .addHelpText(
      "after",
      `
Without conflicts, \`prs merge <pr>\` is enough. If the pull request has
unanswered conflicts it exits 14 (MERGE_CONFLICTS) and lists them. Run \`prs diff\`
first, then answer each conflict (or let --take answer the rest) and pass the
diff's match_heads. If either branch moved since that diff, nothing is merged
(exit 13); diff again. Precedence: --resolutions-file, then --resolve, then
--take. "delete" removes the item; it isn't allowed for single values such as
max_retries.

--admin needs a workspace role in the target branch ruleset's bypass list or a
system admin; API keys carry no workspace role, so they can't use it.

Examples:
  $ cloudcruise prs merge 12 --workflow <workflow_id>
  $ cloudcruise prs merge 12 --workflow <workflow_id> --match-heads <heads> --resolve nodes:<node_id>=target --take source
  $ cloudcruise prs merge 12 --workflow <workflow_id> --match-heads <heads> --resolutions-file resolutions.json`
    )
    .action(async (ref: string, opts: WorkflowOption & MergeOptions & AuthOptions) => {
      try {
        const custom = opts.resolutionsFile
          ? readResolutionsFile(opts.resolutionsFile)
          : undefined
        validateMergeOptions(opts)
        const client = new ApiClient(await resolveAuth(opts))
        const pr = await getPullRequest(client, opts.workflow, ref)
        const preview = hasResolutionInput(opts)
          ? await client.get<MergePreview>(prPath(opts.workflow, pr, "preview"))
          : undefined
        const body = buildMergeBody(preview, opts, custom)
        try {
          outputJson(await client.post(prPath(opts.workflow, pr, "merge"), body))
        } catch (err: unknown) {
          throw toMergeConflictsError(err, pr, opts.workflow) ?? err
        }
      } catch (err: unknown) {
        fail(withBranchHint(err, ref))
      }
    })
}
