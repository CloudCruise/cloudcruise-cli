import { Command } from "commander"
import { resolveAuth } from "../core/auth.js"
import { ApiClient } from "../core/api-client.js"
import { outputJson } from "../core/output.js"
import { fail, UsageError } from "../core/exit.js"
import { addAuthOptions, type AuthOptions } from "../core/auth-options.js"
import {
  hasJsonObjectSource,
  readJsonObject,
  type JsonObjectSource
} from "../core/input.js"

export type ErrorCodeFieldOptions = {
  code?: string
  description?: string
  enrichedDescription?: string
  action?: string
}

type ErrorCode = { id: string } & Record<string, unknown>

export function buildListErrorCodesPath(opts: { workflowId?: string }): string {
  if (opts.workflowId === undefined) return "/error-codes"
  return `/error-codes?workflow_id=${encodeURIComponent(opts.workflowId)}`
}

/**
 * Request body for POST and PATCH /error-codes, built from the field flags.
 * Field rules are left to the API.
 */
export function buildErrorCodeBody(
  opts: ErrorCodeFieldOptions
): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (opts.code !== undefined) body.error_code = opts.code
  if (opts.description !== undefined) body.description = opts.description
  if (opts.enrichedDescription !== undefined) {
    body.enriched_description = opts.enrichedDescription
  }
  if (opts.action !== undefined) body.error_action = opts.action
  return body
}

/**
 * The body comes from the field flags or from --file/--stdin, never both, so
 * no value is silently overridden.
 */
export async function readErrorCodeBody(
  opts: ErrorCodeFieldOptions & JsonObjectSource
): Promise<Record<string, unknown>> {
  const fromFlags = buildErrorCodeBody(opts)
  if (!hasJsonObjectSource(opts)) return fromFlags
  if (Object.keys(fromFlags).length > 0) {
    throw new UsageError(
      "Pass the fields as flags or as a JSON object via --file/--stdin, not both"
    )
  }
  return (await readJsonObject(opts)) as Record<string, unknown>
}

export function findErrorCode(
  codes: ErrorCode[],
  id: string
): ErrorCode | undefined {
  const wanted = id.trim().toLowerCase()
  return codes.find((code) => code.id.toLowerCase() === wanted)
}

function addFieldOptions(cmd: Command): Command {
  return cmd
    .option("--code <name>", "Error code name, e.g. CLAIM_NOT_FOUND")
    .option("--description <text>", "What went wrong, shown on failed runs")
    .option(
      "--enriched-description <text>",
      "Longer context the maintenance agent uses to match failures to this code"
    )
    .option(
      "--action <action>",
      "error_action: alert (default), cancel, pause, retry or input_required"
    )
    .option(
      "--file <path>",
      "Read the fields from a JSON file (API field names; instead of flags)"
    )
    .option(
      "--stdin",
      "Read the fields from JSON on stdin (API field names; instead of flags)"
    )
}

const FIELDS_HELP = `
Pass the fields as flags, or as one JSON object via --file or --stdin. Not
both. The JSON object uses the API's field names (error_code, description,
enriched_description, error_action) and is sent as-is; unknown keys are
rejected (400).

error_action "retry" only labels the error today; nothing reruns the run.`

export function registerErrorCodeCommands(program: Command): void {
  const errorCodes = program
    .command("error-codes")
    .description(
      "Manage workspace error codes (the ids that error_on_false_message, error_message and selector_error_message take)"
    )

  // ── list ───────────────────────────────────────────────────────
  addAuthOptions(
    errorCodes
      .command("list")
      .description("List the workspace's error codes")
      .option(
        "--workflow-id <uuid>",
        "Only codes mapped to this workflow"
      )
  )
    .addHelpText(
      "after",
      `
Examples:
  $ cloudcruise error-codes list
  $ cloudcruise error-codes list --workflow-id 7c1e...`
    )
    .action(async (opts: { workflowId?: string } & AuthOptions) => {
      try {
        const path = buildListErrorCodesPath(opts)
        const client = new ApiClient(await resolveAuth(opts))
        outputJson(await client.get(path))
      } catch (err: unknown) {
        fail(err)
      }
    })

  // ── get ────────────────────────────────────────────────────────
  addAuthOptions(
    errorCodes
      .command("get <id>")
      .description("Get one of the workspace's error codes by id")
  )
    .addHelpText(
      "after",
      `
Exits 1 if the workspace has no code with this id.

Examples:
  $ cloudcruise error-codes get 7c1e...`
    )
    .action(async (id: string, opts: AuthOptions) => {
      try {
        const client = new ApiClient(await resolveAuth(opts))
        const codes = await client.get<ErrorCode[]>("/error-codes")
        const code = findErrorCode(codes, id)
        if (!code) {
          throw new Error(`No error code with id ${id} in this workspace`)
        }
        outputJson(code)
      } catch (err: unknown) {
        fail(err)
      }
    })

  // ── create ─────────────────────────────────────────────────────
  addAuthOptions(
    addFieldOptions(
      errorCodes
        .command("create")
        .description(
          "Create an error code, or return the existing one with the same name"
        )
    )
  )
    .addHelpText(
      "after",
      `
Find-or-create: if the workspace already has a code with this name (ignoring
case and surrounding whitespace), that code is returned with "created": false
and nothing is changed, even if you passed other fields. Safe to run again.
If "created" is false and the returned fields differ from what you want, run
\`error-codes update <id>\`.

Put the returned "id" into a node's error_on_false_message (BOOL_CONDITION),
error_message (USER_INTERACTION) or selector_error_message (selector nodes),
then save with \`workflows update\`. Saving links the code to the workflow.
Names, placeholders and free text are rejected on save.
${FIELDS_HELP}

Examples:
  $ cloudcruise error-codes create --code CLAIM_NOT_FOUND --description "Claim not found in the portal"
  $ printf '%s' '{"error_code":"PORTAL_DOWN","description":"Portal unavailable","error_action":"alert"}' | cloudcruise error-codes create --stdin`
    )
    .action(
      async (opts: ErrorCodeFieldOptions & JsonObjectSource & AuthOptions) => {
        try {
          const body = await readErrorCodeBody(opts)
          const client = new ApiClient(await resolveAuth(opts))
          outputJson(await client.post("/error-codes", body))
        } catch (err: unknown) {
          fail(err)
        }
      }
    )

  // ── update ─────────────────────────────────────────────────────
  addAuthOptions(
    addFieldOptions(
      errorCodes
        .command("update <id>")
        .description("Update an error code's name, descriptions or action")
    )
  )
    .addHelpText(
      "after",
      `
Only the fields you pass are changed. Passing no fields is rejected (400).
Renaming to a name another code already uses is rejected (409).
${FIELDS_HELP}

Examples:
  $ cloudcruise error-codes update 7c1e... --description "Claim number not found"
  $ cloudcruise error-codes update 7c1e... --action input_required`
    )
    .action(
      async (
        id: string,
        opts: ErrorCodeFieldOptions & JsonObjectSource & AuthOptions
      ) => {
        try {
          const body = await readErrorCodeBody(opts)
          const client = new ApiClient(await resolveAuth(opts))
          outputJson(
            await client.patch(`/error-codes/${encodeURIComponent(id)}`, body)
          )
        } catch (err: unknown) {
          fail(err)
        }
      }
    )
}
