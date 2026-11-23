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

## Two-factor step-up

Supabase issues every OAuth grant at `aal1`, even when the user passed MFA before consent, and RLS hides workspace data from an `aal1` session of a user with MFA. Before a request with an `aal1` token that carries `client_id` reaches the SDK, the server asks the API (`POST /mcp/step-up`) what to do, and caches a `none` answer per session for 10 minutes:

- `none`: the user has no MFA; the request is served.
- `required`: every tool, `whoami` included, returns an error with a dashboard link. There the user enters their authenticator code, and the API runs the MFA challenge on the connector's session. `initialize` and `tools/list` are unchanged.
- `refresh`: the user has confirmed; the request gets `401` with `WWW-Authenticate: Bearer error="invalid_token", …`, so the client refreshes and gets an `aal2` token.

If the API call fails or the endpoint doesn't exist, the request is served as before. The token is decoded without verification, only to route the request; the API still authorizes every call.

## Tools

One file per tool in `src/tools/`; `common.ts` holds what more than one tool uses, including `workspaceIdInput`, the required `workspace_id` field every workspace-scoped tool takes.

- `search`: finds the API operations tagged for MCP that match a plain-language query, up to 5 by default, each with its name, summary, description, hints and input schema. The tool description lists the spec's tags as areas.
- `call`: runs one of those operations with the caller's token in the workspace named by the required `workspace_id` (sent as `x-workspace-id`): path and query parameters at the top level of `arguments`, the request body under `body`. A missing or non-UUID `workspace_id` is an input error and nothing is sent; a workspace the user isn't in gets the API's 403. Returns the API's data as JSON. A 401 for an invalid, expired or missing token asks the user to reconnect; other API errors pass the API's message through.
- `whoami`: the signed-in user and the workspaces they belong to, from `GET /users/me` and `GET /me/workspaces`.
- `run`: starts a workflow run (`POST /run`) with its inputs in the given workspace and returns a handle, `v1:run:<workspace_id>:<session_id>`, fixed for the run's life.
- `observe`: follows a run by its handle. Without `after` it returns the run's state at once; with the `after` cursor from its last result it reads `GET /run/{id}` (backing off 1, 2, 5, then every 10 s) until the run changes or the wait ends, then says what changed. A rise in `session_retries` counts as a change, so a requeue between calls is never missed. The run is done once `finalized_at` is set. The wait cap depends on the client: 50 s for Claude Code, 200 s for Claude, 45 s for others. The server keeps no state, so any instance answers any call.
- `run` and `observe` carry `_meta["anthropic/alwaysLoad"]`, so Claude Code doesn't defer them behind tool search.

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
