import { afterEach, test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { CallError, SpecCache } from "../dist/index.js"
import { BASE, editOperation, fakeBackend, fixture, setup } from "./helpers.ts"

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

const START = { body: { workflow_id: "wf-1", run_input_variables: { name: "Ada" } } }

async function callError(promise: Promise<unknown>): Promise<CallError> {
  const err = await promise.then(
    () => assert.fail("expected the call to throw"),
    (e: unknown) => e
  )
  assert.ok(err instanceof CallError, `expected CallError, got ${String(err)}`)
  for (const word of ["etag", "version", "snapshot", "cache", BASE.toLowerCase()]) {
    assert.equal(err.message.toLowerCase().includes(word), false, `message mentions "${word}": ${err.message}`)
  }
  return err
}

// Spec cache

test("uses the spec for the TTL, then revalidates with If-None-Match", async () => {
  const backend = fakeBackend()
  const { strata, clock } = setup()

  await strata.search("workflow")
  clock.now = 299_999
  await strata.search("workflow")
  assert.equal(backend.specRequests.length, 1)
  assert.equal(backend.specRequests[0].has("if-none-match"), false)
  assert.equal(backend.specRequests[0].has("authorization"), false)
  assert.equal(backend.specRequests[0].get("x-cloudcruise-client"), "test/1.0.0")

  clock.now = 300_000
  await strata.search("workflow")
  assert.equal(backend.specRequests.length, 2)
  assert.equal(backend.specRequests[1].get("if-none-match"), 'W/"v1"')
})

test("a 304 keeps the spec; a 200 replaces it", async () => {
  const backend = fakeBackend()
  const { strata, clock } = setup()

  assert.deepEqual((await strata.search("runs.get")).map((o) => o.name)[0], "runs.get")

  clock.now = 300_000
  assert.equal((await strata.search("runs.get"))[0].name, "runs.get")
  assert.equal(backend.specRequests.length, 2)

  backend.spec = editOperation(backend.spec, "/run/{sessionId}", "get", (op) => {
    op["x-strata-surfaces"] = ["cli"]
  })
  backend.etag = 'W/"v2"'
  clock.now = 600_000
  const found = (await strata.search("runs.get")).map((o) => o.name)
  assert.equal(found.includes("runs.get"), false)
})

test("concurrent cold requests share one spec fetch", async () => {
  const backend = fakeBackend()
  const specs = new SpecCache({ client: "test/1.0.0" })

  await Promise.all(
    Array.from({ length: 10 }, (_, i) => setup({ specs, token: `user-${i}` }).strata.search("workflow"))
  )

  assert.equal(backend.specRequests.length, 1)
})

test("a failed refresh keeps serving the old spec and retries after 30 s", async () => {
  const backend = fakeBackend()
  const { strata, clock } = setup()
  await strata.search("workflow")

  backend.specFailure = 503
  clock.now = 300_000
  assert.equal((await strata.search("list workflows"))[0].name, "workflows.list")
  clock.now = 329_999
  await strata.search("workflow")
  assert.equal(backend.specRequests.length, 2)

  backend.specFailure = "throw"
  clock.now = 330_000
  assert.equal((await strata.search("list workflows"))[0].name, "workflows.list")
  assert.equal(backend.specRequests.length, 3)
})

test("serves the snapshot when there is no spec yet and the fetch fails, then retries", async () => {
  const backend = fakeBackend()
  backend.specFailure = "throw"
  const clock = { now: 0 }
  const specs = new SpecCache({ client: "test/1.0.0", now: () => clock.now, snapshot: fixture })
  const { strata } = setup({ specs })

  assert.equal((await strata.search("list workflows"))[0].name, "workflows.list")

  backend.specFailure = undefined
  backend.spec = editOperation(backend.spec, "/workflows", "get", (op) => {
    op["x-strata-name"] = "workflows.search"
  })
  clock.now = 30_000
  assert.equal((await strata.search("list workflows"))[0].name, "workflows.search")
})

test("the bundled snapshot ships in dist as an OpenAPI document", () => {
  const snapshot = JSON.parse(readFileSync(new URL("../dist/openapi.snapshot.json", import.meta.url), "utf8"))

  assert.equal(typeof snapshot.openapi, "string")
  assert.equal(typeof snapshot.paths, "object")
})

test("bundled snapshot loads and exposes nothing yet", async () => {
  const backend = fakeBackend()
  backend.specFailure = 404
  const { strata } = setup({ specs: new SpecCache({ client: "test/1.0.0" }) })

  assert.deepEqual(await strata.search("workflow"), [])
  const err = await callError(strata.call("workflows.list", {}))
  assert.equal(err.kind, "unknown_operation")
})

test("two callers on one cache send their own tokens and fetch the spec once", async () => {
  const backend = fakeBackend()
  const specs = new SpecCache({ client: "test/1.0.0" })
  const a = setup({ specs, token: "token-a" }).strata
  const b = setup({ specs, token: "token-b" }).strata

  await Promise.all([a.call("workflows.list", {}), b.call("workflows.list", {})])

  assert.equal(backend.specRequests.length, 1)
  assert.deepEqual(
    backend.apiCalls.map((c) => c.headers.get("authorization")).sort(),
    ["Bearer token-a", "Bearer token-b"]
  )
})

test("during an outage, revalidation waits out the retry interval too", async () => {
  const backend = fakeBackend()
  const { strata, clock } = setup()
  await strata.search("workflow")

  backend.specFailure = "throw"
  backend.api = () => Response.json({ message: "Workflow not found" }, { status: 404 })
  clock.now = 300_000
  for (let i = 0; i < 5; i++) {
    assert.equal((await callError(strata.call("workflows.get", { workflowId: "w" }))).kind, "api_error")
  }
  assert.equal(backend.specRequests.length, 2)

  clock.now = 330_000
  await callError(strata.call("workflows.get", { workflowId: "w" }))
  assert.equal(backend.specRequests.length, 3)
})

test("a spec fetch that hangs times out and the old spec is kept", { timeout: 2000 }, async () => {
  const backend = fakeBackend()
  const clock = { now: 0 }
  const specs = new SpecCache({ client: "test/1.0.0", now: () => clock.now, timeoutMs: 20 })
  const { strata } = setup({ specs })
  await strata.search("workflow")

  const fake = globalThis.fetch
  globalThis.fetch = ((input: string, init: RequestInit = {}) =>
    String(input).endsWith("/openapi.json")
      ? new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)))
      : fake(input, init)) as typeof fetch
  clock.now = 300_000

  assert.equal((await strata.search("list workflows"))[0].name, "workflows.list")
  assert.equal(backend.specRequests.length, 1)
})

// Building the request

test("sends the method, path, query and body with the caller's headers", async () => {
  const backend = fakeBackend()
  backend.api = () => Response.json({ session_id: "s-1" }, { status: 202 })
  const { strata } = setup()

  const result = await strata.call("runs.start", START)

  assert.deepEqual(result, { status: 202, data: { session_id: "s-1" } })
  assert.equal(backend.apiCalls[0].method, "POST")
  assert.equal(backend.apiCalls[0].url, `${BASE}/run`)
  assert.deepEqual(backend.apiCalls[0].body, START.body)
  assert.equal(backend.apiCalls[0].headers.get("authorization"), "Bearer tok")
  assert.equal(backend.apiCalls[0].headers.get("content-type"), "application/json")
})

test("encodes path values and repeats array query values", async () => {
  const backend = fakeBackend()
  const { strata } = setup()

  await strata.call("workflows.get", { workflowId: "a/b c" })
  await strata.call("workflows.list", { limit: 5, tags: ["x", "y z"] })

  assert.equal(backend.apiCalls[0].url, `${BASE}/workflows/a%2Fb%20c`)
  assert.equal(backend.apiCalls[1].url, `${BASE}/workflows?limit=5&tags=x&tags=y+z`)
  assert.equal(backend.apiCalls[1].body, undefined)
})

test("a 204 returns no data; a text body returns text", async () => {
  const backend = fakeBackend()
  const { strata } = setup({ surface: "cli" })

  backend.api = () => new Response(null, { status: 204 })
  assert.deepEqual(await strata.call("workflows.delete", { workflowId: "w" }), { status: 204, data: undefined })

  backend.api = () => new Response("ok", { status: 200 })
  assert.deepEqual(await strata.call("workflows.get", { workflowId: "w" }), { status: 200, data: "ok" })
})

// Checks before sending

test("rejects arguments that don't fit the shape without sending", async () => {
  const backend = fakeBackend()
  const { strata } = setup()

  const cases: [string, unknown, string][] = [
    ["runs.start", {}, "missing `body`"],
    ["runs.start", { ...START, session: "x" }, "unknown argument `session`"],
    ["workflows.get", {}, "missing `workflowId`"],
    ["workflows.get", { workflowId: { id: 1 } }, "`workflowId` must be a string or number"],
    ["workflows.list", { tags: [{}] }, "`tags` must be a string, number, boolean or a list of them"],
    ["workflows.list", { body: {} }, "unknown argument `body`"],
    ["workflows.list", null, "arguments must be an object"],
    ["workflows.get", { workflowId: ".." }, '`workflowId` can\'t be ".."'],
    ["workflows.get", { workflowId: "." }, '`workflowId` can\'t be "."'],
    ["workflows.get", { workflowId: "" }, '`workflowId` can\'t be ""'],
    ["workflows.list", { toString: 1 }, "unknown argument `toString`"],
    ["workflows.list", { constructor: 1 }, "unknown argument `constructor`"]
  ]
  for (const [name, args, problem] of cases) {
    const err = await callError(strata.call(name, args))
    assert.equal(err.kind, "invalid_arguments", name)
    assert.ok(err.message.includes(problem), err.message)
    assert.ok(err.message.includes("Schema: {"), err.message)
  }
  assert.equal(backend.apiCalls.length, 0)
})

test("leaves value checks to the API", async () => {
  const backend = fakeBackend()
  const { strata } = setup()

  await strata.call("runs.start", { body: { workflow_id: 42, priority_level: "MID" } })

  assert.equal(backend.apiCalls.length, 1)
})

test("an unknown name is refreshed once, then reported", async () => {
  const backend = fakeBackend()
  const { strata } = setup()

  const err = await callError(strata.call("runs.strat", {}))

  assert.equal(err.kind, "unknown_operation")
  assert.equal(err.message, "No operation named runs.strat. Search for it.")
  assert.equal(backend.specRequests.length, 2)
  assert.equal(backend.apiCalls.length, 0)
})

test("an operation added since the last fetch is found and sent once", async () => {
  const backend = fakeBackend()
  const { strata } = setup()
  await strata.search("workflow")

  backend.spec = editOperation(backend.spec, "/users/me", "get", (op) => {
    op["x-strata-surfaces"] = ["mcp"]
    op["x-strata-name"] = "users.me"
  })
  backend.etag = 'W/"v2"'
  await strata.call("users.me", {})

  assert.equal(backend.apiCalls.length, 1)
})

test("operations tagged for another surface, [] or nothing can't be called", async () => {
  const backend = fakeBackend()
  const { strata } = setup()

  for (const name of ["workflows.delete", "vault.create", "users.me"]) {
    assert.equal((await callError(strata.call(name, {}))).kind, "unknown_operation")
  }
  assert.equal(backend.apiCalls.length, 0)
})

test("readOnly refuses a write without sending it and allows a read", async () => {
  const backend = fakeBackend()
  const { strata } = setup()

  const err = await callError(strata.call("runs.start", START, { readOnly: true }))
  assert.equal(err.kind, "not_read_only")
  assert.equal(backend.apiCalls.length, 0)

  await strata.call("workflows.list", {}, { readOnly: true })
  assert.equal(backend.apiCalls.length, 1)
})

// Drift and API errors

test("a 4xx after the operation changed reports the new schema and does not retry", async () => {
  const backend = fakeBackend()
  const { strata } = setup()
  await strata.search("runs.start")

  backend.spec = editOperation(backend.spec, "/run", "post", (op) => {
    op.requestBody.content["application/json"].schema = {
      type: "object",
      required: ["workflow"],
      properties: { workflow: { type: "string" } }
    }
  })
  backend.etag = 'W/"v2"'
  backend.api = () => Response.json({ message: ["property workflow_id should not exist"] }, { status: 400 })

  const err = await callError(strata.call("runs.start", START))

  assert.equal(err.kind, "api_changed")
  assert.ok(err.message.startsWith("runs.start changed since you looked it up."), err.message)
  assert.ok(err.message.includes('"required":["workflow"]'), err.message)
  assert.deepEqual(err.operation?.input.required, ["body"])
  assert.equal(backend.apiCalls.length, 1)
  assert.equal(backend.specRequests.at(-1)?.get("if-none-match"), 'W/"v1"')
})

test("a 4xx after the operation was removed says so", async () => {
  const backend = fakeBackend()
  const { strata } = setup()
  await strata.search("runs.start")

  backend.spec = editOperation(backend.spec, "/run", "post", (op) => {
    op["x-strata-surfaces"] = []
  })
  backend.etag = 'W/"v2"'
  backend.api = () => new Response("Not Found", { status: 404 })

  const err = await callError(strata.call("runs.start", START))

  assert.equal(err.kind, "api_changed")
  assert.equal(err.message, "runs.start no longer exists. Search again.")
})

test("a 400 with the operation unchanged passes the API's message with the schema", async () => {
  const backend = fakeBackend()
  const { strata } = setup()
  backend.api = () =>
    Response.json(
      { statusCode: 400, message: ["workflow_id must be a string", "priority_level must be HIGH or LOW"] },
      { status: 400 }
    )

  const err = await callError(strata.call("runs.start", START))

  assert.equal(err.kind, "api_error")
  assert.equal(err.status, 400)
  assert.ok(
    err.message.startsWith(
      "The API rejected the arguments for runs.start (400): workflow_id must be a string; priority_level must be HIGH or LOW. Schema: {"
    ),
    err.message
  )
  assert.equal(backend.specRequests.length, 2)
  assert.equal(backend.apiCalls.length, 1)
})

test("a change to another operation is not reported as a change", async () => {
  const backend = fakeBackend()
  const { strata } = setup()
  await strata.search("runs.start")

  backend.spec = editOperation(backend.spec, "/workflows", "get", (op) => {
    op.parameters = []
  })
  backend.etag = 'W/"v2"'
  backend.api = () => Response.json({ message: "bad" }, { status: 422 })

  assert.equal((await callError(strata.call("runs.start", START))).kind, "api_error")
})

test("other 4xx return the API's message without a schema", async () => {
  const backend = fakeBackend()
  const { strata } = setup()
  backend.api = () => Response.json({ message: "Workflow not found" }, { status: 404 })

  const err = await callError(strata.call("workflows.get", { workflowId: "w" }))

  assert.equal(err.kind, "api_error")
  assert.equal(err.status, 404)
  assert.equal(err.message, "workflows.get failed (404): Workflow not found")
  assert.equal(err.operation, undefined)
})

test("a 5xx does not check the spec", async () => {
  const backend = fakeBackend()
  const { strata } = setup()
  backend.api = () => new Response("", { status: 502 })

  const err = await callError(strata.call("workflows.list", {}))

  assert.equal(err.kind, "api_error")
  assert.equal(err.message, "workflows.list failed (502): no details")
  assert.equal(backend.specRequests.length, 1)
})

test("a shape error against a changed operation reports the change, without sending", async () => {
  const backend = fakeBackend()
  const { strata } = setup()
  await strata.search("runs.start")

  backend.spec = editOperation(backend.spec, "/run", "post", (op) => {
    op.parameters = [{ name: "preview", in: "query", required: false, schema: { type: "boolean" } }]
  })
  backend.etag = 'W/"v2"'

  const err = await callError(strata.call("runs.start", { ...START, dry: true }))

  assert.equal(err.kind, "api_changed")
  assert.ok(err.message.includes('"preview"'), err.message)
  assert.equal(backend.apiCalls.length, 0)
})

test("arguments that fit the operation as it is now are sent", async () => {
  const backend = fakeBackend()
  const { strata } = setup()
  await strata.search("runs.start")

  backend.spec = editOperation(backend.spec, "/run", "post", (op) => {
    op.parameters = [{ name: "preview", in: "query", required: false, schema: { type: "boolean" } }]
  })
  backend.etag = 'W/"v2"'
  await strata.call("runs.start", { ...START, preview: true })

  assert.equal(backend.apiCalls.length, 1)
  assert.equal(backend.apiCalls[0].url, `${BASE}/run?preview=true`)
})

test("a network failure is unavailable, and warns that a write may have run", async () => {
  const backend = fakeBackend()
  const { strata } = setup()
  backend.api = () => {
    throw new TypeError("fetch failed")
  }

  const write = await callError(strata.call("runs.start", START))
  const read = await callError(strata.call("workflows.list", {}))

  assert.equal(write.kind, "unavailable")
  assert.equal(
    write.message,
    "Could not reach the CloudCruise API for runs.start. It may have run; check before calling it again."
  )
  assert.equal(read.message, "Could not reach the CloudCruise API for workflows.list.")
  assert.equal(backend.apiCalls.length, 2)
})
