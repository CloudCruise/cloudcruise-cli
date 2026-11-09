# @cloudcruise/strata

Shared CloudCruise API runtime used by the [CloudCruise CLI](https://github.com/CloudCruise/cloudcruise-cli) and the CloudCruise MCP server.

```ts
import { StrataClient, ApiError } from "@cloudcruise/strata"

const client = new StrataClient({
  baseUrl: "https://api.cloudcruise.com",
  token: process.env.CLOUDCRUISE_API_KEY!,
  authScheme: "api-key",
  client: "my-tool/1.0.0"
})

const workflows = await client.get("/workflows")
```

A client sends only what its constructor was given. Build one client per caller.

## Finding and calling operations

`Strata` reads the API's OpenAPI spec at run time and reaches the operations tagged for one surface (`cli` or `mcp`) through `x-strata-surfaces`, by their `x-strata-name`.

```ts
import { SpecCache, Strata, StrataClient, CallError } from "@cloudcruise/strata"

// One per process: it holds no credentials, so every caller can share it.
const specs = new SpecCache({ client: "my-tool/1.0.0" })

// One per caller.
const strata = new Strata({ client, surface: "mcp", specs })

const [op] = await strata.search("start a run")   // name, hints, input and output schemas
try {
  const { status, data } = await strata.call(op.name, { body: { workflow_id: "…", run_input_variables: {} } })
} catch (err) {
  if (err instanceof CallError) console.error(err.kind, err.message)
}
```

`call` takes path and query parameters as top-level arguments and the JSON body under `body`. It never retries; a `CallError` message says what went wrong in words meant for the agent that made the call.

The spec is checked again after 5 minutes, and whenever a call gets a 4xx. If a refresh fails, the runtime keeps using the spec it has. If it has none yet, search finds nothing and `call` throws an `unavailable` error until the API can be reached.
