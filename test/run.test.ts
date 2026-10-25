import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildRunNetworkPath,
  buildRunStartBody,
  omittedBodiesWarning,
  summarizeRunNetwork
} from "../dist/src/commands/run.js"

test("buildRunStartBody omits notifications by default", () => {
  const body = buildRunStartBody("wf_1", {}, {})
  assert.equal("notifications" in body, false)
})

test("buildRunStartBody sends notifications disabled with --no-notifications", () => {
  const body = buildRunStartBody("wf_1", {}, { notifications: false })
  assert.deepEqual(body.notifications, { enabled: false })
})

test("buildRunStartBody omits notifications when explicitly true", () => {
  const body = buildRunStartBody("wf_1", {}, { notifications: true })
  assert.equal("notifications" in body, false)
})

test("buildRunStartBody sets debug and dry_run flags", () => {
  const body = buildRunStartBody("wf_1", {}, { debug: true, dryRun: true })
  assert.equal(body.debug, true)
  assert.deepEqual(body.dry_run, { enabled: true })
})

test("buildRunStartBody carries workflow_id and run_input_variables", () => {
  const body = buildRunStartBody("wf_1", { USER: "abc" }, {})
  assert.equal(body.workflow_id, "wf_1")
  assert.deepEqual(body.run_input_variables, { USER: "abc" })
})

// The old production backend rejects unknown body fields, so a run without
// --version or --branch must not carry workflow_version or workflow_branch_id.
test("buildRunStartBody without --version or --branch sends neither workflow_version nor workflow_branch_id", () => {
  const body = buildRunStartBody("wf_1", {}, {})
  assert.equal("workflow_version" in body, false)
  assert.equal("workflow_branch_id" in body, false)
})

test("buildRunStartBody sends --version as workflow_version", () => {
  const body = buildRunStartBody("wf_1", {}, { version: "^2.1.0" })
  assert.equal(body.workflow_version, "^2.1.0")
  assert.equal("workflow_branch_id" in body, false)
})

test("buildRunStartBody sends --branch as workflow_branch_id", () => {
  const body = buildRunStartBody("wf_1", {}, { branch: "b_1" })
  assert.equal(body.workflow_branch_id, "b_1")
  assert.equal("workflow_version" in body, false)
})

// The backend accepts at most one way to pick the version to run, so the
// combination is refused locally as a usage error.
test("buildRunStartBody refuses --version together with --branch", () => {
  assert.throws(
    () => buildRunStartBody("wf_1", {}, { version: "2.1.0", branch: "b_1" }),
    { name: "UsageError", message: /Pass only one of --version, --branch/ }
  )
})

test("buildRunNetworkPath targets the run network endpoint and filters noise by default", () => {
  assert.equal(buildRunNetworkPath("sess_1", {}), "/run/sess_1/network")
})

test("buildRunNetworkPath passes --include-noise through as include_noise=true", () => {
  assert.equal(
    buildRunNetworkPath("sess_1", { includeNoise: true }),
    "/run/sess_1/network?include_noise=true"
  )
})

const networkResponse = {
  session_id: "sess_1",
  complete: true,
  omitted_bodies: 2,
  events: [
    { id: "a", method: "POST", status: 200, url: "https://app.example.com/api/a" },
    { id: "b", method: "GET", status: 404, url: "https://app.example.com/api/b" }
  ]
}

async function startNetworkBackend() {
  const urls: (string | undefined)[] = []
  const server = createServer((req, res) => {
    urls.push(req.url)
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify(networkResponse))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${port}`, urls, server }
}

function runCli(args: string[]) {
  const home = mkdtempSync(join(tmpdir(), "cloudcruise-test-"))
  const child = spawn(process.execPath, ["dist/bin/cloudcruise.js", ...args], {
    env: { ...process.env, HOME: home, CLOUDCRUISE_API_KEY: "test_key" }
  })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => (stdout += chunk))
  child.stderr.on("data", (chunk) => (stderr += chunk))
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) =>
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  )
}

// Agents save traffic with --output and only read the summary: the file must
// hold the full response, and stdout must carry the event count, the number of
// bodies cut by the body budget, and the path instead of every event. Bodies
// cut by the budget are also reported on stderr, so they are not missed.
test("run network --output writes the full traffic to the file and prints only a summary", async () => {
  const backend = await startNetworkBackend()
  try {
    const file = join(mkdtempSync(join(tmpdir(), "cloudcruise-network-")), "net.json")

    const result = await runCli([
      "run",
      "network",
      "sess_1",
      "--output",
      file,
      "--base-url",
      backend.baseUrl
    ])

    assert.equal(result.code, 0)
    assert.deepEqual(backend.urls, ["/run/sess_1/network"])
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), networkResponse)
    assert.deepEqual(JSON.parse(result.stdout), {
      session_id: "sess_1",
      complete: true,
      event_count: 2,
      omitted_bodies: 2,
      file
    })
    assert.match(result.stderr, /2 bodies are null: the 100 MB body budget per call was used up/)
  } finally {
    backend.server.close()
  }
})

const BRANCH_ID = "22222222-2222-4222-8222-222222222222"

async function startRunBackend() {
  const requests: { method?: string; url?: string; body: unknown }[] = []
  const server = createServer((req, res) => {
    let raw = ""
    req.on("data", (chunk) => (raw += chunk))
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : undefined })
      res.writeHead(200, { "content-type": "application/json" })
      if (req.url === "/workflows/wf_1/branches") {
        res.end(JSON.stringify([{ id: BRANCH_ID, name: "fix-login", is_default: false }]))
      } else {
        res.end(JSON.stringify({ session_id: "sess_1" }))
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${port}`, requests, server }
}

function runCliWithEnv(args: string[], env: Record<string, string | undefined>) {
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

// Unit tests of buildRunStartBody can't see whether Commander hands --version
// to the subcommand (the root --version used to swallow it), so this runs the
// real command against a local backend and inspects what reached POST /run.
test("run start --version sends workflow_version to POST /run through the real command", async () => {
  const backend = await startRunBackend()
  try {
    const result = await runCliWithEnv(
      ["run", "start", "wf_1", "--version", "^2.1.0", "--base-url", backend.baseUrl],
      { CLOUDCRUISE_API_KEY: "test_key" }
    )
    assert.equal(result.code, 0)
    assert.deepEqual(backend.requests.map((r) => `${r.method} ${r.url}`), ["POST /run"])
    assert.equal((backend.requests[0].body as Record<string, unknown>).workflow_version, "^2.1.0")
  } finally {
    backend.server.close()
  }
})

// A branch name is looked up in the workflow's branch list and sent as its id;
// the API only accepts ids.
test("run start --branch with a name looks the branch up and sends its id as workflow_branch_id", async () => {
  const backend = await startRunBackend()
  try {
    const result = await runCliWithEnv(
      ["run", "start", "wf_1", "--branch", "fix-login", "--base-url", backend.baseUrl],
      { CLOUDCRUISE_API_KEY: "test_key" }
    )
    assert.equal(result.code, 0)
    assert.deepEqual(backend.requests.map((r) => `${r.method} ${r.url}`), [
      "GET /workflows/wf_1/branches",
      "POST /run"
    ])
    assert.equal((backend.requests[1].body as Record<string, unknown>).workflow_branch_id, BRANCH_ID)
  } finally {
    backend.server.close()
  }
})

test("run start --branch with an id sends it as-is without a lookup", async () => {
  const backend = await startRunBackend()
  try {
    const result = await runCliWithEnv(
      ["run", "start", "wf_1", "--branch", BRANCH_ID, "--base-url", backend.baseUrl],
      { CLOUDCRUISE_API_KEY: "test_key" }
    )
    assert.equal(result.code, 0)
    assert.deepEqual(backend.requests.map((r) => `${r.method} ${r.url}`), ["POST /run"])
    assert.equal((backend.requests[0].body as Record<string, unknown>).workflow_branch_id, BRANCH_ID)
  } finally {
    backend.server.close()
  }
})

// Conflicting flags are a usage error the caller can fix without credentials,
// so they must exit 2 before auth is resolved and before any request.
test("run start with both --version and --branch exits 2 without credentials and sends no request", async () => {
  const backend = await startRunBackend()
  try {
    const result = await runCliWithEnv(
      ["run", "start", "wf_1", "--version", "2.1.0", "--branch", "fix-login", "--base-url", backend.baseUrl],
      { CLOUDCRUISE_API_KEY: undefined }
    )
    assert.equal(result.code, 2)
    assert.match(result.stderr, /Pass only one of --version, --branch/)
    assert.deepEqual(backend.requests, [])
  } finally {
    backend.server.close()
  }
})

test("omittedBodiesWarning stays silent when the body budget cut no bodies", () => {
  assert.equal(omittedBodiesWarning({ ...networkResponse, omitted_bodies: 0 }), undefined)
})

// A backend without the body budget does not send omitted_bodies; it cut no bodies.
test("summarizeRunNetwork reports 0 omitted bodies when the backend does not send omitted_bodies", () => {
  const { omitted_bodies: _, ...withoutField } = networkResponse
  assert.equal(summarizeRunNetwork(withoutField, "net.json").omitted_bodies, 0)
  assert.equal(omittedBodiesWarning(withoutField), undefined)
})
