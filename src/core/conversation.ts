import { ApiClient, ApiError } from "./api-client.js"
import { AmbiguousSessionError, UsageError } from "./exit.js"

/** Roster route on the workflow-builder agent. Kept in sync with builder.ts BASE. */
const ROSTER_PATH = "/workflow-builder/agent/sessions"

export type ResolutionSource = "flag" | "env" | "roster"

/** One entry in the server roster (GET sessions). The server is the single
 * source of truth for which conversations exist and are live; the CLI keeps no
 * local conversation store. */
export interface RosterEntry {
  conversationId: string
  previousConversationIds?: string[]
  workflowId?: string
  status: string
  startedAt: number
  title?: string
  workspaceId: string
}

export interface ResolvedConversation {
  conversationId: string
  source: ResolutionSource
}

async function fetchRoster(client: ApiClient): Promise<RosterEntry[]> {
  const { sessions } = await client.get<{ sessions: RosterEntry[] }>(ROSTER_PATH)
  return sessions
}

function scopeToWorkspace(
  roster: RosterEntry[],
  workspaceId: string | undefined
): RosterEntry[] {
  return workspaceId
    ? roster.filter((s) => s.workspaceId === workspaceId)
    : roster
}

/**
 * Resolve the conversation a command acts on, per the locked resolution order:
 *   --conversation > CLOUDCRUISE_CONVERSATION > roster (sole-survivor).
 *
 * Explicit ids skip the roster entirely and overrule workspace scope (the
 * backend still authorizes via RLS). The implicit path fetches the server
 * roster, scopes it to the active workspace, and succeeds only when exactly one
 * live conversation is in scope — >1 forces the caller to pass --conversation
 * rather than silently picking newest (neutralizes the cross-client default
 * footgun).
 */
export async function resolveConversation(
  client: ApiClient,
  opts: { conversation?: string },
  workspaceId: string | undefined
): Promise<ResolvedConversation> {
  if (opts.conversation) {
    return { conversationId: opts.conversation, source: "flag" }
  }
  const envId = process.env.CLOUDCRUISE_CONVERSATION
  if (envId) {
    return { conversationId: envId, source: "env" }
  }

  const scope = scopeToWorkspace(await fetchRoster(client), workspaceId)

  if (scope.length === 0) {
    throw new UsageError(
      "No active conversation for this workspace. Start one with " +
        "'cloudcruise builder start', or pass --conversation."
    )
  }
  if (scope.length > 1) {
    throw new AmbiguousSessionError(
      "Multiple active conversations in scope; pass --conversation (or set " +
        "CLOUDCRUISE_CONVERSATION).",
      scope.map((s) => ({
        conversationId: s.conversationId,
        title: s.title,
        startedAt: new Date(s.startedAt).toISOString()
      }))
    )
  }
  return { conversationId: scope[0].conversationId, source: "roster" }
}

/** The live successor the backend attached to a gone-conversation 404, if any. */
function successorFromError(err: ApiError): string | undefined {
  try {
    const body = JSON.parse(err.body) as { successorConversationId?: unknown }
    return typeof body.successorConversationId === "string"
      ? body.successorConversationId
      : undefined
  } catch {
    return undefined
  }
}

/** Fallback when the backend didn't enrich the 404: one roster scan matching
 * the dead id against previousConversationIds (full ancestry, so the tip at any
 * chain depth). */
async function successorFromRoster(
  client: ApiClient,
  deadId: string,
  workspaceId: string | undefined
): Promise<string | undefined> {
  const scope = scopeToWorkspace(await fetchRoster(client), workspaceId)
  return scope.find((s) => s.previousConversationIds?.includes(deadId))
    ?.conversationId
}

export interface Reconciled<T> {
  result: T
  /** The conversation actually acted on — the chain tip after any follow. */
  conversationId: string
  /** Present only when a follow happened; the dead id the caller held. */
  reconciledFrom?: string
}

/**
 * Run an action against a conversation, auto-following a cleared/restarted
 * conversation to its live chain tip when the command is eligible (§5 matrix).
 *
 * A held id that was cleared/restarted 404s with CONVERSATION_NOT_FOUND. For
 * eligible reads/send/save we follow the successor (from the enriched 404, or a
 * roster fallback) and retry, reporting reconciledFrom. For ineligible commands
 * (respond/interrupt/end) we surface the successor on stderr and re-throw so the
 * caller never acts on the wrong turn — following `end` would destroy the live
 * successor. Whole-chain-dead (no successor) always re-throws -> exit 4.
 */
export async function withAutoFollow<T>(
  client: ApiClient,
  conversationId: string,
  eligible: boolean,
  workspaceId: string | undefined,
  action: (id: string) => Promise<T>
): Promise<Reconciled<T>> {
  try {
    return { result: await action(conversationId), conversationId }
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== "CONVERSATION_NOT_FOUND") {
      throw err
    }
    const successor =
      successorFromError(err) ??
      (await successorFromRoster(client, conversationId, workspaceId))
    if (!successor) throw err

    if (!eligible) {
      process.stderr.write(
        `conversation ${conversationId} was cleared; live successor ` +
          `${successor}. Re-run with --conversation ${successor} if intended.\n`
      )
      throw err
    }

    process.stderr.write(
      `reconciled ${conversationId} → ${successor} (${conversationId} was cleared)\n`
    )
    return {
      result: await action(successor),
      conversationId: successor,
      reconciledFrom: conversationId
    }
  }
}

/** Merge the reconcile fields onto a command's output object: the tip as
 * `conversationId`, and `reconciledFrom` when a follow happened. */
export function withReconcileFields(
  result: object,
  r: Reconciled<unknown>
): Record<string, unknown> {
  return {
    ...(result as Record<string, unknown>),
    conversationId: r.conversationId,
    ...(r.reconciledFrom ? { reconciledFrom: r.reconciledFrom } : {})
  }
}
