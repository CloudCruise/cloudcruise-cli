import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const read = (path: string) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf-8")) as {
    version: string
    dependencies: Record<string, string>
  }

// The published CLI installs strata from npm, not the workspace. The two packages
// release in lockstep with an exact pin, so a core change can't ship without a bump.
test("the CLI pins @cloudcruise/strata to the exact version both packages share", () => {
  const cli = read("../package.json")
  const core = read("../packages/core/package.json")

  assert.equal(core.version, cli.version)
  assert.equal(cli.dependencies["@cloudcruise/strata"], cli.version)
})
