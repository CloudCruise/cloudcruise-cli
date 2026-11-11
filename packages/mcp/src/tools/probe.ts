import type { McpServer } from "@modelcontextprotocol/server"
import * as z from "zod/v4"
import { errorResult } from "./common.js"

// Longer waits outlive client request timeouts: the MCP TS SDK gives up after
// 60 s, and Claude Code reports that as "The operation timed out".
export const MAX_POLL_SECONDS = 45
const HANDLE_PREFIX = "probe1."

export function registerProbes(server: McpServer): void {
  server.registerTool(
    "probe_long",
    {
      title: "Start a test job",
      description:
        "Start a fake job that finishes after duration_seconds. Returns a handle; pass it to probe_poll until the job is done.",
      inputSchema: z.object({
        duration_seconds: z.number().int().min(1).max(3600).default(120)
      }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ duration_seconds }) => {
      const handle = encodeHandle({ s: Date.now(), d: duration_seconds * 1000 })
      const out = { handle, duration_seconds }
      return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out }
    }
  )

  server.registerTool(
    "probe_poll",
    {
      title: "Wait for a test job",
      description:
        "Check a job started by probe_long. Pass timeout_seconds (30-45 for a normal poll) to wait up to that long, at most 45 s, for it to finish; omit it to check once and return at once. If the result says running, call probe_poll again with the same handle.",
      inputSchema: z.object({
        handle: z.string(),
        timeout_seconds: z.number().int().min(1).optional()
      }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ handle, timeout_seconds }, ctx) => {
      const job = decodeHandle(handle)
      if (!job) {
        return errorResult("Invalid handle. Pass the handle exactly as probe_long returned it.")
      }
      const doneAt = job.s + job.d
      if (timeout_seconds !== undefined) {
        const waitSeconds = Math.min(timeout_seconds, MAX_POLL_SECONDS)
        const waitMs = Math.min(doneAt - Date.now(), waitSeconds * 1000)
        if (waitMs > 0) {
          await sleep(waitMs, ctx.mcpReq.signal)
        }
      }
      const remainingMs = doneAt - Date.now()
      const out =
        remainingMs <= 0
          ? { status: "done" }
          : {
              status: "running",
              remaining_seconds: Math.ceil(remainingMs / 1000),
              next: "call probe_poll again with the same handle"
            }
      return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out }
    }
  )
}

interface ProbeJob {
  /** Start time, epoch ms. */
  s: number
  /** Duration, ms. */
  d: number
}

// The handle carries its own state so any replica can answer for it. Unsigned:
// a forged handle only changes the timing of the forger's own fake job.
function encodeHandle(job: ProbeJob): string {
  return HANDLE_PREFIX + Buffer.from(JSON.stringify(job)).toString("base64url")
}

function decodeHandle(handle: string): ProbeJob | undefined {
  if (!handle.startsWith(HANDLE_PREFIX)) return undefined
  try {
    const job = JSON.parse(
      Buffer.from(handle.slice(HANDLE_PREFIX.length), "base64url").toString("utf8")
    ) as Partial<ProbeJob>
    if (Number.isFinite(job.s) && Number.isFinite(job.d)) {
      return { s: job.s as number, d: job.d as number }
    }
  } catch {
    // Not base64url JSON.
  }
  return undefined
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
  })
}
