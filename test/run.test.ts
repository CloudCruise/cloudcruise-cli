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
  buildRunStartBody
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
  child.stdout.on("data", (chunk) => (stdout += chunk))
  return new Promise<{ code: number | null; stdout: string }>((resolve) =>
    child.on("close", (code) => resolve({ code, stdout }))
  )
}

// Agents save traffic with --output and only read the summary: the file must
// hold the full response, and stdout must carry the event count and path
// instead of every event.
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
      file
    })
  } finally {
    backend.server.close()
  }
})
