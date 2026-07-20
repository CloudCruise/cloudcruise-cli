import { ApiClient } from "./api-client.js"
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
