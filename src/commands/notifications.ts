import { Command } from "commander"
import { resolveAuth } from "../core/auth.js"
import { ApiClient } from "../core/api-client.js"
import { addAuthOptions, type AuthOptions } from "../core/auth-options.js"
import { outputError, outputJson } from "../core/output.js"

const RUN_NOTIFICATION_EVENTS = [
  "run.started",
  "run.succeeded",
  "run.failed",
  "run.requeued",
  "run.maintenance_triggered"
] as const

function parseEvents(raw: string): string[] {
  if (raw === "all") {
    return [...RUN_NOTIFICATION_EVENTS]
  }
  const events = raw
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean)
  const invalid = events.filter(
    (e) => !RUN_NOTIFICATION_EVENTS.includes(e as never)
  )
  if (events.length === 0 || invalid.length > 0) {
    throw new Error(
      `Invalid events: ${invalid.join(", ") || "(none provided)"}. Valid events: ${RUN_NOTIFICATION_EVENTS.join(", ")} (or "all")`
    )
  }
  return [...new Set(events)]
}

interface ScopeOptions {
  workspace?: string
  workflows?: string
}

function parseScope(
  opts: ScopeOptions
): { workspace_id: string } | { workflow_ids: string[] } {
  if (Boolean(opts.workspace) === Boolean(opts.workflows)) {
    throw new Error("Provide exactly one of --workspace or --workflows")
  }
  if (opts.workspace) {
    return { workspace_id: opts.workspace }
  }
  const ids = (opts.workflows as string)
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
  if (ids.length === 0) {
    throw new Error("--workflows requires at least one workflow ID")
  }
  return { workflow_ids: [...new Set(ids)] }
}

export function registerNotificationCommands(program: Command): void {
  const notifications = program
    .command("notifications")
    .description(
      "Manage Slack run-notification subscriptions (admin API key required)"
    )

  addAuthOptions(
    notifications
      .command("list")
      .description("List your run-notification subscriptions")
      .option("--all", "List subscriptions for all users")
  ).action(async (opts: { all?: boolean } & AuthOptions) => {
    try {
      const auth = await resolveAuth(opts)
      const client = new ApiClient(auth)
      const path = opts.all
        ? "/notifications/run-subscriptions?all=true"
        : "/notifications/run-subscriptions"
      outputJson(await client.get(path))
    } catch (err: unknown) {
      outputError(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
  })

  addAuthOptions(
    notifications
      .command("subscribe")
      .description(
        "Subscribe to Slack pings for runs in a workspace or specific workflows"
      )
      .requiredOption(
        "--events <events>",
        `Comma-separated events (${RUN_NOTIFICATION_EVENTS.join(", ")}) or "all"`
      )
      .option("--workspace <id>", "Subscribe to all runs in this workspace")
      .option(
        "--workflows <ids>",
        "Comma-separated workflow IDs to subscribe to"
      )
  ).action(async (opts: { events: string } & ScopeOptions & AuthOptions) => {
    try {
      const auth = await resolveAuth(opts)
      const client = new ApiClient(auth)
      const result = await client.post("/notifications/run-subscriptions", {
        ...parseScope(opts),
        events: parseEvents(opts.events)
      })
      outputJson(result)
    } catch (err: unknown) {
      outputError(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
  })

  addAuthOptions(
    notifications
      .command("unsubscribe")
      .description("Remove run-notification subscriptions")
      .option(
        "--workspace <id>",
        "Remove the workspace-wide subscription for this workspace"
      )
      .option(
        "--workflows <ids>",
        "Comma-separated workflow IDs to unsubscribe from"
      )
  ).action(async (opts: ScopeOptions & AuthOptions) => {
    try {
      const auth = await resolveAuth(opts)
      const client = new ApiClient(auth)
      const result = await client.delete(
        "/notifications/run-subscriptions",
        parseScope(opts)
      )
      outputJson(result)
    } catch (err: unknown) {
      outputError(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
  })
}
