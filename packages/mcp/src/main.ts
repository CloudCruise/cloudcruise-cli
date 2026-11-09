import { loadConfig, type Config } from "./config.js"
import { createHttpServer } from "./http.js"
import { VERSION } from "./tools/index.js"

let config: Config
try {
  config = loadConfig(process.env)
} catch (err) {
  console.error(`cloudcruise-mcp: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}

const { server, closeMcp } = createHttpServer(config)

server.listen(config.port, () => {
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : config.port
  console.log(JSON.stringify({ msg: "listening", port, version: VERSION, resource: `${config.publicUrl}/mcp` }))
})

// Porter sends SIGTERM and allows 30 s. Long polls are aborted; clients re-poll
// on another replica with the same handle.
process.on("SIGTERM", () => {
  server.close(() => process.exit(0))
  void closeMcp()
  server.closeIdleConnections()
})
