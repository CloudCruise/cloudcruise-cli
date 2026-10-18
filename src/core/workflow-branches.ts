import { ApiClient, ApiError } from "./api-client.js"
import { UsageError } from "./exit.js"

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
}

export type WorkflowBranch = {
  id: string
  name: string
  is_default?: boolean
  head_version_id?: string
} & Record<string, unknown>

export type PullRequest = {
  id: string
  number: number
  status: string
  title: string | null
  source_branch_name: string
  target_branch_name: string
} & Record<string, unknown>

export type MergeConflict = {
  field: string
  key: string
  base?: unknown
  source?: unknown
  target?: unknown
  reason: string
  dependsOn?: { field: string; key: string }
}

export type MergePreview = {
  mergeable: boolean
  merged?: Record<string, unknown>
  conflicts: MergeConflict[]
  graphErrors?: unknown[]
  graphWarnings?: unknown[]
  sourceHeadVersionId: string
  targetHeadVersionId: string
  mergeBases?: { id: string; version: string | null }[]
}

export function branchesPath(workflowId: string): string {
  return `/workflows/${encodeURIComponent(workflowId)}/branches`
}

export function pullRequestsPath(workflowId: string): string {
  return `/workflows/${encodeURIComponent(workflowId)}/pull-requests`
}

/**
 * A branch is named by its id or its name. An id that matches no branch is
 * still rejected here rather than passed through, so a typo fails with the
 * list of branches instead of a bare 404 from the API.
 */
export function findBranch(
  branches: WorkflowBranch[],
  ref: string
): WorkflowBranch {
  const wanted = ref.trim()
  const match =
    branches.find((b) => b.id.toLowerCase() === wanted.toLowerCase()) ??
    branches.find((b) => b.name === wanted)
  if (!match) {
    const known = branches.map((b) => b.name).join(", ") || "none"
    throw new UsageError(
      `No branch "${ref}" on this workflow. Branches: ${known}`
    )
  }
  return match
}

export async function listBranches(
  client: ApiClient,
  workflowId: string
): Promise<WorkflowBranch[]> {
  return client.get<WorkflowBranch[]>(branchesPath(workflowId))
}

export async function resolveBranch(
  client: ApiClient,
  workflowId: string,
  ref: string
): Promise<WorkflowBranch> {
  return findBranch(await listBranches(client, workflowId), ref)
}

/**
 * For flags that only need the branch id: a UUID is sent as-is (one request
 * fewer, and the API answers 404 for an unknown one), anything else is looked
 * up by name.
 */
export async function resolveBranchId(
  client: ApiClient,
  workflowId: string,
  ref: string
): Promise<string> {
  if (isUuid(ref.trim())) return ref.trim()
  return (await resolveBranch(client, workflowId, ref)).id
}

/** The id of the highest version matching an exact version or semver range. */
export async function resolveVersionId(
  client: ApiClient,
  workflowId: string,
  version: string
): Promise<string> {
  const workflow = await client.get<{ version_id?: string }>(
    `/workflows/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(version)}`
  )
  if (!workflow.version_id) {
    throw new Error(`The API returned no version_id for version ${version}`)
  }
  return workflow.version_id
}

export type PullRequestRef = { number: number } | { id: string }

/** `12`, `#12` or a pull request id. */
export function parsePullRequestRef(ref: string): PullRequestRef {
  const trimmed = ref.trim()
  const numeric = /^#?(\d+)$/.exec(trimmed)
  if (numeric) return { number: Number(numeric[1]) }
  if (isUuid(trimmed)) return { id: trimmed }
  throw new UsageError(
    `"${ref}" is not a pull request number (e.g. 12 or #12) or id`
  )
}

export async function getPullRequest(
  client: ApiClient,
  workflowId: string,
  ref: string
): Promise<PullRequest> {
  const parsed = parsePullRequestRef(ref)
  const base = pullRequestsPath(workflowId)
  return client.get<PullRequest>(
    "number" in parsed
      ? `${base}/by-number/${parsed.number}`
      : `${base}/${encodeURIComponent(parsed.id)}`
  )
}

export const PR_STATES = ["open", "merged", "closed", "all"] as const
export type PullRequestState = (typeof PR_STATES)[number]

export function filterPullRequests(
  prs: PullRequest[],
  state: PullRequestState
): PullRequest[] {
  return state === "all" ? prs : prs.filter((pr) => pr.status === state)
}

export function conflictKey(conflict: { field: string; key: string }): string {
  return `${conflict.field}:${conflict.key}`
}

const SINGLE_VALUE_FIELDS = new Set([
  "proxy_setting",
  "proxy_value",
  "max_retries",
  "use_native_actions",
  "video_record_session",
  "enable_network_listener",
  "skip_udp_proxying",
  "manual_captcha_solve"
])

/**
 * Whether a conflict can be resolved by removing the item. Single-value
 * fields and a schema's top-level keywords always exist, so for them `null`
 * would be written as a value, not mean "delete".
 */
export function canDelete(conflict: MergeConflict): boolean {
  return !SINGLE_VALUE_FIELDS.has(conflict.field) && conflict.key !== "$schema-root"
}

const MAX_VALUE_PREVIEW = 60

function previewValue(value: unknown): string {
  const text = JSON.stringify(value) ?? "undefined"
  return text.length > MAX_VALUE_PREVIEW
    ? `${text.slice(0, MAX_VALUE_PREVIEW - 1)}…`
    : text
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sameJson(a: unknown, b: unknown): boolean {
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    return [...keys].every((k) => sameJson(a[k], b[k]))
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => sameJson(item, b[i]))
  }
  return Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b)
}

/** Top-level keys that differ, one level deeper for a node's parameters. */
function changedPaths(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): string[] {
  const paths: string[] = []
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const key of keys) {
    if (sameJson(before[key], after[key])) continue
    if (
      key === "parameters" &&
      isPlainObject(before[key]) &&
      isPlainObject(after[key])
    ) {
      paths.push(
        ...changedPaths(
          before[key] as Record<string, unknown>,
          after[key] as Record<string, unknown>
        ).map((p) => `parameters.${p}`)
      )
    } else {
      paths.push(key)
    }
  }
  return paths
}

function describeSide(base: unknown, side: unknown): string {
  if (side === undefined) return base === undefined ? "absent" : "deleted it"
  if (base === undefined) return "added it"
  if (isPlainObject(base) && isPlainObject(side)) {
    const paths = changedPaths(base, side)
    return paths.length > 0 ? `changed ${paths.join(", ")}` : "left it unchanged"
  }
  return `set ${previewValue(side)}`
}

function itemLabel(conflict: MergeConflict): string {
  if (conflict.key === "$value") return conflict.field
  if (conflict.key === "$schema-root") return `${conflict.field} (top level)`
  const named = [conflict.source, conflict.target, conflict.base].find(
    (v) => isPlainObject(v) && typeof v.name === "string"
  ) as { name: string } | undefined
  const singular = conflict.field.replace(/s$/, "")
  return named
    ? `${singular} "${named.name}" (${conflict.key})`
    : `${conflict.field} ${conflict.key}`
}

export function describeConflict(conflict: MergeConflict): string {
  if (conflict.reason === "referential" && conflict.dependsOn) {
    return `${itemLabel(conflict)} references ${conflictKey(conflict.dependsOn)}; it follows whichever side that conflict takes unless resolved itself`
  }
  return `${itemLabel(conflict)}: source ${describeSide(conflict.base, conflict.source)}; target ${describeSide(conflict.base, conflict.target)}`
}

export function formatMatchHeads(preview: {
  sourceHeadVersionId: string
  targetHeadVersionId: string
}): string {
  return `${preview.sourceHeadVersionId}:${preview.targetHeadVersionId}`
}

export function parseMatchHeads(value: string): {
  sourceHeadVersionId: string
  targetHeadVersionId: string
} {
  const [source, target, ...rest] = value.trim().split(":")
  if (rest.length > 0 || !source || !target || !isUuid(source) || !isUuid(target)) {
    throw new UsageError(
      `--match-heads must be "<source_head>:<target_head>" as printed by \`prs diff\` (got: ${value})`
    )
  }
  return { sourceHeadVersionId: source, targetHeadVersionId: target }
}

/** The JSON `prs diff` prints: everything needed to decide and resolve. */
export function buildDiffOutput(
  pr: PullRequest,
  preview: MergePreview,
  opts: { includeMerged?: boolean } = {}
): Record<string, unknown> {
  const output: Record<string, unknown> = {
    pull_request: {
      id: pr.id,
      number: pr.number,
      title: pr.title,
      status: pr.status,
      source_branch_name: pr.source_branch_name,
      target_branch_name: pr.target_branch_name
    },
    mergeable: preview.mergeable,
    match_heads: formatMatchHeads(preview),
    conflicts: preview.conflicts.map((c) => ({
      key: conflictKey(c),
      reason: c.reason,
      summary: describeConflict(c),
      can_delete: canDelete(c),
      ...(c.dependsOn ? { depends_on: conflictKey(c.dependsOn) } : {}),
      base: c.base ?? null,
      source: c.source ?? null,
      target: c.target ?? null
    }))
  }
  if (preview.mergeBases && preview.mergeBases.length > 1) {
    output.merge_bases = preview.mergeBases
    output.merge_bases_warning = `These branches share more than one base version. Changes are compared against ${preview.mergeBases[0].version ?? preview.mergeBases[0].id}; changes that came in through the others, including reverts, can merge without showing up as conflicts. Check the merged result before merging.`
  }
  if (preview.graphErrors?.length) output.graph_errors = preview.graphErrors
  if (preview.graphWarnings?.length) output.graph_warnings = preview.graphWarnings
  if (opts.includeMerged) output.merged = preview.merged ?? null
  return output
}

/**
 * A resolutions file to edit by hand, pre-filled with the source side of every
 * conflict that needs its own answer. Referential conflicts are left out:
 * they follow the conflict they depend on.
 */
export function buildResolutionsTemplate(
  preview: MergePreview
): Record<string, unknown> {
  const template: Record<string, unknown> = {}
  for (const c of preview.conflicts) {
    if (c.dependsOn) continue
    template[conflictKey(c)] = c.source ?? null
  }
  return template
}

export type ResolveChoice = "source" | "target" | "delete"
const RESOLVE_CHOICES: readonly ResolveChoice[] = ["source", "target", "delete"]

/** `--resolve <field:key>=<source|target|delete>`; the key may contain ":" and "=". */
export function parseResolveFlag(value: string): { key: string; choice: ResolveChoice } {
  const at = value.lastIndexOf("=")
  const key = at > 0 ? value.slice(0, at).trim() : ""
  const choice = at > 0 ? value.slice(at + 1).trim() : ""
  if (!key || !RESOLVE_CHOICES.includes(choice as ResolveChoice)) {
    throw new UsageError(
      `--resolve must be "<conflict key>=source|target|delete", e.g. nodes:<node_id>=target (got: ${value})`
    )
  }
  return { key, choice: choice as ResolveChoice }
}

export type ResolutionInput = {
  resolve?: { key: string; choice: ResolveChoice }[]
  take?: "source" | "target"
  custom?: Record<string, unknown>
}

function sideValue(conflict: MergeConflict, side: "source" | "target"): unknown {
  const value = conflict[side]
  return value === undefined ? null : value
}

/**
 * Turns per-conflict choices into the literal values the merge endpoint
 * expects, taken from the same preview the heads are checked against.
 * Precedence: --resolutions-file values, then --resolve, then --take. A
 * referential conflict left unanswered follows the side its driving conflict
 * took, as the API does; it stays unresolved when the driving one was given a
 * custom value. Every conflict must end up answered, and every answer must
 * name a real conflict - the API would otherwise ignore a stale key silently.
 */
export function buildResolutions(
  conflicts: MergeConflict[],
  input: ResolutionInput
): Record<string, unknown> {
  const byKey = new Map(conflicts.map((c) => [conflictKey(c), c]))
  const resolutions: Record<string, unknown> = {}
  const sides = new Map<string, "source" | "target" | "custom">()

  const requireConflict = (key: string, origin: string): MergeConflict => {
    const conflict = byKey.get(key)
    if (!conflict) {
      const known = [...byKey.keys()].join(", ") || "none"
      throw new UsageError(
        `${origin} names "${key}", which is not a conflict in this merge. Conflicts: ${known}`
      )
    }
    return conflict
  }

  for (const [key, value] of Object.entries(input.custom ?? {})) {
    requireConflict(key, "--resolutions-file")
    resolutions[key] = value
    sides.set(key, "custom")
  }

  for (const { key, choice } of input.resolve ?? []) {
    const conflict = requireConflict(key, "--resolve")
    if (key in resolutions) {
      throw new UsageError(`"${key}" is resolved more than once`)
    }
    if (choice === "delete") {
      if (!canDelete(conflict)) {
        throw new UsageError(
          `"${key}" can't be deleted (it always has a value); choose source or target`
        )
      }
      resolutions[key] = null
      sides.set(
        key,
        conflict.source === undefined
          ? "source"
          : conflict.target === undefined
            ? "target"
            : "custom"
      )
    } else {
      resolutions[key] = sideValue(conflict, choice)
      sides.set(key, choice)
    }
  }

  if (input.take) {
    for (const conflict of conflicts) {
      const key = conflictKey(conflict)
      if (key in resolutions) continue
      if (conflict.dependsOn && byKey.has(conflictKey(conflict.dependsOn))) continue
      resolutions[key] = sideValue(conflict, input.take)
      sides.set(key, input.take)
    }
  }

  for (const conflict of conflicts) {
    const key = conflictKey(conflict)
    if (key in resolutions || !conflict.dependsOn) continue
    const drivingSide = sides.get(conflictKey(conflict.dependsOn))
    if (drivingSide === "source" || drivingSide === "target") {
      resolutions[key] = sideValue(conflict, drivingSide)
      sides.set(key, drivingSide)
    }
  }

  const unresolved = conflicts.filter((c) => !(conflictKey(c) in resolutions))
  if (unresolved.length > 0) {
    throw new UsageError(
      `Unresolved conflicts: ${unresolved
        .map((c) => `${conflictKey(c)} (${c.reason})`)
        .join(", ")}. Add --resolve <key>=source|target|delete for each, --take source|target for the rest, or values in --resolutions-file.`
    )
  }
  return resolutions
}

function apiMessage(err: ApiError): string {
  try {
    const parsed: unknown = JSON.parse(err.body)
    if (isPlainObject(parsed) && typeof parsed.message === "string") return parsed.message
  } catch {
    // Non-JSON body - fall back to the full error message.
  }
  return err.message
}

const BYPASS_HINT =
  "Bypassing review or protection needs a workspace role in the branch ruleset's bypass list, or a system admin. API keys carry no workspace role, so they can't bypass; log in with `cloudcruise login` as a user who has that role."

/**
 * What to do next for the branch and pull request errors an agent can act on.
 * Returns the error unchanged when there is nothing more specific to say.
 */
export function withBranchHint(err: unknown, pr?: string): unknown {
  if (!(err instanceof ApiError)) return err
  const message = apiMessage(err)
  const ref = pr ?? "<number>"
  if (message.includes("can't approve your own pull request")) {
    err.hint =
      "Another workspace member has to approve it. An API key acts as the user who created it."
  } else if (/^Needs \d+ approval/.test(message)) {
    err.hint = `Ask a reviewer to run \`prs approve ${ref}\`. ${BYPASS_HINT}`
  } else if (
    message.includes("permission to force-merge") ||
    message.includes("permission to bypass protection")
  ) {
    err.hint = BYPASS_HINT
  } else if (message.includes("is protected")) {
    err.hint =
      "Save to another branch (`branches create`, then `workflows update --branch`) and open a pull request with `prs create`."
  } else if (message === "Unresolved merge conflicts") {
    err.hint = `Run \`prs diff ${ref}\`, then merge with --match-heads plus --resolve <key>=source|target|delete, --take source|target or --resolutions-file.`
  } else if (
    message.includes("since this merge was previewed") ||
    message.includes("Missing preview head versions")
  ) {
    err.hint = `A branch moved. Run \`prs diff ${ref}\` again and decide on the current conflicts.`
  } else if (message === "Merged workflow failed validation" || message.startsWith("Merged ")) {
    err.hint =
      "The merged result is invalid (see errors). Resolve the conflicts differently, or fix the source branch with `workflows update --branch` and diff again."
  } else if (message.includes("Another merge into this workflow is still in progress")) {
    err.hint = "Retry in a few seconds."
  }
  return err
}
