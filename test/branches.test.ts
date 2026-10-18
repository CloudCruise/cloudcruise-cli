import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ApiError } from "../dist/src/core/api-client.js"
import {
  buildErrorEnvelope,
  ExitCode,
  StalePreviewError,
  UsageError
} from "../dist/src/core/exit.js"
import {
  buildDiffOutput,
  buildResolutions,
  buildResolutionsTemplate,
  canDelete,
  describeConflict,
  filterPullRequests,
  findBranch,
  parseMatchHeads,
  parsePullRequestRef,
  parseResolveFlag,
  toMergeConflictsError,
  withBranchHint
} from "../dist/src/core/workflow-branches.js"
import {
  buildCreateBranchBody,
  buildDeleteBranchPath
} from "../dist/src/commands/branches.js"
import {
  buildMergeBody,
  readResolutionsFile,
  validateMergeOptions
} from "../dist/src/commands/pull-requests.js"

const WORKFLOW_ID = "d413c71b-841e-40e6-8765-29df2968af26"
const MAIN_ID = "11111111-1111-4111-8111-111111111111"
const FEATURE_ID = "22222222-2222-4222-8222-222222222222"
const SOURCE_HEAD = "33333333-3333-4333-8333-333333333333"
const TARGET_HEAD = "44444444-4444-4444-8444-444444444444"
const NODE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const NODE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const HEADS = `${SOURCE_HEAD}:${TARGET_HEAD}`

const branches = [
  { id: MAIN_ID, name: "main", is_default: true },
  { id: FEATURE_ID, name: "fix-login", is_default: false }
]

const node = (id: string, execution: string, name = "Click login") => ({
  id,
  name,
  action: "CLICK",
  parameters: { execution }
})

const modifyModify = {
  field: "nodes",
  key: NODE_A,
  base: node(NODE_A, "STATIC"),
  source: node(NODE_A, "LLM_VISION"),
  target: { ...node(NODE_A, "STATIC"), name: "Click sign in" },
  reason: "modify-modify"
}
const deletedOnTarget = {
  field: "nodes",
  key: NODE_B,
  base: node(NODE_B, "STATIC", "Submit"),
  source: node(NODE_B, "LLM_VISION", "Submit"),
  reason: "modify-delete"
}
const maxRetries = {
  field: "max_retries",
  key: "$value",
  base: 1,
  source: 3,
  target: 5,
  reason: "modify-modify"
}
const edgeFollowingNodeA = {
  field: "edges",
  key: NODE_A,
  base: { to: NODE_B },
  source: { to: null },
  target: { to: NODE_B },
  reason: "referential",
  dependsOn: { field: "nodes", key: NODE_A }
}

const preview = (conflicts: unknown[], extra: Record<string, unknown> = {}) => ({
  mergeable: conflicts.length === 0,
  merged: { nodes: [] },
  conflicts,
  sourceHeadVersionId: SOURCE_HEAD,
  targetHeadVersionId: TARGET_HEAD,
  ...extra
})

const pr = {
  id: "55555555-5555-4555-8555-555555555555",
  number: 12,
  status: "open",
  title: "Fix login",
  source_branch_name: "fix-login",
  target_branch_name: "main"
}

test("findBranch matches a branch by name, so agents never need to look up ids", () => {
  assert.equal(findBranch(branches, "fix-login").id, FEATURE_ID)
})

test("findBranch matches an id case-insensitively, since UUIDs are often upper-cased by tools", () => {
  assert.equal(findBranch(branches, MAIN_ID.toUpperCase()).name, "main")
})

test("findBranch rejects an unknown branch as a usage error that lists the real branch names", () => {
  assert.throws(
    () => findBranch(branches, "fix-logn"),
    (err: unknown) =>
      err instanceof UsageError && err.message.includes("main, fix-login")
  )
})

test("parsePullRequestRef accepts 12 and #12 as numbers and a UUID as an id, like gh", () => {
  assert.deepEqual(parsePullRequestRef("12"), { number: 12 })
  assert.deepEqual(parsePullRequestRef("#12"), { number: 12 })
  assert.deepEqual(parsePullRequestRef(pr.id), { id: pr.id })
  assert.throws(() => parsePullRequestRef("fix-login"), UsageError)
})

test("filterPullRequests keeps only the requested state and everything for all", () => {
  const prs = [
    { ...pr, status: "open" },
    { ...pr, number: 13, status: "merged" }
  ]
  assert.deepEqual(filterPullRequests(prs, "open").map((p) => p.number), [12])
  assert.equal(filterPullRequests(prs, "all").length, 2)
})

test("describeConflict names the node and what each side changed, down to node parameters", () => {
  assert.equal(
    describeConflict(modifyModify),
    `node "Click login" (${NODE_A}): source changed parameters.execution; target changed name`
  )
})

test("describeConflict says which side deleted an item a modify-delete conflict is about", () => {
  assert.match(describeConflict(deletedOnTarget), /source changed parameters\.execution; target deleted it$/)
})

test("describeConflict shows both values of a single-value field", () => {
  assert.equal(describeConflict(maxRetries), "max_retries: source set 3; target set 5")
})

test("describeConflict tells that a referential conflict follows the conflict it depends on", () => {
  assert.match(describeConflict(edgeFollowingNodeA), new RegExp(`references nodes:${NODE_A}`))
})

test("canDelete is false for single-value fields and schema roots, where null is a value rather than a deletion", () => {
  assert.equal(canDelete(modifyModify), true)
  assert.equal(canDelete(maxRetries), false)
  assert.equal(canDelete({ field: "input_schema", key: "$schema-root", reason: "modify-modify" }), false)
})

test("parseResolveFlag splits on the last = so keys containing : and = survive", () => {
  assert.deepEqual(parseResolveFlag(`nodes:${NODE_A}=target`), { key: `nodes:${NODE_A}`, choice: "target" })
  assert.deepEqual(parseResolveFlag("input_schema:a=b=delete"), { key: "input_schema:a=b", choice: "delete" })
  assert.throws(() => parseResolveFlag(`nodes:${NODE_A}=mine`), UsageError)
  assert.throws(() => parseResolveFlag("=source"), UsageError)
})

test("parseMatchHeads accepts the source:target pair prs diff prints and rejects anything else", () => {
  assert.deepEqual(parseMatchHeads(HEADS), {
    sourceHeadVersionId: SOURCE_HEAD,
    targetHeadVersionId: TARGET_HEAD
  })
  assert.throws(() => parseMatchHeads(SOURCE_HEAD), UsageError)
  assert.throws(() => parseMatchHeads(`${SOURCE_HEAD}:nope`), UsageError)
})

test("buildResolutions copies the chosen side's literal value from the preview, which is what the API expects", () => {
  const resolutions = buildResolutions([modifyModify, maxRetries], {
    resolve: [
      { key: `nodes:${NODE_A}`, choice: "target" },
      { key: "max_retries:$value", choice: "source" }
    ]
  })
  assert.deepEqual(resolutions, {
    [`nodes:${NODE_A}`]: modifyModify.target,
    "max_retries:$value": 3
  })
})

test("buildResolutions sends null for the side that deleted the item, the API's deletion marker", () => {
  assert.deepEqual(
    buildResolutions([deletedOnTarget], { take: "target" }),
    { [`nodes:${NODE_B}`]: null }
  )
  assert.deepEqual(
    buildResolutions([deletedOnTarget], { resolve: [{ key: `nodes:${NODE_B}`, choice: "delete" }] }),
    { [`nodes:${NODE_B}`]: null }
  )
})

test("buildResolutions refuses delete for a single-value field, which would write null as its value", () => {
  assert.throws(
    () => buildResolutions([maxRetries], { resolve: [{ key: "max_retries:$value", choice: "delete" }] }),
    UsageError
  )
})

test("buildResolutions applies file values first, then --resolve, then --take for whatever is left", () => {
  const resolutions = buildResolutions([modifyModify, deletedOnTarget, maxRetries], {
    custom: { "max_retries:$value": 4 },
    resolve: [{ key: `nodes:${NODE_A}`, choice: "source" }],
    take: "target"
  })
  assert.deepEqual(resolutions, {
    "max_retries:$value": 4,
    [`nodes:${NODE_A}`]: modifyModify.source,
    [`nodes:${NODE_B}`]: null
  })
})

test("buildResolutions rejects a key that is not a conflict, which the API would otherwise ignore silently", () => {
  assert.throws(
    () => buildResolutions([modifyModify], { resolve: [{ key: `nodes:${NODE_B}`, choice: "source" }] }),
    (err: unknown) => err instanceof UsageError && err.message.includes(`nodes:${NODE_A}`)
  )
})

test("buildResolutions rejects answering the same conflict twice, so no answer is silently overridden", () => {
  assert.throws(
    () =>
      buildResolutions([maxRetries], {
        custom: { "max_retries:$value": 4 },
        resolve: [{ key: "max_retries:$value", choice: "source" }]
      }),
    UsageError
  )
})

test("buildResolutions resolves a referential conflict to the side its driving conflict took, as the API does", () => {
  const resolutions = buildResolutions([modifyModify, edgeFollowingNodeA], {
    resolve: [{ key: `nodes:${NODE_A}`, choice: "source" }]
  })
  assert.deepEqual(resolutions[`edges:${NODE_A}`], { to: null })
})

test("buildResolutions keeps --take from overriding a referential conflict whose driver chose another side", () => {
  const resolutions = buildResolutions([modifyModify, edgeFollowingNodeA], {
    resolve: [{ key: `nodes:${NODE_A}`, choice: "target" }],
    take: "source"
  })
  assert.deepEqual(resolutions[`edges:${NODE_A}`], { to: NODE_B })
})

test("buildResolutions leaves a referential conflict unresolved when its driver got a custom value, since no side applies", () => {
  assert.throws(
    () =>
      buildResolutions([modifyModify, edgeFollowingNodeA], {
        custom: { [`nodes:${NODE_A}`]: node(NODE_A, "OTHER") }
      }),
    (err: unknown) => err instanceof UsageError && err.message.includes(`edges:${NODE_A} (referential)`)
  )
})

// The generated template omits referential conflicts and pre-fills source
// values; sending it back unchanged must complete the merge, so a file value
// equal to one side counts as that side, as the API itself decides.
test("buildResolutions lets a referential conflict follow a file value equal to one side, so an unedited template merges", () => {
  const conflicts = [modifyModify, edgeFollowingNodeA]
  const template = buildResolutionsTemplate(preview(conflicts))
  const resolutions = buildResolutions(conflicts, { custom: template })
  assert.deepEqual(resolutions[`edges:${NODE_A}`], edgeFollowingNodeA.source)
})

test("buildResolutions treats a file null as picking the side that deleted the item, for its referential conflicts", () => {
  const dependent = { ...edgeFollowingNodeA, key: NODE_B, dependsOn: { field: "nodes", key: NODE_B } }
  const resolutions = buildResolutions([deletedOnTarget, dependent], {
    custom: { [`nodes:${NODE_B}`]: null }
  })
  assert.deepEqual(resolutions[`edges:${NODE_B}`], dependent.target)
})

test("buildResolutions lists every unanswered conflict instead of letting the API reject the merge", () => {
  assert.throws(
    () => buildResolutions([modifyModify, maxRetries], {}),
    (err: unknown) =>
      err instanceof UsageError &&
      err.message.includes(`nodes:${NODE_A} (modify-modify)`) &&
      err.message.includes("max_retries:$value (modify-modify)")
  )
})

test("buildMergeBody sends an empty body for a merge without conflicts, and force only with --admin", () => {
  assert.deepEqual(buildMergeBody(undefined, {}), {})
  assert.deepEqual(buildMergeBody(undefined, { admin: true }), { force: true })
})

test("validateMergeOptions requires --match-heads whenever conflicts are resolved, before any request", () => {
  assert.throws(() => validateMergeOptions({ take: "source" }), UsageError)
  assert.doesNotThrow(() => validateMergeOptions({ take: "source", matchHeads: HEADS }))
})

test("buildMergeBody refuses to resolve against a preview whose heads moved, and exits 13 like a version conflict", () => {
  const moved = { ...preview([maxRetries]), targetHeadVersionId: SOURCE_HEAD }
  assert.throws(
    () => buildMergeBody(moved, { take: "source", matchHeads: HEADS }),
    (err: unknown) => err instanceof StalePreviewError
  )
  const { exitCode, envelope } = buildErrorEnvelope(new StalePreviewError("moved", "diff again"))
  assert.equal(exitCode, ExitCode.VERSION_CONFLICT)
  assert.equal(envelope.code, "STALE_MERGE_PREVIEW")
})

// --match-heads on a conflict-free merge means "merge what I reviewed":
// ignoring it would let changes pushed after the review merge unseen.
test("buildMergeBody checks --match-heads even without resolutions and sends the heads for the API to re-check", () => {
  assert.deepEqual(buildMergeBody(preview([]), { matchHeads: HEADS }), {
    previewSourceHeadVersionId: SOURCE_HEAD,
    previewTargetHeadVersionId: TARGET_HEAD
  })
  const moved = { ...preview([]), sourceHeadVersionId: TARGET_HEAD }
  assert.throws(() => buildMergeBody(moved, { matchHeads: HEADS }), StalePreviewError)
})

test("buildMergeBody sends the resolutions with the preview heads the API checks for staleness", () => {
  assert.deepEqual(buildMergeBody(preview([maxRetries]), { take: "target", matchHeads: HEADS }), {
    resolutions: { "max_retries:$value": 5 },
    previewSourceHeadVersionId: SOURCE_HEAD,
    previewTargetHeadVersionId: TARGET_HEAD
  })
})

test("readResolutionsFile accepts a JSON object and rejects other JSON as a usage error", () => {
  const dir = mkdtempSync(join(tmpdir(), "resolutions-"))
  const good = join(dir, "good.json")
  writeFileSync(good, JSON.stringify({ "max_retries:$value": 4 }))
  assert.deepEqual(readResolutionsFile(good), { "max_retries:$value": 4 })
  const bad = join(dir, "bad.json")
  writeFileSync(bad, "[1]")
  assert.throws(() => readResolutionsFile(bad), UsageError)
})

test("buildDiffOutput gives each conflict its --resolve key, summary and dependency, plus match_heads", () => {
  const output = buildDiffOutput(pr, preview([modifyModify, edgeFollowingNodeA])) as {
    match_heads: string
    conflicts: { key: string; depends_on?: string; can_delete: boolean }[]
    merged?: unknown
    merge_bases?: unknown
  }
  assert.equal(output.match_heads, HEADS)
  assert.deepEqual(output.conflicts.map((c) => c.key), [`nodes:${NODE_A}`, `edges:${NODE_A}`])
  assert.equal(output.conflicts[1].depends_on, `nodes:${NODE_A}`)
  assert.equal(output.merged, undefined)
  assert.equal(output.merge_bases, undefined)
})

test("buildDiffOutput warns only when there is more than one merge base, and includes the merge result only on request", () => {
  const output = buildDiffOutput(
    pr,
    preview([], {
      mergeBases: [
        { id: SOURCE_HEAD, version: "1.2.0" },
        { id: TARGET_HEAD, version: "1.1.0" }
      ]
    }),
    { includeMerged: true }
  ) as { merge_bases_warning?: string; merged?: unknown }
  assert.match(output.merge_bases_warning ?? "", /compared against 1\.2\.0/)
  assert.deepEqual(output.merged, { nodes: [] })
})

test("buildResolutionsTemplate pre-fills the source side and leaves out referential conflicts", () => {
  assert.deepEqual(buildResolutionsTemplate(preview([modifyModify, deletedOnTarget, edgeFollowingNodeA])), {
    [`nodes:${NODE_A}`]: modifyModify.source,
    [`nodes:${NODE_B}`]: deletedOnTarget.source
  })
})

test("withBranchHint explains self-approval, and the envelope carries the hint", () => {
  const own = withBranchHint(
    new ApiError("forbidden", 403, JSON.stringify({ message: "You can't approve your own pull request" }))
  ) as ApiError
  assert.match(own.hint ?? "", /Another workspace member/)
  assert.match(String(buildErrorEnvelope(own).envelope.hint), /Another workspace member/)
})

const unresolvedConflictsError = () =>
  new ApiError(
    "conflict",
    409,
    JSON.stringify({ message: "Unresolved merge conflicts", conflicts: [modifyModify, maxRetries] })
  )

// A bare "Unresolved merge conflicts" (exit 1) told an agent neither what
// conflicts nor what to run; the restated error names both and exits 14 so a
// driver can branch on "decide on conflicts" without parsing text.
test("toMergeConflictsError restates an unresolved-conflicts 409 with the PR, each conflict and the commands to run, and exits 14", () => {
  const err = toMergeConflictsError(unresolvedConflictsError(), { number: 12 }, WORKFLOW_ID)
  assert.ok(err)
  assert.match(err.message, /^Pull request #12 can't be merged: 2 conflicts need a decision\./)
  assert.match(err.message, /\| max_retries: source set 3; target set 5$/)
  const { exitCode, envelope } = buildErrorEnvelope(err)
  assert.equal(exitCode, ExitCode.MERGE_CONFLICTS)
  assert.equal(exitCode, 14)
  assert.equal(envelope.code, "MERGE_CONFLICTS")
  assert.deepEqual(
    (envelope.conflicts as { key: string }[]).map((c) => c.key),
    [`nodes:${NODE_A}`, "max_retries:$value"]
  )
  assert.match(String(envelope.hint), new RegExp(`prs diff 12 --workflow ${WORKFLOW_ID}`))
  assert.match(String(envelope.hint), /--match-heads <match_heads>/)
})

test("toMergeConflictsError says '1 conflict needs' for a single conflict", () => {
  const single = new ApiError(
    "conflict",
    409,
    JSON.stringify({ message: "Unresolved merge conflicts", conflicts: [maxRetries] })
  )
  assert.match(toMergeConflictsError(single, { number: 3 }, WORKFLOW_ID)?.message ?? "", /1 conflict needs a decision/)
})

test("toMergeConflictsError leaves every other error alone, including other 409s", () => {
  const moved = new ApiError("conflict", 409, JSON.stringify({ message: "Pull request is not open" }))
  assert.equal(toMergeConflictsError(moved, { number: 12 }, WORKFLOW_ID), undefined)
  assert.equal(toMergeConflictsError(new Error("boom"), { number: 12 }, WORKFLOW_ID), undefined)
})

test("withBranchHint tells API-key users they cannot bypass review", () => {
  const err = withBranchHint(
    new ApiError(
      "forbidden",
      403,
      JSON.stringify({ message: "You don't have permission to force-merge past branch 'main's review requirement." })
    )
  ) as ApiError
  assert.match(err.hint ?? "", /API keys carry no workspace role/)
})

test("buildCreateBranchBody prefers a starting version over a starting branch, matching the API", () => {
  assert.deepEqual(buildCreateBranchBody("x", {}), { name: "x" })
  assert.deepEqual(buildCreateBranchBody("x", { branchId: MAIN_ID }), { name: "x", fromBranchId: MAIN_ID })
  assert.deepEqual(buildCreateBranchBody("x", { versionId: SOURCE_HEAD }), { name: "x", fromVersionId: SOURCE_HEAD })
})

test("buildDeleteBranchPath adds closeOpenPullRequests only when asked", () => {
  assert.equal(
    buildDeleteBranchPath(WORKFLOW_ID, FEATURE_ID, false),
    `/workflows/${WORKFLOW_ID}/branches/${FEATURE_ID}`
  )
  assert.equal(
    buildDeleteBranchPath(WORKFLOW_ID, FEATURE_ID, true),
    `/workflows/${WORKFLOW_ID}/branches/${FEATURE_ID}?closeOpenPullRequests=true`
  )
})
