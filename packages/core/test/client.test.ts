import { afterEach, test } from "node:test"
import assert from "node:assert/strict"
import { ApiError, StrataClient, type StrataClientOptions } from "../dist/index.js"

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

const base: StrataClientOptions = {
  baseUrl: "https://api.example.test",
  token: "tok",
  authScheme: "bearer",
  client: "test/1.0.0"
}

// Records every request so a test can assert what each client sent.
function recordRequests(): { url: string; headers: Headers }[] {
  const seen: { url: string; headers: Headers }[] = []
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: new Headers(init.headers) })
    // Yield so concurrent requests interleave.
    await new Promise((resolve) => setTimeout(resolve, 0))
    return new Response("{}", { status: 200 })
  }) as typeof fetch
  return seen
}

test("sends the caller's identity, bearer token and workspace", async () => {
  const seen = recordRequests()

  await new StrataClient({ ...base, workspaceId: "ws-1", agent: "claude" }).get("/me")

  assert.equal(seen[0].url, "https://api.example.test/me")
  assert.equal(seen[0].headers.get("authorization"), "Bearer tok")
  assert.equal(seen[0].headers.get("x-workspace-id"), "ws-1")
  assert.equal(seen[0].headers.get("x-cloudcruise-client"), "test/1.0.0")
  assert.equal(seen[0].headers.get("x-cloudcruise-agent"), "claude")
})

test("sends an API key as cc-key and omits unset optional headers", async () => {
  const seen = recordRequests()

  await new StrataClient({ ...base, authScheme: "api-key" }).get("/me")

  assert.equal(seen[0].headers.get("cc-key"), "tok")
  assert.equal(seen[0].headers.has("authorization"), false)
  assert.equal(seen[0].headers.has("x-workspace-id"), false)
  assert.equal(seen[0].headers.has("x-cloudcruise-agent"), false)
})

// The MCP server serves many users from one process: concurrent clients must each
// send only their own credentials.
test("concurrent clients each send their own token and workspace", async () => {
  const seen = recordRequests()
  const users = Array.from({ length: 20 }, (_, i) => `user-${i}`)

  await Promise.all(
    users.map((user) =>
      new StrataClient({ ...base, token: user, workspaceId: `ws-${user}` }).get(`/as/${user}`)
    )
  )

  assert.equal(seen.length, users.length)
  for (const { url, headers } of seen) {
    const user = url.split("/as/")[1]
    assert.equal(headers.get("authorization"), `Bearer ${user}`)
    assert.equal(headers.get("x-workspace-id"), `ws-${user}`)
  }
})

test("changing the options object after construction does not change the client", async () => {
  const seen = recordRequests()
  const options = { ...base }
  const client = new StrataClient(options)

  options.token = "other"
  await client.get("/me")

  assert.equal(seen[0].headers.get("authorization"), "Bearer tok")
})

test("headers do not depend on the process environment", async () => {
  const seen = recordRequests()
  const client = new StrataClient(base)
  const saved = { ...process.env }

  await client.get("/me")
  process.env.CLAUDECODE = "1"
  process.env.CLOUDCRUISE_TOKEN = "env-token"
  process.env.CLOUDCRUISE_WORKSPACE_ID = "env-ws"
  try {
    await client.get("/me")
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, saved)
  }

  assert.deepEqual([...seen[1].headers], [...seen[0].headers])
})

test("non-2xx responses throw ApiError with status, code and body", async () => {
  const body = JSON.stringify({ code: "SESSION_BUSY", message: "busy" })
  globalThis.fetch = (async () => new Response(body, { status: 409 })) as typeof fetch

  const err = await new StrataClient(base).post("/x", {}).catch((e: unknown) => e)

  assert.ok(err instanceof ApiError)
  assert.equal(err.status, 409)
  assert.equal(err.code, "SESSION_BUSY")
  assert.equal(err.body, body)
  assert.equal(err.message, `POST /x failed (409): ${body}`)
})
