import { afterEach, beforeEach, test } from "node:test"
import assert from "node:assert/strict"
import { ApiClient } from "../dist/src/core/api-client.js"
import { CLI_VERSION } from "../dist/src/core/version.js"

// Agent detection reads process.env by reference, so the environment is cleared and
// restored in place: the suite itself may run inside a coding agent.
const originalEnv = { ...process.env }
const realFetch = globalThis.fetch

beforeEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key]
})

afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  globalThis.fetch = realFetch
})

async function headersSentByApiClient(): Promise<Headers> {
  let seen: Headers | undefined
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    seen = new Headers(init.headers)
    return new Response("{}", { status: 200 })
  }) as typeof fetch
  const client = new ApiClient({
    token: "key",
    authScheme: "api-key",
    baseUrl: "https://api.example.test"
  })
  await client.get("/workflows")
  return seen!
}

test("API requests identify the CLI and its version in X-CloudCruise-Client", async () => {
  const headers = await headersSentByApiClient()

  assert.equal(headers.get("x-cloudcruise-client"), `cli/${CLI_VERSION}`)
})

// The backend breaks CLI usage down by the coding agent driving it; std-env recognizes the
// agent from the variables it sets in the shells it runs commands in.
for (const [variable, agent] of [
  ["CLAUDECODE", "claude"],
  ["CODEX_THREAD_ID", "codex"],
  ["CURSOR_AGENT", "cursor"]
] as const) {
  test(`API requests send X-CloudCruise-Agent: ${agent} when ${variable} is set`, async () => {
    process.env[variable] = "1"

    const headers = await headersSentByApiClient()

    assert.equal(headers.get("x-cloudcruise-agent"), agent)
  })
}

// A human at a plain terminal is not a coding agent; the header must be absent so the
// backend counts the request under agent "none".
test("API requests omit X-CloudCruise-Agent when no coding agent is detected", async () => {
  const headers = await headersSentByApiClient()

  assert.equal(headers.has("x-cloudcruise-agent"), false)
})

// Replit sets REPL_ID in every shell, including the ones humans type into, so it alone
// does not prove an agent is running the CLI.
test("API requests omit X-CloudCruise-Agent when only Replit's REPL_ID is set", async () => {
  process.env.REPL_ID = "repl-1"

  const headers = await headersSentByApiClient()

  assert.equal(headers.has("x-cloudcruise-agent"), false)
})

// AI_AGENT is the explicit, agent-neutral way to declare an agent and is trusted as given.
test("API requests send the agent named in AI_AGENT, even for Replit", async () => {
  process.env.REPL_ID = "repl-1"
  process.env.AI_AGENT = "replit"

  const headers = await headersSentByApiClient()

  assert.equal(headers.get("x-cloudcruise-agent"), "replit")
})
