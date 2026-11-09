import { readFileSync } from "node:fs"
import { afterEach, test } from "node:test"
import assert from "node:assert/strict"
import { fakeBackend, setup } from "./helpers.ts"

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

async function names(surface: "cli" | "mcp", query: string, limit = 10): Promise<string[]> {
  fakeBackend()
  const { strata } = setup({ surface })
  return (await strata.search(query, { limit })).map((op) => op.name)
}

test("mcp sees only operations tagged mcp that have a name", async () => {
  const found = await names("mcp", "workflow run steps vault user export credential value", 10)

  assert.deepEqual(found.sort(), [
    "runs.get",
    "runs.start",
    "runs.steps",
    "values.get",
    "workflows.get",
    "workflows.list"
  ])
})

test("cli sees its own operations, including ones hidden from mcp", async () => {
  const found = await names("cli", "workflow run delete", 10)

  assert.deepEqual(found.sort(), ["runs.start", "workflows.delete", "workflows.get", "workflows.list"])
})

test("ranks the operation a request describes first", async () => {
  assert.equal((await names("mcp", "list my workflows"))[0], "workflows.list")
  assert.equal((await names("mcp", "start a run"))[0], "runs.start")
  assert.equal((await names("mcp", "get the workflow"))[0], "workflows.get")
  assert.equal((await names("mcp", "what steps did my run take"))[0], "runs.steps")
})

test("an exact name ranks first", async () => {
  assert.equal((await names("mcp", "runs.get"))[0], "runs.get")
})

test("an empty or unmatched query returns nothing", async () => {
  assert.deepEqual(await names("mcp", ""), [])
  assert.deepEqual(await names("mcp", "zebra"), [])
})

test("limit defaults to 5 and is capped at 10", async () => {
  const backend = fakeBackend()
  for (let i = 0; i < 12; i++) {
    backend.spec.paths[`/things/${i}`] = {
      get: { summary: "Read a thing", "x-strata-surfaces": ["mcp"], "x-strata-name": `things.read${i}` }
    }
  }
  const { strata } = setup()

  assert.equal((await strata.search("thing")).length, 5)
  assert.equal((await strata.search("thing", { limit: 2 })).length, 2)
  assert.equal((await strata.search("thing", { limit: 50 })).length, 10)
})

test("results carry hints and full schemas with refs resolved and nullable rewritten", async () => {
  fakeBackend()
  const { strata } = setup()

  const [op] = await strata.search("runs.start")

  assert.equal(op.summary, "Start a workflow run")
  assert.deepEqual(op.hints, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true
  })
  assert.deepEqual(op.input, {
    type: "object",
    additionalProperties: false,
    required: ["body"],
    properties: {
      body: {
        type: "object",
        required: ["workflow_id", "run_input_variables"],
        properties: {
          workflow_id: { type: "string" },
          run_input_variables: { type: "object", additionalProperties: true },
          priority_level: { type: ["string", "null"], enum: ["HIGH", "LOW", null] },
          webhook: {
            anyOf: [
              { allOf: [{ type: "object", required: ["url"], properties: { url: { type: "string" } } }] },
              { type: "null" }
            ]
          }
        }
      }
    }
  })
  assert.deepEqual(op.output, { type: "object", properties: { session_id: { type: "string" } } })
  assert.equal(JSON.stringify(op).includes("$ref"), false)
})

test("parameters become top-level arguments; header parameters are left out", async () => {
  fakeBackend()
  const { strata } = setup()

  const [list] = await strata.search("workflows.list")
  const [get] = await strata.search("workflows.get")
  const [run] = await strata.search("runs.get")

  assert.deepEqual(list.input, {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: { type: "integer", description: "Most workflows to return." },
      tags: { type: "array", items: { type: "string" } }
    }
  })
  assert.deepEqual(get.input.required, ["workflowId"])
  assert.deepEqual(Object.keys(run.input.properties as object), ["sessionId"])
})

test("an operation without hints gets the most cautious ones", async () => {
  fakeBackend()
  const { strata } = setup()

  const [steps] = await strata.search("runs.steps")

  assert.deepEqual(steps.hints, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true
  })
})

test("an operation that needs a header parameter is hidden, since call can't send it", async () => {
  assert.equal((await names("mcp", "signed export get")).includes("signed.get"), false)
})

test("a recursive schema stops at its second appearance", async () => {
  fakeBackend()
  const { strata } = setup()

  const [op] = await strata.search("values.get")

  assert.deepEqual(op.output, {
    anyOf: [
      { type: "string" },
      { type: "number" },
      { type: "array", items: {} },
      { type: "object", additionalProperties: {} }
    ]
  })
})

test("one caller can't change the operations another caller sees", async () => {
  fakeBackend()
  const a = setup()
  const b = setup({ specs: a.specs, token: "other" })

  const [op] = await a.strata.search("workflows.list")
  assert.throws(() => {
    ;(op.hints as { readOnlyHint: boolean }).readOnlyHint = false
  }, TypeError)
  assert.throws(() => {
    ;(op.input.properties as Record<string, unknown>).limit = { type: "string" }
  }, TypeError)

  const [seen] = await b.strata.search("workflows.list")
  assert.equal(seen.hints.readOnlyHint, true)
  assert.deepEqual((seen.input.properties as Record<string, unknown>).limit, {
    type: "integer",
    description: "Most workflows to return."
  })
})

function launchSpec(): any {
  return JSON.parse(readFileSync(new URL("./fixtures/launch.openapi.json", import.meta.url), "utf8"))
}

// Requests a user types in a chat client, against the operations tagged for launch.
// The ticket's requests must rank first; the rest must reach the top 3, since an
// agent reads every result before it calls one.
const FIRST: [string, string][] = [
  ["list my workflows", "workflows.list"],
  ["show the last failed run", "runs.list"],
  ["what did run 8f2c return", "runs.get"],
  ["start the invoice workflow", "runs.start"],
  ["dry run the invoice workflow", "runs.start"],
  ["what inputs does the invoice workflow need", "workflows.get"],
  ["tell the builder to add a login step", "builder.message"]
]
const TOP_3: [string, string][] = [
  ["which runs failed today", "runs.list"],
  ["runs of my invoice workflow", "runs.list"],
  ["is my run done", "runs.get"],
  ["is the builder finished", "builder.turn"]
]

test("known requests find their operation on the launch operations", async () => {
  const backend = fakeBackend()
  backend.spec = launchSpec()
  const { strata } = setup()

  const misses: string[] = []
  for (const [queries, depth] of [[FIRST, 1], [TOP_3, 3]] as const) {
    for (const [query, expected] of queries) {
      const found = (await strata.search(query)).map((op) => op.name)
      if (!found.slice(0, depth).includes(expected)) {
        misses.push(`"${query}": expected ${expected} in top ${depth}, got [${found.join(", ")}]`)
      }
    }
  }

  assert.deepEqual(misses, [])
})

test("parameters, enum values, body fields, path segments and tags are searchable", async () => {
  const backend = fakeBackend()
  backend.spec = {
    openapi: "3.0.0",
    paths: {
      "/widgets/{id}": {
        post: {
          summary: "Read a thing",
          tags: ["Gadgets"],
          "x-strata-surfaces": ["mcp"],
          "x-strata-name": "things.read",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "colourCode", in: "query", description: "Zebra stripes", schema: { type: "string", enum: ["tint.crimson"] } }
          ],
          requestBody: {
            content: {
              "application/json": {
                schema: { type: "object", properties: { flavour: { type: "string", enum: ["mango"] } } }
              }
            }
          }
        }
      },
      "/other": {
        get: { summary: "Something else", "x-strata-surfaces": ["mcp"], "x-strata-name": "other.get" }
      }
    }
  }
  const { strata } = setup()

  for (const term of ["widgets", "Gadgets", "colour", "code", "zebra", "crimson", "flavour", "mango"]) {
    assert.deepEqual((await strata.search(term)).map((op) => op.name), ["things.read"], term)
  }
})

test("categories are the reachable operations' tags in the spec's order", async () => {
  const backend = fakeBackend()
  backend.spec = launchSpec()
  const { strata } = setup()

  assert.deepEqual(await strata.categories(), ["Workflows", "Runs", "Builder"])
})
