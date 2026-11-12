import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildUnpauseRequests, summarizePausedResources } from "../dist/src/commands/run.js"

const pausedResponse = {
  pausedWorkflows: {
    "dispatcher:pause:workflow:ws_1:wf_retired": {
      paused_at: Date.UTC(2026, 10, 12, 23, 41, 34),
      paused_by_user_id: "error_code",
      reason: "Paused because the target service is retired",
      source: "manual"
    },
    "dispatcher:pause:workflow:ws_1:wf_window": {
      paused_at: Date.UTC(2026, 10, 12, 23, 0, 0),
      reason: "Outside run window",
      source: "run_window",
      resumes_at: Date.UTC(2026, 10, 13, 13, 0, 0)
    }
  },
  pausedCredentials: {
    "dispatcher:pause:credential:ws_1:billing-bot:portal.example.com:8443": {
      paused_at: Date.UTC(2026, 10, 12, 23, 40, 44),
      reason: "Paused because the site says the account is locked",
      source: "manual"
    }
  }
}

async function startPauseBackend() {
  const requests: { method?: string; url?: string; body: unknown }[] = []
  const server = createServer((req, res) => {
    let raw = ""
    req.on("data", (chunk) => (raw += chunk))
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : undefined })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(req.url === "/runs/paused" ? pausedResponse : { success: true, resumedRuns: 1 }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${port}`, requests, server }
}

function runCli(args: string[], env: Record<string, string | undefined>) {
  const home = mkdtempSync(join(tmpdir(), "cloudcruise-test-"))
  const child = spawn(process.execPath, ["dist/bin/cloudcruise.js", ...args], {
    env: { ...process.env, HOME: home, ...env }
  })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => (stdout += chunk))
  child.stderr.on("data", (chunk) => (stderr += chunk))
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) =>
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  )
}

test("summarizePausedResources turns the Redis keys into workflow ids and the credential_id that run unpause accepts, keeping a domain with a port intact", () => {
  const summary = summarizePausedResources(pausedResponse)
  assert.deepEqual(summary.credentials, [
    {
      credential_id: "ws_1:billing-bot:portal.example.com:8443",
      workspace_id: "ws_1",
      permissioned_user_id: "billing-bot",
      domain: "portal.example.com:8443",
      reason: "Paused because the site says the account is locked",
      paused_at: "2026-11-12T23:40:44.000Z"
    }
  ])
  assert.deepEqual(
    summary.workflows.map((w) => [w.workflow_id, w.source, w.reason]),
    [
      ["wf_retired", "manual", "Paused because the target service is retired"],
      ["wf_window", "run_window", "Outside run window"]
    ]
  )
})

test("summarizePausedResources reports when a run-window hold resumes, because unpausing does not lift it", () => {
  const window = summarizePausedResources(pausedResponse).workflows.find((w) => w.workflow_id === "wf_window")
  assert.equal(window?.resumes_at, "2026-11-13T13:00:00.000Z")
})

test("summarizePausedResources returns empty lists when nothing is paused", () => {
  assert.deepEqual(summarizePausedResources({ pausedWorkflows: {}, pausedCredentials: {} }), {
    workflows: [],
    credentials: []
  })
})

test("buildUnpauseRequests sends one unpause per resource kind, since the API unpauses one kind per call", () => {
  assert.deepEqual(
    buildUnpauseRequests({ workflow: ["wf_1", "wf_2"], credential: ["ws_1:billing-bot:portal.example.com"] }),
    [
      { path: "/runs/unpause", body: { pause_resource: "workflow", resource_ids: ["wf_1", "wf_2"] } },
      {
        path: "/runs/unpause",
        body: { pause_resource: "credential", resource_ids: ["ws_1:billing-bot:portal.example.com"] }
      }
    ]
  )
})

test("buildUnpauseRequests uses unpause-all for --all", () => {
  assert.deepEqual(buildUnpauseRequests({ all: true }), [{ path: "/runs/unpause-all", body: {} }])
})

test("buildUnpauseRequests refuses a call that names nothing, --all mixed with ids, and a credential that is not a credential_id, so nothing is unpaused by mistake", () => {
  assert.throws(() => buildUnpauseRequests({}), /Pass --workflow/)
  assert.throws(() => buildUnpauseRequests({ all: true, workflow: ["wf_1"] }), /do not combine/)
  assert.throws(() => buildUnpauseRequests({ credential: ["billing-bot"] }), /Invalid --credential/)
})

test("run paused calls GET /runs/paused and prints the summarized lists through the real command", async () => {
  const backend = await startPauseBackend()
  try {
    const result = await runCli(["run", "paused", "--base-url", backend.baseUrl], { CLOUDCRUISE_API_KEY: "test_key" })
    assert.equal(result.code, 0)
    assert.deepEqual(backend.requests.map((r) => `${r.method} ${r.url}`), ["GET /runs/paused"])
    const printed = JSON.parse(result.stdout)
    assert.equal(printed.credentials[0].credential_id, "ws_1:billing-bot:portal.example.com:8443")
    assert.equal(printed.workflows.length, 2)
  } finally {
    backend.server.close()
  }
})

test("run unpause --workflow and --credential post one unpause each through the real command", async () => {
  const backend = await startPauseBackend()
  try {
    const result = await runCli(
      [
        "run",
        "unpause",
        "--workflow",
        "wf_retired",
        "--credential",
        "ws_1:billing-bot:portal.example.com:8443",
        "--base-url",
        backend.baseUrl
      ],
      { CLOUDCRUISE_API_KEY: "test_key" }
    )
    assert.equal(result.code, 0)
    assert.deepEqual(
      backend.requests.map((r) => [r.method, r.url, r.body]),
      [
        ["POST", "/runs/unpause", { pause_resource: "workflow", resource_ids: ["wf_retired"] }],
        [
          "POST",
          "/runs/unpause",
          { pause_resource: "credential", resource_ids: ["ws_1:billing-bot:portal.example.com:8443"] }
        ]
      ]
    )
  } finally {
    backend.server.close()
  }
})

test("run unpause with nothing to unpause exits 2 without credentials and sends no request", async () => {
  const backend = await startPauseBackend()
  try {
    const result = await runCli(["run", "unpause", "--base-url", backend.baseUrl], { CLOUDCRUISE_API_KEY: undefined })
    assert.equal(result.code, 2)
    assert.match(result.stderr, /Pass --workflow/)
    assert.deepEqual(backend.requests, [])
  } finally {
    backend.server.close()
  }
})
