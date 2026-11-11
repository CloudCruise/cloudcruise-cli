import type { StrataClient } from "@cloudcruise/strata"
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server"
import * as z from "zod/v4"
import {
  apiFailure,
  client,
  clientName,
  errorResult,
  parseHandle,
  structured,
  waitForChange,
  type Handle,
  type ToolContext,
  type Wait
} from "./common.js"
import {
  GONE,
  formatTurnCursor,
  isGone,
  parseTurnCursor,
  readTurn,
  successorOf,
  turnCursor,
  type Phase,
  type TurnCursor,
  type TurnState
} from "./turn.js"

/** How observe paces its reads; tests pass shorter ones. */
export interface ObserveTiming {
  /** Gaps between reads while waiting; the last one repeats. */
  delaysMs: number[]
  /** The longest a client lets a call run silent, by its clientInfo name. */
  capMs: (client: string | undefined) => number
}

export const OBSERVE_TIMING: ObserveTiming = { delaysMs: [1000, 2000, 5000, 10_000], capMs: waitCapMs }

// Each client gives up on a silent call at its own limit. Claude Code fails an HTTP
// call with no response byte for 60 s; Claude.ai documents 240 s per tool call.
// Everyone else, ChatGPT and clients without a name included, gets 45 s, under the
// TS SDK's 60 s. The Claude.ai pattern is a guess until its clientInfo name is seen live.
export function waitCapMs(client: string | undefined): number {
  const name = client?.toLowerCase() ?? ""
  if (name.includes("claude-code")) return 50_000
  if (name.includes("claude") || name.includes("anthropic")) return 200_000
  return 45_000
}

/** The fields of runs.get that observe reads. */
interface Run {
  status: string
  session_retries?: number | null
  finalized_at?: string | null
  data?: unknown
  errors?: { message?: string; error_code?: string | null }[]
}

/** What the caller last saw: the v1 cursor `r<retries>.<status>`. */
interface Cursor {
  retries: number
  status: string
}

const CURSOR = /^r(\d+)\.([a-z_]+)$/

export function registerObserve(server: McpServer, tool: ToolContext, timing: ObserveTiming = OBSERVE_TIMING): void {
  server.registerTool(
    "observe",
    {
      title: "Follow a run or builder turn",
      description:
        "Follow a run started with run, or a builder turn started with build. Without after, returns the current state at once. With after (pass the after value from the last result), waits until something changes, then returns what changed. If nothing changes before the wait ends, or the call is cut off, call observe again with the same handle and after.",
      inputSchema: z.object({
        handle: z.string().describe("The handle run or build returned"),
        after: z.string().optional().describe("The after value from the last result"),
        timeout_seconds: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("How long to wait for a change; the default suits your client")
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { "anthropic/alwaysLoad": true }
    },
    async ({ handle, after, timeout_seconds }, ctx) => {
      const ref = parseHandle(handle)
      if (!ref) return errorResult("Invalid handle. Pass the handle exactly as run or build returned it.")
      const cap = timing.capMs(clientName(ctx))
      const waitMs = timeout_seconds === undefined ? cap : Math.min(timeout_seconds * 1000, cap)
      const api = client(tool, ctx, ref.workspaceId)
      const wait = { waitMs, delaysMs: timing.delaysMs, signal: ctx.mcpReq.signal }
      return ref.kind === "run" ? observeRun(api, ref, after, wait) : observeTurn(api, ref, after, wait)
    }
  )
}

async function observeRun(api: StrataClient, ref: Handle, after: string | undefined, wait: Wait): Promise<CallToolResult> {
  let cursor = after === undefined ? undefined : parseCursor(after)
  let run: Run
  try {
    run = await readRun(api, ref.id, cursor, wait)
  } catch (err) {
    return apiFailure(err)
  }
  // A cursor ahead of the run (only after a staff rollback) describes nothing it can compare.
  if (cursor && cursor.retries > retries(run)) cursor = undefined
  const done = !!run.finalized_at
  const out: Record<string, unknown> = {
    status: run.status,
    statusMessage: statusMessage(run, cursor),
    attempt: retries(run) + 1,
    done,
    after: formatCursor(run)
  }
  // An after that can't be read is treated as none, so the caller sees the current state.
  if (after !== undefined && !cursor) out.history_reset = true
  if (done) {
    out.data = run.data ?? null
    if (run.status !== "execution.success") {
      out.errors = (run.errors ?? []).map((e) => ({ message: e.message ?? null, code: e.error_code ?? null }))
    }
  } else {
    out.next = "Call observe again with the same handle and this after value."
  }
  return structured(out)
}

async function observeTurn(api: StrataClient, ref: Handle, after: string | undefined, wait: Wait): Promise<CallToolResult> {
  const cursor = after === undefined ? undefined : parseTurnCursor(after)
  let state: TurnState
  try {
    state = await readTurn(api, ref.id, cursor, wait)
  } catch (err) {
    if (isGone(err)) return structured(gone(successorOf(err)))
    return apiFailure(err)
  }
  const now = turnCursor(state)
  const out: Record<string, unknown> = {
    status: state.phase,
    statusMessage: turnMessage(now, cursor),
    done: state.phase !== "processing",
    after: formatTurnCursor(now)
  }
  if (after !== undefined && !cursor) out.history_reset = true
  if (state.phase === "completed" && state.report) out.report = state.report
  const fields = state.phase === "awaiting-human-input" ? (state.humanInput?.fields ?? []) : []
  if (state.phase === "awaiting-human-input" && state.humanInput) {
    out.question = {
      prompt: state.humanInput.prompt ?? null,
      // A secret never travels through the model: the user types it into the dashboard.
      fields: fields.map((f) => (f.type === "secret" ? { ...f, enter_in_dashboard: true } : f))
    }
  }
  out.next = NEXT[state.phase] ?? NEXT.idle
  if (fields.some((f) => f.type === "secret")) {
    out.next = `${out.next} Ask the user to enter each field marked enter_in_dashboard in the CloudCruise dashboard; don't send it yourself.`
  }
  return structured(out)
}

const NEXT: Record<Phase, string> = {
  processing: "Call observe again with the same handle and this after value.",
  "awaiting-human-input": "Answer with build (conversation_id and responses, or a message), then observe again.",
  completed: "Send the next message with build.",
  "agent-errored": "Send the next message with build.",
  idle: "Send the next message with build.",
  ended: "This conversation has ended. Start a new one with build."
}

const PHASE: Record<Phase, string> = {
  processing: "working on it",
  "awaiting-human-input": "waiting for an answer to its question",
  completed: "finished the turn",
  "agent-errored": "stopped on an error",
  idle: "idle, waiting for a message",
  ended: "ended"
}

// Cursors carry the phase as a string: one from an older server may name a phase this one doesn't.
function describe(phase: string): string {
  return (PHASE as Record<string, string>)[phase] ?? phase
}

function turnMessage(now: TurnCursor, cursor: TurnCursor | undefined): string {
  const phase = describe(now.phase)
  if (!cursor) return `The builder is ${phase}.`
  if (now.turn !== cursor.turn) return `A new turn started since your last call; the builder is ${phase}.`
  if (now.phase !== cursor.phase) return `Was ${describe(cursor.phase)}, now ${phase}.`
  if (now.question !== cursor.question) return "The builder asked another question."
  return `No change since your last call; the builder is still ${phase}.`
}

// A cleared or restarted conversation doesn't come back; the handle names it alone.
function gone(successor: string | undefined): Record<string, unknown> {
  if (!successor) {
    return {
      status: "ended",
      statusMessage: GONE,
      done: true,
      next: "Start a new conversation with build."
    }
  }
  return {
    status: "ended",
    statusMessage: "This conversation was cleared and continues as a new one.",
    done: true,
    successor_conversation_id: successor,
    next: "To continue, send the next message with build and this successor_conversation_id as conversation_id."
  }
}

// Reads the run until it differs from the cursor or the wait ends. Without a cursor it
// reads once. The signature is the one an API-side wait would take.
function readRun(api: StrataClient, id: string, cursor: Cursor | undefined, wait: Wait): Promise<Run> {
  return waitForChange(
    () => api.get<Run>(`/run/${id}`),
    (run) => !cursor || changed(run, cursor),
    wait
  )
}

// A requeue between two reads shows as the retry count rising, even when both read `start`.
function changed(run: Run, cursor: Cursor): boolean {
  return !!run.finalized_at || retries(run) !== cursor.retries || state(run.status) !== cursor.status
}

function statusMessage(run: Run, cursor: Cursor | undefined): string {
  const now = state(run.status)
  const attempt = retries(run) + 1
  if (run.finalized_at) return `Finished: ${now} (attempt ${attempt}).`
  let line: string
  const requeues = cursor ? retries(run) - cursor.retries : 0
  if (!cursor) line = `Currently ${now} (attempt ${attempt}).`
  else if (requeues > 0) {
    line = `Requeued ${requeues === 1 ? "once" : `${requeues} times`} since your last call: the run hit an error it can retry (attempt ${attempt}); now ${now}.`
  } else if (now !== cursor.status) line = `Was ${cursor.status}, now ${now}.`
  else line = `No change since your last call; still ${now}.`
  if (now === "failed") line += " It may still be retried."
  if (now === "paused") line += " It continues when its runs are resumed."
  return line
}

function parseCursor(after: string): Cursor | undefined {
  const match = CURSOR.exec(after)
  return match ? { retries: Number(match[1]), status: match[2] } : undefined
}

function formatCursor(run: Run): string {
  return `r${retries(run)}.${state(run.status)}`
}

function retries(run: Run): number {
  return run.session_retries ?? 0
}

function state(status: string): string {
  return status.replace(/^execution\./, "")
}
