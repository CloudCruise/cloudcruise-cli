import { ApiError, type StrataClient } from "@cloudcruise/strata"
import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server"
import * as z from "zod/v4"
import { apiFailure, client, errorResult, formatHandle, structured, workspaceIdInput, type ToolContext } from "./common.js"
import { GONE, builderPath, formatTurnCursor, isGone, successorOf, turnCursor, type TurnState } from "./turn.js"

/** How often build reports progress while the builder browser starts; tests pass a shorter one. */
export interface BuildTiming {
  progressMs: number
}

export const BUILD_TIMING: BuildTiming = { progressMs: 10_000 }

const input = z.object({
  workspace_id: workspaceIdInput,
  conversation_id: z.guid().optional().describe("The conversation to continue. Omit to start a new one."),
  message: z.string().min(1).optional().describe("What to tell the builder"),
  responses: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Answers to the builder's question, keyed by field name as observe returned them. For a credential field, pass { permissioned_user_id, domain } of a vault entry."
    ),
  workflow_id: z.guid().optional().describe("Start from this workflow instead of a blank one"),
  name: z.string().min(1).optional().describe("Name for a new workflow"),
  start_url: z.url().optional().describe("Where a new workflow starts")
})

type Input = z.infer<typeof input>

export function registerBuild(server: McpServer, tool: ToolContext, timing: BuildTiming = BUILD_TIMING): void {
  server.registerTool(
    "build",
    {
      title: "Build a workflow",
      description:
        "Send a message to the CloudCruise workflow builder agent, starting a new builder conversation or continuing one, or answer its question. The builder works in a live browser and edits the workflow. Returns a handle; to follow the turn, use observe.",
      inputSchema: input,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      _meta: { "anthropic/alwaysLoad": true }
    },
    async (args, ctx) => {
      const problem = checkInput(args)
      if (problem) return errorResult(problem)
      const api = client(tool, ctx, args.workspace_id)
      const handle = (id: string) => formatHandle({ kind: "turn", workspaceId: args.workspace_id, id })
      try {
        let id = args.conversation_id ?? (await start(api, args, ctx, timing))
        if (!id) return errorResult("The CloudCruise API started no builder conversation: its reply had no conversation id.")
        let cleared = false
        // The writes return once the turn reads as processing, naming the open turn, so the
        // cursor comes from their replies; no read follows that could fail after the turn started.
        let turnId: string | undefined
        if (args.responses) {
          const answered = await answer(api, id, args.responses)
          if ("refused" in answered) return answered.refused
          turnId = answered.turnId
        } else {
          let sent: string | undefined
          try {
            sent = await send(api, id, args.message!)
          } catch (err) {
            // A new conversation exists now: hand back its handle so a retry doesn't start another.
            if (!args.conversation_id) return keptHandle(handle(id), "The conversation started, but the message failed", id, err)
            // As the CLI's send does: a cleared conversation's message belongs to the one it continues as.
            const successor = successorOf(err)
            if (!successor) throw err
            try {
              sent = await send(api, successor, args.message!)
            } catch (err) {
              return keptHandle(handle(successor), "The conversation was cleared and continues as a new one, but the message failed", successor, err)
            }
            id = successor
            cleared = true
          }
          turnId = sent
        }
        const out: Record<string, unknown> = { handle: handle(id) }
        if (turnId) {
          out.after = formatTurnCursor(turnCursor({ phase: "processing", turnId }))
          out.next = "To follow the turn, call observe with this handle and after."
        } else {
          out.next = "To follow the turn, call observe with this handle, without after."
        }
        if (cleared) {
          out.conversation_cleared = true
          out.statusMessage = "That conversation was cleared; the message went to the one it continues as, which this handle names."
        }
        return structured(out)
      } catch (err) {
        return failure(err)
      }
    }
  )
}

function checkInput(args: Input): string | undefined {
  if ((args.message === undefined) === (args.responses === undefined)) {
    return "Pass either message or responses, not both and not neither."
  }
  if (args.conversation_id) {
    if (args.workflow_id || args.name || args.start_url) {
      return "workflow_id, name and start_url start a new conversation; omit them when continuing one with conversation_id."
    }
    return undefined
  }
  if (args.responses) return "responses answer a question in an existing conversation: pass its conversation_id."
  if (args.workflow_id) {
    if (args.name || args.start_url) return "Starting from workflow_id takes the workflow's own name and start URL; omit name and start_url."
    return undefined
  }
  if (!args.name || !args.start_url) {
    return "A new conversation needs name and start_url, or workflow_id to start from an existing workflow."
  }
  return undefined
}

// The API returns only once the builder browser is up, which can take about a minute.
// A progress notification opens the response as a stream, so clients that drop a call
// silent for 60 s keep this one; the later ones keep it from looking idle.
async function start(api: StrataClient, args: Input, ctx: ServerContext, timing: BuildTiming): Promise<string | undefined> {
  const started = args.workflow_id
    ? api.post<{ conversationId?: unknown }>("/workflow-builder/agent/session/from-workflow", {
        workflowId: args.workflow_id,
        // Empty template inputs leave the builder's selectors with nothing to match.
        useExampleInputs: true
      })
    : api.post<{ conversationId?: unknown }>("/workflow-builder/agent/session", { name: args.name, startUrl: args.start_url })
  const progressToken = ctx.mcpReq._meta?.progressToken
  let timer: ReturnType<typeof setInterval> | undefined
  if (progressToken !== undefined) {
    let progress = 0
    const report = () =>
      void ctx.mcpReq
        .notify({
          method: "notifications/progress",
          params: { progressToken, progress: progress++, message: "Starting the builder browser" }
        })
        .catch(() => {})
    report()
    timer = setInterval(report, timing.progressMs)
  }
  try {
    // Only the id is read: the reply also carries the live browser's viewer token.
    const { conversationId } = await started
    return typeof conversationId === "string" && conversationId ? conversationId : undefined
  } finally {
    clearInterval(timer)
  }
}

// /message and /respond name the open turn: the new one, or the one an answer continues.
// An API that predates the field names none, and the caller observes without after.
function openTurn(reply: { turnId?: unknown } | undefined): string | undefined {
  return typeof reply?.turnId === "string" && reply.turnId ? reply.turnId : undefined
}

/** Sends a message; returns the open turn's id. */
async function send(api: StrataClient, id: string, text: string): Promise<string | undefined> {
  return openTurn(await api.post<{ turnId?: unknown }>(builderPath(id, "message"), { text }))
}

async function answer(
  api: StrataClient,
  id: string,
  responses: Record<string, unknown>
): Promise<{ refused: CallToolResult } | { turnId?: string }> {
  let state: TurnState
  try {
    state = await api.get<TurnState>(builderPath(id, "turn-state"))
  } catch (err) {
    if (!isGone(err)) throw err
    const successor = successorOf(err)
    return {
      refused: errorResult(
        successor
          ? `This conversation was cleared and continues as ${successor}. Its question belonged to the old one: send a message to ${successor} with build instead.`
          : `${GONE} Start a new one with build.`
      )
    }
  }
  if (state.phase !== "awaiting-human-input" || !state.humanInput) {
    return { refused: errorResult("The builder isn't waiting on a question; send a message instead.") }
  }
  const reply = await api.post<{ turnId?: unknown }>(builderPath(id, "respond"), { messageId: state.humanInput.messageId, responses })
  return { turnId: openTurn(reply) }
}

// The conversation exists but the message didn't reach it: an error that still carries the handle.
function keptHandle(handle: string, what: string, id: string, err: unknown): CallToolResult {
  const reason = failure(err).content.map((c) => (c.type === "text" ? c.text : "")).join(" ")
  const out = { handle, next: `Send the message again with build and conversation_id ${id}.` }
  return {
    isError: true,
    content: [{ type: "text", text: `${what}: ${reason} ${out.next} ${JSON.stringify(out)}` }],
    structuredContent: out
  }
}

function failure(err: unknown): CallToolResult {
  if (err instanceof ApiError) {
    if (err.code === "SESSION_BUSY") {
      return errorResult("The builder is still working on the last message. Follow it with observe, then send again.")
    }
    if (err.code === "ALREADY_ANSWERED") return errorResult("That question was already answered.")
    if (isGone(err)) return errorResult(`${GONE} Start a new one with build.`)
  }
  return apiFailure(err)
}
