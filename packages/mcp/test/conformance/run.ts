// Runs the official MCP conformance suite against the built server, once per
// spec revision. The runner cannot send an Authorization header, so a local
// proxy adds one; the server under test is the one we ship, with no bypass.
//
//   npm run build && npm run conformance -w @cloudcruise/mcp [-- <runner flags>]
//
// Extra flags (e.g. `-o <dir>`, `--verbose`) go to every run.
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { createServer, request, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { fileURLToPath } from "node:url"
import { loadConfig } from "../../dist/config.js"
import { createHttpServer } from "../../dist/http.js"

const REVISIONS = ["2025-11-25", "2026-07-28"]
const runner = createRequire(import.meta.url).resolve(
  "@modelcontextprotocol/conformance/dist/index.js"
)

async function listen(server: Server, port = 0): Promise<number> {
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve))
  return (server.address() as AddressInfo).port
}

const api = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" }).end('{"userId":"conformance"}')
})
const apiPort = await listen(api)

// Reserve the proxy's port first: the server's MCP_PUBLIC_URL must name the host
// the runner connects to, or Host validation rejects it.
const proxy = createServer()
const proxyPort = await listen(proxy)

const { server: mcp, closeMcp } = createHttpServer(
  loadConfig({
    CLOUDCRUISE_API_BASE_URL: `http://127.0.0.1:${apiPort}`,
    CLOUDCRUISE_OAUTH_ISSUER: "https://issuer.example.test/auth/v1",
    MCP_PUBLIC_URL: `http://localhost:${proxyPort}`
  })
)
const mcpPort = await listen(mcp)

proxy.on("request", (req, res) => {
  const headers = { ...req.headers }
  headers.authorization ??= "Bearer conformance"
  const upstream = request(
    { host: "127.0.0.1", port: mcpPort, method: req.method, path: req.url, headers },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers)
      upRes.pipe(res)
    }
  )
  upstream.on("error", () => res.destroy())
  res.on("close", () => upstream.destroy())
  req.pipe(upstream)
})

let failed = false
for (const revision of REVISIONS) {
  console.log(`\n=== conformance ${revision} ===`)
  // Async: the proxy and server run on this process's event loop.
  const child = spawn(
    process.execPath,
    [
      runner,
      "server",
      "--url", `http://localhost:${proxyPort}/mcp`,
      "--requirements", revision,
      "--expected-failures",
      fileURLToPath(new URL(`./baseline-${revision}.yml`, import.meta.url)),
      ...process.argv.slice(2)
    ],
    { stdio: "inherit" }
  )
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve))
  if (code !== 0) failed = true
}

await closeMcp()
for (const server of [proxy, mcp, api]) {
  server.closeAllConnections()
  server.close()
}
process.exit(failed ? 1 : 0)
