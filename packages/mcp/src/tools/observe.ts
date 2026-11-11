import type { StrataClient } from "@cloudcruise/strata"
import type { McpServer } from "@modelcontextprotocol/server"
import * as z from "zod/v4"
import { apiFailure, client, clientName, errorResult, parseHandle, sleep, type ToolContext } from "./common.js"

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
      title: "Follow a run",
      description:
        "Follow a run started with run. Without after, returns the run's current state at once. With after (pass the after value from the last result), waits until something changes, then returns what changed. If nothing changes before the wait ends, or the call is cut off, call observe again with the same handle and after.",
      inputSchema: z.object({
        handle: z.string().describe("The handle run returned"),
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
      if (!ref) return errorResult("Invalid handle. Pass the handle exactly as run returned it.")
      let cursor = after === undefined ? undefined : parseCursor(after)
      const cap = timing.capMs(clientName(ctx))
      const waitMs = timeout_seconds === undefined ? cap : Math.min(timeout_seconds * 1000, cap)
      let run: Run
      try {
        run = await readRun(client(tool, ctx, ref.workspaceId), ref.id, cursor, waitMs, timing.delaysMs, ctx.mcpReq.signal)
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
      return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out }
    }
  )
}

// Reads the run until it differs from the cursor or waitMs passes. Without a cursor it
// reads once. The signature is the one an API-side wait would take.
async function readRun(
  api: StrataClient,
  id: string,
  cursor: Cursor | undefined,
  waitMs: number,
  delaysMs: number[],
  signal: AbortSignal
): Promise<Run> {
  const deadline = Date.now() + waitMs
  let run = await api.get<Run>(`/run/${id}`)
  for (let i = 0; cursor && !changed(run, cursor); i++) {
    const left = deadline - Date.now()
    if (left <= 0) break
    await sleep(Math.min(delaysMs[Math.min(i, delaysMs.length - 1)], left), signal)
    if (signal.aborted) break
    try {
      run = await api.get<Run>(`/run/${id}`)
    } catch {
      // The last good read still answers the call; the next call reads again.
      break
    }
  }
  return run
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
