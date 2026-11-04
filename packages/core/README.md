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
