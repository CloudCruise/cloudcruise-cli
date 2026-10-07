import { test } from "node:test"
import assert from "node:assert/strict"
import {
  buildRunNetworkPath,
  buildRunStartBody,
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

test("buildRunNetworkPath targets the run network endpoint and filters noise by default", () => {
  assert.equal(buildRunNetworkPath("sess_1", {}), "/run/sess_1/network")
})

test("buildRunNetworkPath passes --include-noise through as include_noise=true", () => {
  assert.equal(
    buildRunNetworkPath("sess_1", { includeNoise: true }),
    "/run/sess_1/network?include_noise=true"
  )
})

test("summarizeRunNetwork reports where --output wrote the traffic instead of echoing every event", () => {
  const summary = summarizeRunNetwork(
    { session_id: "sess_1", complete: true, events: [{}, {}, {}] },
    "traffic.json"
  )
  assert.deepEqual(summary, {
    session_id: "sess_1",
    complete: true,
    event_count: 3,
    file: "traffic.json"
  })
})
