import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const SCRIPT = fileURLToPath(
  new URL(
    "../skills/cc-workflow-build/scripts/wait-builder-turn.sh",
    import.meta.url
  )
)

// A fake `cloudcruise` (node, so no bash-quoting minefield). `builder status`
// replays FAKE_DIR/status.seq — one "<exit> <json>" line per call, tracked by a
// counter file, clamped to the last line so a lone `processing` line repeats.
// Codes 0/7/8/9 print the JSON to stdout (plus the real CLI's echoSession stderr
// line); anything else prints it to stderr, mirroring the CLI's fail() envelope.
// `builder messages` dumps FAKE_DIR/messages.json, or fails with FAKE_MESSAGES_RC.
const FAKE = `#!/usr/bin/env node
const fs = require("fs")
const [, , group, sub] = process.argv
const dir = process.env.FAKE_DIR
if (group !== "builder") { process.stderr.write('{"code":"BAD"}\\n'); process.exit(2) }
if (sub === "status") {
  const nFile = dir + "/status.n"
  let n = 0
  try { n = parseInt(fs.readFileSync(nFile, "utf8"), 10) || 0 } catch {}
  const lines = fs.readFileSync(dir + "/status.seq", "utf8").split("\\n").filter(Boolean)
  const idx = Math.min(n, lines.length - 1)
  fs.writeFileSync(nFile, String(n + 1))
  const line = lines[idx]
  const sp = line.indexOf(" ")
  const rc = parseInt(line.slice(0, sp), 10)
  const jsonPart = line.slice(sp + 1)
  if ([0, 7, 8, 9].includes(rc)) {
    process.stderr.write("conversation c1 (via flag)\\n")
    process.stdout.write(jsonPart + "\\n")
  } else {
    process.stderr.write(jsonPart + "\\n")
  }
  process.exit(rc)
} else if (sub === "messages") {
  const rc = parseInt(process.env.FAKE_MESSAGES_RC || "0", 10)
  if (rc !== 0) { process.stderr.write('{"code":"FAILURE"}\\n'); process.exit(rc) }
  process.stdout.write(fs.readFileSync(dir + "/messages.json", "utf8"))
  process.exit(0)
} else { process.stderr.write('{"code":"BAD_ARGS"}\\n'); process.exit(2) }
`

const DEFAULT_ARGS = [
  "--conversation",
  "c1",
  "--profile",
  "p",
  "--poll-seconds",
  "0",
  "--timeout-seconds",
  "30"
]

function runWait(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wbt-"))
  try {
    const fakePath = join(dir, "cloudcruise")
    writeFileSync(fakePath, FAKE)
    chmodSync(fakePath, 0o755)
    writeFileSync(
      join(dir, "status.seq"),
      (opts.seq ?? ["0 {\"status\":\"completed\"}"]).join("\n") + "\n"
    )
    writeFileSync(join(dir, "messages.json"), opts.messages ?? "{}")

    const env = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      FAKE_DIR: dir
    }
    if (opts.messagesRc !== undefined) env.FAKE_MESSAGES_RC = String(opts.messagesRc)

    const res = spawnSync("bash", [SCRIPT, ...(opts.args ?? DEFAULT_ARGS)], {
      encoding: "utf8",
      env
    })
    return { status: res.status, stdout: res.stdout, stderr: res.stderr }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const COMPLETED_MESSAGES = JSON.stringify({
  messages: [
    { role: "assistant", type: "reasoning", text: "thinking it through" },
    { role: "tool", type: "tool_result", text: "" },
    { role: "assistant", type: "message", text: "Implemented the Claims component." },
    { role: "assistant", type: "reasoning", text: "was that right?" }
  ],
  isProcessing: false
})

test("processing then completed prints only the final assistant report", () => {
  const r = runWait({
    seq: [
      '9 {"status":"processing","terminal":false}',
      '9 {"status":"processing","terminal":false}',
      '0 {"status":"completed","terminal":true,"conversationId":"c1"}'
    ],
    messages: COMPLETED_MESSAGES
  })
  assert.equal(r.status, 0)
  // stdout is EXACTLY the report — no status/poll noise leaked in.
  assert.equal(r.stdout, "Implemented the Claims component.\n")
  assert.equal(r.stderr, "")
})

test("report excludes reasoning and tool rows, even a trailing reasoning row", () => {
  const r = runWait({ messages: COMPLETED_MESSAGES })
  assert.equal(r.status, 0)
  assert.ok(!r.stdout.includes("thinking it through"))
  assert.ok(!r.stdout.includes("was that right?"))
  assert.equal(r.stdout.trim(), "Implemented the Claims component.")
})

test("awaiting-human-input exits 7 with the status JSON on stdout", () => {
  const r = runWait({
    seq: [
      '7 {"status":"awaiting-human-input","terminal":false,"humanInput":{"messageId":"m1","prompt":"2FA?","fields":[{"name":"code","type":"text"}]}}'
    ]
  })
  assert.equal(r.status, 7)
  const parsed = JSON.parse(r.stdout)
  assert.equal(parsed.status, "awaiting-human-input")
  assert.equal(parsed.humanInput.messageId, "m1")
})

test("agent-errored exits 8 with the status JSON on stdout", () => {
  const r = runWait({
    seq: ['8 {"status":"agent-errored","terminal":true,"workflowId":"wf1"}']
  })
  assert.equal(r.status, 8)
  assert.equal(JSON.parse(r.stdout).status, "agent-errored")
})

test("still-processing at the deadline exits 124", () => {
  const r = runWait({
    seq: ['9 {"status":"processing"}'],
    args: ["--conversation", "c1", "--poll-seconds", "5", "--timeout-seconds", "0"]
  })
  assert.equal(r.status, 124)
  assert.match(r.stderr, /timed out/)
})

test("idle does not masquerade as completed (exit 1)", () => {
  const r = runWait({ seq: ['0 {"status":"idle","conversationId":"c1"}'] })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /idle/)
})

test("ended does not masquerade as completed (exit 1)", () => {
  const r = runWait({ seq: ['0 {"status":"ended","conversationId":"c1"}'] })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /ended/)
})

test("a genuine CLI failure is passed through with its own exit code", () => {
  const r = runWait({
    seq: ['3 {"code":"UNAUTHENTICATED","message":"bad key","exitCode":3}']
  })
  assert.equal(r.status, 3)
  assert.equal(r.stdout, "")
  assert.match(r.stderr, /UNAUTHENTICATED/)
})

test("completed but no assistant report exits 1", () => {
  const r = runWait({
    seq: ['0 {"status":"completed"}'],
    messages: JSON.stringify({
      messages: [{ role: "assistant", type: "reasoning", text: "only thinking" }]
    })
  })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /no assistant report/)
})

test("completed but messages fetch fails exits 1 and surfaces the CLI error", () => {
  const r = runWait({ seq: ['0 {"status":"completed"}'], messagesRc: 4 })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /builder messages` failed/)
  assert.match(r.stderr, /FAILURE/)
})

test("completed with malformed messages JSON exits 1", () => {
  const r = runWait({ seq: ['0 {"status":"completed"}'], messages: "not json at all" })
  assert.equal(r.status, 1)
})

test("unknown flag exits 2", () => {
  const r = runWait({ args: ["--conversation", "c1", "--bogus", "x"] })
  assert.equal(r.status, 2)
})

test("a flag missing its value exits 2", () => {
  const r = runWait({ args: ["--conversation"] })
  assert.equal(r.status, 2)
})

test("non-integer --poll-seconds exits 2", () => {
  const r = runWait({ args: ["--conversation", "c1", "--poll-seconds", "abc"] })
  assert.equal(r.status, 2)
})
