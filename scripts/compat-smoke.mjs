// Live compatibility smoke test: exercises the current published CLI's real
// HTTP call surface against a real, running CloudCruise backend. Read-only
// call only.
//
// Requires CLOUDCRUISE_API_KEY and COMPAT_TEST_BASE_URL (mapped to
// CLOUDCRUISE_BASE_URL, which the CLI resolves directly with no allowlist).
import { execFileSync } from "node:child_process"

const baseUrl = process.env.COMPAT_TEST_BASE_URL
const apiKey = process.env.CLOUDCRUISE_API_KEY

if (!baseUrl) {
  console.error("FAIL: COMPAT_TEST_BASE_URL is required")
  process.exit(1)
}
if (!apiKey) {
  console.error("FAIL: CLOUDCRUISE_API_KEY is required")
  process.exit(1)
}

try {
  const stdout = execFileSync("node", ["dist/bin/cloudcruise.js", "workflows", "list"], {
    env: { ...process.env, CLOUDCRUISE_BASE_URL: baseUrl, CLOUDCRUISE_API_KEY: apiKey },
    encoding: "utf-8"
  })
  const workflows = JSON.parse(stdout)
  if (!Array.isArray(workflows)) {
    throw new Error(`expected a JSON array, got: ${stdout.slice(0, 200)}`)
  }
  console.log(`OK: workflows list -> ${workflows.length} workflows`)
} catch (err) {
  console.error(`FAIL: workflows list -> ${err.message}`)
  process.exit(1)
}
