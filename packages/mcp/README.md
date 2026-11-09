# @cloudcruise/mcp

The CloudCruise remote MCP server. It ships as a container image, not an npm package.

Stateless streamable HTTP: every request builds a fresh server, so any replica can answer any request. The server forwards the caller's bearer token to the CloudCruise API through `@cloudcruise/strata` and does not validate it; the API authorizes every call.

## Endpoints

| Path | |
|---|---|
| `POST /mcp` | MCP. Without `Authorization: Bearer …` it answers `401` with `WWW-Authenticate: Bearer resource_metadata="…", scope="openid email offline_access"`. |
| `GET`, `DELETE /mcp` | `405` |
| `GET /.well-known/oauth-protected-resource[/mcp]` | Protected-resource metadata: `resource` is `${MCP_PUBLIC_URL}/mcp`, the issuer is the only authorization server, `scopes_supported` is `openid email offline_access`. |
| `GET /healthz` | `200`, no auth |

## Tools

- `whoami`: the signed-in user, from `GET /users/me`.
- `probe_long` / `probe_poll`: a fake job for checking that a client keeps polling a handle until it is done. The handle carries its own start time and duration.

## Configuration

| Variable | |
|---|---|
| `PORT` | Listen port, default `8080` |
| `CLOUDCRUISE_API_BASE_URL` | e.g. `https://api.cloudcruise.com` |
| `CLOUDCRUISE_OAUTH_ISSUER` | Supabase Auth issuer, e.g. `https://<project>.supabase.co/auth/v1` |
| `MCP_PUBLIC_URL` | Public origin, e.g. `https://mcp.example.com`. Requests to `/mcp` must carry this host. |

All three URLs are required, with no trailing slash. The server exits at startup if one is missing.

## Run locally

```bash
npm run build
PORT=8080 \
CLOUDCRUISE_API_BASE_URL=https://api.cloudcruise.com \
CLOUDCRUISE_OAUTH_ISSUER=https://<project>.supabase.co/auth/v1 \
MCP_PUBLIC_URL=http://localhost:8080 \
npm start -w @cloudcruise/mcp
```

## Test

```bash
npm test                                   # whole repo, including this package
npm run conformance -w @cloudcruise/mcp    # official MCP conformance suite, 2025-11-25 and 2026-07-28
```

The conformance runner cannot send an `Authorization` header, so `test/conformance/run.ts` puts a local proxy in front of the server that adds one. Scenarios that need the SDK's fixture tools, or prompts and resources this server doesn't offer, are listed with reasons in `test/conformance/baseline-<revision>.yml`. Everything else must pass, and the runner rejects baseline entries that pass.
