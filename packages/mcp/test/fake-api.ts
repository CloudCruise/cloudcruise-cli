// A stand-in for the CloudCruise API: serves a fixture spec at /openapi.json and
// canned workflows, runs and builder turns for the operations it tags.
import { readFileSync } from "node:fs"
import { createServer, type IncomingHttpHeaders, type Server } from "node:http"

export const LAUNCH_SPEC = new URL("../../core/test/fixtures/launch.openapi.json", import.meta.url)

/** Bearer tokens the fake accepts, and the API's answer to each one it refuses. */
const REFUSED: Record<string, [number, string]> = {
  expired: [401, "Invalid or expired token"],
  noprivs: [401, "Missing privileges"],
  mfa: [403, "MFA challenge required"]
}
export const GOOD_TOKEN = "good"

const INVOICE = "6f1d2c3a-0b4e-4c5d-9e8f-1a2b3c4d5e6f"
const PORTAL = "a7b8c9d0-1e2f-4a3b-8c4d-5e6f7a8b9c0d"
const ELIGIBILITY = "0c9b8a7d-6e5f-4d3c-b2a1-f0e9d8c7b6a5"

const WORKFLOWS = [
  { id: INVOICE, name: "Download supplier invoices", description: "Logs into the supplier portal and downloads this month's invoices", updated_at: "2026-11-05T14:02:11Z" },
  { id: PORTAL, name: "Update patient address", description: "Changes a patient's address in the EHR", updated_at: "2026-11-01T09:30:00Z" },
  { id: ELIGIBILITY, name: "Check insurance eligibility", description: null, updated_at: "2026-10-28T17:45:52Z" }
]

const RUNS = [
  { session_id: "run_8f2c", workflow_id: INVOICE, status: "execution.success", created_at: "2026-11-08T15:10:00Z", finished_at: "2026-11-08T15:12:41Z", data: { invoices: [{ number: "INV-2041", total: 1820.5 }, { number: "INV-2042", total: 311 }] }, error: null },
  { session_id: "run_7d1a", workflow_id: ELIGIBILITY, status: "execution.failed", created_at: "2026-11-08T13:01:00Z", finished_at: "2026-11-08T13:02:15Z", data: null, error: "Login failed: the portal asked for a one-time code" },
  { session_id: "run_6b9e", workflow_id: PORTAL, status: "execution.start", created_at: "2026-11-08T15:20:00Z", finished_at: null, data: null, error: null },
  { session_id: "run_5a3f", workflow_id: INVOICE, status: "execution.failed", created_at: "2026-11-07T10:00:00Z", finished_at: "2026-11-07T10:03:02Z", data: null, error: "Timed out waiting for the invoices table" }
]

export interface ApiRequest {
  method: string
  path: string
  headers: IncomingHttpHeaders
  body?: unknown
}

export interface FakeApi {
  server: Server
  requests: ApiRequest[]
  /** How many times /openapi.json was fetched. */
  specFetches: number
}

export function createFakeApi(spec: unknown = JSON.parse(readFileSync(LAUNCH_SPEC, "utf8"))): FakeApi {
  const api: FakeApi = { server: undefined as unknown as Server, requests: [], specFetches: 0 }
  api.server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake")
    const send = (status: number, value?: unknown) => {
      if (value === undefined) return res.writeHead(status).end()
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value))
    }

    if (url.pathname === "/openapi.json") {
      api.specFetches++
      return send(200, spec)
    }

    let raw = ""
    for await (const chunk of req) raw += chunk
    api.requests.push({ method: req.method ?? "GET", path: url.pathname + url.search, headers: req.headers, body: raw ? JSON.parse(raw) : undefined })

    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1]
    if (!token) return send(401, { statusCode: 401, message: "Missing Authorization header" })
    const refused = REFUSED[token]
    if (refused) return send(refused[0], { statusCode: refused[0], message: refused[1] })
    if (token !== GOOD_TOKEN) return send(401, { statusCode: 401, message: "Invalid or expired token" })

    const route = `${req.method} ${url.pathname}`
    let m: RegExpExecArray | null
    if (route === "GET /users/me") return send(200, { userId: "u1", email: "u1@example.test", workspaceId: "w1" })
    if (route === "GET /workflows") {
      const search = url.searchParams.get("search")?.toLowerCase()
      return send(200, WORKFLOWS.filter((w) => !search || w.name.toLowerCase().includes(search)))
    }
    if ((m = /^GET \/workflows\/([^/]+)$/.exec(route))) {
      const workflow = WORKFLOWS.find((w) => w.id === m![1])
      if (!workflow) return send(404, { statusCode: 404, message: "Workflow not found" })
      return send(200, { ...workflow, input_schema: { type: "object", properties: { month: { type: "string", description: "YYYY-MM" } } }, nodes: [], edges: [] })
    }
    if (route === "GET /runs") {
      const q = url.searchParams
      const limit = Number(q.get("limit") ?? 100)
      const runs = RUNS.filter((r) => (!q.get("status") || r.status === q.get("status")) && (!q.get("workflow_id") || r.workflow_id === q.get("workflow_id")))
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, limit)
        .map(({ data: _data, error: _error, ...summary }) => summary)
      return send(200, runs)
    }
    if ((m = /^GET \/run\/([^/]+)$/.exec(route))) {
      const run = RUNS.find((r) => r.session_id === m![1])
      return run ? send(200, run) : send(404, { statusCode: 404, message: "Run not found" })
    }
    if (route === "POST /run") {
      const body = api.requests.at(-1)?.body as { workflow_id?: unknown; run_input_variables?: unknown } | undefined
      if (typeof body?.workflow_id !== "string" || typeof body.run_input_variables !== "object") {
        return send(400, { statusCode: 400, message: ["workflow_id must be a UUID", "run_input_variables must be an object"] })
      }
      if (!WORKFLOWS.some((w) => w.id === body.workflow_id)) return send(404, { statusCode: 404, message: "Workflow not found" })
      // Recorded so runs.get and runs.list find it; it stays queued.
      const session_id = `run_${(RUNS.length + 1).toString(16).padStart(4, "0")}`
      RUNS.push({ session_id, workflow_id: body.workflow_id, status: "execution.queued", created_at: new Date().toISOString(), finished_at: null, data: null, error: null })
      return send(202, { session_id })
    }
    if ((m = /^POST \/builder\/sessions\/([^/]+)\/messages$/.exec(route))) return send(202)
    if ((m = /^GET \/builder\/sessions\/([^/]+)\/turn$/.exec(route))) {
      return send(200, { state: "waiting_for_user", messages: ["Added a login step. Which credential should it use?"] })
    }
    send(404, { statusCode: 404, message: `Cannot ${req.method} ${url.pathname}` })
  })
  return api
}
