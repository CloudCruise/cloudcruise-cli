import { Command, InvalidArgumentError } from "commander"
import { resolveAuth } from "../core/auth.js"
import { ApiClient } from "../core/api-client.js"
import { outputJson } from "../core/output.js"
import { fail, UsageError } from "../core/exit.js"
import { addAuthOptions, type AuthOptions } from "../core/auth-options.js"

const parseNonNegativeInt = (value: string): number => {
  const parsed = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed)) {
    throw new InvalidArgumentError(
      `Must be a non-negative integer (got: ${value}).`
    )
  }
  return parsed
}

export type ErrorCodeFieldOptions = {
  code?: string
  description?: string
  enrichedDescription?: string
  action?: string
  retries?: number
  retryAfter?: number
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString("utf-8")
}

function parseJsonObject(raw: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new UsageError("--stdin must contain valid JSON")
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new UsageError("--stdin must contain a JSON object")
  }
  return value as Record<string, unknown>
}

export function buildListErrorCodesPath(opts: { workflowId?: string }): string {
  if (opts.workflowId === undefined) return "/error-codes"
  return `/error-codes?workflow_id=${encodeURIComponent(opts.workflowId)}`
}

/**
 * Request body for POST and PATCH /error-codes: the --stdin object with any
 * flags laid over it. Field rules are left to the API.
 */
export function buildErrorCodeBody(
  opts: ErrorCodeFieldOptions,
  stdinBody?: Record<string, unknown>
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...(stdinBody ?? {}) }
  if (opts.code !== undefined) body.error_code = opts.code
  if (opts.description !== undefined) body.description = opts.description
  if (opts.enrichedDescription !== undefined) {
    body.enriched_description = opts.enrichedDescription
  }
  if (opts.action !== undefined) body.error_action = opts.action
  if (opts.retries !== undefined) body.retries = opts.retries
  if (opts.retryAfter !== undefined) body.retry_after = opts.retryAfter
  return body
}

function addFieldOptions(cmd: Command): Command {
  return cmd
    .option("--code <name>", "Error code name, e.g. CLAIM_NOT_FOUND")
    .option("--description <text>", "What went wrong, shown on failed runs")
    .option(
      "--enriched-description <text>",
      "Longer context for the maintenance agent"
    )
    .option(
      "--action <action>",
      "What happens when the code fires (error_action), e.g. alert or retry"
    )
    .option("--retries <n>", "Retries for this code", parseNonNegativeInt)
    .option(
      "--retry-after <n>",
      "Delay before retrying",
      parseNonNegativeInt
    )
    .option("--stdin", "Read a JSON object of fields from stdin (flags win)")
}

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
and nothing is changed. Safe to run again.

Put the returned "id" into a node's error_on_false_message (BOOL_CONDITION),
error_message (USER_INTERACTION) or selector_error_message (selector nodes),
then save with \`workflows update\`. Saving links the code to the workflow.
Names, placeholders and free text are rejected on save.

Examples:
  $ cloudcruise error-codes create --code CLAIM_NOT_FOUND --description "Claim not found in the portal"
  $ printf '%s' '{"error_code":"PORTAL_DOWN","description":"Portal unavailable","error_action":"retry","retries":2}' | cloudcruise error-codes create --stdin`
    )
    .action(async (opts: ErrorCodeFieldOptions & { stdin?: boolean } & AuthOptions) => {
      try {
        const stdinBody = opts.stdin ? parseJsonObject(await readStdin()) : undefined
        const body = buildErrorCodeBody(opts, stdinBody)
        const client = new ApiClient(await resolveAuth(opts))
        outputJson(await client.post("/error-codes", body))
      } catch (err: unknown) {
        fail(err)
      }
    })

  // ── update ─────────────────────────────────────────────────────
  addAuthOptions(
    addFieldOptions(
      errorCodes
        .command("update <id>")
        .description("Update an error code's name, description or action")
    )
  )
    .addHelpText(
      "after",
      `
Only the fields you pass are changed. Renaming to a name another code already
uses is rejected (409).

Examples:
  $ cloudcruise error-codes update 7c1e... --description "Claim number not found"
  $ cloudcruise error-codes update 7c1e... --action retry --retries 2`
    )
    .action(
      async (
        id: string,
        opts: ErrorCodeFieldOptions & { stdin?: boolean } & AuthOptions
      ) => {
        try {
          const stdinBody = opts.stdin ? parseJsonObject(await readStdin()) : undefined
          const body = buildErrorCodeBody(opts, stdinBody)
          const client = new ApiClient(await resolveAuth(opts))
          outputJson(await client.patch(`/error-codes/${encodeURIComponent(id)}`, body))
        } catch (err: unknown) {
          fail(err)
        }
      }
    )
}
